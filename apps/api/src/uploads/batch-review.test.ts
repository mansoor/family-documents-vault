import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  EnvKeyProvider,
  itemProposalsBinding,
  itemTextBinding,
  ScopeKeys,
  sealBytes,
  unwrapKey,
} from '@fdv/crypto';
import { createPool, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  ACCEPT_READY_MAX,
  untouchedAccept,
  type ActivityLine,
  type BatchAcceptReadyResult,
  type BatchDetail,
  type BatchItemView,
  type BatchUndoResult,
  type BatchView,
  type CollectionDetail,
  type DetailProposal,
  type DocumentTypeView,
  type DocumentView,
  type Tokens,
} from '@fdv/shared';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, TEST_MASTER, type Harness } from '../test-harness.js';

/**
 * The review queue (Phase 6, I3), in the API: Accept all Ready — the items
 * Ready now, as the vault levels them, each filed as its untouched card
 * would file it, item by item — and Undo, which takes those documents back
 * into the queue for a few minutes with nothing of them left that anybody
 * else is shown. The worker is not here: what it seals is planted as it
 * seals it (as batch-proposals.test.ts does).
 */

const PDF = (marker: string) => Buffer.from(`%PDF-1.4\n% ${marker} ${randomUUID()}\n%%EOF\n`);
const day = (date: string) => ({ date, precision: 'day' as const });

describe.skipIf(!testAdminUrl())('the review queue: Accept all Ready and Undo (I3)', () => {
  let h: Harness;
  let owner: Tokens;
  let adult: Tokens;
  let teen: Tokens;
  let viewer: Tokens;
  let hh: string;
  let admin: ReturnType<typeof createPool>;
  let app: ReturnType<typeof createPool>;
  const keys = new ScopeKeys(new EnvKeyProvider(TEST_MASTER));
  /** While set, an Undo holding its document waits for this. */
  let undoGate: Promise<void> | null = null;
  let undoReached: (() => void) | null = null;

  beforeAll(async () => {
    h = await createHarness({
      rateLimitPerMinute: 100_000,
      batchUndoHeld: async () => {
        if (!undoGate) return;
        undoReached?.();
        await undoGate;
      },
    });
    owner = await h.setup();
    hh = owner.household_id;
    adult = await h.join(owner, { name: 'Sana', email: 'sana@example.test', role: 'adult' });
    teen = await h.join(owner, { name: 'Zara', email: 'zara@example.test', role: 'teen' });
    viewer = await h.join(owner, { name: 'Vic', email: 'vic@example.test', role: 'viewer' });
    admin = createPool(h.adminUrl, 1);
    app = createPool(h.appUrl, 1);
  }, 120_000);

  afterAll(async () => {
    await admin?.end();
    await app?.end();
    await h?.close();
  });

  const call = (who: Tokens, method: string, url: string, payload?: unknown) =>
    h.app.inject({
      method: method as 'GET',
      url,
      headers: h.as(who),
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
  const made = async (who: Tokens, body: Record<string, unknown> = {}) => {
    const res = await call(who, 'POST', '/api/v1/batches', body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json<BatchDetail>();
  };
  const sent = async (who: Tokens, batchId: string, bytes = PDF('scan')) => {
    const form = new FormData();
    form.append('file', bytes, { filename: 'scan.pdf', contentType: 'application/pdf' });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/batches/${batchId}/items`,
      headers: { ...h.as(who), ...form.getHeaders() },
      payload: form.getBuffer(),
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<BatchItemView>();
  };
  const batch = async (who: Tokens, id: string) => {
    const res = await call(who, 'GET', `/api/v1/batches/${id}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<BatchDetail>();
  };
  const itemOf = async (who: Tokens, batchId: string, itemId: string) =>
    (await batch(who, batchId)).items.find((i) => i.id === itemId) as BatchItemView;
  const acceptReady = (who: Tokens, batchId: string, body: Record<string, unknown> = {}) =>
    call(who, 'POST', `/api/v1/batches/${batchId}/accept-ready`, body);
  const accepted = async (who: Tokens, batchId: string, body: Record<string, unknown> = {}) => {
    const res = await acceptReady(who, batchId, body);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<BatchAcceptReadyResult>();
  };
  const undo = (who: Tokens, batchId: string, ids: string[]) =>
    call(who, 'POST', `/api/v1/batches/${batchId}/accept-ready/undo`, { item_ids: ids });
  const undone = async (who: Tokens, batchId: string, ids: string[]) => {
    const res = await undo(who, batchId, ids);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<BatchUndoResult>();
  };
  const doc = (who: Tokens, id: string) => call(who, 'GET', `/api/v1/documents/${id}`);
  const activity = async (who: Tokens) =>
    (await call(who, 'GET', '/api/v1/audit?limit=100'))
      .json<{ items: ActivityLine[] }>()
      .items.map((l) => `${l.id}:${l.text}`);
  const types = async (who: Tokens) =>
    (await call(who, 'GET', '/api/v1/document-types')).json<{ items: DocumentTypeView[] }>().items;
  const onDisk = (key: string) =>
    stat(path.join(h.vaultDir, key)).then(
      () => true,
      () => false,
    );

  /** What the worker writes once it has read an item: its words and what they propose, sealed. */
  const plant = async (itemId: string, proposal: DetailProposal) =>
    withSystem(h.db, hh, async (trx) => {
      const f = await trx
        .selectFrom('incoming_file')
        .select(['file_key_wrapped', 'wrapped_by_scope'])
        .where('id', '=', itemId)
        .executeTakeFirstOrThrow();
      const fileKey = unwrapKey(
        f.file_key_wrapped,
        await keys.unwrapById(trx, f.wrapped_by_scope),
        `incoming:${itemId}`,
      );
      await trx
        .updateTable('incoming_file')
        .set({
          read_state: 'read',
          preview_state: 'ready',
          preview_pages: 1,
          text_sealed: sealBytes(
            fileKey,
            Buffer.from('the words on its pages'),
            itemTextBinding(itemId),
          ),
          proposals_sealed: sealBytes(
            fileKey,
            Buffer.from(JSON.stringify({ v: 1, proposal })),
            itemProposalsBinding(itemId),
          ),
        })
        .where('id', '=', itemId)
        .execute();
    });

  /** A passport read well, for `who`. */
  const passport = (
    who: string,
    c = 0.9,
    number = `P-${randomUUID().slice(0, 8)}`,
  ): DetailProposal => ({
    type_key: { value: 'passport', confidence: 0.97, cue: 'kind_words' },
    owner_member_id: { value: who, confidence: c, cue: 'name_labelled' },
    issued: { value: day('2021-03-14'), confidence: 0.89, cue: 'issue_label' },
    expires: { value: day('2031-03-14'), confidence: 0.94, cue: 'machine_lines' },
    identifier: { value: number, confidence: 0.95, cue: 'machine_lines' },
    issued_by: { value: 'United Kingdom', confidence: 0.9, cue: 'machine_lines' },
  });

  /** An item sent and read as Ready, for `who`'s batch. */
  const readyItem = async (who: Tokens, batchId: string, proposal = passport(who.member_id)) => {
    const it = await sent(who, batchId);
    await plant(it.id, proposal);
    return it;
  };

  /** Every row anywhere that still names a document by `document_id`. */
  const namedBy = async (documentId: string) => {
    const tables = await admin.query<{ table_name: string }>(
      `select c.table_name from information_schema.columns c
         join information_schema.tables t
           on t.table_name = c.table_name and t.table_schema = c.table_schema
        where c.table_schema = 'public' and c.column_name = 'document_id'
          and t.table_type = 'BASE TABLE'`,
    );
    const out: string[] = [];
    for (const { table_name } of tables.rows) {
      const n = await admin.query<{ n: string }>(
        `select count(*) as n from public."${table_name}" where document_id = $1`,
        [documentId],
      );
      if (Number(n.rows[0]?.n) > 0) out.push(table_name);
    }
    for (const [table, column] of [
      ['document', 'id'],
      ['document_tombstone', 'id'],
    ] as const) {
      const n = await admin.query<{ n: string }>(
        `select count(*) as n from public.${table} where ${column} = $1`,
        [documentId],
      );
      if (Number(n.rows[0]?.n) > 0) out.push(table);
    }
    return out;
  };

  it('says it has the review queue', async () => {
    const caps = (await h.app.inject({ url: '/api/v1/capabilities' })).json<{
      features: Record<string, unknown>;
    }>();
    expect(caps.features.batch_review).toBe(true);
  });

  it('accepts exactly what is Ready now, as the vault levels it: an item a default change made Check is not, whatever the client saw', async () => {
    const b = await made(adult, { name: 'Passports' });
    const sana = await readyItem(adult, b.id, passport(adult.member_id));
    // The pages name the owner: Ready while the batch says nobody's.
    const ahmed = await readyItem(adult, b.id, passport(owner.member_id));
    // Its expiry unsure: Check, whatever the batch says.
    const unsure = await readyItem(adult, b.id, {
      ...passport(adult.member_id),
      expires: { value: day('2031-03-14'), confidence: 0.7, cue: 'expiry_label' },
    });
    const seen = await batch(adult, b.id);
    const levels = new Map(seen.items.map((i) => [i.id, i.level]));
    expect(levels.get(sana.id)).toBe('ready');
    expect(levels.get(ahmed.id)).toBe('ready');
    expect(levels.get(unsure.id)).toBe('check');
    // Then the batch says Sana's: the pages naming Ahmed disagree, and it is Check.
    const patched = await call(adult, 'PATCH', `/api/v1/batches/${b.id}`, {
      defaults: { owner_member_id: adult.member_id },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    const now = await batch(adult, b.id);
    expect(now.items.find((i) => i.id === ahmed.id)?.level, JSON.stringify(now.items)).toBe(
      'check',
    );

    // The client sends what it saw Ready a moment ago; and one it never could.
    const out = await accepted(adult, b.id, { item_ids: [sana.id, ahmed.id, unsure.id] });
    expect(out.accepted.map((a) => a.item_id)).toEqual([sana.id]);
    expect(out.skipped).toEqual([
      { item_id: ahmed.id, reason: 'not_ready', level: 'check' },
      { item_id: unsure.id, reason: 'not_ready', level: 'check' },
    ]);
    expect(out.failed).toEqual([]);
    expect(out.more).toBe(false);
    expect(new Date(out.undo_until as string).getTime()).toBeGreaterThan(Date.now());
    expect((await itemOf(adult, b.id, ahmed.id)).state).toBe('waiting');
    expect((await itemOf(adult, b.id, sana.id)).state).toBe('accepted');
  });

  it('files each as its untouched card would: the merged proposal, its name, who can see it, the batch’s collection, tags and Essential', async () => {
    const c = await call(adult, 'POST', '/api/v1/collections', {
      name: 'Travel',
      audience: 'everyone',
    });
    expect(c.statusCode, c.body).toBe(201);
    const collection = c.json<CollectionDetail>();
    const b = await made(adult, {
      name: 'Travel papers',
      defaults: {
        collection_id: collection.id,
        tags: ['travel', 'house'],
        is_essential: true,
        physical_location: 'The blue folder',
      },
    });
    const it = await readyItem(adult, b.id, passport(adult.member_id, 0.9, 'P-533401872'));
    const before = await itemOf(adult, b.id, it.id);
    expect(before.level).toBe('ready');
    const card = untouchedAccept({
      proposals: before.proposals as NonNullable<BatchItemView['proposals']>,
      defaults: b.defaults,
      types: await types(adult),
      people: [{ id: adult.member_id, display_name: 'Sana' }],
      role: 'adult',
      me: adult.member_id,
    });

    // Without naming any: every item Ready now.
    const out = await accepted(adult, b.id);
    expect(out.accepted).toHaveLength(1);
    const filed = (await doc(adult, out.accepted[0]?.document_id as string)).json<DocumentView>();
    expect(filed).toMatchObject({
      title: card.title,
      type_key: 'passport',
      owner_member_id: adult.member_id,
      visibility: before.proposals?.visibility.value,
      identifier: 'P-533401872',
      issued_by: 'United Kingdom',
      issued: day('2021-03-14'),
      expires: day('2031-03-14'),
      is_essential: true,
      physical_location: 'The blue folder',
    });
    expect(card.title).toBe("Sana's passport");
    expect([...(filed.tags ?? [])].sort()).toEqual(['house', 'travel']);
    const inIt = (
      await call(adult, 'GET', `/api/v1/collections/${collection.id}`)
    ).json<CollectionDetail>();
    expect(inIt.items.map((d) => d.document.id)).toContain(filed.id);
  });

  it('item by item: one that cannot be filed is named with why and kept waiting; one decided, or not in the batch, is said so; the rest are filed', async () => {
    const b = await made(adult, { name: 'Mixed' });
    const good = await readyItem(adult, b.id);
    const lost = await readyItem(adult, b.id);
    const decided = await readyItem(adult, b.id);
    // Its file gone from where it is kept: the copy cannot be made.
    const key = (
      await admin.query<{ storage_key: string }>(
        'select storage_key from incoming_file where id = $1',
        [lost.id],
      )
    ).rows[0]?.storage_key as string;
    await rm(path.join(h.vaultDir, key), { force: true });
    const one = await call(adult, 'POST', `/api/v1/batches/${b.id}/items/${decided.id}/accept`, {});
    expect(one.statusCode, one.body).toBe(201);
    const stranger = randomUUID();

    const out = await accepted(adult, b.id, {
      item_ids: [good.id, lost.id, decided.id, stranger],
    });
    expect(out.accepted.map((a) => a.item_id)).toEqual([good.id]);
    expect(out.failed.map((f) => [f.item_id, f.code])).toEqual([[lost.id, 'storage_unreachable']]);
    expect(out.failed[0]?.message).toMatch(/where your files are kept/);
    expect(out.skipped).toEqual([
      { item_id: decided.id, reason: 'decided' },
      { item_id: stranger, reason: 'not_found' },
    ]);
    const still = await itemOf(adult, b.id, lost.id);
    expect(still).toMatchObject({ state: 'waiting', level: 'ready' });
    // Nothing of the failed one was kept: no document with its bytes.
    const documents = await admin.query<{ n: string }>(
      `select count(*) as n from document_version v join incoming_file f on f.sha256 = v.sha256
        where f.id = $1`,
      [lost.id],
    );
    expect(Number(documents.rows[0]?.n)).toBe(0);
  });

  it('at most ACCEPT_READY_MAX a request: more Ready says so, and naming more is refused', async () => {
    const tooMany = Array.from({ length: ACCEPT_READY_MAX + 1 }, () => randomUUID());
    const b = await made(adult, { name: 'Too many' });
    const res = await acceptReady(adult, b.id, { item_ids: tooMany });
    expect(res.statusCode, res.body).toBe(422);
  });

  it('nobody but its uploader: an owner, another adult and a teen are told it is not there; a viewer may not', async () => {
    const b = await made(adult, { name: 'Mine alone' });
    const it = await readyItem(adult, b.id);
    for (const who of [owner, teen]) {
      expect((await acceptReady(who, b.id)).statusCode).toBe(404);
      expect((await acceptReady(who, b.id, { item_ids: [it.id] })).statusCode).toBe(404);
    }
    expect((await acceptReady(viewer, b.id)).statusCode).toBe(403);
    expect((await itemOf(adult, b.id, it.id)).state).toBe('waiting');
    // And its Undo: an owner taking back an adult's is not there either.
    const out = await accepted(adult, b.id);
    expect(out.accepted).toHaveLength(1);
    expect((await undo(owner, b.id, [it.id])).statusCode).toBe(404);
    expect((await undo(teen, b.id, [it.id])).statusCode).toBe(404);
    expect((await undo(viewer, b.id, [it.id])).statusCode).toBe(403);
    expect((await doc(adult, out.accepted[0]?.document_id as string)).statusCode).toBe(200);
    // Another adult's batch, named with this item: not theirs either.
    const other = await made(owner, { name: 'The owner’s' });
    const kept = await undone(owner, other.id, [it.id]);
    expect(kept.restored).toEqual([]);
    expect(kept.kept.map((k) => [k.item_id, k.reason])).toEqual([[it.id, 'not_found']]);
  });

  it('a teen’s are their own: one whose pages name somebody else is never Ready, and what is filed is theirs', async () => {
    const b = await made(teen, { name: 'School' });
    const theirs = await readyItem(teen, b.id, passport(teen.member_id));
    const sanas = await readyItem(teen, b.id, passport(adult.member_id));
    const seen = await batch(teen, b.id);
    expect(seen.items.find((i) => i.id === sanas.id)?.tags?.map((t) => t.code)).toContain(
      'not_theirs',
    );
    const out = await accepted(teen, b.id, { item_ids: [theirs.id, sanas.id] });
    expect(out.accepted.map((a) => a.item_id)).toEqual([theirs.id]);
    expect(out.skipped).toEqual([{ item_id: sanas.id, reason: 'not_ready', level: 'check' }]);
    const filed = (await doc(teen, out.accepted[0]?.document_id as string)).json<DocumentView>();
    expect(filed.owner_member_id).toBe(teen.member_id);
    expect(filed.visibility).not.toBe('adults');
  });

  it('a batch made Only me files Only me, the uploader’s own, sealed; it follows no link outside, whatever the household’s rule (5.41)', async () => {
    const c = await call(adult, 'POST', '/api/v1/collections', {
      name: 'Shared out',
      audience: 'everyone',
    });
    const collection = c.json<CollectionDetail>();
    const b = await made(adult, {
      name: 'Private',
      defaults: { visibility: 'private', collection_id: collection.id },
    });
    const it = await readyItem(adult, b.id);
    const out = await accepted(adult, b.id);
    const id = out.accepted[0]?.document_id as string;
    expect(out.accepted.map((a) => a.item_id)).toEqual([it.id]);
    const filed = (await doc(adult, id)).json<DocumentView>();
    expect(filed).toMatchObject({ visibility: 'private', owner_member_id: adult.member_id });
    expect((await doc(owner, id)).statusCode).toBe(404);
    // Sealed from its first moment, under the uploader's own member key.
    const scope = await admin.query<{ kind: string; member_id: string | null }>(
      `select k.kind, k.member_id from document_version v join scope_key k on k.id = v.wrapped_by_scope
        where v.document_id = $1`,
      [id],
    );
    expect(scope.rows).toEqual([{ kind: 'member', member_id: adult.member_id }]);
    // No collection's link takes an Only me document out.
    const followed = await admin.query('select 1 from share_link_item where document_id = $1', [
      id,
    ]);
    expect(followed.rowCount).toBe(0);
  });

  it('a collection’s 5.33 warnings come back with each item filed into it', async () => {
    await h.decider(owner);
    const c = await call(adult, 'POST', '/api/v1/collections', {
      name: 'For Jane',
      audience: 'everyone',
    });
    const collection = c.json<CollectionDetail>();
    const invited = await call(owner, 'POST', '/api/v1/invitations', {
      display_name: 'Jane Smith',
      relationship: 'attorney',
      email: `jane-${randomUUID().slice(0, 6)}@example.test`,
      role: 'viewer',
      kind: 'guest',
      restriction: { collections: [collection.id] },
      access_expires_at: new Date(Date.now() + 30 * 864e5).toISOString(),
    });
    expect(invited.statusCode, invited.body).toBe(201);
    const { link_token, code } = invited.json<{ link_token: string; code: string }>();
    const joined = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      payload: { token: link_token, code, password: 'the guest’s own password' },
      remoteAddress: '10.92.0.9',
    });
    expect(joined.statusCode, joined.body).toBe(201);
    const b = await made(adult, {
      name: 'For the lawyer',
      defaults: { collection_id: collection.id, visibility: 'household' },
    });
    await readyItem(adult, b.id);
    const out = await accepted(adult, b.id);
    expect(out.accepted[0]?.warnings).toEqual(['Jane Smith (guest) will be able to see this.']);
  });

  it('Undo takes them back into the queue: each document gone for good, nothing of it left that anybody is shown, its file waiting to be read again', async () => {
    const c = await call(adult, 'POST', '/api/v1/collections', {
      name: 'Undone',
      audience: 'everyone',
    });
    const collection = c.json<CollectionDetail>();
    const b = await made(adult, {
      name: 'Taken back',
      defaults: { collection_id: collection.id, tags: ['undone'] },
    });
    const one = await readyItem(adult, b.id);
    const two = await readyItem(adult, b.id);
    const ownerSaw = await activity(owner);
    const adultSaw = await activity(adult);
    const out = await accepted(adult, b.id);
    expect(out.accepted.map((a) => a.item_id)).toEqual([one.id, two.id]);
    const docs = out.accepted.map((a) => a.document_id);
    // Filed: the owner sees it for a moment, as any new document.
    expect((await doc(owner, docs[0] as string)).statusCode).toBe(200);
    expect((await activity(owner)).length).toBeGreaterThan(ownerSaw.length);
    h.jobs.length = 0;

    const back = await undone(adult, b.id, [one.id, two.id]);
    expect(back).toEqual({ restored: [one.id, two.id], kept: [] });
    for (const id of docs) {
      for (const who of [adult, owner]) expect((await doc(who, id)).statusCode).toBe(404);
      // No row anywhere names it — reminders, collections, search, notices, links — and no tombstone.
      expect(await namedBy(id)).toEqual([]);
    }
    // Nobody is shown a line about them: the log reads as it did before.
    expect(await activity(owner)).toEqual(ownerSaw);
    expect(await activity(adult)).toEqual(adultSaw);
    // Not in search, by its name.
    const found = await call(owner, 'GET', `/api/v1/search?q=${encodeURIComponent('passport')}`);
    expect(JSON.stringify(found.json())).not.toContain(docs[0] as string);
    // Back in the queue: waiting, to be drawn and read again, at a file of its own.
    const again = await batch(adult, b.id);
    for (const id of [one.id, two.id]) {
      const item = again.items.find((i) => i.id === id) as BatchItemView;
      expect(item).toMatchObject({
        state: 'waiting',
        reading: 'waiting',
        level: null,
        preview_state: 'pending',
        document_id: null,
      });
      const row = (
        await admin.query<{ storage_key: string; undo_until: Date | null }>(
          'select storage_key, undo_until from incoming_file where id = $1',
          [id],
        )
      ).rows[0];
      expect(row?.undo_until).toBeNull();
      expect(await onDisk(row?.storage_key as string)).toBe(true);
    }
    expect(again.counts).toMatchObject({ waiting: 2, accepted: 0 });
    expect(h.jobs.map((j) => j.name).sort()).toEqual(['batch.previews', 'purge.leftovers']);
    // Each version's file is written down to be deleted, by the worker.
    const owed = await admin.query<{ removed_document: string }>(
      'select distinct removed_document from purge_leftover where removed_document = any($1::uuid[])',
      [docs],
    );
    expect(owed.rows.map((r) => r.removed_document).sort()).toEqual([...docs].sort());
    // Read again, it is Ready again, and Accept all Ready takes it.
    await plant(one.id, passport(adult.member_id));
    expect((await itemOf(adult, b.id, one.id)).level).toBe('ready');
    const twice = await accepted(adult, b.id, { item_ids: [one.id] });
    expect(twice.accepted.map((a) => a.item_id)).toEqual([one.id]);
  });

  it('sealed pages too: an Only me document’s sealed words go, and its pages and thumbnail are written down to be deleted', async () => {
    const b = await made(adult, { name: 'Sealed', defaults: { visibility: 'private' } });
    const it = await readyItem(adult, b.id);
    const out = await accepted(adult, b.id);
    const id = out.accepted[0]?.document_id as string;
    // As the worker leaves an Only me version: sealed words, a thumbnail, pages.
    const v = (
      await admin.query<{ id: string; storage_key: string }>(
        'select id, storage_key from document_version where document_id = $1',
        [id],
      )
    ).rows[0] as { id: string; storage_key: string };
    await admin.query(
      `insert into document_text_sealed (version_id, household_id, document_id, content_cipher)
       values ($1, $2, $3, '\\x00')`,
      [v.id, hh, id],
    );
    const thumb = `${v.storage_key}.thumb.enc`;
    const page = `${v.storage_key}.p1.enc`;
    await admin.query('update document_version set thumbnail_key = $2 where id = $1', [
      v.id,
      thumb,
    ]);
    for (const k of [thumb, page]) {
      await mkdir(path.dirname(path.join(h.vaultDir, k)), { recursive: true });
      await writeFile(path.join(h.vaultDir, k), 'sealed');
    }
    const back = await undone(adult, b.id, [it.id]);
    expect(back.restored).toEqual([it.id]);
    expect(await namedBy(id)).toEqual([]);
    const owed = await admin.query<{ object_key: string }>(
      'select object_key from purge_leftover where removed_document = $1',
      [id],
    );
    const owedKeys = owed.rows.map((r) => r.object_key);
    for (const k of [v.storage_key, thumb, page]) expect(owedKeys).toContain(k);
    // And the item is its uploader's own still, under their member key.
    const item = await admin.query<{ kind: string; member_id: string }>(
      `select k.kind, k.member_id from incoming_file f join scope_key k on k.id = f.wrapped_by_scope
        where f.id = $1`,
      [it.id],
    );
    expect(item.rows).toEqual([{ kind: 'member', member_id: adult.member_id }]);
  });

  it('after its minutes, or accepted one at a time, or changed by somebody since, it is kept, and said so', async () => {
    const b = await made(adult, { name: 'Kept' });
    const late = await readyItem(adult, b.id);
    const edited = await readyItem(adult, b.id);
    const single = await readyItem(adult, b.id);
    const one = await call(adult, 'POST', `/api/v1/batches/${b.id}/items/${single.id}/accept`, {});
    expect(one.statusCode, one.body).toBe(201);
    const out = await accepted(adult, b.id);
    const docOf = (id: string) => out.accepted.find((a) => a.item_id === id)?.document_id as string;
    await admin.query(
      `update incoming_file set undo_until = now() - interval '1 second' where id = $1`,
      [late.id],
    );
    // The owner edits it in the meantime.
    const current = (await doc(owner, docOf(edited.id))).json<DocumentView>();
    const patched = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/documents/${docOf(edited.id)}`,
      headers: { ...h.as(owner), 'if-match': String(current.etag) },
      payload: { title: 'Renamed by the owner' },
    });
    expect(patched.statusCode, patched.body).toBe(200);

    const back = await undone(adult, b.id, [late.id, edited.id, single.id]);
    expect(back.restored).toEqual([]);
    expect(back.kept.map((k) => [k.item_id, k.reason])).toEqual([
      [late.id, 'too_late'],
      [edited.id, 'changed'],
      [single.id, 'not_undoable'],
    ]);
    for (const id of [
      docOf(late.id),
      docOf(edited.id),
      one.json<{ document_id: string }>().document_id,
    ]) {
      expect((await doc(adult, id)).statusCode).toBe(200);
    }
    // Nothing copied back was left behind for what was kept.
    const keys = await admin.query<{ storage_key: string }>(
      'select storage_key from incoming_file where batch_id = $1',
      [b.id],
    );
    const dir = path.join(h.vaultDir, hh, 'batches', b.id);
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(dir).catch(() => [] as string[]);
    const named = new Set(keys.rows.map((r) => path.basename(r.storage_key)));
    expect(files.filter((f) => f.endsWith('.enc') && !f.includes('.p') && !named.has(f))).toEqual(
      [],
    );
  });

  it('races: Accept all Ready twice at once files each item once', async () => {
    const b = await made(adult, { name: 'Twice' });
    const items = [await readyItem(adult, b.id), await readyItem(adult, b.id)];
    const ids = items.map((i) => i.id);
    const [x, y] = await Promise.all([
      accepted(adult, b.id, { item_ids: ids }),
      accepted(adult, b.id, { item_ids: ids }),
    ]);
    const filed = [...x.accepted, ...y.accepted].map((a) => a.item_id).sort();
    expect(filed).toEqual([...ids].sort());
    expect([...x.skipped, ...y.skipped].map((s) => s.reason)).toEqual(['decided', 'decided']);
    const docs = await admin.query<{ n: string }>(
      `select count(*) as n from incoming_file where batch_id = $1 and state = 'accepted'`,
      [b.id],
    );
    expect(Number(docs.rows[0]?.n)).toBe(2);
  });

  it('races: a link made while Undo holds the document waits, and finds nothing; a link made first keeps the document', async () => {
    const b = await made(adult, { name: 'Shared meanwhile' });
    const first = await readyItem(adult, b.id);
    const second = await readyItem(adult, b.id);
    const out = await accepted(adult, b.id);
    const docOf = (id: string) => out.accepted.find((a) => a.item_id === id)?.document_id as string;

    // Undo first: held with the document held; the link asked for meanwhile.
    let release: () => void = () => undefined;
    undoGate = new Promise<void>((r) => (release = r));
    const reached = new Promise<void>((r) => (undoReached = r));
    const undoing = undo(adult, b.id, [first.id]);
    await reached;
    const sharing = call(adult, 'POST', `/api/v1/documents/${docOf(first.id)}/share`, {
      recipient_label: 'the bank',
    });
    await new Promise((r) => setTimeout(r, 300));
    undoGate = null;
    release();
    const [u, s] = await Promise.all([undoing, sharing]);
    expect(u.json<BatchUndoResult>().restored).toEqual([first.id]);
    expect(s.statusCode, s.body).toBe(404);
    const links = await admin.query('select 1 from share_link where document_id = $1', [
      docOf(first.id),
    ]);
    expect(links.rowCount).toBe(0);

    // A link first: the document is kept.
    const shared = await call(adult, 'POST', `/api/v1/documents/${docOf(second.id)}/share`, {
      recipient_label: 'the bank',
    });
    expect(shared.statusCode, shared.body).toBe(201);
    const kept = await undone(adult, b.id, [second.id]);
    expect(kept.kept.map((k) => k.reason)).toEqual(['changed']);
    expect((await doc(adult, docOf(second.id))).statusCode).toBe(200);
  });

  it('the database holds it: an item goes back only with its document gone, and only Accept all Ready says until when', async () => {
    const b = await made(adult, { name: 'Held' });
    const it = await readyItem(adult, b.id);
    const out = await accepted(adult, b.id);
    const docId = out.accepted[0]?.document_id as string;
    const account = (
      await admin.query<{ account_id: string }>(
        'select account_id from account_household where member_id = $1',
        [adult.member_id],
      )
    ).rows[0]?.account_id as string;
    const asUploader = async (sql: string) => {
      const client = await app.connect();
      try {
        await client.query('begin');
        await client.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                  set_config('app.member_id', $2, true), set_config('app.role', 'adult', true),
                  set_config('app.account_id', $3, true)`,
          [hh, adult.member_id, account],
        );
        await client.query(sql);
        await client.query('commit');
        return null;
      } catch (err) {
        await client.query('rollback').catch(() => undefined);
        return (err as Error).message;
      } finally {
        client.release();
      }
    };
    // Back to waiting, its document kept: refused at commit.
    const kept = await asUploader(
      `update incoming_file set state = 'received', decided_by = null, decided_at = null,
              document_id = null, version_id = null, undo_until = null, object_removed_at = null,
              storage_key = '${hh}/batches/${b.id}/again.enc', preview_state = 'none',
              preview_pages = null, read_state = 'waiting', read_failure = null,
              read_started_at = null, read_attempts = 0, read_not_before = null
        where id = '${it.id}'`,
    );
    expect(kept).toMatch(/must take its document with it/);
    // Its time made longer: refused.
    const longer = await asUploader(
      `update incoming_file set undo_until = now() + interval '1 day' where id = '${it.id}'`,
    );
    expect(longer).toMatch(/may only file or refuse/);
    // Past its time, taken back with its document gone: refused all the same.
    await admin.query(
      `update incoming_file set undo_until = now() - interval '1 second' where id = $1`,
      [it.id],
    );
    const late = await asUploader(
      `update incoming_file set state = 'received', decided_by = null, decided_at = null,
              document_id = null, version_id = null, undo_until = null, object_removed_at = null,
              storage_key = '${hh}/batches/${b.id}/late.enc', preview_state = 'none',
              preview_pages = null, read_state = 'waiting', read_failure = null,
              read_started_at = null, read_attempts = 0, read_not_before = null
        where id = '${it.id}';
       delete from document where id = '${docId}'`,
    );
    expect(late).toMatch(/may only file or refuse/);
    expect((await doc(adult, docId)).statusCode).toBe(200);
  });

  it('GET /batches?with=levels counts each batch’s levels; a batch says how many were removed', async () => {
    const b = await made(adult, { name: 'Counted' });
    await readyItem(adult, b.id);
    await readyItem(adult, b.id, passport(adult.member_id, 0.8));
    const gone = await sent(adult, b.id);
    await sent(adult, b.id);
    const removed = await call(adult, 'DELETE', `/api/v1/batches/${b.id}/items/${gone.id}`);
    expect(removed.statusCode).toBe(204);
    const plain = (await call(adult, 'GET', '/api/v1/batches')).json<{ items: BatchView[] }>();
    const mine = plain.items.find((x) => x.id === b.id) as BatchView;
    expect(mine.levels).toBeUndefined();
    expect(mine.counts.removed).toBe(1);
    const withLevels = (await call(adult, 'GET', '/api/v1/batches?with=levels')).json<{
      items: BatchView[];
    }>();
    expect(withLevels.items.find((x) => x.id === b.id)?.levels).toEqual({
      ready: 1,
      check: 1,
      unrecognised: 0,
      problem: 0,
      unread: 1,
    });
    expect((await batch(adult, b.id)).counts.removed).toBe(1);
    expect((await call(adult, 'GET', '/api/v1/batches?with=everything')).statusCode).toBe(422);
  });
});
