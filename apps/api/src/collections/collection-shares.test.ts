import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { EncryptStream, EnvKeyProvider, ScopeKeys, unwrapKey } from '@fdv/crypto';
import { computeHash, createPool, verifyAuditChain, withScope, withSystem, type Db } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  COLLECTION_SHARE_REASONS,
  FOLLOW_MAX_DAYS,
  type ActivityLine,
  type CollectionDetail,
  type CollectionSharePreview,
  type CollectionView,
  type DocumentView,
  type ShareLinkPreview,
  type SharedSession,
} from '@fdv/shared';
import { LocalAdapter } from '@fdv/storage';
import type { LightMyRequestResponse } from 'fastify';
import FormData from 'form-data';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Tokens } from '../auth/service.js';
import {
  PAGES_RETRY_MS,
  ShareService,
  type CreatedShare,
  type ShareView,
} from '../documents/shares.js';
import { createHarness, TEST_MASTER, type Harness } from '../test-harness.js';

const testKeys = new ScopeKeys(new EnvKeyProvider(TEST_MASTER));

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

type Who = 'owner' | 'adult' | 'teen' | 'viewer';

/**
 * Sharing a collection outside the family (5.19).
 *
 * What goes out is exactly what its sharer ticked, checked again on every
 * request: a document made private since, taken out of the collection or
 * put in the Trash is simply not given, and nothing says it was there. What
 * a sharer cannot see never goes, whoever made the collection; a teen never
 * shares one; every share asks to confirm it's you; a link that keeps up
 * with its collection sends only what the whole audience may see, and
 * lasts 30 days at most.
 */
describe.skipIf(!testAdminUrl())('sharing a collection (5.19)', () => {
  let h: Harness;
  const t = {} as Record<Who, Tokens>;
  const accounts = {} as Record<Who, string>;

  const json = <T>(r: { json: () => unknown }) => r.json() as T;
  const code = (r: LightMyRequestResponse) => json<{ error: { code: string } }>(r).error.code;
  let nth = 0;
  const peer = () => ({ remoteAddress: `10.9.${Math.floor(++nth / 200)}.${nth % 200}` });

  const call = (
    who: Who,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
  ) => h.app.inject({ method, url, headers: h.as(t[who]), ...(payload ? { payload } : {}) });

  /** A document with a file, made (and owned) by `who`. */
  const make = async (
    who: Who,
    title: string,
    visibility: 'household' | 'adults' | 'private' = 'household',
    file = true,
  ) => {
    const created = await call(who, 'POST', '/api/v1/documents', {
      title,
      type_key: 'utility_bill',
      visibility,
      owner_member_id: t[who].member_id,
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = json<DocumentView>(created).id;
    if (file) {
      const form = new FormData();
      form.append('file', PDF, { filename: `${title}.pdf`, contentType: 'application/pdf' });
      const up = await h.app.inject({
        method: 'POST',
        url: `/api/v1/documents/${id}/versions`,
        headers: { ...h.as(t[who]), ...form.getHeaders(), 'idempotency-key': randomUUID() },
        payload: form.getBuffer(),
      });
      expect(up.statusCode, up.body).toBeLessThan(300);
    }
    return id;
  };

  const collection = async (
    who: Who,
    name: string,
    audience: 'everyone' | 'teens' | 'adults' | 'only_me',
    documents: string[],
  ) => {
    const made = await call(who, 'POST', '/api/v1/collections', { name, audience });
    expect(made.statusCode, made.body).toBe(201);
    const id = json<CollectionDetail>(made).id;
    if (documents.length) await put(who, id, documents);
    return id;
  };
  const put = async (who: Who, collectionId: string, documents: string[]) => {
    const r = await call(who, 'POST', `/api/v1/collections/${collectionId}/items`, {
      document_ids: documents,
    });
    expect(r.statusCode, r.body).toBe(200);
    return json<CollectionDetail>(r);
  };

  const sharePreview = (who: Who, collectionId: string) =>
    call(who, 'GET', `/api/v1/collections/${collectionId}/share-preview`);
  const share = (who: Who, collectionId: string, body: Record<string, unknown>) =>
    call(who, 'POST', `/api/v1/collections/${collectionId}/shares`, body);
  const shared = async (who: Who, collectionId: string, body: Record<string, unknown>) => {
    const r = await share(who, collectionId, body);
    expect(r.statusCode, r.body).toBe(201);
    return json<CreatedShare>(r);
  };

  /** Whether `who` confirmed it's them in the last five minutes. */
  const fresh = (who: Who, yes: boolean) =>
    withSystem(h.db, t.owner.household_id, (trx) =>
      trx
        .updateTable('session')
        .set({ verified_at: new Date(Date.now() - (yes ? 0 : 10 * 60_000)) })
        .where('account_id', '=', accounts[who])
        .execute(),
    );

  // ------------------------------------------------ the recipient's calls

  const preview = (token: string) =>
    h.app.inject({ method: 'POST', url: '/api/v1/shared/preview', payload: { token }, ...peer() });
  const opened = async (token: string, secret?: string) => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/shared/unlock',
      payload: secret === undefined ? { token } : { token, secret },
      ...peer(),
    });
    expect(res.statusCode, res.body).toBe(200);
    const cookie = res.cookies.find((c) => c.name === 'fdv_share')?.value as string;
    return { session: json<SharedSession>(res), cookie };
  };
  const items = (cookie: string) =>
    h.app.inject({ url: '/api/v1/shared/items', cookies: { fdv_share: cookie }, ...peer() });
  const content = (cookie: string, documentId: string) =>
    h.app.inject({
      url: `/api/v1/shared/items/${documentId}/content`,
      cookies: { fdv_share: cookie },
      ...peer(),
    });
  const page = (cookie: string, documentId: string, n: number) =>
    h.app.inject({
      url: `/api/v1/shared/items/${documentId}/pages/${n}`,
      cookies: { fdv_share: cookie },
      ...peer(),
    });
  const given = async (cookie: string) => {
    const r = await items(cookie);
    expect(r.statusCode, r.body).toBe(200);
    return json<SharedSession>(r).items.map((i) => i.id);
  };
  const withScopeOfLink = <T>(shareId: string, fn: (trx: Db) => Promise<T>) =>
    withScope(h.db, { householdId: t.owner.household_id, actor: { kind: 'link', shareId } }, fn);
  const bySnapshot = (a: { document_id: string }, b: { document_id: string }) =>
    a.document_id < b.document_id ? -1 : 1;
  /** A link's snapshot as the database holds it: each document, and why, by id. */
  const snapshotOf = async (shareId: string) =>
    (
      await withSystem(h.db, t.owner.household_id, (trx) =>
        trx
          .selectFrom('share_link_item')
          .select(['document_id', 'kind'])
          .where('share_id', '=', shareId)
          .execute(),
      )
    ).sort(bySnapshot);
  /** Waits until `n` statements in the test's database wait on a lock. */
  const lockWaiters = async (admin: ReturnType<typeof createPool>, n: number) => {
    const dbName = new URL(h.adminUrl).pathname.slice(1);
    for (let i = 0; i < 200; i += 1) {
      const r = await admin.query<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity
          where datname = $1 and wait_event_type = 'Lock'`,
        [dbName],
      );
      if ((r.rows[0]?.n ?? 0) >= n) return;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error(`fewer than ${n} statements waiting on a lock`);
  };
  const linksFor = async (who: Who) =>
    json<{ items: ShareView[] }>(await call(who, 'GET', '/api/v1/shares')).items;
  const activity = async (who: Who) =>
    json<{ items: ActivityLine[] }>(await call(who, 'GET', '/api/v1/audit?limit=100')).items.map(
      (l) => l.text,
    );

  /** Everybody's documents, by what they are. */
  const docs = {
    lease: '',
    will: '',
    diary: '',
    noFile: '',
    teenPoster: '',
    teenNotes: '',
    insurance: '',
  };
  /** The owner's collection for everybody, and the teen's. */
  let family: string;
  let teens: string;

  beforeAll(async () => {
    // The family's calls all come from one address, and this file makes more
    // than 300 of them a minute on a fast runner (CI, PR #72).
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    t.owner = await h.setup();
    t.adult = await h.join(t.owner, { name: 'Alex', email: 'alex@example.test', role: 'adult' });
    t.teen = await h.join(t.owner, { name: 'Tia', email: 'tia@example.test', role: 'teen' });
    t.viewer = await h.join(t.owner, { name: 'Vic', email: 'vic@example.test', role: 'viewer' });
    for (const who of ['owner', 'adult', 'teen', 'viewer'] as const) {
      accounts[who] = json<{ account_id: string }>(
        await h.app.inject({ url: '/api/v1/me', headers: h.as(t[who]) }),
      ).account_id;
    }
    docs.lease = await make('owner', 'Flat 3 lease');
    docs.will = await make('owner', 'Last will', 'adults');
    docs.diary = await make('owner', 'Owner diary', 'private');
    docs.noFile = await make('owner', 'Paper only', 'household', false);
    docs.insurance = await make('owner', 'Home insurance');
    docs.teenPoster = await make('teen', 'School trip form');
    docs.teenNotes = await make('teen', 'Tia private notes', 'private');
    family = await collection('owner', 'For the mortgage broker', 'everyone', [
      docs.lease,
      docs.will,
      docs.diary,
      docs.noFile,
      docs.insurance,
    ]);
    teens = await collection('teen', 'School trip', 'everyone', [docs.teenPoster, docs.teenNotes]);
  }, 180_000);
  afterAll(() => h.close());

  it('the share sheet ticks what everybody the collection is for may see, and says why not of the rest', async () => {
    const offered = json<CollectionSharePreview>(await sharePreview('owner', family));
    expect(offered).toMatchObject({
      collection_id: family,
      collection_name: 'For the mortgage broker',
      audience: 'everyone',
    });
    const byId = new Map(offered.items.map((i) => [i.document_id, i]));
    expect(byId.get(docs.lease)).toMatchObject({ ticked: true, lock: null, reason: null });
    expect(byId.get(docs.will)).toMatchObject({
      ticked: false,
      lock: 'adults',
      reason: 'Adults only — include anyway?',
    });
    expect(byId.get(docs.diary)).toMatchObject({
      ticked: false,
      lock: 'private',
      reason: 'Only you can see this. It is private.',
    });
    expect(byId.get(docs.noFile)).toMatchObject({
      ticked: false,
      lock: 'no_file',
      reason: COLLECTION_SHARE_REASONS.no_file,
    });
    // In the collection's order.
    expect(offered.items.map((i) => i.document_id)).toEqual([
      docs.lease,
      docs.will,
      docs.diary,
      docs.noFile,
      docs.insurance,
    ]);

    // An adult is offered what they can see, and nothing says there is more.
    const theirs = json<CollectionSharePreview>(await sharePreview('adult', family));
    expect(theirs.items.map((i) => i.document_id)).toEqual([
      docs.lease,
      docs.will,
      docs.noFile,
      docs.insurance,
    ]);
    expect(Object.keys(theirs).sort()).toEqual(
      ['audience', 'collection_id', 'collection_name', 'items'].sort(),
    );
  });

  it('a teen cannot share a collection', async () => {
    for (const who of ['teen', 'viewer'] as const) {
      for (const res of [
        await sharePreview(who, teens),
        await share(who, teens, { document_ids: [docs.teenPoster] }),
      ]) {
        expect(res.statusCode, who).toBe(403);
        expect(json<{ error: { message: string } }>(res).error.message).toBe(
          'Only an adult can share a document outside the family.',
        );
      }
    }
    // Nothing was made.
    const made = await withSystem(h.db, t.owner.household_id, (trx) =>
      trx.selectFrom('share_link').select('id').where('collection_id', '=', teens).execute(),
    );
    expect(made).toEqual([]);
  });

  it('a collection share without step-up is refused', async () => {
    await fresh('owner', false);
    try {
      const refused = await share('owner', family, { document_ids: [docs.lease] });
      expect(refused.statusCode).toBe(403);
      expect(json<{ error: { code: string; action: string } }>(refused).error).toMatchObject({
        code: 'step_up_required',
        action: 'share_collection',
      });
      // Even with nothing in it that is Essential or private: every one asks.
      const plain = await share('owner', family, { document_ids: [docs.insurance] });
      expect(code(plain)).toBe('step_up_required');
      // A collection that is not there for the caller is not asked about.
      expect((await share('owner', randomUUID(), { document_ids: [docs.lease] })).statusCode).toBe(
        404,
      );
      const none = await withSystem(h.db, t.owner.household_id, (trx) =>
        trx.selectFrom('share_link').select('id').where('collection_id', '=', family).execute(),
      );
      expect(none).toEqual([]);
    } finally {
      await fresh('owner', true);
    }
    expect((await share('owner', family, { document_ids: [docs.lease] })).statusCode).toBe(201);
  });

  it("a teen's private document never leaves in a collection share", async () => {
    // The owner is offered the teen's collection without the teen's own
    // private notes, which nothing says are there.
    const offered = json<CollectionSharePreview>(await sharePreview('owner', teens));
    expect(offered.items.map((i) => i.document_id)).toEqual([docs.teenPoster]);
    // Asked for by id, it is a document that is not in the collection.
    const asked = await share('owner', teens, { document_ids: [docs.teenPoster, docs.teenNotes] });
    const nowhere = await share('owner', teens, { document_ids: [docs.teenPoster, randomUUID()] });
    expect(asked.statusCode).toBe(404);
    expect(json<{ error: { message: string } }>(asked).error.message).toBe(
      json<{ error: { message: string } }>(nowhere).error.message,
    );
    // Shared, following, the teen's own private things never go — not
    // what is there now, and not what they put in later.
    const link = await shared('owner', teens, {
      document_ids: [docs.teenPoster],
      follow_collection: true,
      recipient_label: 'the school',
    });
    const later = await make('teen', 'Tia diary', 'private');
    await put('teen', teens, [later]);
    const { cookie } = await opened(link.link_token);
    expect(await given(cookie)).toEqual([docs.teenPoster]);
    for (const doc of [docs.teenNotes, later]) {
      expect((await content(cookie, doc)).statusCode).toBe(404);
      const row = await withScopeOfLink(link.share.id, (trx) =>
        trx.selectFrom('document').select('id').where('id', '=', doc).executeTakeFirst(),
      );
      expect(row).toBeUndefined();
    }
  });

  it('an item made private after sharing disappears for the recipient at the next request', async () => {
    const insurance = await make('owner', 'Car insurance');
    const cars = await collection('owner', 'The car', 'everyone', [docs.lease, insurance]);
    const link = await shared('adult', cars, { document_ids: [docs.lease, insurance] });
    const { cookie } = await opened(link.link_token);
    expect(await given(cookie)).toEqual([docs.lease, insurance]);
    expect((await content(cookie, insurance)).statusCode).toBe(200);

    // Its owner makes it theirs alone: the adult who shared it no longer
    // sees it, and neither does the link.
    const hidden = await call('owner', 'POST', `/api/v1/documents/${insurance}/visibility`, {
      visibility: 'private',
    });
    expect(hidden.statusCode, hidden.body).toBe(200);
    expect(await given(cookie)).toEqual([docs.lease]);
    expect((await content(cookie, insurance)).statusCode).toBe(404);
    // Nothing says it was there: the answer is the same as for no document.
    const body = (r: LightMyRequestResponse) => ({
      ...json<{ error: Record<string, unknown> }>(r).error,
      request_id: null,
    });
    expect(body(await content(cookie, insurance))).toEqual(
      body(await content(cookie, randomUUID())),
    );

    // Taken out of the collection, and in the Trash: gone too.
    await call('owner', 'DELETE', `/api/v1/collections/${cars}/items/${docs.lease}`);
    expect(await given(cookie)).toEqual([]);
    // And shared again, a document in the Trash is not given either.
    const again = await shared('owner', family, { document_ids: [docs.insurance] });
    const second = await opened(again.link_token);
    expect(await given(second.cookie)).toEqual([docs.insurance]);
    expect((await call('owner', 'DELETE', `/api/v1/documents/${docs.insurance}`)).statusCode).toBe(
      204,
    );
    expect(await given(second.cookie)).toEqual([]);
    expect(
      (await call('owner', 'POST', `/api/v1/documents/${docs.insurance}/restore`)).statusCode,
    ).toBe(200);
    expect(await given(second.cookie)).toEqual([docs.insurance]);
  });

  it('the recipient never learns how many items were left out', async () => {
    const link = await shared('owner', family, {
      document_ids: [docs.lease],
      recipient_label: 'the broker',
    });
    const shown = json<ShareLinkPreview>(await preview(link.link_token));
    expect(shown).toMatchObject({
      kind: 'collection',
      collection_name: 'For the mortgage broker',
      document_title: null,
      shared_by: 'Owner',
    });
    // Nothing in what it is given counts anything. (5.20's say what Open
    // asks for: a code's inbox, masked, and whether it is for one device.)
    expect(Object.keys(shown).sort()).toEqual(
      [
        'code_to',
        'collection_name',
        'document_title',
        'expires_at',
        'household_name',
        'kind',
        'opens_left',
        'other_device',
        'permission',
        'protection',
        'shared_by',
        'this_device_only',
      ].sort(),
    );
    const { session } = await opened(link.link_token);
    expect(session.items.map((i) => i.id)).toEqual([docs.lease]);
    expect(Object.keys(session).sort()).toEqual(
      [
        'collection_name',
        'downloads_left',
        'expires_at',
        'household_name',
        'items',
        'kind',
        'permission',
        'session_expires_at',
        'shared_by',
      ].sort(),
    );
    const serialised = JSON.stringify(session) + JSON.stringify(shown);
    for (const left of [docs.will, docs.diary, docs.noFile, docs.insurance]) {
      expect(serialised).not.toContain(left);
    }
    expect(serialised).not.toMatch(/Last will|Owner diary|Paper only|Home insurance/);

    // With a PIN, the collection's name waits too.
    const locked = await shared('owner', family, { document_ids: [docs.lease], with_pin: true });
    expect(json<ShareLinkPreview>(await preview(locked.link_token)).collection_name).toBeNull();
  });

  it('a link session asking for a document outside its snapshot by id gets 404', async () => {
    const link = await shared('owner', family, { document_ids: [docs.lease, docs.will] });
    const { cookie } = await opened(link.link_token);
    for (const doc of [docs.insurance, docs.diary, docs.teenPoster, randomUUID()]) {
      expect((await content(cookie, doc)).statusCode, doc).toBe(404);
      expect((await page(cookie, doc, 1)).statusCode, doc).toBe(404);
    }
    // And the policy returns no row: not the document, its file, its place
    // in the collection or a line of the snapshot it was never in.
    const seen = await withScopeOfLink(link.share.id, async (trx) => ({
      documents: (await trx.selectFrom('document').select('id').execute()).map((r) => r.id).sort(),
      versions: (await trx.selectFrom('document_version').select('document_id').execute())
        .map((r) => r.document_id)
        .sort(),
      inCollection: (await trx.selectFrom('doc_collection_item').select('document_id').execute())
        .map((r) => r.document_id)
        .sort(),
      ticked: (await trx.selectFrom('share_link_item').select('document_id').execute())
        .map((r) => r.document_id)
        .sort(),
      unticked: await trx
        .selectFrom('document')
        .select('id')
        .where('id', '=', docs.insurance)
        .executeTakeFirst(),
    }));
    const both = [docs.lease, docs.will].sort();
    expect(seen).toEqual({
      documents: both,
      versions: both,
      inCollection: both,
      ticked: both,
      unticked: undefined,
    });
  });

  it('following adds only what fits the audience and is not private', async () => {
    const trip = await collection('owner', 'The trip', 'everyone', [docs.lease]);
    const before = await make('owner', 'Passport scan');
    await put('owner', trip, [before]);
    const link = await shared('owner', trip, {
      document_ids: [docs.lease],
      follow_collection: true,
      recipient_label: 'the travel agent',
    });
    expect(link.share).toMatchObject({ follow_collection: true, collection_id: trip });
    expect(link.share.summary).toMatch(/Keeps up with the collection/);
    const { cookie } = await opened(link.link_token);

    const everybody = await make('owner', 'Hotel booking');
    const adultsOnly = await make('owner', 'Bank statement', 'adults');
    const mine = await make('owner', 'Owner medical', 'private');
    const noFile = await make('owner', 'To be scanned', 'household', false);
    await put('owner', trip, [everybody, adultsOnly, mine, noFile]);
    // What was there and left unticked stays left out; of what came later,
    // only what everybody may see — and has a file to send.
    expect(await given(cookie)).toEqual([docs.lease, everybody]);
    expect((await content(cookie, everybody)).statusCode).toBe(200);
    for (const doc of [before, adultsOnly, mine, noFile]) {
      expect((await content(cookie, doc)).statusCode, doc).toBe(404);
    }
    // For the adults, adults-only documents go too; a private one never does.
    const papers = await collection('owner', 'Papers for the adults', 'adults', [docs.lease]);
    const adults = await shared('owner', papers, {
      document_ids: [docs.lease],
      follow_collection: true,
    });
    await put('owner', papers, [adultsOnly, mine]);
    const theirs = await opened(adults.link_token);
    expect(await given(theirs.cookie)).toEqual([docs.lease, adultsOnly]);

    // What went out is a line of its own, for whoever may see it; what did
    // not, is not.
    const log = await activity('owner');
    expect(log).toContain(
      'Owner put “Hotel booking” in the collection “The trip”, and a link that keeps up with it sent it outside the family',
    );
    expect(log.join('\n')).not.toMatch(
      /put “(Bank statement|Owner medical)” in the collection “The trip”/,
    );
    expect(log).toContain(
      'Owner made a link to the collection “The trip” for the travel agent, which keeps up with it',
    );
    // And the collection says it is shared, and with whom.
    const view = json<CollectionDetail>(await call('owner', 'GET', `/api/v1/collections/${trip}`));
    expect(view.shared_outside).toEqual({ with: ['the travel agent'], following: true });
  });

  it('a link that keeps up gives no document whose file a restore found removed for good, until the file is back (the 5.24 check, N524S-01)', async () => {
    await fresh('owner', true);
    const trip = await collection('owner', 'Restored trip', 'everyone', [docs.lease]);
    const link = await shared('owner', trip, {
      document_ids: [docs.lease],
      follow_collection: true,
    });
    const { cookie } = await opened(link.link_token);
    // What a restore marks (removed-files.ts), and what recheck-files clears.
    const marked = (documentId: string, removed: boolean) =>
      withSystem(h.db, t.owner.household_id, (trx) =>
        trx
          .updateTable('document_version')
          .set({ file_removed_at: removed ? new Date() : null })
          .where('document_id', '=', documentId)
          .execute(),
      );
    const gone = await make('owner', 'Restored without its file');
    await marked(gone, true);
    await put('owner', trip, [gone]);
    // Not given: neither listed nor opened, by the API or by the database.
    expect(await given(cookie)).toEqual([docs.lease]);
    expect((await content(cookie, gone)).statusCode).toBe(404);
    const seen = () =>
      withScopeOfLink(link.share.id, async (trx) =>
        (await trx.selectFrom('document').select('id').execute()).map((r) => r.id).sort(),
      );
    expect(await seen()).toEqual([docs.lease]);
    // Its file found back: given again.
    await marked(gone, false);
    expect(await given(cookie)).toEqual([docs.lease, gone]);
    expect(await seen()).toEqual([docs.lease, gone].sort());
    expect((await content(cookie, gone)).statusCode).toBe(200);
  });

  it('a following link ends at 30 days', async () => {
    const days = (n: number) => new Date(Date.now() + n * 864e5).toISOString();
    const tooLong = await share('owner', family, {
      document_ids: [docs.lease],
      follow_collection: true,
      expires_at: days(FOLLOW_MAX_DAYS + 1),
    });
    expect(tooLong.statusCode).toBe(422);
    expect(code(tooLong)).toBe('expiry_out_of_range');
    expect(tooLong.body).toMatch(/keeps up with its collection lasts 30 days at most/);
    // A snapshot may last as long as any link.
    expect(
      (
        await share('owner', family, {
          document_ids: [docs.lease],
          expires_at: days(FOLLOW_MAX_DAYS + 1),
        })
      ).statusCode,
    ).toBe(201);
    // Days from an older way of asking are cut to 30.
    const cut = await shared('owner', family, {
      document_ids: [docs.lease],
      follow_collection: true,
      expires_in_days: 60,
    });
    const end = new Date(cut.share.expires_at).getTime();
    expect(end).toBeLessThanOrEqual(Date.now() + FOLLOW_MAX_DAYS * 864e5);
    expect(end).toBeGreaterThan(Date.now() + (FOLLOW_MAX_DAYS - 1) * 864e5);
    // A few minutes past, from a clock that is ahead, is taken and cut to 30
    // days, as every link's end has its grace (5.18); ten minutes past is not.
    const edge = await shared('owner', family, {
      document_ids: [docs.lease],
      follow_collection: true,
      expires_at: new Date(Date.now() + FOLLOW_MAX_DAYS * 864e5 + 3 * 60_000).toISOString(),
    });
    expect(new Date(edge.share.expires_at).getTime()).toBeLessThanOrEqual(
      Date.now() + FOLLOW_MAX_DAYS * 864e5,
    );
    const far = await share('owner', family, {
      document_ids: [docs.lease],
      follow_collection: true,
      expires_at: new Date(Date.now() + FOLLOW_MAX_DAYS * 864e5 + 10 * 60_000).toISOString(),
    });
    expect(code(far)).toBe('expiry_out_of_range');
    // Nor can the database be talked into more, by anybody.
    await expect(
      withSystem(h.db, t.owner.household_id, (trx) =>
        trx
          .updateTable('share_link')
          .set({ expires_at: new Date(Date.now() + 40 * 864e5) })
          .where('id', '=', cut.share.id)
          .execute(),
      ),
    ).rejects.toThrow(/share_link_follow_30_days/);
    // At its end it stops, as every link does.
    const { cookie } = await opened(cut.link_token);
    await withSystem(h.db, t.owner.household_id, (trx) =>
      trx
        .updateTable('share_link')
        .set({ expires_at: new Date(Date.now() - 1000) })
        .where('id', '=', cut.share.id)
        .execute(),
    );
    expect(code(await items(cookie))).toBe('link_not_valid');
  });

  it('narrowing the collection to Only me, or deleting it, ends its outside links', async () => {
    const move = await collection('owner', 'The move', 'everyone', [docs.lease]);
    const first = await shared('owner', move, { document_ids: [docs.lease] });
    const second = await shared('adult', move, { document_ids: [docs.lease] });
    const a = await opened(first.link_token);
    const b = await opened(second.link_token);

    // Made its maker's alone: both stop at their next request.
    const narrowed = await call('owner', 'PATCH', `/api/v1/collections/${move}`, {
      audience: 'only_me',
    });
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    // Taken back, their sessions went with them: the pages open on them stop.
    for (const s of [a, b]) {
      expect(['share_session_ended', 'link_not_valid']).toContain(code(await items(s.cookie)));
    }
    expect(code(await preview(second.link_token))).toBe('link_not_valid');
    // And for good: widened again, they do not come back.
    await call('owner', 'PATCH', `/api/v1/collections/${move}`, { audience: 'everyone' });
    expect(code(await preview(first.link_token))).toBe('link_not_valid');
    const states = (await linksFor('owner')).filter((l) => l.collection_id === move);
    expect(states.map((l) => l.state)).toEqual(['revoked', 'revoked']);
    // An Only me collection cannot be shared at all.
    await call('owner', 'PATCH', `/api/v1/collections/${move}`, { audience: 'only_me' });
    const refused = await share('owner', move, { document_ids: [docs.lease] });
    expect(refused.statusCode).toBe(422);
    expect(code(refused)).toBe('collection_only_me');

    // Deleted: its links end with it.
    const gone = await collection('owner', 'Gone soon', 'everyone', [docs.lease]);
    const third = await shared('owner', gone, { document_ids: [docs.lease] });
    const c = await opened(third.link_token);
    expect((await call('owner', 'DELETE', `/api/v1/collections/${gone}`)).statusCode).toBe(204);
    expect(['share_session_ended', 'link_not_valid']).toContain(code(await items(c.cookie)));
    expect(code(await preview(third.link_token))).toBe('link_not_valid');
    const log = await activity('owner');
    expect(log).toContain(
      'A link to the collection “Gone soon” stopped working: Owner deleted the collection',
    );
  });

  it('the creator is told when someone else shares their collection', async () => {
    const tellings = () =>
      h.jobs.filter(
        (j) =>
          j.name === 'alert.send' && j.data.subject === 'Somebody shared one of your collections',
      );
    const before = tellings().length;
    // The owner sharing their own: nobody is told.
    await shared('owner', family, { document_ids: [docs.lease] });
    expect(tellings().length).toBe(before);
    // An adult sharing the owner's: the owner is, and the teen when it is theirs.
    await shared('adult', family, { document_ids: [docs.lease], recipient_label: 'Jane Smith' });
    await shared('adult', teens, { document_ids: [docs.teenPoster] });
    const told = tellings().slice(before);
    expect(told.map((j) => j.data.account_ids)).toEqual([[accounts.owner], [accounts.teen]]);
    // Without the collection's name, whom it went to or what: an email leaves the vault.
    for (const j of told) {
      expect(String(j.data.body)).toMatch(/^Alex shared one of the collections you made/);
      expect(JSON.stringify(j.data)).not.toMatch(/mortgage|School trip|Jane Smith|lease/i);
    }
    // The line in the log about the link is for those the list of links
    // gives it to (C519-04): the owner, who may see all it gives, and not
    // the teen, who is told by the email but is given no links.
    const line = 'Alex made a link to the collection “School trip”';
    expect(await activity('owner')).toContain(line);
    expect(await activity('teen')).not.toContain(line);
  });

  it('a reader who cannot see every item does not see the collection share in GET /shares', async () => {
    const withDiary = await shared('owner', family, {
      document_ids: [docs.lease, docs.diary],
      recipient_label: 'the accountant',
    });
    const leaseOnly = await shared('owner', family, {
      document_ids: [docs.lease],
      recipient_label: 'the landlord',
    });
    const adults = (await linksFor('adult')).map((l) => l.id);
    expect(adults).not.toContain(withDiary.share.id);
    expect(adults).toContain(leaseOnly.share.id);
    // Nor may they take it back: there is no such link, for them.
    expect((await call('adult', 'DELETE', `/api/v1/shares/${withDiary.share.id}`)).statusCode).toBe(
      404,
    );
    // Its sharer sees it, never with how many documents went.
    const mine = (await linksFor('owner')).find((l) => l.id === withDiary.share.id);
    expect(mine).toMatchObject({
      collection_id: family,
      collection_name: 'For the mortgage broker',
      document_id: null,
      document_title: null,
      recipient_label: 'the accountant',
    });
    // Its opens are counted; what it holds is not.
    expect(Object.keys(mine ?? {}).filter((k) => /count|item|document_ids/.test(k))).toEqual([
      'open_count',
    ]);
    // A teen and a viewer see no links at all.
    expect(await linksFor('teen')).toEqual([]);
    expect(await linksFor('viewer')).toEqual([]);
    // An owner may take back what they see; an adult who sees every document too.
    expect((await call('adult', 'DELETE', `/api/v1/shares/${leaseOnly.share.id}`)).statusCode).toBe(
      204,
    );
    expect((await call('owner', 'DELETE', `/api/v1/shares/${withDiary.share.id}`)).statusCode).toBe(
      204,
    );
  });

  it('a collection shared to view gives each document’s pages, and never a file', async () => {
    const link = await shared('owner', family, {
      document_ids: [docs.lease, docs.will],
      permission: 'view',
      recipient_label: 'the valuer',
    });
    // The worker is asked for each document's pages.
    const asked = h.jobs
      .filter((j) => j.name === 'share.pages' && j.data.share_id === link.share.id)
      .map((j) => j.data.version_id);
    expect(asked).toHaveLength(2);
    const { session, cookie } = await opened(link.link_token);
    expect(session.permission).toBe('view');
    expect(session.items.map((i) => i.pages?.state)).toEqual(['drawing', 'drawing']);
    for (const doc of [docs.lease, docs.will]) {
      expect(code(await content(cookie, doc))).toBe('view_only');
    }
    // Drawn for the lease, as the worker would: that page is served.
    const v = await withSystem(h.db, t.owner.household_id, (trx) =>
      trx
        .selectFrom('document_version')
        .selectAll()
        .where('document_id', '=', docs.lease)
        .orderBy('version_no', 'desc')
        .executeTakeFirstOrThrow(),
    );
    const key = `${v.storage_key}.share-${link.share.id}.p1.enc`;
    const fileKey = await withSystem(h.db, t.owner.household_id, async (trx) =>
      unwrapKey(
        v.file_key_wrapped,
        await testKeys.unwrapById(trx, v.wrapped_by_scope),
        `version:${docs.lease}`,
      ),
    );
    const jpeg = Buffer.from('\xff\xd8\xff a marked page of the lease', 'latin1');
    const enc = new EncryptStream(fileKey);
    await Promise.all([
      new LocalAdapter(h.vaultDir).put(key, enc),
      pipeline(Readable.from([jpeg]), enc),
    ]);
    await withSystem(h.db, t.owner.household_id, (trx) =>
      trx
        .insertInto('share_page')
        .values({
          household_id: t.owner.household_id,
          share_id: link.share.id,
          document_id: docs.lease,
          version_id: v.id,
          n: 1,
          storage_key: key,
        })
        .execute(),
    );
    const got = await page(cookie, docs.lease, 1);
    expect(got.statusCode, got.body).toBe(200);
    expect(got.rawPayload.equals(jpeg)).toBe(true);
    expect(json<SharedSession>(await items(cookie)).items.map((i) => i.pages?.state)).toEqual([
      'ready',
      'drawing',
    ]);
    // A Word file cannot go on a link to view.
    const notes = await make('owner', 'Tenancy notes');
    await withSystem(h.db, t.owner.household_id, (trx) =>
      trx
        .updateTable('document_version')
        .set({ mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
        .where('document_id', '=', notes)
        .execute(),
    );
    await put('owner', family, [notes]);
    const refused = await share('owner', family, {
      document_ids: [docs.lease, notes],
      permission: 'view',
    });
    expect(code(refused)).toBe('view_not_possible');
    expect(refused.body).toMatch(/“Tenancy notes” is one/);
  });

  it('a collection’s pages that could not be drawn fail a document at a time: the hour, then asked again, as a document’s link’s', async () => {
    const one = await make('owner', 'Survey, page scans');
    const two = await make('owner', 'Floor plan');
    const valuer = await collection('owner', 'For the surveyor', 'everyone', [one, two]);
    const link = await shared('owner', valuer, {
      document_ids: [one, two],
      permission: 'view',
    });
    const { cookie } = await opened(link.link_token);
    const newest = (doc: string) =>
      withSystem(h.db, t.owner.household_id, (trx) =>
        trx
          .selectFrom('document_version')
          .select('id')
          .where('document_id', '=', doc)
          .orderBy('version_no', 'desc')
          .executeTakeFirstOrThrow(),
      );
    const v1 = (await newest(one)).id;
    // The worker's last try failed for the first document, some time ago.
    const failedAgo = (ms: number) =>
      withSystem(h.db, t.owner.household_id, (trx) =>
        trx
          .insertInto('share_page_failure')
          .values({
            household_id: t.owner.household_id,
            share_id: link.share.id,
            document_id: one,
            version_id: v1,
            failed_at: new Date(Date.now() - ms),
          })
          .onConflict((oc) =>
            oc
              .columns(['share_id', 'version_id'])
              .doUpdateSet({ failed_at: new Date(Date.now() - ms) }),
          )
          .execute(),
      );
    const asks = () =>
      h.jobs.filter(
        (j) =>
          j.name === 'share.pages' && j.data.share_id === link.share.id && j.data.version_id === v1,
      ).length;
    const states = async () =>
      json<SharedSession>(await items(cookie)).items.map((i) => [i.id, i.pages?.state]);

    // Under the hour: that one failed, and not asked for; the other still drawn.
    await failedAgo(PAGES_RETRY_MS - 60_000);
    const before = asks();
    expect(await states()).toEqual([
      [one, 'failed'],
      [two, 'drawing'],
    ]);
    expect(code(await page(cookie, one, 1))).toBe('no_preview');
    expect(asks()).toBe(before);
    // A link cannot clear it for itself.
    const cleared = await withScopeOfLink(link.share.id, (trx) =>
      trx.deleteFrom('share_page_failure').where('share_id', '=', link.share.id).executeTakeFirst(),
    );
    expect(cleared.numDeletedRows).toBe(0n);
    // It reads its own, of the documents it gives, and nobody else's.
    const seen = await withScopeOfLink(link.share.id, (trx) =>
      trx.selectFrom('share_page_failure').select('version_id').execute(),
    );
    expect(seen).toEqual([{ version_id: v1 }]);

    // Past the hour: being drawn again, and asked for, by whoever looks.
    await failedAgo(PAGES_RETRY_MS + 60_000);
    expect(await states()).toEqual([
      [one, 'drawing'],
      [two, 'drawing'],
    ]);
    expect(asks()).toBeGreaterThan(before);
    // The version's own previews failing is for good, however long ago.
    await withSystem(h.db, t.owner.household_id, (trx) =>
      trx
        .updateTable('document_version')
        .set({ preview_state: 'failed' })
        .where('id', '=', v1)
        .execute(),
    );
    const now = asks();
    expect((await states())[0]).toEqual([one, 'failed']);
    expect(asks()).toBe(now);

    // Paused after a restore, then turned back on by an owner.
    await withSystem(h.db, t.owner.household_id, (trx) =>
      trx
        .updateTable('document_version')
        .set({ preview_state: 'queued' })
        .where('id', '=', v1)
        .execute(),
    );
    await withSystem(h.db, t.owner.household_id, (trx) =>
      sql`update share_link set paused_at = now(), paused_reason = 'restored'
           where id = ${link.share.id}`.execute(trx),
    );
    // Every failure of the link is tried afresh, each document's pages drawn again.
    const resumed = await call('owner', 'POST', `/api/v1/shares/${link.share.id}/resume`);
    expect(resumed.statusCode, resumed.body).toBe(200);
    const left = await withSystem(h.db, t.owner.household_id, (trx) =>
      trx
        .selectFrom('share_page_failure')
        .select('version_id')
        .where('share_id', '=', link.share.id)
        .execute(),
    );
    expect(left).toEqual([]);
    expect(
      h.jobs.filter(
        (j) => j.name === 'share.pages' && j.data.share_id === link.share.id && j.data.redraw,
      ).length,
    ).toBe(2);
  });

  it('a download counts once for each document in a session, and is written down about it', async () => {
    const link = await shared('owner', family, {
      document_ids: [docs.lease, docs.will],
      max_downloads: 2,
      recipient_label: 'the bank',
    });
    const { cookie } = await opened(link.link_token);
    expect((await content(cookie, docs.lease)).statusCode).toBe(200);
    expect((await content(cookie, docs.lease)).statusCode).toBe(200);
    expect((await content(cookie, docs.will)).statusCode).toBe(200);
    const row = await withSystem(h.db, t.owner.household_id, (trx) =>
      trx
        .selectFrom('share_link')
        .select(['downloads_used', 'open_count'])
        .where('id', '=', link.share.id)
        .executeTakeFirstOrThrow(),
    );
    expect(row).toEqual({ downloads_used: 2, open_count: 1 });
    const lines = await withSystem(h.db, t.owner.household_id, (trx) =>
      trx
        .selectFrom('audit_event')
        .select(['action', 'object_type', 'object_id', 'actor_label'])
        .where(sql<boolean>`detail->>'share_id' = ${link.share.id}`)
        .orderBy('id')
        .execute(),
    );
    expect(lines).toEqual([
      {
        action: 'share.created',
        object_type: 'collection',
        object_id: family,
        actor_label: null,
      },
      {
        action: 'share.opened',
        object_type: 'collection',
        object_id: family,
        actor_label: 'shared link (the bank)',
      },
      {
        action: 'share.downloaded',
        object_type: 'document',
        object_id: docs.lease,
        actor_label: 'shared link (the bank)',
      },
      {
        action: 'share.downloaded',
        object_type: 'document',
        object_id: docs.will,
        actor_label: 'shared link (the bank)',
      },
    ]);
    // The chain the link wrote into — without reading it — still verifies.
    const verified = await withSystem(h.db, t.owner.household_id, (trx) =>
      verifyAuditChain(trx, t.owner.household_id),
    );
    expect(verified.ok).toBe(true);
  });

  it('shared outside, a collection says so: whom only to those who may share', async () => {
    const hols = await collection('owner', 'Holidays', 'everyone', [docs.lease]);
    await shared('owner', hols, { document_ids: [docs.lease], recipient_label: 'Jane Smith' });
    const said = async (who: Who) =>
      json<{ items: CollectionView[] }>(await call(who, 'GET', '/api/v1/collections')).items.find(
        (c) => c.id === hols,
      )?.shared_outside;
    expect(await said('owner')).toEqual({ with: ['Jane Smith'], following: false });
    expect(await said('adult')).toEqual({ with: ['Jane Smith'], following: false });
    expect(await said('teen')).toEqual({ with: [], following: false });
    // A link made with something the reader cannot see is one GET /shares
    // does not give them: they are told the collection is shared, not with whom.
    await put('owner', hols, [docs.diary]);
    await shared('owner', hols, {
      document_ids: [docs.lease, docs.diary],
      recipient_label: 'the solicitor',
    });
    expect(await said('owner')).toEqual({
      with: ['Jane Smith', 'the solicitor'],
      following: false,
    });
    expect(await said('adult')).toEqual({ with: ['Jane Smith'], following: false });
    // A collection shared with nobody, or whose links are all taken back, says nothing.
    const quiet = await collection('owner', 'Not shared', 'everyone', [docs.lease]);
    expect(
      json<CollectionDetail>(await call('owner', 'GET', `/api/v1/collections/${quiet}`))
        .shared_outside,
    ).toBeNull();
    const once = await shared('owner', quiet, { document_ids: [docs.lease] });
    await call('owner', 'DELETE', `/api/v1/shares/${once.share.id}`);
    expect(await said('owner')).not.toBeNull();
    expect(
      json<{ items: CollectionView[] }>(
        await call('owner', 'GET', '/api/v1/collections'),
      ).items.find((c) => c.id === quiet)?.shared_outside,
    ).toBeNull();
  });

  it('after a restore a collection’s link waits for an owner, who confirms it’s them', async () => {
    const link = await shared('owner', family, { document_ids: [docs.lease] });
    // As restore.ts's PAUSE_LINKS does it, for this one link.
    await withSystem(h.db, t.owner.household_id, (trx) =>
      sql`update share_link set paused_at = now(), paused_reason = 'restored'
           where id = ${link.share.id}`.execute(trx),
    );
    expect(code(await preview(link.link_token))).toBe('link_not_valid');
    const paused = json<{ links: ShareView[] }>(
      await call('owner', 'GET', '/api/v1/after-restore'),
    ).links;
    expect(paused.map((l) => l.id)).toContain(link.share.id);
    // An adult may not turn it back on.
    expect((await call('adult', 'POST', `/api/v1/shares/${link.share.id}/resume`)).statusCode).toBe(
      403,
    );
    await fresh('owner', false);
    try {
      const asked = await call('owner', 'POST', `/api/v1/shares/${link.share.id}/resume`);
      expect(json<{ error: { code: string; action: string } }>(asked).error).toMatchObject({
        code: 'step_up_required',
        action: 'share_collection',
      });
    } finally {
      await fresh('owner', true);
    }
    const resumed = await call('owner', 'POST', `/api/v1/shares/${link.share.id}/resume`);
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(json<ShareView>(resumed).state).toBe('active');
    expect(json<ShareLinkPreview>(await preview(link.link_token)).kind).toBe('collection');
  });

  it("a link scope sees 0 rows in every household table but its document's, its file, its share and what the page names", async () => {
    const admin = createPool(h.adminUrl, 1);
    try {
      // Every table that holds a household's rows, and the sign-ins that
      // belong to no household: whatever a later migration adds is in here
      // too, and must give a link nothing unless it is named below.
      const { rows } = await admin.query<{ name: string; household: boolean }>(
        `select c.relname as name,
                exists (select 1 from pg_attribute a where a.attrelid = c.oid
                         and a.attname = 'household_id' and not a.attisdropped) as household
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r'
            and (c.relname in ('household', 'account', 'credential', 'password_reset',
                               'webauthn_challenge')
                 or exists (select 1 from pg_attribute a where a.attrelid = c.oid
                             and a.attname = 'household_id' and not a.attisdropped))
          order by 1`,
      );
      const tables = rows.map((r) => r.name);
      expect(tables).toEqual(
        expect.arrayContaining(['audit_event', 'member', 'account_household', 'session']),
      );
      const counted = (shareId: string) =>
        withScopeOfLink(shareId, async (trx) => {
          const got: Record<string, number> = {};
          for (const r of rows) {
            // The built-in kinds of document and fields are everybody's (0031).
            const where =
              r.name === 'document_type' || r.name === 'document_attribute'
                ? ' where household_id is not null'
                : '';
            const n = await sql<{ n: number }>`select count(*)::int as n from ${sql.table(
              r.name,
            )}${sql.raw(where)}`.execute(trx);
            got[r.name] = n.rows[0]?.n ?? -1;
          }
          return got;
        });
      const nothing = Object.fromEntries(tables.map((name) => [name, 0]));

      // A collection's link, opened, with two documents: what they are, the
      // newest file of each, its share and snapshot, its collection and the
      // two documents' places in it, its session, and what the page names —
      // the household, whoever shared it and their membership — and what
      // opens the files: the key they are wrapped under and where they are.
      const link = await shared('adult', family, { document_ids: [docs.lease, docs.will] });
      await opened(link.link_token);
      const keys = await withSystem(h.db, t.owner.household_id, (trx) =>
        trx
          .selectFrom('document_version')
          .select(['wrapped_by_scope', 'vault_id'])
          .where('document_id', 'in', [docs.lease, docs.will])
          .execute(),
      );
      expect(await counted(link.share.id)).toEqual({
        ...nothing,
        document: 2,
        document_version: 2,
        share_link: 1,
        share_link_item: 2,
        share_session: 1,
        doc_collection: 1,
        doc_collection_item: 2,
        household: 1,
        member: 1,
        account_household: 1,
        scope_key: new Set(keys.map((k) => k.wrapped_by_scope)).size,
        vault: new Set(keys.map((k) => k.vault_id)).size,
      });
      // And the sharer it names is the one who shared it.
      const sharer = await withScopeOfLink(link.share.id, (trx) =>
        trx.selectFrom('member').select('display_name').execute(),
      );
      expect(sharer).toEqual([{ display_name: 'Alex' }]);

      // A document's link: its document, its file, its share.
      const one = json<CreatedShare>(
        await call('owner', 'POST', `/api/v1/documents/${docs.lease}/share`, {}),
      );
      expect(await counted(one.share.id)).toEqual({
        ...nothing,
        document: 1,
        document_version: 1,
        share_link: 1,
        household: 1,
        member: 1,
        account_household: 1,
        scope_key: 1,
        vault: 1,
      });
      // Taken back, it reaches nothing of the family at all but its household.
      await call('owner', 'DELETE', `/api/v1/shares/${one.share.id}`);
      expect(await counted(one.share.id)).toEqual({ ...nothing, household: 1 });

      // It writes nothing of the household's but its own lines, and reads none.
      await expect(
        withScopeOfLink(link.share.id, (trx) =>
          trx
            .updateTable('member')
            .set({ display_name: 'Changed' })
            .where('display_name', '=', 'Alex')
            .execute(),
        ),
      ).resolves.toEqual([expect.objectContaining({ numUpdatedRows: 0n })]);
      await expect(
        withScopeOfLink(link.share.id, (trx) =>
          trx
            .insertInto('audit_event')
            .values({
              household_id: t.owner.household_id,
              action: 'document.deleted',
              object_type: 'document',
              object_id: docs.lease,
              detail: JSON.stringify({ share_id: link.share.id }),
              hash: randomBytes(32),
            })
            .execute(),
        ),
        // Refused by its rule, or, first, as a line off the chain (0042).
      ).rejects.toThrow(/row-level security|head of the activity log/);
    } finally {
      await admin.end();
    }
  });

  // ------------------------------------------------ the 5.19 review

  describe('following decides once, as a document is added (R519-01, C519-01/02/03)', () => {
    /** An adult's following link to a fresh collection of the owner's, for everyone. */
    const following = async (name: string, documents: string[], ticked = documents) => {
      await fresh('adult', true);
      await fresh('owner', true);
      const id = await collection('owner', name, 'everyone', documents);
      const link = await shared('adult', id, {
        document_ids: ticked,
        follow_collection: true,
        recipient_label: 'the agent',
      });
      const { cookie } = await opened(link.link_token);
      return { id, link, cookie };
    };
    const followedLines = async (collectionId: string) =>
      (
        await withSystem(h.db, t.owner.household_id, (trx) =>
          trx
            .selectFrom('audit_event')
            .select('object_id')
            .where('action', '=', 'share.followed')
            .where(sql<boolean>`detail->>'collection_id' = ${collectionId}`)
            .execute(),
        )
      ).map((r) => r.object_id);

    it('narrowing a following collection to Adults sends nothing new outside', async () => {
      const house = await make('owner', 'Gas safety certificate');
      const settlement = await make('owner', 'Divorce settlement', 'adults');
      const { id, cookie } = await following('House papers', [docs.lease]);
      // Put in while the collection is for everyone: the household one
      // follows; the adults-only one is held back, and the log says which.
      await put('owner', id, [house, settlement]);
      expect(await given(cookie)).toEqual([docs.lease, house]);
      expect(await followedLines(id)).toEqual([house]);
      // Made more private: nothing held back goes out now, and what went out
      // before and still fits stays.
      const narrowed = await call('owner', 'PATCH', `/api/v1/collections/${id}`, {
        audience: 'adults',
      });
      expect(narrowed.statusCode, narrowed.body).toBe(200);
      expect(await given(cookie)).toEqual([docs.lease, house]);
      expect((await content(cookie, settlement)).statusCode).toBe(404);
      expect(await followedLines(id)).toEqual([house]);
    });

    it("widening a document's visibility later does not send it out", async () => {
      const medical = await make('owner', 'Medical history', 'private');
      const statement = await make('owner', 'Savings statement', 'adults');
      const { id, cookie } = await following('Before the move', [docs.lease]);
      await put('owner', id, [medical, statement]);
      expect(await given(cookie)).toEqual([docs.lease]);
      // Both made the family's own afterwards: still not sent.
      for (const doc of [medical, statement]) {
        const widened = await call('owner', 'POST', `/api/v1/documents/${doc}/visibility`, {
          visibility: 'household',
        });
        expect(widened.statusCode, widened.body).toBe(200);
      }
      expect(await given(cookie)).toEqual([docs.lease]);
      expect(await followedLines(id)).toEqual([]);
      // And one that followed, made adults-only later, is taken away: a
      // later change only ever takes away.
      const utility = await make('owner', 'Water bill');
      await put('owner', id, [utility]);
      expect(await given(cookie)).toEqual([docs.lease, utility]);
      await call('owner', 'POST', `/api/v1/documents/${utility}/visibility`, {
        visibility: 'adults',
      });
      expect(await given(cookie)).toEqual([docs.lease]);
    });

    it("a teen's addition never follows", async () => {
      await fresh('adult', true);
      const trip = await collection('teen', 'Exchange trip', 'everyone', [docs.teenPoster]);
      const link = await shared('adult', trip, {
        document_ids: [docs.teenPoster],
        follow_collection: true,
      });
      const { cookie } = await opened(link.link_token);
      // The teen, its maker, puts the family's household bank letter in it.
      const letter = await make('owner', 'Bank letter');
      await put('teen', trip, [letter]);
      expect(await given(cookie)).toEqual([docs.teenPoster]);
      expect((await content(cookie, letter)).statusCode).toBe(404);
      expect(await followedLines(trip)).toEqual([]);
      // Nor does it through the database's own rule for the link.
      const reached = await withScopeOfLink(link.share.id, (trx) =>
        trx.selectFrom('document').select('id').execute(),
      );
      expect(reached.map((r) => r.id)).toEqual([docs.teenPoster]);
    });

    it('a document left unticked never follows, even re-added', async () => {
      const deed = await make('owner', 'Title deed scan');
      const { id, cookie } = await following('For the solicitor', [docs.lease, deed], [docs.lease]);
      expect(await given(cookie)).toEqual([docs.lease]);
      // Taken out and put back — how a document is moved to the end.
      expect(
        (await call('owner', 'DELETE', `/api/v1/collections/${id}/items/${deed}`)).statusCode,
      ).toBe(204);
      await put('owner', id, [deed]);
      expect(await given(cookie)).toEqual([docs.lease]);
      expect(await followedLines(id)).toEqual([]);
    });

    it('a document taken out and put back is decided again, by whoever puts it back (second review)', async () => {
      await fresh('owner', true);
      // Bea, an adult, makes the collection; the owner shares it, keeping up.
      const bea = await h.join(t.owner, { name: 'Bea', email: 'bea@example.test', role: 'adult' });
      const asBea = (method: 'POST' | 'DELETE', url: string, payload?: object) =>
        h.app.inject({ method, url, headers: h.as(bea), ...(payload ? { payload } : {}) });
      const made = await asBea('POST', '/api/v1/collections', {
        name: 'Bea’s papers',
        audience: 'everyone',
      });
      const id = json<CollectionDetail>(made).id;
      expect(
        (await asBea('POST', `/api/v1/collections/${id}/items`, { document_ids: [docs.lease] }))
          .statusCode,
      ).toBe(200);
      const link = await shared('owner', id, {
        document_ids: [docs.lease],
        follow_collection: true,
      });
      const { cookie } = await opened(link.link_token);
      const letter = await make('owner', 'Bank letter, twice');
      const putBack = async () =>
        expect(
          (await asBea('POST', `/api/v1/collections/${id}/items`, { document_ids: [letter] }))
            .statusCode,
        ).toBe(200);
      const takeOut = async () =>
        expect(
          (await asBea('DELETE', `/api/v1/collections/${id}/items/${letter}`)).statusCode,
        ).toBe(204);
      await putBack();
      expect(await given(cookie)).toEqual([docs.lease, letter]);
      expect(await followedLines(id)).toEqual([letter]);
      await takeOut();
      expect(await given(cookie)).toEqual([docs.lease]);
      // Put back by an adult: decided again, and the log says it went again.
      await putBack();
      expect(await given(cookie)).toEqual([docs.lease, letter]);
      expect(await followedLines(id)).toEqual([letter, letter]);
      // Taken out, and Bea made a teen — still its maker: put back, it
      // stays in the family, and nothing says it went.
      await takeOut();
      const role = await call('owner', 'POST', `/api/v1/members/${bea.member_id}/role`, {
        role: 'teen',
      });
      expect(role.statusCode, role.body).toBe(200);
      await putBack();
      expect(await given(cookie)).toEqual([docs.lease]);
      expect((await content(cookie, letter)).statusCode).toBe(404);
      expect(await followedLines(id)).toEqual([letter, letter]);
    });

    it('what the sheet offered and was left unticked never follows, though it left the collection before Share (second review)', async () => {
      await fresh('adult', true);
      await fresh('owner', true);
      const deed = await make('owner', 'Deed, seen in the sheet');
      const id = await collection('owner', 'Sheet left open', 'everyone', [docs.lease, deed]);
      const offered = json<CollectionSharePreview>(await sharePreview('adult', id)).items.map(
        (i) => i.document_id,
      );
      expect(offered).toEqual([docs.lease, deed]);
      // While the sheet is open, the owner takes the deed out.
      expect(
        (await call('owner', 'DELETE', `/api/v1/collections/${id}/items/${deed}`)).statusCode,
      ).toBe(204);
      // The sheet says what it offered and was left unticked — with, here,
      // another's private document, kept as left out too (it only ever
      // narrows the link: the third review), and one that is not there,
      // which is dropped, never an error.
      const link = await shared('adult', id, {
        document_ids: [docs.lease],
        follow_collection: true,
        left_out_ids: [deed, docs.diary, randomUUID()],
      });
      const { cookie } = await opened(link.link_token);
      // Put back later: seen and left unticked, it stays in the family.
      await put('owner', id, [deed]);
      expect(await given(cookie)).toEqual([docs.lease]);
      expect(await followedLines(id)).toEqual([]);
      expect(await snapshotOf(link.share.id)).toEqual(
        [
          { document_id: deed, kind: 'left_out' },
          { document_id: docs.diary, kind: 'left_out' },
          { document_id: docs.lease, kind: 'ticked' },
        ].sort(bySnapshot),
      );
    });

    it('what the sheet offered and was left unticked never follows, though it was made private and taken out while the sheet was open (third review)', async () => {
      await fresh('adult', true);
      await fresh('owner', true);
      const deed = await make('owner', 'Deed, private for a while');
      const id = await collection('owner', 'Sheet open, deed hidden', 'everyone', [
        docs.lease,
        deed,
      ]);
      const offered = json<CollectionSharePreview>(await sharePreview('adult', id)).items.map(
        (i) => i.document_id,
      );
      expect(offered).toEqual([docs.lease, deed]);
      // While the sheet is open, the owner makes the deed their own, and
      // takes it out: the adult can no longer see it.
      const hidden = await call('owner', 'POST', `/api/v1/documents/${deed}/visibility`, {
        visibility: 'private',
      });
      expect(hidden.statusCode, hidden.body).toBe(200);
      expect(
        (await call('owner', 'DELETE', `/api/v1/collections/${id}/items/${deed}`)).statusCode,
      ).toBe(204);
      const link = await shared('adult', id, {
        document_ids: [docs.lease],
        follow_collection: true,
        left_out_ids: [deed],
      });
      const { cookie } = await opened(link.link_token);
      expect(await snapshotOf(link.share.id)).toEqual(
        [
          { document_id: deed, kind: 'left_out' },
          { document_id: docs.lease, kind: 'ticked' },
        ].sort(bySnapshot),
      );
      // Later, the family's again, and put back: still left out.
      const shown = await call('owner', 'POST', `/api/v1/documents/${deed}/visibility`, {
        visibility: 'household',
      });
      expect(shown.statusCode, shown.body).toBe(200);
      await put('owner', id, [deed]);
      expect(await given(cookie)).toEqual([docs.lease]);
      expect(await followedLines(id)).toEqual([]);
    });

    it("putting documents in while a link's pages are kept is never a deadlock (second review)", async () => {
      await fresh('adult', true);
      await fresh('owner', true);
      const id = await collection('owner', 'Pages being kept', 'everyone', [docs.lease]);
      const link = await shared('adult', id, {
        document_ids: [docs.lease],
        follow_collection: true,
        permission: 'view',
      });
      const extra = await make('owner', 'Put in as pages are kept');
      const admin = createPool(h.adminUrl, 2);
      const holder = await admin.connect();
      const dbName = new URL(h.adminUrl).pathname.slice(1);
      try {
        const version = (
          await holder.query<{ id: string }>(
            'select id from document_version where document_id = $1 order by version_no desc limit 1',
            [docs.lease],
          )
        ).rows[0]?.id;
        // What keeps a link's pages, as it once did: the link held first,
        // then a page of the lease written, which names the lease.
        await holder.query('begin');
        await holder.query('select id from share_link where id = $1 for update', [link.share.id]);
        // The lease (already in it) and a new one put in, together.
        const adding = call('owner', 'POST', `/api/v1/collections/${id}/items`, {
          document_ids: [docs.lease, extra],
        });
        let waited = false;
        for (let i = 0; i < 200 && !waited; i += 1) {
          const r = await admin.query<{ n: number }>(
            `select count(*)::int as n from pg_stat_activity
              where datname = $1 and wait_event_type = 'Lock'`,
            [dbName],
          );
          waited = (r.rows[0]?.n ?? 0) >= 1;
          if (!waited) await new Promise((res) => setTimeout(res, 50));
        }
        expect(waited).toBe(true);
        await holder.query(
          `insert into share_page (household_id, share_id, permission, document_id, version_id, n, storage_key)
           values ($1, $2, 'view', $3, $4, 1, 'held/while/adding')`,
          [t.owner.household_id, link.share.id, docs.lease, version],
        );
        await holder.query('rollback');
        const added = await adding;
        expect(added.statusCode, added.body).toBe(200);
      } finally {
        await holder.query('rollback').catch(() => undefined);
        holder.release();
        await admin.end();
      }
      const { cookie } = await opened(link.link_token);
      expect(await given(cookie)).toEqual([docs.lease, extra]);
    });

    it("a share racing the maker's narrowing to Only me does not survive it (C519-07)", async () => {
      await fresh('adult', true);
      await fresh('owner', true);
      const id = await collection('owner', 'Race', 'everyone', [docs.lease]);
      const admin = createPool(h.adminUrl, 3);
      const holder = await admin.connect();
      const dbName = new URL(h.adminUrl).pathname.slice(1);
      const waiting = async (n: number) => {
        for (let i = 0; i < 200; i += 1) {
          const r = await admin.query<{ n: number }>(
            `select count(*)::int as n from pg_stat_activity
              where datname = $1 and wait_event_type = 'Lock'`,
            [dbName],
          );
          if ((r.rows[0]?.n ?? 0) >= n) return;
          await new Promise((res) => setTimeout(res, 50));
        }
        throw new Error(`fewer than ${n} requests waiting`);
      };
      try {
        // The household's activity log held, so both requests stop where
        // they write to it: the narrowing after its change, the share after
        // it read the collection as it was.
        await holder.query('begin');
        await holder.query(`select pg_advisory_xact_lock(hashtext('audit:' || $1::uuid::text))`, [
          t.owner.household_id,
        ]);
        const narrowing = call('owner', 'PATCH', `/api/v1/collections/${id}`, {
          audience: 'only_me',
        });
        await waiting(1);
        const sharing = share('adult', id, { document_ids: [docs.lease] });
        await waiting(2);
        await holder.query('commit');
        const [narrowed, made] = await Promise.all([narrowing, sharing]);
        expect(narrowed.statusCode, narrowed.body).toBe(200);
        // Refused, or made and then taken back with the rest: never live.
        const live = await withSystem(h.db, t.owner.household_id, (trx) =>
          trx
            .selectFrom('share_link')
            .select('id')
            .where('collection_id', '=', id)
            .where('revoked_at', 'is', null)
            .execute(),
        );
        expect(live).toEqual([]);
        // Widened again, nothing comes back.
        await call('owner', 'PATCH', `/api/v1/collections/${id}`, { audience: 'everyone' });
        if (made.statusCode === 201) {
          expect(code(await preview(json<CreatedShare>(made).link_token))).toBe('link_not_valid');
        } else {
          expect([404, 422]).toContain(made.statusCode);
        }
      } finally {
        holder.release();
        await admin.end();
      }
    });
  });

  it('a link reads only the snapshot rows of what it gives (R519-03)', async () => {
    await fresh('owner', true);
    const first = await make('owner', 'Snapshot one');
    const second = await make('owner', 'Snapshot two');
    const id = await collection('owner', 'Snapshot', 'everyone', [first, second]);
    const link = await shared('owner', id, { document_ids: [first, second] });
    const rows = () =>
      withScopeOfLink(link.share.id, (trx) =>
        trx.selectFrom('share_link_item').select('document_id').execute(),
      );
    expect((await rows()).length).toBe(2);
    // The second in the Trash: the link neither gives it nor learns it was ticked.
    expect((await call('owner', 'DELETE', `/api/v1/documents/${second}`)).statusCode).toBe(204);
    expect(await rows()).toEqual([{ document_id: first }]);
    await call('owner', 'POST', `/api/v1/documents/${second}/restore`);
    expect((await rows()).length).toBe(2);
  });

  /**
   * A line `link` writes in the log itself, then undone: whether it was let
   * through. As its own (`shared link (the bank)`, the lease downloaded),
   * hashed as appendAudit hashes unless `hash` is given; `rows` of it in
   * one statement.
   */
  const linkLine = (link: CreatedShare) => {
    const hh = t.owner.household_id;
    const headNow = async (trx: Db) =>
      (
        await sql<{
          hash: Buffer | null;
          at: Date;
        }>`select audit_chain_head(${hh}::uuid) as hash,
                  date_trunc('milliseconds', clock_timestamp()) as at`.execute(trx)
      ).rows[0] as { hash: Buffer | null; at: Date };
    return (over: Record<string, unknown>, rows = 1) =>
      withScopeOfLink(link.share.id, async (trx) => {
        const { hash: prev, at } = await headNow(trx);
        const line = {
          household_id: hh,
          actor_account_id: null,
          actor_label: 'shared link (the bank)',
          action: 'share.downloaded',
          object_type: 'document',
          object_id: docs.lease,
          detail: { share_id: link.share.id },
          at,
          prev_hash: prev,
          ...over,
        } as Parameters<typeof computeHash>[0];
        const hash = (over.hash as Buffer | undefined) ?? computeHash(line);
        const detail = JSON.stringify(line.detail);
        if (rows === 1) {
          await trx
            .insertInto('audit_event')
            .values({
              household_id: line.household_id,
              actor_label: line.actor_label,
              action: line.action,
              object_type: line.object_type,
              object_id: line.object_id,
              detail,
              at: line.at,
              prev_hash: line.prev_hash,
              hash,
            })
            .execute();
        } else {
          await sql`insert into audit_event (household_id, actor_label, action, object_type,
                                             object_id, detail, at, prev_hash, hash)
                    select ${hh}::uuid, ${line.actor_label}, ${line.action}, ${line.object_type},
                           ${line.object_id}::uuid, ${detail}::jsonb, ${line.at}::timestamptz,
                           ${line.prev_hash}, ${hash}
                      from generate_series(1, ${rows})`.execute(trx);
        }
        throw new Error('written, and undone');
      });
  };
  const chainWhole = () =>
    withSystem(h.db, t.owner.household_id, (trx) => verifyAuditChain(trx, t.owner.household_id));

  it("a link writes only its own lines: its own documents, its own name, the chain's head (R519-04)", async () => {
    await fresh('owner', true);
    const link = await shared('owner', family, {
      document_ids: [docs.lease],
      recipient_label: 'the bank',
    });
    const tries = linkLine(link);
    // Its own, hashed as the log hashes: written (and undone here).
    await expect(tries({})).rejects.toThrow(/written, and undone/);
    // A document it does not give, a collection it is not to, another's
    // name, nobody's, or a line off the chain: refused.
    for (const [what, over] of [
      ['a document it does not give', { object_id: docs.insurance }],
      ['the will, which it does not give', { object_id: docs.will }],
      ['a collection it is not to', { object_type: 'collection', object_id: teens }],
      ['as the owner', { actor_label: 'Owner' }],
      ['as somebody else’s link', { actor_label: 'shared link (the landlord)' }],
      ['off the chain', { prev_hash: randomBytes(32) }],
    ] as const) {
      await expect(tries(over), what).rejects.toThrow(
        /row-level security|head of the activity log/,
      );
    }
    // 5.20's line, a code sent (0043, F520-01), is held the same way, by the
    // rule and the trigger as 0042 has them: about its own collection, under
    // its own name, on the chain, and on the database's clock — no more than
    // 15 minutes behind it, nor more than one ahead.
    const codeSent = {
      action: 'share.code_sent',
      object_type: 'collection',
      object_id: family,
      detail: { share_id: link.share.id, to: 'j•••@e•••.com', user_agent: 'Firefox' },
    };
    await expect(tries(codeSent)).rejects.toThrow(/written, and undone/);
    const dbNow = await withSystem(h.db, t.owner.household_id, async (trx) =>
      (
        await sql<{
          now: Date;
        }>`select date_trunc('milliseconds', clock_timestamp()) as now`.execute(trx)
      ).rows[0]?.now.getTime(),
    );
    for (const [what, over] of [
      ['a collection it is not to', { object_id: teens }],
      ['as somebody else’s link', { actor_label: 'shared link (the landlord)' }],
      ['off the chain', { prev_hash: randomBytes(32) }],
      ['16 minutes behind the clock', { at: new Date((dbNow ?? 0) - 16 * 60_000) }],
      ['two minutes ahead of the clock', { at: new Date((dbNow ?? 0) + 2 * 60_000) }],
    ] as const) {
      await expect(tries({ ...codeSent, ...over }), `a code sent, ${what}`).rejects.toThrow(
        /row-level security|head of the activity log/,
      );
    }
    // And `to` is a code sent's alone: on any other line, refused.
    for (const action of ['share.opened', 'share.viewed', 'share.downloaded']) {
      await expect(
        tries({ action, detail: { share_id: link.share.id, to: 'j•••@e•••.com' } }),
        `${action} with a to`,
      ).rejects.toThrow(/says only what a line of its kind may say/);
    }
  });

  it('a link cannot fork the chain, or hash its line otherwise than the log does (second review)', async () => {
    await fresh('owner', true);
    const link = await shared('owner', family, {
      document_ids: [docs.lease],
      recipient_label: 'the bank',
    });
    const tries = linkLine(link);
    // Three lines on one head in one statement: the second is refused.
    await expect(tries({}, 3), 'three lines on one head').rejects.toThrow(
      /head of the activity log/,
    );
    // A made-up hash, and a detail saying more than which link and what
    // browser (which the hash would carry on for ever): refused.
    await expect(tries({ hash: Buffer.from('ffff', 'hex') }), 'a made-up hash').rejects.toThrow(
      /hashed as every line/,
    );
    await expect(
      tries({ detail: { share_id: link.share.id, said: 'anything' } }),
      'more in its detail',
    ).rejects.toThrow(/says only what a line of its kind may say/);
    // Its own, honestly: written; and the chain is whole after all of it.
    await expect(tries({})).rejects.toThrow(/written, and undone/);
    await opened(link.link_token);
    expect(await chainWhole()).toMatchObject({ ok: true });
  });

  it('a link says it locked only once it has: its tenth wrong PIN (second review)', async () => {
    await fresh('owner', true);
    const link = await shared('owner', family, {
      document_ids: [docs.lease],
      recipient_label: 'the bank',
    });
    const tries = linkLine(link);
    const locked = { action: 'share.locked', object_type: 'collection', object_id: family };
    // While it still works: refused.
    await expect(tries(locked), 'a lock that never was').rejects.toThrow(/row-level security/);
    // Its tenth wrong PIN taken: said.
    await withSystem(h.db, t.owner.household_id, (trx) =>
      trx.updateTable('share_link').set({ attempts: 10 }).where('id', '=', link.share.id).execute(),
    );
    await expect(tries(locked), 'its tenth wrong PIN').rejects.toThrow(/written, and undone/);
  });

  it("a recipient's request does not depend on the API's clock agreeing with the database's (second review)", async () => {
    await fresh('owner', true);
    const hh = t.owner.household_id;
    const link = await shared('owner', family, { document_ids: [docs.lease] });
    for (const skew of [20 * 60_000, -20 * 60_000]) {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(Date.now() + skew));
      try {
        const { cookie } = await opened(link.link_token);
        expect((await content(cookie, docs.lease)).statusCode, `${skew}`).toBe(200);
      } finally {
        vi.useRealTimers();
      }
    }
    // Each line dated by the database: now, whatever the API's clock said.
    const lines = await withSystem(h.db, hh, (trx) =>
      trx
        .selectFrom('audit_event')
        .select(sql<number>`extract(epoch from (now() - at))::float`.as('ago'))
        .where(sql<boolean>`detail->>'share_id' = ${link.share.id}`)
        .execute(),
    );
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const l of lines) expect(Math.abs(l.ago)).toBeLessThan(120);
    expect(await withSystem(h.db, hh, (trx) => verifyAuditChain(trx, hh))).toMatchObject({
      ok: true,
    });
  });

  it('a collection link’s lines in the log are for those GET /shares gives the link (C519-04)', async () => {
    await fresh('owner', true);
    const withDiary = await shared('owner', family, {
      document_ids: [docs.lease, docs.diary],
      recipient_label: 'the divorce lawyer',
    });
    const lawyer = await opened(withDiary.link_token);
    const leaseOnly = await shared('owner', family, {
      document_ids: [docs.lease],
      recipient_label: 'the landlord',
    });
    const landlord = await opened(leaseOnly.link_token);
    // And the lease downloaded through each: a line about the document, on
    // the link (the second review).
    expect((await content(lawyer.cookie, docs.lease)).statusCode).toBe(200);
    expect((await content(landlord.cookie, docs.lease)).statusCode).toBe(200);
    const said = async (who: Who) => (await activity(who)).join('\n');
    // Its maker, who sees every document, reads both.
    expect(await said('owner')).toMatch(/for the divorce lawyer/);
    expect(await said('owner')).toMatch(/Shared link \(the divorce lawyer\) opened/);
    expect(await said('owner')).toMatch(/Shared link \(the divorce lawyer\) downloaded/);
    // An adult who cannot see the diary: not a word of that link, not even
    // of the lease they may see downloaded through it.
    expect(await said('adult')).not.toMatch(/divorce lawyer/);
    expect(await said('adult')).toMatch(/for the landlord/);
    expect(await said('adult')).toMatch(/Shared link \(the landlord\) downloaded/);
    // A teen, who may not share: no collection link's lines at all.
    expect(await said('teen')).not.toMatch(/divorce lawyer|the landlord/);
  });

  it('Sharing says who took a link back, and why a collection’s ended (W519-1)', async () => {
    await fresh('adult', true);
    await fresh('owner', true);
    const id = await collection('owner', 'Taken back', 'everyone', [docs.lease]);
    const link = await shared('adult', id, {
      document_ids: [docs.lease],
      recipient_label: 'the bank',
    });
    expect((await call('owner', 'DELETE', `/api/v1/shares/${link.share.id}`)).statusCode).toBe(204);
    const summary = async (who: Who, shareId: string) =>
      (await linksFor(who)).find((l) => l.id === shareId)?.summary;
    expect(await summary('adult', link.share.id)).toMatch(/Owner took this link back\.$/);
    expect(await summary('owner', link.share.id)).toMatch(/You took this link back\.$/);
    // Ended with its collection made Only me: said so, to its maker.
    const other = await shared('owner', id, { document_ids: [docs.lease] });
    await call('owner', 'PATCH', `/api/v1/collections/${id}`, { audience: 'only_me' });
    expect(await summary('owner', other.share.id)).toMatch(
      /It stopped when the collection was made Only me\.$/,
    );
  });

  it("a collection link's download lines follow the collection's audience: made Only me, the adults read none (third review)", async () => {
    await fresh('owner', true);
    const said = async (who: Who) => (await activity(who)).join('\n');
    const downloaded = async (name: string, label: string) => {
      const id = await collection('owner', name, 'everyone', [docs.lease]);
      const link = await shared('owner', id, {
        document_ids: [docs.lease],
        recipient_label: label,
      });
      const { cookie } = await opened(link.link_token);
      expect((await content(cookie, docs.lease)).statusCode).toBe(200);
      return id;
    };
    const surveyed = await downloaded('Made Only me later', 'the surveyor');
    expect(await said('adult')).toMatch(/Shared link \(the surveyor\) downloaded/);
    // Made the owner's alone: GET /shares gives the adult no such link, and
    // the log names its recipient to them no more.
    const narrowed = await call('owner', 'PATCH', `/api/v1/collections/${surveyed}`, {
      audience: 'only_me',
    });
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    expect(await said('adult')).not.toMatch(/the surveyor/);
    expect(await said('owner')).toMatch(/Shared link \(the surveyor\) downloaded/);
    // Deleted, its lines are its history, as the collection's own are.
    const valued = await downloaded('Deleted later', 'the valuer');
    expect((await call('owner', 'DELETE', `/api/v1/collections/${valued}`)).statusCode).toBe(204);
    expect(await said('adult')).toMatch(/Shared link \(the valuer\) downloaded/);
  });

  it('sharing one collection while documents go into another is never a deadlock (third review)', async () => {
    await fresh('adult', true);
    await fresh('owner', true);
    // Three documents, A < X < B by id, in the shared collection against
    // that order: B, X, A.
    const made = [
      await make('owner', 'Lock order one'),
      await make('owner', 'Lock order two'),
      await make('owner', 'Lock order three'),
    ];
    const [A, X, B] = [...made].sort() as [string, string, string];
    const sharedOne = await collection('owner', 'Shared against id order', 'everyone', [B, X, A]);
    const other = await collection('owner', 'Being added to', 'everyone', []);
    const admin = createPool(h.adminUrl, 3);
    const holder = await admin.connect();
    try {
      // X held a moment, so the share stops part-way through its documents.
      await holder.query('begin');
      await holder.query('select id from document where id = $1 for update', [X]);
      const sharing = share('adult', sharedOne, { document_ids: [B, X, A] });
      await lockWaiters(admin, 1);
      // Meanwhile A and B go into the other collection, held in id order.
      const adding = call('owner', 'POST', `/api/v1/collections/${other}/items`, {
        document_ids: [A, B],
      });
      await lockWaiters(admin, 2);
      await holder.query('rollback');
      const [s, a] = await Promise.all([sharing, adding]);
      expect(s.statusCode, s.body).toBe(201);
      expect(a.statusCode, a.body).toBe(200);
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
      await admin.end();
    }
  });

  const endings: Array<[string, (id: string) => Promise<LightMyRequestResponse>, number]> = [
    ['deleted', (id) => call('owner', 'DELETE', `/api/v1/collections/${id}`), 204],
    [
      'made Only me',
      (id) => call('owner', 'PATCH', `/api/v1/collections/${id}`, { audience: 'only_me' }),
      200,
    ],
  ];
  for (const [what, end, answer] of endings) {
    it(`an Open as its collection is ${what} is never a deadlock (third review)`, async () => {
      await fresh('adult', true);
      await fresh('owner', true);
      const id = await collection('owner', `Ending as it opens: ${what}`, 'everyone', [docs.lease]);
      const link = await shared('adult', id, { document_ids: [docs.lease] });
      await opened(link.link_token);
      const admin = createPool(h.adminUrl, 3);
      const holder = await admin.connect();
      try {
        // Its session run out, so the next Open — its link counted, and held
        // — stops to clear it, where it is held here a moment.
        await admin.query(
          `update share_session set expires_at = now() - interval '1 minute' where share_id = $1`,
          [link.share.id],
        );
        await holder.query('begin');
        await holder.query('select id from share_session where share_id = $1 for update', [
          link.share.id,
        ]);
        const opening = h.app.inject({
          method: 'POST',
          url: '/api/v1/shared/unlock',
          payload: { token: link.link_token },
          ...peer(),
        });
        await lockWaiters(admin, 1);
        // Meanwhile the collection is ended: it waits on the link, not on
        // the log the Open is about to write to.
        const ending = end(id);
        await lockWaiters(admin, 2);
        await holder.query('rollback');
        const [o, e] = await Promise.all([opening, ending]);
        expect(e.statusCode, `${what}: ${e.body}`).toBe(answer);
        expect(o.statusCode, `${what}: ${o.body}`).toBe(200);
        // And the link ended with it.
        expect(code(await preview(link.link_token)), what).toBe('link_not_valid');
      } finally {
        await holder.query('rollback').catch(() => undefined);
        holder.release();
        await admin.end();
      }
    });
  }

  it('what a link may write is said in one place each, for a later release to add to (third review, for 5.20)', async () => {
    await fresh('owner', true);
    const hh = t.owner.household_id;
    // What the rule and the trigger ask: 0042's, and 5.20's code sent, which
    // 0043 adds by redefining the two alone (F520-01) — with where the code
    // went, masked, its line's alone.
    const said = await withSystem(h.db, hh, async (trx) => {
      const r = await sql<{
        actions: string[];
        keys: string[];
        code: string[];
        none: string[];
      }>`select app_link_audit_actions() as actions,
                app_link_line_keys('share.downloaded') as keys,
                app_link_line_keys('share.code_sent') as code,
                app_link_line_keys('share.created') as none`.execute(trx);
      return r.rows[0];
    });
    expect(said).toEqual({
      actions: [
        'share.opened',
        'share.viewed',
        'share.downloaded',
        'share.locked',
        'share.code_sent',
      ],
      keys: ['share_id', 'user_agent'],
      code: ['share_id', 'user_agent', 'to'],
      // The same for any action: one a link may not write is the rule's to refuse.
      none: ['share_id', 'user_agent'],
    });
    // Redefined as 0042 defined them: stable, parallel safe, its search_path,
    // no owner's rights, and the application's to call.
    const defined = await withSystem(
      h.db,
      hh,
      async (trx) =>
        (
          await sql<{
            name: string;
            volatility: string;
            parallel: string;
            definer: boolean;
            config: string[];
            granted: boolean;
          }>`select p.proname as name, p.provolatile as volatility, p.proparallel as parallel,
                  p.prosecdef as definer, p.proconfig as config,
                  has_function_privilege('fdv_app', p.oid, 'execute') as granted
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and p.proname in ('app_link_audit_actions', 'app_link_line_keys')
            order by 1`.execute(trx)
        ).rows,
    );
    expect(defined).toEqual(
      ['app_link_audit_actions', 'app_link_line_keys'].map((name) => ({
        name,
        volatility: 's',
        parallel: 's',
        definer: false,
        config: ['search_path=pg_catalog, public, pg_temp'],
        granted: true,
      })),
    );
    // And the rule itself is 0042's, not restated: its window ends a minute
    // ahead, and a lock is said only once it has happened.
    const rule = await withSystem(
      h.db,
      hh,
      async (trx) =>
        (
          await sql<{
            rule: string;
          }>`select pg_get_expr(polwithcheck, polrelid) as rule from pg_policy
            where polname = 'audit_event_link_insert'`.execute(trx)
        ).rows[0]?.rule,
    );
    expect(rule).toContain('app_link_audit_actions()');
    expect(rule).toContain('app_link_locked()');
    expect(rule).toMatch(/'00:01:00'::interval/);
    const link = await shared('owner', family, {
      document_ids: [docs.lease],
      recipient_label: 'the bank',
    });
    const tries = linkLine(link);
    for (const action of ['share.opened', 'share.viewed', 'share.downloaded']) {
      await expect(tries({ action }), action).rejects.toThrow(/written, and undone/);
    }
    await expect(
      tries({ detail: { share_id: link.share.id, user_agent: 'Firefox' } }),
      'with its browser',
    ).rejects.toThrow(/written, and undone/);
    for (const [what, over] of [
      ['an action a link does not write', { action: 'share.created' }],
      ['another action', { action: 'document.deleted' }],
    ] as const) {
      await expect(tries(over), what).rejects.toThrow(/row-level security/);
    }
    for (const [what, over] of [
      ['a browser that is not a string', { detail: { share_id: link.share.id, user_agent: 42 } }],
      ['another key', { detail: { share_id: link.share.id, to: 'a***@example.test' } }],
      ['no share', { detail: { user_agent: 'Firefox' } }],
    ] as const) {
      await expect(tries(over), what).rejects.toThrow(/says only what a line of its kind may say/);
    }

    // A later release adds an action, and a key for it, by redefining the
    // two alone — the rule and the trigger unchanged, as 0043 did for a code
    // sent. (Tried here in a transaction that is rolled back, as the
    // application's role, with an action nobody writes yet.)
    const admin = createPool(h.adminUrl, 1);
    const c = await admin.connect();
    try {
      await c.query('begin');
      await c.query(`create or replace function app_link_audit_actions() returns text[]
                       language sql stable parallel safe set search_path = pg_catalog, public, pg_temp as
                       $$ select array['share.opened', 'share.viewed', 'share.downloaded',
                                       'share.locked', 'share.code_sent', 'share.later']::text[] $$`);
      await c.query(`create or replace function app_link_line_keys(p_action text) returns text[]
                       language sql stable parallel safe set search_path = pg_catalog, public, pg_temp as
                       $$ select case p_action
                                   when 'share.code_sent' then array['share_id', 'user_agent', 'to']::text[]
                                   when 'share.later' then array['share_id', 'user_agent', 'more']::text[]
                                   else array['share_id', 'user_agent']::text[] end $$`);
      await c.query('set local role fdv_app_test');
      await c.query(
        `select set_config('app.household_id', $1, true), set_config('app.actor', 'link', true),
                set_config('app.share_id', $2, true)`,
        [hh, link.share.id],
      );
      const head = (
        await c.query<{ hash: Buffer | null; at: Date }>(
          `select audit_chain_head($1::uuid) as hash,
                  date_trunc('milliseconds', clock_timestamp()) as at`,
          [hh],
        )
      ).rows[0] as { hash: Buffer | null; at: Date };
      const line = {
        household_id: hh,
        actor_account_id: null,
        actor_label: 'shared link (the bank)',
        action: 'share.later',
        object_type: 'collection',
        object_id: family,
        detail: { share_id: link.share.id, more: 'said by a later release' },
        at: head.at,
        prev_hash: head.hash,
      };
      await c.query(
        `insert into audit_event (household_id, actor_label, action, object_type, object_id,
                                  detail, at, prev_hash, hash)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          hh,
          line.actor_label,
          line.action,
          line.object_type,
          line.object_id,
          JSON.stringify(line.detail),
          line.at,
          line.prev_hash,
          computeHash(line),
        ],
      );
    } finally {
      await c.query('rollback');
      c.release();
      await admin.end();
    }
    // Rolled back: as it was.
    await expect(tries({ action: 'share.later' })).rejects.toThrow(/row-level security/);
  });

  // ------------------------------------ a request in a session, as its link ends

  /**
   * A collection's link, to view or to download, the adult's, opened: in
   * use. Or, `of` a document, the document's own link, the owner's.
   */
  const inUse = async (
    perm: 'view' | 'download',
    name: string,
    of: 'collection' | 'document' = 'collection',
  ) => {
    const hh = t.owner.household_id;
    const lease = await make('owner', `${name}: the lease`);
    const id = await collection('owner', name, 'everyone', [lease]);
    await fresh('adult', true);
    const link =
      of === 'collection'
        ? await shared('adult', id, { document_ids: [lease], permission: perm })
        : json<CreatedShare>(
            await call('owner', 'POST', `/api/v1/documents/${lease}/share`, { permission: perm }),
          );
    if (perm === 'view') {
      // A page drawn for it (nowhere in storage: it answers "being drawn").
      await withSystem(h.db, hh, async (trx) => {
        const v = await trx
          .selectFrom('document_version')
          .select('id')
          .where('document_id', '=', lease)
          .orderBy('version_no', 'desc')
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('share_page')
          .values({
            household_id: hh,
            share_id: link.share.id,
            permission: 'view',
            document_id: lease,
            version_id: v.id,
            n: 1,
            storage_key: `nowhere/${link.share.id}/1`,
          })
          .execute();
      });
    }
    const { cookie } = await opened(link.link_token);
    const use = () => (perm === 'view' ? page(cookie, lease, 1) : content(cookie, lease));
    return { id, link, lease, cookie, use };
  };
  type Ending = 'deleted' | 'made Only me' | 'taken back';
  const ending = (how: Ending, collectionId: string, shareId: string) =>
    how === 'deleted'
      ? call('owner', 'DELETE', `/api/v1/collections/${collectionId}`)
      : how === 'made Only me'
        ? call('owner', 'PATCH', `/api/v1/collections/${collectionId}`, { audience: 'only_me' })
        : call('owner', 'DELETE', `/api/v1/shares/${shareId}`);
  const endedWith: Record<Ending, number> = {
    deleted: 204,
    'made Only me': 200,
    'taken back': 204,
  };
  const deadlocksSoFar = async (admin: ReturnType<typeof createPool>) => {
    const dbName = new URL(h.adminUrl).pathname.slice(1);
    return (
      await admin.query<{ n: number }>(
        'select deadlocks::int as n from pg_stat_database where datname = $1',
        [dbName],
      )
    ).rows[0]?.n as number;
  };
  const revoked = async (shareId: string) =>
    (
      await withSystem(h.db, t.owner.household_id, (trx) =>
        trx
          .selectFrom('share_link')
          .select('revoked_at')
          .where('id', '=', shareId)
          .executeTakeFirstOrThrow(),
      )
    ).revoked_at !== null;
  const cases: Array<[string, 'view' | 'download', Ending, 'collection' | 'document']> = [
    ['a first look at a page', 'view', 'deleted', 'collection'],
    ['a first look at a page', 'view', 'made Only me', 'collection'],
    ['a first download', 'download', 'deleted', 'collection'],
    ['a first download', 'download', 'made Only me', 'collection'],
    ['a first download', 'download', 'taken back', 'collection'],
    // A document's own link, taken back as 5.18 takes links back: the rule
    // would let its line about its own document through; its count finds
    // the link gone first.
    ['a first download of a document’s link', 'download', 'taken back', 'document'],
    // And a document's view link: its line about its own document is let
    // through, and the request then finds the file's key gone (the fifth
    // review: a 500 until inSession asked its link again).
    ['a first look at a page of a document’s link', 'view', 'taken back', 'document'],
  ];

  for (const [what, perm, how, of] of cases) {
    it(`${what}, held up in its session as its link is ${how}, is never a deadlock (fourth review)`, async () => {
      await fresh('owner', true);
      const { id, link, cookie, lease, use } = await inUse(perm, `Held up: ${what}, ${how}`, of);
      const admin = createPool(h.adminUrl, 3);
      const holder = await admin.connect();
      const before = await deadlocksSoFar(admin);
      try {
        // The document held a moment (as an edit of it would): the request
        // stops there, its session row already held.
        await holder.query('begin');
        await holder.query('select id from document where id = $1 for update', [lease]);
        const using = use();
        await lockWaiters(admin, 1);
        // The link ends meanwhile, waiting on nothing the request holds.
        const ended = ending(how, id, link.share.id);
        const first = await Promise.race([
          ended.then(() => 'ended' as const),
          new Promise<'waiting'>((res) => setTimeout(() => res('waiting'), 5_000)),
        ]);
        await holder.query('rollback');
        const [u, e] = await Promise.all([using, ended]);
        expect(first, `${what}, ${how}: the ending waited on the request`).toBe('ended');
        expect(e.statusCode, e.body).toBe(endedWith[how]);
        // The request finds its link gone as it goes on: refused as such,
        // and nothing counted.
        expect(u.statusCode, u.body).toBe(404);
        expect(code(u)).toBe('link_not_valid');
        expect(await revoked(link.share.id)).toBe(true);
        // Its session, passed over by the ending, went with that answer (the
        // fifth review), as a session found on a gone link always has: a
        // later request of it finds none.
        const left = await withSystem(h.db, t.owner.household_id, (trx) =>
          trx
            .selectFrom('share_session')
            .select('id')
            .where('share_id', '=', link.share.id)
            .execute(),
        );
        expect(left).toEqual([]);
        expect(code(await content(cookie, lease))).toBe('share_session_ended');
        const used = await withSystem(h.db, t.owner.household_id, (trx) =>
          trx
            .selectFrom('share_link')
            .select('downloads_used')
            .where('id', '=', link.share.id)
            .executeTakeFirstOrThrow(),
        );
        expect(used.downloads_used).toBe(0);
        await new Promise((res) => setTimeout(res, 1500));
        expect(await deadlocksSoFar(admin)).toBe(before);
      } finally {
        await holder.query('rollback').catch(() => undefined);
        holder.release();
        await admin.end();
      }
    });
  }

  /** Waits until a statement naming `text` waits on a lock. */
  const waitingOn = async (admin: ReturnType<typeof createPool>, text: string) => {
    const dbName = new URL(h.adminUrl).pathname.slice(1);
    for (let i = 0; i < 200; i += 1) {
      const r = await admin.query<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity
          where datname = $1 and wait_event_type = 'Lock' and query like $2`,
        [dbName, `%${text}%`],
      );
      if ((r.rows[0]?.n ?? 0) >= 1) return;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error(`nothing naming ${text} waits on a lock`);
  };
  const holdTheLog = async (c: { query: (q: string, v?: unknown[]) => Promise<unknown> }) => {
    await c.query('begin');
    await c.query(`select pg_advisory_xact_lock(hashtext('audit:' || $1::uuid::text))`, [
      t.owner.household_id,
    ]);
  };

  it('a first download that waits on its link as the link is taken back is refused, and not counted (fourth review)', async () => {
    await fresh('owner', true);
    const { link, lease, use } = await inUse('download', 'Counted as it ends', 'document');
    const admin = createPool(h.adminUrl, 4);
    const doc = await admin.connect();
    const log = await admin.connect();
    try {
      // The request held up in its session: the document held a moment.
      await doc.query('begin');
      await doc.query('select id from document where id = $1 for update', [lease]);
      const using = use();
      await lockWaiters(admin, 1);
      // The link taken back, and held up at the log with its row held.
      await holdTheLog(log);
      const takingBack = call('owner', 'DELETE', `/api/v1/shares/${link.share.id}`);
      await lockWaiters(admin, 2);
      // The request goes on, to count its download: it waits on the link.
      await doc.query('rollback');
      await waitingOn(admin, 'downloads_used');
      await log.query('rollback');
      const [u, r] = await Promise.all([using, takingBack]);
      expect(r.statusCode, r.body).toBe(204);
      expect(u.statusCode, u.body).toBe(404);
      expect(code(u)).toBe('link_not_valid');
      const now = await withSystem(h.db, t.owner.household_id, (trx) =>
        trx
          .selectFrom('share_link')
          .select('downloads_used')
          .where('id', '=', link.share.id)
          .executeTakeFirstOrThrow(),
      );
      expect(now.downloads_used).toBe(0);
    } finally {
      await doc.query('rollback').catch(() => undefined);
      await log.query('rollback').catch(() => undefined);
      doc.release();
      log.release();
      await admin.end();
    }
  });

  it('a request that comes as its link is being taken back is refused as gone, not a fault (fourth review)', async () => {
    await fresh('owner', true);
    const { link, use } = await inUse('download', 'Arriving as it ends', 'document');
    const admin = createPool(h.adminUrl, 3);
    const log = await admin.connect();
    try {
      // Taken back, its sessions removed, and held up at the log.
      await holdTheLog(log);
      const takingBack = call('owner', 'DELETE', `/api/v1/shares/${link.share.id}`);
      await lockWaiters(admin, 1);
      // A request of the session then waits on its row, being removed.
      const using = use();
      await lockWaiters(admin, 2);
      await log.query('rollback');
      const [u, r] = await Promise.all([using, takingBack]);
      expect(r.statusCode, r.body).toBe(204);
      expect(u.statusCode, u.body).toBe(404);
      expect(code(u)).toBe('link_not_valid');
    } finally {
      await log.query('rollback').catch(() => undefined);
      log.release();
      await admin.end();
    }
  });

  it('a first look or download racing its link’s end is never a deadlock, whichever comes first (fourth review)', async () => {
    await fresh('owner', true);
    const admin = createPool(h.adminUrl, 1);
    const before = await deadlocksSoFar(admin);
    try {
      for (const [what, perm, how, of] of cases) {
        // A few tries each, the ending a little before or after the request.
        for (const offset of [-2, 0, 2, 5]) {
          const { id, link, use } = await inUse(perm, `Racing: ${what}, ${how}, ${offset}`, of);
          const pause = (ms: number) => new Promise((res) => setTimeout(res, ms));
          const [u, e] = await Promise.all([
            (async () => {
              if (offset < 0) await pause(-offset);
              return use();
            })(),
            (async () => {
              if (offset > 0) await pause(offset);
              return ending(how, id, link.share.id);
            })(),
          ]);
          const said = `${what}, ${how}, ${offset} ms`;
          expect(e.statusCode, `${said}: ${e.body}`).toBe(endedWith[how]);
          // Done before the link ended, its own answer (the file; for a
          // page not yet drawn, "being drawn"); otherwise the link's, gone —
          // and nothing else (the fifth review).
          const answered =
            u.statusCode === 200 ? 'done' : ((code(u) as string | undefined) ?? `${u.statusCode}`);
          expect(
            [perm === 'download' ? 'done' : 'preview_pending', 'link_not_valid'],
            `${said}: ${u.statusCode} ${u.body}`,
          ).toContain(answered);
          expect(await revoked(link.share.id), said).toBe(true);
        }
      }
      await new Promise((res) => setTimeout(res, 1500));
      expect(await deadlocksSoFar(admin)).toBe(before);
    } finally {
      await admin.end();
    }
  }, 120_000);

  /**
   * Holds the next call of a method, wherever it is made, until let go: a
   * request stopped part-way, its session row held and its link's checks
   * behind it.
   */
  const gateOnce = (target: object, name: string) => {
    const proto = target as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const original = proto[name] as (...args: unknown[]) => Promise<unknown>;
    let release!: () => void;
    const opened = new Promise<void>((res) => (release = res));
    let reached!: () => void;
    const arrived = new Promise<void>((res) => (reached = res));
    let first = true;
    const spy = vi.spyOn(proto, name).mockImplementation(async function (
      this: unknown,
      ...args: unknown[]
    ) {
      if (first) {
        first = false;
        reached();
        await opened;
      }
      return original.apply(this, args);
    });
    return { arrived, release, restore: () => spy.mockRestore() };
  };
  const sessionsOf = (shareId: string) =>
    withSystem(h.db, t.owner.household_id, (trx) =>
      trx.selectFrom('share_session').select('id').where('share_id', '=', shareId).execute(),
    );

  const secondDownloads: Array<['collection' | 'document', Ending]> = [
    ['document', 'taken back'],
    ['collection', 'deleted'],
  ];
  for (const [of, how] of secondDownloads) {
    it(`a second download under way as its ${of}’s link is ${how} is answered link_not_valid, not a fault (fifth review)`, async () => {
      await fresh('owner', true);
      const { id, link, use } = await inUse('download', `A second download: ${of}, ${how}`, of);
      expect((await use()).statusCode).toBe(200);
      // The second held where it asks for the file's key: after every
      // check, its session row held.
      const gate = gateOnce(ScopeKeys.prototype, 'unwrapById');
      try {
        const using = use();
        await gate.arrived;
        // The link ends meanwhile, not waiting for it.
        const e = await ending(how, id, link.share.id);
        expect(e.statusCode, e.body).toBe(endedWith[how]);
        gate.release();
        const u = await using;
        expect(u.statusCode, u.body).toBe(404);
        expect(code(u)).toBe('link_not_valid');
        expect(await sessionsOf(link.share.id)).toEqual([]);
      } finally {
        gate.release();
        gate.restore();
      }
    });
  }

  it('the list of what a session gives, under way as its link is taken back, is answered link_not_valid (fifth review)', async () => {
    await fresh('owner', true);
    const { link, cookie } = await inUse('download', 'The list as it ends');
    // Held as it starts to say who sent it: its checks behind it.
    const gate = gateOnce(ShareService.prototype, 'from');
    try {
      const listing = items(cookie);
      await gate.arrived;
      const e = await ending('taken back', '', link.share.id);
      expect(e.statusCode, e.body).toBe(204);
      gate.release();
      const u = await listing;
      // Not an empty list from nobody: the link is gone.
      expect(u.statusCode, u.body).toBe(404);
      expect(code(u)).toBe('link_not_valid');
      expect(await sessionsOf(link.share.id)).toEqual([]);
    } finally {
      gate.release();
      gate.restore();
    }
  });

  it('a following link takes as many left-out documents as a household holds, in any number of rows (third review)', async () => {
    await fresh('adult', true);
    const hh = t.owner.household_id;
    // More than the old cap, of documents that are not there: dropped.
    const id = await collection('owner', 'Many left out', 'everyone', [docs.lease]);
    const many = await share('adult', id, {
      document_ids: [docs.lease],
      follow_collection: true,
      left_out_ids: Array.from({ length: 5001 }, () => randomUUID()),
    });
    expect(many.statusCode, many.body).toBe(201);
    // A household's worth, and a thousand in the collection besides: more
    // snapshot rows than one statement could carry.
    const bulk = (
      await withSystem(h.db, hh, (trx) =>
        sql<{ id: string }>`insert into document (household_id, title, visibility)
                            select ${hh}::uuid, 'Bulk ' || g, 'household'
                              from generate_series(1, 11000) g
                            returning id`.execute(trx),
      )
    ).rows.map((r) => r.id);
    const big = await collection('owner', 'A big collection', 'everyone', []);
    await withSystem(h.db, hh, (trx) =>
      sql`insert into doc_collection_item (collection_id, document_id, household_id, position)
          select ${big}::uuid, d, ${hh}::uuid, n
            from unnest(${bulk.slice(0, 1000)}::uuid[]) with ordinality as u(d, n)`.execute(trx),
    );
    await fresh('adult', true);
    const link = await shared('adult', big, {
      document_ids: [],
      follow_collection: true,
      left_out_ids: bulk.slice(1000),
    });
    const counted = await withSystem(h.db, hh, (trx) =>
      trx
        .selectFrom('share_link_item')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('share_id', '=', link.share.id)
        .where('kind', '=', 'left_out')
        .executeTakeFirstOrThrow(),
    );
    expect(Number(counted.n)).toBe(11000);
  }, 120_000);
});
