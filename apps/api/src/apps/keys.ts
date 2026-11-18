import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIPv6 } from 'node:net';
import {
  APP_CLIENT_ID_PATTERN,
  APP_CLIENT_ID_PREFIX,
  APP_SECRET_PATTERN,
  APP_SECRET_PREFIX,
} from '@fdv/shared';

/**
 * A connected app's API key (0.9.0-dev.63, APP6): what an owner generates
 * in Settings, and how a request's `Authorization: Basic` is read.
 *
 * - The client ID is `fdvc_` and 16 random bytes, base64url: it names the
 *   key, and is no secret.
 * - The secret is `fdvs_` and 32 random bytes, base64url, shown once. The
 *   vault keeps its SHA-256 alone: 256 random bits need no slow hash, and
 *   the hash lets nobody act as the app.
 * - A request's secret is compared with the kept hash in constant time,
 *   and against a hash of nothing when the client ID is not known, so an
 *   unknown ID and a wrong secret take the same work and say the same.
 *
 * Pure. Which app and key a client ID names, and whether it is live, are
 * the service's.
 */

/** A new client ID. */
export function newClientId(): string {
  return `${APP_CLIENT_ID_PREFIX}${randomBytes(16).toString('base64url')}`;
}

/** A new secret: shown once, kept nowhere. */
export function newSecret(): string {
  return `${APP_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** What is kept of a secret. */
export function secretHash(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

/** Compared with when there is no key to compare with: the same work, never a match. */
const NOTHING = secretHash('');

/**
 * Whether a secret is the one whose hash was kept, in constant time; with
 * no hash (an unknown client ID), the same work and false.
 */
export function secretMatches(secret: string, kept: Buffer | null | undefined): boolean {
  const given = secretHash(secret);
  const against = kept && kept.length === given.length ? kept : NOTHING;
  const same = timingSafeEqual(given, against);
  return same && against !== NOTHING;
}

/** What a request's Authorization says, read. */
export type BasicCredentials =
  | { kind: 'basic'; clientId: string; secret: string }
  /** An app's key (its user part starts `fdvc_`), but not as the vault writes them. */
  | { kind: 'malformed' }
  /**
   * No Authorization, another scheme, or Basic that is no app's key — a
   * self-hoster's proxy (Caddy's basicauth, nginx's auth_basic) in front of
   * the vault sends its own, which goes on untouched.
   */
  | { kind: 'none' };

/** The user part of a Basic header's value, decoded, and the rest; null for anything else. */
function basicUser(v: string): { user: string; rest: string | null } | null {
  const m = /^basic +([A-Za-z0-9+/]+={0,2})$/i.exec(v.trim());
  if (!m) return null;
  const decoded = Buffer.from(m[1] as string, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon === -1
    ? { user: decoded, rest: null }
    : { user: decoded.slice(0, colon), rest: decoded.slice(colon + 1) };
}

/**
 * Whether a request carries a connected app's API key: Basic whose user
 * part is a client ID (`fdvc_…`). Any other Basic value is somebody else's
 * — a proxy's in front of the vault — and is not taken for one.
 */
export function presentsBasic(headers: Record<string, string | string[] | undefined>): boolean {
  const v = headers.authorization;
  if (Array.isArray(v)) return v.some((x) => presentsBasic({ authorization: x }));
  if (typeof v !== 'string') return false;
  return basicUser(v)?.user.startsWith(APP_CLIENT_ID_PREFIX) ?? false;
}

/**
 * `Authorization: Basic base64(client_id:secret)`, read strictly: the
 * scheme (any case), a space, standard base64 of `client_id:secret` whose
 * two halves are as the vault writes them. A header sent twice is no key;
 * Basic that is not an app's (its user part not `fdvc_…`) is no key either.
 */
export function readBasic(
  headers: Record<string, string | string[] | undefined>,
): BasicCredentials {
  const v = headers.authorization;
  if (v === undefined) return { kind: 'none' };
  if (Array.isArray(v)) return presentsBasic(headers) ? { kind: 'malformed' } : { kind: 'none' };
  const b = basicUser(v);
  if (!b || !b.user.startsWith(APP_CLIENT_ID_PREFIX)) return { kind: 'none' };
  if (b.rest === null) return { kind: 'malformed' };
  if (!APP_CLIENT_ID_PATTERN.test(b.user) || !APP_SECRET_PATTERN.test(b.rest)) {
    return { kind: 'malformed' };
  }
  return { kind: 'basic', clientId: b.user, secret: b.rest };
}

/**
 * Where an address's failed authentications are counted: an IPv4 address
 * alone; an IPv6 address by its /64, which one client usually holds whole;
 * an IPv4 address written as IPv6 as itself.
 */
export function addressBucket(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (mapped) return mapped;
  if (!isIPv6(ip)) return ip;
  const lower = ip.toLowerCase();
  const [head = '', tail = ''] = lower.split('::');
  const left = head ? head.split(':') : [];
  const right = lower.includes('::') && tail ? tail.split(':') : [];
  const groups = lower.includes('::')
    ? [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
    : left;
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}
