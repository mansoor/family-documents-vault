import { randomUUID } from 'node:crypto';
import { withHousehold } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { DocumentView } from '@fdv/shared';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../test-harness.js';
import { SoftwareAuthenticator } from './passkey-test-authenticator.js';
import type { Tokens } from './service.js';

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

/**
 * SEC-17: a live session is not the same as someone being there. These are
 * the actions where the difference matters, and the point of the tests is
 * the refusals — that each one asks, says which action it is asking about,
 * and lets the work through once a credential has been presented.
 */
describe.skipIf(!testAdminUrl())('step-up authentication', () => {
  let h: Harness;
  let owner: Tokens;
  let essentialVersion: string;
  let ordinaryVersion: string;

  const upload = async (documentId: string) => {
    const form = new FormData();
    form.append('file', PDF, { filename: 'scan.pdf', contentType: 'application/pdf' });
    const up = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/versions`,
      headers: { ...h.as(owner), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    return up.json<{ id: string }>().id;
  };

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();

    const essential = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(owner),
      payload: { title: 'Passport', type_key: 'passport', owner_member_id: owner.member_id },
    });
    essentialVersion = await upload(essential.json<DocumentView>().id);

    const ordinary = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(owner),
      payload: { title: 'Electricity bill', type_key: 'utility_bill' },
    });
    ordinaryVersion = await upload(ordinary.json<DocumentView>().id);
  }, 60_000);
  afterAll(() => h.close());

  /** Puts the session's last credential far enough in the past to matter. */
  const goStale = async () =>
    withHousehold(h.db, owner.household_id, (trx) =>
      trx
        .updateTable('session')
        .set({ verified_at: new Date(Date.now() - 10 * 60 * 1000) })
        .execute(),
    );

  const stepUp = (payload: Record<string, unknown>) =>
    h.app.inject({ method: 'POST', url: '/api/v1/auth/step-up', headers: h.as(owner), payload });

  const json = <T>(r: { json: () => unknown }) => r.json() as T;

  it('a fresh session is not asked anything', async () => {
    const fresh = json<{ expires_in: number; verified_at: string | null }>(
      await h.app.inject({ url: '/api/v1/auth/step-up', headers: h.as(owner) }),
    );
    expect(fresh.verified_at).not.toBeNull();
    expect(fresh.expires_in).toBeGreaterThan(250);

    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: '/api/v1/exports',
          headers: h.as(owner),
        })
      ).statusCode,
    ).toBe(202);
  });

  it('once it goes stale, each consequential action asks — and says which', async () => {
    await goStale();
    const cases: Array<[string, () => Promise<{ statusCode: number; json: () => unknown }>]> = [
      [
        'export_everything',
        () => h.app.inject({ method: 'POST', url: '/api/v1/exports', headers: h.as(owner) }),
      ],
      [
        'change_people',
        () =>
          h.app.inject({
            method: 'POST',
            url: '/api/v1/members',
            headers: h.as(owner),
            payload: { display_name: 'Someone new' },
          }),
      ],
      [
        'change_storage',
        () =>
          h.app.inject({
            method: 'POST',
            url: '/api/v1/vaults',
            headers: h.as(owner),
            payload: {
              provider: 'other',
              label: 'Bucket',
              endpoint: 'https://s3.example.test',
              region: 'us-east-1',
              bucket: 'fdv',
              access_key_id: 'key',
              secret_access_key: 'secret',
            },
          }),
      ],
      [
        'open_private_document',
        () =>
          h.app.inject({
            url: `/api/v1/versions/${essentialVersion}/content`,
            headers: h.as(owner),
          }),
      ],
    ];

    for (const [action, run] of cases) {
      const res = await run();
      expect(res.statusCode, action).toBe(403);
      const body = json<{ error: { code: string; action: string; message: string } }>(res);
      expect(body.error.code).toBe('step_up_required');
      expect(body.error.action).toBe(action);
      expect(body.error.message).toMatch(/^Please confirm it is you to /);
    }
  });

  it('an ordinary document still opens without being asked', async () => {
    await goStale();
    const res = await h.app.inject({
      url: `/api/v1/versions/${ordinaryVersion}/content`,
      headers: h.as(owner),
    });
    expect(res.statusCode).toBe(200);
  });

  it('a password gets the session moving again', async () => {
    await goStale();
    expect(json<{ error: { code: string } }>(await stepUp({ password: 'wrong' })).error.code).toBe(
      'invalid_credentials',
    );

    const ok = await stepUp({ password: 'correct horse battery' });
    expect(ok.statusCode).toBe(200);
    expect(json<{ expires_in: number }>(ok).expires_in).toBe(300);

    expect(
      (await h.app.inject({ method: 'POST', url: '/api/v1/exports', headers: h.as(owner) }))
        .statusCode,
    ).toBe(202);
  });

  it('so does a passkey, which is the one that proves the device is here', async () => {
    const device = new SoftwareAuthenticator();
    const options = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkeys/challenge',
      headers: h.as(owner),
    });
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkeys',
      headers: h.as(owner),
      payload: { response: device.register(options.json()), label: 'Laptop' },
    });
    expect(created.statusCode).toBe(201);

    await goStale();
    const challenge = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkey/challenge',
      payload: { email: 'owner@example.test' },
    });
    const res = await stepUp({ passkey: device.authenticate(challenge.json()) });
    expect(res.statusCode).toBe(200);
    expect(
      (await h.app.inject({ method: 'POST', url: '/api/v1/exports', headers: h.as(owner) }))
        .statusCode,
    ).toBe(202);
  });

  it('someone else’s passkey does not step this session up', async () => {
    const stranger = new SoftwareAuthenticator();
    await goStale();
    const challenge = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkey/challenge',
      payload: { email: 'owner@example.test' },
    });
    const res = await stepUp({ passkey: stranger.authenticate(challenge.json()) });
    expect(res.statusCode).toBe(401);
  });

  it('nothing presented at all is a plain 422', async () => {
    expect((await stepUp({})).statusCode).toBe(422);
  });

  it('every step-up is in the audit chain, with how it was done', async () => {
    const rows = await withHousehold(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('audit_event')
        .select(['action', 'detail'])
        .where('action', '=', 'auth.stepped_up')
        .orderBy('id')
        .execute(),
    );
    expect(rows.map((r) => (r.detail as { method: string }).method)).toEqual([
      'password',
      'passkey',
    ]);
  });
});
