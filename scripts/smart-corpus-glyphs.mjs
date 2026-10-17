#!/usr/bin/env node
// Builds scripts/smart-corpus-glyphs.json: the letters smart-corpus.mjs draws
// its scanned pages with, so that the corpus is the same bytes wherever it
// is made, with no font or ImageMagick needed then. Each character of
// printable ASCII (and £, é), in three fonts — DejaVu Sans, DejaVu Serif and
// DejaVu Sans Mono (free fonts: https://dejavu-fonts.github.io) — drawn by
// ImageMagick at EM pixels to the em, kept as its ink (0 none, 255 full)
// cropped to where it has any, with where it sits on the line and how far
// it moves the pen on.
//
// Only needed again to change the fonts. Run where ImageMagick 7 and the
// DejaVu fonts are — the worker's image has both:
//
//   docker run --rm --entrypoint node -v "$PWD/scripts:/s" \
//     ghcr.io/mansoor/family-documents-vault/worker:<version> /s/smart-corpus-glyphs.mjs
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const EM = 56;
const FONTS = {
  sans: '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  serif: '/usr/share/fonts/dejavu/DejaVuSerif.ttf',
  mono: '/usr/share/fonts/dejavu/DejaVuSansMono.ttf',
};
const CHARS = [...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)), '£', 'é'];
const SIZE = EM * 2;
const ORIGIN_X = Math.round(EM / 2);
const BASELINE = Math.round(EM * 1.4);

/** The text as -annotate reads it: its escapes escaped. */
const annotateText = (c) => (c === '%' ? '%%' : c === '\\' ? '\\\\' : c === '@' ? '\\@' : c);

/** How far the pen moves on, from ImageMagick's metrics. */
function penFrom(log, what) {
  const origin = /origin: ([-\d.]+),/.exec(log);
  if (!origin) throw new Error(`no metrics for ${JSON.stringify(what)}`);
  return Number(origin[1]);
}

/** How far the pen moves on over some text. */
function penOf(file, text) {
  const run = spawnSync('magick', [
    '-debug',
    'annotate',
    'xc:',
    '-font',
    file,
    '-pointsize',
    String(EM),
    '-annotate',
    '0',
    text,
    'null:',
  ]);
  return penFrom(run.stderr.toString(), text);
}

const out = { em: EM, fonts: {} };
for (const [name, file] of Object.entries(FONTS)) {
  const table = [];
  const ink = [];
  let offset = 0;
  for (const c of CHARS) {
    const args = [
      '-debug',
      'annotate',
      '-size',
      `${SIZE}x${SIZE}`,
      'xc:white',
      '-font',
      file,
      '-pointsize',
      String(EM),
      '-fill',
      'black',
      '-annotate',
      `+${ORIGIN_X}+${BASELINE}`,
      annotateText(c),
      '-depth',
      '8',
      'gray:-',
    ];
    const run = spawnSync('magick', args, { maxBuffer: 1 << 24 });
    if (run.status !== 0) {
      throw new Error(`magick failed on ${JSON.stringify(c)}: ${run.stderr.toString()}`);
    }
    const raw = run.stdout;
    // The metrics, on its standard error: how far the pen moves on.
    const err = run.stderr.toString();
    const advance = c === ' ' ? penOf(file, 'x x') - penOf(file, 'xx') : penFrom(err, c);
    let x0 = SIZE;
    let y0 = SIZE;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        if (raw[y * SIZE + x] < 250) {
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
      }
    }
    if (x1 < 0) {
      table.push([c.codePointAt(0), Math.round(advance * 100) / 100, 0, 0, 0, 0, offset]);
      continue;
    }
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) ink.push(255 - raw[y * SIZE + x]);
    }
    table.push([
      c.codePointAt(0),
      Math.round(advance * 100) / 100,
      x0 - ORIGIN_X,
      y0 - BASELINE,
      w,
      h,
      offset,
    ]);
    offset += w * h;
  }
  out.fonts[name] = {
    glyphs: table,
    ink: deflateSync(Buffer.from(ink), { level: 9 }).toString('base64'),
  };
  console.log(`${name}: ${table.length} glyphs, ${offset} pixels`);
}
writeFileSync(new URL('./smart-corpus-glyphs.json', import.meta.url), `${JSON.stringify(out)}\n`);
