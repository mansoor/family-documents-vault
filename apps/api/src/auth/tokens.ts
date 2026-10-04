import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { deriveKey } from '@fdv/crypto';
import type { Role } from '@fdv/db';
import { jwtVerify, SignJWT } from 'jose';

/**
 * Sessions are a short-lived access JWT plus a rotating refresh token.
 *
 * The JWT signing key is derived from the master key with HKDF, so a
 * self-hoster has one secret to back up, not two. Rotating the master key
 * (SEC-02) therefore also signs everyone out, which is the right default.
 */

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface AccessClaims {
  sub: string; // account id
  sid: string; // session id
  hid: string; // household id
  mid: string; // member id
  role: Role;
}

export function deriveSigningKey(masterSecret: string): Uint8Array {
  return new Uint8Array(deriveKey(masterSecret, 'access-token-signing'));
}

export async function signAccessToken(key: Uint8Array, claims: AccessClaims): Promise<string> {
  return new SignJWT({ sid: claims.sid, hid: claims.hid, mid: claims.mid, role: claims.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setIssuer('fdv')
    .setAudience('fdv-api')
    .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
    .sign(key);
}

export async function verifyAccessToken(key: Uint8Array, token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, key, { issuer: 'fdv', audience: 'fdv-api' });
  const { sub, sid, hid, mid, role } = payload as Record<string, unknown>;
  if (
    typeof sub !== 'string' ||
    typeof sid !== 'string' ||
    typeof hid !== 'string' ||
    typeof mid !== 'string' ||
    typeof role !== 'string'
  ) {
    throw new Error('malformed access token');
  }
  return { sub, sid, hid, mid, role: role as Role };
}

/**
 * A refresh token carries the household id in the clear so the server can
 * enter the right tenant scope before looking the session up under RLS.
 * The whole token is what is hashed and stored.
 *
 * Token families (5.30): `household.session.secret`. Every token names the
 * session it belongs to, so a token that has been replaced is still known
 * for that session's however many refreshes later — presented again, it
 * ends the session as `reused`, whoever presents it second. Until then only
 * the token just replaced (and those a grace replay touched) were
 * remembered, and a thief who spent a stolen token and then its successor
 * before the owner did kept the session: the owner's token matched nothing.
 *
 * The secret is 16 random bytes and 16 of an HMAC, under a key derived from
 * the signing key, over the household, the session and those random bytes:
 * only the vault makes a token that names a session, so somebody who knows a
 * session's id — no secret — cannot end it by writing a token of their own. A token from before 5.30 (`household.secret`) names
 * no session; it still refreshes, and its answer is a token of a family.
 */
const FAMILY_NONCE_BYTES = 16;
const FAMILY_TAG_BYTES = 16;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;

/** The key a token's tag is made with: the signing key's, for this alone. */
export function refreshFamilyKey(signingKey: Uint8Array): Buffer {
  return createHmac('sha256', signingKey).update('fdv refresh-token family').digest();
}

function familyTag(key: Buffer, householdId: string, sessionId: string, nonce: Buffer): Buffer {
  return createHmac('sha256', key)
    .update(`${householdId}.${sessionId}.`)
    .update(nonce)
    .digest()
    .subarray(0, FAMILY_TAG_BYTES);
}

export function newRefreshToken(key: Buffer, householdId: string, sessionId: string): string {
  const nonce = randomBytes(FAMILY_NONCE_BYTES);
  const secret = Buffer.concat([nonce, familyTag(key, householdId, sessionId, nonce)]);
  return `${householdId}.${sessionId}.${secret.toString('base64url')}`;
}

export interface ParsedRefreshToken {
  householdId: string;
  /** The session a token of a family names, as written: not yet checked (`sessionOfToken`). */
  named: { sessionId: string; secret: string } | null;
}

export function parseRefreshToken(token: string): ParsedRefreshToken | null {
  const dot = token.indexOf('.');
  if (dot !== 36) return null;
  const householdId = token.slice(0, dot);
  if (!/^[0-9a-f-]{36}$/.test(householdId)) return null;
  // A token from before 5.30 is the household and a secret with no dot in
  // it: base64url has none.
  const rest = token.slice(dot + 1);
  const sessionId = rest.slice(0, 36);
  if (rest.charAt(36) !== '.' || !UUID.test(sessionId)) return { householdId, named: null };
  return { householdId, named: { sessionId, secret: rest.slice(37) } };
}

/**
 * The session a token names, if the vault made it: its tag checked. Null
 * for a token from before families, and for one whose tag is not the
 * vault's — written by hand, or cut short.
 */
export function sessionOfToken(key: Buffer, parsed: ParsedRefreshToken): string | null {
  const named = parsed.named;
  if (!named || !SECRET.test(named.secret)) return null;
  const secret = Buffer.from(named.secret, 'base64url');
  if (secret.length !== FAMILY_NONCE_BYTES + FAMILY_TAG_BYTES) return null;
  const nonce = secret.subarray(0, FAMILY_NONCE_BYTES);
  const want = familyTag(key, parsed.householdId, named.sessionId, nonce);
  return timingSafeEqual(want, secret.subarray(FAMILY_NONCE_BYTES)) ? named.sessionId : null;
}

export function hashRefreshToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}
