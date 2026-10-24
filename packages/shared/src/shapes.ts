import type { DateValue } from './documents.js';
import {
  pageText,
  type DetailProposal,
  type ProposalContext,
  type ProposalKind,
  type Proposed,
} from './proposals.js';
import type { Role } from './roles.js';
import { SHAPE_WORDS } from './shape-words.js';

/**
 * The vault learns each sender's papers from your corrections (0.9.0, R1).
 *
 * I4 (learning.ts) learns, for each issuer, the kind and the person. Most of
 * a family's papers come from the same senders month after month — the bank,
 * the surgery, the council, the insurer — and each sender lays its papers out
 * the same way each time. So the vault also learns a sender's paper **shape**:
 * what that layout is, and on it, which label carries the date or the number
 * that was filed. The next paper of that shape from that sender is read
 * right, its dates included.
 *
 * **A shape** is a fingerprint of a page's layout and wording, never of what
 * it says about anybody (`readPaper`). It is exactly:
 *
 * - **the issuer's key**, as I4 keeps it (`learnedIssuerKey`: lower case,
 *   its legal form gone) — the issuer that was filed;
 * - **its words**: the set of its heading and label words. From its first
 *   SHAPE_LINES lines: the words of a heading (a line of at most
 *   HEADING_WORDS words with no value on it), and of a label (the last
 *   SHAPE_LABEL_WORDS words before a value, in its column or the column
 *   before it) — on a line with no value, only its first column, the label's
 *   — never a row of a table (a line starting with its day, as a
 *   statement's transactions do), and never an address: a postcode's column
 *   and the lines of that column above it, and near the top an addressee's
 *   block whatever its country (short lines in one column starting with a
 *   house number or ending in a postal code, and the line above them), and
 *   what follows "Dear" or "To".
 *   Of those, only the words in SHAPE_WORDS, a fixed list of everyday
 *   layout words ("statement", "payment", "due", "date", "policy") with no
 *   common first name or surname, no value and no sensitive category in it,
 *   less any word of the name of anybody of the household — family or guest,
 *   as they are now (`withoutNames`) — or of its name; a word with a digit
 *   in it is never one. So no number, amount, month, company or place, and
 *   no name of the household's, is ever part of a shape; a stranger's name
 *   that is also a layout word ("Bank") could only be that word;
 * - **its lessons**, each a field and what was learned for it: a kind's key,
 *   a member's id, or — for the issue date, the expiry (or due date) and the
 *   number — the **label** before the value on the page, in the same words
 *   (at most SHAPE_LABEL_WORDS of them, from the list, the family's taken
 *   out), with the coarse place it was at (`band`: a band of SHAPE_BAND_LINES
 *   lines, and the left or the right of the page). "payment date", never the
 *   date; "account number", never the number.
 *
 * And for each lesson, how many times it was confirmed and contradicted.
 * Shapes are each person's own, as I4's rules are: learned from their own
 * accepts, used on their own uploads, read by them alone, sealed under their
 * own key (0075), and gone with their rules on Forget all and when they can
 * no longer add documents.
 *
 * - **Reading** (the worker, on its proposal thread): the page's shape, and
 *   every date and number on it with its label (`readPaper`). Sealed with the
 *   item's proposal, under the item's own key, as its words are: what an
 *   accept learns from, so the API never reads a page.
 * - **Matching** (`matchShape`): the uploader's shapes of the issuer the
 *   pages name (or one whose name begins with the other's), by the Jaccard
 *   similarity of their words. At SHAPE_MATCH or more it is the same layout;
 *   only at SHAPE_SURE_MATCH or more, with the pages naming that very issuer,
 *   and no runner-up within SHAPE_RUNNER_UP that says another kind or person,
 *   can it be sure. A near miss is never sure.
 * - **Using** (`applyShape`): a lesson trusted (`lessonTrusted`: confirmed
 *   SHAPE_SURE_CONFIRMATIONS times, never contradicted, and no other lesson
 *   of its field confirmed) on a sure match proposes its kind, its person
 *   and — read off this page at the label learned — its dates and its
 *   number, with the cue `learned` and `shape: true`, sure (0.9); anything
 *   less is proposed unsure (0.78), so the item is Check. A person is sure
 *   only where this page's number, read at the shape's label, hashes to one
 *   the person's lesson was taught with (`ShapeNumberHash`): two of the
 *   family with the same bank share a layout, never an account. As I4: it
 *   never replaces a proposal of the pages' that disagrees — the pages'
 *   stands, what the shape says is kept beside it (`LearnedClash`), and the
 *   item is Check, never Ready.
 * - **Learning** (`shapeLessonOf`, `teachShape`): a reviewed accept of an
 *   item that was read — never Accept all Ready, and never a kind or person
 *   from the batch's defaults alone — teaches the shape it matches at
 *   SHAPE_SURE_MATCH (or a new one), vouched for where the card was
 *   corrected or the item was at Check (a lesson needs one to be sure):
 *   the kind and the person filed, and the labels the filed dates and number
 *   are at on this page. A lesson saying what was filed is confirmed (made if
 *   it is not there); every other lesson of its field that this page
 *   disagrees with is contradicted, and one contradicted more often than
 *   confirmed goes. Taken back exactly by an Undo (`unteachShape`).
 */

/** The fields a shape learns. */
export type ShapeField = 'type_key' | 'owner_member_id' | 'issued' | 'expires' | 'identifier';
export const SHAPE_FIELDS: readonly ShapeField[] = [
  'type_key',
  'owner_member_id',
  'issued',
  'expires',
  'identifier',
];

/** A date or number on a page, with the label before it and where it is. */
export interface PaperLabelled<T> {
  /** The label's words, from SHAPE_WORDS, the family's out: "payment date". */
  label: string;
  /** Where it is, coarsely: `paperBand`. */
  band: number;
  value: T;
}

/**
 * A page as an accept learns from it: its shape's words, and its labelled
 * dates and numbers. Sealed under the item's own key, beside its proposal.
 */
export interface PaperReading {
  /** The shape's words, sorted, each once. */
  words: string[];
  dates: Array<PaperLabelled<DateValue>>;
  numbers: Array<PaperLabelled<string>>;
}

/** One thing a shape learned for a field, and how sure. */
export interface ShapeLesson {
  field: ShapeField;
  /** A kind's key, a member's id, or a label's words. */
  value: string;
  /** For a label: where it was last found (`paperBand`). */
  band: number | null;
  /** Confirmed by a reviewed accept (`shapeLessonOf`). */
  confirmed: number;
  contradicted: number;
  /**
   * Of the confirmations, how many came from a correction or an item that
   * was at Check (the R1 review, W2): a lesson needs one to be sure. Absent
   * is none.
   */
  vouched?: number;
  /**
   * For a person: keyed hashes of the numbers filed with the papers that
   * taught it (`ShapeNumberHash`, the R1 review, W1) — each once for each
   * paper filed with it, up to SHAPE_SURE_CONFIRMATIONS times, and at most
   * SHAPE_PERSON_NUMBERS of them. A person is sure only on a page whose
   * number, read at the shape's label, is one of them; and a shape several
   * of the family's accounts taught proposes the one whose account it is.
   */
  numbers?: string[];
  /**
   * For a person: papers with a number filed for somebody else whose
   * number this lesson has never held (the R1 re-check, N3). Each
   * SHAPE_DRIFT of them weighs as one contradiction toward unlearning it,
   * never toward whether it is sure. Absent is none.
   */
  drift?: number;
}

/** A shape, as the worker uses it. */
export interface LearnedShape {
  issuer: string;
  words: readonly string[];
  lessons: readonly ShapeLesson[];
}

/** A shape as a store keeps it: its id and the day it was last taught. */
export interface KeptShape {
  id: string;
  issuer: string;
  words: string[];
  lessons: ShapeLesson[];
  /** YYYY-MM-DD. */
  last_used: string;
}

/** The lines a shape's words are read from: the details are at the top of a paper. */
export const SHAPE_LINES = 150;
/** The most words a shape keeps. */
export const SHAPE_WORDS_MAX = 300;
/** Fewer words than this, and a page has no shape: a near-blank page says nothing. */
export const SHAPE_MIN_WORDS = 8;
/** The most words of a label kept: the last ones before its value. */
export const SHAPE_LABEL_WORDS = 4;
/** A band is this many lines. */
export const SHAPE_BAND_LINES = 6;
/** The most bands down a page: anything lower is the last. */
export const SHAPE_BANDS_DOWN = 32;
/** A value starting this far along its line is on the right of the page. */
export const SHAPE_RIGHT_COLUMN = 45;
/** Similar this much (Jaccard of words) and the same issuer: the same layout, unsure. */
export const SHAPE_MATCH = 0.5;
/** Similar this much, and the pages naming the issuer: the same layout, and it may be sure. */
export const SHAPE_SURE_MATCH = 0.8;
/** Confirmed this many times and never contradicted, and a lesson is sure. */
export const SHAPE_SURE_CONFIRMATIONS = 3;
/** A sure lesson's proposal: over ITEM_SURE (as I4's LEARNED_SURE_CONFIDENCE). */
export const SHAPE_SURE_CONFIDENCE = 0.9;
/** Anything less: shown, unsure (as I4's LEARNED_CONFIDENCE). */
export const SHAPE_CONFIDENCE = 0.78;
/** The most shapes one person keeps: past it, the least used go. */
export const SHAPES_MAX = 200;
/** The most lessons one shape keeps. */
export const SHAPE_LESSONS_MAX = 24;
/** The most dates and numbers a page's reading keeps. */
export const PAPER_DATES_MAX = 120;
export const PAPER_NUMBERS_MAX = 60;
/** The most numbers' hashes a person's lesson keeps. */
export const SHAPE_PERSON_NUMBERS = 8;
/** Papers of other accounts that weigh as one contradiction against a person's lesson (N3). */
export const SHAPE_DRIFT = 3;
/** A runner-up this close to the best match, saying otherwise, and the match is unsure (W3). */
export const SHAPE_RUNNER_UP = 0.1;

/**
 * A keyed hash of a number (the R1 review, W1), so that a shape can tell
 * one person's account from another's without keeping either: the API's
 * and the worker's thread's, under a key derived from the person's member
 * key (@fdv/crypto `shapeNumberKey`). Given the number as `plainNumber`
 * makes it. Without one, a shape's person is never sure.
 */
export type ShapeNumberHash = (plain: string) => string;

/** A number as it is compared and hashed: no spaces or dashes, in capitals. */
export const plainNumber = (v: string) => v.replace(/[\s-]/g, '').toUpperCase();

/** The longest label kept, and the longest number. */
const LABEL_MAX = 80;
const NUMBER_MAX = 40;
/** The longest word kept. */
const WORD_MAX = 24;

// ------------------------------------------------------------- reading

/**
 * The household's own words: its people's names — the family's and its
 * guests' — and its own name, a word at a time.
 */
export function familyWords(
  ctx: Pick<ProposalContext, 'people' | 'household' | 'guests'>,
): Set<string> {
  const out = new Set<string>();
  const add = (s: string | null | undefined) => {
    for (const w of (s ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .split(/[^a-z]+/)) {
      if (w.length >= 2) out.add(w);
    }
  };
  for (const p of ctx.people) add(p.name);
  for (const p of ctx.guests ?? []) add(p.name);
  // The household's name, but for what every household is called by.
  for (const w of familyName(ctx.household)) out.add(w);
  return out;
}

/** "The Khan family": its words but "the" and "family", which say nobody. */
function familyName(name: string | null | undefined): string[] {
  return (name ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 2 && !HOUSEHOLD_WORDS.has(w));
}
const HOUSEHOLD_WORDS = new Set(['the', 'family', 'household', 'and', 'of']);

/** The words of some text a shape may keep, in order: from the list, never the family's. */
function keptWords(text: string, family: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const token of text.split(/[\s,;:()[\]{}"|]+/)) {
    // A token with a digit in it is a number, a reference, a postcode, an amount.
    if (token === '' || /\d/.test(token)) continue;
    for (const w of token.split(/[^a-z]+/)) {
      if (w.length < 2 || w.length > WORD_MAX) continue;
      if (SHAPE_WORDS.has(w) && !family.has(w)) out.push(w);
    }
  }
  return out;
}

/** A label from its words: the last SHAPE_LABEL_WORDS of them; '' for none. */
function labelOf(text: string, family: ReadonlySet<string>): string {
  const w = keptWords(text, family);
  return w.slice(-SHAPE_LABEL_WORDS).join(' ').slice(0, LABEL_MAX);
}

/** Where columns part on a line: runs of three spaces or more (pdftotext -layout). */
function segments(line: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const re = / {3,}|\t/g;
  let from = 0;
  for (const m of line.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > from) out.push({ start: from, end: at });
    from = at + m[0].length;
    if (out.length > 40) break;
  }
  if (from < line.length) out.push({ start: from, end: line.length });
  return out;
}

/** A value's coarse place: its band of lines down the page, and left or right. */
export function paperBand(line: number, col: number): number {
  const down = Math.min(SHAPE_BANDS_DOWN - 1, Math.floor(line / SHAPE_BAND_LINES));
  return down * 2 + (col >= SHAPE_RIGHT_COLUMN ? 1 : 0);
}

/**
 * The label of a value at `col`–`end` on `line`: the words before it in its
 * column; else the column before it on its line; else, for a value alone in
 * its column, the column above it (a row of labels over a row of values).
 */
function labelAt(
  folded: readonly string[],
  line: number,
  col: number,
  family: ReadonlySet<string>,
  taken: (line: number, col: number) => boolean,
): string {
  const text = folded[line] ?? '';
  const segs = segments(text);
  const i = segs.findIndex((s) => s.start <= col && col < s.end);
  const seg = segs[i];
  if (seg) {
    const before = labelOf(text.slice(seg.start, col), family);
    if (before) return before;
    const prev = segs[i - 1];
    if (prev && !taken(line, prev.start)) {
      const left = labelOf(text.slice(prev.start, prev.end), family);
      if (left) return left;
    }
  }
  // The column above: the nearest line up with words, within two.
  const start = seg?.start ?? col;
  for (let up = line - 1; up >= Math.max(0, line - 2); up -= 1) {
    const above = folded[up] ?? '';
    if (above.trim() === '') continue;
    const near = segments(above)
      .filter((s) => Math.abs(s.start - start) <= 12 || (s.start <= start && start < s.end))
      .sort((a, b) => Math.abs(a.start - start) - Math.abs(b.start - start))[0];
    if (near && !taken(up, near.start)) return labelOf(above.slice(near.start, near.end), family);
    return '';
  }
  return '';
}

const AMOUNT = /^[£$€]|^\d{1,3}(?:,\d{3})*\.\d{2}$|^\d+\.\d{2}$/;
/** A line that starts with a day ("01 Sep", "12/03"): a row of a table. */
const TABLE_ROW = /^\s*\d{1,2}(?:[ ./-](?:\d{1,2}\b|[a-z]{3}))/;
/** A line of no more words than this, with no value on it, is a heading. */
const HEADING_WORDS = 8;
/** A UK postcode: the last line of an address. */
const POSTCODE = /\b[a-z]{1,2}\d[a-z\d]? ?\d[a-z]{2}\b/;
/** The most lines of an address above its postcode. */
const ADDRESS_LINES = 5;
const NUMBER_START = /[A-Za-z0-9]/;
/** The lines near the top an addressee's block is looked for in. */
const ADDRESSEE_LINES = 30;
/** A postal code that ends an address: a UK postcode, a US ZIP (with its state), a Canadian or a European one. */
const POSTAL =
  /\b[a-z]{1,2}\d[a-z\d]? ?\d[a-z]{2}\b|\b[a-z]{2} \d{5}(?:-\d{4})?\b|\b[a-z]\d[a-z] ?\d[a-z]\d\b|\b\d{4,5} [a-z]{3,}/;
/** A line starting with a house number: "14 Elm Street", "1420 Maple Avenue", "Flat 3". */
const HOUSE =
  /^(?:flat |apt |apartment |unit )?\d{1,5}[a-z]?,? (?!jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]/;
const NUMBER_CHAR = /[A-Za-z0-9 \-/.]/;

/**
 * Where a column's value starts: the first word of the run of a number's
 * characters (letters, digits, spaces, - / .) that ends it, that run having
 * a digit; -1 for none. One pass from the end, then one forward. A word of
 * letters alone that is a label word (SHAPE_WORDS) is the label's, not the
 * value's: on a line set out with single spaces ("Account number NW 4417"),
 * the value is "NW 4417" (the R1 re-check).
 */
function valueStart(part: string): number {
  let i = part.length;
  while (i > 0 && NUMBER_CHAR.test(part.charAt(i - 1))) i -= 1;
  const run = part.slice(i);
  if (!/\d/.test(run)) return -1;
  // Its first word: the start of the run, or after a space in it.
  for (let at = i; at < part.length; at += 1) {
    const c = part.charAt(at);
    if (/[A-Za-z0-9]/.test(c) && (at === i || part.charAt(at - 1) === ' ')) {
      // Past the label's own words, so long as a digit is still to come.
      let from = at;
      for (;;) {
        const space = part.indexOf(' ', from);
        if (space === -1) break;
        const word = part.slice(from, space);
        if (!/^[A-Za-z]+$/.test(word) || !SHAPE_WORDS.has(word.toLowerCase())) break;
        let next = space;
        while (part.charAt(next) === ' ') next += 1;
        if (!/\d/.test(part.slice(next))) break;
        from = next;
      }
      return /\d/.test(part.slice(from)) ? from : -1;
    }
  }
  return -1;
}

/**
 * An address's block whose column starts near `start` on line `n`: two to
 * six short lines (at most 6 words each) in that column, the first with a
 * house number or the last with a postal code — and the line above it, its
 * addressee. Null for none.
 */
function addressRun(
  lines: readonly string[],
  n: number,
  start: number,
): Array<[number, { start: number; end: number }]> | null {
  const run: Array<[number, { start: number; end: number }]> = [];
  for (let at = n; at < Math.min(lines.length, n + 6); at += 1) {
    const seg = segments(lines[at] ?? '').find((s) => Math.abs(s.start - start) <= 3);
    if (!seg) break;
    const text = (lines[at] ?? '').slice(seg.start, seg.end).trim();
    if (text === '' || text.startsWith('#') || text.split(/\s+/).length > 6) break;
    run.push([at, seg]);
  }
  if (run.length < 2) return null;
  const textOf = ([at, s]: [number, { start: number; end: number }]) =>
    (lines[at] ?? '').slice(s.start, s.end).trim();
  const firstLine = run[0] as [number, { start: number; end: number }];
  const ends = run.findIndex((r) => POSTAL.test(textOf(r)));
  if (!HOUSE.test(textOf(firstLine)) && ends === -1) return null;
  const block = ends === -1 ? run : run.slice(0, ends + 1);
  const above =
    n > 0 ? segments(lines[n - 1] ?? '').find((s) => Math.abs(s.start - start) <= 3) : undefined;
  if (above) block.unshift([n - 1, above]);
  return block;
}

/**
 * A page read for its shape (0.9.0, R1): its words, and each date and each
 * number on it with the label it is under. Pure and bounded — the page as
 * `proposeDetails` reads it (`pageText`), at most PAPER_DATES_MAX dates and
 * PAPER_NUMBERS_MAX numbers — and run where the proposals are, on the
 * worker's proposal thread.
 */
export function readPaper(
  text: string,
  ctx: Pick<ProposalContext, 'people' | 'household' | 'dateOrder' | 'guests'>,
): PaperReading {
  const family = familyWords(ctx);
  const page = pageText(text, ctx.dateOrder);
  const marked = page.folded.slice();
  // An address — its postcode's column, and the lines of that column above
  // it — is no part of a shape, whatever its words (a "Bank Street").
  const blank = (line: number, seg: { start: number; end: number }) => {
    const text = marked[line] ?? '';
    marked[line] =
      `${text.slice(0, seg.start)}${'#'.repeat(seg.end - seg.start)}${text.slice(seg.end)}`;
  };
  for (const [n, line] of page.folded.entries()) {
    if (n >= SHAPE_LINES) break;
    const at = line.search(POSTCODE);
    if (at === -1) continue;
    const segs = segments(line);
    const own = segs.find((s) => s.start <= at && at < s.end);
    if (!own) continue;
    blank(n, own);
    for (let up = n - 1; up >= Math.max(0, n - ADDRESS_LINES); up -= 1) {
      const above = segments(marked[up] ?? '').find((s) => Math.abs(s.start - own.start) <= 3);
      if (!above) break;
      blank(up, above);
    }
  }
  // And the addressee's block near the top, postcode or none (the R1
  // review, P2): the lines after "Dear" or "To", and a run of short lines
  // in one column ending in a postal code of any country, or starting with
  // a house number.
  for (const [n, line] of page.folded.entries()) {
    if (n >= ADDRESSEE_LINES) break;
    for (const seg of segments(line)) {
      const part = line.slice(seg.start, seg.end).trim();
      if (/^(?:dear|to)\b/.test(part)) blank(n, seg);
    }
  }
  for (let n = 0; n < Math.min(ADDRESSEE_LINES, page.folded.length); n += 1) {
    for (const seg of segments(marked[n] ?? '')) {
      const run = addressRun(marked, n, seg.start);
      if (!run) continue;
      for (const [at, s] of run) blank(at, s);
    }
  }
  page.folded = marked;
  const words = new Set<string>();
  const add = (s: string, most = Infinity) => {
    for (const w of keptWords(s, family).slice(-most)) {
      if (words.size < SHAPE_WORDS_MAX) words.add(w);
    }
  };
  for (const line of page.folded.slice(0, SHAPE_LINES)) {
    // A row of a table (a statement's, a bill's readings) starts with its
    // day: what it says changes each time, and is no part of the layout.
    if (TABLE_ROW.test(line)) continue;
    if (!/\d/.test(line)) {
      // A heading: short, and with no value on it. Where it parts into
      // columns, only the first, the label's: the others are its values
      // ("Status    Single", the R1 review, P1).
      const first = segments(line)[0];
      const head = first ? line.slice(first.start, first.end) : '';
      if (head.trim().split(/\s+/).length <= HEADING_WORDS) add(head);
      continue;
    }
    // A label: the words before a value, in its column or the column before it.
    const segs = segments(line);
    for (const [i, seg] of segs.entries()) {
      const part = line.slice(seg.start, seg.end);
      const digit = part.search(/\d|£|\$|€/);
      if (digit > 0) add(part.slice(0, digit), SHAPE_LABEL_WORDS);
      else if (digit === -1 && /^\s*[\d£$€]/.test(line.slice(segs[i + 1]?.start ?? line.length))) {
        add(part, SHAPE_LABEL_WORDS);
      }
    }
  }
  // Where each date is, so a date is never a number, nor another's label.
  const dateAt = new Map<number, Array<{ col: number; end: number }>>();
  for (const d of page.dates) {
    const on = dateAt.get(d.line) ?? [];
    on.push({ col: d.col, end: d.end });
    dateAt.set(d.line, on);
  }
  const isDate = (line: number, col: number) =>
    (dateAt.get(line) ?? []).some((d) => d.col <= col && col < d.end);
  const hasValue = (line: number, from: number) => {
    const text = page.folded[line] ?? '';
    const seg = segments(text).find((s) => s.start === from);
    return !!seg && /\d/.test(text.slice(seg.start, seg.end));
  };

  const dates: Array<PaperLabelled<DateValue>> = [];
  for (const d of page.dates) {
    if (dates.length >= PAPER_DATES_MAX) break;
    const label = labelAt(page.folded, d.line, d.col, family, hasValue);
    if (label) dates.push({ label, band: paperBand(d.line, d.col), value: d.value });
  }

  const numbers: Array<PaperLabelled<string>> = [];
  for (const [n, folded] of page.folded.entries()) {
    if (numbers.length >= PAPER_NUMBERS_MAX || n >= SHAPE_LINES) break;
    const line = page.lines[n] ?? '';
    for (const seg of segments(folded)) {
      if (numbers.length >= PAPER_NUMBERS_MAX) break;
      // The value: the run of a number's characters that ends the column,
      // from its first word — found in one pass, never by a pattern that
      // backtracks (the R1 review, PERF1).
      const part = line.slice(seg.start, seg.end);
      const from = valueStart(part);
      if (from === -1) continue;
      const value = part.slice(from).trim();
      const at = seg.start + from;
      if (!NUMBER_START.test(value) || value.length > NUMBER_MAX) continue;
      if ((value.match(/\d/g) ?? []).length < 4 || AMOUNT.test(value)) continue;
      if (isDate(n, at) || isDate(n, at + value.length - 1)) continue;
      const label = labelAt(page.folded, n, at, family, hasValue);
      if (label) numbers.push({ label, band: paperBand(n, at), value });
    }
  }
  // And the labels of its dates and numbers: a shape's own labels.
  for (const d of [...dates, ...numbers]) add(d.label);
  return { words: [...words].sort(), dates, numbers };
}

// ------------------------------------------------------------ matching

/** The Jaccard similarity of two shapes' words: what they share over what either has. */
export function shapeSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const bs = new Set(b);
  let both = 0;
  for (const w of new Set(a)) if (bs.has(w)) both += 1;
  return both / (new Set(a).size + bs.size - both);
}

/** The same issuer: the same key, or one beginning with the other's words ("northgate" of "northgate building society"). */
export function issuerMatches(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `);
}

/** A shape a page matches, how similar it is, and whether the match can be sure. */
export interface ShapeMatch<S extends LearnedShape = LearnedShape> {
  shape: S;
  similarity: number;
  /** The pages name its issuer, and it is SHAPE_SURE_MATCH similar or more. */
  sure: boolean;
}

/**
 * The shape a page is (`readPaper`'s words), of the uploader's: the most
 * similar of the issuer's the pages name, at SHAPE_MATCH or more; sure only
 * at SHAPE_SURE_MATCH. Where the pages name no issuer, only one shape at
 * SHAPE_SURE_MATCH, of whatever issuer, is matched — and never sure. Two
 * as similar as each other are no answer.
 */
export function matchShape<S extends LearnedShape>(
  paper: Pick<PaperReading, 'words'>,
  pageIssuer: string,
  shapes: readonly S[],
): ShapeMatch<S> | null {
  if (paper.words.length < SHAPE_MIN_WORDS) return null;
  const scored = shapes
    .filter((s) => (pageIssuer ? issuerMatches(pageIssuer, s.issuer) : true))
    .map((s) => ({ shape: s, similarity: shapeSimilarity(paper.words, s.words) }))
    .filter((m) => m.similarity >= (pageIssuer ? SHAPE_MATCH : SHAPE_SURE_MATCH))
    .sort((a, b) => b.similarity - a.similarity);
  const [best, next] = scored;
  if (!best) return null;
  if (next && next.similarity === best.similarity && next.shape.issuer !== best.shape.issuer) {
    return null;
  }
  // A runner-up nearly as close that says another kind or person: which of
  // the two this page is, is not sure (the R1 review, W3).
  const rival =
    !!next &&
    best.similarity - next.similarity <= SHAPE_RUNNER_UP &&
    (['type_key', 'owner_member_id'] as const).some((f) => {
      const a = bestLesson(best.shape, f, () => true)?.value;
      const b = bestLesson(next.shape, f, () => true)?.value;
      return a !== undefined && b !== undefined && a !== b;
    });
  return {
    shape: best.shape,
    similarity: Math.round(best.similarity * 1000) / 1000,
    // Sure only with the pages naming this very issuer, not one that begins
    // with it (the R1 review, W4).
    sure: pageIssuer === best.shape.issuer && best.similarity >= SHAPE_SURE_MATCH && !rival,
  };
}

/**
 * A lesson's own counts are enough: confirmed enough by reviewed accepts,
 * at least one of them a correction or an item at Check (the R1 review,
 * W2), and never contradicted.
 */
export const lessonSure = (
  l: Pick<ShapeLesson, 'confirmed' | 'contradicted' | 'vouched'>,
): boolean =>
  l.confirmed >= SHAPE_SURE_CONFIRMATIONS && l.contradicted === 0 && (l.vouched ?? 0) >= 1;

/** How many papers filed with this number's hash taught a person's lesson (at most SHAPE_SURE_CONFIRMATIONS). */
const timesIn = (numbers: readonly string[] | undefined, hash: string) =>
  (numbers ?? []).filter((n) => n === hash).length;

/** A lesson's confirmations net of its contradictions, the weak ones weighed (N3). */
const net = (l: Pick<ShapeLesson, 'confirmed' | 'contradicted' | 'drift'>) =>
  l.confirmed - l.contradicted - Math.floor((l.drift ?? 0) / SHAPE_DRIFT);

/** Labels may both be right (a date under two); a kind or a person is one or the other. */
const exclusive = (f: ShapeField) => f === 'type_key' || f === 'owner_member_id';

/**
 * A lesson trusted: sure by its own counts (`lessonSure`), and — for the
 * kind and the person — no other lesson of its field in its shape confirmed
 * (as I4's `ruleTrusted`).
 */
export function lessonTrusted(lesson: ShapeLesson, shape: Pick<LearnedShape, 'lessons'>): boolean {
  if (!lessonSure(lesson)) return false;
  if (!exclusive(lesson.field)) return true;
  return !shape.lessons.some(
    (l) => l.field === lesson.field && l.value !== lesson.value && l.confirmed > 0,
  );
}

/** The one lesson of a field to use: the most confirmed net of contradictions, strictly ahead. */
function bestLesson(
  shape: LearnedShape,
  field: ShapeField,
  usable: (value: string) => boolean,
): ShapeLesson | null {
  const mine = shape.lessons
    .filter((l) => l.field === field && usable(l.value) && net(l) > 0)
    .sort((a, b) => net(b) - net(a) || b.confirmed - a.confirmed);
  const [best, next] = mine;
  if (!best) return null;
  if (next && net(next) === net(best)) return null;
  return best;
}

// ------------------------------------------------------------- using

/** Where a sure lesson of a shape disagreed with the pages (beside I4's LearnedClash). */
export interface ShapeClash {
  type_key?: string;
  owner_member_id?: string;
  /** The date the shape's label gives (YYYY-MM-DD). */
  issued?: string;
  expires?: string;
  /** That a number differs: never the number. */
  identifier?: 'differs';
}

const round = (n: number) => Math.round(n * 100) / 100;

/** A proposal made surer by a shape: its page confidence kept beside it (the I4 review, I4-4). */
function raised<T>(p: Proposed<T>, sure: boolean): Proposed<T> {
  const to = sure ? Math.max(p.confidence, SHAPE_SURE_CONFIDENCE) : p.confidence;
  const out: Proposed<T> = { ...p, shape: true };
  if (p.cue !== 'learned') {
    out.learned = true;
    out.page_confidence = p.page_confidence ?? p.confidence;
  }
  out.confidence = round(to);
  return out;
}

const showsField = (k: ProposalKind, f: 'issued' | 'identifier' | 'expires') =>
  k.core?.[f]?.shown !== false;

/**
 * The kind and the person a matched shape says (0.9.0, R1), applied to what
 * the pages and I4's rules proposed. Pure, as `applyLearned` is. Answers
 * the proposal, what the shape disagreed with (`clash`), and a kind only
 * the shape proposed, for which the pages' dates are read again.
 */
export function applyShapeKind(input: {
  proposal: DetailProposal;
  clash: ShapeClash;
  match: ShapeMatch;
  tie: readonly string[];
  role: Role;
  types: readonly ProposalKind[];
  people: ReadonlyArray<{ id: string }>;
  /** The page's reading, for its number at the shape's label (W1). */
  paper?: PaperReading;
  /** Or that number itself (`shapeNumberOn`), as the proposal thread read it (N5). */
  pageNumber?: string | null;
  /**
   * The person's keyed hash of numbers (W1): only off the proposal thread,
   * which never sees a hash (`settleAccounts`, N5). None, and a person is
   * never sure.
   */
  numberHash?: ShapeNumberHash | undefined;
}): { proposal: DetailProposal; clash: ShapeClash; learnedKind: string | null } {
  const { match } = input;
  /**
   * A person's lesson is sure only for a page whose number, read at the
   * shape's label for it, is one the lesson was taught with (the R1 review,
   * W1): two of the family with the same bank, or a parent and a child's
   * junior account, share a layout but never an account.
   */
  const pageHash = (() => {
    const hash = input.numberHash;
    const number =
      input.pageNumber !== undefined
        ? input.pageNumber
        : input.paper
          ? shapeNumberOn(match.shape, input.paper)
          : null;
    return hash && number ? hash(plainNumber(number)) : null;
  })();
  const numberIsTheirs = (lesson: ShapeLesson): boolean =>
    pageHash !== null && timesIn(lesson.numbers, pageHash) > 0;
  /**
   * Whose account this page is (the R1 review's follow-up): of the person
   * lessons, the one alone that the page's number was filed with. Sure
   * where the layout's match is, that account was filed for them on
   * SHAPE_SURE_CONFIRMATIONS papers, one vouched for, and no other lesson
   * is too full of accounts to say it was never theirs. None — no lesson
   * holds it, or more than one — and the shape's person is as it was.
   */
  const byAccount = (
    usable: (v: string) => boolean,
  ): { lesson: ShapeLesson; sure: boolean } | null => {
    if (pageHash === null) return null;
    // Every person lesson that holds it counts, however contradicted: the
    // same account filed for two of the family says neither.
    const people = match.shape.lessons.filter((l) => l.field === 'owner_member_id');
    const holders = people.filter((l) => timesIn(l.numbers, pageHash) > 0);
    const [lesson] = holders;
    if (!lesson || holders.length > 1) return null;
    if (!usable(lesson.value) || net(lesson) <= 0) return null;
    const full = people.some(
      (l) => l !== lesson && new Set(l.numbers ?? []).size >= SHAPE_PERSON_NUMBERS,
    );
    return {
      lesson,
      // Never contradicted, as every sure lesson (the R1 re-check, N4).
      sure:
        match.sure &&
        !full &&
        lesson.contradicted === 0 &&
        (lesson.vouched ?? 0) >= 1 &&
        timesIn(lesson.numbers, pageHash) >= SHAPE_SURE_CONFIRMATIONS,
    };
  };
  const out: DetailProposal = { ...input.proposal };
  const clash: ShapeClash = { ...input.clash };
  let learnedKind: string | null = null;
  const fields: Array<['type_key' | 'owner_member_id', (v: string) => boolean]> = [
    ['type_key', (v) => input.types.some((t) => t.key === v && !t.hidden)],
  ];
  // A teen's documents are their own: never a person.
  if (input.role !== 'teen') {
    fields.push(['owner_member_id', (v) => input.people.some((m) => m.id === v)]);
  }
  for (const [field, usable] of fields) {
    const account = field === 'owner_member_id' ? byAccount(usable) : null;
    const lesson = account?.lesson ?? bestLesson(match.shape, field, usable);
    if (!lesson) continue;
    // W1's rule for a shape one person taught; or, for one several of the
    // family's accounts taught, the page's account (`byAccount`).
    const sure =
      (match.sure &&
        lessonTrusted(lesson, match.shape) &&
        (field !== 'owner_member_id' || numberIsTheirs(lesson))) ||
      !!account?.sure;
    const page = out[field];
    if (!page) {
      // Where the pages could not choose, a shape for one of their kinds
      // chooses; a shape for none of them is never sure.
      const fits =
        field !== 'type_key' || input.tie.length === 0 || input.tie.includes(lesson.value);
      out[field] = {
        value: lesson.value,
        confidence: sure && fits ? SHAPE_SURE_CONFIDENCE : SHAPE_CONFIDENCE,
        cue: 'learned',
        shape: true,
      };
      if (field === 'type_key') learnedKind = lesson.value;
    } else if (page.value === lesson.value) {
      out[field] = raised(page, sure);
    } else if (page.cue === 'learned') {
      // The issuer's rule (I4) and this sender's layout disagree: the
      // layout's, more particular, but unsure — sure only where the page's
      // own account says whose it is.
      out[field] = {
        value: lesson.value,
        confidence: account?.sure ? SHAPE_SURE_CONFIDENCE : SHAPE_CONFIDENCE,
        cue: 'learned',
        shape: true,
      };
      if (field === 'type_key') learnedKind = lesson.value;
    } else if (sure && clash[field] === undefined) {
      clash[field] = lesson.value;
    }
  }
  // A person sure from what was learned — I4's rule for the issuer, or a
  // shape — on a page whose account is not one theirs was filed with: unsure
  // (the R1 re-check, N1). Their lesson here says which accounts are theirs;
  // a lesson with none says nothing.
  const person = out.owner_member_id;
  if (person && input.role !== 'teen' && (person.cue === 'learned' || person.learned)) {
    const theirs = match.shape.lessons.find(
      (l) => l.field === 'owner_member_id' && l.value === person.value,
    );
    if (theirs?.numbers?.length && !numberIsTheirs(theirs)) {
      const floor =
        person.cue === 'learned'
          ? SHAPE_CONFIDENCE
          : Math.max(SHAPE_CONFIDENCE, Math.min(person.confidence, person.page_confidence ?? 0));
      if (person.confidence > floor) out.owner_member_id = { ...person, confidence: floor };
    }
  }
  return { proposal: out, clash, learnedKind };
}

/** The number on this page at the shape's learned label for it: none, or not one. */
export function shapeNumberOn(
  shape: LearnedShape,
  paper: Pick<PaperReading, 'numbers'>,
): string | null {
  return labelled(shape, 'identifier', paper.numbers, plainNumber)?.value ?? null;
}

/**
 * A label's value on this page: what the page has under it; where it has
 * several, the one at the band learned; null where that does not tell.
 * `exact`: the page has only the one.
 */
function valueUnder<T>(
  found: ReadonlyArray<PaperLabelled<T>>,
  lesson: ShapeLesson,
  key: (v: T) => string,
): { value: T; exact: boolean } | null {
  const under = found.filter((f) => f.label === lesson.value);
  const distinct = new Map(under.map((f) => [key(f.value), f.value]));
  if (distinct.size === 1) return { value: [...distinct.values()][0] as T, exact: true };
  const there = under.filter((f) => f.band === lesson.band);
  const at = new Map(there.map((f) => [key(f.value), f.value]));
  return at.size === 1 ? { value: [...at.values()][0] as T, exact: false } : null;
}

/**
 * The dates and the number a matched shape reads off this page at the
 * labels it learned (0.9.0, R1), for the kind now proposed — only one the
 * shape learned, if it learned a kind, and only fields that kind keeps.
 * Pure. A value the pages proposed too is made surer where they agree; where
 * they disagree the pages' stands, and a sure lesson is said beside it.
 */
export function applyShapeFields(input: {
  proposal: DetailProposal;
  clash: ShapeClash;
  match: ShapeMatch;
  paper: PaperReading;
  types: readonly ProposalKind[];
}): { proposal: DetailProposal; clash: ShapeClash } {
  const { match, paper } = input;
  const out: DetailProposal = { ...input.proposal };
  const clash: ShapeClash = { ...input.clash };
  const kindKey = out.type_key?.value;
  const kind = kindKey ? input.types.find((t) => t.key === kindKey) : undefined;
  if (!kind) return { proposal: out, clash };
  // Its dates are for the kind it learned: not for another.
  const shapeKind = bestLesson(match.shape, 'type_key', () => true);
  if (shapeKind && shapeKind.value !== kind.key) return { proposal: out, clash };
  const keeps = {
    issued: showsField(kind, 'issued'),
    expires: kind.expiry_driver !== null && showsField(kind, 'expires'),
    identifier: showsField(kind, 'identifier'),
  };
  for (const field of ['issued', 'expires'] as const) {
    if (!keeps[field]) continue;
    const got = labelled(match.shape, field, paper.dates, (d) => d.date);
    if (!got) continue;
    const sure = match.sure && got.sure;
    const page = out[field];
    if (!page) {
      out[field] = {
        value: got.value,
        confidence: sure ? SHAPE_SURE_CONFIDENCE : SHAPE_CONFIDENCE,
        cue: 'learned',
        shape: true,
      };
    } else if (page.value.date === got.value.date) {
      out[field] = raised(page, sure);
    } else if (sure) {
      clash[field] = got.value.date;
    }
  }
  if (keeps.identifier) {
    const got = labelled(match.shape, 'identifier', paper.numbers, plainNumber);
    if (got) {
      const sure = match.sure && got.sure;
      const page = out.identifier;
      if (!page) {
        out.identifier = {
          value: got.value,
          confidence: sure ? SHAPE_SURE_CONFIDENCE : SHAPE_CONFIDENCE,
          cue: 'learned',
          shape: true,
        };
      } else if (plainNumber(page.value) === plainNumber(got.value)) {
        out.identifier = raised(page, sure);
      } else if (sure) {
        clash.identifier = 'differs';
      }
    }
  }
  // A document that runs out before it was issued says neither of the shape's.
  const from = out.issued?.value.date;
  const to = out.expires?.value.date;
  if (from && to && to <= from) {
    if (out.issued?.shape && out.issued.cue === 'learned') delete out.issued;
    if (out.expires?.shape && out.expires.cue === 'learned') delete out.expires;
  }
  return { proposal: out, clash };
}

/**
 * A field's value read at the labels a shape learned: each lesson of the
 * field, best first, that finds one on this page. Sure only where the best
 * lesson is trusted, finds just the one value, and no other trusted lesson
 * of the field finds another.
 */
function labelled<T>(
  shape: LearnedShape,
  field: ShapeField,
  found: ReadonlyArray<PaperLabelled<T>>,
  key: (v: T) => string,
): { value: T; sure: boolean } | null {
  const lessons = shape.lessons
    .filter((l) => l.field === field && l.confirmed - l.contradicted > 0)
    .sort(
      (a, b) =>
        b.confirmed - b.contradicted - (a.confirmed - a.contradicted) ||
        b.confirmed - a.confirmed ||
        a.value.localeCompare(b.value),
    );
  let first: { value: T; exact: boolean; lesson: ShapeLesson } | null = null;
  let disagree = false;
  for (const lesson of lessons) {
    const got = valueUnder(found, lesson, key);
    if (!got) continue;
    if (!first) {
      first = { ...got, lesson };
    } else if (lessonTrusted(lesson, shape) && key(got.value) !== key(first.value)) {
      disagree = true;
    }
  }
  if (!first) return null;
  return {
    value: first.value,
    sure: first.exact && !disagree && lessonTrusted(first.lesson, shape),
  };
}

// ------------------------------------------------------------- learning

/** What was filed, as a shape learns from it. */
export interface ShapeFiled {
  type_key?: string | null;
  owner_member_id?: string | null;
  issued?: DateValue | null;
  expires?: DateValue | null;
  identifier?: string | null;
  issued_by?: string | null;
}

/** One step of what an accept teaches a shape. */
export type ShapeStep =
  /**
   * The kind or the person filed: confirmed, or made; every other of its
   * field contradicted. For the person, the keyed hash of the number filed
   * with it, where one was (W1).
   */
  | {
      field: 'type_key' | 'owner_member_id';
      value: string;
      number?: string;
      /** Vouched for (W2, N2): put right, or the pages' own value confirmed on a card looked at. */
      vouched?: boolean;
    }
  /**
   * A date or the number: the labels on this page that carry what was filed
   * (`labels`, confirmed, or made), and those that carry something else
   * (`wrong`: contradicted, where the shape learned them).
   */
  | {
      field: 'issued' | 'expires' | 'identifier';
      labels: Array<{ label: string; band: number }>;
      wrong: string[];
      vouched?: boolean;
    };

/**
 * What an accept teaches a shape (0.9.0, R1): the issuer filed (none, and
 * nothing is taught), the page's words, and a step for each field filed —
 * the kind; the person (never for a teen, whose documents are their own);
 * and, for each date and the number the filed kind keeps (`keeps`), the
 * labels on this page carrying what was filed and those carrying something
 * else. A field the kind keeps that was filed empty makes every label of it
 * on this page wrong. Nothing from a page with too few words for a shape.
 *
 * Only a reviewed accept teaches (the R1 review, W2): never Accept all
 * Ready, which files what the card said unseen (`reviewed: false`); and a
 * kind or a person the card had from the batch's defaults alone, filed as
 * it was, teaches nothing of that field. Where the person corrected the
 * card, or the item was at Check (`vouched`), what it teaches is vouched
 * for: a lesson is sure only with one such.
 */
export function shapeLessonOf(opts: {
  paper: PaperReading | null;
  filed: ShapeFiled;
  /** The filed issuer's key (`learnedIssuerKey`). */
  issuer: string;
  role: Role;
  /** The fields the filed kind keeps. */
  keeps: { issued: boolean; expires: boolean; identifier: boolean };
  /** A person looked at this card and accepted it: never Accept all Ready (W2). */
  reviewed: boolean;
  /** They corrected the card, or it was at Check (W2). */
  vouched: boolean;
  /**
   * The card as it was when accepted: a kind or a person from the batch
   * alone teaches nothing (W2); a value the shape itself suggested, filed
   * unchanged, teaches nothing either (the R1 re-check, N2).
   */
  card?: ShapeCard | null;
  /** The person's keyed hash of numbers (W1). */
  numberHash?: ShapeNumberHash | undefined;
}): { issuer: string; words: string[]; steps: ShapeStep[]; vouched: boolean } | null {
  const { paper, filed } = opts;
  if (!opts.reviewed) return null;
  if (!paper || !opts.issuer || paper.words.length < SHAPE_MIN_WORDS) return null;
  const fromBatch = (field: 'type_key' | 'owner_member_id', value: string) =>
    opts.card?.[field]?.from === 'batch' && opts.card[field]?.value === value;
  /**
   * What a step of this field may teach (N2): nothing, where what was filed
   * is the shape's own suggestion unchanged — accepting it is no evidence
   * for it, and a misfiled paper would otherwise be confirmed by its own
   * echo; vouched for, where the person changed it, or confirmed what the
   * pages themselves proposed on a card they looked at (`vouched`).
   */
  const taughtBy = (field: ShapeField, same: (v: unknown) => boolean) => {
    const c = opts.card?.[field];
    if (c && c.shape === true && c.cue === 'learned' && same(c.value)) return null;
    // Nor what the local AI suggested, filed unchanged (0.9.0, R4): its echo
    // is never a lesson, so it never makes a later card Ready by the back door.
    if (c && c.local_ai === true && same(c.value)) return null;
    // With no card at all, what the accept says of itself (W2).
    const changed = opts.card ? !c || !same(c.value) : opts.vouched;
    const pages = !!c && c.cue !== 'learned' && c.from !== 'batch' && c.from !== 'folder';
    return { vouched: changed || (pages && opts.vouched) };
  };
  const steps: ShapeStep[] = [];
  const text = (v: string | null | undefined) => {
    const t = (v ?? '').trim();
    return t === '' ? null : t;
  };
  const kind = text(filed.type_key);
  const kindBy = kind ? taughtBy('type_key', (v) => v === kind) : null;
  if (kind && kindBy && !fromBatch('type_key', kind)) {
    steps.push({ field: 'type_key', value: kind, vouched: kindBy.vouched });
  }
  const person = text(filed.owner_member_id);
  const personBy = person ? taughtBy('owner_member_id', (v) => v === person) : null;
  if (person && personBy && opts.role !== 'teen' && !fromBatch('owner_member_id', person)) {
    const number = text(filed.identifier);
    steps.push({
      field: 'owner_member_id',
      value: person,
      vouched: personBy.vouched,
      ...(number && opts.numberHash ? { number: opts.numberHash(plainNumber(number)) } : {}),
    });
  }
  const split = <T>(
    field: 'issued' | 'expires' | 'identifier',
    found: ReadonlyArray<PaperLabelled<T>>,
    want: string | null,
    key: (v: T) => string,
    same: (v: unknown) => boolean,
  ) => {
    const by = taughtBy(field, same);
    if (!by) return;
    const labels: Array<{ label: string; band: number }> = [];
    const right = new Set<string>();
    for (const f of found) {
      if (want !== null && key(f.value) === want && !right.has(f.label)) {
        right.add(f.label);
        labels.push({ label: f.label, band: f.band });
      }
    }
    const wrong = [...new Set(found.filter((f) => !right.has(f.label)).map((f) => f.label))];
    if (labels.length > 0 || wrong.length > 0) {
      steps.push({ field, labels, wrong, vouched: by.vouched });
    }
  };
  if (kind) {
    for (const field of ['issued', 'expires'] as const) {
      if (!opts.keeps[field]) continue;
      const want = filed[field]?.date ?? null;
      split(
        field,
        paper.dates,
        want,
        (d) => d.date,
        (v) => !!v && typeof v === 'object' && (v as DateValue).date === want,
      );
    }
    if (opts.keeps.identifier) {
      const want = text(filed.identifier);
      split(
        'identifier',
        paper.numbers,
        want ? plainNumber(want) : null,
        plainNumber,
        (v) => typeof v === 'string' && !!want && plainNumber(v) === plainNumber(want),
      );
    }
  }
  return { issuer: opts.issuer, words: paper.words, steps, vouched: opts.vouched };
}

/** The card a shape is taught beside: each field's suggestion, as levelItem had it. */
export type ShapeCard = Partial<
  Record<
    ShapeField,
    | { value: unknown; from: string; cue?: string | null; shape?: boolean; local_ai?: boolean }
    | undefined
  >
>;

/** A lesson by field and value: what an outcome remembers of what it touched. */
export interface LessonRef {
  field: ShapeField;
  value: string;
}

/** What one accept taught a shape, for an Undo to take back exactly. */
export interface ShapeTaught {
  shape: string;
  /** The shape was made by it. */
  made: boolean;
  confirmed: LessonRef[];
  contradicted: LessonRef[];
  /** Its lessons removed by it — contradicted more often than confirmed, or past the cap — as they were. */
  removed: ShapeLesson[];
  /** Shapes evicted past SHAPES_MAX, as they were. */
  evicted: KeptShape[];
  /** Each lesson's band before it was moved (a label found at another place). */
  moved: Array<LessonRef & { band: number | null }>;
  /** The lessons it vouched for (W2). Absent from what was taught before. */
  vouched?: LessonRef[];
  /** The numbers' hashes it gave a person's lesson (W1). */
  numbered?: Array<LessonRef & { number: string }>;
  /** The person lessons it weakly contradicted: another account (N3). */
  drifted?: LessonRef[];
}

const sameRef = (a: LessonRef, b: LessonRef) => a.field === b.field && a.value === b.value;

/**
 * What an accept teaches, applied to one person's shapes (0.9.0, R1): the
 * shape the page matches at SHAPE_SURE_MATCH, of the filed issuer (or a new
 * one); in it, each step's lessons confirmed or made, and the lessons the
 * page disagrees with contradicted; a lesson contradicted more often than
 * confirmed removed; and past SHAPES_MAX, the least used shapes. Pure: the
 * API applies it to the shapes it opened, and the fake vault to its own.
 * Answers every shape after, and what was taught, for an Undo.
 */
export function teachShape(
  shapes: readonly KeptShape[],
  lesson: { issuer: string; words: string[]; steps: readonly ShapeStep[]; vouched?: boolean },
  opts: { newId: () => string; today: string },
): { shapes: KeptShape[]; taught: ShapeTaught } {
  let out = shapes.map((s) => ({ ...s, lessons: s.lessons.map((l) => ({ ...l })) }));
  const of = out
    .filter((s) => issuerMatches(s.issuer, lesson.issuer))
    .map((s) => ({ s, sim: shapeSimilarity(lesson.words, s.words) }))
    .filter((m) => m.sim >= SHAPE_SURE_MATCH)
    .sort((a, b) => b.sim - a.sim || a.s.id.localeCompare(b.s.id))[0];
  let shape: KeptShape;
  let made = false;
  if (of) {
    shape = of.s;
  } else {
    shape = {
      id: opts.newId(),
      issuer: lesson.issuer,
      words: lesson.words.slice(0, SHAPE_WORDS_MAX),
      lessons: [],
      last_used: opts.today,
    };
    out.push(shape);
    made = true;
  }
  shape.last_used = opts.today;
  const taught: ShapeTaught = {
    shape: shape.id,
    made,
    confirmed: [],
    contradicted: [],
    removed: [],
    evicted: [],
    moved: [],
    vouched: [],
    numbered: [],
    drifted: [],
  };
  const confirm = (
    field: ShapeField,
    value: string,
    band: number | null,
    vouched: boolean,
    number?: string,
  ) => {
    let own = shape.lessons.find((l) => l.field === field && l.value === value);
    if (own) {
      own.confirmed = Math.min(own.confirmed + 1, 1_000_000);
      if (band !== null && own.band !== band) {
        taught.moved.push({ field, value, band: own.band });
        own.band = band;
      }
    } else {
      own = { field, value, band, confirmed: 1, contradicted: 0 };
      shape.lessons.push(own);
    }
    taught.confirmed.push({ field, value });
    if (vouched) {
      own.vouched = Math.min((own.vouched ?? 0) + 1, 1_000_000);
      taught.vouched?.push({ field, value });
    }
    const numbers = own.numbers ?? [];
    const times = number ? timesIn(numbers, number) : 0;
    if (
      number &&
      times < SHAPE_SURE_CONFIRMATIONS &&
      (times > 0 || new Set(numbers).size < SHAPE_PERSON_NUMBERS)
    ) {
      own.numbers = [...numbers, number];
      taught.numbered?.push({ field, value, number });
    }
  };
  const contradict = (l: ShapeLesson) => {
    l.contradicted = Math.min(l.contradicted + 1, 1_000_000);
    taught.contradicted.push({ field: l.field, value: l.value });
  };
  for (const step of lesson.steps) {
    if (!('labels' in step)) {
      confirm(
        step.field,
        step.value,
        null,
        step.vouched ?? !!lesson.vouched,
        step.field === 'owner_member_id' ? step.number : undefined,
      );
      for (const l of shape.lessons) {
        if (l.field !== step.field || l.value === step.value) continue;
        // Another of the family's accounts at the same bank says nothing
        // against them: only the same account filed for somebody else does,
        // or a paper whose number was not read.
        const number = step.field === 'owner_member_id' ? step.number : undefined;
        if (number && l.numbers?.length && timesIn(l.numbers, number) === 0) {
          // Weakly, so a lesson only ever misfiled is in time unlearned (N3).
          l.drift = Math.min((l.drift ?? 0) + 1, 1_000_000);
          taught.drifted?.push({ field: l.field, value: l.value });
          continue;
        }
        contradict(l);
      }
    } else {
      for (const { label, band } of step.labels) {
        confirm(step.field, label, band, step.vouched ?? !!lesson.vouched);
      }
      const right = new Set(step.labels.map((l) => l.label));
      for (const l of shape.lessons) {
        if (l.field === step.field && !right.has(l.value) && step.wrong.includes(l.value)) {
          contradict(l);
        }
      }
    }
  }
  const gone = shape.lessons.filter((l) => net(l) < 0);
  shape.lessons = shape.lessons.filter((l) => net(l) >= 0);
  // At most SHAPE_LESSONS_MAX: the least confirmed go, never one just confirmed.
  if (shape.lessons.length > SHAPE_LESSONS_MAX) {
    const keep = [...shape.lessons].sort(
      (a, b) =>
        Number(taught.confirmed.some((r) => sameRef(r, b))) -
          Number(taught.confirmed.some((r) => sameRef(r, a))) ||
        b.confirmed - b.contradicted - (a.confirmed - a.contradicted) ||
        a.value.localeCompare(b.value),
    );
    gone.push(...keep.slice(SHAPE_LESSONS_MAX));
    shape.lessons = keep.slice(0, SHAPE_LESSONS_MAX);
  }
  taught.removed = gone.map((l) => ({ ...l }));
  const over = out.length - SHAPES_MAX;
  if (over > 0) {
    const evict = new Set(
      out
        .filter((s) => s.id !== shape.id)
        .sort(
          (a, b) =>
            a.last_used.localeCompare(b.last_used) || sum(a) - sum(b) || a.id.localeCompare(b.id),
        )
        .slice(0, over)
        .map((s) => s.id),
    );
    taught.evicted = out.filter((s) => evict.has(s.id));
    out = out.filter((s) => !evict.has(s.id));
  }
  return { shapes: out, taught };
}

const sum = (s: KeptShape) => s.lessons.reduce((n, l) => n + l.confirmed, 0);

/**
 * An accept taken back (I3's Undo): what it taught its shape taken back
 * exactly — the shapes it evicted and the lessons it removed put back as
 * they were; each lesson it confirmed and contradicted, by one; a lesson's
 * band where it was; a lesson then confirmed by nothing removed; and the
 * shape, if it made it and nothing is left in it, removed. Pure.
 */
export function unteachShape(shapes: readonly KeptShape[], taught: ShapeTaught): KeptShape[] {
  let out = shapes.map((s) => ({ ...s, lessons: s.lessons.map((l) => ({ ...l })) }));
  for (const e of taught.evicted) {
    if (!out.some((s) => s.id === e.id))
      out.push({ ...e, lessons: e.lessons.map((l) => ({ ...l })) });
  }
  const shape = out.find((s) => s.id === taught.shape);
  if (!shape) return out;
  for (const r of taught.removed) {
    if (!shape.lessons.some((l) => sameRef(l, r))) shape.lessons.push({ ...r });
  }
  for (const r of taught.confirmed) {
    const l = shape.lessons.find((x) => sameRef(x, r));
    if (l) l.confirmed = Math.max(0, l.confirmed - 1);
  }
  for (const r of taught.contradicted) {
    const l = shape.lessons.find((x) => sameRef(x, r));
    if (l) l.contradicted = Math.max(0, l.contradicted - 1);
  }
  for (const m of taught.moved) {
    const l = shape.lessons.find((x) => sameRef(x, m));
    if (l) l.band = m.band;
  }
  for (const r of taught.vouched ?? []) {
    const l = shape.lessons.find((x) => sameRef(x, r));
    if (l) l.vouched = Math.max(0, (l.vouched ?? 0) - 1);
  }
  for (const r of taught.numbered ?? []) {
    const l = shape.lessons.find((x) => sameRef(x, r));
    if (l?.numbers) {
      // One paper's: one of its times.
      const at = l.numbers.lastIndexOf(r.number);
      if (at !== -1) l.numbers = [...l.numbers.slice(0, at), ...l.numbers.slice(at + 1)];
      if (l.numbers.length === 0) delete l.numbers;
    }
  }
  for (const r of taught.drifted ?? []) {
    const l = shape.lessons.find((x) => sameRef(x, r));
    if (l) l.drift = Math.max(0, (l.drift ?? 0) - 1);
  }
  for (const l of shape.lessons) {
    if (l.vouched === 0) delete l.vouched;
    if (l.drift === 0) delete l.drift;
  }
  shape.lessons = shape.lessons.filter((l) => l.confirmed > 0 && net(l) >= 0);
  if (shape.lessons.length === 0) out = out.filter((s) => s.id !== shape.id);
  return out;
}

// ------------------------------------------------------------- stored

const isDateValue = (v: unknown): v is DateValue =>
  !!v &&
  typeof v === 'object' &&
  typeof (v as DateValue).date === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test((v as DateValue).date) &&
  ['day', 'month', 'year'].includes(String((v as DateValue).precision));

/** A label: words of SHAPE_WORDS alone, at most SHAPE_LABEL_WORDS of them. */
const isLabel = (v: unknown): v is string => {
  if (typeof v !== 'string' || v.length === 0 || v.length > LABEL_MAX) return false;
  const w = v.split(' ');
  return w.length <= SHAPE_LABEL_WORDS && w.every((x) => SHAPE_WORDS.has(x));
};
const isBand = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < SHAPE_BANDS_DOWN * 2;
const isCount = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1_000_000;
const isWord = (v: unknown): v is string => typeof v === 'string' && SHAPE_WORDS.has(v);

/**
 * A page's reading as the worker sealed it beside the proposal (`paper`):
 * only words of SHAPE_WORDS, only labels of such words, dates and numbers
 * well formed and within their bounds. Anything else is none.
 */
export function storedPaper(raw: unknown): PaperReading | null {
  if (!raw || typeof raw !== 'object' || (raw as { v?: unknown }).v !== 1) return null;
  const p = (raw as { paper?: unknown }).paper;
  if (!p || typeof p !== 'object') return null;
  const words = (p as { words?: unknown }).words;
  const dates = (p as { dates?: unknown }).dates;
  const numbers = (p as { numbers?: unknown }).numbers;
  if (!Array.isArray(words) || !Array.isArray(dates) || !Array.isArray(numbers)) return null;
  const out: PaperReading = {
    words: [...new Set(words.filter(isWord))].sort().slice(0, SHAPE_WORDS_MAX),
    dates: [],
    numbers: [],
  };
  for (const d of dates.slice(0, PAPER_DATES_MAX)) {
    const x = d as { label?: unknown; band?: unknown; value?: unknown };
    if (isLabel(x.label) && isBand(x.band) && isDateValue(x.value)) {
      out.dates.push({
        label: x.label,
        band: x.band,
        value: { date: x.value.date, precision: x.value.precision },
      });
    }
  }
  for (const n of numbers.slice(0, PAPER_NUMBERS_MAX)) {
    const x = n as { label?: unknown; band?: unknown; value?: unknown };
    if (
      isLabel(x.label) &&
      isBand(x.band) &&
      typeof x.value === 'string' &&
      x.value.length > 0 &&
      x.value.length <= NUMBER_MAX
    ) {
      out.numbers.push({ label: x.label, band: x.band, value: x.value });
    }
  }
  return out;
}

const isField = (v: unknown): v is ShapeField =>
  typeof v === 'string' && (SHAPE_FIELDS as readonly string[]).includes(v);

/** A lesson as kept: well formed, or none. */
function storedLesson(raw: unknown): ShapeLesson | null {
  if (!raw || typeof raw !== 'object') return null;
  const l = raw as Record<string, unknown>;
  if (!isField(l.field) || !isCount(l.confirmed) || !isCount(l.contradicted)) return null;
  if (typeof l.value !== 'string' || l.value.length === 0 || l.value.length > LABEL_MAX)
    return null;
  // A label is of the list's words alone; a kind's key or a member's id is short.
  if (!exclusive(l.field) && !isLabel(l.value)) return null;
  if (exclusive(l.field) && l.value.length > 64) return null;
  const band = l.band === null || l.band === undefined ? null : isBand(l.band) ? l.band : null;
  // Numbers' hashes: a person's alone, hex, at most SHAPE_PERSON_NUMBERS of
  // them, each at most SHAPE_SURE_CONFIRMATIONS times (W1).
  const numbers: string[] = [];
  if (l.field === 'owner_member_id' && Array.isArray(l.numbers)) {
    for (const n of l.numbers.slice(0, SHAPE_PERSON_NUMBERS * SHAPE_SURE_CONFIRMATIONS)) {
      if (typeof n !== 'string' || !/^[0-9a-f]{32}$/.test(n)) continue;
      const times = timesIn(numbers, n);
      if (times >= SHAPE_SURE_CONFIRMATIONS) continue;
      if (times === 0 && new Set(numbers).size >= SHAPE_PERSON_NUMBERS) continue;
      numbers.push(n);
    }
  }
  return {
    field: l.field,
    value: l.value,
    band,
    confirmed: l.confirmed,
    contradicted: l.contradicted,
    ...(isCount(l.vouched) && l.vouched > 0 ? { vouched: l.vouched } : {}),
    ...(l.field === 'owner_member_id' && isCount(l.drift) && l.drift > 0 ? { drift: l.drift } : {}),
    ...(numbers.length > 0 ? { numbers } : {}),
  };
}

/**
 * A shape without the words of anybody's name (the R1 review, P2): the
 * household's people, family or guest, as they are now. Somebody added
 * since a shape was made, whose name is a word it kept, takes that word out
 * of it, and every lesson whose label holds it. Answers the same shape
 * where there was nothing to take out.
 */
export function withoutNames<S extends Pick<LearnedShape, 'words' | 'lessons'>>(
  shape: S,
  names: ReadonlySet<string>,
): S {
  const named = (w: string) => names.has(w);
  const words = shape.words.filter((w) => !named(w));
  const lessons = shape.lessons.filter(
    (l) => exclusive(l.field) || !l.value.split(' ').some(named),
  );
  if (words.length === shape.words.length && lessons.length === shape.lessons.length) return shape;
  return { ...shape, words, lessons };
}

/**
 * A page's reading without the words of these names (the R1 review, P2):
 * its words, and each date and number whose label holds one. The worker
 * takes the guests' names out of what the proposal thread read here, before
 * it is sealed, so the thread is never told of a guest (I2). Answers the
 * same reading where there was nothing to take out.
 */
export function paperWithoutNames(paper: PaperReading, names: ReadonlySet<string>): PaperReading {
  const named = (label: string) => label.split(' ').some((w) => names.has(w));
  const words = paper.words.filter((w) => !names.has(w));
  const dates = paper.dates.filter((d) => !named(d.label));
  const numbers = paper.numbers.filter((n) => !named(n.label));
  if (
    words.length === paper.words.length &&
    dates.length === paper.dates.length &&
    numbers.length === paper.numbers.length
  )
    return paper;
  return { words, dates, numbers };
}

/** A shape as the store sealed it (`{ v: 1, issuer, words, lessons }`): well formed, or none. */
export function storedShape(raw: unknown): Pick<KeptShape, 'issuer' | 'words' | 'lessons'> | null {
  if (!raw || typeof raw !== 'object' || (raw as { v?: unknown }).v !== 1) return null;
  const s = raw as { issuer?: unknown; words?: unknown; lessons?: unknown };
  if (typeof s.issuer !== 'string' || s.issuer.length === 0 || s.issuer.length > 120) return null;
  if (!Array.isArray(s.words) || !Array.isArray(s.lessons)) return null;
  return {
    issuer: s.issuer,
    words: [...new Set(s.words.filter(isWord))].sort().slice(0, SHAPE_WORDS_MAX),
    lessons: s.lessons
      .slice(0, SHAPE_LESSONS_MAX)
      .map(storedLesson)
      .filter((l): l is ShapeLesson => l !== null),
  };
}

/** What a shape is sealed as. */
export const shapeSealed = (s: Pick<KeptShape, 'issuer' | 'words' | 'lessons'>) => ({
  v: 1 as const,
  issuer: s.issuer,
  words: s.words,
  lessons: s.lessons,
});

/** What an outcome kept of what its accept taught a shape: well formed, or none. */
export function storedShapeTaught(raw: unknown): ShapeTaught | null {
  if (!raw || typeof raw !== 'object' || (raw as { v?: unknown }).v !== 1) return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.shape !== 'string' || typeof t.made !== 'boolean') return null;
  const refs = (v: unknown): LessonRef[] =>
    Array.isArray(v)
      ? v
          .slice(0, 200)
          .filter(
            (r): r is LessonRef =>
              !!r &&
              typeof r === 'object' &&
              isField((r as LessonRef).field) &&
              typeof (r as LessonRef).value === 'string',
          )
          .map((r) => ({ field: r.field, value: r.value }))
      : [];
  const evicted: KeptShape[] = [];
  for (const e of Array.isArray(t.evicted) ? t.evicted.slice(0, SHAPES_MAX) : []) {
    const x = e as { id?: unknown; last_used?: unknown };
    const s = storedShape(e);
    if (
      s &&
      typeof x.id === 'string' &&
      typeof x.last_used === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(x.last_used)
    ) {
      evicted.push({ ...s, id: x.id, last_used: x.last_used });
    }
  }
  return {
    shape: t.shape,
    made: t.made,
    confirmed: refs(t.confirmed),
    contradicted: refs(t.contradicted),
    removed: (Array.isArray(t.removed) ? t.removed.slice(0, 200) : [])
      .map(storedLesson)
      .filter((l): l is ShapeLesson => l !== null),
    evicted,
    moved: (Array.isArray(t.moved) ? t.moved.slice(0, 200) : []).flatMap((m) => {
      const r = refs([m])[0];
      const band = (m as { band?: unknown }).band;
      return r ? [{ ...r, band: isBand(band) ? band : null }] : [];
    }),
    vouched: refs(t.vouched),
    drifted: refs(t.drifted),
    numbered: (Array.isArray(t.numbered) ? t.numbered.slice(0, 200) : []).flatMap((m) => {
      const r = refs([m])[0];
      const number = (m as { number?: unknown }).number;
      return r && typeof number === 'string' && /^[0-9a-f]{32}$/.test(number)
        ? [{ ...r, number }]
        : [];
    }),
  };
}

/** `GET /api/v1/batches/learned`: one shape, as its person is shown it. */
export interface LearnedShapeView {
  id: string;
  /** The issuer's key, as the vault keeps it. */
  issuer: string;
  /** How many of the list's words make it. */
  words: number;
  lessons: Array<{
    field: ShapeField;
    /** A kind's key, a member's id, or a label's words. */
    value: string;
    /** The kind's name, the person's, or the label as it is kept; null for one no longer there. */
    label: string | null;
    confirmed: number;
    contradicted: number;
    /** Trusted (`lessonTrusted`). */
    sure: boolean;
  }>;
  /** YYYY-MM-DD. */
  last_used: string;
}
