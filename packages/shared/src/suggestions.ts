/**
 * Missing-document suggestions (REM-10).
 *
 * A rule fires from what the family told the first-run wizard, so every
 * suggestion can be defended out loud: *you said you own your home, and
 * there is no deed here*. The condition language is deliberately tiny —
 * three shapes, evaluated here rather than in SQL, because this is the
 * part that has to be right and therefore the part that has to be read.
 */

export interface SuggestionProfile {
  owns_home: boolean | null;
  rents_home: boolean | null;
  vehicle_count: number | null;
  has_pets: boolean | null;
  has_business: boolean | null;
  country: string | null;
}

export interface SuggestionMember {
  id: string;
  display_name: string;
  date_of_birth: string | null;
  is_deceased: boolean;
}

/** `{"gte": 1}` — the only comparison a rule needs so far. */
export interface NumericTest {
  gte?: number;
  lte?: number;
}

export interface Condition {
  /** Every key must match: booleans compare exactly, numbers use NumericTest. */
  profile?: Record<string, boolean | number | NumericTest>;
  /** Facts about the person a per-member rule is considering. */
  member?: { is_minor?: boolean; is_adult?: boolean };
  /** At least one of these must match. */
  any?: Condition[];
}

/** A rule as it comes out of the database. */
export interface SuggestionRule {
  key: string;
  condition: Condition;
  suggests_type: string;
  scope: 'household' | 'per_member';
  quantity: number | { profile: string };
  noun: string;
  why: string;
  sort_order: number;
}

/** Whole years between a date of birth and a day, or null if unknown. */
export function ageOn(dateOfBirth: string | null, on: string): number | null {
  if (!dateOfBirth) return null;
  const [by, bm, bd] = dateOfBirth.split('-').map(Number);
  const [ny, nm, nd] = on.split('-').map(Number);
  if (!by || !bm || !bd || !ny || !nm || !nd) return null;
  let age = ny - by;
  if (nm < bm || (nm === bm && nd < bd)) age -= 1;
  return age;
}

function numberMatches(value: unknown, test: number | NumericTest): boolean {
  if (typeof value !== 'number') return false;
  if (typeof test === 'number') return value === test;
  if (test.gte !== undefined && value < test.gte) return false;
  if (test.lte !== undefined && value > test.lte) return false;
  return true;
}

/**
 * Unknown is not false. A family that skipped a wizard question should not
 * be told what it is missing on the strength of a guess, so a rule whose
 * condition touches an unanswered field does not fire.
 */
export function conditionHolds(
  condition: Condition,
  facts: { profile: SuggestionProfile; member?: SuggestionMember | undefined; today: string },
): boolean {
  if (condition.any) {
    if (!condition.any.some((c) => conditionHolds(c, facts))) return false;
  }
  for (const [key, test] of Object.entries(condition.profile ?? {})) {
    const value = (facts.profile as unknown as Record<string, unknown>)[key];
    if (value === null || value === undefined) return false;
    if (typeof test === 'boolean') {
      if (value !== test) return false;
    } else if (!numberMatches(value, test)) return false;
  }
  if (condition.member) {
    if (!facts.member) return false;
    const age = ageOn(facts.member.date_of_birth, facts.today);
    if (age === null) return false; // we do not guess at someone's age
    if (condition.member.is_minor !== undefined && age < 18 !== condition.member.is_minor)
      return false;
    if (condition.member.is_adult !== undefined && age >= 18 !== condition.member.is_adult)
      return false;
  }
  return true;
}

/** How many of the type this household should have. */
export function wantedCount(rule: SuggestionRule, profile: SuggestionProfile): number {
  const q = rule.quantity;
  if (typeof q === 'number') return q;
  const value = (profile as unknown as Record<string, unknown>)[q.profile];
  return typeof value === 'number' ? value : 0;
}

/**
 * The headline, written the way a person would say it. "No birth
 * certificate for Aisha", and — when the family said two cars and filed
 * one registration — "One more vehicle registration to add".
 */
export function suggestionTitle(
  rule: SuggestionRule,
  missing: number,
  have: number,
  memberName?: string | null,
): string {
  if (memberName) return `No ${rule.noun} for ${memberName}`;
  if (have === 0) return `No ${rule.noun}${missing > 1 ? 's' : ''} on file`;
  if (missing === 1) return `One more ${rule.noun} to add`;
  return `${missing} more ${rule.noun}s to add`;
}

export interface SuggestionView {
  /** Stable across reloads: the rule, plus the person for per-member rules. */
  key: string;
  rule_key: string;
  member_id: string | null;
  member_name: string | null;
  type_key: string;
  type_label: string;
  title: string;
  why: string;
  missing: number;
  dismissed: boolean;
}

export function suggestionKey(ruleKey: string, memberId: string | null): string {
  return memberId ? `${ruleKey}:${memberId}` : ruleKey;
}
