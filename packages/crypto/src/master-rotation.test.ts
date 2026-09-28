import { randomUUID } from 'node:crypto';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveKey, KEK_PURPOSE } from './master.js';
import {
  ensureMasterKey,
  MASTER_SEALED,
  MasterKeyMismatch,
  openBound,
  sealBound,
} from './master-rotation.js';
import { binding, type ScopeRef } from './scope-keys.js';
import { newKey, unwrapKey, wrapKey } from './wrap.js';

/**
 * A restore of a backup made before a rotation (ensureMasterKey): what it
 * holds is moved onto the current key, all of it or none of it.
 */

const OLD = 'old-master-secret-with-at-least-32-bytes!!';
const NEW = 'new-master-secret-with-at-least-32-bytes!!';

describe.skipIf(!testAdminUrl())('a restored database and the master key', () => {
  let tdb: TestDatabase;
  let admin: pg.Pool;
  /** Each scope key's plaintext, and each sealed value's, by where it is. */
  let plain: Map<string, Buffer>;

  /** A household with its three scope keys and one of each sealed secret, under `secret`. */
  async function seed(secret: string): Promise<void> {
    const h = randomUUID();
    await admin.query("insert into household (id, name) values ($1, 'H')", [h]);
    const m = await admin.query<{ id: string }>(
      "insert into member (household_id, display_name) values ($1, 'One') returning id",
      [h],
    );
    const refs: ScopeRef[] = [
      { householdId: h, kind: 'household' },
      { householdId: h, kind: 'adults' },
      { householdId: h, kind: 'member', memberId: m.rows[0]?.id ?? null },
    ];
    for (const ref of refs) {
      const key = newKey();
      const { rows } = await admin.query<{ id: string }>(
        `insert into scope_key (household_id, kind, member_id, key_wrapped)
         values ($1, $2, $3, $4) returning id`,
        [
          h,
          ref.kind,
          ref.memberId ?? null,
          wrapKey(key, deriveKey(secret, KEK_PURPOSE), binding(ref)),
        ],
      );
      plain.set(`scope_key:${rows[0]?.id}`, key);
    }
    const a = await admin.query<{ id: string }>(
      'insert into account (email) values ($1) returning id',
      [`${h}@example.test`],
    );
    const v = await admin.query<{ id: string }>(
      "insert into vault (household_id, kind, label, bucket) values ($1, 's3', 'B', 'b') returning id",
      [h],
    );
    await admin.query(
      "insert into smtp_settings (household_id, host, from_email) values ($1, 'smtp.example.test', 'v@example.test')",
      [h],
    );
    const ids = { account: a.rows[0]?.id, vault: v.rows[0]?.id, smtp_settings: h };
    for (const s of MASTER_SEALED) {
      const id = ids[s.table] as string;
      const value = Buffer.from(`${s.name} of ${id}`);
      await admin.query(`update ${s.table} set ${s.column} = $1 where ${s.key} = $2`, [
        sealBound(deriveKey(secret, s.purpose), value, s.aad(id)),
        id,
      ]);
      plain.set(`${s.table}:${id}`, value);
    }
  }

  /** Every protected value, opened under `secret`; throws if one does not open. */
  async function openAll(secret: string): Promise<Map<string, Buffer>> {
    const out = new Map<string, Buffer>();
    const keys = await admin.query<{
      id: string;
      household_id: string;
      kind: ScopeRef['kind'];
      member_id: string | null;
      key_wrapped: Buffer;
    }>('select id, household_id, kind, member_id, key_wrapped from scope_key');
    for (const r of keys.rows) {
      const ref = { householdId: r.household_id, kind: r.kind, memberId: r.member_id };
      out.set(
        `scope_key:${r.id}`,
        unwrapKey(r.key_wrapped, deriveKey(secret, KEK_PURPOSE), binding(ref)),
      );
    }
    for (const s of MASTER_SEALED) {
      const { rows } = await admin.query<{ id: string; v: Buffer }>(
        `select ${s.key}::text as id, ${s.column} as v from ${s.table} where ${s.column} is not null`,
      );
      for (const r of rows) {
        out.set(`${s.table}:${r.id}`, openBound(deriveKey(secret, s.purpose), r.v, s.aad(r.id)));
      }
    }
    return out;
  }

  /** Every protected value as stored, in a fixed order. */
  const bytes = async () => {
    const all: string[] = [];
    const columns: [table: string, column: string, key: string][] = [
      ['scope_key', 'key_wrapped', 'id'],
      ...MASTER_SEALED.map((s): [string, string, string] => [s.table, s.column, s.key]),
    ];
    for (const [table, column, key] of columns) {
      const { rows } = await admin.query<{ v: string | null }>(
        `select encode(${column}, 'hex') as v from ${table} order by ${key}`,
      );
      all.push(...rows.map((r) => `${table}:${r.v ?? ''}`));
    }
    return all.join(',');
  };

  beforeEach(async () => {
    tdb = await createTestDatabase();
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 2 });
    plain = new Map();
  });
  afterEach(async () => {
    await admin.end();
    await tdb.drop();
  });

  it('moves what a backup from before a rotation holds onto the current key, then leaves it be', async () => {
    await seed(OLD);
    await seed(OLD);

    // Without the key it was made with, it is refused and nothing moves.
    const before = await bytes();
    await expect(ensureMasterKey(admin, NEW)).rejects.toBeInstanceOf(MasterKeyMismatch);
    expect(await bytes()).toBe(before);

    const moved = await ensureMasterKey(admin, NEW, OLD);
    expect(moved).toEqual({
      rewrapped: 6,
      resealed: { totpSecrets: 2, vaultCredentials: 2, smtpPasswords: 2 },
    });
    expect(await openAll(NEW)).toEqual(plain);
    await expect(openAll(OLD)).rejects.toThrow();

    // Under the current key already: nothing to do, and nothing done.
    const after = await bytes();
    expect(await ensureMasterKey(admin, NEW, OLD)).toBeNull();
    expect(await ensureMasterKey(admin, NEW)).toBeNull();
    expect(await bytes()).toBe(after);
  });

  it('refuses a database part under one key and part under the other, and moves none of it', async () => {
    await seed(OLD);
    // The mail password is reached last: by then every scope key and the
    // other secrets have been moved, in the same transaction.
    const { rows } = await admin.query<{ id: string }>(
      'select household_id as id from smtp_settings',
    );
    const h = rows[0]?.id as string;
    await admin.query('update smtp_settings set password_encrypted = $1', [
      sealBound(deriveKey(NEW, 'smtp-credentials'), Buffer.from('mixed'), `smtp:${h}`),
    ]);
    const before = await bytes();
    await expect(ensureMasterKey(admin, NEW, OLD)).rejects.toThrow(
      new RegExp(`smtp_settings.password_encrypted of ${h} does not open`),
    );
    expect(await bytes()).toBe(before);
  });
});
