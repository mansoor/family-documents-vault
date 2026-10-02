import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { deriveKey } from '@fdv/crypto';

/**
 * A browser's cookie for a public page that is bound to one browser (5.20's
 * "this device only" link, `fdv_share_device_*`; 5.21's upload request,
 * `fdv_drop_device_*`).
 *
 * Only the vault makes them: 32 random bytes and their HMAC under a key
 * derived from the master key for that purpose alone, base64url. A cookie a
 * browser presents is taken for a NEW binding only when its MAC verifies
 * under the key in use now; anything else — one planted from a sibling site
 * or an injected http answer before the first open, to be bound to and then
 * reused elsewhere (fixation) — is replaced by a new one, and a new binding
 * only ever names a cookie the vault made (the 5.20 review, F520-04).
 *
 * Each cookie's name carries a short id of the key it was made under
 * (`<prefix>_<kid>`, the master-key rotation review, ROT-C-03). After a
 * rotation the browser keeps the cookie it was given before beside the one
 * a new binding gives it now, so every binding made before still finds its
 * own: a binding is matched against every cookie of the prefix the browser
 * brings (its hash is what is kept), whatever key made it. The bare prefix
 * is read too, for cookies made before names carried an id.
 */

const RANDOM_BYTES = 32;
const MAC_BYTES = 32;
/** How many of a prefix's cookies are looked at: a browser brings one a key, and keys are few. */
const MAX_PRESENTED = 8;

/** A cookie of the kind, as the browser brought it or as it is to be set. */
export interface DeviceCookie {
  name: string;
  value: string;
}

/** The key a purpose's cookies are made and checked with: `share-device`, `drop-device`. */
export function deviceCookieKey(masterSecret: string, purpose: string): Buffer {
  return deriveKey(masterSecret, purpose);
}

const macOf = (key: Buffer, random: Buffer) => createHmac('sha256', key).update(random).digest();

/** The short id of a key, which its cookies' name carries: 8 hex of HMAC(key, 'kid'). */
export function deviceCookieKid(key: Buffer): string {
  return createHmac('sha256', key).update('kid').digest('hex').slice(0, 8);
}

/** The name a prefix's cookies are given under a key: `fdv_share_device_1a2b3c4d`. */
export function deviceCookieName(prefix: string, key: Buffer): string {
  return `${prefix}_${deviceCookieKid(key)}`;
}

/** A new cookie: random bytes and their MAC. */
export function mintDeviceCookie(key: Buffer): string {
  const random = randomBytes(RANDOM_BYTES);
  return Buffer.concat([random, macOf(key, random)]).toString('base64url');
}

/** The presented cookie, when the vault made it under this key; otherwise null. */
export function verifiedDeviceCookie(key: Buffer, presented: string | undefined): string | null {
  if (!presented || presented.length > 128 || !/^[A-Za-z0-9_-]+$/.test(presented)) return null;
  const raw = Buffer.from(presented, 'base64url');
  // One spelling of the bytes only: the one the vault wrote.
  if (raw.length !== RANDOM_BYTES + MAC_BYTES || raw.toString('base64url') !== presented) {
    return null;
  }
  const mac = macOf(key, raw.subarray(0, RANDOM_BYTES));
  return timingSafeEqual(mac, raw.subarray(RANDOM_BYTES)) ? presented : null;
}

/**
 * Every cookie of a prefix the browser brought — `<prefix>_<kid>` of any
 * key, or the bare prefix — each a candidate for a binding made before,
 * under whichever key. Only a few, and none longer than a cookie of ours.
 */
export function presentedDeviceCookies(
  cookies: Record<string, string | undefined>,
  prefix: string,
): DeviceCookie[] {
  const named = new RegExp(`^${prefix}(?:_[0-9a-f]{8})?$`);
  return Object.entries(cookies)
    .filter(
      (entry): entry is [string, string] =>
        named.test(entry[0]) &&
        typeof entry[1] === 'string' &&
        entry[1].length > 0 &&
        entry[1].length <= 128,
    )
    .slice(0, MAX_PRESENTED)
    .map(([name, value]) => ({ name, value }));
}

/**
 * The cookie a new binding is made with: the one the browser brought under
 * the key in use now, when the vault made it — or a new one. Never one of
 * another name, or one the vault did not make.
 */
export function cookieForNewBinding(
  key: Buffer,
  prefix: string,
  presented: readonly DeviceCookie[],
): DeviceCookie {
  const name = deviceCookieName(prefix, key);
  const mine = presented.find((c) => c.name === name);
  return { name, value: verifiedDeviceCookie(key, mine?.value) ?? mintDeviceCookie(key) };
}
