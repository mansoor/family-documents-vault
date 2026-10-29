import type * as ChildProcess from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { pdfOfJpegs, wholeBufferJpeg } from './jpeg-test-helper.js';

/**
 * Every poppler run capped at 1 GiB of address space (0.8.0-rc.2, from
 * 0.9.0's L2): poppler draws a PDF's JPEGs with libjpeg, unchecked, and a
 * 3 KB PDF holding a progressive CMYK JPEG 16,000 pixels square took about
 * 2 GB to draw for OCR, a thumbnail or previews; an inline one, in
 * pdftotext and `pdfimages -list` too. Capped, it is drawn blank instead.
 * And every Tesseract run, which reads an uploaded photo itself with
 * Leptonica: the same JPEG, sent as a photo, took 2,978 MiB to read.
 */

/** What each tool run is handed, and whether it is only recorded (not run). */
const spy = vi.hoisted(() => ({
  calls: [] as Array<{ bin: string; args: string[] }>,
  fake: false,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof ChildProcess>();
  const { promisify } = await import('node:util');
  const realAsync = promisify(real.execFile);
  const execFile = ((...a: unknown[]) =>
    (real.execFile as (...b: unknown[]) => unknown)(...a)) as unknown as typeof real.execFile;
  // tools.ts promisifies execFile: its promise form is what each run calls.
  Object.defineProperty(execFile, promisify.custom, {
    value: (bin: string, args: string[], opts: object) => {
      spy.calls.push({ bin, args });
      return spy.fake ? Promise.resolve({ stdout: '', stderr: '' }) : realAsync(bin, args, opts);
    },
  });
  return { ...real, default: { ...real, execFile }, execFile };
});

const tools = await import('./tools.js');
const { extractText } = await import('./extract-text.js');
const {
  cappedCommand,
  detectTools,
  ocrImage,
  OCR_MAX_KIB,
  pdfImageCoverage,
  pdfLocked,
  pdfPageCount,
  pdfPageTexts,
  POPPLER_MAX_KIB,
  popplerCommand,
  renderPdfPage,
  renderPdfPages,
  renderPreviews,
  thumbnail,
} = tools;

const POPPLER = ['pdftoppm', 'pdfinfo', 'pdftotext', 'pdfimages'];
const CAP = `ulimit -v ${POPPLER_MAX_KIB} && exec "$0" "$@"`;
const OCR_CAP = `ulimit -v ${OCR_MAX_KIB} && exec "$0" "$@"`;

describe('every poppler and Tesseract run is capped (0.8.0-rc.2)', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'fdv-pdf-cap-'));
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    spy.fake = false;
    spy.calls.length = 0;
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs poppler by sh, its address space capped, on Linux; as it is elsewhere', () => {
    expect(POPPLER_MAX_KIB).toBe(1024 * 1024);
    expect(popplerCommand('pdftoppm', ['-png', 'a b.pdf'], 'linux')).toEqual({
      bin: 'sh',
      args: ['-c', CAP, 'pdftoppm', '-png', 'a b.pdf'],
    });
    expect(popplerCommand('pdftoppm', ['-v'], 'win32')).toEqual({ bin: 'pdftoppm', args: ['-v'] });
    expect(popplerCommand('pdftoppm', ['-v'], 'darwin')).toEqual({ bin: 'pdftoppm', args: ['-v'] });
    expect(OCR_MAX_KIB).toBe(1024 * 1024);
    expect(cappedCommand('tesseract', ['a.png', '-'], OCR_MAX_KIB, 'linux')).toEqual({
      bin: 'sh',
      args: ['-c', OCR_CAP, 'tesseract', 'a.png', '-'],
    });
  });

  it('OCR runs Tesseract through its cap, for a photo and a drawn page alike', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    spy.fake = true;
    await ocrImage(path.join(dir, 'photo.jpg'));
    await ocrImage(path.join(dir, 'page-1.png'), 'eng', undefined, '6');
    expect(spy.calls).toEqual([
      {
        bin: 'sh',
        args: [
          '-c',
          OCR_CAP,
          'tesseract',
          path.join(dir, 'photo.jpg'),
          '-',
          '-l',
          'eng',
          '--psm',
          '3',
        ],
      },
      {
        bin: 'sh',
        args: [
          '-c',
          OCR_CAP,
          'tesseract',
          path.join(dir, 'page-1.png'),
          '-',
          '-l',
          'eng',
          '--psm',
          '6',
        ],
      },
    ]);
  });

  it('each path that runs poppler on a file goes through the cap: page counts, the lock check, text, picture coverage, OCR pages, the thumbnail and previews', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    spy.fake = true;
    const f = path.join(dir, 'any.pdf');
    const out = await mkdtemp(path.join(dir, 'out-'));
    const paths: Record<string, () => Promise<unknown>> = {
      pdfPageCount: () => pdfPageCount(f),
      pdfLocked: () => pdfLocked(f),
      pdfPageTexts: () => pdfPageTexts(f, 5),
      pdfImageCoverage: () => pdfImageCoverage(f, 5),
      renderPdfPages: () => renderPdfPages(f, out, 5),
      renderPdfPage: () => renderPdfPage(f, out, 2),
      thumbnail: () => thumbnail(f, path.join(out, 'thumb.jpg')),
      renderPreviews: () => renderPreviews(f, 'application/pdf', out, 5),
    };
    const seen: Record<string, string[]> = {};
    for (const [name, call] of Object.entries(paths)) {
      spy.calls.length = 0;
      // The fake runs write nothing, so a path may fail after poppler's run.
      await call().catch(() => undefined);
      // Never a poppler tool run as it is.
      expect(
        spy.calls.filter((c) => POPPLER.includes(c.bin)),
        name,
      ).toEqual([]);
      const capped = spy.calls.filter((c) => c.bin === 'sh');
      for (const c of capped) {
        expect(c.args.slice(0, 2), name).toEqual(['-c', CAP]);
        expect(c.args, name).toContain(f);
      }
      seen[name] = capped.map((c) => c.args[2] as string);
    }
    expect(seen).toEqual({
      pdfPageCount: ['pdfinfo'],
      pdfLocked: ['pdfinfo'],
      pdfPageTexts: ['pdftotext'],
      pdfImageCoverage: ['pdfimages', 'pdfinfo'],
      renderPdfPages: ['pdftoppm'],
      renderPdfPage: ['pdftoppm'],
      thumbnail: ['pdftoppm'],
      renderPreviews: ['pdftoppm'],
    });
  });

  it('nothing in the worker or the API runs a poppler tool or Tesseract but through its cap', async () => {
    const roots = ['apps/worker/src', 'apps/api/src'].map((r) =>
      path.resolve(import.meta.dirname, '../../../..', r),
    );
    const direct =
      /\b(?:run|runTool|execFile|execFileAsync|execFileSync|spawn|spawnSync|exec|execSync)\(\s*['"`](?:pdf\w+|tesseract)/;
    const found: string[] = [];
    for (const root of roots) {
      for (const name of await readdir(root, { recursive: true })) {
        if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name.includes('test-helper')) {
          continue;
        }
        const source = await readFile(path.join(root, name), 'utf8');
        if (direct.test(source)) found.push(name);
      }
    }
    expect(found).toEqual([]);
  });
});

/** The pids of every process whose name is one of `names`, with their peak address space so far, in KiB. */
async function peaks(names: string[], into: Map<number, number>): Promise<void> {
  for (const pid of await readdir('/proc').catch(() => [] as string[])) {
    if (!/^\d+$/.test(pid)) continue;
    const status = await readFile(`/proc/${pid}/status`, 'utf8').catch(() => '');
    const name = /^Name:\s+(\S+)/m.exec(status)?.[1] ?? '';
    if (!names.includes(name)) continue;
    const kib = Number(/VmPeak:\s+(\d+)/.exec(status)?.[1] ?? 0);
    into.set(Number(pid), Math.max(into.get(Number(pid)) ?? 0, kib));
  }
}

/**
 * The most address space any run of `names` (poppler's, by default) took
 * while `call` ran, in KiB, and what `call` gave.
 */
async function peakOf<T>(
  call: () => Promise<T>,
  names = POPPLER,
): Promise<{ peakKib: number; result: T | Error }> {
  const seen = new Map<number, number>();
  let polling = true;
  const poll = (async () => {
    while (polling) {
      await peaks(names, seen);
      await new Promise((r) => setTimeout(r, 2));
    }
  })();
  const result = await call().catch((e: Error) => e);
  polling = false;
  await poll;
  return { peakKib: Math.max(0, ...seen.values()), result };
}

const real = await detectTools();

describe.skipIf(process.platform !== 'linux' || !(real.pdftoppm && real.pdfimages && real.magick))(
  'the bomb PDF, with the real tools (0.8.0-rc.2)',
  () => {
    let dir: string;
    const bombs: Record<string, string> = {};
    beforeAll(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'fdv-pdf-bomb-'));
      const prog16 = wholeBufferJpeg(16_000, 16_000, 4);
      const page = { jpeg: prog16, width: 16_000, height: 16_000, components: 4 as const };
      const made = {
        // A picture of its own, 2 MB: drawn for OCR, the thumbnail and previews.
        'xobject.pdf': pdfOfJpegs([page]),
        // In the page's content: pdftotext and pdfimages -list decode it too.
        'inline.pdf': pdfOfJpegs([{ ...page, as: 'inline' }]),
      };
      for (const [name, bytes] of Object.entries(made)) {
        bombs[name] = path.join(dir, name);
        await writeFile(bombs[name], bytes);
      }
      // Deflated as well, the same PDF is 3 KB.
      expect(pdfOfJpegs([{ ...page, as: 'flate' }]).length).toBeLessThan(4_000);
    });
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    // Each capped run still takes 13 to 15 s to draw it blank (37 s for
    // pdftotext's inline one): a 2 MB JPEG's DC scan of 16 million blocks.
    it('is drawn blank within the cap by every path that draws it: OCR pages, the thumbnail, previews', async () => {
      const file = bombs['xobject.pdf']!;
      const draws: Record<string, (out: string) => Promise<unknown>> = {
        renderPdfPage: (out) => renderPdfPage(file, out, 1),
        renderPdfPages: (out) => renderPdfPages(file, out, 5),
        thumbnail: (out) => thumbnail(file, path.join(out, 'thumb.jpg')),
        renderPreviews: (out) => renderPreviews(file, 'application/pdf', out, 5),
      };
      for (const [where, draw] of Object.entries(draws)) {
        const out = await mkdtemp(path.join(dir, 'out-'));
        const { peakKib, result } = await peakOf(() => draw(out));
        // Drawn — blank — not failed.
        expect(result, where).not.toBeInstanceOf(Error);
        // It went for the picture (far past what a blank page takes), and was held to the cap.
        expect(peakKib, where).toBeGreaterThan(256 * 1024);
        expect(peakKib, where).toBeLessThanOrEqual(POPPLER_MAX_KIB);
        // The page drawn for OCR is there, to be read (as nothing).
        if (where === 'renderPdfPage')
          expect((await stat(result as string)).size).toBeGreaterThan(0);
        await rm(out, { recursive: true, force: true });
      }
    }, 300_000);

    it('an inline one read for its text, and its pictures listed, within the cap', async () => {
      const file = bombs['inline.pdf']!;
      for (const [where, call] of Object.entries<() => Promise<unknown>>({
        pdfPageTexts: () => pdfPageTexts(file, 5),
        pdfImageCoverage: () => pdfImageCoverage(file, 5),
        pdfPageCount: () => pdfPageCount(file),
      })) {
        const { peakKib } = await peakOf(call);
        expect(peakKib, where).toBeLessThanOrEqual(POPPLER_MAX_KIB);
        if (where !== 'pdfPageCount') expect(peakKib, where).toBeGreaterThan(256 * 1024);
      }
      expect(await pdfPageCount(file)).toBe(1);
    }, 300_000);
  },
);

describe.skipIf(process.platform !== 'linux' || !real.tesseract)(
  'the same JPEG sent as a photo, read by Tesseract (0.8.0-rc.2)',
  () => {
    let dir: string;
    beforeAll(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'fdv-ocr-bomb-'));
    });
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('is read within the cap: a failed read, not the server’s memory taken', async () => {
      const bomb = path.join(dir, 'photo.jpg');
      await writeFile(bomb, wholeBufferJpeg(16_000, 16_000, 4));
      const started = Date.now();
      const { peakKib, result } = await peakOf(
        () => extractText(bomb, 'image/jpeg', { maxPages: 5, workDir: dir }),
        ['tesseract'],
      );
      // It went for the picture, and was held to the cap.
      expect(peakKib).toBeGreaterThan(256 * 1024);
      expect(peakKib).toBeLessThanOrEqual(OCR_MAX_KIB);
      expect(result).toBeInstanceOf(Error);
      expect(Date.now() - started).toBeLessThan(30_000);
    }, 300_000);

    it.skipIf(!real.magick)(
      'an ordinary photo of a page still reads',
      async () => {
        const photo = path.join(dir, 'page.jpg');
        await tools.runTool(
          'magick',
          [
            '-size',
            '2480x3508',
            'xc:white',
            '-font',
            'DejaVu-Sans',
            '-fill',
            'black',
            '-pointsize',
            '60',
            '-annotate',
            '+200+400',
            'Payment due by 29/04/2026',
            '-quality',
            '85',
            `jpeg:${photo}`,
          ],
          { timeout: 120_000 },
        );
        const got = await extractText(photo, 'image/jpeg', { maxPages: 5, workDir: dir });
        expect(got?.text).toMatch(/Payment due by 29\/04\/2026/);
      },
      300_000,
    );
  },
);
