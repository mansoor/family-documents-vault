import { randomUUID } from 'node:crypto';
import { testAdminUrl } from '@fdv/db/testing';
import type { DocumentView } from '@fdv/shared';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import type { CreatedShare } from '../documents/shares.js';
import { createHarness, type Harness } from '../test-harness.js';
import { SMS_TEXT_JOB } from './text-job.js';

/**
 * A link opened (0.9.0, SMS2): the API asks the worker (`sms.text`) to tell
 * its maker, once the open is kept — the household and the link, and
 * nothing of the document or who opened it. A try that is refused asks
 * nothing. Whether the maker hears, and when, is the worker's to decide
 * (apps/worker/src/jobs/texts.test.ts).
 */
describe.skipIf(!testAdminUrl())('a link opened asks the worker to tell its maker', () => {
  let h: Harness;
  let owner: Tokens;

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();
  });
  afterAll(async () => {
    await h?.close();
  });

  const texts = () => h.jobs.filter((j) => j.name === SMS_TEXT_JOB);

  it('queues one job when the link opens, and none for a wrong PIN', async () => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(owner),
      payload: { title: 'Tenancy agreement for the flat', type_key: 'utility_bill' },
    });
    const id = created.json<DocumentView>().id;
    const form = new FormData();
    form.append(
      'file',
      Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'),
      { filename: 'scan.pdf', contentType: 'application/pdf' },
    );
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${id}/versions`,
      headers: { ...h.as(owner), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    const made = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${id}/share`,
      headers: h.as(owner),
      payload: { recipient_label: 'the letting agent', with_pin: true },
    });
    expect(made.statusCode, made.body).toBe(201);
    const link = made.json<CreatedShare>();
    const unlock = (secret: string) =>
      h.app.inject({
        method: 'POST',
        url: '/api/v1/shared/unlock',
        payload: { token: link.link_token, secret },
        remoteAddress: '10.9.0.1',
      });
    const wrong = link.pin === '0000' ? '1111' : '0000';
    expect((await unlock(wrong)).statusCode).not.toBe(200);
    expect(texts()).toEqual([]);
    const opened = await unlock(link.pin as string);
    expect(opened.statusCode, opened.body).toBe(200);
    expect(texts()).toEqual([
      {
        name: SMS_TEXT_JOB,
        data: {
          kind: 'share_opened',
          household_id: owner.household_id,
          share_id: link.share.id,
        },
      },
    ]);
    expect(JSON.stringify(texts())).not.toMatch(/Tenancy|letting agent|10\.9/);
  });
});
