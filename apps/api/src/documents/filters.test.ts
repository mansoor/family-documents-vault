import { testAdminUrl } from '@fdv/db/testing';
import type { Capabilities, DocumentPage, DocumentView, SearchHit } from '@fdv/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { ApiError } from '../errors.js';
import { createHarness, type Harness } from '../test-harness.js';
import { asLists, filtersOf, valuesOf } from './filters.js';

/**
 * Filters of several values and of dates (V1, `features.document_filters`):
 * the phone's filter panel — Sam's or Leo's, passports or licences, expiring
 * in the next 90 days — on GET /documents (the table and the older list) and
 * GET /search, each only narrowing what the reader may see already.
 */

const DAY = 86_400_000;
const dayIn = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

describe('a filter of several values, and of days (V1): read', () => {
  it('one value is the filter as it always was; several are any of them', () => {
    expect(valuesOf('a, b,,a')).toEqual(['a', 'b']);
    expect(valuesOf(' , ')).toBeUndefined();
    const one = filtersOf({ type_key: 'passport', status: 'expired', visibility: 'adults' });
    expect(one).toEqual({
      single: { type_key: 'passport', status: 'expired', visibility: 'adults' },
      many: {},
    });
    const several = filtersOf({
      type_key: 'passport,will',
      status: 'expired,valid',
      expires_from: '2026-01-01',
    });
    expect(several.single).toEqual({});
    expect(several.many).toEqual({
      type_keys: ['passport', 'will'],
      statuses: ['expired', 'valid'],
      expires_from: '2026-01-01',
    });
    expect(asLists({ type_key: 'passport', visibility: 'private' }, {})).toEqual({
      type_keys: ['passport'],
      visibilities: ['private'],
    });
  });

  it('refuses what is not a person, a status, who can see, or a day; and days the wrong way round', () => {
    const refusal = (raw: Parameters<typeof filtersOf>[0]) => {
      try {
        filtersOf(raw);
      } catch (e) {
        return e instanceof ApiError ? e.status : 'other';
      }
      return 'accepted';
    };
    expect(refusal({ member_id: 'sam,leo' })).toBe(422);
    expect(refusal({ status: 'expired,lost' })).toBe(422);
    expect(refusal({ visibility: 'household,everyone' })).toBe(422);
    expect(refusal({ issued_from: '10/11/2026' })).toBe(422);
    expect(refusal({ expires_from: '2026-02-30' })).toBe(422);
    expect(refusal({ expires_from: '2026-02-28' })).toBe('accepted');
    expect(refusal({ added_from: '2026-12-01', added_to: '2026-11-01' })).toBe(422);
    expect(refusal({ member_id: 'none,7a1c3f52-2a8e-4f0e-9b1e-1d2f3a4b5c6d' })).toBe('accepted');
  });
});

describe.skipIf(!testAdminUrl())('a filter of several values, and of days (V1)', () => {
  let h: Harness;
  let owner: Tokens;
  let ahmed: Tokens;
  let tia: Tokens;
  const ids: Record<string, string> = {};

  const json = <T>(r: { json: () => unknown }) => r.json() as T;
  const get = async (who: Tokens, url: string) => h.app.inject({ url, headers: h.as(who) });
  const ok = async <T>(who: Tokens, url: string): Promise<T> => {
    const r = await get(who, url);
    expect(r.statusCode, r.body).toBe(200);
    return json<T>(r);
  };
  const titles = (docs: { title: string | null }[]) => docs.map((d) => d.title).sort();

  const make = async (
    key: string,
    payload: {
      title: string;
      type_key: string;
      owner_member_id: string | null;
      visibility?: string;
      issued?: string;
      expires?: string;
    },
    by: Tokens = owner,
  ) => {
    const { issued, expires, ...rest } = payload;
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(by),
      payload: {
        visibility: 'household',
        ...rest,
        ...(issued ? { issued: { date: issued, precision: 'day' } } : {}),
        ...(expires ? { expires: { date: expires, precision: 'day' } } : {}),
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    ids[key] = json<DocumentView>(created).id;
  };

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    owner = await h.setup();
    ahmed = await h.join(owner, { name: 'Ahmed', email: 'ahmed-v1@example.test', role: 'adult' });
    tia = await h.join(owner, { name: 'Tia', email: 'tia-v1@example.test', role: 'teen' });
    await make('ownerPassport', {
      title: 'Owner passport',
      type_key: 'passport',
      owner_member_id: owner.member_id,
      issued: '2020-01-10',
      expires: dayIn(30),
    });
    await make('ahmedPassport', {
      title: 'Ahmed passport',
      type_key: 'passport',
      owner_member_id: ahmed.member_id,
      issued: '2016-05-01',
      expires: dayIn(-5),
    });
    await make('ahmedWill', {
      title: 'Ahmed will',
      type_key: 'will',
      owner_member_id: ahmed.member_id,
      visibility: 'adults',
      issued: '2019-06-01',
    });
    await make('tiaPassport', {
      title: 'Tia passport',
      type_key: 'passport',
      owner_member_id: tia.member_id,
      issued: '2023-02-01',
      expires: dayIn(400),
    });
    await make('houseTax', {
      title: 'House tax return',
      type_key: 'tax_return',
      owner_member_id: null,
      issued: '2025-04-05',
    });
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  it('says so in its capabilities', async () => {
    const caps = await ok<Capabilities>(owner, '/api/v1/capabilities');
    expect(caps.features.document_filters).toBe(true);
  });

  it('the table: any of the people, any of the kinds, counted', async () => {
    const both = await ok<DocumentPage>(
      owner,
      `/api/v1/documents?sort=title&member_id=${ahmed.member_id},${tia.member_id}&limit=50`,
    );
    expect(titles(both.items)).toEqual(['Ahmed passport', 'Ahmed will', 'Tia passport']);
    expect(both.total).toBe(3);
    const nobodysOrTia = await ok<DocumentPage>(
      owner,
      `/api/v1/documents?sort=title&member_id=none,${tia.member_id}`,
    );
    expect(titles(nobodysOrTia.items)).toEqual(['House tax return', 'Tia passport']);
    const kinds = await ok<DocumentPage>(
      owner,
      '/api/v1/documents?sort=title&type_key=will,tax_return',
    );
    expect(titles(kinds.items)).toEqual(['Ahmed will', 'House tax return']);
  });

  it('the table: days issued and expiring, both ends included; none without that date', async () => {
    const soon = await ok<DocumentPage>(
      owner,
      `/api/v1/documents?sort=title&expires_from=${dayIn(0)}&expires_to=${dayIn(90)}`,
    );
    expect(titles(soon.items)).toEqual(['Owner passport']);
    const issued = await ok<DocumentPage>(
      owner,
      '/api/v1/documents?sort=issued&issued_from=2019-06-01&issued_to=2023-02-01',
    );
    expect(titles(issued.items)).toEqual(['Ahmed will', 'Owner passport', 'Tia passport']);
    const added = await ok<DocumentPage>(
      owner,
      `/api/v1/documents?sort=title&added_from=${dayIn(-1)}&added_to=${dayIn(1)}`,
    );
    expect(added.total).toBe(5);
    const none = await ok<DocumentPage>(
      owner,
      `/api/v1/documents?sort=title&added_to=${dayIn(-2)}`,
    );
    expect(none.items).toEqual([]);
  });

  it('the table: several statuses, and filters only narrow what the reader may see', async () => {
    const pressing = await ok<DocumentPage>(
      owner,
      '/api/v1/documents?sort=title&status=expired,expiring_soon',
    );
    expect(titles(pressing.items)).toEqual(['Ahmed passport', 'Owner passport']);
    expect(pressing.total).toBe(2);
    // A teen is never given the adults' will, whatever is asked for.
    const teen = await ok<DocumentPage>(
      tia,
      `/api/v1/documents?sort=title&member_id=${ahmed.member_id}&visibility=household,adults`,
    );
    expect(titles(teen.items)).toEqual(['Ahmed passport']);
  });

  it('the older list (no sort) takes them too', async () => {
    const r = await ok<{ items: DocumentView[] }>(
      owner,
      `/api/v1/documents?member_id=${owner.member_id},${tia.member_id}&type_key=passport`,
    );
    expect(titles(r.items)).toEqual(['Owner passport', 'Tia passport']);
    const statuses = await ok<{ items: DocumentView[] }>(
      owner,
      '/api/v1/documents?status=expired,valid&type_key=passport,will',
    );
    expect(titles(statuses.items)).toContain('Ahmed passport');
    expect(titles(statuses.items)).not.toContain('Owner passport');
    // Nobody's goes with a column sort only, as it always has.
    expect(
      (await get(owner, `/api/v1/documents?member_id=none,${owner.member_id}`)).statusCode,
    ).toBe(422);
  });

  it('search: words, narrowed by several people, kinds, statuses and days', async () => {
    const people = await ok<{ items: SearchHit[] }>(
      owner,
      `/api/v1/search?q=passport&member_id=${owner.member_id},${tia.member_id}`,
    );
    expect(titles(people.items)).toEqual(['Owner passport', 'Tia passport']);
    const expired = await ok<{ items: SearchHit[] }>(
      owner,
      '/api/v1/search?q=passport&status=expired',
    );
    expect(titles(expired.items)).toEqual(['Ahmed passport']);
    const days = await ok<{ items: SearchHit[] }>(
      owner,
      `/api/v1/search?q=passport&expires_from=${dayIn(100)}`,
    );
    expect(titles(days.items)).toEqual(['Tia passport']);
    const kinds = await ok<{ items: SearchHit[] }>(owner, '/api/v1/search?q=ahmed&type_key=will');
    expect(titles(kinds.items)).toEqual(['Ahmed will']);
  });

  it('refuses a filter it cannot read, saying which', async () => {
    const r = await get(owner, '/api/v1/documents?sort=title&status=expired,lost');
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({ error: { code: 'validation_failed' } });
    expect((await get(owner, '/api/v1/search?q=x&expires_to=yesterday')).statusCode).toBe(422);
    // Not sure yet, and the household's, are searched since 0.9.0; a word that is neither is not.
    expect((await get(owner, '/api/v1/search?q=x&member_id=none')).statusCode).toBe(200);
    expect((await get(owner, '/api/v1/search?q=x&member_id=nobody')).statusCode).toBe(422);
  });
});
