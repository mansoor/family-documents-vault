import { createPool, readAs, remindTurned13, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import { ageOn, localToday, type PersonReminderView, type Role } from '@fdv/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';
import { NO_LONGER_FITS, type CreatedInvitation, type InvitationView } from './invitations.js';
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
    // Said to the invitee, who chose neither the date nor the role.
    expect(errorOf(r)).toMatchObject({ code: 'too_young', message: NO_LONGER_FITS });
    // Nothing was made: they still have no sign-in.
    const members = (await h.app.inject({ url: '/api/v1/members', headers: h.as(owner) })).json<{
      items: MemberView[];
    }>();
    expect(members.items.find((m) => m.id === ray.id)?.has_account).toBe(false);
  });

  it('refuses a role the age does not allow, by either route: from 13 to 17 a teen’s alone, from 18 never a teen’s', async () => {
    await timezone('UTC');
    const today = localToday('UTC');
    const una = await add('Uma', bornYearsBefore(today, 17));
    const vik = await add('Vik', bornYearsBefore(today, 18));
    for (const route of ['invitations', 'member'] as const) {
      for (const role of ['adult', 'owner', 'viewer'] as const) {
        const r = await invite(una.id, { email: `uma-${route}@example.test`, role }, owner, route);
        expect(r.statusCode, `${route} ${role}`).toBe(422);
        expect(errorOf(r)).toMatchObject({
          code: 'role_not_for_age',
          message: 'Uma is under 18, so they can only be invited as a teen.',
        });
        expect(r.json<{ error: { detail: string } }>().error.detail).toBe('role');
      }
      const teenAt18 = await invite(
        vik.id,
        { email: `vik-${route}@example.test`, role: 'teen' },
        owner,
        route,
      );
      expect(teenAt18.statusCode).toBe(422);
      expect(errorOf(teenAt18)).toMatchObject({
        code: 'role_not_for_age',
        message: 'Vik is 18 or over, so they can’t be invited as a teen.',
      });
    }
    // An adult is told the same of a teen's sign-in for somebody grown.
    expect(
      errorOf(await invite(vik.id, { email: 'vik-ada@example.test', role: 'teen' }, adult)).code,
    ).toBe('role_not_for_age');
    // Nothing was made for either.
    const listed = (await h.app.inject({ url: '/api/v1/invitations', headers: h.as(owner) })).json<{
      items: InvitationView[];
    }>();
    expect(listed.items.some((i) => [una.id, vik.id].includes(i.member_id))).toBe(false);
    // The roles their ages allow are made; somebody of no known age, any.
    expect((await invite(una.id, { email: 'uma@example.test', role: 'teen' })).statusCode).toBe(
      201,
    );
    expect((await invite(vik.id, { email: 'vik@example.test', role: 'adult' })).statusCode).toBe(
      201,
    );
    const wes = await add('Wes', null);
    expect((await invite(wes.id, { email: 'wes@example.test', role: 'teen' })).statusCode).toBe(
      201,
    );
  });

  it('refuses to accept an invitation once their date of birth says its role is not for their age', async () => {
    await timezone('UTC');
    const today = localToday('UTC');
    const xan = await add('Xan', bornYearsBefore(today, 16));
    const created = (
      await invite(xan.id, { email: 'xan@example.test', role: 'teen' })
    ).json<CreatedInvitation>();
    await admin.query('update member set date_of_birth = $1 where id = $2', [
      bornYearsBefore(today, 25),
      xan.id,
    ]);
    const r = await accept(created);
    expect(r.statusCode).toBe(422);
    expect(errorOf(r)).toMatchObject({ code: 'role_not_for_age', message: NO_LONGER_FITS });
    const members = (await h.app.inject({ url: '/api/v1/members', headers: h.as(owner) })).json<{
      items: MemberView[];
    }>();
    expect(members.items.find((m) => m.id === xan.id)?.has_account).toBe(false);
  });

  it('a teen’s invitation made at 17 is still accepted once they are 18: the role is judged on the day it was made (INV-1)', async () => {
    await timezone('UTC');
    const today = localToday('UTC');
    const day = (iso: string, n: number) => {
      const t = new Date(`${iso}T00:00:00Z`);
      t.setUTCDate(t.getUTCDate() + n);
      return t.toISOString().slice(0, 10);
    };
    // Invited at 17, as a teen; then five days pass, and they turned 18 on
    // the third — moved back, the invitation's day and their birthday both.
    const yan = await add('Yan', day(bornYearsBefore(today, 18), 2));
    const created = (
      await invite(yan.id, { email: 'yan@example.test', role: 'teen' })
    ).json<CreatedInvitation>();
    expect(created.invitation.role).toBe('teen');
    await admin.query(
      "update invitation set created_at = now() - interval '5 days' where id = $1",
      [created.invitation.id],
    );
    await admin.query('update member set date_of_birth = $1 where id = $2', [
      day(bornYearsBefore(today, 18), -3),
      yan.id,
    ]);
    const joined = await accept(created);
    expect(joined.statusCode, joined.body).toBe(201);
    expect(joined.json<Tokens>()).toMatchObject({ role: 'teen', member_id: yan.id });
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

  // ------------------------------------------------- the review's findings

  it('an invitation run out or used up stands in nobody’s way: an adult replaces an owner’s dead one (INV-2)', async () => {
    await timezone('UTC');
    const today = localToday('UTC');
    for (const [name, dead] of [
      ['Exp', "expires_at = now() - interval '1 day'"],
      ['Lok', 'attempts = 5'],
    ] as const) {
      const m = await add(name, bornYearsBefore(today, 15));
      const first = await invite(m.id, { email: `${name}-1@example.test`, role: 'teen' });
      expect(first.statusCode).toBe(201);
      // While it is live, an adult may not replace an owner's.
      const blocked = await invite(m.id, { email: `${name}-2@example.test`, role: 'teen' }, adult);
      expect(errorOf(blocked).code).toBe('already_invited');
      await admin.query(`update invitation set ${dead} where member_id = $1`, [m.id]);
      const listed = (await h.app.inject({ url: '/api/v1/invitations', headers: h.as(adult) }))
        .json<{ items: InvitationView[] }>()
        .items.filter((i) => i.member_id === m.id);
      expect(listed.map((i) => i.state)).not.toContain('pending');
      const again = await invite(m.id, { email: `${name}-3@example.test`, role: 'teen' }, adult);
      expect(again.statusCode, again.body).toBe(201);
      // Still one live invitation for them: the dead one taken back.
      const live = await admin.query<{ n: number }>(
        `select count(*)::int as n from invitation
          where member_id = $1 and accepted_at is null and revoked_at is null`,
        [m.id],
      );
      expect(live.rows[0]?.n).toBe(1);
    }
  });

  it('a date of birth corrected after the reminder was made takes it away (INV-3)', async () => {
    await timezone('UTC');
    const today = localToday('UTC');
    const typo = await add('Typo', bornYearsBefore(today, 13));
    await admin.query("update member set created_at = now() - interval '1 year' where id = $1", [
      typo.id,
    ]);
    await withSystem(h.db, owner.household_id, (trx) =>
      remindTurned13(trx, owner.household_id, 'UTC', new Date()),
    );
    const listed = async () =>
      (await h.app.inject({ url: '/api/v1/reminders/people', headers: h.as(owner) }))
        .json<{ items: PersonReminderView[] }>()
        .items.filter((r) => r.member_id === typo.id);
    expect(await listed()).toHaveLength(1);
    // Ten, after all: not listed, and the tick is done with it.
    const fixed = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/members/${typo.id}`,
      headers: h.as(owner),
      payload: { date_of_birth: bornYearsBefore(today, 10) },
    });
    expect(fixed.statusCode).toBe(200);
    expect(await listed()).toHaveLength(0);
    await withSystem(h.db, owner.household_id, (trx) =>
      remindTurned13(trx, owner.household_id, 'UTC', new Date()),
    );
    const row = await admin.query<{ status: string }>(
      "select status from reminder where member_id = $1 and kind = 'turned_13'",
      [typo.id],
    );
    expect(row.rows.map((r) => r.status)).toEqual(['resolved']);
    // And with none at all, none either.
    const zed = await add('Zed', bornYearsBefore(today, 13));
    await admin.query("update member set created_at = now() - interval '1 year' where id = $1", [
      zed.id,
    ]);
    await withSystem(h.db, owner.household_id, (trx) =>
      remindTurned13(trx, owner.household_id, 'UTC', new Date()),
    );
    await admin.query('update member set date_of_birth = null where id = $1', [zed.id]);
    const people = (await h.app.inject({ url: '/api/v1/reminders/people', headers: h.as(owner) }))
      .json<{ items: PersonReminderView[] }>()
      .items.map((r) => r.member_id);
    expect(people).not.toContain(zed.id);
  });

  it('a child’s date of birth is an owner’s to change or clear: an adult may not, and so may not invite them by clearing it (INV-6)', async () => {
    await timezone('UTC');
    const today = localToday('UTC');
    const kid = await add('Kid', bornYearsBefore(today, 10));
    const patch = (t: Tokens, date_of_birth: string | null) =>
      h.app.inject({
        method: 'PATCH',
        url: `/api/v1/members/${kid.id}`,
        headers: h.as(t),
        payload: { date_of_birth },
      });
    for (const dob of [null, bornYearsBefore(today, 15)]) {
      const r = await patch(adult, dob);
      expect(r.statusCode).toBe(403);
      expect(errorOf(r)).toMatchObject({
        code: 'child_birthday_owners',
        message: 'Only an owner can change the date of birth of a child under 13.',
      });
    }
    // The probe's way round (P4): cleared by an adult, then invited. Closed.
    const invited = await invite(kid.id, { email: 'kid@example.test', role: 'teen' }, adult);
    expect(errorOf(invited).code).toBe('too_young');
    // An adult still changes the rest of their details, and somebody 13 or over's birthday.
    const renamed = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/members/${kid.id}`,
      headers: h.as(adult),
      payload: { display_name: 'Kiddo' },
    });
    expect(renamed.statusCode).toBe(200);
    const older = await add('Older', bornYearsBefore(today, 15));
    const moved = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/members/${older.id}`,
      headers: h.as(adult),
      payload: { date_of_birth: bornYearsBefore(today, 16) },
    });
    expect(moved.statusCode).toBe(200);
    // An owner may.
    expect((await patch(owner, null)).statusCode).toBe(200);
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
