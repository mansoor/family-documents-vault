import type { MultipartFile } from '@fastify/multipart';
import {
  APP_BASIC_DEPRECATION,
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
  type ConnectedAppKeyInput,
} from '@fdv/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { metaOf, parse } from '../auth/routes.js';
import { clientAddressOf } from '../client-address.js';
import type { Principal } from '../auth/service.js';
import type { StepUpService } from '../auth/step-up.js';
import { cutOff } from '../documents/routes.js';
import { ApiError } from '../errors.js';
import { crossSite, looksLikeToken, openPage } from './links.js';
import { AppService, type AppCaller, type AppRoute } from './service.js';

/**
 * A link's own address (APP3): a GET is the page that opens it, a POST the
 * open (0.9.0-dev.68). The page sets its own Content-Security-Policy.
 */
export const APP_LINK_TOKEN_ROUTE = '/api/v1/app-links/:token';

/**
 * Connected apps (0.9.0, APP1): the family's routes, signed in, and the
 * app's, with an API key an owner generated (APP6) — since 0.9.0-dev.72
 * traded at `POST /apps/token` for a short-lived access token, sent as
 * `Authorization: Bearer` (the key as Basic still taken, deprecated).
 *
 * The routes an app's key and its tokens are taken by — and nothing else
 * takes them: the hook in app.ts answers either `401 app_key_not_accepted`
 * on every other route, a public one and one that is not there too. And
 * these take nothing else: a sign-in's bearer token, a session cookie, a
 * device key, a link's or a sender's cookie is `401 app_key_required`.
 */
export const APP_ROUTES: ReadonlyMap<string, AppRoute> = new Map<string, AppRoute>([
  // An access token for the key (0.9.0-dev.72): the key alone, as Basic;
  // while paused or waiting too, so GET /apps/me can say so.
  ['POST /api/v1/apps/token', { scope: null, anyState: true, token: true }],
  // The connection test: under any scope, and while paused or waiting.
  ['GET /api/v1/apps/me', { scope: null, anyState: true }],
  ['POST /api/v1/apps/intake', { scope: 'documents.send' }],
  ['GET /api/v1/apps/intake', { scope: 'documents.send' }],
  ['GET /api/v1/apps/intake/:external_id', { scope: 'documents.send' }],
  ['DELETE /api/v1/apps/intake/:external_id', { scope: 'documents.send' }],
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

/** The scope an app route needs, for the tests and the release-exit rules. */
export const appRouteScope = (key: string): AppScope | null => APP_ROUTES.get(key)?.scope ?? null;

/** A body's room beyond the file: its boundaries and its metadata part. */
const BODY_ROOM = 64 * 1024;

declare module 'fastify' {
  interface FastifyRequest {
    connectedApp: { caller: AppCaller } | null;
  }
}

const createBody = z
  .object({
    name: z.string().max(400),
    // Whom it acts as (APP8): itself unless it says a person; then member_id.
    acts_as: z.enum(['app', 'person']).optional(),
    member_id: z.string().uuid().optional(),
    reviewer_member_id: z.string().uuid().optional(),
    allowed_kinds: z.array(z.string().max(64)).max(200),
    default_visibility: z.enum(['household', 'adults', 'private']).nullable().optional(),
    daily_files: z.number().int().optional(),
    daily_bytes: z.number().int().optional(),
    ip_allow: z.array(z.string().max(260)).max(20).optional(),
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

const changeBody = createBody.partial().strict();

/** An API key, as an owner generates it: what is checked of each field is the service's. */
const keyBody = z
  .object({
    name: z.string().max(400).nullable().optional(),
    permissions: z.array(z.string().max(64)).max(10),
    // Left out: 90 days (0.9.0-dev.72); null, never, said on purpose.
    expires_in_days: z.number().int().nullable().optional(),
  })
  .strict();
const linkBody = z.object({ mode: z.string().max(16) }).strict();
const idParams = z.object({ id: z.string().uuid() });

export function registerApps(
  app: FastifyInstance,
  apps: AppService,
  stepUp: StepUpService,
  maxUploadBytes: number,
): void {
  const auth = { preHandler: app.requireAuth };
  const principal = (req: FastifyRequest) => req.principal as Principal;
  app.decorateRequest('connectedApp', null);

  /**
   * An app's route: its API key checked as the request arrives — before a
   * byte of its body is read — in the contract's order.
   */
  const keyed = (key: string) => {
    const route = APP_ROUTES.get(key);
    if (!route) throw new Error(`${key} is not an app route`);
    const [method] = key.split(' ');
    const bodiless = method === 'GET' || method === 'DELETE';
    return {
      // No HEAD beside a GET: a HEAD of a download would be counted,
      // written down and open the file for nothing. Its key is refused as
      // on any route that is not an app's.
      exposeHeadRoute: false,
      onRequest: async (req: FastifyRequest, reply: FastifyReply) => {
        // The token route's address limit, before its key is looked at (0.9.0-dev.72).
        if (route.token === true) apps.mintAddressCheck(req);
        const { caller, via } = await apps.authenticate(req, route);
        req.connectedApp = { caller };
        // The key as Basic off the token route (0.9.0-dev.72): taken, and
        // said to be deprecated (RFC 9745) — an access token replaces it.
        if (via === 'basic' && route.token !== true) {
          void reply.header('deprecation', APP_BASIC_DEPRECATION);
        }
        if (bodiless) return;
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
  const caller = (req: FastifyRequest) => (req.connectedApp as { caller: AppCaller }).caller;

  // ------------------------------------------------------------ the app's

  /**
   * An access token (0.9.0-dev.72), as OAuth 2.0's client credentials grant
   * (RFC 6749 §4.4) has it: the API key as `Authorization: Basic`, and the
   * form body `grant_type=client_credentials`; answered `access_token`,
   * `token_type: "Bearer"`, `expires_in` and `scope`, never kept by a cache.
   * Its own scope takes the form: the link's open (below) is the only other
   * route that reads one.
   */
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 1024 },
      (_req, body, done) => done(null, body),
    );
    // A form alone, said so, an optional charset beside: no other body —
    // text/plain, which Fastify reads as a string too, or JSON — is read.
    scope.addHook('preParsing', async (req) => {
      const type = req.headers['content-type'] ?? '';
      if (
        !/^application\/x-www-form-urlencoded\s*(;\s*charset=[A-Za-z0-9_.:-]+\s*)?$/i.test(type)
      ) {
        throw new ApiError(400, 'invalid_request', APP_REFUSALS.invalid_request);
      }
    });
    scope.post('/api/v1/apps/token', keyed('POST /api/v1/apps/token'), async (req, reply) => {
      if (typeof req.body !== 'string') {
        throw new ApiError(400, 'invalid_request', APP_REFUSALS.invalid_request);
      }
      const form = new URLSearchParams(req.body);
      // The key in the body as well as the header, or a field twice: no.
      if (
        form.has('client_secret') ||
        form.getAll('grant_type').length !== 1 ||
        form.getAll('scope').length > 1
      ) {
        throw new ApiError(400, 'invalid_request', APP_REFUSALS.invalid_request);
      }
      if (form.get('grant_type') !== 'client_credentials') {
        throw new ApiError(400, 'unsupported_grant_type', APP_REFUSALS.unsupported_grant_type);
      }
      const made = await apps.mintToken(caller(req));
      void reply.header('cache-control', 'no-store');
      void reply.header('pragma', 'no-cache');
      return made;
    });
  });

  app.get('/api/v1/apps/me', keyed('GET /api/v1/apps/me'), async (req) => apps.me(caller(req)));

  /**
   * One document, multipart: a `metadata` part (JSON, 16 KiB at most), then
   * a `file` part, and nothing else. 201 for a new item; 200 with
   * `Idempotent-Replayed: true` for an external id sent before.
   */
  app.post('/api/v1/apps/intake', keyed('POST /api/v1/apps/intake'), async (req, reply) => {
    const c = caller(req);
    if (!req.isMultipart()) {
      throw new ApiError(
        422,
        'validation_failed',
        'Send multipart/form-data: metadata, then file.',
      );
    }
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
    keyed('GET /api/v1/apps/intake'),
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
    keyed('GET /api/v1/apps/intake/:external_id'),
    async (req) => apps.status(caller(req), req.params.external_id, metaOf(req)),
  );

  app.delete<{ Params: { external_id: string } }>(
    '/api/v1/apps/intake/:external_id',
    keyed('DELETE /api/v1/apps/intake/:external_id'),
    async (req) => apps.withdraw(caller(req), req.params.external_id, metaOf(req)),
  );

  /** An app's route with a small JSON body. */
  const keyedJson = (key: string) => ({ ...keyed(key), bodyLimit: 16 * 1024 });

  // ---------------------------------------------------- reading (APP2)

  const reads = apps.reads;
  if (reads) {
    /** Its own and what its grants cover, newest paper first: `kind`, `category`, `from`, `to`, `own`, `limit`, `cursor`. */
    app.get<{ Querystring: Record<string, string | string[] | undefined> }>(
      '/api/v1/apps/documents',
      keyed('GET /api/v1/apps/documents'),
      async (req) => reads.list(caller(req), singleQuery(req.query), metaOf(req)),
    );

    app.get<{ Params: { id: string } }>(
      '/api/v1/apps/documents/:id',
      keyed('GET /api/v1/apps/documents/:id'),
      async (req) => reads.document(caller(req), req.params.id, metaOf(req)),
    );

    /** What changed since the cursor: `changed`, and `unavailable` with no reason. */
    app.get<{ Querystring: Record<string, string | string[] | undefined> }>(
      '/api/v1/apps/changes',
      keyed('GET /api/v1/apps/changes'),
      async (req) => reads.changes(caller(req), singleQuery(req.query), metaOf(req)),
    );

    /** The current file's bytes, server to server: an attachment, never a page. */
    app.get<{ Params: { id: string } }>(
      '/api/v1/apps/documents/:id/content',
      keyed('GET /api/v1/apps/documents/:id/content'),
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
      keyed('GET /api/v1/apps/intake/:external_id/content'),
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
      keyedJson('POST /api/v1/apps/documents/:id/links'),
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
      keyed('DELETE /api/v1/apps/documents/:id'),
      async (req) => links.remove(caller(req), req.params.id, metaOf(req)),
    );

    // What its user's browser asks: no app key, no sign-in. The token
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
     * The link's address, as the browser (or a link preview) first asks it
     * (0.9.0-dev.68): a small page that consumes nothing and has no
     * script; its Open button sends a POST to the same address. A token the
     * vault could not have made is "ended" at once; any other gets the same
     * page, so the page says nothing of whether the link is good. Its own
     * strict policy, with a nonce for its style, and `Referrer-Policy:
     * same-origin`, so the POST it sends carries a real Origin (app.ts
     * leaves both, and adds the public routes' other headers).
     */
    app.get<{ Params: { token: string } }>(APP_LINK_TOKEN_ROUTE, tight, async (req, reply) => {
      const { token } = req.params;
      if (!looksLikeToken(token)) return reply.redirect(`${APP_LINK_PAGE}#ended`, 303);
      const page = openPage(token);
      void reply.header('content-security-policy', page.csp);
      void reply.header('referrer-policy', 'same-origin');
      void reply.header('x-frame-options', 'DENY');
      void reply.header('cache-control', 'no-store');
      void reply.type('text/html; charset=utf-8');
      return reply.send(page.html);
    });

    /**
     * The open itself, from that page: within two minutes, once. A
     * session's cookie, and on (303) to the page or the file, so the token
     * leaves the address bar. Used, or too late: the page says so.
     *
     * A form's POST, so its body (form-encoded, and empty) is taken here
     * and on the app's token route alone (which takes nothing without its
     * key): nowhere else does the vault read a form, which a page on any
     * site could send. And one from anywhere but the link's own page —
     * `Sec-Fetch-Site` cross-site or same-site, or its Origin, else its
     * Referer, naming another host — is refused before anything is looked
     * at; the token is the secret, and it is not consumed.
     */
    void app.register(async (scope) => {
      scope.addContentTypeParser(
        'application/x-www-form-urlencoded',
        { parseAs: 'string', bodyLimit: 1024 },
        (_req, _body, done) => done(null, {}),
      );
      scope.post<{ Params: { token: string } }>(APP_LINK_TOKEN_ROUTE, tight, async (req, reply) => {
        const header = (name: string) => {
          const v = req.headers[name];
          return typeof v === 'string' ? v : undefined;
        };
        if (
          crossSite(
            {
              secFetchSite: header('sec-fetch-site'),
              origin: header('origin'),
              referer: header('referer'),
            },
            [header('host'), links.linkAddress()],
          )
        ) {
          throw new ApiError(
            403,
            'forbidden',
            'Open the link from the app, in the browser it sent you to.',
          );
        }
        const opened = await links.open(req.params.token, clientAddressOf(req), metaOf(req));
        if (opened.kind !== 'session') {
          return reply.redirect(`${APP_LINK_PAGE}#${opened.kind}`, 303);
        }
        // Secure always, as a share's is; Lax, not Strict: the cookie must
        // come with the request it is sent on to. Its path keeps it off
        // everything else.
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
      });
    });
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

  /**
   * An owner generates an API key for an app (APP6), with a passkey or a
   * code: its name, its permissions and how long it lasts. Its secret is
   * in this answer alone.
   */
  app.post<{ Params: { id: string } }>(
    '/api/v1/connected-apps/:id/keys',
    auth,
    async (req, reply) => {
      const p = principal(req);
      const { id } = parse(idParams, req.params);
      if (p.role !== 'owner') {
        throw new ApiError(403, 'forbidden', 'Only an owner can generate a key for an app.');
      }
      await stepUp.requireOwnerPower(p, 'connect_app');
      const body = parse(keyBody, req.body ?? {}) as ConnectedAppKeyInput;
      void reply.header('cache-control', 'no-store');
      return reply.status(201).send(await apps.generateKey(p, id, body, metaOf(req)));
    },
  );

  /** An owner revokes an API key, with a passkey or a code: refused from its next request. */
  app.delete<{ Params: { id: string; keyId: string } }>(
    '/api/v1/connected-apps/:id/keys/:keyId',
    auth,
    async (req, reply) => {
      const p = principal(req);
      const { id, keyId } = parse(
        z.object({ id: z.string().uuid(), keyId: z.string().uuid() }),
        req.params,
      );
      if (p.role !== 'owner') {
        throw new ApiError(403, 'forbidden', 'Only an owner can revoke an app’s key.');
      }
      await stepUp.requireOwnerPower(p, 'connect_app');
      await apps.revokeKey(p, id, keyId, metaOf(req));
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
