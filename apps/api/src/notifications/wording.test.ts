import { createPool, withPrincipal } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { Capabilities, MyWordingView, NeutralWordingView } from '@fdv/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * Neutral wording in notifications and email (0.9.0, H2): the household's
 * choice — GET and PUT /household/neutral-wording, an owner's, naming more
 * documents only after confirming it's them — and each person's own,
 * GET and PUT /notifications/wording, beside the household's: a line is
 * neutral when either says so. What the worker sends under each is
 * apps/worker/src/jobs/neutral-wording.test.ts's.
 */
describe.skipIf(!testAdminUrl())('neutral wording, the settings (H2)', () => {
  let h: Harness;
  let owner: Tokens;
  let adult: Tokens;
  let teen: Tokens;
  let viewer: Tokens;
  let admin: ReturnType<typeof createPool>;
  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    owner = await h.setup();
    adult = await h.join(owner, { name: 'Ada', email: 'ada-wording@example.test', role: 'adult' });
    teen = await h.join(owner, { name: 'Tess', email: 'tess-wording@example.test', role: 'teen' });
    viewer = await h.join(owner, {
      name: 'Vic',
      email: 'vic-wording@example.test',
      role: 'viewer',
    });
    admin = createPool(h.adminUrl, 1);
  });
  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  const household = (who: Tokens, payload?: Record<string, unknown>) =>
    h.app.inject({
      method: payload ? 'PUT' : 'GET',
      url: '/api/v1/household/neutral-wording',
      headers: h.as(who),
      ...(payload ? { payload } : {}),
    });
  const mine = (who: Tokens, payload?: Record<string, unknown>) =>
    h.app.inject({
      method: payload ? 'PUT' : 'GET',
      url: '/api/v1/notifications/wording',
      headers: h.as(who),
      ...(payload ? { payload } : {}),
    });
  const codeOf = (r: { json: () => unknown }) =>
    (r.json() as { error?: { code?: string } }).error?.code;
  /** Their sign-in confirmed an hour ago, or just now. */
  const confirmed = (who: Tokens, when: 'stale' | 'fresh') =>
    admin.query(
      `update session set verified_at = ${when === 'fresh' ? 'now()' : "now() - interval '1 hour'"}
        where account_id = (select account_id from account_household where member_id = $1)`,
      [who.member_id],
    );
  const lines = async () =>
    (
      await admin.query<{ detail: { neutral_wording: string; was: string } }>(
        `select detail from audit_event
          where household_id = $1 and action = 'household.neutral_wording_changed' order by id`,
        [owner.household_id],
      )
    ).rows.map((r) => `${r.detail.was}>${r.detail.neutral_wording}`);
  const accountOf = async (who: Tokens) =>
    (
      await admin.query<{ account_id: string }>(
        'select account_id from account_household where member_id = $1',
        [who.member_id],
      )
    ).rows[0]?.account_id as string;

  it('Sensitive documents only, and as the household says, until somebody chooses; capabilities say so', async () => {
    const caps = (await h.app.inject({ url: '/api/v1/capabilities' })).json<Capabilities>();
    expect(caps.features.neutral_wording).toBe(true);
    const got = await household(owner);
    expect(got.statusCode, got.body).toBe(200);
    expect(got.json<NeutralWordingView>()).toEqual({ neutral_wording: 'sensitive' });
    for (const who of [owner, adult, teen, viewer]) {
      const res = await mine(who);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<MyWordingView>()).toEqual({
        neutral_wording: 'household',
        household: 'sensitive',
        in_effect: ['sensitive'],
      });
    }
  });

  it('the household’s choice is an owner’s alone, to read and to change', async () => {
    for (const who of [adult, teen, viewer]) {
      const read = await household(who);
      expect([read.statusCode, codeOf(read)], read.body).toEqual([403, 'forbidden']);
      for (const to of ['off', 'health', 'all', 'sensitive']) {
        const put = await household(who, { neutral_wording: to });
        expect(put.statusCode, `${to}: ${put.body}`).toBe(403);
      }
    }
    expect((await household(owner)).json<NeutralWordingView>().neutral_wording).toBe('sensitive');
    for (const payload of [{}, { neutral_wording: 'loud' }, { neutral_wording: 'all', x: 1 }]) {
      expect((await household(owner, payload)).statusCode, JSON.stringify(payload)).toBe(422);
    }
    expect(await lines()).toEqual([]);
  });

  it('a change that names nothing newly never asks; one that names any document asks the owner to confirm it’s them', async () => {
    await confirmed(owner, 'stale');
    // To All: never asks.
    const all = await household(owner, { neutral_wording: 'all' });
    expect(all.statusCode, all.body).toBe(200);
    expect(all.json<NeutralWordingView>()).toEqual({ neutral_wording: 'all' });
    // From All to any other: asked, and nothing changed.
    for (const to of ['health', 'sensitive', 'off']) {
      const r = await household(owner, { neutral_wording: to });
      expect([r.statusCode, codeOf(r)], to).toEqual([403, 'step_up_required']);
      expect(r.json<{ error: { message: string } }>().error.message).toMatch(/name more documents/);
    }
    expect((await household(owner)).json<NeutralWordingView>().neutral_wording).toBe('all');
    // The same again changes nothing, and asks nothing.
    expect((await household(owner, { neutral_wording: 'all' })).statusCode).toBe(200);
    await confirmed(owner, 'fresh');
    expect((await household(owner, { neutral_wording: 'off' })).statusCode).toBe(200);
    await confirmed(owner, 'stale');
    // From Off: never asks.
    expect((await household(owner, { neutral_wording: 'health' })).statusCode).toBe(200);
    // Health → Sensitive names Medical documents not marked Sensitive: asks.
    const across = await household(owner, { neutral_wording: 'sensitive' });
    expect([across.statusCode, codeOf(across)]).toEqual([403, 'step_up_required']);
    await confirmed(owner, 'fresh');
    expect((await household(owner, { neutral_wording: 'sensitive' })).statusCode).toBe(200);
    // One line each change, from which to which, for whoever reads the log.
    expect(await lines()).toEqual(['sensitive>all', 'all>off', 'off>health', 'health>sensitive']);
    const log = await h.app.inject({ url: '/api/v1/audit', headers: h.as(adult) });
    expect(log.statusCode, log.body).toBe(200);
    expect(log.body).toContain(
      'changed neutral wording in notifications and email from Health documents only to Sensitive documents only',
    );
  });

  it('each person’s own: beside the household’s, never naming what it hides; naming more asks them to confirm', async () => {
    for (const who of [adult, teen, viewer]) await confirmed(who, 'stale');
    // Twice each: the first writes their row, the next changes it — each
    // hiding more, so nothing asks.
    for (const who of [adult, teen, viewer]) {
      for (const [to, effect] of [
        ['health', ['health', 'sensitive']],
        ['all', ['all']],
      ] as const) {
        const r = await mine(who, { neutral_wording: to });
        expect(r.statusCode, r.body).toBe(200);
        expect(r.json<MyWordingView>()).toEqual({
          neutral_wording: to,
          household: 'sensitive',
          in_effect: effect,
        });
      }
    }
    // All to Health would name ordinary documents to them again: asked.
    const back = await mine(adult, { neutral_wording: 'health' });
    expect([back.statusCode, codeOf(back)], back.body).toEqual([403, 'step_up_required']);
    expect((await mine(adult)).json<MyWordingView>().neutral_wording).toBe('all');
    await confirmed(adult, 'fresh');
    expect((await mine(adult, { neutral_wording: 'health' })).statusCode).toBe(200);
    await confirmed(adult, 'stale');
    await confirmed(owner, 'fresh');
    expect((await household(owner, { neutral_wording: 'all' })).statusCode).toBe(200);
    // Under the household's All, their Health names nothing more: All applies.
    expect((await mine(adult)).json<MyWordingView>()).toEqual({
      neutral_wording: 'health',
      household: 'all',
      in_effect: ['all'],
    });
    // Under All, going back to as the household says names nothing more.
    expect((await mine(teen, { neutral_wording: 'household' })).statusCode).toBe(200);
    expect((await household(owner, { neutral_wording: 'off' })).statusCode).toBe(200);
    // The household made Off: theirs still holds for them.
    expect((await mine(adult)).json<MyWordingView>().in_effect).toEqual(['health']);
    expect((await mine(owner)).json<MyWordingView>()).toEqual({
      neutral_wording: 'household',
      household: 'off',
      in_effect: ['off'],
    });
    // As the household says, under Off: Medical documents named again, asked.
    expect((await mine(adult, { neutral_wording: 'household' })).statusCode).toBe(403);
    await confirmed(adult, 'fresh');
    expect((await mine(adult, { neutral_wording: 'household' })).json<MyWordingView>()).toEqual({
      neutral_wording: 'household',
      household: 'off',
      in_effect: ['off'],
    });
    const stored = await admin.query<{ neutral_wording: string | null }>(
      'select neutral_wording from notification_preference where account_id = $1',
      [await accountOf(adult)],
    );
    expect(stored.rows).toEqual([{ neutral_wording: null }]);
    // Off is no choice of a person's: it would add nothing.
    for (const payload of [{ neutral_wording: 'off' }, {}, { neutral_wording: 'all', x: 1 }]) {
      expect((await mine(adult, payload)).statusCode, JSON.stringify(payload)).toBe(422);
    }
    // Their other preferences are as they were.
    const prefs = await h.app.inject({
      url: '/api/v1/notifications/preferences',
      headers: h.as(teen),
    });
    expect(prefs.json()).toMatchObject({ daily_push: true, weekly_email: true });
    expect((await household(owner, { neutral_wording: 'sensitive' })).statusCode).toBe(200);
  });

  it('the database holds both too, as the vault’s limited role: an owner’s, and each person’s own', async () => {
    const as = async (who: Tokens, role: string) => ({
      accountId: await accountOf(who),
      householdId: who.household_id,
      memberId: who.member_id,
      role,
    });
    const refusal = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: unknown) => (e as Error).message,
      );
    const byAdult = await refusal(
      withPrincipal(h.db, (await as(adult, 'adult')) as never, (trx) =>
        trx
          .updateTable('household')
          .set({ neutral_wording: 'off' })
          .where('id', '=', adult.household_id)
          .execute(),
      ),
    );
    expect(byAdult).toMatch(/only an owner chooses how notifications name documents/);
    // Their own row, as themselves: allowed.
    const ownerAccount = await accountOf(owner);
    expect(
      await refusal(
        withPrincipal(h.db, (await as(owner, 'owner')) as never, (trx) =>
          trx
            .insertInto('notification_preference')
            .values({
              account_id: ownerAccount,
              household_id: owner.household_id,
              neutral_wording: 'all',
            })
            .onConflict((oc) => oc.doNothing())
            .execute(),
        ),
      ),
    ).toBeNull();
    // Somebody else's, whatever the value: theirs to choose.
    for (const value of ['sensitive', null] as const) {
      const other = await refusal(
        withPrincipal(h.db, (await as(adult, 'adult')) as never, (trx) =>
          trx
            .updateTable('notification_preference')
            .set({ neutral_wording: value })
            .where('account_id', '=', ownerAccount)
            .execute(),
        ),
      );
      expect(other, String(value)).toMatch(/for themselves/);
    }
    expect((await mine(owner)).json<MyWordingView>().neutral_wording).toBe('all');
    const viewerAccount = await accountOf(viewer);
    const intoAnothers = await refusal(
      withPrincipal(h.db, (await as(owner, 'owner')) as never, (trx) =>
        trx
          .updateTable('notification_preference')
          .set({ neutral_wording: 'health' })
          .where('account_id', '=', viewerAccount)
          .execute(),
      ),
    );
    expect(intoAnothers).toMatch(/for themselves/);
    const after = await admin.query<{ neutral_wording: string }>(
      'select neutral_wording from household where id = $1',
      [owner.household_id],
    );
    expect(after.rows[0]?.neutral_wording).toBe('sensitive');
    expect((await mine(viewer)).json<MyWordingView>().neutral_wording).toBe('all');

    // Nor taken away by deleting their row: somebody else may not.
    const deleted = await refusal(
      withPrincipal(h.db, (await as(owner, 'owner')) as never, (trx) =>
        trx.deleteFrom('notification_preference').where('account_id', '=', viewerAccount).execute(),
      ),
    );
    expect(deleted).toMatch(/for themselves/);
    expect((await mine(viewer)).json<MyWordingView>().neutral_wording).toBe('all');
    // Their own, they may.
    const own = await refusal(
      withPrincipal(h.db, (await as(viewer, 'viewer')) as never, (trx) =>
        trx.deleteFrom('notification_preference').where('account_id', '=', viewerAccount).execute(),
      ),
    );
    expect(own).toBeNull();
    expect((await mine(viewer)).json<MyWordingView>().neutral_wording).toBe('household');
  });

  it('a row goes with its account by the foreign key’s cascade, whoever is signed in', async () => {
    const gone = (
      await admin.query<{ id: string }>(
        "insert into account (email) values ('leaving-wording@example.test') returning id",
      )
    ).rows[0]?.id as string;
    await admin.query(
      `insert into notification_preference (account_id, household_id, neutral_wording)
       values ($1, $2, 'all')`,
      [gone, owner.household_id],
    );
    // As an account other than theirs: the cascade's own delete passes the guard.
    const asOwner = await accountOf(owner);
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query(
        "select set_config('app.actor', 'account', true), set_config('app.account_id', $1, true)",
        [asOwner],
      );
      await client.query('delete from account where id = $1', [gone]);
      await client.query('commit');
    } finally {
      client.release();
    }
    const left = await admin.query('select 1 from notification_preference where account_id = $1', [
      gone,
    ]);
    expect(left.rows).toEqual([]);
  });
});
