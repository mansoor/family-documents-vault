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

  it('advertises nothing that has not shipped yet', () => {
    const caps = buildCapabilities(config);
    expect(Object.values(caps.features).every((v) => v === false)).toBe(true);
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
