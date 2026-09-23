import { describe, expect, it } from 'vitest';
import { meetsMinimum } from '@fdv/shared';
import { buildCapabilities, MIN_CLIENT_VERSION } from './capabilities.js';

const config = {
  serverVersion: '0.0.1',
  edition: 'self_hosted' as const,
  displayName: 'Our family vault',
  maxUploadBytes: 100 * 1024 * 1024,
  setupRequired: true,
};

describe('buildCapabilities', () => {
  it('reports the contract identifiers and configuration verbatim', () => {
    const caps = buildCapabilities(config);
    expect(caps.product).toBe('family-document-vault');
    expect(caps.api_version).toBe(1);
    expect(caps.server_version).toBe('0.0.1');
    expect(caps.edition).toBe('self_hosted');
    expect(caps.branding.display_name).toBe('Our family vault');
    expect(caps.limits.max_upload_bytes).toBe(104857600);
  });

  it('advertises only what has shipped', () => {
    // A feature flips to true in the iteration that ships it, and never
    // before: a client must not be told about something the server cannot
    // do. Passkeys shipped in 3.1; the rest have not.
    const caps = buildCapabilities(config);
    expect(caps.features).toEqual({
      passkeys: true,
      private_mode: false,
      email_ingest: false,
      push: false,
      share_links: false,
      bulk_import: false,
      multi_household: false,
    });
    expect(caps.deprecations).toEqual([]);
  });

  it('self-hosted limits are unlimited', () => {
    const caps = buildCapabilities(config);
    expect(caps.limits.max_members).toBeNull();
    expect(caps.limits.max_storage_bytes).toBeNull();
  });

  it('the minimum client version is a valid semver the server itself satisfies', () => {
    expect(meetsMinimum(config.serverVersion, MIN_CLIENT_VERSION)).toBe(true);
  });
});
