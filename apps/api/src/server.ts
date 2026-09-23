import { readFile } from 'node:fs/promises';
import { deriveKey, EnvKeyProvider, ScopeKeys } from '@fdv/crypto';
import { createDb, createPool, migrateUp } from '@fdv/db';
import { AuthService } from './auth/service.js';
import { TotpService } from './auth/totp.js';
import { deriveSigningKey } from './auth/tokens.js';
import { buildApp } from './app.js';
import { loadConfig, type ApiConfig } from './config.js';
import { PgBoss } from 'pg-boss';
import { DocumentService } from './documents/service.js';
import { VisibilityService } from './documents/visibility.js';
import { ExportService } from './exports/service.js';
import { NotificationService } from './notifications/service.js';
import { ReminderService } from './reminders/service.js';
import { SealedSearchService } from './documents/sealed-search.js';
import { deriveSealedKey } from './documents/sealed-token.js';
import { PasskeyService, passkeyConfig } from './auth/passkeys.js';
import { StepUpService } from './auth/step-up.js';
import { SuggestionService } from './suggestions/service.js';
import { HouseholdService } from './household/service.js';
import { InvitationService } from './household/invitations.js';
import { CoOwnerService } from './household/co-owners.js';
import { VaultService } from './vaults/service.js';

async function readVersion(): Promise<string> {
  const url = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(await readFile(url, 'utf8')) as { version: string };
  return pkg.version;
}

/** The one secret behind the installation: from the variable, or a file. */
async function resolveMasterSecret(config: ApiConfig): Promise<string> {
  if (config.FDV_MASTER_KEY_FILE)
    return (await readFile(config.FDV_MASTER_KEY_FILE, 'utf8')).trim();
  return config.FDV_MASTER_KEY as string;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const version = await readVersion();
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

  const pool = createPool(config.DATABASE_URL);
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
  const enqueue = async (name: string, data: Record<string, unknown>) => {
    await boss.send(name, data);
  };
  /**
   * An alert goes on the queue rather than out of the API: the worker owns
   * push and the household's mail server, and a sign-in must not wait for
   * an SMTP handshake. The job name matches `JOBS.alertSend` in the worker.
   */
  const alert = (a: { householdId: string; accountIds: string[]; subject: string; body: string }) =>
    enqueue('alert.send', {
      household_id: a.householdId,
      account_ids: a.accountIds,
      subject: a.subject,
      body: a.body,
    });

  // Passkeys are bound to the address the vault is published at, so this
  // is where FDV_BASE_URL stops being cosmetic.
  const auth = new AuthService(
    db,
    deriveSigningKey(masterSecret),
    keys,
    (trx, householdId) => vaults.createDefaultLocal(trx, householdId),
    alert,
    totp,
  );
  const passkeys = new PasskeyService(
    db,
    auth,
    passkeyConfig(config.FDV_BASE_URL, config.FDV_DISPLAY_NAME, config.FDV_RP_ID),
  );

  const app = await buildApp(config, {
    serverVersion: version,
    pingDatabase: async () => {
      await pool.query('select 1');
    },
    auth,
    totp,
    passkeys,
    visibility: new VisibilityService(db, keys),
    exports: new ExportService(db, keys, vaults, enqueue),
    vaults,
    documents: new DocumentService(
      db,
      keys,
      vaults,
      config.FDV_MAX_UPLOAD_BYTES,
      enqueue,
      reminders,
      deriveSealedKey(masterSecret),
    ),
    reminders,
    notifications: new NotificationService(
      db,
      deriveKey(masterSecret, 'smtp-credentials'),
      config.FDV_VAPID_PUBLIC_KEY ?? null,
    ),
    household: new HouseholdService(db, keys),
    invitations: new InvitationService(db, keys, auth),
    coOwners: new CoOwnerService(db, alert),
    suggestions: new SuggestionService(db),
    stepUp: new StepUpService(db, passkeys, totp),
    sealedSearch: new SealedSearchService(db, keys, deriveSealedKey(masterSecret)),
  });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await boss.stop({ graceful: false });
    await db.destroy();
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
