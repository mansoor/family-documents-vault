/**
 * Reading a scan better (0.9.0, R3): Tesseract's words with where each is on
 * the page, rather than its text alone, so that
 *
 * - a page is read **in its rows**, as pdftotext -layout reads a PDF's own
 *   text: a label and the value to its right on one line, however far apart
 *   Tesseract's blocks put them (`layoutText`) — "Payment date      12/05/2026"
 *   survives a page set in columns, and the proposal rules and the shapes a
 *   sender's papers teach (R1) see a scan as they see a text PDF;
 * - a page read **crooked** is set straight in those rows by the slant its
 *   own lines show (`pageSkew`) — or, a form's lines too short to show one,
 *   by a small copy's measure, checked against its rows (`betterSkew`);
 * - a page read **badly** — few words that look like words, words standing
 *   on their side, small or unsure letters, a slant, or a part of the page
 *   taken for a picture — is looked at again: **turned** a quarter, half or
 *   three quarters if one of those reads far better on a small copy
 *   (`bestTurn`), **straightened**, **evened out** (its background's shadow
 *   divided out), **made bigger** where its letters are small, **cleaned**
 *   of speckle where it read unsurely, and read again: kept where it reads
 *   clearly more (`readScanPage`).
 *
 * A page that reads well the first time is read once (the fast path). All
 * pixels are handled by the worker's tools in their own processes, under
 * their limits (tools.ts: MAGICK_LIMITS, Tesseract's timeout): nothing here
 * decodes a picture. What is parsed here is Tesseract's own table, bounded
 * (MAX_OCR_WORDS).
 */

/** One word as Tesseract read it: its block, paragraph and line, its box in pixels, how sure. */
export interface OcrWord {
  block: number;
  par: number;
  line: number;
  left: number;
  top: number;
  width: number;
  height: number;
  /** 0 to 100. */
  conf: number;
  text: string;
}

/** The most words taken from one page's table: far more than any page holds. */
export const MAX_OCR_WORDS = 20_000;

/** Tesseract's TSV (`tsv` output): its words, level 5, each with a box. */
export function parseTsv(tsv: string): OcrWord[] {
  return parseTsvPage(tsv).words;
}

/** A page as Tesseract read it: its words, and how much of it it took for pictures. */
export interface OcrPage {
  words: OcrWord[];
  /**
   * The share of the page, 0 to 1, in blocks Tesseract found no words in —
   * what it took for a picture: a photo's shadow, a faint corner, a logo.
   */
  unread: number;
  /** The page's size in pixels, as Tesseract gives it (0 where it does not). */
  width?: number;
  height?: number;
}

/**
 * Tesseract's TSV: its words (level 5), and its blocks (level 2) that hold
 * none, measured against the page (level 1).
 */
export function parseTsvPage(tsv: string): OcrPage {
  const out: OcrWord[] = [];
  const blocks = new Map<number, number>();
  const withWords = new Set<number>();
  let pageArea = 0;
  let pageW = 0;
  let pageH = 0;
  let at = 0;
  while (at < tsv.length && out.length < MAX_OCR_WORDS) {
    let end = tsv.indexOf('\n', at);
    if (end < 0) end = tsv.length;
    const row = tsv.slice(at, end);
    at = end + 1;
    if (row.startsWith('1\t') || row.startsWith('2\t')) {
      const c = row.split('\t');
      const [block, w, h] = [Number(c[2]), Number(c[8]), Number(c[9])];
      if (c.length < 11 || !(w > 0 && h > 0)) continue;
      if (row.startsWith('1\t')) {
        pageArea = w * h;
        pageW = w;
        pageH = h;
      } else if (blocks.size < MAX_OCR_WORDS) blocks.set(block, w * h);
      continue;
    }
    if (!row.startsWith('5\t')) continue;
    const c = row.split('\t');
    if (c.length < 12) continue;
    const text = c.slice(11).join(' ').trim();
    if (text === '') continue;
    const n = c.slice(2, 11).map(Number);
    if (n.some((v) => !Number.isFinite(v))) continue;
    const [block, par, line, , left, top, width, height, conf] = n as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    if (width <= 0 || height <= 0) continue;
    out.push({ block, par, line, left, top, width, height, conf, text });
    withWords.add(block);
  }
  let empty = 0;
  for (const [block, area] of blocks) if (!withWords.has(block)) empty += area;
  return {
    words: out,
    unread: pageArea > 0 ? Math.min(1, empty / pageArea) : 0,
    width: pageW,
    height: pageH,
  };
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};

/** A word that looks like one: three letters or more, read with some confidence. */
const GOOD_WORD = /^[("'‘“]?(?:[A-Za-z][a-z]{2,}|[A-Z]{3,})[)"'’”.,:;]?$/;
/** How sure Tesseract must be of a word for it to count as read. */
const GOOD_CONF = 60;

/** How well a page was read. */
export interface ReadingQuality {
  /** All words. */
  words: number;
  /** Words that look like words, read with some confidence. */
  good: number;
  /** Their median height in pixels (0 with none). */
  height: number;
  /** The median confidence of all words (0 with none). */
  conf: number;
  /**
   * The share of its words of four letters or more whose box is taller than
   * wide: a page lying on its side, which Tesseract reads a line at a time
   * turned, but whose words then stand in columns, not rows.
   */
  tall: number;
}

export function readingQuality(words: readonly OcrWord[]): ReadingQuality {
  const good = words.filter((w) => w.conf >= GOOD_CONF && GOOD_WORD.test(w.text));
  return {
    words: words.length,
    good: good.length,
    height: median(good.map((w) => w.height)),
    conf: median(words.map((w) => w.conf)),
    tall: (() => {
      const long = words.filter((w) => w.text.length >= 4);
      return long.length === 0
        ? 0
        : long.filter((w) => w.height > 1.5 * w.width).length / long.length;
    })(),
  };
}

/** Tesseract's lines: each line's words, left to right, in the order the lines came. */
function linesOf(words: readonly OcrWord[]): OcrWord[][] {
  const by = new Map<string, OcrWord[]>();
  for (const w of words) {
    const key = `${w.block}.${w.par}.${w.line}`;
    const on = by.get(key);
    if (on) on.push(w);
    else by.set(key, [w]);
  }
  return [...by.values()].map((l) => l.sort((a, b) => a.left - b.left));
}

/**
 * How far the page is turned off the straight, in degrees, clockwise
 * positive (its lines fall to the right): the median slope of its long
 * lines, each fitted through its words' middles. 0 where fewer than three
 * lines are long enough to say (`linesSkew`: null).
 */
export function pageSkew(words: readonly OcrWord[]): number {
  return linesSkew(words) ?? 0;
}

/** pageSkew's, or null where fewer than three lines are long enough to say: a form, a card. */
export function linesSkew(words: readonly OcrWord[]): number | null {
  const slopes: number[] = [];
  for (const line of linesOf(words)) {
    if (line.length < 3) continue;
    const first = line[0] as OcrWord;
    const last = line[line.length - 1] as OcrWord;
    const h = median(line.map((w) => w.height));
    if (last.left + last.width - first.left < 12 * h) continue;
    const xs = line.map((w) => w.left + w.width / 2);
    const ys = line.map((w) => w.top + w.height / 2);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let num = 0;
    let den = 0;
    for (let i = 0; i < xs.length; i += 1) {
      num += ((xs[i] as number) - mx) * ((ys[i] as number) - my);
      den += ((xs[i] as number) - mx) ** 2;
    }
    if (den > 0) slopes.push(num / den);
  }
  if (slopes.length < 3) return null;
  return (Math.atan(median(slopes)) * 180) / Math.PI;
}

/** The most columns a row is laid out to: pdftotext -layout's page is about this wide. */
const MAX_COLUMNS = 400;

/**
 * The page's words as text laid out as the page is (as pdftotext -layout
 * lays out a PDF's own text): straightened by `skew` degrees, Tesseract's
 * lines that sit at the same height put on one row however far apart their
 * blocks are, each word at about its place across the page, and a blank
 * line where the page has a gap. Within one of Tesseract's lines words are a
 * space apart unless the page sets them far apart.
 */
export function layoutText(words: readonly OcrWord[], skew = 0): string {
  if (words.length === 0) return '';
  const { lines, lineH } = placed(words, skew);
  // Character width: the median of the words' widths over their lengths.
  const cw = Math.max(
    1,
    median(words.filter((w) => w.text.length >= 2).map((w) => w.width / w.text.length)) ||
      median(words.map((w) => w.width)),
  );
  const rows = rowsOf(lines, lineH);
  const left = Math.min(...lines.map((l) => l.x0));
  const out: string[] = [];
  let lastY: number | null = null;
  for (const row of rows) {
    const y = median(row.map((l) => l.y));
    if (lastY !== null && y - lastY > lineH * 2.2) out.push('');
    lastY = y;
    const inRow = row.flatMap((l) => l.words).sort((a, b) => a.x - b.x);
    let text = '';
    let prev: Placed | null = null;
    for (const p of inRow) {
      const want = Math.min(MAX_COLUMNS, Math.max(0, Math.round((p.x - left) / cw)));
      if (prev === null) {
        text = ' '.repeat(want);
      } else {
        const gap = p.x - (prev.x + prev.w.width);
        const sameLine = prev.line === p.line && gap < 2.5 * cw;
        const least = sameLine ? 1 : 2;
        text += ' '.repeat(sameLine ? 1 : Math.max(least, want - text.length));
      }
      text += p.w.text;
      prev = p;
    }
    out.push(text.trimEnd());
  }
  // The page's left margin is not the text's.
  const indent = Math.min(
    ...out.filter((l) => l !== '').map((l) => l.length - l.trimStart().length),
  );
  return out.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join('\n');
}

interface Placed {
  w: OcrWord;
  x: number;
  y: number;
  line: number;
}
interface Line {
  words: Placed[];
  y: number;
  h: number;
  x0: number;
  x1: number;
  block: number;
}

/** Tesseract's lines, each word turned back by the page's slant (`skew` degrees) about its corner. */
function placed(words: readonly OcrWord[], skew: number): { lines: Line[]; lineH: number } {
  const rad = (skew * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const lines: Line[] = linesOf(words).map((l, n) => {
    const placed = l.map((w) => {
      const cx = w.left + w.width / 2;
      const cy = w.top + w.height / 2;
      // Turned back by the page's slant, about the page's corner.
      return { w, x: cx * cos + cy * sin - w.width / 2, y: cy * cos - cx * sin, line: n };
    });
    const h = median(l.map((w) => w.height));
    return {
      words: placed,
      y: median(placed.map((p) => p.y)),
      h,
      x0: Math.min(...placed.map((p) => p.x)),
      x1: Math.max(...placed.map((p) => p.x + p.w.width)),
      block: (l[0] as OcrWord).block,
    };
  });
  return { lines, lineH: Math.max(1, median(lines.map((l) => l.h))) };
}

/**
 * How far apart, in lines' heights, the middles of two of Tesseract's lines
 * may be and still share a row: lines of one block, which Tesseract parted
 * at a wide gap, as far as ROW_SAME_BLOCK; a label and a value in blocks of
 * their own only ROW_OTHER_BLOCK — a row of a sparse form a little crooked
 * would otherwise take the value of the row below (the R3 review).
 */
export const ROW_SAME_BLOCK = 0.6;
export const ROW_OTHER_BLOCK = 0.35;
/**
 * The most of Tesseract's lines one row holds: a page has a few; a crafted
 * table of thousands at one height would make every row a long search.
 */
export const MAX_LINES_A_ROW = 64;

/**
 * Rows: lines whose middles are near each other (ROW_SAME_BLOCK,
 * ROW_OTHER_BLOCK) and which do not overlap across the page, top to
 * bottom. Each row keeps its first line's middle and height, and holds at
 * most MAX_LINES_A_ROW lines, so this is linear in the lines.
 */
function rowsOf(lines: Line[], lineH: number): Line[][] {
  lines.sort((a, b) => a.y - b.y || a.x0 - b.x0);
  interface Row {
    lines: Line[];
    y: number;
    h: number;
  }
  const rows: Row[] = [];
  for (const line of lines) {
    let joined = false;
    for (let r = rows.length - 1; r >= 0 && r >= rows.length - 4; r -= 1) {
      const row = rows[r] as Row;
      if (row.lines.length >= MAX_LINES_A_ROW) continue;
      const h = Math.min(lineH, line.h, row.h);
      const sameBlock = row.lines.some((l) => l.block === line.block);
      if (Math.abs(line.y - row.y) > h * (sameBlock ? ROW_SAME_BLOCK : ROW_OTHER_BLOCK)) continue;
      if (row.lines.some((l) => line.x0 < l.x1 && l.x0 < line.x1)) continue;
      row.lines.push(line);
      joined = true;
      break;
    }
    if (!joined) rows.push({ lines: [line], y: line.y, h: line.h });
  }
  rows.sort((a, b) => a.y - b.y);
  return rows.map((r) => r.lines);
}

/**
 * How well a page's lines sit in rows when straightened by `skew`: how
 * many lines share a row with another, and how far, on average, from the
 * row's middle (in lines' heights).
 */
export function rowFit(words: readonly OcrWord[], skew: number): { joined: number; off: number } {
  const { lines, lineH } = placed(words, skew);
  let joined = 0;
  let off = 0;
  for (const row of rowsOf(lines, lineH)) {
    if (row.length < 2) continue;
    const y = median(row.map((l) => l.y));
    for (const l of row) {
      joined += 1;
      off += Math.abs(l.y - y) / lineH;
    }
  }
  return { joined, off: joined > 0 ? off / joined : 0 };
}

/**
 * Of two slants, the one the page's lines sit in rows better by: more
 * lines in a row with another (two more at least), or else nearer their
 * rows' middles. A small copy's measure of a page of little text can be a
 * degree or two out; its rows say whether it is right.
 */
export function betterSkew(words: readonly OcrWord[], a: number, b: number): number {
  if (a === b) return a;
  const fa = rowFit(words, a);
  const fb = rowFit(words, b);
  if (Math.abs(fa.joined - fb.joined) >= 2) return fa.joined > fb.joined ? a : b;
  return fb.off < fa.off ? b : a;
}

/**
 * A reading good enough to keep as it is (the fast path): many words that
 * look like words, letters big enough, and few that do not.
 */
export function readsWell(q: ReadingQuality): boolean {
  return q.good >= 12 && q.good >= q.words * 0.45 && q.height >= MIN_LETTER_HEIGHT && q.conf >= 75;
}

/**
 * Letters shorter than this (a word's box, in pixels) are read better made
 * bigger: Tesseract reads best with capitals some 25 to 35 pixels tall.
 */
export const MIN_LETTER_HEIGHT = 16;
/** How much bigger a page with small letters is made: to about this height. */
export const AIM_LETTER_HEIGHT = 32;
/** And at most this much bigger. */
export const MAX_SCALE = 3;

/**
 * Of a page's four turns, read on a small copy, the one that reads far
 * better than the page as it is: by the words that look like words, at
 * least twice as many and at least eight. 0 when none does. A page on its
 * side (`sideways`) is turned a quarter one way or the other, whichever
 * reads better, with eight words at least.
 */
export function bestTurn(
  goodByTurn: Readonly<Record<0 | 90 | 180 | 270, number>>,
  sideways = false,
): 0 | 90 | 180 | 270 {
  if (sideways) {
    const quarter = goodByTurn[270] > goodByTurn[90] ? 270 : 90;
    return goodByTurn[quarter] >= 8 ? quarter : 0;
  }
  let best: 0 | 90 | 180 | 270 = 0;
  for (const turn of [90, 180, 270] as const) {
    if (goodByTurn[turn] > goodByTurn[best]) best = turn;
  }
  if (best === 0) return 0;
  return goodByTurn[best] >= 8 && goodByTurn[best] >= 2 * goodByTurn[0] ? best : 0;
}

/** How much bigger to make a page whose letters are `height` pixels tall. */
export function scaleFor(height: number): number {
  if (height <= 0 || height >= MIN_LETTER_HEIGHT) return 1;
  return Math.min(MAX_SCALE, Math.round((AIM_LETTER_HEIGHT / height) * 10) / 10);
}

/** Of two readings, the better: more words that look like words, then surer. */
export function better(a: OcrPage, b: OcrPage): OcrPage {
  const qa = readingQuality(a.words);
  const qb = readingQuality(b.words);
  if (qb.good !== qa.good) return qb.good > qa.good ? b : a;
  return qb.conf > qa.conf ? b : a;
}

/**
 * More of the page than this taken for a picture, and it is read again
 * evened out: a phone's shadow reads as a picture, not as words.
 */
export const MAX_UNREAD = 0.15;
/**
 * A page whose lines slant this many degrees or more is read again
 * straightened; one measured past MAX_SKEW is not crooked but turned.
 */
export const MIN_SKEW = 1;
export const MAX_SKEW = 20;
/**
 * Fewer than this share of a page's words looking like words, and each
 * other way up is tried: upside down or sideways, Tesseract reads specks
 * and fragments, few of them words.
 */
export const TURN_BELOW = 0.25;
/** More than this share of its long words standing taller than wide, and a page is on its side. */
export const SIDEWAYS_ABOVE = 0.5;
/** Read less surely than this, or next to nothing read, and a page is cleaned of its speckle too. */
export const CLEAN_BELOW_CONF = 70;

/** How a page is made ready to read again: tools.ts's prepareScan's. */
export interface Preparation {
  turn: 0 | 90 | 180 | 270;
  angle?: number;
  scale: number;
  clean?: boolean;
}

/** Which way up a page reads, as Tesseract's orientation model (OSD) says, and how sure. */
export interface Orientation {
  /** The turn that stands it upright, as `Preparation.turn` turns it. */
  turn: 0 | 90 | 180 | 270;
  confidence: number;
}

/**
 * What `readScanPage` is given to work with: the tools, or a test's
 * stand-ins. Each is handed the signal of the step it is part of — the
 * read's own, or the second look's budget — and is to stop when it ends.
 */
export interface ScanTools {
  /** Tesseract's words of an image (its TSV, parsed). */
  words: (image: string, signal?: AbortSignal) => Promise<OcrPage>;
  /**
   * A small copy of an image, turned a quarter, half or three quarters (or
   * not), for trying. Without it (no ImageMagick) a page is read once.
   */
  small?: (
    image: string,
    turn: 0 | 90 | 180 | 270,
    output: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  /** How many degrees a page is turned off the straight, measured on a small copy (0 if it cannot say). */
  skew?: (image: string, signal?: AbortSignal) => Promise<number>;
  /**
   * Which way up the page reads, by Tesseract's orientation model, where the
   * worker has it (`tesseract-ocr-data-osd`); null where it cannot say.
   * Without it, each way up is tried on a small copy.
   */
  orient?: (image: string, signal?: AbortSignal) => Promise<Orientation | null>;
  /** The page made ready to read again: turned, straightened, evened out, made bigger, cleaned. */
  prepare?: (
    image: string,
    how: Preparation,
    output: string,
    signal?: AbortSignal,
  ) => Promise<void>;
}

/** How long the second look at one page may take in all: then the best reading so far stands. */
export const SECOND_LOOK_MS = 45_000;
/**
 * The most pixels a page is made ready at: a phone's 12 megapixel photo is
 * not made bigger past this, nor a big page cleaned at twice its size — under
 * MAGICK_LIMITS such a page would be refused, or run out of time.
 */
export const PREPARE_MAX_PIXELS = 24_000_000;
/** How sure Tesseract's orientation model must be for its word to be taken. */
export const OSD_MIN_CONFIDENCE = 2;
/** A slant this small or more, a small copy's measure is weighed against the page's rows. */
export const MIN_LAYOUT_SKEW = 0.3;

/** How much bigger a page `width` by `height` may be made: within PREPARE_MAX_PIXELS, and never smaller. */
export function cappedScale(scale: number, width = 0, height = 0): number {
  if (!(width > 0 && height > 0)) return scale;
  const most = Math.sqrt(PREPARE_MAX_PIXELS / (width * height));
  return Math.max(1, Math.min(scale, Math.floor(most * 10) / 10));
}

/**
 * A reading laid out in rows, straightened by its lines' slant — or, where
 * its lines are too short to show one, by `measured` (a small copy's, as
 * ImageMagick's deskew gives it: the turn that straightens it, so the
 * slant's opposite), where the page's rows say it fits.
 */
const laidOut = (page: OcrPage, measured = 0) =>
  layoutText(page.words, linesSkew(page.words) ?? betterSkew(page.words, 0, -measured));

/** How a page is read: by default with a second look; `once` for a page that is itself a second look. */
export interface ScanReadOptions {
  /** Read once, laid out: no second look (S5's cleaned copy of a page). */
  once?: boolean;
  /** The second look's budget: SECOND_LOOK_MS, unless a test shortens it. */
  budgetMs?: number;
  /**
   * When second looks end (the R3 re-check: half a version's read deadline):
   * a second look under way when it comes ends there, the best reading so
   * far kept; one after it ends before its first step, so the page is read
   * once.
   */
  until?: AbortSignal;
  /** Told when the second look has read a cleaned copy, so S5 need not clean it again. */
  onCleaned?: () => void;
}

/**
 * One drawn page or photo read as text laid out as the page is. Read once;
 * read well, that is it (the fast path). Read badly — few words that look
 * like words, small or unsure letters, lines that slant, or part of the
 * page taken for a picture — and it is looked at again, made ready: if its
 * words look wrong, which way up it reads is asked of Tesseract's
 * orientation model, or tried each way up on a small copy, and it is turned
 * so; a page the right way up is turned back by the slant a small copy
 * shows; then it is evened out, made bigger if its letters are small (never
 * past PREPARE_MAX_PIXELS), cleaned of speckle if it was read unsurely, and
 * read again — kept only if it reads clearly more (REREAD_MARGIN), and a
 * page turned always. The whole second look has one budget
 * (SECOND_LOOK_MS), and ends early when `until` does; a step of it that
 * fails, or runs past either, leaves the best reading so far. Only the
 * read's own signal ending stops it. Its words laid out in rows,
 * straightened by the slant of its lines.
 */
export async function readScanPage(
  image: string,
  tools: ScanTools,
  signal?: AbortSignal,
  opts: ScanReadOptions = {},
): Promise<string> {
  const first = await tools.words(image, signal);
  if (opts.once) return laidOut(first);
  const q = readingQuality(first.words);
  const { small, prepare } = tools;
  const budget = AbortSignal.any([
    ...(signal ? [signal] : []),
    ...(opts.until ? [opts.until] : []),
    AbortSignal.timeout(opts.budgetMs ?? SECOND_LOOK_MS),
  ]);
  /** A step of the second look: its answer, or null where it failed or ran past the budget. */
  const step = async <T>(run: () => Promise<T>): Promise<T | null> => {
    try {
      budget.throwIfAborted();
      return await new Promise<T>((resolve, reject) => {
        const stop = () => reject(budget.reason as Error);
        budget.addEventListener('abort', stop, { once: true });
        run().then(
          (v) => {
            budget.removeEventListener('abort', stop);
            resolve(v);
          },
          (e: unknown) => {
            budget.removeEventListener('abort', stop);
            reject(e instanceof Error ? e : new Error(String(e)));
          },
        );
      });
    } catch {
      // The read itself stopped: so does this. Anything else: no answer.
      signal?.throwIfAborted();
      return null;
    }
  };
  // Part of the page taken for a picture: a shadow, read again evened out.
  const partly = first.unread > MAX_UNREAD;
  // How crooked: by its lines; or, a form or a card whose lines are too
  // short to say, as a small copy shows it (its rows need it to be laid out).
  const known = linesSkew(first.words);
  let measured = 0;
  if (known === null && q.words >= 6 && tools.skew) {
    const m =
      (await step(() => (tools.skew as NonNullable<ScanTools['skew']>)(image, budget))) ?? 0;
    if (Math.abs(m) >= MIN_LAYOUT_SKEW && Math.abs(m) <= MAX_SKEW) measured = m;
  }
  const slanted = Math.abs(known ?? measured) >= MIN_SKEW;
  // On its side: Tesseract reads its lines turned, but they stand in columns.
  const sideways = q.tall > SIDEWAYS_ABOVE;
  const asItCame = () => laidOut(first, measured);
  if (
    (readsWell(q) && !partly && !slanted && !sideways) ||
    (q.words < 6 && !partly) ||
    !small ||
    !prepare
  ) {
    return asItCame();
  }
  const base = image.replace(/\.png$/i, '');
  let turn: 0 | 90 | 180 | 270 = 0;
  if (q.words >= 6 && (sideways || q.good < 8 || q.good < q.words * TURN_BELOW)) {
    // Tesseract's orientation model, where the worker has it; else each way up on a small copy.
    const said = tools.orient
      ? await step(() => (tools.orient as NonNullable<ScanTools['orient']>)(image, budget))
      : null;
    // Taken where sure — but a page on its side said to be upright or upside
    // down is tried each way up after all.
    const sideOn = said && sideways && (said.turn === 0 || said.turn === 180);
    if (said && said.confidence >= OSD_MIN_CONFIDENCE && !sideOn) {
      turn = said.turn;
    } else {
      const good: Record<0 | 90 | 180 | 270, number> = { 0: 0, 90: 0, 180: 0, 270: 0 };
      let tried = true;
      for (const t of [0, 90, 180, 270] as const) {
        const out = `${base}-turn${t}.png`;
        const read = await step(async () => {
          await small(image, t, out, budget);
          return tools.words(out, budget);
        });
        if (!read) {
          tried = false;
          break;
        }
        good[t] = readingQuality(read.words).good;
      }
      if (tried) turn = bestTurn(good, sideways);
    }
  }
  // The right way up: turned back by the slant a small copy shows.
  let angle = turn === 0 && Math.abs(measured) >= MIN_SKEW ? measured : 0;
  if (turn === 0 && angle === 0 && known !== null && Math.abs(known) >= MIN_SKEW && tools.skew) {
    const m =
      (await step(() => (tools.skew as NonNullable<ScanTools['skew']>)(image, budget))) ?? 0;
    if (Math.abs(m) >= MIN_SKEW && Math.abs(m) <= MAX_SKEW) angle = m;
  }
  // The letters' height as read upright: from the first reading, unless it was the wrong way up.
  const clean = q.words < 6 || q.conf < CLEAN_BELOW_CONF;
  const size =
    turn === 90 || turn === 270 ? [first.height, first.width] : [first.width, first.height];
  const scale = cappedScale(
    Math.max(clean ? 2 : 1, turn === 0 ? scaleFor(q.height) : 1),
    size[0],
    size[1],
  );
  /** The page made ready `how`, and read: null where either failed or ran past the budget. */
  const ready = (how: Preparation, out: string) =>
    step(async () => {
      await prepare(image, how, out, budget);
      const read = await tools.words(out, budget);
      if (how.clean) opts.onCleaned?.();
      return read;
    });
  let again = await ready({ turn, angle, scale, clean }, `${base}-ready.png`);
  if (!again) return turn !== 0 ? laidOut(first) : asItCame();
  if (turn !== 0) {
    // Turned, its letters can now be measured: made bigger too, if small.
    const s = cappedScale(scaleFor(readingQuality(again.words).height), size[0], size[1]);
    if (s > scale) {
      const bigger = await ready({ turn, scale: s, clean }, `${base}-ready2.png`);
      if (bigger) again = better(again, bigger);
    }
    // Turned, the first reading's words stood in the wrong places: the turned
    // one's, unless it read next to nothing.
    return laidOut(readingQuality(again.words).good >= 8 ? again : better(again, first));
  }
  // The page as it came is kept unless the second look reads clearly more:
  // two readings a word or two apart differ as much in which words they get
  // wrong — a name, say — as in how many.
  const clearly =
    readingQuality(again.words).good >= readingQuality(first.words).good + REREAD_MARGIN;
  return clearly ? laidOut(again) : asItCame();
}

/** How many more words that look like words a second look must read to be kept over the first. */
export const REREAD_MARGIN = 3;
