import { describe, expect, it } from 'vitest';
import { errorForLog, loggableUrl } from './log-redaction.js';

describe('what the log may say about a request (0.5.0)', () => {
  it('cuts the secret out of every link that is one, and keeps the shape', () => {
    expect(loggableUrl('/api/v1/shared/Abc123-_x')).toBe('/api/v1/shared/[redacted]');
    expect(loggableUrl('/api/v1/shared/Abc123-_x/open')).toBe('/api/v1/shared/[redacted]/open');
    expect(loggableUrl('/api/v1/password-resets/r3s3t')).toBe('/api/v1/password-resets/[redacted]');
    expect(loggableUrl('/api/v1/invitations/inv1t3/accept')).toBe(
      '/api/v1/invitations/[redacted]/accept',
    );
    // The pages a browser opens from those links.
    expect(loggableUrl('/shared/Abc123')).toBe('/shared/[redacted]');
    expect(loggableUrl('/reset/r3s3t')).toBe('/reset/[redacted]');
    expect(loggableUrl('/join/inv1t3')).toBe('/join/[redacted]');
  });

  it('never keeps a query string: a PIN, or what somebody searched for', () => {
    expect(loggableUrl('/api/v1/shared/Abc123/content?pin=4242')).toBe(
      '/api/v1/shared/[redacted]/content?[redacted]',
    );
    expect(loggableUrl('/api/v1/search?q=divorce')).toBe('/api/v1/search?[redacted]');
  });

  it('keeps the names of the share routes that carry no secret in their paths (5.16)', () => {
    expect(loggableUrl('/api/v1/shared/preview')).toBe('/api/v1/shared/preview');
    expect(loggableUrl('/api/v1/shared/unlock')).toBe('/api/v1/shared/unlock');
    expect(loggableUrl('/api/v1/shared/items')).toBe('/api/v1/shared/items');
    expect(loggableUrl('/api/v1/shared/items/7f1c/content')).toBe(
      '/api/v1/shared/items/7f1c/content',
    );
    // 5.20: sending a link's code carries its token in the body.
    expect(loggableUrl('/api/v1/shared/code')).toBe('/api/v1/shared/code');
    // A token that merely starts like one of them is still a token.
    expect(loggableUrl('/api/v1/shared/previewXYZ123')).toBe('/api/v1/shared/[redacted]');
    expect(loggableUrl('/api/v1/shared/codeXYZ123/open')).toBe('/api/v1/shared/[redacted]/open');
    expect(loggableUrl('/api/v1/shared/items-abc/content')).toBe(
      '/api/v1/shared/[redacted]/content',
    );
  });

  it('keeps the names of the reset and invitation routes that carry no secret in their paths (5.17)', () => {
    expect(loggableUrl('/api/v1/password-resets/lookup')).toBe('/api/v1/password-resets/lookup');
    expect(loggableUrl('/api/v1/password-resets/complete')).toBe(
      '/api/v1/password-resets/complete',
    );
    expect(loggableUrl('/api/v1/invitations/lookup')).toBe('/api/v1/invitations/lookup');
    expect(loggableUrl('/api/v1/invitations/accept')).toBe('/api/v1/invitations/accept');
    // A token that merely starts like one of them is still a token, and a
    // name kept under one prefix is not kept under another.
    expect(loggableUrl('/api/v1/password-resets/lookupABC123')).toBe(
      '/api/v1/password-resets/[redacted]',
    );
    expect(loggableUrl('/api/v1/invitations/accept-xyz/accept')).toBe(
      '/api/v1/invitations/[redacted]/accept',
    );
    expect(loggableUrl('/api/v1/password-resets/accept')).toBe(
      '/api/v1/password-resets/[redacted]',
    );
    expect(loggableUrl('/api/v1/shared/lookup')).toBe('/api/v1/shared/[redacted]');
    // The pages a new link opens have no secret in their paths at all.
    expect(loggableUrl('/reset')).toBe('/reset');
    expect(loggableUrl('/join')).toBe('/join');
  });

  it('an error keeps no address and no refused row (5.20)', () => {
    // As PostgreSQL refuses a row: its values in `detail`, its names beside.
    const refused = Object.assign(new Error('new row violates check constraint "x"'), {
      code: '23514',
      constraint: 'share_link_code_email',
      table: 'share_link',
      detail: 'Failing row contains (…, jane.smith@example.com, …).',
    });
    const kept = errorForLog(refused);
    expect(kept).toMatchObject({ code: '23514', constraint: 'share_link_code_email' });
    expect(JSON.stringify(kept)).not.toContain('jane.smith@example.com');
    expect(kept).not.toHaveProperty('detail');
    // A mail server naming the recipient in its words.
    const mailed = errorForLog(
      new Error('550 5.1.1 <jane@example.org>: Recipient address rejected'),
    );
    expect(mailed.message).toBe('550 5.1.1 <[address]>: Recipient address rejected');
    expect(JSON.stringify(mailed)).not.toContain('jane@example.org');
    expect(errorForLog('plain words to bob@example.net')).toEqual({
      message: 'plain words to [address]',
    });
    // A stack keeps its paths, packages and versions included.
    const deep = new Error('Queue alert.send does not exist');
    deep.stack =
      'Error: Queue alert.send does not exist\n    at Manager.getQueueCache (file:///C:/repo/node_modules/.pnpm/pg-boss@10.1.6/node_modules/pg-boss/src/manager.js:785:19)\n    at x (/repo/node_modules/@fdv/db/src/client.ts:1:1)';
    expect(errorForLog(deep).stack).toBe(deep.stack);
  });

  it('leaves everything else as it was', () => {
    expect(loggableUrl('/api/v1/documents/7f1c')).toBe('/api/v1/documents/7f1c');
    expect(loggableUrl('/api/v1/shares')).toBe('/api/v1/shares');
    expect(loggableUrl('/healthz')).toBe('/healthz');
  });
});
