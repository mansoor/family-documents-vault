import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendAudit, verifyAuditChain } from './audit.js';
import { createDb, createPool, withHousehold, withScope, type Db } from './client.js';
import { createTestDatabase, testAdminUrl, type TestDatabase } from './testing.js';

/**
 * The tests that make the tenant guarantee real. If any of these fail, the
 * product's central promise — a bug cannot leak across households — is gone.
 */
describe.skipIf(!testAdminUrl())('row-level security', () => {
  let tdb: TestDatabase;
  let app: Db; // fdv_app: RLS enforced
  let admin: pg.Pool; // owner: for fixtures and tampering
  const A = randomUUID();
  const B = randomUUID();

  beforeAll(async () => {
    tdb = await createTestDatabase();
    app = createDb(createPool(tdb.appUrl, 3));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 2 });
    for (const [id, name] of [
      [A, 'The A family'],
      [B, 'The B family'],
    ]) {
      await admin.query('insert into household (id, name) values ($1, $2)', [id, name]);
      await admin.query('insert into member (household_id, display_name) values ($1, $2)', [
        id,
        `Member of ${name}`,
      ]);
    }
  });
  afterAll(async () => {
    await app.destroy();
    await admin.end();
    await tdb.drop();
  });

  it('a query with no household set sees nothing, even without a WHERE clause', async () => {
    const rows = await app.selectFrom('member').selectAll().execute();
    expect(rows).toEqual([]);
    const hh = await app.selectFrom('household').selectAll().execute();
    expect(hh).toEqual([]);
  });

  it('a query scoped to A sees only A, without a WHERE clause', async () => {
    const rows = await withHousehold(app, A, (trx) =>
      trx.selectFrom('member').select(['household_id', 'display_name']).execute(),
    );
    expect(rows).toEqual([{ household_id: A, display_name: 'Member of The A family' }]);
  });

  it('a query scoped to A cannot read B even when it asks for B by id', async () => {
    const rows = await withHousehold(app, A, (trx) =>
      trx.selectFrom('member').selectAll().where('household_id', '=', B).execute(),
    );
    expect(rows).toEqual([]);
  });

  it('a write scoped to A cannot insert a row for B', async () => {
    await expect(
      withHousehold(app, A, (trx) =>
        trx.insertInto('member').values({ household_id: B, display_name: 'smuggled' }).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('a write scoped to A cannot update or delete B', async () => {
    const upd = await withHousehold(app, A, (trx) =>
      trx.updateTable('member').set({ display_name: 'x' }).where('household_id', '=', B).execute(),
    );
    expect(Number(upd[0]?.numUpdatedRows ?? 0)).toBe(0);
    const del = await withHousehold(app, A, (trx) =>
      trx.deleteFrom('member').where('household_id', '=', B).execute(),
    );
    expect(Number(del[0]?.numDeletedRows ?? 0)).toBe(0);
  });

  it('the scope does not survive the transaction', async () => {
    await withHousehold(app, A, async (trx) => {
      await trx.selectFrom('member').selectAll().execute();
    });
    const after = await app.selectFrom('member').selectAll().execute();
    expect(after).toEqual([]);
  });

  it('an account can see its own memberships before choosing a household', async () => {
    const accountId = randomUUID();
    const member = await admin.query<{ id: string }>(
      'select id from member where household_id = $1',
      [A],
    );
    await admin.query('insert into account (id, email) values ($1, $2)', [accountId, 'a@x.test']);
    await admin.query(
      `insert into account_household (account_id, household_id, member_id, role)
       values ($1, $2, $3, 'owner')`,
      [accountId, A, member.rows[0]?.id],
    );
    const mine = await withScope(app, { accountId }, (trx) =>
      trx.selectFrom('account_household').select(['household_id', 'role']).execute(),
    );
    expect(mine).toEqual([{ household_id: A, role: 'owner' }]);

    const someoneElse = await withScope(app, { accountId: randomUUID() }, (trx) =>
      trx.selectFrom('account_household').selectAll().execute(),
    );
    expect(someoneElse).toEqual([]);
  });

  describe('audit chain', () => {
    it('appends linked rows and verifies clean', async () => {
      await withHousehold(app, A, async (trx) => {
        await appendAudit(trx, { householdId: A, action: 'household.created' });
        await appendAudit(trx, {
          householdId: A,
          action: 'member.added',
          objectType: 'member',
          detail: { name: 'Aisha', b: 1, a: 2 },
        });
        await appendAudit(trx, { householdId: A, action: 'signed_in', ip: '10.0.0.1' });
      });
      const result = await withHousehold(app, A, (trx) => verifyAuditChain(trx, A));
      expect(result).toEqual({ ok: true, checked: 3 });
    });

    it('is invisible from another household', async () => {
      const rows = await withHousehold(app, B, (trx) =>
        trx.selectFrom('audit_event').selectAll().execute(),
      );
      expect(rows).toEqual([]);
    });

    it('the application role cannot update or delete audit rows', async () => {
      await expect(
        withHousehold(app, A, (trx) =>
          trx
            .updateTable('audit_event')
            .set({ action: 'x' })
            .where('household_id', '=', A)
            .execute(),
        ),
      ).rejects.toThrow(/permission denied/);
    });

    it('a tampered row is detected, even by the owning role', async () => {
      // Even the table owner cannot update: the trigger refuses.
      await expect(
        admin.query(`update audit_event set action = 'forged' where household_id = $1`, [A]),
      ).rejects.toThrow(/append-only/);

      // So a real attacker has to drop the trigger first. Simulate that.
      await admin.query('alter table audit_event disable trigger audit_event_no_update');
      try {
        await admin.query(
          `update audit_event set detail = '{"name":"Someone else"}'
           where household_id = $1 and action = 'member.added'`,
          [A],
        );
      } finally {
        await admin.query('alter table audit_event enable trigger audit_event_no_update');
      }
      const result = await withHousehold(app, A, (trx) => verifyAuditChain(trx, A));
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('hash');
      expect(result.brokenAt).toBeDefined();
    });

    it('a deleted row is detected', async () => {
      await admin.query('alter table audit_event disable trigger audit_event_no_update');
      try {
        await admin.query(
          `delete from audit_event where household_id = $1 and action = 'member.added'`,
          [A],
        );
      } finally {
        await admin.query('alter table audit_event enable trigger audit_event_no_update');
      }
      const result = await withHousehold(app, A, (trx) => verifyAuditChain(trx, A));
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('link');
    });
  });

  it('the application role is genuinely not a table owner (RLS would be bypassed)', async () => {
    const r = await sql<{ n: string }>`
      select count(*)::text as n from pg_tables
      where schemaname = 'public' and tableowner = current_user`.execute(app);
    expect(r.rows[0]?.n).toBe('0');
  });
});
