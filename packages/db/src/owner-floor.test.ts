import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, testAdminUrl, type TestDatabase } from './testing.js';

/**
 * A household keeps an owner, even when two changes commit at once.
 *
 * The rule is a deferred trigger (0015), checked as each transaction
 * commits. Until 0.4.7 two transactions committing together — one owner's
 * demotion carried out while the other stepped down — each saw the other
 * still an owner, both passed, and the household had none. 0023 has the
 * trigger take a per-household lock first, so the second waits and then
 * sees the first.
 */
describe.skipIf(!testAdminUrl())('the owner floor under concurrent commits', () => {
  let tdb: TestDatabase;
  let admin: pg.Pool;
  const hh = randomUUID();
  const owners: string[] = [];

  beforeAll(async () => {
    tdb = await createTestDatabase();
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 4 });
    await admin.query("insert into household (id, name) values ($1, 'Floor')", [hh]);
    for (const name of ['A', 'B']) {
      const m = await admin.query<{ id: string }>(
        'insert into member (household_id, display_name) values ($1, $2) returning id',
        [hh, name],
      );
      const a = await admin.query<{ id: string }>(
        'insert into account (email) values ($1) returning id',
        [`${name.toLowerCase()}-${hh}@example.test`],
      );
      owners.push(a.rows[0]?.id as string);
      await admin.query(
        "insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, 'owner')",
        [a.rows[0]?.id, hh, m.rows[0]?.id],
      );
    }
  }, 60_000);
  afterAll(async () => {
    await admin?.end();
    await tdb?.drop();
  });

  it('two owners giving up the role at the same moment: one of them is refused', async () => {
    const [a, b] = await Promise.all([admin.connect(), admin.connect()]);
    try {
      await a.query('begin');
      await b.query('begin');
      await a.query("update account_household set role = 'adult' where account_id = $1", [
        owners[0],
      ]);
      await b.query("update account_household set role = 'adult' where account_id = $1", [
        owners[1],
      ]);
      const results = await Promise.allSettled([a.query('commit'), b.query('commit')]);
      const refused = results.filter((r) => r.status === 'rejected');
      expect(refused).toHaveLength(1);
      expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({ code: '23514' });
    } finally {
      a.release();
      b.release();
    }
    const { rows } = await admin.query<{ n: number }>(
      "select count(*)::int as n from account_household where household_id = $1 and role = 'owner'",
      [hh],
    );
    expect(rows[0]?.n).toBe(1);
  });
});
