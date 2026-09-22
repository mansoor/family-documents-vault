import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { EncryptStream } from '@fdv/crypto';

/**
 * Nightly encrypted database dump (NFR-07). `pg_dump` streams through the
 * same chunked AES-256-GCM used for files, under a key derived from the
 * master key, into the backups directory. Thirty days are kept.
 *
 * Restoring is `scripts/restore-drill.sh`, which decrypts a dump with the
 * same key and loads it into a scratch database — and CI runs that drill
 * on a schedule, so the restore path is exercised, not hoped for.
 */

export interface BackupDeps {
  adminUrl: string;
  backupKey: Buffer; // deriveKey(master, 'database-backup')
  dir: string;
  retainDays: number;
  log: (level: string, msg: string, extra?: Record<string, unknown>) => void;
}

export async function backupDatabase(deps: BackupDeps): Promise<{ file: string; bytes: number }> {
  await mkdir(deps.dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(deps.dir, `fdv-${stamp}.sql.enc`);

  const dump = spawn(
    'pg_dump',
    ['--no-owner', '--no-privileges', '--format=plain', deps.adminUrl],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  dump.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
  const exit = new Promise<void>((resolve, reject) => {
    dump.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`pg_dump exited ${code}: ${stderr.trim()}`)),
    );
    dump.on('error', reject);
  });
  const enc = new EncryptStream(deps.backupKey);
  try {
    await Promise.all([pipeline(dump.stdout, enc, createWriteStream(file)), exit]);
  } catch (err) {
    await rm(file, { force: true });
    throw err;
  }
  const bytes = (await stat(file)).size;

  // Retention.
  const cutoff = Date.now() - deps.retainDays * 24 * 3600 * 1000;
  for (const f of await readdir(deps.dir)) {
    if (!/^fdv-.*\.sql\.enc$/.test(f)) continue;
    const full = path.join(deps.dir, f);
    if ((await stat(full)).mtimeMs < cutoff) await rm(full, { force: true });
  }
  deps.log('info', 'database backed up', { file, bytes });
  return { file, bytes };
}
