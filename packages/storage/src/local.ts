import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  MESSAGES,
  StorageError,
  type ByteRange,
  type PutMeta,
  type PutResult,
  type StorageAdapter,
  type TestResult,
} from './adapter.js';

/**
 * A directory on the server or a NAS. The default; works with no internet.
 *
 * Writes go to a temp file beside the target and are renamed into place
 * only after the bytes have been re-read and hashed, so a crash mid-write
 * never leaves a half object under the real key.
 */
export class LocalAdapter implements StorageAdapter {
  readonly kind = 'local' as const;
  readonly description: string;

  constructor(private readonly root: string) {
    this.description = `the folder ${root} on this computer`;
  }

  private resolve(key: string): string {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) {
      throw new StorageError('unknown', MESSAGES.unknown, `key escapes root: ${key}`);
    }
    return full;
  }

  async put(key: string, body: Readable, meta: PutMeta = {}): Promise<PutResult> {
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${randomBytes(4).toString('hex')}.tmp`;

    const hash = createHash('sha256');
    let bytes = 0;
    body.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      bytes += chunk.length;
    });
    try {
      await pipeline(body, createWriteStream(tmp, { flags: 'wx' }));
      if (meta.bytes !== undefined && meta.bytes !== bytes) {
        throw new StorageError(
          'verification_failed',
          MESSAGES.verification_failed,
          `expected ${meta.bytes} bytes, wrote ${bytes}`,
        );
      }
      const expected = hash.digest('hex');
      const actual = await hashFile(tmp);
      if (actual !== expected) {
        throw new StorageError(
          'verification_failed',
          MESSAGES.verification_failed,
          'sha256 mismatch',
        );
      }
      await rename(tmp, target);
      return { bytes, sha256: expected };
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw wrap(err);
    }
  }

  async get(key: string, range?: ByteRange): Promise<Readable> {
    const full = this.resolve(key);
    try {
      await stat(full);
    } catch (err) {
      throw wrap(err);
    }
    return createReadStream(full, range ? { start: range.start, end: range.end } : {});
  }

  async stat(key: string): Promise<{ bytes: number }> {
    try {
      return { bytes: (await stat(this.resolve(key))).size };
    } catch (err) {
      throw wrap(err);
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async signedUrl(): Promise<null> {
    return null;
  }

  async test(): Promise<TestResult> {
    const key = `.fdv-test/${randomBytes(8).toString('hex')}`;
    const payload = Buffer.from(`family document vault test ${new Date().toISOString()}`);
    try {
      const { Readable } = await import('node:stream');
      await this.put(key, Readable.from([payload]));
      const back = await readAll(await this.get(key));
      await this.delete(key);
      if (!back.equals(payload)) {
        return { ok: false, code: 'verification_failed', message: MESSAGES.verification_failed };
      }
      return {
        ok: true,
        message: `Connected. Wrote a test file to ${this.root} and read it back.`,
      };
    } catch (err) {
      const e = wrap(err);
      const result: TestResult = { ok: false, code: e.code, message: e.message };
      if (e.detail) result.detail = e.detail;
      return result;
    }
  }
}

async function hashFile(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

export async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function wrap(err: unknown): StorageError {
  if (err instanceof StorageError) return err;
  const e = err as NodeJS.ErrnoException;
  switch (e.code) {
    case 'ENOENT':
      return new StorageError('not_found', MESSAGES.not_found, e.message);
    case 'EACCES':
    case 'EPERM':
      return new StorageError('permission_denied', MESSAGES.permission_denied, e.message);
    case 'ENOSPC':
      return new StorageError('unknown', 'The disk where your files are kept is full.', e.message);
    default:
      return new StorageError('unknown', MESSAGES.unknown, e.message);
  }
}
