import { randomUUID } from 'node:crypto';
import { createPool, withScope, withSystem, type Db } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  CHECKLIST_NO_LONGER_NEEDED_NOTE,
  CHECKLIST_ONLY_ME_NOTE,
  CHECKLIST_WAS_BANK_NOTE,
  type ChecklistAdded,
  type CollectionChecklist,
  type CollectionDetail,
  type CreatedUploadRequest,
  type DocumentView,
  type Tokens,
} from '@fdv/shared';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreatedShare } from '../documents/shares.js';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * A collection from a checklist (0.9.0, C1), through the API: the owner's
 * own example — a refinance's list for Mansoor and Richa — read, matched
 * as each reader may see, added only as ticked, kept, matched again as the
 * page opens, and asked for where it is missing. Never given to a viewer,
 * nor to a share link.
 */

type Who = 'mansoor' | 'richa' | 'teen' | 'viewer';

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

const OWNERS_LIST = `Documents for Mansoor
W2 for 2025 and 2024
Last 3 pay statements
Last 2 bank statements
Last 2 investment statements

Documents for Richa
Last 3 pay statements
and so on....`;

describe.skipIf(!testAdminUrl())('a collection from a checklist (C1)', () => {
  let h: Harness;
  const t = {} as Record<Who, Tokens>;
  const docs: Record<string, string> = {};
  let refinance = '';

  const json = <T>(r: { json: () => unknown }) => r.json() as T;
  const call = (
    who: Who,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: object,
  ) => h.app.inject({ method, url, headers: h.as(t[who]), ...(payload ? { payload } : {}) });

  /** A document of `who`'s, for `owner` (theirs unless said). */
  const file = async (
    who: Who,
    title: string,
    type_key: string,
    o: {
      issued?: string;
      visibility?: 'household' | 'adults' | 'private';
      owner?: Who;
      extra?: Record<string, unknown>;
    } = {},
  ) => {
    const made = await call(who, 'POST', '/api/v1/documents', {
      title,
      type_key,
      visibility: o.visibility ?? 'adults',
      owner_member_id: t[o.owner ?? who].member_id,
      ...(o.issued ? { issued: { date: o.issued, precision: 'day' } } : {}),
      ...(o.extra ? { extra: o.extra } : {}),
    });
    expect(made.statusCode, made.body).toBe(201);
    return json<DocumentView>(made).id;
  };

  const check = async (who: Who, id: string, body: object) => {
    const r = await call(who, 'POST', `/api/v1/collections/${id}/checklist`, body);
    expect(r.statusCode, r.body).toBe(200);
    return json<CollectionChecklist>(r);
  };
  const ids = (c: CollectionChecklist, n: number, ticked?: boolean) =>
    (c.items[n]?.matches ?? [])
      .filter((m) => ticked === undefined || m.ticked === ticked)
      .map((m) => m.document_id);
  const makeCollection = async (who: Who, name: string, audience: string) => {
    const r = await call(who, 'POST', '/api/v1/collections', { name, audience });
    expect(r.statusCode, r.body).toBe(201);
    return json<CollectionDetail>(r).id;
  };

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    t.mansoor = await h.setup({ display_name: 'Mansoor' });
    t.richa = await h.join(t.mansoor, {
      name: 'Richa',
      email: 'richa@example.test',
      role: 'adult',
    });
    t.teen = await h.join(t.mansoor, { name: 'Zara', email: 'zara@example.test', role: 'teen' });
    t.viewer = await h.join(t.mansoor, {
      name: 'Vic',
      email: 'vic-checklist@example.test',
      role: 'viewer',
    });

    // Mansoor's: two W-2s and a 1099, by their tax years.
    docs.w2025 = await file('mansoor', 'W-2 Acme 2025', 'tax_form', {
      issued: '2026-01-28',
      extra: { tax_year: 2025 },
    });
    docs.w2024 = await file('mansoor', 'W-2 Acme 2024', 'tax_form', {
      issued: '2025-01-30',
      extra: { tax_year: 2024 },
    });
    docs.int2025 = await file('mansoor', '1099-INT Harbour Bank 2025', 'tax_form', {
      issued: '2026-01-31',
      extra: { tax_year: 2025 },
    });
    // Four payslips; the newest in the Trash.
    for (const [k, d] of [
      ['payJun', '2026-06-30'],
      ['payJul', '2026-07-31'],
      ['payAug', '2026-08-31'],
      ['paySep', '2026-09-30'],
      ['payOct', '2026-10-15'],
    ] as const) {
      docs[k] = await file('mansoor', `Acme payslip ${d}`, 'pay_statement', { issued: d });
    }
    const trashed = await call('mansoor', 'DELETE', `/api/v1/documents/${docs.payOct}`);
    expect(trashed.statusCode, trashed.body).toBeLessThan(300);
    // One bank statement of the two asked for.
    docs.bank = await file('mansoor', 'Harbour Bank statement', 'bank_statement', {
      issued: '2026-09-30',
    });
    // Two investment statements: one his alone.
    docs.invest = await file('mansoor', 'Vanguard statement Q3', 'investment_statement', {
      issued: '2026-09-30',
    });
    docs.investOnlyMe = await file('mansoor', 'Brokerage statement Q2', 'investment_statement', {
      issued: '2026-06-30',
      visibility: 'private',
    });
    // Richa's: her family-seen payslips, and one only she sees.
    docs.richaSep = await file('richa', 'Richa payslip Sep', 'pay_statement', {
      issued: '2026-09-25',
    });
    docs.richaAug = await file('richa', 'Richa payslip Aug', 'pay_statement', {
      issued: '2026-08-25',
    });
    docs.richaOnlyMe = await file('richa', 'Richa payslip Oct', 'pay_statement', {
      issued: '2026-10-10',
      visibility: 'private',
    });
    // The teen's own.
    docs.teenPassport = await file('teen', 'Zara passport', 'passport', {
      issued: '2024-03-01',
      visibility: 'household',
    });
    refinance = await makeCollection('mansoor', 'Refinance', 'everyone');
  }, 120_000);
  afterAll(() => h?.close());

  it("reads the owner's list and shows what it found, as its maker sees", async () => {
    const c = await check('mansoor', refinance, { text: OWNERS_LIST });
    expect(c.saved_at).toBeNull();
    expect(c.mine).toBe(true);
    expect(c.items.map((i) => i.summary)).toEqual([
      'W-2s for 2025 and 2024, Mansoor’s',
      '3 most recent pay statements, Mansoor’s',
      '2 most recent bank statements, Mansoor’s',
      '2 most recent investment statements, Mansoor’s',
      '3 most recent pay statements, Richa’s',
      'Not understood',
    ]);
    // W-2s by their tax years: never the 1099.
    expect(ids(c, 0, true)).toEqual([docs.w2025, docs.w2024]);
    expect(c.items[0]).toMatchObject({ wanted: 2, found: 2, missing: [] });
    // The three newest payslips; the one in the Trash is not there at all.
    expect(ids(c, 1, true)).toEqual([docs.paySep, docs.payAug, docs.payJul]);
    expect(ids(c, 1)).not.toContain(docs.payOct);
    expect(ids(c, 1, false)).toEqual([docs.payJun]);
    // Fewer found than asked: one of two, the other missing.
    expect(c.items[2]).toMatchObject({ wanted: 2, found: 1 });
    expect(c.items[2]?.missing).toEqual(['1 more bank statement, Mansoor’s']);
    // His Only me statement is found, and offered unticked, with why.
    const onlyMe = c.items[3]?.matches.find((m) => m.document_id === docs.investOnlyMe);
    expect(onlyMe).toMatchObject({ ticked: false, chosen: true, note: CHECKLIST_ONLY_ME_NOTE });
    // Found, but it would not go in: not counted as found, nor asked for.
    expect(c.items[3]).toMatchObject({ found: 1, found_not_added: 1, missing: [] });
    // And his bank statement is offered, unticked: investments were filed so before 0.9.0.
    expect(c.items[3]?.matches.find((m) => m.document_id === docs.bank)).toMatchObject({
      ticked: false,
      note: CHECKLIST_WAS_BANK_NOTE,
    });
    // Richa's own Only me payslip is never among his matches, nor counted.
    expect(ids(c, 4)).toEqual([docs.richaSep, docs.richaAug]);
    expect(c.items[4]).toMatchObject({ wanted: 3, found: 2 });
    expect(c.items[4]?.missing).toEqual(['1 more pay statement, Richa’s']);
    expect(JSON.stringify(c)).not.toContain(docs.richaOnlyMe);
    // "and so on" is not understood, and matches nothing.
    expect(c.items[5]).toMatchObject({ understood: false, problem: 'kind', matches: [] });
    // What Add all found would add, and what is missing, for a request.
    expect(c.to_add).toBe(2 + 3 + 1 + 1 + 2);
    expect(c.missing).toEqual([
      '1 more bank statement, Mansoor’s',
      '1 more pay statement, Richa’s',
    ]);
    // Nothing is in the collection yet: a check writes nothing.
    const after = json<CollectionDetail>(
      await call('mansoor', 'GET', `/api/v1/collections/${refinance}`),
    );
    expect(after.item_count).toBe(0);
  });

  it('adds the documents ticked through the collection’s own rules, and says what it skipped', async () => {
    const c = await check('mansoor', refinance, { text: OWNERS_LIST });
    const ticked = c.items.flatMap((i) =>
      i.matches.filter((m) => m.ticked).map((m) => m.document_id),
    );
    // One already in, one in the Trash, one somebody else's Only me: each skipped, with why.
    const pre = await call('mansoor', 'POST', `/api/v1/collections/${refinance}/items`, {
      document_ids: [docs.bank],
    });
    expect(pre.statusCode, pre.body).toBe(200);
    const r = await call('mansoor', 'POST', `/api/v1/collections/${refinance}/checklist/add`, {
      document_ids: [...ticked, docs.payOct, docs.richaOnlyMe],
    });
    expect(r.statusCode, r.body).toBe(200);
    const added = json<ChecklistAdded>(r);
    expect(added.added).toHaveLength(ticked.length - 1);
    expect(added.skipped).toEqual([
      { document_id: docs.bank, why: 'in_collection' },
      { document_id: docs.payOct, why: 'not_found' },
      { document_id: docs.richaOnlyMe, why: 'not_found' },
    ]);
    expect(added.collection.item_count).toBe(ticked.length);
    // Somebody else's Only me document answers as one that does not exist.
    expect(JSON.stringify(added.collection)).not.toContain('Richa payslip Oct');
    // Matched again, they are in it now: none left to add, all still found.
    const again = await check('mansoor', refinance, { text: OWNERS_LIST });
    expect(again.to_add).toBe(0);
    expect(again.items[1]?.matches.filter((m) => m.chosen).every((m) => m.in_collection)).toBe(
      true,
    );
  });

  it('keeps the checklist, matches it again as the page opens, and never adds by itself', async () => {
    const read = await check('mansoor', refinance, { text: OWNERS_LIST });
    const put = await call('mansoor', 'PUT', `/api/v1/collections/${refinance}/checklist`, {
      items: read.items,
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(json<CollectionChecklist>(put).saved_at).not.toBeNull();
    const before = json<CollectionDetail>(
      await call('mansoor', 'GET', `/api/v1/collections/${refinance}`),
    ).item_count;

    // A second bank statement arrives: offered, ticked, not put in.
    docs.bank2 = await file('mansoor', 'Harbour Bank statement Aug', 'bank_statement', {
      issued: '2026-08-31',
    });
    const opened = json<CollectionChecklist>(
      await call('mansoor', 'GET', `/api/v1/collections/${refinance}/checklist`),
    );
    expect(opened.saved_at).not.toBeNull();
    expect(opened.items[2]).toMatchObject({ found: 2, missing: [] });
    expect(opened.items[2]?.matches.find((m) => m.document_id === docs.bank2)?.ticked).toBe(true);
    expect(opened.to_add).toBe(1);
    const now = json<CollectionDetail>(
      await call('mansoor', 'GET', `/api/v1/collections/${refinance}`),
    );
    expect(now.item_count).toBe(before);
  });

  it('the same list kept again writes nothing, and no line in the activity log', async () => {
    const lines = async () =>
      (
        await withSystem(h.db, t.mansoor.household_id, (trx) =>
          trx
            .selectFrom('audit_event')
            .select('id')
            .where('action', '=', 'collection.updated')
            .where('object_id', '=', refinance)
            .execute(),
        )
      ).length;
    const kept = json<CollectionChecklist>(
      await call('mansoor', 'GET', `/api/v1/collections/${refinance}/checklist`),
    );
    const before = await lines();
    expect(before).toBeGreaterThan(0);
    const again = await call('mansoor', 'PUT', `/api/v1/collections/${refinance}/checklist`, {
      items: kept.items,
    });
    expect(again.statusCode, again.body).toBe(200);
    expect(json<CollectionChecklist>(again).saved_at).toBe(kept.saved_at);
    expect(await lines()).toBe(before);
  });

  it('keeps months named and "dated within" as the person set them', async () => {
    const made = await makeCollection('mansoor', 'Months', 'everyone');
    const c = await check('mansoor', made, {
      text: 'Bank statements for May and June 2026\nPay stub dated within 3 months',
    });
    const put = await call('mansoor', 'PUT', `/api/v1/collections/${made}/checklist`, {
      items: c.items.map((i) => ({ ...i, matches: undefined })),
    });
    expect(put.statusCode, put.body).toBe(200);
    const kept = json<CollectionChecklist>(
      await call('mansoor', 'GET', `/api/v1/collections/${made}/checklist`),
    );
    expect(kept.items.map((i) => [i.in_months, i.within])).toEqual([
      [['2026-05', '2026-06'], null],
      [[], 3],
    ]);
  });

  it('an investment line alone offers his bank statements, unticked', async () => {
    const made = await makeCollection('mansoor', 'Investments', 'everyone');
    const c = await check('mansoor', made, {
      text: 'Documents for Mansoor\nLast 2 investment statements',
    });
    expect(c.items[0]?.matches.find((m) => m.document_id === docs.bank)).toMatchObject({
      ticked: false,
      note: CHECKLIST_WAS_BANK_NOTE,
    });
  });

  it('a document taken to the Trash while it is added is skipped; the rest go in', async () => {
    const target = await makeCollection('mansoor', 'Race', 'everyone');
    const a = await file('mansoor', 'Race payslip A', 'pay_statement', { issued: '2026-01-31' });
    const b = await file('mansoor', 'Race payslip B', 'pay_statement', { issued: '2026-02-28' });
    const admin = createPool(h.adminUrl, 2);
    const held = await admin.connect();
    try {
      // B is being taken to the Trash, not yet done…
      await held.query('begin');
      await held.query('update document set deleted_at = now() where id = $1', [b]);
      const adding = call('mansoor', 'POST', `/api/v1/collections/${target}/checklist/add`, {
        document_ids: [a, b],
      });
      // … while the add waits on it; then it is gone.
      for (let i = 0; i < 100; i += 1) {
        const waiting = await admin.query<{ n: number }>(
          `select count(*)::int as n from pg_stat_activity
            where datname = $1 and wait_event_type = 'Lock'`,
          [new URL(h.adminUrl).pathname.slice(1)],
        );
        if ((waiting.rows[0]?.n ?? 0) > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await held.query('commit');
      const r = await adding;
      expect(r.statusCode, r.body).toBe(200);
      expect(json<ChecklistAdded>(r)).toMatchObject({
        added: [a],
        skipped: [{ document_id: b, why: 'not_found' }],
      });
    } finally {
      held.release();
      await admin.end();
    }
  });

  it('opens the tax year of the caller’s own Only me tax form', async () => {
    const own = await file('mansoor', 'W-2 Acme 2023', 'tax_form', {
      issued: '2024-02-01',
      visibility: 'private',
      extra: { tax_year: 2022 },
    });
    const made = await makeCollection('mansoor', 'Old years', 'only_me');
    const c = await check('mansoor', made, { text: "Mansoor's W2 for 2022" });
    // Its sealed tax year, 2022: not its title's 2023, nor the year it was issued.
    expect(ids(c, 0, true)).toEqual([own]);
    const title = await check('mansoor', made, { text: "Mansoor's W2 for 2023" });
    expect(ids(title, 0, true)).toEqual([]);
  });

  it('is matched for each reader as they see: Richa, who did not make it, only reads it', async () => {
    const r = await call('richa', 'GET', `/api/v1/collections/${refinance}/checklist`);
    expect(r.statusCode, r.body).toBe(200);
    const c = json<CollectionChecklist>(r);
    expect(c.mine).toBe(false);
    // His Only me statement is nowhere in what she is given, nor counted.
    expect(JSON.stringify(c)).not.toContain(docs.investOnlyMe);
    expect(c.items[3]).toMatchObject({ found: 1, wanted: 2 });
    // Her own Only me payslip is hers to see: found, unticked, with why.
    const own = c.items[4]?.matches.find((m) => m.document_id === docs.richaOnlyMe);
    expect(own).toMatchObject({ ticked: false, note: CHECKLIST_ONLY_ME_NOTE });
    // She may not change it, nor add from it.
    for (const [method, url, body] of [
      ['POST', `/api/v1/collections/${refinance}/checklist`, { text: 'Passport' }],
      ['PUT', `/api/v1/collections/${refinance}/checklist`, { items: [] }],
      ['POST', `/api/v1/collections/${refinance}/checklist/add`, { document_ids: [docs.richaSep] }],
    ] as const) {
      const refused = await call('richa', method, url, body);
      expect(refused.statusCode, refused.body).toBe(403);
    }
  });

  it('is never given to a viewer, nor to a link outside the family', async () => {
    const viewer = await call('viewer', 'GET', `/api/v1/collections/${refinance}/checklist`);
    expect(viewer.statusCode).toBe(403);
    // Shared outside the family, the link gives the documents, never the list.
    const form = new FormData();
    form.append('file', PDF, { filename: 'w2.pdf', contentType: 'application/pdf' });
    const up = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${docs.w2025}/versions`,
      headers: { ...h.as(t.mansoor), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    expect(up.statusCode, up.body).toBeLessThan(300);
    await withSystem(h.db, t.mansoor.household_id, (trx) =>
      trx.updateTable('session').set({ verified_at: new Date() }).execute(),
    );
    const shared = await call('mansoor', 'POST', `/api/v1/collections/${refinance}/shares`, {
      document_ids: [docs.w2025],
      recipient_label: 'the lender',
    });
    expect(shared.statusCode, shared.body).toBe(201);
    const link = json<CreatedShare>(shared);
    const unlocked = await h.app.inject({
      method: 'POST',
      url: '/api/v1/shared/unlock',
      payload: { token: link.link_token },
    });
    expect(unlocked.statusCode, unlocked.body).toBe(200);
    const cookie = unlocked.cookies.find((k) => k.name === 'fdv_share')?.value as string;
    const items = await h.app.inject({
      url: '/api/v1/shared/items',
      cookies: { fdv_share: cookie },
    });
    expect(items.statusCode, items.body).toBe(200);
    for (const words of ['pay statements', 'Documents for', 'Last 3', 'checklist']) {
      expect(unlocked.body + items.body).not.toContain(words);
    }
    // The link's own session, at the database: no row of any checklist.
    const asLink = (fn: (trx: Db) => Promise<number>) =>
      withScope(
        h.db,
        { householdId: t.mansoor.household_id, actor: { kind: 'link', shareId: link.share.id } },
        fn,
      );
    const rows = await asLink(
      async (trx) =>
        (await trx.selectFrom('collection_checklist').select('collection_id').execute()).length,
    );
    expect(rows).toBe(0);
    // While the vault itself has it.
    const kept = await withSystem(h.db, t.mansoor.household_id, (trx) =>
      trx.selectFrom('collection_checklist').select('collection_id').execute(),
    );
    expect(kept.map((k) => k.collection_id)).toContain(refinance);
  });

  it('the database keeps it: read by the family, never a viewer; written by its maker alone', async () => {
    const accountOf = async (who: Who) =>
      json<{ account_id: string }>(await call(who, 'GET', '/api/v1/me')).account_id;
    const as = async <T>(
      who: Who,
      role: 'owner' | 'adult' | 'viewer',
      fn: (trx: Db) => Promise<T>,
    ) =>
      withScope(
        h.db,
        {
          householdId: t.mansoor.household_id,
          actor: {
            kind: 'account',
            accountId: await accountOf(who),
            memberId: t[who].member_id,
            role,
          },
        },
        fn,
      );
    const read = (trx: Db) =>
      trx.selectFrom('collection_checklist').select('collection_id').execute();
    // Richa, an adult who sees the collection, reads it; as a viewer she would not.
    expect((await as('richa', 'adult', read)).map((r) => r.collection_id)).toContain(refinance);
    expect(await as('viewer', 'viewer', read)).toEqual([]);
    expect(await as('richa', 'viewer', read)).toEqual([]);
    // She cannot change it, nor remove it, whatever the API is asked.
    await expect(
      as('richa', 'adult', (trx) =>
        trx
          .updateTable('collection_checklist')
          .set({ items: '[]' })
          .where('collection_id', '=', refinance)
          .execute(),
      ),
    ).resolves.toEqual([expect.objectContaining({ numUpdatedRows: 0n })]);
    await expect(
      as('richa', 'adult', (trx) =>
        trx.deleteFrom('collection_checklist').where('collection_id', '=', refinance).execute(),
      ),
    ).resolves.toEqual([expect.objectContaining({ numDeletedRows: 0n })]);
    const own = await makeCollection('richa', 'Richa’s own', 'everyone');
    await expect(
      as('richa', 'adult', (trx) =>
        trx
          .insertInto('collection_checklist')
          .values({ collection_id: refinance, household_id: t.mansoor.household_id, items: '[]' })
          .onConflict((oc) => oc.column('collection_id').doNothing())
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    // Her own collection's, she writes.
    await as('richa', 'adult', (trx) =>
      trx
        .insertInto('collection_checklist')
        .values({ collection_id: own, household_id: t.mansoor.household_id, items: '[]' })
        .execute(),
    );
  });

  it('a teen is matched to themselves alone; nobody else is matched by name', async () => {
    const own = await makeCollection('teen', 'School trip', 'everyone');
    const c = await check('teen', own, {
      text: 'Documents for Mansoor\nLast 3 pay statements\nDocuments for me\nPassport',
    });
    // Mansoor is nobody the teen may choose: asked whose, never matched.
    expect(c.items[0]).toMatchObject({
      problem: 'person_unknown',
      member_id: null,
      matches: [],
      summary: '3 most recent pay statements: whose?',
    });
    expect(c.items[1]).toMatchObject({ member_id: t.teen.member_id, found: 1 });
    expect(ids(c, 1, true)).toEqual([docs.teenPassport]);
    // Told whose for the first, it is still nobody the teen may choose.
    const told = await check('teen', own, {
      items: [{ ...c.items[0], member_id: t.mansoor.member_id, unresolved: null }],
    });
    expect(told.items[0]).toMatchObject({
      problem: 'person_unknown',
      member_id: null,
      matches: [],
    });
  });

  it('asks for the missing ones with a request to send documents', async () => {
    const c = await check('mansoor', refinance, {
      text: 'Documents for Mansoor\nW2 for 2023\nLast 2 bank statements for 2024',
    });
    expect(c.missing).toEqual([
      'W-2 for 2023, Mansoor’s',
      '2 more bank statements from 2024, Mansoor’s',
    ]);
    const made = await call('mansoor', 'POST', '/api/v1/upload-requests', {
      title: 'Documents for Refinance',
      items: c.missing,
      recipient_label: 'Mansoor’s employer',
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
    });
    expect(made.statusCode, made.body).toBe(201);
    const request = json<CreatedUploadRequest>(made).request;
    expect(request.items.map((i) => i.label)).toEqual(c.missing);
    expect(request.recipient_label).toBe('Mansoor’s employer');
  });

  it('is refused when the list cannot be read in time, and says so', async () => {
    const slow = await createHarness({
      checklistReader: { readChecklist: async () => null },
    });
    try {
      const owner = await slow.setup();
      const made = await slow.app.inject({
        method: 'POST',
        url: '/api/v1/collections',
        headers: slow.as(owner),
        payload: { name: 'Trip', audience: 'everyone' },
      });
      const id = json<CollectionDetail>(made).id;
      const r = await slow.app.inject({
        method: 'POST',
        url: `/api/v1/collections/${id}/checklist`,
        headers: slow.as(owner),
        payload: { text: 'Passport' },
      });
      expect(r.statusCode).toBe(503);
      expect(json<{ error: { code: string } }>(r).error.code).toBe('checklist_unavailable');
    } finally {
      await slow.close();
    }
  });

  it("finds a line by its title — the owner's own list — as each reader sees, never from the Trash (0.9.0)", async () => {
    // The EAD card filed as a kind of the household's own, with no words to say it.
    const made = await call('mansoor', 'POST', '/api/v1/document-types', {
      label: 'Work papers',
      category: 'other',
    });
    expect(made.statusCode, made.body).toBe(201);
    const own = json<{ key: string }>(made).key;
    docs.mPassport = await file('mansoor', 'Mansoor’s passport', 'passport', {
      issued: '2021-05-01',
      visibility: 'household',
    });
    docs.ead = await file('mansoor', 'Mansoor’s EAD Card', own, { visibility: 'household' });
    // A line with no kind, and three documents by its words: one the family
    // see, one only Richa sees, one in the Trash.
    docs.mooring = await file('mansoor', 'Harbour mooring permit 2025', own, {
      visibility: 'household',
    });
    docs.richaMooring = await file('richa', 'Mooring permit (Richa)', own, {
      visibility: 'private',
    });
    docs.oldMooring = await file('mansoor', 'Old mooring permit', own, { visibility: 'household' });
    const trashed = await call('mansoor', 'DELETE', `/api/v1/documents/${docs.oldMooring}`);
    expect(trashed.statusCode, trashed.body).toBeLessThan(300);
    const papers = await makeCollection('mansoor', 'Immigration', 'everyone');

    const c = await check('mansoor', papers, {
      text: 'mansoors passport\nmansoors ead\nMooring permit',
    });
    expect(c.items.map((i) => [i.summary, i.member_id, i.found, i.by_title ?? false])).toEqual([
      ['The most recent passport, Mansoor’s', t.mansoor.member_id, 1, false],
      ['Found by its title: Mansoor’s EAD Card', t.mansoor.member_id, 1, true],
      ['Found by its title: Harbour mooring permit 2025', null, 1, true],
    ]);
    expect(ids(c, 0, true)).toEqual([docs.mPassport]);
    expect(ids(c, 1, true)).toEqual([docs.ead]);
    expect(ids(c, 2, true)).toEqual([docs.mooring]);
    // Richa's Only me permit and the one in the Trash: never found, nor counted.
    expect(JSON.stringify(c)).not.toContain(docs.richaMooring);
    expect(JSON.stringify(c)).not.toContain('Mooring permit (Richa)');
    expect(JSON.stringify(c)).not.toContain(docs.oldMooring);
    expect(c.to_add).toBe(3);

    // Kept, and looked for again by its title as the page opens.
    const put = await call('mansoor', 'PUT', `/api/v1/collections/${papers}/checklist`, {
      items: c.items,
    });
    expect(put.statusCode, put.body).toBe(200);
    const kept = await withSystem(h.db, t.mansoor.household_id, (trx) =>
      trx
        .selectFrom('collection_checklist')
        .select('items')
        .where('collection_id', '=', papers)
        .executeTakeFirstOrThrow(),
    );
    expect((kept.items as Array<{ title_words?: string[] }>)[2]?.title_words).toEqual([
      'mooring',
      'permit',
    ]);
    const opened = json<CollectionChecklist>(
      await call('mansoor', 'GET', `/api/v1/collections/${papers}/checklist`),
    );
    expect(opened.items.map((i) => i.summary)).toEqual(c.items.map((i) => i.summary));
    expect(ids(opened, 2, true)).toEqual([docs.mooring]);

    // Richa, opening it: her own Only me permit too — two, to choose from,
    // hers found and never ticked in a collection others see.
    const hers = json<CollectionChecklist>(
      await call('richa', 'GET', `/api/v1/collections/${papers}/checklist`),
    );
    expect(hers.items[2]).toMatchObject({
      by_title: true,
      summary: 'Found by its title: 2 to choose from',
      found: 0,
    });
    expect(ids(hers, 2).sort()).toEqual([docs.mooring, docs.richaMooring].sort());
    expect(ids(hers, 2, true)).toEqual([]);
    expect(JSON.stringify(hers)).not.toContain(docs.oldMooring);
  });

  it('a current passport passes by one no longer needed; a plain line finds it, and says so (0.9.0)', async () => {
    const old = await file('richa', 'Richa old passport', 'passport', {
      issued: '2025-02-01',
      visibility: 'household',
    });
    const marked = await call('richa', 'POST', `/api/v1/documents/${old}/no-longer-needed`, {});
    expect(marked.statusCode, marked.body).toBe(200);
    const trip = await makeCollection('richa', 'Trip', 'everyone');
    const c = await check('richa', trip, { text: "Richa's current passport\nRicha's passport" });
    expect(ids(c, 0)).toEqual([]);
    expect(c.items[0]?.missing).toEqual(['a current passport, Richa’s']);
    expect(c.items[1]?.matches.map((m) => [m.document_id, m.note])).toEqual([
      [old, CHECKLIST_NO_LONGER_NEEDED_NOTE],
    ]);
  });

  it('refuses a list longer than it reads, before reading it', async () => {
    const r = await call('mansoor', 'POST', `/api/v1/collections/${refinance}/checklist`, {
      text: 'x'.repeat(10_001),
    });
    expect(r.statusCode).toBe(422);
    const nowhere = await call('mansoor', 'POST', `/api/v1/collections/${randomUUID()}/checklist`, {
      text: 'Passport',
    });
    expect(nowhere.statusCode).toBe(404);
  });
});
