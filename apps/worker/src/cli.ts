import { readFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DecryptStream, deriveKey } from '@fdv/crypto';
import { loadConfig } from './config.js';
import { backupDatabase } from './jobs/backup.js';
import {
  backupBefore,
  newestBackup,
  restoreBackup,
  RestoreIncomplete,
  RestoreRefused,
  restoreDrill,
  type RestoreReport,
} from './jobs/restore.js';

/**
 * Operator commands, run inside the worker container:
 *
 *   node apps/worker/dist/cli.mjs backup-now
 *   node apps/worker/dist/cli.mjs restore-drill [<file.sql.enc>]
 *   node apps/worker/dist/cli.mjs restore-backup <file.sql.enc | latest>
 *   node apps/worker/dist/cli.mjs decrypt-backup <in.sql.enc> <out.sql>
 *
 * All of them need only the normal configuration (the master key and the
 * database). The README's "Restoring" section says when to use which.
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
  const adminUrl = config.DATABASE_ADMIN_URL ?? config.DATABASE_URL;
  const backupNow = async () =>
    (
      await backupDatabase({
        adminUrl,
        backupKey,
        dir: config.FDV_BACKUP_DIR,
        retainDays: config.FDV_BACKUP_RETAIN_DAYS,
        log,
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
        adminUrl,
        appUrl: config.DATABASE_URL,
        log,
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
        { adminUrl: config.DATABASE_ADMIN_URL, appUrl: config.DATABASE_URL },
        log,
      );
      console.log(summary(file, report));
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
      const older = a === 'latest' ? await backupBefore(file, config.FDV_BACKUP_DIR) : null;
      if (older) {
        console.error(
          `\nIf this backup is damaged, restore the one before it:\n\n` +
            `  docker compose run --rm --no-deps worker node apps/worker/dist/cli.mjs restore-backup ${older}`,
        );
      }
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'decrypt-backup' && a && b) {
    await pipeline(createReadStream(a), new DecryptStream(backupKey), createWriteStream(b));
    console.log(`wrote ${b}`);
    return;
  }
  console.error(
    'usage: cli.mjs backup-now | restore-drill [<file>] | restore-backup <file|latest> | ' +
      'decrypt-backup <in.sql.enc> <out.sql>',
  );
  process.exitCode = 2;
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

function summary(file: string, r: RestoreReport): string {
  const made = madeAt(file);
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const lines = [
    `Restored ${path.basename(file)}${made ? `, made ${made}` : ''}:`,
    `  ${plural(r.households, 'household')}, ${plural(r.members, 'person', 'people')}, ` +
      `${plural(r.documents, 'document')} (${plural(r.versions, 'version')}); database schema ${r.schema}.`,
    '',
    'Everything since the backup was made is undone, so:',
    `  - Everybody has been signed out (${plural(r.sessionsEnded, 'session')}). Each person signs in`,
    '    with the password they had when the backup was made.',
    '  - Passkeys and two-step sign-in are as they were then too. Anybody who removed a',
    '    passkey or reset two-step sign-in since does it again, in Settings.',
  ];
  if (r.ownerChangesWithdrawn > 0) {
    lines.push(
      `  - ${plural(r.ownerChangesWithdrawn, 'request')} to change who is an owner ` +
        `${r.ownerChangesWithdrawn === 1 ? 'was' : 'were'} withdrawn;`,
      '    ask again if it still stands, and everybody is told afresh.',
    );
  }
  if (r.liveShareLinks > 0) {
    lines.push(
      `  - ${plural(r.liveShareLinks, 'share link')} ${r.liveShareLinks === 1 ? 'works' : 'work'} ` +
        'again. Look at Shared links and revoke',
      '    any you had revoked since.',
    );
  }
  if (r.openInvitations > 0) {
    lines.push(
      `  - ${plural(r.openInvitations, 'invitation')} ${r.openInvitations === 1 ? 'is' : 'are'} ` +
        'open. Anybody who joined since the backup',
      '    joins again with the same invitation, or is invited afresh.',
    );
  }
  lines.push(
    '',
    'Now start the vault:  docker compose up -d',
    '(with the same -f files you always use, such as docker-compose.tls.yml)',
  );
  return lines.join('\n');
}

/** "fdv-2026-09-24T02-30-00-123Z.sql.enc" was made at 2026-09-24 02:30 UTC. */
function madeAt(file: string): string | null {
  const m = /fdv-(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)/.exec(path.basename(file));
  return m ? `${m[1]} ${m[2]}:${m[3]} UTC` : null;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
