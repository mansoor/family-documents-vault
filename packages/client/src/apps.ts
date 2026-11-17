import {
  APP_CONNECTION_PREFIX,
  APP_SIGNATURE_LABEL,
  APP_SIGNATURE_TAG,
  APP_SIGNED_COMPONENTS,
  EXTERNAL_ID_PATTERN,
  type AppChanges,
  type AppConnection,
  type AppDeleted,
  type AppDocument,
  type AppDocumentList,
  type AppHints,
  type AppIntakeState,
  type AppIntakeStates,
  type AppKeyAdded,
  type AppLinkMinted,
  type AppLinkMode,
  type AppMe,
} from '@fdv/shared';
import { createHttp, toError, type FetchLike, type Http } from './http.js';
import { multipartBody } from './multipart.js';

/**
 * A connected app's side of the vault (0.9.0, APP1): the signer and a
 * client for `/api/v1/apps/*`.
 *
 * Every request is signed as the vault's contract says (RFC 9421, the
 * `fdv` profile): `("@method" "@path" "@query" "content-digest")`, with
 * `created`, `keyid`, a fresh `nonce`, `alg="ed25519"` and `tag="fdv-app"`,
 * and a `Content-Digest` (sha-256) of the exact body bytes — of zero bytes
 * for a GET or a DELETE. Every retry is signed again.
 *
 * With Web Crypto's Ed25519 (Node 22, and the browsers that have it): no
 * Node module, so the package stays as platform-neutral as the rest. Its
 * own entry (`@fdv/client/apps`), so an app that never signs never loads
 * it. Optional: the contract alone is enough to write a signer.
 */

/** The three headers a signed request carries. */
export type SignedHeaders = {
  'content-digest': string;
  'signature-input': string;
  signature: string;
};

export interface SignInput {
  method: string;
  /** The path and query exactly as they are sent on the request line: `/api/v1/apps/intake?x=1`. */
  target: string;
  /** The exact body bytes; none for a GET or a DELETE. */
  body?: Uint8Array | string;
  /** `<app_id>.<key_id>`. */
  keyid: string;
  /** The private key: a PEM `PRIVATE KEY` (PKCS#8) block, or its DER bytes. */
  privateKey: string | Uint8Array;
  /** Unix seconds; now unless a test says. */
  created?: number;
  /** 16 to 48 random bytes, base64url; fresh unless a test says. */
  nonce?: string;
}

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

/** A copy on a buffer of its own: what Web Crypto takes on every platform. */
function own(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}

// ------------------------------------------------------------- signing

/** A body's `Content-Digest` (RFC 9530, sha-256). */
export async function contentDigestOf(body: Uint8Array | string = ''): Promise<string> {
  const bytes = typeof body === 'string' ? utf8(body) : own(body);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `sha-256=:${toBase64(hash)}:`;
}

/** A fresh nonce: 24 random bytes, base64url. */
export function newNonce(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(24)), true);
}

/** The `Signature-Input` member's value after `fdv=`: the base's last line. */
export function signatureParams(p: { created: number; keyid: string; nonce: string }): string {
  return `(${APP_SIGNED_COMPONENTS.map((c) => `"${c}"`).join(' ')});created=${p.created};keyid="${p.keyid}";nonce="${p.nonce}";alg="ed25519";tag="${APP_SIGNATURE_TAG}"`;
}

/** The signature base (RFC 9421 §2.5): five lines joined by LF, no newline at the end. */
export function signatureBaseOf(p: {
  method: string;
  target: string;
  contentDigest: string;
  params: string;
}): string {
  const q = p.target.indexOf('?');
  const path = q === -1 ? p.target : p.target.slice(0, q);
  const query = q === -1 ? '?' : p.target.slice(q);
  return [
    `"@method": ${p.method.toUpperCase()}`,
    `"@path": ${path}`,
    `"@query": ${query}`,
    `"content-digest": ${p.contentDigest}`,
    `"@signature-params": ${p.params}`,
  ].join('\n');
}

/** A private key's PKCS#8 bytes, from PEM or as given. */
function pkcs8(key: string | Uint8Array): Uint8Array {
  if (typeof key !== 'string') return own(key);
  const m = /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/.exec(key);
  if (!m) throw new Error('privateKey is a PEM PRIVATE KEY (PKCS#8) block, or its DER bytes');
  return fromBase64(m[1] as string);
}

/**
 * A request signed: the three headers to send with it. Ed25519 is
 * deterministic, so the same base and key give the same signature — the
 * contract's worked examples are this function's test vectors.
 */
export async function signRequest(input: SignInput): Promise<SignedHeaders> {
  const contentDigest = await contentDigestOf(input.body ?? '');
  const params = signatureParams({
    created: input.created ?? Math.floor(Date.now() / 1000),
    keyid: input.keyid,
    nonce: input.nonce ?? newNonce(),
  });
  const base = signatureBaseOf({
    method: input.method,
    target: input.target,
    contentDigest,
    params,
  });
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8(input.privateKey),
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, utf8(base)));
  return {
    'content-digest': contentDigest,
    'signature-input': `${APP_SIGNATURE_LABEL}=${params}`,
    signature: `${APP_SIGNATURE_LABEL}=:${toBase64(sig)}:`,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FINGERPRINT = /^[0-9a-f]{4}( [0-9a-f]{4}){7}$/;
/** An origin alone: a scheme, a host and perhaps a port — no user, path, query or fragment. */
const ORIGIN = /^(https?):\/\/([a-z0-9.-]+|\[[0-9a-f:]+\])(?::(\d{1,5}))?$/;
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Whether a vault's address is one to sign requests to: https, or plain
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
 * A connection string, read: `fdvapp1.` and base64url of its JSON, strictly
 * — base64url alone, exactly its five fields, ids as the vault writes them,
 * and an address to sign requests to. Anything else is refused, so nothing
 * in a pasted string can reach a header.
 */
export function parseConnectionString(text: string): AppConnection {
  const bad = (why: string) => new Error(`not a connection string: ${why}`);
  const t = text.trim();
  if (!t.startsWith(APP_CONNECTION_PREFIX)) throw bad('it starts with fdvapp1.');
  const body = t.slice(APP_CONNECTION_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(body) || body.length % 4 === 1) throw bad('base64url');
  let c: Record<string, unknown>;
  try {
    c = JSON.parse(new TextDecoder().decode(fromBase64(body))) as Record<string, unknown>;
  } catch {
    throw bad('JSON');
  }
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw bad('JSON');
  const fields = ['url', 'app_id', 'key_id', 'instance_id', 'fingerprint'];
  const unknown = Object.keys(c).find((k) => !fields.includes(k));
  if (unknown !== undefined) throw bad(`unknown field ${unknown}`);
  if (typeof c.url !== 'string') throw bad('url');
  const problem = vaultOriginProblem(c.url);
  if (problem) throw bad(problem);
  if (typeof c.app_id !== 'string' || !UUID.test(c.app_id)) throw bad('app_id');
  if (typeof c.key_id !== 'string' || !UUID.test(c.key_id)) throw bad('key_id');
  if (typeof c.fingerprint !== 'string' || !FINGERPRINT.test(c.fingerprint)) {
    throw bad('fingerprint');
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
    app_id: c.app_id,
    key_id: c.key_id,
    instance_id: typeof c.instance_id === 'string' ? c.instance_id : null,
    fingerprint: c.fingerprint,
  };
}

// --------------------------------------------------------------- client

export interface AppClientOptions {
  /** The vault's origin, from the connection string. */
  baseUrl: string;
  appId: string;
  keyId: string;
  privateKey: string | Uint8Array;
  fetch: FetchLike;
  /** Unix milliseconds, for a signature's `created`; now unless a test says. */
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
   * A link for its user's browser (APP3, `documents.links`; a download link
   * needs `documents.download` too): send the browser to `url` at once. It
   * opens once, within 2 minutes, for a session of 10 minutes there.
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
  /** A new key for rotation, signed with this one. */
  addKey(publicKey: string): Promise<AppKeyAdded>;
  retireKey(keyId: string): Promise<void>;
  /** A signed request of the app's own, for anything else. */
  signed<T>(
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
  // Ids as the vault writes them: nothing else ever reaches `keyid="…"`.
  if (!UUID.test(opts.appId) || !UUID.test(opts.keyId)) {
    throw new Error('appId and keyId are the lower-case UUIDs the connection string gives');
  }
  /** An external id, as the contract allows it: safe in a path as it is. */
  const pathId = (id: string) => {
    if (!EXTERNAL_ID_PATTERN.test(id)) throw new Error('not an external_id');
    return id;
  };
  const http: Http = createHttp({ baseUrl: opts.baseUrl, fetch: opts.fetch });
  const keyid = `${opts.appId}.${opts.keyId}`;
  const created = () => Math.floor((opts.now?.() ?? Date.now()) / 1000);

  const request = async (
    method: 'GET' | 'POST' | 'DELETE',
    target: string,
    body?: { bytes: Uint8Array; contentType: string },
  ) => {
    const headers = await signRequest({
      method,
      target,
      ...(body ? { body: body.bytes } : {}),
      keyid,
      privateKey: opts.privateKey,
      created: created(),
    });
    return http.raw(target, {
      method,
      headers: { ...headers },
      ...(body ? { upload: { kind: 'bytes' as const, ...body } } : {}),
    });
  };
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
    async download(id, o = {}) {
      const target = `/api/v1/apps/documents/${docId(id)}/content`;
      const headers: Record<string, string> = {
        ...(await signRequest({
          method: 'GET',
          target,
          keyid,
          privateKey: opts.privateKey,
          created: created(),
        })),
        accept: '*/*',
      };
      if (o.range) headers.range = `bytes=${o.range.start}-${o.range.end ?? ''}`;
      if (o.ifNoneMatch) headers['if-none-match'] = o.ifNoneMatch;
      const res = await opts.fetch(`${opts.baseUrl.replace(/\/+$/, '')}${target}`, {
        method: 'GET',
        headers,
      });
      if (res.status !== 304 && !res.ok) throw await toError(res, opts.now?.() ?? Date.now());
      return {
        status: res.status as 200 | 206 | 304,
        etag: res.headers.get('etag'),
        bytes: res.status === 304 ? new Uint8Array() : new Uint8Array(await res.arrayBuffer()),
        contentType: res.headers.get('content-type'),
        contentDisposition: res.headers.get('content-disposition'),
        contentRange: res.headers.get('content-range'),
      };
    },
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
    addKey: (publicKey) =>
      json<AppKeyAdded>('POST', '/api/v1/apps/keys', {
        bytes: utf8(JSON.stringify({ public_key: publicKey })),
        contentType: 'application/json',
      }),
    async retireKey(id) {
      await request('DELETE', `/api/v1/apps/keys/${encodeURIComponent(id)}`);
    },
    signed: json,
  };
}
