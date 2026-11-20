import { randomBytes } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import type { StorageErrorCode } from './adapter.js';
import { CONNECT_TIMEOUT_MS, QUICK_TIMEOUT_MS, storageErrorOf } from './s3.js';

/**
 * The off-site copy of the nightly backups (0.9.0): a bucket on any
 * S3-compatible service, written to only under its prefix. What goes there
 * is the backup file exactly as the worker wrote it — already encrypted
 * under the master key — and the only objects ever removed are the vault's
 * own older copies, by their name, directly under that prefix.
 */
export interface OffsiteBucket {
  /** Null: Amazon S3 itself, by its region. */
  endpoint: string | null;
  region: string | null;
  bucket: string;
  /** A folder inside the bucket, or null for its top. */
  prefix: string | null;
  pathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Why it did not go, in a word: the storage adapter's own, as the database keeps them. */
export type OffsiteFailure = StorageErrorCode;

export class OffsiteError extends Error {
  constructor(
    readonly problem: OffsiteFailure,
    /** For the log alone: the provider's words, never shown, never kept. */
    readonly detail: string,
  ) {
    super(`off-site copy: ${problem}`);
    this.name = 'OffsiteError';
  }
}

/** A backup's own name, as backup.ts makes it: the only names the copy writes or removes. */
export const OFFSITE_COPY_NAME = /^fdv-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.sql\.enc$/;

/** Parts of a large copy: S3's least is 5 MiB; 16 MiB keeps memory small and calls few. */
export const OFFSITE_PART_BYTES = 16 * 1024 * 1024;

/** One request of a copy (a part, or a small file whole) gives up after this. */
const PART_TIMEOUT_MS = 10 * 60_000;

export function offsiteClient(b: OffsiteBucket): S3Client {
  return new S3Client({
    region: b.region || 'us-east-1',
    ...(b.endpoint ? { endpoint: b.endpoint } : {}),
    forcePathStyle: b.pathStyle,
    credentials: { accessKeyId: b.accessKeyId, secretAccessKey: b.secretAccessKey },
    // What is sent is ciphertext already; no checksum trailer, which some
    // providers refuse (as the storage adapter).
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    requestHandler: { connectionTimeout: CONNECT_TIMEOUT_MS },
  });
}

/** Where a name goes: under the prefix, or at the top of the bucket. */
export function offsiteKey(prefix: string | null, name: string): string {
  const p = (prefix ?? '').replace(/^\/+|\/+$/g, '');
  return p ? `${p}/${name}` : name;
}

/** A request's own time, ended sooner when the caller is told to stop (a job past its time). */
const within = (ms: number, stop?: AbortSignal) => ({
  abortSignal: stop ? AbortSignal.any([AbortSignal.timeout(ms), stop]) : AbortSignal.timeout(ms),
});
const quick = (stop?: AbortSignal) => within(QUICK_TIMEOUT_MS, stop);
const long = (stop?: AbortSignal) => within(PART_TIMEOUT_MS, stop);

function failure(err: unknown): OffsiteError {
  if (err instanceof OffsiteError) return err;
  const e = storageErrorOf(err);
  return new OffsiteError(e.code, e.detail ?? e.message);
}

/** What a test found besides that the copy can go: whether the key may delete there. */
export interface OffsiteTestFound {
  /**
   * False for a key that may write but not delete — a write-only key, the
   * safer kind: a server taken over cannot then wipe the copies. The copy
   * still goes, and the vault removes nothing (the bucket's own lifecycle
   * rule keeps the count down). Its test file is left behind, as it must be.
   */
  canDelete: boolean;
}

/**
 * "Send a test": a small file written under the prefix and its size read
 * back, the prefix listed (the copy lists it to keep the newest few), and
 * the file deleted again — every permission a copy needs, and whether the
 * key may delete. Throws OffsiteError when a copy could not go.
 */
export async function testOffsite(b: OffsiteBucket): Promise<OffsiteTestFound> {
  const client = offsiteClient(b);
  const key = offsiteKey(b.prefix, `.fdv-offsite-test-${randomBytes(8).toString('hex')}`);
  const body = Buffer.from(`family document vault off-site test ${new Date().toISOString()}\n`);
  let written = false;
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: b.bucket,
        Key: key,
        Body: body,
        ContentLength: body.length,
        ContentType: 'text/plain',
      }),
      quick(),
    );
    written = true;
    const head = await client.send(new HeadObjectCommand({ Bucket: b.bucket, Key: key }), quick());
    if (head.ContentLength !== body.length) {
      throw new OffsiteError(
        'verification_failed',
        `stored ${head.ContentLength} bytes, sent ${body.length}`,
      );
    }
    await client.send(
      new ListObjectsV2Command({ Bucket: b.bucket, Prefix: listPrefix(b.prefix), MaxKeys: 1 }),
      quick(),
    );
    try {
      await client.send(new DeleteObjectCommand({ Bucket: b.bucket, Key: key }), quick());
    } catch (err) {
      // A key that may not delete: a choice, said, not a failure.
      if (failure(err).problem === 'permission_denied') {
        written = false;
        return { canDelete: false };
      }
      throw err;
    }
    written = false;
    return { canDelete: true };
  } catch (err) {
    throw failure(err);
  } finally {
    if (written) {
      await client
        .send(new DeleteObjectCommand({ Bucket: b.bucket, Key: key }), quick())
        .catch(() => undefined);
    }
    client.destroy();
  }
}

/**
 * Copies one backup file there, under its own name, and checks the bucket
 * holds all of it. A file larger than a part goes in parts, read from disk
 * one at a time. Throws OffsiteError.
 */
export async function uploadOffsite(
  b: OffsiteBucket,
  file: string,
  /** Stops the copy, as its job's time runs out. */
  stop?: AbortSignal,
): Promise<{ key: string; bytes: number }> {
  const name = path.basename(file);
  if (!OFFSITE_COPY_NAME.test(name)) {
    throw new OffsiteError('unknown', `not a backup's name: ${name}`);
  }
  const key = offsiteKey(b.prefix, name);
  const bytes = (await stat(file)).size;
  const client = offsiteClient(b);
  const fh = await open(file, 'r');
  try {
    const read = async (at: number, length: number): Promise<Buffer> => {
      const buf = Buffer.alloc(length);
      let got = 0;
      while (got < length) {
        const { bytesRead } = await fh.read(buf, got, length - got, at + got);
        if (bytesRead === 0) throw new OffsiteError('unknown', 'the backup file grew shorter');
        got += bytesRead;
      }
      return buf;
    };
    if (bytes <= OFFSITE_PART_BYTES) {
      const body = await read(0, bytes);
      await client.send(
        new PutObjectCommand({
          Bucket: b.bucket,
          Key: key,
          Body: body,
          ContentLength: body.length,
          ContentType: 'application/octet-stream',
        }),
        long(stop),
      );
    } else {
      const created = await client.send(
        new CreateMultipartUploadCommand({
          Bucket: b.bucket,
          Key: key,
          ContentType: 'application/octet-stream',
        }),
        quick(stop),
      );
      const uploadId = created.UploadId;
      if (!uploadId) throw new OffsiteError('unknown', 'no upload id');
      try {
        const parts: { ETag: string; PartNumber: number }[] = [];
        for (let at = 0, n = 1; at < bytes; at += OFFSITE_PART_BYTES, n += 1) {
          const body = await read(at, Math.min(OFFSITE_PART_BYTES, bytes - at));
          const part = await client.send(
            new UploadPartCommand({
              Bucket: b.bucket,
              Key: key,
              UploadId: uploadId,
              PartNumber: n,
              Body: body,
              ContentLength: body.length,
            }),
            long(stop),
          );
          if (!part.ETag) throw new OffsiteError('unknown', `no ETag for part ${n}`);
          parts.push({ ETag: part.ETag, PartNumber: n });
        }
        await client.send(
          new CompleteMultipartUploadCommand({
            Bucket: b.bucket,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: { Parts: parts },
          }),
          long(stop),
        );
      } catch (err) {
        await client
          .send(
            new AbortMultipartUploadCommand({ Bucket: b.bucket, Key: key, UploadId: uploadId }),
            quick(),
          )
          .catch(() => undefined);
        throw err;
      }
    }
    const head = await client.send(
      new HeadObjectCommand({ Bucket: b.bucket, Key: key }),
      quick(stop),
    );
    if (head.ContentLength !== bytes) {
      throw new OffsiteError(
        'verification_failed',
        `stored ${head.ContentLength} bytes, sent ${bytes}`,
      );
    }
    return { key, bytes };
  } catch (err) {
    throw failure(err);
  } finally {
    await fh.close();
    client.destroy();
  }
}

/**
 * Keeps the newest `keep` of the vault's own copies there, and removes the
 * rest: only objects directly under the prefix whose name is a backup's,
 * never anything else in the bucket. Returns what it removed. Throws
 * OffsiteError.
 */
export async function pruneOffsite(b: OffsiteBucket, keep: number): Promise<string[]> {
  const client = offsiteClient(b);
  const prefix = listPrefix(b.prefix);
  try {
    const ours: string[] = [];
    let token: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: b.bucket,
          Prefix: prefix,
          // Only what is directly under the prefix: a folder below it is not ours.
          Delimiter: '/',
          ...(token ? { ContinuationToken: token } : {}),
        }),
        quick(),
      );
      for (const o of page.Contents ?? []) {
        const key = o.Key ?? '';
        if (!key.startsWith(prefix)) continue;
        const name = key.slice(prefix.length);
        if (OFFSITE_COPY_NAME.test(name)) ours.push(key);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    // A backup's name is its time, so the newest sort last.
    ours.sort();
    const gone = ours.slice(0, Math.max(0, ours.length - Math.max(1, keep)));
    for (const key of gone) {
      await client.send(new DeleteObjectCommand({ Bucket: b.bucket, Key: key }), quick());
    }
    return gone;
  } catch (err) {
    throw failure(err);
  } finally {
    client.destroy();
  }
}

/** What a listing asks for: the prefix and its '/', or the whole bucket's top. */
function listPrefix(prefix: string | null): string {
  const p = (prefix ?? '').replace(/^\/+|\/+$/g, '');
  return p ? `${p}/` : '';
}
