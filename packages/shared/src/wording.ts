/**
 * Neutral wording in notifications and email (0.9.0, H2 of the health plan;
 * the owner's change of 22 Oct 2026, and Health documents only of 13 Nov).
 *
 * What leaves the vault about a document — a digest's line by email, a
 * browser's push, the reminder email — may name it, or may say only that
 * there is "A reminder about a document". The household chooses, in
 * Settings → Privacy, an owner's to change, which documents are not named:
 *
 *   off        none: titles as before.
 *   health     Health documents only: a document whose category is Medical
 *              (its own, else its kind's).
 *   sensitive  Sensitive documents only (the default, for new and existing
 *              households): a sensitive document (`sensitiveOf`).
 *   all        All documents.
 *
 * Each choice is a set of documents, and Health and Sensitive overlap
 * without either holding the other: not a ladder. Each person may add a
 * choice of their own for what is sent to them ("As the household says",
 * Health, Sensitive or All): a line is neutral when the household's choice
 * OR theirs says so (`neutralUnder`), so a person's choice can never name
 * what the household's hides. Whatever either says, an Only me document is
 * "One of your private documents" on every channel.
 *
 * A text never names a document whatever this says (SMS2), and a phone's
 * own push (UnifiedPush) never carries a title: they are not changed by it.
 */

/** The household's choice, in the order Settings offers them. */
export const NEUTRAL_WORDINGS = ['off', 'health', 'sensitive', 'all'] as const;
export type NeutralWording = (typeof NEUTRAL_WORDINGS)[number];

/** What a household says before an owner chooses: new and existing households alike. */
export const NEUTRAL_WORDING_DEFAULT: NeutralWording = 'sensitive';

/** A person's own choice: as the household says, or one more set of documents not named. */
export const MY_WORDINGS = ['household', 'health', 'sensitive', 'all'] as const;
export type MyWording = (typeof MY_WORDINGS)[number];

/** The category whose documents are Health's: Medical. */
export const HEALTH_CATEGORY = 'medical';

/** How a document is named when it may not be. */
export const NEUTRAL_LINE = 'A reminder about a document';
/** How an Only me document is named, on every channel, whatever the choice. */
export const PRIVATE_LINE = 'One of your private documents';

/** Whatever a stored value is, a choice the vault knows: anything else is the default. */
export const neutralWordingOf = (value: unknown): NeutralWording =>
  (NEUTRAL_WORDINGS as readonly unknown[]).includes(value)
    ? (value as NeutralWording)
    : NEUTRAL_WORDING_DEFAULT;

/** A person's stored choice (null: as the household says). */
export const myWordingOf = (value: unknown): MyWording =>
  value === 'health' || value === 'sensitive' || value === 'all' ? value : 'household';

/** What decides whether a document is neutral: whether it is sensitive, and whether Health. */
export interface WordedDocument {
  sensitive: boolean;
  health: boolean;
}

/** Whether one choice says a document is not named (Only me aside). */
export function neutralByRule(rule: NeutralWording, d: WordedDocument): boolean {
  switch (rule) {
    case 'all':
      return true;
    case 'sensitive':
      return d.sensitive;
    case 'health':
      return d.health;
    case 'off':
      return false;
  }
}

/**
 * The choices that apply to what is sent to one person: the household's,
 * and their own beside it. "As the household says" adds none.
 */
export function rulesFor(household: NeutralWording, mine: MyWording): NeutralWording[] {
  return mine === 'household' || mine === household ? [household] : [household, mine];
}

/** Whether a document is not named under any of `rules` (Only me aside): the union. */
export const neutralUnder = (rules: readonly NeutralWording[], d: WordedDocument): boolean =>
  rules.some((r) => neutralByRule(r, d));

/**
 * The choices in effect, said simply, in Settings' order: All alone when it
 * is among them; Off only when nothing else is.
 */
export function rulesInEffect(household: NeutralWording, mine: MyWording): NeutralWording[] {
  const rules = rulesFor(household, mine);
  if (rules.includes('all')) return ['all'];
  const some = NEUTRAL_WORDINGS.filter((r) => r !== 'off' && rules.includes(r));
  return some.length > 0 ? some : ['off'];
}

/**
 * Whether every document `b` leaves unnamed, `a` leaves unnamed too. Health
 * and Sensitive each hold only themselves and Off; All holds every choice;
 * Off holds Off alone.
 */
export const ruleContains = (a: NeutralWording, b: NeutralWording): boolean =>
  a === 'all' || b === 'off' || a === b;

/**
 * The same for unions of choices: each of `b`'s is held by one of `a`'s.
 * Exact here, as Health and Sensitive are each partly outside the other and
 * together are not All.
 */
export const rulesContain = (a: readonly NeutralWording[], b: readonly NeutralWording[]): boolean =>
  b.every((rb) => a.some((ra) => ruleContains(ra, rb)));

/**
 * Whether changing the household's choice from `from` to `to` names any
 * document `from` left unnamed — and so asks the owner to confirm it's them.
 * To All, or from Off, never; Health ↔ Sensitive, and either to Off, yes.
 */
export const wordingNeedsStepUp = (from: NeutralWording, to: NeutralWording): boolean =>
  !ruleContains(to, from);

/**
 * Whether a person's change of their own choice names, in what is sent to
 * them, any document it left unnamed — the household's choice counted in.
 */
export const myWordingNeedsStepUp = (
  household: NeutralWording,
  from: MyWording,
  to: MyWording,
): boolean => !rulesContain(rulesFor(household, to), rulesFor(household, from));

/** The documents the examples are about. */
export const WORDING_EXAMPLE_DOCUMENTS = {
  sensitive: 'A passport (Sensitive)',
  health: 'Blood test results (Health, not marked Sensitive)',
  ordinary: 'Car insurance (neither)',
} as const;

const NAMED = {
  sensitive: 'Sara’s passport — Expires: 20 Nov, in 7 days',
  health: 'Blood test results — Review: 20 Nov, in 7 days',
  ordinary: 'Car insurance — Expires: 20 Nov, in 7 days',
};
const NEUTRAL_EXAMPLE = `${NEUTRAL_LINE} — Due in 7 days`;
/** How an Only me document's line reads, whatever the choice. */
export const PRIVATE_EXAMPLE = `${PRIVATE_LINE} — Due in 7 days`;

/** The example documents, as `wordingExamples` says each under some choices. */
export type WordingExamples = Record<keyof typeof WORDING_EXAMPLE_DOCUMENTS, string>;

/** The line each example document would be sent as under these choices. */
export function wordingExamples(rules: readonly NeutralWording[]): WordingExamples {
  const of: Record<keyof typeof WORDING_EXAMPLE_DOCUMENTS, WordedDocument> = {
    sensitive: { sensitive: true, health: false },
    health: { sensitive: false, health: true },
    ordinary: { sensitive: false, health: false },
  };
  const out = {} as WordingExamples;
  for (const k of Object.keys(of) as Array<keyof typeof of>) {
    out[k] = neutralUnder(rules, of[k]) ? NEUTRAL_EXAMPLE : NAMED[k];
  }
  return out;
}

/** Each household choice in plain words. */
export const NEUTRAL_WORDING_WORDS: Record<NeutralWording, { label: string; note: string }> = {
  off: {
    label: 'Off',
    note: 'Documents are named by their title, as before.',
  },
  health: {
    label: 'Health documents only',
    note: 'Medical documents are not named. Others are named by their title.',
  },
  sensitive: {
    label: 'Sensitive documents only',
    note: 'Documents marked Sensitive are not named. Others are named by their title.',
  },
  all: {
    label: 'All documents',
    note: 'No document is named. Every reminder says only when it is due.',
  },
};

/** A person's choices in plain words. */
export const MY_WORDING_WORDS: Record<MyWording, { label: string; note: string }> = {
  household: {
    label: 'As the household says',
    note: 'Nothing more than an owner chose for the family.',
  },
  health: {
    label: 'Health documents only',
    note: 'Medical documents are not named in what is sent to you either.',
  },
  sensitive: {
    label: 'Sensitive documents only',
    note: 'Documents marked Sensitive are not named in what is sent to you either.',
  },
  all: {
    label: 'All documents',
    note: 'No document is named in what is sent to you.',
  },
};

/** Choices in effect in plain words: "Health and Sensitive documents". */
export function rulesWords(rules: readonly NeutralWording[]): string {
  if (rules.length === 1) return NEUTRAL_WORDING_WORDS[rules[0] as NeutralWording].label;
  if (rules.includes('health') && rules.includes('sensitive')) {
    return 'Health and Sensitive documents';
  }
  return rules.map((r) => NEUTRAL_WORDING_WORDS[r].label).join(', ');
}

/** GET and PUT /household/neutral-wording: an owner's. */
export interface NeutralWordingView {
  neutral_wording: NeutralWording;
}

/** PUT /household/neutral-wording. */
export interface NeutralWordingInput {
  neutral_wording: NeutralWording;
}

/** GET and PUT /notifications/wording: each person's own. */
export interface MyWordingView {
  /** Their own choice. */
  neutral_wording: MyWording;
  /** What the household says. */
  household: NeutralWording;
  /**
   * What is sent to them: the choices that apply (`rulesInEffect`) — the
   * household's and their own together. `['all']`, `['off']`, or Health
   * and Sensitive, one or both.
   */
  in_effect: NeutralWording[];
}

/** PUT /notifications/wording. */
export interface MyWordingInput {
  neutral_wording: MyWording;
}
