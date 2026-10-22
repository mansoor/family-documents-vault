import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listMigrations, migrateUp } from './migrate.js';
import { createEmptyDatabase, testAdminUrl, type TestDatabase } from './testing.js';

/**
 * Migration 0077 (0.9.0, C1): a household that already keeps a kind of its
 * own called "Payslip" or "Investment statement" goes on using it, the new
 * built-in hidden for it; a household with none has both new kinds shown,
 * and the bank's own kind is called "Bank statement".
 */
describe.skipIf(!testAdminUrl())('migration 0077: the new kinds beside a household’s own', () => {
  let tdb: TestDatabase;
  let admin: pg.Pool;
  let dir: string;
  const own = randomUUID();
  const none = randomUUID();

  beforeAll(async () => {
    tdb = await createEmptyDatabase();
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    dir = await mkdtemp(path.join(tmpdir(), 'fdv-0076-'));
    for (const m of await listMigrations()) {
      if (m.version < 77) await copyFile(m.file, path.join(dir, path.basename(m.file)));
    }
    await migrateUp(admin, dir);
    for (const [id, name] of [
      [own, 'Keeps its own'],
      [none, 'Keeps none'],
    ]) {
      await admin.query('insert into household (id, name) values ($1, $2)', [id, name]);
    }
    await admin.query(
      `insert into document_type (key, household_id, label, category, fields, expiry_driver, reminder_leads)
       values ('h_aaaaaaaaaa', $1, 'Payslip', 'financial', '[]', null, '{}'),
              ('h_bbbbbbbbbb', $1, 'Investment Statements', 'financial', '[]', null, '{}'),
              ('h_cccccccccc', $1, 'Gym pass', 'other', '[]', null, '{}')`,
      [own],
    );
    await migrateUp(admin);
  }, 120_000);
  afterAll(async () => {
    await admin?.end();
    await tdb?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const hidden = async (household: string) =>
    (
      await admin.query<{ type_key: string }>(
        `select type_key from document_type_setting where household_id = $1 and hidden order by 1`,
        [household],
      )
    ).rows.map((r) => r.type_key);

  it('hides the new built-ins for a household with its own of the same name, and keeps its own', async () => {
    expect(await hidden(own)).toEqual(['investment_statement', 'pay_statement']);
    expect(await hidden(none)).toEqual([]);
    const ownKinds = await admin.query<{ key: string; archived_at: Date | null }>(
      `select key, archived_at from document_type where household_id = $1 order by key`,
      [own],
    );
    expect(ownKinds.rows).toEqual([
      { key: 'h_aaaaaaaaaa', archived_at: null },
      { key: 'h_bbbbbbbbbb', archived_at: null },
      { key: 'h_cccccccccc', archived_at: null },
    ]);
  });

  it('adds the two kinds and calls the bank’s own what it is', async () => {
    const { rows } = await admin.query<{ key: string; label: string }>(
      `select key, label from document_type
        where household_id is null and key in ('pay_statement', 'investment_statement', 'bank_statement')
        order by key`,
    );
    expect(rows).toEqual([
      { key: 'bank_statement', label: 'Bank statement' },
      { key: 'investment_statement', label: 'Investment statement' },
      { key: 'pay_statement', label: 'Pay statement / payslip' },
    ]);
  });
});
