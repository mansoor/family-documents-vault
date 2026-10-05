import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, withPrincipal, withSystem, type Db } from './client.js';
import { createTestDatabase, testAdminUrl, type TestDatabase } from './testing.js';

/**
 * Migration 0057 (5.35): who last changed a note's words, and when — held by
 * the database as well as the API. Somebody signed in stamps a note as
 * themselves and now, never in another's name nor at another time; a stamp
 * never names somebody without a moment; a sign-in removed takes its name
 * off and leaves the moment. The vault itself is not asked.
 */
describe.skipIf(!testAdminUrl())("migration 0057: a note's stamp", () => {
  let tdb: TestDatabase;
  let admin: pg.Pool;
  let db: Db;
  const hh = randomUUID();
  const member = { owner: randomUUID(), adult: randomUUID() };
  const account = { owner: randomUUID(), adult: randomUUID() };
  const doc = randomUUID();

  const as = (who: 'owner' | 'adult') => ({
    householdId: hh,
    accountId: account[who],
    memberId: member[who],
    role: who,
  });
  /** Stamps the note as `who`, in `by`'s name, at `at` (SQL). */
  const stamp = (who: 'owner' | 'adult', by: string | null, at = 'now()') =>
    withPrincipal(db, as(who), async (trx) => {
      await sql`update document
                   set notes = 'Spare key under the pot',
                       notes_updated_at = ${sql.raw(at)},
                       notes_updated_by = ${by}::uuid
                 where id = ${doc}::uuid`.execute(trx);
    });
  const stamped = async () =>
    (
      await admin.query<{ by: string | null; at: Date | null }>(
        'select notes_updated_by as by, notes_updated_at as at from document where id = $1',
        [doc],
      )
    ).rows[0];

  beforeAll(async () => {
    tdb = await createTestDatabase();
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 2 });
    db = createDb(createPool(tdb.appUrl, 2));
    await admin.query("insert into household (id, name) values ($1, 'Notes')", [hh]);
    await admin.query(
      `insert into member (id, household_id, display_name) values ($1, $3, 'Owner'), ($2, $3, 'Adult')`,
      [member.owner, member.adult, hh],
    );
    await admin.query('insert into account (id, email) values ($1, $3), ($2, $4)', [
      account.owner,
      account.adult,
      `owner-${hh}@example.test`,
      `adult-${hh}@example.test`,
    ]);
    await admin.query(
      `insert into account_household (account_id, household_id, member_id, role)
       values ($1, $3, $4, 'owner'), ($2, $3, $5, 'adult')`,
      [account.owner, account.adult, hh, member.owner, member.adult],
    );
    await admin.query(
      "insert into document (id, household_id, title, visibility) values ($1, $2, 'Lease', 'household')",
      [doc, hh],
    );
  });
  afterAll(async () => {
    await db.destroy();
    await admin.end();
    await tdb.drop();
  });

  it('somebody signed in stamps a note as themselves, now, and in no other name or time', async () => {
    await expect(stamp('adult', account.owner)).rejects.toThrow(/stamped by whoever changed it/);
    await expect(stamp('adult', account.adult, "now() - interval '1 day'")).rejects.toThrow(
      /stamped by whoever changed it/,
    );
    await expect(stamp('adult', account.adult, "now() + interval '1 day'")).rejects.toThrow(
      /stamped by whoever changed it/,
    );
    // A moment with nobody's name, written by somebody signed in: refused too.
    await expect(stamp('adult', null, "now() - interval '1 day'")).rejects.toThrow(
      /stamped by whoever changed it/,
    );
    expect(await stamped()).toEqual({ by: null, at: null });

    await stamp('adult', account.adult);
    const first = await stamped();
    expect(first?.by).toBe(account.adult);
    expect(first?.at).toBeInstanceOf(Date);

    // Anything else of the row changed leaves the stamp to stand as it is.
    await withPrincipal(db, as('owner'), (trx) =>
      trx.updateTable('document').set({ title: 'The lease' }).where('id', '=', doc).execute(),
    );
    expect(await stamped()).toEqual(first);

    // A new document stamped as it is made: the same rule.
    const made = (by: string) =>
      withPrincipal(db, as('owner'), (trx) =>
        trx
          .insertInto('document')
          .values({
            id: randomUUID(),
            household_id: hh,
            title: 'Filed with a note',
            notes: 'Written as it was filed',
            notes_updated_at: sql<Date>`now()`,
            notes_updated_by: by,
          })
          .execute(),
      );
    await expect(made(account.adult)).rejects.toThrow(/stamped by whoever changed it/);
    await made(account.owner);
  });

  it('a stamp never names somebody without a moment; a sign-in removed takes its name off, not the moment', async () => {
    await expect(
      admin.query(
        'update document set notes_updated_at = null, notes_updated_by = $2 where id = $1',
        [doc, account.owner],
      ),
    ).rejects.toThrow(/document_notes_stamp_whole/);
    // What the foreign key does when a sign-in is removed, done by somebody
    // signed in: the name comes off and the moment stays.
    const before = await stamped();
    await withPrincipal(db, as('owner'), (trx) =>
      trx.updateTable('document').set({ notes_updated_by: null }).where('id', '=', doc).execute(),
    );
    expect(await stamped()).toEqual({ by: null, at: before?.at });
  });

  it('the vault itself writes any stamp: a restore, a migration', async () => {
    await withSystem(db, hh, async (trx) => {
      await sql`update document
                   set notes_updated_at = '2026-09-25T15:12:00Z', notes_updated_by = ${account.owner}::uuid
                 where id = ${doc}::uuid`.execute(trx);
    });
    expect(await stamped()).toEqual({
      by: account.owner,
      at: new Date('2026-09-25T15:12:00Z'),
    });
  });
});
