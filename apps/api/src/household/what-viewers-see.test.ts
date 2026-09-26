import { testAdminUrl } from '@fdv/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';
import { maskedEmail } from './invitations.js';
import type { MemberView } from './service.js';

/**
 * What a viewer is not told (5.3). A viewer — an accountant or an attorney
 * with a sign-in — is given documents, not the family: not who is how old,
 * not the household's answers, not the suggestions worked out from them.
 */
describe.skipIf(!testAdminUrl())('what a viewer is not told (5.3)', () => {
  let h: Harness;
  let owner: Tokens;
  let adult: Tokens;
  let teen: Tokens;
  let viewer: Tokens;

  const json = <T>(r: { json: () => unknown }) => r.json() as T;
  const get = <T>(who: Tokens, url: string) =>
    h.app.inject({ url, headers: h.as(who) }).then((r) => {
      expect(r.statusCode, r.body).toBe(200);
      return json<T>(r);
    });

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();
    adult = await h.join(owner, { name: 'Sam', email: 'sam-5.3@example.test', role: 'adult' });
    teen = await h.join(owner, { name: 'Kid', email: 'kid-5.3@example.test', role: 'teen' });
    viewer = await h.join(owner, {
      name: 'Accountant',
      email: 'acc-5.3@example.test',
      role: 'viewer',
    });
    // A child with a birthday, and a household that has answered: enough
    // for "No passport for Aisha" and friends.
    const aisha = await h.app.inject({
      method: 'POST',
      url: '/api/v1/members',
      headers: h.as(owner),
      payload: { display_name: 'Aisha', date_of_birth: '2016-05-01' },
    });
    expect(aisha.statusCode, aisha.body).toBe(201);
    const answered = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/profile',
      headers: h.as(owner),
      payload: { owns_home: true, vehicle_count: 2, has_business: true, country: 'GB' },
    });
    expect(answered.statusCode, answered.body).toBe(200);
  }, 90_000);
  afterAll(() => h.close());

  it('a viewer gets no one’s date of birth but their own, no household answers and no suggestions', async () => {
    const people = (await get<{ items: MemberView[] }>(viewer, '/api/v1/members')).items;
    expect(people.find((m) => m.display_name === 'Aisha')?.date_of_birth).toBeNull();
    expect(people.filter((m) => !m.is_me).every((m) => m.date_of_birth === null)).toBe(true);

    const profile = await get<Record<string, unknown>>(viewer, '/api/v1/profile');
    expect(profile).toMatchObject({
      owns_home: null,
      rents_home: null,
      vehicle_count: null,
      has_pets: null,
      has_business: null,
      country: null,
      answered_at: null,
      extra: {},
    });
    // The name and time zone every screen shows stay.
    expect(typeof profile.household_name).toBe('string');
    expect(typeof profile.timezone).toBe('string');

    expect(await get(viewer, '/api/v1/suggestions')).toEqual({
      items: [],
      profile_answered: null,
      dismissed_count: 0,
    });
  });

  it('an owner, an adult and a teen still get all three', async () => {
    for (const who of [owner, adult, teen]) {
      const people = (await get<{ items: MemberView[] }>(who, '/api/v1/members')).items;
      expect(people.find((m) => m.display_name === 'Aisha')?.date_of_birth).toBe('2016-05-01');
      const profile = await get<{ owns_home: boolean | null; vehicle_count: number | null }>(
        who,
        '/api/v1/profile',
      );
      expect(profile).toMatchObject({ owns_home: true, vehicle_count: 2 });
      const suggestions = await get<{ items: unknown[]; profile_answered: boolean | null }>(
        who,
        '/api/v1/suggestions',
      );
      expect(suggestions.profile_answered).toBe(true);
      expect(suggestions.items.length).toBeGreaterThan(0);
    }
  });

  it('a viewer keeps their own date of birth', async () => {
    const added = await h.app.inject({
      method: 'POST',
      url: '/api/v1/members',
      headers: h.as(owner),
      payload: { display_name: 'Grandpa', date_of_birth: '1950-02-03' },
    });
    expect(added.statusCode, added.body).toBe(201);
    const invited = await h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${json<{ id: string }>(added).id}/invite`,
      headers: h.as(owner),
      payload: { email: 'grandpa-5.3@example.test', role: 'viewer' },
    });
    expect(invited.statusCode, invited.body).toBe(201);
    const { link_token, code } = json<{ link_token: string; code: string }>(invited);
    const accepted = await h.app.inject({
      method: 'POST',
      url: `/api/v1/invitations/${link_token}/accept`,
      payload: { code, password: 'another correct horse' },
      remoteAddress: '10.53.0.9',
    });
    expect(accepted.statusCode, accepted.body).toBe(201);
    const grandpa = json<Tokens>(accepted);
    const people = (await get<{ items: MemberView[] }>(grandpa, '/api/v1/members')).items;
    expect(people.find((m) => m.is_me)?.date_of_birth).toBe('1950-02-03');
    expect(people.find((m) => m.display_name === 'Aisha')?.date_of_birth).toBeNull();
  });

  it('a viewer is told whether email works, not how it is set up', async () => {
    const saved = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/notifications/smtp',
      headers: h.as(owner),
      payload: {
        host: 'smtp.example.test',
        username: 'owner.personal@example.test',
        password: 'an app password',
        from_email: 'owner.personal@example.test',
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    for (const who of [viewer, adult]) {
      const seen = await h.app.inject({ url: '/api/v1/notifications/smtp', headers: h.as(who) });
      expect(seen.statusCode).toBe(200);
      expect(json<{ configured: boolean }>(seen).configured).toBe(true);
      expect(seen.body).not.toContain('owner.personal');
      expect(seen.body).not.toContain('smtp.example.test');
    }
    const theirs = await h.app.inject({ url: '/api/v1/notifications/smtp', headers: h.as(owner) });
    expect(theirs.body).toContain('owner.personal@example.test');
  });

  it('the invitation preview never shows the whole address before the code', async () => {
    const invited = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invitations',
      headers: h.as(owner),
      payload: { display_name: 'Grandma', email: 'jane.smith@example.test', role: 'viewer' },
    });
    expect(invited.statusCode, invited.body).toBe(201);
    const { link_token } = json<{ link_token: string }>(invited);
    const preview = await h.app.inject({ url: `/api/v1/invitations/${link_token}` });
    expect(preview.statusCode).toBe(200);
    expect(json<{ email: string }>(preview).email).toBe('j•••@example.test');
    expect(preview.body).not.toContain('jane.smith');
  });

  it('masks what it is given, even an address it could not use', () => {
    expect(maskedEmail('j@x.test')).toBe('j•••@x.test');
    expect(maskedEmail('no-at-sign')).toBe('•••');
    expect(maskedEmail('@x.test')).toBe('•••');
  });
});
