import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { Tokens } from '@fdv/shared';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * Sessions a phone can live with (4.6). A phone refreshes on networks that
 * drop answers; a lost answer used to end the session, since the token it
 * had just spent looked stolen. Now the token just replaced may be replayed
 * once, within 30 seconds, from the session's own app installation — and
 * every other replay still ends the session, for owner and thief alike.
 */
describe.skipIf(!testAdminUrl())('refresh grace, sliding expiry, and why a session ended', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  const PHONE = randomUUID();
  const OTHER = randomUUID();
  const APP_AGENT = 'FamilyDocumentVault/0.1.3 (Android 15; Google Pixel 8a)';

  beforeAll(async () => {
    h = await createHarness();
    await h.setup();
    admin = createPool(h.adminUrl, 2);
  }, 120_000);
  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  // Each request from its own address: the sign-in rate limit is not what is under test.
  let nth = 0;
  const peer = () => ({ remoteAddress: `10.7.${Math.floor(++nth / 200)}.${nth % 200}` });

  const signIn = async (installation: string | null = PHONE): Promise<Tokens> => {
    const res = await h.app.inject({
      ...peer(),
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: {
        'user-agent': APP_AGENT,
        ...(installation ? { 'x-fdv-installation': installation } : {}),
      },
      payload: { email: 'owner@example.test', password: 'correct horse battery' },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Tokens>();
  };
  const refresh = (token: string, installation: string | null = PHONE) =>
    h.app.inject({
      ...peer(),
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: installation ? { 'x-fdv-installation': installation } : {},
      payload: { refresh_token: token },
    });
  const refreshed = async (token: string, installation: string | null = PHONE) => {
    const res = await refresh(token, installation);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Tokens>();
  };
  const reasonOf = (res: { json: <T>() => T }) =>
    res.json<{ error: { code: string; reason?: string } }>().error;
  const sessionOf = async (t: Tokens) => {
    const [, payload] = t.access_token.split('.');
    const sid = (JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()) as { sid: string })
      .sid;
    return sid;
  };

  it('a refresh answer lost on the network can be replayed once within 30 s from the same installation', async () => {
    const t0 = await signIn();
    await refreshed(t0.refresh_token); // its answer never arrives
    const again = await refreshed(t0.refresh_token);
    // The session carries on from the replay's token.
    const onwards = await refreshed(again.refresh_token);
    expect(onwards.access_token).toBeTruthy();
    const audit = await admin.query<{ n: string }>(
      "select count(*) as n from audit_event where action = 'auth.refresh_replayed' and object_id = $1",
      [await sessionOf(t0)],
    );
    expect(Number(audit.rows[0]?.n)).toBe(1);
  });

  it('the same replay from another installation, or with none, revokes the session', async () => {
    for (const from of [OTHER, null]) {
      const t0 = await signIn();
      const t1 = await refreshed(t0.refresh_token);
      const replay = await refresh(t0.refresh_token, from);
      expect(replay.statusCode).toBe(401);
      expect(reasonOf(replay)).toMatchObject({ code: 'session_ended', reason: 'reused' });
      // The whole session is gone: the owner's current token too.
      const owner = await refresh(t1.refresh_token);
      expect(owner.statusCode).toBe(401);
      expect(reasonOf(owner).reason).toBe('reused');
    }
  });

  it('a browser never gets the grace', async () => {
    const t0 = await signIn(null);
    await refreshed(t0.refresh_token, null);
    const replay = await refresh(t0.refresh_token, null);
    expect(replay.statusCode).toBe(401);
  });

  it('a replay after 30 s revokes the session', async () => {
    const t0 = await signIn();
    const t1 = await refreshed(t0.refresh_token);
    await admin.query(
      "update session set rotated_at = now() - interval '31 seconds' where id = $1",
      [await sessionOf(t0)],
    );
    expect((await refresh(t0.refresh_token)).statusCode).toBe(401);
    expect((await refresh(t1.refresh_token)).statusCode).toBe(401);
  });

  it('a second replay of the same token is refused', async () => {
    const t0 = await signIn();
    await refreshed(t0.refresh_token);
    await refreshed(t0.refresh_token); // the one replay
    const second = await refresh(t0.refresh_token);
    expect(second.statusCode).toBe(401);
    expect(reasonOf(second).reason).toBe('reused');
  });

  it("a thief who replays first loses the session at the owner's next refresh", async () => {
    const t0 = await signIn();
    // The owner refreshes; a thief with a copy of the old token — and the
    // installation id — replays it within the 30 seconds.
    const owners = await refreshed(t0.refresh_token);
    const thiefs = await refreshed(t0.refresh_token);
    // The owner's next refresh presents a token the replay displaced: the session ends.
    const next = await refresh(owners.refresh_token);
    expect(next.statusCode).toBe(401);
    expect(reasonOf(next).reason).toBe('reused');
    // And with it the thief's.
    const theirs = await refresh(thiefs.refresh_token);
    expect(theirs.statusCode).toBe(401);
    expect(
      (await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: h.as(thiefs) })).statusCode,
    ).toBe(401);
  });

  it('the token displaced by a replay revokes the session if it is ever presented', async () => {
    const t0 = await signIn();
    const lost = await refreshed(t0.refresh_token);
    const kept = await refreshed(t0.refresh_token);
    expect((await refresh(lost.refresh_token)).statusCode).toBe(401);
    expect((await refresh(kept.refresh_token)).statusCode).toBe(401);
  });

  it('refresh slides the expiry but never past 180 days, and refresh_expires_in is honest', async () => {
    const t0 = await signIn();
    const day = 24 * 60 * 60;
    // A sign-in: 30 days, and 180 at most.
    expect(t0.refresh_expires_in).toBeGreaterThan(30 * day - 60);
    expect(t0.refresh_expires_in).toBeLessThanOrEqual(30 * day);
    const sid = await sessionOf(t0);
    const row = async () =>
      (
        await admin.query<{ expires_at: Date; absolute_expires_at: Date }>(
          'select expires_at, absolute_expires_at from session where id = $1',
          [sid],
        )
      ).rows[0];
    const signedIn = await row();
    expect((signedIn?.absolute_expires_at.getTime() ?? 0) - Date.now()).toBeGreaterThan(
      179 * day * 1000,
    );

    // Near the end of the 180 days, a refresh keeps it only until then.
    await admin.query(
      "update session set absolute_expires_at = now() + interval '10 days' where id = $1",
      [sid],
    );
    const late = await refreshed(t0.refresh_token);
    expect(late.refresh_expires_in).toBeGreaterThan(10 * day - 60);
    expect(late.refresh_expires_in).toBeLessThanOrEqual(10 * day);
    const after = await row();
    expect(after?.expires_at.getTime()).toBe(after?.absolute_expires_at.getTime());
  });

  it('session_ended says why', async () => {
    // Malformed.
    const malformed = await refresh('not-a-token');
    expect(reasonOf(malformed)).toMatchObject({ code: 'session_ended', reason: 'malformed' });

    // Expired.
    const e = await signIn();
    await admin.query("update session set expires_at = now() - interval '1 minute' where id = $1", [
      await sessionOf(e),
    ]);
    expect(reasonOf(await refresh(e.refresh_token)).reason).toBe('expired');

    // Revoked: signed out.
    const r = await signIn();
    await h.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: h.as(r) });
    expect(reasonOf(await refresh(r.refresh_token)).reason).toBe('revoked');
    const me = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: h.as(r) });
    expect(reasonOf(me).reason).toBe('revoked');
  });

  it('a person taken out of the household is told they were removed', async () => {
    const owner = await signIn();
    const adult = await h.join(owner, {
      name: 'Alex',
      email: `alex-${randomUUID()}@example.test`,
      role: 'adult',
    });
    await admin.query('delete from account_household where member_id = $1', [adult.member_id]);
    expect(reasonOf(await refresh(adult.refresh_token)).reason).toBe('removed');
    const me = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: h.as(adult) });
    expect(reasonOf(me).reason).toBe('removed');
  });

  it('the session list says which is the app, in words', async () => {
    const t = await signIn();
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/auth/sessions',
      headers: h.as(t),
    });
    const mine = res.json<{ items: Array<{ current: boolean; client: string; label: string }> }>()
      .items;
    expect(mine.find((s) => s.current)).toMatchObject({
      client: 'app',
      label: 'the app on a Google Pixel 8a',
    });
  });
});
