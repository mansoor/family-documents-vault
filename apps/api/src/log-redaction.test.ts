import { describe, expect, it } from 'vitest';
import { loggableUrl } from './log-redaction.js';

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

  it('leaves everything else as it was', () => {
    expect(loggableUrl('/api/v1/documents/7f1c')).toBe('/api/v1/documents/7f1c');
    expect(loggableUrl('/api/v1/shares')).toBe('/api/v1/shares');
    expect(loggableUrl('/healthz')).toBe('/healthz');
  });
});
