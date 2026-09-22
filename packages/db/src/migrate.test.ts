import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listMigrations, migrateUp, migrationStatus, MIGRATIONS_DIR } from './migrate.js';
import { createTestDatabase, testAdminUrl, type TestDatabase } from './testing.js';

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
