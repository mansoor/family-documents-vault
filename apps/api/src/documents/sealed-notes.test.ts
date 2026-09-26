import { randomBytes, randomUUID } from 'node:crypto';
import { EnvKeyProvider, openPrivate, ScopeKeys } from '@fdv/crypto';
import { createPool, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { DocumentView } from '@fdv/shared';
import FormData from 'form-data';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, TEST_MASTER, type Harness } from '../test-harness.js';
import type { SearchHit } from './service.js';

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** A household's own key: 'h_' and ten base32 characters (0031). */
const ownKey = () => `h_${[...randomBytes(10)].map((b) => BASE32[b % 32]).join('')}`;

interface FirstPass {
  items: SearchHit[];
  sealed_pending: { count: number; token?: string };
}

/**
 * 5.9: an Only me document's notes and details are sealed under its
 * owner's member key, as its pages' text always has been. They leave the
 * plain columns and the search index the moment it is made Only me; only
 * its owner reads them, on the document itself or through their private
 * search pass; and they come back when it is shown to the family again.
 *
 * Every row is read here as the application role, fdv_app_test, as the
 * vault reads it.
 */
describe.skipIf(!testAdminUrl())("an Only me document's notes and details", () => {
  let h: Harness;
  let owner: Tokens;
  let other: Tokens;
  let carId: string;
  const keys = new ScopeKeys(new EnvKeyProvider(TEST_MASTER));

  const NOTE = 'Spare key under the geranium pot by the back door';
  const VIN = 'SEALEDVIN0000001';
  const PLATE = 'SL33 LED';
  /** A type of the household's own, and its fields: one of them required. */
  const boxType = ownKey();
  const boxNumber = ownKey();
  const branch = ownKey();

  const get = (t: Tokens, url: string) => h.app.inject({ url, headers: h.as(t) });
  const send = (t: Tokens, method: 'POST' | 'PATCH', url: string, payload: unknown) =>
    h.app.inject({ method, url, headers: h.as(t), payload: payload as never });
  const first = async (q: string, who = owner) =>
    (await get(who, `/api/v1/search?q=${encodeURIComponent(q)}`)).json<FirstPass>();
  const second = async (token: string, who = owner) =>
    (await get(who, `/api/v1/search/sealed?token=${encodeURIComponent(token)}`)).json<{
      items: SearchHit[];
      searched: number;
    }>();

  /** The row as the vault keeps it, read as the application role. */
  const stored = (id: string) =>
    withSystem(h.db, owner.household_id, async (trx) => {
      const row = await trx
        .selectFrom('document')
        .select([
          'notes',
          'extra',
          'notes_sealed',
          'extra_sealed',
          'sealed_details',
          'updated_at',
          sql<string>`search_tsv::text`.as('terms'),
          sql<string>`current_user`.as('role'),
        ])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      const key = await keys.unwrap(trx, {
        householdId: owner.household_id,
        kind: 'member',
        memberId: owner.member_id,
      });
      return { ...row, open: () => openPrivate(key.key, id, row) };
    });

  const made = async (payload: Record<string, unknown>) => {
    const r = await send(owner, 'POST', '/api/v1/documents', {
      owner_member_id: owner.member_id,
      ...payload,
    });
    expect(r.statusCode).toBe(201);
    return r.json<DocumentView>();
  };

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();
    other = await h.join(owner, { name: 'Sana', email: 'sana@example.test', role: 'adult' });
    const admin = createPool(h.adminUrl, 1);
    try {
      await admin.query(
        `insert into document_type (key, label, category, household_id, fields)
         values ($1, 'Safe deposit box', 'financial', $2, $3)`,
        [
          boxType,
          owner.household_id,
          JSON.stringify([
            { key: boxNumber, label: 'Box number', kind: 'text', required: true },
            { key: branch, label: 'Branch', kind: 'text', required: false },
          ]),
        ],
      );
    } finally {
      await admin.end();
    }
    // A car the family can see, with a note and its details.
    carId = (
      await made({
        type_key: 'vehicle_registration',
        title: 'Family estate car',
        expires: { date: '2031-03-31', precision: 'month' },
        notes: NOTE,
        extra: { vin: VIN, plate: PLATE },
      })
    ).id;
  }, 60_000);
  afterAll(() => h.close());

  it('making a document Only me seals its note and details and empties the plain columns', async () => {
    // The family's to begin with: plain, and found by another adult.
    expect((await stored(carId)).notes).toBe(NOTE);
    expect((await first('geranium', other)).items.map((i) => i.document_id)).toEqual([carId]);

    const hidden = await send(owner, 'POST', `/api/v1/documents/${carId}/visibility`, {
      visibility: 'private',
    });
    expect(hidden.statusCode).toBe(200);

    const row = await stored(carId);
    expect(row.role).toBe('fdv_app_test');
    expect(row).toMatchObject({ notes: null, extra: {} });
    expect([...row.sealed_details].sort()).toEqual(['plate', 'vin']);
    const blob = Buffer.concat([row.notes_sealed as Buffer, row.extra_sealed as Buffer]);
    for (const word of ['geranium', VIN, 'SL33']) {
      expect(blob.toString('latin1')).not.toContain(word);
    }
    // Sealed under the owner's own key, bound to this document.
    expect(row.open()).toEqual({ notes: NOTE, extra: { vin: VIN, plate: PLATE } });

    // The owner reads them on the document itself, and nobody else can.
    const own = (await get(owner, `/api/v1/documents/${carId}`)).json<DocumentView>();
    expect(own).toMatchObject({ notes: NOTE, has_notes: true, extra: { vin: VIN, plate: PLATE } });
    expect((await get(other, `/api/v1/documents/${carId}`)).statusCode).toBe(404);

    // A list says it has notes, and shows neither them nor its details.
    const listed = (await get(owner, '/api/v1/documents')).json<{ items: DocumentView[] }>();
    expect(listed.items.find((d) => d.id === carId)).toMatchObject({
      notes: null,
      has_notes: true,
      extra: {},
    });
  });

  it("the search index holds no word of an Only me document's notes or details", async () => {
    const row = await stored(carId);
    expect(row.terms).toContain("'estate'"); // its title, as ever
    expect(row.terms).not.toMatch(/geranium|pot|door|sealedvin|sl33|led/);
    for (const who of [owner, other]) {
      expect((await first('geranium', who)).items).toEqual([]);
      expect((await first(VIN, who)).items).toEqual([]);
    }
    // Nor does a document made Only me from the start, nor one captured so,
    // nor an Only me document's later edit: sealed from their first byte.
    const diary = await made({ title: 'Diary', visibility: 'private', notes: 'Lighthouse' });
    expect(diary).toMatchObject({ notes: 'Lighthouse', has_notes: true });
    const form = new FormData();
    form.append(
      'metadata',
      JSON.stringify({
        type_key: 'vehicle_registration',
        title: 'Captured car',
        owner_member_id: owner.member_id,
        visibility: 'private',
        notes: 'Windmill',
        extra: { vin: 'CAPTUREDVIN00001' },
      }),
    );
    form.append('file', PDF, { filename: 'scan.pdf', contentType: 'application/pdf' });
    const captured = await h.app.inject({
      method: 'POST',
      url: '/api/v1/capture',
      headers: { ...h.as(owner), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    expect(captured.statusCode).toBe(201);
    const capturedId = captured.json<{ document_id: string }>().document_id;
    const edited = await send(owner, 'PATCH', `/api/v1/documents/${diary.id}`, {
      notes: 'Lighthouse and harbour',
    });
    expect(edited.json<DocumentView>().notes).toBe('Lighthouse and harbour');

    for (const [id, words] of [
      [diary.id, /lighthouse|harbour/],
      [capturedId, /windmill|capturedvin/],
    ] as const) {
      const r = await stored(id);
      expect(r).toMatchObject({ notes: null, extra: {} });
      expect(r.notes_sealed).not.toBeNull();
      expect(r.terms).not.toMatch(words);
    }
    expect((await stored(capturedId)).open()).toEqual({
      notes: 'Windmill',
      extra: { vin: 'CAPTUREDVIN00001' },
    });
    expect((await first('harbour')).items).toEqual([]);
  });

  it('the owner finds them through the private pass; another adult finds nothing', async () => {
    const byNote = await first('geranium');
    expect(byNote.items).toEqual([]);
    expect(byNote.sealed_pending.count).toBeGreaterThan(0);
    const found = await second(byNote.sealed_pending.token as string);
    expect(found.items.map((i) => i.document_id)).toEqual([carId]);
    expect(found.items[0]).toMatchObject({ matched_in: 'title' });
    expect(found.items[0]?.snippet).toContain('<em>geranium</em>');

    // A detail, and a detail with a word of the title the index has.
    const byVin = await first(VIN);
    expect((await second(byVin.sealed_pending.token as string)).items[0]?.document_id).toBe(carId);
    const both = await first(`estate ${VIN}`);
    expect(both.items).toEqual([]);
    expect(
      (await second(both.sealed_pending.token as string)).items.map((i) => i.document_id),
    ).toEqual([carId]);

    // Sana has no Only me documents: nothing is pending for her, and there
    // is nothing of the owner's to find.
    const hers = await first('geranium', other);
    expect(hers.items).toEqual([]);
    expect(hers.sealed_pending).toEqual({ count: 0 });
    // The owner's handle is not hers to use.
    const stolen = await get(
      other,
      `/api/v1/search/sealed?token=${encodeURIComponent(byNote.sealed_pending.token as string)}`,
    );
    expect(stolen.statusCode).toBe(403);
  });

  it("an Only me document's Needs info is worked out when its owner writes, and kept", async () => {
    // A safe deposit box, as the household's own type (5.11's editor will
    // make them), asks for its box number.
    const box = await made({
      type_key: boxType,
      title: 'Bank box',
      visibility: 'private',
      extra: { [branch]: 'High Street' },
    });
    const needs = { value: 'needs_info', label: 'Needs a box number' };
    expect(box.status).toEqual(needs);
    const listedStatus = async () =>
      (await get(owner, '/api/v1/documents'))
        .json<{ items: DocumentView[] }>()
        .items.find((d) => d.id === box.id)?.status;
    expect(await listedStatus()).toEqual(needs);

    // Given, sealed: nothing is plain, and the list knows it has one.
    const given = await send(owner, 'PATCH', `/api/v1/documents/${box.id}`, {
      extra: { [boxNumber]: '0413' },
    });
    expect(given.json<DocumentView>()).toMatchObject({
      extra: { [branch]: 'High Street', [boxNumber]: '0413' },
      status: { value: 'valid' },
    });
    const row = await stored(box.id);
    expect(row.extra).toEqual({});
    expect([...row.sealed_details].sort()).toEqual([branch, boxNumber].sort());
    expect((await listedStatus())?.value).toBe('valid');

    // Taken away again: needed again. The merge kept the branch.
    await send(owner, 'PATCH', `/api/v1/documents/${box.id}`, { extra: { [boxNumber]: null } });
    expect(await listedStatus()).toEqual(needs);
    expect((await stored(box.id)).open().extra).toEqual({ [branch]: 'High Street' });
  });

  it('making it household again unseals them', async () => {
    const before = (await stored(carId)).updated_at;
    const shown = await send(owner, 'POST', `/api/v1/documents/${carId}/visibility`, {
      visibility: 'household',
    });
    expect(shown.statusCode).toBe(200);
    const row = await stored(carId);
    expect(row).toMatchObject({
      notes: NOTE,
      extra: { vin: VIN, plate: PLATE },
      notes_sealed: null,
      extra_sealed: null,
      sealed_details: [],
    });
    expect(row.updated_at.getTime()).toBeGreaterThan(before.getTime());
    expect(row.terms).toMatch(/geranium/);
    expect(row.terms).toMatch(/sealedvin0000001/);
    // The family finds it by its words again, and reads them in a list.
    expect((await first('geranium', other)).items.map((i) => i.document_id)).toEqual([carId]);
    const listed = (await get(other, '/api/v1/documents')).json<{ items: DocumentView[] }>();
    expect(listed.items.find((d) => d.id === carId)).toMatchObject({
      notes: NOTE,
      has_notes: true,
      extra: { vin: VIN, plate: PLATE },
    });
  });
});
