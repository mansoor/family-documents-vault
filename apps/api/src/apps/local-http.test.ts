import { describe, expect, it } from 'vitest';
import { plainHttpAllowed } from './service.js';

describe('plain http for connected apps (FDV_APPS_LOCAL_HTTP)', () => {
  it('a localhost vault: from this machine always; from behind its web container only with the switch', () => {
    for (const base of ['http://localhost:8091', 'http://127.0.0.1:8080', 'http://[::1]:8080']) {
      expect(plainHttpAllowed(base, true, false), base).toBe(true);
      expect(plainHttpAllowed(base, false, false), base).toBe(false);
      expect(plainHttpAllowed(base, false, true), base).toBe(true);
    }
  });

  it('any other vault: never, switch or not', () => {
    for (const base of [
      'https://vault.example.com',
      'http://vault.example.com',
      'http://192.168.1.10:8080',
      'https://localhost:8443',
      'not a url',
    ]) {
      expect(plainHttpAllowed(base, true, true), base).toBe(false);
      expect(plainHttpAllowed(base, false, true), base).toBe(false);
    }
  });
});
