import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  deriveKey,
  EncryptStream,
  EnvKeyProvider,
  newKey,
  openChunk,
  ScopeKeys,
  wrapKey,
} from '@fdv/crypto';
import { createDb, createPool, withHousehold, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import { LocalAdapter } from '@fdv/storage';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decryptToBuffer, processVersion } from './process-version.js';
import { detectTools } from './tools.js';

const MASTER = 'worker-test-master-key-with-32-bytes-or-more';

/**
 * A one-page PDF that says "POLICY NUMBER 4471" in a large plain font,
 * built by hand so no PDF library is needed.
 */
function textPdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 40 700 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const tools = await detectTools();
const ready = Boolean(testAdminUrl()) && tools.pdftoppm && tools.magick && tools.tesseract;

describe.skipIf(!ready)('version.process job', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  let vaultDir: string;
  const hh = randomUUID();
  let memberId: string;
  const keys = new ScopeKeys(new EnvKeyProvider(MASTER));
  const log: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 3));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    vaultDir = await mkdtemp(path.join(tmpdir(), 'fdv-worker-vault-'));
    await admin.query('insert into household (id, name) values ($1, $2)', [hh, 'W']);
    const m = await admin.query<{ id: string }>(
      "insert into member (household_id, display_name) values ($1, 'M') returning id",
      [hh],
    );
    memberId = m.rows[0]?.id as string;
    await withHousehold(db, hh, async (trx) => {
      await keys.mintHouseholdKeys(trx, hh);
      await keys.mintMemberKey(trx, hh, memberId, null);
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

  async function storeVersion(visibility: 'household' | 'private', plain: Buffer) {
    return withHousehold(db, hh, async (trx) => {
      const doc = await trx
        .insertInto('document')
        .values({ household_id: hh, title: 't', owner_member_id: memberId, visibility })
        .returning('id')
        .executeTakeFirstOrThrow();
      const scope = await keys.unwrap(
        trx,
        visibility === 'private'
          ? { householdId: hh, kind: 'member', memberId }
          : { householdId: hh, kind: 'household' },
      );
      const fileKey = newKey();
      const key = `${hh}/${doc.id}/1/abc.pdf.enc`;
      const adapter = new LocalAdapter(vaultDir);
      const enc = new EncryptStream(fileKey);
      const [put] = await Promise.all([
        adapter.put(key, enc),
        pipeline(Readable.from([plain]), enc),
      ]);
      const vault = await trx.selectFrom('vault').select('id').executeTakeFirstOrThrow();
      const version = await trx
        .insertInto('document_version')
        .values({
          household_id: hh,
          document_id: doc.id,
          version_no: 1,
          filename: 'policy.pdf',
          mime: 'application/pdf',
          byte_size: plain.length,
          sha256: Buffer.alloc(32),
          cipher_bytes: put.bytes,
          cipher_sha256: Buffer.from(put.sha256, 'hex'),
          storage_key: key,
          vault_id: vault.id,
          file_key_wrapped: wrapKey(fileKey, scope.key, `version:${doc.id}`),
          wrapped_by_scope: scope.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return { docId: doc.id, versionId: version.id, fileKey, scopeKey: scope.key };
    });
  }

  const deps = () => ({
    db,
    keys,
    credentialsKey: deriveKey(MASTER, 'vault-credentials'),
    localRoot: vaultDir,
    maxOcrPages: 5,
    log: (level: string, msg: string, extra?: Record<string, unknown>) =>
      log.push({ level, msg, ...extra }),
  });

  it('counts pages, caches an encrypted thumbnail and indexes the OCR text', async () => {
    const { versionId, fileKey } = await storeVersion(
      'household',
      textPdf('POLICY NUMBER 4471 EFFECTIVE MARCH'),
    );
    await processVersion(deps(), { household_id: hh, version_id: versionId });

    const v = await withHousehold(db, hh, (trx) =>
      trx
        .selectFrom('document_version')
        .selectAll()
        .where('id', '=', versionId)
        .executeTakeFirstOrThrow(),
    );
    expect(v.page_count).toBe(1);
    expect(v.ocr_status).toBe('done');
    expect(v.process_error).toBeNull();
    expect(v.thumbnail_key).toBe(`${v.storage_key}.thumb.enc`);

    const thumb = await decryptToBuffer(
      new LocalAdapter(vaultDir),
      v.thumbnail_key as string,
      fileKey,
    );
    expect(thumb.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true); // JPEG

    const text = await withHousehold(db, hh, (trx) =>
      trx
        .selectFrom('document_text')
        .select('content')
        .where('version_id', '=', versionId)
        .executeTakeFirstOrThrow(),
    );
    expect(text.content.replace(/\s+/g, ' ')).toMatch(/POLICY NUMBER 4471/i);

    const hit = await withHousehold(db, hh, (trx) =>
      trx
        .selectFrom('document_text')
        .select('document_id')
        .where(sql<boolean>`tsv @@ websearch_to_tsquery('simple', '4471')`)
        .execute(),
    );
    expect(hit).toHaveLength(1);
  }, 120_000);

  it('a private document gets sealed text and no plain index row', async () => {
    const { versionId, scopeKey } = await storeVersion('private', textPdf('SECRET WILL CLAUSE 7'));
    await processVersion(deps(), { household_id: hh, version_id: versionId });
    const plain = await withHousehold(db, hh, (trx) =>
      trx.selectFrom('document_text').selectAll().where('version_id', '=', versionId).execute(),
    );
    expect(plain).toEqual([]);
    const sealed = await withHousehold(db, hh, (trx) =>
      trx
        .selectFrom('document_text_sealed')
        .selectAll()
        .where('version_id', '=', versionId)
        .executeTakeFirstOrThrow(),
    );
    const prefix = sealed.content_cipher.subarray(0, 8);
    const body = sealed.content_cipher.subarray(8);
    const text = openChunk(
      scopeKey,
      { prefix, chunkSize: body.length - 16 },
      0,
      true,
      body,
    ).toString('utf8');
    expect(text.replace(/\s+/g, ' ')).toMatch(/SECRET WILL CLAUSE 7/i);
    expect(sealed.content_cipher.toString('latin1')).not.toContain('SECRET');
  }, 120_000);
});
