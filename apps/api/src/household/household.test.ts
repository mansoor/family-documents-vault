import { testAdminUrl } from '@fdv/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';
import type { MemberView } from './service.js';

describe.skipIf(!testAdminUrl())('household profile and members', () => {
  let h: Harness;
  let owner: Tokens;
  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();
  });
  afterAll(() => h.close());

  it('the profile starts empty and remembers the wizard answers', async () => {
    const before = await h.app.inject({ url: '/api/v1/profile', headers: h.as(owner) });
    expect(
      before.json<{ owns_home: null; answered_at: null; household_name: string }>(),
    ).toMatchObject({
      owns_home: null,
      answered_at: null,
      household_name: 'The Test family',
    });
    const put = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/profile',
      headers: h.as(owner),
      payload: {
        owns_home: true,
        rents_home: false,
        vehicle_count: 2,
        has_pets: false,
        country: 'us',
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json<{ vehicle_count: number; country: string }>()).toMatchObject({
      vehicle_count: 2,
      country: 'US',
    });
    const again = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/profile',
      headers: h.as(owner),
      payload: { has_pets: true },
    });
    expect(again.json<{ has_pets: boolean; vehicle_count: number }>()).toMatchObject({
      has_pets: true,
      vehicle_count: 2,
    });
  });

  it('lists the owner as a member with an account, and adds people without one', async () => {
    const list = await h.app.inject({ url: '/api/v1/members', headers: h.as(owner) });
    const items = list.json<{ items: MemberView[] }>().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      display_name: 'Owner',
      has_account: true,
      role: 'owner',
      is_me: true,
    });

    const child = await h.app.inject({
      method: 'POST',
      url: '/api/v1/members',
      headers: h.as(owner),
      payload: { display_name: 'Aisha', date_of_birth: '2017-05-01', relationship: 'daughter' },
    });
    expect(child.statusCode).toBe(201);
    expect(child.json<MemberView>()).toMatchObject({
      display_name: 'Aisha',
      has_account: false,
      is_me: false,
      document_count: 0,
      date_of_birth: '2017-05-01',
    });

    // A private-scope key exists for the new member even without a sign-in.
    const { withSystem } = await import('@fdv/db');
    const keys = await withSystem(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('scope_key')
        .select(['kind', 'member_id'])
        .where('kind', '=', 'member')
        .execute(),
    );
    expect(keys.map((k) => k.member_id)).toContain(child.json<MemberView>().id);
  });

  it('counts documents per member', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(owner),
      payload: { title: 'Mine', owner_member_id: owner.member_id },
    });
    const list = await h.app.inject({ url: '/api/v1/members', headers: h.as(owner) });
    const me = list.json<{ items: MemberView[] }>().items.find((m) => m.is_me);
    expect(me?.document_count).toBe(1);
  });
});
