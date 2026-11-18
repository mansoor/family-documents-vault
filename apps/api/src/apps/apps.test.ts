import { createHash, randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { multipartBody } from '@fdv/client';
import { createPool, withPrincipal } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  type AppIntakeState,
  type AppMe,
  type BatchDetail,
  type BatchView,
  type ConnectedAppKeyMade,
  type ConnectedAppList,
  type ConnectedAppView,
  type Tokens,
} from '@fdv/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  alertsSent,
  appKeyFor,
  basicFor,
  createHarness,
  type Harness,
  type TestAppKey,
} from '../test-harness.js';
import {
  addressBucket,
  newClientId,
  newSecret,
  presentsBasic,
  readBasic,
  secretHash,
  secretMatches,
} from './keys.js';
import { APP_ROUTES } from './routes.js';

/**
 * Connected apps (0.9.0, APP1): an owner connects one with a passkey or a
 * code, generates its API keys (APP6), it sends one on every request as
 * HTTP Basic, and what it sends goes into its person's Inbox, followed by
 * its external id.
 */

const PDF = (marker: string) =>
  Buffer.from(
    `%PDF-1.4\n% ${marker}\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
  );
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

interface TestApp extends TestAppKey {
  appId: string;
  view: ConnectedAppView;
}

interface CallOptions {
  body?: Buffer;
  contentType?: string;
  /** Headers added or replaced after the key's. */
  headers?: Record<string, string>;
  /** The caller's address, as a trusted proxy on this machine says it (X-Forwarded-For). */
  remoteAddress?: string;
  /** The connection's own address, said by nothing but the socket. */
  socket?: string;
  /** Another key, or another secret, than the app's own. */
  key?: { clientId: string; secret: string };
}

/** The connected apps' clock, ahead of the real one by this much: a test moves it. */
let clockOffset = 0;
/** Or held still at this instant, while a test counts within one minute. */
let clockHeld: number | null = null;

let peers = 0;
const peer = () => `10.72.${(peers >> 8) & 0xff}.${peers++ & 0xff}`;
const codeOf = (r: { json: () => unknown }) =>
  (r.json() as { error?: { code?: string } }).error?.code;
/** What the API's request log said, at its most talkative. */
const logged: string[] = [];

/**
 * The harness's DNS for the names in an allow-list (APP7): a name's A and
 * AAAA addresses, or a failure; and every lookup asked of it, by name.
 */
const dnsTable = new Map<
  string,
  { v4?: string[]; v6?: string[]; ttl?: number } | 'fail' | 'hang'
>();
const dnsAsked: string[] = [];

describe.skipIf(!testAdminUrl())('connected apps (0.9.0, APP1)', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  let owner: Tokens;
  let ahmed: Tokens;
  let sara: Tokens;
  let teen: Tokens;

  const send = (t: Tokens, method: string, url: string, payload?: unknown) =>
    h.app.inject({
      method: method as 'GET',
      url,
      headers: h.as(t),
      ...(payload === undefined ? {} : { payload: payload as never }),
      remoteAddress: peer(),
    });

  /** An owner connects an app, with a code just given, and generates its key. */
  async function connect(
    by: Tokens,
    input: Partial<{
      member_id: string;
      allowed_kinds: string[];
      name: string;
      ip_allow: string[];
      default_visibility: string | null;
      daily_files: number;
      scopes: string[];
    }> = {},
  ): Promise<TestApp> {
    await h.decider(by);
    const res = await send(by, 'POST', '/api/v1/connected-apps', {
      name: 'Acme Money',
      member_id: by.member_id,
      allowed_kinds: ['bank_statement', 'utility_bill', 'credit_card_statement'],
      ...input,
    });
    expect(res.statusCode, res.body).toBe(201);
    const view = res.json<ConnectedAppView>();
    return { appId: view.id, ...(await appKeyFor(h, by, view)), view };
  }

  /** A request sent as the app, with its key. */
  async function call(
    a: TestApp,
    method: 'GET' | 'POST' | 'DELETE',
    target: string,
    o: CallOptions = {},
  ): Promise<LightMyRequestResponse> {
    return h.app.inject({
      method,
      url: target,
      headers: {
        ...basicFor(o.key ?? a),
        ...(o.contentType ? { 'content-type': o.contentType } : {}),
        // From this machine — a vault on localhost takes plain http only so —
        // through a proxy here that says who is asking.
        ...(o.socket ? {} : { 'x-forwarded-for': o.remoteAddress ?? peer() }),
        ...o.headers,
      },
      ...(o.body ? { payload: o.body } : {}),
      remoteAddress: o.socket ?? '127.0.0.1',
    });
  }

  /** A file sent, with its metadata. */
  function intake(
    a: TestApp,
    externalId: string,
    file: { bytes: Buffer; name?: string; type?: string } = { bytes: PDF('SENT') },
    hints?: Record<string, unknown>,
    o: CallOptions = {},
  ) {
    const body = multipartBody([
      {
        name: 'metadata',
        value: JSON.stringify({ external_id: externalId, ...(hints ? { hints } : {}) }),
      },
      {
        name: 'file',
        filename: file.name ?? 'statement.pdf',
        contentType: file.type ?? 'application/pdf',
        bytes: new Uint8Array(file.bytes),
      },
    ]);
    return call(a, 'POST', '/api/v1/apps/intake', {
      body: Buffer.from(body.bytes),
      contentType: body.contentType,
      ...o,
    });
  }

  const me = (a: TestApp, o: CallOptions = {}) => call(a, 'GET', '/api/v1/apps/me', o);
  const status = (a: TestApp, id: string) => call(a, 'GET', `/api/v1/apps/intake/${id}`);
  const lines = async (t: Tokens) =>
    (await send(t, 'GET', '/api/v1/audit?limit=100'))
      .json<{ items: Array<{ text: string }> }>()
      .items.map((l) => l.text);
  const appsOf = async (t: Tokens) =>
    (await send(t, 'GET', '/api/v1/connected-apps')).json<ConnectedAppList>();
  const batchesOf = async (t: Tokens) =>
    (await send(t, 'GET', '/api/v1/batches')).json<{ items: BatchView[] }>().items;

  /** A key past its expiry, as the database's clock would have it. */
  async function expire(clientId: string) {
    const c = await admin.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      await c.query(
        `update connected_app_key set created_at = now() - interval '2 days',
                expires_at = now() - interval '5 minutes' where client_id = $1`,
        [clientId],
      );
      await c.query('commit');
    } finally {
      c.release();
    }
  }

  beforeAll(async () => {
    h = await createHarness({
      rateLimitPerMinute: 20_000,
      publicApps: 'on',
      appsNow: () => clockHeld ?? Date.now() + clockOffset,
      appsResolve: async (name, family) => {
        dnsAsked.push(`${name}/${family}`);
        const r = dnsTable.get(name);
        // A lookup that never answers: the vault's timeout ends it.
        if (r === 'hang') return new Promise(() => undefined);
        if (r === 'fail' || r === undefined) {
          throw Object.assign(new Error(`no answer for ${name}`), {
            code: r === 'fail' ? 'ETIMEOUT' : 'ENOTFOUND',
          });
        }
        const list = (family === 4 ? r.v4 : r.v6) ?? [];
        return list.map((address) => ({ address, ttl: r.ttl ?? 300 }));
      },
      logger: { level: 'trace', stream: { write: (s: string) => void logged.push(s) } },
    });
    admin = createPool(h.adminUrl, 1);
    owner = await h.setup();
    ahmed = await h.join(owner, { name: 'Ahmed Khan', email: 'ahmed@example.test', role: 'adult' });
    sara = await h.join(owner, { name: 'Sara Khan', email: 'sara@example.test', role: 'adult' });
    teen = await h.join(owner, { name: 'Tariq', email: 'tariq@example.test', role: 'teen' });
  }, 120_000);
  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  // ------------------------------------------------------------ API keys

  it('an API key is a client ID and a secret as the vault makes them, read strictly from Basic', () => {
    const id = newClientId();
    const secret = newSecret();
    expect(id).toMatch(/^fdvc_[A-Za-z0-9_-]{22}$/);
    expect(secret).toMatch(/^fdvs_[A-Za-z0-9_-]{43}$/);
    expect(newSecret()).not.toBe(secret);
    const basic = (s: string) => ({ authorization: `Basic ${Buffer.from(s).toString('base64')}` });
    expect(readBasic(basic(`${id}:${secret}`))).toEqual({ kind: 'basic', clientId: id, secret });
    expect(
      readBasic({ authorization: `basic  ${Buffer.from(`${id}:${secret}`).toString('base64')}` }),
    ).toMatchObject({ kind: 'basic' });
    // A client ID's user part, but not as the vault writes keys: malformed.
    for (const bad of [
      `${id}${secret}`,
      `${id}:`,
      `${id}:${secret}x`,
      `fdvc_short:${secret}`,
      `${id}:${secret.slice(5)}`,
    ]) {
      expect(readBasic(basic(bad)), bad).toEqual({ kind: 'malformed' });
    }
    const twice = { authorization: [basic(`${id}:${secret}`).authorization, 'Basic a'] };
    expect(readBasic(twice)).toEqual({ kind: 'malformed' });
    // Basic that is no app's — a proxy's login in front of the vault — is
    // not taken for a key at all.
    for (const theirs of [`alice:correct horse`, `:${secret}`, `fdv:${secret}`, 'nobody']) {
      expect(readBasic(basic(theirs)), theirs).toEqual({ kind: 'none' });
      expect(presentsBasic(basic(theirs)), theirs).toBe(false);
    }
    expect(readBasic({ authorization: 'Basic not base64!' })).toEqual({ kind: 'none' });
    expect(readBasic({ authorization: ['Basic a', 'Basic b'] })).toEqual({ kind: 'none' });
    expect(readBasic({ authorization: 'Bearer abc' })).toEqual({ kind: 'none' });
    expect(readBasic({})).toEqual({ kind: 'none' });
    expect(presentsBasic(basic(`${id}:${secret}`))).toBe(true);
    expect(presentsBasic(basic(`${id}:wrong`))).toBe(true);
    expect(presentsBasic({ authorization: 'Bearer x' })).toBe(false);
    // Failures are counted by address: an IPv6 one by its /64.
    expect(addressBucket('198.51.100.7')).toBe('198.51.100.7');
    expect(addressBucket('::ffff:198.51.100.7')).toBe('198.51.100.7');
    expect(addressBucket('2001:db8:5:6::1')).toBe('2001:db8:5:6::/64');
    expect(addressBucket('2001:0DB8:0005:0006:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:5:6::/64');
    expect(addressBucket('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(addressBucket('::1')).toBe('0:0:0:0::/64');
    // Kept as its SHA-256, compared in constant time; nothing matches no hash.
    expect(secretHash(secret)).toHaveLength(32);
    expect(secretMatches(secret, secretHash(secret))).toBe(true);
    expect(secretMatches(newSecret(), secretHash(secret))).toBe(false);
    expect(secretMatches(secret, null)).toBe(false);
    expect(secretMatches('', undefined)).toBe(false);
  });

  // ------------------------------------------------------------ connecting

  it('an owner connects an app with a passkey or a code, never the password alone, then generates its key', async () => {
    const body = {
      name: 'Acme Money',
      member_id: owner.member_id,
      allowed_kinds: ['bank_statement'],
    };
    // An adult is refused; an owner with only a password is told to turn on two-step.
    expect(codeOf(await send(ahmed, 'POST', '/api/v1/connected-apps', body))).toBe('forbidden');
    const passwordOnly = await send(owner, 'POST', '/api/v1/connected-apps', body);
    expect([passwordOnly.statusCode, codeOf(passwordOnly)]).toEqual([
      403,
      'totp_required_for_owner',
    ]);
    await h.decider(owner);
    // What it is given is checked: a person who may be acted as, kinds the household has.
    for (const [bad, field] of [
      [{ member_id: teen.member_id }, 'member_id'],
      [{ allowed_kinds: ['no_such_kind'] }, 'allowed_kinds'],
      [{ ip_allow: ['not-an-address'] }, 'ip_allow'],
      [{ daily_files: 5000 }, 'daily_files'],
    ] as const) {
      const res = await send(owner, 'POST', '/api/v1/connected-apps', { ...body, ...bad });
      expect([res.statusCode, res.json<{ error: { detail: string } }>().error.detail]).toEqual([
        422,
        field,
      ]);
    }
    // A public key is no longer anything an app is given.
    const signedOnce = await send(owner, 'POST', '/api/v1/connected-apps', {
      ...body,
      public_key: 'ed25519:JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs',
    });
    expect(signedOnce.statusCode).toBe(422);
    const made = await send(owner, 'POST', '/api/v1/connected-apps', body);
    expect(made.statusCode, made.body).toBe(201);
    const view = made.json<ConnectedAppView>();
    expect(view).toMatchObject({
      name: 'Acme Money',
      member_name: 'Owner',
      mine: true,
      state: 'active',
      scopes: ['documents.send'],
      allowed_kinds: ['bank_statement'],
      daily_files: 100,
      daily_bytes: 500 * 1024 * 1024,
      address: { url: 'http://localhost:8080', public: false },
      // No key until an owner generates one, so nothing to paste yet.
      keys: [],
      connection_string: '',
    });

    // Its key: the client ID and the secret, this once.
    const gen = await send(owner, 'POST', `/api/v1/connected-apps/${view.id}/keys`, {
      name: 'Acme Money, live',
      permissions: ['documents.send'],
      expires_in_days: 90,
    });
    expect(gen.statusCode, gen.body).toBe(201);
    expect(gen.headers['cache-control']).toBe('no-store');
    const key = gen.json<ConnectedAppKeyMade>();
    expect(key.client_id).toMatch(/^fdvc_[A-Za-z0-9_-]{22}$/);
    expect(key.secret).toMatch(/^fdvs_[A-Za-z0-9_-]{43}$/);
    expect(key.key).toMatchObject({
      client_id: key.client_id,
      name: 'Acme Money, live',
      permissions: ['documents.send'],
      last_used_at: null,
      revoked_at: null,
      state: 'live',
    });
    const days =
      (Date.parse(key.key.expires_at as string) - Date.parse(key.key.created_at)) / 864e5;
    expect(days).toBeCloseTo(90, 3);
    // The connection string: the address, the client ID — and the secret
    // only in the one the owner chooses to copy with it.
    const decode = (s: string) => {
      expect(s.startsWith('fdvapp2.')).toBe(true);
      return JSON.parse(
        Buffer.from(s.slice('fdvapp2.'.length), 'base64url').toString('utf8'),
      ) as Record<string, unknown>;
    };
    expect(decode(key.connection_string)).toEqual({
      url: 'http://localhost:8080',
      client_id: key.client_id,
      instance_id: expect.any(String) as string,
    });
    expect(decode(key.connection_string_with_secret)).toEqual({
      url: 'http://localhost:8080',
      client_id: key.client_id,
      instance_id: expect.any(String) as string,
      secret: key.secret,
    });
    // Kept as a hash alone: nothing the vault keeps, or lists, holds the secret.
    const kept = await admin.query<{ row: string; hash: Buffer }>(
      `select row_to_json(k)::text as row, secret_hash as hash from connected_app_key k where client_id = $1`,
      [key.client_id],
    );
    expect(kept.rows[0]?.hash.equals(createHash('sha256').update(key.secret).digest())).toBe(true);
    expect(kept.rows[0]?.row).not.toContain(key.secret);
    const listed = await appsOf(owner);
    expect(JSON.stringify(listed)).not.toContain(key.secret);
    const shown = listed.items.find((x) => x.id === view.id) as ConnectedAppView;
    expect(shown.keys).toEqual([key.key]);
    expect(decode(shown.connection_string)).toEqual(decode(key.connection_string));

    // The connection test, with it.
    const a: TestApp = {
      appId: view.id,
      keyId: key.key.id,
      clientId: key.client_id,
      secret: key.secret,
      view,
    };
    const res = await me(a);
    expect(res.statusCode, res.body).toBe(200);
    const said = res.json<AppMe>();
    expect(said).toMatchObject({
      app: { id: view.id, name: 'Acme Money' },
      state: 'active',
      acting_as: { name: 'Owner' },
      scopes: ['documents.send'],
      send: { auto_file: false },
      backfill: null,
    });
    expect(said.send.kinds.map((k) => k.key)).toEqual(['bank_statement']);
    expect(said.send.kinds[0]?.fields).toEqual(expect.arrayContaining(['account_last4', 'period']));
    expect(said.limits).toMatchObject({
      files_per_day: 100,
      files_today: 0,
      requests_per_minute: 120,
    });
    // The key that made the call, and nothing of any other; never its secret.
    expect(said.key).toEqual({
      client_id: key.client_id,
      name: 'Acme Money, live',
      permissions: ['documents.send'],
      created_at: key.key.created_at,
      expires_at: key.key.expires_at,
      last_used_at: expect.any(String) as string,
    });
    expect('keys' in said).toBe(false);
    expect(res.body).not.toContain(key.secret);
    // An answer carries what the contract says every answer carries.
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.headers['x-fdv-server-version']).toBeTruthy();
    expect(res.headers['set-cookie']).toBeUndefined();
    // Its use noted on the key and on the app.
    expect(
      (await appsOf(owner)).items.find((x) => x.id === view.id)?.keys[0]?.last_used_at,
    ).not.toBeNull();
    const said2 = await lines(owner);
    expect(said2).toContain('Owner connected Acme Money, acting as themselves');
    expect(said2).toContain('Owner generated an API key for Acme Money');
    // And no request log line, at its most talkative, holds the secret or the header.
    const log = logged.join('\n');
    expect(log).not.toContain(key.secret);
    expect(log).not.toContain(basicFor(a).authorization.slice('Basic '.length));
    expect(log).not.toMatch(/Basic [A-Za-z0-9+/]{20,}/);
  });

  it('an app acting as another adult waits until they turn it on, and only they may', async () => {
    const a = await connect(owner, { member_id: ahmed.member_id, name: 'Ledger' });
    expect(a.view.state).toBe('waiting_for_approval');
    // Ahmed is told, by email alone.
    expect(alertsSent(h).some((m) => m.subject === 'Ledger was connected to your sign-in')).toBe(
      true,
    );
    // Its connection test answers, and says so; anything else is refused.
    expect((await me(a)).json<AppMe>().state).toBe('waiting_for_approval');
    const early = await intake(a, 'early-1');
    expect([early.statusCode, codeOf(early)]).toEqual([403, 'app_not_approved']);
    // Ahmed sees it; Sara and the teen see no app at all.
    expect((await appsOf(ahmed)).items.find((x) => x.id === a.appId)).toMatchObject({ mine: true });
    expect((await appsOf(sara)).items).toEqual([]);
    expect((await appsOf(teen)).items).toEqual([]);
    // An owner cannot turn it on for him; Ahmed must give a passkey or a code.
    expect(
      (await send(owner, 'POST', `/api/v1/connected-apps/${a.appId}/approve`)).statusCode,
    ).toBe(404);
    const noFactor = await send(ahmed, 'POST', `/api/v1/connected-apps/${a.appId}/approve`);
    expect([noFactor.statusCode, codeOf(noFactor)]).toEqual([403, 'two_step_required']);
    // Nor may anybody but an owner widen what it may do.
    expect(
      (await send(ahmed, 'PATCH', `/api/v1/connected-apps/${a.appId}`, { daily_files: 900 }))
        .statusCode,
    ).toBe(403);
    await h.decider(ahmed);
    const on = await send(ahmed, 'POST', `/api/v1/connected-apps/${a.appId}/approve`);
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json<ConnectedAppView>().state).toBe('active');
    expect((await me(a)).json<AppMe>().state).toBe('active');
    expect(await lines(ahmed)).toContain('Ahmed Khan turned on Ledger, which acts as them');
  });

  // ------------------------------------------------------------ refusals

  it('every refusal of the contract’s order is reachable, each with its own code', async () => {
    const a = await connect(owner, { name: 'Checks' });
    const ok = await me(a);
    expect(ok.statusCode).toBe(200);
    const valid = basicFor(a);
    const raw = (headers: Record<string, string>) =>
      h.app.inject({
        url: '/api/v1/apps/me',
        headers: { 'x-forwarded-for': peer(), ...headers },
        remoteAddress: '127.0.0.1',
      });
    const refusal = async (r: LightMyRequestResponse | Promise<LightMyRequestResponse>) => {
      const res = await r;
      return [res.statusCode, codeOf(res)];
    };

    // 1. Basic, and nothing else that names a caller.
    expect(await refusal(raw({}))).toEqual([401, 'app_key_required']);
    expect(await refusal(raw(h.as(owner)))).toEqual([401, 'app_key_required']);
    expect(await refusal(raw({ ...valid, cookie: 'fdv_share=abc' }))).toEqual([
      401,
      'app_key_required',
    ]);
    expect(await refusal(raw({ authorization: `Device ${randomUUID()}.key` }))).toEqual([
      401,
      'app_key_required',
    ]);
    // A sign-in alone on an app route: told to send the app's key.
    expect(await refusal(send(owner, 'GET', '/api/v1/apps/me'))).toEqual([401, 'app_key_required']);

    // 2. A client ID the vault made, and its secret: an unknown ID, a wrong
    // secret and a key not written as the vault writes them are one answer,
    // word for word.
    const unknown = await call(a, 'GET', '/api/v1/apps/me', {
      key: { clientId: newClientId(), secret: a.secret },
    });
    const wrong = await call(a, 'GET', '/api/v1/apps/me', {
      key: { clientId: a.clientId, secret: newSecret() },
    });
    // A client ID's user part, but nothing the vault made: a key not right.
    const garbled = await raw({
      authorization: `Basic ${Buffer.from('fdvc_not:a key').toString('base64')}`,
    });
    for (const r of [unknown, wrong, garbled]) {
      expect([r.statusCode, codeOf(r)]).toEqual([401, 'app_key_invalid']);
    }
    const message = (r: LightMyRequestResponse) =>
      r.json<{ error: { message: string } }>().error.message;
    expect(message(wrong)).toBe(message(unknown));
    expect(message(garbled)).toBe(message(unknown));

    // 3. Paused: refused, but for the connection test, which says why.
    await send(owner, 'POST', `/api/v1/connected-apps/${a.appId}/pause`);
    expect(await refusal(call(a, 'GET', '/api/v1/apps/intake/x1'))).toEqual([403, 'app_paused']);
    expect((await me(a)).json<AppMe>()).toMatchObject({ state: 'paused', paused_reason: 'owner' });
    await h.decider(owner);
    expect((await send(owner, 'POST', `/api/v1/connected-apps/${a.appId}/resume`)).statusCode).toBe(
      200,
    );

    // 4. From an address it may come from: IPv4 and an IPv6 /64.
    await h.decider(owner);
    const allow = (list: string[]) =>
      send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, { ip_allow: list });
    expect(
      (await allow(['203.0.113.0/24', '2001:db8:1:2::/64'])).json<ConnectedAppView>().ip_allow,
    ).toEqual(['2001:db8:1:2::/64', '203.0.113.0/24']);
    expect(await refusal(me(a, { remoteAddress: '198.51.100.7' }))).toEqual([
      403,
      'address_not_allowed',
    ]);
    expect((await me(a, { remoteAddress: '203.0.113.9' })).statusCode).toBe(200);
    expect((await me(a, { remoteAddress: '2001:db8:1:2::5' })).statusCode).toBe(200);
    expect(await refusal(me(a, { remoteAddress: '2001:db8:1:3::5' }))).toEqual([
      403,
      'address_not_allowed',
    ]);
    // An address it wrote itself is not believed: the connection's is.
    expect(
      await refusal(
        me(a, { socket: '198.51.100.7', headers: { 'x-forwarded-for': '203.0.113.9' } }),
      ),
    ).toEqual([403, 'address_not_allowed']);
    await allow([]);

    // 5. The route in its scopes (what the connection test is not).
    await admin.query(`update connected_app set scopes = '{documents.read}' where id = $1`, [
      a.appId,
    ]);
    expect(await refusal(call(a, 'GET', '/api/v1/apps/intake/x1'))).toEqual([
      403,
      'scope_not_granted',
    ]);
    expect((await me(a)).statusCode).toBe(200);
    await admin.query(`update connected_app set scopes = '{documents.send}' where id = $1`, [
      a.appId,
    ]);

    // 6. A key revoked: refused from its very next request; and one past
    // its expiry.
    await h.decider(owner);
    const b = await appKeyFor(h, owner, a.view, { expires_in_days: 1 });
    const withB = { ...a, ...b };
    expect((await me(withB)).statusCode).toBe(200);
    expect(
      (await send(owner, 'DELETE', `/api/v1/connected-apps/${a.appId}/keys/${a.keyId}`)).statusCode,
    ).toBe(204);
    expect(await refusal(me(a))).toEqual([401, 'app_key_revoked']);
    await expire(b.clientId);
    expect(await refusal(me(withB))).toEqual([401, 'app_key_expired']);

    // Refusals are counted, not a line each: one notable line today.
    const view = (await appsOf(owner)).items.find((x) => x.id === a.appId) as ConnectedAppView;
    expect(view.refused_today).toBeGreaterThanOrEqual(6);
    expect(view.last_refusal).toBe('app_key_expired');
    const refused = (await lines(owner)).filter((l) => l.startsWith('Requests from Checks'));
    expect(refused).toEqual([expect.stringMatching(/^Requests from Checks were refused today/)]);

    // Removed: its next request is told so, whichever key; its keys revoked with it.
    expect((await send(owner, 'DELETE', `/api/v1/connected-apps/${a.appId}`)).statusCode).toBe(204);
    expect(await refusal(me(withB))).toEqual([401, 'app_revoked']);
    expect((await appsOf(owner)).items.some((x) => x.id === a.appId)).toBe(false);
    expect(await lines(owner)).toContain('Owner removed Checks');
    const live = await admin.query(
      'select 1 from connected_app_key where app_id = $1 and revoked_at is null',
      [a.appId],
    );
    expect(live.rowCount).toBe(0);
  }, 120_000);

  it('an allow-list takes host names: the addresses a name points to now, cached, failing closed (APP7)', async () => {
    const a = await connect(owner, { name: 'By name' });
    const allow = async (list: string[]) => {
      await h.decider(owner);
      return send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, { ip_allow: list });
    };
    const from = async (address: string) => {
      const r = await me(a, { remoteAddress: address });
      return r.statusCode === 200 ? 'in' : codeOf(r);
    };
    const asked = (name: string) => dnsAsked.filter((q) => q.startsWith(`${name}/`)).length;

    // Names, checked and kept as the vault writes them, after the networks.
    dnsTable.set('feeds.example.com', { v4: ['203.0.113.40'], v6: ['2001:db8:5:6::40'] });
    dnsTable.set('elsewhere.example.net', { v4: ['198.51.100.99'] });
    const set = await allow(['Feeds.Example.com', '192.0.2.0/24', 'elsewhere.example.net.']);
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json<ConnectedAppView>().ip_allow).toEqual([
      '192.0.2.0/24',
      'elsewhere.example.net',
      'feeds.example.com',
    ]);
    const kept = await admin.query<{ ip_allow: string[]; ip_allow_names: string[] }>(
      'select ip_allow::text[] as ip_allow, ip_allow_names from connected_app where id = $1',
      [a.appId],
    );
    expect(kept.rows[0]).toEqual({
      ip_allow: ['192.0.2.0/24'],
      ip_allow_names: ['elsewhere.example.net', 'feeds.example.com'],
    });

    // A name that points to the caller lets it in, IPv4 and IPv6 exactly;
    // a network still does; anything else is refused.
    expect(await from('203.0.113.40')).toBe('in');
    expect(await from('2001:db8:5:6::40')).toBe('in');
    expect(await from('::ffff:203.0.113.40')).toBe('in');
    expect(await from('192.0.2.77')).toBe('in');
    expect(await from('203.0.113.41')).toBe('address_not_allowed');
    expect(await from('2001:db8:5:6::41')).toBe('address_not_allowed');

    // The answers are kept: many requests, one lookup a name and family.
    for (let i = 0; i < 5; i++) expect(await from('198.51.100.99')).toBe('in');
    expect(asked('feeds.example.com')).toBe(2);
    expect(asked('elsewhere.example.net')).toBe(2);

    // Past their TTL (five minutes at most), asked again: the name now
    // points elsewhere, and the old address is refused.
    dnsTable.set('feeds.example.com', { v4: ['203.0.113.50'] });
    clockOffset += 6 * 60_000;
    try {
      expect(await from('203.0.113.40')).toBe('address_not_allowed');
      expect(await from('203.0.113.50')).toBe('in');
      expect(asked('feeds.example.com')).toBe(4);
    } finally {
      clockOffset -= 6 * 60_000;
    }

    // A name that cannot be looked up, with no answer kept: nothing in, and
    // the failure kept a little while (one lookup for many requests).
    dnsTable.set('down.example.org', 'fail');
    await allow(['down.example.org']);
    expect(await from('203.0.113.40')).toBe('address_not_allowed');
    expect(await from('203.0.113.40')).toBe('address_not_allowed');
    expect(asked('down.example.org')).toBe(2);
    // A name with no such host: nothing in.
    await allow(['nowhere.example.org']);
    expect(await from('203.0.113.40')).toBe('address_not_allowed');

    // A name that matches never waits for another's slow lookup: the one
    // known is asked first, and the first match answers.
    dnsTable.set('slow.example.org', 'hang');
    await allow(['slow.example.org', 'feeds.example.com']);
    let started = Date.now();
    expect(await from('203.0.113.50')).toBe('in');
    expect(Date.now() - started).toBeLessThan(1_500);
    dnsTable.set('quick.example.org', { v4: ['203.0.113.60'] });
    await allow(['slow.example.org', 'quick.example.org']);
    started = Date.now();
    expect(await from('203.0.113.60')).toBe('in');
    expect(Date.now() - started).toBeLessThan(1_500);

    // A loopback or unspecified address in a name's answer lets nothing in.
    dnsTable.set('local.example.org', {
      v4: ['127.0.0.1', '0.0.0.0', '127.8.9.10'],
      v6: ['::1', '::'],
    });
    await allow(['local.example.org']);
    for (const address of ['127.0.0.1', '127.8.9.10', '0.0.0.0', '::1', '::']) {
      expect(await from(address), address).toBe('address_not_allowed');
    }
    await allow([]);
    expect(await from('203.0.113.40')).toBe('in');

    // What is not an address, a network or a host name is refused, and so
    // is more than the caps: ten entries, five names.
    const names = (n: number) => Array.from({ length: n }, (_, i) => `n${i}.example.com`);
    const nets = (n: number) => Array.from({ length: n }, (_, i) => `198.51.100.${i}`);
    for (const bad of [
      ['*.example.com'],
      ['localhost'],
      ['https://feeds.example.com'],
      ['feeds.example.com:443'],
      ['feeds.example.com/24'],
      ['1.2.3'],
      ['-x.example.com'],
      names(6),
      [...names(5), ...nets(6)],
    ]) {
      const r = await allow(bad);
      expect(
        [r.statusCode, r.json<{ error: { detail?: string } }>().error.detail],
        bad.join(),
      ).toEqual([422, 'ip_allow']);
    }
    const most = await allow([...names(5), ...nets(5)]);
    expect(most.statusCode, most.body).toBe(200);
    // The database holds to the caps and the form too: one name an element,
    // labels without a hyphen at either end, a letter in the last label,
    // 253 characters at most.
    for (const bad of [
      ['Bad_Name.example.com'],
      ['a.example.com b.example.com'],
      ['n0.example.com n1.example.com', ...names(4)],
      ['-x.example.com'],
      ['x-.example.com'],
      ['feeds.example.1-2'],
      ['203.0.113.7'],
      ['localhost'],
      ['feeds.example.com '],
      [''],
      [`${'a.'.repeat(126)}com`],
      names(6),
    ]) {
      await expect(
        admin.query(`update connected_app set ip_allow_names = $2 where id = $1`, [a.appId, bad]),
        bad.join(),
      ).rejects.toThrow(/connected_app_ip_allow_names/);
    }
    for (const good of [
      [`${'a.'.repeat(124)}com`],
      ['xn--bcher-kva.example', 'a-1.b2.example.org'],
      names(5),
    ]) {
      await admin.query(
        `update connected_app set ip_allow = '{}', ip_allow_names = $2 where id = $1`,
        [a.appId, good],
      );
    }
    await allow([]);
  });

  it('a new name in the allow-list widens it: an app acting as another adult waits for them again (APP7)', async () => {
    const a = await connect(owner, {
      member_id: ahmed.member_id,
      name: 'Named widening',
      ip_allow: ['203.0.113.0/24', 'api.example.com'],
    });
    await h.decider(ahmed);
    await send(ahmed, 'POST', `/api/v1/connected-apps/${a.appId}/approve`);
    const change = async (list: string[]) => {
      await h.decider(owner);
      const res = await send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, {
        ip_allow: list,
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json<ConnectedAppView>().state;
    };
    // Dropping a name narrows; a name it did not have widens.
    expect(await change(['203.0.113.0/24'])).toBe('active');
    expect(await change(['203.0.113.0/24', 'other.example.com'])).toBe('waiting_for_approval');
  });

  it('an address that keeps sending a key that does not work waits out its minute; others do not', async () => {
    const a = await connect(owner, { name: 'Guessed' });
    const from = '198.51.100.44';
    clockHeld = Math.floor(Date.now() / 60_000) * 60_000 + 1_000;
    try {
      for (let i = 0; i < 10; i++) {
        const r = await me(a, {
          remoteAddress: from,
          key: { clientId: a.clientId, secret: newSecret() },
        });
        expect(codeOf(r)).toBe('app_key_invalid');
      }
      // The eleventh, even with the right secret: wait, before anything is looked up.
      const limited = await me(a, { remoteAddress: from });
      expect([limited.statusCode, codeOf(limited)]).toEqual([429, 'rate_limited']);
      expect(limited.json<{ error: { retriable: boolean } }>().error.retriable).toBe(true);
      expect(Number(limited.headers['retry-after'])).toBe(59);
      // Another address is not held back.
      expect((await me(a, { remoteAddress: '198.51.100.45' })).statusCode).toBe(200);
      // A minute on: tried again.
      clockHeld += 60_000;
      expect((await me(a, { remoteAddress: from })).statusCode).toBe(200);
    } finally {
      clockHeld = null;
    }
    // A stranger's guesses write nothing against the app.
    expect((await appsOf(owner)).items.find((x) => x.id === a.appId)?.refused_today).toBe(0);
  });

  it('only guessing counts: a right secret for a revoked or expired key, or a removed app, never locks an address out; IPv6 by its /64', async () => {
    const a = await connect(owner, { name: 'Not guessing' });
    await h.decider(owner);
    const b = { ...a, ...(await appKeyFor(h, owner, a.view)) };
    expect(
      (await send(owner, 'DELETE', `/api/v1/connected-apps/${a.appId}/keys/${a.keyId}`)).statusCode,
    ).toBe(204);
    clockHeld = Math.floor(Date.now() / 60_000) * 60_000 + 1_000;
    try {
      // Twelve requests with a revoked key's right secret: refused each time
      // for being revoked, never for guessing.
      for (let i = 0; i < 12; i++) {
        expect(codeOf(await me(a, { remoteAddress: '198.51.100.60' }))).toBe('app_key_revoked');
      }
      expect((await me(b, { remoteAddress: '198.51.100.60' })).statusCode).toBe(200);
      // And past its expiry: the same.
      const c = { ...a, ...(await appKeyFor(h, owner, a.view)) };
      await expire(c.clientId);
      for (let i = 0; i < 12; i++) {
        expect(codeOf(await me(c, { remoteAddress: '198.51.100.61' }))).toBe('app_key_expired');
      }
      // Guesses from across one IPv6 /64 are counted together; the next /64 is not held back.
      for (let i = 0; i < 10; i++) {
        const r = await me(b, {
          remoteAddress: `2001:db8:5:6::${(i + 1).toString(16)}`,
          key: { clientId: b.clientId, secret: newSecret() },
        });
        expect(codeOf(r)).toBe('app_key_invalid');
      }
      const held = await me(b, { remoteAddress: '2001:db8:5:6:ffff::99' });
      expect([held.statusCode, codeOf(held)]).toEqual([429, 'rate_limited']);
      expect((await me(b, { remoteAddress: '2001:db8:5:7::1' })).statusCode).toBe(200);
    } finally {
      clockHeld = null;
    }
    // A removed app's right secret, many times: never a guess either.
    await send(owner, 'DELETE', `/api/v1/connected-apps/${a.appId}`);
    for (let i = 0; i < 12; i++) {
      expect(codeOf(await me(b, { remoteAddress: '198.51.100.62' }))).toBe('app_revoked');
    }
  });

  it('a proxy’s own Basic login in front of the vault goes through untouched; only an fdvc_ user is an app’s key', async () => {
    const proxy = {
      authorization: `Basic ${Buffer.from('alice:correct horse').toString('base64')}`,
    };
    const capabilities = await h.app.inject({
      url: '/api/v1/capabilities',
      headers: proxy,
      remoteAddress: peer(),
    });
    expect(capabilities.statusCode).toBe(200);
    // A family route: answered as without it — asked to sign in, never told
    // it is an app's key.
    const family = await h.app.inject({
      url: '/api/v1/documents',
      headers: proxy,
      remoteAddress: peer(),
    });
    expect([family.statusCode, codeOf(family)]).toEqual([401, 'unauthenticated']);
    // Signing in with a password goes on as ever, the proxy's header beside it.
    const signedIn = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: proxy,
      payload: { email: 'sara@example.test', password: 'another correct horse' },
      remoteAddress: peer(),
    });
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    // On an app route it is no key: the app is asked for one.
    const app = await h.app.inject({
      url: '/api/v1/apps/me',
      headers: proxy,
      remoteAddress: peer(),
    });
    expect([app.statusCode, codeOf(app)]).toEqual([401, 'app_key_required']);
  });

  it('a new key that may do no more than a live one does not ask its person again; a wider one does', async () => {
    const a = await connect(owner, {
      member_id: ahmed.member_id,
      name: 'Rotated',
      scopes: ['documents.send', 'documents.read'],
    });
    await h.decider(ahmed);
    await send(ahmed, 'POST', `/api/v1/connected-apps/${a.appId}/approve`);
    const stateOf = async () => (await appsOf(owner)).items.find((x) => x.id === a.appId)?.state;
    expect(await stateOf()).toBe('active');
    await h.decider(owner);
    // The live key may send and read: a key that may only send is a rotation.
    const narrower = await appKeyFor(h, owner, a.view, { permissions: ['documents.send'] });
    expect(await stateOf()).toBe('active');
    expect((await me({ ...a, ...narrower })).statusCode).toBe(200);
    await send(owner, 'DELETE', `/api/v1/connected-apps/${a.appId}/keys/${a.keyId}`);
    // Now the only live key may only send: one that may read too is wider.
    await appKeyFor(h, owner, a.view, { permissions: ['documents.send', 'documents.read'] });
    expect(await stateOf()).toBe('waiting_for_approval');
  });

  it('only an owner generates or revokes a key, with a passkey or a code; two live at most; each with its own permissions', async () => {
    const a = await connect(owner, {
      name: 'Keyring',
      scopes: ['documents.send', 'documents.read'],
    });
    const gen = (by: Tokens, body: Record<string, unknown>) =>
      send(by, 'POST', `/api/v1/connected-apps/${a.appId}/keys`, {
        permissions: ['documents.send'],
        expires_in_days: 30,
        ...body,
      });
    // An adult — even its own person's adult — never; an owner without a
    // fresh passkey or code is asked for one.
    expect(codeOf(await gen(ahmed, {}))).toBe('forbidden');
    expect(
      codeOf(await send(ahmed, 'DELETE', `/api/v1/connected-apps/${a.appId}/keys/${a.keyId}`)),
    ).toBe('forbidden');
    await admin.query(
      `update session set factor_verified_at = null, verified_at = null
        where account_id = (select account_id from account_household where member_id = $1)`,
      [owner.member_id],
    );
    expect(codeOf(await gen(owner, {}))).toBe('step_up_required');
    expect(
      codeOf(await send(owner, 'DELETE', `/api/v1/connected-apps/${a.appId}/keys/${a.keyId}`)),
    ).toBe('step_up_required');
    await h.decider(owner);
    // What a key is given is checked.
    for (const [bad, field] of [
      [{ permissions: [] }, 'permissions'],
      [{ permissions: ['documents.delete'] }, 'permissions'],
      [{ expires_in_days: 0 }, 'expires_in_days'],
      [{ expires_in_days: 3651 }, 'expires_in_days'],
      [{ name: 'x'.repeat(61) }, 'name'],
    ] as const) {
      const r = await gen(owner, bad);
      expect([
        JSON.stringify(bad),
        r.statusCode,
        r.json<{ error: { detail: string } }>().error.detail,
      ]).toEqual([JSON.stringify(bad), 422, field]);
    }
    // A key that never expires, with less than the app may do: the
    // request is held to both.
    const never = await gen(owner, { expires_in_days: null, name: '  ' });
    expect(never.statusCode, never.body).toBe(201);
    const nk = never.json<ConnectedAppKeyMade>();
    expect(nk.key).toMatchObject({ expires_at: null, name: null, permissions: ['documents.send'] });
    const sendOnly = { ...a, clientId: nk.client_id, secret: nk.secret, keyId: nk.key.id };
    const meSaid = (await me(sendOnly)).json<AppMe>();
    expect(meSaid.scopes).toEqual(['documents.send']);
    expect(meSaid.key).toMatchObject({ expires_at: null, permissions: ['documents.send'] });
    expect(codeOf(await call(sendOnly, 'GET', '/api/v1/apps/documents'))).toBe('scope_not_granted');
    expect((await call(a, 'GET', '/api/v1/apps/documents')).statusCode).toBe(200);
    // Years from now, it still works.
    try {
      clockOffset = 4000 * 864e5;
      expect((await me(sendOnly)).statusCode).toBe(200);
    } finally {
      clockOffset = 0;
    }
    // And the app narrowed below it: the app's own scopes hold too.
    await h.decider(owner);
    await send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, { scopes: ['documents.read'] });
    expect((await me(a)).json<AppMe>().scopes).toEqual(['documents.read']);
    expect((await me(sendOnly)).json<AppMe>().scopes).toEqual([]);
    expect(codeOf(await call(sendOnly, 'GET', '/api/v1/apps/intake/x1'))).toBe('scope_not_granted');
    await h.decider(owner);
    await send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, {
      scopes: ['documents.send', 'documents.read'],
    });

    // Two live: a third is refused, from the API and from the database.
    await h.decider(owner);
    const third = await gen(owner, {});
    expect([third.statusCode, codeOf(third)]).toEqual([409, 'key_limit']);
    await expect(
      admin.query(
        `insert into connected_app_key (household_id, app_id, client_id, secret_hash, permissions)
         select household_id, id, $2, sha256('x'), '{documents.send}' from connected_app where id = $1`,
        [a.appId, newClientId()],
      ),
    ).rejects.toThrow(/two live keys at most/);
    // A revoked key frees its place; revoking it again changes nothing; a
    // key not there is 404. Owners and its person are told by email.
    const before = alertsSent(h).length;
    expect(
      (await send(owner, 'DELETE', `/api/v1/connected-apps/${a.appId}/keys/${nk.key.id}`))
        .statusCode,
    ).toBe(204);
    expect(codeOf(await me(sendOnly))).toBe('app_key_revoked');
    expect(
      (await send(owner, 'DELETE', `/api/v1/connected-apps/${a.appId}/keys/${nk.key.id}`))
        .statusCode,
    ).toBe(204);
    expect(
      (await send(owner, 'DELETE', `/api/v1/connected-apps/${a.appId}/keys/${randomUUID()}`))
        .statusCode,
    ).toBe(404);
    const told = alertsSent(h).slice(before);
    expect(told.filter((m) => m.subject === 'An API key of Keyring was revoked')).toHaveLength(1);
    expect(JSON.stringify(told)).not.toContain(nk.secret);
    expect(await lines(owner)).toContain('Owner revoked an API key of Keyring');
    // An expired key frees its place too.
    await h.decider(owner);
    const next = (await gen(owner, {})).json<ConnectedAppKeyMade>();
    expect(codeOf(await gen(owner, {}))).toBe('key_limit');
    await expire(next.client_id);
    expect(codeOf(await me({ ...a, clientId: next.client_id, secret: next.secret }))).toBe(
      'app_key_expired',
    );
    expect((await gen(owner, {})).statusCode).toBe(201);
    const states = (await appsOf(owner)).items
      .find((x) => x.id === a.appId)
      ?.keys.map((k) => k.state);
    expect(states?.sort()).toEqual(['expired', 'live', 'live', 'revoked']);
    // The database keeps a key as it was made: never un-revoked, never widened.
    await expect(
      admin.query('update connected_app_key set revoked_at = null where id = $1', [nk.key.id]),
    ).rejects.toThrow(/a revoked key stays revoked/);
    // Who revoked it, and why, stay as they were.
    await expect(
      admin.query('update connected_app_key set revoked_by = null where id = $1', [nk.key.id]),
    ).rejects.toThrow(/a revoked key stays revoked/);
    await expect(
      admin.query(`update connected_app_key set revoked_reason = 'restore' where id = $1`, [
        nk.key.id,
      ]),
    ).rejects.toThrow(/a revoked key stays revoked/);
    expect(
      (await appsOf(owner)).items
        .find((x) => x.id === a.appId)
        ?.keys.find((k) => k.id === nk.key.id)?.revoked_reason,
    ).toBe('owner');
    await expect(
      admin.query(`update connected_app_key set permissions = '{documents.read}' where id = $1`, [
        a.keyId,
      ]),
    ).rejects.toThrow(/only a key's use, its revoking/);
    // The routes an app once had for its own keys are not there.
    for (const [method, url] of [
      ['POST', '/api/v1/apps/keys'],
      ['DELETE', `/api/v1/apps/keys/${a.keyId}`],
    ] as const) {
      expect(codeOf(await call(a, method, url))).toBe('app_key_not_accepted');
    }
    expect(
      (await send(owner, 'POST', `/api/v1/connected-apps/${a.appId}/keys/${a.keyId}/confirm`))
        .statusCode,
    ).toBe(404);
  }, 120_000);

  it('its person locked, or paused after a restore: refused; and the rate of its requests', async () => {
    const a = await connect(owner, { member_id: ahmed.member_id, name: 'Rated' });
    await h.decider(ahmed);
    await send(ahmed, 'POST', `/api/v1/connected-apps/${a.appId}/approve`);
    const account = (
      await admin.query<{ account_id: string }>(
        'select account_id from account_household where member_id = $1',
        [ahmed.member_id],
      )
    ).rows[0]?.account_id;
    for (const [reason, code] of [
      ['locked', 'member_locked'],
      ['restored', 'member_paused'],
    ] as const) {
      await admin.query(
        `update account_household set suspended_at = now(), suspend_reason = $2 where account_id = $1`,
        [account, reason],
      );
      try {
        const res = await me(a);
        expect([res.statusCode, codeOf(res)]).toEqual([403, code]);
      } finally {
        await admin.query(
          `update account_household set suspended_at = null, suspend_reason = null, suspended_until = null
            where account_id = $1`,
          [account],
        );
      }
    }
    // 120 requests a minute, then 429 with Retry-After. The clock is held a
    // second into a minute, so a busy machine's slow loop never crosses into
    // the next one.
    clockHeld = Math.floor(Date.now() / 60_000) * 60_000 + 1_000;
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 121; i++) statuses.push((await me(a)).statusCode);
      expect(statuses.slice(0, 118).every((s) => s === 200)).toBe(true);
      const limited = await me(a);
      expect([limited.statusCode, codeOf(limited)]).toEqual([429, 'rate_limited']);
      expect(Number(limited.headers['retry-after'])).toBe(59);
    } finally {
      clockHeld = null;
    }
  }, 120_000);

  // ------------------------------------------------------------ the review round

  it('an owner widening an app that acts as another adult sends it back to them; narrowing does not', async () => {
    const a = await connect(owner, {
      member_id: ahmed.member_id,
      name: 'Widened',
      allowed_kinds: ['bank_statement', 'utility_bill'],
      ip_allow: ['203.0.113.0/24'],
    });
    await h.decider(ahmed);
    await send(ahmed, 'POST', `/api/v1/connected-apps/${a.appId}/approve`);
    const stateOf = async () => (await appsOf(owner)).items.find((x) => x.id === a.appId)?.state;
    const change = async (body: Record<string, unknown>) => {
      await h.decider(owner);
      const res = await send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, body);
      expect(res.statusCode, res.body).toBe(200);
      return res.json<ConnectedAppView>().state;
    };
    const turnOn = async () => {
      await h.decider(ahmed);
      expect(
        (await send(ahmed, 'POST', `/api/v1/connected-apps/${a.appId}/approve`)).statusCode,
      ).toBe(200);
    };
    // Narrowing: fewer kinds, a lower cap, a tighter allow-list, a narrower
    // visibility, a new name — it stays on.
    expect(await change({ allowed_kinds: ['bank_statement'] })).toBe('active');
    expect(await change({ daily_files: 50 })).toBe('active');
    expect(await change({ ip_allow: ['203.0.113.0/25'] })).toBe('active');
    expect(await change({ default_visibility: 'private' })).toBe('active');
    expect(await change({ name: 'Widened too' })).toBe('active');
    // Each widening: it waits for Ahmed again, who is told.
    const before = alertsSent(h).length;
    for (const body of [
      { allowed_kinds: ['bank_statement', 'utility_bill'] },
      { daily_files: 60 },
      { ip_allow: [] },
      { default_visibility: 'household' },
      {
        backfill: {
          until: new Date(Date.now() + 5 * 864e5).toISOString(),
          files_per_day: 300,
          bytes_per_day: 50 * 1024 * 1024,
        },
      },
    ]) {
      expect(await change(body), JSON.stringify(body)).toBe('waiting_for_approval');
      expect(codeOf(await intake(a, `w-${randomUUID()}`))).toBe('app_not_approved');
      await turnOn();
      expect(await stateOf()).toBe('active');
    }
    const asked = alertsSent(h)
      .slice(before)
      .filter((m) => m.subject === 'Widened too waits for you to turn it on again');
    expect(asked).toHaveLength(5);
    expect(await lines(owner)).toContain(
      'Owner changed what Widened too may do, so Ahmed Khan must turn it on again',
    );
    // A key an owner generates that may do no more than its live key: a
    // rotation, which asks nothing of Ahmed (a wider one does: below).
    await h.decider(owner);
    const k = await send(owner, 'POST', `/api/v1/connected-apps/${a.appId}/keys`, {
      permissions: ['documents.send'],
      expires_in_days: 30,
    });
    expect(k.statusCode, k.body).toBe(201);
    expect(await stateOf()).toBe('active');
    expect(await lines(owner)).toContain('Owner generated an API key for Widened too');
    // An owner's own app: changed freely.
    const own = await connect(owner, { name: 'Owned' });
    await h.decider(owner);
    const wider = await send(owner, 'PATCH', `/api/v1/connected-apps/${own.appId}`, {
      daily_files: 500,
    });
    expect(wider.json<ConnectedAppView>().state).toBe('active');
  }, 120_000);

  it('a refusal is written against an app only once its key is right: a stranger writes nothing', async () => {
    const a = await connect(owner, { name: 'Quiet' });
    await send(owner, 'POST', `/api/v1/connected-apps/${a.appId}/pause`);
    const refused = async () =>
      (await appsOf(owner)).items.find((x) => x.id === a.appId)?.refused_today;
    // A stranger who knows the app's client ID, but not its secret: told
    // the key is not right — not even that the app is paused — and nothing
    // is written.
    const stranger = await call(a, 'GET', '/api/v1/apps/intake/q-1', {
      key: { clientId: a.clientId, secret: newSecret() },
    });
    expect(codeOf(stranger)).toBe('app_key_invalid');
    expect(await refused()).toBe(0);
    expect((await lines(owner)).some((l) => l.startsWith('Requests from Quiet'))).toBe(false);
    // The app itself: counted, and the day's one line.
    expect(codeOf(await call(a, 'GET', '/api/v1/apps/intake/q-1'))).toBe('app_paused');
    expect(await refused()).toBe(1);
    expect(await lines(owner)).toContain('Requests from Quiet were refused today (paused)');
  });

  it('plain http only from this machine itself, whatever FDV_BASE_URL says; and external_ids asked once', async () => {
    const a = await connect(owner, { name: 'Local' });
    // A localhost vault asked from elsewhere on the network: refused.
    const far = await me(a, { socket: '192.168.1.20' });
    expect([far.statusCode, codeOf(far)]).toEqual([403, 'https_required']);
    for (const socket of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect((await me(a, { socket })).statusCode, socket).toBe(200);
    }
    // The same parameter twice is no list: 422, never 500.
    const twice = await call(a, 'GET', '/api/v1/apps/intake?external_ids=a&external_ids=b');
    expect([twice.statusCode, codeOf(twice)]).toEqual([422, 'validation_failed']);
  });

  it('the public-only site’s capability document leaves the family’s name out', async () => {
    const asked = (headers: Record<string, string>) =>
      h.app.inject({ url: '/api/v1/capabilities', headers, remoteAddress: peer() });
    const pub = (await asked({ 'x-fdv-site': 'public' })).json<{
      branding: { display_name: string };
      apps_public: boolean;
    }>();
    expect(pub.branding.display_name).toBe('Family Document Vault');
    expect(pub.apps_public).toBe(true);
    const home = (await asked({})).json<{ branding: { display_name: string } }>();
    expect(home.branding.display_name).toBe('The Test family');
  });

  it('never an identity, legal, medical or Essential kind among what an app may send', async () => {
    await h.decider(owner);
    const types = await admin.query<{ key: string; category: string; usually_essential: boolean }>(
      `select key, category, usually_essential from document_type
        where household_id is null and (category in ('identity', 'legal', 'medical') or usually_essential)
        order by key`,
    );
    expect(types.rows.length).toBeGreaterThan(0);
    for (const t of types.rows.slice(0, 4)) {
      const res = await send(owner, 'POST', '/api/v1/connected-apps', {
        name: 'Never',
        member_id: owner.member_id,
        allowed_kinds: ['bank_statement', t.key],
      });
      expect([
        t.key,
        res.statusCode,
        res.json<{ error: { detail: string } }>().error.detail,
      ]).toEqual([t.key, 422, 'allowed_kinds']);
    }
  });

  it('two first sends of one external id at once: one is taken, the other told it is arriving, never a 500', async () => {
    const a = await connect(owner, { name: 'Racing' });
    for (let i = 0; i < 4; i++) {
      const id = `race-${i}`;
      const both = await Promise.all([
        intake(a, id, { bytes: PDF(`R${i}`) }),
        intake(a, id, { bytes: PDF(`R${i}`) }),
      ]);
      const codes = both.map((r) => r.statusCode).sort();
      expect(
        codes.every((c) => c < 500),
        JSON.stringify(codes),
      ).toBe(true);
      expect(codes.filter((c) => c === 201)).toHaveLength(1);
      for (const r of both.filter((x) => x.statusCode === 409)) {
        expect(codeOf(r)).toBe('upload_in_progress');
      }
    }
  });

  it('a send taken over while its bytes still come changes nothing: the later one stands, either way round', async () => {
    const a = await connect(owner, { name: 'Overtaken' });
    /** A send whose body is held after its first part, until `finish`. */
    const held = async (id: string, marker: string) => {
      const body = Buffer.from(
        multipartBody([
          { name: 'metadata', value: JSON.stringify({ external_id: id }) },
          {
            name: 'file',
            filename: 'a.pdf',
            contentType: 'application/pdf',
            bytes: new Uint8Array(PDF(marker)),
          },
        ]).bytes,
      );
      const boundary = /^--([^\r]+)/.exec(body.toString('latin1'))?.[1] as string;
      const signed = basicFor(a);
      const stream = new PassThrough();
      const cut = body.indexOf('%PDF') + 20;
      const answer = h.app.inject({
        method: 'POST',
        url: '/api/v1/apps/intake',
        headers: {
          ...signed,
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': String(body.length),
          'x-forwarded-for': peer(),
        },
        payload: stream,
        remoteAddress: '127.0.0.1',
      });
      stream.write(body.subarray(0, cut));
      return {
        answer,
        finish: async () => {
          stream.end(body.subarray(cut));
          return answer;
        },
      };
    };
    const item = async (id: string) =>
      (
        await admin.query<{ incoming_file_id: string | null; attempt: string | null }>(
          'select incoming_file_id, attempt from connected_app_intake where app_id = $1 and external_id = $2',
          [a.appId, id],
        )
      ).rows[0];
    const until = async (cond: () => Promise<boolean>) => {
      for (let i = 0; i < 200 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 25));
    };
    const stale = (id: string) =>
      admin.query(
        `update connected_app_intake set started_at = now() - interval '20 minutes'
          where app_id = $1 and external_id = $2`,
        [a.appId, id],
      );
    const items = async () =>
      Number(
        (
          await admin.query<{ n: string }>(
            `select count(*) as n from incoming_file f join intake_batch b on b.id = f.batch_id
              where b.app_id = $1 and f.state = 'received'`,
            [a.appId],
          )
        ).rows[0]?.n,
      );

    // B takes over and finishes first; A finishes after: A changes nothing.
    const first = await held('over-1', 'A1');
    await until(async () => !!(await item('over-1'))?.incoming_file_id);
    await stale('over-1');
    const b = await intake(a, 'over-1', { bytes: PDF('B1') });
    expect(b.statusCode, b.body).toBe(201);
    const late = await first.finish();
    expect([late.statusCode, codeOf(late)]).toEqual([409, 'upload_in_progress']);
    expect((await status(a, 'over-1')).json<AppIntakeState>().sha256).toBe(sha(PDF('B1')));

    // B takes over and is held; A finishes first: A changes nothing, then B lands.
    const a2 = await held('over-2', 'A2');
    await until(async () => !!(await item('over-2'))?.incoming_file_id);
    await stale('over-2');
    const b2 = await held('over-2', 'B2');
    const claimed = (await item('over-2'))?.attempt;
    await until(async () => (await item('over-2'))?.attempt !== claimed || false);
    await until(async () => {
      const r = await item('over-2');
      return !!r?.incoming_file_id;
    });
    const aDone = await a2.finish();
    expect([aDone.statusCode, codeOf(aDone)]).toEqual([409, 'upload_in_progress']);
    const bDone = await b2.finish();
    expect(bDone.statusCode, bDone.body).toBe(201);
    expect((await status(a, 'over-2')).json<AppIntakeState>().sha256).toBe(sha(PDF('B2')));
    // One item each in the Inbox: the later sends'.
    expect(await items()).toBe(2);
  }, 120_000);

  it('narrowing who sees what it sends reaches today’s batch; and its hints go once it is filed', async () => {
    const a = await connect(owner, { name: 'Narrow', default_visibility: 'household' });
    expect(
      (await intake(a, 'n-1', { bytes: PDF('N1') }, { kind: 'bank_statement' })).statusCode,
    ).toBe(201);
    const batchOf = async () =>
      (
        await admin.query<{ id: string; v: string | null }>(
          'select id, default_visibility as v from intake_batch where app_id = $1',
          [a.appId],
        )
      ).rows[0];
    expect((await batchOf())?.v).toBe('household');
    await h.decider(owner);
    await send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, {
      default_visibility: 'adults',
    });
    expect((await intake(a, 'n-2', { bytes: PDF('N2') })).statusCode).toBe(201);
    expect((await batchOf())?.v).toBe('adults');
    // Filed: what the app said of it is let go.
    const batch = (await batchOf())?.id as string;
    const detail = (await send(owner, 'GET', `/api/v1/batches/${batch}`)).json<BatchDetail>();
    const first = detail.items.find((i) => i.sha256 === sha(PDF('N1')));
    const filed = await send(owner, 'POST', `/api/v1/batches/${batch}/items/${first?.id}/accept`, {
      type_key: 'bank_statement',
      title: 'Narrow, filed',
    });
    expect(filed.statusCode, filed.body).toBe(201);
    const kept = await admin.query<{ hints: Buffer | null }>(
      `select hints_sealed as hints from connected_app_intake where app_id = $1 and external_id = 'n-1'`,
      [a.appId],
    );
    expect(kept.rows[0]?.hints).toBeNull();
  });

  // ------------------------------------------------------------ crossing

  it('an app’s key is refused on every route but its own (the all-routes walk)', async () => {
    const a = await connect(owner, { name: 'Walker' });
    const keyed = basicFor(a);
    const routes = routeTable(h);
    expect(routes.length).toBeGreaterThan(170);
    const answered: string[] = [];
    for (const r of routes) {
      const key = `${r.method} ${r.url}`;
      const url = r.url.replace(/:[A-Za-z_]+/g, (p) => (p === ':n' ? '1' : randomUUID()));
      const res = await h.app.inject({
        method: r.method as 'GET',
        url,
        headers: keyed,
        ...(r.method === 'GET' || r.method === 'DELETE' ? {} : { payload: {} }),
        remoteAddress: peer(),
      });
      if (APP_ROUTES.has(key)) {
        expect(codeOf(res), key).not.toBe('app_key_not_accepted');
        answered.push(key);
      } else {
        expect([key, res.statusCode, codeOf(res)]).toEqual([key, 401, 'app_key_not_accepted']);
      }
    }
    expect(answered.sort()).toEqual([...APP_ROUTES.keys()].sort());
    // A route that is not there: refused too; and Basic with nothing a key in it.
    const nowhere = await h.app.inject({ url: '/api/v1/nowhere', headers: keyed });
    expect([nowhere.statusCode, codeOf(nowhere)]).toEqual([401, 'app_key_not_accepted']);
    const junk = await h.app.inject({
      url: '/api/v1/documents',
      headers: { authorization: `Basic ${Buffer.from('fdvc_x').toString('base64')}` },
    });
    expect([junk.statusCode, codeOf(junk)]).toEqual([401, 'app_key_not_accepted']);
    // Basic that is no app's (a proxy's own login): the route answers as ever.
    const theirs = await h.app.inject({
      url: '/api/v1/documents',
      headers: { authorization: 'Basic' },
    });
    expect([theirs.statusCode, codeOf(theirs)]).toEqual([401, 'unauthenticated']);
  }, 180_000);

  // ------------------------------------------------------------ intake

  it('a file lands in its person’s Inbox, from the app, and an external id is answered again for the same bytes', async () => {
    const a = await connect(owner, { member_id: ahmed.member_id, name: 'Acme Money' });
    await h.decider(ahmed);
    await send(ahmed, 'POST', `/api/v1/connected-apps/${a.appId}/approve`);
    const bytes = PDF('NORTHGATE-OCT');
    const hints = {
      person: { name: 'ahmed  khan' },
      kind: 'bank_statement',
      title: 'Northgate current account, October 2026',
      issuer: 'Northgate Bank',
      issued: '2026-10-31',
      account_last4: '1234',
      period: 'October 2026',
      amount: { value: '2450.10', currency: 'USD' },
      tags: ['Acme Money'],
    };
    const first = await intake(a, 'mt:tenant-7f3a:doc-01', { bytes }, hints);
    expect(first.statusCode, first.body).toBe(201);
    const state = first.json<AppIntakeState>();
    expect(state).toEqual({
      external_id: 'mt:tenant-7f3a:doc-01',
      state: 'waiting',
      received_at: expect.any(String) as string,
      sha256: sha(bytes),
      byte_size: bytes.length,
      document_id: null,
      version_id: null,
      filed_at: null,
      removed_reason: null,
      refusal: null,
      content_available: false,
    });
    // In Ahmed's Inbox, in today's batch from the app.
    const batch = (await batchesOf(ahmed)).find((b) => b.name?.startsWith('From Acme Money, '));
    expect(batch?.counts.waiting).toBe(1);
    const detail = (await send(ahmed, 'GET', `/api/v1/batches/${batch?.id}`)).json<BatchDetail>();
    const item = detail.items[0];
    // What the app said is on the card, as the app's: its kind, its person, its title and fields.
    expect(item?.proposals).toMatchObject({
      type_key: { value: 'bank_statement', from: 'app' },
      owner_member_id: { value: ahmed.member_id, from: 'app' },
      title: { value: 'Northgate current account, October 2026', from: 'app' },
      extra: {
        account_last4: { value: '1234', from: 'app' },
        period: { value: 'October 2026', from: 'app' },
      },
      tags: [{ value: 'Acme Money', from: 'app', existing: false, ticked: false }],
      app_name: 'Acme Money',
    });
    // Its hints are sealed, never plain in the database.
    const kept = await admin.query<{ hints: Buffer }>(
      `select hints_sealed as hints from connected_app_intake where external_id = 'mt:tenant-7f3a:doc-01'`,
    );
    expect(kept.rows[0]?.hints.toString('latin1')).not.toContain('Northgate');
    // Nobody else is given it: not Sara, not an owner.
    expect((await batchesOf(owner)).some((b) => b.id === batch?.id)).toBe(false);
    expect((await batchesOf(sara)).some((b) => b.id === batch?.id)).toBe(false);
    expect((await send(owner, 'GET', `/api/v1/batches/${batch?.id}`)).statusCode).toBe(404);
    // The same bytes again: the same item, said to be a replay; hints ignored.
    const again = await intake(a, 'mt:tenant-7f3a:doc-01', { bytes }, { kind: 'utility_bill' });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json<AppIntakeState>()).toEqual(state);
    // Other bytes under the same id: refused.
    const other = await intake(a, 'mt:tenant-7f3a:doc-01', { bytes: PDF('OTHER') });
    expect([other.statusCode, codeOf(other)]).toEqual([409, 'external_id_conflict']);
    // Its status, and several at once; one never sent is not known.
    expect((await status(a, 'mt:tenant-7f3a:doc-01')).json<AppIntakeState>()).toEqual(state);
    expect((await status(a, 'never-sent')).statusCode).toBe(404);
    const many = await call(
      a,
      'GET',
      '/api/v1/apps/intake?external_ids=mt%3Atenant-7f3a%3Adoc-01,never-sent',
    );
    expect(many.json()).toEqual({ items: [state], unknown: ['never-sent'] });
    // Filed by Ahmed: filed, with its document.
    const accepted = await send(
      ahmed,
      'POST',
      `/api/v1/batches/${batch?.id}/items/${item?.id}/accept`,
      { type_key: 'bank_statement', title: 'Northgate, October' },
    );
    expect(accepted.statusCode, accepted.body).toBe(201);
    const filed = (await status(a, 'mt:tenant-7f3a:doc-01')).json<AppIntakeState>();
    expect(filed).toMatchObject({
      state: 'filed',
      document_id: accepted.json<{ document_id: string }>().document_id,
      version_id: accepted.json<{ version_id: string }>().version_id,
      filed_at: expect.any(String) as string,
    });
    // Filed as a document of its own (APP2): the paper it made.
    const madeIt = await admin.query<{ made: boolean }>(
      `select made_document as made from connected_app_intake where external_id = 'mt:tenant-7f3a:doc-01'`,
    );
    expect(madeIt.rows[0]?.made).toBe(true);
    // Let go of by the app, then the filing taken back by an Undo: waiting
    // again, as if never filed nor let go of — tried, and rolled back.
    const undo = await admin.connect();
    try {
      await undo.query('begin');
      await undo.query(
        `update connected_app_intake set unlinked_at = now() where external_id = 'mt:tenant-7f3a:doc-01'`,
      );
      await undo.query(
        `update incoming_file set state = 'received', document_id = null, version_id = null,
                as_version = false, decided_at = null, decided_by = null, undo_until = null, object_removed_at = null
          where id = $1`,
        [item?.id],
      );
      const back = await undo.query<{ state: string; unlinked: boolean; made: boolean }>(
        `select state, unlinked_at is not null as unlinked, made_document as made
           from connected_app_intake where external_id = 'mt:tenant-7f3a:doc-01'`,
      );
      expect(back.rows[0]).toEqual({ state: 'waiting', unlinked: false, made: false });
    } finally {
      await undo.query('rollback');
      undo.release();
    }
    // A filed one is not withdrawn.
    const late = await call(a, 'DELETE', '/api/v1/apps/intake/mt:tenant-7f3a:doc-01');
    expect([late.statusCode, codeOf(late)]).toEqual([409, 'already_decided']);
    // And the log says what the app did, never what it sent.
    const said = await lines(owner);
    expect(said).toContain('Ahmed Khan via Acme Money sent a file to their Inbox');
    expect(said).toContain('Ahmed Khan via Acme Money checked on files it sent');
    expect(said.join('\n')).not.toContain('Northgate');
    expect((await lines(sara)).some((l) => l.includes('via Acme Money'))).toBe(false);
    // Only Ahmed is told how many wait, and were filed.
    expect((await appsOf(ahmed)).items.find((x) => x.id === a.appId)?.counts).toEqual({
      waiting: 0,
      filed: 1,
    });
    expect((await appsOf(owner)).items.find((x) => x.id === a.appId)?.counts).toBeNull();
    expect((await appsOf(owner)).items.find((x) => x.id === a.appId)?.today.files).toBe(1);
  }, 120_000);

  it('the database gives nobody but its person what an app sent (RLS)', async () => {
    const a = await connect(owner, { member_id: sara.member_id, name: 'Walled' });
    await h.decider(sara);
    await send(sara, 'POST', `/api/v1/connected-apps/${a.appId}/approve`);
    expect((await intake(a, 'walled-1')).statusCode).toBe(201);
    const p = (t: Tokens, role: 'owner' | 'adult') => ({
      householdId: t.household_id,
      accountId: '',
      memberId: t.member_id,
      role,
    });
    const accountOf = async (t: Tokens) =>
      (
        await admin.query<{ account_id: string }>(
          'select account_id from account_household where member_id = $1',
          [t.member_id],
        )
      ).rows[0]?.account_id as string;
    const seen = async (who: {
      householdId: string;
      accountId: string;
      memberId: string;
      role: 'owner' | 'adult';
    }) =>
      withPrincipal(h.db, who, async (trx) => ({
        items: Number(
          (
            await trx
              .selectFrom('incoming_file as f')
              .innerJoin('intake_batch as b', 'b.id', 'f.batch_id')
              .select((eb) => eb.fn.countAll<string>().as('n'))
              .where('b.app_id', '=', a.appId)
              .executeTakeFirstOrThrow()
          ).n,
        ),
        sent: Number(
          (
            await trx
              .selectFrom('connected_app_intake')
              .select((eb) => eb.fn.countAll<string>().as('n'))
              .where('app_id', '=', a.appId)
              .executeTakeFirstOrThrow()
          ).n,
        ),
      }));
    expect(await seen({ ...p(sara, 'adult'), accountId: await accountOf(sara) })).toEqual({
      items: 1,
      sent: 1,
    });
    expect(await seen({ ...p(owner, 'owner'), accountId: await accountOf(owner) })).toEqual({
      items: 0,
      sent: 0,
    });
    expect(await seen({ ...p(ahmed, 'adult'), accountId: await accountOf(ahmed) })).toEqual({
      items: 0,
      sent: 0,
    });
  });

  it('a kind it may not send is refused and kept as refused; a refused or expired id is free again', async () => {
    const a = await connect(owner, { name: 'Kinds' });
    // Not on its list (a receipt): refused, nothing in the Inbox.
    const receipt = await intake(a, 'k-1', undefined, { kind: 'warranty' });
    expect([receipt.statusCode, codeOf(receipt)]).toEqual([422, 'kind_not_allowed']);
    expect((await status(a, 'k-1')).json<AppIntakeState>()).toMatchObject({
      state: 'refused',
      refusal: 'kind_not_allowed',
      received_at: null,
    });
    const inbox = async () =>
      (await batchesOf(owner))
        .filter((b) => b.name?.startsWith('From Kinds'))
        .reduce((n, b) => n + b.counts.waiting, 0);
    expect(await inbox()).toBe(0);
    // Sent again with a kind it may send: a new item, whatever bytes.
    const fine = await intake(a, 'k-1', { bytes: PDF('FINE') }, { kind: 'bank_statement' });
    expect(fine.statusCode, fine.body).toBe(201);
    expect(await inbox()).toBe(1);
    // A file the vault does not take: refused for its bytes, said so.
    const text = await intake(a, 'k-2', {
      bytes: Buffer.from('just some text, not a document'),
      name: 'note.txt',
      type: 'text/plain',
    });
    expect([text.statusCode, codeOf(text)]).toEqual([415, 'unsupported_type']);
    expect((await status(a, 'k-2')).json<AppIntakeState>()).toMatchObject({
      state: 'refused',
      refusal: 'unsupported_type',
    });
    expect((await intake(a, 'k-2')).statusCode).toBe(201);
    // Undecided past its batch's end (the worker's sweep): expired, then free again.
    await admin.query(
      `delete from incoming_file where id = (select incoming_file_id from connected_app_intake
                                               where external_id = 'k-2')`,
    );
    expect((await status(a, 'k-2')).json<AppIntakeState>()).toMatchObject({
      state: 'removed',
      removed_reason: 'expired',
    });
    const resent = await intake(a, 'k-2', { bytes: PDF('RESENT') });
    expect(resent.statusCode, resent.body).toBe(201);
    expect(resent.json<AppIntakeState>().sha256).toBe(sha(PDF('RESENT')));
    // Still arriving from another request: retriable.
    await admin.query(
      `insert into connected_app_intake (household_id, app_id, member_id, external_id, state)
       select household_id, id, member_id, 'k-3', 'arriving' from connected_app where id = $1`,
      [a.appId],
    );
    const busy = await intake(a, 'k-3');
    expect([busy.statusCode, codeOf(busy)]).toEqual([409, 'upload_in_progress']);
    expect(busy.json<{ error: { retriable: boolean } }>().error.retriable).toBe(true);
    expect(busy.headers['retry-after']).toBeTruthy();
    expect((await status(a, 'k-3')).statusCode).toBe(404);
  }, 120_000);

  it('declined by its person, or withdrawn by the app: answered so, and never sent in again', async () => {
    const a = await connect(owner, { name: 'Decide' });
    expect((await intake(a, 'd-1', { bytes: PDF('D1') })).statusCode).toBe(201);
    expect((await intake(a, 'd-2', { bytes: PDF('D2') })).statusCode).toBe(201);
    const batch = (await batchesOf(owner)).find((b) => b.name?.startsWith('From Decide'));
    const detail = (await send(owner, 'GET', `/api/v1/batches/${batch?.id}`)).json<BatchDetail>();
    const first = detail.items.find((i) => i.sha256 === sha(PDF('D1')));
    expect(
      (await send(owner, 'DELETE', `/api/v1/batches/${batch?.id}/items/${first?.id}`)).statusCode,
    ).toBe(204);
    const declined = (await status(a, 'd-1')).json<AppIntakeState>();
    expect(declined).toMatchObject({ state: 'removed', removed_reason: 'declined' });
    const again = await intake(a, 'd-1', { bytes: PDF('D1') });
    expect([again.statusCode, again.headers['idempotent-replayed']]).toEqual([200, 'true']);
    expect(again.json<AppIntakeState>()).toMatchObject({
      state: 'removed',
      removed_reason: 'declined',
    });
    // Withdrawn: out of the Inbox, and said so.
    const out = await call(a, 'DELETE', '/api/v1/apps/intake/d-2');
    expect(out.statusCode, out.body).toBe(200);
    expect(out.json<AppIntakeState>()).toMatchObject({
      state: 'removed',
      removed_reason: 'withdrawn',
    });
    const after = (await send(owner, 'GET', `/api/v1/batches/${batch?.id}`)).json<BatchDetail>();
    expect(after.items.filter((i) => i.state === 'waiting')).toEqual([]);
    expect(
      (await call(a, 'DELETE', '/api/v1/apps/intake/d-2')).json<AppIntakeState>(),
    ).toMatchObject({
      removed_reason: 'withdrawn',
    });
    expect(await lines(owner)).toContain(
      'Owner via Decide took back a file it sent to their Inbox',
    );
  });

  it('an intake is two parts, metadata first, and its hints are as the contract says', async () => {
    const a = await connect(owner, { name: 'Parts' });
    expect((await intake(a, 'g-1', { bytes: PDF('REAL') })).statusCode).toBe(201);
    // Only two parts, metadata first; metadata as the contract says.
    const wrong = multipartBody([
      {
        name: 'file',
        filename: 'a.pdf',
        contentType: 'application/pdf',
        bytes: new Uint8Array(PDF('X')),
      },
      { name: 'metadata', value: JSON.stringify({ external_id: 'g-2' }) },
    ]);
    const order = await call(a, 'POST', '/api/v1/apps/intake', {
      body: Buffer.from(wrong.bytes),
      contentType: wrong.contentType,
    });
    expect([order.statusCode, codeOf(order)]).toEqual([422, 'validation_failed']);
    for (const [hints, field] of [
      [{ colour: 'red' }, 'hints.colour'],
      [{ amount: { value: '12,00', currency: 'USD' } }, 'hints.amount'],
      [{ account_last4: '12345' }, 'hints.account_last4'],
      [{ issued: '2026-13-01' }, 'hints.issued'],
      [{ person: { name: 'A', household: true } }, 'hints.person'],
    ] as const) {
      const r = await intake(a, 'g-3', undefined, hints);
      expect([r.statusCode, r.json<{ error: { detail: string } }>().error.detail]).toEqual([
        422,
        field,
      ]);
    }
    const badId = await intake(a, 'not ok/id');
    expect(badId.json<{ error: { detail: string } }>().error.detail).toBe('external_id');
  });

  it('a day’s caps: the files and bytes it may send, the household’s midnight, a backfill allowance', async () => {
    const a = await connect(owner, { name: 'Capped', daily_files: 2 });
    expect((await intake(a, 'c-1', { bytes: PDF('C1') })).statusCode).toBe(201);
    expect((await intake(a, 'c-2', { bytes: PDF('C2') })).statusCode).toBe(201);
    const full = await intake(a, 'c-3', { bytes: PDF('C3') });
    expect([full.statusCode, codeOf(full)]).toEqual([429, 'app_day_full']);
    expect(full.json<{ error: { retriable: boolean } }>().error.retriable).toBe(true);
    const wait = Number(full.headers['retry-after']);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(86_400 + 3600);
    // Nothing was kept of it: still free.
    expect((await status(a, 'c-3')).statusCode).toBe(404);
    const said = (await me(a)).json<AppMe>().limits;
    expect(said).toMatchObject({ files_per_day: 2, files_today: 2 });
    // A backfill allowance raises the day's caps until its end.
    await h.decider(owner);
    const until = new Date(Date.now() + 7 * 864e5).toISOString();
    const set = await send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, {
      backfill: { until, files_per_day: 3, bytes_per_day: 50 * 1024 * 1024 },
    });
    expect(set.statusCode, set.body).toBe(200);
    expect((await intake(a, 'c-3', { bytes: PDF('C3') })).statusCode).toBe(201);
    expect((await intake(a, 'c-4', { bytes: PDF('C4') })).statusCode).toBe(429);
    expect((await me(a)).json<AppMe>().backfill).toMatchObject({
      files_per_day: 3,
      auto_file: false,
    });
    // Past 30 days, or past the operator's ceiling: refused.
    const far = await send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, {
      backfill: {
        until: new Date(Date.now() + 40 * 864e5).toISOString(),
        files_per_day: 3,
        bytes_per_day: 50 * 1024 * 1024,
      },
    });
    expect(far.json<{ error: { detail: string } }>().error.detail).toBe('backfill.until');
    // A rename alone asks for no code; anything else does.
    await admin.query(
      `update session set factor_verified_at = null, verified_at = null
        where account_id = (select account_id from account_household where member_id = $1)`,
      [owner.member_id],
    );
    expect(
      (await send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, { name: 'Capped 2' }))
        .statusCode,
    ).toBe(200);
    expect(
      codeOf(await send(owner, 'PATCH', `/api/v1/connected-apps/${a.appId}`, { daily_files: 5 })),
    ).toBe('step_up_required');
  }, 120_000);

  // ------------------------------------------------------------ lifecycle

  it('revoked as its person’s role can no longer act, and by sign out everywhere; not by a password change', async () => {
    await h.decider(owner);
    const vera = await h.join(owner, { name: 'Vera', email: 'vera@example.test', role: 'adult' });
    await h.decider(vera);
    const a = await connect(owner, { member_id: vera.member_id, name: 'Roles' });
    await send(vera, 'POST', `/api/v1/connected-apps/${a.appId}/approve`);
    // A password changed: the app's credential is not the password.
    const changed = await send(vera, 'POST', '/api/v1/auth/password/change', {
      current_password: 'another correct horse',
      new_password: 'a brand new long passphrase',
    });
    expect(changed.statusCode, changed.body).toBe(204);
    expect((await me(a)).statusCode).toBe(200);
    // Made a teen: revoked in the same transaction, and said so.
    await h.decider(owner);
    const role = await send(owner, 'POST', `/api/v1/members/${vera.member_id}/role`, {
      role: 'teen',
    });
    expect(role.statusCode, role.body).toBe(200);
    expect(codeOf(await me(a))).toBe('app_revoked');
    expect(await lines(owner)).toContain(
      'Owner changed Vera’s role, so Roles can no longer act as them',
    );

    // Signed out everywhere by an owner: every app acting as them, removed.
    const b = await connect(owner, { member_id: ahmed.member_id, name: 'Outed' });
    await h.decider(ahmed);
    await send(ahmed, 'POST', `/api/v1/connected-apps/${b.appId}/approve`);
    expect((await me(b)).statusCode).toBe(200);
    await h.decider(owner);
    const out = await send(owner, 'DELETE', `/api/v1/members/${ahmed.member_id}/sessions`);
    expect(out.statusCode, out.body).toBe(200);
    expect(codeOf(await me(b))).toBe('app_revoked');
    expect(await lines(owner)).toContain(
      'Owner signed Ahmed Khan out everywhere, so Outed was removed',
    );
  }, 120_000);

  it('the vault itself refuses a revoked app’s change, and an adult changing what their app may do', async () => {
    const a = await connect(owner, { name: 'Fixed' });
    await expect(
      admin.query(`update connected_app set member_id = $2 where id = $1`, [
        a.appId,
        sara.member_id,
      ]),
    ).rejects.toThrow(/whom an app acts as never changes/);
    await send(owner, 'DELETE', `/api/v1/connected-apps/${a.appId}`);
    await expect(
      admin.query(`update connected_app set name = 'Back' where id = $1`, [a.appId]),
    ).rejects.toThrow(/a revoked app never changes/);
    // Its keys revoked with it, and none given to it after.
    const live = await admin.query(
      'select 1 from connected_app_key where app_id = $1 and revoked_at is null',
      [a.appId],
    );
    expect(live.rowCount).toBe(0);
    await expect(
      admin.query(
        `insert into connected_app_key (household_id, app_id, client_id, secret_hash, permissions)
         select household_id, id, $2, sha256('x'), '{documents.send}' from connected_app where id = $1`,
        [a.appId, newClientId()],
      ),
    ).rejects.toThrow(/a removed app is given no key/);
  });
});

/** Every route the API answers, as Fastify's router holds it (as the device walk reads it). */
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
          .map((s) => s.trim())
          .includes(method)
      ) {
        out.push({ method, url: stack.join('') });
      }
    }
  }
  return out;
}
