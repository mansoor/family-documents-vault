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
export type Visibility = 'household' | 'adults' | 'private';
export type DatePrecision = 'day' | 'month' | 'year';
/** Where a version's page previews are (0027). */
export type PreviewState = 'none' | 'queued' | 'ready' | 'unsupported' | 'failed';
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
  };

  account: {
    id: Generated<string>;
    email: string;
    password_hash: string | null;
    totp_secret: Buffer | null;
    totp_confirmed_at: Timestamp | null;
    created_at: GeneratedTimestamp;
    disabled_at: Timestamp | null;
  };

  account_household: {
    account_id: string;
    household_id: string;
    member_id: string;
    role: Role;
    joined_at: GeneratedTimestamp;
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
    issued_by: 'self' | 'operator';
    created_at: GeneratedTimestamp;
    expires_at: Timestamp;
    used_at: Timestamp | null;
    ip: string | null;
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
    document_id: string;
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
    kind: 'household' | 'adults' | 'member';
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
 *   document, while the link is live;
 * - `upload`: whoever holds an upload request's link — nothing;
 * - `anonymous`: a caller not yet known — a sign-in page, an invitation,
 *   a reset — nothing.
 *
 * A transaction that names nobody is given nothing.
 */
export type Actor =
  | { kind: 'account'; accountId: string; memberId: string; role: Role }
  | { kind: 'system' }
  | { kind: 'link'; shareId: string }
  | { kind: 'upload'; requestId: string }
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
      set_config('app.upload_request_id', ${actor.kind === 'upload' ? actor.requestId : ''}, true)
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
  const { householdId, accountId, memberId, role } = principal;
  return withScope(db, { householdId, actor: { kind: 'account', accountId, memberId, role } }, fn);
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
