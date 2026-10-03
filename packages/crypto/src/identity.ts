import { openBytes, sealBytes } from './private-values.js';
import { newKey, unwrapKey, wrapKey } from './wrap.js';

/**
 * A person's identity details (5.26), sealed: each part — shared, or Only me
 * — one JSON document under a fresh data key at every write, AES-256-GCM,
 * bound to its household, its person and its part:
 *
 *   sealed       iv (12) || ciphertext || tag (16), additional data
 *                "identity:<household>:<person>:<part>"
 *   dek_wrapped  the data key under the scope key of its part — the
 *                household's identity key for the shared part, the person's
 *                own member key for Only me — bound to the same three
 *
 * A part copied onto another person, into the other part or into another
 * household does not open, whatever key it is tried with.
 *
 * The honest limit: no owner can open an Only me part through the vault,
 * but every key here is wrapped, in the end, by the master key, which
 * whoever runs the server holds.
 */

export type IdentityPartName = 'shared' | 'only_me';

export interface IdentityRef {
  householdId: string;
  memberId: string;
  part: IdentityPartName;
}

/** What a part's sealed value is bound to. */
export const identityBinding = (r: IdentityRef) =>
  `identity:${r.householdId}:${r.memberId}:${r.part}`;

/** What a part's data key is wrapped for. */
export const identityKeyBinding = (r: IdentityRef) =>
  `identity-key:${r.householdId}:${r.memberId}:${r.part}`;

export interface SealedIdentity {
  sealed: Buffer;
  dek_wrapped: Buffer;
}

/** Seals a part's fields under a fresh data key, wrapped under `scopeKey`. */
export function sealIdentity(scopeKey: Buffer, ref: IdentityRef, fields: unknown): SealedIdentity {
  const dek = newKey();
  return {
    sealed: sealBytes(dek, Buffer.from(JSON.stringify(fields), 'utf8'), identityBinding(ref)),
    dek_wrapped: wrapKey(dek, scopeKey, identityKeyBinding(ref)),
  };
}

/**
 * Opens what `sealIdentity` sealed, for the same household, person and part
 * under the same scope key. Anything else throws: a part that does not open
 * is an error, never "no details", or whoever asked would write over what
 * they could not see.
 */
export function openIdentity(
  scopeKey: Buffer,
  ref: IdentityRef,
  row: SealedIdentity,
): Record<string, unknown> {
  const dek = unwrapKey(row.dek_wrapped, scopeKey, identityKeyBinding(ref));
  const value: unknown = JSON.parse(
    openBytes(dek, row.sealed, identityBinding(ref)).toString('utf8'),
  );
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('identity details opened to something that is not a record');
  }
  return value as Record<string, unknown>;
}
