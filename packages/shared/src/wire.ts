import type { DateValue, DocumentView, Visibility } from './documents.js';
import type { IdentityAudience, IdentityFields, IdentityPart } from './identity.js';
import type { CollectionAudience, Role, RoleChangeEffect } from './roles.js';
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
  /**
   * An owner made a one-time link to set a new password for this sign-in, to
   * hand over (5.29, path 2), and the person has not yet said they saw it:
   * told at every sign-in until `DELETE /me/reset-notice`. Null otherwise;
   * absent from older vaults.
   */
  reset_notice?: ResetNotice | null;
  /**
   * When a link an owner was handed for this sign-in was last spent (5.29);
   * null if never. Every password change takes away each passkey and
   * two-step sign-in added since: a client says so before the change.
   * Absent from older vaults.
   */
  handover_since?: string | null;
}

/** That an owner made a hand-over link for this sign-in (5.29): who, and when. */
export interface ResetNotice {
  /** The owner's name; null once their sign-in is gone. */
  by: string | null;
  /** When they made it. */
  at: string;
  /**
   * When such a link was last spent, and what was added to this sign-in
   * since — by whoever spent it, perhaps: changing the password takes each
   * away. Null and empty while no link has been spent. Absent from vaults
   * before the 5.29 review.
   */
  spent_at?: string | null;
  passkeys_since?: Array<{ label: string | null; added_at: string }>;
  /** When two-step sign-in was turned on since; null if it was not. */
  two_step_since?: string | null;
  /**
   * Share links made as this sign-in since, still live (the 5.29 second
   * round): what each is to, and when it was made. Changing the password
   * ends each.
   */
  links_since?: Array<{ title: string | null; made_at: string }>;
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
  /**
   * Moved on by one with every change to their details (5.25): send it back
   * as If-Match with PATCH /members/{id}, and a change made meanwhile is a
   * `409 conflict` instead of being undone. Null to whoever is not given
   * their details (a viewer, but for their own). Absent from older vaults.
   */
  version?: number | null;
  /**
   * Whether the caller may change their name, date of birth and
   * relationship (A66, 5.25). That somebody has passed away is an owner's
   * alone to say. Absent from older vaults, which change nobody's.
   */
  can_edit?: boolean;
}

/**
 * PATCH /members/{id} (5.25): what is sent is changed, and nothing else.
 * `is_deceased` is an owner's alone, and asks for a step-up
 * (`change_people`). A blank relationship is none.
 */
export interface MemberEdit {
  display_name?: string;
  date_of_birth?: string | null;
  relationship?: string | null;
  is_deceased?: boolean;
}

/** One device a person is signed in on, as the owner's account card shows it (5.25). */
export interface MemberAccountDevice {
  /** In words: "the app on a Google Pixel 8a", "Firefox on a Mac". */
  label: string;
  client: 'app' | 'browser' | 'other';
  last_used_at: string;
  /** It keeps Essentials for offline use: its offline grant is in force. */
  offline: boolean;
}

/**
 * GET /members/{id}/account (5.25): an owner's view of somebody's sign-in,
 * read-only. No address a device signed in from, and no secret of any kind:
 * no password, code, passkey or token, and no device's own id.
 */
export interface MemberAccount {
  member_id: string;
  role: Role;
  email: string;
  /** Two-step sign-in with an authenticator app is on. */
  two_step: boolean;
  passkeys: number;
  /** Their most recent sign-in here; null if they never have. */
  last_signed_in_at: string | null;
  /** Where they are signed in now, the most recently used first. */
  devices: MemberAccountDevice[];
  /**
   * Their sign-in locked by an owner, or paused after a restore (5.28); null
   * when they can sign in. Absent from older vaults, which lock nobody.
   */
  suspension?: MemberSuspension | null;
  /**
   * How many days a phone may go on showing the Essentials it keeps without
   * reaching the vault (FDV_OFFLINE_MAX_DAYS, the `max_offline_days` a phone
   * is given): a phone that never reconnects keeps its copies that long
   * after a lock (5.28). Absent from older vaults.
   */
  max_offline_days?: number;
  /**
   * Which way a password reset an owner starts for them would go now (5.29):
   * `mail`, `handover` or `operator` (ResetPath). Null when no owner may
   * start one: they are an owner (A50), or their sign-in is locked or
   * paused. Absent from older vaults, which have no such reset.
   */
  reset_path?: ResetPath | null;
}

/**
 * The way a password reset an owner starts goes (5.29, D5):
 *
 *  - `mail`: whoever runs the server gave it a mail server (FDV_SMTP_URL),
 *    and the link goes by that alone to the person's own sign-in address;
 *  - `handover`: it has none, and the person keeps nothing private, so the
 *    owner is shown a one-time link to hand over, once;
 *  - `operator`: anybody else — no owner's way. Whoever runs the server
 *    runs `cli reset-password`.
 *
 * Treat a value never heard of as `operator`.
 */
export type ResetPath = 'mail' | 'handover' | 'operator';

/**
 * POST /members/{id}/password-reset (5.29): `stop_now` makes their current
 * password stop working at once and signs them out everywhere (A48); they
 * choose a new one through the link.
 */
export interface OwnerResetInput {
  stop_now?: boolean;
}

/**
 * What an owner's password reset did (5.29). Never a link but in `handover`,
 * where it is shown this once.
 */
export interface OwnerResetResult {
  member_id: string;
  path: ResetPath;
  /** Their password stopped working, and every session of theirs ended. */
  stop_now: boolean;
  /** `handover` only: the one-time link, `/reset#…`, shown this once. */
  link?: string;
  /** `mail` and `handover`: when the link stops working. */
  expires_at?: string;
  /** `operator` only: what whoever runs the server types. */
  command?: string;
}

/** How long a reset link works, from whoever it comes (minutes). */
export const RESET_LINK_MINUTES = 60;

/**
 * What whoever runs the server types to give somebody a reset link
 * (`operator`, 5.29): the README's command, for their sign-in address —
 * quoted for a POSIX shell, each `'` written `'\''`, so an address with a
 * quote in it is passed whole and as it is, never as another one.
 */
export const resetCommand = (email: string) =>
  `docker compose exec api node apps/api/dist/cli.mjs reset-password ${shellQuoted(email)}`;

/** One argument for a POSIX shell, taken literally: single quotes, each `'` as `'\''`. */
export const shellQuoted = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

/**
 * Why somebody cannot sign in just now (5.28): `locked` by an owner (A51),
 * or `restored` — paused after the vault was restored from a backup, until
 * an owner turns it back on (A55). Treat a reason never heard of as
 * paused.
 */
export type SuspendReason = 'locked' | 'restored';

/** A sign-in locked or paused (5.28), as an owner is shown it. */
export interface MemberSuspension {
  reason: SuspendReason;
  /** When it was locked or paused. */
  since: string;
  /** A lock that ends by itself at this moment; null until an owner unlocks it. */
  until: string | null;
  /** The owner's note to the other owners; never shown to the person. */
  note: string | null;
  /** Who locked it, by name; null after a restore, or once they have gone. */
  by: string | null;
}

/**
 * POST /members/{id}/lock (5.28): until when (an ISO moment, in the future,
 * within a year; left out or null, until an owner unlocks it); whether their
 * links and requests end for good rather than pause (`end_links`); and a
 * note for the other owners (500 characters at most).
 */
export interface MemberLock {
  until?: string | null;
  end_links?: boolean;
  note?: string | null;
}

/** The longest a lock may be set to last by itself (5.28): a year. */
export const LOCK_MAX_DAYS = 365;

/** The longest note a lock keeps (5.28). */
export const LOCK_NOTE_MAX = 500;

/**
 * A sign-in a restore paused (5.28, A55), waiting in "After a restore" for
 * an owner to turn it back on. Its `role` is shown to confirm; 5.33 adds a
 * viewer's restriction beside it.
 */
export interface PausedSignIn {
  member_id: string;
  display_name: string;
  role: Role;
  paused_at: string;
}

/**
 * Whether a lock or a pause is in effect now (5.28): there, and not past
 * its end — a lock past its date is over, whoever asks, with nothing
 * written. The database's suspension_in_effect() (0051) says the same;
 * change them together.
 */
export function suspensionInEffect(
  s: { suspended_at: Date | string | null; suspended_until: Date | string | null },
  now: number = Date.now(),
): boolean {
  if (s.suspended_at === null) return false;
  return s.suspended_until === null || new Date(s.suspended_until).getTime() > now;
}

/**
 * Whether an owner's lock is in effect now (5.28): what takes away somebody's
 * right to review what was sent for them alone, and what is the owners' and
 * the person's to know. A pause after a restore is not one: it waits for an
 * owner (A55), and takes nothing away.
 */
export function lockInEffect(
  s: {
    suspend_reason: string | null;
    suspended_at: Date | string | null;
    suspended_until: Date | string | null;
  },
  now: number = Date.now(),
): boolean {
  return s.suspend_reason === 'locked' && suspensionInEffect(s, now);
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
  /** True when somebody else made the link: whoever runs the server, or an owner (5.29). */
  issued_by_operator: boolean;
  /**
   * Who made it (5.29): the person (`self`), whoever runs the server
   * (`operator`), or an owner of the vault (`owner`). Absent from older
   * vaults; treat a value never heard of as somebody else.
   */
  issued_by?: 'self' | 'operator' | 'owner';
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
  /**
   * When it was paused, and why (0.5.14): `restored`, by a restore, for an
   * owner to turn back on. Since 5.28, to an owner and to whoever made it,
   * `locked` — its maker's sign-in is locked, and it works again by itself
   * once they are unlocked — or `sign_in_paused` — its maker's sign-in
   * waits after a restore, and it works again once that is turned back on;
   * no owner turns either on (`paused_at` is then when the sign-in was
   * locked or paused). Anybody else is told it is paused, with no reason
   * and no moment (null): a lock is the owners' and the person's to know.
   * Absent from older vaults; treat a reason never heard of as paused.
   */
  paused_at?: string | null;
  paused_reason?: 'restored' | 'locked' | 'sign_in_paused' | null;
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
  /**
   * What Open asks for besides the link (5.20): a PIN or a password, an
   * emailed code. Absent from older vaults: `has_pin` says.
   */
  protection?: ShareProtection[];
  /** Where its code goes, masked; null when it asks for none or has ended (5.20). */
  code_to?: string | null;
  /** It opens in the first browser that opened it, and no other (5.20). */
  this_device_only?: boolean;
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
  /**
   * 5.20, to a vault with `features.share_second_factor`: a password the
   * vault makes up (`with_password`), or one typed here (8 to 64
   * characters) — one secret at most, a PIN included.
   */
  with_password?: boolean;
  password?: string;
  /**
   * 5.20: an emailed code, sent to this address when they ask for it — only
   * to a vault with `features.share_email_code` (its operator's mail server
   * is set); any other refuses it (`422 email_code_unavailable`).
   */
  code_email?: string;
  /** 5.20: the first browser to open it is the only one it opens in. */
  this_device_only?: boolean;
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
  /** A password the vault made up (5.20, `with_password`): here, once, and nowhere else. */
  password?: string;
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
 * `follow_collection` sends what an owner or an adult puts in the collection
 * later too, for the whole of its audience, and such a link lasts 30 days
 * at most. `left_out_ids`, what the sheet offered and was left unticked: for
 * a link that keeps up, never to follow, even if it leaves the collection
 * before the link is made (absent from older clients: what is in it then).
 */
export interface CollectionShareInput extends ShareInput {
  document_ids: string[];
  follow_collection?: boolean;
  left_out_ids?: string[];
}

/**
 * What Open asks for (0.5.14): a PIN; since 5.20 a password instead, and an
 * emailed code (`POST /shared/code` sends it), alone or with either. A
 * client that meets one it does not know asks for nothing it cannot say.
 */
export type ShareProtection = 'pin' | 'password' | 'code';

/**
 * `POST /api/v1/shared/code` (5.20): a code was sent to the address the
 * sharer typed, masked here; it works once, until `expires_at`.
 */
export interface ShareCodeSent {
  sent_to: string;
  expires_at: string;
}

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
  /**
   * Where an emailed code goes, masked (`j•••@e•••.com`), when Open asks for
   * one (5.20). The recipient never types an address.
   */
  code_to?: string | null;
  /** The first browser to open it is the only one it opens in (5.20). */
  this_device_only?: boolean;
  /**
   * It has been opened in another browser already, and opens only there
   * (5.20): Open would be refused, and the title stays withheld.
   */
  other_device?: boolean;
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
  /**
   * What else the change did (5.30), each with how many it touched: the
   * sessions whose offline Essentials ended, the requests to send documents
   * closed, the exports ended. Only what happened is listed; `[]` when
   * nothing else did, or the role did not change. Absent from older vaults.
   */
  effects?: RoleChangeEffectDone[];
}

/** One thing a role change did (5.30). Treat an `effect` never heard of as something it did. */
export interface RoleChangeEffectDone {
  effect: RoleChangeEffect;
  count: number;
}

/**
 * DELETE /members/{id}/sessions (5.30): how many sessions it ended. Oneself,
 * every other one: the device asking stays signed in.
 */
export interface SignedOutEverywhere {
  member_id: string;
  sessions_ended: number;
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

/**
 * The step-ups that take a passkey or a code from an authenticator app,
 * never the password: the owner's powers over other people's sign-ins (A54,
 * 5.25) and who sees identity details (`identity_audience`, 5.26); and,
 * whoever asks, showing another person's identity numbers (`open_identity`,
 * 5.26) — one's own take `reveal_identity`, any credential. Somebody with
 * neither is refused outright, in the words of what they asked for: an
 * owner `403 totp_required_for_owner`, anybody else `403
 * two_step_required`. A client asking for one of these offers no password
 * field.
 */
export const FACTOR_STEP_UPS: readonly string[] = [
  'manage_sign_ins',
  'open_identity',
  'identity_audience',
];

/**
 * One part of a person's identity details, as the reader is shown it
 * (GET /members/{id}/identity, 5.26): every masked value left out of
 * `fields` — an ID's `number`, a hidden custom field's `value` — and named
 * in `masked`; sent back left out, it is kept. `filled` names what has a
 * value, never a value. A part never written is empty, version 0.
 */
export interface IdentityPartView {
  fields: IdentityFields;
  /** `ids.<id>` and `custom.<id>`: what POST …/identity/reveal shows. */
  masked: string[];
  filled: string[];
  version: number;
  updated_at: string | null;
}

/** GET /members/{id}/identity (5.26): the record as the caller may see it. */
export interface IdentityView {
  member_id: string;
  /** The household's audience in effect now (A34). */
  audience: IdentityAudience;
  /** Which parts the caller may change. */
  can_edit: { shared: boolean; only_me: boolean };
  /** Each part's version, for the next PUT; Only me's for the person alone, null to anybody else. */
  versions: { shared: number; only_me: number | null };
  shared: IdentityPartView;
  /** The person's alone (A33): null to anybody else. */
  only_me: IdentityPartView | null;
}

/** PUT /members/{id}/identity (5.26): a whole part, made from the version read. */
export interface IdentityWrite {
  part: IdentityPart;
  /** The part's version as read: 0 for a part never written. */
  version: number;
  fields: IdentityFields;
}

/** POST /members/{id}/identity/reveal (5.26): the masked values asked for, by key. */
export interface IdentityReveal {
  part: IdentityPart;
  values: Record<string, string>;
}

/**
 * GET and PUT /household/identity-audience (5.26, A34): who reads other
 * people's shared identity details now, and a wider audience waiting for
 * its notice to run out — told to every adult, who can mark fields Only me
 * meanwhile.
 */
export interface IdentityAudienceView {
  audience: IdentityAudience;
  pending: {
    to: IdentityAudience;
    requested_at: string;
    /** From this moment on, the wider audience reads. */
    notice_until: string;
  } | null;
  /** Whether the caller may change it: an owner (A54: with two-step sign-in or a passkey). */
  can_change: boolean;
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
