import { randomBytes, randomUUID } from 'node:crypto';
import net from 'node:net';
import { deriveKey, SMS_PASSWORD_PURPOSE, sealSmsPassword } from '@fdv/crypto';
import {
  createDb,
  createPool,
  SmsProviderError,
  withSystem,
  type Db,
  type SmsProviderFactory,
} from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendAlert, type Alert } from './alerts.js';
import { createNotifier } from './notify.js';
import { deliver, type Digest } from './reminders.js';
import { createTexter, isTextJob, type TextDeps, type TextJob } from './texts.js';

/**
 * Notifications by text (0.9.0, SMS2), as the worker sends them: against a
 * real database, through an SMS Gate that keeps what it is asked to send
 * and a mail server that keeps each subject. The day's reminders as one
 * text with a count, alerts to whoever asked, a link opened to its maker
 * once an hour; quiet hours kept by putting a text back on the queue; the
 * email digest instead when a text was the only way and could not go; and
 * every text through the one monthly cap.
 */

const MASTER = 'texts-test-master-key-with-32-bytes-or-more';
const smsKey = deriveKey(MASTER, SMS_PASSWORD_PURPOSE);
const smtpKey = deriveKey(MASTER, 'smtp-credentials');
const GATE = { mode: 'local', baseUrl: 'http://192.168.1.20:8080', username: 'sms' };

/** Just enough SMTP to take every message, keeping each subject. */
async function fakeSmtp() {
  const received: string[] = [];
  const server = net.createServer((sock) => {
    sock.setEncoding('utf8');
    let buf = '';
    let inData = false;
    const say = (line: string) => sock.write(`${line}\r\n`);
    say('220 fake ESMTP');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            say('250 queued');
          } else if (line.startsWith('Subject: ')) received.push(line.slice(9));
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'DATA') {
          inData = true;
          say('354 go ahead');
        } else if (verb === 'QUIT') {
          say('221 bye');
          sock.end();
        } else say('250 ok');
      }
    });
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as net.AddressInfo).port;
  return { port, received, close: () => new Promise((res) => server.close(res)) };
}

describe.skipIf(!testAdminUrl())('notifications by text (SMS2)', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  let smtp: Awaited<ReturnType<typeof fakeSmtp>>;
  /** What SMS Gate was asked to send, in order. */
  let texts: Array<{ to: string; text: string }> = [];
  /** Whether SMS Gate takes a text, or refuses it. */
  let gateWorks = true;
  /** What was put back on the queue, and until when. */
  let later: Array<{ job: TextJob; at: Date }> = [];
  let clock = new Date('2026-11-12T09:30:00Z');

  const gate: SmsProviderFactory = () => ({
    send: async (to, text) => {
      if (!gateWorks) throw new SmsProviderError('unreachable', 'the phone is off');
      texts.push({ to, text });
      return { id: `t-${texts.length}`, state: 'delivered' };
    },
    state: async () => ({ state: 'delivered' }),
  });
  const textDeps = (): TextDeps => ({
    app: db,
    smsKey,
    smtpKey,
    baseUrl: 'https://vault.example',
    provider: gate,
    later: async (job, at) => {
      expect(isTextJob(job)).toBe(true);
      later.push({ job, at });
    },
    log: () => undefined,
    now: () => clock,
  });
  const notifierWith = (deps: TextDeps) =>
    createNotifier({
      app: db,
      vapid: null,
      smtpKey,
      baseUrl: 'https://vault.example',
      log: () => undefined,
      texts: createTexter(deps),
    });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 4));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 2 });
    smtp = await fakeSmtp();
  });
  afterAll(async () => {
    await smtp?.close();
    await db?.destroy();
    await admin?.end();
    await tdb?.drop();
  });

  const one = async <T>(q: string, args: unknown[]) => (await admin.query(q, args)).rows[0] as T;

  interface Person {
    account: string;
    member: string;
    number: string | null;
  }

  /**
   * A household whose SMS Gate works (unless `sms` says otherwise), and its
   * people: each with a number (confirmed unless said), and what they want.
   */
  async function household(opts: {
    sms?: 'ok' | 'untested' | 'none';
    cap?: number;
    mail?: boolean;
    people: Array<{
      role?: string;
      number?: string | null;
      confirmed?: boolean;
      prefs?: Record<string, unknown>;
    }>;
  }): Promise<{ hh: string; people: Person[] }> {
    const hh = randomUUID();
    await admin.query("insert into household (id, name, timezone) values ($1, 'Texts', 'UTC')", [
      hh,
    ]);
    const people: Person[] = [];
    for (const [i, p] of opts.people.entries()) {
      const m = await one<{ id: string }>(
        'insert into member (household_id, display_name) values ($1, $2) returning id',
        [hh, `Person ${i}`],
      );
      const a = await one<{ id: string }>('insert into account (email) values ($1) returning id', [
        `p${i}-${hh}@example.test`,
      ]);
      await admin.query(
        'insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, $4)',
        [a.id, hh, m.id, p.role ?? (i === 0 ? 'owner' : 'adult')],
      );
      // A number each, unless said: +447700900100, +447700900101, …
      const number = p.number === undefined ? `+4477009001${String(i).padStart(2, '0')}` : p.number;
      if (number) {
        await admin.query(
          'insert into member_phone (member_id, household_id, number, confirmed_at) values ($1, $2, $3, $4)',
          [m.id, hh, number, p.confirmed === false ? null : new Date()],
        );
      }
      if (p.prefs) {
        const keys = Object.keys(p.prefs);
        await admin.query(
          `insert into notification_preference (account_id, household_id, ${keys.join(', ')})
           values ($1, $2, ${keys.map((_, k) => `$${k + 3}`).join(', ')})`,
          [a.id, hh, ...Object.values(p.prefs)],
        );
      }
      people.push({ account: a.id, member: m.id, number });
    }
    if ((opts.sms ?? 'ok') !== 'none') {
      await admin.query(
        `insert into sms_settings (household_id, mode, base_url, username, password_encrypted, monthly_cap, status)
         values ($1, 'local', $2, $3, $4, $5, $6)`,
        [
          hh,
          GATE.baseUrl,
          GATE.username,
          sealSmsPassword(smsKey, 'gate-secret', hh, GATE),
          opts.cap ?? 200,
          opts.sms ?? 'ok',
        ],
      );
    }
    if (opts.mail) {
      await admin.query(
        `insert into smtp_settings (household_id, host, port, from_email, status)
         values ($1, '127.0.0.1', $2, 'vault@example.test', 'ok')`,
        [hh, smtp.port],
      );
    }
    return { hh, people };
  }

  const fresh = (at = '2026-11-12T09:30:00Z') => {
    texts = [];
    later = [];
    gateWorks = true;
    smtp.received.length = 0;
    clock = new Date(at);
  };

  const logged = (hh: string) =>
    withSystem(db, hh, (trx) =>
      trx
        .selectFrom('sms_message')
        .select(['kind', 'member_id', 'number_tail', 'state'])
        .orderBy('created_at')
        .execute(),
    );

  const digestFor = (hh: string, p: Person, n = 2): Digest => ({
    household_id: hh,
    household_name: 'Texts',
    timezone: 'UTC',
    local_date: '2026-11-12',
    kind: 'daily',
    recipient: { account_id: p.account, email: `${p.account}@example.test` },
    items: Array.from({ length: n }, (_, i) => ({
      reminder_id: `r${i}`,
      document_id: `d${i}`,
      title: `Secret title ${i}`,
      label: 'Due today',
      about: null,
      note: 'A private note',
      overdue: false,
      private: false,
    })),
  });

  it('the day’s reminders: one text with the count, to the confirmed number, and never a title', async () => {
    fresh();
    const { hh, people } = await household({
      people: [
        { prefs: { daily_text: true } },
        {},
        { prefs: { daily_text: true }, confirmed: false },
      ],
    });
    const notifier = notifierWith(textDeps());
    const [asked, notAsked, unconfirmed] = people as [Person, Person, Person];
    expect(await notifier.digest(digestFor(hh, asked))).toEqual(['sms']);
    expect(texts).toEqual([
      {
        to: asked.number,
        text: 'Family Vault: 2 documents need attention today. Open the app to see them.',
      },
    ]);
    // Somebody who did not ask: nothing.
    expect(await notifier.digest(digestFor(hh, notAsked))).toEqual([]);
    // Somebody whose number waits for its code: no text, and with no mail
    // server nothing to make up for it with.
    expect(await notifier.digest(digestFor(hh, unconfirmed))).toEqual([]);
    expect(texts).toHaveLength(1);
    expect(JSON.stringify(texts)).not.toMatch(/Secret title|private note/);
    expect(await logged(hh)).toEqual([
      { kind: 'reminders', member_id: asked.member, number_tail: '100', state: 'delivered' },
    ]);
    // One thing, said as one.
    texts = [];
    await notifier.digest(digestFor(hh, asked, 1));
    expect(texts[0]?.text).toBe(
      'Family Vault: 1 document needs attention today. Open the app to see it.',
    );
  });

  it('deliver: the ledger counts the text as sent, and a second run sends nothing', async () => {
    fresh('2026-11-12T09:10:00Z');
    const { hh, people } = await household({ people: [{ prefs: { daily_text: true } }] });
    const owner = people[0] as Person;
    await withSystem(db, hh, async (trx) => {
      const d = await trx
        .insertInto('document')
        .values({ household_id: hh, title: 'Passport', owner_member_id: owner.member })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('reminder')
        .values({
          household_id: hh,
          document_id: d.id,
          kind: 'manual',
          fire_at: '2026-11-12',
          status: 'due',
        })
        .execute();
    });
    const deps = {
      admin,
      app: db,
      notifier: notifierWith(textDeps()),
      log: () => undefined,
      now: () => clock,
      digestHour: 9,
    };
    expect((await deliver(deps)).digests).toBeGreaterThanOrEqual(1);
    expect(texts.filter((t) => t.to === owner.number)).toHaveLength(1);
    const ledger = await withSystem(db, hh, (trx) =>
      trx.selectFrom('notification_digest').select(['channels']).execute(),
    );
    expect(ledger).toEqual([{ channels: ['sms'] }]);
    const delivered = await withSystem(db, hh, (trx) =>
      trx.selectFrom('reminder_delivery').select('channel').execute(),
    );
    expect(delivered).toEqual([{ channel: 'sms' }]);
    clock = new Date('2026-11-12T10:10:00Z');
    await deliver(deps);
    expect(texts.filter((t) => t.to === owner.number)).toHaveLength(1);
  });

  it('in quiet hours the text waits on the queue until they end, then goes once', async () => {
    fresh('2026-11-12T22:15:00Z');
    const { hh, people } = await household({
      people: [
        { prefs: { daily_text: true } },
        { prefs: { daily_text: true, quiet_from: '23:00', quiet_to: '06:30' } },
      ],
    });
    const [usual, own] = people as [Person, Person];
    const deps = textDeps();
    const notifier = notifierWith(deps);
    // 22:15: quiet for the first (21:00 to 08:00), not yet for the second.
    expect(await notifier.digest(digestFor(hh, usual))).toEqual(['sms']);
    expect(await notifier.digest(digestFor(hh, own))).toEqual(['sms']);
    expect(texts.map((t) => t.to)).toEqual([own.number]);
    expect(later).toHaveLength(1);
    expect(later[0]?.at.toISOString()).toBe('2026-11-13T08:00:00.000Z');
    expect(later[0]?.job).toEqual({
      kind: 'reminders',
      household_id: hh,
      account_id: usual.account,
      count: 2,
      all_documents: true,
      alone: true,
    });
    // Its own quiet hours, past midnight.
    clock = new Date('2026-11-13T02:00:00Z');
    expect(await notifier.digest(digestFor(hh, own))).toEqual(['sms']);
    expect(later[1]?.at.toISOString()).toBe('2026-11-13T06:30:00.000Z');
    // At eight, the job runs: the text goes.
    clock = new Date('2026-11-13T08:00:00Z');
    expect(await createTexter(deps).run(later[0]?.job as TextJob)).toBe('sent');
    expect(texts.map((t) => t.to)).toEqual([own.number, usual.number]);
  });

  it('a text that cannot go is made up for by the email digest, only when nothing else reached them', async () => {
    fresh();
    const { hh, people } = await household({
      cap: 1,
      mail: true,
      people: [
        { prefs: { daily_text: true, daily_email: false } },
        { prefs: { daily_text: true, daily_email: true } },
      ],
    });
    const [textOnly, both] = people as [Person, Person];
    const notifier = notifierWith(textDeps());
    // The month's one text spent.
    expect(await notifier.digest(digestFor(hh, textOnly))).toEqual(['sms']);
    expect(smtp.received).toEqual([]);
    // The cap reached: the text cannot go, and they hear by email instead.
    expect(await notifier.digest(digestFor(hh, textOnly))).toEqual(['email']);
    expect(smtp.received).toEqual(['2 things need attention']);
    // Somebody who has email anyway: the one email, never two.
    expect(await notifier.digest(digestFor(hh, both))).toEqual(['email']);
    expect(smtp.received).toHaveLength(2);
    expect(texts).toHaveLength(1);
    // SMS Gate refusing it is the same: the email instead.
    await admin.query('update sms_settings set monthly_cap = 100 where household_id = $1', [hh]);
    gateWorks = false;
    expect(await notifier.digest(digestFor(hh, textOnly))).toEqual(['email']);
    expect(smtp.received).toHaveLength(3);
    expect((await logged(hh)).map((r) => r.state)).toEqual(['delivered', 'not_sent']);
  });

  it('texts only while the household’s texts are set up and tested', async () => {
    fresh();
    const { hh, people } = await household({
      sms: 'untested',
      mail: true,
      people: [{ prefs: { daily_text: true } }],
    });
    const notifier = notifierWith(textDeps());
    // Untested: no text, and the email instead.
    expect(await notifier.digest(digestFor(hh, people[0] as Person))).toEqual(['email']);
    expect(texts).toEqual([]);
    expect(await logged(hh)).toEqual([]);
    // A text waiting for quiet hours finds texts not set up: emailed instead.
    expect(
      await createTexter(textDeps()).run({
        kind: 'reminders',
        household_id: hh,
        account_id: (people[0] as Person).account,
        count: 3,
        all_documents: false,
        alone: true,
      }),
    ).toBe('failed');
    expect(smtp.received.at(-1)).toBe('Reminders from your vault');
  });

  it('alerts text those who asked, keep quiet hours unless about their own sign-in, and never the operator’s', async () => {
    fresh('2026-11-12T23:00:00Z');
    const { hh, people } = await household({
      people: [
        { prefs: { alerts_text: true } },
        { prefs: { alerts_text: false } },
        { prefs: { alerts_text: true } },
      ],
    });
    const [a, b, c] = people as [Person, Person, Person];
    const deps = textDeps();
    const alertDeps = {
      app: db,
      vapid: null,
      smtpKey,
      linkKey: randomBytes(32),
      baseUrl: 'https://vault.example',
      log: () => undefined,
      texts: createTexter(deps),
    };
    const alert = (over: Partial<Alert>): Alert => ({
      household_id: hh,
      account_ids: [a.account, b.account],
      subject: 'Sara Seikh did something',
      body: 'Body with details',
      ...over,
    });
    // About their own sign-in: at once, in quiet hours too, to whoever asked.
    expect(await sendAlert(alertDeps, alert({ text_kind: 'new_device' }))).toEqual(['sms']);
    expect(texts).toEqual([
      { to: a.number, text: 'Family Vault: a new device signed in to your account.' },
    ]);
    // Anything else waits for the quiet hours to end, and says only that there is news.
    texts = [];
    expect(await sendAlert(alertDeps, alert({ account_ids: [c.account] }))).toEqual(['sms']);
    expect(texts).toEqual([]);
    expect(later).toEqual([
      {
        job: { kind: 'alert', household_id: hh, account_id: c.account, text_kind: 'news' },
        at: new Date('2026-11-13T08:00:00Z'),
      },
    ]);
    clock = new Date('2026-11-13T08:00:00Z');
    expect(await createTexter(deps).run(later[0]?.job as TextJob)).toBe('sent');
    expect(texts).toEqual([
      { to: c.number, text: 'Family Vault: there is news about your vault in your email.' },
    ]);
    // By the operator's mail alone (a reset's link): never texted.
    texts = [];
    await sendAlert(alertDeps, alert({ via: 'operator', text_kind: 'reset_started' }));
    expect(texts).toEqual([]);
    expect(JSON.stringify(await logged(hh))).not.toMatch(/Sara|Body/);
  });

  it('a link opened: its maker is texted once, not again within the hour, and never its title', async () => {
    fresh('2026-11-12T10:00:00Z');
    const { hh, people } = await household({
      people: [{ prefs: { share_opened_text: true } }, {}],
    });
    const [maker, other] = people as [Person, Person];
    const doc = await one<{ id: string }>(
      "insert into document (household_id, title, owner_member_id) values ($1, 'Will and testament', $2) returning id",
      [hh, maker.member],
    );
    const link = async (by: string, label: string | null) =>
      (
        await one<{ id: string }>(
          `insert into share_link (household_id, document_id, token_hash, created_by, expires_at, recipient_label)
           values ($1, $2, $3, $4, now() + interval '7 days', $5) returning id`,
          [hh, doc.id, randomBytes(32), by, label],
        )
      ).id;
    const agent = await link(maker.account, 'the letting agent');
    const texter = createTexter(textDeps());
    const opened = (share: string): TextJob => ({
      kind: 'share_opened',
      household_id: hh,
      share_id: share,
    });
    expect(await texter.run(opened(agent))).toBe('sent');
    expect(texts).toEqual([
      {
        to: maker.number,
        text: 'Family Vault: the link you shared for the letting agent was opened.',
      },
    ]);
    // Opened again within the hour: not again.
    clock = new Date('2026-11-12T10:40:00Z');
    expect(await texter.run(opened(agent))).toBe('off');
    expect(texts).toHaveLength(1);
    // An hour on, it may.
    clock = new Date('2026-11-12T11:01:00Z');
    expect(await texter.run(opened(agent))).toBe('sent');
    expect(texts).toHaveLength(2);
    // Somebody else's link, who did not ask: nothing.
    expect(await texter.run(opened(await link(other.account, null)))).toBe('off');
    // No label: "someone"; and in quiet hours it waits.
    const unnamed = await link(maker.account, null);
    clock = new Date('2026-11-12T23:30:00Z');
    expect(await texter.run(opened(unnamed))).toBe('later');
    expect(later.at(-1)?.at.toISOString()).toBe('2026-11-13T08:00:00.000Z');
    clock = new Date('2026-11-13T08:00:00Z');
    expect(await texter.run(opened(unnamed))).toBe('sent');
    expect(texts.at(-1)?.text).toBe('Family Vault: the link you shared for someone was opened.');
    expect(JSON.stringify(texts)).not.toContain('Will and testament');
    expect((await logged(hh)).map((r) => r.kind)).toEqual([
      'share_opened',
      'share_opened',
      'share_opened',
    ]);
  });

  it('every kind counts against the one monthly cap', async () => {
    fresh();
    const { hh, people } = await household({
      cap: 2,
      people: [{ prefs: { daily_text: true, alerts_text: true, share_opened_text: true } }],
    });
    const owner = people[0] as Person;
    const texter = createTexter(textDeps());
    expect(await texter.digest(digestFor(hh, owner), ['push'])).toBe('sent');
    expect(
      await texter.alert({
        household_id: hh,
        account_ids: [owner.account],
        subject: 's',
        body: 'b',
        text_kind: 'locked',
      }),
    ).toBe(1);
    // The month's two are sent: a third, of any kind, is not.
    expect(
      await texter.alert({
        household_id: hh,
        account_ids: [owner.account],
        subject: 's',
        body: 'b',
        text_kind: 'unlocked',
      }),
    ).toBe(0);
    expect(texts).toHaveLength(2);
    expect((await logged(hh)).map((r) => r.kind)).toEqual(['reminders', 'alert']);
  });
});
