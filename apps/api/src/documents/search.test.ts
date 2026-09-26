import { randomUUID } from 'node:crypto';
import { withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { DocumentView } from '@fdv/shared';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';
import type { SearchHit } from './service.js';

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

/** The start of the test corpus: fifty varied household documents. */
const CORPUS: Array<{
  type_key: string;
  title: string;
  tags: string[];
  notes?: string;
  identifier?: string;
}> = [
  {
    type_key: 'insurance_policy',
    title: 'Home insurance policy',
    tags: ['house'],
    identifier: '4471-QB',
    notes: 'Renews every March',
  },
  {
    type_key: 'insurance_policy',
    title: 'Car insurance CR-V',
    tags: ['car'],
    identifier: 'CRV-2231',
  },
  { type_key: 'passport', title: "Mansoor's passport", tags: ['travel'], identifier: '563914782' },
  { type_key: 'passport', title: "Sana's passport", tags: ['travel'] },
  { type_key: 'birth_certificate', title: "Aisha's birth certificate", tags: [] },
  {
    type_key: 'vehicle_registration',
    title: 'CR-V registration',
    tags: ['car'],
    identifier: 'VIN 1HGCM82633A004352',
  },
  { type_key: 'tax_return', title: '2024 tax return', tags: ['tax', '2024'] },
  { type_key: 'tax_return', title: '2023 tax return', tags: ['tax', '2023'] },
  {
    type_key: 'utility_bill',
    title: 'Electricity bill September',
    tags: ['bills'],
    notes: 'Repeats monthly',
  },
  { type_key: 'medical_record', title: 'School immunisation record', tags: ['school', 'aisha'] },
];

describe.skipIf(!testAdminUrl())('search', () => {
  let h: Harness;
  let owner: Tokens;
  let policyId: string;

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();
    for (let i = 0; i < 50; i++) {
      const c = CORPUS[i % CORPUS.length] as (typeof CORPUS)[number];
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/documents',
        headers: h.as(owner),
        payload: {
          ...c,
          title: i < CORPUS.length ? c.title : `${c.title} (copy ${i})`,
          owner_member_id: owner.member_id,
        },
      });
      if (i === 0) policyId = res.json<DocumentView>().id;
    }
  }, 60_000);
  afterAll(() => h.close());

  const search = async (q: string, extra = '') =>
    h.app
      .inject({ url: `/api/v1/search?q=${encodeURIComponent(q)}${extra}`, headers: h.as(owner) })
      .then((r) => r.json<{ items: SearchHit[]; sealed_pending: { count: number } }>());

  it('finds by title words, identifier and tag, with a highlighted snippet', async () => {
    const byTitle = await search('home insurance');
    expect(byTitle.items[0]?.title).toMatch(/^Home insurance policy/);
    expect(byTitle.items.map((i) => i.document_id)).toContain(policyId);
    expect(byTitle.items[0]?.snippet).toContain('<em>');
    expect(byTitle.items[0]?.matched_in).toBe('title');

    const byId = await search('4471');
    expect(byId.items.map((i) => i.document_id)).toContain(policyId);

    const byTag = await search('aisha');
    expect(byTag.items.length).toBeGreaterThanOrEqual(2);
  });

  it('finds words that only exist inside the document (OCR text)', async () => {
    // Stand in for the worker: write OCR text for a version directly.
    const form = new FormData();
    form.append('file', PDF, { filename: 'policy.pdf', contentType: 'application/pdf' });
    const up = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${policyId}/versions`,
      headers: { ...h.as(owner), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    const versionId = up.json<{ id: string }>().id;
    expect(h.jobs.find((j) => j.name === 'version.process')?.data).toMatchObject({
      version_id: versionId,
    });

    await withSystem(h.db, owner.household_id, (trx) =>
      trx
        .insertInto('document_text')
        .values({
          version_id: versionId,
          household_id: owner.household_id,
          document_id: policyId,
          content:
            'Certificate of insurance. Policy number 4471-QB, effective from 4 March 2026. Excess 250.',
        })
        .execute(),
    );
    const hit = await search('effective excess');
    expect(hit.items[0]?.document_id).toBe(policyId);
    expect(hit.items[0]?.matched_in).toBe('content');
    expect(hit.items[0]?.snippet).toMatch(/<em>effective<\/em>|<em>Excess<\/em>/);
  });

  it('honours member and category filters and returns nothing for gibberish', async () => {
    const other = await withSystem(h.db, owner.household_id, (trx) =>
      trx
        .insertInto('member')
        .values({ household_id: owner.household_id, display_name: 'Nobody' })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    expect((await search('insurance', `&member_id=${other.id}`)).items).toEqual([]);
    expect((await search('insurance', '&category=insurance')).items.length).toBeGreaterThan(0);
    expect((await search('insurance', '&category=pets')).items).toEqual([]);
    expect((await search('zqxjkv')).items).toEqual([]);
  });

  it('answers in well under half a second across fifty documents (NFR-02)', async () => {
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) await search('tax return 2024');
    const avg = (performance.now() - t0) / 5;
    expect(avg).toBeLessThan(500);
  });
});
