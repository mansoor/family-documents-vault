import { addDays, shortDate } from './reminders.js';
import { can, capabilityToInvite, ROLES, type Role } from './roles.js';
import { ageOn } from './suggestions.js';

/**
 * Inviting family members to sign up (after 0.7.0): who may have a sign-in
 * of their own, and which roles their age allows.
 *
 * The line is 13: an under-13 is a family profile, kept by the adults, with
 * no sign-in of their own. From 13 to 17 they sign in as a teen; from 18,
 * as whatever the inviter may hand out today (an adult, or a viewer with
 * the limits chosen as they are invited, 5.33). Somebody with no date of
 * birth is taken at the inviter's word: no role is a child's, so each the
 * inviter may hand out is offered.
 *
 * Ages are worked out on the household's calendar (`localToday`), as
 * `ageOn` counts them: a 29 February birthday comes on 1 March in other
 * years.
 */

/** The age at which somebody may have a sign-in of their own. */
export const OWN_SIGN_IN_AGE = 13;

/** The age from which the roles of a grown-up are offered, and a teen's no longer. */
export const GROWN_UP_AGE = 18;

/** Said wherever somebody under 13 might be invited, and why they cannot be. */
export const UNDER_13_NOTE =
  'Under-13s can’t have a sign-in of their own. They can be invited once they turn 13.';

/** The API's refusal of an invitation for somebody under 13 (`422 too_young`). */
export const TOO_YOUNG = (name: string) =>
  `${name} is under 13, so they can’t have a sign-in of their own yet. They can be invited once they turn 13.`;

/**
 * The day somebody born on `dateOfBirth` turns `years`, as `ageOn` counts
 * it: the first day on which they are that old. Null for no date.
 */
export function birthdayAt(dateOfBirth: string | null, years: number): string | null {
  if (!dateOfBirth) return null;
  const [y, m, d] = dateOfBirth.split('-').map(Number);
  if (!y || !m || !d) return null;
  const year = String(y + years).padStart(4, '0');
  const month = String(m).padStart(2, '0');
  // A day that year does not have (29 February): they are that old the
  // day after its last, 1 March.
  const last = new Date(Date.UTC(y + years, m, 0)).getUTCDate();
  if (d > last) return addDays(`${year}-${month}-${String(last).padStart(2, '0')}`, 1);
  return `${year}-${month}-${String(d).padStart(2, '0')}`;
}

/** Whether somebody may have a sign-in of their own on `today`: 13 or over, or no date of birth. */
export function oldEnoughToSignIn(dateOfBirth: string | null, today: string): boolean {
  const age = ageOn(dateOfBirth, today);
  return age === null || age >= OWN_SIGN_IN_AGE;
}

/** The roles somebody with this role may hand out in an invitation, today's rule. */
export function rolesToHandOut(inviter: Role): Role[] {
  return ROLES.filter((r) => can(inviter, capabilityToInvite(r)));
}

/**
 * Of the roles the inviter may hand out, those somebody of this age may be
 * given: none under 13; a teen's from 13 to 17; from 18 every other one the
 * inviter may give; every one the inviter may give when the age is not known.
 */
export function rolesForAge(age: number | null, offerable: readonly Role[]): Role[] {
  if (age === null) return [...offerable];
  if (age < OWN_SIGN_IN_AGE) return [];
  if (age < GROWN_UP_AGE) return offerable.filter((r) => r === 'teen');
  return offerable.filter((r) => r !== 'teen');
}

/**
 * Whether somebody of this age may be invited with this role, as the vault
 * holds it: a teen's from 13 to 17, any but a teen's from 18, any when the
 * age is not known. (Under 13, none: `TOO_YOUNG`.)
 */
export function roleSuitsAge(age: number | null, role: Role): boolean {
  if (age === null) return true;
  if (age < OWN_SIGN_IN_AGE) return false;
  return age < GROWN_UP_AGE ? role === 'teen' : role !== 'teen';
}

/** The API's refusal of a role somebody's age does not allow (`422 role_not_for_age`). */
export const ROLE_NOT_FOR_AGE = (name: string, age: number) =>
  age < GROWN_UP_AGE
    ? `${name} is under 18, so they can only be invited as a teen.`
    : `${name} is 18 or over, so they can’t be invited as a teen.`;

/** What the web needs of a person to say whether they may be invited. */
export interface InvitableFacts {
  id: string;
  date_of_birth: string | null;
  has_account: boolean;
  is_deceased: boolean;
  sign_in_removed?: boolean | undefined;
  kind?: 'family' | 'guest' | undefined;
}

/**
 * Whether somebody of the family may be offered an invitation to sign up:
 * of the family, alive, with no sign-in, never had one taken away (they are
 * given it back, never invited), no invitation waiting for them, and 13 or
 * over or of no known age. `invitations` are those the inviter is shown
 * (`GET /invitations`); one is live while it is `pending`.
 */
export function mayBeInvited(
  m: InvitableFacts,
  invitations: ReadonlyArray<{ member_id: string; state: string }>,
  today: string,
): boolean {
  if ((m.kind ?? 'family') !== 'family') return false;
  if (m.has_account || m.sign_in_removed || m.is_deceased) return false;
  if (invitations.some((i) => i.member_id === m.id && i.state === 'pending')) return false;
  return oldEnoughToSignIn(m.date_of_birth, today);
}

/**
 * A reminder to the owners that somebody has turned 13 and may now have a
 * sign-in of their own (after 0.7.0): `GET /reminders/people`. Only an
 * owner is given these; dismissed with `POST /reminders/people/{id}/dismiss`.
 */
export interface PersonReminderView {
  id: string;
  kind: 'turned_13';
  member_id: string;
  display_name: string;
  /** The day they turned 13, on the household's calendar. */
  fire_at: string;
  /** "Sara is 13 today", or "Sara turned 13 on 9 Oct" once the day has gone. */
  title: string;
  /** "They can now have their own sign-in." */
  label: string;
}

/**
 * What a turning-13 reminder says, on `today`: a title and a line, said
 * together as "Sara is 13 today. They can now have their own sign-in."
 */
export function turnedThirteenWords(
  name: string,
  fireAt: string,
  today: string,
): { title: string; label: string } {
  return {
    title: fireAt === today ? `${name} is 13 today` : `${name} turned 13 on ${shortDate(fireAt)}`,
    label: 'They can now have their own sign-in.',
  };
}
