import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { ReadingSettings, Tokens } from '@fdv/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * The vault's reading model on or off (0.9.0, R2): GET and PUT
 * /household/reading, an owner's alone — at the route and in the database
 * (0079's household_reading_model_rule) — on unless an owner turns it off,
 * and said in the activity log.
 */

describe.skipIf(!testAdminUrl())('the reading model’s switch (R2)', () => {
  let h: Harness;
  let owner: Tokens;
  let adult: Tokens;
  let teen: Tokens;
  let viewer: Tokens;
  let hh: string;
  let admin: ReturnType<typeof createPool>;
  let appPool: ReturnType<typeof createPool>;

  const call = (who: Tokens | null, method: string, url: string, payload?: unknown) =>
    h.app.inject({
      method: method as 'GET',
      url,
      headers: who ? h.as(who) : {},
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
  const stored = async () =>
    (
      await admin.query<{ on: boolean }>(
        'select reading_model as on from household where id = $1',
        [hh],
      )
    ).rows[0]?.on;

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    owner = await h.setup();
    hh = owner.household_id;
    adult = await h.join(owner, { name: 'Sara', email: 'sara@reading-model.test', role: 'adult' });
    teen = await h.join(owner, { name: 'Zain', email: 'zain@reading-model.test', role: 'teen' });
    viewer = await h.join(owner, { name: 'Vic', email: 'vic@reading-model.test', role: 'viewer' });
    admin = createPool(h.adminUrl, 1);
    appPool = createPool(h.appUrl, 1);
  }, 180_000);

  afterAll(async () => {
    await admin?.end();
    await appPool?.end();
    await h?.close();
  });

  it('is on unless an owner turns it off; offered only while the worker has the weights loaded', async () => {
    expect(await stored()).toBe(true);
    const features = async () =>
      (await call(owner, 'GET', '/api/v1/capabilities')).json<{
        features: Record<string, unknown>;
      }>().features.reading_model;
    const settings = async () =>
      (await call(owner, 'GET', '/api/v1/household/reading')).json<ReadingSettings>();
    // No worker has said yet: not offered, and Settings is told.
    await admin.query('delete from reading_model_state');
    expect(await features()).toBe(false);
    expect(await settings()).toMatchObject({ reading_model: true, loaded: false });
    // Loaded, as the worker says (the R2 review).
    await admin.query("insert into reading_model_state (worker, state) values ('w1:1', 'loaded')");
    expect(await features()).toBe(true);
    expect(await settings()).toMatchObject({ reading_model: true, loaded: true });
    // Its weights spoilt: not offered again.
    await admin.query("update reading_model_state set state = 'corrupt'");
    expect(await features()).toBe(false);
    expect(await settings()).toMatchObject({ reading_model: true, loaded: false });
    await admin.query("update reading_model_state set state = 'loaded'");
    // Two workers: offered only while every one said lately has it (the R2 re-check).
    await admin.query("insert into reading_model_state (worker, state) values ('w2:2', 'missing')");
    expect(await features()).toBe(false);
    expect(await settings()).toMatchObject({ reading_model: true, loaded: false });
    // The one without it stopped saying so long ago (stopped, or a restore's row): not counted.
    await admin.query(
      "update reading_model_state set checked_at = now() - interval '1 hour' where worker = 'w2:2'",
    );
    expect(await features()).toBe(true);
    // And no worker said anything lately: not offered.
    await admin.query("update reading_model_state set checked_at = now() - interval '1 hour'");
    expect(await features()).toBe(false);
    expect(await settings()).toMatchObject({ reading_model: true, loaded: false });
    await admin.query("delete from reading_model_state where worker = 'w2:2'");
    await admin.query('update reading_model_state set checked_at = now()');
    expect(await features()).toBe(true);
    // The application role reads it, and never writes it.
    const client = await appPool.connect();
    try {
      await expect(
        client.query("update reading_model_state set state = 'missing'"),
      ).rejects.toThrow(/permission/);
    } finally {
      client.release();
    }
  });

  it('many owners’ requests at once never starve the pool (the R2 re-check)', async () => {
    // More requests than the harness's pool has connections (4): each asks
    // whether the model is loaded outside its transaction, so none waits
    // for a connection another holds while it holds one.
    const many = Array.from({ length: 12 }, (_, i) =>
      i % 2 === 0
        ? call(owner, 'GET', '/api/v1/household/reading')
        : call(owner, 'PUT', '/api/v1/household/reading', { reading_model: true }),
    );
    const timeout = new Promise<'stuck'>((done) => setTimeout(() => done('stuck'), 20_000));
    const got = await Promise.race([Promise.all(many), timeout]);
    expect(got).not.toBe('stuck');
    if (got !== 'stuck') expect(got.map((r) => r.statusCode)).toEqual(Array(12).fill(200));
  }, 60_000);

  it('an owner turns it off and on again; each change is said in the activity log', async () => {
    const off = await call(owner, 'PUT', '/api/v1/household/reading', { reading_model: false });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json<ReadingSettings>()).toMatchObject({ reading_model: false });
    expect(await stored()).toBe(false);
    expect(
      (await call(owner, 'GET', '/api/v1/household/reading')).json<ReadingSettings>(),
    ).toMatchObject({ reading_model: false });
    // The same again changes nothing, and says nothing more.
    await call(owner, 'PUT', '/api/v1/household/reading', { reading_model: false });
    const on = await call(owner, 'PUT', '/api/v1/household/reading', { reading_model: true });
    expect(on.json<ReadingSettings>()).toMatchObject({ reading_model: true });
    expect(await stored()).toBe(true);
    const lines = await admin.query<{ detail: { reading_model: boolean } }>(
      `select detail from audit_event where household_id = $1
         and action = 'household.reading_model_changed' order by id`,
      [hh],
    );
    expect(lines.rows.map((r) => r.detail)).toEqual([
      { reading_model: false },
      { reading_model: true },
    ]);
    // In the owners' activity log, in words; not in an adult's.
    const words = async (who: Tokens) =>
      (await call(who, 'GET', '/api/v1/audit'))
        .json<{ items: Array<{ text: string }> }>()
        .items.map((l) => l.text);
    expect((await words(owner)).join('|')).toMatch(/turned off the vault’s reading model/);
    expect((await words(adult)).join('|')).not.toMatch(/reading model/);
  });

  it('is an owner’s alone at the route: anybody else, or nobody, is refused, and nothing changes', async () => {
    for (const who of [adult, teen, viewer]) {
      expect((await call(who, 'GET', '/api/v1/household/reading')).statusCode).toBe(403);
      expect(
        (await call(who, 'PUT', '/api/v1/household/reading', { reading_model: false })).statusCode,
      ).toBe(403);
    }
    expect((await call(null, 'GET', '/api/v1/household/reading')).statusCode).toBe(401);
    // A body that is not the switch is refused.
    for (const bad of [{}, { reading_model: 'no' }, { reading_model: false, more: 1 }]) {
      expect(
        (await call(owner, 'PUT', '/api/v1/household/reading', bad)).statusCode,
        JSON.stringify(bad),
      ).toBe(422);
    }
    expect(await stored()).toBe(true);
  });

  it('is an owner’s alone in the database too (0079)', async () => {
    const asRole = async (role: string, member: string) => {
      const client = await appPool.connect();
      try {
        await client.query('begin');
        await client.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                  set_config('app.role', $2, true), set_config('app.member_id', $3, true)`,
          [hh, role, member],
        );
        await client.query('update household set reading_model = false where id = $1', [hh]);
        await client.query('rollback');
        return 'changed';
      } catch (e) {
        await client.query('rollback').catch(() => undefined);
        return (e as Error).message;
      } finally {
        client.release();
      }
    };
    for (const role of ['adult', 'teen', 'viewer']) {
      expect(await asRole(role, adult.member_id)).toMatch(
        /only an owner turns the vault's reading model on or off|permission|policy/,
      );
    }
    expect(await asRole('owner', owner.member_id)).toBe('changed');
    expect(await stored()).toBe(true);
  });
});
