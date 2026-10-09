import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { SHARE_COOKIE_PATH } from './documents/shares.js';
import { errorForLog, LOG_REDACTED_PATHS, requestForLog } from './log-redaction.js';
import { registerOffline } from './offline/routes.js';
import type { OfflineService } from './offline/service.js';
import { registerAudit } from './audit/routes.js';
import type { AuditService } from './audit/service.js';
import { registerAuth } from './auth/routes.js';
import type { PasskeyService } from './auth/passkeys.js';
import type { StepUpService } from './auth/step-up.js';
import type { PasswordService } from './auth/passwords.js';
import { endedMeanwhile, type AuthService } from './auth/service.js';
import { buildCapabilities } from './capabilities.js';
import { registerDocuments } from './documents/routes.js';
import type { SealedSearchService } from './documents/sealed-search.js';
import type { ShareService } from './documents/shares.js';
import {
  registerAccess,
  registerHousehold,
  registerIdentity,
  registerLocks,
  registerOwnerResets,
} from './household/routes.js';
import type { LockService } from './household/locks.js';
import type { OwnerResetService } from './household/owner-resets.js';
import { restrictedRefusal, type RestrictionService } from './household/restrictions.js';
import type { GuestService } from './household/guests.js';
import type { HouseholdService } from './household/service.js';
import type { IdentityService } from './household/identity.js';
import type { PhotoService } from './household/photos.js';
import type { InvitationService } from './household/invitations.js';
import type { CoOwnerService } from './household/co-owners.js';
import type { DocumentService } from './documents/service.js';
import type { PurgeService } from './documents/purge.js';
import { registerTypes } from './documents/type-routes.js';
import type { TypeService } from './documents/types.js';
import { registerCollections } from './collections/routes.js';
import type { CollectionService } from './collections/service.js';
import type { VisibilityService } from './documents/visibility.js';
import type { TotpService } from './auth/totp.js';
import { registerExports } from './exports/routes.js';
import { registerNotifications } from './notifications/routes.js';
import type { NotificationService } from './notifications/service.js';
import { registerReminders } from './reminders/routes.js';
import { registerSuggestions } from './suggestions/routes.js';
import type { SuggestionService } from './suggestions/service.js';
import type { ReminderService } from './reminders/service.js';
import type { ExportService } from './exports/service.js';
import { registerBatches, registerIncoming, registerUploads } from './uploads/routes.js';
import { DROP_COOKIE_PATH, type UploadRequestService } from './uploads/requests.js';
import type { IncomingService } from './uploads/incoming.js';
import type { BatchService } from './uploads/batches.js';
import { registerVaults } from './vaults/routes.js';
import type { VaultService } from './vaults/service.js';
import type { ApiConfig } from './config.js';
import { ownNetworks, trustProxyFor } from './client-address.js';
import { GUEST_OWNS_NOTHING } from '@fdv/shared';
import { ApiError, notFound, notReady } from './errors.js';

/**
 * What the HTTP layer needs from the outside world. Kept as an interface so
 * tests can hand in fakes and the server wires in the real database.
 */
export interface AppDeps {
  serverVersion: string;
  /** This installation's identifier (migration 0021), or null if it cannot be read. */
  instanceId?: () => Promise<string | null>;
  /** Resolves when the database answers; rejects otherwise. */
  pingDatabase: () => Promise<void>;
  auth: AuthService;
  vaults: VaultService;
  documents: DocumentService;
  /** Removing a document for good (5.24). */
  purge: PurgeService;
  /** Kinds of document, managed (5.11). */
  types: TypeService;
  /** Collections of documents (5.14). */
  collections: CollectionService;
  sealedSearch: SealedSearchService;
  visibility: VisibilityService;
  totp: TotpService;
  passkeys: PasskeyService;
  stepUp: StepUpService;
  exports: ExportService;
  reminders: ReminderService;
  suggestions: SuggestionService;
  notifications: NotificationService;
  household: HouseholdService;
  /** People's photos (5.17c). */
  photos: PhotoService;
  /** People's identity details, sealed, and who sees them (5.26). */
  identity: IdentityService;
  /** Locking a sign-in, and what a restore paused (5.28). */
  locks: LockService;
  /** What a viewer can see, limited by an owner (5.32, 5.33). */
  restrictions: RestrictionService;
  /** A guest's sign-in renewed by an owner (5.34, A28). */
  guests?: GuestService;
  /** A password reset an owner starts (5.29). */
  resets: OwnerResetService;
  invitations: InvitationService;
  coOwners: CoOwnerService;
  shares: ShareService;
  /** Asking somebody outside the family to send documents (5.21). */
  uploads: UploadRequestService;
  /** What they sent, looked at before it is filed (5.23). */
  incoming: IncomingService;
  /** Many documents at once (Phase 6, I1): batches, and their items. */
  batches: BatchService;
  audit: AuditService;
  passwords: PasswordService;
  /** Essentials a phone may keep (0.4.13). */
  offline: OfflineService;
  logger?: boolean | object;
  /**
   * The networks this process is on, for `FDV_TRUST_PROXY=network` (5.30):
   * read from its interfaces unless a test says otherwise.
   */
  ownNetworks?: () => string[];
}

/**
 * What every answer under /api/v1/shared and /api/v1/drop carries (5.16,
 * 5.21), on top of the
 * public pages' own (docker/nginx.conf): no referrer, no sniffing, never in
 * a frame, and nothing in it runs — a shared HTML file opened by mistake is
 * a sandboxed page with no script and no fetch.
 */
export const PUBLIC_API_HEADERS = {
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
} as const;

/**
 * The logger, as the caller asked for it, but never with a secret from a
 * URL in it (0.5.0): share, reset and invitation tokens and query strings
 * are cut from every request line (log-redaction.ts).
 */
function loggerOptions(config: ApiConfig, given: AppDeps['logger']): boolean | object {
  const base = {
    level: config.LOG_LEVEL,
    // And never an address from an error (5.20): a refused row, a mail server's words.
    serializers: { req: requestForLog, err: errorForLog },
    // A multipart upload's parser writes, at trace level, the request's
    // headers — a sign-in's bearer token, a sender's session cookie (5.21).
    redact: { paths: LOG_REDACTED_PATHS, censor: '[redacted]' },
  };
  if (given === undefined) return base;
  if (typeof given !== 'object' || given === null) return given;
  const theirs = (given as { serializers?: object }).serializers ?? {};
  return {
    ...base,
    ...given,
    serializers: { ...base.serializers, ...theirs, req: requestForLog, err: errorForLog },
    redact: base.redact,
  };
}

export async function buildApp(config: ApiConfig, deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions(config, deps.logger),
    requestIdHeader: 'x-request-id',
    genReqId: () => crypto.randomUUID(),
    // Whose X-Forwarded-For is believed (client-address.ts): by default the
    // networks the API's own container is on, never the LAN (5.30).
    trustProxy: trustProxyFor(config.FDV_TRUST_PROXY, deps.ownNetworks ?? (() => ownNetworks())),
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    // Nothing the vault says is kept by a device's HTTP cache unless its
    // route says otherwise: a phone's HTTP stack stores every answer it may,
    // on disk, and keeps it after the phone is signed out.
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    // Which version answered: an app notices an upgrade from what it
    // already asks, instead of asking for the capability document again.
    reply.header('x-fdv-server-version', deps.serverVersion);
    // What a stranger's browser is sent (5.16): the share routes answer
    // people outside the family, and whatever they are sent — a file of
    // any kind included — is never framed, sniffed, run or passed on.
    if (req.url.startsWith(`${SHARE_COOKIE_PATH}/`) || req.url.startsWith(`${DROP_COOKIE_PATH}/`)) {
      for (const [name, value] of Object.entries(PUBLIC_API_HEADERS)) reply.header(name, value);
    }
  });

  // The session a share link's Open gives (5.16). Unsigned: its value is 32
  // random bytes the vault keeps only as a hash, so there is nothing to sign.
  await app.register(cookie);

  app.setNotFoundHandler((req, reply) => {
    const err = notFound();
    void reply.status(err.status).send(err.toBody(req.id));
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof ApiError) {
      if (err.options.retryAfter !== undefined) {
        void reply.header('retry-after', String(err.options.retryAfter));
      }
      void reply.status(err.status).send(err.toBody(req.id));
      return;
    }
    // Text PostgreSQL cannot keep — a NUL character, in whichever field —
    // is the caller's mistake, not the server's: 22021 in text, 22P05 in
    // JSON.
    const pgCode = (err as { code?: unknown }).code;
    // Two requests that got in each other's way (a deadlock, or a
    // serialization failure): nothing was done, and the next try works.
    if (pgCode === '40P01' || pgCode === '40001') {
      const busy = new ApiError(503, 'busy', 'The vault was busy just then. Try again.', {
        retriable: true,
        retryAfter: 1,
      });
      void reply.header('retry-after', '1');
      void reply.status(503).send(busy.toBody(req.id));
      return;
    }
    // What a write named went while it waited for it (a foreign key's
    // 23503): a document taken back into a batch's queue as somebody put it
    // in a collection or set a reminder for it (the I3 review, P-I3-2).
    // Nothing was done; it is the caller's to look again, not the server's.
    if (pgCode === '23503') {
      const gone = new ApiError(
        409,
        'gone_meanwhile',
        'What this was about was removed just then, so nothing was changed. Look again.',
      );
      void reply.status(409).send(gone.toBody(req.id));
      return;
    }
    // A write that waited for a reset or a lock to end the session asking
    // (0052's own SQLSTATE, FDV01, with the session's end as its detail):
    // that session is over, as its next request would be told. Nothing else
    // is answered so: a database refusing a connection is the server's.
    if (pgCode === 'FDV01') {
      const why = (err as { detail?: unknown }).detail;
      void reply
        .status(401)
        .send(endedMeanwhile(typeof why === 'string' && why ? why : null).toBody(req.id));
      return;
    }
    // A role but viewer's for somebody restricted (0054's own SQLSTATE,
    // FDV02): a restriction never stands beside another role, and the
    // routes that set one ask first; this answers whichever did not.
    if (pgCode === 'FDV02') {
      void reply.status(409).send(restrictedRefusal(null).toBody(req.id));
      return;
    }
    // A document made, changed, handed over or filed as a guest's (0056's
    // FDV04): a guest owns no document, by any path.
    if (pgCode === 'FDV04') {
      const refused = new ApiError(422, 'validation_failed', GUEST_OWNS_NOTHING, {
        detail: 'owner_member_id',
      });
      void reply.status(422).send(refused.toBody(req.id));
      return;
    }
    // A locked or paused sign-in deleted without its lock kept with the
    // person (0059's FDV05): the API keeps it first; anything that did not
    // is answered as the conflict it is, never as the server's fault.
    if (pgCode === 'FDV05') {
      const refused = new ApiError(
        409,
        'sign_in_suspended',
        'That sign-in is locked or paused. An owner unlocks it, or turns it back on, first.',
      );
      void reply.status(409).send(refused.toBody(req.id));
      return;
    }
    if (pgCode === '22021' || pgCode === '22P05') {
      const refused = new ApiError(
        422,
        'validation_failed',
        'That text contains a character the vault cannot keep.',
      );
      void reply.status(422).send(refused.toBody(req.id));
      return;
    }
    // An id that is no id at all — `/documents/abc` — reached the database
    // as one: there is nothing by it, so it is answered as nothing there, on
    // every route, never as the server's fault (the 5.17c review). A valid
    // id never raises this.
    if (pgCode === '22P02' && /\btype uuid\b/.test((err as Error).message ?? '')) {
      const nothing = new ApiError(404, 'not_found', 'Nothing in the vault has that id.');
      void reply.status(404).send(nothing.toBody(req.id));
      return;
    }
    const status =
      typeof (err as { statusCode?: number }).statusCode === 'number'
        ? (err as { statusCode: number }).statusCode
        : 500;
    if (status >= 500) req.log.error({ err }, 'unhandled error');
    const wrapped = new ApiError(
      status,
      status >= 500 ? 'internal_error' : 'bad_request',
      status >= 500
        ? 'Something went wrong on the server. It has been logged.'
        : ((err as Error).message ?? 'The request could not be understood.'),
      { retriable: status >= 500 },
    );
    void reply.status(status).send(wrapped.toBody(req.id));
  });

  // Liveness: the process is up. No dependencies consulted.
  app.get('/healthz', async () => ({ ok: true }));

  // Readiness: the process can do useful work.
  app.get('/readyz', async () => {
    try {
      await deps.pingDatabase();
    } catch (err) {
      throw notReady((err as Error).message);
    }
    return { ok: true };
  });

  // Auth endpoints get a tight per-route limit (see routes); this is the
  // ceiling for everything else, per address (FDV_RATE_LIMIT_PER_MINUTE, 300
  // unless raised: a household whose devices share one address may need more).
  // Every 429, from here or a route's own limit, is the one envelope:
  // rate_limited, retriable, with Retry-After (the plugin sets the header).
  await app.register(rateLimit, {
    global: true,
    max: config.FDV_RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    errorResponseBuilder: (_req, context) => {
      const seconds = Math.max(1, Math.ceil(context.ttl / 1000));
      return new ApiError(
        429,
        'rate_limited',
        `Too many requests at once. Try again in ${seconds} seconds.`,
        { retriable: true, retryAfter: seconds },
      );
    },
  });

  // API-01: the first call any client makes. Unauthenticated, and never
  // cached: it says which vault this is and what it runs, and a phone on
  // plain http checks the first before it sends anything. A kept answer
  // said the old version for five minutes after an upgrade — and could
  // vouch for a vault that was no longer there.
  app.get('/api/v1/capabilities', async (req, reply) => {
    const setupRequired = !(await deps.auth.setupComplete());
    const householdName = setupRequired ? null : await deps.auth.displayName();
    reply.header('cache-control', 'no-store');
    return buildCapabilities({
      serverVersion: deps.serverVersion,
      edition: config.FDV_EDITION,
      displayName: householdName ?? config.FDV_DISPLAY_NAME,
      maxUploadBytes: config.FDV_MAX_UPLOAD_BYTES,
      shareMaxDays: config.FDV_SHARE_MAX_DAYS,
      operatorMail: Boolean(config.FDV_SMTP_URL),
      setupRequired,
      pushEnabled: Boolean(config.FDV_VAPID_PUBLIC_KEY),
      // Without it the document is still true, only less specific; say
      // why in the log rather than failing the first call every client makes.
      instanceId: await (deps.instanceId?.() ?? Promise.resolve(null)).catch((err: unknown) => {
        req.log.warn({ err }, 'the installation id could not be read');
        return null;
      }),
    });
  });

  // Multipart bodies, for every route that takes one: a document's upload
  // (one file of FDV_MAX_UPLOAD_BYTES at most) and, since 5.17c, a person's
  // photo, whose route narrows the limits for itself. Registered ahead of
  // every route, not inside one group of them, so that no route's parsing
  // rests on the order the groups happen to be registered in.
  await app.register(multipart, { limits: { fileSize: config.FDV_MAX_UPLOAD_BYTES, files: 1 } });

  registerAuth(
    app,
    deps.auth,
    deps.totp,
    deps.passkeys,
    deps.stepUp,
    deps.passwords,
    deps.restrictions,
  );
  registerVaults(app, deps.vaults, deps.stepUp);
  registerHousehold(
    app,
    deps.household,
    deps.stepUp,
    deps.invitations,
    deps.coOwners,
    deps.photos,
    deps.restrictions,
  );
  registerAccess(app, deps.restrictions, deps.stepUp, deps.guests);
  registerIdentity(app, deps.identity, deps.stepUp);
  registerLocks(app, deps.locks, deps.stepUp);
  registerOwnerResets(app, deps.resets, deps.stepUp);
  registerExports(app, deps.exports, deps.stepUp);
  registerReminders(app, deps.reminders);
  registerSuggestions(app, deps.suggestions);
  registerNotifications(app, deps.notifications);
  registerAudit(app, deps.audit);
  registerOffline(app, deps.offline);
  registerTypes(app, deps.types);
  registerCollections(app, deps.collections);
  registerDocuments(
    app,
    deps.documents,
    deps.visibility,
    deps.sealedSearch,
    deps.stepUp,
    deps.shares,
    deps.uploads,
    deps.purge,
    deps.locks,
  );
  registerUploads(app, deps.uploads);
  registerIncoming(app, deps.incoming);
  registerBatches(app, deps.batches);

  return app;
}
