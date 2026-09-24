import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { EncryptStream } from '@fdv/crypto';
import { libpqConnection } from './libpq.js';

/**
 * Nightly encrypted database dump (NFR-07). `pg_dump` streams through the
 * same chunked AES-256-GCM used for files, under a key derived from the
 * master key, into the backups directory. Thirty days are kept.
 *
 * The dump is taken without privileges, so it loads anywhere; restoring
 * (restore.ts) gives the application role its privileges back, as every
 * start of the vault does. CI restores a backup this job made on every
 * push, so the restore path is exercised, not hoped for.
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
  // Written under another name and renamed when whole: a backup cut short
  // by a crash or a restart must never look like the newest one.
  const partial = `${file}.partial`;

  const conn = libpqConnection(deps.adminUrl);
  const dump = spawn('pg_dump', ['--no-owner', '--no-privileges', '--format=plain', ...conn.args], {
    env: { ...process.env, ...conn.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
    await Promise.all([pipeline(dump.stdout, enc, createWriteStream(partial)), exit]);
  } catch (err) {
    await rm(partial, { force: true });
    throw err;
  }
  await rename(partial, file);
  const bytes = (await stat(file)).size;

  // Retention, and whatever a backup that was killed outright left behind.
  const cutoff = Date.now() - deps.retainDays * 24 * 3600 * 1000;
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  for (const f of await readdir(deps.dir)) {
    const full = path.join(deps.dir, f);
    if (/^fdv-.*\.sql\.enc$/.test(f)) {
      if ((await stat(full)).mtimeMs < cutoff) await rm(full, { force: true });
    } else if (/^fdv-.*\.sql\.enc\.partial$/.test(f)) {
      if ((await stat(full)).mtimeMs < dayAgo) await rm(full, { force: true });
    }
  }
  deps.log('info', 'database backed up', { file, bytes });
  return { file, bytes };
}
