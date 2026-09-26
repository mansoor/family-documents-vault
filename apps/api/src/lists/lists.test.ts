import { randomUUID } from 'node:crypto';
import { createDb, createPool, withPrincipal, withScope, type Db } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  inListAudience,
  LIST_AUDIENCES,
  LIST_HINT_PRIVATE,
  LIST_HINT_TEENS,
  ROLES,
  type ActivityLine,
  type DocumentView,
  type ListDetail,
  type ListView,
  type Tokens,
} from '@fdv/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DocumentService } from '../documents/service.js';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * Lists of documents (5.14), through the API as each role, and in the
 * database as the application role.
 *
 * A list never widens who sees a document: each reader is given the
 * documents on it they could see anyway, counted as they see them. Who a
 * list is for decides whether it exists for them at all (A17), and only
 * its maker changes it (A18).
 */

type Person = 'owner' | 'adult' | 'teen' | 'viewer';

describe.skipIf(!testAdminUrl())('lists of documents', () => {
  let h: Harness;
  const people = {} as Record<Person, Tokens>;
  const accounts = {} as Record<Person, string>;
  /** Documents of each kind: everyone's, the adults', and each adult's Only me. */
  const docs = { household: '', adults: '', ownerPrivate: '', adultPrivate: '', teenOwn: '' };
  const titles = {
    household: 'Council tax bill',
    adults: 'Mortgage offer',
    ownerPrivate: 'Solicitor’s letter',
    adultPrivate: 'Sam’s therapy notes',
    teenOwn: 'Teen’s bus pass',
  };

  const json = <T>(r: { json: () => unknown }) => r.json() as T;
  // Each request from an address of its own: the file asks more than the
  // vault's ceiling for one address in a minute.
  let nth = 0;
  /** A request as somebody: one of `people`, or anybody else's tokens. */
  const call = (
    who: Person | Tokens,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
    headers: Record<string, string> = {},
  ) =>
    h.app.inject({
      method,
      url,
      headers: { ...h.as(typeof who === 'string' ? people[who] : who), ...headers },
      remoteAddress: `10.14.${(++nth >> 8) & 0xff}.${nth & 0xff}`,
      ...(payload ? { payload } : {}),
    });
  const makeList = async (
    who: Person | Tokens,
    name: string,
    audience: string,
    documentIds: string[] = [],
  ): Promise<ListDetail> => {
    const made = await call(who, 'POST', '/api/v1/lists', { name, audience });
    expect(made.statusCode, made.body).toBe(201);
    const list = json<ListDetail>(made);
    if (documentIds.length === 0) return list;
    const added = await call(who, 'POST', `/api/v1/lists/${list.id}/items`, {
      document_ids: documentIds,
    });
    expect(added.statusCode, added.body).toBe(200);
    return json<ListDetail>(added);
  };
  const seen = async (who: Person | Tokens, id: string) => {
    const res = await call(who, 'GET', `/api/v1/lists/${id}`);
    return res.statusCode === 200 ? json<ListDetail>(res) : null;
  };
  const itemIds = (l: ListDetail | null) => l?.items.map((i) => i.document.id) ?? [];
  /** An error's body as anybody could compare it: without the request it answered. */
  const refusal = (r: { json: () => unknown; statusCode: number }): Record<string, unknown> => {
    const { error } = json<{ error: Record<string, unknown> }>(r);
    return { status: r.statusCode, ...error, request_id: null };
  };
  const activity = async (who: Person | Tokens) =>
    json<{ items: ActivityLine[] }>(await call(who, 'GET', '/api/v1/audit?limit=100')).items.map(
      (l) => l.text,
    );

  beforeAll(async () => {
    h = await createHarness();
    people.owner = await h.setup();
    people.adult = await h.join(people.owner, {
      name: 'Sam',
      email: 'lists-adult@example.test',
      role: 'adult',
    });
    people.teen = await h.join(people.owner, {
      name: 'Teen',
      email: 'lists-teen@example.test',
      role: 'teen',
    });
    people.viewer = await h.join(people.owner, {
      name: 'Viewer',
      email: 'lists-viewer@example.test',
      role: 'viewer',
    });
    for (const who of Object.keys(people) as Person[]) {
      accounts[who] = json<{ account_id: string }>(await call(who, 'GET', '/api/v1/me')).account_id;
    }
    const file = async (
      who: Person,
      key: keyof typeof docs,
      visibility: 'household' | 'adults' | 'private',
    ) => {
      const made = await call(who, 'POST', '/api/v1/documents', {
        title: titles[key],
        type_key: 'utility_bill',
        owner_member_id: people[who].member_id,
        visibility,
      });
      expect(made.statusCode, made.body).toBe(201);
      docs[key] = json<DocumentView>(made).id;
    };
    await file('owner', 'household', 'household');
    await file('owner', 'adults', 'adults');
    await file('owner', 'ownerPrivate', 'private');
    await file('adult', 'adultPrivate', 'private');
    await file('teen', 'teenOwn', 'household');
  }, 120_000);
  afterAll(() => h.close());

  it('a list is 404, not 403, outside its audience', async () => {
    const adults = await makeList('owner', 'For the accountant', 'adults', [docs.household]);
    const onlyMe = await makeList('owner', 'Divorce', 'only_me', [docs.household]);
    const nowhere = randomUUID();

    // Every way of asking about a list outside the reader's audience is
    // answered exactly as one that never was: the same code, words and all.
    const attempts = (id: string) =>
      [
        ['GET', `/api/v1/lists/${id}`, undefined],
        ['PATCH', `/api/v1/lists/${id}`, { name: 'Mine now' }],
        ['DELETE', `/api/v1/lists/${id}`, undefined],
        ['POST', `/api/v1/lists/${id}/items`, { document_ids: [docs.household] }],
        ['DELETE', `/api/v1/lists/${id}/items/${docs.household}`, undefined],
      ] as const;
    for (const [who, list] of [
      ['teen', adults],
      ['adult', onlyMe],
      ['teen', onlyMe],
    ] as const) {
      const hidden = attempts(list.id);
      const absent = attempts(nowhere);
      for (let i = 0; i < hidden.length; i++) {
        const [method, url, body] = hidden[i] as (typeof hidden)[number];
        const [, other] = absent[i] as (typeof absent)[number];
        const res = await call(who, method, url, body);
        expect(res.statusCode, `${who} ${method} ${url}`).toBe(404);
        expect(refusal(res), `${who} ${method}`).toEqual(
          refusal(await call(who, method, other, body)),
        );
      }
      // Nor is it among their lists, or the document's.
      const theirs = json<{ items: ListView[] }>(await call(who, 'GET', '/api/v1/lists')).items;
      expect(theirs.map((l) => l.id)).not.toContain(list.id);
      const ofDoc = json<{ items: ListView[] }>(
        await call(who, 'GET', `/api/v1/documents/${docs.household}/lists`),
      ).items;
      expect(ofDoc.map((l) => l.id)).not.toContain(list.id);
    }
    // And nothing was changed by any of it.
    expect(await seen('owner', adults.id)).toMatchObject({
      name: 'For the accountant',
      item_count: 1,
    });
    expect(await seen('owner', onlyMe.id)).toMatchObject({ name: 'Divorce', item_count: 1 });
  });

  it('only its maker changes a list; the rest of its audience is told so (A18)', async () => {
    const list = await makeList('owner', 'Car papers', 'everyone', [docs.household]);
    for (const who of ['adult', 'teen'] as const) {
      expect((await seen(who, list.id))?.mine).toBe(false);
      for (const [method, url, body] of [
        ['PATCH', `/api/v1/lists/${list.id}`, { name: 'Mine now' }],
        ['DELETE', `/api/v1/lists/${list.id}`, undefined],
        ['POST', `/api/v1/lists/${list.id}/items`, { document_ids: [docs.household] }],
        ['DELETE', `/api/v1/lists/${list.id}/items/${docs.household}`, undefined],
      ] as const) {
        const res = await call(who, method, url, body);
        expect(res.statusCode, `${who} ${method} ${url}`).toBe(403);
        expect(refusal(res)).toMatchObject({
          code: 'forbidden',
          message: 'Only the person who made this list can change it.',
        });
      }
    }
    expect(await seen('owner', list.id)).toMatchObject({
      name: 'Car papers',
      mine: true,
      item_count: 1,
    });
  });

  it('a viewer sees no list', async () => {
    const list = await makeList('owner', 'Everybody’s papers', 'everyone', [docs.household]);
    const teens = await makeList('owner', 'For the teens', 'teens', [docs.household]);
    const lists = await call('viewer', 'GET', '/api/v1/lists');
    expect(lists.statusCode).toBe(200);
    expect(json<{ items: ListView[] }>(lists).items).toEqual([]);
    for (const id of [list.id, teens.id]) {
      const res = await call('viewer', 'GET', `/api/v1/lists/${id}`);
      expect(refusal(res)).toEqual(
        refusal(await call('viewer', 'GET', `/api/v1/lists/${randomUUID()}`)),
      );
    }
    // A document they are given is on no list, as far as they are told.
    const ofDoc = await call('viewer', 'GET', `/api/v1/documents/${docs.household}/lists`);
    expect(ofDoc.statusCode).toBe(200);
    expect(json<{ items: ListView[] }>(ofDoc).items).toEqual([]);
    // And they make none.
    const make = await call('viewer', 'POST', '/api/v1/lists', {
      name: 'Mine',
      audience: 'everyone',
    });
    expect(refusal(make)).toMatchObject({
      status: 403,
      code: 'forbidden',
      message: 'Viewers can open and download documents, but not make lists of them.',
    });
    // Everybody else in the family sees it.
    for (const who of ['owner', 'adult', 'teen'] as const) {
      const theirs = json<{ items: ListView[] }>(await call(who, 'GET', '/api/v1/lists')).items;
      expect(
        theirs.map((l) => l.id),
        who,
      ).toEqual(expect.arrayContaining([list.id, teens.id]));
    }
  });

  it('a teen sees only the items a teen may see, and the count agrees', async () => {
    const list = await makeList('owner', 'Everything for the move', 'everyone', [
      docs.household,
      docs.adults,
      docs.ownerPrivate,
    ]);
    const expected: Record<Exclude<Person, 'viewer'>, string[]> = {
      owner: [docs.household, docs.adults, docs.ownerPrivate],
      adult: [docs.household, docs.adults],
      teen: [docs.household],
    };
    for (const who of ['owner', 'adult', 'teen'] as const) {
      const l = await seen(who, list.id);
      expect(itemIds(l), who).toEqual(expected[who]);
      expect(l?.item_count, who).toBe(expected[who].length);
      // The same count in the list of lists, and in the document's lists.
      const all = json<{ items: ListView[] }>(await call(who, 'GET', '/api/v1/lists')).items;
      expect(all.find((x) => x.id === list.id)?.item_count, who).toBe(expected[who].length);
      const ofDoc = json<{ items: ListView[] }>(
        await call(who, 'GET', `/api/v1/documents/${docs.household}/lists`),
      ).items;
      expect(ofDoc.find((x) => x.id === list.id)?.item_count, who).toBe(expected[who].length);
      // Nothing says how many are hidden: no field but these, anywhere.
      expect(Object.keys(l ?? {}).sort()).toEqual(
        [
          'audience',
          'created_at',
          'description',
          'etag',
          'has_more',
          'id',
          'item_count',
          'items',
          'mine',
          'name',
          'next_cursor',
          'owner_member_id',
          'updated_at',
        ].sort(),
      );
      // Only the maker is told who of the audience cannot see an item.
      const hints = l?.items.map((i) => i.hint);
      expect(hints, who).toEqual(
        who === 'owner'
          ? [null, LIST_HINT_TEENS, LIST_HINT_PRIVATE]
          : expected[who].map(() => null),
      );
    }
    // Every reader is given the same ETag, whatever they can see of it.
    const tags = await Promise.all(
      (['owner', 'adult', 'teen'] as const).map(async (who) => (await seen(who, list.id))?.etag),
    );
    expect(new Set(tags).size).toBe(1);
  });

  it('a private document in a household list is seen only by its owner', async () => {
    const list = await makeList('adult', 'Sam’s health', 'everyone', [
      docs.household,
      docs.adultPrivate,
    ]);
    expect(itemIds(await seen('adult', list.id))).toEqual([docs.household, docs.adultPrivate]);
    for (const who of ['owner', 'teen'] as const) {
      const l = await seen(who, list.id);
      expect(itemIds(l), who).toEqual([docs.household]);
      expect(l?.item_count, who).toBe(1);
      // The document itself is not there for them, list or no list.
      const ofDoc = await call(who, 'GET', `/api/v1/documents/${docs.adultPrivate}/lists`);
      expect(refusal(ofDoc)).toEqual(
        refusal(await call(who, 'GET', `/api/v1/documents/${randomUUID()}/lists`)),
      );
    }
    const mine = json<{ items: ListView[] }>(
      await call('adult', 'GET', `/api/v1/documents/${docs.adultPrivate}/lists`),
    ).items;
    expect(mine.map((l) => l.id)).toEqual([list.id]);
  });

  it('you cannot add what you cannot see', async () => {
    const list = await makeList('adult', 'Sam’s pile', 'everyone', [docs.household]);
    const nowhere = randomUUID();
    const add = (who: Person, id: string, ids: string[]) =>
      call(who, 'POST', `/api/v1/lists/${id}/items`, { document_ids: ids });

    // The owner's Only me document is answered as one that does not exist,
    // alone or beside one Sam can see — and then nothing is added at all.
    const hidden = await add('adult', list.id, [docs.ownerPrivate]);
    expect(hidden.statusCode).toBe(404);
    expect(refusal(hidden)).toEqual(refusal(await add('adult', list.id, [nowhere])));
    const mixed = await add('adult', list.id, [docs.adults, docs.ownerPrivate]);
    expect(refusal(mixed)).toEqual(refusal(await add('adult', list.id, [docs.adults, nowhere])));
    expect(itemIds(await seen('adult', list.id))).toEqual([docs.household]);

    // A teen cannot put the adults' document on a list of their own.
    const teens = await makeList('teen', 'My stuff', 'everyone', [docs.teenOwn]);
    const adultsDoc = await add('teen', teens.id, [docs.adults]);
    expect(refusal(adultsDoc)).toEqual(refusal(await add('teen', teens.id, [nowhere])));
    // Nor make a list for the adults, which they could not see.
    const forAdults = await call('teen', 'POST', '/api/v1/lists', {
      name: 'For the adults',
      audience: 'adults',
    });
    expect(refusal(forAdults)).toMatchObject({ status: 403, code: 'forbidden' });

    // What Sam can see goes on, in the order asked, once however often asked.
    const added = await add('adult', list.id, [docs.adults, docs.adultPrivate, docs.adults]);
    expect(added.statusCode, added.body).toBe(200);
    expect(itemIds(json<ListDetail>(added))).toEqual([
      docs.household,
      docs.adults,
      docs.adultPrivate,
    ]);
    const again = await add('adult', list.id, [docs.household]);
    expect(itemIds(json<ListDetail>(again))).toEqual([
      docs.household,
      docs.adults,
      docs.adultPrivate,
    ]);

    // Taken off: once. A second time, it is not on it.
    const off = await call('adult', 'DELETE', `/api/v1/lists/${list.id}/items/${docs.adults}`);
    expect(off.statusCode).toBe(204);
    const twice = await call('adult', 'DELETE', `/api/v1/lists/${list.id}/items/${docs.adults}`);
    expect(refusal(twice)).toMatchObject({ status: 404, code: 'not_found' });
    // The owner's Only me one is not in the vault, as far as Sam is told.
    const theirs = await call(
      'adult',
      'DELETE',
      `/api/v1/lists/${list.id}/items/${docs.ownerPrivate}`,
    );
    expect(refusal(theirs)).toEqual(
      refusal(await call('adult', 'DELETE', `/api/v1/lists/${list.id}/items/${nowhere}`)),
    );
  });

  it('trash takes an item out of every list; Bring it back returns it', async () => {
    const made = await call('owner', 'POST', '/api/v1/documents', {
      title: 'Boiler warranty',
      type_key: 'utility_bill',
    });
    const boiler = json<DocumentView>(made).id;
    const one = await makeList('owner', 'House', 'everyone', [docs.household, boiler]);
    const two = await makeList('adult', 'Repairs', 'teens', [boiler, docs.household]);
    const view = async (who: Person, id: string) => itemIds(await seen(who, id));

    expect(await view('teen', one.id)).toEqual([docs.household, boiler]);
    expect((await call('owner', 'DELETE', `/api/v1/documents/${boiler}`)).statusCode).toBe(204);
    for (const who of ['owner', 'adult', 'teen'] as const) {
      expect(await view(who, one.id), who).toEqual([docs.household]);
      expect(await view(who, two.id), who).toEqual([docs.household]);
      expect((await seen(who, two.id))?.item_count, who).toBe(1);
    }
    // In the Trash it is on no list, and cannot be put on one.
    const ofTrashed = await call('owner', 'GET', `/api/v1/documents/${boiler}/lists`);
    expect(json<{ items: ListView[] }>(ofTrashed).items).toEqual([]);
    const add = await call('owner', 'POST', `/api/v1/lists/${one.id}/items`, {
      document_ids: [boiler],
    });
    expect(add.statusCode).toBe(404);

    // Brought back, it is where it was, on both.
    const back = await call('owner', 'POST', `/api/v1/documents/${boiler}/restore`);
    expect(back.statusCode, back.body).toBe(200);
    for (const who of ['owner', 'adult', 'teen'] as const) {
      expect(await view(who, one.id), who).toEqual([docs.household, boiler]);
      expect(await view(who, two.id), who).toEqual([boiler, docs.household]);
    }
    const ofBack = json<{ items: ListView[] }>(
      await call('teen', 'GET', `/api/v1/documents/${boiler}/lists`),
    ).items;
    expect(ofBack.map((l) => l.id).sort()).toEqual([one.id, two.id].sort());
  });

  it('a document made Only me drops out for everybody else at once, and comes back when it is not', async () => {
    const made = await call('owner', 'POST', '/api/v1/documents', {
      title: 'Letter from the bank',
      type_key: 'utility_bill',
      owner_member_id: people.owner.member_id,
    });
    const letter = json<DocumentView>(made).id;
    const list = await makeList('owner', 'Money', 'everyone', [letter]);
    const visibility = (to: string) =>
      call('owner', 'POST', `/api/v1/documents/${letter}/visibility`, { visibility: to });
    expect((await visibility('private')).statusCode).toBe(200);
    for (const who of ['adult', 'teen'] as const) {
      expect(await seen(who, list.id), who).toMatchObject({ item_count: 0, items: [] });
    }
    expect(await seen('owner', list.id)).toMatchObject({ item_count: 1 });
    expect((await visibility('household')).statusCode).toBe(200);
    for (const who of ['adult', 'teen'] as const) {
      expect(itemIds(await seen(who, list.id)), who).toEqual([letter]);
    }
  });

  it('a name is tidied and 80 characters at most; a change is made to the list as it was seen', async () => {
    const make = (body: object) => call('owner', 'POST', '/api/v1/lists', body);
    expect(refusal(await make({ name: '   ', audience: 'everyone' }))).toMatchObject({
      status: 422,
      detail: 'name',
    });
    expect(refusal(await make({ name: 'x'.repeat(81), audience: 'everyone' }))).toMatchObject({
      status: 422,
      detail: 'name',
    });
    expect(refusal(await make({ name: 'No audience' }))).toMatchObject({
      status: 422,
      detail: 'audience',
    });
    const made = json<ListDetail>(
      await make({ name: '  School   forms ', audience: 'teens', description: '  For Sept  ' }),
    );
    expect(made).toMatchObject({
      name: 'School forms',
      description: 'For Sept',
      audience: 'teens',
      mine: true,
      item_count: 0,
      items: [],
    });

    const renamed = await call(
      'owner',
      'PATCH',
      `/api/v1/lists/${made.id}`,
      { name: 'School forms 2027' },
      { 'if-match': made.etag },
    );
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.headers.etag).not.toBe(made.etag);
    const stale = await call(
      'owner',
      'PATCH',
      `/api/v1/lists/${made.id}`,
      { audience: 'adults' },
      { 'if-match': made.etag },
    );
    expect(refusal(stale)).toMatchObject({ status: 409, code: 'conflict' });
    expect(JSON.parse(String(refusal(stale).detail))).toMatchObject({
      name: 'School forms 2027',
      audience: 'teens',
    });

    // Narrowed to Only me, it is gone for everybody else.
    const narrowed = await call('owner', 'PATCH', `/api/v1/lists/${made.id}`, {
      audience: 'only_me',
    });
    expect(json<ListDetail>(narrowed).audience).toBe('only_me');
    expect(await seen('adult', made.id)).toBeNull();

    // Deleted, it is gone for its maker too; its documents are untouched.
    const withDoc = await makeList('owner', 'Short-lived', 'everyone', [docs.household]);
    expect((await call('owner', 'DELETE', `/api/v1/lists/${withDoc.id}`)).statusCode).toBe(204);
    for (const who of ['owner', 'adult'] as const) expect(await seen(who, withDoc.id)).toBeNull();
    expect((await call('owner', 'GET', `/api/v1/documents/${docs.household}`)).statusCode).toBe(
      200,
    );
    expect((await call('owner', 'DELETE', `/api/v1/lists/${withDoc.id}`)).statusCode).toBe(404);
  });

  it("a list's activity lines never name a document the reader cannot see", async () => {
    const list = await makeList('owner', 'Holiday', 'everyone', [
      docs.household,
      docs.adults,
      docs.ownerPrivate,
    ]);
    await makeList('owner', 'Secret plans', 'only_me', [docs.household]);
    const adultsOnly = await makeList('owner', 'Grown-up things', 'adults', [docs.household]);
    const added = (title: string, name: string) => `Owner added “${title}” to the list “${name}”`;

    const lines = {
      owner: await activity('owner'),
      adult: await activity('adult'),
      teen: await activity('teen'),
    };
    // The list itself, to all three.
    for (const who of ['owner', 'adult', 'teen'] as const) {
      expect(lines[who], who).toContain('Owner made the list “Holiday”');
      expect(lines[who], who).toContain(added(titles.household, 'Holiday'));
    }
    // Each document's line, to whoever may see the document.
    expect(lines.owner).toContain(added(titles.adults, 'Holiday'));
    expect(lines.owner).toContain(added(titles.ownerPrivate, 'Holiday'));
    expect(lines.adult).toContain(added(titles.adults, 'Holiday'));
    for (const who of ['adult', 'teen'] as const) {
      const text = lines[who].join('\n');
      expect(text, who).not.toContain(titles.ownerPrivate);
      // Nor anything of the Only me list: not its name, not a line
      // about a document on it, not a line with no name at all.
      expect(text, who).not.toContain('Secret plans');
      expect(text, who).not.toContain('Divorce');
      expect(text, who).not.toMatch(/a list$/m);
    }
    // A list for the adults, and what is on it, is the adults'.
    expect(lines.adult).toContain(added(titles.household, 'Grown-up things'));
    expect(lines.teen.join('\n')).not.toContain(titles.adults);
    expect(lines.teen.join('\n')).not.toContain('Grown-up things');
    expect(lines.owner).toContain(added(titles.household, 'Secret plans'));

    // Taken off, one line about the document, to the same people.
    await call('owner', 'DELETE', `/api/v1/lists/${list.id}/items/${docs.adults}`);
    expect(await activity('adult')).toContain(
      `Owner took “${titles.adults}” off the list “Holiday”`,
    );
    expect((await activity('teen')).join('\n')).not.toContain(titles.adults);
    await call('owner', 'DELETE', `/api/v1/lists/${adultsOnly.id}`);
    expect(await activity('adult')).toContain('Owner deleted the list “Grown-up things”');
    expect((await activity('teen')).join('\n')).not.toContain('Grown-up things');

    // The log itself keeps ids and nothing else about a list: no name.
    const admin = createPool(h.adminUrl, 1);
    try {
      const { rows } = await admin.query<{ action: string; object_type: string; detail: object }>(
        "select action, object_type, detail from audit_event where action like 'list.%'",
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(
          Object.keys(r.detail).every((k) => k === 'list_id'),
          r.action,
        ).toBe(true);
        expect(r.object_type, r.action).toBe(
          r.action.startsWith('list.item_') ? 'document' : 'list',
        );
      }
      expect(JSON.stringify(rows)).not.toMatch(/Holiday|Secret plans|Grown-up/);
    } finally {
      await admin.end();
    }
  });

  describe('a list whose maker is moved or loses their sign-in (the 5.14 review)', () => {
    const nowhere = randomUUID();
    const setRole = async (member: string, role: string) => {
      const res = await call('owner', 'POST', `/api/v1/members/${member}/role`, { role });
      expect(res.statusCode, res.body).toBe(200);
      expect(json<{ applied: boolean }>(res).applied).toBe(true);
    };
    /** Everything somebody outside a list's audience reads that a list could leave a mark on. */
    const outsiderSees = async (who: Person) => ({
      lists: json<{ items: ListView[] }>(await call(who, 'GET', '/api/v1/lists')).items.map(
        (l) => l.id,
      ),
      ofDoc: json<{ items: ListView[] }>(
        await call(who, 'GET', `/api/v1/documents/${docs.household}/lists`),
      ).items.map((l) => l.id),
    });
    /** Every way of asking about a list, answered as for one that never was. */
    const asNowhere = async (who: Person | Tokens, id: string, label: string) => {
      for (const [method, path, body] of [
        ['GET', '', undefined],
        ['PATCH', '', { name: 'Mine now' }],
        ['DELETE', '', undefined],
        ['POST', '/items', { document_ids: [docs.household] }],
        ['DELETE', `/items/${docs.household}`, undefined],
      ] as const) {
        const res = await call(who, method, `/api/v1/lists/${id}${path}`, body);
        expect(refusal(res), `${label} ${method} ${path}`).toEqual(
          refusal(await call(who, method, `/api/v1/lists/${nowhere}${path}`, body)),
        );
      }
    };
    const changes = (id: string) =>
      [
        ['PATCH', `/api/v1/lists/${id}`, { name: 'Taken back' }],
        ['POST', `/api/v1/lists/${id}/items`, { document_ids: [docs.household] }],
        ['DELETE', `/api/v1/lists/${id}/items/${docs.household}`, undefined],
      ] as const;
    const notYours = {
      status: 403,
      code: 'forbidden',
      message: 'Only the person who made this list can change it.',
    };

    it('its maker, made a teen and then a viewer, still sees it and deletes it, but no longer changes it; nobody else may', async () => {
      const alex = await h.join(people.owner, {
        name: 'Alex',
        email: 'lists-alex@example.test',
        role: 'adult',
      });
      const lawyer = await makeList(alex, 'ZZ For the lawyer', 'adults', [
        docs.household,
        docs.adults,
      ]);
      const car = await makeList(alex, 'Alex’s car', 'everyone', [docs.household]);
      const second = await makeList(alex, 'ZZ Second thoughts', 'adults', [docs.household]);
      const ownersOwn = await makeList('owner', 'Owner’s own', 'everyone');
      const before = { teen: await outsiderSees('teen'), viewer: await outsiderSees('viewer') };

      await setRole(alex.member_id, 'teen');

      // Its maker sees it, with only what a teen may see on it, counted so.
      const theirs = await seen(alex, lawyer.id);
      expect(theirs).toMatchObject({ mine: true, item_count: 1 });
      expect(itemIds(theirs)).toEqual([docs.household]);
      const listed = json<{ items: ListView[] }>(await call(alex, 'GET', '/api/v1/lists')).items;
      expect(listed.find((l) => l.id === lawyer.id)).toMatchObject({ item_count: 1 });
      const ofDoc = json<{ items: ListView[] }>(
        await call(alex, 'GET', `/api/v1/documents/${docs.household}/lists`),
      ).items;
      expect(ofDoc.map((l) => l.id)).toEqual(expect.arrayContaining([lawyer.id, car.id]));
      // …and changes it no more: not its name, not what is on it.
      for (const [method, url, body] of changes(lawyer.id)) {
        expect(refusal(await call(alex, method, url, body)), `${method} ${url}`).toMatchObject({
          status: 403,
          code: 'forbidden',
          message:
            'This list is for people you are no longer one of. You can still delete it, but not change it.',
        });
      }
      // A list for everyone is still theirs to change: a teen is in it.
      const renamed = await call(alex, 'PATCH', `/api/v1/lists/${car.id}`, {
        name: 'Alex’s bike',
      });
      expect(renamed.statusCode, renamed.body).toBe(200);

      // Nobody else changes it: not an owner, not an adult.
      for (const who of ['owner', 'adult'] as const) {
        expect((await seen(who, lawyer.id))?.item_count, who).toBe(2);
        for (const [method, url, body] of changes(lawyer.id)) {
          expect(refusal(await call(who, method, url, body)), `${who} ${method}`).toMatchObject(
            notYours,
          );
        }
      }
      expect(refusal(await call('adult', 'DELETE', `/api/v1/lists/${lawyer.id}`))).toMatchObject(
        notYours,
      );
      // An owner may not delete one its maker can still change.
      expect(refusal(await call('owner', 'DELETE', `/api/v1/lists/${car.id}`))).toMatchObject(
        notYours,
      );
      // Outside its audience it is still a list that never was.
      await asNowhere('teen', lawyer.id, 'teen');
      await asNowhere('viewer', lawyer.id, 'viewer');

      // Its maker takes it back; those in its audience are told, as for any
      // list, and its maker too.
      expect((await call(alex, 'DELETE', `/api/v1/lists/${lawyer.id}`)).statusCode).toBe(204);
      for (const who of ['owner', 'adult', 'teen'] as const) {
        expect(await seen(who, lawyer.id), who).toBeNull();
      }
      expect(await seen(alex, lawyer.id)).toBeNull();
      for (const who of ['owner', 'adult', alex] as const) {
        expect(await activity(who)).toContain('Alex deleted the list “ZZ For the lawyer”');
      }

      // Made a viewer, who may make and change no list: sees their own, and deletes it.
      await setRole(alex.member_id, 'viewer');
      const asViewer = await seen(alex, second.id);
      expect(asViewer).toMatchObject({ mine: true, item_count: 1 });
      expect(
        refusal(await call(alex, 'PATCH', `/api/v1/lists/${second.id}`, { name: 'x' })),
      ).toMatchObject({
        status: 403,
        message: 'Viewers can open and download documents, but not make lists of them.',
      });
      // Their own lists, and nobody else's: somebody else's is still, to a
      // viewer, a list that never was, asked any way.
      const asViewerLists = json<{ items: ListView[] }>(await call(alex, 'GET', '/api/v1/lists'));
      expect(asViewerLists.items.map((l) => l.id).sort()).toEqual([car.id, second.id].sort());
      await asNowhere(alex, ownersOwn.id, 'Alex, a viewer');
      expect((await call(alex, 'DELETE', `/api/v1/lists/${second.id}`)).statusCode).toBe(204);
      expect(await seen('owner', second.id)).toBeNull();

      // Nothing reached anybody outside the lists' audience: no list they
      // did not have before, not a name in a teen's activity (a viewer is
      // given none).
      for (const who of ['teen', 'viewer'] as const) {
        const now = await outsiderSees(who);
        for (const key of ['lists', 'ofDoc'] as const) {
          expect(
            now[key].filter((id) => !before[who][key].includes(id)),
            `${who} ${key}`,
          ).toEqual([]);
        }
      }
      expect((await activity('teen')).join('\n')).not.toMatch(/ZZ /);
    });

    it('an owner deletes a list whose maker is no longer in its audience, never changes it; the log says so as for its maker', async () => {
      const jo = await h.join(people.owner, {
        name: 'Jo',
        email: 'lists-jo@example.test',
        role: 'adult',
      });
      const papers = await makeList(jo, 'ZZ Jo’s papers', 'adults', [docs.household, docs.adults]);
      await setRole(jo.member_id, 'teen');

      // Seen by the owner as ever, never changed by them.
      expect((await seen('owner', papers.id))?.item_count).toBe(2);
      for (const [method, url, body] of changes(papers.id)) {
        expect(refusal(await call('owner', method, url, body)), method).toMatchObject(notYours);
      }
      // An adult who is not an owner may not delete it.
      expect(refusal(await call('adult', 'DELETE', `/api/v1/lists/${papers.id}`))).toMatchObject(
        notYours,
      );
      expect((await call('owner', 'DELETE', `/api/v1/lists/${papers.id}`)).statusCode).toBe(204);
      for (const who of ['owner', 'adult', jo] as const) {
        expect(await seen(who, papers.id)).toBeNull();
        expect(await activity(who)).toContain('Owner deleted the list “ZZ Jo’s papers”');
      }
      expect((await activity('teen')).join('\n')).not.toContain('ZZ Jo’s papers');
    });

    it('a maker whose sign-in is taken away: an owner deletes their lists, never changes them; their Only me list is nobody’s', async () => {
      const kim = await h.join(people.owner, {
        name: 'Kim',
        email: 'lists-kim@example.test',
        role: 'adult',
      });
      const forms = await makeList(kim, 'ZZ Kim’s school forms', 'everyone', [docs.household]);
      const remortgage = await makeList(kim, 'ZZ Kim’s remortgage', 'adults', [
        docs.household,
        docs.adults,
      ]);
      const own = await makeList(kim, 'ZZ Kim’s own', 'only_me', [docs.household]);
      const before = await outsiderSees('teen');

      const removed = await call('owner', 'DELETE', `/api/v1/members/${kim.member_id}/sign-in`);
      expect(removed.statusCode, removed.body).toBe(204);
      expect((await call(kim, 'GET', `/api/v1/lists/${forms.id}`)).statusCode).toBe(401);

      for (const list of [forms, remortgage]) {
        // Seen as ever by those in its audience; changed by none of them.
        for (const who of ['owner', 'adult'] as const) {
          expect(await seen(who, list.id), `${who} ${list.name}`).not.toBeNull();
          for (const [method, url, body] of changes(list.id)) {
            expect(refusal(await call(who, method, url, body)), `${who} ${method}`).toMatchObject(
              notYours,
            );
          }
        }
        expect(refusal(await call('adult', 'DELETE', `/api/v1/lists/${list.id}`))).toMatchObject(
          notYours,
        );
      }
      // Outside its audience, a list that never was — before an owner deletes it, and after.
      await asNowhere('teen', remortgage.id, 'teen');
      for (const list of [forms, remortgage]) {
        expect((await call('owner', 'DELETE', `/api/v1/lists/${list.id}`)).statusCode).toBe(204);
        for (const who of ['owner', 'adult', 'teen'] as const) {
          expect(await seen(who, list.id), `${who} ${list.name}`).toBeNull();
        }
      }
      await asNowhere('teen', remortgage.id, 'teen, after');
      expect(await activity('adult')).toContain('Owner deleted the list “ZZ Kim’s remortgage”');
      expect(await activity('teen')).toContain('Owner deleted the list “ZZ Kim’s school forms”');
      expect((await activity('teen')).join('\n')).not.toContain('remortgage');

      // Their Only me list is nobody's, an owner's no more than anybody's:
      // it stays, unseen and unchanged.
      for (const who of ['owner', 'adult', 'teen'] as const) {
        await asNowhere(who, own.id, `${who}, Only me`);
        expect((await activity(who)).join('\n'), who).not.toContain('Kim’s own');
      }
      const admin = createPool(h.adminUrl, 1);
      try {
        const { rows } = await admin.query<{ deleted: boolean }>(
          'select deleted_at is not null as deleted from doc_list where id = $1',
          [own.id],
        );
        expect(rows).toEqual([{ deleted: false }]);
      } finally {
        await admin.end();
      }
      // And nothing reached the teen: no list they did not have before.
      const now = await outsiderSees('teen');
      expect(now.lists.filter((id) => !before.lists.includes(id))).toEqual([]);
      expect(now.ofDoc.filter((id) => !before.ofDoc.includes(id))).toEqual([]);
    });
  });

  it("a list's documents come a page at a time; item_count is all the reader sees; a cursor names nothing hidden", async () => {
    const list = await makeList('owner', 'Everything, paged', 'everyone', [
      docs.household,
      docs.adults,
      docs.ownerPrivate,
      docs.teenOwn,
    ]);
    const all = async (who: Person, limit: number) => {
      const pages: ListDetail[] = [];
      let cursor: string | null = null;
      do {
        const q: string = `?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const res = await call(who, 'GET', `/api/v1/lists/${list.id}${q}`);
        expect(res.statusCode, res.body).toBe(200);
        const page: ListDetail = json<ListDetail>(res);
        pages.push(page);
        cursor = page.next_cursor;
      } while (cursor && pages.length < 10);
      return pages;
    };
    const expected: Record<'owner' | 'adult' | 'teen', string[]> = {
      owner: [docs.household, docs.adults, docs.ownerPrivate, docs.teenOwn],
      adult: [docs.household, docs.adults, docs.teenOwn],
      teen: [docs.household, docs.teenOwn],
    };
    for (const who of ['owner', 'adult', 'teen'] as const) {
      const pages = await all(who, 1);
      expect(pages.flatMap(itemIds), who).toEqual(expected[who]);
      expect(
        pages.map((p) => p.items.length),
        who,
      ).toEqual(expected[who].map(() => 1));
      expect(new Set(pages.map((p) => p.item_count)), who).toEqual(new Set([expected[who].length]));
      expect(
        pages.map((p) => p.has_more),
        who,
      ).toEqual(expected[who].map((_, i) => i < expected[who].length - 1));
      // Unasked, a page holds up to 50: all of these.
      const whole = await seen(who, list.id);
      expect(itemIds(whole), who).toEqual(expected[who]);
      expect(whole, who).toMatchObject({ has_more: false, next_cursor: null });
    }

    // A cursor that names a document the reader is not given — on the list
    // or not, theirs to see elsewhere or not — is one that is not valid,
    // exactly as one naming nothing.
    const naming = (id: string) => Buffer.from(JSON.stringify({ after: id })).toString('base64url');
    const page = (who: Person, cursor: string) =>
      call(who, 'GET', `/api/v1/lists/${list.id}?cursor=${encodeURIComponent(cursor)}`);
    const invalid = refusal(await page('teen', naming(randomUUID())));
    expect(invalid).toMatchObject({ status: 422, code: 'validation_failed' });
    for (const hidden of [docs.adults, docs.ownerPrivate, docs.adultPrivate]) {
      expect(refusal(await page('teen', naming(hidden))), hidden).toEqual(invalid);
    }
    expect(refusal(await page('teen', 'not a cursor'))).toEqual(invalid);
    // One the owner was given, passed to a teen, is no way round it either.
    const ownerFirst = (await all('owner', 2))[0]?.next_cursor as string;
    expect(refusal(await page('teen', ownerFirst))).toEqual(invalid);
    // Pages hold 1 to 200.
    for (const limit of [0, 201]) {
      expect(
        refusal(await call('owner', 'GET', `/api/v1/lists/${list.id}?limit=${limit}`)),
      ).toMatchObject({ status: 422 });
    }
  });

  it('a change is made and let go before the list is read back: the log and the rows are not held while it renders', async () => {
    const list = await makeList('owner', 'Held while drawn?', 'everyone');
    const target = { list: list.id, documents: [docs.household, docs.adults] };
    const admin = createPool(h.adminUrl, 2);
    const hh = people.owner.household_id;
    const held: Array<{ audit: boolean; list: boolean; documents: boolean }> = [];
    const locked = async (q: string, params: unknown[]) =>
      admin.query(q, params).then(
        () => false,
        (e: { code?: string }) => {
          if (e.code === '55P03') return true;
          throw e;
        },
      );
    // The render as it is, to call once the probe has looked.
    const listed = Object.getOwnPropertyDescriptor(DocumentService.prototype, 'listed')
      ?.value as DocumentService['listed'];
    const spy = vi.spyOn(DocumentService.prototype, 'listed').mockImplementation(async function (
      this: DocumentService,
      trx,
      rows,
    ) {
      // While the answer is drawn, from another connection: is anything
      // the change took still taken?
      const free = await admin.query<{ free: boolean }>(
        "select pg_try_advisory_xact_lock(hashtext('audit:' || $1)) as free",
        [hh],
      );
      held.push({
        audit: free.rows[0]?.free !== true,
        list: await locked('select id from doc_list where id = $1 for update nowait', [
          target.list,
        ]),
        documents: await locked(
          'select id from document where id = any($1::uuid[]) for update nowait',
          [target.documents],
        ),
      });
      return listed.call(this, trx, rows);
    });
    try {
      const added = await call('owner', 'POST', `/api/v1/lists/${list.id}/items`, {
        document_ids: [docs.household, docs.adults],
      });
      expect(added.statusCode, added.body).toBe(200);
      const renamed = await call('owner', 'PATCH', `/api/v1/lists/${list.id}`, {
        name: 'Not held',
      });
      expect(renamed.statusCode, renamed.body).toBe(200);
      const stale = await call(
        'owner',
        'PATCH',
        `/api/v1/lists/${list.id}`,
        { name: 'Stale' },
        { 'if-match': list.etag },
      );
      expect(stale.statusCode).toBe(409);
      expect(held).toEqual([
        { audit: false, list: false, documents: false },
        { audit: false, list: false, documents: false },
        { audit: false, list: false, documents: false },
      ]);
    } finally {
      spy.mockRestore();
      await admin.end();
    }
  });

  describe('in the database, as the application role', () => {
    let one: Db;
    let divorce: ListDetail;
    const principal = (who: Person) => ({
      householdId: people[who].household_id,
      accountId: accounts[who],
      memberId: people[who].member_id,
      role: people[who].role,
    });

    beforeAll(async () => {
      divorce = await makeList('owner', 'Divorce lawyer', 'only_me', [docs.household, docs.adults]);
      // One connection: a transaction that sets nothing is given one another
      // has used, where an unset setting reads '' rather than null.
      one = createDb(createPool(h.appUrl, 1));
    });
    afterAll(async () => {
      await one.destroy();
    });

    it('an Only me list is invisible to a query with no WHERE clause', async () => {
      const everything = (trx: Db) =>
        Promise.all([
          trx.selectFrom('doc_list').selectAll().execute(),
          trx.selectFrom('doc_list_item').selectAll().execute(),
          sql<{ n: number }>`select count(*)::int as n from doc_list`.execute(trx),
        ]);
      // A second adult, asking for every list and every item there is.
      const [lists, items, count] = await withPrincipal(one, principal('adult'), everything);
      expect(lists.map((l) => l.id)).not.toContain(divorce.id);
      expect(
        lists.every(
          (l) => l.audience !== 'only_me' || l.owner_member_id === people.adult.member_id,
        ),
      ).toBe(true);
      expect(items.map((i) => i.list_id)).not.toContain(divorce.id);
      expect(count.rows[0]?.n).toBe(lists.length);
      expect(JSON.stringify(lists)).not.toContain('Divorce lawyer');

      // Its maker, asking the same way, is given it and what is on it.
      const [own, ownItems] = await withPrincipal(one, principal('owner'), everything);
      expect(own.map((l) => l.id)).toContain(divorce.id);
      expect(ownItems.filter((i) => i.list_id === divorce.id)).toHaveLength(2);

      // Signed in with no member said, after the connection was used: none.
      const unset = await withScope(
        one,
        {
          householdId: people.owner.household_id,
          actor: { kind: 'account', accountId: accounts.owner, memberId: '', role: 'owner' },
        },
        (trx) => trx.selectFrom('doc_list').select(['id', 'audience']).execute(),
      );
      expect(unset.map((l) => l.id)).not.toContain(divorce.id);
      expect(unset.some((l) => l.audience === 'only_me')).toBe(false);

      // Nobody said, anonymous, an upload link or a share link: no list at all.
      for (const actor of [
        { kind: 'anonymous' } as const,
        { kind: 'upload', requestId: randomUUID() } as const,
        { kind: 'link', shareId: randomUUID() } as const,
      ]) {
        const [l, i] = await withScope(
          one,
          { householdId: people.owner.household_id, actor },
          everything,
        );
        expect([l.length, i.length], actor.kind).toEqual([0, 0]);
      }
    });

    it('a second adult cannot change, empty or add to an Only me list they are not given', async () => {
      await withPrincipal(one, principal('adult'), async (trx) => {
        const renamed = await trx
          .updateTable('doc_list')
          .set({ name: 'Taken' })
          .where('id', '=', divorce.id)
          .executeTakeFirst();
        expect(renamed.numUpdatedRows).toBe(0n);
        const emptied = await trx
          .deleteFrom('doc_list_item')
          .where('list_id', '=', divorce.id)
          .executeTakeFirst();
        expect(emptied.numDeletedRows).toBe(0n);
      });
      await expect(
        withPrincipal(one, principal('adult'), (trx) =>
          trx
            .insertInto('doc_list_item')
            .values({
              list_id: divorce.id,
              document_id: docs.adultPrivate,
              household_id: people.adult.household_id,
              position: 99,
            })
            .execute(),
        ),
      ).rejects.toThrow(/row-level security/);
      // Nor may anybody take a list away outright: it is marked deleted.
      await expect(
        withPrincipal(one, principal('owner'), (trx) =>
          trx.deleteFrom('doc_list').where('id', '=', divorce.id).execute(),
        ),
      ).rejects.toThrow(/permission denied/);
      expect(await seen('owner', divorce.id)).toMatchObject({
        name: 'Divorce lawyer',
        item_count: 2,
      });
    });

    it('the roles in each audience are the same here as in @fdv/shared', async () => {
      const admin = createPool(h.adminUrl, 1);
      try {
        for (const role of [...ROLES, '', 'root', null]) {
          for (const audience of [...LIST_AUDIENCES, 'public', '']) {
            const { rows } = await admin.query<{ has: boolean }>(
              'select list_audience_has($1, $2) as has',
              [role, audience],
            );
            const known = ROLES.find((r) => r === role);
            expect(rows[0]?.has, `${role} ${audience}`).toBe(
              known ? inListAudience(known, audience) : false,
            );
          }
        }
      } finally {
        await admin.end();
      }
    });

    it('only its maker changes a list; an owner only marks deleted one nobody can change any more', async () => {
      const hh = people.owner.household_id;
      // Sam's, for everyone: Sam is in it, so it is Sam's alone to change.
      const sams = await makeList('adult', 'Sam’s, in the database', 'everyone');
      // And one whose maker is somebody with no sign-in at all.
      const admin = createPool(h.adminUrl, 1);
      let nobodys = '';
      try {
        const gone = await admin.query<{ id: string }>(
          "insert into member (household_id, display_name) values ($1, 'Gone') returning id",
          [hh],
        );
        const made = await admin.query<{ id: string }>(
          `insert into doc_list (household_id, name, audience, owner_member_id)
           values ($1, 'Nobody’s now', 'everyone', $2) returning id`,
          [hh, gone.rows[0]?.id],
        );
        nobodys = made.rows[0]?.id as string;
      } finally {
        await admin.end();
      }
      const update = (who: Person, id: string, set: Record<string, unknown>) =>
        withPrincipal(one, principal(who), async (trx) =>
          Number(
            (await trx.updateTable('doc_list').set(set).where('id', '=', id).executeTakeFirst())
              .numUpdatedRows,
          ),
        );
      const held = (who: Person, id: string) =>
        withPrincipal(
          one,
          principal(who),
          async (trx) =>
            (
              await trx
                .selectFrom('doc_list')
                .select('id')
                .where('id', '=', id)
                .forUpdate()
                .execute()
            ).length,
        );

      // Sam's own: nobody else changes it, or holds it — not an owner.
      expect(await update('owner', sams.id, { deleted_at: new Date() })).toBe(0);
      expect(await update('teen', sams.id, { name: 'Taken' })).toBe(0);
      expect(await held('owner', sams.id)).toBe(0);
      expect(await held('adult', sams.id)).toBe(1);
      expect(await update('adult', sams.id, { name: 'Still Sam’s' })).toBe(1);
      // Nor hands it to anybody else.
      await expect(
        update('adult', sams.id, { owner_member_id: people.owner.member_id }),
      ).rejects.toThrow(/row-level security/);

      // Nobody's now: not an adult's to touch.
      expect(await update('adult', nobodys, { deleted_at: new Date() })).toBe(0);
      expect(await held('adult', nobodys)).toBe(0);
      // An owner's to hold, but not to change, nor to take for their own…
      expect(await held('owner', nobodys)).toBe(1);
      for (const set of [
        { name: 'Renamed' },
        { owner_member_id: people.owner.member_id },
        { name: 'Renamed', deleted_at: new Date() },
      ]) {
        await expect(update('owner', nobodys, set), JSON.stringify(set)).rejects.toThrow(
          /only its maker changes a list/,
        );
      }
      // …and not with no role said, after the connection was used.
      const unsaid = await withScope(
        one,
        {
          householdId: hh,
          actor: {
            kind: 'account',
            accountId: accounts.owner,
            memberId: people.owner.member_id,
            role: '' as unknown as Person,
          },
        },
        async (trx) =>
          (
            await trx
              .updateTable('doc_list')
              .set({ deleted_at: new Date() })
              .where('id', '=', nobodys)
              .executeTakeFirst()
          ).numUpdatedRows,
      );
      expect(unsaid).toBe(0n);
      // Marked deleted by an owner: once, and never brought back.
      expect(await update('owner', nobodys, { deleted_at: new Date() })).toBe(1);
      for (const set of [{ deleted_at: new Date() }, { deleted_at: null }]) {
        await expect(update('owner', nobodys, set), JSON.stringify(set)).rejects.toThrow(
          /only its maker changes a list/,
        );
      }
    });
  });
});
