import { randomUUID } from 'node:crypto';
import { createDb, createPool, withSystem, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import { addDays } from '@fdv/shared';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deliver, refreshStatus, tick, type Digest } from './reminders.js';

/**
 * The reminder clockwork against real tables, with a fake clock.
 * The headline test: a server switched off for nine days produces exactly
 * one summary notification when it comes back (REM-13, Phase 2 exit).
 */
describe.skipIf(!testAdminUrl())('reminders tick / deliver / catch-up', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  const hh = randomUUID();
  const sent: Digest[] = [];
  const notifier = { digest: async (d: Digest) => (sent.push(d), ['test']) };
  let clock = new Date('2026-09-22T09:10:00Z'); // 09:10 UTC; the household is in UTC
  const deps = () => ({ admin, app: db, notifier, log: () => undefined, now: () => clock });
  const at = (iso: string) => {
    clock = new Date(iso);
  };

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 3));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    await admin.query(
      "insert into household (id, name, timezone) values ($1, 'Clockwork', 'UTC')",
      [hh],
    );
    const m = await admin.query<{ id: string }>(
      "insert into member (household_id, display_name) values ($1, 'M') returning id",
      [hh],
    );
    // Somebody to send the digest to: a digest is always one person's.
    const a = await admin.query<{ id: string }>(
      "insert into account (email) values ('clockwork@example.test') returning id",
    );
    await admin.query(
      "insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, 'owner')",
      [a.rows[0]?.id, hh, m.rows[0]?.id],
    );
    await withSystem(db, hh, async (trx) => {
      const docs: Array<[string, string]> = [
        ['Passport', '2026-09-20'],
        ['Car registration', '2026-09-24'],
        ['Insurance', '2026-10-01'],
      ];
      for (const [title, fire] of docs) {
        const d = await trx
          .insertInto('document')
          .values({
            household_id: hh,
            title,
            owner_member_id: m.rows[0]?.id as string,
            type_key: 'passport',
            // A passport's number is required from 0032 (A9): these have one.
            identifier: `P-${title}`,
            expires_on: addDays(fire, 180),
            expires_precision: 'day',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('reminder')
          .values({
            household_id: hh,
            document_id: d.id,
            kind: 'derived',
            fire_at: fire,
            lead_days: 180,
          })
          .execute();
      }
    });
  });
  afterAll(async () => {
    await db.destroy();
    await admin.end();
    await tdb.drop();
  });

  const statuses = () =>
    withSystem(db, hh, (trx) =>
      trx.selectFrom('reminder').select(['fire_at', 'status']).orderBy('fire_at').execute(),
    ).then((rows) => rows.map((r) => `${String(r.fire_at).slice(0, 10)}:${r.status}`));

  it('tick moves reminders to due on their local date, not before', async () => {
    at('2026-09-22T09:10:00Z');
    expect(await tick(deps())).toEqual({ became_due: 1 });
    expect(await statuses()).toEqual([
      '2026-09-20:due',
      '2026-09-24:scheduled',
      '2026-10-01:scheduled',
    ]);
  });

  it('deliver sends one digest at 9am local and records the ledger; a second run sends nothing', async () => {
    expect(await deliver({ ...deps(), digestHour: 9 })).toEqual({ digests: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      kind: 'catch_up',
      local_date: '2026-09-22',
      items: [{ title: 'Passport', overdue: true }],
    });
    expect(await deliver({ ...deps(), digestHour: 9 })).toEqual({ digests: 0 });
    expect(sent).toHaveLength(1);
    const ledger = await withSystem(db, hh, (trx) =>
      trx.selectFrom('reminder_delivery').selectAll().execute(),
    );
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.channel).toBe('test');
  });

  it('later the same day it is not sent again: the ledger, not the clock', async () => {
    at('2026-09-22T14:00:00Z');
    expect(await deliver({ ...deps(), digestHour: 9 })).toEqual({ digests: 0 });
  });

  it('a server off for nine days produces exactly one summary on restart', async () => {
    // Nothing ran between 23 Sep and 1 Oct. Back on at six in the morning:
    // there is plenty to say, but nothing fires before nine.
    at('2026-10-01T06:00:00Z');
    expect(await tick(deps())).toEqual({ became_due: 2 });
    expect(await deliver({ ...deps(), digestHour: 9 })).toEqual({ digests: 0 });
    expect(sent).toHaveLength(1);

    // It actually came back in the evening — which is when a server that
    // was off for nine days usually does. The summary is still owed today.
    at('2026-10-01T21:40:00Z');
    expect(await deliver({ ...deps(), digestHour: 9 })).toEqual({ digests: 1 });
    expect(sent).toHaveLength(2);
    const summary = sent[1] as Digest;
    expect(summary.kind).toBe('catch_up');
    expect(summary.items.map((i) => i.title).sort()).toEqual(['Car registration', 'Insurance']);
    expect(summary.items.find((i) => i.title === 'Car registration')?.label).toBe(
      'Overdue by 7 days',
    );
    expect(summary.items.find((i) => i.title === 'Insurance')?.label).toBe('Due today');
    // The passport was delivered on the 22nd; it is not repeated.
    expect(summary.items.map((i) => i.title)).not.toContain('Passport');
  });

  it('a snoozed reminder returns to due when the snooze ends', async () => {
    await withSystem(db, hh, (trx) =>
      trx
        .updateTable('reminder')
        .set({ status: 'snoozed', snoozed_until: '2026-10-05' })
        .where('fire_at', '=', '2026-10-01')
        .execute(),
    );
    at('2026-10-04T09:00:00Z');
    expect(await tick(deps())).toEqual({ became_due: 0 });
    at('2026-10-05T09:00:00Z');
    expect(await tick(deps())).toEqual({ became_due: 1 });
  });

  it('refreshStatus materialises status_cache without being authoritative', async () => {
    at('2026-10-05T09:00:00Z');
    const r = await refreshStatus(deps());
    expect(r.documents).toBe(3);
    const cached = await withSystem(db, hh, (trx) =>
      trx.selectFrom('document').select(['title', 'status_cache']).orderBy('title').execute(),
    );
    expect(cached.every((c) => c.status_cache === 'expiring_soon')).toBe(true);
  });

  it("refreshStatus reads the household's own types, through the view", async () => {
    // The household tells its passports to warn 30 days out, not 270 and
    // 180 (0031): each, about six months from its expiry, is simply valid.
    await admin.query(
      `insert into document_type_setting (household_id, type_key, reminder_leads)
       values ($1, 'passport', '{30}')`,
      [hh],
    );
    const statuses = () =>
      withSystem(db, hh, (trx) =>
        trx.selectFrom('document').select('status_cache').orderBy('title').execute(),
      );
    try {
      at('2026-10-05T09:00:00Z');
      expect((await refreshStatus(deps())).documents).toBe(3);
      expect((await statuses()).map((c) => c.status_cache)).toEqual(['active', 'active', 'active']);
      // And with Expires switched off, a passport no longer expires at all.
      await admin.query(
        `update document_type_setting set core = '{"expires": {"shown": false}}'
          where household_id = $1 and type_key = 'passport'`,
        [hh],
      );
      await refreshStatus(deps());
      expect((await statuses()).map((c) => c.status_cache)).toEqual(['valid', 'valid', 'valid']);
    } finally {
      await admin.query('delete from document_type_setting where household_id = $1', [hh]);
    }
    await refreshStatus(deps());
    expect((await statuses()).every((c) => c.status_cache === 'expiring_soon')).toBe(true);
  });

  it('refreshStatus: a required field with no value is Needs info, as the API says (0.5.7)', async () => {
    // With 30 days' warning the passports are simply valid — but one has
    // no number, which a passport requires (A9).
    await admin.query(
      `insert into document_type_setting (household_id, type_key, reminder_leads)
       values ($1, 'passport', '{30}')`,
      [hh],
    );
    await admin.query(
      "update document set identifier = null where household_id = $1 and title = 'Insurance'",
      [hh],
    );
    try {
      at('2026-10-05T09:00:00Z');
      await refreshStatus(deps());
      const cached = await withSystem(db, hh, (trx) =>
        trx.selectFrom('document').select(['title', 'status_cache']).orderBy('title').execute(),
      );
      expect(cached).toEqual([
        { title: 'Car registration', status_cache: 'active' },
        { title: 'Insurance', status_cache: 'needs_info' },
        { title: 'Passport', status_cache: 'active' },
      ]);
    } finally {
      await admin.query('delete from document_type_setting where household_id = $1', [hh]);
      await admin.query(
        "update document set identifier = 'P-Insurance' where household_id = $1 and title = 'Insurance'",
        [hh],
      );
    }
  });
});
