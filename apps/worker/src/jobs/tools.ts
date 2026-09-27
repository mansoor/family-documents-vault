import { execFile } from 'node:child_process';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The three command-line tools the worker image ships: poppler
 * (pdftoppm, pdfinfo), ImageMagick (magick) and Tesseract. Wrapped so the
 * rest of the worker never builds a shell command, and so tests can skip
 * cleanly on a machine without them.
 */

export interface Tools {
  pdftoppm: boolean;
  magick: boolean;
  tesseract: boolean;
}

let cached: Tools | null = null;

async function has(bin: string, args: string[]): Promise<boolean> {
  try {
    await run(bin, args, { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export async function detectTools(): Promise<Tools> {
  if (cached) return cached;
  cached = {
    pdftoppm: await has('pdftoppm', ['-v']),
    magick: (await has('magick', ['-version'])) || (await has('convert', ['-version'])),
    tesseract: await has('tesseract', ['--version']),
  };
  return cached;
}

const MAGICK = async () => ((await has('magick', ['-version'])) ? 'magick' : 'convert');

/**
 * What one ImageMagick run may use. Uploads are untrusted: a small file can
 * claim to be 60,000 pixels square, and ImageMagick's own defaults would
 * decode it onto the disk the database lives on. Anything over these is
 * refused, not decoded, and no run outlives a minute.
 */
export const MAGICK_LIMITS = [
  '-limit',
  'memory',
  '256MiB',
  '-limit',
  'map',
  '512MiB',
  '-limit',
  'disk',
  '1GiB',
  '-limit',
  'area',
  '128MP',
  '-limit',
  'width',
  '16KP',
  '-limit',
  'height',
  '16KP',
  '-limit',
  'time',
  '60',
];

/** Page count of a PDF, from pdfinfo. */
export async function pdfPageCount(file: string): Promise<number | null> {
  try {
    const { stdout } = await run('pdfinfo', [file], { timeout: 30_000 });
    const m = /^Pages:\s+(\d+)/m.exec(stdout);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** Renders the first `maxPages` pages of a PDF to PNGs in `outDir`; returns them in order. */
export async function renderPdfPages(
  file: string,
  outDir: string,
  maxPages: number,
  dpi = 150,
): Promise<string[]> {
  await run(
    'pdftoppm',
    ['-png', '-r', String(dpi), '-f', '1', '-l', String(maxPages), file, path.join(outDir, 'page')],
    {
      timeout: 120_000,
    },
  );
  const files = (await readdir(outDir)).filter((f) => /^page-\d+\.png$/.test(f)).sort();
  return files.map((f) => path.join(outDir, f));
}

/**
 * A JPEG thumbnail, longest side `size`. PDFs go through poppler for the
 * first page (ImageMagick would need Ghostscript for that); images go
 * straight to ImageMagick, which also fixes camera orientation.
 */
export async function thumbnail(input: string, output: string, size = 480): Promise<void> {
  const bin = await MAGICK();
  let src = input;
  if (input.toLowerCase().endsWith('.pdf')) {
    const base = path.join(path.dirname(output), 'thumb-src');
    // A size, not a resolution: a page drawn 200 inches wide stays small.
    await run(
      'pdftoppm',
      ['-png', '-scale-to', '960', '-f', '1', '-l', '1', '-singlefile', input, base],
      { timeout: 60_000 },
    );
    src = `${base}.png`;
  }
  await run(
    bin,
    [
      ...MAGICK_LIMITS,
      src,
      '-auto-orient',
      '-thumbnail',
      `${size}x${size}>`,
      '-quality',
      '82',
      '-strip',
      output,
    ],
    { timeout: 60_000 },
  );
  await access(output);
}

/** A page preview's size and quality (4.7): enough to read a passport's small print. */
export const PREVIEW_EDGE = 1600;
export const PREVIEW_QUALITY = 80;

/**
 * The ImageMagick coder for each kind of image the vault accepts. The
 * input is always named with its coder, so a file is read as what it was
 * accepted as and never as whatever its bytes claim to be.
 */
const IMAGE_CODERS: Record<string, string> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/tiff': 'tiff',
  'image/heic': 'heic',
  'image/heif': 'heic',
};

/** Can the vault draw pages of this kind of file? */
export function drawable(mime: string): boolean {
  return mime === 'application/pdf' || mime in IMAGE_CODERS;
}

/**
 * Page previews: JPEG, 1600 px on the long edge, quality 80, and nothing
 * but the picture — `-strip` drops EXIF, GPS and every other tag. A PDF's
 * first `maxPages` pages go through poppler; an image is one page, turned
 * upright first. Returns the JPEGs in page order.
 */
export async function renderPreviews(
  input: string,
  mime: string,
  outDir: string,
  maxPages: number,
): Promise<string[]> {
  const bin = await MAGICK();
  let sources: string[];
  if (mime === 'application/pdf') {
    await run(
      'pdftoppm',
      [
        '-png',
        '-scale-to',
        String(PREVIEW_EDGE),
        '-f',
        '1',
        '-l',
        String(maxPages),
        input,
        path.join(outDir, 'pv'),
      ],
      { timeout: 300_000 },
    );
    const pageNo = (f: string) => Number(/(\d+)\.png$/.exec(f)?.[1] ?? 0);
    sources = (await readdir(outDir))
      .filter((f) => /^pv-\d+\.png$/.test(f))
      .sort((a, b) => pageNo(a) - pageNo(b))
      .map((f) => `png:${path.join(outDir, f)}`);
  } else {
    const coder = IMAGE_CODERS[mime];
    if (!coder) return [];
    // The first frame: a TIFF may hold several, and a phone's is one page.
    sources = [`${coder}:${input}[0]`];
  }
  const out: string[] = [];
  for (const [i, src] of sources.entries()) {
    const file = path.join(outDir, `preview-${i + 1}.jpg`);
    await run(
      bin,
      [
        ...MAGICK_LIMITS,
        src,
        '-auto-orient',
        '-resize',
        `${PREVIEW_EDGE}x${PREVIEW_EDGE}>`,
        // A transparent screenshot on white, not on black.
        '-background',
        'white',
        '-alpha',
        'remove',
        '-alpha',
        'off',
        '-quality',
        String(PREVIEW_QUALITY),
        '-strip',
        `jpeg:${file}`,
      ],
      { timeout: 120_000 },
    );
    out.push(file);
  }
  return out;
}

/** A person's photo (5.17c): a square this many pixels a side… */
export const PHOTO_EDGE = 512;
/** …of at most this many bytes… */
export const PHOTO_MAX_JPEG = 256 * 1024;
/** …at this quality, or, for a picture too busy to fit, the second. */
const PHOTO_QUALITIES = [82, 65];

/**
 * What a person's photo is, from its first bytes: JPEG, PNG, WebP, or
 * HEIC/HEIF. The worker reads the bytes it is about to decode itself,
 * rather than taking anybody's word for what they are, and names the coder
 * from that. Null for anything else — TIFF, a PDF, a document — which is
 * refused, not decoded.
 */
export function photoType(
  head: Buffer,
): 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic' | null {
  const at = (offset: number, ascii: string) =>
    head.length >= offset + ascii.length &&
    head.subarray(offset, offset + ascii.length).toString('latin1') === ascii;
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return 'image/jpeg';
  }
  if (at(0, '\x89PNG\r\n\x1a\n')) return 'image/png';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp';
  if (at(4, 'ftyp')) {
    const brand = head.subarray(8, 12).toString('latin1');
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) {
      return 'image/heic';
    }
  }
  return null;
}

/** The coders a photo may be read with: IMAGE_CODERS', but never TIFF's. */
function photoCoderFor(mime: string): string | null {
  return mime === 'image/tiff' ? null : (IMAGE_CODERS[mime] ?? null);
}

/** A JPEG's width and height, from its first start-of-frame marker; null if it has none. */
export function jpegSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1] as number;
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/** The part of a photo to show, as fractions of the upright picture (the crop field). */
export interface PhotoCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A person's photo, made from one picture (5.17c): read with the coder
 * named (`coder:file[0]`, the first frame only) under MAGICK_LIMITS, turned
 * upright, the part chosen cut out — or the middle — and made one
 * 512-pixel square JPEG, flattened onto white, with nothing but its pixels
 * (`-strip`: no EXIF, no GPS, no profile). Two runs: the first says how big
 * the picture is once upright, which is what the crop's fractions are of.
 * The result is checked, and anything but a 512×512 JPEG of at most 256 KiB
 * is refused. ImageMagick's own spill goes into the folder `output` is in.
 */
export async function squarePhoto(
  input: string,
  mime: string,
  crop: PhotoCrop | null,
  output: string,
): Promise<Buffer> {
  const coder = photoCoderFor(mime);
  if (!coder) throw new Error(`a photo is not made from ${mime}`);
  const bin = await MAGICK();
  const src = `${coder}:${input}[0]`;
  const env = { ...process.env, MAGICK_TEMPORARY_PATH: path.dirname(output) };
  const { stdout } = await run(
    bin,
    [...MAGICK_LIMITS, src, '-auto-orient', '-format', '%w %h', 'info:'],
    {
      timeout: 60_000,
      env,
    },
  );
  const [width, height] = stdout.trim().split(/\s+/).map(Number);
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error('the picture has no size');
  }
  const box = cropBox(width, height, crop);
  for (const quality of PHOTO_QUALITIES) {
    await run(
      bin,
      [
        ...MAGICK_LIMITS,
        src,
        '-auto-orient',
        '-crop',
        `${box.w}x${box.h}+${box.x}+${box.y}`,
        '+repage',
        '-resize',
        `${PHOTO_EDGE}x${PHOTO_EDGE}^`,
        '-gravity',
        'center',
        '-extent',
        `${PHOTO_EDGE}x${PHOTO_EDGE}`,
        // A transparent picture on white, not on black.
        '-background',
        'white',
        '-alpha',
        'remove',
        '-alpha',
        'off',
        '-quality',
        String(quality),
        '-strip',
        `jpeg:${output}`,
      ],
      { timeout: 60_000, env },
    );
    const jpeg = await readFile(output);
    const size = jpegSize(jpeg);
    if (!size || size.width !== PHOTO_EDGE || size.height !== PHOTO_EDGE) {
      throw new Error('the photo did not come out square');
    }
    if (jpeg.length <= PHOTO_MAX_JPEG) return jpeg;
  }
  throw new Error('the photo came out too big');
}

/**
 * The pixels a crop names, inside a picture `width` by `height`; with none,
 * the largest square in the middle.
 */
export function cropBox(
  width: number,
  height: number,
  crop: PhotoCrop | null,
): { x: number; y: number; w: number; h: number } {
  if (!crop) {
    const side = Math.min(width, height);
    return {
      x: Math.floor((width - side) / 2),
      y: Math.floor((height - side) / 2),
      w: side,
      h: side,
    };
  }
  const x = Math.min(width - 1, Math.max(0, Math.round(crop.x * width)));
  const y = Math.min(height - 1, Math.max(0, Math.round(crop.y * height)));
  const w = Math.max(1, Math.min(width - x, Math.round(crop.w * width)));
  const h = Math.max(1, Math.min(height - y, Math.round(crop.h * height)));
  return { x, y, w, h };
}

/** OCR of one page image. Returns the text, possibly empty. */
export async function ocrImage(file: string, lang = 'eng'): Promise<string> {
  const { stdout } = await run('tesseract', [file, '-', '-l', lang, '--psm', '3'], {
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.replace(/\f/g, '\n').trim();
}

export async function readIfExists(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch {
    return null;
  }
}
