import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, createPool, withSystem, type Db } from './client.js';
import {
  assertSchemaKnown,
  listMigrations,
  migrateUp,
  migrationStatus,
  MIGRATIONS_DIR,
} from './migrate.js';
import {
  createEmptyDatabase,
  createTestDatabase,
  testAdminUrl,
  type TestDatabase,
} from './testing.js';
import { typeEtag, type EffectiveType } from './type-etag.js';

describe('listMigrations', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'fdv-mig-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('orders by version and ignores files that do not match the naming rule', async () => {
    await writeFile(path.join(dir, '0002_second.sql'), 'select 2;');
    await writeFile(path.join(dir, '0001_first.sql'), 'select 1;');
    await writeFile(path.join(dir, 'README.md'), 'not a migration');
    await writeFile(path.join(dir, '0003-bad-name.sql'), 'select 3;');
    const list = await listMigrations(dir);
    expect(list.map((m) => `${m.version}_${m.name}`)).toEqual(['1_first', '2_second']);
  });

  it('refuses duplicate version numbers', async () => {
    await writeFile(path.join(dir, '0001_a.sql'), 'select 1;');
    await writeFile(path.join(dir, '0001_b.sql'), 'select 1;');
    await expect(listMigrations(dir)).rejects.toThrow(/duplicate migration version 1/);
  });

  it('the real migrations directory is well-formed', async () => {
    const list = await listMigrations(MIGRATIONS_DIR);
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]?.version).toBe(1);
  });
});

describe.skipIf(!testAdminUrl())('migrateUp against PostgreSQL', () => {
  let db: TestDatabase;
  let pool: pg.Pool;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new pg.Pool({ connectionString: db.adminUrl, max: 2 });
  });
  afterAll(async () => {
    await pool.end();
    await db.drop();
  });

  it('applied every migration exactly once and is idempotent', async () => {
    const before = await migrationStatus(pool);
    expect(before.pending).toEqual([]);
    expect(before.applied.length).toBeGreaterThan(0);

    const again = await migrateUp(pool);
    expect(again).toEqual([]);

    const { rows } = await pool.query<{ n: string }>(
      'select count(*)::text as n from schema_migration',
    );
    expect(Number(rows[0]?.n)).toBe(before.applied.length);
  });

  it("every view reads with the caller's rights, behind the household's wall", async () => {
    const { rows } = await pool.query<{ view: string; invoker: boolean }>(
      `select c.relname as view,
              coalesce((select o.option_value in ('true', 'on', '1')
                          from pg_options_to_table(c.reloptions) o
                         where o.option_name = 'security_invoker'), false) as invoker
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'v'`,
    );
    // There is one at least (0031's types in effect), and none reads as its
    // owner: `create or replace view` without the option would drop it.
    expect(rows.map((r) => r.view)).toContain('effective_document_type');
    expect(rows.filter((r) => !r.invoker)).toEqual([]);
  });

  it('the application only reads the migrations and the shared suggestion rules', async () => {
    const app = new pg.Pool({ connectionString: db.appUrl, max: 1 });
    try {
      for (const write of [
        "insert into schema_migration (version, name) values (9998, 'slipped_in')",
        'delete from schema_migration where version = 1',
        "update suggestion_rule set scope = 'household'",
        'delete from suggestion_rule',
      ]) {
        await expect(app.query(write), write).rejects.toThrow(/permission denied/);
      }
      await expect(app.query('select count(*) from suggestion_rule')).resolves.toBeTruthy();
    } finally {
      await app.end();
    }
  });

  it('refuses a database a newer release has upgraded, and says what to do', async () => {
    const app = new pg.Pool({ connectionString: db.appUrl, max: 1 });
    try {
      // The application role can ask, as the API does when it does not migrate.
      await expect(assertSchemaKnown(app)).resolves.toBeUndefined();

      await pool.query(
        "insert into schema_migration (version, name) values (9999, 'from_a_newer_release')",
      );
      try {
        await expect(migrateUp(pool)).rejects.toThrow(
          /upgraded by a newer release of the vault \(database schema 9999\).*restore the backup taken before the upgrade/,
        );
        await expect(assertSchemaKnown(app)).rejects.toThrow(/only knows schema/);
      } finally {
        await pool.query('delete from schema_migration where version = 9999');
      }
      await expect(assertSchemaKnown(app)).resolves.toBeUndefined();
    } finally {
      await app.end();
    }
  });

  it('does not refuse a new, empty database', async () => {
    const empty = await createEmptyDatabase();
    const p = new pg.Pool({ connectionString: empty.adminUrl, max: 1 });
    try {
      await expect(assertSchemaKnown(p)).resolves.toBeUndefined();
    } finally {
      await p.end();
      await empty.drop();
    }
    // Making a database waits its turn on the cluster-wide setup lock.
  }, 30_000);

  it('created the application role without table ownership', async () => {
    const { rows } = await pool.query<{ rolname: string; rolsuper: boolean }>(
      "select rolname, rolsuper from pg_roles where rolname = 'fdv_app'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rolsuper).toBe(false);

    const owned = await pool.query<{ tablename: string }>(
      "select tablename from pg_tables where tableowner = 'fdv_app'",
    );
    expect(owned.rows).toEqual([]);
  });

  it('a failing migration is rolled back and not recorded', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fdv-mig-'));
    try {
      await writeFile(
        path.join(dir, '9001_breaks.sql'),
        'create table should_not_exist (id int); select 1/0;',
      );
      await expect(migrateUp(pool, dir)).rejects.toThrow(/migration 9001_breaks failed/);
      const t = await pool.query("select 1 from pg_tables where tablename = 'should_not_exist'");
      expect(t.rowCount).toBe(0);
      const s = await pool.query('select 1 from schema_migration where version = 9001');
      expect(s.rowCount).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Migration 0038: which date a kind reminds from, and which date each
 * reminder is about. Older phones read `effective_document_type` through
 * GET /document-types, and edit a kind with the ETag it had: every
 * existing kind must read, and be tagged, exactly as before, or every
 * phone and browser would be told to load it again at the upgrade.
 */
describe.skipIf(!testAdminUrl())('migration 0038: reminders from any date', () => {
  let tdb: TestDatabase;
  let admin: pg.Pool;
  let app: Db;
  let dir: string;
  /** Untouched: every built-in as the vault ships it. */
  const plain = randomUUID();
  /** A household that changed several built-ins, and has kinds of its own. */
  const changed = randomUUID();
  const ids = { doc: randomUUID(), r270: randomUUID(), r180: randomUUID(), manual: randomUUID() };
  const before = new Map<string, EffectiveType[]>();
  let ledger: unknown[] = [];

  /** The household's kinds as the vault reads them: through the view, in its household. */
  const kinds = (hh: string) =>
    withSystem(app, hh, (trx) =>
      trx.selectFrom('effective_document_type').selectAll().orderBy('key').execute(),
    ) as Promise<EffectiveType[]>;

  beforeAll(async () => {
    tdb = await createEmptyDatabase();
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    // 0.5.14's schema.
    dir = await mkdtemp(path.join(tmpdir(), 'fdv-0037-'));
    for (const m of await listMigrations()) {
      if (m.version <= 37) await copyFile(m.file, path.join(dir, path.basename(m.file)));
    }
    await migrateUp(admin, dir);
    app = createDb(createPool(tdb.appUrl, 2));

    for (const [id, name] of [
      [plain, 'As shipped'],
      [changed, 'Changed'],
    ]) {
      await admin.query('insert into household (id, name) values ($1, $2)', [id, name]);
    }
    // Kinds of the household's own: one with Expires off (its lead times
    // kept, as a household's are), one that expires, 60 days before.
    await admin.query(
      `insert into document_type (key, household_id, label, category, fields, expiry_driver, reminder_leads)
       values ('h_aaaaaaaaaa', $1, 'Gym pass', 'other', '[]', null, '{30}'),
              ('h_bbbbbbbbbb', $1, 'Allotment', 'property', '[]', 'expires_on', '{60}')`,
      [changed],
    );
    // Built-ins the household changed: Expires hidden on a passport, the
    // lead times emptied on a licence, a birth certificate made to expire,
    // a visa's lead times its own, and an ID shown Expires with none.
    await admin.query(
      `insert into document_type_setting (household_id, type_key, core, reminder_leads) values
         ($1, 'passport', '{"expires": {"shown": false}}', null),
         ($1, 'drivers_licence', '{}', '{}'),
         ($1, 'birth_certificate', '{"expires": {"shown": true}}', '{30}'),
         ($1, 'visa', '{}', '{90,10}'),
         ($1, 'national_id', '{"expires": {"shown": true}}', null)`,
      [changed],
    );
    // A passport with its two reminders, one already sent, and one set by hand.
    await admin.query(
      `insert into document (id, household_id, type_key, title, expires_on, expires_precision)
       values ($1, $2, 'passport', 'Passport', '2027-06-30', 'day')`,
      [ids.doc, plain],
    );
    await admin.query(
      `insert into reminder (id, household_id, document_id, kind, fire_at, lead_days, status) values
         ($1, $3, $4, 'derived', '2026-10-03', 270, 'due'),
         ($2, $3, $4, 'derived', '2027-01-01', 180, 'scheduled')`,
      [ids.r270, ids.r180, plain, ids.doc],
    );
    await admin.query(
      `insert into reminder (id, household_id, document_id, kind, fire_at, note)
       values ($1, $2, $3, 'manual', '2026-12-01', 'Book the photo')`,
      [ids.manual, plain, ids.doc],
    );
    await admin.query(
      `insert into reminder_delivery (reminder_id, household_id, fire_date, channel)
       values ($1, $2, '2026-10-03', 'push'), ($1, $2, '2026-10-03', 'email')`,
      [ids.r270, plain],
    );
    ledger = (await admin.query('select * from reminder_delivery order by channel')).rows;
    for (const hh of [plain, changed]) before.set(hh, await kinds(hh));

    await migrateUp(admin);
  }, 60_000);
  afterAll(async () => {
    await app?.destroy();
    await admin?.end();
    await tdb?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("every existing kind's view row and etag are exactly as before 0038", async () => {
    for (const hh of [plain, changed]) {
      const was = before.get(hh) as EffectiveType[];
      const now = await kinds(hh);
      // The columns 0038 appends aside, every row is as it was, byte for byte…
      const old = (t: EffectiveType) =>
        Object.fromEntries(
          Object.entries(t).filter(([k]) => k !== 'remind_from' && k !== 'remind_leads'),
        );
      expect(now.map(old)).toEqual(was);
      expect(Object.keys(now[0] ?? {})).toEqual([
        ...Object.keys(was[0] ?? {}),
        'remind_from',
        'remind_leads',
      ]);
      // …and so is every ETag: nobody is asked to load a kind again.
      expect(now.map(typeEtag)).toEqual(was.map(typeEtag));
    }
    const kind = async (hh: string, key: string) => (await kinds(hh)).find((t) => t.key === key);
    const says = (t: EffectiveType | undefined) =>
      t && {
        expiry_driver: t.expiry_driver,
        reminder_leads: t.reminder_leads,
        remind_from: t.remind_from,
        remind_leads: t.remind_leads,
      };
    // As shipped: a passport nine and six months before; the Will on its
    // review day; a bill 7 days and 1 day before; a birth certificate never.
    expect(says(await kind(plain, 'passport'))).toEqual({
      expiry_driver: 'expires_on',
      reminder_leads: [270, 180],
      remind_from: 'expires',
      remind_leads: [270, 180],
    });
    expect(says(await kind(plain, 'will'))).toEqual({
      expiry_driver: 'review_on',
      reminder_leads: [0],
      remind_from: 'expires',
      remind_leads: [0],
    });
    expect(says(await kind(plain, 'utility_bill'))).toMatchObject({
      reminder_leads: [7, 1],
      remind_from: 'expires',
    });
    expect(says(await kind(plain, 'birth_certificate'))).toEqual({
      expiry_driver: null,
      reminder_leads: [],
      remind_from: null,
      remind_leads: [],
    });
    // Changed by the household: whatever it did, the same answer as before,
    // and reminding exactly where it reminded.
    expect(says(await kind(changed, 'h_aaaaaaaaaa'))).toEqual({
      expiry_driver: null,
      reminder_leads: [30],
      remind_from: null,
      remind_leads: [30],
    });
    expect(says(await kind(changed, 'h_bbbbbbbbbb'))).toMatchObject({ remind_from: 'expires' });
    expect(says(await kind(changed, 'passport'))).toEqual({
      expiry_driver: null,
      reminder_leads: [270, 180],
      remind_from: null,
      remind_leads: [270, 180],
    });
    expect(says(await kind(changed, 'drivers_licence'))).toMatchObject({
      expiry_driver: 'expires_on',
      reminder_leads: [],
      remind_from: null,
    });
    expect(says(await kind(changed, 'birth_certificate'))).toEqual({
      expiry_driver: 'expires_on',
      reminder_leads: [30],
      remind_from: 'expires',
      remind_leads: [30],
    });
    expect(says(await kind(changed, 'visa'))).toMatchObject({
      reminder_leads: [90, 10],
      remind_from: 'expires',
    });
    expect(says(await kind(changed, 'national_id'))).toMatchObject({
      expiry_driver: 'expires_on',
      reminder_leads: [],
      remind_from: null,
    });
    // A setting says so only where it differs from its built-in.
    const { rows } = await admin.query<{ type_key: string; remind_from: string | null }>(
      'select type_key, remind_from from document_type_setting where household_id = $1 order by type_key',
      [changed],
    );
    expect(rows).toEqual([
      { type_key: 'birth_certificate', remind_from: 'expires' },
      { type_key: 'drivers_licence', remind_from: 'none' },
      { type_key: 'national_id', remind_from: null },
      { type_key: 'passport', remind_from: 'none' },
      { type_key: 'visa', remind_from: null },
    ]);
    // The library has Due date, a date, for every household.
    const due = await admin.query(
      "select household_id, label, kind from document_attribute where key = 'due_date'",
    );
    expect(due.rows).toEqual([{ household_id: null, label: 'Due date', kind: 'date' }]);
  });

  it('existing derived reminders keep their ids, are about Expires, and are not sent again', async () => {
    const { rows } = await admin.query<{ id: string; kind: string; source: string | null }>(
      'select id, kind, source from reminder order by fire_at',
    );
    expect(rows).toEqual([
      { id: ids.r270, kind: 'derived', source: 'expires' },
      { id: ids.manual, kind: 'manual', source: null },
      { id: ids.r180, kind: 'derived', source: 'expires' },
    ]);
    // Each keeps its lines in the ledger, by its own id: the digest, which
    // sends only a reminder with none, does not send it again.
    expect((await admin.query('select * from reminder_delivery order by channel')).rows).toEqual(
      ledger,
    );
  });

  it('a derived reminder must say which date it is about; a manual one must not', async () => {
    const add = (kind: string, source: string | null) =>
      admin.query(
        `insert into reminder (household_id, document_id, kind, fire_at, lead_days, source)
         values ($1, $2, $3, '2027-02-01', 7, $4)`,
        [plain, ids.doc, kind, source],
      );
    await expect(add('derived', null)).rejects.toThrow(/reminder_source/);
    await expect(add('manual', 'expires')).rejects.toThrow(/reminder_source/);
    await expect(add('derived', 'Due Date')).rejects.toThrow(/reminder_source/);
    await expect(add('derived', 'due_date')).resolves.toBeTruthy();
    await expect(add('manual', null)).resolves.toBeTruthy();
    // A kind reminding from a date needs lead times for it; a setting's
    // "off" is a word of its own.
    await expect(
      admin.query(
        "update document_type set remind_from = 'h_zzzzzzzzzz', reminder_leads = '{}' where key = 'h_bbbbbbbbbb'",
      ),
    ).rejects.toThrow(/document_type_remind_from/);
    await expect(
      admin.query(
        "update document_type_setting set remind_from = 'Off' where household_id = $1 and type_key = 'visa'",
        [changed],
      ),
    ).rejects.toThrow(/document_type_setting_remind_from/);
  });
});
