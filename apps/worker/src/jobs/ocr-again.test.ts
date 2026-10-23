import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { columnsApart, extractText, OCR_AGAIN_WORDS, wordsIn } from './extract-text.js';
import { detectTools, ocrImage, renderPdfPage } from './tools.js';

/**
 * A grainy scan read again, cleaned (0.8.0, S5): the Smart exit's corpus
 * had low-resolution, speckled scans Tesseract read nothing of — "L" for a
 * vet's certificate — which, enlarged and with each pixel the median of its
 * neighbours, it reads whole. Only a page that gave next to no words is
 * read again, and the reading with more words is kept. The scans are drawn
 * by the corpus's own renderer (scripts/smart-corpus-render.mjs); the tests
 * with the real tools need poppler, ImageMagick and Tesseract, and skip
 * without them.
 */

const tools = await detectTools();
const real = Boolean(tools.pdftoppm && tools.magick && tools.tesseract);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

interface Render {
  Page: new (o?: { size?: number }) => {
    line(text: string | string[], o?: { size?: number; bold?: boolean }): unknown;
    row(cols: Array<[number, string]>, o?: { bold?: boolean }): unknown;
  };
  scanPdf: (pages: unknown[], family: string, looks: unknown[], r: unknown) => Buffer;
  textPdf: (pages: unknown[], family: string) => Buffer;
  randomFor: (seed: number, name: string) => unknown;
}
const render = async () =>
  (await import(
    /* @vite-ignore */ pathToFileURL(path.join(ROOT, 'scripts/smart-corpus-render.mjs')).href
  )) as Render;

/** A vet's certificate, as the corpus writes one. */
async function certificate(look: Record<string, unknown> | null): Promise<Buffer> {
  const { Page, scanPdf, textPdf, randomFor } = await render();
  const pg = new Page({ size: 10 });
  pg.line('Willowbank Veterinary Surgery', { size: 15, bold: true });
  pg.line('Vaccination Certificate', { size: 12 });
  pg.line(["Pet's name: Biscuit", 'Microchip: 981089922335896', 'Owner: Mrs Sara Khan']);
  pg.row([
    [56, 'Feline enteritis and flu'],
    [250, '14/03/2025'],
    [380, '14/03/2026'],
  ]);
  pg.line('Vet: Ms R Okonkwo MRCVS');
  return look ? scanPdf([pg], 'serif', [look], randomFor(1, 'ocr-again')) : textPdf([pg], 'sans');
}

/** A grainy, crooked scan at 110 dpi: the corpus's "poor" scanner. */
const GRAINY = {
  dpi: 110,
  angle: -1.2,
  paper: 0.95,
  inkDark: 0.8,
  noise: 0.1,
  specks: 600,
  shadow: false,
  mono: false,
  offsetX: 0,
  offsetY: 0,
};

describe('a scan read again, cleaned (S5)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'fdv-ocr-again-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('counts words, not specks', () => {
    expect(wordsIn('L')).toBe(0);
    expect(wordsIn("ST IR NS RO ol ',y.,e,);: tgj")).toBe(0);
    expect(wordsIn('Willowbank Veterinary Surgery Vaccination Certificate')).toBe(5);
    expect(OCR_AGAIN_WORDS).toBe(3);
  });

  it.skipIf(!tools.pdftoppm)(
    'a page that gave next to no words is cleaned and read again; the reading with more words is kept',
    async () => {
      const file = path.join(dir, 'grainy.pdf');
      await writeFile(file, await certificate(GRAINY));
      const asked: string[] = [];
      const cleaned: Array<[string, string]> = [];
      const got = await extractText(file, 'application/pdf', {
        maxPages: 5,
        workDir: dir,
        tools: { ...tools, magick: true, tesseract: true },
        ocr: (image) => {
          asked.push(path.basename(image));
          return Promise.resolve(
            image.endsWith('-clean.png')
              ? 'Willowbank Veterinary Surgery Vaccination Certificate'
              : 'L',
          );
        },
        clean: async (image, output) => {
          cleaned.push([path.basename(image), path.basename(output)]);
        },
      });
      expect(cleaned).toEqual([['page-1.png', 'page-1-clean.png']]);
      expect(asked).toEqual(['page-1.png', 'page-1-clean.png']);
      expect(got?.text).toBe('Willowbank Veterinary Surgery Vaccination Certificate');
    },
  );

  it.skipIf(!tools.pdftoppm)(
    'a page read well is never read again; a blank one keeps its first reading',
    async () => {
      const file = path.join(dir, 'clean.pdf');
      await writeFile(file, await certificate({ ...GRAINY, dpi: 200, noise: 0.01, specks: 0 }));
      const cleaned: string[] = [];
      const clean = async (image: string) => {
        cleaned.push(image);
      };
      const well = await extractText(file, 'application/pdf', {
        maxPages: 5,
        workDir: dir,
        tools: { ...tools, magick: true, tesseract: true },
        ocr: () => Promise.resolve('Willowbank Veterinary Surgery Vaccination Certificate Owner'),
        clean,
      });
      expect(cleaned).toEqual([]);
      expect(well?.text).toContain('Willowbank');
      // Nothing either time: the first reading stands, and the page is blank.
      const blank = await extractText(file, 'application/pdf', {
        maxPages: 5,
        workDir: dir,
        tools: { ...tools, magick: true, tesseract: true },
        ocr: (image) => Promise.resolve(image.endsWith('-clean.png') ? "ol ',y.,e" : ''),
        clean,
      });
      expect(cleaned).toHaveLength(1);
      expect(blank?.text).toBe('');
      // Without ImageMagick, nothing is cleaned.
      cleaned.length = 0;
      await extractText(file, 'application/pdf', {
        maxPages: 5,
        workDir: dir,
        tools: { ...tools, magick: false, tesseract: true },
        ocr: () => Promise.resolve('L'),
        clean,
      });
      expect(cleaned).toEqual([]);
    },
    // Three pages drawn by poppler: a busy machine takes more than the default.
    60_000,
  );

  it.skipIf(!real)(
    'with the real tools: a grainy scan Tesseract reads nothing of is read once cleaned',
    async () => {
      const file = path.join(dir, 'real.pdf');
      await writeFile(file, await certificate(GRAINY));
      // As drawn, Tesseract 5.5 (the worker image's) reads next to nothing of it.
      const page = await renderPdfPage(file, dir, 1, 150);
      const raw = wordsIn(await ocrImage(page));
      const got = await extractText(file, 'application/pdf', { maxPages: 5, workDir: dir, tools });
      expect(wordsIn(got?.text ?? '')).toBeGreaterThanOrEqual(Math.max(OCR_AGAIN_WORDS, raw));
      expect(got?.text).toMatch(/Veterinary/);
      expect(got?.text).toMatch(/Certificate/);
    },
    120_000,
  );
});

/**
 * A form read column by column, read again row by row (0.8.0, S5): a
 * scanned card statement or insurance schedule that Tesseract read as a
 * run of labels and then, far below, a run of values. Only such a page is
 * read again (--psm 6), and the row-by-row reading is kept where its
 * labels and values are no longer apart.
 */
describe('a form read column by column, read again by rows (S5)', () => {
  const APART = [
    'Lantern Card',
    'Statement date',
    'Card number ending',
    'Previous balance',
    'Payment due',
    'Credit limit',
    '18 August 2026',
    '4929',
    '£429.79',
    '12 September 2026',
  ].join('\n');
  const ROWS = [
    'Lantern Card',
    'Statement date 18 August 2026',
    'Card number ending 4929',
    'Previous balance £429.79',
    'Payment due 12 September 2026',
    'Credit limit £4,500.00',
  ].join('\n');

  it('tells a form read by columns from one read by rows, or a letter', () => {
    expect(columnsApart(APART)).toBe(true);
    expect(columnsApart(ROWS)).toBe(false);
    expect(
      columnsApart('Dear Mrs Khan,\nYour results are normal.\nYours sincerely,\nDr H Marsh'),
    ).toBe(false);
  });

  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'fdv-ocr-rows-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.skipIf(!tools.pdftoppm)(
    'only a page read by columns is read again, and the rows kept where they read better',
    async () => {
      const file = path.join(dir, 'card.pdf');
      await writeFile(file, await certificate({ ...GRAINY, dpi: 200, noise: 0.01, specks: 0 }));
      const opts = (first: string, rows: string, asked: string[]) => ({
        maxPages: 5,
        workDir: dir,
        tools: { ...tools, magick: false, tesseract: true },
        ocr: () => Promise.resolve(first),
        ocrRows: (image: string) => {
          asked.push(path.basename(image));
          return Promise.resolve(rows);
        },
      });
      const asked: string[] = [];
      const read = await extractText(file, 'application/pdf', opts(APART, ROWS, asked));
      expect(asked).toEqual(['page-1.png']);
      expect(read?.text).toBe(ROWS);
      // Still apart by rows: the first reading stands.
      const still = await extractText(file, 'application/pdf', opts(APART, APART, []));
      expect(still?.text).toBe(APART);
      // Read by rows already: never read again.
      const none: string[] = [];
      await extractText(file, 'application/pdf', opts(ROWS, APART, none));
      expect(none).toEqual([]);
    },
  );
});
