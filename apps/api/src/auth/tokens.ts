import { createHash, hkdfSync, randomBytes } from 'node:crypto';
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

export function deriveSigningKey(masterKey: string): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', masterKey, 'fdv', 'access-token-signing', 32));
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
 * The secret half is what is hashed and stored.
 */
export function newRefreshToken(householdId: string): string {
  return `${householdId}.${randomBytes(32).toString('base64url')}`;
}

export function parseRefreshToken(token: string): { householdId: string } | null {
  const dot = token.indexOf('.');
  if (dot !== 36) return null;
  const householdId = token.slice(0, dot);
  if (!/^[0-9a-f-]{36}$/.test(householdId)) return null;
  return { householdId };
}

export function hashRefreshToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}
