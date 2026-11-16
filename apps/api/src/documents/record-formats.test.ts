import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { DocumentLinkOpens, DocumentView, ShareOpens, VersionView } from '@fdv/shared';
import type { LightMyRequestResponse } from 'fastify';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';
import { sniffStream } from './service.js';
import type { CreatedShare } from './shares.js';

/**
 * Health records kept as they are, and who opened a link (0.9.0, H5).
 *
 * A C-CDA (XML), a FHIR export (JSON), a DICOM image and a ZIP are taken
 * only when their bytes bear out what they say they are, kept without being
 * opened, and only ever downloaded — XML and JSON under a type no browser
 * renders, never sniffed. A link to view refuses them. And a link's
 * openings are listed for its maker, the owners, and the person a sensitive
 * paper belongs to: when, and in what browser — never an address.
 */

const XML = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?>\n<ClinicalDocument xmlns="urn:hl7-org:v3"><title>Summary</title></ClinicalDocument>\n',
);
const JSON_BYTES = Buffer.concat([
  Buffer.from([0xef, 0xbb, 0xbf]), // a byte-order mark first
  Buffer.from('  {"resourceType":"Bundle","entry":[]}\n'),
]);
const DICOM = Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), Buffer.alloc(64, 1)]);
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60, 2)]);

/** What sniffStream makes of some bytes, said and named as given. */
async function sniffed(bytes: Buffer, declared: string, name: string, records = true) {
  const s = sniffStream(declared, name, { records });
  await pipeline(Readable.from([bytes]), s.stream, async (src) => {
    for await (const _ of src) void _;
  }).catch(() => undefined);
  return s.detected.then(
    (d) => d.mime,
    (e: { code?: string }) => e.code ?? 'refused',
  );
}

describe('what a health record is, from its bytes (H5)', () => {
  it('takes each format by its type, or by its name when the type says nothing', async () => {
    expect(await sniffed(XML, 'text/xml', 'ccd.xml')).toBe('application/xml');
    expect(await sniffed(XML, 'application/octet-stream', 'ccd.xml')).toBe('application/xml');
    expect(await sniffed(JSON_BYTES, 'application/fhir+json', 'export')).toBe('application/json');
    expect(await sniffed(DICOM, '', 'IM0001.dcm')).toBe('application/dicom');
    expect(await sniffed(ZIP, 'application/x-zip-compressed', 'portal.zip')).toBe(
      'application/zip',
    );
  });

  it('refuses one whose bytes are not what it says', async () => {
    // JSON that is XML, XML that is JSON, text that isn't UTF-8 past its start.
    expect(await sniffed(XML, 'application/json', 'a.json')).toBe('unsupported_type');
    expect(await sniffed(JSON_BYTES, 'text/xml', 'a.xml')).toBe('unsupported_type');
    const late = Buffer.concat([XML, Buffer.alloc(6000, 0x20), Buffer.from([0xff, 0xfe])]);
    expect(await sniffed(late, 'text/xml', 'a.xml')).toBe('unsupported_type');
    // A character cut off at the very end.
    expect(
      await sniffed(Buffer.from('{"a":"\xe2\x82', 'latin1'), 'application/json', 'a.json'),
    ).toBe('unsupported_type');
    // DICOM without DICM, a ZIP without PK, a PDF called a ZIP.
    expect(await sniffed(Buffer.alloc(200, 1), 'application/dicom', 'a.dcm')).toBe(
      'unsupported_type',
    );
    expect(await sniffed(XML, 'application/zip', 'a.zip')).toBe('unsupported_type');
    expect(await sniffed(Buffer.from('%PDF-1.4\n%%EOF\n'), '', 'a.zip')).toBe('unsupported_type');
    // A file said to be a PDF is never taken for a record, whatever its name.
    expect(await sniffed(XML, 'application/pdf', 'a.xml')).toBe('unsupported_type');
  });

  it('knows a DICOM image or a ZIP by its bytes when its type and name say nothing (review)', async () => {
    expect(await sniffed(DICOM, '', 'IM00001')).toBe('application/dicom');
    expect(await sniffed(DICOM, 'application/octet-stream', 'IM00001')).toBe('application/dicom');
    expect(await sniffed(ZIP, 'application/octet-stream', 'export')).toBe('application/zip');
    // Sent as something else, it is not taken for one.
    expect(await sniffed(DICOM, 'image/jpeg', 'IM00001')).toBe('unsupported_type');
    // Plain text names: a .json or .xml sent as text/plain is taken; .ndjson is not.
    expect(await sniffed(JSON_BYTES, 'text/plain', 'export.json')).toBe('application/json');
    expect(await sniffed(XML, 'text/plain', 'ccd.xml')).toBe('application/xml');
    expect(await sniffed(JSON_BYTES, 'text/plain', 'export.ndjson')).toBe('unsupported_type');
  });

  it('takes none of them where records are not taken (a computer, a request)', async () => {
    expect(await sniffed(XML, 'text/xml', 'ccd.xml', false)).toBe('unsupported_type');
    expect(await sniffed(DICOM, 'application/dicom', 'a.dcm', false)).toBe('unsupported_type');
    expect(await sniffed(ZIP, 'application/zip', 'a.zip', false)).toBe('unsupported_type');
  });
});

describe.skipIf(!testAdminUrl())('health records kept as they are; who opened a link (H5)', () => {
  let h: Harness;
  let owner: Tokens;
  let adult: Tokens;
  let other: Tokens;
  let adultMember: string;

  const json = <T>(r: { json: () => unknown }) => r.json() as T;
  const errorOf = (r: LightMyRequestResponse) =>
    json<{ error: { code: string; message: string } }>(r).error;
  let nth = 0;
  const peer = () => ({ remoteAddress: `10.85.${Math.floor(++nth / 200)}.${nth % 200}` });

  const doc = async (body: Record<string, unknown>) =>
    json<DocumentView>(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/documents',
        headers: h.as(owner),
        payload: { type_key: 'medical_record', visibility: 'household', ...body },
      }),
    ).id;
  const upload = (id: string, bytes: Buffer, filename: string, contentType: string) => {
    const form = new FormData();
    form.append('file', bytes, { filename, contentType });
    return h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${id}/versions`,
      headers: { ...h.as(owner), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
  };
  const versions = async (id: string) =>
    json<{ items: VersionView[] }>(
      await h.app.inject({ url: `/api/v1/documents/${id}/versions`, headers: h.as(owner) }),
    ).items;

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();
    adult = await h.join(owner, { name: 'Sana', email: 'sana@example.test', role: 'adult' });
    other = await h.join(owner, { name: 'Omar', email: 'omar@example.test', role: 'adult' });
    adultMember = json<{ member_id: string }>(
      await h.app.inject({ url: '/api/v1/me', headers: h.as(adult) }),
    ).member_id;
  }, 90_000);
  afterAll(async () => {
    await h.close();
  });

  it('keeps each record as it is: never drawn, downloaded only, and XML as a type no browser renders', async () => {
    const id = await doc({ title: 'Hospital summary', sensitive: false });
    for (const [bytes, name, type, mime] of [
      [XML, 'ccd.xml', 'text/xml', 'application/xml'],
      [JSON_BYTES, 'export.json', 'application/fhir+json', 'application/json'],
      [DICOM, 'IM0001.dcm', 'application/dicom', 'application/dicom'],
      [ZIP, 'portal.zip', 'application/zip', 'application/zip'],
    ] as const) {
      const r = await upload(id, bytes, name, type);
      expect(r.statusCode, r.body).toBe(201);
      const [v] = await versions(id);
      expect(v).toMatchObject({ mime, stored_as_is: true, preview_pages: 0 });
    }
    // A record that is not one: refused, and nothing kept.
    const bad = await upload(id, Buffer.alloc(300, 7), 'scan.dcm', 'application/dicom');
    expect(bad.statusCode).toBe(415);
    expect(errorOf(bad).code).toBe('unsupported_type');
    expect(await versions(id)).toHaveLength(4);

    const xml = (await versions(id)).find((v) => v.mime === 'application/xml') as VersionView;
    const got = await h.app.inject({
      url: `/api/v1/versions/${xml.id}/content`,
      headers: h.as(owner),
    });
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('application/octet-stream');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    expect(String(got.headers['content-disposition'])).toMatch(/^attachment/);
    expect(got.rawPayload.equals(XML)).toBe(true);
    // No page, and none queued: said so in words.
    const page = await h.app.inject({
      url: `/api/v1/versions/${xml.id}/pages/1`,
      headers: h.as(owner),
    });
    expect(page.statusCode).toBe(404);
    expect(errorOf(page)).toMatchObject({ code: 'no_preview' });
    expect(errorOf(page).message).toMatch(/patient portal’s PDF is the readable copy/);
  });

  it('shares a record only to download, and its download is never rendered', async () => {
    const id = await doc({ title: 'Lab export', sensitive: false });
    expect((await upload(id, JSON_BYTES, 'labs.json', 'application/json')).statusCode).toBe(201);
    const view = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${id}/share`,
      headers: h.as(owner),
      payload: { permission: 'view' },
    });
    expect(view.statusCode).toBe(422);
    expect(errorOf(view)).toMatchObject({ code: 'view_not_possible' });
    expect(errorOf(view).message).toMatch(/Health record files kept as they are/);

    const made = json<CreatedShare>(
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/documents/${id}/share`,
        headers: h.as(owner),
        payload: { permission: 'download' },
      }),
    );
    const opened = await h.app.inject({
      method: 'POST',
      url: '/api/v1/shared/unlock',
      payload: { token: made.link_token },
      ...peer(),
    });
    expect(opened.statusCode, opened.body).toBe(200);
    const cookie = opened.cookies.find((c) => c.name === 'fdv_share')?.value as string;
    const file = await h.app.inject({
      url: `/api/v1/shared/items/${id}/content`,
      cookies: { fdv_share: cookie },
      ...peer(),
    });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('application/octet-stream');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(String(file.headers['content-disposition'])).toMatch(/^attachment/);
  });

  it('lists who opened a link, when, to its maker, the owners and the person whose sensitive paper it is — never an address', async () => {
    // Sana's sensitive paper, shared by the owner.
    const id = await doc({
      title: 'Sana’s blood test',
      owner_member_id: adultMember,
      sensitive: true,
    });
    expect((await upload(id, XML, 'labs.xml', 'text/xml')).statusCode).toBe(201);
    const made = json<CreatedShare>(
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/documents/${id}/share`,
        headers: h.as(owner),
        payload: { permission: 'download', recipient_label: 'Dr Patel', confirm_sensitive: true },
      }),
    );
    const opened = await h.app.inject({
      method: 'POST',
      url: '/api/v1/shared/unlock',
      payload: { token: made.link_token },
      headers: {
        'user-agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      },
      remoteAddress: '203.0.113.77',
    });
    expect(opened.statusCode, opened.body).toBe(200);

    const opens = (t: Tokens) =>
      h.app.inject({ url: `/api/v1/shares/${made.share.id}/opens`, headers: h.as(t) });
    // Its maker, an owner.
    const mine = await opens(owner);
    expect(mine.statusCode, mine.body).toBe(200);
    const seen = json<ShareOpens>(mine);
    expect(seen).toMatchObject({
      share_id: made.share.id,
      recipient_label: 'Dr Patel',
      open_count: 1,
    });
    expect(seen.items.map((o) => o.device)).toEqual(['Safari on an iPhone']);
    expect(Number.isNaN(Date.parse(seen.items[0]?.at ?? ''))).toBe(false);
    expect(mine.body).not.toContain('203.0.113');
    // Sana, whose paper it is: hers to know, though she did not make it.
    const hers = await opens(adult);
    expect(hers.statusCode, hers.body).toBe(200);
    expect(json<ShareOpens>(hers).items).toHaveLength(1);
    const listed = json<DocumentLinkOpens>(
      await h.app.inject({ url: `/api/v1/documents/${id}/link-opens`, headers: h.as(adult) }),
    ).items;
    expect(listed).toEqual([
      expect.objectContaining({
        share_id: made.share.id,
        mine: false,
        recipient_label: 'Dr Patel',
        opens: [{ at: seen.items[0]?.at, device: 'Safari on an iPhone' }],
      }),
    ]);
    // Another adult, who sees the paper and the link in Sharing: not theirs.
    const his = await opens(other);
    expect(his.statusCode).toBe(404);
    expect(
      json<DocumentLinkOpens>(
        await h.app.inject({ url: `/api/v1/documents/${id}/link-opens`, headers: h.as(other) }),
      ).items,
    ).toEqual([]);

    // Not sensitive any more: Sana is no longer shown links she did not make.
    const now = json<DocumentView>(
      await h.app.inject({ url: `/api/v1/documents/${id}`, headers: h.as(owner) }),
    );
    const patched = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/documents/${id}`,
      headers: { ...h.as(owner), 'if-match': now.etag },
      payload: { sensitive: false },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect((await opens(adult)).statusCode).toBe(404);
  });

  it('lists a collection’s link to a teen’s sensitive paper for the teen, and its maker (review)', async () => {
    const teen = await h.join(owner, { name: 'Zara', email: 'zara@example.test', role: 'teen' });
    const teenMember = json<{ member_id: string }>(
      await h.app.inject({ url: '/api/v1/me', headers: h.as(teen) }),
    ).member_id;
    const id = await doc({
      title: 'Zara’s vaccination record',
      owner_member_id: teenMember,
      sensitive: true,
    });
    expect((await upload(id, XML, 'jabs.xml', 'text/xml')).statusCode).toBe(201);
    const c = await h.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: h.as(owner),
      payload: { name: 'For the school', audience: 'everyone' },
    });
    const collection = json<{ id: string }>(c).id;
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/collections/${collection}/items`,
      headers: h.as(owner),
      payload: { document_ids: [id] },
    });
    // Making a collection's link asks that it's them: confirmed a moment ago.
    await withSystem(h.db, owner.household_id, (trx) =>
      trx.updateTable('session').set({ verified_at: new Date() }).execute(),
    );
    const madeRes = await h.app.inject({
      method: 'POST',
      url: `/api/v1/collections/${collection}/shares`,
      headers: h.as(owner),
      payload: {
        document_ids: [id],
        permission: 'download',
        recipient_label: 'the school nurse',
        confirm_sensitive: true,
      },
    });
    expect(madeRes.statusCode, madeRes.body).toBe(201);
    const made = json<CreatedShare>(madeRes);
    const opened = await h.app.inject({
      method: 'POST',
      url: '/api/v1/shared/unlock',
      payload: { token: made.link_token },
      ...peer(),
    });
    expect(opened.statusCode, opened.body).toBe(200);

    for (const who of [teen, owner]) {
      const listed = json<DocumentLinkOpens>(
        await h.app.inject({ url: `/api/v1/documents/${id}/link-opens`, headers: h.as(who) }),
      ).items;
      expect(listed.map((l) => [l.share_id, l.recipient_label, l.opens.length])).toEqual([
        [made.share.id, 'the school nurse', 1],
      ]);
      const one = await h.app.inject({
        url: `/api/v1/shares/${made.share.id}/opens`,
        headers: h.as(who),
      });
      expect(one.statusCode, one.body).toBe(200);
    }
    // In the Trash: neither route gives it, for anybody.
    const now = json<DocumentView>(
      await h.app.inject({ url: `/api/v1/documents/${id}`, headers: h.as(owner) }),
    );
    const trashed = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/documents/${id}`,
      headers: { ...h.as(owner), 'if-match': now.etag },
    });
    expect(trashed.statusCode, trashed.body).toBeLessThan(300);
    const gone = await h.app.inject({
      url: `/api/v1/documents/${id}/link-opens`,
      headers: h.as(teen),
    });
    expect(gone.statusCode).toBe(404);
    const goneOne = await h.app.inject({
      url: `/api/v1/shares/${made.share.id}/opens`,
      headers: h.as(teen),
    });
    expect(goneOne.statusCode).toBe(404);
  });

  it('names a record’s download as what it is, whatever it was called (review)', async () => {
    const id = await doc({ title: 'Odd name', sensitive: false });
    expect((await upload(id, XML, 'invoice.html', 'text/xml')).statusCode).toBe(201);
    expect((await upload(id, DICOM, 'IM00001', 'application/octet-stream')).statusCode).toBe(201);
    const [dcm, xml] = await versions(id);
    expect([xml?.filename, dcm?.filename]).toEqual(['invoice.xml', 'IM00001.dcm']);
    const got = await h.app.inject({
      url: `/api/v1/versions/${xml?.id}/content`,
      headers: h.as(owner),
    });
    expect(String(got.headers['content-disposition'])).toContain('invoice.xml');
    expect(String(got.headers['content-disposition'])).not.toContain('.html');
  });

  it('answers 404 for a link that is not there, and for a document the caller cannot see', async () => {
    const none = await h.app.inject({
      url: `/api/v1/shares/${randomUUID()}/opens`,
      headers: h.as(owner),
    });
    expect([none.statusCode, errorOf(none).code]).toEqual([404, 'not_found']);
    const theirs = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(adult),
      payload: {
        title: 'Only mine',
        type_key: 'medical_record',
        owner_member_id: adultMember,
        visibility: 'private',
      },
    });
    expect(theirs.statusCode, theirs.body).toBe(201);
    const hidden = await h.app.inject({
      url: `/api/v1/documents/${json<DocumentView>(theirs).id}/link-opens`,
      headers: h.as(other),
    });
    expect(hidden.statusCode).toBe(404);
  });
});
