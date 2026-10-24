import { testAdminUrl } from '@fdv/db/testing';
import type { CollectionDetail, DocumentPage, DocumentView } from '@fdv/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * A collection's documents as the Documents table (0.9.0, CV): the web asks
 * the table's own call with the collection as its filter
 * (GET /documents?sort=…&collection_id=…), and is given exactly what the
 * collection's page gives the same reader — the same documents, the same
 * count — by today's collection rules: never another's Only me in a
 * collection shared with the family, never Adults only to a teen, nothing
 * in the Trash, nothing at all of a collection the reader may not see. And
 * taking one out, and putting it back (Undo), stay its maker's alone.
 */

describe.skipIf(!testAdminUrl())('a collection’s documents as the table (0.9.0, CV)', () => {
  let h: Harness;
  let owner: Tokens;
  let ahmed: Tokens;
  let tia: Tokens;
  let uma: Tokens;
  const ids: Record<string, string> = {};
  let trip = '';
  let mine = '';

  const json = <T>(r: { json: () => unknown }) => r.json() as T;

  const make = async (
    key: string,
    by: Tokens,
    payload: { title: string; visibility?: string; owner_member_id?: string | null },
  ) => {
    const r = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(by),
      payload: { visibility: 'household', ...payload },
    });
    expect(r.statusCode, r.body).toBe(201);
    ids[key] = json<DocumentView>(r).id;
  };

  const collection = async (by: Tokens, name: string, audience: string, docs: string[]) => {
    const made = await h.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: h.as(by),
      payload: { name, audience },
    });
    expect(made.statusCode, made.body).toBe(201);
    const id = json<{ id: string }>(made).id;
    const put = await h.app.inject({
      method: 'POST',
      url: `/api/v1/collections/${id}/items`,
      headers: h.as(by),
      payload: { document_ids: docs.map((k) => ids[k]) },
    });
    expect(put.statusCode, put.body).toBe(200);
    return id;
  };

  /** What the table gives `who` of collection `id`: its documents' ids, and its count. */
  const table = async (who: Tokens, id: string, sort = 'title') => {
    const r = await h.app.inject({
      url: `/api/v1/documents?sort=${sort}&collection_id=${id}&limit=200`,
      headers: h.as(who),
    });
    expect(r.statusCode, r.body).toBe(200);
    const page = json<DocumentPage>(r);
    return { ids: page.items.map((d) => d.id).sort(), total: page.total };
  };

  /** What the collection's page gives `who`: its documents' ids, and its count; null for none. */
  const pageOf = async (who: Tokens, id: string) => {
    const r = await h.app.inject({
      url: `/api/v1/collections/${id}?limit=200`,
      headers: h.as(who),
    });
    if (r.statusCode === 404) return null;
    expect(r.statusCode, r.body).toBe(200);
    const c = json<CollectionDetail>(r);
    return { ids: c.items.map((i) => i.document.id).sort(), total: c.item_count };
  };

  /** The table and the page agree, for every reader; what the page gives is `expected`. */
  const agree = async (id: string, expected: Array<[Tokens, string[] | null]>) => {
    for (const [who, keys] of expected) {
      const want = keys === null ? null : keys.map((k) => ids[k] as string).sort();
      const page = await pageOf(who, id);
      const shown = await table(who, id);
      expect(page?.ids ?? null).toEqual(want);
      expect(shown.ids).toEqual(want ?? []);
      expect(shown.total).toBe(want?.length ?? 0);
      if (page) expect(page.total).toBe(shown.total);
      // However it is sorted: the same documents.
      for (const sort of ['status', 'person', 'visibility']) {
        expect((await table(who, id, sort)).ids).toEqual(want ?? []);
      }
    }
  };

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    owner = await h.setup();
    ahmed = await h.join(owner, { name: 'Ahmed', email: 'ahmed-cv@example.test', role: 'adult' });
    tia = await h.join(owner, { name: 'Tia', email: 'tia-cv@example.test', role: 'teen' });
    uma = await h.join(owner, { name: 'Uma', email: 'uma-cv@example.test', role: 'viewer' });

    await make('everyone', ahmed, { title: 'Boarding passes' });
    await make('adults', ahmed, { title: 'Hotel invoice', visibility: 'adults' });
    // Ahmed's own, Only me, in his collection for the whole family.
    await make('hisOwn', ahmed, {
      title: 'Ahmed’s medical letter',
      visibility: 'private',
      owner_member_id: ahmed.member_id,
    });
    await make('later', ahmed, { title: 'Car hire', owner_member_id: ahmed.member_id });
    await make('binned', ahmed, { title: 'Old itinerary' });
    await make('outside', ahmed, { title: 'Not in the trip' });
    // The owner's own Only me, in the owner's own collection.
    await make('ownersOwn', owner, {
      title: 'Owner’s will',
      visibility: 'private',
      owner_member_id: owner.member_id,
    });
    trip = await collection(ahmed, 'Trip', 'everyone', [
      'everyone',
      'adults',
      'hisOwn',
      'later',
      'binned',
    ]);
    mine = await collection(owner, 'Mine alone', 'only_me', ['ownersOwn', 'everyone']);

    // One to the Trash, and one made Only me by its owner, after they went in.
    const binned = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/documents/${ids.binned}`,
      headers: h.as(ahmed),
    });
    expect(binned.statusCode, binned.body).toBe(204);
    const later = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${ids.later}/visibility`,
      headers: h.as(ahmed),
      payload: { visibility: 'private' },
    });
    expect(later.statusCode, later.body).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  it('gives each reader what the collection’s page gives them, counted the same: never another’s Only me', async () => {
    await agree(trip, [
      // Its maker: all of it but the Trash.
      [ahmed, ['everyone', 'adults', 'hisOwn', 'later']],
      // The owner: never Ahmed's Only me, whenever it was made so.
      [owner, ['everyone', 'adults']],
      // A teen: never Adults only either.
      [tia, ['everyone']],
      // A viewer given no collection: none of it, not even a count.
      [uma, null],
    ]);
  });

  it('a collection the reader may not see gives them nothing at all', async () => {
    await agree(mine, [
      [owner, ['ownersOwn', 'everyone']],
      [ahmed, null],
      [tia, null],
    ]);
  });

  it('taking out and putting back (Undo) stay its maker’s alone, and never touch the document', async () => {
    const before = json<DocumentView>(
      await h.app.inject({ url: `/api/v1/documents/${ids.everyone}`, headers: h.as(ahmed) }),
    );
    for (const who of [owner, tia]) {
      const out = await h.app.inject({
        method: 'DELETE',
        url: `/api/v1/collections/${trip}/items/${ids.everyone}`,
        headers: h.as(who),
      });
      expect(out.statusCode, out.body).toBe(403);
      const back = await h.app.inject({
        method: 'POST',
        url: `/api/v1/collections/${trip}/items`,
        headers: h.as(who),
        payload: { document_ids: [ids.outside] },
      });
      expect(back.statusCode, back.body).toBe(403);
    }
    const out = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${trip}/items/${ids.everyone}`,
      headers: h.as(ahmed),
    });
    expect(out.statusCode, out.body).toBe(204);
    expect((await table(owner, trip)).ids).toEqual([ids.adults].sort());
    // The document itself is as it was, and still in the vault.
    const after = json<DocumentView>(
      await h.app.inject({ url: `/api/v1/documents/${ids.everyone}`, headers: h.as(ahmed) }),
    );
    expect(after.etag).toBe(before.etag);
    expect(after.deleted_at ?? null).toBeNull();
    // Undo: back in by the same Add.
    const back = await h.app.inject({
      method: 'POST',
      url: `/api/v1/collections/${trip}/items`,
      headers: h.as(ahmed),
      payload: { document_ids: [ids.everyone] },
    });
    expect(back.statusCode, back.body).toBe(200);
    await agree(trip, [
      [ahmed, ['everyone', 'adults', 'hisOwn', 'later']],
      [owner, ['everyone', 'adults']],
    ]);
  });
});
