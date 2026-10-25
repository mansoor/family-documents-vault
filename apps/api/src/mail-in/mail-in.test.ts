import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  MAIL_IN_CODE_PATTERN,
  type Capabilities,
  type MailInCode,
  type MailInEmailed,
  type MailInMine,
  type MailInView,
  type WatchNoticeView,
} from '@fdv/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, mailSent, type Harness } from '../test-harness.js';

/**
 * Email in (0.8.0, S4), in the API: offered in /capabilities only while
 * the worker has a mailbox set up and checked it in its last two polls; an
 * owner's setting, at the API and in the database's own rules; each person
 * who may add documents told where to send from where, and given a code to
 * confirm that address — theirs alone, never a viewer's; the notes an email
 * leaves its person's alone; an item from an email whose sender was not
 * verified saying so; and the mailbox's password nowhere the API can reach.
 */
describe.skipIf(!testAdminUrl())('email in, in the API (S4)', () => {
  let h: Harness;
  let owner: Tokens;
  let adult: Tokens;
  let other: Tokens;
  let teen: Tokens;
  let viewer: Tokens;
  let admin: ReturnType<typeof createPool>;
  let app: ReturnType<typeof createPool>;
  let nth = 0;
  /**
   * The API's clock, held still where a test says (null: the real one), so
   * the worker's word is exactly so old by the clock that reads it — never
   * the database's clock against the API's, or a slow run's milliseconds.
   */
  let frozen: number | null = null;
  const clock = () => frozen ?? Date.now();
  const PASSWORD = `pw-${randomBytes(9).toString('hex')}`;

  beforeAll(async () => {
    // The worker's password in this process's environment, as a careless
    // compose file might put it: the API must still never say it.
    process.env.FDV_MAIL_IN_PASSWORD = PASSWORD;
    h = await createHarness({ rateLimitPerMinute: 100_000, now: clock });
    owner = await h.setup();
    adult = await h.join(owner, { name: 'Ahmed', email: 'ahmed@example.test', role: 'adult' });
    other = await h.join(owner, { name: 'Bea', email: 'bea@example.test', role: 'adult' });
    teen = await h.join(owner, { name: 'Tia', email: 'tia@example.test', role: 'teen' });
    viewer = await h.join(owner, { name: 'Vic', email: 'vic@example.test', role: 'viewer' });
    admin = createPool(h.adminUrl, 2);
    app = createPool(h.appUrl, 1);
  }, 60_000);
  afterAll(async () => {
    delete process.env.FDV_MAIL_IN_PASSWORD;
    await app?.end();
    await admin?.end();
    await h?.close();
  });
  beforeEach(async () => {
    frozen = null;
    await admin.query('delete from mail_in');
    await admin.query('delete from mail_in_address');
    await admin.query('delete from mail_in_server');
    await admin.query('delete from watch_notice');
  });

  const call = (
    who: Tokens,
    method: 'GET' | 'PUT' | 'POST',
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    h.app.inject({
      method,
      url,
      headers: h.as(who),
      ...(payload ? { payload } : {}),
      remoteAddress: `10.69.${++nth >> 8}.${nth & 0xff}`,
    });
  /** The mailbox as the worker says it, `ago` seconds ago by the API's clock. */
  const said = (
    configured: boolean,
    ago = 0,
    over: { sender_check?: boolean; poll?: number; after?: string } = {},
  ) =>
    admin.query(
      `insert into mail_in_server (singleton, configured, address, folder, after, sender_check, poll_seconds, checked_at)
       values (true, $1, $2, $3, $4, $5, $6, $7)
       on conflict (singleton) do update set configured = $1, address = $2, folder = $3, after = $4,
         sender_check = $5, poll_seconds = $6, checked_at = $7`,
      [
        configured,
        configured ? 'home@vault.test' : null,
        configured ? 'INBOX' : null,
        over.after ?? 'move',
        over.sender_check ?? false,
        over.poll ?? 300,
        new Date(clock() - ago * 1000),
      ],
    );
  const offered = async () =>
    (await h.app.inject({ method: 'GET', url: '/api/v1/capabilities' })).json<Capabilities>()
      .features.email_ingest;
  const view = async (who: Tokens = owner) => {
    const r = await call(who, 'GET', '/api/v1/mail-in');
    expect(r.statusCode, r.body).toBe(200);
    return r.json<MailInView>();
  };
  const mine = async (who: Tokens) => {
    const r = await call(who, 'GET', '/api/v1/mail-in/me');
    expect(r.statusCode, r.body).toBe(200);
    return r.json<MailInMine>();
  };
  const turnOn = () =>
    admin.query(
      `insert into mail_in (household_id, enabled) values ($1, true)
       on conflict (household_id) do update set enabled = true`,
      [owner.household_id],
    );

  /** One statement as somebody signed in, straight to the database: rows, or the error's code. */
  const asCaller = async (who: Tokens, role: string, text: string, args: unknown[] = []) => {
    const c = await app.connect();
    try {
      await c.query('begin');
      const acct = await admin.query<{ account_id: string }>(
        'select account_id from account_household where member_id = $1',
        [who.member_id],
      );
      await c.query(
        `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                set_config('app.account_id', $2, true), set_config('app.member_id', $3, true),
                set_config('app.role', $4, true)`,
        [who.household_id, acct.rows[0]?.account_id, who.member_id, role],
      );
      const r = await c.query(text, args);
      return { rows: r.rows as unknown[], count: r.rowCount ?? 0 };
    } catch (err) {
      return { code: (err as { code?: string }).code ?? 'error' };
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
  };

  it('is offered only while the worker has a mailbox set up and checked it in its last two polls', async () => {
    frozen = Date.now();
    expect(await offered()).toBe(false);
    expect((await view()).server).toMatchObject({
      state: 'unknown',
      words: expect.stringMatching(/hasn’t checked the mailbox lately/) as unknown,
    });
    await said(true);
    expect(await offered()).toBe(true);
    expect((await view()).server).toMatchObject({
      state: 'ready',
      address: 'home@vault.test',
      folder: 'INBOX',
      words: 'The vault checks home@vault.test, in its INBOX folder.',
    });
    // Two polls of five minutes and a minute more: still. Past that: not running.
    await said(true, 10 * 60 + 30);
    expect(await offered()).toBe(true);
    await said(true, 11 * 60);
    expect(await offered()).toBe(true);
    await said(true, 11 * 60 + 1);
    expect(await offered()).toBe(false);
    await said(true, 11 * 60 + 30);
    expect(await offered()).toBe(false);
    expect((await view()).server.state).toBe('unknown');
    // A quicker poll goes stale sooner: two of a minute, and a minute more.
    await said(true, 3 * 60, { poll: 60 });
    expect(await offered()).toBe(true);
    await said(true, 3 * 60 + 1, { poll: 60 });
    expect(await offered()).toBe(false);
    // Not set up on the worker: said so, with what to set.
    await said(false);
    expect(await offered()).toBe(false);
    expect((await view()).server).toMatchObject({
      state: 'not_configured',
      address: null,
      words: expect.stringMatching(/FDV_MAIL_IN_HOST, FDV_MAIL_IN_USER and a password/) as unknown,
    });
  });

  it('is an owner’s to see and change: anybody else is refused; on only while offered, and one household at most', async () => {
    await said(true);
    for (const who of [adult, other, teen, viewer]) {
      expect((await call(who, 'GET', '/api/v1/mail-in')).statusCode).toBe(403);
      const put = await call(who, 'PUT', '/api/v1/mail-in', { enabled: true });
      expect(put.statusCode).toBe(403);
      expect(put.json<{ error: { message: string } }>().error.message).toMatch(/Only an owner/);
    }
    expect((await admin.query('select count(*)::int as n from mail_in')).rows[0]).toEqual({ n: 0 });
    const on = await call(owner, 'PUT', '/api/v1/mail-in', { enabled: true });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json<MailInView>()).toMatchObject({ enabled: true, available: true });
    // Off is always taken; on only while offered.
    await said(false);
    expect((await call(owner, 'PUT', '/api/v1/mail-in', { enabled: false })).statusCode).toBe(200);
    const refused = await call(owner, 'PUT', '/api/v1/mail-in', { enabled: true });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe('mail_in_unavailable');
    // Another household on this server has it on: the mailbox is the server's.
    await said(true);
    const elsewhere = randomUUID();
    await admin.query("insert into household (id, name) values ($1, 'Next door')", [elsewhere]);
    await admin.query('insert into mail_in (household_id, enabled) values ($1, true)', [elsewhere]);
    const taken = await call(owner, 'PUT', '/api/v1/mail-in', { enabled: true });
    expect(taken.statusCode).toBe(409);
    expect(taken.json<{ error: { code: string } }>().error.code).toBe('mail_in_in_use');
    await admin.query('delete from household where id = $1', [elsewhere]);
    // Nothing else is taken in its form.
    expect(
      (await call(owner, 'PUT', '/api/v1/mail-in', { enabled: true, unknown_senders: 0 }))
        .statusCode,
    ).toBe(422);
  });

  it('is the owners’ in the database too, and what the worker says is the worker’s', async () => {
    await turnOn();
    await admin.query('update mail_in set unknown_senders = 3 where household_id = $1', [
      owner.household_id,
    ]);
    for (const [who, role] of [
      [adult, 'adult'],
      [teen, 'teen'],
      [viewer, 'viewer'],
    ] as const) {
      expect(await asCaller(who, role, 'select * from mail_in'), role).toMatchObject({ rows: [] });
      expect(
        await asCaller(who, role, 'update mail_in set enabled = false, updated_by = app_account()'),
        role,
      ).toMatchObject({ count: 0 });
    }
    expect(
      await asCaller(
        adult,
        'adult',
        `insert into mail_in (household_id, enabled, updated_by) values (app_household(), true, app_account())
         on conflict (household_id) do nothing`,
      ),
    ).toMatchObject({ code: '42501' });
    expect(await asCaller(owner, 'owner', 'select unknown_senders from mail_in')).toMatchObject({
      rows: [{ unknown_senders: 3 }],
    });
    expect(
      await asCaller(
        owner,
        'owner',
        'update mail_in set enabled = false, updated_by = app_account()',
      ),
    ).toMatchObject({ count: 1 });
    // Never what the worker says; never as somebody else.
    expect(
      await asCaller(
        owner,
        'owner',
        'update mail_in set unknown_senders = 0, updated_by = app_account()',
      ),
    ).toMatchObject({ code: '42501' });
    expect(
      await asCaller(
        owner,
        'owner',
        "update mail_in set last_error = 'unreachable', updated_by = app_account()",
      ),
    ).toMatchObject({ code: '42501' });
    expect(
      await asCaller(owner, 'owner', 'update mail_in set enabled = true, updated_by = null'),
    ).toMatchObject({ code: '42501' });
    // The mailbox's state: read by the application, written by the vault's owning role alone.
    expect(
      await asCaller(
        owner,
        'owner',
        `insert into mail_in_server (configured, poll_seconds) values (true, 300)`,
      ),
    ).toMatchObject({ code: '42501' });
    // An email's batch, an item saying its sender, a note: the vault's alone.
    const acct = await admin.query<{ account_id: string }>(
      'select account_id from account_household where member_id = $1',
      [adult.member_id],
    );
    expect(
      await asCaller(
        adult,
        'adult',
        `insert into intake_batch (household_id, created_by, member_id, mail_day, ends_at)
         values (app_household(), $1, app_member(), current_date, now() + interval '1 day')`,
        [acct.rows[0]?.account_id],
      ),
    ).toMatchObject({ code: '42501' });
    expect(
      await asCaller(
        adult,
        'adult',
        `insert into watch_notice (household_id, member_id, source, reason, file_key)
         values (app_household(), app_member(), 'email', 'nothing_to_add', gen_random_uuid())`,
      ),
    ).toMatchObject({ code: '42501' });
  });

  it('tells whoever may add documents where to send from where: never a viewer, and nothing while it is off', async () => {
    await said(true);
    expect(await mine(adult)).toMatchObject({
      on: false,
      address: null,
      email: 'ahmed@example.test',
      confirmed: false,
      confirm: { send_from: false, emailed: false },
      held: null,
    });
    expect((await call(adult, 'POST', '/api/v1/mail-in/me/code')).statusCode).toBe(409);
    expect((await call(adult, 'POST', '/api/v1/mail-in/me/email-code')).statusCode).toBe(409);
    await turnOn();
    // A viewer is never included; a teen is.
    for (const url of [
      '/api/v1/mail-in/me',
      '/api/v1/mail-in/me/code',
      '/api/v1/mail-in/me/email-code',
    ]) {
      expect((await call(viewer, url.endsWith('me') ? 'GET' : 'POST', url)).statusCode, url).toBe(
        403,
      );
    }
    expect(
      (await call(viewer, 'POST', '/api/v1/mail-in/me/confirm', { code: 'ABCD-EFGH' })).statusCode,
    ).toBe(403);
    expect(await mine(teen)).toMatchObject({
      on: true,
      address: 'home@vault.test',
      email: 'tia@example.test',
    });
    // What of theirs was left in the mailbox: told to them alone, counts and a date.
    await admin.query(
      `insert into mail_in_address (household_id, member_id, held_unverified, held_unconfirmed, held_last_at)
       values ($1, $2, 1, 2, '2026-10-12T08:00:00Z')`,
      [owner.household_id, adult.member_id],
    );
    expect((await mine(adult)).held).toEqual({
      unverified: 1,
      unconfirmed: 2,
      last_at: '2026-10-12T08:00:00.000Z',
    });
    expect((await mine(other)).held).toBeNull();
  });

  it('a code to send FROM the address only while the mailbox checks senders, with a mailto link (F1)', async () => {
    await turnOn();
    // Senders not checked: sending a code from an address would prove nothing.
    await said(true);
    expect((await mine(adult)).confirm.send_from).toBe(false);
    const refused = await call(adult, 'POST', '/api/v1/mail-in/me/code');
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe('mail_in_no_sender_check');
    await said(true, 0, { sender_check: true });
    expect((await mine(adult)).confirm.send_from).toBe(true);
    const made = await call(adult, 'POST', '/api/v1/mail-in/me/code');
    expect(made.statusCode, made.body).toBe(200);
    expect(made.headers['cache-control']).toBe('no-store');
    const { code, mailto } = made.json<MailInCode>();
    expect(code).toMatch(new RegExp(`^${MAIL_IN_CODE_PATTERN.source}$`));
    expect(mailto).toBe(`mailto:home%40vault.test?subject=${code}`);
    // Kept as its SHA-256 alone, as one to send from the address.
    const row = await admin.query<{ code_hash: Buffer; code_kind: string }>(
      'select code_hash, code_kind from mail_in_address where member_id = $1',
      [adult.member_id],
    );
    expect(row.rows[0]?.code_hash.equals(createHash('sha256').update(code).digest())).toBe(true);
    expect(row.rows[0]?.code_kind).toBe('send');
    expect(await mine(adult)).toMatchObject({ code_kind: 'send', confirmed: false });
    // A code a minute.
    expect((await call(adult, 'POST', '/api/v1/mail-in/me/code')).statusCode).toBe(429);
  });

  it('a code emailed TO the address, typed in: used once, five tries, a day, a code a minute and five a day (F1)', async () => {
    await turnOn();
    await said(true);
    expect((await mine(adult)).confirm).toEqual({ send_from: false, emailed: true });
    const before = mailSent(h).length;
    const sent = await call(adult, 'POST', '/api/v1/mail-in/me/email-code');
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json<MailInEmailed>().sent_to).not.toBe('ahmed@example.test');
    const out = mailSent(h).slice(before);
    expect(out.map((m) => m.to)).toEqual(['ahmed@example.test']);
    const code = /\b([A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4})\b/.exec(
      out[0]?.text ?? '',
    )?.[1] as string;
    expect(code).toBeTruthy();
    // Kept as an HMAC, never as itself.
    const kept = await admin.query<{ code_hash: Buffer; code_kind: string }>(
      'select code_hash, code_kind from mail_in_address where member_id = $1',
      [adult.member_id],
    );
    expect(kept.rows[0]?.code_kind).toBe('enter');
    expect(kept.rows[0]?.code_hash.equals(createHash('sha256').update(code).digest())).toBe(false);
    // The wrong code: refused, a try spent; the right one confirms; used once.
    const wrong = await call(adult, 'POST', '/api/v1/mail-in/me/confirm', { code: 'AAAA-BBBB' });
    expect(wrong.statusCode).toBe(422);
    // Another person's typing it is nothing to them: the code is the adult's.
    expect((await call(other, 'POST', '/api/v1/mail-in/me/confirm', { code })).statusCode).toBe(
      410,
    );
    const ok = await call(adult, 'POST', '/api/v1/mail-in/me/confirm', {
      code: code.toLowerCase(),
    });
    expect(ok.statusCode, ok.body).toBe(204);
    expect(await mine(adult)).toMatchObject({ confirmed: true });
    expect((await call(adult, 'POST', '/api/v1/mail-in/me/confirm', { code })).statusCode).toBe(
      410,
    );
    // Five wrong tries, and the code is spent.
    await call(teen, 'POST', '/api/v1/mail-in/me/email-code');
    const teenCode = /\b([A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4})\b/.exec(
      mailSent(h).at(-1)?.text ?? '',
    )?.[1] as string;
    for (let i = 0; i < 5; i++) {
      expect(
        (await call(teen, 'POST', '/api/v1/mail-in/me/confirm', { code: 'AAAA-BBBB' })).statusCode,
      ).toBe(422);
    }
    expect(
      (await call(teen, 'POST', '/api/v1/mail-in/me/confirm', { code: teenCode })).statusCode,
    ).toBe(410);
    // A code a minute; five a day.
    expect((await call(teen, 'POST', '/api/v1/mail-in/me/email-code')).statusCode).toBe(429);
    await admin.query(
      "update mail_in_address set code_sent_at = now() - interval '2 minutes', codes_sent = 5 where member_id = $1",
      [teen.member_id],
    );
    const many = await call(teen, 'POST', '/api/v1/mail-in/me/email-code');
    expect(many.statusCode).toBe(429);
    expect(many.json<{ error: { message: string } }>().error.message).toMatch(/Five codes/);
    // A day on: expired.
    await admin.query(
      "update mail_in_address set code_expires_at = now() - interval '1 second', code_attempts = 0 where member_id = $1",
      [teen.member_id],
    );
    expect(
      (await call(teen, 'POST', '/api/v1/mail-in/me/confirm', { code: teenCode })).statusCode,
    ).toBe(410);
  });

  it('with neither the sender check nor the operator’s mail server, nobody can confirm, and both pages say why (F1)', async () => {
    const quiet = await createHarness({ rateLimitPerMinute: 100_000, operatorMail: false });
    try {
      const boss = await quiet.setup();
      const kid = await quiet.join(boss, { name: 'Kid', email: 'kid@example.test', role: 'teen' });
      const qadmin = createPool(quiet.adminUrl, 1);
      try {
        await qadmin.query(
          `insert into mail_in_server (singleton, configured, address, folder, after, sender_check, poll_seconds, checked_at)
           values (true, true, 'home@vault.test', 'INBOX', 'move', false, 300, now())
           on conflict (singleton) do update set configured = true, sender_check = false, checked_at = now()`,
        );
        await qadmin.query('insert into mail_in (household_id, enabled) values ($1, true)', [
          boss.household_id,
        ]);
        const ask = (who: Tokens, method: 'GET' | 'POST', url: string) =>
          quiet.app.inject({ method, url, headers: quiet.as(who), remoteAddress: '10.70.0.1' });
        const me = (await ask(kid, 'GET', '/api/v1/mail-in/me')).json<MailInMine>();
        expect(me).toMatchObject({
          on: true,
          confirmed: false,
          confirm: { send_from: false, emailed: false },
        });
        expect(me.confirm_words).toMatch(/Nobody can confirm their address yet/);
        expect((await ask(kid, 'POST', '/api/v1/mail-in/me/code')).statusCode).toBe(409);
        expect((await ask(kid, 'POST', '/api/v1/mail-in/me/email-code')).statusCode).toBe(409);
        const owners = (await ask(boss, 'GET', '/api/v1/mail-in')).json<MailInView>();
        expect(owners.confirm_warning).toMatch(/FDV_MAIL_IN_AUTHSERV_ID .* or FDV_SMTP_URL/);
      } finally {
        await qadmin.query('delete from mail_in');
        await qadmin.end();
      }
    } finally {
      await quiet.close();
    }
  });

  it('an address’s row is written by the vault’s own functions alone: nobody signed in writes it directly (F1)', async () => {
    await admin.query(
      `insert into mail_in_address (household_id, member_id, email, confirmed_at) values ($1, $2, 'bea@example.test', now())`,
      [owner.household_id, other.member_id],
    );
    expect(await asCaller(owner, 'owner', 'select * from mail_in_address')).toMatchObject({
      rows: [],
    });
    expect(await asCaller(other, 'adult', 'select member_id from mail_in_address')).toMatchObject({
      rows: [{ member_id: other.member_id }],
    });
    expect(await asCaller(viewer, 'viewer', 'select * from mail_in_address')).toMatchObject({
      rows: [],
    });
    for (const [who, role, text] of [
      [
        other,
        'adult',
        'update mail_in_address set code_hash = null, code_kind = null, code_expires_at = null',
      ],
      [other, 'adult', 'update mail_in_address set confirmed_at = now()'],
      [
        teen,
        'teen',
        `insert into mail_in_address (household_id, member_id) values (app_household(), app_member())`,
      ],
      [
        teen,
        'teen',
        `insert into mail_in_address (household_id, member_id, email, confirmed_at)
         values (app_household(), app_member(), 'tia@example.test', now())`,
      ],
    ] as const) {
      expect(await asCaller(who, role, text), text).toMatchObject({ code: '42501' });
    }
    expect(await asCaller(other, 'adult', 'delete from mail_in_address')).toMatchObject({
      count: 0,
    });
    // A viewer's call of the vault's functions is refused by them.
    expect(
      await asCaller(viewer, 'viewer', 'select mail_in_issue_code($1, $2)', [
        randomBytes(32),
        'enter',
      ]),
    ).toMatchObject({ code: '42501' });
    // And they are the application's alone, as mail_in_on is (F9).
    const granted = await admin.query<{ fn: string; public: boolean }>(
      `select p.proname as fn, has_function_privilege('public', p.oid, 'execute') as public
         from pg_proc p where p.proname in ('mail_in_on', 'mail_in_issue_code', 'mail_in_check_code')
        order by p.proname`,
    );
    expect(granted.rows).toEqual([
      { fn: 'mail_in_check_code', public: false },
      { fn: 'mail_in_issue_code', public: false },
      { fn: 'mail_in_on', public: false },
    ]);
  });

  it('says what went wrong and what was left alone, in words with no secret; warns while senders are not checked', async () => {
    await said(true);
    await turnOn();
    await admin.query(
      `update mail_in set last_error = 'login_failed', last_error_at = now(), last_checked_at = now(),
              unknown_senders = 3, unverified = 1, waiting = 2 where household_id = $1`,
      [owner.household_id],
    );
    const v = await view();
    expect(v.last_error).toMatchObject({
      code: 'login_failed',
      words: expect.stringMatching(/refused the vault’s sign-in.*tries less often/) as unknown,
    });
    expect(v.counts).toEqual([
      '3 emails from unknown senders were ignored. They are still in the mailbox, unread.',
      '1 email from family addresses didn’t pass the mailbox’s sender check, so it was ignored as possibly forged.',
      '2 emails wait: the sender can’t have files added just now (their sign-in is locked or waits after a restore, or today’s batch is full).',
    ]);
    expect(v.sender_warning).toMatch(/Set FDV_MAIL_IN_AUTHSERV_ID/);
    await said(true, 0, { sender_check: true });
    expect((await view()).sender_warning).toBeNull();
    // The password is in nothing the API answers.
    for (const [who, url] of [
      [owner, '/api/v1/mail-in'],
      [adult, '/api/v1/mail-in/me'],
    ] as const) {
      expect((await call(who, 'GET', url)).body).not.toContain(PASSWORD);
    }
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/capabilities' })).body).not.toContain(
      PASSWORD,
    );
  });

  it('an email’s notes are its person’s alone, in plain words; an item from an unverified sender says so', async () => {
    await said(true, 0, { after: 'delete' });
    await admin.query(
      `insert into watch_notice (household_id, member_id, source, file_name, reason, file_key)
       values ($1, $2, 'email', null, 'nothing_to_add', gen_random_uuid())`,
      [owner.household_id, adult.member_id],
    );
    await admin.query(
      `insert into watch_notice (household_id, member_id, source, file_name, reason, skipped, file_key)
       values ($1, $2, 'email', 'AHMED-HUGE-SCAN.pdf', 'skipped', '{"too_large": 1, "unsupported": 2}', gen_random_uuid())`,
      [owner.household_id, adult.member_id],
    );
    const got = (await call(adult, 'GET', '/api/v1/watch-folder/notices')).json<{
      items: WatchNoticeView[];
    }>().items;
    expect(got.map((n) => [n.source, n.title]).sort()).toEqual([
      ['email', 'An email had nothing we could add'],
      ['email', 'Some attachments couldn’t be added'],
    ]);
    // Never "deleted": a provider may keep what is deleted (Gmail archives it).
    expect(got.find((n) => n.reason === 'nothing_to_add')?.words).toMatch(
      /No PDF, photo, Word or Excel file was attached.*taken out of the household mailbox’s inbox/,
    );
    expect(got.find((n) => n.reason === 'skipped')?.words).toMatch(
      /2 aren’t a kind of file the vault keeps; 1 is larger than .*kept in the household mailbox, so nothing is lost/,
    );
    for (const who of [owner, other, teen]) {
      const r = await call(who, 'GET', '/api/v1/watch-folder/notices');
      expect(r.body).not.toContain('AHMED-HUGE-SCAN');
      expect(r.json<{ items: unknown[] }>().items).toEqual([]);
    }

    // An item from an email whose sender was not verified: its card says so.
    const acct = await admin.query<{ account_id: string }>(
      'select account_id from account_household where member_id = $1',
      [adult.member_id],
    );
    const batch = await admin.query<{ id: string }>(
      `insert into intake_batch (household_id, created_by, member_id, name, mail_day, ends_at)
       values ($1, $2, $3, 'Email, 13 Oct', '2026-10-13', now() + interval '20 days') returning id`,
      [owner.household_id, acct.rows[0]?.account_id, adult.member_id],
    );
    const scope = await admin.query<{ id: string }>(
      "select id from scope_key where kind = 'member' and member_id = $1",
      [adult.member_id],
    );
    const vault = await admin.query<{ active_vault_id: string }>(
      'select active_vault_id from household where id = $1',
      [owner.household_id],
    );
    await admin.query(
      `insert into incoming_file (household_id, batch_id, review_by, requester_member_id, state,
                                  original_name, mime, byte_size, sha256, cipher_bytes,
                                  cipher_sha256, storage_key, vault_id, file_key_wrapped,
                                  wrapped_by_scope, scope, scan_state, read_state, received_at,
                                  submitted_at, idempotency_key, mail_key, sender_unverified)
       values ($1, $2, 'me', $3, 'received', 'AHMED-EMAILED.pdf', 'application/pdf', 1, $4, 1,
               $4, $5, $6, '\\x00', $7, 'member', 'unscanned', 'waiting', now(), now(),
               gen_random_uuid(), gen_random_uuid(), true)`,
      [
        owner.household_id,
        batch.rows[0]?.id,
        adult.member_id,
        randomBytes(32),
        `${owner.household_id}/batches/y.enc`,
        vault.rows[0]?.active_vault_id,
        scope.rows[0]?.id,
      ],
    );
    const detail = await call(adult, 'GET', `/api/v1/batches/${batch.rows[0]?.id}`);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(
      detail.json<{ name: string; items: Array<{ name: string; sender_unverified?: boolean }> }>(),
    ).toMatchObject({
      name: 'Email, 13 Oct',
      items: [{ name: 'AHMED-EMAILED.pdf', sender_unverified: true }],
    });
    for (const who of [owner, other]) {
      expect((await call(who, 'GET', '/api/v1/batches')).body).not.toContain('Email, 13 Oct');
    }
  });

  it('says in the activity log who turned it on or off: to the owners alone', async () => {
    await said(true);
    await call(owner, 'PUT', '/api/v1/mail-in', { enabled: true });
    await call(owner, 'PUT', '/api/v1/mail-in', { enabled: false });
    const lines = async (who: Tokens) =>
      (await call(who, 'GET', '/api/v1/audit'))
        .json<{ items: Array<{ text: string }> }>()
        .items.map((l) => l.text);
    expect(await lines(owner)).toEqual(
      expect.arrayContaining(['Owner turned on email in', 'Owner turned off email in']),
    );
    expect((await lines(adult)).some((t) => t.includes('email in'))).toBe(false);
  });
});
