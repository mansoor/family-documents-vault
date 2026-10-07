import type { CaptureMetadata } from './capture.js';
import { effectiveVisibility } from './capture.js';
import type { DocumentTypeView, Visibility } from './documents.js';
import { can, type Role } from './roles.js';
import type { IncomingPreviewState } from './upload-requests.js';

/**
 * Many documents at once (Phase 6, I1): a batch, its defaults, and the
 * items in it. Somebody who may add documents (an owner, an adult, a teen)
 * makes a batch, sends its files one request at a time, and accepts each
 * item as a document — or removes it. Until then an item is not a
 * document, and nobody but its uploader sees it (the owner's decision Q3).
 * The defaults fill only what is blank on the card (Q4).
 */

/** A batch holds this many files at most: a 201st is refused (`422 batch_full`). */
export const BATCH_MAX_FILES = 200;

/** A batch's name, at most. */
export const BATCH_NAME_MAX = 120;

/** Who can see what is filed from a batch, by default: as each kind says, or one of these. */
export type BatchVisibility = Visibility | null;

/**
 * A batch's defaults: each optional, each filling only what is blank when
 * an item is accepted. `visibility` null is "As each kind says";
 * `physical_location` is null for whoever does not see where originals are
 * kept (seesLocation), as it is everywhere else.
 */
export interface BatchDefaults {
  owner_member_id: string | null;
  type_key: string | null;
  visibility: BatchVisibility;
  physical_location: string | null;
  collection_id: string | null;
  tags: string[];
  is_essential: boolean;
}

/** `POST /api/v1/batches` and `PATCH /api/v1/batches/{id}`: a name, and defaults, each optional. */
export interface BatchInput {
  name?: string | null;
  defaults?: Partial<BatchDefaults>;
}

/** How many of a batch's items are in each state. Removed items are not counted. */
export interface BatchCounts {
  /** Every item not removed: waiting or accepted. */
  items: number;
  /** Not decided yet: the Inbox counts these. */
  waiting: number;
  accepted: number;
  /** Waiting, and a duplicate of a document or of another item. */
  duplicates: number;
}

/** `GET /api/v1/batches`: one of the caller's own batches. Nobody else's is ever listed. */
export interface BatchView {
  id: string;
  name: string | null;
  created_at: string;
  /** Its end: what is still undecided then is removed with it (INCOMING_KEEP_DAYS after it was made). */
  ends_at: string;
  defaults: BatchDefaults;
  counts: BatchCounts;
}

/**
 * What an item duplicates, by SHA-256: a document the uploader can see
 * (never one they cannot: that would say another person's Only me
 * document exists), or another of their own items, waiting, sent before it.
 */
export type BatchDuplicate =
  | { of: 'document'; document_id: string; title: string | null }
  | {
      of: 'item';
      batch_id: string;
      batch_name: string | null;
      /** When that batch was made: an unnamed batch is called by its date. */
      batch_created_at: string;
      item_id: string;
      /** In this very batch: "Also in this batch". */
      same_batch: boolean;
    };

/** An item's own state: waiting for its uploader, or filed as a document. Removed ones are gone. */
export type BatchItemState = 'waiting' | 'accepted';

/** Whether its pages have been read for its details (I2): `waiting` until then. */
export type BatchReadState = 'waiting' | 'reading' | 'read' | 'failed';

/** One file in a batch. */
export interface BatchItemView {
  id: string;
  batch_id: string;
  /** Its name as chosen, made safe to show. */
  name: string;
  /** What its bytes are, never what it was called. */
  content_type: string;
  byte_size: number;
  /** Its SHA-256, in hex: what a resumed upload compares, with the name and the size. */
  sha256: string;
  arrived_at: string;
  state: BatchItemState;
  /** Read for its details (I2 fills this); `waiting` in I1. */
  reading: BatchReadState;
  /** Its pages, drawn by the worker one at a time a household: served at …/pages/{n}. */
  preview_state: IncomingPreviewState;
  preview_pages: number | null;
  duplicate: BatchDuplicate | null;
  /** Accepted: the document it became, while the uploader can still see it. */
  document_id: string | null;
}

/** `GET /api/v1/batches/{id}`: a batch, and every item not removed, oldest first. */
export interface BatchDetail extends BatchView {
  items: BatchItemView[];
}

/**
 * `POST /api/v1/batches/{id}/items/{itemId}/accept`: every detail the
 * single add's card takes, and a collection. A detail left out takes the
 * batch's default, where it has one (Q4); one sent — `null` included — is
 * as sent.
 */
export interface BatchAcceptInput extends CaptureMetadata {
  collection_id?: string | null;
}

/** What an accepted item became; and who else will now see it, as a collection says (5.33). */
export interface BatchAccepted {
  document_id: string;
  version_id: string;
  warnings?: string[];
}

/** The narrowest first: Only me, Adults only, Everyone. */
const NARROW: Record<Visibility, number> = { private: 0, adults: 1, household: 2 };

/**
 * Who can see a document filed from a batch, before anybody chooses on the
 * card: the kind's own default, never wider than the batch's choice (a
 * kind usually Adults only stays Adults only), Only me for one's own
 * documents alone, and never Adults only for a teen. With no choice for the
 * batch ("As each kind says"), the kind's default; a kind kept Only me by
 * default, for somebody else's document or nobody's, the narrowest left.
 */
export function batchVisibility(opts: {
  chosen: BatchVisibility;
  type: Pick<DocumentTypeView, 'default_visibility'> | null | undefined;
  role: Role;
  /** Whose the document is ('' or null: nobody's yet). */
  owner: string | null;
  me: string | null | undefined;
}): Visibility {
  const mine = opts.owner !== null && opts.owner !== '' && opts.owner === opts.me;
  const adults = can(opts.role, 'document.see_adults');
  const kind = effectiveVisibility({}, opts.type, opts.role);
  let v: Visibility =
    opts.chosen === null ? kind : NARROW[opts.chosen] < NARROW[kind] ? opts.chosen : kind;
  if (v === 'private' && !mine) v = adults ? 'adults' : 'household';
  if (v === 'adults' && !adults) v = mine ? 'private' : 'household';
  return v;
}

/**
 * What a duplicate is said as, beside its item: "Already in the vault:
 * Aisha's passport", "Also in this batch", "In your batch Old papers". A
 * batch with no name is called as `label` says (by its date, on the web).
 */
export function duplicateWords(
  d: BatchDuplicate,
  label: (batch: { name: string | null; created_at: string }) => string = (b) =>
    b.name ?? 'with no name',
): string {
  if (d.of === 'document') return `Already in the vault: ${d.title ?? 'a document with no name'}`;
  if (d.same_batch) return 'Also in this batch';
  return `In your batch ${label({ name: d.batch_name, created_at: d.batch_created_at })}`;
}
