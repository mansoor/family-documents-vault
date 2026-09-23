import { withHousehold } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
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
