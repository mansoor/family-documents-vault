import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { EncryptStream, EnvKeyProvider, ScopeKeys, unwrapKey } from '@fdv/crypto';
import { createPool, verifyAuditChain, withScope, withSystem, type Db } from '@fdv/db';
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { PAGES_RETRY_MS, type CreatedShare, type ShareView } from '../documents/shares.js';
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
    h = await createHarness();
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
    // Nothing in what it is given counts anything.
    expect(Object.keys(shown).sort()).toEqual(
      [
        'collection_name',
        'document_title',
        'expires_at',
        'household_name',
        'kind',
        'opens_left',
        'permission',
        'protection',
        'shared_by',
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
    // The teen reads it in the log, as a teen reads the collection.
    expect(await activity('teen')).toContain('Alex made a link to the collection “School trip”');
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
      ).rejects.toThrow(/row-level security/);
    } finally {
      await admin.end();
    }
  });
});
