import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';
import { KEY_BYTES } from './wrap.js';

/**
 * File content encryption: AES-256-GCM in independent chunks.
 *
 * A single GCM stream cannot be read from the middle, and a passport scan
 * being shown at a counter must not wait for a 50 MB PDF's preceding bytes.
 * So the plaintext is cut into fixed-size chunks and each is sealed on its
 * own:
 *
 *   chunk i  ->  nonce = prefix (8 bytes, random per file) || i (4 bytes BE)
 *                aad   = i (4 bytes BE) || last (1 byte)
 *                out   = ciphertext (n bytes) || tag (16 bytes)
 *
 * The chunk index in the nonce and AAD stops reordering; the `last` flag
 * stops truncation; the per-file prefix stops nonce reuse across files. A
 * Range request maps byte offsets to chunk indices, decrypts only those,
 * and trims.
 *
 * Ciphertext layout: header (magic 4 || version 1 || prefix 8 || chunkSize 4)
 * followed by the chunks. The header is authenticated by every chunk through
 * the nonce prefix and chunk size being derived from it.
 */

export const CHUNK_SIZE = 1024 * 1024; // plaintext bytes per chunk
const TAG = 16;
const MAGIC = Buffer.from('FDV1');
export const HEADER_BYTES = 4 + 1 + 8 + 4;

export interface FileHeader {
  prefix: Buffer;
  chunkSize: number;
}

export function encodeHeader(h: FileHeader): Buffer {
  const b = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(b, 0);
  b.writeUInt8(1, 4);
  h.prefix.copy(b, 5);
  b.writeUInt32BE(h.chunkSize, 13);
  return b;
}

export function decodeHeader(b: Buffer): FileHeader {
  if (b.length < HEADER_BYTES || !b.subarray(0, 4).equals(MAGIC) || b.readUInt8(4) !== 1) {
    throw new Error('not an encrypted vault file');
  }
  return { prefix: Buffer.from(b.subarray(5, 13)), chunkSize: b.readUInt32BE(13) };
}

function nonce(prefix: Buffer, index: number): Buffer {
  const n = Buffer.alloc(12);
  prefix.copy(n, 0);
  n.writeUInt32BE(index, 8);
  return n;
}

function aad(index: number, last: boolean): Buffer {
  const a = Buffer.alloc(5);
  a.writeUInt32BE(index, 0);
  a.writeUInt8(last ? 1 : 0, 4);
  return a;
}

export function sealChunk(key: Buffer, h: FileHeader, index: number, last: boolean, plain: Buffer) {
  const c = createCipheriv('aes-256-gcm', key, nonce(h.prefix, index));
  c.setAAD(aad(index, last));
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}

export function openChunk(
  key: Buffer,
  h: FileHeader,
  index: number,
  last: boolean,
  sealed: Buffer,
) {
  if (sealed.length < TAG) throw new Error('truncated chunk');
  const d = createDecipheriv('aes-256-gcm', key, nonce(h.prefix, index));
  d.setAAD(aad(index, last));
  d.setAuthTag(sealed.subarray(sealed.length - TAG));
  try {
    return Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG)), d.final()]);
  } catch {
    throw new Error('content failed authentication: wrong key, or the file was altered');
  }
}

/** Size of the ciphertext for a plaintext of `plainBytes`. */
export function ciphertextSize(plainBytes: number, chunkSize = CHUNK_SIZE): number {
  const chunks = Math.max(1, Math.ceil(plainBytes / chunkSize));
  return HEADER_BYTES + plainBytes + chunks * TAG;
}

/** Byte offset of chunk `i` within the ciphertext. */
export function chunkOffset(i: number, chunkSize = CHUNK_SIZE): number {
  return HEADER_BYTES + i * (chunkSize + TAG);
}

/**
 * Transform: plaintext in, ciphertext out. Emits the header first, then one
 * sealed chunk per `chunkSize` bytes; the final chunk (possibly empty) is
 * marked last.
 */
export class EncryptStream extends Transform {
  private buf: Buffer = Buffer.alloc(0);
  private index = 0;
  private readonly header: FileHeader;
  /** Number of plaintext bytes seen; available after 'finish'. */
  plainBytes = 0;

  constructor(
    private readonly key: Buffer,
    chunkSize = CHUNK_SIZE,
  ) {
    super();
    if (key.length !== KEY_BYTES) throw new Error('file key must be 32 bytes');
    this.header = { prefix: randomBytes(8), chunkSize };
    this.push(encodeHeader(this.header));
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    this.plainBytes += chunk.length;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length > this.header.chunkSize) {
      const plain = this.buf.subarray(0, this.header.chunkSize);
      this.buf = this.buf.subarray(this.header.chunkSize);
      this.push(sealChunk(this.key, this.header, this.index++, false, plain));
    }
    cb();
  }

  override _flush(cb: TransformCallback) {
    // Whatever remains (0..chunkSize bytes) is the last chunk. An exact
    // multiple still ends with a full last chunk, never an empty one, unless
    // the file itself is empty.
    this.push(sealChunk(this.key, this.header, this.index++, true, this.buf));
    this.buf = Buffer.alloc(0);
    cb();
  }
}

/**
 * Transform: ciphertext in, plaintext out. Verifies every chunk; a wrong key
 * or an altered byte fails the stream rather than yielding garbage.
 */
export class DecryptStream extends Transform {
  private buf: Buffer = Buffer.alloc(0);
  private header: FileHeader | null = null;
  private index = 0;

  constructor(private readonly key: Buffer) {
    super();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    try {
      if (!this.header) {
        if (this.buf.length < HEADER_BYTES) return cb();
        this.header = decodeHeader(this.buf);
        this.buf = this.buf.subarray(HEADER_BYTES);
      }
      const sealedSize = this.header.chunkSize + TAG;
      // Keep at least one full sealed chunk plus one byte back, so we can
      // tell a full middle chunk from a full *last* chunk at flush time.
      while (this.buf.length > sealedSize) {
        const sealed = this.buf.subarray(0, sealedSize);
        this.buf = this.buf.subarray(sealedSize);
        this.push(openChunk(this.key, this.header, this.index++, false, sealed));
      }
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  override _flush(cb: TransformCallback) {
    try {
      if (!this.header) throw new Error('not an encrypted vault file');
      this.push(openChunk(this.key, this.header, this.index++, true, this.buf));
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }
}

/**
 * Decrypts a byte range. Given a reader for arbitrary ciphertext byte
 * ranges, fetches only the chunks that cover `[start, end]` (inclusive
 * plaintext offsets) and returns exactly those plaintext bytes.
 */
export async function decryptRange(
  key: Buffer,
  plainBytes: number,
  range: { start: number; end: number },
  readCiphertext: (start: number, end: number) => Promise<Buffer>,
): Promise<Buffer> {
  if (range.start < 0 || range.end >= plainBytes || range.start > range.end) {
    throw new RangeError('range outside content');
  }
  const header = decodeHeader(await readCiphertext(0, HEADER_BYTES - 1));
  const cs = header.chunkSize;
  const lastIndex = Math.max(0, Math.ceil(plainBytes / cs) - 1);
  const first = Math.floor(range.start / cs);
  const last = Math.floor(range.end / cs);
  const lastChunkPlain = plainBytes - lastIndex * cs;

  const from = chunkOffset(first, cs);
  const to = chunkOffset(last, cs) + (last === lastIndex ? lastChunkPlain : cs) + TAG - 1;
  const sealed = await readCiphertext(from, to);

  const parts: Buffer[] = [];
  let cursor = 0;
  for (let i = first; i <= last; i++) {
    const isLast = i === lastIndex;
    const size = (isLast ? lastChunkPlain : cs) + TAG;
    parts.push(openChunk(key, header, i, isLast, sealed.subarray(cursor, cursor + size)));
    cursor += size;
  }
  const plain = Buffer.concat(parts);
  const offset = range.start - first * cs;
  return plain.subarray(offset, offset + (range.end - range.start + 1));
}
