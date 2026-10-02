import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  cookieForNewBinding,
  deviceCookieKey,
  deviceCookieKid,
  deviceCookieName,
  mintDeviceCookie,
  presentedDeviceCookies,
  verifiedDeviceCookie,
} from './device-cookie.js';

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

/**
 * Names that carry the key (the master-key rotation review, ROT-C-03): a
 * browser keeps a cookie of each key beside the next, every one is read
 * for the bindings made before, and only the current key's makes a new one.
 */
describe('device cookies named by the key that made them', () => {
  const key = deviceCookieKey(MASTER, 'share-device');
  const before = deviceCookieKey(`${MASTER}-before-rotation`, 'share-device');

  it('the name carries a short id of the key, and differs with the key and the purpose', () => {
    expect(deviceCookieKid(key)).toMatch(/^[0-9a-f]{8}$/);
    expect(deviceCookieName('fdv_share_device', key)).toBe(
      `fdv_share_device_${deviceCookieKid(key)}`,
    );
    expect(deviceCookieKid(before)).not.toBe(deviceCookieKid(key));
    expect(deviceCookieKid(deviceCookieKey(MASTER, 'drop-device'))).not.toBe(deviceCookieKid(key));
  });

  it('every cookie of the prefix is read, of whichever key, and nothing else', () => {
    const now = deviceCookieName('fdv_share_device', key);
    const old = deviceCookieName('fdv_share_device', before);
    expect(
      presentedDeviceCookies(
        {
          [now]: 'a',
          [old]: 'b',
          fdv_share_device: 'c',
          fdv_share: 'the session, not a device',
          fdv_drop_device_12345678: 'another purpose',
          fdv_share_device_xyz: 'not a key id',
          fdv_share_device_1234567a: 'x'.repeat(200),
        },
        'fdv_share_device',
      ),
    ).toEqual([
      { name: now, value: 'a' },
      { name: old, value: 'b' },
      { name: 'fdv_share_device', value: 'c' },
    ]);
  });

  it('a new binding takes the current key’s own cookie, or a new one — never another’s', () => {
    const now = deviceCookieName('fdv_share_device', key);
    const old = deviceCookieName('fdv_share_device', before);
    const mine = mintDeviceCookie(key);
    // Its own, under its own name: kept.
    expect(cookieForNewBinding(key, 'fdv_share_device', [{ name: now, value: mine }])).toEqual({
      name: now,
      value: mine,
    });
    // Anything else: a new one, under the current name — an earlier key's
    // cookie, a valid one under another name, one the vault did not make.
    for (const presented of [
      [{ name: old, value: mintDeviceCookie(before) }],
      [{ name: 'fdv_share_device', value: mine }],
      [{ name: now, value: 'planted-by-somebody-else' }],
      [],
    ]) {
      const made = cookieForNewBinding(key, 'fdv_share_device', presented);
      expect(made.name).toBe(now);
      expect(made.value).not.toBe(mine);
      expect(verifiedDeviceCookie(key, made.value)).toBe(made.value);
    }
  });
});
