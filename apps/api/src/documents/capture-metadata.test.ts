import { createPool } from '@fdv/db';
import type { DocumentView, Tokens } from '@fdv/shared';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * Iteration 4.3b: the confirm card's details travel with the capture, as a
 * `metadata` field sent before the file. The document is made complete —
 * type, person, Only me, Essential — and its file is wrapped for the right
 * people from the first byte. Details that break a rule are refused before
 * anything is stored, and details sent after the file are refused outright.
 */

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
const BOUNDARY = 'fdv-capture-metadata-boundary';

const field = (name: string, value: string) =>
  Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  );
const fileHead = () =>
  Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="scan.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
  );
const end = Buffer.from(`--${BOUNDARY}--\r\n`);

describe('a capture that knows what it is', () => {
  let h: Harness;
  let owner: Tokens;
  let adult: Tokens;
  let teen: Tokens;
  let admin: ReturnType<typeof createPool>;

  const json = <T>(r: { json: () => unknown }) => r.json() as T;

  /** A capture, with its details first (or, if asked, after the file). */
  const capture = (
    who: Tokens,
    metadata?: unknown,
    opts: { key?: string; after?: boolean } = {},
  ) => {
    const meta = metadata === undefined ? [] : [field('metadata', JSON.stringify(metadata))];
    const file = [fileHead(), PDF, Buffer.from('\r\n')];
    const body = Buffer.concat(opts.after ? [...file, ...meta, end] : [...meta, ...file, end]);
    return h.app.inject({
      method: 'POST',
      url: '/api/v1/capture',
      headers: {
        ...h.as(who),
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
        'idempotency-key': opts.key ?? randomUUID(),
      },
      payload: body,
    });
  };

  /** A capture whose file arrives only when the test says so. */
  const heldCapture = (who: Tokens, metadata: unknown, key: string) => {
    const body = new PassThrough();
    body.write(field('metadata', JSON.stringify(metadata)));
    body.write(fileHead());
    body.write(PDF.subarray(0, 10));
    const response = h.app.inject({
      method: 'POST',
      url: '/api/v1/capture',
      headers: {
        ...h.as(who),
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
        'idempotency-key': key,
      },
      payload: body,
    });
    return {
      response,
      finish: () => {
        body.write(PDF.subarray(10));
        body.write('\r\n');
        body.end(end);
      },
    };
  };

  const doc = async (who: Tokens, id: string) =>
    h.app.inject({ method: 'GET', url: `/api/v1/documents/${id}`, headers: h.as(who) });
  const listed = async (who: Tokens) =>
    json<{ items: DocumentView[] }>(
      await h.app.inject({ method: 'GET', url: '/api/v1/documents?limit=200', headers: h.as(who) }),
    ).items.map((d) => d.id);
  const documentCount = async () =>
    Number(
      (
        await admin.query<{ n: string }>(
          'select count(*) as n from document where household_id = $1',
          [owner.household_id],
        )
      ).rows[0]?.n,
    );
  const incoming = async (): Promise<string[]> => {
    const found: string[] = [];
    const walk = async (dir: string) => {
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (full.split(path.sep).includes('incoming')) found.push(full);
      }
    };
    await walk(h.vaultDir);
    return found;
  };

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();
    adult = await h.join(owner, {
      name: 'Alex',
      email: `alex-${randomUUID()}@example.test`,
      role: 'adult',
    });
    teen = await h.join(owner, {
      name: 'Sam',
      email: `sam-${randomUUID()}@example.test`,
      role: 'teen',
    });
    admin = createPool(h.adminUrl, 2);
  }, 120_000);
  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  it('metadata sets type, owner, visibility and Essential at creation', async () => {
    const res = await capture(owner, {
      type_key: 'passport',
      title: "Alex's passport",
      owner_member_id: adult.member_id,
      visibility: 'adults',
      issued: { date: '2021-03-14', precision: 'day' },
      expires: { date: '2031-03-31', precision: 'month' },
      identifier: '563914782',
      physical_location: 'Bedroom safe',
      is_essential: true,
      tags: ['Travel'],
      notes: 'Renew early',
    });
    expect(res.statusCode).toBe(201);
    const d = json<DocumentView>(await doc(owner, json<{ document_id: string }>(res).document_id));
    expect(d).toMatchObject({
      type_key: 'passport',
      title: "Alex's passport",
      owner_member_id: adult.member_id,
      visibility: 'adults',
      category: 'identity',
      issued: { date: '2021-03-14', precision: 'day' },
      expires: { date: '2031-03-31', precision: 'month' },
      identifier: '563914782',
      physical_location: 'Bedroom safe',
      is_essential: true,
      tags: ['travel'],
      notes: 'Renew early',
    });
    expect(d.status.value).not.toBe('needs_info');
  });

  it('with no details it is Needs info, as before', async () => {
    const res = await capture(owner);
    expect(res.statusCode).toBe(201);
    const d = json<DocumentView>(await doc(owner, json<{ document_id: string }>(res).document_id));
    expect(d).toMatchObject({ title: null, type_key: null, visibility: 'household' });
  });

  it('an Only me capture is wrapped under the member key from the first byte', async () => {
    const res = await capture(owner, {
      type_key: 'passport',
      owner_member_id: owner.member_id,
      visibility: 'private',
    });
    expect(res.statusCode).toBe(201);
    const { version_id } = json<{ version_id: string }>(res);
    const row = (
      await admin.query<{ kind: string; member_id: string | null }>(
        `select s.kind, s.member_id from document_version v join scope_key s on s.id = v.wrapped_by_scope
          where v.id = $1`,
        [version_id],
      )
    ).rows[0];
    expect(row).toEqual({ kind: 'member', member_id: owner.member_id });
  });

  it('the second adult never sees an Only me capture, even while its upload is still streaming', async () => {
    const key = randomUUID();
    const before = await listed(adult);
    const slow = heldCapture(
      owner,
      { type_key: 'medical_record', owner_member_id: owner.member_id, visibility: 'private' },
      key,
    );
    // Watching the list throughout: while it is claimed, and after.
    for (let i = 0; i < 100; i += 1) {
      const s = await h.app.inject({
        method: 'GET',
        url: `/api/v1/uploads/${key}`,
        headers: h.as(owner),
      });
      expect(await listed(adult)).toEqual(before);
      if (s.statusCode === 200) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(await listed(adult)).toEqual(before);
    slow.finish();
    const res = await slow.response;
    expect(res.statusCode).toBe(201);
    const id = json<{ document_id: string }>(res).document_id;
    expect(await listed(adult)).toEqual(before);
    expect((await doc(adult, id)).statusCode).toBe(404);
    expect(await listed(owner)).toContain(id);
  });

  it('a field after the file is refused and nothing is stored', async () => {
    const before = await documentCount();
    const key = randomUUID();
    const res = await capture(owner, { type_key: 'passport' }, { key, after: true });
    expect(res.statusCode).toBe(422);
    expect(json<{ error: { message: string } }>(res).error.message).toBe(
      'Send the details before the file.',
    );
    expect(await documentCount()).toBe(before);
    expect(await incoming()).toEqual([]);
    const status = await h.app.inject({
      method: 'GET',
      url: `/api/v1/uploads/${key}`,
      headers: h.as(owner),
    });
    expect(status.statusCode).toBe(404);
  });

  it('invalid metadata is refused before any byte is stored, and the same key then works', async () => {
    const before = await documentCount();
    const key = randomUUID();
    for (const bad of [
      // A birth certificate does not expire.
      { type_key: 'birth_certificate', expires: { date: '2031-03-31', precision: 'month' } },
      // Only me, for somebody else's document.
      { owner_member_id: adult.member_id, visibility: 'private' },
      // A month is stored as its last day.
      { type_key: 'passport', expires: { date: '2031-03-01', precision: 'month' } },
      // Not a field the card has.
      { status: 'valid' },
      { category: 'identity' },
    ]) {
      const res = await capture(owner, bad, { key });
      expect(res.statusCode).toBe(422);
    }
    const notJson = await h.app.inject({
      method: 'POST',
      url: '/api/v1/capture',
      headers: {
        ...h.as(owner),
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
        'idempotency-key': key,
      },
      payload: Buffer.concat([
        field('metadata', '{not json'),
        fileHead(),
        PDF,
        Buffer.from('\r\n'),
        end,
      ]),
    });
    expect(notJson.statusCode).toBe(422);
    expect(await documentCount()).toBe(before);
    expect(await incoming()).toEqual([]);

    const good = await capture(owner, { type_key: 'birth_certificate' }, { key });
    expect(good.statusCode).toBe(201);
    expect(good.headers['idempotent-replayed']).toBeUndefined();
    expect(await documentCount()).toBe(before + 1);
  });

  it('a teen cannot capture a document for someone else, and files their own as theirs', async () => {
    const theirs = await capture(teen, { type_key: 'passport', owner_member_id: owner.member_id });
    expect(theirs.statusCode).toBe(403);
    const mine = await capture(teen, { type_key: 'passport', visibility: 'private' });
    expect(mine.statusCode).toBe(201);
    const d = json<DocumentView>(await doc(teen, json<{ document_id: string }>(mine).document_id));
    expect(d).toMatchObject({ owner_member_id: teen.member_id, visibility: 'private' });
  });

  it('a replay with different metadata returns the original, unchanged', async () => {
    const key = randomUUID();
    const first = await capture(owner, { type_key: 'passport', title: 'First' }, { key });
    expect(first.statusCode).toBe(201);
    const again = await capture(owner, { type_key: 'utility_bill', title: 'Second' }, { key });
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    const id = json<{ document_id: string }>(first).document_id;
    expect(json<{ document_id: string }>(again).document_id).toBe(id);
    expect(json<DocumentView>(await doc(owner, id))).toMatchObject({
      type_key: 'passport',
      title: 'First',
    });
  });

  it('one metadata field, then the file: anything else is refused', async () => {
    const twice = await h.app.inject({
      method: 'POST',
      url: '/api/v1/capture',
      headers: {
        ...h.as(owner),
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
        'idempotency-key': randomUUID(),
      },
      payload: Buffer.concat([
        field('metadata', '{}'),
        field('metadata', '{}'),
        fileHead(),
        PDF,
        Buffer.from('\r\n'),
        end,
      ]),
    });
    expect(twice.statusCode).toBe(422);
    const other = await h.app.inject({
      method: 'POST',
      url: '/api/v1/capture',
      headers: {
        ...h.as(owner),
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
        'idempotency-key': randomUUID(),
      },
      payload: Buffer.concat([field('title', 'x'), fileHead(), PDF, Buffer.from('\r\n'), end]),
    });
    expect(other.statusCode).toBe(422);
  });

  /** A raw multipart capture, parts as given. */
  const raw = (who: Tokens, parts: Buffer[], key = randomUUID()) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/capture',
      headers: {
        ...h.as(who),
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
        'idempotency-key': key,
      },
      payload: Buffer.concat([...parts, end]),
    });
  const filePart = (name = 'file', body: Buffer = PDF) =>
    Buffer.concat([
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"; filename="${name}.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
      ),
      body,
      Buffer.from('\r\n'),
    ]);

  it('a teen never files a document as Adults only, which they could not then see', async () => {
    // Medical records are Adults only by default: a teen's is theirs, for everyone.
    const res = await capture(teen, { type_key: 'medical_record' });
    expect(res.statusCode).toBe(201);
    const id = json<{ document_id: string }>(res).document_id;
    const d = await doc(teen, id);
    expect(d.statusCode).toBe(200);
    expect(json<DocumentView>(d)).toMatchObject({
      visibility: 'household',
      owner_member_id: teen.member_id,
    });

    // Asking for it is refused, and nothing is claimed.
    const key = randomUUID();
    const asked = await capture(teen, { visibility: 'adults' }, { key });
    expect(asked.statusCode).toBe(403);
    expect((await capture(teen, {}, { key })).statusCode).toBe(201);

    // The same for a document made without a file.
    const made = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(teen),
      payload: { title: 'Allergy letter', type_key: 'medical_record' },
    });
    expect(made.statusCode).toBe(201);
    expect(json<DocumentView>(made).visibility).toBe('household');
    const refused = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(teen),
      payload: { title: 'Allergy letter', visibility: 'adults' },
    });
    expect(refused.statusCode).toBe(403);
  });

  it('an Only me capture records that its owner was told what that means', async () => {
    const res = await capture(owner, { owner_member_id: owner.member_id, visibility: 'private' });
    const id = json<{ document_id: string }>(res).document_id;
    const told = await admin.query(
      'select 1 from private_notice where document_id = $1 and member_id = $2',
      [id, owner.member_id],
    );
    expect(told.rowCount).toBe(1);
  });

  it('the details sent as a file part (a Blob of JSON) are still the details', async () => {
    const meta = Buffer.concat([
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="metadata"; filename="blob"\r\nContent-Type: application/json\r\n\r\n`,
      ),
      Buffer.from(JSON.stringify({ type_key: 'passport', title: 'Sent as a blob' })),
      Buffer.from('\r\n'),
    ]);
    const res = await raw(owner, [meta, filePart()]);
    expect(res.statusCode).toBe(201);
    const d = json<DocumentView>(await doc(owner, json<{ document_id: string }>(res).document_id));
    expect(d).toMatchObject({ type_key: 'passport', title: 'Sent as a blob' });
  });

  it('details sent as a file are read only as far as details could reach', async () => {
    const huge = Buffer.concat([
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="metadata"; filename="blob"\r\nContent-Type: application/json\r\n\r\n`,
      ),
      Buffer.from(JSON.stringify({ notes: 'x'.repeat(70 * 1024) })),
      Buffer.from('\r\n'),
    ]);
    const key = randomUUID();
    const res = await raw(owner, [huge, filePart()], key);
    expect(res.statusCode).toBe(422);
    expect(json<{ error: { message: string } }>(res).error.message).toBe(
      'The details are too long.',
    );
    expect((await capture(owner, undefined, { key })).statusCode).toBe(201);
  });

  it('a details field sent as application/json is read', async () => {
    const meta = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ title: 'Typed JSON' })}\r\n`,
    );
    const res = await raw(owner, [meta, filePart()]);
    expect(res.statusCode).toBe(201);
    expect(
      json<DocumentView>(await doc(owner, json<{ document_id: string }>(res).document_id)).title,
    ).toBe('Typed JSON');
  });

  it('a second file is refused, promptly, and nothing is kept', async () => {
    const before = await documentCount();
    const key = randomUUID();
    const res = await raw(owner, [filePart(), filePart('file', Buffer.alloc(300_000, 1))], key);
    expect(res.statusCode).toBe(422);
    expect(await documentCount()).toBe(before);
    expect(await incoming()).toEqual([]);
    const status = await h.app.inject({
      method: 'GET',
      url: `/api/v1/uploads/${key}`,
      headers: h.as(owner),
    });
    expect(status.statusCode).toBe(404);
  }, 20_000);

  it('a file under any other name is refused, and the key is not used up', async () => {
    const key = randomUUID();
    const res = await raw(owner, [filePart('photo'), filePart()], key);
    expect(res.statusCode).toBe(422);
    expect((await capture(owner, undefined, { key })).statusCode).toBe(201);
  });
});
