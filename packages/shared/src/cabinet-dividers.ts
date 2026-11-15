import type { DocumentView } from './documents.js';

/**
 * Dividers and pins (0.9.0, C2; the owner's ideas 4 and 7 of 13 Nov 2026):
 * what is inside one folder of somebody's cabinet. The wire's half, shared
 * by the vault, the client, its fake and the web — and the phone later
 * (C5), which is why the vault itself groups a folder's papers.
 *
 * Dividers. A folder's papers are grouped behind dividers by the date each
 * is about (issued, else added: the list's `dated_`), newest first:
 *
 *  - by year, by themselves, unless the folder turns them off;
 *  - or by the folder's own named ranges ("Elementary", 2014-09-01 to
 *    2020-08-31; "College", from 2027-09-01, its end open). Ranges never
 *    overlap — a paper goes behind one divider only, and a layout whose
 *    ranges share a day is refused, saying which two — and they replace the
 *    years. A paper in no range goes behind "Other years".
 *
 * Pins. A person may pin a paper into one of their folders by hand: it is
 * shown first, marked, before the dividers, and counted in the folder once.
 * A pin is the person's arrangement, never a change to the paper. It shows
 * only while its person may still open the paper, out of the Trash: when
 * that changes, it shows and counts no more, saying nothing (`cabinet_pin`,
 * 0099).
 */

/** A divider of a folder's own: a named stretch of days, either end open (not both). */
export interface DividerRange {
  name: string;
  /**
   * Its first day, `YYYY-MM-DD`, or a whole year, `YYYY` (its 1 January);
   * null: from the very start.
   */
  from: string | null;
  /**
   * Its last day, included, `YYYY-MM-DD`, or a whole year, `YYYY` (its 31
   * December — or the year before, when another range starts with that
   * year: `resolvedRanges`); null: still going.
   */
  to: string | null;
}

/** How a folder's papers are grouped. A folder without it has year dividers. */
export interface FolderDividers {
  /** Year dividers, by themselves: on unless turned off. Not used while there are ranges. */
  years: boolean;
  /** The folder's own ranges: when there are any, they replace the years. */
  ranges: DividerRange[];
}

/** What groups a folder's papers: its own ranges, years, or nothing. */
export type DividerMode = 'years' | 'ranges' | 'none';

export function dividerMode(d: FolderDividers | undefined): DividerMode {
  if (d && d.ranges.length > 0) return 'ranges';
  return d && !d.years ? 'none' : 'years';
}

/** One divider of a folder, as GET /cabinet/folders/{id} gives it. */
export interface FolderDivider {
  /**
   * `year:2025`; `range:0` (the range's place in the folder's own list);
   * `other`, papers in none of its ranges; or `all`, a folder with no
   * dividers. What GET /cabinet/folders/{id}/documents asks with.
   */
  key: string;
  kind: 'year' | 'range' | 'other' | 'all';
  /** Its name: the year, the range's own, "Other years"; empty for `all`. */
  name: string;
  /** Its days, both included; null where open (and for `other` and `all`). */
  from: string | null;
  to: string | null;
  /** How many papers are behind it for the caller, pinned ones left out. */
  count: number;
}

/**
 * GET /cabinet/folders/{id}: one of the caller's shown folders, opened —
 * its pinned papers first, then its dividers, newest first, each counted.
 * `total` is GET /cabinet/counts's own for it: the pinned and every
 * divider's, each paper once; null when the list would now refuse its
 * question (its pins are still shown).
 */
export interface FolderContents {
  folder_id: string;
  /** The layout's version it was read from. */
  version: number;
  total: number | null;
  /** The pinned papers the caller may still open, out of the Trash, newest first. */
  pinned: DocumentView[];
  dividers: FolderDivider[];
}

/** POST /cabinet/folders/{id}/pins: papers to pin there, the caller's own arrangement. */
export interface CabinetPinsAdd {
  document_ids: string[];
}

/** And its answer: how many of them are pinned there now. */
export interface CabinetPinned {
  pinned: number;
}

/** A folder's papers moved with it as two folders are merged: PUT /cabinet's `pins_moved`. */
export interface PinsMoved {
  from: string;
  to: string;
}

export const DIVIDER_LIMITS = {
  /** Ranges in one folder. */
  ranges: 20,
  /** A range's name, in characters. */
  name: 80,
} as const;

export const PIN_LIMITS = {
  /** Pinned papers in one folder: one page of the table. */
  folder: 200,
  /** Every pin of one person. */
  total: 2000,
} as const;

/** What a paper in no range is behind. */
export const OTHER_YEARS = 'Other years';

export const TOO_MANY_PINS = `A folder can hold at most ${PIN_LIMITS.folder} pinned papers, and your cabinet ${PIN_LIMITS.total}. Unpin some first.`;
export const PIN_IN_TRASH = 'A paper in the Trash can’t be pinned. Restore it first.';

/** The years a day may be in: four figures, as the vault and Postgres both take them. */
export const DIVIDER_YEARS = { first: 1000, last: 9999 } as const;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const YEAR = /^(\d{4})$/;
const inYears = (y: number) => y >= DIVIDER_YEARS.first && y <= DIVIDER_YEARS.last;

/** Whether `day` is a real day, `YYYY-MM-DD`, of a year from 1000 to 9999. */
export function isDay(day: string): boolean {
  const m = DAY.exec(day);
  if (!m || !inYears(Number(m[1]))) return false;
  const at = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === day;
}

/** Whether a divider's end is one: a whole year (`2014`) or a day (`2014-09-01`), 1000 to 9999. */
export function isDividerEnd(v: string): boolean {
  const y = YEAR.exec(v);
  return y ? inYears(Number(y[1])) : isDay(v);
}

/** A range's ends as days, both included, open where null. */
export interface DaySpan {
  from: string | null;
  to: string | null;
}

/**
 * A folder's ranges as the days they cover, in their own order. An end
 * typed as a day is that day; a start typed as a year is its 1 January; an
 * end typed as a year is its 31 December — unless another range starts
 * with that same year, typed as a year too ("Elementary 2014–2020", then
 * "Middle 2020–2023"): the shared year is the later range's, and this one
 * ends on 31 December of the year before. An end that is neither is kept
 * as it is, for `dividersProblemOf` to refuse.
 */
export function resolvedRanges(d: FolderDividers | undefined): DaySpan[] {
  const ranges = d?.ranges ?? [];
  const startsByYear = new Set(
    ranges.map((r) => r.from).filter((f): f is string => f !== null && YEAR.test(f)),
  );
  return ranges.map((r, i) => {
    const from = r.from !== null && YEAR.test(r.from) ? `${r.from}-01-01` : r.from;
    let to = r.to;
    if (to !== null && YEAR.test(to)) {
      const y = Number(to);
      const shared = startsByYear.has(to) && ranges.some((o, j) => j !== i && o.from === r.to);
      to = shared ? `${String(y - 1).padStart(4, '0')}-12-31` : `${to}-12-31`;
    }
    return { from, to };
  });
}

/** What a folder's dividers are refused with: their codes. */
export type DividerProblemCode =
  | 'cabinet_too_many_dividers'
  | 'cabinet_divider_name_missing'
  | 'cabinet_divider_name_too_long'
  | 'cabinet_divider_dates'
  | 'cabinet_divider_overlap';

/** Two spans share a day: each end open counts as reaching as far as it can. */
function overlap(a: DaySpan, b: DaySpan): boolean {
  const startsBeforeEnd = (x: DaySpan, y: DaySpan) =>
    x.from === null || y.to === null || x.from <= y.to;
  return startsBeforeEnd(a, b) && startsBeforeEnd(b, a);
}

/** A range as it was typed: "2014 to 2020", "from 2027-09-01". */
const typedWords = (r: DividerRange) =>
  r.from && r.to ? `${r.from} to ${r.to}` : r.from ? `from ${r.from}` : `until ${r.to ?? ''}`;

/**
 * What is wrong with one folder's dividers, in words, or null: how many,
 * their names, their ends, and two that share a day once resolved
 * (`resolvedRanges`) — refused, never settled by which comes first, so a
 * paper is behind one divider only.
 */
export function dividersProblemOf(
  d: FolderDividers,
): { code: DividerProblemCode; message: string } | null {
  if (d.ranges.length > DIVIDER_LIMITS.ranges) {
    return {
      code: 'cabinet_too_many_dividers',
      message: `A folder can have at most ${DIVIDER_LIMITS.ranges} dividers of its own.`,
    };
  }
  const spans = resolvedRanges(d);
  for (const [i, r] of d.ranges.entries()) {
    const name = r.name.trim();
    if (name === '') {
      return { code: 'cabinet_divider_name_missing', message: 'Every divider needs a name.' };
    }
    if ([...name].length > DIVIDER_LIMITS.name) {
      return {
        code: 'cabinet_divider_name_too_long',
        message: `Keep each divider’s name to ${DIVIDER_LIMITS.name} characters.`,
      };
    }
    const span = spans[i] as DaySpan;
    if (
      (r.from !== null && !isDividerEnd(r.from)) ||
      (r.to !== null && !isDividerEnd(r.to)) ||
      (r.from === null && r.to === null) ||
      (span.from !== null && span.to !== null && span.from > span.to)
    ) {
      return {
        code: 'cabinet_divider_dates',
        message: `The divider “${name}” needs a start or an end — a year (2014) or a full date (2014-09-01), from 1000 to 9999 — and its start can’t be after its end.`,
      };
    }
  }
  for (const [i, a] of d.ranges.entries()) {
    for (const [k, b] of d.ranges.slice(i + 1).entries()) {
      if (overlap(spans[i] as DaySpan, spans[i + 1 + k] as DaySpan)) {
        return {
          code: 'cabinet_divider_overlap',
          message: `The dividers “${a.name.trim()}” (${typedWords(a)}) and “${b.name.trim()}” (${typedWords(b)}) share days. A paper goes behind one divider only: end one before the other starts.`,
        };
      }
    }
  }
  return null;
}

/**
 * A folder's own ranges, newest first, each with its key (its place in the
 * folder's list) and the days it covers (`resolvedRanges`).
 */
export function rangesNewestFirst(
  d: FolderDividers | undefined,
): Array<{ key: string; range: DividerRange }> {
  const spans = resolvedRanges(d);
  // They never overlap: the latest start is the newest; one open at its start, last.
  return (d?.ranges ?? [])
    .map((r, i) => ({ key: `range:${i}`, range: { name: r.name, ...(spans[i] as DaySpan) } }))
    .sort((a, b) => {
      const af = a.range.from ?? '';
      const bf = b.range.from ?? '';
      return af === bf ? 0 : af < bf ? 1 : -1;
    });
}

/**
 * The divider a paper dated `day` (`YYYY-MM-DD`) is behind, by its key. A
 * year outside 1000 to 9999 has no year divider of its own: Other years.
 */
export function dividerKeyOf(d: FolderDividers | undefined, day: string): string {
  switch (dividerMode(d)) {
    case 'none':
      return 'all';
    case 'years': {
      const y = /^(\d{4})-/.exec(day);
      return y && inYears(Number(y[1])) ? `year:${y[1]}` : 'other';
    }
    case 'ranges': {
      const at = resolvedRanges(d).findIndex(
        (r) => (r.from === null || r.from <= day) && (r.to === null || day <= r.to),
      );
      return at === -1 ? 'other' : `range:${at}`;
    }
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayWords = (day: string): string => {
  const [y, m, d] = day.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? ''} ${y}`;
};

/** The days a range covers, in words: "1 Jan 2014 – 31 Dec 2019", "from 1 Sep 2027". */
export function daySpanWords(span: DaySpan): string {
  if (span.from && span.to) return `${dayWords(span.from)} – ${dayWords(span.to)}`;
  if (span.from) return `from ${dayWords(span.from)}`;
  return span.to ? `until ${dayWords(span.to)}` : '';
}

const ymd = (y: number, m: number, d: number) =>
  `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * School stages from a date of birth ("Use these dividers for…"): the
 * American school years, each starting on 1 September — kindergarten the
 * year somebody is five by then, elementary to the end of fifth grade (six
 * years), middle school three, high school four, then college, its end
 * open. The stages never overlap; each is the family's to rename or move.
 */
export function schoolStages(dateOfBirth: string): DividerRange[] | null {
  if (!isDay(dateOfBirth)) return null;
  const [y, m, d] = dateOfBirth.split('-').map(Number) as [number, number, number];
  // Five by 1 September of the year they start.
  const start = y + 5 + (m > 9 || (m === 9 && d > 1) ? 1 : 0);
  const stage = (name: string, from: number, years: number | null): DividerRange => ({
    name,
    from: ymd(from, 9, 1),
    to: years === null ? null : ymd(from + years, 8, 31),
  });
  return [
    stage('College', start + 13, null),
    stage('High school', start + 9, 4),
    stage('Middle school', start + 6, 3),
    stage('Elementary', start, 6),
  ];
}
