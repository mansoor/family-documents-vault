import { addDays, shortDate } from './reminders.js';
import type { Role } from './roles.js';

/**
 * A caregiver for somebody's medical papers, and turning 18 (0.9.0, H1b of
 * the health plan; the owner's decisions of 14 Nov 2026;
 * `features.caregivers`).
 *
 * A person names somebody of the family ("Let Ahmed see my medical
 * papers"); an owner may name one for somebody with no sign-in. The
 * caregiver then reads that person's Medical papers, their Only me ones
 * included, and writes none of them: no edit, no delete, no link outside
 * the family, no collection. Nothing else of the person's is opened. A grant
 * is revoked whenever the person (or, for somebody with no sign-in, an
 * owner) says, and a caregiver may give it up. Every grant, revoke and look
 * is written down; the person reads who looked at what, and when.
 *
 * The rule itself is the database's (0098, `caregiver_reads`), asked beside
 * the visibility rule wherever a document is read or found.
 */

/** The roles a caregiver signs in with: an owner's or an adult's. */
export const CAREGIVER_ROLES: readonly Role[] = ['owner', 'adult'];

/** Whether somebody signed in with this role may be named a caregiver. */
export const mayGiveCare = (role: Role | null | undefined): boolean =>
  role === 'owner' || role === 'adult';

/** The roles a person names a caregiver for themselves with: an owner, an adult or a teen. */
export const mayNameOwnCaregiver = (role: Role | null | undefined): boolean =>
  role === 'owner' || role === 'adult' || role === 'teen';

/** Said on each paper a caregiver sees because of a grant, and nowhere else. */
export const CAREGIVER_MARK = 'Shared with you as caregiver';

/** What a caregiver may not do to a paper a grant gave them (403 caregiver_read_only). */
export const CAREGIVER_READ_ONLY =
  'You can see this paper as a caregiver, but you can’t change it, share it or add it to a collection.';

/** The question, asked once of somebody turned 18 who signs in themselves. */
export const GROWN_UP_QUESTION =
  'Keep your medical papers visible to the family, or make them Only me?';

/** Said beside it: what each answer does. */
export const GROWN_UP_EXPLAINED =
  'You’re 18 or over now. Your medical papers are visible to the family. Only me means nobody else in the family can open them, owners included — only a caregiver you keep still sees them. Either way you can still change each paper yourself later.';

/** The refusal of Only me answered for somebody else (`403 only_the_person`). */
export const GROWN_UP_ONLY_ME_THEIRS =
  'Only they can make their medical papers Only me, once they have their own sign-in. You can keep them as they are, or name a caregiver.';

/** An owner's answer for somebody with a sign-in of their own (`403 ask_them_themselves`). */
export const GROWN_UP_THEIRS_TO_ANSWER =
  'They have their own sign-in, so they answer this themselves. If they still sign in as a teen, change their role to adult first.';

/** The refusal of a second answer (`409 already_answered`). */
export const GROWN_UP_ANSWERED = 'That question has already been answered.';

/**
 * What the owners' digest says of somebody turned 18 with no sign-in of
 * their own: by email and by push, no name and no date, as turning 13's
 * (`TURNED_13_TOLD`). The vault's own Home card names them.
 */
export const TURNED_18_TOLD = {
  title: 'Someone in the family has turned 18.',
  label: 'Open the vault to ask them about their medical papers.',
} as const;

/**
 * "Sara turned 18 on 9 Oct", "Sara is 18 today", or — asked long after, as
 * the first look asks everybody already grown up — "Sara is over 18", with
 * what to ask: an owner's card for somebody with no sign-in at all.
 */
export function turnedEighteenWords(
  name: string,
  turnedOn: string,
  today: string,
): { title: string; label: string } {
  return {
    title:
      turnedOn === today
        ? `${name} is 18 today`
        : turnedOn > addDays(today, -30)
          ? `${name} turned 18 on ${shortDate(turnedOn)}`
          : `${name} is over 18`,
    label:
      'Ask them in person whether their medical papers stay visible to the family. Once they have their own sign-in as an adult, they can make them Only me themselves.',
  };
}

/**
 * An owner's card for somebody 18 or over who still signs in as a teen
 * (H1b): the question waits for them until their role is an adult's — a
 * teen's sign-in may not choose who sees papers they did not file.
 */
export function roleFirstWords(name: string): { title: string; label: string } {
  return {
    title: `${name} is 18 or over and still signs in as a teen`,
    label: `Change ${name}’s role to adult on their page. Then they’ll be asked themselves whether their medical papers stay visible to the family.`,
  };
}

/** A caregiver grant, as whoever is given it reads it. Never an id they need not act on. */
export interface CaregiverGrantView {
  id: string;
  /** Whose medical papers. */
  person_member_id: string;
  person_name: string;
  /** Who may read them. */
  caregiver_member_id: string;
  caregiver_name: string;
  granted_at: string;
  /** Who named them, on the activity log's terms; null when they have left. */
  granted_by_name: string | null;
  /**
   * The person has said so themselves — they named them, or kept the one an
   * owner named — so their Only me medical papers are included. False for
   * one an owner named that they have not kept yet.
   */
  confirmed: boolean;
  /** The caller may revoke it: the person, or an owner for somebody with no sign-in. */
  may_revoke: boolean;
  /** The caller may keep it: the person, while an owner's naming is not kept. */
  may_keep: boolean;
  /** The caller is the caregiver, and may give it up. */
  may_give_up: boolean;
}

/** Somebody who may be named a caregiver: of the family, signed in as an owner or an adult. */
export interface CaregiverCandidate {
  member_id: string;
  display_name: string;
}

/** GET /members/{id}/caregivers: a person's caregivers, and who may be named. */
export interface PersonCaregivers {
  items: CaregiverGrantView[];
  /** The caller may name a caregiver for this person. */
  may_add: boolean;
  /** Who may be named, when the caller may name one: never the person, nor anybody already named. */
  candidates: CaregiverCandidate[];
}

/** GET /caregivers: the caller's own — those about them, and those they are caregiver in. */
export interface MyCaregivers {
  about_me: CaregiverGrantView[];
  for_others: CaregiverGrantView[];
}

/** What a caregiver did with a paper. */
export type CaregiverLookAction = 'opened' | 'downloaded' | 'previewed';

/**
 * One look a caregiver took at a paper a grant gave them: GET
 * /members/{id}/caregiver-views, for the person and the owners.
 */
export interface CaregiverLook {
  caregiver_name: string;
  /**
   * The paper, to the person; null to an owner, who is never told which of
   * somebody's Only me papers was looked at (`only_me`).
   */
  document_id: string | null;
  /** Its title — null for a sensitive one, said "a sensitive document", as the activity log says it; and to an owner. */
  title: string | null;
  sensitive: boolean;
  /** Said to an owner: one of the person's Only me papers, never which. */
  only_me?: boolean;
  action: CaregiverLookAction;
  at: string;
}

/** The words for a look: "Ahmed opened Blood test results". */
export function caregiverLookWords(l: CaregiverLook): string {
  const what =
    l.only_me === true
      ? 'one of their Only me papers'
      : l.document_id === null
        ? 'a paper since removed'
        : l.sensitive
          ? 'a sensitive document'
          : (l.title ?? 'an untitled paper');
  const verb =
    l.action === 'opened'
      ? 'opened'
      : l.action === 'downloaded'
        ? 'saved a copy of'
        : 'looked at the pages of';
  return `${l.caregiver_name} ${verb} ${what}`;
}

/**
 * Who answers a turning-18 question: the person themselves (signed in as an
 * owner or an adult); an owner asking them in person (no sign-in at all, Keep
 * only); or nobody yet — they sign in as a teen, and an owner changes their
 * role first (`role_first`, a card with no answer on it).
 */
export type GrownUpAsks = 'self' | 'in_person' | 'role_first';

/** A turning-18 question waiting for its answer (GET /grown-up/questions). */
export interface GrownUpQuestionView {
  member_id: string;
  display_name: string;
  /** Their 18th birthday, on the household's calendar. */
  turned_on: string;
  /** How many Medical papers about them the family can see now, those in the Trash too. */
  papers: number;
  asks: GrownUpAsks;
  /** Said as a Home card: "Sara turned 18 on 9 Oct" and what to do. */
  title: string;
  label: string;
}

/** The answer: keep as they are, or (the person only) make them Only me. */
export type GrownUpAnswerChoice = 'keep' | 'only_me';

/** What answering did. */
export interface GrownUpAnswerResult {
  answer: GrownUpAnswerChoice;
  /** How many papers were made Only me. */
  made_private: number;
}
