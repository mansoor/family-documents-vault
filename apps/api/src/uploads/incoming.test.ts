import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DecryptStream, EncryptStream, EnvKeyProvider, ScopeKeys, unwrapKey } from '@fdv/crypto';
import { createPool, withScope, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import { LocalAdapter, readAll } from '@fdv/storage';
import {
  NOT_SCANNED,
  type ActivityLine,
  type CreatedUploadRequest,
  type DocumentView,
  type DropFile,
  type IncomingFileView,
  type Tokens,
  type UploadRequestInput,
  type VersionView,
} from '@fdv/shared';
import FormData from 'form-data';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, TEST_MASTER, type Harness } from '../test-harness.js';

/**
 * Incoming (5.23): what somebody outside the family sent through a request,
 * looked at before it is filed — the inbox, the previews, a copy, filing it
 * and refusing it — and who may do any of it. The worker is not here: what
 * it does once a sender presses Finish (the scan, none here, A42, and the
 * pages drawn) is stood in for by `ready`; its own tests are
 * apps/worker/src/jobs/incoming.test.ts.
 */

/** The harness's passwords: the owner's at setup, everybody else's as they joined. */
const OWNER_PASSWORD = 'correct horse battery';
const JOINED_PASSWORD = 'another correct horse';

const PDF = (marker: string, size = 2048) =>
  Buffer.concat([
    Buffer.from(`%PDF-1.4\n% ${marker}\n`),
    Buffer.alloc(Math.max(0, size - 32), 0x20),
    Buffer.from('\n%%EOF\n'),
  ]);
/** A JPEG, as far as its first bytes say. */
const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);
/** What the worker would have drawn: a JPEG page, in so far as its bytes say. */
const PAGE = Buffer.concat([JPEG, Buffer.from('page one')]);

describe.skipIf(!testAdminUrl())('incoming: look before it is filed', () => {
  let h: Harness;
  let owner: Tokens;
  let adult: Tokens;
  let other: Tokens;
  let teen: Tokens;
  let viewer: Tokens;
  let household: string;
  let ip = 0;
  const keys = new ScopeKeys(new EnvKeyProvider(TEST_MASTER));
  /** Each sender's call from an address of its own: the drop routes are 20 a minute each. */
  const addr = () => `10.78.${(++ip >> 8) & 0xff}.${ip & 0xff}`;
  /** A decision held before it commits, for the races; null lets every one through. */
  let hold: ((what: 'accept' | 'reject', id: string) => Promise<void>) | null = null;

  beforeAll(async () => {
    h = await createHarness({
      rateLimitPerMinute: 100_000,
      incomingBeforeCommit: async (what, id) => {
        if (hold) await hold(what, id);
      },
    });
    owner = await h.setup();
    household = owner.household_id;
    adult = await h.join(owner, { name: 'Adult', email: 'adult@example.test', role: 'adult' });
    other = await h.join(owner, { name: 'Other', email: 'other@example.test', role: 'adult' });
    teen = await h.join(owner, { name: 'Teen', email: 'teen@example.test', role: 'teen' });
    viewer = await h.join(owner, { name: 'Viewer', email: 'viewer@example.test', role: 'viewer' });
  }, 120_000);
  afterAll(() => h.close());

  const admin = async <T extends object>(text: string, params: unknown[] = []): Promise<T[]> => {
    const pool = createPool(h.adminUrl, 1);
    try {
      return (await pool.query<T>(text, params)).rows;
    } finally {
      await pool.end();
    }
  };

  const inAWeek = () => new Date(Date.now() + 7 * 864e5).toISOString();

  /** A request made, opened by its sender, these files sent, and Finish pressed (unless not). */
  const arrive = async (
    as: Tokens,
    body: Partial<UploadRequestInput>,
    files: Array<{ name: string; bytes: Buffer; type?: string }>,
    opts: { finish?: boolean } = {},
  ) => {
    const made = await h.app.inject({
      method: 'POST',
      url: '/api/v1/upload-requests',
      headers: h.as(as),
      payload: { title: 'Your tax papers', expires_at: inAWeek(), ...body },
    });
    expect(made.statusCode, made.body).toBe(201);
    const request = made.json<CreatedUploadRequest>();
    const open = await h.app.inject({
      method: 'POST',
      url: '/api/v1/drop/unlock',
      payload: { token: request.link_token },
      remoteAddress: addr(),
    });
    expect(open.statusCode, open.body).toBe(200);
    const set = open.cookies.find((c) => c.name.startsWith('fdv_drop_s_'));
    const cookie = { [set?.name as string]: set?.value as string };
    const sent: DropFile[] = [];
    for (const f of files) {
      const form = new FormData();
      form.append('file', f.bytes, { filename: f.name, contentType: f.type ?? 'application/pdf' });
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/drop/files',
        headers: form.getHeaders(),
        cookies: cookie,
        payload: form.getBuffer(),
        remoteAddress: addr(),
      });
      expect(res.statusCode, res.body).toBe(201);
      sent.push(res.json<DropFile>());
    }
    if (opts.finish === false) return { request: request.request, files: sent };
    const finished = await h.app.inject({
      method: 'POST',
      url: '/api/v1/drop/finish',
      cookies: cookie,
      payload: { note: 'Here they are.' },
      remoteAddress: addr(),
    });
    expect(finished.statusCode, finished.body).toBe(200);
    return { request: request.request, files: sent };
  };

  /**
   * What the worker does once Finish is pressed (jobs/incoming.ts): scanned
   * by nothing (A42), its pages drawn — here, `pages` pages made elsewhere,
   * encrypted under the file's own key beside its object.
   */
  const ready = async (fileId: string, pages = 1) => {
    await withSystem(h.db, household, async (trx) => {
      const f = await trx
        .selectFrom('incoming_file')
        .select(['storage_key', 'file_key_wrapped', 'wrapped_by_scope'])
        .where('id', '=', fileId)
        .executeTakeFirstOrThrow();
      const fileKey = unwrapKey(
        f.file_key_wrapped,
        await keys.unwrapById(trx, f.wrapped_by_scope),
        `incoming:${fileId}`,
      );
      const local = new LocalAdapter(h.vaultDir);
      for (let n = 1; n <= pages; n++) {
        const enc = new EncryptStream(fileKey);
        await Promise.all([
          local.put(`${f.storage_key}.p${n}.enc`, enc),
          pipeline(Readable.from([PAGE]), enc),
        ]);
      }
      await trx
        .updateTable('incoming_file')
        .set({ scan_state: 'unscanned', preview_state: 'ready', preview_pages: pages })
        .where('id', '=', fileId)
        .execute();
    });
  };

  const inbox = async (as: Tokens) => {
    const res = await h.app.inject({ url: '/api/v1/incoming', headers: h.as(as) });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ items: IncomingFileView[] }>().items;
  };
  const accept = (as: Tokens, id: string, body: Record<string, unknown> = {}) =>
    h.app.inject({
      method: 'POST',
      url: `/api/v1/incoming/${id}/accept`,
      headers: h.as(as),
      payload: body,
    });
  const reject = (as: Tokens, id: string) =>
    h.app.inject({ method: 'POST', url: `/api/v1/incoming/${id}/reject`, headers: h.as(as) });
  const page = (as: Tokens, id: string, n = 1) =>
    h.app.inject({ url: `/api/v1/incoming/${id}/pages/${n}`, headers: h.as(as) });
  const content = (as: Tokens, id: string) =>
    h.app.inject({ url: `/api/v1/incoming/${id}/content`, headers: h.as(as) });
  /** Confirming it is them (SEC-17), which an Essential or an Only me document asks first. */
  const stepUp = async (as: Tokens) => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/step-up',
      headers: h.as(as),
      payload: { password: as === owner ? OWNER_PASSWORD : JOINED_PASSWORD },
    });
    expect(res.statusCode, res.body).toBe(200);
  };
  const objectThere = (key: string) =>
    stat(path.join(h.vaultDir, key)).then(
      () => true,
      () => false,
    );
  const fileRow = async (id: string) =>
    (
      await admin<{
        state: string;
        decided_by: string | null;
        document_id: string | null;
        version_id: string | null;
        object_removed_at: Date | null;
        storage_key: string;
      }>(
        `select state, decided_by, document_id, version_id, object_removed_at, storage_key
           from incoming_file where id = $1`,
        [id],
      )
    )[0];
  const accountOf = async (t: Tokens) =>
    (await h.app.inject({ url: '/api/v1/me', headers: h.as(t) })).json<{ account_id: string }>()
      .account_id;
  const activity = async (as: Tokens) =>
    (await h.app.inject({ url: '/api/v1/audit?limit=100', headers: h.as(as) }))
      .json<{ items: ActivityLine[] }>()
      .items.map((l) => l.text);
  /** An answer within a second and a half, or 'held'. */
  const soon = <T>(p: Promise<T>) =>
    Promise.race([p, new Promise<'held'>((r) => setTimeout(() => r('held'), 1500))]);
  /** A gate a held decision waits at, and the moment it reached it. */
  const gate = () => {
    let open!: () => void;
    let reached!: () => void;
    const opened = new Promise<void>((r) => (open = r));
    const arrived = new Promise<void>((r) => (reached = r));
    return { open, arrived, wait: () => (reached(), opened) };
  };

  it('the vault says it can be asked to send documents', async () => {
    const caps = await h.app.inject({ url: '/api/v1/capabilities' });
    expect(caps.json<{ features: { upload_requests?: boolean } }>().features.upload_requests).toBe(
      true,
    );
  });

  it('accepting files it for the chosen person and visibility, and it opens', async () => {
    const bytes = PDF('w-2');
    const { files } = await arrive(
      adult,
      { recipient_label: 'Jane, accountant', suggested_member_id: teen.member_id },
      [{ name: 'W-2 2025.pdf', bytes }],
    );
    const file = files[0] as DropFile;
    // Sent: the worker is asked to get it ready, and nothing reads it yet.
    const queued = h.jobs.filter((j) => j.name === 'incoming.scan').at(-1);
    expect(queued?.data).toMatchObject({ household_id: household });
    await ready(file.id);

    const waiting = (await inbox(adult)).find((f) => f.id === file.id);
    expect(waiting).toMatchObject({
      name: 'W-2 2025.pdf',
      content_type: 'application/pdf',
      byte_size: bytes.length,
      recipient_label: 'Jane, accountant',
      request_title: 'Your tax papers',
      sender_note: 'Here they are.',
      scan_state: 'unscanned',
      preview_state: 'ready',
      preview_pages: 1,
      suggested_member_id: teen.member_id,
      review_by: 'me',
      moved_to_owners: false,
    });
    // Removed 30 days after it arrived, unless it is filed.
    const days =
      (Date.parse(waiting?.removed_at ?? '') - Date.parse(waiting?.sent_at ?? '')) / 864e5;
    expect(Math.round(days)).toBe(30);
    // Its preview is the page the worker drew.
    const shown = await page(adult, file.id);
    expect(shown.statusCode, shown.body).toBe(200);
    expect(shown.headers['content-type']).toBe('image/jpeg');
    expect(shown.rawPayload.equals(PAGE)).toBe(true);
    expect((await page(adult, file.id, 2)).json()).toMatchObject({
      error: { code: 'no_preview' },
    });

    const jobsBefore = h.jobs.length;
    const res = await accept(adult, file.id, {
      owner_member_id: teen.member_id,
      type_key: 'tax_form',
      title: 'W-2 for 2025',
      visibility: 'household',
    });
    expect(res.statusCode, res.body).toBe(201);
    const made = res.json<{ document_id: string; version_id: string }>();

    // A document now, as chosen.
    const doc = (
      await h.app.inject({ url: `/api/v1/documents/${made.document_id}`, headers: h.as(adult) })
    ).json<DocumentView>();
    expect(doc).toMatchObject({
      owner_member_id: teen.member_id,
      type_key: 'tax_form',
      title: 'W-2 for 2025',
      visibility: 'household',
      versions: 1,
      latest_version_id: made.version_id,
      filed_by_me: true,
    });
    // And it opens: its bytes are the bytes sent, under the name its bytes say.
    await stepUp(adult);
    const opened = await h.app.inject({
      url: `/api/v1/versions/${made.version_id}/content`,
      headers: h.as(adult),
    });
    expect(opened.statusCode, opened.body).toBe(200);
    expect(opened.rawPayload.equals(bytes)).toBe(true);
    expect(opened.headers['content-disposition']).toContain("filename*=UTF-8''W-2%202025.pdf");
    // The teen it is for sees it, as anybody would a family document of theirs.
    expect(
      (await h.app.inject({ url: `/api/v1/documents/${made.document_id}`, headers: h.as(teen) }))
        .statusCode,
    ).toBe(200);

    // The file is decided, says what it became, and is gone from the inbox,
    // its own bytes and its page with it.
    expect(await fileRow(file.id)).toMatchObject({
      state: 'accepted',
      decided_by: await accountOf(adult),
      document_id: made.document_id,
      version_id: made.version_id,
    });
    const row = await fileRow(file.id);
    expect(row?.object_removed_at).not.toBeNull();
    expect(await objectThere(row?.storage_key as string)).toBe(false);
    expect(await objectThere(`${row?.storage_key}.p1.enc`)).toBe(false);
    expect((await inbox(adult)).some((f) => f.id === file.id)).toBe(false);
    // Its OCR, page count and previews: queued now, and not before.
    expect(h.jobs.slice(jobsBefore)).toContainEqual({
      name: 'version.process',
      data: { household_id: household, version_id: made.version_id },
    });
    expect(
      h.jobs
        .slice(0, jobsBefore)
        .some((j) => j.name === 'version.process' && j.data.version_id === made.version_id),
    ).toBe(false);
  });

  it("filing a file sent in records who filed it, never nobody (5.24's rule)", async () => {
    const { files } = await arrive(owner, { review_by: 'adults' }, [
      { name: 'deed.pdf', bytes: PDF('deed') },
    ]);
    const file = files[0] as DropFile;
    await ready(file.id);
    // Filed by another adult than the one who asked.
    const res = await accept(other, file.id, { title: 'Deed' });
    expect(res.statusCode, res.body).toBe(201);
    const { document_id, version_id } = res.json<{ document_id: string; version_id: string }>();
    const [made] = await admin<{ created_by: string | null; uploaded_by: string | null }>(
      `select d.created_by, v.uploaded_by from document d
         join document_version v on v.document_id = d.id
        where d.id = $1 and v.id = $2`,
      [document_id, version_id],
    );
    const filer = await accountOf(other);
    expect(made).toEqual({ created_by: filer, uploaded_by: filer });
  });

  it("accepting into Only me wraps it under that person's key", async () => {
    const { files } = await arrive(adult, {}, [
      { name: 'payslip.jpg', bytes: JPEG, type: 'image/jpeg' },
    ]);
    const file = files[0] as DropFile;
    await ready(file.id);
    const res = await accept(adult, file.id, {
      owner_member_id: adult.member_id,
      visibility: 'private',
      title: 'Payslip',
    });
    expect(res.statusCode, res.body).toBe(201);
    const { document_id, version_id } = res.json<{ document_id: string; version_id: string }>();

    // Wrapped under the adult's own member key, and nobody else's.
    const [wrapped] = await admin<{ kind: string; member_id: string | null }>(
      `select k.kind, k.member_id from document_version v
         join scope_key k on k.id = v.wrapped_by_scope where v.id = $1`,
      [version_id],
    );
    expect(wrapped).toEqual({ kind: 'member', member_id: adult.member_id });
    // The round trip: that key, bound to this document, opens the bytes kept,
    // and they are the bytes sent.
    const plain = await withSystem(h.db, household, async (trx) => {
      const v = await trx
        .selectFrom('document_version')
        .select(['storage_key', 'file_key_wrapped'])
        .where('id', '=', version_id)
        .executeTakeFirstOrThrow();
      const member = await keys.unwrap(trx, {
        householdId: household,
        kind: 'member',
        memberId: adult.member_id,
      });
      const fileKey = unwrapKey(v.file_key_wrapped, member.key, `version:${document_id}`);
      const dec = new DecryptStream(fileKey);
      const [, out] = await Promise.all([
        pipeline(await new LocalAdapter(h.vaultDir).get(v.storage_key), dec),
        readAll(dec),
      ]);
      return out;
    });
    expect(plain.equals(JPEG)).toBe(true);
    // And through the vault, once they confirm it is them; to nobody else.
    await stepUp(adult);
    const opened = await h.app.inject({
      url: `/api/v1/versions/${version_id}/content`,
      headers: h.as(adult),
    });
    expect(opened.rawPayload.equals(JPEG)).toBe(true);
    for (const t of [owner, other]) {
      expect(
        (await h.app.inject({ url: `/api/v1/documents/${document_id}`, headers: h.as(t) }))
          .statusCode,
      ).toBe(404);
    }
    // Only me is for one's own: somebody else's is refused, and nothing is filed.
    const { files: more } = await arrive(adult, {}, [{ name: 'x.pdf', bytes: PDF('x') }]);
    const another = more[0] as DropFile;
    await ready(another.id);
    const refused = await accept(adult, another.id, {
      owner_member_id: teen.member_id,
      visibility: 'private',
    });
    expect(refused.statusCode).toBe(422);
    expect((await fileRow(another.id))?.state).toBe('received');
  });

  it('accepting into a document the reviewer cannot see or edit is 404', async () => {
    const { files } = await arrive(adult, {}, [{ name: 'renewal.pdf', bytes: PDF('renewal') }]);
    const file = files[0] as DropFile;
    await ready(file.id);
    const create = async (as: Tokens, body: Record<string, unknown>) => {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/documents',
        headers: h.as(as),
        payload: body,
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json<DocumentView>().id;
    };
    // Another adult's Only me document; one that does not exist; one in the Trash.
    const theirs = await create(other, {
      title: 'Theirs',
      owner_member_id: other.member_id,
      visibility: 'private',
    });
    const trashed = await create(adult, { title: 'Old lease' });
    expect(
      (
        await h.app.inject({
          method: 'DELETE',
          url: `/api/v1/documents/${trashed}`,
          headers: h.as(adult),
        })
      ).statusCode,
    ).toBe(204);
    for (const into of [theirs, randomUUID(), trashed]) {
      const res = await accept(adult, file.id, { into_document_id: into });
      expect(res.statusCode, `${into}: ${res.body}`).toBe(404);
      expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
    }
    // Nothing of it was filed, and nothing was left behind.
    expect((await fileRow(file.id))?.state).toBe('received');
    const versions = await admin<{ n: number }>(
      'select count(*)::int as n from document_version where document_id = any($1::uuid[])',
      [[theirs, trashed]],
    );
    expect(versions[0]?.n).toBe(0);
    // Both at once is neither.
    const both = await accept(adult, file.id, { into_document_id: theirs, title: 'New' });
    expect(both.statusCode).toBe(422);

    // A family document the reviewer may change takes it as its next version.
    const family = await create(owner, { title: 'Insurance policy' });
    const res = await accept(adult, file.id, { into_document_id: family });
    expect(res.statusCode, res.body).toBe(201);
    const listed = (
      await h.app.inject({ url: `/api/v1/documents/${family}/versions`, headers: h.as(owner) })
    ).json<{ items: VersionView[] }>().items;
    expect(listed.map((v) => v.version_no)).toEqual([1]);
    expect(res.json<{ document_id: string }>().document_id).toBe(family);
  });

  it('history names the request link', async () => {
    const { files } = await arrive(
      owner,
      { review_by: 'adults', recipient_label: 'Jane, accountant' },
      [{ name: 'statement.pdf', bytes: PDF('statement') }],
    );
    const file = files[0] as DropFile;
    await ready(file.id);
    const res = await accept(owner, file.id, { title: 'Bank statement', visibility: 'household' });
    expect(res.statusCode, res.body).toBe(201);
    const { document_id } = res.json<{ document_id: string }>();
    const history = async (as: Tokens) =>
      (
        await h.app.inject({ url: `/api/v1/documents/${document_id}/versions`, headers: h.as(as) })
      ).json<{ items: VersionView[] }>().items[0];
    // Its reviewers are told where it came from.
    for (const t of [owner, adult, other]) {
      expect(await history(t)).toMatchObject({
        sent_through: 'Sent through a request link (Jane, accountant)',
        uploaded_by_name: 'Owner',
      });
    }
    // A teen, given no request, is told who filed it; a viewer, nothing.
    expect(await history(teen)).toMatchObject({ sent_through: null, uploaded_by_name: 'Owner' });
    expect(await history(viewer)).toMatchObject({ sent_through: null, uploaded_by_name: null });

    // The activity log names the sender by their link, as the request did.
    const lines = await activity(owner);
    expect(lines).toContain('Upload link (Jane, accountant) sent a file');
    expect(lines).toContain('Owner filed a document sent by Jane, accountant');
    // Never the file's name; and the teen reads no line about it.
    expect(lines.some((l) => l.includes('statement.pdf'))).toBe(false);
    const theirs = await activity(teen);
    expect(theirs.some((l) => l.includes('Jane, accountant'))).toBe(false);
  });

  it('reject deletes the object', async () => {
    const { files } = await arrive(adult, { recipient_label: 'Jane, accountant' }, [
      { name: 'spam.pdf', bytes: PDF('spam') },
    ]);
    const file = files[0] as DropFile;
    await ready(file.id, 2);
    const before = await fileRow(file.id);
    const key = before?.storage_key as string;
    expect(await objectThere(key)).toBe(true);
    expect(await objectThere(`${key}.p2.enc`)).toBe(true);

    const res = await reject(adult, file.id);
    expect(res.statusCode, res.body).toBe(204);
    // Its bytes and its pages are gone; its row says it was refused, and by whom.
    expect(await objectThere(key)).toBe(false);
    expect(await objectThere(`${key}.p1.enc`)).toBe(false);
    expect(await objectThere(`${key}.p2.enc`)).toBe(false);
    const row = await fileRow(file.id);
    expect(row).toMatchObject({
      state: 'rejected',
      decided_by: await accountOf(adult),
      document_id: null,
      version_id: null,
    });
    expect(row?.object_removed_at).not.toBeNull();
    // And what the refuse dialog says stays is all that does (W523-08): no
    // name, no note from the sender, no fingerprint of what was in it; its
    // kind and size, and who refused it when.
    const [kept] = await admin<Record<string, unknown>>(
      `select original_name, sender_note, sha256, mime, byte_size::int as byte_size
         from incoming_file where id = $1`,
      [file.id],
    );
    expect(kept).toEqual({
      original_name: null,
      sender_note: null,
      sha256: null,
      mime: 'application/pdf',
      byte_size: PDF('spam').length,
    });
    expect((await inbox(adult)).some((f) => f.id === file.id)).toBe(false);
    // Decided is decided.
    for (const again of [await reject(adult, file.id), await accept(adult, file.id)]) {
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ error: { code: 'already_decided' } });
    }
    expect(await activity(adult)).toContain('Adult refused a file sent by Jane, accountant');
  });

  it('not in search, lists, reminders or counts', async () => {
    const counts = async () =>
      (await h.app.inject({ url: '/api/v1/documents/counts', headers: h.as(owner) })).json<{
        by_member: Array<{ count: number }>;
      }>();
    const total = async () => (await counts()).by_member.reduce((n, m) => n + m.count, 0);
    const listed = async () =>
      (await h.app.inject({ url: '/api/v1/documents?limit=200', headers: h.as(owner) })).json<{
        items: DocumentView[];
      }>().items.length;
    const found = async () =>
      (await h.app.inject({ url: '/api/v1/search?q=Zanzibar', headers: h.as(owner) })).json<{
        items: unknown[];
      }>().items.length;
    const reminders = async () =>
      (await h.app.inject({ url: '/api/v1/reminders', headers: h.as(owner) })).body;
    const was = { total: await total(), listed: await listed(), reminders: await reminders() };

    const { files } = await arrive(
      owner,
      { review_by: 'adults', title: 'Zanzibar papers', suggested_type_key: 'passport' },
      [{ name: 'Zanzibar passport.pdf', bytes: PDF('Zanzibar passport') }],
    );
    const file = files[0] as DropFile;
    await ready(file.id);
    // Waiting: no document, no hit, no reminder, no count.
    expect(await found()).toBe(0);
    expect(await listed()).toBe(was.listed);
    expect(await total()).toBe(was.total);
    expect(await reminders()).toBe(was.reminders);

    // Filed, it is a document like any other.
    const res = await accept(owner, file.id, { title: 'Zanzibar passport' });
    expect(res.statusCode, res.body).toBe(201);
    expect(await found()).toBe(1);
    expect(await listed()).toBe(was.listed + 1);
    expect(await total()).toBe(was.total + 1);
  });

  it('a teen gets 404 for the inbox', async () => {
    const { files } = await arrive(owner, { review_by: 'adults' }, [
      { name: 'family.pdf', bytes: PDF('family') },
    ]);
    const file = files[0] as DropFile;
    await ready(file.id);
    for (const t of [teen, viewer]) {
      const asked = [
        await h.app.inject({ url: '/api/v1/incoming', headers: h.as(t) }),
        await page(t, file.id),
        await content(t, file.id),
        await accept(t, file.id, { title: 'Mine now' }),
        await reject(t, file.id),
      ];
      for (const res of asked) {
        expect(res.statusCode, res.body).toBe(404);
        expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
      }
    }
    expect((await fileRow(file.id))?.state).toBe('received');
  });

  it('review by me: another adult gets 404', async () => {
    const { files } = await arrive(adult, { review_by: 'me' }, [
      { name: 'mine.pdf', bytes: PDF('mine') },
    ]);
    const file = files[0] as DropFile;
    await ready(file.id);
    // Not another adult, and not an owner either (A43).
    for (const t of [other, owner]) {
      expect((await inbox(t)).some((f) => f.id === file.id)).toBe(false);
      for (const res of [
        await page(t, file.id),
        await content(t, file.id),
        await accept(t, file.id, { title: 'Taken' }),
        await reject(t, file.id),
      ]) {
        expect(res.statusCode, res.body).toBe(404);
      }
    }
    expect((await fileRow(file.id))?.state).toBe('received');
    // Its requester has it.
    expect((await inbox(adult)).some((f) => f.id === file.id)).toBe(true);
    // And its lines in the activity log are theirs alone too.
    const { files: more } = await arrive(
      adult,
      { review_by: 'me', recipient_label: 'Mr Private' },
      [{ name: 'private.pdf', bytes: PDF('private') }],
    );
    const theirs = more[0] as DropFile;
    await ready(theirs.id);
    expect((await content(adult, theirs.id)).statusCode).toBe(200);
    const line = 'Adult saved a copy of a file sent by Mr Private, to look at it';
    expect(await activity(adult)).toContain(line);
    for (const t of [other, owner, teen]) {
      expect((await activity(t)).some((l) => l.includes('Mr Private'))).toBe(false);
    }
  });

  it('a copy is an attachment, never sniffed, named by its bytes, and says it was not scanned', async () => {
    const bytes = PDF('copy');
    const { files } = await arrive(adult, { recipient_label: 'Jane, accountant' }, [
      // Called a web page, and a PDF by its bytes.
      { name: 'invoice.html', bytes, type: 'text/html' },
    ]);
    const file = files[0] as DropFile;
    // Still being got ready: no copy, and it cannot be filed.
    for (const res of [await content(adult, file.id), await accept(adult, file.id)]) {
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: { code: 'incoming_not_ready', retriable: true } });
    }
    expect((await page(adult, file.id)).json()).toMatchObject({
      error: { code: 'preview_pending' },
    });
    await ready(file.id);
    const res = await content(adult, file.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.rawPayload.equals(bytes)).toBe(true);
    expect(res.headers).toMatchObject({
      'content-type': 'application/pdf',
      'content-disposition': "attachment; filename*=UTF-8''invoice.pdf",
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
      'x-fdv-scan': 'unscanned',
      warning: `199 - "${NOT_SCANNED}"`,
    });
    expect(String(res.headers['content-security-policy'])).toContain('sandbox');
    // Looking is in the activity log, for its reviewer.
    expect(await activity(adult)).toContain(
      'Adult saved a copy of a file sent by Jane, accountant, to look at it',
    );
  });

  it('a reviewer may only file or refuse a file, as themselves, once, and never remove it', async () => {
    const { files } = await arrive(adult, {}, [{ name: 'held.pdf', bytes: PDF('held') }]);
    const file = files[0] as DropFile;
    await ready(file.id);
    const me = {
      householdId: household,
      actor: {
        kind: 'account' as const,
        accountId: await accountOf(adult),
        memberId: adult.member_id,
        role: 'adult' as const,
      },
    };
    const refused = (change: Record<string, unknown>) =>
      withScope(h.db, me, (trx) =>
        trx.updateTable('incoming_file').set(change).where('id', '=', file.id).execute(),
      ).then(
        () => 'done',
        (err: unknown) => (err as { code?: string }).code,
      );
    // Not whose key, who reviews it, or where its bytes are; not as anybody
    // else; not filed with nothing to show for it.
    expect(await refused({ review_by: 'adults' })).toBe('42501');
    expect(await refused({ storage_key: 'elsewhere.enc' })).toBe('42501');
    expect(
      await refused({
        state: 'rejected',
        decided_by: await accountOf(other),
        decided_at: new Date(),
      }),
    ).toBe('42501');
    expect(
      await refused({ state: 'accepted', decided_by: me.actor.accountId, decided_at: new Date() }),
    ).toBe('42501');
    // Removing it is nobody's but the vault's: nothing goes.
    const removed = await withScope(h.db, me, (trx) =>
      trx.deleteFrom('incoming_file').where('id', '=', file.id).executeTakeFirst(),
    );
    expect(Number(removed.numDeletedRows)).toBe(0);
    expect((await fileRow(file.id))?.state).toBe('received');
  });

  it('where a filed file went is written once, at the decision, as what the decision made, and never changed (R523-1)', async () => {
    const { files } = await arrive(owner, { review_by: 'adults' }, [
      { name: 'filed.pdf', bytes: PDF('filed') },
      { name: 'waiting.pdf', bytes: PDF('waiting') },
    ]);
    const [filed, waiting] = files as [DropFile, DropFile];
    await ready(filed.id);
    await ready(waiting.id);
    expect((await accept(owner, filed.id, { title: 'Filed' })).statusCode).toBe(201);
    const was = (await fileRow(filed.id)) as NonNullable<Awaited<ReturnType<typeof fileRow>>>;
    const me = {
      householdId: household,
      actor: {
        kind: 'account' as const,
        accountId: await accountOf(owner),
        memberId: owner.member_id,
        role: 'owner' as const,
      },
    };
    const tried = (id: string, change: Record<string, unknown>) =>
      withScope(h.db, me, (trx) =>
        trx.updateTable('incoming_file').set(change).where('id', '=', id).executeTakeFirst(),
      ).then(
        (r) => `changed ${Number(r.numUpdatedRows)}`,
        (err: unknown) => (err as { code?: string }).code,
      );
    // Not let go of by hand: only a removal takes it, and the row with it.
    expect(await tried(filed.id, { document_id: null, version_id: null })).toBe('42501');
    // Another document's version, filed some other way.
    const [elsewhere] = await admin<{ id: string }>(
      "insert into document (household_id, title) values ($1, 'Elsewhere') returning id",
      [household],
    );
    const [another] = await admin<{ id: string; document_id: string }>(
      `insert into document_version
         (household_id, document_id, version_no, filename, mime, byte_size, sha256, cipher_bytes,
          cipher_sha256, storage_key, vault_id, file_key_wrapped, wrapped_by_scope)
       select v.household_id, $2, 1, 'a.pdf', 'application/pdf', 1, '\\x00', 1, '\\x00', $3,
              v.vault_id, '\\x00', v.wrapped_by_scope
         from document_version v where v.id = $1
       returning id, document_id`,
      [was.version_id, elsewhere?.id, `${household}/${elsewhere?.id}/1/elsewhere.enc`],
    );
    expect(another).toBeDefined();
    // Not pointed elsewhere afterwards.
    expect(
      await tried(filed.id, { document_id: another?.document_id, version_id: another?.id }),
    ).toBe('42501');
    // A file waiting is not filed as a version this decision did not make.
    expect(
      await tried(waiting.id, {
        state: 'accepted',
        decided_by: me.actor.accountId,
        decided_at: new Date(),
        document_id: another?.document_id,
        version_id: another?.id,
      }),
    ).toBe('42501');
    // A sender's session is let go of only as it ends, by the database.
    const [held] = await admin<{ session_id: string | null }>(
      'select session_id from incoming_file where id = $1',
      [waiting.id],
    );
    expect(held?.session_id).not.toBeNull();
    expect(await tried(waiting.id, { session_id: null })).toBe('42501');
    expect(await fileRow(filed.id)).toMatchObject({
      state: 'accepted',
      document_id: was.document_id,
      version_id: was.version_id,
    });
    expect((await fileRow(waiting.id))?.state).toBe('received');
  });

  it('a file sent but not finished is not waiting: not listed, and not there to anyone (W523-04)', async () => {
    const { files } = await arrive(
      adult,
      { review_by: 'adults' },
      [{ name: 'unfinished.pdf', bytes: PDF('unfinished') }],
      { finish: false },
    );
    const file = files[0] as DropFile;
    // Ready in every other way: only Finish is missing.
    await ready(file.id);
    expect((await fileRow(file.id))?.state).toBe('received');
    for (const t of [adult, owner, other]) {
      expect((await inbox(t)).some((f) => f.id === file.id)).toBe(false);
      for (const res of [
        await page(t, file.id),
        await content(t, file.id),
        await accept(t, file.id, { title: 'Too soon' }),
        await reject(t, file.id),
      ]) {
        expect(res.statusCode, res.body).toBe(404);
      }
    }
    expect((await fileRow(file.id))?.state).toBe('received');
  });

  it('a kind of document the household does not have is refused, and nothing is filed (W523-05)', async () => {
    const { files } = await arrive(owner, { review_by: 'adults' }, [
      { name: 'kind.pdf', bytes: PDF('kind') },
    ]);
    const file = files[0] as DropFile;
    await ready(file.id);
    const before = await admin<{ n: number }>(
      'select count(*)::int as n from document where household_id = $1',
      [household],
    );
    const res = await accept(owner, file.id, { title: 'Kindless', type_key: 'no_such_kind' });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json()).toMatchObject({
      error: { code: 'validation_failed', detail: 'type_key' },
    });
    const after = await admin<{ n: number }>(
      'select count(*)::int as n from document where household_id = $1',
      [household],
    );
    expect(after[0]?.n).toBe(before[0]?.n);
    expect((await fileRow(file.id))?.state).toBe('received');
    // A kind it has is filed as asked.
    const filed = await accept(owner, file.id, { title: 'Passport', type_key: 'passport' });
    expect(filed.statusCode, filed.body).toBe(201);
  });

  it('deciding a file whose pages were still being drawn removes every page of it (F523-3)', async () => {
    const { files } = await arrive(adult, { review_by: 'adults' }, [
      { name: 'drawn-a.pdf', bytes: PDF('drawn-a') },
      { name: 'drawn-b.pdf', bytes: PDF('drawn-b') },
    ]);
    const [refused, filed] = files as [DropFile, DropFile];
    for (const f of [refused, filed]) {
      await ready(f.id, 3);
      // The drawing stopped part-way (its worker gone): three pages stored,
      // and its row still saying they are being drawn, counting none.
      await admin(
        "update incoming_file set preview_state = 'drawing', preview_pages = null where id = $1",
        [f.id],
      );
    }
    expect((await reject(adult, refused.id)).statusCode).toBe(204);
    expect((await accept(adult, filed.id, { title: 'Drawn' })).statusCode).toBe(201);
    for (const f of [refused, filed]) {
      const key = (await fileRow(f.id))?.storage_key as string;
      for (const n of [1, 2, 3]) expect(await objectThere(`${key}.p${n}.enc`)).toBe(false);
      expect(await objectThere(key)).toBe(false);
    }
  });

  it("a decision removes a file's pages all at once; one that cannot be removed leaves the rest to the sweep (N523A-02)", async () => {
    const { files } = await arrive(adult, { review_by: 'adults' }, [
      { name: 'quick.pdf', bytes: PDF('quick') },
      { name: 'stuck.pdf', bytes: PDF('stuck') },
    ]);
    const [quick, stuck] = files as [DropFile, DropFile];
    await ready(quick.id, 2);
    await ready(stuck.id, 2);
    // Each delete takes a moment, as a bucket's round trip does; one page
    // of the second file cannot be deleted at all.
    const proto = LocalAdapter.prototype as unknown as { delete: (key: string) => Promise<void> };
    const real = proto.delete;
    const seen = { inFlight: 0, most: 0, after: [] as string[] };
    let refuse = '';
    proto.delete = async function (this: LocalAdapter, key: string) {
      seen.inFlight += 1;
      seen.most = Math.max(seen.most, seen.inFlight);
      try {
        await new Promise((r) => setTimeout(r, 15));
        if (key === refuse) throw new Error('the bucket is not answering');
        // What was deleted while no page delete was under way.
        if (seen.inFlight === 1) seen.after.push(key);
        return await real.call(this, key);
      } finally {
        seen.inFlight -= 1;
      }
    };
    try {
      expect((await reject(adult, quick.id)).statusCode).toBe(204);
      // The pages went together: many deletes under way at once.
      expect(seen.most).toBeGreaterThan(1);
      const quickKey = (await fileRow(quick.id))?.storage_key as string;
      // The object last, once every page had gone.
      expect(seen.after.at(-1)).toBe(quickKey);
      expect(await objectThere(quickKey)).toBe(false);
      expect((await fileRow(quick.id))?.object_removed_at).not.toBeNull();

      const stuckKey = (await fileRow(stuck.id))?.storage_key as string;
      refuse = `${stuckKey}.p2.enc`;
      expect((await reject(adult, stuck.id)).statusCode).toBe(204);
      // Refused all the same; but not said to be gone, so the sweep tries
      // again — its other page went, its object is still there.
      expect((await fileRow(stuck.id))?.object_removed_at).toBeNull();
      expect(await objectThere(`${stuckKey}.p1.enc`)).toBe(false);
      expect(await objectThere(`${stuckKey}.p2.enc`)).toBe(true);
      expect(await objectThere(stuckKey)).toBe(true);
    } finally {
      proto.delete = real;
    }
  });

  it('a filing whose answer is lost keeps the copy the version committed (F523-2)', async () => {
    const { files } = await arrive(owner, { review_by: 'adults' }, [
      { name: 'slow.pdf', bytes: PDF('slow') },
    ]);
    const file = files[0] as DropFile;
    await ready(file.id);
    // Its commit takes two seconds — and its answer never comes back: the
    // connection dies the moment COMMIT has gone out, so the reviewer is
    // told it failed while the database is still making it so.
    await admin(
      `create function test_slow_commit() returns trigger language plpgsql as $$
         begin perform pg_sleep(2); return null; end $$`,
    );
    await admin(
      `create constraint trigger test_slow_commit after update on incoming_file
         deferrable initially deferred for each row
         when (new.id = '${file.id}' and new.state = 'accepted')
         execute function test_slow_commit()`,
    );
    // The connections the vault's own pool makes: their query, patched.
    type Query = (this: object, ...args: unknown[]) => Promise<unknown>;
    const probe = createPool(h.adminUrl, 1);
    const one = await probe.connect();
    const proto = Object.getPrototypeOf(one) as { query: Query };
    one.release();
    await probe.end();
    const real = proto.query;
    const dead = new WeakSet<object>();
    let lose = false;
    proto.query = function (this: object, ...args: unknown[]) {
      if (dead.has(this)) return Promise.reject(new Error('Connection terminated unexpectedly'));
      const text = typeof args[0] === 'string' ? args[0] : '';
      if (lose && /^\s*commit\b/i.test(text)) {
        lose = false;
        const sent = real.apply(this, args);
        sent.catch(() => undefined);
        // Never answered, and never used again: the pool lets it go.
        dead.add(this);
        (this as unknown as { _queryable: boolean })._queryable = false;
        return Promise.reject(new Error('Connection terminated unexpectedly'));
      }
      return real.apply(this, args);
    };
    const res = await (async () => {
      try {
        hold = async (what, id) => {
          if (what === 'accept' && id === file.id) lose = true;
        };
        return await accept(owner, file.id, { title: 'Slow' });
      } finally {
        hold = null;
        proto.query = real;
        await admin('drop trigger test_slow_commit on incoming_file');
        await admin('drop function test_slow_commit()');
      }
    })();
    // Told it failed...
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    // ...and filed all the same: the version's bytes are where it says.
    const row = await fileRow(file.id);
    expect(row?.state).toBe('accepted');
    const [version] = await admin<{ storage_key: string }>(
      'select storage_key from document_version where id = $1',
      [row?.version_id],
    );
    expect(version).toBeDefined();
    expect(await objectThere(version?.storage_key as string)).toBe(true);
    // Its own copy stays for the sweep, which removes it only once the
    // version's is there (apps/worker/src/jobs/incoming.ts).
    expect(row?.object_removed_at).toBeNull();
  });

  it('a document removed for good takes the file it was filed from with it, and every byte of it (5.24)', async () => {
    const { files } = await arrive(owner, { review_by: 'adults', recipient_label: 'Jane' }, [
      { name: 'gone.pdf', bytes: PDF('gone') },
    ]);
    const file = files[0] as DropFile;
    await ready(file.id, 2);
    const filed = await accept(owner, file.id, { title: 'Gone soon' });
    expect(filed.statusCode, filed.body).toBe(201);
    const documentId = filed.json<{ document_id: string }>().document_id;
    const key = (await fileRow(file.id))?.storage_key as string;
    // Its own copy's removal after filing failed: its bytes and a page are
    // still there, for the sweep.
    const local = new LocalAdapter(h.vaultDir);
    for (const k of [key, `${key}.p1.enc`]) {
      await local.put(k, Readable.from([Buffer.from('left behind')]));
    }
    await admin('update incoming_file set object_removed_at = null where id = $1', [file.id]);

    const trashed = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/documents/${documentId}`,
      headers: h.as(owner),
    });
    expect(trashed.statusCode, trashed.body).toBe(204);
    await stepUp(owner);
    const removed = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/purge`,
      headers: h.as(owner),
    });
    expect(removed.statusCode, removed.body).toBe(204);
    // Nothing of it: not the row, with the sender's name for it and their
    // note; not its bytes or its pages; and nothing left to delete.
    expect(await fileRow(file.id)).toBeUndefined();
    expect(await objectThere(key)).toBe(false);
    expect(await objectThere(`${key}.p1.enc`)).toBe(false);
    const left = await admin<{ n: number }>(
      'select count(*)::int as n from purge_leftover where removed_document = $1',
      [documentId],
    );
    expect(left[0]?.n).toBe(0);
  });

  // ------------------------------------------------------------ races

  it('accept and reject at once: one decides, and the other is told it was decided', async () => {
    const { files } = await arrive(adult, {}, [
      { name: 'one.pdf', bytes: PDF('one') },
      { name: 'two.pdf', bytes: PDF('two') },
    ]);
    const [first, second] = files as [DropFile, DropFile];
    await ready(first.id);
    await ready(second.id);

    // Filing first, held before it commits: the refusal waits for it.
    let g = gate();
    hold = async (what) => {
      if (what === 'accept') await g.wait();
    };
    const filing = accept(adult, first.id, { title: 'One' });
    await g.arrived;
    const refusing = reject(adult, first.id);
    expect(await soon(refusing)).toBe('held');
    g.open();
    expect((await filing).statusCode).toBe(201);
    const late = await refusing;
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ error: { code: 'already_decided' } });
    expect((await fileRow(first.id))?.state).toBe('accepted');

    // Refusing first: the filing waits, then finds it refused, and files nothing.
    g = gate();
    hold = async (what) => {
      if (what === 'reject') await g.wait();
    };
    const docsBefore = await admin<{ n: number }>(
      'select count(*)::int as n from document where household_id = $1',
      [household],
    );
    const refusing2 = reject(adult, second.id);
    await g.arrived;
    const filing2 = accept(adult, second.id, { title: 'Two' });
    expect(await soon(filing2)).toBe('held');
    g.open();
    expect((await refusing2).statusCode).toBe(204);
    expect((await filing2).statusCode).toBe(409);
    hold = null;
    const docsAfter = await admin<{ n: number }>(
      'select count(*)::int as n from document where household_id = $1',
      [household],
    );
    expect(docsAfter[0]?.n).toBe(docsBefore[0]?.n);
    expect((await fileRow(second.id))?.state).toBe('rejected');
  });

  it('accept while the requester is demoted: whichever is first, the other waits for it', async () => {
    const person = async (name: string) =>
      h.join(owner, {
        name,
        email: `${name.toLowerCase()}-${randomUUID()}@example.test`,
        role: 'adult',
      });
    const demote = (t: Tokens) =>
      h.app.inject({
        method: 'POST',
        url: `/api/v1/members/${t.member_id}/role`,
        headers: h.as(owner),
        payload: { role: 'teen' },
      });

    // Filing first, held: the demotion waits for it, and the file is filed.
    const early = await person('Early');
    const { files: a } = await arrive(early, {}, [{ name: 'a.pdf', bytes: PDF('a') }]);
    const fa = a[0] as DropFile;
    await ready(fa.id);
    const g = gate();
    hold = async (what) => {
      if (what === 'accept') await g.wait();
    };
    const filing = accept(early, fa.id, { title: 'A' });
    await g.arrived;
    const demoting = demote(early);
    expect(await soon(demoting)).toBe('held');
    g.open();
    expect((await filing).statusCode).toBe(201);
    expect((await demoting).statusCode).toBe(200);
    hold = null;
    expect((await fileRow(fa.id))?.state).toBe('accepted');
    // The move to the owners is queued once the demotion has committed.
    expect(h.jobs.filter((j) => j.name === 'incoming.move').at(-1)?.data).toEqual({
      household_id: household,
    });

    // Demoted first, not yet committed (another connection): the filing
    // waits for it, then finds them no longer a reviewer, and files nothing.
    const late = await person('Late');
    const { files: b } = await arrive(late, {}, [{ name: 'b.pdf', bytes: PDF('b') }]);
    const fb = b[0] as DropFile;
    await ready(fb.id);
    const pool = createPool(h.adminUrl, 1);
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(
        "update account_household set role = 'teen' where member_id = $1 and household_id = $2",
        [late.member_id, household],
      );
      const filing2 = accept(late, fb.id, { title: 'B' });
      expect(await soon(filing2)).toBe('held');
      await client.query('commit');
      const answered = await filing2;
      expect(answered.statusCode, answered.body).toBe(404);
    } finally {
      client.release();
      await pool.end();
    }
    expect((await fileRow(fb.id))?.state).toBe('received');
  });

  it('accept while the requester is locked: the filing waits, then files nothing (5.28)', async () => {
    await stepUp(owner);
    const rana = await h.join(owner, {
      name: 'Rana',
      email: `rana-${randomUUID()}@example.test`,
      role: 'adult',
    });
    const { files } = await arrive(rana, {}, [{ name: 'r.pdf', bytes: PDF('r') }]);
    const f = files[0] as DropFile;
    await ready(f.id);
    // Locked, not yet committed (another connection, as an owner's lock
    // holds the membership first): the filing waits for it, then finds her
    // no longer able to review, and files nothing.
    const pool = createPool(h.adminUrl, 1);
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `update account_household set suspended_at = now(), suspend_reason = 'locked'
          where member_id = $1 and household_id = $2`,
        [rana.member_id, household],
      );
      const filing = accept(rana, f.id, { title: 'R' });
      expect(await soon(filing)).toBe('held');
      await client.query('commit');
      const answered = await filing;
      expect(answered.statusCode, answered.body).toBe(404);
    } finally {
      client.release();
      await pool.end();
    }
    expect((await fileRow(f.id))?.state).toBe('received');
    await admin(
      `update account_household set suspended_at = null, suspend_reason = null
        where member_id = $1 and household_id = $2`,
      [rana.member_id, household],
    );
  });

  it('accept while the requester is paused after a restore: a pause takes nothing away, and it is filed (the 5.28 review)', async () => {
    await stepUp(owner);
    const rhea = await h.join(owner, {
      name: 'Rhea',
      email: `rhea-${randomUUID()}@example.test`,
      role: 'adult',
    });
    const { files } = await arrive(rhea, {}, [{ name: 'p.pdf', bytes: PDF('p') }]);
    const f = files[0] as DropFile;
    await ready(f.id);
    const pool = createPool(h.adminUrl, 1);
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `update account_household set suspended_at = now(), suspend_reason = 'restored'
          where member_id = $1 and household_id = $2`,
        [rhea.member_id, household],
      );
      const filing = accept(rhea, f.id, { title: 'P' });
      expect(await soon(filing)).toBe('held');
      await client.query('commit');
      const answered = await filing;
      expect(answered.statusCode, answered.body).toBe(201);
    } finally {
      client.release();
      await pool.end();
    }
    expect((await fileRow(f.id))?.state).toBe('accepted');
    await admin(
      `update account_household set suspended_at = null, suspend_reason = null
        where member_id = $1 and household_id = $2`,
      [rhea.member_id, household],
    );
  });

  it('accept while its request is taken back: both are done', async () => {
    const { request, files } = await arrive(adult, {}, [{ name: 'c.pdf', bytes: PDF('c') }]);
    const file = files[0] as DropFile;
    await ready(file.id);
    const g = gate();
    hold = async (what) => {
      if (what === 'accept') await g.wait();
    };
    const filing = accept(adult, file.id, { title: 'C' });
    await g.arrived;
    const revoking = h.app.inject({
      method: 'DELETE',
      url: `/api/v1/upload-requests/${request.id}`,
      headers: h.as(adult),
    });
    // It writes its line in the activity log after the filing's.
    expect(await soon(revoking)).toBe('held');
    g.open();
    expect((await filing).statusCode).toBe(201);
    const revoked = await revoking;
    expect(revoked.statusCode, revoked.body).toBe(204);
    hold = null;
    expect((await fileRow(file.id))?.state).toBe('accepted');
    const [r] = await admin<{ revoked: boolean }>(
      'select revoked_at is not null as revoked from upload_request where id = $1',
      [request.id],
    );
    expect(r?.revoked).toBe(true);
  });

  it('nothing of a file sent in leaks into another household', async () => {
    // A stranger's household, asking for this one's file by id.
    const rows = await withScope(
      h.db,
      {
        householdId: randomUUID(),
        actor: {
          kind: 'account',
          accountId: randomUUID(),
          memberId: randomUUID(),
          role: 'owner',
        },
      },
      (trx) => sql<{ n: number }>`select count(*)::int as n from incoming_file`.execute(trx),
    );
    expect(rows.rows[0]?.n).toBe(0);
  });
});
