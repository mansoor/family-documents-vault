import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { DocumentView, TagView } from '@fdv/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * The tags used most recently (0.9.0-dev.103): GET /tags?sort=recent, the
 * tag field's "Recently used". The one put on a document last comes first —
 * of the documents the reader can see, out of the Trash, while they carry
 * it — so a tag on somebody else's Only me document is never listed nor
 * moved up by it, and a tag deleted or taken off is gone.
 */
describe.skipIf(!testAdminUrl())('the tags used most recently', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  let owner: Tokens;
  let sarah: Tokens;

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    admin = createPool(h.adminUrl, 1);
    owner = await h.setup();
    sarah = await h.join(owner, {
      name: 'Sarah',
      email: 'sarah-recent@example.test',
      role: 'adult',
    });
  });
  afterAll(async () => {
    await admin.end();
    await h.close();
  });

  const send = (who: Tokens, method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    h.app.inject({ method, url, headers: h.as(who), ...(payload ? { payload } : {}) });
  const made = async (who: Tokens, title: string, tags: string[], extra: object = {}) => {
    const r = await send(who, 'POST', '/api/v1/documents', {
      title,
      owner_member_id: who.member_id,
      sensitive: false,
      tags,
      ...extra,
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json<DocumentView>();
  };
  /** The tags on a document set to these, with its ETag, as its page does. */
  const tagged = async (who: Tokens, doc: DocumentView, tags: string[]) => {
    const now = await h.app.inject({ url: `/api/v1/documents/${doc.id}`, headers: h.as(who) });
    const r = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/documents/${doc.id}`,
      headers: { ...h.as(who), 'if-match': now.json<DocumentView>().etag },
      payload: { tags },
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json<DocumentView>();
  };
  const recent = async (who: Tokens, query = 'limit=1000') => {
    const r = await h.app.inject({ url: `/api/v1/tags?sort=recent&${query}`, headers: h.as(who) });
    expect(r.statusCode, r.body).toBe(200);
    return r.json<{ items: TagView[] }>().items.map((t) => t.tag);
  };
  /** Of one test's own tags, by their start. */
  const mine = async (who: Tokens, start: string, query?: string) =>
    (await recent(who, query)).filter((t) => t.startsWith(start));

  it('lists the one put on a document most recently first, as many as asked', async () => {
    const a = await made(owner, 'Recent one', ['r1-first']);
    await made(owner, 'Recent two', ['r1-second']);
    await made(owner, 'Recent three', ['r1-third', 'r1-third-too']);
    // Put on at once: the one on more documents first, then by its words.
    expect(await mine(owner, 'r1-')).toEqual(['r1-third', 'r1-third-too', 'r1-second', 'r1-first']);
    // Put on another document later: first again. A tag left as it was keeps its time.
    await tagged(owner, a, ['r1-first', 'r1-second']);
    expect(await mine(owner, 'r1-')).toEqual(['r1-second', 'r1-third', 'r1-third-too', 'r1-first']);
    await tagged(owner, a, ['r1-first', 'r1-second', 'r1-fourth']);
    expect((await mine(owner, 'r1-'))[0]).toBe('r1-fourth');
    // Five, as a tag field asks for them.
    expect(await recent(owner, 'limit=5')).toEqual([
      'r1-fourth',
      'r1-second',
      'r1-third',
      'r1-third-too',
      'r1-first',
    ]);
    expect(await recent(owner, 'limit=2')).toEqual(['r1-fourth', 'r1-second']);
    // With what is typed, those that start so, in the same order.
    expect(await recent(owner, 'q=r1-th')).toEqual(['r1-third', 'r1-third-too']);
    // Without `sort`, most used first, as always.
    const counted = await h.app.inject({ url: '/api/v1/tags?q=r1-', headers: h.as(owner) });
    expect(counted.json<{ items: TagView[] }>().items[0]).toMatchObject({
      tag: 'r1-second',
      count: 2,
    });
    // Anything else as an order is refused.
    const bad = await h.app.inject({ url: '/api/v1/tags?sort=newest', headers: h.as(owner) });
    expect(bad.statusCode).toBe(422);
  });

  it('never lists a tag only on somebody else’s Only me document, nor moves one up by it', async () => {
    await made(owner, 'Shared word', ['r2-shared']);
    await made(owner, 'Fresh word', ['r2-fresh']);
    // Sarah's own, later: hers alone to see.
    await made(sarah, 'Her diary', ['r2-hers', 'r2-shared'], { visibility: 'private' });
    expect(await mine(owner, 'r2-')).toEqual(['r2-fresh', 'r2-shared']);
    expect(await mine(sarah, 'r2-')).toEqual(['r2-shared', 'r2-hers', 'r2-fresh']);
    // Nor as typed.
    expect(await recent(owner, 'q=r2-h')).toEqual([]);
    // Kept to the adults: a teen is told nothing of it either.
    const teen = await h.join(owner, {
      name: 'Tariq',
      email: 'tariq-recent@example.test',
      role: 'teen',
    });
    await made(owner, 'For the adults', ['r2-adults'], { visibility: 'adults' });
    expect(await mine(teen, 'r2-')).toEqual(['r2-fresh', 'r2-shared']);
    expect((await mine(sarah, 'r2-'))[0]).toBe('r2-adults');
  });

  it('drops a tag deleted, taken off, or only in the Trash; a rename is used now', async () => {
    const a = await made(owner, 'Kept tags', ['r3-gone', 'r3-off', 'r3-kept']);
    const b = await made(owner, 'Binned', ['r3-binned']);
    await made(owner, 'Later', ['r3-later']);
    expect(await mine(owner, 'r3-')).toEqual([
      'r3-later',
      'r3-binned',
      'r3-gone',
      'r3-kept',
      'r3-off',
    ]);
    // Deleted in Settings → Tags.
    expect((await send(owner, 'POST', '/api/v1/tags/delete', { tag: 'r3-gone' })).statusCode).toBe(
      200,
    );
    // Taken off its one document.
    await tagged(owner, a, ['r3-kept']);
    // Its document in the Trash.
    expect((await send(owner, 'DELETE', `/api/v1/documents/${b.id}`)).statusCode).toBe(204);
    expect(await mine(owner, 'r3-')).toEqual(['r3-later', 'r3-kept']);
    // Back from the Trash, back where it was.
    expect((await send(owner, 'POST', `/api/v1/documents/${b.id}/restore`)).statusCode).toBe(200);
    expect(await mine(owner, 'r3-')).toEqual(['r3-later', 'r3-binned', 'r3-kept']);
    // Put on again, it is used now: first.
    await tagged(owner, a, ['r3-kept', 'r3-off']);
    expect((await mine(owner, 'r3-'))[0]).toBe('r3-off');
    // Renamed: under its new name, and used now.
    const renamed = await send(owner, 'POST', '/api/v1/tags/rename', {
      from: 'r3-binned',
      to: 'r3-renamed',
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(await mine(owner, 'r3-')).toEqual(['r3-renamed', 'r3-off', 'r3-later', 'r3-kept']);
    // The database's own rows: one a document and tag it carries, no more.
    // Written by the database alone: the application's role may only read it.
    const app = createPool(h.appUrl, 1);
    try {
      await expect(
        app.query(
          `insert into document_tag_use (household_id, document_id, tag_key)
           values ($1, $2, 'r3-forged')`,
          [owner.household_id, a.id],
        ),
      ).rejects.toThrow(/permission denied/);
      for (const sql of [
        'update document_tag_use set used_at = now()',
        'delete from document_tag_use',
      ]) {
        await expect(app.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    } finally {
      await app.end();
    }
    const rows = await admin.query<{ tag_key: string }>(
      'select tag_key from document_tag_use where document_id = $1 order by tag_key',
      [a.id],
    );
    expect(rows.rows.map((r) => r.tag_key)).toEqual(['r3-kept', 'r3-off']);
  });

  it('counts a tag however it was put on: many documents at once, or a batch’s', async () => {
    const one = await made(owner, 'Bulk one', []);
    const two = await made(owner, 'Bulk two', []);
    await made(owner, 'Before', ['r4-before']);
    // A list's Tags menu: each document its own edit.
    await tagged(owner, one, ['r4-bulk']);
    await tagged(owner, two, ['r4-bulk']);
    expect(await mine(owner, 'r4-')).toEqual(['r4-bulk', 'r4-before']);
    // Written by the vault itself (the worker, a restore's own load aside):
    // the database stamps it all the same.
    await admin.query(`update document set tags = array['r4-system'] where id = $1`, [one.id]);
    expect(await mine(owner, 'r4-')).toEqual(['r4-system', 'r4-bulk', 'r4-before']);
  });
});
