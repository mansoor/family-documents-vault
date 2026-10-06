import type { DocumentView } from '@fdv/shared';

/**
 * Drafts of notes not yet saved (5.35, A32): kept so a reload, or a slip
 * back to the list, does not lose what somebody was writing — but only for
 * a document everyone in the family sees, only for this tab
 * (`sessionStorage`), only for whoever wrote it, and never past a sign-out.
 * A draft of a note on an Adults only or an Only me document is never kept
 * anywhere: left in the browser, it could be read by a teen using the same
 * browser on a shared family computer.
 *
 * A draft remembers the note it began from — its words and the document's
 * ETag then — and never anybody else's: saved over a note somebody changed
 * meanwhile, after a reload too, it is refused and their note shown (the
 * 5.35 review, W535-03).
 *
 * Each is kept under the household and the person signed in (the review,
 * W535-07): a tab that outlives a sign-out, and is then signed in to as
 * somebody else, finds none of the last person's, and forgets them.
 *
 * Everything here is wrapped: a private window, or blocked site data, makes
 * storage throw, and then there is simply no draft.
 */

const PREFIX = 'fdv.note-draft.';

/** What was being written, and the note it began from. */
export interface NoteDraft {
  text: string;
  /** The note's words when the edit began ('' for none). */
  baseText: string;
  /** The document's ETag then: never one learnt from a conflict. */
  baseEtag: string;
  /** When the note had last changed then, to tell whether somebody changed it since. */
  baseStamp: string | null;
}

/** Who is signed in: whose drafts these are. */
export interface DraftOwner {
  household_id: string;
  member_id: string;
}

type Whose = Pick<DocumentView, 'id' | 'visibility'>;

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

const ownPrefix = (who: DraftOwner) => `${PREFIX}${who.household_id}.${who.member_id}.`;

/** Keeps a draft, for a document everyone in the family sees; for any other, forgets it. */
export function keepDraft(doc: Whose, who: DraftOwner, draft: NoteDraft): void {
  if (doc.visibility !== 'household') {
    forgetDraft(doc.id, who);
    return;
  }
  try {
    storage()?.setItem(ownPrefix(who) + doc.id, JSON.stringify(draft));
  } catch {
    // Full, or blocked: no draft.
  }
}

/**
 * The draft this person kept for this document, if any. Anybody else's is
 * not theirs, and is forgotten. A document no longer for everyone in the
 * family has none, and any kept from before is forgotten.
 */
export function draftOf(doc: Whose, who: DraftOwner): NoteDraft | null {
  forgetDrafts(who);
  if (doc.visibility !== 'household') {
    forgetDraft(doc.id, who);
    return null;
  }
  try {
    const raw = storage()?.getItem(ownPrefix(who) + doc.id);
    if (!raw) return null;
    const kept = JSON.parse(raw) as Partial<NoteDraft> | null;
    return typeof kept?.text === 'string' &&
      typeof kept.baseText === 'string' &&
      typeof kept.baseEtag === 'string'
      ? {
          text: kept.text,
          baseText: kept.baseText,
          baseEtag: kept.baseEtag,
          baseStamp: typeof kept.baseStamp === 'string' ? kept.baseStamp : null,
        }
      : null;
  } catch {
    return null;
  }
}

export function forgetDraft(documentId: string, who: DraftOwner): void {
  try {
    storage()?.removeItem(ownPrefix(who) + documentId);
  } catch {
    // Nothing kept, or nothing to keep it in.
  }
}

/**
 * Every draft this tab kept — at a sign-out, a session's end and a new
 * sign-in — or, given who is signed in, every one but theirs.
 */
export function forgetDrafts(keep?: DraftOwner): void {
  try {
    const s = storage();
    if (!s) return;
    const theirs = keep ? ownPrefix(keep) : null;
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const key = s.key(i);
      if (key?.startsWith(PREFIX) && !(theirs && key.startsWith(theirs))) keys.push(key);
    }
    for (const key of keys) s.removeItem(key);
  } catch {
    // Nothing kept, or nothing to keep it in.
  }
}
