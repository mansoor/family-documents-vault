import { open, type FileHandle } from 'node:fs/promises';
import {
  decodeHeader,
  deriveKey,
  ensureMasterKey,
  HEADER_BYTES,
  MasterKeyMismatch,
  openChunk,
  type RekeyReport,
} from '@fdv/crypto';
import { createPool } from '@fdv/db';
import type { Log } from './restore.js';

export type { RekeyReport };

/**
 * A backup made before the master key was rotated (README, "Rotating the
 * master key"). The file is encrypted under the key it was made with, and
 * so is what it holds — its scope keys and the secrets sealed under
 * master-derived keys. Given that key as FDV_MASTER_KEY_PREVIOUS, a restore
 * opens the file with it and then moves what it holds onto the vault's
 * current key, before anything reads it.
 */
export interface MasterKeys {
  /** FDV_MASTER_KEY: what the restored vault runs with. */
  current: string;
  /** FDV_MASTER_KEY_PREVIOUS: the key a backup from before a rotation was made with. */
  previous?: string | undefined;
}

const CHUNK_TAG_BYTES = 16;

/**
 * The key to load a backup with: this vault's backup key or, for a backup
 * made before a rotation, the previous master key's. The first chunk is
 * enough to tell them apart. When neither opens it, this vault's, for the
 * load to say what is wrong as it always has.
 */
export async function backupKeyFor(
  file: string,
  backupKey: Buffer,
  previous: string | undefined,
): Promise<Buffer> {
  if (previous === undefined) return backupKey;
  const older = deriveKey(previous, 'database-backup');
  let handle: FileHandle | null = null;
  try {
    handle = await open(file, 'r');
    const { size } = await handle.stat();
    const head = Buffer.alloc(HEADER_BYTES);
    await handle.read(head, 0, HEADER_BYTES, 0);
    const header = decodeHeader(head);
    const sealedSize = header.chunkSize + CHUNK_TAG_BYTES;
    const rest = Math.max(0, size - HEADER_BYTES);
    const first = Buffer.alloc(Math.min(sealedSize, rest));
    await handle.read(first, 0, first.length, HEADER_BYTES);
    for (const key of [backupKey, older]) {
      try {
        openChunk(key, header, 0, rest <= sealedSize, first);
        return key;
      } catch {
        // not this one
      }
    }
  } catch {
    // Not there, or not a backup: the load says so.
  } finally {
    await handle?.close();
  }
  return backupKey;
}

/**
 * Everything the master key protects in the restored database, opening
 * with the vault's current key: moved there, in one transaction, from the
 * previous key if that is what it is under. When it opens with neither —
 * or part with one and part with the other — nothing is moved and the
 * restore fails, rather than leave a vault part of which cannot be opened.
 */
export async function onCurrentKey(
  adminUrl: string,
  master: MasterKeys,
  log: Log,
): Promise<RekeyReport | null> {
  const admin = createPool(adminUrl, 1);
  try {
    const moved = await ensureMasterKey(admin, master.current, master.previous);
    if (moved) log('info', 'backup moved onto the current master key', { ...moved });
    return moved;
  } catch (err) {
    if (!(err instanceof MasterKeyMismatch)) throw err;
    throw new Error(
      master.previous === undefined
        ? `${err.what} does not open with this vault's master key: the backup was made under ` +
            'another one. If that was before a rotation, restore it again with ' +
            'FDV_MASTER_KEY_PREVIOUS set to the key it was made with'
        : `${err.what} does not open with FDV_MASTER_KEY_PREVIOUS, and not all of the backup ` +
            "opens with this vault's own master key, so nothing was moved: what a backup holds " +
            'must be all under one key or all under the other',
      { cause: err },
    );
  } finally {
    await admin.end();
  }
}
