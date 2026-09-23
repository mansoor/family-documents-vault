import type { Readable } from 'node:stream';

/**
 * The four-method storage interface from the design, plus the two small
 * additions the implementation needed: `stat` (for verification and Range
 * arithmetic) and `test` (the Storage screen's "Test" button).
 *
 * The application never calls a storage SDK directly. Everything it stores
 * is ciphertext; the adapter neither knows nor cares.
 */
export interface StorageAdapter {
  readonly kind: 'local' | 's3';
  /** Where this is, in words a person can read. Never includes secrets. */
  readonly description: string;

  /**
   * Writes the stream under `key`. Returns the SHA-256 of what was written,
   * verified against the bytes actually stored (NFR-06): local re-reads the
   * file; S3 receives the digest with the upload and refuses a mismatch.
   */
  put(key: string, body: Readable, meta?: PutMeta): Promise<PutResult>;

  /** Reads the object, or the inclusive byte range `[start, end]`. */
  get(key: string, range?: ByteRange): Promise<Readable>;

  /** Size in bytes; throws NotFound. */
  stat(key: string): Promise<{ bytes: number }>;

  delete(key: string): Promise<void>;

  /** A direct URL, or null when the backend cannot or should not hand one out. */
  signedUrl(key: string, ttlSeconds: number): Promise<string | null>;

  /** Writes a small object, reads it back, deletes it. Never throws. */
  test(): Promise<TestResult>;
}

export interface PutMeta {
  contentType?: string;
  /** Expected size, when known; lets local storage fail early on a short write. */
  bytes?: number;
}

export interface PutResult {
  bytes: number;
  /** Hex SHA-256 of the stored bytes. */
  sha256: string;
  etag?: string;
}

export interface ByteRange {
  start: number;
  end: number;
}

export interface TestResult {
  ok: boolean;
  /** Written for a non-technical reader; safe to display verbatim. */
  message: string;
  /** For logs and support. */
  detail?: string;
  code?: StorageErrorCode;
}

export type StorageErrorCode =
  | 'not_found'
  | 'unreachable'
  | 'credentials_rejected'
  | 'bucket_missing'
  | 'permission_denied'
  | 'verification_failed'
  | 'unknown';

export class StorageError extends Error {
  constructor(
    public readonly code: StorageErrorCode,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

/** Plain-language messages for each failure, used by every adapter. */
export const MESSAGES: Record<StorageErrorCode, string> = {
  not_found: 'That file is not where your files are kept.',
  unreachable: "We can't reach where your files are kept.",
  credentials_rejected: 'The key ID or application key was not accepted.',
  bucket_missing: 'That bucket does not exist, or the key cannot see it.',
  permission_denied: 'The key is not allowed to write there.',
  verification_failed: 'The file was written, but reading it back gave something different.',
  unknown: 'Something went wrong with where your files are kept.',
};

/**
 * The object key layout. Deliberately boring, so a household can recover
 * files with nothing but their storage provider's own console:
 *
 *   <prefix>/<household-id>/<document-id>/<version-no>/<random>.<ext>.enc
 *
 * The last part is random, not derived from the file. Until 0.4.2 it was
 * the first 64 bits of the plaintext's SHA-256, which let whoever controls
 * the bucket — an owner can point storage anywhere — confirm that a file
 * they already had was in somebody else's private documents.
 */
export function objectKey(p: {
  prefix?: string | null;
  householdId: string;
  documentId: string;
  versionNo: number;
  /** Random; says nothing about the contents. */
  name: string;
  ext: string;
}): string {
  const ext = p.ext.replace(/^\./, '').toLowerCase() || 'bin';
  const parts = [p.householdId, p.documentId, String(p.versionNo), `${p.name}.${ext}.enc`];
  const prefix = (p.prefix ?? '').replace(/^\/+|\/+$/g, '');
  return prefix ? `${prefix}/${parts.join('/')}` : parts.join('/');
}
