import { createHash, randomBytes } from 'node:crypto';
import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { Tokens } from '@fdv/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, TEST_MASTER, type Harness } from '../test-harness.js';
import { deriveSigningKey, parseRefreshToken, refreshFamilyKey, sessionOfToken } from './tokens.js';

/**
 * Token families (5.30). Every refresh token names its session, so any
 * token the vault made for a session, presented once it has been replaced,
 * ends the session as `reused` — not only the token just replaced. Until
 * then a thief who spent a stolen token and its successor before the owner
 * did kept the session: the owner's token matched nothing.
 */
describe.skipIf(!testAdminUrl())('token families (5.30)', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/140.0';

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    await h.setup();
    admin = createPool(h.adminUrl, 2);
  }, 120_000);
  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  // Each sign-in from its own address: the sign-in rate limit is not under test.
  let nth = 0;
  const peer = () => `10.30.${Math.floor(++nth / 200)}.${nth % 200}`;
  const signIn = async (at = peer()): Promise<Tokens> => {
    const res = await h.app.inject({
      remoteAddress: at,
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: { 'user-agent': BROWSER },
      payload: { email: 'owner@example.test', password: 'correct horse battery' },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Tokens>();
  };
  /** A refresh, by default from somewhere new: never the grace's own client. */
  const refresh = (token: string, at = peer(), agent = BROWSER) =>
    h.app.inject({
      remoteAddress: at,
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { 'user-agent': agent },
      payload: { refresh_token: token },
    });
  const refreshed = async (token: string, at?: string) => {
    const res = await refresh(token, at);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Tokens>();
  };
  const why = (res: { json: <T>() => T }) =>
    res.json<{ error: { code: string; reason?: string } }>().error;
  const sessionOf = (t: Tokens) => {
    const payload = t.access_token.split('.')[1] ?? '';
    return (JSON.parse(Buffer.from(payload, 'base64url').toString()) as { sid: string }).sid;
  };
  const revokedReason = async (sid: string) =>
    (
      await admin.query<{ revoked_reason: string | null }>(
        'select revoked_reason from session where id = $1',
        [sid],
      )
    ).rows[0]?.revoked_reason;

  it('every refresh token names its session, with a tag only the vault makes', async () => {
    const t = await signIn();
    const sid = sessionOf(t);
    expect(t.refresh_token).toMatch(new RegExp(`^${t.household_id}\\.${sid}\\.[A-Za-z0-9_-]{43}$`));
    const key = refreshFamilyKey(deriveSigningKey(TEST_MASTER));
    const parsed = parseRefreshToken(t.refresh_token);
    expect(parsed && sessionOfToken(key, parsed)).toBe(sid);
    // The same session, any other secret: not the vault's.
    const forged = parseRefreshToken(`${t.household_id}.${sid}.${'A'.repeat(43)}`);
    expect(forged && sessionOfToken(key, forged)).toBeNull();
    // And the next token names it too.
    expect((await refreshed(t.refresh_token)).refresh_token.split('.')[1]).toBe(sid);
  });

  it("a stolen refresh token spent before the owner's ends the session as reused, whichever is presented second", async () => {
    // The thief spends the stolen token, and its successor, before the owner refreshes.
    const owners = await signIn();
    const thief1 = await refreshed(owners.refresh_token);
    const thief2 = await refreshed(thief1.refresh_token);
    const late = await refresh(owners.refresh_token);
    expect(late.statusCode).toBe(401);
    expect(why(late)).toMatchObject({ code: 'session_ended', reason: 'reused' });
    // The thief's session is over with it, to its refresh and access tokens alike.
    expect(why(await refresh(thief2.refresh_token)).reason).toBe('reused');
    const me = await h.app.inject({ url: '/api/v1/me', headers: h.as(thief2) });
    expect(why(me)).toMatchObject({ code: 'session_ended', reason: 'reused' });
    expect(await revokedReason(sessionOf(owners))).toBe('refresh token reuse');
    // Any other of its tokens, presented now, says the same.
    expect(why(await refresh(thief1.refresh_token)).reason).toBe('reused');

    // The other way round: the owner refreshes on, twice; the thief's copy,
    // two refreshes behind, comes in second.
    const stolen = await signIn();
    const next = await refreshed(stolen.refresh_token);
    const owner2 = await refreshed(next.refresh_token);
    const thief = await refresh(stolen.refresh_token);
    expect(thief.statusCode).toBe(401);
    expect(why(thief)).toMatchObject({ code: 'session_ended', reason: 'reused' });
    expect(why(await refresh(owner2.refresh_token)).reason).toBe('reused');
    const told = await admin.query<{ n: number }>(
      `select count(*)::int as n from audit_event
        where action = 'auth.session_revoked' and object_id = $1
          and detail->>'reason' = 'refresh token reuse'`,
      [sessionOf(stolen)],
    );
    expect(told.rows[0]?.n).toBe(1);
  });

  it("a token naming a live session with a tag that is not the vault's ends nothing", async () => {
    const t = await signIn();
    const sid = sessionOf(t);
    for (const forged of [
      `${t.household_id}.${sid}.${randomBytes(32).toString('base64url')}`,
      `${t.household_id}.${sid}.short`,
      `${t.household_id}.${sid}.${t.refresh_token.split('.')[2]?.slice(0, -2) ?? ''}AA`,
    ]) {
      const res = await refresh(forged);
      expect(res.statusCode, forged).toBe(401);
      expect(why(res).reason, forged).toBe('revoked');
    }
    // Its owner refreshes as before.
    await refreshed(t.refresh_token);
    expect(await revokedReason(sid)).toBeNull();
  });

  it("the grace window still lets a browser's racing tabs refresh", async () => {
    // Two tabs of one browser, at one address, both refreshing the token
    // they share at the same moment: one rotates it, and the other is the
    // grace's one replay — neither ends the session.
    const at = '10.31.0.1';
    const t = await signIn(at);
    const [a, b] = await Promise.all([refresh(t.refresh_token, at), refresh(t.refresh_token, at)]);
    expect(a.statusCode, a.body).toBe(200);
    expect(b.statusCode, b.body).toBe(200);
    // The session goes on from the token the vault has as current.
    const current = (
      await admin.query<{ refresh_hash: Buffer }>(
        'select refresh_hash from session where id = $1',
        [sessionOf(t)],
      )
    ).rows[0]?.refresh_hash;
    const hashOf = (token: string) => createHash('sha256').update(token).digest();
    const tokens = [a.json<Tokens>().refresh_token, b.json<Tokens>().refresh_token];
    const kept = tokens.find((x) => current?.equals(hashOf(x)));
    expect(kept).toBeDefined();
    const onwards = await refreshed(kept as string, at);
    expect(onwards.refresh_token.split('.')[1]).toBe(sessionOf(t));
    expect(await revokedReason(sessionOf(t))).toBeNull();
  });

  it('a session from before families still refreshes, and is given a token of a family', async () => {
    const t = await signIn();
    const sid = sessionOf(t);
    // A token as the vault made them before 5.30: the household and a secret.
    const legacy = `${t.household_id}.${randomBytes(32).toString('base64url')}`;
    await admin.query('update session set refresh_hash = $1 where id = $2', [
      createHash('sha256').update(legacy).digest(),
      sid,
    ]);
    const moved = await refreshed(legacy);
    expect(moved.refresh_token).toMatch(new RegExp(`^${t.household_id}\\.${sid}\\.`));
    expect(sessionOf(moved)).toBe(sid);
    const onwards = await refreshed(moved.refresh_token);
    const later = await refreshed(onwards.refresh_token);
    // From then on it is a family's: a token of it two refreshes back ends it.
    expect(why(await refresh(moved.refresh_token)).reason).toBe('reused');
    expect(why(await refresh(later.refresh_token)).reason).toBe('reused');
  });

  it('a token from before families is known, as before, while it is the one just replaced', async () => {
    const t = await signIn();
    const legacy = `${t.household_id}.${randomBytes(32).toString('base64url')}`;
    await admin.query('update session set refresh_hash = $1 where id = $2', [
      createHash('sha256').update(legacy).digest(),
      sessionOf(t),
    ]);
    const moved = await refreshed(legacy);
    // Presented again, by another client: theft, and the session ends.
    expect(why(await refresh(legacy)).reason).toBe('reused');
    expect(why(await refresh(moved.refresh_token)).reason).toBe('reused');
  });

  it('a token from before families, spent twice by a thief before the owner presents it, ends the session as reused (the 5.30 review, T530-01)', async () => {
    const t = await signIn();
    const sid = sessionOf(t);
    const legacy = `${t.household_id}.${randomBytes(32).toString('base64url')}`;
    await admin.query('update session set refresh_hash = $1 where id = $2', [
      createHash('sha256').update(legacy).digest(),
      sid,
    ]);
    // The thief refreshes the copied token, and then its successor.
    const thief1 = await refreshed(legacy);
    const thief2 = await refreshed(thief1.refresh_token);
    // The owner's device, idle since before the upgrade, presents it now.
    const owner = await refresh(legacy);
    expect(owner.statusCode).toBe(401);
    expect(why(owner)).toMatchObject({ code: 'session_ended', reason: 'reused' });
    expect(await revokedReason(sid)).toBe('refresh token reuse');
    expect(why(await refresh(thief2.refresh_token)).reason).toBe('reused');
  });
});
