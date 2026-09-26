import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, withSystem, type Db } from './client.js';
import { createTestDatabase, TEST_APP_ROLE, testAdminUrl, type TestDatabase } from './testing.js';

describe.skipIf(!testAdminUrl())('withSystem', () => {
  let tdb: TestDatabase;
  let db: Db;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 2));
  });
  afterAll(async () => {
    await db.destroy();
    await tdb.drop();
  });

  const current = async (executor: Db) => {
    const r = await sql<{
      v: string;
    }>`select current_setting('app.household_id', true) as v`.execute(executor);
    return r.rows[0]?.v ?? null;
  };

  it('connects as a role that owns nothing, so row-level security applies', async () => {
    // Tests log in as a member of fdv_app rather than fdv_app itself (see
    // testing.ts); what matters is that it is neither the table owner nor
    // a superuser, because either would bypass every policy.
    const r = await sql<{ u: string; member: boolean; boss: boolean }>`
      select current_user as u,
             pg_has_role(current_user, 'fdv_app', 'usage') as member,
             (select rolsuper from pg_roles where rolname = current_user) as boss`.execute(db);
    expect(r.rows[0]?.u).toBe(TEST_APP_ROLE);
    expect(r.rows[0]?.member).toBe(true);
    expect(r.rows[0]?.boss).toBe(false);
  });

  it('sets app.household_id inside the transaction only', async () => {
    const id = '11111111-1111-1111-1111-111111111111';
    const inside = await withSystem(db, id, (trx) => current(trx));
    expect(inside).toBe(id);

    // Same pool, next borrower: the setting must be gone.
    const outside = await current(db);
    expect(outside === null || outside === '').toBe(true);
  });
});
