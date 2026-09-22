import { readFile } from 'node:fs/promises';
import { deriveKey, EnvKeyProvider, ScopeKeys } from '@fdv/crypto';
import { createDb, createPool, migrateUp } from '@fdv/db';
import { AuthService } from './auth/service.js';
import { deriveSigningKey } from './auth/tokens.js';
import { buildApp } from './app.js';
import { loadConfig, type ApiConfig } from './config.js';
import { PgBoss } from 'pg-boss';
import { DocumentService } from './documents/service.js';
import { HouseholdService } from './household/service.js';
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
  const app = await buildApp(config, {
    serverVersion: version,
    pingDatabase: async () => {
      await pool.query('select 1');
    },
    auth: new AuthService(db, deriveSigningKey(masterSecret), keys, (trx, householdId) =>
      vaults.createDefaultLocal(trx, householdId),
    ),
    vaults,
    documents: new DocumentService(db, keys, vaults, config.FDV_MAX_UPLOAD_BYTES, enqueue),
    household: new HouseholdService(db, keys),
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
