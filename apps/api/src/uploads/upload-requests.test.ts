import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { crc32 } from 'node:zlib';
import { deriveKey, openBytes } from '@fdv/crypto';
import { createPool, withPrincipal } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import { LocalAdapter } from '@fdv/storage';
import {
  rolesWith,
  type ActivityLine,
  type CreatedUploadRequest,
  type DropFile,
  type DropSession,
  type Tokens,
  type UploadRequestInput,
  type UploadRequestView,
} from '@fdv/shared';
import FormData from 'form-data';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHarness, TEST_MASTER, type Harness } from '../test-harness.js';
import { EXCEL_MIME, WORD_MIME } from './office.js';

/**
 * Asking somebody outside the family to send documents (5.21): making a
 * request, and what whoever holds its link can and cannot do.
 */

const PDF = (size = 2048) =>
  Buffer.concat([
    Buffer.from('%PDF-1.4\n'),
    Buffer.alloc(Math.max(0, size - 16), 0x20),
    Buffer.from('\n%%EOF\n'),
  ]);

/** A zip whose parts are stored as they are: an Office file, as far as its structure goes. */
function zip(entries: Array<[string, string]>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.from(content);
    const file = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(file.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(file.length, 28);
    dir.writeUInt32LE(offset, 42);
    parts.push(local, file, data);
    central.push(dir, file);
    offset += 30 + file.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

const contentTypes = (main: string) =>
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  `<Override PartName="/word/document.xml" ContentType="${main}"/></Types>`;
const WORD_MAIN =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>';
const docx = (extra: Array<[string, string]> = [], main = WORD_MAIN, types?: string) =>
  zip([
    ['[Content_Types].xml', types ?? contentTypes(main)],
    ['_rels/.rels', ROOT_RELS],
    ['word/document.xml', '<w:document/>'],
    ...extra,
  ]);

describe.skipIf(!testAdminUrl())('asking somebody to send documents', () => {
  let h: Harness;
  const logged: string[] = [];
  let owner: Tokens;
  let adult: Tokens;
  let other: Tokens;
  let teen: Tokens;
  let household: string;
  let ip = 0;
  /** Each sender's call from an address of its own: the drop routes are 20 a minute each. */
  const addr = () => `10.77.${(++ip >> 8) & 0xff}.${ip & 0xff}`;

  beforeAll(async () => {
    h = await createHarness({
      logger: { level: 'trace', stream: { write: (s: string) => void logged.push(s) } },
    });
    owner = await h.setup();
    household = owner.household_id;
    adult = await h.join(owner, { name: 'Adult', email: 'adult@example.test', role: 'adult' });
    other = await h.join(owner, { name: 'Other', email: 'other@example.test', role: 'adult' });
    teen = await h.join(owner, { name: 'Teen', email: 'teen@example.test', role: 'teen' });
  }, 90_000);
  afterAll(() => h.close());

  const inAWeek = () => new Date(Date.now() + 7 * 864e5).toISOString();

  const make = async (as: Tokens, body: Partial<UploadRequestInput> = {}) => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/upload-requests',
      headers: h.as(as),
      payload: { title: 'Your tax papers', expires_at: inAWeek(), ...body },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<CreatedUploadRequest>();
  };

  const preview = (token: string) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/drop/preview',
      payload: { token },
      remoteAddress: addr(),
    });

  const unlock = (token: string, extra: Record<string, string> = {}) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/drop/unlock',
      payload: { token, ...extra },
      remoteAddress: addr(),
    });

  const opened = async (token: string, extra: Record<string, string> = {}) => {
    const res = await unlock(token, extra);
    expect(res.statusCode, res.body).toBe(200);
    const set = res.cookies.find((c) => c.name.startsWith('fdv_drop_s_'));
    // The session cookie, named for its request, as a browser would send it.
    return {
      cookie: { [set?.name as string]: set?.value as string } as Record<string, string>,
      session: res.json<DropSession>(),
    };
  };

  const send = (
    cookie: Record<string, string>,
    file: { name: string; bytes: Buffer; type?: string; itemId?: string },
  ) => {
    const form = new FormData();
    if (file.itemId) form.append('item_id', file.itemId);
    form.append('file', file.bytes, {
      filename: file.name,
      contentType: file.type ?? 'application/pdf',
    });
    return h.app.inject({
      method: 'POST',
      url: '/api/v1/drop/files',
      headers: form.getHeaders(),
      cookies: cookie,
      payload: form.getBuffer(),
      remoteAddress: addr(),
    });
  };

  const admin = async <T extends object>(text: string, params: unknown[] = []): Promise<T[]> => {
    const pool = createPool(h.adminUrl, 1);
    try {
      return (await pool.query<T>(text, params)).rows;
    } finally {
      await pool.end();
    }
  };

  /** What of a request's is in the vault's storage. */
  const stored = async (requestId: string) =>
    (
      await readdir(path.join(h.vaultDir, household, 'incoming', requestId)).catch(
        () => [] as string[],
      )
    ).length;

  const accountOf = async (t: Tokens) =>
    (await h.app.inject({ url: '/api/v1/me', headers: h.as(t) })).json<{ account_id: string }>()
      .account_id;

  it("before unlocking, only the household name and the requester's name are shown", async () => {
    const made = await make(adult, {
      title: 'W-2 2025 for the tax return',
      message: 'Please send your W-2 and the 1099 from the bank.',
      items: ['W-2', '1099-INT'],
      recipient_label: 'Jane, accountant',
      recipient_email: 'jane@example.test',
      with_password: true,
    });
    expect(made.password).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    const res = await preview(made.link_token);
    expect(res.statusCode).toBe(200);
    const shown = res.json<Record<string, unknown>>();
    expect(Object.keys(shown).sort()).toEqual([
      'expires_at',
      'household_name',
      'protection',
      'requested_by',
    ]);
    expect(shown).toMatchObject({
      household_name: 'The Test family',
      requested_by: 'Adult',
      protection: ['password'],
    });
    for (const secret of ['W-2', 'tax return', '1099', 'Jane', 'accountant', 'jane@']) {
      expect(res.body, secret).not.toContain(secret);
    }
    // And looking counts nothing and writes nothing down.
    const [row] = await admin<{ visits_used: number; attempts: number }>(
      'select visits_used, attempts from upload_request where id = $1',
      [made.request.id],
    );
    expect(row).toEqual({ visits_used: 0, attempts: 0 });
    // Open, with the password, gives what was asked for.
    const { session } = await opened(made.link_token, { password: made.password as string });
    expect(session.title).toBe('W-2 2025 for the tax return');
    expect(session.items.map((i) => i.label)).toEqual(['W-2', '1099-INT']);
  });

  it('the sender never sees the suggested person or type', async () => {
    const made = await make(adult, {
      suggested_member_id: teen.member_id,
      suggested_type_key: 'utility_bill',
      review_by: 'adults',
    });
    expect(made.request.suggested_member_id).toBe(teen.member_id);
    const answers = [(await preview(made.link_token)).body];
    const { cookie } = await opened(made.link_token);
    answers.push((await unlock(made.link_token)).body);
    answers.push(
      (
        await h.app.inject({
          url: '/api/v1/drop/session',
          cookies: cookie,
          remoteAddress: addr(),
        })
      ).body,
    );
    answers.push((await send(cookie, { name: 'bill.pdf', bytes: PDF() })).body);
    for (const body of answers) {
      expect(body).not.toContain(teen.member_id);
      expect(body).not.toContain('utility_bill');
      expect(body).not.toContain('suggested');
      expect(body).not.toContain('review_by');
    }
  });

  it('the file that passes 200 MB is refused and nothing of it is kept', async () => {
    const made = await make(adult);
    expect(made.request.max_total_bytes).toBe(200 * 1024 * 1024);
    const { cookie } = await opened(made.link_token);
    // 199.99 MB in already: the next file of 5 KB takes it past 200 MB.
    const nearly = 200 * 1024 * 1024 - 1000;
    await admin('update upload_request set bytes_used = $2 where id = $1', [
      made.request.id,
      nearly,
    ]);
    const refused = await send(cookie, { name: 'big.pdf', bytes: PDF(5000) });
    expect(refused.statusCode, refused.body).toBe(413);
    const error = refused.json<{ error: { code: string; message: string } }>().error;
    expect(error.code).toBe('too_large');
    expect(error.message).toMatch(/200 MB/);
    const [after] = await admin<{ files_used: number; bytes_used: string; files: number }>(
      `select files_used, bytes_used,
              (select count(*)::int from incoming_file where request_id = $1) as files
         from upload_request where id = $1`,
      [made.request.id],
    );
    expect(after).toEqual({ files_used: 0, bytes_used: String(nearly), files: 0 });
    expect(await stored(made.request.id)).toBe(0);
    // One that fits is taken.
    const fits = await send(cookie, { name: 'small.pdf', bytes: PDF(900) });
    expect(fits.statusCode, fits.body).toBe(201);
    expect(await stored(made.request.id)).toBe(1);
  });

  it('a macro-enabled Word file is refused', async () => {
    const made = await make(adult, { accept_types: 'office' });
    const { cookie } = await opened(made.link_token);
    const docType = WORD_MIME;
    const macroBin = await send(cookie, {
      name: 'letter.docx',
      type: docType,
      bytes: docx([['word/vbaProject.bin', 'macros']]),
    });
    expect(macroBin.statusCode, macroBin.body).toBe(415);
    expect(macroBin.json<{ error: { code: string } }>().error.code).toBe('macros_refused');
    // A .docm by its content types, whatever it is called.
    const docm = await send(cookie, {
      name: 'letter.docx',
      type: docType,
      bytes: docx([], 'application/vnd.ms-word.document.macroEnabled.main+xml'),
    });
    expect(docm.statusCode).toBe(415);
    expect(docm.json<{ error: { code: string } }>().error.code).toBe('macros_refused');
    // A zip with no content types is no Office file.
    const bare = await send(cookie, {
      name: 'report.docx',
      type: docType,
      bytes: zip([['word/document.xml', '<w:document/>']]),
    });
    expect(bare.statusCode).toBe(415);
    expect(bare.json<{ error: { code: string } }>().error.code).toBe('unsupported_type');
    expect(await stored(made.request.id)).toBe(0);

    // An ordinary one is taken, as what its parts say it is.
    const plain = await send(cookie, { name: 'letter.docx', type: 'text/plain', bytes: docx() });
    expect(plain.statusCode, plain.body).toBe(201);
    expect(plain.json<DropFile>().content_type).toBe(WORD_MIME);
    expect(EXCEL_MIME).toContain('spreadsheetml');

    // And a request for PDFs and photos takes no Word file at all.
    const standard = await make(adult);
    const s = await opened(standard.link_token);
    const refused = await send(s.cookie, { name: 'letter.docx', type: docType, bytes: docx() });
    expect(refused.statusCode).toBe(415);
  });

  it("a file that claims to be a PDF but isn't is refused", async () => {
    const made = await make(adult);
    const { cookie } = await opened(made.link_token);
    for (const bytes of [
      Buffer.from('just some words, typed into a file and named like a PDF'),
      Buffer.from('<html><script>alert(1)</script></html>'),
      Buffer.from('MZ\x90\x00 an executable'),
    ]) {
      const res = await send(cookie, { name: 'invoice.pdf', type: 'application/pdf', bytes });
      expect(res.statusCode, res.body).toBe(415);
      expect(res.json<{ error: { code: string; detail?: string } }>().error).toMatchObject({
        code: 'unsupported_type',
      });
      // The refusal never repeats the file's name.
      expect(res.body).not.toContain('invoice');
    }
    const [count] = await admin<{ n: number }>(
      'select count(*)::int as n from incoming_file where request_id = $1',
      [made.request.id],
    );
    expect(count?.n).toBe(0);
    expect(await stored(made.request.id)).toBe(0);
  });

  it("the sender never sees vault content or another session's files", async () => {
    // A document with a file, in the family's vault.
    const doc = (
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/documents',
        headers: h.as(owner),
        payload: { title: 'Family passport', type_key: 'utility_bill' },
      })
    ).json<{ id: string }>().id;
    const form = new FormData();
    form.append('file', PDF(), { filename: 'passport.pdf', contentType: 'application/pdf' });
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${doc}/versions`,
      headers: { ...h.as(owner), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });

    const made = await make(adult);
    const a = await opened(made.link_token);
    const b = await opened(made.link_token);
    const sent = (await send(a.cookie, { name: 'mine.pdf', bytes: PDF() })).json<DropFile>();

    // The second browser sees nothing of the first's.
    const bSession = (
      await h.app.inject({
        url: '/api/v1/drop/session',
        cookies: b.cookie,
        remoteAddress: addr(),
      })
    ).json<DropSession>();
    expect(bSession.files).toEqual([]);
    const takeBack = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/drop/files/${sent.id}`,
      cookies: b.cookie,
      remoteAddress: addr(),
    });
    expect(takeBack.statusCode).toBe(404);
    // The first does, and nothing else of the vault's.
    const aSession = (
      await h.app.inject({
        url: '/api/v1/drop/session',
        cookies: a.cookie,
        remoteAddress: addr(),
      })
    ).json<DropSession>();
    expect(aSession.files.map((f) => f.id)).toEqual([sent.id]);
    expect(JSON.stringify(aSession)).not.toContain('Family passport');
    // No route of a sender's gives a file back, its own included.
    for (const url of [
      `/api/v1/drop/files/${sent.id}`,
      `/api/v1/drop/files/${sent.id}/content`,
      `/api/v1/versions/${doc}/content`,
    ]) {
      const res = await h.app.inject({
        url,
        cookies: a.cookie,
        remoteAddress: addr(),
      });
      expect(res.statusCode, url).toBeGreaterThanOrEqual(401);
      expect(res.body).not.toContain('%PDF');
    }

    // And the database gives each session's link only its own files, and no document.
    const sessions = await admin<{ id: string }>(
      'select id from upload_session where request_id = $1 order by created_at',
      [made.request.id],
    );
    const asUpload = async (sessionId: string) => {
      const pool = createPool(h.appUrl, 1);
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', 'upload', true),
                  set_config('app.upload_request_id', $2, true),
                  set_config('app.upload_session_id', $3, true)`,
          [household, made.request.id, sessionId],
        );
        const { rows } = await c.query<Record<string, number>>(
          `select (select count(*)::int from incoming_file) as files,
                  (select count(*)::int from document) as documents,
                  (select count(*)::int from document_version) as versions,
                  (select count(*)::int from upload_request) as requests`,
        );
        await c.query('commit');
        return rows[0];
      } finally {
        c.release();
        await pool.end();
      }
    };
    expect(await asUpload(sessions[0]?.id as string)).toEqual({
      files: 1,
      documents: 0,
      versions: 0,
      requests: 1,
    });
    expect(await asUpload(sessions[1]?.id as string)).toEqual({
      files: 0,
      documents: 0,
      versions: 0,
      requests: 1,
    });
  });

  it('the third unlock of a two-visit request is refused, also in parallel', async () => {
    const one = await make(adult, { max_visits: 2 });
    await opened(one.link_token);
    await opened(one.link_token);
    const third = await unlock(one.link_token);
    expect(third.statusCode).toBe(410);
    expect(third.json<{ error: { code: string } }>().error.code).toBe('request_used_up');
    // And the preview says so, rather than offering Open.
    expect((await preview(one.link_token)).statusCode).toBe(410);

    const two = await make(adult, { max_visits: 2 });
    const all = await Promise.all([1, 2, 3, 4, 5].map(() => unlock(two.link_token)));
    expect(all.map((r) => r.statusCode).sort()).toEqual([200, 200, 410, 410, 410]);
    const [row] = await admin<{ visits_used: number }>(
      'select visits_used from upload_request where id = $1',
      [two.request.id],
    );
    expect(row?.visits_used).toBe(2);
  });

  it('a request cannot last longer than 90 days', async () => {
    const tooLong = await h.app.inject({
      method: 'POST',
      url: '/api/v1/upload-requests',
      headers: h.as(adult),
      payload: {
        title: 'For ever',
        expires_at: new Date(Date.now() + 91 * 864e5).toISOString(),
      },
    });
    expect(tooLong.statusCode).toBe(422);
    expect(tooLong.json<{ error: { code: string; message: string } }>().error).toMatchObject({
      code: 'expiry_out_of_range',
      message: 'A request can last 90 days at most.',
    });
    // No end is not an end either.
    const none = await h.app.inject({
      method: 'POST',
      url: '/api/v1/upload-requests',
      headers: h.as(adult),
      payload: { title: 'For ever' },
    });
    expect(none.statusCode).toBe(422);
    const ninety = await make(adult, {
      expires_at: new Date(Date.now() + 90 * 864e5 - 60_000).toISOString(),
    });
    expect(ninety.request.state).toBe('active');
    // And the database holds it too, whatever writes it.
    await expect(
      admin(
        `insert into upload_request (household_id, created_by, requester_member_id, title, token_hash, expires_at)
         select household_id, created_by, requester_member_id, 'x', $2, now() + interval '100 days'
           from upload_request where id = $1`,
        [ninety.request.id, Buffer.from(randomUUID())],
      ),
    ).rejects.toThrow(/upload_request_at_most_90_days/);
  });

  it('demoting the requester to teen closes the request', async () => {
    const spare = await h.join(owner, {
      name: 'Spare',
      email: `spare-${randomUUID()}@example.test`,
      role: 'adult',
    });
    const made = await make(spare, { recipient_email: 'jane@example.test' });
    const { cookie } = await opened(made.link_token);
    const demoted = await h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${spare.member_id}/role`,
      headers: h.as(owner),
      payload: { role: 'teen' },
    });
    expect(demoted.statusCode, demoted.body).toBe(200);
    const [row] = await admin<{
      closed_reason: string | null;
      recipient_email: string | null;
      sessions: number;
    }>(
      `select closed_reason, recipient_email,
              (select count(*)::int from upload_session where request_id = $1) as sessions
         from upload_request where id = $1`,
      [made.request.id],
    );
    expect(row).toEqual({
      closed_reason: 'requester_lost_right',
      recipient_email: null,
      sessions: 0,
    });
    // The link answers as one that does not exist, everywhere.
    expect((await preview(made.link_token)).statusCode).toBe(404);
    expect((await unlock(made.link_token)).statusCode).toBe(404);
    expect((await send(cookie, { name: 'late.pdf', bytes: PDF() })).statusCode).toBe(401);
    // Promoted back, it stays closed: a request is asked for once.
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${spare.member_id}/role`,
      headers: h.as(owner),
      payload: { role: 'adult' },
    });
    expect((await preview(made.link_token)).statusCode).toBe(404);

    // A requester no longer an adult, however that came about, asks for nothing:
    // the database's own rule, and the API's, both ask.
    const another = await h.join(owner, {
      name: 'Another',
      email: `another-${randomUUID()}@example.test`,
      role: 'adult',
    });
    const quiet = await make(another);
    await admin("update account_household set role = 'viewer' where member_id = $1", [
      another.member_id,
    ]);
    expect((await preview(quiet.link_token)).statusCode).toBe(404);
  });

  it('another adult cannot read a review-by-me file, even with a query that forgets the WHERE', async () => {
    const mine = await make(adult, { review_by: 'me' });
    const theirs = await make(adult, { review_by: 'adults' });
    for (const r of [mine, theirs]) {
      const { cookie } = await opened(r.link_token);
      expect((await send(cookie, { name: 'w2.pdf', bytes: PDF() })).statusCode).toBe(201);
    }
    const principalOf = async (t: Tokens) => ({
      householdId: household,
      accountId: await accountOf(t),
      memberId: t.member_id,
      role: t.role,
    });
    const everything = (t: Awaited<ReturnType<typeof principalOf>>) =>
      withPrincipal(h.db, t, async (trx) => {
        const files = await sql<{ request_id: string }>`select * from incoming_file`.execute(trx);
        const requests = await sql<{ id: string }>`select * from upload_request`.execute(trx);
        return {
          files: files.rows.map((f) => f.request_id),
          requests: requests.rows.map((r) => r.id),
        };
      });
    for (const who of [other, owner]) {
      const seen = await everything(await principalOf(who));
      expect(seen.files, who.role).not.toContain(mine.request.id);
      expect(seen.requests, who.role).not.toContain(mine.request.id);
      expect(seen.files, who.role).toContain(theirs.request.id);
      const listed = (
        await h.app.inject({ url: '/api/v1/upload-requests', headers: h.as(who) })
      ).json<{ items: UploadRequestView[] }>();
      expect(listed.items.map((r) => r.id)).not.toContain(mine.request.id);
      // Nor can they take it back: it is not there for them.
      const revoke = await h.app.inject({
        method: 'DELETE',
        url: `/api/v1/upload-requests/${mine.request.id}`,
        headers: h.as(who),
      });
      expect(revoke.statusCode).toBe(404);
    }
    const asker = await everything(await principalOf(adult));
    expect(asker.files).toContain(mine.request.id);
    // A teen is given none of it.
    const young = await everything(await principalOf(teen));
    expect(young).toEqual({ files: [], requests: [] });
    // Encrypted under the asker's own key, and the adults' for the other.
    const keys = await admin<{ request_id: string; kind: string; member_id: string | null }>(
      `select f.request_id, k.kind::text as kind, k.member_id from incoming_file f
         join scope_key k on k.id = f.wrapped_by_scope where f.request_id = any($1::uuid[])`,
      [[mine.request.id, theirs.request.id]],
    );
    expect(keys.find((k) => k.request_id === mine.request.id)).toMatchObject({
      kind: 'member',
      member_id: adult.member_id,
    });
    expect(keys.find((k) => k.request_id === theirs.request.id)?.kind).toBe('adults');
  });

  it('a teen and another adult see no activity line about a request', async () => {
    const made = await make(adult, { recipient_label: 'Jane, accountant' });
    const { cookie } = await opened(made.link_token);
    await send(cookie, { name: 'W-2 secret.pdf', bytes: PDF() });
    const done = await h.app.inject({
      method: 'POST',
      url: '/api/v1/drop/finish',
      cookies: cookie,
      payload: { note: 'Here it is' },
      remoteAddress: addr(),
    });
    expect(done.json()).toEqual({ files: 1, closed: false });
    const lines = async (t: Tokens) =>
      (await h.app.inject({ url: '/api/v1/audit?limit=100', headers: h.as(t) }))
        .json<{ items: ActivityLine[] }>()
        .items.map((l) => l.text);
    const asker = await lines(adult);
    expect(asker).toContain('Adult asked Jane, accountant to send documents');
    expect(asker).toContain('Upload link (Jane, accountant) opened a request to send documents');
    expect(asker).toContain('Upload link (Jane, accountant) sent a file');
    // A teen, no line about any request at all; another adult and an owner,
    // none about this one (a request for any adult's review is theirs).
    const young = (await lines(teen)).join('\n');
    expect(young).not.toMatch(/send documents|Jane|Upload link|W-2|sent a file/);
    for (const who of [other, owner]) {
      const theirs = (await lines(who)).join('\n');
      expect(theirs, who.role).toMatch(/Adult asked somebody outside the family to send documents/);
      expect(theirs, who.role).not.toMatch(/Jane|W-2/);
    }
    // Nowhere in the permanent log: the title, or a file's name.
    const written = await admin<{ detail: unknown }>(
      "select detail from audit_event where action like 'upload_request.%'",
    );
    const all = JSON.stringify(written);
    expect(all).not.toContain('Your tax papers');
    expect(all).not.toContain('W-2 secret');
  });

  it('no secret appears in the log', async () => {
    logged.length = 0;
    const made = await make(adult, {
      recipient_label: 'Jane, accountant',
      recipient_email: 'jane.secret@example.test',
      with_password: true,
      email_code: true,
    });
    const password = made.password as string;
    await preview(made.link_token);
    const coded = await h.app.inject({
      method: 'POST',
      url: '/api/v1/drop/code',
      payload: { token: made.link_token },
      remoteAddress: addr(),
    });
    expect(coded.statusCode, coded.body).toBe(200);
    expect(coded.json<{ sent_to: string }>().sent_to).toBe('j•••@e•••.test');
    // The code, as the worker is handed it: sealed, and bound to its row.
    const job = h.jobs.filter((j) => j.name === 'upload.code').at(-1)?.data as {
      code_id: string;
      sealed: string;
    };
    expect(JSON.stringify(job)).not.toContain('jane.secret');
    const code = openBytes(
      deriveKey(TEST_MASTER, 'upload-code-job'),
      Buffer.from(job.sealed, 'base64'),
      `upload-code:${job.code_id}`,
    ).toString('utf8');
    expect(code).toMatch(/^\d{6}$/);
    // The stored code cannot be checked without the server's key: it is its
    // HMAC under that key, not a hash anybody with a dump could try codes
    // against, nor one under another key.
    const [stored] = await admin<{ code_hash: Buffer }>(
      'select code_hash from upload_code where id = $1',
      [job.code_id],
    );
    const text = `${made.request.id}:${code}`;
    const under = (key: Buffer) => createHmac('sha256', key).update(text).digest();
    expect(stored?.code_hash.equals(under(deriveKey(TEST_MASTER, 'upload-code-hmac')))).toBe(true);
    expect(stored?.code_hash.equals(createHash('sha256').update(text).digest())).toBe(false);
    expect(stored?.code_hash.equals(createHash('sha256').update(code).digest())).toBe(false);
    expect(
      stored?.code_hash.equals(
        under(deriveKey('another-master-key-that-is-long-enough-9876', 'upload-code-hmac')),
      ),
    ).toBe(false);

    const wrong = await unlock(made.link_token, { password: 'not-the-password', code });
    expect(wrong.statusCode).toBe(401);
    const { cookie } = await opened(made.link_token, { password, code });
    const sent = await send(cookie, { name: 'W-2 very-private-name.pdf', bytes: PDF() });
    expect(sent.statusCode).toBe(201);
    await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/drop/files/${sent.json<DropFile>().id}`,
      cookies: cookie,
      remoteAddress: addr(),
    });
    await send(cookie, { name: 'W-2 very-private-name.pdf', bytes: PDF() });
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/drop/finish',
      cookies: cookie,
      payload: { note: 'my private note' },
      remoteAddress: addr(),
    });
    // A token pasted into a path by mistake, too.
    await h.app.inject({ url: `/api/v1/drop/${made.link_token}`, remoteAddress: addr() });
    await h.app.inject({ url: `/drop/${made.link_token}`, remoteAddress: addr() });

    const log = logged.join('\n');
    // The log was listening.
    expect(log).toContain('/api/v1/drop/unlock');
    expect(log).toContain('/api/v1/drop/files');
    for (const secret of [
      made.link_token,
      password,
      code,
      ...Object.values(cookie),
      'very-private-name',
      'jane.secret',
      'my private note',
    ]) {
      expect(log, secret).not.toContain(secret);
    }
  });

  it('wrong passwords and codes share one counter of ten, also in parallel', async () => {
    const made = await make(adult, { with_password: true });
    const tries = await Promise.all(
      Array.from({ length: 14 }, () => unlock(made.link_token, { password: 'wrong-wrong' })),
    );
    const codes = tries.map((r) => r.statusCode).sort();
    // Ten tries are made, however many arrive at once; the rest find no link.
    expect(codes.filter((c) => c === 401)).toHaveLength(10);
    expect(codes.filter((c) => c === 404)).toHaveLength(4);
    const [row] = await admin<{ attempts: number }>(
      'select attempts from upload_request where id = $1',
      [made.request.id],
    );
    expect(row?.attempts).toBe(10);
    // Locked: the right password opens nothing, and the asker is told, once.
    expect((await unlock(made.link_token, { password: made.password as string })).statusCode).toBe(
      404,
    );
    const alerts = h.jobs.filter(
      (j) => j.name === 'alert.send' && j.data.subject === 'A request you sent has stopped working',
    );
    expect(alerts).toHaveLength(1);
  });

  it('a teen gets 404 for everything about requests', async () => {
    const made = await make(adult);
    const calls: Array<['GET' | 'POST' | 'DELETE', string, Record<string, unknown> | undefined]> = [
      ['POST', '/api/v1/upload-requests', { title: 'Mine', expires_at: inAWeek() }],
      ['GET', '/api/v1/upload-requests', undefined],
      ['DELETE', `/api/v1/upload-requests/${made.request.id}`, undefined],
      ['POST', `/api/v1/upload-requests/${made.request.id}/resume`, undefined],
    ];
    for (const [method, url, payload] of calls) {
      const res = await h.app.inject({
        method,
        url,
        headers: h.as(teen),
        ...(payload ? { payload } : {}),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.body).not.toContain('Your tax papers');
    }
    const after = (await h.app.inject({ url: '/api/v1/after-restore', headers: h.as(teen) })).json<{
      upload_requests: unknown[];
    }>();
    expect(after.upload_requests).toEqual([]);
    // Still there, untouched, for the one who asked.
    const listed = (
      await h.app.inject({ url: '/api/v1/upload-requests', headers: h.as(adult) })
    ).json<{ items: UploadRequestView[] }>();
    expect(listed.items.find((r) => r.id === made.request.id)?.state).toBe('active');
  });

  it('an owner turns a paused request back on; nobody else can', async () => {
    const made = await make(adult, { review_by: 'adults' });
    await admin(
      "update upload_request set paused_at = now(), paused_reason = 'restored' where id = $1",
      [made.request.id],
    );
    expect((await preview(made.link_token)).statusCode).toBe(404);
    const asAdult = await h.app.inject({
      method: 'POST',
      url: `/api/v1/upload-requests/${made.request.id}/resume`,
      headers: h.as(adult),
    });
    expect(asAdult.statusCode).toBe(403);
    const paused = (
      await h.app.inject({ url: '/api/v1/after-restore', headers: h.as(owner) })
    ).json<{ upload_requests: UploadRequestView[] }>();
    expect(paused.upload_requests.map((r) => r.id)).toContain(made.request.id);
    const resumed = await h.app.inject({
      method: 'POST',
      url: `/api/v1/upload-requests/${made.request.id}/resume`,
      headers: h.as(owner),
    });
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect((await preview(made.link_token)).statusCode).toBe(200);
  });

  it('every answer under /api/v1/drop carries the public headers, a refusal too', async () => {
    const made = await make(adult);
    const answers = [
      await preview(made.link_token),
      await unlock(made.link_token),
      await h.app.inject({ url: '/api/v1/drop/session', remoteAddress: addr() }),
      await preview('a'.repeat(43)),
    ];
    expect(answers.map((a) => a.statusCode)).toEqual([200, 200, 401, 404]);
    for (const a of answers) {
      expect(a.headers['referrer-policy']).toBe('no-referrer');
      expect(a.headers['x-content-type-options']).toBe('nosniff');
      expect(a.headers['x-robots-tag']).toBe('noindex, nofollow');
      expect(String(a.headers['content-security-policy'])).toMatch(
        /default-src 'none'; frame-ancestors 'none'; sandbox/,
      );
    }
    // The session cookie is for the sender's routes alone, and no script's.
    const cookie = answers[1]?.cookies.find((c) => c.name.startsWith('fdv_drop_s_'));
    expect(cookie).toMatchObject({
      path: '/api/v1/drop',
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
    });
  });

  // ------------------------------------------------ from the 5.21 review

  it('the tenth wrong try, the last visit, taking back and closing each clear the address at once', async () => {
    const addressOf = async (id: string) =>
      (
        await admin<{ recipient_email: string | null }>(
          'select recipient_email from upload_request where id = $1',
          [id],
        )
      )[0]?.recipient_email;
    const email = { recipient_email: 'jane@example.test' };

    // Locked by the tenth wrong try (R521-2).
    const locked = await make(adult, { ...email, with_password: true });
    for (let i = 0; i < 10; i++) await unlock(locked.link_token, { password: 'wrong-wrong' });
    expect(
      (
        await admin<{ attempts: number }>('select attempts from upload_request where id = $1', [
          locked.request.id,
        ])
      )[0]?.attempts,
    ).toBe(10);
    expect(await addressOf(locked.request.id)).toBeNull();

    // Used up by its last visit (D521-8).
    const once = await make(adult, { ...email, max_visits: 1 });
    expect(await addressOf(once.request.id)).toBe('jane@example.test');
    await opened(once.link_token);
    expect(await addressOf(once.request.id)).toBeNull();
    const listed = (
      await h.app.inject({ url: '/api/v1/upload-requests', headers: h.as(adult) })
    ).json<{ items: UploadRequestView[] }>();
    expect(listed.items.find((r) => r.id === once.request.id)).toMatchObject({
      state: 'used_up',
      recipient_email: null,
    });

    // Taken back.
    const back = await make(adult, email);
    await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/upload-requests/${back.request.id}`,
      headers: h.as(adult),
    });
    expect(await addressOf(back.request.id)).toBeNull();

    // Closed by the first sending, with close_after_submit: its link opens
    // nothing more, and its sessions go.
    const closing = await make(adult, { ...email, close_after_submit: true });
    const { cookie } = await opened(closing.link_token);
    await send(cookie, { name: 'w2.pdf', bytes: PDF() });
    const done = await h.app.inject({
      method: 'POST',
      url: '/api/v1/drop/finish',
      cookies: cookie,
      payload: {},
      remoteAddress: addr(),
    });
    expect(done.json()).toEqual({ files: 1, closed: true });
    expect(await addressOf(closing.request.id)).toBeNull();
    const [row] = await admin<{ closed_reason: string | null; sessions: number }>(
      `select closed_reason,
              (select count(*)::int from upload_session where request_id = $1) as sessions
         from upload_request where id = $1`,
      [closing.request.id],
    );
    expect(row).toEqual({ closed_reason: 'submitted', sessions: 0 });
    expect((await preview(closing.link_token)).statusCode).toBe(404);
  });

  it('a Word file of many small parts is read with bounded work, and one of more parts than any document has is refused', async () => {
    const made = await make(adult, { accept_types: 'office' });
    const { cookie } = await opened(made.link_token);
    const many = (n: number) =>
      docx(Array.from({ length: n }, (_, i): [string, string] => [`word/media/p${i}.xml`, '']));
    const reads = vi.spyOn(LocalAdapter.prototype, 'get');
    try {
      const fine = await send(cookie, { name: 'long.docx', type: WORD_MIME, bytes: many(400) });
      expect(fine.statusCode, fine.body).toBe(201);
      // One chunk, decrypted once, however many small reads the zip needs:
      // its header and its bytes.
      expect(reads.mock.calls.length).toBeLessThanOrEqual(4);
    } finally {
      reads.mockRestore();
    }
    const tooMany = await send(cookie, { name: 'long.docx', type: WORD_MIME, bytes: many(600) });
    expect(tooMany.statusCode).toBe(415);
  });

  it('a Word file that hides its macros from a text search is refused, and one that is Excel is taken', async () => {
    const made = await make(adult, { accept_types: 'office' });
    const { cookie } = await opened(made.link_token);
    const types = (body: string) =>
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      body +
      '</Types>';
    const refused = async (bytes: Buffer, code: string) => {
      const res = await send(cookie, { name: 'report.docx', type: WORD_MIME, bytes });
      expect(res.statusCode, res.body).toBe(415);
      expect(res.json<{ error: { code: string } }>().error.code).toBe(code);
    };
    // Character references, the Word type in a comment, and the VBA project
    // renamed: an XML parser reads it as macro-enabled, with a VBA project.
    await refused(
      docx(
        [['word/macros.dat', 'Attribute VB_Name']],
        WORD_MAIN,
        types(
          `<!-- ${WORD_MAIN} -->` +
            '<Default Extension="xml" ContentType="application/xml"/>' +
            '<Default Extension="dat" ContentType="application/vnd.ms-office.vba&#80;roject"/>' +
            '<Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.document.macro&#69;nabled.main+xml"/>',
        ),
      ),
      'macros_refused',
    );
    // The Word type only in a comment, and no part that is Word: a zip, not a document.
    await refused(
      docx(
        [],
        WORD_MAIN,
        types(`<!-- ${WORD_MAIN} --><Default Extension="xml" ContentType="application/xml"/>`),
      ),
      'unsupported_type',
    );
    // A VBA project by its relationship, whatever its part is called and declared as.
    await refused(
      docx([
        [
          'word/_rels/document.xml.rels',
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            '<Relationship Id="rId9" Type="http://schemas.microsoft.com/office/2006/relationships/vba&#80;roject" Target="macros.dat"/>' +
            '</Relationships>',
        ],
        ['word/macros.dat', 'Attribute VB_Name'],
      ]),
      'macros_refused',
    );
    // A template, with its macros, fetched from elsewhere when it opens.
    await refused(
      docx([
        [
          'word/_rels/settings.xml.rels',
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="https://evil.example/t.dotm" TargetMode="External"/>' +
            '</Relationships>',
        ],
      ]),
      'macros_refused',
    );
    // A VBA project by its name alone.
    await refused(docx([['word/vbaProject.bin', 'x']]), 'macros_refused');
    // A document type of its own, which could define anything.
    await refused(
      docx(
        [],
        WORD_MAIN,
        `<!DOCTYPE Types [<!ENTITY m "macroEnabled">]>${contentTypes(WORD_MAIN)}`,
      ),
      'unsupported_type',
    );
    expect(await stored(made.request.id)).toBe(0);

    // An ordinary workbook is taken, as Excel.
    const xlsx = zip([
      [
        '[Content_Types].xml',
        types(
          '<Default Extension="xml" ContentType="application/xml"/>' +
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
        ),
      ],
      [
        '_rels/.rels',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          '</Relationships>',
      ],
      ['xl/workbook.xml', '<workbook/>'],
      ['xl/printerSettings/printerSettings1.bin', 'printer'],
    ]);
    const taken = await send(cookie, { name: 'accounts.xlsx', type: EXCEL_MIME, bytes: xlsx });
    expect(taken.statusCode, taken.body).toBe(201);
    expect(taken.json<DropFile>().content_type).toBe(EXCEL_MIME);
  });

  it("uploads at once can't together pass the caps: each holds its room from its start", async () => {
    const made = await make(adult, { max_total_bytes: 3_000_000 });
    const { cookie } = await opened(made.link_token);
    const file = PDF(2_500_000);
    /** An upload whose body stops after its first 64 KB, until let go. */
    const held = () => {
      const form = new FormData();
      form.append('file', file, { filename: 'big.pdf', contentType: 'application/pdf' });
      const body = form.getBuffer();
      const stream = new PassThrough();
      stream.write(body.subarray(0, 64 * 1024));
      const reply = h.app.inject({
        method: 'POST',
        url: '/api/v1/drop/files',
        headers: { ...form.getHeaders(), 'content-length': String(body.length) },
        cookies: cookie,
        payload: stream,
        remoteAddress: addr(),
      });
      return { reply, release: () => stream.end(body.subarray(64 * 1024)) };
    };
    const arriving = async () =>
      (
        await admin<{ n: number; reserved: string }>(
          `select count(*)::int as n, coalesce(sum(reserved_bytes), 0)::text as reserved
             from incoming_file where request_id = $1 and state = 'uploading'`,
          [made.request.id],
        )
      )[0];
    const first = held();
    for (let i = 0; i < 100 && (await arriving())?.n !== 1; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const second = held();
    for (let i = 0; i < 100 && (await arriving())?.n !== 2; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const third = held();
    const fourth = held();
    // No room is left for these two: refused at once, before their bodies end.
    const soon = <T>(p: Promise<T>) =>
      Promise.race([p, new Promise<'held'>((r) => setTimeout(() => r('held'), 5000))]);
    const [a, b] = await Promise.all([soon(third.reply), soon(fourth.reply)]);
    expect(a === 'held' ? 'held' : a.statusCode).toBe(413);
    expect(b === 'held' ? 'held' : b.statusCode).toBe(413);
    // And what the two arriving hold is within the request's cap.
    const now = await arriving();
    expect(now?.n).toBe(2);
    expect(Number(now?.reserved)).toBeLessThanOrEqual(3_000_000);
    third.release();
    fourth.release();
    first.release();
    second.release();
    expect((await first.reply).statusCode).toBe(201);
    // The second said 2.5 MB and was given what was left: cut off there.
    expect((await second.reply).statusCode).toBe(413);
    const [after] = await admin<{ files_used: number; bytes_used: string }>(
      'select files_used, bytes_used::text from upload_request where id = $1',
      [made.request.id],
    );
    expect(after).toEqual({ files_used: 1, bytes_used: String(file.length) });
    expect(await stored(made.request.id)).toBe(1);
  });

  it('a file past what is left is cut off as it arrives, not stored whole first', async () => {
    const made = await make(adult, { max_total_bytes: 1000 });
    const { cookie } = await opened(made.link_token);
    let written = 0;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with its own this below
    const original = LocalAdapter.prototype.put;
    const puts = vi.spyOn(LocalAdapter.prototype, 'put').mockImplementation(function (
      this: LocalAdapter,
      key,
      body,
      meta,
    ) {
      body.on('data', (c: Buffer) => (written += c.length));
      return original.call(this, key, body, meta);
    });
    try {
      const res = await send(cookie, { name: 'big.pdf', bytes: PDF(200_000) });
      expect(res.statusCode).toBe(413);
    } finally {
      puts.mockRestore();
    }
    // At most the room, sealed: nothing like the 200 KB sent.
    expect(written).toBeLessThanOrEqual(1000 + 64);
    expect(await stored(made.request.id)).toBe(0);
  });

  it('this device only: of Opens at once, one binds and works, and every other is refused', async () => {
    const made = await make(adult, { this_device_only: true });
    const all = await Promise.all([1, 2, 3, 4, 5].map(() => unlock(made.link_token)));
    expect(all.map((r) => r.statusCode).sort()).toEqual([200, 403, 403, 403, 403]);
    const [row] = await admin<{ sessions: number; visits_used: number }>(
      `select visits_used,
              (select count(*)::int from upload_session where request_id = $1) as sessions
         from upload_request where id = $1`,
      [made.request.id],
    );
    expect(row).toEqual({ sessions: 1, visits_used: 1 });
    // The browser that bound it opens it again; another browser is refused.
    const device = all
      .find((r) => r.statusCode === 200)
      ?.cookies.find((c) => c.name === 'fdv_drop_device')?.value as string;
    const again = await h.app.inject({
      method: 'POST',
      url: '/api/v1/drop/unlock',
      payload: { token: made.link_token },
      cookies: { fdv_drop_device: device },
      remoteAddress: addr(),
    });
    expect(again.statusCode).toBe(200);
    const elsewhere = await unlock(made.link_token);
    expect(elsewhere.statusCode).toBe(403);
    expect(elsewhere.json<{ error: { code: string } }>().error.code).toBe('other_device');
  });

  it('Opens at once with the one right code: one opens, the rest are told it was used, and no try is counted', async () => {
    const made = await make(adult, { recipient_email: 'jane@example.test', email_code: true });
    const sent = await h.app.inject({
      method: 'POST',
      url: '/api/v1/drop/code',
      payload: { token: made.link_token },
      remoteAddress: addr(),
    });
    expect(sent.statusCode).toBe(200);
    const job = h.jobs.filter((j) => j.name === 'upload.code').at(-1)?.data as {
      code_id: string;
      sealed: string;
    };
    const code = openBytes(
      deriveKey(TEST_MASTER, 'upload-code-job'),
      Buffer.from(job.sealed, 'base64'),
      `upload-code:${job.code_id}`,
    ).toString('utf8');
    const all = await Promise.all([1, 2, 3, 4].map(() => unlock(made.link_token, { code })));
    expect(all.map((r) => r.statusCode).sort()).toEqual([200, 409, 409, 409]);
    for (const r of all.filter((x) => x.statusCode === 409)) {
      expect(r.json<{ error: { code: string } }>().error.code).toBe('code_used');
    }
    // Pressed again later: still used, still not a wrong guess.
    expect((await unlock(made.link_token, { code })).statusCode).toBe(409);
    const [row] = await admin<{ attempts: number }>(
      'select attempts from upload_request where id = $1',
      [made.request.id],
    );
    expect(row?.attempts).toBe(0);
  });

  it('the fourth code in a quarter of an hour is refused', async () => {
    const made = await make(adult, { recipient_email: 'jane@example.test', email_code: true });
    const ask = () =>
      h.app.inject({
        method: 'POST',
        url: '/api/v1/drop/code',
        payload: { token: made.link_token },
        remoteAddress: addr(),
      });
    for (let i = 0; i < 3; i++) expect((await ask()).statusCode).toBe(200);
    const fourth = await ask();
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json<{ error: { code: string } }>().error.code).toBe('too_many_codes');
  });

  it('a browser keeps two requests open: neither unbinds nor replaces the other', async () => {
    const first = await make(adult, { this_device_only: true, title: 'First papers' });
    const second = await make(adult, { this_device_only: true, title: 'Second papers' });
    /** One browser's cookies, as it keeps them. */
    const jar: Record<string, string> = {};
    const open = async (token: string) => {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/drop/unlock',
        payload: { token },
        cookies: jar,
        remoteAddress: addr(),
      });
      for (const c of res.cookies) jar[c.name] = c.value;
      return res;
    };
    expect((await open(first.link_token)).statusCode).toBe(200);
    const device = jar.fdv_drop_device;
    const b = await open(second.link_token);
    expect(b.statusCode).toBe(200);
    // One device cookie for the browser, made once.
    expect(b.cookies.find((c) => c.name === 'fdv_drop_device')).toBeUndefined();
    expect(jar.fdv_drop_device).toBe(device);
    // The first opens again in it.
    expect((await open(first.link_token)).statusCode).toBe(200);
    // And each session is its own request's, asked for by its id.
    const titleOf = async (requestId: string) =>
      (
        await h.app.inject({
          url: '/api/v1/drop/session',
          cookies: jar,
          headers: { 'x-fdv-drop-request': requestId },
          remoteAddress: addr(),
        })
      ).json<DropSession>().title;
    expect(await titleOf(first.request.id)).toBe('First papers');
    expect(await titleOf(second.request.id)).toBe('Second papers');
    // With two open, a call that does not say which is not guessed at.
    const unsaid = await h.app.inject({
      url: '/api/v1/drop/session',
      cookies: jar,
      remoteAddress: addr(),
    });
    expect(unsaid.statusCode).toBe(401);
  });

  it("stepping down to teen, or losing one's sign-in, closes one's requests; an owner made an adult keeps them", async () => {
    const person = async (name: string, role: 'owner' | 'adult') => {
      const t = await h.join(owner, {
        name,
        email: `${name.toLowerCase()}-${randomUUID()}@example.test`,
        role: 'adult',
      });
      if (role === 'owner') {
        const made = await h.app.inject({
          method: 'POST',
          url: `/api/v1/members/${t.member_id}/role`,
          headers: h.as(owner),
          payload: { role: 'owner' },
        });
        expect(made.statusCode, made.body).toBe(200);
      }
      return t;
    };
    const closed = async (id: string) =>
      (
        await admin<{
          closed_reason: string | null;
          recipient_email: string | null;
          sessions: number;
        }>(
          `select closed_reason, recipient_email,
                  (select count(*)::int from upload_session where request_id = $1) as sessions
             from upload_request where id = $1`,
          [id],
        )
      )[0];
    const lost = { closed_reason: 'requester_lost_right', recipient_email: null, sessions: 0 };

    // An owner who steps down to teen.
    const stepping = await person('Stepping', 'owner');
    const theirs = await make(stepping, { recipient_email: 'jane@example.test' });
    await opened(theirs.link_token);
    const down = await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/step-down',
      headers: h.as(stepping),
      payload: { role: 'teen' },
    });
    expect(down.statusCode, down.body).toBe(200);
    expect(await closed(theirs.request.id)).toEqual(lost);

    // An adult whose sign-in is taken away.
    const leaving = await person('Leaving', 'adult');
    const hers = await make(leaving, { recipient_email: 'jane@example.test' });
    await opened(hers.link_token);
    const removed = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/members/${leaving.member_id}/sign-in`,
      headers: h.as(owner),
    });
    expect(removed.statusCode, removed.body).toBe(204);
    expect(await closed(hers.request.id)).toEqual(lost);

    // An owner made an adult, after the seven days, may still ask.
    const staying = await person('Staying', 'owner');
    const kept = await make(staying);
    const asked = await h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${staying.member_id}/role`,
      headers: h.as(owner),
      payload: { role: 'adult' },
    });
    const change = asked.json<{ request: { id: string } }>().request.id;
    await admin(
      'update owner_change_request set opens_at = now() - interval $$1 second$$ where id = $1',
      [change],
    );
    const done = await h.app.inject({
      method: 'POST',
      url: `/api/v1/owner-changes/${change}/complete`,
      headers: h.as(owner),
    });
    expect(done.statusCode, done.body).toBe(200);
    expect((await closed(kept.request.id))?.closed_reason).toBeNull();
    expect((await preview(kept.link_token)).statusCode).toBe(200);
  });

  it("after a restore, an adult is shown their own paused requests, and nobody else's", async () => {
    const mine = await make(adult, { review_by: 'adults' });
    const theirs = await make(other, { review_by: 'adults' });
    await admin(
      "update upload_request set paused_at = now(), paused_reason = 'restored' where id = any($1::uuid[])",
      [[mine.request.id, theirs.request.id]],
    );
    const paused = async (t: Tokens) =>
      (await h.app.inject({ url: '/api/v1/after-restore', headers: h.as(t) }))
        .json<{ upload_requests: UploadRequestView[] }>()
        .upload_requests.map((r) => r.id);
    const adults = await paused(adult);
    expect(adults).toContain(mine.request.id);
    expect(adults).not.toContain(theirs.request.id);
    expect(await paused(owner)).toEqual(
      expect.arrayContaining([mine.request.id, theirs.request.id]),
    );
  });

  it("the database's copy of who may ask is the matrix's", async () => {
    expect(rolesWith('upload_request.create')).toEqual(['owner', 'adult']);
    const [fn] = await admin<{ src: string }>(
      "select pg_get_functiondef('public.app_live_upload_request()'::regprocedure) as src",
    );
    expect(fn?.src).toContain("asker.role in ('owner', 'adult')");
  });
});

/**
 * The caps and the choices that depend on the vault's own settings: the
 * household's room for files waiting, and operator mail (5.21 review).
 */
describe.skipIf(!testAdminUrl())('a vault with little room and no operator mail', () => {
  let h: Harness;
  let owner: Tokens;
  let ip = 0;
  const addr = () => `10.78.${(++ip >> 8) & 0xff}.${ip & 0xff}`;

  beforeAll(async () => {
    h = await createHarness({ operatorMail: false, incomingMaxBytes: 5000 });
    owner = await h.setup();
  }, 90_000);
  afterAll(() => h.close());

  const make = async (body: Partial<UploadRequestInput> = {}) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/upload-requests',
      headers: h.as(owner),
      payload: {
        title: 'Tax papers',
        expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
        ...body,
      },
    });

  const sendTo = async (token: string, bytes: Buffer) => {
    const opened = await h.app.inject({
      method: 'POST',
      url: '/api/v1/drop/unlock',
      payload: { token },
      remoteAddress: addr(),
    });
    const set = opened.cookies.find((c) => c.name.startsWith('fdv_drop_s_'));
    const form = new FormData();
    form.append('file', bytes, { filename: 'w2.pdf', contentType: 'application/pdf' });
    return h.app.inject({
      method: 'POST',
      url: '/api/v1/drop/files',
      headers: form.getHeaders(),
      cookies: { [set?.name as string]: set?.value as string },
      payload: form.getBuffer(),
      remoteAddress: addr(),
    });
  };

  it("the household's room for files waiting is shared by every request", async () => {
    const one = (await make()).json<CreatedUploadRequest>();
    const two = (await make()).json<CreatedUploadRequest>();
    expect((await sendTo(one.link_token, PDF(3000))).statusCode).toBe(201);
    const refused = await sendTo(two.link_token, PDF(3000));
    expect(refused.statusCode).toBe(413);
    expect(refused.json<{ error: { message: string } }>().error.message).toMatch(
      /cannot take any more files/,
    );
  });

  it('without operator mail, an emailed code is refused, and said to be unavailable', async () => {
    const res = await make({ recipient_email: 'jane@example.test', email_code: true });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('email_code_unavailable');
    const listed = (
      await h.app.inject({ url: '/api/v1/upload-requests', headers: h.as(owner) })
    ).json<{ email_code_available: boolean }>();
    expect(listed.email_code_available).toBe(false);
  });
});
