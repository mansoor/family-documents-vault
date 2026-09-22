import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import { deriveKey, EnvKeyProvider, FileKeyProvider, keyProviderFromEnv } from './master.js';
import {
  CHUNK_SIZE,
  ciphertextSize,
  DecryptStream,
  decryptRange,
  EncryptStream,
  HEADER_BYTES,
} from './stream.js';
import { credentialKey, newKdfParams, newKey, unwrapKey, wrapKey } from './wrap.js';

const SECRET = 'a-master-secret-of-at-least-thirty-two-bytes';

async function encrypt(key: Buffer, plain: Buffer, chunkSize?: number) {
  const enc = new EncryptStream(key, chunkSize);
  const [, ciphertext] = await Promise.all([pipeline(Readable.from([plain]), enc), buffer(enc)]);
  return { ciphertext, plainBytes: enc.plainBytes };
}

async function decrypt(key: Buffer, ciphertext: Buffer) {
  const dec = new DecryptStream(key);
  const [, plain] = await Promise.all([pipeline(Readable.from([ciphertext]), dec), buffer(dec)]);
  return plain;
}

describe('master key providers', () => {
  it('derives a 32-byte key that differs by purpose', () => {
    const a = deriveKey(SECRET, 'key-encryption-key');
    const b = deriveKey(SECRET, 'access-token-signing');
    expect(a).toHaveLength(32);
    expect(a.equals(b)).toBe(false);
    expect(deriveKey(SECRET, 'key-encryption-key').equals(a)).toBe(true);
  });

  it('refuses a short secret', () => {
    expect(() => deriveKey('short', 'x')).toThrow(/at least 32 bytes/);
  });

  it('env and file providers agree on the same secret', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fdv-key-'));
    try {
      const file = path.join(dir, 'master.key');
      await writeFile(file, `${SECRET}\n`);
      const fromFile = await new FileKeyProvider(file).keyEncryptionKey();
      const fromEnv = await new EnvKeyProvider(SECRET).keyEncryptionKey();
      expect(fromFile.equals(fromEnv)).toBe(true);
      expect(keyProviderFromEnv({ FDV_MASTER_KEY_FILE: file }).description).toContain('key file');
      expect(() => keyProviderFromEnv({})).toThrow(/FDV_MASTER_KEY/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('key wrapping', () => {
  const kek = deriveKey(SECRET, 'key-encryption-key');

  it('round-trips and is 60 bytes on the wire', () => {
    const k = newKey();
    const w = wrapKey(k, kek, 'scope:abc');
    expect(w).toHaveLength(60);
    expect(unwrapKey(w, kek, 'scope:abc').equals(k)).toBe(true);
  });

  it('fails with the wrong wrapping key or the wrong binding', () => {
    const w = wrapKey(newKey(), kek, 'scope:abc');
    expect(() => unwrapKey(w, deriveKey(SECRET, 'other'), 'scope:abc')).toThrow(/cannot unwrap/);
    expect(() => unwrapKey(w, kek, 'scope:xyz')).toThrow(/cannot unwrap/);
  });

  it('never produces the same ciphertext twice for one key', () => {
    const k = newKey();
    expect(wrapKey(k, kek, 'b').equals(wrapKey(k, kek, 'b'))).toBe(false);
  });

  it('derives a stable credential key from a password and its parameters', async () => {
    const params = newKdfParams();
    const a = await credentialKey('correct horse battery', params);
    const b = await credentialKey('correct horse battery', params);
    const c = await credentialKey('wrong horse', params);
    expect(a).toHaveLength(32);
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);

    const member = newKey();
    const w = wrapKey(member, a, 'member:1');
    expect(unwrapKey(w, a, 'member:1').equals(member)).toBe(true);
    expect(() => unwrapKey(w, c, 'member:1')).toThrow();
  });
});

describe('file encryption', () => {
  const key = newKey();

  it.each([0, 1, 100, CHUNK_SIZE - 1, CHUNK_SIZE, CHUNK_SIZE + 1, 3 * CHUNK_SIZE + 17])(
    'round-trips %i bytes and matches the predicted size',
    async (n) => {
      const plain = randomBytes(n);
      const { ciphertext, plainBytes } = await encrypt(key, plain);
      expect(plainBytes).toBe(n);
      expect(ciphertext).toHaveLength(ciphertextSize(n));
      expect((await decrypt(key, ciphertext)).equals(plain)).toBe(true);
    },
  );

  it('the ciphertext shares nothing with the plaintext', async () => {
    const plain = Buffer.alloc(5000, 'A');
    const { ciphertext } = await encrypt(key, plain);
    expect(ciphertext.subarray(HEADER_BYTES).includes(Buffer.from('AAAAAAAA'))).toBe(false);
  });

  it('rejects the wrong key, an altered byte, a swapped chunk and truncation', async () => {
    const plain = randomBytes(3 * 1000 + 5);
    const { ciphertext } = await encrypt(key, plain, 1000);

    await expect(decrypt(newKey(), ciphertext)).rejects.toThrow(/failed authentication/);

    const altered = Buffer.from(ciphertext);
    altered[HEADER_BYTES + 10] = (altered[HEADER_BYTES + 10] ?? 0) ^ 0x01;
    await expect(decrypt(key, altered)).rejects.toThrow(/failed authentication/);

    const sealed = 1000 + 16;
    const swapped = Buffer.concat([
      ciphertext.subarray(0, HEADER_BYTES),
      ciphertext.subarray(HEADER_BYTES + sealed, HEADER_BYTES + 2 * sealed),
      ciphertext.subarray(HEADER_BYTES, HEADER_BYTES + sealed),
      ciphertext.subarray(HEADER_BYTES + 2 * sealed),
    ]);
    await expect(decrypt(key, swapped)).rejects.toThrow(/failed authentication/);

    const truncated = ciphertext.subarray(0, HEADER_BYTES + 2 * sealed);
    await expect(decrypt(key, truncated)).rejects.toThrow(/failed authentication/);

    await expect(decrypt(key, Buffer.from('not a vault file at all'))).rejects.toThrow(
      /not an encrypted vault file/,
    );
  });

  it('decrypts arbitrary byte ranges without reading the whole file', async () => {
    const plain = randomBytes(4 * 1000 + 321);
    const { ciphertext } = await encrypt(key, plain, 1000);
    const reads: Array<[number, number]> = [];
    const read = async (s: number, e: number) => {
      reads.push([s, e]);
      return ciphertext.subarray(s, e + 1);
    };

    for (const [start, end] of [
      [0, 0],
      [0, 999],
      [999, 1000],
      [1500, 2600],
      [4000, 4320],
      [0, 4320],
      [4320, 4320],
    ] as const) {
      const got = await decryptRange(key, plain.length, { start, end }, read);
      expect(got.equals(plain.subarray(start, end + 1))).toBe(true);
    }

    // The [1500, 2600] read must have touched chunks 1 and 2 only.
    reads.length = 0;
    await decryptRange(key, plain.length, { start: 1500, end: 2600 }, read);
    const body = reads[1] as [number, number];
    expect(body[0]).toBe(HEADER_BYTES + 1 * (1000 + 16));
    expect(body[1]).toBe(HEADER_BYTES + 3 * (1000 + 16) - 1);

    await expect(decryptRange(key, plain.length, { start: 0, end: 5000 }, read)).rejects.toThrow(
      RangeError,
    );
  });
});
