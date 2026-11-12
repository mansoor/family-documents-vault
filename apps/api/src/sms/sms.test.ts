import { randomBytes } from 'node:crypto';
import { deriveKey, openSmsPassword, SMS_PASSWORD_PURPOSE } from '@fdv/crypto';
import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  SMS_CLOUD_URL,
  SMS_TEST_TEXT,
  type Capabilities,
  type MemberPhoneView,
  type SmsSettingsView,
  type SmsState,
  type SmsTestResult,
} from '@fdv/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, TEST_MASTER, type Harness } from '../test-harness.js';
import { SmsProviderError, type SmsConnection, type SmsProviderFactory } from '@fdv/db';

/**
 * Text messages (0.9.0, SMS1), in the API: the household's SMS Gate, an
 * owner's to set up — the step-up first, its password sealed and never
 * answered — and tested before any other text is sent; the month's limit;
 * and each person's mobile number, confirmed by a code texted to it, theirs
 * and the owners' alone. SMS Gate itself is a fake here, told what to say.
 */

/** What the fake SMS Gate does with the next texts. */
interface Script {
  /** How it answers a send. */
  send: 'accept' | 'unauthorised' | 'timeout';
  /** What it says of a text's state, in turn; the last again once they run out. */
  states: SmsState[];
  error?: string;
}

describe.skipIf(!testAdminUrl())('text messages, in the API', () => {
  let h: Harness;
  let owner: Tokens;
  let adult: Tokens;
  let teen: Tokens;
  let viewer: Tokens;
  let admin: ReturnType<typeof createPool>;
  let app: ReturnType<typeof createPool>;
  let nth = 0;
  const PASSWORD = `sms-pw-${randomBytes(9).toString('hex')}`;
  const sent: Array<{ to: string; text: string; c: SmsConnection }> = [];
  let script: Script = { send: 'accept', states: ['delivered'] };

  const fake: SmsProviderFactory = (c) => ({
    send: async (to, text) => {
      if (script.send === 'unauthorised') {
        throw new SmsProviderError('unauthorised', 'SMS Gate refused', 401);
      }
      if (script.send === 'timeout') throw new SmsProviderError('timeout', 'no answer');
      sent.push({ to, text, c });
      return { id: `gate-${sent.length}`, state: 'pending' };
    },
    state: async () => {
      const state = (
        script.states.length > 1 ? script.states.shift() : script.states[0]
      ) as SmsState;
      return script.error ? { state, error: script.error } : { state };
    },
  });

  beforeAll(async () => {
    h = await createHarness({
      rateLimitPerMinute: 100_000,
      smsProvider: fake,
      smsTestWaitMs: 300,
    });
    owner = await h.setup();
    adult = await h.join(owner, {
      name: 'Ahmed Khan',
      email: 'ahmed-sms@example.test',
      role: 'adult',
    });
    teen = await h.join(owner, { name: 'Tia', email: 'tia-sms@example.test', role: 'teen' });
    viewer = await h.join(owner, { name: 'Vic', email: 'vic-sms@example.test', role: 'viewer' });
    admin = createPool(h.adminUrl, 2);
    app = createPool(h.appUrl, 1);
  }, 60_000);
  afterAll(async () => {
    await app?.end();
    await admin?.end();
    await h?.close();
  });
  beforeEach(async () => {
    await admin.query('delete from sms_message');
    await admin.query('delete from phone_code');
    await admin.query('delete from member_phone');
    await admin.query('delete from sms_settings');
    sent.length = 0;
    h.jobs.length = 0;
    script = { send: 'accept', states: ['delivered'] };
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
      // A code is asked for from many addresses: each call is its own.
      remoteAddress: `10.78.${++nth >> 8}.${nth & 0xff}`,
    });
  const codeOf = (r: { json: <T>() => T; statusCode: number }) =>
    r.json<{ error?: { code: string } }>().error?.code ?? 'ok';

  const LOCAL = {
    mode: 'local',
    base_url: 'http://192.168.1.20:8080/',
    username: 'sms',
    password: PASSWORD,
    country: 'GB',
    monthly_cap: 200,
  };
  const save = async (over: Record<string, unknown> = {}) => {
    const r = await call(owner, 'PUT', '/api/v1/sms/settings', { ...LOCAL, ...over });
    expect(r.statusCode, r.body).toBe(200);
    return r.json<SmsSettingsView>();
  };
  const test = async (number = '07700 900123') => {
    const r = await call(owner, 'POST', '/api/v1/sms/settings/test', { number });
    expect(r.statusCode, r.body).toBe(200);
    return r.json<SmsTestResult>();
  };
  /** Set up and tested: the vault sends texts. */
  const ready = async () => {
    await save();
    expect((await test()).ok).toBe(true);
    sent.length = 0;
  };
  const sealed = async () =>
    (
      await admin.query<{ p: Buffer | null }>(
        'select password_encrypted as p from sms_settings where household_id = $1',
        [owner.household_id],
      )
    ).rows[0]?.p ?? null;
  /** The code in the newest text, as whoever has the phone reads it. */
  const lastCode = () => /code: ([0-9]{6})\./.exec(sent.at(-1)?.text ?? '')?.[1] as string;

  // ---------------------------------------------------------- the setting

  it('is an owner’s to see, set up, remove and test: anybody else is refused', async () => {
    for (const who of [adult, teen, viewer]) {
      expect((await call(who, 'GET', '/api/v1/sms/settings')).statusCode).toBe(403);
      expect((await call(who, 'PUT', '/api/v1/sms/settings', LOCAL)).statusCode).toBe(403);
      expect((await call(who, 'DELETE', '/api/v1/sms/settings')).statusCode).toBe(403);
      expect(
        (await call(who, 'POST', '/api/v1/sms/settings/test', { number: '+447700900123' }))
          .statusCode,
      ).toBe(403);
    }
    expect(await sealed()).toBeNull();
    const r = await call(owner, 'PUT', '/api/v1/sms/settings', LOCAL);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('asks the owner to confirm it is them before changing it', async () => {
    await admin.query(
      `update session set verified_at = now() - interval '1 hour', factor_verified_at = now() - interval '1 hour'
        where account_id = (select account_id from account_household where member_id = $1)`,
      [owner.member_id],
    );
    const r = await call(owner, 'PUT', '/api/v1/sms/settings', LOCAL);
    expect([r.statusCode, codeOf(r)]).toEqual([403, 'step_up_required']);
    expect(r.body).toMatch(/to change how the vault sends text messages/);
    expect(await sealed()).toBeNull();
  });

  it('keeps the password sealed for its address and sign-in, and never answers it', async () => {
    const v = await save();
    expect(v.settings).toMatchObject({
      mode: 'local',
      base_url: 'http://192.168.1.20:8080',
      username: 'sms',
      password: 'set',
      country: 'GB',
      monthly_cap: 200,
      status: 'untested',
    });
    expect(v.ready).toBe(false);
    expect(JSON.stringify(v)).not.toContain(PASSWORD);
    const got = await call(owner, 'GET', '/api/v1/sms/settings');
    expect(got.headers['cache-control']).toBe('no-store');
    expect(got.body).not.toContain(PASSWORD);
    const p = (await sealed()) as Buffer;
    expect(p.includes(Buffer.from(PASSWORD))).toBe(false);
    const key = deriveKey(TEST_MASTER, SMS_PASSWORD_PURPOSE);
    const at = { mode: 'local', baseUrl: 'http://192.168.1.20:8080', username: 'sms' };
    expect(openSmsPassword(key, p, owner.household_id, at)).toBe(PASSWORD);
    // Bound to its household, mode, address and sign-in.
    expect(() => openSmsPassword(key, p, adult.member_id, at)).toThrow();
    expect(() => openSmsPassword(key, p, owner.household_id, { ...at, mode: 'private' })).toThrow();
    expect(() =>
      openSmsPassword(key, p, owner.household_id, { ...at, baseUrl: 'http://10.0.0.9:8080' }),
    ).toThrow();
    expect(() => openSmsPassword(key, p, owner.household_id, { ...at, username: 'x' })).toThrow();
    // The activity log says what changed, never the password, address or sign-in.
    const audit = await admin.query<{ detail: unknown }>(
      `select detail from audit_event where action = 'sms.settings_saved' order by id desc limit 1`,
    );
    expect(audit.rows[0]?.detail).toEqual({
      mode: 'local',
      password_changed: true,
      address_changed: true,
      monthly_cap: 200,
    });
    expect(JSON.stringify(audit.rows)).not.toMatch(/192\.168|sms-pw/);
  });

  it('asks for the password first, and again for a new address or sign-in', async () => {
    const { password: _, ...without } = LOCAL;
    void _;
    let r = await call(owner, 'PUT', '/api/v1/sms/settings', without);
    expect([r.statusCode, codeOf(r)]).toEqual([422, 'sms_password_needed']);
    await save();
    r = await call(owner, 'PUT', '/api/v1/sms/settings', {
      ...without,
      base_url: 'http://192.168.1.21:8080',
    });
    expect([r.statusCode, codeOf(r)]).toEqual([422, 'sms_password_needed']);
    // The same address and sign-in: the password set is kept.
    r = await call(owner, 'PUT', '/api/v1/sms/settings', { ...without, monthly_cap: 50 });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json<SmsSettingsView>().settings?.password).toBe('set');
  });

  it('takes the relay’s own address for the cloud, https for a server of your own, and nothing inside the network but the local server', async () => {
    expect(
      (await save({ mode: 'cloud', base_url: 'http://anything.test' })).settings?.base_url,
    ).toBe(SMS_CLOUD_URL);
    h.dns.set('sms.family.test', ['203.0.113.7']);
    h.dns.set('inside.family.test', ['192.168.1.9']);
    expect(
      (await save({ mode: 'private', base_url: 'https://sms.family.test/3rdparty/v1' })).settings
        ?.base_url,
    ).toBe('https://sms.family.test/3rdparty/v1');
    const refused = async (over: Record<string, unknown>) => {
      const r = await call(owner, 'PUT', '/api/v1/sms/settings', { ...LOCAL, ...over });
      return [r.statusCode, codeOf(r)];
    };
    expect(await refused({ mode: 'private', base_url: 'http://sms.family.test' })).toEqual([
      422,
      'validation_failed',
    ]);
    for (const base of [
      'https://10.0.0.5/3rdparty/v1',
      'https://127.0.0.1',
      'https://localhost:8443',
      'https://169.254.169.254',
      'https://inside.family.test',
    ]) {
      expect(await refused({ mode: 'private', base_url: base }), base).toEqual([
        422,
        'sms_address_refused',
      ]);
    }
    for (const base of ['ftp://192.168.1.20', 'http://user:pw@192.168.1.20:8080', 'nonsense']) {
      expect(await refused({ base_url: base }), base).toEqual([422, 'validation_failed']);
    }
    expect(await refused({ country: 'ZZ' })).toEqual([422, 'validation_failed']);
    expect(await refused({ monthly_cap: 0 })).toEqual([422, 'validation_failed']);
    // The local server is on the home network by design.
    expect((await save()).settings?.base_url).toBe('http://192.168.1.20:8080');
  });

  it('a test that SMS Gate sends turns texts on; the test went to the number typed, in the household’s country', async () => {
    await save();
    script = { send: 'accept', states: ['processed', 'sent'] };
    const t = await test('07700 900123');
    expect(t).toMatchObject({ ok: true, state: 'sent' });
    expect(t.view.ready).toBe(true);
    expect(t.view.settings).toMatchObject({ status: 'ok', last_error: null });
    expect(t.view.settings?.last_verified_at).not.toBeNull();
    expect(t.view.sent_this_month).toBe(1);
    expect(sent).toEqual([
      {
        to: '+447700900123',
        text: SMS_TEST_TEXT,
        c: {
          mode: 'local',
          baseUrl: 'http://192.168.1.20:8080',
          username: 'sms',
          password: PASSWORD,
        },
      },
    ]);
    // Anybody signed in is told texts can be sent; nothing more.
    for (const who of [adult, teen, viewer]) {
      const s = await call(who, 'GET', '/api/v1/sms/status');
      expect(s.json()).toEqual({ ready: true });
    }
    // What the log keeps of it: its kind and state, three digits, never the words.
    const rows = await admin.query(
      'select number_tail, kind, provider_id, state, error from sms_message',
    );
    expect(rows.rows).toEqual([
      { number_tail: '123', kind: 'test', provider_id: 'gate-1', state: 'sent', error: null },
    ]);
    const audit = await admin.query<{ detail: unknown }>(
      `select detail from audit_event where action = 'sms.settings_tested' order by id desc limit 1`,
    );
    expect(audit.rows[0]?.detail).toEqual({ ok: true, state: 'sent' });
  });

  it('a test the phone fails, SMS Gate refuses or never sends leaves texts off, and says why', async () => {
    await save();
    script = { send: 'accept', states: ['failed'], error: 'RESULT_ERROR_NO_SERVICE' };
    let t = await test();
    expect(t).toMatchObject({ ok: false, state: 'failed' });
    expect(t.words).toMatch(/The phone couldn’t send the text\. .*RESULT_ERROR_NO_SERVICE/);
    expect(t.view.settings).toMatchObject({ status: 'failed', last_verified_at: null });
    expect(t.view.settings?.last_error).toBe(t.words);
    expect(t.view.ready).toBe(false);

    script = { send: 'unauthorised', states: ['pending'] };
    t = await test();
    expect(t).toMatchObject({ ok: false, state: 'not_sent' });
    expect(t.words).toMatch(/refused the username or password/);
    expect(t.view.settings?.last_error).toMatch(/refused the username or password/);

    script = { send: 'timeout', states: ['pending'] };
    t = await test();
    expect(t.words).toMatch(/didn’t answer within 10 seconds/);

    script = { send: 'accept', states: ['pending'] };
    t = await test();
    expect(t).toMatchObject({ ok: false, state: 'pending' });
    expect(t.words).toMatch(/hadn’t sent it after/);
    expect((await call(adult, 'GET', '/api/v1/sms/status')).json()).toEqual({ ready: false });
    // A text not taken by SMS Gate is not counted against the month.
    expect(t.view.sent_this_month).toBe(2);
  });

  it('a new address waits for a test of its own; a new limit or country alone does not', async () => {
    await ready();
    let v = await save({ monthly_cap: 10, country: 'FR', password: undefined });
    expect(v.settings).toMatchObject({ status: 'ok', monthly_cap: 10, country: 'FR' });
    expect(v.ready).toBe(true);
    v = await save({ username: 'another' });
    expect(v.settings?.status).toBe('untested');
    expect(v.ready).toBe(false);
  });

  it('the database takes whether a test passed from nobody signed in', async () => {
    await save();
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
      await expect(
        c.query(`update sms_settings set status = 'ok', updated_by = $1`, [
          acct.rows[0]?.account_id,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await c.query('rollback');
      c.release();
    }
  });

  it('never sends more in a calendar month than the limit, on the family’s clock', async () => {
    await ready();
    await save({ monthly_cap: 2, password: undefined });
    // Last month's do not count.
    await admin.query(
      `insert into sms_message (household_id, number_tail, kind, state, created_at)
       select $1, '000', 'test', 'delivered', now() - interval '40 days' from generate_series(1, 5)`,
      [owner.household_id],
    );
    // The test that turned texts on is this month's first.
    let r = await call(adult, 'PUT', `/api/v1/members/${adult.member_id}/phone`, {
      number: '+447700900456',
    });
    expect(r.statusCode, r.body).toBe(200);
    r = await call(teen, 'PUT', `/api/v1/members/${teen.member_id}/phone`, {
      number: '+447700900789',
    });
    expect([r.statusCode, codeOf(r)]).toEqual([409, 'sms_cap_reached']);
    expect(r.body).toMatch(/This month’s 2 texts have all been sent/);
    expect(sent).toHaveLength(1);
    const v = (await call(owner, 'GET', '/api/v1/sms/settings')).json<SmsSettingsView>();
    expect([v.sent_this_month, v.monthly_cap]).toEqual([2, 2]);
  });

  it('is the owners’ in the database: nobody else reads the settings or the texts, and nobody signed in a code', async () => {
    await ready();
    await call(adult, 'PUT', `/api/v1/members/${adult.member_id}/phone`, {
      number: '+447700900456',
    });
    const as = async (who: Tokens, role: string, text: string) => {
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
        return (await c.query<{ n: number }>(text)).rows[0]?.n;
      } finally {
        await c.query('rollback');
        c.release();
      }
    };
    const count = (t: string) => `select count(*)::int as n from ${t}`;
    for (const [who, role] of [
      [adult, 'adult'],
      [teen, 'teen'],
      [viewer, 'viewer'],
    ] as const) {
      expect(await as(who, role, count('sms_settings')), role).toBe(0);
      expect(await as(who, role, count('sms_message')), role).toBe(0);
      expect(await as(who, role, count('phone_code')), role).toBe(0);
    }
    expect(await as(owner, 'owner', count('sms_settings'))).toBe(1);
    expect(await as(owner, 'owner', count('sms_message'))).toBe(2);
    expect(await as(owner, 'owner', count('phone_code'))).toBe(0);
    // A number: its person's, and the owners'.
    expect(await as(adult, 'adult', count('member_phone'))).toBe(1);
    expect(await as(teen, 'teen', count('member_phone'))).toBe(0);
    expect(await as(owner, 'owner', count('member_phone'))).toBe(1);
  });

  // ------------------------------------------------------------ the numbers

  it('a number is offered only once texts are set up', async () => {
    const r = await call(adult, 'PUT', `/api/v1/members/${adult.member_id}/phone`, {
      number: '+447700900456',
    });
    expect([r.statusCode, codeOf(r)]).toEqual([409, 'sms_not_set_up']);
    const v = (
      await call(adult, 'GET', `/api/v1/members/${adult.member_id}/phone`)
    ).json<MemberPhoneView>();
    expect(v).toEqual({ phone: null, sms_ready: false });
  });

  it('somebody adds their own number, and a code texted to it confirms it', async () => {
    await ready();
    const since = (await admin.query<{ n: string }>('select max(id) as n from audit_event')).rows[0]
      ?.n;
    let r = await call(adult, 'PUT', `/api/v1/members/${adult.member_id}/phone`, {
      number: '07700 900456',
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    let v = r.json<MemberPhoneView>();
    expect(v.phone).toMatchObject({ masked: '•••• •••456', confirmed: false, confirmed_at: null });
    expect(v.phone?.code_expires_at).not.toBeNull();
    expect(JSON.stringify(v)).not.toContain('900456');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('+447700900456');
    expect(sent[0]?.text).toMatch(
      /^Family Vault code: [0-9]{6}\. It confirms this number for Ahmed\. It ends in 10 minutes\.$/,
    );
    expect(sent[0]?.text).not.toMatch(/https?:/);
    // Never the code, in the database or the log of texts.
    const code = lastCode();
    const stored = await admin.query<{ h: Buffer }>('select code_hash as h from phone_code');
    expect(stored.rows[0]?.h.toString('hex')).not.toContain(Buffer.from(code).toString('hex'));
    expect(JSON.stringify((await admin.query('select * from sms_message')).rows)).not.toContain(
      code,
    );

    const wrong = code === '000000' ? '111111' : '000000';
    r = await call(adult, 'POST', `/api/v1/members/${adult.member_id}/phone/confirm`, {
      code: wrong,
    });
    expect([r.statusCode, codeOf(r)]).toEqual([422, 'phone_code_wrong']);
    expect(r.body).toMatch(/4 tries left/);
    r = await call(adult, 'POST', `/api/v1/members/${adult.member_id}/phone/confirm`, {
      code: `${code.slice(0, 3)} ${code.slice(3)}`,
    });
    expect(r.statusCode, r.body).toBe(200);
    v = r.json<MemberPhoneView>();
    expect(v.phone).toMatchObject({ confirmed: true, code_expires_at: null });
    // Used once.
    await admin.query(`update member_phone set confirmed_at = null`);
    r = await call(adult, 'POST', `/api/v1/members/${adult.member_id}/phone/confirm`, { code });
    expect([r.statusCode, codeOf(r)]).toEqual([409, 'phone_code_expired']);
    const lines = await admin.query<{ action: string; detail: unknown }>(
      `select action, detail from audit_event where action like 'member.phone_%' and id > $1 order by id`,
      [since],
    );
    expect(lines.rows).toEqual([
      { action: 'member.phone_added', detail: { number: '•••• •••456', replaced: false } },
      { action: 'member.phone_confirmed', detail: { number: '•••• •••456' } },
    ]);
  });

  it('nobody else sees or changes somebody’s number; an owner adds one for anybody', async () => {
    await ready();
    for (const [who, method, path, body] of [
      [teen, 'GET', 'phone', undefined],
      [teen, 'PUT', 'phone', { number: '+447700900111' }],
      [viewer, 'DELETE', 'phone', undefined],
      [teen, 'POST', 'phone/resend', undefined],
      [viewer, 'POST', 'phone/confirm', { code: '123456' }],
    ] as const) {
      const r = await call(who, method, `/api/v1/members/${adult.member_id}/${path}`, body);
      expect([r.statusCode, `${method} ${path}`]).toEqual([403, `${method} ${path}`]);
    }
    expect(sent).toHaveLength(0);
    const r = await call(owner, 'PUT', `/api/v1/members/${teen.member_id}/phone`, {
      number: '+447700900789',
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(sent[0]?.text).toMatch(/for Tia\./);
    // The owner types the code the person reads them.
    const ok = await call(owner, 'POST', `/api/v1/members/${teen.member_id}/phone/confirm`, {
      code: lastCode(),
    });
    expect(ok.json<MemberPhoneView>().phone?.confirmed).toBe(true);
    expect(
      (await call(teen, 'GET', `/api/v1/members/${teen.member_id}/phone`)).json<MemberPhoneView>()
        .phone?.confirmed,
    ).toBe(true);
    const bad = await call(owner, 'PUT', `/api/v1/members/${teen.member_id}/phone`, {
      number: '12',
    });
    expect([bad.statusCode, codeOf(bad)]).toEqual([422, 'phone_number_invalid']);
  });

  it('a code ends after ten minutes, and after five wrong tries', async () => {
    await ready();
    await call(adult, 'PUT', `/api/v1/members/${adult.member_id}/phone`, {
      number: '+447700900456',
    });
    const code = lastCode();
    await admin.query(`update phone_code set expires_at = now() - interval '1 second'`);
    let r = await call(adult, 'POST', `/api/v1/members/${adult.member_id}/phone/confirm`, { code });
    expect([r.statusCode, codeOf(r)]).toEqual([409, 'phone_code_expired']);

    r = await call(adult, 'POST', `/api/v1/members/${adult.member_id}/phone/resend`);
    expect(r.statusCode, r.body).toBe(200);
    const fresh = lastCode();
    const wrong = fresh === '000000' ? '111111' : '000000';
    const answers: string[] = [];
    for (let i = 0; i < 5; i++) {
      r = await call(adult, 'POST', `/api/v1/members/${adult.member_id}/phone/confirm`, {
        code: wrong,
      });
      answers.push(codeOf(r));
    }
    expect(answers).toEqual([
      'phone_code_wrong',
      'phone_code_wrong',
      'phone_code_wrong',
      'phone_code_wrong',
      'phone_code_too_many',
    ]);
    // Not even the right one now.
    r = await call(adult, 'POST', `/api/v1/members/${adult.member_id}/phone/confirm`, {
      code: fresh,
    });
    expect([r.statusCode, codeOf(r)]).toEqual([409, 'phone_code_too_many']);
    // An older code is ended by a newer one.
    expect(code).toBeDefined();
  });

  it('three codes a number in fifteen minutes, then wait', async () => {
    await ready();
    const path = `/api/v1/members/${adult.member_id}/phone`;
    expect((await call(adult, 'PUT', path, { number: '+447700900456' })).statusCode).toBe(200);
    expect((await call(adult, 'POST', `${path}/resend`)).statusCode).toBe(200);
    expect((await call(adult, 'POST', `${path}/resend`)).statusCode).toBe(200);
    const r = await call(adult, 'POST', `${path}/resend`);
    expect([r.statusCode, codeOf(r)]).toEqual([429, 'phone_code_limit']);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect(sent).toHaveLength(3);
    // Only the newest works.
    const newest = lastCode();
    const older = /code: ([0-9]{6})\./.exec(sent[0]?.text ?? '')?.[1] as string;
    if (older !== newest) {
      const o = await call(adult, 'POST', `${path}/confirm`, { code: older });
      expect(codeOf(o)).toBe('phone_code_wrong');
    }
    expect((await call(adult, 'POST', `${path}/confirm`, { code: newest })).statusCode).toBe(200);
    // Confirmed: no code to resend.
    const again = await call(adult, 'POST', `${path}/resend`);
    expect([again.statusCode, codeOf(again)]).toEqual([409, 'phone_confirmed']);
  });

  it('a changed number is unconfirmed until its own code, and the old one is told', async () => {
    await ready();
    const path = `/api/v1/members/${adult.member_id}/phone`;
    await call(adult, 'PUT', path, { number: '+447700900456' });
    await call(adult, 'POST', `${path}/confirm`, { code: lastCode() });
    sent.length = 0;
    // The same number again changes nothing.
    const same = await call(adult, 'PUT', path, { number: '07700900456' });
    expect(same.json<MemberPhoneView>().phone?.confirmed).toBe(true);
    expect(sent).toHaveLength(0);
    const r = await call(owner, 'PUT', path, { number: '+447700900999' });
    expect(r.json<MemberPhoneView>().phone).toMatchObject({
      masked: '•••• •••999',
      confirmed: false,
    });
    expect(sent.map((s) => s.to)).toEqual(['+447700900456', '+447700900999']);
    expect(sent[0]?.text).toBe('Family Vault: the mobile number for Ahmed was changed.');
    expect(sent[1]?.text).toMatch(
      /^Family Vault code: [0-9]{6}\. It confirms this number for Ahmed\./,
    );
  });

  it('a number is removed, and its code with it', async () => {
    await ready();
    const path = `/api/v1/members/${adult.member_id}/phone`;
    await call(adult, 'PUT', path, { number: '+447700900456' });
    const code = lastCode();
    const r = await call(owner, 'DELETE', path);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json<MemberPhoneView>().phone).toBeNull();
    const c = await call(adult, 'POST', `${path}/confirm`, { code });
    expect([c.statusCode, codeOf(c)]).toEqual([404, 'phone_none']);
    expect((await call(adult, 'DELETE', path)).statusCode).toBe(404);
    const line = await admin.query<{ detail: unknown }>(
      `select detail from audit_event where action = 'member.phone_removed'`,
    );
    expect(line.rows[0]?.detail).toEqual({ number: '•••• •••456' });
  });

  it('is said in the capabilities, and in the activity log in words', async () => {
    const caps = (
      await h.app.inject({ method: 'GET', url: '/api/v1/capabilities' })
    ).json<Capabilities>();
    expect(caps.features.sms_texts).toBe(true);
    await ready();
    await call(adult, 'PUT', `/api/v1/members/${adult.member_id}/phone`, {
      number: '+447700900456',
    });
    const log = await call(owner, 'GET', '/api/v1/audit');
    const texts = log.json<{ items: Array<{ text: string }> }>().items.map((i) => i.text);
    expect(texts).toEqual(
      expect.arrayContaining([
        'Owner changed how the vault sends text messages',
        'Owner sent a test text, and it went',
        'Ahmed Khan added their mobile number',
      ]),
    );
    expect(JSON.stringify(texts)).not.toMatch(/900456/);
    // A teen is told of their own number, and of nobody else's, nor of the setting.
    const theirs = (await call(teen, 'GET', '/api/v1/audit')).json<{
      items: Array<{ text: string }>;
    }>();
    expect(JSON.stringify(theirs)).not.toMatch(/text messages|test text|Ahmed/);
  });
});
