import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { deriveKey, EncryptStream, EnvKeyProvider, newKey, ScopeKeys, wrapKey } from '@fdv/crypto';
import { createDb, createPool, withSystem, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import { LocalAdapter } from '@fdv/storage';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { processVersion } from './process-version.js';
import { renderVersionPreviews } from './previews.js';
import type * as Tools from './tools.js';

/**
 * A version removed for good (5.24) while the worker was making something
 * of it. The removal deletes every object it finds, holding the version
 * until it is gone; what the worker writes after that is the worker's to
 * take away again, or it is a file nothing names. The tools are stood in
 * for here — their own tests draw real pages — so that the removal can
 * happen at the one moment that matters: after the drawing, before the
 * worker writes down what it drew.
 */
const during = vi.hoisted(() => ({ now: null as null | (() => Promise<void>) }));

vi.mock('./tools.js', async (importOriginal) => {
  const real = await importOriginal<typeof Tools>();
  const { writeFile } = await import('node:fs/promises');
  const where = await import('node:path');
  return {
    ...real,
    detectTools: async () => ({ pdftoppm: true, magick: true, tesseract: false }),
    pdfPageCount: async () => 2,
    renderPreviews: async (_input: string, _mime: string, out: string) => {
      const pages = [where.join(out, 'pv-1.jpg'), where.join(out, 'pv-2.jpg')];
      for (const p of pages) await writeFile(p, 'a page');
      await during.now?.();
      return pages;
    },
    thumbnail: async (_input: string, output: string) => {
      await writeFile(output, 'a thumbnail');
      await during.now?.();
    },
  };
});

const MASTER = 'worker-test-master-key-with-32-bytes-or-more';

describe.skipIf(!testAdminUrl())('a version removed for good while it is drawn (5.24)', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  let vaultDir: string;
  const hh = randomUUID();
  const keys = new ScopeKeys(new EnvKeyProvider(MASTER));

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 3));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    vaultDir = await mkdtemp(path.join(tmpdir(), 'fdv-removed-'));
    await admin.query("insert into household (id, name) values ($1, 'R')", [hh]);
    await withSystem(db, hh, async (trx) => {
      await keys.mintHouseholdKeys(trx, hh);
      const v = await trx
        .insertInto('vault')
        .values({ household_id: hh, kind: 'local', label: 'test', status: 'ok' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('household')
        .set({ active_vault_id: v.id })
        .where('id', '=', hh)
        .execute();
    });
  }, 60_000);
  afterAll(async () => {
    await db.destroy();
    await admin.end();
    await tdb.drop();
    await rm(vaultDir, { recursive: true, force: true });
  });

  /** A household document with one encrypted PDF version. */
  const store = () =>
    withSystem(db, hh, async (trx) => {
      const doc = await trx
        .insertInto('document')
        .values({ household_id: hh, title: 'Going', visibility: 'household' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const scope = await keys.unwrap(trx, { householdId: hh, kind: 'household' });
      const fileKey = newKey();
      const key = `${hh}/${doc.id}/1/${randomUUID()}.pdf.enc`;
      const enc = new EncryptStream(fileKey);
      const [put] = await Promise.all([
        new LocalAdapter(vaultDir).put(key, enc),
        pipeline(Readable.from([Buffer.from('%PDF-1.4\n%%EOF\n')]), enc),
      ]);
      const vault = await trx.selectFrom('vault').select('id').executeTakeFirstOrThrow();
      const version = await trx
        .insertInto('document_version')
        .values({
          household_id: hh,
          document_id: doc.id,
          version_no: 1,
          filename: 'going.pdf',
          mime: 'application/pdf',
          byte_size: 15,
          sha256: Buffer.alloc(32),
          cipher_bytes: put.bytes,
          cipher_sha256: Buffer.from(put.sha256, 'hex'),
          storage_key: key,
          vault_id: vault.id,
          file_key_wrapped: wrapKey(fileKey, scope.key, `version:${doc.id}`),
          wrapped_by_scope: scope.id,
        })
        .returning(['id', 'storage_key'])
        .executeTakeFirstOrThrow();
      return { documentId: doc.id, versionId: version.id, storageKey: version.storage_key };
    });

  const deps = () => ({
    db,
    keys,
    credentialsKey: deriveKey(MASTER, 'vault-credentials'),
    localRoot: vaultDir,
    maxOcrPages: 1,
    log: () => undefined,
  });
  /** The files of a document, once its own file has gone the way a removal takes it. */
  const filesOf = async (documentId: string) =>
    (await readdir(path.join(vaultDir, hh, documentId), { recursive: true }).catch(() => []))
      .map((f) => String(f).split(path.sep).join('/'))
      .filter((f) => f.endsWith('.enc'))
      .sort();
  /** The removal, as purge.ts does it: the files it finds, then the rows. */
  const removeFor = (v: { documentId: string; storageKey: string }) => async () => {
    const adapter = new LocalAdapter(vaultDir);
    await adapter.delete(v.storageKey);
    await adapter.delete(`${v.storageKey}.thumb.enc`);
    for (let n = 1; n <= 30; n += 1) await adapter.delete(`${v.storageKey}.p${n}.enc`);
    await admin.query('delete from document where id = $1', [v.documentId]);
  };

  it('pages drawn of a version removed meanwhile are taken away again', async () => {
    const v = await store();
    await withSystem(db, hh, (trx) =>
      trx
        .updateTable('document_version')
        .set({ preview_state: 'queued' })
        .where('id', '=', v.versionId)
        .execute(),
    );
    during.now = removeFor(v);
    try {
      await renderVersionPreviews(deps(), { household_id: hh, version_id: v.versionId });
    } finally {
      during.now = null;
    }
    expect(await filesOf(v.documentId)).toEqual([]);
  });

  it('pages of a version still there are kept', async () => {
    const v = await store();
    await renderVersionPreviews(deps(), { household_id: hh, version_id: v.versionId });
    expect((await filesOf(v.documentId)).filter((f) => /\.p\d+\.enc$/.test(f))).toHaveLength(2);
  });

  it('a thumbnail made of a version removed meanwhile is taken away again', async () => {
    const v = await store();
    during.now = removeFor(v);
    try {
      await processVersion(deps(), { household_id: hh, version_id: v.versionId });
    } finally {
      during.now = null;
    }
    expect(await filesOf(v.documentId)).toEqual([]);
  });

  it('a thumbnail of a version still there is kept', async () => {
    const v = await store();
    await processVersion(deps(), { household_id: hh, version_id: v.versionId });
    expect(await filesOf(v.documentId)).toContain(`1/${path.basename(v.storageKey)}.thumb.enc`);
  });
});
