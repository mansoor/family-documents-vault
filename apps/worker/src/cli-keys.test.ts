import { execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { deriveKey, EncryptStream } from '@fdv/crypto';
import { createEmptyDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bundleForTest, type Bundled } from './bundle-test-helper.js';

/**
 * The worker's commands and a backup made before a rotation (ROT-R-03,
 * ROT-O-07): each says how to give the old key when it is the likely
 * reason, keeps giving it once given, and decrypt-backup opens such a file
 * too — with a warning that what is in it is still under the old key.
 */

const OLD = 'the-master-key-before-the-rotation-32-bytes-0';
const NEW = 'the-master-key-after-the-rotation-32-bytes-11';
const SQL = 'select 1/0; -- not a vault\n';

function hasPsql(): boolean {
  try {
    execFileSync('psql', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!testAdminUrl())('the worker commands and a backup made before a rotation', () => {
  let dir: string;
  let older: string;
  let newest: string;
  let empty: TestDatabase;
  let env: Record<string, string>;
  let bundled: Bundled;
  /** cli.ts, as the container runs cli.mjs. */
  const cli = (args: string[], extra: Record<string, string>) => bundled.run(args, extra);

  /** A file encrypted as a backup under the old key's backup key. */
  const oldBackup = async (name: string) => {
    const file = path.join(dir, name);
    await pipeline(
      Readable.from([Buffer.from(SQL)]),
      new EncryptStream(deriveKey(OLD, 'database-backup')),
      createWriteStream(file),
    );
    return file;
  };

  beforeAll(async () => {
    bundled = bundleForTest('src/cli.ts');
    dir = await mkdtemp(path.join(tmpdir(), 'fdv-cli-keys-'));
    older = await oldBackup('fdv-2026-09-19T02-30-00-000Z.sql.enc');
    newest = await oldBackup('fdv-2026-09-20T02-30-00-000Z.sql.enc');
    empty = await createEmptyDatabase();
    env = {
      DATABASE_URL: empty.appUrl,
      DATABASE_ADMIN_URL: empty.adminUrl,
      FDV_MASTER_KEY: NEW,
      FDV_BACKUP_DIR: dir,
    };
  }, 60_000);
  afterAll(async () => {
    await empty?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
    await bundled?.remove();
  });

  it.skipIf(!hasPsql())(
    'the drill of such a backup says how to give the old key',
    async () => {
      const r = await cli(['restore-drill', newest], env);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/restore drill FAILED: .*failed authentication/);
      expect(r.stderr).toContain(
        `docker compose exec -e FDV_MASTER_KEY_PREVIOUS=<the old key> worker sh scripts/restore-drill.sh ${newest}`,
      );
    },
    120_000,
  );

  it.skipIf(!hasPsql())(
    'a restore given the old key suggests the backup before with the old key too',
    async () => {
      const r = await cli(['restore-backup', 'latest'], { ...env, FDV_MASTER_KEY_PREVIOUS: OLD });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/Nothing was restored; the database is as it was/);
      expect(r.stderr).toContain(
        '-e FDV_MASTER_KEY_PREVIOUS=<the old key> worker node apps/worker/dist/cli.mjs ' +
          `restore-backup ${older}`,
      );
    },
    120_000,
  );

  it('decrypt-backup opens it with the old key, and warns that it must be restored instead', async () => {
    const out = path.join(dir, 'out.sql');
    const r = await cli(['decrypt-backup', newest, out], {
      ...env,
      FDV_MASTER_KEY_PREVIOUS: OLD,
    });
    expect(r.stderr).toContain('Restore it with restore-backup');
    expect(r.code).toBe(0);
    expect(await readFile(out, 'utf8')).toBe(SQL);
    expect(r.stderr).not.toContain(OLD);
  }, 120_000);
});
