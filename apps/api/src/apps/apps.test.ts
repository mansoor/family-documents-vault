import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { multipartBody } from '@fdv/client';
import { signRequest } from '@fdv/client/apps';
import { createPool, withPrincipal } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  APP_EMPTY_DIGEST,
  type AppIntakeState,
  type AppMe,
  type BatchDetail,
  type BatchView,
  type ConnectedAppList,
  type ConnectedAppView,
  type Tokens,
} from '@fdv/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alertsSent, createHarness, type Harness } from '../test-harness.js';
import { APP_SIGNED_ROUTES } from './routes.js';
import {
  fingerprintOf,
  parseSignature,
  pathAndQuery,
  rawPublicKey,
  signatureBase,
  verifies,
} from './signing.js';

/**
 * Connected apps (0.9.0, APP1): an owner connects one with a passkey or a
 * code, it signs every request (RFC 9421), and what it sends goes into its
 * person's Inbox, followed by its external id.
 */

const PDF = (marker: string) =>
  Buffer.from(
    `%PDF-1.4\n% ${marker}\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
  );
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** A key pair an app made: its private key as PEM, and the public key as an owner pastes it. */
function newKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
  return {
    pem: privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
    given: `ed25519:${raw.toString('base64url')}`,
    spki: publicKey.export({ format: 'pem', type: 'spki' }) as string,
    raw,
  };
}
type Key = ReturnType<typeof newKey>;

interface TestApp {
  appId: string;
  keyId: string;
  key: Key;
  view: ConnectedAppView;
}

interface CallOptions {
  body?: Buffer;
  contentType?: string;
  /** Headers added or replaced after signing. */
  headers?: Record<string, string>;
  created?: number;
  nonce?: string;
  /** Signed for this, not what is sent. */
  signedTarget?: string;
  signedBody?: Buffer | string;
  signedMethod?: string;
  /** The caller's address, as a trusted proxy on this machine says it (X-Forwarded-For). */
  remoteAddress?: string;
  /** The connection's own address, said by nothing but the socket. */
  socket?: string;
  key?: { keyId: string; pem: string };
}

/** The connected apps' clock, ahead of the real one by this much: a test moves it. */
let clockOffset = 0;
/** Or held still at this instant, while a test counts within one minute. */
let clockHeld: number | null = null;

let peers = 0;
const peer = () => `10.72.${(peers >> 8) & 0xff}.${peers++ & 0xff}`;
const codeOf = (r: { json: () => unknown }) =>
  (r.json() as { error?: { code?: string } }).error?.code;

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

  /** An owner connects an app, with a code just given. */
  async function connect(
    by: Tokens,
    input: Partial<{
      member_id: string;
      allowed_kinds: string[];
      name: string;
      ip_allow: string[];
      default_visibility: string | null;
      daily_files: number;
    }> = {},
  ): Promise<TestApp> {
    await h.decider(by);
    const key = newKey();
    const res = await send(by, 'POST', '/api/v1/connected-apps', {
      name: 'Acme Money',
      member_id: by.member_id,
      public_key: key.given,
      allowed_kinds: ['bank_statement', 'utility_bill', 'credit_card_statement'],
      ...input,
    });
    expect(res.statusCode, res.body).toBe(201);
    const view = res.json<ConnectedAppView>();
    return { appId: view.id, keyId: view.keys[0]?.key_id as string, key, view };
  }

  /** A request signed as the app, sent. */
  async function call(
    a: TestApp,
    method: 'GET' | 'POST' | 'DELETE',
    target: string,
    o: CallOptions = {},
  ): Promise<LightMyRequestResponse> {
    const key = o.key ?? { keyId: a.keyId, pem: a.key.pem };
    const signed = await signRequest({
      method: o.signedMethod ?? method,
      target: o.signedTarget ?? target,
      ...(o.signedBody !== undefined
        ? { body: o.signedBody }
        : o.body
          ? { body: new Uint8Array(o.body) }
          : {}),
      keyid: `${a.appId}.${key.keyId}`,
      privateKey: key.pem,
      ...(o.created !== undefined ? { created: o.created } : {}),
      ...(o.nonce ? { nonce: o.nonce } : {}),
    });
    return h.app.inject({
      method,
      url: target,
      headers: {
        ...signed,
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

  beforeAll(async () => {
    h = await createHarness({
      rateLimitPerMinute: 20_000,
      publicApps: 'on',
      appsNow: () => clockHeld ?? Date.now() + clockOffset,
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

  // ------------------------------------------------------------ signing

  it('the contract’s worked examples verify byte for byte, and the key and fingerprint read as it says', () => {
    const key = rawPublicKey('ed25519:JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs') as Buffer;
    expect(fingerprintOf(key)).toBe('b16c 2d1b ead1 2626 3976 4fdb 0ee4 d377');
    const keyid = '0b9a1f3e-6c2d-4e8a-9f71-2d5c8b4a7e10.5e2c7d91-3a4b-4c6d-8e9f-0a1b2c3d4e5f';
    const examples = [
      {
        method: 'GET',
        url: '/api/v1/apps/documents?kind=bank_statement&from=2025-11-01&limit=50',
        digest: APP_EMPTY_DIGEST,
        nonce: 'q2v5Xb8Kc1nT4yWm9pLd3A',
        sig: 'svm/e0HinJECVqp1YVETGIVKXu8YHfHxL5MsK5BV7p2+oBP5aDq4Q2IWcWlAPH2EapyPthUzmXUwkbvKQUosBg==',
        bytes: 402,
      },
      {
        method: 'POST',
        url: '/api/v1/apps/documents/7c4e2a10-9b3d-4f6e-8a21-5d0c9e8f7b62/links',
        digest: 'sha-256=:jiFmkkKT2RXl18q8BbzJlDQtG4I0hKhvLwf5yptXusM=:',
        nonce: 'Hn3kQ7rT2xLp9vB6cW1sZg',
        sig: 'Z5FdCGmjraCmjPjFBiIB9/3mYq8kTL1Kponj4fxVyRLn40g2ZoqrbpazhLXYOMoKsXwG06ACO7CKz+jQBbM7Bg==',
        bytes: null,
      },
    ];
    for (const e of examples) {
      const parsed = parseSignature({
        'content-digest': e.digest,
        'signature-input': `fdv=("@method" "@path" "@query" "content-digest");created=1794830400;keyid="${keyid}";nonce="${e.nonce}";alg="ed25519";tag="fdv-app"`,
        signature: `fdv=:${e.sig}:`,
      });
      if ('code' in parsed) throw new Error(JSON.stringify(parsed));
      expect(parsed).toMatchObject({
        appId: '0b9a1f3e-6c2d-4e8a-9f71-2d5c8b4a7e10',
        keyId: '5e2c7d91-3a4b-4c6d-8e9f-0a1b2c3d4e5f',
        created: 1794830400,
        nonce: e.nonce,
      });
      const base = signatureBase({
        method: e.method,
        ...pathAndQuery(e.url),
        digestHeader: parsed.digestHeader,
        params: parsed.params,
      });
      if (e.bytes) expect(Buffer.byteLength(base)).toBe(e.bytes);
      expect(verifies(key, base, parsed.signature)).toBe(true);
      // One byte of the path changed, and it does not.
      expect(verifies(key, base.replace('/api/v1/', '/api/v2/'), parsed.signature)).toBe(false);
    }
    // A PEM SPKI block is the same key.
    const pem = newKey();
    expect(rawPublicKey(pem.spki)?.equals(pem.raw)).toBe(true);
    expect(rawPublicKey('ed25519:short')).toBeNull();
    expect(rawPublicKey('ssh-ed25519 AAAA')).toBeNull();
  });

  // ------------------------------------------------------------ connecting

  it('an owner connects an app with a passkey or a code, never the password alone', async () => {
    const key = newKey();
    const body = {
      name: 'Acme Money',
      member_id: owner.member_id,
      public_key: key.given,
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
    // What it is given is checked: a key, a person who may be acted as, kinds the household has.
    for (const [bad, field] of [
      [{ public_key: 'not a key' }, 'public_key'],
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
    const made = await send(owner, 'POST', '/api/v1/connected-apps', {
      ...body,
      public_key: key.spki,
    });
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
    });
    expect(view.keys).toHaveLength(1);
    expect(view.keys[0]?.fingerprint).toBe(fingerprintOf(key.raw));
    // The connection string: no secret, the address, the ids and the fingerprint.
    expect(view.connection_string.startsWith('fdvapp1.')).toBe(true);
    const c = JSON.parse(
      Buffer.from(view.connection_string.slice('fdvapp1.'.length), 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(c).toEqual({
      url: 'http://localhost:8080',
      app_id: view.id,
      key_id: view.keys[0]?.key_id,
      instance_id: expect.any(String) as string,
      fingerprint: fingerprintOf(key.raw),
    });
    // The same key on another live app of the household: refused.
    const twice = await send(owner, 'POST', '/api/v1/connected-apps', body);
    expect([twice.statusCode, codeOf(twice)]).toEqual([409, 'key_exists']);
    // The connection test.
    const a: TestApp = { appId: view.id, keyId: view.keys[0]?.key_id as string, key, view };
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
    expect(said.keys).toEqual([
      expect.objectContaining({
        key_id: a.keyId,
        fingerprint: fingerprintOf(key.raw),
        added_by: 'owner',
      }),
    ]);
    // An answer carries what the contract says every answer carries.
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.headers['x-fdv-server-version']).toBeTruthy();
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await lines(owner)).toContain('Owner connected Acme Money, acting as themselves');
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
    const valid = await signRequest({
      method: 'GET',
      target: '/api/v1/apps/me',
      keyid: `${a.appId}.${a.keyId}`,
      privateKey: a.key.pem,
    });
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

    // 1. The headers, and nothing else that names a caller.
    expect(await refusal(raw({}))).toEqual([401, 'app_signature_required']);
    expect(await refusal(raw({ 'content-digest': APP_EMPTY_DIGEST }))).toEqual([
      401,
      'app_signature_required',
    ]);
    expect(await refusal(raw({ ...valid, ...h.as(owner) }))).toEqual([
      401,
      'app_signature_required',
    ]);
    expect(await refusal(raw({ ...valid, cookie: 'fdv_share=abc' }))).toEqual([
      401,
      'app_signature_required',
    ]);
    expect(await refusal(raw({ ...valid, authorization: `Device ${randomUUID()}.key` }))).toEqual([
      401,
      'app_signature_required',
    ]);
    // A sign-in alone on an app route: told to sign the request.
    expect(await refusal(send(owner, 'GET', '/api/v1/apps/me'))).toEqual([
      401,
      'app_signature_required',
    ]);

    // 2. As the profile says, each part.
    const input = valid['signature-input'];
    for (const [what, headers] of [
      ['another label', { ...valid, 'signature-input': input.replace(/^fdv=/, 'sig1=') }],
      [
        'the components in another order',
        { ...valid, 'signature-input': input.replace('"@path" "@query"', '"@query" "@path"') },
      ],
      ['a component missing', { ...valid, 'signature-input': input.replace(' "@query"', '') }],
      ['an expires', { ...valid, 'signature-input': `${input};expires=1794830700` }],
      ['another parameter', { ...valid, 'signature-input': `${input};foo="bar"` }],
      [
        'another alg',
        { ...valid, 'signature-input': input.replace('"ed25519"', '"rsa-pss-sha512"') },
      ],
      ['another tag', { ...valid, 'signature-input': input.replace('"fdv-app"', '"other"') }],
      ['no nonce', { ...valid, 'signature-input': input.replace(/;nonce="[^"]+"/, '') }],
      [
        'a short nonce',
        { ...valid, 'signature-input': input.replace(/nonce="[^"]+"/, 'nonce="abc"') },
      ],
      [
        'a keyid not of two ids',
        { ...valid, 'signature-input': input.replace(/keyid="[^"]+"/, 'keyid="acme"') },
      ],
      ['a short signature', { ...valid, signature: 'fdv=:AAAA:' }],
      ['two signatures', { ...valid, signature: `${valid.signature}, sig2=:AAAA:` }],
      ['another digest', { ...valid, 'content-digest': `sha-512=:${'A'.repeat(86)}==:` }],
    ] as const) {
      const res = await raw(headers);
      expect([what, res.statusCode, codeOf(res)]).toEqual([what, 401, 'signature_malformed']);
    }

    // 3. A key the vault does not know, and one retired.
    const unknown = await call(a, 'GET', '/api/v1/apps/me', {
      key: { keyId: randomUUID(), pem: a.key.pem },
    });
    expect([unknown.statusCode, codeOf(unknown)]).toEqual([401, 'app_key_unknown']);
    const next = newKey();
    const added = await send(owner, 'POST', `/api/v1/connected-apps/${a.appId}/keys`, {
      public_key: next.given,
    });
    expect(added.statusCode, added.body).toBe(201);
    const nextId = added.json<{ key: { key_id: string } }>().key.key_id;
    expect(
      (await send(owner, 'DELETE', `/api/v1/connected-apps/${a.appId}/keys/${a.keyId}`)).statusCode,
    ).toBe(204);
    expect(await refusal(me(a))).toEqual([401, 'app_key_unknown']);
    a.keyId = nextId;
    a.key = next;
    expect((await me(a)).statusCode).toBe(200);
    // Its last key cannot be retired.
    const last = await send(owner, 'DELETE', `/api/v1/connected-apps/${a.appId}/keys/${nextId}`);
    expect([last.statusCode, codeOf(last)]).toEqual([409, 'key_in_use']);

    // 4. Paused: refused, but for the connection test, which says why.
    await send(owner, 'POST', `/api/v1/connected-apps/${a.appId}/pause`);
    expect(await refusal(call(a, 'GET', '/api/v1/apps/intake/x1'))).toEqual([403, 'app_paused']);
    expect((await me(a)).json<AppMe>()).toMatchObject({ state: 'paused', paused_reason: 'owner' });
    await h.decider(owner);
    expect((await send(owner, 'POST', `/api/v1/connected-apps/${a.appId}/resume`)).statusCode).toBe(
      200,
    );

    // 5. From an address it may come from: IPv4 and an IPv6 /64.
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

    // 7. Within five minutes of the vault's clock, either way.
    const now = Math.floor(Date.now() / 1000);
    const stale = await me(a, { created: now - 301 });
    expect([stale.statusCode, codeOf(stale)]).toEqual([401, 'signature_stale']);
    expect(stale.json<{ error: { detail: string } }>().error.detail).toMatch(
      /created 30\d seconds behind the vault's clock/,
    );
    expect(await refusal(me(a, { created: now + 301 }))).toEqual([401, 'signature_stale']);
    expect((await me(a, { created: now - 290 })).statusCode).toBe(200);
    expect(stale.headers.date).toBeTruthy();

    // 8. The signature verifies: over this path, with this key.
    expect(await refusal(me(a, { signedTarget: '/api/v1/apps/me?x=1' }))).toEqual([
      401,
      'signature_invalid',
    ]);
    expect(await refusal(me(a, { signedMethod: 'POST' }))).toEqual([401, 'signature_invalid']);
    const stranger = newKey();
    expect(await refusal(me(a, { key: { keyId: a.keyId, pem: stranger.pem } }))).toEqual([
      401,
      'signature_invalid',
    ]);

    // 9. A replay, exactly as sent: refused.
    const once = await signRequest({
      method: 'GET',
      target: '/api/v1/apps/me',
      keyid: `${a.appId}.${a.keyId}`,
      privateKey: a.key.pem,
    });
    expect((await raw(once)).statusCode).toBe(200);
    expect(await refusal(raw(once))).toEqual([401, 'nonce_reused']);

    // 11. The route in its scopes (what the connection test is not).
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

    // 12. A body's digest: a GET carries the digest of nothing.
    expect(
      await refusal(call(a, 'GET', '/api/v1/apps/intake/x1', { signedBody: 'something' })),
    ).toEqual([400, 'content_digest_mismatch']);

    // Refusals are counted, not a line each: one notable line today.
    const view = (await appsOf(owner)).items.find((x) => x.id === a.appId) as ConnectedAppView;
    expect(view.refused_today).toBeGreaterThanOrEqual(8);
    expect(view.last_refusal).toBe('content_digest_mismatch');
    const refused = (await lines(owner)).filter((l) => l.startsWith('Requests from Checks'));
    expect(refused).toEqual([expect.stringMatching(/^Requests from Checks were refused today/)]);

    // Removed: its next request is told so.
    expect((await send(owner, 'DELETE', `/api/v1/connected-apps/${a.appId}`)).statusCode).toBe(204);
    expect(await refusal(me(a))).toEqual([401, 'app_revoked']);
    expect((await appsOf(owner)).items.some((x) => x.id === a.appId)).toBe(false);
    expect(await lines(owner)).toContain('Owner removed Checks');
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
    // 120 signed requests a minute, then 429 with Retry-After. The clock is
    // held a second into a minute, so a busy machine's slow loop never
    // crosses into the next one (each request is still signed at its own
    // real moment, well inside the window).
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
    // A key an owner adds sends it back too.
    await h.decider(owner);
    const k = await send(owner, 'POST', `/api/v1/connected-apps/${a.appId}/keys`, {
      public_key: newKey().given,
    });
    expect(k.statusCode, k.body).toBe(201);
    expect(await stateOf()).toBe('waiting_for_approval');
    // An owner's own app: changed freely.
    const own = await connect(owner, { name: 'Owned' });
    await h.decider(owner);
    const wider = await send(owner, 'PATCH', `/api/v1/connected-apps/${own.appId}`, {
      daily_files: 500,
    });
    expect(wider.json<ConnectedAppView>().state).toBe('active');
  }, 120_000);

  it('a key the app adds signs nothing until confirmed, never retires an owner’s key, and a thief is left with none', async () => {
    const a = await connect(owner, { member_id: ahmed.member_id, name: 'Stolen' });
    await h.decider(ahmed);
    await send(ahmed, 'POST', `/api/v1/connected-apps/${a.appId}/approve`);
    // The thief holds key A, and adds B of its own.
    const b = newKey();
    const added = await call(a, 'POST', '/api/v1/apps/keys', {
      body: Buffer.from(JSON.stringify({ public_key: b.given })),
      contentType: 'application/json',
    });
    expect(added.statusCode, added.body).toBe(201);
    const bId = added.json<{ key_id: string; pending: boolean }>().key_id;
    expect(added.json<{ pending: boolean }>().pending).toBe(true);
    const withB = { ...a, keyId: bId, key: b };
    // B signs nothing.
    expect(codeOf(await me(withB))).toBe('app_key_pending');
    // Settings shows it pending; the connection test lists it so.
    const view = (await appsOf(owner)).items.find((x) => x.id === a.appId) as ConnectedAppView;
    expect(view.keys.find((k) => k.key_id === bId)?.pending).toBe(true);
    expect((await me(a)).json<AppMe>().keys.find((k) => k.key_id === bId)).toMatchObject({
      pending: true,
    });
    // A can never retire itself out, nor can B (once working) retire A: an owner's key.
    const self = await call(a, 'DELETE', `/api/v1/apps/keys/${a.keyId}`);
    expect(codeOf(self)).toBe('key_added_by_owner');
    // The owner retires A in Settings while B waits: the thief has no working key.
    await h.decider(owner);
    const before = alertsSent(h).length;
    expect(
      (await send(owner, 'DELETE', `/api/v1/connected-apps/${a.appId}/keys/${a.keyId}`)).statusCode,
    ).toBe(204);
    expect(codeOf(await me(a))).toBe('app_key_unknown');
    expect(codeOf(await me(withB))).toBe('app_key_pending');
    expect(
      alertsSent(h)
        .slice(before)
        .some((m) => m.subject === 'A key of Stolen was retired'),
    ).toBe(true);

    // Another app: B confirmed by its person, then B tries to retire A.
    const c = await connect(owner, { name: 'Rotating' });
    const d = newKey();
    const dId = (
      await call(c, 'POST', '/api/v1/apps/keys', {
        body: Buffer.from(JSON.stringify({ public_key: d.given })),
        contentType: 'application/json',
      })
    ).json<{ key_id: string }>().key_id;
    const withD = { ...c, keyId: dId, key: d };
    expect(codeOf(await me(withD))).toBe('app_key_pending');
    await h.decider(owner);
    const confirmed = await send(
      owner,
      'POST',
      `/api/v1/connected-apps/${c.appId}/keys/${dId}/confirm`,
    );
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    // Its own app (the owner acts as themselves): it stays on.
    expect(confirmed.json<ConnectedAppView>().state).toBe('active');
    expect((await me(withD)).statusCode).toBe(200);
    const retireA = await call(withD, 'DELETE', `/api/v1/apps/keys/${c.keyId}`);
    expect([retireA.statusCode, codeOf(retireA)]).toEqual([409, 'key_added_by_owner']);
    expect((await me(c)).statusCode).toBe(200);
    // The 7 days count from the first use of a confirmed newer key: its own
    // pending key never retires the older one.
    expect(await lines(owner)).toContain('Owner confirmed a new key of Rotating');
  }, 120_000);

  it('the window is to the millisecond: a nonce is always kept past the last instant its created is taken', async () => {
    const a = await connect(owner, { name: 'Edge' });
    const created = Math.floor(Date.now() / 1000);
    try {
      // 300.5 s after `created`: stale, where whole seconds said 300.
      clockOffset = created * 1000 + 300_500 - Date.now();
      expect(codeOf(await me(a, { created }))).toBe('signature_stale');
      // Inside the window: taken once, and its replay refused. Five seconds
      // in hand, so a busy machine's two requests both land inside it.
      clockOffset = created * 1000 + 295_000 - Date.now();
      const once = await signRequest({
        method: 'GET',
        target: '/api/v1/apps/me',
        keyid: `${a.appId}.${a.keyId}`,
        privateKey: a.key.pem,
        created,
      });
      const again = () =>
        h.app.inject({
          url: '/api/v1/apps/me',
          headers: { ...once, 'x-forwarded-for': peer() },
          remoteAddress: '127.0.0.1',
        });
      expect((await again()).statusCode).toBe(200);
      const kept = await admin.query<{ until: Date }>(
        `select expires_at as until from connected_app_nonce where app_id = $1`,
        [a.appId],
      );
      expect(kept.rows[0]?.until.getTime()).toBeGreaterThan(created * 1000 + 300_000);
      expect(codeOf(await again())).toBe('nonce_reused');
    } finally {
      clockOffset = 0;
    }
  });

  it('a signature made before a restore is refused, so a restore forgetting the nonces opens no replay', async () => {
    const a = await connect(owner, { name: 'Restored' });
    const created = Math.floor(Date.now() / 1000) - 5;
    await admin.query(`update connected_app set signed_after = now() where id = $1`, [a.appId]);
    const res = await me(a, { created });
    expect([res.statusCode, codeOf(res)]).toEqual([401, 'signature_stale']);
    expect(res.json<{ error: { detail: string } }>().error.detail).toBe(
      'created before the vault was restored',
    );
    // One made after it is taken.
    expect((await me(a, { created: Math.floor(Date.now() / 1000) + 1 })).statusCode).toBe(200);
  });

  it('a refusal is written against an app only once its signature verifies: a stranger writes nothing', async () => {
    const a = await connect(owner, { name: 'Quiet' });
    await send(owner, 'POST', `/api/v1/connected-apps/${a.appId}/pause`);
    const refused = async () =>
      (await appsOf(owner)).items.find((x) => x.id === a.appId)?.refused_today;
    // A stranger who knows the app's id and key id, but not its key: told it
    // is paused, as the contract's order says, and nothing is written.
    const stranger = await me(a, { key: { keyId: a.keyId, pem: newKey().pem } });
    expect(codeOf(stranger)).toBe('signature_invalid');
    const pausedStranger = await call(a, 'GET', '/api/v1/apps/intake/q-1', {
      key: { keyId: a.keyId, pem: newKey().pem },
    });
    expect(codeOf(pausedStranger)).toBe('app_paused');
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
        public_key: newKey().given,
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
      const signed = await signRequest({
        method: 'POST',
        target: '/api/v1/apps/intake',
        body: new Uint8Array(body),
        keyid: `${a.appId}.${a.keyId}`,
        privateKey: a.key.pem,
      });
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

  it('an app signature is refused on every route but its own (the all-routes walk)', async () => {
    const a = await connect(owner, { name: 'Walker' });
    const signed = await signRequest({
      method: 'GET',
      target: '/api/v1/apps/me',
      keyid: `${a.appId}.${a.keyId}`,
      privateKey: a.key.pem,
    });
    const routes = routeTable(h);
    expect(routes.length).toBeGreaterThan(170);
    const answered: string[] = [];
    for (const r of routes) {
      const key = `${r.method} ${r.url}`;
      const url = r.url.replace(/:[A-Za-z_]+/g, (p) => (p === ':n' ? '1' : randomUUID()));
      const res = await h.app.inject({
        method: r.method as 'GET',
        url,
        headers: signed,
        ...(r.method === 'GET' || r.method === 'DELETE' ? {} : { payload: {} }),
        remoteAddress: peer(),
      });
      if (APP_SIGNED_ROUTES.has(key)) {
        expect(codeOf(res), key).not.toBe('app_signature_not_accepted');
        answered.push(key);
      } else {
        expect([key, res.statusCode, codeOf(res)]).toEqual([
          key,
          401,
          'app_signature_not_accepted',
        ]);
      }
    }
    expect(answered.sort()).toEqual([...APP_SIGNED_ROUTES.keys()].sort());
    // A route that is not there: refused too; and a signature alone, half of one.
    const nowhere = await h.app.inject({ url: '/api/v1/nowhere', headers: signed });
    expect([nowhere.statusCode, codeOf(nowhere)]).toEqual([401, 'app_signature_not_accepted']);
    const half = await h.app.inject({
      url: '/api/v1/documents',
      headers: { 'signature-input': signed['signature-input'] },
    });
    expect([half.statusCode, codeOf(half)]).toEqual([401, 'app_signature_not_accepted']);
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

  it('a body changed after signing keeps nothing: refused once it has all arrived', async () => {
    const a = await connect(owner, { name: 'Digest' });
    const objects = async () =>
      (await readdir(h.vaultDir, { recursive: true, withFileTypes: true })).filter((f) =>
        f.isFile(),
      ).length;
    const before = await objects();
    const rows = async () =>
      Number(
        (
          await admin.query<{ n: string }>(
            `select count(*) as n from incoming_file f join intake_batch b on b.id = f.batch_id
              where b.app_id = $1`,
            [a.appId],
          )
        ).rows[0]?.n,
      );
    // Signed over one body, another sent: the digest of the first.
    const body = multipartBody([
      { name: 'metadata', value: JSON.stringify({ external_id: 'g-1' }) },
      {
        name: 'file',
        filename: 'a.pdf',
        contentType: 'application/pdf',
        bytes: new Uint8Array(PDF('REAL')),
      },
    ]);
    const res = await call(a, 'POST', '/api/v1/apps/intake', {
      body: Buffer.from(body.bytes),
      contentType: body.contentType,
      signedBody: 'a body that was never sent',
    });
    expect([res.statusCode, codeOf(res)]).toEqual([400, 'content_digest_mismatch']);
    expect((await status(a, 'g-1')).statusCode).toBe(404);
    expect(await rows()).toBe(0);
    expect(await objects()).toBe(before);
    // And the same body signed as it is sent: taken.
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

  it('the app rotates its own key: two at most, never the one signing, and the owners are told', async () => {
    const a = await connect(owner, { name: 'Rotor' });
    const next = newKey();
    const body = (k: Key) => Buffer.from(JSON.stringify({ public_key: k.given }));
    const add = (k: Key, o: CallOptions = {}) =>
      call(a, 'POST', '/api/v1/apps/keys', {
        body: body(k),
        contentType: 'application/json',
        ...o,
      });
    // Its body's digest, checked.
    const forged = await add(next, { signedBody: '{"public_key":"ed25519:other"}' });
    expect([forged.statusCode, codeOf(forged)]).toEqual([400, 'content_digest_mismatch']);
    const added = await add(next);
    expect(added.statusCode, added.body).toBe(201);
    const k = added.json<{ key_id: string; keyid: string; fingerprint: string }>();
    expect(k).toMatchObject({
      keyid: `${a.appId}.${k.key_id}`,
      fingerprint: fingerprintOf(next.raw),
    });
    expect(alertsSent(h).some((m) => m.subject === 'A new key was added to Rotor')).toBe(true);
    expect(await lines(owner)).toContain('Owner via Rotor added a new key to Rotor');
    expect(codeOf(await add(next))).toBe('key_exists');
    expect(codeOf(await add(newKey()))).toBe('key_limit');
    // The new key signs once an owner confirms it; the owner's own key is
    // Settings' to retire, never the app's.
    await h.decider(owner);
    expect(
      (await send(owner, 'POST', `/api/v1/connected-apps/${a.appId}/keys/${k.key_id}/confirm`))
        .statusCode,
    ).toBe(200);
    const own = await call(a, 'DELETE', `/api/v1/apps/keys/${a.keyId}`);
    expect([own.statusCode, codeOf(own)]).toEqual([409, 'key_added_by_owner']);
    const old = a.keyId;
    a.keyId = k.key_id;
    a.key = next;
    expect((await me(a)).statusCode).toBe(200);
    // Not the key signing the request, even one the app added.
    const signing = await call(a, 'DELETE', `/api/v1/apps/keys/${a.keyId}`);
    expect([signing.statusCode, codeOf(signing)]).toEqual([409, 'key_in_use']);
    expect(
      (await send(owner, 'DELETE', `/api/v1/connected-apps/${a.appId}/keys/${old}`)).statusCode,
    ).toBe(204);
    expect(
      codeOf(await call(a, 'GET', '/api/v1/apps/me', { key: { keyId: old, pem: next.pem } })),
    ).toBe('app_key_unknown');
    // An older key retires by itself seven days after a newer, confirmed
    // key's first use — never a pending one's.
    const third = newKey();
    const t = (await add(third)).json<{ key_id: string }>();
    await admin.query(
      `update connected_app_key set first_used_at = now() - interval '8 days' where id = $1`,
      [t.key_id],
    );
    expect((await me(a)).statusCode).toBe(200);
    await admin.query(`update connected_app_key set confirmed_at = now() where id = $1`, [
      t.key_id,
    ]);
    expect(codeOf(await me(a))).toBe('app_key_unknown');
    a.keyId = t.key_id;
    a.key = third;
    expect((await me(a)).statusCode).toBe(200);
    // The app retires a key it added, and the owners are told.
    const before = alertsSent(h).length;
    const fourth = newKey();
    const f = (await add(fourth)).json<{ key_id: string }>();
    expect((await call(a, 'DELETE', `/api/v1/apps/keys/${f.key_id}`)).statusCode).toBe(204);
    expect(
      alertsSent(h)
        .slice(before)
        .some((m) => m.subject === 'A key of Rotor was retired'),
    ).toBe(true);
  });

  // ------------------------------------------------------------ lifecycle

  it('revoked as its person’s role can no longer act, and by sign out everywhere; not by a password change', async () => {
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
    // Its key retired with it: the same key may be connected again.
    const again = await send(owner, 'POST', '/api/v1/connected-apps', {
      name: 'Fixed',
      member_id: owner.member_id,
      public_key: a.key.given,
      allowed_kinds: [],
    });
    expect(again.statusCode, again.body).toBe(201);
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
