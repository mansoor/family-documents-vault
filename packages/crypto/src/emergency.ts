import { openBytes, sealBytes } from './private-values.js';
import { newKey, unwrapKey, wrapKey } from './wrap.js';

/**
 * A person's emergency information (0.9.0, H4), sealed as identity details
 * are (identity.ts): one JSON document under a fresh data key at every
 * write, AES-256-GCM, bound to its household and its person:
 *
 *   sealed       iv (12) || ciphertext || tag (16), additional data
 *                "emergency:<household>:<person>"
 *   dek_wrapped  the data key under the household's identity key, bound to
 *                the same two
 *
 * A record copied onto another person, or into another household, does not
 * open, whatever key it is tried with. As with identity details, every key
 * here is wrapped in the end by the master key, which whoever runs the
 * server holds.
 */

export interface EmergencyRef {
  householdId: string;
  memberId: string;
}

/** What a record's sealed value is bound to. */
export const emergencyBinding = (r: EmergencyRef) => `emergency:${r.householdId}:${r.memberId}`;

/** What a record's data key is wrapped for. */
export const emergencyKeyBinding = (r: EmergencyRef) =>
  `emergency-key:${r.householdId}:${r.memberId}`;

export interface SealedEmergency {
  sealed: Buffer;
  dek_wrapped: Buffer;
}

/** Seals a person's emergency fields under a fresh data key, wrapped under `scopeKey`. */
export function sealEmergency(
  scopeKey: Buffer,
  ref: EmergencyRef,
  fields: unknown,
): SealedEmergency {
  const dek = newKey();
  return {
    sealed: sealBytes(dek, Buffer.from(JSON.stringify(fields), 'utf8'), emergencyBinding(ref)),
    dek_wrapped: wrapKey(dek, scopeKey, emergencyKeyBinding(ref)),
  };
}

/**
 * Opens what `sealEmergency` sealed, for the same household and person
 * under the same scope key. Anything else throws: a record that does not
 * open is an error, never "nothing entered", or whoever asked would write
 * over what they could not see.
 */
export function openEmergency(
  scopeKey: Buffer,
  ref: EmergencyRef,
  row: SealedEmergency,
): Record<string, unknown> {
  const dek = unwrapKey(row.dek_wrapped, scopeKey, emergencyKeyBinding(ref));
  const value: unknown = JSON.parse(
    openBytes(dek, row.sealed, emergencyBinding(ref)).toString('utf8'),
  );
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('emergency information opened to something that is not a record');
  }
  return value as Record<string, unknown>;
}
