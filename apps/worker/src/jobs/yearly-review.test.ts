import { randomUUID } from 'node:crypto';
import { createDb, createPool, withSystem, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import { NEUTRAL_LINE, REVIEW_NOTE } from '@fdv/shared';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { itemLine } from './notify.js';
import { deliver, tick, type Digest } from './reminders.js';

/**
 * Health's reminders in the worker (0.9.0, H3 of plan-health): a yearly
 * review falls due on the household's calendar, goes into the digest once —
 * and, done and come round again a year on, once more (the ledger counts a
 * reminder once a day it falls due, not once for good) — while the job run
 * twice sends nothing twice. And from the side of whoever must not read the
 * words: under neutral wording (H2), a line about a review, a refill or a
 * next dose says only when it falls due — no title, no kind, no person, no
 * "Yearly review" — and the teen, who cannot see these papers, hears
 * nothing of them.
 */
describe.skipIf(!testAdminUrl())('a yearly review and Health’s reminders, sent (H3)', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  const hh = randomUUID();
  const sent: Digest[] = [];
  const notifier = { digest: async (d: Digest) => (sent.push(d), ['email']) };
  let clock = new Date();
  const deps = () => ({ admin, app: db, notifier, log: () => undefined, now: () => clock });
  const at = (iso: string) => {
    clock = new Date(iso);
  };
  const people: Record<'mum' | 'dad' | 'teen', { member: string; account: string }> = {
    mum: { member: '', account: '' },
    dad: { member: '', account: '' },
    teen: { member: '', account: '' },
  };
  const TITLES = {
    directive: 'Mum’s living will Quokka',
    prescription: 'Dad’s inhaler Narwhal',
    vaccination: 'Tia’s HPV jabs Axolotl',
  };
  let review: string;
  const digestsFor = (who: keyof typeof people) =>
    sent.filter((d) => d.recipient.account_id === people[who].account);

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 3));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    // Auckland: thirteen hours ahead of UTC in November.
    await admin.query(
      "insert into household (id, name, timezone, neutral_wording) values ($1, 'Kiwis', 'Pacific/Auckland', 'sensitive')",
      [hh],
    );
    for (const [who, role] of [
      ['mum', 'owner'],
      ['dad', 'adult'],
      ['teen', 'teen'],
    ] as const) {
      const m = await admin.query<{ id: string }>(
        'insert into member (household_id, display_name) values ($1, $2) returning id',
        [hh, who],
      );
      const a = await admin.query<{ id: string }>(
        'insert into account (email) values ($1) returning id',
        [`${who}-${hh.slice(0, 8)}@example.test`],
      );
      people[who] = { member: m.rows[0]?.id as string, account: a.rows[0]?.id as string };
      await admin.query(
        'insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, $4)',
        [people[who].account, hh, people[who].member, role],
      );
    }
    await withSystem(db, hh, async (trx) => {
      const doc = (title: string, type_key: string, owner: string, visibility: 'adults') =>
        trx
          .insertInto('document')
          .values({ household_id: hh, title, type_key, owner_member_id: owner, visibility })
          .returning('id')
          .executeTakeFirstOrThrow();
      const directive = await doc(
        TITLES.directive,
        'advance_directive',
        people.mum.member,
        'adults',
      );
      const rx = await doc(TITLES.prescription, 'prescription', people.dad.member, 'adults');
      const vax = await doc(TITLES.vaccination, 'vaccination_record', people.teen.member, 'adults');
      // The review as the API makes it, on the 16th, Auckland's day.
      const r = await trx
        .insertInto('reminder')
        .values({
          household_id: hh,
          document_id: directive.id,
          kind: 'manual',
          fire_at: '2026-11-16',
          recurrence: 'annual',
          review: true,
          note: REVIEW_NOTE,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      review = r.id;
      // A refill, and a next dose, as their kinds remind from them.
      await trx
        .insertInto('reminder')
        .values([
          {
            household_id: hh,
            document_id: rx.id,
            kind: 'derived',
            source: 'refill_date',
            fire_at: '2026-11-16',
            lead_days: 3,
          },
          {
            household_id: hh,
            document_id: vax.id,
            kind: 'derived',
            source: 'next_dose_due',
            fire_at: '2026-11-16',
            lead_days: 30,
          },
        ])
        .execute();
    });
  });
  afterAll(async () => {
    await db?.destroy();
    await admin?.end();
    await tdb?.drop();
  });

  const statusOf = async () =>
    (
      await admin.query<{ status: string; fire_at: string }>(
        'select status, fire_at::text from reminder where id = $1',
        [review],
      )
    ).rows[0];

  it('falls due on the household’s day, not the server’s', async () => {
    // 10:00 UTC on the 15th: 23:00 on the 15th in Auckland. Not yet.
    at('2026-11-15T10:00:00Z');
    await tick(deps());
    expect(await statusOf()).toEqual({ status: 'scheduled', fire_at: '2026-11-16' });
    // 20:30 UTC on the 15th: 09:30 on the 16th there. Due, and sent.
    at('2026-11-15T20:30:00Z');
    await tick(deps());
    expect(await statusOf()).toEqual({ status: 'due', fire_at: '2026-11-16' });
    expect(await deliver({ ...deps(), digestHour: 9 })).toEqual({ digests: 1 });
  });

  it('says nothing of the paper under neutral wording: no title, kind, person or note', () => {
    const mine = digestsFor('mum').at(-1) as Digest;
    expect(mine.local_date).toBe('2026-11-16');
    expect(mine.wording).toContain('sensitive');
    const items = mine.items.map((i) => i.reminder_id);
    expect(items).toContain(review);
    const lines = mine.items.map((i) => itemLine(i, mine.wording));
    for (const line of lines) {
      expect(line.startsWith(NEUTRAL_LINE), line).toBe(true);
      for (const word of [
        ...Object.values(TITLES),
        REVIEW_NOTE,
        'Advance directive',
        'Prescription',
        'Vaccination',
        'Next refill',
        'Next dose',
        'Mum',
        'Tia',
      ]) {
        expect(line, line).not.toContain(word);
      }
    }
    // With neutral wording off, the owner's line says what it is.
    const review0 = mine.items.find((i) => i.reminder_id === review);
    expect(itemLine(review0 as Digest['items'][number], ['off'])).toBe(
      `${TITLES.directive} — Due today (${REVIEW_NOTE})`,
    );
  });

  it('is sent only to those who can see the paper: never the teen', () => {
    expect(digestsFor('teen')).toEqual([]);
    const dad = digestsFor('dad').at(-1) as Digest;
    expect(dad.items.map((i) => i.reminder_id)).toContain(review);
  });

  it('the job run again sends nothing again, that day or the next', async () => {
    const before = sent.length;
    at('2026-11-15T22:00:00Z');
    await tick(deps());
    expect(await deliver({ ...deps(), digestHour: 9 })).toEqual({ digests: 0 });
    // The next day: still open, but already told.
    at('2026-11-16T21:00:00Z');
    await tick(deps());
    expect(await deliver({ ...deps(), digestHour: 9 })).toEqual({ digests: 0 });
    expect(sent.length).toBe(before);
  });

  it('done, it comes round a year on, and is sent once more — once', async () => {
    // Done, as the API does it: the next a year on, waiting.
    await admin.query(
      "update reminder set status = 'scheduled', fire_at = '2027-11-16', snoozed_until = null where id = $1",
      [review],
    );
    at('2027-11-15T10:00:00Z');
    await tick(deps());
    expect(await statusOf()).toEqual({ status: 'scheduled', fire_at: '2027-11-16' });
    at('2027-11-15T20:30:00Z');
    await tick(deps());
    expect(await statusOf()).toEqual({ status: 'due', fire_at: '2027-11-16' });
    const before = sent.length;
    expect(await deliver({ ...deps(), digestHour: 9 })).toEqual({ digests: 1 });
    const mums = sent.slice(before).filter((d) => d.recipient.account_id === people.mum.account);
    expect(mums.map((d) => d.items.map((i) => i.reminder_id))).toEqual([[review]]);
    // And once only.
    at('2027-11-16T21:00:00Z');
    expect(await deliver({ ...deps(), digestHour: 9 })).toEqual({ digests: 0 });
  });

  it('snoozed and due again on the same occurrence, it is not sent twice', async () => {
    await admin.query(
      "update reminder set status = 'snoozed', snoozed_until = '2027-11-20' where id = $1",
      [review],
    );
    at('2027-11-20T08:00:00Z');
    await tick(deps());
    expect((await statusOf())?.status).toBe('due');
    expect(await deliver({ ...deps(), digestHour: 9 })).toEqual({ digests: 0 });
  });

  it('a household whose clock moves west is not told of the same reminder again', async () => {
    const doc = await admin.query<{ id: string }>(
      'select id from document where household_id = $1 and title = $2',
      [hh, TITLES.prescription],
    );
    const r = await admin.query<{ id: string }>(
      `insert into reminder (household_id, document_id, kind, fire_at, note)
       values ($1, $2, 'manual', '2028-03-02', 'Ring the pharmacy') returning id`,
      [hh, doc.rows[0]?.id],
    );
    // 09:30 on the 2nd in Auckland: due there.
    at('2028-03-01T20:30:00Z');
    await tick(deps());
    // Then the household moves to Honolulu, where it is still the 1st: sent there.
    await admin.query("update household set timezone = 'Pacific/Honolulu' where id = $1", [hh]);
    try {
      const before = sent.length;
      expect(await deliver({ ...deps(), digestHour: 9 })).toEqual({ digests: 1 });
      expect(sent.slice(before).flatMap((d) => d.items.map((i) => i.reminder_id))).toContain(
        r.rows[0]?.id,
      );
      // The next day there, the 2nd — the day it was for: not again.
      at('2028-03-02T20:00:00Z');
      expect(await deliver({ ...deps(), digestHour: 9 })).toEqual({ digests: 0 });
    } finally {
      await admin.query("update household set timezone = 'Pacific/Auckland' where id = $1", [hh]);
    }
  });
});
