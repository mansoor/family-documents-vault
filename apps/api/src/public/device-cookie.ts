import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { deriveKey } from '@fdv/crypto';

/**
 * A browser's cookie for a public page that is bound to one browser (5.20's
 * "this device only" link, `fdv_share_device`; 5.21's upload request,
 * `fdv_drop_device`).
 *
 * Only the vault makes them: 32 random bytes and their HMAC under a key
 * derived from the master key for that purpose alone, base64url. A cookie a
 * browser presents is taken as one of these only when its MAC verifies;
 * anything else — one planted from a sibling site or an injected http
 * answer before the first open, to be bound to and then reused elsewhere
 * (fixation) — is replaced by a new one, and a binding only ever names a
 * cookie the vault made.
 */

const RANDOM_BYTES = 32;
const MAC_BYTES = 32;

/** The key a purpose's cookies are made and checked with: `share-device`, `drop-device`. */
export function deviceCookieKey(masterSecret: string, purpose: string): Buffer {
  return deriveKey(masterSecret, purpose);
}

const macOf = (key: Buffer, random: Buffer) => createHmac('sha256', key).update(random).digest();

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
