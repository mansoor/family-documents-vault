import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendAudit } from './audit.js';
import { createDb, type Db } from './client.js';
import { listMigrations, migrateUp } from './migrate.js';
import { createEmptyDatabase, testAdminUrl, type TestDatabase } from './testing.js';

/**
 * Migration 0023 and the requests that ended before it.
 *
 * Until 0.4.7 a withdrawn request was written down as refused, and a
 * request about somebody who stepped down stayed live. The migration tells
 * the withdrawals apart by the audit log — each one appended
 * 'owner_change.withdrawn' against the request — and closes what stepping
 * down left open.
 */
describe.skipIf(!testAdminUrl())('migration 0023: requests that ended before it', () => {
  let tdb: TestDatabase;
  let admin: pg.Pool;
  let db: Db;
  let dir: string;
  const hh = randomUUID();
  const ids = {
    withdrawn: randomUUID(),
    refused: randomUUID(),
    steppedDown: randomUUID(),
    live: randomUUID(),
  };
  const account: Record<'one' | 'two' | 'three', string> = { one: '', two: '', three: '' };
  const withdrawnAt = new Date(Date.now() - 5 * 864e5);

  beforeAll(async () => {
    tdb = await createEmptyDatabase();
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 2 });
    db = createDb(new pg.Pool({ connectionString: tdb.adminUrl, max: 1 }));
    // 0.4.6's schema.
    dir = await mkdtemp(path.join(tmpdir(), 'fdv-0022-'));
    for (const m of await listMigrations()) {
      if (m.version <= 22) await copyFile(m.file, path.join(dir, path.basename(m.file)));
    }
    await migrateUp(admin, dir);

    await admin.query("insert into household (id, name) values ($1, 'Ended')", [hh]);
    // One and Two are owners; Three was one, and stepped down.
    for (const [name, role] of [
      ['one', 'owner'],
      ['two', 'owner'],
      ['three', 'adult'],
    ] as const) {
      const m = await admin.query<{ id: string }>(
        'insert into member (household_id, display_name) values ($1, $2) returning id',
        [hh, name],
      );
      const a = await admin.query<{ id: string }>(
        'insert into account (email) values ($1) returning id',
        [`${name}-${hh}@example.test`],
      );
      account[name] = a.rows[0]?.id as string;
      await admin.query(
        'insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, $4)',
        [account[name], hh, m.rows[0]?.id, role],
      );
    }
    const request = (id: string, target: string, by: string, refusedAt: Date | null) =>
      admin.query(
        `insert into owner_change_request
           (id, household_id, target_account, requested_by, action, requested_at,
            opens_at, lapses_at, refused_at)
         values ($1, $2, $3, $4, 'demote', now() - interval '6 days',
                 now() + interval '1 day', now() + interval '24 days', $5)`,
        [id, hh, target, by, refusedAt],
      );
    // About Two: withdrawn by One, which 0.4.6 recorded as refused_at.
    await request(ids.withdrawn, account.two, account.one, withdrawnAt);
    await appendAudit(db, {
      householdId: hh,
      actorAccountId: account.one,
      action: 'owner_change.withdrawn',
      objectType: 'owner_change_request',
      objectId: ids.withdrawn,
    });
    // About Two again: this time Two did refuse it.
    await request(ids.refused, account.two, account.one, new Date());
    await appendAudit(db, {
      householdId: hh,
      actorAccountId: account.two,
      action: 'owner_change.refused',
      objectType: 'owner_change_request',
      objectId: ids.refused,
    });
    // About Three, who stepped down while it was waiting: still live.
    await request(ids.steppedDown, account.three, account.one, null);
    // About One, still an owner: live, and staying so.
    await request(ids.live, account.one, account.two, null);

    await migrateUp(admin);
  }, 60_000);
  afterAll(async () => {
    await db?.destroy();
    await admin?.end();
    await tdb?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const row = async (id: string) =>
    (
      await admin.query<{
        refused_at: Date | null;
        withdrawn_at: Date | null;
        withdrawn_by: string | null;
        withdrawn_why: string | null;
      }>(
        'select refused_at, withdrawn_at, withdrawn_by, withdrawn_why from owner_change_request where id = $1',
        [id],
      )
    ).rows[0];

  it('a withdrawal recorded as a refusal becomes a withdrawal, by whoever withdrew it', async () => {
    expect(await row(ids.withdrawn)).toEqual({
      refused_at: null,
      withdrawn_at: withdrawnAt,
      withdrawn_by: account.one,
      withdrawn_why: 'withdrawn',
    });
  });

  it('a real refusal stays a refusal', async () => {
    expect(await row(ids.refused)).toMatchObject({ withdrawn_at: null, withdrawn_why: null });
    expect((await row(ids.refused))?.refused_at).not.toBeNull();
  });

  it('a request about somebody who stepped down is closed as that', async () => {
    expect(await row(ids.steppedDown)).toMatchObject({
      refused_at: null,
      withdrawn_by: account.three,
      withdrawn_why: 'stepped_down',
    });
  });

  it('a request about an owner is left alone', async () => {
    expect(await row(ids.live)).toEqual({
      refused_at: null,
      withdrawn_at: null,
      withdrawn_by: null,
      withdrawn_why: null,
    });
  });

  it('an ending always says why', async () => {
    await expect(
      admin.query('update owner_change_request set withdrawn_at = now() where id = $1', [ids.live]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
