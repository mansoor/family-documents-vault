import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DecryptStream, deriveKey } from '@fdv/crypto';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import { readAll } from '@fdv/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backupDatabase } from './backup.js';

function hasPgDump(): boolean {
  try {
    execFileSync('pg_dump', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!testAdminUrl() || !hasPgDump())('backup.database job', () => {
  let tdb: TestDatabase;
  let dir: string;
  beforeAll(async () => {
    tdb = await createTestDatabase();
    dir = await mkdtemp(path.join(tmpdir(), 'fdv-backups-'));
  });
  afterAll(async () => {
    await tdb.drop();
    await rm(dir, { recursive: true, force: true });
  });

  it('writes an encrypted dump that decrypts to SQL, and prunes old ones', async () => {
    const key = deriveKey('backup-test-master-secret-at-least-32-bytes', 'database-backup');
    const log: unknown[] = [];
    const r = await backupDatabase({
      adminUrl: tdb.adminUrl,
      backupKey: key,
      dir,
      retainDays: 30,
      log: (...a) => log.push(a),
    });
    expect(r.bytes).toBeGreaterThan(1000);
    const raw = await readAll(createReadStream(r.file));
    expect(raw.subarray(0, 4).toString()).toBe('FDV1');
    expect(raw.includes(Buffer.from('CREATE TABLE'))).toBe(false);

    const dec = new DecryptStream(key);
    createReadStream(r.file).pipe(dec);
    const sql = (await readAll(dec)).toString('utf8');
    expect(sql).toContain('CREATE TABLE public.household');
    expect(sql).toContain('CREATE TABLE public.document_version');

    // Retention: a second backup with zero retention removes the first.
    await new Promise((res) => setTimeout(res, 20));
    await backupDatabase({
      adminUrl: tdb.adminUrl,
      backupKey: key,
      dir,
      retainDays: 0,
      log: () => undefined,
    });
    const left = (await readdir(dir)).filter((f) => f.endsWith('.sql.enc'));
    expect(left.length).toBeLessThanOrEqual(1);
  }, 60_000);
});
