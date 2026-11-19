import { describe, expect, it } from 'vitest';
import {
  basicAuthorization,
  createAppClient,
  fromBase64,
  parseConnectionString,
  toBase64,
} from './apps.js';
import { ApiRequestError, NetworkError } from './errors.js';
import type { RequestInitLike, ResponseLike } from './http.js';

/**
 * `@fdv/client/apps` (0.9.0-dev.63, APP6): an API key the vault generated,
 * sent on every request as HTTP Basic; and the connection string, read
 * strictly. Made-up keys, which no vault ever gave anybody.
 */
const CLIENT_ID = 'fdvc_AAECAwQFBgcICQoLDA0ODw';
const SECRET = 'fdvs_ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8';

/** An answer, as fetch gives it. */
function answer(status: number, body: unknown = {}): ResponseLike {
  const text = JSON.stringify(body);
  return {
    ok: status < 400,
    status,
    headers: { get: () => null },
    json: async () => JSON.parse(text) as unknown,
    text: async () => text,
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

/** The n-th access token a made-up vault gives: `fdvt_` and 43 characters. */
const tokenNo = (n: number) => `fdvt_${String(n).padStart(43, 'T')}`;

/** A vault that gives tokens (0.9.0-dev.72), and answers {} to everything else. */
function tokenVault(o: { expiresIn?: number } = {}) {
  const seen: Array<{ url: string; init: RequestInitLike }> = [];
  let minted = 0;
  const fetch = async (url: string, init: RequestInitLike) => {
    seen.push({ url, init });
    if (url.endsWith('/api/v1/apps/token')) {
      minted += 1;
      return answer(200, {
        access_token: tokenNo(minted),
        token_type: 'Bearer',
        expires_in: o.expiresIn ?? 900,
        scope: 'documents.send',
      });
    }
    return answer(200);
  };
  return { seen, fetch, minted: () => minted };
}

describe("a connected app's API key (0.9.0, APP6)", () => {
  it('is sent as Basic base64(client_id:secret), byte for byte', () => {
    const header = basicAuthorization(CLIENT_ID, SECRET);
    expect(header).toBe(
      'Basic ZmR2Y19BQUVDQXdRRkJnY0lDUW9MREEwT0R3OmZkdnNfSUNFaUl5UWxKaWNvS1NvckxDMHVMekF4TWpNME5UWTNPRGs2T3p3OVBqOA==',
    );
    expect(new TextDecoder().decode(fromBase64(header.slice(6)))).toBe(`${CLIENT_ID}:${SECRET}`);
  });

  it('never builds a header from what is not a client ID or a secret', () => {
    for (const [id, secret] of [
      ['fdvc_short', SECRET],
      [`${CLIENT_ID}:x`, SECRET],
      ['0b9a1f3e-6c2d-4e8a-9f71-2d5c8b4a7e10', SECRET],
      [CLIENT_ID, 'fdvs_short'],
      [CLIENT_ID, `${SECRET}\r\nx-other: y`],
      [CLIENT_ID, SECRET.replace('fdvs_', 'fdvc_')],
    ] as const) {
      expect(() => basicAuthorization(id, secret), `${id} ${secret}`).toThrow();
      expect(() =>
        createAppClient({ url: 'https://vault.example.com', clientId: id, secret }),
      ).toThrow();
    }
  });

  it('is sent once, for an access token, and every request carries the token, a download too, and nothing else that names a caller (0.9.0-dev.72)', async () => {
    const vault = tokenVault();
    const app = createAppClient({
      url: 'https://vault.example.com',
      clientId: CLIENT_ID,
      secret: SECRET,
      fetch: vault.fetch,
    });
    await app.me();
    await app.download('doc-1', { range: { start: 0, end: 9 } });
    await app.status('sent-1');
    expect(vault.seen.map((s) => s.url)).toEqual([
      'https://vault.example.com/api/v1/apps/token',
      'https://vault.example.com/api/v1/apps/me',
      'https://vault.example.com/api/v1/apps/documents/doc-1/content',
      'https://vault.example.com/api/v1/apps/intake/sent-1',
    ]);
    // The key, as Basic, to the token route alone, with the grant as a form.
    const [mint, ...rest] = vault.seen;
    expect(mint?.init).toMatchObject({
      method: 'POST',
      body: 'grant_type=client_credentials',
      headers: {
        authorization: basicAuthorization(CLIENT_ID, SECRET),
        'content-type': 'application/x-www-form-urlencoded',
      },
    });
    for (const s of rest) {
      expect(s.init.headers.authorization).toBe(`Bearer ${tokenNo(1)}`);
      const names = Object.keys(s.init.headers).map((n) => n.toLowerCase());
      expect(names).not.toContain('signature');
      expect(names).not.toContain('signature-input');
      expect(names).not.toContain('content-digest');
      expect(names).not.toContain('cookie');
    }
    // Nothing of the token or the key on the client itself.
    expect(JSON.stringify(app)).not.toMatch(/fdvt_|fdvs_/);
  });

  it('asks for a token again a minute before it ends, and once more when the vault says it ended (0.9.0-dev.72)', async () => {
    let now = Date.parse('2026-11-19T09:00:00Z');
    const vault = tokenVault();
    let refuse = 0;
    const app = createAppClient({
      url: 'https://vault.example.com',
      clientId: CLIENT_ID,
      secret: SECRET,
      now: () => now,
      fetch: async (url, init) => {
        if (!url.endsWith('/token') && refuse > 0) {
          refuse -= 1;
          return answer(401, {
            error: { code: 'app_token_expired', message: 'That access token has expired.' },
          });
        }
        return vault.fetch(url, init);
      },
    });
    await app.me();
    now += 830_000;
    await app.me();
    expect(vault.minted()).toBe(1);
    // A minute before its end (900 s): another.
    now += 20_000;
    await app.me();
    expect(vault.minted()).toBe(2);
    // Refused as ended: another, and the request sent again with it, once.
    refuse = 1;
    await app.me();
    expect(vault.minted()).toBe(3);
    const lastTwo = vault.seen.slice(-2).map((s) => [s.url, s.init.headers.authorization]);
    expect(lastTwo).toEqual([
      ['https://vault.example.com/api/v1/apps/token', basicAuthorization(CLIENT_ID, SECRET)],
      ['https://vault.example.com/api/v1/apps/me', `Bearer ${tokenNo(3)}`],
    ]);
    // Refused again with the new one: no loop, the refusal is the app's.
    refuse = 2;
    const err = await app.me().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({ status: 401, code: 'app_token_expired' });
    expect(vault.minted()).toBe(4);
    // A refusal of the key itself is never answered with another token.
    const revoked = createAppClient({
      url: 'https://vault.example.com',
      clientId: CLIENT_ID,
      secret: SECRET,
      fetch: async (url) =>
        url.endsWith('/token')
          ? answer(401, { error: { code: 'app_key_revoked', message: 'Revoked.' } })
          : answer(200),
    });
    expect(await revoked.me().catch((e: unknown) => e)).toMatchObject({
      status: 401,
      code: 'app_key_revoked',
    });
  });

  it('requests at once share one token, and a vault from before tokens is sent the key as Basic (0.9.0-dev.72)', async () => {
    const vault = tokenVault();
    const app = createAppClient({
      url: 'https://vault.example.com',
      clientId: CLIENT_ID,
      secret: SECRET,
      fetch: vault.fetch,
    });
    await Promise.all([app.me(), app.status('a'), app.list()]);
    expect(vault.minted()).toBe(1);
    // A vault from dev.63 to dev.71: the token route is not an app route
    // there, so the key is refused on it as anywhere else (401
    // app_key_not_accepted), and its capability document says nothing of
    // tokens. Basic, as before, asked again after ten minutes — when an
    // upgraded vault moves it to tokens.
    let now = Date.parse('2026-11-19T09:00:00Z');
    let upgraded = false;
    const seen: string[] = [];
    const older = createAppClient({
      url: 'https://vault.example.com',
      clientId: CLIENT_ID,
      secret: SECRET,
      now: () => now,
      fetch: async (url, init) => {
        seen.push(`${url.replace('https://vault.example.com', '')} ${init.headers.authorization}`);
        if (url.endsWith('/capabilities')) {
          return answer(200, { features: upgraded ? { connected_app_tokens: true } : {} });
        }
        if (url.endsWith('/token') && !upgraded) {
          return answer(401, {
            error: {
              code: 'app_key_not_accepted',
              message: 'A connected app can only use the app routes.',
            },
          });
        }
        return url.endsWith('/token')
          ? answer(200, { access_token: tokenNo(1), token_type: 'Bearer', expires_in: 900 })
          : answer(200);
      },
    });
    await older.me();
    await older.me();
    const basic = basicAuthorization(CLIENT_ID, SECRET);
    expect(seen).toEqual([
      `/api/v1/apps/token ${basic}`,
      // Asked without the key: the vault's capability document is public.
      '/api/v1/capabilities undefined',
      `/api/v1/apps/me ${basic}`,
      `/api/v1/apps/me ${basic}`,
    ]);
    // Ten minutes on, and the vault upgraded: the token route asked again, and used.
    upgraded = true;
    now += 10 * 60_000;
    seen.length = 0;
    await older.me();
    expect(seen).toEqual([`/api/v1/apps/token ${basic}`, `/api/v1/apps/me Bearer ${tokenNo(1)}`]);
    // No route at all (a 404) is an older vault too.
    const missing: string[] = [];
    await createAppClient({
      url: 'https://vault.example.com',
      clientId: CLIENT_ID,
      secret: SECRET,
      fetch: async (url, init) => {
        missing.push(
          `${url.replace('https://vault.example.com', '')} ${init.headers.authorization}`,
        );
        return url.endsWith('/token')
          ? answer(404, { error: { code: 'not_found', message: 'That page does not exist.' } })
          : answer(200, {});
      },
    }).me();
    expect(missing.at(-1)).toBe(`/api/v1/apps/me ${basic}`);
    // A vault that says it gives tokens is never sent Basic for that refusal:
    // the refusal is the app's.
    const newer = createAppClient({
      url: 'https://vault.example.com',
      clientId: CLIENT_ID,
      secret: SECRET,
      fetch: async (url) =>
        url.endsWith('/capabilities')
          ? answer(200, { features: { connected_app_tokens: true } })
          : url.endsWith('/token')
            ? answer(404, { error: { code: 'not_found', message: 'That page does not exist.' } })
            : answer(200),
    });
    expect(await newer.me().catch((e: unknown) => e)).toMatchObject({
      status: 404,
      code: 'not_found',
    });
  });

  it('never sends the key but over https, or plain http to this machine alone', async () => {
    const sent: string[] = [];
    const vault = tokenVault();
    const fetch = async (url: string, init: RequestInitLike) => {
      if (!url.endsWith('/token')) sent.push(url);
      return vault.fetch(url, init);
    };
    for (const url of [
      'http://vault.example.com',
      'http://192.168.1.20',
      '',
      'vault.example.com',
      'https://vault.example.com/api',
      'https://user@vault.example.com',
      'ftp://vault.example.com',
    ]) {
      expect(
        () => createAppClient({ url, clientId: CLIENT_ID, secret: SECRET, fetch }),
        url,
      ).toThrow(/not a vault's address/);
    }
    expect(sent).toEqual([]);
    // https anywhere; plain http to this machine; a slash at the end is no matter.
    for (const url of [
      'https://vault.example.com',
      'https://vault.example.com/',
      'http://localhost:8080',
      'http://127.0.0.1',
      'http://[::1]:3000',
    ]) {
      await createAppClient({ url, clientId: CLIENT_ID, secret: SECRET, fetch }).me();
    }
    expect(sent).toHaveLength(5);
    expect(sent[1]).toBe('https://vault.example.com/api/v1/apps/me');
  });

  it('the client never builds a path from what is not one', () => {
    const app = createAppClient({
      url: 'https://vault.example.com',
      clientId: CLIENT_ID,
      secret: SECRET,
      fetch: async () => {
        throw new Error('never sent');
      },
    });
    expect(() => app.status('../documents')).toThrow(/not an external_id/);
    expect(() => app.withdraw('a/b')).toThrow(/not an external_id/);
  });
});

describe('a connection string (0.9.0, APP6)', () => {
  const as = (o: unknown, prefix = 'fdvapp2.') =>
    `${prefix}${toBase64(new TextEncoder().encode(JSON.stringify(o)), true)}`;
  const good = { url: 'https://vault.example.com', client_id: CLIENT_ID, instance_id: 'c1f4' };

  it('base64 both ways, and a connection string read, with its secret or without', () => {
    for (const n of [0, 1, 2, 3, 31, 32, 33]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255);
      expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
      expect([...fromBase64(toBase64(bytes, true))]).toEqual([...bytes]);
    }
    expect(parseConnectionString(as(good))).toEqual(good);
    expect(parseConnectionString(as({ ...good, secret: SECRET }))).toEqual({
      ...good,
      secret: SECRET,
    });
    expect(parseConnectionString(as({ ...good, instance_id: null })).instance_id).toBeNull();
    expect(() => parseConnectionString('nope')).toThrow();
  });

  it('one made before API keys is refused, saying what to do', () => {
    const old = as(
      {
        url: 'https://vault.example.com',
        app_id: '0b9a1f3e-6c2d-4e8a-9f71-2d5c8b4a7e10',
        key_id: '5e2c7d91-3a4b-4c6d-8e9f-0a1b2c3d4e5f',
        instance_id: null,
        fingerprint: 'b16c 2d1b ead1 2626 3976 4fdb 0ee4 d377',
      },
      'fdvapp1.',
    );
    expect(() => parseConnectionString(old)).toThrow(/before API keys.*generates an API key/);
  });

  it('is read strictly: nothing in it can reach a header or another host', () => {
    // http to this machine alone; an origin with a port.
    expect(parseConnectionString(as({ ...good, url: 'http://localhost:8080' })).url).toBe(
      'http://localhost:8080',
    );
    for (const [why, o] of [
      ['a quote in the client id', { ...good, client_id: `${CLIENT_ID}"` }],
      [
        'a client id that is a UUID',
        { ...good, client_id: '0b9a1f3e-6c2d-4e8a-9f71-2d5c8b4a7e10' },
      ],
      ['a secret that is not one', { ...good, secret: 'hunter2' }],
      ['a secret with a header after it', { ...good, secret: `${SECRET}\r\nx: y` }],
      ['plain http elsewhere', { ...good, url: 'http://vault.example.com' }],
      ['a path', { ...good, url: 'https://vault.example.com/api' }],
      ['a user before the host', { ...good, url: 'https://vault.example.com@evil.example' }],
      ['a trailing slash', { ...good, url: 'https://vault.example.com/' }],
      ['an unknown field', { ...good, callback: 'https://evil.example' }],
      ['an old field', { ...good, fingerprint: 'b16c 2d1b ead1 2626 3976 4fdb 0ee4 d377' }],
    ] as const) {
      expect(() => parseConnectionString(as(o)), why).toThrow(/not a connection string/);
    }
    // base64url alone: standard base64's + and /, padding, spaces.
    const text = as(good);
    expect(() => parseConnectionString(`${text}=`)).toThrow();
    expect(() => parseConnectionString(text.replace(/-/g, '+').replace(/_/g, '/') + '+')).toThrow();
    expect(() => parseConnectionString(`fdvapp2.${text.slice(8, 20)} ${text.slice(20)}`)).toThrow();
  });
});

describe("a connected app's request with no answer (CL2)", () => {
  it('is offline, a download too, with what fetch threw as its cause', async () => {
    const thrown = new TypeError('fetch failed');
    const app = createAppClient({
      url: 'https://vault.example.com',
      clientId: CLIENT_ID,
      secret: SECRET,
      fetch: async () => {
        throw thrown;
      },
    });
    for (const p of [app.download('doc-1'), app.sentFile('sent-1'), app.me()]) {
      const err = await p.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NetworkError);
      expect(err).toMatchObject({ kind: 'offline', cause: thrown, detail: 'fetch failed' });
    }
  });
});
