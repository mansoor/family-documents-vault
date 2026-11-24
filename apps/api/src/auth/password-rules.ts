import type { Db } from '@fdv/db';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_RULES_CODE,
  PASSWORD_RULES_DEFAULT,
  passwordForms,
  passwordIsPersonal,
  passwordLacks,
  passwordRefusalWords,
  type PasswordRules,
} from '@fdv/shared';
import { z } from 'zod';
import { ApiError } from '../errors.js';

/**
 * The household's password rules, held to wherever a sign-in password is set
 * (`features.password_rules`): a change, a reset link, an invitation
 * accepted, and setup. The length and the mix are @fdv/shared's, which a page
 * says too; whether a password is common is asked here alone, of a list the
 * vault keeps in its own dependencies: nothing is ever sent anywhere to be
 * checked.
 *
 * The list is @zxcvbn-ts/language-common's (MIT): its "passwords-common", the
 * most used of Mark Burnett's ten million passwords, released by him to the
 * public domain. Loaded the first time a password is set, and kept.
 */

/**
 * A new sign-in password as a body carries it: anything up to the longest a
 * password may be. What it must be beyond that is the household's to say
 * (`mustMeetRules`), so it is refused as `400 password_rules`, never here.
 */
export const newPasswordField = z
  .string()
  .min(1, 'Enter a password.')
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters.`);

let common: Promise<ReadonlySet<string>> | null = null;

/** The list, once. */
export function commonPasswords(): Promise<ReadonlySet<string>> {
  common ??= import('@zxcvbn-ts/language-common').then(
    (m) => new Set(m.dictionary['passwords-common'].map((p) => p.toLowerCase())),
  );
  return common;
}

/** Whether a password is in the list, as it is or with digits and symbols at either end taken off. */
export async function isCommonPassword(password: string): Promise<boolean> {
  const list = await commonPasswords();
  return passwordForms(password).some((f) => list.has(f));
}

/** The rules as the household's row keeps them. */
export interface PasswordRulesRow {
  password_min_length: number;
  password_refuse_common: boolean;
  password_needs_upper: boolean;
  password_needs_lower: boolean;
  password_needs_number: boolean;
  password_needs_symbol: boolean;
}

export const PASSWORD_RULES_COLUMNS = [
  'password_min_length',
  'password_refuse_common',
  'password_needs_upper',
  'password_needs_lower',
  'password_needs_number',
  'password_needs_symbol',
] as const;

export const rulesOfRow = (r: PasswordRulesRow): PasswordRules => ({
  min_length: r.password_min_length,
  refuse_common: r.password_refuse_common,
  needs_upper: r.password_needs_upper,
  needs_lower: r.password_needs_lower,
  needs_number: r.password_needs_number,
  needs_symbol: r.password_needs_symbol,
});

export const rowOfRules = (r: PasswordRules): PasswordRulesRow => ({
  password_min_length: r.min_length,
  password_refuse_common: r.refuse_common,
  password_needs_upper: r.needs_upper,
  password_needs_lower: r.needs_lower,
  password_needs_number: r.needs_number,
  password_needs_symbol: r.needs_symbol,
});

/**
 * A household's rules, read in the caller's transaction and scope: whoever
 * may read the household's row. None found (a household gone meanwhile), the
 * rules every household starts with.
 */
export async function householdPasswordRules(trx: Db, householdId: string): Promise<PasswordRules> {
  const row = await trx
    .selectFrom('household')
    .select([...PASSWORD_RULES_COLUMNS])
    .where('id', '=', householdId)
    .executeTakeFirst();
  return row ? rulesOfRow(row) : { ...PASSWORD_RULES_DEFAULT };
}

/**
 * Refuses a new sign-in password the rules do not let in: `400
 * password_rules`, the message naming everything that is missing, and
 * `detail` the same as words a log can count ("length,number,common").
 * `who` is the person it is for, whose own email address and name are
 * refused with the common passwords.
 */
export async function mustMeetRules(
  password: string,
  rules: PasswordRules,
  who: { email?: string | null | undefined; name?: string | null | undefined },
): Promise<void> {
  const lacks = passwordLacks(password, rules);
  const guessable = !rules.refuse_common
    ? null
    : passwordIsPersonal(password, who)
      ? ('personal' as const)
      : (await isCommonPassword(password))
        ? ('common' as const)
        : null;
  if (lacks.length === 0 && guessable === null) return;
  throw new ApiError(400, PASSWORD_RULES_CODE, passwordRefusalWords(lacks, rules, guessable), {
    detail: [...lacks, ...(guessable ? [guessable] : [])].join(','),
  });
}
