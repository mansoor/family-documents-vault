import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { ActivityLine } from '@fdv/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alertsSent, createHarness, TEST_MASTER, type Harness } from '../test-harness.js';
import { FORGOT_ANSWER_MS } from './routes.js';
import type { Tokens } from './service.js';
import { AUDITED_PER_HOUR } from './sign-in-guard.js';
import { deriveSigningKey, signAccessToken } from './tokens.js';
import { codeFor } from './totp.js';

/**
 * Failed sign-ins counted per account (0.9.0): the wait after five in a
 * row, never longer than fifteen minutes, the same for an address with no
 * account; the activity line, bounded; the alerts, once an hour; codes from
 * an authenticator app counted across interim tokens and taken once; a
 * forgotten password answered in the same time whoever asks; a token's
 * account held to its session's; and "sign out my other devices".
 */
describe.skipIf(!testAdminUrl())('failed sign-ins, counted per account (0.9.0)', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  let owner: Tokens;
  let coOwner: Tokens;
  let adult: Tokens;
  let max: Tokens;
  const KIM = 'kim@example.test';
  const KIM_PASSWORD = 'kims own long password';
  const MAX = 'max@example.test';
  const MAX_PASSWORD = 'maxs own long password';
  const LEE = 'lee@example.test';
  const LEE_PASSWORD = 'lees own long password';
  let peer = 0;
  /** Each request from its own address: the per-address limit is not what is tried here. */
  const from = () => ({ remoteAddress: `10.77.${(++peer >> 8) & 0xff}.${peer & 0xff}` });

  const signIn = (email: string, password: string) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { email, password },
      ...from(),
    });

  /** The account's wait ends now: as if its minutes had passed. */
  const waitOver = (email: string) =>
    admin
      .query(
        `update sign_in_failure set throttled_until = now() - interval '1 second'
        where throttled_until is not null`,
        [],
      )
      .then(() => email);

  const accountOf = async (t: Tokens) =>
    (await h.app.inject({ url: '/api/v1/me', headers: h.as(t) })).json<{ account_id: string }>()
      .account_id;

  beforeAll(async () => {
    h = await createHarness({ signInGuard: true, totpReplay: true });
    admin = createPool(h.adminUrl, 1);
    owner = await h.setup();
    coOwner = await h.join(owner, { name: 'Robin', email: 'robin@example.test', role: 'owner' });
    adult = await h.join(owner, { name: 'Sam', email: 'sam@example.test', role: 'adult' });
    // For the known device, the per-session count and the tries at once, below.
    await h.join(owner, { name: 'Kim', email: KIM, role: 'adult', password: KIM_PASSWORD });
    max = await h.join(owner, { name: 'Max', email: MAX, role: 'adult', password: MAX_PASSWORD });
    await h.join(owner, { name: 'Lee', email: LEE, role: 'adult', password: LEE_PASSWORD });
  });
  afterAll(async () => {
    await admin.end();
    await h.close();
  });

  it('five wrong passwords make signing in wait a minute, the right one too; an unknown address is answered word for word the same', async () => {
    const answers = async (email: string, password: string) => {
      const seen: Array<{ status: number; code: string; message: string; retry?: number }> = [];
      for (let i = 0; i < 6; i++) {
        const res = await signIn(email, i === 5 ? password : 'not the password');
        const e = res.json<{ error: { code: string; message: string; retry_after?: number } }>();
        seen.push({
          status: res.statusCode,
          code: e.error.code,
          message: e.error.message,
          ...(e.error.retry_after !== undefined ? { retry: e.error.retry_after } : {}),
        });
        if (i === 5) expect(res.headers['retry-after']).toBe(String(e.error.retry_after));
      }
      return seen;
    };
    const known = await answers('sam@example.test', 'another correct horse');
    const unknown = await answers('nobody-at-all@example.test', 'whatever it is');
    expect(
      known.slice(0, 5).every((a) => a.status === 401 && a.code === 'invalid_credentials'),
    ).toBe(true);
    // The sixth, the right password among them, waits.
    expect(known[5]).toMatchObject({ status: 429, code: 'sign_in_throttled' });
    expect(known[5]?.retry).toBeGreaterThan(55);
    expect(known[5]?.retry).toBeLessThanOrEqual(60);
    expect(known[5]?.message).toMatch(/^Too many tries to sign in\. Wait a minute/);
    // Nothing tells the two apart but the second or so between them.
    const strip = (a: (typeof known)[number]) => ({ ...a, retry: a.retry === undefined ? 0 : 1 });
    expect(unknown.map(strip)).toEqual(known.map(strip));
    // Nothing of the address is kept: an HMAC of the account, or of the address.
    const rows = await admin.query<{ subject: Buffer }>('select subject from sign_in_failure');
    for (const r of rows.rows) {
      expect(r.subject.length).toBe(32);
      expect(r.subject.toString('latin1')).not.toMatch(/example\.test/);
    }
  });

  it('then five minutes, then fifteen — never longer; a sign-in that opens starts the count again', async () => {
    const email = 'sam@example.test';
    const waits: number[] = [];
    for (let i = 0; i < 3; i++) {
      await waitOver(email);
      expect((await signIn(email, 'still not it')).statusCode).toBe(401);
      const res = await signIn(email, 'another correct horse');
      expect(res.statusCode).toBe(429);
      waits.push(res.json<{ error: { retry_after: number } }>().error.retry_after);
    }
    expect(waits[0]).toBeGreaterThan(290);
    expect(waits[0]).toBeLessThanOrEqual(300);
    expect(waits[1]).toBeGreaterThan(890);
    expect(waits[1]).toBeLessThanOrEqual(900);
    expect(waits[2]).toBeLessThanOrEqual(900);
    // The wait over, the right password opens, and the count is gone.
    await waitOver(email);
    expect((await signIn(email, 'another correct horse')).statusCode).toBe(200);
    for (let i = 0; i < 4; i++) {
      expect((await signIn(email, 'wrong again')).statusCode).toBe(401);
    }
    expect((await signIn(email, 'another correct horse')).statusCode).toBe(200);
  });

  it('each failure is a line in the person’s Activity, ten an hour at most, with the step and never the address', async () => {
    await h.guard.settled();
    const { rows } = await admin.query<{ detail: Record<string, unknown>; actor: string }>(
      `select detail, actor_account_id::text as actor from audit_event
        where action = 'auth.sign_in_failed' order by id`,
    );
    const sam = await accountOf(adult);
    // Sam's alone: an address with no account writes nowhere.
    expect(new Set(rows.map((r) => r.actor))).toEqual(new Set([sam]));
    expect(rows.length).toBeLessThanOrEqual(AUDITED_PER_HOUR);
    expect(rows.length).toBe(AUDITED_PER_HOUR);
    for (const r of rows) {
      expect(r.detail.step).toBe('password');
      expect(JSON.stringify(r.detail)).not.toMatch(/example\.test|horse|not the password/);
    }
    expect(rows.some((r) => r.detail.paused_minutes === 1)).toBe(true);
    // In words, to Sam and to the owners; never to another adult or a teen.
    const said = async (t: Tokens) =>
      (await h.app.inject({ url: '/api/v1/audit?limit=100', headers: h.as(t) }))
        .json<{ items: ActivityLine[] }>()
        .items.map((l) => l.text);
    expect(await said(adult)).toContain(
      'A sign-in to Sam’s account failed: the password was wrong',
    );
    expect(await said(owner)).toContain(
      'A sign-in to Sam’s account failed: the password was wrong, so signing in waits a minute',
    );
    const teen = await h.join(owner, { name: 'Tia', email: 'tia@example.test', role: 'teen' });
    expect((await said(teen)).filter((l) => l.includes('sign-in to'))).toEqual([]);
  });

  it('Sam is told once in an incident, with one text; an owner’s tries tell the other owners once too; a day without a failure starts a new incident', async () => {
    const sam = await accountOf(adult);
    const toSam = alertsSent(h).filter(
      (a) =>
        (a.account_ids as string[]).includes(sam) &&
        a.subject === 'Somebody is trying to sign in to your vault',
    );
    // Four waits began for Sam in this incident: one alert, with its text.
    expect(toSam).toHaveLength(1);
    expect(String(toSam[0]?.body)).toMatch(/failed tries to sign in to your account/);
    expect(toSam[0]?.text_kind).toBe('sign_in_tries');

    const ownerId = await accountOf(owner);
    const robin = await accountOf(coOwner);
    const told = () => {
      const all = alertsSent(h);
      return {
        owner: all.filter(
          (a) =>
            (a.account_ids as string[]).includes(ownerId) &&
            a.subject === 'Somebody is trying to sign in to your vault',
        ),
        others: all.filter((a) => a.subject === 'Somebody is trying to sign in as Owner'),
      };
    };
    for (let i = 0; i < 5; i++) await signIn('owner@example.test', 'not the owner password');
    await h.guard.settled();
    expect(told().owner).toHaveLength(1);
    expect(told().owner[0]?.text_kind).toBe('sign_in_tries');
    expect(told().others).toHaveLength(1);
    expect(told().others[0]?.account_ids).toEqual([robin]);
    // The other owners are emailed, never texted: the text is the person's.
    expect(told().others[0]?.no_text).toBe(true);
    // More tries in the same incident: nobody is told again.
    await waitOver('owner@example.test');
    for (let i = 0; i < 3; i++) await signIn('owner@example.test', 'still not it');
    await h.guard.settled();
    expect(told().owner).toHaveLength(1);
    expect(told().others).toHaveLength(1);
    // A day without a failure: the next five are a new incident, told again.
    await admin.query(
      `update sign_in_failure set last_failed_at = now() - interval '25 hours',
              window_started_at = now() - interval '25 hours', throttled_until = null`,
    );
    for (let i = 0; i < 5; i++) await signIn('owner@example.test', 'a new incident');
    await h.guard.settled();
    expect(told().owner).toHaveLength(2);
    expect(told().owner[1]?.text_kind).toBe('sign_in_tries');
    expect(told().others).toHaveLength(2);
    await waitOver('owner@example.test');
    expect((await signIn('owner@example.test', 'correct horse battery')).statusCode).toBe(200);
  });

  describe('codes from an authenticator app', () => {
    let secret: string;
    const robinSignIn = async () =>
      (await signIn('robin@example.test', 'another correct horse')).json<{ mfa_token: string }>()
        .mfa_token;
    const mfa = (token: string, code: string) =>
      h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/mfa',
        payload: { mfa_token: token, code },
        ...from(),
      });

    beforeAll(async () => {
      await admin.query(
        `update session set verified_at = now(), factor_verified_at = now() where revoked_at is null`,
      );
      const enrol = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/totp/enrol',
        headers: h.as(coOwner),
      });
      secret = enrol.json<{ secret: string }>().secret;
      // The step before now's: now's and the next are left for the tests.
      const confirmed = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/totp/confirm',
        headers: h.as(coOwner),
        payload: { code: codeFor(secret, Date.now() - 30_000) },
      });
      expect(confirmed.statusCode).toBe(204);
    });

    it('a code is taken once: the same code again, at sign-in, at confirming it’s you, at turning it off, is refused', async () => {
      const again = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/step-up',
        headers: h.as(coOwner),
        payload: { code: codeFor(secret, Date.now() - 30_000) },
      });
      expect(again.statusCode).toBe(401);
      const againSaid = again.json<{ error: { message: string; reason?: string } }>().error;
      expect(againSaid.message).toMatch(/used already/);
      expect(againSaid.reason).toBe('code_used');
      const now = codeFor(secret);
      const first = await mfa(await robinSignIn(), now);
      expect(first.statusCode).toBe(200);
      const replayed = await mfa(await robinSignIn(), now);
      expect(replayed.statusCode).toBe(401);
      const said = replayed.json<{ error: { code: string; message: string; reason?: string } }>()
        .error;
      expect(said.code).toBe('totp_invalid');
      expect(said.message).toMatch(/used already/);
      expect(said.reason).toBe('code_used');
      // An owner cannot turn it off; an adult's own, tried below, is refused the same.
      const step = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/step-up',
        headers: h.as(coOwner),
        payload: { code: now },
      });
      expect(step.statusCode).toBe(401);
      expect(step.json<{ error: { reason?: string } }>().error.reason).toBe('code_used');
      // The next step's code is still good.
      const next = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/step-up',
        headers: h.as(coOwner),
        payload: { code: codeFor(secret, Date.now() + 30_000) },
      });
      expect(next.statusCode).toBe(200);
    });

    it('wrong codes are counted across interim tokens: a new one buys no more tries', async () => {
      // The code replayed above counted; this starts from none.
      await admin.query('update sign_in_failure set failures = 0, throttled_until = null');
      // Six interim tokens, each of a password that was right.
      const tokens: string[] = [];
      for (let i = 0; i < 6; i++) tokens.push(await robinSignIn());
      for (const token of tokens.slice(0, 5)) {
        const res = await mfa(token, '000000');
        expect(res.statusCode).toBe(401);
      }
      const sixth = await mfa(tokens[5] as string, '000001');
      expect(sixth.statusCode).toBe(429);
      expect(sixth.json<{ error: { code: string } }>().error.code).toBe('sign_in_throttled');
      // The password alone is refused while it waits, too.
      expect((await signIn('robin@example.test', 'another correct horse')).statusCode).toBe(429);
      await h.guard.settled();
      const robin = await accountOf(coOwner);
      const toRobin = alertsSent(h).filter(
        (a) =>
          (a.account_ids as string[]).includes(robin) &&
          a.subject === 'Somebody is trying to sign in to your vault',
      );
      expect(toRobin).toHaveLength(1);
      // The password was right: they are told somebody may know it.
      expect(String(toRobin[0]?.body)).toMatch(/right password but the wrong code/);
      const { rows } = await admin.query<{ step: string }>(
        `select detail->>'step' as step from audit_event
          where action = 'auth.sign_in_failed' and actor_account_id = $1`,
        [robin],
      );
      expect(rows.map((r) => r.step)).toContain('code');
      await waitOver('robin@example.test');
    });
  });

  it('a forgotten password is answered after the same time, whether the address has a sign-in or not', async () => {
    const timed = async (email: string) => {
      const started = performance.now();
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password/forgot',
        payload: { email },
        ...from(),
      });
      expect(res.statusCode).toBe(202);
      return performance.now() - started;
    };
    await h.guard.settled();
    const before = alertsSent(h).length;
    const known = await timed('sam@example.test');
    const unknown = await timed('nobody-forgot@example.test');
    expect(known).toBeGreaterThanOrEqual(FORGOT_ANSWER_MS - 5);
    expect(unknown).toBeGreaterThanOrEqual(FORGOT_ANSWER_MS - 5);
    expect(Math.abs(known - unknown)).toBeLessThan(200);
    // And the link went, to the address that has a sign-in.
    const sent = alertsSent(h).slice(before);
    expect(sent.map((a) => a.subject)).toEqual(['Setting a new password for your vault']);
  });

  it('a token naming a real session but somebody else’s account opens nothing', async () => {
    const sam = await h.app.inject({ url: '/api/v1/me', headers: h.as(adult) });
    expect(sam.statusCode).toBe(200);
    const claims = JSON.parse(
      Buffer.from(adult.access_token.split('.')[1] as string, 'base64url').toString(),
    ) as { sid: string; hid: string; mid: string };
    const forged = await signAccessToken(deriveSigningKey(TEST_MASTER), {
      sub: await accountOf(owner),
      sid: claims.sid,
      hid: claims.hid,
      mid: claims.mid,
      role: 'owner',
    });
    const res = await h.app.inject({
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('unauthenticated');
  });

  describe('sign out my other devices', () => {
    it('asks them to confirm it’s them, then ends every other session of theirs and only theirs', async () => {
      const elsewhere = (await signIn('sam@example.test', 'another correct horse')).json<Tokens>();
      const here = (await signIn('sam@example.test', 'another correct horse')).json<Tokens>();
      await admin.query('update session set verified_at = null, factor_verified_at = null');
      const asked = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/sessions/sign-out-others',
        headers: h.as(here),
        payload: {},
      });
      expect(asked.statusCode).toBe(403);
      expect(asked.json<{ error: { code: string; action: string } }>().error).toMatchObject({
        code: 'step_up_required',
        action: 'sign_out_others',
      });
      const stepped = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/step-up',
        headers: h.as(here),
        payload: { password: 'another correct horse' },
      });
      expect(stepped.statusCode).toBe(200);
      const done = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/sessions/sign-out-others',
        headers: h.as(here),
        payload: {},
      });
      expect(done.statusCode).toBe(200);
      expect(done.json<{ ended: number }>().ended).toBeGreaterThanOrEqual(2);
      for (const gone of [elsewhere, adult]) {
        const me = await h.app.inject({ url: '/api/v1/me', headers: h.as(gone) });
        expect(me.statusCode).toBe(401);
        const renewed = await h.app.inject({
          method: 'POST',
          url: '/api/v1/auth/refresh',
          payload: { refresh_token: gone.refresh_token },
          ...from(),
        });
        expect(renewed.statusCode).toBe(401);
      }
      expect((await h.app.inject({ url: '/api/v1/me', headers: h.as(here) })).statusCode).toBe(200);
      // Nobody else's: the owner is signed in still.
      expect((await h.app.inject({ url: '/api/v1/me', headers: h.as(owner) })).statusCode).toBe(
        200,
      );
      const lines = (
        await h.app.inject({ url: '/api/v1/audit?limit=50', headers: h.as(here) })
      ).json<{ items: ActivityLine[] }>().items;
      expect(lines.map((l) => l.text)).toContain('Sam signed out their other devices');
      adult = here;
    });
  });

  describe('a device that signed in before is never made to wait by tries from elsewhere', () => {
    const browser = { 'x-fdv-refresh': 'cookie', 'sec-fetch-site': 'same-origin' };
    let proof: string;
    let cookie: string;

    beforeAll(async () => {
      // An app that keeps its proof, and a browser that keeps its cookie.
      const app = await signIn(KIM, KIM_PASSWORD);
      proof = app.json<Tokens>().device_proof as string;
      expect(proof).toMatch(/^kd1\./);
      const web = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password',
        headers: browser,
        payload: { email: KIM, password: KIM_PASSWORD },
        ...from(),
      });
      expect(web.json<Tokens>().device_proof).toBeUndefined();
      const c = web.cookies.find((x) => x.name === 'fdv_device');
      expect(c).toMatchObject({ path: '/api/v1/auth', httpOnly: true, sameSite: 'Strict' });
      cookie = c?.value as string;
    });

    it('whoever keeps failing elsewhere waits; the person’s app and browser sign in', async () => {
      for (let i = 0; i < 6; i++) await signIn(KIM, 'an attacker guesses');
      // From anywhere else, even the right password waits.
      expect((await signIn(KIM, KIM_PASSWORD)).statusCode).toBe(429);
      // The app that signed in before, with its proof: in.
      const app = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password',
        payload: { email: KIM, password: KIM_PASSWORD, device_proof: proof },
        ...from(),
      });
      expect(app.statusCode).toBe(200);
      // The browser, with its cookie: in.
      const web = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password',
        headers: browser,
        cookies: { fdv_device: cookie },
        payload: { email: KIM, password: KIM_PASSWORD },
        ...from(),
      });
      expect(web.statusCode).toBe(200);
      // A proof of another account's, or made up, is no proof: it waits.
      const ownerProof = (await signIn('sam@example.test', 'another correct horse')).json<Tokens>()
        .device_proof as string;
      for (const forged of [ownerProof, `${proof.slice(0, -2)}AA`]) {
        const res = await h.app.inject({
          method: 'POST',
          url: '/api/v1/auth/password',
          payload: { email: KIM, password: KIM_PASSWORD, device_proof: forged },
          ...from(),
        });
        expect(res.statusCode).toBe(429);
      }
    });

    it('the known device’s own wrong tries count on its own, and wait on their own', async () => {
      const withProof = (password: string) =>
        h.app.inject({
          method: 'POST',
          url: '/api/v1/auth/password',
          payload: { email: KIM, password, device_proof: proof },
          ...from(),
        });
      for (let i = 0; i < 5; i++) expect((await withProof('typo')).statusCode).toBe(401);
      expect((await withProof(KIM_PASSWORD)).statusCode).toBe(429);
      await waitOver(KIM);
    });

    it('the count starts again 24 hours after the first failure it counts', async () => {
      for (let i = 0; i < 6; i++) await signIn(KIM, 'an attacker guesses');
      expect((await signIn(KIM, KIM_PASSWORD)).statusCode).toBe(429);
      await admin.query(
        `update sign_in_failure set window_started_at = now() - interval '25 hours'
          where throttled_until > now()`,
      );
      expect((await signIn(KIM, KIM_PASSWORD)).statusCode).toBe(200);
    });
  });

  describe('confirming it’s you, and the current password, are counted per session', () => {
    let one: Tokens;
    let two: Tokens;

    beforeAll(async () => {
      one = max;
      two = (await signIn(MAX, MAX_PASSWORD)).json<Tokens>();
    });

    it('a session’s wrong tries make that session wait, never the person’s sign-in or their other sessions', async () => {
      const stepUp = (t: Tokens, password: string) =>
        h.app.inject({
          method: 'POST',
          url: '/api/v1/auth/step-up',
          headers: h.as(t),
          payload: { password },
        });
      for (let i = 0; i < 3; i++) expect((await stepUp(one, 'wrong')).statusCode).toBe(401);
      // A wrong current password at changing it counts there too.
      for (let i = 0; i < 2; i++) {
        const changed = await h.app.inject({
          method: 'POST',
          url: '/api/v1/auth/password/change',
          headers: h.as(one),
          payload: { current_password: 'wrong', new_password: 'a brand new long password' },
        });
        expect(changed.statusCode).toBe(401);
      }
      const waited = await stepUp(one, MAX_PASSWORD);
      expect(waited.statusCode).toBe(429);
      expect(waited.json<{ error: { code: string } }>().error.code).toBe('sign_in_throttled');
      // The other session, and signing in, are untouched.
      expect((await stepUp(two, MAX_PASSWORD)).statusCode).toBe(200);
      expect((await signIn(MAX, MAX_PASSWORD)).statusCode).toBe(200);
      await h.guard.settled();
      const { rows } = await admin.query<{ at: string | null }>(
        `select detail->>'at' as at from audit_event
          where action = 'auth.sign_in_failed' and actor_account_id = $1`,
        [await accountOf(two)],
      );
      expect(rows.length).toBe(5);
      expect(rows.every((r) => r.at === 'step_up')).toBe(true);
    });
  });

  describe('tries at the same moment cannot pass the limit', () => {
    it('twenty wrong passwords at once: five at most are checked, the rest wait', async () => {
      const answers = await Promise.all(
        Array.from({ length: 20 }, () => signIn(LEE, 'all at once')),
      );
      const checked = answers.filter((r) => r.statusCode === 401).length;
      const waited = answers.filter((r) => r.statusCode === 429).length;
      expect(checked).toBeGreaterThan(0);
      expect(checked).toBeLessThanOrEqual(5);
      expect(checked + waited).toBe(20);
      expect((await signIn(LEE, LEE_PASSWORD)).statusCode).toBe(429);
      await waitOver(LEE);
      await admin.query(`update sign_in_failure set failures = 0, throttled_until = null`);
    });

    it('twenty wrong codes at once with one interim token: five at most are checked', async () => {
      const secretOf = async (t: Tokens) => {
        await admin.query(
          `update session set verified_at = now(), factor_verified_at = now() where revoked_at is null`,
        );
        const enrol = await h.app.inject({
          method: 'POST',
          url: '/api/v1/auth/totp/enrol',
          headers: h.as(t),
        });
        const secret = enrol.json<{ secret: string }>().secret;
        const confirmed = await h.app.inject({
          method: 'POST',
          url: '/api/v1/auth/totp/confirm',
          headers: h.as(t),
          payload: { code: codeFor(secret, Date.now() - 30_000) },
        });
        expect(confirmed.statusCode).toBe(204);
      };
      await secretOf((await signIn(LEE, LEE_PASSWORD)).json<Tokens>());
      const token = (await signIn(LEE, LEE_PASSWORD)).json<{ mfa_token: string }>().mfa_token;
      expect(token).toBeTruthy();
      const answers = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          h.app.inject({
            method: 'POST',
            url: '/api/v1/auth/mfa',
            payload: { mfa_token: token, code: String(100000 + i) },
            ...from(),
          }),
        ),
      );
      const checked = answers.filter((r) => r.statusCode === 401).length;
      expect(checked).toBeGreaterThan(0);
      expect(checked).toBeLessThanOrEqual(5);
      expect(answers.filter((r) => r.statusCode === 429).length).toBe(20 - checked);
    });
  });
});

describe.skipIf(!testAdminUrl())('the web’s refresh token, in a cookie (0.9.0)', () => {
  let h: Harness;
  let peer = 0;
  const from = () => ({ remoteAddress: `10.78.${(++peer >> 8) & 0xff}.${peer & 0xff}` });
  const browser = { 'x-fdv-refresh': 'cookie', 'sec-fetch-site': 'same-origin' };

  beforeAll(async () => {
    h = await createHarness();
    await h.setup();
  });
  afterAll(() => h.close());

  const signIn = (headers: Record<string, string>, remote?: string) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers,
      payload: { email: 'owner@example.test', password: 'correct horse battery' },
      ...(remote ? { remoteAddress: remote } : from()),
    });

  it('a browser that asks is given its refresh token as an HttpOnly cookie, and none in the body', async () => {
    const res = await signIn(browser);
    expect(res.statusCode).toBe(200);
    const body = res.json<Tokens>();
    expect(body.refresh_token).toBe('');
    expect(body.access_token).toBeTruthy();
    const cookie = res.cookies.find((c) => c.name === 'fdv_refresh');
    expect(cookie).toMatchObject({
      path: '/api/v1/auth',
      httpOnly: true,
      sameSite: 'Strict',
    });
    expect(cookie?.value).toMatch(/\./);
    // Over plain http (the home network's :8080) it cannot be Secure.
    expect(cookie?.secure).toBeFalsy();
    expect(String(res.headers['set-cookie'])).not.toMatch(/Secure/);
    // And its proof that it signed in, beside it, kept 90 days; none in the body.
    expect(body.device_proof).toBeUndefined();
    expect(res.cookies.find((c) => c.name === 'fdv_device')).toMatchObject({
      path: '/api/v1/auth',
      httpOnly: true,
      sameSite: 'Strict',
      maxAge: 90 * 24 * 60 * 60,
    });
  });

  it('Secure when the vault was reached over https, as the proxy in front of it says', async () => {
    const res = await signIn({ ...browser, 'x-forwarded-proto': 'https' }, '127.0.0.1');
    expect(res.statusCode).toBe(200);
    expect(res.cookies.find((c) => c.name === 'fdv_refresh')?.secure).toBe(true);
  });

  it('a phone, or any client that does not ask, is answered as ever: the token in the body, no cookie', async () => {
    const res = await signIn({});
    expect(res.json<Tokens>().refresh_token).toMatch(/\./);
    expect(res.headers['set-cookie']).toBeUndefined();
    const renewed = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refresh_token: res.json<Tokens>().refresh_token },
      ...from(),
    });
    expect(renewed.statusCode).toBe(200);
    expect(renewed.json<Tokens>().refresh_token).toMatch(/\./);
    expect(renewed.headers['set-cookie']).toBeUndefined();
    // And a body with no token, or an empty one, from one that does not ask
    // (an old web page whose token went to the cookie in another tab): its
    // session is over, as far as it goes, and it is told so.
    for (const payload of [{}, { refresh_token: '' }]) {
      const none = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload,
        ...from(),
      });
      expect(none.statusCode).toBe(401);
      expect(none.json<{ error: { code: string; reason: string } }>().error).toMatchObject({
        code: 'session_ended',
        reason: 'expired',
      });
    }
    // A token not a string is still the caller's mistake.
    const wrong = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refresh_token: 12 },
      ...from(),
    });
    expect(wrong.statusCode).toBe(422);
  });

  it('renews with the cookie, from the vault’s own page only', async () => {
    const signed = await signIn(browser);
    let cookie = signed.cookies.find((c) => c.name === 'fdv_refresh')?.value as string;
    const renew = (headers: Record<string, string>, value = cookie) =>
      h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers,
        cookies: { fdv_refresh: value },
        payload: {},
        ...from(),
      });
    const ok = await renew({ ...browser, origin: 'http://localhost:80' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<Tokens>().refresh_token).toBe('');
    const next = ok.cookies.find((c) => c.name === 'fdv_refresh')?.value as string;
    expect(next).toBeTruthy();
    expect(next).not.toBe(cookie);
    cookie = next;
    // Another site's page: refused, and the token not spent.
    for (const headers of [
      { ...browser, 'sec-fetch-site': 'cross-site' },
      { ...browser, 'sec-fetch-site': 'same-site' },
      { 'x-fdv-refresh': 'cookie', origin: 'https://elsewhere.example' },
    ]) {
      const refused = await renew(headers);
      expect(refused.statusCode).toBe(403);
      expect(refused.json<{ error: { code: string } }>().error.code).toBe('cross_site_refused');
    }
    // Without the header the cookie is not even read: no token, as above.
    const plain = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { fdv_refresh: cookie },
      payload: {},
      ...from(),
    });
    expect(plain.statusCode).toBe(401);
    // Still good: nothing above spent it.
    expect((await renew(browser)).statusCode).toBe(200);
    // No cookie at all: the session is over, as far as this browser goes.
    const none = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: browser,
      payload: {},
      ...from(),
    });
    expect(none.statusCode).toBe(401);
    expect(none.json<{ error: { code: string; reason: string } }>().error).toMatchObject({
      code: 'session_ended',
      reason: 'expired',
    });
  });

  it('a refresh token kept from before is spent once for a cookie', async () => {
    const old = (await signIn({})).json<Tokens>();
    const moved = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: browser,
      payload: { refresh_token: old.refresh_token },
      ...from(),
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json<Tokens>().refresh_token).toBe('');
    const cookie = moved.cookies.find((c) => c.name === 'fdv_refresh')?.value as string;
    const again = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: browser,
      cookies: { fdv_refresh: cookie },
      payload: {},
      ...from(),
    });
    expect(again.statusCode).toBe(200);
  });

  it('signing out with the cookie alone ends its session and clears it; from another site, nothing', async () => {
    const signed = await signIn(browser);
    const cookie = signed.cookies.find((c) => c.name === 'fdv_refresh')?.value as string;
    const access = signed.json<Tokens>().access_token;
    const crossSite = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { ...browser, 'sec-fetch-site': 'cross-site' },
      cookies: { fdv_refresh: cookie },
    });
    expect(crossSite.statusCode).toBe(403);
    expect(
      (await h.app.inject({ url: '/api/v1/me', headers: { authorization: `Bearer ${access}` } }))
        .statusCode,
    ).toBe(200);
    const out = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: browser,
      cookies: { fdv_refresh: cookie },
    });
    expect(out.statusCode).toBe(204);
    const cleared = out.cookies.find((c) => c.name === 'fdv_refresh');
    expect(cleared?.value).toBe('');
    expect(
      (await h.app.inject({ url: '/api/v1/me', headers: { authorization: `Bearer ${access}` } }))
        .statusCode,
    ).toBe(401);
    // With neither a token nor a cookie: as before, sign in first.
    const nothing = await h.app.inject({ method: 'POST', url: '/api/v1/auth/logout' });
    expect(nothing.statusCode).toBe(401);
  });

  it('signing out with the access token clears the cookie too', async () => {
    const signed = await signIn(browser);
    const out = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { ...browser, authorization: `Bearer ${signed.json<Tokens>().access_token}` },
    });
    expect(out.statusCode).toBe(204);
    expect(out.cookies.find((c) => c.name === 'fdv_refresh')?.value).toBe('');
  });
});
