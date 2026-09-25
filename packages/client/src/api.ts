import type {
  ActivityLine,
  Capabilities,
  CaptureResult,
  UploadStatus,
  IssuerCount,
  IssuerSuggestions,
  Counts,
  CreatedInvitation,
  CreatedShare,
  DeviceRow,
  DocumentInput,
  DocumentTypeView,
  DocumentView,
  ExportRow,
  Invitation,
  InvitationPreview,
  Me,
  Member,
  MfaChallenge,
  NewVault,
  OwnerChange,
  Page,
  PasskeyView,
  Preferences,
  Profile,
  Provider,
  PushKey,
  ReminderView,
  ResetPreview,
  Role,
  RoleChangeResult,
  SearchHit,
  SearchResult,
  SessionRow,
  Share,
  SharedDocument,
  SharePreview,
  SmtpInput,
  SmtpProvider,
  SmtpView,
  StepUpState,
  SuggestionView,
  TestOutcome,
  Tokens,
  VaultRow,
  VersionView,
  Visibility,
} from '@fdv/shared';
import type { Http, ResponseLike, UploadBody } from './http.js';
import { captureUpload, type CaptureBody } from './multipart.js';

/**
 * Every endpoint, as one method each. Every authenticated call takes the
 * access token first, so the client holds no state of its own and composes
 * with whatever session layer a platform has.
 */

export type Params = Record<string, string | number | boolean | undefined | null>;

/** WebAuthn option JSON, passed through untouched to the platform's authenticator. */
export type PasskeyOptions = Record<string, unknown>;

export function qs(params: Params): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

const enc = encodeURIComponent;

export function createApi(http: Http) {
  const request = http.request.bind(http);
  const raw = http.raw.bind(http);

  return {
    http,

    // ------------------------------------------------------------ addresses
    /** Where a version's file is, for a platform that downloads it itself. */
    contentUrl: (versionId: string) => http.url(`/api/v1/versions/${versionId}/content`),
    thumbnailUrl: (versionId: string) => http.url(`/api/v1/versions/${versionId}/thumbnail`),
    sharedContentUrl: (linkToken: string, pin?: string) =>
      http.url(`/api/v1/shared/${enc(linkToken)}/content${pin ? `?pin=${enc(pin)}` : ''}`),
    authHeaders: (token: string) => ({ authorization: `Bearer ${token}` }),

    // ------------------------------------------------------ signing in and out
    capabilities: () => request<Capabilities>('/api/v1/capabilities', { fresh: true }),
    setup: (body: {
      household_name: string;
      display_name: string;
      email: string;
      password: string;
    }) => request<Tokens>('/api/v1/setup', { method: 'POST', body }),
    signIn: (email: string, password: string) =>
      request<Tokens | MfaChallenge>('/api/v1/auth/password', {
        method: 'POST',
        body: { email, password },
      }),
    signInMfa: (mfa_token: string, code: string) =>
      request<Tokens>('/api/v1/auth/mfa', { method: 'POST', body: { mfa_token, code } }),
    refresh: (refresh_token: string) =>
      request<Tokens>('/api/v1/auth/refresh', { method: 'POST', body: { refresh_token } }),
    logout: (token: string) => request<void>('/api/v1/auth/logout', { method: 'POST', token }),
    me: (token: string) => request<Me>('/api/v1/me', { token }),
    sessions: (token: string) =>
      request<{ items: SessionRow[] }>('/api/v1/auth/sessions', { token }),
    revokeSession: (token: string, id: string) =>
      request<void>(`/api/v1/auth/sessions/${id}`, { method: 'DELETE', token }),
    totpEnrol: (token: string) =>
      request<{ secret: string; otpauth_url: string }>('/api/v1/auth/totp/enrol', {
        method: 'POST',
        token,
      }),
    totpConfirm: (token: string, code: string) =>
      request<void>('/api/v1/auth/totp/confirm', { method: 'POST', body: { code }, token }),
    stepUpState: (token: string) => request<StepUpState>('/api/v1/auth/step-up', { token }),
    stepUp: (token: string, body: { password?: string; code?: string; passkey?: unknown }) =>
      request<{ verified_at: string; expires_in: number }>('/api/v1/auth/step-up', {
        method: 'POST',
        body,
        token,
      }),
    passkeys: (token: string) =>
      request<{ items: PasskeyView[] }>('/api/v1/auth/passkeys', { token }),
    passkeyRegisterChallenge: (token: string) =>
      request<PasskeyOptions>('/api/v1/auth/passkeys/challenge', { method: 'POST', token }),
    passkeyRegister: (token: string, response: unknown, label: string) =>
      request<PasskeyView>('/api/v1/auth/passkeys', {
        method: 'POST',
        body: { response, label },
        token,
      }),
    removePasskey: (token: string, id: string) =>
      request<void>(`/api/v1/auth/passkeys/${id}`, { method: 'DELETE', token }),
    passkeyChallenge: (email?: string) =>
      request<PasskeyOptions>('/api/v1/auth/passkey/challenge', {
        method: 'POST',
        body: email ? { email } : {},
      }),
    passkeyVerify: (response: unknown) =>
      request<Tokens>('/api/v1/auth/passkey/verify', { method: 'POST', body: { response } }),

    // ---------------------------------------------------------------- passwords
    changePassword: (token: string, body: { current_password?: string; new_password: string }) =>
      request<void>('/api/v1/auth/password/change', { method: 'POST', body, token }),
    forgotPassword: (email: string) =>
      request<{ message: string }>('/api/v1/auth/password/forgot', {
        method: 'POST',
        body: { email },
      }),
    resetPreview: (linkToken: string) =>
      request<ResetPreview>(`/api/v1/password-resets/${enc(linkToken)}`),
    resetPassword: (linkToken: string, password: string) =>
      request<{ email: string }>(`/api/v1/password-resets/${enc(linkToken)}`, {
        method: 'POST',
        body: { password },
      }),

    // -------------------------------------------------------------- storage
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

    // ------------------------------------------------------------ exports
    requestExport: (token: string) =>
      request<ExportRow>('/api/v1/exports', { method: 'POST', token }),
    exports: (token: string) => request<{ items: ExportRow[] }>('/api/v1/exports', { token }),
    exportContent: (token: string, id: string): Promise<ResponseLike> =>
      raw(`/api/v1/exports/${id}/content`, { token }),

    // ------------------------------------------------------------- household
    profile: (token: string) => request<Profile>('/api/v1/profile', { token }),
    updateProfile: (token: string, body: Partial<Profile>) =>
      request<Profile>('/api/v1/profile', { method: 'PUT', body, token }),
    members: (token: string) => request<{ items: Member[] }>('/api/v1/members', { token }),
    addMember: (
      token: string,
      body: { display_name: string; date_of_birth?: string | null; relationship?: string | null },
    ) => request<Member>('/api/v1/members', { method: 'POST', body, token }),
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
    restoreSignIn: (token: string, memberId: string, role: 'adult' | 'teen' | 'viewer') =>
      request<{ message: string }>(`/api/v1/members/${memberId}/sign-in`, {
        method: 'POST',
        token,
        body: { role },
      }),
    ownerChanges: (token: string) =>
      request<{ items: OwnerChange[] }>('/api/v1/owner-changes', { token }),
    refuseOwnerChange: (token: string, id: string) =>
      request<OwnerChange>(`/api/v1/owner-changes/${id}/refuse`, { method: 'POST', token }),
    completeOwnerChange: (token: string, id: string) =>
      request<RoleChangeResult>(`/api/v1/owner-changes/${id}/complete`, { method: 'POST', token }),
    withdrawOwnerChange: (token: string, id: string) =>
      request<void>(`/api/v1/owner-changes/${id}`, { method: 'DELETE', token }),
    activity: (token: string, before?: number) =>
      request<{ items: ActivityLine[]; next: number | null }>(
        `/api/v1/audit${before ? `?before=${before}` : ''}`,
        { token },
      ),

    // ----------------------------------------------------------- invitations
    invitations: (token: string) =>
      request<{ items: Invitation[] }>('/api/v1/invitations', { token }),
    invite: (
      token: string,
      body: { member_id?: string; display_name?: string; email: string; role: Role },
    ) => request<CreatedInvitation>('/api/v1/invitations', { method: 'POST', body, token }),
    revokeInvitation: (token: string, id: string) =>
      request<void>(`/api/v1/invitations/${id}`, { method: 'DELETE', token }),
    invitationPreview: (linkToken: string) =>
      request<InvitationPreview>(`/api/v1/invitations/${enc(linkToken)}`),
    acceptInvitation: (
      linkToken: string,
      body: { code: string; password: string; email?: string },
    ) => request<Tokens>(`/api/v1/invitations/${enc(linkToken)}/accept`, { method: 'POST', body }),

    // ------------------------------------------------------------- documents
    documentTypes: (token: string) =>
      request<{ items: DocumentTypeView[] }>('/api/v1/document-types', { token }),
    documents: (token: string, params: Params = {}) =>
      request<Page<DocumentView>>(`/api/v1/documents${qs(params)}`, { token }),
    /**
     * Who issued the household's documents, as far as this person can see
     * (0.4.10, `features.issued_by`): the filter chips, and with `type_key`
     * the card's suggestions, those used for that type first.
     */
    issuers: (token: string, params: Params = {}) =>
      request<{ items: IssuerCount[] }>(`/api/v1/issuers${qs(params)}`, { token }),
    /** Who probably issued it, from its pages: offered, never filled in (0.4.10). */
    issuerSuggestions: (token: string, documentId: string) =>
      request<IssuerSuggestions>(`/api/v1/documents/${documentId}/issuer-suggestions`, { token }),
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
    setVisibility: (token: string, documentId: string, visibility: Visibility) =>
      request<{ notice: { title: string; body: string } | null }>(
        `/api/v1/documents/${documentId}/visibility`,
        { method: 'POST', body: { visibility }, token },
      ),
    versions: (token: string, id: string) =>
      request<{ items: VersionView[] }>(`/api/v1/documents/${id}/versions`, { token }),
    /** One file, as a new version. The key is made once per file and kept for retries. */
    upload: (token: string, documentId: string, body: UploadBody, idempotencyKey: string) =>
      request<VersionView>(`/api/v1/documents/${documentId}/versions`, {
        method: 'POST',
        upload: body,
        token,
        headers: { 'idempotency-key': idempotencyKey },
      }),
    /**
     * A new document from one file (CAP-05, CAP-13): `{ file, metadata }`,
     * with the card's details sent ahead of the file (0.4.9, when the vault
     * has `features.capture_metadata`); without details it is filed as Needs
     * info. A body already built is sent as it is.
     */
    capture: (token: string, body: CaptureBody | UploadBody, idempotencyKey: string) =>
      request<CaptureResult>('/api/v1/capture', {
        method: 'POST',
        upload: 'file' in body ? captureUpload(body) : body,
        token,
        headers: { 'idempotency-key': idempotencyKey },
      }),
    /**
     * What became of one of the caller's own uploads (0.4.8, when
     * `features.idempotent_capture`): done with its ids, in progress, or a
     * 404 for a key never seen, someone else's, or a try that failed.
     */
    uploadStatus: (token: string, idempotencyKey: string) =>
      request<UploadStatus>(`/api/v1/uploads/${encodeURIComponent(idempotencyKey)}`, { token }),
    content: (token: string, versionId: string): Promise<ResponseLike> =>
      raw(`/api/v1/versions/${versionId}/content`, { token }),
    thumbnail: (token: string, versionId: string): Promise<ResponseLike> =>
      raw(`/api/v1/versions/${versionId}/thumbnail`, { token }),
    /**
     * One page of a version, as the vault drew it (0.4.12, when
     * `features.page_previews`): a JPEG, 1600 px on its long edge. While it
     * is being drawn the answer is `preview_pending` (retriable, with
     * Retry-After); a file or page the vault does not draw is `no_preview`;
     * an Essential or an "only me" document asks for a step-up first.
     */
    page: (token: string, versionId: string, n: number): Promise<ResponseLike> =>
      raw(`/api/v1/versions/${versionId}/pages/${n}`, { token }),

    // ------------------------------------------------------------ finding
    search: (token: string, q: string, params: Params = {}) =>
      request<SearchResult>(`/api/v1/search${qs({ q, ...params })}`, { token }),
    /** The second pass: the caller's own sealed documents (FND-08). */
    searchSealed: (token: string, handle: string) =>
      request<{ items: SearchHit[]; searched: number }>(
        `/api/v1/search/sealed?token=${enc(handle)}`,
        {
          token,
        },
      ),
    suggestions: (token: string, dismissed = false) =>
      request<{ items: SuggestionView[]; profile_answered: boolean; dismissed_count: number }>(
        `/api/v1/suggestions${dismissed ? '?dismissed=true' : ''}`,
        { token },
      ),
    dismissSuggestion: (token: string, key: string) =>
      request<void>(`/api/v1/suggestions/${enc(key)}/dismiss`, { method: 'POST', token }),
    restoreSuggestion: (token: string, key: string) =>
      request<void>(`/api/v1/suggestions/${enc(key)}/dismiss`, { method: 'DELETE', token }),

    // ----------------------------------------------------------- reminders
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

    // ------------------------------------------------------- notifications
    pushKey: () => request<PushKey>('/api/v1/notifications/push-key'),
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

    // ------------------------------------------------------------- sharing
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
    sharePreview: (linkToken: string) => request<SharePreview>(`/api/v1/shared/${enc(linkToken)}`),
    openShare: (linkToken: string, pin?: string) =>
      request<SharedDocument>(`/api/v1/shared/${enc(linkToken)}/open`, {
        method: 'POST',
        body: pin ? { pin } : {},
      }),
  };
}

export type Api = ReturnType<typeof createApi>;
