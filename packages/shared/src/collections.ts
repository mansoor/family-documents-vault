import type { DocumentView } from './documents.js';
import { inCollectionAudience, type CollectionAudience, type Role } from './roles.js';

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
  /**
   * Shared outside the family by a link that still works (5.19): with whom,
   * as each link names them — only to readers GET /shares would give the
   * link, and never how many documents went — and whether any of them
   * keeps up with it, so that what is put in it goes too. Null when it is
   * not. Absent from older vaults.
   */
  shared_outside?: CollectionSharedOutside | null;
  /**
   * What the reader may do with it now (0.9.0, collection managers): its
   * maker, or a manager its maker chose. Clients enable each action by
   * this rather than by `mine`. Absent from older vaults: there, only its
   * maker in its audience changes it (`mine`).
   */
  my_powers?: CollectionPowers;
  /**
   * Who manages it besides its maker, by name, with what each may do: for
   * the family who see it (owners, adults and teens). Null for a viewer or
   * a guest it is given to. Absent from older vaults.
   */
  managers?: CollectionManager[] | null;
}

/**
 * What a reader may do with a collection (0.9.0, collection managers). Its
 * maker, while they are in its audience, may do all of it; made a teen or
 * a viewer, still delete it. A manager may always `edit`; the other three
 * only as its maker turned them on for them. An owner may delete one
 * nobody may change any more.
 */
export interface CollectionPowers {
  /** They made it. */
  maker: boolean;
  /** Its maker (or a manager who may) chose them to manage it, and they can see it now. */
  manager: boolean;
  /**
   * Rename it and change its words; put documents in it and take them out;
   * fill it from a checklist, change the checklist or clear it.
   */
  edit: boolean;
  /** Change who it is for (never to Only me, unless they made it). */
  change_audience: boolean;
  delete: boolean;
  /** Choose its managers: add them, take them away, set what they may do. */
  choose_managers: boolean;
  /**
   * Take its managers away, and nothing more: whoever may choose them, and
   * an owner while its maker may no longer change it (no sign-in, or outside
   * its audience), so no collection keeps managers nobody can take away.
   */
  remove_managers: boolean;
}

/** One of a collection's managers, as the family who see it are told (0.9.0). */
export interface CollectionManager {
  member_id: string;
  display_name: string;
  /** "Can also change who it's for". */
  may_change_audience: boolean;
  /** "Can also delete it". */
  may_delete: boolean;
  /** "Can also choose managers". */
  may_choose_managers: boolean;
  added_at: string;
}

/** Somebody who could be made a manager: of the family, with a sign-in, who can see it. */
export interface CollectionManagerCandidate {
  member_id: string;
  display_name: string;
}

/**
 * GET /collections/{id}/managers, and the answer to every change of them:
 * its managers, and — for a reader who may choose managers — who else could
 * be one. Empty for anybody else.
 */
export interface CollectionManagers {
  items: CollectionManager[];
  eligible: CollectionManagerCandidate[];
  /** What the reader may do, as the collection's own `my_powers` says. */
  my_powers: CollectionPowers;
}

/** POST /collections/{id}/managers; PATCH /collections/{id}/managers/{memberId} takes the switches alone. */
export interface CollectionManagerInput {
  member_id?: string;
  may_change_audience?: boolean;
  may_delete?: boolean;
  may_choose_managers?: boolean;
}

/** The three switches, in plain words, in the order they are offered. */
export const COLLECTION_MANAGER_SWITCHES = [
  { key: 'may_change_audience', label: 'Can also change who it’s for' },
  { key: 'may_delete', label: 'Can also delete it' },
  { key: 'may_choose_managers', label: 'Can also choose managers' },
] as const;

/** What every manager may always do, in a sentence. */
export const COLLECTION_MANAGERS_ALWAYS =
  'Managers can always add and remove documents, fill it from a checklist, and rename it.';

/** The powers a reader is given by an older vault, which has no managers: its maker's, in its audience. */
export function collectionPowers(
  role: Role,
  collection: Pick<CollectionView, 'mine' | 'audience' | 'my_powers'>,
): CollectionPowers {
  if (collection.my_powers) return collection.my_powers;
  const maker = collection.mine;
  const now = maker && inCollectionAudience(role, collection.audience);
  return {
    maker,
    manager: false,
    edit: now,
    change_audience: now,
    delete: maker,
    choose_managers: false,
    remove_managers: false,
  };
}

/** A collection's links outside the family, as the family is told of them (5.19). */
export interface CollectionSharedOutside {
  /**
   * Whom each is for, as its sharer named them: only the links GET /shares
   * gives the reader (who may share, and made it or can see all it holds).
   */
  with: string[];
  /** A link keeps up with the collection: what is put in it goes too, if its audience may see it. */
  following: boolean;
}

/**
 * The warning beside a collection shared outside, where documents are put
 * in it (5.19): "This collection is shared with Jane Smith", and whether
 * what goes in now goes to them too. Only what an owner or an adult puts in
 * a collection follows its link (the 5.19 review): a teen, `role`, is told
 * that what they put in stays in the family.
 */
export function sharedOutsideWords(shared: CollectionSharedOutside, role?: Role | null): string {
  const names = shared.with.filter((n) => n.trim() !== '');
  const whom =
    names.length === 0
      ? 'This collection is shared outside the family'
      : names.length === 1
        ? `This collection is shared with ${names[0]}`
        : `This collection is shared with ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  if (!shared.following) return `${whom}. What you put in it now is not sent.`;
  return role === 'owner' || role === 'adult' || role == null
    ? `${whom}. What you put in it goes to them too, if everybody the collection is for may see it.`
    : `${whom}. What you put in it stays in the family: only what an owner or an adult puts in goes to them.`;
}

export interface CollectionItemView {
  /** As a collection of documents gives it: an Only me one's notes and details stay sealed. */
  document: DocumentView;
  added_at: string;
  /**
   * For the collection's maker and, since 0.9.0, its managers only
   * (`collectionItemHint`): who in its audience is not given this one. Null
   * for everybody else, always.
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
  /**
   * POST /collections/{id}/items only (5.33): who else will now see what was
   * put in — a viewer the collection is given to — one sentence each: "Jane
   * (viewer) will be able to see this." Absent when there is nobody, and
   * from older vaults.
   */
  warnings?: string[];
}

/** POST /collections (name and audience required) and PATCH /collections/{id}. */
export interface CollectionInput {
  name?: string | undefined;
  description?: string | null | undefined;
  audience?: CollectionAudience | undefined;
}
