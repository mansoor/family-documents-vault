import { readFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { DecryptStream, deriveKey, EnvKeyProvider, ScopeKeys } from '@fdv/crypto';
import { createPool } from '@fdv/db';
import { loadConfig } from './config.js';
import { backupDatabase } from './jobs/backup.js';
import { recheckRemovedFiles } from './jobs/removed-files.js';
import {
  backupBefore,
  newestBackup,
  restoreBackup,
  RestoreIncomplete,
  RestoreRefused,
  restoreDrill,
} from './jobs/restore.js';
import { backupKeyFor } from './jobs/restore-keys.js';
import { restoreSummary } from './restore-summary.js';

/**
 * Operator commands, run inside the worker container:
 *
 *   node apps/worker/dist/cli.mjs backup-now
 *   node apps/worker/dist/cli.mjs restore-drill [<file.sql.enc>]
 *   node apps/worker/dist/cli.mjs restore-backup <file.sql.enc | latest>
 *   node apps/worker/dist/cli.mjs decrypt-backup <in.sql.enc> <out.sql>
 *   node apps/worker/dist/cli.mjs recheck-files
 *
 * All of them need only the normal configuration (the master key and the
 * database). The README's "Restoring" section says when to use which. A
 * backup made before the master key was rotated is restored, or drilled,
 * with FDV_MASTER_KEY_PREVIOUS set to the key it was made with: what it
 * holds is then moved onto the current key (restore-keys.ts).
 */
async function main() {
  const [command, a, b] = process.argv.slice(2);
  const config = loadConfig();
  const masterSecret = config.FDV_MASTER_KEY_FILE
    ? (await readFile(config.FDV_MASTER_KEY_FILE, 'utf8')).trim()
    : (config.FDV_MASTER_KEY as string);
  const backupKey = deriveKey(masterSecret, 'database-backup');
  // What a restore seals a backup's Only me notes and details with (0.5.8).
  const keys = new ScopeKeys(new EnvKeyProvider(masterSecret));
  const log = (level: string, msg: string, extra?: Record<string, unknown>) =>
    console.log(JSON.stringify({ level, msg, ...extra }));
  const adminUrl = config.DATABASE_ADMIN_URL ?? config.DATABASE_URL;
  const master = {
    current: masterSecret,
    previous: process.env.FDV_MASTER_KEY_PREVIOUS || undefined,
  };
  const backupNow = async () =>
    (
      await backupDatabase({
        adminUrl,
        backupKey,
        dir: config.FDV_BACKUP_DIR,
        retainDays: config.FDV_BACKUP_RETAIN_DAYS,
        log,
        masterSecret,
      })
    ).file;

  if (command === 'backup-now') {
    console.log(await backupNow());
    return;
  }

  if (command === 'restore-drill') {
    let file = a ?? (await newestBackup(config.FDV_BACKUP_DIR));
    if (!file) {
      console.log(`no backup found in ${config.FDV_BACKUP_DIR}; making one`);
      file = await backupNow();
    }
    console.log(`restoring ${file} into a scratch database`);
    try {
      const report = await restoreDrill({
        file,
        backupKey,
        keys,
        adminUrl,
        appUrl: config.DATABASE_URL,
        log,
        master,
      });
      console.log(
        `restored: households=${report.households} people=${report.members} ` +
          `documents=${report.documents} versions=${report.versions} schema=${report.schema}`,
      );
      if (report.households < 1) {
        console.error('restore drill FAILED: the backup has no household in it');
        process.exitCode = 1;
        return;
      }
      console.log('restore drill OK: the vault would read it as it reads itself');
    } catch (err) {
      console.error(`restore drill FAILED: ${(err as Error).message}`);
      const hint = previousKeyHint(
        err,
        master.previous,
        `docker compose exec -e FDV_MASTER_KEY_PREVIOUS=<the old key> worker sh scripts/restore-drill.sh ${file}`,
      );
      if (hint) console.error(hint);
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'restore-backup' && a) {
    if (!config.DATABASE_ADMIN_URL) {
      console.error('DATABASE_ADMIN_URL is needed to restore; it is set in docker-compose.yml');
      process.exitCode = 2;
      return;
    }
    const file = a === 'latest' ? await newestBackup(config.FDV_BACKUP_DIR) : a;
    if (!file) {
      console.error(`no backup found in ${config.FDV_BACKUP_DIR}`);
      process.exitCode = 2;
      return;
    }
    try {
      const report = await restoreBackup(
        file,
        backupKey,
        { adminUrl: config.DATABASE_ADMIN_URL, appUrl: config.DATABASE_URL, master },
        log,
        keys,
        // Where the files are, to look for each version's (5.24).
        {
          credentialsKey: deriveKey(masterSecret, 'vault-credentials'),
          localRoot: config.FDV_LOCAL_VAULT_DIR,
        },
      );
      console.log(restoreSummary(file, report));
    } catch (err) {
      if (err instanceof RestoreRefused) {
        console.error(`${err.message}\n\n${RESET}`);
        process.exitCode = 3;
        return;
      }
      if (err instanceof RestoreIncomplete) {
        console.error(
          `The backup was loaded, but the check that follows failed: ${err.message}\n` +
            `Do not start the vault on this database. Clear it and try again:\n\n${RESET}`,
        );
        process.exitCode = 1;
        return;
      }
      console.error(`Nothing was restored; the database is as it was. ${(err as Error).message}`);
      const hint = previousKeyHint(
        err,
        master.previous,
        'docker compose run --rm --no-deps -e FDV_MASTER_KEY_PREVIOUS=<the old key> worker ' +
          `node apps/worker/dist/cli.mjs restore-backup ${a}`,
      );
      if (hint) console.error(hint);
      const older = a === 'latest' ? await backupBefore(file, config.FDV_BACKUP_DIR) : null;
      if (older) {
        // With the old key again, if it was given: the one before is as likely to need it.
        const withPrevious = master.previous ? '-e FDV_MASTER_KEY_PREVIOUS=<the old key> ' : '';
        console.error(
          `\nIf this backup is damaged, restore the one before it:\n\n` +
            `  docker compose run --rm --no-deps ${withPrevious}worker node apps/worker/dist/cli.mjs restore-backup ${older}`,
        );
      }
      process.exitCode = 1;
    }
    return;
  }

  // A file a restore marked removed for good, put back since (5.24): looked
  // for again, and unmarked where it is found.
  if (command === 'recheck-files') {
    const admin = createPool(adminUrl, 1);
    try {
      const r = await recheckRemovedFiles(
        admin,
        {
          credentialsKey: deriveKey(masterSecret, 'vault-credentials'),
          localRoot: config.FDV_LOCAL_VAULT_DIR,
        },
        log,
      );
      console.log(
        `${r.found} file(s) marked removed for good were found again and open as before; ` +
          `${r.stillRemoved} still are not there.`,
      );
      if (r.unchecked) {
        console.log(`${r.unchecked} could not be looked for:`);
        for (const why of r.uncheckedWhy) console.log(`  ${why}`);
      }
    } finally {
      await admin.end();
    }
    return;
  }

  if (command === 'decrypt-backup' && a && b) {
    const key = await backupKeyFor(a, backupKey, master.previous);
    await pipeline(createReadStream(a), new DecryptStream(key), createWriteStream(b));
    console.log(`wrote ${b}`);
    if (key !== backupKey) {
      console.error(
        'This backup was made before the master key was rotated: it opened with\n' +
          'FDV_MASTER_KEY_PREVIOUS, and what is in it is under that key too. A database loaded\n' +
          'from it by hand would not open with the current key. Restore it with restore-backup\n' +
          'and FDV_MASTER_KEY_PREVIOUS instead, which moves it onto the current key.',
      );
    }
    return;
  }
  console.error(
    'usage: cli.mjs backup-now | restore-drill [<file>] | restore-backup <file|latest> | ' +
      'decrypt-backup <in.sql.enc> <out.sql> | recheck-files',
  );
  process.exitCode = 2;
}

/**
 * A backup that did not open with this vault's key may have been made
 * before a rotation: how to give the key it was made with, if it was not.
 */
function previousKeyHint(err: unknown, previous: string | undefined, command: string) {
  if (previous || !/failed authentication/.test((err as Error).message)) return null;
  return (
    '\nIf the backup was made before the master key was rotated, give the key it was\n' +
    `made with, beside the current one:\n\n  ${command}`
  );
}

/** The empty database a restore needs, reached without touching the files. */
const RESET = `If the vault started on a new, empty database before you restored, clear it
and try again. This removes the database only; your files and your backups
are in the other volume and are not touched:

  docker compose down
  docker volume rm fdv_db-data
  docker compose up -d --wait postgres

(With the same -f files you always use, such as docker-compose.tls.yml.)
Never use "docker compose down -v": that deletes the files and the backups too.`;

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
