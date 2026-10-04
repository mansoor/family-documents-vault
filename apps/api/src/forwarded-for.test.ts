import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './test-harness.js';

/**
 * An address a proxy passed on that is no address (5.30): the audit log's
 * column is an address, and text written into it was refused by the
 * database — a 500 for whoever sent it, until 5.30. Under `all`, which
 * believes anybody, so that the caller's own header is what arrives.
 */
describe.skipIf(!testAdminUrl())('X-Forwarded-For, into the activity log', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;

  beforeAll(async () => {
    h = await createHarness({ trustProxy: 'all' });
    await h.setup();
    admin = createPool(h.adminUrl, 1);
  }, 120_000);
  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  const signIn = (forwarded: string, peer: string) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: { 'x-forwarded-for': forwarded },
      remoteAddress: peer,
      payload: { email: 'owner@example.test', password: 'correct horse battery' },
    });
  const lastSignIn = async () =>
    (
      await admin.query<{ ip: string | null }>(
        `select host(ip) as ip from audit_event where action = 'auth.signed_in' order by id desc limit 1`,
      )
    ).rows[0]?.ip;

  it('a forged non-address in X-Forwarded-For is ignored, not a 500', async () => {
    for (const [forged, peer] of [
      ['<script>alert(1)</script>', '10.40.0.1'],
      ['unknown', '10.40.0.2'],
      ['999.1.1.1', '10.40.0.3'],
    ] as const) {
      const res = await signIn(forged, peer);
      expect(res.statusCode, `${forged}: ${res.body}`).toBe(200);
      // Recorded as the connection it came on.
      expect(await lastSignIn()).toBe(peer);
    }
    // An address, believed as `all` believes it.
    expect((await signIn('198.51.100.4', '10.40.0.4')).statusCode).toBe(200);
    expect(await lastSignIn()).toBe('198.51.100.4');
  });
});
