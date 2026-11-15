import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, withSystem, type Db } from './client.js';
import { listMigrations, migrateUp } from './migrate.js';
import { createEmptyDatabase, testAdminUrl, type TestDatabase } from './testing.js';

/**
 * Migration 0101 (0.9.0, H3 of the health plan): Health's nine kinds, in
 * Medical, kept for adults and Sensitive by default; a medical record
 * called what it is; a prescription reminding from its Next refill; and a
 * reminder that may be a yearly review. A household that already keeps a
 * kind of its own by one of the new names goes on using it, the built-in
 * hidden for it (as 0077); a household that gave the prescription fields of
 * its own gains Next refill among them, unless it chose its own date to
 * remind from.
 */
describe.skipIf(!testAdminUrl())('migration 0101: Health’s kinds, details and reminders', () => {
  let tdb: TestDatabase;
  let admin: pg.Pool;
  let app: Db;
  let dir: string;
  /** Keeps kinds of its own by some of the new names, and the prescription with fields of its own. */
  const own = randomUUID();
  /** Chose its own date for the prescription to remind from. */
  const chose = randomUUID();
  /** Changed nothing. */
  const none = randomUUID();
  let prescription: string;
  let expiryReminder: string;

  beforeAll(async () => {
    tdb = await createEmptyDatabase();
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    dir = await mkdtemp(path.join(tmpdir(), 'fdv-0100-'));
    for (const m of await listMigrations()) {
      if (m.version < 101) await copyFile(m.file, path.join(dir, path.basename(m.file)));
    }
    await migrateUp(admin, dir);
    for (const [id, name] of [
      [own, 'Keeps its own'],
      [chose, 'Chose a date'],
      [none, 'Keeps none'],
    ]) {
      await admin.query('insert into household (id, name) values ($1, $2)', [id, name]);
    }
    await admin.query(
      `insert into document_type (key, household_id, label, category, fields, expiry_driver, reminder_leads, short_label)
       values ('h_aaaaaaaaaa', $1, 'Vaccinations', 'medical', '[]', null, '{}', null),
              ('h_bbbbbbbbbb', $1, 'Living Will', 'legal', '[]', null, '{}', null),
              ('h_cccccccccc', $1, 'Insurer letters', 'medical', '[]', null, '{}', 'EOB'),
              ('h_dddddddddd', $1, 'Gym pass', 'other', '[]', null, '{}', null),
              -- Names that could be anything, on kinds that are not Medical: nothing hidden.
              ('h_ffffffffff', $1, 'Member card', 'other', '[]', null, '{}', null),
              ('h_gggggggggg', $1, 'Test results', 'education', '[]', null, '{}', null),
              ('h_hhhhhhhhhh', $1, 'Imaging', 'other', '[]', null, '{}', null),
              ('h_iiiiiiiiii', $1, 'Insurance card', 'vehicle', '[]', null, '{}', null)`,
      [own],
    );
    // An archived one by a new name hides nothing: the household no longer uses it.
    await admin.query(
      `insert into document_type (key, household_id, label, category, fields, expiry_driver, reminder_leads, archived_at)
       values ('h_eeeeeeeeee', $1, 'Lab results', 'medical', '[]', null, '{}', now())`,
      [own],
    );
    await admin.query(
      `insert into document_type_setting (household_id, type_key, fields)
       values ($1, 'prescription',
               '[{"key": "medication", "label": "Medication", "kind": "text", "required": true}]')`,
      [own],
    );
    await admin.query(
      `insert into document_type_setting (household_id, type_key, fields, remind_from)
       values ($1, 'prescription',
               '[{"key": "medication", "label": "Medication", "kind": "text", "required": false}]',
               'expires')`,
      [chose],
    );
    // A prescription reminding from its Expires, as every one did.
    const d = await admin.query<{ id: string }>(
      `insert into document (household_id, title, type_key, expires_on, expires_precision, visibility)
       values ($1, 'Inhaler', 'prescription', current_date + 30, 'day', 'adults') returning id`,
      [none],
    );
    prescription = d.rows[0]?.id as string;
    const r = await admin.query<{ id: string }>(
      `insert into reminder (household_id, document_id, kind, source, fire_at, lead_days, status)
       values ($1, $2, 'derived', 'expires', current_date + 23, 7, 'scheduled') returning id`,
      [none, prescription],
    );
    expiryReminder = r.rows[0]?.id as string;
    await migrateUp(admin);
    app = createDb(createPool(tdb.appUrl, 2));
  }, 120_000);

  afterAll(async () => {
    await app?.destroy();
    await admin?.end();
    await tdb?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const kinds = (hh: string) =>
    withSystem(app, hh, (trx) =>
      trx.selectFrom('effective_document_type').selectAll().orderBy('key').execute(),
    );
  const hidden = async (household: string) =>
    (
      await admin.query<{ type_key: string }>(
        `select type_key from document_type_setting where household_id = $1 and hidden order by 1`,
        [household],
      )
    ).rows.map((r) => r.type_key);

  const NEW = [
    'advance_directive',
    'explanation_of_benefits',
    'healthcare_proxy',
    'hipaa_authorization',
    'imaging_report',
    'insurance_card',
    'lab_result',
    'vaccination_record',
    'visit_summary',
  ];

  it('adds nine built-ins in Medical: kept for adults, Sensitive, a person’s', async () => {
    const { rows } = await admin.query<{
      key: string;
      category: string;
      default_visibility: string;
      sensitive_default: boolean;
      belongs_to: string;
    }>(
      `select key, category, default_visibility, sensitive_default, belongs_to
         from document_type where household_id is null and key = any($1) order by key`,
      [NEW],
    );
    expect(rows.map((r) => r.key)).toEqual(NEW);
    for (const r of rows) {
      expect(r, r.key).toMatchObject({
        category: 'medical',
        default_visibility: 'adults',
        sensitive_default: true,
        belongs_to: 'person',
      });
    }
  });

  it('gives each the details and the date it reminds from, from the library', async () => {
    const all = await kinds(none);
    const of = (key: string) => all.find((t) => t.key === key);
    const fields = (key: string) =>
      ((of(key)?.fields ?? []) as Array<{ key: string; required: boolean }>).map((f) => [
        f.key,
        f.required,
      ]);
    expect(fields('vaccination_record')).toEqual([
      ['vaccines', false],
      ['date_given', false],
      ['next_dose_due', false],
    ]);
    expect(of('vaccination_record')).toMatchObject({
      remind_from: 'next_dose_due',
      remind_leads: [30, 7],
      expiry_driver: null,
      hidden: false,
    });
    expect(of('insurance_card')).toMatchObject({
      remind_from: 'expires',
      remind_leads: [30, 7],
      expiry_driver: 'expires_on',
      issued_by_label: 'Insurer',
    });
    expect(
      (of('insurance_card')?.core as Record<string, { label: string | null }>).identifier,
    ).toMatchObject({ label: 'Member ID' });
    expect(of('hipaa_authorization')).toMatchObject({ remind_from: 'expires', remind_leads: [30] });
    expect(of('advance_directive')).toMatchObject({ remind_from: null, expiry_driver: null });
    expect((of('advance_directive')?.core as Record<string, unknown>).issued).toMatchObject({
      label: 'Signed',
    });
    expect((of('advance_directive')?.core as Record<string, unknown>).issued_by).toMatchObject({
      shown: false,
    });
    expect(of('explanation_of_benefits')).toMatchObject({
      issuer_noun: 'explanation of benefits',
      remind_from: null,
    });
    // Every field a kind asks for is the library's (0031).
    const library = (
      await admin.query<{ key: string }>(
        'select key from document_attribute where household_id is null',
      )
    ).rows.map((r) => r.key);
    for (const key of NEW) {
      for (const [field] of fields(key)) expect(library, `${key}.${field}`).toContain(field);
    }
    expect(library).toContain('refill_date');
  });

  it('calls a medical record what it is, and makes a prescription remind from its Next refill', async () => {
    const all = await kinds(none);
    expect(all.find((t) => t.key === 'medical_record')?.label).toBe('Medical record');
    const rx = all.find((t) => t.key === 'prescription');
    expect(rx).toMatchObject({
      remind_from: 'refill_date',
      // And, for one with no Next refill, its Expires, on the same days.
      remind_fallback: 'expires',
      remind_leads: [7, 1],
      // As an older phone reads it: a date field reminds, so none for Expires.
      reminder_leads: [],
      expiry_driver: 'expires_on',
    });
    // Every other kind has none.
    expect(all.filter((t) => t.remind_fallback !== null).map((t) => t.key)).toEqual([
      'prescription',
    ]);
    expect((rx?.fields as Array<{ key: string; required: boolean }>).at(-1)).toMatchObject({
      key: 'refill_date',
      required: false,
    });
    // The reminder already made from its Expires is left as it was.
    const r = await admin.query('select source, status from reminder where id = $1', [
      expiryReminder,
    ]);
    expect(r.rows).toEqual([{ source: 'expires', status: 'scheduled' }]);
  });

  it('gives Next refill to a household’s own prescription fields; one that chose its date keeps it', async () => {
    const mine = (await kinds(own)).find((t) => t.key === 'prescription');
    expect((mine?.fields as Array<{ key: string }>).map((f) => f.key)).toEqual([
      'medication',
      'refill_date',
    ]);
    expect(mine?.remind_from).toBe('refill_date');
    expect(mine?.remind_fallback).toBe('expires');
    const theirs = (await kinds(chose)).find((t) => t.key === 'prescription');
    expect((theirs?.fields as Array<{ key: string }>).map((f) => f.key)).toEqual(['medication']);
    expect(theirs?.remind_from).toBe('expires');
    // Its own choice: nothing to fall back on.
    expect(theirs?.remind_fallback).toBeNull();
  });

  it('hides a new built-in for a household with its own of that name, and keeps its own', async () => {
    expect(await hidden(own)).toEqual([
      'advance_directive',
      'explanation_of_benefits',
      'vaccination_record',
    ]);
    expect(await hidden(chose)).toEqual([]);
    expect(await hidden(none)).toEqual([]);
    const ownKinds = await admin.query<{ key: string; label: string }>(
      `select key, label from document_type where household_id = $1 order by key`,
      [own],
    );
    expect(ownKinds.rows.map((r) => r.label)).toEqual([
      'Vaccinations',
      'Living Will',
      'Insurer letters',
      'Gym pass',
      'Lab results',
      'Member card',
      'Test results',
      'Imaging',
      'Insurance card',
    ]);
    // Shown again in Kinds of document, it is offered again.
    const shown = (await kinds(own)).filter((t) => NEW.includes(t.key) && !t.hidden);
    expect(shown.map((t) => t.key)).toEqual(
      NEW.filter(
        (k) => !['advance_directive', 'explanation_of_benefits', 'vaccination_record'].includes(k),
      ),
    );
  });

  it('a yearly review: somebody’s own reminder, every year, one open a document', async () => {
    const doc = await admin.query<{ id: string }>(
      `insert into document (household_id, title, type_key, visibility)
       values ($1, 'Living will', 'advance_directive', 'adults') returning id`,
      [none],
    );
    const id = doc.rows[0]?.id as string;
    const review = (status = 'scheduled') =>
      admin.query(
        `insert into reminder (household_id, document_id, kind, fire_at, recurrence, review, status, note)
         values ($1, $2, 'manual', current_date + 300, 'annual', true, $3, 'Yearly review')`,
        [none, id, status],
      );
    // Every reminder until now is not one.
    const before = await admin.query('select review from reminder where id = $1', [expiryReminder]);
    expect(before.rows).toEqual([{ review: false }]);
    await review();
    await expect(review()).rejects.toThrow(/reminder_one_review/);
    // Done with for good (no longer needed resolves it), another may be set.
    await admin.query(`update reminder set status = 'resolved' where document_id = $1 and review`, [
      id,
    ]);
    await review();
    // Never one made from a date, nor one that does not repeat every year.
    await expect(
      admin.query(
        `insert into reminder (household_id, document_id, kind, source, fire_at, lead_days, review)
         values ($1, $2, 'derived', 'expires', current_date, 0, true)`,
        [none, id],
      ),
    ).rejects.toThrow(/reminder_review/);
    await expect(
      admin.query(
        `insert into reminder (household_id, document_id, kind, fire_at, recurrence, review)
         values ($1, $2, 'manual', current_date, 'monthly', true)`,
        [none, prescription],
      ),
    ).rejects.toThrow(/reminder_review/);
  });
});
