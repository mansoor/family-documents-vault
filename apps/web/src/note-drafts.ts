import type { DocumentView } from '@fdv/shared';

/**
 * Drafts of notes not yet saved (5.35, A32): kept so a reload, or a slip
 * back to the list, does not lose what somebody was writing — but only for
 * a document everyone in the family sees, only for this tab
 * (`sessionStorage`), and never past a sign-out. A draft of a note on an
 * Adults only or an Only me document is never kept anywhere: left in the
 * browser, it could be read by a teen using the same browser on a shared
 * family computer.
 *
 * Everything here is wrapped: a private window, or blocked site data, makes
 * storage throw, and then there is simply no draft.
 */

const PREFIX = 'fdv.note-draft.';

/** What was being written, and the document's ETag it was started from. */
export interface NoteDraft {
  text: string;
  etag: string;
}

type Whose = Pick<DocumentView, 'id' | 'visibility'>;

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Keeps a draft, for a document everyone in the family sees; for any other, forgets it. */
export function keepDraft(doc: Whose, draft: NoteDraft): void {
  if (doc.visibility !== 'household') {
    forgetDraft(doc.id);
    return;
  }
  try {
    storage()?.setItem(PREFIX + doc.id, JSON.stringify(draft));
  } catch {
    // Full, or blocked: no draft.
  }
}

/**
 * The draft kept for this document, if any. A document no longer for
 * everyone in the family has none, and any kept from before is forgotten.
 */
export function draftOf(doc: Whose): NoteDraft | null {
  if (doc.visibility !== 'household') {
    forgetDraft(doc.id);
    return null;
  }
  try {
    const raw = storage()?.getItem(PREFIX + doc.id);
    if (!raw) return null;
    const kept = JSON.parse(raw) as Partial<NoteDraft> | null;
    return typeof kept?.text === 'string' && typeof kept.etag === 'string'
      ? { text: kept.text, etag: kept.etag }
      : null;
  } catch {
    return null;
  }
}

export function forgetDraft(documentId: string): void {
  try {
    storage()?.removeItem(PREFIX + documentId);
  } catch {
    // Nothing kept, or nothing to keep it in.
  }
}

/** Every draft this tab kept: at a sign-out, a session's end, and a new sign-in. */
export function forgetDrafts(): void {
  try {
    const s = storage();
    if (!s) return;
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const key = s.key(i);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) s.removeItem(key);
  } catch {
    // Nothing kept, or nothing to keep it in.
  }
}
