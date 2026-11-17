import { describe, expect, it } from 'vitest';
import { createApi } from './api.js';
import { NetworkError, networkDetail } from './errors.js';
import { createHttp, type RequestInitLike } from './http.js';

/** A fetch that answers 200 {} and remembers what it was asked. */
function recorder(answerHeaders: Record<string, string> = {}) {
  const seen: { url: string; init: RequestInitLike }[] = [];
  const fetch = async (url: string, init: RequestInitLike) => {
    seen.push({ url, init });
    return {
      ok: true,
      status: 200,
      headers: { get: (name: string) => answerHeaders[name.toLowerCase()] ?? null },
      json: async () => ({}),
      text: async () => '',
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
  return { seen, fetch };
}

describe('nothing the vault says is cached (0.5.0)', () => {
  it('every request asks for no kept answer and keeps none, in words every platform obeys', async () => {
    const { seen, fetch } = recorder();
    const http = createHttp({ baseUrl: 'http://10.0.0.2:8080', fetch });
    await createApi(http).capabilities();
    await http.request('/api/v1/documents', { token: 't' });
    await http.request('/api/v1/documents', { method: 'POST', body: { title: 'x' }, token: 't' });
    await http.raw('/api/v1/versions/v/thumbnail', { token: 't' });
    expect(seen.map((s) => s.url)).toEqual([
      'http://10.0.0.2:8080/api/v1/capabilities',
      'http://10.0.0.2:8080/api/v1/documents',
      'http://10.0.0.2:8080/api/v1/documents',
      'http://10.0.0.2:8080/api/v1/versions/v/thumbnail',
    ]);
    for (const { init } of seen) {
      // The header for a phone's HTTP stack, which ignores `cache`; `cache` for browsers.
      expect(init.headers['cache-control']).toBe('no-cache, no-store');
      expect(init.cache).toBe('no-store');
    }
  });

  it('no caller can ask for a kept answer', async () => {
    const { seen, fetch } = recorder();
    const http = createHttp({
      baseUrl: '',
      fetch,
      headers: () => ({ 'cache-control': 'max-age=300' }),
    });
    await http.request('/api/v1/me', { headers: { 'cache-control': 'only-if-cached' } });
    expect(seen[0]?.init.headers['cache-control']).toBe('no-cache, no-store');
  });
});

describe("the vault's version, from every answer (0.5.0)", () => {
  it('is handed to the app with each answer that says it, and never gets in the way', async () => {
    const heard: string[] = [];
    const { fetch } = recorder({ 'x-fdv-server-version': '0.5.0' });
    const http = createHttp({ baseUrl: '', fetch, onServerVersion: (v) => heard.push(v) });
    await http.request('/api/v1/me');
    await http.raw('/api/v1/versions/v/thumbnail');
    expect(heard).toEqual(['0.5.0', '0.5.0']);

    const throwing = createHttp({
      baseUrl: '',
      fetch,
      onServerVersion: () => {
        throw new Error('listener broke');
      },
    });
    await expect(throwing.request('/api/v1/me')).resolves.toEqual({});
  });

  it('an older vault says nothing, and nothing is heard', async () => {
    const heard: string[] = [];
    const http = createHttp({
      baseUrl: '',
      fetch: recorder().fetch,
      onServerVersion: (v) => heard.push(v),
    });
    await http.request('/api/v1/me');
    expect(heard).toEqual([]);
  });
});

describe('a request with no answer keeps what went wrong (CL2)', () => {
  it('is offline, as ever, with what fetch threw as its cause and its code as the detail', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8080'), {
      code: 'ECONNREFUSED',
    });
    const thrown = new TypeError('fetch failed', { cause: refused });
    const http = createHttp({
      baseUrl: 'http://127.0.0.1:8080',
      fetch: async () => {
        throw thrown;
      },
    });
    const err = await http.request('/api/v1/me').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    const net = err as NetworkError;
    expect(net.kind).toBe('offline');
    expect(net.message).toBe("We can't reach the vault right now.");
    expect(net.cause).toBe(thrown);
    expect(net.detail).toBe('ECONNREFUSED');
    await expect(http.raw('/api/v1/versions/v/thumbnail')).rejects.toMatchObject({
      kind: 'offline',
      cause: thrown,
    });
  });

  it('a timeout is still a timeout, with the abort as its cause', async () => {
    const http = createHttp({
      baseUrl: '',
      timeoutMs: 5,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          const wait = (): void => {
            if (init.signal?.aborted) reject(new Error('This operation was aborted'));
            else setTimeout(wait, 1);
          };
          wait();
        }),
    });
    const err = (await http.request('/api/v1/me').catch((e: unknown) => e)) as NetworkError;
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.kind).toBe('timeout');
    expect((err.cause as Error).message).toBe('This operation was aborted');
    expect(err.detail).toBe('This operation was aborted');
  });

  it('the detail is a few words on one line, or nothing', () => {
    expect(networkDetail(new Error('  Network\n request   failed '))).toBe(
      'Network request failed',
    );
    expect(networkDetail(new Error('x'.repeat(300)))?.length).toBe(120);
    expect(networkDetail('offline')).toBe('offline');
    // An address in the message is never repeated; a code still is.
    expect(networkDetail(new TypeError('Failed to fetch https://vault.example/x?token=abc'))).toBe(
      'the request failed',
    );
    expect(
      networkDetail(
        Object.assign(new Error('getaddrinfo ENOTFOUND https://vault.example'), {
          code: 'ENOTFOUND',
        }),
      ),
    ).toBe('ENOTFOUND');
    expect(networkDetail(null)).toBeUndefined();
    expect(networkDetail({})).toBeUndefined();
    // Made without a cause, as the web app's own uploads make one: none.
    const bare = new NetworkError('offline');
    expect('cause' in bare).toBe(false);
    expect(bare.detail).toBeUndefined();
  });
});
