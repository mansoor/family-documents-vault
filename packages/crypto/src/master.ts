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
 *
 * A purpose whose sealed values are kept in the database must be listed in
 * MASTER_SEALED (master-rotation.ts): rotating the master key moves only
 * what is there, and anything else would stay sealed under the old key.
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

/**
 * The one secret behind the installation, as the API, the worker and their
 * commands read it: FDV_MASTER_KEY, or the contents of FDV_MASTER_KEY_FILE
 * (a Docker secret, say: the key is then in no container's environment).
 *
 * Both may be set while moving from one to the other, but only to the same
 * key: two different keys are refused, never one silently preferred, since
 * running on the wrong one writes new secrets under it. An empty file is
 * refused too. Throws an Error whose message says what to do.
 */
export async function readMasterSecret(config: {
  FDV_MASTER_KEY?: string | undefined;
  FDV_MASTER_KEY_FILE?: string | undefined;
}): Promise<string> {
  const fromEnv = config.FDV_MASTER_KEY || undefined;
  if (!config.FDV_MASTER_KEY_FILE) {
    if (fromEnv === undefined) throw new Error('set FDV_MASTER_KEY or FDV_MASTER_KEY_FILE');
    return fromEnv;
  }
  let fromFile: string;
  try {
    fromFile = (await readFile(config.FDV_MASTER_KEY_FILE, 'utf8')).trim();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? String(err);
    throw new Error(
      `FDV_MASTER_KEY_FILE is ${config.FDV_MASTER_KEY_FILE}, which cannot be read (${code}): ` +
        'is the file mounted into this container, and readable by its user (uid 1000)?',
      { cause: err },
    );
  }
  if (!fromFile) {
    throw new Error(`FDV_MASTER_KEY_FILE is ${config.FDV_MASTER_KEY_FILE}, which is empty`);
  }
  if (fromEnv !== undefined && fromEnv.trim() !== fromFile) {
    throw new Error(
      'FDV_MASTER_KEY and FDV_MASTER_KEY_FILE are both set, to different keys. Keep one: ' +
        'remove FDV_MASTER_KEY from .env once the same key is in the file (README, ' +
        '"Keeping the master key in a file").',
    );
  }
  return fromFile;
}

/** Picks the provider from configuration: a file path wins over the variable. */
export function keyProviderFromEnv(env: NodeJS.ProcessEnv = process.env): KeyProvider {
  if (env.FDV_MASTER_KEY_FILE) return new FileKeyProvider(env.FDV_MASTER_KEY_FILE);
  if (env.FDV_MASTER_KEY) return new EnvKeyProvider(env.FDV_MASTER_KEY);
  throw new Error('set FDV_MASTER_KEY or FDV_MASTER_KEY_FILE');
}
