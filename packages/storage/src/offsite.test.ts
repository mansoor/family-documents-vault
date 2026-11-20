import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CreateBucketCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  OFFSITE_COPY_NAME,
  OFFSITE_PART_BYTES,
  OffsiteError,
  offsiteKey,
  pruneOffsite,
  testOffsite,
  uploadOffsite,
  type OffsiteBucket,
} from './offsite.js';

describe('the off-site copy: names', () => {
  it('writes and removes only a backup’s own name, under the prefix', () => {
    expect(OFFSITE_COPY_NAME.test('fdv-2026-11-20T02-30-00-000Z.sql.enc')).toBe(true);
    for (const other of [
      'fdv-2026-11-20T02-30-00-000Z.sql.enc.partial',
      'notes.txt',
      'fdv-latest.sql.enc',
      'x/fdv-2026-11-20T02-30-00-000Z.sql.enc',
    ]) {
      expect(OFFSITE_COPY_NAME.test(other)).toBe(false);
    }
    expect(offsiteKey('vault/backups', 'a')).toBe('vault/backups/a');
    expect(offsiteKey('/vault/', 'a')).toBe('vault/a');
    expect(offsiteKey(null, 'a')).toBe('a');
  });

  it('refuses to copy a file that is not a backup', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fdv-offsite-'));
    try {
      const f = path.join(dir, 'secrets.env');
      await writeFile(f, 'x');
      await expect(
        uploadOffsite(
          {
            endpoint: 'http://127.0.0.1:1',
            region: null,
            bucket: 'b',
            prefix: null,
            pathStyle: true,
            accessKeyId: 'k',
            secretAccessKey: 's',
          },
          f,
        ),
      ).rejects.toBeInstanceOf(OffsiteError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * A bucket whose key may write, read and list but not delete — a write-only
 * key, as the README recommends — answered by a server of the test's own.
 */
describe('the off-site copy with a key that may not delete', () => {
  let server: http.Server;
  let endpoint = '';
  const seen: string[] = [];
  beforeAll(async () => {
    let size = 0;
    server = http.createServer((req, res) => {
      seen.push(req.method ?? '');
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.method === 'PUT') {
          size = Buffer.concat(chunks).length;
          res.writeHead(200, { ETag: '"e"' }).end();
        } else if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Length': String(size) }).end();
        } else if (req.method === 'GET') {
          res
            .writeHead(200, { 'Content-Type': 'application/xml' })
            .end(
              '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>b</Name><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated></ListBucketResult>',
            );
        } else {
          res
            .writeHead(403, { 'Content-Type': 'application/xml' })
            .end(
              '<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>',
            );
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('passes the test, saying the key may not delete', async () => {
    const found = await testOffsite({
      endpoint,
      region: 'us-east-1',
      bucket: 'b',
      prefix: 'vault',
      pathStyle: true,
      accessKeyId: 'k',
      secretAccessKey: 's',
    });
    expect(found).toEqual({ canDelete: false });
    expect(seen).toEqual(['PUT', 'HEAD', 'GET', 'DELETE']);
  });
});

const S3_ENDPOINT = process.env.S3_TEST_ENDPOINT ?? '';

describe.skipIf(!S3_ENDPOINT)('the off-site copy, against an S3-compatible server', () => {
  const bucket = `fdv-offsite-${randomBytes(4).toString('hex')}`;
  const creds = {
    accessKeyId: process.env.S3_TEST_KEY ?? 'fdv',
    secretAccessKey: process.env.S3_TEST_SECRET ?? 'fdv-minio-test',
  };
  const target: OffsiteBucket = {
    endpoint: S3_ENDPOINT,
    region: 'us-east-1',
    bucket,
    prefix: 'family/backups',
    pathStyle: true,
    ...creds,
  };
  const s3 = new S3Client({
    endpoint: S3_ENDPOINT,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: creds,
  });
  let dir: string;
  const keys = async () =>
    (
      (await s3.send(new ListObjectsV2Command({ Bucket: bucket }))).Contents?.map(
        (o) => o.Key ?? '',
      ) ?? []
    ).sort();
  const backupFile = async (stamp: string, bytes: number) => {
    const f = path.join(dir, `fdv-${stamp}.sql.enc`);
    await writeFile(f, randomBytes(bytes));
    return f;
  };

  beforeAll(async () => {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    dir = await mkdtemp(path.join(tmpdir(), 'fdv-offsite-'));
  });
  afterAll(async () => {
    s3.destroy();
    await rm(dir, { recursive: true, force: true });
  });

  it('a test writes a small file under the prefix and leaves nothing behind', async () => {
    expect(await testOffsite(target)).toEqual({ canDelete: true });
    expect(await keys()).toEqual([]);
  });

  it('a test says why it failed: the key, the bucket, the address', async () => {
    const why = async (b: OffsiteBucket) =>
      testOffsite(b).then(
        () => null,
        (e: unknown) => (e as OffsiteError).problem,
      );
    expect(await why({ ...target, accessKeyId: 'nobody', secretAccessKey: 'nothing' })).toBe(
      'credentials_rejected',
    );
    expect(await why({ ...target, bucket: 'no-such-bucket-at-all' })).toBe('bucket_missing');
    expect(await why({ ...target, endpoint: 'http://127.0.0.1:1' })).toBe('unreachable');
  }, 60_000);

  it('copies a backup as it is, whole, in parts when it is large', async () => {
    const small = await backupFile('2026-11-01T02-30-00-000Z', 4096);
    const r = await uploadOffsite(target, small);
    expect(r).toEqual({ key: 'family/backups/fdv-2026-11-01T02-30-00-000Z.sql.enc', bytes: 4096 });
    const large = await backupFile('2026-11-02T02-30-00-000Z', OFFSITE_PART_BYTES + 1234);
    const big = await uploadOffsite(target, large);
    expect(big.bytes).toBe(OFFSITE_PART_BYTES + 1234);
    const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: big.key }));
    const back = Buffer.from((await got.Body?.transformToByteArray()) ?? []);
    expect(back.equals(await readFile(large))).toBe(true);
  }, 120_000);

  it('keeps the newest copies and removes only its own older ones under the prefix', async () => {
    for (const day of ['03', '04', '05']) {
      await uploadOffsite(target, await backupFile(`2026-11-${day}T02-30-00-000Z`, 100));
    }
    // What is not the vault's: another file under the prefix, a folder
    // below it, and the rest of the bucket.
    const put = (Key: string) =>
      s3.send(new PutObjectCommand({ Bucket: bucket, Key, Body: Buffer.from('mine') }));
    await put('family/backups/README.txt');
    await put('family/backups/older/fdv-2020-01-01T00-00-00-000Z.sql.enc');
    await put('fdv-2020-01-01T00-00-00-000Z.sql.enc');
    await put('family/fdv-2020-01-01T00-00-00-000Z.sql.enc');

    const gone = await pruneOffsite(target, 2);
    expect(gone).toEqual([
      'family/backups/fdv-2026-11-01T02-30-00-000Z.sql.enc',
      'family/backups/fdv-2026-11-02T02-30-00-000Z.sql.enc',
      'family/backups/fdv-2026-11-03T02-30-00-000Z.sql.enc',
    ]);
    expect(await keys()).toEqual([
      'family/backups/README.txt',
      'family/backups/fdv-2026-11-04T02-30-00-000Z.sql.enc',
      'family/backups/fdv-2026-11-05T02-30-00-000Z.sql.enc',
      'family/backups/older/fdv-2020-01-01T00-00-00-000Z.sql.enc',
      'family/fdv-2020-01-01T00-00-00-000Z.sql.enc',
      'fdv-2020-01-01T00-00-00-000Z.sql.enc',
    ]);
  }, 60_000);
});
