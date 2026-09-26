import { verifyAuditChain, withSystem, type Db } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../test-harness.js';
import type { Tokens } from './service.js';

describe.skipIf(!testAdminUrl())('setup and password auth', () => {
  let h: Harness;
  let db: Db;
  let app: FastifyInstance;
  let tokens: Tokens;

  const setupBody = {
    household_name: 'The Test family',
    display_name: 'Mansoor',
    email: 'Owner@Example.test',
    password: 'correct horse battery',
  };

  beforeAll(async () => {
    h = await createHarness();
    db = h.db;
    app = h.app;
  });
  afterAll(() => h.close());

  const json = <T>(res: { json: () => unknown }) => res.json() as T;
  const error = (res: { json: () => unknown }) => json<{ error: { code: string } }>(res).error;

  it('capabilities report setup_required before the first run', async () => {
    const res = await app.inject('/api/v1/capabilities');
    expect(json<{ setup_required: boolean }>(res).setup_required).toBe(true);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('rejects a weak password with the envelope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      payload: { ...setupBody, password: 'short' },
    });
    expect(res.statusCode).toBe(422);
    expect(error(res).code).toBe('validation_failed');
  });

  it('creates the household, owner and a session', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/setup', payload: setupBody });
    expect(res.statusCode).toBe(201);
    tokens = json<Tokens>(res);
    expect(tokens.role).toBe('owner');
    expect(tokens.scopes_unlocked).toEqual(['household', 'adults', 'member']);
    expect(tokens.expires_in).toBe(900);
    expect(tokens.refresh_token.startsWith(`${tokens.household_id}.`)).toBe(true);

    const scopes = await withSystem(db, tokens.household_id, (trx) =>
      trx.selectFrom('scope_key').select(['kind', 'key_wrapped_cred']).orderBy('kind').execute(),
    );
    expect(scopes.map((s) => s.kind).sort()).toEqual(['adults', 'household', 'member']);
    expect(scopes.find((s) => s.kind === 'member')?.key_wrapped_cred).not.toBeNull();

    const caps = json<{ setup_required: boolean; branding: { display_name: string } }>(
      await app.inject('/api/v1/capabilities'),
    );
    expect(caps.setup_required).toBe(false);
    expect(caps.branding.display_name).toBe('The Test family');
  });

  it('refuses to run setup twice', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/setup', payload: setupBody });
    expect(res.statusCode).toBe(409);
    expect(error(res).code).toBe('already_set_up');
  });

  it('a bearer token opens /me; no token does not', async () => {
    const ok = await app.inject({
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(json<{ role: string }>(ok).role).toBe('owner');

    const anon = await app.inject('/api/v1/me');
    expect(anon.statusCode).toBe(401);
    expect(error(anon).code).toBe('unauthenticated');

    const forged = await app.inject({
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${tokens.access_token.slice(0, -2)}xx` },
    });
    expect(forged.statusCode).toBe(401);
  });

  it('signs in with the password, case-insensitively on email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { email: 'owner@example.TEST', password: setupBody.password },
    });
    expect(res.statusCode).toBe(200);
    expect(json<Tokens>(res).member_id).toBe(tokens.member_id);
  });

  it('rejects a wrong password and an unknown email with the same answer', async () => {
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { email: setupBody.email, password: 'not it' },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { email: 'nobody@example.test', password: 'whatever' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(error(wrong).code).toBe('invalid_credentials');
    expect(error(unknown).code).toBe('invalid_credentials');
  });

  it('rotates the refresh token and revokes the session on reuse', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refresh_token: tokens.refresh_token },
    });
    expect(first.statusCode).toBe(200);
    const rotated = json<Tokens>(first);
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);

    // Replay of the old token: theft signal.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refresh_token: tokens.refresh_token },
    });
    expect(replay.statusCode).toBe(401);
    expect(error(replay).code).toBe('session_ended');

    // The rotated token is now dead too, and so is the access token.
    const after = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refresh_token: rotated.refresh_token },
    });
    expect(after.statusCode).toBe(401);
    const me = await app.inject({
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${rotated.access_token}` },
    });
    expect(me.statusCode).toBe(401);
  });

  it('lists devices and revokes one', async () => {
    const a = json<Tokens>(
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/password',
        payload: { email: setupBody.email, password: setupBody.password },
        headers: { 'user-agent': 'phone' },
      }),
    );
    const b = json<Tokens>(
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/password',
        payload: { email: setupBody.email, password: setupBody.password },
        headers: { 'user-agent': 'laptop' },
      }),
    );
    const auth = { authorization: `Bearer ${a.access_token}` };
    const list = json<{ items: Array<{ id: string; current: boolean; user_agent: string }> }>(
      await app.inject({ url: '/api/v1/auth/sessions', headers: auth }),
    );
    expect(list.items.filter((s) => s.current)).toHaveLength(1);
    const laptop = list.items.find((s) => s.user_agent === 'laptop');
    expect(laptop).toBeDefined();

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/sessions/${laptop?.id}`,
      headers: auth,
    });
    expect(del.statusCode).toBe(204);
    const bAfter = await app.inject({
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${b.access_token}` },
    });
    expect(bAfter.statusCode).toBe(401);

    const out = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: auth });
    expect(out.statusCode).toBe(204);
    // The browser forgets what it kept of the vault (0.5.0).
    expect(out.headers['clear-site-data']).toBe('"cache"');
    const aAfter = await app.inject({ url: '/api/v1/me', headers: auth });
    expect(aAfter.statusCode).toBe(401);
  });

  it('wrote a clean audit chain for everything above', async () => {
    const result = await withSystem(db, tokens.household_id, (trx) =>
      verifyAuditChain(trx, tokens.household_id),
    );
    expect(result.ok).toBe(true);
    expect(result.checked).toBeGreaterThanOrEqual(6);
    const actions = await withSystem(db, tokens.household_id, (trx) =>
      trx.selectFrom('audit_event').select('action').orderBy('id').execute(),
    );
    expect(actions.map((a) => a.action)).toContain('household.created');
    expect(actions.map((a) => a.action)).toContain('auth.session_revoked');
    expect(actions.map((a) => a.action)).toContain('auth.signed_out');
  });

  it('rate-limits password attempts', async () => {
    let last = 200;
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/password',
        payload: { email: 'x@example.test', password: 'guess' },
        remoteAddress: '203.0.113.9',
      });
      last = res.statusCode;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });
});
