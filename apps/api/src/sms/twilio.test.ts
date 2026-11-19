import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { deriveKey, openSmsSecret, openTwilioToken, SMS_PASSWORD_PURPOSE } from '@fdv/crypto';
import {
  createPool,
  sendSms,
  SmsProviderError,
  TwilioProvider,
  withSystem,
  type SmsConnection,
  type SmsProviderFactory,
  type SmsWay,
} from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  LINK_TEXTS_CAP_SHARE,
  SMS_TEST_TEXT,
  type SmsSettingsView,
  type SmsTestResult,
} from '@fdv/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, TEST_MASTER, type Harness } from '../test-harness.js';

/**
 * Text messages through Twilio (0.9.0-dev.71), in the API: an owner chooses
 * Twilio in Settings → Text messages — the step-up first, its Auth Token
 * sealed as SMS Gate's password is and never answered — and a test must go
 * before any other text, as it must for SMS Gate; switching provider waits
 * for a test of its own. Twilio itself is a fake HTTP server here, spoken
 * to by the vault's own Twilio client: nothing is ever really sent.
 */

const SID = `AC${randomBytes(16).toString('hex')}`;
const OTHER_SID = `AC${randomBytes(16).toString('hex')}`;
const MG = `MG${randomBytes(16).toString('hex')}`;
const TOKEN = `tw-${randomBytes(16).toString('hex')}`;
const FROM = '+447700900999';

describe.skipIf(!testAdminUrl())('text messages through Twilio, in the API', () => {
  let h: Harness;
  let owner: Tokens;
  let adult: Tokens;
  let admin: ReturnType<typeof createPool>;
  let server: Server;
  let base = '';
  let nth = 0;
  /** What the fake Twilio was asked: the form of each send, and each GET. */
  const seen: Array<{ method: string; url: string; auth: string; form: Record<string, string> }> =
    [];
  type Answer = (req: IncomingMessage, res: ServerResponse) => void;
  /**
   * How the fake Twilio answers a send, and a message's status, each in
   * turn; the last again once they run out.
   */
  let sends: Answer[] = [];
  let states: Answer[] = [];
  const next = (list: Answer[]) => (list.length > 1 ? list.shift() : list[0]);
  /** What SMS Gate's fake took, when SMS Gate sends. */
  const gateSent: string[] = [];

  const json = (status: number, body: unknown) => (_: IncomingMessage, res: ServerResponse) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  /** Twilio takes a text. */
  const taken = json(201, { sid: 'SM00000000000000000000000000000001', status: 'queued' });
  /** What Twilio says of a text when asked after it, in turn; its message never read. */
  const statuses = (...said: Array<string | [string, number]>) =>
    said.map((s) =>
      Array.isArray(s)
        ? json(200, { status: s[0], error_code: s[1], error_message: 'about +447700900123' })
        : json(200, { status: s, error_code: null }),
    );

  // The vault's own Twilio client, pointed at the fake; SMS Gate a fake of its own.
  const providers: SmsProviderFactory = (c) =>
    c.provider === 'twilio'
      ? new TwilioProvider(c, { baseUrl: base, timeoutMs: 1000, retryMs: 5 })
      : {
          send: async (to) => {
            gateSent.push(to);
            return { id: `gate-${gateSent.length}`, state: 'delivered' };
          },
          state: async () => ({ state: 'delivered' }),
        };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({
          method: req.method ?? '',
          url: req.url ?? '',
          auth: req.headers.authorization ?? '',
          form: Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))),
        });
        const answer = req.method === 'POST' ? next(sends) : next(states);
        answer?.(req, res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    h = await createHarness({
      rateLimitPerMinute: 100_000,
      smsProvider: providers,
      smsTestWaitMs: 400,
    });
    owner = await h.setup();
    adult = await h.join(owner, {
      name: 'Ahmed Khan',
      email: 'ahmed-twilio@example.test',
      role: 'adult',
    });
    admin = createPool(h.adminUrl, 2);
  }, 60_000);
  afterAll(async () => {
    await admin?.end();
    await h?.close();
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
  });
  beforeEach(async () => {
    await admin.query('delete from sms_message');
    await admin.query('delete from sms_settings');
    seen.length = 0;
    gateSent.length = 0;
    sends = [taken];
    states = statuses('sending', 'delivered');
    await admin.query(
      `update session set verified_at = now(), factor_verified_at = now()
        where account_id = (select account_id from account_household where member_id = $1)
          and revoked_at is null`,
      [owner.member_id],
    );
  });

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
      remoteAddress: `10.79.${++nth >> 8}.${nth & 0xff}`,
    });
  const codeOf = (r: { json: <T>() => T }) =>
    r.json<{ error?: { code: string } }>().error?.code ?? 'ok';

  const TWILIO = {
    provider: 'twilio',
    account_sid: SID,
    auth_token: TOKEN,
    from: FROM,
    messaging_service_sid: null,
    country: 'GB',
    monthly_cap: 200,
  };
  const LOCAL = {
    mode: 'local',
    base_url: 'http://192.168.1.20:8080',
    username: 'sms',
    password: 'gate-password',
    country: 'GB',
    monthly_cap: 200,
  };
  const save = async (body: Record<string, unknown>) => {
    const r = await call(owner, 'PUT', '/api/v1/sms/settings', body);
    expect(r.statusCode, r.body).toBe(200);
    return r.json<SmsSettingsView>();
  };
  const test = async (number = '07700 900123') => {
    const r = await call(owner, 'POST', '/api/v1/sms/settings/test', { number });
    expect(r.statusCode, r.body).toBe(200);
    return r.json<SmsTestResult>();
  };
  const row = async () =>
    (
      await admin.query<{
        provider: string;
        mode: string | null;
        password_encrypted: Buffer | null;
        twilio_token_encrypted: Buffer | null;
        status: string;
      }>(
        `select provider, mode, password_encrypted, twilio_token_encrypted, status
           from sms_settings where household_id = $1`,
        [owner.household_id],
      )
    ).rows[0];

  it('keeps the Auth Token sealed for its account, never answers it, and is an owner’s alone', async () => {
    expect((await call(adult, 'PUT', '/api/v1/sms/settings', TWILIO)).statusCode).toBe(403);
    const v = await save(TWILIO);
    expect(v.settings).toMatchObject({
      provider: 'twilio',
      mode: null,
      base_url: null,
      username: null,
      password: 'not_set',
      twilio: { account_sid: SID, auth_token: 'set', from: FROM, messaging_service_sid: null },
      status: 'untested',
    });
    expect(v.ready).toBe(false);
    expect(JSON.stringify(v)).not.toContain(TOKEN);
    const got = await call(owner, 'GET', '/api/v1/sms/settings');
    expect(got.headers['cache-control']).toBe('no-store');
    expect(got.body).not.toContain(TOKEN);
    const sealed = (await row())?.twilio_token_encrypted as Buffer;
    expect(sealed.includes(Buffer.from(TOKEN))).toBe(false);
    const key = deriveKey(TEST_MASTER, SMS_PASSWORD_PURPOSE);
    expect(openTwilioToken(key, sealed, owner.household_id, { accountSid: SID })).toBe(TOKEN);
    expect(
      openSmsSecret(key, sealed, owner.household_id, { provider: 'twilio', accountSid: SID }),
    ).toBe(TOKEN);
    // Bound to its household and its Account SID.
    expect(() =>
      openTwilioToken(key, sealed, owner.household_id, { accountSid: OTHER_SID }),
    ).toThrow();
    expect(() => openTwilioToken(key, sealed, adult.member_id, { accountSid: SID })).toThrow();
    // The activity log says which provider and what changed: never the token, SID or number.
    const audit = await admin.query<{ detail: unknown }>(
      `select detail from audit_event where action = 'sms.settings_saved' order by id desc limit 1`,
    );
    expect(audit.rows[0]?.detail).toEqual({
      provider: 'twilio',
      sender: 'number',
      token_changed: true,
      account_changed: true,
      sender_changed: true,
      monthly_cap: 200,
    });
    expect(JSON.stringify(audit.rows)).not.toContain(SID);
    expect(JSON.stringify(audit.rows)).not.toContain(TOKEN);
    expect(JSON.stringify(audit.rows)).not.toContain('900999');
  });

  it('asks the owner to confirm it is them before choosing Twilio', async () => {
    await admin.query(
      `update session set verified_at = now() - interval '1 hour', factor_verified_at = now() - interval '1 hour'
        where account_id = (select account_id from account_household where member_id = $1)`,
      [owner.member_id],
    );
    const r = await call(owner, 'PUT', '/api/v1/sms/settings', TWILIO);
    expect([r.statusCode, codeOf(r)]).toEqual([403, 'step_up_required']);
    expect(await row()).toBeUndefined();
  });

  it('takes a From number or a Messaging Service, exactly one, and asks for the token again for another account', async () => {
    const refused = async (over: Record<string, unknown>) => {
      const r = await call(owner, 'PUT', '/api/v1/sms/settings', { ...TWILIO, ...over });
      return [r.statusCode, codeOf(r)];
    };
    const invalid = [422, 'validation_failed'];
    expect(await refused({ account_sid: 'AC123' })).toEqual(invalid);
    expect(await refused({ from: null })).toEqual(invalid);
    expect(await refused({ messaging_service_sid: MG })).toEqual(invalid);
    expect(await refused({ from: '07700 900999' })).toEqual(invalid);
    expect(await refused({ from: null, messaging_service_sid: 'MGnope' })).toEqual(invalid);
    expect(await refused({ auth_token: 'has a space' })).toEqual(invalid);
    expect(await refused({ base_url: 'https://elsewhere.test' })).toEqual(invalid);
    const { auth_token: _, ...noToken } = TWILIO;
    void _;
    expect(await refused({ auth_token: undefined })).toEqual([422, 'sms_password_needed']);
    // A From number typed with spaces is kept as E.164.
    expect((await save({ ...TWILIO, from: '+44 7700 900999' })).settings?.twilio?.from).toBe(FROM);
    // The same account: the token set is kept, through a Messaging Service now.
    const viaService = await save({ ...noToken, from: null, messaging_service_sid: MG });
    expect(viaService.settings?.twilio).toEqual({
      account_sid: SID,
      auth_token: 'set',
      from: null,
      messaging_service_sid: MG,
    });
    // Another account: its own token.
    const r = await call(owner, 'PUT', '/api/v1/sms/settings', {
      ...noToken,
      account_sid: OTHER_SID,
    });
    expect([r.statusCode, codeOf(r)]).toEqual([422, 'sms_password_needed']);
  });

  it('a test Twilio delivers turns texts on, asked after on the message’s own resource', async () => {
    await save(TWILIO);
    states = statuses('queued', 'sending', 'sent');
    const t = await test('07700 900123');
    expect(t).toMatchObject({ ok: true, state: 'sent' });
    expect(t.view.ready).toBe(true);
    expect(t.view.settings?.status).toBe('ok');
    const [send, ...polls] = seen;
    expect(send?.method).toBe('POST');
    expect(send?.url).toBe(`/2010-04-01/Accounts/${SID}/Messages.json`);
    expect(send?.auth).toBe(`Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`);
    expect(send?.form).toEqual({ To: '+447700900123', Body: SMS_TEST_TEXT, From: FROM });
    expect(polls.length).toBeGreaterThan(0);
    for (const p of polls) {
      expect([p.method, p.url]).toEqual([
        'GET',
        `/2010-04-01/Accounts/${SID}/Messages/SM00000000000000000000000000000001.json`,
      ]);
    }
    const rows = await admin.query('select number_tail, kind, provider_id, state from sms_message');
    expect(rows.rows).toEqual([
      {
        number_tail: '123',
        kind: 'test',
        provider_id: 'SM00000000000000000000000000000001',
        state: 'sent',
      },
    ]);
    // Anybody signed in is told texts can be sent.
    expect((await call(adult, 'GET', '/api/v1/sms/status')).json()).toEqual({ ready: true });
  });

  it('a test through a Messaging Service sends with it, and no From', async () => {
    await save({ ...TWILIO, from: null, messaging_service_sid: MG });
    expect((await test()).ok).toBe(true);
    expect(seen[0]?.form).toEqual({
      To: '+447700900123',
      Body: SMS_TEST_TEXT,
      MessagingServiceSid: MG,
    });
  });

  it('a test Twilio fails or leaves undelivered keeps texts off, and says why by its code alone', async () => {
    await save(TWILIO);
    states = statuses('sending', ['undelivered', 30003]);
    let t = await test();
    expect(t).toMatchObject({ ok: false, state: 'failed' });
    expect(t.words).toBe(
      'Twilio couldn’t deliver the text. Twilio error 30003: the phone was switched off or out of reach.',
    );
    expect(t.words).not.toContain('900123');
    expect(t.view.settings).toMatchObject({ status: 'failed', last_error: t.words });
    const failed = await admin.query<{ state: string; error: string }>(
      'select state, error from sms_message',
    );
    expect(failed.rows).toEqual([{ state: 'failed', error: t.words }]);

    states = statuses(['failed', 21610]);
    t = await test();
    expect(t.words).toMatch(/Twilio error 21610: the person replied STOP/);
    expect(t.view.ready).toBe(false);
    // Texts stay off: a code is refused, nothing written.
    const r = await call(adult, 'PUT', `/api/v1/members/${adult.member_id}/phone`, {
      number: '+447700900456',
    });
    expect([r.statusCode, codeOf(r)]).toEqual([409, 'sms_not_set_up']);
  });

  it('a refused Auth Token, and a Twilio that never sends in time, are said in plain words', async () => {
    await save(TWILIO);
    sends = [json(401, { code: 20003, message: 'Authenticate', status: 401 })];
    let t = await test();
    expect(t).toMatchObject({ ok: false, state: 'not_sent' });
    expect(t.words).toMatch(/^Twilio refused the Account SID or Auth Token\./);
    expect(JSON.stringify(t)).not.toContain(TOKEN);

    sends = [taken];
    states = statuses('queued');
    t = await test();
    expect(t).toMatchObject({ ok: false, state: 'pending' });
    expect(t.words).toMatch(/^Twilio took the text, but hadn’t sent it after/);
  });

  it('a 5xx to a send is never sent again: counted as sent, its delivery unknown', async () => {
    await save(TWILIO);
    sends = [json(500, { code: 20500, message: 'Internal Server Error' })];
    // Send a test: one request, not a pass, and words that say it may still arrive.
    const t = await test();
    expect(t).toMatchObject({ ok: false, state: 'pending' });
    expect(t.words).toMatch(/^Twilio didn’t say whether it took the text\. It may still arrive/);
    expect(seen).toHaveLength(1);
    // Tested and on, a code that meets a 5xx is told as sent, so nobody sends it again.
    sends = [taken];
    expect((await test()).ok).toBe(true);
    seen.length = 0;
    await admin.query('delete from sms_message');
    sends = [json(502, {})];
    const r = await call(adult, 'PUT', `/api/v1/members/${adult.member_id}/phone`, {
      number: '+447700900456',
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(seen).toHaveLength(1);
    const rows = await admin.query<{ state: string; provider_id: string | null; error: string }>(
      'select state, provider_id, error from sms_message',
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ state: 'pending', provider_id: null });
    expect(rows.rows[0]?.error).toMatch(/won’t send it again by itself/);
    // Still counted against the month.
    const v = (await call(owner, 'GET', '/api/v1/sms/settings')).json<SmsSettingsView>();
    expect(v.sent_this_month).toBe(1);
  });

  it('Send a test answers within its wait, however slowly Twilio answers', async () => {
    await save(TWILIO);
    // Twilio takes the text, then takes 3 seconds to say how it stands: the
    // test waits 400 ms (the harness's), and asks once, cut short, never again.
    states = [
      (_req, res) => {
        setTimeout(() => json(200, { status: 'delivered' })(_req, res), 3000);
      },
    ];
    const started = Date.now();
    const t = await test();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(t).toMatchObject({ ok: false, state: 'pending' });
    expect(t.words).toMatch(/^Twilio took the text, but hadn’t sent it after/);
    expect(seen.filter((s) => s.method === 'GET')).toHaveLength(1);
  });

  it('a 429 from Twilio is tried again, and the test still goes', async () => {
    await save(TWILIO);
    sends = [json(429, { code: 20429, message: 'Too Many Requests', status: 429 }), taken];
    states = statuses('delivered');
    const t = await test();
    expect(t).toMatchObject({ ok: true, state: 'delivered' });
    expect(seen.filter((s) => s.method === 'POST')).toHaveLength(2);
    expect(await admin.query('select 1 from sms_message')).toMatchObject({ rowCount: 1 });
  });

  it('switching provider forgets the other’s settings and secret, and waits for a test of its own', async () => {
    // SMS Gate, tested and on.
    await save(LOCAL);
    expect((await test()).ok).toBe(true);
    expect(gateSent).toHaveLength(1);
    // Twilio chosen: SMS Gate's settings and password go, and nothing is sent until a test.
    let v = await save(TWILIO);
    expect(v.ready).toBe(false);
    expect(v.settings?.status).toBe('untested');
    expect(await row()).toMatchObject({
      provider: 'twilio',
      mode: null,
      password_encrypted: null,
      status: 'untested',
    });
    let r = await call(adult, 'PUT', `/api/v1/members/${adult.member_id}/phone`, {
      number: '+447700900456',
    });
    expect([r.statusCode, codeOf(r)]).toEqual([409, 'sms_not_set_up']);
    expect(seen).toHaveLength(0);
    expect((await test()).ok).toBe(true);
    // Now a code goes through Twilio, not SMS Gate.
    seen.length = 0;
    r = await call(adult, 'PUT', `/api/v1/members/${adult.member_id}/phone`, {
      number: '+447700900456',
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(seen[0]?.form.To).toBe('+447700900456');
    expect(gateSent).toHaveLength(1);
    // A new limit alone keeps the test that passed.
    const { auth_token: _, ...noToken } = TWILIO;
    void _;
    v = await save({ ...noToken, monthly_cap: 150 });
    expect([v.ready, v.settings?.status]).toEqual([true, 'ok']);
    // A new sender does not.
    v = await save({ ...noToken, from: null, messaging_service_sid: MG });
    expect([v.ready, v.settings?.status]).toEqual([false, 'untested']);
    // Back to SMS Gate: its password is typed again, and Twilio's token goes.
    const { password: __, ...noPassword } = LOCAL;
    void __;
    r = await call(owner, 'PUT', '/api/v1/sms/settings', noPassword);
    expect([r.statusCode, codeOf(r)]).toEqual([422, 'sms_password_needed']);
    v = await save(LOCAL);
    expect(v.settings).toMatchObject({ provider: 'sms_gate', twilio: null, status: 'untested' });
    expect(await row()).toMatchObject({ provider: 'sms_gate', twilio_token_encrypted: null });
    // Turned off: Twilio's settings are gone with the rest.
    await save(TWILIO);
    expect((await call(owner, 'DELETE', '/api/v1/sms/settings')).statusCode).toBe(200);
    expect(await row()).toBeUndefined();
  });

  it('the database waits for a test after a new sender or token, whoever writes it', async () => {
    await save(TWILIO);
    expect((await test()).ok).toBe(true);
    const app = createPool(h.appUrl, 1);
    const c = await app.connect();
    try {
      await c.query('begin');
      const acct = await admin.query<{ account_id: string }>(
        'select account_id from account_household where member_id = $1',
        [owner.member_id],
      );
      await c.query(
        `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                set_config('app.account_id', $2, true), set_config('app.member_id', $3, true),
                set_config('app.role', 'owner', true)`,
        [owner.household_id, acct.rows[0]?.account_id, owner.member_id],
      );
      for (const change of [
        `twilio_messaging_service_sid = '${MG}', twilio_from = null`,
        `twilio_token_encrypted = '\\x${'00'.repeat(40)}'::bytea`,
        `provider = 'sms_gate', mode = 'local', base_url = 'http://192.168.1.20:8080', username = 'sms'`,
      ]) {
        await c.query('savepoint s');
        await expect(
          c.query(`update sms_settings set ${change}, updated_by = $1`, [acct.rows[0]?.account_id]),
          change,
        ).rejects.toMatchObject({ code: '42501' });
        await c.query('rollback to savepoint s');
      }
    } finally {
      await c.query('rollback');
      c.release();
      await app.end();
    }
  });

  it('the month’s cap, and link texts’ share of it, hold for Twilio as for SMS Gate', async () => {
    await save({ ...TWILIO, monthly_cap: 4 });
    expect((await test()).ok).toBe(true);
    const way: SmsWay = {
      open: (sealed, household, to) =>
        openSmsSecret(deriveKey(TEST_MASTER, SMS_PASSWORD_PURPOSE), sealed, household, to),
      provider: providers,
    };
    const asVault = <T>(fn: (trx: typeof h.db) => Promise<T>) =>
      withSystem(h.db, owner.household_id, fn);
    const send = (kind: 'share_link' | 'alert') =>
      sendSms(asVault, way, owner.household_id, {
        to: '+447700900456',
        kind,
        text: 'Family Vault: hello.',
      });
    states = statuses('delivered');
    // Link texts take half the cap at most: 2 of 4.
    const share = Math.floor(4 * LINK_TEXTS_CAP_SHARE);
    for (let i = 0; i < share; i += 1) expect(await send('share_link')).toHaveProperty('sent');
    expect(await send('share_link')).toEqual({ refused: 'cap_reached', cap: share, links: true });
    // The rest are kept for the codes and alerts: one left (the test was one).
    expect(await send('alert')).toHaveProperty('sent');
    expect(await send('alert')).toEqual({ refused: 'cap_reached', cap: 4 });
    expect(seen.filter((s) => s.method === 'POST')).toHaveLength(1 + share + 1);
    const v = (await call(owner, 'GET', '/api/v1/sms/settings')).json<SmsSettingsView>();
    expect([v.sent_this_month, v.monthly_cap]).toEqual([4, 4]);
  });

  it('a text Twilio would not take is logged as not sent, in words with no number or token', async () => {
    await save(TWILIO);
    expect((await test()).ok).toBe(true);
    sends = [
      json(400, {
        code: 21211,
        message: "The 'To' number +447700900456 is not a valid phone number.",
        status: 400,
      }),
    ];
    const r = await call(adult, 'PUT', `/api/v1/members/${adult.member_id}/phone`, {
      number: '+447700900456',
    });
    expect([r.statusCode, codeOf(r)]).toEqual([503, 'sms_not_sent']);
    expect(r.body).toMatch(/Twilio error 21211: the number isn’t a valid phone number/);
    expect(r.body).not.toContain('+447700900456');
    const kept = await admin.query<{ state: string; error: string; number_tail: string }>(
      `select state, error, number_tail from sms_message where kind <> 'test'`,
    );
    expect(kept.rows).toHaveLength(1);
    expect(kept.rows[0]).toMatchObject({ state: 'not_sent', number_tail: '456' });
    expect(kept.rows[0]?.error).not.toMatch(/7700|tw-/);
  });

  it('what reaches the provider is the household’s own connection, its token opened', async () => {
    const got: SmsConnection[] = [];
    const watching: SmsProviderFactory = (c) => {
      got.push(c);
      return {
        send: async () => {
          throw new SmsProviderError('timeout', 'no answer');
        },
        state: async () => ({ state: 'pending' }),
      };
    };
    await save(TWILIO);
    const way: SmsWay = {
      open: (sealed, household, to) =>
        openSmsSecret(deriveKey(TEST_MASTER, SMS_PASSWORD_PURPOSE), sealed, household, to),
      provider: watching,
    };
    const out = await sendSms(
      (fn) => withSystem(h.db, owner.household_id, fn),
      way,
      owner.household_id,
      { to: '+447700900123', kind: 'test', text: SMS_TEST_TEXT },
    );
    expect(got).toEqual([
      {
        provider: 'twilio',
        accountSid: SID,
        authToken: TOKEN,
        from: FROM,
        messagingServiceSid: null,
      },
    ]);
    expect(out).toHaveProperty('problem');
  });
});
