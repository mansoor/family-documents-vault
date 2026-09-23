import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import type {
  ActivityLine,
  Capabilities,
  Role,
  DateValue,
  DocumentTypeView,
  DocumentView,
  ReminderView,
  SuggestionView,
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
    /** Which consequential action asked for a fresh credential (SEC-17). */
    public readonly action?: string,
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
  role: Role;
  scopes_unlocked: string[];
}

export interface Me {
  account_id: string;
  household_id: string;
  member_id: string;
  role: Role;
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

export interface PasskeyView {
  id: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  backed_up: boolean | null;
  transports: string[];
}

export interface Member {
  id: string;
  display_name: string;
  date_of_birth: string | null;
  relationship: string | null;
  is_deceased: boolean;
  colour: number;
  has_account: boolean;
  role: Role | null;
  is_me: boolean;
  document_count: number;
}

export interface Invitation {
  id: string;
  member_id: string;
  display_name: string;
  email: string;
  role: Role;
  invited_by: string | null;
  created_at: string;
  expires_at: string;
  state: 'pending' | 'accepted' | 'revoked' | 'expired' | 'locked';
  attempts_left: number;
}

/**
 * The link and the code are in this response and nowhere else — the server
 * keeps only their hashes, so this is the one moment they exist.
 */
export interface CreatedInvitation {
  invitation: Invitation;
  link_token: string;
  code: string;
}

export interface InvitationPreview {
  household_name: string;
  display_name: string;
  email: string;
  role: Role;
  role_label: string;
  invited_by: string | null;
  expires_at: string;
}

export interface ResetPreview {
  household_name: string | null;
  email: string;
  /** True when the person who runs the server made the link. */
  issued_by_operator: boolean;
  expires_at: string;
}

export interface Share {
  id: string;
  document_id: string;
  document_title: string | null;
  recipient_label: string | null;
  created_by_name: string | null;
  created_at: string;
  expires_at: string;
  has_pin: boolean;
  open_count: number;
  last_opened_at: string | null;
  state: 'active' | 'expired' | 'revoked' | 'locked';
  summary: string;
}

/** The link and the PIN exist here and nowhere else. */
export interface CreatedShare {
  share: Share;
  link_token: string;
  pin?: string;
}

export interface SharePreview {
  household_name: string;
  needs_pin: boolean;
  expires_at: string;
  document_title: string | null;
  shared_by: string | null;
}

export interface SharedDocument {
  document_title: string | null;
  document_type: string | null;
  shared_by: string | null;
  expires_at: string;
  byte_size: number;
  content_type: string;
  filename: string;
}

export interface OwnerChange {
  id: string;
  target_member_id: string;
  target_name: string;
  requested_by_name: string | null;
  action: 'promote' | 'demote';
  requested_at: string;
  opens_at: string;
  lapses_at: string;
  state: 'waiting' | 'ready' | 'refused' | 'completed' | 'lapsed';
  about_me: boolean;
  summary: string;
}

export interface RoleChangeResult {
  applied: boolean;
  role: Role;
  request?: OwnerChange;
  message: string;
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

export interface DeviceRow {
  id: string;
  endpoint: string;
  label: string | null;
  user_agent: string | null;
  created_at: string;
  last_used_at: string | null;
  working: boolean;
}

export interface Preferences {
  daily_push: boolean;
  daily_email: boolean;
  weekly_email: boolean;
}

export interface SmtpProvider {
  key: string;
  name: string;
  host: string;
  port: number;
  secure: boolean;
  hint: string;
}

export interface SmtpView {
  configured: boolean;
  provider: string | null;
  host: string | null;
  port: number | null;
  secure: boolean;
  username: string | null;
  from_name: string | null;
  from_email: string | null;
  status: string;
  last_verified_at: string | null;
  last_error: string | null;
}

export interface SmtpInput {
  provider?: string;
  host: string;
  port: number;
  secure: boolean;
  username?: string | null;
  password?: string | null;
  from_name: string;
  from_email: string;
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
  let action: string | undefined;
  try {
    const body = (await res.json()) as {
      error?: { code?: string; message?: string; action?: string };
    };
    code = body.error?.code ?? code;
    message = body.error?.message ?? message;
    action = body.error?.action;
  } catch {
    // not JSON; keep the generic message
  }
  return new ApiRequestError(res.status, code, message, action);
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

  changePassword: (token: string, body: { current_password?: string; new_password: string }) =>
    request<void>('/api/v1/auth/password/change', { method: 'POST', body, token }),
  // The three for somebody who cannot sign in at all.
  forgotPassword: (email: string) =>
    request<{ message: string }>('/api/v1/auth/password/forgot', {
      method: 'POST',
      body: { email },
    }),
  resetPreview: (linkToken: string) =>
    request<ResetPreview>(`/api/v1/password-resets/${encodeURIComponent(linkToken)}`),
  resetPassword: (linkToken: string, password: string) =>
    request<{ email: string }>(`/api/v1/password-resets/${encodeURIComponent(linkToken)}`, {
      method: 'POST',
      body: { password },
    }),

  setVisibility: (token: string, documentId: string, visibility: Visibility) =>
    request<{ notice: { title: string; body: string } | null }>(
      `/api/v1/documents/${documentId}/visibility`,
      { method: 'POST', body: { visibility }, token },
    ),
  activity: (token: string, before?: number) =>
    request<{ items: ActivityLine[]; next: number | null }>(
      `/api/v1/audit${before ? `?before=${before}` : ''}`,
      { token },
    ),

  share: (
    token: string,
    documentId: string,
    body: { expires_in_days?: number; recipient_label?: string; with_pin?: boolean },
  ) =>
    request<CreatedShare>(`/api/v1/documents/${documentId}/share`, {
      method: 'POST',
      body,
      token,
    }),
  shares: (token: string) => request<{ items: Share[] }>('/api/v1/shares', { token }),
  revokeShare: (token: string, id: string) =>
    request<void>(`/api/v1/shares/${id}`, { method: 'DELETE', token }),
  // The two the recipient calls, with no sign-in at all.
  sharePreview: (linkToken: string) =>
    request<SharePreview>(`/api/v1/shared/${encodeURIComponent(linkToken)}`),
  openShare: (linkToken: string, pin?: string) =>
    request<SharedDocument>(`/api/v1/shared/${encodeURIComponent(linkToken)}/open`, {
      method: 'POST',
      body: pin ? { pin } : {},
    }),
  sharedContentUrl: (linkToken: string, pin?: string) =>
    `/api/v1/shared/${encodeURIComponent(linkToken)}/content${pin ? `?pin=${encodeURIComponent(pin)}` : ''}`,

  setRole: (token: string, memberId: string, role: Role) =>
    request<RoleChangeResult>(`/api/v1/members/${memberId}/role`, {
      method: 'POST',
      body: { role },
      token,
    }),
  stepDown: (token: string, role: Role) =>
    request<RoleChangeResult>('/api/v1/me/step-down', { method: 'POST', body: { role }, token }),
  removeSignIn: (token: string, memberId: string) =>
    request<void>(`/api/v1/members/${memberId}/sign-in`, { method: 'DELETE', token }),
  ownerChanges: (token: string) =>
    request<{ items: OwnerChange[] }>('/api/v1/owner-changes', { token }),
  refuseOwnerChange: (token: string, id: string) =>
    request<OwnerChange>(`/api/v1/owner-changes/${id}/refuse`, { method: 'POST', token }),
  completeOwnerChange: (token: string, id: string) =>
    request<RoleChangeResult>(`/api/v1/owner-changes/${id}/complete`, { method: 'POST', token }),
  withdrawOwnerChange: (token: string, id: string) =>
    request<void>(`/api/v1/owner-changes/${id}`, { method: 'DELETE', token }),

  invitations: (token: string) =>
    request<{ items: Invitation[] }>('/api/v1/invitations', { token }),
  invite: (
    token: string,
    body: { member_id?: string; display_name?: string; email: string; role: Role },
  ) => request<CreatedInvitation>('/api/v1/invitations', { method: 'POST', body, token }),
  revokeInvitation: (token: string, id: string) =>
    request<void>(`/api/v1/invitations/${id}`, { method: 'DELETE', token }),
  // The two the invitee calls, before they have any token at all.
  invitationPreview: (linkToken: string) =>
    request<InvitationPreview>(`/api/v1/invitations/${encodeURIComponent(linkToken)}`),
  acceptInvitation: (linkToken: string, body: { code: string; password: string }) =>
    request<Tokens>(`/api/v1/invitations/${encodeURIComponent(linkToken)}/accept`, {
      method: 'POST',
      body,
    }),

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
  reminders: (token: string, state: 'due' | 'upcoming' | 'all' = 'all') =>
    request<{ items: ReminderView[] }>(`/api/v1/reminders?state=${state}`, { token }),
  snoozeReminder: (token: string, id: string, until: string) =>
    request<ReminderView>(`/api/v1/reminders/${id}/snooze`, {
      method: 'POST',
      body: { until },
      token,
    }),
  acknowledgeReminder: (token: string, id: string) =>
    request<ReminderView>(`/api/v1/reminders/${id}/acknowledge`, { method: 'POST', token }),
  pushKey: () =>
    request<{ public_key: string | null; enabled: boolean }>('/api/v1/notifications/push-key'),
  devices: (token: string) => request<{ items: DeviceRow[] }>('/api/v1/devices', { token }),
  registerDevice: (
    token: string,
    body: { endpoint: string; keys: { p256dh: string; auth: string }; label?: string },
  ) => request<{ id: string }>('/api/v1/devices', { method: 'POST', body, token }),
  removeDevice: (token: string, endpoint: string) =>
    request<void>('/api/v1/devices', { method: 'DELETE', body: { endpoint }, token }),
  preferences: (token: string) =>
    request<Preferences>('/api/v1/notifications/preferences', { token }),
  updatePreferences: (token: string, body: Partial<Preferences>) =>
    request<Preferences>('/api/v1/notifications/preferences', { method: 'PUT', body, token }),
  smtp: (token: string) => request<SmtpView>('/api/v1/notifications/smtp', { token }),
  smtpProviders: (token: string) =>
    request<SmtpProvider[]>('/api/v1/notifications/smtp/providers', { token }),
  saveSmtp: (token: string, body: SmtpInput) =>
    request<SmtpView>('/api/v1/notifications/smtp', { method: 'PUT', body, token }),
  testSmtp: (token: string) =>
    request<{ ok: boolean; message: string }>('/api/v1/notifications/smtp/test', {
      method: 'POST',
      token,
    }),
  passkeys: (token: string) =>
    request<{ items: PasskeyView[] }>('/api/v1/auth/passkeys', { token }),
  passkeyRegisterChallenge: (token: string) =>
    request<PublicKeyCredentialCreationOptionsJSON>('/api/v1/auth/passkeys/challenge', {
      method: 'POST',
      token,
    }),
  passkeyRegister: (token: string, response: unknown, label: string) =>
    request<PasskeyView>('/api/v1/auth/passkeys', {
      method: 'POST',
      body: { response, label },
      token,
    }),
  removePasskey: (token: string, id: string) =>
    request<void>(`/api/v1/auth/passkeys/${id}`, { method: 'DELETE', token }),
  passkeyChallenge: (email?: string) =>
    request<PublicKeyCredentialRequestOptionsJSON>('/api/v1/auth/passkey/challenge', {
      method: 'POST',
      body: email ? { email } : {},
    }),
  passkeyVerify: (response: unknown) =>
    request<Tokens>('/api/v1/auth/passkey/verify', { method: 'POST', body: { response } }),

  stepUpState: (token: string) =>
    request<{ verified_at: string | null; expires_in: number }>('/api/v1/auth/step-up', { token }),
  stepUp: (token: string, body: { password?: string; code?: string; passkey?: unknown }) =>
    request<{ verified_at: string; expires_in: number }>('/api/v1/auth/step-up', {
      method: 'POST',
      body,
      token,
    }),

  suggestions: (token: string, dismissed = false) =>
    request<{ items: SuggestionView[]; profile_answered: boolean; dismissed_count: number }>(
      `/api/v1/suggestions${dismissed ? '?dismissed=true' : ''}`,
      { token },
    ),
  dismissSuggestion: (token: string, key: string) =>
    request<void>(`/api/v1/suggestions/${encodeURIComponent(key)}/dismiss`, {
      method: 'POST',
      token,
    }),
  restoreSuggestion: (token: string, key: string) =>
    request<void>(`/api/v1/suggestions/${encodeURIComponent(key)}/dismiss`, {
      method: 'DELETE',
      token,
    }),
  search: (token: string, q: string, params: Params = {}) =>
    request<{ items: SearchHit[]; sealed_pending: { count: number; token?: string } }>(
      `/api/v1/search${qs({ q, ...params })}`,
      { token },
    ),
  /** The second pass: the caller's own sealed documents (FND-08). */
  searchSealed: (token: string, handle: string) =>
    request<{ items: SearchHit[]; searched: number }>(
      `/api/v1/search/sealed?token=${encodeURIComponent(handle)}`,
      { token },
    ),
};
