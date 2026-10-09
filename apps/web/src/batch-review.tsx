import {
  ACCEPT_READY_MAX,
  ACCEPT_UNDO_MINUTES,
  BATCH_MAX_FILES,
  type BatchAcceptReadyResult,
  type BatchUndoResult,
} from '@fdv/shared';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { api } from './api.js';
import { describeError, useApp } from './app-context.js';
import { forgetPages } from './batch-pages.js';
import { useUploads } from './batch-store.js';
import { ConfirmDialog } from './ui.js';

/**
 * Accept all Ready, on the web (Phase 6, I3): asked first, then sent — the
 * items the page showed Ready, ACCEPT_READY_MAX a request, or, from the
 * Inbox, whatever is Ready now — and what happened said in a toast with
 * Undo. The vault decides what is Ready, item by item, at that moment: the
 * toast says what was filed, what was not Ready any more, and what could
 * not be filed, and why.
 *
 * The toast stays until it is dismissed or the page is left (WCAG 2.2.1):
 * no timer takes it, or its Undo, away. Undo works for ACCEPT_UNDO_MINUTES,
 * as the toast says; after that the vault keeps the documents and the toast
 * says so. It is heard politely, its Undo is reached with Tab, Escape puts
 * it away, and the page leaves room under it so nothing in focus is hidden
 * behind it (WCAG 2.4.11).
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * One go through the queue (I3), carried from file to file in the page's
 * history: the files to go through as they stood when it began, in the
 * filter's order, and what was done with each so far — for "Item 4 of 20"
 * and, after the last, "All 20 done: 17 accepted, 3 removed".
 */
export interface ReviewRun {
  order: string[];
  /** The queue's filter it began from ('' for all). */
  level: string;
  accepted: number;
  removed: number;
  skipped: string[];
  /**
   * What the last decision did, said on the next file and, after the last,
   * on the queue: "“scan-3.pdf” is a document now: Aisha's passport.", with
   * who else will now see it (5.33).
   */
  last?: string;
}

export const newRun = (order: string[], level: string): ReviewRun => ({
  order,
  level,
  accepted: 0,
  removed: 0,
  skipped: [],
});

/** "All 20 done: 17 accepted, 3 removed", or what is left when some were skipped. */
export function runSummary(run: ReviewRun): string {
  const parts = [
    run.accepted > 0 ? `${run.accepted} accepted` : null,
    run.removed > 0 ? `${run.removed} removed` : null,
    run.skipped.length > 0 ? `${run.skipped.length} skipped` : null,
  ].filter((p): p is string => p !== null);
  const done = run.accepted + run.removed;
  if (run.skipped.length === 0) {
    return done === 0 ? 'Nothing left to check here.' : `All ${done} done: ${parts.join(', ')}.`;
  }
  return `Done for now: ${parts.join(', ')}. The skipped ${run.skipped.length === 1 ? 'one waits' : 'ones wait'} for you.`;
}

/** Ids in turns of `size`: a request never names more than the vault takes. */
const inTurns = (ids: readonly string[], size: number) =>
  Array.from({ length: Math.ceil(ids.length / size) }, (_, i) =>
    ids.slice(i * size, (i + 1) * size),
  );

export interface ReviewToast {
  /** What was done, first. */
  text: string;
  /** And what else is worth knowing: what was not filed, who else will see them. */
  more: string[];
  /**
   * The items Undo takes back, and until when (the vault's word); null once
   * there is nothing to undo. Another Accept all Ready of the same batch
   * while it may still be undone adds its own (the I3 review, W-I3-9).
   */
  undo: { batchId: string; itemIds: string[]; until: string | null } | null;
  busy: boolean;
}

/** What one Accept all Ready did, in words, with the names of the files where the page knows them. */
export function acceptedWords(
  r: BatchAcceptReadyResult,
  names: ReadonlyMap<string, string> = new Map(),
): { text: string; more: string[] } {
  const n = r.accepted.length;
  const nameOf = (id: string) => (names.get(id) ? `“${names.get(id)}”` : 'One file');
  // Each file said once, however many requests named it (W-I3-11).
  const failed = [...new Map(r.failed.map((f) => [f.item_id, f])).values()];
  const notReady = r.skipped.filter((s) => s.reason === 'not_ready').length;
  const decided = r.skipped.filter((s) => s.reason !== 'not_ready').length;
  const more: string[] = [];
  for (const f of failed) more.push(`${nameOf(f.item_id)} was not accepted: ${f.message}`);
  if (notReady > 0) {
    more.push(
      `${plural(notReady, 'file')} ${notReady === 1 ? 'was' : 'were'} not Ready any more, so ${notReady === 1 ? 'it waits' : 'they wait'} for you to check.`,
    );
  }
  if (decided > 0) {
    more.push(`${plural(decided, 'file')} had been accepted or removed already.`);
  }
  for (const w of new Set(r.accepted.flatMap((a) => a.warnings ?? []))) more.push(w);
  const text =
    n === 0
      ? 'Nothing was accepted.'
      : `${plural(n, 'file')} accepted as ${n === 1 ? 'a document' : 'documents'}. You can undo this for ${ACCEPT_UNDO_MINUTES} minutes.`;
  return { text, more };
}

/** What one Undo did, in words. */
export function undoneWords(r: BatchUndoResult): { text: string; more: string[] } {
  const n = r.restored.length;
  const text =
    n === 0
      ? 'Nothing was taken back.'
      : `Undone: ${plural(n, 'file')} ${n === 1 ? 'is' : 'are'} back in the queue, and will be read again.`;
  const byWhy = new Map<string, number>();
  for (const k of r.kept) byWhy.set(k.message, (byWhy.get(k.message) ?? 0) + 1);
  const more = [...byWhy].map(
    ([why, k]) => `${plural(k, 'file')} ${k === 1 ? 'stays a document' : 'stay documents'}: ${why}`,
  );
  return { text, more };
}

/** The toast: what was done, Undo while there is something to undo, and a way to put it away. */
export function Toast({
  toast,
  box,
  onUndo,
  onDismiss,
}: {
  toast: ReviewToast;
  box: RefObject<HTMLDivElement | null>;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      ref={box}
      className="toast"
      role="region"
      aria-label="What was just done"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onDismiss();
        }
      }}
    >
      <div className="toast-words">
        <p>{toast.text}</p>
        {toast.more.map((m, i) => (
          // The same words twice are two lines (the I3 review, W-I3-11).
          <p key={i} className="toast-more">
            {m}
          </p>
        ))}
      </div>
      {toast.undo && (
        <button
          type="button"
          className="btn btn-quiet toast-undo"
          aria-disabled={toast.busy || undefined}
          onClick={() => {
            if (!toast.busy) onUndo();
          }}
        >
          {toast.busy ? 'Undoing…' : 'Undo'}
        </button>
      )}
      <button
        type="button"
        className="btn btn-link toast-x"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  );
}

/** What a page asks Accept all Ready to take: the files it showed Ready, by id and name. */
export interface ReadyAsk {
  batchId: string;
  /** The files shown Ready: the question's count is theirs (the I3 review, W-I3-3). */
  itemIds: string[];
  names?: ReadonlyMap<string, string>;
}

/**
 * Accept all Ready, asked first and then the toast: one per page. `open`
 * asks about a batch — the ids the page showed Ready, the queue's or, from
 * the Inbox, the batch's as it was just read; `element` is the dialog, the
 * toast and the words heard; `changed` is called once the vault has
 * answered, for the page to read the batch again; `fallback` is where the
 * focus goes when the toast is put away and what asked is gone.
 */
export function useAcceptReady(opts: {
  changed: () => Promise<unknown> | void;
  /** The files' names the page knows, for the toast to name what was not filed. */
  names?: ReadonlyMap<string, string>;
  /** The focus's place once the toast goes, when the button that asked has gone (W-I3-4). */
  fallback?: (batchId: string) => HTMLElement | null;
}): {
  open: (ask: ReadyAsk, from: HTMLElement) => void;
  element: ReactNode;
  toastShown: boolean;
} {
  const { withToken } = useApp();
  const [, uploads] = useUploads();
  const [asking, setAsking] = useState<ReadyAsk | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<ReviewToast | null>(null);
  const [heard, setHeard] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const askedFrom = useRef<HTMLElement | null>(null);
  const focusToast = useRef(false);
  const { changed, names, fallback } = opts;
  const lastBatch = useRef<string | null>(null);

  // The toast takes the focus as it comes, and again once Undo has answered.
  useEffect(() => {
    if (!toast || !focusToast.current) return;
    focusToast.current = false;
    box.current?.focus();
  }, [toast]);

  const say = (words: { text: string; more: string[] }) =>
    setHeard([words.text, ...words.more].join(' '));

  const accept = async () => {
    if (!asking) return;
    setBusy(true);
    const { batchId, itemIds } = asking;
    lastBatch.current = batchId;
    const known = new Map([...(names ?? []), ...(asking.names ?? [])]);
    const all: BatchAcceptReadyResult = {
      accepted: [],
      skipped: [],
      failed: [],
      undo_until: null,
      more: false,
    };
    // Why the rest were not sent, once a request could not be finished.
    let stopped: string | null = null;
    const turns = inTurns(itemIds, ACCEPT_READY_MAX);
    // A turn at a time; what was filed is kept, whatever happens to a later
    // turn (the I3 review, W-I3-2): it is said, with its Undo, and so is why
    // the rest were not.
    for (const [at, turn] of turns.entries()) {
      let r: BatchAcceptReadyResult | null;
      try {
        r = await withToken((t) => api.acceptReady(t, batchId, { item_ids: turn }));
      } catch (err) {
        stopped = describeError(err);
        break;
      }
      if (!r) {
        stopped = 'You were signed out.';
        break;
      }
      all.accepted.push(...r.accepted);
      all.skipped.push(...r.skipped);
      all.failed.push(...r.failed);
      if (r.undo_until && (!all.undo_until || r.undo_until < all.undo_until)) {
        all.undo_until = r.undo_until;
      }
      // Some could not be filed: the rest are not sent after them (W-I3-11).
      if (r.failed.length > 0 && at < turns.length - 1) {
        stopped = `${plural(turns.slice(at + 1).flat().length, 'more file')} ${
          turns.slice(at + 1).flat().length === 1 ? 'was' : 'were'
        } not sent, as some could not be accepted. Try again.`;
        break;
      }
    }
    forgetPages(all.accepted.map((a) => a.item_id));
    if (all.accepted.length > 0) uploads.changed();
    const words = acceptedWords(all, known);
    if (stopped) {
      if (all.accepted.length > 0) words.more.push(`The rest were not accepted: ${stopped}`);
      else words.text = `Nothing was accepted: ${stopped}`;
    }
    // Still to be undone, from this batch: this Undo takes those too (W-I3-9).
    const ids = all.accepted.map((a) => a.item_id);
    const earlier =
      toast?.undo?.batchId === batchId &&
      (!toast.undo.until || new Date(toast.undo.until).getTime() > Date.now())
        ? toast.undo
        : null;
    const until = [earlier?.until ?? null, all.undo_until]
      .filter((u): u is string => u !== null)
      .sort()[0];
    const undoIds = [...(earlier?.itemIds ?? []), ...ids];
    if (earlier && ids.length > 0) {
      words.more.push(`Undo takes back all ${plural(undoIds.length, 'file')} accepted here.`);
    }
    focusToast.current = true;
    setToast({
      ...words,
      undo: undoIds.length > 0 ? { batchId, itemIds: undoIds, until: until ?? null } : null,
      busy: false,
    });
    say(words);
    setAsking(null);
    setBusy(false);
    await changed();
  };

  const undo = async () => {
    const was = toast;
    if (!was?.undo) return;
    setToast({ ...was, busy: true });
    const { batchId, itemIds } = was.undo;
    try {
      const all: BatchUndoResult = { restored: [], kept: [] };
      for (const turn of inTurns(itemIds, BATCH_MAX_FILES)) {
        const r = await withToken((t) => api.undoAcceptReady(t, batchId, turn));
        if (!r) return;
        all.restored.push(...r.restored);
        all.kept.push(...r.kept);
      }
      uploads.changed();
      const words = undoneWords(all);
      focusToast.current = true;
      setToast({ ...words, undo: null, busy: false });
      say(words);
      await changed();
    } catch (err) {
      // Nothing known to be taken back: Undo is still there to try again.
      setToast({ ...was, more: [describeError(err)], busy: false });
      setHeard(describeError(err));
    }
  };

  const dismiss = () => {
    setToast(null);
    // Back where the person was: the button that asked, if it is still there;
    // or else the page's own place for it — never nowhere (the I3 review, W-I3-4).
    const from = askedFrom.current;
    if (from?.isConnected) {
      from.focus();
      return;
    }
    const to = lastBatch.current && fallback ? fallback(lastBatch.current) : null;
    to?.focus();
  };

  const element = (
    <>
      {asking && (
        <ConfirmDialog
          title={`Accept ${plural(asking.itemIds.length, 'Ready file')}?`}
          confirmLabel={`Accept ${asking.itemIds.length}`}
          busyLabel="Accepting…"
          busy={busy}
          returnFocus={askedFrom}
          onConfirm={() => void accept()}
          onCancel={() => setAsking(null)}
        >
          <p>
            Each becomes a document with what its card shows: its kind, whose it is, its dates and
            number as its pages say them, and who can see it as the batch and its kind say. The
            vault checks each one again as it accepts it: one that is not Ready any more waits for
            you.
          </p>
          <p>You can undo this for {ACCEPT_UNDO_MINUTES} minutes.</p>
        </ConfirmDialog>
      )}
      {toast && <Toast toast={toast} box={box} onUndo={() => void undo()} onDismiss={dismiss} />}
      <p className="visually-hidden" role="status" aria-live="polite">
        {heard}
      </p>
    </>
  );

  return {
    open: (ask, from) => {
      askedFrom.current = from;
      lastBatch.current = ask.batchId;
      setAsking(ask);
    },
    element,
    toastShown: toast !== null,
  };
}
