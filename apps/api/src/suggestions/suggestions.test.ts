import { withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { SuggestionView } from '@fdv/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * The "missing documents" feature, which is the one that has to be right:
 * a suggestion nobody asked for is worse than no suggestion at all.
 */
describe.skipIf(!testAdminUrl())('suggestions', () => {
  let h: Harness;
  let owner: Tokens;
  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();
  });
  afterAll(() => h.close());

  const json = <T>(r: { json: () => unknown }) => r.json() as T;
  const list = async (query = '') =>
    json<{ items: SuggestionView[]; profile_answered: boolean; dismissed_count: number }>(
      await h.app.inject({ url: `/api/v1/suggestions${query}`, headers: h.as(owner) }),
    );
  const titles = async () => (await list()).items.map((i) => i.title);

  const answer = (body: Record<string, unknown>) =>
    h.app.inject({
      method: 'PUT',
      url: '/api/v1/profile',
      headers: h.as(owner),
      payload: body,
    });

  const addMember = async (display_name: string, date_of_birth: string | null) =>
    json<{ id: string }>(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/members',
        headers: h.as(owner),
        payload: { display_name, date_of_birth },
      }),
    ).id;

  /** A filed document, without going through capture and OCR. */
  const file = async (typeKey: string, ownerMemberId: string, visibility = 'household') =>
    withSystem(h.db, owner.household_id, (trx) =>
      trx
        .insertInto('document')
        .values({
          household_id: owner.household_id,
          title: `A ${typeKey}`,
          type_key: typeKey,
          owner_member_id: ownerMemberId,
          visibility: visibility as 'household',
        })
        .execute(),
    );

  it('before the questions are answered, only what is true of every family', async () => {
    const before = await list();
    expect(before.profile_answered).toBe(false);
    // Nothing is assumed about a home, a car or a business we were not told about.
    expect(before.items.map((i) => i.rule_key)).toEqual(['household_needs_will']);
    expect(before.items[0]?.title).toBe('No will or power of attorney on file');
    expect(before.items[0]?.why).toMatch(/simple one/);
  });

  it('answering the wizard turns the answers into suggestions', async () => {
    expect(
      (await answer({ owns_home: true, rents_home: false, vehicle_count: 2 })).statusCode,
    ).toBe(200);
    const after = await list();
    expect(after.profile_answered).toBe(true);
    expect(after.items.map((i) => i.rule_key)).toEqual([
      'vehicle_needs_registration',
      'home_owner_needs_deed',
      'home_needs_insurance',
      'household_needs_will',
    ]);
    // Renting was answered "no", so the lease rule stays quiet.
    expect(await titles()).toContain('No vehicle registrations on file');
    expect(await titles()).not.toContain('No lease on file');
  });

  it('what is already filed counts, and the wording admits it', async () => {
    const me = json<{ items: Array<{ id: string; is_me: boolean }> }>(
      await h.app.inject({ url: '/api/v1/members', headers: h.as(owner) }),
    ).items.find((m) => m.is_me)!.id;

    await file('vehicle_registration', me);
    expect(await titles()).toContain('One more vehicle registration to add');
    await file('vehicle_registration', me);
    // Two cars, two registrations: the suggestion goes away by itself.
    expect((await list()).items.map((i) => i.rule_key)).not.toContain('vehicle_needs_registration');
  });

  it('a child gets a birth-certificate suggestion; someone whose age we do not know does not', async () => {
    const child = await addMember('Aisha', '2016-04-02');
    await addMember('Sam', null);
    const items = (await list()).items;
    const forChild = items.filter((i) => i.rule_key === 'minor_needs_birth_certificate');
    expect(forChild).toHaveLength(1);
    expect(forChild[0]).toMatchObject({
      title: 'No birth certificate for Aisha',
      member_id: child,
      member_name: 'Aisha',
      type_key: 'birth_certificate',
      missing: 1,
    });
    expect(forChild[0]?.key).toBe(`minor_needs_birth_certificate:${child}`);

    // File it and the suggestion is satisfied for that child only.
    await file('birth_certificate', child);
    expect((await list()).items.map((i) => i.rule_key)).not.toContain(
      'minor_needs_birth_certificate',
    );
  });

  it('someone else’s private document does not silently satisfy a rule', async () => {
    // A will nobody but its owner can see must not make the suggestion
    // vanish for everyone else: absence would reveal what is there.
    const other = await addMember('Private person', '1980-01-01');
    await file('will', other, 'private');
    expect(await titles()).toContain('No will or power of attorney on file');
  });

  it('a suggestion can be waved away and brought back', async () => {
    const dismissed = await h.app.inject({
      method: 'POST',
      url: '/api/v1/suggestions/household_needs_will/dismiss',
      headers: h.as(owner),
    });
    expect(dismissed.statusCode).toBe(204);

    const after = await list();
    expect(after.items.map((i) => i.rule_key)).not.toContain('household_needs_will');
    expect(after.dismissed_count).toBe(1);

    const hidden = await list('?dismissed=true');
    expect(hidden.items).toHaveLength(1);
    expect(hidden.items[0]).toMatchObject({ rule_key: 'household_needs_will', dismissed: true });

    // Twice is not an error.
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: '/api/v1/suggestions/household_needs_will/dismiss',
          headers: h.as(owner),
        })
      ).statusCode,
    ).toBe(204);

    const restored = await h.app.inject({
      method: 'DELETE',
      url: '/api/v1/suggestions/household_needs_will/dismiss',
      headers: h.as(owner),
    });
    expect(restored.statusCode).toBe(204);
    expect((await list()).items.map((i) => i.rule_key)).toContain('household_needs_will');
  });

  it('dismissing something that is not a suggestion is refused, not recorded', async () => {
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: '/api/v1/suggestions/no_such_rule/dismiss',
          headers: h.as(owner),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: '/api/v1/suggestions/not%20a%20key/dismiss',
          headers: h.as(owner),
        })
      ).statusCode,
    ).toBe(422);
  });

  it('needs a session', async () => {
    expect((await h.app.inject('/api/v1/suggestions')).statusCode).toBe(401);
  });
});
