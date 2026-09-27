import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { deriveKey, EncryptStream, EnvKeyProvider, newKey, ScopeKeys, wrapKey } from '@fdv/crypto';
import { createDb, createPool, withSystem, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import { LocalAdapter } from '@fdv/storage';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { previewKey, renderVersionPreviews } from './previews.js';
import { decryptToBuffer, processVersion } from './process-version.js';
import { drawSharePages, pruneSharePages, sharePageKey, watermarkText } from './share-pages.js';
import { detectTools, hasPango, magickText, watermarkLine, watermarkPage } from './tools.js';

const run = promisify(execFile);
const MASTER = 'worker-test-master-key-with-32-bytes-or-more';

const magickBin = async () =>
  run('magick', ['-version'])
    .then(() => 'magick')
    .catch(() => 'convert');

/**
 * How much of a region of the page the mark changed, 0 to 1: the page as
 * the vault drew it against the page as the link shows it, the band at the
 * foot cut off — so only what lies across the page itself counts.
 */
async function markedShare(
  own: string,
  shown: string,
  region: { x: number; y: number; w: number; h: number },
): Promise<number> {
  const { stdout } = await run(await magickBin(), [
    own,
    shown,
    '-compose',
    'difference',
    '-composite',
    '-crop',
    `${region.w}x${region.h}+${region.x}+${region.y}`,
    '+repage',
    '-colorspace',
    'gray',
    '-threshold',
    '10%',
    '-format',
    '%[fx:mean]',
    'info:',
  ]);
  return Number(stdout.trim());
}

/** The four corners of a page: a third of its width, a fifth of its height. */
const corners = (width: number, height: number) => {
  const w = Math.floor(width / 3);
  const h = Math.floor(height / 5);
  return {
    'top left': { x: 0, y: 0, w, h },
    'top right': { x: width - w, y: 0, w, h },
    'bottom left': { x: 0, y: height - h, w, h },
    'bottom right': { x: width - w, y: height - h, w, h },
  };
};

/** How much of an image's foot band is ink (anything not near white), 0 to 1. */
async function footInk(file: string, band: number): Promise<number> {
  const { stdout } = await run(await magickBin(), [
    file,
    '-gravity',
    'south',
    '-crop',
    `0x${band}+0+0`,
    '+repage',
    '-colorspace',
    'gray',
    '-threshold',
    '85%',
    '-negate',
    '-format',
    '%[fx:mean]',
    'info:',
  ]);
  return Number(stdout.trim());
}

/** Whether fontconfig has a font for a language: what drawing a label in it needs. */
const fontFor = (lang: string) =>
  run('fc-list', [`:lang=${lang}`, 'family'])
    .then(({ stdout }) => stdout.trim().length > 0)
    .catch(() => false);

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

const tools = await detectTools();
const drawing = Boolean(testAdminUrl()) && tools.pdftoppm && tools.magick;
/**
 * Every script a label is drawn in (5.18 review): with pango, and the
 * worker image's fonts for Chinese, Japanese and Korean, Devanagari,
 * Arabic and emoji. Elsewhere those tests are skipped: a machine without
 * the fonts draws what it can.
 */
const everyScript =
  tools.magick &&
  (await hasPango()) &&
  (await fontFor('zh')) &&
  (await fontFor('hi')) &&
  (await fontFor('ar'));

/**
 * A view-only link's pages (5.18, A22): the vault's drawn pages, drawn
 * again for the link with whom it is for and the day it was made across
 * each, and removed when the link ends.
 */
describe.skipIf(!testAdminUrl())("a view-only link's pages", () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  let vaultDir: string;
  const hh = randomUUID();
  let memberId: string;
  let accountId: string;
  const keys = new ScopeKeys(new EnvKeyProvider(MASTER));
  const adapter = () => new LocalAdapter(vaultDir);
  const credentialsKey = deriveKey(MASTER, 'vault-credentials');

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 3));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    vaultDir = await mkdtemp(path.join(tmpdir(), 'fdv-sp-vault-'));
    await admin.query(
      "insert into household (id, name, timezone) values ($1, 'P', 'Europe/London')",
      [hh],
    );
    memberId = (
      await admin.query<{ id: string }>(
        "insert into member (household_id, display_name) values ($1, 'M') returning id",
        [hh],
      )
    ).rows[0]?.id as string;
    accountId = (
      await admin.query<{ id: string }>(
        `insert into account (email) values ('sp-${hh}@example.test') returning id`,
      )
    ).rows[0]?.id as string;
    await admin.query(
      "insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, 'owner')",
      [accountId, hh, memberId],
    );
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
    await db?.destroy();
    await admin?.end();
    await tdb?.drop();
    if (vaultDir) await rm(vaultDir, { recursive: true, force: true });
  });

  /** A document with one version of `plain`, stored as the vault stores it. */
  async function store(plain: Buffer, mime: string, documentId?: string, versionNo = 1) {
    return withSystem(db, hh, async (trx) => {
      const doc =
        documentId ??
        (
          await trx
            .insertInto('document')
            .values({ household_id: hh, title: 't', visibility: 'household' })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      const scope = await keys.unwrap(trx, { householdId: hh, kind: 'household' });
      const fileKey = newKey();
      const key = `${hh}/${doc}/${versionNo}/${randomUUID()}.enc`;
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
          document_id: doc,
          version_no: versionNo,
          filename: 'f',
          mime,
          byte_size: plain.length,
          sha256: Buffer.alloc(32),
          cipher_bytes: put.bytes,
          cipher_sha256: Buffer.from(put.sha256, 'hex'),
          storage_key: key,
          vault_id: vault.id,
          file_key_wrapped: wrapKey(fileKey, scope.key, `version:${doc}`),
          wrapped_by_scope: scope.id,
        })
        .returning(['id', 'storage_key'])
        .executeTakeFirstOrThrow();
      return { documentId: doc, versionId: version.id, storageKey: version.storage_key, fileKey };
    });
  }

  /** A link to a document, made as 5.18 makes them, with whatever it has been through. */
  async function link(
    documentId: string,
    opts: { permission?: 'view' | 'download'; label?: string; ended?: string } = {},
  ) {
    const { rows } = await admin.query<{ id: string }>(
      `insert into share_link (household_id, document_id, token_hash, created_by, expires_at,
                               permission, recipient_label, created_at)
       values ($1, $2, $3, $4, now() + interval '7 days', $5, $6, '2026-09-27T10:00:00Z')
       returning id`,
      [hh, documentId, randomBytes(32), accountId, opts.permission ?? 'view', opts.label ?? null],
    );
    const id = rows[0]?.id as string;
    if (opts.ended) await admin.query(`update share_link set ${opts.ended} where id = $1`, [id]);
    return id;
  }

  const deps = () => ({
    db,
    keys,
    credentialsKey,
    localRoot: vaultDir,
    maxOcrPages: 1,
    log: () => undefined,
  });
  const pagesOf = async (shareId: string) =>
    (
      await admin.query<{ n: number; storage_key: string; version_id: string }>(
        'select n, storage_key, version_id from share_page where share_id = $1 order by n',
        [shareId],
      )
    ).rows;
  const exists = (key: string) =>
    adapter()
      .get(key)
      .then(
        (s) => {
          s.destroy();
          return true;
        },
        () => false,
      );

  it("what is written across is whom it is for and the day it was made, and ImageMagick's escapes are plain", () => {
    const made = new Date('2026-09-27T23:30:00Z');
    // Half past midnight in London: the household's day, not the server's.
    expect(
      watermarkText({ recipient_label: 'the letting agent', created_at: made }, 'Europe/London'),
    ).toBe('Shared with ⁨the letting agent⁩ · 28 September 2026');
    expect(watermarkText({ recipient_label: null, created_at: made }, 'UTC')).toBe(
      'Shared by link · 27 September 2026',
    );
    // A label is set apart, so a name in Arabic keeps the date after it; and
    // what it carries of its own to turn the line about is taken out.
    expect(watermarkText({ recipient_label: 'أحمد ‮⁩علي', created_at: made }, 'UTC')).toBe(
      'Shared with ⁨أحمد علي⁩ · 27 September 2026',
    );
    expect(watermarkLine('a⁨b⁩ ‮c\u0007\nd')).toBe('a⁨b⁩ c d');
    expect(magickText('100% %[fx:1] \\n and\u0007 more\nlines')).toBe(
      '100%% %%[fx:1] \\\\n and more lines',
    );
    expect(magickText('@/etc/passwd')).toBe(' @/etc/passwd');
    expect(magickText('x'.repeat(500))).toHaveLength(160);
  });

  it.skipIf(!drawing)(
    'every page of a view-only link carries the watermark',
    async () => {
      const v = await store(pagesPdf(3), 'application/pdf');
      const id = await link(v.documentId, { label: 'the letting agent' });
      // The version's own pages are drawn first, then the link's.
      expect(await drawSharePages(deps(), { household_id: hh, share_id: id })).toEqual({
        drawn: 3,
      });
      const rows = await pagesOf(id);
      expect(rows.map((r) => r.n)).toEqual([1, 2, 3]);
      const scratch = await mkdtemp(path.join(tmpdir(), 'fdv-sp-ocr-'));
      try {
        for (const r of rows) {
          expect(r.storage_key).toBe(sharePageKey(v.storageKey, id, r.n));
          expect(r.version_id).toBe(v.versionId);
          const own = await decryptToBuffer(adapter(), previewKey(v.storageKey, r.n), v.fileKey);
          const marked = await decryptToBuffer(adapter(), r.storage_key, v.fileKey);
          // A picture, and not the vault's own page: the same width, and
          // taller by the band along its foot.
          expect(marked.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
          expect(marked.equals(own)).toBe(false);
          const [a, b] = [jpegSize(own), jpegSize(marked)];
          expect(b.width, `page ${r.n}`).toBe(a.width);
          expect(b.height, `page ${r.n}`).toBeGreaterThan(a.height);
          expect(marked.includes(Buffer.from('Exif'))).toBe(false);
          // The page itself, the band at its foot cut off: what a crop to the
          // page's own edges keeps (5.18 review). The mark is across all of
          // it, corners included ...
          const ownFile = path.join(scratch, `own${r.n}.jpg`);
          const pageFile = path.join(scratch, `page${r.n}.png`);
          await writeFile(ownFile, own);
          await writeFile(path.join(scratch, `marked${r.n}.jpg`), marked);
          await run(await magickBin(), [
            `jpeg:${path.join(scratch, `marked${r.n}.jpg`)}`,
            '-crop',
            `${a.width}x${a.height}+0+0`,
            '+repage',
            `png:${pageFile}`,
          ]);
          for (const [where, region] of Object.entries(corners(a.width, a.height))) {
            expect(
              await markedShare(`jpeg:${ownFile}`, `png:${pageFile}`, region),
              `page ${r.n}, ${where}`,
            ).toBeGreaterThan(0.002);
          }
          // ... and says whom it is for, where a reader — or a machine — can
          // see: read level (the mark rises at 30 degrees), in its own colour.
          if (tools.tesseract) {
            const level = path.join(scratch, `level${r.n}.png`);
            await run(await magickBin(), [
              `png:${pageFile}`,
              '-rotate',
              '30',
              '-colorspace',
              'HSL',
              '-channel',
              'G',
              '-separate',
              '+channel',
              '-threshold',
              '45%',
              '-negate',
              `png:${level}`,
            ]);
            const { stdout } = await run('tesseract', [level, '-', '--psm', '6'], {
              timeout: 120_000,
            });
            expect(stdout, `page ${r.n}`).toMatch(/letting\W{0,3}agent/i);
            expect(stdout, `page ${r.n}`).toMatch(/2026/);
          }
        }
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
      // Asked again, it has them: nothing is drawn twice.
      expect(await drawSharePages(deps(), { household_id: hh, share_id: id })).toEqual({
        drawn: 3,
      });

      // A newer version: drawn again, and the older version's pages go.
      const newer = await store(pagesPdf(1), 'application/pdf', v.documentId, 2);
      expect(await drawSharePages(deps(), { household_id: hh, share_id: id })).toEqual({
        drawn: 1,
      });
      expect((await pagesOf(id)).map((r) => r.version_id)).toEqual([newer.versionId]);
      for (const n of [1, 2, 3]) {
        expect(await exists(sharePageKey(v.storageKey, id, n)), `old page ${n}`).toBe(false);
      }
      // A label with ImageMagick's own escapes in it is drawn as it is written.
      const odd = await link(newer.documentId, { label: '100% %[fx:1] @/etc/hostname' });
      expect(await drawSharePages(deps(), { household_id: hh, share_id: odd })).toEqual({
        drawn: 1,
      });
    },
    180_000,
  );

  it.skipIf(!drawing)(
    'the mark is seen across a dark photo too, in every corner (5.18 review)',
    async () => {
      const bin = await magickBin();
      const scratch = await mkdtemp(path.join(tmpdir(), 'fdv-sp-dark-'));
      try {
        // A dark, landscape photo: navy, the colour the old mark vanished on.
        const src = path.join(scratch, 'dark.jpg');
        await run(bin, ['-size', '2000x1200', 'xc:#1a2340', `jpeg:${src}`]);
        const v = await store(await readFile(src), 'image/jpeg');
        const id = await link(v.documentId, { label: 'the letting agent' });
        expect(await drawSharePages(deps(), { household_id: hh, share_id: id })).toEqual({
          drawn: 1,
        });
        const own = await decryptToBuffer(adapter(), previewKey(v.storageKey, 1), v.fileKey);
        const [row] = await pagesOf(id);
        const marked = await decryptToBuffer(adapter(), row?.storage_key ?? '', v.fileKey);
        const a = jpegSize(own);
        await writeFile(path.join(scratch, 'own.jpg'), own);
        await writeFile(path.join(scratch, 'marked.jpg'), marked);
        await run(bin, [
          `jpeg:${path.join(scratch, 'marked.jpg')}`,
          '-crop',
          `${a.width}x${a.height}+0+0`,
          '+repage',
          `png:${path.join(scratch, 'page.png')}`,
        ]);
        for (const [where, region] of Object.entries(corners(a.width, a.height))) {
          expect(
            await markedShare(
              `jpeg:${path.join(scratch, 'own.jpg')}`,
              `png:${path.join(scratch, 'page.png')}`,
              region,
            ),
            where,
          ).toBeGreaterThan(0.002);
        }
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it.skipIf(!everyScript)(
    'a label in Chinese, Korean, Devanagari, Arabic or with emoji is drawn, not left out (5.18 review)',
    async () => {
      const bin = await magickBin();
      const scratch = await mkdtemp(path.join(tmpdir(), 'fdv-sp-scripts-'));
      try {
        const page = path.join(scratch, 'page.jpg');
        await run(bin, ['-size', '1236x1600', 'xc:white', `jpeg:${page}`]);
        const made = new Date('2026-09-27T10:00:00Z');
        /** How much ink the foot line has, with this label. */
        const inkWith = async (label: string | null, name: string) => {
          const out = path.join(scratch, `${name}.jpg`);
          await watermarkPage(
            page,
            out,
            watermarkText({ recipient_label: label, created_at: made }, 'UTC'),
          );
          const { height } = jpegSize(await readFile(out));
          return footInk(out, height - 1600);
        };
        // The foot line with a one-letter label, beside it with the name:
        // a name drawn is more ink; a name left out as blanks is not.
        const bare = await inkWith('x', 'bare');
        for (const [name, label] of [
          ['chinese', '王小明 王小明 王小明'],
          ['korean', '김민수 김민수 김민수'],
          ['devanagari', 'राम शर्मा राम शर्मा'],
          ['arabic', 'أحمد علي أحمد علي'],
          ['emoji', 'x 🏠 🔑 🏠 🔑 🏠'],
        ] as const) {
          expect(await inkWith(label, name), name).toBeGreaterThan(bare * 1.25);
        }
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it.skipIf(!drawing)(
    "a scanner's TIFF is shared page by page, and counted, up to 30 (5.18 review)",
    async () => {
      const bin = await magickBin();
      const scratch = await mkdtemp(path.join(tmpdir(), 'fdv-sp-tiff-'));
      try {
        const three = path.join(scratch, 'three.tif');
        await run(bin, ['-size', '600x800', 'xc:white', 'xc:gray90', 'xc:gray80', `tiff:${three}`]);
        const v = await store(await readFile(three), 'image/tiff');
        await processVersion(deps(), { household_id: hh, version_id: v.versionId });
        const id = await link(v.documentId);
        expect(await drawSharePages(deps(), { household_id: hh, share_id: id })).toEqual({
          drawn: 3,
        });
        const counted = await admin.query<{ page_count: number; preview_pages: number }>(
          'select page_count, preview_pages from document_version where id = $1',
          [v.versionId],
        );
        expect(counted.rows[0]).toEqual({ page_count: 3, preview_pages: 3 });

        // Thirty-five frames: thirty drawn, and thirty-five counted, so
        // both ends are told "the first 30 of 35".
        const many = path.join(scratch, 'many.tif');
        await run(bin, ['-size', '200x260', 'xc:white', '-duplicate', '34', `tiff:${many}`]);
        const w = await store(await readFile(many), 'image/tiff');
        await processVersion(deps(), { household_id: hh, version_id: w.versionId });
        await renderVersionPreviews(deps(), { household_id: hh, version_id: w.versionId });
        const cut = await admin.query<{ page_count: number; preview_pages: number }>(
          'select page_count, preview_pages from document_version where id = $1',
          [w.versionId],
        );
        expect(cut.rows[0]).toEqual({ page_count: 35, preview_pages: 30 });
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
    180_000,
  );

  it.skipIf(!drawing)(
    'a drawing that fails part-way leaves nothing behind, and its last try says so (5.18 review)',
    async () => {
      const v = await store(pagesPdf(3), 'application/pdf');
      await renderVersionPreviews(deps(), { household_id: hh, version_id: v.versionId });
      // The vault's own page 2 is gone: the drawing stops there.
      await adapter().delete(previewKey(v.storageKey, 2));
      const id = await link(v.documentId);
      const job = { household_id: hh, share_id: id };
      await expect(drawSharePages(deps(), job, { final: false })).rejects.toThrow();
      // Page 1 was written before it stopped, and is not left behind: no row
      // names it, so nothing else would ever remove it.
      expect(await exists(sharePageKey(v.storageKey, id, 1))).toBe(false);
      expect(await pagesOf(id)).toEqual([]);
      const failed = async () =>
        (
          await admin.query<{ pages_failed_version: string | null }>(
            'select pages_failed_version from share_link where id = $1',
            [id],
          )
        ).rows[0]?.pages_failed_version;
      // Not the last try: the queue will try again.
      expect(await failed()).toBeNull();
      await expect(drawSharePages(deps(), job, { final: true })).rejects.toThrow();
      expect(await exists(sharePageKey(v.storageKey, id, 1))).toBe(false);
      // The last: said on the link, for this version, rather than "being
      // drawn" for ever.
      expect(await failed()).toBe(v.versionId);
    },
    120_000,
  );

  it.skipIf(!drawing)(
    'a link taken back while its pages are drawn keeps none of them (5.18 review)',
    async () => {
      const v = await store(pagesPdf(2), 'application/pdf');
      await renderVersionPreviews(deps(), { household_id: hh, version_id: v.versionId });
      const id = await link(v.documentId);
      // Taken back as the drawing runs: the revoke holds the link's row
      // until it is done, so the drawing starts on the link as it was ...
      const revoker = new pg.Client({ connectionString: tdb.adminUrl });
      await revoker.connect();
      try {
        await revoker.query('begin');
        await revoker.query(
          'update share_link set revoked_at = now(), revoked_by = created_by where id = $1',
          [id],
        );
        const underway = drawSharePages(deps(), { household_id: hh, share_id: id });
        // ... and, its pages written, waits to keep them until the revoke is in.
        for (let i = 0; i < 300; i += 1) {
          const waiting = await admin.query<{ n: number }>(
            `select count(*)::int as n from pg_stat_activity
              where datname = current_database() and wait_event_type = 'Lock'`,
          );
          if ((waiting.rows[0]?.n ?? 0) > 0) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        await revoker.query('commit');
        expect(await underway).toEqual({ drawn: 0 });
      } finally {
        await revoker.end();
      }
      expect(await pagesOf(id)).toEqual([]);
      for (const n of [1, 2]) {
        expect(await exists(sharePageKey(v.storageKey, id, n)), `page ${n}`).toBe(false);
      }
    },
    120_000,
  );

  it('a link to download, or one that has ended, has nothing drawn', async () => {
    const v = await store(pagesPdf(1), 'application/pdf');
    const cases = [
      await link(v.documentId, { permission: 'download' }),
      await link(v.documentId, { ended: 'revoked_at = now(), revoked_by = created_by' }),
      await link(v.documentId, { ended: "expires_at = now() - interval '1 minute'" }),
      await link(v.documentId, { ended: "paused_at = now(), paused_reason = 'restored'" }),
      await link(v.documentId, { ended: 'attempts = 10' }),
    ];
    for (const id of cases) {
      expect(await drawSharePages(deps(), { household_id: hh, share_id: id })).toEqual({
        drawn: 0,
      });
      expect(await pagesOf(id)).toEqual([]);
    }
    // Nor a link to a file the vault cannot draw.
    const word = await store(
      Buffer.from('PK not really a document'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    const id = await link(word.documentId);
    expect(await drawSharePages(deps(), { household_id: hh, share_id: id })).toEqual({
      drawn: 0,
    });
  });

  it("a link's pages go with it", async () => {
    const v = await store(pagesPdf(1), 'application/pdf');
    /** Pages as the worker leaves them: a file each, and a row. */
    const drawn = async (id: string, versionId = v.versionId, storageKey = v.storageKey) => {
      const key = sharePageKey(storageKey, id, 1);
      const enc = new EncryptStream(v.fileKey);
      await Promise.all([
        adapter().put(key, enc),
        pipeline(Readable.from([Buffer.from('a page')]), enc),
      ]);
      await admin.query(
        `insert into share_page (household_id, share_id, document_id, version_id, n, storage_key)
         values ($1, $2, $3, $4, 1, $5)`,
        [hh, id, v.documentId, versionId, key],
      );
      return key;
    };
    const live = await link(v.documentId);
    const taken = await link(v.documentId);
    const lapsed = await link(v.documentId);
    const usedUpOpen = await link(v.documentId);
    const usedUpShut = await link(v.documentId);
    const keysOf = {
      live: await drawn(live),
      taken: await drawn(taken),
      lapsed: await drawn(lapsed),
      usedUpOpen: await drawn(usedUpOpen),
      usedUpShut: await drawn(usedUpShut),
    };
    await admin.query(
      'update share_link set revoked_at = now(), revoked_by = created_by where id = $1',
      [taken],
    );
    await admin.query(
      "update share_link set expires_at = now() - interval '1 minute' where id = $1",
      [lapsed],
    );
    await admin.query('update share_link set max_opens = 2, open_count = 2 where id = any($1)', [
      [usedUpOpen, usedUpShut],
    ]);
    // Opened as often as it allows, but a page opened with it is still open.
    await admin.query(
      `insert into share_session (household_id, share_id, cookie_hash, expires_at)
       values ($1, $2, $3, now() + interval '1 hour')`,
      [hh, usedUpOpen, randomBytes(32)],
    );

    // Taken back: the API asks for that one link's at once.
    expect(
      await pruneSharePages(
        { admin, app: db, credentialsKey, localRoot: vaultDir },
        { household_id: hh, share_id: taken },
      ),
    ).toEqual({ removed: 1 });
    expect(await pagesOf(taken)).toEqual([]);
    expect(await exists(keysOf.taken)).toBe(false);
    expect(await exists(keysOf.lapsed)).toBe(true);

    // And each night, the rest that have ended.
    expect(await pruneSharePages({ admin, app: db, credentialsKey, localRoot: vaultDir })).toEqual({
      removed: 2,
    });
    for (const [name, id, kept] of [
      ['live', live, true],
      ['lapsed', lapsed, false],
      ['used up, a page still open', usedUpOpen, true],
      ['used up, nothing open', usedUpShut, false],
    ] as const) {
      expect((await pagesOf(id)).length, name).toBe(kept ? 1 : 0);
    }
    expect(await exists(keysOf.live)).toBe(true);
    expect(await exists(keysOf.usedUpShut)).toBe(false);

    // A newer version replaces the one the live link's pages were drawn from.
    await store(pagesPdf(1), 'application/pdf', v.documentId, 2);
    expect(await pruneSharePages({ admin, app: db, credentialsKey, localRoot: vaultDir })).toEqual({
      removed: 2,
    });
    expect(await pagesOf(live)).toEqual([]);
    expect(await exists(keysOf.live)).toBe(false);
  });
});
