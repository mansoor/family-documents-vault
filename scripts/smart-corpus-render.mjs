// How smart-corpus.mjs draws its papers: a page of positioned lines, made
// into a PDF that carries its words (a downloaded statement), or into a
// picture of them — skewed, specked, grey and at a scanner's lower
// resolution — that only OCR can read. Deterministic: the same page and the
// same random numbers give the same bytes. Node's own modules only.
import { readFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';

/** An A4 page, in points. */
export const PAGE_W = 595;
export const PAGE_H = 842;

// ------------------------------------------------------------ random numbers

/**
 * Random numbers from a seed and a name (mulberry32 over FNV-1a): each
 * paper draws from its own, so one paper changed changes no other.
 */
export function randomFor(seed, name) {
  let h = 2166136261 >>> 0;
  for (const ch of `${seed}:${name}`) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let a = h;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (p) => next() < p,
    digits: (n) => Array.from({ length: n }, () => String(Math.floor(next() * 10))).join(''),
    letters: (n) =>
      Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(next() * 26))).join(''),
    /** A normal deviate (Box–Muller). */
    normal: () => {
      const u = Math.max(next(), 1e-12);
      const v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
  };
  return r;
}

// ------------------------------------------------------------------- pages

/**
 * A page being written: lines from the top, each item placed at x (points
 * from the left) on the current baseline. `family` is the typeface:
 * 'sans', 'serif' or 'mono'.
 */
export class Page {
  constructor({ size = 10.5, left = 56, top = 70, lead = 1.45 } = {}) {
    this.items = [];
    this.size = size;
    this.left = left;
    this.y = top;
    this.lead = lead;
  }

  /** Text at x on this line, the line not moved on. */
  at(x, text, o = {}) {
    if (text !== '' && text !== null && text !== undefined) {
      this.items.push({
        x,
        y: this.y,
        text: String(text),
        size: o.size ?? this.size,
        bold: !!o.bold,
        mono: !!o.mono,
      });
    }
    return this;
  }

  /** A line (or several), from the left margin unless said, then the next line. */
  line(text, o = {}) {
    for (const t of Array.isArray(text) ? text : [text]) {
      this.at(o.x ?? this.left, t, o);
      this.y += (o.size ?? this.size) * (o.lead ?? this.lead);
    }
    return this;
  }

  /** Columns on one line: [[x, text], …], then the next line. */
  row(cols, o = {}) {
    for (const [x, t] of cols) this.at(x, t, o);
    this.y += (o.size ?? this.size) * (o.lead ?? this.lead);
    return this;
  }

  gap(lines = 1) {
    this.y += this.size * this.lead * lines;
    return this;
  }

  /** The line at the foot of every made-up paper. */
  foot(text = 'Made-up document for testing the vault. Not a real document.') {
    this.y = Math.max(this.y, PAGE_H - 50);
    this.at(this.left, text, { size: 7 });
    return this;
  }
}

// ------------------------------------------------------------- PDF writing

/** Bytes of a PDF from its objects, in order; a Buffer[] object is kept as bytes. */
function pdfOf(objects) {
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let size = parts[0].length;
  const offsets = [];
  const push = (b) => {
    parts.push(b);
    size += b.length;
  };
  objects.forEach((o, i) => {
    offsets.push(size);
    push(Buffer.from(`${i + 1} 0 obj\n`, 'latin1'));
    for (const b of typeof o === 'string' ? [Buffer.from(o, 'latin1')] : o) push(b);
    push(Buffer.from('\nendobj\n', 'latin1'));
  });
  const xref = size;
  let tail = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) tail += `${String(off).padStart(10, '0')} 00000 n \n`;
  tail += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  push(Buffer.from(tail, 'latin1'));
  return Buffer.concat(parts);
}

const BASE_FONTS = {
  sans: ['Helvetica', 'Helvetica-Bold'],
  serif: ['Times-Roman', 'Times-Bold'],
  mono: ['Courier', 'Courier-Bold'],
};

/**
 * An item's size on the page: a typewriter face a little smaller, as a
 * paper set in one is, so that its wider letters keep to the columns laid
 * out for the others (a machine-readable line is set as it is).
 */
const sizeOf = (it, family) =>
  family === 'mono' && !it.mono ? Math.round(it.size * 85) / 100 : it.size;

/** A string as a PDF literal, in WinAnsi: £ and é as their own bytes. */
function literal(s) {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`;
    else if (code >= 32 && code < 127) out += ch;
    else if (code === 0xa3 || code === 0xe9) out += `\\${code.toString(8)}`;
    else out += '?';
  }
  return `(${out})`;
}

/** A PDF whose pages carry their words, in the standard fonts of `family`. */
export function textPdf(pages, family = 'sans') {
  const [regular, bold] = BASE_FONTS[family];
  // 1 catalog, 2 pages, 3 to 5 the fonts (the last for machine-readable
  // lines), then each page and its content.
  const kids = pages.map((_, i) => `${6 + 2 * i} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /${regular} /Encoding /WinAnsiEncoding >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /${bold} /Encoding /WinAnsiEncoding >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>',
  ];
  pages.forEach((page, i) => {
    const ops = page.items.map(
      (it) =>
        `BT /${it.mono ? 'F3' : it.bold ? 'F2' : 'F1'} ${sizeOf(it, family)} Tf 1 0 0 1 ${it.x} ${(PAGE_H - it.y).toFixed(2)} Tm ${literal(it.text)} Tj ET`,
    );
    const stream = ops.join('\n');
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${7 + 2 * i} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> >>`,
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    );
  });
  return pdfOf(objects);
}

// ------------------------------------------------------------ scanned pages

let glyphCache = null;

/** The glyphs (smart-corpus-glyphs.json): each font's table, its ink inflated once. */
function glyphs() {
  if (glyphCache) return glyphCache;
  const raw = JSON.parse(
    readFileSync(new URL('./smart-corpus-glyphs.json', import.meta.url), 'utf8'),
  );
  const fonts = {};
  for (const [name, f] of Object.entries(raw.fonts)) {
    const ink = inflateSync(Buffer.from(f.ink, 'base64'));
    const table = new Map();
    for (const [code, adv, left, top, w, h, offset] of f.glyphs) {
      table.set(code, { adv, left, top, w, h, offset });
    }
    fonts[name] = { ink, table };
  }
  glyphCache = { em: raw.em, fonts };
  return glyphCache;
}

/**
 * How a page is scanned: its resolution, how crooked, how grey and specked,
 * and whether the scanner kept it as black and white or as grey.
 */
export function scanLook(r, quality = 'normal') {
  const dpi = quality === 'poor' ? r.pick([100, 110, 120]) : r.pick([150, 150, 200, 200]);
  return {
    dpi,
    angle: (r.next() * 2 - 1) * (quality === 'poor' ? 2.5 : 1.6),
    paper: 0.9 + r.next() * 0.09,
    inkDark: 0.75 + r.next() * 0.22,
    noise: quality === 'poor' ? 0.06 + r.next() * 0.05 : 0.02 + r.next() * 0.04,
    specks: r.int(20, quality === 'poor' ? 900 : 300),
    shadow: r.chance(0.35),
    mono: r.chance(0.3),
    offsetX: r.int(-12, 12),
    offsetY: r.int(-10, 14),
  };
}

/** Draws a page's words as ink (0 none to 1 full) at `dpi`, in `family`. */
function inkOf(page, family, dpi, offsetX, offsetY) {
  const { em, fonts } = glyphs();
  const font = fonts[family];
  const W = Math.round((PAGE_W / 72) * dpi);
  const H = Math.round((PAGE_H / 72) * dpi);
  const ink = new Float32Array(W * H);
  const pt = dpi / 72;
  for (const it of page.items) {
    const s = (sizeOf(it, family) * pt) / em;
    let pen = it.x * pt + offsetX;
    const base = it.y * pt + offsetY;
    const f = it.mono ? fonts.mono : font;
    for (const ch of it.text) {
      const g = f.table.get(ch.codePointAt(0)) ?? f.table.get(63);
      if (g.w > 0) {
        const x0 = pen + g.left * s;
        const y0 = base + g.top * s;
        const tx0 = Math.max(0, Math.floor(x0));
        const ty0 = Math.max(0, Math.floor(y0));
        const tx1 = Math.min(W - 1, Math.ceil(x0 + g.w * s));
        const ty1 = Math.min(H - 1, Math.ceil(y0 + g.h * s));
        // Bold: the same glyph a little wider.
        const spread = it.bold ? Math.max(1, Math.round(0.05 * em * s)) : 0;
        for (let ty = ty0; ty <= ty1; ty += 1) {
          for (let tx = tx0; tx <= tx1 + spread; tx += 1) {
            if (tx >= W) break;
            // 2×2 samples a pixel, each read bilinearly from the glyph.
            let sum = 0;
            for (let q = 0; q < 4; q += 1) {
              const dx = q & 1 ? 0.75 : 0.25;
              const dy = q & 2 ? 0.75 : 0.25;
              let best = 0;
              for (let b = 0; b <= spread; b += 1) {
                const gx = (tx + dx - b - x0) / s - 0.5;
                const gy = (ty + dy - y0) / s - 0.5;
                const v = sample(f.ink, g, gx, gy);
                if (v > best) best = v;
              }
              sum += best;
            }
            const v = sum / 4;
            const at = ty * W + tx;
            if (v > ink[at]) ink[at] = v;
          }
        }
      }
      pen += g.adv * s;
    }
  }
  return { ink, W, H };
}

/** A glyph's ink at a place in it, read bilinearly; 0 outside it. */
function sample(data, g, x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const w = g.w;
  const h = g.h;
  const o = g.offset;
  const inX0 = x0 >= 0 && x0 < w;
  const inX1 = x0 + 1 >= 0 && x0 + 1 < w;
  const inY0 = y0 >= 0 && y0 < h;
  const inY1 = y0 + 1 >= 0 && y0 + 1 < h;
  const a = inX0 && inY0 ? data[o + y0 * w + x0] : 0;
  const b = inX1 && inY0 ? data[o + y0 * w + x0 + 1] : 0;
  const c = inX0 && inY1 ? data[o + (y0 + 1) * w + x0] : 0;
  const d = inX1 && inY1 ? data[o + (y0 + 1) * w + x0 + 1] : 0;
  return ((a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy) / 255;
}

let gaussCache = null;

/** 8,192 normal deviates, the same every time: a pixel's noise is one of them. */
function gaussTable() {
  if (gaussCache) return gaussCache;
  const r = randomFor(0, 'gauss');
  gaussCache = Float32Array.from({ length: 8192 }, () => r.normal());
  return gaussCache;
}

/**
 * A page as a scanner gives it: the ink turned by the page's angle, on grey
 * paper with a shadow at an edge, with noise and specks, as grey levels
 * (0 black, 255 white).
 */
function scanned(page, family, look, r) {
  const { ink, W, H } = inkOf(page, family, look.dpi, look.offsetX, look.offsetY);
  const out = new Uint8Array(W * H);
  const rad = (look.angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = W / 2;
  const cy = H / 2;
  const shadowW = Math.round(look.dpi * 0.12);
  const gauss = gaussTable();
  // A pixel's noise from a fast generator seeded from the page's numbers:
  // millions of pixels, each drawn the same way every time.
  let s = Math.floor(r.next() * 4294967295) >>> 0 || 1;
  const paper = look.paper * 255;
  const dark = look.inkDark;
  const noise = look.noise * 255;
  for (let y = 0; y < H; y += 1) {
    const dy = y - cy;
    // Where this row's first pixel was on the page before it was turned.
    let sx = cx - cx * cos + dy * sin;
    let sy = cy + cx * sin + dy * cos;
    for (let x = 0; x < W; x += 1, sx += cos, sy -= sin) {
      let k = 0;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      if (x0 >= 0 && y0 >= 0 && x0 + 1 < W && y0 + 1 < H) {
        const i = y0 * W + x0;
        const fx = sx - x0;
        const fy = sy - y0;
        k =
          (ink[i] * (1 - fx) + ink[i + 1] * fx) * (1 - fy) +
          (ink[i + W] * (1 - fx) + ink[i + W + 1] * fx) * fy;
      }
      let v = paper * (1 - k * dark);
      if (look.shadow && x < shadowW) v *= 0.35 + (0.65 * x) / shadowW;
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      v += gauss[s & 8191] * noise;
      out[y * W + x] = v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
    }
  }
  // Dust and specks: small dark blots.
  for (let n = 0; n < look.specks; n += 1) {
    const x = r.int(0, W - 3);
    const y = r.int(0, H - 3);
    const size = r.chance(0.85) ? 1 : 2;
    const dark = r.int(10, 120);
    for (let yy = 0; yy < size; yy += 1) {
      for (let xx = 0; xx < size; xx += 1) out[(y + yy) * W + x + xx] = dark;
    }
  }
  return { gray: out, W, H };
}

/** Grey levels packed as a PDF image's samples: 1 bit (black and white) or 4 bits a pixel. */
function packed(gray, W, H, mono) {
  const bits = mono ? 1 : 4;
  const rowBytes = Math.ceil((W * bits) / 8);
  const out = Buffer.alloc(rowBytes * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const g = gray[y * W + x];
      if (mono) {
        if (g >= 150) out[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
      } else {
        const q = g >> 4;
        out[y * rowBytes + (x >> 1)] |= x & 1 ? q : q << 4;
      }
    }
  }
  return { data: out, bits };
}

/**
 * A PDF of scanned pages: each page only a picture of its words, as a
 * scanner or a phone's scanning app files it — no text of its own.
 */
export function scanPdf(pages, family, looks, r) {
  const kids = pages.map((_, i) => `${3 + 3 * i} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
  ];
  pages.forEach((page, i) => {
    const look = looks[i] ?? looks[0];
    const { gray, W, H } = scanned(page, family, look, r);
    const { data, bits } = packed(gray, W, H, look.mono);
    const z = deflateSync(data, { level: 1 });
    const draw = `q ${PAGE_W} 0 0 ${PAGE_H} 0 0 cm /Im1 Do Q`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${4 + 3 * i} 0 R /Resources << /XObject << /Im1 ${5 + 3 * i} 0 R >> >> >>`,
      `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`,
      [
        Buffer.from(
          `<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceGray /BitsPerComponent ${bits} /Filter /FlateDecode /Length ${z.length} >>\nstream\n`,
          'latin1',
        ),
        z,
        Buffer.from('\nendstream', 'latin1'),
      ],
    );
  });
  return pdfOf(objects);
}
