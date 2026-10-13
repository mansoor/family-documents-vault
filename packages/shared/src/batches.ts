import type {
  BatchClash,
  BatchLevel,
  BatchReadFailure,
  BatchTag,
  ItemProposals,
} from './batch-levels.js';
import type { BatchLevelCounts } from './batch-review.js';
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
  /**
   * Removed by the uploader, kept as a line of the batch until it goes
   * (I3): what the queue's Done says. Absent from an older vault.
   */
  removed?: number;
}

/**
 * `GET /api/v1/batches/counts`: how many of the caller's own items wait,
 * every batch of theirs together — what the Inbox counts, without the list.
 * Nobody else's, an owner included. Absent from a vault before 0.7.0.
 */
export interface BatchWaitingCounts {
  /** Not decided yet: the sum of `counts.waiting` over `GET /api/v1/batches`. */
  waiting: number;
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
  /**
   * How many waiting items are at each level, as the vault levels them now
   * (I3): only when asked for (`GET /batches?with=levels`) — counting them
   * opens what each item's pages proposed.
   */
  levels?: BatchLevelCounts;
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

/** The most near matches an item names (0.8.0, S1): the best first, "or another…" for the rest. */
export const RENEWALS_MAX = 5;

/**
 * A near match (0.8.0, S1): a document the uploader may change that an item
 * is probably the same paper as, or a renewal of. Judged on what its pages
 * proposed — never its bytes — under the uploader's own rules, as it is
 * asked: the same kind and the same number (spaces, dashes and case aside),
 * or the same kind, person and issuer. Nothing of it is stored.
 */
export interface BatchRenewal {
  document_id: string;
  title: string | null;
  /** How it matched: its number, or its kind, person and issuer. */
  by: 'number' | 'details';
}

/**
 * The separators a document number is written with, which say nothing of
 * it: white space and every kind of dash. The vault strips the same ones in
 * SQL, so the two always agree.
 */
export const NUMBER_SEPARATORS = ' \t\n\r\f\v ‐‑‒–—―−-';

const separators = new RegExp(`[${NUMBER_SEPARATORS}]`, 'g');

/** A document number as a near match compares it: "548 721-093" and "548721093" are one. */
export const numberKey = (n: string): string => n.replace(separators, '').toLowerCase();

/** An issuer as a near match compares it: its words, spaced once, in lower case. */
export const issuerMatchKey = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** "New version of Aisha's passport?": a near match, as the batch's page says it. */
export const renewalWords = (r: Pick<BatchRenewal, 'title'>): string =>
  `New version of ${r.title ?? 'a document with no name'}?`;

/** "Same as Aisha's passport": a file already in the vault, as the batch's page says it. */
export const sameAsWords = (d: { title: string | null }): string =>
  `Same as ${d.title ?? 'a document with no name'}`;

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
  /**
   * Read for its details (I2): `waiting` until the worker takes it,
   * `reading`, then `read` — or `failed`, and `read_failure` says why.
   */
  reading: BatchReadState;
  /** Why its pages were not read, while `reading` is `failed` (I2); absent from an I1 vault. */
  read_failure?: BatchReadFailure | null;
  /**
   * What the vault made of it (I2), for its uploader alone, worked out as it
   * is asked from what its pages proposed, the batch's defaults and the
   * kinds as they are now (`levelItem`): Ready, Check, Not recognised or a
   * Problem; null while it is not read yet (unless it is a duplicate), and
   * once it is accepted. Absent from an I1 vault.
   */
  level?: BatchLevel | null;
  /** Why it is at its level: a duplicate, unsure, missing, disagreed about, narrowed. */
  tags?: BatchTag[];
  /** What its card starts from: each detail proposed or defaulted, with how sure. Null once accepted. */
  proposals?: ItemProposals | null;
  /** Where the pages confidently disagree with a default (0.8 or more): both values. */
  clashes?: BatchClash[];
  /**
   * Its pages, drawn by the worker one at a time a household: served at
   * …/pages/{n} while it waits. `none` once it is accepted: its pages went
   * with its bytes, so there is nothing to ask for (the I1 review).
   */
  preview_state: IncomingPreviewState | 'none';
  preview_pages: number | null;
  duplicate: BatchDuplicate | null;
  /**
   * Near matches (0.8.0, S1): documents the uploader may change that it is
   * probably a new version of, best first, RENEWALS_MAX at most — each to be
   * added to with `into_document_id`. Empty while it is not read, once it is
   * accepted, and when it is the same file as a document they can see.
   * Absent from a vault before 0.8.0.
   */
  renewals?: BatchRenewal[];
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
  /**
   * Added as a new version of this document instead (0.8.0, S1): one the
   * uploader may see and change (403 for one they may see but not change, a
   * teen's not their own; 404 for one they cannot see). With it, only
   * `issued`, `expires` and `identifier` may be sent — what the document
   * takes from the new paper, as an edit would — and anything else is 422.
   * Its Undo is Accept all Ready's, for ACCEPT_UNDO_MINUTES.
   */
  into_document_id?: string;
}

/** What an accepted item became; and who else will now see it, as a collection says (5.33). */
export interface BatchAccepted {
  document_id: string;
  version_id: string;
  warnings?: string[];
  /**
   * Added as a new version (0.8.0, S1): until when it may be taken back,
   * with POST …/accept-ready/undo naming the item.
   */
  undo_until?: string;
}

/** What may be sent with `into_document_id`: what the document takes from the new paper. */
export const VERSION_ACCEPT_FIELDS = ['issued', 'expires', 'identifier'] as const;

/** The narrowest first: Only me, Adults only, Everyone. */
const NARROW: Record<Visibility, number> = { private: 0, adults: 1, household: 2 };

/**
 * Who can see a document filed from a batch, before anybody chooses on the
 * card: the kind's own default, never wider than the batch's choice (a
 * kind usually Adults only stays Adults only), Only me for one's own
 * documents alone, and never Adults only for a teen. With no choice for the
 * batch ("As each kind says"), the kind's default; a kind kept Only me by
 * default, for somebody else's document or nobody's, the narrowest left.
 *
 * A batch made Only me is its uploader's own documents (the I1 review):
 * Only me, always — never widened by a guess. Whose they are is the
 * uploader, filled where nobody is chosen (the vault stores it so); a card
 * that names somebody else must choose who can see it, as a single add must.
 */
export function batchVisibility(opts: {
  chosen: BatchVisibility;
  type: Pick<DocumentTypeView, 'default_visibility'> | null | undefined;
  role: Role;
  /** Whose the document is ('' or null: nobody's yet). */
  owner: string | null;
  me: string | null | undefined;
}): Visibility {
  if (opts.chosen === 'private') return 'private';
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
