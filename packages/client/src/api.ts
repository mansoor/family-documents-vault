import type {
  ActivityLine,
  Capabilities,
  CaptureResult,
  UploadStatus,
  IssuerCount,
  IssuerSuggestions,
  CollectionAudience,
  CollectionDetail,
  CollectionInput,
  CollectionSharePreview,
  CollectionShareInput,
  CollectionView,
  Counts,
  CreatedInvitation,
  CreatedShare,
  CreatedUploadRequest,
  DeviceRow,
  DropCodeSent,
  DropFinished,
  DropPreview,
  DropSession,
  DocumentAttributeInput,
  DocumentAttributeView,
  DocumentInput,
  DocumentTypeImpact,
  DocumentTypeInput,
  DocumentTypeView,
  DocumentView,
  ExportRow,
  Invitation,
  InvitationPreview,
  Me,
  Member,
  MfaChallenge,
  OfflineGrant,
  OfflineOpen,
  OfflineOpensResult,
  OfflineSet,
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
  ShareCodeSent,
  SharedDocument,
  SharedSession,
  ShareInput,
  ShareLinkPreview,
  SharePreview,
  SmtpInput,
  SmtpProvider,
  SmtpView,
  StepUpState,
  SuggestionView,
  TestOutcome,
  Tokens,
  UploadRequestInput,
  UploadRequestView,
  VaultRow,
  VersionView,
  Visibility,
} from '@fdv/shared';
import type { Http, ResponseLike, UploadBody } from './http.js';
import { captureUpload, photoUpload, type CaptureBody, type PhotoBody } from './multipart.js';

/**
 * Every endpoint, as one method each. Every authenticated call takes the
 * access token first, so the client holds no state of its own and composes
 * with whatever session layer a platform has.
 */

export type Params = Record<string, string | number | boolean | undefined | null>;

/**
 * What asking to remove a document for good came to (5.24): removed, or —
 * somebody else's — asked about, with the document as it now is.
 */
export type PurgeResult = { removed: true } | { removed: false; document: DocumentView };

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
    /** Where a person's photo is (0.5.19): fetched with the token, like a thumbnail. */
    memberPhotoUrl: (memberId: string, photoId: string) =>
      http.url(`/api/v1/members/${enc(memberId)}/photo/${enc(photoId)}`),
    sharedContentUrl: (linkToken: string, pin?: string) =>
      http.url(`/api/v1/shared/${enc(linkToken)}/content${pin ? `?pin=${enc(pin)}` : ''}`),
    authHeaders: (token: string) => ({ authorization: `Bearer ${token}` }),

    // ------------------------------------------------------ signing in and out
    capabilities: () => request<Capabilities>('/api/v1/capabilities'),
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
    /**
     * The path form, deprecated since 0.5.17 (removed in 0.9.0): the token
     * in the address, where a proxy on the way sees it. Use `lookupReset`.
     */
    resetPreview: (linkToken: string) =>
      request<ResetPreview>(`/api/v1/password-resets/${enc(linkToken)}`),
    /** The path form, deprecated since 0.5.17 (removed in 0.9.0). Use `completeReset`. */
    resetPassword: (linkToken: string, password: string) =>
      request<{ email: string }>(`/api/v1/password-resets/${enc(linkToken)}`, {
        method: 'POST',
        body: { password },
      }),
    // A reset link since 0.5.17 reads /reset#<token>: the page reads the
    // token from the fragment, which no server is sent, and it goes in a
    // body, never a path. A vault older than 0.5.17 refuses these: it reads
    // "lookup" and "complete" as a path form's token, too short (422).
    /** Whose account the link is for, before a new password is typed. */
    lookupReset: (linkToken: string) =>
      request<ResetPreview>('/api/v1/password-resets/lookup', {
        method: 'POST',
        body: { token: linkToken },
      }),
    /** Spends the link: the new password is set, and nobody is signed in. */
    completeReset: (linkToken: string, password: string) =>
      request<{ email: string }>('/api/v1/password-resets/complete', {
        method: 'POST',
        body: { token: linkToken, password },
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
    /**
     * A person's photo (0.5.19, when `features.member_photos`): the picture,
     * and the part of it to show, sent crop first. `202` with the person,
     * `photo_status: 'processing'`: the vault makes the square, and GET
     * /members says `photo` once it is ready (or `photo_status: 'failed'`).
     * JPEG, PNG, WebP or HEIC, 20 MB at most (`415`, `413`); whose photo is
     * whose to change is A66 (`403`).
     */
    setMemberPhoto: (token: string, memberId: string, body: PhotoBody) =>
      request<Member>(`/api/v1/members/${enc(memberId)}/photo`, {
        method: 'PUT',
        upload: photoUpload(body),
        token,
      }),
    /** Their photo taken away, with any on its way; `204` also when there was none. */
    removeMemberPhoto: (token: string, memberId: string) =>
      request<void>(`/api/v1/members/${enc(memberId)}/photo`, { method: 'DELETE', token }),
    /** The photo itself, a 512-pixel JPEG; `404 no_photo` for anything not given. */
    memberPhoto: (token: string, memberId: string, photoId: string): Promise<ResponseLike> =>
      raw(`/api/v1/members/${enc(memberId)}/photo/${enc(photoId)}`, { token }),
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
    /**
     * The path form, deprecated since 0.5.17 (removed in 0.9.0): the token
     * in the address, where a proxy on the way sees it. Use `lookupInvitation`.
     */
    invitationPreview: (linkToken: string) =>
      request<InvitationPreview>(`/api/v1/invitations/${enc(linkToken)}`),
    /** The path form, deprecated since 0.5.17 (removed in 0.9.0). Use `acceptInvitationLink`. */
    acceptInvitation: (
      linkToken: string,
      body: { code: string; password: string; email?: string },
    ) => request<Tokens>(`/api/v1/invitations/${enc(linkToken)}/accept`, { method: 'POST', body }),
    // An invitation link since 0.5.17 reads /join#<token>: the page reads
    // the token from the fragment, which no server is sent, and it goes in
    // a body, never a path. A vault older than 0.5.17 answers these 404.
    /** Whose vault, who invited them and as what, before anything is typed. */
    lookupInvitation: (linkToken: string) =>
      request<InvitationPreview>('/api/v1/invitations/lookup', {
        method: 'POST',
        body: { token: linkToken },
      }),
    /** The code and a password of their own: a signed-in account, as a sign-in gives. */
    acceptInvitationLink: (
      linkToken: string,
      body: { code: string; password: string; email?: string },
    ) =>
      request<Tokens>('/api/v1/invitations/accept', {
        method: 'POST',
        body: { ...body, token: linkToken },
      }),

    // ------------------------------------------------------------- documents
    /**
     * The household's types. A type it has hidden or archived is listed
     * while a document it can see still uses it, marked `hidden` (0.5.6);
     * `all` lists every one.
     */
    documentTypes: (token: string, params: { all?: boolean } = {}) =>
      request<{ items: DocumentTypeView[] }>(
        `/api/v1/document-types${qs(params.all ? { all: true } : {})}`,
        { token },
      ),
    /** The fields a type can ask for, from the library (0.5.6). */
    documentAttributes: (token: string) =>
      request<{ items: DocumentAttributeView[] }>('/api/v1/document-attributes', { token }),
    // Kinds of document, managed (0.5.10; owners and adults, `types.manage`).
    /** A kind of the household's own, under an `h_` key it keeps for good. */
    createDocumentType: (token: string, body: DocumentTypeInput) =>
      request<DocumentTypeView>('/api/v1/document-types', { method: 'POST', body, token }),
    /**
     * A change to a kind, made to the one the caller saw: pass its `etag`,
     * and a newer one answers `409 conflict`. Letting more people see it by
     * default is an owner's, and asks them to confirm it is them.
     */
    updateDocumentType: (token: string, key: string, body: DocumentTypeInput, etag?: string) =>
      request<DocumentTypeView>(`/api/v1/document-types/${enc(key)}`, {
        method: 'PATCH',
        body,
        token,
        ...(etag ? { headers: { 'if-match': etag } } : {}),
      }),
    /** No longer offered: the household's own archived, a built-in hidden. Its documents keep it. */
    archiveDocumentType: (token: string, key: string) =>
      request<DocumentTypeView>(`/api/v1/document-types/${enc(key)}/archive`, {
        method: 'POST',
        token,
      }),
    restoreDocumentType: (token: string, key: string) =>
      request<DocumentTypeView>(`/api/v1/document-types/${enc(key)}/restore`, {
        method: 'POST',
        token,
      }),
    /** Only a kind of the household's own that no document uses: `409 type_in_use` otherwise. */
    deleteDocumentType: (token: string, key: string) =>
      request<void>(`/api/v1/document-types/${enc(key)}`, { method: 'DELETE', token }),
    /** What a change would touch, among the documents the caller can see. */
    documentTypeImpact: (token: string, key: string) =>
      request<DocumentTypeImpact>(`/api/v1/document-types/${enc(key)}/impact`, { token }),
    /** A field of the household's own, for the library. */
    createDocumentAttribute: (token: string, body: DocumentAttributeInput) =>
      request<DocumentAttributeView>('/api/v1/document-attributes', {
        method: 'POST',
        body,
        token,
      }),
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
    /** Out of the Trash again (5.1); an owner's request to remove it for good goes with it (5.24). */
    restoreDocument: (token: string, id: string) =>
      request<DocumentView>(`/api/v1/documents/${id}/restore`, { method: 'POST', token }),
    /**
     * Removes a document in the Trash for good (5.24, `features.remove_for_good`).
     * Owners only, and it always asks to confirm it's you first (`403
     * step_up_required`, action `remove_for_good`). One the caller filed, or
     * that is theirs, is removed at once. Anybody else's is asked about
     * instead — whoever filed it, and the other owners, are told — and the
     * document comes back with `purge_allowed_from`: a call from then
     * removes it, and one before is `409 purge_not_yet`.
     */
    purgeDocument: async (token: string, id: string): Promise<PurgeResult> => {
      const asked = await request<DocumentView | undefined>(`/api/v1/documents/${id}/purge`, {
        method: 'POST',
        token,
      });
      return asked ? { removed: false, document: asked } : { removed: true };
    },
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

    // ---------------------------------------------- collections (0.5.12)
    /**
     * Collections of documents (when `features.collections`): every collection the caller may
     * see, each with `item_count`, how many of its documents they can see.
     * A viewer is given none.
     */
    collections: (token: string) =>
      request<{ items: CollectionView[] }>('/api/v1/collections', { token }),
    /** A collection made by the caller (owners, adults and teens), for an audience they are in. */
    createCollection: (
      token: string,
      body: { name: string; audience: CollectionAudience; description?: string | null },
    ) => request<CollectionDetail>('/api/v1/collections', { method: 'POST', body, token }),
    /**
     * One collection, with a page of the documents in it the caller can see, in
     * the order they were put there: 50 unless `limit` says (200 at most),
     * from the start or after `cursor`, the last page's `next_cursor`.
     * `item_count` is all of them. A cursor whose document has since left
     * the collection, or the caller's sight, is `422`: start again.
     */
    getCollection: (
      token: string,
      id: string,
      page: { limit?: number; cursor?: string | null } = {},
    ) => request<CollectionDetail>(`/api/v1/collections/${enc(id)}${qs(page)}`, { token }),
    /**
     * Its name, words or audience, by its maker while they are in its
     * audience (`403` once they are not), made to the collection they saw: pass
     * its `etag`, and a newer one answers `409 conflict`.
     */
    updateCollection: (token: string, id: string, body: CollectionInput, etag?: string) =>
      request<CollectionDetail>(`/api/v1/collections/${enc(id)}`, {
        method: 'PATCH',
        body,
        token,
        ...(etag ? { headers: { 'if-match': etag } } : {}),
      }),
    /**
     * Gone for everybody: by its maker, whatever their role now, or by an
     * owner when nobody may change it any more — its maker is outside its
     * audience, or has no sign-in. Anybody else in its audience is `403`.
     */
    deleteCollection: (token: string, id: string) =>
      request<void>(`/api/v1/collections/${enc(id)}`, { method: 'DELETE', token }),
    /**
     * Documents put in a collection by its maker, at the end: each one the maker
     * can see, or `404` and none is put in. The answer is the collection's first
     * page.
     */
    addToCollection: (token: string, id: string, documentIds: string[]) =>
      request<CollectionDetail>(`/api/v1/collections/${enc(id)}/items`, {
        method: 'POST',
        body: { document_ids: documentIds },
        token,
      }),
    removeFromCollection: (token: string, id: string, documentId: string) =>
      request<void>(`/api/v1/collections/${enc(id)}/items/${enc(documentId)}`, {
        method: 'DELETE',
        token,
      }),
    /** The collections a document is in, of those the caller may see. */
    documentCollections: (token: string, documentId: string) =>
      request<{ items: CollectionView[] }>(`/api/v1/documents/${enc(documentId)}/collections`, {
        token,
      }),

    // ------------------------------------------------ offline (0.4.13)
    /**
     * Keeping Essentials on this phone (when `features.offline_essentials`):
     * the password again, for at most 30 days. `401 invalid_credentials`
     * for a wrong one; 403 for viewers; 422 from a session with no
     * installation id (only an app keeps documents).
     */
    offlineGrant: (token: string, password: string, includePrivate = false) =>
      request<OfflineGrant>('/api/v1/offline/grant', {
        method: 'POST',
        token,
        body: { password, include_private: includePrivate },
      }),
    endOfflineGrant: (token: string) =>
      request<void>('/api/v1/offline/grant', { method: 'DELETE', token }),
    /** Everything this phone may keep, complete: what is not here is to be removed. */
    offlineEssentials: (token: string) =>
      request<OfflineSet>('/api/v1/offline/essentials', { token }),
    /** A page for the phone's copy: 403 offline_grant_required without a grant. */
    offlinePage: (token: string, versionId: string, n: number): Promise<ResponseLike> =>
      raw(`/api/v1/offline/pages/${versionId}/${n}`, { token }),
    /** What was opened while there was no connection; each event is recorded once. */
    offlineOpens: (token: string, events: OfflineOpen[]) =>
      request<OfflineOpensResult>('/api/v1/offline/opens', {
        method: 'POST',
        token,
        body: { events },
      }),

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
      request<{
        items: SuggestionView[];
        profile_answered: boolean | null;
        dismissed_count: number;
      }>(`/api/v1/suggestions${dismissed ? '?dismissed=true' : ''}`, { token }),
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
      body: {
        endpoint: string;
        keys: { p256dh: string; auth: string };
        label?: string;
        /** 0.4.14: 'unified_push' for the phone app's distributor. */
        kind?: 'web_push' | 'unified_push';
      },
    ) => request<{ id: string }>('/api/v1/devices', { method: 'POST', body, token }),
    /** A test push to one of your own devices (0.4.14). */
    testDevice: (token: string, id: string) =>
      request<{ queued: boolean }>(`/api/v1/devices/${encodeURIComponent(id)}/test`, {
        method: 'POST',
        token,
      }),
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
    /**
     * `expires_at`, `permission`, `max_opens` and `max_downloads` only to a
     * vault with `features.share_options` (5.18); `expires_in_days` to any.
     */
    share: (token: string, documentId: string, body: ShareInput) =>
      request<CreatedShare>(`/api/v1/documents/${documentId}/share`, {
        method: 'POST',
        body,
        token,
      }),
    /**
     * What the share sheet offers for a collection (5.19, `features.collection_shares`):
     * the documents in it the caller can see, each ticked or not, with why.
     * `403` for a teen or a viewer; `422 collection_only_me` for an Only me one.
     */
    collectionSharePreview: (token: string, collectionId: string) =>
      request<CollectionSharePreview>(`/api/v1/collections/${enc(collectionId)}/share-preview`, {
        token,
      }),
    /**
     * A link to a collection (5.19): always asks to confirm it's you first
     * (`403 step_up_required`, action `share_collection`).
     */
    shareCollection: (token: string, collectionId: string, body: CollectionShareInput) =>
      request<CreatedShare>(`/api/v1/collections/${enc(collectionId)}/shares`, {
        method: 'POST',
        body,
        token,
      }),
    /** Every link the caller may know about: a document's, and since 5.19 a collection's. */
    shares: (token: string) => request<{ items: Share[] }>('/api/v1/shares', { token }),
    revokeShare: (token: string, id: string) =>
      request<void>(`/api/v1/shares/${id}`, { method: 'DELETE', token }),
    sharePreview: (linkToken: string) => request<SharePreview>(`/api/v1/shared/${enc(linkToken)}`),
    openShare: (linkToken: string, pin?: string) =>
      request<SharedDocument>(`/api/v1/shared/${enc(linkToken)}/open`, {
        method: 'POST',
        body: pin ? { pin } : {},
      }),

    // ----------------------------------- a link, opened at /s (0.5.14)
    // The token goes in a body, never a path. Open gives this browser a
    // session cookie (for /api/v1/shared alone), which the vault keeps
    // only as a hash; everything after it is asked inside that session.
    /** What the page shows before Open. Nothing is counted or written down. */
    previewLink: (linkToken: string) =>
      request<ShareLinkPreview>('/api/v1/shared/preview', {
        method: 'POST',
        body: { token: linkToken },
      }),
    /**
     * Open: counted, written down, and a session for this browser. `secret`
     * is the PIN or, since 5.20, the password; `code` the emailed code. A
     * wrong one of either is `401` (`pin_wrong` for a PIN alone, otherwise
     * `secret_wrong`), in words that never say which; another browser than
     * the one a link for this device only was opened in is `403
     * other_device`.
     */
    unlockLink: (linkToken: string, secret?: string, code?: string) =>
      request<SharedSession>('/api/v1/shared/unlock', {
        method: 'POST',
        body: {
          token: linkToken,
          ...(secret ? { secret } : {}),
          ...(code ? { code } : {}),
        },
      }),
    /**
     * An emailed code (5.20, `features.share_email_code`), to the address the
     * sharer typed — the page never says one. Only the newest code works: a
     * new one ends the one before it. `429 code_limit` past 3 in 15 minutes
     * or 10 a day; `409 no_code_needed` for a link that asks for none; `403
     * other_device` from another browser than a link for one browser was
     * opened in; `503 email_code_unavailable` when the vault has no way to
     * send one (ask the sender for a new link); `503 code_not_sent`
     * (retriable, `Retry-After`) when its email could not be queued just
     * now — nothing was sent, the code before it still works, and the try is
     * not counted against the limit.
     */
    sendLinkCode: (linkToken: string) =>
      request<ShareCodeSent>('/api/v1/shared/code', {
        method: 'POST',
        body: { token: linkToken },
      }),
    /** What is open in this browser's session; `401 share_session_ended` when nothing is. */
    linkItems: () => request<SharedSession>('/api/v1/shared/items'),
    linkItemContentUrl: (documentId: string) =>
      http.url(`/api/v1/shared/items/${enc(documentId)}/content`),
    /** A view-only link's page (5.18): a JPEG drawn with whom the link is for. */
    linkItemPageUrl: (documentId: string, n: number) =>
      http.url(`/api/v1/shared/items/${enc(documentId)}/pages/${n}`),

    // ------------------------------------------- after a restore (0.5.14)
    /**
     * What a restore paused that the caller may decide about: for an owner,
     * to turn back on or take back; for anybody else, their own links, only
     * to take back.
     */
    afterRestore: (token: string) =>
      request<{ links: Share[]; upload_requests?: UploadRequestView[] }>('/api/v1/after-restore', {
        token,
      }),
    /** Owners only (`restore.review`): anybody else is `403 forbidden`. */
    resumeShare: (token: string, id: string) =>
      request<Share>(`/api/v1/shares/${id}/resume`, { method: 'POST', token }),

    // ------------------------------- asking to be sent documents (0.5.21)
    // Owners and adults; a teen or a viewer is answered 404, as if there
    // were no such thing. The link and a made-up password are in the
    // answer to making one, and nowhere else.
    createUploadRequest: (token: string, body: UploadRequestInput) =>
      request<CreatedUploadRequest>('/api/v1/upload-requests', { method: 'POST', body, token }),
    uploadRequests: (token: string) =>
      request<{ items: UploadRequestView[]; email_code_available: boolean }>(
        '/api/v1/upload-requests',
        { token },
      ),
    revokeUploadRequest: (token: string, id: string) =>
      request<void>(`/api/v1/upload-requests/${enc(id)}`, { method: 'DELETE', token }),
    /** After a restore, owners only (`restore.review`). */
    resumeUploadRequest: (token: string, id: string) =>
      request<UploadRequestView>(`/api/v1/upload-requests/${enc(id)}/resume`, {
        method: 'POST',
        token,
      }),

    // The sender's page, /drop#<token>: the token in a body, never a path.
    // Open gives this browser a session cookie for /api/v1/drop alone.
    /** Whose vault and who asked, and what Open asks for. Nothing is counted. */
    dropPreview: (linkToken: string) =>
      request<DropPreview>('/api/v1/drop/preview', { method: 'POST', body: { token: linkToken } }),
    /** An emailed code, to the address the requester gave (operator mail only). */
    dropCode: (linkToken: string) =>
      request<DropCodeSent>('/api/v1/drop/code', { method: 'POST', body: { token: linkToken } }),
    /** Open: counted, and a session for this browser. */
    dropUnlock: (linkToken: string, secrets: { password?: string; code?: string } = {}) =>
      request<DropSession>('/api/v1/drop/unlock', {
        method: 'POST',
        body: { token: linkToken, ...secrets },
      }),
    // Inside an opened request, the page names it (its `request_id`): a
    // browser may have two open, each with its own session cookie.
    dropSession: (requestId: string) =>
      request<DropSession>('/api/v1/drop/session', { headers: dropHeaders(requestId) }),
    /**
     * Where a file is sent, multipart: an optional `item_id`, then `file`,
     * with `X-FDV-Drop-Request` (`dropHeaders`).
     */
    dropFilesUrl: () => http.url('/api/v1/drop/files'),
    dropRemoveFile: (requestId: string, id: string) =>
      request<void>(`/api/v1/drop/files/${enc(id)}`, {
        method: 'DELETE',
        headers: dropHeaders(requestId),
      }),
    dropFinish: (requestId: string, note?: string) =>
      request<DropFinished>('/api/v1/drop/finish', {
        method: 'POST',
        body: note ? { note } : {},
        headers: dropHeaders(requestId),
      }),
  };
}

/** Which request a sender's call is about (0.5.21): the `request_id` Open answered. */
export function dropHeaders(requestId: string): Record<string, string> {
  return { 'x-fdv-drop-request': requestId };
}

export type Api = ReturnType<typeof createApi>;
