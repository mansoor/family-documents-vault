import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { deriveKey, openBytes } from '@fdv/crypto';
import { createPool, withPrincipal } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
const docx = (extra: Array<[string, string]> = [], main = WORD_MAIN) =>
  zip([
    ['[Content_Types].xml', contentTypes(main)],
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
    return {
      cookie: res.cookies.find((c) => c.name === 'fdv_drop')?.value as string,
      session: res.json<DropSession>(),
    };
  };

  const send = (
    cookie: string,
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
      cookies: { fdv_drop: cookie },
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
          cookies: { fdv_drop: cookie },
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
        cookies: { fdv_drop: b.cookie },
        remoteAddress: addr(),
      })
    ).json<DropSession>();
    expect(bSession.files).toEqual([]);
    const takeBack = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/drop/files/${sent.id}`,
      cookies: { fdv_drop: b.cookie },
      remoteAddress: addr(),
    });
    expect(takeBack.statusCode).toBe(404);
    // The first does, and nothing else of the vault's.
    const aSession = (
      await h.app.inject({
        url: '/api/v1/drop/session',
        cookies: { fdv_drop: a.cookie },
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
        cookies: { fdv_drop: a.cookie },
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
      cookies: { fdv_drop: cookie },
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
    // The stored code cannot be checked without the server's key.
    const [stored] = await admin<{ code_hash: Buffer }>(
      'select code_hash from upload_code where id = $1',
      [job.code_id],
    );
    expect(stored?.code_hash.toString('hex')).not.toContain(Buffer.from(code).toString('hex'));

    const wrong = await unlock(made.link_token, { password: 'not-the-password', code });
    expect(wrong.statusCode).toBe(401);
    const { cookie } = await opened(made.link_token, { password, code });
    const sent = await send(cookie, { name: 'W-2 very-private-name.pdf', bytes: PDF() });
    expect(sent.statusCode).toBe(201);
    await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/drop/files/${sent.json<DropFile>().id}`,
      cookies: { fdv_drop: cookie },
      remoteAddress: addr(),
    });
    await send(cookie, { name: 'W-2 very-private-name.pdf', bytes: PDF() });
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/drop/finish',
      cookies: { fdv_drop: cookie },
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
      cookie,
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
    const cookie = answers[1]?.cookies.find((c) => c.name === 'fdv_drop');
    expect(cookie).toMatchObject({
      path: '/api/v1/drop',
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
    });
  });

  it("the database's copy of who may ask is the matrix's", async () => {
    expect(rolesWith('upload_request.create')).toEqual(['owner', 'adult']);
    const [fn] = await admin<{ src: string }>(
      "select pg_get_functiondef('public.app_live_upload_request()'::regprocedure) as src",
    );
    expect(fn?.src).toContain("asker.role in ('owner', 'adult')");
  });
});
