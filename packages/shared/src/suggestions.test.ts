import { describe, expect, it } from 'vitest';
import {
  ageOn,
  conditionHolds,
  suggestionTitle,
  wantedCount,
  type SuggestionProfile,
  type SuggestionRule,
} from './suggestions.js';

const blank: SuggestionProfile = {
  owns_home: null,
  rents_home: null,
  vehicle_count: null,
  has_pets: null,
  has_business: null,
  country: null,
};
const TODAY = '2026-09-22';

const member = (dob: string | null) => ({
  id: 'm1',
  display_name: 'Aisha',
  date_of_birth: dob,
  is_deceased: false,
});

describe('ageOn', () => {
  it('counts whole years, and the birthday itself counts', () => {
    expect(ageOn('2000-09-22', TODAY)).toBe(26);
    expect(ageOn('2000-09-23', TODAY)).toBe(25);
    expect(ageOn('2000-12-31', TODAY)).toBe(25);
    expect(ageOn(null, TODAY)).toBeNull();
  });
});

describe('conditionHolds', () => {
  it('an empty condition is always true', () => {
    expect(conditionHolds({}, { profile: blank, today: TODAY })).toBe(true);
  });

  it('a boolean answer must match exactly', () => {
    const c = { profile: { owns_home: true } };
    expect(conditionHolds(c, { profile: { ...blank, owns_home: true }, today: TODAY })).toBe(true);
    expect(conditionHolds(c, { profile: { ...blank, owns_home: false }, today: TODAY })).toBe(
      false,
    );
  });

  it('an unanswered question does not fire a rule', () => {
    // The family skipped the question; we do not tell them what they are
    // missing on the strength of a guess.
    expect(conditionHolds({ profile: { owns_home: true } }, { profile: blank, today: TODAY })).toBe(
      false,
    );
    expect(
      conditionHolds({ profile: { vehicle_count: { gte: 1 } } }, { profile: blank, today: TODAY }),
    ).toBe(false);
  });

  it('numbers compare with gte and lte', () => {
    const c = { profile: { vehicle_count: { gte: 1 } } };
    expect(conditionHolds(c, { profile: { ...blank, vehicle_count: 2 }, today: TODAY })).toBe(true);
    expect(conditionHolds(c, { profile: { ...blank, vehicle_count: 0 }, today: TODAY })).toBe(
      false,
    );
    expect(
      conditionHolds(
        { profile: { vehicle_count: { lte: 1 } } },
        { profile: { ...blank, vehicle_count: 2 }, today: TODAY },
      ),
    ).toBe(false);
  });

  it('any is satisfied by one branch', () => {
    const c = {
      any: [{ profile: { owns_home: true } }, { profile: { rents_home: true } }],
    };
    expect(conditionHolds(c, { profile: { ...blank, rents_home: true }, today: TODAY })).toBe(true);
    expect(
      conditionHolds(c, {
        profile: { ...blank, owns_home: false, rents_home: false },
        today: TODAY,
      }),
    ).toBe(false);
  });

  it('a per-member rule needs a known date of birth', () => {
    const c = { member: { is_minor: true } };
    const facts = (dob: string | null) => ({ profile: blank, member: member(dob), today: TODAY });
    expect(conditionHolds(c, facts('2015-01-01'))).toBe(true);
    expect(conditionHolds(c, facts('1990-01-01'))).toBe(false);
    // Unknown age: no suggestion rather than a wrong one.
    expect(conditionHolds(c, facts(null))).toBe(false);
    expect(conditionHolds(c, { profile: blank, today: TODAY })).toBe(false);
    // The day before an eighteenth birthday is still a minor.
    expect(conditionHolds(c, facts('2008-09-23'))).toBe(true);
    expect(conditionHolds(c, facts('2008-09-22'))).toBe(false);
    expect(conditionHolds({ member: { is_adult: true } }, facts('2008-09-22'))).toBe(true);
  });
});

describe('wantedCount', () => {
  const rule = (quantity: SuggestionRule['quantity']): SuggestionRule => ({
    key: 'r',
    condition: {},
    suggests_type: 'vehicle_registration',
    scope: 'household',
    quantity,
    noun: 'vehicle registration',
    why: '',
    sort_order: 1,
  });

  it('is a fixed number, or comes from the profile', () => {
    expect(wantedCount(rule(1), blank)).toBe(1);
    expect(wantedCount(rule({ profile: 'vehicle_count' }), { ...blank, vehicle_count: 3 })).toBe(3);
    expect(wantedCount(rule({ profile: 'vehicle_count' }), blank)).toBe(0);
  });
});

describe('suggestionTitle', () => {
  const rule = { noun: 'birth certificate' } as SuggestionRule;
  const cars = { noun: 'vehicle registration' } as SuggestionRule;

  it('names the person, or says how many are still missing', () => {
    expect(suggestionTitle(rule, 1, 0, 'Aisha')).toBe('No birth certificate for Aisha');
    expect(suggestionTitle(cars, 1, 0)).toBe('No vehicle registration on file');
    expect(suggestionTitle(cars, 2, 0)).toBe('No vehicle registrations on file');
    // Two cars, one registration filed: the wording admits what is there.
    expect(suggestionTitle(cars, 1, 1)).toBe('One more vehicle registration to add');
    expect(suggestionTitle(cars, 2, 1)).toBe('2 more vehicle registrations to add');
  });
});
