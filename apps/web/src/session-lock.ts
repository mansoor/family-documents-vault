/**
 * Lock (0.9.0-dev.86): what the tab knows of its session being locked.
 *
 * The vault keeps the lock (`POST /auth/lock`): every call but the lock
 * screen's answers `423 session_locked` until a credential unlocks it. Any
 * call that hears a 423 says so here (api.ts), so a second tab, or a screen
 * that asked as the lock came, shows the lock screen too.
 *
 * Beside it, a note in localStorage of whose session it is (a member's id,
 * nothing else), so a reload, and every other tab of this browser, show the
 * lock screen at once rather than the page first. It is only a hint for
 * what to draw: the vault decides, and the lock screen asks it.
 */

/** Where the hint is kept: shared by this browser's tabs, as the session is. */
export const LOCK_HINT_KEY = 'fdv.locked';

const listeners = new Set<() => void>();

/** Some call was answered `423 session_locked`. */
export function heardLocked(): void {
  for (const listen of listeners) listen();
}

/** Told whenever a call hears the vault is locked. Returns the way to stop. */
export function onLockHeard(listen: () => void): () => void {
  listeners.add(listen);
  return () => {
    listeners.delete(listen);
  };
}

/** Whether this browser was last told that `memberId`'s session is locked. */
export function lockedHintFor(memberId: string | null | undefined): boolean {
  if (!memberId) return false;
  try {
    return localStorage.getItem(LOCK_HINT_KEY) === memberId;
  } catch {
    return false;
  }
}

/** Kept (the session locked, whose it is), or forgotten (null). */
export function setLockedHint(memberId: string | null): void {
  try {
    if (memberId) localStorage.setItem(LOCK_HINT_KEY, memberId);
    else localStorage.removeItem(LOCK_HINT_KEY);
  } catch {
    // Blocked storage: a reload shows the page until the vault says 423.
  }
}

/**
 * A lock asked for that the vault has not said it took (no 204 yet): Lock
 * pressed while the vault could not be reached, or its answer lost. Kept,
 * whose it is, beside the hint, and sent again until it is taken
 * (app-context.tsx). Without it, a lock screen the vault says is not locked
 * — a late 423, from before another tab unlocked — goes away by itself.
 */
export const LOCK_PENDING_KEY = 'fdv.lock-pending';

/** Whether a lock asked for in this browser for `memberId` waits to be taken. */
export function lockPendingFor(memberId: string | null | undefined): boolean {
  if (!memberId) return false;
  try {
    return localStorage.getItem(LOCK_PENDING_KEY) === memberId;
  } catch {
    return false;
  }
}

/** Kept (a lock asked for, whose), or forgotten (null: taken, or no longer wanted). */
export function setLockPending(memberId: string | null): void {
  try {
    if (memberId) localStorage.setItem(LOCK_PENDING_KEY, memberId);
    else localStorage.removeItem(LOCK_PENDING_KEY);
  } catch {
    // Blocked storage: asked again only by this page, while it is open.
  }
}
