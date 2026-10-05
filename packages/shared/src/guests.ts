import { shareEndWords } from './shares.js';

/**
 * Someone outside the family with a sign-in of their own: a guest (5.34,
 * D4, A27, A28). An attorney given the will, an accountant one person's tax
 * papers. On the wire a guest is a viewer (`role: 'viewer'`) with
 * `kind: 'guest'`, so an older client treats them as one:
 *
 *  - always limited to what they are given (a restriction they cannot be
 *    without, and that no owner can take off: 409 `guest_always_limited`);
 *  - a viewer and nothing else (409 `guest`);
 *  - their sign-in ends on a day within a year (A28), which an owner can
 *    renew (`renew_guest`, a passkey or a code);
 *  - never among the family: not in People, not offered as whose a
 *    document is, not counted, no suggestions for them, no identity details,
 *    no household profile — and they own no document, so nothing of theirs
 *    is private, and they have no member key.
 */

/** Of the family, or a guest from outside it (5.34): fixed once the person is made. */
export type MemberKind = 'family' | 'guest';

/**
 * The longest a guest's sign-in lasts before an owner renews it (A28): a
 * year, with a leap year's extra day. The database holds to the same.
 */
export const GUEST_MAX_DAYS = 366;

/** How long a guest's sign-in lasts when nobody says (the web's suggestion): 90 days. */
export const GUEST_DEFAULT_DAYS = 90;

/** The longest a guest's description may be: "attorney", "the family's accountant". */
export const GUEST_DESCRIPTION_MAX = 60;

/**
 * How the activity log names a guest (5.34): "Guest — Jane Smith, attorney",
 * or "Guest — Jane Smith" with no description. Never said as one of the
 * family.
 */
export function guestLabel(name: string, description?: string | null): string {
  const about = description?.trim();
  return `Guest — ${name}${about ? `, ${about}` : ''}`;
}

/**
 * What is wrong with an end chosen for a guest's sign-in, or null: it must
 * be in the future, and within a year (A28).
 */
export function guestEndProblem(end: Date, now: number = Date.now()): string | null {
  if (Number.isNaN(end.getTime())) return 'Choose the day their access ends.';
  if (end.getTime() <= now) return 'Choose a day in the future for their access to end.';
  if (end.getTime() > now + GUEST_MAX_DAYS * 24 * 60 * 60 * 1000) {
    return 'A guest’s access ends within a year. Choose an earlier day; an owner can renew it.';
  }
  return null;
}

/** Whether a guest's sign-in has ended (A28): past its end, it signs nobody in. */
export function guestAccessEnded(
  accessExpiresAt: Date | string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (accessExpiresAt === null || accessExpiresAt === undefined) return false;
  return new Date(accessExpiresAt).getTime() <= now;
}

/**
 * A guest's end in words (the 5.34 review): with its year, on the
 * household's clock — "Friday 4 December 2026 at 23:59".
 */
export const guestEndWords = (end: Date | string, timezone: string) =>
  shareEndWords(new Date(end), timezone, { year: true });

/**
 * Said to somebody whose guest sign-in has ended, once they have proven who
 * they are (`403 access_ended`): until when it ran, on the household's clock.
 */
export const guestAccessEndedWords = (end: Date | string, timezone: string) =>
  `Your access to this family vault ended ${guestEndWords(end, timezone)} (${timezone}). Ask whoever invited you to renew it.`;

/** Said of a guest given any role but viewer (409 `guest`). */
export const GUEST_ONLY_VIEWER = (name: string | null) =>
  `${name ?? 'They'} ${name ? 'is' : 'are'} from outside the family: a guest is always a viewer, limited to what they are given.`;

/** Said to an owner taking a guest's limits off (409 `guest_always_limited`). */
export const GUEST_ALWAYS_LIMITED =
  'A guest is always limited to what they are given. Change what they can see instead, or take their sign-in away.';

/** Said of a guest named where only the family may be: whose a document is, people given to a viewer. */
export const GUEST_OWNS_NOTHING = 'A guest owns no documents. Choose someone in the family.';
