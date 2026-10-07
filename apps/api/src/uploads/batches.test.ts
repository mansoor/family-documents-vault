import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  BATCH_MAX_FILES,
  type ActivityLine,
  type BatchAccepted,
  type BatchDetail,
  type BatchItemView,
  type BatchView,
  type CollectionDetail,
  type DocumentView,
  type IncomingFileView,
  type Tokens,
  type VersionView,
} from '@fdv/shared';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * Many documents at once (Phase 6, I1): a batch with defaults, its files
 * sent one at a time, each item its uploader's alone until accepted, with
 * every detail, or removed. The worker is not here: the pages it draws, one
 * at a time a household, are its own tests' (apps/worker/src/jobs/batches.test.ts);
 * here the API asks for them.
 */

const PDF = (marker: string, size = 1024) =>
  Buffer.concat([
    Buffer.from(`%PDF-1.4\n% ${marker}\n`),
    Buffer.alloc(Math.max(0, size - 32), 0x20),
    Buffer.from('\n%%EOF\n'),
  ]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe.skipIf(!testAdminUrl())('many documents at once: batches', () => {
  let h: Harness;
  let owner: Tokens;
  let adult: Tokens;
  let teen: Tokens;
  let viewer: Tokens;
  let guest: Tokens;
  let hh: string;
  let admin: ReturnType<typeof createPool>;
  let app: ReturnType<typeof createPool>;
  let peerN = 0;
  const peer = () => ({ remoteAddress: `10.91.${(++peerN >> 8) & 0xff}.${peerN & 0xff}` });

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    owner = await h.setup();
    hh = owner.household_id;
    adult = await h.join(owner, { name: 'Sana', email: 'sana@example.test', role: 'adult' });
    teen = await h.join(owner, { name: 'Zara', email: 'zara@example.test', role: 'teen' });
    viewer = await h.join(owner, { name: 'Vic', email: 'vic@example.test', role: 'viewer' });
    admin = createPool(h.adminUrl, 1);
    app = createPool(h.appUrl, 1);
    // A guest from outside the family: a viewer, always limited (5.34).
    await h.decider(owner);
    const invited = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invitations',
      headers: h.as(owner),
      payload: {
        display_name: 'Jane Smith',
        relationship: 'attorney',
        email: 'jane@example.test',
        role: 'viewer',
        kind: 'guest',
        restriction: { people: [owner.member_id], types: ['tax_return'] },
        access_expires_at: new Date(Date.now() + 30 * 864e5).toISOString(),
      },
    });
    expect(invited.statusCode, invited.body).toBe(201);
    const { link_token, code } = invited.json<{ link_token: string; code: string }>();
    const accepted = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      payload: { token: link_token, code, password: 'the guest’s own password' },
      ...peer(),
    });
    expect(accepted.statusCode, accepted.body).toBe(201);
    guest = accepted.json<Tokens>();
  }, 120_000);

  afterAll(async () => {
    await admin?.end();
    await app?.end();
    await h?.close();
  });

  const make = async (who: Tokens, body: Record<string, unknown> = {}) =>
    h.app.inject({ method: 'POST', url: '/api/v1/batches', headers: h.as(who), payload: body });
  const made = async (who: Tokens, body: Record<string, unknown> = {}) => {
    const res = await make(who, body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json<BatchDetail>();
  };
  const send = (
    who: Tokens,
    batchId: string,
    name: string,
    bytes: Buffer,
    type = 'application/pdf',
  ) => {
    const form = new FormData();
    form.append('file', bytes, { filename: name, contentType: type });
    return h.app.inject({
      method: 'POST',
      url: `/api/v1/batches/${batchId}/items`,
      headers: { ...h.as(who), ...form.getHeaders() },
      payload: form.getBuffer(),
    });
  };
  const sent = async (who: Tokens, batchId: string, name: string, bytes: Buffer) => {
    const res = await send(who, batchId, name, bytes);
    expect(res.statusCode, res.body).toBe(201);
    return res.json<BatchItemView>();
  };
  const detail = (who: Tokens, id: string) =>
    h.app.inject({ url: `/api/v1/batches/${id}`, headers: h.as(who) });
  const list = (who: Tokens) => h.app.inject({ url: '/api/v1/batches', headers: h.as(who) });
  const accept = (who: Tokens, batchId: string, itemId: string, body: Record<string, unknown>) =>
    h.app.inject({
      method: 'POST',
      url: `/api/v1/batches/${batchId}/items/${itemId}/accept`,
      headers: h.as(who),
      payload: body,
    });
  const doc = async (who: Tokens, id: string) =>
    (
      await h.app.inject({ url: `/api/v1/documents/${id}`, headers: h.as(who) })
    ).json<DocumentView>();
  const activity = async (who: Tokens) =>
    (await h.app.inject({ url: '/api/v1/audit?limit=100', headers: h.as(who) }))
      .json<{ items: ActivityLine[] }>()
      .items.map((l) => l.text);
  const onDisk = (key: string) =>
    stat(path.join(h.vaultDir, key)).then(
      () => true,
      () => false,
    );
  const keyOf = async (itemId: string) =>
    (
      await admin.query<{ storage_key: string }>(
        'select storage_key from incoming_file where id = $1',
        [itemId],
      )
    ).rows[0]?.storage_key as string;
  /** A document filed the ordinary way, with these bytes. */
  const filed = async (
    who: Tokens,
    title: string,
    bytes: Buffer,
    extra: Record<string, unknown> = {},
  ) => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(who),
      payload: { title, ...extra },
    });
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
  /** What somebody signed in is given by the database, asked as them: one statement. */
  const asThem = async <T extends object>(who: Tokens, role: string, text: string) => {
    const client = await app.connect();
    try {
      await client.query('begin');
      await client.query(
        `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                set_config('app.member_id', $2, true), set_config('app.role', $3, true)`,
        [hh, who.member_id, role],
      );
      return (await client.query<T>(text)).rows;
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  };

  // ----------------------------------------------------------- who may

  it('whoever may add documents makes a batch; a viewer and a guest are refused', async () => {
    for (const who of [owner, adult, teen]) {
      const b = await made(who, { name: '  Old   papers ' });
      expect(b.name).toBe('Old papers');
      expect(b.items).toEqual([]);
      expect(b.counts).toEqual({ items: 0, waiting: 0, accepted: 0, duplicates: 0 });
      // Thirty days to decide what is in it.
      expect(Date.parse(b.ends_at) - Date.parse(b.created_at)).toBe(30 * 864e5);
    }
    for (const who of [viewer, guest]) {
      const res = await make(who);
      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: { message: string } }>().error.message).toMatch(/Viewers/);
      expect((await list(who)).statusCode).toBe(403);
    }
    // And the database gives a viewer nothing either, whatever it asks.
    const seen = await asThem<{ n: number }>(
      viewer,
      'viewer',
      'select count(*)::int as n from intake_batch',
    );
    expect(seen[0]?.n).toBe(0);
  });

  it('a batch and its items are its uploader’s alone: nobody else is given one, an owner included', async () => {
    const mine = await made(adult, { name: 'Sana’s papers' });
    const item = await sent(adult, mine.id, 'bank.pdf', PDF('sana bank'));
    // Others: no batch, no item, no count — and the same answer as none at all.
    for (const who of [owner, teen]) {
      const theirs = (await list(who)).json<{ items: BatchView[] }>().items;
      expect(theirs.map((b) => b.id)).not.toContain(mine.id);
      expect((await detail(who, mine.id)).statusCode).toBe(404);
      expect((await detail(who, randomUUID())).statusCode).toBe(404);
      expect((await send(who, mine.id, 'x.pdf', PDF('intruder'))).statusCode).toBe(404);
      expect((await accept(who, mine.id, item.id, {})).statusCode).toBe(404);
      const removed = await h.app.inject({
        method: 'DELETE',
        url: `/api/v1/batches/${mine.id}/items/${item.id}`,
        headers: h.as(who),
      });
      expect(removed.statusCode).toBe(404);
      const page = await h.app.inject({
        url: `/api/v1/batches/${mine.id}/items/${item.id}/pages/1`,
        headers: h.as(who),
      });
      expect(page.statusCode).toBe(404);
    }
    for (const who of [viewer, guest]) {
      expect((await detail(who, mine.id)).statusCode).toBe(403);
    }
    // The database, asked as each: an owner, a teen, a viewer, another adult.
    for (const [who, role] of [
      [owner, 'owner'],
      [teen, 'teen'],
      [viewer, 'viewer'],
    ] as const) {
      const rows = await asThem<{ batches: number; items: number }>(
        who,
        role,
        `select (select count(*)::int from intake_batch where member_id <> app_member()) as batches,
                (select count(*)::int from incoming_file where batch_id is not null
                   and requester_member_id <> app_member()) as items`,
      );
      expect(rows[0]).toEqual({ batches: 0, items: 0 });
    }
    // Nothing else counts it: not the files sent in, not the documents, not their counts.
    const incoming = (await h.app.inject({ url: '/api/v1/incoming', headers: h.as(owner) })).json<{
      items: IncomingFileView[];
    }>();
    expect(incoming.items.map((f) => f.id)).not.toContain(item.id);
    const mineToo = (await h.app.inject({ url: '/api/v1/incoming', headers: h.as(adult) })).json<{
      items: IncomingFileView[];
    }>();
    expect(mineToo.items.map((f) => f.id)).not.toContain(item.id);
    const counts = await h.app.inject({ url: '/api/v1/documents/counts', headers: h.as(owner) });
    expect(JSON.stringify(counts.json())).not.toMatch(/bank/);
    // Nor is a file sent in decided here, nor an item there.
    const there = await h.app.inject({
      method: 'POST',
      url: `/api/v1/incoming/${item.id}/accept`,
      headers: h.as(adult),
      payload: {},
    });
    expect(there.statusCode).toBe(404);
  });

  it('the activity log has nothing of a batch before acceptance, for anybody; then the document’s lines', async () => {
    const before = {
      owner: await activity(owner),
      adult: await activity(adult),
      teen: await activity(teen),
    };
    const b = await made(adult, { name: 'Taxes 2024' });
    const item = await sent(adult, b.id, 'p60.pdf', PDF('p60 2024'));
    const removed = await sent(adult, b.id, 'blank.pdf', PDF('blank page'));
    await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/batches/${b.id}/items/${removed.id}`,
      headers: h.as(adult),
    });
    expect(await activity(owner)).toEqual(before.owner);
    expect(await activity(adult)).toEqual(before.adult);
    expect(await activity(teen)).toEqual(before.teen);
    const raw = await admin.query<{ n: number }>(
      `select count(*)::int as n from audit_event
        where object_id in ($1, $2, $3) or detail::text like '%Taxes 2024%'`,
      [b.id, item.id, removed.id],
    );
    expect(raw.rows[0]?.n).toBe(0);
    const done = await accept(adult, b.id, item.id, { title: 'P60 2024', visibility: 'household' });
    expect(done.statusCode, done.body).toBe(201);
    const after = await activity(owner);
    expect(after.length).toBeGreaterThan(before.owner.length);
    expect(after.join('\n')).toMatch(/P60 2024/);
  });

  // ------------------------------------------------------------ the files

  it('one file at a time, as a single add takes them: too big, or a kind the vault refuses, is refused, and nothing is kept', async () => {
    const b = await made(owner);
    const big = await send(owner, b.id, 'huge.pdf', PDF('huge', 5 * 1024 * 1024 + 10));
    expect(big.statusCode).toBe(413);
    const text = await send(owner, b.id, 'notes.txt', Buffer.from('just some words'), 'text/plain');
    expect(text.statusCode).toBe(415);
    const rows = await admin.query<{ n: number }>(
      'select count(*)::int as n from incoming_file where batch_id = $1',
      [b.id],
    );
    expect(rows.rows[0]?.n).toBe(0);
    // A file that failed can be sent again.
    const again = await sent(owner, b.id, 'huge.pdf', PDF('huge, smaller now'));
    expect(again.state).toBe('waiting');
    // Two files in one request are not one file.
    const form = new FormData();
    form.append('file', PDF('one'), { filename: 'one.pdf', contentType: 'application/pdf' });
    form.append('file', PDF('two'), { filename: 'two.pdf', contentType: 'application/pdf' });
    const two = await h.app.inject({
      method: 'POST',
      url: `/api/v1/batches/${b.id}/items`,
      headers: { ...h.as(owner), ...form.getHeaders() },
      payload: form.getBuffer(),
    });
    expect(two.statusCode).toBe(422);
  });

  it('an item is under its uploader’s own key, waiting to be read, and its pages are asked of the worker one household at a time', async () => {
    const b = await made(teen);
    const bytes = PDF('teen school report');
    h.jobs.length = 0;
    const item = await sent(teen, b.id, 'report.pdf', bytes);
    expect(item).toMatchObject({
      name: 'report.pdf',
      content_type: 'application/pdf',
      byte_size: bytes.length,
      sha256: sha(bytes),
      state: 'waiting',
      reading: 'waiting',
      preview_state: 'pending',
      duplicate: null,
      document_id: null,
    });
    const row = await admin.query<{
      scope: string;
      key_member: string;
      review_by: string;
      request_id: string | null;
    }>(
      `select f.scope, k.member_id as key_member, f.review_by, f.request_id
         from incoming_file f join scope_key k on k.id = f.wrapped_by_scope where f.id = $1`,
      [item.id],
    );
    expect(row.rows[0]).toEqual({
      scope: 'member',
      key_member: teen.member_id,
      review_by: 'me',
      request_id: null,
    });
    // Its object holds none of its words: it is encrypted.
    const key = await keyOf(item.id);
    expect(await onDisk(key)).toBe(true);
    expect((await readFile(path.join(h.vaultDir, key))).includes('teen school report')).toBe(false);
    expect(h.jobs).toEqual([
      {
        name: 'batch.previews',
        data: { household_id: hh },
        options: { singletonKey: `batch-previews:${hh}` },
      },
    ]);
    // Not drawn yet: the page is on its way.
    const page = await h.app.inject({
      url: `/api/v1/batches/${b.id}/items/${item.id}/pages/1`,
      headers: h.as(teen),
    });
    expect(page.statusCode).toBe(404);
    expect(page.json<{ error: { code: string } }>().error.code).toBe('preview_pending');
  });

  it('a batch holds 200 files at most: the 201st is refused, and one removed makes room', async () => {
    const b = await made(owner, { name: 'Lots' });
    // 199 already in, as their rows say (the bytes are not what is counted).
    await admin.query(
      `insert into incoming_file (household_id, batch_id, review_by, requester_member_id, state,
                                  original_name, mime, byte_size, sha256, cipher_bytes, cipher_sha256,
                                  storage_key, vault_id, file_key_wrapped, wrapped_by_scope, scope,
                                  scan_state, read_state, received_at, submitted_at)
       select $1::uuid, $2::uuid, 'me', $3::uuid, 'received', 'f' || n || '.pdf',
              'application/pdf', 10,
              sha256(convert_to('f' || n, 'UTF8')), 38, sha256(convert_to('c' || n, 'UTF8')),
              $1::text || '/batches/' || $2::text || '/f' || n || '.enc',
              (select id from vault where household_id = $1::uuid limit 1),
              decode('00', 'hex'),
              (select id from scope_key where kind = 'member' and member_id = $3::uuid),
              'member', 'unscanned', 'waiting', now(), now()
         from generate_series(1, ${BATCH_MAX_FILES - 1}) n`,
      [hh, b.id, owner.member_id],
    );
    const last = await sent(owner, b.id, 'two-hundredth.pdf', PDF('the 200th'));
    const over = await send(owner, b.id, 'too-many.pdf', PDF('the 201st'));
    expect(over.statusCode).toBe(422);
    expect(over.json<{ error: { code: string } }>().error.code).toBe('batch_full');
    const removed = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/batches/${b.id}/items/${last.id}`,
      headers: h.as(owner),
    });
    expect(removed.statusCode).toBe(204);
    expect((await send(owner, b.id, 'too-many.pdf', PDF('the 201st'))).statusCode).toBe(201);
    const shown = (await detail(owner, b.id)).json<BatchDetail>();
    expect(shown.counts.items).toBe(BATCH_MAX_FILES);
    // Its rows are cleared away with it: these bytes were never there.
    await admin.query('delete from incoming_file where batch_id = $1', [b.id]);
  });

  it('resuming: the batch says what arrived — name, size and SHA-256 — so a client sends only the rest', async () => {
    const b = await made(owner, { name: 'Scanner folder' });
    const files = [
      ['scan-001.pdf', PDF('scan one')],
      ['scan-002.pdf', PDF('scan two')],
      ['scan-003.pdf', PDF('scan three')],
    ] as const;
    // The tab closed after two.
    for (const [name, bytes] of files.slice(0, 2)) await sent(owner, b.id, name, bytes);
    const arrived = (await detail(owner, b.id)).json<BatchDetail>().items;
    const left = files.filter(
      ([name, bytes]) =>
        !arrived.some(
          (i) => i.name === name && i.byte_size === bytes.length && i.sha256 === sha(bytes),
        ),
    );
    expect(left.map(([name]) => name)).toEqual(['scan-003.pdf']);
    for (const [name, bytes] of left) await sent(owner, b.id, name, bytes);
    const all = (await detail(owner, b.id)).json<BatchDetail>();
    expect(all.items.map((i) => i.name)).toEqual(['scan-001.pdf', 'scan-002.pdf', 'scan-003.pdf']);
    expect(all.items.every((i) => i.duplicate === null)).toBe(true);
  });

  // ------------------------------------------------------- duplicates

  it('duplicates by SHA-256: a document the uploader can see, their own items — never somebody else’s Only me', async () => {
    const passport = PDF('owner passport scan');
    const diary = PDF('sana diary');
    const shared = PDF('council tax bill');
    await filed(owner, 'Council tax 2025', shared, { visibility: 'household' });
    await filed(adult, 'Sana’s diary', diary, {
      owner_member_id: adult.member_id,
      visibility: 'private',
    });
    const first = await made(owner, { name: 'First' });
    const second = await made(owner);
    const p1 = await sent(owner, first.id, 'passport.pdf', passport);
    const p2 = await sent(owner, first.id, 'passport (copy).pdf', passport);
    const p3 = await sent(owner, second.id, 'passport again.pdf', passport);
    const tax = await sent(owner, second.id, 'tax.pdf', shared);
    const hidden = await sent(owner, second.id, 'diary.pdf', diary);
    expect(p1.duplicate).toBeNull();
    expect(p2.duplicate).toMatchObject({ of: 'item', item_id: p1.id, same_batch: true });
    expect(p3.duplicate).toMatchObject({
      of: 'item',
      item_id: p1.id,
      batch_id: first.id,
      batch_name: 'First',
      same_batch: false,
    });
    expect(tax.duplicate).toMatchObject({ of: 'document', title: 'Council tax 2025' });
    // Sana's Only me diary has these very bytes: nothing says so.
    expect(hidden.duplicate).toBeNull();
    const counts = (await detail(owner, second.id)).json<BatchDetail>().counts;
    expect(counts).toMatchObject({ items: 3, waiting: 3, duplicates: 2 });
    // Sana's own upload of her diary is hers to know about.
    const hers = await made(adult);
    expect((await sent(adult, hers.id, 'diary.pdf', diary)).duplicate).toMatchObject({
      of: 'document',
      title: 'Sana’s diary',
    });
    // Once the first passport is accepted, the copies are of a document.
    const done = await accept(owner, first.id, p1.id, {
      title: 'My passport',
      visibility: 'household',
    });
    expect(done.statusCode, done.body).toBe(201);
    const now = (await detail(owner, first.id)).json<BatchDetail>().items;
    expect(now.find((i) => i.id === p2.id)?.duplicate).toMatchObject({
      of: 'document',
      title: 'My passport',
    });
    // A duplicate is still the uploader's to accept or remove.
    const gone = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/batches/${first.id}/items/${p2.id}`,
      headers: h.as(owner),
    });
    expect(gone.statusCode).toBe(204);
  });

  // ---------------------------------------------------------- accepting

  it('accepting files it with every detail the card takes, Only me included: sealed, under the uploader’s key, read for search as a single add’s', async () => {
    const coll = await h.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: h.as(owner),
      payload: { name: 'The car', audience: 'everyone' },
    });
    expect(coll.statusCode, coll.body).toBe(201);
    const collectionId = coll.json<{ id: string }>().id;
    const b = await made(owner, { name: 'Car papers' });
    const item = await sent(owner, b.id, 'v5c.pdf', PDF('the v5c'));
    h.jobs.length = 0;
    const res = await accept(owner, b.id, item.id, {
      type_key: 'vehicle_registration',
      title: 'Our car’s V5C',
      owner_member_id: owner.member_id,
      visibility: 'private',
      issued: { date: '2023-05-01', precision: 'day' },
      expires: null,
      identifier: 'AB12 CDE',
      issued_by: 'DVLA',
      physical_location: 'Glovebox',
      is_essential: true,
      tags: ['Car', 'car'],
      notes: 'Bought from a dealer',
      extra: { vin: 'JM1BK32F781234567', plate: 'AB12 CDE' },
      collection_id: collectionId,
    });
    expect(res.statusCode, res.body).toBe(201);
    const accepted = res.json<BatchAccepted>();
    const d = await doc(owner, accepted.document_id);
    expect(d).toMatchObject({
      type_key: 'vehicle_registration',
      title: 'Our car’s V5C',
      owner_member_id: owner.member_id,
      visibility: 'private',
      issued: { date: '2023-05-01', precision: 'day' },
      identifier: 'AB12 CDE',
      issued_by: 'DVLA',
      physical_location: 'Glovebox',
      is_essential: true,
      tags: ['car'],
      notes: 'Bought from a dealer',
      extra: { vin: 'JM1BK32F781234567', plate: 'AB12 CDE' },
    });
    // Sealed, as an Only me document's notes and details are from their first moment.
    const sealed = await admin.query<{ notes: string | null; extra: unknown; sealed: boolean }>(
      'select notes, extra, notes_sealed is not null as sealed from document where id = $1',
      [accepted.document_id],
    );
    expect(sealed.rows[0]).toEqual({ notes: null, extra: {}, sealed: true });
    const wrapped = await admin.query<{ kind: string; member_id: string }>(
      `select k.kind, k.member_id from document_version v join scope_key k on k.id = v.wrapped_by_scope
        where v.id = $1`,
      [accepted.version_id],
    );
    expect(wrapped.rows[0]).toEqual({ kind: 'member', member_id: owner.member_id });
    // In the collection, in the same transaction.
    const c = (
      await h.app.inject({ url: `/api/v1/collections/${collectionId}`, headers: h.as(owner) })
    ).json<CollectionDetail>();
    expect(c.items.map((i) => i.document.id)).toContain(accepted.document_id);
    // Read for search once filed, as a single add's is: sealed, being Only me.
    expect(h.jobs).toContainEqual({
      name: 'version.process',
      data: { household_id: hh, version_id: accepted.version_id },
    });
    const search = (
      await h.app.inject({ url: '/api/v1/search?q=dealer', headers: h.as(owner) })
    ).json<{ sealed_pending: { count: number } }>();
    expect(search.sealed_pending.count).toBeGreaterThanOrEqual(1);
    // Its bytes are where versions are kept now, and the item's are gone.
    const versions = (
      await h.app.inject({
        url: `/api/v1/documents/${accepted.document_id}/versions`,
        headers: h.as(owner),
      })
    ).json<{ items: VersionView[] }>().items;
    expect(versions).toHaveLength(1);
    expect(await onDisk(await keyOf(item.id))).toBe(false);
    const after = (await detail(owner, b.id)).json<BatchDetail>();
    expect(after.items.find((i) => i.id === item.id)).toMatchObject({
      state: 'accepted',
      document_id: accepted.document_id,
    });
    expect(after.counts).toMatchObject({ items: 1, waiting: 0, accepted: 1 });
    // Nobody else sees it: Only me.
    expect(
      (
        await h.app.inject({
          url: `/api/v1/documents/${accepted.document_id}`,
          headers: h.as(adult),
        })
      ).statusCode,
    ).toBe(404);
    // Once decided, never twice.
    const twice = await accept(owner, b.id, item.id, {});
    expect(twice.statusCode).toBe(409);
  });

  it('the batch’s defaults fill only what is not sent; what is sent wins; never wider than the batch chose', async () => {
    const coll = await h.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: h.as(adult),
      payload: { name: 'Sana’s house', audience: 'everyone' },
    });
    const collectionId = coll.json<{ id: string }>().id;
    const b = await made(adult, {
      name: 'House',
      defaults: {
        owner_member_id: adult.member_id,
        type_key: 'utility_bill',
        visibility: 'adults',
        physical_location: 'Filing cabinet',
        collection_id: collectionId,
        tags: ['House', ' bills '],
        is_essential: true,
      },
    });
    expect(b.defaults).toEqual({
      owner_member_id: adult.member_id,
      type_key: 'utility_bill',
      visibility: 'adults',
      physical_location: 'Filing cabinet',
      collection_id: collectionId,
      tags: ['house', 'bills'],
      is_essential: true,
    });
    const one = await sent(adult, b.id, 'ct.pdf', PDF('council tax 2026'));
    const two = await sent(adult, b.id, 'other.pdf', PDF('something else'));
    const filledIn = await accept(adult, b.id, one.id, {});
    expect(filledIn.statusCode, filledIn.body).toBe(201);
    const d1 = await doc(adult, filledIn.json<BatchAccepted>().document_id);
    expect(d1).toMatchObject({
      owner_member_id: adult.member_id,
      type_key: 'utility_bill',
      visibility: 'adults',
      physical_location: 'Filing cabinet',
      tags: ['house', 'bills'],
      is_essential: true,
    });
    const c = (
      await h.app.inject({ url: `/api/v1/collections/${collectionId}`, headers: h.as(adult) })
    ).json<CollectionDetail>();
    expect(c.items.map((i) => i.document.id)).toContain(d1.id);
    // Sent, even as blank, it is as sent.
    const asSent = await accept(adult, b.id, two.id, {
      type_key: null,
      owner_member_id: null,
      physical_location: null,
      tags: [],
      is_essential: false,
      collection_id: null,
      visibility: 'household',
    });
    expect(asSent.statusCode, asSent.body).toBe(201);
    const d2 = await doc(adult, asSent.json<BatchAccepted>().document_id);
    expect(d2).toMatchObject({
      owner_member_id: null,
      type_key: null,
      visibility: 'household',
      physical_location: null,
      tags: [],
      is_essential: false,
    });
    // A batch for Everyone, and a kind usually for the adults: Adults only.
    const wide = await made(adult, { defaults: { visibility: 'household', type_key: 'will' } });
    const will = await sent(adult, wide.id, 'will.pdf', PDF('a will'));
    const willDoc = await doc(
      adult,
      (await accept(adult, wide.id, will.id, {})).json<BatchAccepted>().document_id,
    );
    expect(willDoc.visibility).toBe('adults');
  });

  it('defaults are checked as the card checks them; a teen’s are their own, and so is what they file', async () => {
    const bad = [
      [owner, { defaults: { type_key: 'no_such_kind' } }, 422],
      [owner, { defaults: { owner_member_id: randomUUID() } }, 422],
      [owner, { defaults: { owner_member_id: adult.member_id, visibility: 'private' } }, 422],
      [teen, { defaults: { visibility: 'adults' } }, 403],
      [teen, { defaults: { owner_member_id: owner.member_id } }, 403],
      [owner, { defaults: { collection_id: randomUUID() } }, 404],
      [owner, { name: 'x'.repeat(121) }, 422],
      [owner, { defaults: { colour: 'red' } }, 422],
    ] as const;
    for (const [who, body, status] of bad) {
      const res = await make(who, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(status);
    }
    // Somebody else's collection is not one to put documents in.
    const theirs = await h.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: h.as(owner),
      payload: { name: 'Owner’s', audience: 'everyone' },
    });
    expect(
      (await make(adult, { defaults: { collection_id: theirs.json<{ id: string }>().id } }))
        .statusCode,
    ).toBe(403);
    // A teen's batch, and what they file from it: theirs, never Adults only.
    const b = await made(teen, {
      defaults: { owner_member_id: teen.member_id, type_key: 'passport' },
    });
    const item = await sent(teen, b.id, 'passport.pdf', PDF('teen passport'));
    expect(
      (await accept(teen, b.id, item.id, { owner_member_id: owner.member_id })).statusCode,
    ).toBe(403);
    expect((await accept(teen, b.id, item.id, { visibility: 'adults' })).statusCode).toBe(403);
    const ok = await accept(teen, b.id, item.id, {});
    expect(ok.statusCode, ok.body).toBe(201);
    const d = await doc(teen, ok.json<BatchAccepted>().document_id);
    expect(d.owner_member_id).toBe(teen.member_id);
    expect(d.visibility).not.toBe('adults');
    // A kind the household does not have is refused at accept, as it is chosen now.
    const k = await sent(teen, b.id, 'thing.pdf', PDF('a thing'));
    expect((await accept(teen, b.id, k.id, { type_key: 'no_such_kind' })).statusCode).toBe(422);
    // PATCH: name and defaults, what is not sent stays.
    const patched = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/batches/${b.id}`,
      headers: h.as(teen),
      payload: { name: 'School', defaults: { tags: ['school'] } },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json<BatchDetail>()).toMatchObject({
      name: 'School',
      defaults: { owner_member_id: teen.member_id, type_key: 'passport', tags: ['school'] },
    });
  });

  it('where the paper copies are is for whoever sees that: an uploader made a viewer sees nothing of their batch', async () => {
    const someone = await h.join(owner, {
      name: 'Rafi',
      email: 'rafi@example.test',
      role: 'adult',
    });
    const b = await made(someone, { defaults: { physical_location: 'Study drawer' } });
    expect(b.defaults.physical_location).toBe('Study drawer');
    await sent(someone, b.id, 'deed.pdf', PDF('deeds'));
    await admin.query("update account_household set role = 'viewer' where member_id = $1", [
      someone.member_id,
    ]);
    const asViewer = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { email: 'rafi@example.test', password: 'another correct horse' },
      ...peer(),
    });
    expect(asViewer.statusCode, asViewer.body).toBe(200);
    const viewerTokens = asViewer.json<Tokens>();
    expect((await detail(viewerTokens, b.id)).statusCode).toBe(403);
    expect((await list(viewerTokens)).statusCode).toBe(403);
    const db = await asThem<{ n: number }>(
      someone,
      'viewer',
      `select (select count(*)::int from intake_batch) + (select count(*)::int from incoming_file
         where batch_id is not null) as n`,
    );
    expect(db[0]?.n).toBe(0);
    await admin.query("update account_household set role = 'adult' where member_id = $1", [
      someone.member_id,
    ]);
  });

  // ----------------------------------------------------------- removing

  it('removing an item removes its bytes and its name; removing a batch removes what is undecided, and keeps what was accepted', async () => {
    const b = await made(owner, { name: 'To clear' });
    const keep = await sent(owner, b.id, 'keep.pdf', PDF('keep me'));
    const drop = await sent(owner, b.id, 'drop.pdf', PDF('drop me'));
    const left = await sent(owner, b.id, 'left.pdf', PDF('left undecided'));
    const keepDoc = (
      await accept(owner, b.id, keep.id, { visibility: 'household' })
    ).json<BatchAccepted>().document_id;
    const dropKey = await keyOf(drop.id);
    // Pages the worker drew, beside it.
    await admin.query(
      "update incoming_file set preview_state = 'ready', preview_pages = 1 where id = $1",
      [drop.id],
    );
    const gone = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/batches/${b.id}/items/${drop.id}`,
      headers: h.as(owner),
    });
    expect(gone.statusCode).toBe(204);
    expect(await onDisk(dropKey)).toBe(false);
    const row = await admin.query<{
      state: string;
      original_name: string | null;
      sha256: Buffer | null;
    }>('select state, original_name, sha256 from incoming_file where id = $1', [drop.id]);
    expect(row.rows[0]).toEqual({ state: 'rejected', original_name: null, sha256: null });
    expect((await detail(owner, b.id)).json<BatchDetail>().items.map((i) => i.id)).toEqual([
      keep.id,
      left.id,
    ]);
    // Twice is decided already.
    const twice = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/batches/${b.id}/items/${drop.id}`,
      headers: h.as(owner),
    });
    expect(twice.statusCode).toBe(409);
    const leftKey = await keyOf(left.id);
    const removed = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/batches/${b.id}`,
      headers: h.as(owner),
    });
    expect(removed.statusCode).toBe(204);
    expect(await onDisk(leftKey)).toBe(false);
    expect((await detail(owner, b.id)).statusCode).toBe(404);
    const rows = await admin.query<{ n: number }>(
      'select count(*)::int as n from incoming_file where batch_id = $1',
      [b.id],
    );
    expect(rows.rows[0]?.n).toBe(0);
    // What was accepted is a document, and stays one.
    expect((await doc(owner, keepDoc)).id).toBe(keepDoc);
  });

  it('somebody with a batch keeps something private: an owner is never handed a reset link for them', async () => {
    const plain = await h.join(owner, {
      name: 'Nadia',
      email: 'nadia@example.test',
      role: 'adult',
    });
    const ask = async () =>
      (
        await asThem<{ held: boolean }>(
          owner,
          'owner',
          `select member_holds_private((select account_id from account_household
                                        where member_id = '${plain.member_id}')) as held`,
        )
      )[0]?.held;
    expect(await ask()).toBe(false);
    await made(plain);
    expect(await ask()).toBe(true);
  });

  it('the database holds a batch and its items to their uploader, whatever the API asks', async () => {
    const b = await made(adult, { name: 'Held' });
    const item = await sent(adult, b.id, 'held.pdf', PDF('held by the database'));
    /** One statement as the uploader, signed in: what it did, or the error's code. */
    const asUploader = async (text: string, args: unknown[] = [], session?: string) => {
      const client = await app.connect();
      try {
        await client.query('begin');
        await client.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                  set_config('app.member_id', $2, true), set_config('app.role', 'adult', true),
                  set_config('app.account_id', (select account_id::text from account_household
                                                 where member_id = $2::uuid), true),
                  set_config('app.session_id', $3, true)`,
          [hh, adult.member_id, session ?? ''],
        );
        return (await client.query(text, args)).rowCount ?? 0;
      } catch (err) {
        return (err as { code?: string }).code ?? 'error';
      } finally {
        await client.query('rollback').catch(() => undefined);
        client.release();
      }
    };
    // Its name and defaults are the uploader's to change; who made it and its end are not.
    expect(await asUploader("update intake_batch set name = 'Renamed' where id = $1", [b.id])).toBe(
      1,
    );
    expect(
      await asUploader(
        "update intake_batch set ends_at = ends_at + interval '1 day' where id = $1",
        [b.id],
      ),
    ).toBe('42501');
    // An item is put in under the uploader's own key, and no other.
    const household = await admin.query<{ id: string; vault: string }>(
      `select k.id, (select id from vault where household_id = $1 limit 1) as vault
         from scope_key k where k.household_id = $1 and k.kind = 'household'`,
      [hh],
    );
    const put = (scope: string) =>
      asUploader(
        `insert into incoming_file (household_id, batch_id, review_by, requester_member_id,
                                    original_name, storage_key, vault_id, file_key_wrapped,
                                    wrapped_by_scope, scope, scan_state, read_state)
         values ($1, $2, 'me', $3, 'x.pdf', $4, $5, decode('00', 'hex'), $6, 'member', 'unscanned',
                 'waiting')`,
        [
          hh,
          b.id,
          adult.member_id,
          `${hh}/batches/x-${randomUUID()}.enc`,
          household.rows[0]?.vault,
          scope,
        ],
      );
    expect(await put(household.rows[0]?.id as string)).toBe('42501');
    const own = await admin.query<{ id: string }>(
      "select id from scope_key where kind = 'member' and member_id = $1",
      [adult.member_id],
    );
    expect(await put(own.rows[0]?.id as string)).toBe(1);
    // A received item is never removed by its uploader, only decided.
    expect(await asUploader('delete from incoming_file where id = $1', [item.id])).toBe(0);
    // A session a reset ended makes nothing private (0052): no batch.
    const ended = await admin.query<{ id: string }>(
      `insert into session (account_id, household_id, refresh_hash, expires_at, revoked_at, revoked_reason)
       select account_id, household_id, $2, now() + interval '1 day', now(), 'password_reset'
         from account_household where member_id = $1 returning id`,
      [adult.member_id, Buffer.from(randomUUID())],
    );
    expect(
      await asUploader(
        `insert into intake_batch (household_id, created_by, member_id, ends_at)
         values ($1, app_account(), app_member(), now() + interval '30 days')`,
        [hh],
        ended.rows[0]?.id,
      ),
    ).toBe('FDV01');
  });
});

/**
 * The household's room for files sent through a request bounds what
 * strangers can make the vault keep; a batch's items are the family's own,
 * and neither take that room nor are told of by a stranger's refusal.
 */
describe.skipIf(!testAdminUrl())('a batch and the room for files sent in', () => {
  let h: Harness;
  let owner: Tokens;
  let ip = 0;
  const addr = () => `10.92.${(++ip >> 8) & 0xff}.${ip & 0xff}`;

  beforeAll(async () => {
    h = await createHarness({ operatorMail: false, incomingMaxBytes: 5000 });
    owner = await h.setup();
  }, 90_000);
  afterAll(() => h.close());

  it('items in a batch take none of the room a sender’s file needs', async () => {
    const b = (
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/batches',
        headers: h.as(owner),
        payload: {},
      })
    ).json<BatchDetail>();
    for (const n of [1, 2, 3]) {
      const form = new FormData();
      form.append('file', PDF(`bulk ${n}`, 3000), {
        filename: `bulk-${n}.pdf`,
        contentType: 'application/pdf',
      });
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/batches/${b.id}/items`,
        headers: { ...h.as(owner), ...form.getHeaders() },
        payload: form.getBuffer(),
      });
      expect(res.statusCode, res.body).toBe(201);
    }
    const made = await h.app.inject({
      method: 'POST',
      url: '/api/v1/upload-requests',
      headers: h.as(owner),
      payload: { title: 'Tax papers', expires_at: new Date(Date.now() + 7 * 864e5).toISOString() },
    });
    expect(made.statusCode, made.body).toBe(201);
    const { link_token } = made.json<{ link_token: string }>();
    const opened = await h.app.inject({
      method: 'POST',
      url: '/api/v1/drop/unlock',
      payload: { token: link_token },
      remoteAddress: addr(),
    });
    const set = opened.cookies.find((c) => c.name.startsWith('fdv_drop_s_'));
    const form = new FormData();
    form.append('file', PDF('from the accountant', 3000), {
      filename: 'w2.pdf',
      contentType: 'application/pdf',
    });
    const sentIn = await h.app.inject({
      method: 'POST',
      url: '/api/v1/drop/files',
      headers: form.getHeaders(),
      cookies: { [set?.name as string]: set?.value as string },
      payload: form.getBuffer(),
      remoteAddress: addr(),
    });
    expect(sentIn.statusCode, sentIn.body).toBe(201);
  });
});
