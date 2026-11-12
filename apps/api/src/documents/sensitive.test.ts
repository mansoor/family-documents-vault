import { randomUUID } from 'node:crypto';
import { createDb, createPool, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  SENSITIVE_BY_DEFAULT,
  sensitiveOf,
  type BatchView,
  type Capabilities,
  type DocumentPage,
  type DocumentTypeView,
  type DocumentView,
  type SearchHit,
} from '@fdv/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * Sensitive (0.9.0, AIR2 of the AI readers plan, `features.sensitive_documents`):
 * each kind's Sensitive by default, per household, and each document's own
 * choice — null as its kind says, true, false. A kind's default changed
 * changes every document left on null; one set yes or no keeps it. An
 * older client's edit leaves it as it is. A teen may make a paper
 * sensitive, never not.
 */
describe.skipIf(!testAdminUrl())('Sensitive: per kind, per household, per document', () => {
  let h: Harness;
  let owner: Tokens;
  let teen: Tokens;
  let admin: ReturnType<typeof createPool>;
  let app: ReturnType<typeof createDb>;

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
  const ok = async <T>(url: string, who: Tokens = owner): Promise<T> => {
    const r = await call('GET', url, undefined, who);
    expect(r.statusCode, r.body).toBe(200);
    return json<T>(r);
  };
  const make = async (payload: Record<string, unknown>, who: Tokens = owner) => {
    const r = await call('POST', '/api/v1/documents', { visibility: 'household', ...payload }, who);
    expect(r.statusCode, r.body).toBe(201);
    return json<DocumentView>(r);
  };
  const patch = (d: DocumentView, payload: Record<string, unknown>, who: Tokens = owner) =>
    call('PATCH', `/api/v1/documents/${d.id}`, payload, who, { 'if-match': d.etag });
  const edit = async (d: DocumentView, payload: Record<string, unknown>, who: Tokens = owner) => {
    const r = await patch(d, payload, who);
    expect(r.statusCode, r.body).toBe(200);
    return json<DocumentView>(r);
  };
  const get = (d: { id: string }) => ok<DocumentView>(`/api/v1/documents/${d.id}`);
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
  const audit = async (action: string, objectId?: string) =>
    (
      await admin.query<{ detail: Record<string, unknown> }>(
        `select detail from audit_event where household_id = $1 and action = $2
            ${objectId ? 'and object_id = $3' : ''} order by id`,
        objectId ? [owner.household_id, action, objectId] : [owner.household_id, action],
      )
    ).rows.map((r) => r.detail);

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    owner = await h.setup();
    teen = await h.join(owner, { name: 'Tia', email: 'tia-sensitive@example.test', role: 'teen' });
    admin = createPool(h.adminUrl, 2);
    app = createDb(createPool(h.appUrl, 2));
  }, 120_000);

  afterAll(async () => {
    await admin?.end();
    await app?.destroy();
    await h?.close();
  });

  it('says so in its capabilities, and seeds each built-in as decision 5 says', async () => {
    const caps = await ok<Capabilities>('/api/v1/capabilities');
    expect(caps.features.sensitive_documents).toBe(true);
    const { rows } = await admin.query<{ key: string; sensitive_default: boolean }>(
      'select key, sensitive_default from document_type where household_id is null order by key',
    );
    expect(rows.length).toBeGreaterThan(20);
    // The migration and @fdv/shared's list say the same, kind for kind.
    expect(rows.filter((r) => r.sensitive_default).map((r) => r.key)).toEqual(
      [...SENSITIVE_BY_DEFAULT].sort(),
    );
    const kinds = (await ok<{ items: DocumentTypeView[] }>('/api/v1/document-types?all=true'))
      .items;
    for (const k of kinds) {
      expect(k.sensitive_default, k.key).toBe(SENSITIVE_BY_DEFAULT.includes(k.key));
    }
    for (const on of ['passport', 'medical_record', 'prescription', 'bank_statement', 'will']) {
      expect((await kind(on)).sensitive_default, on).toBe(true);
    }
    for (const off of ['utility_bill', 'insurance_policy', 'warranty', 'vehicle_registration']) {
      expect((await kind(off)).sensitive_default, off).toBe(false);
    }
  });

  it('a new document is as its kind says, or as it says itself', async () => {
    const passport = await make({ title: 'S passport', type_key: 'passport' });
    expect(passport).toMatchObject({ sensitive: null, sensitive_effective: true });
    const bill = await make({ title: 'S bill', type_key: 'utility_bill', extra: due });
    expect(bill).toMatchObject({ sensitive: null, sensitive_effective: false });
    const loud = await make({ title: 'S loud bill', type_key: 'utility_bill', sensitive: true });
    expect(loud).toMatchObject({ sensitive: true, sensitive_effective: true });
    const plain = await make({ title: 'S plain passport', type_key: 'passport', sensitive: false });
    expect(plain).toMatchObject({ sensitive: false, sensitive_effective: false });
    // No kind yet: sensitive, the safer answer, as sensitiveOf says.
    const scan = await make({ title: 'S scan' });
    expect(scan).toMatchObject({ sensitive: null, sensitive_effective: sensitiveOf(null, null) });
    expect(scan.sensitive_effective).toBe(true);
    const bad = await call('POST', '/api/v1/documents', { title: 'S bad', sensitive: 'yes' });
    expect(bad.statusCode).toBe(422);
  });

  it('an older client’s edit keeps it; yes, no and null change it, and the log says which', async () => {
    let bill = await make({ title: 'S kept bill', type_key: 'utility_bill', sensitive: true });
    // All an older client sends: the card without the field.
    bill = await edit(bill, { title: 'S kept bill 2027', owner_member_id: null });
    expect(bill).toMatchObject({ sensitive: true, sensitive_effective: true });
    bill = await edit(bill, { sensitive: false });
    expect(bill).toMatchObject({ sensitive: false, sensitive_effective: false });
    bill = await edit(bill, { sensitive: null });
    expect(bill).toMatchObject({ sensitive: null, sensitive_effective: false });
    bill = await edit(bill, { sensitive: true, title: 'S kept bill again' });
    // The same again changes nothing, and says nothing of it.
    bill = await edit(bill, { sensitive: true });
    const said = await audit('document.updated', bill.id);
    expect(said.map((d) => d.sensitive ?? null)).toEqual([null, 'no', 'as_kind', 'yes', null]);
  });

  it('a kind’s default changed changes every document left as its kind says, and no other', async () => {
    const left = await make({ title: 'S warranty left', type_key: 'warranty' });
    const yes = await make({ title: 'S warranty yes', type_key: 'warranty', sensitive: true });
    const no = await make({ title: 'S warranty no', type_key: 'warranty', sensitive: false });
    expect(left.sensitive_effective).toBe(false);
    const before = await kind('warranty');
    const after = await changeKind('warranty', { sensitive_default: true });
    expect(after.sensitive_default).toBe(true);
    expect(after.etag).not.toBe(before.etag);
    // A change made to the kind as it was is refused.
    const stale = await call(
      'PATCH',
      '/api/v1/document-types/warranty',
      { sensitive_default: false },
      owner,
      { 'if-match': before.etag as string },
    );
    expect(stale.statusCode).toBe(409);
    expect((await get(left)).sensitive_effective).toBe(true);
    expect((await get(yes)).sensitive_effective).toBe(true);
    expect((await get(no)).sensitive_effective).toBe(false);
    // Nothing was written to the documents: worked out, not rewritten.
    const { rows } = await admin.query<{ sensitive: boolean | null }>(
      'select sensitive from document where id = $1',
      [left.id],
    );
    expect(rows).toEqual([{ sensitive: null }]);
    expect((await audit('document_type.updated')).at(-1)).toMatchObject({
      key: 'warranty',
      fields: ['sensitive_default'],
      sensitive_default: true,
    });

    // Another household's warranty is the built-in's, untouched.
    const other = randomUUID();
    await admin.query("insert into household (id, name) values ($1, 'Next door')", [other]);
    const theirs = await withSystem(app, other, (trx) =>
      trx
        .selectFrom('effective_document_type')
        .select(['key', 'sensitive_default'])
        .where('key', '=', 'warranty')
        .executeTakeFirstOrThrow(),
    );
    expect(theirs.sensitive_default).toBe(false);
    const built = await admin.query<{ sensitive_default: boolean }>(
      "select sensitive_default from document_type where key = 'warranty'",
    );
    expect(built.rows).toEqual([{ sensitive_default: false }]);

    await changeKind('warranty', { sensitive_default: false });
    expect((await get(left)).sensitive_effective).toBe(false);
    expect((await get(yes)).sensitive_effective).toBe(true);
  });

  it('a kind the household makes starts sensitive, unless it says otherwise', async () => {
    const made = await call('POST', '/api/v1/document-types', {
      label: 'S allotment lease',
      category: 'property',
    });
    expect(made.statusCode, made.body).toBe(201);
    const lease = json<DocumentTypeView>(made);
    expect(lease.sensitive_default).toBe(true);
    const doc = await make({ title: 'S lease', type_key: lease.key });
    expect(doc.sensitive_effective).toBe(true);
    expect((await changeKind(lease.key, { sensitive_default: false })).sensitive_default).toBe(
      false,
    );
    expect((await get(doc)).sensitive_effective).toBe(false);
    const quiet = await call('POST', '/api/v1/document-types', {
      label: 'S garden plan',
      category: 'property',
      sensitive_default: false,
    });
    expect(json<DocumentTypeView>(quiet).sensitive_default).toBe(false);
  });

  it('a teen may make their papers sensitive, never not', async () => {
    const refused = await call(
      'POST',
      '/api/v1/documents',
      { title: 'S teen plain', type_key: 'passport', sensitive: false },
      teen,
    );
    expect(refused.statusCode).toBe(403);
    expect(json<{ error: { detail?: string } }>(refused).error.detail).toBe('sensitive');
    let mine = await make({ title: 'S teen bill', type_key: 'utility_bill' }, teen);
    expect(mine.sensitive_effective).toBe(false);
    mine = await edit(mine, { sensitive: true }, teen);
    expect(mine.sensitive_effective).toBe(true);
    // Back to its kind's word, which is no: refused.
    expect((await patch(mine, { sensitive: null }, teen)).statusCode).toBe(403);
    expect((await patch(mine, { sensitive: false }, teen)).statusCode).toBe(403);
    // A passport left as its kind says is still sensitive: allowed.
    let passport = await make(
      { title: 'S teen passport', type_key: 'passport', sensitive: true },
      teen,
    );
    passport = await edit(passport, { sensitive: null }, teen);
    expect(passport).toMatchObject({ sensitive: null, sensitive_effective: true });
    // An adult may.
    passport = await get(passport);
    expect((await edit(passport, { sensitive: false })).sensitive_effective).toBe(false);
    // The same value again is no change: a teen's whole card still saves.
    passport = await get(passport);
    const r = await patch(passport, { sensitive: false, title: 'S teen passport, again' }, teen);
    expect(r.statusCode, r.body).toBe(200);
  });

  it('filters: sensitive or not, all said, on the table, the older list and search', async () => {
    await make({ title: 'Zsens passport', type_key: 'passport' });
    await make({ title: 'Zsens bill', type_key: 'utility_bill', extra: due });
    await make({ title: 'Zsens loud bill', type_key: 'utility_bill', sensitive: true });
    await make({ title: 'Zsens plain will', type_key: 'will', sensitive: false });
    await make({ title: 'Zsens scan' });
    const table = async (q: string) =>
      titles(
        (await ok<DocumentPage>(`/api/v1/documents?sort=title&limit=200${q}`)).items.filter((d) =>
          d.title?.startsWith('Zsens'),
        ),
      );
    const yes = ['Zsens loud bill', 'Zsens passport', 'Zsens scan'];
    const no = ['Zsens bill', 'Zsens plain will'];
    expect(await table('&sensitive=yes')).toEqual(yes);
    expect(await table('&sensitive=no')).toEqual(no);
    expect(await table('&sensitive=yes,no')).toEqual([...yes, ...no].sort());
    // Each row's own word agrees with the filter: one rule.
    for (const d of (await ok<DocumentPage>('/api/v1/documents?sort=title&limit=200')).items) {
      if (!d.title?.startsWith('Zsens')) continue;
      expect(d.sensitive_effective, d.title).toBe(yes.includes(d.title));
    }
    const older = titles(
      (await ok<DocumentPage>('/api/v1/documents?sensitive=no&limit=200')).items.filter((d) =>
        d.title?.startsWith('Zsens'),
      ),
    );
    expect(older).toEqual(no);
    const search = async (q: string) =>
      titles((await ok<{ items: SearchHit[] }>(`/api/v1/search?q=zsens${q}`)).items);
    expect(await search('&sensitive=yes')).toEqual(yes);
    expect(await search('&sensitive=no')).toEqual(no);
    const hit = (await ok<{ items: SearchHit[] }>('/api/v1/search?q=zsens')).items.find(
      (i) => i.title === 'Zsens plain will',
    );
    expect(hit).toMatchObject({ sensitive: false, sensitive_effective: false });
    const bad = await call('GET', '/api/v1/documents?sort=title&sensitive=maybe');
    expect(bad.statusCode).toBe(422);
    expect(json<{ error: { detail?: string } }>(bad).error.detail).toBe('sensitive');
  });

  it('a batch’s default: kept and shown, and never "no" from a teen', async () => {
    const made = await call('POST', '/api/v1/batches', {
      name: 'S papers',
      defaults: { sensitive: true },
    });
    expect(made.statusCode, made.body).toBe(201);
    const b = json<BatchView>(made);
    expect(b.defaults.sensitive).toBe(true);
    const changed = await call('PATCH', `/api/v1/batches/${b.id}`, {
      defaults: { sensitive: null },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(json<BatchView>(changed).defaults.sensitive).toBeNull();
    const theirs = await call(
      'POST',
      '/api/v1/batches',
      { name: 'S teen papers', defaults: { sensitive: false } },
      teen,
    );
    expect(theirs.statusCode).toBe(403);
  });
});

const due = { due_date: { date: '2027-03-01', precision: 'day' } };
