/**
 * My cabinet (0.9.0, C1; the owner's idea of 13 Nov 2026): each person's
 * own cabinets, drawers and folders, laid out the way they file paper at
 * home. The wire's half, shared by the vault, the client, its fake and the
 * web.
 *
 * A folder is a saved question, never a place: its `filter` is what GET
 * /documents takes (the same names, checked by the same parser), so a
 * paper is in every folder whose question it answers — nothing is filed
 * twice, and a new paper is in its folders as soon as its details say so.
 * A folder can only narrow what its person may see already: its documents
 * and its count come from the list's own rules.
 *
 * The layout is its person's alone (`cabinet_layout`, 0097): nobody else,
 * an owner included, reads or writes it. Its order is the order of each
 * list; a node hidden is kept, and shown only while arranging.
 */

import {
  dividersProblemOf,
  type DividerProblemCode,
  type FolderDividers,
  type PinsMoved,
} from './cabinet-dividers.js';
import { CATEGORY_LABELS } from './tokens.js';

/**
 * The levels a cabinet is arranged by (0.9.0-dev.90; the owner's idea of 19
 * Nov 2026): an ordered list of 2 to 5 of them. The first three are the
 * cabinet, the drawer and the folder; the fourth and fifth are dividers
 * inside each folder, worked out as it opens, so they cost no folders. With
 * two levels there is one cabinet, "My cabinet": the first level is its
 * drawers and the second its folders.
 *
 *  - `topic`: the kind's category ("Financial").
 *  - `person`: whose it is (a person, The household, or Not sure yet).
 *  - `year`: the year it is about (issued, else added).
 *  - `kind`: its kind ("Bank statement").
 */
export const CABINET_LEVELS = ['topic', 'person', 'year', 'kind'] as const;
export type CabinetLevel = (typeof CABINET_LEVELS)[number];

/** How many levels an arrangement has, and how many of them make cabinets, drawers and folders. */
export const LEVEL_LIMITS = {
  fewest: 2,
  most: 5,
  /** Cabinet, drawer and folder: the rest are dividers. */
  nodes: 3,
  /** Divider levels inside one folder. */
  dividers: 2,
} as const;

/** Each level, as the picker shows it. */
export const CABINET_LEVEL_WORDS: Record<
  CabinetLevel,
  { name: string; hint: string; example: string }
> = {
  topic: { name: 'Topic', hint: 'what it is about', example: 'Financial' },
  person: { name: 'Person', hint: 'whose it is', example: 'Me' },
  year: { name: 'Year', hint: 'issued, else added', example: '2026' },
  kind: { name: 'Kind', hint: 'bank statement, payslip…', example: 'Bank statement' },
};

/** Levels the picker shows that are not offered yet. */
export const LEVELS_COMING = [
  { key: 'issuer', name: 'Who issued it', hint: 'the bank, the employer…' },
] as const;

/** One-tap shortcuts that fill the picker. */
export const LEVEL_PRESETS: ReadonlyArray<readonly CabinetLevel[]> = [
  ['person', 'topic', 'year'],
  ['topic', 'year', 'person'],
  ['person', 'kind'],
];

/** Levels in words: "Topic › Year › Person". */
export function levelsWords(levels: readonly CabinetLevel[]): string {
  return levels.map((l) => CABINET_LEVEL_WORDS[l].name).join(' › ');
}

const isLevel = (l: unknown): l is CabinetLevel =>
  typeof l === 'string' && (CABINET_LEVELS as readonly string[]).includes(l);

/** What is wrong with an arrangement's levels, in words, or null: 2 to 5 levels, each once. */
export function levelsProblem(levels: readonly unknown[]): string | null {
  if (levels.length < LEVEL_LIMITS.fewest || levels.length > LEVEL_LIMITS.most) {
    return `Choose from ${LEVEL_LIMITS.fewest} to ${LEVEL_LIMITS.most} levels to arrange your cabinet by.`;
  }
  if (!levels.every(isLevel)) return 'That is not something a cabinet can be arranged by.';
  if (new Set(levels).size !== levels.length) return 'Each level can be used only once.';
  return null;
}

/**
 * What is wrong with one cabinet's own arrangement, in words, or null: the
 * 2 to 4 levels below the cabinet, each once, never the default's first
 * level (the cabinet itself), and only while the default has three or more.
 */
export function ownLevelsProblem(
  own: readonly unknown[],
  defaults: readonly CabinetLevel[] | null,
): string | null {
  if (!defaults || defaults.length < LEVEL_LIMITS.nodes) {
    return 'A cabinet can have its own arrangement only while your cabinet is arranged by three levels or more.';
  }
  if (own.length < LEVEL_LIMITS.fewest || own.length > LEVEL_LIMITS.most - 1) {
    return `A cabinet’s own arrangement needs from ${LEVEL_LIMITS.fewest} to ${LEVEL_LIMITS.most - 1} levels below the cabinet.`;
  }
  if (!own.every(isLevel)) return 'That is not something a cabinet can be arranged by.';
  if (new Set(own).size !== own.length) return 'Each level can be used only once.';
  const first = defaults[0] as CabinetLevel;
  if (own.includes(first)) {
    return `${CABINET_LEVEL_WORDS[first].name} is the cabinet itself, so it can’t be a level inside it.`;
  }
  return null;
}

/**
 * The ways an older vault drew a cabinet ("Arrange by").
 * @deprecated Since 0.9.0-dev.90, levels (`CabinetLayout.levels`) replace
 * them; kept for apps built against them, removed in 0.13.0.
 */
export const ARRANGE_BY = ['person_category_year', 'category_year_person', 'person_kind'] as const;
/** @deprecated Since 0.9.0-dev.90: `CabinetLevel[]`. Removed in 0.13.0. */
export type ArrangeBy = (typeof ARRANGE_BY)[number];

/**
 * Each way, as an older picker offered it.
 * @deprecated Since 0.9.0-dev.90: `levelsWords`. Removed in 0.13.0.
 */
export const ARRANGE_BY_WORDS: Record<ArrangeBy, { title: string; example: string }> = {
  person_category_year: {
    title: 'By person, then topic, then year',
    example: 'Sara › Education › 2025 · Ahmed › Tax › 2024',
  },
  category_year_person: {
    title: 'By topic, then year, then person',
    example: 'Tax › 2025 › Ahmed · Financial › 2024 › Olivia',
  },
  person_kind: {
    title: 'By person, then kind',
    example: 'Tariq › Passport · Olivia › Payslip',
  },
};

/** Each older way's levels: what POST /cabinet/preview's `arrange_by` (deprecated) still takes. */
export const ARRANGE_BY_LEVELS: Readonly<Record<ArrangeBy, readonly CabinetLevel[]>> = {
  person_category_year: ['person', 'topic', 'year'],
  category_year_person: ['topic', 'year', 'person'],
  person_kind: ['person', 'kind'],
};

/**
 * What a folder may ask: GET /documents's filters, by their own names, and
 * nothing that pages, sorts or reaches the Trash.
 */
export const CABINET_FILTER_KEYS = [
  'member_id',
  'category',
  'type_key',
  'issued_by',
  'tag',
  'tag_label',
  'notes',
  'sensitive',
  'visibility',
  'essential',
  'status',
  'collection_id',
  'location',
  // Its place in a cabinet, as one line (0.9.0, C3): as `location`, only for
  // whoever sees where originals are kept.
  'original_place',
  // The folder its papers came from (0.9.0, C4): as `location`, only for
  // whoever sees where originals are kept.
  'source_folder',
  'added_from',
  'added_to',
  'issued_from',
  'issued_to',
  'expires_from',
  'expires_to',
  'dated_from',
  'dated_to',
] as const;
export type CabinetFilterKey = (typeof CABINET_FILTER_KEYS)[number];

/** A folder's saved question: GET /documents's own parameters, as an address carries them. */
export type FolderFilter = {
  [K in Exclude<CabinetFilterKey, 'tag'>]?: string;
} & {
  /** A tag, or several (any of them), as the list takes them. */
  tag?: string | string[];
};

interface Node {
  /** Unique within the layout: letters, digits, `-` and `_`, at most 40. */
  id: string;
  name: string;
  /** Kept, but shown only while arranging. */
  hidden: boolean;
}

export interface CabinetFolder extends Node {
  filter: FolderFilter;
  /**
   * How its papers are grouped inside (0.9.0, C2): year dividers when it
   * is absent; turned off, or the folder's own date ranges.
   */
  dividers?: FolderDividers | undefined;
}

export interface CabinetDrawer extends Node {
  folders: CabinetFolder[];
}

/**
 * What made a drawn cabinet: the value of the arrangement's first level it
 * holds (`financial`, a person's id, `2026`, a kind), or null for the one
 * "My cabinet" of two levels; and, optionally, its own levels below it.
 */
export interface DrawnFrom {
  value: string | null;
  /**
   * Its own arrangement: the 2 to 4 levels below the cabinet, never the
   * default's first. Absent: it follows the default.
   */
  levels?: CabinetLevel[] | undefined;
}

export interface Cabinet extends Node {
  drawers: CabinetDrawer[];
  /**
   * How it was drawn (0.9.0-dev.90). A cabinet without it was arranged by
   * hand (a kept folder tree, say): never redrawn, never grown, kept beside
   * the drawn ones.
   */
  drawn?: DrawnFrom | undefined;
}

/** A person's whole arrangement: their cabinets, in order. */
export interface CabinetLayout {
  /**
   * The default levels every drawn cabinet follows (0.9.0-dev.90), 2 to 5;
   * null for a cabinet arranged by hand, which is never redrawn or grown.
   */
  levels: CabinetLevel[] | null;
  /** What older apps read (deprecated): the vault sends null, and ignores what it is sent. */
  arranged_by?: null | undefined;
  cabinets: Cabinet[];
}

/** GET /cabinet: the caller's layout, none until they save one (`version` 0). */
export interface CabinetView {
  layout: CabinetLayout | null;
  version: number;
  updated_at: string | null;
}

/** PUT /cabinet: the whole layout, made to the version last read. */
export interface CabinetSave {
  layout: CabinetLayout;
  version: number;
  /**
   * Folders merged into others (0.9.0, C2): each one's pinned papers moved
   * to the folder it joined. A pin of a folder the layout no longer has is
   * let go.
   */
  pins_moved?: PinsMoved[];
}

/** POST /cabinet/preview: a layout drawn, not saved, and how many each folder holds. */
export interface CabinetPreview {
  layout: CabinetLayout;
  /** How many each folder drawn afresh holds; a folder kept as it was is not here. */
  counts: Record<string, number>;
  /** How many documents the caller can see, notes left out. */
  documents: number;
  /** How many of them no folder holds: no topic, or no kind, yet. */
  left_out: number;
  /** How big the layout is, and whether it is past what a cabinet may hold (0.9.0-dev.90). */
  size: CabinetSize;
}

/**
 * POST /cabinet/preview (0.9.0-dev.90): the default levels, and, for one
 * cabinet's own arrangement, which one and its levels below it (null: the
 * default again), drawn over `layout` (the saved one when absent).
 */
export interface CabinetPreviewAsk {
  levels: CabinetLevel[];
  cabinet?: { id: string; levels: CabinetLevel[] | null } | undefined;
  layout?: CabinetLayout | undefined;
}

/**
 * How big a layout is (0.9.0-dev.90): its parts counted, the fullest drawer
 * and the cabinet with most drawers, each named and with its cabinet's id,
 * and what refuses it (past `CABINET_LIMITS`), or null.
 */
export interface CabinetSize {
  cabinets: number;
  drawers: number;
  folders: number;
  nodes: number;
  biggest_drawer: { cabinet_id: string; path: [string, string]; folders: number } | null;
  biggest_cabinet: { cabinet_id: string; name: string; drawers: number } | null;
  over: CabinetProblemCode | null;
}

/**
 * GET /cabinet/counts: how many documents each shown folder holds for the
 * caller, by the list's own rules; `null` for one whose question they may no
 * longer ask (where originals are kept, after a role changed).
 */
export interface CabinetCounts {
  version: number;
  counts: Record<string, number | null>;
  /**
   * How many papers are pinned in each folder that has any (0.9.0, C2),
   * hidden folders too — those the caller may still open, out of the
   * Trash: what saving an arrangement without that folder lets go of.
   * Absent from older vaults.
   */
  pins?: Record<string, number>;
  /**
   * Whether the caller filed papers from a folder their cabinet asks for
   * nowhere yet (0.9.0, C4, `features.source_folders`): what GET
   * /cabinet/from-folders would add, asked cheaply. Only for whoever sees
   * where originals are kept; absent otherwise, and from older vaults.
   */
  new_folders?: boolean;
  /**
   * How many documents the cabinet holds for the caller, each once however
   * many folders hold it (19 Nov 2026): exactly the Documents table's
   * unfiltered total — what they see, out of the Trash, notes left out.
   * With a saved layout only; absent from older vaults.
   */
  documents?: number;
  /** How many of them no shown folder holds, by its question or a pin (GET /cabinet/unfiled). */
  unfiled?: number;
  /** How many of them more than one shown folder holds: why the folders add up to more. */
  in_several?: number;
}

/**
 * What a cabinet holds, in words beside its total (19 Nov 2026): "2 aren't
 * in any folder", "3 are in more than one folder". Null for none.
 */
export function unfiledWords(n: number): string | null {
  return n <= 0 ? null : `${n} ${n === 1 ? 'isn’t' : 'aren’t'} in any folder`;
}
export function inSeveralWords(n: number): string | null {
  return n <= 0 ? null : `${n} ${n === 1 ? 'is' : 'are'} in more than one folder`;
}

/** A folder a document is in, as GET /documents/{id}/also-in names it. */
export interface AlsoInFolder {
  id: string;
  name: string;
  /** Its cabinet's, its drawer's and its own name. */
  path: [string, string, string];
  /** Pinned there by hand (0.9.0, C2), whether or not its question holds it too. */
  pinned?: boolean;
}

export interface AlsoIn {
  items: AlsoInFolder[];
}

/** How big a layout may be. */
export const CABINET_LIMITS = {
  cabinets: 50,
  /** Drawers in one cabinet. */
  drawers: 200,
  /** Folders in one drawer. */
  folders: 300,
  /** Every folder of the layout. */
  folders_total: 1000,
  /** Cabinets, drawers and folders together. */
  nodes: 1500,
  name: 80,
  /** Folders that ask a status, worked out for every paper on each count. */
  status_folders: 200,
  /** One folder's question, as JSON, in UTF-8 bytes. */
  filter_bytes: 4096,
  /**
   * The whole layout, as JSON, in UTF-8 bytes. Postgres keeps it as jsonb,
   * whose text adds a space after each `:` and `,`, at most half again:
   * well inside 0097's own floor of 1 MiB.
   */
  layout_bytes: 512 * 1024,
} as const;

export const CABINET_NODE_ID = /^[A-Za-z0-9_-]{1,40}$/;

/** What a layout too big, or drawn too big, is refused with. */
export const CABINET_TOO_BIG =
  'That is more folders than a cabinet can hold. Hide or merge some, or choose another way to arrange it.';
export const CABINET_CHANGED =
  'Your cabinet was changed somewhere else, in another window or on another device. Load it again and try once more.';

/** Every node of a layout, counted. */
export function layoutSize(layout: CabinetLayout): {
  cabinets: number;
  drawers: number;
  folders: number;
  nodes: number;
} {
  let drawers = 0;
  let folders = 0;
  for (const c of layout.cabinets) {
    drawers += c.drawers.length;
    for (const d of c.drawers) folders += d.folders.length;
  }
  const cabinets = layout.cabinets.length;
  return { cabinets, drawers, folders, nodes: cabinets + drawers + folders };
}

/**
 * What is wrong with a layout's shape, in words, or null: its sizes, its
 * names and its ids. Each folder's question is the vault's to check (the
 * list's own parser); this is what the web can say before it is sent.
 */
export function layoutProblem(layout: CabinetLayout): string | null {
  return layoutProblemOf(layout)?.message ?? null;
}

/** What a refused layout is answered with: its code, and its words. */
export type CabinetProblemCode =
  | 'cabinet_too_big'
  | 'cabinet_too_many_status_folders'
  | 'cabinet_node_id'
  | 'cabinet_name_missing'
  | 'cabinet_name_too_long'
  | 'cabinet_levels'
  | DividerProblemCode;

export const CABINET_TOO_MANY_STATUS = `A cabinet can have at most ${CABINET_LIMITS.status_folders} folders that ask for a status. Merge or remove some.`;

/** `layoutProblem`, with the code a refusal carries. */
export function layoutProblemOf(
  layout: CabinetLayout,
): { code: CabinetProblemCode; message: string } | null {
  const size = layoutSize(layout);
  if (
    size.cabinets > CABINET_LIMITS.cabinets ||
    size.folders > CABINET_LIMITS.folders_total ||
    size.nodes > CABINET_LIMITS.nodes ||
    layout.cabinets.some(
      (c) =>
        c.drawers.length > CABINET_LIMITS.drawers ||
        c.drawers.some((d) => d.folders.length > CABINET_LIMITS.folders),
    )
  ) {
    return { code: 'cabinet_too_big', message: CABINET_TOO_BIG };
  }
  const statusFolders = layout.cabinets
    .flatMap((c) => c.drawers.flatMap((d) => d.folders))
    .filter((f) => f.filter.status !== undefined).length;
  if (statusFolders > CABINET_LIMITS.status_folders) {
    return { code: 'cabinet_too_many_status_folders', message: CABINET_TOO_MANY_STATUS };
  }
  // The levels (0.9.0-dev.90): the default's, and each cabinet's own.
  if (layout.levels !== null && layout.levels !== undefined) {
    const wrong = Array.isArray(layout.levels)
      ? levelsProblem(layout.levels)
      : 'That is not something a cabinet can be arranged by.';
    if (wrong) return { code: 'cabinet_levels', message: wrong };
  }
  for (const c of layout.cabinets) {
    const own = c.drawn?.levels;
    if (own === undefined) continue;
    const wrong = Array.isArray(own)
      ? ownLevelsProblem(own, layout.levels ?? null)
      : 'That is not something a cabinet can be arranged by.';
    if (wrong) {
      return { code: 'cabinet_levels', message: `The cabinet “${c.name.trim()}”: ${wrong}` };
    }
  }
  const ids = new Set<string>();
  const nodes = layout.cabinets.flatMap((c) => [c, ...c.drawers.flatMap((d) => [d, ...d.folders])]);
  for (const n of nodes) {
    if (!CABINET_NODE_ID.test(n.id) || ids.has(n.id)) {
      return { code: 'cabinet_node_id', message: 'Each part of a cabinet needs its own id.' };
    }
    ids.add(n.id);
    const name = n.name.trim();
    if (name === '') {
      return {
        code: 'cabinet_name_missing',
        message: 'Every cabinet, drawer and folder needs a name.',
      };
    }
    if ([...name].length > CABINET_LIMITS.name) {
      return {
        code: 'cabinet_name_too_long',
        message: `Keep each name to ${CABINET_LIMITS.name} characters.`,
      };
    }
  }
  // Each folder's own dividers (C2), the folder named.
  for (const c of layout.cabinets) {
    for (const d of c.drawers) {
      for (const f of d.folders) {
        if (f.dividers === undefined) continue;
        const wrong = dividersProblemOf(f.dividers);
        if (wrong)
          return { code: wrong.code, message: `The folder “${f.name.trim()}”: ${wrong.message}` };
      }
    }
  }
  return null;
}

/** A name as a cabinet may hold it: at most `CABINET_LIMITS.name` characters, cut with an ellipsis. */
export function cabinetName(name: string): string {
  const chars = [...name.trim()];
  return chars.length <= CABINET_LIMITS.name
    ? chars.join('')
    : `${chars
        .slice(0, CABINET_LIMITS.name - 1)
        .join('')
        .trimEnd()}…`;
}

// ------------------------------------------------------------- merging

/** The filters that hold several values, comma-separated, any of them. */
const SEVERAL: readonly CabinetFilterKey[] = [
  'member_id',
  'category',
  'type_key',
  'status',
  'visibility',
  'sensitive',
];
const RANGES = ['added', 'issued', 'expires', 'dated'] as const;

/** A filter's facets: each key alone, a date range's two ends together. */
function facetsOf(f: FolderFilter): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined) continue;
    const range = RANGES.find((r) => k === `${r}_from` || k === `${r}_to`);
    const facet = range ?? k;
    const was = out.get(facet);
    const value = Array.isArray(v) ? JSON.stringify([...v].sort()) : String(v);
    out.set(facet, was === undefined ? `${k}=${value}` : [was, `${k}=${value}`].sort().join('&'));
  }
  return out;
}

const dayAfter = (day: string): string => {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + 1);
  return at.toISOString().slice(0, 10);
};

/**
 * One question that asks exactly what two folders asked between them, or
 * null where no one question can: they must differ in one thing alone —
 * one filter of several values (both people, both kinds), or one date
 * range that meets or overlaps (2024 and 2025 make 2024 to 2025).
 */
export function mergeFolderFilters(a: FolderFilter, b: FolderFilter): FolderFilter | null {
  const fa = facetsOf(a);
  const fb = facetsOf(b);
  const facets = new Set([...fa.keys(), ...fb.keys()]);
  const differ = [...facets].filter((k) => fa.get(k) !== fb.get(k));
  if (differ.length === 0) return { ...a };
  if (differ.length > 1) return null;
  const facet = differ[0] as string;
  // Both must ask it: one that asks nothing of it already asks everything.
  if (!fa.has(facet) || !fb.has(facet)) {
    const wider = fa.has(facet) ? b : a;
    return { ...wider };
  }
  if ((SEVERAL as readonly string[]).includes(facet)) {
    const key = facet as Exclude<CabinetFilterKey, 'tag'>;
    const values = [
      ...new Set([...(a[key] ?? '').split(','), ...(b[key] ?? '').split(',')]),
    ].filter((v) => v !== '');
    return { ...a, [key]: values.join(',') };
  }
  if (facet === 'tag') {
    const list = (t: FolderFilter['tag']) => (t === undefined ? [] : Array.isArray(t) ? t : [t]);
    return { ...a, tag: [...new Set([...list(a.tag), ...list(b.tag)])] };
  }
  const range = RANGES.find((r) => r === facet);
  if (range) {
    const from = `${range}_from` as const;
    const to = `${range}_to` as const;
    const [first, second] = (a[from] ?? '') <= (b[from] ?? '') ? [a, b] : [b, a];
    // Open at either end stays open; otherwise they must meet.
    const firstTo = first[to];
    const secondFrom = second[from];
    if (firstTo !== undefined && secondFrom !== undefined && dayAfter(firstTo) < secondFrom) {
      return null;
    }
    const merged: FolderFilter = { ...a };
    delete merged[from];
    delete merged[to];
    if (first[from] !== undefined) merged[from] = first[from];
    const lastTo =
      first[to] === undefined || second[to] === undefined
        ? undefined
        : first[to] > second[to]
          ? first[to]
          : second[to];
    if (lastTo !== undefined) merged[to] = lastTo;
    return merged;
  }
  return null;
}

/** Two names as one: "2024 and 2025", kept to the longest a name may be. */
export function mergedName(a: string, b: string): string {
  if (a.trim().toLowerCase() === b.trim().toLowerCase()) return a;
  const both = `${a} and ${b}`;
  return [...both].length <= CABINET_LIMITS.name ? both : a;
}

// ------------------------------------------------------------- words

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayWords = (day: string): string => {
  const [y, m, d] = day.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? ''} ${y}`;
};

/** A date range in words: "2025", "2023 to 2025", "since 2020", "1 Mar 2025 to 4 Apr 2025". */
export function rangeWords(from: string | undefined, to: string | undefined): string | null {
  if (from === undefined && to === undefined) return null;
  const wholeFrom = from === undefined || from.endsWith('-01-01');
  const wholeTo = to === undefined || to.endsWith('-12-31');
  if (wholeFrom && wholeTo) {
    const a = from?.slice(0, 4);
    const b = to?.slice(0, 4);
    if (a && b) return a === b ? a : `${a} to ${b}`;
    return a ? `since ${a}` : `until the end of ${b as string}`;
  }
  if (from && to) return `${dayWords(from)} to ${dayWords(to)}`;
  return from ? `since ${dayWords(from)}` : `until ${dayWords(to as string)}`;
}

/** A category's name, or names: "Tax", "Tax or Work". */
export function categoriesWords(value: string): string {
  return value
    .split(',')
    .filter((v) => v !== '')
    .map((c) => CATEGORY_LABELS[c] ?? c)
    .join(' or ');
}

/**
 * What a folder holds, in a sentence a family reads: "Tax papers dated
 * 2025, for Ahmed." Each name is the page's to give (people and kinds as
 * the reader is given them).
 */
export function folderQuestionWords(
  f: FolderFilter,
  names: { person: (id: string) => string; kind: (key: string) => string },
): string {
  const what: string[] = [];
  if (f.type_key) what.push(f.type_key.split(',').map(names.kind).join(' or '));
  else if (f.category) what.push(`${categoriesWords(f.category)} papers`);
  else what.push('Papers');
  const dated = rangeWords(f.dated_from, f.dated_to);
  if (dated)
    what.push(dated.startsWith('since') || dated.startsWith('until') ? dated : `dated ${dated}`);
  const issued = rangeWords(f.issued_from, f.issued_to);
  if (issued) what.push(`issued ${issued}`);
  if (f.type_key && f.category) what.push(`in ${categoriesWords(f.category)}`);
  if (f.issued_by) what.push(`from ${f.issued_by}`);
  // The folder they came from (C4), as the vault keeps it.
  if (f.source_folder) what.push(`that came from the folder “${f.source_folder}”`);
  let out = what.join(' ');
  if (f.member_id) out += `, for ${f.member_id.split(',').map(names.person).join(' or ')}`;
  return `${out}.`;
}
