import type {
  Capabilities,
  DateValue,
  DocumentTypeView,
  DocumentView,
  VersionView,
  Visibility,
} from '@fdv/shared';

/**
 * A thin client for the parts of the API the web app uses. Every function
 * maps to one documented endpoint in docs/api-changelog.md.
 */

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export interface Tokens {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  refresh_expires_in: number;
  household_id: string;
  member_id: string;
  role: 'owner' | 'adult' | 'teen' | 'viewer';
  scopes_unlocked: string[];
}

export interface Me {
  account_id: string;
  household_id: string;
  member_id: string;
  role: Tokens['role'];
  totp_enabled: boolean;
  totp_required: boolean;
}

export interface ExportRow {
  id: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  document_count: number | null;
  byte_size: number | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  expires_at: string | null;
}

export interface SessionRow {
  id: string;
  current: boolean;
  user_agent: string | null;
  ip: string | null;
  created_at: string;
  last_used_at: string;
}

export interface VaultRow {
  id: string;
  kind: 'local' | 's3';
  provider: string | null;
  label: string;
  endpoint: string | null;
  bucket: string | null;
  region: string | null;
  prefix: string | null;
  path_style: boolean;
  role: string;
  status: 'untested' | 'ok' | 'failed';
  active: boolean;
  last_verified_at: string | null;
  last_error: string | null;
}

export interface Provider {
  key: string;
  name: string;
  endpoint: string | null;
  pathStyle: boolean;
  region?: string;
  hint: string;
}

export interface NewVault {
  provider: string;
  label?: string;
  endpoint?: string | null;
  region?: string | null;
  bucket: string;
  prefix?: string | null;
  path_style?: boolean;
  access_key_id: string;
  secret_access_key: string;
}

export interface TestOutcome {
  ok: boolean;
  message: string;
  code?: string;
}

export interface Member {
  id: string;
  display_name: string;
  date_of_birth: string | null;
  relationship: string | null;
  is_deceased: boolean;
  colour: number;
  has_account: boolean;
  role: string | null;
  is_me: boolean;
  document_count: number;
}

export interface Profile {
  household_name: string;
  owns_home: boolean | null;
  rents_home: boolean | null;
  vehicle_count: number | null;
  has_pets: boolean | null;
  has_business: boolean | null;
  country: string | null;
  answered_at: string | null;
}

export interface DocumentInput {
  type_key?: string | null;
  title?: string | null;
  owner_member_id?: string | null;
  category?: string | null;
  visibility?: Visibility;
  issued?: DateValue | null;
  expires?: DateValue | null;
  identifier?: string | null;
  physical_location?: string | null;
  is_essential?: boolean;
  tags?: string[];
  notes?: string | null;
}

export interface Counts {
  by_member: Array<{ member_id: string | null; count: number }>;
  by_category: Array<{ category: string | null; count: number }>;
}

export interface SearchHit {
  document_id: string;
  title: string | null;
  type_key: string | null;
  category: string | null;
  owner_member_id: string | null;
  status: DocumentView['status'];
  snippet: string;
  matched_in: 'title' | 'content';
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
  has_more: boolean;
}

type Method = 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT';
type Params = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
  method?: Method;
  body?: unknown;
  form?: FormData;
  token?: string | null;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  /** Bypass the HTTP cache; used where a stale answer would mislead. */
  fresh?: boolean;
}

async function toError(res: Response): Promise<ApiRequestError> {
  let code = 'http_error';
  let message = `The server answered ${res.status}.`;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    code = body.error?.code ?? code;
    message = body.error?.message ?? message;
  } catch {
    // not JSON; keep the generic message
  }
  return new ApiRequestError(res.status, code, message);
}

async function send(path: string, opts: RequestOptions): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const init: RequestInit = { method: opts.method ?? 'GET', headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  if (opts.form) init.body = opts.form;
  if (opts.fresh) init.cache = 'no-store';
  const res = await fetchImpl(path, init);
  if (!res.ok) throw await toError(res);
  return res;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await send(path, opts);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function requestBlob(path: string, opts: RequestOptions = {}): Promise<Blob> {
  const res = await send(path, { ...opts, headers: { ...opts.headers, accept: '*/*' } });
  return res.blob();
}

function qs(params: Params): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : '';
}

function fileForm(file: File): FormData {
  const form = new FormData();
  form.append('file', file, file.name);
  return form;
}

export const api = {
  capabilities: () => request<Capabilities>('/api/v1/capabilities', { fresh: true }),

  setup: (body: {
    household_name: string;
    display_name: string;
    email: string;
    password: string;
  }) => request<Tokens>('/api/v1/setup', { method: 'POST', body }),
  signIn: (email: string, password: string) =>
    request<Tokens | { mfa_required: true; mfa_token: string }>('/api/v1/auth/password', {
      method: 'POST',
      body: { email, password },
    }),
  signInMfa: (mfa_token: string, code: string) =>
    request<Tokens>('/api/v1/auth/mfa', { method: 'POST', body: { mfa_token, code } }),
  totpEnrol: (token: string) =>
    request<{ secret: string; otpauth_url: string }>('/api/v1/auth/totp/enrol', {
      method: 'POST',
      token,
    }),
  totpConfirm: (token: string, code: string) =>
    request<void>('/api/v1/auth/totp/confirm', { method: 'POST', body: { code }, token }),
  requestExport: (token: string) =>
    request<ExportRow>('/api/v1/exports', { method: 'POST', token }),
  exports: (token: string) => request<{ items: ExportRow[] }>('/api/v1/exports', { token }),
  exportContent: (token: string, id: string) =>
    requestBlob(`/api/v1/exports/${id}/content`, { token }),
  refresh: (refresh_token: string) =>
    request<Tokens>('/api/v1/auth/refresh', { method: 'POST', body: { refresh_token } }),
  logout: (token: string) => request<void>('/api/v1/auth/logout', { method: 'POST', token }),
  me: (token: string) => request<Me>('/api/v1/me', { token }),
  sessions: (token: string) => request<{ items: SessionRow[] }>('/api/v1/auth/sessions', { token }),
  revokeSession: (token: string, id: string) =>
    request<void>(`/api/v1/auth/sessions/${id}`, { method: 'DELETE', token }),

  vaults: (token: string) => request<{ items: VaultRow[] }>('/api/v1/vaults', { token }),
  providers: (token: string) => request<Provider[]>('/api/v1/vaults/providers', { token }),
  addVault: (token: string, body: NewVault) =>
    request<VaultRow>('/api/v1/vaults', { method: 'POST', body, token }),
  testVault: (token: string, id: string) =>
    request<TestOutcome>(`/api/v1/vaults/${id}/test`, { method: 'POST', token }),
  activateVault: (token: string, id: string) =>
    request<void>(`/api/v1/vaults/${id}/activate`, { method: 'POST', token }),
  removeVault: (token: string, id: string) =>
    request<void>(`/api/v1/vaults/${id}`, { method: 'DELETE', token }),

  profile: (token: string) => request<Profile>('/api/v1/profile', { token }),
  updateProfile: (token: string, body: Partial<Profile>) =>
    request<Profile>('/api/v1/profile', { method: 'PUT', body, token }),
  members: (token: string) => request<{ items: Member[] }>('/api/v1/members', { token }),
  addMember: (
    token: string,
    body: { display_name: string; date_of_birth?: string | null; relationship?: string | null },
  ) => request<Member>('/api/v1/members', { method: 'POST', body, token }),

  documentTypes: (token: string) =>
    request<{ items: DocumentTypeView[] }>('/api/v1/document-types', { token }),
  documents: (token: string, params: Params = {}) =>
    request<Page<DocumentView>>(`/api/v1/documents${qs(params)}`, { token }),
  counts: (token: string) => request<Counts>('/api/v1/documents/counts', { token }),
  document: (token: string, id: string) =>
    request<DocumentView>(`/api/v1/documents/${id}`, { token }),
  createDocument: (token: string, body: DocumentInput) =>
    request<DocumentView>('/api/v1/documents', { method: 'POST', body, token }),
  updateDocument: (token: string, id: string, body: DocumentInput, etag?: string) =>
    request<DocumentView>(`/api/v1/documents/${id}`, {
      method: 'PATCH',
      body,
      token,
      ...(etag ? { headers: { 'if-match': etag } } : {}),
    }),
  deleteDocument: (token: string, id: string) =>
    request<void>(`/api/v1/documents/${id}`, { method: 'DELETE', token }),
  versions: (token: string, id: string) =>
    request<{ items: VersionView[] }>(`/api/v1/documents/${id}/versions`, { token }),
  upload: (token: string, documentId: string, file: File, idempotencyKey: string) =>
    request<VersionView>(`/api/v1/documents/${documentId}/versions`, {
      method: 'POST',
      form: fileForm(file),
      token,
      headers: { 'idempotency-key': idempotencyKey },
    }),
  capture: (token: string, file: File, idempotencyKey: string) =>
    request<{ document_id: string; version_id: string }>('/api/v1/capture', {
      method: 'POST',
      form: fileForm(file),
      token,
      headers: { 'idempotency-key': idempotencyKey },
    }),
  content: (token: string, versionId: string) =>
    requestBlob(`/api/v1/versions/${versionId}/content`, { token }),
  thumbnail: (token: string, versionId: string) =>
    requestBlob(`/api/v1/versions/${versionId}/thumbnail`, { token }),
  search: (token: string, q: string, params: Params = {}) =>
    request<{ items: SearchHit[] }>(`/api/v1/search${qs({ q, ...params })}`, { token }),
};
