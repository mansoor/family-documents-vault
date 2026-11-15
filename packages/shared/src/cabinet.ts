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

/** The ways the vault draws a cabinet from what it knows ("Arrange by"). */
export const ARRANGE_BY = ['person_category_year', 'category_year_person', 'person_kind'] as const;
export type ArrangeBy = (typeof ARRANGE_BY)[number];

/** Each way, as the picker offers it. */
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

export interface Cabinet extends Node {
  drawers: CabinetDrawer[];
}

/** A person's whole arrangement: their cabinets, in order. */
export interface CabinetLayout {
  /** The way it was drawn, if it was: what the page says it is arranged by. */
  arranged_by: ArrangeBy | null;
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
  counts: Record<string, number>;
  /** How many documents the caller can see, notes left out. */
  documents: number;
  /** How many of them no folder holds: no topic, or no kind, yet. */
  left_out: number;
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
  let out = what.join(' ');
  if (f.member_id) out += `, for ${f.member_id.split(',').map(names.person).join(' or ')}`;
  return `${out}.`;
}
