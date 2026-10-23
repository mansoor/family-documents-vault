#!/usr/bin/env node
// The scan set (0.9.0, R3): the Smart exit's made-up papers drawn again as
// the scans and phone photos a family really files — turned a quarter or
// upside down, crooked, blurred, crushed by JPEG, grainy, at 100 dpi, in a
// shadow, photographed at a slant on a table, set in two columns, or with
// the date that matters on page 2 — for measuring how well the vault reads
// scans, cause by cause.
//
//   node scripts/scan-corpus.mjs --out ./scans [--split tune|held-out|both] [--per 12]
//
// Two splits. `tune` is drawn from the first set's papers (seed 1), the
// ones the rules were adjusted on; `held-out` from the second and third
// sets' (seeds 2 and 3), which they never were. Only the tune split may be
// looked at while the reader is changed. Each split has `per` papers of each
// cause, chosen and spoilt by fixed seeds: the same options give the same
// bytes. Node's own modules only; nothing is read but the corpus scripts.
//
// manifest.json beside them says, for each file, its cause, how it was
// spoilt, its kind of file and its truth (as the Smart exit's manifest), and
// the words on the page that hold the date that matters (`date_text`).
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { smartCorpus } from './smart-corpus.mjs';
import { fmt } from './smart-corpus-papers.mjs';
import {
  gaussTable,
  inkOf,
  PAGE_H,
  PAGE_W,
  Page,
  pdfOf,
  randomFor,
  sizeOf,
} from './smart-corpus-render.mjs';

/**
 * What goes wrong with a scan, one cause a file: `clean` is a good scan
 * (the fast path's control), every other one thing a real scan suffers.
 */
export const CAUSES = [
  'clean',
  'rotated',
  'skew',
  'blur',
  'jpeg',
  'noise',
  'lowres',
  'shadow',
  'photo',
  'columns',
  'page2',
];

const SEED = { tune: [1], 'held-out': [2, 3] };
const CORPUS = { 1: 'first', 2: 'second', 3: 'third' };

// ------------------------------------------------------------ the papers

/** The lines of a page: its items grouped by baseline, top to bottom. */
function linesOf(page) {
  const byY = new Map();
  for (const it of page.items) {
    const key = Math.round(it.y * 100) / 100;
    if (!byY.has(key)) byY.set(key, []);
    byY.get(key).push(it);
  }
  return [...byY.entries()].sort((a, b) => a[0] - b[0]).map(([y, items]) => ({ y, items }));
}

/** A copy of a page with these items. */
function pageOf(items) {
  const p = new Page();
  p.items = items.map((it) => ({ ...it }));
  return p;
}

const FOOT = (l) => l.y >= PAGE_H - 52;

/** About how far a line reaches to the right, in points. */
const reach = (line, family) =>
  Math.max(
    ...line.items.map(
      (it) =>
        it.x + it.text.length * sizeOf(it, family) * (it.mono || family === 'mono' ? 0.6 : 0.52),
    ),
  );

/**
 * The page set in two columns: its heading across the top, then its body's
 * first half on the left and its second half on the right, each made small
 * enough to fit. Null where it would be too small to read.
 */
function twoColumns(page, family) {
  const lines = linesOf(page);
  const foot = lines.filter(FOOT);
  const body = lines.filter((l) => !FOOT(l));
  if (body.length < 8) return null;
  const head = body.slice(0, 2);
  const rest = body.slice(2);
  // Split at the gap nearest the middle, so a block stays whole.
  const mid = rest.length / 2;
  let at = Math.round(mid);
  let best = Infinity;
  for (let i = 2; i < rest.length - 2; i += 1) {
    const gap = rest[i].y - rest[i - 1].y;
    const lead = (rest[i - 1].items[0]?.size ?? 10) * 1.6;
    if (gap > lead && Math.abs(i - mid) < best) {
      best = Math.abs(i - mid);
      at = i;
    }
  }
  const left = rest.slice(0, at);
  const right = rest.slice(at);
  const width = (PAGE_W - 2 * 56 - 24) / 2;
  const widest = Math.max(...rest.map((l) => reach(l, family) - 56));
  const s = Math.min(1, width / widest);
  if (s < 0.62) return null;
  const top = (head.at(-1)?.y ?? 70) + 28;
  const place = (col, x0) =>
    col.flatMap((l) =>
      l.items.map((it) => ({
        ...it,
        x: x0 + (it.x - 56) * s,
        y: top + (l.y - col[0].y) * s,
        size: it.size * s,
      })),
    );
  return pageOf([
    ...head.flatMap((l) => l.items),
    ...place(left, 56),
    ...place(right, 56 + width + 24),
    ...foot.flatMap((l) => l.items),
  ]);
}

const DATE_STYLES = [
  'long',
  'longth',
  'short',
  'SHORT',
  'dashed',
  'us-long',
  'slash',
  'us-slash',
  'dots',
  'iso',
  'passport',
];

/** The text of the first item that writes `date`, in any style a paper uses; null if none. */
function dateText(pages, date) {
  if (!date) return null;
  const forms = DATE_STYLES.map((s) => fmt(date, s));
  for (const page of pages) {
    for (const it of page.items) {
      const found = forms.find((f) => it.text.includes(f));
      if (found) return { text: found, page, item: it };
    }
  }
  return null;
}

/**
 * The page as two: its date that matters, and the block it is in, moved to
 * the top of page 2 with everything after it; page 1 keeps what came
 * before. Null where too little would be left on page 1.
 */
function onPageTwo(page, item) {
  const lines = linesOf(page);
  const body = lines.filter((l) => !FOOT(l));
  const foot = lines.filter(FOOT);
  let at = body.findIndex((l) => l.items.includes(item));
  if (at < 0) return null;
  // Back to the start of its block: a label above its value goes with it.
  while (at > 0) {
    const gap = body[at].y - body[at - 1].y;
    if (gap > (body[at - 1].items[0]?.size ?? 10) * 1.6) break;
    at -= 1;
  }
  if (at < 4) return null;
  const first = body.slice(0, at);
  const second = body.slice(at);
  const shift = second[0].y - 96;
  const p1 = pageOf([
    ...first.flatMap((l) => l.items),
    { x: 56, y: PAGE_H - 70, text: 'Continued overleaf', size: 9, bold: false, mono: false },
    ...foot.flatMap((l) => l.items),
  ]);
  const p2 = pageOf([
    { x: 56, y: 60, text: 'Page 2 of 2', size: 9, bold: false, mono: false },
    ...second.flatMap((l) => l.items.map((it) => ({ ...it, y: it.y - shift }))),
    ...foot.flatMap((l) => l.items),
  ]);
  return [p1, p2];
}

// ------------------------------------------------------------- drawing

/** A grey picture: 0 black to 255 white, `w` by `h`. */
const picture = (w, h) => ({ w, h, data: new Float32Array(w * h) });

/** The 3×3 matrix taking the unit square's corners to `q` (TL, TR, BR, BL). */
function squareTo(q) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / den;
  const hh = (dx1 * sy - sx * dy1) / den;
  return [
    x1 - x0 + g * x1,
    x3 - x0 + hh * x3,
    x0,
    y1 - y0 + g * y1,
    y3 - y0 + hh * y3,
    y0,
    g,
    hh,
    1,
  ];
}

/** The inverse of a 3×3 matrix. */
function inverse(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    A / det,
    -(b * i - c * h) / det,
    (b * f - c * e) / det,
    B / det,
    (a * i - c * g) / det,
    -(a * f - c * d) / det,
    C / det,
    -(a * h - b * g) / det,
    (a * e - b * d) / det,
  ];
}

/**
 * One page drawn and spoilt as `look` says: the page's ink at its dpi,
 * turned (a quarter turn and a small angle) or photographed at a slant onto
 * a table, on paper of its shade, lit unevenly, blurred, with noise and
 * specks. Returns grey levels.
 */
export function spoil(page, family, look, r) {
  const { ink, W, H } = inkOf(page, family, look.dpi, look.offsetX ?? 0, look.offsetY ?? 0);
  const quarter = look.quarter ?? 0;
  const sideways = quarter === 90 || quarter === 270;
  let ow;
  let oh;
  let toSource;
  if (look.photo) {
    // A phone photo: the page's corners somewhere on a bigger picture.
    ow = Math.round(W * look.photo.canvas);
    oh = Math.round(H * look.photo.canvas);
    const q = look.photo.corners.map(([fx, fy]) => [fx * ow, fy * oh]);
    const fromOut = inverse(squareTo(q));
    toSource = (x, y) => {
      const den = fromOut[6] * x + fromOut[7] * y + fromOut[8];
      const u = (fromOut[0] * x + fromOut[1] * y + fromOut[2]) / den;
      const v = (fromOut[3] * x + fromOut[4] * y + fromOut[5]) / den;
      return [u * W, v * H];
    };
  } else {
    ow = sideways ? H : W;
    oh = sideways ? W : H;
    const rad = ((look.angle ?? 0) * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    toSource = (x, y) => {
      // Undo the small angle about the middle, then the quarter turn.
      const dx = x - ow / 2;
      const dy = y - oh / 2;
      const ux = ow / 2 + dx * cos + dy * sin;
      const uy = oh / 2 - dx * sin + dy * cos;
      switch (quarter) {
        case 90:
          return [uy, ow - 1 - ux];
        case 180:
          return [W - 1 - ux, H - 1 - uy];
        case 270:
          return [oh - 1 - uy, ux];
        default:
          return [ux, uy];
      }
    };
  }
  const out = picture(ow, oh);
  const paper = look.paper * 255;
  const table = (look.table ?? look.paper) * 255;
  const light = look.light ?? null;
  for (let y = 0; y < oh; y += 1) {
    for (let x = 0; x < ow; x += 1) {
      const [sx, sy] = toSource(x, y);
      let v;
      if (sx < 0 || sy < 0 || sx > W - 1 || sy > H - 1) {
        v = table;
      } else {
        const x0 = Math.min(W - 2, Math.floor(sx));
        const y0 = Math.min(H - 2, Math.floor(sy));
        const fx = sx - x0;
        const fy = sy - y0;
        const i = y0 * W + x0;
        const k =
          (ink[i] * (1 - fx) + ink[i + 1] * fx) * (1 - fy) +
          (ink[i + W] * (1 - fx) + ink[i + W + 1] * fx) * fy;
        v = paper * (1 - k * look.inkDark);
      }
      if (light) {
        // Brighter at one side than the other, and a soft shadow across a corner.
        const fx = x / ow;
        const fy = y / oh;
        let l = 1 - light.slope * (light.dx * fx + light.dy * fy);
        const d = Math.hypot(fx - light.cx, fy - light.cy);
        if (d < light.radius) l *= 1 - light.depth * (1 - d / light.radius) ** 0.6;
        v *= l;
      }
      out.data[y * ow + x] = v;
    }
  }
  if (look.blur) blur(out, look.blur);
  const gauss = gaussTable();
  let s = Math.floor(r.next() * 4294967295) >>> 0 || 1;
  const noise = (look.noise ?? 0) * 255;
  for (let i = 0; i < out.data.length; i += 1) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    out.data[i] += gauss[s & 8191] * noise;
  }
  for (let n = 0; n < (look.specks ?? 0); n += 1) {
    const x = r.int(0, ow - 3);
    const y = r.int(0, oh - 3);
    const size = r.chance(0.85) ? 1 : 2;
    const dark = r.int(10, 120);
    for (let yy = 0; yy < size; yy += 1) {
      for (let xx = 0; xx < size; xx += 1) out.data[(y + yy) * ow + x + xx] = dark;
    }
  }
  const gray = new Uint8Array(ow * oh);
  for (let i = 0; i < gray.length; i += 1) {
    const v = out.data[i];
    gray[i] = v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
  }
  return { gray, w: ow, h: oh, dpi: look.dpi };
}

/** A Gaussian blur of about `sigma` pixels: three box blurs each way. */
function blur(p, sigma) {
  const radius = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2));
  const tmp = new Float32Array(p.data.length);
  for (let pass = 0; pass < 3; pass += 1) {
    boxPass(p.data, tmp, p.w, p.h, radius, true);
    boxPass(tmp, p.data, p.w, p.h, radius, false);
  }
}

function boxPass(src, dst, w, h, r, horizontal) {
  const n = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const step = horizontal ? 1 : w;
  for (let l = 0; l < lines; l += 1) {
    const base = horizontal ? l * w : l;
    let sum = 0;
    const at = (i) => src[base + Math.min(n - 1, Math.max(0, i)) * step];
    for (let i = -r; i <= r; i += 1) sum += at(i);
    for (let i = 0; i < n; i += 1) {
      dst[base + i * step] = sum / (2 * r + 1);
      sum += at(i + r + 1) - at(i - r);
    }
  }
}

// ------------------------------------------------------------- encoding

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b) {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A grey PNG, with its resolution (pHYs) as a scanner writes it. */
export function grayPng({ gray, w, h, dpi }) {
  const chunk = (type, data) => {
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
  const phys = Buffer.alloc(9);
  const ppm = Math.round(dpi / 0.0254);
  phys.writeUInt32BE(ppm, 0);
  phys.writeUInt32BE(ppm, 4);
  phys[8] = 1;
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y += 1) raw.set(gray.subarray(y * w, (y + 1) * w), y * (w + 1) + 1);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('pHYs', phys),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
  13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52,
  45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];
const LUMA_Q = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113,
  92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_VALS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

/** A Huffman table's codes from its bits and values, by value. */
function huffman(bits, vals) {
  const codes = new Map();
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len += 1) {
    for (let i = 0; i < bits[len - 1]; i += 1) codes.set(vals[k++], { code: code++, len });
    code <<= 1;
  }
  return codes;
}

const COS = (() => {
  const t = new Float64Array(64);
  for (let x = 0; x < 8; x += 1) {
    for (let u = 0; u < 8; u += 1) t[x * 8 + u] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  }
  return t;
})();

/**
 * A grey baseline JPEG at `quality` (IJG's scale), as a phone or a cheap
 * scanner app saves one: its blocks and ringing are the artefacts.
 */
export function grayJpeg({ gray, w, h, dpi }, quality) {
  const scale = quality < 50 ? 5000 / quality : 200 - 2 * quality;
  const q = LUMA_Q.map((v) => Math.min(255, Math.max(1, Math.floor((v * scale + 50) / 100))));
  const dc = huffman(DC_BITS, DC_VALS);
  const ac = huffman(AC_BITS, AC_VALS);
  const bytes = [];
  let acc = 0;
  let nbits = 0;
  const put = (code, len) => {
    for (let i = len - 1; i >= 0; i -= 1) {
      acc = (acc << 1) | ((code >> i) & 1);
      nbits += 1;
      if (nbits === 8) {
        bytes.push(acc);
        if (acc === 0xff) bytes.push(0);
        acc = 0;
        nbits = 0;
      }
    }
  };
  const category = (v) => {
    let a = Math.abs(v);
    let n = 0;
    while (a > 0) {
      a >>= 1;
      n += 1;
    }
    return n;
  };
  const bitsOf = (v, n) => (v >= 0 ? v : v + (1 << n) - 1);
  const block = new Float64Array(64);
  const coef = new Int32Array(64);
  let prevDc = 0;
  for (let by = 0; by < h; by += 8) {
    for (let bx = 0; bx < w; bx += 8) {
      for (let y = 0; y < 8; y += 1) {
        const yy = Math.min(h - 1, by + y);
        for (let x = 0; x < 8; x += 1) {
          block[y * 8 + x] = gray[yy * w + Math.min(w - 1, bx + x)] - 128;
        }
      }
      for (let v = 0; v < 8; v += 1) {
        for (let u = 0; u < 8; u += 1) {
          let sum = 0;
          for (let y = 0; y < 8; y += 1) {
            for (let x = 0; x < 8; x += 1)
              sum += block[y * 8 + x] * COS[x * 8 + u] * COS[y * 8 + v];
          }
          const cu = u === 0 ? Math.SQRT1_2 : 1;
          const cv = v === 0 ? Math.SQRT1_2 : 1;
          coef[v * 8 + u] = Math.round((0.25 * cu * cv * sum) / q[v * 8 + u]);
        }
      }
      const diff = coef[0] - prevDc;
      prevDc = coef[0];
      const dn = category(diff);
      const d = dc.get(dn);
      put(d.code, d.len);
      if (dn > 0) put(bitsOf(diff, dn), dn);
      let run = 0;
      for (let k = 1; k < 64; k += 1) {
        const c = coef[ZIGZAG[k]];
        if (c === 0) {
          run += 1;
          continue;
        }
        while (run > 15) {
          const z = ac.get(0xf0);
          put(z.code, z.len);
          run -= 16;
        }
        const n = category(c);
        const e = ac.get((run << 4) | n);
        put(e.code, e.len);
        put(bitsOf(c, n), n);
        run = 0;
      }
      if (run > 0) {
        const eob = ac.get(0x00);
        put(eob.code, eob.len);
      }
    }
  }
  if (nbits > 0) put((1 << (8 - nbits)) - 1, 8 - nbits);
  const seg = (marker, body) => {
    const b = Buffer.alloc(4 + body.length);
    b.writeUInt16BE(marker, 0);
    b.writeUInt16BE(body.length + 2, 2);
    b.set(body, 4);
    return b;
  };
  const app0 = Buffer.alloc(14);
  app0.write('JFIF\0', 0, 'latin1');
  app0.set([1, 1, 1], 5);
  app0.writeUInt16BE(dpi, 8);
  app0.writeUInt16BE(dpi, 10);
  const dqt = Buffer.from([0, ...ZIGZAG.map((i) => q[i])]);
  const sof = Buffer.alloc(9);
  sof[0] = 8;
  sof.writeUInt16BE(h, 1);
  sof.writeUInt16BE(w, 3);
  sof.set([1, 1, 0x11, 0], 5);
  const dht = Buffer.from([0x00, ...DC_BITS, ...DC_VALS, 0x10, ...AC_BITS, ...AC_VALS]);
  const sos = Buffer.from([1, 1, 0x00, 0, 63, 0]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xffe0, app0),
    seg(0xffdb, dqt),
    seg(0xffc0, sof),
    seg(0xffc4, dht),
    seg(0xffda, sos),
    Buffer.from(bytes),
    Buffer.from([0xff, 0xd9]),
  ]);
}

/**
 * A PDF of pictures, a page each, as a scanner or a phone's scanning app
 * makes one: grey, kept losslessly or as a JPEG, its page the picture's size.
 */
export function picturePdf(shots, jpegQuality = null) {
  const kids = shots.map((_, i) => `${3 + 3 * i} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${shots.length} >>`,
  ];
  shots.forEach((shot, i) => {
    const pw = ((shot.w / shot.dpi) * 72).toFixed(2);
    const ph = ((shot.h / shot.dpi) * 72).toFixed(2);
    const body = jpegQuality ? grayJpeg(shot, jpegQuality) : deflateSync(shot.gray, { level: 6 });
    const filter = jpegQuality ? '/DCTDecode' : '/FlateDecode';
    const draw = `q ${pw} 0 0 ${ph} 0 0 cm /Im1 Do Q`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Contents ${4 + 3 * i} 0 R /Resources << /XObject << /Im1 ${5 + 3 * i} 0 R >> >> >>`,
      `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`,
      [
        Buffer.from(
          `<< /Type /XObject /Subtype /Image /Width ${shot.w} /Height ${shot.h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter ${filter} /Length ${body.length} >>\nstream\n`,
          'latin1',
        ),
        body,
        Buffer.from('\nendstream', 'latin1'),
      ],
    );
  });
  return pdfOf(objects);
}

// --------------------------------------------------------------- causes

/** A scan's usual look, which each cause then spoils one way. */
const plain = (r) => ({
  dpi: r.pick([200, 300]),
  angle: (r.next() * 2 - 1) * 0.4,
  paper: 0.92 + r.next() * 0.07,
  inkDark: 0.8 + r.next() * 0.18,
  noise: 0.015 + r.next() * 0.02,
  specks: r.int(10, 120),
  offsetX: r.int(-10, 10),
  offsetY: r.int(-8, 12),
});

/**
 * How a file of each cause is made: its look, its pages, and what kind of
 * file it is. `pages` are the paper's own; null where the paper does not
 * suit the cause (too few lines for two columns, its date not on it).
 */
function make(cause, paper, r) {
  const { pages, family } = paper;
  const look = plain(r);
  const as = (format, extra = {}) => ({ format, ...extra });
  switch (cause) {
    case 'clean':
      return { pages, look: { ...look, dpi: 300, angle: 0 }, out: as('pdf', { quality: 85 }) };
    case 'rotated':
      return {
        pages,
        look: { ...look, dpi: 200, quarter: r.pick([90, 180, 270]) },
        out: r.chance(0.5) ? as('pdf', { quality: 80 }) : as('png'),
      };
    case 'skew': {
      const angle = (r.chance(0.5) ? -1 : 1) * (1 + r.next() * 6);
      return { pages, look: { ...look, dpi: 200, angle }, out: as('pdf', { quality: 80 }) };
    }
    case 'blur':
      return { pages, look: { ...look, dpi: 200, blur: 1 + r.next() * 0.9 }, out: as('png') };
    case 'jpeg':
      return {
        pages,
        look: { ...look, dpi: r.pick([150, 200]) },
        out: as('jpeg', { quality: r.int(12, 30) }),
      };
    case 'noise':
      return {
        pages,
        look: { ...look, dpi: 200, noise: 0.1 + r.next() * 0.08, specks: r.int(1500, 4000) },
        out: as('pdf', { quality: 85 }),
      };
    case 'lowres':
      return {
        pages,
        look: { ...look, dpi: r.pick([100, 100, 110, 120, 150]), angle: (r.next() * 2 - 1) * 1 },
        out: r.chance(0.5) ? as('pdf') : as('png'),
      };
    case 'shadow':
      return {
        pages,
        look: {
          ...look,
          dpi: 200,
          paper: 0.75 + r.next() * 0.15,
          inkDark: 0.35 + r.next() * 0.25,
          light: {
            slope: 0.25 + r.next() * 0.3,
            dx: r.next(),
            dy: r.next(),
            cx: r.pick([0, 1]),
            cy: r.pick([0, 1]),
            radius: 0.5 + r.next() * 0.4,
            depth: 0.35 + r.next() * 0.25,
          },
        },
        out: as('jpeg', { quality: 85 }),
      };
    case 'photo': {
      // A phone over a table: the page a little turned and leaning away.
      const j = () => (r.next() * 2 - 1) * 0.025;
      const lean = 0.02 + r.next() * 0.05;
      const corners = [
        [0.07 + lean + j(), 0.05 + j()],
        [0.93 - lean + j(), 0.05 + j()],
        [0.95 + j(), 0.95 + j()],
        [0.05 + j(), 0.95 + j()],
      ];
      return {
        pages,
        look: {
          ...look,
          dpi: 180,
          paper: 0.85 + r.next() * 0.12,
          table: 0.25 + r.next() * 0.25,
          photo: { canvas: 1.08, corners },
          blur: 0.6 + r.next() * 0.5,
          light: {
            slope: 0.15 + r.next() * 0.2,
            dx: r.next(),
            dy: r.next(),
            cx: r.next(),
            cy: r.pick([0, 1]),
            radius: 0.4,
            depth: 0.3,
          },
        },
        out: as('jpeg', { quality: 80, dpi: 72 }),
      };
    }
    case 'columns': {
      if (pages.length !== 1) return null;
      const two = twoColumns(pages[0], family);
      return two
        ? { pages: [two], look: { ...look, dpi: 300 }, out: as('pdf', { quality: 85 }) }
        : null;
    }
    case 'page2': {
      if (pages.length !== 1) return null;
      const found = dateText(pages, paper.entry.truth.expires ?? paper.entry.truth.issued);
      const split = found ? onPageTwo(pages[0], found.item) : null;
      return split
        ? { pages: split, look: { ...look, dpi: 200 }, out: as('pdf', { quality: 80 }) }
        : null;
    }
    default:
      throw new Error(`no cause ${cause}`);
  }
}

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/** The papers a split is drawn from: every one with a page and a truth, no blank and no copy. */
function papersOf(split) {
  const out = [];
  for (const seed of SEED[split]) {
    const corpus = smartCorpus({ seed, corpus: CORPUS[seed], withPages: true });
    for (const f of corpus.files) {
      if (!f.pages || f.entry.blank || f.entry.duplicate_of || f.entry.rescan_of) continue;
      out.push({ ...f, seed });
    }
  }
  return out;
}

/**
 * One split of the scan set: `per` papers of each cause, each spoilt its
 * cause's way, in a fixed order. Every file's bytes, place and truth. With
 * `only`, only those causes' files are drawn — each the same file, at the
 * same place, as in the whole set (for a test, which has no time to draw
 * them all).
 */
export function scanSet({ split = 'tune', per = 12, only = null } = {}) {
  const pick = randomFor(`scan-set:${split}`, 'order');
  // A fixed shuffle of the papers, then each cause in turn takes the next
  // that suits it.
  const papers = papersOf(split)
    .map((p) => ({ p, k: pick.next() }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.p);
  const used = new Set();
  const files = [];
  let assigned = 0;
  for (let round = 0; round < per; round += 1) {
    for (const cause of CAUSES) {
      for (const paper of papers) {
        if (used.has(paper)) continue;
        const r = randomFor(`scan-set:${split}`, `${cause}:${paper.seed}:${paper.path}`);
        const made = make(cause, paper, r);
        if (!made) continue;
        used.add(paper);
        assigned += 1;
        if (only && !only.includes(cause)) break;
        const shots = made.pages.map((pg) => spoil(pg, paper.family, made.look, r));
        const n = String(assigned).padStart(3, '0');
        const base = `${cause}/${n}-${paper.entry.paper}`;
        let bytes;
        let mime;
        let ext;
        if (made.out.format === 'png' && shots.length === 1) {
          bytes = grayPng(shots[0]);
          mime = 'image/png';
          ext = 'png';
        } else if (made.out.format === 'jpeg' && shots.length === 1) {
          bytes = grayJpeg({ ...shots[0], dpi: made.out.dpi ?? shots[0].dpi }, made.out.quality);
          mime = 'image/jpeg';
          ext = 'jpg';
        } else {
          bytes = picturePdf(shots, made.out.quality ?? null);
          mime = 'application/pdf';
          ext = 'pdf';
        }
        const date = dateText(made.pages, paper.entry.truth.expires);
        files.push({
          path: `${base}.${ext}`,
          bytes,
          entry: {
            ...paper.entry,
            path: `${base}.${ext}`,
            sha256: sha256(bytes),
            size: bytes.length,
            folder: null,
            misfiled: false,
            mode: 'scan',
            pages: made.pages.length,
            mime,
            cause,
            split,
            from: `${CORPUS[paper.seed]}:${paper.path}`,
            look: {
              dpi: made.look.dpi,
              quarter: made.look.quarter ?? 0,
              angle: Math.round((made.look.angle ?? 0) * 100) / 100,
              blur: made.look.blur ? Math.round(made.look.blur * 100) / 100 : 0,
              noise: Math.round((made.look.noise ?? 0) * 1000) / 1000,
              quality: made.out.quality ?? null,
            },
            date_text: date ? date.text : null,
            // The page's words of four letters or more: how much of it OCR read.
            page_words: [
              ...new Set(
                made.pages.flatMap((pg) =>
                  pg.items.flatMap((it) => it.text.toLowerCase().match(/[a-z]{4,}/g) ?? []),
                ),
              ),
            ].sort(),
          },
        });
        break;
      }
    }
  }
  return { split, per, files };
}

// --------------------------------------------------------------------- CLI

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const option = (name, fallback) => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback;
  };
  const out = option('out', process.env.FDV_SCAN_SET_OUT);
  if (!out) {
    console.error('scan-corpus: say where to write it with --out <folder>.');
    process.exit(1);
  }
  const which = option('split', 'both');
  const per = Number(option('per', '12'));
  for (const split of which === 'both' ? ['tune', 'held-out'] : [which]) {
    const set = scanSet({ split, per });
    const dir = path.join(out, split);
    for (const f of set.files) {
      const to = path.join(dir, ...f.path.split('/'));
      mkdirSync(path.dirname(to), { recursive: true });
      writeFileSync(to, f.bytes);
    }
    writeFileSync(
      path.join(dir, 'manifest.json'),
      `${JSON.stringify({ split, per, files: set.files.map((f) => f.entry) }, null, 2)}\n`,
    );
    console.log(`scan-corpus: wrote ${set.files.length} ${split} scans to ${dir}`);
  }
}
