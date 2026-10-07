import { readFile } from 'node:fs/promises';
import {
  ALERT_LINK_KEY_PURPOSE,
  deriveKey,
  EnvKeyProvider,
  OPERATOR_MAIL_KEY_PURPOSE,
  ScopeKeys,
} from '@fdv/crypto';
import { assertSchemaKnown, createDb, createPool, migrateUp } from '@fdv/db';
import { AuthService } from './auth/service.js';
import { TotpService } from './auth/totp.js';
import { deriveSigningKey } from './auth/tokens.js';
import { buildApp } from './app.js';
import { loadConfig, type ApiConfig } from './config.js';
import { PgBoss } from 'pg-boss';
import { proposalPool } from './documents/proposal-pool.js';
import { DocumentService, type Enqueue } from './documents/service.js';
import { stopApi } from './shutdown.js';
import { VisibilityService } from './documents/visibility.js';
import { TypeService } from './documents/types.js';
import { CollectionService } from './collections/service.js';
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
import { AuditService } from './audit/service.js';
import { OfflineService } from './offline/service.js';
import { VaultService } from './vaults/service.js';
import { alertJob, type AlertRequest } from './alert-job.js';
import { pushJob, type PushRequest } from './push-job.js';
import { instanceIdReader } from './instance.js';
import { serverVersion } from './version.js';
import { masterKeyOpensVault } from './master-key-check.js';

/** The one secret behind the installation: from the variable, or a file. */
async function resolveMasterSecret(config: ApiConfig): Promise<string> {
  if (config.FDV_MASTER_KEY_FILE)
    return (await readFile(config.FDV_MASTER_KEY_FILE, 'utf8')).trim();
  return config.FDV_MASTER_KEY as string;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const version = await serverVersion();
  const masterSecret = await resolveMasterSecret(config);

  if (config.FDV_RUN_MIGRATIONS === 'true') {
    const adminUrl = config.DATABASE_ADMIN_URL ?? config.DATABASE_URL;
    const admin = createPool(adminUrl, 1);
    try {
      const applied = await migrateUp(admin, undefined, (m) => console.log(`[migrate] ${m}`));
      console.log(`[migrate] ${applied.length ? `${applied.length} applied` : 'up to date'}`);
    } finally {
      await admin.end();
    }
    // The job queue's own schema is installed here too, with the owning
    // role, so a fresh install does not wait on the worker (which waits on
    // the API) to create it. The worker upgrades it later if needed.
    const installer = new PgBoss({
      connectionString: adminUrl,
      schema: 'pgboss',
      migrate: true,
      supervise: false,
      schedule: false,
    });
    await installer.start();
    await installer.stop({ graceful: false });
    console.log('[migrate] job queue schema ready');
  }
  if (
    !(await masterKeyOpensVault(config.DATABASE_ADMIN_URL ?? config.DATABASE_URL, masterSecret))
  ) {
    process.exitCode = 1;
    return;
  }

  const pool = createPool(config.DATABASE_URL);
  // A database a newer release has upgraded is refused, not half-served
  // (migrateUp above refuses it too, when this replica migrates).
  await assertSchemaKnown(pool);
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
  // The API only enqueues; the worker installs the schema and supervises.
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

  // Passkeys are bound to the address the vault is published at, so this
  // is where FDV_BASE_URL stops being cosmetic.
  const auth = new AuthService(
    db,
    deriveSigningKey(masterSecret),
    keys,
    (trx, householdId) => vaults.createDefaultLocal(trx, householdId),
    alert,
    totp,
    push,
  );
  const passkeys = new PasskeyService(
    db,
    auth,
    passkeyConfig(config.FDV_BASE_URL, config.FDV_DISPLAY_NAME, config.FDV_RP_ID),
  );

  const stepUpService = new StepUpService(db, passkeys, totp);
  const passwords = new PasswordService(
    db,
    keys,
    stepUpService,
    config.FDV_BASE_URL,
    alert,
    Boolean(config.FDV_SMTP_URL),
    push,
    enqueue,
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
  const collections = new CollectionService(db, documents);
  const app = await buildApp(config, {
    serverVersion: version,
    instanceId: instanceIdReader(db),
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
    invitations: new InvitationService(db, keys, auth),
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
    }),
    uploads: new UploadRequestService(db, keys, vaults, {
      maxDays: config.FDV_SHARE_MAX_DAYS,
      maxFileBytes: config.FDV_MAX_UPLOAD_BYTES,
      publicUrl: config.FDV_PUBLIC_URL ?? null,
      // 5.20's code by the operator's mail server alone, and its device cookies.
      codeKey: deriveKey(masterSecret, UPLOAD_CODE_KEY_PURPOSE),
      mail: config.FDV_SMTP_URL ? operatorMail : null,
      deviceKey: deviceCookieKey(masterSecret, UPLOAD_DEVICE_KEY_PURPOSE),
      enqueue,
      alert,
    }),
    incoming: new IncomingService(db, keys, vaults, documents, { enqueue }),
    batches: new BatchService(
      db,
      keys,
      vaults,
      documents,
      collections,
      config.FDV_MAX_UPLOAD_BYTES,
      enqueue,
    ),
    audit: new AuditService(db),
    suggestions: new SuggestionService(db),
    stepUp: stepUpService,
    passwords,
    sealedSearch: new SealedSearchService(db, keys, deriveSealedKey(masterSecret)),
  });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await stopApi({ proposals: proposalPool, app, boss, db });
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.HOST, port: config.PORT });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
