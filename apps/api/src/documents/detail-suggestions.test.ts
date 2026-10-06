import { randomUUID } from 'node:crypto';
import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { DetailSuggestions, DocumentView } from '@fdv/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * What a document's pages propose (5.37, A44): GET /documents/{id}/suggestions
 * reads the words the worker read off its newest version and proposes its
 * empty fields — its kind, whose it is, its dates, its number, who issued
 * it — each with a confidence. Worked out for the request and kept nowhere;
 * an Only me document's words opened only in its owner's own request; and
 * only for whoever may change the document, never a viewer, limited or
 * not, nor a guest.
 */

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
const BOUNDARY = 'fdv-suggestions-capture-boundary';
const DAY = 24 * 60 * 60 * 1000;

/** Sarah's passport, as OCR reads its data page. Made up. */
const PASSPORT = [
  'PASSPORT',
  'UNITED KINGDOM OF GREAT BRITAIN AND NORTHERN IRELAND',
  'Passport No.',
  '533401872',
  'Surname',
  'KHAN',
  'Given names',
  'SARAH',
  'Nationality',
  'BRITISH CITIZEN',
  'Place of birth',
  'LEEDS',
  'Date of issue',
  '14 MAR 2021',
  'Date of expiry',
  '14 MAR 2031',
  'Authority',
  'HMPO',
].join('\n');

/** The words of the page, and what was read off it: none of it may reach a log or the audit. */
const SECRETS = ['533401872', 'SARAH', 'KHAN', 'HMPO', 'LEEDS', 'Passport No'];

const json = <T>(r: { json: () => unknown }) => r.json() as T;
/** A refusal as its reader sees it: the status, the code and the words, not the request's id. */
const refusal = (r: { statusCode: number; json: () => unknown }) => {
  const { code, message } = json<{ error: { code: string; message: string } }>(r).error;
  return { status: r.statusCode, code, message };
};

describe.skipIf(!testAdminUrl())('suggestions from the pages (5.37)', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  let owner: Tokens;
  let sarah: Tokens;
  let tariq: Tokens;
  let uma: Tokens;
  let vera: Tokens;
  let jane: Tokens;
  const logged: string[] = [];
  let nth = 0;
  const peer = () => ({ remoteAddress: `10.37.${Math.floor(++nth / 200)}.${nth % 200}` });

  const get = (who: Tokens, url: string) => h.app.inject({ url, headers: h.as(who) });
  const suggestions = (who: Tokens, id: string) => get(who, `/api/v1/documents/${id}/suggestions`);
  const send = (who: Tokens, method: 'POST' | 'PATCH' | 'PUT', url: string, payload: unknown) =>
    h.app.inject({ method, url, headers: h.as(who), payload: payload as never });
  const read = async (who: Tokens, id: string) => {
    const r = await get(who, `/api/v1/documents/${id}`);
    expect(r.statusCode, r.body).toBe(200);
    return json<DocumentView>(r);
  };
  /** A scan sent with its details, as the add card sends it. */
  const capture = async (who: Tokens, metadata: Record<string, unknown>) => {
    const field = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    );
    const head = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="scan.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
    );
    const r = await h.app.inject({
      method: 'POST',
      url: '/api/v1/capture',
      headers: {
        ...h.as(who),
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
        'idempotency-key': randomUUID(),
      },
      payload: Buffer.concat([field, head, PDF, Buffer.from(`\r\n--${BOUNDARY}--\r\n`)]),
    });
    expect(r.statusCode, r.body).toBe(201);
    return json<{ document_id: string; version_id: string }>(r);
  };
  /** The pages read, as the worker leaves them: the words in the index, and the version done. */
  const readPages = async (made: { document_id: string; version_id: string }, words: string) => {
    await admin.query(
      'insert into document_text (version_id, household_id, document_id, content) values ($1, $2, $3, $4)',
      [made.version_id, owner.household_id, made.document_id, words],
    );
    await admin.query("update document_version set ocr_status = 'done' where id = $1", [
      made.version_id,
    ]);
  };
  const auditCount = async () =>
    Number(
      (
        await admin.query<{ n: string }>(
          'select count(*) as n from audit_event where household_id = $1',
          [owner.household_id],
        )
      ).rows[0]?.n,
    );

  beforeAll(async () => {
    h = await createHarness({
      rateLimitPerMinute: 100_000,
      // Every line the API logs, at every level, for the test that reads them.
      logger: { level: 'trace', stream: { write: (s: string) => void logged.push(s) } },
    });
    admin = createPool(h.adminUrl, 2);
    owner = await h.setup();
    sarah = await h.join(owner, { name: 'Sarah', email: 'sarah-537@example.test', role: 'adult' });
    tariq = await h.join(owner, { name: 'Tariq', email: 'tariq-537@example.test', role: 'teen' });
    uma = await h.join(owner, { name: 'Uma', email: 'uma-537@example.test', role: 'viewer' });
    vera = await h.join(owner, { name: 'Vera', email: 'vera-537@example.test', role: 'viewer' });
    // Vera is given Sarah's documents only (5.33).
    await h.decider(owner);
    const limited = await send(owner, 'PUT', `/api/v1/members/${vera.member_id}/access`, {
      people: [sarah.member_id],
    });
    expect(limited.statusCode, limited.body).toBe(200);
    // Jane, from outside the family, is given the same (5.34).
    await h.decider(owner);
    const invited = await send(owner, 'POST', '/api/v1/invitations', {
      display_name: 'Jane Smith',
      relationship: 'attorney',
      email: 'jane-537@example.test',
      role: 'viewer',
      kind: 'guest',
      restriction: { people: [sarah.member_id] },
      access_expires_at: new Date(Date.now() + 30 * DAY).toISOString(),
    });
    expect(invited.statusCode, invited.body).toBe(201);
    const { link_token, code } = json<{ link_token: string; code: string }>(invited);
    const accepted = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      payload: { token: link_token, code, password: 'the guest’s own password' },
      ...peer(),
    });
    expect(accepted.statusCode, accepted.body).toBe(201);
    jane = json<Tokens>(accepted);
  }, 120_000);
  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  it('waits while the pages are read, then proposes the empty fields — and fills none of them', async () => {
    const made = await capture(owner, { title: 'Scan' });
    const pending = await suggestions(owner, made.document_id);
    expect(pending.statusCode).toBe(200);
    expect(pending.headers['cache-control']).toBe('no-store');
    expect(json(pending)).toEqual({ state: 'pending', proposal: {} });

    await readPages(made, PASSPORT);
    const before = await read(owner, made.document_id);
    const audited = await auditCount();
    const ready = json<DetailSuggestions>(await suggestions(owner, made.document_id));
    expect(ready.state).toBe('ready');
    expect(ready.proposal).toEqual({
      type_key: { value: 'passport', confidence: expect.any(Number) as unknown, cue: 'kind_words' },
      owner_member_id: { value: sarah.member_id, confidence: 0.85, cue: 'name_labelled' },
      issued: {
        value: { date: '2021-03-14', precision: 'day' },
        confidence: expect.any(Number) as unknown,
        cue: 'issue_label',
      },
      expires: {
        value: { date: '2031-03-14', precision: 'day' },
        confidence: expect.any(Number) as unknown,
        cue: 'expiry_label',
      },
      identifier: {
        value: '533401872',
        confidence: expect.any(Number) as unknown,
        cue: 'number_label',
      },
      issued_by: { value: 'HM Passport Office', confidence: 0.85, cue: 'issuing_body' },
    });
    for (const p of Object.values(ready.proposal) as Array<{ confidence: number }>) {
      expect(p.confidence).toBeGreaterThanOrEqual(0.7);
      expect(p.confidence).toBeLessThanOrEqual(1);
    }
    // Offered, never filled in, and nothing written down for asking.
    const after = await read(owner, made.document_id);
    expect(after).toEqual(before);
    expect(after.type_key).toBeNull();
    expect(await auditCount()).toBe(audited);
  });

  it('a filled field is never offered, and the kind the document has is the kind its dates are read for', async () => {
    const made = await capture(owner, { title: 'Scan' });
    await readPages(made, PASSPORT);
    const patched = await send(owner, 'PATCH', `/api/v1/documents/${made.document_id}`, {
      type_key: 'passport',
      owner_member_id: sarah.member_id,
      expires: { date: '2031-03-14', precision: 'day' },
      identifier: '  ',
    });
    expect(patched.statusCode, patched.body).toBe(200);
    const { proposal } = json<DetailSuggestions>(await suggestions(owner, made.document_id));
    expect(Object.keys(proposal).sort()).toEqual(['identifier', 'issued', 'issued_by']);
    // The kind was chosen by a person: its dates are read surely.
    expect(proposal.issued?.confidence).toBe(0.9);
  });

  it('a page that says nothing of what it is proposes nothing, and a document with no file has nothing to read', async () => {
    const made = await capture(owner, { title: 'Scan' });
    await readPages(made, 'We met Sarah for lunch on 14 March 2031 and talked about the garden.');
    expect(json(await suggestions(owner, made.document_id))).toEqual({
      state: 'ready',
      proposal: {},
    });
    const bare = await send(owner, 'POST', '/api/v1/documents', { title: 'No file' });
    expect(json(await suggestions(owner, json<DocumentView>(bare).id))).toEqual({
      state: 'unavailable',
      proposal: {},
    });
    // A file the worker could not read, or would not: nothing to propose from.
    const skipped = await capture(owner, { title: 'Workbook' });
    await admin.query("update document_version set ocr_status = 'skipped' where id = $1", [
      skipped.version_id,
    ]);
    expect(json(await suggestions(owner, skipped.document_id))).toEqual({
      state: 'unavailable',
      proposal: {},
    });
  });

  it("an Only me document's suggestions are opened only for its owner", async () => {
    const made = await capture(sarah, { title: 'My passport', owner_member_id: sarah.member_id });
    await readPages(made, PASSPORT);
    // Made Only me: its words move behind Sarah's key, out of the index.
    const moved = await send(sarah, 'POST', `/api/v1/documents/${made.document_id}/visibility`, {
      visibility: 'private',
    });
    expect(moved.statusCode, moved.body).toBe(200);
    const plain = await admin.query('select 1 from document_text where version_id = $1', [
      made.version_id,
    ]);
    expect(plain.rows).toEqual([]);
    const sealed = await admin.query<{ content_cipher: Buffer }>(
      'select content_cipher from document_text_sealed where version_id = $1',
      [made.version_id],
    );
    expect(sealed.rows[0]?.content_cipher.toString('latin1')).not.toContain('533401872');

    // Sarah's own request opens them.
    const hers = json<DetailSuggestions>(await suggestions(sarah, made.document_id));
    expect(hers.state).toBe('ready');
    expect(hers.proposal.identifier?.value).toBe('533401872');
    expect(hers.proposal.expires?.value.date).toBe('2031-03-14');

    // Nobody else's: the owner of the household, another adult — answered
    // as for a document that does not exist, word for word.
    const absent = await suggestions(owner, randomUUID());
    for (const who of [owner, tariq]) {
      const asked = await suggestions(who, made.document_id);
      expect(asked.statusCode).toBe(404);
      expect(refusal(asked)).toEqual(refusal(absent));
    }
  });

  it('a viewer, limited or not, and a guest never get suggestions, even for a document they see', async () => {
    const made = await capture(owner, {
      title: 'Sarah’s passport',
      owner_member_id: sarah.member_id,
    });
    await readPages(made, PASSPORT);
    for (const [who, name] of [
      [uma, 'a viewer'],
      [vera, 'a limited viewer'],
      [jane, 'a guest'],
    ] as const) {
      // They see the document: the refusal is about the suggestions.
      expect((await get(who, `/api/v1/documents/${made.document_id}`)).statusCode, name).toBe(200);
      const asked = await suggestions(who, made.document_id);
      expect(asked.statusCode, name).toBe(403);
      // And it is the refusal any id gets, so it says nothing of this one.
      const absent = await suggestions(who, randomUUID());
      expect(absent.statusCode, name).toBe(403);
      expect(refusal(asked), name).toEqual(refusal(absent));
      expect(asked.body, name).not.toMatch(/533401872|SARAH|passport/i);
    }
  });

  it('a teen gets suggestions for their own documents only', async () => {
    const theirs = await capture(tariq, { title: 'My passport', owner_member_id: tariq.member_id });
    await readPages(theirs, PASSPORT.replace('SARAH', 'TARIQ'));
    const own = json<DetailSuggestions>(await suggestions(tariq, theirs.document_id));
    expect(own.state).toBe('ready');
    expect(own.proposal.type_key?.value).toBe('passport');
    const someoneElses = await capture(owner, { title: 'Scan', visibility: 'household' });
    await readPages(someoneElses, PASSPORT);
    const asked = await suggestions(tariq, someoneElses.document_id);
    expect(asked.statusCode).toBe(403);
  });

  it('no text, number or name read off the pages reaches the log, the audit or an error', async () => {
    const made = await capture(owner, { title: 'Scan' });
    await readPages(made, PASSPORT);
    logged.length = 0;
    const asked = await suggestions(owner, made.document_id);
    expect(json<DetailSuggestions>(asked).proposal.identifier?.value).toBe('533401872');
    await suggestions(uma, made.document_id);
    await suggestions(owner, randomUUID());
    expect(logged.length).toBeGreaterThan(0);
    const said = logged.join('\n');
    for (const secret of SECRETS) expect(said, secret).not.toContain(secret);
    const audit = await admin.query<{ text: string }>(
      `select coalesce(detail::text, '') || ' ' || action as text from audit_event where household_id = $1`,
      [owner.household_id],
    );
    for (const secret of SECRETS) {
      expect(audit.rows.map((r) => r.text).join('\n'), secret).not.toContain(secret);
    }
  });

  it('who issued it, by the old route, is still there for older phones', async () => {
    const made = await capture(owner, { title: 'Scan' });
    await readPages(made, PASSPORT);
    const r = await get(owner, `/api/v1/documents/${made.document_id}/issuer-suggestions`);
    expect(r.statusCode).toBe(200);
    expect(json<{ state: string }>(r).state).toBe('ready');
  });
});
