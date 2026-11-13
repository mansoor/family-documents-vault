import { AI_READER_KEY_PURPOSE, deriveKey, openAiReaderKey } from '@fdv/crypto';
import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type {
  AiReaderView,
  Capabilities,
  LocalAiNotice,
  LocalAiSettingsView,
  SettingsCheckView,
} from '@fdv/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { alertsSent, createHarness, TEST_MASTER, type Harness } from '../test-harness.js';

/**
 * The AI reader set in Settings → Reading → AI reader (0.9.0, AIR1): an
 * owner's, with step-up; Ollama alone until AIR3; the address guarded as
 * decision 9 says; the key sealed and never answered; a Test that must pass
 * before it is used, which only the vault says passed; .env's reader wins,
 * and FDV_AI_READER_SETTINGS=off takes it out of Settings.
 */

const KEY = 'sk-test-abcd-1234-WXYZ';
const URL_OK = 'http://192.168.1.30:11434';

const DNS: Record<string, string[]> = {
  'reader.example.com': ['203.0.113.10'],
  'nas.example.com': ['192.168.1.40'],
  'metadata.example.com': ['169.254.169.254'],
  'mixed.example.com': ['192.168.1.40', '203.0.113.10'],
  // The vault's own worker, as the compose file names it (the review, S2c).
  worker: ['172.18.0.4'],
};
const aiResolve = async (host: string) => {
  const got = DNS[host];
  if (!got) throw new Error('not found');
  return got;
};

const codeOf = (r: { json: <T>() => T }) =>
  r.json<{ error?: { code: string } }>().error?.code ?? 'ok';

describe.skipIf(!testAdminUrl())('the AI reader set in Settings (AIR1)', () => {
  let h: Harness;
  let owner: Tokens;
  let adult: Tokens;
  let admin: ReturnType<typeof createPool>;
  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000, aiResolve });
    owner = await h.setup();
    // A second owner, told by email when the reader changes.
    await h.join(owner, { name: 'Omar', email: 'omar-air1@example.test', role: 'owner' });
    adult = await h.join(owner, { name: 'Ada', email: 'ada-air1@example.test', role: 'adult' });
    admin = createPool(h.adminUrl, 1);
  });
  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });
  beforeEach(async () => {
    await admin.query('delete from local_ai_state');
    await admin.query('delete from settings_check');
    await admin.query('delete from ai_reader');
    await admin.query('update household set local_ai = false');
  });

  const call = (
    who: Tokens,
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) => h.app.inject({ method, url, headers: h.as(who), ...(payload ? { payload } : {}) });
  const AT = '/api/v1/household/reading/ai-reader';
  const body = (over: Record<string, unknown> = {}) => ({
    kind: 'ollama',
    base_url: URL_OK,
    model: 'qwen2.5:3b-instruct',
    timeout_seconds: 120,
    monthly_cap: 500,
    ...over,
  });
  const save = async (over: Record<string, unknown> = {}) => {
    const r = await call(owner, 'PUT', AT, body(over));
    expect(r.statusCode, r.body).toBe(200);
    return r.json<AiReaderView>();
  };
  const stored = async () =>
    (
      await admin.query<{
        kind: string;
        base_url: string;
        api_key_encrypted: Buffer | null;
        status: string;
        runs_at: string;
      }>('select * from ai_reader where household_id = $1', [owner.household_id])
    ).rows[0];
  const caps = async () =>
    (await h.app.inject({ url: '/api/v1/capabilities' })).json<Capabilities>().features;
  const passed = (runsAt = 'own_network') =>
    admin.query(
      "update ai_reader set status = 'ok', last_tested_at = now(), runs_at = $2 where household_id = $1",
      [owner.household_id, runsAt],
    );

  it('is offered, with the kinds this vault reads with: all three since AIR3', async () => {
    const f = await caps();
    expect(f.ai_reader_settings).toBe(true);
    expect(f.ai_reader_kinds).toEqual(['ollama', 'anthropic', 'openai_compatible']);
    expect(f.ai_reader_send_sensitive).toBe(true);
    // `local_ai` too, so that every client asks whether a reader reads the
    // household's papers (the notice, the R4 review's M1).
    expect(f.local_ai).toBe(true);
    const v = (await call(owner, 'GET', AT)).json<AiReaderView>();
    expect(v).toEqual({
      source: 'settings',
      kinds: ['ollama', 'anthropic', 'openai_compatible'],
      env: null,
      reader: null,
      https_only: false,
      send_sensitive: false,
      month: {
        month: expect.stringMatching(/^\d{4}-\d{2}$/) as unknown,
        sent: 0,
        cap: 500,
        warned: false,
      },
    });
  });

  it('is an owner’s alone: anybody else is refused, before their body is read', async () => {
    for (const [method, url] of [
      ['GET', AT],
      ['PUT', AT],
      ['DELETE', AT],
      ['POST', `${AT}/test`],
      ['POST', `${AT}/models`],
      ['PUT', `${AT}/send-sensitive`],
    ] as const) {
      const r = await call(
        adult,
        method,
        url,
        method === 'PUT'
          ? url.endsWith('send-sensitive')
            ? { send_sensitive: true }
            : body()
          : undefined,
      );
      expect([url, r.statusCode]).toEqual([url, 403]);
    }
    expect(await stored()).toBeUndefined();
  });

  it('asks the owner to confirm it is them before it is changed or removed', async () => {
    await admin.query(
      `update session set verified_at = now() - interval '1 hour', factor_verified_at = now() - interval '1 hour'
        where account_id = (select account_id from account_household where member_id = $1)`,
      [owner.member_id],
    );
    try {
      const r = await call(owner, 'PUT', AT, body());
      expect([r.statusCode, codeOf(r)]).toEqual([403, 'step_up_required']);
      expect(r.body).toMatch(/to change where the vault sends papers to be read/);
      const d = await call(owner, 'DELETE', AT);
      expect([d.statusCode, codeOf(d)]).toEqual([403, 'step_up_required']);
      expect(await stored()).toBeUndefined();
    } finally {
      await admin.query(
        `update session set verified_at = now(), factor_verified_at = now()
          where account_id = (select account_id from account_household where member_id = $1)`,
        [owner.member_id],
      );
    }
  });

  it('keeps the key sealed for its reader and address, and never answers it: set, and its last four', async () => {
    const r = await call(owner, 'PUT', AT, body({ api_key: KEY }));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).not.toContain(KEY);
    const v = r.json<AiReaderView>();
    expect(v.reader).toMatchObject({
      kind: 'ollama',
      base_url: URL_OK,
      model: 'qwen2.5:3b-instruct',
      runs_at: 'own_network',
      api_key: 'set',
      api_key_last4: 'WXYZ',
      status: 'untested',
      last_tested_at: null,
    });
    const row = await stored();
    expect(row?.api_key_encrypted?.toString('utf8')).not.toContain(KEY);
    expect(
      openAiReaderKey(
        deriveKey(TEST_MASTER, AI_READER_KEY_PURPOSE),
        row?.api_key_encrypted as Buffer,
        owner.household_id,
        { kind: 'ollama', baseUrl: URL_OK },
      ),
    ).toBe(KEY);
    // Bound to its address: it opens for no other.
    expect(() =>
      openAiReaderKey(
        deriveKey(TEST_MASTER, AI_READER_KEY_PURPOSE),
        row?.api_key_encrypted as Buffer,
        owner.household_id,
        { kind: 'ollama', baseUrl: 'http://192.168.1.31:11434' },
      ),
    ).toThrow();
    // A new model keeps it; a new address forgets it — never sent where it was not typed for.
    expect((await save({ model: 'llama3.2' })).reader?.api_key).toBe('set');
    expect((await save({ base_url: 'http://192.168.1.31:11434' })).reader?.api_key).toBe('not_set');
    // In the activity log, and the other owners told: never the key or the address.
    const lines = await admin.query<{ action: string; detail: unknown }>(
      "select action, detail from audit_event where household_id = $1 and action like 'ai_reader.%'",
      [owner.household_id],
    );
    expect(lines.rows.length).toBe(3);
    expect(lines.rows[0]?.detail).toMatchObject({
      kind: 'ollama',
      runs_at: 'own_network',
      key_changed: true,
      address_changed: true,
    });
    expect(JSON.stringify(lines.rows)).not.toContain(KEY);
    expect(JSON.stringify(lines.rows)).not.toContain('192.168.1');
    const told = alertsSent(h).filter((a) => /AI reader/.test(String(a.subject)));
    expect(told.length).toBeGreaterThan(0);
    expect(JSON.stringify(told)).not.toContain(KEY);
  });

  it('takes the address alone, http(s), with no sign-in, path, query or fragment', async () => {
    for (const base_url of [
      'ftp://192.168.1.30:11434',
      'file:///etc/passwd',
      'http://user:pw@192.168.1.30:11434',
      'http://192.168.1.30:11434/api/chat',
      'http://router.lan/admin',
      'http://192.168.1.30:11434?x=1',
      'http://192.168.1.30:11434#x',
      'not an address',
      '',
    ]) {
      const r = await call(owner, 'PUT', AT, body({ base_url }));
      expect([base_url, r.statusCode, codeOf(r)]).toEqual([base_url, 422, 'validation_failed']);
    }
    expect(await stored()).toBeUndefined();
  });

  it('refuses link-local, "this network" and cloud metadata, by address or by name', async () => {
    for (const base_url of [
      'http://169.254.169.254',
      'http://[fe80::1]:11434',
      'http://0.0.0.0:11434',
      'http://metadata.example.com:11434',
    ]) {
      const r = await call(owner, 'PUT', AT, body({ base_url }));
      expect([base_url, r.statusCode, codeOf(r)]).toEqual([
        base_url,
        422,
        'ai_reader_address_refused',
      ]);
    }
    expect(await stored()).toBeUndefined();
  });

  it('only on the ports the operator allows, and never at the vault’s own services (the review, S2)', async () => {
    const port = await call(owner, 'PUT', AT, body({ base_url: 'http://192.168.1.30:5432' }));
    expect([port.statusCode, codeOf(port)]).toEqual([422, 'ai_reader_port_refused']);
    expect(port.body).toContain('11434');
    for (const base_url of [
      'http://api:11434',
      'http://postgres:8080',
      'http://fdv-web-1',
      'http://worker:11434',
      'http://172.18.0.4:11434',
    ]) {
      const r = await call(owner, 'PUT', AT, body({ base_url }));
      expect([base_url, r.statusCode, codeOf(r)]).toEqual([
        base_url,
        422,
        'ai_reader_address_refused',
      ]);
    }
    expect(await stored()).toBeUndefined();
    // Each of the default ports, and a host's own name for Docker, are fine.
    for (const at of [
      'http://192.168.1.30:1234',
      'http://host.docker.internal:11434',
      'http://a',
    ]) {
      expect((await call(owner, 'PUT', AT, body({ base_url: at }))).statusCode).toBe(200);
    }
    // Too long is said, not a server error (M3).
    const long = await call(owner, 'PUT', AT, body({ base_url: `http://${'a'.repeat(300)}.lan` }));
    expect([long.statusCode, codeOf(long)]).toEqual([422, 'validation_failed']);
  });

  it('keeps the last four of a long key alone: a short key is never shown back (the review, M1)', async () => {
    expect((await save({ api_key: 'abcd' })).reader).toMatchObject({
      api_key: 'set',
      api_key_last4: null,
    });
    expect((await save({ api_key: '12345678901' })).reader?.api_key_last4).toBeNull();
    expect((await save({ api_key: '123456789012' })).reader?.api_key_last4).toBe('9012');
  });

  it('says where it runs: your own network, or a cloud service (decision 2)', async () => {
    const at = async (base_url: string) => (await save({ base_url })).reader?.runs_at;
    expect(await at('http://ollama:11434')).toBe('own_network');
    expect(await at('http://nas.local:11434')).toBe('own_network');
    expect(await at('http://localhost:11434')).toBe('own_network');
    expect(await at('https://nas.example.com')).toBe('own_network');
    expect(await at('https://reader.example.com')).toBe('cloud');
    expect(await at('https://mixed.example.com')).toBe('cloud');
    expect(await at('http://8.8.8.8:11434')).toBe('cloud');
    // A name nobody can resolve counts as a cloud service until a Test finds otherwise.
    expect(await at('https://unknown.example.org')).toBe('cloud');
  });

  it('Anthropic (AIR3): its address fixed — none typed, none kept — a key it must have, always a cloud service', async () => {
    // An address typed for it is refused; none, and no key, too.
    const typed = await call(owner, 'PUT', AT, body({ kind: 'anthropic', api_key: KEY }));
    expect(typed.statusCode).toBe(422);
    const keyless = await call(owner, 'PUT', AT, body({ kind: 'anthropic', base_url: null }));
    expect([keyless.statusCode, keyless.body]).toEqual([422, expect.stringMatching(/API key/)]);
    expect(await stored()).toBeUndefined();
    const v = await save({
      kind: 'anthropic',
      base_url: null,
      model: 'claude-haiku-4-5',
      api_key: KEY,
    });
    expect(v.reader).toMatchObject({
      kind: 'anthropic',
      base_url: null,
      runs_at: 'cloud',
      api_key: 'set',
      status: 'untested',
    });
    // The key sealed for Anthropic, its address none.
    const row = await stored();
    expect(row?.base_url).toBeNull();
    expect(
      openAiReaderKey(
        deriveKey(TEST_MASTER, AI_READER_KEY_PURPOSE),
        row?.api_key_encrypted as Buffer,
        owner.household_id,
        { kind: 'anthropic', baseUrl: null },
      ),
    ).toBe(KEY);
  });

  it('OpenAI-compatible (AIR3): a cloud service unless the owner says it is on their network AND its address is private', async () => {
    const at = async (base_url: string, own_network: boolean) =>
      (await save({ kind: 'openai_compatible', base_url, model: 'gpt-4o-mini', own_network }))
        .reader?.runs_at;
    expect(await at('http://192.168.1.30:1234', false)).toBe('cloud');
    expect(await at('http://192.168.1.30:1234', true)).toBe('own_network');
    expect(await at('https://reader.example.com', true)).toBe('cloud');
    expect((await stored())?.kind).toBe('openai_compatible');
    // The owner's word changed waits for a Test of its own.
    await passed('cloud');
    const v = await save({
      kind: 'openai_compatible',
      base_url: 'https://reader.example.com',
      model: 'gpt-4o-mini',
      own_network: false,
    });
    expect(v.reader?.status).toBe('untested');
    const r = await call(owner, 'PUT', AT, body({ kind: 'gemini' }));
    expect(r.statusCode).toBe(422);
  });

  it('"Also send sensitive papers" (AIR3): an owner’s, with step-up, only for a cloud reader; every owner emailed, and the activity log says so', async () => {
    const SS = `${AT}/send-sensitive`;
    const flagOf = async () =>
      (
        await admin.query<{ ai_send_sensitive: boolean }>(
          'select ai_send_sensitive from household where id = $1',
          [owner.household_id],
        )
      ).rows[0]?.ai_send_sensitive;
    try {
      // A reader on your own network: nothing is held back from it.
      await save();
      const local = await call(owner, 'PUT', SS, { send_sensitive: true });
      expect([local.statusCode, codeOf(local)]).toEqual([409, 'ai_reader_not_cloud']);
      // Anthropic, a cloud service: off until an owner turns it on.
      await save({ kind: 'anthropic', base_url: null, model: 'claude-haiku-4-5', api_key: KEY });
      expect((await call(owner, 'GET', AT)).json<AiReaderView>().send_sensitive).toBe(false);
      // An adult never; Peter's step-up asked of an owner whose confirmation is old.
      expect((await call(adult, 'PUT', SS, { send_sensitive: true })).statusCode).toBe(403);
      await admin.query(
        `update session set verified_at = now() - interval '1 hour', factor_verified_at = now() - interval '1 hour'
          where account_id = (select account_id from account_household where member_id = $1)`,
        [owner.member_id],
      );
      try {
        const r = await call(owner, 'PUT', SS, { send_sensitive: true });
        expect([r.statusCode, codeOf(r)]).toEqual([403, 'step_up_required']);
        expect(r.body).toMatch(/whether sensitive papers are sent to the AI reader/);
        expect(await flagOf()).toBe(false);
      } finally {
        await admin.query(
          `update session set verified_at = now(), factor_verified_at = now()
            where account_id = (select account_id from account_household where member_id = $1)`,
          [owner.member_id],
        );
      }
      const before = alertsSent(h).length;
      const on = await call(owner, 'PUT', SS, { send_sensitive: true });
      expect(on.statusCode, on.body).toBe(200);
      expect(on.headers['cache-control']).toBe('no-store');
      expect(on.json<AiReaderView>().send_sensitive).toBe(true);
      expect(await flagOf()).toBe(true);
      // Every owner emailed — the one who did it too — naming the provider.
      const told = alertsSent(h).slice(before);
      expect(told).toHaveLength(1);
      expect(told[0]).toMatchObject({ email_only: true });
      expect((told[0]?.account_ids as string[]).sort()).toEqual(
        (
          await admin.query<{ account_id: string }>(
            "select account_id from account_household where household_id = $1 and role = 'owner'",
            [owner.household_id],
          )
        ).rows
          .map((r) => r.account_id)
          .sort(),
      );
      expect(String(told[0]?.body)).toMatch(/sent to Anthropic/);
      expect(JSON.stringify(told)).not.toContain(KEY);
      // And in the activity log.
      const audit = await admin.query<{ detail: Record<string, unknown> }>(
        `select detail from audit_event where household_id = $1
          and action = 'ai_reader.send_sensitive_changed' order by id`,
        [owner.household_id],
      );
      expect(audit.rows.at(-1)?.detail).toMatchObject({ send_sensitive: true, kind: 'anthropic' });
      // The same again changes nothing, and tells nobody.
      await call(owner, 'PUT', SS, { send_sensitive: true });
      expect(alertsSent(h).length).toBe(before + 1);
      // Held to the reader it was turned on for (the review, S3): .env's
      // reader taking over is another reader, and Settings says it is off.
      expect(
        (
          await admin.query<{ ai_send_sensitive_for: string }>(
            'select ai_send_sensitive_for from household where id = $1',
            [owner.household_id],
          )
        ).rows[0]?.ai_send_sensitive_for,
      ).toBe('settings:anthropic:https://api.anthropic.com');
      await admin.query(
        `insert into local_ai_state (worker, model, host, state, kind, runs_at)
         values ('w-s3', 'qwen2.5:3b-instruct', 'ai.example.com:11434', 'reachable', 'ollama', 'cloud')`,
      );
      try {
        const envView = (await call(owner, 'GET', AT)).json<AiReaderView>();
        expect(envView.source).toBe('env');
        expect(envView.send_sensitive).toBe(false);
      } finally {
        await admin.query("delete from local_ai_state where worker = 'w-s3'");
      }
      expect((await call(owner, 'GET', AT)).json<AiReaderView>().send_sensitive).toBe(true);
      // Another kind of reader: the warning named Anthropic, so it is turned off.
      await save({ kind: 'openai_compatible', base_url: 'https://reader.example.com', model: 'm' });
      expect(await flagOf()).toBe(false);
      const after = await admin.query<{ detail: Record<string, unknown> }>(
        `select detail from audit_event where household_id = $1
          and action = 'ai_reader.send_sensitive_changed' order by id`,
        [owner.household_id],
      );
      expect(after.rows.at(-1)?.detail).toMatchObject({
        send_sensitive: false,
        reader_changed: true,
      });
      // Off is always allowed.
      expect((await call(owner, 'PUT', SS, { send_sensitive: false })).statusCode).toBe(200);
    } finally {
      await admin.query('update household set ai_send_sensitive = false where id = $1', [
        owner.household_id,
      ]);
    }
  });

  it('this month’s count, of the cap, on the household’s calendar (AIR3)', async () => {
    await save({
      kind: 'anthropic',
      base_url: null,
      model: 'claude-haiku-4-5',
      api_key: KEY,
      monthly_cap: 40,
    });
    await admin.query(
      `insert into ai_reader_send (household_id, kind, runs_at, purpose, sent_at, outcome)
       values ($1, 'anthropic', 'cloud', 'item', now() - interval '1 minute', 'read'),
              ($1, 'anthropic', 'cloud', 'check', now() - interval '1 minute', 'without'),
              ($1, 'anthropic', 'cloud', 'item', now() - interval '1 minute', 'not_sent'),
              ($1, 'ollama', 'own_network', 'item', now() - interval '1 minute', 'read'),
              ($1, 'anthropic', 'cloud', 'item', now() - interval '45 days', 'read')`,
      [owner.household_id],
    );
    try {
      const v = (await call(owner, 'GET', AT)).json<AiReaderView>();
      expect(v.month).toMatchObject({ sent: 2, cap: 40, warned: false });
      // The owners alone read what was sent: an adult is given none of it.
      const asAdult = await call(adult, 'GET', AT);
      expect(asAdult.statusCode).toBe(403);
    } finally {
      await admin.query('delete from ai_reader_send where household_id = $1', [owner.household_id]);
    }
  });

  it('waits for a Test, which only the vault says passed; anything that reaches the reader changed waits again', async () => {
    await save({ api_key: KEY });
    // An owner, as themselves, can't say a Test passed: the database refuses it.
    const account = (
      await admin.query<{ id: string }>(
        'select account_id as id from account_household where member_id = $1',
        [owner.member_id],
      )
    ).rows[0]?.id as string;
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query(
        `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                set_config('app.role', 'owner', true), set_config('app.account_id', $2, true)`,
        [owner.household_id, account],
      );
      const refused = await client
        .query("update ai_reader set status = 'ok', updated_by = $1", [account])
        .then(
          () => null,
          (e: Error) => e.message,
        );
      expect(refused).toMatch(/the vault's to say/);
    } finally {
      await client.query('rollback');
      client.release();
    }
    await passed();
    // A new limit or timeout alone keeps it.
    expect((await save({ monthly_cap: 50, timeout_seconds: 30 })).reader?.status).toBe('ok');
    // A new model waits for a Test of its own.
    expect((await save({ model: 'llama3.2' })).reader?.status).toBe('untested');
  });

  it('Test and the models are asked of the worker, for the reader saved; what it said is never shown', async () => {
    expect(codeOf(await call(owner, 'POST', `${AT}/test`))).toBe('ai_reader_not_saved');
    await save();
    const r = await call(owner, 'POST', `${AT}/test`);
    expect(r.statusCode, r.body).toBe(202);
    const asked = r.json<SettingsCheckView>();
    expect(asked).toMatchObject({ kind: 'ai_reader', state: 'waiting' });
    expect(h.jobs.some((j) => j.name === 'settings.check' && j.data.check_id === asked.id)).toBe(
      true,
    );
    // Whatever the worker wrote beyond what is known is not shown.
    await admin.query(
      `update settings_check set done_at = now(),
         result = '{"problem": "bad_reply", "model": "m", "host": "h:1", "latency_ms": null,
                    "body": "secret-from-the-network", "runs_at": "cloud"}'::jsonb
        where id = $1`,
      [asked.id],
    );
    const got = await call(owner, 'GET', `/api/v1/settings-checks/${asked.id}`);
    expect(got.json<SettingsCheckView>().ai_reader).toMatchObject({
      problem: 'bad_reply',
      runs_at: 'cloud',
    });
    expect(got.body).not.toContain('secret-from-the-network');
    // An unknown problem is never taken for an answer.
    await admin.query(
      `update settings_check set result = '{"problem": "anything-else", "model": "m"}'::jsonb where id = $1`,
      [asked.id],
    );
    expect(
      (await call(owner, 'GET', `/api/v1/settings-checks/${asked.id}`)).json<SettingsCheckView>()
        .ai_reader?.problem,
    ).toBe('unreachable');
    // The models: names of a model's shape alone.
    await admin.query('delete from settings_check');
    const m = (await call(owner, 'POST', `${AT}/models`)).json<SettingsCheckView>();
    await admin.query(
      `update settings_check set done_at = now(),
         result = '{"problem": null, "models": ["llama3.2", "<b>secret</b>", 7]}'::jsonb where id = $1`,
      [m.id],
    );
    const listed = await call(owner, 'GET', `/api/v1/settings-checks/${m.id}`);
    expect(listed.json<SettingsCheckView>().ai_models).toEqual({
      problem: null,
      models: ['llama3.2'],
      words: 'It has 1 model.',
    });
  });

  it('the household’s switch turns it on only once its Test passed; whoever adds papers is told which reader, and where', async () => {
    await save();
    const on = await call(owner, 'PUT', '/api/v1/household/reading', { local_ai: true });
    expect([on.statusCode, codeOf(on)]).toEqual([409, 'local_ai_unavailable']);
    await passed();
    const v = (await call(owner, 'GET', '/api/v1/household/reading')).json<LocalAiSettingsView>();
    expect(v.local_ai_reader).toEqual({
      source: 'settings',
      kind: 'ollama',
      model: 'qwen2.5:3b-instruct',
      host: '192.168.1.30:11434',
      runs_at: 'own_network',
      ready: true,
    });
    expect(
      (await call(owner, 'PUT', '/api/v1/household/reading', { local_ai: true })).statusCode,
    ).toBe(200);
    const notice = (
      await call(adult, 'GET', '/api/v1/household/reading/notice')
    ).json<LocalAiNotice>();
    expect(notice).toEqual({
      local_ai: true,
      host: '192.168.1.30:11434',
      kind: 'ollama',
      runs_at: 'own_network',
    });
    // Removed: forgotten, key and all, and nobody is told it reads any more.
    const gone = await call(owner, 'DELETE', AT);
    expect(gone.statusCode, gone.body).toBe(200);
    expect(gone.json<AiReaderView>().reader).toBeNull();
    expect(
      (await call(adult, 'GET', '/api/v1/household/reading/notice')).json<LocalAiNotice>(),
    ).toEqual({ local_ai: false, host: null });
  });

  it('.env wins: its reader shown, locked, and nothing here can change it (decision 8)', async () => {
    await save();
    await admin.query(
      `insert into local_ai_state (worker, model, host, state, kind, runs_at)
       values ('w1:1', 'env-model', 'ollama:11434', 'reachable', 'ollama', 'own_network')`,
    );
    const v = (await call(owner, 'GET', AT)).json<AiReaderView>();
    expect(v.source).toBe('env');
    expect(v.env).toEqual({
      kind: 'ollama',
      model: 'env-model',
      host: 'ollama:11434',
      runs_at: 'own_network',
    });
    for (const [method, url] of [
      ['PUT', AT],
      ['POST', `${AT}/test`],
      ['POST', `${AT}/models`],
    ] as const) {
      const r = await call(owner, method, url, method === 'PUT' ? body({ model: 'x' }) : undefined);
      expect([url, r.statusCode, codeOf(r)]).toEqual([url, 409, 'ai_reader_locked']);
    }
    // The switch's reader is .env's.
    expect(
      (await call(owner, 'GET', '/api/v1/household/reading')).json<LocalAiSettingsView>()
        .local_ai_reader,
    ).toMatchObject({ source: 'env', model: 'env-model', ready: true });
  });
});

describe.skipIf(!testAdminUrl())('FDV_AI_READER_SETTINGS=off (AIR1)', () => {
  let h: Harness;
  let owner: Tokens;
  beforeAll(async () => {
    h = await createHarness({ aiReaderSettings: 'off' });
    owner = await h.setup();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('takes the reader out of Settings altogether', async () => {
    const f = (await h.app.inject({ url: '/api/v1/capabilities' })).json<Capabilities>().features;
    expect(f.ai_reader_settings).toBeUndefined();
    expect(f.ai_reader_kinds).toBeUndefined();
    expect(f.local_ai).toBe(false);
    const AT = '/api/v1/household/reading/ai-reader';
    const v = await h.app.inject({ url: AT, headers: h.as(owner) });
    expect(v.json<AiReaderView>().source).toBe('off');
    const put = await h.app.inject({
      method: 'PUT',
      url: AT,
      headers: h.as(owner),
      payload: {
        kind: 'ollama',
        base_url: URL_OK,
        model: 'qwen2.5:3b-instruct',
        timeout_seconds: 120,
        monthly_cap: 500,
      },
    });
    expect([put.statusCode, codeOf(put)]).toEqual([409, 'ai_reader_settings_off']);
    const test = await h.app.inject({ method: 'POST', url: `${AT}/test`, headers: h.as(owner) });
    expect(codeOf(test)).toBe('ai_reader_settings_off');
  });

  it('still lets an owner forget a reader saved before, key and all (the review, M4)', async () => {
    const admin = createPool(h.adminUrl, 1);
    try {
      await admin.query(
        `insert into ai_reader (household_id, kind, base_url, model, runs_at, api_key_encrypted)
         values ($1, 'ollama', 'http://192.168.1.30:11434', 'm', 'own_network', $2)`,
        [owner.household_id, Buffer.alloc(40, 1)],
      );
      const gone = await h.app.inject({
        method: 'DELETE',
        url: '/api/v1/household/reading/ai-reader',
        headers: h.as(owner),
      });
      expect(gone.statusCode, gone.body).toBe(200);
      expect(
        (await admin.query('select 1 from ai_reader where household_id = $1', [owner.household_id]))
          .rows,
      ).toEqual([]);
    } finally {
      await admin.end();
    }
  });
});

describe.skipIf(!testAdminUrl())('the hosted edition (AIR1, decision 9)', () => {
  let h: Harness;
  let owner: Tokens;
  beforeAll(async () => {
    h = await createHarness({ edition: 'hosted', aiResolve });
    owner = await h.setup();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('takes only https to a public address', async () => {
    const put = (base_url: string) =>
      h.app.inject({
        method: 'PUT',
        url: '/api/v1/household/reading/ai-reader',
        headers: h.as(owner),
        payload: {
          kind: 'ollama',
          base_url,
          model: 'qwen2.5:3b-instruct',
          timeout_seconds: 120,
          monthly_cap: 500,
        },
      });
    const http = await put('http://reader.example.com');
    expect([http.statusCode, codeOf(http)]).toEqual([422, 'validation_failed']);
    expect(http.body).toMatch(/https:\/\//);
    for (const inside of [
      'https://192.168.1.30',
      'https://127.0.0.1',
      'https://localhost',
      'https://nas.example.com',
      'https://mixed.example.com',
    ]) {
      const r = await put(inside);
      expect([inside, r.statusCode, codeOf(r)]).toEqual([inside, 422, 'ai_reader_address_refused']);
    }
    const ok = await put('https://reader.example.com');
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json<AiReaderView>()).toMatchObject({
      https_only: true,
      reader: { runs_at: 'cloud', base_url: 'https://reader.example.com' },
    });
    // The rule is kept with the reader, for a worker without FDV_EDITION (the review, S1).
    const admin = createPool(h.adminUrl, 1);
    try {
      const row = await admin.query<{ https_only: boolean }>(
        'select https_only from ai_reader where household_id = $1',
        [owner.household_id],
      );
      expect(row.rows).toEqual([{ https_only: true }]);
    } finally {
      await admin.end();
    }
  });

  it('only the providers its subprocessor list names: Anthropic, and OpenAI-compatible only at OpenAI (AIR3)', async () => {
    const put = (payload: Record<string, unknown>) =>
      h.app.inject({
        method: 'PUT',
        url: '/api/v1/household/reading/ai-reader',
        headers: h.as(owner),
        payload: { model: 'm-1', timeout_seconds: 120, monthly_cap: 500, ...payload },
      });
    const other = await put({ kind: 'openai_compatible', base_url: 'https://reader.example.com' });
    expect([other.statusCode, codeOf(other)]).toEqual([422, 'ai_reader_provider_not_offered']);
    const openai = await put({ kind: 'openai_compatible', base_url: 'https://api.openai.com' });
    expect(openai.statusCode, openai.body).toBe(200);
    expect(openai.json<AiReaderView>().reader).toMatchObject({ runs_at: 'cloud' });
    const claude = await put({ kind: 'anthropic', base_url: null, api_key: KEY });
    expect(claude.statusCode, claude.body).toBe(200);
  });
});
