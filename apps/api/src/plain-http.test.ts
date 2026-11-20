import { describe, expect, it } from 'vitest';
import { plainHttpWarning } from './plain-http.js';

/**
 * The API says, once as it starts, when FDV_BASE_URL is plain http to
 * another machine: passwords and tokens would cross the network in clear.
 */
describe('the warning about plain http', () => {
  it('is said for http to another machine', () => {
    for (const url of [
      'http://192.168.1.20:8080',
      'http://vault.local',
      'http://vault.example.com/',
      'http://[fd00::20]:8080',
      'http://10.0.0.5',
      // Just outside Tailscale's range.
      'http://100.63.255.1',
      'http://100.128.0.1',
    ]) {
      const w = plainHttpWarning(url);
      expect(w, url).toMatch(/plain http to another machine/);
      expect(w).toMatch(/Tailscale/);
      expect(w).toMatch(/Caddy/);
    }
  });

  it('is not said for https, or for this machine alone', () => {
    for (const url of [
      'https://vault.example.com',
      'https://192.168.1.20',
      'http://localhost:8080',
      'http://LOCALHOST',
      'http://vault.localhost:8080',
      'http://127.0.0.1:8080',
      'http://127.1.2.3',
      'http://[::1]:8080',
      // Over Tailscale, which encrypts what crosses the network itself.
      'http://100.101.102.103:8080',
      'http://100.64.0.1',
      'http://vault.tail1234.ts.net:8080',
      'not a url',
    ]) {
      expect(plainHttpWarning(url), url).toBeNull();
    }
  });
});
