import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import { FACTOR_STEP_UPS } from '@fdv/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../test-harness.js';
import { SoftwareAuthenticator } from './passkey-test-authenticator.js';
import { TWO_STEP_SETUP_ROUTES } from './routes.js';
import type { Tokens } from './service.js';
import { codeFor } from './totp.js';

/**
 * Two-step sign-in, held to (0.9.0). An owner with neither a code from an
 * authenticator app nor a passkey — and, where the household asks it, an
 * adult — signs in with a password to a session that can only set one up,
 * or sign out. The README said owners must have it; until now nothing made
 * them.
 */

type Res = { statusCode: number; body: string; json: () => unknown };
const json = <T>(r: { json: () => unknown }) => r.json() as T;
const code = (r: Res) => {
  try {
    return json<{ error?: { code?: string } }>(r).error?.code;
  } catch {
    return undefined;
  }
};

/** Every route the API answers, from Fastify's own router (as release-exit.test.ts reads it). */
function routeTable(h: Harness): Array<{ method: string; url: string }> {
  const out: Array<{ method: string; url: string }> = [];
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    const tree = h.app.printRoutes({ method: method as 'GET', commonPrefix: false });
    const stack: string[] = [];
    for (const line of tree.split('\n')) {
      const m = /^([│ ]*)(?:├── |└── )(.*?)(?: \(([A-Z, ]+)\))?$/.exec(line.replace(/\r$/, ''));
      if (!m) continue;
      stack.length = (m[1] as string).length / 4;
      stack.push(m[2] as string);
      if (
        (m[3] ?? '')
          .split(',')
          .map((s) => s.trim())
          .includes(method)
      ) {
        out.push({ method, url: stack.join('') });
      }
    }
  }
  return out;
}

describe.skipIf(!testAdminUrl())('two-step sign-in, held to (0.9.0)', () => {
  let h: Harness;
  let owner: Tokens;
  let nth = 0;
  const peer = () => ({ remoteAddress: `10.93.${(++nth >> 8) & 0xff}.${nth & 0xff}` });

  const get = (t: Tokens, url: string) =>
    h.app.inject({ url, headers: h.as(t), ...peer() }) as Promise<Res>;
  const send = (t: Tokens, method: 'POST' | 'PUT', url: string, payload?: unknown) =>
    h.app.inject({
      method,
      url,
      headers: h.as(t),
      ...(payload === undefined ? {} : { payload: payload as never }),
      ...peer(),
    }) as Promise<Res>;
  const signIn = (email: string, password: string) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { email, password },
      ...peer(),
    }) as Promise<Res>;

  beforeAll(async () => {
    h = await createHarness({ twoStep: true, rateLimitPerMinute: 100_000 });
    owner = await h.setup();
  });
  afterAll(() => h?.close());

  it('the first owner, set up with a password alone, can only set up two-step sign-in', async () => {
    expect(owner.two_step_setup_required).toBe(true);
    const me = await get(owner, '/api/v1/me');
    expect(me.statusCode).toBe(200);
    expect(json<{ two_step_setup_required: boolean }>(me).two_step_setup_required).toBe(true);
    const docs = await get(owner, '/api/v1/documents');
    expect(docs.statusCode).toBe(403);
    expect(code(docs)).toBe('two_step_setup_required');
    expect(json<{ error: { message: string } }>(docs).error.message).toMatch(/Owners must/);
    // Signing in again with the password: the same, and a refresh too.
    const again = await signIn('owner@example.test', 'correct horse battery');
    expect(again.statusCode).toBe(200);
    expect(json<Tokens>(again).two_step_setup_required).toBe(true);
    const refreshed = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refresh_token: json<Tokens>(again).refresh_token },
      ...peer(),
    });
    expect(json<Tokens>(refreshed).two_step_setup_required).toBe(true);
  });

  it('every route but setting it up and signing out refuses that session', async () => {
    const routes = routeTable(h);
    expect(routes.length).toBeGreaterThan(300);
    const tried: string[] = [];
    for (const r of routes) {
      const key = `${r.method} ${r.url}`;
      if (TWO_STEP_SETUP_ROUTES.has(key)) continue;
      const url = r.url.replace(/:[A-Za-z_]+/g, '00000000-0000-4000-8000-000000000000');
      // A route a sign-in opens at all: refused with no bearer as unsigned-in.
      const anon = (await h.app.inject({
        method: r.method as 'GET',
        url,
        ...peer(),
      })) as Res;
      if (anon.statusCode !== 401) continue;
      const res = (await h.app.inject({
        method: r.method as 'GET',
        url,
        headers: h.as(owner),
        ...peer(),
      })) as Res;
      tried.push(key);
      // The session's routes say so; an app's or a computer's own refuse any bearer.
      expect(res.statusCode, key).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, key).toBeLessThan(500);
      if (res.statusCode !== 401) expect(code(res), key).toBe('two_step_setup_required');
    }
    expect(tried.length).toBeGreaterThan(250);
    // Signing out is let through (and the session is still good after the sweep).
    expect((await get(owner, '/api/v1/me')).statusCode).toBe(200);
  }, 300_000);

  it('a passkey set up lifts it, at once, for the same session', async () => {
    // A second owner's household of its own, set up with a password alone.
    const other = await createHarness({ twoStep: true });
    try {
      const first = await other.setup();
      expect(first.two_step_setup_required).toBe(true);
      const options = (await other.app.inject({
        method: 'POST',
        url: '/api/v1/auth/passkeys/challenge',
        headers: other.as(first),
      })) as Res;
      expect(options.statusCode).toBe(200);
      const made = (await other.app.inject({
        method: 'POST',
        url: '/api/v1/auth/passkeys',
        headers: other.as(first),
        payload: {
          response: new SoftwareAuthenticator().register(
            json<Parameters<SoftwareAuthenticator['register']>[0]>(options),
          ),
          label: 'Laptop',
        },
      })) as Res;
      expect(made.statusCode).toBe(201);
      // Making it, PIN and all, was a passkey given: this session goes on.
      expect(
        (await other.app.inject({ url: '/api/v1/documents', headers: other.as(first) })).statusCode,
      ).toBe(200);
    } finally {
      await other.close();
    }
  });

  it('an owner whose factor is a passkey is never let in by the password alone', async () => {
    const other = await createHarness({ twoStep: true, rateLimitPerMinute: 100_000 });
    let n = 0;
    const go = (method: 'GET' | 'POST', url: string, t?: Tokens, payload?: unknown) =>
      other.app.inject({
        method,
        url,
        ...(t ? { headers: other.as(t) } : {}),
        ...(payload === undefined ? {} : { payload: payload as never }),
        remoteAddress: `10.95.0.${++n}`,
      }) as Promise<Res>;
    const passwordSignIn = () =>
      go('POST', '/api/v1/auth/password', undefined, {
        email: 'owner@example.test',
        password: 'correct horse battery',
      });
    const challenge = async () =>
      json<Parameters<SoftwareAuthenticator['authenticate']>[0]>(
        await go('POST', '/api/v1/auth/passkey/challenge', undefined, {
          email: 'owner@example.test',
        }),
      );
    try {
      const first = await other.setup();
      // A sign-in opened with the password before the passkey was made.
      const earlier = json<Tokens>(await passwordSignIn());
      const device = new SoftwareAuthenticator();
      const options = await go('POST', '/api/v1/auth/passkeys/challenge', first);
      const made = await go('POST', '/api/v1/auth/passkeys', first, {
        response: device.register(json<Parameters<SoftwareAuthenticator['register']>[0]>(options)),
      });
      expect(made.statusCode).toBe(201);

      // The password now asks for the passkey: no session, only the challenge.
      const asked = await passwordSignIn();
      expect(asked.statusCode).toBe(200);
      expect(json(asked)).toMatchObject({ mfa_required: true, methods: ['passkey'] });
      expect(json<Partial<Tokens>>(asked).access_token).toBeUndefined();

      // The earlier password session is held until a passkey is given.
      const held = await go('GET', '/api/v1/documents', earlier);
      expect(held.statusCode).toBe(403);
      expect(code(held)).toBe('two_step_setup_required');
      expect(json<{ error: { reason: string } }>(held).error.reason).toBe('confirm');
      expect(json(await go('GET', '/api/v1/me', earlier))).toMatchObject({
        two_step_setup_required: true,
        two_step_reason: 'confirm',
      });

      // It cannot add an authenticator or another passkey of its own: that
      // takes the passkey, and the password does not do.
      for (const url of ['/api/v1/auth/totp/enrol', '/api/v1/auth/passkeys/challenge']) {
        const refused = await go('POST', url, earlier);
        expect(refused.statusCode, url).toBe(403);
        expect(json(refused), url).toMatchObject({
          error: { code: 'step_up_required', action: 'change_sign_in', factor: true },
        });
      }
      const password = await go('POST', '/api/v1/auth/step-up', earlier, {
        password: 'correct horse battery',
      });
      expect(password.statusCode).toBe(200);
      expect((await go('POST', '/api/v1/auth/totp/enrol', earlier)).statusCode).toBe(403);
      expect((await go('GET', '/api/v1/documents', earlier)).statusCode).toBe(403);

      // The passkey given, the same session goes on.
      const given = await go('POST', '/api/v1/auth/step-up', earlier, {
        passkey: device.authenticate(await challenge()),
      });
      expect(given.statusCode, given.body).toBe(200);
      expect((await go('GET', '/api/v1/documents', earlier)).statusCode).toBe(200);

      // And a passkey sign-in is a whole session from the start.
      const signedIn = await go('POST', '/api/v1/auth/passkey/verify', undefined, {
        response: device.authenticate(await challenge()),
      });
      expect(signedIn.statusCode, signedIn.body).toBe(200);
      const tokens = json<Tokens>(signedIn);
      expect(tokens.two_step_setup_required).toBeUndefined();
      expect((await go('GET', '/api/v1/documents', tokens)).statusCode).toBe(200);
    } finally {
      await other.close();
    }
  });

  it('a passkey from before 0.9.0 is still the second step: asked for, never enrolled past', async () => {
    const other = await createHarness({ twoStep: true, rateLimitPerMinute: 100_000 });
    let n = 0;
    const go = (method: 'GET' | 'POST', url: string, t?: Tokens, payload?: unknown) =>
      other.app.inject({
        method,
        url,
        ...(t ? { headers: other.as(t) } : {}),
        ...(payload === undefined ? {} : { payload: payload as never }),
        remoteAddress: `10.96.0.${++n}`,
      }) as Promise<Res>;
    try {
      const first = await other.setup();
      const device = new SoftwareAuthenticator();
      const options = await go('POST', '/api/v1/auth/passkeys/challenge', first);
      const made = await go('POST', '/api/v1/auth/passkeys', first, {
        response: device.register(json<Parameters<SoftwareAuthenticator['register']>[0]>(options)),
      });
      expect(made.statusCode).toBe(201);
      // As a passkey made before 0.9.0 is (never asked for a PIN), and a
      // session from before (never given it).
      const admin = createPool(other.adminUrl, 1);
      const verified = async () =>
        (await admin.query<{ v: boolean }>('select user_verified as v from credential')).rows[0]?.v;
      try {
        await admin.query('update credential set user_verified = false');
        await admin.query('update session set factor_verified_at = null');

        // Held to confirm with it, not to set something else up.
        const held = await go('GET', '/api/v1/documents', first);
        expect(held.statusCode).toBe(403);
        expect(json<{ error: { reason: string } }>(held).error.reason).toBe('confirm');
        // The password asks for the passkey.
        const again = await go('POST', '/api/v1/auth/password', undefined, {
          email: 'owner@example.test',
          password: 'correct horse battery',
        });
        expect(json(again)).toMatchObject({ mfa_required: true, methods: ['passkey'] });
        // And a password step-up cannot set up an authenticator past it.
        expect(
          (
            await go('POST', '/api/v1/auth/step-up', first, {
              password: 'correct horse battery',
            })
          ).statusCode,
        ).toBe(200);
        const enrol = await go('POST', '/api/v1/auth/totp/enrol', first);
        expect(enrol.statusCode).toBe(403);
        expect(json(enrol)).toMatchObject({ error: { code: 'step_up_required', factor: true } });

        // Given, with its PIN, it marks itself verified, and the session goes on.
        const challenge = await go('POST', '/api/v1/auth/passkey/challenge', undefined, {
          email: 'owner@example.test',
        });
        const given = await go('POST', '/api/v1/auth/step-up', first, {
          passkey: device.authenticate(
            json<Parameters<SoftwareAuthenticator['authenticate']>[0]>(challenge),
          ),
        });
        expect(given.statusCode, given.body).toBe(200);
        expect(await verified()).toBe(true);
        expect((await go('GET', '/api/v1/documents', first)).statusCode).toBe(200);
      } finally {
        await admin.end();
      }
    } finally {
      await other.close();
    }
  });

  it('a code by text is never the second step of somebody held to it who has a factor', async () => {
    const other = await createHarness({ twoStep: true, rateLimitPerMinute: 100_000 });
    let n = 0;
    try {
      const first = await other.setup();
      const call = (method: 'POST' | 'PUT', url: string, payload: unknown) =>
        other.app.inject({
          method,
          url,
          headers: other.as(first),
          payload: payload as never,
          remoteAddress: `10.97.1.${++n}`,
        }) as Promise<Res>;
      // A passkey: their factor, and their second step.
      const device = new SoftwareAuthenticator();
      const options = (await other.app.inject({
        method: 'POST',
        url: '/api/v1/auth/passkeys/challenge',
        headers: other.as(first),
      })) as Res;
      const made = await call('POST', '/api/v1/auth/passkeys', {
        response: device.register(json<Parameters<SoftwareAuthenticator['register']>[0]>(options)),
      });
      expect(made.statusCode).toBe(201);
      // The household's texts set up and working, and this owner's number
      // confirmed with codes by text asked for — as an older vault let
      // anybody, and as forSignIn would otherwise offer.
      const saved = await call('PUT', '/api/v1/sms/settings', {
        mode: 'local',
        base_url: 'http://192.168.1.20:8080',
        username: 'sms',
        password: 'sms-gate-password',
        country: 'GB',
        monthly_cap: 1000,
      });
      expect(saved.statusCode, saved.body).toBe(200);
      const tested = await call('POST', '/api/v1/sms/settings/test', { number: '07700 900999' });
      expect(json<{ ok: boolean }>(tested).ok, tested.body).toBe(true);
      const admin = createPool(other.adminUrl, 1);
      try {
        await admin.query(
          `insert into member_phone (member_id, household_id, number, confirmed_at)
           values ($1, $2, '+447700900101', now())`,
          [first.member_id, first.household_id],
        );
        await admin.query('update account set sign_in_text = true');
      } finally {
        await admin.end();
      }
      const asked = (await other.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password',
        payload: { email: 'owner@example.test', password: 'correct horse battery' },
        remoteAddress: `10.97.0.${++n}`,
      })) as Res;
      // The passkey is asked for, and no text is offered.
      expect(json(asked)).toMatchObject({ mfa_required: true, methods: ['passkey'] });
      const { mfa_token } = json<{ mfa_token: string }>(asked);
      expect(mfa_token).toBeTruthy();
      const send = (await other.app.inject({
        method: 'POST',
        url: '/api/v1/auth/mfa/text',
        payload: { mfa_token },
        remoteAddress: `10.97.0.${++n}`,
      })) as Res;
      expect(send.statusCode).toBe(409);
      expect(code(send)).toBe('sms_code_not_offered');
      const byText = (await other.app.inject({
        method: 'POST',
        url: '/api/v1/auth/mfa',
        payload: { mfa_token, code: '123456', method: 'text' },
        remoteAddress: `10.97.0.${++n}`,
      })) as Res;
      expect(code(byText)).toBe('sms_code_not_offered');
    } finally {
      await other.close();
    }
  });

  it('an authenticator app set up lifts it, at once, for the same session', async () => {
    const enrol = await send(owner, 'POST', '/api/v1/auth/totp/enrol');
    expect(enrol.statusCode).toBe(200);
    const { secret } = json<{ secret: string }>(enrol);
    const confirmed = await send(owner, 'POST', '/api/v1/auth/totp/confirm', {
      code: codeFor(secret),
    });
    expect(confirmed.statusCode).toBe(204);
    expect((await get(owner, '/api/v1/documents')).statusCode).toBe(200);
    const me = await get(owner, '/api/v1/me');
    expect(json<{ two_step_setup_required: boolean }>(me).two_step_setup_required).toBe(false);
    // A password alone no longer opens anything: the code is asked for.
    const again = await signIn('owner@example.test', 'correct horse battery');
    expect(json<{ mfa_required: boolean }>(again).mfa_required).toBe(true);
  });

  let adult: Tokens;

  it('an adult is held to it where the household asks it — every new household does', async () => {
    const setting = await get(owner, '/api/v1/household/two-step');
    expect(json(setting)).toEqual({ adults: true, can_change: true });
    adult = await h.join(owner, { name: 'Aisha', email: 'aisha@example.test', role: 'adult' });
    expect(adult.two_step_setup_required).toBe(true);
    const docs = await get(adult, '/api/v1/documents');
    expect(docs.statusCode).toBe(403);
    expect(code(docs)).toBe('two_step_setup_required');
    expect(json<{ error: { message: string } }>(docs).error.message).toMatch(/every adult/);
    // A teen never is.
    const teen = await h.join(owner, { name: 'Zain', email: 'zain@example.test', role: 'teen' });
    expect(teen.two_step_setup_required).toBeUndefined();
    expect((await get(teen, '/api/v1/documents')).statusCode).toBe(200);
  });

  it('an owner may stop asking it of adults, with a code; an adult may not', async () => {
    const refused = await send(adult, 'PUT', '/api/v1/household/two-step', { adults: false });
    expect(refused.statusCode).toBe(403);
    // A password is not enough to change it: a passkey or a code.
    await h.decider(owner);
    const changed = await send(owner, 'PUT', '/api/v1/household/two-step', { adults: false });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(json(changed)).toEqual({ adults: false, can_change: true });
    // The adult's same session goes on.
    expect((await get(adult, '/api/v1/documents')).statusCode).toBe(200);
    const me = await get(adult, '/api/v1/me');
    expect(json<{ two_step_setup_required: boolean }>(me).two_step_setup_required).toBe(false);
  });

  it('a household made before 0.9.0 does not ask it of adults until an owner says', async () => {
    const admin = createPool(h.adminUrl, 1);
    try {
      // What the migration gave every household there already was.
      const { rows } = await admin.query<{ d: string }>(
        `select column_default as d from information_schema.columns
          where table_name = 'household' and column_name = 'require_two_step_adults'`,
      );
      expect(rows[0]?.d).toBe('true');
      // Only an owner changes it, the database says too.
      await expect(
        admin.query(`
          begin;
          select set_config('app.actor', 'account', true), set_config('app.role', 'adult', true);
          update household set require_two_step_adults = true;
          commit;`),
      ).rejects.toThrow(/only an owner/);
      await admin.query('rollback').catch(() => undefined);
    } finally {
      await admin.end();
    }
  });

  it('exporting everything and connecting an app take a passkey or a code, never the password', async () => {
    expect(FACTOR_STEP_UPS).toEqual(expect.arrayContaining(['export_everything', 'connect_app']));
    // An adult with neither is told to set one up.
    const asked = await send(adult, 'POST', '/api/v1/exports');
    expect(asked.statusCode).toBe(403);
    expect(code(asked)).toBe('two_step_required');
    // An owner who gave only the password lately is asked for a code…
    const admin = createPool(h.adminUrl, 1);
    try {
      await admin.query(
        `update session set verified_at = now(), factor_verified_at = now() - interval '10 minutes'
          where account_id = (select account_id from account_household where member_id = $1)`,
        [owner.member_id],
      );
    } finally {
      await admin.end();
    }
    const stale = await send(owner, 'POST', '/api/v1/exports');
    expect(stale.statusCode).toBe(403);
    expect(json<{ error: { code: string; action: string } }>(stale).error).toMatchObject({
      code: 'step_up_required',
      action: 'export_everything',
    });
    const connect = await send(owner, 'POST', '/api/v1/connected-apps', {});
    expect(connect.statusCode).toBe(403);
    expect(json<{ error: { action: string } }>(connect).error.action).toBe('connect_app');
    // …which the password does not give…
    const password = await send(owner, 'POST', '/api/v1/auth/step-up', {
      password: 'correct horse battery',
    });
    expect(password.statusCode).toBe(200);
    expect((await send(owner, 'POST', '/api/v1/exports')).statusCode).toBe(403);
    // …and a code does.
    await h.decider(owner);
    expect((await send(owner, 'POST', '/api/v1/exports')).statusCode).toBe(202);
  });
});
