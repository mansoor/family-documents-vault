/**
 * Where the original is, as a place in somebody's cabinet (0.9.0, C3; the
 * owner's idea 5 of 13 Nov 2026): Cabinet › Drawer › Folder, picked from
 * the setter's own layout (C1), beside the free text `physical_location`
 * ("Fire safe, top shelf"), which stays for everything else.
 *
 * A household's fact, as where the original is kept has been since 5.41:
 * answered to the same people (owners, adults and teens, `seesLocation`),
 * and to nobody else. Layouts are each person's own, so the place keeps the
 * names of its path on the document — nobody needs the setter's layout to
 * read it. While the setter's folder is still in their layout the place
 * follows it: renamed, the names change with it; taken away, the names stay
 * as they were, as words.
 */

/** A document's place in a cabinet, as the vault answers it. */
export interface OriginalPlace {
  /** The cabinet's, the drawer's and the folder's names, as the setter last had them. */
  path: [cabinet: string, drawer: string, folder: string];
  /**
   * The folder in the caller's own layout, by its id there, when it was the
   * caller who set it and it is still theirs; null otherwise (somebody
   * else's folder, or one taken away). Never another person's folder id.
   */
  folder_id: string | null;
}

/** What PATCH /documents/{id} takes for it: a folder of the caller's own layout, or null to clear it. */
export type OriginalPlaceInput = { folder_id: string } | null;

/** POST /documents/original-place: one place, or none, for many documents at once. */
export interface OriginalPlaceBulkInput {
  document_ids: string[];
  /** A folder of the caller's own layout, or null to clear the place. */
  folder_id: string | null;
}

/** Its answer: which were set (or cleared), and which were left as they were, not theirs to change. */
export interface OriginalPlaceBulkResult {
  changed: string[];
  /** Unchanged: already so. */
  unchanged: string[];
  /** Left as they are: a teen's not their own, or a caregiver's read-only paper. */
  not_yours: string[];
}

/** The most documents one POST /documents/original-place takes. */
export const ORIGINAL_PLACE_MOST = 200;

/** How a place's names are joined, wherever it is said in one line. */
export const PLACE_SEPARATOR = ' › ';

/** A place in a line: "Study cabinet › Drawer 2 › Tax 2025". */
export function placeWords(place: Pick<OriginalPlace, 'path'>): string {
  return place.path.join(PLACE_SEPARATOR);
}

/**
 * Where the original is, said once (C3): the place in a cabinet first, and
 * then the words written for it, after a middle dot — "Study cabinet ›
 * Drawer 2 › Tax 2025 · behind the blue divider". Either alone when there
 * is only one; null when there is neither.
 */
export function whereKeptWords(doc: {
  original_place?: Pick<OriginalPlace, 'path'> | null | undefined;
  physical_location?: string | null | undefined;
}): string | null {
  const place = doc.original_place ? placeWords(doc.original_place) : '';
  const note = doc.physical_location?.trim() ?? '';
  if (place && note) return `${place} · ${note}`;
  return place || note || null;
}

/**
 * The address a printed folder label's QR code holds (C3): the vault's own
 * page for the folder, and nothing else — no token, no secret, no title and
 * nobody's name; only the folder's id in its person's layout. Whoever opens
 * it signs in as usual, and is shown the folder only if it is theirs, and
 * only what they may see in it.
 */
export function folderLabelUrl(origin: string, folderId: string): string {
  return `${origin.replace(/\/+$/, '')}/folder/${encodeURIComponent(folderId)}`;
}

/**
 * Refused (C3): a cabinet's, drawer's or folder's new name may not hold
 * `PLACE_SEPARATOR`, which joins a place's names into one line — so a line
 * always says which name is which. A name kept from before keeps it.
 */
export const NAME_HOLDS_SEPARATOR =
  'a name can’t hold “ › ”, which goes between a cabinet, a drawer and a folder. Use another mark, such as “-”.';

/** Refused: the folder named is not one of the caller's own shown folders. */
export const PLACE_NOT_IN_CABINET =
  'That folder isn’t in your cabinet any more. Choose another, or reload the page.';
