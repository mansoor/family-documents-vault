import {
  can,
  formatDate,
  isDocumentSort,
  mayChangeVisibilityAtAll,
  seesLocation,
  visibilityRefusal,
  type DateValue,
  type DocumentListParams,
  type DocumentSort,
  type DocumentView,
  type Role,
  type SortDirection,
  type StatusValue,
  type Visibility,
} from '@fdv/shared';
import { mayChange } from './DocActions.js';

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
  | 'collections';

export interface Column {
  key: ColumnKey;
  label: string;
  /** Its width in px; the title takes what is left, at least `TITLE_MIN`. */
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
  { key: 'visibility', label: 'Who can see it', width: 92 },
  { key: 'location', label: 'Location', width: 104 },
  { key: 'collections', label: 'Collections', width: 96 },
];

/** The title's least width, in px: below it the box scrolls sideways. */
export const TITLE_MIN = 168;
/** The box for choosing, in px. */
export const PICK_WIDTH = 44;

/**
 * A date as a column has room for: 14 Mar 2021, Sept 2026, 2026 — by its
 * precision, as the document's page says it in full.
 */
export function tableDate(d: DateValue): string {
  if (d.precision !== 'month') return formatDate(d);
  const [y, m] = d.date.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** How many rows a page of the table asks for; Show more asks for the next. */
export const PAGE_SIZE = 100;
/** The most documents one action takes at once, as the vault takes them into a collection. */
export const MOST_AT_ONCE = 200;

/** The columns this reader has: never Location for whom it is not (5.41), never Collections without any. */
export function columnsFor(role: Role, opts: { collections: boolean }): Column[] {
  return COLUMNS.filter(
    (c) =>
      (c.key !== 'location' || seesLocation(role)) && (c.key !== 'collections' || opts.collections),
  );
}

// ------------------------------------------------------------- the address

/** What the table shows: its sort, and each filter (empty for none). */
export interface TableView {
  sort: DocumentSort;
  dir: SortDirection;
  /** A person's id, or `none`. */
  person: string;
  kind: string;
  status: string;
  visibility: string;
  /** A collection's id, or `none`. */
  collection: string;
  tag: string;
}

export const FILTER_KEYS = ['person', 'kind', 'status', 'visibility', 'collection', 'tag'] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];

const STATUSES: readonly string[] = ['expired', 'expiring_soon', 'needs_info', 'active', 'valid'];
const VISIBILITIES: readonly string[] = ['household', 'adults', 'private'];

/**
 * The view an address asks for. A sort the reader may not have — by where
 * originals are kept, for a viewer or a guest — or one that is not there is
 * the title's: a link never shows them what is not theirs, nor fails.
 */
export function viewFrom(params: URLSearchParams, role: Role): TableView {
  const sort = params.get('sort');
  const pick = (k: string, ok?: readonly string[]) => {
    const v = params.get(k) ?? '';
    return ok && !ok.includes(v) ? '' : v;
  };
  return {
    sort: isDocumentSort(sort) && (sort !== 'location' || seesLocation(role)) ? sort : 'title',
    dir: params.get('dir') === 'desc' ? 'desc' : 'asc',
    person: pick('person'),
    kind: pick('kind'),
    status: pick('status', STATUSES),
    visibility: pick('visibility', VISIBILITIES),
    collection: pick('collection'),
    tag: pick('tag'),
  };
}

/** The address for a view: only what differs from the title, A to Z, unfiltered. */
export function paramsOf(view: TableView): URLSearchParams {
  const out = new URLSearchParams();
  if (view.sort !== 'title') out.set('sort', view.sort);
  if (view.dir === 'desc') out.set('dir', 'desc');
  for (const k of FILTER_KEYS) if (view[k]) out.set(k, view[k]);
  return out;
}

/** What the vault is asked for a view: a page, after `cursor`. */
export function queryOf(
  view: TableView,
  opts: { cursor?: string | null; limit?: number } = {},
): DocumentListParams {
  return {
    sort: view.sort,
    direction: view.dir,
    member_id: view.person || undefined,
    type_key: view.kind || undefined,
    status: (view.status || undefined) as StatusValue | undefined,
    visibility: (view.visibility || undefined) as Visibility | undefined,
    collection_id: view.collection || undefined,
    tag: view.tag || undefined,
    limit: opts.limit ?? PAGE_SIZE,
    cursor: opts.cursor ?? undefined,
  };
}

/** How many filters are on: what the phone's Filters button says. */
export function filtersOn(view: TableView): number {
  return FILTER_KEYS.filter((k) => view[k]).length;
}

// ------------------------------------------------------------- remembered

/** Which columns this device hides: remembered here, and only here. */
export const HIDDEN_COLUMNS_KEY = 'fdv.documents.hidden-columns';

export function readHidden(): Set<ColumnKey> {
  try {
    const raw = localStorage.getItem(HIDDEN_COLUMNS_KEY);
    const keys = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(
      Array.isArray(keys)
        ? keys.filter(
            (k): k is ColumnKey =>
              typeof k === 'string' && k !== 'title' && COLUMNS.some((c) => c.key === k),
          )
        : [],
    );
  } catch {
    // A private window, or something else's words there: every column.
    return new Set();
  }
}

export function writeHidden(hidden: ReadonlySet<ColumnKey>): void {
  try {
    localStorage.setItem(HIDDEN_COLUMNS_KEY, JSON.stringify([...hidden]));
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
  return {
    collect: n > 0 && who.collections,
    location: n > 0 && changeAll && seesLocation(who.role),
    visibility: n > 0 ? visibility : [],
    trash: n > 0 && changeAll,
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
};
