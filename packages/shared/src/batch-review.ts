import type { BatchLevel, ItemProposals } from './batch-levels.js';
import type { BatchAcceptInput, BatchDefaults } from './batches.js';
import { autoTitle } from './capture.js';
import type { CoreField, DocumentTypeView } from './documents.js';
import type { Role } from './roles.js';

/**
 * The review queue (Phase 6, I3): a batch's items accepted many at once —
 * every one that is Ready, as the vault levels it at that moment — and
 * taken back, while the uploader still may, into the queue.
 *
 * Accept all Ready files each item with exactly what its card would send
 * if nobody touched it (`untouchedAccept`): what the pages proposed, merged
 * with the batch's defaults, who can see it as the batch and its kind say
 * (narrowed where the kind is usually narrower), and the batch's
 * collection, tags and Essential. Each item is its own transaction, as a
 * single accept is: one that fails is named, and the rest are filed.
 *
 * Undo takes a document filed so back, for ACCEPT_UNDO_MINUTES after: the
 * document is removed for good, with nothing of it left that anybody else
 * is shown, and its file goes back to its item, which waits in the queue
 * again — read again, as it was read before. A document somebody else has
 * changed, shared or added to meanwhile is kept, and said so.
 */

/** Items one request of Accept all Ready takes at most: a client sends more in turns. */
export const ACCEPT_READY_MAX = 50;

/** How long, after Accept all Ready, its documents may be taken back into the queue. */
export const ACCEPT_UNDO_MINUTES = 5;

/** `POST /api/v1/batches/{id}/accept-ready`: the items the client saw Ready, optionally. */
export interface BatchAcceptReadyInput {
  /**
   * The items the client showed as Ready (ACCEPT_READY_MAX at most): only
   * those still Ready now are accepted, the rest reported. Left out, every
   * item Ready now, up to ACCEPT_READY_MAX, oldest first.
   */
  item_ids?: string[];
}

/** Why an item Accept all Ready was asked for was not accepted. */
export type AcceptReadySkip =
  /** Not Ready now: its level, as the vault levels it now. */
  | 'not_ready'
  /** Accepted or removed already, by this request's twin or the card. */
  | 'decided'
  /** Not an item of this batch. */
  | 'not_found';

/** What Accept all Ready did, item by item. */
export interface BatchAcceptReadyResult {
  /** Filed, each as its untouched card would have filed it. */
  accepted: Array<{
    item_id: string;
    document_id: string;
    version_id: string;
    /** Who else will now see it, as the collection it went in says (5.33). */
    warnings?: string[];
  }>;
  /** Asked for, and not accepted: not Ready now, decided already, or not in this batch. */
  skipped: Array<{ item_id: string; reason: AcceptReadySkip; level?: BatchLevel | null }>;
  /** Ready, and refused as its card's accept would have been: kept waiting, with why. */
  failed: Array<{ item_id: string; code: string; message: string }>;
  /** Until when `…/accept-ready/undo` takes these back; null when nothing was accepted. */
  undo_until: string | null;
  /** More items are Ready than one request takes (none were named): ask again. */
  more: boolean;
}

/** `POST /api/v1/batches/{id}/accept-ready/undo`: the items Accept all Ready accepted. */
export interface BatchUndoInput {
  item_ids: string[];
}

/** Why a document Accept all Ready filed was not taken back. */
export type UndoKept =
  /** Past ACCEPT_UNDO_MINUTES: it stays a document. */
  | 'too_late'
  /** Not filed by Accept all Ready, or not filed now (taken back already, or never). */
  | 'not_undoable'
  /** Somebody changed it, made a link to it, added a copy or moved it to the Trash meanwhile. */
  | 'changed'
  /** Not an item of this batch. */
  | 'not_found'
  /** Something went wrong taking it back (storage out of reach): it is still a document. */
  | 'failed';

/** What Undo did, item by item. */
export interface BatchUndoResult {
  /** Back in the queue, waiting: their documents removed for good. */
  restored: string[];
  /** Still documents, with why. */
  kept: Array<{ item_id: string; reason: UndoKept; message: string }>;
}

/** How many of a batch's waiting items are at each level, and how many are not read yet. */
export interface BatchLevelCounts {
  ready: number;
  check: number;
  unrecognised: number;
  problem: number;
  /** Waiting, and not levelled yet: still to be read. */
  unread: number;
}

/** Whether a kind shows one of the fixed fields: shown unless it says not (a vault before 0.5.6 says nothing). */
const shows = (type: Pick<DocumentTypeView, 'core'> | undefined, key: CoreField) =>
  type?.core?.[key]?.shown !== false;

/**
 * What an item's card sends when nobody changes anything on it and presses
 * Accept (I3): the body of `POST …/items/{itemId}/accept`. The web card
 * starts from exactly these (apps/web: BatchItemScreen and ConfirmForm), and
 * Accept all Ready files each Ready item with them, so accepting one by one
 * untouched and all at once file the same document.
 *
 * - The kind and whose it is: the merged proposal (the pages', the batch's,
 *   or both); a teen's are their own; a batch made Only me is the
 *   uploader's own.
 * - The name nobody typed: `autoTitle`, for that kind, person, issuer and
 *   issue date.
 * - Who can see it: the merged proposal's — the batch's choice, narrowed by
 *   the kind — never wider.
 * - The fixed fields the kind shows, as proposed (blank is null); an expiry
 *   only for a kind that expires; where the paper copies are as the batch
 *   says, when the kind shows it.
 * - A required yes-or-no of the kind's own, left alone, is a no — as the
 *   card shows it, and sends it.
 * - The batch's collection, tags and Essential.
 */
export function untouchedAccept(opts: {
  proposals: ItemProposals;
  defaults: BatchDefaults;
  types: ReadonlyArray<DocumentTypeView>;
  people: ReadonlyArray<{ id: string; display_name: string }>;
  role: Role;
  me: string;
}): BatchAcceptInput {
  const { proposals: p, defaults: d, role, me } = opts;
  const type = opts.types.find((t) => t.key === p.type_key?.value);
  const owner =
    role === 'teen' ? me : (p.owner_member_id?.value ?? (d.visibility === 'private' ? me : ''));
  const person = opts.people.find((m) => m.id === owner) ?? null;
  const issuer = p.issued_by?.value ?? '';
  const title = type
    ? autoTitle(type, person, { issued_by: issuer, issued: p.issued?.value ?? null })
    : '';
  const out: BatchAcceptInput = {
    type_key: type?.key ?? null,
    title: title.trim() || null,
    owner_member_id: owner || null,
    visibility: p.visibility.value,
  };
  if (shows(type, 'issued_by')) out.issued_by = issuer.trim() || null;
  if (shows(type, 'identifier')) out.identifier = (p.identifier?.value ?? '').trim() || null;
  if (shows(type, 'physical_location')) {
    out.physical_location = (d.physical_location ?? '').trim() || null;
  }
  if (shows(type, 'issued')) out.issued = p.issued?.value ?? null;
  if (type?.expiry_driver) out.expires = p.expires?.value ?? null;
  const answers: Record<string, unknown> = {};
  for (const f of type?.fields ?? []) {
    if (f.kind === 'yes_no' && f.required === true) answers[f.key] = false;
  }
  if (Object.keys(answers).length > 0) out.extra = answers;
  out.tags = d.tags.map((t) => t.trim()).filter(Boolean);
  out.is_essential = d.is_essential;
  out.collection_id = d.collection_id ?? null;
  return out;
}
