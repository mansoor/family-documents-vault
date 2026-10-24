import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  addDays,
  localToday,
  shareEndWords,
  zonedTime,
  type FamilyTimeZone,
  type Profile,
} from '@fdv/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { loadConfig } from '../config.js';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * The family's time zone (0.9.0, TZ; the owner's ask of 23 Oct 2026): the
 * household's own when an owner chose one, else the server's FDV_TIMEZONE,
 * else UTC; an owner's to change, in Settings or by PUT /profile as before;
 * null goes back to the server's default; a name nobody knows is refused.
 */
describe.skipIf(!testAdminUrl())("the family's time zone (TZ)", () => {
  let h: Harness;
  let owner: Tokens;
  let adult: Tokens;
  const PASSWORD = 'a long enough password 0123';
  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    owner = await h.setup();
    adult = await h.join(owner, {
      name: 'Ada',
      email: 'ada-tz@example.test',
      role: 'adult',
      password: PASSWORD,
    });
  });
  afterAll(() => h.close());
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const zoneOf = async (who: Tokens) => {
    const res = await h.app.inject({ url: '/api/v1/household/timezone', headers: h.as(who) });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<FamilyTimeZone>();
  };
  const profileOf = async (who: Tokens) =>
    (await h.app.inject({ url: '/api/v1/profile', headers: h.as(who) })).json<Profile>();
  const setZone = (who: Tokens, timezone: unknown) =>
    h.app.inject({
      method: 'PUT',
      url: '/api/v1/household/timezone',
      headers: h.as(who),
      payload: { timezone },
    });
  const stored = async () => {
    const admin = createPool(h.adminUrl, 1);
    try {
      return (
        await admin.query<{ timezone: string | null }>(
          'select timezone from household where id = $1',
          [owner.household_id],
        )
      ).rows[0]?.timezone;
    } finally {
      await admin.end();
    }
  };

  it("is the server's default until an owner chooses one: UTC, or FDV_TIMEZONE when it is set", async () => {
    expect(await stored()).toBeNull();
    expect(await zoneOf(owner)).toEqual({
      timezone: 'UTC',
      timezone_source: 'server_default',
      server_timezone: 'UTC',
      can_change: true,
    });
    vi.stubEnv('FDV_TIMEZONE', 'America/New_York');
    // Every role reads it, and the profile says it as the zone in effect.
    expect(await zoneOf(adult)).toEqual({
      timezone: 'America/New_York',
      timezone_source: 'server_default',
      server_timezone: 'America/New_York',
      can_change: false,
    });
    expect(await profileOf(adult)).toMatchObject({
      timezone: 'America/New_York',
      timezone_source: 'server_default',
      server_timezone: 'America/New_York',
    });
  });

  it("an owner's choice overrides the server's default, and null goes back to it", async () => {
    vi.stubEnv('FDV_TIMEZONE', 'America/New_York');
    const chosen = await setZone(owner, 'Pacific/Kiritimati');
    expect(chosen.statusCode, chosen.body).toBe(200);
    expect(chosen.json<FamilyTimeZone>()).toMatchObject({
      timezone: 'Pacific/Kiritimati',
      timezone_source: 'household',
      server_timezone: 'America/New_York',
    });
    expect(await stored()).toBe('Pacific/Kiritimati');
    expect((await profileOf(adult)).timezone).toBe('Pacific/Kiritimati');
    // The server's default changing does not move the family's own.
    vi.stubEnv('FDV_TIMEZONE', 'Europe/Paris');
    expect((await zoneOf(adult)).timezone).toBe('Pacific/Kiritimati');
    // Cleared: the server's default again, whatever it is now.
    const cleared = await setZone(owner, null);
    expect(cleared.json<FamilyTimeZone>()).toMatchObject({
      timezone: 'Europe/Paris',
      timezone_source: 'server_default',
    });
    expect(await stored()).toBeNull();
    // PUT /profile {timezone} as before, null too.
    const old = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/profile',
      headers: h.as(owner),
      payload: { timezone: 'Europe/London' },
    });
    expect(old.statusCode, old.body).toBe(200);
    expect(old.json<Profile>()).toMatchObject({
      timezone: 'Europe/London',
      timezone_source: 'household',
    });
    const oldNull = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/profile',
      headers: h.as(owner),
      payload: { timezone: null },
    });
    expect(oldNull.json<Profile>()).toMatchObject({
      timezone: 'Europe/Paris',
      timezone_source: 'server_default',
    });
  });

  it('a name nobody knows is refused (422), by either route, and nothing changes', async () => {
    await setZone(owner, 'Asia/Tokyo');
    for (const res of [
      await setZone(owner, 'Mars/Olympus_Mons'),
      await setZone(owner, 'Europe/Londn'),
      await h.app.inject({
        method: 'PUT',
        url: '/api/v1/profile',
        headers: h.as(owner),
        payload: { timezone: 'Not a zone' },
      }),
    ]) {
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json<{ error: { code: string; message: string } }>().error).toMatchObject({
        code: 'validation_failed',
        message: expect.stringMatching(/time zone is not recognised/) as unknown,
      });
    }
    expect(await stored()).toBe('Asia/Tokyo');
    await setZone(owner, null);
  });

  it('takes an IANA name as the runtime spells it, and never an abbreviation or an offset (the TZ review)', async () => {
    for (const not of ['EST', 'GMT', '+05:30', 'UTC+1', 'Etc/GMT+5']) {
      const res = await setZone(owner, not);
      expect(res.statusCode, not).toBe(422);
    }
    expect((await setZone(owner, 'europe/london')).json<FamilyTimeZone>().timezone).toBe(
      'Europe/London',
    );
    expect(await stored()).toBe('Europe/London');
    // A current name the runtime knows by an older one is kept as written.
    expect((await setZone(owner, 'Asia/Kolkata')).json<FamilyTimeZone>().timezone).toBe(
      'Asia/Kolkata',
    );
    const viaProfile = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/profile',
      headers: h.as(owner),
      payload: { timezone: 'utc' },
    });
    expect(viaProfile.json<Profile>().timezone).toBe('UTC');
    expect(await stored()).toBe('UTC');
    // FDV_TIMEZONE as well.
    vi.stubEnv('FDV_TIMEZONE', 'america/new_york');
    await setZone(owner, null);
    expect((await zoneOf(owner)).server_timezone).toBe('America/New_York');
  });

  it("is an owner's alone: an adult is refused by either route, and nothing else they sent is changed", async () => {
    const refused = await setZone(adult, 'Europe/London');
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ error: { code: string; message: string } }>().error).toEqual(
      expect.objectContaining({
        code: 'forbidden',
        message: 'Only an owner can change the family’s time zone.',
      }),
    );
    const both = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/profile',
      headers: h.as(adult),
      payload: { has_pets: true, timezone: 'Europe/London' },
    });
    expect(both.statusCode).toBe(403);
    expect((await profileOf(owner)).has_pets).not.toBe(true);
    expect(await stored()).toBeNull();
    // An adult still answers the household's questions.
    const answers = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/profile',
      headers: h.as(adult),
      payload: { has_pets: false },
    });
    expect(answers.statusCode, answers.body).toBe(200);
  });

  it('the database holds it too: nobody signed in but an owner changes it (0080)', async () => {
    const accountOf = async (who: Tokens) => {
      const admin = createPool(h.adminUrl, 1);
      try {
        return (
          await admin.query<{ account_id: string }>(
            'select account_id from account_household where member_id = $1',
            [who.member_id],
          )
        ).rows[0]?.account_id as string;
      } finally {
        await admin.end();
      }
    };
    const asMember = async (who: Tokens, role: string) => {
      const pool = createPool(h.appUrl, 1);
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                  set_config('app.role', $2, true), set_config('app.account_id', $3, true),
                  set_config('app.member_id', $4, true)`,
          [owner.household_id, role, await accountOf(who), who.member_id],
        );
        return await client
          .query("update household set timezone = 'Europe/London' where id = $1", [
            owner.household_id,
          ])
          .then(
            (r) => r.rowCount,
            (e: { code?: string }) => e.code,
          );
      } finally {
        await client.query('rollback').catch(() => undefined);
        client.release();
        await pool.end();
      }
    };
    expect(await asMember(adult, 'adult')).toBe('42501');
    expect(await asMember(owner, 'owner')).toBe(1);
  });

  it("the activity log says who changed it, from which to which, the server's default named", async () => {
    vi.stubEnv('FDV_TIMEZONE', 'America/New_York');
    expect((await setZone(owner, 'Europe/London')).statusCode).toBe(200);
    expect((await setZone(owner, null)).statusCode).toBe(200);
    const texts = (await h.app.inject({ url: '/api/v1/audit', headers: h.as(adult) })).json<{
      items: Array<{ text: string; kind?: string }>;
    }>().items;
    const lines = texts.map((l) => l.text).filter((t) => t.includes('time zone'));
    expect(lines.slice(0, 2)).toEqual([
      'Owner changed the family’s time zone from Europe/London to the server’s default (America/New_York)',
      'Owner changed the family’s time zone from the server’s default (America/New_York) to Europe/London',
    ]);
  });

  it("what the vault says of a moment is on the family's clock, its zone named: a lock's end", async () => {
    await h.decider(owner);
    vi.stubEnv('FDV_TIMEZONE', 'Pacific/Pago_Pago');
    const until = new Date(Date.now() + 3 * 864e5);
    const locked = await h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${adult.member_id}/lock`,
      headers: h.as(owner),
      payload: { until: until.toISOString() },
    });
    expect(locked.statusCode, locked.body).toBe(200);
    const refusedIn = async () =>
      (
        await h.app.inject({
          method: 'POST',
          url: '/api/v1/auth/password',
          payload: { email: 'ada-tz@example.test', password: PASSWORD },
        })
      ).json<{ error: { message: string } }>().error.message;
    // The server's default…
    expect(await refusedIn()).toBe(
      `An owner has locked your sign-in until ${shareEndWords(until, 'Pacific/Pago_Pago')} (Pacific/Pago_Pago). Ask one of them if you need to get in sooner.`,
    );
    // …and the family's own, a day apart across the date line.
    await setZone(owner, 'Pacific/Kiritimati');
    expect(await refusedIn()).toBe(
      `An owner has locked your sign-in until ${shareEndWords(until, 'Pacific/Kiritimati')} (Pacific/Kiritimati). Ask one of them if you need to get in sooner.`,
    );
    expect(shareEndWords(until, 'Pacific/Kiritimati')).not.toBe(
      shareEndWords(until, 'Pacific/Pago_Pago'),
    );
    await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/members/${adult.member_id}/lock`,
      headers: h.as(owner),
    });
    await setZone(owner, null);
  });

  /**
   * Whether a document has expired is the family's day, never the server's
   * UTC one (the TZ review): at 00:30 in Auckland it is still yesterday in
   * UTC, and at 17:30 in Los Angeles it is already tomorrow.
   */
  it("a document's status is worked out on the family's today, at both ends of the UTC day", async () => {
    const statusAt = async (zone: string, time: string, expires: (today: string) => string) => {
      expect((await setZone(owner, zone)).statusCode).toBe(200);
      const today = localToday(zone);
      const at = zonedTime(today, time, zone) as Date;
      vi.useFakeTimers({ toFake: ['Date'], now: at });
      try {
        // Signed in at that moment, so the sign-in holds then.
        const signedIn = await h.app.inject({
          method: 'POST',
          url: '/api/v1/auth/password',
          payload: { email: 'ada-tz@example.test', password: PASSWORD },
        });
        expect(signedIn.statusCode, signedIn.body).toBe(200);
        const ada = signedIn.json<Tokens>();
        const made = await h.app.inject({
          method: 'POST',
          url: '/api/v1/documents',
          headers: h.as(ada),
          payload: {
            title: `Passport, ${zone}`,
            type_key: 'passport',
            identifier: 'P1234567',
            owner_member_id: ada.member_id,
            expires: { date: expires(today), precision: 'day' },
          },
        });
        expect(made.statusCode, made.body).toBe(201);
        const id = made.json<{ id: string }>().id;
        const one = await h.app.inject({ url: `/api/v1/documents/${id}`, headers: h.as(ada) });
        const listed = await h.app.inject({ url: '/api/v1/documents', headers: h.as(ada) });
        const inList = listed
          .json<{ items: Array<{ id: string; status: { value: string; label: string } }> }>()
          .items.find((d) => d.id === id);
        return [one.json<{ status: { value: string; label: string } }>().status, inList?.status];
      } finally {
        vi.useRealTimers();
      }
    };
    // Auckland, 00:30: yesterday's expiry has passed (UTC still says "today").
    const auckland = await statusAt('Pacific/Auckland', '00:30', (d) => addDays(d, -1));
    expect(auckland.map((s) => s?.value)).toEqual(['expired', 'expired']);
    // Los Angeles, 17:30: today's expiry is today (UTC already says it has passed).
    const la = await statusAt('America/Los_Angeles', '17:30', (d) => d);
    expect(la.map((s) => s?.label)).toEqual(['Expires today', 'Expires today']);
    await setZone(owner, null);
  });
});

describe('FDV_TIMEZONE at startup', () => {
  const base = { DATABASE_URL: 'postgres://x', FDV_MASTER_KEY: 'k'.repeat(40) };
  it('is UTC unless set, and an IANA name when it is', () => {
    expect(loadConfig(base).FDV_TIMEZONE).toBe('UTC');
    expect(loadConfig({ ...base, FDV_TIMEZONE: 'Europe/London' }).FDV_TIMEZONE).toBe(
      'Europe/London',
    );
    // Compose hands an unset one over as nothing: unset.
    expect(loadConfig({ ...base, FDV_TIMEZONE: '' }).FDV_TIMEZONE).toBe('UTC');
    // As the runtime spells it (the TZ review).
    expect(loadConfig({ ...base, FDV_TIMEZONE: 'europe/london' }).FDV_TIMEZONE).toBe(
      'Europe/London',
    );
  });
  it('refuses to start with a name that is not a zone, saying what to give', () => {
    for (const not of ['EST', '+05:30']) {
      expect(() => loadConfig({ ...base, FDV_TIMEZONE: not })).toThrow(/FDV_TIMEZONE/);
    }
    expect(() => loadConfig({ ...base, FDV_TIMEZONE: 'Europe/Londn' })).toThrow(
      /FDV_TIMEZONE: not a time zone this server knows: give an IANA name such as Europe\/London/,
    );
  });
});
