import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { deriveKey, KEK_PURPOSE } from './master.js';
import { binding, type ScopeKind } from './scope-keys.js';
import { unwrapKey, wrapKey } from './wrap.js';

/**
 * Moving the database onto another master key (SEC-02): a rotation, and a
 * restore of a backup made before one.
 *
 * What the master key protects in the database is of two kinds. Scope keys
 * are wrapped by the key-encryption key. And a few secrets the vault keeps
 * for the household are sealed under keys derived from the master secret
 * with `deriveKey`, one purpose each: MASTER_SEALED. Moving means rewrapping
 * the first and sealing the second again, in one transaction, so that a
 * database half under one key and half under the other cannot exist. File
 * content is never read or rewritten: it is under file keys, under scope
 * keys, which keep their value.
 *
 * Everything else derived from the master secret signs something that
 * lasts minutes — an access token, the "now the code" token of two-step
 * sign-in, a sealed-search handle — and is simply no longer accepted. The
 * nightly backups are files under 'database-backup': they are not
 * rewritten, and a restore opens an older one with the key it was made with
 * and moves what it holds across (ensureMasterKey).
 */

/**
 * The secrets sealed under a master-derived key, sealed as their writers
 * seal them: AES-256-GCM, `iv (12) || tag (16) || ciphertext`, with the row
 * bound in as additional data. A new purpose whose values are kept in the
 * database belongs here; the API's rotation test opens each one through its
 * writer's own code.
 */
export const MASTER_SEALED = [
  // apps/api/src/auth/totp.ts
  {
    name: 'totpSecrets',
    purpose: 'totp-secrets',
    table: 'account',
    key: 'id',
    column: 'totp_secret',
    aad: (id: string) => `totp:${id}`,
  },
  // packages/storage/src/vault-row.ts
  {
    name: 'vaultCredentials',
    purpose: 'vault-credentials',
    table: 'vault',
    key: 'id',
    column: 'credentials_encrypted',
    aad: (id: string) => `vault:${id}`,
  },
  // apps/api/src/notifications/service.ts (sealPassword)
  {
    name: 'smtpPasswords',
    purpose: 'smtp-credentials',
    table: 'smtp_settings',
    key: 'household_id',
    column: 'password_encrypted',
    aad: (id: string) => `smtp:${id}`,
  },
] as const;

export type SealedName = (typeof MASTER_SEALED)[number]['name'];

/** What was moved onto the new key: counts, never contents. */
export interface RekeyReport {
  /** Scope keys rewrapped under the new key-encryption key. */
  rewrapped: number;
  /** Secrets sealed again under the new master-derived keys, by kind. */
  resealed: Record<SealedName, number>;
}

/** Something the master key should open did not. Nothing was changed. */
export class MasterKeyMismatch extends Error {
  constructor(
    /** What did not open, by table and row: never its contents. */
    readonly what: string,
  ) {
    super(`${what} does not open with that master key`);
  }
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Seals a value as MASTER_SEALED's writers do. */
export function sealBound(key: Buffer, plain: Buffer, aad: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

/** Opens a value sealed by `sealBound`, or by one of MASTER_SEALED's writers. */
export function openBound(key: Buffer, sealed: Buffer, aad: string): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, IV_BYTES));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([d.update(sealed.subarray(IV_BYTES + TAG_BYTES)), d.final()]);
}

/**
 * Rotation: everything the old master key protects is moved onto the new
 * one, and every session is ended — in one transaction, as the owning role,
 * across households. Access tokens are signed with a master-derived key and
 * stop working by themselves; the refresh tokens that renew them are not,
 * so their sessions are ended here and everybody signs in again. Throws
 * MasterKeyMismatch, changing nothing, if anything does not open with the
 * old key.
 */
export async function rotateMasterKey(
  admin: pg.Pool,
  oldSecret: string,
  newSecret: string,
): Promise<RekeyReport & { sessionsEnded: number }> {
  if (oldSecret === newSecret) throw new Error('the new master key is the one in use');
  return inTransaction(admin, async (client) => {
    const moved = await rekey(client, oldSecret, newSecret);
    const ended = await client.query(
      `update session set revoked_at = now(), revoked_reason = 'master key rotated'
        where revoked_at is null`,
    );
    return { ...moved, sessionsEnded: ended.rowCount ?? 0 };
  });
}

/**
 * After a restore: makes everything the master key protects open with
 * `current`. A backup made before a rotation holds it under the key it was
 * made with; given that key as `previous`, it is moved across in one
 * transaction. Null when it all opens with `current` already.
 *
 * Throws MasterKeyMismatch, changing nothing, when something does not open
 * with `current` and there is no `previous`, or `previous` does not open
 * all of it either: a database left half under one key and half under the
 * other would lock part of the household out for good.
 */
export async function ensureMasterKey(
  admin: pg.Pool,
  current: string,
  previous?: string,
): Promise<RekeyReport | null> {
  return inTransaction(admin, async (client) => {
    try {
      await rekey(client, current, null);
      return null;
    } catch (err) {
      if (!(err instanceof MasterKeyMismatch) || previous === undefined || previous === current) {
        throw err;
      }
    }
    return rekey(client, previous, current);
  });
}

/**
 * Opens everything under `from` and, unless `to` is null (a check), puts
 * it back under `to`. Rows are locked as they are read.
 */
async function rekey(client: pg.ClientBase, from: string, to: string | null): Promise<RekeyReport> {
  const kek = deriveKey(from, KEK_PURPOSE);
  const nextKek = to === null ? null : deriveKey(to, KEK_PURPOSE);
  const { rows } = await client.query<{
    id: string;
    household_id: string;
    kind: ScopeKind;
    member_id: string | null;
    key_wrapped: Buffer;
  }>('select id, household_id, kind, member_id, key_wrapped from scope_key order by id for update');
  for (const r of rows) {
    const b = binding({ householdId: r.household_id, kind: r.kind, memberId: r.member_id });
    const key = opened(() => unwrapKey(r.key_wrapped, kek, b), `the ${r.kind} scope key ${r.id}`);
    if (nextKek) {
      await client.query(
        'update scope_key set key_wrapped = $1, rotated_at = now() where id = $2',
        [wrapKey(key, nextKek, b), r.id],
      );
    }
  }

  const resealed: Record<SealedName, number> = {
    totpSecrets: 0,
    vaultCredentials: 0,
    smtpPasswords: 0,
  };
  for (const s of MASTER_SEALED) {
    // A backup can be older than the column; a restore brings it up to date
    // afterwards, with nothing in it to move.
    if (!(await hasColumn(client, s.table, s.column))) continue;
    const key = deriveKey(from, s.purpose);
    const nextKey = to === null ? null : deriveKey(to, s.purpose);
    const { rows: sealed } = await client.query<{ id: string; value: Buffer }>(
      `select ${s.key}::text as id, ${s.column} as value from ${s.table}
        where ${s.column} is not null order by 1 for update`,
    );
    for (const r of sealed) {
      const aad = s.aad(r.id);
      const plain = opened(() => openBound(key, r.value, aad), `${s.table}.${s.column} of ${r.id}`);
      if (nextKey) {
        await client.query(`update ${s.table} set ${s.column} = $1 where ${s.key} = $2`, [
          sealBound(nextKey, plain, aad),
          r.id,
        ]);
      }
      resealed[s.name] += 1;
    }
  }
  return { rewrapped: rows.length, resealed };
}

function opened<T>(open: () => T, what: string): T {
  try {
    return open();
  } catch {
    throw new MasterKeyMismatch(what);
  }
}

async function hasColumn(client: pg.ClientBase, table: string, column: string): Promise<boolean> {
  const { rows } = await client.query<{ ok: boolean }>(
    `select exists (select 1 from pg_attribute
                     where attrelid = to_regclass($1) and attname = $2 and not attisdropped) as ok`,
    [`public.${table}`, column],
  );
  return rows[0]?.ok === true;
}

async function inTransaction<T>(
  admin: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await admin.connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
