import { randomUUID } from 'node:crypto';
import { createDb, createPool, withHousehold, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EnvKeyProvider } from './master.js';
import { rotateMasterKey, ScopeKeys } from './scope-keys.js';
import { newKey, unwrapKey, wrapKey } from './wrap.js';

const OLD = 'old-master-secret-with-at-least-32-bytes!!';
const NEW = 'new-master-secret-with-at-least-32-bytes!!';

describe.skipIf(!testAdminUrl())('scope keys', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  const H = randomUUID();
  const OTHER = randomUUID();
  let memberId: string;
  let keys: ScopeKeys;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 3));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 2 });
    keys = new ScopeKeys(new EnvKeyProvider(OLD));
    for (const id of [H, OTHER]) {
      await admin.query('insert into household (id, name) values ($1, $2)', [id, id]);
    }
    const m = await admin.query<{ id: string }>(
      "insert into member (household_id, display_name) values ($1, 'Owner') returning id",
      [H],
    );
    memberId = m.rows[0]?.id as string;
  });
  afterAll(async () => {
    await db.destroy();
    await admin.end();
    await tdb.drop();
  });

  it('mints household, adults and member keys and unwraps each', async () => {
    await withHousehold(db, H, async (trx) => {
      await keys.mintHouseholdKeys(trx, H);
      await keys.mintMemberKey(trx, H, memberId, 'members password 123');
    });
    const opened = await withHousehold(db, H, async (trx) => ({
      household: await keys.unwrap(trx, { householdId: H, kind: 'household' }),
      adults: await keys.unwrap(trx, { householdId: H, kind: 'adults' }),
      member: await keys.unwrap(trx, { householdId: H, kind: 'member', memberId }),
    }));
    expect(opened.household.key).toHaveLength(32);
    expect(opened.household.key.equals(opened.adults.key)).toBe(false);
    expect(opened.member.key.equals(opened.household.key)).toBe(false);

    const byId = await withHousehold(db, H, (trx) => keys.unwrapById(trx, opened.member.id));
    expect(byId.equals(opened.member.key)).toBe(true);
  });

  it('refuses a second key of the same scope', async () => {
    await expect(withHousehold(db, H, (trx) => keys.mintHouseholdKeys(trx, H))).rejects.toThrow(
      /duplicate key/,
    );
  });

  it('the member key opens with the credential alone, and not with a wrong password', async () => {
    const ref = { householdId: H, kind: 'member' as const, memberId };
    const viaMaster = await withHousehold(db, H, (trx) => keys.unwrap(trx, ref));
    const viaCred = await withHousehold(db, H, (trx) =>
      keys.unwrapWithCredential(trx, ref, 'members password 123'),
    );
    expect(viaCred.equals(viaMaster.key)).toBe(true);
    await expect(
      withHousehold(db, H, (trx) => keys.unwrapWithCredential(trx, ref, 'wrong')),
    ).rejects.toThrow(/cannot unwrap/);
  });

  it('a password change rewraps the credential copy without changing the key', async () => {
    const ref = { householdId: H, kind: 'member' as const, memberId };
    await withHousehold(db, H, (trx) =>
      keys.rewrapCredential(trx, ref, 'members password 123', 'a brand new password'),
    );
    const viaNew = await withHousehold(db, H, (trx) =>
      keys.unwrapWithCredential(trx, ref, 'a brand new password'),
    );
    const viaMaster = await withHousehold(db, H, (trx) => keys.unwrap(trx, ref));
    expect(viaNew.equals(viaMaster.key)).toBe(true);
    await expect(
      withHousehold(db, H, (trx) => keys.unwrapWithCredential(trx, ref, 'members password 123')),
    ).rejects.toThrow();
  });

  it('a member without a sign-in gets a master wrap only', async () => {
    const child = await admin.query<{ id: string }>(
      "insert into member (household_id, display_name) values ($1, 'Child') returning id",
      [H],
    );
    const childId = child.rows[0]?.id as string;
    await withHousehold(db, H, (trx) => keys.mintMemberKey(trx, H, childId, null));
    const row = await withHousehold(db, H, (trx) =>
      trx
        .selectFrom('scope_key')
        .select(['key_wrapped_cred', 'kdf_params'])
        .where('member_id', '=', childId)
        .executeTakeFirstOrThrow(),
    );
    expect(row.key_wrapped_cred).toBeNull();
    expect(row.kdf_params).toBeNull();
  });

  it('is invisible from another household', async () => {
    const rows = await withHousehold(db, OTHER, (trx) =>
      trx.selectFrom('scope_key').selectAll().execute(),
    );
    expect(rows).toEqual([]);
    await expect(
      withHousehold(db, OTHER, (trx) => keys.unwrap(trx, { householdId: H, kind: 'household' })),
    ).rejects.toThrow(/no household scope key/);
  });

  it('a wrapped blob moved to another row does not unwrap (binding)', async () => {
    const hh = await withHousehold(db, H, (trx) =>
      trx
        .selectFrom('scope_key')
        .select('key_wrapped')
        .where('kind', '=', 'household')
        .executeTakeFirstOrThrow(),
    );
    await admin.query(
      'update scope_key set key_wrapped = $1 where household_id = $2 and kind = $3',
      [hh.key_wrapped, H, 'adults'],
    );
    await expect(
      withHousehold(db, H, (trx) => keys.unwrap(trx, { householdId: H, kind: 'adults' })),
    ).rejects.toThrow(/cannot unwrap/);
    // put a valid adults key back for the rotation test
    const kek = await new EnvKeyProvider(OLD).keyEncryptionKey();
    await admin.query(
      'update scope_key set key_wrapped = $1 where household_id = $2 and kind = $3',
      [wrapKey(newKey(), kek, `${H}:adults`), H, 'adults'],
    );
  });

  it('rotating the master key rewraps every scope key and nothing else', async () => {
    const before = await withHousehold(db, H, async (trx) => ({
      household: (await keys.unwrap(trx, { householdId: H, kind: 'household' })).key,
      member: (await keys.unwrap(trx, { householdId: H, kind: 'member', memberId })).key,
    }));
    // A file key wrapped under the household key: must still open afterwards,
    // proving content never needs rewriting.
    const fileKey = newKey();
    const fileWrapped = wrapKey(fileKey, before.household, 'version:1');

    const result = await rotateMasterKey(admin, new EnvKeyProvider(OLD), new EnvKeyProvider(NEW));
    expect(result.rewrapped).toBe(4);

    const rotated = new ScopeKeys(new EnvKeyProvider(NEW));
    const after = await withHousehold(db, H, async (trx) => ({
      household: (await rotated.unwrap(trx, { householdId: H, kind: 'household' })).key,
      member: (await rotated.unwrap(trx, { householdId: H, kind: 'member', memberId })).key,
    }));
    expect(after.household.equals(before.household)).toBe(true);
    expect(after.member.equals(before.member)).toBe(true);
    expect(unwrapKey(fileWrapped, after.household, 'version:1').equals(fileKey)).toBe(true);

    await expect(
      withHousehold(db, H, (trx) => keys.unwrap(trx, { householdId: H, kind: 'household' })),
    ).rejects.toThrow(/cannot unwrap/);

    const stamped = await admin.query<{ n: number }>(
      'select count(*)::int as n from scope_key where rotated_at is not null',
    );
    expect(stamped.rows[0]?.n).toBe(4);
  });
});
