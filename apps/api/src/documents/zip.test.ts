import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  ZIP_LEFT_OUT,
  type Capabilities,
  type CollectionDetail,
  type DocumentView,
  type SharedSession,
  type Tokens,
} from '@fdv/shared';
import type { LightMyRequestResponse } from 'fastify';
import FormData from 'form-data';
import yauzl from 'yauzl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../test-harness.js';
import { safeFileName } from '@fdv/shared';
import { zipLimits } from './zip.js';

/**
 * Several documents as one ZIP (0.9.0, DL; FND-05), from the side of each
 * role and of a link's recipient: exactly what each could download on its
 * own goes in, written down as each download is; what they can see but not
 * download is named in the index; what they cannot see is not there at all.
 * A Sensitive document asks to confirm it's you first; a link to view gives
 * no ZIP; one taken back or expired gives nothing.
 */

const PDF = (marker: string) =>
  Buffer.from(
    `%PDF-1.4\n% ${marker}\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
  );

/** A ZIP's files by name, read whole: small test files only. */
async function unzip(body: Buffer): Promise<Map<string, Buffer>> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.fromBuffer(body, { lazyEntries: true }, (err, z) => (err ? reject(err) : resolve(z))),
  );
  const out = new Map<string, Buffer>();
  await new Promise<void>((resolve, reject) => {
    zip.on('error', reject);
    zip.on('end', () => resolve());
    zip.on('entry', (entry: yauzl.Entry) => {
      zip.openReadStream(entry, (err, stream) => {
        if (err) return reject(err);
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('error', reject);
        stream.on('end', () => {
          out.set(entry.fileName, Buffer.concat(chunks));
          zip.readEntry();
        });
      });
    });
    zip.readEntry();
  });
  return out;
}

/** The files in a ZIP, but its index. */
const filesIn = (z: Map<string, Buffer>) =>
  [...z.keys()].filter((n) => n !== 'index.html' && n !== 'index.csv').sort();

describe.skipIf(!testAdminUrl())('several documents as one ZIP (0.9.0, DL)', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  let owner: Tokens;
  let ada: Tokens;
  let ben: Tokens;
  let tia: Tokens;
  let vic: Tokens;
  let jane: Tokens;
  const d = {} as Record<
    | 'water'
    | 'adults'
    | 'ownerPrivate'
    | 'bank'
    | 'passport'
    | 'note'
    | 'paperOnly'
    | 'adaBill'
    | 'adaMedical'
    | 'adaPrivate',
    string
  >;
  let nth = 0;
  const peer = () => ({ remoteAddress: `10.77.${Math.floor(++nth / 200)}.${nth % 200}` });

  const json = <T>(r: { json: () => unknown }) => r.json() as T;
  const code = (r: LightMyRequestResponse) => json<{ error: { code: string } }>(r).error.code;
  const call = (
    who: Tokens,
    method: 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT',
    url: string,
    payload?: object,
  ) => h.app.inject({ method, url, headers: h.as(who), ...(payload ? { payload } : {}) });

  const make = async (who: Tokens, body: Record<string, unknown>, file = true) => {
    const r = await call(who, 'POST', '/api/v1/documents', body);
    expect(r.statusCode, r.body).toBe(201);
    const id = json<DocumentView>(r).id;
    if (file) {
      const form = new FormData();
      form.append('file', PDF(String(body.title)), {
        filename: 'scan.pdf',
        contentType: 'application/pdf',
      });
      const up = await h.app.inject({
        method: 'POST',
        url: `/api/v1/documents/${id}/versions`,
        headers: { ...h.as(who), ...form.getHeaders(), 'idempotency-key': randomUUID() },
        payload: form.getBuffer(),
      });
      expect(up.statusCode, up.body).toBeLessThan(300);
    }
    return id;
  };

  /** Whether `who` confirmed it's them in the last five minutes. */
  const fresh = (who: Tokens, yes = true) =>
    admin.query(
      `update session set verified_at = $2
        where account_id = (select account_id from account_household where member_id = $1)`,
      [who.member_id, new Date(Date.now() - (yes ? 0 : 10 * 60_000))],
    );
  const zipOf = (who: Tokens, ids: string[]) =>
    call(who, 'POST', '/api/v1/documents/download', { document_ids: ids });
  const zipped = async (r: LightMyRequestResponse) => {
    expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
    expect(r.headers['content-type']).toBe('application/zip');
    expect(String(r.headers['content-disposition'])).toMatch(/^attachment; filename\*=UTF-8''/);
    expect(r.headers['cache-control']).toBe('private, no-store');
    return unzip(r.rawPayload);
  };
  /** Each `document.downloaded` line written for these documents since `since`. */
  const downloadsLogged = async (ids: string[], since: string, action = 'document.downloaded') =>
    (
      await admin.query<{ object_id: string }>(
        `select object_id from audit_event
          where action = $1 and object_id = any($2::uuid[]) and id > $3`,
        [action, ids, since],
      )
    ).rows
      .map((r) => r.object_id)
      .sort();
  /** Where the log is now: what is written after this is newer. */
  const now = async () =>
    (await admin.query<{ id: string }>('select coalesce(max(id), 0)::text as id from audit_event'))
      .rows[0]?.id as string;

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    admin = createPool(h.adminUrl, 2);
    owner = await h.setup();
    ada = await h.join(owner, { name: 'Ada', email: 'ada-dl@example.test', role: 'adult' });
    ben = await h.join(owner, { name: 'Ben', email: 'ben-dl@example.test', role: 'adult' });
    tia = await h.join(owner, { name: 'Tia', email: 'tia-dl@example.test', role: 'teen' });
    vic = await h.join(owner, { name: 'Vic', email: 'vic-dl@example.test', role: 'viewer' });
    // Jane, an attorney from outside the family, given Ada's documents (5.34).
    await h.decider(owner);
    const invited = await call(owner, 'POST', '/api/v1/invitations', {
      display_name: 'Jane Smith',
      relationship: 'attorney',
      email: 'jane-dl@example.test',
      role: 'viewer',
      kind: 'guest',
      restriction: { people: [ada.member_id] },
      access_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    expect(invited.statusCode, invited.body).toBe(201);
    const { link_token, code: joinCode } = json<{ link_token: string; code: string }>(invited);
    const accepted = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      payload: { token: link_token, code: joinCode, password: 'the guest’s own password' },
      ...peer(),
    });
    expect(accepted.statusCode, accepted.body).toBe(201);
    jane = json<Tokens>(accepted);

    const plain = { type_key: 'utility_bill', sensitive: false };
    d.water = await make(owner, {
      ...plain,
      title: 'Water bill',
      visibility: 'household',
      owner_member_id: owner.member_id,
    });
    d.adults = await make(owner, {
      ...plain,
      title: 'Adults only bill',
      visibility: 'adults',
      owner_member_id: owner.member_id,
    });
    d.ownerPrivate = await make(owner, {
      ...plain,
      title: 'Owner’s own bill',
      visibility: 'private',
      owner_member_id: owner.member_id,
    });
    d.bank = await make(owner, {
      ...plain,
      title: 'Bank statement',
      sensitive: true,
      visibility: 'household',
      owner_member_id: owner.member_id,
    });
    d.passport = await make(owner, {
      type_key: 'passport',
      title: 'Passport',
      sensitive: false,
      is_essential: true,
      visibility: 'household',
      owner_member_id: owner.member_id,
    });
    d.note = await make(
      owner,
      { type_key: 'note', title: 'Where the keys are', notes: 'Under the mat.' },
      false,
    );
    d.paperOnly = await make(
      owner,
      { ...plain, title: 'Paper only', visibility: 'household', owner_member_id: owner.member_id },
      false,
    );
    d.adaBill = await make(ada, {
      ...plain,
      title: 'Ada’s bill',
      visibility: 'household',
      owner_member_id: ada.member_id,
    });
    d.adaMedical = await make(ada, {
      type_key: 'prescription',
      title: 'Ada’s prescription',
      sensitive: false,
      visibility: 'private',
      owner_member_id: ada.member_id,
    });
    d.adaPrivate = await make(ada, {
      ...plain,
      title: 'Ada’s private bill',
      visibility: 'private',
      owner_member_id: ada.member_id,
    });
    // Ada names Ben her caregiver: he reads her medical papers (H1b).
    const named = await call(ada, 'POST', `/api/v1/members/${ada.member_id}/caregivers`, {
      caregiver_member_id: ben.member_id,
    });
    expect(named.statusCode, named.body).toBe(201);
  }, 180_000);

  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  it('says so in its capabilities', async () => {
    const caps = json<Capabilities>(await h.app.inject({ url: '/api/v1/capabilities' }));
    expect(caps.features.zip_download).toBe(true);
  });

  it('an adult: what they can download, an index, each written down as a download; nothing asked', async () => {
    await fresh(ada, false);
    const since = await now();
    const z = await zipped(await zipOf(ada, [d.water, d.adults, d.ownerPrivate, d.adaBill]));
    // The owner's Only me is not there at all, not even in the index.
    expect(filesIn(z)).toEqual(['Ada_s bill.pdf', 'Adults only bill.pdf', 'Water bill.pdf']);
    expect(z.get('Water bill.pdf')?.toString()).toContain('% Water bill');
    const csv = z.get('index.csv')?.toString() ?? '';
    expect(csv.split('\n')[0]).toBe('Title,Kind,Person,Issued,Expires,File in this ZIP,Note');
    expect(csv).toContain('Water bill');
    expect(csv).not.toContain('Owner’s own bill');
    const html = z.get('index.html')?.toString() ?? '';
    expect(html).toContain('<a href="Water%20bill.pdf">Water bill.pdf</a>');
    expect(html).not.toContain('Owner’s own bill');
    expect(await downloadsLogged([d.water, d.adults, d.ownerPrivate, d.adaBill], since)).toEqual(
      [d.water, d.adults, d.adaBill].sort(),
    );
  });

  it('a Sensitive document asks to confirm it’s you first, and nothing is written down until then', async () => {
    await fresh(ada, false);
    const since = await now();
    const asked = await zipOf(ada, [d.water, d.bank]);
    expect(asked.statusCode).toBe(403);
    expect(json<{ error: { code: string; action: string } }>(asked).error).toMatchObject({
      code: 'step_up_required',
      action: 'download_sensitive',
    });
    expect(await downloadsLogged([d.water, d.bank], since)).toEqual([]);
    await fresh(ada);
    expect(filesIn(await zipped(await zipOf(ada, [d.water, d.bank])))).toEqual([
      'Bank statement.pdf',
      'Water bill.pdf',
    ]);
  });

  it('an Only me or an Essential document asks what opening it asks', async () => {
    await fresh(owner, false);
    const own = await zipOf(owner, [d.water, d.ownerPrivate]);
    expect(json<{ error: { action: string } }>(own).error.action).toBe('open_private_document');
    const essential = await zipOf(owner, [d.water, d.passport]);
    expect(json<{ error: { action: string } }>(essential).error.action).toBe('open_essential');
    await fresh(owner);
    expect(filesIn(await zipped(await zipOf(owner, [d.ownerPrivate, d.passport])))).toEqual([
      'Owner_s own bill.pdf',
      'Passport.pdf',
    ]);
  });

  it('a note goes in as its words, a Markdown file; a document with no file is named in the index', async () => {
    await fresh(owner);
    const own = await make(
      owner,
      {
        type_key: 'note',
        title: 'My own <note>',
        notes: 'Only for me & nobody else.',
        visibility: 'private',
        owner_member_id: owner.member_id,
      },
      false,
    );
    const z = await zipped(await zipOf(owner, [d.water, d.note, d.paperOnly, own]));
    expect(filesIn(z)).toEqual(['My own _note_.md', 'Water bill.pdf', 'Where the keys are.md']);
    expect(z.get('Where the keys are.md')?.toString()).toBe(
      '# Where the keys are\n\nUnder the mat.\n',
    );
    // Its owner's own Only me note, opened for them; written safe for any viewer.
    expect(z.get('My own _note_.md')?.toString()).toBe(
      '# My own \\<note>\n\nOnly for me & nobody else.\n',
    );
    const csv = z.get('index.csv')?.toString() ?? '';
    expect(csv).toContain('Where the keys are,Note,');
    expect(csv).toContain(ZIP_LEFT_OUT.no_file);
    // Its words are in its file, never in the index.
    expect(z.get('index.html')?.toString()).not.toContain('Under the mat');
    // Somebody else's Only me note is not there at all.
    await fresh(ada);
    expect(filesIn(await zipped(await zipOf(ada, [d.water, own])))).toEqual(['Water bill.pdf']);
  });

  it('a teen and a viewer: only what they see; a guest: only what she was given', async () => {
    const all = Object.values(d);
    // An Essential and a Sensitive one among them: asked of the whole.
    await fresh(tia, false);
    expect(code(await zipOf(tia, all))).toBe('step_up_required');
    await fresh(tia);
    expect(filesIn(await zipped(await zipOf(tia, all)))).toEqual([
      'Ada_s bill.pdf',
      'Bank statement.pdf',
      'Passport.pdf',
      'Water bill.pdf',
      'Where the keys are.md',
    ]);

    await fresh(vic);
    expect(filesIn(await zipped(await zipOf(vic, all)))).toEqual([
      'Ada_s bill.pdf',
      'Bank statement.pdf',
      'Passport.pdf',
      'Water bill.pdf',
      'Where the keys are.md',
    ]);

    await fresh(jane);
    expect(filesIn(await zipped(await zipOf(jane, all)))).toEqual(['Ada_s bill.pdf']);
    // Nothing she is given at all: as if none of them were there.
    expect((await zipOf(jane, [d.water, d.passport])).statusCode).toBe(404);
  });

  it('a caregiver: the medical paper his grant gives him, written down for its person; nothing else of hers', async () => {
    await fresh(ben, false);
    const asked = await zipOf(ben, [d.adaMedical, d.adaPrivate]);
    expect(json<{ error: { action: string } }>(asked).error.action).toBe('open_private_document');
    await fresh(ben);
    const since = await now();
    const z = await zipped(await zipOf(ben, [d.adaMedical, d.adaPrivate]));
    expect(filesIn(z)).toEqual(['Ada_s prescription.pdf']);
    expect(z.get('index.csv')?.toString()).not.toContain('private bill');
    expect(await downloadsLogged([d.adaMedical], since)).toEqual([d.adaMedical]);
    const looks = await admin.query<{ action: string }>(
      'select action from caregiver_view where document_id = $1',
      [d.adaMedical],
    );
    expect(looks.rows.map((r) => r.action)).toContain('downloaded');
  });

  it('nothing to download, nothing there, and past what one ZIP holds', async () => {
    await fresh(owner);
    expect(code(await zipOf(owner, [d.paperOnly]))).toBe('nothing_to_zip');
    expect((await zipOf(owner, [randomUUID()])).statusCode).toBe(404);
    expect((await zipOf(owner, [])).statusCode).toBe(422);
    const was = { ...zipLimits };
    zipLimits.documents = 2;
    try {
      const big = await zipOf(owner, [d.water, d.adults, d.bank]);
      expect(big.statusCode).toBe(422);
      expect(code(big)).toBe('zip_too_large');
      expect(json<{ error: { message: string } }>(big).error.message).toContain(
        'Settings → Export',
      );
      // Somebody who may not export is not sent there.
      expect(
        json<{ error: { message: string } }>(await zipOf(vic, [d.water, d.adaBill, d.passport]))
          .error.message,
      ).not.toContain('Export');
      zipLimits.documents = was.documents;
      zipLimits.bytes = 10;
      expect(code(await zipOf(owner, [d.water]))).toBe('zip_too_large');
    } finally {
      Object.assign(zipLimits, was);
    }
  });

  it('a collection: what the caller is given of it, in its order; Sensitive asks; a viewer is given none', async () => {
    const made = await call(owner, 'POST', '/api/v1/collections', {
      name: 'House: sale',
      audience: 'everyone',
    });
    expect(made.statusCode, made.body).toBe(201);
    const id = json<CollectionDetail>(made).id;
    const put = await call(owner, 'POST', `/api/v1/collections/${id}/items`, {
      document_ids: [d.water, d.bank, d.adults, d.ownerPrivate, d.note],
    });
    expect(put.statusCode, put.body).toBe(200);
    const download = (who: Tokens) => call(who, 'POST', `/api/v1/collections/${id}/download`);

    await fresh(ada, false);
    expect(json<{ error: { action: string } }>(await download(ada)).error.action).toBe(
      'download_sensitive',
    );
    await fresh(ada);
    const r = await download(ada);
    expect(String(r.headers['content-disposition'])).toContain(
      encodeURIComponent(safeFileName('House: sale')),
    );
    const z = await zipped(r);
    expect(filesIn(z)).toEqual([
      'Adults only bill.pdf',
      'Bank statement.pdf',
      'Water bill.pdf',
      'Where the keys are.md',
    ]);
    const csv = z.get('index.csv')?.toString() ?? '';
    expect(csv).not.toContain('Owner’s own bill');
    // In the collection's order.
    expect(csv.indexOf('Water bill')).toBeLessThan(csv.indexOf('Bank statement'));

    await fresh(tia);
    expect(filesIn(await zipped(await download(tia)))).toEqual([
      'Bank statement.pdf',
      'Water bill.pdf',
      'Where the keys are.md',
    ]);
    expect((await download(vic)).statusCode).toBe(404);
    expect(
      (await call(owner, 'POST', `/api/v1/collections/${randomUUID()}/download`)).statusCode,
    ).toBe(404);
  });

  /** The file a document's newest version is kept in, taken away: as a disk that lost it. */
  const loseFile = async (documentId: string) => {
    const v = await admin.query<{ storage_key: string }>(
      'select storage_key from document_version where document_id = $1 order by version_no desc limit 1',
      [documentId],
    );
    await rm(path.join(h.vaultDir, v.rows[0]?.storage_key as string));
  };

  it('a file not where the files are kept is left out, said so in the index, not logged — and the rest come', async () => {
    await fresh(owner);
    const lost = await make(owner, {
      type_key: 'utility_bill',
      sensitive: false,
      title: 'Lost bill',
      visibility: 'household',
      owner_member_id: owner.member_id,
    });
    await loseFile(lost);
    const since = await now();
    const z = await zipped(await zipOf(owner, [d.water, lost]));
    expect(filesIn(z)).toEqual(['Water bill.pdf']);
    const csv = z.get('index.csv')?.toString() ?? '';
    expect(csv).toContain(ZIP_LEFT_OUT.not_there);
    expect(await downloadsLogged([d.water, lost], since)).toEqual([d.water]);
    // Only that one: nothing there to give.
    expect(code(await zipOf(owner, [lost]))).toBe('nothing_to_zip');
  });

  it('the index is written last, after the files, so it says what is really in it', async () => {
    await fresh(owner);
    const index = await make(owner, {
      type_key: 'utility_bill',
      sensitive: false,
      title: 'index',
      visibility: 'household',
      owner_member_id: owner.member_id,
    });
    const r = await zipOf(owner, [index]);
    expect(r.statusCode, r.body.slice(0, 200)).toBe(200);
    const z = await unzip(r.rawPayload);
    expect([...z.keys()]).toEqual(['index.pdf', 'index.html', 'index.csv']);
  });

  it('a title in Urdu or Arabic keeps its letters in the file’s name', async () => {
    await fresh(owner);
    const urdu = await make(owner, {
      type_key: 'utility_bill',
      sensitive: false,
      title: 'بجلی کا بل',
      visibility: 'household',
      owner_member_id: owner.member_id,
    });
    const arabic = await make(owner, {
      type_key: 'utility_bill',
      sensitive: false,
      title: 'فاتورة الكهرباء\u202e/../x',
      visibility: 'household',
      owner_member_id: owner.member_id,
    });
    const r = await zipOf(owner, [urdu, arabic]);
    expect(String(r.headers['content-disposition'])).toMatch(/^attachment; filename\*=UTF-8''/);
    const z = await zipped(r);
    expect(filesIn(z)).toEqual(['بجلی کا بل.pdf', 'فاتورة الكهرباء_.._x.pdf'].sort());
  });

  describe('by a ticket, as a browser saves it to disk', () => {
    const ticket = (who: Tokens, ids: string[]) =>
      call(who, 'POST', '/api/v1/documents/download/ticket', { document_ids: ids });

    it('asks everything first, as JSON; then the ZIP once, as that session, and never again', async () => {
      await fresh(ada, false);
      // Asked of the ticket, with nothing written down.
      const since = await now();
      const asked = await ticket(ada, [d.water, d.bank]);
      expect(asked.statusCode).toBe(403);
      expect(json<{ error: { action: string } }>(asked).error.action).toBe('download_sensitive');
      expect(code(await ticket(ada, [randomUUID()]))).toBe('not_found');
      await fresh(ada);
      const made = await ticket(ada, [d.water, d.bank]);
      expect(made.statusCode, made.body).toBe(201);
      expect(made.headers['cache-control']).toBe('no-store');
      const { url } = json<{ url: string; expires_at: string }>(made);
      expect(url).toMatch(/^\/api\/v1\/downloads\/[\w-]{40,}$/);
      expect(await downloadsLogged([d.water, d.bank], since)).toEqual([]);
      // No bearer: the ticket alone.
      const got = await h.app.inject({ url, ...peer() });
      expect(got.headers['referrer-policy']).toBe('no-referrer');
      expect(filesIn(await zipped(got))).toEqual(['Bank statement.pdf', 'Water bill.pdf']);
      expect(await downloadsLogged([d.water, d.bank], since)).toEqual([d.water, d.bank].sort());
      // Once.
      const again = await h.app.inject({ url, ...peer() });
      expect(again.statusCode).toBe(404);
      expect(code(again)).toBe('download_ticket_gone');
      expect(
        code(await h.app.inject({ url: '/api/v1/downloads/made-up-ticket-0123456789abcdef' })),
      ).toBe('download_ticket_gone');
    });

    it('one whose session is no longer fresh, or signed out, gives nothing', async () => {
      await fresh(owner);
      const first = await ticket(owner, [d.water, d.bank]);
      const { url } = json<{ url: string }>(first);
      // No longer fresh by the time it is followed: asked again, refused.
      await fresh(owner, false);
      const stale = await h.app.inject({ url, ...peer() });
      expect(stale.statusCode).toBe(403);
      expect(code(stale)).toBe('step_up_required');
      // Signed out: the session it was made for is over.
      await h.decider(owner);
      await fresh(owner);
      const someone = await h.join(owner, {
        name: 'Sam',
        email: 'sam-dl@example.test',
        role: 'adult',
      });
      const theirs = json<{ url: string }>(await ticket(someone, [d.water]));
      await admin.query(
        `update session set revoked_at = now()
          where account_id = (select account_id from account_household where member_id = $1)`,
        [someone.member_id],
      );
      const out = await h.app.inject({ url: theirs.url, ...peer() });
      expect(out.statusCode).toBe(401);
    });
  });

  describe('a share link’s Download all', () => {
    let collectionId = '';
    const share = async (body: Record<string, unknown>) => {
      await fresh(owner);
      const r = await call(owner, 'POST', `/api/v1/collections/${collectionId}/shares`, {
        document_ids: [d.water, d.bank, d.adults, d.note],
        confirm_sensitive: true,
        ...body,
      });
      expect(r.statusCode, r.body).toBe(201);
      return json<{ link_token: string; share: { id: string } }>(r);
    };
    const open = async (token: string) => {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/shared/unlock',
        payload: { token },
        ...peer(),
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.cookies.find((c) => c.name === 'fdv_share')?.value as string;
    };
    const all = (cookie: string) =>
      h.app.inject({
        url: '/api/v1/shared/items/download',
        cookies: { fdv_share: cookie },
        ...peer(),
      });

    beforeAll(async () => {
      const made = await call(owner, 'POST', '/api/v1/collections', {
        name: 'For the solicitor',
        audience: 'adults',
      });
      collectionId = json<CollectionDetail>(made).id;
      const put = await call(owner, 'POST', `/api/v1/collections/${collectionId}/items`, {
        document_ids: [d.water, d.bank, d.adults, d.note],
      });
      expect(put.statusCode, put.body).toBe(200);
    });

    it('exactly what the link gives, counted and written down once a session; the index says no more than its page', async () => {
      const made = await share({});
      const cookie = await open(made.link_token);
      const since = await now();
      const r = await all(cookie);
      expect(r.headers['x-robots-tag']).toBe('noindex, nofollow');
      const z = await zipped(r);
      const files = filesIn(z);
      expect(files).toHaveLength(4);
      expect(files).toContain('Where the keys are.md');
      // The sensitive one's title left out of the page is left out here too (H1a).
      expect(files).toContain('document.pdf');
      expect(files).not.toContain('Bank statement.pdf');
      const csv = z.get('index.csv')?.toString() ?? '';
      expect(csv.split('\n')[0]).toBe('Title,Kind,File in this ZIP,Note');
      expect(csv).not.toContain('Bank statement');
      expect(csv).not.toContain('Owner');
      expect(
        await downloadsLogged([d.water, d.bank, d.adults, d.note], since, 'share.downloaded'),
      ).toEqual([d.water, d.bank, d.adults, d.note].sort());
      const used = await admin.query<{ downloads_used: number }>(
        'select downloads_used from share_link where id = $1',
        [made.share.id],
      );
      expect(used.rows[0]?.downloads_used).toBe(4);
      // Again in the same session: free, and not written down again.
      await zipped(await all(cookie));
      expect(
        (await downloadsLogged([d.water, d.bank, d.adults, d.note], since, 'share.downloaded'))
          .length,
      ).toBe(4);
      const session = json<SharedSession>(
        await h.app.inject({
          url: '/api/v1/shared/items',
          cookies: { fdv_share: cookie },
          ...peer(),
        }),
      );
      // The note too: downloaded as a file in the ZIP.
      expect(session.items.filter((i) => i.downloaded)).toHaveLength(4);
    });

    it('Download selected: only the ticked ones the link gives; a note on its own as a Markdown file', async () => {
      const made = await share({});
      const cookie = await open(made.link_token);
      const some = await h.app.inject({
        url: `/api/v1/shared/items/download?ids=${d.water},${d.note},${d.ownerPrivate}`,
        cookies: { fdv_share: cookie },
        ...peer(),
      });
      const z = await zipped(some);
      expect(filesIn(z)).toEqual(['Water bill.pdf', 'Where the keys are.md']);
      expect(z.get('index.csv')?.toString()).not.toContain('Adults only');
      // Nothing the link gives among them.
      const none = await h.app.inject({
        url: `/api/v1/shared/items/download?ids=${d.ownerPrivate}`,
        cookies: { fdv_share: cookie },
        ...peer(),
      });
      expect(none.statusCode).toBe(404);
      const bad = await h.app.inject({
        url: '/api/v1/shared/items/download?ids=not-an-id',
        cookies: { fdv_share: cookie },
        ...peer(),
      });
      expect(bad.statusCode).toBe(422);

      const note = await h.app.inject({
        url: `/api/v1/shared/items/${d.note}/note/download`,
        cookies: { fdv_share: cookie },
        ...peer(),
      });
      expect(note.statusCode, note.body).toBe(200);
      expect(note.headers['content-type']).toBe('text/markdown; charset=utf-8');
      expect(String(note.headers['content-disposition'])).toContain('Where%20the%20keys%20are.md');
      expect(note.body).toBe('# Where the keys are\n\nUnder the mat.\n');
      // A document with a file is not a note.
      const notNote = await h.app.inject({
        url: `/api/v1/shared/items/${d.water}/note/download`,
        cookies: { fdv_share: cookie },
        ...peer(),
      });
      expect(notNote.statusCode).toBe(404);
    });

    it('downloads running out part-way leave the rest out, named; none left is refused', async () => {
      const made = await share({ max_downloads: 2 });
      const cookie = await open(made.link_token);
      const z = await zipped(await all(cookie));
      expect(filesIn(z)).toHaveLength(2);
      expect(z.get('index.csv')?.toString()).toContain(ZIP_LEFT_OUT.used_up);
      // Another session of the same link: nothing new left to give.
      const other = await open(made.link_token);
      const refused = await all(other);
      expect(refused.statusCode).toBe(403);
      expect(code(refused)).toBe('downloads_used_up');
    });

    it('asked first, counting nothing: what a ZIP of them would refuse', async () => {
      const made = await share({ max_downloads: 1 });
      const cookie = await open(made.link_token);
      const check = (q = '') =>
        h.app.inject({
          url: `/api/v1/shared/items/download/check${q}`,
          cookies: { fdv_share: cookie },
          ...peer(),
        });
      const ok = await check();
      expect(ok.statusCode, ok.body).toBe(200);
      expect(json<{ ok: boolean; documents: number }>(ok)).toEqual({ ok: true, documents: 4 });
      const used = await admin.query<{ downloads_used: number }>(
        'select downloads_used from share_link where id = $1',
        [made.share.id],
      );
      expect(used.rows[0]?.downloads_used).toBe(0);
      // One download left: taken; then none left for what this session has not had.
      await zipped(await all(cookie));
      const none = await check(`?ids=${d.adults}`);
      expect([none.statusCode, code(none)]).toEqual([403, 'downloads_used_up']);
      const was = { ...zipLimits };
      zipLimits.documents = 1;
      try {
        expect(code(await check())).toBe('zip_too_large');
      } finally {
        Object.assign(zipLimits, was);
      }
    });

    it('a clinician’s link (H4) never reaches a ZIP or a note’s file', async () => {
      await fresh(owner);
      const page = await call(owner, 'PUT', `/api/v1/members/${owner.member_id}/emergency`, {
        fields: { blood_type: 'O-' },
      });
      expect(page.statusCode, page.body).toBeLessThan(300);
      const made = await call(owner, 'POST', `/api/v1/members/${owner.member_id}/emergency/links`, {
        fields: ['blood_type'],
      });
      expect(made.statusCode, made.body).toBe(201);
      const cookie = await open(json<{ link_token: string }>(made).link_token);
      for (const url of [
        '/api/v1/shared/items/download',
        `/api/v1/shared/items/download?ids=${d.water}`,
        '/api/v1/shared/items/download/check',
        `/api/v1/shared/items/${d.note}/note/download`,
      ]) {
        const r = await h.app.inject({ url, cookies: { fdv_share: cookie }, ...peer() });
        expect([403, 404], `${url}: ${r.body}`).toContain(r.statusCode);
        expect(r.headers['content-type']).not.toBe('application/zip');
      }
    });

    it('a file not where the files are kept is neither counted nor logged, and the rest come', async () => {
      const lost = await make(owner, {
        type_key: 'utility_bill',
        sensitive: false,
        title: 'Lost on the link',
        visibility: 'household',
        owner_member_id: owner.member_id,
      });
      const put = await call(owner, 'POST', `/api/v1/collections/${collectionId}/items`, {
        document_ids: [lost],
      });
      expect(put.statusCode, put.body).toBe(200);
      const made = await share({ document_ids: [d.water, lost] });
      await loseFile(lost);
      const cookie = await open(made.link_token);
      const since = await now();
      const z = await zipped(await all(cookie));
      expect(filesIn(z)).toEqual(['Water bill.pdf']);
      expect(z.get('index.csv')?.toString()).toContain(ZIP_LEFT_OUT.not_there);
      expect(await downloadsLogged([d.water, lost], since, 'share.downloaded')).toEqual([d.water]);
      const used = await admin.query<{ downloads_used: number }>(
        'select downloads_used from share_link where id = $1',
        [made.share.id],
      );
      expect(used.rows[0]?.downloads_used).toBe(1);
    });

    it('a link to view gives no ZIP; one taken back or expired gives nothing', async () => {
      const viewing = await share({ permission: 'view' });
      const v = await all(await open(viewing.link_token));
      expect(v.statusCode).toBe(403);
      expect(code(v)).toBe('view_only');
      const viewCookie = await open((await share({ permission: 'view' })).link_token);
      const noteFile = await h.app.inject({
        url: `/api/v1/shared/items/${d.note}/note/download`,
        cookies: { fdv_share: viewCookie },
        ...peer(),
      });
      expect(code(noteFile)).toBe('view_only');

      const revoked = await share({});
      const cookie = await open(revoked.link_token);
      await fresh(owner);
      expect((await call(owner, 'DELETE', `/api/v1/shares/${revoked.share.id}`)).statusCode).toBe(
        204,
      );
      // Its sessions end with it.
      expect(['share_session_ended', 'link_not_valid']).toContain(code(await all(cookie)));

      const expiring = await share({});
      const late = await open(expiring.link_token);
      await admin.query(
        "update share_link set expires_at = now() - interval '1 minute' where id = $1",
        [expiring.share.id],
      );
      expect(code(await all(late))).toBe('link_not_valid');

      // No session at all.
      expect((await all('not-a-session-cookie-at-all')).statusCode).toBe(401);
      const was = { ...zipLimits };
      zipLimits.documents = 1;
      try {
        const big = await all(await open((await share({})).link_token));
        expect(code(big)).toBe('zip_too_large');
        expect(json<{ error: { message: string } }>(big).error.message).not.toContain('Export');
      } finally {
        Object.assign(zipLimits, was);
      }
    });
  });
});
