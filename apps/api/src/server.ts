import { readFile } from 'node:fs/promises';
import { createDb, createPool, migrateUp } from '@fdv/db';
import { AuthService } from './auth/service.js';
import { deriveSigningKey } from './auth/tokens.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

async function readVersion(): Promise<string> {
  const url = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(await readFile(url, 'utf8')) as { version: string };
  return pkg.version;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const version = await readVersion();

  if (config.FDV_RUN_MIGRATIONS === 'true') {
    const admin = createPool(config.DATABASE_ADMIN_URL ?? config.DATABASE_URL, 1);
    try {
      const applied = await migrateUp(admin, undefined, (m) => console.log(`[migrate] ${m}`));
      console.log(`[migrate] ${applied.length ? `${applied.length} applied` : 'up to date'}`);
    } finally {
      await admin.end();
    }
  }

  const pool = createPool(config.DATABASE_URL);
  const db = createDb(pool);
  const app = await buildApp(config, {
    serverVersion: version,
    pingDatabase: async () => {
      await pool.query('select 1');
    },
    auth: new AuthService(db, deriveSigningKey(config.FDV_MASTER_KEY)),
  });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
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
