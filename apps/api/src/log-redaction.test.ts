import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { errorForLog, loggableUrl } from './log-redaction.js';

/**
 * nginx's access-log map (docker/nginx.conf), read from the file and run as
 * nginx runs it: each `"~regex" "replacement"` line of the map that cuts a
 * path, in order, the first that matches.
 */
function nginxLogPath(path: string): string {
  const conf = readFileSync(new URL('../../../docker/nginx.conf', import.meta.url), 'utf8');
  const block = /map \$fdv_log_path \$fdv_log_uri \{([\s\S]*?)\n\}/.exec(conf)?.[1] ?? '';
  for (const line of block.split('\n')) {
    const m = /^\s*"~(.*)" "(.*)";\s*$/.exec(line);
    if (!m) continue;
    const re = new RegExp(m[1] as string);
    if (re.test(path)) {
      return path.replace(re, (m[2] as string).replace(/\$\{(\w+)\}/g, '$<$1>'));
    }
  }
  return path;
}

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
    expect(loggableUrl('/api/v1/downloads/tIcKeT_abc-123')).toBe('/api/v1/downloads/[redacted]');
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
    // 0.9.0 (SMS3): texting the code that finishes a reset carries the token in its body.
    expect(loggableUrl('/api/v1/password-resets/code')).toBe('/api/v1/password-resets/code');
    expect(loggableUrl('/api/v1/password-resets/codeABC123')).toBe(
      '/api/v1/password-resets/[redacted]',
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
    // A mobile number a code went to (SMS3), in SMS Gate's words or a refused row's.
    const texted = errorForLog(new Error('SMS Gate: message to +447700900123 failed'));
    expect(texted.message).toBe('SMS Gate: message to [number] failed');
    expect(JSON.stringify(texted)).not.toContain('7700900123');
    const row = errorForLog(
      Object.assign(new Error('new row violates check constraint "x"'), {
        code: '23514',
        constraint: 'share_link_code_phone',
        detail: 'Failing row contains (…, +447700900123, …).',
      }),
    );
    expect(JSON.stringify(row)).not.toContain('7700900123');
    // An AI reader's key as it is sent (AIR1): never in an error's words.
    const keyed = errorForLog(new Error('refused: Authorization: Bearer sk-test-abcd-1234'));
    expect(keyed.message).toBe('refused: Authorization: Bearer [key]');
    expect(JSON.stringify(keyed)).not.toContain('sk-test-abcd-1234');
    // Nor a refused row's: the key is kept sealed, and a row's values are never kept.
    const aiRow = errorForLog(
      Object.assign(new Error('new row violates check constraint "ai_reader_model"'), {
        code: '23514',
        constraint: 'ai_reader_model',
        detail: 'Failing row contains (…, sealed-bytes, abcd, …).',
      }),
    );
    expect(aiRow).not.toHaveProperty('detail');
    expect(loggableUrl('/api/v1/household/reading/ai-reader')).toBe(
      '/api/v1/household/reading/ai-reader',
    );
    // A stack keeps its paths, packages and versions included.
    const deep = new Error('Queue alert.send does not exist');
    deep.stack =
      'Error: Queue alert.send does not exist\n    at Manager.getQueueCache (file:///C:/repo/node_modules/.pnpm/pg-boss@10.1.6/node_modules/pg-boss/src/manager.js:785:19)\n    at x (/repo/node_modules/@fdv/db/src/client.ts:1:1)';
    expect(errorForLog(deep).stack).toBe(deep.stack);
  });

  it("keeps the names of a sender's routes, and cuts anything else there (5.21)", () => {
    for (const name of ['preview', 'code', 'unlock', 'session', 'files', 'finish']) {
      expect(loggableUrl(`/api/v1/drop/${name}`)).toBe(`/api/v1/drop/${name}`);
    }
    // A file's id is not a secret: the session is the cookie.
    expect(loggableUrl('/api/v1/drop/files/7f1c')).toBe('/api/v1/drop/files/7f1c');
    // A token in a path, by mistake or by an older page, is cut.
    expect(loggableUrl('/api/v1/drop/Abc123-_xyz')).toBe('/api/v1/drop/[redacted]');
    expect(loggableUrl('/api/v1/drop/previewAbc123')).toBe('/api/v1/drop/[redacted]');
    expect(loggableUrl('/drop/Abc123-_xyz')).toBe('/drop/[redacted]');
    expect(loggableUrl('/drop')).toBe('/drop');
    expect(loggableUrl('/api/v1/upload-requests')).toBe('/api/v1/upload-requests');
  });

  it("cuts a connected app's external id, here and in nginx's access log (0.9.0, APP1)", () => {
    expect(loggableUrl('/api/v1/apps/intake/mt:tenant-7f3a:doc-01HZX3K9Q2')).toBe(
      '/api/v1/apps/intake/[redacted]',
    );
    // Asked for several at once, on a query string: none of it is kept.
    expect(loggableUrl('/api/v1/apps/intake?external_ids=mt:a,mt:b')).toBe(
      '/api/v1/apps/intake?[redacted]',
    );
    expect(loggableUrl('/api/v1/apps/me')).toBe('/api/v1/apps/me');
    expect(nginxLogPath('/api/v1/apps/intake/mt:tenant-7f3a:doc-01HZX3K9Q2')).toBe(
      '/api/v1/apps/intake/[redacted]',
    );
    expect(nginxLogPath('/api/v1/apps/me')).toBe('/api/v1/apps/me');
  });

  it("cuts a connected app's link, here and in nginx's access log, but its session's name (0.9.0, APP3)", () => {
    const token = 'q2v5Xb8Kc1nT4yWm9pLd3Aq2v5Xb8Kc1nT4yWm9pLd3';
    expect(loggableUrl(`/api/v1/app-links/${token}`)).toBe('/api/v1/app-links/[redacted]');
    expect(nginxLogPath(`/api/v1/app-links/${token}`)).toBe('/api/v1/app-links/[redacted]');
    // A token that merely starts like the session's name is still cut.
    expect(loggableUrl(`/api/v1/app-links/session${token}`)).toBe('/api/v1/app-links/[redacted]');
    expect(nginxLogPath(`/api/v1/app-links/session${token}`)).toBe('/api/v1/app-links/[redacted]');
    for (const kept of [
      '/api/v1/app-links/session',
      '/api/v1/app-links/session/pages/3',
      '/api/v1/app-links/session/file',
    ]) {
      expect(loggableUrl(kept), kept).toBe(kept);
      expect(nginxLogPath(kept), kept).toBe(kept);
    }
  });

  it("nginx's access log cuts what the API's log cuts: a ZIP's ticket too (DL, found in APP1)", () => {
    for (const path of [
      '/api/v1/downloads/tIcKeT_abc-123',
      '/api/v1/shared/Abc123-_x/open',
      '/api/v1/password-resets/r3s3t',
      '/api/v1/invitations/inv1t3/accept',
      '/api/v1/apps/intake/mt:doc-1',
      '/shared/Abc123',
      '/reset/r3s3t',
    ]) {
      expect(nginxLogPath(path), path).toBe(loggableUrl(path));
    }
    expect(nginxLogPath('/api/v1/documents/7f1c')).toBe('/api/v1/documents/7f1c');
  });

  it('leaves everything else as it was', () => {
    expect(loggableUrl('/api/v1/documents/7f1c')).toBe('/api/v1/documents/7f1c');
    expect(loggableUrl('/api/v1/shares')).toBe('/api/v1/shares');
    expect(loggableUrl('/healthz')).toBe('/healthz');
  });
});
