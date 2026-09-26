import { randomUUID } from 'node:crypto';
import { withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { DocumentView } from '@fdv/shared';
import type { LightMyRequestResponse } from 'fastify';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';
import type { CreatedShare } from './shares.js';

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

/**
 * A share link asks as itself (5.5, 5.6).
 *
 * The one step taken as the vault is finding which share a token names.
 * Everything after it — the preview, a wrong PIN counted, the right one, the
 * file — asks as that link and no other, so 0030's rule for a link is what
 * stands between a share route and every other document in the household.
 * Each step is listened to as the database is told it, the way the worker's
 * actor.test.ts listens to its jobs.
 */
describe.skipIf(!testAdminUrl())('a share link asks as itself', () => {
  let h: Harness;
  let owner: Tokens;
  let lease: string;

  /** Every scope the API opens: its household, its actor and its share. */
  const said: Array<{ household: unknown; actor: unknown; share: unknown }> = [];

  let nth = 0;
  const peer = () => ({ remoteAddress: `10.9.${Math.floor(++nth / 200)}.${nth % 200}` });

  beforeAll(async () => {
    h = await createHarness({
      log(event) {
        if (event.level !== 'query' || !event.query.sql.includes("set_config('app.actor'")) return;
        // In the order withScope says them: household, actor, account,
        // member, role, share, upload request.
        const [household, actor, , , , share] = event.query.parameters;
        said.push({ household, actor, share });
      },
    });
    owner = await h.setup();
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(owner),
      payload: { title: 'Flat 3 tenancy agreement', type_key: 'utility_bill' },
    });
    lease = created.json<DocumentView>().id;
    const form = new FormData();
    form.append('file', PDF, { filename: 'scan.pdf', contentType: 'application/pdf' });
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${lease}/versions`,
      headers: { ...h.as(owner), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
  }, 90_000);
  afterAll(() => h.close());

  it('one lookup as the vault, then only the link, at every step', async () => {
    const made = (
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/documents/${lease}/share`,
        headers: h.as(owner),
        payload: { with_pin: true },
      })
    ).json<CreatedShare>();
    const token = made.link_token;
    const pin = made.pin as string;
    const wrong = pin === '0000' ? '1111' : '0000';

    const steps: Array<[string, () => Promise<LightMyRequestResponse>, number]> = [
      ['the preview', () => h.app.inject({ url: `/api/v1/shared/${token}`, ...peer() }), 200],
      [
        'a wrong PIN',
        () =>
          h.app.inject({
            method: 'POST',
            url: `/api/v1/shared/${token}/open`,
            payload: { pin: wrong },
            ...peer(),
          }),
        401,
      ],
      [
        'the right PIN',
        () =>
          h.app.inject({
            method: 'POST',
            url: `/api/v1/shared/${token}/open`,
            payload: { pin },
            ...peer(),
          }),
        200,
      ],
      [
        'the file',
        () => h.app.inject({ url: `/api/v1/shared/${token}/content?pin=${pin}`, ...peer() }),
        200,
      ],
    ];

    for (const [name, step, status] of steps) {
      said.length = 0;
      const res = await step();
      expect(res.statusCode, name).toBe(status);
      if (name === 'the file') expect(res.rawPayload.equals(PDF), name).toBe(true);

      const [lookup, ...after] = said;
      // Finding the share by the token's hash, as the vault: once.
      expect(lookup, name).toEqual({ household: owner.household_id, actor: 'system', share: '' });
      // Then the link, and only the link — this share, in this household.
      expect(after.length, name).toBeGreaterThan(0);
      expect(
        after.filter(
          (s) =>
            s.actor !== 'link' || s.share !== made.share.id || s.household !== owner.household_id,
        ),
        name,
      ).toEqual([]);
    }

    // Asking as the link, the wrong PIN was still counted on its own row,
    // and the right one counted as one open.
    const row = await withSystem(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('share_link')
        .select(['attempts', 'open_count'])
        .where('id', '=', made.share.id)
        .executeTakeFirstOrThrow(),
    );
    expect(row).toEqual({ attempts: 1, open_count: 1 });
  });
});
