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
    physical_location: string | null;
    is_essential: Generated<boolean>;
    tags: Generated<string[]>;
    notes: string | null;
    extra: GeneratedJson;
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
    document_id: string;
    version_id: string | null;
    created_at: GeneratedTimestamp;
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

  device: {
    id: Generated<string>;
    household_id: string;
    account_id: string;
    kind: Generated<'web_push' | 'apns' | 'fcm'>;
    endpoint: string;
    p256dh: string | null;
    auth: string | null;
    label: string | null;
    user_agent: string | null;
    created_at: GeneratedTimestamp;
    last_used_at: Timestamp | null;
    failed_at: Timestamp | null;
    fail_reason: string | null;
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
  return new pg.Pool({ connectionString, max });
}

export function createDb(pool: pg.Pool): Db {
  return new Kysely<Schema>({ dialect: new PostgresDialect({ pool }) });
}

/**
 * The tenant context for a transaction. Row-level-security policies read
 * `app.household_id`; `app.account_id` additionally lets an account see its
 * own memberships before a household is chosen (sign-in).
 */
export interface Scope {
  householdId?: string;
  accountId?: string;
}

/**
 * Runs `fn` inside a transaction with the scope settings applied for its
 * duration. `set_config(..., true)` is transaction-local, so nothing leaks
 * to the next borrower of the pooled connection.
 */
export async function withScope<T>(db: Db, scope: Scope, fn: (trx: Db) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    if (scope.householdId) {
      await sql`select set_config('app.household_id', ${scope.householdId}, true)`.execute(trx);
    }
    if (scope.accountId) {
      await sql`select set_config('app.account_id', ${scope.accountId}, true)`.execute(trx);
    }
    return fn(trx);
  });
}

/** Shorthand for the common case: one household, no account context. */
export function withHousehold<T>(
  db: Db,
  householdId: string,
  fn: (trx: Db) => Promise<T>,
): Promise<T> {
  return withScope(db, { householdId }, fn);
}
