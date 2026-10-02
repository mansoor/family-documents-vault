import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { deriveKey, EncryptStream, EnvKeyProvider, newKey, ScopeKeys, wrapKey } from '@fdv/crypto';
import { createDb, createPool, withSystem, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import { LocalAdapter, readAll } from '@fdv/storage';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { previewKey, renderVersionPreviews } from './previews.js';
import { decryptToBuffer, processVersion } from './process-version.js';
import { drawSharePages, pruneSharePages, sharePageKey, watermarkText } from './share-pages.js';
import {
  detectTools,
  hasPango,
  magickText,
  watermarkLine,
  watermarkPage,
  watermarkSizes,
} from './tools.js';

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

/** How many pixels of an image's foot band are ink (anything not near white). */
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
    '%[fx:mean*w*h]',
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

/**
 * A scanner's TIFF, built by hand: `frames` pages of `width`×`height` 8-bit
 * RGB, uncompressed, each page's directory pointing at one shared run of
 * pixels (a colour gradient), so the file is one page's size however many
 * pages it has, while every page decodes to its full size.
 */
function scannedTiff(
  frames: number,
  width: number,
  height: number,
  /** Each frame's PageNumber tag (297): its number and the pages in all, when set. */
  pageNumber?: (frame: number) => [number, number],
): Buffer {
  const pixels = width * height * 3;
  const data = Buffer.alloc(pixels);
  for (let y = 0; y < height; y += 1) {
    const row = y * width * 3;
    for (let x = 0; x < width; x += 1) {
      data[row + x * 3] = (x * 255) / width;
      data[row + x * 3 + 1] = (y * 255) / height;
      data[row + x * 3 + 2] = 160;
    }
  }
  const entries = pageNumber ? 14 : 13;
  const ifdSize = 2 + entries * 12 + 4;
  const extra = 6 + 16; // BitsPerSample, then two resolutions
  const start = 8 + pixels;
  const out = Buffer.alloc(start + frames * (ifdSize + extra));
  out.write('II', 0, 'latin1');
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(start, 4);
  data.copy(out, 8);
  for (let f = 0; f < frames; f += 1) {
    const at = start + f * (ifdSize + extra);
    const bits = at + ifdSize;
    const xres = bits + 6;
    const yres = xres + 8;
    out.writeUInt16LE(entries, at);
    const tags: Array<[number, number, number, number]> = [
      [256, 4, 1, width], // ImageWidth
      [257, 4, 1, height], // ImageLength
      [258, 3, 3, bits], // BitsPerSample -> 8,8,8
      [259, 3, 1, 1], // no compression
      [262, 3, 1, 2], // RGB
      [273, 4, 1, 8], // the pixels
      [277, 3, 1, 3], // three samples a pixel
      [278, 4, 1, height], // one strip
      [279, 4, 1, pixels],
      [282, 5, 1, xres], // 300 dpi
      [283, 5, 1, yres],
      [284, 3, 1, 1], // chunky
      [296, 3, 1, 2], // inches
    ];
    if (pageNumber) {
      const [n, of] = pageNumber(f);
      tags.push([297, 3, 2, n + of * 65536]); // PageNumber: two SHORTs
    }
    tags.forEach(([tag, type, count, value], i) => {
      const e = at + 2 + i * 12;
      out.writeUInt16LE(tag, e);
      out.writeUInt16LE(type, e + 2);
      out.writeUInt32LE(count, e + 4);
      if (type === 3 && count === 1) out.writeUInt16LE(value, e + 8);
      else if (type === 3 && count === 2) {
        out.writeUInt16LE(value % 65536, e + 8);
        out.writeUInt16LE(Math.floor(value / 65536), e + 10);
      } else out.writeUInt32LE(value, e + 8);
    });
    out.writeUInt32LE(
      f + 1 < frames ? start + (f + 1) * (ifdSize + extra) : 0,
      at + 2 + entries * 12,
    );
    for (let s = 0; s < 3; s += 1) out.writeUInt16LE(8, bits + s * 2);
    out.writeUInt32LE(300, xres);
    out.writeUInt32LE(1, xres + 4);
    out.writeUInt32LE(300, yres);
    out.writeUInt32LE(1, yres + 4);
  }
  return out;
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
 * Arabic and emoji. A machine without the fonts draws what it can.
 */
const everyScript =
  tools.magick &&
  (await hasPango()) &&
  (await fontFor('zh')) &&
  (await fontFor('hi')) &&
  (await fontFor('ar'));
/**
 * The worker image's own image tools: ImageMagick 7 with pango, the image's
 * fonts, tesseract — what CI's image-tests job installs, and says so with
 * FDV_IMAGE_PARITY=1. What OCR reads back of the mark, and where exactly a
 * line in a given script falls, depend on the ImageMagick and the fonts
 * that drew it: elsewhere (ubuntu-latest's ImageMagick 6 and stock fonts)
 * the mark is drawn, legibly to a person, but OCR reads it otherwise (the
 * third review). Those checks run only there, and say why they are skipped
 * elsewhere; everything else — drawn, counted, stored, served — runs
 * everywhere.
 */
const parity = process.env.FDV_IMAGE_PARITY === '1';
const NOT_PARITY =
  "needs the worker image's ImageMagick 7, fonts and tesseract: set FDV_IMAGE_PARITY=1 where they are (CI's image-tests job does)";
/** A label made of what ImageMagick and pango would read as their own. */
const LOOK_ALIKES = '100% %[fx:1] <b>x</b> &amp; @/etc/hostname';

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

  /**
   * A link's page as the link shows it, cut to the page's own edges (the
   * band at its foot off: what a crop to the page keeps), beside the vault's
   * own page — both as files in `dir` — and the page's size.
   */
  async function pageAsShown(
    v: Awaited<ReturnType<typeof store>>,
    row: { n: number; storage_key: string },
    dir: string,
  ) {
    const own = await decryptToBuffer(adapter(), previewKey(v.storageKey, row.n), v.fileKey);
    const marked = await decryptToBuffer(adapter(), row.storage_key, v.fileKey);
    const { width, height } = jpegSize(own);
    const ownFile = path.join(dir, `own${row.n}.jpg`);
    const markedFile = path.join(dir, `marked${row.n}.jpg`);
    const pageFile = path.join(dir, `page${row.n}.png`);
    await writeFile(ownFile, own);
    await writeFile(markedFile, marked);
    await run(await magickBin(), [
      `jpeg:${markedFile}`,
      '-crop',
      `${width}x${height}+0+0`,
      '+repage',
      `png:${pageFile}`,
    ]);
    return { own, marked, ownFile, pageFile, width, height };
  }

  /**
   * A white page 1236 by 1600 watermarked for `label` where the system's
   * ImageMagick reads no @file (Debian's and Ubuntu's stock rule): the page
   * as drawn, in `dir`.
   */
  async function markedUnderPolicy(dir: string, label: string): Promise<string> {
    const policies = path.join(dir, 'policy');
    await mkdir(policies);
    await writeFile(
      path.join(policies, 'policy.xml'),
      '<policymap><policy domain="path" rights="none" pattern="@*"/></policymap>\n',
    );
    const page = path.join(dir, 'page.jpg');
    await run(await magickBin(), ['-size', '1236x1600', 'xc:white', `jpeg:${page}`]);
    const out = path.join(dir, 'out.jpg');
    const was = process.env.MAGICK_CONFIGURE_PATH;
    process.env.MAGICK_CONFIGURE_PATH = policies;
    try {
      await watermarkPage(
        page,
        out,
        watermarkText({ recipient_label: label, created_at: new Date('2026-09-27') }, 'UTC'),
      );
    } finally {
      if (was === undefined) delete process.env.MAGICK_CONFIGURE_PATH;
      else process.env.MAGICK_CONFIGURE_PATH = was;
    }
    return out;
  }

  it("has every tool the worker image's checks need, where FDV_IMAGE_PARITY=1 says so (third review)", async ({
    skip,
  }) => {
    skip(!parity, NOT_PARITY);
    // So that none of those checks is skipped here for want of a tool.
    expect({
      magick7: (await magickBin()) === 'magick',
      pdftoppm: tools.pdftoppm,
      tesseract: tools.tesseract,
      everyScript,
    }).toEqual({ magick7: true, pdftoppm: true, tesseract: true, everyScript: true });
  });

  it('sizes the mark to the page, and on a strip to its height (second review; the third)', () => {
    // A page: by its width, a forty-fourth of it; the foot line a forty-eighth.
    expect(watermarkSizes(1236, 1600)).toEqual({ mark: 28, foot: 26 });
    // A strip 1600 by 200: by its width the mark would be 36 pixels, too big
    // for a whole one to cross it; by its height, 20.
    expect(watermarkSizes(1600, 200)).toEqual({ mark: 20, foot: 33 });
    // Any strip: min(width / 44, 3 × height / 30), rounded.
    for (const [w, h] of [
      [1600, 150],
      [2000, 300],
      [900, 120],
      [3000, 250],
    ] as const) {
      expect(watermarkSizes(w, h).mark, `${w}x${h}`).toBe(
        Math.round(Math.min(w / 44, (3 * h) / 30)),
      );
    }
    // Never under 10 pixels, nor over 44; the foot line 12 to 40.
    expect(watermarkSizes(1600, 60).mark).toBe(10);
    expect(watermarkSizes(60, 60)).toEqual({ mark: 10, foot: 12 });
    expect(watermarkSizes(4000, 6000)).toEqual({ mark: 44, foot: 40 });
  });

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
      const scratch = await mkdtemp(path.join(tmpdir(), 'fdv-sp-every-'));
      try {
        for (const r of rows) {
          expect(r.storage_key).toBe(sharePageKey(v.storageKey, id, r.n));
          expect(r.version_id).toBe(v.versionId);
          const shown = await pageAsShown(v, r, scratch);
          const { own, marked } = shown;
          // A picture, and not the vault's own page: the same width, and
          // taller by the band along its foot.
          expect(marked.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
          expect(marked.equals(own)).toBe(false);
          const b = jpegSize(marked);
          expect(b.width, `page ${r.n}`).toBe(shown.width);
          expect(b.height, `page ${r.n}`).toBeGreaterThan(shown.height);
          expect(marked.includes(Buffer.from('Exif'))).toBe(false);
          // The page itself, the band at its foot cut off: what a crop to the
          // page's own edges keeps (5.18 review). The mark is across all of
          // it, corners included. (What it says, read back, is the next test.)
          for (const [where, region] of Object.entries(corners(shown.width, shown.height))) {
            expect(
              await markedShare(`jpeg:${shown.ownFile}`, `png:${shown.pageFile}`, region),
              `page ${r.n}, ${where}`,
            ).toBeGreaterThan(0.002);
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

  it('the mark on every page says whom it is for, where a reader, or a machine, can see (5.18 review)', async ({
    skip,
  }) => {
    skip(!parity, NOT_PARITY);
    const v = await store(pagesPdf(3), 'application/pdf');
    const id = await link(v.documentId, { label: 'the letting agent' });
    expect(await drawSharePages(deps(), { household_id: hh, share_id: id })).toEqual({
      drawn: 3,
    });
    const scratch = await mkdtemp(path.join(tmpdir(), 'fdv-sp-ocr-'));
    try {
      for (const r of await pagesOf(id)) {
        const { pageFile } = await pageAsShown(v, r, scratch);
        // Read level (the mark rises at 30 degrees), in its own colour.
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
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 180_000);

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

  it('a label in Chinese, Korean, Devanagari, Arabic or with emoji is drawn, not left out (5.18 review)', async ({
    skip,
  }) => {
    // The worker image's fonts, and how much ink each draws.
    skip(!parity, NOT_PARITY);
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
  }, 120_000);

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
      // The vault's own page 2 is gone (kept aside, to be put back): the
      // drawing stops there.
      const page2 = previewKey(v.storageKey, 2);
      const kept2 = await readAll(await adapter().get(page2));
      await adapter().delete(page2);
      const id = await link(v.documentId);
      const job = { household_id: hh, share_id: id };
      await expect(drawSharePages(deps(), job, { final: false })).rejects.toThrow();
      // Page 1 was written before it stopped, and is not left behind: no row
      // names it, so nothing else would ever remove it.
      expect(await exists(sharePageKey(v.storageKey, id, 1))).toBe(false);
      expect(await pagesOf(id)).toEqual([]);
      // What the link says of its pages that could not be drawn: a version,
      // and when (share_page_failure, 0042; 0041 kept it on the link).
      const failed = async () =>
        (
          await admin.query<{ version: string | null; at: Date | null }>(
            `select (select version_id from share_page_failure where share_id = $1) as version,
                    (select failed_at from share_page_failure where share_id = $1) as at`,
            [id],
          )
        ).rows[0];
      // Not the last try: the queue will try again.
      expect(await failed()).toEqual({ version: null, at: null });
      await expect(drawSharePages(deps(), job, { final: true })).rejects.toThrow();
      expect(await exists(sharePageKey(v.storageKey, id, 1))).toBe(false);
      // The last: said on the link, for this version, and when — so that an
      // hour on it is asked for again (the third review).
      const said = await failed();
      expect(said?.version).toBe(v.versionId);
      expect(said?.at).not.toBeNull();
      expect(Math.abs(Date.now() - (said?.at?.getTime() ?? 0))).toBeLessThan(60_000);
      // Drawn at last: the failure is cleared, version and time both.
      await adapter().put(page2, Readable.from([kept2]));
      expect(await drawSharePages(deps(), job)).toEqual({ drawn: 3 });
      expect(await failed()).toEqual({ version: null, at: null });
    },
    120_000,
  );

  it.skipIf(!drawing)(
    'a first drawing that fails with the database gone still removes what it wrote (third review)',
    async () => {
      const v = await store(pagesPdf(3), 'application/pdf');
      await renderVersionPreviews(deps(), { household_id: hh, version_id: v.versionId });
      await adapter().delete(previewKey(v.storageKey, 2));
      const id = await link(v.documentId);
      // The database answers the drawing's first two questions, and then no
      // more: the connection is lost as the drawing fails.
      let asked = 0;
      const failing = new Proxy(db, {
        get(target, prop) {
          if (prop === 'transaction') {
            asked += 1;
            if (asked > 2) {
              return () => ({
                execute: () => Promise.reject(new Error('Connection terminated unexpectedly')),
              });
            }
          }
          const value = Reflect.get(target, prop, target) as unknown;
          return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
        },
      });
      await expect(
        drawSharePages({ ...deps(), db: failing }, { household_id: hh, share_id: id }),
      ).rejects.toThrow();
      expect(asked).toBeGreaterThan(2);
      // Page 1 was written, and is gone: no row could ever have named it.
      expect(await exists(sharePageKey(v.storageKey, id, 1))).toBe(false);
    },
    120_000,
  );

  /**
   * A collection's link to view (5.19): the documents it was made with, in
   * a collection for everybody, the link to view made by the owner.
   */
  async function collectionLink(documents: string[], ticked: string[]) {
    const c = await admin.query<{ id: string }>(
      `insert into doc_collection (household_id, name, audience, owner_member_id)
       values ($1, 'For the valuer', 'everyone', $2) returning id`,
      [hh, memberId],
    );
    const collectionId = c.rows[0]?.id as string;
    for (const [i, doc] of documents.entries()) {
      await admin.query(
        `insert into doc_collection_item (collection_id, document_id, household_id, position)
         values ($1, $2, $3, $4)`,
        [collectionId, doc, hh, i + 1],
      );
    }
    const l = await admin.query<{ id: string }>(
      `insert into share_link (household_id, collection_id, token_hash, created_by, expires_at,
                               permission, recipient_label, created_at)
       values ($1, $2, $3, $4, now() + interval '7 days', 'view', 'the valuer',
               '2026-09-27T10:00:00Z') returning id`,
      [hh, collectionId, randomBytes(32), accountId],
    );
    const id = l.rows[0]?.id as string;
    for (const [i, doc] of ticked.entries()) {
      await admin.query(
        `insert into share_link_item (share_id, household_id, collection_id, document_id, position)
         values ($1, $2, $3, $4, $5)`,
        [id, hh, collectionId, doc, i + 1],
      );
    }
    return { id, collectionId };
  }
  const pagesByDocument = async (shareId: string) =>
    (
      await admin.query<{ document_id: string; n: number }>(
        'select document_id, count(*)::int as n from share_page where share_id = $1 group by 1',
        [shareId],
      )
    ).rows;

  it('a collection’s link draws nothing for what it does not give (5.19)', async () => {
    const a = await store(pagesPdf(1), 'application/pdf');
    const left = await store(pagesPdf(1), 'application/pdf');
    const { id, collectionId } = await collectionLink(
      [a.documentId, left.documentId],
      [a.documentId],
    );
    // Named by the job, a version of a document the link was not made with
    // is not drawn: the database gives the link no such version.
    expect(
      await drawSharePages(deps(), { household_id: hh, share_id: id, version_id: left.versionId }),
    ).toEqual({ drawn: 0 });
    // Nor anything at all once the collection is deleted.
    await admin.query('update doc_collection set deleted_at = now() where id = $1', [collectionId]);
    expect(await drawSharePages(deps(), { household_id: hh, share_id: id })).toEqual({ drawn: 0 });
    expect(await pagesByDocument(id)).toEqual([]);
  });

  it.skipIf(!drawing)(
    'a collection’s link to view has each document it gives drawn, and only those (5.19)',
    async () => {
      const a = await store(pagesPdf(2), 'application/pdf');
      const b = await store(pagesPdf(1), 'application/pdf');
      const left = await store(pagesPdf(1), 'application/pdf');
      const { id } = await collectionLink(
        [a.documentId, b.documentId, left.documentId],
        [a.documentId, b.documentId],
      );
      expect(await drawSharePages(deps(), { household_id: hh, share_id: id })).toEqual({
        drawn: 3,
      });
      const drawn = await pagesByDocument(id);
      expect(Object.fromEntries(drawn.map((d) => [d.document_id, d.n]))).toEqual({
        [a.documentId]: 2,
        [b.documentId]: 1,
      });
      // Each is kept beside its own version, marked for whom it is for.
      const [first] = await pagesOf(id);
      expect(first?.storage_key).toMatch(new RegExp(`\\.share-${id}\\.p\\d\\.enc$`));
      // Asked for one version, that one; already drawn, nothing twice.
      expect(
        await drawSharePages(deps(), { household_id: hh, share_id: id, version_id: b.versionId }),
      ).toEqual({ drawn: 1 });
      // A newer version of one: drawn again, that document's older pages go,
      // and the other's stay.
      const newer = await store(pagesPdf(1), 'application/pdf', a.documentId, 2);
      expect(
        await drawSharePages(deps(), {
          household_id: hh,
          share_id: id,
          version_id: newer.versionId,
        }),
      ).toEqual({ drawn: 1 });
      expect(
        Object.fromEntries((await pagesByDocument(id)).map((d) => [d.document_id, d.n])),
      ).toEqual({ [a.documentId]: 1, [b.documentId]: 1 });
      expect(await exists(sharePageKey(a.storageKey, id, 2))).toBe(false);
      expect(await exists(sharePageKey(b.storageKey, id, 1))).toBe(true);

      // One whose drawing fails is cleaned up after, and said — on the last
      // try — for its version and when, as a document's link's is; the
      // other document's pages are drawn all the same.
      const broken = await store(pagesPdf(2), 'application/pdf');
      await renderVersionPreviews(deps(), { household_id: hh, version_id: broken.versionId });
      const page2 = previewKey(broken.storageKey, 2);
      const kept2 = await readAll(await adapter().get(page2));
      await adapter().delete(page2);
      const second = await collectionLink(
        [broken.documentId, b.documentId],
        [broken.documentId, b.documentId],
      );
      const failures = async () =>
        (
          await admin.query<{ document_id: string; version_id: string; failed_at: Date }>(
            'select document_id, version_id, failed_at from share_page_failure where share_id = $1',
            [second.id],
          )
        ).rows;
      const job = { household_id: hh, share_id: second.id };
      await expect(drawSharePages(deps(), job, { final: false })).rejects.toThrow();
      expect(await failures()).toEqual([]);
      await expect(drawSharePages(deps(), job, { final: true })).rejects.toThrow();
      // Page 1 of the broken one was written before it stopped, and is gone.
      expect(await exists(sharePageKey(broken.storageKey, second.id, 1))).toBe(false);
      expect(
        Object.fromEntries((await pagesByDocument(second.id)).map((d) => [d.document_id, d.n])),
      ).toEqual({ [b.documentId]: 1 });
      const said = await failures();
      expect(said.map(({ document_id, version_id }) => ({ document_id, version_id }))).toEqual([
        { document_id: broken.documentId, version_id: broken.versionId },
      ]);
      expect(Math.abs(Date.now() - (said[0]?.failed_at.getTime() ?? 0))).toBeLessThan(60_000);
      // Drawn at last, when it is asked for again: the failure is over.
      await adapter().put(page2, Readable.from([kept2]));
      expect(await drawSharePages(deps(), job)).toEqual({ drawn: 3 });
      expect(await failures()).toEqual([]);
      expect(
        Object.fromEntries((await pagesByDocument(second.id)).map((d) => [d.document_id, d.n])),
      ).toEqual({ [broken.documentId]: 2, [b.documentId]: 1 });
    },
    180_000,
  );

  it('the mark on every page of a collection’s link says whom it is for, to a machine too (5.19)', async ({
    skip,
  }) => {
    skip(!parity, NOT_PARITY);
    const a = await store(pagesPdf(2), 'application/pdf');
    const b = await store(pagesPdf(1), 'application/pdf');
    const { id } = await collectionLink([a.documentId, b.documentId], [a.documentId, b.documentId]);
    expect(await drawSharePages(deps(), { household_id: hh, share_id: id })).toEqual({
      drawn: 3,
    });
    const scratch = await mkdtemp(path.join(tmpdir(), 'fdv-sp-ocr-c-'));
    try {
      const rows = (
        await admin.query<{ document_id: string; n: number; storage_key: string }>(
          'select document_id, n, storage_key from share_page where share_id = $1 order by 1, 2',
          [id],
        )
      ).rows;
      expect(rows).toHaveLength(3);
      for (const r of rows) {
        const v = r.document_id === a.documentId ? a : b;
        const dir = await mkdtemp(path.join(scratch, 'doc-'));
        const { pageFile } = await pageAsShown(v, r, dir);
        const level = path.join(dir, `level${r.n}.png`);
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
        expect(stdout, `${r.document_id} page ${r.n}`).toMatch(/valuer/i);
        expect(stdout, `${r.document_id} page ${r.n}`).toMatch(/2026/);
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 180_000);

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

  it.skipIf(!drawing)(
    'keeping its pages does not wait on a document following the link, nor it on them (5.19 second review)',
    async () => {
      const v = await store(pagesPdf(1), 'application/pdf');
      await renderVersionPreviews(deps(), { household_id: hh, version_id: v.versionId });
      const id = await link(v.documentId);
      // A collection's addition holds each link that follows it as this:
      // against its going, and nothing else (collections/service.ts).
      const adding = new pg.Client({ connectionString: tdb.adminUrl });
      await adding.connect();
      let keeping: Promise<unknown> | undefined;
      try {
        await adding.query('begin');
        await adding.query('select id from share_link where id = $1 for key share', [id]);
        keeping = drawSharePages(deps(), { household_id: hh, share_id: id });
        const outcome = await Promise.race([
          keeping,
          new Promise((res) => setTimeout(() => res('waited on the addition'), 20_000)),
        ]);
        expect(outcome).toEqual({ drawn: 1 });
      } finally {
        await adding.query('rollback').catch(() => undefined);
        await adding.end();
        await keeping?.catch(() => undefined);
      }
    },
    120_000,
  );

  it.skipIf(!drawing)(
    'a redraw that fails part-way leaves the pages it was redrawing, which are still shown (second review)',
    async () => {
      const v = await store(pagesPdf(3), 'application/pdf');
      await renderVersionPreviews(deps(), { household_id: hh, version_id: v.versionId });
      const id = await link(v.documentId);
      expect(await drawSharePages(deps(), { household_id: hh, share_id: id })).toEqual({
        drawn: 3,
      });
      const kept = await pagesOf(id);
      // Asked to draw them again (a restore, or a page gone from storage),
      // and failing at page 2: page 1 is written where the kept page 1 is.
      await adapter().delete(previewKey(v.storageKey, 2));
      await expect(
        drawSharePages(deps(), { household_id: hh, share_id: id, redraw: true }, { final: false }),
      ).rejects.toThrow();
      // Every page a row names is still there, and still opens.
      expect(await pagesOf(id)).toEqual(kept);
      for (const r of kept) {
        expect(await exists(r.storage_key), `page ${r.n}`).toBe(true);
        const jpeg = await decryptToBuffer(adapter(), r.storage_key, v.fileKey);
        expect(jpeg.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])), `page ${r.n}`).toBe(
          true,
        );
      }
    },
    120_000,
  );

  it.skipIf(!drawing)(
    'a 20-page colour scan at 300 dpi, as a TIFF, is counted from its headers and drawn page by page (second review)',
    async () => {
      const v = await store(scannedTiff(20, 2480, 3508), 'image/tiff');
      await processVersion(deps(), { household_id: hh, version_id: v.versionId });
      await renderVersionPreviews(deps(), { household_id: hh, version_id: v.versionId });
      const got = await admin.query<{ page_count: number; preview_pages: number; state: string }>(
        `select page_count, preview_pages, preview_state as state
           from document_version where id = $1`,
        [v.versionId],
      );
      expect(got.rows[0]).toEqual({ page_count: 20, preview_pages: 20, state: 'ready' });
    },
    300_000,
  );

  it.skipIf(!drawing)(
    "a TIFF's pages are counted as frames, whatever its PageNumber tags say (third review)",
    async () => {
      /** Stored, processed and drawn: how many pages it has, and how many were drawn. */
      const counted = async (tiff: Buffer) => {
        const v = await store(tiff, 'image/tiff');
        await processVersion(deps(), { household_id: hh, version_id: v.versionId });
        await renderVersionPreviews(deps(), { household_id: hh, version_id: v.versionId });
        return (
          await admin.query<{ page_count: number; preview_pages: number; state: string }>(
            `select page_count, preview_pages, preview_state as state
               from document_version where id = $1`,
            [v.versionId],
          )
        ).rows[0];
      };
      // A scanner that numbers its pages from 1.
      expect(await counted(scannedTiff(4, 300, 400, (f) => [f + 1, 4]))).toEqual({
        page_count: 4,
        preview_pages: 4,
        state: 'ready',
      });
      // One page, numbered 1 of 1; and page 3 of 4, split out of a scan.
      for (const numbered of [[1, 1] as const, [2, 4] as const]) {
        expect(
          await counted(scannedTiff(1, 300, 400, () => [numbered[0], numbered[1]])),
          numbered.join(' of '),
        ).toEqual({ page_count: 1, preview_pages: 1, state: 'ready' });
      }
    },
    180_000,
  );

  it.skipIf(!tools.magick)(
    "a watermark is drawn where the system's ImageMagick refuses @files (second review)",
    async () => {
      const scratch = await mkdtemp(path.join(tmpdir(), 'fdv-sp-policy-'));
      try {
        const out = await markedUnderPolicy(scratch, LOOK_ALIKES);
        // Drawn, whichever ImageMagick: the page, and the band below it with
        // the foot line on it.
        const drawn = await readFile(out);
        expect(drawn.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
        const { width, height } = jpegSize(drawn);
        expect(width).toBe(1236);
        expect(height).toBeGreaterThan(1600);
        expect(await footInk(out, height - 1600)).toBeGreaterThan(100);
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it("a label's look-alikes are drawn as they were typed, read back (second review)", async ({
    skip,
  }) => {
    skip(!parity, NOT_PARITY);
    const bin = await magickBin();
    const scratch = await mkdtemp(path.join(tmpdir(), 'fdv-sp-typed-'));
    try {
      const out = await markedUnderPolicy(scratch, LOOK_ALIKES);
      // The foot line, read back: every look-alike drawn as it was typed.
      const { height } = jpegSize(await readFile(out));
      const foot = path.join(scratch, 'foot.png');
      await run(bin, [
        `jpeg:${out}`,
        '-gravity',
        'south',
        '-crop',
        `0x${height - 1600}+0+0`,
        '+repage',
        '-resize',
        '200%',
        `png:${foot}`,
      ]);
      const { stdout } = await run('tesseract', [foot, '-', '--psm', '7'], {
        timeout: 60_000,
      });
      expect(stdout).toContain('<b>x</b>');
      expect(stdout).toContain('&amp;');
      expect(stdout).toContain('%[fx:1]');
      expect(stdout).toContain('@/etc/hostname');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 120_000);

  it("an Arabic label's foot line fits its band, and covers none of the page (second review)", async ({
    skip,
  }) => {
    // Where the band's edge falls, to the pixel, with the image's Arabic font.
    skip(!parity, NOT_PARITY);
    const bin = await magickBin();
    const scratch = await mkdtemp(path.join(tmpdir(), 'fdv-sp-foot-'));
    try {
      const page = path.join(scratch, 'black.jpg');
      await run(bin, ['-size', '1236x1600', 'xc:black', `jpeg:${page}`]);
      const out = path.join(scratch, 'out.jpg');
      await watermarkPage(
        page,
        out,
        watermarkText(
          { recipient_label: 'أحمد علي کے', created_at: new Date('2026-09-27') },
          'UTC',
        ),
      );
      // The last rows of the page itself, just above the band: dark, with
      // nothing of the band's white laid over them.
      const { stdout } = await run(bin, [
        `jpeg:${out}`,
        '-crop',
        '1236x30+0+1570',
        '+repage',
        '-colorspace',
        'gray',
        '-threshold',
        '90%',
        '-format',
        '%[fx:mean]',
        'info:',
      ]);
      expect(Number(stdout.trim())).toBeLessThan(0.01);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 120_000);

  it.skipIf(!drawing)(
    'a strip or a small page has a whole mark across it, not the gap between marks (second review)',
    async () => {
      const bin = await magickBin();
      const scratch = await mkdtemp(path.join(tmpdir(), 'fdv-sp-strip-'));
      const text = watermarkText(
        { recipient_label: 'the letting agent', created_at: new Date('2026-09-27') },
        'UTC',
      );
      try {
        // A strip: the mark across its page area (what it says, read back,
        // is the next test).
        const strip = path.join(scratch, 'strip.jpg');
        await run(bin, ['-size', '1600x200', 'xc:white', `jpeg:${strip}`]);
        const out = path.join(scratch, 'strip-out.jpg');
        await watermarkPage(strip, out, text);
        const drawn = jpegSize(await readFile(out));
        expect(drawn.width).toBe(1600);
        expect(drawn.height).toBeGreaterThan(200);
        expect(
          await markedShare(`jpeg:${strip}`, `jpeg:${out}`, { x: 0, y: 0, w: 1600, h: 200 }),
        ).toBeGreaterThan(0.005);
        // A page sixty pixels square carries some of the mark.
        const tiny = path.join(scratch, 'tiny.jpg');
        await run(bin, ['-size', '60x60', 'xc:white', `jpeg:${tiny}`]);
        const tinyOut = path.join(scratch, 'tiny-out.jpg');
        await watermarkPage(tiny, tinyOut, text);
        expect(
          await markedShare(`jpeg:${tiny}`, `jpeg:${tinyOut}`, { x: 0, y: 0, w: 60, h: 60 }),
        ).toBeGreaterThan(0.01);
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it("a strip's mark says whom it is for, read level (second review)", async ({ skip }) => {
    skip(!parity, NOT_PARITY);
    const bin = await magickBin();
    const scratch = await mkdtemp(path.join(tmpdir(), 'fdv-sp-strip-ocr-'));
    try {
      const strip = path.join(scratch, 'strip.jpg');
      await run(bin, ['-size', '1600x200', 'xc:white', `jpeg:${strip}`]);
      const out = path.join(scratch, 'strip-out.jpg');
      await watermarkPage(
        strip,
        out,
        watermarkText(
          { recipient_label: 'the letting agent', created_at: new Date('2026-09-27') },
          'UTC',
        ),
      );
      const level = path.join(scratch, 'level.png');
      await run(bin, [
        `jpeg:${out}`,
        '-crop',
        '1600x200+0+0',
        '+repage',
        '-background',
        'white',
        '-rotate',
        '30',
        '-colorspace',
        'gray',
        '-threshold',
        '80%',
        '-resize',
        '200%',
        `png:${level}`,
      ]);
      const { stdout } = await run('tesseract', [level, '-', '--psm', '6'], { timeout: 60_000 });
      expect(stdout).toMatch(/letting\W{0,3}agent/i);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 120_000);

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
