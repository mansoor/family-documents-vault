import { randomUUID } from 'node:crypto';
import { createDb, createPool, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import { HEALTH_EVENTS } from '@fdv/shared';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OwnersAlert } from '../ai-send.js';
import { installationHousehold, lastTry, noteVaultCheck, noticeHealth } from './vault-health.js';

/**
 * Settings → System health (0.9.0-dev.78), the worker's side: a line in
 * every household's log as it makes a backup, checks the activity log or
 * runs the drill; and the owners emailed once when the backups stop or the
 * check fails, not again until it clears.
 */
describe.skipIf(!testAdminUrl())('system health, from the worker', () => {
  let vault: TestDatabase;
  let admin: pg.Pool;
  let appPool: pg.Pool;
  let db: Db;
  let hh: string;
  let other: string;
  const told: OwnersAlert[] = [];
  const DAY = 24 * 3600_000;
  let offset = 0;

  const notice = (backups = true) =>
    noticeHealth({
      admin,
      db,
      tell: async (a) => void told.push(a),
      lateDays: 2,
      backups,
      now: () => Date.now() + offset,
    });
  const note = async (action: Parameters<typeof noteVaultCheck>[1], ok?: boolean) => {
    await new Promise((r) => setTimeout(r, 5));
    // A check's line in every household's log; a backup's in the installation's.
    await noteVaultCheck({ admin, db }, action, () => (ok === undefined ? {} : { ok }), {
      every: action === HEALTH_EVENTS.auditChecked,
    });
  };
  const lines = async (household: string, action: string) =>
    (
      await admin.query<{ detail: Record<string, unknown>; actor_account_id: string | null }>(
        'select detail, actor_account_id from audit_event where household_id = $1 and action = $2 order by id',
        [household, action],
      )
    ).rows;

  const household = async (name: string) => {
    const id = randomUUID();
    await admin.query("insert into household (id, name, timezone) values ($1, $2, 'UTC')", [
      id,
      name,
    ]);
    const m = await admin.query<{ id: string }>(
      "insert into member (household_id, display_name) values ($1, 'Owner') returning id",
      [id],
    );
    const a = await admin.query<{ id: string }>(
      'insert into account (email) values ($1) returning id',
      [`health-${id}@example.test`],
    );
    await admin.query(
      "insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, 'owner')",
      [a.rows[0]?.id, id, m.rows[0]?.id],
    );
    return { id, owner: a.rows[0]?.id as string };
  };
  let owner = '';

  beforeAll(async () => {
    vault = await createTestDatabase();
    admin = new pg.Pool({ connectionString: vault.adminUrl, max: 2 });
    appPool = createPool(vault.appUrl, 2);
    db = createDb(appPool);
    const one = await household('Healthy');
    hh = one.id;
    owner = one.owner;
    other = (await household('Next door')).id;
  });
  afterAll(async () => {
    await appPool?.end();
    await admin?.end();
    await vault?.drop();
  });
  beforeEach(() => {
    told.length = 0;
    offset = 0;
  });

  it('writes a check’s line in every household’s log, and a backup’s in the installation’s alone', async () => {
    await noteVaultCheck(
      { admin, db },
      HEALTH_EVENTS.auditChecked,
      (id) => (id === hh ? { ok: true } : { ok: false, broken_at: 4 }),
      { every: true },
    );
    expect(await lines(hh, HEALTH_EVENTS.auditChecked)).toEqual([
      { detail: { ok: true }, actor_account_id: null },
    ]);
    expect(await lines(other, HEALTH_EVENTS.auditChecked)).toEqual([
      { detail: { ok: false, broken_at: 4 }, actor_account_id: null },
    ]);
    // The server's: the first household set up, the installation's own.
    expect(await installationHousehold(admin)).toBe(hh);
    await noteVaultCheck({ admin, db }, HEALTH_EVENTS.restoreDrilled, () => ({ ok: true }));
    expect(await lines(hh, HEALTH_EVENTS.restoreDrilled)).toHaveLength(1);
    expect(await lines(other, HEALTH_EVENTS.restoreDrilled)).toEqual([]);
  });

  it('a new vault is told nothing; days on with no backup, its owners are told once', async () => {
    // The check above left next door's log failing its check: told of that.
    expect(await notice()).toBe(1);
    expect(told.map((t) => [t.household_id, t.subject])).toEqual([
      [other, 'Your vault’s activity log failed its check'],
    ]);
    told.length = 0;
    // Nothing more, however often it looks.
    expect(await notice()).toBe(0);
    // Three days on with none made: the installation's owners alone are
    // told of its backups — next door's are not theirs.
    offset = 3 * DAY;
    expect(await notice()).toBe(1);
    expect(told.map((t) => [t.household_id, t.subject])).toEqual([
      [hh, 'Your vault hasn’t made a backup lately'],
    ]);
    expect(told[0]?.account_ids).toEqual([owner]);
    expect(told[0]?.body).toContain('No backup has been made yet.');
    expect(told[0]?.body).toContain('docker compose ps');
    expect(told[0]?.body).toContain('Settings → System health');
    // Once: not again while it stands.
    expect(await notice()).toBe(0);
    expect(await lines(hh, HEALTH_EVENTS.ownersTold)).toEqual([
      { detail: { about: 'backup' }, actor_account_id: null },
    ]);
    expect(await lines(other, HEALTH_EVENTS.ownersTold)).toEqual([
      { detail: { about: 'audit_chain' }, actor_account_id: null },
    ]);
  });

  it('a backup made clears it; the next problem is told again', async () => {
    await note(HEALTH_EVENTS.backupMade);
    expect(await notice()).toBe(0);
    // Its last try failed: told at once, not waiting for it to be late.
    await note(HEALTH_EVENTS.backupFailed);
    expect(await notice()).toBe(1);
    expect(told[0]?.subject).toBe('Your vault’s backup didn’t finish');
    expect(told[0]?.body).toMatch(/The last backup was made on /);
    expect(await notice()).toBe(0);
  });

  it('a check that passes clears its problem; one that fails again is told again', async () => {
    await note(HEALTH_EVENTS.backupMade);
    expect(await notice()).toBe(0);
    await note(HEALTH_EVENTS.auditChecked, true);
    expect(await notice()).toBe(0);
    await note(HEALTH_EVENTS.auditChecked, false);
    expect(await notice()).toBe(2);
    expect(told.map((t) => t.subject)).toEqual([
      'Your vault’s activity log failed its check',
      'Your vault’s activity log failed its check',
    ]);
    expect(told[0]?.body).toContain('changed or missing');
    expect(told[0]?.body).toContain('Restore a backup from before then');
    // Failing again the next night: still the same problem, not told again.
    await note(HEALTH_EVENTS.auditChecked, false);
    expect(await notice()).toBe(0);
  });

  it('on the hosted edition: never told of the backups, and a failed check says to contact whoever runs it', async () => {
    offset = 10 * DAY;
    await note(HEALTH_EVENTS.auditChecked, true);
    expect(await notice(false)).toBe(0);
    await note(HEALTH_EVENTS.auditChecked, false);
    expect(await notice(false)).toBe(2);
    for (const t of told) {
      expect(t.body).toContain('Contact whoever runs your vault.');
      expect(t.body).not.toMatch(/docker|restore a backup/i);
    }
    told.length = 0;
    // Self-hosted again, the late backup is told.
    expect(await notice(true)).toBe(1);
    expect(told[0]?.subject).toBe('Your vault hasn’t made a backup lately');
  });

  it('a backup is said to have failed on its last try alone', () => {
    expect(lastTry({ retryCount: 0, retryLimit: 3 })).toBe(false);
    expect(lastTry({ retryCount: 2, retryLimit: 3 })).toBe(false);
    expect(lastTry({ retryCount: 3, retryLimit: 3 })).toBe(true);
    // Run by hand (cli.mjs backup-now), or with no limit: its only try.
    expect(lastTry(undefined)).toBe(true);
    expect(lastTry({ retryCount: 0, retryLimit: 0 })).toBe(true);
  });
});
