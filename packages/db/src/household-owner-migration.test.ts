import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, withSystem, type Db } from './client.js';
import { listMigrations, migrateUp } from './migrate.js';
import { regenerateDerived } from './reminders.js';
import { createEmptyDatabase, testAdminUrl, type TestDatabase } from './testing.js';

/**
 * Migration 0087 (0.9.0, the owner's decisions of 11 Nov 2026): the
 * household as a document's owner, whom each kind belongs to, and the
 * Utility / bill's Due date in place of Expires — each bill's expiry moved
 * to its due date, and its reminders with it, in place: none lost, none
 * made twice, none sent again. A household that changed the bill keeps its
 * changes.
 */
describe.skipIf(!testAdminUrl())('migration 0087: the household, and a bill’s due date', () => {
  let tdb: TestDatabase;
  let admin: pg.Pool;
  let app: Db;
  let dir: string;
  const hh = { plain: randomUUID(), ownFields: randomUUID(), keepsExpires: randomUUID() };
  const member = randomUUID();
  const doc = {
    bill: randomUUID(),
    noDate: randomUUID(),
    onlyMe: randomUUID(),
    hasDue: randomUUID(),
    ownFieldsBill: randomUUID(),
    keptBill: randomUUID(),
    pets: randomUUID(),
    passport: randomUUID(),
    deed: randomUUID(),
  };
  const r = { due: randomUUID(), ahead: randomUUID(), manual: randomUUID(), kept: randomUUID() };
  // Weeks ahead of the real today, as the worker measures it.
  const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const due = day(40);
  let ledger: unknown[];
  let remindersBefore: Array<Record<string, unknown>>;

  const one = async <T extends pg.QueryResultRow>(q: string, v: unknown[] = []) =>
    (await admin.query<T>(q, v)).rows[0] as T;

  beforeAll(async () => {
    tdb = await createEmptyDatabase();
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    // 0.9.0-dev.30's schema, before 0087.
    dir = await mkdtemp(path.join(tmpdir(), 'fdv-0086-'));
    for (const m of await listMigrations()) {
      if (m.version < 87) await copyFile(m.file, path.join(dir, path.basename(m.file)));
    }
    await migrateUp(admin, dir);
    app = createDb(createPool(tdb.appUrl, 2));

    for (const [name, id] of Object.entries(hh)) {
      await admin.query('insert into household (id, name) values ($1, $2)', [id, name]);
    }
    await admin.query(
      `insert into member (id, household_id, display_name) values ($1, $2, 'Sara')`,
      [member, hh.plain],
    );
    // One household gave the bill its own fields (Amount as the built-in
    // called it, and a word of its own for the account); another switched
    // Expires on for it itself.
    await admin.query(
      `insert into document_type_setting (household_id, type_key, fields) values ($1, 'utility_bill',
         '[{"key": "account", "label": "Customer no.", "kind": "text", "required": false},
           {"key": "amount", "label": "Amount", "kind": "text", "required": false}]')`,
      [hh.ownFields],
    );
    await admin.query(
      `insert into document_type_setting (household_id, type_key, core, reminder_leads)
       values ($1, 'utility_bill', '{"expires": {"shown": true, "label": "Pay by"}}', '{3}')`,
      [hh.keepsExpires],
    );
    const insert = (
      id: string,
      household: string,
      type: string,
      extra: Record<string, unknown> = {},
    ) =>
      admin.query(
        `insert into document (id, household_id, type_key, title, owner_member_id, visibility,
                               expires_on, expires_precision, extra)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id,
          household,
          type,
          type,
          extra.owner ?? null,
          extra.visibility ?? 'household',
          extra.expires ?? null,
          extra.expires ? (extra.precision ?? 'day') : null,
          JSON.stringify(extra.extra ?? {}),
        ],
      );
    await insert(doc.bill, hh.plain, 'utility_bill', { expires: due });
    await insert(doc.noDate, hh.plain, 'utility_bill');
    // An Only me bill, of a month: written plain, sealed by private.seal.
    await insert(doc.onlyMe, hh.plain, 'utility_bill', {
      owner: member,
      visibility: 'private',
      expires: '2027-01-31',
      precision: 'month',
    });
    await insert(doc.hasDue, hh.plain, 'utility_bill', {
      expires: '2026-12-01',
      extra: { due_date: { date: '2026-12-05', precision: 'day' } },
    });
    await insert(doc.ownFieldsBill, hh.ownFields, 'utility_bill', { expires: '2026-12-24' });
    await insert(doc.keptBill, hh.keepsExpires, 'utility_bill', { expires: '2026-12-24' });
    await insert(doc.pets, hh.plain, 'pet_record');
    await insert(doc.passport, hh.plain, 'passport');
    await insert(doc.deed, hh.plain, 'property_deed', { owner: member });

    // The bill's reminders: 7 days before, already due and sent twice; 1
    // day before, ahead; and one set by hand. The kept bill's own, 3 days.
    await admin.query(
      `insert into reminder (id, household_id, document_id, kind, source, fire_at, lead_days, status)
       values ($1, $3, $4, 'derived', 'expires', $5, 7, 'due'),
              ($2, $3, $4, 'derived', 'expires', $6, 1, 'scheduled')`,
      [r.due, r.ahead, hh.plain, doc.bill, day(33), day(39)],
    );
    await admin.query(
      `insert into reminder (id, household_id, document_id, kind, fire_at, note)
       values ($1, $2, $3, 'manual', '2026-12-10', 'Ring them')`,
      [r.manual, hh.plain, doc.bill],
    );
    await admin.query(
      `insert into reminder (id, household_id, document_id, kind, source, fire_at, lead_days, status)
       values ($1, $2, $3, 'derived', 'expires', '2026-12-21', 3, 'scheduled')`,
      [r.kept, hh.keepsExpires, doc.keptBill],
    );
    await admin.query(
      `insert into reminder_delivery (reminder_id, household_id, fire_date, channel)
       values ($1, $2, $3, 'push'), ($1, $2, $3, 'email')`,
      [r.due, hh.plain, day(33)],
    );
    ledger = (await admin.query('select * from reminder_delivery order by channel')).rows;
    remindersBefore = (
      await admin.query<Record<string, unknown>>(
        'select * from reminder where document_id = $1 order by id',
        [doc.bill],
      )
    ).rows;

    // And now 0087, as an upgrade runs it.
    for (const m of await listMigrations()) {
      if (m.version >= 87) await copyFile(m.file, path.join(dir, path.basename(m.file)));
    }
    await migrateUp(admin, dir);
  }, 120_000);

  afterAll(async () => {
    await app?.destroy();
    await admin?.end();
    await tdb?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const docOf = (id: string) =>
    one<{
      expires_on: string | null;
      expires_precision: string | null;
      extra: Record<string, unknown>;
      household_owned: boolean;
      owner_member_id: string | null;
    }>(
      `select to_char(expires_on, 'YYYY-MM-DD') as expires_on, expires_precision, extra,
              household_owned, owner_member_id
         from document where id = $1`,
      [id],
    );
  const kind = (household: string, key: string) =>
    withSystem(app, household, (trx) =>
      trx
        .selectFrom('effective_document_type')
        .selectAll()
        .where('key', '=', key)
        .executeTakeFirstOrThrow(),
    );

  it('moves each bill’s expiry to its due date, in the form a date detail keeps', async () => {
    expect(await docOf(doc.bill)).toMatchObject({
      expires_on: null,
      expires_precision: null,
      extra: { due_date: { date: due, precision: 'day' } },
    });
    // A month's, as a month; an Only me one's plain until private.seal seals it.
    expect(await docOf(doc.onlyMe)).toMatchObject({
      expires_on: null,
      extra: { due_date: { date: '2027-01-31', precision: 'month' } },
    });
    expect((await docOf(doc.noDate)).extra).toEqual({});
    // One that had a due date already keeps both as they were.
    expect(await docOf(doc.hasDue)).toMatchObject({
      expires_on: '2026-12-01',
      extra: { due_date: { date: '2026-12-05', precision: 'day' } },
    });
    expect((await docOf(doc.ownFieldsBill)).extra).toEqual({
      due_date: { date: '2026-12-24', precision: 'day' },
    });
  });

  it('keeps the bill’s reminders, about its due date now: none lost, doubled or sent again', async () => {
    const now = (
      await admin.query('select * from reminder where document_id = $1 order by id', [doc.bill])
    ).rows;
    expect(now).toEqual(
      remindersBefore.map((row) => (row.kind === 'derived' ? { ...row, source: 'due_date' } : row)),
    );
    expect((await admin.query('select * from reminder_delivery order by channel')).rows).toEqual(
      ledger,
    );
    // Made again from the kind as it now is, as the next edit or the
    // worker would: exactly the same rows.
    await withSystem(app, hh.plain, (trx) => regenerateDerived(trx, hh.plain, doc.bill));
    expect(
      (await admin.query('select * from reminder where document_id = $1 order by id', [doc.bill]))
        .rows,
    ).toEqual(now);
  });

  it('makes the bill a bill: a Due date reminding 7 and 1 days before, no Expires, a Bill amount', async () => {
    const bill = await kind(hh.plain, 'utility_bill');
    expect(bill).toMatchObject({
      expiry_driver: null,
      reminder_leads: [],
      remind_from: 'due_date',
      remind_leads: [7, 1],
      belongs_to: 'household',
    });
    expect((bill.core as Record<string, { shown: boolean } | undefined>).expires?.shown).toBe(
      false,
    );
    expect(bill.fields).toEqual([
      { key: 'account', label: 'Account', kind: 'text', required: false },
      { key: 'amount', label: 'Bill amount', kind: 'text', required: false },
      { key: 'due_date', label: 'Due date', kind: 'date', required: true },
    ]);
  });

  it('keeps a household’s own changes to the bill', async () => {
    // Its own fields kept, a Due date added, and Amount a bill's.
    const own = await kind(hh.ownFields, 'utility_bill');
    expect(own.fields).toEqual([
      { key: 'account', label: 'Customer no.', kind: 'text', required: false },
      { key: 'amount', label: 'Bill amount', kind: 'text', required: false },
      { key: 'due_date', label: 'Due date', kind: 'date', required: true },
    ]);
    expect(own.remind_from).toBe('due_date');
    // Expires switched on by the household: kept, and still reminding.
    const kept = await kind(hh.keepsExpires, 'utility_bill');
    expect(kept).toMatchObject({
      expiry_driver: 'expires_on',
      remind_from: 'expires',
      remind_leads: [3],
    });
    expect(await docOf(doc.keptBill)).toMatchObject({ expires_on: '2026-12-24', extra: {} });
    expect(
      (await one<{ source: string }>('select source from reminder where id = $1', [r.kept])).source,
    ).toBe('expires');
  });

  it('makes the household’s kinds the household’s, and their documents with nobody chosen', async () => {
    for (const key of ['utility_bill', 'property_deed', 'pet_record']) {
      expect((await kind(hh.plain, key)).belongs_to).toBe('household');
    }
    for (const key of ['passport', 'loan', 'insurance_policy', 'bank_statement']) {
      expect((await kind(hh.plain, key)).belongs_to).toBe('person');
    }
    expect((await docOf(doc.pets)).household_owned).toBe(true);
    expect((await docOf(doc.noDate)).household_owned).toBe(true);
    // Somebody's stays theirs; a person's kind with nobody stays Not sure yet.
    expect(await docOf(doc.deed)).toMatchObject({
      household_owned: false,
      owner_member_id: member,
    });
    expect((await docOf(doc.onlyMe)).household_owned).toBe(false);
    expect((await docOf(doc.passport)).household_owned).toBe(false);
  });

  it('never keeps a document both the household’s and a person’s', async () => {
    // A person chosen clears the household, whoever writes it.
    await admin.query('update document set owner_member_id = $2 where id = $1', [doc.pets, member]);
    expect(await docOf(doc.pets)).toMatchObject({
      household_owned: false,
      owner_member_id: member,
    });
    await admin.query(
      'update document set owner_member_id = null, household_owned = true where id = $1',
      [doc.pets],
    );
    expect((await docOf(doc.pets)).household_owned).toBe(true);
    // Both at once: the person's.
    await admin.query(
      'update document set owner_member_id = $2, household_owned = true where id = $1',
      [doc.pets, member],
    );
    expect(await docOf(doc.pets)).toMatchObject({ household_owned: false });
    const check = await one<{ n: number }>(
      `select count(*)::int as n from pg_constraint where conname = 'document_household_or_person'`,
    );
    expect(check.n).toBe(1);
  });
});
