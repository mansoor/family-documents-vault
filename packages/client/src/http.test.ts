import { describe, expect, it } from 'vitest';
import { createApi } from './api.js';
import { createHttp, type RequestInitLike } from './http.js';

/** A fetch that answers 200 {} and remembers what it was asked. */
function recorder() {
  const seen: { url: string; init: RequestInitLike }[] = [];
  const fetch = async (url: string, init: RequestInitLike) => {
    seen.push({ url, init });
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
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
