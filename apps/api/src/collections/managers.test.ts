import { createDb, createPool, withPrincipal, type Db } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type {
  ActivityLine,
  CollectionDetail,
  CollectionManagers,
  CollectionView,
  Tokens,
} from '@fdv/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * Collection managers (0.9.0, the owner's decision of 13 Nov 2026; 0095),
 * through the API as each kind of caller, and in the database as the
 * application role.
 *
 * A collection's maker chooses people of the family who can see it to
 * manage it too. Every manager may always rename it, put documents in and
 * take them out, and its checklist; three switches, each off unless turned
 * on, say whether they may also change who it is for, delete it, or choose
 * managers. A manager gives another only what they may do themselves, and
 * nobody takes the maker away. Nothing a manager does widens who sees a
 * document.
 */

type Person = 'owner' | 'adult' | 'ada' | 'teen' | 'viewer';
type Switches = { may_change_audience: boolean; may_delete: boolean; may_choose_managers: boolean };
type Action =
  | 'rename'
  | 'add'
  | 'remove'
  | 'checklist_put'
  | 'checklist_post'
  | 'checklist_add'
  | 'audience'
  | 'delete'
  | 'managers';

const ACTIONS: Action[] = [
  'rename',
  'add',
  'remove',
  'checklist_put',
  'checklist_post',
  'checklist_add',
  'audience',
  'managers',
  // Last: it takes the collection away.
  'delete',
];

/** What each action answers when it is allowed. */
const DONE: Record<Action, number> = {
  rename: 200,
  add: 200,
  remove: 204,
  checklist_put: 200,
  checklist_post: 200,
  checklist_add: 200,
  audience: 200,
  delete: 204,
  managers: 201,
};

/** UUIDs, which a negative pattern must never match by chance, taken out first. */
const unUuid = (s: string) =>
  s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>');

describe.skipIf(!testAdminUrl())('collection managers', () => {
  let h: Harness;
  const people = {} as Record<Person, Tokens>;
  const accounts = {} as Record<Person, string>;
  /** Everyone's, a second one of everyone's, the adults', the owner's Only me. */
  const docs = { household: '', second: '', adults: '', ownerPrivate: '', adaPrivate: '' };

  const json = <T>(r: { json: () => unknown }) => r.json() as T;
  let nth = 0;
  const call = (
    who: Person | Tokens,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    payload?: object,
  ) =>
    h.app.inject({
      method,
      url,
      headers: h.as(typeof who === 'string' ? people[who] : who),
      remoteAddress: `10.95.${(++nth >> 8) & 0xff}.${nth & 0xff}`,
      ...(payload ? { payload } : {}),
    });
  const ok = async <T>(res: Promise<{ statusCode: number; body: string; json: () => unknown }>) => {
    const r = await res;
    expect(r.statusCode, r.body).toBeLessThan(300);
    return r.statusCode === 204 ? (undefined as T) : json<T>(r);
  };
  const member = (who: Person) => people[who].member_id;

  /** A collection the owner made, for `audience`, with everyone's document in it. */
  const made = async (name: string, audience = 'everyone', by: Person | Tokens = 'owner') => {
    const c = await ok<CollectionDetail>(
      call(by, 'POST', '/api/v1/collections', { name, audience }),
    );
    await ok(
      call(by, 'POST', `/api/v1/collections/${c.id}/items`, { document_ids: [docs.household] }),
    );
    return c.id;
  };
  const makeManager = (
    id: string,
    who: Person,
    switches: Partial<Switches> = {},
    by: Person = 'owner',
  ) =>
    ok<CollectionManagers>(
      call(by, 'POST', `/api/v1/collections/${id}/managers`, {
        member_id: member(who),
        ...switches,
      }),
    );

  /** One action on collection `id`, as `who`. */
  const act = (who: Person, id: string, action: Action) => {
    const c = `/api/v1/collections/${id}`;
    switch (action) {
      case 'rename':
        return call(who, 'PATCH', c, { name: `Renamed ${++nth}`, description: 'New words' });
      case 'add':
        return call(who, 'POST', `${c}/items`, { document_ids: [docs.second] });
      case 'remove':
        return call(who, 'DELETE', `${c}/items/${docs.household}`);
      case 'checklist_put':
        return call(who, 'PUT', `${c}/checklist`, { items: [] });
      case 'checklist_post':
        return call(who, 'POST', `${c}/checklist`, { items: [] });
      case 'checklist_add':
        return call(who, 'POST', `${c}/checklist/add`, { document_ids: [docs.second] });
      case 'audience':
        return call(who, 'PATCH', c, { audience: 'teens' });
      case 'delete':
        return call(who, 'DELETE', c);
      case 'managers':
        return call(who, 'POST', `${c}/managers`, { member_id: member('teen') });
    }
  };

  const activity = async (who: Person) =>
    json<{ items: ActivityLine[] }>(await call(who, 'GET', '/api/v1/audit?limit=100')).items.map(
      (l) => l.text,
    );

  beforeAll(async () => {
    h = await createHarness();
    people.owner = await h.setup({ display_name: 'Olive' });
    people.adult = await h.join(people.owner, {
      name: 'Sam',
      email: 'managers-sam@example.test',
      role: 'adult',
    });
    people.ada = await h.join(people.owner, {
      name: 'Ada',
      email: 'managers-ada@example.test',
      role: 'adult',
    });
    people.teen = await h.join(people.owner, {
      name: 'Tia',
      email: 'managers-tia@example.test',
      role: 'teen',
    });
    people.viewer = await h.join(people.owner, {
      name: 'Vic',
      email: 'managers-vic@example.test',
      role: 'viewer',
    });
    for (const who of Object.keys(people) as Person[]) {
      accounts[who] = json<{ account_id: string }>(await call(who, 'GET', '/api/v1/me')).account_id;
    }
    const file = async (who: Person, title: string, visibility: string) =>
      (
        await ok<{ id: string }>(
          call(who, 'POST', '/api/v1/documents', {
            title,
            type_key: 'utility_bill',
            owner_member_id: member(who),
            visibility,
          }),
        )
      ).id;
    docs.household = await file('owner', 'Council tax bill', 'household');
    docs.second = await file('owner', 'Water bill', 'household');
    docs.adults = await file('owner', 'Mortgage offer', 'adults');
    docs.ownerPrivate = await file('owner', 'Solicitor’s letter', 'private');
    docs.adaPrivate = await file('ada', 'Ada’s own papers', 'private');
  });
  afterAll(async () => {
    await h.close();
  });

  it('says what each caller may do, and who manages it, to the family alone', async () => {
    const id = await made('Who may');
    await makeManager(id, 'ada', { may_delete: true });
    const as = async (who: Person) => {
      const r = await call(who, 'GET', `/api/v1/collections/${id}`);
      return r.statusCode === 200 ? json<CollectionView>(r) : null;
    };
    expect((await as('owner'))?.my_powers).toEqual({
      maker: true,
      manager: false,
      edit: true,
      change_audience: true,
      delete: true,
      choose_managers: true,
      remove_managers: true,
    });
    expect((await as('ada'))?.my_powers).toEqual({
      maker: false,
      manager: true,
      edit: true,
      change_audience: false,
      delete: true,
      choose_managers: false,
      remove_managers: false,
    });
    expect((await as('adult'))?.my_powers).toEqual({
      maker: false,
      manager: false,
      edit: false,
      change_audience: false,
      delete: false,
      choose_managers: false,
      remove_managers: false,
    });
    for (const who of ['owner', 'ada', 'adult', 'teen'] as const) {
      expect((await as(who))?.managers, who).toEqual([
        expect.objectContaining({
          member_id: member('ada'),
          display_name: 'Ada',
          may_change_audience: false,
          may_delete: true,
          may_choose_managers: false,
        }),
      ]);
    }
    // In the list too.
    const listed = json<{ items: CollectionView[] }>(
      await call('ada', 'GET', '/api/v1/collections'),
    );
    expect(listed.items.find((c) => c.id === id)?.my_powers?.manager).toBe(true);
    // A viewer it is granted to (5.33) is told nobody manages it, and is refused the list.
    await h.decider(people.owner);
    const granted = await call('owner', 'PUT', `/api/v1/members/${member('viewer')}/access`, {
      collections: [id],
    });
    expect(granted.statusCode, granted.body).toBe(200);
    const seen = json<CollectionView>(await call('viewer', 'GET', `/api/v1/collections/${id}`));
    expect(seen.managers).toBeNull();
    expect(seen.my_powers?.edit).toBe(false);
    await h.decider(people.owner);
    await call('owner', 'DELETE', `/api/v1/members/${member('viewer')}/access`);
    expect((await call('viewer', 'GET', `/api/v1/collections/${id}/managers`)).statusCode).toBe(
      403,
    );
    // Who could be one: the family with a sign-in in its audience, never the
    // maker, a manager already or a viewer.
    const offered = await ok<CollectionManagers>(
      call('owner', 'GET', `/api/v1/collections/${id}/managers`),
    );
    expect(offered.eligible.map((e) => e.display_name)).toEqual(['Sam', 'Tia']);
    // Somebody who may not choose is offered nobody.
    expect(
      (await ok<CollectionManagers>(call('ada', 'GET', `/api/v1/collections/${id}/managers`)))
        .eligible,
    ).toEqual([]);
  });

  // The full matrix: maker, a manager with each of the eight combinations of
  // switches, somebody of the family who is not one, and a viewer — each
  // action tried on a collection of its own.
  const combos: Switches[] = [false, true].flatMap((a) =>
    [false, true].flatMap((d) =>
      [false, true].map((c) => ({ may_change_audience: a, may_delete: d, may_choose_managers: c })),
    ),
  );
  type Case = { label: string; who: Person; switches: Switches | null; may: Action[] };
  const cases: Case[] = [
    { label: 'its maker', who: 'owner', switches: null, may: ACTIONS },
    ...combos.map((s): Case => ({
      label: `a manager ${JSON.stringify(s)}`,
      who: 'ada',
      switches: s,
      may: ACTIONS.filter(
        (a) =>
          !['audience', 'delete', 'managers'].includes(a) ||
          (a === 'audience' && s.may_change_audience) ||
          (a === 'delete' && s.may_delete) ||
          (a === 'managers' && s.may_choose_managers),
      ),
    })),
    { label: 'somebody of the family who is not a manager', who: 'adult', switches: null, may: [] },
    { label: 'a viewer', who: 'viewer', switches: null, may: [] },
  ];
  for (const c of cases) {
    it(`the permission matrix: ${c.label}`, { timeout: 60_000 }, async () => {
      for (const action of ACTIONS) {
        const id = await made(`Matrix ${action} ${++nth}`);
        if (c.switches) await makeManager(id, c.who, c.switches);
        const res = await act(c.who, id, action);
        if (c.may.includes(action)) {
          expect(res.statusCode, `${action}: ${res.body}`).toBe(DONE[action]);
        } else {
          expect(res.statusCode, `${action}: ${res.body}`).toBe(403);
        }
        // What was refused changed nothing.
        if (!c.may.includes(action)) {
          const now = json<CollectionDetail>(
            await call('owner', 'GET', `/api/v1/collections/${id}`),
          );
          expect(now.name, action).toMatch(/^Matrix /);
          expect(now.audience, action).toBe('everyone');
          expect(
            now.items.map((i) => i.document.id),
            action,
          ).toEqual([docs.household]);
          expect(now.managers?.length ?? 0, action).toBe(c.switches ? 1 : 0);
        }
      }
    });
  }

  it('a refusal says why, in plain words', async () => {
    const id = await made('Why not');
    await makeManager(id, 'ada');
    const message = async (who: Person, action: Action) =>
      json<{ error: { message: string } }>(await act(who, id, action)).error.message;
    expect(await message('ada', 'audience')).toBe(
      'You manage this collection, but only the person who made it, or a manager they let, can change who it’s for.',
    );
    expect(await message('ada', 'delete')).toBe(
      'You manage this collection, but only the person who made it, or a manager they let, can delete it.',
    );
    expect(await message('ada', 'managers')).toBe(
      'Only the person who made this collection, or a manager they let, can choose who manages it.',
    );
    expect(await message('adult', 'rename')).toBe(
      'Only the person who made this collection, or someone they chose to manage it, can change it.',
    );
  });

  it('a manager gives only what they may do themselves, and never takes the maker away', async () => {
    const id = await made('Only what you have');
    await makeManager(id, 'ada', { may_choose_managers: true });
    const as = (body: object) =>
      call('ada', 'POST', `/api/v1/collections/${id}/managers`, {
        member_id: member('adult'),
        ...body,
      });
    for (const s of ['may_change_audience', 'may_delete'] as const) {
      const r = await as({ [s]: true });
      expect(r.statusCode, s).toBe(403);
      expect(json<{ error: { message: string } }>(r).error.message).toBe(
        'You can only let a manager do what you can do yourself.',
      );
    }
    // What they have, they give.
    expect((await as({ may_choose_managers: true })).statusCode).toBe(201);
    // Nor turned on later.
    const raised = await call(
      'ada',
      'PATCH',
      `/api/v1/collections/${id}/managers/${member('adult')}`,
      {
        may_delete: true,
      },
    );
    expect(raised.statusCode).toBe(403);
    // Its maker gives anything; then Ada may take it away again (taking is not giving).
    await ok(
      call('owner', 'PATCH', `/api/v1/collections/${id}/managers/${member('adult')}`, {
        may_delete: true,
      }),
    );
    const lowered = await ok<CollectionManagers>(
      call('ada', 'PATCH', `/api/v1/collections/${id}/managers/${member('adult')}`, {
        may_delete: false,
      }),
    );
    expect(lowered.items.find((m) => m.member_id === member('adult'))?.may_delete).toBe(false);
    // Nor can anybody grant themselves more.
    expect(
      (
        await call('ada', 'PATCH', `/api/v1/collections/${id}/managers/${member('ada')}`, {
          may_delete: true,
        })
      ).statusCode,
    ).toBe(403);
    // The maker: not a manager, not to be taken away, not to be made one.
    for (const [method, url, body] of [
      ['DELETE', `/api/v1/collections/${id}/managers/${member('owner')}`, undefined],
      ['PATCH', `/api/v1/collections/${id}/managers/${member('owner')}`, { may_delete: false }],
      ['POST', `/api/v1/collections/${id}/managers`, { member_id: member('owner') }],
    ] as const) {
      const r = await call('ada', method, url, body);
      expect(r.statusCode, `${method} ${url}`).toBe(422);
      expect(json<{ error: { message: string } }>(r).error.message).toMatch(
        /made this collection can already do everything/,
      );
    }
    // A manager who may choose takes another away.
    expect(
      (await call('ada', 'DELETE', `/api/v1/collections/${id}/managers/${member('adult')}`))
        .statusCode,
    ).toBe(204);
    expect(
      (await call('ada', 'DELETE', `/api/v1/collections/${id}/managers/${member('adult')}`))
        .statusCode,
    ).toBe(404);
  });

  it('only somebody of the family with a sign-in who can already see it is made a manager', async () => {
    const forAdults = await made('For the adults', 'adults');
    const refused = async (id: string, memberId: string) => {
      const r = await call('owner', 'POST', `/api/v1/collections/${id}/managers`, {
        member_id: memberId,
      });
      expect(r.statusCode, r.body).toBe(422);
      return json<{ error: { message: string } }>(r).error.message;
    };
    expect(await refused(forAdults, member('teen'))).toBe(
      'Tia can’t manage this collection: only someone in the family with a sign-in who can already see it can.',
    );
    expect(await refused(forAdults, member('viewer'))).toMatch(/^Vic can’t manage this collection/);
    expect(await refused(forAdults, '00000000-0000-4000-8000-000000000000')).toMatch(
      /^That person can’t manage this collection/,
    );
    // Somebody with no sign-in at all.
    const nobody = await ok<{ id: string }>(
      call('owner', 'POST', '/api/v1/members', { display_name: 'Grandad' }),
    );
    expect(await refused(forAdults, nobody.id)).toMatch(/^Grandad can’t/);
    // An Only me collection has none.
    const own = await made('Mine alone', 'only_me');
    expect(await refused(own, member('ada'))).toMatch(/^Ada can’t manage/);
    // Twice is a conflict.
    await makeManager(forAdults, 'ada');
    expect(
      (
        await call('owner', 'POST', `/api/v1/collections/${forAdults}/managers`, {
          member_id: member('ada'),
        })
      ).statusCode,
    ).toBe(409);
  });

  it('made for fewer people, its managers outside it go, in the same change, and the log says so', async () => {
    const id = await made('Narrowing');
    await makeManager(id, 'teen');
    await makeManager(id, 'ada', { may_change_audience: true });
    await makeManager(id, 'adult');
    // A manager may not make it Only me.
    const onlyMe = await call('ada', 'PATCH', `/api/v1/collections/${id}`, { audience: 'only_me' });
    expect(onlyMe.statusCode).toBe(403);
    expect(json<{ error: { message: string } }>(onlyMe).error.message).toBe(
      'Only the person who made this collection can make it Only me.',
    );
    // Ada, let change who it is for, makes it the adults': Tia goes.
    const narrowed = await ok<CollectionDetail>(
      call('ada', 'PATCH', `/api/v1/collections/${id}`, { audience: 'adults' }),
    );
    expect(narrowed.managers?.map((m) => m.display_name)).toEqual(['Ada', 'Sam']);
    expect(await activity('owner')).toContain(
      'Tia no longer manages the collection “Narrowing”: Ada changed who it is for',
    );
    // Tia, outside it, is told nothing of it — not even that she went.
    expect((await activity('teen')).some((l) => unUuid(l).includes('Narrowing'))).toBe(false);
    // Its maker makes it Only me: nobody but them.
    const alone = await ok<CollectionDetail>(
      call('owner', 'PATCH', `/api/v1/collections/${id}`, { audience: 'only_me' }),
    );
    expect(alone.managers).toEqual([]);
    const lines = await activity('owner');
    expect(lines).toContain(
      'Ada no longer manages the collection “Narrowing”: Olive changed who it is for',
    );
    expect(lines).toContain(
      'Sam no longer manages the collection “Narrowing”: Olive changed who it is for',
    );
    // Ada and Sam see nothing of it now.
    expect((await call('ada', 'GET', `/api/v1/collections/${id}`)).statusCode).toBe(404);
  });

  it('a manager whose role moves outside it, or whose sign-in goes, is a manager no more', async () => {
    const kim = await h.join(people.owner, {
      name: 'Kim',
      email: 'managers-kim@example.test',
      role: 'adult',
    });
    const id = await made('Role moves', 'adults');
    await ok(
      call('owner', 'POST', `/api/v1/collections/${id}/managers`, { member_id: kim.member_id }),
    );
    const role = await call('owner', 'POST', `/api/v1/members/${kim.member_id}/role`, {
      role: 'teen',
    });
    expect(role.statusCode, role.body).toBe(200);
    expect(
      (await ok<CollectionManagers>(call('owner', 'GET', `/api/v1/collections/${id}/managers`)))
        .items,
    ).toEqual([]);
  });

  it('nothing hidden leaks through a manager: not a count, an ETag, an add or a removal', async () => {
    // The owner's collection holds the owner's Only me document and the adults'.
    const id = await made('Leaks', 'everyone');
    await ok(
      call('owner', 'POST', `/api/v1/collections/${id}/items`, {
        document_ids: [docs.ownerPrivate, docs.adults],
      }),
    );
    await makeManager(id, 'teen');
    await makeManager(id, 'ada');
    const owners = json<CollectionDetail>(await call('owner', 'GET', `/api/v1/collections/${id}`));
    const adas = json<CollectionDetail>(await call('ada', 'GET', `/api/v1/collections/${id}`));
    const tias = json<CollectionDetail>(await call('teen', 'GET', `/api/v1/collections/${id}`));
    expect(owners.item_count).toBe(3);
    expect(adas.item_count).toBe(2);
    expect(tias.item_count).toBe(1);
    expect(adas.items.map((i) => i.document.id)).not.toContain(docs.ownerPrivate);
    // The same ETag for everybody.
    expect(new Set([owners.etag, adas.etag, tias.etag]).size).toBe(1);
    const body = JSON.stringify(tias);
    expect(unUuid(body)).not.toMatch(/Solicitor|Mortgage offer|"item_count":3/);
    // Taking out one they cannot see is answered as one that does not exist.
    const nowhere = '00000000-0000-4000-8000-000000000001';
    const strip = (r: { statusCode: number; body: string }) => ({
      status: r.statusCode,
      body: unUuid(r.body).replace(/"request_id":"[^"]*"/, ''),
    });
    for (const [who, hidden] of [
      ['teen', docs.adults],
      ['teen', docs.ownerPrivate],
      ['ada', docs.ownerPrivate],
    ] as const) {
      const out = await call(who, 'DELETE', `/api/v1/collections/${id}/items/${hidden}`);
      expect(strip(out), `${who} ${hidden}`).toEqual(
        strip(await call(who, 'DELETE', `/api/v1/collections/${id}/items/${nowhere}`)),
      );
      expect(out.statusCode).toBe(404);
    }
    // Nor put in what they cannot open: the owner's Only me is not theirs to add.
    const add = await call('ada', 'POST', `/api/v1/collections/${id}/items`, {
      document_ids: [docs.ownerPrivate],
    });
    expect(add.statusCode).toBe(404);
    const fromList = await ok<{ added: string[]; skipped: Array<{ why: string }> }>(
      call('teen', 'POST', `/api/v1/collections/${id}/checklist/add`, {
        document_ids: [docs.adults],
      }),
    );
    expect(fromList.added).toEqual([]);
    expect(fromList.skipped).toEqual([expect.objectContaining({ why: 'not_found' })]);
    // Ada's own Only me document, put in by her: still hers alone.
    await ok(
      call('ada', 'POST', `/api/v1/collections/${id}/items`, { document_ids: [docs.adaPrivate] }),
    );
    expect(
      json<CollectionDetail>(await call('owner', 'GET', `/api/v1/collections/${id}`)).item_count,
    ).toBe(3);
    // Everything is still there for the owner.
    const after = json<CollectionDetail>(await call('owner', 'GET', `/api/v1/collections/${id}`));
    expect(after.items.map((i) => i.document.id).sort()).toEqual(
      [docs.household, docs.ownerPrivate, docs.adults].sort(),
    );
    // A teen manager is told who of its audience cannot see what they see.
    expect(tias.items.every((i) => i.hint === null)).toBe(true);
    expect(adas.items.find((i) => i.document.id === docs.adults)?.hint).toBe(
      'Teens in this collection’s audience can’t see this one.',
    );
  });

  it('every change records who made it; being made a manager, changed and taken away are in the person’s activity; the maker is told', async () => {
    const id = await made('Logged');
    const jobs = h.jobs.length;
    await makeManager(id, 'ada', { may_choose_managers: true });
    // The maker made Ada one: nobody to tell.
    expect(h.jobs.slice(jobs).filter((j) => j.name === 'alert.send')).toEqual([]);
    // Ada makes Sam one: the maker is told, without the collection's name.
    await makeManager(id, 'adult', {}, 'ada');
    const told = h.jobs.slice(jobs).filter((j) => j.name === 'alert.send');
    expect(told).toHaveLength(1);
    expect(told[0]?.data).toMatchObject({
      account_ids: [accounts.owner],
      subject: 'Someone else now manages one of your collections',
    });
    expect(JSON.stringify(told[0]?.data)).not.toContain('Logged');
    expect(String(told[0]?.data.body)).toContain('Ada made Sam a manager');

    await ok(call('ada', 'PATCH', `/api/v1/collections/${id}`, { name: 'Logged still' }));
    await ok(
      call('owner', 'PATCH', `/api/v1/collections/${id}/managers/${member('adult')}`, {
        may_delete: true,
      }),
    );
    await ok(call('owner', 'DELETE', `/api/v1/collections/${id}/managers/${member('adult')}`));
    const want = [
      'Olive made Ada a manager of the collection “Logged still” (can also choose managers)',
      'Ada made Sam a manager of the collection “Logged still”',
      'Ada renamed a collection, now “Logged still”',
      'Olive changed what Sam can do as a manager of the collection “Logged still” (can also delete it)',
      'Olive stopped Sam managing the collection “Logged still”',
    ];
    for (const who of ['owner', 'ada', 'adult', 'teen'] as const) {
      const lines = await activity(who);
      for (const w of want) expect(lines, `${who}: ${w}`).toContain(w);
    }
    // Who did it, by account, in the log itself.
    const admin = createPool(h.adminUrl, 1);
    try {
      const { rows } = await admin.query<{ action: string; actor_account_id: string }>(
        `select action, actor_account_id from audit_event
          where object_id = $1 and action in ('collection.renamed', 'collection.manager_added')
          order by id`,
        [id],
      );
      expect(rows).toEqual([
        { action: 'collection.manager_added', actor_account_id: accounts.owner },
        { action: 'collection.manager_added', actor_account_id: accounts.ada },
        { action: 'collection.renamed', actor_account_id: accounts.ada },
      ]);
    } finally {
      await admin.end();
    }
  });

  it('a manager never pushes its maker out of their own collection (the review, B1)', async () => {
    // Tia, a teen, makes one for Everyone and lets Ada change who it is for.
    const id = await made('Tia’s, for everyone', 'everyone', 'teen');
    await makeManager(id, 'ada', { may_change_audience: true }, 'teen');
    const r = await call('ada', 'PATCH', `/api/v1/collections/${id}`, { audience: 'adults' });
    expect(r.statusCode, r.body).toBe(422);
    expect(json<{ error: { message: string } }>(r).error.message).toBe(
      'That would leave Tia unable to see their own collection.',
    );
    // Nothing changed: still Everyone, still Ada's to manage, still Tia's.
    const now = json<CollectionDetail>(await call('teen', 'GET', `/api/v1/collections/${id}`));
    expect(now.audience).toBe('everyone');
    expect(now.my_powers?.choose_managers).toBe(true);
    expect(now.managers?.map((m) => m.display_name)).toEqual(['Ada']);
    // To an audience Tia is in, Ada may.
    await ok(call('ada', 'PATCH', `/api/v1/collections/${id}`, { audience: 'teens' }));
  });

  it('an owner deletes one nobody may delete any more, and takes its managers away while its maker cannot (the review, S1)', async () => {
    const jo = await h.join(people.owner, {
      name: 'Jo',
      email: 'managers-jo@example.test',
      role: 'adult',
    });
    const id = await made('Jo’s, managed', 'everyone', jo);
    const other = await made('Jo’s other', 'everyone', jo);
    await ok(call(jo, 'POST', `/api/v1/collections/${id}/managers`, { member_id: member('ada') }));
    await ok(
      call(jo, 'POST', `/api/v1/collections/${other}/managers`, {
        member_id: member('adult'),
        may_delete: true,
      }),
    );
    const powers = async (c: string) =>
      json<CollectionView>(await call('owner', 'GET', `/api/v1/collections/${c}`)).my_powers;
    // While Jo can sign in, nothing of either is the owner's.
    expect(await powers(id)).toMatchObject({ delete: false, remove_managers: false });
    expect(
      (await call('owner', 'DELETE', `/api/v1/collections/${id}/managers/${member('ada')}`))
        .statusCode,
    ).toBe(403);
    expect(
      (await call('owner', 'DELETE', `/api/v1/members/${jo.member_id}/sign-in`)).statusCode,
    ).toBe(204);
    // Ada manages it, but may not delete it: the owner may — and may take her away.
    expect(await powers(id)).toMatchObject({
      delete: true,
      remove_managers: true,
      choose_managers: false,
    });
    // Never add one, nor give anything.
    expect(
      (
        await call('owner', 'POST', `/api/v1/collections/${id}/managers`, {
          member_id: member('teen'),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await call('owner', 'PATCH', `/api/v1/collections/${id}/managers/${member('ada')}`, {
          may_delete: true,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await call('owner', 'DELETE', `/api/v1/collections/${id}/managers/${member('ada')}`))
        .statusCode,
    ).toBe(204);
    expect((await call('owner', 'DELETE', `/api/v1/collections/${id}`)).statusCode).toBe(204);
    // Sam may delete the other: not the owner's — until Sam no longer manages it.
    expect(await powers(other)).toMatchObject({ delete: false, remove_managers: true });
    const refused = await call('owner', 'DELETE', `/api/v1/collections/${other}`);
    expect(refused.statusCode, refused.body).toBe(403);
    await ok(call('owner', 'DELETE', `/api/v1/collections/${other}/managers/${member('adult')}`));
    expect((await call('owner', 'DELETE', `/api/v1/collections/${other}`)).statusCode).toBe(204);
  });

  it('a manager let go by a role change, or by their sign-in going, is a line in the log (the review, M1)', async () => {
    const kai = await h.join(people.owner, {
      name: 'Kai',
      email: 'managers-kai@example.test',
      role: 'adult',
    });
    const mo = await h.join(people.owner, {
      name: 'Mo',
      email: 'managers-mo@example.test',
      role: 'adult',
    });
    const grown = await made('For the grown-ups', 'adults');
    const family = await made('For the family', 'everyone');
    for (const c of [grown, family]) {
      for (const who of [kai, mo]) {
        await ok(
          call('owner', 'POST', `/api/v1/collections/${c}/managers`, { member_id: who.member_id }),
        );
      }
    }
    // Kai made a teen: out of the grown-ups' alone.
    const role = await call('owner', 'POST', `/api/v1/members/${kai.member_id}/role`, {
      role: 'teen',
    });
    expect(role.statusCode, role.body).toBe(200);
    // Mo's sign-in taken away: out of both.
    expect(
      (await call('owner', 'DELETE', `/api/v1/members/${mo.member_id}/sign-in`)).statusCode,
    ).toBe(204);
    const lines = await activity('owner');
    expect(lines).toContain(
      'Kai no longer manages the collection “For the grown-ups”: Olive changed their role',
    );
    expect(lines.filter((l) => l.startsWith('Kai no longer manages'))).toHaveLength(1);
    for (const name of ['For the grown-ups', 'For the family']) {
      expect(lines).toContain(
        `Mo no longer manages the collection “${name}”: Olive took away their sign-in`,
      );
    }
    const left = await ok<CollectionManagers>(
      call('owner', 'GET', `/api/v1/collections/${family}/managers`),
    );
    expect(left.items.map((m) => m.display_name)).toEqual(['Kai']);
  });

  it('a manager whose sign-in is locked has no power, is chosen by nobody, and does not stop an owner’s delete (the review, M2)', async () => {
    const lou = await h.join(people.owner, {
      name: 'Lou',
      email: 'managers-lou@example.test',
      role: 'adult',
    });
    const jay = await h.join(people.owner, {
      name: 'Jay',
      email: 'managers-jay@example.test',
      role: 'adult',
    });
    const id = await made('Jay’s, Lou locked', 'everyone', jay);
    await ok(
      call(jay, 'POST', `/api/v1/collections/${id}/managers`, {
        member_id: lou.member_id,
        may_delete: true,
      }),
    );
    await h.decider(people.owner);
    const locked = await call('owner', 'POST', `/api/v1/members/${lou.member_id}/lock`, {});
    expect(locked.statusCode, locked.body).toBe(200);
    // Not offered, nor taken, as a new manager anywhere.
    const fresh = await made('Lou is not offered');
    const offered = await ok<CollectionManagers>(
      call('owner', 'GET', `/api/v1/collections/${fresh}/managers`),
    );
    expect(offered.eligible.map((e) => e.display_name)).not.toContain('Lou');
    const chosen = await call('owner', 'POST', `/api/v1/collections/${fresh}/managers`, {
      member_id: lou.member_id,
    });
    expect(chosen.statusCode, chosen.body).toBe(422);
    // Jay's sign-in gone, Lou's may_delete counts for nothing: the owner may delete it.
    expect(
      (await call('owner', 'DELETE', `/api/v1/members/${jay.member_id}/sign-in`)).statusCode,
    ).toBe(204);
    expect(
      json<CollectionView>(await call('owner', 'GET', `/api/v1/collections/${id}`)).my_powers
        ?.delete,
    ).toBe(true);
    expect((await call('owner', 'DELETE', `/api/v1/collections/${id}`)).statusCode).toBe(204);
    await h.decider(people.owner);
    await call('owner', 'DELETE', `/api/v1/members/${lou.member_id}/lock`);
  });

  describe('in the database, as the application role', () => {
    let one: Db;
    const principal = (who: Person) => ({
      householdId: people[who].household_id,
      accountId: accounts[who],
      memberId: people[who].member_id,
      role: people[who].role,
    });
    beforeAll(() => {
      one = createDb(createPool(h.appUrl, 1));
    });
    afterAll(async () => {
      await one.destroy();
    });
    const insert = (who: Person, collection: string, target: Person, s: Partial<Switches> = {}) =>
      withPrincipal(one, principal(who), (trx) =>
        trx
          .insertInto('doc_collection_manager')
          .values({
            collection_id: collection,
            household_id: people.owner.household_id,
            member_id: member(target),
            ...s,
          })
          .execute(),
      );
    const update = (who: Person, id: string, set: Record<string, unknown>) =>
      withPrincipal(one, principal(who), async (trx) =>
        Number(
          (await trx.updateTable('doc_collection').set(set).where('id', '=', id).executeTakeFirst())
            .numUpdatedRows,
        ),
      );

    it('only its maker, or a manager who may choose managers, writes its managers; each one somebody who may be', async () => {
      const id = await made('In the database');
      // Somebody who is not a manager writes none.
      await expect(insert('adult', id, 'teen')).rejects.toThrow(
        /row-level security|only its maker, or a manager who may choose managers/,
      );
      // The maker may not make a viewer one, nor themselves.
      await expect(insert('owner', id, 'viewer')).rejects.toThrow(
        /somebody of the family with a sign-in who can see the collection/,
      );
      await expect(insert('owner', id, 'owner')).rejects.toThrow(/not one of its managers/);
      // The maker makes Ada one, who may choose managers but not delete.
      await insert('owner', id, 'ada', { may_choose_managers: true });
      await expect(insert('ada', id, 'adult', { may_delete: true })).rejects.toThrow(
        /gives another only what they may do themselves/,
      );
      await insert('ada', id, 'adult');
      // Nor turns one on later.
      await expect(
        withPrincipal(one, principal('ada'), (trx) =>
          trx
            .updateTable('doc_collection_manager')
            .set({ may_change_audience: true })
            .where('collection_id', '=', id)
            .where('member_id', '=', member('adult'))
            .execute(),
        ),
      ).rejects.toThrow(/gives another only what they may do themselves/);
      // A manager who may not choose writes nothing.
      const removed = await withPrincipal(one, principal('adult'), async (trx) =>
        Number(
          (
            await trx
              .deleteFrom('doc_collection_manager')
              .where('collection_id', '=', id)
              .executeTakeFirst()
          ).numDeletedRows,
        ),
      );
      expect(removed).toBe(0);
      // A viewer, and a share link, read none.
      const read = (who: Person) =>
        withPrincipal(one, principal(who), (trx) =>
          trx.selectFrom('doc_collection_manager').selectAll().execute(),
        );
      expect(await read('viewer')).toEqual([]);
      expect((await read('teen')).length).toBeGreaterThan(0);
    });

    it('a manager changes its name and words, who it is for and delete it only with their switches, never its maker', async () => {
      const id = await made('Row rules');
      await insert('owner', id, 'ada');
      expect(await update('ada', id, { name: 'Ada renamed it', updated_at: new Date() })).toBe(1);
      await expect(update('ada', id, { audience: 'adults' })).rejects.toThrow(
        /only its maker changes a collection/,
      );
      await expect(update('ada', id, { deleted_at: new Date() })).rejects.toThrow(
        /only its maker, or a manager its maker lets, deletes a collection/,
      );
      await expect(update('ada', id, { owner_member_id: member('ada') })).rejects.toThrow(
        /keeps its maker and its household/,
      );
      // Not a manager: not given it to change at all.
      expect(await update('adult', id, { name: 'Taken' })).toBe(0);
      // With the switches.
      await withPrincipal(one, principal('owner'), (trx) =>
        trx
          .updateTable('doc_collection_manager')
          .set({ may_change_audience: true, may_delete: true })
          .where('collection_id', '=', id)
          .execute(),
      );
      // Never Only me, which is its maker's alone.
      await expect(update('ada', id, { audience: 'only_me' })).rejects.toThrow(
        /row-level security|only its maker changes/,
      );
      expect(await update('ada', id, { audience: 'adults' })).toBe(1);
      expect(await update('ada', id, { deleted_at: new Date() })).toBe(1);
    });

    it('a manager never makes it for people its maker is not one of (B1)', async () => {
      const id = await made('A teen’s, in the database', 'everyone', 'teen');
      await insert('teen', id, 'ada', { may_change_audience: true });
      await expect(update('ada', id, { audience: 'adults' })).rejects.toThrow(
        /only its maker changes a collection/,
      );
      expect(await update('ada', id, { audience: 'teens' })).toBe(1);
    });

    it('an owner takes managers away, and nothing more, only while its maker cannot change it (S1)', async () => {
      const zed = await h.join(people.owner, {
        name: 'Zed',
        email: 'managers-zed@example.test',
        role: 'adult',
      });
      const id = await made('Zed’s, in the database', 'everyone', zed);
      await ok(
        call(zed, 'POST', `/api/v1/collections/${id}/managers`, { member_id: member('ada') }),
      );
      const takeAway = () =>
        withPrincipal(one, principal('owner'), async (trx) =>
          Number(
            (
              await trx
                .deleteFrom('doc_collection_manager')
                .where('collection_id', '=', id)
                .executeTakeFirst()
            ).numDeletedRows,
          ),
        );
      // Zed can still change it: not the owner's.
      expect(await takeAway()).toBe(0);
      expect(
        (await call('owner', 'DELETE', `/api/v1/members/${zed.member_id}/sign-in`)).statusCode,
      ).toBe(204);
      // Nor may the owner add one, even now.
      await expect(insert('owner', id, 'teen')).rejects.toThrow(
        /row-level security|only its maker, or a manager who may choose managers/,
      );
      expect(await takeAway()).toBe(1);
      // And with nobody who may delete it, the owner marks it deleted.
      expect(await update('owner', id, { deleted_at: new Date() })).toBe(1);
    });

    it('its checklist is written by its maker or a manager, ON CONFLICT included (PG 16)', async () => {
      const id = await made('Checklist rules');
      await insert('owner', id, 'teen');
      const write = (who: Person) =>
        withPrincipal(one, principal(who), (trx) =>
          trx
            .insertInto('collection_checklist')
            .values({
              collection_id: id,
              household_id: people.owner.household_id,
              items: '[]',
            })
            .onConflict((oc) => oc.column('collection_id').doUpdateSet({ items: '[]' }))
            .execute(),
        );
      await expect(write('adult')).rejects.toThrow(/row-level security/);
      await write('teen');
      // Again: the conflicting row is checked as an update, and passes.
      await write('teen');
      await expect(write('adult')).rejects.toThrow(/row-level security/);
      const n = await withPrincipal(one, principal('adult'), async (trx) =>
        Number(
          (
            await trx
              .deleteFrom('collection_checklist')
              .where('collection_id', '=', id)
              .executeTakeFirst()
          ).numDeletedRows,
        ),
      );
      expect(n).toBe(0);
    });

    it('made for fewer people in the database, its managers outside it go too', async () => {
      const id = await made('Dropped by the database');
      await insert('owner', id, 'teen');
      await insert('owner', id, 'ada');
      expect(await update('owner', id, { audience: 'adults' })).toBe(1);
      const left = await withPrincipal(one, principal('owner'), (trx) =>
        trx
          .selectFrom('doc_collection_manager')
          .select('member_id')
          .where('collection_id', '=', id)
          .execute(),
      );
      expect(left.map((m) => m.member_id)).toEqual([member('ada')]);
      // As the owning role sees the table: nothing left behind.
      const admin = createDb(createPool(h.adminUrl, 1));
      try {
        const counted = await sql<{ n: number }>`select count(*)::int as n
            from doc_collection_manager where collection_id = ${id}::uuid`.execute(admin);
        expect(counted.rows[0]?.n).toBe(1);
      } finally {
        await admin.destroy();
      }
    });
  });
});
