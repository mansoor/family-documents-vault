import { randomUUID } from 'node:crypto';
import { EnvKeyProvider, ScopeKeys } from '@fdv/crypto';
import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { codeFor } from '../auth/totp.js';
import type { Principal, Tokens } from '../auth/service.js';
import { createHarness, TEST_MASTER, type Harness } from '../test-harness.js';
import { IdentityService } from './identity.js';

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

  it('the mail is queued last in the transaction and the push after it commits: a notice whose mail cannot be queued is not asked, and nothing is pushed (L533-07, N533A-02)', async () => {
    const { h, owner } = await family(true);
    const me = await h.app.inject({ url: '/api/v1/me', headers: h.as(owner) });
    const p: Principal = {
      accountId: me.json<{ account_id: string }>().account_id,
      sessionId: randomUUID(),
      householdId: owner.household_id,
      memberId: owner.member_id,
      role: 'owner',
      seesAdults: true,
    };
    const keys = new ScopeKeys(new EnvKeyProvider(TEST_MASTER));
    const queued: string[] = [];
    const waiting = async () => {
      const admin = createPool(h.adminUrl, 1);
      try {
        return (
          await admin.query<{ n: number }>(
            `select count(*)::int as n from notice_request
              where household_id = $1 and completed_at is null and withdrawn_at is null`,
            [owner.household_id],
          )
        ).rows[0]?.n;
      } finally {
        await admin.end();
      }
    };
    const down = new IdentityService(
      h.db,
      keys,
      async () => {
        throw new Error('the queue is down');
      },
      true,
      async () => void queued.push('push'),
    );
    await expect(down.setAudience(p, 'adults', { ip: null })).rejects.toThrow(/queue is down/);
    // Rolled back: no notice, and no push for it.
    expect(queued).toEqual([]);
    expect(await waiting()).toBe(0);
    // The push waits for the notice to commit: whoever it wakes finds it.
    const seenByThePush: Array<number | undefined> = [];
    const up = new IdentityService(
      h.db,
      keys,
      async () => void queued.push('mail'),
      true,
      async () => {
        queued.push('push');
        seenByThePush.push(await waiting());
      },
    );
    await up.setAudience(p, 'adults', { ip: null });
    expect(queued).toEqual(['mail', 'push']);
    expect(seenByThePush).toEqual([1]);
    expect(await waiting()).toBe(1);

    // A push that cannot be queued leaves the notice standing, and its one
    // mail (the 5.33 second round, N533A-02).
    expect((await up.setAudience(p, 'owners_and_self', { ip: null })).pending).toBeNull();
    const mails: string[] = [];
    const pushDown = new IdentityService(
      h.db,
      keys,
      async () => void mails.push('mail'),
      true,
      async () => {
        throw new Error('the push queue is down');
      },
    );
    const asked = await pushDown.setAudience(p, 'family', { ip: null });
    expect(asked.pending?.to).toBe('family');
    expect(mails).toEqual(['mail']);
    expect(await waiting()).toBe(1);
  });
});
