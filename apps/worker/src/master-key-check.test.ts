import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deriveKey, EnvKeyProvider, ScopeKeys } from '@fdv/crypto';
import { createDb, createPool } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bundleForTest, type Bundled } from './bundle-test-helper.js';
import { backupDatabase, BackupRefused } from './jobs/backup.js';

/**
 * The worker does not start, and the nightly backup is not made, on a
 * master key that does not open the vault (ROT-O-01). A worker left on the
 * old key after a rotation failed mail, storage and OCR quietly, and kept
 * making backups under a key the operator had been told could go.
 */

const MASTER = 'worker-start-test-master-secret-32-bytes-000';
const WRONG = 'the-key-after-a-rotation-that-is-not-in-use-000';

function hasPgDump(): boolean {
  try {
    execFileSync('pg_dump', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!testAdminUrl())('the worker and its master key', () => {
  let tdb: TestDatabase;
  let dir: string;
  let main: Bundled;

  beforeAll(async () => {
    main = bundleForTest('src/main.ts');
    tdb = await createTestDatabase();
    dir = await mkdtemp(path.join(tmpdir(), 'fdv-worker-key-'));
    // A household and its scope keys, under MASTER.
    const household = randomUUID();
    const db = createDb(createPool(tdb.adminUrl, 1));
    try {
      await db.insertInto('household').values({ id: household, name: 'Keyed' }).execute();
      await new ScopeKeys(new EnvKeyProvider(MASTER)).mintHouseholdKeys(db, household);
    } finally {
      await db.destroy();
    }
  }, 60_000);
  afterAll(async () => {
    await tdb?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
    await main?.remove();
  });

  it('refuses to start on a key that does not open the vault, and says what to do', async () => {
    const started = await main.run(
      [],
      {
        DATABASE_URL: tdb.appUrl,
        DATABASE_ADMIN_URL: tdb.adminUrl,
        FDV_MASTER_KEY: WRONG,
        FDV_LOCAL_VAULT_DIR: dir,
        FDV_BACKUP_DIR: dir,
      },
      { stopWhen: /"queue started"/ },
    );
    expect(started.stopped).toBe(false);
    expect(started.code).toBe(1);
    expect(started.stderr).toMatch(/FDV_MASTER_KEY does not open this vault \(the \w+ scope key/);
    expect(started.stderr).toContain('docker compose up -d');
  }, 120_000);

  it('makes no backup, and says so in the log, on a key that does not open the vault', async () => {
    const logged: unknown[][] = [];
    await expect(
      backupDatabase({
        adminUrl: tdb.adminUrl,
        backupKey: deriveKey(WRONG, 'database-backup'),
        dir,
        retainDays: 30,
        log: (...a) => logged.push(a),
        masterSecret: WRONG,
      }),
    ).rejects.toBeInstanceOf(BackupRefused);
    expect((await readdir(dir)).filter((f) => f.startsWith('fdv-'))).toEqual([]);
    expect(logged).toContainEqual([
      'error',
      'the master key does not open this vault',
      { reason: expect.stringContaining('FDV_MASTER_KEY does not open this vault') as unknown },
    ]);
  });

  it.skipIf(!hasPgDump())(
    'makes one on the key that opens it',
    async () => {
      const made = await backupDatabase({
        adminUrl: tdb.adminUrl,
        backupKey: deriveKey(MASTER, 'database-backup'),
        dir,
        retainDays: 30,
        log: () => undefined,
        masterSecret: MASTER,
      });
      expect(made.bytes).toBeGreaterThan(1000);
    },
    60_000,
  );
});
