/**
 * The Documents table (Phase 6, R2): GET /documents sorted by a column,
 * filtered, a page at a time. The wire's half, shared by the vault, the
 * client, its fake and the web.
 *
 * A column sort (`sort` one of `DOCUMENT_SORTS`) is new in 0.6.0, and the
 * rest of what the table asks goes with it: `direction`, the filters for
 * a collection (`collection_id`), for where the original is kept
 * (`location`) and for documents that are nobody's (`member_id=none`).
 * With an older sort (`recent`, `expiring`, `alpha`), or none, they are
 * refused (422): an older client never sends them, and is answered as it
 * always was.
 */

import type { DocumentView, StatusValue, Visibility } from './documents.js';
import { refusalFor, seesLocation, type Role } from './roles.js';

/** The columns a list of documents can be sorted by, as the table shows them. */
export const DOCUMENT_SORTS = [
  'title',
  'kind',
  'person',
  'issued',
  'expires',
  'status',
  'visibility',
  'collections',
  'location',
  // Where the original is, as a place in a cabinet (0.9.0, C3,
  // `features.original_place`): by its names, as one line. Only for whoever
  // sees where originals are kept, as `location`.
  'original_place',
  // The date a paper is about: issued, else added (0.9.0, C1, `features.cabinets`):
  // a cabinet's folder, newest first. No column of its own.
  'dated',
] as const;
export type DocumentSort = (typeof DOCUMENT_SORTS)[number];

/** The sorts GET /documents had before the table, which keep their own order and paging. */
export const OLDER_DOCUMENT_SORTS = ['recent', 'expiring', 'alpha'] as const;

export const SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

/** Whether `sort` is one of the table's columns, rather than an older sort or none. */
export function isDocumentSort(sort: string | null | undefined): sort is DocumentSort {
  return (DOCUMENT_SORTS as readonly string[]).includes(sort ?? '');
}

/**
 * The statuses in the order a sort by status puts them, most pressing
 * first: what has run out, what runs out soon, what needs details, what is
 * in date, and what has nothing to renew. Within one, the sooner expiry
 * first, and those with none last.
 */
export const STATUS_ORDER: readonly StatusValue[] = [
  'expired',
  'expiring_soon',
  'needs_info',
  'active',
  'valid',
  'superseded',
  // Kept, and nothing to act on (0.9.0): after everything that is.
  'no_longer_needed',
  'missing',
];

/** A status's place in `STATUS_ORDER`; one a client has never heard of goes last. */
export function statusRank(value: string): number {
  const at = (STATUS_ORDER as readonly string[]).indexOf(value);
  return at === -1 ? STATUS_ORDER.length : at;
}

/** The most documents one page of the table holds, as every list of documents. */
export const DOCUMENT_PAGE_MAX = 200;

/**
 * Who may sort or filter by where the original is kept: whoever sees it
 * (5.41, the owner's decision of 6 Oct 2026) — owners, adults and teens.
 * A viewer, limited or not, and a guest are refused (422), so that the
 * order of their documents never says where anything is.
 */
export function maySortByLocation(role: Role | null | undefined): boolean {
  return seesLocation(role);
}

/** What a refused sort or filter by location says. */
export const LOCATION_SORT_REFUSAL = refusalFor('document.see_location');

/** A collection a document is in, as the table names it: one the reader may see. */
export interface DocumentCollectionRef {
  id: string;
  name: string;
}

/**
 * The most values one filter takes at once (V1; on every filter since
 * 0.9.0-dev.92): more is refused (422), and the web offers no more.
 */
export const FILTER_VALUES_MAX = 50;

/**
 * A filter's value, or several (0.9.0-dev.92, `features.multi_filters`):
 * a list is sent with the field once for each value, any of them. An older
 * vault takes one value each (or, for the filters of keys, several
 * comma-separated: `member_id: 'a,b'`).
 */
export type OneOrMany = string | readonly string[];

/**
 * What GET /documents takes (the table's additions marked). Each filter
 * narrows what the reader may see already; none widens it. Across filters,
 * all of them; within one, any of its values.
 */
export type DocumentListParams = {
  /** A column (`DOCUMENT_SORTS`, R2), or an older sort. */
  sort?: DocumentSort | (typeof OLDER_DOCUMENT_SORTS)[number] | undefined;
  /** R2: with a column sort only; ascending unless said. Blanks go last either way. */
  direction?: SortDirection | undefined;
  /**
   * Whose: a person's id; or, with a column sort, `none` (R2) for nobody's —
   * Not sure yet since 0.9.0 — or `household` (0.9.0, `features.household_owner`)
   * for the household's.
   */
  member_id?: OneOrMany | undefined;
  type_key?: OneOrMany | undefined;
  category?: OneOrMany | undefined;
  issued_by?: string | undefined;
  /**
   * Who issued it, by issuer key (0.9.0-dev.91, `features.cabinet_issuer`):
   * keys comma-separated, any of them, each with every key the household
   * says is the same; or `_none` for no issuer given.
   */
  issuer?: OneOrMany | undefined;
  /**
   * A tag, whatever its case since 0.9.0 (`features.tag_details`); several,
   * any of them, since `features.tag_filters`.
   */
  tag?: string | readonly string[] | undefined;
  /** Notes left out (`features.notes_apart`). */
  notes?: 'exclude' | undefined;
  /** A detail tag's label, any value: "locker" (0.9.0, `features.tag_details`). */
  tag_label?: OneOrMany | undefined;
  visibility?: Visibility | readonly Visibility[] | undefined;
  /**
   * Sensitive, all said (0.9.0, AIR2, `features.sensitive_documents`): `yes`,
   * `no`, or both comma-separated. As V1's filters, on GET /search too.
   */
  sensitive?: OneOrMany | undefined;
  /** With a column sort, every page holds only this status, and `total` counts them. */
  status?: StatusValue | readonly StatusValue[] | undefined;
  /**
   * R2, with a column sort: in this collection (one the reader may see), or
   * `none`; several, any of them, since `features.multi_filters`.
   */
  collection_id?: OneOrMany | undefined;
  /** R2, with a column sort, for whoever sees locations: kept there, whatever the case. */
  location?: string | undefined;
  /**
   * 0.9.0 (C3, `features.original_place`), with a column sort, for whoever
   * sees locations: in this place in a cabinet, whatever the case — its
   * names joined by `PLACE_SEPARATOR` (" › "), the whole path, or its
   * cabinet, or its cabinet and drawer, for everything inside them.
   */
  original_place?: string | undefined;
  /**
   * 0.9.0 (C4, `features.source_folders`), with a column sort, for whoever
   * sees locations: came from this folder ("Taxes/2025"), exactly, whatever
   * the case — not the folders inside it.
   */
  source_folder?: string | undefined;
  essential?: boolean | undefined;
  deleted?: boolean | undefined;
  purge_requested?: boolean | undefined;
  updated_since?: string | undefined;
  /**
   * V1 (`features.document_filters`): the days a document was added,
   * issued or expires within, `YYYY-MM-DD`, both included. Several
   * people, kinds, statuses or who-can-see go comma-separated in their
   * own field (`member_id: 'a,b'`).
   */
  added_from?: string | undefined;
  added_to?: string | undefined;
  issued_from?: string | undefined;
  issued_to?: string | undefined;
  expires_from?: string | undefined;
  expires_to?: string | undefined;
  /**
   * 0.9.0 (C1, `features.cabinets`): the days the date a paper is about
   * falls within — when it was issued, else when it was added — both
   * included: what a cabinet's year folder asks.
   */
  dated_from?: string | undefined;
  dated_to?: string | undefined;
  /** At most `DOCUMENT_PAGE_MAX`. */
  limit?: number | undefined;
  /** The `next_cursor` of the page before, asked the same way. */
  cursor?: string | undefined;
};

/** A page of the table: as any page of documents, and how many there are in all (R2). */
export interface DocumentPage {
  items: DocumentView[];
  next_cursor: string | null;
  has_more: boolean;
  /** With a column sort: how many documents the filters give this reader, every page together. */
  total?: number;
}
