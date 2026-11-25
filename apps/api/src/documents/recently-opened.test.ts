import { createPool, withScope } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { DocumentView, RecentlyOpened } from '@fdv/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * The documents somebody opened most recently (0.9.0-dev.102), for Home's
 * Recent: each person's own, newest open first, each once; only what they
 * may open now, out of the Trash, never a note; and nobody else's — an
 * owner's included.
 */
describe.skipIf(!testAdminUrl())('recently opened', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  let owner: Tokens;
  let teen: Tokens;

  beforeAll(async () => {
    h = await createHarness();
    admin = createPool(h.adminUrl, 1);
    owner = await h.setup();
    teen = await h.join(owner, { name: 'Tariq', email: 'tariq-recent@example.test', role: 'teen' });
  });
  afterAll(async () => {
    await admin.end();
    await h.close();
  });

  const make = async (title: string, extra: Record<string, unknown> = {}) => {
    const r = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(owner),
      payload: { title, ...extra },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json<DocumentView>().id;
  };
  const open = (t: Tokens, id: string) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/me/recently-opened',
      headers: h.as(t),
      payload: { document_id: id },
    });
  const listed = async (t: Tokens, limit?: number) => {
    const r = await h.app.inject({
      url: `/api/v1/me/recently-opened${limit === undefined ? '' : `?limit=${limit}`}`,
      headers: h.as(t),
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json<RecentlyOpened>().items.map((d) => d.title);
  };
  const send = (t: Tokens, method: 'PATCH' | 'DELETE' | 'POST', url: string, payload?: object) =>
    h.app.inject({ method, url, headers: h.as(t), ...(payload ? { payload } : {}) });

  it('lists the person’s own opens, newest first, each once, as many as asked', async () => {
    expect(await listed(owner)).toEqual([]);
    const a = await make('Opened A');
    const b = await make('Opened B');
    const c = await make('Opened C');
    // Reading a document is not opening it: only the app's word is.
    expect(
      (await h.app.inject({ url: `/api/v1/documents/${a}`, headers: h.as(owner) })).statusCode,
    ).toBe(200);
    expect(await listed(owner)).toEqual([]);
    for (const id of [a, b, c, a]) expect((await open(owner, id)).statusCode).toBe(204);
    expect(await listed(owner)).toEqual(['Opened A', 'Opened C', 'Opened B']);
    expect(await listed(owner, 2)).toEqual(['Opened A', 'Opened C']);
    // As every list gives a document.
    const r = await h.app.inject({
      url: '/api/v1/me/recently-opened?limit=1',
      headers: h.as(owner),
    });
    expect(r.json<RecentlyOpened>().items[0]).toMatchObject({ id: a, title: 'Opened A' });
    // A limit that is not one.
    for (const q of ['limit=0', 'limit=51', 'limit=x']) {
      const bad = await h.app.inject({
        url: `/api/v1/me/recently-opened?${q}`,
        headers: h.as(owner),
      });
      expect(bad.statusCode, q).toBe(422);
    }
  });

  it('is nobody else’s: another person has their own, and is never given the owner’s', async () => {
    expect(await listed(teen)).toEqual([]);
    const d = await make('Opened by the teen');
    expect((await open(teen, d)).statusCode).toBe(204);
    expect(await listed(teen)).toEqual(['Opened by the teen']);
    expect(await listed(owner)).not.toContain('Opened by the teen');
    // Nor, in the database, is an owner given the teen's rows: each their own alone.
    const acct = await admin.query<{ account_id: string }>(
      'select account_id from account_household where member_id = $1',
      [owner.member_id],
    );
    const rows = await withScope(
      h.db,
      {
        householdId: owner.household_id,
        actor: {
          kind: 'account',
          accountId: acct.rows[0]?.account_id as string,
          memberId: owner.member_id,
          role: 'owner',
        },
      },
      (trx) => trx.selectFrom('document_recent_open').select('member_id').execute(),
    );
    expect(new Set(rows.map((x) => x.member_id))).toEqual(new Set([owner.member_id]));
  });

  it('drops a document the person may no longer open, and lists it again when they may', async () => {
    const d = await make('Kept to the adults later');
    expect((await open(teen, d)).statusCode).toBe(204);
    expect((await listed(teen))[0]).toBe('Kept to the adults later');
    expect(
      (await send(owner, 'PATCH', `/api/v1/documents/${d}`, { visibility: 'adults' })).statusCode,
    ).toBe(200);
    expect(await listed(teen)).not.toContain('Kept to the adults later');
    // Nor said again: it is not there for them.
    expect((await open(teen, d)).statusCode).toBe(404);
    expect(
      (await send(owner, 'PATCH', `/api/v1/documents/${d}`, { visibility: 'household' }))
        .statusCode,
    ).toBe(200);
    expect((await listed(teen))[0]).toBe('Kept to the adults later');
    // Somebody else's Only me is not there either.
    const mine = await make('The owner’s own', {
      owner_member_id: owner.member_id,
      visibility: 'private',
    });
    expect((await open(teen, mine)).statusCode).toBe(404);
    expect(await listed(teen)).not.toContain('The owner’s own');
  });

  it('leaves out what is in the Trash, brings it back when restored, and never lists a note', async () => {
    const d = await make('Trashed and back');
    expect((await open(owner, d)).statusCode).toBe(204);
    expect((await listed(owner))[0]).toBe('Trashed and back');
    expect((await send(owner, 'DELETE', `/api/v1/documents/${d}`)).statusCode).toBe(204);
    expect(await listed(owner)).not.toContain('Trashed and back');
    // Opened in the Trash: nothing remembered, nothing said.
    expect((await open(owner, d)).statusCode).toBe(204);
    expect((await send(owner, 'POST', `/api/v1/documents/${d}/restore`)).statusCode).toBe(200);
    expect((await listed(owner))[0]).toBe('Trashed and back');
    const note = await make('A note opened', { type_key: 'note', notes: 'Words' });
    expect((await open(owner, note)).statusCode).toBe(204);
    expect(await listed(owner)).not.toContain('A note opened');
  });

  it('refuses what is not a document, and keeps a person’s newest 50 alone', async () => {
    expect((await open(owner, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    const bad = await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/recently-opened',
      headers: h.as(owner),
      payload: { document_id: 'not-an-id' },
    });
    expect(bad.statusCode).toBe(422);
    expect((await h.app.inject({ url: '/api/v1/me/recently-opened' })).statusCode).toBe(401);
    for (let i = 0; i < 52; i += 1) {
      expect((await open(owner, await make(`Many ${i}`))).statusCode).toBe(204);
    }
    const { rows } = await admin.query<{ n: number }>(
      'select count(*)::int as n from document_recent_open where member_id = $1',
      [owner.member_id],
    );
    expect(rows[0]?.n).toBe(50);
    expect((await listed(owner, 50))[0]).toBe('Many 51');
    expect(await listed(owner, 50)).not.toContain('Many 0');
    // Several at once, as from several tabs: one at a time, still 50, none refused.
    const together = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => make(`Together ${i}`)));
    const answers = await Promise.all(together.map((id) => open(owner, id)));
    expect(answers.map((r) => r.statusCode)).toEqual([204, 204, 204, 204, 204, 204]);
    const after = await admin.query<{ n: number }>(
      'select count(*)::int as n from document_recent_open where member_id = $1',
      [owner.member_id],
    );
    expect(after.rows[0]?.n).toBe(50);
    // Removed for good, its opens go with it.
    const gone = await make('Removed for good');
    await open(owner, gone);
    await admin.query('delete from document where id = $1', [gone]);
    const left = await admin.query<{ n: number }>(
      'select count(*)::int as n from document_recent_open where document_id = $1',
      [gone],
    );
    expect(left.rows[0]?.n).toBe(0);
  });
});
