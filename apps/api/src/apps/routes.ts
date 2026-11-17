import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { MultipartFile } from '@fastify/multipart';
import {
  APP_EMPTY_DIGEST,
  APP_METADATA_MAX_BYTES,
  APP_REFUSALS,
  parseAppMetadata,
  type AppIntakeMetadata,
  type AppScope,
  type ConnectedAppChange,
  type ConnectedAppInput,
} from '@fdv/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { metaOf, parse } from '../auth/routes.js';
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
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

const changeBody = createBody.omit({ member_id: true, public_key: true }).partial().strict();

const keyBody = z.object({ public_key: z.string().max(4096) }).strict();
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

  /** A key the app adds for rotation, signed with a current key. */
  app.post(
    '/api/v1/apps/keys',
    {
      ...signed('POST /api/v1/apps/keys'),
      bodyLimit: 16 * 1024,
      // The body hashed as the parser reads it.
      preParsing: async (req: FastifyRequest, _reply: FastifyReply, payload) => {
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
    },
    async (req, reply) => {
      const body = parse(keyBody, req.body ?? {});
      return reply
        .status(201)
        .send(await apps.appAddsKey(caller(req), body.public_key, metaOf(req)));
    },
  );

  app.delete<{ Params: { key_id: string } }>(
    '/api/v1/apps/keys/:key_id',
    signed('DELETE /api/v1/apps/keys/:key_id'),
    async (req, reply) => {
      await apps.appRetiresKey(caller(req), req.params.key_id, metaOf(req));
      return reply.status(204).send();
    },
  );

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

/** The parser's own limits (a second file, a third field) are the order's refusal. */
function limitRefusal(e: unknown, order: () => ApiError): unknown {
  const code = (e as { code?: unknown } | null)?.code;
  return code === 'FST_FILES_LIMIT' || code === 'FST_FIELDS_LIMIT' || code === 'FST_PARTS_LIMIT'
    ? order()
    : e;
}
