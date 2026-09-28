import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deviceCookieKey, mintDeviceCookie, verifiedDeviceCookie } from './device-cookie.js';

const MASTER = 'device-cookie-test-master-key-with-32-bytes-or-more';

/**
 * A browser's cookie for a page bound to one browser (the 5.20 review,
 * F520-04): only the vault makes one, and only one it made is taken back.
 */
describe('device cookies, made and checked by the vault alone', () => {
  const key = deviceCookieKey(MASTER, 'share-device');

  it('a cookie the vault made is taken back as it is', () => {
    const made = mintDeviceCookie(key);
    expect(made).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(verifiedDeviceCookie(key, made)).toBe(made);
    // And every one is new.
    expect(mintDeviceCookie(key)).not.toBe(made);
  });

  it('anything else is not: made up, altered, another purpose’s, another vault’s', () => {
    const made = mintDeviceCookie(key);
    const raw = Buffer.from(made, 'base64url');
    const flipped = Buffer.from(raw);
    flipped[3] = (flipped[3] ?? 0) ^ 1;
    for (const presented of [
      undefined,
      '',
      'planted-by-somebody-else',
      randomBytes(64).toString('base64url'),
      flipped.toString('base64url'),
      `${made}A`,
      made.slice(0, -1),
      mintDeviceCookie(deviceCookieKey(MASTER, 'drop-device')),
      mintDeviceCookie(deviceCookieKey(`${MASTER}-another-vault`, 'share-device')),
      'x'.repeat(200),
    ]) {
      expect(verifiedDeviceCookie(key, presented), String(presented)).toBeNull();
    }
  });
});
