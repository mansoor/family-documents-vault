import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractText } from './extract-text.js';
import { wholeBufferJpeg } from './jpeg-test-helper.js';
import { PREPARE_MAX_PIXELS } from './scan-read.js';
import {
  cleanForOcr,
  detectTools,
  imageFrames,
  imagePage,
  imagePageCount,
  JPEG_HEADER_MAX_BYTES,
  JPEG_HELD_MAX_COEFFICIENTS,
  jpegFrame,
  PictureRefused,
  prepareScan,
  READ_MAX_SIDE,
  renderPreviews,
  runTool,
  smallTurned,
  squarePhoto,
  thumbnail,
} from './tools.js';

/**
 * The scan steps' limits (0.9.0, R3): every new step that touches a
 * picture's pixels — an upload's pages drawn grey and upright, a small copy
 * turned to try, a page prepared to be read again — is ImageMagick, in its
 * own process, under MAGICK_LIMITS and a timeout. A picture that claims to
 * be bigger than they allow is refused at once, never decoded, and never
 * reaches Tesseract. These need ImageMagick (the worker image's), and skip
 * without it.
 */

const tools = await detectTools();

/** A PNG's size, by ImageMagick 7's `magick identify` or 6's `identify`. */
const sizeOf = async (file: string) => {
  const args = ['-format', '%w %h', `png:${file}`];
  const { stdout } = await runTool('magick', ['identify', ...args]).catch(() =>
    runTool('identify', args),
  );
  return stdout.trim();
};

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = (crcTable[(c ^ x) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** A PNG `w` by `h`, grey, every pixel `shade`: or, with `claim`, a few hundred bytes claiming that size. */
function png(w: number, h: number, opts: { claim?: boolean; shade?: number } = {}): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 0, 0, 0, 0], 8);
  const raw = opts.claim ? Buffer.alloc(4096) : Buffer.alloc((w + 1) * h, opts.shade ?? 255);
  if (!opts.claim) for (let y = 0; y < h; y += 1) raw[y * (w + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe.skipIf(!tools.magick)('the scan steps’ limits (R3)', () => {
  let dir: string;
  let bomb: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'fdv-scan-limits-'));
    bomb = path.join(dir, 'bomb.png');
    // 60,000 pixels square: decoded, tens of gigabytes.
    await writeFile(bomb, png(60_000, 60_000, { claim: true }));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('a picture claiming 60,000 pixels square is refused by every step, at once', async () => {
    for (const step of [
      () => imagePage(bomb, 'image/png', dir, 0),
      () => smallTurned(bomb, 90, path.join(dir, 'small.png')),
      () => prepareScan(bomb, { turn: 180, scale: 3 }, path.join(dir, 'ready.png')),
    ]) {
      const started = Date.now();
      await expect(step()).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(20_000);
    }
  }, 120_000);

  it('an upload claiming it is refused before Tesseract is ever asked to read it', async () => {
    const asked: string[] = [];
    const started = Date.now();
    await expect(
      extractText(bomb, 'image/png', {
        maxPages: 5,
        workDir: dir,
        tools: { ...tools, tesseract: true },
        ocr: async (image) => {
          asked.push(image);
          return '';
        },
      }),
    ).rejects.toBeInstanceOf(PictureRefused);
    expect(asked).toEqual([]);
    expect(Date.now() - started).toBeLessThan(20_000);
    // Said as a refusal, not as a tool that failed.
    await expect(imagePage(bomb, 'image/png', dir, 0)).rejects.toMatchObject({
      code: 'picture_refused',
    });
  }, 120_000);

  it('a JPEG libjpeg holds whole is refused from its header when big: progressive, or each colour in a scan of its own (the R3 re-check)', async () => {
    // Two megabytes, 16,000 pixels square, progressive CMYK: decoded, 2.2 GB
    // of coefficients, whatever size it is decoded at. Over the area: refused.
    // A grey JPEG of one scan, 12,000 square: never held whole, but 144
    // megapixels, over the area, which libjpeg's shrinking hid from
    // ImageMagick: refused. Under it, 8,000 square, but 256 million
    // coefficients held: refused.
    const bombs = {
      'prog-16000-cmyk.jpg': wholeBufferJpeg(16_000, 16_000, 4),
      'base-12000-grey.jpg': wholeBufferJpeg(12_000, 12_000, 1, 'sequential'),
      'prog-8000-cmyk.jpg': wholeBufferJpeg(8_000, 8_000, 4),
      'seq-8000-rgb.jpg': wholeBufferJpeg(8_000, 8_000, 3, 'sequential'),
    };
    for (const [name, bytes] of Object.entries(bombs)) {
      const file = path.join(dir, name);
      await writeFile(file, bytes);
      const started = Date.now();
      await expect(imagePage(file, 'image/jpeg', dir, 0), name).rejects.toBeInstanceOf(
        PictureRefused,
      );
      expect(Date.now() - started, name).toBeLessThan(10_000);
    }
    expect(await jpegFrame(path.join(dir, 'base-12000-grey.jpg'))).toMatchObject({ held: false });
    expect(await jpegFrame(path.join(dir, 'seq-8000-rgb.jpg'))).toEqual({
      width: 8_000,
      height: 8_000,
      coefficients: 192_000_000,
      held: true,
    });
    // Never handed to Tesseract.
    const asked: string[] = [];
    await expect(
      extractText(path.join(dir, 'prog-16000-cmyk.jpg'), 'image/jpeg', {
        maxPages: 5,
        workDir: dir,
        tools: { ...tools, tesseract: true },
        ocr: async (image) => {
          asked.push(image);
          return '';
        },
      }),
    ).rejects.toBeInstanceOf(PictureRefused);
    expect(asked).toEqual([]);
    // At the most it may hold, it is read: 4,000 square in CMYK is 64 million.
    const held = path.join(dir, 'prog-4000-cmyk.jpg');
    await writeFile(held, wholeBufferJpeg(4_000, 4_000, 4));
    expect(await jpegFrame(held)).toMatchObject({ coefficients: JPEG_HELD_MAX_COEFFICIENTS });
    expect(await sizeOf(await imagePage(held, 'image/jpeg', dir, 0))).toBe('4000 4000');
  }, 120_000);

  it('every path that decodes an uploaded JPEG refuses one libjpeg would hold whole, or whose header hides past what is read (R3, round four)', async () => {
    // 16,000 square: refused on every path by its size already. 11,000 and
    // 8,000 square fit the area, and were read: a person's photo at 961 MiB,
    // a thumbnail or previews at 498 MiB and 977 MiB on disk. And 8,000
    // square behind 100,001 empty segments, which the check read past no
    // further than that before, failing open: a page read at 879 MiB. And
    // 8,000 square behind 2 MiB and more of segments, past what is read of
    // it: it cannot be told, so it is refused (failing closed).
    const bombs = {
      'prog-16000-cmyk.jpg': wholeBufferJpeg(16_000, 16_000, 4),
      'prog-11000-cmyk.jpg': wholeBufferJpeg(11_000, 11_000, 4),
      'prog-8000-cmyk.jpg': wholeBufferJpeg(8_000, 8_000, 4),
      'app-8000-cmyk.jpg': wholeBufferJpeg(8_000, 8_000, 4, 'progressive', {
        appSegments: 100_001,
      }),
      'long-8000-cmyk.jpg': wholeBufferJpeg(8_000, 8_000, 4, 'progressive', {
        appSegments: 33,
        appSize: 65_533,
      }),
    };
    expect(bombs['long-8000-cmyk.jpg'].length).toBeGreaterThan(JPEG_HEADER_MAX_BYTES);
    const paths = {
      page: (f: string, out: string) => imagePage(f, 'image/jpeg', out, 0),
      photo: (f: string, out: string) =>
        squarePhoto(f, 'image/jpeg', null, path.join(out, 'square.jpg')),
      thumbnail: (f: string, out: string) => thumbnail(f, path.join(out, 'thumb.jpg')),
      previews: (f: string, out: string) => renderPreviews(f, 'image/jpeg', out, 5),
    };
    for (const [name, bytes] of Object.entries(bombs)) {
      const file = path.join(dir, `path-${name}`);
      await writeFile(file, bytes);
      for (const [where, decode] of Object.entries(paths)) {
        // The 16,000 square photo is refused by squarePhoto's own size check, as before.
        if (where === 'photo' && name === 'prog-16000-cmyk.jpg') continue;
        const out = await mkdtemp(path.join(dir, `${where}-`));
        const started = Date.now();
        await expect(decode(file, out), `${where} ${name}`).rejects.toBeInstanceOf(PictureRefused);
        expect(Date.now() - started, `${where} ${name}`).toBeLessThan(10_000);
      }
    }
    await expect(
      squarePhoto(
        path.join(dir, 'path-prog-16000-cmyk.jpg'),
        'image/jpeg',
        null,
        path.join(dir, 's.jpg'),
      ),
    ).rejects.toThrow(/bigger than a photo may be/);
    // An ordinary JPEG still makes each.
    const plain = path.join(dir, 'path-plain.jpg');
    const draw = ['-size', '1200x900', 'xc:white', '-quality', '85', `jpeg:${plain}`];
    await runTool('magick', draw).catch(() => runTool('convert', draw));
    for (const decode of Object.values(paths)) {
      await decode(plain, await mkdtemp(path.join(dir, 'plain-')));
    }
  }, 300_000);

  it('a small PNG of a big picture is refused at once, never spilled to disk (the R3 re-check)', async () => {
    // 11,000 pixels square of white: about a hundred kilobytes.
    const big = path.join(dir, 'white-11000.png');
    await writeFile(big, png(11_000, 11_000));
    const work = await mkdtemp(path.join(dir, 'white-'));
    const started = Date.now();
    await expect(imagePage(big, 'image/png', work, 0)).rejects.toBeInstanceOf(PictureRefused);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 120_000);

  it('a wide photo is decoded no bigger than it is: its shrink asked for in its own proportions (the R3 re-check)', async () => {
    // 8,000 by 2,000 in CMYK: shrunk to a square 4,700 across, libjpeg would
    // have drawn it 16,000 by 4,000, and it was refused.
    const wide = path.join(dir, 'wide.jpg');
    const draw = ['-size', '8000x2000', 'xc:white', '-colorspace', 'CMYK', `jpeg:${wide}`];
    await runTool('magick', draw).catch(() => runTool('convert', draw));
    const page = await imagePage(wide, 'image/jpeg', dir, 0);
    const [w = 0, h = 0] = (await sizeOf(page)).split(' ').map(Number);
    expect(w).toBeLessThanOrEqual(READ_MAX_SIDE);
    expect(Math.abs(w / h - 4)).toBeLessThan(0.05);
  }, 120_000);

  it('S5 cleans a page as big as a photo’s without making it bigger than PREPARE_MAX_PIXELS (the R3 re-check)', async () => {
    const page = path.join(dir, 'page-4700.png');
    await writeFile(page, png(4_700, 4_700, { shade: 230 }));
    const out = path.join(dir, 'page-4700-clean.png');
    await cleanForOcr(page, out);
    const [w = 0, h = 0] = (await sizeOf(out)).split(' ').map(Number);
    expect(w * h).toBeLessThanOrEqual(PREPARE_MAX_PIXELS);
    expect(w).toBe(4_700);
    // A small page is still made twice the size.
    const small = path.join(dir, 'page-small.png');
    await writeFile(small, png(1_000, 1_400, { shade: 230 }));
    await cleanForOcr(small, out);
    expect(await sizeOf(out)).toBe('2000 2800');
  }, 120_000);

  it('counting a TIFF’s pages stops when its read is told to (the R3 re-check)', async () => {
    const tiff = path.join(dir, 'count.tif');
    const frames = ['xc:white', 'xc:gray90', 'xc:white'].flatMap((c) => ['-size', '300x200', c]);
    await runTool('magick', [...frames, `tiff:${tiff}`]).catch(() =>
      runTool('convert', [...frames, `tiff:${tiff}`]),
    );
    expect(await imageFrames(tiff, 'image/tiff')).toBe(3);
    await expect(imageFrames(tiff, 'image/tiff', AbortSignal.abort())).rejects.toThrow();
    await expect(imagePageCount(tiff, 'image/tiff', 5, AbortSignal.abort())).rejects.toThrow();
  }, 120_000);

  it('a phone’s 108 megapixel photo is read, shrunk as it is decoded (the R3 review)', async () => {
    const big = path.join(dir, 'big.jpg');
    const draw = [
      '-size',
      '12000x9000',
      'xc:white',
      '-font',
      'DejaVu-Sans',
      '-fill',
      'black',
      '-pointsize',
      '250',
      '-annotate',
      '+600+1500',
      'Payment due by 29/04/2026',
      '-annotate',
      '+600+2200',
      'Statement date 18 May 2026',
      '-type',
      'TrueColor',
      '-quality',
      '85',
      `jpeg:${big}`,
    ];
    await runTool('magick', draw, { timeout: 300_000 }).catch(() =>
      runTool('convert', draw, { timeout: 300_000 }),
    );
    const work = await mkdtemp(path.join(dir, 'big-'));
    const got = await extractText(big, 'image/jpeg', { maxPages: 5, workDir: work });
    expect(got?.text).toMatch(/Payment due by +29\/04\/2026/);
    // Its spill stays in the job's own folder, and goes with the page.
    expect((await readdir(work)).filter((f) => f.endsWith('.png'))).toEqual([]);
  }, 600_000);

  it('a scanner’s TIFF is drawn a page at a time as it is read, and each page let go after (the R3 review)', async () => {
    const tiff = path.join(dir, 'pages.tif');
    const frames = ['xc:white', 'xc:gray90', 'xc:white'].flatMap((c) => ['-size', '300x200', c]);
    await runTool('magick', [...frames, `tiff:${tiff}`]).catch(() =>
      runTool('convert', [...frames, `tiff:${tiff}`]),
    );
    const work = await mkdtemp(path.join(dir, 'tiff-'));
    const seen: string[][] = [];
    const got = await extractText(tiff, 'image/tiff', {
      maxPages: 5,
      workDir: work,
      ocr: async (image) => {
        seen.push((await readdir(work)).filter((f) => f.endsWith('.png')).sort());
        return `page ${path.basename(image)}: these words read well enough`;
      },
    });
    expect(got?.ocrPages).toBe(3);
    // Each page alone in the folder as it is read: never the next, nor the last.
    expect(seen).toEqual([['photo-1.png'], ['photo-2.png'], ['photo-3.png']]);
    expect((await readdir(work)).filter((f) => f.endsWith('.png'))).toEqual([]);
  }, 120_000);

  it('a photo bigger than a page is read no bigger than READ_MAX_SIDE', async () => {
    const big = path.join(dir, 'big.png');
    await writeFile(big, png(6_000, 1_000));
    const page = await imagePage(big, 'image/png', dir, 0);
    const [w, h] = (await sizeOf(page)).split(' ').map(Number);
    expect(w).toBe(READ_MAX_SIDE);
    expect(h).toBeLessThanOrEqual(Math.ceil((1_000 * READ_MAX_SIDE) / 6_000));
  }, 120_000);

  it('a phone photo is turned upright by its EXIF orientation before it is read', async () => {
    // A 120×40 JPEG whose EXIF says to turn it a quarter (6, RightTop).
    const jpeg = path.join(dir, 'turned.jpg');
    const made = path.join(dir, 'plain.jpg');
    await writeFile(path.join(dir, 'plain.png'), png(120, 40, { shade: 200 }));
    await runTool('magick', [`png:${path.join(dir, 'plain.png')}`, `jpeg:${made}`]).catch(() =>
      runTool('convert', [`png:${path.join(dir, 'plain.png')}`, `jpeg:${made}`]),
    );
    const plain = await readFile(made);
    const tiff = Buffer.from('49492a00080000000100120103000100000006000000000000', 'hex');
    const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
    const app1 = Buffer.from([0xff, 0xe1, 0, 0]);
    app1.writeUInt16BE(payload.length + 2, 2);
    await writeFile(jpeg, Buffer.concat([plain.subarray(0, 2), app1, payload, plain.subarray(2)]));
    const page = await imagePage(jpeg, 'image/jpeg', dir, 0);
    expect(await sizeOf(page)).toBe('40 120');
  }, 120_000);

  it('a page made three times bigger stays within the limits, and is made', async () => {
    const page = path.join(dir, 'page.png');
    await writeFile(page, png(1_240, 1_754, { shade: 230 }));
    const out = path.join(dir, 'page-ready.png');
    // Turned a quarter (and straightened, which may widen it a pixel or two), three times bigger.
    await prepareScan(page, { turn: 90, scale: 3 }, out);
    const [w, h] = (await sizeOf(out)).split(' ').map(Number);
    expect(Math.abs((w as number) - 1_754 * 3)).toBeLessThanOrEqual(12);
    expect(Math.abs((h as number) - 1_240 * 3)).toBeLessThanOrEqual(12);
    // Made no bigger than three times, whatever is asked, and turned back no more than 45°.
    await prepareScan(page, { turn: 0, angle: 0, scale: 50, clean: true }, out);
    expect(await sizeOf(out)).toBe(`${1_240 * 3} ${1_754 * 3}`);
  }, 120_000);
});
