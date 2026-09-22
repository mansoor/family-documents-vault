import type { Capabilities } from '@fdv/shared';

/**
 * A thin client for the parts of the API the web app uses. Grows with each
 * iteration; every function here maps to one documented endpoint.
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

type Method = 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT';

export interface RequestOptions {
  method?: Method;
  body?: unknown;
  token?: string | null;
  fetchImpl?: typeof fetch;
  /** Bypass the HTTP cache; used where a stale answer would mislead. */
  fresh?: boolean;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const init: RequestInit = { method: opts.method ?? 'GET', headers };
  if (opts.fresh) init.cache = 'no-store';
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const res = await fetchImpl(path, init);
  if (!res.ok) {
    let code = 'http_error';
    let message = `The server answered ${res.status}.`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      // not JSON; keep the generic message
    }
    throw new ApiRequestError(res.status, code, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
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
    request<Tokens>('/api/v1/auth/password', { method: 'POST', body: { email, password } }),

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
};
