import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deriveKey } from '@fdv/crypto';
import { createDb, createPool, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import { LocalAdapter, StorageError } from '@fdv/storage';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { removeLeftovers } from './purge-leftovers.js';

const MASTER = 'worker-test-master-key-with-32-bytes-or-more';

/**
 * The files of a document removed for good that could not be deleted then
 * (5.24, the review's M524-2): the worker deletes them, each row going with
 * its file; one it cannot reach keeps its row, saying how often and why,
 * until it can.
 */
describe.skipIf(!testAdminUrl())('the files a removal could not delete', () => {
  let tdb: TestDatabase;
  let admin: pg.Pool;
  let db: Db;
  let root: string;
  const hh = randomUUID();
  let vault = '';
  const credentialsKey = deriveKey(MASTER, 'vault-credentials');
  const deps = () => ({ admin, app: db, credentialsKey, localRoot: root });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    db = createDb(createPool(tdb.appUrl, 2));
    root = await mkdtemp(path.join(tmpdir(), 'fdv-leftovers-'));
    await admin.query("insert into household (id, name) values ($1, 'Leftovers')", [hh]);
    vault = (
      await admin.query<{ id: string }>(
        "insert into vault (household_id, kind, label) values ($1, 'local', 'This computer') returning id",
        [hh],
      )
    ).rows[0]?.id as string;
  });
  afterAll(async () => {
    await db?.destroy();
    await admin?.end();
    await tdb?.drop();
    await rm(root, { recursive: true, force: true });
  });

  const put = async (key: string) => {
    await mkdir(path.dirname(path.join(root, key)), { recursive: true });
    await writeFile(path.join(root, key), 'ciphertext');
  };
  const rows = async () =>
    (
      await admin.query<{ object_key: string; tries: number; last_error: string | null }>(
        'select object_key, tries, last_error from purge_leftover order by object_key',
      )
    ).rows;

  it('deletes what it can, keeps the rest written down, and finishes it later', async () => {
    const doc = randomUUID();
    const keys = ['a.pdf.enc', 'a.pdf.enc.p1.enc', 'a.pdf.enc.thumb.enc', 'never-made.enc'].map(
      (k) => `${hh}/${doc}/1/${k}`,
    );
    await put(keys[0] as string);
    await put(keys[1] as string);
    // Something that cannot be deleted as a file is, where the thumbnail was.
    await put(`${keys[2]}/held`);
    for (const key of keys) {
      await admin.query(
        `insert into purge_leftover (household_id, vault_id, object_key, removed_document)
         values ($1, $2, $3, $4)`,
        [hh, vault, key, doc],
      );
    }

    // The two before the one that fails are deleted; it, and what comes
    // after it in the same place, wait for the next run.
    const first = await removeLeftovers(deps(), { household_id: hh });
    expect(first).toEqual({ removed: 2, left: 2 });
    const why = (await rows())[0]?.last_error;
    expect(why).toEqual(expect.any(String));
    expect(await rows()).toEqual([
      { object_key: keys[2], tries: 1, last_error: why },
      { object_key: keys[3], tries: 1, last_error: why },
    ]);
    expect(await readdir(path.join(root, hh, doc, '1'))).toEqual(['a.pdf.enc.thumb.enc']);

    // Out of the way: the nightly run, over every household, finishes them.
    await rm(path.join(root, keys[2] as string), { recursive: true, force: true });
    expect(await removeLeftovers(deps())).toEqual({ removed: 2, left: 0 });
    expect(await rows()).toEqual([]);
    expect(await readdir(path.join(root, hh, doc, '1'))).toEqual([]);
  });

  it('a place out of reach is tried once a run, not once a file; its rows are all counted as tried (the 5.24 check, N524R-3)', async () => {
    const doc = randomUUID();
    const keys = [1, 2, 3, 4].map((n) => `${hh}/${doc}/1/c${n}.enc`);
    for (const key of keys) {
      await admin.query(
        `insert into purge_leftover (household_id, vault_id, object_key, removed_document)
         values ($1, $2, $3, $4)`,
        [hh, vault, key, doc],
      );
    }
    const deletes = vi
      .spyOn(LocalAdapter.prototype, 'delete')
      .mockRejectedValue(
        new StorageError('unreachable', "We can't reach where your files are kept."),
      );
    try {
      expect(await removeLeftovers(deps(), { household_id: hh })).toEqual({ removed: 0, left: 4 });
      expect(deletes).toHaveBeenCalledTimes(1);
    } finally {
      deletes.mockRestore();
    }
    expect((await rows()).map((r) => [r.object_key, r.tries, r.last_error])).toEqual(
      keys.map((k) => [k, 1, "We can't reach where your files are kept."]),
    );
    // Back in reach: the next run finishes them.
    expect(await removeLeftovers(deps(), { household_id: hh })).toEqual({ removed: 4, left: 0 });
    expect(await rows()).toEqual([]);
  });

  it('a place that cannot be opened keeps its rows', async () => {
    const doc = randomUUID();
    const s3 = (
      await admin.query<{ id: string }>(
        // No bucket and no credentials: it cannot be opened.
        "insert into vault (household_id, kind, label) values ($1, 's3', 'Cloud') returning id",
        [hh],
      )
    ).rows[0]?.id as string;
    await admin.query(
      `insert into purge_leftover (household_id, vault_id, object_key, removed_document)
       values ($1, $2, $3, $4)`,
      [hh, s3, `${hh}/${doc}/1/b.pdf.enc`, doc],
    );
    expect(await removeLeftovers(deps(), { household_id: hh })).toEqual({ removed: 0, left: 1 });
    expect(await rows()).toEqual([
      {
        object_key: `${hh}/${doc}/1/b.pdf.enc`,
        tries: 1,
        last_error: 'the place its files are kept could not be opened',
      },
    ]);
  });
});
