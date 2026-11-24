import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ALERT_LINK_KEY_PURPOSE,
  alertLinkBinding,
  deriveKey,
  EnvKeyProvider,
  MAILBOX_PASSWORD_PURPOSE,
  OPERATOR_MAIL_KEY_PURPOSE,
  openBytes,
  operatorMailBinding,
  ScopeKeys,
  SMS_PASSWORD_PURPOSE,
  AI_READER_KEY_PURPOSE,
  BACKUP_OFFSITE_KEY_PURPOSE,
  SHARE_LINK_COPY_PURPOSE,
  UPLOAD_REQUEST_COPY_PURPOSE,
} from '@fdv/crypto';
import { createDb, createPool, type Db, type Schema } from '@fdv/db';
import type { CabinetLayout, CabinetLevel, Role } from '@fdv/shared';
import type { OffsiteBucket, OffsiteTestFound } from '@fdv/storage';
import { createTestDatabase, type TestDatabase } from '@fdv/db/testing';
import type { FastifyInstance } from 'fastify';
import { Kysely, PostgresDialect, type LogEvent } from 'kysely';
import { buildApp } from './app.js';
import { AuthService, type Tokens } from './auth/service.js';
import { codeFor, TotpService } from './auth/totp.js';
import { SignInGuard } from './auth/sign-in-guard.js';
import { deriveSigningKey } from './auth/tokens.js';
import { loadConfig } from './config.js';
import type { ChecklistReader, Proposals } from './documents/proposal-pool.js';
import { DocumentService, type Enqueue } from './documents/service.js';
import { VisibilityService } from './documents/visibility.js';
import { TypeService } from './documents/types.js';
import { CollectionService } from './collections/service.js';
import { CabinetService } from './cabinet/service.js';
import { CaregiverService } from './caregivers/service.js';
import { EmergencyService } from './emergency/service.js';
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
import { ZipService } from './documents/zip.js';
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
import { DEVICE_KEY_PURPOSE, DeviceService } from './devices/service.js';
import { AppService } from './apps/service.js';
import { AuditService } from './audit/service.js';
import { OfflineService } from './offline/service.js';
import { SealedSearchService } from './documents/sealed-search.js';
import { deriveSealedKey } from './documents/sealed-token.js';
import { deriveCursorKey } from './documents/table.js';
import { PasskeyService, passkeyConfig } from './auth/passkeys.js';
import { SetupToken } from './auth/setup-token.js';
import { StepUpService } from './auth/step-up.js';
import { PasswordService } from './auth/passwords.js';
import { SuggestionService } from './suggestions/service.js';
import { VaultService } from './vaults/service.js';
import { alertJob, type AlertRequest } from './alert-job.js';
import { pushJob, type PushRequest } from './push-job.js';
import { instanceIdReader } from './instance.js';
import { WatchFolderService } from './watch-folder/service.js';
import { ReadingCheckService } from './reading-check/service.js';
import { MAIL_IN_CODE_KEY_PURPOSE, MailInService } from './mail-in/service.js';
import { SettingsCheckService } from './settings-checks.js';
import { LocalAiService } from './household/local-ai.js';
import { AiReaderService } from './household/ai-reader.js';
import { BackupOffsiteService } from './backups/offsite.js';
import { SecurityHealthService } from './backups/health.js';
import { PHONE_CODE_KEY_PURPOSE, MemberPhoneService } from './sms/phones.js';
import type { SmsProvider, SmsProviderFactory } from '@fdv/db';
import { SmsService } from './sms/service.js';
import { SMS_CODE_KEY_PURPOSE, TextCodeService } from './sms/codes.js';
import { serverVersion } from './version.js';

/**
 * A cabinet layout made by a test, as the vault takes one (0.9.0-dev.94):
 * arranged by levels (Topic › Year › Person where it gives none), every
 * cabinet drawn as a drawing would draw it. With two levels, the one
 * cabinet drawn for none (`null`); with more, each for a value of the first
 * level — a cabinet not drawn by the test, for the topic every folder of it
 * asks (`category`) where there is one no other cabinet has, else for its
 * own id, which no drawing gives, so the vault grows papers beside it,
 * never into it. For tests of what folders hold, not of drawing.
 */
export function asArranged(
  layout: Omit<CabinetLayout, 'levels'> & { levels?: CabinetLevel[] | null },
): CabinetLayout {
  const levels = layout.levels ?? ['topic', 'year', 'person'];
  const taken = new Set(layout.cabinets.flatMap((c) => (c.drawn ? [c.drawn.value] : [])));
  const valueOf = (c: CabinetLayout['cabinets'][number]): string | null => {
    if (levels.length <= 2) return null;
    const topics = new Set(c.drawers.flatMap((d) => d.folders.map((f) => f.filter.category)));
    const [topic] = topics;
    const value =
      levels[0] === 'topic' && topics.size === 1 && topic && !topic.includes(',') ? topic : c.id;
    return taken.has(value) ? c.id : value;
  };
  return {
    ...layout,
    levels,
    cabinets: layout.cabinets.map((c) => {
      if (c.drawn) return c;
      const value = valueOf(c);
      taken.add(value);
      return { ...c, drawn: { value } };
    }),
  };
}

/**
 * A fully wired API on a throwaway database with a temp local vault.
 * Integration tests build one per file.
 */
export const TEST_MASTER = 'test-master-key-that-is-long-enough-0123456789';

/** The setup code the harness's vault takes (0.9.0), as FDV_SETUP_TOKEN would give it. */
export const TEST_SETUP_TOKEN = 'test-setup-code-of-the-harness-0001';

export interface Harness {
  app: FastifyInstance;
  db: Db;
  /** Failed sign-ins counted per account (0.9.0): `settled()` waits for its lines and alerts. */
  guard: SignInGuard;
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
  /** The batches, for a test that sends a file as a stream it holds (the D1 review). */
  batches: BatchService;
  /** The connected apps' service (APP1), for a test that moves its clock. */
  apps: AppService;
  /**
   * Every text the harness's own SMS Gate was asked to send (SMS1), in
   * order: nothing leaves it. Each is Delivered at once. Empty when a test
   * brings an SMS Gate of its own (`smsProvider`).
   */
  texts: SentText[];
}

/** A text the harness's provider took: to whom, and what it said. */
export interface SentText {
  to: string;
  text: string;
  /** Where it was asked to go, as the household set it up: SMS Gate's address, or `twilio`. */
  baseUrl: string;
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
  /** Told of each batch item whose sealed proposal is opened (the I2 review). */
  batchOpened?: BatchOptions['opened'];
  /** An Undo of Accept all Ready, held with the document held (I3): for the races. */
  batchUndoHeld?: BatchOptions['undoHeld'];
  /** An accept held once it has taught its first step (I4-5). */
  batchLearnTaught?: BatchOptions['learnTaught'];
  /** FDV_TRUST_PROXY (5.30): whose X-Forwarded-For is believed; `network` otherwise. */
  trustProxy?: 'network' | 'private' | 'all' | 'none';
  /** Where pages are proposed for (5.37): the process's proposal thread, unless a test stands in. */
  proposals?: Proposals;
  /** Where a collection's checklist is read (0.9.0, C1): the same thread, unless a test stands in. */
  checklistReader?: ChecklistReader;
  /** FDV_DESKTOP_DOWNLOAD_URL (0.8.0, D1): where the uploader app for computers is downloaded. */
  desktopDownloadUrl?: string;
  /** FDV_DEVICE_DAILY_BYTES (0.8.0, D1): the most one computer may send in a day. */
  deviceDailyBytes?: number;
  /** FDV_BASE_URL: http://localhost:8080 unless a test says (APP1's https rule). */
  baseUrl?: string;
  /** FDV_PUBLIC_APPS (APP1): off unless a test says on. */
  publicApps?: 'on' | 'off';
  /** The connected apps' clock (APP1): a signature's window, a day's caps. */
  appsNow?: () => number;
  /** FDV_APP_DAILY_FILES (APP1): the ceiling of an app's files a day. */
  appDailyFiles?: number;
  /** The clock of the scanner folder's, email in's and the Settings checks' services (O1). */
  now?: () => number;
  /** SMS Gate (SMS1): the harness's own, which delivers every text at once, unless a test stands in. */
  smsProvider?: SmsProviderFactory;
  /** How long a test text is waited for, and how often asked after (SMS1): short, for the tests. */
  smsTestWaitMs?: number;
  /** Where a text provider's own detail goes (the API's log in server.ts), for a test that reads it. */
  smsLog?: (fields: Record<string, unknown>, message: string) => void;
  /** FDV_EDITION: self_hosted unless a test says (AIR1's hosted guards). */
  edition?: 'self_hosted' | 'hosted';
  /**
   * Settings → Backups' test (0.9.0-dev.76): a small file written to the
   * bucket and deleted. Unless a test stands in, the real one, which reaches
   * only the S3 test server's address.
   */
  offsiteTest?: (b: OffsiteBucket) => Promise<OffsiteTestFound>;
  /** Settings → System health's clock (0.9.0): what is late, and what is due. */
  healthNow?: () => Date;
  /** FDV_AI_READER_SETTINGS (AIR1): on unless a test says off. */
  aiReaderSettings?: 'on' | 'off';
  /** DNS for the AI reader's address (AIR1): the harness's own, a name → its addresses. */
  aiResolve?: (host: string) => Promise<string[]>;
  /**
   * DNS for the names in a connected app's allow-list (APP7): a name and a
   * family → its addresses. Unless a test stands in, no name is found.
   */
  appsResolve?: (name: string, family: 4 | 6) => Promise<Array<{ address: string; ttl: number }>>;
  /**
   * Two-step sign-in held to (0.9.0): an owner, or an adult where the
   * household asks it, with neither a code nor a passkey may only set one
   * up. Off unless a test says on — production always holds to it; the
   * tests that are not about it sign owners in with a password alone.
   */
  twoStep?: boolean;
  /**
   * Failed sign-ins counted per account (0.9.0): a wait after five in a
   * row, the activity line, the alerts. Off unless a test asks, as two-step
   * sign-in is: the tests not about it fail sign-ins on purpose, often.
   */
  signInGuard?: boolean;
  /**
   * A code from an authenticator app refused a second time (0.9.0). Off
   * unless a test asks: the tests not about it give the same code twice in
   * thirty seconds, as nobody signing in does.
   */
  totpReplay?: boolean;
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

/**
 * A log, a job or a JSON answer with what may hold a short run of digits by
 * chance taken out, and JSON's escapes undone first (`\n`, `\r`, `\t`, `\"`,
 * `\\`, `\/` and `\uXXXX` become a space, so "\n123456" in a stringified log
 * is the code after a line break, not after an "n"): random ids (UUIDs),
 * other hex ids of 16 characters or more (hashes, tokens), times (ISO 8601)
 * and numbers with a fractional part (a response time). None of them can
 * carry a code or a PIN a test is making sure never reaches it.
 */
export function withoutChanceDigits(text: string): string {
  return text
    .replace(/\\u[0-9a-fA-F]{4}|\\[nrt"\\/bf]/g, ' ')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/(?<![0-9A-Za-z])[0-9a-f]{16,}(?![0-9A-Za-z])/gi, '<hex>')
    .replace(
      /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g,
      '<time>',
    )
    .replace(/\d+\.\d+(?:e[+-]?\d+)?/gi, '<n>');
}

/**
 * Whether a short secret of digits — a code by text or email, a PIN; pass a
 * spaced form ("123 456") to look for that too — is in `text`, with nothing
 * but other digits ruled out around it: not inside a longer number, nor in
 * an id, a time or a timing (taken out first), where a random collision put
 * "024137" in a request log once (the dev.44 flake; the dev.36 one was "505"
 * in a UUID). A letter before or after is no cover: "code123456" is a leak.
 */
export function holdsDigits(text: string, digits: string): boolean {
  const escaped = digits.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![0-9])${escaped}(?![0-9])`).test(withoutChanceDigits(text));
}

/** The key the harness's `alert.send` links are sealed under, as the worker's are (F529-11). */
export const TEST_ALERT_KEY = deriveKey(TEST_MASTER, ALERT_LINK_KEY_PURPOSE);

/** A connected app's API key (APP6), as an owner generates it and the app sends it. */
export interface TestAppKey {
  keyId: string;
  clientId: string;
  secret: string;
}

/**
 * An API key for a connected app, generated by an owner as Settings does
 * (with the step-up they were just given): every permission the app has,
 * for 30 days, unless the test says otherwise.
 */
export async function appKeyFor(
  h: Pick<Harness, 'app' | 'as'>,
  by: Tokens,
  app: { id: string; scopes: readonly string[] },
  body: Record<string, unknown> = {},
): Promise<TestAppKey> {
  const res = await h.app.inject({
    method: 'POST',
    url: `/api/v1/connected-apps/${app.id}/keys`,
    headers: h.as(by),
    payload: { permissions: [...app.scopes], expires_in_days: 30, ...body },
  });
  if (res.statusCode !== 201) throw new Error(`no key: ${res.statusCode} ${res.body}`);
  const made = res.json<{ key: { id: string }; client_id: string; secret: string }>();
  return { keyId: made.key.id, clientId: made.client_id, secret: made.secret };
}

/** The header an app sends its key in: `Authorization: Basic base64(client_id:secret)`. */
export function basicFor(k: { clientId: string; secret: string }): { authorization: string } {
  return {
    authorization: `Basic ${Buffer.from(`${k.clientId}:${k.secret}`, 'utf8').toString('base64')}`,
  };
}

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
    ...(opts.edition ? { FDV_EDITION: opts.edition } : {}),
    ...(opts.aiReaderSettings ? { FDV_AI_READER_SETTINGS: opts.aiReaderSettings } : {}),
    ...(opts.baseUrl ? { FDV_BASE_URL: opts.baseUrl } : {}),
    ...(opts.publicApps ? { FDV_PUBLIC_APPS: opts.publicApps } : {}),
    ...(opts.appDailyFiles ? { FDV_APP_DAILY_FILES: String(opts.appDailyFiles) } : {}),
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
  // Text messages (SMS1): an SMS Gate that delivers every text at once and
  // keeps it in h.texts, unless a test brings its own.
  const texts: SentText[] = [];
  const delivering: SmsProviderFactory = (c): SmsProvider => ({
    send: async (to, text) => {
      texts.push({ to, text, baseUrl: c.provider === 'twilio' ? 'twilio' : c.baseUrl });
      return { id: `text-${texts.length}`, state: 'delivered' };
    },
    state: async () => ({ state: 'delivered' }),
  });
  const sms = new SmsService(db, {
    key: deriveKey(TEST_MASTER, SMS_PASSWORD_PURPOSE),
    provider: opts.smsProvider ?? delivering,
    alert,
    testWaitMs: opts.smsTestWaitMs ?? 2000,
    pollMs: 20,
    resolve: async (host) => {
      const found = dns.get(host);
      if (!found) throw new Error(`ENOTFOUND ${host}`);
      return found;
    },
  });
  if (opts.smsLog) sms.useLog(opts.smsLog);
  // Codes by text to one's own number (SMS3).
  const textCodes = new TextCodeService(db, sms, {
    codeKey: deriveKey(TEST_MASTER, SMS_CODE_KEY_PURPOSE),
    alert,
  });
  const totp = new TotpService(
    db,
    deriveKey(TEST_MASTER, 'totp-secrets'),
    deriveSigningKey(TEST_MASTER),
    { refuseReplay: opts.totpReplay ?? false },
  );
  const guard = new SignInGuard(db, deriveSigningKey(TEST_MASTER), alert, {
    enabled: opts.signInGuard ?? false,
  });
  const auth = new AuthService(
    db,
    deriveSigningKey(TEST_MASTER),
    keys,
    (trx, hh) => vaults.createDefaultLocal(trx, hh),
    alert,
    totp,
    push,
    textCodes,
    { twoStep: opts.twoStep ?? false, guard },
  );
  auth.useSetupToken(new SetupToken(TEST_SETUP_TOKEN));
  const passkeys = new PasskeyService(
    db,
    auth,
    passkeyConfig('http://localhost:8080', 'Test vault'),
  );
  const invitations = new InvitationService(db, keys, auth, sms);
  let joined = 1;
  /** The owning role, for `join`'s viewers: made when first asked for. */
  let admin: ReturnType<typeof createPool> | null = null;
  const stepUp = new StepUpService(db, passkeys, totp, textCodes, guard);
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
    textCodes,
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
  const collections = new CollectionService(db, documents, opts.checklistReader, alert);
  const batches = new BatchService(
    db,
    keys,
    vaults,
    documents,
    collections,
    5 * 1024 * 1024,
    enqueue,
    {
      ...(opts.batchBetweenRemoval ? { betweenRemoval: opts.batchBetweenRemoval } : {}),
      ...(opts.batchOpened ? { opened: opts.batchOpened } : {}),
      ...(opts.batchUndoHeld ? { undoHeld: opts.batchUndoHeld } : {}),
      ...(opts.batchLearnTaught ? { learnTaught: opts.batchLearnTaught } : {}),
    },
  );
  // What an owner asks the worker from Settings (O1): the job is in h.jobs,
  // and a test answers it as the worker would.
  const settingsChecks = new SettingsCheckService(db, enqueue, opts.now);
  // The AI reader set in Settings (AIR1): DNS the harness's own, never the network's.
  const localAiState = new LocalAiService(db, settingsChecks);
  const aiReader = new AiReaderService(db, {
    key: deriveKey(TEST_MASTER, AI_READER_KEY_PURPOSE),
    edition: config.FDV_EDITION,
    settings: config.FDV_AI_READER_SETTINGS,
    allowedPorts: config.FDV_AI_READER_ALLOWED_PORTS,
    checks: settingsChecks,
    // The harness's own addresses: none, so a test's 192.168.x is never this machine's.
    ownAddresses: () => new Set(),
    server: () => localAiState.server(),
    resolve:
      opts.aiResolve ??
      (async (host) => {
        throw new Error(`no address for ${host} in the harness`);
      }),
    alert,
  });
  const apps = new AppService(db, batches, {
    baseUrl: config.FDV_BASE_URL,
    publicUrl: opts.publicUrl ?? null,
    appsPublic: config.FDV_PUBLIC_APPS === 'on',
    localHttp: config.FDV_APPS_LOCAL_HTTP === 'on',
    maxUploadBytes: 5 * 1024 * 1024,
    ceilings: { files: config.FDV_APP_DAILY_FILES, bytes: config.FDV_APP_DAILY_BYTES },
    serverVersion: await serverVersion(),
    instanceId: instanceIdReader(db),
    alert,
    ...(opts.appsNow ? { now: opts.appsNow } : {}),
    documents,
    resolveName:
      opts.appsResolve ??
      (async (name) => {
        throw Object.assign(new Error(`no address for ${name} in the harness`), {
          code: 'ESERVFAIL',
        });
      }),
  });
  const app = await buildApp(config, {
    apps,
    cabinet: new CabinetService(db, documents),
    caregivers: new CaregiverService(db, new VisibilityService(db, keys, enqueue)),
    emergency: new EmergencyService(db, keys),
    serverVersion: await serverVersion(),
    instanceId: instanceIdReader(db),
    watchFolder: new WatchFolderService(db, {
      checks: settingsChecks,
      ...(opts.now ? { now: opts.now } : {}),
    }),
    readingChecks: new ReadingCheckService(db, keys, enqueue),
    mailIn: new MailInService(db, {
      mail: config.FDV_SMTP_URL ? (opts.mail ?? operatorMail) : null,
      codeKey: deriveKey(TEST_MASTER, MAIL_IN_CODE_KEY_PURPOSE),
      mailboxKey: deriveKey(TEST_MASTER, MAILBOX_PASSWORD_PURPOSE),
      checks: settingsChecks,
      ...(opts.now ? { now: opts.now } : {}),
    }),
    settingsChecks,
    sms,
    phones: new MemberPhoneService(db, sms, {
      codeKey: deriveKey(TEST_MASTER, PHONE_CODE_KEY_PURPOSE),
    }),
    textCodes,
    localAi: new LocalAiService(db, settingsChecks, aiReader),
    aiReader,
    backupOffsite: new BackupOffsiteService(db, {
      key: deriveKey(TEST_MASTER, BACKUP_OFFSITE_KEY_PURPOSE),
      edition: config.FDV_EDITION,
      ...(opts.offsiteTest ? { test: opts.offsiteTest } : {}),
      alert,
    }),
    securityHealth: new SecurityHealthService(db, {
      edition: config.FDV_EDITION,
      ...(opts.healthNow ? { now: opts.healthNow } : {}),
    }),
    pingDatabase: async () => undefined,
    auth,
    totp,
    passkeys,
    stepUp: stepUp,
    passwords,
    visibility: new VisibilityService(db, keys, enqueue),
    vaults,
    documents,
    // Several documents as one ZIP (0.9.0, DL).
    zips: new ZipService(db, keys, vaults, documents),
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
      copyKey: deriveKey(TEST_MASTER, SHARE_LINK_COPY_PURPOSE),
      sms,
      baseUrl: config.FDV_BASE_URL,
    }),
    uploads: new UploadRequestService(db, keys, vaults, {
      maxDays: config.FDV_SHARE_MAX_DAYS,
      maxFileBytes: 5 * 1024 * 1024,
      publicUrl: opts.publicUrl ?? null,
      codeKey: deriveKey(TEST_MASTER, UPLOAD_CODE_KEY_PURPOSE),
      mail: config.FDV_SMTP_URL ? (opts.mail ?? operatorMail) : null,
      deviceKey: deviceCookieKey(TEST_MASTER, UPLOAD_DEVICE_KEY_PURPOSE),
      copyKey: deriveKey(TEST_MASTER, UPLOAD_REQUEST_COPY_PURPOSE),
      baseUrl: config.FDV_BASE_URL,
      sms,
      enqueue,
      alert,
      ...(opts.incomingMaxBytes ? { householdMaxBytes: opts.incomingMaxBytes } : {}),
    }),
    incoming: new IncomingService(db, keys, vaults, documents, {
      enqueue,
      ...(opts.incomingBeforeCommit ? { beforeCommit: opts.incomingBeforeCommit } : {}),
    }),
    batches,
    devices: new DeviceService(db, batches, {
      hmacKey: deriveKey(TEST_MASTER, DEVICE_KEY_PURPOSE),
      baseUrl: config.FDV_BASE_URL,
      downloadUrl: opts.desktopDownloadUrl ?? null,
      maxUploadBytes: 5 * 1024 * 1024,
      dailyBytes: opts.deviceDailyBytes ?? config.FDV_DEVICE_DAILY_BYTES,
      alert,
    }),
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
    guard,
    adminUrl: tdb.adminUrl,
    appUrl: tdb.appUrl,
    vaultDir,
    jobs,
    dns,
    batches,
    apps,
    texts,
    async close() {
      await guard.settled();
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
          setup_token: TEST_SETUP_TOKEN,
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
