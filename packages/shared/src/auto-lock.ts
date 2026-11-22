/**
 * Lock by itself after a while away (0.9.0-dev.87).
 *
 * A browser left signed in is locked by the vault once nobody has used it
 * for a while, as if Lock had been pressed (`features.session_lock`): the
 * session stays, and answers `423 session_locked` until it is confirmed to
 * be them. How long is a setting, never a number in the code:
 *
 *  - the household's, an owner's: Off, or 5, 10, 15, 30 or 60 minutes —
 *    15 for every household until an owner chooses otherwise;
 *  - each person's own, beside it: a shorter time for themselves, never a
 *    longer one, and never Off while the household has a time. Null is "as
 *    the household says".
 *
 * What is in effect is the shorter of the two (`autoLockInEffect`). Only a
 * browser's session is ever locked so: a phone's and a connected app's
 * never are.
 *
 * What counts as use is real use. A browser marks the requests it makes by
 * itself — counts it asks for, checks on a timer — with `BACKGROUND_HEADER`,
 * and those leave the time it was last used as it was; and while somebody
 * moves the mouse, types or scrolls, it says they are still here (`POST
 * /auth/still-here`) at most about once a minute, so reading a long document
 * is use too.
 */

/** The times on offer, in minutes. */
export const AUTO_LOCK_MINUTES = [5, 10, 15, 30, 60] as const;
export type AutoLockMinutes = (typeof AUTO_LOCK_MINUTES)[number];

/** The household's time until an owner chooses another. */
export const AUTO_LOCK_DEFAULT: AutoLockMinutes = 15;

/**
 * Sent by a browser with a request it makes by itself, never because
 * somebody did something (`1`): the vault does not count it as use.
 */
export const BACKGROUND_HEADER = 'x-fdv-background';

/** Whether a value is one of the times on offer. */
export function isAutoLockMinutes(v: unknown): v is AutoLockMinutes {
  return (AUTO_LOCK_MINUTES as readonly unknown[]).includes(v);
}

/**
 * The time in effect for somebody: the household's (null, Off) and their
 * own (null, as the household says), the shorter of the two. With the
 * household's Off, their own alone.
 */
export function autoLockInEffect(
  household: AutoLockMinutes | null,
  mine: AutoLockMinutes | null,
): AutoLockMinutes | null {
  if (household === null) return mine;
  if (mine === null) return household;
  return mine < household ? mine : household;
}

/**
 * Whether somebody may choose `mine` for themselves under the household's
 * time: as the household says (null) always; a time of their own only if it
 * is no longer than the household's.
 */
export function autoLockAllowed(
  household: AutoLockMinutes | null,
  mine: AutoLockMinutes | null,
): boolean {
  if (mine === null) return true;
  return household === null || mine <= household;
}

/** "Off", "After 15 minutes", "After 1 hour": a choice, as Settings offers it. */
export function autoLockChoiceWords(minutes: AutoLockMinutes | null): string {
  if (minutes === null) return 'Off';
  return `After ${autoLockSpan(minutes)}`;
}

/** "15 minutes", "1 hour": a time, inside a sentence. */
export function autoLockSpan(minutes: AutoLockMinutes): string {
  return minutes === 60 ? '1 hour' : `${minutes} minutes`;
}

/** What is in effect, in a sentence: Settings says it under the choices. */
export function autoLockWords(minutes: AutoLockMinutes | null): string {
  return minutes === null
    ? 'The vault stays unlocked in a browser until you lock it or sign out.'
    : `The vault locks itself in a browser after ${autoLockSpan(minutes)} with nobody using it.`;
}

/**
 * GET /household/auto-lock (`features.auto_lock`): the household's time,
 * the reader's own, and what is in effect for them; whether they may change
 * the household's (an owner). PUT /household/auto-lock `{ minutes }` changes
 * the household's; PUT /me/auto-lock `{ minutes }` their own.
 */
export interface AutoLock {
  /** The household's: null, Off. */
  household: AutoLockMinutes | null;
  /** Their own: null, as the household says. */
  mine: AutoLockMinutes | null;
  /** The shorter of the two (`autoLockInEffect`). */
  in_effect: AutoLockMinutes | null;
  /** The reader may change the household's: an owner. */
  can_change: boolean;
}

/** `PUT /household/auto-lock` and `PUT /me/auto-lock`. */
export interface AutoLockInput {
  minutes: AutoLockMinutes | null;
}

/** A time of their own longer than the household's (422, `detail: 'minutes'`). */
export const AUTO_LOCK_LONGER = 'Choose a time no longer than the family’s.';
