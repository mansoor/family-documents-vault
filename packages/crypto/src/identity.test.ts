import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { identityBinding, openIdentity, sealIdentity, type IdentityRef } from './identity.js';
import { newKey } from './wrap.js';

describe("a person's identity details, sealed (5.26)", () => {
  const household = randomUUID();
  const sara: IdentityRef = { householdId: household, memberId: randomUUID(), part: 'shared' };
  const aisha: IdentityRef = { ...sara, memberId: randomUUID() };
  const scopeKey = newKey();
  const fields = { given_name: 'Sara', ids: [{ id: 'p1', kind: 'passport', number: '123456789' }] };

  it('open again as they were, for the same person and part, under the same key', () => {
    const sealed = sealIdentity(scopeKey, sara, fields);
    expect(openIdentity(scopeKey, sara, sealed)).toEqual(fields);
    // Nothing of them is readable in what is kept.
    expect(sealed.sealed.includes(Buffer.from('123456789'))).toBe(false);
    expect(sealed.sealed.includes(Buffer.from('Sara'))).toBe(false);
    // A fresh data key every time: the same fields seal differently.
    const again = sealIdentity(scopeKey, sara, fields);
    expect(again.dek_wrapped.equals(sealed.dek_wrapped)).toBe(false);
    expect(again.sealed.equals(sealed.sealed)).toBe(false);
  });

  it('a record sealed for one person cannot be opened as another (AAD)', () => {
    const sealed = sealIdentity(scopeKey, sara, fields);
    // Another person, the other part, another household, another key.
    expect(() => openIdentity(scopeKey, aisha, sealed)).toThrow();
    expect(() => openIdentity(scopeKey, { ...sara, part: 'only_me' }, sealed)).toThrow();
    expect(() => openIdentity(scopeKey, { ...sara, householdId: randomUUID() }, sealed)).toThrow();
    expect(() => openIdentity(newKey(), sara, sealed)).toThrow();
    // Nor half of one with half of another: Sara's value under Aisha's data key.
    const theirs = sealIdentity(scopeKey, aisha, fields);
    expect(() =>
      openIdentity(scopeKey, aisha, { sealed: sealed.sealed, dek_wrapped: theirs.dek_wrapped }),
    ).toThrow();
    expect(identityBinding(sara)).toBe(`identity:${household}:${sara.memberId}:shared`);
  });

  it('a byte changed does not open', () => {
    const sealed = sealIdentity(scopeKey, sara, fields);
    const bent = Buffer.from(sealed.sealed);
    bent[20] = (bent[20] ?? 0) ^ 1;
    expect(() => openIdentity(scopeKey, sara, { ...sealed, sealed: bent })).toThrow();
  });
});
