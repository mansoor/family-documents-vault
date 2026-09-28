import type { DateValue, DocumentView, Visibility } from './documents.js';
import type { CollectionAudience, Role } from './roles.js';
import type { CollectionShareLock, SharePages, SharePermission } from './shares.js';

/**
 * The shapes that travel over the wire, written once.
 *
 * Until 0.4.3 these lived in the web app's `api.ts`, with the server
 * keeping its own copies — which had already drifted (the server's search
 * hits carried a `rank` the web's type did not know about). The API, the
 * web app and the phone now all compile against these.
 *
 * Additive rule (API-02): new optional fields are fine; a client ignores
 * what it does not recognise.
 */

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

/** What password sign-in answers when two-step sign-in is on. */
export interface MfaChallenge {
  mfa_required: true;
  mfa_token: string;
}

export interface Me {
  account_id: string;
  household_id: string;
  member_id: string;
  role: Role;
  totp_enabled: boolean;
  totp_required: boolean;
  has_passkey?: boolean;
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
  /** What holds it: an app installation, a browser, or neither we can tell (0.4.11). */
  client?: 'app' | 'browser' | 'other';
  /** In words: "the app on a Google Pixel 8a", "Firefox on a Mac" (0.4.11). */
  label?: string;
  /** It keeps Essentials for offline use: its offline grant is in force (0.4.13). */
  offline?: boolean;
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
  /**
   * Mum, Son, Grandad. Since 0.5.19 the family's own detail, as a birthday
   * is: null to a viewer, but for their own.
   */
  relationship: string | null;
  is_deceased: boolean;
  colour: number;
  has_account: boolean;
  role: Role | null;
  is_me: boolean;
  document_count: number;
  /** Their sign-in was taken away and can be given back — never re-invited. */
  sign_in_removed?: boolean;
  /**
   * Their photo, when one is ready (0.5.19): fetch it from
   * GET /members/{id}/photo/{photo.id} with a sign-in. Null for no photo,
   * and for everybody but themselves to a viewer. Absent from older vaults.
   */
  photo?: { id: string } | null;
  /**
   * A new photo on its way, or refused (0.5.19): told only to whoever may
   * change their photo. Null otherwise. Absent from older vaults.
   */
  photo_status?: 'processing' | 'failed' | null;
  /** Whether the caller may give them a photo, or change it (A66; 0.5.19). */
  can_change_photo?: boolean;
}

/** The largest photo a person's picture is made from (5.17c): 20 MiB. */
export const PHOTO_MAX_BYTES = 20 * 1024 * 1024;

/** A person's photo is a square JPEG this many pixels a side (5.17c). */
export const PHOTO_EDGE = 512;

/** What a person's photo can be made from (5.17c): JPEG, PNG, WebP, HEIC and HEIF. */
export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

/**
 * The part of a picture a photo shows (5.17c), as fractions of the upright
 * picture's width and height: from `x`, `y`, `w` across and `h` down. Each
 * from 0 to 1, inside the picture, and at least 0.05 a side. None is the
 * middle.
 */
export interface PhotoCrop {
  x: number;
  y: number;
  w: number;
  h: number;
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
  /**
   * The document it gives. Null for a link to a collection (5.19), which
   * says `collection_id` instead: a client that looks for a document's
   * links finds none of those.
   */
  document_id: string | null;
  document_title: string | null;
  /** A link to a collection (5.19): which, and its name now. Absent from older vaults. */
  collection_id?: string | null;
  collection_name?: string | null;
  /**
   * It also gives what is put in the collection later, for the whole of its
   * audience, and lasts 30 days at most (5.19, A19).
   */
  follow_collection?: boolean;
  recipient_label: string | null;
  created_by_name: string | null;
  created_at: string;
  expires_at: string;
  has_pin: boolean;
  open_count: number;
  last_opened_at: string | null;
  /**
   * `paused` since 0.5.14: a restore paused it, for an owner to turn back
   * on. `used_up` since 5.18: opened as many times as it allows (a page
   * opened with it stays open to its own end).
   */
  state: 'active' | 'expired' | 'revoked' | 'locked' | 'paused' | 'used_up';
  /**
   * Which routes open it (0.5.14): `legacy`, a link made before then, on
   * the old /shared/{token} routes; `v2`, on the new ones. Absent from
   * older vaults, where every link is legacy.
   */
  flow?: 'legacy' | 'v2';
  /** When it was paused, and why (0.5.14). Absent from older vaults. */
  paused_at?: string | null;
  paused_reason?: 'restored' | null;
  /**
   * What it gives (5.18): `view`, the pages the vault drew for it, with
   * whom it is for across each, and never the file; `download`, the file.
   * Absent from older vaults, where every link downloads.
   */
  permission?: SharePermission;
  /** How many times Open may work, against `open_count`; null for no limit (5.18). */
  max_opens?: number | null;
  /** How many downloads, each document counted once a session; null for no limit (5.18). */
  max_downloads?: number | null;
  /** Downloads so far, each document once a session (5.18). */
  downloads_used?: number;
  /** A view-only link's pages (5.18); null for a link to download. */
  pages?: SharePages | null;
  summary: string;
}

/**
 * `POST /documents/{id}/share`. `expires_at` (5.18) is the end: at least 5
 * minutes ahead and at most `limits.share_max_days` (FDV_SHARE_MAX_DAYS, 90)
 * days. Send it, and the rest of 5.18's options, only to a vault with
 * `features.share_options`; `expires_in_days` is what older vaults take.
 * Neither: seven days. Days past the vault's longest are cut to it.
 */
export interface ShareInput {
  expires_at?: string;
  expires_in_days?: number;
  recipient_label?: string;
  with_pin?: boolean;
  permission?: SharePermission;
  max_opens?: number | null;
  max_downloads?: number | null;
}

/**
 * The link and the PIN exist here and nowhere else. Since 0.5.14 the link
 * is `{origin}/s#{link_token}`: in the fragment, which no server sees.
 */
export interface CreatedShare {
  share: Share;
  link_token: string;
  /**
   * The link to send, on the vault's public-only site (0.5.14, FDV_PUBLIC_URL):
   * `https://share.example.com/s#{link_token}`. Null when the vault has none,
   * and absent from older vaults: then the link is the app's own address
   * followed by `/s#{link_token}`.
   */
  link_url?: string | null;
  pin?: string;
}

/**
 * `GET /collections/{id}/share-preview` (5.19): what the share sheet
 * offers. The documents in the collection the sharer can see — none they
 * cannot, and no count of them — each ticked when everybody the collection
 * is for may see it, and otherwise not, with why (`collectionShareItem`).
 */
export interface CollectionSharePreview {
  collection_id: string;
  collection_name: string;
  audience: CollectionAudience;
  items: CollectionShareItem[];
}

export interface CollectionShareItem {
  document_id: string;
  title: string | null;
  type_label: string | null;
  /** Ticked for you: everybody the collection is for may see it. */
  ticked: boolean;
  /** Why not: 'adults' and 'private' may be ticked anyway; 'no_file' cannot go. */
  lock: CollectionShareLock | null;
  /** In words, beside it: COLLECTION_SHARE_REASONS[lock]. */
  reason: string | null;
  /** The vault can draw its pages, so it can go on a link to view (A22). */
  viewable: boolean;
}

/**
 * `POST /collections/{id}/shares` (5.19): the documents ticked, at least one
 * unless the link follows the collection, and 5.18's options. Always asks to
 * confirm it's you (`step_up_required`, action `share_collection`).
 * `follow_collection` sends what is put in the collection later too, for
 * the whole of its audience, and such a link lasts 30 days at most.
 */
export interface CollectionShareInput extends ShareInput {
  document_ids: string[];
  follow_collection?: boolean;
}

/** What protects a link (0.5.14): its PIN. 5.20 adds a password and an emailed code. */
export type ShareProtection = 'pin';

/**
 * `POST /api/v1/shared/preview` (0.5.14): what the page shows before
 * anybody presses Open. Nothing is counted and nothing is written down.
 */
export interface ShareLinkPreview {
  household_name: string;
  shared_by: string | null;
  /** What Open asks for; empty when the link alone opens it. */
  protection: ShareProtection[];
  expires_at: string;
  /** Withheld while a protection is on: a title can say a great deal. */
  document_title: string | null;
  /** What Open gives (5.18): the pages, or the file. Absent from older vaults: download. */
  permission?: SharePermission;
  /** How many more times Open will work; null for no limit (5.18). */
  opens_left?: number | null;
  /** A document, or a collection (5.19). Absent from older vaults: a document. */
  kind?: 'document' | 'collection';
  /** A collection's name, withheld while a protection is on, as a title is (5.19). */
  collection_name?: string | null;
}

/** A document inside an opened link (0.5.14). */
export interface SharedItem {
  id: string;
  title: string | null;
  type_label: string | null;
  filename: string;
  content_type: string;
  byte_size: number;
  /**
   * A view-only link's pages of it (5.18): `GET
   * /shared/items/{id}/pages/{n}` serves 1 to `shown`. Null for a link to
   * download.
   */
  pages?: SharePages | null;
  /**
   * This session has downloaded it already (5.18): downloading it again
   * here is free, even once the link's downloads are used up.
   */
  downloaded?: boolean;
}

/**
 * What an opened link gives (0.5.14): `POST /api/v1/shared/unlock` and
 * `GET /api/v1/shared/items`. The session lasts 30 minutes from its last
 * use, and ends at `session_expires_at` at the latest.
 */
export interface SharedSession {
  household_name: string;
  shared_by: string | null;
  /** The link's own end. */
  expires_at: string;
  session_expires_at: string;
  items: SharedItem[];
  /** What the link gives (5.18): the pages, or the files. Absent from older vaults: download. */
  permission?: SharePermission;
  /** How many more documents may be downloaded; null for no limit (5.18). */
  downloads_left?: number | null;
  /**
   * A document, or a collection (5.19): then `items` are the documents it
   * gives now, as its sharer may still see them, and nothing says how many
   * others there are. Absent from older vaults: a document.
   */
  kind?: 'document' | 'collection';
  collection_name?: string | null;
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
  state: 'waiting' | 'ready' | 'refused' | 'withdrawn' | 'completed' | 'lapsed';
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
  /**
   * The household's time zone (IANA): reminders fall due on its calendar,
   * and "today" is its day. Every role reads it; a vault answers it
   * whenever it answers the profile.
   */
  timezone?: string;
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
  /** Who issued it (0.4.10): send only to a vault with `features.issued_by`. */
  issued_by?: string | null;
  physical_location?: string | null;
  is_essential?: boolean;
  tags?: string[];
  notes?: string | null;
  /**
   * The type's own details, by field key (0.5.7). An edit merges them: a
   * key left out stays as it is, and null takes it away.
   */
  extra?: Record<string, unknown>;
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
  /** Who issued it, and when (0.4.10): "Bank statement · Barclays · Sep 2026". */
  issued_by?: string | null;
  issued?: DocumentView['issued'];
  /** Server-highlighted with `<em>`; clients escape everything else. */
  snippet: string;
  matched_in: 'title' | 'content';
  /** How well it matched; results arrive already ordered by it. */
  rank?: number;
}

/** GET /issuers: the household's issuers the caller can see, most used first (0.4.10). */
export interface IssuerCount {
  issued_by: string;
  count: number;
}

/**
 * GET /documents/{id}/issuer-suggestions (0.4.10): who issued it, going by
 * the words on its pages and the household's own issuers. Offered, never
 * filled in; 'pending' until the vault has read the pages.
 */
export interface IssuerSuggestions {
  state: 'ready' | 'pending' | 'unavailable';
  items: Array<{ value: string; source: 'known' | 'page' }>;
}

export interface SearchResult {
  items: SearchHit[];
  sealed_pending: { count: number; token?: string };
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface DeviceRow {
  id: string;
  /** A browser, or the phone app through its distributor (4.13). */
  kind?: 'web_push' | 'unified_push' | 'apns' | 'fcm';
  endpoint: string;
  label: string | null;
  user_agent: string | null;
  created_at: string;
  last_used_at: string | null;
  working: boolean;
  /** When it last failed, while it is not working (4.13). */
  failed_at?: string | null;
  /** Registered by the session asking (4.13). */
  this_session?: boolean;
  /**
   * Its session expired or was ended: it hears nothing (and `working` is
   * false) until that device signs in again (0.4.14).
   */
  signed_out?: boolean;
}

export interface PushKey {
  public_key: string | null;
  enabled: boolean;
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

export interface StepUpState {
  verified_at: string | null;
  expires_in: number;
}

export interface CaptureResult {
  document_id: string;
  version_id: string;
  job_id: string | null;
  state: string;
}

/**
 * GET /uploads/{key}: what became of one of the caller's own uploads. A key
 * never seen, someone else's, or a try that failed is a 404.
 */
export type UploadStatus =
  | { state: 'done'; document_id: string; version_id: string }
  | { state: 'in_progress'; since: string };

/** The single error envelope every failure uses (API-03). */
export interface ErrorBody {
  error: {
    code: string;
    message: string;
    retriable?: boolean;
    request_id?: string;
    detail?: string;
    action?: string;
    /** Why a session ended, where the server says. */
    reason?: string;
  };
}
