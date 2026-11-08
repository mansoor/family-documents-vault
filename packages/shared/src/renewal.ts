/**
 * A new version's details, read from its pages and offered (0.9.0; the
 * owner's report of 7 Nov 2026: a renewed licence added from the phone kept
 * its old dates, and nothing offered the new ones).
 *
 * A document's chips (5.37) offer only what it has no value for. A renewal
 * has every value already — the old ones — so GET /documents/{id}/suggestions
 * also gives `renewal`: what the newest version's pages read of the fields a
 * renewal changes, read whatever the document holds now, and only for a
 * version after the first. `renewalOffers` says which of those differ from
 * the document's, each with what it was and whether it is weak — a client
 * shows "The new version says: Expires 1 Mar 2033 (was 1 Mar 2025)", weak
 * ones unticked and marked "check this", and sends the ticked ones to POST
 * /documents/{id}/renewal. Nothing is ever applied unasked (A44).
 *
 * Pure, so the web and the phone say the same.
 */
import { ACCEPT_UNDO_MINUTES } from './batch-review.js';
import type { DateValue, DocumentView } from './documents.js';
import type { DetailProposal, ProposalCue } from './proposals.js';

/** The fields a renewal changes, as the pages are read for them. */
export const RENEWAL_FIELDS = ['issued', 'expires', 'identifier', 'issued_by'] as const;
export type RenewalField = (typeof RENEWAL_FIELDS)[number];

/** How long "Use these" can be undone: as a batch's new version (S1). */
export const RENEWAL_UNDO_MINUTES = ACCEPT_UNDO_MINUTES;

/**
 * Below this a reading is weak (as a batch's card has it, ITEM_SURE's
 * expiry and CLASH_CONFIDENCE): shown, marked "check this", and unticked.
 */
export const RENEWAL_SURE = 0.8;

/** One field the new version's pages say otherwise. */
export interface RenewalOffer {
  field: RenewalField;
  value: DateValue | string;
  /** What the document holds now. */
  was: DateValue | string;
  confidence: number;
  cue: ProposalCue;
  /** Under RENEWAL_SURE, or read from unclear digits: offered unticked. */
  weak: boolean;
}

const plainWords = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
const plainNumber = (s: string) => s.replace(/[\s-]/g, '').toUpperCase();

const sameDate = (a: DateValue, b: DateValue) => a.date === b.date && a.precision === b.precision;

/**
 * What the newest version's pages say that differs from what the document
 * holds, for each field it has a value for (an empty one is the chips'). In
 * RENEWAL_FIELDS' order. Empty when there is no `renewal`.
 */
export function renewalOffers(
  doc: Pick<DocumentView, 'issued' | 'expires' | 'identifier' | 'issued_by'>,
  renewal: DetailProposal | null | undefined,
): RenewalOffer[] {
  if (!renewal) return [];
  const out: RenewalOffer[] = [];
  for (const field of RENEWAL_FIELDS) {
    const p = renewal[field];
    if (!p) continue;
    const weak = p.confidence < RENEWAL_SURE || p.corrected === true;
    const base = { field, confidence: p.confidence, cue: p.cue, weak };
    if (field === 'issued' || field === 'expires') {
      const was = doc[field];
      const value = p.value as DateValue;
      if (was && !sameDate(was, value)) out.push({ ...base, value, was });
    } else {
      const was = doc[field]?.trim() || null;
      const value = (p.value as string).trim();
      if (!was || !value) continue;
      const differs =
        field === 'identifier'
          ? plainNumber(was) !== plainNumber(value)
          : plainWords(was) !== plainWords(value);
      if (differs) out.push({ ...base, value, was });
    }
  }
  return out;
}

/** POST /documents/{id}/renewal: the fields chosen, for the version they were read from. */
export interface RenewalInput {
  /** The newest version whose pages were read: refused (409) once it is not. */
  version_id: string;
  issued?: DateValue | null | undefined;
  expires?: DateValue | null | undefined;
  identifier?: string | null | undefined;
  issued_by?: string | null | undefined;
}

/** What "Use these" did: the document now, and until when Undo takes it back. */
export interface RenewalResult {
  document: DocumentView;
  undo_until: string | null;
}

/** POST /documents/{id}/renewal/undo. */
export interface RenewalUndoInput {
  version_id: string;
}
