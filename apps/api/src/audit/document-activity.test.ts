import { randomUUID } from 'node:crypto';
import { appendAudit, createPool, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { ActivityLine, CollectionDetail, DocumentView } from '@fdv/shared';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import type { CreatedShare } from '../documents/shares.js';
import { createHarness, type Harness } from '../test-harness.js';

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

type Page = { items: ActivityLine[]; next: number | null };

/**
 * One document's activity (0.9.0, DA; the owner's ask of 16 Nov 2026):
 * GET /documents/{id}/activity gives each reader exactly the lines the
 * whole log gives them about that document — its own, its own links', and
 * those of every collection's link that gave it, removed ones too — and
 * nothing of a document they cannot see.
 */
describe.skipIf(!testAdminUrl())("one document's activity (DA)", () => {
  let h: Harness;
  let owner: Tokens;
  let adult: Tokens;
  let teen: Tokens;
  let viewer: Tokens;
  let passport: string;
  let other: string;
  /** Links that gave the passport: its own, a collection's, a removed collection's. */
  const gave: string[] = [];
  /** A collection's link that never gave it. */
  let elsewhere: string;
  const PASSWORD = 'a long enough password 0123';

  const call = (who: Tokens, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
    h.app.inject({ method, url, headers: h.as(who), ...(payload ? { payload } : {}) });
  const admin = async <T extends object>(q: string, params: unknown[] = []) => {
    const pool = createPool(h.adminUrl, 1);
    try {
      return (await pool.query<T>(q, params)).rows;
    } finally {
      await pool.end();
    }
  };
  /** Every page of a list, read with `before` until `next` is null. */
  const everyPage = async (who: Tokens, url: string, limit = 100) => {
    const all: ActivityLine[] = [];
    let before: number | null = null;
    for (let i = 0; i < 200; i++) {
      const sep = url.includes('?') ? '&' : '?';
      const r = await call(
        who,
        'GET',
        `${url}${sep}limit=${limit}${before ? `&before=${before}` : ''}`,
      );
      expect(r.statusCode, r.body).toBe(200);
      const page = r.json<Page>();
      all.push(...page.items);
      if (page.next === null) return all;
      before = page.next;
    }
    throw new Error('never ended');
  };
  const activityOf = (who: Tokens, id: string, limit?: number) =>
    everyPage(who, `/api/v1/documents/${id}/activity`, limit);
  /** As the whole log gives `who` them: the lines written about the passport and its links. */
  const fromTheWholeLog = async (who: Tokens) => {
    const written = await admin<{ id: string }>(
      `select id from audit_event
        where household_id = $1
          and ((object_type = 'document' and object_id = $2)
               or (object_type = 'collection' and detail->>'share_id' = any($3::text[])))`,
      [owner.household_id, passport, gave],
    );
    const ids = new Set(written.map((w) => Number(w.id)));
    return (await everyPage(who, '/api/v1/audit')).filter((l) => ids.has(l.id));
  };
  const said = (lines: ActivityLine[]) => lines.map((l) => `${l.id} ${l.text}`);

  const make = async (title: string, who: Tokens = owner, visibility = 'household') => {
    const created = await call(who, 'POST', '/api/v1/documents', {
      title,
      type_key: 'utility_bill',
      visibility,
      owner_member_id: who.member_id,
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json<DocumentView>().id;
    const form = new FormData();
    form.append('file', PDF, { filename: `${title}.pdf`, contentType: 'application/pdf' });
    const up = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${id}/versions`,
      headers: { ...h.as(who), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    expect(up.statusCode, up.body).toBeLessThan(300);
    return id;
  };
  /** What the other end of a link did, as the link writes it (ShareService.recordLine). */
  const through = (
    link: string,
    label: string,
    action: string,
    object: { type: 'document' | 'collection'; id: string },
  ) =>
    withSystem(h.db, owner.household_id, (trx) =>
      appendAudit(trx, {
        householdId: owner.household_id,
        actorLabel: `shared link (${label})`,
        action,
        objectType: object.type,
        objectId: object.id,
        detail: { share_id: link, user_agent: null },
      }),
    );
  /** A collection with these documents, and a link to it for `label`: opened, downloaded, taken back. */
  const collectionLink = async (name: string, docs: string[], label: string) => {
    const c = await call(owner, 'POST', '/api/v1/collections', { name, audience: 'everyone' });
    expect(c.statusCode, c.body).toBe(201);
    const id = c.json<CollectionDetail>().id;
    const put = await call(owner, 'POST', `/api/v1/collections/${id}/items`, {
      document_ids: docs,
    });
    expect(put.statusCode, put.body).toBe(200);
    const s = await call(owner, 'POST', `/api/v1/collections/${id}/shares`, {
      document_ids: docs,
      recipient_label: label,
    });
    expect(s.statusCode, s.body).toBe(201);
    const link = s.json<CreatedShare>().share.id;
    await through(link, label, 'share.opened', { type: 'collection', id });
    await through(link, label, 'share.downloaded', { type: 'collection', id });
    for (const doc of docs) {
      await through(link, label, 'share.downloaded', { type: 'document', id: doc });
    }
    expect((await call(owner, 'DELETE', `/api/v1/shares/${link}`)).statusCode).toBe(204);
    return link;
  };

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    owner = await h.setup();
    adult = await h.join(owner, {
      name: 'Ada',
      email: 'ada-da@example.test',
      role: 'adult',
      password: PASSWORD,
    });
    teen = await h.join(owner, {
      name: 'Tara',
      email: 'tara-da@example.test',
      role: 'teen',
      password: PASSWORD,
    });
    viewer = await h.join(owner, {
      name: 'Vic',
      email: 'vic-da@example.test',
      role: 'viewer',
      password: PASSWORD,
    });
    await withSystem(h.db, owner.household_id, (trx) =>
      trx.updateTable('session').set({ verified_at: new Date() }).execute(),
    );
    passport = await make("Richa's visa");
    other = await make('Water bill');

    // Its own link: made, opened, downloaded from, taken back.
    const own = await call(owner, 'POST', `/api/v1/documents/${passport}/share`, {
      recipient_label: 'the embassy',
    });
    expect(own.statusCode, own.body).toBe(201);
    const ownLink = own.json<CreatedShare>().share.id;
    await through(ownLink, 'the embassy', 'share.opened', { type: 'document', id: passport });
    await through(ownLink, 'the embassy', 'share.downloaded', { type: 'document', id: passport });
    expect((await call(owner, 'DELETE', `/api/v1/shares/${ownLink}`)).statusCode).toBe(204);
    gave.push(ownLink);

    // A collection's link that gave it with another.
    gave.push(await collectionLink('Travel', [passport, other], 'the travel agent'));
    // One removed once it had ended (RQ): its tombstone, then no link.
    const removed = await collectionLink('Visa papers', [passport], 'the consulate');
    await admin(
      `with t as (
         insert into share_link_tombstone (id, household_id, created_by, collection_id, document_ids)
         select l.id, l.household_id, l.created_by, l.collection_id,
                array(select i.document_id from share_link_item i
                       where i.share_id = l.id and i.kind in ('ticked', 'followed'))
           from share_link l where l.id = $1 returning id)
       delete from share_link where id in (select id from t)`,
      [removed],
    );
    expect(await admin('select 1 from share_link where id = $1', [removed])).toEqual([]);
    gave.push(removed);
    // And one that never gave it: none of its lines are the passport's.
    elsewhere = await collectionLink('Bills', [other], 'the landlord');

    // Somebody downloaded it, and the other document.
    for (const doc of [passport, other]) {
      const versions = await call(adult, 'GET', `/api/v1/documents/${doc}/versions`);
      const v = versions.json<{ items: Array<{ id: string }> }>().items[0] as { id: string };
      expect((await call(adult, 'GET', `/api/v1/versions/${v.id}/content`)).statusCode).toBe(200);
    }
  }, 120_000);
  afterAll(() => h.close());

  it('gives an owner, an adult and a teen exactly what the whole log gives them about it', async () => {
    for (const who of [owner, adult, teen]) {
      const expected = await fromTheWholeLog(who);
      expect(expected.length).toBeGreaterThan(0);
      expect(said(await activityOf(who, passport))).toEqual(said(expected));
    }
  });

  it('includes its links’ lines — its own, a collection’s, a removed one’s — for whoever knows of them', async () => {
    const owners = (await activityOf(owner, passport)).map((l) => l.text);
    // Its own link: made, opened, downloaded from, taken back.
    expect(owners).toContain("Owner made a link to “Richa's visa” for the embassy");
    expect(owners).toContain("Shared link (the embassy) opened “Richa's visa”");
    // Through a collection's link: what was downloaded of it, and the
    // link's own lines about the collection.
    expect(owners).toContain("Shared link (the travel agent) downloaded “Richa's visa”");
    expect(owners.filter((t) => t.includes('the travel agent')).length).toBeGreaterThan(1);
    // A link removed once it had ended: its lines stay.
    expect(owners.filter((t) => t.includes('the consulate')).length).toBeGreaterThan(1);
    // Nothing of a link that never gave it, nor of the other document.
    expect(owners.join(' ')).not.toContain('the landlord');
    expect(owners.join(' ')).not.toContain('Water bill');
    const ids = new Set(
      (
        await admin<{ id: string }>(`select id from audit_event where detail->>'share_id' = $1`, [
          elsewhere,
        ])
      ).map((r) => Number(r.id)),
    );
    expect((await activityOf(owner, passport)).some((l) => ids.has(l.id))).toBe(false);

    // An adult who may share and sees everything those links gave: the same.
    expect((await activityOf(adult, passport)).map((l) => l.text)).toEqual(owners);
    // A teen is told of no collection's link, nor what went through one —
    // though of the document's own link, as the whole log tells them.
    const teens = (await activityOf(teen, passport)).map((l) => l.text);
    expect(teens.join(' ')).not.toContain('the travel agent');
    expect(teens.join(' ')).not.toContain('the consulate');
    expect(teens).toContain("Shared link (the embassy) opened “Richa's visa”");
    expect(teens).toContain("Ada downloaded “Richa's visa”");
  });

  it('pages with before and limit, as the whole log does', async () => {
    const whole = await activityOf(owner, passport);
    expect(whole.length).toBeGreaterThan(4);
    const first = await call(owner, 'GET', `/api/v1/documents/${passport}/activity?limit=2`);
    const page = first.json<Page>();
    expect(page.items).toHaveLength(2);
    expect(page.next).toBe(page.items[1]?.id);
    expect(said(await activityOf(owner, passport, 2))).toEqual(said(whole));
    expect(said(await activityOf(owner, passport, 3))).toEqual(said(whole));
    // Newest first, never one twice.
    const ids = whole.map((l) => l.id);
    expect([...ids].sort((a, b) => b - a)).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is nobody’s of a document they cannot see, nor any viewer’s', async () => {
    const omar = await h.join(owner, {
      name: 'Omar',
      email: 'omar-da@example.test',
      role: 'adult',
      password: PASSWORD,
    });
    const onlyMe = await make('Omar’s letter', omar, 'private');
    expect((await call(omar, 'GET', `/api/v1/documents/${onlyMe}/activity`)).statusCode).toBe(200);
    for (const who of [owner, adult, teen]) {
      const r = await call(who, 'GET', `/api/v1/documents/${onlyMe}/activity`);
      expect(r.statusCode).toBe(404);
      expect(r.json<{ error: { code: string } }>().error.code).toBe('not_found');
      // As the document itself is answered.
      expect((await call(who, 'GET', `/api/v1/documents/${onlyMe}`)).statusCode).toBe(404);
    }
    // Adults only, for a teen.
    const forAdults = await make('Solicitor’s letter', owner, 'adults');
    expect((await call(teen, 'GET', `/api/v1/documents/${forAdults}/activity`)).statusCode).toBe(
      404,
    );
    expect((await call(adult, 'GET', `/api/v1/documents/${forAdults}/activity`)).statusCode).toBe(
      200,
    );
    // A viewer reads no log at all.
    const v = await call(viewer, 'GET', `/api/v1/documents/${passport}/activity`);
    expect(v.statusCode).toBe(403);
    // Not there at all; and not an id.
    expect(
      (await call(owner, 'GET', `/api/v1/documents/${randomUUID()}/activity`)).statusCode,
    ).toBe(404);
    expect((await call(owner, 'GET', '/api/v1/documents/nope/activity')).statusCode).toBe(422);
  });

  it('keeps the history of one in the Trash, as its page does', async () => {
    const binned = await make('Old gas bill');
    expect((await call(owner, 'DELETE', `/api/v1/documents/${binned}`)).statusCode).toBe(204);
    const page = await call(owner, 'GET', `/api/v1/documents/${binned}`);
    const r = await call(owner, 'GET', `/api/v1/documents/${binned}/activity`);
    expect(r.statusCode).toBe(page.statusCode);
    expect(
      r.json<Page>().items.some((l) => l.text === 'Owner moved “Old gas bill” to the Trash'),
    ).toBe(true);
  });

  // ------------------------------------------------- the review round

  /** Every page as `who` reads it with `limit`, each page as answered. */
  const pages = async (who: Tokens, id: string, limit: number) => {
    const all: Page[] = [];
    let before: number | null = null;
    for (let i = 0; i < 200; i++) {
      const r = await call(
        who,
        'GET',
        `/api/v1/documents/${id}/activity?limit=${limit}${before ? `&before=${before}` : ''}`,
      );
      expect(r.statusCode, r.body).toBe(200);
      const page = r.json<Page>();
      all.push(page);
      if (page.next === null) return all;
      before = page.next;
    }
    throw new Error('never ended');
  };
  /** The ids of a link's lines of one action, oldest first. */
  const linesOf = async (link: string, action: string) =>
    (
      await admin<{ id: string }>(
        `select id from audit_event where detail->>'share_id' = $1 and action = $2 order by id`,
        [link, action],
      )
    ).map((r) => Number(r.id));
  const idsOf = async (who: Tokens, doc: string) =>
    new Set((await activityOf(who, doc)).map((l) => l.id));
  const verified = () =>
    withSystem(h.db, owner.household_id, (trx) =>
      trx.updateTable('session').set({ verified_at: new Date() }).execute(),
    );

  it('never gives a teen a page with nothing on it, nor a cursor for a line kept from them', async () => {
    // What went through the adults' collections' links about it is kept
    // from a teen, between lines they are shown.
    const hidden = (
      await admin<{ id: string }>(
        `select id from audit_event
          where object_type = 'document' and object_id = $1
            and detail->>'share_id' = any($2::text[])`,
        [passport, gave.slice(1)],
      )
    ).map((r) => Number(r.id));
    expect(hidden.length).toBeGreaterThan(0);
    const theirs = await activityOf(teen, passport);
    const seen = new Set(theirs.map((l) => l.id));
    for (const id of hidden) expect(seen.has(id)).toBe(false);
    const read = await pages(teen, passport, 1);
    for (const page of read) {
      if (page.next === null) continue;
      expect(page.items).toHaveLength(1);
      expect(page.next).toBe(page.items[0]?.id);
      expect(seen.has(page.next)).toBe(true);
      expect(hidden).not.toContain(page.next);
    }
    expect(said(read.flatMap((p) => p.items))).toEqual(said(theirs));
    // Its last page ends it, with whatever was left: never empty with a cursor.
    expect(read.every((p) => p.items.length > 0 || p.next === null)).toBe(true);
  });

  it("gives a collection's link's lines only while it gave the document: followed in, taken out", async () => {
    await verified();
    const first = await make('Moving quote');
    const later = await make('Removal contract');
    const c = await call(owner, 'POST', '/api/v1/collections', {
      name: 'The move',
      audience: 'everyone',
    });
    const collection = c.json<CollectionDetail>().id;
    await call(owner, 'POST', `/api/v1/collections/${collection}/items`, {
      document_ids: [first],
    });
    const s = await call(owner, 'POST', `/api/v1/collections/${collection}/shares`, {
      document_ids: [first],
      follow_collection: true,
      recipient_label: 'the mover',
    });
    expect(s.statusCode, s.body).toBe(201);
    const link = s.json<CreatedShare>().share.id;
    const opened = () =>
      through(link, 'the mover', 'share.opened', { type: 'collection', id: collection });
    await opened(); // before the later document was in it
    const put = await call(owner, 'POST', `/api/v1/collections/${collection}/items`, {
      document_ids: [later],
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(await linesOf(link, 'share.followed')).toHaveLength(1);
    await opened(); // while it gave both
    const out = await call(owner, 'DELETE', `/api/v1/collections/${collection}/items/${later}`);
    expect(out.statusCode, out.body).toBe(204);
    await opened(); // after the later one was taken out
    const [before, during, after] = await linesOf(link, 'share.opened');
    const [made] = await linesOf(link, 'share.created');

    const laters = await idsOf(owner, later);
    expect(laters.has(during as number)).toBe(true);
    for (const id of [made, before, after]) expect(laters.has(id as number)).toBe(false);
    // Its followed line, as the whole log says it.
    const followed = (await linesOf(link, 'share.followed'))[0] as number;
    expect(laters.has(followed)).toBe(true);
    // The first was ticked as it was made: every one of them.
    const firsts = await idsOf(owner, first);
    for (const id of [made, before, during, after]) expect(firsts.has(id as number)).toBe(true);
    // And the same lines as the whole log gives, of those.
    const whole = new Set((await everyPage(owner, '/api/v1/audit')).map((l) => l.id));
    for (const id of laters) expect(whole.has(id)).toBe(true);
  });

  it("keeps a link's lines up to its leaving the document out, and none after", async () => {
    await verified();
    const health = await make('Blood test results');
    const c = await call(owner, 'POST', '/api/v1/collections', {
      name: 'For the clinic',
      audience: 'everyone',
    });
    const collection = c.json<CollectionDetail>().id;
    await call(owner, 'POST', `/api/v1/collections/${collection}/items`, {
      document_ids: [health],
    });
    const s = await call(owner, 'POST', `/api/v1/collections/${collection}/shares`, {
      document_ids: [health],
      recipient_label: 'the clinic',
    });
    expect(s.statusCode, s.body).toBe(201);
    const link = s.json<CreatedShare>().share.id;
    const opened = () =>
      through(link, 'the clinic', 'share.opened', { type: 'collection', id: collection });
    await opened();
    // Made sensitive, and taken out of the links it went with (H1a).
    const now = await call(owner, 'GET', `/api/v1/documents/${health}`);
    const edited = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/documents/${health}`,
      headers: { ...h.as(owner), 'if-match': now.json<DocumentView>().etag },
      payload: { sensitive: true },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const stopped = await call(owner, 'POST', `/api/v1/documents/${health}/stop-sharing`);
    expect(stopped.statusCode, stopped.body).toBe(200);
    const [leftOut] = await linesOf(link, 'share.left_out');
    expect(leftOut).toBeDefined();
    await opened();
    const [before, after] = await linesOf(link, 'share.opened');
    const [made] = await linesOf(link, 'share.created');
    const ids = await idsOf(owner, health);
    for (const id of [made, before, leftOut]) expect(ids.has(id as number)).toBe(true);
    expect(ids.has(after as number)).toBe(false);
  });

  it("gives none of a link's own lines once it left the document out unsaid, as it was made Only me", async () => {
    await verified();
    const letter = await make('Bank letter');
    const c = await call(owner, 'POST', '/api/v1/collections', {
      name: 'For the bank',
      audience: 'everyone',
    });
    const collection = c.json<CollectionDetail>().id;
    await call(owner, 'POST', `/api/v1/collections/${collection}/items`, {
      document_ids: [letter],
    });
    const s = await call(owner, 'POST', `/api/v1/collections/${collection}/shares`, {
      document_ids: [letter],
      recipient_label: 'the branch',
    });
    expect(s.statusCode, s.body).toBe(201);
    const link = s.json<CreatedShare>().share.id;
    await through(link, 'the branch', 'share.opened', { type: 'collection', id: collection });
    await through(link, 'the branch', 'share.downloaded', { type: 'document', id: letter });
    await verified();
    const made = await call(owner, 'POST', `/api/v1/documents/${letter}/visibility`, {
      visibility: 'private',
      own_links: 'end',
    });
    expect(made.statusCode, made.body).toBe(200);
    const kind = await admin<{ kind: string }>(
      'select kind from share_link_item where share_id = $1 and document_id = $2',
      [link, letter],
    );
    expect(kind).toEqual([{ kind: 'left_out' }]);
    const ids = await idsOf(owner, letter);
    for (const id of [
      ...(await linesOf(link, 'share.created')),
      ...(await linesOf(link, 'share.opened')),
    ]) {
      expect(ids.has(id)).toBe(false);
    }
    // What went through it of the document itself still is.
    for (const id of await linesOf(link, 'share.downloaded')) expect(ids.has(id)).toBe(true);
  });

  it("shows a collection's link emailed by the vault to its maker and an owner, never a teen", async () => {
    await verified();
    const doc = await make('Car insurance');
    const c = await call(adult, 'POST', '/api/v1/collections', {
      name: 'The car',
      audience: 'everyone',
    });
    expect(c.statusCode, c.body).toBe(201);
    const collection = c.json<CollectionDetail>().id;
    await call(adult, 'POST', `/api/v1/collections/${collection}/items`, {
      document_ids: [doc],
    });
    const s = await call(adult, 'POST', `/api/v1/collections/${collection}/shares`, {
      document_ids: [doc],
      recipient_label: 'the garage',
    });
    expect(s.statusCode, s.body).toBe(201);
    const link = s.json<CreatedShare>().share.id;
    const [maker] = await admin<{ account_id: string }>(
      'select account_id from account_household where member_id = $1',
      [adult.member_id],
    );
    // As ShareService.email writes it (shares.ts): about the collection.
    await withSystem(h.db, owner.household_id, (trx) =>
      appendAudit(trx, {
        householdId: owner.household_id,
        actorAccountId: maker?.account_id ?? null,
        action: 'share_link.emailed',
        objectType: 'collection',
        objectId: collection,
        detail: { share_id: link, to: 'g***@example.test' },
      }),
    );
    const [emailed] = await linesOf(link, 'share_link.emailed');
    const text = 'Ada emailed the link to the collection “The car” to g***@example.test';
    for (const who of [adult, owner]) {
      const line = (await everyPage(who, '/api/v1/audit')).find((l) => l.id === emailed);
      expect(line?.text).toBe(text);
      // And in the document's activity, as the link's other lines are.
      expect((await idsOf(who, doc)).has(emailed as number)).toBe(true);
    }
    expect((await everyPage(teen, '/api/v1/audit')).some((l) => l.id === emailed)).toBe(false);
    expect((await idsOf(teen, doc)).has(emailed as number)).toBe(false);
  });
});
