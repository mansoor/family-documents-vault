import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { deriveKey, EncryptStream, EnvKeyProvider, ScopeKeys, unwrapKey } from '@fdv/crypto';
import { withHousehold } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { ActivityLine, DocumentView, VersionView } from '@fdv/shared';
import { adapterFromRow, type StorageAdapter } from '@fdv/storage';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, TEST_MASTER, type Harness } from '../test-harness.js';

/**
 * Pages the vault draws (0.4.12): GET /versions/{id}/pages/{n}.
 *
 * The worker draws them (its own tests cover the drawing); here they are
 * put where it would put them, encrypted under the version's key, so what
 * is under test is the door: who gets through it, what they are asked
 * first, what they are told while a page is on its way, and what is
 * written down about it.
 */
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n');
/** A JPEG's markers around something that says which page it is. */
const jpeg = (n: number) =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from(`page ${n}`),
    Buffer.from([0xff, 0xd9]),
  ]);

describe.skipIf(!testAdminUrl())('pages the vault draws', () => {
  let h: Harness;
  let owner: Tokens;
  const keys = new ScopeKeys(new EnvKeyProvider(TEST_MASTER));
  const doc: Record<string, string> = {};
  const version: Record<string, string> = {};

  const make = async (
    key: string,
    fields: { type_key: string; visibility?: 'household' | 'private'; is_essential?: boolean },
  ) => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(owner),
      payload: { title: key, owner_member_id: owner.member_id, ...fields },
    });
    expect(created.statusCode, created.body).toBe(201);
    doc[key] = created.json<DocumentView>().id;
    const form = new FormData();
    form.append('file', PDF, { filename: `${key}.pdf`, contentType: 'application/pdf' });
    const up = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${doc[key]}/versions`,
      headers: { ...h.as(owner), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    expect(up.statusCode, up.body).toBe(201);
    version[key] = up.json<{ id: string }>().id;
  };

  const put = async (adapter: StorageAdapter, key: string, fileKey: Buffer, plain: Buffer) => {
    const enc = new EncryptStream(fileKey);
    await Promise.all([adapter.put(key, enc), pipeline(Readable.from([plain]), enc)]);
  };

  /** What the worker leaves behind: `pages` drawn pages, and a thumbnail if asked. */
  const draw = (key: string, pages: number, thumbnail = false) =>
    withHousehold(h.db, owner.household_id, async (trx) => {
      const v = await trx
        .selectFrom('document_version')
        .selectAll()
        .where('id', '=', version[key] as string)
        .executeTakeFirstOrThrow();
      const vault = await trx
        .selectFrom('vault')
        .selectAll()
        .where('id', '=', v.vault_id)
        .executeTakeFirstOrThrow();
      const adapter = adapterFromRow(
        vault,
        deriveKey(TEST_MASTER, 'vault-credentials'),
        h.vaultDir,
      );
      const scopeKey = await keys.unwrapById(trx, v.wrapped_by_scope);
      const fileKey = unwrapKey(v.file_key_wrapped, scopeKey, `version:${v.document_id}`);
      for (let n = 1; n <= pages; n += 1) {
        await put(adapter, `${v.storage_key}.p${n}.enc`, fileKey, jpeg(n));
      }
      if (thumbnail) await put(adapter, `${v.storage_key}.thumb.enc`, fileKey, jpeg(0));
      await trx
        .updateTable('document_version')
        .set({
          preview_state: 'ready',
          preview_pages: pages,
          ...(thumbnail ? { thumbnail_key: `${v.storage_key}.thumb.enc` } : {}),
        })
        .where('id', '=', v.id)
        .execute();
    });

  /** The owner's sessions, made older than the step-up window, or fresh again. */
  const setFresh = (fresh: boolean) =>
    withHousehold(h.db, owner.household_id, (trx) =>
      trx
        .updateTable('session')
        .set({ verified_at: new Date(Date.now() - (fresh ? 0 : 6 * 60 * 1000)) })
        .execute(),
    );

  const page = (key: string, n: number | string) =>
    h.app.inject({ url: `/api/v1/versions/${version[key]}/pages/${n}`, headers: h.as(owner) });
  const previewJobs = (key: string) =>
    h.jobs.filter((j) => j.name === 'version.previews' && j.data.version_id === version[key]);
  const errorOf = (r: { json: () => unknown }) =>
    (r.json() as { error: { code: string; message: string; retriable: boolean; action?: string } })
      .error;

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();
    await make('Water bill', { type_key: 'utility_bill' });
    await make('Passport', { type_key: 'passport', is_essential: true });
    await make('Therapy notes', { type_key: 'medical_record', visibility: 'private' });
    await make('Lease', { type_key: 'utility_bill' });
    await make('Spreadsheet', { type_key: 'utility_bill' });
  }, 90_000);
  afterAll(() => h.close());

  it('says the vault draws pages', async () => {
    const caps = await h.app.inject({ url: '/api/v1/capabilities' });
    expect(caps.json<{ features: Record<string, boolean> }>().features.page_previews).toBe(true);
  });

  it('a pending page says preview_pending and queues one job', async () => {
    const first = await page('Water bill', 1);
    expect(first.statusCode).toBe(404);
    expect(errorOf(first)).toMatchObject({ code: 'preview_pending', retriable: true });
    expect(first.headers['retry-after']).toBe('3');
    // Asked again while it is on its way: the same answer, and no second job.
    const second = await page('Water bill', 2);
    expect(errorOf(second).code).toBe('preview_pending');
    expect(previewJobs('Water bill')).toHaveLength(1);
    expect(previewJobs('Water bill')[0]?.data).toEqual({
      household_id: owner.household_id,
      version_id: version['Water bill'],
    });
    // A job that seems to have been lost is queued again.
    await withHousehold(h.db, owner.household_id, (trx) =>
      trx
        .updateTable('document_version')
        .set({ preview_requested_at: new Date(Date.now() - 3 * 60 * 1000) })
        .where('id', '=', version['Water bill'] as string)
        .execute(),
    );
    await page('Water bill', 1);
    expect(previewJobs('Water bill')).toHaveLength(2);
  });

  it('a drawn page is a JPEG no cache keeps; past the last one there is no preview', async () => {
    await draw('Water bill', 2);
    const one = await page('Water bill', 1);
    expect(one.statusCode, one.body).toBe(200);
    expect(one.headers['content-type']).toBe('image/jpeg');
    expect(one.headers['cache-control']).toBe('private, no-store');
    expect(one.rawPayload.equals(jpeg(1))).toBe(true);
    expect((await page('Water bill', 2)).rawPayload.equals(jpeg(2))).toBe(true);

    const past = await page('Water bill', 3);
    expect(past.statusCode).toBe(404);
    expect(errorOf(past)).toMatchObject({ code: 'no_preview', retriable: false });
    expect(errorOf(past).message).toBe(
      "There's no preview of this page. You can save a copy to open it.",
    );
    expect((await page('Water bill', 0)).statusCode).toBe(422);
    expect((await page('Water bill', 'one')).statusCode).toBe(422);

    // The version says how many there are.
    const versions = await h.app.inject({
      url: `/api/v1/documents/${doc['Water bill']}/versions`,
      headers: h.as(owner),
    });
    expect(versions.json<{ items: VersionView[] }>().items[0]?.preview_pages).toBe(2);
  });

  it('a file the vault cannot draw says so, and queues nothing', async () => {
    await withHousehold(h.db, owner.household_id, (trx) =>
      trx
        .updateTable('document_version')
        .set({ preview_state: 'unsupported', preview_pages: 0 })
        .where('id', '=', version.Spreadsheet as string)
        .execute(),
    );
    const res = await page('Spreadsheet', 1);
    expect(errorOf(res)).toMatchObject({
      code: 'no_preview',
      message: "There's no preview for this kind of file. You can save a copy to open it.",
    });
    expect(previewJobs('Spreadsheet')).toHaveLength(0);
  });

  it('every page fetch is audited, and the log shows one line per sitting', async () => {
    const viewed = await withHousehold(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('audit_event')
        .select(['detail', 'object_id'])
        .where('action', '=', 'document.viewed')
        .orderBy('id')
        .execute(),
    );
    // Two pages served above; the refusals and the pending answers are not views.
    expect(viewed.map((v) => v.detail)).toEqual([
      { version_id: version['Water bill'], page: 1 },
      { version_id: version['Water bill'], page: 2 },
    ]);
    expect(viewed.every((v) => v.object_id === doc['Water bill'])).toBe(true);

    const lines = async () =>
      (await h.app.inject({ url: '/api/v1/audit', headers: h.as(owner) }))
        .json<{ items: ActivityLine[] }>()
        .items.filter((l) => l.text.includes('looked at'))
        .map((l) => l.text);
    expect(await lines()).toEqual(['Owner looked at “Water bill”']);

    // Downloaded in between, and looked at again: that is two sittings.
    await h.app.inject({
      url: `/api/v1/versions/${version['Water bill']}/content`,
      headers: h.as(owner),
    });
    await page('Water bill', 1);
    expect(await lines()).toEqual(['Owner looked at “Water bill”', 'Owner looked at “Water bill”']);
  });

  it('an Essential’s page asks with open_essential and says why in plain words', async () => {
    await draw('Passport', 1);
    await draw('Therapy notes', 1);
    await setFresh(false);
    try {
      for (const url of [
        `/api/v1/versions/${version.Passport}/pages/1`,
        `/api/v1/versions/${version.Passport}/content`,
      ]) {
        const res = await h.app.inject({ url, headers: h.as(owner) });
        expect(res.statusCode, url).toBe(403);
        expect(errorOf(res), url).toMatchObject({
          code: 'step_up_required',
          action: 'open_essential',
          message: 'Please confirm it is you to open an Essential document.',
        });
      }
      // A share link to it asks the same.
      const link = await h.app.inject({
        method: 'POST',
        url: `/api/v1/documents/${doc.Passport}/share`,
        headers: h.as(owner),
        payload: {},
      });
      expect(errorOf(link).action).toBe('open_essential');
      // "Only me" is still "only me".
      const mine = await page('Therapy notes', 1);
      expect(errorOf(mine)).toMatchObject({
        code: 'step_up_required',
        action: 'open_private_document',
        message: 'Please confirm it is you to open a document only you can see.',
      });
      // An everyday document does not ask.
      expect((await page('Water bill', 1)).statusCode).toBe(200);
    } finally {
      await setFresh(true);
    }
    expect((await page('Passport', 1)).statusCode).toBe(200);
  });

  it('an Essential’s or an "only me" thumbnail is kept by no cache; an everyday one for an hour', async () => {
    await draw('Passport', 1, true);
    await draw('Therapy notes', 1, true);
    await draw('Water bill', 2, true);
    const cacheOf = async (key: string) =>
      (
        await h.app.inject({
          url: `/api/v1/versions/${version[key]}/thumbnail`,
          headers: h.as(owner),
        })
      ).headers['cache-control'];
    expect(await cacheOf('Passport')).toBe('private, no-store');
    expect(await cacheOf('Therapy notes')).toBe('private, no-store');
    expect(await cacheOf('Water bill')).toBe('private, max-age=3600');
  });

  it('making a document Essential queues its pages, once', async () => {
    expect(previewJobs('Lease')).toHaveLength(0);
    const made = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/documents/${doc.Lease}`,
      headers: h.as(owner),
      payload: { is_essential: true },
    });
    expect(made.statusCode, made.body).toBe(200);
    expect(previewJobs('Lease')).toHaveLength(1);
    const state = await withHousehold(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('document_version')
        .select('preview_state')
        .where('id', '=', version.Lease as string)
        .executeTakeFirstOrThrow(),
    );
    expect(state.preview_state).toBe('queued');
    // Already Essential: edited again, nothing more is queued.
    await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/documents/${doc.Lease}`,
      headers: h.as(owner),
      payload: { title: 'The lease', is_essential: true },
    });
    expect(previewJobs('Lease')).toHaveLength(1);
  });
});
