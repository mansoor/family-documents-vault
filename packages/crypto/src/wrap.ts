import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';

/**
 * Key wrapping: one 32-byte key encrypted under another with AES-256-GCM.
 *
 * Wire format: `iv (12) || tag (16) || ciphertext (32)` = 60 bytes.
 * The `binding` string is authenticated as additional data, so a wrapped
 * key copied from one row to another (a different scope, a different
 * household) fails to unwrap rather than silently decrypting the wrong
 * thing.
 */

export const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function newKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

export function wrapKey(key: Buffer, wrappingKey: Buffer, binding: string): Buffer {
  if (key.length !== KEY_BYTES) throw new Error('key must be 32 bytes');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', wrappingKey, iv);
  cipher.setAAD(Buffer.from(binding, 'utf8'));
  const ct = Buffer.concat([cipher.update(key), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function unwrapKey(wrapped: Buffer, wrappingKey: Buffer, binding: string): Buffer {
  if (wrapped.length !== IV_BYTES + TAG_BYTES + KEY_BYTES) throw new Error('malformed wrapped key');
  const iv = wrapped.subarray(0, IV_BYTES);
  const tag = wrapped.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = wrapped.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', wrappingKey, iv);
  decipher.setAAD(Buffer.from(binding, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new Error('cannot unwrap key: wrong wrapping key or binding');
  }
}

export function keysEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The credential-derived key (SEC-14): a member's scope key is additionally
 * wrapped under a key stretched from their password, so recovery and
 * escrow can work without the server's master key. Parameters are stored
 * beside the wrapped key so they can be raised later without a flag day.
 */
export interface KdfParams {
  algorithm: 'argon2id';
  salt: string; // base64url
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

export function newKdfParams(): KdfParams {
  return {
    algorithm: 'argon2id',
    salt: randomBytes(16).toString('base64url'),
    memoryKiB: 64 * 1024,
    iterations: 3,
    parallelism: 1,
  };
}

export async function credentialKey(password: string, params: KdfParams): Promise<Buffer> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    raw: true,
    salt: Buffer.from(params.salt, 'base64url'),
    memoryCost: params.memoryKiB,
    timeCost: params.iterations,
    parallelism: params.parallelism,
    hashLength: KEY_BYTES,
  });
}
