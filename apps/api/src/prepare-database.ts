import { databasePasswordProblem, masterSecretProblem, readMasterSecret } from '@fdv/crypto';
import { createPool, migrateUp } from '@fdv/db';
import { PgBoss } from 'pg-boss';
import type { ApiConfig } from './config.js';
import { masterKeyOpensVault } from './master-key-check.js';

/**
 * What the database needs before the API serves on it, done as the owning
 * role: every pending migration, the application role's privileges (applied
 * each time by migrateUp, so a restored database is put right), and the job
 * queue's own schema, so a fresh install does not wait on the worker to
 * create it (the worker upgrades it later if need be).
 */
export async function prepareDatabase(
  adminUrl: string,
  log: (message: string) => void = (m) => console.log(`[migrate] ${m}`),
): Promise<void> {
  const admin = createPool(adminUrl, 1);
  try {
    const applied = await migrateUp(admin, undefined, log);
    log(applied.length ? `${applied.length} applied` : 'up to date');
  } finally {
    await admin.end();
  }
  const installer = new PgBoss({
    connectionString: adminUrl,
    schema: 'pgboss',
    migrate: true,
    supervise: false,
    schedule: false,
  });
  await installer.start();
  await installer.stop({ graceful: false });
  log('job queue schema ready');
}

/**
 * `cli.mjs migrate`: the compose file's one-shot `migrate` service, which
 * runs before the API and the worker start and then exits, so the API that
 * stays up never holds the owning role's password. It refuses, as the API's
 * own start does, the example file's secrets and a master key that does not
 * open the vault: the API and the worker wait for it to succeed, so neither
 * starts on the wrong key. 0 when the database is ready; 1, having said why.
 */
export async function migrateCommand(config: ApiConfig): Promise<number> {
  const adminUrl = config.DATABASE_ADMIN_URL;
  if (!adminUrl) {
    console.error(
      '[migrate] DATABASE_ADMIN_URL is needed: migrations run as the role that owns the tables ' +
        '(docker-compose.yml gives it to the migrate service).',
    );
    return 1;
  }
  let masterSecret: string;
  try {
    masterSecret = await readMasterSecret(config);
  } catch (err) {
    console.error(`[migrate] ${(err as Error).message}`);
    return 1;
  }
  const weak =
    masterSecretProblem(masterSecret) ??
    databasePasswordProblem(config.DATABASE_URL, 'DATABASE_URL') ??
    databasePasswordProblem(adminUrl, 'DATABASE_ADMIN_URL');
  if (weak) {
    console.error(`[migrate] ${weak}`);
    return 1;
  }
  await prepareDatabase(adminUrl);
  if (!(await masterKeyOpensVault(adminUrl, masterSecret))) return 1;
  console.log('[migrate] the master key opens the vault; done');
  return 0;
}
