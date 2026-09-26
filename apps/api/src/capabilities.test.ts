import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import { meetsMinimum, parseVersion, type Capabilities } from '@fdv/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCapabilities, MIN_CLIENT_VERSION } from './capabilities.js';
import { createHarness, type Harness } from './test-harness.js';
import { serverVersion } from './version.js';

const config = {
  serverVersion: '0.4.4',
  edition: 'self_hosted' as const,
  displayName: 'Our family vault',
  maxUploadBytes: 100 * 1024 * 1024,
  setupRequired: true,
  pushEnabled: false,
  instanceId: null,
};

describe('buildCapabilities', () => {
  it('reports the contract identifiers and configuration verbatim', () => {
    const caps = buildCapabilities(config);
    expect(caps.product).toBe('family-document-vault');
    expect(caps.api_version).toBe(1);
    expect(caps.server_version).toBe('0.4.4');
    expect(caps.edition).toBe('self_hosted');
    expect(caps.branding.display_name).toBe('Our family vault');
    expect(caps.limits.max_upload_bytes).toBe(104857600);
  });

  it('advertises what has shipped, and only that', () => {
    // A feature flips to true in the iteration that ships it: never before,
    // so a client is not told about something the server cannot do, and
    // not long after, so a client that hides what is not offered does not
    // hide something that is. Until 0.4.4, push and share links said false
    // although both had shipped (2.3 and 3.3).
    const caps = buildCapabilities(config);
    expect(caps.features).toEqual({
      passkeys: true,
      private_mode: false,
      email_ingest: false,
      push: false,
      share_links: true,
      bulk_import: false,
      multi_household: false,
      // 0.4.8: uploads are reserve-then-commit on their key (4.3).
      idempotent_capture: true,
      // 0.4.9: the card's details travel with the capture (4.3b).
      capture_metadata: true,
      // 0.4.10: who issued a document, first-class (4.3c).
      issued_by: true,
      // 0.4.12: the vault draws each version's pages (4.7).
      page_previews: true,
      // 0.4.13: a phone may keep the Essentials (4.9).
      offline_essentials: true,
      // 0.4.14: the phone app's notifications through UnifiedPush — as push is (4.13).
      unified_push: false,
      // 0.5.11: kinds of document of the household's own, and the editor (5.11, 5.12).
      custom_types: true,
    });
    expect(caps.deprecations).toEqual([]);
  });

  it('push is reported only when the vault has Web Push keys', () => {
    expect(buildCapabilities({ ...config, pushEnabled: false }).features.push).toBe(false);
    expect(buildCapabilities({ ...config, pushEnabled: true }).features.push).toBe(true);
  });

  it('names the installation when it knows it, and says nothing otherwise', () => {
    const id = randomUUID();
    expect(buildCapabilities({ ...config, instanceId: id }).instance_id).toBe(id);
    expect('instance_id' in buildCapabilities(config)).toBe(false);
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

describe('the version a server reports', () => {
  it('is the release in the root package.json, and a real one', async () => {
    const root = JSON.parse(
      await readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    const v = await serverVersion();
    expect(v).toBe(root.version);
    expect(() => parseVersion(v)).not.toThrow();
    // Never again the 0.0.1 every server said until 0.4.4.
    expect(meetsMinimum(v, '0.4.4')).toBe(true);
  });
});

describe.skipIf(!testAdminUrl())('the capability document, served', () => {
  let a: Harness;
  let b: Harness;
  let c: Harness;
  const caps = async (h: Harness) =>
    (await h.app.inject({ url: '/api/v1/capabilities' })).json<Capabilities>();

  beforeAll(async () => {
    a = await createHarness();
    b = await createHarness();
    c = await createHarness();
  }, 90_000);
  // Three databases to drop, while the rest of the suite runs: more than
  // the default 10 s under load, which failed CI-like runs now and then.
  afterAll(async () => {
    await a.close();
    await b.close();
    await c.close();
  }, 60_000);

  it('carries the installation id: the same every time, different for another vault', async () => {
    const first = await caps(a);
    const again = await caps(a);
    expect(first.instance_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(again.instance_id).toBe(first.instance_id);
    expect((await caps(b)).instance_id).not.toBe(first.instance_id);
  });

  it('share links are on; push follows the Web Push keys', async () => {
    const got = await caps(a);
    expect(got.features.share_links).toBe(true);
    expect(typeof got.features.push).toBe('boolean');
  });

  it('a vault whose id cannot be read still answers, and asks again next time', async () => {
    // As a database loaded from a dump without its grants would be.
    const admin = createPool(c.adminUrl, 1);
    try {
      await admin.query('revoke select on instance from fdv_app');
      const res = await c.app.inject({ url: '/api/v1/capabilities' });
      expect(res.statusCode).toBe(200);
      expect('instance_id' in res.json<Capabilities>()).toBe(false);

      await admin.query('grant select on instance to fdv_app');
      expect((await caps(c)).instance_id).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await admin.end();
    }
  });

  it('the application role can read the installation id but never change it', async () => {
    const changed = await a.db
      .updateTable('instance')
      .set({ instance_id: randomUUID() })
      .execute()
      .then(
        () => 'changed',
        (err: Error) => err.message,
      );
    expect(changed).toMatch(/permission denied/);
  });
});
