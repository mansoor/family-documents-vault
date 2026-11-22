import { randomUUID } from 'node:crypto';
import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import { SESSION_LOCKED_CODE, type AutoLock, type Me } from '@fdv/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../test-harness.js';
import type { Tokens } from './service.js';

let peers = 0;
const peer = () => `10.88.${(peers >> 8) & 0xff}.${peers++ & 0xff}`;
const codeOf = (r: LightMyRequestResponse) => r.json<{ error?: { code?: string } }>().error?.code;

/** The session an access token names. */
const sidOf = (t: Tokens) =>
  (
    JSON.parse(Buffer.from(t.access_token.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
      sid: string;
    }
  ).sid;

/**
 * Lock by itself after a while away (0.9.0-dev.87). A browser's session — one
 * signed in by the vault's own page, its refresh token in a cookie — with
 * nobody using it for the time in effect is locked by the vault at its next
 * request, as Lock locks it, with a line in the activity log. What the page
 * asks by itself (`X-FDV-Background: 1`) is not use; `POST /auth/still-here`
 * is. The household's time is an owner's, 15 minutes unless one chose
 * otherwise, or Off; each person may choose a shorter one for themselves.
 * A phone's session is never locked so.
 */
describe.skipIf(!testAdminUrl())('locking by itself after a while away', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  let owner: Tokens;

  const get = (url: string, t: Tokens, headers: Record<string, string> = {}) =>
    h.app.inject({ url, headers: { ...h.as(t), ...headers }, remoteAddress: peer() });
  const send = (method: 'POST' | 'PUT', url: string, t: Tokens, payload: object = {}) =>
    h.app.inject({ method, url, headers: h.as(t), payload, remoteAddress: peer() });
  /** Somebody signed in: by the vault's own page (a browser), or by a phone. */
  const signIn = async (email: string, password: string, how: 'browser' | 'phone') => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers:
        how === 'browser'
          ? { 'x-fdv-refresh': 'cookie', 'sec-fetch-site': 'same-origin' }
          : { 'x-fdv-installation': randomUUID() },
      payload: { email, password },
      remoteAddress: peer(),
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Tokens>();
  };
  /** When a session was last used, minutes ago; and whether it is locked. */
  const away = (t: Tokens, minutes: number) =>
    admin.query(
      `update session set last_active_at = now() - make_interval(secs => $2) where id = $1`,
      [sidOf(t), minutes * 60],
    );
  const row = async (t: Tokens) =>
    (
      await admin.query<{ in_browser: boolean; last_active_at: Date; locked_at: Date | null }>(
        'select in_browser, last_active_at, locked_at from session where id = $1',
        [sidOf(t)],
      )
    ).rows[0];
  const unlock = (t: Tokens, password: string) =>
    send('POST', '/api/v1/auth/unlock', t, { password });
  const lines = async (action: string) =>
    (
      await admin.query<{ detail: Record<string, unknown> }>(
        'select detail from audit_event where action = $1 order by id',
        [action],
      )
    ).rows.map((r) => r.detail);
  const activity = async (t: Tokens) =>
    (await get('/api/v1/audit', t))
      .json<{ items: Array<{ text: string }> }>()
      .items.map((l) => l.text);

  const TEEN = { email: 'tess-away@example.test', password: 'another correct horse' };

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 20_000 });
    admin = createPool(h.adminUrl, 1);
    owner = await h.setup();
    await h.join(owner, { name: 'Tess', email: TEEN.email, role: 'teen' });
  }, 120_000);
  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  it('the capability document says so, and a browser is told its time', async () => {
    const caps = await h.app.inject({ url: '/api/v1/capabilities' });
    expect(caps.json<{ features: { auto_lock?: boolean } }>().features.auto_lock).toBe(true);
    const browser = await signIn(TEEN.email, TEEN.password, 'browser');
    expect((await row(browser))?.in_browser).toBe(true);
    expect((await get('/api/v1/me', browser)).json<Me>().auto_lock_minutes).toBe(15);
    const phone = await signIn(TEEN.email, TEEN.password, 'phone');
    expect((await row(phone))?.in_browser).toBe(false);
    expect((await get('/api/v1/me', phone)).json<Me>().auto_lock_minutes).toBeNull();
    // Nor the owner's first session, made by no page of the vault's.
    expect((await row(owner))?.in_browser).toBe(false);
  });

  it('a request past the time locks it first, with its line, and answers 423', async () => {
    const browser = await signIn(TEEN.email, TEEN.password, 'browser');
    await away(browser, 14);
    expect((await get('/api/v1/documents', browser)).statusCode).toBe(200);
    // That was use: the time starts again.
    expect(Date.now() - (await row(browser))!.last_active_at.getTime()).toBeLessThan(60_000);
    await away(browser, 16);
    const refused = await get('/api/v1/documents', browser);
    expect([refused.statusCode, codeOf(refused)]).toEqual([423, SESSION_LOCKED_CODE]);
    expect((await row(browser))?.locked_at).not.toBeNull();
    expect(await lines('session.locked_away')).toContainEqual({ minutes: 15 });
    // The lock screen's own look at who it is: locked, and nothing more written.
    expect((await get('/api/v1/me', browser)).json<Me>().locked).toBe(true);
    expect((await lines('session.locked_away')).length).toBe(1);
    expect(await activity(owner)).toContain(
      'Tess was away for 15 minutes or more, so the vault locked itself in one browser',
    );
    // Unlocked with the password: used just now, so not locked again at once.
    expect((await unlock(browser, TEEN.password)).statusCode).toBe(200);
    expect((await get('/api/v1/documents', browser)).statusCode).toBe(200);
  });

  it('what the page asks by itself is not use, and saying somebody is still here is', async () => {
    const browser = await signIn(TEEN.email, TEEN.password, 'browser');
    await away(browser, 10);
    const before = (await row(browser))!.last_active_at.getTime();
    const quiet = await get('/api/v1/documents/counts', browser, { 'x-fdv-background': '1' });
    expect(quiet.statusCode).toBe(200);
    expect((await row(browser))!.last_active_at.getTime()).toBe(before);
    // Nor is who is signed in.
    await get('/api/v1/me', browser);
    expect((await row(browser))!.last_active_at.getTime()).toBe(before);
    expect((await send('POST', '/api/v1/auth/still-here', browser)).statusCode).toBe(204);
    expect((await row(browser))!.last_active_at.getTime()).toBeGreaterThan(before);
    // Past the time, a request the page made by itself locks it too.
    await away(browser, 20);
    const late = await get('/api/v1/documents/counts', browser, { 'x-fdv-background': '1' });
    expect(late.statusCode).toBe(423);
  });

  it('a phone is never locked so, however long it waits', async () => {
    const phone = await signIn(TEEN.email, TEEN.password, 'phone');
    await away(phone, 600);
    expect((await get('/api/v1/documents', phone)).statusCode).toBe(200);
    expect((await row(phone))?.locked_at).toBeNull();
  });

  it("each person's own time: shorter than the family's, never longer, the shorter in effect", async () => {
    const browser = await signIn(TEEN.email, TEEN.password, 'browser');
    const longer = await send('PUT', '/api/v1/me/auto-lock', browser, { minutes: 30 });
    expect([longer.statusCode, codeOf(longer)]).toEqual([422, 'validation_failed']);
    expect(longer.json<{ error: { detail?: string } }>().error.detail).toBe('minutes');
    const mine = await send('PUT', '/api/v1/me/auto-lock', browser, { minutes: 5 });
    expect(mine.json<AutoLock>()).toEqual({
      household: 15,
      mine: 5,
      in_effect: 5,
      can_change: false,
    });
    expect((await get('/api/v1/me', browser)).json<Me>().auto_lock_minutes).toBe(5);
    await away(browser, 6);
    expect((await get('/api/v1/documents', browser)).statusCode).toBe(423);
    expect((await lines('session.locked_away')).at(-1)).toEqual({ minutes: 5 });
    expect(await activity(owner)).toContain(
      'Tess chose to have the vault lock itself after 5 minutes away in their browsers',
    );
    // Back to the family's: longer in effect, so it asks to confirm it's you
    // once the five minutes since signing in have gone.
    const other = await signIn(TEEN.email, TEEN.password, 'browser');
    await admin.query(
      `update session set verified_at = now() - interval '10 minutes' where id = $1`,
      [sidOf(other)],
    );
    const asked = await send('PUT', '/api/v1/me/auto-lock', other, { minutes: null });
    expect(asked.statusCode).toBe(403);
    expect(asked.json<{ error: { code: string; action: string } }>().error).toMatchObject({
      code: 'step_up_required',
      action: 'change_auto_lock',
    });
    expect(
      (await send('POST', '/api/v1/auth/step-up', other, { password: TEEN.password })).statusCode,
    ).toBe(200);
    const back = await send('PUT', '/api/v1/me/auto-lock', other, { minutes: null });
    expect(back.json<AutoLock>()).toMatchObject({ mine: null, in_effect: 15 });
  });

  it("the family's time is an owner's: Off locks nobody, a person's own still does", async () => {
    const teen = await signIn(TEEN.email, TEEN.password, 'browser');
    const refused = await send('PUT', '/api/v1/household/auto-lock', teen, { minutes: 5 });
    expect([refused.statusCode, codeOf(refused)]).toEqual([403, 'forbidden']);
    // Shorter asks nothing; Off asks to confirm it's you.
    await admin.query(
      `update session set verified_at = now() - interval '10 minutes' where id = $1`,
      [sidOf(owner)],
    );
    const shorter = await send('PUT', '/api/v1/household/auto-lock', owner, { minutes: 10 });
    expect(shorter.json<AutoLock>()).toMatchObject({ household: 10, can_change: true });
    const off = await send('PUT', '/api/v1/household/auto-lock', owner, { minutes: null });
    expect(off.json<{ error: { action?: string } }>().error.action).toBe('change_auto_lock');
    await admin.query(`update session set verified_at = now() where id = $1`, [sidOf(owner)]);
    expect(
      (await send('PUT', '/api/v1/household/auto-lock', owner, { minutes: null })).json<AutoLock>()
        .household,
    ).toBeNull();
    const odd = await send('PUT', '/api/v1/household/auto-lock', owner, { minutes: 20 });
    expect(odd.statusCode).toBe(422);
    expect(await lines('household.auto_lock_changed')).toEqual([
      { minutes: 10, was: 15 },
      { minutes: null, was: 10 },
    ]);
    const said = await activity(owner);
    expect(said).toContain(
      'Owner set the vault to lock itself in a browser after 10 minutes away (it was 15 minutes)',
    );
    expect(said).toContain(
      'Owner turned off the vault locking itself in a browser after a while away',
    );

    // Off: a browser left for hours is not locked.
    await away(teen, 300);
    expect((await get('/api/v1/documents', teen)).statusCode).toBe(200);
    expect((await get('/api/v1/me', teen)).json<Me>().auto_lock_minutes).toBeNull();
    // Their own time, with the family's Off: theirs.
    expect(
      (await send('PUT', '/api/v1/me/auto-lock', teen, { minutes: 60 })).json<AutoLock>().in_effect,
    ).toBe(60);
    await away(teen, 61);
    expect((await get('/api/v1/documents', teen)).statusCode).toBe(423);
    expect((await unlock(teen, TEEN.password)).statusCode).toBe(200);
    await send('PUT', '/api/v1/me/auto-lock', teen, { minutes: null });
    await send('PUT', '/api/v1/household/auto-lock', owner, { minutes: 15 });
    expect(await activity(owner)).toContain(
      'Owner set the vault to lock itself in a browser after 15 minutes away (it was Off)',
    );
  });

  it("the page's own lock as its time ran out says so; Lock pressed says what it always did", async () => {
    const browser = await signIn(TEEN.email, TEEN.password, 'browser');
    const before = (await lines('session.locked_away')).length;
    expect((await send('POST', '/api/v1/auth/lock', browser, { away: true })).statusCode).toBe(204);
    expect((await lines('session.locked_away')).length).toBe(before + 1);
    expect((await get('/api/v1/documents', browser)).statusCode).toBe(423);
    expect((await unlock(browser, TEEN.password)).statusCode).toBe(200);
    const pressed = (await lines('session.locked')).length;
    expect((await send('POST', '/api/v1/auth/lock', browser)).statusCode).toBe(204);
    expect((await lines('session.locked')).length).toBe(pressed + 1);
  });
});
