import type { Db } from '@fdv/db';
import type pg from 'pg';
import type { KeyProvider } from './master.js';
import { credentialKey, newKdfParams, newKey, unwrapKey, wrapKey, type KdfParams } from './wrap.js';

/**
 * Scope keys: minting, unwrapping, rewrapping. Every function that takes a
 * `Db` expects it to be inside a transaction scoped to the household, so
 * row-level security is in force.
 *
 * Bindings tie each wrapped blob to its row: a household key's blob cannot
 * be pasted into another household's row and still unwrap.
 */

export type ScopeKind = 'household' | 'adults' | 'member';

export interface ScopeRef {
  householdId: string;
  kind: ScopeKind;
  memberId?: string | null;
}

export const binding = (s: ScopeRef) =>
  s.kind === 'member' ? `${s.householdId}:member:${s.memberId}` : `${s.householdId}:${s.kind}`;

const credBinding = (s: ScopeRef) => `${binding(s)}:cred`;

export class ScopeKeys {
  constructor(private readonly provider: KeyProvider) {}

  /** Creates the household and adults keys. Call in the household's creating transaction. */
  async mintHouseholdKeys(trx: Db, householdId: string): Promise<void> {
    const kek = await this.provider.keyEncryptionKey();
    for (const kind of ['household', 'adults'] as const) {
      const ref: ScopeRef = { householdId, kind };
      await trx
        .insertInto('scope_key')
        .values({
          household_id: householdId,
          kind,
          key_wrapped: wrapKey(newKey(), kek, binding(ref)),
        })
        .execute();
    }
  }

  /**
   * Creates a member's private-scope key, wrapped twice: by the master key
   * (so the server can serve their own documents) and by their credential
   * (so recovery and escrow do not depend on the server). A member with no
   * sign-in (a child) gets only the master wrap; the credential wrap is
   * added when an account is attached to them.
   */
  async mintMemberKey(
    trx: Db,
    householdId: string,
    memberId: string,
    password: string | null,
  ): Promise<void> {
    const kek = await this.provider.keyEncryptionKey();
    const ref: ScopeRef = { householdId, kind: 'member', memberId };
    const key = newKey();
    let credWrap: Buffer | null = null;
    let params: KdfParams | null = null;
    if (password !== null) {
      params = newKdfParams();
      credWrap = wrapKey(key, await credentialKey(password, params), credBinding(ref));
    }
    await trx
      .insertInto('scope_key')
      .values({
        household_id: householdId,
        kind: 'member',
        member_id: memberId,
        key_wrapped: wrapKey(key, kek, binding(ref)),
        key_wrapped_cred: credWrap,
        kdf_params: params ? JSON.stringify(params) : null,
      })
      .execute();
  }

  /** The plaintext scope key, via the master key. */
  async unwrap(trx: Db, ref: ScopeRef): Promise<{ id: string; key: Buffer }> {
    const kek = await this.provider.keyEncryptionKey();
    let q = trx
      .selectFrom('scope_key')
      .select(['id', 'key_wrapped'])
      .where('household_id', '=', ref.householdId)
      .where('kind', '=', ref.kind);
    q = ref.kind === 'member' ? q.where('member_id', '=', ref.memberId ?? '') : q;
    const row = await q.executeTakeFirst();
    if (!row) throw new Error(`no ${ref.kind} scope key for household ${ref.householdId}`);
    return { id: row.id, key: unwrapKey(row.key_wrapped, kek, binding(ref)) };
  }

  /** The plaintext scope key by row id — what a document version points at. */
  async unwrapById(trx: Db, scopeKeyId: string): Promise<Buffer> {
    const kek = await this.provider.keyEncryptionKey();
    const row = await trx
      .selectFrom('scope_key')
      .select(['household_id', 'kind', 'member_id', 'key_wrapped'])
      .where('id', '=', scopeKeyId)
      .executeTakeFirstOrThrow();
    const ref: ScopeRef = {
      householdId: row.household_id,
      kind: row.kind,
      memberId: row.member_id,
    };
    return unwrapKey(row.key_wrapped, kek, binding(ref));
  }

  /** A member's scope key via their password — no master key involved. */
  async unwrapWithCredential(trx: Db, ref: ScopeRef, password: string): Promise<Buffer> {
    const row = await trx
      .selectFrom('scope_key')
      .select(['key_wrapped_cred', 'kdf_params'])
      .where('household_id', '=', ref.householdId)
      .where('kind', '=', 'member')
      .where('member_id', '=', ref.memberId ?? '')
      .executeTakeFirstOrThrow();
    if (!row.key_wrapped_cred || !row.kdf_params)
      throw new Error('member key has no credential wrap');
    const params = row.kdf_params as KdfParams;
    return unwrapKey(row.key_wrapped_cred, await credentialKey(password, params), credBinding(ref));
  }

  /** On password change: rewrap the member key under the new credential. */
  async rewrapCredential(trx: Db, ref: ScopeRef, oldPassword: string, newPassword: string) {
    const key = await this.unwrapWithCredential(trx, ref, oldPassword);
    const params = newKdfParams();
    await trx
      .updateTable('scope_key')
      .set({
        key_wrapped_cred: wrapKey(key, await credentialKey(newPassword, params), credBinding(ref)),
        kdf_params: JSON.stringify(params),
      })
      .where('household_id', '=', ref.householdId)
      .where('kind', '=', 'member')
      .where('member_id', '=', ref.memberId ?? '')
      .execute();
  }
}

/**
 * Master-key rotation (SEC-02): every scope key is unwrapped with the old
 * KEK and rewrapped with the new one. File content is never read or
 * rewritten. Runs with the owning role because it crosses households; each
 * row is rewrapped in one statement, and the whole run is one transaction
 * so a half-rotated database cannot exist.
 */
export async function rotateMasterKey(
  admin: pg.Pool,
  oldProvider: KeyProvider,
  newProvider: KeyProvider,
): Promise<{ rewrapped: number }> {
  const [oldKek, newKek] = await Promise.all([
    oldProvider.keyEncryptionKey(),
    newProvider.keyEncryptionKey(),
  ]);
  const client = await admin.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query<{
      id: string;
      household_id: string;
      kind: ScopeKind;
      member_id: string | null;
      key_wrapped: Buffer;
    }>('select id, household_id, kind, member_id, key_wrapped from scope_key for update');
    for (const r of rows) {
      const ref: ScopeRef = { householdId: r.household_id, kind: r.kind, memberId: r.member_id };
      const key = unwrapKey(r.key_wrapped, oldKek, binding(ref));
      await client.query(
        'update scope_key set key_wrapped = $1, rotated_at = now() where id = $2',
        [wrapKey(key, newKek, binding(ref)), r.id],
      );
    }
    await client.query('commit');
    return { rewrapped: rows.length };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
