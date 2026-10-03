import { describe, expect, it } from 'vitest';
import {
  IDENTITY_AUDIENCES,
  IDENTITY_FIELDS,
  identityAudienceRank,
  identityChanges,
  identityFilled,
  identityMaskedKeys,
  identityTooLong,
  IDENTITY_MAX_BYTES,
  maskIdentity,
  mergeIdentityWrite,
  revealIdentity,
  type IdentityFields,
} from './identity.js';
import {
  canEditIdentity,
  canSeeIdentity,
  identityAudienceSees,
  ROLES,
  type Role,
} from './roles.js';

const record: IdentityFields = {
  given_name: 'Sara',
  family_name: '  ',
  nationalities: ['GB'],
  emails: [{ id: 'e1', value: 'sara@example.test' }],
  addresses: [{ id: 'a1', label: 'Home' }],
  ids: [
    { id: 'p1', kind: 'passport', number: 'P-123', document_id: 'doc-1' },
    { id: 'n1', kind: 'other', label: 'Library card' },
  ],
  custom: [
    { id: 'c1', label: 'Locker', value: '4471', hidden: true },
    { id: 'c2', label: 'Shoe size', value: '6', hidden: false },
    { id: 'c3', label: 'Empty secret', value: '', hidden: true },
  ],
};

describe('identity details: what a reader is shown (5.26)', () => {
  it('masks every ID number and every hidden custom field with a value, and names them', () => {
    expect(identityMaskedKeys(record)).toEqual(['ids.p1', 'custom.c1']);
    const { fields, masked } = maskIdentity(record);
    expect(masked).toEqual(['ids.p1', 'custom.c1']);
    // Left out, not null: what is sent back left out is kept (the 5.26 review).
    expect(fields.ids).toEqual([
      { id: 'p1', kind: 'passport', document_id: 'doc-1' },
      { id: 'n1', kind: 'other', label: 'Library card' },
    ]);
    expect(fields.ids?.[0]).not.toHaveProperty('number');
    expect(fields.custom).toEqual([
      { id: 'c1', label: 'Locker', hidden: true },
      { id: 'c2', label: 'Shoe size', value: '6', hidden: false },
      { id: 'c3', label: 'Empty secret', value: '', hidden: true },
    ]);
    expect(JSON.stringify(fields)).not.toMatch(/P-123|4471/);
    // The record itself is untouched.
    expect(record.ids?.[0]?.number).toBe('P-123');
  });

  it('what a reader was shown, sent back as it was, changes nothing and keeps every masked value', () => {
    const { fields } = maskIdentity(record);
    const back = mergeIdentityWrite(record, fields, () => false);
    expect(identityChanges(record, back)).toEqual([]);
    expect(revealIdentity(back, ['ids.p1', 'custom.c1'])).toEqual({
      'ids.p1': 'P-123',
      'custom.c1': '4471',
    });
  });

  it('a hidden field whose value a write leaves out stays hidden, whatever the write says', () => {
    // Unhiding it would hand the writer a value they were never shown.
    const unhidden = mergeIdentityWrite(
      record,
      { custom: [{ id: 'c1', label: 'Locker', hidden: false }] },
      () => false,
    );
    expect(unhidden.custom).toEqual([{ id: 'c1', label: 'Locker', hidden: true, value: '4471' }]);
    expect(maskIdentity(unhidden).masked).toEqual(['custom.c1']);
    expect(JSON.stringify(maskIdentity(unhidden).fields)).not.toContain('4471');
    // With a value of its own, the write says what it likes: it knows it.
    const rewritten = mergeIdentityWrite(
      record,
      { custom: [{ id: 'c1', label: 'Locker', value: '9999', hidden: false }] },
      () => false,
    );
    expect(rewritten.custom).toEqual([{ id: 'c1', label: 'Locker', value: '9999', hidden: false }]);
    // An entry never hidden may be hidden, its value kept.
    const hidden = mergeIdentityWrite(
      record,
      { custom: [{ id: 'c2', label: 'Shoe size', hidden: true }] },
      () => false,
    );
    expect(hidden.custom).toEqual([{ id: 'c2', label: 'Shoe size', hidden: true, value: '6' }]);
  });

  it('a part too big to keep is said to be, by its bytes as sealed', () => {
    const many = (n: number, value: string) => ({
      custom: Array.from({ length: n }, (_, i) => ({ id: `c${i}`, label: 'x', value })),
    });
    expect(identityTooLong(many(40, 'ب'.repeat(2000)))).toBe(true);
    expect(identityTooLong(many(11, '\u0001'.repeat(2000)))).toBe(true);
    expect(identityTooLong(many(30, 'b'.repeat(2000)))).toBe(false);
    expect(IDENTITY_MAX_BYTES).toBe(131_072);
  });

  it('reveals only what is masked and asked for', () => {
    expect(
      revealIdentity(record, ['ids.p1', 'custom.c1', 'custom.c2', 'ids.n1', 'given_name', 'x']),
    ).toEqual({
      'ids.p1': 'P-123',
      'custom.c1': '4471',
    });
  });

  it('says what has a value by key, never a value', () => {
    expect(identityFilled(record)).toEqual([
      'given_name',
      'nationalities',
      'emails.e1',
      'ids.p1',
      'custom.c1',
      'custom.c2',
    ]);
  });

  it('a change names the fields and entries that moved, and blank is none', () => {
    expect(identityChanges(record, record)).toEqual([]);
    expect(identityChanges(record, { ...record, family_name: null, middle_name: '' })).toEqual([]);
    expect(
      identityChanges(record, {
        ...record,
        given_name: 'Sarah',
        ids: [{ id: 'p1', kind: 'passport', number: 'P-999', document_id: 'doc-1' }],
      }).sort(),
    ).toEqual(['given_name', 'ids.n1', 'ids.p1']);
    // An entry's keys in another order, or a blank one added, is no change.
    expect(
      identityChanges(
        { ids: [{ id: 'p1', kind: 'passport', number: 'P' }] },
        { ids: [{ number: 'P', kind: 'passport', id: 'p1', document_id: null }] },
      ),
    ).toEqual([]);
  });

  it('a write keeps what the writer was shown masked, or may not see', () => {
    const merged = mergeIdentityWrite(
      record,
      {
        given_name: 'Sara',
        ids: [
          { id: 'p1', kind: 'passport' },
          { id: 'n1', kind: 'other', number: null },
        ],
        custom: [
          { id: 'c1', label: 'Locker', hidden: true },
          { id: 'c2', label: 'Shoe size', value: null },
        ],
      },
      () => false,
    );
    // Left out: kept. Sent as null: cleared. A link the writer may not see: kept.
    expect(merged.ids).toEqual([
      { id: 'p1', kind: 'passport', number: 'P-123', document_id: 'doc-1' },
      { id: 'n1', kind: 'other', number: null },
    ]);
    expect(merged.custom?.map((c) => c.value)).toEqual(['4471', null]);
    // A link the writer may see is theirs to clear, and kept when left out.
    const cleared = mergeIdentityWrite(
      record,
      { ids: [{ id: 'p1', kind: 'passport', document_id: null }] },
      () => true,
    );
    expect(cleared.ids?.[0]?.document_id).toBeNull();
    const kept = mergeIdentityWrite(record, { ids: [{ id: 'p1', kind: 'passport' }] }, () => true);
    expect(kept.ids?.[0]?.document_id).toBe('doc-1');
    // An entry left out is gone, and a new one keeps nothing of another's.
    expect(
      mergeIdentityWrite(record, { ids: [{ id: 'z9', kind: 'passport' }] }, () => false).ids,
    ).toEqual([{ id: 'z9', kind: 'passport' }]);
  });

  it('the catalogue is the Bitwarden identity set, with custom fields and notes, and no health details (A35)', () => {
    const keys = IDENTITY_FIELDS.map((f) => f.key);
    for (const k of [
      'title',
      'given_name',
      'middle_name',
      'family_name',
      'username',
      'company',
      'emails',
      'phones',
      'addresses',
      'ids',
      'custom',
      'notes',
    ]) {
      expect(keys, k).toContain(k);
    }
    expect(keys.join(' ')).not.toMatch(/blood|allerg/);
  });
});

describe('who sees whose identity details (5.26, A33, A34)', () => {
  const sara = { id: 'sara' };
  const asRole = (role: Role, memberId = `${role}-member`) => ({ role, memberId });

  it('the person themselves: always, both parts, whatever the audience', () => {
    for (const role of ROLES) {
      for (const aud of IDENTITY_AUDIENCES) {
        expect(canSeeIdentity(asRole(role, 'sara'), sara, aud, 'shared')).toBe(true);
        expect(canSeeIdentity(asRole(role, 'sara'), sara, aud, 'only_me')).toBe(true);
      }
    }
  });

  it("owners: every shared part, never another person's Only me (A33)", () => {
    for (const aud of IDENTITY_AUDIENCES) {
      expect(canSeeIdentity(asRole('owner'), sara, aud)).toBe(true);
      expect(canSeeIdentity(asRole('owner'), sara, aud, 'only_me')).toBe(false);
    }
  });

  it('adults widen to `adults`, teens to `family`; viewers only their own', () => {
    const table = ROLES.map((role) =>
      IDENTITY_AUDIENCES.map((aud) => canSeeIdentity(asRole(role), sara, aud)),
    );
    expect(table).toEqual([
      [true, true, true],
      [false, true, true],
      [false, false, true],
      [false, false, false],
    ]);
    for (const role of ROLES)
      expect(canSeeIdentity(asRole(role), sara, 'family', 'only_me')).toBe(false);
    // An audience or a role never heard of is nobody's.
    expect(identityAudienceSees('everyone', 'owner')).toBe(false);
    expect(identityAudienceSees('family', 'guest' as Role)).toBe(false);
    expect(identityAudienceRank('everyone')).toBeLessThan(identityAudienceRank('owners_and_self'));
    expect(IDENTITY_AUDIENCES.map(identityAudienceRank)).toEqual([0, 1, 2]);
  });

  it('the person writes both parts (not a viewer); an owner the shared part of anybody', () => {
    expect(canEditIdentity(asRole('adult', 'sara'), sara, 'only_me')).toBe(true);
    expect(canEditIdentity(asRole('teen', 'sara'), sara, 'only_me')).toBe(true);
    expect(canEditIdentity(asRole('viewer', 'sara'), sara, 'shared')).toBe(false);
    expect(canEditIdentity(asRole('owner'), sara, 'shared')).toBe(true);
    expect(canEditIdentity(asRole('owner'), sara, 'only_me')).toBe(false);
    expect(canEditIdentity(asRole('adult'), sara, 'shared')).toBe(false);
    expect(canEditIdentity({ role: 'owner', memberId: null }, sara, 'only_me')).toBe(false);
  });
});
