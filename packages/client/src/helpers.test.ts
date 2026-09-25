import type { Capabilities } from '@fdv/shared';
import { describe, expect, it } from 'vitest';
import { ApiRequestError, isRetriableStatus, NetworkError, parseRetryAfter } from './errors.js';
import { createHttp } from './http.js';
import { multipartBody } from './multipart.js';
import { negotiate } from './negotiate.js';
import { isPrivateHost, serverOriginFrom } from './origin.js';
import { MAX_RETRY_SECONDS, retryDelay } from './retry.js';
import { StepUpCoordinator } from './step-up.js';

describe('retrying', () => {
  const limited = (after: number) =>
    new ApiRequestError(429, 'rate_limited', 'Slow down.', undefined, { retryAfterSeconds: after });

  it('Retry-After 30 waits 30 s', () => {
    expect(retryDelay(limited(30), 1)).toBe(30_000);
  });

  it('an HTTP-date Retry-After is honoured', () => {
    const now = Date.parse('2026-09-23T10:00:00Z');
    expect(parseRetryAfter('Wed, 23 Sep 2026 10:00:45 GMT', now)).toBe(45);
    expect(parseRetryAfter('12', now)).toBe(12);
    expect(parseRetryAfter('not a date', now)).toBeUndefined();
  });

  it('backoff is capped at 300 s, and jittered below it', () => {
    expect(retryDelay(new Error('x'), 30, () => 1)).toBe(MAX_RETRY_SECONDS * 1000);
    expect(retryDelay(new Error('x'), 3, () => 0.5)).toBe(4000);
    expect(retryDelay(limited(10_000), 1)).toBe(MAX_RETRY_SECONDS * 1000);
  });

  it('429 and 5xx are worth retrying whatever the envelope says; 4xx are not', () => {
    for (const s of [408, 429, 500, 503]) expect(isRetriableStatus(s), String(s)).toBe(true);
    for (const s of [400, 401, 403, 404, 409, 413, 415, 422])
      expect(isRetriableStatus(s)).toBe(false);
    expect(new ApiRequestError(429, 'bad_request', 'x').retriable).toBe(true);
  });
});

describe('the transport', () => {
  it('reads the whole error envelope, and Retry-After', async () => {
    const http = createHttp({
      baseUrl: 'https://vault.example/',
      fetch: async () => ({
        ok: false,
        status: 429,
        headers: { get: (n) => (n === 'retry-after' ? '17' : null) },
        json: async () => ({
          error: { code: 'bad_request', message: 'Too many.', retriable: false, request_id: 'r1' },
        }),
        text: async () => '',
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
    });
    const err = (await http.request('/api/v1/me').catch((e: unknown) => e)) as ApiRequestError;
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err.status).toBe(429);
    expect(err.retriable).toBe(true);
    expect(err.retryAfterSeconds).toBe(17);
    expect(err.requestId).toBe('r1');
  });

  it('no answer is a NetworkError, not an ApiRequestError', async () => {
    const http = createHttp({
      baseUrl: '',
      fetch: async () => {
        throw new TypeError('Network request failed');
      },
    });
    const err = (await http.request('/x').catch((e: unknown) => e)) as NetworkError;
    expect(err).toBeInstanceOf(NetworkError);
    expect(err).not.toBeInstanceOf(ApiRequestError);
    expect(err.kind).toBe('offline');
  });

  it('says which installation it is, when it is one, on every request', async () => {
    const seen: Record<string, string>[] = [];
    const http = createHttp({
      baseUrl: 'https://vault.example',
      installationId: '0f5a1c2e-9b7d-4e61-8a33-5c2d7e9f1a40',
      fetch: async (_url, init) => {
        seen.push(init.headers);
        return {
          ok: false,
          status: 401,
          headers: { get: () => null },
          json: async () => ({
            error: {
              code: 'session_ended',
              message: 'Please sign in again.',
              reason: 'reused',
              request_id: 'r2',
            },
          }),
          text: async () => '',
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      },
    });
    const err = (await http
      .request('/api/v1/auth/refresh', { method: 'POST', body: {} })
      .catch((e: unknown) => e)) as ApiRequestError;
    expect(seen[0]?.['x-fdv-installation']).toBe('0f5a1c2e-9b7d-4e61-8a33-5c2d7e9f1a40');
    // And why a session ended, when the vault says (0.4.11).
    expect(err.reason).toBe('reused');
  });

  it('builds absolute addresses from the vault origin', () => {
    const http = createHttp({
      baseUrl: 'https://vault.local:8443/',
      fetch: async () => undefined as never,
    });
    expect(http.url('/api/v1/me')).toBe('https://vault.local:8443/api/v1/me');
  });
});

describe('a vault address, from whatever was typed or pasted', () => {
  it('vault.local becomes https://vault.local', () => {
    expect(serverOriginFrom('vault.local')).toMatchObject({
      origin: 'https://vault.local',
      assumedScheme: true,
      trimmed: false,
    });
    expect(serverOriginFrom('http://192.168.1.20:8080/')?.origin).toBe('http://192.168.1.20:8080');
    expect(serverOriginFrom('https://Vault.Example:443')?.origin).toBe('https://vault.example');
  });

  it('a pasted invitation link gives its origin, and the token is discarded', () => {
    const got = serverOriginFrom('https://vault.example/join/abcdefSECRETtoken?x=1#y');
    expect(got?.origin).toBe('https://vault.example');
    expect(got?.trimmed).toBe(true);
    expect(JSON.stringify(got)).not.toContain('SECRET');
  });

  it('refuses what is not an address, or would mislead about one', () => {
    for (const bad of [
      '',
      'two words',
      'ftp://vault',
      'https://trusted.example@evil.example',
      'https://[nope',
    ]) {
      expect(serverOriginFrom(bad), bad).toBeNull();
    }
  });

  it('a number written the way a browser reads as octal or hex is refused, not trusted', () => {
    // A browser reads 010.0.0.1 as 8.0.0.1: public, though it looks private.
    for (const sly of [
      'http://010.0.0.1',
      'http://172.016.0.1',
      'http://0x7f.0.0.1',
      'http://2130706433',
      'http://1.2.3',
    ]) {
      expect(serverOriginFrom(sly), sly).toBeNull();
    }
    expect(isPrivateHost('010.0.0.1')).toBe(false);
    expect(serverOriginFrom('http://10.0.0.1')?.origin).toBe('http://10.0.0.1');
  });

  it('192.168.1.20 and 100.100.1.1 are private, 8.8.8.8 is not', () => {
    expect(isPrivateHost('192.168.1.20')).toBe(true);
    expect(isPrivateHost('100.100.1.1')).toBe(true);
    expect(isPrivateHost('10.0.2.2')).toBe(true);
    expect(isPrivateHost('vault.local')).toBe(true);
    expect(isPrivateHost('8.8.8.8')).toBe(false);
    expect(isPrivateHost('vault.example')).toBe(false);
    expect(isPrivateHost('172.32.0.1')).toBe(false);
  });
});

describe('negotiating with a vault', () => {
  const caps = (over: Partial<Capabilities> = {}) =>
    ({
      product: 'family-document-vault',
      server_version: '0.4.3',
      api_version: 1,
      min_client_version: '0.1.0',
      setup_required: false,
      ...over,
    }) as Capabilities;
  const me = { clientVersion: '0.1.2', minServerVersion: '0.4.2' };

  it('one answer for each way it can go', () => {
    expect(negotiate(caps(), me).kind).toBe('ok');
    expect(negotiate({ hello: 'captive portal' }, me).kind).toBe('not_a_vault');
    expect(negotiate(null, me).kind).toBe('not_a_vault');
    expect(negotiate(caps({ api_version: 2 as never }), me).kind).toBe('api_version');
    expect(negotiate(caps({ server_version: '0.3.0' }), me)).toEqual({
      kind: 'server_too_old',
      server: '0.3.0',
      needed: '0.4.2',
    });
    expect(negotiate(caps({ min_client_version: '0.2.0' }), me).kind).toBe('client_too_old');
    expect(negotiate(caps({ setup_required: true }), me).kind).toBe('setup_required');
    // A version nobody can read is too old, not a crash.
    expect(negotiate(caps({ server_version: 'dev' }), me).kind).toBe('server_too_old');
  });
});

describe('confirming it is you, once', () => {
  it('two requests that need it share one prompt and both carry on', async () => {
    let asked = 0;
    let answer: (ok: boolean) => void = () => undefined;
    const coordinator = new StepUpCoordinator(
      () =>
        new Promise<boolean>((resolve) => {
          asked++;
          answer = resolve;
        }),
    );
    const a = coordinator.confirm({ action: 'open_private_document', message: 'm' });
    const b = coordinator.confirm({ action: 'export_everything', message: 'm' });
    expect(asked).toBe(1);
    answer(true);
    expect(await Promise.all([a, b])).toEqual([true, true]);
    // The next one asks afresh.
    void coordinator.confirm({ action: 'x', message: 'm' });
    expect(asked).toBe(2);
  });
});

describe('multipart bodies from bytes', () => {
  it('writes fields and files the way a form does', () => {
    const { bytes, contentType } = multipartBody(
      [
        { name: 'metadata', value: '{"title":"Passport"}' },
        {
          name: 'file',
          filename: 'scan "1".pdf',
          contentType: 'application/pdf',
          bytes: new Uint8Array([37, 80, 68, 70]),
        },
      ],
      'B',
    );
    expect(contentType).toBe('multipart/form-data; boundary=B');
    const text = String.fromCharCode(...bytes);
    expect(text).toContain(
      '--B\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n{"title":"Passport"}\r\n',
    );
    expect(text).toContain(
      'filename="scan %221%22.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF\r\n',
    );
    expect(text.endsWith('--B--\r\n')).toBe(true);
  });
});
