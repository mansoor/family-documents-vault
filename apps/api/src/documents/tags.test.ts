import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type {
  ActivityLine,
  DocumentPage,
  DocumentView,
  SearchHit,
  TagChangeResult,
  TagView,
} from '@fdv/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * Tags you can use (0.9.0, T1): detail tags ("locker: 12"), found by their
 * label, their value or the whole tag; the filter by a label; and a tag
 * renamed, merged or deleted across the documents the caller may change —
 * and never across, or about, one they cannot see.
 */

const json = <T>(r: { json: () => unknown }) => r.json() as T;
type Res = Awaited<ReturnType<Harness['app']['inject']>>;

describe.skipIf(!testAdminUrl())('tags you can use (0.9.0, T1)', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  let owner: Tokens;
  let sarah: Tokens;
  let tariq: Tokens;
  let vera: Tokens;

  const get = (who: Tokens, url: string) => h.app.inject({ url, headers: h.as(who) });
  const send = (
    who: Tokens,
    method: 'POST' | 'PATCH' | 'PUT',
    url: string,
    payload: unknown,
    headers: Record<string, string> = {},
  ) =>
    h.app.inject({ method, url, headers: { ...h.as(who), ...headers }, payload: payload as never });
  const made = async (who: Tokens, payload: Record<string, unknown>) => {
    const r = await send(who, 'POST', '/api/v1/documents', {
      owner_member_id: who.member_id,
      ...payload,
    });
    expect(r.statusCode, r.body).toBe(201);
    return json<DocumentView>(r);
  };
  const read = async (who: Tokens, id: string) => {
    const r = await get(who, `/api/v1/documents/${id}`);
    expect(r.statusCode, r.body).toBe(200);
    return json<DocumentView>(r);
  };
  const tagsOf = async (who: Tokens, query = '') => {
    const r = await get(who, `/api/v1/tags${query ? `?${query}` : '?limit=1000'}`);
    expect(r.statusCode, r.body).toBe(200);
    return json<{ items: TagView[] }>(r).items;
  };
  const titles = async (who: Tokens, query: string) => {
    const r = await get(who, `/api/v1/documents?${query}`);
    expect(r.statusCode, r.body).toBe(200);
    return json<DocumentPage>(r)
      .items.map((d) => d.title)
      .sort();
  };
  const found = async (who: Tokens, q: string) => {
    const r = await get(who, `/api/v1/search?q=${encodeURIComponent(q)}`);
    expect(r.statusCode, r.body).toBe(200);
    return json<{ items: SearchHit[] }>(r)
      .items.map((d) => d.title)
      .sort();
  };
  const rename = (who: Tokens, body: Record<string, unknown>) =>
    send(who, 'POST', '/api/v1/tags/rename', body);
  const remove = (who: Tokens, tag: string) => send(who, 'POST', '/api/v1/tags/delete', { tag });
  const result = (r: Res) => {
    expect(r.statusCode, r.body).toBe(200);
    return json<TagChangeResult>(r);
  };
  const activity = async (who: Tokens) => {
    const r = await get(who, '/api/v1/audit?limit=100');
    expect(r.statusCode, r.body).toBe(200);
    return json<{ items: ActivityLine[] }>(r).items.map((l) => l.text);
  };

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    admin = createPool(h.adminUrl, 2);
    owner = await h.setup();
    sarah = await h.join(owner, { name: 'Sarah', email: 'sarah-t1@example.test', role: 'adult' });
    tariq = await h.join(owner, { name: 'Tariq', email: 'tariq-t1@example.test', role: 'teen' });
    vera = await h.join(owner, { name: 'Vera', email: 'vera-t1@example.test', role: 'viewer' });
  });
  afterAll(async () => {
    await admin.end();
    await h.close();
  });

  it('keeps a detail tag as label: value, its value as written, and one of each whatever the case', async () => {
    const d = await made(owner, {
      title: 'Gym membership',
      tags: ['Locker :  4417', 'policy holder: Ahmed', 'Travel', 'travel', 'LOCKER: 4417', '  '],
    });
    expect(d.tags).toEqual(['locker: 4417', 'policy holder: Ahmed', 'travel']);
  });

  it('refuses a tag too long, and too many, in words', async () => {
    const long = await send(owner, 'POST', '/api/v1/documents', { tags: ['x'.repeat(41)] });
    expect(long.statusCode).toBe(422);
    expect(json<{ error: { message: string } }>(long).error.message).toBe(
      `A tag can be 40 characters at most: “${'x'.repeat(24)}…” is 41.`,
    );
    const many = await send(owner, 'POST', '/api/v1/documents', {
      tags: Array.from({ length: 51 }, (_, i) => `t${i}`),
    });
    expect(many.statusCode).toBe(422);
    expect(json<{ error: { message: string } }>(many).error.message).toBe(
      'A document can carry 50 tags at most: this would be 51.',
    );
    // Spaces tidied first: forty characters and a few spaces are forty.
    await made(owner, { title: 'Spaced', tags: [`  ${'y'.repeat(40)}  `] });
  });

  it('a tag kept before 0.9.0 is as it was; one with ": " in it is a detail tag now', async () => {
    const d = await made(owner, { title: 'Old council tax' });
    // As a vault before 0.9.0 could have left them, written by its owning role.
    await admin.query('update document set tags = $1::text[] where id = $2', [
      ['tax', 'locker: 9', 'locker:9', 'a  b'],
      d.id,
    ]);
    // An edit of something else leaves them exactly so.
    const before = await read(owner, d.id);
    const r = await send(
      owner,
      'PATCH',
      `/api/v1/documents/${d.id}`,
      { title: 'Old council tax bill' },
      { 'if-match': before.etag },
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(json<DocumentView>(r).tags).toEqual(['tax', 'locker: 9', 'locker:9', 'a  b']);
    // Filtered by as ever, and by its label.
    expect(await titles(owner, 'tag=tax')).toContain('Old council tax bill');
    expect(await titles(owner, 'tag_label=locker')).toContain('Old council tax bill');
    // "locker:9" has no space: a plain tag, no label.
    expect((await tagsOf(owner, 'q=locker:9'))[0]).toMatchObject({ tag: 'locker:9', label: null });
    expect((await tagsOf(owner, 'q=locker: 9'))[0]).toMatchObject({
      tag: 'locker: 9',
      label: 'locker',
      value: '9',
    });
  });

  it('finds a detail tag by its label, its value, or the whole tag', async () => {
    await made(owner, { title: 'Pension statement', tags: ['agent: Sam Lee'] });
    for (const q of ['agent', 'Sam Lee', 'lee', 'agent: Sam Lee', 'AGENT: sam lee']) {
      expect(await found(owner, q), q).toContain('Pension statement');
    }
    for (const q of ['locker', '4417', 'locker: 4417', 'policy holder', 'Ahmed']) {
      expect(await found(owner, q), q).toContain('Gym membership');
    }
  });

  it('filters by a tag whatever its case, by a label, and by a label and its value', async () => {
    await made(owner, { title: 'Bank safe box', tags: ['locker: 12'] });
    for (const query of ['tag=agent: sam lee', 'tag=Agent:%20%20Sam%20Lee']) {
      expect(await titles(owner, query), query).toEqual(['Pension statement']);
      expect(await titles(owner, `sort=title&${query}`), query).toEqual(['Pension statement']);
    }
    for (const query of ['tag_label=locker', 'tag_label=Locker', 'sort=title&tag_label=LOCKER']) {
      expect(await titles(owner, query), query).toEqual([
        'Bank safe box',
        'Gym membership',
        'Old council tax bill',
      ]);
    }
    expect(await titles(owner, 'sort=title&tag_label=locker&tag=locker: 12')).toEqual([
      'Bank safe box',
    ]);
    expect(await titles(owner, 'tag_label=nothing')).toEqual([]);
  });

  it('lists tags whatever their case, the most used spelling, with the values of a label', async () => {
    await made(owner, { title: 'Will', tags: ['executor: Sam Lee'] });
    await made(owner, { title: 'Will copy', tags: ['executor: Sam Lee'] });
    await made(owner, { title: 'Will draft', tags: ['Executor: sam lee'] });
    expect(await tagsOf(owner, 'q=executor')).toEqual([
      { tag: 'executor: Sam Lee', count: 3, label: 'executor', value: 'Sam Lee', changeable: 3 },
    ]);
    // After "locker: ", the values used for it.
    expect((await tagsOf(owner, `q=${encodeURIComponent('locker: ')}`)).map((t) => t.tag)).toEqual([
      'locker: 12',
      'locker: 4417',
      'locker: 9',
    ]);
    // A LIKE's own characters are themselves.
    expect(await tagsOf(owner, 'q=%25')).toEqual([]);
    expect(await tagsOf(owner, 'q=_')).toEqual([]);
  });

  it('an edit of the tags is checked against its ETag', async () => {
    const d = await made(owner, { title: 'Insurance', tags: ['house'] });
    const first = await send(
      owner,
      'PATCH',
      `/api/v1/documents/${d.id}`,
      { tags: ['house', 'locker: 3'] },
      { 'if-match': d.etag },
    );
    expect(first.statusCode, first.body).toBe(200);
    const stale = await send(
      sarah,
      'PATCH',
      `/api/v1/documents/${d.id}`,
      { tags: ['house', 'car'] },
      { 'if-match': d.etag },
    );
    expect(stale.statusCode).toBe(409);
    expect(json<{ error: { code: string } }>(stale).error.code).toBe('conflict');
    expect((await read(owner, d.id)).tags).toEqual(['house', 'locker: 3']);
  });

  // ------------------------------------------------- rename, merge, delete

  let mine: DocumentView;
  let sarahsOnlyMe: DocumentView;
  let ownersOnlyMe: DocumentView;
  let adultsOnly: DocumentView;
  let tariqs: DocumentView;
  let family: DocumentView;

  it('renames a tag only where the caller may change it, and counts only what they can see', async () => {
    mine = await made(owner, { title: 'Owner’s gas bill', tags: ['utilities', 'paid'] });
    family = await made(owner, { title: 'Family water bill', tags: ['utilities'] });
    adultsOnly = await made(owner, {
      title: 'Adults’ mortgage',
      visibility: 'adults',
      tags: ['utilities'],
    });
    sarahsOnlyMe = await made(sarah, {
      title: 'Sarah’s private bill',
      visibility: 'private',
      tags: ['utilities', 'sarah secret label: 5512'],
    });
    ownersOnlyMe = await made(owner, {
      title: 'Owner’s private bill',
      visibility: 'private',
      tags: ['utilities'],
    });
    tariqs = await made(tariq, { title: 'Tariq’s phone bill', tags: ['utilities'] });

    // The owner sees five: never Sarah's Only me one.
    expect((await tagsOf(owner, 'q=utilities'))[0]).toMatchObject({ count: 5, changeable: 5 });
    // Tariq sees the family's two and his own, and may change his own alone.
    expect((await tagsOf(tariq, 'q=utilities'))[0]).toMatchObject({ count: 3, changeable: 1 });

    const done = result(await rename(owner, { from: 'Utilities', to: 'household bills' }));
    expect(done).toEqual({ changed: 5, kept: 0, merged: false });
    expect((await read(owner, mine.id)).tags).toEqual(['household bills', 'paid']);
    expect((await read(owner, ownersOnlyMe.id)).tags).toEqual(['household bills']);
    // Sarah's Only me document is untouched: the owner has no more power over it than anybody.
    expect((await read(sarah, sarahsOnlyMe.id)).tags).toEqual([
      'utilities',
      'sarah secret label: 5512',
    ]);
    // Each document changed is its own line, which says what was done and not the tag.
    const rows = await admin.query<{ detail: Record<string, unknown> }>(
      `select detail from audit_event where household_id = $1 and action = 'document.tags_changed'`,
      [owner.household_id],
    );
    expect(rows.rows.map((r) => r.detail)).toEqual(Array(5).fill({ change: 'renamed' }));
    const log = await admin.query<{ n: number }>(
      `select count(*)::int as n from audit_event where detail::text ilike '%household bills%'`,
    );
    expect(log.rows[0]?.n).toBe(0);
    // Tariq reads the lines of what he can see; not the adults' document's.
    const lines = await activity(tariq);
    expect(lines).toContain('Owner renamed a tag on “Family water bill”');
    expect(lines).toContain('Owner renamed a tag on “Tariq’s phone bill”');
    expect(lines.filter((l) => l.includes('Adults’ mortgage'))).toEqual([]);
    expect(lines.filter((l) => l.includes('private bill'))).toEqual([]);
    // An edit made against the document as it was is told it changed.
    const stale = await send(
      owner,
      'PATCH',
      `/api/v1/documents/${mine.id}`,
      { title: 'x' },
      { 'if-match': mine.etag },
    );
    expect(stale.statusCode).toBe(409);
  });

  it('a teen renames on their own documents only, and is told how many they could not change', async () => {
    const done = result(await rename(tariq, { from: 'household bills', to: 'my bills' }));
    // His own; the family's two he can see but not change; nothing of the rest.
    expect(done).toEqual({ changed: 1, kept: 2, merged: false });
    expect((await read(tariq, tariqs.id)).tags).toEqual(['my bills']);
    expect((await read(tariq, family.id)).tags).toEqual(['household bills']);
    expect((await read(owner, adultsOnly.id)).tags).toEqual(['household bills']);
  });

  it('asks before a merge, only into a tag the caller can see, and keeps one of the two', async () => {
    const both = await made(owner, { title: 'Both', tags: ['bills', 'household bills'] });
    const asked = await rename(owner, { from: 'household bills', to: 'Bills' });
    expect(asked.statusCode).toBe(409);
    expect(json<{ error: { code: string; message: string } }>(asked).error).toEqual(
      expect.objectContaining({
        code: 'tag_exists',
        message: '“bills” is a tag already. Renaming “household bills” to it merges the two.',
      }),
    );
    // Nothing changed for asking.
    expect((await read(owner, both.id)).tags).toEqual(['bills', 'household bills']);
    const done = result(await rename(owner, { from: 'household bills', to: 'bills', merge: true }));
    expect(done).toEqual({ changed: 5, kept: 0, merged: true });
    expect((await read(owner, both.id)).tags).toEqual(['bills']);
    expect((await read(owner, family.id)).tags).toEqual(['bills']);
    expect(await activity(owner)).toContain('Owner merged two tags on “Both”');
  });

  it('a tag only on somebody else’s Only me documents is no tag to merge into, and stays theirs', async () => {
    // "sarah secret label: 5512" is on Sarah's Only me document alone.
    const done = result(await rename(owner, { from: 'paid', to: 'Sarah secret label: 5512' }));
    expect(done).toEqual({ changed: 1, kept: 0, merged: false });
    expect((await read(owner, mine.id)).tags).toEqual(['bills', 'sarah secret label: 5512']);
    expect((await read(sarah, sarahsOnlyMe.id)).tags).toEqual([
      'utilities',
      'sarah secret label: 5512',
    ]);
    // Deleting it touches only the owner's, and says nothing of Sarah's.
    expect(result(await remove(owner, 'sarah secret label: 5512'))).toEqual({
      changed: 1,
      kept: 0,
      merged: false,
    });
    expect((await read(sarah, sarahsOnlyMe.id)).tags).toEqual([
      'utilities',
      'sarah secret label: 5512',
    ]);
    // And the other way: Sarah's rename of "bills" leaves the owner's Only me document alone.
    const sarahs = result(await rename(sarah, { from: 'bills', to: 'sarah bills' }));
    expect(sarahs.kept).toBe(0);
    expect((await read(owner, ownersOnlyMe.id)).tags).toEqual(['bills']);
    expect((await read(owner, family.id)).tags).toEqual(['sarah bills']);
  });

  it('a tag the caller cannot see is never counted, touched or named', async () => {
    for (const who of [owner, tariq]) {
      expect(await tagsOf(who, 'q=sarah secret')).toEqual([]);
      expect(await titles(who, 'tag=sarah secret label: 5512')).toEqual([]);
      expect(await titles(who, 'sort=title&tag_label=sarah secret label')).toEqual([]);
      expect(await found(who, '5512')).toEqual([]);
      expect(result(await rename(who, { from: 'sarah secret label: 5512', to: 'x' }))).toEqual({
        changed: 0,
        kept: 0,
        merged: false,
      });
      expect(result(await remove(who, 'utilities'))).toEqual({
        changed: 0,
        kept: 0,
        merged: false,
      });
    }
    expect((await read(sarah, sarahsOnlyMe.id)).tags).toEqual([
      'utilities',
      'sarah secret label: 5512',
    ]);
    // Sarah herself finds hers.
    expect(await found(sarah, '5512')).toEqual(['Sarah’s private bill']);
    expect(await titles(sarah, 'tag_label=Sarah secret label')).toEqual(['Sarah’s private bill']);
  });

  it('deletes a tag everywhere the caller may, and says how many it stays on that they may not change', async () => {
    const done = result(await remove(tariq, 'sarah bills'));
    // Tariq changes none of the family's three he sees it on, and is told so.
    expect(done).toEqual({ changed: 0, kept: 3, merged: false });
    const owners = result(await remove(owner, 'Sarah Bills'));
    expect(owners.changed).toBeGreaterThan(0);
    expect(owners.kept).toBe(0);
    expect((await read(owner, family.id)).tags).toEqual([]);
    expect(await activity(owner)).toContain('Owner took a tag off “Family water bill”');
  });

  it('is for whoever may change documents: never a viewer', async () => {
    for (const r of [await rename(vera, { from: 'bills', to: 'x' }), await remove(vera, 'bills')]) {
      expect(r.statusCode).toBe(403);
    }
    for (const body of [
      { from: '  ', to: 'x' },
      { from: 'bills', to: '   ' },
    ]) {
      expect((await rename(owner, body)).statusCode).toBe(422);
    }
    const long = await rename(owner, { from: 'bills', to: 'z'.repeat(41) });
    expect(long.statusCode).toBe(422);
    expect(json<{ error: { message: string } }>(long).error.message).toMatch(
      /^A tag can be 40 characters at most/,
    );
  });
});
