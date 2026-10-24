import { createPool, withPrincipal } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { Capabilities, LocalAiSettingsView, SettingsCheckView } from '@fdv/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * The local AI reader's switch (0.9.0, R4): GET and PUT /household/reading
 * `{ local_ai }`, an owner's, off unless an owner turns it on — and on only
 * while a worker has one set up. Where the model is, the operator's .env
 * alone says: nothing here takes a URL, a host or a model. Test is asked of
 * the worker; capabilities say `local_ai` while a worker said so lately.
 */
describe.skipIf(!testAdminUrl())('the local AI’s switch (R4)', () => {
  let h: Harness;
  let owner: Tokens;
  let adult: Tokens;
  let admin: ReturnType<typeof createPool>;
  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    owner = await h.setup();
    adult = await h.join(owner, { name: 'Ada', email: 'ada-ai@example.test', role: 'adult' });
    admin = createPool(h.adminUrl, 1);
  });
  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });
  beforeEach(async () => {
    await admin.query('delete from local_ai_state');
    await admin.query('delete from settings_check');
  });

  const get = (who: Tokens) =>
    h.app.inject({ url: '/api/v1/household/reading', headers: h.as(who) });
  const put = (who: Tokens, payload: Record<string, unknown>) =>
    h.app.inject({ method: 'PUT', url: '/api/v1/household/reading', headers: h.as(who), payload });
  const workerSays = (state: string, ago = '0 seconds') =>
    admin.query(
      `insert into local_ai_state (worker, model, host, state, checked_at)
       values ('w1:1', 'qwen2.5:3b-instruct', 'ollama:11434', $1, now() - $2::interval)`,
      [state, ago],
    );
  const caps = async () =>
    (await h.app.inject({ url: '/api/v1/capabilities' })).json<Capabilities>().features;

  it('off as a household starts, and not set up while no worker has one', async () => {
    const res = await get(owner);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<LocalAiSettingsView>()).toEqual({
      reading_model: true,
      loaded: false,
      local_ai: false,
      local_ai_server: { state: 'not_set_up' },
    });
    expect((await caps()).local_ai).toBe(false);
    // Not to be turned on: there is nothing to turn on.
    const on = await put(owner, { local_ai: true });
    expect(on.statusCode).toBe(409);
    expect(on.json<{ error: { code: string } }>().error.code).toBe('local_ai_unavailable');
    // Beside the reading model's switch (R2), refused, nothing changes.
    expect((await put(owner, { reading_model: false, local_ai: true })).statusCode).toBe(409);
    expect((await get(owner)).json<{ reading_model: boolean }>().reading_model).toBe(true);
    // Off may always be said.
    expect((await put(owner, { local_ai: false })).statusCode).toBe(200);
  });

  it('a worker’s word lately: its model and host, and whether it answered — a stale one is none', async () => {
    await workerSays('unreachable');
    expect((await get(owner)).json<LocalAiSettingsView>().local_ai_server).toMatchObject({
      state: 'unreachable',
      model: 'qwen2.5:3b-instruct',
      host: 'ollama:11434',
    });
    expect((await caps()).local_ai).toBe(true);
    await admin.query('delete from local_ai_state');
    await workerSays('reachable', '20 minutes');
    expect((await get(owner)).json<LocalAiSettingsView>().local_ai_server).toEqual({
      state: 'not_set_up',
    });
    expect((await caps()).local_ai).toBe(false);
  });

  it('an owner turns it on and off, said in the activity log; nobody can send where the model is', async () => {
    await workerSays('reachable');
    const on = await put(owner, { local_ai: true });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json<LocalAiSettingsView>().local_ai).toBe(true);
    expect((await get(owner)).json<LocalAiSettingsView>().local_ai).toBe(true);
    const lines = await admin.query<{ detail: { local_ai: boolean } }>(
      "select detail from audit_event where household_id = $1 and action = 'household.local_ai_changed' order by id",
      [owner.household_id],
    );
    expect(lines.rows.map((r) => r.detail.local_ai)).toEqual([true]);
    // The endpoint is the operator's .env alone: the body takes the switch and nothing else.
    for (const payload of [
      { local_ai: true, url: 'http://169.254.169.254/' },
      { local_ai_url: 'http://evil.example' },
      { local_ai: true, model: 'other' },
      { local_ai: true, local_ai_server: { host: 'evil.example' } },
      { local_ai: 'yes' },
      {},
    ]) {
      const res = await put(owner, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(422);
    }
    expect((await get(owner)).json<LocalAiSettingsView>().local_ai_server).toMatchObject({
      host: 'ollama:11434',
    });
    expect((await put(owner, { local_ai: false })).json<LocalAiSettingsView>().local_ai).toBe(
      false,
    );
  });

  it('whoever adds papers is told whether the local AI reads them, and on which host (M1)', async () => {
    const notice = async (who: Tokens) =>
      h.app.inject({ url: '/api/v1/household/reading/notice', headers: h.as(who) });
    await workerSays('reachable');
    expect((await notice(adult)).json()).toEqual({ local_ai: false, host: null });
    expect((await put(owner, { local_ai: true })).statusCode).toBe(200);
    const on = await notice(adult);
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json()).toEqual({ local_ai: true, host: 'ollama:11434' });
    // Never the model, nor whether it answered.
    expect(on.body).not.toMatch(/qwen|reachable/);
    // Not set up any more: not said.
    await admin.query('delete from local_ai_state');
    expect((await notice(adult)).json()).toEqual({ local_ai: false, host: null });
    await workerSays('reachable');
    await put(owner, { local_ai: false });
  });

  it('both switches in one PUT are set in one transaction: both, or neither', async () => {
    await workerSays('reachable');
    const now = async () =>
      (
        await admin.query<{ local_ai: boolean; reading_model: boolean }>(
          'select local_ai, reading_model from household where id = $1',
          [owner.household_id],
        )
      ).rows[0];
    expect(await now()).toEqual({ local_ai: false, reading_model: true });
    // The second change's line in the log refused: the first is not kept either.
    await admin.query(`create function r4_refuse() returns trigger language plpgsql as $$
      begin raise exception 'refused for the test'; end $$`);
    await admin.query(`create trigger r4_refuse before insert on audit_event for each row
      when (new.action = 'household.reading_model_changed') execute function r4_refuse()`);
    try {
      const res = await put(owner, { local_ai: true, reading_model: false });
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(await now()).toEqual({ local_ai: false, reading_model: true });
    } finally {
      await admin.query('drop trigger r4_refuse on audit_event');
      await admin.query('drop function r4_refuse()');
    }
    const ok = await put(owner, { local_ai: true, reading_model: false });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ local_ai: true, reading_model: false });
    expect(await now()).toEqual({ local_ai: true, reading_model: false });
    await put(owner, { local_ai: false, reading_model: true });
  });

  it('an owner’s alone: anybody else is refused, and the database says so too', async () => {
    await workerSays('reachable');
    expect((await get(adult)).statusCode).toBe(403);
    expect((await put(adult, { local_ai: true })).statusCode).toBe(403);
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: '/api/v1/household/reading/local-ai/test',
          headers: h.as(adult),
        })
      ).statusCode,
    ).toBe(403);
    const accountId = (
      await admin.query<{ account_id: string }>(
        'select account_id from account_household where member_id = $1',
        [adult.member_id],
      )
    ).rows[0]?.account_id;
    const refused = await withPrincipal(
      h.db,
      {
        accountId,
        householdId: adult.household_id,
        memberId: adult.member_id,
        role: 'adult',
      } as never,
      (trx) =>
        trx
          .updateTable('household')
          .set({ local_ai: true })
          .where('id', '=', adult.household_id)
          .execute(),
    ).then(
      () => null,
      (e: unknown) => (e as Error).message,
    );
    const after = await admin.query<{ local_ai: boolean }>(
      'select local_ai from household where id = $1',
      [adult.household_id],
    );
    expect(refused).toMatch(/only an owner turns the local AI on or off/);
    expect(after.rows[0]?.local_ai).toBe(false);
  });

  it('Test is asked of the worker, one at a time, and answered with the model, the host and how long', async () => {
    await workerSays('reachable');
    const before = h.jobs.length;
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/household/reading/local-ai/test',
      headers: h.as(owner),
    });
    expect(res.statusCode, res.body).toBe(202);
    const view = res.json<SettingsCheckView>();
    expect(view).toMatchObject({ kind: 'local_ai', state: 'waiting' });
    expect(h.jobs.slice(before).map((j) => j.name)).toEqual(['settings.check']);
    const again = await h.app.inject({
      method: 'POST',
      url: '/api/v1/household/reading/local-ai/test',
      headers: h.as(owner),
    });
    expect(again.statusCode).toBe(429);
    // The worker answers into its row.
    await admin.query(
      `update settings_check set done_at = now(),
              result = '{"problem":null,"model":"qwen2.5:3b-instruct","host":"ollama:11434","latency_ms":2345,"extra":"<b>x</b>"}'
        where id = $1`,
      [view.id],
    );
    const done = await h.app.inject({
      url: `/api/v1/settings-checks/${view.id}`,
      headers: h.as(owner),
    });
    expect(done.json<SettingsCheckView>().local_ai).toEqual({
      problem: null,
      model: 'qwen2.5:3b-instruct',
      host: 'ollama:11434',
      latency_ms: 2345,
      words: 'qwen2.5:3b-instruct answered in 2.3 seconds.',
    });
  });
});
