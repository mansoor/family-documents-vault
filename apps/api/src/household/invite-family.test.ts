import { createPool, readAs, remindTurned13, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import { ageOn, localToday, type PersonReminderView, type Role } from '@fdv/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';
import type { CreatedInvitation, InvitationView } from './invitations.js';
import type { MemberView } from './service.js';

/**
 * Inviting family members to sign up (after 0.7.0). The web offers an
 * invitation as somebody is added, from their page, and on Invite's "Who
 * is it for?"; each is an invitation for somebody already in the vault
 * (`member_id`), as the API has taken since SHR-02. What the API adds:
 *
 * - nobody under 13 by their date of birth, on the household's calendar,
 *   is invited (`422 too_young`) — nor accepts one made before their date
 *   of birth was changed;
 * - the owners' reminders that somebody has turned 13: listed for an owner
 *   (`GET /reminders/people`), dismissed by one, and nobody else's.
 *
 * What it keeps is tried here too, for somebody already in the vault: the
 * role the invitation gives is the one asked; an adult hands out no role
 * wider than today; one live invitation for each person.
 */
describe.skipIf(!testAdminUrl())('inviting family members to sign up', () => {
  let h: Harness;
  let owner: Tokens;
  let adult: Tokens;
  let teen: Tokens;
  let viewer: Tokens;
  let admin: ReturnType<typeof createPool>;
  let nth = 0;

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();
    adult = await h.join(owner, { name: 'Ada', email: 'ada@example.test', role: 'adult' });
    teen = await h.join(owner, { name: 'Tia', email: 'tia@example.test', role: 'teen' });
    viewer = await h.join(owner, { name: 'Vic', email: 'vic@example.test', role: 'viewer' });
    admin = createPool(h.adminUrl, 1);
  }, 60_000);
  afterAll(async () => {
    await admin.end();
    await h.close();
  });

  const timezone = async (tz: string) => {
    await admin.query('update household set timezone = $1 where id = $2', [tz, owner.household_id]);
  };

  /** The day somebody born `years` before `today` was born; the 28th for a 29 February. */
  const bornYearsBefore = (today: string, years: number): string => {
    const [y, m, d] = today.split('-').map(Number) as [number, number, number];
    const last = new Date(Date.UTC(y - years, m, 0)).getUTCDate();
    const day = Math.min(d, last);
    return `${y - years}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  };
  const dayAfter = (iso: string) => {
    const t = new Date(`${iso}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + 1);
    return t.toISOString().slice(0, 10);
  };

  const add = async (name: string, dob: string | null): Promise<MemberView> => {
    const r = await h.app.inject({
      method: 'POST',
      url: '/api/v1/members',
      headers: h.as(owner),
      payload: { display_name: name, date_of_birth: dob },
    });
    expect(r.statusCode).toBe(201);
    return r.json<MemberView>();
  };

  /** An invitation for somebody already in the vault, by either route. */
  const invite = async (
    memberId: string,
    body: { email: string; role: Role; restriction?: unknown },
    as: Tokens = owner,
    route: 'invitations' | 'member' = 'invitations',
  ) => {
    if (as === owner) await h.decider(owner);
    return route === 'invitations'
      ? h.app.inject({
          method: 'POST',
          url: '/api/v1/invitations',
          headers: h.as(as),
          payload: { member_id: memberId, ...body },
        })
      : h.app.inject({
          method: 'POST',
          url: `/api/v1/members/${memberId}/invite`,
          headers: h.as(as),
          payload: body,
        });
  };

  const accept = (created: CreatedInvitation, password = 'a long enough password') =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      payload: { token: created.link_token, code: created.code, password },
      remoteAddress: `10.77.0.${++nth}`,
    });

  const errorOf = (r: { json: () => unknown }) =>
    (r.json() as { error: { code: string; message: string } }).error;

  // ------------------------------------------------------------ the age guard

  it('refuses an invitation for somebody under 13, by either route, and says why', async () => {
    await timezone('UTC');
    const today = localToday('UTC');
    const sam = await add('Sam', dayAfter(bornYearsBefore(today, 13)));
    expect(ageOn(sam.date_of_birth, today)).toBe(12);
    for (const route of ['invitations', 'member'] as const) {
      const r = await invite(
        sam.id,
        { email: `sam-${route}@example.test`, role: 'teen' },
        owner,
        route,
      );
      expect(r.statusCode).toBe(422);
      expect(errorOf(r)).toMatchObject({
        code: 'too_young',
        message:
          'Sam is under 13, so they can’t have a sign-in of their own yet. They can be invited once they turn 13.',
      });
    }
    // An adult, who may invite a teen, is told the same.
    const byAdult = await invite(sam.id, { email: 'sam-ada@example.test', role: 'teen' }, adult);
    expect(errorOf(byAdult).code).toBe('too_young');
    // And nothing was made: no invitation for Sam is waiting.
    const listed = (await h.app.inject({ url: '/api/v1/invitations', headers: h.as(owner) })).json<{
      items: InvitationView[];
    }>();
    expect(listed.items.some((i) => i.member_id === sam.id)).toBe(false);
  });

  it('invites somebody 13 today as a teen, and somebody 18 as an adult; somebody of no known age as asked', async () => {
    await timezone('UTC');
    const today = localToday('UTC');
    const jo = await add('Jo', bornYearsBefore(today, 13));
    const kim = await add('Kim', bornYearsBefore(today, 18));
    const lee = await add('Lee', null);
    const made = await invite(jo.id, { email: 'jo@example.test', role: 'teen' });
    expect(made.statusCode).toBe(201);
    const grown = await invite(kim.id, { email: 'kim@example.test', role: 'adult' });
    expect(grown.statusCode).toBe(201);
    expect((await invite(lee.id, { email: 'lee@example.test', role: 'adult' })).statusCode).toBe(
      201,
    );
  });

  it('works the age out on the household’s calendar, not the server’s', async () => {
    // Kiritimati is UTC+14 and Pago Pago UTC−11: at any moment Kiritimati's
    // day is one or two ahead. Born 13 years before Kiritimati's today, Mo
    // is 13 there and 12 in Pago Pago — and in UTC on one side of the day
    // or the other, so a guard on the server's own clock fails one of these.
    const there = localToday('Pacific/Kiritimati');
    const mo = await add('Mo', bornYearsBefore(there, 13));
    expect(ageOn(mo.date_of_birth, localToday('Pacific/Pago_Pago'))).toBe(12);
    await timezone('Pacific/Pago_Pago');
    const young = await invite(mo.id, { email: 'mo@example.test', role: 'teen' });
    expect(errorOf(young).code).toBe('too_young');
    await timezone('Pacific/Kiritimati');
    expect((await invite(mo.id, { email: 'mo@example.test', role: 'teen' })).statusCode).toBe(201);
    await timezone('UTC');
  });

  it('refuses to accept an invitation once their date of birth says they are under 13', async () => {
    await timezone('UTC');
    const today = localToday('UTC');
    const ray = await add('Ray', bornYearsBefore(today, 14));
    const created = (
      await invite(ray.id, { email: 'ray@example.test', role: 'teen' })
    ).json<CreatedInvitation>();
    await admin.query('update member set date_of_birth = $1 where id = $2', [
      bornYearsBefore(today, 10),
      ray.id,
    ]);
    const r = await accept(created);
    expect(r.statusCode).toBe(422);
    expect(errorOf(r).code).toBe('too_young');
    // Nothing was made: they still have no sign-in.
    const members = (await h.app.inject({ url: '/api/v1/members', headers: h.as(owner) })).json<{
      items: MemberView[];
    }>();
    expect(members.items.find((m) => m.id === ray.id)?.has_account).toBe(false);
  });

  // ------------------------------------------------- what is kept, for a member

  it('inviting somebody already in the vault gives them the role it asked, and nobody new', async () => {
    const today = localToday('UTC');
    const before = (await h.app.inject({ url: '/api/v1/members', headers: h.as(owner) })).json<{
      items: MemberView[];
    }>().items.length;
    const zoe = await add('Zoe', bornYearsBefore(today, 15));
    const created = (
      await invite(zoe.id, { email: 'zoe@example.test', role: 'teen' })
    ).json<CreatedInvitation>();
    expect(created.invitation).toMatchObject({ member_id: zoe.id, role: 'teen', state: 'pending' });
    const joined = await accept(created);
    expect(joined.statusCode).toBe(201);
    expect(joined.json<Tokens>()).toMatchObject({ role: 'teen', member_id: zoe.id });
    const after = (await h.app.inject({ url: '/api/v1/members', headers: h.as(owner) })).json<{
      items: MemberView[];
    }>().items;
    // Zoe herself, and nobody else made.
    expect(after).toHaveLength(before + 1);
    expect(after.find((m) => m.id === zoe.id)).toMatchObject({ has_account: true, role: 'teen' });
  });

  it('an adult hands out no role wider than they may: a viewer, limited; never an adult or an owner', async () => {
    const today = localToday('UTC');
    const pat = await add('Pat', bornYearsBefore(today, 30));
    for (const role of ['adult', 'owner'] as const) {
      const r = await invite(pat.id, { email: 'pat@example.test', role }, adult);
      expect(r.statusCode).toBe(403);
    }
    // A viewer with no limits is only an owner's to give (A27).
    const open = await invite(pat.id, { email: 'pat@example.test', role: 'viewer' }, adult);
    expect(open.statusCode).toBe(403);
    const limited = await invite(
      pat.id,
      {
        email: 'pat@example.test',
        role: 'viewer',
        restriction: { people: [pat.id], types: [], collections: [] },
      },
      adult,
    );
    expect(limited.statusCode).toBe(201);
    expect(limited.json<CreatedInvitation>().invitation).toMatchObject({
      role: 'viewer',
      limited: true,
    });
  });

  it('one live invitation for each person: another replaces the first, and an adult may not replace an owner’s', async () => {
    const today = localToday('UTC');
    const max = await add('Max', bornYearsBefore(today, 16));
    const first = (
      await invite(max.id, { email: 'max@example.test', role: 'teen' })
    ).json<CreatedInvitation>();
    const second = (
      await invite(max.id, { email: 'max2@example.test', role: 'teen' }, owner, 'member')
    ).json<CreatedInvitation>();
    const live = await admin.query<{ n: number }>(
      `select count(*)::int as n from invitation
        where member_id = $1 and accepted_at is null and revoked_at is null`,
      [max.id],
    );
    expect(live.rows[0]?.n).toBe(1);
    expect(second.invitation.id).not.toBe(first.invitation.id);
    expect((await accept(first)).statusCode).toBe(404);
    const byAdult = await invite(max.id, { email: 'max3@example.test', role: 'teen' }, adult);
    expect(byAdult.statusCode).toBe(409);
    expect(errorOf(byAdult).code).toBe('already_invited');
  });

  // ------------------------------------------ who is told, and of what (R4 + 0066)

  it('what the web works out who has no sign-in from is given only to those who may invite', async () => {
    const today = localToday('UTC');
    const una = await add('Una', bornYearsBefore(today, 20));
    // Owners and adults are given the invitations and the birthdays.
    for (const t of [owner, adult]) {
      expect(
        (await h.app.inject({ url: '/api/v1/invitations', headers: h.as(t) })).statusCode,
      ).toBe(200);
      const m = (await h.app.inject({ url: '/api/v1/members', headers: h.as(t) }))
        .json<{ items: MemberView[] }>()
        .items.find((x) => x.id === una.id);
      expect(m?.date_of_birth).toBe(una.date_of_birth);
    }
    // A teen and a viewer are not given who has been invited; a viewer, no birthday.
    for (const t of [teen, viewer]) {
      expect(
        (await h.app.inject({ url: '/api/v1/invitations', headers: h.as(t) })).statusCode,
      ).toBe(403);
    }
    const seen = (await h.app.inject({ url: '/api/v1/members', headers: h.as(viewer) }))
      .json<{ items: MemberView[] }>()
      .items.find((x) => x.id === una.id);
    expect(seen?.date_of_birth).toBeNull();
  });

  it('the turning-13 reminder: an owner’s alone, listed while they may sign up, and dismissed once', async () => {
    await timezone('UTC');
    const today = localToday('UTC');
    const ivy = await add('Ivy', bornYearsBefore(today, 13));
    const ned = await add('Ned', bornYearsBefore(today, 13));
    // In the vault since last year: the reminder is for somebody turning 13
    // while they are in it.
    await admin.query(
      "update member set created_at = now() - interval '1 year' where id = any($1::uuid[])",
      [[ivy.id, ned.id]],
    );
    const made = await withSystem(h.db, owner.household_id, (trx) =>
      remindTurned13(trx, owner.household_id, 'UTC', new Date()),
    );
    expect(made).toBeGreaterThanOrEqual(2);
    const list = async (t: Tokens) =>
      h.app.inject({ url: '/api/v1/reminders/people', headers: h.as(t) });

    // Nobody but an owner: refused, and the database gives them none.
    for (const t of [adult, teen, viewer]) {
      const r = await list(t);
      expect(r.statusCode).toBe(403);
      expect(r.body).not.toContain('Ivy');
    }
    const account = await admin.query<{ account_id: string }>(
      'select account_id from account_household where member_id = $1',
      [adult.member_id],
    );
    const asAdult = await withSystem(h.db, owner.household_id, (trx) =>
      readAs(
        trx,
        {
          accountId: account.rows[0]?.account_id as string,
          memberId: adult.member_id,
          role: 'adult',
        },
        (as) => as.selectFrom('reminder').select('id').where('kind', '=', 'turned_13').execute(),
      ),
    );
    expect(asAdult).toHaveLength(0);

    const theirs = (await list(owner)).json<{ items: PersonReminderView[] }>().items;
    expect(
      theirs
        .filter((r) => [ivy.id, ned.id].includes(r.member_id))
        .sort((a, b) => a.display_name.localeCompare(b.display_name)),
    ).toEqual([
      expect.objectContaining({
        kind: 'turned_13',
        member_id: ivy.id,
        display_name: 'Ivy',
        fire_at: today,
        title: 'Ivy is 13 today',
        label: 'They can now have their own sign-in.',
      }),
      expect.objectContaining({ member_id: ned.id, title: 'Ned is 13 today' }),
    ]);

    // Ned is invited: no longer listed, though nothing was dismissed.
    expect((await invite(ned.id, { email: 'ned@example.test', role: 'teen' })).statusCode).toBe(
      201,
    );
    const now = (await list(owner)).json<{ items: PersonReminderView[] }>().items;
    expect(now.map((r) => r.member_id)).toContain(ivy.id);
    expect(now.map((r) => r.member_id)).not.toContain(ned.id);

    // An adult may not dismiss it; an owner may, once.
    const ivys = now.find((r) => r.member_id === ivy.id) as PersonReminderView;
    const dismiss = (t: Tokens) =>
      h.app.inject({
        method: 'POST',
        url: `/api/v1/reminders/people/${ivys.id}/dismiss`,
        headers: h.as(t),
      });
    expect((await dismiss(adult)).statusCode).toBe(403);
    expect((await dismiss(owner)).statusCode).toBe(204);
    expect((await dismiss(owner)).statusCode).toBe(404);
    expect(
      (await list(owner)).json<{ items: PersonReminderView[] }>().items.map((r) => r.member_id),
    ).not.toContain(ivy.id);
    // And it is not made again.
    await withSystem(h.db, owner.household_id, (trx) =>
      remindTurned13(trx, owner.household_id, 'UTC', new Date()),
    );
    expect(
      (await list(owner)).json<{ items: PersonReminderView[] }>().items.map((r) => r.member_id),
    ).not.toContain(ivy.id);
    // A reminder about a document is not one of these: the documents' own
    // route does not find it.
    const ack = await h.app.inject({
      method: 'POST',
      url: `/api/v1/reminders/${ivys.id}/acknowledge`,
      headers: h.as(owner),
    });
    expect(ack.statusCode).toBe(404);
    const docs = (
      await h.app.inject({ url: '/api/v1/reminders?state=all', headers: h.as(owner) })
    ).json<{ items: Array<{ id: string }> }>();
    expect(docs.items.map((r) => r.id)).not.toContain(ivys.id);
  });
});
