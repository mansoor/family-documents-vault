import {
  ALERT_LINK_KEY_PURPOSE,
  deriveKey,
  EnvKeyProvider,
  MAILBOX_PASSWORD_PURPOSE,
  OPERATOR_MAIL_KEY_PURPOSE,
  ScopeKeys,
  SMS_PASSWORD_PURPOSE,
  AI_READER_KEY_PURPOSE,
  BACKUP_OFFSITE_KEY_PURPOSE,
  SHARE_LINK_COPY_PURPOSE,
  UPLOAD_REQUEST_COPY_PURPOSE,
  databasePasswordProblem,
  masterSecretProblem,
  readMasterSecret,
} from '@fdv/crypto';
import {
  assertSchemaCurrent,
  assertSchemaKnown,
  createDb,
  createPool,
  rowSecurityProblem,
} from '@fdv/db';
import { AuthService } from './auth/service.js';
import { SetupToken } from './auth/setup-token.js';
import { TotpService } from './auth/totp.js';
import { deriveSigningKey } from './auth/tokens.js';
import { SignInGuard } from './auth/sign-in-guard.js';
import { buildApp } from './app.js';
import { loadConfig, runsMigrations } from './config.js';
import { PgBoss } from 'pg-boss';
import { proposalPool } from './documents/proposal-pool.js';
import { DocumentService, type Enqueue } from './documents/service.js';
import { stopApi } from './shutdown.js';
import { VisibilityService } from './documents/visibility.js';
import { TypeService } from './documents/types.js';
import { CollectionService } from './collections/service.js';
import { CabinetService } from './cabinet/service.js';
import { CaregiverService } from './caregivers/service.js';
import { EmergencyService } from './emergency/service.js';
import { ExportService } from './exports/service.js';
import { NotificationService } from './notifications/service.js';
import { ReminderService } from './reminders/service.js';
import { SealedSearchService } from './documents/sealed-search.js';
import { deriveSealedKey } from './documents/sealed-token.js';
import { deriveCursorKey } from './documents/table.js';
import { PasskeyService, passkeyConfig } from './auth/passkeys.js';
import { StepUpService } from './auth/step-up.js';
import { PasswordService } from './auth/passwords.js';
import { SuggestionService } from './suggestions/service.js';
import { HouseholdService } from './household/service.js';
import { IdentityService } from './household/identity.js';
import { LockService } from './household/locks.js';
import { RestrictionService } from './household/restrictions.js';
import { GuestService } from './household/guests.js';
import { OwnerResetService } from './household/owner-resets.js';
import { PhotoService } from './household/photos.js';
import { InvitationService } from './household/invitations.js';
import { CoOwnerService } from './household/co-owners.js';
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
import { IncomingService } from './uploads/incoming.js';
import { BatchService } from './uploads/batches.js';
import { DEVICE_KEY_PURPOSE, DeviceService } from './devices/service.js';
import { AppService } from './apps/service.js';
import { consumeFileReady } from './apps/auto-file.js';
import { AuditService } from './audit/service.js';
import { OfflineService } from './offline/service.js';
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
import { PHONE_CODE_KEY_PURPOSE, MemberPhoneService } from './sms/phones.js';
import { SmsService } from './sms/service.js';
import { SMS_CODE_KEY_PURPOSE, TextCodeService } from './sms/codes.js';
import { serverVersion } from './version.js';
import { masterKeyMatchesCanary, masterKeyOpensVault } from './master-key-check.js';
import { prepareDatabase } from './prepare-database.js';
import { plainHttpWarning } from './plain-http.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const version = await serverVersion();
  // The variable, or a file (a Docker secret); both only if they agree.
  let masterSecret: string;
  try {
    masterSecret = await readMasterSecret(config);
  } catch (err) {
    console.error(`[start] ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  // Never on the example file's secrets, nor a master key anybody could
  // guess: before anything is migrated, sealed or signed with them.
  const weak =
    masterSecretProblem(masterSecret) ??
    databasePasswordProblem(config.DATABASE_URL, 'DATABASE_URL') ??
    (config.DATABASE_ADMIN_URL
      ? databasePasswordProblem(config.DATABASE_ADMIN_URL, 'DATABASE_ADMIN_URL')
      : null);
  if (weak) {
    console.error(`[start] ${weak}`);
    process.exitCode = 1;
    return;
  }

  // In the compose setup the one-shot `migrate` service has migrated the
  // database and checked the master key before this starts, and the API is
  // not given the owning role's password at all: what stays running holds
  // only the application role's. Given DATABASE_ADMIN_URL (development, the
  // tests, a compose file of your own) it does both itself, as before.
  // Plain http to another machine: said once, plainly, and the vault starts
  // all the same (a LAN :8080 is how many houses reach it today).
  const clear = plainHttpWarning(config.FDV_BASE_URL);
  if (clear) console.warn(`[start] WARNING: ${clear}`);

  const migrates = runsMigrations(config);
  if (migrates) await prepareDatabase(config.DATABASE_ADMIN_URL ?? config.DATABASE_URL);
  if (config.DATABASE_ADMIN_URL) {
    if (!(await masterKeyOpensVault(config.DATABASE_ADMIN_URL, masterSecret))) {
      process.exitCode = 1;
      return;
    }
  }

  const pool = createPool(config.DATABASE_URL);
  // A database a newer release has upgraded is refused, not half-served
  // (migrateUp above refuses it too, when this process migrates); and, when
  // migrating is left to the migrate service, one with migrations of this
  // release still to run.
  try {
    await (migrates ? assertSchemaKnown(pool) : assertSchemaCurrent(pool));
  } catch (err) {
    console.error(`[start] ${(err as Error).message}`);
    await pool.end();
    process.exitCode = 1;
    return;
  }
  // Without the owning role the key is compared with the one the migrate
  // service last opened the vault with (master_key_canary).
  if (
    !config.DATABASE_ADMIN_URL &&
    !(await masterKeyMatchesCanary(config.DATABASE_URL, masterSecret))
  ) {
    await pool.end();
    process.exitCode = 1;
    return;
  }
  // Every household boundary is a row-level security policy: the role the
  // family is served with must be held by them, or nothing starts.
  const rls = await rowSecurityProblem(pool);
  if (rls) {
    console.error(`[start] ${rls}`);
    await pool.end();
    process.exitCode = 1;
    return;
  }
  const db = createDb(pool);
  const vaults = new VaultService(
    db,
    deriveKey(masterSecret, 'vault-credentials'),
    config.FDV_LOCAL_VAULT_DIR,
  );
  const keys = new ScopeKeys(new EnvKeyProvider(masterSecret));
  const reminders = new ReminderService(db);
  const totp = new TotpService(
    db,
    deriveKey(masterSecret, 'totp-secrets'),
    deriveSigningKey(masterSecret),
  );
  // The API enqueues, and consumes one queue: apps.file_ready (0.9.0,
  // APP4), an item a connected app sent filed automatically once the
  // worker has read it — filing is the API's code, and is never written
  // twice. The worker installs the schema, makes the queues and supervises
  // (expired jobs retried, schedules); this connection does neither.
  const boss = new PgBoss({
    connectionString: config.DATABASE_URL,
    schema: 'pgboss',
    migrate: false,
    supervise: false,
    schedule: false,
  });
  boss.on('error', (err) => console.error('[queue]', err));
  await boss.start();
  const enqueue: Enqueue = async (name, data, options) => {
    await boss.send(name, data, options ?? {});
  };
  /**
   * An alert goes on the queue rather than out of the API: the worker owns
   * push and the household's mail server, and a sign-in must not wait for
   * an SMTP handshake. The job name matches `JOBS.alertSend` in the worker.
   * Its link, a password reset's, is sealed on the queue (F529-11).
   */
  const alertKey = deriveKey(masterSecret, ALERT_LINK_KEY_PURPOSE);
  const alert = (a: AlertRequest) => enqueue('alert.send', alertJob(alertKey, a));
  // What the worker pushes (4.13): the same mapping here and in tests, as alerts.
  const push = (r: PushRequest) => enqueue('push.send', pushJob(r));
  // An email to one address, through the operator's mail server (5.20):
  // sealed on the queue, the same mapping here and in tests.
  const mailKey = deriveKey(masterSecret, OPERATOR_MAIL_KEY_PURPOSE);
  const operatorMail = (m: MailRequest) => enqueue(MAIL_JOB, mailJob(mailKey, m));

  // Text messages (0.9.0, SMS1): SMS Gate's password sealed as it is saved,
  // and the codes that confirm a number HMACed under a key of their own.
  const sms = new SmsService(db, { key: deriveKey(masterSecret, SMS_PASSWORD_PURPOSE), alert });
  // Codes by text to one's own number (SMS3), HMACed under a key of their own.
  const textCodes = new TextCodeService(db, sms, {
    codeKey: deriveKey(masterSecret, SMS_CODE_KEY_PURPOSE),
    alert,
  });

  // Passkeys are bound to the address the vault is published at, so this
  // is where FDV_BASE_URL stops being cosmetic.
  // Failed sign-ins counted per account (0.9.0): a wait after five in a
  // row, a line in the person's Activity, an alert.
  const guard = new SignInGuard(db, deriveSigningKey(masterSecret), alert);
  const auth = new AuthService(
    db,
    deriveSigningKey(masterSecret),
    keys,
    (trx, householdId) => vaults.createDefaultLocal(trx, householdId),
    alert,
    totp,
    push,
    textCodes,
    { guard },
  );
  const passkeys = new PasskeyService(
    db,
    auth,
    passkeyConfig(config.FDV_BASE_URL, config.FDV_DISPLAY_NAME, config.FDV_RP_ID),
  );
  // First-run setup takes a code (0.9.0): FDV_SETUP_TOKEN from .env, or,
  // with none, one made now and written to the log once — a new one each
  // time the API starts, until the vault is set up. Only its hash is kept.
  if (config.FDV_SETUP_TOKEN) {
    auth.useSetupToken(new SetupToken(config.FDV_SETUP_TOKEN));
    if (!(await auth.setupComplete())) {
      console.log(
        '[setup] This vault is not set up yet. Open it in a browser; the setup code it asks for is FDV_SETUP_TOKEN in your .env.',
      );
    }
  } else if (!(await auth.setupComplete())) {
    const made = SetupToken.generate();
    auth.useSetupToken(made.gate);
    console.log(
      `[setup] This vault is not set up yet. Open it in a browser and give this setup code: ${made.token} (a new one is made each time the API starts, until the vault is set up).`,
    );
  }

  const stepUpService = new StepUpService(db, passkeys, totp, textCodes, guard);
  const passwords = new PasswordService(
    db,
    keys,
    stepUpService,
    config.FDV_BASE_URL,
    alert,
    Boolean(config.FDV_SMTP_URL),
    push,
    enqueue,
    textCodes,
  );
  // 5.29: a reset an owner starts goes by the operator's mail server alone,
  // or is handed over only for somebody who keeps nothing private.
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
    config.FDV_MAX_UPLOAD_BYTES,
    enqueue,
    reminders,
    deriveSealedKey(masterSecret),
    deriveCursorKey(masterSecret),
  );
  const collections = new CollectionService(db, documents, undefined, alert);
  const batches = new BatchService(
    db,
    keys,
    vaults,
    documents,
    collections,
    config.FDV_MAX_UPLOAD_BYTES,
    enqueue,
  );
  // What an owner asks the worker from Settings (0.9.0, O1): Verify, browse, Test the mailbox.
  const settingsChecks = new SettingsCheckService(db, enqueue);
  // The AI reader set in Settings (0.9.0, AIR1): its key sealed here, opened
  // by the worker alone; .env's reader, as the workers said it, wins.
  const localAiState = new LocalAiService(db, settingsChecks);
  const aiReader = new AiReaderService(db, {
    key: deriveKey(masterSecret, AI_READER_KEY_PURPOSE),
    edition: config.FDV_EDITION,
    settings: config.FDV_AI_READER_SETTINGS,
    allowedPorts: config.FDV_AI_READER_ALLOWED_PORTS,
    checks: settingsChecks,
    server: () => localAiState.server(),
    alert,
  });
  // Connected apps (0.9.0, APP1): their routes signed, their files the batches'.
  const apps = new AppService(db, batches, {
    baseUrl: config.FDV_BASE_URL,
    publicUrl: config.FDV_PUBLIC_URL ?? null,
    appsPublic: config.FDV_PUBLIC_APPS === 'on',
    localHttp: config.FDV_APPS_LOCAL_HTTP === 'on',
    maxUploadBytes: config.FDV_MAX_UPLOAD_BYTES,
    ceilings: { files: config.FDV_APP_DAILY_FILES, bytes: config.FDV_APP_DAILY_BYTES },
    serverVersion: version,
    instanceId: instanceIdReader(db),
    alert,
    // What an app reads and downloads (APP2).
    documents,
  });
  const app = await buildApp(config, {
    cabinet: new CabinetService(db, documents),
    caregivers: new CaregiverService(db, new VisibilityService(db, keys, enqueue)),
    emergency: new EmergencyService(db, keys),
    serverVersion: version,
    instanceId: instanceIdReader(db),
    watchFolder: new WatchFolderService(db, { checks: settingsChecks }),
    readingChecks: new ReadingCheckService(db, keys, enqueue),
    mailIn: new MailInService(db, {
      // A code emailed to an address only through the operator's mail server (F1).
      mail: config.FDV_SMTP_URL ? operatorMail : null,
      codeKey: deriveKey(masterSecret, MAIL_IN_CODE_KEY_PURPOSE),
      // The household mailbox's app password, sealed as it is saved (O1).
      mailboxKey: deriveKey(masterSecret, MAILBOX_PASSWORD_PURPOSE),
      checks: settingsChecks,
    }),
    settingsChecks,
    sms,
    phones: new MemberPhoneService(db, sms, {
      codeKey: deriveKey(masterSecret, PHONE_CODE_KEY_PURPOSE),
    }),
    textCodes,
    // The local AI reader's switch (0.9.0, R4): the endpoint is the worker's alone.
    localAi: new LocalAiService(db, settingsChecks, aiReader),
    aiReader,
    // Settings → Backups (0.9.0-dev.76): the bucket the nightly backups are
    // copied to, its secret key sealed here; the worker copies to it.
    backupOffsite: new BackupOffsiteService(db, {
      key: deriveKey(masterSecret, BACKUP_OFFSITE_KEY_PURPOSE),
      edition: config.FDV_EDITION,
      lateDays: config.FDV_BACKUP_OFFSITE_LATE_DAYS,
      alert,
    }),
    pingDatabase: async () => {
      await pool.query('select 1');
    },
    auth,
    totp,
    passkeys,
    visibility: new VisibilityService(db, keys, enqueue),
    exports: new ExportService(db, keys, vaults, enqueue),
    vaults,
    documents,
    // Several documents as one ZIP (0.9.0, DL).
    zips: new ZipService(db, keys, vaults, documents),
    purge: new PurgeService(db, vaults, documents, alert, enqueue),
    types: new TypeService(db, enqueue, stepUpService),
    collections,
    offline: new OfflineService(db, documents, config.FDV_OFFLINE_MAX_DAYS),
    reminders,
    notifications: new NotificationService(
      db,
      deriveKey(masterSecret, 'smtp-credentials'),
      config.FDV_VAPID_PUBLIC_KEY ?? null,
      alert,
      { push, allowPrivateEndpoints: config.FDV_PUSH_ALLOW_PRIVATE_ENDPOINTS === 'true' },
    ),
    household: new HouseholdService(
      db,
      keys,
      stepUpService,
      config.FDV_OFFLINE_MAX_DAYS,
      (trx, target) => resets.pathFor(trx, target),
    ),
    photos: new PhotoService(db, keys, vaults, enqueue, config.FDV_MAX_UPLOAD_BYTES),
    // 5.26: a wider audience is told by the operator's mail server alone.
    identity: new IdentityService(db, keys, alert, Boolean(config.FDV_SMTP_URL), push),
    // SMS3: an owner may text an invitation's code as well.
    invitations: new InvitationService(db, keys, auth, sms),
    coOwners: new CoOwnerService(db, alert, push, enqueue),
    locks: new LockService(db, alert, push, enqueue),
    restrictions: new RestrictionService(db, alert),
    // 5.34: a guest's sign-in renewed by an owner (A28).
    guests: new GuestService(db),
    resets,
    shares: new ShareService(db, keys, vaults, alert, config.FDV_PUBLIC_URL ?? null, {
      enqueue,
      maxDays: config.FDV_SHARE_MAX_DAYS,
      // 5.20: a link's codes, HMACed under a key of their own, and sent only
      // through the operator's mail server — none at all without one (A21).
      codeKey: deriveKey(masterSecret, SHARE_CODE_KEY_PURPOSE),
      mail: config.FDV_SMTP_URL ? operatorMail : null,
      // "This device only" cookies: made, and checked, by the vault alone.
      deviceKey: deviceCookieKey(masterSecret, SHARE_DEVICE_KEY_PURPOSE),
      // 0.9.0: what a link's maker was handed, kept sealed to show them again.
      copyKey: deriveKey(masterSecret, SHARE_LINK_COPY_PURPOSE),
      // SMS3: a link's code by text, through the household's own SMS Gate.
      sms,
      // 0.9.0: an emailed link starts with the vault's own address when
      // there is no public-only site.
      baseUrl: config.FDV_BASE_URL,
    }),
    uploads: new UploadRequestService(db, keys, vaults, {
      maxDays: config.FDV_SHARE_MAX_DAYS,
      maxFileBytes: config.FDV_MAX_UPLOAD_BYTES,
      publicUrl: config.FDV_PUBLIC_URL ?? null,
      // 5.20's code by the operator's mail server alone, and its device cookies.
      codeKey: deriveKey(masterSecret, UPLOAD_CODE_KEY_PURPOSE),
      mail: config.FDV_SMTP_URL ? operatorMail : null,
      deviceKey: deviceCookieKey(masterSecret, UPLOAD_DEVICE_KEY_PURPOSE),
      // 0.9.0 (LK): a request's link kept sealed, to show whoever asked
      // again, and the vault's own address, to email it from.
      copyKey: deriveKey(masterSecret, UPLOAD_REQUEST_COPY_PURPOSE),
      baseUrl: config.FDV_BASE_URL,
      // 0.9.0-dev.69: a request's link texted, through the household's own SMS Gate.
      sms,
      enqueue,
      alert,
    }),
    incoming: new IncomingService(db, keys, vaults, documents, { enqueue }),
    batches,
    // 0.8.0 (D1): a computer paired to send scans, its code and key HMACed
    // under a key of their own.
    devices: new DeviceService(db, batches, {
      hmacKey: deriveKey(masterSecret, DEVICE_KEY_PURPOSE),
      baseUrl: config.FDV_BASE_URL,
      downloadUrl: config.FDV_DESKTOP_DOWNLOAD_URL ?? null,
      maxUploadBytes: config.FDV_MAX_UPLOAD_BYTES,
      dailyBytes: config.FDV_DEVICE_DAILY_BYTES,
      alert,
    }),
    apps,
    audit: new AuditService(db),
    suggestions: new SuggestionService(db),
    stepUp: stepUpService,
    passwords,
    sealedSearch: new SealedSearchService(db, keys, deriveSealedKey(masterSecret)),
  });

  // What a connected app sent, filed automatically (APP4): consumed once
  // the server listens, on every instance (each job is filed once, under
  // its item's lock), and stopped before the server closes.
  // A failed sign-in, and signing in made to wait, in the API's own log
  // (README, "Security events"): `"event":"sign_in_failed"`, `"event":"sign_in_throttled"`.
  guard.useLog((fields, message) => app.log.warn(fields, message));

  const consumers: Array<{ stop: () => Promise<void> }> = [];
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await guard.settled();
    await stopApi({ proposals: proposalPool, consumers, app, boss, db });
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.HOST, port: config.PORT });
  consumers.push(
    consumeFileReady(boss, apps.autoFile, (level, msg, extra) => app.log[level](extra ?? {}, msg)),
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
