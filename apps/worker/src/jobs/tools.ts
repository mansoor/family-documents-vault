import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { access, mkdtemp, open, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { childEnv } from './child-env.js';
import { cappedScale } from './scan-read.js';

const execFileAsync = promisify(execFile);

/**
 * Tools run for work nobody is waiting on (the Reading check, 0.9.0 R0):
 * inside `atLowPriority`, each tool runs under `nice -n 19` (where there is
 * one: not on Windows) and with OMP_THREAD_LIMIT=1, so Tesseract takes one
 * core, gently, and never crowds out a family's own uploads.
 */
const lowPriority = new AsyncLocalStorage<boolean>();

/** `fn`, its tools run at the lowest priority. */
export const atLowPriority = <T>(fn: () => Promise<T>): Promise<T> => lowPriority.run(true, fn);

/** How a tool is run now: as it is, or niced, one thread. */
export function lowPriorityCommand(
  bin: string,
  args: string[],
  env: Record<string, string> | undefined,
  platform: NodeJS.Platform = process.platform,
): { bin: string; args: string[]; env: Record<string, string> | undefined } {
  if (!lowPriority.getStore()) return { bin, args, env };
  const one = { ...env, OMP_THREAD_LIMIT: '1' };
  return platform === 'win32'
    ? { bin, args, env: one }
    : { bin: 'nice', args: ['-n', '19', bin, ...args], env: one };
}

/**
 * A tool run: its arguments never through a shell, and its environment the
 * few names it needs (childEnv, the S4 review's F7), never the worker's —
 * no master key, no database address — with what a call adds.
 */
function run(
  bin: string,
  args: string[],
  opts: {
    timeout?: number;
    signal?: AbortSignal | undefined;
    maxBuffer?: number;
    env?: Record<string, string>;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  const how = lowPriorityCommand(bin, args, opts.env);
  return execFileAsync(how.bin, how.args, { ...opts, env: childEnv(how.env) });
}

/** The same, for the tests: what a tool is handed. */
export const runTool = run;

/**
 * The most address space one poppler run may take (L2): 1 GiB. poppler
 * hands a PDF's pictures to libjpeg, openjpeg and its own decoders, with no
 * limits of its own like ImageMagick's: a 3 KB PDF holding a progressive
 * CMYK JPEG 16,000 pixels square took 1,979 MiB to draw, and pdftotext and
 * `pdfimages -list` decode an inline one (1,962 MiB). Capped, the run fails
 * instead of the server: a decode that cannot have its memory is drawn
 * blank, and the page reads nothing. Measured, the most an ordinary page
 * takes is an A0 page drawn at 150 dpi for OCR, 250 MiB; a JPEG at the most
 * a picture may hold whole (JPEG_HELD_MAX_COEFFICIENTS), 153 MiB. A JPEG
 * held whole past that is refused before anything is drawn
 * (refusePdfHeldJpegs), as a photo's is.
 */
export const POPPLER_MAX_KIB = 1024 * 1024;

/**
 * How a poppler tool is run: on Linux (the worker image), by `sh`, which
 * caps its address space (`ulimit -v`, POPPLER_MAX_KIB) and then becomes it
 * (`exec`, so a timeout or an abort kills the tool itself); `fileBlocks`
 * also caps each file it writes, in 512-byte blocks, a write past it failing
 * rather than killing it (SIGXFSZ ignored). Elsewhere — a development
 * machine — as it is.
 */
export function popplerCommand(
  bin: string,
  args: string[],
  opts: { fileBlocks?: number } = {},
  platform: NodeJS.Platform = process.platform,
): { bin: string; args: string[] } {
  if (platform !== 'linux') return { bin, args };
  const files = opts.fileBlocks ? `trap '' XFSZ && ulimit -f ${opts.fileBlocks} && ` : '';
  return {
    bin: 'sh',
    args: ['-c', `${files}ulimit -v ${POPPLER_MAX_KIB} && exec "$0" "$@"`, bin, ...args],
  };
}

/** A poppler tool, run as `popplerCommand` says. */
function poppler(
  bin: string,
  args: string[],
  opts: Parameters<typeof run>[2] & { fileBlocks?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const { fileBlocks, ...rest } = opts;
  const how = popplerCommand(bin, args, fileBlocks ? { fileBlocks } : {});
  return run(how.bin, how.args, rest);
}

/**
 * The three command-line tools the worker image ships: poppler
 * (pdftoppm, pdfinfo, pdftotext), ImageMagick (magick) and Tesseract.
 * Wrapped so the rest of the worker never builds a shell command, and so
 * tests can skip cleanly on a machine without them.
 */

export interface Tools {
  pdftoppm: boolean;
  magick: boolean;
  tesseract: boolean;
  /** poppler's, in the same package as pdftoppm (5.37); absent, every page is OCR'd. */
  pdftotext?: boolean;
  /** poppler's too: how much of each page its pictures cover (the 5.37 review). */
  pdfimages?: boolean;
  /** Tesseract's orientation model (tesseract-ocr-data-osd, 0.9.0 R3): which way up a page reads. */
  osd?: boolean;
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
    pdftotext: await has('pdftotext', ['-v']),
    pdfimages: await has('pdfimages', ['-v']),
    osd: await hasOsd(),
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
export async function pdfPageCount(file: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const { stdout } = await poppler('pdfinfo', [file], { timeout: 30_000, signal });
    const m = /^Pages:\s+(\d+)/m.exec(stdout);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Whether a PDF needs a password to be opened (Phase 6, I2): pdfinfo refuses
 * it with "Incorrect password". The vault never asks for one. A PDF locked
 * only against printing or copying opens, and is read as any other.
 */
export async function pdfLocked(file: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await poppler('pdfinfo', [file], { timeout: 30_000, signal });
    return false;
  } catch (err) {
    const { message, stderr } = err as { message?: string; stderr?: string | Buffer };
    return /password/i.test(`${message ?? ''} ${stderr?.toString() ?? ''}`);
  }
}

/**
 * Renders the first `maxPages` pages of a PDF to PNGs in `outDir`; returns
 * them in order. A JPEG on them libjpeg would hold whole past
 * JPEG_HELD_MAX_COEFFICIENTS is refused first (refusePdfHeldJpegs, L2).
 */
export async function renderPdfPages(
  file: string,
  outDir: string,
  maxPages: number,
  dpi = 150,
  /** Ends the drawing, its process killed, when it is aborted (a read's deadline, I2). */
  signal?: AbortSignal,
): Promise<string[]> {
  await refusePdfHeldJpegs(file, 1, maxPages, outDir, signal);
  await poppler(
    'pdftoppm',
    ['-png', '-r', String(dpi), '-f', '1', '-l', String(maxPages), file, path.join(outDir, 'page')],
    {
      timeout: 120_000,
      signal,
    },
  );
  const files = (await readdir(outDir)).filter((f) => /^page-\d+\.png$/.test(f)).sort();
  return files.map((f) => path.join(outDir, f));
}

/**
 * The text a PDF carries of its own, page by page, for its first
 * `lastPage` pages (5.37): poppler's pdftotext, UTF-8, laid out as the page
 * is (`-layout`), so a label stays on the line of the value beside it (the
 * review: in reading order a table's label and value came apart). A page
 * that is a scan comes back empty, or nearly. Nothing is drawn, so it takes
 * a moment however many pages there are.
 */
export async function pdfPageTexts(
  file: string,
  lastPage: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const { stdout } = await poppler(
    'pdftotext',
    [
      '-q',
      '-layout',
      '-enc',
      'UTF-8',
      '-eol',
      'unix',
      '-f',
      '1',
      '-l',
      String(lastPage),
      file,
      '-',
    ],
    { timeout: 120_000, maxBuffer: 64 * 1024 * 1024, signal },
  );
  // A form feed ends each page, the last one included.
  const pages = stdout.split('');
  if (pages.length > 1 && (pages[pages.length - 1] ?? '').trim() === '') pages.pop();
  return pages;
}

/**
 * How much of each of a PDF's first `lastPage` pages its pictures cover,
 * from 0 to 1, by page number (the review): a scan is a picture of the
 * whole page, with perhaps a line of text of its own — a "Scanned with"
 * line, a browser's print header. From pdfimages' list (each picture's size and
 * resolution, so its size on the page) and pdfinfo's page sizes. A page
 * not in the answer has no picture; null when either cannot say.
 */
export async function pdfImageCoverage(
  file: string,
  lastPage: number,
  signal?: AbortSignal,
): Promise<Map<number, number> | null> {
  try {
    const range = ['-f', '1', '-l', String(lastPage)];
    const [listed, info] = await Promise.all([
      poppler('pdfimages', ['-list', ...range, file], {
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
        signal,
      }),
      poppler('pdfinfo', [...range, file], { timeout: 30_000, signal }),
    ]);
    const pageArea = new Map<number, number>();
    for (const m of info.stdout.matchAll(
      /^Page\s+(\d+)\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/gm,
    )) {
      pageArea.set(Number(m[1]), (Number(m[2]) / 72) * (Number(m[3]) / 72));
    }
    const covered = new Map<number, number>();
    for (const row of listed.stdout.split('\n')) {
      const c = row.trim().split(/\s+/);
      if (c.length < 14 || !/^\d+$/.test(c[0] ?? '') || c[2] !== 'image') continue;
      const page = Number(c[0]);
      const [w, h, xppi, yppi] = [c[3], c[4], c[12], c[13]].map(Number) as [
        number,
        number,
        number,
        number,
      ];
      if (!(xppi > 0 && yppi > 0)) continue;
      covered.set(page, (covered.get(page) ?? 0) + (w / xppi) * (h / yppi));
    }
    const out = new Map<number, number>();
    for (const [page, area] of covered) {
      const whole = pageArea.get(page);
      if (whole && whole > 0) out.set(page, Math.min(1, area / whole));
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Draws one page of a PDF as a PNG in `outDir`, as `renderPdfPages` draws
 * them, for OCR: its JPEGs checked first, as theirs are (L2).
 */
export async function renderPdfPage(
  file: string,
  outDir: string,
  page: number,
  dpi = 150,
  signal?: AbortSignal,
): Promise<string> {
  const base = path.join(outDir, `page-${page}`);
  await refusePdfHeldJpegs(file, page, page, outDir, signal);
  await poppler(
    'pdftoppm',
    ['-png', '-r', String(dpi), '-f', String(page), '-l', String(page), '-singlefile', file, base],
    { timeout: 120_000, signal },
  );
  return `${base}.png`;
}

/**
 * A drawn page (a PNG of `renderPdfPage`'s) cleaned for OCR to read again
 * (0.8.0, S5): twice the size, each pixel the median of its 3×3 neighbours,
 * which takes a grainy scan's speckle out and leaves its letters. Never
 * made bigger than PREPARE_MAX_PIXELS (the R3 re-check: a photo's page
 * 4,700 pixels square doubled was 88 megapixels, a minute and 690 MB on
 * disk), so a page that size already is only cleaned. Under MAGICK_LIMITS,
 * as every ImageMagick call is.
 */
export async function cleanForOcr(
  input: string,
  output: string,
  signal?: AbortSignal,
): Promise<void> {
  const bin = await MAGICK();
  const [w = 0, h = 0] = (
    await identify(['-ping', '-format', '%w %h', `png:${input}`], 60_000, signal)
  )
    .trim()
    .split(/\s+/)
    .map(Number);
  const scale = cappedScale(2, w, h);
  await run(
    bin,
    [
      ...MAGICK_LIMITS,
      `png:${input}`,
      ...(scale > 1 ? ['-resize', `${Math.round(scale * 100)}%`] : []),
      '-statistic',
      'Median',
      '3x3',
      `png:${output}`,
    ],
    { timeout: 120_000, signal },
  );
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
    // A JPEG on its first page libjpeg would hold whole, too big or
    // unreadable, is refused first, as a photo's is (L2).
    await refusePdfHeldJpegs(input, 1, 1, path.dirname(output));
    // A size, not a resolution: a page drawn 200 inches wide stays small.
    await poppler(
      'pdftoppm',
      ['-png', '-scale-to', '960', '-f', '1', '-l', '1', '-singlefile', input, base],
      { timeout: 60_000 },
    );
    src = `${base}.png`;
  } else {
    // Read by what its bytes are: a JPEG libjpeg would hold whole, too big
    // or unreadable, is refused first (R3, round four).
    await refuseHeldJpeg(input);
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
 * first `maxPages` pages go through poppler, their JPEGs checked first
 * (refusePdfHeldJpegs); an image is one page, turned upright first.
 * Returns the JPEGs in page order.
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
    // A JPEG on its pages libjpeg would hold whole, too big or unreadable:
    // refused, as an image's is (L2).
    await refusePdfHeldJpegs(input, 1, maxPages, outDir);
    await poppler(
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
    // A scanner's TIFF holds a page in each frame (5.18 review): each is
    // drawn, up to `maxPages`. Any other image is one page, its first frame.
    const frames = coder === 'tiff' ? Math.min(await imageFrames(input, mime), maxPages) : 1;
    // A JPEG libjpeg would hold whole, too big or unreadable: refused (R3, round four).
    if (coder === 'jpeg') await refuseHeldJpeg(input);
    sources = Array.from({ length: frames }, (_, i) => `${coder}:${input}[${i}]`);
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
 * The most pixels, and the longest side, a photo may have: MAGICK_LIMITS'
 * area and width, asked of the picture's header before anything is
 * decoded. A JPEG decoded smaller than it is (below) is not counted at its
 * full size by ImageMagick, so these are checked here.
 */
export const PHOTO_MAX_PIXELS = 128_000_000;
export const PHOTO_MAX_SIDE = 16_000;
/**
 * The most pixels a JPEG photo is decoded at, however small the part
 * chosen: a phone's 64, 108 or 128 megapixel picture fits the memory
 * MAGICK_LIMITS allow, and is never spilled to disk whole. A part the web
 * can choose, a quarter of the picture's side or more, is decoded far
 * smaller than this.
 */
export const PHOTO_DECODE_PIXELS = 32_000_000;

/**
 * What one photo's decode may use: MAGICK_LIMITS, but 2 GiB of disk. A
 * HEIC, WebP or PNG cannot be decoded smaller than it is, and a 48 or 50
 * megapixel one (an iPhone's "HEIF Max", a 50 megapixel WebP) spills its
 * pixel cache to disk, in the job's own folder, removed after. The pixel
 * limits stay what they are: the guard against a picture that claims to
 * be bigger than any photo.
 */
const PHOTO_LIMITS = MAGICK_LIMITS.map((v, i, all) => (all[i - 1] === 'disk' ? '2GiB' : v));

/**
 * The turn that stands a picture up, for each EXIF orientation, as
 * `-auto-orient` would make it. Named here, rather than left to
 * `-auto-orient`, so the picture is turned by the same orientation its part
 * was planned by: ImageMagick 7's `-ping` does not read a WebP's (the 5.17c
 * review), and a part planned upright and then turned again is the wrong
 * part.
 */
const TURNS: Record<string, string[]> = {
  TopRight: ['-flop'],
  BottomRight: ['-rotate', '180'],
  BottomLeft: ['-flip'],
  LeftTop: ['-transpose'],
  RightTop: ['-rotate', '90'],
  RightBottom: ['-transverse'],
  LeftBottom: ['-rotate', '270'],
};

/** EXIF's orientation numbers, by ImageMagick's names for them. */
const ORIENTATIONS = [
  'Undefined',
  'TopLeft',
  'TopRight',
  'BottomRight',
  'BottomLeft',
  'LeftTop',
  'RightTop',
  'RightBottom',
  'LeftBottom',
];

/**
 * A WebP's EXIF orientation, from its RIFF 'EXIF' chunk (IFD0, tag 0x0112),
 * as ImageMagick names it; null when it has none. ImageMagick 7 reads it
 * when it decodes the picture, but not when it only pings it.
 */
export function webpOrientation(file: Buffer): string | null {
  if (file.length < 12 || file.toString('latin1', 0, 4) !== 'RIFF') return null;
  if (file.toString('latin1', 8, 12) !== 'WEBP') return null;
  let at = 12;
  while (at + 8 <= file.length) {
    const id = file.toString('latin1', at, at + 4);
    const size = file.readUInt32LE(at + 4);
    const body = file.subarray(at + 8, Math.min(file.length, at + 8 + size));
    if (id === 'EXIF') return tiffOrientation(body);
    at += 8 + size + (size % 2);
  }
  return null;
}

/** The orientation in a TIFF header's first IFD (EXIF's layout), with or without "Exif\0\0" before it. */
function tiffOrientation(exif: Buffer): string | null {
  const t = exif.toString('latin1', 0, 6) === 'Exif\0\0' ? exif.subarray(6) : exif;
  if (t.length < 8) return null;
  const order = t.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const u16 = (o: number) => (order === 'II' ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o: number) => (order === 'II' ? t.readUInt32LE(o) : t.readUInt32BE(o));
  const ifd = u32(4);
  if (ifd + 2 > t.length) return null;
  const n = u16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > t.length) return null;
    if (u16(e) === 0x0112) return ORIENTATIONS[u16(e + 8)] ?? null;
  }
  return null;
}

/**
 * A person's photo, made from one picture (5.17c): read with the coder
 * named (`coder:file[0]`, the first frame only) under MAGICK_LIMITS, the
 * part chosen cut out — or the middle — turned upright, and made one
 * 512-pixel square JPEG, flattened onto white, with nothing but its pixels
 * (`-strip`: no EXIF, no GPS, no profile).
 *
 * The picture is decoded once, and as small as will do (the 5.17c review:
 * a phone's 64 megapixel photo ran out of room decoded whole, and again
 * turned upright). Its header says how big it is and which way up (`-ping`,
 * which decodes nothing; a WebP's orientation is read from its EXIF chunk
 * here, which ImageMagick 7's ping does not, and a HEIC is upright once
 * libheif has read it): more than PHOTO_MAX_PIXELS, or a side over
 * PHOTO_MAX_SIDE, is refused there. A JPEG is then decoded by libjpeg at a
 * half, a quarter or an eighth of its size (`jpeg:size`, asked for as
 * exactly that, which ImageMagick 6 and 7 both give): the smallest that
 * keeps the part chosen 512 pixels a side, and no more than
 * PHOTO_DECODE_PIXELS. Anything else is decoded at the size it is, under
 * PHOTO_LIMITS. Any page offset is dropped (`+repage`), so a picture
 * placed off its canvas is cut where it is seen. The part is cut before
 * anything else, in one crop: in pixels when the picture was decoded at the
 * size its header said, as fractions of what was decoded when libjpeg
 * shrank it (a copy of all but the corner of a full-size picture would not
 * fit beside it). Only the part is turned upright, by the orientation it
 * was planned by, and resized. The square is kept as a PNG, and only that
 * is made a JPEG: at the second quality, if the first is over 256 KiB. The
 * result is checked, and anything but a 512x512 JPEG of at most 256 KiB is
 * refused. ImageMagick's own spill goes into the folder `output` is in.
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
  const env = { MAGICK_TEMPORARY_PATH: path.dirname(output) };
  const { stdout } = await run(
    bin,
    [...MAGICK_LIMITS, '-ping', src, '-format', '%w %h %[orientation]', 'info:'],
    { timeout: 60_000, env },
  );
  const [w, h, pinged = ''] = stdout.trim().split(/\s+/);
  const stored = { w: Number(w), h: Number(h) };
  if (!(stored.w > 0 && stored.h > 0 && Number.isFinite(stored.w) && Number.isFinite(stored.h))) {
    throw new Error('the picture has no size');
  }
  if (
    stored.w * stored.h > PHOTO_MAX_PIXELS ||
    stored.w > PHOTO_MAX_SIDE ||
    stored.h > PHOTO_MAX_SIDE
  ) {
    throw new Error('the picture is bigger than a photo may be');
  }
  // A JPEG libjpeg would hold whole, too big or unreadable: refused, as a
  // page read's is (R3, round four) — its shrinking below does not help it.
  if (coder === 'jpeg') await refuseHeldJpeg(input);
  // Which way up, as the picture will be turned: libheif stands a HEIC up
  // as it reads it; a WebP says so in its EXIF chunk, which ping skips.
  const orientation =
    coder === 'heic'
      ? 'TopLeft'
      : coder === 'webp'
        ? (webpOrientation(await readFile(input)) ?? pinged)
        : pinged;
  const plan = photoPlan(stored, orientation, crop, coder === 'jpeg');
  const { part, shrink } = plan;
  const cut: string[] = [];
  if (shrink === 1) {
    // Decoded at the size the header said: one crop, in pixels.
    const x0 = Math.min(stored.w - 1, Math.max(0, Math.round(part.x * stored.w)));
    const y0 = Math.min(stored.h - 1, Math.max(0, Math.round(part.y * stored.h)));
    const x1 = Math.min(stored.w, Math.max(x0 + 1, Math.round((part.x + part.w) * stored.w)));
    const y1 = Math.min(stored.h, Math.max(y0 + 1, Math.round((part.y + part.h) * stored.h)));
    cut.push('-crop', `${x1 - x0}x${y1 - y0}+${x0}+${y0}`, '+repage');
  } else {
    /** A fraction as ImageMagick's percentage geometry. */
    const pc = (f: number) => `${Math.min(100, f * 100).toFixed(4)}%`;
    // Shrunk as libjpeg read it: as fractions of what was decoded,
    // everything up to the part's far corner, then its own share of that.
    cut.push(
      '-gravity',
      'NorthWest',
      '-crop',
      `${pc(part.x + part.w)}x${pc(part.y + part.h)}+0+0`,
      '+repage',
      '-gravity',
      'SouthEast',
      '-crop',
      `${pc(part.w / (part.x + part.w))}x${pc(part.h / (part.y + part.h))}+0+0`,
      '+repage',
    );
  }
  const square = path.join(path.dirname(output), 'square.png');
  await run(
    bin,
    [
      ...(shrink > 1 ? MAGICK_LIMITS : PHOTO_LIMITS),
      ...(shrink > 1
        ? ['-define', `jpeg:size=${Math.floor(stored.w / shrink)}x${Math.floor(stored.h / shrink)}`]
        : []),
      src,
      '+repage',
      ...cut,
      ...(TURNS[orientation] ?? []),
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
      '-strip',
      `png:${square}`,
    ],
    { timeout: 60_000, env },
  );
  for (const quality of PHOTO_QUALITIES) {
    await run(
      bin,
      [...MAGICK_LIMITS, `png:${square}`, '-quality', String(quality), '-strip', `jpeg:${output}`],
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

/** An EXIF orientation's way from the picture as stored to it upright. */
type Orienting = (r: { x: number; y: number; w: number; h: number }) => {
  x: number;
  y: number;
  w: number;
  h: number;
};

/**
 * For each EXIF orientation, where a part of the upright picture is in the
 * picture as stored, all in fractions: 2 to 4 mirror or turn it half way,
 * 5 to 8 turn it a quarter (so its width is the stored height).
 */
const STORED_PART: Record<string, Orienting> = {
  TopRight: (r) => ({ x: 1 - r.x - r.w, y: r.y, w: r.w, h: r.h }),
  BottomRight: (r) => ({ x: 1 - r.x - r.w, y: 1 - r.y - r.h, w: r.w, h: r.h }),
  BottomLeft: (r) => ({ x: r.x, y: 1 - r.y - r.h, w: r.w, h: r.h }),
  LeftTop: (r) => ({ x: r.y, y: r.x, w: r.h, h: r.w }),
  RightTop: (r) => ({ x: r.y, y: 1 - r.x - r.w, w: r.h, h: r.w }),
  RightBottom: (r) => ({ x: 1 - r.y - r.h, y: 1 - r.x - r.w, w: r.h, h: r.w }),
  LeftBottom: (r) => ({ x: 1 - r.y - r.h, y: r.x, w: r.h, h: r.w }),
};

/**
 * How a picture `stored` pixels big, which its EXIF says to turn by
 * `orientation`, is made a photo: the part to cut, as fractions of the
 * picture as stored — the crop, or the largest square in the middle of the
 * upright picture — and, for a JPEG, how much to shrink it as it is
 * decoded (1, 2, 4 or 8): the most that keeps that part PHOTO_EDGE a side,
 * and at least enough to decode no more than PHOTO_DECODE_PIXELS.
 */
export function photoPlan(
  stored: { w: number; h: number },
  orientation: string,
  crop: PhotoCrop | null,
  jpeg: boolean,
): { part: { x: number; y: number; w: number; h: number }; shrink: 1 | 2 | 4 | 8 } {
  const turn = STORED_PART[orientation];
  const quarter = ['LeftTop', 'RightTop', 'RightBottom', 'LeftBottom'].includes(orientation);
  const upright = quarter ? { w: stored.h, h: stored.w } : stored;
  const box = cropBox(upright.w, upright.h, crop);
  const shown = {
    x: box.x / upright.w,
    y: box.y / upright.h,
    w: box.w / upright.w,
    h: box.h / upright.h,
  };
  const part = turn ? turn(shown) : shown;
  if (!jpeg) return { part, shrink: 1 };
  const side = Math.min(box.w, box.h);
  const sharp = ([8, 4, 2, 1] as const).find((s) => side / s >= PHOTO_EDGE) ?? 1;
  const fits =
    ([1, 2, 4, 8] as const).find((s) => (stored.w * stored.h) / (s * s) <= PHOTO_DECODE_PIXELS) ??
    8;
  return { part, shrink: Math.max(sharp, fits) as 1 | 2 | 4 | 8 };
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

/** `identify`, as whichever ImageMagick is installed names it. */
async function identify(args: string[], timeout = 60_000, signal?: AbortSignal): Promise<string> {
  const bin = await MAGICK();
  const [cmd, ...pre] = bin === 'magick' ? ['magick', 'identify'] : ['identify'];
  const { stdout } = await run(cmd, [...pre, ...MAGICK_LIMITS, ...args], { timeout, signal });
  return stdout;
}

/**
 * How many pages an image holds: a TIFF from a document scanner has one a
 * frame; every other kind the vault takes is one page. At least 1. Stopped
 * by `signal` (a version's read deadline).
 */
export async function imageFrames(
  file: string,
  mime: string,
  signal?: AbortSignal,
): Promise<number> {
  const coder = IMAGE_CODERS[mime];
  if (coder !== 'tiff') return 1;
  // Counted from the frames' headers alone (`-ping`), over a bounded range:
  // decoding a twenty-page colour scan's every frame to count them fills
  // the pixel cache, and its pages were never drawn (the second review).
  // One line a frame, counted: a frame's number (`%s`) is taken from the
  // file's PageNumber tag, which a scanner may start at 1, or a page split
  // out of a scan keep as 3 (the third review), and is no count.
  const out = await identify(
    ['-ping', '-format', 'frame\n', `tiff:${file}[0-${TIFF_MAX_FRAMES - 1}]`],
    60_000,
    signal,
  );
  const frames = out.split('\n').filter((line) => line.trim() === 'frame').length;
  return Math.min(Math.max(frames, 1), TIFF_MAX_FRAMES);
}

/** The most frames a TIFF is counted to: past this, it is said to have this many. */
export const TIFF_MAX_FRAMES = 1000;

let pangoFound: Promise<boolean> | null = null;

/**
 * Whether ImageMagick can lay text out with pango (the worker image's
 * imagemagick-pango): fontconfig then finds each character a font that has
 * it — Chinese, Arabic, Devanagari, emoji — and shapes and orders it, where
 * one font file would leave a gap for every character it lacks.
 */
export function hasPango(): Promise<boolean> {
  pangoFound ??= MAGICK()
    .then((bin) => run(bin, ['-list', 'format'], { timeout: 30_000 }))
    .then(({ stdout }) => /^\s*PANGO\*?\s/m.test(stdout))
    .catch(() => false);
  return pangoFound;
}

let fontFound: Promise<string | null> | null = null;

/**
 * A font file to write with where there is no pango: whichever fontconfig
 * gives for sans-serif. Named by its file, so ImageMagick never falls back
 * to a font it cannot find, which it reports as a failure on some systems.
 */
function sansFont(): Promise<string | null> {
  fontFound ??= run('fc-match', ['-f', '%{file}', 'sans-serif'], { timeout: 10_000 })
    .then(async ({ stdout }) => {
      const file = stdout.trim();
      if (!file) return null;
      await access(file);
      return file;
    })
    .catch(() => null);
  return fontFound;
}

/**
 * A line of the family's text, fit to be drawn: one line, no control
 * characters, not too long. The bidirectional isolates (U+2066–U+2069) are
 * kept — they are how a label in Arabic keeps to its own place in the line
 * — and every other format character goes.
 */
export function watermarkLine(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/(?![⁦-⁩])\p{Cf}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/**
 * What ImageMagick is given to write, inline after `pango:` or `label:`:
 * `%` and `\` made plain — a label is the family's text, and `%[…]` in it
 * would otherwise be read as a question about the image — and never an
 * `@file`, which ImageMagick would read (and which a distribution's policy
 * may refuse outright, as Debian's and Ubuntu's `@*` rule does: the second
 * review). With pango, markup is off, so `<b>` is drawn as it is written;
 * ImageMagick still reads `&amp;`, `&lt;` and their like in what `pango:` is
 * given inline, so every `&` is given as `&amp;` and a label's own `&amp;`
 * is drawn as it was typed. The bidirectional isolates are kept for pango
 * to order the line by; the one font `label:` draws with has no use for
 * them.
 */
export function magickText(text: string, opts: { pango?: boolean } = {}): string {
  const line = watermarkLine(text);
  const kept = opts.pango ? line.replace(/&/g, '&amp;') : line.replace(/[⁦-⁩]/g, '');
  const escaped = kept.replace(/\\/g, '\\\\').replace(/%/g, '%%');
  return escaped.startsWith('@') ? ` ${escaped}` : escaped;
}

/**
 * The mark across a page: dark red with a pale halo, laid over the page at
 * about half strength — read on a white page and on a dark photo alike,
 * and the page still read through it.
 */
export const MARK_FILL = '#8c1c1c';
const MARK_HALO = 'white';
const MARK_OPACITY = 0.5;

/**
 * The watermark's type sizes, in pixels, for a page `width` by `height`:
 * the mark's sized to the page, and on a strip to its height, a little, so
 * that on a strip or a small page a whole mark still crosses it, big enough
 * to read (the second review); the foot line's to the page's width.
 */
export function watermarkSizes(width: number, height: number): { mark: number; foot: number } {
  const clamp = (n: number, lo: number, hi: number) => Math.round(Math.max(lo, Math.min(hi, n)));
  return {
    mark: clamp(Math.min(width / 44, (3 * height) / 30), 10, 44),
    foot: clamp(width / 48, 12, 40),
  };
}

/**
 * A view-only link's page (5.18): one of the vault's drawn pages, with
 * `text` — whom the link is for, and the day it was made — written across
 * the whole of it on the slant, again and again in a grid, so that any part
 * of the page cut out still carries it, corners included: dark red with a
 * pale halo, to be read on a white page and on a dark photo alike, and
 * light enough to read the page through. Once more, plainly, on a white
 * band added below the page (a crop to the page's own edges drops that
 * line, never the grid). JPEG, as the previews are, and nothing but the
 * picture.
 *
 * With pango the text is laid out as the family wrote it, in any script;
 * without it, with the one sans-serif font fontconfig gives, which draws
 * Latin, Greek and Cyrillic. Either way the text goes inline, escaped
 * (magickText), never through a file ImageMagick is asked to read.
 */
export async function watermarkPage(
  input: string,
  output: string,
  text: string,
  opts: { pango?: boolean } = {},
): Promise<void> {
  const bin = await MAGICK();
  const size = async (file: string) => {
    const [w = 0, h = 0] = (await identify(['-format', '%w %h', file]))
      .trim()
      .split(/\s+/)
      .map(Number);
    return { w, h };
  };
  const page = await size(`jpeg:${input}`);
  const width = page.w || PREVIEW_EDGE;
  const height = page.h || PREVIEW_EDGE;
  const { mark: markSize, foot: footSize } = watermarkSizes(width, height);
  const pango = opts.pango ?? (await hasPango());
  const dir = await mkdtemp(path.join(path.dirname(output), 'wm-'));
  try {
    const font = pango ? null : await sansFont();
    const words = (size: number, fill: string): string[] =>
      pango
        ? [
            '-font',
            'Noto Sans',
            '-pointsize',
            String(size),
            '-fill',
            fill,
            '-define',
            'pango:markup=false',
            `pango:${magickText(text, { pango: true })}`,
          ]
        : [
            ...(font ? ['-font', font] : []),
            '-pointsize',
            String(size),
            '-fill',
            fill,
            `label:${magickText(text)}`,
          ];

    // One mark: the words with their halo, at half strength, turned to rise
    // to the right, with a little room around it. Laid edge to edge, marks
    // run on into slanted lines across the page; a second set, shifted half
    // a mark along, lies between them, so no part of the page a few
    // centimetres across is without one.
    const mark = path.join(dir, 'mark.png');
    await run(
      bin,
      [
        ...MAGICK_LIMITS,
        '-background',
        'none',
        ...words(markSize, MARK_FILL),
        '(',
        '+clone',
        '-background',
        MARK_HALO,
        '-shadow',
        '100x1.3+0+0',
        ')',
        '+swap',
        '-background',
        'none',
        '-layers',
        'merge',
        '+repage',
        '-channel',
        'A',
        '-evaluate',
        'multiply',
        String(MARK_OPACITY),
        '+channel',
        '-rotate',
        '-30',
        '-bordercolor',
        'none',
        '-border',
        `${Math.round(markSize * 0.5)}x${Math.round(markSize * 0.5)}`,
        `png:${mark}`,
      ],
      { timeout: 60_000 },
    );
    const { w: markWidth, h: markHeight } = await size(`png:${mark}`);
    const tile = path.join(dir, 'tile.png');
    await run(
      bin,
      [
        ...MAGICK_LIMITS,
        `png:${mark}`,
        '(',
        '+clone',
        '-roll',
        `+${Math.round(markWidth / 2)}+0`,
        ')',
        '-background',
        'none',
        '-compose',
        'over',
        '-composite',
        `png:${tile}`,
      ],
      { timeout: 60_000 },
    );
    // The line at the foot, never wider than the page, on nothing: the band
    // it sits on is made as tall as it is, whatever the script (Arabic and
    // Urdu stand taller than Latin), so it never covers the page.
    const footLine = path.join(dir, 'foot.png');
    await run(
      bin,
      [
        ...MAGICK_LIMITS,
        '-background',
        'none',
        ...words(footSize, '#1f1f1f'),
        '-resize',
        `${Math.max(1, width - 2 * footSize)}x>`,
        `png:${footLine}`,
      ],
      { timeout: 60_000 },
    );
    const foot = await size(`png:${footLine}`);
    const band = Math.max(Math.round(footSize * 2.4), foot.h + Math.round(footSize * 0.6));
    // The grid, laid so that one mark's middle is the page's middle: a small
    // page, or a strip, has a whole mark across it, not the empty corner
    // between marks. Tiled wider than the page and cut to it, so the pattern
    // carries on unbroken to every edge.
    const cut = (page: number, period: number) =>
      period > 0 ? ((Math.round(period / 2 - page / 2) % period) + period) % period : 0;
    await run(
      bin,
      [
        ...MAGICK_LIMITS,
        `jpeg:${input}`,
        // A page of black and white is kept as grey, which would turn the
        // mark grey too: in colour, always.
        '-colorspace',
        'sRGB',
        '-type',
        'TrueColor',
        '(',
        '-size',
        `${width + markWidth}x${height + markHeight}`,
        `tile:png:${tile}`,
        '-crop',
        `${width}x${height}+${cut(width, markWidth)}+${cut(height, markHeight)}`,
        '+repage',
        ')',
        '-compose',
        'over',
        '-composite',
        '-background',
        'white',
        '-gravity',
        'south',
        '-splice',
        `0x${band}`,
        `png:${footLine}`,
        '-gravity',
        'south',
        '-geometry',
        `+0+${Math.round((band - foot.h) / 2)}`,
        '-composite',
        '-type',
        'TrueColor',
        '-quality',
        String(PREVIEW_QUALITY),
        '-strip',
        `jpeg:${output}`,
      ],
      { timeout: 120_000 },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  await access(output);
}

/** OCR of one page image. Returns the text, possibly empty. */
export async function ocrImage(
  file: string,
  lang = 'eng',
  signal?: AbortSignal,
  /** Tesseract's page segmentation: 3, found by itself; 6, one block read row by row (S5). */
  psm: '3' | '6' = '3',
): Promise<string> {
  const { stdout } = await run('tesseract', [file, '-', '-l', lang, '--psm', psm], {
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
    signal,
  });
  return stdout.replace(/\f/g, '\n').trim();
}

/**
 * OCR of one page image, as Tesseract's table of words (`tsv`): each word
 * with its box and how sure it is (0.9.0, R3; scan-read.ts lays them out).
 * The same limits as `ocrImage`.
 */
export async function ocrTsv(file: string, lang = 'eng', signal?: AbortSignal): Promise<string> {
  const { stdout } = await run('tesseract', [file, '-', '-l', lang, '--psm', '3', 'tsv'], {
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
    signal,
  });
  return stdout;
}

/**
 * The longest side, in pixels, a page is read at: an A4 page at 400 dpi.
 * A phone's photo bigger than this is made smaller to read.
 */
export const READ_MAX_SIDE = 4_700;

/**
 * A picture the vault will not read (0.9.0, R3, the review): bigger than
 * MAGICK_LIMITS allow even shrunk as it is decoded — a picture claiming to
 * be 60,000 pixels square, say. Said apart from a tool that failed.
 */
export class PictureRefused extends Error {
  readonly code = 'picture_refused';
  constructor(why: string) {
    super(`picture refused: ${why}`);
    this.name = 'PictureRefused';
  }
}

/** ImageMagick refusing a picture for its size, rather than failing on it. */
const REFUSED =
  /cache resources exhausted|exceeds (?:user )?limit|too large|pixel cache allocation failed|limit exceeded/i;

/**
 * How many pages of an uploaded picture are read: each frame of a
 * scanner's TIFF, up to `maxPages`; one of anything else. Stopped by
 * `signal`.
 */
export async function imagePageCount(
  input: string,
  mime: string,
  maxPages: number,
  signal?: AbortSignal,
): Promise<number> {
  return IMAGE_CODERS[mime] === 'tiff'
    ? Math.min(await imageFrames(input, mime, signal), maxPages)
    : 1;
}

/**
 * The most coefficients a JPEG libjpeg holds whole may have (0.9.0, R3, the
 * re-check). A JPEG in more than one scan — a progressive one, or a
 * baseline one with each colour in a scan of its own — is kept in memory as
 * all its coefficients, two bytes each, until its last scan, whatever size
 * it is decoded at, and ImageMagick's limits do not count them: a 2 MB
 * progressive CMYK JPEG 16,000 pixels square took 2.2 GB. 64 million — a
 * grey page of 64 megapixels, a colour one of 42 (its colour at a quarter,
 * as a camera's is) or 21 (in full), a CMYK one of 16 — kept the worst such
 * page read under 470 MiB, measured, as a one-scan JPEG's is.
 */
export const JPEG_HELD_MAX_COEFFICIENTS = 64_000_000;

/**
 * The most of a JPEG's start read to find its frame and first scan (R3,
 * round four): 2 MiB. What comes before a JPEG's first scan is its header —
 * its tables, a camera's EXIF, a colour profile — far less than this; a
 * header longer than it is not read on, and the picture is refused.
 */
export const JPEG_HEADER_MAX_BYTES = 2 * 1024 * 1024;

/** What a JPEG's header says libjpeg will make of it. */
export interface JpegFrame {
  width: number;
  height: number;
  /** Its coefficients: 64 an 8×8 block of each component, at its sampling. */
  coefficients: number;
  /** Whether libjpeg keeps them all at once: more than one scan. */
  held: boolean;
}

/**
 * A JPEG's frame, read from the start of its bytes (`head`) as libjpeg reads
 * its markers, up to its first scan: each segment's body skipped by its
 * length, and any bytes between markers passed over as libjpeg passes over
 * them. Null where `head` does not start with SOI — not a JPEG, which
 * libjpeg refuses at once too. `'unknown'` where it cannot say: a segment
 * that runs past `head`, a length under two, a second SOI or a frame, an
 * EOI or a scan before a frame, a frame of no height or width, or no scan
 * within `head` — so whoever asks refuses it (it fails closed: round four).
 * Synchronous and linear in `head`'s length (every step moves on at least
 * a byte, and nothing is copied): at JPEG_HEADER_MAX_BYTES, a few
 * milliseconds at worst.
 */
export function jpegFrameOf(head: Buffer): JpegFrame | null | 'unknown' {
  const n = head.length;
  if (n < 2 || head[0] !== 0xff || head[1] !== 0xd8) return null;
  let pos = 2;
  let frame: {
    width: number;
    height: number;
    comps: number;
    sampling: Array<[number, number]>;
    progressive: boolean;
  } | null = null;
  while (pos < n) {
    // The next marker: anything not 0xFF passed over, then its fill bytes.
    while (pos < n && head[pos] !== 0xff) pos += 1;
    while (pos < n && head[pos] === 0xff) pos += 1;
    if (pos >= n) return 'unknown';
    const c = head[pos] as number;
    pos += 1;
    if (c === 0x00) continue; // a stuffed 0xFF, not a marker
    if (c === 0xd8 || c === 0xd9) return 'unknown';
    if ((c >= 0xd0 && c <= 0xd7) || c === 0x01) continue; // no length
    if (pos + 2 > n) return 'unknown';
    const length = head.readUInt16BE(pos);
    if (length < 2 || pos + length > n) return 'unknown';
    if (c >= 0xc0 && c <= 0xcf && c !== 0xc4 && c !== 0xc8 && c !== 0xcc) {
      if (frame || length < 8) return 'unknown';
      const height = head.readUInt16BE(pos + 3);
      const width = head.readUInt16BE(pos + 5);
      const comps = head[pos + 7] as number;
      if (height === 0 || width === 0 || comps === 0 || length < 8 + comps * 3) {
        return 'unknown';
      }
      const sampling: Array<[number, number]> = [];
      for (let i = 0; i < comps; i += 1) {
        const hv = head[pos + 8 + i * 3 + 1] as number;
        sampling.push([Math.max(1, hv >> 4), Math.max(1, hv & 0x0f)]);
      }
      frame = {
        width,
        height,
        comps,
        sampling,
        progressive: c === 0xc2 || c === 0xc6 || c === 0xca || c === 0xce,
      };
    } else if (c === 0xda) {
      if (!frame || length < 3) return 'unknown';
      const inScan = head[pos + 2] as number;
      const hMax = Math.max(...frame.sampling.map(([h]) => h));
      const vMax = Math.max(...frame.sampling.map(([, v]) => v));
      let coefficients = 0;
      for (const [h, v] of frame.sampling) {
        const across = Math.ceil(Math.ceil((frame.width * h) / hMax) / 8);
        const down = Math.ceil(Math.ceil((frame.height * v) / vMax) / 8);
        coefficients += across * down * 64;
      }
      return {
        width: frame.width,
        height: frame.height,
        coefficients,
        held: frame.progressive || inScan < frame.comps,
      };
    }
    pos += length;
  }
  return 'unknown';
}

/**
 * A file's JPEG frame: `jpegFrameOf` its first JPEG_HEADER_MAX_BYTES, read
 * at once — never more of it, however long the file.
 */
export async function jpegFrame(file: string): Promise<JpegFrame | null | 'unknown'> {
  const fh = await open(file, 'r');
  try {
    const head = Buffer.alloc(JPEG_HEADER_MAX_BYTES);
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    return jpegFrameOf(head.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

/**
 * Refuses (PictureRefused) a JPEG ImageMagick would hand libjpeg to hold
 * whole with more than JPEG_HELD_MAX_COEFFICIENTS — and one whose header
 * cannot be read within JPEG_HEADER_MAX_BYTES, which libjpeg may still
 * decode (round four: fails closed). A file not starting as a JPEG passes:
 * libjpeg will not decode it. Asked before every ImageMagick read of an
 * uploaded JPEG: a page read (`imagePage`), a person's photo
 * (`squarePhoto`), a thumbnail and page previews.
 */
export async function refuseHeldJpeg(file: string): Promise<void> {
  refuseFrame(await jpegFrame(file));
}

/** A JPEG frame refused, or not: unreadable, or held whole past JPEG_HELD_MAX_COEFFICIENTS. */
function refuseFrame(frame: JpegFrame | null | 'unknown'): void {
  if (frame === null) return;
  if (frame === 'unknown') throw new PictureRefused('a JPEG whose header the vault cannot read');
  if (frame.held && frame.coefficients > JPEG_HELD_MAX_COEFFICIENTS) {
    throw new PictureRefused('a JPEG in more scans than the vault reads at its size');
  }
}

/**
 * Where poppler's JPEG decoder starts a picture in a PDF's DCT stream, as
 * it looks for it: the first 0xFF then 0xD8, any bytes before passed over
 * (poppler's DCTStream skips what precedes, unlike libjpeg; an 0xFF after
 * 0xFF starts the looking again, so FF FF D8 is not a start). Its offset,
 * or -1 where `head` has none.
 */
export function pdfJpegStart(head: Buffer): number {
  let marker = false;
  for (let i = 0; i < head.length; i += 1) {
    const c = head[i] as number;
    if (!marker) marker = c === 0xff;
    else if (c === 0xd8) return i - 1;
    else marker = false;
  }
  return -1;
}

/**
 * A JPEG inside a PDF, from the start of its stream (`head`, all of it when
 * `whole`): its frame, read from where poppler starts it (pdfJpegStart) as
 * libjpeg reads it. Null where it has no start at all — poppler draws
 * nothing of it; `'unknown'` where none is found in a `head` that is not
 * the whole stream, so it is refused (failing closed).
 */
export function pdfJpegFrameOf(head: Buffer, whole: boolean): JpegFrame | null | 'unknown' {
  const start = pdfJpegStart(head);
  if (start < 0) return whole ? null : 'unknown';
  return jpegFrameOf(head.subarray(start));
}

/** A row of `pdfimages -list`: its page, what it is, its size and its encoding. */
interface PdfPicture {
  page: number;
  width: number;
  height: number;
  components: number;
  bits: number;
  enc: string;
}

/** `pdfimages -list`'s rows: every picture drawn on the pages listed, a row each time it is drawn. */
export function pdfPictures(listed: string): PdfPicture[] {
  const out: PdfPicture[] = [];
  for (const row of listed.split('\n')) {
    const c = row.trim().split(/\s+/);
    if (c.length < 10 || !/^\d+$/.test(c[0] ?? '') || !/^\d+$/.test(c[1] ?? '')) continue;
    out.push({
      page: Number(c[0]),
      width: Number(c[3]),
      height: Number(c[4]),
      components: Number(c[6]),
      bits: Number(c[7]),
      enc: c[8] ?? '',
    });
  }
  return out;
}

/**
 * The most the check of a PDF's JPEGs writes at once (L2): 256 MiB. Each
 * picture it lists is written as `pdfimages -j` writes it — a JPEG as the
 * bytes it is kept as, any other decoded — but no file past
 * JPEG_HEADER_MAX_BYTES, so a picture counts as its decoded size, or that,
 * whichever is less. Pages are checked as many together as fit; a page whose
 * pictures alone are more is refused.
 */
export const PDF_CHECK_MAX_BYTES = 256 * 1024 * 1024;

/** What one listed picture may take on disk as the check writes it. */
function pictureBytes(p: PdfPicture): number {
  if (p.enc === 'jpeg') return JPEG_HEADER_MAX_BYTES;
  const decoded =
    Math.ceil((p.width * Math.max(p.components, 3) * Math.max(p.bits, 8)) / 8) * p.height;
  return Math.min(JPEG_HEADER_MAX_BYTES, (Number.isFinite(decoded) ? decoded : Infinity) + 1024);
}

/**
 * Refuses (PictureRefused) a PDF whose pages `first` to `last` draw a JPEG
 * libjpeg would hold whole past JPEG_HELD_MAX_COEFFICIENTS, or one whose
 * header cannot be read — the rule a photo's JPEG is held to
 * (refuseHeldJpeg) — before poppler draws them (L2). poppler decodes a
 * PDF's JPEGs with libjpeg, and a 3 KB PDF holding a progressive CMYK JPEG
 * 16,000 pixels square took 1,979 MiB to draw.
 *
 * The PDF's own dictionary may say a picture is any size, whatever its JPEG
 * is, and a JPEG may sit inline in a page, under another filter, or behind
 * bytes poppler passes over; so each is read from its own bytes, as poppler
 * will decode them. `pdfimages -list` says what is drawn on the pages; with
 * no JPEG, that is all. Otherwise `pdfimages -j` writes each picture into a
 * folder of its own in `workDir` — a JPEG as the bytes poppler will decode,
 * the rest decoded — no file past JPEG_HEADER_MAX_BYTES, and no more than
 * PDF_CHECK_MAX_BYTES at once; each JPEG's start is read
 * (`pdfJpegFrameOf`), and the folder removed. Both runs are poppler's, in
 * their own processes, capped (POPPLER_MAX_KIB) and timed; only the bounded
 * start of each JPEG is read here. A JPEG listed but not written, or a
 * check that failed, is refused (failing closed). A list that fails is
 * thrown as it is: nothing is drawn.
 */
export async function refusePdfHeldJpegs(
  file: string,
  first: number,
  last: number,
  workDir: string,
  signal?: AbortSignal,
): Promise<void> {
  const range = ['-f', String(first), '-l', String(last)];
  const { stdout } = await poppler('pdfimages', ['-list', ...range, file], {
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
    signal,
  });
  const pictures = pdfPictures(stdout);
  if (!pictures.some((p) => p.enc === 'jpeg')) return;
  // Pages together while they fit; a page of more than fits, refused.
  const byPage = new Map<number, PdfPicture[]>();
  for (const p of pictures) byPage.set(p.page, [...(byPage.get(p.page) ?? []), p]);
  const batches: Array<{ from: number; to: number; jpegs: number }> = [];
  let current: { from: number; to: number; jpegs: number; bytes: number } | null = null;
  for (const [page, drawn] of [...byPage].sort(([a], [b]) => a - b)) {
    const bytes = drawn.reduce((sum, p) => sum + pictureBytes(p), 0);
    const jpegs = drawn.filter((p) => p.enc === 'jpeg').length;
    if (bytes > PDF_CHECK_MAX_BYTES) {
      throw new PictureRefused('a PDF page of more pictures than the vault checks');
    }
    if (current && current.bytes + bytes <= PDF_CHECK_MAX_BYTES) {
      current.to = page;
      current.jpegs += jpegs;
      current.bytes += bytes;
    } else {
      if (current) batches.push(current);
      current = { from: page, to: page, jpegs, bytes };
    }
  }
  if (current) batches.push(current);
  for (const batch of batches) {
    if (batch.jpegs === 0) continue;
    signal?.throwIfAborted();
    const dir = await mkdtemp(path.join(workDir, 'pdf-jpegs-'));
    try {
      try {
        await poppler(
          'pdfimages',
          [
            '-j',
            '-jp2',
            '-jbig2',
            '-ccitt',
            '-f',
            String(batch.from),
            '-l',
            String(batch.to),
            file,
            path.join(dir, 'p'),
          ],
          { timeout: 60_000, signal, fileBlocks: JPEG_HEADER_MAX_BYTES / 512 },
        );
      } catch (err) {
        signal?.throwIfAborted();
        throw new PictureRefused(
          `a PDF whose JPEGs the vault cannot check (${(err as Error).message.slice(0, 80)})`,
        );
      }
      const jpegs = (await readdir(dir)).filter((f) => f.endsWith('.jpg')).sort();
      if (jpegs.length !== batch.jpegs) {
        throw new PictureRefused('a PDF whose JPEGs the vault cannot check');
      }
      for (const name of jpegs) {
        const fh = await open(path.join(dir, name), 'r');
        try {
          const head = Buffer.alloc(JPEG_HEADER_MAX_BYTES);
          const { bytesRead } = await fh.read(head, 0, head.length, 0);
          // Written whole only if shorter than the most each file may be.
          refuseFrame(pdfJpegFrameOf(head.subarray(0, bytesRead), bytesRead < head.length));
        } finally {
          await fh.close();
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/**
 * One page (`index`, from 0) of an uploaded picture as a grey PNG to read
 * (0.9.0, R3), drawn only when it is to be read, read with the coder its
 * kind names under MAGICK_LIMITS, its spill in `outDir`. Its header is
 * asked first (`-ping`, which decodes nothing), and a picture over
 * PHOTO_MAX_PIXELS, or with a side over PHOTO_MAX_SIDE, is refused there
 * (PictureRefused) — as is a JPEG libjpeg would hold whole with more than
 * JPEG_HELD_MAX_COEFFICIENTS, or whose header cannot be read
 * (`refuseHeldJpeg`) — never handed to Tesseract; one ImageMagick
 * finds too big as it reads is refused too. A JPEG longer than READ_MAX_SIDE
 * is shrunk as libjpeg decodes it (`jpeg:size`, asked for in its own
 * proportions, so neither side is ever grown): by the eighths libjpeg
 * offers, to about READ_MAX_SIDE across — a phone's 108 megapixel photo,
 * 12,000 by 9,000, is decoded at 4,500 by 3,375 and read. Turned upright by
 * its EXIF orientation (which Tesseract ignores), flattened onto white, and
 * no bigger than READ_MAX_SIDE. Stopped by `signal`.
 */
export async function imagePage(
  input: string,
  mime: string,
  outDir: string,
  index: number,
  signal?: AbortSignal,
): Promise<string> {
  const coder = IMAGE_CODERS[mime];
  if (!coder) throw new Error(`a page is not read from ${mime}`);
  const bin = await MAGICK();
  const file = path.join(outDir, `photo-${index + 1}.png`);
  const src = `${coder}:${input}[${index}]`;
  try {
    // Pinged as a range up to its frame: ImageMagick 7 pings a TIFF's later
    // frame alone as having no size.
    const sizes = (
      await identify(
        ['-ping', '-format', '%w %h\n', `${coder}:${input}[0-${index}]`],
        60_000,
        signal,
      )
    )
      .trim()
      .split('\n');
    const [w = 0, h = 0] = (sizes[index] ?? '').trim().split(/\s+/).map(Number);
    if (w * h > PHOTO_MAX_PIXELS || w > PHOTO_MAX_SIDE || h > PHOTO_MAX_SIDE) {
      throw new PictureRefused('bigger than the vault reads');
    }
    let shrink: string[] = [];
    if (coder === 'jpeg') {
      await refuseHeldJpeg(input);
      const long = Math.max(w, h);
      if (long > READ_MAX_SIDE) {
        const side = (n: number) => Math.max(1, Math.ceil((n * READ_MAX_SIDE) / long));
        shrink = ['-define', `jpeg:size=${side(w)}x${side(h)}`];
      }
    }
    await run(
      bin,
      [
        ...MAGICK_LIMITS,
        ...shrink,
        src,
        '-auto-orient',
        '-background',
        'white',
        '-alpha',
        'remove',
        '-alpha',
        'off',
        '-colorspace',
        'Gray',
        '-resize',
        `${READ_MAX_SIDE}x${READ_MAX_SIDE}>`,
        '+repage',
        '-strip',
        `png:${file}`,
      ],
      { timeout: 120_000, signal, env: { MAGICK_TEMPORARY_PATH: outDir } },
    );
  } catch (err) {
    signal?.throwIfAborted();
    if (err instanceof PictureRefused) throw err;
    const { stderr, message } = err as { stderr?: string | Buffer; message?: string };
    const said = `${stderr?.toString() ?? ''} ${message ?? ''}`;
    if (REFUSED.test(said)) throw new PictureRefused('bigger than the vault reads');
    throw err;
  }
  return file;
}

/**
 * Whether Tesseract has its orientation model (`osd`, the worker image's
 * tesseract-ocr-data-osd): asked once.
 */
let osdFound: Promise<boolean> | null = null;
export function hasOsd(): Promise<boolean> {
  osdFound ??= run('tesseract', ['--list-langs'], { timeout: 10_000 })
    .then(({ stdout, stderr }) => /^osd$/m.test(`${stdout}\n${stderr}`))
    .catch(() => false);
  return osdFound;
}

/**
 * Which way up a page reads, by Tesseract's orientation model (`--psm 0`,
 * 0.9.0 R3): the turn (clockwise, as ImageMagick's `-rotate`) that stands
 * it upright, and how sure. Null where it cannot say.
 */
export async function osdOf(
  file: string,
  signal?: AbortSignal,
): Promise<{ turn: 0 | 90 | 180 | 270; confidence: number } | null> {
  const { stdout } = await run('tesseract', [file, '-', '--psm', '0'], {
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
    signal,
  });
  const rotate = /^Rotate:\s*(\d+)/m.exec(stdout);
  const conf = /^Orientation confidence:\s*([\d.]+)/m.exec(stdout);
  if (!rotate || !conf) return null;
  const turn = Number(rotate[1]);
  if (turn !== 0 && turn !== 90 && turn !== 180 && turn !== 270) return null;
  // Tesseract's "Rotate" is the clockwise turn ImageMagick's -rotate makes
  // (measured on a page turned each way: the R3 review's round).
  return { turn, confidence: Number(conf[1]) };
}

/** A turn as ImageMagick's arguments. */
const turnArgs = (turn: 0 | 90 | 180 | 270): string[] =>
  turn === 0 ? [] : ['-rotate', String(turn)];

/**
 * A small copy of a page (a third of its size, grey), turned a quarter,
 * half or three quarters, for trying which way up it reads (0.9.0, R3).
 */
export async function smallTurned(
  input: string,
  turn: 0 | 90 | 180 | 270,
  output: string,
  signal?: AbortSignal,
): Promise<void> {
  const bin = await MAGICK();
  await run(
    bin,
    [
      ...MAGICK_LIMITS,
      `png:${input}`,
      '-colorspace',
      'Gray',
      '-resize',
      '50%',
      ...turnArgs(turn),
      `png:${output}`,
    ],
    { timeout: 60_000, signal },
  );
}

/**
 * How many degrees a page is turned off the straight (0.9.0, R3), as
 * ImageMagick's deskew measures it on a quarter-size grey copy: a crooked
 * scan's slant within a fraction of a degree, in a fraction of a second.
 * 0 where it cannot say.
 */
export async function skewOf(input: string, signal?: AbortSignal): Promise<number> {
  const bin = await MAGICK();
  const { stdout } = await run(
    bin,
    [
      ...MAGICK_LIMITS,
      `png:${input}`,
      '-colorspace',
      'Gray',
      '-resize',
      '25%',
      '-deskew',
      '40%',
      '-format',
      '%[deskew:angle]',
      'info:',
    ],
    { timeout: 60_000, signal },
  );
  const angle = Number.parseFloat(stdout.trim());
  return Number.isFinite(angle) ? angle : 0;
}

/** How a page is made ready to be read again: prepareScan's. */
export interface Preparation {
  /** A quarter, half or three-quarter turn, the way up it reads. */
  turn: 0 | 90 | 180 | 270;
  /** Degrees it is turned off the straight (skewOf's), to turn it back; 0 for none. */
  angle?: number;
  /** How much bigger to make it, 1 to 3. */
  scale: number;
  /** Each pixel the median of its 3×3 neighbours, after it is made bigger: a grainy scan's speckle out. */
  clean?: boolean;
}

/**
 * A page made ready to be read again (0.9.0, R3): turned the way up it
 * reads (and, turned, straightened by ImageMagick's deskew, its slant
 * measurable only now) or turned back by `angle`, grey, its background — a
 * phone's shadow, uneven light — divided out (the page over the paper's own
 * shade near each place: a small copy, each pixel the lightest of its
 * neighbours so the print is left out, blurred and made the page's size
 * again, so it costs little), its faint print darkened and its paper made
 * white (`-level`), then made `scale` times bigger (at most 3); to
 * `clean` it, made bigger first and its speckle taken out as S5's
 * cleanForOcr does. Under MAGICK_LIMITS.
 */
export async function prepareScan(
  input: string,
  how: Preparation,
  output: string,
  signal?: AbortSignal,
): Promise<void> {
  const bin = await MAGICK();
  const scale = Math.max(1, Math.min(3, how.scale));
  const angle = Math.max(-45, Math.min(45, how.angle ?? 0));
  const bigger = scale > 1 ? ['-resize', `${Math.round(scale * 100)}%`] : [];
  // Cleaned, as S5's cleanForOcr: made bigger, then each pixel the median of
  // its neighbours — before the contrast is stretched, which would make its
  // speckle print.
  const cleaned = how.clean ? [...bigger, '-statistic', 'Median', '3x3'] : [];
  await run(
    bin,
    [
      ...MAGICK_LIMITS,
      `png:${input}`,
      ...turnArgs(how.turn),
      '-colorspace',
      'Gray',
      '-background',
      'white',
      // Turned upright, a page's slant can be measured now: straightened.
      ...(how.turn !== 0 ? ['-deskew', '40%', '+repage'] : []),
      ...(how.turn === 0 && angle !== 0 ? ['-rotate', String(angle), '+repage'] : []),
      ...cleaned,
      '(',
      '+clone',
      '-resize',
      '4%',
      '-statistic',
      'Maximum',
      '3x3',
      '-blur',
      '0x2',
      '-resize',
      '2500%',
      ')',
      // The blurred copy back to the page's own size, whatever the rounding.
      '(',
      '-clone',
      '0',
      '-clone',
      '1',
      '-compose',
      'Copy',
      '-composite',
      ')',
      '-delete',
      '1',
      '-compose',
      'DivideSrc',
      '-composite',
      '-clamp',
      '-level',
      '25%,95%',
      // Bigger last, unless cleaned: everything before on the page's own pixels.
      ...(how.clean ? [] : bigger),
      `png:${output}`,
    ],
    { timeout: 120_000, signal },
  );
}

export async function readIfExists(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch {
    return null;
  }
}
