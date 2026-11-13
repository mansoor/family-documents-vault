import { randomBytes, randomUUID } from 'node:crypto';
import { deriveKey, SMS_PASSWORD_PURPOSE, sealSmsPassword } from '@fdv/crypto';
import { createDb, createPool, withSystem, type Db, type SmsProviderFactory } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import nodemailer from 'nodemailer';
import pg from 'pg';
import webpush from 'web-push';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createNotifier } from './notify.js';
import { deliver, weekly, type Digest } from './reminders.js';
import { createTexter } from './texts.js';

/**
 * Neutral wording in notifications and email (0.9.0, H2), from the side of
 * whoever must not read the words: the mail server an owner can point
 * anywhere, the lock screen anybody holding the phone reads, and the text
 * that goes through the household's SMS Gate.
 *
 * Every combination is sent for real — the household's choice (Off, Health
 * documents only, Sensitive documents only, All documents) × each person's
 * own (as the household says, Health, Sensitive, All) × documents Health
 * and not sensitive, sensitive and not Health, both, and neither — each by
 * its own choice or its kind's, the kind's as the household has set it — and
 * Only me — through every channel that leaves the vault: the email digest
 * (and the Sunday summary), the email sent instead of a text that could not
 * go, a browser's push, a phone's push, and the day's text. What each
 * person should see is written out here, not asked of the code under test.
 */

const MASTER = 'neutral-wording-test-master-secret-32-bytes';
const smtpKey = deriveKey(MASTER, 'smtp-credentials');
const smsKey = deriveKey(MASTER, SMS_PASSWORD_PURPOSE);
const GATE = { mode: 'local', baseUrl: 'http://192.168.1.20:8080', username: 'sms' };

const NEUTRAL = 'A reminder about a document';
const PRIVATE = 'One of your private documents';

type Rule = 'off' | 'health' | 'sensitive' | 'all';
type Mine = 'household' | 'health' | 'sensitive' | 'all';
const RULES: Rule[] = ['off', 'health', 'sensitive', 'all'];

/** A household's own kind, which it set to Sensitive. */
const OWN_KIND = 'h_lockboxes';

/**
 * The family's documents everybody sees: whether each is sensitive and
 * whether Health, and why. This household turned Sensitive by default off
 * for passports and on for utility bills (document_type_setting).
 */
const SHARED = [
  // Neither: an insurance policy's kind is neither.
  {
    title: 'Riverside home cover',
    type: 'insurance_policy',
    own: null,
    category: null,
    sensitive: false,
    health: false,
  },
  // Neither: a passport, which the household made not sensitive by default.
  {
    title: 'Expired Quokka passport',
    type: 'passport',
    own: null,
    category: null,
    sensitive: false,
    health: false,
  },
  // Health, not sensitive: a medical record marked not sensitive.
  {
    title: 'Clinic letter Zebra',
    type: 'medical_record',
    own: false,
    category: null,
    sensitive: false,
    health: true,
  },
  // Health by its own category, chosen on a kind that is not Medical.
  {
    title: 'Physio note Walrus',
    type: 'other',
    own: false,
    category: 'medical',
    sensitive: false,
    health: true,
  },
  // Sensitive, not Health: a bill, which the household made sensitive by default.
  {
    title: 'Riverside water bill',
    type: 'utility_bill',
    own: null,
    category: null,
    sensitive: true,
    health: false,
  },
  // Sensitive, not Health: the household's own kind, set to Sensitive.
  {
    title: 'Lockbox inventory Yak',
    type: OWN_KIND,
    own: null,
    category: null,
    sensitive: true,
    health: false,
  },
  // Both: a prescription, Medical and sensitive by its kind.
  {
    title: 'Ayesha prescription',
    type: 'prescription',
    own: null,
    category: null,
    sensitive: true,
    health: true,
  },
] as const;

/** Each person, their own wording, and how they hear. */
const PEOPLE = [
  { key: 'owner', role: 'owner', mine: 'household' },
  { key: 'healthy', role: 'adult', mine: 'health' },
  { key: 'strict', role: 'adult', mine: 'sensitive' },
  { key: 'strictest', role: 'adult', mine: 'all' },
  // Asked for the day's reminders by text alone, with no number: the
  // email digest goes instead.
  { key: 'sam', role: 'adult', mine: 'household' },
] as const;
type Key = (typeof PEOPLE)[number]['key'];

/** A line of a document someone may see, as the matrix says it should be told. */
interface Doc {
  title: string;
  note: string;
  sensitive: boolean;
  health: boolean;
  private: boolean;
  /** Whose Only me document it is. */
  of: Key | null;
  /** The date words its reminder is about, as the digest worked them out. */
  about?: string | null;
}

/** Whether one choice leaves a document unnamed. */
const hides = (rule: Rule | Mine, d: Doc): boolean =>
  rule === 'all' || (rule === 'sensitive' && d.sensitive) || (rule === 'health' && d.health);

/** Named only when neither the household's choice nor the person's hides it, and not Only me. */
const named = (d: Doc, household: Rule, mine: Mine) =>
  !d.private && !hides(household, d) && !hides(mine, d);

/** No uuid left to match a word or a digit by chance. */
const noIds = (s: string) =>
  s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>');

describe.skipIf(!testAdminUrl())('neutral wording, as it is sent (H2)', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  let today = '';
  const vapid = webpush.generateVAPIDKeys();

  interface House {
    hh: string;
    rule: Rule;
    people: Record<
      Key,
      { account: string; member: string; email: string; mine: Mine; number: string | null }
    >;
    docs: Doc[];
  }

  const one = async <T>(q: string, args: unknown[]) => (await admin.query(q, args)).rows[0] as T;

  async function house(rule: Rule, n: number): Promise<House> {
    const hh = randomUUID();
    await admin.query(
      'insert into household (id, name, timezone, neutral_wording) values ($1, $2, $3, $4)',
      [hh, `The ${rule} family`, 'UTC', rule],
    );
    // The household's kinds as it has them: its own kind set to Sensitive,
    // passports not sensitive by default, utility bills sensitive.
    await admin.query(
      `insert into document_type (key, household_id, label, category, sensitive_default)
       values ($1, $2, 'Lockbox', 'other', true)`,
      [`${OWN_KIND}${'abcd'[n]}`, hh],
    );
    await admin.query(
      `insert into document_type_setting (household_id, type_key, sensitive_default)
       values ($1, 'passport', false), ($1, 'utility_bill', true)`,
      [hh],
    );
    const people = {} as House['people'];
    for (const [i, p] of PEOPLE.entries()) {
      const member = await one<{ id: string }>(
        'insert into member (household_id, display_name) values ($1, $2) returning id',
        [hh, `Person ${p.key}`],
      );
      const email = `${p.key}-${rule}-${hh.slice(0, 8)}@example.test`;
      const account = await one<{ id: string }>(
        'insert into account (email) values ($1) returning id',
        [email],
      );
      await admin.query(
        'insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, $4)',
        [account.id, hh, member.id, p.role],
      );
      // Everybody but Sam: email every day, a text, a confirmed number, a
      // browser and a phone. Sam: a text alone, and no number to send it to.
      const sam = p.key === 'sam';
      await admin.query(
        `insert into notification_preference
           (account_id, household_id, daily_email, daily_text, neutral_wording)
         values ($1, $2, $3, true, $4)`,
        [account.id, hh, !sam, p.mine === 'household' ? null : p.mine],
      );
      const number = sam ? null : `+44770090${n}${i}0`;
      if (number) {
        await admin.query(
          'insert into member_phone (member_id, household_id, number, confirmed_at) values ($1, $2, $3, now())',
          [member.id, hh, number],
        );
      }
      people[p.key] = { account: account.id, member: member.id, email, mine: p.mine, number };
    }
    await admin.query(
      `insert into sms_settings (household_id, mode, base_url, username, password_encrypted, monthly_cap, status)
       values ($1, 'local', $2, $3, $4, 500, 'ok')`,
      [hh, GATE.baseUrl, GATE.username, sealSmsPassword(smsKey, 'gate-secret', hh, GATE)],
    );
    const docs: Doc[] = [];
    await withSystem(db, hh, async (trx) => {
      const remind = async (
        title: string,
        type: string,
        own: boolean | null,
        category: string | null,
        visibility: 'household' | 'private',
        owner: string,
        lead: number,
      ) => {
        const d = await trx
          .insertInto('document')
          .values({
            household_id: hh,
            title,
            type_key: type === OWN_KIND ? `${OWN_KIND}${'abcd'[n]}` : type,
            visibility,
            owner_member_id: owner,
            sensitive: own,
            category,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        // Due today, each about a different day: their words never alike.
        await trx
          .insertInto('reminder')
          .values({
            household_id: hh,
            document_id: d.id,
            kind: 'derived',
            source: 'expires',
            fire_at: today,
            lead_days: lead,
            status: 'due',
            note: `Note about ${title}`,
          })
          .execute();
      };
      let lead = 7;
      for (const s of SHARED) {
        await remind(s.title, s.type, s.own, s.category, 'household', people.owner.member, lead++);
        docs.push({
          title: s.title,
          note: `Note about ${s.title}`,
          sensitive: s.sensitive,
          health: s.health,
          private: false,
          of: null,
        });
      }
      for (const p of PEOPLE) {
        const title = `Lonely ${p.key} ${rule} letter`;
        // Neither sensitive nor Health: Only me alone keeps it unnamed.
        await remind(
          title,
          'insurance_policy',
          false,
          null,
          'private',
          people[p.key].member,
          lead++,
        );
        docs.push({
          title,
          note: `Note about ${title}`,
          sensitive: false,
          health: false,
          private: true,
          of: p.key,
        });
      }
      for (const p of PEOPLE) {
        if (p.key === 'sam') continue;
        const session = await trx
          .insertInto('session')
          .values({
            account_id: people[p.key].account,
            household_id: hh,
            refresh_hash: randomBytes(32),
            expires_at: new Date(Date.now() + 30 * 864e5),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        for (const kind of ['web_push', 'unified_push'] as const) {
          await trx
            .insertInto('device')
            .values({
              household_id: hh,
              account_id: people[p.key].account,
              kind,
              endpoint: `https://push.example.test/${hh}/${p.key}/${kind}`,
              p256dh: 'test-key',
              auth: 'test-auth',
              session_id: session.id,
            })
            .execute();
        }
      }
      await trx
        .insertInto('smtp_settings')
        .values({
          household_id: hh,
          host: 'mail.example.test',
          port: 25,
          secure: false,
          from_email: 'vault@example.test',
          status: 'ok',
        })
        .execute();
    });
    return { hh, rule, people, docs };
  }

  /** Whatever left the vault, captured where it would have gone out. */
  interface Sent {
    digests: Digest[];
    mails: Array<{ to: string; subject: string; text: string; html: string }>;
    pushes: Array<{ endpoint: string; payload: string }>;
    texts: Array<{ to: string; text: string }>;
  }

  /** Every household's digests, sent as the worker sends them. */
  async function run(which: 'daily' | 'weekly'): Promise<Sent> {
    const sent: Sent = { digests: [], mails: [], pushes: [], texts: [] };
    vi.spyOn(webpush, 'sendNotification').mockImplementation(async (sub, payload) => {
      sent.pushes.push({ endpoint: sub.endpoint, payload: String(payload) });
      return { statusCode: 201, body: '', headers: {} };
    });
    // The household's mail server, as nodemailer is handed each message:
    // its words before any encoding, so a title split across a line by
    // quoted-printable could not slip past.
    vi.spyOn(nodemailer, 'createTransport').mockImplementation(
      () =>
        ({
          sendMail: async (m: { to: string; subject: string; text: string; html?: string }) => {
            sent.mails.push({ to: m.to, subject: m.subject, text: m.text, html: m.html ?? '' });
            return {};
          },
          close: () => undefined,
        }) as never,
    );
    const gate: SmsProviderFactory = () => ({
      send: async (to, text) => {
        sent.texts.push({ to, text });
        return { id: `t-${sent.texts.length}`, state: 'delivered' };
      },
      state: async () => ({ state: 'delivered' }),
    });
    const now =
      which === 'daily' ? new Date(`${today}T10:00:00Z`) : new Date(`${sunday()}T18:05:00Z`);
    const texts = createTexter({
      app: db,
      smsKey,
      smtpKey,
      baseUrl: 'https://vault.example.test',
      provider: gate,
      later: async () => {
        throw new Error('nothing waits for quiet hours at ten in the morning');
      },
      log: () => undefined,
      now: () => now,
    });
    const real = createNotifier({
      app: db,
      vapid: { ...vapid, subject: 'mailto:test@example.test' },
      smtpKey,
      baseUrl: 'https://vault.example.test',
      log: () => undefined,
      texts,
    });
    const notifier = { digest: async (d: Digest) => (sent.digests.push(d), real.digest(d)) };
    const deps = { admin, app: db, notifier, log: () => undefined, now: () => now };
    const r =
      which === 'daily'
        ? await deliver({ ...deps, digestHour: 9 })
        : await weekly({ ...deps, weeklyHour: 18 });
    vi.restoreAllMocks();
    expect(r.digests).toBe(RULES.length);
    // Each item's date words, as the digest worked them out: what an
    // unnamed line must not carry either.
    for (const h of Object.values(houses)) {
      for (const d of sent.digests) {
        if (d.household_id !== h.hh) continue;
        for (const i of d.items) {
          const doc = h.docs.find((x) => x.title === i.title);
          if (doc) doc.about = i.about;
        }
      }
    }
    return sent;
  }

  /** What of `sent` was this household's. */
  const of = (h: House, sent: Sent): Sent => {
    const emails = new Set(Object.values(h.people).map((p) => p.email));
    const numbers = new Set(Object.values(h.people).map((p) => p.number));
    return {
      digests: sent.digests.filter((d) => d.household_id === h.hh),
      mails: sent.mails.filter((m) => emails.has(m.to)),
      pushes: sent.pushes.filter((p) => p.endpoint.includes(h.hh)),
      texts: sent.texts.filter((t) => numbers.has(t.to)),
    };
  };

  /** The coming Sunday on the household's calendar, today if it is one. */
  const sunday = () => {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7));
    return d.toISOString().slice(0, 10);
  };

  /** What this person may read of each document they can see, under their rule. */
  const sees = (h: House, who: Key) => h.docs.filter((d) => !d.private || d.of === who);

  /** Every document's words that must not be in what went to `who`. */
  function hidden(h: House, who: Key): string[] {
    return h.docs.flatMap((d) => {
      const theirs = !d.private || d.of === who;
      if (theirs && named(d, h.rule, h.people[who].mine)) return [];
      return [d.title, d.note, ...(d.about ? [d.about] : [])];
    });
  }

  const houses: Partial<Record<Rule, House>> = {};
  const daily: Partial<Record<Rule, Sent>> = {};

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 4));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 2 });
    today = (await one<{ today: string }>('select current_date::text as today', [])).today;
    for (const [n, rule] of RULES.entries()) {
      houses[rule] = await house(rule, n);
    }
    // One run delivers every household's digest; each is read apart.
    const all = await run('daily');
    for (const rule of RULES) {
      daily[rule] = of(houses[rule] as House, all);
    }
  }, 120_000);
  afterAll(async () => {
    vi.restoreAllMocks();
    await db?.destroy();
    await admin?.end();
    await tdb?.drop();
  });

  const cases = RULES.flatMap((rule) => PEOPLE.map((p) => [rule, p.key] as const));

  it('each digest carries its choices: the household’s, and the person’s own beside it', () => {
    // Every reminder is about a date in its kind's words, so an unnamed
    // line's missing them is tested too.
    for (const h of Object.values(houses)) {
      for (const d of h.docs) expect(d.about, d.title).toMatch(/in \d+ days/);
    }
    for (const [rule, who] of cases) {
      const h = houses[rule] as House;
      const d = daily[rule]?.digests.find((x) => x.recipient.account_id === h.people[who].account);
      const mine = h.people[who].mine;
      expect(d?.wording, `${rule}/${who}`).toEqual(
        mine === 'household' || mine === rule ? [rule] : [rule, mine],
      );
      // And each item whether it is sensitive and whether Health, as its own
      // choice or its kind says, the kind as the household has it.
      for (const i of d?.items ?? []) {
        const doc = h.docs.find((x) => x.title === i.title);
        expect([i.sensitive, i.health], i.title).toEqual([doc?.sensitive, doc?.health]);
      }
    }
  });

  it.each(cases)(
    'household %s, %s: the email names only what may be named, and nothing else of the rest',
    (rule, who) => {
      const h = houses[rule] as House;
      const me = h.people[who];
      const mail = daily[rule]?.mails.filter((m) => m.to === me.email) ?? [];
      // Sam asked for a text and has no number: the digest came instead.
      expect(mail, `${rule}/${who}`).toHaveLength(1);
      const m = mail[0] as Sent['mails'][number];
      const words = noIds(`${m.subject}\n${m.text}\n${m.html}`);
      for (const w of hidden(h, who)) expect(words, `${rule}/${who} read “${w}”`).not.toContain(w);
      let unnamed = 0;
      let mineHidden = 0;
      for (const d of sees(h, who)) {
        if (named(d, rule, me.mine)) {
          expect(m.text, d.title).toContain(d.title);
          expect(m.text, d.title).toContain(d.note);
          expect(m.html, d.title).toContain(d.about ?? '');
        } else if (d.private) mineHidden++;
        else unnamed++;
      }
      // The neutral lines keep when each is due, and nothing more.
      const lines = m.text.split('\n').filter((l) => l.startsWith('• '));
      expect(lines.filter((l) => l === `• ${NEUTRAL} — Due today`)).toHaveLength(unnamed);
      expect(lines.filter((l) => l === `• ${PRIVATE} — Due today`)).toHaveLength(mineHidden);
      expect(mineHidden).toBe(1);
      expect(m.subject).toBe(`${sees(h, who).length} things need attention`);
    },
  );

  it.each(cases)(
    'household %s, %s: a browser’s push says no more than the email may, Only me included',
    (rule, who) => {
      const h = houses[rule] as House;
      const me = h.people[who];
      const browser = daily[rule]?.pushes.filter((p) => p.endpoint.endsWith(`/${who}/web_push`));
      if (who === 'sam') {
        expect(browser).toEqual([]);
        return;
      }
      expect(browser, `${rule}/${who}`).toHaveLength(1);
      const payload = noIds(browser?.[0]?.payload ?? '');
      for (const w of hidden(h, who)) expect(payload, `${rule}/${who} saw “${w}”`).not.toContain(w);
      const body = (JSON.parse(browser?.[0]?.payload ?? '{}') as { body: string }).body;
      const allowed = new Set([
        `${NEUTRAL} — Due today`,
        `${PRIVATE} — Due today`,
        ...sees(h, who)
          .filter((d) => named(d, rule, me.mine))
          .map((d) => `${d.title} — ${d.about ?? 'Due today'}`),
      ]);
      const lines = body.split('\n');
      expect(lines).toHaveLength(3);
      for (const l of lines) expect(allowed, l).toContain(l);
    },
  );

  it.each(cases)(
    'household %s, %s: a phone’s push and the day’s text are a count, and never a word of a document',
    (rule, who) => {
      const h = houses[rule] as House;
      const sent = daily[rule] as Sent;
      const phone = sent.pushes.filter((p) => p.endpoint.endsWith(`/${who}/unified_push`));
      const count = sees(h, who).length;
      if (who === 'sam') {
        expect(phone).toEqual([]);
        return;
      }
      expect(phone).toHaveLength(1);
      expect(JSON.parse(phone[0]?.payload ?? '')).toEqual({
        v: 1,
        type: 'digest',
        count,
        date: today,
      });
      const mine = sent.texts.filter((t) => t.to === h.people[who].number);
      expect(mine).toHaveLength(1);
      expect(mine[0]?.text).toBe(
        `Family Vault: ${count} documents need attention today. Open the app to see them.`,
      );
      for (const d of h.docs) {
        for (const w of [d.title, d.note, d.about ?? d.title]) {
          expect(noIds(mine[0]?.text ?? ''), w).not.toContain(w);
        }
      }
    },
  );

  it('the Sunday summary is worded by the same rule', async () => {
    const h = houses.off as House;
    // Today's are delivered; the summary repeats what is still open.
    const sent = of(h, await run('weekly'));
    for (const p of PEOPLE) {
      const me = h.people[p.key];
      const mail = sent.mails.filter((m) => m.to === me.email);
      expect(mail, p.key).toHaveLength(1);
      expect(mail[0]?.subject).toBe(`Your week in The off family`);
      const words = noIds(`${mail[0]?.text}\n${mail[0]?.html}`);
      for (const w of hidden(h, p.key)) expect(words, `${p.key} read “${w}”`).not.toContain(w);
      for (const d of sees(h, p.key)) {
        if (named(d, 'off', me.mine)) expect(words, `${p.key}: ${d.title}`).toContain(d.title);
      }
    }
    // Off names what is not Only me to whoever goes by the household.
    const owner = sent.mails.find((m) => m.to === h.people.owner.email)?.text ?? '';
    expect(owner).toContain('Ayesha prescription');
    // And Health to whoever chose it, sensitive papers named to them.
    const healthy = sent.mails.find((m) => m.to === h.people.healthy.email)?.text ?? '';
    expect(healthy).not.toContain('Ayesha prescription');
    expect(healthy).not.toContain('Physio note Walrus');
    expect(healthy).toContain('Riverside water bill');
    expect(owner).toContain(PRIVATE);
    expect(owner).not.toContain('Lonely owner');
  });
});
