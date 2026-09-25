import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listMigrations, migrateUp } from './migrate.js';
import { createEmptyDatabase, testAdminUrl, type TestDatabase } from './testing.js';

/**
 * Migration 0025: who issued a document becomes a column of its own,
 * moved out of each type's own field (institution, provider, lender…) —
 * out of the document's extra and out of the type's field list, so the
 * value is kept in one place. The type keeps its word for it as a label.
 */
describe.skipIf(!testAdminUrl())("migration 0025: issued_by from the types' own fields", () => {
  let tdb: TestDatabase;
  let admin: pg.Pool;
  let dir: string;
  const hh = randomUUID();
  const ids = {
    statement: randomUUID(),
    bill: randomUUID(),
    passport: randomUUID(),
    blank: randomUUID(),
    lineBreaks: randomUUID(),
    whiteOnly: randomUUID(),
    notText: randomUUID(),
    tooLong: randomUUID(),
    otherType: randomUUID(),
  };
  let updatedBefore = new Map<string, string>();

  beforeAll(async () => {
    tdb = await createEmptyDatabase();
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    // 0.4.9's schema.
    dir = await mkdtemp(path.join(tmpdir(), 'fdv-0024-'));
    for (const m of await listMigrations()) {
      if (m.version <= 24) await copyFile(m.file, path.join(dir, path.basename(m.file)));
    }
    await migrateUp(admin, dir);

    await admin.query("insert into household (id, name) values ($1, 'Issuers')", [hh]);
    const doc = (id: string, type: string, extra: unknown, title: string) =>
      admin.query(
        `insert into document (id, household_id, type_key, title, extra, updated_at)
         values ($1, $2, $3, $4, $5::jsonb, now() - interval '3 days')`,
        [id, hh, type, title, JSON.stringify(extra)],
      );
    await doc(
      ids.statement,
      'bank_statement',
      { institution: '  Barclays   Bank UK ', account_last4: '1234' },
      'Current account',
    );
    await doc(ids.bill, 'utility_bill', { provider: 'British Gas', amount: '£52.10' }, 'Gas');
    await doc(ids.passport, 'passport', { issuing_country: 'United Kingdom' }, "Aisha's passport");
    await doc(ids.blank, 'loan', { lender: '   ' }, 'Mortgage');
    await doc(ids.lineBreaks, 'employment_contract', { employer: '\tAcme\n Widgets\r\n' }, 'Job');
    await doc(ids.whiteOnly, 'diploma', { institution: '\t\n' }, 'Degree');
    await doc(ids.notText, 'warranty', { vendor: 42 }, 'Fridge');
    await doc(ids.tooLong, 'insurance_policy', { insurer: 'x'.repeat(201) }, 'Home');
    await doc(ids.otherType, 'prescription', { prescriber: 'Dr Patel' }, 'Inhaler');
    updatedBefore = new Map(
      (
        await admin.query<{ id: string; updated_at: Date }>('select id, updated_at from document')
      ).rows.map((r) => [r.id, r.updated_at.toISOString()]),
    );
  }, 60_000);
  afterAll(async () => {
    await admin?.end();
    await tdb?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const row = async (id: string) =>
    (
      await admin.query<{ issued_by: string | null; extra: Record<string, unknown> }>(
        'select issued_by, extra from document where id = $1',
        [id],
      )
    ).rows[0];

  it('moves the issuer out of extra, tidied, and leaves the rest of extra alone', async () => {
    await migrateUp(admin);
    expect(await row(ids.statement)).toEqual({
      issued_by: 'Barclays Bank UK',
      extra: { account_last4: '1234' },
    });
    expect(await row(ids.bill)).toEqual({ issued_by: 'British Gas', extra: { amount: '£52.10' } });
    expect(await row(ids.passport)).toEqual({ issued_by: 'United Kingdom', extra: {} });
    // Tabs and line breaks too, at the ends as well as inside: as the API tidies.
    expect(await row(ids.lineBreaks)).toEqual({ issued_by: 'Acme Widgets', extra: {} });
  });

  it('leaves what does not fit where it was: blank, not text, too long, or another type', async () => {
    expect(await row(ids.blank)).toEqual({ issued_by: null, extra: { lender: '   ' } });
    expect(await row(ids.whiteOnly)).toEqual({ issued_by: null, extra: { institution: '\t\n' } });
    expect(await row(ids.notText)).toEqual({ issued_by: null, extra: { vendor: 42 } });
    expect((await row(ids.tooLong))?.issued_by).toBeNull();
    expect(await row(ids.otherType)).toEqual({
      issued_by: null,
      extra: { prescriber: 'Dr Patel' },
    });
  });

  it('gives each type its word for the issuer, and takes the field out of its list', async () => {
    const types = new Map(
      (
        await admin.query<{
          key: string;
          issued_by_label: string | null;
          fields: Array<{ key: string }>;
        }>('select key, issued_by_label, fields from document_type')
      ).rows.map((t) => [t.key, t]),
    );
    expect(types.get('bank_statement')?.issued_by_label).toBe('Institution');
    expect(types.get('utility_bill')?.issued_by_label).toBe('Provider');
    expect(types.get('passport')?.issued_by_label).toBe('Issuing country');
    expect(types.get('pet_record')?.issued_by_label).toBe('Vet');
    expect(types.get('birth_certificate')?.issued_by_label).toBeNull();
    expect(types.get('bank_statement')?.fields.map((f) => f.key)).toEqual([
      'account_last4',
      'period',
    ]);
    expect(types.get('utility_bill')?.fields.map((f) => f.key)).not.toContain('provider');
    expect(types.get('passport')?.fields.map((f) => f.key)).not.toContain('issuing_country');
  });

  it('search finds a document by who issued it', async () => {
    const hit = await admin.query<{ id: string }>(
      "select id from document where search_tsv @@ websearch_to_tsquery('simple', 'barclays')",
    );
    expect(hit.rows.map((r) => r.id)).toEqual([ids.statement]);
  });

  it("is nobody's edit: updated_at stays as it was", async () => {
    const after = (
      await admin.query<{ id: string; updated_at: Date }>('select id, updated_at from document')
    ).rows;
    for (const r of after) expect(r.updated_at.toISOString()).toBe(updatedBefore.get(r.id));
  });
});
