import { APP_EMPTY_DIGEST } from '@fdv/shared';
import { describe, expect, it } from 'vitest';
import {
  contentDigestOf,
  createAppClient,
  fromBase64,
  parseConnectionString,
  signatureBaseOf,
  signatureParams,
  signRequest,
  toBase64,
} from './apps.js';

/**
 * The signer of `@fdv/client/apps` (0.9.0, APP1), held to the contract's
 * worked examples byte for byte: the RFC 9421 Appendix B.1.4 test key,
 * which nobody may use for real.
 */
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIJ+DYvh6SEqVTm50DFtMDoQikTmiCqirVv9mWG9qfSnF
-----END PRIVATE KEY-----`;
const KEYID = '0b9a1f3e-6c2d-4e8a-9f71-2d5c8b4a7e10.5e2c7d91-3a4b-4c6d-8e9f-0a1b2c3d4e5f';
const CREATED = 1794830400;

describe("a connected app's signer (0.9.0, APP1)", () => {
  it('worked example 1, a GET: the base is 402 bytes and the signature is the contract’s', async () => {
    const params = signatureParams({
      created: CREATED,
      keyid: KEYID,
      nonce: 'q2v5Xb8Kc1nT4yWm9pLd3A',
    });
    const target = '/api/v1/apps/documents?kind=bank_statement&from=2025-11-01&limit=50';
    const base = signatureBaseOf({
      method: 'GET',
      target,
      contentDigest: APP_EMPTY_DIGEST,
      params,
    });
    expect(base).toBe(
      [
        '"@method": GET',
        '"@path": /api/v1/apps/documents',
        '"@query": ?kind=bank_statement&from=2025-11-01&limit=50',
        '"content-digest": sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:',
        '"@signature-params": ("@method" "@path" "@query" "content-digest");created=1794830400;keyid="0b9a1f3e-6c2d-4e8a-9f71-2d5c8b4a7e10.5e2c7d91-3a4b-4c6d-8e9f-0a1b2c3d4e5f";nonce="q2v5Xb8Kc1nT4yWm9pLd3A";alg="ed25519";tag="fdv-app"',
      ].join('\n'),
    );
    expect(new TextEncoder().encode(base).length).toBe(402);
    const signed = await signRequest({
      method: 'GET',
      target,
      keyid: KEYID,
      privateKey: TEST_KEY,
      created: CREATED,
      nonce: 'q2v5Xb8Kc1nT4yWm9pLd3A',
    });
    expect(signed).toEqual({
      'content-digest': 'sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:',
      'signature-input': `fdv=${params}`,
      signature:
        'fdv=:svm/e0HinJECVqp1YVETGIVKXu8YHfHxL5MsK5BV7p2+oBP5aDq4Q2IWcWlAPH2EapyPthUzmXUwkbvKQUosBg==:',
    });
  });

  it('worked example 2, a POST with a JSON body: its digest and signature are the contract’s', async () => {
    const signed = await signRequest({
      method: 'POST',
      target: '/api/v1/apps/documents/7c4e2a10-9b3d-4f6e-8a21-5d0c9e8f7b62/links',
      body: '{"mode":"view"}',
      keyid: KEYID,
      privateKey: TEST_KEY,
      created: CREATED,
      nonce: 'Hn3kQ7rT2xLp9vB6cW1sZg',
    });
    expect(signed['content-digest']).toBe('sha-256=:jiFmkkKT2RXl18q8BbzJlDQtG4I0hKhvLwf5yptXusM=:');
    expect(signed.signature).toBe(
      'fdv=:Z5FdCGmjraCmjPjFBiIB9/3mYq8kTL1Kponj4fxVyRLn40g2ZoqrbpazhLXYOMoKsXwG06ACO7CKz+jQBbM7Bg==:',
    );
  });

  it('a body of nothing is the digest of zero bytes; every signing has a fresh nonce', async () => {
    expect(await contentDigestOf()).toBe(APP_EMPTY_DIGEST);
    const a = await signRequest({
      method: 'GET',
      target: '/api/v1/apps/me',
      keyid: KEYID,
      privateKey: TEST_KEY,
    });
    const b = await signRequest({
      method: 'GET',
      target: '/api/v1/apps/me',
      keyid: KEYID,
      privateKey: TEST_KEY,
    });
    const nonce = (s: string) => /nonce="([^"]+)"/.exec(s)?.[1];
    expect(nonce(a['signature-input'])).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(nonce(a['signature-input'])).not.toBe(nonce(b['signature-input']));
  });

  it('base64 both ways, and a connection string read', () => {
    for (const n of [0, 1, 2, 3, 31, 32, 33]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255);
      expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
      expect([...fromBase64(toBase64(bytes, true))]).toEqual([...bytes]);
    }
    const c = {
      url: 'https://vault.example.com',
      app_id: '0b9a1f3e-6c2d-4e8a-9f71-2d5c8b4a7e10',
      key_id: '5e2c7d91-3a4b-4c6d-8e9f-0a1b2c3d4e5f',
      instance_id: 'c1f4',
      fingerprint: 'b16c 2d1b ead1 2626 3976 4fdb 0ee4 d377',
    };
    const text = `fdvapp1.${toBase64(new TextEncoder().encode(JSON.stringify(c)), true)}`;
    expect(parseConnectionString(text)).toEqual(c);
    expect(() => parseConnectionString('nope')).toThrow();
  });

  it('a connection string is read strictly: nothing in it can reach a header or another host', () => {
    const good = {
      url: 'https://vault.example.com',
      app_id: '0b9a1f3e-6c2d-4e8a-9f71-2d5c8b4a7e10',
      key_id: '5e2c7d91-3a4b-4c6d-8e9f-0a1b2c3d4e5f',
      instance_id: null,
      fingerprint: 'b16c 2d1b ead1 2626 3976 4fdb 0ee4 d377',
    };
    const as = (o: unknown) =>
      `fdvapp1.${toBase64(new TextEncoder().encode(JSON.stringify(o)), true)}`;
    expect(parseConnectionString(as(good))).toEqual(good);
    // http to this machine alone; an origin with a port.
    expect(parseConnectionString(as({ ...good, url: 'http://localhost:8080' })).url).toBe(
      'http://localhost:8080',
    );
    for (const [why, o] of [
      ['a quote in the app id', { ...good, app_id: '0b9a1f3e-6c2d-4e8a-9f71-2d5c8b4a7e10"' }],
      ['an id that is no UUID', { ...good, key_id: 'acme' }],
      ['an upper-case id', { ...good, app_id: good.app_id.toUpperCase() }],
      ['plain http elsewhere', { ...good, url: 'http://vault.example.com' }],
      ['a path', { ...good, url: 'https://vault.example.com/api' }],
      ['a user before the host', { ...good, url: 'https://vault.example.com@evil.example' }],
      ['a trailing slash', { ...good, url: 'https://vault.example.com/' }],
      ['an unknown field', { ...good, callback: 'https://evil.example' }],
      ['a fingerprint not written as one', { ...good, fingerprint: 'b16c2d1b' }],
    ] as const) {
      expect(() => parseConnectionString(as(o)), why).toThrow(/not a connection string/);
    }
    // base64url alone: standard base64's + and /, padding, spaces.
    const text = as(good);
    expect(() => parseConnectionString(`${text}=`)).toThrow();
    expect(() => parseConnectionString(text.replace(/-/g, '+').replace(/_/g, '/') + '+')).toThrow();
    expect(() => parseConnectionString(`fdvapp1.${text.slice(8, 20)} ${text.slice(20)}`)).toThrow();
  });

  it('the client never builds a path or a keyid from what is not one', () => {
    const fetch = async () => {
      throw new Error('never sent');
    };
    expect(() =>
      createAppClient({
        baseUrl: 'https://vault.example.com',
        appId: 'x" , other="y',
        keyId: '5e2c7d91-3a4b-4c6d-8e9f-0a1b2c3d4e5f',
        privateKey: '',
        fetch,
      }),
    ).toThrow();
    const app = createAppClient({
      baseUrl: 'https://vault.example.com',
      appId: '0b9a1f3e-6c2d-4e8a-9f71-2d5c8b4a7e10',
      keyId: '5e2c7d91-3a4b-4c6d-8e9f-0a1b2c3d4e5f',
      privateKey: '',
      fetch,
    });
    expect(() => app.status('../documents')).toThrow(/not an external_id/);
    expect(() => app.withdraw('a/b')).toThrow(/not an external_id/);
  });
});
