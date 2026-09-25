import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { deriveKey, EncryptStream, EnvKeyProvider, newKey, ScopeKeys, wrapKey } from '@fdv/crypto';
import { createDb, createPool, withHousehold, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import { LocalAdapter } from '@fdv/storage';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decryptToBuffer, processVersion } from './process-version.js';
import { backfillPreviews, previewKey, renderVersionPreviews } from './previews.js';
import { detectTools } from './tools.js';

const run = promisify(execFile);
const MASTER = 'worker-test-master-key-with-32-bytes-or-more';

/** A PDF of `pages` US-letter pages, each saying which it is, built by hand. */
function pagesPdf(pages: number): Buffer {
  const objs: string[] = ['<< /Type /Catalog /Pages 2 0 R >>'];
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  const font = 3 + pages * 2;
  for (let i = 0; i < pages; i += 1) {
    const stream = `BT /F1 36 Tf 72 700 Td (PAGE ${i + 1}) Tj ET`;
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
    );
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
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

/** A JPEG's width and height, from its first start-of-frame marker. */
function jpegSize(b: Buffer): { width: number; height: number } {
  let i = 2;
  while (i < b.length) {
    const marker = b[i + 1] as number;
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  throw new Error('no frame');
}

/**
 * An APP1 Exif block saying "turn me a quarter to the right" (orientation
 * 6), and a GPS-ish string besides, spliced in after a JPEG's first marker.
 */
function withExif(jpeg: Buffer): Buffer {
  const tiff = Buffer.from(
    [
      '4d4d002a00000008', // big-endian TIFF, its one IFD at offset 8
      '0001', // one entry:
      '011200030000000100060000', // Orientation (0x0112), a SHORT, = 6
      '00000000', // and no next IFD
    ].join(''),
    'hex',
  );
  const payload = Buffer.concat([
    Buffer.from('Exif\0\0', 'latin1'),
    tiff,
    Buffer.from('51.5007N0.1246W'),
  ]);
  const header = Buffer.from([0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), header, payload, jpeg.subarray(2)]);
}

const tools = await detectTools();
const magickBin = async () =>
  run('magick', ['-version'])
    .then(() => 'magick')
    .catch(() => 'convert');
const heic =
  tools.magick &&
  (await magickBin()
    .then((bin) => run(bin, ['-list', 'format']))
    .then(({ stdout }) => /^\s*HEIC\*?\s+\S+\s+rw/m.test(stdout))
    .catch(() => false));
const ready = Boolean(testAdminUrl()) && tools.pdftoppm && tools.magick;

describe.skipIf(!ready)('page previews', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  let vaultDir: string;
  let scratch: string;
  const hh = randomUUID();
  let memberId: string;
  const keys = new ScopeKeys(new EnvKeyProvider(MASTER));
  const adapter = () => new LocalAdapter(vaultDir);

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 3));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    vaultDir = await mkdtemp(path.join(tmpdir(), 'fdv-pv-vault-'));
    scratch = await mkdtemp(path.join(tmpdir(), 'fdv-pv-src-'));
    await admin.query('insert into household (id, name) values ($1, $2)', [hh, 'P']);
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
    await rm(scratch, { recursive: true, force: true });
  });

  async function store(plain: Buffer, mime: string, essential: boolean) {
    return withHousehold(db, hh, async (trx) => {
      const doc = await trx
        .insertInto('document')
        .values({
          household_id: hh,
          title: 't',
          owner_member_id: memberId,
          visibility: 'household',
          is_essential: essential,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const scope = await keys.unwrap(trx, { householdId: hh, kind: 'household' });
      const fileKey = newKey();
      const key = `${hh}/${doc.id}/1/${randomUUID()}.enc`;
      const enc = new EncryptStream(fileKey);
      const [put] = await Promise.all([
        adapter().put(key, enc),
        pipeline(Readable.from([plain]), enc),
      ]);
      const vault = await trx.selectFrom('vault').select('id').executeTakeFirstOrThrow();
      const version = await trx
        .insertInto('document_version')
        .values({
          household_id: hh,
          document_id: doc.id,
          version_no: 1,
          filename: 'f',
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
        .returning(['id', 'storage_key'])
        .executeTakeFirstOrThrow();
      return { versionId: version.id, storageKey: version.storage_key, fileKey };
    });
  }

  const deps = () => ({
    db,
    keys,
    credentialsKey: deriveKey(MASTER, 'vault-credentials'),
    localRoot: vaultDir,
    maxOcrPages: 1,
    log: () => undefined,
  });
  const row = (id: string) =>
    withHousehold(db, hh, (trx) =>
      trx
        .selectFrom('document_version')
        .select(['preview_state', 'preview_pages', 'process_error'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    );
  const pageOf = (v: { storageKey: string; fileKey: Buffer }, n: number) =>
    decryptToBuffer(adapter(), previewKey(v.storageKey, n), v.fileKey);

  it('a 3-page Essential PDF gets 3 previews, drawn while it is processed', async () => {
    const v = await store(pagesPdf(3), 'application/pdf', true);
    await processVersion(deps(), { household_id: hh, version_id: v.versionId });
    expect(await row(v.versionId)).toMatchObject({ preview_state: 'ready', preview_pages: 3 });
    for (const n of [1, 2, 3]) {
      const jpeg = await pageOf(v, n);
      expect(jpeg.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])), `page ${n}`).toBe(true);
      const { width, height } = jpegSize(jpeg);
      expect(Math.max(width, height), `page ${n}`).toBe(1600);
    }
    await expect(pageOf(v, 4)).rejects.toThrow();
  }, 120_000);

  it('an everyday document is drawn only when somebody asks', async () => {
    const v = await store(pagesPdf(2), 'application/pdf', false);
    await processVersion(deps(), { household_id: hh, version_id: v.versionId });
    expect((await row(v.versionId)).preview_state).toBe('none');
    await renderVersionPreviews(deps(), { household_id: hh, version_id: v.versionId });
    expect(await row(v.versionId)).toMatchObject({ preview_state: 'ready', preview_pages: 2 });
  }, 120_000);

  it('previews decrypt with the version key, stand the right way up, and carry no EXIF', async () => {
    const bin = await magickBin();
    const src = path.join(scratch, 'wide.jpg');
    await run(bin, ['-size', '2000x1000', 'xc:#88aacc', `jpeg:${src}`]);
    const photo = withExif(await readFile(src));
    const v = await store(photo, 'image/jpeg', false);
    await renderVersionPreviews(deps(), { household_id: hh, version_id: v.versionId });
    expect(await row(v.versionId)).toMatchObject({ preview_state: 'ready', preview_pages: 1 });
    const jpeg = await pageOf(v, 1);
    // Orientation 6 was a quarter turn: the landscape photo is a portrait page.
    expect(jpegSize(jpeg)).toEqual({ width: 800, height: 1600 });
    expect(jpeg.includes(Buffer.from('Exif'))).toBe(false);
    expect(jpeg.includes(Buffer.from('51.5007N'))).toBe(false);
    expect(jpeg.includes(Buffer.from([0xff, 0xe1]))).toBe(false);
  }, 120_000);

  it.skipIf(!heic)(
    'a HEIC photo gets one',
    async () => {
      const bin = await magickBin();
      const src = path.join(scratch, 'photo.heic');
      await run(bin, ['-size', '1200x900', 'xc:#cc8844', `heic:${src}`]);
      const v = await store(await readFile(src), 'image/heic', false);
      await renderVersionPreviews(deps(), { household_id: hh, version_id: v.versionId });
      expect(await row(v.versionId)).toMatchObject({ preview_state: 'ready', preview_pages: 1 });
      expect(jpegSize(await pageOf(v, 1))).toEqual({ width: 1200, height: 900 });
    },
    120_000,
  );

  it('a file claiming to be one kind is read as that kind only', async () => {
    // PDF bytes stored as a PNG: ImageMagick is told "png", and refuses.
    const v = await store(pagesPdf(1), 'image/png', false);
    await expect(
      renderVersionPreviews(deps(), { household_id: hh, version_id: v.versionId }),
    ).rejects.toThrow();
    expect(await row(v.versionId)).toMatchObject({ preview_state: 'failed', preview_pages: 0 });
  }, 120_000);

  it('a kind the vault cannot draw is marked so when it is processed', async () => {
    const v = await store(
      Buffer.from('PK\x03\x04 not really a document'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      true,
    );
    await processVersion(deps(), { household_id: hh, version_id: v.versionId });
    expect(await row(v.versionId)).toMatchObject({
      preview_state: 'unsupported',
      preview_pages: 0,
    });
    // Asked again, it is not tried again.
    await renderVersionPreviews(deps(), { household_id: hh, version_id: v.versionId });
    expect((await row(v.versionId)).preview_state).toBe('unsupported');
  }, 120_000);

  it('the start-up backfill queues each Essential never drawn, once', async () => {
    const v = await store(pagesPdf(1), 'application/pdf', true);
    const everyday = await store(pagesPdf(1), 'application/pdf', false);
    const sent: Array<{ version_id: string }> = [];
    const send = async (job: { household_id: string; version_id: string }) => {
      sent.push(job);
    };
    await backfillPreviews({ admin, app: db, send });
    expect(sent.map((j) => j.version_id)).toContain(v.versionId);
    expect(sent.map((j) => j.version_id)).not.toContain(everyday.versionId);
    expect((await row(v.versionId)).preview_state).toBe('queued');
    const again: typeof sent = [];
    await backfillPreviews({ admin, app: db, send: async (job) => void again.push(job) });
    expect(again.map((j) => j.version_id)).not.toContain(v.versionId);
  }, 120_000);
});
