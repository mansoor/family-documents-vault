import {
  APP_CLIENT_ID_PATTERN,
  APP_CONNECTION_PREFIX,
  APP_CONNECTION_PREFIX_SIGNED,
  APP_SECRET_PATTERN,
  EXTERNAL_ID_PATTERN,
  type AppChanges,
  type AppConnection,
  type AppDeleted,
  type AppDocument,
  type AppDocumentList,
  type AppHints,
  type AppIntakeState,
  type AppIntakeStates,
  type AppLinkMinted,
  type AppLinkMode,
  type AppMe,
} from '@fdv/shared';
import { NetworkError } from './errors.js';
import { createHttp, toError, type FetchLike, type Http } from './http.js';
import { multipartBody } from './multipart.js';

/**
 * A connected app's side of the vault (0.9.0): a client for
 * `/api/v1/apps/*`.
 *
 * Since 0.9.0-dev.63 (APP6) an app proves who it is with an API key an
 * owner generated for it in Settings → Connected apps: a client ID and a
 * secret, sent on every request as `Authorization: Basic
 * base64(client_id:secret)`. The vault shows the secret once and keeps only
 * a hash of it; an app never makes, renews or retires its own keys. A key
 * lasts as long as the owner chose (or never expires): `me().key.expires_at`
 * says when, so an app can warn its own users in time.
 *
 * Its own entry (`@fdv/client/apps`), platform-neutral as the rest.
 */

// ------------------------------------------------------------- base64

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Bytes as base64, padded; `url` for base64url without padding. */
export function toBase64(bytes: Uint8Array, url = false): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64[(n >> 18) & 63];
    out += B64[(n >> 12) & 63];
    out += b === undefined ? '=' : B64[(n >> 6) & 63];
    out += c === undefined ? '=' : B64[n & 63];
  }
  return url ? out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : out;
}

/** base64 or base64url, padded or not, as bytes. */
export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[\s=]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let at = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const v = [0, 1, 2, 3].map((k) => {
      const ch = clean[i + k];
      return ch === undefined ? -1 : B64.indexOf(ch);
    });
    if (v.some((x, k) => x < 0 && k < 2)) throw new Error('not base64');
    const n =
      ((v[0] as number) << 18) |
      ((v[1] as number) << 12) |
      (Math.max(0, v[2] as number) << 6) |
      Math.max(0, v[3] as number);
    out[at++] = (n >> 16) & 255;
    if ((v[2] as number) >= 0) out[at++] = (n >> 8) & 255;
    if ((v[3] as number) >= 0) out[at++] = n & 255;
  }
  return out.slice(0, at);
}

const utf8 = (s: string) => new TextEncoder().encode(s);

// ------------------------------------------------------------- the key

/**
 * The `Authorization` header an API key is sent as: `Basic` and
 * base64(`client_id:secret`). Both are checked first, so nothing but a
 * client ID and a secret as the vault writes them reaches a header.
 */
export function basicAuthorization(clientId: string, secret: string): string {
  if (!APP_CLIENT_ID_PATTERN.test(clientId)) {
    throw new Error('clientId is the fdvc_… client ID the vault showed with the key');
  }
  if (!APP_SECRET_PATTERN.test(secret)) {
    throw new Error('secret is the fdvs_… secret the vault showed once with the key');
  }
  return `Basic ${toBase64(utf8(`${clientId}:${secret}`))}`;
}

/** An origin alone: a scheme, a host and perhaps a port — no user, path, query or fragment. */
const ORIGIN = /^(https?):\/\/([a-z0-9.-]+|\[[0-9a-f:]+\])(?::(\d{1,5}))?$/;
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Whether a vault's address is one to send an API key to: https, or plain
 * http to this machine alone; an origin and nothing more.
 */
export function vaultOriginProblem(url: string): string | null {
  const m = ORIGIN.exec(url);
  if (!m) return 'the address is an origin alone: https://vault.example.com';
  if (m[3] !== undefined && (Number(m[3]) < 1 || Number(m[3]) > 65535)) return 'not a port';
  if (m[1] === 'http' && !LOOPBACK.includes(m[2] as string)) {
    return 'the address is https, or http to this machine alone';
  }
  return null;
}

/**
 * A connection string, read: `fdvapp2.` and base64url of its JSON,
 * strictly — base64url alone; `url`, `client_id` and `instance_id`, and
 * `secret` only when the owner chose to include it; the client ID and
 * secret as the vault writes them, and an address to send them to.
 * Anything else is refused, so nothing in a pasted string can reach a
 * header or another host. One made before API keys (`fdvapp1.`) is refused
 * with what to do instead.
 */
export function parseConnectionString(text: string): AppConnection {
  const bad = (why: string) => new Error(`not a connection string: ${why}`);
  const t = text.trim();
  if (t.startsWith(APP_CONNECTION_PREFIX_SIGNED)) {
    throw new Error(
      'this connection string was made before API keys: an owner generates an API key in Settings → Connected apps, and you paste its new connection string',
    );
  }
  if (!t.startsWith(APP_CONNECTION_PREFIX)) throw bad(`it starts with ${APP_CONNECTION_PREFIX}`);
  const body = t.slice(APP_CONNECTION_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(body) || body.length % 4 === 1) throw bad('base64url');
  let c: Record<string, unknown>;
  try {
    c = JSON.parse(new TextDecoder().decode(fromBase64(body))) as Record<string, unknown>;
  } catch {
    throw bad('JSON');
  }
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw bad('JSON');
  const fields = ['url', 'client_id', 'instance_id', 'secret'];
  const unknown = Object.keys(c).find((k) => !fields.includes(k));
  if (unknown !== undefined) throw bad(`unknown field ${unknown}`);
  if (typeof c.url !== 'string') throw bad('url');
  const problem = vaultOriginProblem(c.url);
  if (problem) throw bad(problem);
  if (typeof c.client_id !== 'string' || !APP_CLIENT_ID_PATTERN.test(c.client_id)) {
    throw bad('client_id');
  }
  if (
    c.secret !== undefined &&
    (typeof c.secret !== 'string' || !APP_SECRET_PATTERN.test(c.secret))
  ) {
    throw bad('secret');
  }
  if (
    c.instance_id !== undefined &&
    c.instance_id !== null &&
    (typeof c.instance_id !== 'string' || !/^[0-9A-Za-z-]{1,64}$/.test(c.instance_id))
  ) {
    throw bad('instance_id');
  }
  return {
    url: c.url,
    client_id: c.client_id,
    instance_id: typeof c.instance_id === 'string' ? c.instance_id : null,
    ...(typeof c.secret === 'string' ? { secret: c.secret } : {}),
  };
}

// --------------------------------------------------------------- client

export interface AppClientOptions {
  /** The vault's origin, from the connection string. */
  url: string;
  /** The key's client ID (`fdvc_…`). */
  clientId: string;
  /** The key's secret (`fdvs_…`), shown once when an owner generated it. */
  secret: string;
  /** The platform's fetch; `globalThis.fetch` when left out. */
  fetch?: FetchLike;
  /** Unix milliseconds, for an error's Retry-After; now unless a test says. */
  now?: () => number;
}

/** A file to send, and what the app says of it. */
export interface AppSend {
  externalId: string;
  hints?: AppHints | Record<string, unknown>;
  file: { bytes: Uint8Array; filename: string; contentType: string };
}

/** What `list` may narrow to (APP2): each as `GET /apps/documents` takes it. */
export interface AppListQuery {
  kind?: string[];
  category?: string;
  /** YYYY-MM-DD, compared with `paper_date`. */
  from?: string;
  to?: string;
  own?: boolean;
  limit?: number;
  cursor?: string;
}

/** A download (APP2): its bytes, or 304 when `ifNoneMatch` is still its version. */
export interface AppDownload {
  status: 200 | 206 | 304;
  /** The version's id, quoted: `"<version_id>"`. */
  etag: string | null;
  bytes: Uint8Array;
  contentType: string | null;
  contentDisposition: string | null;
  contentRange: string | null;
}

export interface AppClient {
  /** The connection test, and what this app may do. */
  me(): Promise<AppMe>;
  /** Its own and what its grants cover, newest paper first (APP2). */
  list(q?: AppListQuery): Promise<AppDocumentList>;
  /** One document (APP2): 404 for one it may not read, as for one that is not there. */
  document(id: string): Promise<AppDocument>;
  /** What changed since `cursor` (APP2); without one, everything it may read now. */
  changes(q?: { cursor?: string; limit?: number }): Promise<AppChanges>;
  /** The current file's bytes (APP2, `documents.download`): a range, or 304 for a version it has. */
  download(
    id: string,
    o?: { range?: { start: number; end?: number }; ifNoneMatch?: string },
  ): Promise<AppDownload>;
  /**
   * The exact file a send of its became, by its own external id (APP5,
   * `documents.download`): while it is still the vault's, its document out
   * of the Trash and not Only me — whether or not it may read the document
   * now. Its status says whether (`content_available`); 404 otherwise.
   */
  sentFile(
    externalId: string,
    o?: { range?: { start: number; end?: number }; ifNoneMatch?: string },
  ): Promise<AppDownload>;
  /**
   * A link for its user's browser (APP3, `documents.links`; a download link
   * needs `documents.download` too): send the browser to `url` at once. It
   * opens once, within 2 minutes, for a session of 10 minutes there. It
   * ends when the key that made it is revoked or expires.
   */
  link(id: string, mode: AppLinkMode): Promise<AppLinkMinted>;
  /**
   * A document it sent, deleted as the owner chose (APP3, `documents.delete`):
   * `unlinked` (it stays in the vault) or `trashed`. Its own alone: 404 otherwise.
   */
  delete(id: string): Promise<AppDeleted>;
  /** One document into its person's Inbox; 200 for an external id sent before. */
  send(s: AppSend): Promise<{ status: number; replayed: boolean; state: AppIntakeState }>;
  status(externalId: string): Promise<AppIntakeState>;
  statuses(externalIds: string[]): Promise<AppIntakeStates>;
  withdraw(externalId: string): Promise<AppIntakeState>;
  /** A request of the app's own, with its key, for anything else. */
  request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    target: string,
    body?: { bytes: Uint8Array; contentType: string },
  ): Promise<T>;
}

/** Hints as the contract writes them: the dates as they were given. */
function wireHints(h: AppSend['hints']): Record<string, unknown> | undefined {
  return h as Record<string, unknown> | undefined;
}

export function createAppClient(opts: AppClientOptions): AppClient {
  // The vault's address, an origin over https (plain http only to this
  // machine): the secret is never sent anywhere else.
  const baseUrl = opts.url.replace(/\/+$/, '');
  const problem = vaultOriginProblem(baseUrl);
  if (problem) throw new Error(`not a vault's address: ${problem}`);
  // The key as the vault writes it: nothing else ever reaches the header.
  const authorization = basicAuthorization(opts.clientId, opts.secret);
  const fetch: FetchLike =
    opts.fetch ?? ((url, init) => (globalThis as unknown as { fetch: FetchLike }).fetch(url, init));
  /** An external id, as the contract allows it: safe in a path as it is. */
  const pathId = (id: string) => {
    if (!EXTERNAL_ID_PATTERN.test(id)) throw new Error('not an external_id');
    return id;
  };
  const http: Http = createHttp({ baseUrl, fetch });

  const request = async (
    method: 'GET' | 'POST' | 'DELETE',
    target: string,
    body?: { bytes: Uint8Array; contentType: string },
  ) =>
    http.raw(target, {
      method,
      headers: { authorization },
      ...(body ? { upload: { kind: 'bytes' as const, ...body } } : {}),
    });
  const json = async <T>(
    method: 'GET' | 'POST' | 'DELETE',
    target: string,
    body?: { bytes: Uint8Array; contentType: string },
  ): Promise<T> => (await (await request(method, target, body)).json()) as T;
  /** A document's id, as the vault writes them: nothing else reaches a path. */
  const docId = (id: string) => {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new Error('not a document id');
    return id;
  };
  /** A query, each value percent-encoded once, in the order given. */
  const query = (pairs: Array<[string, string | undefined]>) => {
    const kept = pairs.filter((p): p is [string, string] => p[1] !== undefined);
    return kept.length === 0
      ? ''
      : `?${kept.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
  };

  /** A file's bytes: a range, or 304 for a version it has (APP2, APP5). */
  const bytesOf = async (
    target: string,
    o: { range?: { start: number; end?: number }; ifNoneMatch?: string },
  ): Promise<AppDownload> => {
    const headers: Record<string, string> = { authorization, accept: '*/*' };
    if (o.range) headers.range = `bytes=${o.range.start}-${o.range.end ?? ''}`;
    if (o.ifNoneMatch) headers['if-none-match'] = o.ifNoneMatch;
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await fetch(`${baseUrl}${target}`, {
        method: 'GET',
        headers,
      });
    } catch (cause) {
      // No answer: offline, as every other request says it, with the cause.
      throw new NetworkError('offline', undefined, { cause });
    }
    if (res.status !== 304 && !res.ok) throw await toError(res, opts.now?.() ?? Date.now());
    return {
      status: res.status as 200 | 206 | 304,
      etag: res.headers.get('etag'),
      bytes: res.status === 304 ? new Uint8Array() : new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get('content-type'),
      contentDisposition: res.headers.get('content-disposition'),
      contentRange: res.headers.get('content-range'),
    };
  };

  return {
    me: () => json<AppMe>('GET', '/api/v1/apps/me'),
    list: (q = {}) =>
      json<AppDocumentList>(
        'GET',
        `/api/v1/apps/documents${query([
          ['kind', q.kind?.join(',')],
          ['category', q.category],
          ['from', q.from],
          ['to', q.to],
          ['own', q.own === undefined ? undefined : String(q.own)],
          ['limit', q.limit === undefined ? undefined : String(q.limit)],
          ['cursor', q.cursor],
        ])}`,
      ),
    document: (id) => json<AppDocument>('GET', `/api/v1/apps/documents/${docId(id)}`),
    changes: (q = {}) =>
      json<AppChanges>(
        'GET',
        `/api/v1/apps/changes${query([
          ['cursor', q.cursor],
          ['limit', q.limit === undefined ? undefined : String(q.limit)],
        ])}`,
      ),
    download: (id, o = {}) => bytesOf(`/api/v1/apps/documents/${docId(id)}/content`, o),
    sentFile: (id, o = {}) => bytesOf(`/api/v1/apps/intake/${pathId(id)}/content`, o),
    link: (id, mode) =>
      json<AppLinkMinted>('POST', `/api/v1/apps/documents/${docId(id)}/links`, {
        bytes: utf8(JSON.stringify({ mode })),
        contentType: 'application/json',
      }),
    delete: (id) => json<AppDeleted>('DELETE', `/api/v1/apps/documents/${docId(id)}`),
    async send(s) {
      const body = multipartBody([
        {
          name: 'metadata',
          value: JSON.stringify({
            external_id: s.externalId,
            ...(s.hints ? { hints: wireHints(s.hints) } : {}),
          }),
        },
        { name: 'file', ...s.file },
      ]);
      const res = await request('POST', '/api/v1/apps/intake', {
        bytes: body.bytes,
        contentType: body.contentType,
      });
      return {
        status: res.status,
        replayed: res.headers.get('idempotent-replayed') === 'true',
        state: (await res.json()) as AppIntakeState,
      };
    },
    // An external id is safe in a path as it is : nothing to encode.
    status: (id) => json<AppIntakeState>('GET', `/api/v1/apps/intake/${pathId(id)}`),
    statuses: (ids) =>
      json<AppIntakeStates>(
        'GET',
        `/api/v1/apps/intake?external_ids=${ids.map((i) => encodeURIComponent(i)).join(',')}`,
      ),
    withdraw: (id) => json<AppIntakeState>('DELETE', `/api/v1/apps/intake/${pathId(id)}`),
    request: json,
  };
}
