import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, withHousehold, type Db } from './client.js';
import { createTestDatabase, testAdminUrl, type TestDatabase } from './testing.js';

describe.skipIf(!testAdminUrl())('withHousehold', () => {
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

  it('connects as the application role', async () => {
    const r = await sql<{ u: string }>`select current_user as u`.execute(db);
    expect(r.rows[0]?.u).toBe('fdv_app');
  });

  it('sets app.household_id inside the transaction only', async () => {
    const id = '11111111-1111-1111-1111-111111111111';
    const inside = await withHousehold(db, id, (trx) => current(trx));
    expect(inside).toBe(id);

    // Same pool, next borrower: the setting must be gone.
    const outside = await current(db);
    expect(outside === null || outside === '').toBe(true);
  });
});
