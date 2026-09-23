import { testAdminUrl } from '@fdv/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../test-harness.js';
import { describeDevice } from './service.js';

const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

/**
 * New-device alerts (SEC-11). The whole value is in the first sign-in
 * from somewhere unfamiliar, so the tests are about when it stays quiet
 * as much as when it speaks.
 */
describe.skipIf(!testAdminUrl())('new-device alerts', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  }, 60_000);
  afterAll(() => h.close());

  const signIn = (userAgent: string) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: { 'user-agent': userAgent },
      payload: { email: 'owner@example.test', password: 'correct horse battery' },
    });

  const alerts = () =>
    h.jobs
      .filter((j) => j.name === 'alert.send')
      .map((j) => j.data as { subject: string; body: string });

  it('the first device an account ever uses is not news', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      headers: { 'user-agent': CHROME_MAC },
      payload: {
        household_name: 'The Test family',
        display_name: 'Owner',
        email: 'owner@example.test',
        password: 'correct horse battery',
      },
    });
    expect(alerts()).toHaveLength(0);
  });

  it('signing in again on the same device is quiet', async () => {
    expect((await signIn(CHROME_MAC)).statusCode).toBe(200);
    expect(alerts()).toHaveLength(0);
  });

  it('a device that has not been seen before says so, in recognisable words', async () => {
    expect((await signIn(SAFARI_IPHONE)).statusCode).toBe(200);
    const told = alerts();
    expect(told).toHaveLength(1);
    expect(told[0]?.subject).toBe('A new device signed in to your vault');
    expect(told[0]?.body).toContain('Safari on an iPhone');
    // And says what to do if it was not you.
    expect(told[0]?.body).toMatch(/change your password/);
  });

  it('and then that one is quiet too', async () => {
    await signIn(SAFARI_IPHONE);
    expect(alerts()).toHaveLength(1);
  });

  it('describes devices coarsely, because that is all a browser tells us', () => {
    expect(describeDevice(CHROME_MAC)).toBe('Chrome on a Mac');
    expect(describeDevice(SAFARI_IPHONE)).toBe('Safari on an iPhone');
    expect(describeDevice('Mozilla/5.0 (Windows NT 10.0) Firefox/130.0')).toBe(
      'Firefox on a Windows computer',
    );
    expect(describeDevice('curl/8.4.0')).toBe('a device we could not recognise');
  });
});
