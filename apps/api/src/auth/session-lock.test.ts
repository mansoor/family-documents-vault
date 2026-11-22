import { randomUUID } from 'node:crypto';
import { withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import { CODE_USED_REASON, SESSION_LOCKED_CODE, type DocumentView } from '@fdv/shared';
import FormData from 'form-data';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appKeyFor, basicFor, createHarness, type Harness } from '../test-harness.js';
import { DEVICE_KEY_ROUTES } from '../devices/routes.js';
import { SESSION_LOCK_ROUTES } from './routes.js';
import type { Tokens } from './service.js';
import { codeFor } from './totp.js';

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

let peers = 0;
const peer = () => `10.86.${(peers >> 8) & 0xff}.${peers++ & 0xff}`;
const codeOf = (r: LightMyRequestResponse) => r.json<{ error?: { code?: string } }>().error?.code;
const refusal = (r: LightMyRequestResponse) => [r.statusCode, codeOf(r)];

/**
 * Lock (0.9.0-dev.86). A session locked by POST /auth/lock is kept locked by
 * the vault: every route that takes a session answers it `423
 * session_locked`, but the few that draw the lock screen, unlock it or sign
 * out; a renewal keeps it; only a credential given again unlocks it. It is
 * one session's: another of the same person's, their phone among them, is
 * not locked, and neither is a connected app nor a link.
 */
describe.skipIf(!testAdminUrl())('locking a session', () => {
  let h: Harness;
  let owner: Tokens;
  let phone: Tokens;
  let sara: Tokens;
  let secret: string;
  let doc: string;
  let version: string;
  let linkToken: string;
  let app: { clientId: string; secret: string };

  const get = (url: string, t: Tokens = owner) =>
    h.app.inject({ url, headers: h.as(t), remoteAddress: peer() });
  const post = (url: string, payload: object = {}, t: Tokens = owner) =>
    h.app.inject({ method: 'POST', url, headers: h.as(t), payload, remoteAddress: peer() });
  const lines = async (action: string) =>
    withSystem(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('audit_event')
        .select(['detail', 'object_type'])
        .where('action', '=', action)
        .execute(),
    );
  const activity = async (t: Tokens) =>
    (await get('/api/v1/audit', t))
      .json<{ items: Array<{ text: string }> }>()
      .items.map((l) => l.text);

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 20_000, signInGuard: true, totpReplay: true });
    owner = await h.setup();
    sara = await h.join(owner, { name: 'Sara', email: 'sara@example.test', role: 'adult' });

    // The owner's phone: another session of the same person, signed in
    // before an authenticator app asks a second step of every sign-in.
    const signedIn = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: { 'x-fdv-installation': randomUUID() },
      payload: { email: 'owner@example.test', password: 'correct horse battery' },
      remoteAddress: peer(),
    });
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    phone = signedIn.json<Tokens>();

    const made = await post('/api/v1/documents', {
      title: 'Electricity bill',
      type_key: 'utility_bill',
    });
    doc = made.json<DocumentView>().id;
    const form = new FormData();
    form.append('file', PDF, { filename: 'bill.pdf', contentType: 'application/pdf' });
    const up = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${doc}/versions`,
      headers: { ...h.as(owner), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    expect(up.statusCode, up.body).toBe(201);
    version = up.json<{ id: string }>().id;

    // An authenticator app, set up here so its code is known.
    const enrol = await post('/api/v1/auth/totp/enrol');
    expect(enrol.statusCode, enrol.body).toBe(200);
    secret = enrol.json<{ secret: string }>().secret;
    const confirmed = await post('/api/v1/auth/totp/confirm', { code: codeFor(secret) });
    expect(confirmed.statusCode, confirmed.body).toBe(204);

    // A link outside the family, and a connected app, made before the lock.
    const shared = await post(`/api/v1/documents/${doc}/share`, { recipient_label: 'the agent' });
    expect(shared.statusCode, shared.body).toBe(201);
    linkToken = shared.json<{ link_token: string }>().link_token;
    await h.decider(owner);
    const connected = await post('/api/v1/connected-apps', {
      name: 'Acme Money',
      member_id: owner.member_id,
      allowed_kinds: ['bank_statement', 'utility_bill'],
    });
    expect(connected.statusCode, connected.body).toBe(201);
    const view = connected.json<{ id: string; scopes: string[] }>();
    app = await appKeyFor(h, owner, view);
  }, 120_000);
  afterAll(() => h?.close());

  it('the capability document says the vault offers it', async () => {
    const caps = await h.app.inject({ url: '/api/v1/capabilities' });
    expect(caps.json<{ features: { session_lock?: boolean } }>().features.session_lock).toBe(true);
    expect((await get('/api/v1/me')).json<{ locked: boolean }>().locked).toBe(false);
  });

  it('locks, once: documents, files, pages, search, notes, Activity and settings answer 423', async () => {
    // A ZIP's ticket made before the lock: refused as it is spent, after.
    const ticket = await post('/api/v1/documents/download/ticket', { document_ids: [doc] });
    expect(ticket.statusCode, ticket.body).toBe(201);
    expect((await post('/api/v1/auth/lock')).statusCode).toBe(204);
    const zip = await get(ticket.json<{ url: string }>().url);
    expect(refusal(zip)).toEqual([423, SESSION_LOCKED_CODE]);
    // Again: locked already, nothing more.
    expect((await post('/api/v1/auth/lock')).statusCode).toBe(204);
    expect(await lines('session.locked')).toHaveLength(1);

    const refused = [
      await get('/api/v1/documents'),
      await get(`/api/v1/documents/${doc}`),
      await get(`/api/v1/versions/${version}/content`),
      await get(`/api/v1/versions/${version}/pages/1`),
      await get('/api/v1/search?q=electricity'),
      await get('/api/v1/notes'),
      await get('/api/v1/audit'),
      await get('/api/v1/notifications/preferences'),
      await get('/api/v1/profile'),
      await get('/api/v1/members'),
      await get('/api/v1/auth/sessions'),
      await post('/api/v1/documents', { title: 'Written while locked', type_key: 'utility_bill' }),
      await post('/api/v1/auth/step-up', { password: 'correct horse battery' }),
      await h.app.inject({
        method: 'PUT',
        url: '/api/v1/profile',
        headers: h.as(owner),
        payload: { display_name: 'Changed while locked' },
      }),
      await post('/api/v1/auth/sessions/sign-out-others'),
    ];
    for (const r of refused) {
      expect(refusal(r)).toEqual([423, SESSION_LOCKED_CODE]);
      expect(r.body).not.toContain('Electricity');
    }
  });

  it('the lock screen is drawn: who it is, how to confirm, a passkey’s challenge and the public routes', async () => {
    const me = await get('/api/v1/me');
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      member_id: owner.member_id,
      totp_enabled: true,
      locked: true,
    });
    expect((await get('/api/v1/auth/step-up')).statusCode).toBe(200);
    const challenge = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkey/challenge',
      payload: {},
      remoteAddress: peer(),
    });
    expect(challenge.statusCode).toBe(200);
    for (const url of ['/api/v1/capabilities', '/healthz', '/readyz']) {
      expect((await h.app.inject({ url, headers: h.as(owner) })).statusCode, url).toBe(200);
    }
    // Exactly the routes that say so: nothing else is let through.
    expect([...SESSION_LOCK_ROUTES].sort()).toEqual(
      [
        'GET /api/v1/auth/step-up',
        'GET /api/v1/me',
        'POST /api/v1/auth/lock',
        'POST /api/v1/auth/logout',
        'POST /api/v1/auth/step-up/text',
        'POST /api/v1/auth/unlock',
      ].sort(),
    );
  });

  it('every route that takes a session but the lock screen’s answers 423, HEAD too: read from the router', async () => {
    const routes = routeTable(h);
    expect(routes.length).toBeGreaterThan(170);
    const asked: string[] = [];
    const wrong: string[] = [];
    for (const r of routes) {
      const key = `${r.method} ${r.url}`;
      // The lock screen's own; and a paired computer's two, which take its key alone.
      if (SESSION_LOCK_ROUTES.has(key) || DEVICE_KEY_ROUTES.has(key)) continue;
      const url = r.url.replace(/:[A-Za-z_]+/g, (p) => (p === ':n' ? '1' : randomUUID()));
      const withBody = r.method === 'GET' || r.method === 'DELETE' ? {} : { payload: {} };
      // Whether it takes a session: asked with none, it says to sign in.
      const anon = await h.app.inject({
        method: r.method as 'GET',
        url,
        ...withBody,
        remoteAddress: peer(),
      });
      if (anon.statusCode !== 401 || codeOf(anon) !== 'unauthenticated') continue;
      asked.push(key);
      const locked = await h.app.inject({
        method: r.method as 'GET',
        url,
        headers: h.as(owner),
        ...withBody,
        remoteAddress: peer(),
      });
      if (locked.statusCode !== 423 || codeOf(locked) !== SESSION_LOCKED_CODE) {
        wrong.push(`${key} → ${locked.statusCode} ${codeOf(locked) ?? ''}`);
      }
      // The activity log's CSV has no HEAD (0.9.0-dev.82).
      if (r.method === 'GET' && r.url !== '/api/v1/audit/export') {
        const head = await h.app.inject({
          method: 'HEAD',
          url,
          headers: h.as(owner),
          remoteAddress: peer(),
        });
        if (head.statusCode !== 423) wrong.push(`HEAD ${r.url} → ${head.statusCode}`);
      }
    }
    expect(wrong).toEqual([]);
    expect(asked.length).toBeGreaterThan(150);
    for (const key of [
      'GET /api/v1/search/sealed',
      'GET /api/v1/offline/essentials',
      'GET /api/v1/versions/:id/thumbnail',
      'GET /api/v1/documents',
      'POST /api/v1/auth/step-up',
    ]) {
      expect(asked).toContain(key);
    }
  }, 180_000);

  it('a renewal keeps it locked: the renewed access token is refused as the last', async () => {
    const renewed = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refresh_token: owner.refresh_token },
      remoteAddress: peer(),
    });
    expect(renewed.statusCode, renewed.body).toBe(200);
    owner = renewed.json<Tokens>();
    expect(refusal(await get('/api/v1/documents'))).toEqual([423, SESSION_LOCKED_CODE]);
    expect((await get('/api/v1/me')).json<{ locked: boolean }>().locked).toBe(true);
  });

  it('another session of the same person is not locked — their phone, which never sees a 423', async () => {
    const list = await get('/api/v1/documents', phone);
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain('Electricity bill');
    expect((await get('/api/v1/me', phone)).json<{ locked: boolean }>().locked).toBe(false);
    // Nor can it unlock this one: the lock is the session's own. Not locked
    // itself, its unlock is only a step-up, and writes no line of unlocking.
    expect(
      (await post('/api/v1/auth/unlock', { password: 'correct horse battery' }, phone)).statusCode,
    ).toBe(200);
    expect(await lines('session.unlocked')).toEqual([]);
    expect(refusal(await get('/api/v1/documents'))).toEqual([423, SESSION_LOCKED_CODE]);
  });

  it('a connected app and a link outside the family are not asked', async () => {
    const asApp = await h.app.inject({
      url: '/api/v1/apps/me',
      headers: { ...basicFor(app), 'x-forwarded-for': peer() },
      remoteAddress: '127.0.0.1',
    });
    expect(asApp.statusCode, asApp.body).toBe(200);
    const opened = await h.app.inject({
      method: 'POST',
      url: '/api/v1/shared/unlock',
      payload: { token: linkToken },
      remoteAddress: peer(),
    });
    expect(opened.statusCode, opened.body).toBe(200);
  });

  it('unlocking takes a credential given again: a wrong password, or a code used already, is refused', async () => {
    const wrong = await post('/api/v1/auth/unlock', { password: 'not the password' });
    expect(refusal(wrong)).toEqual([401, 'invalid_credentials']);
    // A code taken already: by the phone, confirming it's them a moment ago.
    const code = codeFor(secret, Date.now() + 30_000);
    expect((await post('/api/v1/auth/step-up', { code }, phone)).statusCode).toBe(200);
    const used = await post('/api/v1/auth/unlock', { code });
    expect(refusal(used)).toEqual([401, 'invalid_credentials']);
    expect(used.json<{ error: { reason?: string } }>().error.reason).toBe(CODE_USED_REASON);
    const nothing = await post('/api/v1/auth/unlock', {});
    expect(refusal(nothing)).toEqual([422, 'validation_failed']);
    expect(refusal(await get('/api/v1/documents'))).toEqual([423, SESSION_LOCKED_CODE]);
    expect(await lines('session.unlocked')).toEqual([]);

    const right = await post('/api/v1/auth/unlock', { password: 'correct horse battery' });
    expect(right.statusCode, right.body).toBe(200);
    expect(right.json<{ expires_in: number }>().expires_in).toBeGreaterThan(250);
    const list = await get('/api/v1/documents');
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain('Electricity bill');
    expect((await get('/api/v1/me')).json<{ locked: boolean }>().locked).toBe(false);
    expect(await lines('session.unlocked')).toEqual([
      { object_type: 'session', detail: { method: 'password' } },
    ]);
    // Unlocked already: confirmed again, and nothing more written.
    expect(
      (await post('/api/v1/auth/unlock', { password: 'correct horse battery' })).statusCode,
    ).toBe(200);
    expect(await lines('session.unlocked')).toHaveLength(1);
  });

  it('wrong tries are counted as confirming it’s you counts them, on the session alone', async () => {
    expect((await post('/api/v1/auth/lock')).statusCode).toBe(204);
    const answers: Array<Array<number | string | undefined>> = [];
    for (let i = 0; i < 6; i++) {
      answers.push(refusal(await post('/api/v1/auth/unlock', { password: `wrong ${i}` })));
    }
    // Five failures at most, then it waits, as a step-up's tries do.
    const wrong = answers.filter(([status]) => status === 401);
    expect(wrong.length).toBeGreaterThan(0);
    expect(wrong.length).toBeLessThanOrEqual(5);
    expect(answers.slice(wrong.length)).toEqual(
      Array.from({ length: 6 - wrong.length }, () => [429, 'sign_in_throttled']),
    );
    // Never the person's sign-in: their phone goes on.
    expect((await get('/api/v1/documents', phone)).statusCode).toBe(200);
  });

  it('the Activity lines name the person, for whoever reads a sign-in’s lines', async () => {
    for (const t of [phone, sara]) {
      const said = await activity(t);
      expect(said).toContain('Owner signed in');
      expect(said).toContain('Owner locked the vault in one browser');
      expect(said).toContain('Owner unlocked the vault in one browser');
    }
  });

  it('signing out works while locked', async () => {
    const out = await post('/api/v1/auth/logout');
    expect(out.statusCode).toBe(204);
    expect(refusal(await get('/api/v1/me'))).toEqual([401, 'session_ended']);
  });
});

/** Every route the router has, with its method: `printRoutes`, read as apps.test.ts reads it. */
function routeTable(h: Harness): Array<{ method: string; url: string }> {
  const out: Array<{ method: string; url: string }> = [];
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    const tree = h.app.printRoutes({ method: method as 'GET', commonPrefix: false });
    const stack: string[] = [];
    for (const line of tree.split('\n')) {
      const m = /^([│ ]*)(?:├── |└── )(.*?)(?: \(([A-Z, ]+)\))?$/.exec(line.replace(/\r$/, ''));
      if (!m) continue;
      const depth = (m[1] as string).length / 4;
      stack.length = depth;
      stack.push(m[2] as string);
      if (
        (m[3] ?? '')
          .split(',')
          .map((x) => x.trim())
          .includes(method)
      ) {
        out.push({ method, url: stack.join('') });
      }
    }
  }
  return out;
}
