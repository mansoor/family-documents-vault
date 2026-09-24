import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listMigrations, migrateUp } from './migrate.js';
import { createEmptyDatabase, testAdminUrl, type TestDatabase } from './testing.js';

/**
 * Migration 0022 and the requests that lapsed before it.
 *
 * A vault upgraded from 0.4.5 may hold a request that lapsed while nothing
 * recorded lapses: still "live" to the one-live-request index, so asking
 * about that person again failed. The migration records those as lapsed,
 * which is what lets the vault ask again.
 */
describe.skipIf(!testAdminUrl())('migration 0022: requests that lapsed before it', () => {
  let tdb: TestDatabase;
  let admin: pg.Pool;
  let dir: string;
  const hh = randomUUID();
  const ids = { lapsed: randomUUID(), live: randomUUID() };
  let one = '';
  let two = '';

  beforeAll(async () => {
    tdb = await createEmptyDatabase();
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    // 0.4.5's schema.
    dir = await mkdtemp(path.join(tmpdir(), 'fdv-0021-'));
    for (const m of await listMigrations()) {
      if (m.version <= 21) await copyFile(m.file, path.join(dir, path.basename(m.file)));
    }
    await migrateUp(admin, dir);

    await admin.query("insert into household (id, name) values ($1, 'Lapsed')", [hh]);
    const accounts: string[] = [];
    for (const name of ['One', 'Two']) {
      const m = await admin.query<{ id: string }>(
        'insert into member (household_id, display_name) values ($1, $2) returning id',
        [hh, name],
      );
      const a = await admin.query<{ id: string }>(
        'insert into account (email) values ($1) returning id',
        [`${name.toLowerCase()}-${hh}@example.test`],
      );
      accounts.push(a.rows[0]?.id as string);
      await admin.query(
        "insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, 'owner')",
        [a.rows[0]?.id, hh, m.rows[0]?.id],
      );
    }
    [one, two] = accounts as [string, string];
    // About Two: asked forty days ago, never carried out, never refused.
    await admin.query(
      `insert into owner_change_request
         (id, household_id, target_account, requested_by, action, requested_at, opens_at, lapses_at)
       values ($1, $2, $3, $4, 'demote', now() - interval '40 days',
               now() - interval '33 days', now() - interval '10 days')`,
      [ids.lapsed, hh, two, one],
    );
    // About One: asked yesterday, still running.
    await admin.query(
      `insert into owner_change_request
         (id, household_id, target_account, requested_by, action, requested_at, opens_at, lapses_at)
       values ($1, $2, $3, $4, 'demote', now() - interval '1 day',
               now() + interval '6 days', now() + interval '29 days')`,
      [ids.live, hh, one, two],
    );
  }, 60_000);
  afterAll(async () => {
    await admin?.end();
    await tdb?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const ask = (target: string, by: string) =>
    admin.query(
      `insert into owner_change_request
         (household_id, target_account, requested_by, action, opens_at, lapses_at)
       values ($1, $2, $3, 'demote', now() + interval '7 days', now() + interval '30 days')`,
      [hh, target, by],
    );

  it('before it, the lapsed request still blocks asking again', async () => {
    await expect(ask(two, one)).rejects.toMatchObject({ code: '23505' });
  });

  it('records the lapse, and only that one', async () => {
    await migrateUp(admin);
    const { rows } = await admin.query<{ id: string; lapsed: boolean; refused_at: Date | null }>(
      `select id, lapsed_at is not null and lapsed_at = lapses_at as lapsed, refused_at
         from owner_change_request order by requested_at`,
    );
    expect(rows).toEqual([
      { id: ids.lapsed, lapsed: true, refused_at: null },
      { id: ids.live, lapsed: false, refused_at: null },
    ]);
  });

  it('after it, the person can be asked about again — once', async () => {
    await expect(ask(two, one)).resolves.toBeDefined();
    await expect(ask(two, one)).rejects.toMatchObject({ code: '23505' });
    // The request still running is still the only one about One.
    await expect(ask(one, two)).rejects.toMatchObject({ code: '23505' });
  });
});
