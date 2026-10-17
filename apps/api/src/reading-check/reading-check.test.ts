import { randomUUID } from 'node:crypto';
import { EnvKeyProvider, readingMissesBinding, ScopeKeys, sealBytes } from '@fdv/crypto';
import { createPool, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  type BatchDetail,
  type BatchItemView,
  type DocumentView,
  type ReadingCheckDetail,
  type ReadingCheckSummary,
  type ReadingCheckView,
  type ReadingChecksList,
  type Tokens,
} from '@fdv/shared';
import FormData from 'form-data';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, TEST_MASTER, type Harness } from '../test-harness.js';

/**
 * The Reading check in the API (0.9.0, R0): an owner's alone, at the route
 * and in the database; one at a time; its numbers every owner's, and its
 * misses the asking owner's alone, for documents they can still see, for
 * seven days. Documents filed through review are found by the database as
 * an item is accepted (review_filing). The worker is not here: what it
 * keeps is planted as it keeps it.
 */

const PDF = () => Buffer.from(`%PDF-1.4\n% scan ${randomUUID()}\n%%EOF\n`);

const counts = {
  documents: 2,
  ready: 1,
  check: 1,
  unrecognised: 0,
  problem: 0,
  not_read: 0,
  needs_typing: 1,
  wrong_ready: 0,
  ready_detail_wrong: 0,
  expiry_not_on_paper: 0,
  kind_typed: 1,
  person_typed: 0,
  expiry_typed: 0,
};
const SUMMARY: ReadingCheckSummary = {
  chosen: 2,
  read: 2,
  skipped: 0,
  edited: 0,
  without_rules: {
    all: counts,
    text: counts,
    scan: { ...counts, documents: 0 },
    by_kind: { passport: { documents: 2, kind_right: 1, no_typing: 1 } },
  },
  with_rules: {
    all: counts,
    text: counts,
    scan: { ...counts, documents: 0 },
    by_kind: { passport: { documents: 2, kind_right: 1, no_typing: 1 } },
  },
};

describe.skipIf(!testAdminUrl())('the Reading check, in the API (R0)', () => {
  let h: Harness;
  let owner: Tokens;
  let second: Tokens;
  let adult: Tokens;
  let teen: Tokens;
  let viewer: Tokens;
  let hh: string;
  let admin: ReturnType<typeof createPool>;
  let appPool: ReturnType<typeof createPool>;
  const acct: Record<string, string> = {};
  const keys = new ScopeKeys(new EnvKeyProvider(TEST_MASTER));
  const docs: Record<string, string> = {};

  const call = (who: Tokens | null, method: string, url: string, payload?: unknown) =>
    h.app.inject({
      method: method as 'GET',
      url,
      headers: who ? h.as(who) : {},
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  /** An item of `who`'s, accepted with these details: a document filed through review. */
  const throughReview = async (who: Tokens, details: Record<string, unknown>) => {
    const b = await call(who, 'POST', '/api/v1/batches', {});
    expect(b.statusCode, b.body).toBe(201);
    const batchId = b.json<BatchDetail>().id;
    const form = new FormData();
    form.append('file', PDF(), { filename: 'scan.pdf', contentType: 'application/pdf' });
    const sent = await h.app.inject({
      method: 'POST',
      url: `/api/v1/batches/${batchId}/items`,
      headers: { ...h.as(who), ...form.getHeaders() },
      payload: form.getBuffer(),
    });
    expect(sent.statusCode, sent.body).toBe(201);
    const item = sent.json<BatchItemView>();
    const done = await call(who, 'POST', `/api/v1/batches/${batchId}/items/${item.id}/accept`, {
      title: 'Filed',
      ...details,
    });
    expect(done.statusCode, done.body).toBe(201);
    return done.json<{ document_id: string }>().document_id;
  };

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    owner = await h.setup();
    hh = owner.household_id;
    second = await h.join(owner, { name: 'Omar', email: 'omar@reading.test', role: 'adult' });
    adult = await h.join(owner, { name: 'Sara', email: 'sara@reading.test', role: 'adult' });
    teen = await h.join(owner, { name: 'Zain', email: 'zain@reading.test', role: 'teen' });
    viewer = await h.join(owner, { name: 'Vic', email: 'vic@reading.test', role: 'viewer' });
    admin = createPool(h.adminUrl, 1);
    appPool = createPool(h.appUrl, 1);
    for (const [k, t] of [
      ['owner', owner],
      ['second', second],
    ] as const) {
      acct[k] = (
        await admin.query<{ account_id: string }>(
          'select account_id from account_household where member_id = $1',
          [t.member_id],
        )
      ).rows[0]?.account_id as string;
    }
    // Omar, a second owner.
    await admin.query("update account_household set role = 'owner' where member_id = $1", [
      second.member_id,
    ]);
    docs.everybody = await throughReview(owner, { visibility: 'household' });
    docs.adults = await throughReview(adult, { visibility: 'adults' });
    // Sara's Only me: never an owner's.
    docs.saras = await throughReview(adult, {
      visibility: 'private',
      owner_member_id: adult.member_id,
    });
    // The owner's own Only me: hers.
    docs.mine = await throughReview(owner, {
      visibility: 'private',
      owner_member_id: owner.member_id,
    });
    // Filed by hand: not through review.
    const byHand = await call(owner, 'POST', '/api/v1/documents', { title: 'By hand' });
    expect(byHand.statusCode, byHand.body).toBe(201);
    docs.byHand = byHand.json<DocumentView>().id;
  }, 180_000);

  afterAll(async () => {
    await admin?.end();
    await appPool?.end();
    await h?.close();
  });

  beforeEach(async () => {
    await admin.query('delete from reading_check where household_id = $1', [hh]);
    h.jobs.length = 0;
  });

  /** As the worker leaves a finished check: its numbers, and its misses sealed for its owner. */
  const finish = async (
    id: string,
    misses: Array<{ document_id: string; fields: string[] }>,
    sealedFor: Tokens = owner,
  ) => {
    await admin.query(
      `update reading_check set state = 'done', started_at = now(), finished_at = now(),
              total = 2, done = 2, server_version = '0.9.0-dev.2', rules_hash = 'abcdef012345',
              summary = $2 where id = $1`,
      [id, JSON.stringify(SUMMARY)],
    );
    const key = await withSystem(h.db, hh, (trx) =>
      keys.unwrap(trx, { householdId: hh, kind: 'member', memberId: sealedFor.member_id }),
    );
    await admin.query(
      `insert into reading_check_sealed (check_id, household_id, member_id, wrapped_by_scope,
                                         misses_sealed, expires_at)
       values ($1, $2, $3, $4, $5, now() + interval '7 days')`,
      [
        id,
        hh,
        sealedFor.member_id,
        key.id,
        sealBytes(
          key.key,
          Buffer.from(
            JSON.stringify({
              v: 1,
              misses: misses.map((m) => ({ ...m, level: 'check', wrong_ready: false })),
            }),
          ),
          readingMissesBinding(id),
        ),
      ],
    );
  };
  const start = async (who: Tokens, body: Record<string, unknown> = {}) => {
    const res = await call(who, 'POST', '/api/v1/reading-checks', body);
    expect(res.statusCode, res.body).toBe(202);
    return res.json<ReadingCheckView>();
  };

  it('is an owner’s alone, at every route', async () => {
    const id = randomUUID();
    for (const who of [adult, teen, viewer]) {
      for (const [method, url] of [
        ['GET', '/api/v1/reading-checks'],
        ['POST', '/api/v1/reading-checks'],
        ['GET', `/api/v1/reading-checks/${id}`],
        ['POST', `/api/v1/reading-checks/${id}/cancel`],
        ['DELETE', `/api/v1/reading-checks/${id}`],
      ] as const) {
        const res = await call(who, method, url, method === 'POST' ? {} : undefined);
        expect(res.statusCode, `${method} ${url}`).toBe(403);
      }
    }
    expect((await call(null, 'GET', '/api/v1/reading-checks')).statusCode).toBe(401);
    // And the capability says it is there.
    const caps = await call(owner, 'GET', '/api/v1/capabilities');
    expect(caps.json<{ features: Record<string, unknown> }>().features.reading_check).toBe(true);
  });

  it('is an owner’s alone in the database too: nobody else signed in is given a check, its misses or a filing', async () => {
    const c = await start(owner);
    await finish(c.id, [{ document_id: docs.everybody as string, fields: ['kind'] }]);
    const seenAs = async (role: string, member: string) => {
      const client = await appPool.connect();
      try {
        await client.query('begin');
        await client.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                  set_config('app.role', $2, true), set_config('app.member_id', $3, true)`,
          [hh, role, member],
        );
        const { rows } = await client.query<{ checks: number; sealed: number; filings: number }>(
          `select (select count(*)::int from reading_check) as checks,
                  (select count(*)::int from reading_check_sealed) as sealed,
                  (select count(*)::int from review_filing) as filings`,
        );
        await client.query('rollback');
        return rows[0];
      } finally {
        client.release();
      }
    };
    for (const role of ['adult', 'teen', 'viewer']) {
      expect(await seenAs(role, adult.member_id)).toEqual({ checks: 0, sealed: 0, filings: 0 });
    }
    // The owner who asked: the check, its misses, and the filings she can see —
    // never Sara's Only me.
    expect(await seenAs('owner', owner.member_id)).toEqual({ checks: 1, sealed: 1, filings: 3 });
    // Another owner: the check, never its misses; their own filings.
    expect(await seenAs('owner', second.member_id)).toEqual({ checks: 1, sealed: 0, filings: 2 });
  });

  it('starts a check, waiting for the worker, at a low priority, one a household', async () => {
    const list = await call(owner, 'GET', '/api/v1/reading-checks');
    expect(list.statusCode).toBe(200);
    // Filed through review, as the database found them as each was accepted:
    // hers to see, never Sara's Only me, never one filed by hand.
    expect(list.json<ReadingChecksList>().filed).toBe(3);
    expect(
      (await call(second, 'GET', '/api/v1/reading-checks')).json<ReadingChecksList>().filed,
    ).toBe(2);
    const c = await start(owner, { n: 25, include_edited: false });
    expect(c).toMatchObject({
      state: 'waiting',
      n: 25,
      include_edited: false,
      mine: true,
      summary: null,
      requested_by: { member_id: owner.member_id },
      progress: { total: 0, done: 0 },
    });
    expect(h.jobs).toContainEqual({
      name: 'reading.check',
      data: { household_id: hh, check_id: c.id },
      options: { singletonKey: `reading-check:${hh}` },
    });
    // One at a time: another owner too.
    const again = await call(second, 'POST', '/api/v1/reading-checks', {});
    expect(again.statusCode).toBe(409);
    expect(again.json<{ error: { code: string } }>().error.code).toBe('reading_check_running');
    // N between 10 and 500, a whole number.
    await admin.query('delete from reading_check where household_id = $1', [hh]);
    for (const n of [9, 501, 10.5, '50']) {
      expect((await call(owner, 'POST', '/api/v1/reading-checks', { n })).statusCode).toBe(422);
    }
    expect((await call(owner, 'POST', '/api/v1/reading-checks', { what: 1 })).statusCode).toBe(422);
    expect((await start(owner)).n).toBe(50);
  });

  it('the numbers are every owner’s; the misses the asking owner’s alone, for documents she can still see', async () => {
    const c = await start(owner);
    await finish(c.id, [
      { document_id: docs.everybody as string, fields: ['kind', 'person'] },
      { document_id: docs.mine as string, fields: ['expiry'] },
      // Planted: Sara's Only me, which the owner cannot see, never shown.
      { document_id: docs.saras as string, fields: ['kind'] },
    ]);
    const mine = await call(owner, 'GET', `/api/v1/reading-checks/${c.id}`);
    expect(mine.statusCode, mine.body).toBe(200);
    const d = mine.json<ReadingCheckDetail>();
    expect(d.summary).toEqual(SUMMARY);
    expect(d.reader).toEqual({ server_version: '0.9.0-dev.2', rules: 'abcdef012345' });
    expect(d.misses?.map((m) => [m.document_id, m.fields])).toEqual([
      [docs.everybody, ['kind', 'person']],
      [docs.mine, ['expiry']],
    ]);
    expect(d.misses?.[0]?.title).toBe('Filed');
    expect(d.misses_until).not.toBeNull();
    expect(mine.body).not.toContain(docs.saras as string);
    // Another owner: the numbers, never the misses.
    const theirs = await call(second, 'GET', `/api/v1/reading-checks/${c.id}`);
    expect(theirs.statusCode).toBe(200);
    expect(theirs.json<ReadingCheckDetail>()).toMatchObject({
      mine: false,
      summary: SUMMARY,
      misses: null,
      misses_until: null,
    });
    expect(theirs.body).not.toContain(docs.everybody as string);
    // A document she can no longer see — moved to the Trash — goes from her list.
    await admin.query('update document set deleted_at = now() where id = $1', [docs.everybody]);
    try {
      const later = (
        await call(owner, 'GET', `/api/v1/reading-checks/${c.id}`)
      ).json<ReadingCheckDetail>();
      expect(later.misses?.map((m) => m.document_id)).toEqual([docs.mine]);
    } finally {
      await admin.query('update document set deleted_at = null where id = $1', [docs.everybody]);
    }
    // Past their seven days: gone, though the sweep has not been.
    await admin.query(
      "update reading_check_sealed set expires_at = now() - interval '1 second' where check_id = $1",
      [c.id],
    );
    expect(
      (await call(owner, 'GET', `/api/v1/reading-checks/${c.id}`)).json<ReadingCheckDetail>(),
    ).toMatchObject({ misses: null, summary: SUMMARY });
  });

  it('misses sealed for another owner are never opened for this one', async () => {
    const c = await start(owner);
    // Sealed under Omar's key, as if he had asked: the owner who did is given none.
    await finish(c.id, [{ document_id: docs.everybody as string, fields: ['kind'] }], second);
    const d = (
      await call(owner, 'GET', `/api/v1/reading-checks/${c.id}`)
    ).json<ReadingCheckDetail>();
    expect(d.misses).toBeNull();
  });

  it('lists the household’s checks with the newest first, to compare one with another', async () => {
    const a = await start(owner);
    await finish(a.id, []);
    const b = await start(second);
    const list = (await call(owner, 'GET', '/api/v1/reading-checks')).json<ReadingChecksList>();
    expect(list.items.map((i) => i.id)).toEqual([b.id, a.id]);
    expect(list.items[0]).toMatchObject({ state: 'waiting', mine: false });
    expect(list.items[1]).toMatchObject({ state: 'done', mine: true, summary: SUMMARY });
    // Numbers only, whatever is asked.
    expect(JSON.stringify(list)).not.toContain(docs.everybody as string);
  });

  it('cancels a check waiting or running; one finished is not cancelled', async () => {
    const c = await start(owner);
    // Any owner may cancel the household's check.
    const res = await call(second, 'POST', `/api/v1/reading-checks/${c.id}/cancel`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<ReadingCheckView>()).toMatchObject({ state: 'cancelled' });
    expect(res.json<ReadingCheckView>().finished_at).not.toBeNull();
    const twice = await call(owner, 'POST', `/api/v1/reading-checks/${c.id}/cancel`);
    expect(twice.statusCode).toBe(409);
    // Another may start once it is cancelled.
    const d = await start(owner);
    await finish(d.id, []);
    expect((await call(owner, 'POST', `/api/v1/reading-checks/${d.id}/cancel`)).statusCode).toBe(
      409,
    );
    expect(
      (await call(owner, 'POST', `/api/v1/reading-checks/${randomUUID()}/cancel`)).statusCode,
    ).toBe(404);
  });

  it('an owner writes only what is theirs: never the worker’s numbers, never another’s name', async () => {
    const c = await start(owner);
    const asOwner = async (q: string, params: unknown[]) => {
      const client = await appPool.connect();
      try {
        await client.query('begin');
        await client.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                  set_config('app.role', 'owner', true), set_config('app.member_id', $2, true),
                  set_config('app.account_id', $3, true)`,
          [hh, owner.member_id, acct.owner],
        );
        await client.query(q, params);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw err;
      } finally {
        client.release();
      }
    };
    await expect(
      asOwner('update reading_check set summary = $2 where id = $1', [
        c.id,
        JSON.stringify(SUMMARY),
      ]),
    ).rejects.toThrow(/only cancel/);
    await expect(
      asOwner("update reading_check set state = 'done' where id = $1", [c.id]),
    ).rejects.toThrow(/only cancel/);
    await admin.query('delete from reading_check where household_id = $1', [hh]);
    // A check made in somebody else's name, or done already: refused.
    await expect(
      asOwner(
        'insert into reading_check (household_id, requested_by, member_id, n) values ($1, $2, $3, 50)',
        [hh, acct.second, second.member_id],
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asOwner(
        `insert into reading_check (household_id, requested_by, member_id, n, total)
         values ($1, $2, $3, 50, 3)`,
        [hh, acct.owner, owner.member_id],
      ),
    ).rejects.toThrow(/row-level security/);
    // Nor the misses, which are the vault's to write.
    const d = await start(owner);
    const key = await withSystem(h.db, hh, (trx) =>
      keys.unwrap(trx, { householdId: hh, kind: 'member', memberId: owner.member_id }),
    );
    await expect(
      asOwner(
        `insert into reading_check_sealed (check_id, household_id, member_id, wrapped_by_scope,
                                           misses_sealed, expires_at)
         values ($1, $2, $3, $4, '\\x00', now() + interval '30 days')`,
        [d.id, hh, owner.member_id, key.id],
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('removes a check, its misses with it', async () => {
    const c = await start(owner);
    await finish(c.id, [{ document_id: docs.everybody as string, fields: ['kind'] }]);
    const gone = await call(owner, 'DELETE', `/api/v1/reading-checks/${c.id}`);
    expect(gone.statusCode).toBe(204);
    expect((await call(owner, 'GET', `/api/v1/reading-checks/${c.id}`)).statusCode).toBe(404);
    const { rows } = await admin.query('select 1 from reading_check_sealed where check_id = $1', [
      c.id,
    ]);
    expect(rows).toEqual([]);
    expect((await call(owner, 'DELETE', `/api/v1/reading-checks/${c.id}`)).statusCode).toBe(404);
    expect((await call(owner, 'GET', '/api/v1/reading-checks/not-a-uuid')).statusCode).toBe(404);
  });

  it('a filing goes with its document, and an Undo of Accept all Ready takes it back', async () => {
    const before = (await call(owner, 'GET', '/api/v1/reading-checks')).json<ReadingChecksList>()
      .filed;
    const id = await throughReview(owner, { visibility: 'household' });
    expect(
      (await call(owner, 'GET', '/api/v1/reading-checks')).json<ReadingChecksList>().filed,
    ).toBe(before + 1);
    // Who filed it, and when: the vault's.
    const { rows } = await admin.query<{ filed_by: string }>(
      'select filed_by from review_filing where document_id = $1',
      [id],
    );
    expect(rows).toEqual([{ filed_by: acct.owner }]);
    await admin.query('delete from document where id = $1', [id]);
    expect(
      (await call(owner, 'GET', '/api/v1/reading-checks')).json<ReadingChecksList>().filed,
    ).toBe(before);
  });
});
