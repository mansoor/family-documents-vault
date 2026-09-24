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
 * Until 0.4.7 a withdrawn request was written down as refused — by an
 * owner withdrawing it, and by a restore from a backup — and a request
 * about somebody who stepped down stayed live. The migration tells the
 * endings apart by the audit log and closes what stepping down left open.
 * The histories here are the ordinary ones: withdraw and ask again,
 * withdraw twice, withdraw and then step down.
 */
describe.skipIf(!testAdminUrl())('migration 0023: requests that ended before it', () => {
  let tdb: TestDatabase;
  let admin: pg.Pool;
  let db: Db;
  let dir: string;
  const hh = randomUUID();
  const ids = {
    withdrawn: randomUUID(),
    withdrawnAgain: randomUUID(),
    refused: randomUUID(),
    askedAfter: randomUUID(),
    restored: randomUUID(),
    withdrawnThenSteppedDown: randomUUID(),
    steppedDown: randomUUID(),
    steppedDownAndBack: randomUUID(),
    lapsedBeforeRestore: randomUUID(),
    live: randomUUID(),
  };
  const account: Record<'one' | 'two' | 'three' | 'four', string> = {
    one: '',
    two: '',
    three: '',
    four: '',
  };
  const daysAgo = (n: number) => new Date(Date.now() - n * 864e5);
  const withdrawnAt = daysAgo(5);

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
    // One and Two are owners; Three was one, and stepped down; Four stepped
    // down and has been made an owner again since.
    for (const [name, role] of [
      ['one', 'owner'],
      ['two', 'owner'],
      ['three', 'adult'],
      ['four', 'owner'],
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
    const audit = (actor: string, action: string, id: string) =>
      appendAudit(db, {
        householdId: hh,
        actorAccountId: actor,
        action,
        objectType: 'owner_change_request',
        objectId: id,
      });

    // About Two: withdrawn by One — twice — and 0.4.6 recorded each as
    // refused_at; asked a third time, and that one is live.
    await request(ids.withdrawn, account.two, account.one, withdrawnAt);
    await audit(account.one, 'owner_change.withdrawn', ids.withdrawn);
    await request(ids.withdrawnAgain, account.two, account.one, daysAgo(3));
    await audit(account.one, 'owner_change.withdrawn', ids.withdrawnAgain);
    await request(ids.askedAfter, account.two, account.one, null);
    // About Two again: this one Two did refuse.
    await request(ids.refused, account.two, account.one, daysAgo(2));
    await audit(account.two, 'owner_change.refused', ids.refused);
    // About Two: ended by a 0.4.5 restore, which wrote refused_at and no
    // audit event.
    await request(ids.restored, account.two, account.one, daysAgo(1));
    // About Three: withdrawn by One, and later Three stepped down.
    await request(ids.withdrawnThenSteppedDown, account.three, account.one, daysAgo(4));
    await audit(account.one, 'owner_change.withdrawn', ids.withdrawnThenSteppedDown);
    // About Three, who stepped down while it was waiting: still live.
    await request(ids.steppedDown, account.three, account.one, null);
    // About Four: asked, then Four stepped down (the audit log has it),
    // then Four was made an owner again. Stepping down closes it now.
    await request(ids.steppedDownAndBack, account.four, account.one, null);
    await audit(account.four, 'member.stepped_down', ids.steppedDownAndBack);
    // About One: lapsed long ago, and a 0.4.5 restore then wrote refused_at
    // on it anyway.
    await admin.query(
      `insert into owner_change_request
         (id, household_id, target_account, requested_by, action, requested_at,
          opens_at, lapses_at, refused_at)
       values ($1, $2, $3, $4, 'demote', now() - interval '90 days',
               now() - interval '83 days', now() - interval '60 days', now() - interval '1 day')`,
      [ids.lapsedBeforeRestore, hh, account.one, account.two],
    );
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
    expect(await row(ids.withdrawnAgain)).toMatchObject({
      refused_at: null,
      withdrawn_by: account.one,
      withdrawn_why: 'withdrawn',
    });
  });

  it('a request asked after a withdrawal is still the live one', async () => {
    expect(await row(ids.askedAfter)).toEqual({
      refused_at: null,
      withdrawn_at: null,
      withdrawn_by: null,
      withdrawn_why: null,
    });
  });

  it('a real refusal stays a refusal', async () => {
    expect(await row(ids.refused)).toMatchObject({ withdrawn_at: null, withdrawn_why: null });
    expect((await row(ids.refused))?.refused_at).not.toBeNull();
  });

  it('a request a restore ended is recorded as that, not as a refusal', async () => {
    expect(await row(ids.restored)).toMatchObject({
      refused_at: null,
      withdrawn_by: null,
      withdrawn_why: 'restored',
    });
  });

  it('a request about somebody who stepped down is closed as that', async () => {
    expect(await row(ids.steppedDown)).toMatchObject({
      refused_at: null,
      withdrawn_by: account.three,
      withdrawn_why: 'stepped_down',
    });
  });

  it('a request whose subject stepped down and came back is closed as of the step-down', async () => {
    const stepped = (
      await admin.query<{ at: Date }>(
        "select at from audit_event where action = 'member.stepped_down' and actor_account_id = $1",
        [account.four],
      )
    ).rows[0]?.at;
    expect(await row(ids.steppedDownAndBack)).toEqual({
      refused_at: null,
      withdrawn_at: stepped,
      withdrawn_by: account.four,
      withdrawn_why: 'stepped_down',
    });
  });

  it('a request that had lapsed before a restore wrote refused_at on it is a lapse', async () => {
    const { rows } = await admin.query<{ lapsed: boolean }>(
      'select lapsed_at = lapses_at as lapsed from owner_change_request where id = $1',
      [ids.lapsedBeforeRestore],
    );
    expect(rows[0]?.lapsed).toBe(true);
    expect(await row(ids.lapsedBeforeRestore)).toMatchObject({
      refused_at: null,
      withdrawn_at: null,
    });
  });

  it('a withdrawal stays a withdrawal when its subject stepped down later', async () => {
    expect(await row(ids.withdrawnThenSteppedDown)).toMatchObject({
      withdrawn_by: account.one,
      withdrawn_why: 'withdrawn',
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

  it('one live request per person, and an ending always says why', async () => {
    await expect(
      admin.query(
        `insert into owner_change_request
           (household_id, target_account, requested_by, action, opens_at, lapses_at)
         values ($1, $2, $3, 'demote', now() + interval '7 days', now() + interval '30 days')`,
        [hh, account.two, account.one],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      admin.query('update owner_change_request set withdrawn_at = now() where id = $1', [ids.live]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
