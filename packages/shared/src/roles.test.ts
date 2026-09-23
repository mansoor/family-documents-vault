import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  can,
  canSee,
  capabilitiesFor,
  capabilityToInvite,
  refusalFor,
  ROLES,
  rolesWith,
  type Capability,
} from './roles.js';

describe('the role matrix', () => {
  it('an owner can do everything there is', () => {
    expect(capabilitiesFor('owner')).toEqual(CAPABILITIES);
  });

  it('a viewer changes nothing', () => {
    const allowed = capabilitiesFor('viewer');
    expect(allowed).toEqual([]);
  });

  it('is a ladder: anything a teen may do, an adult and an owner may do too', () => {
    for (const c of CAPABILITIES) {
      if (can('viewer', c)) expect(can('teen', c), c).toBe(true);
      if (can('teen', c)) expect(can('adult', c), c).toBe(true);
      if (can('adult', c)) expect(can('owner', c), c).toBe(true);
    }
  });

  it('the things the design reserves for an owner are reserved', () => {
    for (const c of [
      'storage.manage',
      'member.remove',
      'role.change',
      'notifications.manage',
      'member.invite_adult',
    ] as Capability[]) {
      expect(rolesWith(c), c).toEqual(['owner']);
    }
  });

  it('a teen keeps the two things the design gives them', () => {
    // "See and add documents where they are the owner, plus Household-visible
    // items" — adding is here; the ownership half is enforced per document.
    expect(can('teen', 'document.add')).toBe(true);
    expect(can('teen', 'document.see_adults')).toBe(false);
  });

  it('every refusal says who can do it instead, and is a sentence', () => {
    for (const c of CAPABILITIES) {
      const refusal = refusalFor(c);
      expect(refusal, c).toMatch(/^[A-Z].*\.$/);
      expect(refusal.length, c).toBeLessThan(120);
    }
  });

  it('handing out adult access is a different permission from handing out a sign-in', () => {
    expect(capabilityToInvite('adult')).toBe('member.invite_adult');
    expect(capabilityToInvite('owner')).toBe('member.invite_adult');
    expect(capabilityToInvite('teen')).toBe('member.invite');
    expect(capabilityToInvite('viewer')).toBe('member.invite');
    // An adult can give their child a sign-in but cannot widen the circle
    // of people who see the adults-only documents.
    expect(can('adult', 'member.invite')).toBe(true);
    expect(can('adult', 'member.invite_adult')).toBe(false);
  });

  it('every role is covered by every capability, one way or the other', () => {
    for (const r of ROLES) for (const c of CAPABILITIES) expect(typeof can(r, c)).toBe('boolean');
  });

  it('who may see a document: everyone, the adults, or only its owner', () => {
    const me = 'member-me';
    const doc = (visibility: string, owner: string | null = me) => ({
      visibility,
      owner_member_id: owner,
    });
    for (const role of ROLES) {
      expect(canSee({ role, memberId: me }, doc('household', 'someone-else')), role).toBe(true);
      expect(canSee({ role, memberId: me }, doc('private')), role).toBe(true);
      expect(canSee({ role, memberId: me }, doc('private', 'someone-else')), role).toBe(false);
      expect(canSee({ role, memberId: me }, doc('adults')), role).toBe(
        role === 'owner' || role === 'adult',
      );
    }
    // Being an owner opens nothing private that belongs to somebody else.
    expect(canSee({ role: 'owner', memberId: me }, doc('private', 'spouse'))).toBe(false);
    // Nobody without a member matches a private document with no owner.
    expect(canSee({ role: 'owner', memberId: null }, doc('private', null))).toBe(false);
    // A value this code has never heard of is closed, not open.
    expect(canSee({ role: 'owner', memberId: me }, doc('sealed'))).toBe(false);
  });
});
