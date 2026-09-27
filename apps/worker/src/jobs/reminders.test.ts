import { randomBytes, randomUUID } from 'node:crypto';
import { EnvKeyProvider, ScopeKeys, sealPrivate } from '@fdv/crypto';
import { createDb, createPool, regenerateDerived, typeEtag, withSystem, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import { addDays, localToday } from '@fdv/shared';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deliver, refreshStatus, tick, type Digest, type Notifier } from './reminders.js';
import { regenerateTypeReminders } from './types.js';

const MASTER = 'reminders-test-master-secret-at-least-32-bytes';

/**
 * The reminder clockwork against real tables, with a fake clock.
 * The headline test: a server switched off for nine days produces exactly
 * one summary notification when it comes back (REM-13, Phase 2 exit).
 */
describe.skipIf(!testAdminUrl())('reminders tick / deliver / catch-up', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  const hh = randomUUID();
  const sent: Digest[] = [];
  const notifier = { digest: async (d: Digest) => (sent.push(d), ['test']) };
  let clock = new Date('2026-09-22T09:10:00Z'); // 09:10 UTC; the household is in UTC
  const deps = () => ({ admin, app: db, notifier, log: () => undefined, now: () => clock });
  const at = (iso: string) => {
    clock = new Date(iso);
  };

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 3));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    await admin.query(
      "insert into household (id, name, timezone) values ($1, 'Clockwork', 'UTC')",
      [hh],
    );
    const m = await admin.query<{ id: string }>(
      "insert into member (household_id, display_name) values ($1, 'M') returning id",
      [hh],
    );
    // Somebody to send the digest to: a digest is always one person's.
    const a = await admin.query<{ id: string }>(
      "insert into account (email) values ('clockwork@example.test') returning id",
    );
    await admin.query(
      "insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, 'owner')",
      [a.rows[0]?.id, hh, m.rows[0]?.id],
    );
    await withSystem(db, hh, async (trx) => {
      const docs: Array<[string, string]> = [
        ['Passport', '2026-09-20'],
        ['Car registration', '2026-09-24'],
        ['Insurance', '2026-10-01'],
      ];
      for (const [title, fire] of docs) {
        const d = await trx
          .insertInto('document')
          .values({
            household_id: hh,
            title,
            owner_member_id: m.rows[0]?.id as string,
            type_key: 'passport',
            // A passport's number is required from 0032 (A9): these have one.
            identifier: `P-${title}`,
            expires_on: addDays(fire, 180),
            expires_precision: 'day',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('reminder')
          .values({
            household_id: hh,
            document_id: d.id,
            kind: 'derived',
            source: 'expires',
            fire_at: fire,
            lead_days: 180,
          })
          .execute();
      }
    });
  });
  afterAll(async () => {
    await db.destroy();
    await admin.end();
    await tdb.drop();
  });

  const statuses = () =>
    withSystem(db, hh, (trx) =>
      trx.selectFrom('reminder').select(['fire_at', 'status']).orderBy('fire_at').execute(),
    ).then((rows) => rows.map((r) => `${String(r.fire_at).slice(0, 10)}:${r.status}`));

  it('tick moves reminders to due on their local date, not before', async () => {
    at('2026-09-22T09:10:00Z');
    expect(await tick(deps())).toEqual({ became_due: 1 });
    expect(await statuses()).toEqual([
      '2026-09-20:due',
      '2026-09-24:scheduled',
      '2026-10-01:scheduled',
    ]);
  });

  it('deliver sends one digest at 9am local and records the ledger; a second run sends nothing', async () => {
    expect(await deliver({ ...deps(), digestHour: 9 })).toEqual({ digests: 1 });
    expect(sent).toHaveLength(1);
    // Two days late, but about a passport that expires next March: it says
    // what it is about, and nothing has lapsed (0.5.15).
    expect(sent[0]).toMatchObject({
      kind: 'catch_up',
      local_date: '2026-09-22',
      items: [
        {
          title: 'Passport',
          label: 'Overdue by 2 days',
          about: 'Expires: 19 Mar 2027, in 6 months',
          overdue: false,
        },
      ],
    });
    expect(await deliver({ ...deps(), digestHour: 9 })).toEqual({ digests: 0 });
    expect(sent).toHaveLength(1);
    const ledger = await withSystem(db, hh, (trx) =>
      trx.selectFrom('reminder_delivery').selectAll().execute(),
    );
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.channel).toBe('test');
  });

  it('later the same day it is not sent again: the ledger, not the clock', async () => {
    at('2026-09-22T14:00:00Z');
    expect(await deliver({ ...deps(), digestHour: 9 })).toEqual({ digests: 0 });
  });

  it('a server off for nine days produces exactly one summary on restart', async () => {
    // Nothing ran between 23 Sep and 1 Oct. Back on at six in the morning:
    // there is plenty to say, but nothing fires before nine.
    at('2026-10-01T06:00:00Z');
    expect(await tick(deps())).toEqual({ became_due: 2 });
    expect(await deliver({ ...deps(), digestHour: 9 })).toEqual({ digests: 0 });
    expect(sent).toHaveLength(1);

    // It actually came back in the evening — which is when a server that
    // was off for nine days usually does. The summary is still owed today.
    at('2026-10-01T21:40:00Z');
    expect(await deliver({ ...deps(), digestHour: 9 })).toEqual({ digests: 1 });
    expect(sent).toHaveLength(2);
    const summary = sent[1] as Digest;
    expect(summary.kind).toBe('catch_up');
    expect(summary.items.map((i) => i.title).sort()).toEqual(['Car registration', 'Insurance']);
    expect(summary.items.find((i) => i.title === 'Car registration')?.label).toBe(
      'Overdue by 7 days',
    );
    expect(summary.items.find((i) => i.title === 'Insurance')?.label).toBe('Due today');
    // The passport was delivered on the 22nd; it is not repeated.
    expect(summary.items.map((i) => i.title)).not.toContain('Passport');
  });

  it('a snoozed reminder returns to due when the snooze ends', async () => {
    await withSystem(db, hh, (trx) =>
      trx
        .updateTable('reminder')
        .set({ status: 'snoozed', snoozed_until: '2026-10-05' })
        .where('fire_at', '=', '2026-10-01')
        .execute(),
    );
    at('2026-10-04T09:00:00Z');
    expect(await tick(deps())).toEqual({ became_due: 0 });
    at('2026-10-05T09:00:00Z');
    expect(await tick(deps())).toEqual({ became_due: 1 });
  });

  it('refreshStatus materialises status_cache without being authoritative', async () => {
    at('2026-10-05T09:00:00Z');
    const r = await refreshStatus(deps());
    expect(r.documents).toBe(3);
    const cached = await withSystem(db, hh, (trx) =>
      trx.selectFrom('document').select(['title', 'status_cache']).orderBy('title').execute(),
    );
    expect(cached.every((c) => c.status_cache === 'expiring_soon')).toBe(true);
  });

  it("refreshStatus reads the household's own types, through the view", async () => {
    // The household tells its passports to warn 30 days out, not 270 and
    // 180 (0031): each, about six months from its expiry, is simply valid.
    await admin.query(
      `insert into document_type_setting (household_id, type_key, reminder_leads)
       values ($1, 'passport', '{30}')`,
      [hh],
    );
    const statuses = () =>
      withSystem(db, hh, (trx) =>
        trx.selectFrom('document').select('status_cache').orderBy('title').execute(),
      );
    try {
      at('2026-10-05T09:00:00Z');
      expect((await refreshStatus(deps())).documents).toBe(3);
      expect((await statuses()).map((c) => c.status_cache)).toEqual(['active', 'active', 'active']);
      // And with Expires switched off, a passport no longer expires at all.
      await admin.query(
        `update document_type_setting set core = '{"expires": {"shown": false}}'
          where household_id = $1 and type_key = 'passport'`,
        [hh],
      );
      await refreshStatus(deps());
      expect((await statuses()).map((c) => c.status_cache)).toEqual(['valid', 'valid', 'valid']);
    } finally {
      await admin.query('delete from document_type_setting where household_id = $1', [hh]);
    }
    await refreshStatus(deps());
    expect((await statuses()).every((c) => c.status_cache === 'expiring_soon')).toBe(true);
  });

  it('refreshStatus: a required field with no value is Needs info, as the API says (0.5.7)', async () => {
    // With 30 days' warning the passports are simply valid — but one has
    // no number, which a passport requires (A9).
    await admin.query(
      `insert into document_type_setting (household_id, type_key, reminder_leads)
       values ($1, 'passport', '{30}')`,
      [hh],
    );
    await admin.query(
      "update document set identifier = null where household_id = $1 and title = 'Insurance'",
      [hh],
    );
    try {
      at('2026-10-05T09:00:00Z');
      await refreshStatus(deps());
      const cached = await withSystem(db, hh, (trx) =>
        trx.selectFrom('document').select(['title', 'status_cache']).orderBy('title').execute(),
      );
      expect(cached).toEqual([
        { title: 'Car registration', status_cache: 'active' },
        { title: 'Insurance', status_cache: 'needs_info' },
        { title: 'Passport', status_cache: 'active' },
      ]);
    } finally {
      await admin.query('delete from document_type_setting where household_id = $1', [hh]);
      await admin.query(
        "update document set identifier = 'P-Insurance' where household_id = $1 and title = 'Insurance'",
        [hh],
      );
    }
  });
});

/** A household with one person to tell, as the digest needs; its id and member. */
async function household(admin: pg.Pool, name: string): Promise<{ id: string; member: string }> {
  const id = randomUUID();
  await admin.query("insert into household (id, name, timezone) values ($1, $2, 'UTC')", [
    id,
    name,
  ]);
  const m = await admin.query<{ id: string }>(
    'insert into member (household_id, display_name) values ($1, $2) returning id',
    [id, name],
  );
  const a = await admin.query<{ id: string }>(
    'insert into account (email) values ($1) returning id',
    [`${id}@example.test`],
  );
  await admin.query(
    "insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, 'owner')",
    [a.rows[0]?.id, id, m.rows[0]?.id],
  );
  return { id, member: m.rows[0]?.id as string };
}

/**
 * types.regenerate against real tables, and the digest after it (the 5.11
 * review): a change to Passport reminds of what is ahead, never of every
 * passport the family keeps for the record, nor again of what it dealt with.
 */
describe.skipIf(!testAdminUrl())('a type changed reminds of what is ahead', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  let hh: string;
  const sent: Digest[] = [];
  const notifier: Notifier = { digest: async (d) => (sent.push(d), ['test']) };
  /** Today, whenever the test runs: the digest goes at any hour. */
  const digest = () => deliver({ admin, app: db, notifier, log: () => undefined, digestHour: 0 });
  const today = localToday('UTC');
  /** By title: each passport's derived reminders, furthest first. */
  const reminders = async () => {
    const { rows } = await admin.query<{ title: string; lead_days: number; status: string }>(
      `select d.title, r.lead_days, r.status from reminder r join document d on d.id = r.document_id
        where r.household_id = $1 order by d.title, r.lead_days desc`,
      [hh],
    );
    const by: Record<string, string[]> = {};
    for (const r of rows) (by[r.title] ??= []).push(`${r.lead_days}:${r.status}`);
    return by;
  };
  const setting = (sql: string) => admin.query(sql, [hh]);
  const keys = new ScopeKeys(new EnvKeyProvider(MASTER));
  const regenerate = () =>
    regenerateTypeReminders({ app: db, keys }, { household_id: hh, type_key: 'passport' });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 3));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    const made = await household(admin, 'Archive');
    hh = made.id;
    // Three passports kept for the record, long expired; one with 100 days
    // left; one with 400. Each filed as the API files one, so a lead whose
    // day has passed is due — and then the family dealt with all of those.
    const passports: Array<[string, number]> = [
      ['Expired 1500', -1500],
      ['Expired 2500', -2500],
      ['Expired 3500', -3500],
      ['In 100 days', 100],
      ['In 400 days', 400],
    ];
    for (const [title, days] of passports) {
      await withSystem(db, hh, async (trx) => {
        const d = await trx
          .insertInto('document')
          .values({
            household_id: hh,
            title,
            owner_member_id: made.member,
            type_key: 'passport',
            identifier: `P-${days}`,
            expires_on: addDays(today, days),
            expires_precision: 'day',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await regenerateDerived(trx, hh, d.id);
      });
    }
    await admin.query(
      "update reminder set status = 'acknowledged' where household_id = $1 and status = 'due'",
      [hh],
    );
  });
  afterAll(async () => {
    await db?.destroy();
    await admin?.end();
    await tdb?.drop();
  });

  it('a lead time added makes no reminder whose day has passed', async () => {
    const before = await reminders();
    // Filed with both lead days gone by, only the nearer was made due (0.5.15).
    expect(before['Expired 1500']).toEqual(['180:acknowledged']);
    expect(before['In 400 days']).toEqual(['270:scheduled', '180:scheduled']);
    await setting(
      `insert into document_type_setting (household_id, type_key, reminder_leads)
       values ($1, 'passport', '{270,180,30}')`,
    );
    expect(await regenerate()).toEqual({ documents: 5, failed: 0 });
    expect(await reminders()).toEqual({
      'Expired 1500': ['180:acknowledged'],
      'Expired 2500': ['180:acknowledged'],
      'Expired 3500': ['180:acknowledged'],
      'In 100 days': ['180:acknowledged', '30:scheduled'],
      'In 400 days': ['270:scheduled', '180:scheduled', '30:scheduled'],
    });
    expect(await digest()).toEqual({ digests: 0 });
    expect(sent).toEqual([]);
  });

  it('Expires switched off and on again brings back nothing the family dealt with', async () => {
    await setting(
      `update document_type_setting set core = '{"expires": {"shown": false}}'
        where household_id = $1 and type_key = 'passport'`,
    );
    await regenerate();
    expect(await reminders()).toEqual({});
    await setting(
      `update document_type_setting set core = '{"expires": {"shown": true}}'
        where household_id = $1 and type_key = 'passport'`,
    );
    await regenerate();
    expect(await reminders()).toEqual({
      'In 100 days': ['30:scheduled'],
      'In 400 days': ['270:scheduled', '180:scheduled', '30:scheduled'],
    });
    expect(await digest()).toEqual({ digests: 0 });
    expect(sent).toEqual([]);
  });

  it('a document edited is reminded as before: the nearest lead whose day has passed is due', async () => {
    const { rows } = await admin.query<{ id: string }>(
      "select id from document where household_id = $1 and title = 'In 100 days'",
      [hh],
    );
    await withSystem(db, hh, (trx) => regenerateDerived(trx, hh, rows[0]?.id as string));
    // 270 and 180 days before have both passed: the nearer is due, once (0.5.15).
    expect((await reminders())['In 100 days']).toEqual(['180:due', '30:scheduled']);
    expect(await digest()).toEqual({ digests: 1 });
    expect(sent[0]?.items).toHaveLength(1);
  });
});

/**
 * The digest is sent, then its ledger written, in one transaction (the
 * 5.11 review). A reminder deleted while it is being sent — every reminder
 * of a type made anew — failed the ledger, rolled the digest back, and it
 * went again next hour; and the failure stopped every household after it.
 */
describe.skipIf(!testAdminUrl())('the digest, while reminders change under it', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  let first: string;
  let second: string;
  const logged: Array<{ level: string; msg: string; extra?: Record<string, unknown> }> = [];
  const log = (level: string, msg: string, extra?: Record<string, unknown>) =>
    void logged.push({ level, msg, ...(extra ? { extra } : {}) });
  let clock = new Date();

  /** A document with a reminder due today, in `hh`; the reminder's id. */
  const due = async (hh: string, member: string, title: string) =>
    withSystem(db, hh, async (trx) => {
      const d = await trx
        .insertInto('document')
        .values({ household_id: hh, title, owner_member_id: member })
        .returning('id')
        .executeTakeFirstOrThrow();
      const r = await trx
        .insertInto('reminder')
        .values({
          household_id: hh,
          document_id: d.id,
          kind: 'manual',
          fire_at: localToday('UTC', clock),
          note: title,
          status: 'due',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return r.id;
    });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 3));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    const a = await household(admin, 'First');
    const b = await household(admin, 'Second');
    first = a.id;
    second = b.id;
    await due(first, a.member, 'Permit');
    await due(first, a.member, 'Passport');
    await due(second, b.member, 'Lease');
  });
  afterAll(async () => {
    await db?.destroy();
    await admin?.end();
    await tdb?.drop();
  });

  it('a reminder deleted while the digest is sent waits for its ledger: the digest goes once', async () => {
    const [permit] = (
      await admin.query<{ id: string }>("select id from reminder where note = 'Permit'")
    ).rows;
    const sent: Digest[] = [];
    const pending: { deleting?: Promise<unknown> } = {};
    const slow: Notifier = {
      async digest(d) {
        sent.push(d);
        if (d.household_id === first && !pending.deleting) {
          // The permit's reminders made anew, as types.regenerate does,
          // while the mail server takes its time.
          pending.deleting = withSystem(db, first, (trx) =>
            trx
              .deleteFrom('reminder')
              .where('id', '=', permit?.id as string)
              .execute(),
          );
          await Promise.race([pending.deleting, new Promise((r) => setTimeout(r, 400))]);
        }
        return ['test'];
      },
    };
    const run = () =>
      deliver({ admin, app: db, notifier: slow, log, now: () => clock, digestHour: 0 });
    expect(await run()).toEqual({ digests: 2 });
    await pending.deleting;
    expect(sent.filter((d) => d.household_id === first)).toHaveLength(1);
    expect(sent.find((d) => d.household_id === first)?.items).toHaveLength(2);
    // Sent once: the next run has nothing more to say today.
    expect(await run()).toEqual({ digests: 0 });
    expect(sent).toHaveLength(2);
    // The permit's reminder went after the ledger, and its line with it.
    const ledger = await admin.query<{ n: number }>(
      'select count(*)::int as n from reminder_delivery where household_id = $1',
      [first],
    );
    expect(ledger.rows[0]?.n).toBe(1);
    expect(logged.filter((l) => l.level === 'error')).toEqual([]);
  });

  it("one household's failure is logged, and the others still get theirs", async () => {
    // Tomorrow: something new due in each.
    clock = new Date(clock.getTime() + 86_400_000);
    const members = await admin.query<{ id: string; household_id: string }>(
      'select id, household_id from member',
    );
    const memberOf = (hh: string) => members.rows.find((m) => m.household_id === hh)?.id as string;
    await due(first, memberOf(first), 'Insurance');
    await due(second, memberOf(second), 'Tenancy');
    const sent: Digest[] = [];
    const failing: Notifier = {
      async digest(d) {
        if (d.household_id === first) throw new Error('the mail server said no');
        sent.push(d);
        return ['test'];
      },
    };
    const run = (notifier: Notifier) =>
      deliver({ admin, app: db, notifier, log, now: () => clock, digestHour: 0 });
    expect(await run(failing)).toEqual({ digests: 1 });
    expect(sent.map((d) => d.household_id)).toEqual([second]);
    expect(logged).toContainEqual({
      level: 'error',
      msg: 'reminder digest failed',
      extra: { household: first, error: 'the mail server said no' },
    });
    // Nothing was recorded for the first, so it is owed still, and sent next time.
    const again: Digest[] = [];
    expect(await run({ digest: async (d) => (again.push(d), ['test']) })).toEqual({ digests: 1 });
    expect(again.map((d) => d.household_id)).toEqual([first]);
  });
});

/**
 * types.regenerate when a kind reminds from a date field (0.5.15), against
 * real tables. On an Only me document that date is sealed under its
 * owner's key: the job opens it, that date alone, in the document's own
 * transaction — the one exception to the seal (A62) — and nothing else.
 */
describe.skipIf(!testAdminUrl())('types.regenerate and the date a kind reminds from', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  let hh: string;
  let member: string;
  const KIND = 'h_counciltax';
  const today = localToday('UTC');
  const keys = new ScopeKeys(new EnvKeyProvider(MASTER));
  /** Whose member key each unwrap asked for, while a test listens. */
  const unwrapped: Array<string | null | undefined> = [];
  const listening = new (class extends ScopeKeys {
    override async unwrap(trx: Db, ref: Parameters<ScopeKeys['unwrap']>[1]) {
      unwrapped.push(ref.memberId);
      return super.unwrap(trx, ref);
    }
  })(new EnvKeyProvider(MASTER));
  const ids: Record<string, string> = {};
  const day = (n: number) => ({ date: addDays(today, n), precision: 'day' });
  const regenerate = (k: ScopeKeys = keys) =>
    regenerateTypeReminders({ app: db, keys: k }, { household_id: hh, type_key: KIND });

  /**
   * A bill, filed as the API files one: Only me ones with their details
   * sealed under their owner's key, and reminded from what was written.
   */
  const bill = async (
    title: string,
    extra: Record<string, unknown>,
    opts: { sealed?: boolean; owner?: string; trashed?: boolean } = {},
  ) => {
    const id = randomUUID();
    const owner = opts.owner ?? member;
    await withSystem(db, hh, async (trx) => {
      const sealed = opts.sealed
        ? sealPrivate(
            opts.owner && opts.owner !== member
              ? randomBytes(32)
              : (await keys.unwrap(trx, { householdId: hh, kind: 'member', memberId: member })).key,
            id,
            { notes: null, extra },
          )
        : null;
      await trx
        .insertInto('document')
        .values({
          id,
          household_id: hh,
          title,
          type_key: KIND,
          owner_member_id: owner,
          visibility: sealed ? 'private' : 'household',
          expires_on: addDays(today, 100),
          expires_precision: 'day',
          extra: JSON.stringify(sealed ? {} : extra),
          ...(sealed ?? {}),
          deleted_at: opts.trashed ? new Date() : null,
        })
        .execute();
      if (!opts.owner || opts.owner === member) {
        await regenerateDerived(trx, hh, id, sealed ? { details: extra } : {});
      }
    });
    ids[title] = id;
    return id;
  };
  /** Each bill's derived reminders: the date each is about, its lead, its day, its state. */
  const reminders = async (title: string) =>
    (
      await admin.query<{ line: string }>(
        `select source || ':' || lead_days || ':' || (fire_at - current_date) || ':' || status as line
           from reminder where document_id = $1 and kind = 'derived' order by fire_at`,
        [ids[title]],
      )
    ).rows.map((r) => r.line);

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 3));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    const made = await household(admin, 'Bills');
    hh = made.id;
    member = made.member;
    await withSystem(db, hh, async (trx) => {
      await keys.mintHouseholdKeys(trx, hh);
      await keys.mintMemberKey(trx, hh, member, null);
    });
    // Council tax: it expires, and asks for its due date; it reminds, for
    // now, 30 days before it expires.
    await admin.query(
      `insert into document_type
         (key, household_id, label, category, fields, expiry_driver, reminder_leads, remind_from)
       values ($1, $2, 'Council tax', 'bills',
               '[{"key": "due_date", "label": "Due date", "kind": "date", "required": true},
                 {"key": "account", "label": "Account", "kind": "text", "required": false}]',
               'expires_on', '{30}', 'expires')`,
      [KIND, hh],
    );
    await bill('Flat', { due_date: day(20) });
    await bill('Mine, sealed', { due_date: day(25), account: 'CT-1' }, { sealed: true });
    await bill('Nearly due', { due_date: day(3) });
    // The family dealt with the flat's already.
    await admin.query("update reminder set status = 'acknowledged' where document_id = $1", [
      ids.Flat,
    ]);
  }, 60_000);
  afterAll(async () => {
    await db?.destroy();
    await admin?.end();
    await tdb?.drop();
  });

  it('moving a kind to Due date makes only reminders still ahead, and drops the old ones, even done ones', async () => {
    expect(await reminders('Flat')).toEqual(['expires:30:70:acknowledged']);
    expect(await reminders('Mine, sealed')).toEqual(['expires:30:70:scheduled']);
    await admin.query(
      "update document_type set remind_from = 'due_date', reminder_leads = '{7,1}' where key = $1",
      [KIND],
    );
    expect(await regenerate()).toEqual({ documents: 3, failed: 0 });
    expect(await reminders('Flat')).toEqual(['due_date:7:13:scheduled', 'due_date:1:19:scheduled']);
    // Its date sealed, opened by the vault for this alone.
    expect(await reminders('Mine, sealed')).toEqual([
      'due_date:7:18:scheduled',
      'due_date:1:24:scheduled',
    ]);
    // 7 days before has gone by: only what is still ahead.
    expect(await reminders('Nearly due')).toEqual(['due_date:1:2:scheduled']);
  });

  it('types.regenerate opens only the one date it needs, and nothing in the Trash', async () => {
    await bill('Binned, sealed', { due_date: day(40) }, { sealed: true, trashed: true });
    // Only me, with a detail sealed, but not the due date: nothing to open.
    await bill('Account only, sealed', { account: 'CT-2' }, { sealed: true });
    unwrapped.length = 0;
    expect(await regenerate(listening)).toEqual({ documents: 4, failed: 0 });
    // One key, once: the owner's, for the one Only me bill whose due date is sealed.
    expect(unwrapped).toEqual([member]);
    expect(await reminders('Binned, sealed')).toEqual([]);
    expect(await reminders('Account only, sealed')).toEqual([]);
    expect(await reminders('Mine, sealed')).toEqual([
      'due_date:7:18:scheduled',
      'due_date:1:24:scheduled',
    ]);
  });

  it("a document whose owner's key cannot be opened counts as failed, and the others are done", async () => {
    // Somebody whose member key is not there: their bill cannot be opened.
    const { rows } = await admin.query<{ id: string }>(
      "insert into member (household_id, display_name) values ($1, 'Lodger') returning id",
      [hh],
    );
    const lodgers = await bill(
      'Lodger, sealed',
      { due_date: day(12) },
      { sealed: true, owner: rows[0]?.id as string },
    );
    await admin.query('delete from reminder where document_id = $1', [ids.Flat]);
    const r = await regenerate();
    // Counts and ids, never a value.
    expect(r).toEqual({ documents: 4, failed: 1, failed_ids: [lodgers] });
    expect(await reminders('Flat')).toEqual(['due_date:7:13:scheduled', 'due_date:1:19:scheduled']);
    expect(await reminders('Lodger, sealed')).toEqual([]);
    await admin.query('delete from document where id = $1', [lodgers]);
  });

  it('the job leaves updated_at, the etag and the audit alone', async () => {
    const state = async () => ({
      documents: (
        await admin.query<{ id: string; updated_at: Date }>(
          'select id, updated_at from document where household_id = $1 order by id',
          [hh],
        )
      ).rows.map((d) => `${d.id}:${d.updated_at.toISOString()}`),
      audit: (
        await admin.query<{ n: number }>(
          'select count(*)::int as n from audit_event where household_id = $1',
          [hh],
        )
      ).rows[0]?.n,
      kind: typeEtag(
        await withSystem(db, hh, (trx) =>
          trx
            .selectFrom('effective_document_type')
            .selectAll()
            .where('key', '=', KIND)
            .executeTakeFirstOrThrow(),
        ),
      ),
    });
    // A lead time added: every bill reminded anew, and nobody edited anything.
    await admin.query("update document_type set reminder_leads = '{7,1,3}' where key = $1", [KIND]);
    const before = await state();
    expect(await regenerate()).toEqual({ documents: 4, failed: 0 });
    expect(await reminders('Flat')).toContain('due_date:3:17:scheduled');
    expect(await state()).toEqual(before);
  });

  it('a reminder unchanged by a move is not delivered twice', async () => {
    const sent: Digest[] = [];
    const notifier: Notifier = { digest: async (d) => (sent.push(d), ['test']) };
    const run = (now: Date) =>
      deliver({ admin, app: db, notifier, log: () => undefined, digestHour: 0, now: () => now });
    // Due in 2 days, filed today: its 3-day reminder is due now.
    await bill('Due soon', { due_date: day(2) });
    expect(await reminders('Due soon')).toEqual(['due_date:3:-1:due', 'due_date:1:1:scheduled']);
    const first = await admin.query<{ id: string }>(
      'select id from reminder where document_id = $1 and lead_days = 3',
      [ids['Due soon']],
    );
    expect(await run(new Date())).toEqual({ digests: 1 });
    expect(sent[0]?.items.map((i) => [i.title, i.about, i.overdue])).toEqual([
      ['Due soon', expect.stringMatching(/^Due date: .*, in 2 days$/), false],
    ]);
    // The kind's lead times move; the 3-day reminder is exactly as it was.
    await admin.query("update document_type set reminder_leads = '{14,3,1}' where key = $1", [
      KIND,
    ]);
    await regenerate();
    const after = await admin.query<{ id: string }>(
      'select id from reminder where document_id = $1 and lead_days = 3',
      [ids['Due soon']],
    );
    expect(after.rows).toEqual(first.rows);
    // Tomorrow's digest has nothing new to say of it.
    expect(await run(new Date(Date.now() + 86_400_000))).toEqual({ digests: 0 });
    expect(sent).toHaveLength(1);
  });
});
