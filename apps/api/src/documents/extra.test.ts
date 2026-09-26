import { randomBytes, randomUUID } from 'node:crypto';
import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { DocumentView, Tokens } from '@fdv/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * A type's details (5.8): what a document keeps in `extra`, one value for
 * each of its type's own fields.
 *
 * The API takes only the type's fields, each of its kind, text up to 500
 * characters and 16 KB in all; anything else is `422 invalid_extra`, naming
 * the key. An edit merges, and null takes a key away, so a client never
 * wipes what it did not show. A required field left out is never a
 * refusal (A7): the document says what it needs — "Needs a passport
 * number" — until somebody adds it.
 */

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** A household's own key: 'h_' and ten base32 characters (0031). */
const ownKey = () => `h_${[...randomBytes(10)].map((b) => BASE32[b % 32]).join('')}`;

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n');
const BOUNDARY = 'fdv-extra-boundary';

const in5Years = () => `${new Date().getUTCFullYear() + 5}-12-31`;

describe.skipIf(!testAdminUrl())("a type's details", () => {
  let h: Harness;
  let owner: Tokens;
  let admin: ReturnType<typeof createPool>;
  /** A type of the household's own, with a field of every kind. */
  const policy = ownKey();
  const k = {
    cover: ownKey(),
    terms: ownKey(),
    terms2: ownKey(),
    renewed: ownKey(),
    started: ownKey(),
    claims: ownKey(),
    band: ownKey(),
    direct: ownKey(),
    unanswered: ownKey(),
  };

  const json = <T>(r: { json: () => unknown }) => r.json() as T;
  const refusal = (r: { json: () => unknown }) =>
    json<{ error: { code: string; message: string; detail?: string } }>(r).error;
  const get = (url: string) => h.app.inject({ method: 'GET', url, headers: h.as(owner) });
  const send = (method: 'POST' | 'PATCH', url: string, payload: unknown) =>
    h.app.inject({ method, url, headers: h.as(owner), payload: payload as object });
  const create = (body: Record<string, unknown>) => send('POST', '/api/v1/documents', body);
  const patch = (id: string, body: Record<string, unknown>) =>
    send('PATCH', `/api/v1/documents/${id}`, body);
  const stored = async (id: string) =>
    (await admin.query<{ extra: unknown }>('select extra from document where id = $1', [id]))
      .rows[0]?.extra;
  const documentCount = async () =>
    Number(
      (
        await admin.query<{ n: string }>(
          'select count(*) as n from document where household_id = $1',
          [owner.household_id],
        )
      ).rows[0]?.n,
    );

  /** A capture with the card's details, sent before the file. */
  const capture = (metadata: unknown, key = randomUUID()) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/capture',
      headers: {
        ...h.as(owner),
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
        'idempotency-key': key,
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

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();
    admin = createPool(h.adminUrl, 1);
    // As 5.11's editor will make it; nothing in the API does yet.
    await admin.query(
      `insert into document_type (key, label, category, household_id, fields)
       values ($1, 'Pet insurance', 'insurance', $2, $3)`,
      [
        policy,
        owner.household_id,
        JSON.stringify([
          { key: k.cover, label: 'Cover', kind: 'money', required: false },
          { key: k.terms, label: 'Terms', kind: 'long_text', required: false },
          { key: k.terms2, label: 'More terms', kind: 'long_text', required: false },
          { key: k.renewed, label: 'Renewed', kind: 'date', required: false },
          { key: k.started, label: 'First year', kind: 'year', required: false },
          { key: k.claims, label: 'Claims made', kind: 'number', required: false },
          {
            key: k.band,
            label: 'Band',
            kind: 'choice',
            choices: ['Basic', 'Lifetime'],
            required: false,
          },
          { key: k.direct, label: 'Paid by direct debit', kind: 'yes_no', required: false },
          // A choice whose answers are the library's, not its own.
          { key: k.unanswered, label: 'Species', kind: 'choice', required: false },
        ]),
      ],
    );
    await admin.query(
      `insert into document_attribute (household_id, key, label, kind, choices)
       values ($1, $2, 'Species', 'choice', '{Cat,Dog}')`,
      [owner.household_id, k.unanswered],
    );
  }, 60_000);

  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  it('an unknown key is refused and named', async () => {
    const before = await documentCount();
    const res = await create({
      type_key: 'vehicle_registration',
      title: 'Our car',
      extra: { vin: 'JM1BK32F781234567', colour: 'Red' },
    });
    expect(res.statusCode).toBe(422);
    expect(refusal(res)).toMatchObject({ code: 'invalid_extra', detail: 'colour' });
    expect(refusal(res).message).toContain('"colour"');
    // With no type, no detail is known.
    const untyped = await create({ title: 'A letter', extra: { vin: 'JM1BK32F781234567' } });
    expect(refusal(untyped)).toMatchObject({ code: 'invalid_extra', detail: 'vin' });
    // Another type's field is not this one's.
    const passport = await create({ type_key: 'passport', extra: { vin: 'JM1BK32F781234567' } });
    expect(refusal(passport)).toMatchObject({ code: 'invalid_extra', detail: 'vin' });
    expect(await documentCount()).toBe(before);

    // An edit too; and the document is as it was.
    const car = json<DocumentView>(
      await create({ type_key: 'vehicle_registration', extra: { vin: 'JM1BK32F781234567' } }),
    );
    const edited = await patch(car.id, { title: 'Renamed', extra: { colour: 'Red' } });
    expect(refusal(edited)).toMatchObject({ code: 'invalid_extra', detail: 'colour' });
    expect(json<DocumentView>(await get(`/api/v1/documents/${car.id}`))).toMatchObject({
      title: null,
      extra: { vin: 'JM1BK32F781234567' },
    });
  });

  it('a date field refuses "next week"', async () => {
    const res = await create({
      type_key: 'will',
      title: 'Our wills',
      extra: { last_reviewed: 'next week' },
    });
    expect(res.statusCode).toBe(422);
    expect(refusal(res)).toMatchObject({ code: 'invalid_extra', detail: 'last_reviewed' });
    expect(refusal(res).message).toBe(
      'Last reviewed must be a date: a day, a month or a year, with its precision.',
    );
    // Nor an impossible day, nor a month that is not kept as its last day.
    for (const bad of [
      { date: '2026-02-30', precision: 'day' },
      { date: '2026-03-01', precision: 'month' },
      '2026-03-14',
    ]) {
      const r = await create({ type_key: 'will', extra: { last_reviewed: bad } });
      expect(refusal(r).detail).toBe('last_reviewed');
    }
    // A date as every date is sent: with its precision.
    const ok = await create({
      type_key: 'will',
      title: 'Our wills',
      extra: { last_reviewed: { date: '2026-03-31', precision: 'month' } },
    });
    expect(ok.statusCode).toBe(201);
    expect(json<DocumentView>(ok).extra).toEqual({
      last_reviewed: { date: '2026-03-31', precision: 'month' },
    });
  });

  it('each kind of detail takes only its own kind of value', async () => {
    const good = {
      [k.cover]: 1250.5,
      [k.terms]: '  Excess £99.\nNo cover abroad.  ',
      [k.renewed]: { date: '2026-04-01', precision: 'day' },
      [k.started]: 2019,
      [k.claims]: 2,
      [k.band]: 'Lifetime',
      [k.direct]: false,
      [k.unanswered]: 'Cat',
    };
    const made = await create({ type_key: policy, title: 'Pet cover', extra: good });
    expect(made.statusCode).toBe(201);
    // Text is kept trimmed; everything else as sent.
    expect(json<DocumentView>(made).extra).toEqual({
      ...good,
      [k.terms]: 'Excess £99.\nNo cover abroad.',
    });

    const refused: Array<[string, unknown]> = [
      [k.cover, 12.345],
      [k.cover, '12.50'],
      [k.terms, 42],
      [k.renewed, 'April 2026'],
      [k.started, 2019.5],
      [k.started, '2019'],
      [k.claims, 'two'],
      [k.band, 'Gold'],
      [k.direct, 'yes'],
      [k.unanswered, 'Rabbit'],
    ];
    for (const [key, value] of refused) {
      const r = await create({ type_key: policy, extra: { [key]: value } });
      expect([r.statusCode, refusal(r).code, refusal(r).detail]).toEqual([
        422,
        'invalid_extra',
        key,
      ]);
    }

    // Text is 500 characters at most; long text, as long as a note.
    const vin = (n: number) =>
      create({ type_key: 'vehicle_registration', extra: { vin: 'V'.repeat(n) } });
    expect((await vin(500)).statusCode).toBe(201);
    const long = await vin(501);
    expect(refusal(long)).toMatchObject({
      code: 'invalid_extra',
      detail: 'vin',
      message: 'VIN is too long: 500 characters at most.',
    });
    const terms = (n: number) => create({ type_key: policy, extra: { [k.terms]: 'x'.repeat(n) } });
    expect((await terms(10_000)).statusCode).toBe(201);
    expect(refusal(await terms(10_001)).detail).toBe(k.terms);
  });

  it('16 KB is the most', async () => {
    // Two long texts that come to exactly 16 KB as JSON, in UTF-8.
    const exactly = (bytes: number) => {
      const first = 'é'.repeat(4000); // two bytes each
      const bare = Buffer.byteLength(JSON.stringify({ [k.terms]: first, [k.terms2]: '' }));
      return { [k.terms]: first, [k.terms2]: 'b'.repeat(bytes - bare) };
    };
    expect(Buffer.byteLength(JSON.stringify(exactly(16 * 1024)))).toBe(16_384);

    const most = await create({ type_key: policy, title: 'Full', extra: exactly(16_384) });
    expect(most.statusCode).toBe(201);
    const over = await create({ type_key: policy, extra: exactly(16_385) });
    expect(over.statusCode).toBe(422);
    expect(refusal(over)).toMatchObject({
      code: 'invalid_extra',
      detail: k.terms2,
      message: 'The details are too long: 16 KB at most, all together.',
    });

    // Full, a document takes nothing more; taking something away is fine.
    const id = json<DocumentView>(most).id;
    const more = await patch(id, { extra: { [k.band]: 'Basic' } });
    expect(refusal(more)).toMatchObject({ code: 'invalid_extra', detail: k.band });
    const less = await patch(id, { extra: { [k.terms2]: null, [k.band]: 'Basic' } });
    expect(less.statusCode).toBe(200);
    expect(Object.keys(json<DocumentView>(less).extra).sort()).toEqual([k.band, k.terms].sort());
  });

  it('two edits at once cannot take the details past 16 KB between them', async () => {
    // Each is well under on its own; together they are not. Held one after
    // the other, the second is measured against what the first left.
    const outcomes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const made = await create({ type_key: policy, title: `Policy ${i}` });
      const id = json<DocumentView>(made).id;
      const both = await Promise.all([
        patch(id, { extra: { [k.terms]: 'a'.repeat(9_000) } }),
        patch(id, { extra: { [k.terms2]: 'b'.repeat(9_000) } }),
      ]);
      outcomes.push(...both.map((r) => r.statusCode));
      const kept = (await stored(id)) as Record<string, unknown>;
      expect(Buffer.byteLength(JSON.stringify(kept))).toBeLessThanOrEqual(16 * 1024);
      expect(both.map((r) => r.statusCode).sort()).toEqual([200, 422]);
    }
    expect(outcomes.filter((c) => c === 422)).toHaveLength(5);
  });

  it('text the vault cannot keep is refused and named, never a 500', async () => {
    const made = await create({ type_key: policy, title: 'Odd characters' });
    const id = json<DocumentView>(made).id;
    for (const odd of ['a\ud800b', 'b\udc00', 'nul\u0000here']) {
      const r = await patch(id, { extra: { [k.terms]: odd } });
      expect(r.statusCode, r.body).toBe(422);
      expect(refusal(r)).toMatchObject({ code: 'invalid_extra', detail: k.terms });
      expect(refusal(r).message).toBe('Terms contains a character the vault cannot keep.');
    }
    // A pair that belongs together is a character like any other.
    const fine = await patch(id, { extra: { [k.terms]: 'a smile \ud83d\ude00' } });
    expect(fine.statusCode, fine.body).toBe(200);
  });

  it('PATCH merges; null removes', async () => {
    const car = json<DocumentView>(
      await create({
        type_key: 'vehicle_registration',
        title: 'The car',
        extra: { vin: 'JM1BK32F781234567', plate: 'AB12 CDE' },
      }),
    );

    // A key left out is left alone.
    const one = await patch(car.id, { extra: { vin: 'JM1BK32F781234568' } });
    expect(json<DocumentView>(one).extra).toEqual({
      vin: 'JM1BK32F781234568',
      plate: 'AB12 CDE',
    });
    // Null takes one away; blank text is no value, so it does too.
    const gone = await patch(car.id, { extra: { plate: null } });
    expect(json<DocumentView>(gone).extra).toEqual({ vin: 'JM1BK32F781234568' });
    const blank = await patch(car.id, { extra: { vin: '   ' } });
    expect(json<DocumentView>(blank).extra).toEqual({});
    // An edit that does not mention the details leaves them.
    await patch(car.id, { extra: { vin: 'JM1BK32F781234567', plate: 'AB12 CDE' } });
    const titled = await patch(car.id, { title: 'Our car' });
    expect(json<DocumentView>(titled).extra).toEqual({
      vin: 'JM1BK32F781234567',
      plate: 'AB12 CDE',
    });

    // A value kept from before the type changed (A11: "Other details"): an
    // older phone sends the whole object back, and is not refused for what
    // it did not change; null removes it like any other.
    await admin.query(`update document set extra = extra || '{"colour": 7}' where id = $1`, [
      car.id,
    ]);
    const whole = await patch(car.id, {
      extra: { vin: 'JM1BK32F781234567', plate: 'CD34 EFG', colour: 7 },
    });
    expect(whole.statusCode).toBe(200);
    expect(json<DocumentView>(whole).extra).toEqual({
      vin: 'JM1BK32F781234567',
      plate: 'CD34 EFG',
      colour: 7,
    });
    // Changed, it is checked, and it is not the type's.
    expect(refusal(await patch(car.id, { extra: { colour: 8 } })).detail).toBe('colour');
    const removed = await patch(car.id, { extra: { colour: null } });
    expect(json<DocumentView>(removed).extra).toEqual({
      vin: 'JM1BK32F781234567',
      plate: 'CD34 EFG',
    });
    expect(await stored(car.id)).toEqual({ vin: 'JM1BK32F781234567', plate: 'CD34 EFG' });

    // Changing the type keeps what the old one asked for; the new one's
    // fields are what an edit may add.
    const moved = await patch(car.id, { type_key: 'insurance_policy', extra: { premium: '£30' } });
    expect(json<DocumentView>(moved).extra).toEqual({
      vin: 'JM1BK32F781234567',
      plate: 'CD34 EFG',
      premium: '£30',
    });
  });

  it('a capture with details is complete from its first byte', async () => {
    const res = await capture({
      type_key: 'vehicle_registration',
      title: 'Car registration',
      owner_member_id: owner.member_id,
      expires: { date: in5Years(), precision: 'day' },
      extra: { vin: ' JM1BK32F781234567 ', plate: 'AB12 CDE' },
    });
    expect(res.statusCode).toBe(201);
    const id = json<{ document_id: string }>(res).document_id;
    const d = json<DocumentView>(await get(`/api/v1/documents/${id}`));
    expect(d.extra).toEqual({ vin: 'JM1BK32F781234567', plate: 'AB12 CDE' });
    expect(d.status.value).toBe('active');
    expect(await stored(id)).toEqual({ vin: 'JM1BK32F781234567', plate: 'AB12 CDE' });

    // Details the type does not have are refused before anything is kept,
    // and the same key works again.
    const key = randomUUID();
    const before = await documentCount();
    const bad = await capture(
      { type_key: 'vehicle_registration', extra: { plate: 'AB12 CDE', wheels: 4 } },
      key,
    );
    expect(bad.statusCode).toBe(422);
    expect(refusal(bad)).toMatchObject({ code: 'invalid_extra', detail: 'wheels' });
    expect(await documentCount()).toBe(before);
    const again = await capture({ type_key: 'vehicle_registration', extra: {} }, key);
    expect(again.statusCode).toBe(201);
  });

  it('a missing required field is Needs info, never a refusal', async () => {
    const needs = async (res: { statusCode: number; json: () => unknown }) => {
      expect(res.statusCode).toBe(201);
      const id =
        json<{ document_id?: string; id?: string }>(res).document_id ??
        json<{ id: string }>(res).id;
      return json<DocumentView>(await get(`/api/v1/documents/${id}`));
    };
    const future = { date: in5Years(), precision: 'day' };
    const mine = { owner_member_id: owner.member_id };

    // What each built-in requires (A9), and what it says without it.
    const passport = await needs(await create({ type_key: 'passport', ...mine, expires: future }));
    expect(passport.status).toEqual({ value: 'needs_info', label: 'Needs a passport number' });
    const bare = await needs(await create({ type_key: 'passport', ...mine }));
    expect(bare.status.label).toBe('Needs a passport number and an expiry date');
    const licence = await needs(await capture({ type_key: 'drivers_licence', ...mine }));
    expect(licence.status.label).toBe('Needs an expiry date');
    const policyDoc = await needs(await capture({ type_key: 'insurance_policy', ...mine }));
    expect(policyDoc.status.label).toBe('Needs an insurer and an expiry date');
    const car = await needs(
      await create({ type_key: 'vehicle_registration', ...mine, expires: future }),
    );
    // A car's plate, one of the type's own details, since the card can ask
    // for it (0034, 5.10).
    expect(car.status).toEqual({ value: 'needs_info', label: 'Needs a registration plate' });

    // Lists and search say the same.
    const listed = json<{ items: DocumentView[] }>(
      await get('/api/v1/documents?limit=200&status=needs_info'),
    ).items;
    expect(listed.find((d) => d.id === passport.id)?.status.label).toBe('Needs a passport number');

    // Given, it is what its dates say.
    const numbered = await patch(passport.id, { identifier: '563914782' });
    expect(json<DocumentView>(numbered).status.value).toBe('active');
    const plated = await patch(car.id, { extra: { plate: 'AB12 CDE' } });
    expect(json<DocumentView>(plated).status.value).toBe('active');

    // An expiry that has passed still comes first: that is what to act on.
    const lapsed = await needs(
      await create({
        type_key: 'passport',
        ...mine,
        expires: { date: '2020-01-31', precision: 'month' },
      }),
    );
    expect(lapsed.status).toEqual({ value: 'expired', label: 'Expired January 2020' });

    // The type as the household has it: a field it makes required counts.
    await admin.query(
      `insert into document_type_setting (household_id, type_key, fields)
       values ($1, 'birth_certificate',
               '[{"key": "registration_no", "label": "Registration number", "kind": "text", "required": true}]')`,
      [owner.household_id],
    );
    try {
      const birth = await needs(await create({ type_key: 'birth_certificate', ...mine }));
      expect(birth.status.label).toBe('Needs a registration number');
    } finally {
      await admin.query(
        "delete from document_type_setting where household_id = $1 and type_key = 'birth_certificate'",
        [owner.household_id],
      );
    }
  });

  it('a capture queued before its type was hidden is accepted', async () => {
    // The household hides a built-in, and archives a type of its own, after
    // a phone queued a scan of each against the list it had.
    await admin.query(
      `insert into document_type_setting (household_id, type_key, hidden)
       values ($1, 'vehicle_registration', true)`,
      [owner.household_id],
    );
    await admin.query('update document_type set archived_at = now() where key = $1', [policy]);
    try {
      const car = await capture({
        type_key: 'vehicle_registration',
        extra: { plate: 'AB12 CDE' },
      });
      expect(car.statusCode).toBe(201);
      const pet = await capture({ type_key: policy, extra: { [k.band]: 'Basic' } });
      expect(pet.statusCode).toBe(201);
      const d = json<DocumentView>(
        await get(`/api/v1/documents/${json<{ document_id: string }>(pet).document_id}`),
      );
      expect(d).toMatchObject({ type_key: policy, extra: { [k.band]: 'Basic' } });
      // Its details are checked all the same.
      const wrong = await capture({ type_key: policy, extra: { [k.band]: 'Gold' } });
      expect(refusal(wrong)).toMatchObject({ code: 'invalid_extra', detail: k.band });
    } finally {
      await admin.query(
        "delete from document_type_setting where household_id = $1 and type_key = 'vehicle_registration'",
        [owner.household_id],
      );
      await admin.query('update document_type set archived_at = null where key = $1', [policy]);
    }
  });
});
