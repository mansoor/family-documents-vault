import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, readAs, withSystem, type Db } from './client.js';
import { createTestDatabase, testAdminUrl, type TestDatabase } from './testing.js';

/**
 * A reminder that somebody turned 13 (0066) is the owners' alone, and so are
 * its deliveries: a delivery is given to whoever is given its reminder, and
 * nobody else (the review, INV-8). A document's reminder, and its
 * deliveries, are given as before.
 */
describe.skipIf(!testAdminUrl())(
  'the owners’ reminder that somebody turned 13, and its deliveries',
  () => {
    let tdb: TestDatabase;
    let db: Db;
    let admin: pg.Pool;
    const hh = randomUUID();
    const who: Record<string, { account: string; member: string }> = {};
    let personReminder = '';
    let documentReminder = '';

    beforeAll(async () => {
      tdb = await createTestDatabase();
      db = createDb(createPool(tdb.appUrl, 2));
      admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
      await admin.query("insert into household (id, name, timezone) values ($1, 'T', 'UTC')", [hh]);
      for (const role of ['owner', 'adult', 'teen'] as const) {
        const m = await admin.query<{ id: string }>(
          'insert into member (household_id, display_name) values ($1, $2) returning id',
          [hh, role],
        );
        const a = await admin.query<{ id: string }>(
          'insert into account (email) values ($1) returning id',
          [`${role}-${hh.slice(0, 8)}@example.test`],
        );
        await admin.query(
          'insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, $4)',
          [a.rows[0]?.id, hh, m.rows[0]?.id, role],
        );
        who[role] = { account: a.rows[0]?.id as string, member: m.rows[0]?.id as string };
      }
      const child = await admin.query<{ id: string }>(
        "insert into member (household_id, display_name, date_of_birth) values ($1, 'Sara', '2013-10-12') returning id",
        [hh],
      );
      await withSystem(db, hh, async (trx) => {
        const r = await trx
          .insertInto('reminder')
          .values({
            household_id: hh,
            member_id: child.rows[0]?.id as string,
            document_id: null,
            kind: 'turned_13',
            fire_at: '2026-10-12',
            status: 'due',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        personReminder = r.id;
        const d = await trx
          .insertInto('document')
          .values({
            household_id: hh,
            title: 'Passport',
            owner_member_id: who.owner?.member as string,
            type_key: 'passport',
            identifier: 'P-1',
            expires_on: '2027-04-01',
            expires_precision: 'day',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        const dr = await trx
          .insertInto('reminder')
          .values({
            household_id: hh,
            document_id: d.id,
            kind: 'derived',
            source: 'expires',
            fire_at: '2026-10-12',
            lead_days: 180,
            status: 'due',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        documentReminder = dr.id;
        for (const id of [personReminder, documentReminder]) {
          await trx
            .insertInto('reminder_delivery')
            .values({ reminder_id: id, household_id: hh, fire_date: '2026-10-12', channel: 'push' })
            .execute();
        }
      });
    });
    afterAll(async () => {
      await db.destroy();
      await admin.end();
      await tdb.drop();
    });

    const seen = (role: 'owner' | 'adult' | 'teen') =>
      withSystem(db, hh, (trx) =>
        readAs(
          trx,
          { accountId: who[role]?.account as string, memberId: who[role]?.member as string, role },
          async (as) => ({
            reminders: (await as.selectFrom('reminder').select('id').execute()).map((r) => r.id),
            deliveries: (
              await as.selectFrom('reminder_delivery').select('reminder_id').execute()
            ).map((r) => r.reminder_id),
          }),
        ),
      );

    it('an owner is given the reminder and its delivery', async () => {
      const owner = await seen('owner');
      expect(owner.reminders.sort()).toEqual([personReminder, documentReminder].sort());
      expect(owner.deliveries.sort()).toEqual([personReminder, documentReminder].sort());
    });

    it('an adult and a teen are given neither: only the document’s, as before', async () => {
      for (const role of ['adult', 'teen'] as const) {
        const theirs = await seen(role);
        expect(theirs.reminders, role).toEqual([documentReminder]);
        expect(theirs.deliveries, role).toEqual([documentReminder]);
      }
    });

    it('nobody signed in but an owner writes one', async () => {
      await expect(
        withSystem(db, hh, (trx) =>
          readAs(
            trx,
            {
              accountId: who.adult?.account as string,
              memberId: who.adult?.member as string,
              role: 'adult',
            },
            (as) =>
              as
                .insertInto('reminder_delivery')
                .values({
                  reminder_id: personReminder,
                  household_id: hh,
                  fire_date: '2026-10-13',
                  channel: 'email',
                })
                .execute(),
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    });
  },
);
