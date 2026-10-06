import { alertLinkBinding, openBytes } from '@fdv/crypto';
import { describe, expect, it } from 'vitest';
import { alertJob } from './alert-job.js';
import { TEST_ALERT_KEY } from './test-harness.js';

/**
 * The one mapping from an API alert to the worker's job. In 0.4.1 the
 * server had its own copy that dropped the link and the "email only" flag,
 * so real password-reset emails had no link in them while every test —
 * which used the harness's copy — passed.
 */
describe('alertJob', () => {
  const reset = {
    householdId: 'hh',
    accountIds: ['a'],
    subject: 'Setting a new password',
    body: 'b',
    url: 'https://vault.example/reset#t0k3n-that-opens-a-sign-in',
    urlLabel: 'Set a new password',
    emailOnly: true,
  };

  it('carries the link, sealed, and keeps it off lock screens when asked', () => {
    const job = alertJob(TEST_ALERT_KEY, reset);
    expect(job).toEqual({
      household_id: 'hh',
      account_ids: ['a'],
      subject: 'Setting a new password',
      body: 'b',
      sealed_url: expect.any(String) as unknown,
      url_label: 'Set a new password',
      email_only: true,
    });
    // The worker opens it, under the same key, for the same household.
    const opened = openBytes(
      TEST_ALERT_KEY,
      Buffer.from(String(job.sealed_url), 'base64'),
      alertLinkBinding('hh'),
    ).toString('utf8');
    expect(opened).toBe(reset.url);
  });

  it('puts no working link on the queue (F529-11)', () => {
    // What the queue's table holds — the application role reads it, and
    // every backup keeps it — names neither the link nor its token.
    const held = JSON.stringify(alertJob(TEST_ALERT_KEY, reset));
    expect(held).not.toContain('reset#');
    expect(held).not.toContain('t0k3n-that-opens-a-sign-in');
    // Moved to another household's job, it does not open.
    const job = alertJob(TEST_ALERT_KEY, reset);
    expect(() =>
      openBytes(
        TEST_ALERT_KEY,
        Buffer.from(String(job.sealed_url), 'base64'),
        alertLinkBinding('another'),
      ),
    ).toThrow();
  });

  it('adds nothing that was not asked for', () => {
    expect(
      alertJob(TEST_ALERT_KEY, { householdId: 'hh', accountIds: [], subject: 's', body: 'b' }),
    ).toEqual({
      household_id: 'hh',
      account_ids: [],
      subject: 's',
      body: 'b',
    });
  });

  it('is the mapping the server itself uses, not a copy of it', async () => {
    const { readFile } = await import('node:fs/promises');
    const server = await readFile(new URL('./server.ts', import.meta.url), 'utf8');
    expect(server).toMatch(/enqueue\('alert\.send', alertJob\(alertKey, a\)\)/);
    expect(server).toMatch(/alertKey = deriveKey\(masterSecret, ALERT_LINK_KEY_PURPOSE\)/);
  });
});
