import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { objectKey, StorageError, type StorageAdapter } from './adapter.js';
import { LocalAdapter, readAll } from './local.js';
import { S3Adapter } from './s3.js';

/**
 * One behavioural suite, run against every adapter. What the vault relies
 * on must hold identically whether the bytes land on a disk or in a bucket.
 */
function adapterSuite(
  name: string,
  make: () => Promise<{ adapter: StorageAdapter; cleanup: () => Promise<void> }>,
) {
  describe(name, () => {
    let adapter: StorageAdapter;
    let cleanup: () => Promise<void>;
    beforeAll(async () => ({ adapter, cleanup } = await make()));
    afterAll(() => cleanup());

    it('test() succeeds with a sentence a person can read', async () => {
      const r = await adapter.test();
      expect(r.ok).toBe(true);
      expect(r.message).toMatch(/^Connected\./);
    });

    it('round-trips bytes and reports the verified sha256', async () => {
      const data = randomBytes(3 * 1024 * 1024 + 7);
      const key = objectKey({
        householdId: 'hh',
        documentId: 'doc',
        versionNo: 1,
        name: 'abcdef0123456789',
        ext: 'PDF',
      });
      expect(key).toBe('hh/doc/1/abcdef0123456789.pdf.enc');
      const put = await adapter.put(key, Readable.from([data]), { bytes: data.length });
      expect(put.bytes).toBe(data.length);
      expect(put.sha256).toHaveLength(64);
      expect((await adapter.stat(key)).bytes).toBe(data.length);
      expect((await readAll(await adapter.get(key))).equals(data)).toBe(true);
    });

    it('serves inclusive byte ranges', async () => {
      const data = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
      await adapter.put('ranges/x', Readable.from([data]));
      expect((await readAll(await adapter.get('ranges/x', { start: 0, end: 0 }))).toString()).toBe(
        '0',
      );
      expect(
        (await readAll(await adapter.get('ranges/x', { start: 10, end: 15 }))).toString(),
      ).toBe('abcdef');
      expect(
        (await readAll(await adapter.get('ranges/x', { start: 35, end: 35 }))).toString(),
      ).toBe('z');
    });

    it('deletes, and reports a missing object as not_found', async () => {
      await adapter.put('gone/x', Readable.from([Buffer.from('bye')]));
      await adapter.delete('gone/x');
      await expect(adapter.stat('gone/x')).rejects.toMatchObject({ code: 'not_found' });
      await expect(adapter.get('gone/x')).rejects.toBeInstanceOf(StorageError);
      await adapter.delete('gone/x'); // idempotent
    });

    it('never hands out a direct URL for encrypted content', async () => {
      expect(await adapter.signedUrl('anything', 60)).toBeNull();
    });
  });
}

adapterSuite('LocalAdapter', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fdv-vault-'));
  return {
    adapter: new LocalAdapter(dir),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
});

describe('LocalAdapter specifics', () => {
  it('refuses keys that escape the root', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fdv-vault-'));
    try {
      const a = new LocalAdapter(dir);
      await expect(a.put('../escape', Readable.from([Buffer.from('x')]))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a short write is refused and leaves nothing behind', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fdv-vault-'));
    try {
      const a = new LocalAdapter(dir);
      await expect(
        a.put('short/x', Readable.from([Buffer.from('only ten b')]), { bytes: 100 }),
      ).rejects.toMatchObject({ code: 'verification_failed' });
      await expect(a.stat('short/x')).rejects.toMatchObject({ code: 'not_found' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('test() explains an unusable folder', async () => {
    // A root that is a file, not a directory: mkdir under it must fail.
    const dir = await mkdtemp(path.join(tmpdir(), 'fdv-vault-'));
    try {
      const file = path.join(dir, 'not-a-folder');
      await writeFile(file, 'x');
      const r = await new LocalAdapter(file).test();
      expect(r.ok).toBe(false);
      expect(r.message.length).toBeGreaterThan(10);
      expect(r.detail).toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

const S3_ENDPOINT = process.env.S3_TEST_ENDPOINT ?? '';

describe.skipIf(!S3_ENDPOINT)('S3Adapter', () => {
  const bucket = `fdv-test-${randomBytes(4).toString('hex')}`;
  const creds = {
    accessKeyId: process.env.S3_TEST_KEY ?? 'fdv',
    secretAccessKey: process.env.S3_TEST_SECRET ?? 'fdv-minio-test',
  };

  beforeAll(async () => {
    const { CreateBucketCommand, S3Client } = await import('@aws-sdk/client-s3');
    const c = new S3Client({
      endpoint: S3_ENDPOINT,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: creds,
    });
    await c.send(new CreateBucketCommand({ Bucket: bucket }));
  });

  adapterSuite('against an S3-compatible server (VersityGW in CI)', async () => ({
    adapter: new S3Adapter({
      endpoint: S3_ENDPOINT,
      bucket,
      pathStyle: true,
      providerName: 'MinIO',
      ...creds,
    }),
    cleanup: async () => undefined,
  }));

  it('test() explains wrong credentials, a missing bucket and an unreachable host', async () => {
    const wrongKey = await new S3Adapter({
      endpoint: S3_ENDPOINT,
      bucket,
      pathStyle: true,
      accessKeyId: 'nobody',
      secretAccessKey: 'nothing-at-all',
    }).test();
    expect(wrongKey.ok).toBe(false);
    expect(wrongKey.code).toBe('credentials_rejected');
    expect(wrongKey.message).toMatch(/key ID or application key/);

    const noBucket = await new S3Adapter({
      endpoint: S3_ENDPOINT,
      bucket: 'does-not-exist-at-all',
      pathStyle: true,
      ...creds,
    }).test();
    expect(noBucket.ok).toBe(false);
    expect(noBucket.code).toBe('bucket_missing');

    const down = await new S3Adapter({
      endpoint: 'http://127.0.0.1:1',
      bucket,
      pathStyle: true,
      ...creds,
    }).test();
    expect(down.ok).toBe(false);
    expect(down.code).toBe('unreachable');
    expect(down.message).toMatch(/can't reach/);
  });
});
