import { readFileSync } from 'node:fs';
import { testAdminUrl } from '@fdv/db/testing';
import {
  APP_UPDATE_REQUIRED_MESSAGE,
  meetsMinimum,
  parseVersion,
  type Capabilities,
  type ConnectedAppView,
  type Tokens,
} from '@fdv/shared';
import type { FastifyRequest, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIN_CLIENT_VERSION as SENT_MINIMUM } from './capabilities.js';
import {
  MIN_CLIENT_VERSION,
  PHONE_APPS,
  phoneAppTooOld,
  phoneAppVersion,
  refuseOldPhoneApp,
  type PhoneApp,
  SUPPORTED_PHONE_APPS,
} from './phone-apps.js';
import { appKeyFor, basicFor, createHarness, type Harness } from './test-harness.js';

const phone = (version: string) => `FamilyDocumentVault/${version} (Android 15; Google Pixel 8a)`;
const TOO_OLD = phone('0.17.0');
const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

describe('the phone apps table (phone-apps.json)', () => {
  it('is the one place the minimum is written: the capability document sends it', () => {
    expect(SENT_MINIMUM).toBe(MIN_CLIENT_VERSION);
    expect(MIN_CLIENT_VERSION).toBe('0.18.0');
  });

  it('lists each app once, newest first, each with a vault tag, the minimum among them', () => {
    const apps = PHONE_APPS.map((a) => a.app);
    expect(new Set(apps).size).toBe(apps.length);
    for (const a of PHONE_APPS) {
      expect(() => parseVersion(a.app)).not.toThrow();
      expect(a.vault_tag).toMatch(/^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
    }
    for (let i = 1; i < PHONE_APPS.length; i += 1) {
      expect(meetsMinimum(PHONE_APPS[i - 1]?.app as string, PHONE_APPS[i]?.app as string)).toBe(
        true,
      );
    }
    // An older app never carries a newer client than a newer app.
    const devOf = (tag: string) => Number(/-dev\.(\d+)$/.exec(tag)?.[1] ?? Infinity);
    for (let i = 1; i < PHONE_APPS.length; i += 1) {
      const [newer, older] = [PHONE_APPS[i - 1], PHONE_APPS[i]] as [PhoneApp, PhoneApp];
      expect(devOf(older.vault_tag) <= devOf(newer.vault_tag), older.app).toBe(true);
    }
    expect(apps).toContain(MIN_CLIENT_VERSION);
    expect(SUPPORTED_PHONE_APPS.map((a) => a.app)).toEqual([
      '0.21.0',
      '0.20.0',
      '0.19.0',
      '0.18.1',
      '0.18.0',
    ]);
    // Four tags' clients to run: 0.18.0 and 0.18.1 carry the same one.
    expect([...new Set(SUPPORTED_PHONE_APPS.map((a) => a.vault_tag))]).toEqual([
      'v0.9.0-dev.87',
      'v0.9.0-dev.79',
      'v0.9.0-dev.66',
      'v0.9.0-dev.65',
    ]);
  });

  it('is what the older-client script reads: the same file, the same supported apps', () => {
    const raw = JSON.parse(readFileSync(new URL('./phone-apps.json', import.meta.url), 'utf8')) as {
      min_client_version: string;
      apps: { app: string; vault_tag: string }[];
    };
    expect(raw.min_client_version).toBe(MIN_CLIENT_VERSION);
    expect(raw.apps).toEqual(PHONE_APPS);
    const script = readFileSync(
      new URL('../../../scripts/older-client.mjs', import.meta.url),
      'utf8',
    );
    expect(script).toContain('apps/api/src/phone-apps.json');
    expect(script).toContain('--all-supported');
  });
});

describe('the phone app, read from its User-Agent', () => {
  it('is its version, and nothing else is', () => {
    expect(phoneAppVersion(phone('0.19.0'))).toBe('0.19.0');
    expect(phoneAppVersion('FamilyDocumentVault/0.20.0-beta.1 (Android 16; Pixel 9)')).toBe(
      '0.20.0',
    );
    expect(phoneAppVersion('FamilyDocumentVault/0.19.0')).toBe('0.19.0');
    for (const other of [
      undefined,
      '',
      CHROME,
      'curl/8.4.0',
      'FamilyDocumentVault',
      'FamilyDocumentVault/',
      'FamilyDocumentVault/nineteen (Android 15)',
      'FamilyDocumentVault/0.19 (Android 15)',
      'FamilyDocumentVault/0.19.0x (Android 15)',
      // What the phone says when it cannot read its own version: unknown, never refused.
      'FamilyDocumentVault/0.0.0 (Android 15; Google Pixel 8a)',
      'FamilyDocumentVault/0.0.0',
      'NotFamilyDocumentVault/0.1.0',
      'Mozilla/5.0 FamilyDocumentVault/0.1.0',
      ['FamilyDocumentVault/0.1.0', 'FamilyDocumentVault/0.1.0'],
    ]) {
      expect(phoneAppVersion(other), String(other)).toBeNull();
      expect(phoneAppTooOld(other), String(other)).toBe(false);
    }
  });

  it('is too old below the minimum, and only then', () => {
    expect(phoneAppTooOld(phone('0.17.0'))).toBe(true);
    expect(phoneAppTooOld(phone('0.1.3'))).toBe(true);
    expect(phoneAppTooOld(phone('0.17.99'))).toBe(true);
    // A pre-release counts as its release, as negotiate counts it.
    expect(phoneAppTooOld('FamilyDocumentVault/0.18.0-rc.1 (Android 15; Pixel)')).toBe(false);
    for (const a of SUPPORTED_PHONE_APPS) expect(phoneAppTooOld(phone(a.app))).toBe(false);
    expect(phoneAppTooOld(phone('1.0.0'))).toBe(false);
  });
});

describe.skipIf(!testAdminUrl())('a phone app too old for the vault (0.9.0-dev.79)', () => {
  let h: Harness;
  let owner: Tokens;
  let peer = 0;

  const ask = (
    method: 'GET' | 'POST' | 'HEAD',
    url: string,
    headers: Record<string, string> = {},
    payload?: unknown,
  ): Promise<LightMyRequestResponse> =>
    h.app.inject({
      method,
      url,
      headers,
      ...(payload === undefined ? {} : { payload: payload as never }),
      remoteAddress: `10.79.${++peer >> 8}.${peer & 0xff}`,
    });
  const codeOf = (r: LightMyRequestResponse) =>
    r.body ? r.json<{ error?: { code?: string } }>().error?.code : undefined;

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 20_000 });
    owner = await h.setup();
  }, 120_000);
  afterAll(() => h.close());

  it('is answered 426 app_update_required on a normal route, with the minimum and plain words', async () => {
    for (const [method, url] of [
      ['GET', '/api/v1/documents'],
      ['GET', '/api/v1/me'],
      ['POST', '/api/v1/auth/sessions/sign-out-others'],
      ['GET', '/api/v1/no-such-route'],
    ] as const) {
      const res = await ask(method, url, { ...h.as(owner), 'user-agent': TOO_OLD });
      expect([method, url, res.statusCode]).toEqual([method, url, 426]);
      const { error } = res.json<{ error: Record<string, unknown> }>();
      expect(typeof error.request_id).toBe('string');
      expect({ ...error, request_id: 'r' }).toEqual({
        code: 'app_update_required',
        message: APP_UPDATE_REQUIRED_MESSAGE,
        min_client_version: '0.18.0',
        retriable: false,
        request_id: 'r',
      });
      expect(res.headers['x-fdv-server-version']).toBeDefined();
    }
    expect(APP_UPDATE_REQUIRED_MESSAGE).toMatch(/too old for this vault/);
    expect(APP_UPDATE_REQUIRED_MESSAGE).toMatch(/Update the app/);
    // Signing in too: nothing it would sign in to works.
    const signIn = await ask(
      'POST',
      '/api/v1/auth/password',
      { 'user-agent': TOO_OLD },
      {
        email: 'owner@example.test',
        password: 'whatever it is',
      },
    );
    expect([signIn.statusCode, codeOf(signIn)]).toEqual([426, 'app_update_required']);
  });

  it('still reads the capability document, renews its session, signs out, and the health checks answer', async () => {
    const caps = await ask('GET', '/api/v1/capabilities', { 'user-agent': TOO_OLD });
    expect(caps.statusCode).toBe(200);
    expect(caps.json<Capabilities>().min_client_version).toBe('0.18.0');
    const capsQuery = await ask('GET', '/api/v1/capabilities?x=1', { 'user-agent': TOO_OLD });
    expect(capsQuery.statusCode).toBe(200);
    expect((await ask('HEAD', '/api/v1/capabilities', { 'user-agent': TOO_OLD })).statusCode).toBe(
      200,
    );
    expect((await ask('GET', '/healthz', { 'user-agent': TOO_OLD })).statusCode).toBe(200);
    expect((await ask('GET', '/readyz', { 'user-agent': TOO_OLD })).statusCode).toBe(200);
    // Not an API path (the web's files, nginx's own): never this answer.
    expect(codeOf(await ask('GET', '/index.html', { 'user-agent': TOO_OLD }))).not.toBe(
      'app_update_required',
    );
    // A phone signed in before the vault's minimum rose: it keeps only its
    // refresh token, so it renews first thing. That is answered — every
    // released client ends its session on a refused renewal, and the phone
    // then wipes what it keeps offline — and gives the access token that
    // signing out needs.
    const signedIn = await ask(
      'POST',
      '/api/v1/auth/password',
      { 'user-agent': phone('0.19.0') },
      { email: 'owner@example.test', password: 'correct horse battery' },
    );
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    const renewed = await ask(
      'POST',
      '/api/v1/auth/refresh',
      { 'user-agent': TOO_OLD },
      { refresh_token: signedIn.json<Tokens>().refresh_token },
    );
    expect(renewed.statusCode, renewed.body).toBe(200);
    const session = renewed.json<Tokens>();
    // Anything else it asks with that token is still "update the app".
    const told = await ask('GET', '/api/v1/me', { ...h.as(session), 'user-agent': TOO_OLD });
    expect([told.statusCode, codeOf(told)]).toEqual([426, 'app_update_required']);
    // Signing out works, and the session is over after it.
    const out = await ask('POST', '/api/v1/auth/logout', {
      ...h.as(session),
      'user-agent': TOO_OLD,
    });
    expect(out.statusCode).toBe(204);
    const after = await ask('GET', '/api/v1/me', {
      ...h.as(session),
      'user-agent': phone('0.19.0'),
    });
    expect(after.statusCode).toBe(401);
  });

  it('the current and every supported app pass, and so does a request with no app version', async () => {
    for (const ua of [
      ...SUPPORTED_PHONE_APPS.map((a) => phone(a.app)),
      phone('0.20.0'),
      phone('1.0.0'),
      CHROME,
      'curl/8.4.0',
      'FamilyDocumentVault/unknown (Android 15)',
      'FamilyDocumentVault/0.0.0 (Android 15; Google Pixel 8a)',
      '',
    ]) {
      const res = await ask('GET', '/api/v1/me', { ...h.as(owner), 'user-agent': ua });
      expect([ua, res.statusCode]).toEqual([ua, 200]);
    }
    // No User-Agent at all — light-my-request always sends one, so the
    // hook itself is asked: the web app's fetch, or any other client.
    const bare = { method: 'GET', url: '/api/v1/me', headers: { ...h.as(owner) } };
    expect(() => refuseOldPhoneApp(bare as unknown as FastifyRequest)).not.toThrow();
    const old = { ...bare, headers: { ...bare.headers, 'user-agent': TOO_OLD } };
    expect(() => refuseOldPhoneApp(old as unknown as FastifyRequest)).toThrow(/too old/);
  });

  it('a connected app is never refused by it, whatever it calls itself', async () => {
    await h.decider(owner);
    const made = await ask('POST', '/api/v1/connected-apps', h.as(owner), {
      name: 'Acme Money',
      member_id: owner.member_id,
      allowed_kinds: ['bank_statement'],
      scopes: ['documents.send'],
    });
    expect(made.statusCode, made.body).toBe(201);
    const key = await appKeyFor(h, owner, made.json<ConnectedAppView>());
    const asApp = (authorization: string, method: 'GET' | 'POST', url: string, body?: string) =>
      h.app.inject({
        method,
        url,
        headers: {
          authorization,
          'user-agent': TOO_OLD,
          ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(body ? { payload: body } : {}),
        remoteAddress: '127.0.0.1',
      });
    const basic = basicFor(key).authorization;
    const me = await asApp(basic, 'GET', '/api/v1/apps/me');
    expect(me.statusCode, me.body).toBe(200);
    const token = await asApp(basic, 'POST', '/api/v1/apps/token', 'grant_type=client_credentials');
    expect(token.statusCode, token.body).toBe(200);
    const bearer = `Bearer ${token.json<{ access_token: string }>().access_token}`;
    const again = await asApp(bearer, 'GET', '/api/v1/apps/me');
    expect(again.statusCode, again.body).toBe(200);
    // Off its own routes it is still told that, as ever: never 426.
    const elsewhere = await asApp(bearer, 'GET', '/api/v1/documents');
    expect([elsewhere.statusCode, codeOf(elsewhere)]).toEqual([401, 'app_key_not_accepted']);
  });

  it("a paired computer's key is not refused by it either", async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/devices/me',
      headers: { authorization: 'Device fdvd_not-a-real-key', 'user-agent': TOO_OLD },
      remoteAddress: '127.0.0.1',
    });
    expect(codeOf(res)).not.toBe('app_update_required');
    expect(res.statusCode).toBe(401);
  });
});
