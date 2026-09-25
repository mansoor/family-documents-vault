import { describe, expect, it } from 'vitest';
import { mayKeepOffline } from './offline.js';

const me = 'member-me';
const other = 'member-other';
const essential = (visibility: string, owner: string | null, is_essential = true) => ({
  visibility,
  owner_member_id: owner,
  is_essential,
});

describe('what a phone may keep', () => {
  it('only Essentials', () => {
    expect(
      mayKeepOffline({ role: 'owner', memberId: me }, essential('household', other, false), true),
    ).toBe(false);
  });

  it('owners and adults: every Essential they can see, their own Only me ones only when asked', () => {
    for (const role of ['owner', 'adult'] as const) {
      const who = { role, memberId: me };
      expect(mayKeepOffline(who, essential('household', other), false)).toBe(true);
      expect(mayKeepOffline(who, essential('adults', other), false)).toBe(true);
      expect(mayKeepOffline(who, essential('private', me), false)).toBe(false);
      expect(mayKeepOffline(who, essential('private', me), true)).toBe(true);
      // Never anybody else's Only me.
      expect(mayKeepOffline(who, essential('private', other), true)).toBe(false);
    }
  });

  it('teens: only their own', () => {
    const teen = { role: 'teen' as const, memberId: me };
    expect(mayKeepOffline(teen, essential('household', me), false)).toBe(true);
    expect(mayKeepOffline(teen, essential('household', other), false)).toBe(false);
    expect(mayKeepOffline(teen, essential('adults', me), false)).toBe(false);
    expect(mayKeepOffline(teen, essential('private', me), true)).toBe(true);
  });

  it('viewers: nothing', () => {
    expect(mayKeepOffline({ role: 'viewer', memberId: me }, essential('household', me), true)).toBe(
      false,
    );
  });
});
