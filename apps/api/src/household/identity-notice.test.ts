import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { codeFor } from '../auth/totp.js';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * Who sees identity details, to be widened (5.26's notice): since 5.33 the
 * phones and browsers of everybody told hear of it too — `{v:1,
 * type:'notice'}`, the word and nothing else — beside the notice in the app
 * and the operator's mail, whether or not there is a mail server.
 */

const json = <T>(r: { json: () => unknown }) => r.json() as T;

interface PushJobData {
  household_id: string;
  message: unknown;
  targets: Array<{ id: string | null; kind: string; endpoint: string }>;
}

describe.skipIf(!testAdminUrl())('a widening, pushed as a notice (5.33)', () => {
  const harnesses: Harness[] = [];
  afterAll(async () => {
    for (const h of harnesses) await h.close();
  });

  /** An owner with two-step sign-in, an adult, a viewer; each but the owner with a device. */
  const family = async (operatorMail: boolean) => {
    const h = await createHarness({ rateLimitPerMinute: 100_000, operatorMail });
    harnesses.push(h);
    const owner = await h.setup();
    const enrol = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/enrol',
      headers: h.as(owner),
    });
    const secret = json<{ secret: string }>(enrol).secret;
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/confirm',
      headers: h.as(owner),
      payload: { code: codeFor(secret) },
    });
    const sara = await h.join(owner, {
      name: 'Sara',
      email: 'sara-notice@example.test',
      role: 'adult',
    });
    const val = await h.join(owner, {
      name: 'Val',
      email: 'val-notice@example.test',
      role: 'viewer',
    });
    const register = async (who: Tokens, payload: Record<string, unknown>) => {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/devices',
        headers: h.as(who),
        payload: { keys: { p256dh: 'p256dh-key', auth: 'auth-key' }, ...payload },
      });
      expect(res.statusCode, res.body).toBe(201);
      return json<{ id: string }>(res).id;
    };
    const phone = await register(sara, {
      kind: 'unified_push',
      endpoint: 'https://ntfy.example.test/up-sara',
    });
    const browser = await register(val, { endpoint: 'https://push.example.test/val-browser' });
    // The owner asking hears nothing; a device whose sign-in ended, nothing.
    await register(owner, { endpoint: 'https://push.example.test/owner-browser' });
    const again = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { email: 'sara-notice@example.test', password: 'another correct horse' },
      remoteAddress: '10.34.0.1',
    });
    expect(again.statusCode, again.body).toBe(200);
    const ended = await register(json<Tokens>(again), {
      endpoint: 'https://push.example.test/sara-old',
    });
    const admin = createPool(h.adminUrl, 1);
    try {
      // That second sign-in of Sara's has ended (its device is left out);
      // her first goes on.
      await admin.query(
        `update session set revoked_at = now()
          where id = (select session_id from device where id = $1)`,
        [ended],
      );
      await admin.query(
        `update session set verified_at = now(), factor_verified_at = now()
          where account_id = (select account_id from account_household where member_id = $1)`,
        [owner.member_id],
      );
    } finally {
      await admin.end();
    }
    return { h, owner, phone, browser };
  };

  for (const operatorMail of [true, false]) {
    it(`everybody told hears "notice" on their devices, and nothing else (${
      operatorMail ? 'with' : 'without'
    } the operator's mail server)`, async () => {
      const { h, owner, phone, browser } = await family(operatorMail);
      const since = h.jobs.length;
      const asked = await h.app.inject({
        method: 'PUT',
        url: '/api/v1/household/identity-audience',
        headers: h.as(owner),
        payload: { audience: 'adults' },
      });
      expect(asked.statusCode, asked.body).toBe(200);
      const pushes = h.jobs.slice(since).filter((j) => j.name === 'push.send');
      expect(pushes).toHaveLength(1);
      const job = pushes[0]?.data as unknown as PushJobData;
      expect(job.message).toEqual({ v: 1, type: 'notice' });
      expect(job.targets.map((t) => [t.id, t.kind]).sort()).toEqual(
        [
          [phone, 'unified_push'],
          [browser, 'web_push'],
        ].sort(),
      );
      // The word alone: no name, no address, not who will see, nor from when.
      const said = JSON.stringify(job.message);
      for (const word of ['Sara', 'Val', 'adults', 'notice_until', '@']) {
        expect(said).not.toContain(word);
      }
      // Beside the mail, where there is a mail server.
      const mail = h.jobs.slice(since).filter((j) => j.name === 'alert.send');
      expect(mail).toHaveLength(operatorMail ? 1 : 0);
      // Asked again for the same: nothing new, nobody pushed twice.
      await h.app.inject({
        method: 'PUT',
        url: '/api/v1/household/identity-audience',
        headers: h.as(owner),
        payload: { audience: 'adults' },
      });
      expect(h.jobs.slice(since).filter((j) => j.name === 'push.send')).toHaveLength(1);
    });
  }
});
