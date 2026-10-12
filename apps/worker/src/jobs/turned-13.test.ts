import { randomBytes, randomUUID } from 'node:crypto';
import { createDb, createPool, readAs, withSystem, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deliver, tick, type Digest } from './reminders.js';

/**
 * The owners reminded when somebody turns 13 (0066, after 0.7.0): made by
 * the reminders' own tick, on the day the household's calendar says;
 * delivered once, by the daily digest, to the owners and nobody else; and
 * never about somebody who already signs in or has been invited.
 *
 * The household is in Tokyo (UTC+9): at 16:00 UTC on 11 October it is
 * already the 12th there, Sara's 13th birthday.
 */
describe.skipIf(!testAdminUrl())('somebody turning 13', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  const hh = randomUUID();
  const sent: Digest[] = [];
  const notifier = { digest: async (d: Digest) => (sent.push(d), ['test']) };
  let clock = new Date('2026-10-11T12:00:00Z');
  const deps = () => ({ admin, app: db, notifier, log: () => undefined, now: () => clock });
  const ids: Record<string, string> = {};
  const accounts: Record<string, string> = {};

  /** Somebody of the family, in the vault since 2020: `name`, born on `dob`. */
  const person = async (name: string, dob: string | null) => {
    const r = await admin.query<{ id: string }>(
      `insert into member (household_id, display_name, date_of_birth, created_at)
       values ($1, $2, $3, '2020-01-01') returning id`,
      [hh, name, dob],
    );
    ids[name] = r.rows[0]?.id as string;
    return ids[name];
  };
  const signIn = async (name: string, role: string) => {
    const a = await admin.query<{ id: string }>(
      'insert into account (email) values ($1) returning id',
      [`${name.toLowerCase()}-${hh.slice(0, 8)}@example.test`],
    );
    accounts[name] = a.rows[0]?.id as string;
    await admin.query(
      'insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, $4)',
      [accounts[name], hh, ids[name], role],
    );
  };
  const invite = (name: string, expires = '2099-01-01') =>
    admin.query(
      `insert into invitation (household_id, member_id, email, role, token_hash, code_hash, invited_by, expires_at)
       values ($1, $2, $3, 'teen', $4, 'x', $5, $6)`,
      [
        hh,
        ids[name],
        `${name.toLowerCase()}@example.test`,
        randomBytes(32),
        accounts.Owner,
        expires,
      ],
    );
  const reminders = () =>
    withSystem(db, hh, (trx) =>
      trx
        .selectFrom('reminder')
        .innerJoin('member', 'member.id', 'reminder.member_id')
        .select(['member.display_name', 'reminder.fire_at', 'reminder.status'])
        .where('reminder.kind', '=', 'turned_13')
        .orderBy('member.display_name')
        .execute(),
    ).then((rows) =>
      rows.map((r) => `${r.display_name}:${String(r.fire_at).slice(0, 10)}:${r.status}`),
    );

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 3));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    await admin.query(
      "insert into household (id, name, timezone) values ($1, 'Thirteen', 'Asia/Tokyo')",
      [hh],
    );
    await person('Owner', '1980-05-05');
    await signIn('Owner', 'owner');
    await person('Adult', '1982-06-06');
    await signIn('Adult', 'adult');
    // Thirteen on 12 October 2026, Tokyo's calendar.
    await person('Sara', '2013-10-12');
    // Thirteen the same day, but with a sign-in already, and invited.
    await person('Signed', '2013-10-12');
    await signIn('Signed', 'teen');
    await person('Invited', '2013-10-12');
    await invite('Invited');
    // Thirteen the same day, with an invitation that has run out: reminded.
    await person('Lapsed', '2013-10-12');
    await invite('Lapsed', '2026-01-01');
    // Twelve, and fourteen: nothing.
    await person('Younger', '2014-10-12');
    await person('Older', '2012-10-01');
    // No date of birth: nothing to go on.
    await person('Unknown', null);
  });
  afterAll(async () => {
    await db.destroy();
    await admin.end();
    await tdb.drop();
  });

  it('is not made the day before, on the household’s calendar', async () => {
    // 11 October, 21:00 in Tokyo.
    clock = new Date('2026-10-11T12:00:00Z');
    await tick(deps());
    expect(await reminders()).toEqual([]);
  });

  it('is made on the day, due, for those who may yet sign up — while it is still the 11th in UTC', async () => {
    // 12 October, 01:00 in Tokyo; still the 11th in London.
    clock = new Date('2026-10-11T16:00:00Z');
    expect(await tick(deps())).toEqual({ became_due: 2 });
    expect(await reminders()).toEqual(['Lapsed:2026-10-12:due', 'Sara:2026-10-12:due']);
    // Once: the tick every 15 minutes makes no second one.
    clock = new Date('2026-10-11T16:15:00Z');
    expect(await tick(deps())).toEqual({ became_due: 0 });
    expect(await reminders()).toHaveLength(2);
  });

  it('is the owners’ alone: an adult is given none, read as them', async () => {
    const seen = (role: 'owner' | 'adult', name: 'Owner' | 'Adult') =>
      withSystem(db, hh, (trx) =>
        readAs(
          trx,
          { accountId: accounts[name] as string, memberId: ids[name] as string, role },
          (as) => as.selectFrom('reminder').select('id').where('kind', '=', 'turned_13').execute(),
        ),
      );
    expect(await seen('owner', 'Owner')).toHaveLength(2);
    expect(await seen('adult', 'Adult')).toHaveLength(0);
  });

  it('goes in the owner’s digest, once, and in nobody else’s', async () => {
    // Lapsed is invited again before nine (the one run out taken back, as
    // sending another does): no longer somebody to remind about.
    await admin.query('update invitation set revoked_at = now() where member_id = $1', [
      ids.Lapsed,
    ]);
    await invite('Lapsed');
    clock = new Date('2026-10-12T00:30:00Z'); // 09:30 in Tokyo
    expect(await deliver({ ...deps(), digestHour: 9 })).toEqual({ digests: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.recipient.account_id).toBe(accounts.Owner);
    expect(sent[0]?.items).toEqual([
      {
        reminder_id: expect.any(String) as unknown,
        document_id: null,
        member_id: ids.Sara,
        title: 'Sara is 13 today',
        label: 'They can now have their own sign-in.',
        about: null,
        note: null,
        overdue: false,
        private: false,
      },
    ]);
    // Never again, though it is still due until an owner dismisses it.
    clock = new Date('2026-10-13T00:30:00Z');
    expect(await deliver({ ...deps(), digestHour: 9 })).toEqual({ digests: 0 });
    expect(sent).toHaveLength(1);
  });

  it('is done with once they are invited: resolved at the next tick', async () => {
    expect(await reminders()).toEqual(['Lapsed:2026-10-12:due', 'Sara:2026-10-12:due']);
    await tick(deps());
    expect(await reminders()).toEqual(['Lapsed:2026-10-12:resolved', 'Sara:2026-10-12:due']);
  });

  it('a vault off on the day tells the owners within the week, and not after', async () => {
    await person('Late', '2013-10-08');
    await person('Later', '2013-10-04');
    clock = new Date('2026-10-13T00:30:00Z'); // the 13th in Tokyo
    await tick(deps());
    expect(await reminders()).toEqual([
      'Lapsed:2026-10-12:resolved',
      'Late:2026-10-08:due',
      'Sara:2026-10-12:due',
    ]);
  });

  it('somebody added on their birthday or after it is not reminded about: they were offered it then', async () => {
    const r = await admin.query<{ id: string }>(
      `insert into member (household_id, display_name, date_of_birth, created_at)
       values ($1, 'Newcomer', '2013-10-13', '2026-10-12T16:00:00Z') returning id`,
      [hh],
    );
    expect(r.rows[0]?.id).toBeTruthy();
    clock = new Date('2026-10-13T03:00:00Z'); // the 13th in Tokyo, the day they were added
    await tick(deps());
    expect((await reminders()).some((x) => x.startsWith('Newcomer'))).toBe(false);
  });
});
