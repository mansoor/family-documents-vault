import { createPool } from '@fdv/db';
import type { DocumentTypeView, DocumentView, SearchResult, Tokens } from '@fdv/shared';
import FormData from 'form-data';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * Iteration 4.3c: who issued a document is a field of its own. It is kept
 * as typed (tidied), shown on the document, listed as the household's
 * issuers, matched and filtered by search, and suggested from the pages —
 * and everywhere it is exactly as private as the document's title.
 */

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

const BARCLAYS_LETTER = [
  'Barclays Bank UK PLC',
  'Mrs Farah Seikh',
  '12 Acacia Avenue',
  'Leeds LS6 2AB',
  'Your statement',
  '1 September 2026 to 30 September 2026',
  'Sort code 20-00-00 Account number 12345678',
  'Balance £1,234.56',
  'barclays.co.uk',
  '',
  'Barclays Bank UK PLC. Registered in England.',
].join('\n');

describe('issued by', () => {
  let h: Harness;
  let owner: Tokens;
  let adult: Tokens;
  let teen: Tokens;
  let admin: ReturnType<typeof createPool>;

  const json = <T>(r: { json: () => unknown }) => r.json() as T;
  const as = (t: Tokens) => h.as(t);

  const make = async (who: Tokens, body: Record<string, unknown>) => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: as(who),
      payload: body,
    });
    expect(res.statusCode, res.body).toBe(201);
    return json<DocumentView>(res);
  };
  const capture = async (who: Tokens, metadata: Record<string, unknown>) => {
    const form = new FormData();
    form.append('metadata', JSON.stringify(metadata));
    form.append('file', PDF, { filename: 'scan.pdf', contentType: 'application/pdf' });
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/capture',
      headers: { ...as(who), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    expect(res.statusCode, res.body).toBe(201);
    return json<{ document_id: string; version_id: string }>(res);
  };
  /** The pages read: what the worker would store once it has OCRed them. */
  const readPages = async (versionId: string, documentId: string, content: string) => {
    await admin.query(
      'insert into document_text (version_id, household_id, document_id, content) values ($1, $2, $3, $4)',
      [versionId, owner.household_id, documentId, content],
    );
    await admin.query("update document_version set ocr_status = 'done' where id = $1", [versionId]);
  };
  const get = (who: Tokens, url: string) => h.app.inject({ method: 'GET', url, headers: as(who) });

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

  it('is kept as typed, tidied: blank is nothing, and over 200 characters is refused', async () => {
    const d = await make(owner, { title: 'Current account', issued_by: '  Barclays   Bank UK  ' });
    expect(d.issued_by).toBe('Barclays Bank UK');
    const patched = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/documents/${d.id}`,
      headers: as(owner),
      payload: { issued_by: '   ' },
    });
    expect(json<DocumentView>(patched).issued_by).toBeNull();
    const long = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/documents/${d.id}`,
      headers: as(owner),
      payload: { issued_by: 'x'.repeat(201) },
    });
    expect(long.statusCode).toBe(422);
  });

  it('each type says what its issuer is called, and no longer lists it as a field', async () => {
    const types = json<{ items: DocumentTypeView[] }>(
      await get(owner, '/api/v1/document-types'),
    ).items;
    const by = (k: string) => types.find((t) => t.key === k);
    expect(by('bank_statement')?.issued_by_label).toBe('Institution');
    expect(by('insurance_policy')?.issued_by_label).toBe('Insurer');
    expect(by('birth_certificate')?.issued_by_label).toBeNull();
    expect(by('bank_statement')?.fields.map((f) => f.key)).not.toContain('institution');
  });

  it('a capture carries it, and the list filters by it whatever the case', async () => {
    const a = await capture(owner, { type_key: 'utility_bill', issued_by: 'British Gas' });
    await capture(owner, { type_key: 'utility_bill', issued_by: 'Octopus Energy' });
    const listed = json<{ items: DocumentView[] }>(
      await get(owner, '/api/v1/documents?issued_by=british%20gas'),
    );
    expect(listed.items.map((d) => d.id)).toEqual([a.document_id]);
  });

  it('search finds a document by its issuer, filters by it, and says who issued it and when', async () => {
    const d = await make(owner, {
      title: 'Joint account',
      type_key: 'bank_statement',
      issued_by: 'Nationwide',
      issued: { date: '2026-09-30', precision: 'day' },
    });
    await make(owner, { title: 'Joint account', type_key: 'bank_statement', issued_by: 'Monzo' });
    const found = json<SearchResult>(await get(owner, '/api/v1/search?q=nationwide'));
    expect(found.items.map((i) => i.document_id)).toEqual([d.id]);
    expect(found.items[0]).toMatchObject({
      issued_by: 'Nationwide',
      issued: { date: '2026-09-30', precision: 'day' },
    });
    expect(found.items[0]?.snippet).toContain('<em>Nationwide</em>');
    const filtered = json<SearchResult>(await get(owner, '/api/v1/search?q=joint&issued_by=monzo'));
    expect(filtered.items.map((i) => i.issued_by)).toEqual(['Monzo']);
  });

  it("GET /issuers lists the household's issuers — only those the caller can see — spelled as used most", async () => {
    await make(owner, { title: 'A', issued_by: 'Halifax' });
    await make(owner, { title: 'B', issued_by: 'Halifax' });
    await make(owner, { title: 'C', issued_by: 'HALIFAX' });
    // The owner's own: Only me, and Adults only.
    await make(owner, {
      title: 'Therapy',
      issued_by: 'Quiet Mind Clinic',
      owner_member_id: owner.member_id,
      visibility: 'private',
    });
    await make(owner, { title: 'Payslip', issued_by: 'Acme Payroll', visibility: 'adults' });

    const mine = json<{ items: Array<{ issued_by: string; count: number }> }>(
      await get(owner, '/api/v1/issuers'),
    ).items;
    expect(mine).toContainEqual({ issued_by: 'Halifax', count: 3 });
    expect(mine.map((i) => i.issued_by)).toEqual(
      expect.arrayContaining(['Quiet Mind Clinic', 'Acme Payroll']),
    );

    const alexs = json<{ items: Array<{ issued_by: string }> }>(
      await get(adult, '/api/v1/issuers'),
    ).items;
    expect(alexs.map((i) => i.issued_by)).not.toContain('Quiet Mind Clinic');
    expect(alexs.map((i) => i.issued_by)).toContain('Acme Payroll');

    const sams = json<{ items: Array<{ issued_by: string }> }>(
      await get(teen, '/api/v1/issuers'),
    ).items;
    expect(sams.map((i) => i.issued_by)).not.toContain('Quiet Mind Clinic');
    expect(sams.map((i) => i.issued_by)).not.toContain('Acme Payroll');

    // A prefix narrows it; % and _ are letters there, not wildcards.
    const hal = json<{ items: Array<{ issued_by: string }> }>(
      await get(owner, '/api/v1/issuers?q=hal'),
    ).items;
    expect(hal.map((i) => i.issued_by)).toEqual(['Halifax']);
    expect(json<{ items: unknown[] }>(await get(owner, '/api/v1/issuers?q=%25')).items).toEqual([]);
  });

  it('with a type, only the issuers used for that type', async () => {
    await make(owner, { title: 'Pension', type_key: 'bank_statement', issued_by: 'Aegon' });
    const items = json<{ items: Array<{ issued_by: string }> }>(
      await get(owner, '/api/v1/issuers?type_key=bank_statement'),
    ).items.map((i) => i.issued_by);
    expect(items).toContain('Aegon');
    expect(items).toContain('Nationwide');
    // Halifax was never on a bank statement here.
    expect(items).not.toContain('Halifax');
  });

  it('suggestions wait for the pages, then offer who the letterhead says — never filled in', async () => {
    const c = await capture(owner, { type_key: 'bank_statement' });
    const pending = await get(owner, `/api/v1/documents/${c.document_id}/issuer-suggestions`);
    expect(pending.headers['cache-control']).toBe('no-store');
    expect(json(pending)).toEqual({ state: 'pending', items: [] });

    await readPages(c.version_id, c.document_id, BARCLAYS_LETTER);
    const ready = json<{ state: string; items: Array<{ value: string; source: string }> }>(
      await get(owner, `/api/v1/documents/${c.document_id}/issuer-suggestions`),
    );
    expect(ready.state).toBe('ready');
    expect(ready.items[0]?.value).toMatch(/^Barclays/);
    // Offered, not filled in.
    const doc = json<DocumentView>(await get(owner, `/api/v1/documents/${c.document_id}`));
    expect(doc.issued_by).toBeNull();
  });

  it("a private document's pages are read for its owner only, and a viewer cannot ask", async () => {
    const c = await capture(owner, {
      type_key: 'bank_statement',
      owner_member_id: owner.member_id,
    });
    await readPages(c.version_id, c.document_id, BARCLAYS_LETTER);
    // Made private: its page text moves behind the owner's key.
    const moved = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${c.document_id}/visibility`,
      headers: as(owner),
      payload: { visibility: 'private' },
    });
    expect(moved.statusCode).toBe(200);
    const theirs = json<{ state: string; items: Array<{ value: string }> }>(
      await get(owner, `/api/v1/documents/${c.document_id}/issuer-suggestions`),
    );
    expect(theirs.state).toBe('ready');
    expect(theirs.items[0]?.value).toMatch(/^Barclays/);
    expect(
      (await get(adult, `/api/v1/documents/${c.document_id}/issuer-suggestions`)).statusCode,
    ).toBe(404);
  });

  it('a document with no pages read yet, and no file at all, says so', async () => {
    const d = await make(owner, { title: 'No file', type_key: 'bank_statement' });
    expect(json(await get(owner, `/api/v1/documents/${d.id}/issuer-suggestions`))).toEqual({
      state: 'unavailable',
      items: [],
    });
  });
});
