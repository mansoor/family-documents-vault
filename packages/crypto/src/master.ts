import { hkdfSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/**
 * The master key never enters the database. This is the seam between the
 * self-hosted edition (an environment variable or a file) and the hosted
 * edition (a KMS): everything above it only ever sees a 32-byte
 * key-encryption key.
 */
export interface KeyProvider {
  /** The 32-byte key that wraps scope keys. Called rarely; cache freely. */
  keyEncryptionKey(): Promise<Buffer>;
  /** Where the key comes from, for logs and the settings screen. Never the key. */
  readonly description: string;
}

/**
 * Whatever the operator supplies — a base64url string from gen-env, a
 * passphrase they typed, a file's contents — is stretched to exactly 32
 * bytes with HKDF. The same function derives every other purpose-bound key
 * (session signing, for one) with a different `info`, so one secret backs
 * the whole installation and purposes cannot collide.
 */
export function deriveKey(masterSecret: string | Buffer, purpose: string): Buffer {
  const secret =
    typeof masterSecret === 'string' ? Buffer.from(masterSecret, 'utf8') : masterSecret;
  if (secret.length < 32) throw new Error('master secret must be at least 32 bytes');
  return Buffer.from(hkdfSync('sha256', secret, 'fdv', purpose, 32));
}

export const KEK_PURPOSE = 'key-encryption-key';

export class EnvKeyProvider implements KeyProvider {
  readonly description = 'environment variable FDV_MASTER_KEY';
  private readonly kek: Buffer;
  constructor(masterSecret: string) {
    this.kek = deriveKey(masterSecret, KEK_PURPOSE);
  }
  async keyEncryptionKey(): Promise<Buffer> {
    return this.kek;
  }
}

export class FileKeyProvider implements KeyProvider {
  readonly description: string;
  private kek: Buffer | null = null;
  constructor(private readonly path: string) {
    this.description = `key file ${path}`;
  }
  async keyEncryptionKey(): Promise<Buffer> {
    if (!this.kek) {
      const raw = (await readFile(this.path, 'utf8')).trim();
      this.kek = deriveKey(raw, KEK_PURPOSE);
    }
    return this.kek;
  }
}

/** Picks the provider from configuration: a file path wins over the variable. */
export function keyProviderFromEnv(env: NodeJS.ProcessEnv = process.env): KeyProvider {
  if (env.FDV_MASTER_KEY_FILE) return new FileKeyProvider(env.FDV_MASTER_KEY_FILE);
  if (env.FDV_MASTER_KEY) return new EnvKeyProvider(env.FDV_MASTER_KEY);
  throw new Error('set FDV_MASTER_KEY or FDV_MASTER_KEY_FILE');
}
