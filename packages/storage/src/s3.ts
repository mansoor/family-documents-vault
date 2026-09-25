import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type { S3ServiceException } from '@aws-sdk/client-s3';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  MESSAGES,
  StorageError,
  type ByteRange,
  type PutMeta,
  type PutResult,
  type StorageAdapter,
  type StorageErrorCode,
  type TestResult,
} from './adapter.js';
import { readAll } from './local.js';

/**
 * Anything with an S3 API: AWS itself, MinIO, Backblaze B2, Wasabi,
 * Cloudflare R2, DigitalOcean Spaces, Ceph, Storj, Garage, Hetzner. The
 * differences are an endpoint URL and whether the provider wants
 * path-style addressing.
 */
export interface S3Config {
  endpoint?: string | null; // undefined = AWS
  region?: string | null;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle?: boolean;
  /** Human label for `description`, e.g. "Backblaze B2". */
  providerName?: string;
}

/** Presets fill the endpoint for the common providers (design, Storage). */
export const PROVIDER_PRESETS: Record<
  string,
  { name: string; endpoint: string | null; pathStyle: boolean; region?: string; hint: string }
> = {
  aws: { name: 'Amazon S3', endpoint: null, pathStyle: false, hint: 'Choose the bucket region.' },
  b2: {
    name: 'Backblaze B2',
    endpoint: 'https://s3.{region}.backblazeb2.com',
    pathStyle: false,
    hint: 'The region is in the bucket endpoint, e.g. us-west-004.',
  },
  wasabi: {
    name: 'Wasabi',
    endpoint: 'https://s3.{region}.wasabisys.com',
    pathStyle: false,
    hint: 'e.g. us-east-1',
  },
  r2: {
    name: 'Cloudflare R2',
    endpoint: 'https://{account}.r2.cloudflarestorage.com',
    pathStyle: false,
    region: 'auto',
    hint: 'Replace {account} with your Cloudflare account ID.',
  },
  spaces: {
    name: 'DigitalOcean Spaces',
    endpoint: 'https://{region}.digitaloceanspaces.com',
    pathStyle: false,
    hint: 'e.g. nyc3',
  },
  minio: {
    name: 'MinIO on my own server',
    endpoint: 'http://minio:9000',
    pathStyle: true,
    region: 'us-east-1',
    hint: 'The address of your MinIO server.',
  },
  other: {
    name: 'Something else with an S3 address',
    endpoint: '',
    pathStyle: true,
    hint: 'Paste the endpoint from your provider.',
  },
};

export class S3Adapter implements StorageAdapter {
  readonly kind = 's3' as const;
  readonly description: string;
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(private readonly config: S3Config) {
    this.bucket = config.bucket;
    const where =
      config.providerName ?? (config.endpoint ? new URL(config.endpoint).host : 'Amazon S3');
    this.description = `the bucket ${config.bucket} at ${where}`;
    this.client = new S3Client({
      region: config.region || 'us-east-1',
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.pathStyle ?? false,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      // Every object we store is ciphertext already; do not let the SDK
      // add its own checksum trailer, which some providers reject.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async put(key: string, body: Readable, meta: PutMeta = {}): Promise<PutResult> {
    // S3 needs the length up front for a single PUT, and we want the digest
    // sent with the request so the provider refuses a corrupted upload.
    // Buffering is acceptable here because the API already caps upload
    // size; multipart streaming arrives with the import pipeline.
    const data = await readAll(body);
    const sha256 = createHash('sha256').update(data).digest();
    try {
      const res = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: data,
          ContentLength: data.length,
          ContentType: meta.contentType ?? 'application/octet-stream',
          ChecksumSHA256: sha256.toString('base64'),
        }),
      );
      // Belt and braces: the provider's view of the object must match.
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      if (head.ContentLength !== data.length) {
        throw new StorageError(
          'verification_failed',
          MESSAGES.verification_failed,
          `stored ${head.ContentLength} bytes, sent ${data.length}`,
        );
      }
      const result: PutResult = { bytes: data.length, sha256: sha256.toString('hex') };
      if (res.ETag) result.etag = res.ETag;
      return result;
    } catch (err) {
      throw wrap(err);
    }
  }

  async get(key: string, range?: ByteRange): Promise<Readable> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
        }),
      );
      if (!res.Body) throw new StorageError('not_found', MESSAGES.not_found);
      return res.Body as Readable;
    } catch (err) {
      throw wrap(err);
    }
  }

  async stat(key: string): Promise<{ bytes: number }> {
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { bytes: head.ContentLength ?? 0 };
    } catch (err) {
      throw wrap(err);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      throw wrap(err);
    }
  }

  async signedUrl(): Promise<null> {
    // Content is ciphertext; a direct URL would hand the client bytes it
    // cannot read. Kept for a future unencrypted deployment mode.
    return null;
  }

  async test(): Promise<TestResult> {
    const key = `.fdv-test/${randomBytes(8).toString('hex')}`;
    const payload = Buffer.from(`family document vault test ${new Date().toISOString()}`);
    try {
      await this.put(key, Readable.from([payload]));
      const back = await readAll(await this.get(key));
      await this.delete(key);
      if (!back.equals(payload)) {
        return { ok: false, code: 'verification_failed', message: MESSAGES.verification_failed };
      }
      return {
        ok: true,
        message: `Connected. Your files will be stored in ${this.bucket} at ${this.config.providerName ?? this.host()}.`,
      };
    } catch (err) {
      const e = wrap(err);
      const result: TestResult = { ok: false, code: e.code, message: e.message };
      if (e.detail) result.detail = e.detail;
      return result;
    }
  }

  private host(): string {
    return this.config.endpoint ? new URL(this.config.endpoint).host : 'Amazon S3';
  }
}

function wrap(err: unknown): StorageError {
  if (err instanceof StorageError) return err;
  const e = err as S3ServiceException & { code?: string; cause?: { code?: string } };
  const name = e.name || e.code || '';
  const status = e.$metadata?.httpStatusCode;
  const detail = `${name}${e.message ? `: ${e.message}` : ''}`;
  let code: StorageErrorCode = 'unknown';
  // By name first: some providers answer a key they do not know with a 404
  // (VersityGW's XAdminUserNotFound), which is not a missing file.
  if (
    name === 'InvalidAccessKeyId' ||
    name === 'SignatureDoesNotMatch' ||
    name === 'UnauthorizedAccess' ||
    name === 'XAdminUserNotFound' ||
    status === 401
  )
    code = 'credentials_rejected';
  else if (name === 'NoSuchBucket') code = 'bucket_missing';
  else if (name === 'NoSuchKey' || name === 'NotFound' || status === 404) code = 'not_found';
  else if (name === 'AccessDenied' || status === 403) code = 'permission_denied';
  else if (
    ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(
      e.cause?.code ?? e.code ?? name,
    ) ||
    name === 'TimeoutError'
  )
    code = 'unreachable';
  // "not found" on a HEAD of the bucket root is how a missing bucket surfaces on some providers
  if (code === 'not_found' && /bucket/i.test(e.message ?? '')) code = 'bucket_missing';
  return new StorageError(code, MESSAGES[code], detail);
}
