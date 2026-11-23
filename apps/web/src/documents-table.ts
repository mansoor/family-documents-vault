import {
  can,
  normaliseTag,
  tagKey,
  tagLabelKey,
  formatDate,
  isDocumentSort,
  mayChangeVisibilityAtAll,
  seesLocation,
  SENSITIVE_FILTER_VALUES,
  visibilityRefusal,
  type DateValue,
  type DocumentListParams,
  type DocumentSort,
  type DocumentView,
  type FolderFilter,
  type Role,
  type SortDirection,
  type StatusValue,
  type Visibility,
} from '@fdv/shared';
import { mayChange } from './DocActions.js';
import { dateOnlyWords } from './family-time.js';

/**
 * The Documents table (Phase 6, R2): what it shows, what the address says
 * about it, what this device remembers of it, and what may be done with
 * many documents at once. The screen is screens/Documents.tsx.
 */

export type ColumnKey =
  | 'title'
  | 'kind'
  | 'person'
  | 'issued'
  | 'expires'
  | 'status'
  | 'visibility'
  | 'location'
  // Where the original is, as a place in a cabinet (0.9.0, C3).
  | 'original_place'
  | 'collections';

export interface Column {
  key: ColumnKey;
  label: string;
  /** Its header's words, where they are shorter than its name (0.9.0, TW): one line. */
  head?: string;
  /**
   * Its width in px in a collection's Add documents (collection-add.tsx);
   * the title takes what is left, at least `TITLE_MIN`. The Documents table
   * sizes its own (column-widths.tsx).
   */
  width: number | null;
  /** Dates line up on the right. */
  end?: boolean;
}

/** Each column, in the table's order; the sort it asks for has its key. */
export const COLUMNS: readonly Column[] = [
  { key: 'title', label: 'Title', width: null },
  { key: 'kind', label: 'Kind', width: 96 },
  { key: 'person', label: 'Person', width: 92 },
  { key: 'issued', label: 'Issued', width: 100, end: true },
  { key: 'expires', label: 'Expires', width: 100, end: true },
  { key: 'status', label: 'Status', width: 120 },
  { key: 'visibility', label: 'Who can see it', head: 'Who sees it', width: 92 },
  { key: 'location', label: 'Location', width: 104 },
  { key: 'original_place', label: 'Filed in', width: 140 },
  { key: 'collections', label: 'Collections', width: 96 },
];

/** The title's least width in Add documents, in px: below it the box scrolls sideways. */
export const TITLE_MIN = 168;
/** The box for choosing, in px. */
export const PICK_WIDTH = 44;

/**
 * A date as a column has room for: 14 Mar 2021, Sept 2026, 2026 — by its
 * precision, as the document's page says it in full.
 */
export function tableDate(d: DateValue): string {
  if (d.precision !== 'month') return formatDate(d);
  // A month, never a moment: no zone moves it (0.9.0, TZ).
  return dateOnlyWords(d.date, { day: false, month: 'short' });
}

/** How many rows a page of the table asks for; Show more asks for the next. */
export const PAGE_SIZE = 100;
/** The most documents one action takes at once, as the vault takes them into a collection. */
export const MOST_AT_ONCE = 200;

/**
 * The columns this reader has: never Location for whom it is not (5.41),
 * never Collections without any, and Filed in (C3) only where the vault keeps
 * places in a cabinet, for whoever sees where originals are.
 */
export function columnsFor(
  role: Role,
  opts: { collections: boolean; places?: boolean | undefined },
): Column[] {
  return COLUMNS.filter(
    (c) =>
      (c.key !== 'location' || seesLocation(role)) &&
      (c.key !== 'original_place' || (opts.places === true && seesLocation(role))) &&
      (c.key !== 'collections' || opts.collections),
  );
}

// ------------------------------------------------------------- the address

/**
 * What the table shows: its sort, and each filter's choices (none for
 * any). Since 0.9.0-dev.92 each filter takes several: within one, any of
 * them; across filters, all of them.
 */
export interface TableView {
  sort: DocumentSort;
  dir: SortDirection;
  /** People's ids, `none` (Not sure yet) or `household`. */
  person: string[];
  kind: string[];
  status: string[];
  visibility: string[];
  /** Collections' ids, or `none`. */
  collection: string[];
  tag: string[];
  /** Details' labels, any value (0.9.0, T1): "locker". */
  label: string[];
  /** Sensitive, all said (0.9.0, AIR2): `yes`, `no`; none or both for either. */
  sensitive: string[];
  /**
   * The rest of what a cabinet's folder asks (0.9.0, C1), carried into the
   * table whole: said above it as chips, each taken off by itself.
   */
  folder: FolderPart;
}

/** What a folder asks that the table has no select for, by the list's own names. */
export const FOLDER_KEYS = [
  'category',
  'issued_by',
  // Who issued it, by key, as the household names it (0.9.0-dev.91).
  'issuer',
  'location',
  // In a place in a cabinet (0.9.0, C3): the whole path, or its leading part.
  'original_place',
  // Came from this folder (0.9.0, C4): exactly that folder.
  'source_folder',
  'essential',
  'added_from',
  'added_to',
  'issued_from',
  'issued_to',
  'expires_from',
  'expires_to',
  'dated_from',
  'dated_to',
] as const;
export type FolderKey = (typeof FOLDER_KEYS)[number];

export interface FolderPart {
  keys: Partial<Record<FolderKey, string>>;
  /**
   * The folder asked something the table always leaves out — its notes —
   * so the table may count fewer than the folder does.
   */
  partial: boolean;
}

export const NO_FOLDER: FolderPart = { keys: {}, partial: false };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const FILTER_KEYS = [
  'person',
  'kind',
  'status',
  'visibility',
  'collection',
  'tag',
  'label',
  'sensitive',
] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];

/**
 * The filters whose values are words, never split at a comma (a tag, a
 * detail's label: a comma may be a part of one); the rest are keys, which
 * an address may give comma-separated too, as a cabinet folder does.
 */
const WORD_FILTERS: readonly FilterKey[] = ['tag', 'label'];

/** Every filter taken off, the folder's too: Clear all. */
export function withoutFilters(view: TableView): TableView {
  return {
    ...view,
    person: [],
    kind: [],
    status: [],
    visibility: [],
    collection: [],
    tag: [],
    label: [],
    sensitive: [],
    folder: NO_FOLDER,
  };
}

const STATUSES: readonly string[] = [
  'expired',
  'expiring_soon',
  'needs_info',
  'active',
  'valid',
  // Kept, but no longer needed (0.9.0): among Any status, never the others.
  'no_longer_needed',
];
const VISIBILITIES: readonly string[] = ['household', 'adults', 'private'];

/**
 * The view an address asks for. A sort the reader may not have — by where
 * originals are kept, for a viewer or a guest — or one that is not there is
 * the title's: a link never shows them what is not theirs, nor fails. A
 * filter may hold several values (0.9.0-dev.92), each given once
 * (`person=a&person=b`); a filter of keys comma-separated too, as a merged
 * folder asks (any of them). A value that is not one there is is left out.
 */
export function viewFrom(params: URLSearchParams, role: Role): TableView {
  const sort = params.get('sort');
  const pick = (k: FilterKey, ok?: readonly string[]): string[] => {
    const given = params.getAll(k);
    const all = WORD_FILTERS.includes(k) ? given : given.flatMap((v) => v.split(','));
    // A tag as the vault keeps it, a label by its key (0.9.0-dev.92): what
    // a folder or a link asks ticks the box there is, never a second one.
    const said = all
      .map((v) => (k === 'tag' ? normaliseTag(v) : k === 'label' ? tagLabelKey(v) : v.trim()))
      .filter((v) => v !== '');
    const kept = k === 'tag' ? onceEach(said, tagKey) : [...new Set(said)];
    return ok ? kept.filter((v) => ok.includes(v)) : kept;
  };
  const keys: FolderPart['keys'] = {};
  for (const k of FOLDER_KEYS) {
    const v = params.get(k);
    if (!v) continue;
    if (k.endsWith('_from') || k.endsWith('_to')) {
      if (DAY.test(v)) keys[k] = v;
    } else if (k === 'essential') {
      if (v === 'true' || v === 'false') keys[k] = v;
    } else if (
      (k !== 'location' && k !== 'original_place' && k !== 'source_folder') ||
      seesLocation(role)
    ) {
      keys[k] = v;
    }
  }
  return {
    sort:
      isDocumentSort(sort) &&
      ((sort !== 'location' && sort !== 'original_place') || seesLocation(role))
        ? sort
        : 'title',
    dir: params.get('dir') === 'desc' ? 'desc' : 'asc',
    person: pick('person'),
    kind: pick('kind'),
    status: pick('status', STATUSES),
    visibility: pick('visibility', VISIBILITIES),
    collection: pick('collection'),
    tag: pick('tag'),
    label: pick('label'),
    sensitive: pick('sensitive', SENSITIVE_FILTER_VALUES),
    folder: { keys, partial: params.get('partial') === '1' },
  };
}

/** Each value once, by its key: the first spelling kept. */
function onceEach(values: readonly string[], key: (v: string) => string): string[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const k = key(v);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * A view's tags as the household spells them (0.9.0-dev.92): a tag asked
 * in another case is the box there is for it, not a second one.
 */
export function spelledAsKnown(view: TableView, known: readonly string[]): TableView {
  if (view.tag.length === 0) return view;
  const tag = onceEach(
    view.tag.map((t) => known.find((k) => tagKey(k) === tagKey(t)) ?? t),
    tagKey,
  );
  return { ...view, tag };
}

/** The address for a view: only what differs from the title, A to Z, unfiltered. */
export function paramsOf(view: TableView): URLSearchParams {
  const out = new URLSearchParams();
  if (view.sort !== 'title') out.set('sort', view.sort);
  if (view.dir === 'desc') out.set('dir', 'desc');
  // Each choice given once: a link to the same view, as the vault is asked.
  for (const k of FILTER_KEYS) for (const v of view[k]) out.append(k, v);
  for (const k of FOLDER_KEYS) {
    const v = view.folder.keys[k];
    if (v) out.set(k, v);
  }
  if (view.folder.partial) out.set('partial', '1');
  return out;
}

/**
 * A cabinet folder's question as the table's address (0.9.0, C1: "Open in
 * the table"): every filter of the list it asks, by the table's own name
 * for it, so the table shows the same papers. The table always leaves
 * notes out: a folder that does not is marked `partial`, and the table says
 * its count may differ.
 */
export function folderView(filter: FolderFilter): URLSearchParams {
  const out = new URLSearchParams();
  const one = (k: string, v: string | undefined) => {
    if (v) out.set(k, v);
  };
  one('person', filter.member_id);
  one('kind', filter.type_key);
  one('status', filter.status);
  one('visibility', filter.visibility);
  one('collection', filter.collection_id);
  const tags =
    filter.tag === undefined ? [] : Array.isArray(filter.tag) ? filter.tag : [filter.tag];
  for (const t of tags) out.append('tag', t);
  one('label', filter.tag_label);
  one('sensitive', filter.sensitive);
  for (const k of FOLDER_KEYS) one(k, filter[k]);
  if (filter.notes !== 'exclude') out.set('partial', '1');
  return out;
}

/** What the vault is asked for a view: a page, after `cursor`. */
export function queryOf(
  view: TableView,
  opts: { cursor?: string | null; limit?: number } = {},
): DocumentListParams {
  const k = view.folder.keys;
  // None is any; one, as the filter always was; several, each given once.
  const one = <T extends string>(v: readonly string[]): T | readonly T[] | undefined =>
    v.length === 0 ? undefined : v.length === 1 ? (v[0] as T) : (v as readonly T[]);
  return {
    sort: view.sort,
    direction: view.dir,
    member_id: one(view.person),
    type_key: one(view.kind),
    status: one<StatusValue>(view.status),
    visibility: one<Visibility>(view.visibility),
    collection_id: one(view.collection),
    tag: one(view.tag),
    tag_label: one(view.label),
    sensitive: one(view.sensitive),
    category: k.category,
    issued_by: k.issued_by,
    issuer: k.issuer,
    location: k.location,
    original_place: k.original_place,
    source_folder: k.source_folder,
    essential: k.essential === undefined ? undefined : k.essential === 'true',
    added_from: k.added_from,
    added_to: k.added_to,
    issued_from: k.issued_from,
    issued_to: k.issued_to,
    expires_from: k.expires_from,
    expires_to: k.expires_to,
    dated_from: k.dated_from,
    dated_to: k.dated_to,
    limit: opts.limit ?? PAGE_SIZE,
    cursor: opts.cursor ?? undefined,
  };
}

/** A folder's filter of keys as its values: `financial,tax` is two. */
export const keysOf = (v: string | undefined): string[] =>
  (v ?? '').split(',').filter((x) => x !== '');

/** How many chips a folder's filters are: a topic or an issuer one each (0.9.0-dev.92). */
export function folderChipCount(f: FolderPart): number {
  const k = f.keys;
  const ranges = (['added', 'issued', 'expires', 'dated'] as const).filter(
    (r) => k[`${r}_from`] || k[`${r}_to`],
  ).length;
  return (
    ranges +
    keysOf(k.category).length +
    keysOf(k.issuer).length +
    (['issued_by', 'location', 'original_place', 'source_folder', 'essential'] as const).filter(
      (x) => k[x],
    ).length
  );
}

/** How many choices are made: what the phone's Filters button says, a chip each. */
export function filtersOn(view: TableView): number {
  return FILTER_KEYS.reduce((n, k) => n + view[k].length, 0) + folderChipCount(view.folder);
}

// ------------------------------------------------------------- remembered

/** Which columns this device hides: remembered here, and only here. */
export const HIDDEN_COLUMNS_KEY = 'fdv.documents.hidden-columns';

/**
 * A collection's own table (0.9.0) remembers its columns apart from
 * Documents', and starts without Collections: every row is in this one.
 */
export const COLLECTION_HIDDEN_COLUMNS_KEY = 'fdv.collection.hidden-columns';
export const COLLECTION_HIDDEN_BY_DEFAULT: readonly ColumnKey[] = ['collections'];

/**
 * Columns added after a person may have chosen theirs, hidden until they
 * show them (0.9.0, C3: Filed in): the table at the owner's window keeps
 * every column it had whole. Which of them a person shows is remembered
 * apart (`shownKey`), so a choice made before they came hides none of them.
 */
export const OPTIONAL_COLUMNS: readonly ColumnKey[] = ['original_place'];

/** Where the optional columns a person shows are remembered, beside `key`. */
const shownKey = (key: string) => `${key}.shown`;

/** Which columns are hidden on this device: what was chosen, or `byDefault` until anything is. */
export function readHidden(
  key: string = HIDDEN_COLUMNS_KEY,
  byDefault: readonly ColumnKey[] = [],
): Set<ColumnKey> {
  const known = (keys: unknown): ColumnKey[] =>
    Array.isArray(keys)
      ? keys.filter(
          (k): k is ColumnKey =>
            typeof k === 'string' && k !== 'title' && COLUMNS.some((c) => c.key === k),
        )
      : [];
  let shown: ColumnKey[] = [];
  try {
    shown = known(JSON.parse(localStorage.getItem(shownKey(key)) ?? '[]'));
  } catch {
    // None shown.
  }
  const optional = OPTIONAL_COLUMNS.filter((k) => !shown.includes(k));
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return new Set([...byDefault, ...optional]);
    return new Set([...known(raw ? (JSON.parse(raw) as unknown) : []), ...optional]);
  } catch {
    // A private window, or something else's words there: as it starts.
    return new Set([...byDefault, ...optional]);
  }
}

export function writeHidden(
  hidden: ReadonlySet<ColumnKey>,
  key: string = HIDDEN_COLUMNS_KEY,
): void {
  try {
    localStorage.setItem(
      key,
      JSON.stringify([...hidden].filter((k) => !OPTIONAL_COLUMNS.includes(k))),
    );
    localStorage.setItem(
      shownKey(key),
      JSON.stringify(OPTIONAL_COLUMNS.filter((k) => !hidden.has(k))),
    );
  } catch {
    // Not remembered: hidden for now, on this page.
  }
}

// ------------------------------------------------------------- many at once

/** Who is choosing, as what may be done with documents asks it. */
export interface Chooser {
  role: Role;
  memberId: string | null;
  /** Collections are offered to them (`collectionsOffered`). */
  collections: boolean;
}

/** Whether rows have boxes at all: somebody who can do something with many. */
export function maySelect(who: Chooser): boolean {
  return who.collections || can(who.role, 'document.edit');
}

/**
 * What may be done with the documents chosen: each action only where every
 * one of them allows it, as the vault would (a teen's own, Only me only for
 * whose it is); and, in words, what is not offered and why.
 */
export interface BulkOffer {
  collect: boolean;
  location: boolean;
  /** Who-can-see choices every one may be given (or has): each changes at least one. */
  visibility: Visibility[];
  trash: boolean;
  /**
   * Add a tag, remove a tag (0.9.0, T1): offered when the person may change
   * any of them — and done to those, the rest left as they are and named.
   */
  tags: boolean;
  notes: string[];
}

export function bulkOffer(who: Chooser, docs: readonly DocumentView[]): BulkOffer {
  const n = docs.length;
  const editor = can(who.role, 'document.edit');
  const notMine = docs.filter((d) => !mayChange(who.role, who.memberId, d)).length;
  const changeAll = editor && notMine === 0;
  const visibility = (['household', 'adults', 'private'] as const).filter(
    (to) =>
      docs.some((d) => d.visibility !== to) &&
      docs.every(
        (d) =>
          d.visibility === to ||
          visibilityRefusal(
            {
              role: who.role,
              mine: who.memberId !== null && d.owner_member_id === who.memberId,
              filedByMe: d.filed_by_me === true,
            },
            d.visibility,
            to,
          ) === null,
      ),
  );
  const notes: string[] = [];
  if (n > 0 && editor && notMine > 0) {
    const what = seesLocation(who.role)
      ? 'Set where it’s kept and Move to the Trash are'
      : 'Move to the Trash is';
    notes.push(
      `${notMine === n ? (n === 1 ? 'It isn’t' : 'None of these is') : `${notMine} of these ${notMine === 1 ? 'isn’t' : 'aren’t'}`} yours to change: ${what} offered when every one you chose is.`,
    );
  }
  if (n > 0 && mayChangeVisibilityAtAll(who.role) && visibility.length === 0) {
    notes.push(
      'Who can see it is offered when it can be changed the same way for every one you chose.',
    );
  }
  // A paper seen as its person's caregiver (0.9.0, H1b) goes in no
  // collection, and is changed by nothing done to many: it is read-only.
  const caregiver = docs.filter((d) => d.caregiver === true).length;
  if (caregiver > 0) {
    notes.push(
      `${caregiver === 1 ? 'One paper you chose is' : `${caregiver} papers you chose are`} shared with you as a caregiver: Add to a collection and Who can see it are offered when none is.`,
    );
  }
  return {
    collect: n > 0 && who.collections && caregiver === 0,
    location: n > 0 && changeAll && seesLocation(who.role),
    visibility: n > 0 && caregiver === 0 ? visibility : [],
    trash: n > 0 && changeAll,
    tags: n > 0 && editor && notMine < n,
    notes,
  };
}

/** "1 document", "3 documents". */
export function documentsCount(n: number): string {
  return `${n} document${n === 1 ? '' : 's'}`;
}

/** Who can see a document, as the table says it. */
export const VISIBILITY_WORDS: Record<Visibility, string> = {
  household: 'Everyone',
  adults: 'Adults only',
  private: 'Only me',
};

/** The choices for many at once, with what each means. */
export const VISIBILITY_CHOICES: Record<Visibility, { label: string; means: string }> = {
  household: {
    label: 'Everyone in the family',
    means: 'Anybody with a sign-in here can open them.',
  },
  adults: { label: 'Adults only', means: 'The teens and viewers will not see them.' },
  private: { label: 'Only me', means: 'Nobody else, including the owner of this vault.' },
};

/** What each status filter says. */
export const STATUS_WORDS: Record<string, string> = {
  expired: 'Expired',
  expiring_soon: 'Expiring soon',
  needs_info: 'Needs details',
  active: 'In date',
  valid: 'Nothing to renew',
  no_longer_needed: 'No longer needed',
};
