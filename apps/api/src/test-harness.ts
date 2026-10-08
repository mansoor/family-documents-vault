import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ALERT_LINK_KEY_PURPOSE,
  alertLinkBinding,
  deriveKey,
  EnvKeyProvider,
  OPERATOR_MAIL_KEY_PURPOSE,
  openBytes,
  operatorMailBinding,
  ScopeKeys,
} from '@fdv/crypto';
import { createDb, createPool, type Db, type Schema } from '@fdv/db';
import type { Role } from '@fdv/shared';
import { createTestDatabase, type TestDatabase } from '@fdv/db/testing';
import type { FastifyInstance } from 'fastify';
import { Kysely, PostgresDialect, type LogEvent } from 'kysely';
import { buildApp } from './app.js';
import { AuthService, type Tokens } from './auth/service.js';
import { codeFor, TotpService } from './auth/totp.js';
import { deriveSigningKey } from './auth/tokens.js';
import { loadConfig } from './config.js';
import type { Proposals } from './documents/proposal-pool.js';
import { DocumentService, type Enqueue } from './documents/service.js';
import { VisibilityService } from './documents/visibility.js';
import { TypeService } from './documents/types.js';
import { CollectionService } from './collections/service.js';
import { ExportService } from './exports/service.js';
import { NotificationService } from './notifications/service.js';
import { ReminderService } from './reminders/service.js';
import { HouseholdService } from './household/service.js';
import { PhotoService } from './household/photos.js';
import { IdentityService } from './household/identity.js';
import { InvitationService } from './household/invitations.js';
import { CoOwnerService } from './household/co-owners.js';
import { LockService } from './household/locks.js';
import { RestrictionService } from './household/restrictions.js';
import { GuestService } from './household/guests.js';
import { OwnerResetService } from './household/owner-resets.js';
import {
  SHARE_CODE_KEY_PURPOSE,
  SHARE_DEVICE_KEY_PURPOSE,
  ShareService,
} from './documents/shares.js';
import { deviceCookieKey } from './public/device-cookie.js';
import { MAIL_JOB, mailJob, type MailRequest } from './mail-job.js';
import {
  UPLOAD_CODE_KEY_PURPOSE,
  UPLOAD_DEVICE_KEY_PURPOSE,
  UploadRequestService,
} from './uploads/requests.js';
import { PurgeService } from './documents/purge.js';
import { IncomingService, type IncomingOptions } from './uploads/incoming.js';
import { BatchService, type BatchOptions } from './uploads/batches.js';
import { AuditService } from './audit/service.js';
import { OfflineService } from './offline/service.js';
import { SealedSearchService } from './documents/sealed-search.js';
import { deriveSealedKey } from './documents/sealed-token.js';
import { deriveCursorKey } from './documents/table.js';
import { PasskeyService, passkeyConfig } from './auth/passkeys.js';
import { StepUpService } from './auth/step-up.js';
import { PasswordService } from './auth/passwords.js';
import { SuggestionService } from './suggestions/service.js';
import { VaultService } from './vaults/service.js';
import { alertJob, type AlertRequest } from './alert-job.js';
import { pushJob, type PushRequest } from './push-job.js';
import { instanceIdReader } from './instance.js';
import { serverVersion } from './version.js';

/**
 * A fully wired API on a throwaway database with a temp local vault.
 * Integration tests build one per file.
 */
export const TEST_MASTER = 'test-master-key-that-is-long-enough-0123456789';

export interface Harness {
  app: FastifyInstance;
  db: Db;
  /** The owning role, for fixtures that must go round the application role. */
  adminUrl: string;
  /** The application role, for a test that needs a pool of its own (one connection, say). */
  appUrl: string;
  vaultDir: string;
  /** Jobs the API asked the worker to run. */
  jobs: Array<{
    name: string;
    data: Record<string, unknown>;
    options?: { singletonKey?: string; priority?: number };
  }>;
  close(): Promise<void>;
  /** Runs first-run setup and returns the owner's tokens. */
  setup(overrides?: Partial<SetupBody>): Promise<Tokens>;
  /** Bearer header for a token set. */
  as(t: Tokens): { authorization: string };
  /**
   * A second person, through the real invitation path: invited by `owner`,
   * accepted with the link and the code. This is how the role tests get a
   * teen and a viewer to try things with.
   */
  join(owner: Tokens, who: JoinRequest): Promise<Tokens>;
  /**
   * Somebody who may decide what takes a passkey or a code (A54): their
   * two-step sign-in turned on (once), and each of their sessions marked
   * as having just given a code. For the tests whose owner invites a viewer
   * who sees every family document (5.34) but which are not about asking.
   */
  decider(t: Tokens): Promise<void>;
  /**
   * DNS as the vault sees it when a push address is registered (4.13): a
   * host here resolves to these addresses; any other fails to resolve,
   * which leaves the check to the worker, as in production.
   */
  dns: Map<string, string[]>;
}

export interface JoinRequest {
  name: string;
  email: string;
  role: Role;
  password?: string;
}

export interface SetupBody {
  household_name: string;
  display_name: string;
  email: string;
  password: string;
}

export interface HarnessOptions {
  /** Hears every query the API runs, as Kysely logs it: for a test that listens. */
  log?: (event: LogEvent) => void;
  /** The API's own request log (pino options), for a test that reads it; off otherwise. */
  logger?: object;
  /** FDV_PUBLIC_URL: the public-only site share links start with (5.16). */
  publicUrl?: string;
  /** FDV_SHARE_MAX_DAYS: the longest a share link may last (5.18). */
  shareMaxDays?: number;
  /**
   * FDV_RATE_LIMIT_PER_MINUTE: for a file whose signed-in calls, all from one
   * address, pass the 300 a minute on a fast runner. Routes with their own
   * limit keep it.
   */
  rateLimitPerMinute?: number;
  /**
   * FDV_SMTP_URL set: the operator's mail server, which alone sends a link's
   * code (5.20). On unless a test says false, as passwords.test.ts's reset
   * route is.
   */
  operatorMail?: boolean;
  /**
   * How a code is sent, in place of the harness's capture (mailSent): for a
   * test whose queue fails (the 5.20 review, M520-02).
   */
  mail?: (m: MailRequest) => Promise<void>;
  /** The household's room for files waiting for review, in bytes (5.21). */
  incomingMaxBytes?: number;
  /** A decision on a file sent in, held before it commits (5.23): for the races. */
  incomingBeforeCommit?: IncomingOptions['beforeCommit'];
  /** A batch's removal, held once fenced and before its rows go (the I1 review): for the races. */
  batchBetweenRemoval?: BatchOptions['betweenRemoval'];
  /** FDV_TRUST_PROXY (5.30): whose X-Forwarded-For is believed; `network` otherwise. */
  trustProxy?: 'network' | 'private' | 'all' | 'none';
  /** Where pages are proposed for (5.37): the process's proposal thread, unless a test stands in. */
  proposals?: Proposals;
}

/** The key the harness's `mail.to_address` jobs are sealed under, as the worker's are. */
export const TEST_MAIL_KEY = deriveKey(TEST_MASTER, OPERATOR_MAIL_KEY_PURPOSE);

/**
 * What the harness caught on its way to one address (5.20): each
 * `mail.to_address` job, opened as the worker opens it. The test harness's
 * mail capture: nothing leaves it.
 */
export function mailSent(h: Pick<Harness, 'jobs'>): Array<MailRequest> {
  return h.jobs
    .filter((j) => j.name === MAIL_JOB)
    .map((j) => {
      const householdId = String(j.data.household_id);
      const opened = JSON.parse(
        openBytes(
          TEST_MAIL_KEY,
          Buffer.from(String(j.data.sealed), 'base64'),
          operatorMailBinding(householdId),
        ).toString('utf8'),
      ) as { to: string; subject: string; text: string };
      return { householdId, ...opened };
    });
}

/** The key the harness's `alert.send` links are sealed under, as the worker's are (F529-11). */
export const TEST_ALERT_KEY = deriveKey(TEST_MASTER, ALERT_LINK_KEY_PURPOSE);

/**
 * Each `alert.send` job, as the worker reads it: its link, sealed on the
 * queue, opened as `url`. The test harness's view of what the alert says;
 * `h.jobs` keeps what the queue holds.
 */
export function alertsSent(h: Pick<Harness, 'jobs'>): Array<Record<string, unknown>> {
  return h.jobs
    .filter((j) => j.name === 'alert.send')
    .map((j) => {
      const { sealed_url: sealed, ...rest } = j.data;
      if (typeof sealed !== 'string') return rest;
      const url = openBytes(
        TEST_ALERT_KEY,
        Buffer.from(sealed, 'base64'),
        alertLinkBinding(String(j.data.household_id)),
      ).toString('utf8');
      return { ...rest, url };
    });
}

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const tdb: TestDatabase = await createTestDatabase();
  const vaultDir = await mkdtemp(path.join(tmpdir(), 'fdv-api-vault-'));
  const pool = createPool(tdb.appUrl, 4);
  const db = opts.log
    ? new Kysely<Schema>({ dialect: new PostgresDialect({ pool }), log: opts.log })
    : createDb(pool);
  const config = loadConfig({
    DATABASE_URL: tdb.appUrl,
    FDV_MASTER_KEY: TEST_MASTER,
    FDV_LOCAL_VAULT_DIR: vaultDir,
    LOG_LEVEL: 'error',
    ...(opts.shareMaxDays ? { FDV_SHARE_MAX_DAYS: String(opts.shareMaxDays) } : {}),
    ...(opts.rateLimitPerMinute
      ? { FDV_RATE_LIMIT_PER_MINUTE: String(opts.rateLimitPerMinute) }
      : {}),
    ...(opts.trustProxy ? { FDV_TRUST_PROXY: opts.trustProxy } : {}),
    // Nothing is ever sent to it: the harness catches every email (mailSent).
    ...(opts.operatorMail === false ? {} : { FDV_SMTP_URL: 'smtp://operator-mail.test:25' }),
  });
  const vaults = new VaultService(db, deriveKey(TEST_MASTER, 'vault-credentials'), vaultDir);
  const keys = new ScopeKeys(new EnvKeyProvider(TEST_MASTER));
  const jobs: Harness['jobs'] = [];
  const dns: Harness['dns'] = new Map();
  const enqueue: Enqueue = async (name, data, options) => {
    jobs.push({ name, data, ...(options ? { options } : {}) });
  };
  // The same mapping as production, not a copy of it: see alert-job.ts.
  const alert = (a: AlertRequest) => enqueue('alert.send', alertJob(TEST_ALERT_KEY, a));
  // What the worker pushes (4.13): the same mapping here and in tests, as alerts.
  const push = (r: PushRequest) => enqueue('push.send', pushJob(r));
  // And an email to one address (5.20): the same sealed mapping as production.
  const operatorMail = (m: MailRequest) => enqueue(MAIL_JOB, mailJob(TEST_MAIL_KEY, m));
  const reminders = new ReminderService(db);
  const totp = new TotpService(
    db,
    deriveKey(TEST_MASTER, 'totp-secrets'),
    deriveSigningKey(TEST_MASTER),
  );
  const auth = new AuthService(
    db,
    deriveSigningKey(TEST_MASTER),
    keys,
    (trx, hh) => vaults.createDefaultLocal(trx, hh),
    alert,
    totp,
    push,
  );
  const passkeys = new PasskeyService(
    db,
    auth,
    passkeyConfig('http://localhost:8080', 'Test vault'),
  );
  const invitations = new InvitationService(db, keys, auth);
  let joined = 1;
  /** The owning role, for `join`'s viewers: made when first asked for. */
  let admin: ReturnType<typeof createPool> | null = null;
  const stepUp = new StepUpService(db, passkeys, totp);
  // As if the operator had set FDV_SMTP_URL, unless the test said not
  // (operatorMail: false); passwords.test.ts also builds one without it.
  const passwords = new PasswordService(
    db,
    keys,
    stepUp,
    'http://localhost:8080',
    alert,
    Boolean(config.FDV_SMTP_URL),
    push,
    enqueue,
  );
  const resets = new OwnerResetService(
    db,
    (token) => passwords.linkFor(token),
    Boolean(config.FDV_SMTP_URL),
    alert,
    push,
  );
  const documents = new DocumentService(
    db,
    keys,
    vaults,
    5 * 1024 * 1024,
    enqueue,
    reminders,
    deriveSealedKey(TEST_MASTER),
    deriveCursorKey(TEST_MASTER),
    opts.proposals,
  );
  const collections = new CollectionService(db, documents);
  const app = await buildApp(config, {
    serverVersion: await serverVersion(),
    instanceId: instanceIdReader(db),
    pingDatabase: async () => undefined,
    auth,
    totp,
    passkeys,
    stepUp: stepUp,
    passwords,
    visibility: new VisibilityService(db, keys, enqueue),
    vaults,
    documents,
    purge: new PurgeService(db, vaults, documents, alert, enqueue),
    types: new TypeService(db, enqueue, stepUp),
    collections,
    offline: new OfflineService(db, documents, config.FDV_OFFLINE_MAX_DAYS),
    sealedSearch: new SealedSearchService(db, keys, deriveSealedKey(TEST_MASTER)),
    shares: new ShareService(db, keys, vaults, alert, opts.publicUrl ?? null, {
      enqueue,
      maxDays: config.FDV_SHARE_MAX_DAYS,
      codeKey: deriveKey(TEST_MASTER, SHARE_CODE_KEY_PURPOSE),
      mail: config.FDV_SMTP_URL ? (opts.mail ?? operatorMail) : null,
      deviceKey: deviceCookieKey(TEST_MASTER, SHARE_DEVICE_KEY_PURPOSE),
    }),
    uploads: new UploadRequestService(db, keys, vaults, {
      maxDays: config.FDV_SHARE_MAX_DAYS,
      maxFileBytes: 5 * 1024 * 1024,
      publicUrl: opts.publicUrl ?? null,
      codeKey: deriveKey(TEST_MASTER, UPLOAD_CODE_KEY_PURPOSE),
      mail: config.FDV_SMTP_URL ? (opts.mail ?? operatorMail) : null,
      deviceKey: deviceCookieKey(TEST_MASTER, UPLOAD_DEVICE_KEY_PURPOSE),
      enqueue,
      alert,
      ...(opts.incomingMaxBytes ? { householdMaxBytes: opts.incomingMaxBytes } : {}),
    }),
    incoming: new IncomingService(db, keys, vaults, documents, {
      enqueue,
      ...(opts.incomingBeforeCommit ? { beforeCommit: opts.incomingBeforeCommit } : {}),
    }),
    batches: new BatchService(
      db,
      keys,
      vaults,
      documents,
      collections,
      5 * 1024 * 1024,
      enqueue,
      opts.batchBetweenRemoval ? { betweenRemoval: opts.batchBetweenRemoval } : {},
    ),
    audit: new AuditService(db),
    reminders,
    notifications: new NotificationService(
      db,
      deriveKey(TEST_MASTER, 'smtp-credentials'),
      'test-vapid-public-key',
      alert,
      {
        push,
        resolve: async (host) => {
          const found = dns.get(host);
          if (!found) throw new Error(`ENOTFOUND ${host}`);
          return found;
        },
      },
    ),
    exports: new ExportService(db, keys, vaults, enqueue),
    household: new HouseholdService(db, keys, stepUp, config.FDV_OFFLINE_MAX_DAYS, (trx, target) =>
      resets.pathFor(trx, target),
    ),
    photos: new PhotoService(db, keys, vaults, enqueue, config.FDV_MAX_UPLOAD_BYTES),
    identity: new IdentityService(db, keys, alert, Boolean(config.FDV_SMTP_URL), push),
    invitations,
    coOwners: new CoOwnerService(db, alert, push, enqueue),
    locks: new LockService(db, alert, push, enqueue),
    restrictions: new RestrictionService(db, alert),
    // 5.34: a guest's sign-in renewed by an owner (A28).
    guests: new GuestService(db),
    resets,
    suggestions: new SuggestionService(db),
    logger: opts.logger ?? false,
  });

  return {
    app,
    db,
    adminUrl: tdb.adminUrl,
    appUrl: tdb.appUrl,
    vaultDir,
    jobs,
    dns,
    async close() {
      await app.close();
      await admin?.end();
      await db.destroy();
      await tdb.drop();
      await rm(vaultDir, { recursive: true, force: true });
    },
    async setup(overrides = {}) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/setup',
        payload: {
          household_name: 'The Test family',
          display_name: 'Owner',
          email: 'owner@example.test',
          password: 'correct horse battery',
          ...overrides,
        },
      });
      if (res.statusCode !== 201) throw new Error(`setup failed: ${res.body}`);
      return res.json<Tokens>();
    },
    as: (t) => ({ authorization: `Bearer ${t.access_token}` }),
    async decider(t) {
      admin ??= createPool(tdb.adminUrl, 1);
      const { rows } = await admin.query<{ account_id: string; on: boolean }>(
        `select a.account_id, c.totp_confirmed_at is not null as on
           from account_household a join account c on c.id = a.account_id
          where a.member_id = $1`,
        [t.member_id],
      );
      const markFresh = () =>
        admin?.query(
          `update session set verified_at = now(), factor_verified_at = now()
            where account_id = $1 and revoked_at is null`,
          [rows[0]?.account_id],
        );
      await markFresh();
      if (rows[0] && !rows[0].on) {
        const enrol = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/totp/enrol',
          headers: { authorization: `Bearer ${t.access_token}` },
        });
        if (enrol.statusCode >= 300) throw new Error(`two-step failed: ${enrol.body}`);
        const confirmed = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/totp/confirm',
          headers: { authorization: `Bearer ${t.access_token}` },
          payload: { code: codeFor(enrol.json<{ secret: string }>().secret) },
        });
        if (confirmed.statusCode >= 300) throw new Error(`two-step failed: ${confirmed.body}`);
      }
      await markFresh();
    },
    async join(owner, who) {
      // A viewer who sees every family document is an owner's decision,
      // taken with a passkey or a code (5.34, A27, A54) — which
      // invitations.test.ts and guests.test.ts try. The tests that only need
      // such a viewer are not about that decision: the invitation is made
      // for a teen, and the owning role makes it a viewer's before it is
      // accepted, through the real accept.
      const viewer = who.role === 'viewer';
      const invited = await app.inject({
        method: 'POST',
        url: '/api/v1/invitations',
        headers: { authorization: `Bearer ${owner.access_token}` },
        payload: { display_name: who.name, email: who.email, role: viewer ? 'teen' : who.role },
      });
      if (invited.statusCode !== 201) throw new Error(`invite failed: ${invited.body}`);
      const { link_token, code, invitation } = invited.json<{
        link_token: string;
        code: string;
        invitation: { id: string };
      }>();
      if (viewer) {
        admin ??= createPool(tdb.adminUrl, 1);
        await admin.query("update invitation set role = 'viewer' where id = $1", [invitation.id]);
      }
      const accepted = await app.inject({
        method: 'POST',
        url: `/api/v1/invitations/${link_token}/accept`,
        payload: { code, password: who.password ?? 'another correct horse' },
        // Accepting is rate-limited per address like signing in. Tests that
        // add several people would otherwise throttle themselves.
        remoteAddress: `10.8.${joined >> 8}.${joined++ & 0xff}`,
      });
      if (accepted.statusCode !== 201) throw new Error(`accept failed: ${accepted.body}`);
      return accepted.json<Tokens>();
    },
  };
}
