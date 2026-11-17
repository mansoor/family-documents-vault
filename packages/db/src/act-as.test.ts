import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actAs, createDb, createPool, withPrincipal, withSystem, type Db } from './client.js';
import { createTestDatabase, testAdminUrl, type TestDatabase } from './testing.js';

/**
 * Acting as another person of the household for a part of somebody's own
 * transaction (0.9.0, APP5): only as somebody of this household as they are,
 * and always back to the transaction's own person afterwards — after a
 * throw too, with the transaction still usable.
 */
describe.skipIf(!testAdminUrl())('actAs', () => {
  let tdb: TestDatabase;
  let admin: pg.Pool;
  let db: Db;
  const hh = randomUUID();
  const other = randomUUID();
  const who = {
    owner: { member: '', account: '' },
    adult: { member: '', account: '' },
    stranger: { member: '', account: '' },
  };

  const one = async <T>(text: string, params: unknown[]) =>
    (await admin.query<T & pg.QueryResultRow>(text, params)).rows[0] as T;
  const person = async (household: string, name: string, role: string) => {
    const m = await one<{ id: string }>(
      'insert into member (household_id, display_name) values ($1, $2) returning id',
      [household, name],
    );
    const a = await one<{ id: string }>('insert into account (email) values ($1) returning id', [
      `${randomUUID()}@example.test`,
    ]);
    await admin.query(
      'insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, $4)',
      [a.id, household, m.id, role],
    );
    return { member: m.id, account: a.id };
  };
  const asOwner = () => ({
    householdId: hh,
    accountId: who.owner.account,
    memberId: who.owner.member,
    role: 'owner' as const,
  });
  const me = async (trx: Db) =>
    (
      await sql<{
        account: string;
        member: string;
        role: string;
      }>`select current_setting('app.account_id', true) as account,
                current_setting('app.member_id', true) as member,
                current_setting('app.role', true) as role`.execute(trx)
    ).rows[0];

  beforeAll(async () => {
    tdb = await createTestDatabase();
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    db = createDb(createPool(tdb.appUrl, 1));
    await admin.query("insert into household (id, name) values ($1, 'Acting'), ($2, 'Other')", [
      hh,
      other,
    ]);
    who.owner = await person(hh, 'Owner', 'owner');
    who.adult = await person(hh, 'Adult', 'adult');
    who.stranger = await person(other, 'Stranger', 'owner');
  });
  afterAll(async () => {
    await db?.destroy();
    await admin?.end();
    await tdb?.drop();
  });

  it('acts as the other person, then the transaction’s own again', async () => {
    await withPrincipal(db, asOwner(), async (trx) => {
      const inside = await actAs(
        trx,
        { accountId: who.adult.account, memberId: who.adult.member, role: 'adult' },
        (t) => me(t),
      );
      expect(inside).toEqual({
        account: who.adult.account,
        member: who.adult.member,
        role: 'adult',
      });
      expect(await me(trx)).toEqual({
        account: who.owner.account,
        member: who.owner.member,
        role: 'owner',
      });
    });
  });

  it('a throw inside puts the transaction’s own person back, undoes what it wrote, and leaves it usable', async () => {
    await withPrincipal(db, asOwner(), async (trx) => {
      await expect(
        actAs(
          trx,
          { accountId: who.adult.account, memberId: who.adult.member, role: 'adult' },
          async (t) => {
            await sql`select set_config('app.marker', 'written', true)`.execute(t);
            // A database error: the transaction would be aborted without the savepoint.
            await sql`select 1 / 0`.execute(t);
          },
        ),
      ).rejects.toThrow(/division by zero/);
      expect(await me(trx)).toEqual({
        account: who.owner.account,
        member: who.owner.member,
        role: 'owner',
      });
      const marker = await sql<{ v: string | null }>`
        select nullif(current_setting('app.marker', true), '') as v`.execute(trx);
      expect(marker.rows[0]?.v).toBeNull();
      // And a JS error, caught: the same.
      await expect(
        actAs(
          trx,
          { accountId: who.adult.account, memberId: who.adult.member, role: 'adult' },
          async () => {
            throw new Error('no');
          },
        ),
      ).rejects.toThrow('no');
      expect((await me(trx))?.role).toBe('owner');
    });
  });

  it('never as somebody who is not of this household as they are, nor from the vault’s own', async () => {
    await withPrincipal(db, asOwner(), async (trx) => {
      for (const as of [
        // Another household's person.
        { accountId: who.stranger.account, memberId: who.stranger.member, role: 'owner' as const },
        // The right person, the wrong role.
        { accountId: who.adult.account, memberId: who.adult.member, role: 'owner' as const },
        // Somebody's account with another's member.
        { accountId: who.adult.account, memberId: who.owner.member, role: 'adult' as const },
      ]) {
        await expect(actAs(trx, as, (t) => me(t))).rejects.toThrow(
          /only for somebody of this household/,
        );
      }
      expect((await me(trx))?.role).toBe('owner');
    });
    await expect(
      withSystem(db, hh, (trx) =>
        actAs(
          trx,
          { accountId: who.adult.account, memberId: who.adult.member, role: 'adult' },
          (t) => me(t),
        ),
      ),
    ).rejects.toThrow(/only for a transaction of somebody signed in/);
  });
});
