import { ApiRequestError, dropHeaders, NetworkError, parseRetryAfter } from '@fdv/client';
import type { DropFile } from '@fdv/shared';
import { api } from './api.js';

/**
 * One file sent on the page a request opens (5.22): `POST /api/v1/drop/files`,
 * multipart — which of the things asked for it is, if the sender chose, then
 * the file — inside the session Open gave this browser, naming its request
 * (`X-FDV-Drop-Request`, 5.21). Sent with XMLHttpRequest, not fetch: only it
 * says how much of a file has gone, and a file over a home connection can
 * take minutes. What the vault refuses comes back as the app's own error,
 * in the vault's words, as every other call's does.
 */
export interface DropSending {
  done: Promise<DropFile>;
  /**
   * Stops sending it: `done` then rejects with an AbortError. Before every
   * byte has gone the vault keeps nothing of it. After (`onSent`), the vault
   * may already have it, and goes on to keep it: the page asks the session
   * what arrived (the 5.22 review).
   */
  stop: () => void;
}

export function sendDropFile(
  requestId: string,
  file: File,
  itemId: string | null,
  on: {
    progress: (sent: number, total: number) => void;
    /** Every byte has gone: the vault is checking it, and stopping it now may be too late. */
    sent?: () => void;
  },
): DropSending {
  const xhr = new XMLHttpRequest();
  const done = new Promise<DropFile>((resolve, reject) => {
    xhr.open('POST', api.dropFilesUrl());
    xhr.setRequestHeader('accept', 'application/json');
    for (const [name, value] of Object.entries(dropHeaders(requestId))) {
      xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) on.progress(e.loaded, e.total);
    };
    xhr.upload.onload = () => on.sent?.();
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as DropFile);
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
    if (itemId) form.append('item_id', itemId);
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
