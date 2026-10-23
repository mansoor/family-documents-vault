import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { ConfirmDialog } from './ui.js';

/**
 * Leaving with something unsaved is asked about first (0.9.0, N1, and the
 * N1 review): whatever would take the person away from what they are
 * writing waits for "Leave without saving" —
 *
 *  - a link anywhere on the page (the sidebar, the list of notes);
 *  - the browser's own Back (and a phone's back button), caught by one
 *    entry put on top of the history while there is something unsaved:
 *    going back leaves only it, the page stays, and is asked about;
 *  - what the app does without a link — the search box, Sign out — which
 *    asks through `leaveThen`.
 *
 * The guard's entry is the page's own copy, and never outlives it (the N1
 * re-check): whatever leaves, saves or replaces the page first takes it
 * off with `release`, and only then goes — so Back never finds a stray
 * copy of a page left (an empty New note).
 *
 * Closing or reloading the tab is the browser's own question
 * (`beforeunload`, notes.tsx).
 */

/** Who asks, while something is unsaved: one at a time. */
let asker: ((go: () => void, stayed?: () => void) => void) | null = null;

/**
 * Does `go` now, or once the person has said to leave what they are
 * writing (the guard's entry taken off first); `stayed` if they keep
 * writing instead.
 */
export function leaveThen(go: () => void, stayed?: () => void): void {
  if (asker) asker(go, stayed);
  else go();
}

/** The extra history entry put on while something is unsaved, and the Back that takes it off. */
const SENTINEL = 'fdvLeaveGuard';

function onSentinel(): boolean {
  const state = window.history.state as Record<string, unknown> | null;
  return state !== null && typeof state === 'object' && state[SENTINEL] === true;
}

function putSentinel(): void {
  const state = (window.history.state as Record<string, unknown> | null) ?? {};
  window.history.pushState({ ...state, [SENTINEL]: true }, '', window.location.href);
}

/** The guard's own Back, taking its entry off, while it is on its way. */
let releasing: Promise<void> | null = null;

/**
 * Takes the guard's entry off the history, if it is the one the page is
 * on, and resolves once it is off (the N1 re-check): awaited before
 * anything that replaces the page or leaves it. The Back it makes is
 * the guard's own — never asked about — and is done with by its own
 * listener, whether or not a guard is still listening.
 */
export function release(): Promise<void> {
  if (releasing) return releasing;
  if (!onSentinel()) return Promise.resolve();
  releasing = new Promise<void>((done) => {
    const off = () => {
      window.removeEventListener('popstate', off);
      clearTimeout(late);
      releasing = null;
      done();
    };
    window.addEventListener('popstate', off);
    // A Back the browser never made (the page going as it was asked):
    // nothing is waited for, for ever.
    const late = setTimeout(off, 1000);
    window.history.back();
  });
  return releasing;
}

export function useLeaveGuard(dirty: boolean): ReactNode {
  const navigate = useNavigate();
  // The latest, without the guard set up again as the address changes: put
  // on again there, its entry would be on the page left.
  const go = useRef(navigate);
  useEffect(() => {
    go.current = navigate;
  }, [navigate]);
  const [pending, setPending] = useState<{ go: () => void; stayed?: () => void } | null>(null);
  /** The Back that Leave makes after a Back was asked about: not asked again. */
  const leaving = useRef(false);

  useEffect(() => {
    if (!dirty) return;
    let active = true;
    const ask = (go: () => void, stayed?: () => void) =>
      setPending(stayed ? { go, stayed } : { go });
    asker = ask;

    // Links.
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]');
      if (!(a instanceof HTMLAnchorElement)) return;
      if (a.target && a.target !== '_self') return;
      const to = new URL(a.href, window.location.href);
      if (to.origin !== window.location.origin) return;
      const here = window.location.pathname + window.location.search;
      if (to.pathname + to.search === here) return;
      e.preventDefault();
      e.stopPropagation();
      const where = to.pathname + to.search + to.hash;
      ask(() => void go.current(where));
    };
    document.addEventListener('click', onClick, true);

    // Back: an entry of the same address on top, which Back takes off.
    const here = window.location.href;
    const onPop = () => {
      // The guard's own Backs: taking its entry off, and Leave's.
      if (releasing) return;
      if (leaving.current) {
        leaving.current = false;
        return;
      }
      if (onSentinel()) return;
      // Off the guard's entry: still here. It goes straight back on (the
      // N1 re-check), so a second Back while this is asked is caught too,
      // and the person is asked.
      putSentinel();
      ask(() => {
        // Gone back to before this page: its entry, then the page itself.
        leaving.current = true;
        window.history.back();
      });
    };
    const arm = () => {
      if (!active || window.location.href !== here) return;
      if (!onSentinel()) putSentinel();
      window.addEventListener('popstate', onPop);
    };
    // A release still on its way (saved a moment ago, and written in
    // again): on again once it is done.
    if (releasing) void releasing.then(arm);
    else arm();

    return () => {
      active = false;
      if (asker === ask) asker = null;
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('popstate', onPop);
      // Saved, or let go, here: the guard's entry is taken off again, by
      // its own listener (the N1 re-check: never a flag left to swallow
      // the person's next Back).
      void release();
    };
  }, [dirty]);

  if (!pending) return null;
  const stay = () => {
    pending.stayed?.();
    setPending(null);
    if (!onSentinel() && !releasing) putSentinel();
  };
  return (
    <ConfirmDialog
      title="Leave without saving?"
      confirmLabel="Leave without saving"
      danger
      onConfirm={() => {
        const { go: leave } = pending;
        setPending(null);
        asker = null;
        // The guard's entry off first, then away: nothing of this page is
        // left on the history to come back to (the N1 re-check).
        void release().then(leave);
      }}
      onCancel={stay}
    >
      <p>What you have written in this note since you last saved it will be lost.</p>
    </ConfirmDialog>
  );
}
