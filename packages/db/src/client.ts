import {
  Kysely,
  PostgresDialect,
  sql,
  type ColumnType,
  type Generated,
  type GeneratedAlways,
} from 'kysely';
import pg from 'pg';

/**
 * The database schema as seen by Kysely. Tables are added by the iteration
 * that creates them, so this interface always matches the latest migration.
 */

// Kysely does not unwrap a ColumnType nested inside Generated<>, so the
// generated variants are spelled out.
type Timestamp = ColumnType<Date, Date | string, Date | string>;
type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type GeneratedJson = ColumnType<unknown, string | undefined, string>;

export type Role = 'owner' | 'adult' | 'teen' | 'viewer';
/** Of the family, or a guest from outside it (0056, 5.34): fixed once the person is made. */
export type MemberKind = 'family' | 'guest';
export type Visibility = 'household' | 'adults' | 'private';
export type DatePrecision = 'day' | 'month' | 'year';
/** Who a collection of documents is for (0036). */
export type CollectionAudience = 'everyone' | 'teens' | 'adults' | 'only_me';
/** Where a version's page previews are (0027). */
export type PreviewState = 'none' | 'queued' | 'ready' | 'unsupported' | 'failed';
/** Who reads other people's shared identity details (0050, A34). */
export type IdentityAudience = 'owners_and_self' | 'adults' | 'family';
/** The two parts of a person's identity details (0050). */
export type IdentityPart = 'shared' | 'only_me';
/** Where a person's photo is (0040): on its way, made, or refused. */
export type MemberPhotoState = 'processing' | 'ready' | 'failed';
/** What an attribute holds (0031). */
export type AttributeKind =
  'text' | 'long_text' | 'date' | 'year' | 'number' | 'money' | 'choice' | 'yes_no';
type DateOnly = ColumnType<string, string | null, string | null>;

export interface Schema {
  schema_migration: { version: number; name: string; applied_at: Timestamp };

  household: {
    id: Generated<string>;
    name: string;
    active_vault_id: string | null;
    protection_mode: Generated<'standard' | 'private'>;
    plan: Generated<string>;
    plan_state: Generated<'active' | 'read_only' | 'export_only'>;
    plan_state_since: Timestamp | null;
    settings: GeneratedJson;
    timezone: Generated<string>;
    created_at: GeneratedTimestamp;
    deleted_at: Timestamp | null;
    /**
     * Who reads other people's shared identity details (0050, A34): the
     * owners and each person, all adults too, or the teens as well. Set
     * narrower at once; wider only once its notice has run out
     * (`notice_request`), which the database holds to.
     */
    identity_audience: Generated<IdentityAudience>;
    /**
     * "Only me documents can be shared outside the family" (0061, 5.41): on
     * unless an owner turned it off; off, no link serves one.
     */
    only_me_shareable: Generated<boolean>;
  };

  member: {
    id: Generated<string>;
    household_id: string;
    display_name: string;
    date_of_birth: DateOnly | null;
    relationship: string | null;
    is_deceased: Generated<boolean>;
    colour: Generated<number>;
    created_at: GeneratedTimestamp;
    /** The account whose sign-in was taken away, so it can be given back (0019). */
    former_account_id: Generated<string | null>;
    /**
     * That sign-in's lock, or a restore's pause, as it was when the sign-in
     * was taken away (0059, the Phase 5 exit's review): given back with it,
     * so neither is lifted by taking a sign-in away and giving it back.
     */
    former_suspended_at: Timestamp | null;
    former_suspended_by: string | null;
    former_suspended_until: Timestamp | null;
    former_suspend_reason: 'locked' | 'restored' | null;
    former_suspend_note: string | null;
    /**
     * Moved on by one with every change to the name, date of birth,
     * relationship or passing (0046): the database's to keep, never set.
     */
    version: Generated<number>;
    /** When those last changed, and by whom: null until they do (0046). */
    updated_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
    updated_by: Generated<string | null>;
    /**
     * Of the family, or a guest from outside it (0056, 5.34): never changed
     * once made. A guest owns no document, has no member key and no identity
     * details, and is always restricted.
     */
    kind: Generated<MemberKind>;
  };

  /**
   * A person's identity details (0050): a shared part and an Only me part,
   * each sealed under a fresh data key bound to its household, person and
   * part, the key wrapped under the identity key (shared) or the person's
   * member key (Only me). `filled` names fields, never values. The version,
   * when and by whom are the database's to keep. Only me rows are the
   * person's alone, whoever else asks.
   */
  member_identity: {
    household_id: string;
    member_id: string;
    part: IdentityPart;
    sealed: Buffer;
    dek_wrapped: Buffer;
    wrapped_by_scope: string;
    filled: ColumnType<string[], string[] | undefined, string[]>;
    version: Generated<number>;
    updated_at: GeneratedTimestamp;
    updated_by: Generated<string | null>;
  };

  /**
   * Something done only after the people it touches were told (0050): today
   * a wider identity audience, whose `subject` is the audience it widens to.
   * Asked now, ending once: completed once `notice_until` has passed, or
   * withdrawn. Never removed.
   */
  notice_request: {
    id: Generated<string>;
    household_id: string;
    kind: 'identity_audience';
    subject: string;
    requested_by: string | null;
    requested_at: GeneratedTimestamp;
    notice_until: Timestamp;
    completed_at: Timestamp | null;
    withdrawn_at: Timestamp | null;
  };

  /**
   * A person's photo (0040): one ready 512-pixel square per person, sealed
   * under the household key, and at most one on its way or refused. The
   * upload's columns are set only while it is on its way.
   */
  member_photo: {
    id: Generated<string>;
    household_id: string;
    member_id: string;
    state: ColumnType<MemberPhotoState, MemberPhotoState | undefined, MemberPhotoState>;
    /** The part chosen, as fractions of the upright picture; null for the middle. */
    crop: ColumnType<unknown, string | null | undefined, string | null>;
    sealed: Buffer | null;
    source_key: string | null;
    source_vault_id: string | null;
    source_key_wrapped: Buffer | null;
    created_by: string | null;
    created_at: GeneratedTimestamp;
    ready_at: Timestamp | null;
  };

  account: {
    id: Generated<string>;
    email: string;
    password_hash: string | null;
    totp_secret: Buffer | null;
    totp_confirmed_at: Timestamp | null;
    created_at: GeneratedTimestamp;
    disabled_at: Timestamp | null;
    /**
     * When a link an owner was handed for this sign-in was last spent (0052):
     * every password change and reset after it takes away each passkey and
     * two-step sign-in added since.
     */
    handover_spent_at: Timestamp | null;
    /**
     * When the password was last changed with change(), not a reset (0052):
     * two-step sign-in turned on after it is kept by a reset.
     */
    password_changed_at: Timestamp | null;
  };

  account_household: {
    account_id: string;
    household_id: string;
    member_id: string;
    role: Role;
    joined_at: GeneratedTimestamp;
    /**
     * Their sign-in locked by an owner, or paused after a restore (0051):
     * since when, by whom (null for the vault itself), until when (a lock
     * alone; null until an owner unlocks it), why, and the owner's note. In
     * effect while `suspension_in_effect(suspended_at, suspended_until)`:
     * a lock past its end is over, whoever reads it.
     */
    suspended_at: Timestamp | null;
    suspended_by: string | null;
    suspended_until: Timestamp | null;
    suspend_reason: 'locked' | 'restored' | null;
    suspend_note: string | null;
    /**
     * A guest's sign-in ends then (0056, 5.34, A28): within a year, renewed
     * by an owner. Null for everybody of the family, always set for a guest.
     */
    access_expires_at: ColumnType<
      Date | null,
      Date | string | null | undefined,
      Date | string | null
    >;
  };

  credential: {
    id: Generated<string>;
    account_id: string;
    kind: 'passkey' | 'totp' | 'recovery_share';
    public_key: Buffer | null;
    credential_id: Buffer | null;
    sign_count: number | null;
    label: string | null;
    created_at: GeneratedTimestamp;
    last_used_at: Timestamp | null;
    transports: Generated<string[]>;
    backed_up: boolean | null;
    aaguid: string | null;
  };

  password_reset: {
    id: Generated<string>;
    account_id: string;
    token_hash: Buffer;
    /** `owner` since 0052: an owner started it (5.29). */
    issued_by: 'self' | 'operator' | 'owner';
    created_at: GeneratedTimestamp;
    expires_at: Timestamp;
    used_at: Timestamp | null;
    ip: string | null;
    /** An owner's: the household whose owner made it (0052). */
    household_id: string | null;
    /** An owner's: who made it; null once their account is gone (0052). */
    issued_by_account: string | null;
    /** An owner's, made to be handed over rather than mailed (0052, path 2). */
    handover: Generated<boolean>;
    /** When the person saw that an owner made one for them (0052). */
    told_at: Timestamp | null;
  };

  webauthn_challenge: {
    id: Generated<string>;
    challenge: Buffer;
    purpose: 'register' | 'authenticate';
    account_id: string | null;
    created_at: GeneratedTimestamp;
    expires_at: Timestamp;
    used_at: Timestamp | null;
  };

  session: {
    id: Generated<string>;
    account_id: string;
    household_id: string;
    refresh_hash: Buffer;
    prev_refresh_hash: Buffer | null;
    user_agent: string | null;
    ip: string | null;
    created_at: GeneratedTimestamp;
    last_used_at: GeneratedTimestamp;
    expires_at: Timestamp;
    revoked_at: Timestamp | null;
    revoked_reason: string | null;
    verified_at: Timestamp | null;
    /**
     * When it last saw a passkey or a code from an authenticator app (0046):
     * the owner's powers over other people's sign-ins ask this, never the
     * password (A54).
     */
    factor_verified_at: Timestamp | null;
    /** The app installation that signed in (X-FDV-Installation); null for a browser. */
    installation_id: string | null;
    /** When the refresh token was last replaced. */
    rotated_at: Timestamp | null;
    /** When the one replay allowed since the last rotation was spent. */
    grace_used_at: Timestamp | null;
    /** 180 days from the sign-in: no refresh goes past it. */
    absolute_expires_at: GeneratedTimestamp;
    /** Tokens a grace replay touched: presented again, they end the session. */
    grace_hashes: ColumnType<Buffer[], Buffer[] | undefined, Buffer[]>;
    /** Essentials this phone may keep (0028): when granted, until when, and Only me too. */
    offline_granted_at: Timestamp | null;
    offline_expires_at: Timestamp | null;
    offline_include_private: Generated<boolean>;
  };

  household_profile: {
    household_id: string;
    owns_home: boolean | null;
    rents_home: boolean | null;
    vehicle_count: number | null;
    has_pets: boolean | null;
    has_business: boolean | null;
    country: string | null;
    answered_at: Timestamp | null;
    extra: GeneratedJson;
  };

  invitation: {
    id: Generated<string>;
    household_id: string;
    member_id: string;
    email: string;
    role: Role;
    token_hash: Buffer;
    code_hash: string;
    invited_by: string;
    attempts: Generated<number>;
    created_at: GeneratedTimestamp;
    expires_at: Timestamp;
    accepted_at: Timestamp | null;
    accepted_by: string | null;
    revoked_at: Timestamp | null;
    revoked_by: string | null;
    /**
     * A viewer's limits, applied as the invitation is accepted (0055, 5.33):
     * written as JSON text, read back as the object. Null for none.
     */
    restriction: ColumnType<unknown, string | null | undefined, string | null>;
    /** A guest's invitation (0056, 5.34): always a viewer's, limited, with an end. */
    kind: Generated<MemberKind>;
    /** When the guest's sign-in will end, once accepted; null for the family's. */
    access_expires_at: ColumnType<
      Date | null,
      Date | string | null | undefined,
      Date | string | null
    >;
  };

  private_notice: {
    household_id: string;
    document_id: string;
    member_id: string;
    shown_at: GeneratedTimestamp;
  };

  share_link: {
    id: Generated<string>;
    household_id: string;
    /** The one document it gives; null for a link to a collection (0042). */
    document_id: string | null;
    /** The collection it gives, as ticked (share_link_item); null for a document's (0042). */
    collection_id: ColumnType<string | null, string | null | undefined, never>;
    /**
     * A collection's link that also gives what is put in the collection
     * later, for the whole of its audience (0042, A19): 30 days at most.
     */
    follow_collection: ColumnType<boolean, boolean | undefined, never>;
    /** The collection's audience as a following link was made (0042): what follows must fit it. */
    follow_audience: ColumnType<
      'everyone' | 'teens' | 'adults' | null,
      'everyone' | 'teens' | 'adults' | null | undefined,
      never
    >;
    /** A collection's link ended with its collection: made Only me, or deleted (0042). */
    revoked_why: 'collection_only_me' | 'collection_deleted' | null;
    token_hash: Buffer;
    pin_hash: string | null;
    recipient_label: string | null;
    created_by: string;
    created_at: GeneratedTimestamp;
    expires_at: Timestamp;
    revoked_at: Timestamp | null;
    revoked_by: string | null;
    open_count: Generated<number>;
    last_opened_at: Timestamp | null;
    attempts: Generated<number>;
    /**
     * Which routes open it (0037): `legacy`, a link made before 5.16, on the
     * old /shared/{token} routes only; `v2`, every link since, on the new
     * ones only. A link keeps the flow it was made with.
     */
    flow: Generated<'legacy' | 'v2'>;
    /**
     * Paused, and why: a restore (0037), for an owner to turn back on; or,
     * since 0061, the household's rule against sharing Only me documents
     * outside the family, until an owner turns that back on.
     */
    paused_at: Timestamp | null;
    paused_reason: 'restored' | 'only_me_not_shared' | null;
    /**
     * What it gives (0041): `view`, the pages the vault drew for it and never
     * the file; `download`, the file. Every link made before 0041 downloads,
     * and a legacy one can be nothing else.
     */
    permission: Generated<'view' | 'download'>;
    /** How many Opens may work (0041), against `open_count`; null for no limit. v2 only. */
    max_opens: number | null;
    /** How many downloads (0041), each document once a session; null for no limit. v2 only. */
    max_downloads: number | null;
    downloads_used: Generated<number>;
    /**
     * What `pin_hash` is the hash of (0043): a PIN, a password the sharer
     * typed, or one the vault made up (`generated`: hashed and checked in its
     * canonical form, lowercase without dashes or spaces). Passwords are v2
     * only. Null with a hash is a PIN, as every link before 0043 had.
     */
    secret_kind: ColumnType<
      'pin' | 'password' | 'generated' | null,
      'pin' | 'password' | 'generated' | null | undefined,
      never
    >;
    /**
     * Where an emailed code goes (0043, v2 only): the address the sharer
     * typed, sent to through the operator's mail server alone. Cleared, and
     * only then, when the link has ended.
     */
    code_email: ColumnType<string | null, string | null | undefined, null>;
    /** The first browser to open it is the only one it opens in (0043, v2 only). */
    this_device_only: ColumnType<boolean, boolean | undefined, never>;
    /** That browser: SHA-256 of the link and its device cookie, set once (0043). */
    device_hash: ColumnType<Buffer | null, never, Buffer>;
  };

  /**
   * An emailed code (0043): its HMAC under the server's key (never the code),
   * 10 minutes, 5 tries, used once. The family never reads these; a link its
   * own, the vault every one.
   */
  share_code: {
    id: string;
    household_id: string;
    share_id: string;
    flow: Generated<'v2'>;
    code_hash: Buffer;
    sent_at: GeneratedTimestamp;
    expires_at: Timestamp;
    attempts: Generated<number>;
    used_at: Timestamp | null;
  };

  /**
   * What a collection's link was made with (0042): the documents its sharer
   * ticked, in the collection's order. Checked again on every request.
   */
  share_link_item: {
    share_id: string;
    household_id: string;
    collection_id: string;
    document_id: string;
    position: number;
    /**
     * Ticked as the link was made; followed, decided as it was put in the
     * collection later; left out, in it as the link was made and not
     * ticked, so that it never follows (0042, the 5.19 review).
     */
    kind: ColumnType<
      'ticked' | 'followed' | 'left_out',
      'ticked' | 'followed' | 'left_out' | undefined,
      never
    >;
  };

  /**
   * A view-only link's pages that the worker's last try could not draw, a
   * version at a time, and when (0042; 0041 kept one on the link): said to
   * both ends as failed, and asked for again an hour later. A document's
   * link and each document of a collection's link alike.
   */
  share_page_failure: {
    household_id: string;
    share_id: string;
    permission: Generated<'view'>;
    document_id: string;
    version_id: string;
    failed_at: GeneratedTimestamp;
  };

  /**
   * What one session has had of a document (0041): its download, or its
   * first look at a view-only link's pages. Counted, and written down, once.
   */
  share_session_use: {
    household_id: string;
    session_id: string;
    share_id: string;
    document_id: string;
    kind: 'viewed' | 'downloaded';
    used_at: GeneratedTimestamp;
  };

  /**
   * A view-only link's own pages (0041): drawn by the worker from the
   * version's previews with whom the link is for across each, and encrypted
   * under the version's file key at `storage_key`.
   */
  share_page: {
    household_id: string;
    share_id: string;
    permission: Generated<'view'>;
    document_id: string;
    version_id: string;
    n: number;
    storage_key: string;
    created_at: GeneratedTimestamp;
  };

  /**
   * A v2 link opened in one browser (0037): the cookie's SHA-256, never the
   * cookie. It lasts 30 minutes from its last use, and ends at the earlier
   * of 4 hours and its link's end (`expires_at`).
   */
  share_session: {
    id: Generated<string>;
    household_id: string;
    share_id: string;
    flow: Generated<'v2'>;
    cookie_hash: Buffer;
    device_hash: Buffer | null;
    /** What opened it: the link alone (null), its PIN or password, an emailed code, or both (0043). */
    verified_by: 'pin' | 'password' | 'code' | 'pin+code' | 'password+code' | null;
    created_at: GeneratedTimestamp;
    last_seen_at: GeneratedTimestamp;
    expires_at: Timestamp;
    /** Cut to its /24 or /48 (A24). */
    ip: string | null;
    user_agent: string | null;
  };

  /**
   * Somebody outside the family asked to send documents in (0044): a
   * write-only link with an end, caps, the types it takes and who reviews
   * what comes in; optionally a password, a visit limit, an emailed code,
   * this device only, and closing once sent.
   */
  upload_request: {
    id: Generated<string>;
    household_id: string;
    created_by: string;
    requester_member_id: string;
    title: string;
    message: string | null;
    recipient_label: string | null;
    /** Where an emailed code goes; cleared when the request ends. */
    recipient_email: string | null;
    token_hash: Buffer;
    /** The password, as Argon2id. */
    secret_hash: string | null;
    /**
     * What the password is (0048): `generated`, made up by the vault and
     * hashed and checked in its canonical form (lower case, no dashes or
     * spaces); `password`, typed, checked exactly; null, none, or one made
     * before 0048, checked as typed.
     */
    secret_kind: 'password' | 'generated' | null;
    email_code: Generated<boolean>;
    this_device_only: Generated<boolean>;
    device_hash: Buffer | null;
    created_at: GeneratedTimestamp;
    expires_at: Timestamp;
    max_visits: number | null;
    visits_used: Generated<number>;
    max_files: Generated<number>;
    files_used: Generated<number>;
    max_total_bytes: ColumnType<string | number, number | undefined, string | number>;
    bytes_used: ColumnType<string | number, number | undefined, string | number>;
    accept_types: Generated<'standard' | 'office'>;
    review_by: Generated<'me' | 'adults'>;
    suggested_member_id: string | null;
    suggested_type_key: string | null;
    close_after_submit: Generated<boolean>;
    attempts: Generated<number>;
    paused_at: Timestamp | null;
    paused_reason: 'restored' | null;
    revoked_at: Timestamp | null;
    revoked_by: string | null;
    closed_at: Timestamp | null;
    closed_reason: 'submitted' | 'requester_lost_right' | null;
    /**
     * When its files were moved to the owners from a requester who can no
     * longer review (0047): from then on the owners' alone.
     */
    moved_to_owners_at: Timestamp | null;
  };

  /** What a request asks for, by name (0044): "W-2", "1099". */
  upload_request_item: {
    id: Generated<string>;
    household_id: string;
    request_id: string;
    position: number;
    label: string;
  };

  /** An upload link opened in one browser (0044): the cookie's SHA-256, never the cookie. */
  upload_session: {
    id: Generated<string>;
    household_id: string;
    request_id: string;
    cookie_hash: Buffer;
    verified_by: ColumnType<string[], string[] | undefined, string[]>;
    created_at: GeneratedTimestamp;
    last_seen_at: GeneratedTimestamp;
    expires_at: Timestamp;
    ip: string | null;
    user_agent: string | null;
  };

  /** An emailed code for an upload link (0044): an HMAC under the server's key. */
  upload_code: {
    id: Generated<string>;
    household_id: string;
    request_id: string;
    code_hash: Buffer;
    sent_at: GeneratedTimestamp;
    expires_at: Timestamp;
    attempts: Generated<number>;
    used_at: Timestamp | null;
  };

  /**
   * A file sent through a request (0044), held apart from the documents
   * until it is reviewed (5.23), encrypted under the reviewer's key.
   */
  incoming_file: {
    id: Generated<string>;
    household_id: string;
    /** The request it was sent through; null for a batch's item (0062), which names its batch. */
    request_id: string | null;
    /** The batch it is an item of (0062, Phase 6 I1): its uploader's alone until accepted. */
    batch_id: string | null;
    /** A batch's item, read for its details (I2): `waiting` until then; null for a file sent in. */
    read_state: 'waiting' | 'reading' | 'read' | 'failed' | null;
    /** What I2 proposes from its pages, sealed under the item's own key; gone once it is decided. */
    proposals_sealed: Buffer | null;
    /** Its words, read by the worker (I2, 0063), sealed under the item's own key; gone once decided. */
    text_sealed: Buffer | null;
    /** Why its pages were not read, while `read_state` is `failed` (0063). */
    read_failure: 'blank' | 'password' | 'unreadable' | 'too_slow' | 'not_read' | null;
    /** When the worker took it to read (0063): a read taken long ago is taken again. */
    read_started_at: Date | null;
    /** A batch's item: the uploader's Idempotency-Key for it, so a re-send is answered, not made twice. */
    idempotency_key: string | null;
    review_by: 'me' | 'adults';
    requester_member_id: string;
    item_id: string | null;
    session_id: string | null;
    state: ColumnType<
      'uploading' | 'received' | 'accepted' | 'rejected',
      'uploading' | 'received' | 'accepted' | 'rejected' | undefined,
      'uploading' | 'received' | 'accepted' | 'rejected'
    >;
    /** Its name as sent; null once it is refused (0047), which keeps no name. */
    original_name: string | null;
    mime: string | null;
    byte_size: ColumnType<string | number | null, number | null | undefined, number | null>;
    /** The room it holds while it arrives, against the caps (incoming_room()). */
    reserved_bytes: ColumnType<string | number, number | undefined, number>;
    sha256: Buffer | null;
    cipher_bytes: ColumnType<string | number | null, number | null | undefined, number | null>;
    cipher_sha256: Buffer | null;
    storage_key: string;
    vault_id: string;
    file_key_wrapped: Buffer;
    wrapped_by_scope: string;
    scope: 'adults' | 'member';
    sender_note: string | null;
    scan_state: Generated<'pending' | 'unscanned' | 'clean' | 'infected'>;
    created_at: GeneratedTimestamp;
    received_at: Timestamp | null;
    submitted_at: Timestamp | null;
    decided_by: string | null;
    decided_at: Timestamp | null;
    document_id: string | null;
    version_id: string | null;
    /** Its review previews (0047): drawn by the worker once it is no longer pending a scan. */
    preview_state: Generated<'none' | 'drawing' | 'ready' | 'unsupported' | 'failed'>;
    /** When its drawing began: one job at a time, and one that died is taken over after an hour. */
    preview_requested_at: Timestamp | null;
    preview_pages: number | null;
    /** A decided file's object, and its previews, gone (0047). */
    object_removed_at: Timestamp | null;
    /** Moved to the owners from a requester who can no longer review (0047). */
    owners_only: Generated<boolean>;
    /** When its reviewers were told it is waiting (0047): told once. */
    told_at: Timestamp | null;
  };

  /**
   * Many documents at once (0062, Phase 6 I1): a batch, its uploader's
   * alone, with defaults that fill only what is blank, and an end 30 days
   * after it was made. Its items are incoming files (`batch_id`).
   */
  intake_batch: {
    id: Generated<string>;
    household_id: string;
    created_by: string;
    member_id: string;
    name: string | null;
    default_owner_member_id: string | null;
    default_type_key: string | null;
    default_visibility: Visibility | null;
    default_physical_location: string | null;
    default_collection_id: string | null;
    default_tags: ColumnType<string[], string[] | undefined, string[]>;
    default_essential: Generated<boolean>;
    created_at: GeneratedTimestamp;
    ends_at: Timestamp;
  };

  owner_change_request: {
    id: Generated<string>;
    household_id: string;
    target_account: string;
    requested_by: string;
    action: 'promote' | 'demote';
    requested_at: GeneratedTimestamp;
    opens_at: Timestamp;
    lapses_at: Timestamp;
    /** Recorded once it has lapsed (0022), so a lapsed request is not live. */
    lapsed_at: Timestamp | null;
    refused_at: Timestamp | null;
    completed_at: Timestamp | null;
    completed_by: string | null;
    /** Ended without a refusal (0023): withdrawn, its subject stepped down, or a restore. */
    withdrawn_at: Timestamp | null;
    withdrawn_by: string | null;
    withdrawn_why: 'withdrawn' | 'stepped_down' | 'restored' | null;
  };

  known_device: {
    id: Generated<string>;
    account_id: string;
    household_id: string;
    fingerprint: Buffer;
    label: string;
    first_seen_at: GeneratedTimestamp;
    last_seen_at: GeneratedTimestamp;
  };

  scope_key: {
    id: Generated<string>;
    household_id: string;
    /** 'identity' (0049): what wraps the data keys of people's shared identity details. */
    kind: 'household' | 'adults' | 'member' | 'identity';
    member_id: string | null;
    key_wrapped: Buffer;
    key_wrapped_cred: Buffer | null;
    kdf_params: ColumnType<unknown, string | null, string | null> | null;
    created_at: GeneratedTimestamp;
    rotated_at: Timestamp | null;
  };

  vault: {
    id: Generated<string>;
    household_id: string;
    kind: 'local' | 's3';
    provider: string | null;
    label: string;
    endpoint: string | null;
    bucket: string | null;
    region: string | null;
    prefix: string | null;
    path_style: Generated<boolean>;
    credentials_encrypted: Buffer | null;
    role: Generated<'primary' | 'mirror' | 'migration_target'>;
    status: Generated<'untested' | 'ok' | 'failed'>;
    last_verified_at: Timestamp | null;
    last_error: string | null;
    created_at: GeneratedTimestamp;
  };

  document_type: {
    key: string;
    label: string;
    category: string;
    locale: string | null;
    fields: ColumnType<unknown, string, string>;
    expiry_driver: string | null;
    reminder_leads: number[];
    usually_essential: boolean;
    default_visibility: Visibility;
    sort_order: number;
    pack_version: number;
    /** This type's word for who issued it; null reads "Issued by" (0025). */
    issued_by_label: string | null;
    /** Whose type it is: null for a built-in, which every household reads (0031). */
    household_id: string | null;
    archived_at: Timestamp | null;
    created_by: string | null;
    updated_at: GeneratedTimestamp;
    /** The fixed fields, each shown, required and labelled (0031). */
    core: GeneratedJson;
    /** "Bank statement" for 'Bank / investment statement' (0031). */
    short_label: string | null;
    /** The noun after its issuer in a name: "Barclays statement" (0031). */
    issuer_noun: string | null;
    /**
     * Deleted while documents its deleter could not see still used it
     * (0035): kept only as the name of those documents.
     */
    deleted_at: Timestamp | null;
    /**
     * The date it reminds from (0038): 'expires', or one of its own date
     * fields' keys, with 1 to 8 lead times in reminder_leads; null, none.
     */
    remind_from: ColumnType<string | null, string | null | undefined, string | null>;
  };

  /** A household's changes to a built-in type; null keeps the built-in's own (0031). */
  document_type_setting: {
    household_id: string;
    type_key: string;
    hidden: Generated<boolean>;
    core: GeneratedJson;
    fields: ColumnType<unknown, string | null | undefined, string | null>;
    reminder_leads: number[] | null;
    default_visibility: Visibility | null;
    usually_essential: boolean | null;
    updated_at: GeneratedTimestamp;
    updated_by: string | null;
    /** As the built-in (null), 'none', 'expires' or a date field's key (0038). */
    remind_from: ColumnType<string | null, string | null | undefined, string | null>;
  };

  /** The fields a type can ask for: built-in (no household) or a household's own (0031). */
  document_attribute: {
    id: Generated<string>;
    household_id: string | null;
    key: string;
    label: string;
    kind: AttributeKind;
    choices: string[] | null;
  };

  /**
   * A household's types as they are in effect: the built-ins with its
   * settings applied, and its own (0031). A view, read with the caller's
   * own rights; never written.
   */
  effective_document_type: {
    key: string;
    household_id: string | null;
    builtin: boolean;
    label: string;
    category: string;
    locale: string | null;
    fields: unknown;
    expiry_driver: string | null;
    reminder_leads: number[];
    usually_essential: boolean;
    default_visibility: Visibility;
    sort_order: number;
    pack_version: number;
    core: unknown;
    issued_by_label: string | null;
    short_label: string | null;
    issuer_noun: string | null;
    /** Hidden by the household, archived, or deleted (0035). */
    hidden: boolean;
    archived_at: Date | null;
    updated_at: Date;
    /** Deleted, kept for the documents that use it (0035); see document_type. */
    deleted_at: Date | null;
    /**
     * The date it reminds from while it shows that date and has lead times
     * (0038): 'expires' or a date field's key; null, no reminders. Its lead
     * times are remind_leads; reminder_leads is [] while a detail reminds.
     */
    remind_from: string | null;
    remind_leads: number[];
  };

  document: {
    id: Generated<string>;
    household_id: string;
    type_key: string | null;
    title: string | null;
    owner_member_id: string | null;
    category: string | null;
    visibility: Generated<Visibility>;
    issued_on: DateOnly | null;
    issued_precision: DatePrecision | null;
    expires_on: DateOnly | null;
    expires_precision: DatePrecision | null;
    identifier: string | null;
    /** Who issued it (0025). */
    issued_by: string | null;
    physical_location: string | null;
    is_essential: Generated<boolean>;
    tags: Generated<string[]>;
    notes: string | null;
    extra: GeneratedJson;
    /**
     * An Only me document's notes and details, sealed under its owner's
     * member key (0033); its plain `notes` and `extra` are then empty.
     */
    notes_sealed: Buffer | null;
    extra_sealed: Buffer | null;
    /** Which of those details have a value, by key: what its status needs. */
    sealed_details: Generated<string[]>;
    status_cache: string | null;
    search_tsv: GeneratedAlways<string>;
    created_at: GeneratedTimestamp;
    created_by: string | null;
    updated_at: GeneratedTimestamp;
    updated_by: string | null;
    deleted_at: Timestamp | null;
    /**
     * An owner asked to remove it for good, and when (0045): whoever filed
     * it, and the other owners, were told then. Only in the Trash; Bring it
     * back clears both. Somebody else's is removed 24 hours after.
     */
    purge_requested_at: ColumnType<
      Date | null,
      Date | string | null | undefined,
      Date | string | null
    >;
    purge_requested_by: ColumnType<string | null, string | null | undefined, string | null>;
    /**
     * When its note's words last changed, and whose sign-in changed them
     * (0057, 5.35): set by the API only when the words change. Somebody
     * signed in stamps as themselves, now; the database refuses otherwise.
     */
    notes_updated_at: ColumnType<
      Date | null,
      Date | string | null | undefined,
      Date | string | null
    >;
    notes_updated_by: ColumnType<string | null, string | null | undefined, string | null>;
  };

  /**
   * What a document removed for good leaves behind (0045): who could see it,
   * and the collections' links whose snapshot named it, so the activity log
   * shows its lines to them and nobody else. Never changed or removed.
   */
  document_tombstone: {
    id: string;
    household_id: string;
    visibility: Visibility;
    owner_member_id: string | null;
    link_ids: ColumnType<string[], string[] | undefined, never>;
    removed_at: GeneratedTimestamp;
  };

  /**
   * An object a document removed for good owned, still to be deleted from
   * storage (0045): written with the removal, gone with its object.
   */
  purge_leftover: {
    id: Generated<string>;
    household_id: string;
    vault_id: string;
    object_key: string;
    removed_document: string;
    created_at: GeneratedTimestamp;
    tries: Generated<number>;
    last_error: string | null;
  };

  document_version: {
    id: Generated<string>;
    household_id: string;
    document_id: string;
    version_no: number;
    filename: string;
    mime: string;
    byte_size: ColumnType<string | number, number, number>;
    sha256: Buffer;
    cipher_bytes: ColumnType<string | number, number, number>;
    cipher_sha256: Buffer;
    storage_key: string;
    vault_id: string;
    file_key_wrapped: Buffer;
    wrapped_by_scope: string;
    page_count: number | null;
    ocr_status: Generated<'pending' | 'done' | 'failed' | 'skipped'>;
    thumbnail_key: string | null;
    /** Pages the vault has drawn (0027): how many, and where they are. */
    preview_pages: number | null;
    preview_state: Generated<PreviewState>;
    preview_requested_at: Timestamp | null;
    processed_at: Timestamp | null;
    process_error: string | null;
    uploaded_by: string | null;
    uploaded_at: GeneratedTimestamp;
    /**
     * Its file was not where it is kept when a restore looked (0045): removed
     * for good after the backup was made. Its record is back; its file is not.
     */
    file_removed_at: ColumnType<
      Date | null,
      Date | string | null | undefined,
      Date | string | null
    >;
  };

  document_text: {
    version_id: string;
    household_id: string;
    document_id: string;
    content: string;
    tsv: GeneratedAlways<string>;
    created_at: GeneratedTimestamp;
  };

  document_text_sealed: {
    version_id: string;
    household_id: string;
    document_id: string;
    content_cipher: Buffer;
    created_at: GeneratedTimestamp;
  };

  upload_idempotency: {
    idempotency_key: string;
    household_id: string;
    /** Null while a capture is pending: its document is made at the commit. */
    document_id: string | null;
    version_id: string | null;
    created_at: GeneratedTimestamp;
    account_id: string | null;
    state: ColumnType<'pending' | 'done', 'pending' | 'done' | undefined, 'pending' | 'done'>;
    request_kind: 'capture' | 'version';
    claim_nonce: string | null;
    claimed_at: GeneratedTimestamp;
    temp_key: string | null;
    temp_vault_id: string | null;
  };

  document_link: {
    household_id: string;
    a: string;
    b: string;
    created_at: GeneratedTimestamp;
  };

  /**
   * A collection of documents (0036): who it is for, and the member who made it —
   * the one who changes it, and the one an Only me collection is for. Marked
   * deleted, never removed.
   */
  doc_collection: {
    id: Generated<string>;
    household_id: string;
    name: string;
    description: string | null;
    audience: CollectionAudience;
    owner_member_id: string | null;
    created_by: string | null;
    created_at: GeneratedTimestamp;
    /** Its name, words and audience: never its items. */
    updated_at: GeneratedTimestamp;
    deleted_at: Timestamp | null;
  };

  /** A document in a collection, in the order they were put there. */
  doc_collection_item: {
    collection_id: string;
    document_id: string;
    household_id: string;
    added_by: string | null;
    added_at: GeneratedTimestamp;
    position: number;
  };

  /**
   * What a restricted viewer may see (0054, 5.32): keyed on the person, so
   * it outlives their sign-in. Who made it, when it changed and who confirmed
   * it are the database's to write (access_restriction_guard).
   */
  access_restriction: {
    member_id: string;
    household_id: string;
    include_adults_only: Generated<boolean>;
    include_no_person_docs: Generated<boolean>;
    expires_at: Timestamp | null;
    /** It names people, or kinds, at all: none of them left means none (R532-01). */
    limits_people: Generated<boolean>;
    limits_types: Generated<boolean>;
    created_by: Generated<string | null>;
    created_at: GeneratedTimestamp;
    updated_at: GeneratedTimestamp;
    updated_by: Generated<string | null>;
    /** Set to anything to confirm: the database writes now, and who. */
    private_confirmed_at: Timestamp | null;
    private_confirmed_by: Generated<string | null>;
    /** Their sign-in was given back, or their role changed: confirm again. */
    reconfirm_since: Timestamp | null;
  };

  /** The people whose documents a restriction gives. */
  access_restriction_member: {
    restricted_member_id: string;
    household_id: string;
    member_id: string;
  };

  /** The kinds of document a restriction gives. */
  access_restriction_type: {
    restricted_member_id: string;
    household_id: string;
    type_key: string;
  };

  /** The collections a restriction gives (only one for Everyone counts). */
  access_restriction_collection: {
    restricted_member_id: string;
    household_id: string;
    collection_id: string;
  };

  export: {
    id: Generated<string>;
    household_id: string;
    requested_by: string;
    state: Generated<'queued' | 'running' | 'done' | 'failed'>;
    document_count: number | null;
    byte_size: ColumnType<string | number, number | null, number | null> | null;
    storage_key: string | null;
    vault_id: string | null;
    file_key_wrapped: Buffer | null;
    wrapped_by_scope: string | null;
    error: string | null;
    created_at: GeneratedTimestamp;
    finished_at: Timestamp | null;
    expires_at: Timestamp | null;
  };

  reminder: {
    id: Generated<string>;
    household_id: string;
    document_id: string;
    kind: 'derived' | 'manual';
    fire_at: ColumnType<string, string, string>;
    lead_days: number | null;
    /** A derived reminder's date: 'expires' or a date field's key; null for a manual one (0038). */
    source: ColumnType<string | null, string | null | undefined, string | null>;
    note: string | null;
    recurrence: string | null;
    channel: Generated<string[]>;
    status: Generated<'scheduled' | 'due' | 'snoozed' | 'acknowledged' | 'resolved'>;
    snoozed_until: ColumnType<string, string | null, string | null> | null;
    acknowledged_by: string | null;
    acknowledged_at: Timestamp | null;
    created_by: string | null;
    created_at: GeneratedTimestamp;
  };

  reminder_delivery: {
    reminder_id: string;
    household_id: string;
    fire_date: ColumnType<string, string, string>;
    channel: string;
    delivered_at: GeneratedTimestamp;
  };

  notification_digest: {
    household_id: string;
    local_date: ColumnType<string, string, string>;
    kind: Generated<'daily' | 'catch_up' | 'weekly'>;
    item_count: number;
    channels: Generated<string[]>;
    sent_at: GeneratedTimestamp;
  };

  instance: {
    singleton: Generated<boolean>;
    instance_id: Generated<string>;
    created_at: GeneratedTimestamp;
  };

  device: {
    id: Generated<string>;
    household_id: string;
    account_id: string;
    kind: Generated<'web_push' | 'unified_push' | 'apns' | 'fcm'>;
    endpoint: string;
    p256dh: string | null;
    auth: string | null;
    label: string | null;
    user_agent: string | null;
    created_at: GeneratedTimestamp;
    last_used_at: Timestamp | null;
    failed_at: Timestamp | null;
    fail_reason: string | null;
    /** The sign-in that turned it on; pushes stop when it ends (0020). */
    session_id: Generated<string | null>;
    /** The app installation that registered it (0029). */
    installation_id: Generated<string | null>;
    /** Transient failures in a row; the tenth marks it failed (0029). */
    consecutive_failures: Generated<number>;
  };

  smtp_settings: {
    household_id: string;
    provider: string | null;
    host: string;
    port: Generated<number>;
    secure: Generated<boolean>;
    username: string | null;
    password_encrypted: Buffer | null;
    from_name: Generated<string>;
    from_email: string;
    status: Generated<'untested' | 'ok' | 'failed'>;
    last_verified_at: Timestamp | null;
    last_error: string | null;
    updated_at: GeneratedTimestamp;
  };

  notification_preference: {
    account_id: string;
    household_id: string;
    daily_push: Generated<boolean>;
    daily_email: Generated<boolean>;
    weekly_email: Generated<boolean>;
  };

  suggestion_rule: {
    key: string;
    condition: ColumnType<unknown, string, string>;
    suggests_type: string;
    scope: 'household' | 'per_member';
    quantity: ColumnType<unknown, string, string>;
    noun: string;
    why: string;
    sort_order: Generated<number>;
    enabled: Generated<boolean>;
  };

  suggestion_dismissal: {
    household_id: string;
    rule_key: string;
    member_id: string | null;
    dismissed_at: Generated<Date>;
    dismissed_by: string | null;
  };

  /** Events a phone reported, each received once per account (0028). */
  client_event_receipt: {
    household_id: string;
    account_id: string;
    event_id: string;
    received_at: GeneratedTimestamp;
  };

  /** A session's phone has kept this version (0028): the vault's own record. */
  offline_fill: {
    household_id: string;
    session_id: string;
    version_id: string;
    filled_at: GeneratedTimestamp;
  };

  audit_event: {
    id: Generated<number>;
    household_id: string;
    actor_account_id: string | null;
    actor_label: string | null;
    action: string;
    object_type: string | null;
    object_id: string | null;
    detail: GeneratedJson;
    ip: string | null;
    at: GeneratedTimestamp;
    prev_hash: Buffer | null;
    hash: Buffer;
  };
}

export type Db = Kysely<Schema>;

// A `date` column is a calendar day, not an instant: keep it as the
// 'YYYY-MM-DD' string Postgres sends rather than a local-midnight Date
// that shifts by the machine's time-zone offset. (OID 1082 = date.)
pg.types.setTypeParser(1082, (v: string) => v);

export function createPool(connectionString: string, max = 10): pg.Pool {
  const pool = new pg.Pool({ connectionString, max });
  // An idle connection the server ends — a restart, a failover, a database
  // dropped with force (a restore drill's) — is an 'error' on the pool.
  // Unheard, it is an uncaught exception that takes the process down; the
  // pool has already let the connection go and opens another when asked.
  pool.on('error', (err) => {
    console.warn(`[db] an idle connection was ended: ${err.message}`);
  });
  return pool;
}

export function createDb(pool: pg.Pool): Db {
  return new Kysely<Schema>({ dialect: new PostgresDialect({ pool }) });
}

/**
 * Who a transaction is for. The database is told, and its policies (0030)
 * answer each kind of caller differently in the document tables:
 * - `account`: somebody signed in, as the member and role they hold —
 *   what the application's rules allow;
 * - `system`: the vault itself — the worker's jobs, and the few lookups
 *   that must happen before any caller is known — everything;
 * - `link`: whoever holds a share link, once the link is found — its one
 *   document, or what it gives of its collection (5.19), while the link is
 *   live; of the household's other tables, only what its page names;
 * - `upload`: whoever holds an upload request's link — its own request,
 *   and the files of its own session (0044);
 * - `anonymous`: a caller not yet known — a sign-in page, an invitation,
 *   a reset — nothing.
 *
 * A transaction that names nobody is given nothing.
 */
export type Actor =
  /**
   * `sessionId`, when known, is the session asking (0052's app_session()):
   * a write that waited for a reset or a lock ending it gains nothing.
   */
  | { kind: 'account'; accountId: string; memberId: string; role: Role; sessionId?: string }
  | { kind: 'system' }
  | { kind: 'link'; shareId: string }
  /**
   * Whoever holds an upload request's link (0044): its own request, and,
   * once an Open has given it one, its own session, whose files alone it
   * reaches.
   */
  | { kind: 'upload'; requestId: string; sessionId?: string }
  | { kind: 'anonymous' };

/**
 * Anybody but the vault itself. Only `withSystem` acts as the vault, so the
 * calls that do can be counted (5.6's allow-list) and none slips through
 * `withScope` (5.5 review).
 */
export type CallerActor = Exclude<Actor, { kind: 'system' }>;

/** A caller not yet known. */
export const ANONYMOUS: CallerActor = Object.freeze({ kind: 'anonymous' });

/**
 * The tenant context for a transaction. Row-level-security policies read
 * `app.household_id`. `app.account_id` also lets an account see its own
 * memberships before a household is chosen: an account actor sets it for
 * itself, and `accountId` sets it for a caller that is not one yet
 * (sign-in, a reset).
 *
 * The actor is required, so a transaction cannot forget to say who it is for.
 */
export interface Scope {
  householdId?: string;
  accountId?: string;
  actor: CallerActor;
}

/** What the database is told about somebody signed in. */
export interface ScopePrincipal {
  householdId: string;
  accountId: string;
  memberId: string;
  role: Role;
  /** The session asking, when there is one: told to the database too (0052). */
  sessionId?: string;
}

/**
 * Runs `fn` inside a transaction with the scope settings applied for its
 * duration. `set_config(..., true)` is transaction-local, so nothing leaks
 * to the next borrower of the pooled connection.
 *
 * Every setting is written, empty when it does not apply: a value somebody
 * set on the connection itself cannot show through.
 */
export function withScope<T>(db: Db, scope: Scope, fn: (trx: Db) => Promise<T>): Promise<T> {
  // Its type already keeps the vault itself out; this keeps a cast
  // (`{ kind: 'system' } as never`) from bringing it back in.
  if ((scope.actor as Actor).kind === 'system') {
    return Promise.reject(new Error('only withSystem acts as the vault itself'));
  }
  return inScope(db, scope, fn);
}

/** The one place any actor, the vault included, reaches the settings. */
async function inScope<T>(
  db: Db,
  scope: { householdId?: string; accountId?: string; actor: Actor },
  fn: (trx: Db) => Promise<T>,
): Promise<T> {
  const { actor } = scope;
  const account = actor.kind === 'account' ? actor : null;
  return db.transaction().execute(async (trx) => {
    await sql`select
      set_config('app.household_id', ${scope.householdId ?? ''}, true),
      set_config('app.actor', ${actor.kind}, true),
      set_config('app.account_id', ${account?.accountId ?? scope.accountId ?? ''}, true),
      set_config('app.member_id', ${account?.memberId ?? ''}, true),
      set_config('app.role', ${account?.role ?? ''}, true),
      set_config('app.share_id', ${actor.kind === 'link' ? actor.shareId : ''}, true),
      set_config('app.upload_request_id', ${actor.kind === 'upload' ? actor.requestId : ''}, true),
      set_config('app.upload_session_id', ${actor.kind === 'upload' ? (actor.sessionId ?? '') : ''}, true),
      set_config('app.session_id', ${account?.sessionId ?? ''}, true)
    `.execute(trx);
    return fn(trx);
  });
}

/** Somebody signed in, in their own household, as the member and role they hold. */
export function withPrincipal<T>(
  db: Db,
  principal: ScopePrincipal,
  fn: (trx: Db) => Promise<T>,
): Promise<T> {
  const { householdId, accountId, memberId, role, sessionId } = principal;
  return withScope(
    db,
    {
      householdId,
      actor: { kind: 'account', accountId, memberId, role, ...(sessionId ? { sessionId } : {}) },
    },
    fn,
  );
}

/**
 * The vault itself, in one household: the worker's jobs, and the lookups
 * that must happen before a caller is known. Whatever runs here answers to
 * no member's limits, so the API calls it only where it must.
 */
export function withSystem<T>(
  db: Db,
  householdId: string,
  fn: (trx: Db) => Promise<T>,
): Promise<T> {
  return inScope(db, { householdId, actor: { kind: 'system' } }, fn);
}

/**
 * Reads as somebody signed in, inside a transaction of the vault's own
 * (5.32): what the database gives that person — their restriction applied —
 * and nothing more. The worker builds each person's digest this way, so
 * nothing it sends them comes from outside what they may see.
 *
 * Only for reading. It runs in a savepoint that is always rolled back: the
 * settings go back to what they were (the vault's), and anything `fn` wrote
 * is undone with them. The household stays the transaction's own.
 */
export async function readAs<T>(
  trx: Db,
  who: Omit<ScopePrincipal, 'householdId'>,
  fn: (trx: Db) => Promise<T>,
): Promise<T> {
  // Only from the vault's own: anybody else would be reading as somebody
  // they are not.
  const { rows } = await sql<{ actor: string | null }>`
    select nullif(current_setting('app.actor', true), '') as actor`.execute(trx);
  if (rows[0]?.actor !== 'system') {
    throw new Error('readAs is only for a transaction of the vault itself');
  }
  await sql`savepoint fdv_read_as`.execute(trx);
  try {
    // Marked, so that a test listening for every scope opened can tell this
    // narrowing inside the vault's own transaction from a scope of its own.
    await sql`select /* fdv:read-as */
      set_config('app.actor', 'account', true),
      set_config('app.account_id', ${who.accountId}, true),
      set_config('app.member_id', ${who.memberId}, true),
      set_config('app.role', ${who.role}, true),
      set_config('app.share_id', '', true),
      set_config('app.upload_request_id', '', true),
      set_config('app.upload_session_id', '', true),
      set_config('app.session_id', ${who.sessionId ?? ''}, true)
    `.execute(trx);
    return await fn(trx);
  } finally {
    await sql`rollback to savepoint fdv_read_as`.execute(trx);
    await sql`release savepoint fdv_read_as`.execute(trx);
  }
}
