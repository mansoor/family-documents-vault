import { randomBytes } from 'node:crypto';
import {
  deriveKey,
  MAILBOX_PASSWORD_PURPOSE,
  MASTER_SEALED,
  openMailboxPassword,
} from '@fdv/crypto';
import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { Capabilities, MailInMine, MailInView, SettingsCheckView } from '@fdv/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, TEST_MASTER, type Harness } from '../test-harness.js';

/**
 * The household mailbox set up in Settings (0.9.0, O1), in the API: an
 * owner's, at the API and in the database; overriding the server's
 * FDV_MAIL_IN_*, for the owners' page and for whoever is told where to
 * send; its app password sealed under a key of its own derived from the
 * master key, with the household bound in — never in an answer, the log,
 * the activity log, a query's text, or the database in plain text; kept
 * when left out, gone with the mailbox; and "Test the mailbox" asked of
 * the worker and its answer said in plain words.
 */
describe.skipIf(!testAdminUrl())('the household mailbox set up in Settings, in the API', () => {
  let h: Harness;
  let owner: Tokens;
  let adult: Tokens;
  let teen: Tokens;
  let viewer: Tokens;
  let admin: ReturnType<typeof createPool>;
  let app: ReturnType<typeof createPool>;
  let nth = 0;
  const logged: string[] = [];
  const queries: string[] = [];
  const PASSWORD = `app-pw-${randomBytes(9).toString('hex')}`;

  beforeAll(async () => {
    h = await createHarness({
      rateLimitPerMinute: 100_000,
      logger: { level: 'trace', stream: { write: (s: string) => void logged.push(s) } },
      log: (e) => {
        queries.push(`${e.query.sql} ${JSON.stringify(e.query.parameters)}`);
      },
    });
    owner = await h.setup();
    adult = await h.join(owner, { name: 'Ahmed', email: 'ahmed-mb@example.test', role: 'adult' });
    teen = await h.join(owner, { name: 'Tia', email: 'tia-mb@example.test', role: 'teen' });
    viewer = await h.join(owner, { name: 'Vic', email: 'vic-mb@example.test', role: 'viewer' });
    admin = createPool(h.adminUrl, 2);
    app = createPool(h.appUrl, 1);
  }, 60_000);
  afterAll(async () => {
    await app?.end();
    await admin?.end();
    await h?.close();
  });
  beforeEach(async () => {
    await admin.query('delete from mail_in');
    await admin.query('delete from mail_in_mailbox');
    await admin.query('delete from mail_in_server');
    await admin.query('delete from settings_check');
    h.jobs.length = 0;
    // The owner confirmed it is them just now: changing the mailbox asks it (the O1 review, H1).
    await fresh(owner);
  });

  /** Their sessions just confirmed it's them. */
  const fresh = (t: Tokens) =>
    admin.query(
      `update session set verified_at = now(), factor_verified_at = now()
        where account_id = (select account_id from account_household where member_id = $1)
          and revoked_at is null`,
      [t.member_id],
    );
  /** What a password was sealed for: the box() below. */
  const GMAIL = { host: 'imap.gmail.com', port: 993, username: 'family.docs@gmail.com' };

  const call = (
    who: Tokens,
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    h.app.inject({
      method,
      url,
      headers: h.as(who),
      ...(payload ? { payload } : {}),
      remoteAddress: `10.77.${++nth >> 8}.${nth & 0xff}`,
    });
  /** The worker's word: the server's own mailbox set up or not; how many households' it counted. */
  const said = (configured: boolean, mailboxes = 0, ago = 0) =>
    admin.query(
      `insert into mail_in_server (singleton, configured, address, folder, after, sender_check, poll_seconds, mailboxes, checked_at)
       values (true, $1, $2, $3, 'move', false, 300, $4, now() - make_interval(secs => $5))
       on conflict (singleton) do update set configured = $1, address = $2, folder = $3,
         mailboxes = $4, checked_at = now() - make_interval(secs => $5),
         allowed_ports = '{993}', allow_private = false`,
      [
        configured,
        configured ? 'server@vault.test' : null,
        configured ? 'INBOX' : null,
        mailboxes,
        ago,
      ],
    );
  const box = (over: Record<string, unknown> = {}) => ({
    host: 'imap.gmail.com',
    port: 993,
    username: 'family.docs@gmail.com',
    password: PASSWORD,
    folder: 'INBOX',
    after: 'move',
    authserv_id: 'mx.google.com',
    poll_seconds: 120,
    ...over,
  });
  const view = async () => {
    const r = await call(owner, 'GET', '/api/v1/mail-in');
    expect(r.statusCode, r.body).toBe(200);
    return r.json<MailInView>();
  };
  const sealed = async () =>
    (
      await admin.query<{ p: Buffer | null }>(
        'select password_encrypted as p from mail_in_mailbox where household_id = $1',
        [owner.household_id],
      )
    ).rows[0]?.p ?? null;

  it('is an owner’s to set up, change, remove and test: anybody else is refused', async () => {
    await said(false);
    for (const who of [adult, teen, viewer]) {
      expect((await call(who, 'PUT', '/api/v1/mail-in/mailbox', box())).statusCode).toBe(403);
      expect((await call(who, 'DELETE', '/api/v1/mail-in/mailbox')).statusCode).toBe(403);
      expect((await call(who, 'POST', '/api/v1/mail-in/mailbox/test')).statusCode).toBe(403);
    }
    expect(await sealed()).toBeNull();
    expect((await admin.query('select count(*)::int as n from mail_in_mailbox')).rows[0]).toEqual({
      n: 0,
    });
    const r = await call(owner, 'PUT', '/api/v1/mail-in/mailbox', box());
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('keeps the app password sealed: never answered, logged, written plain, or put in the activity log', async () => {
    await said(false, 1);
    logged.length = 0;
    queries.length = 0;
    const saved = await call(owner, 'PUT', '/api/v1/mail-in/mailbox', box());
    expect(saved.statusCode, saved.body).toBe(200);
    const v = saved.json<MailInView>();
    expect(v.mailbox).toMatchObject({
      host: 'imap.gmail.com',
      port: 993,
      username: 'family.docs@gmail.com',
      password: 'set',
      folder: 'INBOX',
      after: 'move',
      authserv_id: 'mx.google.com',
      poll_seconds: 120,
    });
    const got = await call(owner, 'GET', '/api/v1/mail-in');
    for (const body of [saved.body, got.body]) expect(body).not.toContain(PASSWORD);
    // Sealed under its own key, the household bound in: opens there, and only there.
    const p = await sealed();
    expect(p).not.toBeNull();
    expect((p as Buffer).toString('latin1')).not.toContain(PASSWORD);
    const key = deriveKey(TEST_MASTER, MAILBOX_PASSWORD_PURPOSE);
    expect(openMailboxPassword(key, p as Buffer, owner.household_id, GMAIL)).toBe(PASSWORD);
    expect(() => openMailboxPassword(key, p as Buffer, adult.member_id, GMAIL)).toThrow();
    expect(() =>
      openMailboxPassword(
        deriveKey(TEST_MASTER, 'smtp-credentials'),
        p as Buffer,
        owner.household_id,
        GMAIL,
      ),
    ).toThrow();
    // And the server, port and sign-in it was typed for (the O1 review, H1).
    for (const other of [
      { ...GMAIL, host: 'imap.attacker.test' },
      { ...GMAIL, port: 994 },
      { ...GMAIL, username: 'attacker@gmail.com' },
    ]) {
      expect(() => openMailboxPassword(key, p as Buffer, owner.household_id, other)).toThrow();
    }
    // A host's case is not another server.
    expect(
      openMailboxPassword(key, p as Buffer, owner.household_id, {
        ...GMAIL,
        host: 'IMAP.Gmail.com',
      }),
    ).toBe(PASSWORD);
    // One of the secrets rotate-master-key and a restore move.
    expect(MASTER_SEALED.find((s) => s.table === 'mail_in_mailbox')).toMatchObject({
      purpose: MAILBOX_PASSWORD_PURPOSE,
      column: 'password_encrypted',
    });
    // Nowhere else in the database.
    const { rows } = await admin.query<{ n: number }>(
      `select count(*)::int as n from audit_event where detail::text like '%' || $1 || '%'`,
      [PASSWORD],
    );
    expect(rows[0]?.n).toBe(0);
    const { rows: audit } = await admin.query<{ detail: unknown }>(
      `select detail from audit_event where action = 'mail_in.mailbox_saved' order by id desc limit 1`,
    );
    expect(audit[0]?.detail).toEqual({
      password_changed: true,
      host_changed: false,
      user_changed: false,
    });
    const dump = await admin.query<{ t: string }>(
      `select row_to_json(m)::text as t from mail_in_mailbox m`,
    );
    expect(dump.rows[0]?.t).not.toContain(PASSWORD);
    // Not in the API's log, nor in any query the API sent.
    expect(logged.join('\n')).not.toContain(PASSWORD);
    expect(queries.join('\n')).not.toContain(PASSWORD);
    // Even when the save is refused.
    logged.length = 0;
    const bad = await call(owner, 'PUT', '/api/v1/mail-in/mailbox', box({ host: 'not a host!' }));
    expect(bad.statusCode).toBe(422);
    expect(bad.body + logged.join('\n')).not.toContain(PASSWORD);
  });

  it('keeps the password when it is left out, changes it when one is typed, and goes with the mailbox', async () => {
    await said(false, 1);
    await call(owner, 'PUT', '/api/v1/mail-in/mailbox', box());
    const first = await sealed();
    const without: Record<string, unknown> = box({ folder: 'Scans', authserv_id: null });
    delete without.password;
    const kept = await call(owner, 'PUT', '/api/v1/mail-in/mailbox', without);
    expect(kept.statusCode, kept.body).toBe(200);
    expect(kept.json<MailInView>().mailbox).toMatchObject({
      password: 'set',
      folder: 'Scans',
      authserv_id: null,
    });
    expect((await sealed())?.equals(first as Buffer)).toBe(true);
    await call(owner, 'PUT', '/api/v1/mail-in/mailbox', box({ password: 'another-one' }));
    const key = deriveKey(TEST_MASTER, MAILBOX_PASSWORD_PURPOSE);
    expect(openMailboxPassword(key, (await sealed()) as Buffer, owner.household_id, GMAIL)).toBe(
      'another-one',
    );
    // A mailbox saved without one says so, and cannot be turned on.
    await admin.query('delete from mail_in_mailbox');
    const none = await call(owner, 'PUT', '/api/v1/mail-in/mailbox', without);
    expect(none.json<MailInView>()).toMatchObject({
      available: false,
      source: 'settings',
      mailbox: { password: 'not_set' },
      server: {
        state: 'not_configured',
        words: expect.stringMatching(/no app password yet/) as unknown,
      },
    });
    expect((await call(owner, 'PUT', '/api/v1/mail-in', { enabled: true })).statusCode).toBe(409);
    // Removed: the server's own mailbox again, and the password gone with it.
    await said(true, 0);
    const gone = await call(owner, 'DELETE', '/api/v1/mail-in/mailbox');
    expect(gone.statusCode, gone.body).toBe(200);
    expect(gone.json<MailInView>()).toMatchObject({ source: 'server', mailbox: null });
    expect((await admin.query('select count(*)::int as n from mail_in_mailbox')).rows[0]).toEqual({
      n: 0,
    });
  });

  it('overrides the server’s FDV_MAIL_IN_*: for the owners, for whoever is told where to send, and in /capabilities', async () => {
    // The server's own mailbox, set up and checked.
    await said(true);
    let v = await view();
    expect(v).toMatchObject({
      source: 'server',
      available: true,
      server: { address: 'server@vault.test', sender_check: false },
    });
    // The household's own, set up here: it is the one checked.
    await call(owner, 'PUT', '/api/v1/mail-in/mailbox', box());
    v = await view();
    expect(v).toMatchObject({
      source: 'settings',
      available: true,
      server: {
        state: 'ready',
        address: 'family.docs@gmail.com',
        folder: 'INBOX',
        sender_check: true,
        poll_seconds: 120,
      },
      sender_warning: null,
    });
    await call(owner, 'PUT', '/api/v1/mail-in', { enabled: true });
    const mine = (await call(adult, 'GET', '/api/v1/mail-in/me')).json<MailInMine>();
    expect(mine).toMatchObject({ on: true, address: 'family.docs@gmail.com', sender_check: true });
    // And only that much of it reaches somebody who is not an owner.
    expect(JSON.stringify(mine)).not.toContain('imap.gmail.com');
    // Without the server's own: offered all the same, once the worker counts one.
    await said(false, 0);
    const caps = async () =>
      (await h.app.inject({ method: 'GET', url: '/api/v1/capabilities' })).json<Capabilities>()
        .features.email_ingest;
    expect(await caps()).toBe(false);
    await said(false, 1);
    expect(await caps()).toBe(true);
    expect((await view()).available).toBe(true);
    // A worker that has not said lately: not offered, and not ready.
    await said(false, 1, 3600);
    expect(await caps()).toBe(false);
    expect((await view()).server.state).toBe('unknown');
    // Without a sender check, Settings says where to set one: here.
    await said(false, 1);
    await call(owner, 'PUT', '/api/v1/mail-in/mailbox', box({ authserv_id: null }));
    expect((await view()).sender_warning).toMatch(/Fill in the provider’s authserv-id below/);
  });

  it('is the owners’ in the database: nobody else reads or writes it, and others are told only where to send', async () => {
    await said(false, 1);
    await call(owner, 'PUT', '/api/v1/mail-in/mailbox', box());
    const asCaller = async (who: Tokens, role: string, text: string) => {
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
        const r = await c.query(text);
        return { rows: r.rows as unknown[], count: r.rowCount ?? 0 };
      } catch (err) {
        return { code: (err as { code?: string }).code ?? 'error' };
      } finally {
        await c.query('rollback').catch(() => undefined);
        c.release();
      }
    };
    for (const [who, role] of [
      [adult, 'adult'],
      [teen, 'teen'],
      [viewer, 'viewer'],
    ] as const) {
      expect(await asCaller(who, role, 'select * from mail_in_mailbox'), role).toMatchObject({
        rows: [],
      });
      expect(
        await asCaller(who, role, `update mail_in_mailbox set host = 'evil.example.test'`),
        role,
      ).toMatchObject({ count: 0 });
      expect(await asCaller(who, role, 'delete from mail_in_mailbox'), role).toMatchObject({
        count: 0,
      });
      // Told where to send, and nothing else of it.
      expect(await asCaller(who, role, 'select * from mail_in_box()'), role).toMatchObject({
        rows: [
          {
            configured: true,
            address: 'family.docs@gmail.com',
            after: 'move',
            sender_check: true,
          },
        ],
      });
    }
    // An owner changes it as themselves alone.
    expect(
      await asCaller(owner, 'owner', `update mail_in_mailbox set folder = 'X', updated_by = null`),
    ).toMatchObject({ code: '42501' });
    // A signed-out page, or a link, is given nothing.
    const c = await app.connect();
    try {
      await c.query('begin');
      await c.query(
        `select set_config('app.household_id', $1, true), set_config('app.actor', 'anonymous', true)`,
        [owner.household_id],
      );
      expect((await c.query('select * from mail_in_mailbox')).rows).toEqual([]);
      // Nor where the family sends (the O1 review, L5): mail_in_box() is a
      // signed-in person's, and the vault's.
      expect((await c.query('select * from mail_in_box()')).rows).toEqual([]);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });

  it('Test the mailbox is asked of the worker, and its answer said in plain words', async () => {
    await said(false, 1);
    await call(owner, 'PUT', '/api/v1/mail-in/mailbox', box());
    const asked = await call(owner, 'POST', '/api/v1/mail-in/mailbox/test');
    expect(asked.statusCode, asked.body).toBe(202);
    const check = asked.json<SettingsCheckView>();
    expect(check).toMatchObject({ kind: 'mailbox', state: 'waiting' });
    expect(h.jobs.filter((j) => j.name === 'settings.check').map((j) => j.data)).toEqual([
      { household_id: owner.household_id, check_id: check.id },
    ]);
    // The password is not on the queue either.
    expect(JSON.stringify(h.jobs)).not.toContain(PASSWORD);
    const answer = async (found: Record<string, unknown>) => {
      await admin.query('update settings_check set result = $1, done_at = now() where id = $2', [
        JSON.stringify({
          source: 'settings',
          problem: null,
          messages: null,
          move: null,
          uidplus: null,
          authserv_id_seen: null,
          authserv_id_set: 'mx.google.com',
          ...found,
        }),
        check.id,
      ]);
      const r = await call(owner, 'GET', `/api/v1/settings-checks/${check.id}`);
      expect(r.statusCode, r.body).toBe(200);
      return r.json<SettingsCheckView>().mailbox;
    };
    const fine = await answer({
      messages: 3,
      move: true,
      uidplus: true,
      authserv_id_seen: 'mx.google.com',
      headers_read: 3,
    });
    expect(fine).toMatchObject({ ok: true });
    // What was read, said as it is (the O1 review, L4).
    expect(fine?.lines).toEqual([
      'Signed in, and opened INBOX: 3 messages are there. Only the newest emails’ Authentication-Results headers were read (three at most); nothing was moved or marked.',
      'The server can move and delete one email alone (MOVE and UIDPLUS).',
      'The newest three messages’ Authentication-Results all name mx.google.com, as set.',
    ]);
    const other = await answer({
      messages: 4,
      move: false,
      uidplus: false,
      authserv_id_seen: 'mx.example.net',
      headers_read: 3,
    });
    expect(other?.lines[1]).toMatch(/can’t move or delete one email alone/);
    // Only a hint, said with its caution (L3): never "change it to".
    expect(other?.lines[2]).toMatch(/all name mx\.example\.net, not mx\.google\.com as set/);
    expect(other?.lines[2]).toMatch(/only a hint: anybody can write that header/);
    expect(other?.lines[2]).not.toMatch(/Change the authserv-id/);
    const one = await answer({ messages: 1, move: true, uidplus: true, headers_read: 1 });
    expect(one?.lines[2]).toMatch(/fewer than three messages/);
    const refused = await answer({ problem: 'login_failed' });
    expect(refused).toMatchObject({ ok: false });
    expect(refused?.lines).toEqual([
      expect.stringMatching(/refused the sign-in.*app password/) as unknown,
    ]);
    const empty = await answer({ messages: 0, move: true, uidplus: true });
    expect(empty?.lines[2]).toMatch(/fewer than three messages/);
    // A password that doesn't open for this server: said as such (L4).
    const sealedFor = await answer({ problem: 'password_sealed' });
    expect(sealedFor?.lines).toEqual([
      expect.stringMatching(/can’t open the saved app password for this server/) as unknown,
    ]);
  });

  it('a server, port or sign-in changed asks for the app password again, and the change is said without its values (the O1 review, H1)', async () => {
    await said(false, 1);
    expect((await call(owner, 'PUT', '/api/v1/mail-in/mailbox', box())).statusCode).toBe(200);
    const first = await sealed();
    const noPassword = (over: Record<string, unknown>) => {
      const b: Record<string, unknown> = box(over);
      delete b.password;
      return b;
    };
    // The reviewer's PoC: the host changed, and no password typed.
    for (const over of [
      { host: 'imap.attacker.test' },
      { port: 994 },
      { username: 'attacker@gmail.com' },
    ]) {
      await admin.query('update mail_in_server set allowed_ports = $1', [[993, 994]]);
      const r = await call(owner, 'PUT', '/api/v1/mail-in/mailbox', noPassword(over));
      expect(r.statusCode, JSON.stringify(over)).toBe(422);
      expect(r.json<{ error: { code: string; message: string } }>().error).toMatchObject({
        code: 'mailbox_password_needed',
        message: 'Type the app password again for the new server.',
      });
      expect((await sealed())?.equals(first as Buffer)).toBe(true);
    }
    // The rest changed alone: the password kept, as before.
    expect(
      (await call(owner, 'PUT', '/api/v1/mail-in/mailbox', noPassword({ folder: 'Scans' })))
        .statusCode,
    ).toBe(200);
    // A host's case is the same server.
    expect(
      (await call(owner, 'PUT', '/api/v1/mail-in/mailbox', noPassword({ host: 'IMAP.gmail.com' })))
        .statusCode,
    ).toBe(200);
    // With the password typed again: saved, sealed for the new server, and
    // what changed said — never what it changed to.
    const moved = await call(
      owner,
      'PUT',
      '/api/v1/mail-in/mailbox',
      box({ host: 'imap.fastmail.com', username: 'home@fastmail.test' }),
    );
    expect(moved.statusCode, moved.body).toBe(200);
    const key = deriveKey(TEST_MASTER, MAILBOX_PASSWORD_PURPOSE);
    expect(
      openMailboxPassword(key, (await sealed()) as Buffer, owner.household_id, {
        host: 'imap.fastmail.com',
        port: 993,
        username: 'home@fastmail.test',
      }),
    ).toBe(PASSWORD);
    const { rows: audit } = await admin.query<{ detail: unknown }>(
      `select detail from audit_event where action = 'mail_in.mailbox_saved' order by id desc limit 1`,
    );
    expect(audit[0]?.detail).toEqual({
      password_changed: true,
      host_changed: true,
      user_changed: true,
    });
    expect(JSON.stringify(audit)).not.toMatch(/fastmail/);
  });

  it('changing the mailbox asks the owner to confirm it is them (H1)', async () => {
    await said(false, 1);
    await admin.query(
      `update session set verified_at = now() - interval '1 hour', factor_verified_at = now() - interval '1 hour'
        where account_id = (select account_id from account_household where member_id = $1)`,
      [owner.member_id],
    );
    const r = await call(owner, 'PUT', '/api/v1/mail-in/mailbox', box());
    expect([r.statusCode, r.json<{ error: { code: string } }>().error.code]).toEqual([
      403,
      'step_up_required',
    ]);
    expect(await sealed()).toBeNull();
    await fresh(owner);
    expect((await call(owner, 'PUT', '/api/v1/mail-in/mailbox', box())).statusCode).toBe(200);
  });

  it('a server set up here: port 993 and an address outside the server’s network, unless the operator allows more (M3)', async () => {
    await said(false, 1);
    const refusedFor = async (over: Record<string, unknown>) => {
      const r = await call(owner, 'PUT', '/api/v1/mail-in/mailbox', box(over));
      return [r.statusCode, r.json<{ error?: { code: string } }>().error?.code ?? 'ok'];
    };
    for (const over of [
      { port: 143 },
      { port: 25 },
      { host: 'localhost' },
      { host: 'mail.localhost' },
      { host: '127.0.0.1' },
      { host: '169.254.169.254' },
      { host: '10.0.0.5' },
      { host: '192.168.1.2' },
    ]) {
      expect(await refusedFor(over), JSON.stringify(over)).toEqual([
        422,
        'mailbox_address_refused',
      ]);
    }
    expect(await sealed()).toBeNull();
    // As the worker says the operator allows.
    await admin.query('update mail_in_server set allowed_ports = $1, allow_private = true', [
      [993, 143],
    ]);
    expect(await refusedFor({ port: 143, host: '10.0.0.5' })).toEqual([200, 'ok']);
    // The refusal names the ports allowed, as the worker says them (the O1 re-check, 6).
    const words = async (over: Record<string, unknown>) =>
      (await call(owner, 'PUT', '/api/v1/mail-in/mailbox', box(over))).json<{
        error: { message: string };
      }>().error.message;
    expect(await words({ port: 25 })).toMatch(
      /its port isn’t one of 993, 143.* on port 993 or 143\./,
    );
    await admin.query('update mail_in_server set allowed_ports = $1, allow_private = false', [
      [993],
    ]);
    expect(await words({ port: 25 })).toMatch(/its port isn’t 993.* on port 993\./);
  });

  it('a sign-in or a folder with a control character in it is refused (L4)', async () => {
    await said(false, 1);
    for (const over of [
      { username: 'home\r\nA1 LOGOUT@gmail.com' },
      { username: 'home\u0000@gmail.com' },
      { folder: 'INBOX\r\nA2 DELETE INBOX' },
      { folder: 'In\tbox' },
    ]) {
      const r = await call(owner, 'PUT', '/api/v1/mail-in/mailbox', box(over));
      expect(r.statusCode, JSON.stringify(over)).toBe(422);
    }
    expect(await sealed()).toBeNull();
  });

  it('one Test the mailbox at a time: another while one is under way is refused (L6)', async () => {
    await said(false, 1);
    await call(owner, 'PUT', '/api/v1/mail-in/mailbox', box());
    const first = await call(owner, 'POST', '/api/v1/mail-in/mailbox/test');
    expect(first.statusCode, first.body).toBe(202);
    const second = await call(owner, 'POST', '/api/v1/mail-in/mailbox/test');
    expect([second.statusCode, second.json<{ error: { code: string } }>().error.code]).toEqual([
      429,
      'rate_limited',
    ]);
    expect(h.jobs.filter((j) => j.name === 'settings.check')).toHaveLength(1);
    // Answered: another may be asked.
    await admin.query(
      `update settings_check set result = '{"source":"settings","problem":"unreachable"}', done_at = now()`,
    );
    expect((await call(owner, 'POST', '/api/v1/mail-in/mailbox/test')).statusCode).toBe(202);
  });
});
