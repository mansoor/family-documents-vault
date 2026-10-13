import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  MAIL_IN_CODE_PATTERN,
  type Capabilities,
  type MailInCode,
  type MailInMine,
  type MailInView,
  type WatchNoticeView,
} from '@fdv/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';

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
  const PASSWORD = `pw-${randomBytes(9).toString('hex')}`;

  beforeAll(async () => {
    // The worker's password in this process's environment, as a careless
    // compose file might put it: the API must still never say it.
    process.env.FDV_MAIL_IN_PASSWORD = PASSWORD;
    h = await createHarness({ rateLimitPerMinute: 100_000 });
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
  /** The mailbox as the worker says it, `ago` seconds ago. */
  const said = (
    configured: boolean,
    ago = 0,
    over: { sender_check?: boolean; poll?: number; after?: string } = {},
  ) =>
    admin.query(
      `insert into mail_in_server (singleton, configured, address, folder, after, sender_check, poll_seconds, checked_at)
       values (true, $1, $2, $3, $4, $5, $6, now() - make_interval(secs => $7))
       on conflict (singleton) do update set configured = $1, address = $2, folder = $3, after = $4,
         sender_check = $5, poll_seconds = $6, checked_at = now() - make_interval(secs => $7)`,
      [
        configured,
        configured ? 'home@vault.test' : null,
        configured ? 'INBOX' : null,
        over.after ?? 'move',
        over.sender_check ?? false,
        over.poll ?? 300,
        ago,
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
    await said(true, 11 * 60 + 30);
    expect(await offered()).toBe(false);
    expect((await view()).server.state).toBe('unknown');
    // A quicker poll goes stale sooner.
    await said(true, 3 * 60, { poll: 60 });
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

  it('tells whoever may add documents where to send from where, and gives them a code to confirm it: theirs alone', async () => {
    // Off: says so, and names no mailbox.
    await said(true);
    expect(await mine(adult)).toEqual({
      on: false,
      address: null,
      email: 'ahmed@example.test',
      confirmed: false,
      code_expires_at: null,
      sender_check: false,
    });
    expect((await call(adult, 'POST', '/api/v1/mail-in/me/code')).statusCode).toBe(409);
    await turnOn();
    // A viewer is never included; a teen is.
    expect((await call(viewer, 'GET', '/api/v1/mail-in/me')).statusCode).toBe(403);
    expect((await call(viewer, 'POST', '/api/v1/mail-in/me/code')).statusCode).toBe(403);
    expect(await mine(teen)).toMatchObject({
      on: true,
      address: 'home@vault.test',
      email: 'tia@example.test',
    });
    const made = await call(adult, 'POST', '/api/v1/mail-in/me/code');
    expect(made.statusCode, made.body).toBe(200);
    expect(made.headers['cache-control']).toBe('no-store');
    const { code, expires_at } = made.json<MailInCode>();
    expect(code).toMatch(new RegExp(`^${MAIL_IN_CODE_PATTERN.source}$`));
    expect(new Date(expires_at).getTime() - Date.now()).toBeGreaterThan(23 * 3600_000);
    // Kept as its SHA-256 alone.
    const row = await admin.query<{ code_hash: Buffer; email: string | null }>(
      'select code_hash, email from mail_in_address where member_id = $1',
      [adult.member_id],
    );
    expect(row.rows[0]?.code_hash.equals(createHash('sha256').update(code).digest())).toBe(true);
    expect(JSON.stringify(row.rows)).not.toContain(code);
    expect(await mine(adult)).toMatchObject({
      on: true,
      confirmed: false,
      code_expires_at: expires_at,
    });
    // A new code is a new one: the old stops working.
    const again = (await call(adult, 'POST', '/api/v1/mail-in/me/code')).json<MailInCode>();
    expect(again.code).not.toBe(code);
    // Confirmed by the worker: while it is still their sign-in's address.
    await admin.query(
      "update mail_in_address set email = 'ahmed@example.test', confirmed_at = now(), code_hash = null, code_expires_at = null where member_id = $1",
      [adult.member_id],
    );
    expect(await mine(adult)).toMatchObject({ confirmed: true, code_expires_at: null });
    await admin.query(
      "update mail_in_address set email = 'old@example.test' where member_id = $1",
      [adult.member_id],
    );
    expect((await mine(adult)).confirmed).toBe(false);

    // In the database: each reads and writes their own, and only their code.
    await admin.query(
      `insert into mail_in_address (household_id, member_id, email, confirmed_at) values ($1, $2, 'bea@example.test', now())`,
      [owner.household_id, other.member_id],
    );
    expect(await asCaller(owner, 'owner', 'select * from mail_in_address')).toMatchObject({
      rows: [],
    });
    expect(await asCaller(adult, 'adult', 'select member_id from mail_in_address')).toMatchObject({
      rows: [{ member_id: adult.member_id }],
    });
    expect(await asCaller(viewer, 'viewer', 'select * from mail_in_address')).toMatchObject({
      rows: [],
    });
    expect(
      await asCaller(
        adult,
        'adult',
        'update mail_in_address set confirmed_at = now(), email = $1',
        ['ahmed@example.test'],
      ),
    ).toMatchObject({ code: '42501' });
    expect(
      await asCaller(
        teen,
        'teen',
        `insert into mail_in_address (household_id, member_id, email, confirmed_at)
         values (app_household(), app_member(), 'tia@example.test', now())`,
      ),
    ).toMatchObject({ code: '42501' });
    expect(
      await asCaller(
        teen,
        'teen',
        `insert into mail_in_address (household_id, member_id, code_hash, code_expires_at)
         values (app_household(), $1, $2, now() + interval '1 hour')`,
        [other.member_id, randomBytes(32)],
      ),
    ).toMatchObject({ code: '42501' });
    expect(await asCaller(adult, 'adult', 'delete from mail_in_address')).toMatchObject({
      count: 0,
    });
    expect(
      await asCaller(
        adult,
        'adult',
        "update mail_in_address set code_hash = $1, code_expires_at = now() + interval '30 days'",
        [randomBytes(32)],
      ),
    ).toMatchObject({ code: '23514' });
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
       values ($1, $2, 'email', null, 'nothing_to_add', gen_random_uuid()),
              ($1, $2, 'email', 'AHMED-HUGE-SCAN.pdf', 'too_large', gen_random_uuid())`,
      [owner.household_id, adult.member_id],
    );
    const got = (await call(adult, 'GET', '/api/v1/watch-folder/notices')).json<{
      items: WatchNoticeView[];
    }>().items;
    expect(got.map((n) => [n.source, n.title]).sort()).toEqual([
      ['email', 'An attachment couldn’t be added'],
      ['email', 'An email had nothing we could add'],
    ]);
    expect(got.find((n) => n.reason === 'nothing_to_add')?.words).toMatch(
      /No PDF, photo, Word or Excel file was attached.*deleted from the household mailbox/,
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
