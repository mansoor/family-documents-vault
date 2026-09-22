import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { withHousehold } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { DocumentView, VersionView } from '@fdv/shared';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';

/** A minimal but real PDF, so the type sniffer sees application/pdf. */
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
const PNG_HEAD = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

describe.skipIf(!testAdminUrl())('documents API', () => {
  let h: Harness;
  let owner: Tokens;
  let memberId: string;

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();
    memberId = owner.member_id;
  });
  afterAll(() => h.close());

  const json = <T>(r: { json: () => unknown }) => r.json() as T;
  const errorCode = (r: { json: () => unknown }) => json<{ error: { code: string } }>(r).error.code;

  async function upload(
    t: Tokens,
    url: string,
    body: Buffer,
    filename: string,
    mime: string,
    key = randomUUID(),
  ) {
    const form = new FormData();
    form.append('file', body, { filename, contentType: mime });
    return h.app.inject({
      method: 'POST',
      url,
      headers: { ...h.as(t), ...form.getHeaders(), 'idempotency-key': key },
      payload: form.getBuffer(),
    });
  }

  it('lists the built-in document types', async () => {
    const res = await h.app.inject({ url: '/api/v1/document-types', headers: h.as(owner) });
    const types = json<{ items: Array<{ key: string; reminder_leads: number[] }> }>(res).items;
    expect(types.length).toBeGreaterThanOrEqual(21);
    expect(types.find((t) => t.key === 'passport')?.reminder_leads).toEqual([270, 180]);
  });

  let passport: DocumentView;

  it('creates a document with dates carrying precision and a derived status', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(owner),
      payload: {
        type_key: 'passport',
        title: "Mansoor's passport",
        owner_member_id: memberId,
        issued: { date: '2021-03-14', precision: 'day' },
        expires: { date: '2031-03-31', precision: 'month' },
        identifier: '563914782',
        physical_location: 'Bedroom safe, top shelf',
        tags: ['Travel', 'travel', ' ID '],
      },
    });
    expect(res.statusCode).toBe(201);
    passport = json<DocumentView>(res);
    expect(passport.expires).toEqual({ date: '2031-03-31', precision: 'month' });
    expect(passport.status.value).toBe('active');
    expect(passport.status.label).toMatch(/^Valid for/);
    expect(passport.category).toBe('identity'); // from the type
    expect(passport.is_essential).toBe(true); // passports usually are
    expect(passport.tags).toEqual(['travel', 'id']);
    expect(res.headers.etag).toBe(passport.etag);
  });

  it('refuses a client-set status and an unknown type', async () => {
    const status = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(owner),
      payload: { title: 'x', status: { value: 'active' } },
    });
    expect(status.statusCode).toBe(422);
    const type = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(owner),
      payload: { type_key: 'unicorn_licence' },
    });
    expect(type.statusCode).toBe(422);
  });

  it('a document with nothing but a title is valid and Needs info', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(owner),
      payload: { title: 'Scan from the kitchen' },
    });
    expect(res.statusCode).toBe(201);
    expect(json<DocumentView>(res).status).toEqual({ value: 'needs_info', label: 'Needs a name' });
  });

  it('PATCH honours If-Match and answers 409 with the current copy on a stale tag', async () => {
    const ok = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/documents/${passport.id}`,
      headers: { ...h.as(owner), 'if-match': passport.etag },
      payload: { notes: 'Renewed in 2021' },
    });
    expect(ok.statusCode).toBe(200);
    const updated = json<DocumentView>(ok);
    expect(updated.notes).toBe('Renewed in 2021');
    expect(updated.etag).not.toBe(passport.etag);

    const stale = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/documents/${passport.id}`,
      headers: { ...h.as(owner), 'if-match': passport.etag },
      payload: { notes: 'lost update' },
    });
    expect(stale.statusCode).toBe(409);
    expect(errorCode(stale)).toBe('conflict');
    passport = updated;
  });

  it('uploads a version: encrypted at rest, byte-identical on download', async () => {
    const body = Buffer.concat([PDF, randomBytes(2 * 1024 * 1024 + 123)]);
    const key = randomUUID();
    const res = await upload(
      owner,
      `/api/v1/documents/${passport.id}/versions`,
      body,
      'passport.pdf',
      'application/pdf',
      key,
    );
    expect(res.statusCode).toBe(201);
    const v = json<VersionView>(res);
    expect(v.version_no).toBe(1);
    expect(v.mime).toBe('application/pdf');
    expect(v.byte_size).toBe(body.length);
    expect(v.sha256).toBe(createHash('sha256').update(body).digest('hex'));

    // The stored object is ciphertext under the boring key layout.
    const row = await withHousehold(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('document_version')
        .selectAll()
        .where('id', '=', v.id)
        .executeTakeFirstOrThrow(),
    );
    expect(row.storage_key).toMatch(
      new RegExp(`^${owner.household_id}/${passport.id}/1/[0-9a-f]{16}\\.pdf\\.enc$`),
    );
    const { readFile } = await import('node:fs/promises');
    const stored = await readFile(`${h.vaultDir}/${row.storage_key}`);
    expect(stored.includes(PDF.subarray(0, 8))).toBe(false);
    expect(stored.length).toBe(Number(row.cipher_bytes));

    // Download: byte-identical, with the right headers.
    const dl = await h.app.inject({
      url: `/api/v1/versions/${v.id}/content`,
      headers: h.as(owner),
    });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe('application/pdf');
    expect(dl.headers['content-disposition']).toContain('passport.pdf');
    expect(dl.headers['content-length']).toBe(String(body.length));
    expect(dl.rawPayload.equals(body)).toBe(true);

    // Retry with the same key: same version, no duplicate.
    const again = await upload(
      owner,
      `/api/v1/documents/${passport.id}/versions`,
      body,
      'passport.pdf',
      'application/pdf',
      key,
    );
    expect(again.statusCode).toBe(201);
    expect(json<VersionView>(again).id).toBe(v.id);
    const versions = await h.app.inject({
      url: `/api/v1/documents/${passport.id}/versions`,
      headers: h.as(owner),
    });
    expect(json<{ items: VersionView[] }>(versions).items).toHaveLength(1);

    // Range: a slice from the middle, crossing the 1 MiB chunk boundary.
    const start = 1024 * 1024 - 100;
    const end = 1024 * 1024 + 100;
    const part = await h.app.inject({
      url: `/api/v1/versions/${v.id}/content`,
      headers: { ...h.as(owner), range: `bytes=${start}-${end}` },
    });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes ${start}-${end}/${body.length}`);
    expect(part.rawPayload.equals(body.subarray(start, end + 1))).toBe(true);

    const tail = await h.app.inject({
      url: `/api/v1/versions/${v.id}/content`,
      headers: { ...h.as(owner), range: 'bytes=-10' },
    });
    expect(tail.statusCode).toBe(206);
    expect(tail.rawPayload.equals(body.subarray(-10))).toBe(true);

    const bad = await h.app.inject({
      url: `/api/v1/versions/${v.id}/content`,
      headers: { ...h.as(owner), range: `bytes=${body.length + 5}-` },
    });
    expect(bad.statusCode).toBe(416);
  });

  it('a second upload becomes version 2 and the document reports both', async () => {
    const res = await upload(
      owner,
      `/api/v1/documents/${passport.id}/versions`,
      PDF,
      'renewed.pdf',
      'application/pdf',
    );
    expect(json<VersionView>(res).version_no).toBe(2);
    const doc = json<DocumentView>(
      await h.app.inject({ url: `/api/v1/documents/${passport.id}`, headers: h.as(owner) }),
    );
    expect(doc.versions).toBe(2);
    expect(doc.latest_version_id).toBe(json<VersionView>(res).id);
  });

  it('detects the real file type from the bytes and refuses what it does not accept', async () => {
    const lying = await upload(
      owner,
      `/api/v1/documents/${passport.id}/versions`,
      PDF,
      'photo.jpg',
      'image/jpeg',
    );
    expect(lying.statusCode).toBe(201);
    expect(json<VersionView>(lying).mime).toBe('application/pdf');

    const exe = await upload(
      owner,
      `/api/v1/documents/${passport.id}/versions`,
      Buffer.from('MZ\x90\x00 not a document'),
      'x.pdf',
      'application/pdf',
    );
    expect(exe.statusCode).toBe(415);
    expect(errorCode(exe)).toBe('unsupported_type');

    const noKey = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${passport.id}/versions`,
      headers: h.as(owner),
      payload: {},
    });
    expect(noKey.statusCode).toBe(422);
  });

  it('caps the upload size', async () => {
    const big = Buffer.concat([PNG_HEAD, randomBytes(6 * 1024 * 1024)]);
    const res = await upload(
      owner,
      `/api/v1/documents/${passport.id}/versions`,
      big,
      'big.png',
      'image/png',
    );
    expect(res.statusCode).toBe(413);
  });

  it('capture creates a Needs-info document with its first version in one call', async () => {
    const res = await upload(
      owner,
      '/api/v1/capture',
      Buffer.concat([PNG_HEAD, randomBytes(64)]),
      'IMG_0001.png',
      'image/png',
    );
    expect(res.statusCode).toBe(201);
    const cap = json<{ document_id: string; version_id: string; state: string }>(res);
    expect(cap.state).toBe('stored');
    const doc = json<DocumentView>(
      await h.app.inject({ url: `/api/v1/documents/${cap.document_id}`, headers: h.as(owner) }),
    );
    expect(doc.status.value).toBe('needs_info');
    expect(doc.versions).toBe(1);
  });

  it('lists with filters, sorts and cursors', async () => {
    for (let i = 0; i < 3; i++) {
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/documents',
        headers: h.as(owner),
        payload: {
          type_key: 'utility_bill',
          title: `Bill ${i}`,
          owner_member_id: memberId,
          tags: ['bills'],
        },
      });
    }
    const page1 = json<{ items: DocumentView[]; next_cursor: string | null; has_more: boolean }>(
      await h.app.inject({ url: '/api/v1/documents?limit=2&sort=recent', headers: h.as(owner) }),
    );
    expect(page1.items).toHaveLength(2);
    expect(page1.has_more).toBe(true);
    const page2 = json<{ items: DocumentView[] }>(
      await h.app.inject({
        url: `/api/v1/documents?limit=2&sort=recent&cursor=${page1.next_cursor}`,
        headers: h.as(owner),
      }),
    );
    expect(page2.items.map((d) => d.id)).not.toContain(page1.items[0]?.id);

    const tagged = json<{ items: DocumentView[] }>(
      await h.app.inject({ url: '/api/v1/documents?tag=bills', headers: h.as(owner) }),
    );
    expect(tagged.items).toHaveLength(3);

    const byType = json<{ items: DocumentView[] }>(
      await h.app.inject({ url: '/api/v1/documents?type_key=passport', headers: h.as(owner) }),
    );
    expect(byType.items.map((d) => d.id)).toEqual([passport.id]);

    const tags = json<{ items: Array<{ tag: string; count: number }> }>(
      await h.app.inject({ url: '/api/v1/tags?q=bi', headers: h.as(owner) }),
    );
    expect(tags.items).toEqual([{ tag: 'bills', count: 3 }]);

    const counts = json<{ by_category: Array<{ category: string | null; count: number }> }>(
      await h.app.inject({ url: '/api/v1/documents/counts', headers: h.as(owner) }),
    );
    expect(counts.by_category.find((c) => c.category === 'bills')?.count).toBe(3);
  });

  it('soft-deletes into the trash and restores', async () => {
    const del = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/documents/${passport.id}`,
      headers: h.as(owner),
    });
    expect(del.statusCode).toBe(204);
    const live = json<{ items: DocumentView[] }>(
      await h.app.inject({ url: '/api/v1/documents?type_key=passport', headers: h.as(owner) }),
    );
    expect(live.items).toEqual([]);
    const trash = json<{ items: DocumentView[] }>(
      await h.app.inject({ url: '/api/v1/documents?deleted=true', headers: h.as(owner) }),
    );
    expect(trash.items.map((d) => d.id)).toEqual([passport.id]);
    // content of a trashed document is still reachable (for the 30 days)
    const versions = json<{ items: VersionView[] }>(
      await h.app.inject({
        url: `/api/v1/documents/${passport.id}/versions`,
        headers: h.as(owner),
      }),
    );
    expect(versions.items.length).toBeGreaterThan(0);

    const restore = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${passport.id}/restore`,
      headers: h.as(owner),
    });
    expect(restore.statusCode).toBe(200);
    expect(json<DocumentView>(restore).deleted_at).toBeNull();
  });

  it('private documents belong to their member only, enforced in the query', async () => {
    // A second member (no sign-in) and a document private to them.
    const other = await withHousehold(h.db, owner.household_id, (trx) =>
      trx
        .insertInto('member')
        .values({ household_id: owner.household_id, display_name: 'Sana' })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    const refused = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(owner),
      payload: { title: 'Sana private', owner_member_id: other.id, visibility: 'private' },
    });
    expect(refused.statusCode).toBe(422); // only the owning member can mark private

    const mine = json<DocumentView>(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/documents',
        headers: h.as(owner),
        payload: { title: 'My private note', owner_member_id: memberId, visibility: 'private' },
      }),
    );
    expect(mine.visibility).toBe('private');

    // Simulate Sana having an account by forging a principal in the service.
    const { DocumentService } = await import('./service.js');
    const asSana = {
      accountId: randomUUID(),
      sessionId: randomUUID(),
      householdId: owner.household_id,
      memberId: other.id,
      role: 'adult' as const,
    };
    const { ScopeKeys, EnvKeyProvider } = await import('@fdv/crypto');
    const { VaultService } = await import('../vaults/service.js');
    const { deriveKey } = await import('@fdv/crypto');
    const { TEST_MASTER } = await import('../test-harness.js');
    const service = new DocumentService(
      h.db,
      new ScopeKeys(new EnvKeyProvider(TEST_MASTER)),
      new VaultService(h.db, deriveKey(TEST_MASTER, 'vault-credentials'), h.vaultDir),
      1024,
    );
    await expect(service.get(asSana, mine.id)).rejects.toMatchObject({ code: 'not_found' });
    const list = await service.list(asSana, {});
    expect(list.items.map((d) => d.id)).not.toContain(mine.id);
    expect(list.items.map((d) => d.id)).toContain(passport.id); // household-visible
    const asTeen = { ...asSana, role: 'teen' as const };
    const teenList = await service.list(asTeen, {});
    expect(teenList.items.every((d) => d.visibility === 'household')).toBe(true);
  });

  it('wrote a clean audit chain including downloads', async () => {
    const { verifyAuditChain } = await import('@fdv/db');
    const r = await withHousehold(h.db, owner.household_id, (trx) =>
      verifyAuditChain(trx, owner.household_id),
    );
    expect(r.ok).toBe(true);
    const actions = await withHousehold(h.db, owner.household_id, (trx) =>
      trx.selectFrom('audit_event').select('action').execute(),
    );
    const set = new Set(actions.map((a) => a.action));
    expect(set.has('document.downloaded')).toBe(true);
    expect(set.has('document.version_added')).toBe(true);
    expect(set.has('document.deleted')).toBe(true);
    expect(set.has('document.restored')).toBe(true);
  });
});
