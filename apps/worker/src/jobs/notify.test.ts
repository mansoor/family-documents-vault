import { randomUUID } from 'node:crypto';
import { deriveKey } from '@fdv/crypto';
import { createDb, createPool, withHousehold, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNotifier, htmlBody, subject, textBody } from './notify.js';
import { weekly, type Digest } from './reminders.js';

const MASTER = 'notify-test-master-secret-at-least-32-bytes';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';

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
// Mailpit is shared with the API tests: send from a unique address and
// search for it rather than clearing the inbox.
const FROM = `worker-test-${Date.now()}@example.test`;

async function findMail(query: string, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(query)}&limit=5`);
    const body = (await r.json()) as {
      messages?: Array<{ Subject: string; To: Array<{ Address: string }> }>;
    };
    if (body.messages?.length) return body.messages[0];
    await new Promise((res) => setTimeout(res, 250));
  }
  return null;
}

const digest = (over: Partial<Digest> = {}): Digest => ({
  household_id: 'hh',
  household_name: 'The Seikh family',
  timezone: 'UTC',
  local_date: '2026-09-22',
  kind: 'daily',
  recipient: { account_id: 'acc', email: 'owner@example.test' },
  items: [
    {
      reminder_id: 'r1',
      document_id: 'd1',
      title: "Sana's passport",
      label: 'Overdue by 3 days',
      note: null,
      overdue: true,
    },
    {
      reminder_id: 'r2',
      document_id: 'd2',
      title: 'Car registration',
      label: 'In 12 days · 2 Oct',
      note: 'Renew online',
      overdue: false,
    },
  ],
  ...over,
});

describe('digest copy', () => {
  it('says how many things need attention, in plain words', () => {
    expect(subject(digest())).toBe('2 things need attention');
    expect(subject(digest({ items: [digest().items[0] as never] }))).toBe('1 thing has lapsed');
    expect(subject(digest({ kind: 'weekly' }))).toBe('Your week in The Seikh family');
  });

  it('the text and HTML carry every item, the note, and a link back', () => {
    const text = textBody(digest(), 'https://vault.example');
    expect(text).toContain("• Sana's passport — Overdue by 3 days");
    expect(text).toContain('• Car registration — In 12 days · 2 Oct (Renew online)');
    expect(text).toContain('https://vault.example');
    const html = htmlBody(digest(), 'https://vault.example');
    expect(html).toContain('Car registration');
    expect(html).toContain('Open your vault');
    // Titles are escaped, not injected.
    const nasty = htmlBody(
      digest({ items: [{ ...digest().items[0]!, title: '<script>x</script>' }] }),
      'x',
    );
    expect(nasty).not.toContain('<script>');
    expect(nasty).toContain('&lt;script&gt;');
  });

  it('the catch-up wording differs from the daily one', () => {
    expect(textBody(digest({ kind: 'catch_up' }), 'x')).toContain('While nobody was looking');
    expect(textBody(digest({ kind: 'weekly' }), 'x')).toContain('coming up in the next few weeks');
  });
});

describe.skipIf(!testAdminUrl())('notifier and the weekly summary', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  const hh = randomUUID();
  const smtpKey = deriveKey(MASTER, 'smtp-credentials');

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 3));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    await admin.query(
      "insert into household (id, name, timezone) values ($1, 'Notify household', 'UTC')",
      [hh],
    );
    const m = await admin.query<{ id: string }>(
      "insert into member (household_id, display_name) values ($1, 'M') returning id",
      [hh],
    );
    const a = await admin.query<{ id: string }>(
      "insert into account (email) values ('owner@example.test') returning id",
    );
    await admin.query(
      "insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, 'owner')",
      [a.rows[0]?.id, hh, m.rows[0]?.id],
    );
    await withHousehold(db, hh, async (trx) => {
      const d = await trx
        .insertInto('document')
        .values({
          household_id: hh,
          title: 'Home insurance',
          owner_member_id: m.rows[0]?.id as string,
          type_key: 'insurance_policy',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('reminder')
        .values({
          household_id: hh,
          document_id: d.id,
          kind: 'derived',
          fire_at: '2026-10-10',
          lead_days: 45,
          status: 'scheduled',
        })
        .execute();
    });
  });
  afterAll(async () => {
    await db.destroy();
    await admin.end();
    await tdb.drop();
  });

  it('with nowhere to send, the notifier reports no channels rather than throwing', async () => {
    const logs: unknown[] = [];
    const notifier = createNotifier({
      app: db,
      vapid: null,
      smtpKey,
      baseUrl: 'http://localhost:8080',
      log: (...a) => logs.push(a),
    });
    expect(await notifier.digest(digest({ household_id: hh }))).toEqual([]);
    expect(JSON.stringify(logs)).toContain('nowhere to go');
  });

  it('untested SMTP is never used', async () => {
    await withHousehold(db, hh, (trx) =>
      trx
        .insertInto('smtp_settings')
        .values({
          household_id: hh,
          host: '127.0.0.1',
          port: 1,
          from_email: 'v@example.test',
          status: 'untested',
        })
        .execute(),
    );
    const notifier = createNotifier({
      app: db,
      vapid: null,
      smtpKey,
      baseUrl: 'x',
      log: () => undefined,
    });
    expect(await notifier.digest(digest({ household_id: hh }))).toEqual([]);
  });

  it.skipIf(!withMailpit)(
    'a weekly summary reaches the people who asked for email',
    async () => {
      await withHousehold(db, hh, (trx) =>
        trx
          .updateTable('smtp_settings')
          .set({
            host: 'localhost',
            port: 1025,
            secure: false,
            status: 'ok',
            username: null,
            password_encrypted: null,
            from_email: FROM,
          })
          .where('household_id', '=', hh)
          .execute(),
      );
      const notifier = createNotifier({
        app: db,
        vapid: null,
        smtpKey,
        baseUrl: 'http://localhost:8080',
        log: () => undefined,
      });

      // A Sunday, 18:00 UTC.
      const sunday = new Date('2026-09-27T18:05:00Z');
      expect(new Date(sunday).getUTCDay()).toBe(0);
      const r = await weekly({
        admin,
        app: db,
        notifier,
        log: () => undefined,
        now: () => sunday,
        weeklyHour: 18,
      });
      expect(r).toEqual({ digests: 1 });

      const mail = await findMail(`from:${FROM}`);
      expect(mail?.Subject).toBe('Your week in Notify household');
      expect(mail?.To[0]?.Address).toBe('owner@example.test');

      // Once per Sunday, not once per run.
      expect(
        await weekly({
          admin,
          app: db,
          notifier,
          log: () => undefined,
          now: () => sunday,
          weeklyHour: 18,
        }),
      ).toEqual({ digests: 0 });
      // Not on other days.
      const monday = new Date('2026-09-28T18:05:00Z');
      expect(
        await weekly({
          admin,
          app: db,
          notifier,
          log: () => undefined,
          now: () => monday,
          weeklyHour: 18,
        }),
      ).toEqual({ digests: 0 });
    },
    30_000,
  );

  it.skipIf(!withMailpit)(
    'an encrypted password is decrypted for authentication',
    async () => {
      // Mailpit accepts any credentials; this proves the decrypt path runs
      // rather than throwing on a sealed blob.
      const { sealPassword } = await import('./seal-test-helper.js');
      const accountId = (await admin.query<{ id: string }>('select id from account limit 1'))
        .rows[0]?.id as string;
      await withHousehold(db, hh, async (trx) => {
        await trx
          .updateTable('smtp_settings')
          .set({ username: 'someone', password_encrypted: sealPassword(smtpKey, 'hunter2', hh) })
          .where('household_id', '=', hh)
          .execute();
        await trx
          .insertInto('notification_preference')
          .values({ account_id: accountId, household_id: hh, daily_email: true })
          .onConflict((oc) =>
            oc.columns(['account_id', 'household_id']).doUpdateSet({ daily_email: true }),
          )
          .execute();
      });
      const notifier = createNotifier({
        app: db,
        vapid: null,
        smtpKey,
        baseUrl: 'x',
        log: () => undefined,
      });
      expect(
        await notifier.digest(
          digest({
            household_id: hh,
            recipient: { account_id: accountId, email: 'owner@example.test' },
          }),
        ),
      ).toEqual(['email']);
    },
    30_000,
  );
});
