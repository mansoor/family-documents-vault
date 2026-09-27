import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  can,
  canChangePerson,
  canChangePhoto,
  canRemovePhoto,
  canSee,
  canSeeCollection,
  capabilitiesFor,
  capabilityToInvite,
  COLLECTION_AUDIENCES,
  COLLECTION_HINT_PRIVATE,
  COLLECTION_HINT_SOME,
  COLLECTION_HINT_TEENS,
  collectionItemHint,
  inCollectionAudience,
  mayChangeVisibilityAtAll,
  PHOTO_REFUSAL,
  PRIVATE_OWNER_ONLY,
  refusalFor,
  ROLES,
  rolesWith,
  TEEN_NOT_ADULTS_ONLY,
  visibilityChoices,
  visibilityRefusal,
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
      'types.widen_visibility',
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

describe('who sees a collection (5.14)', () => {
  const me = 'member-me';
  const collection = (audience: string, owner: string | null = 'someone-else') => ({
    audience,
    owner_member_id: owner,
  });

  it('everyone is the family that files; the adults are the adults; Only me is its maker', () => {
    const who = (l: ReturnType<typeof collection>) =>
      ROLES.filter((role) => canSeeCollection({ role, memberId: me }, l));
    expect(who(collection('everyone'))).toEqual(['owner', 'adult', 'teen']);
    expect(who(collection('teens'))).toEqual(['owner', 'adult', 'teen']);
    expect(who(collection('adults'))).toEqual(['owner', 'adult']);
    expect(who(collection('only_me'))).toEqual([]);
    // Its maker, whatever their role now.
    expect(who(collection('only_me', me))).toEqual(['owner', 'adult', 'teen', 'viewer']);
  });

  it('a viewer sees no collection, not even one made for everyone (A17)', () => {
    for (const audience of COLLECTION_AUDIENCES) {
      expect(
        canSeeCollection({ role: 'viewer', memberId: me }, collection(audience)),
        audience,
      ).toBe(false);
    }
  });

  it('its maker still sees a collection outside its audience now, and nobody else does (the 5.14 review)', () => {
    // An adult made a teen, or a viewer: the collection they made for the adults
    // is theirs to see (and delete), and still nobody else's outside it.
    for (const role of ['teen', 'viewer'] as const) {
      for (const audience of COLLECTION_AUDIENCES) {
        expect(
          canSeeCollection({ role, memberId: me }, collection(audience, me)),
          `${role} ${audience}`,
        ).toBe(true);
      }
      expect(canSeeCollection({ role, memberId: me }, collection('adults'))).toBe(false);
      expect(inCollectionAudience(role, 'adults')).toBe(false);
    }
    // Nobody is the maker of a collection whose maker is gone.
    expect(canSeeCollection({ role: 'owner', memberId: null }, collection('adults', null))).toBe(
      true,
    );
    expect(canSeeCollection({ role: 'teen', memberId: null }, collection('adults', null))).toBe(
      false,
    );
  });

  it('an audience never heard of, or nobody at all, is closed', () => {
    for (const audience of ['public', 'constructor', '__proto__', '']) {
      expect(
        canSeeCollection({ role: 'owner', memberId: me }, collection(audience, me)),
        audience,
      ).toBe(false);
      expect(inCollectionAudience('owner', audience), audience).toBe(false);
    }
    // Nobody without a member matches an Only me collection with no maker.
    expect(canSeeCollection({ role: 'owner', memberId: null }, collection('only_me', null))).toBe(
      false,
    );
  });

  it("tells a collection's maker who of its audience is not given a document in it", () => {
    const doc = (visibility: string) => ({ visibility, owner_member_id: me });
    expect(collectionItemHint('everyone', doc('household'))).toBeNull();
    expect(collectionItemHint('everyone', doc('adults'))).toBe(COLLECTION_HINT_TEENS);
    expect(collectionItemHint('teens', doc('adults'))).toBe(COLLECTION_HINT_TEENS);
    expect(collectionItemHint('adults', doc('adults'))).toBeNull();
    expect(collectionItemHint('everyone', doc('private'))).toBe(COLLECTION_HINT_PRIVATE);
    expect(collectionItemHint('adults', doc('private'))).toBe(COLLECTION_HINT_PRIVATE);
    // Only me is for its maker alone: there is nobody else to tell.
    for (const visibility of ['household', 'adults', 'private']) {
      expect(collectionItemHint('only_me', doc(visibility)), visibility).toBeNull();
    }
    // A visibility never heard of is shut to everybody.
    expect(collectionItemHint('adults', doc('sealed'))).toBe(COLLECTION_HINT_SOME);
  });
});

describe("who may change a person's photo (A66)", () => {
  const me = 'member-me';
  const signedIn = { id: 'someone-signed-in', role: 'adult' as const };
  const noSignIn = { id: 'a-child', role: null };

  it('who may change whose photo', () => {
    // Every role against themselves, somebody with a sign-in and somebody without.
    const table = ROLES.map((role) => {
      const viewer = { role, memberId: me };
      return [
        role,
        canChangePhoto(viewer, { id: me, role }),
        canChangePhoto(viewer, signedIn),
        canChangePhoto(viewer, noSignIn),
      ];
    });
    expect(table).toEqual([
      ['owner', true, true, true],
      ['adult', true, false, true],
      ['teen', true, false, false],
      ['viewer', false, false, false],
    ]);
    // The rule for details (5.25) names the same people.
    expect(canChangePerson({ role: 'adult', memberId: me }, noSignIn)).toBe(true);
    expect(canChangePerson({ role: 'viewer', memberId: me }, { id: me, role: 'viewer' })).toBe(
      false,
    );
    // Nobody without a member is anybody's self.
    expect(canChangePhoto({ role: 'teen', memberId: null }, { id: me, role: 'teen' })).toBe(false);
  });

  it('anybody may take a photo of themselves away; nobody else but who may change it', () => {
    for (const role of ROLES) {
      expect(canRemovePhoto({ role, memberId: me }, { id: me, role }), role).toBe(true);
    }
    expect(canRemovePhoto({ role: 'viewer', memberId: me }, noSignIn)).toBe(false);
    expect(canRemovePhoto({ role: 'teen', memberId: me }, noSignIn)).toBe(false);
    expect(canRemovePhoto({ role: 'adult', memberId: me }, noSignIn)).toBe(true);
    expect(canRemovePhoto({ role: 'adult', memberId: me }, signedIn)).toBe(false);
  });

  it('says who may, and a viewer why not', () => {
    expect(rolesWith('member.photo')).toEqual(['owner', 'adult', 'teen']);
    expect(refusalFor('member.photo')).toBe(
      'Viewers can open and download documents, but not add photos.',
    );
    expect(PHOTO_REFUSAL).toBe(
      'Only an owner or the person themselves can change this photo. For someone without a sign-in, any adult can.',
    );
  });
});

describe('who may change who sees a document (A72, 5.17c)', () => {
  const V = ['household', 'adults', 'private'] as const;
  it('a teen: their own, between Only me and Everyone, and nothing else', () => {
    expect(visibilityRefusal('teen', true, 'private', 'household')).toBeNull();
    expect(visibilityRefusal('teen', true, 'household', 'private')).toBeNull();
    expect(visibilityRefusal('teen', true, 'household', 'adults')).toBe(TEEN_NOT_ADULTS_ONLY);
    expect(visibilityRefusal('teen', true, 'private', 'adults')).toBe(TEEN_NOT_ADULTS_ONLY);
    for (const from of V) {
      for (const to of V) {
        expect(visibilityRefusal('teen', false, from, to)).toBe(refusalFor('document.visibility'));
      }
    }
    expect(mayChangeVisibilityAtAll('teen')).toBe(true);
  });

  it('owners and adults as before; viewers never', () => {
    for (const role of ['owner', 'adult'] as const) {
      expect(visibilityRefusal(role, false, 'household', 'adults')).toBeNull();
      expect(visibilityRefusal(role, false, 'adults', 'household')).toBeNull();
      expect(visibilityRefusal(role, false, 'household', 'private')).toBe(PRIVATE_OWNER_ONLY);
      expect(visibilityRefusal(role, false, 'private', 'household')).toBe(PRIVATE_OWNER_ONLY);
      for (const from of V)
        for (const to of V) expect(visibilityRefusal(role, true, from, to)).toBeNull();
    }
    for (const from of V) {
      for (const to of V) {
        expect(visibilityRefusal('viewer', true, from, to)).toBe(refusalFor('document.visibility'));
      }
    }
    expect(mayChangeVisibilityAtAll('viewer')).toBe(false);
    // The matrix itself is unchanged: the teen's right lives with the document.
    expect(can('teen', 'document.visibility')).toBe(false);
  });

  it('what a screen offers is what would not be refused, or nothing', () => {
    expect(visibilityChoices('teen', true, 'private')).toEqual(['household', 'private']);
    expect(visibilityChoices('teen', false, 'household')).toEqual([]);
    expect(visibilityChoices('owner', false, 'household')).toEqual(['household', 'adults']);
    expect(visibilityChoices('owner', false, 'private')).toEqual([]);
    expect(visibilityChoices('adult', true, 'private')).toEqual(['household', 'adults', 'private']);
    expect(visibilityChoices('viewer', true, 'household')).toEqual([]);
  });
});
