import { withHousehold } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';
import type { OwnerChangeView, RoleChangeResult } from './co-owners.js';
import type { MemberView } from './service.js';

/**
 * Co-owners (SHR-09, SHR-10).
 *
 * The interesting behaviour is all in the delays and the refusals: what
 * happens immediately, what waits seven days, who is told, and what the
 * database refuses to let the application do at all.
 */
describe.skipIf(!testAdminUrl())('co-owners', () => {
  let h: Harness;
  let owner: Tokens;
  let sam: Tokens;
  let teen: Tokens;
  let members: MemberView[];

  const json = <T>(r: { json: () => unknown }) => r.json() as T;

  const accountId = async (t: Tokens) =>
    json<{ account_id: string }>(await h.app.inject({ url: '/api/v1/me', headers: h.as(t) }))
      .account_id;
  const memberOf = (name: string) => members.find((m) => m.display_name === name) as MemberView;

  const setRole = (as: Tokens, memberId: string, role: string) =>
    h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${memberId}/role`,
      headers: h.as(as),
      payload: { role },
    });

  const requests = async (as: Tokens) =>
    json<{ items: OwnerChangeView[] }>(
      await h.app.inject({ url: '/api/v1/owner-changes', headers: h.as(as) }),
    ).items;

  /** The alerts the API asked the worker to deliver, newest last. */
  const alerts = () =>
    h.jobs
      .filter((j) => j.name === 'alert.send')
      .map((j) => j.data as { subject: string; account_ids: string[] });

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();
    sam = await h.join(owner, { name: 'Sam', email: 'sam@example.test', role: 'adult' });
    teen = await h.join(owner, { name: 'Aisha', email: 'aisha@example.test', role: 'teen' });
    members = json<{ items: MemberView[] }>(
      await h.app.inject({ url: '/api/v1/members', headers: h.as(owner) }),
    ).items;
  }, 90_000);
  afterAll(() => h.close());

  it('promoting an adult is immediate, and every other adult is told', async () => {
    const before = alerts().length;
    const res = await setRole(owner, memberOf('Sam').id, 'owner');
    expect(res.statusCode).toBe(200);
    expect(json<RoleChangeResult>(res)).toMatchObject({ applied: true, role: 'owner' });

    // The token Sam is already holding says "adult", and the promotion
    // still takes effect at once: the role is read from the household on
    // every request, not from a token that lasts fifteen minutes.
    expect(sam.role).toBe('adult');
    expect(
      json<{ role: string }>(await h.app.inject({ url: '/api/v1/me', headers: h.as(sam) })).role,
    ).toBe('owner');

    const told = alerts().slice(before);
    expect(told).toHaveLength(1);
    expect(told[0]?.subject).toBe('Sam is now an owner');
    // Sam is told; the owner who did it is not.
    expect(told[0]?.account_ids).toEqual([await accountId(sam)]);
  });

  it('a teen cannot promote anybody, and nobody can promote themselves', async () => {
    expect((await setRole(teen, memberOf('Sam').id, 'owner')).statusCode).toBe(403);
    const self = await setRole(owner, memberOf('Owner').id, 'adult');
    expect(self.statusCode).toBe(422);
    expect(json<{ error: { message: string } }>(self).error.message).toMatch(/another owner/);
  });

  it('taking the owner role off somebody else does not happen today', async () => {
    const before = alerts().length;
    const res = await setRole(owner, memberOf('Sam').id, 'adult');
    expect(res.statusCode).toBe(200);
    const body = json<RoleChangeResult>(res);
    expect(body.applied).toBe(false);
    expect(body.role).toBe('owner');
    expect(body.message).toMatch(/can refuse before then/);

    // Seven days, to the day.
    const request = body.request as OwnerChangeView;
    const days = (Date.parse(request.opens_at) - Date.parse(request.requested_at)) / 864e5;
    expect(Math.round(days)).toBe(7);
    expect(request.state).toBe('waiting');

    // Sam is still an owner, and can still do everything an owner does.
    expect(
      (
        await h.app.inject({
          url: '/api/v1/invitations',
          headers: h.as(sam),
        })
      ).statusCode,
    ).toBe(200);

    // Every owner hears about it, including the person it is about.
    const told = alerts().slice(before);
    expect(told).toHaveLength(1);
    expect(told[0]?.subject).toMatch(/take away Sam's owner role/);
  });

  it('asking twice does not start the clock again', async () => {
    const second = await setRole(owner, memberOf('Sam').id, 'adult');
    expect(second.statusCode).toBe(409);
    expect(json<{ error: { code: string } }>(second).error.code).toBe('already_requested');
  });

  it('the notice period is not a formality: it cannot be carried out early', async () => {
    const pending = (await requests(owner)).find((r) => r.state === 'waiting') as OwnerChangeView;
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/owner-changes/${pending.id}/complete`,
      headers: h.as(owner),
    });
    expect(res.statusCode).toBe(409);
    expect(json<{ error: { code: string } }>(res).error.code).toBe('notice_period');
  });

  it('the person it is about sees it, in words, and can refuse it', async () => {
    const mine = (await requests(sam)).find((r) => r.state === 'waiting') as OwnerChangeView;
    expect(mine.about_me).toBe(true);
    expect(mine.summary).toMatch(/you can refuse before then/);

    const refused = await h.app.inject({
      method: 'POST',
      url: `/api/v1/owner-changes/${mine.id}/refuse`,
      headers: h.as(sam),
    });
    expect(refused.statusCode).toBe(200);
    expect(json<OwnerChangeView>(refused).state).toBe('refused');

    // And that is the end of it: Sam is still an owner.
    const after = json<{ items: MemberView[] }>(
      await h.app.inject({ url: '/api/v1/members', headers: h.as(owner) }),
    ).items;
    expect(after.find((m) => m.display_name === 'Sam')?.role).toBe('owner');
  });

  it('nobody else can refuse on their behalf', async () => {
    const asked = await setRole(owner, memberOf('Sam').id, 'adult');
    const request = json<RoleChangeResult>(asked).request as OwnerChangeView;
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/owner-changes/${request.id}/refuse`,
      headers: h.as(owner),
    });
    expect(res.statusCode).toBe(403);
    expect(json<{ error: { message: string } }>(res).error.message).toMatch(/withdraw/);
  });

  it('once the seven days are up, an owner still has to mean it', async () => {
    const pending = (await requests(owner)).find((r) => r.state === 'waiting') as OwnerChangeView;
    // Wind the clock back rather than forward: the same thing, and it
    // leaves `lapses_at` in the future where it belongs.
    await withHousehold(h.db, owner.household_id, (trx) =>
      trx
        .updateTable('owner_change_request')
        .set({ opens_at: new Date(Date.now() - 1000) })
        .where('id', '=', pending.id)
        .execute(),
    );
    expect((await requests(owner)).find((r) => r.id === pending.id)?.state).toBe('ready');

    const before = alerts().length;
    const done = await h.app.inject({
      method: 'POST',
      url: `/api/v1/owner-changes/${pending.id}/complete`,
      headers: h.as(owner),
    });
    expect(done.statusCode).toBe(200);
    expect(json<RoleChangeResult>(done)).toMatchObject({ applied: true, role: 'adult' });

    const after = json<{ items: MemberView[] }>(
      await h.app.inject({ url: '/api/v1/members', headers: h.as(owner) }),
    ).items;
    expect(after.find((m) => m.display_name === 'Sam')?.role).toBe('adult');

    // Sam is told, and told what has not changed.
    const told = alerts().slice(before);
    expect(told[0]?.subject).toMatch(/no longer an owner/);
  });

  it('the last owner cannot be demoted, and the database is the one that says so', async () => {
    // Sam is an adult again, so the household is down to one owner.
    const me = memberOf('Owner');
    await expect(
      withHousehold(h.db, owner.household_id, (trx) =>
        trx
          .updateTable('account_household')
          .set({ role: 'adult' })
          .where('member_id', '=', me.id)
          .execute(),
      ),
    ).rejects.toThrow(/at least one owner/);

    // Stepping down is refused for the same reason, with the database's
    // guarantee behind the application's manners.
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/step-down',
      headers: h.as(owner),
      payload: { role: 'adult' },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('an owner can step down once there is another one', async () => {
    await setRole(owner, memberOf('Sam').id, 'owner');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/step-down',
      headers: h.as(owner),
      payload: { role: 'adult' },
    });
    expect(res.statusCode).toBe(200);
    expect(json<RoleChangeResult>(res).message).toMatch(/give the role back/);
  });

  it('removing a sign-in ends their sessions and leaves the person and the papers', async () => {
    const before = json<{ items: MemberView[] }>(
      await h.app.inject({ url: '/api/v1/members', headers: h.as(sam) }),
    ).items;
    expect(before.find((m) => m.display_name === 'Aisha')?.has_account).toBe(true);

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/members/${memberOf('Aisha').id}/sign-in`,
      headers: h.as(sam),
    });
    expect(res.statusCode).toBe(204);

    // The person stays; only the way in is gone.
    const after = json<{ items: MemberView[] }>(
      await h.app.inject({ url: '/api/v1/members', headers: h.as(sam) }),
    ).items;
    expect(after.find((m) => m.display_name === 'Aisha')).toMatchObject({
      has_account: false,
      role: null,
    });

    // Their session stops working on the next refresh, not eventually.
    const refreshed = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refresh_token: teen.refresh_token },
    });
    expect(refreshed.statusCode).toBe(401);
  });

  it('an owner cannot be removed outright — that is what the notice is for', async () => {
    // Sam, the only owner at this point, gives the role back.
    expect((await setRole(sam, memberOf('Owner').id, 'owner')).statusCode).toBe(200);

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/members/${memberOf('Owner').id}/sign-in`,
      headers: h.as(sam),
    });
    expect(res.statusCode).toBe(409);
    expect(json<{ error: { code: string } }>(res).error.code).toBe('owner_notice_required');
  });

  it('every one of these is in the audit chain', async () => {
    const rows = await withHousehold(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('audit_event')
        .select(['action'])
        .where((eb) =>
          eb.or([
            eb('action', 'like', 'owner_change.%'),
            eb('action', 'like', 'member.role_%'),
            eb('action', 'like', 'member.stepped_%'),
            eb('action', 'like', 'member.sign_in_%'),
          ]),
        )
        .orderBy('id')
        .execute(),
    );
    expect(new Set(rows.map((r) => r.action))).toEqual(
      new Set([
        'member.role_changed',
        'owner_change.requested',
        'owner_change.refused',
        'member.stepped_down',
        'member.sign_in_removed',
      ]),
    );
  });
  /**
   * Found by running it: an owner asked for the other one to be demoted
   * and then stepped down, leaving one owner under notice. Seven days
   * later the trigger would have refused, and whoever pressed the button
   * would have got a failed transaction instead of a sentence.
   */
  it('a request that would leave no owner is refused in words, not by the trigger', async () => {
    // Two owners at this point: Sam and the original owner.
    const asked = await setRole(sam, memberOf('Owner').id, 'adult');
    expect(asked.statusCode).toBe(200);
    const request = json<RoleChangeResult>(asked).request as OwnerChangeView;

    // Sam steps down in the meantime, leaving one owner — the one the
    // request is about.
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: '/api/v1/me/step-down',
          headers: h.as(sam),
          payload: { role: 'adult' },
        })
      ).statusCode,
    ).toBe(200);

    await withHousehold(h.db, owner.household_id, (trx) =>
      trx
        .updateTable('owner_change_request')
        .set({ opens_at: new Date(Date.now() - 1000) })
        .where('id', '=', request.id)
        .execute(),
    );
    const done = await h.app.inject({
      method: 'POST',
      url: `/api/v1/owner-changes/${request.id}/complete`,
      headers: h.as(owner),
    });
    expect(done.statusCode).toBe(409);
    const err = json<{ error: { code: string; message: string } }>(done).error;
    expect(err.code).toBe('last_owner');
    expect(err.message).toMatch(/Make somebody else an owner first/);

    // The household still has its owner, and the database never had to
    // say no.
    const after = json<{ items: MemberView[] }>(
      await h.app.inject({ url: '/api/v1/members', headers: h.as(owner) }),
    ).items;
    expect(after.filter((m) => m.role === 'owner')).toHaveLength(1);
  });
});

/**
 * A request nobody carried out lapses after thirty days. Until 0.4.6 a
 * lapsed request stayed "live": it kept its place in the one-live-request
 * index, the People screen no longer showed it (so it could not be
 * withdrawn), and asking again was refused with "somebody has already
 * asked for this" — for ever.
 */
describe.skipIf(!testAdminUrl())('a request nobody carried out', () => {
  let h: Harness;
  let owner: Tokens;
  let sam: Tokens;
  let samMember = '';

  const json = <T>(r: { json: () => unknown }) => r.json() as T;
  const ask = () =>
    h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${samMember}/role`,
      headers: h.as(owner),
      payload: { role: 'adult' },
    });
  const requests = async () =>
    json<{ items: OwnerChangeView[] }>(
      await h.app.inject({ url: '/api/v1/owner-changes', headers: h.as(owner) }),
    ).items;
  const act = (as: Tokens, id: string, what: 'refuse' | 'complete' | 'withdraw') =>
    h.app.inject({
      method: what === 'withdraw' ? 'DELETE' : 'POST',
      url:
        what === 'withdraw' ? `/api/v1/owner-changes/${id}` : `/api/v1/owner-changes/${id}/${what}`,
      headers: h.as(as),
    });
  const code = (r: { json: () => unknown }) => json<{ error: { code: string } }>(r).error.code;
  const askedAlerts = () =>
    h.jobs.filter(
      (j) =>
        j.name === 'alert.send' &&
        /take away Sam's owner role/.test((j.data as { subject: string }).subject),
    ).length;
  /** Thirty-one days ago, as far as this request is concerned. */
  const lapse = (id: string) =>
    withHousehold(h.db, owner.household_id, (trx) =>
      trx
        .updateTable('owner_change_request')
        .set({
          requested_at: new Date(Date.now() - 31 * 864e5),
          opens_at: new Date(Date.now() - 24 * 864e5),
          lapses_at: new Date(Date.now() - 864e5),
        })
        .where('id', '=', id)
        .execute(),
    );

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();
    sam = await h.join(owner, { name: 'Sam', email: 'sam-lapse@example.test', role: 'adult' });
    const members = json<{ items: MemberView[] }>(
      await h.app.inject({ url: '/api/v1/members', headers: h.as(owner) }),
    ).items;
    samMember = members.find((m) => m.display_name === 'Sam')?.id as string;
    const promoted = await h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${samMember}/role`,
      headers: h.as(owner),
      payload: { role: 'owner' },
    });
    expect(promoted.statusCode).toBe(200);
  }, 90_000);
  afterAll(() => h.close());

  it('lapses, and can then be asked again, with the full notice and everybody told', async () => {
    const first = json<RoleChangeResult>(await ask()).request as OwnerChangeView;
    expect(first.state).toBe('waiting');
    await lapse(first.id);

    const seen = (await requests()).find((r) => r.id === first.id);
    expect(seen?.state).toBe('lapsed');
    expect(seen?.summary).toMatch(/no longer counts/);

    const toldBefore = askedAlerts();
    const again = await ask();
    expect(again.statusCode).toBe(200);
    const second = json<RoleChangeResult>(again).request as OwnerChangeView;
    expect(second.id).not.toBe(first.id);
    expect(second.state).toBe('waiting');
    const days = (Date.parse(second.opens_at) - Date.parse(second.requested_at)) / 864e5;
    expect(Math.round(days)).toBe(7);
    expect(askedAlerts()).toBe(toldBefore + 1);

    // The old one is recorded as lapsed, and stays in the history as that.
    const old = await withHousehold(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('owner_change_request')
        .select(['lapsed_at', 'lapses_at', 'refused_at'])
        .where('id', '=', first.id)
        .executeTakeFirstOrThrow(),
    );
    expect(old.lapsed_at?.getTime()).toBe(old.lapses_at.getTime());
    expect(old.refused_at).toBeNull();
    expect((await requests()).map((r) => r.state)).toEqual(['waiting', 'lapsed']);

    // A live request still stops a second one: asking twice does not start
    // the clock again.
    const third = await ask();
    expect(third.statusCode).toBe(409);
    expect(code(third)).toBe('already_requested');
  });

  it('a lapsed request cannot be refused, withdrawn or carried out', async () => {
    const live = (await requests()).find((r) => r.state === 'waiting') as OwnerChangeView;
    await lapse(live.id);
    for (const [as, what] of [
      [sam, 'refuse'],
      [owner, 'withdraw'],
      [owner, 'complete'],
    ] as const) {
      const res = await act(as, live.id, what);
      expect(res.statusCode, what).toBe(409);
      expect(code(res), what).toBe('request_lapsed');
    }
    // Sam is still an owner: a lapsed request changes nothing.
    const me = json<{ role: string }>(
      await h.app.inject({ url: '/api/v1/me', headers: h.as(sam) }),
    );
    expect(me.role).toBe('owner');
  });

  it('two owners asking at the same moment get one request, and the other a sentence', async () => {
    // Clear the way: the last one lapsed, and asking again records that.
    const results = await Promise.all([ask(), ask()]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const refused = results.find((r) => r.statusCode === 409);
    expect(code(refused as { json: () => unknown })).toBe('already_requested');
    expect((await requests()).filter((r) => r.state === 'waiting')).toHaveLength(1);
  });

  it('a request that loses the race at the database is told in words too', async () => {
    // The test above races on the lapse it records, so the loser stops at
    // the check. Here there is nothing to lapse: another request, not yet
    // committed, holds the place, the check cannot see it, and the insert
    // is what the database refuses.
    const live = (await requests()).find((r) => r.state === 'waiting') as OwnerChangeView;
    expect((await act(owner, live.id, 'withdraw')).statusCode).toBe(204);

    const hold = new pg.Client({ connectionString: h.adminUrl });
    await hold.connect();
    try {
      await hold.query('begin');
      await hold.query(
        `insert into owner_change_request
           (household_id, target_account, requested_by, action, opens_at, lapses_at)
         select household_id, account_id, account_id, 'demote',
                now() + interval '7 days', now() + interval '30 days'
           from account_household where member_id = $1`,
        [samMember],
      );
      const pending = ask();
      // Wait until the ask is blocked behind the held insert, then let it go.
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        const { rows } = await hold.query<{ n: number }>(
          `select count(*)::int as n from pg_stat_activity
            where pg_backend_pid() = any(pg_blocking_pids(pid))`,
        );
        blocked = (rows[0]?.n ?? 0) > 0;
        if (!blocked) await new Promise((r) => setTimeout(r, 50));
      }
      expect(blocked).toBe(true);
      await hold.query('commit');
      const res = await pending;
      expect(res.statusCode).toBe(409);
      expect(code(res)).toBe('already_requested');
    } finally {
      await hold.end();
    }
  });
});
