import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EnvKeyProvider, ScopeKeys } from '@fdv/crypto';
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

  it('a member confirms their address with the code from their Add page, and their mail comes in from then on', async () => {
    await turnOn();
    const code = 'FDV-ABCD-EFGH-JKMN';
    await admin.query(
      `insert into mail_in_address (household_id, member_id, code_hash, code_expires_at)
       values ($1, $2, $3, now() + interval '1 day')`,
      [hh, people.adult.member, createHash('sha256').update(code).digest()],
    );
    const box = new FakeMailbox();
    // Somebody else's code, from their address: not theirs to use.
    const wrong = box.deliver(doc('other', 'other-doc', { subject: code }));
    const theirs = box.deliver(
      mail({ from: from('adult'), subject: `Re: ${code.toLowerCase()}`, parts: [] }),
    );
    const r = runner(box);
    const round = await r.tick();
    expect(round.outcomes.find((o) => o.uid === wrong)?.kind).toBe('unknown');
    // Confirmed, and filed: nothing to add is not said of a confirmation.
    expect(round.outcomes.find((o) => o.uid === theirs)?.kind).toBe('already');
    const row = (
      await admin.query<{ email: string; confirmed_at: Date | null; code_hash: Buffer | null }>(
        'select email, confirmed_at, code_hash from mail_in_address where member_id = $1',
        [people.adult.member],
      )
    ).rows[0];
    expect(row?.email).toBe(from('adult'));
    expect(row?.confirmed_at).not.toBeNull();
    expect(row?.code_hash).toBeNull();
    expect(await notices()).toEqual([]);
    box.deliver(doc('adult', 'after'));
    await r.tick();
    expect((await items()).map((i) => i.original_name)).toEqual(['after.pdf']);
    // A code past its day confirms nothing.
    await admin.query(
      `insert into mail_in_address (household_id, member_id, code_hash, code_expires_at)
       values ($1, $2, $3, now() + interval '1 minute')`,
      [hh, people.teen.member, createHash('sha256').update('FDV-AAAA-BBBB-CCCC').digest()],
    );
    clock += 2 * 60_000;
    box.deliver(mail({ from: from('teen'), subject: 'FDV-AAAA-BBBB-CCCC' }));
    const late = await r.tick();
    expect(late.outcomes.at(-1)?.kind).toBe('unknown');
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

  it('a mail too large is never fetched; an attachment too large, or none to add, or a broken mail is told — and each filed', async () => {
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
          { name: 'small.pdf', type: 'application/pdf', content: pdf('small') },
        ],
      }),
    );
    const nothing = box.deliver(
      mail({
        from: from('other'),
        parts: [
          { name: 'notes.txt', type: 'text/plain', content: Buffer.from('just words') },
          { name: 'sig.png', type: 'image/png', content: png(2000), inline: true },
        ],
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
    expect(await notices()).toEqual([
      {
        member_id: people.adult.member,
        reason: 'message_too_large',
        file_name: null,
        source: 'email',
      },
      {
        member_id: people.adult.member,
        reason: 'too_large',
        file_name: 'scan.pdf',
        source: 'email',
      },
      {
        member_id: people.other.member,
        reason: 'nothing_to_add',
        file_name: null,
        source: 'email',
      },
      {
        member_id: people.other.member,
        reason: 'nothing_to_add',
        file_name: null,
        source: 'email',
      },
    ]);
    expect(box.inbox()).toHaveLength(0);
    expect(box.inbox('Filed')).toHaveLength(4);
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

  it('deletes instead of filing when told to', async () => {
    await turnOn();
    await confirm('adult');
    const box = new FakeMailbox();
    box.deliver(doc('adult', 'gone'));
    await runner(box, { after: 'delete' }).tick();
    expect(box.inbox()).toHaveLength(0);
    expect(box.inbox('Filed')).toHaveLength(0);
    expect(box.made).toEqual([]);
    expect(await items()).toHaveLength(1);
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
    box.deliver(
      mail({
        from: from('adult'),
        messageId: '<full@family.test>',
        parts: [
          { name: 'fits.pdf', content: pdf('fits') },
          { name: 'waits.pdf', content: pdf('waits') },
        ],
      }),
    );
    const full = await r.tick();
    expect(full.outcomes.at(-1)).toMatchObject({ kind: 'waiting', why: 'day_full' });
    expect(box.inbox()).toHaveLength(1);
    expect((await setting())?.waiting).toBe(1);
    const named = async () =>
      (
        await admin.query<{ original_name: string }>(
          "select original_name from incoming_file where household_id = $1 and original_name in ('fits.pdf', 'waits.pdf') order by original_name",
          [hh],
        )
      ).rows.map((x) => x.original_name);
    expect(await named()).toEqual(['fits.pdf']);
    // The next day: the rest, in that day's batch; the first never twice; then filed.
    clock += 864e5;
    expect((await r.tick()).outcomes.at(-1)?.kind).toBe('added');
    expect(await named()).toEqual(['fits.pdf', 'waits.pdf']);
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
      `select count(*)::int as n from pg_locks where locktype = 'advisory' and objid = $1`,
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
});
