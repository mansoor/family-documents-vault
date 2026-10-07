import { createPool, withPrincipal, type Schema } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import { Kysely, PostgresDialect } from 'kysely';
import {
  DOCUMENT_SORTS,
  statusRank,
  type DocumentPage,
  type DocumentSort,
  type DocumentTypeView,
  type DocumentView,
} from '@fdv/shared';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codeFor } from '../auth/totp.js';
import type { Principal, Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';
import { documentTable } from './table.js';

/**
 * The Documents table (Phase 6, R2): GET /documents sorted by a column,
 * filtered, a page at a time — what each reader may see already, and
 * nothing more, in an order that never tells a viewer where anything is.
 *
 * The family: an owner; Ahmed, an adult; Tia, a teen; Uma, a viewer with no
 * limits; Val, a viewer limited to Ahmed's tax returns and the collection
 * "Travel"; and Jane, a guest given Ahmed's tax returns.
 */

const DAY = 86_400_000;
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();
const dayIn = (n: number) => inDays(n).slice(0, 10);

type Page = DocumentPage;

describe.skipIf(!testAdminUrl())('the Documents table (R2)', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  let owner: Tokens;
  let ahmed: Tokens;
  let tia: Tokens;
  let uma: Tokens;
  let val: Tokens;
  let jane: Tokens;
  let types: DocumentTypeView[] = [];
  const names = new Map<string, string>();
  const ids: Record<string, string> = {};
  const collections: Record<string, string> = {};

  const json = <T>(r: { json: () => unknown }) => r.json() as T;

  const ask = async (who: Tokens, query: string) =>
    h.app.inject({ url: `/api/v1/documents?${query}`, headers: h.as(who) });

  /** One page, which must be answered. */
  const page = async (who: Tokens, query: string): Promise<Page> => {
    const r = await ask(who, query);
    expect(r.statusCode, r.body).toBe(200);
    return json<Page>(r);
  };

  /** Every page, `limit` at a time, following the cursors to the end. */
  const all = async (who: Tokens, query: string, limit = 3): Promise<DocumentView[]> => {
    const out: DocumentView[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 100; i++) {
      const p: Page = await page(
        who,
        `${query}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      out.push(...p.items);
      expect(p.has_more).toBe(p.next_cursor !== null);
      if (!p.next_cursor) return out;
      expect(p.items).toHaveLength(limit);
      cursor = p.next_cursor;
    }
    throw new Error('the pages never ended');
  };

  const titles = (docs: DocumentView[]) => docs.map((d) => d.title);

  const make = async (
    key: string,
    payload: {
      title: string | null;
      type_key?: string | null;
      owner_member_id?: string | null;
      visibility?: string;
      issued?: string;
      expires?: string;
      physical_location?: string;
      tags?: string[];
      identifier?: string;
    },
    by: Tokens = owner,
  ) => {
    const { issued, expires, ...rest } = payload;
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(by),
      payload: {
        type_key: null,
        owner_member_id: null,
        visibility: 'household',
        ...rest,
        ...(issued ? { issued: { date: issued, precision: 'day' } } : {}),
        ...(expires ? { expires: { date: expires, precision: 'day' } } : {}),
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    ids[key] = json<DocumentView>(created).id;
  };

  const collection = async (
    name: string,
    audience: string,
    documents: string[],
    by: Tokens = owner,
  ) => {
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
      payload: { document_ids: documents.map((k) => ids[k]) },
    });
    expect(put.statusCode, put.body).toBe(200);
    collections[name] = id;
  };

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    admin = createPool(h.adminUrl, 2);
    owner = await h.setup();
    ahmed = await h.join(owner, { name: 'Ahmed', email: 'ahmed-r2@example.test', role: 'adult' });
    tia = await h.join(owner, { name: 'Tia', email: 'tia-r2@example.test', role: 'teen' });
    uma = await h.join(owner, { name: 'Uma', email: 'uma-r2@example.test', role: 'viewer' });
    val = await h.join(owner, { name: 'Val', email: 'val-r2@example.test', role: 'viewer' });

    await make('alpha', {
      title: 'Alpha passport',
      type_key: 'passport',
      owner_member_id: owner.member_id,
      identifier: 'P1',
      issued: '2020-01-10',
      expires: dayIn(800),
      physical_location: 'Fire safe',
      tags: ['travel'],
    });
    await make('bravo', {
      title: 'bravo tax return',
      type_key: 'tax_return',
      owner_member_id: ahmed.member_id,
      issued: '2025-04-05',
      physical_location: 'Study drawer',
      tags: ['tax'],
    });
    await make('charlie', {
      title: 'Charlie will',
      type_key: 'will',
      owner_member_id: ahmed.member_id,
      visibility: 'adults',
      issued: '2019-06-01',
      physical_location: 'Bank vault',
    });
    await make('delta', {
      title: 'Delta passport',
      type_key: 'passport',
      owner_member_id: owner.member_id,
      identifier: 'P2',
      issued: '2015-03-01',
      expires: dayIn(-1),
      tags: ['travel'],
    });
    await make('echo', {
      title: 'Echo passport',
      type_key: 'passport',
      owner_member_id: tia.member_id,
      identifier: 'P3',
      issued: '2021-01-01',
      expires: dayIn(30),
      physical_location: 'Fire safe',
      tags: ['travel'],
    });
    await make('foxtrot', {
      title: 'Foxtrot deed box',
      type_key: 'other',
      physical_location: 'Loft',
      tags: ['house'],
    });
    await make('golf', { title: null, owner_member_id: owner.member_id });
    await make('hotel', {
      title: 'Hotel tax return',
      type_key: 'tax_return',
      owner_member_id: ahmed.member_id,
      issued: '2024-04-05',
      physical_location: 'fire safe',
      tags: ['tax'],
    });
    await make('india', {
      title: 'India private',
      type_key: 'other',
      owner_member_id: owner.member_id,
      visibility: 'private',
      physical_location: 'Desk',
    });
    // Two with one title, kept in places whose order is the other way to
    // their ids': a sort by title breaks the tie by id, never by where.
    for (const key of ['same1', 'same2']) {
      await make(key, { title: 'Same title', type_key: 'other', owner_member_id: owner.member_id });
    }
    const [lower, higher] = [ids.same1 as string, ids.same2 as string].sort();
    for (const [id, where] of [
      [higher, 'A shelf'],
      [lower, 'Z shelf'],
    ] as const) {
      const now = json<DocumentView>(
        await h.app.inject({ url: `/api/v1/documents/${id}`, headers: h.as(owner) }),
      );
      const kept = await h.app.inject({
        method: 'PATCH',
        url: `/api/v1/documents/${id}`,
        headers: { ...h.as(owner), 'if-match': now.etag },
        payload: { physical_location: where },
      });
      expect(kept.statusCode, kept.body).toBe(200);
    }

    await collection('Travel', 'everyone', ['alpha', 'delta', 'hotel']);
    await collection('Archive', 'adults', ['delta', 'foxtrot']);
    await collection('Ahmed only', 'only_me', ['bravo'], ahmed);

    // Val: Ahmed's tax returns, and the collection Travel (written as an
    // operator would, as the restriction's own tests do).
    const hh = owner.household_id;
    await admin.query(
      `insert into access_restriction (member_id, household_id, limits_people, limits_types)
       values ($1, $2, true, true)`,
      [val.member_id, hh],
    );
    await admin.query(
      `insert into access_restriction_member (restricted_member_id, household_id, member_id)
       values ($1, $2, $3)`,
      [val.member_id, hh, ahmed.member_id],
    );
    await admin.query(
      `insert into access_restriction_type (restricted_member_id, household_id, type_key)
       values ($1, $2, 'tax_return')`,
      [val.member_id, hh],
    );
    await admin.query(
      `insert into access_restriction_collection (restricted_member_id, household_id, collection_id)
       values ($1, $2, $3)`,
      [val.member_id, hh, collections.Travel],
    );

    // Jane, a guest: invited by the owner (who has two-step sign-in, as a
    // guest's invitation asks) to Ahmed's tax returns, and accepted.
    const enrol = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/enrol',
      headers: h.as(owner),
    });
    const secret = json<{ secret: string }>(enrol).secret;
    const confirmed = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/confirm',
      headers: h.as(owner),
      payload: { code: codeFor(secret) },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(204);
    await admin.query(
      `update session set verified_at = now(), factor_verified_at = now()
        where account_id = (select account_id from account_household where member_id = $1)`,
      [owner.member_id],
    );
    const invited = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invitations',
      headers: h.as(owner),
      payload: {
        display_name: 'Jane Smith',
        relationship: 'attorney',
        email: 'jane-r2@example.test',
        role: 'viewer',
        kind: 'guest',
        restriction: { people: [ahmed.member_id], types: ['tax_return'] },
        access_expires_at: inDays(30),
      },
    });
    expect(invited.statusCode, invited.body).toBe(201);
    const { link_token, code } = json<{ link_token: string; code: string }>(invited);
    const accepted = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      payload: { token: link_token, code, password: 'the guest’s own password' },
      remoteAddress: '10.42.0.2',
    });
    expect(accepted.statusCode, accepted.body).toBe(201);
    jane = json<Tokens>(accepted);

    types = json<{ items: DocumentTypeView[] }>(
      await h.app.inject({ url: '/api/v1/document-types?all=true', headers: h.as(owner) }),
    ).items;
    const members = json<{ items: Array<{ id: string; display_name: string }> }>(
      await h.app.inject({ url: '/api/v1/members', headers: h.as(owner) }),
    ).items;
    for (const m of members) names.set(m.id, m.display_name);
  }, 180_000);

  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  /** What each sort orders by, read from the document as it is answered. */
  const keyFor = (sort: DocumentSort, d: DocumentView): string | number | null => {
    const low = (s: string | null | undefined) => (s && s.trim() ? s.trim().toLowerCase() : null);
    switch (sort) {
      case 'title':
        return low(d.title);
      case 'kind':
        return low(types.find((t) => t.key === d.type_key)?.label);
      case 'person':
        return low(d.owner_member_id ? names.get(d.owner_member_id) : null);
      case 'issued':
        return d.issued?.date ?? null;
      case 'expires':
        return d.expires?.date ?? null;
      case 'status':
        return statusRank(d.status.value);
      case 'visibility':
        return { household: 0, adults: 1, private: 2 }[d.visibility];
      case 'collections':
        return low(d.collections?.[0]?.name);
      case 'location':
        return low(d.physical_location);
    }
  };

  /**
   * Whether `docs` are in `sort`'s order, `dir`: each key no further than
   * the next (strings as the database's collation and ours agree on these
   * plain words), blanks last whichever way, a tie by id, and by status
   * the sooner expiry first, none last.
   */
  const inOrder = (sort: DocumentSort, dir: 'asc' | 'desc', docs: DocumentView[]) => {
    const sign = dir === 'desc' ? -1 : 1;
    for (let i = 1; i < docs.length; i++) {
      const [a, b] = [docs[i - 1] as DocumentView, docs[i] as DocumentView];
      const [ka, kb] = [keyFor(sort, a), keyFor(sort, b)];
      const where = `${sort} ${dir} at ${i}: ${a.title} (${ka}) then ${b.title} (${kb})`;
      if (ka === null) {
        expect(kb, where).toBeNull();
      } else if (kb !== null && ka !== kb) {
        expect((ka < kb ? -1 : 1) * sign, where).toBe(-1);
        continue;
      }
      if (ka !== kb) continue;
      if (sort === 'status') {
        const [ea, eb] = [a.expires?.date ?? null, b.expires?.date ?? null];
        if (ea !== eb) {
          if (ea === null) throw new Error(`${where}: no expiry before one`);
          if (eb !== null) expect((ea < eb ? -1 : 1) * sign, where).toBe(-1);
          continue;
        }
      }
      expect((a.id < b.id ? -1 : 1) * sign, `${where}: the tie, by id`).toBe(-1);
    }
  };

  it('sorts by every column, both ways, blanks last, a page at a time without a gap or a repeat', async () => {
    const everything = (await page(owner, 'sort=title&limit=200')).items;
    expect(everything.length).toBe(11);
    for (const sort of DOCUMENT_SORTS) {
      for (const dir of ['asc', 'desc'] as const) {
        const whole = await page(owner, `sort=${sort}&direction=${dir}&limit=200`);
        expect(whole.total).toBe(11);
        expect(whole.has_more).toBe(false);
        inOrder(sort, dir, whole.items);
        // The same, three at a time.
        const paged = await all(owner, `sort=${sort}&direction=${dir}`);
        expect(paged.map((d) => d.id)).toEqual(whole.items.map((d) => d.id));
      }
    }
    // By title, as a person reads it: case aside, the untitled one last.
    expect(titles((await page(owner, 'sort=title&limit=200')).items)).toEqual([
      'Alpha passport',
      'bravo tax return',
      'Charlie will',
      'Delta passport',
      'Echo passport',
      'Foxtrot deed box',
      'Hotel tax return',
      'India private',
      'Same title',
      'Same title',
      null,
    ]);
    // Descending, the untitled one is still last: a blank is never "first".
    const down = titles((await page(owner, 'sort=title&direction=desc&limit=200')).items);
    expect(down[0]).toBe('Same title');
    expect(down[down.length - 1]).toBeNull();
    // Most pressing first: what has run out, then what runs out soon.
    const byStatus = (await page(owner, 'sort=status&limit=3')).items;
    expect(byStatus.map((d) => d.status.value).slice(0, 2)).toEqual(['expired', 'expiring_soon']);
    expect(titles(byStatus).slice(0, 2)).toEqual(['Delta passport', 'Echo passport']);
  }, 60_000);

  it('a page knows its collections, of those the reader may see, by name; none in the Trash', async () => {
    const docs = (await page(owner, 'sort=title&limit=200')).items;
    const of = (k: string) => docs.find((d) => d.id === ids[k])?.collections?.map((c) => c.name);
    expect(of('delta')).toEqual(['Archive', 'Travel']);
    expect(of('alpha')).toEqual(['Travel']);
    // Ahmed's Only me collection is his alone.
    expect(of('bravo')).toEqual([]);
    const his = (await page(ahmed, 'sort=title&limit=200')).items;
    expect(his.find((d) => d.id === ids.bravo)?.collections?.map((c) => c.name)).toEqual([
      'Ahmed only',
    ]);
    // A teen is not among the adults the Archive is for.
    const teen = (await page(tia, 'sort=title&limit=200')).items;
    expect(teen.find((d) => d.id === ids.delta)?.collections?.map((c) => c.name)).toEqual([
      'Travel',
    ]);
    // By collection, the first of them by name; those in none last.
    const byCollection = titles((await page(owner, 'sort=collections&limit=200')).items);
    // Archive's two (tied, so by id), then Travel's.
    expect(byCollection.slice(0, 2).sort()).toEqual(['Delta passport', 'Foxtrot deed box']);
    expect(byCollection.slice(2, 4).sort()).toEqual(['Alpha passport', 'Hotel tax return']);
  });

  it('filters by person (or nobody), kind, status, visibility, collection (or none), tag and location, and counts them', async () => {
    const set = async (who: Tokens, query: string) => {
      const p = await page(who, `sort=title&limit=200&${query}`);
      expect(p.total, query).toBe(p.items.length);
      return titles(p.items).sort();
    };
    expect(await set(owner, `member_id=${ahmed.member_id}`)).toEqual([
      'Charlie will',
      'Hotel tax return',
      'bravo tax return',
    ]);
    expect(await set(owner, 'member_id=none')).toEqual(['Foxtrot deed box']);
    expect(await set(owner, 'type_key=passport')).toEqual([
      'Alpha passport',
      'Delta passport',
      'Echo passport',
    ]);
    expect(await set(owner, 'status=expired')).toEqual(['Delta passport']);
    expect(await set(owner, 'status=expiring_soon')).toEqual(['Echo passport']);
    expect(await set(owner, 'visibility=adults')).toEqual(['Charlie will']);
    expect(await set(owner, 'visibility=private')).toEqual(['India private']);
    expect(await set(owner, `collection_id=${collections.Travel}`)).toEqual([
      'Alpha passport',
      'Delta passport',
      'Hotel tax return',
    ]);
    // Nobody learns what is in a collection they may not see: not even that it holds anything.
    expect(await set(owner, `collection_id=${collections['Ahmed only']}`)).toEqual([]);
    expect(await set(owner, 'collection_id=none')).toEqual(
      [
        'Charlie will',
        'Echo passport',
        'India private',
        'Same title',
        'Same title',
        'bravo tax return',
        // The untitled one.
        null,
      ].sort(),
    );
    expect(await set(owner, 'tag=tax')).toEqual(['Hotel tax return', 'bravo tax return']);
    // Kept there, whatever the case and the spaces.
    expect(await set(owner, `location=${encodeURIComponent('  FIRE SAFE ')}`)).toEqual([
      'Alpha passport',
      'Echo passport',
      'Hotel tax return',
    ]);
    // Together, and with a status, a page still full and the count still right.
    expect(await set(owner, 'tag=travel&status=active')).toEqual(['Alpha passport']);
    const two = await page(owner, 'sort=kind&type_key=passport&status=expired&limit=1');
    expect(two.total).toBe(1);
    expect(two.has_more).toBe(false);
    // A teen sorts and filters by where originals are kept, as the family does.
    expect((await ask(tia, 'sort=location')).statusCode).toBe(200);
    expect(await set(tia, `location=${encodeURIComponent('Fire safe')}`)).toEqual([
      'Alpha passport',
      'Echo passport',
      'Hotel tax return',
    ]);
  });

  it('pages stay whole while documents come and change between them', async () => {
    const first = await page(owner, 'sort=title&limit=4');
    expect(titles(first.items)).toEqual([
      'Alpha passport',
      'bravo tax return',
      'Charlie will',
      'Delta passport',
    ]);
    // Meanwhile: one before where the page ended, one after, and one of the
    // next page's renamed to before it too.
    await make('aardvark', { title: 'Aardvark certificate', type_key: 'other' });
    await make('zulu', { title: 'Zulu letter', type_key: 'other' });
    const foxtrot = json<DocumentView>(
      await h.app.inject({ url: `/api/v1/documents/${ids.foxtrot}`, headers: h.as(owner) }),
    );
    const renamed = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/documents/${ids.foxtrot}`,
      headers: { ...h.as(owner), 'if-match': foxtrot.etag },
      payload: { title: 'Abacus deed box' },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    let cursor = first.next_cursor as string;
    const rest: DocumentView[] = [];
    for (;;) {
      const p = await page(owner, `sort=title&limit=4&cursor=${encodeURIComponent(cursor)}`);
      rest.push(...p.items);
      if (!p.next_cursor) break;
      cursor = p.next_cursor;
    }
    // Nothing of the first page again, nothing skipped after it, and what
    // now sorts before where it ended is for a fresh look.
    expect(titles(rest)).toEqual([
      'Echo passport',
      'Hotel tax return',
      'India private',
      'Same title',
      'Same title',
      'Zulu letter',
      null,
    ]);
    for (const k of ['aardvark', 'zulu']) {
      const gone = await h.app.inject({
        method: 'DELETE',
        url: `/api/v1/documents/${ids[k]}`,
        headers: h.as(owner),
      });
      expect(gone.statusCode).toBe(204);
    }
    const back = json<DocumentView>(
      await h.app.inject({ url: `/api/v1/documents/${ids.foxtrot}`, headers: h.as(owner) }),
    );
    const restored = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/documents/${ids.foxtrot}`,
      headers: { ...h.as(owner), 'if-match': back.etag },
      payload: { title: 'Foxtrot deed box' },
    });
    expect(restored.statusCode, restored.body).toBe(200);
  });

  it('the Trash sorts and filters too: in no collection while it is there', async () => {
    const trash = await page(owner, 'sort=title&deleted=true&limit=200');
    expect(titles(trash.items)).toEqual(['Aardvark certificate', 'Zulu letter']);
    expect(trash.items.every((d) => d.collections?.length === 0)).toBe(true);
    expect(trash.total).toBe(2);
  });

  /** What a cursor says, before its tag: the vault's own words, readable but not changeable. */
  const cursorBody = (c: string) =>
    Buffer.from(c.split('.')[0] as string, 'base64url').toString('utf8');

  it('a kind is named in a sort only as the kinds would name it to the reader: never one used only in the Trash, to somebody who files nothing (R2-API-1)', async () => {
    const made = await h.app.inject({
      method: 'POST',
      url: '/api/v1/document-types',
      headers: h.as(owner),
      payload: { label: 'Divorce proceedings', category: 'legal' },
    });
    expect(made.statusCode, made.body).toBe(201);
    const kind = json<{ key: string }>(made).key;
    await make('papers', { title: 'Papers', type_key: kind, visibility: 'household' });
    const gone = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/documents/${ids.papers}`,
      headers: h.as(owner),
    });
    expect(gone.statusCode).toBe(204);
    // Uma, who files nothing, is not given the kind: no document of it she
    // sees is out of the Trash.
    const hers = json<{ items: DocumentTypeView[] }>(
      await h.app.inject({ url: '/api/v1/document-types?all=true', headers: h.as(uma) }),
    ).items;
    expect(hers.some((t) => t.key === kind)).toBe(false);
    // Her Trash, sorted by kind a page at a time: Papers sorts as of no kind,
    // last, and no cursor names the kind.
    const pages: Page[] = [];
    let cursor: string | null = null;
    do {
      const p: Page = await page(
        uma,
        `sort=kind&deleted=true&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      pages.push(p);
      cursor = p.next_cursor;
    } while (cursor);
    const order = pages.flatMap((p) => titles(p.items));
    // The two of a kind she is given (tied, so by id), then Papers.
    expect(order.slice(0, 2).sort()).toEqual(['Aardvark certificate', 'Zulu letter']);
    expect(order.slice(2)).toEqual(['Papers']);
    for (const p of pages) {
      if (p.next_cursor) expect(cursorBody(p.next_cursor)).not.toMatch(/divorce/i);
    }
    // The same the other way.
    const down = await all(uma, 'sort=kind&direction=desc&deleted=true', 1);
    expect(titles(down).at(-1)).toBe('Papers');
    // The owner, who files documents, is given every kind: it sorts by its name.
    const hisFirst = await page(owner, 'sort=kind&deleted=true&limit=1');
    expect(titles(hisFirst.items)).toEqual(['Papers']);
    expect(cursorBody(hisFirst.next_cursor as string)).toMatch(/divorce proceedings/);
  });

  it('a cursor is the vault’s own: changed, made up, or another’s, it is refused (R2-API-1)', async () => {
    const first = await page(owner, 'sort=title&limit=2');
    const cursor = first.next_cursor as string;
    expect(cursor).toMatch(/^[\w-]+\.[\w-]{43}$/);
    const [body, tag] = cursor.split('.') as [string, string];
    // Its own, followed: fine.
    expect((await ask(owner, `sort=title&limit=2&cursor=${cursor}`)).statusCode).toBe(200);
    const said = JSON.parse(cursorBody(cursor)) as Record<string, unknown>;
    const reworded = Buffer.from(JSON.stringify({ ...said, k: 'b' })).toString('base64url');
    for (const forged of [
      // What it says changed, its tag kept.
      `${reworded}.${tag}`,
      // Its tag changed.
      `${body}.${tag.slice(0, -1)}${tag.endsWith('A') ? 'B' : 'A'}`,
      // No tag at all, as an older cursor was.
      body,
      `${body}.${tag}.more`,
    ]) {
      const r = await ask(owner, `sort=title&limit=2&cursor=${encodeURIComponent(forged)}`);
      expect(r.statusCode, forged).toBe(422);
    }
    // Somebody else's: a cursor is for whoever it was given to.
    const r = await ask(ahmed, `sort=title&limit=2&cursor=${encodeURIComponent(cursor)}`);
    expect(r.statusCode).toBe(422);
  });

  it('a cursor has room for the longest place a family can write (R2-API-4)', async () => {
    // 500 characters of three bytes each: as long a key as a cursor carries.
    const far = (end: string) => `${'倉'.repeat(499)}${end}`;
    await make('far1', { title: 'Far box one', type_key: 'other', physical_location: far('a') });
    await make('far2', { title: 'Far box two', type_key: 'other', physical_location: far('b') });
    const first = await page(owner, 'sort=location&direction=desc&limit=1');
    expect(titles(first.items)).toEqual(['Far box two']);
    const cursor = first.next_cursor as string;
    expect(cursor.length).toBeGreaterThan(2048);
    const second = await page(
      owner,
      `sort=location&direction=desc&limit=1&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(titles(second.items)).toEqual(['Far box one']);
    for (const k of ['far1', 'far2']) {
      const gone = await h.app.inject({
        method: 'DELETE',
        url: `/api/v1/documents/${ids[k]}`,
        headers: h.as(owner),
      });
      expect(gone.statusCode).toBe(204);
    }
  });

  it('a status is worked out from what makes it, never a note’s words nor what is sealed (R2-API-2)', async () => {
    const statements: string[] = [];
    const pool = createPool(h.appUrl, 1);
    const watched = new Kysely<Schema>({
      dialect: new PostgresDialect({ pool }),
      log: (e) => {
        if (e.level === 'query') statements.push(e.query.sql);
      },
    });
    const account = (
      await admin.query<{ account_id: string }>(
        'select account_id from account_household where member_id = $1',
        [owner.member_id],
      )
    ).rows[0]?.account_id as string;
    const p: Principal = {
      accountId: account,
      sessionId: randomUUID(),
      householdId: owner.household_id,
      memberId: owner.member_id,
      role: 'owner',
      seesAdults: true,
    };
    try {
      for (const q of [
        { sort: 'status' as const },
        { sort: 'title' as const, status: 'expired' },
      ]) {
        statements.length = 0;
        const got = await withPrincipal(watched, p, (trx) =>
          documentTable(
            trx,
            p,
            { ...q, limit: 2 },
            async (rows) => rows as unknown as DocumentView[],
            new Uint8Array(32),
          ),
        );
        expect(got.items.length).toBeGreaterThan(0);
        // The pass over every row the filters give reads whether there are
        // notes, never them, nor anything sealed.
        const pass = statements.find((s) => /has_notes/.test(s)) as string;
        expect(pass).toBeDefined();
        expect(pass).not.toMatch(/d\.notes,|d\.notes_sealed,|d\.extra_sealed/);
        // Only the page's own rows are read whole, by id.
        const whole = statements.filter((s) => /d\.notes_sealed,/.test(s));
        expect(whole).toHaveLength(1);
        expect(whole[0]).toMatch(/d\.id = any\(/);
      }
    } finally {
      await watched.destroy();
    }
  });

  it('a cursor is for the sort and direction it came with, and nothing else', async () => {
    const first = await page(owner, 'sort=issued&limit=2');
    const cursor = first.next_cursor as string;
    for (const query of [
      `sort=kind&cursor=${cursor}`,
      `sort=issued&direction=desc&cursor=${cursor}`,
      `sort=issued&cursor=not-a-cursor`,
      // A day that is not one, which the database would choke on.
      `sort=issued&cursor=${Buffer.from(JSON.stringify({ s: 'issued', d: 'asc', k: 'soon', id: randomUUID() })).toString('base64url')}`,
      `sort=status&cursor=${Buffer.from(JSON.stringify({ s: 'status', d: 'asc', k: 'x', id: randomUUID() })).toString('base64url')}`,
      `sort=title&cursor=${Buffer.from(JSON.stringify({ s: 'title', d: 'asc', k: 'a', id: 'nope' })).toString('base64url')}`,
    ]) {
      const r = await ask(owner, query);
      expect(r.statusCode, query).toBe(422);
      expect(json<{ error: { code: string } }>(r).error.code).toBe('validation_failed');
    }
    // An unknown sort, direction or status is refused as well.
    for (const query of ['sort=colour', 'sort=title&direction=up', 'sort=title&status=lost']) {
      expect((await ask(owner, query)).statusCode, query).toBe(422);
    }
  });

  it('a viewer, limited or not, and a guest may not sort or filter by where originals are kept, nor learn it from the order', async () => {
    for (const who of [uma, val, jane]) {
      for (const query of [
        'sort=location',
        'sort=location&direction=desc',
        'sort=title&location=Fire%20safe',
        'sort=title&location=Desk',
        // An older sort with it is refused too.
        'location=Fire%20safe',
      ]) {
        const r = await ask(who, query);
        expect(r.statusCode, query).toBe(422);
        expect(json<{ error: { code: string } }>(r).error.code).toBe('validation_failed');
      }
      // A cursor made for a sort by location is refused like the sort.
      const forged = Buffer.from(
        JSON.stringify({ s: 'location', d: 'asc', k: 'fire safe', id: ids.alpha }),
      ).toString('base64url');
      expect((await ask(who, `sort=title&cursor=${forged}`)).statusCode).toBe(422);
      expect((await ask(who, `sort=location&cursor=${forged}`)).statusCode).toBe(422);
      // What they are given never says where anything is.
      for (const sort of DOCUMENT_SORTS.filter((s) => s !== 'location')) {
        const docs = (await page(who, `sort=${sort}&limit=200`)).items;
        expect(docs.every((d) => d.physical_location === null)).toBe(true);
      }
    }
    // Two of one title are in their ids' order, whichever is kept where: for
    // a viewer and for the family alike, the tie is never broken by place.
    const [lo, hi] = [ids.same1 as string, ids.same2 as string].sort();
    for (const who of [owner, uma]) {
      for (const dir of ['asc', 'desc'] as const) {
        const docs = (await page(who, `sort=title&direction=${dir}&limit=200`)).items;
        const same = docs.filter((d) => d.title === 'Same title').map((d) => d.id);
        expect(same).toEqual(dir === 'asc' ? [lo, hi] : [hi, lo]);
      }
    }
  }, 60_000);

  it('the family, a teen and a viewer are each given what any list gives them, however it is sorted', async () => {
    const listOf = async (who: Tokens) =>
      (await page(who, 'limit=200')).items.map((d) => d.id).sort();
    // Tia: everything for Everyone, and nothing for the adults or anybody's Only me.
    const tiaList = await listOf(tia);
    expect(tiaList).not.toContain(ids.charlie);
    expect(tiaList).not.toContain(ids.india);
    // Uma, a viewer with no limits: the same, as a viewer.
    const umaList = await listOf(uma);
    expect(umaList).not.toContain(ids.charlie);
    expect(umaList).not.toContain(ids.india);
    for (const [who, list] of [
      [owner, await listOf(owner)],
      [ahmed, await listOf(ahmed)],
      [tia, tiaList],
      [uma, umaList],
    ] as const) {
      for (const sort of ['title', 'status', 'collections', 'person'] as const) {
        const p = await page(who, `sort=${sort}&limit=200`);
        expect(p.items.map((d) => d.id).sort()).toEqual(list);
        expect(p.total).toBe(list.length);
      }
    }
    // The Archive is for the adults: a teen is told of none of it, by a
    // filter or a sort, and so it is in no collection of hers.
    expect((await page(tia, `sort=title&collection_id=${collections.Archive}`)).items).toEqual([]);
    const tiaNone = (await page(tia, 'sort=title&collection_id=none')).items.map((d) => d.id);
    expect(tiaNone).toContain(ids.foxtrot);
    expect(tiaNone).not.toContain(ids.alpha);
    const tiaByCollection = (await page(tia, 'sort=collections&limit=200')).items;
    expect(
      tiaByCollection
        .slice(0, 3)
        .map((d) => d.id)
        .sort(),
    ).toEqual([ids.alpha, ids.delta, ids.hotel].map((x) => x as string).sort());
    // Ahmed's Only me collection is his: its filter gives nobody else anything.
    expect(
      (await page(owner, `sort=title&collection_id=${collections['Ahmed only']}`)).items,
    ).toEqual([]);
    expect(
      (await page(ahmed, `sort=title&collection_id=${collections['Ahmed only']}`)).items.map(
        (d) => d.id,
      ),
    ).toEqual([ids.bravo]);
  }, 60_000);

  it('a limited viewer and a guest are given their grant, and only their grant, however they sort and filter', async () => {
    const grantOf = async (who: Tokens) =>
      (await page(who, 'limit=200')).items.map((d) => d.id).sort();
    const valGrant = await grantOf(val);
    const janeGrant = await grantOf(jane);
    // Val: Ahmed's tax returns, and what is in Travel that she may see.
    expect(valGrant).toEqual(
      [ids.bravo, ids.hotel, ids.alpha, ids.delta].map((x) => x as string).sort(),
    );
    expect(janeGrant).toEqual([ids.bravo, ids.hotel].map((x) => x as string).sort());
    for (const [who, grant] of [
      [val, valGrant],
      [jane, janeGrant],
    ] as const) {
      for (const sort of DOCUMENT_SORTS.filter((s) => s !== 'location')) {
        for (const dir of ['asc', 'desc'] as const) {
          const whole = await page(who, `sort=${sort}&direction=${dir}&limit=200`);
          expect(whole.items.map((d) => d.id).sort()).toEqual(grant);
          expect(whole.total).toBe(grant.length);
          const paged = await all(who, `sort=${sort}&direction=${dir}`, 1);
          expect(paged.map((d) => d.id)).toEqual(whole.items.map((d) => d.id));
        }
      }
      // A filter narrows the grant, and never reaches past it.
      for (const query of [
        `member_id=${owner.member_id}`,
        `member_id=${tia.member_id}`,
        'member_id=none',
        'type_key=will',
        'visibility=adults',
        'visibility=private',
        `collection_id=${collections.Archive}`,
        `collection_id=${collections['Ahmed only']}`,
        'tag=house',
        'status=expiring_soon',
      ]) {
        const p = await page(who, `sort=title&limit=200&${query}`);
        for (const d of p.items) expect(grant, query).toContain(d.id);
        expect(p.total, query).toBe(p.items.length);
      }
      expect((await page(who, 'sort=title&limit=200&member_id=none')).items).toEqual([]);
      expect((await page(who, `sort=title&limit=200&member_id=${tia.member_id}`)).items).toEqual(
        [],
      );
    }
    // The collections Val is told of: the one she was given, and no other.
    const valDocs = (await page(val, 'sort=collections&limit=200')).items;
    const seen = new Set(valDocs.flatMap((d) => (d.collections ?? []).map((c) => c.name)));
    expect([...seen]).toEqual(['Travel']);
    // Jane was given no collection: her documents are in none she may see.
    const janeDocs = (await page(jane, 'sort=collections&limit=200')).items;
    expect(janeDocs.every((d) => d.collections?.length === 0)).toBe(true);
  }, 120_000);

  it('older clients are answered as before; what the table adds goes with a column sort', async () => {
    const before = await page(owner, 'limit=200');
    expect(before.total).toBeUndefined();
    expect(before.items.every((d) => d.collections === undefined)).toBe(true);
    for (const query of [
      'sort=recent&direction=asc',
      'direction=desc',
      'member_id=none',
      `collection_id=${collections.Travel}`,
      'sort=alpha&collection_id=none',
      'sort=expiring&location=Loft',
    ]) {
      const r = await ask(owner, query);
      expect(r.statusCode, query).toBe(422);
    }
    // Their sorts and filters, as they were.
    const alpha = await page(owner, `sort=alpha&member_id=${ahmed.member_id}`);
    // In the database's own order (its collation's), as it always was.
    expect(titles(alpha.items).sort()).toEqual([
      'Charlie will',
      'Hotel tax return',
      'bravo tax return',
    ]);
    expect((await ask(owner, 'sort=recent&limit=200')).statusCode).toBe(200);
    expect((await ask(owner, 'sort=expiring&limit=2')).statusCode).toBe(200);
  });

  it('a page is at most 200', async () => {
    expect((await ask(owner, 'sort=title&limit=201')).statusCode).toBe(422);
    expect((await ask(owner, 'sort=title&limit=200')).statusCode).toBe(200);
  });

  it('a status never asks a viewer for where the original is kept: not in its words, its place in the order, nor a filter on it (5.41)', async () => {
    // The household's kind that requires it; a document of it without one.
    const made = await h.app.inject({
      method: 'POST',
      url: '/api/v1/document-types',
      headers: h.as(owner),
      payload: { label: 'Deeds box', category: 'property' },
    });
    expect(made.statusCode, made.body).toBe(201);
    const kind = json<{ key: string }>(made).key;
    const required = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/document-types/${kind}`,
      headers: h.as(owner),
      payload: { core: { physical_location: { required: true } } },
    });
    expect(required.statusCode, required.body).toBe(200);
    await make('boxed', {
      title: 'Boxed deed',
      type_key: kind,
      owner_member_id: owner.member_id,
      visibility: 'household',
    });
    /** What the vault says of it to each, the document itself asked for. */
    const says = async (who: Tokens) => {
      const r = await h.app.inject({ url: `/api/v1/documents/${ids.boxed}`, headers: h.as(who) });
      expect(r.statusCode, r.body).toBe(200);
      return json<DocumentView>(r).status;
    };
    const ownerSays = await says(owner);
    expect(ownerSays.value).toBe('needs_info');
    expect(ownerSays.label).toMatch(/where the original is/);
    const umaSays = await says(uma);
    expect(umaSays.value).not.toBe('needs_info');
    expect(umaSays.label).not.toMatch(/where the original/);

    const byExpiry = (a: DocumentView, b: DocumentView) => {
      const [x, y] = [a.expires?.date ?? null, b.expires?.date ?? null];
      if (x === y) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return x < y ? -1 : 1;
    };
    for (const [who, said] of [
      [owner, ownerSays],
      [uma, umaSays],
    ] as const) {
      const sorted = await all(who, 'sort=status', 50);
      // Its cell says what the vault says.
      expect(sorted.find((d) => d.id === ids.boxed)?.status).toEqual(said);
      // Its place is the place of the status every row shows: most pressing
      // first, then the sooner expiry, then the id.
      const expected = [...sorted].sort(
        (a, b) =>
          statusRank(a.status.value) - statusRank(b.status.value) ||
          byExpiry(a, b) ||
          (a.id < b.id ? -1 : 1),
      );
      expect(sorted.map((d) => d.id)).toEqual(expected.map((d) => d.id));
      // A filter on a status finds it under the status it shows, and no other.
      for (const sort of ['title', 'status']) {
        const asking = await all(who, `sort=${sort}&status=needs_info`, 50);
        expect(asking.some((d) => d.id === ids.boxed)).toBe(said.value === 'needs_info');
        const shown = await all(who, `sort=${sort}&status=${said.value}`, 50);
        expect(shown.some((d) => d.id === ids.boxed)).toBe(true);
      }
    }
    const gone = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/documents/${ids.boxed}`,
      headers: h.as(owner),
    });
    expect(gone.statusCode).toBe(204);
  }, 120_000);
});
