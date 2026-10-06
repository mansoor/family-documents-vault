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
 * What GET /documents takes (the table's additions marked). Each filter
 * narrows what the reader may see already; none widens it.
 */
export type DocumentListParams = {
  /** A column (`DOCUMENT_SORTS`, R2), or an older sort. */
  sort?: DocumentSort | (typeof OLDER_DOCUMENT_SORTS)[number] | undefined;
  /** R2: with a column sort only; ascending unless said. Blanks go last either way. */
  direction?: SortDirection | undefined;
  /** Whose: a person's id, or `none` (R2, with a column sort) for nobody's. */
  member_id?: string | undefined;
  type_key?: string | undefined;
  category?: string | undefined;
  issued_by?: string | undefined;
  tag?: string | undefined;
  visibility?: Visibility | undefined;
  /** With a column sort, every page holds only this status, and `total` counts them. */
  status?: StatusValue | undefined;
  /** R2, with a column sort: in this collection (one the reader may see), or `none`. */
  collection_id?: string | undefined;
  /** R2, with a column sort, for whoever sees locations: kept there, whatever the case. */
  location?: string | undefined;
  essential?: boolean | undefined;
  deleted?: boolean | undefined;
  purge_requested?: boolean | undefined;
  updated_since?: string | undefined;
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
