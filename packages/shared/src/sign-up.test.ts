import { describe, expect, it } from 'vitest';
import {
  birthdayAt,
  mayBeInvited,
  oldEnoughToSignIn,
  rolesForAge,
  rolesToHandOut,
  turnedThirteenWords,
} from './sign-up.js';
import { ageOn } from './suggestions.js';

describe('who may have a sign-in of their own (after 0.7.0)', () => {
  it('a 13th birthday is the first day they are 13, as ageOn counts it', () => {
    expect(birthdayAt('2013-10-12', 13)).toBe('2026-10-12');
    expect(birthdayAt(null, 13)).toBeNull();
    // 29 February: 1 March in a year without one, the day ageOn says 13.
    expect(birthdayAt('2012-02-29', 13)).toBe('2025-03-01');
    expect(ageOn('2012-02-29', '2025-02-28')).toBe(12);
    expect(ageOn('2012-02-29', '2025-03-01')).toBe(13);
    expect(birthdayAt('2012-02-29', 12)).toBe('2024-02-29');
  });

  it('13 or over, or of no known age', () => {
    expect(oldEnoughToSignIn('2013-10-12', '2026-10-11')).toBe(false);
    expect(oldEnoughToSignIn('2013-10-12', '2026-10-12')).toBe(true);
    expect(oldEnoughToSignIn(null, '2026-10-12')).toBe(true);
  });

  it('the roles an age allows, of those the inviter may hand out', () => {
    expect(rolesToHandOut('owner')).toEqual(['owner', 'adult', 'teen', 'viewer']);
    expect(rolesToHandOut('adult')).toEqual(['teen', 'viewer']);
    expect(rolesToHandOut('teen')).toEqual([]);
    expect(rolesForAge(12, rolesToHandOut('owner'))).toEqual([]);
    expect(rolesForAge(13, rolesToHandOut('owner'))).toEqual(['teen']);
    expect(rolesForAge(17, rolesToHandOut('adult'))).toEqual(['teen']);
    expect(rolesForAge(18, rolesToHandOut('owner'))).toEqual(['owner', 'adult', 'viewer']);
    expect(rolesForAge(18, rolesToHandOut('adult'))).toEqual(['viewer']);
    expect(rolesForAge(null, rolesToHandOut('adult'))).toEqual(['teen', 'viewer']);
  });

  it('who may be offered an invitation: of the family, alive, no sign-in, none waiting, 13 or over', () => {
    const today = '2026-10-12';
    const base = { id: 'm', date_of_birth: '2010-01-01', has_account: false, is_deceased: false };
    expect(mayBeInvited(base, [], today)).toBe(true);
    expect(mayBeInvited({ ...base, date_of_birth: null }, [], today)).toBe(true);
    expect(mayBeInvited({ ...base, date_of_birth: '2014-01-01' }, [], today)).toBe(false);
    expect(mayBeInvited({ ...base, has_account: true }, [], today)).toBe(false);
    expect(mayBeInvited({ ...base, sign_in_removed: true }, [], today)).toBe(false);
    expect(mayBeInvited({ ...base, is_deceased: true }, [], today)).toBe(false);
    expect(mayBeInvited({ ...base, kind: 'guest' }, [], today)).toBe(false);
    expect(mayBeInvited(base, [{ member_id: 'm', state: 'pending' }], today)).toBe(false);
    // One taken back, run out or used up is not waiting.
    for (const state of ['revoked', 'expired', 'locked', 'accepted']) {
      expect(mayBeInvited(base, [{ member_id: 'm', state }], today)).toBe(true);
    }
  });

  it('says it on the day, and as a day once it has gone', () => {
    expect(turnedThirteenWords('Sara', '2026-10-12', '2026-10-12')).toEqual({
      title: 'Sara is 13 today',
      label: 'They can now have their own sign-in.',
    });
    expect(turnedThirteenWords('Sara', '2026-10-09', '2026-10-12').title).toBe(
      'Sara turned 13 on 9 Oct',
    );
  });
});
