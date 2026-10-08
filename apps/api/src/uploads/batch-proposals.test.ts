import { randomUUID } from 'node:crypto';
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
  CLASH_CONFIDENCE,
  type BatchDetail,
  type BatchItemView,
  type BatchReadFailure,
  type DetailProposal,
  type DocumentTypeView,
  type DocumentView,
  type Tokens,
} from '@fdv/shared';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, TEST_MASTER, type Harness } from '../test-harness.js';

/**
 * The vault reads each item and suggests (Phase 6, I2), in the API: each
 * item's level, tags, clashes and what its card starts from, worked out as
 * it is asked from what the worker sealed, the batch's defaults and the
 * kinds as they are now — for its uploader alone. The worker is not here:
 * what it seals is planted as it seals it (apps/worker/src/jobs/read-item.ts),
 * and its own tests read real pages.
 */

const PDF = (marker: string) => Buffer.from(`%PDF-1.4\n% ${marker} ${randomUUID()}\n%%EOF\n`);
const day = (date: string) => ({ date, precision: 'day' as const });

describe.skipIf(!testAdminUrl())('what the pages propose, for a batch’s uploader (I2)', () => {
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
    adult = await h.join(owner, { name: 'Sana', email: 'sana@example.test', role: 'adult' });
    teen = await h.join(owner, { name: 'Zara', email: 'zara@example.test', role: 'teen' });
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

  /**
   * What the worker writes once it has read an item: its words and what
   * they propose, sealed under the item's own key — or why it could not.
   */
  const plant = async (
    itemId: string,
    read: { proposal: DetailProposal; text?: string } | { failure: BatchReadFailure },
  ) =>
    withSystem(h.db, hh, async (trx) => {
      const f = await trx
        .selectFrom('incoming_file')
        .select(['file_key_wrapped', 'wrapped_by_scope'])
        .where('id', '=', itemId)
        .executeTakeFirstOrThrow();
      if ('failure' in read) {
        await trx
          .updateTable('incoming_file')
          .set({ read_state: 'failed', read_failure: read.failure })
          .where('id', '=', itemId)
          .execute();
        return;
      }
      const fileKey = unwrapKey(
        f.file_key_wrapped,
        await keys.unwrapById(trx, f.wrapped_by_scope),
        `incoming:${itemId}`,
      );
      await trx
        .updateTable('incoming_file')
        .set({
          read_state: 'read',
          text_sealed: sealBytes(
            fileKey,
            Buffer.from(read.text ?? 'the words on its pages'),
            itemTextBinding(itemId),
          ),
          proposals_sealed: sealBytes(
            fileKey,
            Buffer.from(JSON.stringify({ v: 1, proposal: read.proposal })),
            itemProposalsBinding(itemId),
          ),
        })
        .where('id', '=', itemId)
        .execute();
    });
  const sealedOf = async (itemId: string) =>
    (
      await admin.query<{ text_sealed: Buffer | null; proposals_sealed: Buffer | null }>(
        'select text_sealed, proposals_sealed from incoming_file where id = $1',
        [itemId],
      )
    ).rows[0];

  /** A passport read well, for `who`. */
  const passport = (who: string, c = 0.9): DetailProposal => ({
    type_key: { value: 'passport', confidence: 0.97, cue: 'kind_words' },
    owner_member_id: { value: who, confidence: c, cue: 'name_labelled' },
    issued: { value: day('2021-03-14'), confidence: 0.89, cue: 'issue_label' },
    expires: { value: day('2031-03-14'), confidence: 0.94, cue: 'machine_lines' },
    identifier: { value: 'P-SECRET-533401872', confidence: 0.95, cue: 'machine_lines' },
    issued_by: { value: 'United Kingdom', confidence: 0.9, cue: 'machine_lines' },
  });

  it('says it reads each item and suggests', async () => {
    const caps = (await h.app.inject({ url: '/api/v1/capabilities' })).json<{
      features: Record<string, unknown>;
    }>();
    expect(caps.features.batch_proposals).toBe(true);
  });

  it('each case, levelled and tagged: Ready, Check, Not recognised, a Problem, and not read yet', async () => {
    const b = await made(adult, { name: 'Every level' });
    const ready = await sent(adult, b.id);
    const unsure = await sent(adult, b.id);
    const unknown = await sent(adult, b.id);
    const blank = await sent(adult, b.id);
    const waiting = await sent(adult, b.id);
    const bytes = PDF('twice');
    const first = await sent(adult, b.id, bytes);
    const dup = await sent(adult, b.id, bytes);
    await plant(ready.id, { proposal: passport(adult.member_id) });
    await plant(unsure.id, { proposal: passport(adult.member_id, 0.8) });
    await plant(unknown.id, { proposal: {} });
    await plant(blank.id, { failure: 'blank' });
    await plant(first.id, { proposal: passport(adult.member_id) });
    await plant(dup.id, { proposal: passport(adult.member_id) });

    const got = await batch(adult, b.id);
    const by = (id: string) => got.items.find((i) => i.id === id) as BatchItemView;
    expect(by(ready.id)).toMatchObject({
      reading: 'read',
      read_failure: null,
      level: 'ready',
      tags: [],
      clashes: [],
      proposals: {
        type_key: { value: 'passport', from: 'pages', confidence: 0.97, cue: 'kind_words' },
        owner_member_id: { value: adult.member_id, from: 'pages', confidence: 0.9 },
        expires: { value: day('2031-03-14'), from: 'pages', confidence: 0.94 },
        identifier: { value: 'P-SECRET-533401872', from: 'pages' },
        visibility: { value: 'household', from: 'kind' },
      },
    });
    expect(by(unsure.id)).toMatchObject({
      level: 'check',
      tags: [{ code: 'person_unsure', kind: 'check', words: 'Person unsure' }],
    });
    expect(by(unknown.id)).toMatchObject({ level: 'unrecognised', tags: [] });
    expect(by(blank.id)).toMatchObject({
      reading: 'failed',
      read_failure: 'blank',
      level: 'problem',
      tags: [{ code: 'unread', kind: 'problem', words: 'Couldn’t read the pages' }],
    });
    expect(by(waiting.id)).toMatchObject({ reading: 'waiting', level: null, tags: [] });
    expect(by(first.id).level).toBe('ready');
    expect(by(dup.id)).toMatchObject({
      level: 'problem',
      tags: [{ code: 'duplicate_in_batch', kind: 'problem', words: 'Also in this batch' }],
    });
    // The item as POST …/items answered it carries them too.
    expect(waiting).toMatchObject({ level: null, tags: [], clashes: [], read_failure: null });
  });

  it('defaults fill only blanks; a disagreement at the clash bar goes to Check with both, under it the default stands silently', async () => {
    const members = (await call(owner, 'GET', '/api/v1/members')).json<{
      items: Array<{ id: string; display_name: string }>;
    }>().items;
    const name = (id: string) => members.find((x) => x.id === id)?.display_name;
    const b = await made(owner, { defaults: { owner_member_id: owner.member_id } });
    const blankPerson = await sent(owner, b.id);
    const clash = await sent(owner, b.id);
    const weak = await sent(owner, b.id);
    const nobody = passport(adult.member_id);
    delete nobody.owner_member_id;
    await plant(blankPerson.id, { proposal: nobody });
    await plant(clash.id, { proposal: passport(adult.member_id, CLASH_CONFIDENCE) });
    await plant(weak.id, { proposal: passport(adult.member_id, CLASH_CONFIDENCE - 0.01) });
    const got = await batch(owner, b.id);
    const by = (id: string) => got.items.find((i) => i.id === id) as BatchItemView;
    expect(by(blankPerson.id)).toMatchObject({
      level: 'ready',
      proposals: { owner_member_id: { value: owner.member_id, from: 'batch', confidence: null } },
    });
    expect(by(clash.id)).toMatchObject({
      level: 'check',
      clashes: [
        {
          field: 'owner_member_id',
          pages: { value: adult.member_id, confidence: CLASH_CONFIDENCE },
          batch: owner.member_id,
        },
      ],
      tags: [
        {
          code: 'clash_person',
          words: `The pages say ${name(adult.member_id)}, the batch says ${name(owner.member_id)}`,
        },
      ],
      proposals: { owner_member_id: { value: owner.member_id, from: 'batch' } },
    });
    expect(by(weak.id)).toMatchObject({
      level: 'ready',
      clashes: [],
      tags: [],
      proposals: { owner_member_id: { value: owner.member_id, from: 'batch' } },
    });
  });

  it('a default or a kind changed re-levels every item, nothing read again', async () => {
    const own = (
      await call(owner, 'POST', '/api/v1/document-types', {
        label: 'Garage lease',
        category: 'property',
      })
    ).json<DocumentTypeView>();
    const b = await made(owner);
    const i = await sent(owner, b.id);
    await plant(i.id, {
      proposal: {
        type_key: { value: own.key, confidence: 0.95, cue: 'kind_words' },
        owner_member_id: { value: owner.member_id, confidence: 0.9, cue: 'name_labelled' },
      },
    });
    const sealed = await sealedOf(i.id);
    expect((await itemOf(owner, b.id, i.id)).level).toBe('ready');
    // The kind now requires its number: Check, saying so in its own words.
    const changed = await call(owner, 'PATCH', `/api/v1/document-types/${own.key}`, {
      core: { identifier: { label: 'Lease number', required: true } },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(await itemOf(owner, b.id, i.id)).toMatchObject({
      level: 'check',
      tags: [
        {
          code: 'missing',
          field: 'identifier',
          words: 'Missing: lease number (required for a garage lease)',
        },
      ],
    });
    // The batch's kind made a passport: the pages disagree, confidently.
    const patched = await call(owner, 'PATCH', `/api/v1/batches/${b.id}`, {
      defaults: { type_key: 'passport' },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(await itemOf(owner, b.id, i.id)).toMatchObject({
      level: 'check',
      clashes: [{ field: 'type_key', batch: 'passport' }],
      proposals: { type_key: { value: 'passport', from: 'batch' } },
    });
    // Nothing was read again: what the worker sealed is as it was.
    expect(await sealedOf(i.id)).toEqual(sealed);
    expect(h.jobs.filter((j) => j.name === 'batch.previews' && j.data.item_id)).toEqual([]);
  });

  it('who can see it: a kind usually kept narrower narrows the batch’s choice, and says so', async () => {
    const b = await made(adult, { defaults: { visibility: 'household' } });
    const i = await sent(adult, b.id);
    await plant(i.id, {
      proposal: {
        type_key: { value: 'medical_record', confidence: 0.97, cue: 'kind_words' },
        owner_member_id: { value: adult.member_id, confidence: 0.9, cue: 'name_labelled' },
      },
    });
    expect(await itemOf(adult, b.id, i.id)).toMatchObject({
      proposals: { visibility: { value: 'adults', from: 'narrowed' } },
      tags: [
        {
          code: 'narrowed',
          kind: 'info',
          words: 'Kept to adults: it looks like a medical record / immunisation',
        },
      ],
    });
  });

  it('a teen’s items are their own: whose it is is them, whatever the pages say', async () => {
    const b = await made(teen);
    const i = await sent(teen, b.id);
    await plant(i.id, { proposal: passport(adult.member_id) });
    const got = await itemOf(teen, b.id, i.id);
    expect(got.proposals?.owner_member_id).toEqual({
      value: teen.member_id,
      from: 'batch',
      confidence: null,
      cue: null,
    });
    expect(got.clashes).toEqual([]);
  });

  it('an accept takes what it is sent and the batch’s defaults — never a proposal nobody chose — and lets go of what was read', async () => {
    const b = await made(adult, { defaults: { tags: ['from-batch'] } });
    const i = await sent(adult, b.id);
    await plant(i.id, { proposal: passport(adult.member_id), text: 'PASSPORT 533401872' });
    const res = await call(adult, 'POST', `/api/v1/batches/${b.id}/items/${i.id}/accept`, {
      title: 'Only what was sent',
    });
    expect(res.statusCode, res.body).toBe(201);
    const doc = (
      await call(
        adult,
        'GET',
        `/api/v1/documents/${res.json<{ document_id: string }>().document_id}`,
      )
    ).json<DocumentView>();
    expect(doc).toMatchObject({
      title: 'Only what was sent',
      type_key: null,
      owner_member_id: null,
      identifier: null,
      issued_by: null,
      expires: null,
      tags: ['from-batch'],
    });
    expect(await sealedOf(i.id)).toEqual({ text_sealed: null, proposals_sealed: null });
    expect(await itemOf(adult, b.id, i.id)).toMatchObject({
      state: 'accepted',
      level: null,
      tags: [],
      proposals: null,
      clashes: [],
    });
  });

  it('removing an item, or its batch, lets go of what was read with it', async () => {
    const b = await made(adult);
    const one = await sent(adult, b.id);
    const two = await sent(adult, b.id);
    await plant(one.id, { proposal: passport(adult.member_id) });
    await plant(two.id, { proposal: passport(adult.member_id) });
    const removed = await call(adult, 'DELETE', `/api/v1/batches/${b.id}/items/${one.id}`);
    expect(removed.statusCode, removed.body).toBe(204);
    expect(await sealedOf(one.id)).toEqual({ text_sealed: null, proposals_sealed: null });
    const gone = await call(adult, 'DELETE', `/api/v1/batches/${b.id}`);
    expect(gone.statusCode, gone.body).toBe(204);
    expect(await sealedOf(two.id)).toBeUndefined();
  });

  it('nobody but the uploader is given any of it — an owner neither — and the database gives them nothing of it', async () => {
    const b = await made(adult);
    const i = await sent(adult, b.id);
    await plant(i.id, { proposal: passport(adult.member_id), text: 'P-SECRET-533401872' });
    for (const who of [owner, teen]) {
      const res = await call(who, 'GET', `/api/v1/batches/${b.id}`);
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('P-SECRET');
      const listed = await call(who, 'GET', '/api/v1/batches');
      expect(listed.body).not.toContain(b.id);
    }
    // Asked of the database as the owner: no row, so no sealed words.
    const client = await app.connect();
    try {
      await client.query('begin');
      await client.query(
        `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                set_config('app.member_id', $2, true), set_config('app.role', 'owner', true)`,
        [hh, owner.member_id],
      );
      const rows = await client.query(
        'select text_sealed, proposals_sealed from incoming_file where id = $1',
        [i.id],
      );
      expect(rows.rows).toEqual([]);
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
    // The uploader is given it.
    expect((await itemOf(adult, b.id, i.id)).proposals?.identifier?.value).toBe(
      'P-SECRET-533401872',
    );
  });

  it('nobody signed in reads an item, or says it was read: the worker alone writes what it read', async () => {
    const b = await made(adult);
    const i = await sent(adult, b.id);
    const client = await app.connect();
    try {
      for (const set of [
        "read_state = 'read'",
        "text_sealed = '\\x00'",
        "proposals_sealed = '\\x00'",
        "read_failure = 'blank', read_state = 'failed'",
      ]) {
        await client.query('begin');
        await client.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                  set_config('app.member_id', $2, true), set_config('app.role', 'adult', true)`,
          [hh, adult.member_id],
        );
        await expect(
          client.query(`update incoming_file set ${set} where id = $1`, [i.id]),
        ).rejects.toThrow(/may only file or refuse/);
        await client.query('rollback');
      }
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  });

  it('a batch of 200 read items is levelled as it is asked, quickly', async () => {
    const b = await made(adult);
    const ids: string[] = [];
    for (let n = 0; n < 200; n++) ids.push((await sent(adult, b.id)).id);
    for (const id of ids) await plant(id, { proposal: passport(adult.member_id) });
    const started = performance.now();
    const got = await batch(adult, b.id);
    const took = performance.now() - started;
    // 137 ms on the development machine (I2): well inside a page's patience.
    expect(got.items.filter((x) => x.level === 'ready')).toHaveLength(200);
    expect(took).toBeLessThan(10_000);
  }, 180_000);
});
