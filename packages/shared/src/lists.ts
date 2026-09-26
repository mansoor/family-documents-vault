import type { DocumentView } from './documents.js';
import type { ListAudience } from './roles.js';

/**
 * Lists of documents (5.14), as the API answers them.
 *
 * A list holds documents; it never widens who may see one. Whoever reads a
 * list is given the documents on it that they could see anyway, and
 * `item_count` is how many that is — never how many are hidden. Who a list
 * is for decides whether it exists at all for a reader (`canSeeList`), and
 * only the member who made it changes it (A18).
 */

/** A list's name, once tidied: 80 characters at most. */
export const LIST_NAME_MAX = 80;
/** Its few words about what it is for. */
export const LIST_DESCRIPTION_MAX = 1000;

export interface ListView {
  id: string;
  name: string;
  description: string | null;
  audience: ListAudience;
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

export interface ListItemView {
  /** As a list of documents gives it: an Only me one's notes and details stay sealed. */
  document: DocumentView;
  added_at: string;
  /**
   * For the list's maker only (`listItemHint`): who in its audience is not
   * given this one. Null for everybody else, always.
   */
  hint: string | null;
}

/** One list, with the documents on it the reader can see, in the order they were put there. */
export interface ListDetail extends ListView {
  items: ListItemView[];
}

/** POST /lists (name and audience required) and PATCH /lists/{id}. */
export interface ListInput {
  name?: string | undefined;
  description?: string | null | undefined;
  audience?: ListAudience | undefined;
}
