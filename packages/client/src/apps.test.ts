import { describe, expect, it } from 'vitest';
import {
  basicAuthorization,
  createAppClient,
  fromBase64,
  parseConnectionString,
  toBase64,
} from './apps.js';
import { NetworkError } from './errors.js';
import type { RequestInitLike } from './http.js';

/**
 * `@fdv/client/apps` (0.9.0-dev.63, APP6): an API key the vault generated,
 * sent on every request as HTTP Basic; and the connection string, read
 * strictly. Made-up keys, which no vault ever gave anybody.
 */
const CLIENT_ID = 'fdvc_AAECAwQFBgcICQoLDA0ODw';
const SECRET = 'fdvs_ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8';

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

  it('every request carries it, a download too, and nothing else that names a caller', async () => {
    const seen: Array<{ url: string; init: RequestInitLike }> = [];
    const app = createAppClient({
      url: 'https://vault.example.com',
      clientId: CLIENT_ID,
      secret: SECRET,
      fetch: async (url, init) => {
        seen.push({ url, init });
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({}),
          text: async () => '{}',
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      },
    });
    await app.me();
    await app.download('doc-1', { range: { start: 0, end: 9 } });
    await app.status('sent-1');
    expect(seen.map((s) => s.url)).toEqual([
      'https://vault.example.com/api/v1/apps/me',
      'https://vault.example.com/api/v1/apps/documents/doc-1/content',
      'https://vault.example.com/api/v1/apps/intake/sent-1',
    ]);
    for (const s of seen) {
      expect(s.init.headers.authorization).toBe(basicAuthorization(CLIENT_ID, SECRET));
      const names = Object.keys(s.init.headers).map((n) => n.toLowerCase());
      expect(names).not.toContain('signature');
      expect(names).not.toContain('signature-input');
      expect(names).not.toContain('content-digest');
      expect(names).not.toContain('cookie');
    }
  });

  it('never sends the key but over https, or plain http to this machine alone', async () => {
    const sent: string[] = [];
    const fetch = async (url: string) => {
      sent.push(url);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({}),
        text: async () => '{}',
        arrayBuffer: async () => new ArrayBuffer(0),
      };
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
