import { createPool, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  DECEASED_REFUSAL,
  DETAILS_REFUSAL,
  refusalFor,
  type ActivityLine,
  type MemberAccount,
} from '@fdv/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SoftwareAuthenticator } from '../auth/passkey-test-authenticator.js';
import type { Tokens } from '../auth/service.js';
import { codeFor } from '../auth/totp.js';
import { createHarness, type Harness } from '../test-harness.js';
import type { MemberView } from './service.js';

/**
 * A person's details, changed (5.25): by whoever may change them (A66), made
 * to the person as the changer saw them, and that somebody has passed away
 * by an owner alone, who confirms it is them.
 */

const json = <T>(r: { json: () => unknown }) => r.json() as T;
type Res = Awaited<ReturnType<Harness['app']['inject']>>;
const code = (r: Res) =>
  json<{ error: { code: string; message: string; action?: string } }>(r).error;

describe.skipIf(!testAdminUrl())("changing a person's details (5.25)", () => {
  let h: Harness;
  let owner: Tokens;
  let adult: Tokens;
  let teen: Tokens;
  let viewer: Tokens;
  let child: string;
  let grandad: string;

  const members = async (who: Tokens) =>
    json<{ items: MemberView[] }>(
      await h.app.inject({ url: '/api/v1/members', headers: h.as(who) }),
    ).items;
  const person = async (who: Tokens, id: string) =>
    (await members(who)).find((m) => m.id === id) as MemberView;
  const edit = (who: Tokens, id: string, payload: Record<string, unknown>, ifMatch?: string) =>
    h.app.inject({
      method: 'PATCH',
      url: `/api/v1/members/${id}`,
      headers: { ...h.as(who), ...(ifMatch !== undefined ? { 'if-match': ifMatch } : {}) },
      payload,
    });
  const activity = async () =>
    json<{ items: ActivityLine[] }>(
      await h.app.inject({ url: '/api/v1/audit?limit=100', headers: h.as(owner) }),
    ).items;
  /** The session's last credential, and its last passkey or code, long enough ago to ask again. */
  const goStale = (who: Tokens) =>
    withSystem(h.db, who.household_id, (trx) =>
      trx
        .updateTable('session')
        .set({
          verified_at: new Date(Date.now() - 10 * 60 * 1000),
          factor_verified_at: new Date(Date.now() - 10 * 60 * 1000),
        })
        .where('account_id', '=', (eb) =>
          eb
            .selectFrom('account_household')
            .select('account_id')
            .where('member_id', '=', who.member_id),
        )
        .execute(),
    );
  const stepUp = (who: Tokens, payload: Record<string, unknown>) =>
    h.app.inject({ method: 'POST', url: '/api/v1/auth/step-up', headers: h.as(who), payload });

  beforeAll(async () => {
    // Many signed-in calls from one address.
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    owner = await h.setup();
    adult = await h.join(owner, {
      name: 'Sara Khan',
      email: 'sara-525@example.test',
      role: 'adult',
    });
    teen = await h.join(owner, {
      name: 'Tariq Khan',
      email: 'tariq-525@example.test',
      role: 'teen',
    });
    viewer = await h.join(owner, {
      name: 'The Accountant',
      email: 'acc-525@example.test',
      role: 'viewer',
    });
    const add = async (payload: Record<string, unknown>) => {
      const r = await h.app.inject({
        method: 'POST',
        url: '/api/v1/members',
        headers: h.as(owner),
        payload,
      });
      expect(r.statusCode, r.body).toBe(201);
      return json<MemberView>(r).id;
    };
    child = await add({ display_name: 'Aisha', date_of_birth: '2016-05-01', relationship: 'Kid' });
    grandad = await add({ display_name: 'Grandad', relationship: 'Grandad' });
  }, 90_000);
  afterAll(() => h.close());

  it('an owner changes anybody’s details; each change is a new version, and the log says which details', async () => {
    const before = await person(owner, child);
    expect(before).toMatchObject({ version: 1, can_edit: true });

    const res = await edit(
      owner,
      child,
      { display_name: '  Aisha Khan ', date_of_birth: '2016-05-02', relationship: 'Daughter' },
      '"1"',
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers.etag).toBe('"2"');
    expect(json<MemberView>(res)).toMatchObject({
      id: child,
      display_name: 'Aisha Khan',
      date_of_birth: '2016-05-02',
      relationship: 'Daughter',
      version: 2,
    });
    expect(await person(adult, child)).toMatchObject({ relationship: 'Daughter', version: 2 });

    // The same again, or nothing at all: no change, no new version, no line.
    const lines = (await activity()).length;
    for (const payload of [{ relationship: 'Daughter' }, {}]) {
      const same = await edit(owner, child, payload, '"2"');
      expect(same.statusCode, same.body).toBe(200);
      expect(json<MemberView>(same).version).toBe(2);
    }
    // A blank relationship is none; one detail, one word for it.
    const cleared = await edit(owner, child, { relationship: '  ' }, '"2"');
    expect(json<MemberView>(cleared)).toMatchObject({ relationship: null, version: 3 });
    const after = await activity();
    expect(after.length).toBe(lines + 1);
    expect(after[0]?.text).toBe('Owner changed Aisha Khan’s relationship');
    expect(after[1]?.text).toBe('Owner changed Aisha Khan’s name, date of birth and relationship');
    expect(after[1]?.notable).toBe(false);

    // Who changed them, and when, kept beside them; never their values in the log.
    const row = await withSystem(h.db, owner.household_id, async (trx) => ({
      member: await trx
        .selectFrom('member')
        .select(['version', 'updated_at', 'updated_by'])
        .where('id', '=', child)
        .executeTakeFirstOrThrow(),
      lines: await trx
        .selectFrom('audit_event')
        .select(['detail'])
        .where('action', '=', 'member.updated')
        .where('object_id', '=', child)
        .orderBy('id')
        .execute(),
    }));
    expect(row.member.version).toBe(3);
    expect(row.member.updated_at).toBeInstanceOf(Date);
    const me = json<{ account_id: string }>(
      await h.app.inject({ url: '/api/v1/me', headers: h.as(owner) }),
    );
    expect(row.member.updated_by).toBe(me.account_id);
    expect(row.lines.map((l) => l.detail)).toEqual([
      { fields: ['display_name', 'date_of_birth', 'relationship'] },
      { fields: ['relationship'] },
    ]);
    expect(JSON.stringify(row.lines)).not.toMatch(/Aisha|Daughter|2016/);
  });

  it('a stale version is 409, with the person as they are now, and nothing is changed', async () => {
    const now = await person(owner, child);
    const moved = await edit(adult, child, { relationship: 'Niece' }, `"${now.version}"`);
    expect(moved.statusCode, moved.body).toBe(200);

    // The owner, from what they read before the adult's change.
    const stale = await edit(owner, child, { relationship: 'Daughter' }, `"${now.version}"`);
    expect(stale.statusCode).toBe(409);
    const error = json<{ error: { code: string; detail: string } }>(stale).error;
    expect(error.code).toBe('conflict');
    expect(JSON.parse(error.detail)).toMatchObject({
      id: child,
      relationship: 'Niece',
      version: (now.version as number) + 1,
    });
    expect((await person(owner, child)).relationship).toBe('Niece');
    // Weak, bare and wildcard spellings of the version now are all taken.
    for (const ifMatch of [
      `W/"${(now.version as number) + 1}"`,
      String((now.version as number) + 1),
    ]) {
      const ok = await edit(owner, child, { relationship: 'Niece' }, ifMatch);
      expect(ok.statusCode, ifMatch).toBe(200);
    }
    expect((await edit(owner, child, { relationship: 'Daughter' }, '*')).statusCode).toBe(200);
    // Something that is no version of theirs at all is stale too.
    expect((await edit(owner, child, { relationship: 'x' }, '"abc"')).statusCode).toBe(409);
  });

  it('who may change whom is A66: an owner anybody; an adult themselves and anybody with no sign-in; a teen themselves; a viewer nobody', async () => {
    const people = { owner, adult, teen, viewer } as const;
    const targets = { self: '', 'someone signed in': '', 'no sign-in': grandad } as Record<
      string,
      string
    >;
    const table: Array<[string, string, number]> = [];
    for (const [role, who] of Object.entries(people)) {
      for (const [what, target] of Object.entries(targets)) {
        const id =
          what === 'self'
            ? who.member_id
            : what === 'someone signed in'
              ? role === 'adult'
                ? teen.member_id
                : adult.member_id
              : target;
        const res = await edit(who, id, { relationship: `${role} says so` });
        table.push([role, what, res.statusCode]);
        if (res.statusCode === 403) {
          expect(code(res).code).toBe('forbidden');
          expect(code(res).message).toBe(
            role === 'viewer' ? refusalFor('member.edit') : DETAILS_REFUSAL,
          );
        }
      }
    }
    expect(table).toEqual([
      ['owner', 'self', 200],
      ['owner', 'someone signed in', 200],
      ['owner', 'no sign-in', 200],
      ['adult', 'self', 200],
      ['adult', 'someone signed in', 403],
      ['adult', 'no sign-in', 200],
      ['teen', 'self', 200],
      ['teen', 'someone signed in', 403],
      ['teen', 'no sign-in', 403],
      ['viewer', 'self', 403],
      ['viewer', 'someone signed in', 403],
      ['viewer', 'no sign-in', 403],
    ]);
    // What each is told they may do is what they may do.
    expect((await members(adult)).map((m) => [m.display_name, m.can_edit])).toEqual(
      (await members(adult)).map((m) => [m.display_name, m.role === null || m.is_me]),
    );
    expect((await members(viewer)).every((m) => m.can_edit === false)).toBe(true);
    // Refused, nothing changed: the teen's word stands, not the adult's.
    expect((await person(owner, teen.member_id)).relationship).toBe('teen says so');
  });

  it('deceased needs an owner and step-up', async () => {
    // Anybody but an owner: refused, whoever the person — even somebody
    // whose other details they may change, themselves included.
    for (const [who, id, said] of [
      [adult, grandad, DECEASED_REFUSAL],
      [adult, adult.member_id, DECEASED_REFUSAL],
      [teen, teen.member_id, DECEASED_REFUSAL],
      [teen, grandad, DETAILS_REFUSAL],
      [viewer, grandad, refusalFor('member.edit')],
    ] as const) {
      const res = await edit(who, id, { is_deceased: true });
      expect(res.statusCode).toBe(403);
      expect(code(res).message).toBe(said);
    }
    // An adult's change to Grandad's other details still goes through.
    expect((await edit(adult, grandad, { relationship: 'Grandad' })).statusCode).toBe(200);

    // An owner whose session has gone stale is asked, and nothing changes.
    await goStale(owner);
    const asked = await edit(owner, grandad, { is_deceased: true, relationship: 'Our Grandad' });
    expect(asked.statusCode).toBe(403);
    expect(code(asked)).toMatchObject({ code: 'step_up_required', action: 'change_people' });
    expect(await person(owner, grandad)).toMatchObject({
      is_deceased: false,
      relationship: 'Grandad',
    });
    // Other details alone are not asked about.
    expect((await edit(owner, grandad, { relationship: 'Grandad' })).statusCode).toBe(200);

    // Confirmed — a password does for this, as it does for every power that
    // came before A54 — it goes through, and the log says so, as news.
    expect((await stepUp(owner, { password: 'correct horse battery' })).statusCode).toBe(200);
    const done = await edit(owner, grandad, { is_deceased: true });
    expect(done.statusCode, done.body).toBe(200);
    expect(json<MemberView>(done).is_deceased).toBe(true);
    const line = (await activity())[0];
    expect(line).toMatchObject({
      text: 'Owner recorded that Grandad has passed away',
      notable: true,
    });

    // Taken back: an owner's again, asked again.
    await goStale(owner);
    const back = await edit(owner, grandad, { is_deceased: false });
    expect(code(back)).toMatchObject({ code: 'step_up_required', action: 'change_people' });
    expect((await stepUp(owner, { password: 'correct horse battery' })).statusCode).toBe(200);
    expect(json<MemberView>(await edit(owner, grandad, { is_deceased: false })).is_deceased).toBe(
      false,
    );
    expect((await activity())[0]).toMatchObject({
      text: 'Owner took back the record that Grandad has passed away',
      notable: true,
    });
    // And Grandad passed away again, for the tests below.
    expect(json<MemberView>(await edit(owner, grandad, { is_deceased: true })).is_deceased).toBe(
      true,
    );
  });

  it('somebody who can still sign in is not recorded as passed away', async () => {
    for (const id of [adult.member_id, owner.member_id]) {
      const res = await edit(owner, id, { is_deceased: true });
      expect(res.statusCode).toBe(409);
      expect(code(res).code).toBe('signed_in');
      expect(code(res).message).toMatch(/Take their sign-in away first/);
      expect((await person(owner, id)).is_deceased).toBe(false);
    }
  });

  it('what is sent is checked: a blank name, a day that is none or has not been, anything else', async () => {
    const tomorrowButOne = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    for (const payload of [
      { display_name: '   ' },
      { display_name: 'x'.repeat(121) },
      { date_of_birth: '2016-02-30' },
      { date_of_birth: '12/05/2016' },
      { date_of_birth: tomorrowButOne },
      { relationship: 'x'.repeat(61) },
      { is_deceased: 'yes' },
      { email: 'someone-else@example.test' },
      { colour: 3 },
    ]) {
      const res = await edit(owner, child, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(422);
    }
    // A birthday taken away is null.
    expect(json<MemberView>(await edit(owner, child, { date_of_birth: null })).date_of_birth).toBe(
      null,
    );
  });

  it('a person in another household, or nobody at all, is 404; an id that is none is 422', async () => {
    const other = await createHarness();
    try {
      const theirs = await other.setup({ email: 'other-525@example.test' });
      // Their owner, asking about ours.
      const res = await other.app.inject({
        method: 'PATCH',
        url: `/api/v1/members/${child}`,
        headers: other.as(theirs),
        payload: { relationship: 'Ours now' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await other.close();
    }
    expect((await edit(owner, '00000000-0000-4000-8000-000000000000', {})).statusCode).toBe(404);
    expect((await edit(owner, 'not-an-id', {})).statusCode).toBe(422);
    expect((await person(owner, child)).relationship).not.toBe('Ours now');
    // A second vault, its database made and migrated and dropped again:
    // 1.7 s alone, past the 15 s ceiling with the whole gate on one shared
    // server (5.27).
  }, 60_000);

  it('a viewer is told no more than before: nobody else’s version, and none of the log', async () => {
    const seen = await members(viewer);
    expect(seen.filter((m) => !m.is_me).every((m) => m.version === null)).toBe(true);
    expect(seen.find((m) => m.is_me)?.version).toBe(1);
    // Owners, adults and teens are given everyone's.
    for (const who of [owner, adult, teen]) {
      expect((await members(who)).every((m) => typeof m.version === 'number')).toBe(true);
    }
    const log = await h.app.inject({ url: '/api/v1/audit', headers: h.as(viewer) });
    expect(log.statusCode).toBe(403);
    // A teen reads the lines, which name details, never their values.
    const lines = json<{ items: ActivityLine[] }>(
      await h.app.inject({ url: '/api/v1/audit?limit=100', headers: h.as(teen) }),
    ).items;
    expect(lines.some((l) => l.text === 'Owner changed Aisha Khan’s relationship')).toBe(true);
  });

  it('a date of birth is checked the same way when a person is added: a real day, not to come', async () => {
    const add = (date_of_birth: string) =>
      h.app.inject({
        method: 'POST',
        url: '/api/v1/members',
        headers: h.as(owner),
        payload: { display_name: 'Baby', date_of_birth },
      });
    const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    for (const day of ['2016-02-30', '12/05/2016', soon]) {
      const refused = await add(day);
      expect(refused.statusCode, day).toBe(422);
      expect(code(refused).code).toBe('validation_failed');
    }
    const added = await add('2020-02-29');
    expect(added.statusCode, added.body).toBe(201);
    expect(json<MemberView>(added).date_of_birth).toBe('2020-02-29');
  });

  describe('nobody signs in as somebody recorded as passed away', () => {
    let peer = 0;
    const from = () => `10.53.${++peer >> 8}.${peer & 0xff}`;
    const add = async (display_name: string) => {
      const r = await h.app.inject({
        method: 'POST',
        url: '/api/v1/members',
        headers: h.as(owner),
        payload: { display_name },
      });
      expect(r.statusCode, r.body).toBe(201);
      return json<MemberView>(r).id;
    };
    const invite = (who: Tokens, id: string, email: string, role = 'adult') =>
      h.app.inject({
        method: 'POST',
        url: `/api/v1/members/${id}/invite`,
        headers: h.as(who),
        payload: { email, role },
      });
    const accept = (made: { link_token: string; code: string }) =>
      h.app.inject({
        method: 'POST',
        url: `/api/v1/invitations/${made.link_token}/accept`,
        payload: { code: made.code, password: 'a long enough password' },
        remoteAddress: from(),
      });
    const memberships = (id: string) =>
      withSystem(h.db, owner.household_id, (trx) =>
        trx
          .selectFrom('account_household')
          .select('account_id')
          .where('member_id', '=', id)
          .execute(),
      );

    it('an invitation waiting when the passing is recorded is taken back, and can no longer be accepted', async () => {
      const nana = await add('Nana');
      const made = await invite(owner, nana, 'nana-525@example.test');
      expect(made.statusCode, made.body).toBe(201);
      const link = json<{ link_token: string; code: string; invitation: { id: string } }>(made);
      expect((await stepUp(owner, { password: 'correct horse battery' })).statusCode).toBe(200);
      const passed = await edit(owner, nana, { is_deceased: true });
      expect(passed.statusCode, passed.body).toBe(200);
      // Taken back, and the log says so, as one taken back by hand.
      const invitations = json<{ items: Array<{ id: string; state: string }> }>(
        await h.app.inject({ url: '/api/v1/invitations', headers: h.as(owner) }),
      ).items;
      expect(invitations.find((i) => i.id === link.invitation.id)?.state).toBe('revoked');
      const lines = (await activity()).slice(0, 2).map((l) => l.text);
      expect(lines).toContain('Owner cancelled the invitation to nana-525@example.test');
      expect(lines).toContain('Owner recorded that Nana has passed away');
      const late = await accept(link);
      expect(late.statusCode).toBe(404);
      expect(code(late).code).toBe('invitation_not_valid');
      expect(await memberships(nana)).toEqual([]);
    });

    it('an invitation still live for somebody recorded as passed away is refused at its acceptance', async () => {
      // Recorded by some other way than the API's (the vault itself), so
      // the invitation is still live: its acceptance asks for itself.
      const aunt = await add('Great-aunt');
      const link = json<{ link_token: string; code: string }>(
        await invite(owner, aunt, 'aunt-525@example.test'),
      );
      await withSystem(h.db, owner.household_id, (trx) =>
        trx.updateTable('member').set({ is_deceased: true }).where('id', '=', aunt).execute(),
      );
      const refused = await accept(link);
      expect(refused.statusCode).toBe(409);
      expect(code(refused)).toMatchObject({
        code: 'passed_away',
        message: "Great-aunt is recorded as having passed away, so they can't be given a sign-in.",
      });
      expect(await memberships(aunt)).toEqual([]);
    });

    it('nobody is invited to sign in as them, by an owner or an adult', async () => {
      const grandpa = await add('Grandpa');
      expect((await edit(owner, grandpa, { is_deceased: true })).statusCode).toBe(200);
      for (const [who, role] of [
        [owner, 'adult'],
        [adult, 'teen'],
      ] as const) {
        const refused = await invite(who, grandpa, `grandpa-${role}-525@example.test`, role);
        expect(refused.statusCode, `${who.role}`).toBe(409);
        expect(code(refused).code).toBe('passed_away');
      }
      const listed = json<{ items: Array<{ member_id: string }> }>(
        await h.app.inject({ url: '/api/v1/invitations', headers: h.as(owner) }),
      ).items;
      expect(listed.some((i) => i.member_id === grandpa)).toBe(false);
    });

    it('a sign-in taken away is not given back to somebody recorded as passed away', async () => {
      const bob = await h.join(owner, {
        name: 'Uncle Bob',
        email: 'bob-525@example.test',
        role: 'adult',
      });
      const removed = await h.app.inject({
        method: 'DELETE',
        url: `/api/v1/members/${bob.member_id}/sign-in`,
        headers: h.as(owner),
      });
      expect(removed.statusCode, removed.body).toBe(204);
      expect((await edit(owner, bob.member_id, { is_deceased: true })).statusCode).toBe(200);
      const back = await h.app.inject({
        method: 'POST',
        url: `/api/v1/members/${bob.member_id}/sign-in`,
        headers: h.as(owner),
        payload: { role: 'adult' },
      });
      expect(back.statusCode).toBe(409);
      expect(code(back)).toMatchObject({
        code: 'passed_away',
        message: "Uncle Bob is recorded as having passed away, so they can't be given a sign-in.",
      });
      expect(await memberships(bob.member_id)).toEqual([]);
      // And his password signs nobody in.
      const signIn = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password',
        payload: { email: 'bob-525@example.test', password: 'another correct horse' },
        remoteAddress: from(),
      });
      expect(signIn.statusCode).toBe(403);
      expect(code(signIn).code).toBe('no_household');
    });

    it('the database holds it too, whoever asks: no sign-in for them, no passing for somebody signed in', async () => {
      const gran = await add('Gran');
      await withSystem(h.db, owner.household_id, (trx) =>
        trx.updateTable('member').set({ is_deceased: true }).where('id', '=', gran).execute(),
      );
      const given = withSystem(h.db, owner.household_id, async (trx) => {
        const account = await trx
          .insertInto('account')
          .values({ email: 'gran-525@example.test', password_hash: 'x' })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('account_household')
          .values({
            account_id: account.id,
            household_id: owner.household_id,
            member_id: gran,
            role: 'adult',
          })
          .execute();
      });
      await expect(given).rejects.toMatchObject({ code: '23514' });
      // Nor moved onto them.
      const moved = withSystem(h.db, owner.household_id, (trx) =>
        trx
          .updateTable('account_household')
          .set({ member_id: gran })
          .where('member_id', '=', teen.member_id)
          .execute(),
      );
      await expect(moved).rejects.toMatchObject({ code: '23514' });
      // And somebody who can still sign in is not recorded as passed away.
      const passing = withSystem(h.db, owner.household_id, (trx) =>
        trx
          .updateTable('member')
          .set({ is_deceased: true })
          .where('id', '=', teen.member_id)
          .execute(),
      );
      await expect(passing).rejects.toMatchObject({ code: '23514' });
      expect((await person(owner, teen.member_id)).is_deceased).toBe(false);
    });

    /**
     * Sending an invitation again holds the person before their invitation,
     * as accepting one and recording a passing do (the 5.25 review, round
     * two): the other way round, the two deadlocked. Each race is made to
     * happen, not hoped for: the person is held from outside while the two
     * requests queue for them, the one that must go first queued first.
     */
    it('removing for good (5.24) after a passing: an owner’s own filed by them goes at once, theirs still waits a day', async () => {
      // Recorded as passed away, a filer never signs in here again, and so
      // is never one to be told: as for a sign-in taken away (5.24).
      expect((await stepUp(owner, { password: 'correct horse battery' })).statusCode).toBe(200);
      const may = await h.join(owner, {
        name: 'Aunt May',
        email: 'may-525@example.test',
        role: 'adult',
      });
      const file = async (who: Tokens, title: string, owner_member_id: string) => {
        const r = await h.app.inject({
          method: 'POST',
          url: '/api/v1/documents',
          headers: h.as(who),
          payload: { title, type_key: 'utility_bill', visibility: 'household', owner_member_id },
        });
        expect(r.statusCode, r.body).toBe(201);
        return json<{ id: string }>(r).id;
      };
      const hers = await file(may, 'May’s gas bill', may.member_id);
      const forOwner = await file(owner, 'Filed by May', owner.member_id);
      const mayAccount = json<{ account_id: string }>(
        await h.app.inject({ url: '/api/v1/me', headers: h.as(may) }),
      ).account_id;
      await withSystem(h.db, owner.household_id, (trx) =>
        trx
          .updateTable('document')
          .set({ created_by: mayAccount })
          .where('id', '=', forOwner)
          .execute(),
      );
      for (const id of [hers, forOwner]) {
        const binned = await h.app.inject({
          method: 'DELETE',
          url: `/api/v1/documents/${id}`,
          headers: h.as(owner),
        });
        expect(binned.statusCode, binned.body).toBe(204);
      }
      const atOnce = async () => {
        const trash = json<{ items: Array<{ id: string; purge_at_once: boolean }> }>(
          await h.app.inject({ url: '/api/v1/documents?deleted=true', headers: h.as(owner) }),
        ).items;
        return [hers, forOwner].map((id) => trash.find((d) => d.id === id)?.purge_at_once);
      };
      // May signs in: neither goes without asking her first.
      expect(await atOnce()).toEqual([false, false]);
      const removed = await h.app.inject({
        method: 'DELETE',
        url: `/api/v1/members/${may.member_id}/sign-in`,
        headers: h.as(owner),
      });
      expect(removed.statusCode, removed.body).toBe(204);
      expect((await edit(owner, may.member_id, { is_deceased: true })).statusCode).toBe(200);
      // The owner's own goes at once; hers is still asked about, and waits.
      expect(await atOnce()).toEqual([false, true]);
    });

    describe('an invitation sent again, at the same moment as', () => {
      const deadlocks = async (admin: ReturnType<typeof createPool>) =>
        (
          await admin.query<{ n: number }>(
            'select deadlocks::int as n from pg_stat_database where datname = $1',
            [new URL(h.adminUrl).pathname.slice(1)],
          )
        ).rows[0]?.n as number;
      const waiting = async (admin: ReturnType<typeof createPool>, n: number) => {
        for (let i = 0; i < 200; i += 1) {
          const r = await admin.query<{ n: number }>(
            `select count(*)::int as n from pg_stat_activity
              where datname = $1 and wait_event_type = 'Lock'`,
            [new URL(h.adminUrl).pathname.slice(1)],
          );
          if ((r.rows[0]?.n ?? 0) >= n) return;
          await new Promise((res) => setTimeout(res, 50));
        }
        throw new Error(`fewer than ${n} statements waiting on a lock`);
      };
      /** Runs `first`, then `second`, both queued behind the person held from outside. */
      const race = async <A, B>(
        person: string,
        first: () => Promise<A>,
        second: () => Promise<B>,
      ) => {
        const admin = createPool(h.adminUrl, 3);
        const holder = await admin.connect();
        const before = await deadlocks(admin);
        try {
          await holder.query('begin');
          await holder.query('select id from member where id = $1 for update', [person]);
          const a = first();
          await waiting(admin, 1);
          const b = second();
          await waiting(admin, 2);
          await holder.query('rollback');
          const both = await Promise.all([a, b]);
          // The statistics reach pg_stat_database a moment later.
          await new Promise((res) => setTimeout(res, 1500));
          expect(await deadlocks(admin)).toBe(before);
          return both;
        } finally {
          await holder.query('rollback').catch(() => undefined);
          holder.release();
          await admin.end();
        }
      };
      const pending = async (id: string) =>
        json<{ items: Array<{ member_id: string; state: string }> }>(
          await h.app.inject({ url: '/api/v1/invitations', headers: h.as(owner) }),
        ).items.filter((i) => i.member_id === id && i.state === 'pending');

      it('its acceptance: the invitee is signed in, the one sent again is refused, nothing fails', async () => {
        expect((await stepUp(owner, { password: 'correct horse battery' })).statusCode).toBe(200);
        const cousin = await add('Cousin Ali');
        const link = json<{ link_token: string; code: string }>(
          await invite(owner, cousin, 'ali-525@example.test'),
        );
        const [accepted, again] = await race(
          cousin,
          () => accept(link),
          () => invite(owner, cousin, 'ali-again-525@example.test'),
        );
        expect(accepted.statusCode, accepted.body).toBe(201);
        expect(again.statusCode, again.body).toBe(409);
        expect(code(again).code).toBe('already_signed_in');
        expect(await memberships(cousin)).toHaveLength(1);
        expect(await pending(cousin)).toEqual([]);
      });

      it('a passing recorded first: no invitation is left waiting, and the one sent again is refused', async () => {
        expect((await stepUp(owner, { password: 'correct horse battery' })).statusCode).toBe(200);
        const greatUncle = await add('Great-uncle');
        expect((await invite(owner, greatUncle, 'uncle-525@example.test')).statusCode).toBe(201);
        const [passed, again] = await race(
          greatUncle,
          () => edit(owner, greatUncle, { is_deceased: true }),
          () => invite(owner, greatUncle, 'uncle-again-525@example.test'),
        );
        expect(passed.statusCode, passed.body).toBe(200);
        expect(again.statusCode, again.body).toBe(409);
        expect(code(again).code).toBe('passed_away');
        expect(await pending(greatUncle)).toEqual([]);
      });

      it('a passing recorded second: the one sent again goes first, and is taken back with the passing', async () => {
        expect((await stepUp(owner, { password: 'correct horse battery' })).statusCode).toBe(200);
        const greatAunt = await add('Great-aunt Zee');
        expect((await invite(owner, greatAunt, 'zee-525@example.test')).statusCode).toBe(201);
        const [again, passed] = await race(
          greatAunt,
          () => invite(owner, greatAunt, 'zee-again-525@example.test'),
          () => edit(owner, greatAunt, { is_deceased: true }),
        );
        expect(again.statusCode, again.body).toBe(201);
        expect(passed.statusCode, passed.body).toBe(200);
        expect(await pending(greatAunt)).toEqual([]);
      });
    });
  });

  it('an owner with a passkey and no two-step is let see a sign-in, after the passkey and never the password', async () => {
    // This owner signed in with a password alone: A54 refuses them first.
    const refused = await h.app.inject({
      url: `/api/v1/members/${adult.member_id}/account`,
      headers: h.as(owner),
    });
    expect(refused.statusCode).toBe(403);
    expect(code(refused).code).toBe('totp_required_for_owner');

    const device = new SoftwareAuthenticator();
    expect((await stepUp(owner, { password: 'correct horse battery' })).statusCode).toBe(200);
    const options = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkeys/challenge',
      headers: h.as(owner),
    });
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkeys',
      headers: h.as(owner),
      payload: { response: device.register(options.json()), label: 'Laptop' },
    });
    expect(created.statusCode, created.body).toBe(201);

    // A passkey now, but this session saw only a password: asked, for a passkey.
    const card = () =>
      h.app.inject({ url: `/api/v1/members/${adult.member_id}/account`, headers: h.as(owner) });
    const asked = await card();
    expect(asked.statusCode).toBe(403);
    expect(code(asked)).toMatchObject({ code: 'step_up_required', action: 'manage_sign_ins' });
    expect(code(asked).message).toBe("Please confirm it is you to manage other people's sign-ins.");
    expect((await stepUp(owner, { password: 'correct horse battery' })).statusCode).toBe(200);
    expect(code(await card()).code).toBe('step_up_required');

    const challenge = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkey/challenge',
      payload: { email: 'owner@example.test' },
    });
    expect(
      (await stepUp(owner, { passkey: device.authenticate(challenge.json()) })).statusCode,
    ).toBe(200);
    const shown = await card();
    expect(shown.statusCode, shown.body).toBe(200);
    expect(json<MemberAccount>(shown)).toMatchObject({
      member_id: adult.member_id,
      role: 'adult',
      email: 'sara-525@example.test',
      two_step: false,
      passkeys: 0,
    });
  });
});

describe.skipIf(!testAdminUrl())("the owner's view of a sign-in (5.25, A54)", () => {
  let h: Harness;
  let owner: Tokens;
  let adult: Tokens;
  let teen: Tokens;
  let viewer: Tokens;
  let child: string;
  let secret = '';
  let peer = 0;
  const from = () => `10.52.${++peer >> 8}.${peer & 0xff}`;

  const card = (who: Tokens, id: string) =>
    h.app.inject({ url: `/api/v1/members/${id}/account`, headers: h.as(who) });
  const stepUp = (who: Tokens, payload: Record<string, unknown>) =>
    h.app.inject({ method: 'POST', url: '/api/v1/auth/step-up', headers: h.as(who), payload });
  const goStale = () =>
    withSystem(h.db, owner.household_id, (trx) =>
      trx
        .updateTable('session')
        .set({
          verified_at: new Date(Date.now() - 10 * 60 * 1000),
          factor_verified_at: new Date(Date.now() - 10 * 60 * 1000),
        })
        .execute(),
    );

  const MAC_SAFARI =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
  const PHONE = 'FDV/0.2.0 (Android 15; Google Pixel 8a)';
  const INSTALLATION = '6c1f8a52-3d4e-4b7a-9f10-2e3d4c5b6a79';
  const SARA_PASSWORD = 'another correct horse';

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    owner = await h.setup();
    adult = await h.join(owner, { name: 'Sara', email: 'sara-card@example.test', role: 'adult' });
    teen = await h.join(owner, { name: 'Tariq', email: 'tariq-card@example.test', role: 'teen' });
    viewer = await h.join(owner, { name: 'Acc', email: 'acc-card@example.test', role: 'viewer' });
    const added = await h.app.inject({
      method: 'POST',
      url: '/api/v1/members',
      headers: h.as(owner),
      payload: { display_name: 'Aisha' },
    });
    child = json<MemberView>(added).id;
  }, 90_000);
  afterAll(() => h.close());

  it('a password-only owner is refused the account card, and step-up by password is refused', async () => {
    // A fresh session, just signed in: refused all the same.
    const refused = await card(owner, adult.member_id);
    expect(refused.statusCode).toBe(403);
    expect(code(refused)).toMatchObject({
      code: 'totp_required_for_owner',
      message: "Turn on two-step sign-in to manage other people's sign-ins.",
    });

    // Two-step sign-in on, from the session the password opened.
    const enrol = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/enrol',
      headers: h.as(owner),
    });
    secret = json<{ secret: string }>(enrol).secret;
    const confirm = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/confirm',
      headers: h.as(owner),
      payload: { code: codeFor(secret) },
    });
    expect(confirm.statusCode).toBe(204);

    // That session saw a password, never a code: asked.
    const asked = await card(owner, adult.member_id);
    expect(asked.statusCode).toBe(403);
    expect(code(asked)).toMatchObject({ code: 'step_up_required', action: 'manage_sign_ins' });
    // A password is a step-up still, for what it always opened...
    expect((await stepUp(owner, { password: 'correct horse battery' })).statusCode).toBe(200);
    const added = await h.app.inject({
      method: 'POST',
      url: '/api/v1/members',
      headers: h.as(owner),
      payload: { display_name: 'Someone new' },
    });
    expect(added.statusCode).toBe(201);
    // ...and never for this.
    const still = await card(owner, adult.member_id);
    expect(code(still)).toMatchObject({ code: 'step_up_required', action: 'manage_sign_ins' });

    // A code is.
    expect((await stepUp(owner, { code: codeFor(secret) })).statusCode).toBe(200);
    expect((await card(owner, adult.member_id)).statusCode).toBe(200);
    // For five minutes.
    await goStale();
    expect(code(await card(owner, adult.member_id)).code).toBe('step_up_required');

    // A sign-in with the password and a code is fresh for it at once.
    const first = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { email: 'owner@example.test', password: 'correct horse battery' },
      remoteAddress: from(),
    });
    const mfa = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa',
      payload: { mfa_token: json<{ mfa_token: string }>(first).mfa_token, code: codeFor(secret) },
      remoteAddress: from(),
    });
    owner = json<Tokens>(mfa);
    expect((await card(owner, adult.member_id)).statusCode).toBe(200);
  });

  it('the account card has no IP address or secret', async () => {
    // Sara signs in on a Mac, from an address of her own, and on her phone;
    // a third session is signed out; the phone keeps Essentials offline.
    const signIn = (headers: Record<string, string>, remoteAddress: string) =>
      h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password',
        headers,
        payload: { email: 'sara-card@example.test', password: SARA_PASSWORD },
        remoteAddress,
      });
    const mac = json<Tokens>(await signIn({ 'user-agent': MAC_SAFARI }, '203.0.113.77'));
    const phone = json<Tokens>(
      await signIn({ 'user-agent': PHONE, 'x-fdv-installation': INSTALLATION }, '198.51.100.23'),
    );
    const gone = json<Tokens>(await signIn({ 'user-agent': 'curl/8.4.0' }, '192.0.2.200'));
    expect(
      (await h.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: h.as(gone) }))
        .statusCode,
    ).toBe(204);
    await withSystem(h.db, owner.household_id, (trx) =>
      trx
        .updateTable('session')
        .set({
          offline_granted_at: new Date(),
          offline_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
        })
        .where('installation_id', '=', INSTALLATION)
        .execute(),
    );
    // A passkey of hers, too.
    const device = new SoftwareAuthenticator();
    const options = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkeys/challenge',
      headers: h.as(mac),
    });
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkeys',
      headers: h.as(mac),
      payload: { response: device.register(options.json()), label: 'Sara’s Mac' },
    });
    expect(created.statusCode, created.body).toBe(201);

    const res = await card(owner, adult.member_id);
    expect(res.statusCode, res.body).toBe(200);
    const shown = json<MemberAccount>(res);
    // 5.28: whether their sign-in is locked, and how long a phone keeps its
    // copies offline — a setting of the vault's, not of theirs. 5.29: which
    // way a reset an owner starts would go, never why. 5.33: a viewer's
    // limits, none for an adult.
    expect(Object.keys(shown).sort()).toEqual([
      'access',
      'devices',
      'email',
      'last_signed_in_at',
      'max_offline_days',
      'member_id',
      'passkeys',
      'reset_path',
      'role',
      'suspension',
      'two_step',
    ]);
    expect(shown.suspension).toBeNull();
    expect(shown.access).toBeNull();
    expect(shown).toMatchObject({
      member_id: adult.member_id,
      role: 'adult',
      email: 'sara-card@example.test',
      two_step: false,
      passkeys: 1,
    });
    // The newest sign-in here: the one signed out since, which still was one.
    expect(Date.parse(shown.last_signed_in_at as string)).toBeGreaterThan(Date.now() - 60_000);
    // Where she is signed in now: not the device signed out.
    for (const d of shown.devices) {
      expect(Object.keys(d).sort()).toEqual(['client', 'label', 'last_used_at', 'offline']);
    }
    // The Mac, the phone, and the sign-in her invitation opened (a test's,
    // which says no browser); not the one signed out.
    const labels = shown.devices.map((d) => [d.label, d.client, d.offline]);
    expect(labels).toHaveLength(3);
    expect(labels).toContainEqual(['Safari on a Mac', 'browser', false]);
    expect(labels).toContainEqual(['the app on a Google Pixel 8a', 'app', true]);
    expect(labels.filter(([, client]) => client === 'other')).toHaveLength(1);

    // Nothing that is an address, a user agent, an id or a secret.
    const body = res.body;
    const secrets = await withSystem(h.db, owner.household_id, async (trx) => {
      const sessions = await trx
        .selectFrom('session')
        .select(['id', 'ip', 'refresh_hash', 'installation_id'])
        .where('account_id', '=', (eb) =>
          eb
            .selectFrom('account_household')
            .select('account_id')
            .where('member_id', '=', adult.member_id),
        )
        .execute();
      const account = await trx
        .selectFrom('account')
        .innerJoin('account_household', 'account_household.account_id', 'account.id')
        .select(['account.id', 'account.password_hash'])
        .where('account_household.member_id', '=', adult.member_id)
        .executeTakeFirstOrThrow();
      const credentials = await trx
        .selectFrom('credential')
        .select(['id', 'credential_id', 'public_key'])
        .where('account_id', '=', account.id)
        .execute();
      return { sessions, account, credentials };
    });
    const never = [
      '203.0.113.77',
      '198.51.100.23',
      '192.0.2.200',
      MAC_SAFARI,
      'Macintosh',
      'Android 15',
      INSTALLATION,
      mac.refresh_token,
      mac.access_token,
      phone.refresh_token,
      secrets.account.id,
      String(secrets.account.password_hash),
      '$argon2',
      ...secrets.sessions.flatMap((s) => [s.id, s.refresh_hash.toString('hex'), String(s.ip)]),
      ...secrets.credentials.flatMap((c) => [
        c.id,
        c.credential_id?.toString('base64url') ?? 'none',
        c.public_key?.toString('base64') ?? 'none',
      ]),
    ];
    for (const s of never) expect(body, s).not.toContain(s);
    expect(body).not.toMatch(/"ip"|user_agent|session|token|secret|hash|installation/i);
  });

  it('an adult gets 404 for another person’s account card', async () => {
    for (const who of [adult, teen, viewer]) {
      for (const id of [owner.member_id, adult.member_id, child, who.member_id]) {
        const res = await card(who, id);
        expect(res.statusCode, `${who.role} → ${id}`).toBe(404);
        expect(code(res)).toMatchObject({
          code: 'not_found',
          message: 'That page does not exist.',
        });
        expect(res.body).not.toMatch(/sara|tariq|acc-card|@/i);
      }
    }
  });

  it('a person with no sign-in has no card; nobody of the family has none either', async () => {
    expect((await stepUp(owner, { code: codeFor(secret) })).statusCode).toBe(200);
    const none = await card(owner, child);
    expect(none.statusCode).toBe(404);
    expect(code(none).message).toBe('They have no sign-in to show.');
    expect((await card(owner, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    // The owner's own: theirs to see, as anybody's.
    const own = await card(owner, owner.member_id);
    expect(json<MemberAccount>(own)).toMatchObject({ role: 'owner', two_step: true });
  });

  it('a look at a sign-in is a line for the owners and the person looked at, written only when the card is given', async () => {
    const looks = () =>
      withSystem(h.db, owner.household_id, (trx) =>
        trx
          .selectFrom('audit_event')
          .select(['object_type', 'object_id', 'detail', 'actor_account_id'])
          .where('action', '=', 'member.account_viewed')
          .orderBy('id')
          .execute(),
      );
    const before = (await looks()).length;
    // Refused, however: nothing written.
    expect((await card(teen, adult.member_id)).statusCode).toBe(404);
    await goStale();
    expect(code(await card(owner, adult.member_id)).code).toBe('step_up_required');
    expect((await stepUp(owner, { code: codeFor(secret) })).statusCode).toBe(200);
    expect((await card(owner, child)).statusCode).toBe(404);
    expect(await looks()).toHaveLength(before);

    // Given: one line, about Sara, saying nothing of what the card said.
    expect((await card(owner, adult.member_id)).statusCode).toBe(200);
    const after = await looks();
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)).toMatchObject({
      object_type: 'member',
      object_id: adult.member_id,
      detail: {},
    });

    const lines = async (who: Tokens) =>
      json<{ items: ActivityLine[] }>(
        await h.app.inject({ url: '/api/v1/audit?limit=100', headers: h.as(who) }),
      ).items;
    const said = 'Owner looked at Sara’s sign-in';
    // The owners, and Sara herself: as news.
    for (const who of [owner, adult]) {
      expect((await lines(who)).find((l) => l.text === said)?.notable, who.role).toBe(true);
    }
    // Not a teen of the family; a viewer reads no log at all.
    expect((await lines(teen)).some((l) => /looked at .* sign-in/.test(l.text))).toBe(false);
    expect((await h.app.inject({ url: '/api/v1/audit', headers: h.as(viewer) })).statusCode).toBe(
      403,
    );
  });

  it('no route changes another person’s sign-in email', async () => {
    const emails = () =>
      withSystem(h.db, owner.household_id, (trx) =>
        trx.selectFrom('account').select(['id', 'email']).orderBy('id').execute(),
      );
    const before = await emails();
    const sara = await withSystem(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('account_household')
        .select('account_id')
        .where('member_id', '=', adult.member_id)
        .executeTakeFirstOrThrow(),
    );

    // Every route the vault answers, read from the router itself.
    const routes = listRoutes(h.app.printRoutes({ commonPrefix: false }));
    expect(routes.length).toBeGreaterThan(100);
    expect(routes).toContainEqual({ method: 'PATCH', url: '/api/v1/members/:id' });
    expect(routes).toContainEqual({ method: 'GET', url: '/api/v1/members/:id/account' });

    // Each that changes anything, asked by an owner with every credential
    // fresh to put somebody else's address in place: by their person, and
    // by their account. Signing out is left out (it would end the asking),
    // and so is DELETE, which changes no address.
    const NEW = 'taken-over@example.test';
    const payload = { email: NEW, new_email: NEW, email_address: NEW, sign_in_email: NEW };
    const writes = routes.filter(
      (r) => ['POST', 'PUT', 'PATCH'].includes(r.method) && r.url !== '/api/v1/auth/logout',
    );
    expect(writes.length).toBeGreaterThan(40);
    for (const id of [adult.member_id, sara.account_id]) {
      expect((await stepUp(owner, { code: codeFor(secret) })).statusCode).toBe(200);
      for (const r of writes) {
        const url = r.url.replace(/:id\b/g, id).replace(/:[A-Za-z_]+/g, 'x');
        await h.app.inject({
          method: r.method as 'POST',
          url,
          headers: h.as(owner),
          payload: { ...payload, email: NEW },
          remoteAddress: from(),
        });
      }
    }
    expect(await emails()).toEqual(before);

    // And nothing in the API's code or the worker's writes an account's
    // address: the one place one is written is the account's making.
    const written = await accountWrites();
    expect(written.updates.filter((u) => /\bemail\b/.test(u.set))).toEqual([]);
    expect(written.updates.length).toBeGreaterThan(3);
    expect(written.raw).toEqual([]);
  });
});

/** The routes `printRoutes({ commonPrefix: false })` draws, each with its method. */
function listRoutes(tree: string): Array<{ method: string; url: string }> {
  const out: Array<{ method: string; url: string }> = [];
  const stack: string[] = [];
  for (const line of tree.split('\n')) {
    const m = /^([│ ]*)(?:├── |└── )(.*?)(?: \(([A-Z, ]+)\))?$/.exec(line.replace(/\r$/, ''));
    if (!m) continue;
    const depth = (m[1] as string).length / 4;
    stack.length = depth;
    stack.push(m[2] as string);
    for (const method of (m[3] ?? '').split(',').map((s) => s.trim())) {
      if (method && method !== 'HEAD') out.push({ method, url: stack.join('') });
    }
  }
  return out;
}

/**
 * Every update of the account table in the API's and the worker's code,
 * with what it sets; and any SQL that would update it by hand.
 */
async function accountWrites(): Promise<{
  updates: Array<{ at: string; set: string }>;
  raw: string[];
}> {
  const { readdir, readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const files: string[] = [];
  for (const dir of ['api/src', 'worker/src']) {
    for (const f of await readdir(path.join(root, dir), { recursive: true })) {
      if (/\.ts$/.test(f) && !/\.test\.ts$/.test(f)) files.push(path.join(root, dir, f));
    }
  }
  const updates: Array<{ at: string; set: string }> = [];
  const raw: string[] = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    for (const found of text.matchAll(/updateTable\(\s*'account'\s*\)/g)) {
      // What the next .set( is given, to its closing bracket.
      const from = text.indexOf('.set(', found.index);
      let depth = 0;
      let end = from + 4;
      for (; end < text.length; end++) {
        if (text[end] === '(') depth++;
        else if (text[end] === ')' && --depth === 0) break;
      }
      updates.push({ at: path.basename(file), set: text.slice(from, end + 1) });
    }
    for (const found of text.matchAll(/update\s+(?:public\.)?account\b[^_]/gi)) {
      raw.push(`${path.basename(file)}: ${text.slice(found.index, found.index + 60)}`);
    }
  }
  return { updates, raw };
}
