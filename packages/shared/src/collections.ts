import type { DocumentView } from './documents.js';
import type { CollectionAudience } from './roles.js';

/**
 * Collections of documents (5.14), as the API answers them.
 *
 * A collection holds documents; it never widens who may see one. Whoever reads a
 * collection is given the documents in it that they could see anyway, and
 * `item_count` is how many that is — never how many are hidden. Who a collection
 * is for decides whether it exists at all for a reader (`canSeeCollection`), and
 * only the member who made it changes it (A18).
 */

/** A collection's name, once tidied: 80 characters at most. */
export const COLLECTION_NAME_MAX = 80;
/** Its few words about what it is for. */
export const COLLECTION_DESCRIPTION_MAX = 1000;

export interface CollectionView {
  id: string;
  name: string;
  description: string | null;
  audience: CollectionAudience;
  /** The member who made it: the one who changes it. */
  owner_member_id: string | null;
  /** The reader made it, so it is theirs to change. */
  mine: boolean;
  /** How many of its documents the reader can see: never how many they cannot. */
  item_count: number;
  created_at: string;
  /** When its name, words or audience last changed: never its items. */
  updated_at: string;
  /** For If-Match on a change. */
  etag: string;
}

export interface CollectionItemView {
  /** As a collection of documents gives it: an Only me one's notes and details stay sealed. */
  document: DocumentView;
  added_at: string;
  /**
   * For the collection's maker only (`collectionItemHint`): who in its audience is not
   * given this one. Null for everybody else, always.
   */
  hint: string | null;
}

/** The documents in a collection given in one answer, unless fewer are asked for. */
export const COLLECTION_ITEMS_PAGE = 50;
/** The most a page of a collection's documents may hold. */
export const COLLECTION_ITEMS_PAGE_MAX = 200;

/**
 * One collection, with a page of the documents in it the reader can see, in the
 * order they were put there. `item_count` is all of them, not the page.
 */
export interface CollectionDetail extends CollectionView {
  items: CollectionItemView[];
  /**
   * For `?cursor=` on GET /collections/{id}: where the next page begins, or null
   * when this one is the last. It names nothing the reader was not given.
   */
  next_cursor: string | null;
  has_more: boolean;
}

/** POST /collections (name and audience required) and PATCH /collections/{id}. */
export interface CollectionInput {
  name?: string | undefined;
  description?: string | null | undefined;
  audience?: CollectionAudience | undefined;
}
