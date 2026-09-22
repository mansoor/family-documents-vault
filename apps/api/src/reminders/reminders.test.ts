import { randomUUID } from 'node:crypto';
import { testAdminUrl } from '@fdv/db/testing';
import { addDays, type DocumentView, type ReminderView } from '@fdv/shared';
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
    const due = (await list('due')).filter((r) => r.document_id === doc.id);
    expect(due.map((r) => r.lead_days)).toEqual([270, 180]);
    expect(due[0]?.label).toMatch(/^Overdue by \d+ days$/);
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
    expect((await list('due')).filter((r) => r.document_id === doc.id)).toHaveLength(2);
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
    expect((await list('due')).filter((r) => r.document_id === doc.id)).toHaveLength(2);
    await upload(); // the renewed one does
    expect((await list()).filter((r) => r.document_id === doc.id)).toEqual([]);
  });

  it('deleting a document drops its derived reminders; restoring brings them back', async () => {
    const doc = await create({
      type_key: 'visa',
      title: 'Visa',
      expires: { date: addDays(today, 30), precision: 'day' },
    });
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
