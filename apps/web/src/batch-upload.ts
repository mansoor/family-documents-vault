import { ApiRequestError, NetworkError, parseRetryAfter } from '@fdv/client';
import type { BatchItemView } from '@fdv/shared';
import { api } from './api.js';

/**
 * One file into a batch (Phase 6, I1): `POST /api/v1/batches/{id}/items`,
 * multipart, the file alone, signed in. Sent with XMLHttpRequest, not
 * fetch: only it says how much of a file has gone, and two hundred scans
 * over a home connection take a while. What the vault refuses comes back as
 * the app's own error, in the vault's words, as every other call's does.
 */
export interface BatchSending {
  done: Promise<BatchItemView>;
  /** Stops sending it: `done` then rejects with an AbortError, and the vault keeps nothing of it. */
  stop: () => void;
}

export function sendBatchItem(
  token: string,
  batchId: string,
  file: File,
  progress: (sent: number, total: number) => void,
): BatchSending {
  const xhr = new XMLHttpRequest();
  const done = new Promise<BatchItemView>((resolve, reject) => {
    xhr.open('POST', api.batchItemsUrl(batchId));
    xhr.setRequestHeader('accept', 'application/json');
    xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) progress(e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as BatchItemView);
        } catch {
          reject(new ApiRequestError(xhr.status, 'http_error', 'The vault answered oddly.'));
        }
        return;
      }
      reject(refusal(xhr));
    };
    xhr.onerror = () => reject(new NetworkError('offline'));
    xhr.onabort = () => reject(new DOMException('Stopped', 'AbortError'));
    const form = new FormData();
    form.append('file', file, file.name);
    xhr.send(form);
  });
  return { done, stop: () => xhr.abort() };
}

/** The vault's refusal, read as `@fdv/client` reads one. */
function refusal(xhr: XMLHttpRequest): ApiRequestError {
  let body: {
    error?: { code?: string; message?: string; retriable?: boolean; detail?: string };
  } = {};
  try {
    body = JSON.parse(xhr.responseText) as typeof body;
  } catch {
    // Not JSON: the generic words below.
  }
  const e = body.error ?? {};
  const retryAfter = parseRetryAfter(xhr.getResponseHeader('retry-after'), Date.now());
  return new ApiRequestError(
    xhr.status,
    e.code ?? 'http_error',
    e.message ?? `The vault answered ${xhr.status}.`,
    undefined,
    {
      ...(e.retriable === true ? { retriable: true } : {}),
      ...(e.detail !== undefined ? { detail: e.detail } : {}),
      ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
    },
  );
}

/**
 * A file's SHA-256, in hex, as the vault keeps an item's: what a resumed
 * upload compares, with the name and the size, before it sends a file again.
 */
export async function sha256Of(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await bytesOf(file));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The kinds a single add takes, by what a file says it is or is called: a
 * file of any other kind is not sent, and says why. The vault decides from
 * the bytes; this only saves sending what it would refuse.
 */
export const BATCH_ACCEPT = 'application/pdf,image/*,.heic,.heif,.tif,.tiff,.webp,.docx,.xlsx';
const KINDS = /\.(pdf|jpe?g|png|heic|heif|tiff?|webp|docx|xlsx)$/i;
export function takenKind(file: { name: string; type: string }): boolean {
  if (KINDS.test(file.name)) return true;
  return /^(application\/pdf|image\/(jpeg|png|heic|heif|tiff|webp))$/.test(file.type);
}

/** A file's bytes: as the browser gives them, or by a FileReader where it has no `arrayBuffer`. */
function bytesOf(file: Blob): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('could not read the file'));
    reader.readAsArrayBuffer(file);
  });
}
