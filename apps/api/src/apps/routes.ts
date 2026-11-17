import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { MultipartFile } from '@fastify/multipart';
import {
  APP_EMPTY_DIGEST,
  APP_LINK_COOKIE,
  APP_LINK_PAGE,
  APP_LINK_SESSION_PATH,
  APP_METADATA_MAX_BYTES,
  APP_REFUSALS,
  parseAppMetadata,
  type AppIntakeMetadata,
  type AppScope,
  type ConnectedAppChange,
  type ConnectedAppGrantsInput,
  type ConnectedAppInput,
} from '@fdv/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { metaOf, parse } from '../auth/routes.js';
import { clientAddressOf } from '../client-address.js';
import type { Principal } from '../auth/service.js';
import type { StepUpService } from '../auth/step-up.js';
import { cutOff } from '../documents/routes.js';
import { ApiError } from '../errors.js';
import { AppService, type AppCaller, type AppRoute } from './service.js';
import type { ParsedSignature } from './signing.js';

/**
 * Connected apps (0.9.0, APP1): the family's routes, signed in, and the
 * app's, signed (RFC 9421).
 *
 * The routes an app's signature is taken by — and nothing else takes it:
 * the hook in app.ts answers it `401 app_signature_not_accepted` on every
 * other route, a public one and one that is not there too. And these take
 * nothing else: a bearer token, a session cookie, a device key, a link's
 * or a sender's cookie is `401 app_signature_required`.
 */
export const APP_SIGNED_ROUTES: ReadonlyMap<string, AppRoute> = new Map<string, AppRoute>([
  // The connection test: under any scope, and while paused or waiting.
  ['GET /api/v1/apps/me', { scope: null, anyState: true }],
  ['POST /api/v1/apps/intake', { scope: 'documents.send' }],
  ['GET /api/v1/apps/intake', { scope: 'documents.send' }],
  ['GET /api/v1/apps/intake/:external_id', { scope: 'documents.send' }],
  ['DELETE /api/v1/apps/intake/:external_id', { scope: 'documents.send' }],
  ['POST /api/v1/apps/keys', { scope: null }],
  ['DELETE /api/v1/apps/keys/:key_id', { scope: null }],
  // Reading (APP2): its own and what its grants cover.
  ['GET /api/v1/apps/documents', { scope: 'documents.read' }],
  ['GET /api/v1/apps/documents/:id', { scope: 'documents.read' }],
  ['GET /api/v1/apps/changes', { scope: 'documents.read' }],
  ['GET /api/v1/apps/documents/:id/content', { scope: 'documents.download' }],
  // The exact file it sent, by its own external id, again (APP5).
  ['GET /api/v1/apps/intake/:external_id/content', { scope: 'documents.download' }],
  // Links for its user's browser, and deletes (APP3).
  ['POST /api/v1/apps/documents/:id/links', { scope: 'documents.links' }],
  ['DELETE /api/v1/apps/documents/:id', { scope: 'documents.delete' }],
]);

/** The scope a signed route needs, for the tests and the release-exit rules. */
export const appRouteScope = (key: string): AppScope | null =>
  APP_SIGNED_ROUTES.get(key)?.scope ?? null;

/** A body's room beyond the file: its boundaries and its metadata part. */
const BODY_ROOM = 64 * 1024;

declare module 'fastify' {
  interface FastifyRequest {
    connectedApp: { caller: AppCaller; signature: ParsedSignature } | null;
    /** The body's SHA-256, once all of it has been read. */
    appBodyDigest: Promise<Buffer> | null;
  }
}

const createBody = z
  .object({
    name: z.string().max(400),
    member_id: z.string().uuid(),
    public_key: z.string().max(4096),
    allowed_kinds: z.array(z.string().max(64)).max(200),
    default_visibility: z.enum(['household', 'adults', 'private']).nullable().optional(),
    daily_files: z.number().int().optional(),
    daily_bytes: z.number().int().optional(),
    ip_allow: z.array(z.string().max(64)).max(20).optional(),
    backfill: z
      .object({
        until: z.string().max(64),
        files_per_day: z.number().int(),
        bytes_per_day: z.number().int(),
        auto_file: z.boolean().optional(),
      })
      .strict()
      .nullable()
      .optional(),
    auto_file: z.boolean().optional(),
    route_to_person: z.boolean().optional(),
    scopes: z.array(z.string().max(64)).max(10).optional(),
    daily_read_bytes: z.number().int().optional(),
    delete_mode: z.enum(['unlink', 'trash']).optional(),
    links_per_hour: z.number().int().optional(),
  })
  .strict();

const grantsBody = z
  .object({
    grants: z
      .array(
        z
          .object({
            kind: z.string().max(64).optional(),
            category: z.string().max(64).optional(),
            lookback_months: z.number().int(),
          })
          .strict(),
      )
      .max(200),
    confirm_sensitive: z.boolean().optional(),
  })
  .strict();

const changeBody = createBody.omit({ member_id: true, public_key: true }).partial().strict();

const keyBody = z.object({ public_key: z.string().max(4096) }).strict();
const linkBody = z.object({ mode: z.string().max(16) }).strict();
const idParams = z.object({ id: z.string().uuid() });

/** A hash of every byte that goes by, told once the stream ends. */
function hashing(): { tap: (chunk: Buffer) => void; done: Promise<Buffer>; end: () => void } {
  const hash = createHash('sha256');
  let finish: (b: Buffer) => void = () => undefined;
  const done = new Promise<Buffer>((resolve) => {
    finish = resolve;
  });
  let ended = false;
  return {
    tap: (chunk) => hash.update(chunk),
    done,
    end: () => {
      if (ended) return;
      ended = true;
      finish(hash.digest());
    },
  };
}

export function registerApps(
  app: FastifyInstance,
  apps: AppService,
  stepUp: StepUpService,
  maxUploadBytes: number,
): void {
  const auth = { preHandler: app.requireAuth };
  const principal = (req: FastifyRequest) => req.principal as Principal;
  app.decorateRequest('connectedApp', null);
  app.decorateRequest('appBodyDigest', null);

  /**
   * A signed route: the signature checked as the request arrives — before a
   * byte of its body is read — in the contract's order; a body's digest
   * checked once it has all been read.
   */
  const signed = (key: string) => {
    const route = APP_SIGNED_ROUTES.get(key);
    if (!route) throw new Error(`${key} is not a signed route`);
    const [method] = key.split(' ');
    const bodiless = method === 'GET' || method === 'DELETE';
    return {
      // No HEAD beside a GET: a signed HEAD of a download would be counted,
      // written down and open the file for nothing. Its signature is
      // refused as on any route that is not an app's.
      exposeHeadRoute: false,
      onRequest: async (req: FastifyRequest) => {
        req.connectedApp = await apps.authenticate(req, route);
        if (bodiless) {
          // No body: the digest of zero bytes, and nothing sent.
          const length = req.headers['content-length'];
          if (
            req.connectedApp.signature.digestHeader !== APP_EMPTY_DIGEST ||
            (length !== undefined && length !== '0') ||
            req.headers['transfer-encoding'] !== undefined
          ) {
            await apps.countRefusal(req.connectedApp.caller, 'content_digest_mismatch');
            throw new ApiError(
              400,
              'content_digest_mismatch',
              APP_REFUSALS.content_digest_mismatch,
            );
          }
          return;
        }
        // A body: its length said, and no more than a file and its parts.
        const length = req.headers['content-length'];
        if (length === undefined || !/^\d+$/.test(length)) {
          throw new ApiError(411, 'length_required', APP_REFUSALS.length_required);
        }
        if (Number(length) > maxUploadBytes + BODY_ROOM) {
          throw new ApiError(413, 'too_large', 'That file is too big for this vault.');
        }
      },
    };
  };
  const caller = (req: FastifyRequest) =>
    (req.connectedApp as { caller: AppCaller; signature: ParsedSignature }).caller;
  const digestOf = (req: FastifyRequest) =>
    (req.connectedApp as { caller: AppCaller; signature: ParsedSignature }).signature.digest;

  // ------------------------------------------------------------ the app's

  app.get('/api/v1/apps/me', signed('GET /api/v1/apps/me'), async (req) => apps.me(caller(req)));

  /**
   * One document, multipart: a `metadata` part (JSON, 16 KiB at most), then
   * a `file` part, and nothing else. 201 for a new item; 200 with
   * `Idempotent-Replayed: true` for an external id sent before.
   */
  app.post('/api/v1/apps/intake', signed('POST /api/v1/apps/intake'), async (req, reply) => {
    const c = caller(req);
    if (!req.isMultipart()) {
      throw new ApiError(
        422,
        'validation_failed',
        'Send multipart/form-data: metadata, then file.',
      );
    }
    // Every byte of the body, hashed as it streams to the parser: tapped in
    // the same tick as the parser is given the request, so no byte passes
    // unhashed.
    const body = hashing();
    req.raw.on('data', (chunk: Buffer) => body.tap(chunk));
    req.raw.once('end', body.end);
    const parts = req
      .parts({
        limits: {
          fileSize: maxUploadBytes,
          files: 2,
          fields: 2,
          parts: 4,
          fieldSize: APP_METADATA_MAX_BYTES,
        },
      })
      [Symbol.asyncIterator]();
    const drainRest = async () => {
      for (;;) {
        const next = await parts.next().catch(() => ({ done: true as const, value: undefined }));
        if (next.done) return;
        if (next.value.type === 'file') next.value.file.resume();
      }
    };
    const order = () =>
      new ApiError(
        422,
        'validation_failed',
        'Send exactly two parts: metadata (JSON), then file.',
        { detail: 'parts' },
      );
    let metadata: AppIntakeMetadata;
    let file: MultipartFile;
    try {
      const first = await parts.next();
      if (first.done || first.value.type !== 'field' || first.value.fieldname !== 'metadata') {
        if (!first.done && first.value.type === 'file') first.value.file.resume();
        throw order();
      }
      if (first.value.valueTruncated) {
        throw new ApiError(422, 'validation_failed', 'metadata is 16 KiB at most.', {
          detail: 'metadata',
        });
      }
      let raw: unknown;
      try {
        raw = JSON.parse(String(first.value.value));
      } catch {
        throw new ApiError(422, 'validation_failed', 'metadata is JSON.', { detail: 'metadata' });
      }
      const checked = parseAppMetadata(raw);
      if (!checked.ok) {
        throw new ApiError(422, 'validation_failed', checked.problem.message, {
          detail: checked.problem.detail,
        });
      }
      metadata = checked.value;
      const second = await parts.next();
      if (second.done || second.value.type !== 'file' || second.value.fieldname !== 'file') {
        if (!second.done && second.value.type === 'file') second.value.file.resume();
        throw order();
      }
      file = second.value;
    } catch (e) {
      void drainRest();
      throw limitRefusal(e, order);
    }
    const theFile = file;
    const out = await apps
      .send(
        c,
        metadata,
        {
          filename: theFile.filename,
          mime: theFile.mimetype,
          stream: theFile.file,
          truncated: () => theFile.file.truncated,
          finished: async () => {
            const after = await parts.next().catch((e: unknown) => {
              throw limitRefusal(e, order);
            });
            if (after.done) return;
            if (after.value.type === 'file') after.value.file.resume();
            await drainRest();
            throw order();
          },
          digestOk: async () => {
            const got = await Promise.race([
              body.done,
              new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
            ]);
            return got !== null && got.equals(digestOf(req));
          },
        },
        metaOf(req),
      )
      .catch((e: unknown) => {
        theFile.file.resume();
        void drainRest();
        const refusal = limitRefusal(e, order);
        if (refusal instanceof ApiError && refusal.status === 413) cutOff(req, reply);
        throw refusal;
      });
    if (out.status === 200) void reply.header('idempotent-replayed', 'true');
    return reply.status(out.status).send(out.state);
  });

  /** What became of several, by external id: `?external_ids=a,b,c`, 100 at most. */
  app.get<{ Querystring: { external_ids?: string | string[] } }>(
    '/api/v1/apps/intake',
    signed('GET /api/v1/apps/intake'),
    async (req) => {
      const asked = req.query.external_ids;
      // Once, comma-separated: a parameter given twice is not a list.
      if (Array.isArray(asked)) {
        throw new ApiError(422, 'validation_failed', 'Send external_ids once, comma-separated.', {
          detail: 'external_ids',
        });
      }
      const ids = (asked ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      return apps.statuses(caller(req), ids, metaOf(req));
    },
  );

  app.get<{ Params: { external_id: string } }>(
    '/api/v1/apps/intake/:external_id',
    signed('GET /api/v1/apps/intake/:external_id'),
    async (req) => apps.status(caller(req), req.params.external_id, metaOf(req)),
  );

  app.delete<{ Params: { external_id: string } }>(
    '/api/v1/apps/intake/:external_id',
    signed('DELETE /api/v1/apps/intake/:external_id'),
    async (req) => apps.withdraw(caller(req), req.params.external_id, metaOf(req)),
  );

  /** A signed route with a small JSON body: the body hashed as the parser reads it, then checked. */
  const signedJson = (key: string) => ({
    ...signed(key),
    bodyLimit: 16 * 1024,
    preParsing: async (
      req: FastifyRequest,
      _reply: FastifyReply,
      payload: NodeJS.ReadableStream,
    ) => {
      const body = hashing();
      const tee = new PassThrough();
      tee.on('data', (chunk: Buffer) => body.tap(chunk));
      tee.once('end', body.end);
      req.appBodyDigest = body.done;
      payload.pipe(tee);
      return tee;
    },
    preHandler: async (req: FastifyRequest) => {
      const got = await req.appBodyDigest;
      if (!got || !got.equals(digestOf(req))) {
        await apps.countRefusal(caller(req), 'content_digest_mismatch');
        throw new ApiError(400, 'content_digest_mismatch', APP_REFUSALS.content_digest_mismatch);
      }
    },
  });

  /** A key the app adds for rotation, signed with a current key. */
  app.post('/api/v1/apps/keys', signedJson('POST /api/v1/apps/keys'), async (req, reply) => {
    const body = parse(keyBody, req.body ?? {});
    return reply.status(201).send(await apps.appAddsKey(caller(req), body.public_key, metaOf(req)));
  });

  app.delete<{ Params: { key_id: string } }>(
    '/api/v1/apps/keys/:key_id',
    signed('DELETE /api/v1/apps/keys/:key_id'),
    async (req, reply) => {
      await apps.appRetiresKey(caller(req), req.params.key_id, metaOf(req));
      return reply.status(204).send();
    },
  );

  // ---------------------------------------------------- reading (APP2)

  const reads = apps.reads;
  if (reads) {
    /** Its own and what its grants cover, newest paper first: `kind`, `category`, `from`, `to`, `own`, `limit`, `cursor`. */
    app.get<{ Querystring: Record<string, string | string[] | undefined> }>(
      '/api/v1/apps/documents',
      signed('GET /api/v1/apps/documents'),
      async (req) => reads.list(caller(req), singleQuery(req.query), metaOf(req)),
    );

    app.get<{ Params: { id: string } }>(
      '/api/v1/apps/documents/:id',
      signed('GET /api/v1/apps/documents/:id'),
      async (req) => reads.document(caller(req), req.params.id, metaOf(req)),
    );

    /** What changed since the cursor: `changed`, and `unavailable` with no reason. */
    app.get<{ Querystring: Record<string, string | string[] | undefined> }>(
      '/api/v1/apps/changes',
      signed('GET /api/v1/apps/changes'),
      async (req) => reads.changes(caller(req), singleQuery(req.query), metaOf(req)),
    );

    /** The current file's bytes, server to server: an attachment, never a page. */
    app.get<{ Params: { id: string } }>(
      '/api/v1/apps/documents/:id/content',
      signed('GET /api/v1/apps/documents/:id/content'),
      async (req, reply) => {
        const range = req.headers.range;
        const ifNoneMatch = req.headers['if-none-match'];
        const out = await reads.content(
          caller(req),
          req.params.id,
          {
            range: typeof range === 'string' ? range : undefined,
            ifNoneMatch: typeof ifNoneMatch === 'string' ? ifNoneMatch : undefined,
          },
          metaOf(req),
        );
        void reply.header('etag', out.etag);
        if (out.status === 304) return reply.status(304).send();
        for (const [k, v] of Object.entries(out.headers)) void reply.header(k, v);
        return reply.status(out.status).send(out.stream);
      },
    );

    /**
     * The exact file it sent, by its own external id (APP5): while that file
     * is still one of the vault's, its document out of the Trash and not
     * Only me — whether or not it may read the document now.
     */
    app.get<{ Params: { external_id: string } }>(
      '/api/v1/apps/intake/:external_id/content',
      signed('GET /api/v1/apps/intake/:external_id/content'),
      async (req, reply) => {
        const range = req.headers.range;
        const ifNoneMatch = req.headers['if-none-match'];
        const out = await reads.sentContent(
          caller(req),
          req.params.external_id,
          {
            range: typeof range === 'string' ? range : undefined,
            ifNoneMatch: typeof ifNoneMatch === 'string' ? ifNoneMatch : undefined,
          },
          metaOf(req),
        );
        void reply.header('etag', out.etag);
        if (out.status === 304) return reply.status(304).send();
        for (const [k, v] of Object.entries(out.headers)) void reply.header(k, v);
        return reply.status(out.status).send(out.stream);
      },
    );
  }

  // ------------------------------------------ links and deletes (APP3)

  const links = apps.links;
  if (links) {
    /**
     * A link for its user's browser, to send it to at once: `{ mode: "view" }`
     * (the drawn pages) or `{ mode: "download" }` (the file). 201.
     */
    app.post<{ Params: { id: string } }>(
      '/api/v1/apps/documents/:id/links',
      signedJson('POST /api/v1/apps/documents/:id/links'),
      async (req, reply) => {
        const body = parse(linkBody, req.body ?? {});
        return reply
          .status(201)
          .send(await links.mint(caller(req), req.params.id, body.mode, metaOf(req)));
      },
    );

    /** A document it sent, let go of or moved to the Trash, as the owner chose. */
    app.delete<{ Params: { id: string } }>(
      '/api/v1/apps/documents/:id',
      signed('DELETE /api/v1/apps/documents/:id'),
      async (req) => links.remove(caller(req), req.params.id, metaOf(req)),
    );

    // What its user's browser asks: no signature, no sign-in. The token
    // opens once; after that, the session's cookie, for this path alone.
    // Rate-limited as a share link's are: opening as the front door,
    // inside a session as a page that loads its pages.
    const tight = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };
    const inSession = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };
    const cookieOf = (req: FastifyRequest) => req.cookies[APP_LINK_COOKIE];

    /** The session itself: what the `/a` page shows. */
    app.get('/api/v1/app-links/session', inSession, async (req) =>
      links.session(cookieOf(req), clientAddressOf(req)),
    );

    /** One page a view link shows, as the vault drew it. */
    app.get<{ Params: { n: string } }>(
      '/api/v1/app-links/session/pages/:n',
      inSession,
      async (req, reply) => {
        const { n } = parse(
          z.object({ n: z.coerce.number().int().min(1).max(10_000) }),
          req.params,
        );
        const jpeg = await links.page(cookieOf(req), clientAddressOf(req), n);
        void reply.header('content-type', 'image/jpeg');
        void reply.header('cache-control', 'private, no-store');
        return reply.send(jpeg);
      },
    );

    /**
     * The file a download link gives: an attachment. A browser follows this
     * itself, so a session over is the page's words, not an error's.
     */
    app.get('/api/v1/app-links/session/file', inSession, async (req, reply) => {
      const range = req.headers.range;
      try {
        const out = await links.file(
          cookieOf(req),
          clientAddressOf(req),
          typeof range === 'string' ? range : undefined,
          metaOf(req),
        );
        for (const [k, v] of Object.entries(out.headers)) void reply.header(k, v);
        return reply.status(out.status).send(out.stream);
      } catch (e) {
        // The browser is sent to the page, which says it in words: over,
        // another network, or more than the app may download today.
        const to: Record<string, string> = {
          link_ended: 'ended',
          link_other_address: 'elsewhere',
          app_read_day_full: 'full',
          larger_than_daily_read: 'full',
        };
        if (e instanceof ApiError && to[e.code]) {
          return reply.redirect(`${APP_LINK_PAGE}#${to[e.code]}`, 303);
        }
        throw e;
      }
    });

    /**
     * The link itself, opened by the browser: within two minutes, once. A
     * session's cookie, and on (303) to the page or the file, so the token
     * leaves the address bar. Used, or too late: the page says so.
     */
    app.get<{ Params: { token: string } }>(
      '/api/v1/app-links/:token',
      tight,
      async (req, reply) => {
        const opened = await links.open(req.params.token, clientAddressOf(req), metaOf(req));
        if (opened.kind !== 'session') {
          return reply.redirect(`${APP_LINK_PAGE}#${opened.kind}`, 303);
        }
        // Secure always, as a share's is; Lax, not Strict: the open is a
        // navigation from the app's site, and the cookie must come with the
        // request it is sent on to. Its path keeps it off everything else.
        void reply.setCookie(APP_LINK_COOKIE, opened.cookie, {
          path: APP_LINK_SESSION_PATH,
          httpOnly: true,
          secure: true,
          sameSite: 'lax',
          maxAge: opened.maxAge,
        });
        return reply.redirect(
          opened.mode === 'view' ? APP_LINK_PAGE : `${APP_LINK_SESSION_PATH}/file`,
          303,
        );
      },
    );
  }

  // ---------------------------------------------------------- the family's

  /** The apps the caller sees: an owner every one, its person their own. */
  app.get('/api/v1/connected-apps', auth, async (req) => apps.list(principal(req)));

  /** An owner connects an app, with a passkey or a code (never the password alone). */
  app.post('/api/v1/connected-apps', auth, async (req, reply) => {
    const p = principal(req);
    if (p.role !== 'owner') {
      throw new ApiError(403, 'forbidden', 'Only an owner can connect an app.');
    }
    await stepUp.requireOwnerPower(p, 'connect_app');
    const body = parse(createBody, req.body ?? {}) as ConnectedAppInput;
    return reply.status(201).send(await apps.create(p, body, metaOf(req)));
  });

  /** An owner changes what it may do: a passkey or a code, but for a new name alone. */
  app.patch<{ Params: { id: string } }>('/api/v1/connected-apps/:id', auth, async (req) => {
    const p = principal(req);
    const { id } = parse(idParams, req.params);
    if (p.role !== 'owner') {
      throw new ApiError(403, 'forbidden', 'Only an owner can change what an app may do.');
    }
    const body = parse(changeBody, req.body ?? {}) as ConnectedAppChange;
    if (!AppService.onlyRenames(body)) await stepUp.requireOwnerPower(p, 'connect_app');
    return apps.update(p, id, body, metaOf(req));
  });

  /**
   * What it may read beyond its own (APP2): every grant it is to have, set
   * by an owner with a passkey or a code. Sensitive kinds ask once.
   */
  app.put<{ Params: { id: string } }>('/api/v1/connected-apps/:id/grants', auth, async (req) => {
    const p = principal(req);
    const { id } = parse(idParams, req.params);
    if (p.role !== 'owner') {
      throw new ApiError(403, 'forbidden', 'Only an owner can change what an app may read.');
    }
    await stepUp.requireOwnerPower(p, 'connect_app');
    const body = parse(grantsBody, req.body ?? {}) as ConnectedAppGrantsInput;
    return apps.setGrants(p, id, body, metaOf(req));
  });

  /** Its person turns it on, with a passkey or a code. */
  app.post<{ Params: { id: string } }>('/api/v1/connected-apps/:id/approve', auth, async (req) => {
    const p = principal(req);
    const { id } = parse(idParams, req.params);
    if (p.role !== 'owner' && p.role !== 'adult') {
      throw new ApiError(404, 'not_found', 'That app is not here.');
    }
    await stepUp.requireFactor(p, 'connect_app');
    return apps.approve(p, id, metaOf(req));
  });

  app.post<{ Params: { id: string } }>('/api/v1/connected-apps/:id/pause', auth, async (req) => {
    const p = principal(req);
    const { id } = parse(idParams, req.params);
    return apps.pause(p, id, true, metaOf(req));
  });

  /** Turned back on by an owner — after a pause, or a restore — with a passkey or a code. */
  app.post<{ Params: { id: string } }>('/api/v1/connected-apps/:id/resume', auth, async (req) => {
    const p = principal(req);
    const { id } = parse(idParams, req.params);
    if (p.role !== 'owner') {
      throw new ApiError(403, 'forbidden', 'Only an owner can turn an app back on.');
    }
    await stepUp.requireOwnerPower(p, 'connect_app');
    return apps.pause(p, id, false, metaOf(req));
  });

  app.post<{ Params: { id: string } }>(
    '/api/v1/connected-apps/:id/keys',
    auth,
    async (req, reply) => {
      const p = principal(req);
      const { id } = parse(idParams, req.params);
      if (p.role !== 'owner') {
        throw new ApiError(403, 'forbidden', 'Only an owner can add a key to an app.');
      }
      await stepUp.requireOwnerPower(p, 'connect_app');
      const body = parse(keyBody, req.body ?? {});
      return reply.status(201).send(await apps.addKey(p, id, body.public_key, metaOf(req)));
    },
  );

  /**
   * A key the app added itself, confirmed by an owner or the person it acts
   * as, with a passkey or a code: only then does it sign.
   */
  app.post<{ Params: { id: string; keyId: string } }>(
    '/api/v1/connected-apps/:id/keys/:keyId/confirm',
    auth,
    async (req) => {
      const p = principal(req);
      const { id, keyId } = parse(
        z.object({ id: z.string().uuid(), keyId: z.string().uuid() }),
        req.params,
      );
      if (p.role !== 'owner' && p.role !== 'adult') {
        throw new ApiError(404, 'not_found', 'That app is not here.');
      }
      await stepUp.requireFactor(p, 'connect_app');
      return apps.confirmKey(p, id, keyId, metaOf(req));
    },
  );

  app.delete<{ Params: { id: string; keyId: string } }>(
    '/api/v1/connected-apps/:id/keys/:keyId',
    auth,
    async (req, reply) => {
      const p = principal(req);
      const { id, keyId } = parse(
        z.object({ id: z.string().uuid(), keyId: z.string().uuid() }),
        req.params,
      );
      await apps.retireKey(p, id, keyId, metaOf(req));
      return reply.status(204).send();
    },
  );

  /** Removed — revoked, never deleted — by an owner or its person. */
  app.delete<{ Params: { id: string } }>('/api/v1/connected-apps/:id', auth, async (req, reply) => {
    const p = principal(req);
    const { id } = parse(idParams, req.params);
    await apps.remove(p, id, metaOf(req));
    return reply.status(204).send();
  });
}

/** A query as one value a name: a name given twice is not a list. */
function singleQuery(q: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(q)) {
    if (Array.isArray(v)) {
      throw new ApiError(422, 'validation_failed', `Send ${k} once.`, { detail: k });
    }
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** The parser's own limits (a second file, a third field) are the order's refusal. */
function limitRefusal(e: unknown, order: () => ApiError): unknown {
  const code = (e as { code?: unknown } | null)?.code;
  return code === 'FST_FILES_LIMIT' || code === 'FST_FIELDS_LIMIT' || code === 'FST_PARTS_LIMIT'
    ? order()
    : e;
}
