import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deriveKey } from '@fdv/crypto';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { markRemovedFiles, recheckRemovedFiles } from './removed-files.js';

const MASTER = 'worker-test-master-key-with-32-bytes-or-more';
const quiet = () => undefined;

/**
 * What a restore marks removed for good, and what it leaves alone (5.24, the
 * review's D524-02): only files gone from a place that clearly holds files;
 * a folder that is not there, or one holding none of the files it should, is
 * said and marked nothing. And a mark is undone once the file is back.
 */
describe.skipIf(!testAdminUrl())('files a restore finds gone', () => {
  let tdb: TestDatabase;
  let admin: pg.Pool;
  let root: string;
  const hh = randomUUID();
  let vault = '';
  let scope = '';
  const storage = (localRoot: string) => ({
    credentialsKey: deriveKey(MASTER, 'vault-credentials'),
    localRoot,
  });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    root = await mkdtemp(path.join(tmpdir(), 'fdv-removed-files-'));
    await admin.query("insert into household (id, name) values ($1, 'Files')", [hh]);
    vault = (
      await admin.query<{ id: string }>(
        "insert into vault (household_id, kind, label) values ($1, 'local', 'This computer') returning id",
        [hh],
      )
    ).rows[0]?.id as string;
    scope = (
      await admin.query<{ id: string }>(
        "insert into scope_key (household_id, kind, key_wrapped) values ($1, 'household', '\\x00') returning id",
        [hh],
      )
    ).rows[0]?.id as string;
  });
  afterAll(async () => {
    await admin.end();
    await tdb.drop();
    await rm(root, { recursive: true, force: true });
  });

  /** A document with one version, its file in `under` when asked; its version's id and key. */
  const version = async (under: string | null, removed = false) => {
    const doc = (
      await admin.query<{ id: string }>(
        "insert into document (household_id, title) values ($1, 'A paper') returning id",
        [hh],
      )
    ).rows[0]?.id as string;
    const key = `${hh}/${doc}/1/${randomUUID()}.pdf.enc`;
    const v = (
      await admin.query<{ id: string }>(
        `insert into document_version
           (household_id, document_id, version_no, filename, mime, byte_size, sha256,
            cipher_bytes, cipher_sha256, storage_key, vault_id, file_key_wrapped, wrapped_by_scope,
            file_removed_at)
         values ($1, $2, 1, 'a.pdf', 'application/pdf', 1, '\\x00', 1, '\\x00', $3, $4, '\\x00', $5,
                 case when $6 then now() end)
         returning id`,
        [hh, doc, key, vault, scope, removed],
      )
    ).rows[0]?.id as string;
    if (under) {
      await mkdir(path.dirname(path.join(under, key)), { recursive: true });
      await writeFile(path.join(under, key), 'ciphertext');
    }
    return { id: v, key };
  };
  const marked = async () =>
    (
      await admin.query<{ id: string }>(
        'select id from document_version where file_removed_at is not null order by id',
      )
    ).rows.map((r) => r.id);
  const clean = () => admin.query('delete from document where household_id = $1', [hh]);

  it('a folder that is not there marks nothing, and says why', async () => {
    await clean();
    await version(root);
    await version(root);
    const r = await markRemovedFiles(admin, storage(path.join(root, 'not-mounted')), quiet);
    expect(r.filesRemoved).toEqual([]);
    expect(r.filesUnchecked).toBe(2);
    expect(r.filesUncheckedWhy.join(' ')).toMatch(/is not there: is it mounted\?/);
    expect(await marked()).toEqual([]);
  });

  it('a place holding none of the files it should marks nothing, and says why', async () => {
    await clean();
    const empty = await mkdtemp(path.join(tmpdir(), 'fdv-empty-vault-'));
    try {
      await version(null);
      await version(null);
      const r = await markRemovedFiles(admin, storage(empty), quiet);
      expect(r.filesRemoved).toEqual([]);
      expect(r.filesUnchecked).toBe(2);
      expect(r.filesUncheckedWhy.join(' ')).toMatch(/None of the 2 file\(s\) .* is there/);
      expect(await marked()).toEqual([]);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('only the files gone from a place that holds the rest are marked', async () => {
    await clean();
    await version(root);
    const gone = await version(null);
    const r = await markRemovedFiles(admin, storage(root), quiet);
    expect(r.filesRemoved.map((f) => f.version_id)).toEqual([gone.id]);
    expect(r).toMatchObject({ filesUnchecked: 0, filesUncheckedWhy: [] });
    expect(await marked()).toEqual([gone.id]);
  });

  it('a file put back after it was marked is no longer said to be removed', async () => {
    await clean();
    const back = await version(root, true);
    const stillGone = await version(null, true);
    await version(root);
    expect((await marked()).sort()).toEqual([back.id, stillGone.id].sort());
    const r = await recheckRemovedFiles(admin, storage(root), quiet);
    expect(r).toMatchObject({ found: 1, stillRemoved: 1, unchecked: 0 });
    expect(await marked()).toEqual([stillGone.id]);
    // Looked at again with the folder gone: nothing is unmarked, or marked.
    const away = await recheckRemovedFiles(admin, storage(path.join(root, 'gone')), quiet);
    expect(away).toMatchObject({ found: 0, unchecked: 1 });
    expect(await marked()).toEqual([stillGone.id]);
  });
});
