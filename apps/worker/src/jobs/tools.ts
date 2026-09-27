import { execFile } from 'node:child_process';
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
    // A scanner's TIFF holds a page in each frame (5.18 review): each is
    // drawn, up to `maxPages`. Any other image is one page, its first frame.
    const frames = coder === 'tiff' ? Math.min(await imageFrames(input, mime), maxPages) : 1;
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
  const env = { ...process.env, MAGICK_TEMPORARY_PATH: path.dirname(output) };
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
async function identify(args: string[], timeout = 60_000): Promise<string> {
  const bin = await MAGICK();
  const [cmd, ...pre] = bin === 'magick' ? ['magick', 'identify'] : ['identify'];
  const { stdout } = await run(cmd, [...pre, ...MAGICK_LIMITS, ...args], { timeout });
  return stdout;
}

/**
 * How many pages an image holds: a TIFF from a document scanner has one a
 * frame; every other kind the vault takes is one page. At least 1.
 */
export async function imageFrames(file: string, mime: string): Promise<number> {
  const coder = IMAGE_CODERS[mime];
  if (coder !== 'tiff') return 1;
  // `%n` is the number of frames, said once for each frame.
  const out = await identify(['-format', '%n\n', `tiff:${file}`]);
  const n = Number(out.trim().split(/\s+/)[0]);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

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
 * What ImageMagick is given to write where it reads its own escapes (the
 * `label:` coder, without pango): `%` and `\` made plain — a label is the
 * family's text, and `%[…]` in it would otherwise be read as a question
 * about the image — and never an `@file`. Pango is given its text in a
 * file, which it draws as it is.
 */
export function magickText(text: string): string {
  const line = watermarkLine(text).replace(/[⁦-⁩]/g, '');
  const escaped = line.replace(/\\/g, '\\\\').replace(/%/g, '%%');
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
 * With pango the text is laid out as the family wrote it, in any script,
 * from a file (no ImageMagick escapes); without it, with the one sans-serif
 * font fontconfig gives, which draws Latin, Greek and Cyrillic.
 */
export async function watermarkPage(
  input: string,
  output: string,
  text: string,
  opts: { pango?: boolean } = {},
): Promise<void> {
  const bin = await MAGICK();
  const [width = PREVIEW_EDGE, height = PREVIEW_EDGE] = (
    await identify(['-format', '%w %h', `jpeg:${input}`])
  )
    .trim()
    .split(/\s+/)
    .map(Number);
  const clamp = (n: number, lo: number, hi: number) => Math.round(Math.max(lo, Math.min(hi, n)));
  const markSize = clamp(width / 44, 14, 44);
  const footSize = clamp(width / 48, 12, 40);
  const band = Math.round(footSize * 2.4);
  const pango = opts.pango ?? (await hasPango());
  const dir = await mkdtemp(path.join(path.dirname(output), 'wm-'));
  try {
    // The words, as the coder in use reads them.
    const textFile = path.join(dir, 'text.txt');
    await writeFile(textFile, watermarkLine(text), 'utf8');
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
            `pango:@${textFile}`,
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
    const [markWidth = 0] = (await identify(['-format', '%w %h', `png:${mark}`]))
      .trim()
      .split(/\s+/)
      .map(Number);
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
    // The line at the foot, never wider than the page.
    const footLine = path.join(dir, 'foot.png');
    await run(
      bin,
      [
        ...MAGICK_LIMITS,
        '-background',
        'white',
        ...words(footSize, '#1f1f1f'),
        '-resize',
        `${Math.max(1, width - 2 * footSize)}x>`,
        `png:${footLine}`,
      ],
      { timeout: 60_000 },
    );
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
        `${width}x${height}`,
        `tile:png:${tile}`,
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
        `+0+${Math.round((band - footSize * 1.4) / 2)}`,
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
