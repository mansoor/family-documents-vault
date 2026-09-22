import { testAdminUrl } from '@fdv/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';
import type { SmtpView } from './service.js';

/** Mailpit from the dev compose file; skipped when it is not running. */
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
async function mailpitUp(): Promise<boolean> {
  try {
    const r = await fetch(`${MAILPIT}/api/v1/messages?limit=1`, {
      signal: AbortSignal.timeout(1500),
    });
    return r.ok;
  } catch {
    return false;
  }
}
const withMailpit = await mailpitUp();

/**
 * Mailpit is shared between test files, so nothing here clears the inbox:
 * each test sends from its own address and searches for that.
 */
const FROM = `api-test-${Date.now()}@example.test`;

async function findMail(
  query: string,
  tries = 20,
): Promise<{ Subject: string; To: Array<{ Address: string }> } | null> {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(query)}&limit=5`);
    const body = (await r.json()) as {
      messages?: Array<{ Subject: string; To: Array<{ Address: string }> }>;
    };
    if (body.messages?.length)
      return body.messages[0] as { Subject: string; To: Array<{ Address: string }> };
    await new Promise((res) => setTimeout(res, 250));
  }
  return null;
}

describe.skipIf(!testAdminUrl())('notifications', () => {
  let h: Harness;
  let owner: Tokens;
  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();
  });
  afterAll(() => h.close());

  const json = <T>(r: { json: () => unknown }) => r.json() as T;

  it('offers the push key without a session, so the browser can subscribe', async () => {
    const res = await h.app.inject('/api/v1/notifications/push-key');
    expect(res.statusCode).toBe(200);
    expect(json<{ enabled: boolean; public_key: string }>(res)).toEqual({
      enabled: true,
      public_key: 'test-vapid-public-key',
    });
  });

  it('registers a device, lists it, and is idempotent on the endpoint', async () => {
    const body = {
      endpoint: 'https://push.example.test/abc123',
      keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
      label: 'Android phone',
    };
    const first = await h.app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: h.as(owner),
      payload: body,
    });
    expect(first.statusCode).toBe(201);
    const again = await h.app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: h.as(owner),
      payload: { ...body, keys: { p256dh: 'rotated', auth: 'rotated' } },
    });
    expect(again.statusCode).toBe(201);
    expect(json<{ id: string }>(again).id).toBe(json<{ id: string }>(first).id);

    const list = json<{ items: Array<{ label: string; working: boolean; endpoint: string }> }>(
      await h.app.inject({ url: '/api/v1/devices', headers: h.as(owner) }),
    );
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ label: 'Android phone', working: true });

    const removed = await h.app.inject({
      method: 'DELETE',
      url: '/api/v1/devices',
      headers: h.as(owner),
      payload: { endpoint: body.endpoint },
    });
    expect(removed.statusCode).toBe(204);
    expect(
      json<{ items: unknown[] }>(
        await h.app.inject({ url: '/api/v1/devices', headers: h.as(owner) }),
      ).items,
    ).toEqual([]);
  });

  it('preferences default to push on, daily email off, weekly email on', async () => {
    const before = json<Record<string, boolean>>(
      await h.app.inject({ url: '/api/v1/notifications/preferences', headers: h.as(owner) }),
    );
    expect(before).toEqual({ daily_push: true, daily_email: false, weekly_email: true });
    const after = json<Record<string, boolean>>(
      await h.app.inject({
        method: 'PUT',
        url: '/api/v1/notifications/preferences',
        headers: h.as(owner),
        payload: { weekly_email: false },
      }),
    );
    expect(after).toMatchObject({ weekly_email: false, daily_push: true });
  });

  it('SMTP is unset, then saved as untested, and a bad server fails with a sentence', async () => {
    const before = json<SmtpView>(
      await h.app.inject({ url: '/api/v1/notifications/smtp', headers: h.as(owner) }),
    );
    expect(before.configured).toBe(false);

    const untested = await h.app.inject({
      method: 'POST',
      url: '/api/v1/notifications/smtp/test',
      headers: h.as(owner),
    });
    expect(untested.statusCode).toBe(409);

    const saved = json<SmtpView>(
      await h.app.inject({
        method: 'PUT',
        url: '/api/v1/notifications/smtp',
        headers: h.as(owner),
        payload: {
          provider: 'other',
          host: '127.0.0.1',
          port: 1,
          secure: false,
          username: 'someone',
          password: 'a secret',
          from_name: 'Family Document Vault',
          from_email: 'vault@example.test',
        },
      }),
    );
    expect(saved).toMatchObject({
      configured: true,
      status: 'untested',
      from_email: 'vault@example.test',
    });
    expect(JSON.stringify(saved)).not.toContain('a secret');

    const failed = json<{ ok: boolean; message: string }>(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/notifications/smtp/test',
        headers: h.as(owner),
      }),
    );
    expect(failed.ok).toBe(false);
    expect(failed.message).toMatch(/Nothing answered|did not answer/);
    const after = json<SmtpView>(
      await h.app.inject({ url: '/api/v1/notifications/smtp', headers: h.as(owner) }),
    );
    expect(after.status).toBe('failed');
    expect(after.last_error).toBeTruthy();
  });

  it('the stored password is encrypted, not readable from the row', async () => {
    const { withHousehold } = await import('@fdv/db');
    const row = await withHousehold(h.db, owner.household_id, (trx) =>
      trx.selectFrom('smtp_settings').select('password_encrypted').executeTakeFirstOrThrow(),
    );
    expect(row.password_encrypted).not.toBeNull();
    expect(row.password_encrypted?.toString('latin1')).not.toContain('a secret');
  });

  it.skipIf(!withMailpit)('a real send through Mailpit passes the test and arrives', async () => {
    const saved = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/notifications/smtp',
      headers: h.as(owner),
      payload: {
        provider: 'other',
        host: 'localhost',
        port: 1025,
        secure: false,
        from_name: 'The Test family',
        from_email: FROM,
      },
    });
    expect(saved.statusCode).toBe(200);
    const result = json<{ ok: boolean; message: string }>(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/notifications/smtp/test',
        headers: h.as(owner),
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/^Sent\./);

    const mail = await findMail(`from:${FROM}`);
    expect(mail?.Subject).toMatch(/^Test from /);
    expect(mail?.To[0]?.Address).toBe('owner@example.test');
    const status = json<SmtpView>(
      await h.app.inject({ url: '/api/v1/notifications/smtp', headers: h.as(owner) }),
    );
    expect(status.status).toBe('ok');
  });
});
