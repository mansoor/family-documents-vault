import { randomBytes } from 'node:crypto';
import { testAdminUrl } from '@fdv/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';
import { openCredentials, sealCredentials, type VaultView } from './service.js';

const S3 = process.env.S3_TEST_ENDPOINT ?? '';

describe('credential sealing', () => {
  it('round-trips and is bound to the vault id', () => {
    const key = randomBytes(32);
    const sealed = sealCredentials(key, { accessKeyId: 'k', secretAccessKey: 's' }, 'v1');
    expect(openCredentials(key, sealed, 'v1')).toEqual({ accessKeyId: 'k', secretAccessKey: 's' });
    expect(() => openCredentials(key, sealed, 'v2')).toThrow();
    expect(sealed.toString('utf8')).not.toContain('secretAccessKey');
  });
});

describe.skipIf(!testAdminUrl())('vaults API', () => {
  let h: Harness;
  let owner: Tokens;

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();
  });
  afterAll(() => h.close());

  const list = async (t: Tokens) =>
    h.app
      .inject({ url: '/api/v1/vaults', headers: h.as(t) })
      .then((r) => r.json<{ items: VaultView[] }>().items);

  it('setup created a tested, active local vault', async () => {
    const items = await list(owner);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'local',
      label: 'This computer',
      status: 'ok',
      active: true,
    });
    expect(items[0]?.last_verified_at).toBeTruthy();
  });

  it('offers provider presets without secrets', async () => {
    const res = await h.app.inject({ url: '/api/v1/vaults/providers', headers: h.as(owner) });
    const providers = res.json<Array<{ key: string; name: string }>>();
    expect(providers.map((p) => p.key)).toContain('b2');
    expect(JSON.stringify(providers)).not.toMatch(/secret/i);
  });

  it('rejects a preset whose endpoint still has a placeholder', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/vaults',
      headers: h.as(owner),
      payload: { provider: 'b2', bucket: 'x', access_key_id: 'a', secret_access_key: 'b' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('an unreachable bucket can be added but not activated', async () => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/vaults',
      headers: h.as(owner),
      payload: {
        provider: 'other',
        endpoint: 'http://127.0.0.1:1',
        bucket: 'nowhere',
        access_key_id: 'a',
        secret_access_key: 'b',
      },
    });
    expect(created.statusCode).toBe(201);
    const v = created.json<VaultView>();
    expect(v.status).toBe('untested');
    expect(JSON.stringify(v)).not.toContain('secret_access_key');

    const test = await h.app.inject({
      method: 'POST',
      url: `/api/v1/vaults/${v.id}/test`,
      headers: h.as(owner),
    });
    expect(test.json<{ ok: boolean; code: string; message: string }>()).toMatchObject({
      ok: false,
      code: 'unreachable',
    });

    const activate = await h.app.inject({
      method: 'POST',
      url: `/api/v1/vaults/${v.id}/activate`,
      headers: h.as(owner),
    });
    expect(activate.statusCode).toBe(409);
    expect(activate.json<{ error: { code: string } }>().error.code).toBe('vault_untested');

    const after = (await list(owner)).find((x) => x.id === v.id);
    expect(after?.status).toBe('failed');
    expect(after?.last_error).toBeTruthy();

    const del = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/vaults/${v.id}`,
      headers: h.as(owner),
    });
    expect(del.statusCode).toBe(204);
  });

  it('the active vault cannot be removed', async () => {
    const local = (await list(owner)).find((v) => v.active) as VaultView;
    const del = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/vaults/${local.id}`,
      headers: h.as(owner),
    });
    expect(del.statusCode).toBe(409);
  });

  it.skipIf(!S3)('a reachable MinIO bucket passes its test and becomes active', async () => {
    const bucket = `fdv-api-${randomBytes(4).toString('hex')}`;
    const { CreateBucketCommand, S3Client } = await import('@aws-sdk/client-s3');
    await new S3Client({
      endpoint: S3,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: 'fdv', secretAccessKey: 'fdv-minio-test' },
    }).send(new CreateBucketCommand({ Bucket: bucket }));

    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/vaults',
      headers: h.as(owner),
      payload: {
        provider: 'minio',
        endpoint: S3,
        bucket,
        access_key_id: 'fdv',
        secret_access_key: 'fdv-minio-test',
      },
    });
    const v = created.json<VaultView>();
    const test = await h.app.inject({
      method: 'POST',
      url: `/api/v1/vaults/${v.id}/test`,
      headers: h.as(owner),
    });
    expect(test.json<{ ok: boolean; message: string }>()).toMatchObject({ ok: true });
    expect(test.json<{ message: string }>().message).toMatch(/^Connected\./);

    const activate = await h.app.inject({
      method: 'POST',
      url: `/api/v1/vaults/${v.id}/activate`,
      headers: h.as(owner),
    });
    expect(activate.statusCode).toBe(204);
    const items = await list(owner);
    expect(items.find((x) => x.id === v.id)?.active).toBe(true);
    expect(items.find((x) => x.kind === 'local')?.active).toBe(false);

    // switch back so later tests use the local vault
    const local = items.find((x) => x.kind === 'local') as VaultView;
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/vaults/${local.id}/activate`,
      headers: h.as(owner),
    });
  });

  it('only owners may change storage', async () => {
    // Fake a non-owner by forging nothing: simply check the role guard via a
    // second account is not possible until invitations (3.2); assert the
    // guard exists on the service by role value instead.
    const { VaultService } = await import('./service.js');
    const svc = new VaultService(h.db, randomBytes(32), h.vaultDir);
    await expect(
      svc.create(
        {
          accountId: 'a',
          sessionId: 's',
          householdId: owner.household_id,
          memberId: 'm',
          role: 'adult',
        },
        { provider: 'aws', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' },
        {},
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});
