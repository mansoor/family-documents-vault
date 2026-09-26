import { randomBytes, randomUUID } from 'node:crypto';
import {
  createDb,
  createPool,
  withPrincipal,
  withScope,
  withSystem,
  type Db,
  type Role,
} from '@fdv/db';
import type { DocumentAttributeView, DocumentTypeView, DocumentView, Tokens } from '@fdv/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * Document types belong to the household (5.7).
 *
 * The built-in types are everybody's to read and nobody's to change. A
 * household's own types, its changes to the built-ins and its own fields
 * are its own, behind the same wall as its documents: a type's name can
 * say a lot ("Immigration case").
 *
 * Household B is the vault's (set up through the API); household A is
 * another, put in beside it as the owning role. What the database gives is
 * asked as the application role — the view is security_invoker, so asking
 * as its owner would prove nothing — on a pool of one connection, so a
 * transaction that sets nothing gets the connection another has used.
 */

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** A household's own key: 'h_' and ten base32 characters (0031). */
const ownKey = () => `h_${[...randomBytes(10)].map((b) => BASE32[b % 32]).join('')}`;

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n');
const BOUNDARY = 'fdv-household-types-boundary';

describe('document types belong to the household', () => {
  let h: Harness;
  let owner: Tokens;
  let admin: ReturnType<typeof createPool>;
  /** The application role, one connection. */
  let one: Db;
  let B: string;
  let ownerPrincipal: { householdId: string; accountId: string; memberId: string; role: Role };
  const A = randomUUID();
  const typeA = ownKey();
  const fieldA = ownKey();
  const typeB = ownKey();
  const unusedB = ownKey();
  const fieldB = ownKey();

  const json = <T>(r: { json: () => unknown }) => r.json() as T;
  const get = (url: string) => h.app.inject({ method: 'GET', url, headers: h.as(owner) });
  const send = (method: 'POST' | 'PATCH', url: string, payload: unknown) =>
    h.app.inject({ method, url, headers: h.as(owner), payload: payload as object });
  const refusal = (r: { json: () => unknown }) => json<{ error: { message: string } }>(r).error;

  /** A capture with the card's details, sent before the file. */
  const capture = (metadata: unknown) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/capture',
      headers: {
        ...h.as(owner),
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
        'idempotency-key': randomUUID(),
      },
      payload: Buffer.concat([
        Buffer.from(
          `--${BOUNDARY}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(metadata)}\r\n`,
        ),
        Buffer.from(
          `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="scan.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
        ),
        PDF,
        Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
      ]),
    });

  const documentCount = async (household: string) =>
    (
      await admin.query<{ n: number }>(
        'select count(*)::int as n from document where household_id = $1',
        [household],
      )
    ).rows[0]?.n;

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();
    B = owner.household_id;
    admin = createPool(h.adminUrl, 2);
    one = createDb(createPool(h.appUrl, 1));
    const me = await admin.query<{ account_id: string }>(
      'select account_id from account_household where household_id = $1',
      [B],
    );
    ownerPrincipal = {
      householdId: B,
      accountId: me.rows[0]?.account_id as string,
      memberId: owner.member_id,
      role: 'owner',
    };

    // Household A: a type of its own, a field of its own, and its own
    // change to the passport.
    await admin.query("insert into household (id, name) values ($1, 'The A family')", [A]);
    await admin.query(
      `insert into document_type (key, label, category, household_id, fields)
       values ($1, 'Immigration case', 'legal', $2, $3)`,
      [
        typeA,
        A,
        JSON.stringify([{ key: fieldA, label: 'Case number', kind: 'text', required: true }]),
      ],
    );
    await admin.query(
      "insert into document_attribute (household_id, key, label, kind) values ($1, $2, 'Case number', 'text')",
      [A, fieldA],
    );
    await admin.query(
      `insert into document_type_setting (household_id, type_key, hidden, reminder_leads)
       values ($1, 'passport', true, '{7}')`,
      [A],
    );

    // Household B: two types of its own and a field.
    await admin.query(
      `insert into document_type
         (key, label, category, household_id, short_label, issuer_noun, core)
       values ($1, 'Pension statement from a former employer', 'financial', $2,
               'Pension statement', 'pension statement', '{"identifier": {"label": "Plan number"}}'),
              ($3, 'Allotment tenancy', 'property', $2, null, null, '{}')`,
      [typeB, B, unusedB],
    );
    await admin.query(
      `insert into document_attribute (household_id, key, label, kind, choices)
       values ($1, $2, 'Plan type', 'choice', '{Defined benefit,Defined contribution}')`,
      [B, fieldB],
    );
  }, 120_000);

  afterAll(async () => {
    await one?.destroy();
    await admin?.end();
    await h?.close();
  });

  /** What a transaction is given of the types, the settings and the library. */
  const given = async (trx: Db) =>
    (
      await sql<{
        own: string[];
        builtins: number;
        settings: number;
        fields: string[];
        effective: string[];
        passport_hidden: boolean;
      }>`select
        array(select key from document_type where household_id is not null order by key) as own,
        (select count(*)::int from document_type where household_id is null) as builtins,
        (select count(*)::int from document_type_setting) as settings,
        array(select key from document_attribute where household_id is not null order by key) as fields,
        array(select key from effective_document_type where not builtin order by key) as effective,
        (select hidden from effective_document_type where key = 'passport') as passport_hidden`.execute(
        trx,
      )
    ).rows[0];

  it("a household sees built-ins and its own types, never another household's", async () => {
    const builtins = Number(
      (
        await admin.query<{ n: number }>(
          'select count(*)::int as n from document_type where household_id is null',
        )
      ).rows[0]?.n,
    );
    expect(builtins).toBeGreaterThanOrEqual(21);

    // Through the API, as B's owner: every type, hidden ones too.
    const types = json<{ items: DocumentTypeView[] }>(
      await get('/api/v1/document-types?all=true'),
    ).items;
    const keys = types.map((t) => t.key);
    expect(keys).toEqual(expect.arrayContaining(['passport', typeB, unusedB]));
    expect(keys).not.toContain(typeA);
    expect(types.filter((t) => t.builtin)).toHaveLength(builtins);
    expect(types.find((t) => t.key === typeB)).toMatchObject({
      builtin: false,
      hidden: false,
      label: 'Pension statement from a former employer',
      short_label: 'Pension statement',
      issuer_noun: 'pension statement',
      expiry_driver: null,
      core: {
        identifier: { shown: true, required: false, label: 'Plan number' },
        expires: { shown: false },
      },
    });
    // A's change to the passport is A's alone.
    expect(types.find((t) => t.key === 'passport')).toMatchObject({
      hidden: false,
      reminder_leads: [270, 180],
    });
    const fields = json<{ items: DocumentAttributeView[] }>(
      await get('/api/v1/document-attributes'),
    ).items;
    expect(fields.map((f) => f.key)).toContain(fieldB);
    expect(fields.map((f) => f.key)).not.toContain(fieldA);
    expect(fields.find((f) => f.key === fieldB)).toEqual({
      key: fieldB,
      label: 'Plan type',
      kind: 'choice',
      choices: ['Defined benefit', 'Defined contribution'],
      builtin: false,
    });
    expect(fields.find((f) => f.key === 'vin')).toEqual({
      key: 'vin',
      label: 'VIN',
      kind: 'text',
      choices: null,
      builtin: true,
    });

    // In the database, as the application role, each household is given
    // the built-ins and its own: by somebody signed in and by the vault.
    const b = {
      own: [typeB, unusedB].sort(),
      fields: [fieldB],
      effective: [typeB, unusedB].sort(),
    };
    expect(await withPrincipal(one, ownerPrincipal, given)).toEqual({
      ...b,
      builtins,
      settings: 0,
      passport_hidden: false,
    });
    expect(await withSystem(one, B, given)).toEqual({
      ...b,
      builtins,
      settings: 0,
      passport_hidden: false,
    });
    expect(await withSystem(one, A, given)).toEqual({
      own: [typeA],
      builtins,
      settings: 1,
      fields: [fieldA],
      effective: [typeA],
      passport_hidden: true,
    });

    // Nobody said which household, on the connection they just used: the
    // setting reads '' now, not null. The built-ins, and nothing of anyone's.
    const unset = await one.transaction().execute(async (trx) => ({
      household: (
        await sql<{
          h: string | null;
        }>`select current_setting('app.household_id', true) as h`.execute(trx)
      ).rows[0]?.h,
      given: await given(trx),
    }));
    const none = {
      own: [],
      builtins,
      settings: 0,
      fields: [],
      effective: [],
      passport_hidden: false,
    };
    expect(unset).toEqual({ household: '', given: none });

    // The household said, and nobody asking: its own are not given either.
    const unsaid = await one.transaction().execute(async (trx) => {
      await sql`select set_config('app.household_id', ${B}, true)`.execute(trx);
      return given(trx);
    });
    expect(unsaid).toEqual(none);

    // A link is given the type of its own document, and no other of the
    // household's; not its settings or its fields.
    const doc = await admin.query<{ id: string }>(
      "insert into document (household_id, type_key, title) values ($1, $2, 'Acme pension') returning id",
      [B, typeB],
    );
    const share = await admin.query<{ id: string }>(
      `insert into share_link (household_id, document_id, token_hash, created_by, expires_at)
       values ($1, $2, $3, $4, now() + interval '1 day') returning id`,
      [B, doc.rows[0]?.id, randomBytes(32), ownerPrincipal.accountId],
    );
    const shareId = share.rows[0]?.id as string;
    expect(
      await withScope(one, { householdId: B, actor: { kind: 'link', shareId } }, given),
    ).toEqual({ ...none, own: [typeB], effective: [typeB] });
    // An upload request's sender, and a page nobody is signed in to: none.
    expect(
      await withScope(
        one,
        { householdId: B, actor: { kind: 'upload', requestId: randomUUID() } },
        given,
      ),
    ).toEqual(none);
    expect(await withScope(one, { householdId: B, actor: { kind: 'anonymous' } }, given)).toEqual(
      none,
    );
    await admin.query('delete from share_link where id = $1', [shareId]);
    await admin.query('delete from document where id = $1', [doc.rows[0]?.id]);
  });

  it('fdv_app cannot insert, update or delete a built-in', async () => {
    const asOwner = <T>(fn: (trx: Db) => Promise<T>) => withPrincipal(one, ownerPrincipal, fn);
    const asVault = <T>(fn: (trx: Db) => Promise<T>) => withSystem(one, B, fn);
    const changed = async (as: typeof asOwner, text: ReturnType<typeof sql>) =>
      Number((await as((trx) => text.execute(trx))).numAffectedRows ?? 0n);

    for (const as of [asOwner, asVault]) {
      // A built-in has no household, and nothing written here can reach one.
      await expect(
        as((trx) =>
          sql`insert into document_type (key, label, category) values ('smuggled', 'Smuggled', 'other')`.execute(
            trx,
          ),
        ),
      ).rejects.toThrow(/row-level security/);
      expect(
        await changed(as, sql`update document_type set label = 'Changed' where key = 'passport'`),
      ).toBe(0);
      expect(
        await changed(as, sql`update document_type set household_id = ${B} where key = 'passport'`),
      ).toBe(0);
      expect(await changed(as, sql`delete from document_type where key = 'passport'`)).toBe(0);
      // Nor one of the library's fields.
      await expect(
        as((trx) =>
          sql`insert into document_attribute (key, label, kind) values ('smuggled', 'Smuggled', 'text')`.execute(
            trx,
          ),
        ),
      ).rejects.toThrow(/row-level security/);
      expect(
        await changed(as, sql`update document_attribute set label = 'Changed' where key = 'vin'`),
      ).toBe(0);
      expect(await changed(as, sql`delete from document_attribute where key = 'vin'`)).toBe(0);

      // Nor another household's.
      await expect(
        as((trx) =>
          sql`insert into document_type (key, label, category, household_id)
              values (${ownKey()}, 'Smuggled', 'other', ${A})`.execute(trx),
        ),
      ).rejects.toThrow(/row-level security/);
      expect(
        await changed(as, sql`update document_type set label = 'Changed' where key = ${typeA}`),
      ).toBe(0);
      await expect(
        as((trx) =>
          sql`insert into document_type_setting (household_id, type_key, hidden)
              values (${A}, 'will', true)`.execute(trx),
        ),
      ).rejects.toThrow(/row-level security/);
    }

    // Its own it may add, change and take away — under a key of its own.
    const mine = ownKey();
    await asOwner((trx) =>
      sql`insert into document_type (key, label, category, household_id)
          values (${mine}, 'Season ticket', 'other', ${B})`.execute(trx),
    );
    expect(
      await changed(asOwner, sql`update document_type set label = 'Rail card' where key = ${mine}`),
    ).toBe(1);
    // A key once given never changes.
    await expect(
      asOwner((trx) =>
        sql`update document_type set key = ${ownKey()} where key = ${mine}`.execute(trx),
      ),
    ).rejects.toThrow(/keeps its key/);
    expect(await changed(asOwner, sql`delete from document_type where key = ${mine}`)).toBe(1);
    await expect(
      asOwner((trx) =>
        sql`insert into document_type (key, label, category, household_id)
            values ('season_ticket', 'Season ticket', 'other', ${B})`.execute(trx),
      ),
    ).rejects.toThrow(/document_type_key_shape/);

    // A transaction that says nobody is asking writes nothing, its own included.
    await expect(
      one.transaction().execute(async (trx) => {
        await sql`select set_config('app.household_id', ${B}, true)`.execute(trx);
        await sql`insert into document_type (key, label, category, household_id)
                  values (${ownKey()}, 'Smuggled', 'other', ${B})`.execute(trx);
      }),
    ).rejects.toThrow(/row-level security/);

    // The built-ins are as they were.
    const passport = await admin.query<{ label: string; household_id: string | null }>(
      "select label, household_id from document_type where key = 'passport'",
    );
    expect(passport.rows).toEqual([{ label: 'Passport', household_id: null }]);
  });

  it('a setting on a built-in shows through the view and changes nothing else', async () => {
    const effective = (trx: Db) =>
      trx
        .selectFrom('effective_document_type')
        .select([
          'key',
          'label',
          'fields',
          'expiry_driver',
          'reminder_leads',
          'usually_essential',
          'default_visibility',
          'core',
          'issued_by_label',
          'hidden',
        ])
        .where('builtin', '=', true)
        .orderBy('key')
        .execute();
    const before = await withSystem(one, B, effective);
    const aBefore = await withSystem(one, A, effective);
    const base = (
      await admin.query('select * from document_type where household_id is null order by key')
    ).rows;

    // B changes its passport, as the household itself (5.11 will do this).
    await withPrincipal(one, ownerPrincipal, (trx) =>
      trx
        .insertInto('document_type_setting')
        .values({
          household_id: B,
          type_key: 'passport',
          reminder_leads: [30],
          default_visibility: 'adults',
          usually_essential: false,
          core: JSON.stringify({ identifier: { label: 'Passport number', required: true } }),
          fields: JSON.stringify([
            { key: 'place_of_birth', label: 'Place of birth', kind: 'text', required: false },
          ]),
          updated_by: ownerPrincipal.accountId,
        })
        .execute(),
    );
    try {
      const after = await withSystem(one, B, effective);
      const passport = after.find((t) => t.key === 'passport');
      expect(passport).toMatchObject({
        label: 'Passport',
        expiry_driver: 'expires_on',
        reminder_leads: [30],
        usually_essential: false,
        default_visibility: 'adults',
        issued_by_label: 'Issuing country',
        hidden: false,
        fields: [{ key: 'place_of_birth', label: 'Place of birth', kind: 'text', required: false }],
        core: {
          identifier: { shown: true, required: true, label: 'Passport number' },
          issued_by: { shown: true, required: false, label: 'Issuing country' },
          expires: { shown: true, required: false, label: null },
        },
      });
      // Every other type is as it was, for B; A's passport is A's; and the
      // built-in itself is untouched.
      expect(after.filter((t) => t.key !== 'passport')).toEqual(
        before.filter((t) => t.key !== 'passport'),
      );
      expect(await withSystem(one, A, effective)).toEqual(aBefore);
      expect(
        (await admin.query('select * from document_type where household_id is null order by key'))
          .rows,
      ).toEqual(base);

      // The API answers it, and a passport filed now follows it: seen by
      // adults, not Essential, and not due for 30 days before it expires.
      const listed = json<{ items: DocumentTypeView[] }>(await get('/api/v1/document-types')).items;
      expect(listed.find((t) => t.key === 'passport')).toMatchObject({
        reminder_leads: [30],
        default_visibility: 'adults',
        core: { identifier: { label: 'Passport number', required: true } },
      });
      const in60 = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
      const made = await send('POST', '/api/v1/documents', {
        type_key: 'passport',
        title: 'New passport',
        owner_member_id: owner.member_id,
        expires: { date: in60, precision: 'day' },
      });
      expect(made.statusCode).toBe(201);
      expect(json<DocumentView>(made)).toMatchObject({
        visibility: 'adults',
        is_essential: false,
        status: { value: 'active' },
      });
      const reminders = await admin.query<{ lead_days: number }>(
        "select lead_days from reminder where document_id = $1 and kind = 'derived'",
        [json<DocumentView>(made).id],
      );
      expect(reminders.rows).toEqual([{ lead_days: 30 }]);

      // Switched off, Expires takes the expiry with it: the type no longer expires.
      await admin.query(
        `update document_type_setting set core = core || '{"expires": {"shown": false}}'
          where household_id = $1 and type_key = 'passport'`,
        [B],
      );
      const off = (await withSystem(one, B, effective)).find((t) => t.key === 'passport');
      expect(off).toMatchObject({ expiry_driver: null, core: { expires: { shown: false } } });
    } finally {
      await admin.query(
        "delete from document_type_setting where household_id = $1 and type_key = 'passport'",
        [B],
      );
    }
    expect(await withSystem(one, B, effective)).toEqual(before);
  });

  it("household B cannot capture or edit a document into household A's custom type", async () => {
    const before = await documentCount(B);
    const notOnTheList = 'That kind of document is not on the list.';

    // A capture naming A's type: refused before anything is kept.
    const captured = await capture({ type_key: typeA, title: 'Case papers' });
    expect(captured.statusCode).toBe(422);
    expect(refusal(captured).message).toBe(notOnTheList);
    // Typed in.
    const typed = await send('POST', '/api/v1/documents', { type_key: typeA, title: 'Case' });
    expect(typed.statusCode).toBe(422);
    expect(refusal(typed).message).toBe(notOnTheList);
    expect(await documentCount(B)).toBe(before);

    // Its own type it may file under, by capture and by hand…
    const own = await capture({ type_key: typeB, title: 'Acme pension' });
    expect(own.statusCode).toBe(201);
    const ownId = json<{ document_id: string }>(own).document_id;
    const filed = json<DocumentView>(await get(`/api/v1/documents/${ownId}`));
    expect(filed).toMatchObject({ type_key: typeB, category: 'financial' });
    const byHand = await send('POST', '/api/v1/documents', { type_key: typeB, title: 'Old plan' });
    expect(byHand.statusCode).toBe(201);

    // …but not change one into A's.
    const edited = await send('PATCH', `/api/v1/documents/${ownId}`, { type_key: typeA });
    expect(edited.statusCode).toBe(422);
    expect(refusal(edited).message).toBe(notOnTheList);
    expect(json<DocumentView>(await get(`/api/v1/documents/${ownId}`)).type_key).toBe(typeB);
    const stored = await admin.query<{ type_key: string }>(
      'select type_key from document where household_id = $1 and type_key = $2',
      [B, typeA],
    );
    expect(stored.rows).toEqual([]);
  });
});
