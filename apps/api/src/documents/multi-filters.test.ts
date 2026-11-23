import { testAdminUrl } from '@fdv/db/testing';
import {
  storedIssuerKey,
  type Capabilities,
  type DocumentPage,
  type DocumentView,
  type SearchHit,
} from '@fdv/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { ApiError } from '../errors.js';
import { createHarness, type Harness } from '../test-harness.js';
import { filtersOf, valuesOf } from './filters.js';
import { folderQuery, listQuery, listQueryOf } from './list-query.js';

/**
 * Filters of several choices (0.9.0-dev.92, `features.multi_filters`): the
 * web's Documents filters — two people, Passport and Driving licence, two
 * collections, two details — each value given once (`member_id=a&member_id=b`),
 * any of them within a filter and every filter together, each only
 * narrowing what the reader may read already. One value is the filter as
 * it always was; the filters of keys still take commas, as since V1.
 */

const A = '7a1c3f52-2a8e-4f0e-9b1e-1d2f3a4b5c6d';
const DAY = 86_400_000;
const dayIn = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const B = '0b2d4f60-3c9e-4a1f-8c2d-2e3f4a5b6c7d';

const refusal = (raw: Parameters<typeof filtersOf>[0]) => {
  try {
    filtersOf(raw);
  } catch (e) {
    return e instanceof ApiError ? e.status : 'other';
  }
  return 'accepted';
};

describe('filters of several choices (0.9.0-dev.92): read', () => {
  it('takes each value given once, commas as well, the two together', () => {
    expect(valuesOf(['a', 'b,c', 'a', ' '])).toEqual(['a', 'b', 'c']);
    const given = filtersOf({ member_id: [A, B], type_key: ['passport'], status: ['expired'] });
    // One value given once is the filter as it always was.
    expect(given.single).toEqual({ type_key: 'passport', status: 'expired' });
    expect(given.many).toEqual({ member_ids: [A, B] });
    expect(filtersOf({ member_id: [`${A},${B}`, A] }).many).toEqual({ member_ids: [A, B] });
  });

  it('never splits words: a detail’s label is given once for each, a comma and all', () => {
    expect(filtersOf({ tag_label: ['Locker, top', 'agent'] }).many).toEqual({
      tag_labels: ['Locker, top', 'agent'],
    });
    expect(filtersOf({ tag_label: 'Locker, top' }).single).toEqual({ tag_label: 'Locker, top' });
    expect(filtersOf({ tag: ['a, b', 'c'] }).many).toEqual({ tags: ['a, b', 'c'] });
  });

  it('takes several collections, or none of them, and refuses what is not one', () => {
    expect(filtersOf({ collection_id: [A, 'none'] }).many).toEqual({
      collection_ids: [A, 'none'],
    });
    expect(filtersOf({ collection_id: A }).single).toEqual({ collection_id: A });
    expect(refusal({ collection_id: [A, 'holiday'] })).toBe(422);
    expect(refusal({ member_id: [A, 'sam'] })).toBe(422);
    expect(refusal({ status: ['expired', 'lost'] })).toBe(422);
    expect(refusal({ visibility: ['adults', 'everyone'] })).toBe(422);
    expect(refusal({ sensitive: ['yes', 'maybe'] })).toBe(422);
    expect(
      refusal({ member_id: Array.from({ length: 51 }, (_, i) => `${A.slice(0, -2)}${i}`) }),
    ).toBe(422);
  });

  it('the list’s query passes one value through as it always was', () => {
    const q = listQueryOf(
      listQuery.parse({ collection_id: A, tag_label: 'locker', sort: 'title' }),
    );
    expect(q.collection_id).toBe(A);
    expect(q.tag_label).toBe('locker');
    expect(q.collection_ids).toBeUndefined();
    const many = listQueryOf(listQuery.parse({ collection_id: [A, B], tag_label: ['a', 'b'] }));
    expect(many.collection_id).toBeUndefined();
    expect(many.collection_ids).toEqual([A, B]);
    expect(many.tag_labels).toEqual(['a', 'b']);
  });

  it('a cabinet folder’s question stays one string a filter, as every app reads it', () => {
    expect(folderQuery.safeParse({ member_id: `${A},${B}` }).success).toBe(true);
    expect(folderQuery.safeParse({ member_id: [A, B] }).success).toBe(false);
    expect(folderQuery.safeParse({ collection_id: [A] }).success).toBe(false);
    expect(folderQuery.safeParse({ collection_id: A }).success).toBe(true);
    expect(folderQuery.safeParse({ tag_label: ['a', 'b'] }).success).toBe(false);
    expect(folderQuery.safeParse({ tag: ['a', 'b'] }).success).toBe(true);
  });
});

describe.skipIf(!testAdminUrl())('filters of several choices (0.9.0-dev.92)', () => {
  let h: Harness;
  let owner: Tokens;
  let ahmed: Tokens;
  let tia: Tokens;
  const ids: Record<string, string> = {};
  const collections: Record<string, string> = {};

  const get = async (who: Tokens, url: string) => h.app.inject({ url, headers: h.as(who) });
  const ok = async <T>(who: Tokens, url: string): Promise<T> => {
    const r = await get(who, url);
    expect(r.statusCode, r.body).toBe(200);
    return r.json<T>();
  };
  const titles = (docs: { title: string | null }[]) => docs.map((d) => d.title).sort();
  const table = async (who: Tokens, query: string) =>
    ok<DocumentPage>(who, `/api/v1/documents?sort=title&limit=50&${query}`);

  const make = async (
    key: string,
    payload: {
      title: string;
      type_key: string;
      owner_member_id: string | null;
      visibility?: string;
      tags?: string[];
      issued_by?: string;
      expires?: string;
      household_owned?: boolean;
    },
    by: Tokens = owner,
  ) => {
    const { expires, ...rest } = payload;
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(by),
      payload: {
        visibility: 'household',
        ...rest,
        ...(expires ? { expires: { date: expires, precision: 'day' } } : {}),
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    ids[key] = created.json<DocumentView>().id;
  };
  const collection = async (name: string, audience: string, docs: string[], by: Tokens) => {
    const made = await h.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: h.as(by),
      payload: { name, audience },
    });
    expect(made.statusCode, made.body).toBe(201);
    const id = made.json<{ id: string }>().id;
    const put = await h.app.inject({
      method: 'POST',
      url: `/api/v1/collections/${id}/items`,
      headers: h.as(by),
      payload: { document_ids: docs.map((k) => ids[k]) },
    });
    expect(put.statusCode, put.body).toBe(200);
    collections[name] = id;
  };

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    owner = await h.setup();
    ahmed = await h.join(owner, { name: 'Ahmed', email: 'ahmed-mf@example.test', role: 'adult' });
    tia = await h.join(owner, { name: 'Tia', email: 'tia-mf@example.test', role: 'teen' });
    await make('ownerPassport', {
      title: 'Owner passport',
      type_key: 'passport',
      owner_member_id: owner.member_id,
      tags: ['Locker: 12', 'travel'],
    });
    await make('ahmedLicence', {
      title: 'Ahmed licence',
      type_key: 'drivers_licence',
      owner_member_id: ahmed.member_id,
      tags: ['Agent: Sam Lee'],
    });
    await make('ahmedWill', {
      title: 'Ahmed will',
      type_key: 'will',
      owner_member_id: ahmed.member_id,
      visibility: 'adults',
      tags: ['Locker: 3'],
    });
    await make('tiaPassport', {
      title: 'Tia passport',
      type_key: 'passport',
      owner_member_id: tia.member_id,
    });
    // The owner's own, nobody else's to see: never found by a filter of theirs.
    await make('ownerTherapy', {
      title: 'Owner therapy notes',
      type_key: 'medical_record',
      owner_member_id: owner.member_id,
      visibility: 'private',
      tags: ['Locker: 99'],
    });
    await collection('Travel', 'everyone', ['ownerPassport', 'tiaPassport'], owner);
    await collection('Estate', 'adults', ['ahmedWill'], owner);
    // The owner's Only me collection: Ahmed's licence is in it, but Ahmed
    // cannot see the collection, so to Ahmed the licence is in none.
    await collection('Mine alone', 'only_me', ['ahmedLicence', 'ownerTherapy'], owner);
    // The household's bills: issuers, statuses, and one in the Trash.
    await make('billA', {
      title: 'Insurance A',
      type_key: 'insurance_policy',
      owner_member_id: null,
      issued_by: 'Wrenfold Bank',
      expires: dayIn(-5),
      household_owned: true,
    });
    await make('billB', {
      title: 'Insurance B',
      type_key: 'insurance_policy',
      owner_member_id: null,
      issued_by: 'Wrenfold Bank Savings',
      expires: dayIn(10),
      household_owned: true,
    });
    await make('water', {
      title: 'Water bill',
      type_key: 'utility_bill',
      owner_member_id: null,
      issued_by: 'Thames Water',
    });
    await make('receipt', { title: 'Old receipt', type_key: 'warranty', owner_member_id: null });
    await collection('Bills', 'everyone', ['billA', 'billB', 'water', 'receipt'], owner);
    const gone = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/documents/${ids.receipt}`,
      headers: h.as(owner),
    });
    expect(gone.statusCode, gone.body).toBeLessThan(300);
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  it('says so in its capabilities', async () => {
    const caps = await ok<Capabilities>(owner, '/api/v1/capabilities');
    expect(caps.features.multi_filters).toBe(true);
  });

  it('within one filter any of the choices; across filters all of them', async () => {
    const people = await table(owner, `member_id=${ahmed.member_id}&member_id=${tia.member_id}`);
    expect(titles(people.items)).toEqual(['Ahmed licence', 'Ahmed will', 'Tia passport']);
    expect(people.total).toBe(3);
    const kinds = await table(owner, 'type_key=passport&type_key=drivers_licence');
    expect(titles(kinds.items)).toEqual(['Ahmed licence', 'Owner passport', 'Tia passport']);
    const both = await table(
      owner,
      `member_id=${ahmed.member_id}&member_id=${tia.member_id}&type_key=passport&type_key=drivers_licence`,
    );
    expect(titles(both.items)).toEqual(['Ahmed licence', 'Tia passport']);
    expect(both.total).toBe(2);
    // Given once each, comma-separated, or both: the same.
    const commas = await table(
      owner,
      `member_id=${ahmed.member_id},${tia.member_id}&type_key=passport&type_key=drivers_licence`,
    );
    expect(titles(commas.items)).toEqual(titles(both.items));
    const visibility = await table(owner, 'visibility=adults&visibility=private');
    expect(titles(visibility.items)).toEqual(['Ahmed will', 'Owner therapy notes']);
  });

  it('one value is the filter as it always was', async () => {
    const once = await table(owner, 'type_key=passport');
    const twice = await table(owner, 'type_key=passport&type_key=passport');
    expect(titles(twice.items)).toEqual(titles(once.items));
    expect(titles(once.items)).toEqual(['Owner passport', 'Tia passport']);
    const older = await ok<{ items: DocumentView[] }>(owner, '/api/v1/documents?type_key=passport');
    expect(titles(older.items)).toEqual(['Owner passport', 'Tia passport']);
  });

  it('several collections, or in none, each only one the reader may see', async () => {
    const two = await table(
      owner,
      `collection_id=${collections.Travel}&collection_id=${collections.Estate}`,
    );
    expect(titles(two.items)).toEqual(['Ahmed will', 'Owner passport', 'Tia passport']);
    const travelOrNone = await table(
      owner,
      `collection_id=${collections.Travel}&collection_id=none`,
    );
    // The owner's licence and notes are in their Only me collection: in one.
    expect(titles(travelOrNone.items)).toEqual(['Owner passport', 'Tia passport']);
    // Ahmed cannot see the owner's Only me collection: asking for it beside
    // his own finds nothing of it, and the licence is in none of his.
    const ahmedAsks = await table(
      ahmed,
      `collection_id=${collections['Mine alone']}&collection_id=${collections.Estate}`,
    );
    expect(titles(ahmedAsks.items)).toEqual(['Ahmed will']);
    const ahmedNone = await table(ahmed, `collection_id=none&collection_id=${collections.Estate}`);
    expect(titles(ahmedNone.items)).toEqual(['Ahmed licence', 'Ahmed will']);
    // A teen is never given the adults' will, whatever is asked for.
    const teen = await table(
      tia,
      `collection_id=${collections.Estate}&collection_id=${collections.Travel}&visibility=adults&visibility=household`,
    );
    expect(titles(teen.items)).toEqual(['Owner passport', 'Tia passport']);
  });

  it('several details’ labels and tags, any of them; never another’s Only me', async () => {
    const labels = await table(owner, 'tag_label=locker&tag_label=Agent');
    expect(titles(labels.items)).toEqual([
      'Ahmed licence',
      'Ahmed will',
      'Owner passport',
      'Owner therapy notes',
    ]);
    const ahmedLabels = await table(ahmed, 'tag_label=locker&tag_label=agent');
    expect(titles(ahmedLabels.items)).toEqual(['Ahmed licence', 'Ahmed will', 'Owner passport']);
    expect(ahmedLabels.total).toBe(3);
    const tags = await table(ahmed, 'tag=travel&tag=Agent: Sam Lee');
    expect(titles(tags.items)).toEqual(['Ahmed licence', 'Owner passport']);
    // The older list takes several labels too.
    const older = await ok<{ items: DocumentView[] }>(
      ahmed,
      '/api/v1/documents?tag_label=locker&tag_label=agent',
    );
    expect(titles(older.items)).toEqual(['Ahmed licence', 'Ahmed will', 'Owner passport']);
  });

  it('search takes several of each, given once each', async () => {
    const hits = await ok<{ items: SearchHit[] }>(
      owner,
      `/api/v1/search?q=passport&member_id=${owner.member_id}&member_id=${tia.member_id}&type_key=passport`,
    );
    expect(titles(hits.items)).toEqual(['Owner passport', 'Tia passport']);
    const ahmedHits = await ok<{ items: SearchHit[] }>(
      ahmed,
      '/api/v1/search?q=owner&visibility=private&visibility=household',
    );
    expect(titles(ahmedHits.items)).toEqual(['Owner passport']);
  });

  it('several statuses on the table: as each is worked out, counted', async () => {
    const pressing = await table(owner, 'status=expired&status=expiring_soon');
    expect(titles(pressing.items)).toEqual(['Insurance A', 'Insurance B']);
    expect(pressing.total).toBe(2);
    const one = await table(owner, 'status=expired');
    expect(titles(one.items)).toEqual(['Insurance A']);
  });

  it('several issuers, each with those the household says are the same', async () => {
    const wrenfold = storedIssuerKey('Wrenfold Bank') as string;
    const savings = storedIssuerKey('Wrenfold Bank Savings') as string;
    const thames = storedIssuerKey('Thames Water') as string;
    const q = (...keys: string[]) => keys.map((k) => `issuer=${encodeURIComponent(k)}`).join('&');
    expect(titles((await table(owner, q(wrenfold, thames))).items)).toEqual([
      'Insurance A',
      'Water bill',
    ]);
    const same = await h.app.inject({
      method: 'POST',
      url: '/api/v1/issuers/same',
      headers: h.as(owner),
      payload: { from: savings, to: wrenfold },
    });
    expect(same.statusCode, same.body).toBe(200);
    expect(titles((await table(owner, q(wrenfold, thames))).items)).toEqual([
      'Insurance A',
      'Insurance B',
      'Water bill',
    ]);
    // Given once each or comma-separated, the same.
    expect(titles((await table(owner, `issuer=${wrenfold},${thames}`)).items)).toEqual([
      'Insurance A',
      'Insurance B',
      'Water bill',
    ]);
  });

  it('several collections in the Trash: in none is every one there, in some is none', async () => {
    const both = await table(
      owner,
      `deleted=true&collection_id=${collections.Bills}&collection_id=none`,
    );
    expect(titles(both.items)).toEqual(['Old receipt']);
    const some = await table(
      owner,
      `deleted=true&collection_id=${collections.Bills}&collection_id=${collections.Travel}`,
    );
    expect(some.items).toEqual([]);
  });

  it('Sensitive and not, both asked, is every document', async () => {
    const all = await table(owner, '');
    const both = await table(owner, 'sensitive=yes&sensitive=no');
    expect(titles(both.items)).toEqual(titles(all.items));
    expect(both.total).toBe(all.total);
  });

  it('an empty value is left out: alone, it is no filter', async () => {
    const all = await table(owner, '');
    for (const q of ['collection_id=', 'tag_label=', 'member_id=', 'tag=', 'type_key=&type_key=']) {
      const r = await table(owner, q);
      expect(r.total, q).toBe(all.total);
    }
    const agent = await table(owner, 'tag_label=&tag_label=agent');
    expect(titles(agent.items)).toEqual(['Ahmed licence']);
    // The older list too.
    const older = await get(owner, '/api/v1/documents?tag_label=');
    expect(older.statusCode, older.body).toBe(200);
  });

  it('refuses more than 50 values in one filter, given once each or comma-separated', async () => {
    const many = Array.from(
      { length: 51 },
      (_, i) => `${A.slice(0, -2)}${String(i).padStart(2, '0')}`,
    );
    for (const url of [
      `/api/v1/documents?sort=title&${many.map((m) => `member_id=${m}`).join('&')}`,
      `/api/v1/documents?sort=title&member_id=${many.join(',')}`,
      `/api/v1/search?q=passport&${many.map((m) => `member_id=${m}`).join('&')}`,
      `/api/v1/search?q=passport&member_id=${many.join(',')}`,
    ]) {
      const r = await get(owner, url);
      expect(r.statusCode, url.slice(0, 40)).toBe(422);
      expect(r.json()).toMatchObject({ error: { code: 'validation_failed' } });
    }
    // Fifty is taken.
    const fifty = await get(
      owner,
      `/api/v1/documents?sort=title&${many
        .slice(0, 50)
        .map((m) => `member_id=${m}`)
        .join('&')}`,
    );
    expect(fifty.statusCode, fifty.body).toBe(200);
  });

  it('refuses a value that is not one, and several collections without a column sort', async () => {
    for (const q of [
      `sort=title&collection_id=${collections.Travel}&collection_id=holiday`,
      'sort=title&status=expired&status=lost',
      `collection_id=${collections.Travel}&collection_id=none`,
    ]) {
      const r = await get(owner, `/api/v1/documents?${q}`);
      expect(r.statusCode, q).toBe(422);
      expect(r.json()).toMatchObject({ error: { code: 'validation_failed' } });
    }
  });
});
