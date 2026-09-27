import { randomUUID } from 'node:crypto';
import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import { addDays, type DocumentTypeView, type DocumentView, type ReminderView } from '@fdv/shared';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
const today = new Date().toISOString().slice(0, 10);

describe.skipIf(!testAdminUrl())('reminders', () => {
  let h: Harness;
  let owner: Tokens;
  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();
  });
  afterAll(() => h.close());

  const list = (state = 'all') =>
    h.app
      .inject({ url: `/api/v1/reminders?state=${state}`, headers: h.as(owner) })
      .then((r) => r.json<{ items: ReminderView[] }>().items);
  const create = (body: Record<string, unknown>) =>
    h.app
      .inject({
        method: 'POST',
        url: '/api/v1/documents',
        headers: h.as(owner),
        payload: { owner_member_id: owner.member_id, ...body },
      })
      .then((r) => r.json<DocumentView>());

  it('a passport with 4 years left gets two scheduled reminders at 9 and 6 months before', async () => {
    const expires = addDays(today, 4 * 365);
    const doc = await create({
      type_key: 'passport',
      title: 'Passport',
      expires: { date: expires, precision: 'day' },
    });
    const items = (await list()).filter((r) => r.document_id === doc.id);
    expect(items.map((r) => [r.kind, r.lead_days, r.status, r.fire_at])).toEqual([
      ['derived', 270, 'scheduled', addDays(expires, -270)],
      ['derived', 180, 'scheduled', addDays(expires, -180)],
    ]);
    expect(items[0]?.label).toMatch(/^In \d+ days · /);
  });

  it('a passport with 2 months left is due straight away, and shows in the due list', async () => {
    const doc = await create({
      type_key: 'passport',
      title: 'Soon',
      expires: { date: addDays(today, 60), precision: 'day' },
    });
    // Both lead days have passed: only the nearer is made due (0.5.15), one
    // line in the digest, not two.
    const due = (await list('due')).filter((r) => r.document_id === doc.id);
    expect(due.map((r) => r.lead_days)).toEqual([180]);
    expect(due[0]?.label).toMatch(/^Overdue by \d+ days$/);
    expect((await list()).filter((r) => r.document_id === doc.id)).toHaveLength(1);
  });

  it('changing the expiry regenerates derived reminders and leaves manual ones alone', async () => {
    const doc = await create({
      type_key: 'drivers_licence',
      title: 'Licence',
      expires: { date: addDays(today, 400), precision: 'day' },
    });
    const manual = await h.app.inject({
      method: 'POST',
      url: '/api/v1/reminders',
      headers: h.as(owner),
      payload: { document_id: doc.id, fire_at: addDays(today, 10), note: 'Book the eye test' },
    });
    expect(manual.statusCode).toBe(201);
    expect(manual.json<ReminderView>().status).toBe('scheduled');

    const newExpiry = addDays(today, 800);
    await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/documents/${doc.id}`,
      headers: h.as(owner),
      payload: { expires: { date: newExpiry, precision: 'day' } },
    });
    const items = (await list()).filter((r) => r.document_id === doc.id);
    expect(items.filter((r) => r.kind === 'derived').map((r) => r.fire_at)).toEqual([
      addDays(newExpiry, -60),
      addDays(newExpiry, -14),
    ]);
    expect(items.filter((r) => r.kind === 'manual')).toHaveLength(1);
  });

  it('snooze is honest: a week, a month, or until expiry; then Done', async () => {
    const doc = await create({
      type_key: 'insurance_policy',
      title: 'Car insurance',
      expires: { date: addDays(today, 10), precision: 'day' },
    });
    const due = (await list('due')).filter((r) => r.document_id === doc.id);
    const r = due[0] as ReminderView;

    const week = await h.app.inject({
      method: 'POST',
      url: `/api/v1/reminders/${r.id}/snooze`,
      headers: h.as(owner),
      payload: { until: addDays(today, 7) },
    });
    expect(week.statusCode).toBe(200);
    expect(week.json<ReminderView>()).toMatchObject({
      status: 'snoozed',
      snoozed_until: addDays(today, 7),
    });
    expect(week.json<ReminderView>().label).toMatch(/^Later · /);

    const untilExpiry = await h.app.inject({
      method: 'POST',
      url: `/api/v1/reminders/${r.id}/snooze`,
      headers: h.as(owner),
      payload: { until: 'expiry' },
    });
    expect(untilExpiry.json<ReminderView>().snoozed_until).toBe(addDays(today, 10));

    const past = await h.app.inject({
      method: 'POST',
      url: `/api/v1/reminders/${r.id}/snooze`,
      headers: h.as(owner),
      payload: { until: addDays(today, -1) },
    });
    expect(past.statusCode).toBe(422);

    const done = await h.app.inject({
      method: 'POST',
      url: `/api/v1/reminders/${r.id}/acknowledge`,
      headers: h.as(owner),
    });
    expect(done.json<ReminderView>().status).toBe('acknowledged');
    expect((await list()).find((x) => x.id === r.id)).toBeUndefined();
  });

  it('a recurring manual reminder reschedules itself when done', async () => {
    const doc = await create({ type_key: 'utility_bill', title: 'Electricity' });
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/reminders',
      headers: h.as(owner),
      payload: { document_id: doc.id, fire_at: today, recurrence: 'monthly', note: 'Pay the bill' },
    });
    const r = created.json<ReminderView>();
    expect(r.status).toBe('due');
    const done = await h.app.inject({
      method: 'POST',
      url: `/api/v1/reminders/${r.id}/acknowledge`,
      headers: h.as(owner),
    });
    const next = done.json<ReminderView>();
    expect(next.status).toBe('scheduled');
    expect(next.fire_at > today).toBe(true);
    expect(next.note).toBe('Pay the bill');

    const bad = await h.app.inject({
      method: 'POST',
      url: '/api/v1/reminders',
      headers: h.as(owner),
      payload: { document_id: doc.id, fire_at: today, recurrence: 'weekly' },
    });
    expect(bad.statusCode).toBe(422);
    const removed = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/reminders/${r.id}`,
      headers: h.as(owner),
    });
    expect(removed.statusCode).toBe(204);
  });

  it('uploading a renewed version resolves the open reminders (REM-08)', async () => {
    const doc = await create({
      type_key: 'vehicle_registration',
      title: 'CR-V registration',
      expires: { date: addDays(today, 5), precision: 'day' },
    });
    // 45 and 7 days before: both passed, the nearer due (0.5.15).
    expect((await list('due')).filter((r) => r.document_id === doc.id)).toHaveLength(1);
    const upload = async () => {
      const form = new FormData();
      form.append('file', PDF, { filename: 'reg.pdf', contentType: 'application/pdf' });
      return h.app.inject({
        method: 'POST',
        url: `/api/v1/documents/${doc.id}/versions`,
        headers: { ...h.as(owner), ...form.getHeaders(), 'idempotency-key': randomUUID() },
        payload: form.getBuffer(),
      });
    };
    await upload(); // the first scan does not count as a renewal
    expect((await list('due')).filter((r) => r.document_id === doc.id)).toHaveLength(1);
    await upload(); // the renewed one does
    expect((await list()).filter((r) => r.document_id === doc.id)).toEqual([]);
  });

  it('deleting a document drops its derived reminders; restoring brings them back', async () => {
    const doc = await create({
      type_key: 'visa',
      title: 'Visa',
      expires: { date: addDays(today, 60), precision: 'day' },
    });
    // 120 days before has passed, and is due; 30 days before is ahead.
    expect((await list()).filter((r) => r.document_id === doc.id)).toHaveLength(2);
    await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/documents/${doc.id}`,
      headers: h.as(owner),
    });
    expect((await list()).filter((r) => r.document_id === doc.id)).toHaveLength(0);
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${doc.id}/restore`,
      headers: h.as(owner),
    });
    expect((await list()).filter((r) => r.document_id === doc.id)).toHaveLength(2);
  });

  it('the household time zone can be set from the profile', async () => {
    const ok = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/profile',
      headers: h.as(owner),
      payload: { timezone: 'Asia/Kolkata' },
    });
    expect(ok.json<{ timezone: string }>().timezone).toBe('Asia/Kolkata');
    const bad = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/profile',
      headers: h.as(owner),
      payload: { timezone: 'Mars/Olympus' },
    });
    expect(bad.statusCode).toBe(422);
  });
});

/**
 * Reminders from any date (0.5.15): a kind reminds from a date field it
 * shows — a bill's Due date, a car's MOT — as it does from Expires, and
 * each reminder says which date it is about, in the kind's words.
 */
describe.skipIf(!testAdminUrl())('reminders from a date field', () => {
  let h: Harness;
  let owner: Tokens;
  let admin: ReturnType<typeof createPool>;
  /** Council tax: reminded 7 days and 1 day before its Due date. */
  let tax: DocumentTypeView;
  /** Water: its Due date reminds, 7 days before; it expires as well. */
  let water: DocumentTypeView;

  const send = (method: 'POST' | 'PATCH', url: string, payload: unknown) =>
    h.app.inject({ method, url, headers: h.as(owner), payload: payload as object });
  const made = async <T>(r: Promise<{ statusCode: number; body: string; json: () => unknown }>) => {
    const res = await r;
    expect(res.statusCode, res.body).toBeLessThan(300);
    return res.json() as T;
  };
  const due = (days: number) => ({ due_date: { date: addDays(today, days), precision: 'day' } });
  const file = (body: Record<string, unknown>) =>
    made<DocumentView>(
      send('POST', '/api/v1/documents', { owner_member_id: owner.member_id, ...body }),
    );
  const mine = async (id: string) =>
    (
      await made<{ items: ReminderView[] }>(
        h.app.inject({ url: '/api/v1/reminders?state=all', headers: h.as(owner) }),
      )
    ).items
      .filter((r) => r.document_id === id)
      .map((r) => ({
        id: r.id,
        source: r.source,
        lead_days: r.lead_days,
        fire_at: r.fire_at,
        status: r.status,
        about: r.about,
      }));
  /** "10 Oct" as the vault says a day, with the year when it is not this one's. */
  const day = (iso: string) => {
    const short = new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });
    return iso.slice(0, 4) === today.slice(0, 4) ? short : `${short} ${iso.slice(0, 4)}`;
  };

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();
    admin = createPool(h.adminUrl, 1);
    tax = await made<DocumentTypeView>(
      send('POST', '/api/v1/document-types', {
        label: 'Council tax',
        category: 'bills',
        fields: [{ key: 'due_date' }, { key: 'amount' }],
        remind_from: 'due_date',
        remind_leads: [7, 1],
      }),
    );
    water = await made<DocumentTypeView>(
      send('POST', '/api/v1/document-types', {
        label: 'Water bill',
        category: 'bills',
        core: { expires: { shown: true } },
        fields: [{ key: 'due_date' }],
        remind_from: 'due_date',
        remind_leads: [7],
      }),
    );
  }, 60_000);
  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  it('reminders count back from the due date, and each says which date it is about', async () => {
    const bill = await file({ type_key: tax.key, title: 'Council tax, May', extra: due(20) });
    expect((await mine(bill.id)).map((r) => ({ ...r, id: typeof r.id }))).toEqual([
      {
        id: 'string',
        source: 'due_date',
        lead_days: 7,
        fire_at: addDays(today, 13),
        status: 'scheduled',
        about: `Due date: ${day(addDays(today, 20))}, in 20 days`,
      },
      {
        id: 'string',
        source: 'due_date',
        lead_days: 1,
        fire_at: addDays(today, 19),
        status: 'scheduled',
        about: `Due date: ${day(addDays(today, 20))}, in 20 days`,
      },
    ]);
    // A reminder set by hand is about nothing but itself.
    const manual = await made<ReminderView>(
      send('POST', '/api/v1/reminders', {
        document_id: bill.id,
        fire_at: addDays(today, 3),
        note: 'Set up the direct debit',
      }),
    );
    expect(manual).toMatchObject({ kind: 'manual', source: null, about: null });
  });

  it('editing the due date remakes them; editing another detail leaves them', async () => {
    const bill = await file({ type_key: tax.key, title: 'Council tax, June', extra: due(20) });
    const first = await mine(bill.id);
    await made(send('PATCH', `/api/v1/documents/${bill.id}`, { extra: due(30) }));
    expect((await mine(bill.id)).map((r) => [r.lead_days, r.fire_at])).toEqual([
      [7, addDays(today, 23)],
      [1, addDays(today, 29)],
    ]);
    // Another detail: nothing is made again. One taken away by hand stays away…
    const [seven] = await mine(bill.id);
    await admin.query('delete from reminder where id = $1', [seven?.id]);
    await made(send('PATCH', `/api/v1/documents/${bill.id}`, { extra: { amount: '£152.00' } }));
    expect((await mine(bill.id)).map((r) => r.lead_days)).toEqual([1]);
    // …until the due date is sent again, when both are as they should be.
    await made(send('PATCH', `/api/v1/documents/${bill.id}`, { extra: due(30) }));
    expect((await mine(bill.id)).map((r) => r.lead_days)).toEqual([7, 1]);
    expect(first).toHaveLength(2);
  });

  it('a due date that has passed makes none; an expiry that has passed still does', async () => {
    const paid = await file({ type_key: tax.key, title: 'Council tax, January', extra: due(-3) });
    expect(await mine(paid.id)).toEqual([]);
    const expired = await file({
      type_key: 'passport',
      title: 'Old passport',
      identifier: 'P-OLD',
      expires: { date: addDays(today, -10), precision: 'day' },
    });
    expect((await mine(expired.id)).map((r) => [r.source, r.lead_days, r.status])).toEqual([
      ['expires', 180, 'due'],
    ]);
  });

  it('a detail edit after the due date keeps the overdue reminder', async () => {
    const bill = await file({ type_key: tax.key, title: 'Council tax, July', extra: due(3) });
    expect((await mine(bill.id)).map((r) => [r.lead_days, r.status])).toEqual([
      [7, 'due'],
      [1, 'scheduled'],
    ]);
    // Five days on: the due date was two days ago, and nobody dealt with it.
    await admin.query(
      `update document set extra = jsonb_set(extra, '{due_date,date}', to_jsonb($2::text))
        where id = $1`,
      [bill.id, addDays(today, -2)],
    );
    await admin.query(
      "update reminder set fire_at = fire_at - 5, status = 'due' where document_id = $1",
      [bill.id],
    );
    const held = await mine(bill.id);
    // The date sent again, or put right to another day gone by: nothing is
    // made, and nothing anybody has not dealt with is taken away.
    await made(send('PATCH', `/api/v1/documents/${bill.id}`, { extra: due(-2) }));
    expect(await mine(bill.id)).toEqual(held);
    await made(send('PATCH', `/api/v1/documents/${bill.id}`, { extra: due(-1) }));
    expect((await mine(bill.id)).map((r) => r.id)).toEqual(held.map((r) => r.id));
    // Taken away, it takes its reminders with it, as an expiry's does.
    await made(send('PATCH', `/api/v1/documents/${bill.id}`, { extra: { due_date: null } }));
    expect(await mine(bill.id)).toEqual([]);
  });

  it('filed after two lead days have passed, only the nearer is due', async () => {
    const bill = await file({ type_key: tax.key, title: 'Council tax, August', extra: due(0) });
    expect((await mine(bill.id)).map((r) => [r.lead_days, r.status, r.about])).toEqual([
      [1, 'due', `Due date: ${day(today)}, today`],
    ]);
    // Edited again, the farther one is not made due behind it.
    await made(send('PATCH', `/api/v1/documents/${bill.id}`, { extra: due(0) }));
    expect((await mine(bill.id)).map((r) => r.lead_days)).toEqual([1]);
  });

  it("the line uses the kind's word: Due date, Expires, Review by, MOT", async () => {
    const bill = await file({ type_key: tax.key, title: 'Council tax, September', extra: due(5) });
    const passport = await file({
      type_key: 'passport',
      title: 'Passport',
      identifier: 'P-1',
      expires: { date: addDays(today, 100), precision: 'day' },
    });
    const will = await file({
      type_key: 'will',
      title: 'Will',
      expires: { date: addDays(today, 10), precision: 'day' },
    });
    const mot = await made<{ key: string }>(
      send('POST', '/api/v1/document-attributes', { label: 'MOT', kind: 'date' }),
    );
    const car = await made<DocumentTypeView>(
      send('POST', '/api/v1/document-types', {
        label: 'Car',
        category: 'property',
        fields: [{ key: mot.key }],
        remind_from: mot.key,
        remind_leads: [30],
      }),
    );
    const estate = await file({
      type_key: car.key,
      title: 'Estate car',
      extra: { [mot.key]: { date: addDays(today, 40), precision: 'day' } },
    });
    const first = async (id: string) => (await mine(id))[0]?.about;
    expect(await first(bill.id)).toBe(`Due date: ${day(addDays(today, 5))}, in 5 days`);
    expect(await first(passport.id)).toBe(`Expires: ${day(addDays(today, 100))}, in 3 months`);
    expect(await first(will.id)).toBe(`Review by: ${day(addDays(today, 10))}, in 10 days`);
    expect(await first(estate.id)).toBe(`MOT: ${day(addDays(today, 40))}, in 40 days`);
    // The label older phones show is as it was.
    expect((await mine(passport.id))[0]).toMatchObject({ source: 'expires', lead_days: 180 });
  });

  it("a month's snooze of a bill due in 9 days waits 9 days", async () => {
    const bill = await file({ type_key: tax.key, title: 'Council tax, October', extra: due(9) });
    const [seven] = await mine(bill.id);
    const snoozed = await made<ReminderView>(
      send('POST', `/api/v1/reminders/${seven?.id}/snooze`, { until: addDays(today, 30) }),
    );
    expect(snoozed).toMatchObject({ status: 'snoozed', snoozed_until: addDays(today, 9) });
    // A day before it is kept as asked.
    const sooner = await made<ReminderView>(
      send('POST', `/api/v1/reminders/${seven?.id}/snooze`, { until: addDays(today, 4) }),
    );
    expect(sooner.snoozed_until).toBe(addDays(today, 4));
  });

  it('snoozing until the date waits for the due date, not the expiry', async () => {
    const bill = await file({
      type_key: water.key,
      title: 'Water, spring',
      expires: { date: addDays(today, 100), precision: 'day' },
      extra: due(9),
    });
    const [seven] = await mine(bill.id);
    expect(seven).toMatchObject({ source: 'due_date', lead_days: 7 });
    const snoozed = await made<ReminderView>(
      send('POST', `/api/v1/reminders/${seven?.id}/snooze`, { until: 'expiry' }),
    );
    expect(snoozed.snoozed_until).toBe(addDays(today, 9));
  });
});
