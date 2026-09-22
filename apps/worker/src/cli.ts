import { readFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { DecryptStream, deriveKey } from '@fdv/crypto';
import { loadConfig } from './config.js';
import { backupDatabase } from './jobs/backup.js';

/**
 * Operator commands, run inside the worker container:
 *
 *   node apps/worker/dist/cli.mjs backup-now
 *   node apps/worker/dist/cli.mjs decrypt-backup <in.sql.enc> <out.sql>
 *
 * Both need only the normal configuration (the master key and database).
 */
async function main() {
  const [command, a, b] = process.argv.slice(2);
  const config = loadConfig();
  const masterSecret = config.FDV_MASTER_KEY_FILE
    ? (await readFile(config.FDV_MASTER_KEY_FILE, 'utf8')).trim()
    : (config.FDV_MASTER_KEY as string);
  const backupKey = deriveKey(masterSecret, 'database-backup');
  const log = (level: string, msg: string, extra?: Record<string, unknown>) =>
    console.log(JSON.stringify({ level, msg, ...extra }));

  if (command === 'backup-now') {
    const r = await backupDatabase({
      adminUrl: config.DATABASE_ADMIN_URL ?? config.DATABASE_URL,
      backupKey,
      dir: config.FDV_BACKUP_DIR,
      retainDays: config.FDV_BACKUP_RETAIN_DAYS,
      log,
    });
    console.log(r.file);
    return;
  }
  if (command === 'decrypt-backup' && a && b) {
    await pipeline(createReadStream(a), new DecryptStream(backupKey), createWriteStream(b));
    console.log(`wrote ${b}`);
    return;
  }
  console.error('usage: cli.mjs backup-now | decrypt-backup <in.sql.enc> <out.sql>');
  process.exitCode = 2;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
