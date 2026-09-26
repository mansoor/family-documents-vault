import { ApiRequestError, NetworkError, parseRetryAfter } from './errors.js';

/**
 * The transport, with nothing platform-specific in it.
 *
 * `fetch` is injected: the browser's, React Native's, or a test's. The
 * types below are the structural minimum all three share, so the package
 * compiles without the DOM library and cannot come to depend on it.
 */

export interface AbortSignalLike {
  readonly aborted: boolean;
}

export interface HeadersLike {
  get(name: string): string | null;
}

export interface ResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: HeadersLike;
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface RequestInitLike {
  method: string;
  headers: Record<string, string>;
  body?: unknown;
  signal?: AbortSignalLike;
  /** Honoured by browsers; the `cache-control` request header covers the rest. */
  cache?: 'no-store';
}

export type FetchLike = (url: string, init: RequestInitLike) => Promise<ResponseLike>;

/** What a platform's own FormData looks like, as far as this package cares. */
export interface FormDataLike {
  append(name: string, value: unknown, filename?: string): void;
}

/**
 * An upload body. A browser hands over its own FormData; React Native can
 * too (its parts are `{ uri, name, type }`); anything else — tests, a
 * queue that already holds the bytes — sends `multipartBody()`'s output.
 */
export type UploadBody =
  { kind: 'form'; form: FormDataLike } | { kind: 'bytes'; bytes: Uint8Array; contentType: string };

export interface HttpOptions {
  /** '' for the same origin (the web app), or the vault's origin. */
  baseUrl: string;
  fetch: FetchLike;
  /** Sent with every request: the phone's installation id, for one. */
  headers?: () => Record<string, string>;
  /**
   * This installation of an app: a UUID it made once and keeps (0.4.11).
   * Sent as X-FDV-Installation, so the vault can tell one phone from
   * another — for its new-device alerts, and for the one replay of a
   * refresh whose answer was lost. A browser has none to send.
   */
  installationId?: string;
  /** Give up waiting after this long. Unset: wait as long as fetch does. */
  timeoutMs?: number;
  now?: () => number;
}

export type Method = 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT';

export interface RequestOptions {
  method?: Method;
  /** Sent as JSON. */
  body?: unknown;
  upload?: UploadBody;
  token?: string | null;
  headers?: Record<string, string>;
}

export interface Http {
  readonly baseUrl: string;
  /** The absolute address of an API path. */
  url(path: string): string;
  request<T>(path: string, opts?: RequestOptions): Promise<T>;
  /** The response itself, for downloads; still throws on an error answer. */
  raw(path: string, opts?: RequestOptions): Promise<ResponseLike>;
}

export function createHttp(options: HttpOptions): Http {
  const base = options.baseUrl.replace(/\/+$/, '');
  const now = options.now ?? (() => Date.now());

  const url = (path: string) => `${base}${path}`;

  const send = async (path: string, opts: RequestOptions): Promise<ResponseLike> => {
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(options.installationId ? { 'x-fdv-installation': options.installationId } : {}),
      ...options.headers?.(),
      ...opts.headers,
    };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const init: RequestInitLike = { method: opts.method ?? 'GET', headers };
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    } else if (opts.upload?.kind === 'form') {
      // The platform sets the multipart boundary itself.
      init.body = opts.upload.form;
    } else if (opts.upload?.kind === 'bytes') {
      headers['content-type'] = opts.upload.contentType;
      init.body = opts.upload.bytes;
    }
    // Nothing the vault says is kept or reused by the platform's HTTP cache.
    // `cache` is for browsers; the header is for fetches that ignore it — a
    // phone's (expo/fetch on OkHttp) keeps a disk cache that obeys headers
    // only, so a capability document kept from before an upgrade said the
    // old version, and could vouch for a vault that was no longer there.
    headers['cache-control'] = 'no-cache, no-store';
    init.cache = 'no-store';

    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    if (options.timeoutMs) {
      controller = new AbortController();
      init.signal = controller.signal;
      timer = setTimeout(() => controller?.abort(), options.timeoutMs);
    }
    let res: ResponseLike;
    try {
      res = await options.fetch(url(path), init);
    } catch {
      throw new NetworkError(controller?.signal.aborted ? 'timeout' : 'offline');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (!res.ok) throw await toError(res, now());
    return res;
  };

  return {
    baseUrl: base,
    url,
    async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
      const res = await send(path, opts);
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    },
    raw(path: string, opts: RequestOptions = {}) {
      return send(path, { ...opts, headers: { ...opts.headers, accept: '*/*' } });
    },
  };
}

async function toError(res: ResponseLike, now: number): Promise<ApiRequestError> {
  let code = 'http_error';
  let message = `The server answered ${res.status}.`;
  let body: {
    error?: {
      code?: string;
      message?: string;
      action?: string;
      reason?: string;
      retriable?: boolean;
      request_id?: string;
      detail?: string;
    };
  } = {};
  try {
    body = (await res.json()) as typeof body;
    code = body.error?.code ?? code;
    message = body.error?.message ?? message;
  } catch {
    // not JSON; keep the generic message
  }
  const e = body.error ?? {};
  const retryAfter = parseRetryAfter(res.headers.get('retry-after'), now);
  return new ApiRequestError(res.status, code, message, e.action, {
    ...(e.reason !== undefined ? { reason: e.reason } : {}),
    // A 429 or a 5xx is worth retrying whatever the envelope says: the
    // rate limiter's own answer said "bad_request, not retriable" (0.4.2).
    ...(e.retriable === true ? { retriable: true } : {}),
    ...(e.request_id !== undefined ? { requestId: e.request_id } : {}),
    ...(e.detail !== undefined ? { detail: e.detail } : {}),
    ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
  });
}
