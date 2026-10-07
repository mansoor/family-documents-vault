import type {
  AccessGrant,
  AccessPreview,
  ActivityLine,
  BatchAccepted,
  BatchAcceptInput,
  BatchDetail,
  BatchInput,
  BatchItemView,
  BatchView,
  Capabilities,
  CaptureResult,
  UploadStatus,
  IssuerCount,
  DetailSuggestions,
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
  DocumentListParams,
  DocumentPage,
  DocumentTypeImpact,
  DocumentTypeInput,
  DocumentTypeView,
  DocumentView,
  ExportRow,
  GuestRenewal,
  IncomingAccepted,
  IncomingAcceptInput,
  IncomingFileView,
  IdentityAudience,
  IdentityAudienceView,
  IdentityPart,
  IdentityReveal,
  IdentityView,
  IdentityWrite,
  Invitation,
  InvitationPreview,
  Me,
  Member,
  MemberAccess,
  MemberAccount,
  MemberEdit,
  MemberKind,
  MemberLock,
  MemberSuspension,
  MfaChallenge,
  OfflineGrant,
  OwnerResetInput,
  OwnerResetResult,
  OfflineOpen,
  OfflineOpensResult,
  OfflineSet,
  OnlyMeSharing,
  NewVault,
  OwnerChange,
  PausedSignIn,
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
  SignedOutEverywhere,
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
  VisibilityChange,
} from '@fdv/shared';
import type { Http, ResponseLike, UploadBody } from './http.js';
import {
  batchItemUpload,
  captureUpload,
  photoUpload,
  type CaptureBody,
  type CaptureFile,
  type PhotoBody,
} from './multipart.js';

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
    /**
     * The person has seen that an owner made a link to hand over for their
     * sign-in (5.29, `Me.reset_notice`): `204`, and it is not said again.
     * Nothing to see answers the same.
     */
    dismissResetNotice: (token: string) =>
      request<void>('/api/v1/me/reset-notice', { method: 'DELETE', token }),
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
    /** The family: a guest is never among them (5.34), but for a guest themselves. */
    members: (token: string) => request<{ items: Member[] }>('/api/v1/members', { token }),
    /**
     * The people outside the family (5.34, when `features.guests`): each
     * guest, with their limits (`restriction`) and when their sign-in ends
     * (`access_expires_at`). Owners only (`403 forbidden`).
     */
    guests: (token: string) =>
      request<{ items: Member[] }>('/api/v1/members?kind=guest', { token }),
    /**
     * A guest's sign-in renewed (5.34, A28): to end at `accessExpiresAt`, in
     * the future and within a year (`limits.guest_max_days`, else `422`).
     * Owners only (`403 forbidden`), an owner power: `403
     * totp_required_for_owner`, or `step_up_required` with `renew_guest` (a
     * passkey or a code). Nobody with a sign-in `404`; somebody of the family
     * `409 not_a_guest`.
     */
    /**
     * A guest who never signed in, removed (5.34's review): their
     * invitations and limits with them. Owners only (`403`), asked as
     * taking a sign-in away is (`change_people`). Somebody who has had a
     * sign-in `409 had_sign_in`; somebody of the family `409 not_a_guest`.
     */
    removeGuest: (token: string, memberId: string) =>
      request<void>(`/api/v1/members/${enc(memberId)}`, { method: 'DELETE', token }),
    renewGuest: (token: string, memberId: string, accessExpiresAt: string) =>
      request<GuestRenewal>(`/api/v1/members/${enc(memberId)}/renew`, {
        method: 'POST',
        body: { access_expires_at: accessExpiresAt },
        token,
      }),
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
    /**
     * Gives a sign-in back to the account that had it. A guest's (5.34) comes
     * back as a viewer's with a new end, `accessExpiresAt` — which asks, as
     * renewing does, for a passkey or a code (`renew_guest`).
     */
    restoreSignIn: (
      token: string,
      memberId: string,
      role: 'adult' | 'teen' | 'viewer',
      accessExpiresAt?: string,
    ) =>
      request<{ message: string }>(`/api/v1/members/${memberId}/sign-in`, {
        method: 'POST',
        token,
        body: { role, ...(accessExpiresAt ? { access_expires_at: accessExpiresAt } : {}) },
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
    /**
     * A person's details (5.25, when `features.member_edit`): what is sent
     * is changed. Pass the `version` the person was read with, and a change
     * made since is `409 conflict`, with the person as they are now in the
     * error's `detail`. Whose is A66 (`403`); `is_deceased` an owner's, who
     * may be asked to confirm it is them (`step_up_required`,
     * `change_people`), and not for somebody who can still sign in (`409
     * signed_in`).
     */
    updateMember: (token: string, memberId: string, body: MemberEdit, version?: number | null) =>
      request<Member>(`/api/v1/members/${enc(memberId)}`, {
        method: 'PATCH',
        body,
        token,
        ...(version !== undefined && version !== null
          ? { headers: { 'if-match': `"${version}"` } }
          : {}),
      }),
    /**
     * An owner's view of somebody's sign-in (5.25), read-only: no address and
     * no secret. Anybody else: `404`. An owner with only a password: `403
     * totp_required_for_owner`; any other is asked for a passkey or a code,
     * never the password (`step_up_required`, `manage_sign_ins`; A54).
     */
    memberAccount: (token: string, memberId: string) =>
      request<MemberAccount>(`/api/v1/members/${enc(memberId)}/account`, { token }),
    /**
     * Locks somebody's sign-in (5.28, when `features.member_admin`): their
     * sessions end (`suspended`), their links and requests pause — or with
     * `end_links` end for good — and they cannot sign in (`403
     * membership_suspended`, once their credentials are proven) until an
     * owner unlocks them or `until` comes. Owners only (anybody else `403
     * forbidden`), and an owner power (A54): `403 totp_required_for_owner`,
     * or `step_up_required` with `manage_sign_ins` (a passkey or a code).
     * Never oneself (`422`), never an owner (`409 owner_notice_required`),
     * nobody locked already (`409 already_locked`).
     */
    lockMember: (token: string, memberId: string, body: MemberLock = {}) =>
      request<{ member_id: string; suspension: MemberSuspension }>(
        `/api/v1/members/${enc(memberId)}/lock`,
        { method: 'POST', body, token },
      ),
    /**
     * Starts a password reset for somebody (5.29, D5): which way it goes is
     * the answer's `path` — `mail` to their own address by the operator's
     * mail server; `handover`, a one-time `link` shown this once, only for
     * somebody who keeps nothing private; `operator`, no owner's way, with
     * the `command` whoever runs the server types. `stop_now` stops their
     * current password and ends their sessions (A48). Owners only (`403
     * forbidden`), an owner power asked as a lock is; never oneself (`422`),
     * never an owner (`409 owner_notice_required`), nobody locked or paused
     * (`409 locked`). `MemberAccount.reset_path` says beforehand which way.
     */
    startPasswordReset: (token: string, memberId: string, body: OwnerResetInput = {}) =>
      request<OwnerResetResult>(`/api/v1/members/${enc(memberId)}/password-reset`, {
        method: 'POST',
        body,
        token,
      }),
    /** Unlocks it (5.28): `204`; somebody not locked is `409 not_locked`. Asks as a lock does. */
    unlockMember: (token: string, memberId: string) =>
      request<void>(`/api/v1/members/${enc(memberId)}/lock`, { method: 'DELETE', token }),
    /**
     * Turns a sign-in a restore paused back on (5.28, A55): `204`. Owners
     * only; asks as a lock does. Somebody not paused by a restore is `409
     * not_paused`.
     */
    resumeMember: (token: string, memberId: string) =>
      request<void>(`/api/v1/members/${enc(memberId)}/resume`, { method: 'POST', token }),
    /**
     * Signs somebody out everywhere (5.30, A53, when
     * `features.sign_out_everywhere`): every session and device of theirs
     * ends (`session_ended`, reason `revoked`; their phones are pushed
     * `session_ended`), and their sign-in stays as it is. A co-owner too, who
     * is emailed; anybody else it is about is emailed too. Oneself: every
     * device but the one asking. Owners only (anybody else `403 forbidden`),
     * and an owner power (A54), asked as a lock is: `403
     * totp_required_for_owner`, or `step_up_required` with `manage_sign_ins`
     * (a passkey or a code). Nobody with a sign-in: `404`.
     */
    signOutEverywhere: (token: string, memberId: string) =>
      request<SignedOutEverywhere>(`/api/v1/members/${enc(memberId)}/sessions`, {
        method: 'DELETE',
        token,
      }),
    /**
     * Limits what a viewer can see to exactly `grant` (5.33, when
     * `features.access_restrictions`; D6, A56–A59), or changes them: whose
     * documents, of which kinds, which collections (only one for Everyone,
     * else `422`). Owners only (`403 forbidden`), an owner power asked as a
     * lock is (A54): `403 totp_required_for_owner`, or `step_up_required`
     * with `limit_access` (a passkey or a code). Anybody but a viewer: `409
     * not_a_viewer`. Somebody who keeps Only me documents: `409
     * confirm_private`, until sent again with `confirm_private: true` — they
     * are told. Putting the same limits again confirms them after their
     * sign-in was given back (`reconfirm_since`): send what `MemberAccess`
     * gave, `limits_people` and `limits_types` too — an empty list with the
     * flag set still limits, and gives nothing that way.
     */
    setMemberAccess: (
      token: string,
      memberId: string,
      body: Partial<AccessGrant> & { confirm_private?: boolean },
    ) =>
      request<MemberAccess>(`/api/v1/members/${enc(memberId)}/access`, {
        method: 'PUT',
        body,
        token,
      }),
    /** Takes their limits off (5.33): `204`, also when there were none. Asked as `setMemberAccess`. */
    removeMemberAccess: (token: string, memberId: string) =>
      request<void>(`/api/v1/members/${enc(memberId)}/access`, { method: 'DELETE', token }),
    /**
     * "They will see 14 documents" (5.33): limits not yet saved, counted now
     * as the vault will give them — for somebody in the family, or, with no
     * `memberId`, somebody about to be invited. An owner's, or an adult's
     * inviting a viewer (never with Adults only documents, `403`).
     */
    previewAccess: (token: string, memberId: string | null, grant: Partial<AccessGrant>) =>
      request<AccessPreview>(
        `${memberId ? `/api/v1/members/${enc(memberId)}/access/preview` : '/api/v1/access/preview'}${qs(
          {
            people: grant.people?.join(','),
            types: grant.types?.join(','),
            collections: grant.collections?.join(','),
            include_adults_only: grant.include_adults_only,
            include_no_person_docs: grant.include_no_person_docs,
            expires_at: grant.expires_at,
            limits_people: grant.limits_people,
            limits_types: grant.limits_types,
          },
        )}`,
        { token },
      ),
    /**
     * A person's identity details (5.26, when `features.member_identity`): the
     * shared part, and the Only me part for the person alone, ID numbers and
     * hidden custom fields masked (`masked` names them). Anybody not given
     * the record: `404`, whoever's it is.
     */
    identity: (token: string, memberId: string) =>
      request<IdentityView>(`/api/v1/members/${enc(memberId)}/identity`, { token }),
    /**
     * A whole part, made from the `version` it was read at (0 for one never
     * written): a part moved on since is `409 conflict`. Leave out a masked
     * value to keep it; null clears it. Another person's Only me part is
     * `404`; who may not change this part, `403`. Since the Phase 5 exit
     * (0.6.0), an owner writing another person's shared part uses an owner
     * power (A54): `403 step_up_required` with `change_identity`, a passkey
     * or a code, never the password; without either, `403
     * totp_required_for_owner`.
     */
    updateIdentity: (token: string, memberId: string, body: IdentityWrite) =>
      request<IdentityView>(`/api/v1/members/${enc(memberId)}/identity`, {
        method: 'PUT',
        body,
        token,
      }),
    /**
     * Masked values, by key (`ids.<id>`, `custom.<id>`), of the shared part
     * unless `part` says. Asks who is asking. Another person's numbers,
     * whoever asks: `403 step_up_required` with `open_identity`, a passkey or
     * a code, never the password; somebody with neither is refused outright,
     * an owner `403 totp_required_for_owner` and anybody else `403
     * two_step_required`, each "Turn on two-step sign-in to see another
     * person's identity numbers." One's own: `reveal_identity`, any
     * credential. Audited by key, never by value.
     */
    revealIdentity: (
      token: string,
      memberId: string,
      body: { part?: IdentityPart; keys: string[] },
    ) =>
      request<IdentityReveal>(`/api/v1/members/${enc(memberId)}/identity/reveal`, {
        method: 'POST',
        body,
        token,
      }),
    /** Who reads other people's shared identity details now, and a wider audience waiting (A34). */
    identityAudience: (token: string) =>
      request<IdentityAudienceView>('/api/v1/household/identity-audience', { token }),
    /**
     * An owner's (A54: `403 totp_required_for_owner` without two-step
     * sign-in or a passkey; `step_up_required`, `identity_audience`, never by
     * password). Narrower at once; wider after 72 hours' notice (`pending`),
     * refused while anybody with a sign-in, of any role, cannot sign in to be
     * told (`409 member_cannot_be_told`).
     */
    setIdentityAudience: (token: string, audience: IdentityAudience) =>
      request<IdentityAudienceView>('/api/v1/household/identity-audience', {
        method: 'PUT',
        body: { audience },
        token,
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
    /**
     * An invitation (SHR-02). For a viewer, `restriction` limits what they
     * will see from the moment they accept (5.33): an adult inviting a viewer
     * must give one, without Adults only documents (`403 forbidden`, A27).
     *
     * Someone outside the family (5.34, when `features.guests`): `kind:
     * 'guest'`, always `role: 'viewer'`, always a `restriction`, and
     * `access_expires_at` within a year (else `422`); `relationship` says
     * what they are to the family ("attorney"). An owner's invitation that
     * decides what a viewer sees — none of `restriction` (a viewer who sees
     * every family document), `include_adults_only`, or limits replacing
     * those already set on the person — asks for a passkey or a code: `403
     * totp_required_for_owner`, or `step_up_required` with `limit_access`.
     */
    invite: (
      token: string,
      body: {
        member_id?: string;
        display_name?: string;
        email: string;
        role: Role;
        restriction?: Partial<AccessGrant> | null;
        kind?: MemberKind;
        access_expires_at?: string;
        relationship?: string | null;
      },
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
    /**
     * A page of documents. Sorted by a column (R2, `features.document_table`:
     * `DocumentListParams`), with a `direction` and the table's filters, a
     * page carries `total` and each document its `collections`; a sort or
     * filter by `location` is refused (422) to whoever may not see where
     * originals are kept. An older vault refuses those sorts.
     */
    documents: (token: string, params: DocumentListParams | Params = {}) =>
      request<DocumentPage>(`/api/v1/documents${qs(params)}`, { token }),
    /**
     * The tags on the documents this person can see, most used first (50 at
     * most), or those starting with `q`: the Documents table's tag filter (R2).
     */
    tags: (token: string, q?: string) =>
      request<{ items: Array<{ tag: string; count: number }> }>(`/api/v1/tags${qs({ q })}`, {
        token,
      }),
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
    /**
     * What its pages propose for its empty fields, each with a confidence
     * (5.37, `features.detail_suggestions`): offered as one-tap chips, never
     * filled in. Ask again while `pending`. A viewer or a guest is refused.
     */
    detailSuggestions: (token: string, documentId: string) =>
      request<DetailSuggestions>(`/api/v1/documents/${documentId}/suggestions`, { token }),
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
    /**
     * Who can see a document. Into Only me (5.41), the person's own links
     * that would still send it are ended (`ownLinks: 'end'`) or kept
     * (`'keep'`); with neither, while there are any, `409
     * links_choice_needed`, its `detail` a `LinksChoiceNeeded` (JSON). No
     * keeping while the household shares no Only me documents outside the
     * family: `409 only_me_not_shared`.
     */
    setVisibility: (
      token: string,
      documentId: string,
      visibility: Visibility,
      ownLinks?: 'end' | 'keep',
    ) =>
      request<VisibilityChange>(`/api/v1/documents/${documentId}/visibility`, {
        method: 'POST',
        body: { visibility, ...(ownLinks ? { own_links: ownLinks } : {}) },
        token,
      }),
    /**
     * Whether this household's Only me documents can be shared outside the
     * family (5.41): owners and adults read it; an owner changes it, with a
     * passkey or a code (`only_me_sharing`, A54).
     */
    onlyMeSharing: (token: string) =>
      request<OnlyMeSharing>('/api/v1/household/sharing', { token }),
    setOnlyMeSharing: (token: string, onlyMeShareable: boolean) =>
      request<OnlyMeSharing>('/api/v1/household/sharing', {
        method: 'PUT',
        body: { only_me_shareable: onlyMeShareable },
        token,
      }),
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
      request<{
        links: Share[];
        upload_requests?: UploadRequestView[];
        /** The sign-ins it paused (5.28), an owner's to turn back on; absent from older vaults. */
        sign_ins?: PausedSignIn[];
      }>('/api/v1/after-restore', {
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

    // ------------------------------- incoming: look before it is filed (5.23)
    // When `features.upload_requests`. Owners and adults who review what
    // came in; a teen or a viewer is answered 404, as if there were nothing.
    /** The files waiting for the reader, newest first. Nothing here is a document yet. */
    incoming: (token: string) =>
      request<{ items: IncomingFileView[] }>('/api/v1/incoming', { token }),
    /**
     * A page the vault drew for review: a JPEG. While it is being drawn,
     * `preview_pending` (retriable); a kind it does not draw, `no_preview`.
     */
    incomingPage: (token: string, id: string, n: number): Promise<ResponseLike> =>
      raw(`/api/v1/incoming/${enc(id)}/pages/${n}`, { token }),
    /**
     * A copy of the file, to look at it: an attachment, under its own name
     * with the ending its bytes say; `X-FDV-Scan: unscanned` (and a
     * Warning) when it was not scanned for viruses. Written in the activity log.
     */
    incomingContent: (token: string, id: string): Promise<ResponseLike> =>
      raw(`/api/v1/incoming/${enc(id)}/content`, { token }),
    /**
     * Files it: a new document with these details, checked as a capture's
     * are, or a new version of `into_document_id` (and nothing else beside
     * it). `404` for a document the reader cannot see or change; `409
     * already_decided` once somebody has filed or refused it; `409
     * incoming_not_ready` (retriable) while it is still being got ready.
     */
    acceptIncoming: (token: string, id: string, body: IncomingAcceptInput) =>
      request<IncomingAccepted>(`/api/v1/incoming/${enc(id)}/accept`, {
        method: 'POST',
        body,
        token,
      }),
    /** Refuses it: its bytes are removed. `409 already_decided` once decided. */
    rejectIncoming: (token: string, id: string) =>
      request<void>(`/api/v1/incoming/${enc(id)}/reject`, { method: 'POST', token }),

    // ------------------------------- many documents at once (Phase 6, I1)
    // When `features.batches`. Whoever may add documents (a viewer or a
    // guest is refused, 403); a batch and its items are its uploader's
    // alone until accepted (404 for anybody else's).
    /** A batch of the caller's own: an optional name, and defaults that fill only blanks. */
    createBatch: (token: string, body: BatchInput = {}) =>
      request<BatchDetail>('/api/v1/batches', { method: 'POST', body, token }),
    /** The caller's batches, newest first, each with how many are waiting. */
    batches: (token: string) => request<{ items: BatchView[] }>('/api/v1/batches', { token }),
    /** One batch, and its items not removed, oldest first, each with what it duplicates. */
    batch: (token: string, id: string) =>
      request<BatchDetail>(`/api/v1/batches/${enc(id)}`, { token }),
    /** Its name and defaults: what is sent changes, the rest stays. */
    updateBatch: (token: string, id: string, body: BatchInput) =>
      request<BatchDetail>(`/api/v1/batches/${enc(id)}`, { method: 'PATCH', body, token }),
    /** What is undecided in it removed, its bytes too; and the batch. Accepted items stay documents. */
    removeBatch: (token: string, id: string) =>
      request<void>(`/api/v1/batches/${enc(id)}`, { method: 'DELETE', token }),
    /**
     * One file into a batch, multipart as `file` (`422 batch_full` past
     * BATCH_MAX_FILES, `413 too_large`, `415 unsupported_type`, `409
     * batch_ended`). A browser that shows progress sends it itself, with
     * XMLHttpRequest, to `batchItemsUrl`.
     */
    addBatchItem: (token: string, batchId: string, file: CaptureFile) =>
      request<BatchItemView>(`/api/v1/batches/${enc(batchId)}/items`, {
        method: 'POST',
        upload: batchItemUpload(file),
        token,
      }),
    batchItemsUrl: (batchId: string) => http.url(`/api/v1/batches/${enc(batchId)}/items`),
    /** Removed, as a refused file is: its bytes and pages go. `409 already_decided` once decided. */
    removeBatchItem: (token: string, batchId: string, itemId: string) =>
      request<void>(`/api/v1/batches/${enc(batchId)}/items/${enc(itemId)}`, {
        method: 'DELETE',
        token,
      }),
    /**
     * Filed as a new document with every detail a capture takes, and a
     * collection; a detail left out takes the batch's default.
     */
    acceptBatchItem: (token: string, batchId: string, itemId: string, body: BatchAcceptInput) =>
      request<BatchAccepted>(`/api/v1/batches/${enc(batchId)}/items/${enc(itemId)}/accept`, {
        method: 'POST',
        body,
        token,
      }),
    /** A page the worker drew: a JPEG; `preview_pending` while it is drawn, `no_preview` if none. */
    batchItemPage: (token: string, batchId: string, itemId: string, n: number) =>
      raw(`/api/v1/batches/${enc(batchId)}/items/${enc(itemId)}/pages/${n}`, { token }),
  };
}

/** Which request a sender's call is about (0.5.21): the `request_id` Open answered. */
export function dropHeaders(requestId: string): Record<string, string> {
  return { 'x-fdv-drop-request': requestId };
}

export type Api = ReturnType<typeof createApi>;
