import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  deriveKey,
  EnvKeyProvider,
  MAILBOX_PASSWORD_PURPOSE,
  ScopeKeys,
  sealMailboxPassword,
} from '@fdv/crypto';
import { createDb, createPool, withSystem, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import { BATCH_MAX_FILES, emailDay, MAIL_IN_MAX_MESSAGE_BYTES } from '@fdv/shared';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import {
  MAIL_IN_LOCK_KEY,
  MailInRunner,
  mailboxFromConfig,
  type MailInDeps,
  type MailInOptions,
  type MailRound,
} from './mail-in.js';
import { MailThread } from './mail-thread.js';
import { FakeMailbox, mail, pdf, png } from './mail-test-helper.js';
import { childEnv } from './child-env.js';
import type { ImapSettings } from './mailbox.js';

/**
 * Email in (0.8.0, S4), in the worker: mail From a member's confirmed
 * sign-in address reaches that member's Inbox and nobody else's; anything
 * else — a stranger, a viewer, an address not confirmed, a sender the
 * provider did not vouch for while senders are checked — is left exactly
 * where it was, its body never fetched, and counted for the owners; a
 * forged Authentication-Results counts for nothing; with no authserv-id
 * every item says "sender not verified"; a mail too large, with an
 * attachment too large, with nothing to add, or broken, is filed and its
 * person told; nested and forwarded mail gives up its attachments; and a
 * stop between storing and filing — even with the mailbox renumbered —
 * never makes two items, nor loses one. One runner; a refused sign-in
 * backs off and is said, never the password.
 */

const MASTER = 'mail-in-test-master-key-with-32-bytes-or-more-of-it';
const AUTHSERV = 'mx.provider.test';
const PASS = (domain: string) =>
  `Authentication-Results: ${AUTHSERV}; dkim=pass header.d=${domain}; dmarc=pass header.from=${domain}`;

describe.skipIf(!testAdminUrl())('email in, in the worker (S4)', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  let root: string;
  const keys = new ScopeKeys(new EnvKeyProvider(MASTER));
  const stamp = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  let hh: string;
  const people: Record<
    'owner' | 'adult' | 'other' | 'teen' | 'viewer',
    { member: string; account: string; email: string }
  > = {} as never;
  const sent: string[] = [];
  const logs: string[] = [];
  const runners: MailInRunner[] = [];
  const reader = new MailThread();
  let clock = Date.now();

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 4));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 3 });
    admin.on('error', () => undefined);
    root = await fsp.mkdtemp(path.join(tmpdir(), 'fdv-mail-vault-'));
    hh = randomUUID();
    await admin.query(
      "insert into household (id, name, timezone) values ($1, 'Home', 'Pacific/Auckland')",
      [hh],
    );
    for (const [name, role] of [
      ['owner', 'owner'],
      ['adult', 'adult'],
      ['other', 'adult'],
      ['teen', 'teen'],
      ['viewer', 'viewer'],
    ] as const) {
      const email = `${name}-${stamp}@family.test`;
      const member = (
        await admin.query<{ id: string }>(
          'insert into member (household_id, display_name) values ($1, $2) returning id',
          [hh, name],
        )
      ).rows[0]?.id as string;
      const account = (
        await admin.query<{ id: string }>('insert into account (email) values ($1) returning id', [
          email,
        ])
      ).rows[0]?.id as string;
      await admin.query(
        'insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, $4)',
        [account, hh, member, role],
      );
      people[name] = { member, account, email };
    }
    await withSystem(db, hh, async (trx) => {
      await keys.mintHouseholdKeys(trx, hh);
      for (const p of Object.values(people)) await keys.mintMemberKey(trx, hh, p.member, null);
      const v = await trx
        .insertInto('vault')
        .values({ household_id: hh, kind: 'local', label: 'test', status: 'ok' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('household')
        .set({ active_vault_id: v.id })
        .where('id', '=', hh)
        .execute();
    });
  }, 60_000);

  afterEach(async () => {
    for (const r of runners.splice(0)) await r.stop();
    await admin.query('delete from incoming_file where household_id = $1', [hh]);
    await admin.query('delete from intake_batch where household_id = $1', [hh]);
    await admin.query('delete from watch_notice where household_id = $1', [hh]);
    await admin.query('delete from mail_in where household_id = $1', [hh]);
    await admin.query('delete from mail_in_address where household_id = $1', [hh]);
    await admin.query('delete from mail_in_server');
    await admin.query('delete from mail_in_done where household_id = $1', [hh]);
    await admin.query(
      'update account_household set suspended_at = null, suspended_until = null, suspend_reason = null where household_id = $1',
      [hh],
    );
    sent.length = 0;
    logs.length = 0;
  });

  afterAll(async () => {
    await reader.close();
    await db?.destroy();
    await admin?.end();
    await tdb?.drop();
    await fsp.rm(root, { recursive: true, force: true });
  });

  const turnOn = () =>
    admin.query(
      `insert into mail_in (household_id, enabled) values ($1, true)
       on conflict (household_id) do update set enabled = true`,
      [hh],
    );
  /** Their sign-in address, confirmed for email in. */
  const confirm = (...who: Array<keyof typeof people>) =>
    Promise.all(
      who.map((w) =>
        admin.query(
          `insert into mail_in_address (household_id, member_id, email, confirmed_at) values ($1, $2, $3, now())
           on conflict (household_id, member_id) do update set email = $3, confirmed_at = now()`,
          [hh, people[w].member, people[w].email],
        ),
      ),
    );
  const deps = (over: Partial<MailInDeps> = {}): MailInDeps => ({
    admin,
    db,
    keys,
    credentialsKey: Buffer.alloc(32),
    localRoot: root,
    log: (level, msg, extra) => logs.push(JSON.stringify({ level, msg, ...extra })),
    itemKey: Buffer.alloc(32, 9),
    maxBytes: 64 * 1024,
    sendBatchPreviews: async (h) => {
      sent.push(h);
    },
    reader,
    // A mailbox set up in Settings: its server's name resolved to a public
    // address (TEST-NET-3), as DNS would, and on 993 (the O1 review, M3).
    mailHosts: { allowedPorts: [993], allowPrivate: false, resolve: async () => ['203.0.113.7'] },
    ...over,
  });
  const runner = (
    box: FakeMailbox | null,
    opts: Partial<MailInOptions> = {},
    over: Partial<MailInDeps> = {},
  ) => {
    const r = new MailInRunner(deps(over), {
      connector: box,
      address: 'home@vault.test',
      folder: 'INBOX',
      after: 'move',
      authservId: null,
      pollMs: 300_000,
      lockUrl: tdb.appUrl,
      now: () => clock,
      ...opts,
    });
    runners.push(r);
    return r;
  };
  const items = async () =>
    (
      await admin.query<{
        id: string;
        requester_member_id: string;
        original_name: string;
        state: string;
        sender_unverified: boolean;
        batch_member: string;
        batch_name: string;
        mail_day: string | null;
      }>(
        `select i.id, i.requester_member_id, i.original_name, i.state, i.sender_unverified,
                b.member_id as batch_member, b.name as batch_name, b.mail_day::text
           from incoming_file i join intake_batch b on b.id = i.batch_id
          where i.household_id = $1 order by i.created_at, i.original_name`,
        [hh],
      )
    ).rows;
  const notices = async () =>
    (
      await admin.query<{
        member_id: string;
        reason: string;
        file_name: string | null;
        source: string;
      }>(
        'select member_id, reason, file_name, source from watch_notice where household_id = $1 order by created_at',
        [hh],
      )
    ).rows;
  const setting = async () =>
    (
      await admin.query<{
        last_error: string | null;
        unknown_senders: number;
        unverified: number;
        waiting: number;
        last_added_at: Date | null;
        last_checked_at: Date | null;
      }>('select * from mail_in where household_id = $1', [hh])
    ).rows[0];
  const from = (who: keyof typeof people) => people[who].email;
  const doc = (who: keyof typeof people, marker: string, extra: Parameters<typeof mail>[0] = {}) =>
    mail({
      from: `${who} <${from(who)}>`,
      parts: [{ name: `${marker}.pdf`, type: 'application/pdf', content: pdf(marker) }],
      ...extra,
    });

  it('mail from a member reaches their Inbox alone, a batch of the day, each item theirs; the mail filed', async () => {
    await turnOn();
    await confirm('adult', 'other', 'teen');
    const box = new FakeMailbox();
    box.deliver(doc('adult', 'adult-passport'));
    box.deliver(doc('other', 'other-licence'));
    box.deliver(doc('teen', 'teen-card'));
    const r = runner(box);
    const round = await r.tick();
    expect(round.ran).toBe(true);
    expect(round.outcomes.map((o) => o.kind)).toEqual(['added', 'added', 'added']);
    const got = await items();
    expect(
      got.map((i) => [i.original_name, i.requester_member_id, i.batch_member, i.state]),
    ).toEqual([
      ['adult-passport.pdf', people.adult.member, people.adult.member, 'received'],
      ['other-licence.pdf', people.other.member, people.other.member, 'received'],
      ['teen-card.pdf', people.teen.member, people.teen.member, 'received'],
    ]);
    // Each in its own person's batch of the day: "Email, 13 Oct".
    const { day, name } = emailDay('Pacific/Auckland', new Date(clock));
    expect(new Set(got.map((i) => i.batch_name))).toEqual(new Set([name]));
    expect(new Set(got.map((i) => i.mail_day))).toEqual(new Set([day]));
    expect(new Set(got.map((i) => i.batch_member)).size).toBe(3);
    // No authserv-id: each says "sender not verified".
    expect(got.every((i) => i.sender_unverified)).toBe(true);
    // Filed: out of the folder, into Filed (made the first time).
    expect(box.inbox()).toHaveLength(0);
    expect(box.inbox('Filed')).toHaveLength(3);
    expect(box.made).toEqual(['Filed']);
    expect(sent).toEqual([hh]);
    // Under the member's own key: the adult's item is nobody else's to open.
    const wrapped = await admin.query<{ wrapped_by_scope: string; member_id: string }>(
      `select i.wrapped_by_scope, k.member_id from incoming_file i join scope_key k on k.id = i.wrapped_by_scope
        where i.household_id = $1`,
      [hh],
    );
    for (const w of wrapped.rows) {
      const it = got.find((g) => g.requester_member_id === w.member_id);
      expect(it).toBeDefined();
    }
    const s = await setting();
    expect(s?.last_error).toBeNull();
    expect(s?.last_added_at).not.toBeNull();
    // And it says how it has the mailbox: set up, its address, senders not checked; never a password.
    const server = (await admin.query<Record<string, unknown>>('select * from mail_in_server'))
      .rows[0];
    expect(server).toMatchObject({
      configured: true,
      address: 'home@vault.test',
      folder: 'INBOX',
      sender_check: false,
    });
  }, 60_000);

  it('mail from strangers, a viewer or an address not confirmed is left untouched — never fetched whole — and counted', async () => {
    await turnOn();
    // The viewer's address confirmed too (as it might have been while they
    // were an adult): a viewer is still never included.
    await confirm('adult', 'viewer');
    const box = new FakeMailbox();
    const stranger = box.deliver(
      mail({
        from: 'Promo <deals@shop.test>',
        parts: [{ name: 'offer.pdf', content: pdf('offer') }],
      }),
    );
    const viewer = box.deliver(doc('viewer', 'viewer-doc'));
    const unconfirmed = box.deliver(doc('other', 'other-doc'));
    const twoFroms = box.deliver(
      mail({
        from: [from('adult'), 'deals@shop.test'],
        parts: [{ name: 'x.pdf', content: pdf('x') }],
      }),
    );
    const before = box.inbox().map((m) => [m.uid, m.raw.toString('base64')]);
    const r = runner(box);
    const round = await r.tick();
    expect(round.outcomes.map((o) => [o.uid, o.kind])).toEqual([
      [stranger, 'unknown'],
      [viewer, 'unknown'],
      [unconfirmed, 'unknown'],
      [twoFroms, 'unknown'],
    ]);
    expect(await items()).toEqual([]);
    expect(await notices()).toEqual([]);
    // Exactly as it was: not moved, not changed, only its header read.
    expect(box.inbox().map((m) => [m.uid, m.raw.toString('base64')])).toEqual(before);
    expect(box.sources).toEqual([]);
    expect((await setting())?.unknown_senders).toBe(4);
    // Looked at again: its header is not fetched twice.
    await r.tick();
    expect(box.heads.filter((u) => u === stranger)).toHaveLength(1);
  }, 60_000);

  it('a code sent FROM an address confirms it only on the provider’s word (F1); without the check it confirms nothing, and its person is told what waits', async () => {
    await turnOn();
    const code = 'FDV-ABCD-EFGH-JKMN';
    const domain = from('adult').split('@')[1] as string;
    const issue = (
      who: keyof typeof people,
      c: string,
      kind = 'send',
      until = "interval '1 day'",
    ) =>
      admin.query(
        `insert into mail_in_address (household_id, member_id, code_hash, code_kind, code_expires_at)
         values ($1, $2, $3, $4, now() + ${until})
         on conflict (household_id, member_id) do update
           set code_hash = $3, code_kind = $4, code_expires_at = now() + ${until}`,
        [hh, people[who].member, createHash('sha256').update(c).digest(), kind],
      );
    const address = async (who: keyof typeof people) =>
      (
        await admin.query<{
          email: string | null;
          confirmed_at: Date | null;
          code_hash: Buffer | null;
          held_unconfirmed: number;
          held_unverified: number;
          held_last_at: Date | null;
        }>(
          `select email, confirmed_at, code_hash, held_unconfirmed, held_unverified, held_last_at
             from mail_in_address where member_id = $1`,
          [people[who].member],
        )
      ).rows[0];
    await issue('adult', code);
    const box = new FakeMailbox();
    // Senders not checked: the code, from their address, proves nothing.
    const unchecked = box.deliver(mail({ from: from('adult'), subject: code, parts: [] }));
    const r1 = runner(box);
    expect((await r1.tick()).outcomes).toEqual([{ uid: unchecked, kind: 'unknown' }]);
    expect((await address('adult'))?.confirmed_at).toBeNull();
    // Told to them, by count and date, as waiting for the address to be confirmed.
    expect(await address('adult')).toMatchObject({
      held_unconfirmed: 1,
      held_unverified: 0,
      held_last_at: new Date('2026-10-13T09:00:00Z'),
    });
    await r1.stop();
    box.inbox().splice(0);

    // Senders checked: from the address, vouched for — confirmed, and filed.
    const r = runner(box, { authservId: AUTHSERV });
    // Somebody else's code, from their own address: not theirs to use.
    const wrong = box.deliver(doc('other', 'other-doc', { subject: code, above: [PASS(domain)] }));
    // The right code, the provider not vouching: not confirmed.
    const forged = box.deliver(mail({ from: from('adult'), subject: code, parts: [] }));
    const theirs = box.deliver(
      mail({
        from: from('adult'),
        subject: `Re: ${code.toLowerCase()}`,
        above: [PASS(domain)],
        parts: [],
      }),
    );
    const round = await r.tick();
    expect(round.outcomes.map((o) => [o.uid, o.kind])).toEqual([
      [wrong, 'unknown'],
      [forged, 'unverified'],
      // Confirmed, and filed: nothing to add is not said of a confirmation.
      [theirs, 'already'],
    ]);
    const row = await address('adult');
    expect(row?.email).toBe(from('adult'));
    expect(row?.confirmed_at).not.toBeNull();
    expect(row?.code_hash).toBeNull();
    // What waits of theirs now: the one that failed the check.
    expect(row).toMatchObject({ held_unconfirmed: 0, held_unverified: 1 });
    expect(await notices()).toEqual([]);
    box.deliver(doc('adult', 'after', { above: [PASS(domain)] }));
    await r.tick();
    expect((await items()).map((i) => i.original_name)).toEqual(['after.pdf']);
    // A code emailed TO an address (typed in) is never one to send from it.
    await issue('teen', 'FDV-TEEN-CQDE-ABCD', 'enter');
    // And a code past its day confirms nothing.
    await issue('other', 'FDV-AAAA-BBBB-CCCC', 'send', "interval '1 minute'");
    clock += 2 * 60_000;
    const tdomain = from('teen').split('@')[1] as string;
    box.deliver(
      mail({ from: from('teen'), subject: 'FDV-TEEN-CQDE-ABCD', above: [PASS(tdomain)] }),
    );
    box.deliver(
      mail({ from: from('other'), subject: 'FDV-AAAA-BBBB-CCCC', above: [PASS(domain)] }),
    );
    const late = await r.tick();
    expect(late.outcomes.slice(-2).map((o) => o.kind)).toEqual(['unknown', 'unknown']);
    expect((await address('teen'))?.confirmed_at).toBeNull();
    expect((await address('other'))?.confirmed_at).toBeNull();
  }, 60_000);

  it('with an authserv-id set, only the provider’s own word lets mail in: a forged header of another id is ignored', async () => {
    await turnOn();
    await confirm('adult');
    const box = new FakeMailbox();
    const domain = from('adult').split('@')[1] as string;
    const forged = box.deliver(
      doc('adult', 'forged', {
        below: [`Authentication-Results: mx.forger.test; dkim=pass header.d=${domain}; dmarc=pass`],
      }),
    );
    const failing = box.deliver(
      doc('adult', 'failing', {
        above: [`Authentication-Results: ${AUTHSERV}; dkim=none; dmarc=fail header.from=${domain}`],
        below: [PASS(domain)],
      }),
    );
    const vouched = box.deliver(doc('adult', 'vouched', { above: [PASS(domain)] }));
    const r = runner(box, { authservId: AUTHSERV });
    const round = await r.tick();
    expect(round.outcomes.map((o) => [o.uid, o.kind])).toEqual([
      [forged, 'unverified'],
      [failing, 'unverified'],
      [vouched, 'added'],
    ]);
    const got = await items();
    expect(got.map((i) => [i.original_name, i.sender_unverified])).toEqual([
      ['vouched.pdf', false],
    ]);
    expect(box.inbox().map((m) => m.uid)).toEqual([forged, failing]);
    expect(box.sources).toEqual([vouched]);
    expect((await setting())?.unverified).toBe(2);
    expect(
      (await admin.query<{ sender_check: boolean }>('select sender_check from mail_in_server'))
        .rows[0]?.sender_check,
    ).toBe(true);
  }, 60_000);

  it('a mail too large is never fetched; attachments not added are told, how many and why; nothing to add, or a broken mail, told — and each filed', async () => {
    await turnOn();
    await confirm('adult', 'other');
    const box = new FakeMailbox();
    const huge = box.deliver(doc('adult', 'huge'), { size: MAIL_IN_MAX_MESSAGE_BYTES + 1 });
    const partly = box.deliver(
      mail({
        from: from('adult'),
        parts: [
          {
            name: 'scan.pdf',
            type: 'application/pdf',
            content: Buffer.concat([pdf('big'), Buffer.alloc(70 * 1024, 32)]),
          },
          { name: 'notes.txt', type: 'text/plain', content: Buffer.from('just words') },
          { name: 'small.pdf', type: 'application/pdf', content: pdf('small') },
        ],
      }),
    );
    const nothing = box.deliver(
      mail({
        from: from('other'),
        parts: [{ name: 'sig.png', type: 'image/png', content: png(2000), inline: true }],
      }),
    );
    const broken = box.deliver(
      `From: ${from('other')}\r\nContent-Type: multipart/mixed; boundary="x"\r\n\r\n--x\r\nContent-Type: application/pdf\r\nContent-Transfer-Encoding: base64\r\n\r\n!!!!`,
    );
    const r = runner(box);
    const round = await r.tick();
    expect(round.outcomes.map((o) => [o.uid, o.kind])).toEqual([
      [huge, 'told'],
      [partly, 'added'],
      [nothing, 'told'],
      [broken, 'told'],
    ]);
    expect(box.sources).not.toContain(huge);
    expect((await items()).map((i) => i.original_name)).toEqual(['small.pdf']);
    const said = (
      await admin.query<{ member_id: string; reason: string; skipped: unknown }>(
        'select member_id, reason, skipped from watch_notice where household_id = $1 order by created_at',
        [hh],
      )
    ).rows;
    expect(said).toEqual([
      { member_id: people.adult.member, reason: 'message_too_large', skipped: null },
      // One note for the mail: what was not added, how many and why (F5).
      {
        member_id: people.adult.member,
        reason: 'skipped',
        skipped: { too_large: 1, unsupported: 1 },
      },
      // A signature's picture alone is nothing to add, and no attachment skipped.
      { member_id: people.other.member, reason: 'nothing_to_add', skipped: null },
      { member_id: people.other.member, reason: 'nothing_to_add', skipped: null },
    ]);
    expect(box.inbox()).toHaveLength(0);
    expect(box.inbox('Filed')).toHaveLength(4);
  }, 60_000);

  it('told to delete, deletes only a mail all of which was added: one with anything skipped, too large or unreadable is moved to Filed instead (F5)', async () => {
    await turnOn();
    await confirm('adult');
    const box = new FakeMailbox();
    const whole = box.deliver(doc('adult', 'whole'));
    const partly = box.deliver(
      mail({
        from: from('adult'),
        parts: [
          { name: 'a.pdf', content: pdf('a') },
          {
            name: 'archive.zip',
            type: 'application/zip',
            content: Buffer.from('PK\u0003\u0004 not ours'),
          },
        ],
      }),
    );
    const huge = box.deliver(doc('adult', 'huge'), { size: MAIL_IN_MAX_MESSAGE_BYTES + 1 });
    await runner(box, { after: 'delete' }).tick();
    expect(box.filings).toEqual([
      { uid: whole, how: 'remove' },
      { uid: partly, how: 'move' },
      { uid: huge, how: 'move' },
    ]);
    expect(box.inbox()).toHaveLength(0);
    expect(box.inbox('Filed')).toHaveLength(2);
    expect((await items()).map((i) => i.original_name).sort()).toEqual(['a.pdf', 'whole.pdf']);
  }, 60_000);

  it('a mail that took too long to read, or broke the reader, is kept — moved, never deleted (F5)', async () => {
    await turnOn();
    await confirm('adult');
    const box = new FakeMailbox();
    const uid = box.deliver(doc('adult', 'slow'));
    const slow = {
      head: (b: Buffer, id: string | null) => reader.head(b, id),
      message: async () => ({ state: 'too_slow' as const }),
      close: async () => undefined,
    };
    await runner(box, { after: 'delete' }, { reader: slow }).tick();
    expect(box.filings).toEqual([{ uid, how: 'move' }]);
    expect((await notices()).map((n) => n.reason)).toEqual(['unreadable']);
  }, 60_000);

  it('a whole mail that does not say what its header said is nobody’s: untouched, counted, never fetched again (F3)', async () => {
    await turnOn();
    await confirm('adult');
    const box = new FakeMailbox();
    const uid = box.deliver(doc('adult', 'header-says'));
    // The whole mail, as the server hands it, From somebody else.
    box.wholeAs(uid, doc('other', 'body-says'));
    const r = runner(box);
    expect((await r.tick()).outcomes).toEqual([{ uid, kind: 'unknown' }]);
    expect((await setting())?.unknown_senders).toBe(1);
    expect(await r.tick()).toMatchObject({ outcomes: [{ uid, kind: 'unknown' }] });
    expect(box.sources).toEqual([uid]);
    expect(box.heads).toEqual([uid]);
    expect(await items()).toEqual([]);
    expect(box.inbox()).toHaveLength(1);
  }, 60_000);

  it('an address with anything but ASCII in it is nobody’s, however it folds (F6)', async () => {
    await turnOn();
    // A sign-in whose address folds to an ASCII one (the Kelvin sign is a k in lower case).
    const member = (
      await admin.query<{ id: string }>(
        "insert into member (household_id, display_name) values ($1, 'kelvin') returning id",
        [hh],
      )
    ).rows[0]?.id as string;
    const folded = `marKus-${stamp}@family.test`;
    const account = (
      await admin.query<{ id: string }>('insert into account (email) values ($1) returning id', [
        folded,
      ])
    ).rows[0]?.id as string;
    await admin.query(
      "insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, 'adult')",
      [account, hh, member],
    );
    await withSystem(db, hh, (trx) => keys.mintMemberKey(trx, hh, member, null));
    await admin.query(
      `insert into mail_in_address (household_id, member_id, email, confirmed_at) values ($1, $2, $3, now())`,
      [hh, member, `markus-${stamp}@family.test`],
    );
    const box = new FakeMailbox();
    const ascii = box.deliver(
      mail({ from: `markus-${stamp}@family.test`, parts: [{ name: 'k.pdf', content: pdf('k') }] }),
    );
    const accented = box.deliver(
      mail({
        from: `=?utf-8?Q?x?= <anné@family.test>`,
        parts: [{ name: 'e.pdf', content: pdf('e') }],
      }),
    );
    try {
      const round = await runner(box).tick();
      expect(round.outcomes.map((o) => [o.uid, o.kind])).toEqual([
        [ascii, 'unknown'],
        [accented, 'unknown'],
      ]);
      expect(box.sources).toEqual([]);
      expect(await items()).toEqual([]);
    } finally {
      await admin.query('delete from mail_in_address where member_id = $1', [member]);
      await admin.query('delete from account_household where member_id = $1', [member]);
      await admin.query('delete from account where id = $1', [account]);
      await admin.query('delete from member where id = $1', [member]);
    }
  }, 60_000);

  it('an item its person removed counts as taken: never added again while its mail waits to be filed (F8)', async () => {
    await turnOn();
    await confirm('adult');
    const box = new FakeMailbox();
    box.deliver(doc('adult', 'removed-later'));
    box.refuseFiling = 1;
    const r = runner(box);
    expect((await r.tick()).outcomes[0]).toMatchObject({ kind: 'later' });
    // Removed from the Inbox by its person, as the app does it.
    await admin.query(
      `update incoming_file set state = 'rejected', original_name = null, sha256 = null,
              decided_at = now() where household_id = $1`,
      [hh],
    );
    expect((await r.tick()).outcomes[0]?.kind).toBe('already');
    expect((await items()).map((i) => i.state)).toEqual(['rejected']);
    expect(box.inbox()).toHaveLength(0);
  }, 60_000);

  it('a server without MOVE and UIDPLUS: nothing moved or deleted, mail marked read and never fetched again; owners told (F10)', async () => {
    await turnOn();
    await confirm('adult');
    const box = new FakeMailbox();
    box.caps = { move: false, uidplus: false };
    const uid = box.deliver(doc('adult', 'left'));
    const r = runner(box, { after: 'delete' });
    const first = await r.tick();
    expect(first).toMatchObject({ filing: 'leave', outcomes: [{ uid, kind: 'added' }] });
    expect(box.filings).toEqual([]);
    expect(box.seen).toEqual([uid]);
    expect(box.inbox()).toHaveLength(1);
    expect((await admin.query('select filing from mail_in_server')).rows[0]).toEqual({
      filing: 'leave',
    });
    // A new worker, nothing remembered: still never fetched again.
    await r.stop();
    const r2 = runner(box, { after: 'delete' });
    const again = await r2.tick();
    expect(again.outcomes).toEqual([{ uid, kind: 'done' }]);
    expect(box.sources).toEqual([uid]);
    expect(await items()).toHaveLength(1);
    await r2.stop();
    // MOVE but no UIDPLUS: no delete, no move (an EXPUNGE would take others too).
    box.caps = { move: true, uidplus: false };
    const r3 = runner(box, { after: 'delete' });
    expect((await r3.tick()).filing).toBe('leave');
    expect(box.filings).toEqual([]);
    await r3.stop();
    // UIDPLUS and MOVE, told to delete: deleted.
    box.caps = { move: true, uidplus: true };
    expect((await runner(box, { after: 'delete' }).tick()).filing).toBe('delete');
  }, 60_000);

  it('a worker without the mailbox never says so over one that has it, within its last two polls (F9)', async () => {
    const box = new FakeMailbox();
    await runner(box).tick();
    await runner(null).tick();
    expect((await admin.query('select configured from mail_in_server')).rows[0]).toEqual({
      configured: true,
    });
    // Its word older than two polls: then the one without it is heard.
    await admin.query("update mail_in_server set checked_at = now() - interval '11 minutes'");
    await runner(null).tick();
    expect((await admin.query('select configured from mail_in_server')).rows[0]).toEqual({
      configured: false,
    });
  }, 60_000);

  it('takes attachments from nested multiparts and forwarded mails; a picture in the body under 20 KB is left out, a larger one kept', async () => {
    await turnOn();
    await confirm('adult');
    const box = new FakeMailbox();
    const inner = mail({
      from: 'bank@bank.test',
      parts: [{ name: 'statement.pdf', content: pdf('statement') }],
    });
    box.deliver(
      mail({
        from: from('adult'),
        parts: [
          {
            subtype: 'related',
            parts: [
              { raw: 'Content-Type: text/html\r\n\r\n<p>hi</p>' },
              { name: 'logo.png', type: 'image/png', content: png(4000), inline: true },
              { name: 'photo.png', type: 'image/png', content: png(30 * 1024), inline: true },
            ],
          },
          { forwarded: inner, name: 'fwd.eml' },
        ],
      }),
    );
    await runner(box, {}, { maxBytes: 1024 * 1024 }).tick();
    expect((await items()).map((i) => i.original_name).sort()).toEqual([
      'photo.png',
      'statement.pdf',
    ]);
  }, 60_000);

  it('a stop between storing and filing makes no second item — even after the mailbox is renumbered — and the mail is filed then', async () => {
    await turnOn();
    await confirm('adult');
    const box = new FakeMailbox();
    box.deliver(
      mail({
        from: from('adult'),
        messageId: '<stop@family.test>',
        parts: [
          { name: 'a.pdf', content: pdf('a') },
          { name: 'b.pdf', content: pdf('b') },
        ],
      }),
    );
    const first = runner(box, {
      beforeFile: async () => {
        throw new Error('the worker stopped');
      },
    });
    const r1 = await first.tick();
    expect(r1.outcomes[0]?.kind).toBe('later');
    expect((await items()).map((i) => i.original_name)).toEqual(['a.pdf', 'b.pdf']);
    expect(box.inbox()).toHaveLength(1);
    await first.stop();
    // The same UIDs, a new worker: both found, the mail filed.
    const second = runner(box);
    const r2 = await second.tick();
    expect(r2.outcomes[0]?.kind).toBe('already');
    expect(await items()).toHaveLength(2);
    expect(box.inbox('Filed')).toHaveLength(1);

    // Once more, and the mailbox rebuilt (UIDVALIDITY changed) before the next look.
    box.deliver(
      mail({
        from: from('adult'),
        messageId: '<again@family.test>',
        parts: [{ name: 'c.pdf', content: pdf('c') }],
      }),
    );
    box.refuseFiling = 1;
    const r3 = await second.tick();
    expect(r3.outcomes[0]).toMatchObject({ kind: 'later' });
    expect((await setting())?.last_error).toBe('not_filed');
    box.renumber();
    await second.stop();
    const third = runner(box);
    const r4 = await third.tick();
    expect(r4.outcomes[0]?.kind).toBe('already');
    expect((await items()).map((i) => i.original_name)).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
    expect(box.inbox()).toHaveLength(0);
    expect((await setting())?.last_error).toBeNull();
  }, 60_000);

  it('a full day: what fits is added, and the mail waits — unfiled — until the rest is in, the next day', async () => {
    await turnOn();
    await confirm('adult');
    const box = new FakeMailbox();
    box.deliver(doc('adult', 'first'));
    const r = runner(box);
    await r.tick();
    // The day's batch filled to one short of full.
    await admin.query(
      `insert into incoming_file (household_id, batch_id, review_by, requester_member_id, state,
                                  original_name, mime, byte_size, sha256, cipher_bytes, cipher_sha256,
                                  storage_key, vault_id, file_key_wrapped, wrapped_by_scope, scope,
                                  scan_state, read_state, received_at, submitted_at)
       select household_id, batch_id, review_by, requester_member_id, state, original_name, mime,
              byte_size, sha256, cipher_bytes, cipher_sha256, storage_key || n, vault_id,
              file_key_wrapped, wrapped_by_scope, scope, scan_state, read_state, received_at,
              submitted_at
         from incoming_file, generate_series(1, $2::int - 2) as n
        where household_id = $1`,
      [hh, BATCH_MAX_FILES],
    );
    const fits = box.deliver(
      mail({
        from: from('adult'),
        messageId: '<full@family.test>',
        parts: [
          { name: 'fits.pdf', content: pdf('fits') },
          { name: 'waits.pdf', content: pdf('waits') },
        ],
      }),
    );
    const later = box.deliver(doc('adult', 'later'));
    await confirm('other');
    const others = box.deliver(doc('other', 'others'));
    // Two mails a round: the one that waits for a full day is not one of them (F4).
    const r2 = runner(box, { roundMax: 2 });
    await r.stop();
    const full = await r2.tick();
    expect(full.outcomes.map((o) => [o.uid, o.kind])).toEqual([
      [fits, 'waiting'],
      [later, 'waiting'],
      [others, 'added'],
    ]);
    // The day full once one was in: the rest of theirs never fetched this round.
    expect(box.sources.filter((u) => u === later)).toEqual([]);
    expect(box.inbox().map((m) => m.uid)).toEqual([fits, later]);
    expect((await setting())?.waiting).toBe(2);
    const named = async () =>
      (
        await admin.query<{ original_name: string }>(
          "select original_name from incoming_file where household_id = $1 and original_name in ('fits.pdf', 'waits.pdf', 'later.pdf') order by original_name",
          [hh],
        )
      ).rows.map((x) => x.original_name);
    expect(await named()).toEqual(['fits.pdf']);
    // Looked at again the same day: known full before anything is fetched.
    const fetched = box.sources.length;
    expect((await r2.tick()).outcomes.filter((o) => o.kind === 'waiting')).toHaveLength(2);
    expect(box.sources).toHaveLength(fetched);
    // The next day: the rest, in that day's batch; the first never twice; then filed.
    clock += 864e5;
    expect((await r2.tick()).outcomes.map((o) => o.kind)).toEqual(['added', 'added']);
    expect(await named()).toEqual(['fits.pdf', 'later.pdf', 'waits.pdf']);
    expect(box.inbox()).toHaveLength(0);
  }, 60_000);

  it('mail from somebody locked, or paused after a restore, waits untouched; and comes in once they are not', async () => {
    await turnOn();
    await confirm('adult');
    await admin.query(
      "update account_household set suspended_at = now(), suspend_reason = 'restored' where member_id = $1",
      [people.adult.member],
    );
    const box = new FakeMailbox();
    box.deliver(doc('adult', 'waits'));
    const r = runner(box);
    expect((await r.tick()).outcomes[0]?.kind).toBe('waiting');
    expect(box.sources).toEqual([]);
    expect((await setting())?.waiting).toBe(1);
    expect(await items()).toEqual([]);
    await admin.query(
      'update account_household set suspended_at = null, suspend_reason = null where member_id = $1',
      [people.adult.member],
    );
    expect((await r.tick()).outcomes[0]?.kind).toBe('added');
    expect((await setting())?.waiting).toBe(0);
  }, 60_000);

  it('one runner however many workers; off, or not set up, it checks nothing', async () => {
    const box = new FakeMailbox();
    box.deliver(doc('adult', 'x'));
    await confirm('adult');
    const a = runner(box);
    const b = runner(box);
    // Not on: the mailbox is not opened.
    expect((await a.tick()).ran).toBe(true);
    expect(box.opens).toBe(0);
    await turnOn();
    const [ra, rb] = [await a.tick(), await b.tick()];
    expect([ra.ran, rb.ran]).toEqual([true, false]);
    expect(box.opens).toBe(1);
    await a.stop();
    expect((await b.tick()).ran).toBe(true);
    // Not set up on a worker: it says so, and holds no lock.
    const none = runner(null);
    expect((await none.tick()).ran).toBe(false);
    const held = await admin.query<{ n: number }>(
      `select count(*)::int as n from pg_locks
        where locktype = 'advisory' and objid = $1
          and database = (select oid from pg_database where datname = current_database())`,
      [MAIL_IN_LOCK_KEY],
    );
    expect(held.rows[0]?.n).toBe(1);
  }, 60_000);

  it('a refused sign-in is said as a word, backed off, and the password is nowhere: not the log, not the database', async () => {
    await turnOn();
    const password = `pw-${randomBytes(9).toString('hex')}`;
    const box = new FakeMailbox();
    box.failing = 'login_failed';
    const r = runner(box);
    const first = await r.tick();
    expect(first.error).toBe('login_failed');
    expect((await setting())?.last_error).toBe('login_failed');
    // Not tried again until the back-off is over: a poll, then two, …
    expect((await r.tick()).waited).toBe(true);
    expect(box.opens).toBe(1);
    clock += 300_000;
    await r.tick();
    expect(box.opens).toBe(2);
    expect((await r.tick()).waited).toBe(true);
    clock += 600_000;
    box.failing = null;
    expect((await r.tick()).error).toBeNull();
    expect((await setting())?.last_error).toBeNull();

    // A real connector, from the worker's own settings, to a server that is not there.
    const config = loadConfig({
      DATABASE_URL: 'postgres://x',
      FDV_MASTER_KEY: MASTER,
      FDV_MAIL_IN_HOST: '127.0.0.1',
      FDV_MAIL_IN_PORT: '1',
      FDV_MAIL_IN_USER: 'home@vault.test',
      FDV_MAIL_IN_PASSWORD: password,
    });
    const real = await mailboxFromConfig(
      config,
      () => undefined,
      async () => '',
    );
    expect(real?.address).toBe('home@vault.test');
    const realRunner = new MailInRunner(deps(), {
      connector: real?.connector ?? null,
      address: real?.address ?? null,
      folder: 'INBOX',
      after: 'move',
      authservId: null,
      pollMs: 300_000,
      lockUrl: tdb.appUrl,
    });
    runners.push(realRunner);
    await r.stop();
    const got: MailRound = await realRunner.tick();
    expect(got.error).toBe('unreachable');
    expect(logs.join('\n')).not.toContain(password);
    // Every row of every table, as text: the password in none.
    const { rows: tables } = await admin.query<{ t: string }>(
      "select table_name as t from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'",
    );
    for (const { t } of tables) {
      const { rows } = await admin.query<{ n: number }>(
        `select count(*)::int as n from public."${t}" x where x::text like $1`,
        [`%${password}%`],
      );
      expect(rows[0]?.n, t).toBe(0);
    }
    // A password from a file, its newline gone; a file that cannot be read is no mailbox.
    const fromFile = await mailboxFromConfig(
      { ...config, FDV_MAIL_IN_PASSWORD: undefined, FDV_MAIL_IN_PASSWORD_FILE: '/run/secrets/x' },
      () => undefined,
      async () => `${password}\n`,
    );
    expect(fromFile).not.toBeNull();
    const unread = await mailboxFromConfig(
      { ...config, FDV_MAIL_IN_PASSWORD: undefined, FDV_MAIL_IN_PASSWORD_FILE: '/run/secrets/x' },
      () => undefined,
      async () => {
        throw new Error('ENOENT');
      },
    );
    expect(unread).toBeNull();
  }, 60_000);

  it('turned off mid-round, nothing more is added', async () => {
    await turnOn();
    await confirm('adult');
    const box = new FakeMailbox();
    box.deliver(doc('adult', 'one'));
    box.deliver(doc('adult', 'two'));
    let n = 0;
    const r = runner(box, {
      beforeFile: async () => {
        n += 1;
        if (n === 1)
          await admin.query('update mail_in set enabled = false where household_id = $1', [hh]);
      },
    });
    const round = await r.tick();
    expect(round.outcomes.map((o) => o.kind)).toEqual(['added', 'later']);
    expect((await items()).map((i) => i.original_name)).toEqual(['one.pdf']);
    expect(box.inbox()).toHaveLength(1);
  }, 60_000);

  // ------------------------------------------------- set up in Settings (0.9.0, O1)

  describe('the mailbox set up in Settings (O1)', () => {
    const mailKey = deriveKey(MASTER, MAILBOX_PASSWORD_PURPOSE);
    const PASSWORD = `settings-pw-${randomBytes(6).toString('hex')}`;
    afterEach(async () => {
      await admin.query('delete from mail_in_mailbox where household_id = $1', [hh]);
    });
    const setUp = (
      o: { password?: string | null; after?: string; authserv?: string | null } = {},
    ) =>
      admin.query(
        `insert into mail_in_mailbox (household_id, host, port, username, password_encrypted, folder, after, authserv_id, poll_seconds)
         values ($1, 'imap.household.test', 993, 'family@household.test', $2, 'Docs', $3, $4, 60)
         on conflict (household_id) do update set password_encrypted = $2, after = $3, authserv_id = $4,
           updated_at = now()`,
        [
          hh,
          o.password === null
            ? null
            : sealMailboxPassword(mailKey, o.password ?? PASSWORD, hh, {
                host: 'imap.household.test',
                port: 993,
                username: 'family@household.test',
              }),
          o.after ?? 'move',
          o.authserv === undefined ? null : o.authserv,
        ],
      );

    it('is checked over FDV_MAIL_IN_*: its own server, folder and filing — its password to its connector alone', async () => {
      await turnOn();
      await confirm('adult');
      const server = new FakeMailbox();
      server.deliver(doc('adult', 'server-copy'));
      const own = new FakeMailbox();
      own.folders.set('Docs', []);
      own.deliver(doc('adult', 'household-copy'), { folder: 'Docs' });
      await setUp({ after: 'delete' });
      const given: ImapSettings[] = [];
      const before = JSON.stringify(process.env);
      const r = runner(
        server,
        {},
        {
          mailKey,
          connect: (s) => {
            given.push(s);
            return own;
          },
        },
      );
      const round = await r.tick();
      expect(round.outcomes.map((o) => o.kind)).toEqual(['added']);
      expect((await items()).map((i) => i.original_name)).toEqual(['household-copy.pdf']);
      // Its server and sign-in; the password opened for its connector, and nothing else.
      expect(given).toEqual([
        {
          host: 'imap.household.test',
          port: 993,
          user: 'family@household.test',
          password: PASSWORD,
          // Connected to at the address checked, the name kept for the certificate (M3).
          address: '203.0.113.7',
        },
      ]);
      // Its folder, and deleted as it is set: the server's own never opened.
      expect(own.filings).toEqual([{ uid: 1, how: 'remove' }]);
      expect(server.opens).toBe(0);
      expect(server.inbox()).toHaveLength(1);
      expect(
        (await admin.query('select filing from mail_in where household_id = $1', [hh])).rows[0],
      ).toEqual({ filing: 'delete' });
      // Senders not checked (no authserv-id set here): each item says so.
      expect((await items())[0]?.sender_unverified).toBe(true);
      // Never in the environment, a tool's, the log or the database.
      expect(JSON.stringify(process.env)).toBe(before);
      expect(JSON.stringify(childEnv())).not.toContain(PASSWORD);
      expect(logs.join('\n')).not.toContain(PASSWORD);
      const dump = await admin.query<{ t: string }>(
        `select string_agg(row_to_json(x)::text, ',') as t from
           (select * from mail_in union all select * from mail_in where false) x`,
      );
      expect(dump.rows[0]?.t ?? '').not.toContain(PASSWORD);
      // Counted for /capabilities: one household's own mailbox.
      expect((await admin.query('select mailboxes from mail_in_server')).rows[0]).toEqual({
        mailboxes: 1,
      });
    }, 60_000);

    it('with its authserv-id, senders are checked by it; set up again, it is tried again at once', async () => {
      await turnOn();
      await confirm('adult');
      const own = new FakeMailbox();
      own.folders.set('Docs', []);
      own.deliver(doc('adult', 'unvouched'), { folder: 'Docs' });
      own.deliver(
        doc('adult', 'vouched', { above: [PASS(from('adult').split('@')[1] as string)] }),
        { folder: 'Docs' },
      );
      await setUp({ authserv: AUTHSERV });
      own.failing = 'login_failed';
      const r = runner(null, {}, { mailKey, connect: () => own });
      expect((await r.tick()).error).toBe('login_failed');
      // Backing off: not tried again this soon…
      expect((await r.tick()).waited).toBe(true);
      // …but an owner who sets it up anew is tried at once.
      own.failing = null;
      await setUp({ authserv: AUTHSERV, password: 'the-right-one' });
      const round = await r.tick();
      expect(round.error).toBeNull();
      const kinds = round.outcomes.map((o) => o.kind).sort();
      expect(kinds).toEqual(['added', 'unverified']);
      expect((await items()).map((i) => [i.original_name, i.sender_unverified])).toEqual([
        ['vouched.pdf', false],
      ]);
    }, 60_000);

    it('a password this master key does not open is said, and nothing is signed in to; one with no password checks nothing', async () => {
      await turnOn();
      const own = new FakeMailbox();
      await admin.query(
        `insert into mail_in_mailbox (household_id, host, username, password_encrypted)
         values ($1, 'imap.household.test', 'x@household.test', $2)`,
        [
          hh,
          sealMailboxPassword(
            deriveKey('another-master-key-entirely-32-bytes!!', MAILBOX_PASSWORD_PURPOSE),
            'x',
            hh,
            { host: 'imap.household.test', port: 993, username: 'x@household.test' },
          ),
        ],
      );
      const server = new FakeMailbox();
      const r = runner(server, {}, { mailKey, connect: () => own });
      expect((await r.tick()).error).toBe('password_sealed');
      expect((await setting())?.last_error).toBe('password_sealed');
      expect(own.opens + server.opens).toBe(0);
      await admin.query(
        'update mail_in_mailbox set password_encrypted = null where household_id = $1',
        [hh],
      );
      const round = await r.tick();
      expect(round.outcomes).toEqual([]);
      // Set up in Settings, it is the household's alone: the server's is never checked instead.
      expect(own.opens + server.opens).toBe(0);
    }, 60_000);

    it('a password kept for one server is never sent to another: host, port or sign-in changed, it does not open (the O1 review, H1)', async () => {
      await turnOn();
      await setUp();
      const given: ImapSettings[] = [];
      const own = new FakeMailbox();
      const r = runner(
        null,
        {},
        {
          mailKey,
          connect: (s) => {
            given.push(s);
            return own;
          },
          mailHosts: {
            allowedPorts: [993, 143],
            allowPrivate: false,
            resolve: async () => ['203.0.113.7'],
          },
        },
      );
      // The reviewer's PoC: the server changed under the sealed password (as
      // an owner, or anybody writing the row, could), and it is checked.
      for (const change of [
        "host = 'imap.attacker.test'",
        'port = 143',
        "username = 'attacker@household.test'",
      ]) {
        await admin.query(
          `update mail_in_mailbox set ${change}, updated_at = now() where household_id = $1`,
          [hh],
        );
        clock += 10 * 60_000;
        expect((await r.tick()).error, change).toBe('password_sealed');
        expect((await setting())?.last_error).toBe('password_sealed');
        await setUp();
      }
      expect(given).toEqual([]);
      expect(own.opens).toBe(0);
    }, 60_000);

    it('a server set up in Settings is connected to only on an allowed port, and never inside the server’s own network (the O1 review, M3)', async () => {
      await turnOn();
      const sealFor = (host: string, port: number) =>
        sealMailboxPassword(mailKey, PASSWORD, hh, {
          host,
          port,
          username: 'family@household.test',
        });
      const at = (host: string, port = 993) =>
        admin.query(
          `insert into mail_in_mailbox (household_id, host, port, username, password_encrypted, folder)
           values ($1, $2, $3, 'family@household.test', $4, 'Docs')
           on conflict (household_id) do update set host = $2, port = $3, password_encrypted = $4,
             updated_at = now()`,
          [hh, host, port, sealFor(host, port)],
        );
      const given: ImapSettings[] = [];
      const own = new FakeMailbox();
      own.folders.set('Docs', []);
      let resolved = ['203.0.113.7'];
      let rules: { allowedPorts: number[]; allowPrivate: boolean } = {
        allowedPorts: [993],
        allowPrivate: false,
      };
      const mk = () =>
        runner(
          null,
          {},
          {
            mailKey,
            connect: (s) => {
              given.push(s);
              return own;
            },
            mailHosts: { ...rules, resolve: async () => resolved },
          },
        );
      let r = mk();
      const refused = async (why: string) => {
        clock += 10 * 60_000;
        expect((await r.tick()).error, why).toBe('address_refused');
        expect((await setting())?.last_error, why).toBe('address_refused');
      };
      // A name that is this machine, an address that is, a name resolving
      // inside the network (metadata, a private LAN, CGNAT, a Docker bridge's),
      // and another port: refused, never connected to.
      await at('localhost');
      await refused('localhost');
      await at('127.0.0.1');
      await refused('127.0.0.1');
      await at('imap.rebound.test');
      for (const a of [
        '169.254.169.254',
        '10.0.0.5',
        '192.168.1.20',
        '100.64.0.1',
        '172.17.0.1',
        '::1',
      ]) {
        resolved = [a];
        await refused(a);
      }
      // One address of several inside it is enough to refuse.
      resolved = ['203.0.113.7', '10.0.0.5'];
      await refused('mixed');
      resolved = ['203.0.113.7'];
      await at('imap.rebound.test', 143);
      await refused('port 143');
      expect(given).toEqual([]);
      // The operator allows both: connected to, at the address checked.
      rules = { allowedPorts: [993, 143], allowPrivate: true };
      await r.stop();
      r = mk();
      resolved = ['10.0.0.5'];
      clock += 10 * 60_000;
      expect((await r.tick()).error).toBeNull();
      expect(given.map((g) => [g.host, g.port, g.address])).toEqual([
        ['imap.rebound.test', 143, '10.0.0.5'],
      ]);
      expect(
        (await admin.query('select allowed_ports, allow_private from mail_in_server')).rows[0],
      ).toEqual({ allowed_ports: [993, 143], allow_private: true });
    }, 60_000);
  });
});
