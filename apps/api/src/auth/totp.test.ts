import { testAdminUrl } from '@fdv/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../test-harness.js';
import type { Tokens } from './service.js';
import { codeFor } from './totp.js';

describe.skipIf(!testAdminUrl())('two-step sign-in', () => {
  let h: Harness;
  let owner: Tokens;
  let secret: string;

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();
  });
  afterAll(() => h.close());

  it('an owner without an authenticator is told it is required', async () => {
    const me = await h.app.inject({ url: '/api/v1/me', headers: h.as(owner) });
    expect(me.json<{ totp_enabled: boolean; totp_required: boolean }>()).toMatchObject({
      totp_enabled: false,
      totp_required: true,
    });
  });

  it('enrols with an otpauth URL and confirms with a current code', async () => {
    const enrol = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/enrol',
      headers: h.as(owner),
    });
    expect(enrol.statusCode).toBe(200);
    const body = enrol.json<{ secret: string; otpauth_url: string }>();
    secret = body.secret;
    expect(body.otpauth_url).toMatch(
      /^otpauth:\/\/totp\/Family%20Document%20Vault:owner%40example\.test\?/,
    );

    const wrong = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/confirm',
      headers: h.as(owner),
      payload: { code: '000000' },
    });
    expect(wrong.statusCode).toBe(422);

    // Not yet confirmed: password alone still signs in.
    const before = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { email: 'owner@example.test', password: 'correct horse battery' },
    });
    expect(before.json<Tokens>().access_token).toBeTruthy();

    const ok = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/confirm',
      headers: h.as(owner),
      payload: { code: codeFor(secret) },
    });
    expect(ok.statusCode).toBe(204);
    const me = await h.app.inject({ url: '/api/v1/me', headers: h.as(owner) });
    expect(me.json<{ totp_enabled: boolean; totp_required: boolean }>()).toMatchObject({
      totp_enabled: true,
      totp_required: false,
    });
  });

  it('starting enrolment again does not quietly switch two-step sign-in off', async () => {
    // Until 0.4.2 this overwrote the working secret and cleared the
    // confirmation: two-step off, no code asked for — an owner included.
    const again = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/enrol',
      headers: h.as(owner),
    });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ error: { code: string } }>().error.code).toBe('totp_already_on');
    const me = await h.app.inject({ url: '/api/v1/me', headers: h.as(owner) });
    expect(me.json<{ totp_enabled: boolean }>().totp_enabled).toBe(true);
  });

  it('password sign-in now asks for the code, and the code opens the session', async () => {
    const step1 = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { email: 'owner@example.test', password: 'correct horse battery' },
    });
    expect(step1.statusCode).toBe(200);
    const s1 = step1.json<{ mfa_required: boolean; mfa_token: string }>();
    expect(s1.mfa_required).toBe(true);
    expect(s1.mfa_token).toBeTruthy();

    const bad = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa',
      payload: { mfa_token: s1.mfa_token, code: '123456' },
    });
    expect(bad.statusCode).toBe(401);

    const stale = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa',
      payload: { mfa_token: 'not.a.token', code: codeFor(secret) },
    });
    expect(stale.statusCode).toBe(401);
    expect(stale.json<{ error: { code: string } }>().error.code).toBe('mfa_expired');

    const good = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa',
      payload: { mfa_token: s1.mfa_token, code: codeFor(secret) },
    });
    expect(good.statusCode).toBe(200);
    const tokens = good.json<Tokens>();
    expect(tokens.role).toBe('owner');
    const me = await h.app.inject({ url: '/api/v1/me', headers: h.as(tokens) });
    expect(me.statusCode).toBe(200);
  });

  it('an owner cannot switch it off', async () => {
    const off = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/disable',
      headers: h.as(owner),
      payload: { code: codeFor(secret) },
    });
    expect(off.statusCode).toBe(403);
  });

  it('the stored secret is not readable from the database', async () => {
    const row = await h.db
      .selectFrom('account')
      .select('totp_secret')
      .where('email', '=', 'owner@example.test')
      .executeTakeFirstOrThrow();
    expect(row.totp_secret?.toString('latin1')).not.toContain(secret);
  });
});
