import { randomUUID } from 'node:crypto';
import {
  EnvKeyProvider,
  itemPriorBinding,
  itemProposalsBinding,
  itemTextBinding,
  openBytes,
  ScopeKeys,
  sealBytes,
  unwrapKey,
} from '@fdv/crypto';
import { createPool, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type {
  ActivityLine,
  BatchAccepted,
  BatchDetail,
  BatchItemView,
  BatchLearning,
  BatchUndoResult,
  BatchView,
  DetailProposal,
  DocumentView,
  Tokens,
  VersionView,
} from '@fdv/shared';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, TEST_MASTER, type Harness } from '../test-harness.js';

/**
 * Duplicates as versions (0.8.0, S1; CAP-08), in the API. An item that is
 * the same file as a document its uploader can see says so — and nothing
 * about one they cannot. One that is probably the same paper, or its
 * renewal, by what its pages proposed, names the documents of theirs they
 * may change (`renewals`), and may be added to one as its new version
 * (`into_document_id`): the document's newest version, its dates and number
 * from the card, its reminders resolved as a renewal's are, and an Undo that
 * puts all of it back. The worker is not here: what it seals is planted as
 * it seals it (as batch-review.test.ts does).
 */

const PDF = (marker: string) => Buffer.from(`%PDF-1.4\n% ${marker} ${randomUUID()}\n%%EOF\n`);
const day = (date: string) => ({ date, precision: 'day' as const });
const inDays = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

describe.skipIf(!testAdminUrl())('duplicates as versions (S1)', () => {
  let h: Harness;
  let owner: Tokens;
  let adult: Tokens;
  let teen: Tokens;
  let hh: string;
  let admin: ReturnType<typeof createPool>;
  let app: ReturnType<typeof createPool>;
  const keys = new ScopeKeys(new EnvKeyProvider(TEST_MASTER));

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    owner = await h.setup();
    hh = owner.household_id;
    adult = await h.join(owner, { name: 'Sana', email: 'sana-s1@example.test', role: 'adult' });
    teen = await h.join(owner, { name: 'Zara', email: 'zara-s1@example.test', role: 'teen' });
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
  const batchOf = async (who: Tokens, id: string) => {
    const res = await call(who, 'GET', `/api/v1/batches/${id}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<BatchDetail>();
  };
  const itemOf = async (who: Tokens, batchId: string, itemId: string) =>
    (await batchOf(who, batchId)).items.find((i) => i.id === itemId) as BatchItemView;
  const accept = (who: Tokens, batchId: string, itemId: string, body: Record<string, unknown>) =>
    call(who, 'POST', `/api/v1/batches/${batchId}/items/${itemId}/accept`, body);
  const undone = async (who: Tokens, batchId: string, ids: string[]) => {
    const res = await call(who, 'POST', `/api/v1/batches/${batchId}/accept-ready/undo`, {
      item_ids: ids,
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<BatchUndoResult>();
  };
  const docOf = async (who: Tokens, id: string) => {
    const res = await call(who, 'GET', `/api/v1/documents/${id}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<DocumentView>();
  };
  const versionsOf = async (who: Tokens, id: string) =>
    (await call(who, 'GET', `/api/v1/documents/${id}/versions`)).json<{ items: VersionView[] }>()
      .items;
  const activity = async (who: Tokens) =>
    (await call(who, 'GET', '/api/v1/audit?limit=100'))
      .json<{ items: ActivityLine[] }>()
      .items.map((l) => l.text);
  const reminders = async (docId: string) =>
    (
      await admin.query<{
        id: string;
        kind: string;
        fire_at: string;
        status: string;
        acknowledged_by: string | null;
      }>(
        `select id, kind, to_char(fire_at, 'YYYY-MM-DD') as fire_at, status, acknowledged_by
           from reminder where document_id = $1 order by kind, fire_at`,
        [docId],
      )
    ).rows;

  /** A document filed the ordinary way, with these details and bytes. */
  const filed = async (who: Tokens, details: Record<string, unknown>, bytes = PDF('filed')) => {
    const created = await call(who, 'POST', '/api/v1/documents', details);
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json<DocumentView>().id;
    const form = new FormData();
    form.append('file', bytes, { filename: 'scan.pdf', contentType: 'application/pdf' });
    const up = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${id}/versions`,
      headers: { ...h.as(who), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    expect(up.statusCode, up.body).toBe(201);
    return id;
  };

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
          text_sealed: sealBytes(fileKey, Buffer.from('its words'), itemTextBinding(itemId)),
          proposals_sealed: sealBytes(
            fileKey,
            Buffer.from(JSON.stringify({ v: 1, proposal })),
            itemProposalsBinding(itemId),
          ),
        })
        .where('id', '=', itemId)
        .execute();
    });

  /** A passport as its pages say it. */
  const passport = (o: {
    who?: string;
    number?: string;
    issuer?: string;
    expires?: string;
    issued?: string;
  }): DetailProposal => ({
    type_key: { value: 'passport', confidence: 0.97, cue: 'kind_words' },
    ...(o.who ? { owner_member_id: { value: o.who, confidence: 0.92, cue: 'name_labelled' } } : {}),
    ...(o.issued ? { issued: { value: day(o.issued), confidence: 0.89, cue: 'issue_label' } } : {}),
    ...(o.expires
      ? { expires: { value: day(o.expires), confidence: 0.94, cue: 'machine_lines' } }
      : {}),
    ...(o.number
      ? { identifier: { value: o.number, confidence: 0.95, cue: 'machine_lines' } }
      : {}),
    ...(o.issuer ? { issued_by: { value: o.issuer, confidence: 0.9, cue: 'machine_lines' } } : {}),
  });

  /** An item sent and read, in a batch of its own. */
  const readItem = async (who: Tokens, proposal: DetailProposal, bytes = PDF('item')) => {
    const b = await made(who, { name: `Batch ${randomUUID().slice(0, 6)}` });
    const it = await sent(who, b.id, bytes);
    await plant(it.id, proposal);
    return { batchId: b.id, item: await itemOf(who, b.id, it.id) };
  };

  const accountOf = async (who: Tokens) =>
    (
      await admin.query<{ account_id: string }>(
        'select account_id from account_household where member_id = $1',
        [who.member_id],
      )
    ).rows[0]?.account_id as string;

  it('says it adds a file as a new version (features.batch_versions)', async () => {
    const caps = (await h.app.inject({ url: '/api/v1/capabilities' })).json<{
      features: Record<string, unknown>;
    }>();
    expect(caps.features.batch_versions).toBe(true);
  });

  // ------------------------------------------------------------- exact

  it('the same file as a document they can see: already in the vault, named; Discard drops it as Remove does, and Accept anyway files a second document', async () => {
    const bytes = PDF('the same file');
    const number = `E-${randomUUID().slice(0, 6)}`;
    const docId = await filed(
      adult,
      { title: 'Sana’s exact passport', type_key: 'passport', owner_member_id: adult.member_id },
      bytes,
    );
    await call(adult, 'PATCH', `/api/v1/documents/${docId}`, { identifier: number });
    const first = await readItem(adult, passport({ who: adult.member_id, number }), bytes);
    expect(first.item.duplicate).toEqual({
      of: 'document',
      document_id: docId,
      title: 'Sana’s exact passport',
    });
    // The same file wins: it is not offered as a new version of itself.
    expect(first.item.renewals).toEqual([]);
    expect(first.item.level).toBe('problem');

    // Discard this copy: removed, as Remove removes it.
    const dropped = await call(
      adult,
      'DELETE',
      `/api/v1/batches/${first.batchId}/items/${first.item.id}`,
    );
    expect(dropped.statusCode, dropped.body).toBe(204);
    const gone = await admin.query<{ state: string; sha256: Buffer | null }>(
      'select state, sha256 from incoming_file where id = $1',
      [first.item.id],
    );
    expect(gone.rows[0]).toEqual({ state: 'rejected', sha256: null });

    // Accept anyway: a document of its own beside the first.
    const second = await readItem(adult, passport({ who: adult.member_id, number }), bytes);
    const kept = await accept(adult, second.batchId, second.item.id, {});
    expect(kept.statusCode, kept.body).toBe(201);
    expect(kept.json<BatchAccepted>().document_id).not.toBe(docId);
    expect(kept.json<BatchAccepted>().undo_until).toBeUndefined();
  });

  it('the same file as a document they cannot see — somebody’s Only me, an Adults only Essential to a teen, the Trash — shows nothing new, at the API and in its counts', async () => {
    // The owner's Only me passport, its number and issuer what the pages say.
    const onlyMe = PDF('only me');
    const hidden = await filed(
      owner,
      {
        title: 'The owner’s secret passport',
        type_key: 'passport',
        owner_member_id: owner.member_id,
        visibility: 'private',
        identifier: 'H-777 000',
        issued_by: 'United Kingdom',
      },
      onlyMe,
    );
    const a = await readItem(
      adult,
      passport({ who: owner.member_id, number: 'h777000', issuer: 'United Kingdom' }),
      onlyMe,
    );
    // An Adults only Essential, to a teen.
    const adultsOnly = PDF('adults only');
    const essential = await filed(
      owner,
      {
        title: 'The family will',
        type_key: 'will',
        visibility: 'adults',
        is_essential: true,
      },
      adultsOnly,
    );
    const t = await readItem(teen, passport({ who: teen.member_id }), adultsOnly);
    // Their own, in the Trash.
    const binned = PDF('binned');
    const trashed = await filed(
      adult,
      {
        title: 'Sana’s binned passport',
        type_key: 'passport',
        owner_member_id: adult.member_id,
        identifier: 'B-1',
      },
      binned,
    );
    expect((await call(adult, 'DELETE', `/api/v1/documents/${trashed}`)).statusCode).toBe(204);
    const bin = await readItem(adult, passport({ who: adult.member_id, number: 'B-1' }), binned);

    for (const [who, x, docId] of [
      [adult, a, hidden],
      [teen, t, essential],
      [adult, bin, trashed],
    ] as const) {
      const res = await call(who, 'GET', `/api/v1/batches/${x.batchId}`);
      const seen = res.json<BatchDetail>();
      const item = seen.items.find((i) => i.id === x.item.id) as BatchItemView;
      expect(item.duplicate).toBeNull();
      expect(item.renewals).toEqual([]);
      expect(item.level).not.toBe('problem');
      expect(seen.counts.duplicates).toBe(0);
      // Not a word of it, anywhere in what they are given.
      expect(res.body).not.toContain(docId);
      const listed = (await call(who, 'GET', '/api/v1/batches')).json<{ items: BatchView[] }>();
      expect(listed.items.find((b) => b.id === x.batchId)?.counts.duplicates).toBe(0);
      // And nothing to add it to: as if it were not there.
      const into = await accept(who, x.batchId, x.item.id, { into_document_id: docId });
      expect(into.statusCode, into.body).toBe(404);
      expect(into.body).not.toContain('secret');
    }
  });

  // -------------------------------------------------------------- near

  it('a near match by number: the same kind and number, spaces, dashes and case aside — never another kind’s', async () => {
    const mine = await filed(adult, {
      title: 'Sana’s numbered passport',
      type_key: 'passport',
      owner_member_id: adult.member_id,
      identifier: 'Pq 548-721 093',
      issued_by: 'HM Passport Office',
    });
    // Another kind with the same number is another paper.
    await filed(adult, {
      title: 'Sana’s licence, same digits',
      type_key: 'drivers_licence',
      owner_member_id: adult.member_id,
      identifier: 'PQ548721093',
    });
    const x = await readItem(
      adult,
      passport({ number: 'pq548721–093', issuer: 'Somewhere else entirely' }),
    );
    expect(x.item.duplicate).toBeNull();
    expect(x.item.renewals).toEqual([
      { document_id: mine, title: 'Sana’s numbered passport', by: 'number' },
    ]);
  });

  it('a near match by kind, person and issuer, with another number; the pages’ alone, never the batch’s defaults', async () => {
    const old = await filed(adult, {
      title: 'Sana’s old passport',
      type_key: 'passport',
      owner_member_id: adult.member_id,
      identifier: 'OLD-1',
      issued_by: 'United  Kingdom',
    });
    const byNumber = await filed(adult, {
      title: 'Sana’s other passport',
      type_key: 'passport',
      owner_member_id: adult.member_id,
      identifier: 'NUM-9',
      issued_by: 'Republic of Elsewhere',
    });
    const x = await readItem(
      adult,
      passport({ who: adult.member_id, number: 'num 9', issuer: ' united kingdom ' }),
    );
    // By number first, then by kind, person and issuer.
    expect(x.item.renewals).toEqual([
      { document_id: byNumber, title: 'Sana’s other passport', by: 'number' },
      { document_id: old, title: 'Sana’s old passport', by: 'details' },
    ]);
    // Another issuer, or nobody named: no match.
    const other = await readItem(
      adult,
      passport({ who: adult.member_id, number: 'NEW-2', issuer: 'France' }),
    );
    expect(other.item.renewals).toEqual([]);
    const nobody = await readItem(adult, passport({ number: 'NEW-3', issuer: 'United Kingdom' }));
    expect(nobody.item.renewals).toEqual([]);
    // The batch saying whose it is does not make it a match: the pages' alone.
    const b = await made(adult, { defaults: { owner_member_id: adult.member_id } });
    const it = await sent(adult, b.id);
    await plant(it.id, passport({ number: 'NEW-4', issuer: 'United Kingdom' }));
    expect((await itemOf(adult, b.id, it.id)).renewals).toEqual([]);
    // Not read yet: nothing.
    const unread = await sent(adult, b.id);
    expect((await itemOf(adult, b.id, unread.id)).renewals).toEqual([]);
  });

  // ------------------------------------------------------- as a version

  it('added as a new version: its newest version, its dates and number from the card, reminders resolved as a renewal’s, the activity — and Undo puts it all back', async () => {
    const oldExpiry = inDays(200);
    const newExpiry = inDays(3650);
    const docId = await filed(adult, {
      title: 'Sana’s renewing passport',
      type_key: 'passport',
      owner_member_id: adult.member_id,
      identifier: 'R-111',
      issued_by: 'Kingdom of Renewals',
      issued: day('2016-06-01'),
      expires: day(oldExpiry),
    });
    const manual = await call(adult, 'POST', '/api/v1/reminders', {
      document_id: docId,
      fire_at: inDays(30),
      note: 'Book the photo',
    });
    expect(manual.statusCode, manual.body).toBe(201);
    const remindersBefore = await reminders(docId);
    expect(remindersBefore.map((r) => [r.kind, r.status])).toEqual([
      ['derived', 'due'],
      ['derived', 'scheduled'],
      ['manual', 'scheduled'],
    ]);
    const [original] = await versionsOf(adult, docId);
    const ownerSaw = await activity(owner);
    const learnedBefore = (
      await call(adult, 'GET', '/api/v1/batches/learned')
    ).json<BatchLearning>();

    const x = await readItem(
      adult,
      passport({
        who: adult.member_id,
        number: 'R-222',
        issuer: 'Kingdom of Renewals',
        issued: '2026-09-01',
        expires: newExpiry,
      }),
    );
    expect(x.item.renewals).toEqual([
      { document_id: docId, title: 'Sana’s renewing passport', by: 'details' },
    ]);
    h.jobs.length = 0;
    const res = await accept(adult, x.batchId, x.item.id, {
      into_document_id: docId,
      issued: day('2026-09-01'),
      expires: day(newExpiry),
      identifier: 'R-222',
    });
    expect(res.statusCode, res.body).toBe(201);
    const added = res.json<BatchAccepted>();
    expect(added.document_id).toBe(docId);
    expect(new Date(added.undo_until as string).getTime()).toBeGreaterThan(Date.now());

    // Its newest version, and what the card said.
    const versions = await versionsOf(adult, docId);
    expect(versions.map((v) => v.id)).toEqual([added.version_id, original?.id]);
    expect(await docOf(adult, docId)).toMatchObject({
      identifier: 'R-222',
      issued: day('2026-09-01'),
      expires: day(newExpiry),
      title: 'Sana’s renewing passport',
    });
    expect(h.jobs.map((j) => j.name)).toContain('version.process');
    expect((await itemOf(adult, x.batchId, x.item.id)).state).toBe('accepted');
    // A renewal: the old date's reminders resolved and gone, the new date's
    // made, and the manual one resolved — as uploading a copy and editing do.
    const after = await reminders(docId);
    expect(after.filter((r) => r.kind === 'derived').map((r) => [r.fire_at, r.status])).toEqual([
      [new Date(Date.parse(newExpiry) - 270 * 864e5).toISOString().slice(0, 10), 'scheduled'],
      [new Date(Date.parse(newExpiry) - 180 * 864e5).toISOString().slice(0, 10), 'scheduled'],
    ]);
    expect(after.find((r) => r.kind === 'manual')?.status).toBe('resolved');
    // The activity says so, as it says an upload and an edit.
    const lines = (await activity(owner)).slice(
      0,
      (await activity(owner)).length - ownerSaw.length,
    );
    expect(lines).toEqual(
      expect.arrayContaining([
        'Sana uploaded a new copy of “Sana’s renewing passport”',
        'Sana edited “Sana’s renewing passport”',
      ]),
    );
    // A confirmation, counted, as an accept is (I4).
    const learnedAfter = (
      await call(adult, 'GET', '/api/v1/batches/learned')
    ).json<BatchLearning>();
    expect(learnedAfter.counted).toBe(learnedBefore.counted + 1);
    expect(learnedAfter.unchanged).toBe(learnedBefore.unchanged + 1);
    // What an Undo needs is kept sealed: never the old number in the clear.
    const row = (
      await admin.query<{
        as_version: boolean;
        prior_sealed: Buffer;
        file_key_wrapped: Buffer;
        wrapped_by_scope: string;
      }>(
        'select as_version, prior_sealed, file_key_wrapped, wrapped_by_scope from incoming_file where id = $1',
        [x.item.id],
      )
    ).rows[0];
    expect(row?.as_version).toBe(true);
    expect(row?.prior_sealed.includes(Buffer.from('R-111'))).toBe(false);
    expect(row?.prior_sealed.includes(Buffer.from(oldExpiry))).toBe(false);
    const prior = await withSystem(
      h.db,
      hh,
      async (trx) =>
        JSON.parse(
          openBytes(
            unwrapKey(
              row?.file_key_wrapped as Buffer,
              await keys.unwrapById(trx, row?.wrapped_by_scope as string),
              `incoming:${x.item.id}`,
            ),
            row?.prior_sealed as Buffer,
            itemPriorBinding(x.item.id),
          ).toString('utf8'),
        ) as { fields: unknown },
    );
    expect(prior.fields).toEqual({
      identifier: 'R-111',
      issued: day('2016-06-01'),
      expires: day(oldExpiry),
    });

    // Undo: the version gone, the document as it was, its reminders open again.
    const back = await undone(adult, x.batchId, [x.item.id]);
    expect(back).toEqual({ restored: [x.item.id], kept: [] });
    expect((await versionsOf(adult, docId)).map((v) => v.id)).toEqual([original?.id]);
    expect(await docOf(adult, docId)).toMatchObject({
      identifier: 'R-111',
      issued: day('2016-06-01'),
      expires: day(oldExpiry),
    });
    const restored = await reminders(docId);
    expect(restored.map((r) => [r.kind, r.fire_at, r.status])).toEqual(
      remindersBefore.map((r) => [r.kind, r.fire_at, r.status]),
    );
    expect(restored.find((r) => r.kind === 'manual')).toMatchObject({
      id: remindersBefore.find((r) => r.kind === 'manual')?.id,
      acknowledged_by: null,
    });
    // Back in the queue, to be read again; what it taught taken back.
    expect(await itemOf(adult, x.batchId, x.item.id)).toMatchObject({
      state: 'waiting',
      reading: 'waiting',
      document_id: null,
    });
    const learnedUndone = (
      await call(adult, 'GET', '/api/v1/batches/learned')
    ).json<BatchLearning>();
    expect(learnedUndone.counted).toBe(learnedBefore.counted);
    // That version's objects written down to be deleted — and never the original's.
    const owed = (
      await admin.query<{ object_key: string }>(
        'select object_key from purge_leftover where removed_document = $1',
        [docId],
      )
    ).rows.map((r) => r.object_key);
    const keysOf = await admin.query<{ id: string; storage_key: string }>(
      'select id, storage_key from document_version where document_id = $1',
      [docId],
    );
    expect(keysOf.rows).toHaveLength(1);
    expect(owed.some((k) => k.startsWith(keysOf.rows[0]?.storage_key as string))).toBe(false);
    expect(owed.length).toBeGreaterThan(0);
    // And the activity says it was taken back.
    expect(await activity(owner)).toContain(
      'Sana took back the new copy of “Sana’s renewing passport”',
    );
    const raw = await admin.query<{ n: string }>(
      `select count(*) as n from incoming_file where id = $1 and (as_version or prior_sealed is not null)`,
      [x.item.id],
    );
    expect(Number(raw.rows[0]?.n)).toBe(0);
  });

  it('kept, and said so, once the document has moved on: an edit by anybody, another version, a look by somebody else, or its minutes gone', async () => {
    const make = async (title: string) => {
      const docId = await filed(adult, {
        title,
        type_key: 'passport',
        owner_member_id: adult.member_id,
        issued_by: 'United Kingdom',
      });
      const x = await readItem(
        adult,
        passport({ who: adult.member_id, issuer: 'United Kingdom', number: randomUUID() }),
      );
      const res = await accept(adult, x.batchId, x.item.id, { into_document_id: docId });
      expect(res.statusCode, res.body).toBe(201);
      return { docId, ...x, version: res.json<BatchAccepted>().version_id };
    };
    const edited = await make('Edited since');
    const newer = await make('A newer copy since');
    const looked = await make('Looked at since');
    const late = await make('Too late');
    const editedNow = await docOf(owner, edited.docId);
    const patched = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/documents/${edited.docId}`,
      headers: { ...h.as(owner), 'if-match': String(editedNow.etag) },
      payload: { title: 'Renamed by the owner' },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    const form = new FormData();
    form.append('file', PDF('newer'), { filename: 'scan.pdf', contentType: 'application/pdf' });
    const up = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${newer.docId}/versions`,
      headers: { ...h.as(adult), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    expect(up.statusCode, up.body).toBe(201);
    const got = await call(owner, 'GET', `/api/v1/versions/${looked.version}/content`);
    expect(got.statusCode, got.body).toBe(200);
    await admin.query(
      `update incoming_file set undo_until = now() - interval '1 second' where id = $1`,
      [late.item.id],
    );
    for (const x of [edited, newer, looked, late]) {
      const back = await undone(adult, x.batchId, [x.item.id]);
      expect(back.restored).toEqual([]);
      const why = back.kept[0];
      expect(why?.reason).toBe(x === late ? 'too_late' : 'changed');
      expect(why?.message).toMatch(/newest version/);
      expect((await versionsOf(adult, x.docId)).map((v) => v.id)).toContain(x.version);
    }
  });

  // ------------------------------------------------------------- who may

  it('no edit rights, no offer: a teen is offered only their own; adding to somebody else’s is 403, to one they cannot see 404, and with other details 422', async () => {
    const parents = await filed(owner, {
      title: 'The owner’s passport',
      type_key: 'passport',
      owner_member_id: owner.member_id,
      identifier: 'T-1',
      issued_by: 'United Kingdom',
    });
    const theirs = await filed(teen, {
      title: 'Zara’s passport',
      type_key: 'passport',
      owner_member_id: teen.member_id,
      identifier: 'T-2',
      issued_by: 'United Kingdom',
    });
    // The number is the owner's; the kind, person and issuer the teen's own.
    const x = await readItem(
      teen,
      passport({ who: teen.member_id, number: 'T-1', issuer: 'United Kingdom' }),
    );
    expect(x.item.renewals).toEqual([
      { document_id: theirs, title: 'Zara’s passport', by: 'details' },
    ]);
    // The teen may see the owner's (Everyone), but not change it.
    expect((await call(teen, 'GET', `/api/v1/documents/${parents}`)).statusCode).toBe(200);
    const refused = await accept(teen, x.batchId, x.item.id, { into_document_id: parents });
    expect(refused.statusCode, refused.body).toBe(403);
    expect((await versionsOf(owner, parents)).length).toBe(1);
    const nowhere = await accept(teen, x.batchId, x.item.id, { into_document_id: randomUUID() });
    expect(nowhere.statusCode, nowhere.body).toBe(404);
    const mixed = await accept(teen, x.batchId, x.item.id, {
      into_document_id: theirs,
      title: 'Another name',
    });
    expect(mixed.statusCode, mixed.body).toBe(422);
    // Still waiting, and their own takes it.
    const ok = await accept(teen, x.batchId, x.item.id, {
      into_document_id: theirs,
      identifier: 'T-1',
    });
    expect(ok.statusCode, ok.body).toBe(201);
    expect((await docOf(teen, theirs)).identifier).toBe('T-1');
  });

  // -------------------------------------------------------- the database

  it('the database holds it: a version added says so; it goes back only with its version gone; its uploader writes down only that version’s objects', async () => {
    const docId = await filed(adult, {
      title: 'Held by the database',
      type_key: 'passport',
      owner_member_id: adult.member_id,
      issued_by: 'United Kingdom',
    });
    const [first] = await versionsOf(adult, docId);
    const x = await readItem(adult, passport({ who: adult.member_id, issuer: 'United Kingdom' }));
    const res = await accept(adult, x.batchId, x.item.id, { into_document_id: docId });
    expect(res.statusCode, res.body).toBe(201);
    const account = await accountOf(adult);
    const asUploader = async (text: string) => {
      const client = await app.connect();
      try {
        await client.query('begin');
        await client.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                  set_config('app.member_id', $2, true), set_config('app.role', 'adult', true),
                  set_config('app.account_id', $3, true)`,
          [hh, adult.member_id, account],
        );
        await client.query(text);
        await client.query('commit');
        return null;
      } catch (err) {
        await client.query('rollback').catch(() => undefined);
        return (err as Error).message;
      } finally {
        client.release();
      }
    };
    // Said to be a new document, it could be taken back with the document: refused.
    expect(
      await asUploader(`update incoming_file set as_version = false where id = '${x.item.id}'`),
    ).toMatch(/may only file or refuse/);
    // Back to waiting with its version kept: refused at commit.
    expect(
      await asUploader(
        `update incoming_file set state = 'received', decided_by = null, decided_at = null,
                document_id = null, version_id = null, undo_until = null, object_removed_at = null,
                as_version = false, prior_sealed = null,
                storage_key = '${hh}/batches/${x.batchId}/again.enc', preview_state = 'none',
                preview_pages = null, read_state = 'waiting', read_failure = null,
                read_started_at = null, read_attempts = 0, read_not_before = null
          where id = '${x.item.id}'`,
      ),
    ).toMatch(/must take its version with it/);
    // Another version's file, or the document's own: never theirs to write down.
    const otherKey = (
      await admin.query<{ storage_key: string; vault_id: string }>(
        'select storage_key, vault_id from document_version where id = $1',
        [first?.id],
      )
    ).rows[0] as { storage_key: string; vault_id: string };
    expect(
      await asUploader(
        `insert into purge_leftover (household_id, vault_id, object_key, removed_document)
         values ('${hh}', '${otherKey.vault_id}', '${otherKey.storage_key}', '${docId}')`,
      ),
    ).toMatch(/row-level security/);
    // Their own version's file: theirs to write down, while it may be taken back.
    const ours = (
      await admin.query<{ storage_key: string; vault_id: string }>(
        'select storage_key, vault_id from document_version where id = $1',
        [res.json<BatchAccepted>().version_id],
      )
    ).rows[0] as { storage_key: string; vault_id: string };
    expect(
      await asUploader(
        `insert into purge_leftover (household_id, vault_id, object_key, removed_document)
         values ('${hh}', '${ours.vault_id}', '${ours.storage_key}.p1.enc', '${docId}')`,
      ),
    ).toBeNull();
    await admin.query('delete from purge_leftover where removed_document = $1', [docId]);
    // A new document's accept may not say it is a version; a version may not say it is new.
    const fresh = await readItem(adult, passport({ who: adult.member_id }));
    const plain = await accept(adult, fresh.batchId, fresh.item.id, {});
    expect(plain.statusCode, plain.body).toBe(201);
    const flagged = await admin.query<{ as_version: boolean }>(
      'select as_version from incoming_file where id = $1',
      [fresh.item.id],
    );
    expect(flagged.rows[0]?.as_version).toBe(false);
    // Filed by hand into the document that was there before, saying it made
    // it — so that an Undo would take the whole document: refused. Saying it
    // is a version, it is let through (rolled back here).
    const waiting = await readItem(adult, passport({ who: adult.member_id }));
    const source = (
      await admin.query<Record<string, unknown>>(
        `select vault_id, file_key_wrapped, wrapped_by_scope, cipher_sha256, sha256
           from document_version where id = $1`,
        [first?.id],
      )
    ).rows[0] as {
      vault_id: string;
      file_key_wrapped: Buffer;
      wrapped_by_scope: string;
      cipher_sha256: Buffer;
      sha256: Buffer;
    };
    const fileBy = (claim: boolean, rollback: boolean) => {
      const versionId = randomUUID();
      return asUploader(
        `insert into document_version (id, household_id, document_id, version_no, filename, mime,
                byte_size, sha256, cipher_bytes, cipher_sha256, storage_key, vault_id,
                file_key_wrapped, wrapped_by_scope, uploaded_by)
         values ('${versionId}', '${hh}', '${docId}', 90, 'by-hand.pdf', 'application/pdf', 10,
                 '\\x${source.sha256.toString('hex')}', 38, '\\x${source.cipher_sha256.toString('hex')}',
                 '${hh}/${docId}/by-hand-${versionId}.pdf', '${source.vault_id}',
                 '\\x${source.file_key_wrapped.toString('hex')}', '${source.wrapped_by_scope}',
                 '${account}');
         update incoming_file set state = 'accepted', decided_by = '${account}', decided_at = now(),
                document_id = '${docId}', version_id = '${versionId}', proposals_sealed = null,
                text_sealed = null, as_version = ${claim}
          where id = '${waiting.item.id}';
         ${rollback ? `select 1/0;` : ''}`,
      );
    };
    expect(await fileBy(false, false)).toMatch(/may only file or refuse/);
    expect(await fileBy(true, true)).toMatch(/division by zero/);
    // Who else could ask what reached others: nobody but the application.
    const asked = await admin.query<{ reached: boolean | null }>(
      `select has_function_privilege('public', 'incoming_file_version_reached(uuid)', 'execute') as reached`,
    );
    expect(asked.rows[0]?.reached).toBe(false);
  });
});
