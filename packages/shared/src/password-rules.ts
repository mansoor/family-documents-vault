/**
 * Password rules (`features.password_rules`): what a sign-in password must
 * be, as the household's owners set it in Settings → Security.
 *
 *  - At least so many characters: 10 to 64, 10 unless an owner chose more.
 *  - Not a common or easily guessed password: on unless an owner turned it
 *    off. The vault refuses a password found in a list of common passwords
 *    it keeps itself, and one that is just the person's own email address or
 *    name. Nothing is ever sent anywhere to be checked.
 *  - An uppercase letter, a lowercase letter, a number, a symbol: each off
 *    unless an owner turned it on.
 *
 * The rules are asked whenever a sign-in password is set: changed by the
 * person, set from a reset link, chosen as an invitation is accepted, and the
 * first owner's at setup (with the rules every new household starts with).
 * Passwords already set are never asked again. A link's or a request's
 * password is not a sign-in password, and none of this is about it.
 *
 * The vault is the authority: a refusal is `400 password_rules`, its message
 * written to be shown and naming everything that is missing. What lies here
 * — the length and the mix — is pure, so a page can say the same as it is
 * typed; whether a password is common is the vault's to say.
 */

/** The fewest characters an owner may ask for, and every household's until one asks for more. */
export const PASSWORD_MIN_LENGTH = 10;
/** The most characters an owner may ask for as the least. */
export const PASSWORD_MIN_LENGTH_CEILING = 64;
/** The longest a sign-in password may be at all. */
export const PASSWORD_MAX_LENGTH = 1024;

/** `error.code` of a password the household's rules refuse (400). */
export const PASSWORD_RULES_CODE = 'password_rules';

export interface PasswordRules {
  /** At least this many characters: 10 to 64. */
  min_length: number;
  /** Refuse common and easily guessed passwords, the person's own email and name among them. */
  refuse_common: boolean;
  needs_upper: boolean;
  needs_lower: boolean;
  needs_number: boolean;
  needs_symbol: boolean;
}

/** Every field of the rules, in the order they are shown. */
export const PASSWORD_RULES_KEYS = [
  'min_length',
  'refuse_common',
  'needs_upper',
  'needs_lower',
  'needs_number',
  'needs_symbol',
] as const satisfies readonly (keyof PasswordRules)[];

/** `GET` and `PUT /api/v1/household/password-rules`: the rules, and whether the reader may change them (an owner). */
export interface PasswordRulesView extends PasswordRules {
  can_change: boolean;
}

/** The rules every household starts with: 10 characters, common passwords refused, no mix asked for. */
export const PASSWORD_RULES_DEFAULT: Readonly<PasswordRules> = Object.freeze({
  min_length: PASSWORD_MIN_LENGTH,
  refuse_common: true,
  needs_upper: false,
  needs_lower: false,
  needs_number: false,
  needs_symbol: false,
});

/** One thing a password lacks for the rules' length and mix. */
export type PasswordLack = 'length' | 'upper' | 'lower' | 'number' | 'symbol';

/** The mix, in the order it is said. */
const MIX = ['upper', 'lower', 'number', 'symbol'] as const;
type Mix = (typeof MIX)[number];

const MIX_WORDS: Record<Mix, string> = {
  upper: 'an uppercase letter',
  lower: 'a lowercase letter',
  number: 'a number',
  symbol: 'a symbol',
};

const MIX_TEST: Record<Mix, RegExp> = {
  upper: /\p{Lu}/u,
  lower: /\p{Ll}/u,
  number: /\p{Nd}/u,
  // Anything that is neither a letter nor a number: punctuation, a space, an emoji.
  symbol: /[^\p{L}\p{N}]/u,
};

const asks = (rules: PasswordRules, m: Mix): boolean =>
  m === 'upper'
    ? rules.needs_upper
    : m === 'lower'
      ? rules.needs_lower
      : m === 'number'
        ? rules.needs_number
        : rules.needs_symbol;

/** A password's length in characters, as a person counts them: an emoji is one. */
export const passwordLength = (password: string): number => Array.from(password).length;

/** Whether a length is one an owner may ask for as the least. */
export const isPasswordMinLength = (n: unknown): n is number =>
  typeof n === 'number' &&
  Number.isInteger(n) &&
  n >= PASSWORD_MIN_LENGTH &&
  n <= PASSWORD_MIN_LENGTH_CEILING;

/**
 * What a password lacks for the rules' length and mix, in the order it is
 * said; none when it has all of it. Whether it is common is not asked here.
 */
export function passwordLacks(password: string, rules: PasswordRules): PasswordLack[] {
  const out: PasswordLack[] = [];
  if (passwordLength(password) < rules.min_length) out.push('length');
  for (const m of MIX) if (asks(rules, m) && !MIX_TEST[m].test(password)) out.push(m);
  return out;
}

/** "a", "a and b", "a, b and c". */
function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] as string}`;
}

const mixAsked = (rules: PasswordRules): string[] =>
  MIX.filter((m) => asks(rules, m)).map((m) => MIX_WORDS[m]);

/** The length and the mix, with no stop: "At least 12 characters, with a number and a symbol". */
export function passwordLengthWords(rules: PasswordRules): string {
  const mix = mixAsked(rules);
  return `At least ${rules.min_length} characters${mix.length > 0 ? `, with ${list(mix)}` : ''}`;
}

/**
 * The rules in a line, for under a password field: "At least 12 characters,
 * with an uppercase letter and a number." And, while common passwords are
 * refused, "Not a common password, nor your name or email address."
 */
export function passwordRulesWords(rules: PasswordRules): string {
  const length = `${passwordLengthWords(rules)}.`;
  return rules.refuse_common
    ? `${length} Not a common password, nor your name or email address.`
    : length;
}

/** Said of a password found among the common ones. */
export const PASSWORD_TOO_COMMON = 'That password is too common: choose another.';
/** Said of a password that is the person's own email address or name. */
export const PASSWORD_IS_PERSONAL =
  'That password is your own email address or name: choose another.';

/**
 * Everything a password lacks, in words to be shown: "Use at least 12
 * characters, with a number and a symbol.", "Add an uppercase letter.";
 * with what made it too guessable after it. Empty when nothing is wrong.
 */
export function passwordRefusalWords(
  lacks: readonly PasswordLack[],
  rules: PasswordRules,
  guessable: 'common' | 'personal' | null = null,
): string {
  const mix = MIX.filter((m) => lacks.includes(m)).map((m) => MIX_WORDS[m]);
  const parts: string[] = [];
  if (lacks.includes('length')) {
    parts.push(
      `Use at least ${rules.min_length} characters${mix.length > 0 ? `, with ${list(mix)}` : ''}.`,
    );
  } else if (mix.length > 0) {
    parts.push(`Add ${list(mix)}.`);
  }
  if (guessable === 'common') parts.push(PASSWORD_TOO_COMMON);
  if (guessable === 'personal') parts.push(PASSWORD_IS_PERSONAL);
  return parts.join(' ');
}

/**
 * The rules as a vault answers them, made whole: a field that is missing or
 * wrong is the default's. An older vault answers none, and a page then says
 * the default's.
 */
export function passwordRulesOf(v: Partial<PasswordRules> | null | undefined): PasswordRules {
  const d = PASSWORD_RULES_DEFAULT;
  const bool = (x: unknown, fallback: boolean) => (typeof x === 'boolean' ? x : fallback);
  return {
    min_length: isPasswordMinLength(v?.min_length) ? v.min_length : d.min_length,
    refuse_common: bool(v?.refuse_common, d.refuse_common),
    needs_upper: bool(v?.needs_upper, d.needs_upper),
    needs_lower: bool(v?.needs_lower, d.needs_lower),
    needs_number: bool(v?.needs_number, d.needs_number),
    needs_symbol: bool(v?.needs_symbol, d.needs_symbol),
  };
}

/**
 * Whether `to` lets in a password `from` would have refused: a shorter
 * least, or a switch turned off. Saving such a change asks the owner to
 * confirm it's them first (`weaken_password_rules`).
 */
export function passwordRulesWeaker(from: PasswordRules, to: PasswordRules): boolean {
  return (
    to.min_length < from.min_length ||
    (from.refuse_common && !to.refuse_common) ||
    MIX.some((m) => asks(from, m) && !asks(to, m))
  );
}

/** The most digits and symbols, both ends together, taken off a password as decoration. */
const DECORATION_MAX = 6;

/**
 * The forms of a password a list is searched for: lower case, with no
 * spaces, and with that and a few digits and symbols at either end taken
 * away ("Dragon2024!" is "dragon"). Many more than a year and a mark —
 * "monkey 739284615023" — are a strong password's own, not decoration: that
 * one is kept whole, unless `decoration` says to take off any number (a
 * person's own name, padded out to the length). Empty forms are left out.
 */
export function passwordForms(password: string, decoration = DECORATION_MAX): string[] {
  const whole = password.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
  const core = whole.replace(/^[^\p{L}]+/u, '').replace(/[^\p{L}]+$/u, '');
  const taken = Array.from(whole).length - Array.from(core).length;
  return [...new Set(taken <= decoration ? [whole, core] : [whole])].filter((f) => f.length > 0);
}

/**
 * Whether a password is just the person's own email address or name: the
 * whole address, the part before its @, the whole name or a word of it
 * (three letters or more), however it is cased or spaced, with digits and
 * symbols at either end.
 */
export function passwordIsPersonal(
  password: string,
  who: { email?: string | null | undefined; name?: string | null | undefined },
): boolean {
  const own = new Set<string>();
  const add = (s: string | null | undefined) => {
    for (const f of s ? passwordForms(s, Infinity) : []) if (Array.from(f).length >= 3) own.add(f);
  };
  if (who.email) {
    add(who.email);
    add(who.email.split('@')[0]);
  }
  if (who.name) {
    add(who.name);
    for (const word of who.name.split(/[\s\-'’.]+/u)) add(word);
  }
  return passwordForms(password, Infinity).some((f) => own.has(f));
}
