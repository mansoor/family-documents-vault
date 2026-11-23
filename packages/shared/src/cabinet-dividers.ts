import type { CabinetLevel, FolderFilter } from './cabinet.js';
import type { DocumentView } from './documents.js';
import { compareIssuerNames, NO_ISSUER_GIVEN } from './issuer-groups.js';
import { CATEGORY_LABELS } from './tokens.js';

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
 *    years. A paper in no range goes behind "Other years";
 *  - or (0.9.0-dev.90) by up to two levels, in order — kind, then year,
 *    say: "Bank statement · 2025" — which a drawing writes from its levels
 *    4 and 5. Year is never one where it is a level above already.
 *
 * Year dividers with only one of them to show — a folder in a 2026 drawer,
 * say — are passed over, and the folder is one plain list; a folder whose
 * question is one year is never divided by year (`shownDividers`). A
 * folder's own ranges are never passed over.
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

/**
 * How a folder's papers are grouped (0.9.0; by levels since
 * 0.9.0-dev.90). A folder without it has year dividers: `{ levels:
 * ['year'], ranges: [] }`.
 */
export interface FolderDividers {
  /**
   * Up to two levels, in order, each a divider inside the one before ("by
   * kind, then year"); none: one plain list. A drawing writes them: its
   * levels 4 and 5.
   */
  levels: CabinetLevel[];
  /**
   * The folder's own ranges: when there are any, they take Year's place
   * among the levels, or come first where Year is not one.
   */
  ranges: DividerRange[];
}

/** What a folder without dividers of its own is divided by. */
export const YEAR_DIVIDERS: FolderDividers = { levels: ['year'], ranges: [] };

/** What groups a folder's papers, in words a page may choose by: its own ranges, years, levels, or nothing. */
export type DividerMode = 'years' | 'ranges' | 'none' | 'levels';

export function dividerMode(d: FolderDividers | undefined): DividerMode {
  if (d && d.ranges.length > 0) return 'ranges';
  const levels = d?.levels ?? ['year'];
  if (levels.length === 0) return 'none';
  return levels.length === 1 && levels[0] === 'year' ? 'years' : 'levels';
}

/** One step of how a folder is divided: a level, or the folder's own ranges in Year's place. */
export type DividerDim = CabinetLevel | 'ranges';

/**
 * A folder's divider steps as they may be asked: its levels, its own
 * ranges in Year's place (or first, where Year is not one of them).
 */
export function askedDims(folder: { dividers?: FolderDividers | undefined }): DividerDim[] {
  const d = folder.dividers;
  const levels: DividerDim[] = [...(d?.levels ?? ['year'])];
  if (!d || d.ranges.length === 0) return levels;
  const at = levels.indexOf('year');
  if (at === -1) return ['ranges', ...levels];
  levels[at] = 'ranges';
  return levels;
}

/**
 * A folder's divider steps as it is opened: as asked, except that a folder
 * whose question is one year already (`asksOneYear`) is never divided by
 * year — the year is the folder, or its drawer. Its own named ranges are
 * always kept: they are the person's own.
 */
export function dividerDims(folder: {
  filter: FolderFilter;
  dividers?: FolderDividers | undefined;
}): DividerDim[] {
  const dims = askedDims(folder);
  return asksOneYear(folder.filter) ? dims.filter((d) => d !== 'year') : dims;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whether a folder's question already keeps it to one calendar year: the
 * date each paper is about (or the day it was issued, which is that date
 * wherever there is one) from and to days of the same year — a year
 * folder as a drawing makes it ("2026": 1 Jan to 31 Dec), or a part of one.
 * Year dividers there would be one "2026" holding everything.
 */
export function asksOneYear(filter: FolderFilter): boolean {
  return (['dated', 'issued'] as const).some((r) => {
    const from = filter[`${r}_from`];
    const to = filter[`${r}_to`];
    return (
      from !== undefined &&
      to !== undefined &&
      ISO_DAY.test(from) &&
      ISO_DAY.test(to) &&
      from <= to &&
      from.slice(0, 4) === to.slice(0, 4)
    );
  });
}

/** What a paper is, to the dividers: the day it is about, its kind, its topic and whose it is. */
export interface DividerPaper {
  /** `YYYY-MM-DD`: issued, else added (the list's `dated_`). */
  day: string;
  type_key: string | null;
  category: string | null;
  /** A person's id, `household`, or `none` (Not sure yet). */
  person: string;
  /**
   * Who issued it (0.9.0-dev.91): its issuer key, the household's "Same as"
   * list applied; null or absent for none given.
   */
  issuer?: string | null | undefined;
}

/** How dividers name people and kinds, as the reader is given them, and put people in order. */
export interface DividerNames {
  person: (id: string) => string;
  kind: (key: string) => string;
  /** An issuer key's name, the household's spelling (0.9.0-dev.91); the key itself where absent. */
  issuer?: ((key: string) => string) | undefined;
  personOrder?: ((a: string, b: string) => number) | undefined;
}

const PLAIN_NAMES: DividerNames = { person: (id) => id, kind: (key) => key };

/** The papers without a kind, a topic: behind these, always last. */
export const NO_KIND_YET = 'No kind yet';
export const NO_TOPIC_YET = 'No topic yet';
/** What the smallest dividers past the most a folder shows go behind. */
export const EVERYTHING_ELSE = 'Everything else';

const inSpan = (day: string, s: DaySpan) =>
  (s.from === null || s.from <= day) && (s.to === null || day <= s.to);

/** One step of a paper's divider key. */
function segmentOf(dim: DividerDim, paper: DividerPaper, spans: readonly DaySpan[]): string {
  switch (dim) {
    case 'year': {
      const y = /^(\d{4})-/.exec(paper.day);
      return y && inYears(Number(y[1])) ? `year:${y[1]}` : 'other';
    }
    case 'ranges': {
      const at = spans.findIndex((s) => inSpan(paper.day, s));
      return at === -1 ? 'other' : `range:${at}`;
    }
    case 'kind':
      return `kind:${paper.type_key ?? ''}`;
    case 'topic':
      return `topic:${paper.category ?? ''}`;
    case 'person':
      return `person:${paper.person}`;
    case 'issuer':
      return `issuer:${paper.issuer ?? ''}`;
  }
}

/**
 * The divider a paper is behind, by its key: one step for each of the
 * folder's divider steps, joined by `/` (`kind:payslip/year:2025`); `all`
 * for a folder with none. What one grouped count of a folder is keyed by,
 * in the vault and the fakes alike.
 */
export function dividerKeyOf(
  folder: { filter: FolderFilter; dividers?: FolderDividers | undefined },
  paper: DividerPaper,
): string {
  const dims = dividerDims(folder);
  if (dims.length === 0) return 'all';
  const spans = resolvedRanges(folder.dividers);
  return dims.map((d) => segmentOf(d, paper, spans)).join('/');
}

/** One step of a divider, read back: its level, and its value. */
interface Step {
  dim: DividerDim;
  seg: string;
}

/**
 * A folder's dividers as GET /cabinet/folders/{id} gives them, from how
 * many of its papers (its pinned ones left out) are behind each key
 * `dividerKeyOf` gives. One grouped count is all it needs, however many
 * dividers there are.
 *
 *  - Its own named ranges: each one, newest first, empty or not, then
 *    Other years with something behind it. Never passed over.
 *  - Any other step: each value with something behind it, in its order —
 *    years newest first then Other years, people as the drawing puts them,
 *    topics in the vault's order, kinds by name — those without a value
 *    ("No kind yet") last. A step with only one value is passed over (the
 *    first for the whole folder, the second within each of the first's),
 *    its dividers moving up; with every step passed over, the folder is one
 *    plain list (`all`), as is a folder with no steps. With nothing behind
 *    any, none.
 *  - Each divider is one leaf, its name its steps' joined by " · " ("Bank
 *    statement · 2025"), its `path` each step: an older app shows the flat
 *    list, a newer one groups the leaves under their first step.
 *  - At most `DIVIDER_LIMITS.shown`: past it, the smallest go behind
 *    "Everything else" (`rest`), last.
 */
export function shownDividers(
  folder: { filter: FolderFilter; dividers?: FolderDividers | undefined },
  counts: ReadonlyMap<string, number>,
  names: DividerNames = PLAIN_NAMES,
): FolderDivider[] {
  const sum = [...counts.values()].reduce((a, b) => a + b, 0);
  const all: FolderDivider = {
    key: 'all',
    kind: 'all',
    name: '',
    from: null,
    to: null,
    count: sum,
    path: [],
  };
  const dims = dividerDims(folder);
  if (dims.length === 0) return [all];
  const entries = [...counts]
    .filter(([, n]) => n > 0)
    .map(([key, n]) => ({ segs: key.split('/'), n }));
  const hasRanges = dims.includes('ranges');
  if (entries.length === 0 && !hasRanges) return [];
  const spans = resolvedRanges(folder.dividers);
  const newest = rangesNewestFirst(folder.dividers);
  const leaves: Array<{ path: Step[]; n: number }> = [];
  const walk = (i: number, group: typeof entries, path: Step[]) => {
    if (i === dims.length) {
      leaves.push({ path, n: group.reduce((a, e) => a + e.n, 0) });
      return;
    }
    const dim = dims[i] as DividerDim;
    const by = new Map<string, typeof entries>();
    for (const e of group) {
      const seg = e.segs[i] ?? '';
      by.set(seg, [...(by.get(seg) ?? []), e]);
    }
    if (dim === 'ranges') {
      for (const { key } of newest) walk(i + 1, by.get(key) ?? [], [...path, { dim, seg: key }]);
      const other = by.get('other');
      if (other) walk(i + 1, other, [...path, { dim, seg: 'other' }]);
      return;
    }
    // One value, or none: passed over, its steps moving up.
    if (by.size <= 1) {
      walk(i + 1, group, path);
      return;
    }
    for (const seg of [...by.keys()].sort(orderOf(dim, names))) {
      walk(i + 1, by.get(seg) ?? [], [...path, { dim, seg }]);
    }
  };
  walk(0, entries, []);
  if (leaves.length === 1 && leaves[0]?.path.length === 0) return [all];
  const shown = leaves.map((l) => leafOf(l.path, l.n, spans, folder.dividers, names));
  if (shown.length <= DIVIDER_LIMITS.shown) return shown;
  // The biggest kept, in their order; the smallest behind Everything else.
  const keep = new Set(
    [...shown]
      .map((d, i) => ({ d, i }))
      .sort((a, b) => b.d.count - a.d.count || a.i - b.i)
      .slice(0, DIVIDER_LIMITS.shown - 1)
      .map(({ d }) => d.key),
  );
  const rest = shown.filter((d) => !keep.has(d.key));
  return [
    ...shown.filter((d) => keep.has(d.key)),
    {
      key: 'rest',
      kind: 'group',
      name: EVERYTHING_ELSE,
      from: null,
      to: null,
      count: rest.reduce((n, d) => n + d.count, 0),
      path: [],
    },
  ];
}

/** The order of one step's values: those without a value last. */
function orderOf(dim: DividerDim, names: DividerNames): (a: string, b: string) => number {
  const valueOf = (seg: string) => seg.slice(seg.indexOf(':') + 1);
  const noneLast = (a: string, b: string, then: (x: string, y: string) => number) => {
    const x = valueOf(a);
    const y = valueOf(b);
    if (x === '' || y === '') return x === y ? 0 : x === '' ? 1 : -1;
    return then(x, y);
  };
  switch (dim) {
    case 'year':
      // The newest first; Other years last.
      return (a, b) =>
        a === 'other' ? 1 : b === 'other' ? -1 : Number(valueOf(b)) - Number(valueOf(a));
    case 'kind':
      return (a, b) =>
        noneLast(a, b, (x, y) => names.kind(x).localeCompare(names.kind(y)) || x.localeCompare(y));
    case 'topic':
      return (a, b) => noneLast(a, b, (x, y) => topicRank(x) - topicRank(y) || x.localeCompare(y));
    case 'person':
      return (a, b) => noneLast(a, b, (x, y) => names.personOrder?.(x, y) || x.localeCompare(y));
    case 'issuer': {
      const name = (v: string) => names.issuer?.(v) ?? v;
      return (a, b) =>
        noneLast(a, b, (x, y) => compareIssuerNames(name(x), name(y)) || compareIssuerNames(x, y));
    }
    case 'ranges':
      return () => 0;
  }
}

const TOPIC_ORDER = Object.keys(CATEGORY_LABELS);
const topicRank = (c: string) => {
  const at = TOPIC_ORDER.indexOf(c);
  return at === -1 ? TOPIC_ORDER.length : at;
};

/** One leaf of a folder's dividers, named. */
function leafOf(
  path: readonly Step[],
  count: number,
  spans: readonly DaySpan[],
  dividers: FolderDividers | undefined,
  names: DividerNames,
): FolderDivider {
  let from: string | null = null;
  let to: string | null = null;
  const steps = path.map(({ dim, seg }): DividerStep => {
    const value = seg.slice(seg.indexOf(':') + 1);
    let name: string;
    if (seg === 'other') name = OTHER_YEARS;
    else if (dim === 'year') {
      name = value;
      from = `${value}-01-01`;
      to = `${value}-12-31`;
    } else if (dim === 'ranges') {
      const i = Number(value);
      name = dividers?.ranges[i]?.name ?? '';
      from = spans[i]?.from ?? null;
      to = spans[i]?.to ?? null;
    } else if (dim === 'kind') name = value === '' ? NO_KIND_YET : names.kind(value);
    else if (dim === 'topic')
      name = value === '' ? NO_TOPIC_YET : (CATEGORY_LABELS[value] ?? value);
    else if (dim === 'issuer')
      name = value === '' ? NO_ISSUER_GIVEN : (names.issuer?.(value) ?? value);
    else name = names.person(value);
    return { level: dim === 'ranges' ? 'year' : dim, key: seg, name };
  });
  const only = path.length === 1 ? path[0] : undefined;
  const kind: FolderDivider['kind'] =
    only?.seg === 'other'
      ? 'other'
      : only?.dim === 'year'
        ? 'year'
        : only?.dim === 'ranges'
          ? 'range'
          : 'group';
  return {
    key: path.map((p) => p.seg).join('/'),
    kind,
    name: steps.map((s) => s.name).join(' · '),
    from,
    to,
    count,
    path: steps,
  };
}

/** One step of a divider, as GET /cabinet/folders/{id} names it (0.9.0-dev.90). */
export interface DividerStep {
  /** The level it is a step of: a folder's own range is in Year's place. */
  level: CabinetLevel;
  /**
   * `year:2025`, `range:0`, `other`, `kind:payslip`, `topic:`,
   * `person:household`, `issuer:barclays` (0.9.0-dev.91), `issuer:` (none given)…
   */
  key: string;
  name: string;
}

/** One divider of a folder, as GET /cabinet/folders/{id} gives it. */
export interface FolderDivider {
  /**
   * `year:2025`; `range:0` (the range's place in the folder's own list);
   * `other`, papers in none of its ranges, or of no year 1000 to 9999;
   * `all`, a folder shown as one plain list: no dividers, a year folder, or
   * every step with only one value to show. Since 0.9.0-dev.90 also each
   * step of a folder divided by levels joined by `/`
   * (`kind:bank_statement/year:2025`), and `rest`, Everything else. What
   * GET /cabinet/folders/{id}/documents asks with.
   */
  key: string;
  /** `group` (0.9.0-dev.90): divided by a level other than Year, or by two steps. */
  kind: 'year' | 'range' | 'other' | 'all' | 'group';
  /**
   * Its name: the year, the range's own, "Other years"; each step's joined
   * by " · " ("Bank statement · 2025"); empty for `all`.
   */
  name: string;
  /** Its days, both included, where a year or range is a step of it; else null. */
  from: string | null;
  to: string | null;
  /** How many papers are behind it for the caller, pinned ones left out. */
  count: number;
  /** Each of its steps, in order (0.9.0-dev.90): none for `all` and `rest`. */
  path?: DividerStep[] | undefined;
}

/**
 * What one divider asks beside its folder's question: every one of `atoms`,
 * and none of the leaves in `none_of` (Everything else).
 */
export type DividerAtom =
  | { within: DaySpan }
  | { outside: DaySpan[] }
  | { level: 'kind' | 'topic' | 'person' | 'issuer'; value: string | null };

export interface DividerAsk {
  atoms: DividerAtom[];
  none_of?: DividerAtom[][] | undefined;
}

/**
 * What one divider of a folder asks, by its key; null for none of its. Any
 * of the folder's steps may be asked, in its order, a step passed over left
 * out: what it held is all of it. `all` answers any folder without ranges of
 * its own; `rest` needs the dividers shown (`shown`), and asks for none of
 * them.
 */
export function dividerAsks(
  folder: { filter: FolderFilter; dividers?: FolderDividers | undefined },
  key: string,
  shown?: readonly FolderDivider[],
): DividerAsk | null {
  const dims = askedDims(folder);
  if (key === 'all') return dims.includes('ranges') ? null : { atoms: [] };
  if (key === 'rest') {
    if (!shown?.some((d) => d.key === 'rest')) return null;
    const leaves = shown
      .filter((d) => d.key !== 'rest' && d.key !== 'all')
      .map((d) => dividerAsks(folder, d.key)?.atoms ?? []);
    return { atoms: [], none_of: leaves };
  }
  const spans = resolvedRanges(folder.dividers);
  const atoms: DividerAtom[] = [];
  let next = 0;
  for (const seg of key.split('/')) {
    const level = /^(kind|topic|person|issuer):(.*)$/s.exec(seg);
    const want: DividerDim[] =
      seg === 'other'
        ? ['year', 'ranges']
        : /^year:\d{4}$/.test(seg)
          ? ['year']
          : /^range:\d{1,2}$/.test(seg)
            ? ['ranges']
            : level
              ? [level[1] as DividerDim]
              : [];
    const at = dims.findIndex((d, i) => i >= next && want.includes(d));
    if (at === -1) return null;
    next = at + 1;
    const dim = dims[at] as DividerDim;
    if (seg === 'other') {
      atoms.push({ outside: dim === 'year' ? [DIVIDER_YEAR_SPAN] : [...spans] });
    } else if (dim === 'year') {
      const y = Number(seg.slice(5));
      if (!inYears(y)) return null;
      atoms.push({ within: { from: `${seg.slice(5)}-01-01`, to: `${seg.slice(5)}-12-31` } });
    } else if (dim === 'ranges') {
      const span = spans[Number(seg.slice(6))];
      if (!span) return null;
      atoms.push({ within: span });
    } else {
      const value = (level?.[2] ?? '') === '' ? null : (level?.[2] as string);
      if (dim === 'person' && value === null) return null;
      atoms.push({ level: dim, value });
    }
  }
  return { atoms };
}

/** Whether a paper is behind one divider: what the fakes ask in place of the vault's SQL. */
export function paperBehind(ask: DividerAsk, paper: DividerPaper): boolean {
  const holds = (a: DividerAtom): boolean => {
    if ('within' in a) return inSpan(paper.day, a.within);
    if ('outside' in a) return !a.outside.some((s) => inSpan(paper.day, s));
    const v =
      a.level === 'kind'
        ? paper.type_key
        : a.level === 'topic'
          ? paper.category
          : a.level === 'issuer'
            ? paper.issuer
            : paper.person;
    return (v ?? null) === a.value;
  };
  return ask.atoms.every(holds) && !(ask.none_of ?? []).some((leaf) => leaf.every(holds));
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
  /** Divider levels in one folder. */
  levels: 2,
  /** Dividers shown in one folder: past it, the smallest go behind Everything else. */
  shown: 100,
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

/** The days every year with a divider of its own covers: four figures, as the vault and Postgres take them. */
export const DIVIDER_YEAR_SPAN: DaySpan = {
  from: `${DIVIDER_YEARS.first}-01-01`,
  to: `${DIVIDER_YEARS.last}-12-31`,
};

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
  | 'cabinet_divider_overlap'
  | 'cabinet_divider_levels';

/** The levels a folder may be divided by: a cabinet's own (`CABINET_LEVELS`). */
const DIVIDER_LEVELS: ReadonlySet<string> = new Set(['topic', 'person', 'year', 'kind', 'issuer']);

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
  // Its levels (0.9.0-dev.90): at most two, each once.
  const levels: unknown = (d as { levels?: unknown }).levels;
  if (
    !Array.isArray(levels) ||
    levels.length > DIVIDER_LIMITS.levels ||
    !levels.every((l) => typeof l === 'string' && DIVIDER_LEVELS.has(l)) ||
    new Set(levels).size !== levels.length ||
    !Array.isArray((d as { ranges?: unknown }).ranges)
  ) {
    return {
      code: 'cabinet_divider_levels',
      message: `A folder can be divided by at most ${DIVIDER_LIMITS.levels} levels, each once.`,
    };
  }
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
