import { randomUUID } from 'node:crypto';
import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  addMonths,
  localToday,
  REVIEW_NOTE,
  type BatchAccepted,
  type BatchDetail,
  type BatchItemView,
  type Capabilities,
  type DocumentTypeView,
  type DocumentView,
  type ReminderView,
  type Tokens,
} from '@fdv/shared';
import type { LightMyRequestResponse } from 'fastify';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * Health's kinds, details and reminders (0.9.0, H3 of plan-health), through
 * the API, from the side of whoever must not see:
 *
 *  - nine kinds in Medical, kept for adults and Sensitive by default: a
 *    teen's own and a grown-up son's own start as Only me (H1a), and the
 *    other adults are not given them;
 *  - but a teen's own vaccination record starts where their parents see it
 *    — Everyone for a teen signed in as one, who cannot see Adults only;
 *    Adults only for one signed in as an adult — through POST /documents, a
 *    capture and a batch's accept; a grown-up son's own is Only me as
 *    before (turning 18 is where his parents' sight is asked about);
 *  - their details and the dates they remind from: a prescription's Next
 *    refill and a vaccination record's Next dose due, asked for but never
 *    required; an insurance card's Expires;
 *  - a yearly review on an advance directive, a proxy or a HIPAA
 *    authorization: one open a document, Done bringing the next a year on by
 *    the household's calendar, early or late, Snooze as any reminder's, a
 *    new version leaving it be, and nobody else's to see or set.
 *
 * Dates are relative to today, on the household's calendar.
 */

const PDF = (marker: string) =>
  Buffer.from(
    `%PDF-1.4\n% ${marker}\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
  );
const BOUNDARY = 'fdv-h3-boundary';

/** A date of birth on the first of this month, `years + 1` years ago. */
const bornYearsAgo = (years: number) => {
  const d = new Date();
  return `${d.getUTCFullYear() - years - 1}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
};
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const HEALTH = [
  'advance_directive',
  'explanation_of_benefits',
  'healthcare_proxy',
  'hipaa_authorization',
  'imaging_report',
  'insurance_card',
  'lab_result',
  'vaccination_record',
  'visit_summary',
];

describe.skipIf(!testAdminUrl())('Health’s kinds, details and reminders (0.9.0, H3)', () => {
  let h: Harness;
  /** Mum, an owner: a parent. */
  let mum: Tokens;
  /** Dad, an adult: a parent. */
  let dad: Tokens;
  /** Tia, 15, signed in as a teen. */
  let teen: Tokens;
  /** Noor, 15, whom the family signed in as an adult. */
  let noor: Tokens;
  /** Zain, 20, the family's son. */
  let son: Tokens;
  /** Ravi, 19 by his date of birth, still signed in as a teen. */
  let grownTeen: Tokens;
  let admin: ReturnType<typeof createPool>;
  let zone = 'UTC';

  const json = <T>(r: { json: () => unknown }) => r.json() as T;
  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
    who: Tokens = mum,
    headers: Record<string, string> = {},
  ) =>
    h.app.inject({
      method,
      url,
      headers: { ...h.as(who), ...headers },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
  const ok = async <T>(r: Promise<LightMyRequestResponse>, status = 200): Promise<T> => {
    const res = await r;
    expect(res.statusCode, res.body).toBe(status);
    return json<T>(res);
  };
  const make = (who: Tokens, payload: Record<string, unknown>) =>
    ok<DocumentView>(call('POST', '/api/v1/documents', payload, who), 201);
  const seen = async (who: Tokens, id: string) =>
    (await call('GET', `/api/v1/documents/${id}`, undefined, who)).statusCode;
  const today = () => localToday(zone);
  const reminders = (who: Tokens, documentId?: string) =>
    ok<{ items: ReminderView[] }>(
      call(
        'GET',
        `/api/v1/reminders?state=all${documentId ? `&document_id=${documentId}` : ''}`,
        undefined,
        who,
      ),
    ).then((r) => r.items);
  const review = (who: Tokens, documentId: string, fireAt: string, more = {}) =>
    call(
      'POST',
      '/api/v1/reminders',
      { document_id: documentId, fire_at: fireAt, review: true, ...more },
      who,
    );
  const capture = (who: Tokens, metadata: Record<string, unknown>) => {
    const part = (name: string, value: string) =>
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      );
    const body = Buffer.concat([
      part('metadata', JSON.stringify(metadata)),
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="scan.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
      ),
      PDF(randomUUID()),
      Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
    ]);
    return h.app.inject({
      method: 'POST',
      url: '/api/v1/capture',
      headers: {
        ...h.as(who),
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
        'idempotency-key': randomUUID(),
      },
      payload: body,
    });
  };

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    mum = await h.setup();
    dad = await h.join(mum, { name: 'Omar', email: 'omar-h3@example.test', role: 'adult' });
    teen = await h.join(mum, { name: 'Tia', email: 'tia-h3@example.test', role: 'teen' });
    noor = await h.join(mum, { name: 'Noor', email: 'noor-h3@example.test', role: 'adult' });
    son = await h.join(mum, { name: 'Zain', email: 'zain-h3@example.test', role: 'adult' });
    grownTeen = await h.join(mum, { name: 'Ravi', email: 'ravi-h3@example.test', role: 'teen' });
    admin = createPool(h.adminUrl, 2);
    const set = (t: Tokens, relationship: string | null, dob: string | null) =>
      admin.query('update member set relationship = $1, date_of_birth = $2 where id = $3', [
        relationship,
        dob,
        t.member_id,
      ]);
    await set(mum, 'Mum', bornYearsAgo(44));
    await set(dad, 'Dad', bornYearsAgo(46));
    await set(teen, 'daughter', bornYearsAgo(15));
    await set(noor, 'daughter', bornYearsAgo(15));
    await set(son, 'Son', bornYearsAgo(20));
    await set(grownTeen, 'Son', bornYearsAgo(19));
  }, 120_000);

  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  // ---------------------------------------------------------------- kinds

  it('says so, and lists the nine in Medical: kept for adults, Sensitive', async () => {
    const caps = await ok<Capabilities>(call('GET', '/api/v1/capabilities'));
    expect(caps.features.health_kinds).toBe(true);
    const types = (await ok<{ items: DocumentTypeView[] }>(call('GET', '/api/v1/document-types')))
      .items;
    const health = types.filter((t) => HEALTH.includes(t.key));
    expect(health.map((t) => t.key).sort()).toEqual(HEALTH);
    for (const t of health) {
      expect(t, t.key).toMatchObject({
        category: 'medical',
        default_visibility: 'adults',
        sensitive_default: true,
        builtin: true,
        hidden: false,
      });
    }
    expect(types.find((t) => t.key === 'medical_record')?.label).toBe('Medical record');
    const rx = types.find((t) => t.key === 'prescription');
    expect(rx).toMatchObject({
      remind_from: 'refill_date',
      remind_fallback: 'expires',
      remind_leads: [7, 1],
    });
    expect(rx?.fields.find((f) => f.key === 'refill_date')).toMatchObject({
      label: 'Next refill',
      kind: 'date',
      required: false,
    });
    const vax = types.find((t) => t.key === 'vaccination_record');
    expect(vax).toMatchObject({ remind_from: 'next_dose_due', remind_leads: [30, 7] });
    expect(vax?.fields.find((f) => f.key === 'next_dose_due')?.required).toBe(false);
    // Periodic: never offered as the renewal of the one before.
    expect(types.find((t) => t.key === 'lab_result')?.periodic).toBe(true);
    expect(types.find((t) => t.key === 'insurance_card')?.periodic).toBe(false);
  });

  // ------------------------------------------------------------ who sees it

  describe('who sees a new health paper, nobody having said', () => {
    it('the matrix, and what the others are given', async () => {
      const cases: Array<{
        who: Tokens;
        what: string;
        body: Record<string, unknown>;
        want: 'household' | 'adults' | 'private';
        /** Who must not be given it; and who must. */
        not: Tokens[];
        sees: Tokens[];
      }> = [
        // A teen's own lab result: Only me (H1a). Neither parent.
        {
          who: teen,
          what: 'teen, own lab result',
          body: { type_key: 'lab_result' },
          want: 'private',
          not: [mum, dad, son],
          sees: [teen],
        },
        // A teen's own vaccination record: where both parents see it, and the teen.
        {
          who: teen,
          what: 'teen, own vaccination record',
          body: { type_key: 'vaccination_record' },
          want: 'household',
          not: [],
          sees: [teen, mum, dad],
        },
        // Asked for, as asked: Only me stays Only me.
        {
          who: teen,
          what: 'teen, own vaccination record, Only me asked',
          body: { type_key: 'vaccination_record', visibility: 'private' },
          want: 'private',
          not: [mum, dad],
          sees: [teen],
        },
        // A 15-year-old signed in as an adult: Adults only, never Only me.
        {
          who: noor,
          what: '15 as an adult, own vaccination record',
          body: { type_key: 'vaccination_record', owner_member_id: 'self' },
          want: 'adults',
          not: [teen],
          sees: [noor, mum, dad],
        },
        {
          who: noor,
          what: '15 as an adult, own visit summary',
          body: { type_key: 'visit_summary', owner_member_id: 'self' },
          want: 'private',
          not: [mum, dad],
          sees: [noor],
        },
        // 18 by his date of birth, though still signed in as a teen: Only
        // me, as a grown-up's (the review, 11) — never Everyone.
        {
          who: grownTeen,
          what: 'grown teen sign-in, own vaccination record',
          body: { type_key: 'vaccination_record' },
          want: 'private',
          not: [mum, dad, teen],
          sees: [grownTeen],
        },
        // A grown-up son's own: Only me, as H1a has it; turning 18 governs.
        {
          who: son,
          what: 'son, own vaccination record',
          body: { type_key: 'vaccination_record', owner_member_id: 'self' },
          want: 'private',
          not: [mum, dad],
          sees: [son],
        },
        {
          who: son,
          what: 'son, own insurance card',
          body: { type_key: 'insurance_card', owner_member_id: 'self' },
          want: 'private',
          not: [mum, dad],
          sees: [son],
        },
        // A parent's paper about the teen: the parent's choice, Adults only.
        {
          who: mum,
          what: 'mum, the teen’s vaccination record',
          body: { type_key: 'vaccination_record', owner_member_id: 'teen' },
          want: 'adults',
          not: [teen],
          sees: [mum, dad],
        },
        // A parent's own: Adults only, as the kind says; not the teen.
        {
          who: dad,
          what: 'dad, own advance directive',
          body: { type_key: 'advance_directive', owner_member_id: 'self' },
          want: 'adults',
          not: [teen],
          sees: [dad, mum],
        },
      ];
      const got: string[] = [];
      const want: string[] = [];
      for (const c of cases) {
        const body: Record<string, unknown> = { title: `H3 ${c.what}`, ...c.body };
        if (body.owner_member_id === 'self') body.owner_member_id = c.who.member_id;
        else if (body.owner_member_id === 'teen') body.owner_member_id = teen.member_id;
        const doc = await make(c.who, body);
        expect(doc.sensitive_effective, c.what).toBe(true);
        got.push(`${c.what}: ${doc.visibility}`);
        want.push(`${c.what}: ${c.want}`);
        for (const n of c.not) expect(await seen(n, doc.id), `${c.what}, not given`).toBe(404);
        for (const s of c.sees) expect(await seen(s, doc.id), `${c.what}, given`).toBe(200);
      }
      expect(got).toEqual(want);
    });

    it('a teen narrows her own vaccination record to Only me later (A72), and it is hers alone', async () => {
      const vax = await make(teen, { title: 'H3 Tia narrows', type_key: 'vaccination_record' });
      expect(vax.visibility).toBe('household');
      await ok(
        call('POST', `/api/v1/documents/${vax.id}/visibility`, { visibility: 'private' }, teen),
      );
      const narrowed = await ok<DocumentView>(
        call('GET', `/api/v1/documents/${vax.id}`, undefined, teen),
      );
      expect(narrowed.visibility).toBe('private');
      expect(await seen(mum, vax.id)).toBe(404);
      expect(await seen(dad, vax.id)).toBe(404);
      expect(await seen(teen, vax.id)).toBe(200);
    });

    it('a capture: a teen’s vaccination record for their parents too, any other health paper Only me', async () => {
      const vax = await capture(teen, { type_key: 'vaccination_record' });
      expect(vax.statusCode, vax.body).toBe(201);
      const vaxId = json<{ document_id: string }>(vax).document_id;
      expect(
        (await ok<DocumentView>(call('GET', `/api/v1/documents/${vaxId}`, undefined, teen)))
          .visibility,
      ).toBe('household');
      expect(await seen(mum, vaxId)).toBe(200);
      const lab = await capture(teen, { type_key: 'lab_result' });
      expect(lab.statusCode, lab.body).toBe(201);
      const labId = json<{ document_id: string }>(lab).document_id;
      expect(await seen(mum, labId)).toBe(404);
      expect(await seen(dad, labId)).toBe(404);
      const sons = await capture(son, {
        type_key: 'vaccination_record',
        owner_member_id: son.member_id,
      });
      expect(sons.statusCode, sons.body).toBe(201);
      expect(await seen(mum, json<{ document_id: string }>(sons).document_id)).toBe(404);
    });

    it('a batch’s accept: the same rule', async () => {
      const batch = await ok<BatchDetail>(
        call('POST', '/api/v1/batches', { name: 'Tia’s papers' }, teen),
        201,
      );
      const item = async () => {
        const form = new FormData();
        form.append('file', PDF(randomUUID()), {
          filename: 'paper.pdf',
          contentType: 'application/pdf',
        });
        const res = await h.app.inject({
          method: 'POST',
          url: `/api/v1/batches/${batch.id}/items`,
          headers: { ...h.as(teen), ...form.getHeaders() },
          payload: form.getBuffer(),
        });
        expect(res.statusCode, res.body).toBe(201);
        return json<BatchItemView>(res);
      };
      const accept = async (body: Record<string, unknown>) =>
        ok<BatchAccepted>(
          call('POST', `/api/v1/batches/${batch.id}/items/${(await item()).id}/accept`, body, teen),
          201,
        );
      const vax = await accept({ type_key: 'vaccination_record' });
      expect(await seen(mum, vax.document_id)).toBe(200);
      const scan = await accept({ type_key: 'imaging_report' });
      expect(await seen(mum, scan.document_id)).toBe(404);
    });
  });

  // ------------------------------------------------- details and reminders

  describe('the dates they remind from', () => {
    it('a prescription reminds from its Next refill, and from its Expires when it has none', async () => {
      const refill = addDays(today(), 10);
      const rx = await make(mum, {
        title: 'H3 inhaler',
        type_key: 'prescription',
        owner_member_id: mum.member_id,
        extra: { medication: 'Salbutamol', refill_date: { date: refill, precision: 'day' } },
      });
      const mine = (await reminders(mum, rx.id)).filter((r) => r.kind === 'derived');
      expect(mine.map((r) => [r.source, r.lead_days, r.fire_at])).toEqual([
        ['refill_date', 7, addDays(refill, -7)],
        ['refill_date', 1, addDays(refill, -1)],
      ]);
      expect(mine[0]?.about).toMatch(/^Next refill: /);
      const without = await make(mum, {
        title: 'H3 cream',
        type_key: 'prescription',
        owner_member_id: mum.member_id,
        // Its Expires, as a prescription has always asked; no Next refill.
        expires: { date: addDays(today(), 300), precision: 'day' },
      });
      expect(without.status.value).not.toBe('needs_info');
      // No Next refill: reminded from its Expires, on the same days.
      const ends = addDays(today(), 300);
      const fromExpiry = await reminders(mum, without.id);
      expect(fromExpiry.map((r) => [r.source, r.lead_days, r.fire_at])).toEqual([
        ['expires', 7, addDays(ends, -7)],
        ['expires', 1, addDays(ends, -1)],
      ]);
      expect(fromExpiry[0]?.about).toMatch(/^Expires: /);
      // Edited — reminded anew, as a change of kind does — its Expires reminders are the same ones, kept.
      const renamed = await ok<DocumentView>(
        call(
          'PATCH',
          `/api/v1/documents/${without.id}`,
          { title: 'H3 cream, renamed', type_key: 'prescription' },
          mum,
          {
            'if-match': without.etag,
          },
        ),
      );
      expect((await reminders(mum, without.id)).map((r) => r.id)).toEqual(
        fromExpiry.map((r) => r.id),
      );
      // Given a Next refill: reminded from it instead; taken away, Expires again.
      const refilled = await ok<DocumentView>(
        call(
          'PATCH',
          `/api/v1/documents/${without.id}`,
          { extra: { refill_date: { date: refill, precision: 'day' } } },
          mum,
          { 'if-match': renamed.etag },
        ),
      );
      expect((await reminders(mum, without.id)).map((r) => r.source)).toEqual([
        'refill_date',
        'refill_date',
      ]);
      await ok<DocumentView>(
        call('PATCH', `/api/v1/documents/${without.id}`, { extra: { refill_date: null } }, mum, {
          'if-match': refilled.etag,
        }),
      );
      expect((await reminders(mum, without.id)).map((r) => [r.source, r.lead_days])).toEqual([
        ['expires', 7],
        ['expires', 1],
      ]);
    });

    it('an existing prescription’s Expires reminder, made before 0101, survives an edit', async () => {
      const ends = addDays(today(), 60);
      const rx = await make(mum, {
        title: 'H3 old inhaler',
        type_key: 'prescription',
        owner_member_id: mum.member_id,
        expires: { date: ends, precision: 'day' },
      });
      // As 0.9.0-dev.45 made it: 7 days before its Expires.
      await admin.query('delete from reminder where document_id = $1', [rx.id]);
      const old = await admin.query<{ id: string }>(
        `insert into reminder (household_id, document_id, kind, source, fire_at, lead_days)
         values ($1, $2, 'derived', 'expires', $3, 7) returning id`,
        [mum.household_id, rx.id, addDays(ends, -7)],
      );
      await ok<DocumentView>(
        call(
          'PATCH',
          `/api/v1/documents/${rx.id}`,
          { title: 'H3 old inhaler, edited', type_key: 'prescription' },
          mum,
          {
            'if-match': rx.etag,
          },
        ),
      );
      const now = await reminders(mum, rx.id);
      expect(now.map((r) => r.id)).toContain(old.rows[0]?.id);
      expect(now.map((r) => [r.source, r.lead_days])).toEqual([
        ['expires', 7],
        ['expires', 1],
      ]);
    });

    it('a vaccination record reminds from its Next dose due; without one, nothing is missing', async () => {
      const due = addDays(today(), 60);
      const vax = await make(mum, {
        title: 'H3 Tia’s jabs',
        type_key: 'vaccination_record',
        owner_member_id: teen.member_id,
        extra: {
          vaccines: 'HPV dose 1',
          date_given: { date: addDays(today(), -120), precision: 'day' },
          next_dose_due: { date: due, precision: 'day' },
        },
      });
      expect((await reminders(mum, vax.id)).map((r) => [r.source, r.lead_days])).toEqual([
        ['next_dose_due', 30],
        ['next_dose_due', 7],
      ]);
      // Adults only: the teen is not reminded of a paper she cannot see.
      expect(await reminders(teen, vax.id)).toEqual([]);
      const none = await make(mum, {
        title: 'H3 old jabs',
        type_key: 'vaccination_record',
        owner_member_id: teen.member_id,
      });
      expect(none.status.value).not.toBe('needs_info');
    });

    it('the kinds editor keeps a next dose unrequired, and lets it be marked so; a bill’s due date stays required', async () => {
      const changed = await ok<DocumentTypeView>(
        call('PATCH', '/api/v1/document-types/vaccination_record', { remind_leads: [14] }),
      );
      expect(changed).toMatchObject({ remind_from: 'next_dose_due', remind_leads: [14] });
      expect(changed.fields.find((f) => f.key === 'next_dose_due')?.required).toBe(false);
      const unrequired = await ok<DocumentTypeView>(
        call('PATCH', '/api/v1/document-types/vaccination_record', {
          fields: changed.fields.map((f) => ({ key: f.key, required: false })),
        }),
      );
      expect(unrequired.fields.find((f) => f.key === 'next_dose_due')?.required).toBe(false);
      // Every other reminding date is required, as since 0.5.15.
      const bill = (
        await ok<{ items: DocumentTypeView[] }>(call('GET', '/api/v1/document-types'))
      ).items.find((t) => t.key === 'utility_bill') as DocumentTypeView;
      const refused = await call('PATCH', '/api/v1/document-types/utility_bill', {
        fields: bill.fields.map((f) => ({ key: f.key, required: false })),
      });
      expect(refused.statusCode).toBe(422);
    });

    it('an insurance card reminds from its Expires; one without is not missing it', async () => {
      const ends = addDays(today(), 20);
      const card = await make(mum, {
        title: 'H3 insurance card',
        type_key: 'insurance_card',
        owner_member_id: mum.member_id,
        identifier: 'XHB847291034',
        expires: { date: ends, precision: 'day' },
      });
      // 30 days before is gone by: the nearest made due, the other to come.
      expect((await reminders(mum, card.id)).map((r) => [r.source, r.lead_days, r.status])).toEqual(
        [
          ['expires', 30, 'due'],
          ['expires', 7, 'scheduled'],
        ],
      );
      const open = await make(mum, {
        title: 'H3 card with no end',
        type_key: 'insurance_card',
        owner_member_id: mum.member_id,
      });
      expect(open.status.value).not.toBe('needs_info');
    });
  });

  // ----------------------------------------------------- a yearly review

  describe('a yearly review', () => {
    let directive: DocumentView;
    let mine: DocumentView;

    beforeAll(async () => {
      directive = await make(mum, {
        title: 'H3 Mum’s living will',
        type_key: 'advance_directive',
        owner_member_id: mum.member_id,
        visibility: 'adults',
      });
      mine = await make(mum, {
        title: 'H3 Mum’s own proxy',
        type_key: 'healthcare_proxy',
        owner_member_id: mum.member_id,
        visibility: 'private',
      });
    });

    it('starts today at the earliest, whatever day was asked', async () => {
      const on = await ok<ReminderView>(review(mum, directive.id, addDays(today(), -400)), 201);
      expect(on).toMatchObject({ fire_at: today(), status: 'due' });
      expect((await call('DELETE', `/api/v1/reminders/${on.id}`)).statusCode).toBe(204);
    });

    it('is turned off by whoever turned it on, or an owner; anybody else is told so', async () => {
      const shared = await make(dad, {
        title: 'H3 Dad’s HIPAA form for everyone',
        type_key: 'hipaa_authorization',
        owner_member_id: dad.member_id,
        visibility: 'household',
      });
      const on = await ok<ReminderView>(review(dad, shared.id, addDays(today(), 30)), 201);
      for (const who of [teen, noor]) {
        const refused = await call('DELETE', `/api/v1/reminders/${on.id}`, undefined, who);
        expect(refused.statusCode).toBe(403);
      }
      // An owner may.
      expect((await call('DELETE', `/api/v1/reminders/${on.id}`, undefined, mum)).statusCode).toBe(
        204,
      );
      const again = await ok<ReminderView>(review(dad, shared.id, addDays(today(), 30)), 201);
      expect(
        (await call('DELETE', `/api/v1/reminders/${again.id}`, undefined, dad)).statusCode,
      ).toBe(204);
      // A reminder set by hand that is not a review: as before, whoever sees it.
      const plain = await ok<ReminderView>(
        call(
          'POST',
          '/api/v1/reminders',
          { document_id: shared.id, fire_at: addDays(today(), 9), note: 'Ring the clinic' },
          dad,
        ),
        201,
      );
      expect(
        (await call('DELETE', `/api/v1/reminders/${plain.id}`, undefined, teen)).statusCode,
      ).toBe(204);
    });

    it('ends when the paper moves to a kind it is not for; shown while one is on', async () => {
      const paper = await make(mum, {
        title: 'H3 directive that is a letter',
        type_key: 'advance_directive',
        owner_member_id: mum.member_id,
        visibility: 'adults',
      });
      await ok<ReminderView>(review(mum, paper.id, addDays(today(), 60)), 201);
      await ok<DocumentView>(
        call('PATCH', `/api/v1/documents/${paper.id}`, { type_key: 'visit_summary' }, mum, {
          'if-match': paper.etag,
        }),
      );
      expect(await reminders(mum, paper.id)).toEqual([]);
      const r = await admin.query('select status from reminder where document_id = $1 and review', [
        paper.id,
      ]);
      expect(r.rows).toEqual([{ status: 'resolved' }]);
    });

    it('a caregiver reads the Only me paper, but its review is not hers to see or set', async () => {
      await admin.query(
        `insert into caregiver_grant
           (household_id, person_member_id, caregiver_member_id, person_confirmed_at)
         values ($1, $2, $3, now())`,
        [mum.household_id, mum.member_id, dad.member_id],
      );
      try {
        const on = await ok<ReminderView>(review(mum, mine.id, addDays(today(), 70)), 201);
        expect(await seen(dad, mine.id)).toBe(200);
        expect(await reminders(dad, mine.id)).toEqual([]);
        expect((await review(dad, mine.id, addDays(today(), 70))).statusCode).toBe(404);
        expect(
          (await call('DELETE', `/api/v1/reminders/${on.id}`, undefined, dad)).statusCode,
        ).toBe(404);
        expect((await call('DELETE', `/api/v1/reminders/${on.id}`)).statusCode).toBe(204);
      } finally {
        await admin.query('delete from caregiver_grant where caregiver_member_id = $1', [
          dad.member_id,
        ]);
      }
    });

    it('is off until somebody turns it on; on, it is one reminder repeating every year', async () => {
      expect(await reminders(mum, directive.id)).toEqual([]);
      const day = addDays(today(), 100);
      const on = await ok<ReminderView>(review(mum, directive.id, day), 201);
      expect(on).toMatchObject({
        kind: 'manual',
        recurrence: 'annual',
        note: REVIEW_NOTE,
        review: true,
        fire_at: day,
        status: 'scheduled',
      });
      // Turned on again: the one there is.
      const again = await ok<ReminderView>(review(mum, directive.id, addDays(day, 5)), 201);
      expect(again.id).toBe(on.id);
      expect((await reminders(mum, directive.id)).map((r) => r.id)).toEqual([on.id]);
      // Dad sees the paper, and its review.
      expect((await reminders(dad, directive.id)).map((r) => r.id)).toEqual([on.id]);
      // Off: removed, and nothing reminds.
      expect((await call('DELETE', `/api/v1/reminders/${on.id}`)).statusCode).toBe(204);
      expect(await reminders(mum, directive.id)).toEqual([]);
    });

    it('is for an advance directive, a proxy or a HIPAA authorization, and repeats every year', async () => {
      const lab = await make(mum, { title: 'H3 bloods', type_key: 'lab_result' });
      const refused = await review(mum, lab.id, addDays(today(), 30));
      expect(refused.statusCode).toBe(422);
      expect(json<{ error: { detail: string } }>(refused).error.detail).toBe('review');
      const monthly = await review(mum, directive.id, addDays(today(), 30), {
        recurrence: 'monthly',
      });
      expect(monthly.statusCode).toBe(422);
      expect(await reminders(mum, lab.id)).toEqual([]);
    });

    it('nobody else sees or sets one on a paper they cannot see', async () => {
      const on = await ok<ReminderView>(review(mum, mine.id, addDays(today(), 50)), 201);
      // Dad and the teen asking for that paper's are given none, and cannot set one.
      expect(await reminders(dad, mine.id)).toEqual([]);
      expect(await reminders(teen, mine.id)).toEqual([]);
      expect((await reminders(dad)).some((r) => r.id === on.id)).toBe(false);
      expect((await review(dad, mine.id, addDays(today(), 50))).statusCode).toBe(404);
      expect((await review(teen, directive.id, addDays(today(), 50))).statusCode).toBe(404);
      // Nor Done, Snooze or remove it.
      for (const [method, url, body] of [
        ['POST', `/api/v1/reminders/${on.id}/acknowledge`, {}],
        ['POST', `/api/v1/reminders/${on.id}/snooze`, { until: addDays(today(), 3) }],
        ['DELETE', `/api/v1/reminders/${on.id}`, undefined],
      ] as const) {
        const res = await call(method, url, body, dad);
        expect(res.statusCode, `${method} ${url}`).toBe(404);
        expect(res.body).not.toContain('Mum’s own proxy');
      }
      expect((await call('DELETE', `/api/v1/reminders/${on.id}`)).statusCode).toBe(204);
    });

    it('a teen may set one on a paper the family shares with her, twice at once made once', async () => {
      const shared = await make(dad, {
        title: 'H3 Dad’s proxy for everyone',
        type_key: 'healthcare_proxy',
        owner_member_id: dad.member_id,
        visibility: 'household',
      });
      const day = addDays(today(), 90);
      const [a, b] = await Promise.all([
        ok<ReminderView>(review(teen, shared.id, day), 201),
        ok<ReminderView>(review(dad, shared.id, day), 201),
      ]);
      expect(a.id).toBe(b.id);
      expect((await reminders(teen, shared.id)).map((r) => r.id)).toEqual([a.id]);
    });

    it('Done brings the next a year on — on the day, late, or early', async () => {
      const t = today();
      const at = async (fireAt: string) => {
        const on = await ok<ReminderView>(review(mum, directive.id, fireAt), 201);
        // A day gone by is never asked for (it starts today): one long left undone, as it would be.
        if (fireAt < t) {
          await admin.query("update reminder set fire_at = $1, status = 'due' where id = $2", [
            fireAt,
            on.id,
          ]);
        }
        const done = await ok<ReminderView>(
          call('POST', `/api/v1/reminders/${on.id}/acknowledge`, {}),
        );
        expect((await call('DELETE', `/api/v1/reminders/${on.id}`)).statusCode).toBe(204);
        return done;
      };
      // Due today.
      expect(await at(t)).toMatchObject({ fire_at: addMonths(t, 12), status: 'scheduled' });
      // Two years overdue: the next after today.
      const late = addMonths(addDays(t, -10), -24);
      expect((await at(late)).fire_at).toBe(addMonths(late, 36));
      // Done before its day: the year after its day.
      const early = addDays(t, 40);
      expect((await at(early)).fire_at).toBe(addMonths(early, 12));
    });

    it('Snooze waits as any reminder does; Done after it, a year on from its day', async () => {
      const t = today();
      const on = await ok<ReminderView>(review(mum, directive.id, t), 201);
      expect(on.status).toBe('due');
      const later = await ok<ReminderView>(
        call('POST', `/api/v1/reminders/${on.id}/snooze`, { until: addDays(t, 7) }),
      );
      expect(later).toMatchObject({ status: 'snoozed', snoozed_until: addDays(t, 7) });
      const done = await ok<ReminderView>(
        call('POST', `/api/v1/reminders/${on.id}/acknowledge`, {}),
      );
      expect(done).toMatchObject({
        status: 'scheduled',
        snoozed_until: null,
        fire_at: addMonths(t, 12),
      });
      expect((await call('DELETE', `/api/v1/reminders/${on.id}`)).statusCode).toBe(204);
    });

    it('falls due by the household’s calendar, wherever the server is', async () => {
      // A zone whose day is not the server's (UTC's) now: a day ahead of it
      // late in UTC's day, a day behind early in it.
      const utc = new Date().toISOString().slice(0, 10);
      zone = new Date().getUTCHours() >= 12 ? 'Pacific/Kiritimati' : 'Pacific/Pago_Pago';
      await admin.query('update household set timezone = $1 where id = $2', [
        zone,
        mum.household_id,
      ]);
      try {
        const home = today();
        expect(home).not.toBe(utc);
        // Today at home: due now; a day after it: not yet, wherever UTC is.
        const now = await ok<ReminderView>(review(mum, directive.id, home), 201);
        expect(now.status).toBe('due');
        const done = await ok<ReminderView>(
          call('POST', `/api/v1/reminders/${now.id}/acknowledge`, {}),
        );
        expect(done.fire_at).toBe(addMonths(home, 12));
        expect((await call('DELETE', `/api/v1/reminders/${now.id}`)).statusCode).toBe(204);
        const ahead = await ok<ReminderView>(review(mum, directive.id, addDays(home, 1)), 201);
        expect(ahead.status).toBe('scheduled');
        expect((await call('DELETE', `/api/v1/reminders/${ahead.id}`)).statusCode).toBe(204);
      } finally {
        await admin.query("update household set timezone = 'UTC' where id = $1", [
          mum.household_id,
        ]);
        zone = 'UTC';
      }
    });

    it('a new version of the paper leaves it be; the paper’s other reminders are resolved', async () => {
      const upload = async () => {
        const form = new FormData();
        form.append('file', PDF(randomUUID()), {
          filename: 'living-will.pdf',
          contentType: 'application/pdf',
        });
        const up = await h.app.inject({
          method: 'POST',
          url: `/api/v1/documents/${directive.id}/versions`,
          headers: { ...h.as(mum), ...form.getHeaders(), 'idempotency-key': randomUUID() },
          payload: form.getBuffer(),
        });
        expect(up.statusCode, up.body).toBeLessThan(300);
      };
      // Its first file; then a review and a reminder of Mum's own.
      await upload();
      const on = await ok<ReminderView>(review(mum, directive.id, addDays(today(), 200)), 201);
      const other = await ok<ReminderView>(
        call('POST', '/api/v1/reminders', {
          document_id: directive.id,
          fire_at: addDays(today(), 20),
          note: 'Ask the solicitor',
        }),
        201,
      );
      // A new version: renewed, as REM-08 has it.
      await upload();
      const after = await reminders(mum, directive.id);
      expect(after.map((r) => r.id)).toEqual([on.id]);
      expect(after.some((r) => r.id === other.id)).toBe(false);
      expect((await call('DELETE', `/api/v1/reminders/${on.id}`)).statusCode).toBe(204);
    });
  });
});
