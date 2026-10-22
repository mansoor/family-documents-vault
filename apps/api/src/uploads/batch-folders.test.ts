import { randomUUID } from 'node:crypto';
import {
  EnvKeyProvider,
  itemFolderBinding,
  itemProposalsBinding,
  itemTextBinding,
  openBytes,
  ScopeKeys,
  sealBytes,
  unwrapKey,
} from '@fdv/crypto';
import { createPool, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  itemFolder,
  untouchedAccept,
  type BatchDetail,
  type BatchItemView,
  type BatchLearning,
  type DetailProposal,
  type DocumentTypeView,
  type Tokens,
} from '@fdv/shared';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, TEST_MASTER, type Harness } from '../test-harness.js';

/**
 * Folder names → suggested details (0.8.0, S2), in the API: where an item
 * came from under the folder it was added from (`relative_path`) is kept
 * sealed under its own key — never plain in the database or a log — given
 * back to its uploader alone as its `folder`, and read for what it suggests
 * as it is asked: from the kinds, the people and the tags the uploader is
 * given then, below a sure page reading, after the batch's defaults.
 */

const PDF = (marker: string) => Buffer.from(`%PDF-1.4\n% ${marker} ${randomUUID()}\n%%EOF\n`);
const day = (date: string) => ({ date, precision: 'day' as const });
const SECRET = 'FOLDER-SECRET-71';

describe.skipIf(!testAdminUrl())('the folder an item came from, for its uploader (S2)', () => {
  let h: Harness;
  let owner: Tokens;
  let adult: Tokens;
  let teen: Tokens;
  let hh: string;
  let admin: ReturnType<typeof createPool>;
  let app: ReturnType<typeof createPool>;
  const keys = new ScopeKeys(new EnvKeyProvider(TEST_MASTER));
  /** Every line the API logs, and every query it runs with its values. */
  const logged: string[] = [];

  beforeAll(async () => {
    h = await createHarness({
      rateLimitPerMinute: 100_000,
      logger: { level: 'trace', stream: { write: (s: string) => void logged.push(s) } },
      log: (event) => {
        logged.push(
          JSON.stringify({
            sql: event.query.sql,
            parameters: event.query.parameters.map((v) =>
              Buffer.isBuffer(v) ? v.toString('hex') : v,
            ),
          }),
        );
      },
    });
    owner = await h.setup({ display_name: 'Olivia' });
    hh = owner.household_id;
    adult = await h.join(owner, {
      name: 'Sana Malik',
      email: 'sana-s2@example.test',
      role: 'adult',
    });
    teen = await h.join(owner, { name: 'Zara', email: 'zara-s2@example.test', role: 'teen' });
    admin = createPool(h.adminUrl, 1);
    app = createPool(h.appUrl, 1);
    // Somebody outside the family, with a sign-in of her own one day: never whose a paper is.
    await admin.query(
      `insert into member (household_id, display_name, kind) values ($1, 'Gita', 'guest')`,
      [hh],
    );
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
  /** One file, multipart: its relative_path first, when there is one. */
  const send = (who: Tokens, batchId: string, path?: string, extra?: (f: FormData) => void) => {
    const form = new FormData();
    if (path !== undefined) form.append('relative_path', path);
    form.append('file', PDF('scan'), { filename: 'scan.pdf', contentType: 'application/pdf' });
    extra?.(form);
    return h.app.inject({
      method: 'POST',
      url: `/api/v1/batches/${batchId}/items`,
      headers: { ...h.as(who), ...form.getHeaders() },
      payload: form.getBuffer(),
    });
  };
  const sent = async (who: Tokens, batchId: string, path?: string) => {
    const res = await send(who, batchId, path);
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
  const keyOf = async (itemId: string) =>
    withSystem(h.db, hh, async (trx) => {
      const f = await trx
        .selectFrom('incoming_file')
        .select(['file_key_wrapped', 'wrapped_by_scope'])
        .where('id', '=', itemId)
        .executeTakeFirstOrThrow();
      return unwrapKey(
        f.file_key_wrapped,
        await keys.unwrapById(trx, f.wrapped_by_scope),
        `incoming:${itemId}`,
      );
    });
  /** What the worker writes once it has read an item, sealed as it seals it. */
  const plant = async (itemId: string, proposal: DetailProposal) => {
    const fileKey = await keyOf(itemId);
    await withSystem(h.db, hh, (trx) =>
      trx
        .updateTable('incoming_file')
        .set({
          read_state: 'read',
          text_sealed: sealBytes(fileKey, Buffer.from('its words'), itemTextBinding(itemId)),
          proposals_sealed: sealBytes(
            fileKey,
            Buffer.from(JSON.stringify({ v: 1, proposal })),
            itemProposalsBinding(itemId),
          ),
        })
        .where('id', '=', itemId)
        .execute(),
    );
  };
  const row = async (itemId: string) =>
    (
      await admin.query<{ folder_sealed: Buffer | null; state: string; text: string }>(
        'select folder_sealed, state, row_to_json(f)::text as text from incoming_file f where id = $1',
        [itemId],
      )
    ).rows[0];
  /** A passport read: each its own number and issuer, so none is a renewal of another filed (S1). */
  const passport = (who: string, sure: number): DetailProposal => {
    const n = randomUUID().slice(0, 8);
    return {
      type_key: { value: 'passport', confidence: sure, cue: 'kind_words' },
      owner_member_id: { value: who, confidence: sure, cue: 'name_labelled' },
      expires: { value: day('2031-03-14'), confidence: 0.94, cue: 'machine_lines' },
      identifier: { value: `P-${n}`, confidence: 0.95, cue: 'machine_lines' },
      issued_by: { value: `Office ${n}`, confidence: 0.9, cue: 'letterhead' },
    };
  };

  it('says it suggests from folders', async () => {
    const caps = (await h.app.inject({ url: '/api/v1/capabilities' })).json<{
      features: Record<string, unknown>;
    }>();
    expect(caps.features.folder_suggestions).toBe(true);
  });

  it('keeps the folder sealed under the item’s key — never plain in the database or a log — and gives it back to its uploader alone', async () => {
    logged.length = 0;
    const b = await made(adult);
    const item = await sent(adult, b.id, `Scans/${SECRET}/Passports/scan.pdf`);
    // Without the file's own name.
    expect(item.folder).toBe(`Scans/${SECRET}/Passports`);
    const r = await row(item.id);
    expect(r?.folder_sealed).toBeInstanceOf(Buffer);
    // Nowhere in the row, as words or as bytes.
    expect(r?.text).not.toContain(SECRET);
    expect(r?.text).not.toContain(Buffer.from(SECRET).toString('hex'));
    // Sealed under the item's own key, bound to it: it opens for it, and for no other.
    const fileKey = await keyOf(item.id);
    expect(
      openBytes(fileKey, r?.folder_sealed as Buffer, itemFolderBinding(item.id)).toString(),
    ).toBe(`Scans/${SECRET}/Passports`);
    expect(() =>
      openBytes(fileKey, r?.folder_sealed as Buffer, itemFolderBinding(randomUUID())),
    ).toThrow();
    // The log: the request, and every query with its values.
    await batch(adult, b.id);
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain(Buffer.from(SECRET).toString('hex'));
    }
    // Its uploader's alone: an owner is given no batch, no item, no folder.
    expect((await call(owner, 'GET', `/api/v1/batches/${b.id}`)).statusCode).toBe(404);
    expect((await call(owner, 'GET', '/api/v1/batches')).body).not.toContain(SECRET);
  });

  it('takes one relative_path, before the file, and nothing else; tidies it; refuses one too long', async () => {
    const b = await made(adult);
    const wrong = await send(adult, b.id, undefined, (f) => f.append('relative_path', 'x'));
    expect(wrong.statusCode, wrong.body).toBe(422);
    const named = new FormData();
    named.append('folder', 'Passports');
    named.append('file', PDF('x'), { filename: 'x.pdf', contentType: 'application/pdf' });
    const misnamed = await h.app.inject({
      method: 'POST',
      url: `/api/v1/batches/${b.id}/items`,
      headers: { ...h.as(adult), ...named.getHeaders() },
      payload: named.getBuffer(),
    });
    expect(misnamed.statusCode, misnamed.body).toBe(422);
    const long = await send(adult, b.id, 'x/'.repeat(3000));
    expect(long.statusCode, long.body).toBe(422);
    expect(long.json<{ error: { detail: string } }>().error.detail).toBe('relative_path');
    // Counted as the parser counts it: bytes, and said so.
    expect(long.json<{ error: { message: string } }>().error.message).toBe(
      'A relative_path is 4096 bytes at most.',
    );
    // 2,000 three-byte letters are 2,000 characters, and 6,000 bytes: refused.
    expect((await send(adult, b.id, 'ア'.repeat(2000))).statusCode).toBe(422);
    // Control characters stripped, dots and empties gone, the file's name dropped.
    const tidy = await sent(adult, b.id, './Pass‮ports//Sana\u0007/../scan.pdf');
    expect(tidy.folder).toBe('Passports/Sana');
    // Nothing kept for a file sent alone, or from the top of a folder.
    expect((await sent(adult, b.id)).folder).toBeNull();
    expect((await sent(adult, b.id, 'scan.pdf')).folder).toBeNull();
    // None of the refused made an item.
    expect((await batch(adult, b.id)).items).toHaveLength(3);
  });

  it('suggests from the folder below the pages: alone unsure, agreeing Ready, disagreeing Check', async () => {
    const b = await made(adult);
    const alone = await sent(adult, b.id, 'Sana/Passports/scan.pdf');
    const agree = await sent(adult, b.id, 'Sana/Passports/scan.pdf');
    const against = await sent(adult, b.id, 'Olivia/Bills/scan.pdf');
    const plain = await sent(adult, b.id);
    await plant(alone.id, {});
    await plant(agree.id, passport(adult.member_id, 0.8));
    await plant(against.id, passport(adult.member_id, 0.97));
    await plant(plain.id, passport(adult.member_id, 0.8));
    const got = await batch(adult, b.id);
    const by = (id: string) => got.items.find((i) => i.id === id) as BatchItemView;
    expect(by(alone.id)).toMatchObject({
      level: 'check',
      proposals: {
        type_key: { value: 'passport', from: 'folder', confidence: 0.8, cue: null },
        owner_member_id: { value: adult.member_id, from: 'folder' },
      },
    });
    expect(by(agree.id)).toMatchObject({
      level: 'ready',
      proposals: { type_key: { from: 'pages', confidence: 0.9, folder: true } },
    });
    expect(by(plain.id).level).toBe('check');
    expect(by(against.id)).toMatchObject({
      level: 'check',
      proposals: {
        type_key: { value: 'passport', from: 'pages' },
        owner_member_id: { value: adult.member_id, from: 'pages' },
      },
    });
    expect(
      by(against.id)
        .tags?.filter((t) => t.code === 'clash_folder')
        .map((t) => t.words),
    ).toEqual([
      'The folder says Bill; the pages look like a passport',
      'The folder says Olivia; the pages say Sana Malik',
    ]);
    // Accept all Ready files the one Ready on the folder and the pages together.
    const all = await call(adult, 'POST', `/api/v1/batches/${b.id}/accept-ready`, {});
    expect(
      all.json<{ accepted: Array<{ item_id: string }> }>().accepted.map((a) => a.item_id),
    ).toEqual([agree.id]);
  });

  it('never a note’s kind, from the folder or the pages, even with a note the uploader can see (the N1 review)', async () => {
    // A note of the family's, so the kind of a note is listed to her (types()).
    const note = await call(adult, 'POST', '/api/v1/documents', {
      type_key: 'note',
      title: 'Kitchen notes',
      notes: 'The fuse box is behind the door',
      visibility: 'household',
      owner_member_id: adult.member_id,
    });
    expect(note.statusCode, note.body).toBe(201);
    const kinds = (await call(adult, 'GET', '/api/v1/document-types')).json<{
      items: DocumentTypeView[];
    }>();
    expect(kinds.items.map((k) => k.key)).toContain('note');
    const b = await made(adult);
    const fromFolder = await sent(adult, b.id, 'Notes/scan.pdf');
    const fromPages = await sent(adult, b.id, 'Scans/scan.pdf');
    await plant(fromFolder.id, {});
    await plant(fromPages.id, {
      type_key: { value: 'note', confidence: 0.97, cue: 'kind_words' },
    });
    for (const id of [fromFolder.id, fromPages.id]) {
      const item = await itemOf(adult, b.id, id);
      expect(item.proposals?.type_key?.value ?? null, JSON.stringify(item.proposals)).not.toBe(
        'note',
      );
      expect(item.level).not.toBe('ready');
    }
  });

  it('the batch’s defaults win over the folder, which fills only what they leave blank', async () => {
    const b = await made(adult, { defaults: { type_key: 'insurance_policy', tags: ['scanned'] } });
    const item = await sent(adult, b.id, 'Olivia/Passports/Holidays/scan.pdf');
    await plant(item.id, {});
    const got = await itemOf(adult, b.id, item.id);
    expect(got.proposals?.type_key).toMatchObject({ value: 'insurance_policy', from: 'batch' });
    expect(got.proposals?.owner_member_id).toMatchObject({
      value: owner.member_id,
      from: 'folder',
    });
    // The batch chose tags: the folder's are not offered.
    expect(got.proposals?.tags).toBeUndefined();
    expect(got.tags?.some((t) => t.code === 'clash_folder')).toBe(false);
  });

  it('never names somebody the uploader may not choose, nor a tag on a document they cannot see', async () => {
    // A tag on the owner's Only me document, and one on a document for everybody.
    for (const [title, visibility, tag] of [
      ['Only hers', 'private', 'kestrel'],
      ['Everybody’s', 'household', 'heron'],
    ] as const) {
      const res = await call(owner, 'POST', '/api/v1/documents', {
        title,
        visibility,
        owner_member_id: owner.member_id,
        tags: [tag],
      });
      expect(res.statusCode, res.body).toBe(201);
    }
    const b = await made(adult);
    const guest = await sent(adult, b.id, 'Gita/Passports/scan.pdf');
    const nobody = await sent(adult, b.id, 'Qwerty/Passports/scan.pdf');
    const hidden = await sent(adult, b.id, 'Kestrels/scan.pdf');
    const seen = await sent(adult, b.id, 'Herons/scan.pdf');
    for (const i of [guest, nobody, hidden, seen]) await plant(i.id, {});
    const got = await batch(adult, b.id);
    const by = (id: string) => got.items.find((i) => i.id === id) as BatchItemView;
    // A guest's name is any other word: no person, a new tag, exactly as a name nobody has.
    expect(by(guest.id).proposals?.owner_member_id).toBeUndefined();
    expect(by(guest.id).proposals?.tags).toEqual([
      { value: 'Gita', from: 'folder', existing: false, ticked: false },
    ]);
    expect(by(nobody.id).proposals?.tags).toEqual([
      { value: 'Qwerty', from: 'folder', existing: false, ticked: false },
    ]);
    // Her Only me document's tag is not his to be told of: a new tag, as any word.
    expect(by(hidden.id).proposals?.tags).toEqual([
      { value: 'Kestrels', from: 'folder', existing: false, ticked: false },
    ]);
    expect(by(seen.id).proposals?.tags).toEqual([
      { value: 'heron', from: 'folder', existing: true, ticked: true },
    ]);
    // A teen's are their own: the folder naming somebody else names nobody, and no tag.
    const tb = await made(teen);
    const theirs = await sent(teen, tb.id, 'Sana/Passports/scan.pdf');
    const own = await sent(teen, tb.id, 'Zara/Holidays/scan.pdf');
    await plant(theirs.id, {});
    await plant(own.id, {});
    const tg = await batch(teen, tb.id);
    const tby = (id: string) => tg.items.find((i) => i.id === id) as BatchItemView;
    expect(tby(theirs.id).proposals).toMatchObject({
      type_key: { value: 'passport', from: 'folder' },
      owner_member_id: { value: teen.member_id, from: 'batch' },
    });
    expect(tby(theirs.id).proposals?.tags).toBeUndefined();
    expect(tby(own.id).proposals?.tags).toEqual([
      { value: 'Holidays', from: 'folder', existing: false, ticked: false },
    ]);
  });

  it('a tag only on her Only me papers is never filed by Accept all Ready, nor ticked onto one everybody sees (IVF)', async () => {
    const mine = await call(adult, 'POST', '/api/v1/documents', {
      title: 'Clinic letter',
      visibility: 'private',
      owner_member_id: adult.member_id,
      tags: ['ivf'],
    });
    expect(mine.statusCode, mine.body).toBe(201);
    const everybody = await made(adult, { defaults: { visibility: 'household' } });
    const shown = await sent(adult, everybody.id, 'IVF/scan.pdf');
    await plant(shown.id, passport(adult.member_id, 0.95));
    const got = await itemOf(adult, everybody.id, shown.id);
    expect(got.level).toBe('ready');
    expect(got.proposals?.visibility.value).toBe('household');
    expect(got.proposals?.tags).toEqual([
      { value: 'ivf', from: 'folder', existing: true, ticked: false },
    ]);
    const all = await call(adult, 'POST', `/api/v1/batches/${everybody.id}/accept-ready`, {});
    const filed = all.json<{ accepted: Array<{ item_id: string; document_id: string }> }>()
      .accepted;
    expect(filed.map((a) => a.item_id)).toEqual([shown.id]);
    const doc = await call(adult, 'GET', `/api/v1/documents/${filed[0]?.document_id as string}`);
    expect(doc.json<{ tags: string[]; visibility: string }>()).toMatchObject({
      tags: [],
      visibility: 'household',
    });
    // Kept Only me, the same tag starts ticked on the card — still never filed unasked.
    const onlyMe = await made(adult, { defaults: { visibility: 'private' } });
    const kept = await sent(adult, onlyMe.id, 'IVF/scan.pdf');
    await plant(kept.id, passport(adult.member_id, 0.95));
    expect((await itemOf(adult, onlyMe.id, kept.id)).proposals?.tags).toEqual([
      { value: 'ivf', from: 'folder', existing: true, ticked: true },
    ]);
    const again = await call(adult, 'POST', `/api/v1/batches/${onlyMe.id}/accept-ready`, {});
    const second = again.json<{ accepted: Array<{ document_id: string }> }>().accepted[0];
    const kept2 = await call(adult, 'GET', `/api/v1/documents/${second?.document_id as string}`);
    expect(kept2.json<{ tags: string[] }>().tags).toEqual([]);
  });

  it('a scanner folder’s subfolder, sealed as the worker seals it, suggests the same', async () => {
    const b = await made(adult);
    const item = await sent(adult, b.id);
    // As apps/worker's watch-folder.ts seals it, from the file's path under the folder.
    const folder = itemFolder('Sana/Passports/scan-0001.pdf', { withFileName: true }) as string;
    const fileKey = await keyOf(item.id);
    await withSystem(h.db, hh, (trx) =>
      trx
        .updateTable('incoming_file')
        .set({
          folder_sealed: sealBytes(fileKey, Buffer.from(folder), itemFolderBinding(item.id)),
        })
        .where('id', '=', item.id)
        .execute(),
    );
    await plant(item.id, passport(adult.member_id, 0.8));
    expect(await itemOf(adult, b.id, item.id)).toMatchObject({
      folder: 'Sana/Passports',
      level: 'ready',
    });
  });

  it('kept as it is filed and taken back with it; gone as it is removed; nobody signed in writes it otherwise', async () => {
    const b = await made(adult);
    const filed = await sent(adult, b.id, 'Sana/Passports/scan.pdf');
    const removed = await sent(adult, b.id, 'Sana/Bills/scan.pdf');
    const held = await sent(adult, b.id, 'Sana/Wills/scan.pdf');
    await plant(filed.id, passport(adult.member_id, 0.8));
    // Accepted by Accept all Ready: the folder stays with it, and an Undo puts it back as it was.
    const all = await call(adult, 'POST', `/api/v1/batches/${b.id}/accept-ready`, {
      item_ids: [filed.id],
    });
    expect(all.statusCode, all.body).toBe(200);
    expect((await row(filed.id))?.state).toBe('accepted');
    expect((await itemOf(adult, b.id, filed.id)).folder).toBe('Sana/Passports');
    const undo = await call(adult, 'POST', `/api/v1/batches/${b.id}/accept-ready/undo`, {
      item_ids: [filed.id],
    });
    expect(undo.json<{ restored: string[] }>().restored).toEqual([filed.id]);
    expect((await itemOf(adult, b.id, filed.id)).folder).toBe('Sana/Passports');
    // Removed: gone with its name and its hash.
    expect(
      (await call(adult, 'DELETE', `/api/v1/batches/${b.id}/items/${removed.id}`)).statusCode,
    ).toBe(204);
    expect(await row(removed.id)).toMatchObject({ state: 'rejected', folder_sealed: null });
    // Its uploader, writing straight to the database, changes it not at all.
    const account = (
      await admin.query<{ account_id: string }>(
        'select account_id from account_household where member_id = $1',
        [adult.member_id],
      )
    ).rows[0]?.account_id as string;
    const asUploader = async (statement: string) => {
      const c = await app.connect();
      try {
        await c.query('begin');
        await c.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                  set_config('app.member_id', $2, true), set_config('app.role', 'adult', true),
                  set_config('app.account_id', $3, true)`,
          [hh, adult.member_id, account],
        );
        await c.query(statement);
        await c.query('commit');
        return null;
      } catch (err) {
        await c.query('rollback').catch(() => undefined);
        return (err as Error).message;
      } finally {
        c.release();
      }
    };
    expect(
      await asUploader(`update incoming_file set folder_sealed = '\\x00' where id = '${held.id}'`),
    ).toMatch(/may only file or refuse/);
    // Filed by hand as a version of a document of hers, the folder swapped as
    // it goes: refused; kept as it was, let through (and rolled back here).
    const doc = await call(adult, 'POST', `/api/v1/batches/${b.id}/items/${filed.id}/accept`, {
      title: 'Filed for the test',
      owner_member_id: adult.member_id,
    });
    expect(doc.statusCode, doc.body).toBe(201);
    const docId = doc.json<{ document_id: string }>().document_id;
    const source = (
      await admin.query<{
        vault_id: string;
        file_key_wrapped: Buffer;
        wrapped_by_scope: string;
        cipher_sha256: Buffer;
        sha256: Buffer;
      }>(
        `select vault_id, file_key_wrapped, wrapped_by_scope, cipher_sha256, sha256
           from document_version where document_id = $1`,
        [docId],
      )
    ).rows[0] as {
      vault_id: string;
      file_key_wrapped: Buffer;
      wrapped_by_scope: string;
      cipher_sha256: Buffer;
      sha256: Buffer;
    };
    const fileBy = (folder: string, rollback: boolean) => {
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
                text_sealed = null, as_version = true, folder_sealed = ${folder}
          where id = '${held.id}';
         ${rollback ? `select 1/0;` : ''}`,
      );
    };
    expect(await fileBy(`'\\x00'`, false)).toMatch(/may only file or refuse/);
    expect(await fileBy('null', false)).toMatch(/may only file or refuse/);
    expect(await fileBy('folder_sealed', true)).toMatch(/division by zero/);
    // Removed with its folder left behind: refused, as with its name left behind.
    expect(
      await asUploader(
        `update incoming_file set state = 'rejected', decided_by = '${account}', decided_at = now(),
                original_name = null, sha256 = null, proposals_sealed = null, text_sealed = null
          where id = '${held.id}'`,
      ),
    ).toMatch(/may only file or refuse/);
    // The same, with it let go: as the API removes one.
    expect(
      await asUploader(
        `update incoming_file set state = 'rejected', decided_by = '${account}', decided_at = now(),
                original_name = null, sha256 = null, proposals_sealed = null, text_sealed = null,
                folder_sealed = null
          where id = '${held.id}'`,
      ),
    ).toBeNull();
    // And the database's own bound, whoever writes: a removed item keeps none.
    const other = await sent(adult, b.id, 'Sana/Deeds/scan.pdf');
    await expect(
      admin.query(
        `update incoming_file set state = 'rejected', decided_at = now(), decided_by = $2,
                original_name = null, sha256 = null
          where id = $1`,
        [other.id, account],
      ),
    ).rejects.toThrow(/incoming_file_folder_kept/);
    await admin.query(
      `update incoming_file set state = 'rejected', decided_at = now(), decided_by = $2,
              original_name = null, sha256 = null, folder_sealed = null
        where id = $1`,
      [other.id, account],
    );
  });

  it('accepting what the folder suggested counts as needing no change, as accepting the pages’ does', async () => {
    const b = await made(adult);
    const item = await sent(adult, b.id, 'Sana/Passports/scan.pdf');
    await plant(item.id, {
      expires: { value: day('2031-03-14'), confidence: 0.94, cue: 'machine_lines' },
      identifier: { value: '533401872', confidence: 0.95, cue: 'machine_lines' },
      issued_by: { value: 'United Kingdom', confidence: 0.9, cue: 'machine_lines' },
    });
    const got = await itemOf(adult, b.id, item.id);
    const types = (await call(adult, 'GET', '/api/v1/document-types')).json<{
      items: DocumentTypeView[];
    }>().items;
    const people = (await call(adult, 'GET', '/api/v1/members')).json<{
      items: Array<{ id: string; display_name: string }>;
    }>().items;
    const before = (await call(adult, 'GET', '/api/v1/batches/learned')).json<BatchLearning>();
    const body = untouchedAccept({
      proposals: got.proposals as NonNullable<BatchItemView['proposals']>,
      defaults: b.defaults,
      types,
      people,
      role: 'adult',
      me: adult.member_id,
    });
    expect(body).toMatchObject({ type_key: 'passport', owner_member_id: adult.member_id });
    const res = await call(adult, 'POST', `/api/v1/batches/${b.id}/items/${item.id}/accept`, body);
    expect(res.statusCode, res.body).toBe(201);
    const after = (await call(adult, 'GET', '/api/v1/batches/learned')).json<BatchLearning>();
    expect(after.counted).toBe(before.counted + 1);
    expect(after.unchanged).toBe(before.unchanged + 1);
  });
});
