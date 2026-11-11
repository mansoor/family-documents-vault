import { testAdminUrl } from '@fdv/db/testing';
import type { Capabilities, DocumentPage, DocumentView, SearchHit } from '@fdv/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { ApiError } from '../errors.js';
import { createHarness, type Harness } from '../test-harness.js';
import { asLists, filtersOf } from './filters.js';

/**
 * The owner's tidy-up of 11 Nov 2026 (`features.tag_filters`,
 * `features.notes_apart`): the phone's Documents tab and the web's
 * Documents table keep to documents, the notes having their own place; and
 * the phone's filter panel narrows by several tags, on the list and in
 * search alike.
 */

describe('several tags, and notes left out: read', () => {
  it('one tag is the filter as it always was; several are any of them, never split at a comma', () => {
    expect(filtersOf({ tag: 'Tax' })).toEqual({ single: { tag: 'Tax' }, many: {} });
    expect(filtersOf({ tag: ['Tax', ' tax, 2025 ', 'Tax', ''] }).many).toEqual({
      tags: ['Tax', 'tax, 2025'],
    });
    expect(filtersOf({ tag: [' '] })).toEqual({ single: {}, many: {} });
    expect(filtersOf({ notes: 'exclude' }).many).toEqual({ without_notes: true });
    expect(asLists({ tag: 'Tax' }, {})).toEqual({ tags: ['Tax'] });
  });

  it('refuses more tags than a filter may hold', () => {
    const many = Array.from({ length: 51 }, (_, i) => `t${i}`);
    expect(() => filtersOf({ tag: many })).toThrow(ApiError);
  });
});

describe.skipIf(!testAdminUrl())('several tags, and notes left out', () => {
  let h: Harness;
  let owner: Tokens;

  const json = <T>(r: { json: () => unknown }) => r.json() as T;
  const get = async (url: string) => h.app.inject({ url, headers: h.as(owner) });
  const ok = async <T>(url: string): Promise<T> => {
    const r = await get(url);
    expect(r.statusCode, r.body).toBe(200);
    return json<T>(r);
  };
  const titles = (docs: { title: string | null }[]) => docs.map((d) => d.title).sort();
  const make = async (payload: Record<string, unknown>) => {
    const r = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(owner),
      payload: { visibility: 'household', owner_member_id: owner.member_id, ...payload },
    });
    expect(r.statusCode, r.body).toBe(201);
    return json<DocumentView>(r);
  };

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    owner = await h.setup();
    await make({ title: 'Garden passport', type_key: 'passport', tags: ['Travel'] });
    await make({ title: 'Garden tax return', type_key: 'tax_return', tags: ['tax, 2025'] });
    await make({ title: 'Garden will', type_key: 'will', tags: ['Family'] });
    await make({
      title: 'Garden code',
      type_key: 'note',
      notes: 'The gate code is 4821.',
      tags: ['travel'],
    });
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  it('says so in its capabilities', async () => {
    const caps = await ok<Capabilities>('/api/v1/capabilities');
    expect(caps.features.tag_filters).toBe(true);
    expect(caps.features.notes_apart).toBe(true);
  });

  it('the table and the older list: notes left out, and counted without them', async () => {
    const all = await ok<DocumentPage>('/api/v1/documents?sort=title&limit=50');
    expect(titles(all.items)).toContain('Garden code');
    const apart = await ok<DocumentPage>('/api/v1/documents?sort=title&notes=exclude&limit=50');
    expect(titles(apart.items)).toEqual(['Garden passport', 'Garden tax return', 'Garden will']);
    expect(apart.total).toBe(3);
    const older = await ok<{ items: DocumentView[] }>('/api/v1/documents?notes=exclude');
    expect(titles(older.items)).not.toContain('Garden code');
  });

  it('several tags, any of them, whatever their case; a comma is part of a tag', async () => {
    const two = await ok<DocumentPage>(
      `/api/v1/documents?sort=title&tag=TRAVEL&tag=${encodeURIComponent('Tax, 2025')}`,
    );
    expect(titles(two.items)).toEqual(['Garden code', 'Garden passport', 'Garden tax return']);
    expect(two.total).toBe(3);
    const withoutNotes = await ok<DocumentPage>(
      '/api/v1/documents?sort=title&tag=travel&tag=family&notes=exclude',
    );
    expect(titles(withoutNotes.items)).toEqual(['Garden passport', 'Garden will']);
    const older = await ok<{ items: DocumentView[] }>('/api/v1/documents?tag=travel&tag=family');
    expect(titles(older.items)).toEqual(['Garden code', 'Garden passport', 'Garden will']);
    // One tag, as it always was.
    const one = await ok<DocumentPage>('/api/v1/documents?sort=title&tag=Family');
    expect(titles(one.items)).toEqual(['Garden will']);
  });

  it('search: by tags, and without the notes', async () => {
    const tagged = await ok<{ items: SearchHit[] }>('/api/v1/search?q=garden&tag=travel');
    expect(titles(tagged.items)).toEqual(['Garden code', 'Garden passport']);
    const apart = await ok<{ items: SearchHit[] }>(
      '/api/v1/search?q=garden&tag=travel&tag=family&notes=exclude',
    );
    expect(titles(apart.items)).toEqual(['Garden passport', 'Garden will']);
  });

  it('refuses notes asked for any other way', async () => {
    expect((await get('/api/v1/documents?sort=title&notes=only')).statusCode).toBe(422);
    expect((await get('/api/v1/search?q=garden&notes=yes')).statusCode).toBe(422);
  });
});
