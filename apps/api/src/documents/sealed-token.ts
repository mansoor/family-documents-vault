import { deriveKey } from '@fdv/crypto';
import { jwtVerify, SignJWT } from 'jose';
import { ApiError } from '../errors.js';

/**
 * The handle on the second pass of search (FND-08).
 *
 * `GET /search` answers immediately from the index and says how many of
 * the caller's own sealed documents it could not look inside, handing back
 * a token. The token is a short-lived JWT that carries the query itself,
 * so the second pass can only ever run the search the first pass
 * described, and only for the session that asked: a token that leaks is
 * useless to another account, useless after sign-out, and useless in a
 * minute or two regardless.
 */

export const SEALED_TTL_SECONDS = 120;

export interface SealedClaims {
  /** Session id: the second pass is bound to the session that started it. */
  sid: string;
  hid: string;
  mid: string;
  q: string;
  member_id?: string | undefined;
  category?: string | undefined;
  /** The issuer chip the first pass was filtered by (0.4.10). */
  issued_by?: string | undefined;
  limit: number;
}

export function deriveSealedKey(masterSecret: string): Uint8Array {
  return new Uint8Array(deriveKey(masterSecret, 'sealed-search-token'));
}

export async function signSealedToken(key: Uint8Array, claims: SealedClaims): Promise<string> {
  return new SignJWT({
    sid: claims.sid,
    hid: claims.hid,
    mid: claims.mid,
    q: claims.q,
    member_id: claims.member_id ?? null,
    category: claims.category ?? null,
    issued_by: claims.issued_by ?? null,
    limit: claims.limit,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer('fdv')
    .setAudience('fdv-sealed-search')
    .setExpirationTime(`${SEALED_TTL_SECONDS}s`)
    .sign(key);
}

export async function verifySealedToken(key: Uint8Array, token: string): Promise<SealedClaims> {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = (await jwtVerify(token, key, {
      issuer: 'fdv',
      audience: 'fdv-sealed-search',
    })) as { payload: Record<string, unknown> });
  } catch {
    // Expiry is the common case by far, and it is not the caller's fault:
    // searching again costs nothing and is what the message asks for.
    throw new ApiError(400, 'search_expired', 'That search has expired. Run it again.');
  }
  const { sid, hid, mid, q, limit } = payload;
  if (
    typeof sid !== 'string' ||
    typeof hid !== 'string' ||
    typeof mid !== 'string' ||
    typeof q !== 'string' ||
    typeof limit !== 'number'
  ) {
    throw new ApiError(400, 'search_expired', 'That search has expired. Run it again.');
  }
  return {
    sid,
    hid,
    mid,
    q,
    limit,
    member_id: typeof payload.member_id === 'string' ? payload.member_id : undefined,
    category: typeof payload.category === 'string' ? payload.category : undefined,
    issued_by: typeof payload.issued_by === 'string' ? payload.issued_by : undefined,
  };
}
