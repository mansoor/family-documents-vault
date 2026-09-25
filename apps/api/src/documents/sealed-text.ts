import { openChunk } from '@fdv/crypto';

/**
 * A private document's page text, as the worker seals it when it reads the
 * pages: `prefix(8) || ciphertext || tag`, one chunk under the document's
 * scope key. Opened only in its owner's own request (the second search
 * pass, the issuer suggestions), never stored opened. Null for a blob that
 * cannot be opened: that is no text, not an error.
 */
export function openSealedText(key: Buffer, blob: Buffer): string | null {
  if (blob.length < 8 + 16) return null;
  const prefix = blob.subarray(0, 8);
  const body = blob.subarray(8);
  try {
    return openChunk(key, { prefix, chunkSize: body.length - 16 }, 0, true, body).toString('utf8');
  } catch {
    return null;
  }
}
