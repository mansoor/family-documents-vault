import { randomBytes, randomUUID } from 'node:crypto';
import { deriveKey } from '@fdv/crypto';
import { createDb, createPool, withSystem, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import pg from 'pg';
import webpush from 'web-push';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createNotifier } from './notify.js';
import { deliver, weekly, type Digest } from './reminders.js';

/**
 * The digest and the privacy wall.
 *
 * Until 0.4.2 the daily and weekly digests were built once per household
 * and sent to every device and every inbox in it, so the title of one
 * adult's *Only me* document reached the other adult's lock screen, and
 * *Adults only* titles reached the teen's and the viewer's. These tests
 * are written from the side of the people who must not see them.
 */

const MASTER = 'digest-privacy-test-master-secret-32-bytes!';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const TAG = Date.now().toString(36);

async function mailpitUp(): Promise<boolean> {
  try {
    return (
      await fetch(`${MAILPIT}/api/v1/messages?limit=1`, { signal: AbortSignal.timeout(1500) })
    ).ok;
  } catch {
    return false;
  }
}
const withMailpit = await mailpitUp();

interface MailSummary {
  ID: string;
  Subject: string;
  To: Array<{ Address: string }>;
}

/** Every message sent to one address in this run, with its text. */
async function inbox(address: string, want: number) {
  let found: MailSummary[] = [];
  for (let i = 0; i < 40 && found.length < want; i++) {
    const r = await fetch(
      `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}&limit=20`,
    );
    found = ((await r.json()) as { messages?: MailSummary[] }).messages ?? [];
    if (found.length < want) await new Promise((res) => setTimeout(res, 250));
  }
  return Promise.all(
    found.map(async (m) => {
      const full = (await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json()) as {
        Text: string;
        HTML: string;
      };
      return { ...m, text: `${full.Text}\n${full.HTML}` };
    }),
  );
}

describe.skipIf(!testAdminUrl())('the digest respects the privacy wall', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  const hh = randomUUID();
  const smtpKey = deriveKey(MASTER, 'smtp-credentials');
  const email = (who: string) => `${who}-${TAG}@example.test`;

  /** Who is in the house, and what each of them may see. */
  const people = {
    owner: { role: 'owner', member: '', account: '' },
    adult: { role: 'adult', member: '', account: '' },
    teen: { role: 'teen', member: '', account: '' },
    viewer: { role: 'viewer', member: '', account: '' },
  };
  type Who = keyof typeof people;

  const TITLES = {
    household: 'Council tax bill',
    adults: 'Solicitor letter about the house',
    ownerPrivate: 'Owner therapy notes',
    adultPrivate: 'Adult divorce papers',
  };
  const allowed: Record<Who, string[]> = {
    owner: [TITLES.household, TITLES.adults, TITLES.ownerPrivate],
    adult: [TITLES.household, TITLES.adults, TITLES.adultPrivate],
    teen: [TITLES.household],
    viewer: [TITLES.household],
  };
  const forbidden = (who: Who) => Object.values(TITLES).filter((t) => !allowed[who].includes(t));

  const reminderOf: Record<string, string> = {};
  const vapid = webpush.generateVAPIDKeys();

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 3));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    await admin.query(
      "insert into household (id, name, timezone) values ($1, 'The Wall family', 'UTC')",
      [hh],
    );
    for (const [who, p] of Object.entries(people)) {
      const m = await admin.query<{ id: string }>(
        'insert into member (household_id, display_name) values ($1, $2) returning id',
        [hh, who],
      );
      const a = await admin.query<{ id: string }>(
        'insert into account (email) values ($1) returning id',
        [email(who)],
      );
      p.member = m.rows[0]?.id as string;
      p.account = a.rows[0]?.id as string;
      await admin.query(
        'insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, $4)',
        [p.account, hh, p.member, p.role],
      );
    }

    const docs: Array<[string, 'household' | 'adults' | 'private', string]> = [
      [TITLES.household, 'household', people.owner.member],
      [TITLES.adults, 'adults', people.owner.member],
      [TITLES.ownerPrivate, 'private', people.owner.member],
      [TITLES.adultPrivate, 'private', people.adult.member],
    ];
    await withSystem(db, hh, async (trx) => {
      for (const [title, visibility, owner] of docs) {
        const d = await trx
          .insertInto('document')
          .values({
            household_id: hh,
            title,
            visibility,
            owner_member_id: owner,
            type_key: 'utility_bill',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        const r = await trx
          .insertInto('reminder')
          .values({
            household_id: hh,
            document_id: d.id,
            kind: 'manual',
            fire_at: '2026-09-22',
            status: 'due',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        reminderOf[title] = r.id;
      }
      // One phone each, signed in, and everybody asks for email every day.
      for (const [who, p] of Object.entries(people)) {
        const session = await trx
          .insertInto('session')
          .values({
            account_id: p.account,
            household_id: hh,
            refresh_hash: randomBytes(32),
            expires_at: new Date(Date.now() + 30 * 864e5),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('device')
          .values({
            household_id: hh,
            account_id: p.account,
            endpoint: `https://push.example.test/${TAG}/${who}`,
            p256dh: 'test-key',
            auth: 'test-auth',
            session_id: session.id,
          })
          .execute();
        await trx
          .insertInto('notification_preference')
          .values({ account_id: p.account, household_id: hh, daily_email: true })
          .execute();
      }
      // And the teen's phone app, through its own push distributor (4.13).
      await trx
        .insertInto('device')
        .values({
          household_id: hh,
          account_id: people.teen.account,
          kind: 'unified_push',
          endpoint: `https://push.example.test/${TAG}/teen-phone`,
          p256dh: 'test-key',
          auth: 'test-auth',
        })
        .execute();
      await trx
        .insertInto('smtp_settings')
        .values({
          household_id: hh,
          host: 'localhost',
          port: 1025,
          secure: false,
          from_email: `wall-${TAG}@example.test`,
          status: withMailpit ? 'ok' : 'untested',
        })
        .execute();
    });
  }, 60_000);

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await db.destroy();
    await admin.end();
    await tdb.drop();
  });

  /** Runs the digest with the push service replaced by a recorder. */
  const runDaily = async () => {
    const pushed: Array<{ endpoint: string; payload: string }> = [];
    vi.spyOn(webpush, 'sendNotification').mockImplementation(async (sub, payload) => {
      pushed.push({ endpoint: sub.endpoint, payload: String(payload) });
      return { statusCode: 201, body: '', headers: {} };
    });
    const digests: Digest[] = [];
    const real = createNotifier({
      app: db,
      vapid: { ...vapid, subject: 'mailto:test@example.test' },
      smtpKey,
      baseUrl: 'https://vault.example.test',
      log: () => undefined,
    });
    const notifier = {
      digest: async (d: Digest) => {
        digests.push(d);
        return real.digest(d);
      },
    };
    const r = await deliver({
      admin,
      app: db,
      notifier,
      log: () => undefined,
      now: () => new Date('2026-09-22T09:10:00Z'),
      digestHour: 9,
    });
    return { r, pushed, digests };
  };

  let daily: Awaited<ReturnType<typeof runDaily>>;

  it('each person is sent their own digest, cut to what they may see', async () => {
    daily = await runDaily();
    expect(daily.r).toEqual({ digests: 1 });
    expect(daily.digests).toHaveLength(4);
    for (const [who, p] of Object.entries(people) as Array<[Who, (typeof people)[Who]]>) {
      const mine = daily.digests.find((d) => d.recipient.account_id === p.account);
      expect(mine?.items.map((i) => i.title).sort(), who).toEqual([...allowed[who]].sort());
      expect(mine?.recipient.email).toBe(email(who));
    }
  });

  it('no push carries a title to a phone whose owner may not see it', () => {
    expect(daily.pushed).toHaveLength(5);
    for (const who of Object.keys(people) as Who[]) {
      const mine = daily.pushed.filter((x) => x.endpoint.endsWith(`/${who}`));
      expect(mine, who).toHaveLength(1);
      const payload = mine[0]?.payload ?? '';
      for (const title of forbidden(who))
        expect(payload, `${who} saw ${title}`).not.toContain(title);
      for (const title of allowed[who]) expect(payload, who).toContain(title);
      // The count is theirs too: "3 things" would say something is hidden.
      expect((JSON.parse(payload) as { count: number }).count, who).toBe(allowed[who].length);
    }
  });

  it("a teen's phone is never told about an adults-only reminder", () => {
    const phone = daily.pushed.filter((x) => x.endpoint.endsWith('/teen-phone'));
    expect(phone).toHaveLength(1);
    // A count and a date — theirs, and nothing else.
    expect(JSON.parse(phone[0]?.payload ?? '')).toEqual({
      v: 1,
      type: 'digest',
      count: allowed.teen.length,
      date: '2026-09-22',
    });
    for (const title of Object.values(TITLES)) expect(phone[0]?.payload).not.toContain(title);
  });

  it('the ledger records a private reminder as reaching the one person who may read it', async () => {
    const ledger = await withSystem(db, hh, (trx) =>
      trx.selectFrom('reminder_delivery').select(['reminder_id', 'channel']).execute(),
    );
    const channels = (title: string) =>
      ledger
        .filter((l) => l.reminder_id === reminderOf[title])
        .map((l) => l.channel)
        .sort();
    expect(channels(TITLES.adultPrivate)).toEqual(withMailpit ? ['email', 'push'] : ['push']);
    expect(channels(TITLES.household)).toEqual(withMailpit ? ['email', 'push'] : ['push']);
  });

  it.skipIf(!withMailpit)(
    'every email is addressed to one person and names only what they may see',
    async () => {
      for (const who of Object.keys(people) as Who[]) {
        const mail = await inbox(email(who), 1);
        expect(mail, who).toHaveLength(1);
        const m = mail[0] as (typeof mail)[number];
        expect(
          m.To.map((t) => t.Address),
          who,
        ).toEqual([email(who)]);
        for (const title of forbidden(who))
          expect(m.text, `${who} saw ${title}`).not.toContain(title);
        // A private title is not in the email even of the person it
        // belongs to: the mail server is one an owner can point anywhere.
        // It is named only as what it is, and push carries the title.
        for (const title of allowed[who]) {
          if (title === TITLES.ownerPrivate || title === TITLES.adultPrivate) {
            expect(m.text, who).not.toContain(title);
            expect(m.text, who).toContain('One of your private documents');
          } else expect(m.text, who).toContain(title);
        }
      }
    },
    30_000,
  );

  it.skipIf(!withMailpit)(
    'the Sunday summary is cut the same way',
    async () => {
      vi.spyOn(webpush, 'sendNotification').mockResolvedValue({
        statusCode: 201,
        body: '',
        headers: {},
      });
      const digests: Digest[] = [];
      const real = createNotifier({
        app: db,
        vapid: null,
        smtpKey,
        baseUrl: 'https://vault.example.test',
        log: () => undefined,
      });
      // 27 Sep 2026 is a Sunday; the reminders are still open.
      const r = await weekly({
        admin,
        app: db,
        notifier: { digest: async (d) => (digests.push(d), real.digest(d)) },
        log: () => undefined,
        now: () => new Date('2026-09-27T18:05:00Z'),
        weeklyHour: 18,
      });
      expect(r).toEqual({ digests: 1 });
      for (const [who, p] of Object.entries(people) as Array<[Who, (typeof people)[Who]]>) {
        const mine = digests.find((d) => d.recipient.account_id === p.account);
        expect(mine?.items.map((i) => i.title).sort(), who).toEqual([...allowed[who]].sort());
      }
      const teenMail = await inbox(email('teen'), 2);
      const summary = teenMail.find((m) => m.Subject.startsWith('Your week'));
      expect(summary?.To.map((t) => t.Address)).toEqual([email('teen')]);
      for (const title of forbidden('teen')) expect(summary?.text).not.toContain(title);
    },
    30_000,
  );

  it('somebody who may see none of it is sent nothing at all', async () => {
    // Only private documents belonging to the owner are due today.
    await withSystem(db, hh, async (trx) => {
      const d = await trx
        .insertInto('document')
        .values({
          household_id: hh,
          title: 'Owner second secret',
          visibility: 'private',
          owner_member_id: people.owner.member,
          type_key: 'utility_bill',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('reminder')
        .values({
          household_id: hh,
          document_id: d.id,
          kind: 'manual',
          fire_at: '2026-09-23',
          status: 'due',
        })
        .execute();
    });
    const pushed: string[] = [];
    vi.spyOn(webpush, 'sendNotification').mockImplementation(async (sub) => {
      pushed.push(sub.endpoint);
      return { statusCode: 201, body: '', headers: {} };
    });
    const real = createNotifier({
      app: db,
      vapid: { ...vapid, subject: 'mailto:test@example.test' },
      smtpKey,
      baseUrl: 'x',
      log: () => undefined,
    });
    const r = await deliver({
      admin,
      app: db,
      notifier: real,
      log: () => undefined,
      now: () => new Date('2026-09-23T09:10:00Z'),
      digestHour: 9,
    });
    expect(r).toEqual({ digests: 1 });
    expect(pushed).toEqual([`https://push.example.test/${TAG}/owner`]);
  });

  /** A due reminder on a new document, for the tests below that need fresh ones. */
  const dueOn = async (
    title: string,
    visibility: 'household' | 'adults' | 'private',
    owner: string,
    fireAt: string,
  ) =>
    withSystem(db, hh, async (trx) => {
      const d = await trx
        .insertInto('document')
        .values({ household_id: hh, title, visibility, owner_member_id: owner })
        .returning('id')
        .executeTakeFirstOrThrow();
      const r = await trx
        .insertInto('reminder')
        .values({
          household_id: hh,
          document_id: d.id,
          kind: 'manual',
          fire_at: fireAt,
          status: 'due',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return r.id;
    });

  it('the ledger credits a reminder only with the channels of people who could read it', async () => {
    const shared = await dueOn('Water bill', 'household', people.owner.member, '2026-09-25');
    const secret = await dueOn('Adult second secret', 'private', people.adult.member, '2026-09-25');
    // Each person's "channel" is their own name, so the ledger shows whose
    // copy carried which reminder.
    const byAccount = Object.fromEntries(
      Object.entries(people).map(([who, p]) => [p.account, `to:${who}`]),
    );
    await deliver({
      admin,
      app: db,
      notifier: { digest: async (d) => [byAccount[d.recipient.account_id] as string] },
      log: () => undefined,
      now: () => new Date('2026-09-25T09:10:00Z'),
      digestHour: 9,
    });
    const ledger = await withSystem(db, hh, (trx) =>
      trx
        .selectFrom('reminder_delivery')
        .select(['reminder_id', 'channel'])
        .where('reminder_id', 'in', [shared, secret])
        .execute(),
    );
    const of = (id: string) =>
      ledger
        .filter((l) => l.reminder_id === id)
        .map((l) => l.channel)
        .sort();
    expect(of(secret)).toEqual(['to:adult']);
    expect(of(shared)).toEqual(['to:adult', 'to:owner', 'to:teen', 'to:viewer']);
  });

  it('whether a copy is a catch-up depends on what is in that copy', async () => {
    // Something of the owner's own has been waiting two days; everybody
    // else's list is only today's. "While nobody was looking" in the
    // teen's email would say something older is being kept from them.
    await dueOn('Owner overdue secret', 'private', people.owner.member, '2026-09-24');
    await dueOn('Bin collection', 'household', people.owner.member, '2026-09-26');
    const digests: Digest[] = [];
    await deliver({
      admin,
      app: db,
      notifier: { digest: async (d) => (digests.push(d), ['test']) },
      log: () => undefined,
      now: () => new Date('2026-09-26T09:10:00Z'),
      digestHour: 9,
    });
    const kindOf = (who: Who) =>
      digests.find((d) => d.recipient.account_id === people[who].account)?.kind;
    expect(kindOf('owner')).toBe('catch_up');
    expect(kindOf('adult')).toBe('daily');
    expect(kindOf('teen')).toBe('daily');
    expect(kindOf('viewer')).toBe('daily');
  });
});
