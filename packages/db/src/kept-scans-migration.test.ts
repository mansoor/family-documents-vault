import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listMigrations, migrateUp } from './migrate.js';
import { createEmptyDatabase, testAdminUrl, type TestDatabase } from './testing.js';

/**
 * Migration 0076 (0.9.0, O1): a household that had the scanner folder set
 * up before the upgrade keeps its scans for 0 days — deleted at once, as
 * before 0.9.0 — while a setting made from then on keeps them 7 (the
 * owner's decision of 18 Oct).
 */
describe.skipIf(!testAdminUrl())('migration 0076: kept scans after the upgrade', () => {
  let tdb: TestDatabase;
  let admin: pg.Pool;
  let dir: string;
  const before = { on: randomUUID(), off: randomUUID() };
  const after = randomUUID();

  beforeAll(async () => {
    tdb = await createEmptyDatabase();
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    // 0.9.0-dev.1's schema, with the scanner folder (0068) and no 0076.
    dir = await mkdtemp(path.join(tmpdir(), 'fdv-0075-'));
    for (const m of await listMigrations()) {
      if (m.version < 76) await copyFile(m.file, path.join(dir, path.basename(m.file)));
    }
    await migrateUp(admin, dir);
    for (const [hh, on] of [
      [before.on, true],
      [before.off, false],
    ] as const) {
      await admin.query("insert into household (id, name) values ($1, 'Scanning')", [hh]);
      await admin.query('insert into watch_folder (household_id, enabled) values ($1, $2)', [
        hh,
        on,
      ]);
    }
    // And now 0076, as an upgrade runs it.
    for (const m of await listMigrations()) {
      if (m.version >= 76) await copyFile(m.file, path.join(dir, path.basename(m.file)));
    }
    await migrateUp(admin, dir);
    await admin.query("insert into household (id, name) values ($1, 'New')", [after]);
    await admin.query('insert into watch_folder (household_id, enabled) values ($1, false)', [
      after,
    ]);
  }, 120_000);

  afterAll(async () => {
    await admin?.end();
    await tdb?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('a setting from before keeps scans 0 days, one made since 7', async () => {
    const days = async (hh: string) =>
      (
        await admin.query<{ keep_days: number }>(
          'select keep_days from watch_folder where household_id = $1',
          [hh],
        )
      ).rows[0]?.keep_days;
    expect(await days(before.on)).toBe(0);
    expect(await days(before.off)).toBe(0);
    expect(await days(after)).toBe(7);
  });
});
