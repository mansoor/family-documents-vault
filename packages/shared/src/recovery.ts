/**
 * Getting back in (0.9.0-dev.104): recovery codes, and security questions
 * if the person sets them.
 *
 * Either stands in for a second step that is lost — an authenticator app, a
 * passkey or codes by text — and only for that: with the password, or with
 * a reset link sent to the person's own address. Never on its own. Used,
 * every second step of theirs is taken away, every other device is signed
 * out, and the session may only set up two-step sign-in again and make new
 * recovery codes. The person is emailed, and when they are an owner, the
 * other owners are too.
 */

/** How many recovery codes a set has. Each works once. */
export const RECOVERY_CODE_COUNT = 10;

/** Two or fewer left, and the person is told to make new ones. */
export const RECOVERY_CODES_LOW = 2;

/**
 * What a recovery code is made of: lower-case letters and digits, without
 * the ones easily mistaken for each other on paper (0, 1, i, l, o).
 */
export const RECOVERY_CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

/** Letters and digits in a code: two groups of five, "7kq2m-xd9fe". About 50 bits. */
export const RECOVERY_CODE_LENGTH = 10;

/**
 * A recovery code as typed, as the vault compares it: lower case, with
 * spaces, dashes and anything else that is not a letter or a digit taken out.
 */
export function normaliseRecoveryCode(typed: string): string {
  return typed.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** A code as it is shown: two groups of five, with a dash between them. */
export function recoveryCodeWords(code: string): string {
  const c = normaliseRecoveryCode(code);
  return c.length === RECOVERY_CODE_LENGTH ? `${c.slice(0, 5)}-${c.slice(5)}` : c;
}

/** The ways that stand in for a lost second step, as the vault offers them. */
export type RecoveryWay = 'recovery_code' | 'security_questions';

/** `GET /auth/recovery-codes`: how many of the person's codes are left. */
export interface RecoveryCodesState {
  /** Codes not yet used. 0 when none were ever made, or all are used. */
  remaining: number;
  /** When the set was made; null when there is none. */
  made_at: string | null;
  /** Two or fewer left (`RECOVERY_CODES_LOW`), of a set that was made. */
  low: boolean;
  /**
   * Whether the person has a second step for them to stand in for: an
   * authenticator app, a passkey or codes by text (at sign-in or at a
   * reset). New codes are made only then (`409
   * recovery_codes_need_second_step`).
   */
  second_step: boolean;
}

/**
 * `POST /auth/recovery-codes`: a new set, which replaces the old one. The
 * codes are shown this once, and never again: the vault keeps only their
 * hashes.
 */
export interface RecoveryCodesMade extends RecoveryCodesState {
  codes: string[];
}

/** How many questions a person answers. All of them must be right. */
export const SECURITY_QUESTION_COUNT = 3;

/** The fewest letters and digits an answer may have, once normalised. */
export const SECURITY_ANSWER_MIN = 4;

/** The most characters an answer, or a question in the person's own words, may have. */
export const SECURITY_ANSWER_MAX = 200;
export const SECURITY_QUESTION_MAX = 200;

/** Wrong answers before the questions are refused for a day. */
export const SECURITY_QUESTION_TRIES = 5;

/** How long the questions are refused after that many wrong answers. */
export const SECURITY_QUESTIONS_REFUSED_HOURS = 24;

/** The key of a question in the person's own words. */
export const SECURITY_QUESTION_OWN = 'own';

/** The questions to choose from. A person picks three, one of them their own if they like. */
export const SECURITY_QUESTION_CHOICES: ReadonlyArray<{ key: string; text: string }> = [
  { key: 'first_school', text: 'What was the name of your first school?' },
  { key: 'first_pet', text: 'What was the name of your first pet?' },
  { key: 'childhood_street', text: 'What was the name of the street you grew up on?' },
  { key: 'first_job', text: 'What was your first job?' },
  { key: 'childhood_friend', text: 'What was the name of your best friend as a child?' },
  { key: 'first_concert', text: 'What was the first concert you went to?' },
  { key: 'first_car', text: 'What was the make and model of your first car?' },
  { key: 'favourite_teacher', text: 'What was the surname of your favourite teacher?' },
  { key: 'parents_met', text: 'In which town or city did your parents meet?' },
];

/** What the page says before anybody chooses: the risk, plainly. */
export const SECURITY_QUESTIONS_WARNING =
  'Your relatives may know the answers to questions like these. Choose ones they wouldn’t, or give answers only you would.';

/**
 * An answer as the vault compares it: accents, case, spaces and
 * punctuation taken out, so "St Mary's", "st marys" and "Śt Márys" are the
 * same answer. Decomposed first (NFKD), and every combining mark dropped.
 */
export function normaliseSecurityAnswer(answer: string): string {
  return answer
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** What is wrong with an answer, in plain words; null when nothing is. */
export function securityAnswerProblem(answer: string): string | null {
  if (answer.length > SECURITY_ANSWER_MAX) {
    return `An answer can be ${SECURITY_ANSWER_MAX} characters at most.`;
  }
  if (normaliseSecurityAnswer(answer).length < SECURITY_ANSWER_MIN) {
    return `Each answer needs at least ${SECURITY_ANSWER_MIN} letters or numbers.`;
  }
  return null;
}

/** A question as it is kept and shown: one of the choices, or the person's own words. */
export interface SecurityQuestion {
  /** One of `SECURITY_QUESTION_CHOICES`' keys, or `own`. */
  key: string;
  text: string;
}

/** `GET /auth/security-questions`: the person's own, never their answers. */
export interface SecurityQuestionsState {
  /** Whether three are set. */
  set: boolean;
  /** The three, in order; empty when none are set. */
  questions: SecurityQuestion[];
  /** When they were last set; null when none are. */
  set_at: string | null;
  /**
   * Whether the household lets security questions stand in for a lost
   * second step (an owner's choice, on unless turned off). Off, they are
   * kept but never asked, and setting new ones is refused.
   */
  offered: boolean;
  /** Refused after too many wrong answers, until then; null otherwise. */
  refused_until: string | null;
}

/** `PUT /auth/security-questions`: three, each with its answer. */
export interface SecurityQuestionsInput {
  questions: Array<{
    /** One of the choices' keys, or `own` with `text`. */
    key: string;
    /** The question in the person's own words, for `own`. */
    text?: string | undefined;
    answer: string;
  }>;
}

/** `GET` and `PUT /household/security-questions`: whether the household offers them. */
export interface SecurityQuestionsRule {
  on: boolean;
  can_change: boolean;
}

/** Said when a code by text can't be sent at sign-in or at a reset, and nobody is let in. */
export const TEXT_CODE_UNAVAILABLE_MESSAGE =
  'We couldn’t send your code by text. Use a recovery code or your security questions, or ask an owner to send you a password reset.';
