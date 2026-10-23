import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractText } from './extract-text.js';
import { CLEAN_BELOW_CONF, parseTsvPage, readingQuality } from './scan-read.js';
import { detectTools, ocrImage, ocrTsv, osdOf } from './tools.js';

/**
 * Scans read better, with the worker's real tools (0.9.0, R3): a page
 * upside down, a page photographed in a shadow and a crooked page — drawn
 * by the scan set's own script (scripts/scan-corpus.mjs) — each read by
 * `extractText` as the vault reads it, and each beside what Tesseract alone
 * makes of it, as the vault read scans before. They need Tesseract,
 * ImageMagick and poppler (the worker image's), and skip without them.
 */

const tools = await detectTools();
const real = tools.tesseract && tools.magick && tools.pdftoppm;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

interface Look {
  dpi: number;
  paper: number;
  inkDark: number;
  noise?: number;
  quarter?: 0 | 90 | 180 | 270;
  angle?: number;
  light?: Record<string, number>;
}
interface Shot {
  gray: Uint8Array;
  w: number;
  h: number;
  dpi: number;
}
interface Scripts {
  Page: new (o?: { size?: number }) => {
    line(t: string | string[], o?: { size?: number; bold?: boolean }): unknown;
    row(cols: Array<[number, string]>): unknown;
    gap(n?: number): unknown;
    foot(): unknown;
  };
  randomFor(seed: string | number, name: string): unknown;
  spoil(page: unknown, family: string, look: Look, r: unknown): Shot;
  grayPng(s: Shot): Buffer;
  grayJpeg(s: Shot, quality: number): Buffer;
  picturePdf(s: Shot[], quality: number | null): Buffer;
}

describe.skipIf(!real)('scans read better, with the real tools (R3)', () => {
  let dir: string;
  let s: Scripts;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'fdv-scan-real-'));
    const load = (rel: string) => import(pathToFileURL(path.join(ROOT, rel)).href);
    s = {
      ...((await load('scripts/smart-corpus-render.mjs')) as object),
      ...((await load('scripts/scan-corpus.mjs')) as object),
    } as Scripts;
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A made-up bill, its due date beside its label, a column apart. */
  const bill = () => {
    const pg = new s.Page({ size: 10.5 });
    pg.line('BRIGHTWATER ENERGY', { size: 17, bold: true });
    pg.line('Your electricity bill', { size: 12 });
    pg.row([
      [56, 'Account number'],
      [330, '8820 4417 3391'],
    ]);
    pg.gap();
    pg.line(['Mrs Olivia Khan', '14 Elm Street', 'Ashby Vale', 'AV4 7QT']);
    pg.gap();
    pg.line('Billing period 14 March 2026 to 13 April 2026');
    pg.row([
      [56, 'Electricity used'],
      [330, '663 kWh'],
    ]);
    pg.row([
      [56, 'Amount due'],
      [330, '£124.97'],
    ]);
    pg.row([
      [56, 'Payment due by'],
      [330, '29/04/2026'],
    ]);
    pg.gap();
    pg.line('Questions about your bill? Call 01632 960 220.', { size: 9 });
    pg.foot();
    return pg;
  };
  const draw = (look: Look, seed: string) =>
    s.spoil(bill(), 'sans', { noise: 0.02, ...look }, s.randomFor('scan-real', seed));
  const read = async (name: string, bytes: Buffer, mime: string) => {
    const file = path.join(dir, name);
    await writeFile(file, bytes);
    const work = await mkdtemp(path.join(dir, 'work-'));
    const got = await extractText(file, mime, { maxPages: 5, workDir: work });
    return { file, text: got?.text ?? '' };
  };

  it('a page upside down is read the right way up', async () => {
    const { file, text } = await read(
      'upside-down.png',
      s.grayPng(draw({ dpi: 200, paper: 0.95, inkDark: 0.9, quarter: 180 }, 'upside-down')),
      'image/png',
    );
    expect(text).toMatch(/Payment due by +29\/04\/2026/);
    // Tesseract alone, as before: the page's words are not there.
    expect(await ocrImage(file)).not.toMatch(/Payment due/);
  }, 300_000);

  it('a page turned a quarter, in a PDF, is read the right way up', async () => {
    const { text } = await read(
      'sideways.pdf',
      s.picturePdf([draw({ dpi: 200, paper: 0.95, inkDark: 0.9, quarter: 90 }, 'sideways')], 80),
      'application/pdf',
    );
    expect(text).toMatch(/Payment due by +29\/04\/2026/);
  }, 300_000);

  it('a photo in a shadow is evened out and read', async () => {
    const shadow = { slope: 0.3, dx: 0.6, dy: 0.4, cx: 1, cy: 1, radius: 0.9, depth: 0.55 };
    const { file, text } = await read(
      'shadow.jpg',
      s.grayJpeg(draw({ dpi: 200, paper: 0.8, inkDark: 0.45, light: shadow }, 'shadow'), 85),
      'image/jpeg',
    );
    expect(text).toMatch(/Payment due by +29\/04\/2026/);
    expect(await ocrImage(file)).not.toMatch(/Payment due by\s+29\/04\/2026/);
  }, 300_000);

  it.skipIf(!tools.osd)(
    'Tesseract’s orientation model says the turn that stands each way up upright (the R3 review)',
    async () => {
      for (const quarter of [90, 180, 270] as const) {
        const shot = draw({ dpi: 200, paper: 0.95, inkDark: 0.9, quarter }, `osd-${quarter}`);
        const file = path.join(dir, `osd-${quarter}.png`);
        await writeFile(file, s.grayPng(shot));
        // Turned a quarter clockwise, it is stood up by three more: what -rotate makes.
        expect((await osdOf(file))?.turn).toBe((360 - quarter) % 360);
      }
    },
    300_000,
  );

  it('a big photo read unsurely is read again within the limits, and never loses its reading (the R3 review)', async () => {
    // About 3000 by 4200 pixels, grainy and faint: its first reading unsure,
    // so it would be cleaned at twice its size — 50 megapixels, which
    // ImageMagick's limits refuse, or take past their minute.
    const shot = draw({ dpi: 360, paper: 0.85, inkDark: 0.5, noise: 0.16 }, 'big-unsure');
    expect(shot.w * shot.h).toBeGreaterThan(12_000_000);
    const { file, text } = await read('big-unsure.png', s.grayPng(shot), 'image/png');
    const first = readingQuality(parseTsvPage(await ocrTsv(file)).words);
    expect(first.conf).toBeLessThan(CLEAN_BELOW_CONF);
    expect(text).toMatch(/Payment due by/);
  }, 600_000);

  it('a crooked page is straightened, its label and value on one line', async () => {
    const { text } = await read(
      'crooked.pdf',
      s.picturePdf([draw({ dpi: 200, paper: 0.95, inkDark: 0.9, angle: -6.5 }, 'crooked')], 80),
      'application/pdf',
    );
    expect(text).toMatch(/Payment due by +29\/04\/2026/);
    expect(text).toMatch(/Account number +8820 4417 3391/);
  }, 300_000);
});
