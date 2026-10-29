import type * as ChildProcess from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDeflate } from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { pdfOfJpegs, wholeBufferJpeg } from './jpeg-test-helper.js';

/**
 * Every Tesseract run capped at 1 GiB of address space, as every poppler
 * run is (0.9.0, from 0.8.0-rc.2). Tesseract reads a page with Leptonica,
 * which has no limits of its own: a 750 KB PNG of nothing 16,000 pixels
 * square took 2,672 MiB to read. A photo reaches it only drawn by
 * `imagePage`, under ImageMagick's limits (R3), which refuses that PNG
 * first; the cap is what holds wherever a picture reaches it otherwise.
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
  atLowPriority,
  cappedCommand,
  detectTools,
  OCR_MAX_KIB,
  ocrImage,
  ocrTsv,
  osdOf,
  PictureRefused,
  POPPLER_MAX_KIB,
  popplerCommand,
} = tools;

const OCR_CAP = `ulimit -v ${OCR_MAX_KIB} && exec "$0" "$@"`;

describe('every Tesseract run is capped (0.9.0)', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    spy.fake = false;
    spy.calls.length = 0;
  });

  it('caps a tool by sh at the address space asked, poppler’s by default; as it is elsewhere', () => {
    expect(OCR_MAX_KIB).toBe(1024 * 1024);
    expect(cappedCommand('tesseract', ['a.png', '-'], { maxKib: OCR_MAX_KIB }, 'linux')).toEqual({
      bin: 'sh',
      args: ['-c', OCR_CAP, 'tesseract', 'a.png', '-'],
    });
    expect(popplerCommand('pdftoppm', ['-v'], {}, 'linux').args[1]).toBe(
      `ulimit -v ${POPPLER_MAX_KIB} && exec "$0" "$@"`,
    );
    expect(cappedCommand('tesseract', ['a.png'], { maxKib: OCR_MAX_KIB }, 'win32')).toEqual({
      bin: 'tesseract',
      args: ['a.png'],
    });
  });

  it('each reading runs Tesseract through its cap: the words, read whole or by rows, their table, and which way up', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    spy.fake = true;
    const page = path.join(tmpdir(), 'page-1.png');
    const reads: Record<string, () => Promise<unknown>> = {
      ocrImage: () => ocrImage(page),
      'ocrImage by rows': () => ocrImage(page, 'eng', undefined, '6'),
      ocrTsv: () => ocrTsv(page),
      osdOf: () => osdOf(page),
    };
    const seen: Record<string, string[][]> = {};
    for (const [name, read] of Object.entries(reads)) {
      spy.calls.length = 0;
      await read().catch(() => undefined);
      seen[name] = spy.calls.map((c) => [c.bin, ...c.args.slice(0, 3)]);
    }
    const capped = ['sh', '-c', OCR_CAP, 'tesseract'];
    expect(seen).toEqual({
      ocrImage: [capped],
      'ocrImage by rows': [capped],
      ocrTsv: [capped],
      osdOf: [capped],
    });
  });

  it('at low priority (the Reading check), niced and capped both', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    spy.fake = true;
    await atLowPriority(() => ocrTsv(path.join(tmpdir(), 'page-1.png')));
    expect(spy.calls.map((c) => [c.bin, ...c.args.slice(0, 5)])).toEqual([
      ['nice', '-n', '19', 'sh', '-c', OCR_CAP],
    ]);
  });

  it('nothing in the worker or the API runs Tesseract but through its cap', async () => {
    const roots = ['apps/worker/src', 'apps/api/src'].map((r) =>
      path.resolve(import.meta.dirname, '../../../..', r),
    );
    const direct =
      /\b(?:run|runTool|execFile|execFileAsync|execFileSync|spawn|spawnSync|exec|execSync)\(\s*['"`]tesseract/;
    const found: string[] = [];
    for (const root of roots) {
      for (const name of await readdir(root, { recursive: true })) {
        if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name.includes('test-helper')) {
          continue;
        }
        if (direct.test(await readFile(path.join(root, name), 'utf8'))) found.push(name);
      }
    }
    expect(found).toEqual([]);
  });
});

/**
 * The peak address space, in KiB, of every Tesseract run on a file under
 * `under` while `call` ran, and what it gave. Only those: the other test
 * files run Tesseract at the same time (CI's image-tests job), and theirs
 * are not this test's.
 */
async function peakOf<T>(
  call: () => Promise<T>,
  under: string,
): Promise<{ peakKib: number; result: T | Error }> {
  let peakKib = 0;
  let polling = true;
  const poll = (async () => {
    while (polling) {
      for (const pid of await readdir('/proc').catch(() => [] as string[])) {
        if (!/^\d+$/.test(pid)) continue;
        const status = await readFile(`/proc/${pid}/status`, 'utf8').catch(() => '');
        if (!/^Name:\s+tesseract$/m.test(status)) continue;
        const args = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
        if (args.split('\0').some((arg) => arg.startsWith(under))) {
          peakKib = Math.max(peakKib, Number(/VmPeak:\s+(\d+)/.exec(status)?.[1] ?? 0));
        }
      }
      await new Promise((r) => setTimeout(r, 2));
    }
  })();
  const result = await call().catch((e: Error) => e);
  polling = false;
  await poll;
  return { peakKib, result };
}

/** A PNG of nothing, `side` pixels square, RGB: 750 KB at 16,000. */
async function pngOfNothing(side: number): Promise<Buffer> {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = (table[(c ^ x) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(body));
    return Buffer.concat([head, body, tail]);
  };
  // Deflated a slab of rows at a time: never the whole picture in memory.
  const z = createDeflate({ level: 9 });
  const out: Buffer[] = [];
  z.on('data', (d: Buffer) => out.push(d));
  const done = new Promise((resolve) => z.on('end', resolve));
  const slab = Buffer.alloc((1 + side * 3) * 100);
  for (let rows = 0; rows < side; rows += 100) {
    const n = Math.min(100, side - rows);
    if (!z.write(n === 100 ? slab : slab.subarray(0, (1 + side * 3) * n))) {
      await new Promise((r) => z.once('drain', r));
    }
  }
  z.end();
  await done;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', Buffer.concat(out)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const real = await detectTools();

/**
 * The real-tool tests need the worker image's tools — Alpine's Tesseract 5.5
 * and ImageMagick 7 — on Linux: CI's image-tests job, FDV_IMAGE_PARITY=1.
 * Elsewhere they differ (Ubuntu's older Tesseract gives up on the PNG at
 * 81 MiB; its ImageMagick 6 has no `magick`), and are skipped.
 */
const parity = process.platform === 'linux' && process.env.FDV_IMAGE_PARITY === '1';

describe.runIf(parity)('the worker image’s tools are all here (FDV_IMAGE_PARITY)', () => {
  it('poppler, ImageMagick and Tesseract', () => {
    expect(real).toMatchObject({ pdftoppm: true, pdfimages: true, magick: true, tesseract: true });
  });
});

describe.runIf(parity)(
  'pictures that would reach Tesseract big, with the real tools (0.9.0)',
  () => {
    let dir: string;
    let bomb: string;
    beforeAll(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'fdv-ocr-cap-'));
      bomb = path.join(dir, 'nothing.png');
      const png = await pngOfNothing(16_000);
      expect(png.length).toBeLessThan(1_000_000);
      await writeFile(bomb, png);
    }, 120_000);
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('sent as a photo, is refused before Tesseract sees it (R3: imagePage)', async () => {
      const { peakKib, result } = await peakOf(
        () => extractText(bomb, 'image/png', { maxPages: 5, workDir: dir }),
        dir,
      );
      expect(result).toBeInstanceOf(PictureRefused);
      expect(peakKib).toBe(0);
    });

    it('handed to Tesseract itself, is read within the cap: a failed read, not the server’s memory taken', async () => {
      const started = Date.now();
      // Without ImageMagick a photo goes to Tesseract as it is; and every reading's run.
      for (const [how, read] of Object.entries<() => Promise<unknown>>({
        'a photo, no ImageMagick': () =>
          extractText(bomb, 'image/png', {
            maxPages: 5,
            workDir: dir,
            tools: { ...real, magick: false },
          }),
        ocrTsv: () => ocrTsv(bomb),
        osdOf: () => osdOf(bomb),
      })) {
        const { peakKib, result } = await peakOf(read, dir);
        // It went for the picture (far past what a page takes), and was held to the cap.
        expect(peakKib, how).toBeGreaterThan(256 * 1024);
        expect(peakKib, how).toBeLessThanOrEqual(OCR_MAX_KIB);
        expect(result, how).toBeInstanceOf(Error);
      }
      expect(Date.now() - started).toBeLessThan(60_000);
    }, 300_000);

    it('a PDF of one page 100 inches square, drawn for OCR as the PDF says, is read within the cap', async () => {
      // 3 KB; pdftoppm draws it 15,000 pixels square within its own cap,
      // and Tesseract took 2,354 MiB to read that, uncapped.
      const big = path.join(dir, 'big-page.pdf');
      await writeFile(
        big,
        pdfOfJpegs([
          {
            jpeg: wholeBufferJpeg(8, 8, 1, 'sequential'),
            width: 8,
            height: 8,
            components: 1,
            place: [20, 20],
            size: [7200, 7200],
          },
        ]),
      );
      const { peakKib, result } = await peakOf(
        () => extractText(big, 'application/pdf', { maxPages: 5, workDir: dir }),
        dir,
      );
      expect(peakKib).toBeGreaterThan(256 * 1024);
      expect(peakKib).toBeLessThanOrEqual(OCR_MAX_KIB);
      expect(result).toBeInstanceOf(Error);
    }, 300_000);

    it('an ordinary photo of a page still reads', async () => {
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
    }, 300_000);
  },
);
