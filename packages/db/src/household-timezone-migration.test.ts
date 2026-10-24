import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendAudit } from './audit.js';
import { createDb } from './client.js';
import { listMigrations, migrateUp } from './migrate.js';
import { createEmptyDatabase, testAdminUrl, type TestDatabase } from './testing.js';

/**
 * Migration 0080 (0.9.0, TZ): a household's time zone tells "never chosen"
 * (null: the server's FDV_TIMEZONE) from an owner's choice. Before it, the
 * column was 'UTC' unless an owner set another through PUT /profile, which
 * wrote `household.profile_updated` with 'timezone' among its fields: so a
 * 'UTC' with that line is an owner's choice and stays, any other 'UTC'
 * becomes null, and any other zone stays as it was.
 */
describe.skipIf(!testAdminUrl())("migration 0080: the family's time zone after the upgrade", () => {
  let tdb: TestDatabase;
  let admin: pg.Pool;
  let dir: string;
  const hh = {
    untouched: randomUUID(),
    chosenUtc: randomUUID(),
    answeredOnly: randomUUID(),
    london: randomUUID(),
  };
  const after = randomUUID();

  beforeAll(async () => {
    tdb = await createEmptyDatabase();
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    // 0.9.0-dev.8's schema, before 0080.
    dir = await mkdtemp(path.join(tmpdir(), 'fdv-0079-'));
    for (const m of await listMigrations()) {
      if (m.version < 80) await copyFile(m.file, path.join(dir, path.basename(m.file)));
    }
    await migrateUp(admin, dir);
    for (const [id, zone] of [
      [hh.untouched, null],
      [hh.chosenUtc, 'UTC'],
      [hh.answeredOnly, null],
      [hh.london, 'Europe/London'],
    ] as const) {
      await admin.query(
        zone
          ? 'insert into household (id, name, timezone) values ($1, $2, $3)'
          : 'insert into household (id, name) values ($1, $2)',
        zone ? [id, 'Before', zone] : [id, 'Before'],
      );
    }
    const db = createDb(admin);
    // An owner who set UTC through the API, as the README said to.
    await appendAudit(db, {
      householdId: hh.chosenUtc,
      action: 'household.profile_updated',
      detail: { fields: ['timezone'] },
    });
    // The household's questions answered, and no time zone among them.
    await appendAudit(db, {
      householdId: hh.answeredOnly,
      action: 'household.profile_updated',
      detail: { fields: ['owns_home', 'has_pets'] },
    });
    const zones = await admin.query<{ timezone: string }>('select timezone from household');
    // Not null, UTC by default, before the upgrade.
    expect(zones.rows.map((r) => r.timezone).sort()).toEqual([
      'Europe/London',
      'UTC',
      'UTC',
      'UTC',
    ]);
    // And now 0080, as an upgrade runs it.
    for (const m of await listMigrations()) {
      if (m.version >= 80) await copyFile(m.file, path.join(dir, path.basename(m.file)));
    }
    await migrateUp(admin, dir);
    await admin.query("insert into household (id, name) values ($1, 'New')", [after]);
  }, 120_000);

  afterAll(async () => {
    await admin?.end();
    await tdb?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const zoneOf = async (id: string) =>
    (
      await admin.query<{ timezone: string | null }>(
        'select timezone from household where id = $1',
        [id],
      )
    ).rows[0]?.timezone;

  it("keeps an owner's choice, UTC included, and makes the default never touched the server's", async () => {
    expect(await zoneOf(hh.untouched)).toBeNull();
    expect(await zoneOf(hh.answeredOnly)).toBeNull();
    expect(await zoneOf(hh.chosenUtc)).toBe('UTC');
    expect(await zoneOf(hh.london)).toBe('Europe/London');
    // A household made since has chosen none.
    expect(await zoneOf(after)).toBeNull();
  });

  it('holds a name to a zone’s length, and the rule on who changes it is there', async () => {
    await expect(
      admin.query('update household set timezone = $2 where id = $1', [after, 'x'.repeat(65)]),
    ).rejects.toThrow(/household_timezone_name/);
    await expect(
      admin.query("update household set timezone = '' where id = $1", [after]),
    ).rejects.toThrow(/household_timezone_name/);
    const rule = await admin.query(
      "select 1 from pg_trigger where tgname = 'household_timezone_rule' and tgenabled = 'O'",
    );
    expect(rule.rowCount).toBe(1);
  });
});
