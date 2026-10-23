import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32, deflateSync } from 'node:zlib';
import {
  deriveKey,
  EncryptStream,
  EnvKeyProvider,
  newKey,
  openChunk,
  ScopeKeys,
  wrapKey,
} from '@fdv/crypto';
import { createDb, createPool, withSystem, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import { LocalAdapter } from '@fdv/storage';
import { ZipArchive } from 'archiver';
import { sql } from 'kysely';
import pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQueue } from '../queue.js';
import {
  decryptToBuffer,
  PROCESS_JOB_EXPIRE_SECONDS,
  processQueue,
  processVersion,
  VERSION_READ_DEADLINE_MS,
} from './process-version.js';
import { detectTools } from './tools.js';
import { WORD_MIME } from './word-text.js';

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

/** A Word file whose body says `text` (5.37): the zip Word makes, with only what it needs. */
async function wordFile(text: string): Promise<Buffer> {
  const zip = new ZipArchive({ zlib: { level: 6 } });
  const chunks: Buffer[] = [];
  zip.on('data', (c: Buffer) => chunks.push(c));
  const ended = new Promise<void>((resolve, reject) => {
    zip.on('end', () => resolve());
    zip.on('error', reject);
  });
  zip.append(
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    { name: 'word/document.xml' },
  );
  await zip.finalize();
  await ended;
  return Buffer.concat(chunks);
}

const tools = await detectTools();
const ready = Boolean(testAdminUrl()) && tools.pdftoppm && tools.magick && tools.tesseract;

describe.skipIf(!testAdminUrl())('version.process job', () => {
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
    await withSystem(db, hh, async (trx) => {
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

  async function storeVersion(
    visibility: 'household' | 'private',
    plain: Buffer,
    mime = 'application/pdf',
  ) {
    return withSystem(db, hh, async (trx) => {
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
          filename: mime === WORD_MIME ? 'letter.docx' : 'policy.pdf',
          mime,
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

  it.skipIf(!ready)(
    'counts pages, caches an encrypted thumbnail and indexes the OCR text',
    async () => {
      const { versionId, fileKey } = await storeVersion(
        'household',
        textPdf('POLICY NUMBER 4471 EFFECTIVE MARCH'),
      );
      await processVersion(deps(), { household_id: hh, version_id: versionId });

      const v = await withSystem(db, hh, (trx) =>
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

      const text = await withSystem(db, hh, (trx) =>
        trx
          .selectFrom('document_text')
          .select('content')
          .where('version_id', '=', versionId)
          .executeTakeFirstOrThrow(),
      );
      expect(text.content.replace(/\s+/g, ' ')).toMatch(/POLICY NUMBER 4471/i);

      const hit = await withSystem(db, hh, (trx) =>
        trx
          .selectFrom('document_text')
          .select('document_id')
          .where(sql<boolean>`tsv @@ websearch_to_tsquery('simple', '4471')`)
          .execute(),
      );
      expect(hit).toHaveLength(1);
    },
    120_000,
  );

  it.skipIf(!ready)(
    'reading its words has a deadline: past it, its tools are stopped and it says it was too slow (R3 review)',
    async () => {
      const { versionId } = await storeVersion('household', textPdf('POLICY NUMBER 4471'));
      const started = Date.now();
      await processVersion(
        { ...deps(), readDeadlineMs: 1 },
        { household_id: hh, version_id: versionId },
      );
      expect(Date.now() - started).toBeLessThan(30_000);
      const v = await withSystem(db, hh, (trx) =>
        trx
          .selectFrom('document_version')
          .selectAll()
          .where('id', '=', versionId)
          .executeTakeFirstOrThrow(),
      );
      expect(v.ocr_status).toBe('failed');
      expect(v.process_error).toMatch(/ocr: too slow/);
      // The rest of the job is done as ever: the page counted.
      expect(v.page_count).toBe(1);
      expect(VERSION_READ_DEADLINE_MS).toBeLessThan(PROCESS_JOB_EXPIRE_SECONDS * 1000 - 60_000);
    },
    120_000,
  );

  it('a queue made before R3 takes its expiry too, not pg-boss’s 900 seconds (R3 re-check)', async () => {
    const boss: PgBoss = createQueue({ connectionString: tdb.adminUrl, migrate: true });
    boss.on('error', () => undefined);
    await boss.start();
    try {
      // As an install before R3 made it.
      await boss.createQueue('version.process.before-r3', { retryLimit: 3, retryDelay: 30 });
      expect((await boss.getQueue('version.process.before-r3'))?.expireInSeconds).toBe(900);
      await processQueue(boss, 'version.process.before-r3');
      expect((await boss.getQueue('version.process.before-r3'))?.expireInSeconds).toBe(
        PROCESS_JOB_EXPIRE_SECONDS,
      );
      // A new one is made with it.
      await processQueue(boss, 'version.process.new');
      expect((await boss.getQueue('version.process.new'))?.expireInSeconds).toBe(
        PROCESS_JOB_EXPIRE_SECONDS,
      );
    } finally {
      await boss.stop({ graceful: false });
    }
  }, 60_000);

  it.skipIf(!ready)(
    'past its deadline the pages read are kept, and second looks end at half of it (R3 re-check)',
    async () => {
      const { versionId } = await storeVersion('household', textPdf('POLICY NUMBER 4471'));
      const seen: { looksFirst?: boolean; readAt?: number } = {};
      const started = Date.now();
      await processVersion(
        {
          ...deps(),
          readDeadlineMs: 2_000,
          // The first page read; the deadline passes on the second.
          extract: async (_file, _mime, o) => {
            const { looksUntil, signal } = o;
            if (!looksUntil || !signal) throw new Error('no deadline given');
            await new Promise((resolve) => looksUntil.addEventListener('abort', resolve));
            seen.looksFirst = !signal.aborted;
            seen.readAt = Date.now() - started;
            return {
              text: 'POLICY NUMBER 4471, its first page',
              source: 'ocr',
              textPages: 0,
              ocrPages: 1,
              unreadPages: 2,
            };
          },
        },
        { household_id: hh, version_id: versionId },
      );
      expect(seen.looksFirst).toBe(true);
      expect(seen.readAt).toBeGreaterThanOrEqual(900);
      const v = await withSystem(db, hh, (trx) =>
        trx
          .selectFrom('document_version')
          .selectAll()
          .where('id', '=', versionId)
          .executeTakeFirstOrThrow(),
      );
      expect(v.ocr_status).toBe('done');
      expect(v.process_error).toMatch(/ocr: too slow \(1 of 3 scanned pages read/);
      const hit = await withSystem(db, hh, (trx) =>
        trx
          .selectFrom('document_text')
          .select('document_id')
          .where('version_id', '=', versionId)
          .where(sql<boolean>`tsv @@ websearch_to_tsquery('simple', '4471')`)
          .execute(),
      );
      expect(hit).toHaveLength(1);
    },
    120_000,
  );

  it.skipIf(!ready)(
    'a picture bigger than the vault reads is said to be refused, not as a tool that failed (R3 review)',
    async () => {
      // A PNG a few hundred bytes long whose header says 60,000 pixels square.
      const chunk = (type: string, data: Buffer) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(body));
        return Buffer.concat([len, body, crc]);
      };
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(60_000, 0);
      ihdr.writeUInt32BE(60_000, 4);
      ihdr.set([8, 0, 0, 0, 0], 8);
      const bomb = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(Buffer.alloc(4096))),
        chunk('IEND', Buffer.alloc(0)),
      ]);
      const { versionId } = await storeVersion('household', bomb, 'image/png');
      await processVersion(deps(), { household_id: hh, version_id: versionId });
      const v = await withSystem(db, hh, (trx) =>
        trx
          .selectFrom('document_version')
          .selectAll()
          .where('id', '=', versionId)
          .executeTakeFirstOrThrow(),
      );
      expect(v.ocr_status).toBe('failed');
      expect(v.process_error).toMatch(/ocr: picture refused/);
    },
    120_000,
  );

  it.skipIf(!ready)(
    'a private document gets sealed text and no plain index row',
    async () => {
      const { versionId, scopeKey } = await storeVersion(
        'private',
        textPdf('SECRET WILL CLAUSE 7'),
      );
      await processVersion(deps(), { household_id: hh, version_id: versionId });
      const plain = await withSystem(db, hh, (trx) =>
        trx.selectFrom('document_text').selectAll().where('version_id', '=', versionId).execute(),
      );
      expect(plain).toEqual([]);
      const sealed = await withSystem(db, hh, (trx) =>
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
    },
    120_000,
  );

  it("a Word file's words are indexed (5.37): read from its XML, nothing drawn", async () => {
    const { versionId } = await storeVersion(
      'household',
      await wordFile('Offer of employment, ostrich 4471'),
      WORD_MIME,
    );
    log.length = 0;
    await processVersion(deps(), { household_id: hh, version_id: versionId });
    const v = await withSystem(db, hh, (trx) =>
      trx
        .selectFrom('document_version')
        .selectAll()
        .where('id', '=', versionId)
        .executeTakeFirstOrThrow(),
    );
    expect(v.ocr_status).toBe('done');
    expect(v.process_error).toBeNull();
    expect(v.thumbnail_key).toBeNull();
    expect(v.preview_state).toBe('unsupported');
    const hit = await withSystem(db, hh, (trx) =>
      trx
        .selectFrom('document_text')
        .select('version_id')
        .where(sql<boolean>`tsv @@ websearch_to_tsquery('simple', 'ostrich')`)
        .execute(),
    );
    expect(hit.map((r) => r.version_id)).toEqual([versionId]);
    // The log says how the words were read, never what they are.
    const said = JSON.stringify(log);
    expect(said).toContain('"source":"word"');
    expect(said).not.toContain('ostrich');
  }, 60_000);

  it("an Only me Word file's words are sealed under its owner's key (5.9), and not in the index", async () => {
    const { versionId, scopeKey } = await storeVersion(
      'private',
      await wordFile('Sealed pelican clause 9'),
      WORD_MIME,
    );
    await processVersion(deps(), { household_id: hh, version_id: versionId });
    const plain = await withSystem(db, hh, (trx) =>
      trx.selectFrom('document_text').selectAll().where('version_id', '=', versionId).execute(),
    );
    expect(plain).toEqual([]);
    const sealed = await withSystem(db, hh, (trx) =>
      trx
        .selectFrom('document_text_sealed')
        .selectAll()
        .where('version_id', '=', versionId)
        .executeTakeFirstOrThrow(),
    );
    const body = sealed.content_cipher.subarray(8);
    const text = openChunk(
      scopeKey,
      { prefix: sealed.content_cipher.subarray(0, 8), chunkSize: body.length - 16 },
      0,
      true,
      body,
    ).toString('utf8');
    expect(text).toBe('Sealed pelican clause 9');
    expect(sealed.content_cipher.toString('latin1')).not.toContain('pelican');
  }, 60_000);

  it('a Word file that is not one fails its reading, says why, and nothing else', async () => {
    const { versionId } = await storeVersion('household', Buffer.from('not a zip'), WORD_MIME);
    await processVersion(deps(), { household_id: hh, version_id: versionId });
    const v = await withSystem(db, hh, (trx) =>
      trx
        .selectFrom('document_version')
        .selectAll()
        .where('id', '=', versionId)
        .executeTakeFirstOrThrow(),
    );
    expect(v.ocr_status).toBe('failed');
    expect(v.process_error).toBe('ocr: not a readable Word file: not a zip');
  }, 60_000);
});
