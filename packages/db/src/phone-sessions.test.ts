import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listMigrations, migrateUp } from './migrate.js';
import { createEmptyDatabase, testAdminUrl, type TestDatabase } from './testing.js';

/**
 * Migration 0026: sessions a phone can live with. Sessions already open
 * are given their 180 days from when they began, not from the upgrade:
 * an old session does not get a longer life because the vault was updated.
 */
describe.skipIf(!testAdminUrl())('migration 0026: phone sessions', () => {
  let tdb: TestDatabase;
  let admin: pg.Pool;
  let dir: string;
  const old = randomUUID();
  const recent = randomUUID();

  beforeAll(async () => {
    tdb = await createEmptyDatabase();
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    dir = await mkdtemp(path.join(tmpdir(), 'fdv-0025-'));
    for (const m of await listMigrations()) {
      if (m.version <= 25) await copyFile(m.file, path.join(dir, path.basename(m.file)));
    }
    await migrateUp(admin, dir);
    const hh = randomUUID();
    const account = randomUUID();
    await admin.query("insert into household (id, name) values ($1, 'Sessions')", [hh]);
    await admin.query("insert into account (id, email) values ($1, 'sessions@example.test')", [
      account,
    ]);
    const session = (id: string, age: string) =>
      admin.query(
        `insert into session (id, account_id, household_id, refresh_hash, created_at, expires_at)
         values ($1, $2, $3, gen_random_bytes(32), now() - $4::interval, now() + interval '20 days')`,
        [id, account, hh, age],
      );
    await session(old, '200 days');
    await session(recent, '1 day');
  }, 60_000);
  afterAll(async () => {
    await admin?.end();
    await tdb?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('gives open sessions their 180 days from when they began, and no installation', async () => {
    await migrateUp(admin);
    const rows = new Map(
      (
        await admin.query<{
          id: string;
          lifetime_days: number;
          installation_id: string | null;
          grace_used_at: Date | null;
        }>(
          `select id, extract(epoch from absolute_expires_at - created_at) / 86400 as lifetime_days,
                  installation_id, grace_used_at
             from session`,
        )
      ).rows.map((r) => [r.id, r]),
    );
    expect(Number(rows.get(old)?.lifetime_days)).toBeCloseTo(180, 5);
    expect(Number(rows.get(recent)?.lifetime_days)).toBeCloseTo(180, 5);
    expect(rows.get(recent)).toMatchObject({ installation_id: null, grace_used_at: null });
  });

  it('a session past its 180 days is past them: its next refresh ends it', async () => {
    const r = await admin.query<{ past: boolean }>(
      'select absolute_expires_at < now() as past from session where id = $1',
      [old],
    );
    expect(r.rows[0]?.past).toBe(true);
  });
});
