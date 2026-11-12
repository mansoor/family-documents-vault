import { testAdminUrl } from '@fdv/db/testing';
import type {
  Capabilities,
  DocumentPage,
  DocumentTypeView,
  DocumentView,
  SearchHit,
} from '@fdv/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * The household, and what each kind usually belongs to (0.9.0, the owner's
 * decisions of 11 Nov 2026, `features.household_owner`): a document is the
 * household's, a person's, or Not sure yet — and only Not sure yet reads
 * Needs a person. Each kind says whom its documents usually belong to, and
 * a new one follows it. An older client's `owner_member_id: null` never
 * turns the household's into Not sure yet.
 */
describe.skipIf(!testAdminUrl())('the household as a document’s owner', () => {
  let h: Harness;
  let owner: Tokens;
  let teen: Tokens;

  const json = <T>(r: { json: () => unknown }) => r.json() as T;
  const call = (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: Record<string, unknown>,
    who: Tokens = owner,
    headers: Record<string, string> = {},
  ) =>
    h.app.inject({
      method,
      url,
      headers: { ...h.as(who), ...headers },
      ...(payload ? { payload } : {}),
    });
  const ok = async <T>(url: string): Promise<T> => {
    const r = await call('GET', url);
    expect(r.statusCode, r.body).toBe(200);
    return json<T>(r);
  };
  const make = async (payload: Record<string, unknown>, who: Tokens = owner) => {
    const r = await call('POST', '/api/v1/documents', { visibility: 'household', ...payload }, who);
    expect(r.statusCode, r.body).toBe(201);
    return json<DocumentView>(r);
  };
  const edit = async (d: DocumentView, payload: Record<string, unknown>) => {
    const r = await call('PATCH', `/api/v1/documents/${d.id}`, payload, owner, {
      'if-match': d.etag,
    });
    expect(r.statusCode, r.body).toBe(200);
    return json<DocumentView>(r);
  };
  const kind = async (key: string) =>
    (await ok<{ items: DocumentTypeView[] }>('/api/v1/document-types?all=true')).items.find(
      (t) => t.key === key,
    ) as DocumentTypeView;
  const changeKind = async (key: string, payload: Record<string, unknown>) => {
    const before = await kind(key);
    const r = await call('PATCH', `/api/v1/document-types/${key}`, payload, owner, {
      'if-match': before.etag as string,
    });
    expect(r.statusCode, r.body).toBe(200);
    return json<DocumentTypeView>(r);
  };
  const titles = (docs: { title: string | null }[]) => docs.map((d) => d.title).sort();
  const due = { due_date: { date: '2027-03-01', precision: 'day' } };

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    owner = await h.setup();
    teen = await h.join(owner, { name: 'Tia', email: 'tia-household@example.test', role: 'teen' });
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  it('says so in its capabilities, and each kind says whom it belongs to', async () => {
    const caps = await ok<Capabilities>('/api/v1/capabilities');
    expect(caps.features.household_owner).toBe(true);
    const bill = await kind('utility_bill');
    expect(bill).toMatchObject({
      belongs_to: 'household',
      expiry_driver: null,
      remind_from: 'due_date',
      remind_leads: [7, 1],
    });
    expect(bill.core?.expires.shown).toBe(false);
    expect(bill.fields.map((f) => [f.key, f.label, f.required])).toEqual([
      ['account', 'Account', false],
      ['amount', 'Bill amount', false],
      ['due_date', 'Due date', true],
    ]);
    expect((await kind('property_deed')).belongs_to).toBe('household');
    expect((await kind('pet_record')).belongs_to).toBe('household');
    expect((await kind('passport')).belongs_to).toBe('person');
  });

  it('a new document of a household’s kind is the household’s, and never Needs a person', async () => {
    const bill = await make({ title: 'Gas bill', type_key: 'utility_bill', extra: due });
    expect(bill).toMatchObject({ owner_member_id: null, household_owned: true });
    expect(bill.status.value).toBe('valid');
    // Without its due date, it needs that — not a person.
    const undated = await make({ title: 'Water bill', type_key: 'utility_bill' });
    expect(undated.status).toEqual({ value: 'needs_info', label: 'Needs a due date' });
    // Somebody chosen: theirs.
    const theirs = await make({
      title: 'Phone bill',
      type_key: 'utility_bill',
      owner_member_id: owner.member_id,
      extra: due,
    });
    expect(theirs).toMatchObject({ owner_member_id: owner.member_id, household_owned: false });
    // Not sure yet, asked for.
    const unsure = await make({
      title: 'Odd bill',
      type_key: 'utility_bill',
      household_owned: false,
      extra: due,
    });
    expect(unsure).toMatchObject({ owner_member_id: null, household_owned: false });
    expect(unsure.status.label).toBe('Needs a person');
  });

  it('a person’s kind with nobody is Not sure yet, as before, unless the household is chosen', async () => {
    const passport = await make({ title: 'Lost passport', type_key: 'passport' });
    expect(passport.household_owned).toBe(false);
    expect(passport.status.label).toBe('Needs a person');
    const ours = await make({
      title: 'Family passport folder',
      type_key: 'passport',
      household_owned: true,
    });
    expect(ours).toMatchObject({ owner_member_id: null, household_owned: true });
    expect(ours.status.label).not.toBe('Needs a person');
    const both = await call('POST', '/api/v1/documents', {
      title: 'Both',
      type_key: 'passport',
      owner_member_id: owner.member_id,
      household_owned: true,
    });
    expect(both.statusCode).toBe(422);
    expect(json<{ error: { detail?: string } }>(both).error.detail).toBe('household_owned');
  });

  it('an older client’s edit keeps the household’s the household’s; a person or false changes it', async () => {
    let bill = await make({ title: 'Council tax', type_key: 'utility_bill', extra: due });
    // All an older phone sends: the person, null, with the rest of the card.
    bill = await edit(bill, { title: 'Council tax 2027', owner_member_id: null });
    expect(bill).toMatchObject({ household_owned: true, owner_member_id: null });
    bill = await edit(bill, { owner_member_id: owner.member_id });
    expect(bill).toMatchObject({ household_owned: false, owner_member_id: owner.member_id });
    bill = await edit(bill, { household_owned: true });
    expect(bill).toMatchObject({ household_owned: true, owner_member_id: null });
    bill = await edit(bill, { household_owned: false });
    expect(bill).toMatchObject({ household_owned: false, owner_member_id: null });
    expect(bill.status.label).toBe('Needs a person');
  });

  it('a teen’s documents are their own: never the household’s', async () => {
    const asked = await call(
      'POST',
      '/api/v1/documents',
      { title: 'Mine', type_key: 'utility_bill', household_owned: true },
      teen,
    );
    expect(asked.statusCode).toBe(403);
    // Left out, a household's kind is still theirs.
    const theirs = await make({ title: 'Tia’s phone bill', type_key: 'utility_bill' }, teen);
    expect(theirs).toMatchObject({ owner_member_id: teen.member_id, household_owned: false });
  });

  it('filters: the household’s, and Not sure yet, on the table and in search', async () => {
    await make({ title: 'Zeta household deed', type_key: 'property_deed' });
    await make({ title: 'Zeta unsure licence', type_key: 'drivers_licence' });
    await make({
      title: 'Zeta my licence',
      type_key: 'drivers_licence',
      owner_member_id: owner.member_id,
    });
    const table = async (member: string) =>
      titles(
        (
          await ok<DocumentPage>(
            `/api/v1/documents?sort=title&limit=100&member_id=${encodeURIComponent(member)}`,
          )
        ).items.filter((d) => d.title?.startsWith('Zeta')),
      );
    expect(await table('household')).toEqual(['Zeta household deed']);
    expect(await table('none')).toEqual(['Zeta unsure licence']);
    expect(await table(`household,${owner.member_id}`)).toEqual([
      'Zeta household deed',
      'Zeta my licence',
    ]);
    // The older list takes neither, as it never took `none`.
    expect((await call('GET', '/api/v1/documents?member_id=household')).statusCode).toBe(422);

    const search = async (member: string) =>
      titles(
        (
          await ok<{ items: SearchHit[] }>(
            `/api/v1/search?q=zeta&member_id=${encodeURIComponent(member)}`,
          )
        ).items,
      );
    expect(await search('household')).toEqual(['Zeta household deed']);
    expect(await search('none')).toEqual(['Zeta unsure licence']);
    expect(await search(`none,${owner.member_id}`)).toEqual([
      'Zeta my licence',
      'Zeta unsure licence',
    ]);
    const hit = (await ok<{ items: SearchHit[] }>('/api/v1/search?q=zeta')).items.find(
      (i) => i.title === 'Zeta household deed',
    );
    expect(hit?.household_owned).toBe(true);
    expect((await call('GET', '/api/v1/search?q=zeta&member_id=nobody')).statusCode).toBe(422);
  });

  it('a kind’s belongs_to is changed with its ETag, and a new document follows it', async () => {
    const before = await kind('warranty');
    const after = await changeKind('warranty', { belongs_to: 'household' });
    expect(after.belongs_to).toBe('household');
    expect(after.etag).not.toBe(before.etag);
    // A change made to the kind as it was is refused.
    const stale = await call(
      'PATCH',
      '/api/v1/document-types/warranty',
      { belongs_to: 'person' },
      owner,
      {
        'if-match': before.etag as string,
      },
    );
    expect(stale.statusCode).toBe(409);
    const boiler = await make({ title: 'Boiler warranty', type_key: 'warranty' });
    expect(boiler.household_owned).toBe(true);
    // A document filed already keeps whose it is.
    expect((await changeKind('warranty', { belongs_to: 'person' })).belongs_to).toBe('person');
    expect((await ok<DocumentView>(`/api/v1/documents/${boiler.id}`)).household_owned).toBe(true);
    // The household's own kind, too.
    const made = await call('POST', '/api/v1/document-types', {
      label: 'Allotment lease',
      category: 'property',
      belongs_to: 'household',
    });
    expect(made.statusCode, made.body).toBe(201);
    const allotment = json<DocumentTypeView>(made);
    expect(allotment.belongs_to).toBe('household');
    expect((await changeKind(allotment.key, { belongs_to: 'person' })).belongs_to).toBe('person');
    const bad = await call('PATCH', `/api/v1/document-types/${allotment.key}`, {
      belongs_to: 'family',
    });
    expect(bad.statusCode).toBe(422);
  });

  it('renames any field of a kind, a built-in’s own fields too, and back to the app’s word', async () => {
    let bill = await changeKind('utility_bill', {
      core: { identifier: { label: 'Reference' }, notes: { label: 'Remarks' } },
      fields: [
        { key: 'account', label: 'Customer number' },
        { key: 'amount' },
        { key: 'due_date' },
      ],
    });
    expect(bill.core?.identifier.label).toBe('Reference');
    expect(bill.core?.notes.label).toBe('Remarks');
    expect(bill.fields.map((f) => [f.key, f.label])).toEqual([
      ['account', 'Customer number'],
      ['amount', 'Bill amount'],
      ['due_date', 'Due date'],
    ]);
    // Its documents keep their details under the same keys.
    const filed = await make({
      title: 'Electricity',
      type_key: 'utility_bill',
      extra: { ...due, account: 'A-1' },
    });
    expect(filed.extra).toMatchObject({ account: 'A-1' });
    // Back to the app's own words: null for a fixed field, the library's for its own.
    bill = await changeKind('utility_bill', {
      core: { identifier: { label: null }, notes: { label: null } },
      fields: [{ key: 'account', label: 'Account' }, { key: 'amount' }, { key: 'due_date' }],
    });
    expect(bill.core?.identifier.label).toBeNull();
    expect(bill.core?.notes.label).toBeNull();
    expect(bill.fields[0]?.label).toBe('Account');
    // Every other household still has the built-in as it was: the change is this one's.
    expect(bill.belongs_to).toBe('household');
  });
});
