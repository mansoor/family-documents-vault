import { describe, expect, it } from 'vitest';
import { alertJob } from './alert-job.js';

/**
 * The one mapping from an API alert to the worker's job. In 0.4.1 the
 * server had its own copy that dropped the link and the "email only" flag,
 * so real password-reset emails had no link in them while every test —
 * which used the harness's copy — passed.
 */
describe('alertJob', () => {
  it('carries the link and keeps it off lock screens when asked', () => {
    expect(
      alertJob({
        householdId: 'hh',
        accountIds: ['a'],
        subject: 'Setting a new password',
        body: 'b',
        url: 'https://vault.example/reset/t',
        urlLabel: 'Set a new password',
        emailOnly: true,
      }),
    ).toEqual({
      household_id: 'hh',
      account_ids: ['a'],
      subject: 'Setting a new password',
      body: 'b',
      url: 'https://vault.example/reset/t',
      url_label: 'Set a new password',
      email_only: true,
    });
  });

  it('adds nothing that was not asked for', () => {
    expect(alertJob({ householdId: 'hh', accountIds: [], subject: 's', body: 'b' })).toEqual({
      household_id: 'hh',
      account_ids: [],
      subject: 's',
      body: 'b',
    });
  });

  it('is the mapping the server itself uses, not a copy of it', async () => {
    const { readFile } = await import('node:fs/promises');
    const server = await readFile(new URL('./server.ts', import.meta.url), 'utf8');
    expect(server).toMatch(/enqueue\('alert\.send', alertJob\(a\)\)/);
  });
});
