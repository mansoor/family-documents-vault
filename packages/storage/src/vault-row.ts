import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { StorageAdapter } from './adapter.js';
import { LocalAdapter } from './local.js';
import { S3Adapter } from './s3.js';

/**
 * From a `vault` row to a live adapter. Shared by the API (uploads and
 * downloads) and the worker (OCR and thumbnails), so both open objects the
 * same way.
 */

export interface VaultRowLike {
  id: string;
  kind: 'local' | 's3';
  label: string;
  endpoint: string | null;
  bucket: string | null;
  region: string | null;
  path_style: boolean;
  credentials_encrypted: Buffer | null;
}

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

const CIPHER = 'aes-256-gcm';

/** Bucket credentials at rest: AES-GCM under a master-derived key, bound to the vault id. */
export function sealCredentials(key: Buffer, creds: Credentials, vaultId: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv(CIPHER, key, iv);
  c.setAAD(Buffer.from(`vault:${vaultId}`));
  const ct = Buffer.concat([c.update(JSON.stringify(creds), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

export function openCredentials(key: Buffer, sealed: Buffer, vaultId: string): Credentials {
  const d = createDecipheriv(CIPHER, key, sealed.subarray(0, 12));
  d.setAAD(Buffer.from(`vault:${vaultId}`));
  d.setAuthTag(sealed.subarray(12, 28));
  const json = Buffer.concat([d.update(sealed.subarray(28)), d.final()]).toString('utf8');
  return JSON.parse(json) as Credentials;
}

export function adapterFromRow(
  row: VaultRowLike,
  credentialsKey: Buffer,
  localRoot: string,
): StorageAdapter {
  if (row.kind === 'local') return new LocalAdapter(localRoot);
  if (!row.credentials_encrypted || !row.bucket) {
    throw new Error(`vault ${row.id} is missing its bucket or credentials`);
  }
  const creds = openCredentials(credentialsKey, row.credentials_encrypted, row.id);
  return new S3Adapter({
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    pathStyle: row.path_style,
    providerName: row.label,
    ...creds,
  });
}
