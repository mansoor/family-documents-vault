import type { DateValue, DocumentView, Visibility } from './documents.js';
import type { DetailProposal } from './proposals.js';
import type { MemberKind } from './guests.js';
import type { IdentityAudience, IdentityFields, IdentityPart } from './identity.js';
import type { MemberAccess, MyRestriction, RestrictionSummary } from './restrictions.js';
import type { CollectionAudience, Role, RoleChangeEffect } from './roles.js';
import type { CollectionShareLock, SharePages, SharePermission } from './shares.js';
import type { TimeZoneSource } from './time-zone.js';

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
  /**
   * What the second step may be (0.9.0, SMS3): a code from an authenticator
   * app (`totp`), a code texted to their own confirmed number (`text`, POST
   * /auth/mfa/text sends one), or both. Absent from older vaults: `totp`.
   */
  methods?: ('totp' | 'text')[];
  /** Where a texted code goes, masked ("•••• •••123"); null when there is none. */
  text_to?: string | null;
  /**
   * A code was texted already (SMS3): when a text is the only second step,
   * one goes as the password is accepted, so a client that knows only the
   * code box still works — the code goes in it, as `code`.
   */
  text_sent?: boolean;
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
  /**
   * What an owner has limited this viewer to (5.33), in their own words:
   * null for anybody not restricted. Absent from older vaults.
   */
  restriction?: MyRestriction | null;
  /**
   * Of the family, or a guest from outside it (5.34): a guest is a viewer
   * (`role`), always limited (`restriction`), whose sign-in ends at
   * `access_expires_at`. Absent from older vaults: of the family.
   */
  kind?: MemberKind;
  /** When a guest's sign-in ends (A28); null for the family. Absent from older vaults. */
  access_expires_at?: string | null;
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
  /**
   * What an owner has limited them to, in a sentence (5.33, A56-A59): told
   * to owners alone, null for somebody with no limits. Absent for anybody
   * else, and from older vaults.
   */
  restriction?: RestrictionSummary | null;
  /**
   * Of the family, or a guest from outside it (5.34). GET /members lists
   * the family alone (and a guest themselves, to themselves); an owner
   * lists the guests with `?kind=guest`. Absent from older vaults: of the
   * family.
   */
  kind?: MemberKind;
  /**
   * When a guest's sign-in ends (A28): to an owner, and to the guest. Null
   * for the family, and for a guest with no sign-in. Absent from older vaults.
   */
  access_expires_at?: string | null;
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
  /**
   * What a viewer is limited to (5.33): null for a viewer with no limits,
   * and for anybody else. Absent from older vaults.
   */
  access?: MemberAccess | null;
  /** Of the family, or a guest (5.34). Absent from older vaults: of the family. */
  kind?: MemberKind;
  /** When a guest's sign-in ends (A28); null for the family. Absent from older vaults. */
  access_expires_at?: string | null;
}

/**
 * POST /members/{id}/renew (5.34, A28): a guest's sign-in, renewed by an
 * owner to end at `access_expires_at` — in the future, within a year.
 */
export interface GuestRenewal {
  member_id: string;
  access_expires_at: string;
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
 * an owner to turn it back on. Its `role` is shown to confirm, and so is
 * what a restricted viewer may see (5.32): `restriction`, a sentence, or
 * null for somebody with none. Absent from a vault from before 5.32.
 */
export interface PausedSignIn {
  member_id: string;
  display_name: string;
  role: Role;
  paused_at: string;
  restriction?: RestrictionSummary | null;
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

/**
 * The kinds of file the vault keeps, and the extension each is stored
 * under: what a single add, a batch's item and the scanner folder (S3) take,
 * told from the file's own first bytes (a Word or Excel file, a zip inside,
 * by what it says it is).
 */
export const UPLOAD_KINDS: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heic',
  'image/tiff': 'tiff',
  'image/webp': 'webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

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
  /** A viewer's invitation that limits what they will see once they accept (5.33). Absent from older vaults. */
  limited?: boolean;
  /** A guest's invitation (5.34): always a viewer's, limited, with an end. Absent from older vaults. */
  kind?: MemberKind;
  /** When the guest's sign-in will end once accepted; null for the family's. */
  access_expires_at?: string | null;
}

/**
 * The link and the code are in this response and nowhere else — the server
 * keeps only their hashes, so this is the one moment they exist.
 */
export interface CreatedInvitation {
  invitation: Invitation;
  link_token: string;
  code: string;
  /**
   * The code was texted to the number given as `invitee_phone` (0.9.0,
   * SMS3), masked. Nothing else of the number is kept.
   */
  code_texted_to?: string;
  /** It could not be texted, in plain words: the invitation was made, and the code is above. */
  code_text_problem?: string;
}

export interface InvitationPreview {
  household_name: string;
  display_name: string;
  email: string;
  role: Role;
  role_label: string;
  invited_by: string | null;
  expires_at: string;
  /** A guest's (5.34): from outside the family, until `access_expires_at`. Absent from older vaults. */
  kind?: MemberKind;
  access_expires_at?: string | null;
  /**
   * The household's time zone (IANA), which a guest's end is said on (5.34).
   * Absent from older vaults: say it on the browser's clock, and name it.
   */
  timezone?: string;
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
  /**
   * The person asked for a code by text when their password is reset (0.9.0,
   * SMS3): where it goes, masked. POST /password-resets/code texts it, and
   * POST /password-resets/complete takes it as `code`. Null or absent when
   * none is asked for.
   */
  text_code_to?: string | null;
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
   * Since 5.32, `limited`, to an owner and to whoever made it: its maker's
   * access is limited to some documents since, and it lends nothing outside
   * what they may see now; no owner turns it on (`paused_at` is null).
   * Absent from older vaults; treat a reason never heard of as paused.
   */
  paused_at?: string | null;
  /**
   * Since 5.41, `only_me_not_shared`, to an owner and to whoever made it: it
   * sends an Only me document, and the household no longer lets those out;
   * it works again if an owner turns that back on.
   */
  paused_reason?:
    'restored' | 'locked' | 'sign_in_paused' | 'limited' | 'only_me_not_shared' | null;
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
  /**
   * How its code goes (0.9.0, SMS3): by email, or by text to the number its
   * sharer typed (`code_to` is then "•••• •••123"); null when it asks for
   * none or has ended. Absent from older vaults: by email.
   */
  second_factor?: 'email' | 'sms' | null;
  /** It opens in the first browser that opened it, and no other (5.20). */
  this_device_only?: boolean;
  /**
   * The caller made it, it still works (or is only paused or used up), and
   * the vault kept a sealed copy of it as it was made (0.9.0,
   * `features.share_reveal`): `POST /shares/{id}/reveal` shows it again.
   * False for a link made before then, which stays shown once, and for
   * anybody else's. Absent from older vaults: nothing is revealable.
   */
  revealable?: boolean;
  /**
   * The vault can email it to its recipient for the caller (0.9.0,
   * `features.share_link_email`): `revealable`, and the operator's mail
   * server is set. `POST /shares/{id}/email` sends it. Absent from older
   * vaults: nothing is emailed.
   */
  emailable?: boolean;
  /**
   * Where the caller last emailed it, masked (`j•••@e•••.com`): never the
   * address. Null when they have not, and for anybody else's link. Absent
   * from older vaults.
   */
  emailed_to?: string | null;
  summary: string;
}

/**
 * `POST /shares/{id}/email` (0.9.0, `features.share_link_email`; the owner's
 * decision of 13 Nov 2026): the vault emails the link to `to`, through the
 * operator's mail server alone (FDV_SMTP_URL, A21). The email names the
 * household and who shared it, says "a document" or "a collection" (never
 * its title), when the link stops working, and that a PIN or password comes
 * separately: never the PIN, the password or a code. `message`, if given,
 * is the sharer's own short words, sent as plain text: at most 300
 * characters and five lines, with no web address or website name in it
 * (`422 validation_failed`, asked before any step-up).
 *
 * The link's maker alone, and only while `Share.emailable`: `404
 * not_found` for anybody else's, `410 share_ended`, `409 share_paused`
 * for one paused, `409 share_not_revealable` for one made before the vault
 * kept copies, `503
 * email_link_unavailable` without the operator's mail server, `422` for an
 * address that is not one (`isShareAddress`). Within 15 minutes of making
 * the link it asks what making it asked; later, `403 step_up_required`
 * with action `email_share` (any credential). At most 3 a link and 20 an
 * account in a day: `429 email_link_limit`, with `Retry-After`.
 */
export interface ShareEmailInput {
  to: string;
  message?: string;
}

export interface ShareEmailed {
  /** The address, masked, as the list and the activity log say it. */
  sent_to: string;
  sent_at: string;
  /** How many more this link may be emailed today. */
  sends_left: number;
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
  /**
   * 0.9.0 (SMS3), to a vault with `features.sms_codes`: how the code goes —
   * `email` to `code_email`, or `sms` to `recipient_phone`. Absent: by
   * email when there is a `code_email`, as before. A text needs the
   * household's texts set up (`409 sms_not_set_up`).
   */
  second_factor?: 'email' | 'sms';
  /** The recipient's mobile number, for `second_factor: 'sms'`: never shown back but masked. */
  recipient_phone?: string;
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
 * `POST /shares/{id}/reveal` (0.9.0, `features.share_reveal`): a link shown
 * again, to the account that made it and nobody else, after it has
 * confirmed it's them (`403 step_up_required`, action `reveal_share`) —
 * what `CreatedShare` handed over as it was made: the link, and the PIN or
 * the password the vault made up, if it made one (a password the sharer
 * typed is never kept). `404 not_found` for a link the caller did not make
 * or cannot see; `409 share_not_revealable` for one made before the vault
 * kept copies; `410 share_ended` for one taken back, run out of time or
 * stopped by wrong tries. Never cached (`cache-control: no-store`).
 */
export interface RevealedShare {
  link_token: string;
  /** As `CreatedShare.link_url`: null when the vault has no public-only site. */
  link_url: string | null;
  pin?: string;
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
  /** How it went (0.9.0, SMS3): by email, or by text. Absent from older vaults: by email. */
  by?: 'email' | 'sms';
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
  /** A note kept on its own (0.9.0, N1): read on the page. Absent for a file, and from older vaults. */
  note?: boolean;
  /**
   * Where an emailed code goes, masked (`j•••@e•••.com`), when Open asks for
   * one (5.20). The recipient never types an address.
   */
  code_to?: string | null;
  /**
   * How the code comes (0.9.0, SMS3): by email, or by text to a mobile
   * number (`code_to` is then "•••• •••123"). Absent from older vaults, and
   * when it asks for no code: by email.
   */
  code_by?: 'email' | 'sms';
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
  /**
   * A note kept on its own (0.9.0, N1): no file and no pages — its words
   * are read with `GET /shared/items/{id}/note`. Absent for a file, and
   * from older vaults.
   */
  note?: boolean;
}

/** A shared note's words (0.9.0, N1): `GET /shared/items/{id}/note`. */
export interface SharedNote {
  id: string;
  title: string | null;
  /** The note, in @fdv/shared's small Markdown (notes.ts): drawn, never as HTML. */
  body: string;
  updated_at: string;
}

/**
 * A note kept on its own, as a list of them shows it (0.9.0, N1): `GET
 * /notes`. Its preview is its first words as plain text; an Only me note's
 * only for its owner, whose own list this is — nobody else's list has it.
 */
export interface NoteSummary {
  id: string;
  title: string | null;
  preview: string;
  visibility: 'household' | 'adults' | 'private';
  owner_member_id: string | null;
  tags: string[];
  updated_at: string;
  /** When its words last changed (0057); null for a note never written in. */
  notes_updated_at: string | null;
  deleted_at: string | null;
}

export interface NotesList {
  items: NoteSummary[];
  /** More than the list's limit matched: the newest are given. */
  truncated: boolean;
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
   * whenever it answers the profile. Since 0.9.0 (TZ) the zone in effect:
   * the household's own when an owner chose one, else the server's default
   * (FDV_TIMEZONE), else UTC. Every time shown is on it.
   */
  timezone?: string;
  /** Where `timezone` came from (0.9.0, TZ): an owner's choice, or the server's default. Absent from older vaults. */
  timezone_source?: TimeZoneSource;
  /** The server's default zone, FDV_TIMEZONE (UTC unless set): what clearing the family's own returns to. Absent from older vaults. */
  server_timezone?: string;
  owns_home: boolean | null;
  rents_home: boolean | null;
  vehicle_count: number | null;
  has_pets: boolean | null;
  has_business: boolean | null;
  country: string | null;
  answered_at: string | null;
}

/**
 * GET and PUT /household/timezone (0.9.0, TZ): the family's time zone in
 * effect, where it came from, the server's default it falls back to, and
 * whether this reader may change it (an owner).
 */
export interface FamilyTimeZone {
  timezone: string;
  timezone_source: TimeZoneSource;
  server_timezone: string;
  can_change: boolean;
}

export interface DocumentInput {
  type_key?: string | null;
  title?: string | null;
  /** A person: the household's no longer (0.9.0). Null alone leaves `household_owned` as it is. */
  owner_member_id?: string | null;
  /**
   * The household's (0.9.0, `features.household_owner`): true clears the
   * person; false makes it Not sure yet unless a person is sent. Left out,
   * a new document of a household's kind is the household's, and an edit
   * keeps it as it is — so an older client's `owner_member_id: null` never
   * turns a household's document into Not sure yet. Send only to a vault
   * that says `household_owner`; true with a person is refused (422).
   */
  household_owned?: boolean;
  /**
   * Sensitive (0.9.0, AIR2, `features.sensitive_documents`): null as its kind
   * says, true yes, false no. Left out — all an older client can do — the
   * document keeps what it had (a new one: as its kind says). A teen may
   * make a document sensitive, never less so (403, `detail:
   * 'sensitive'`). Send only to a vault that says `sensitive_documents`.
   */
  sensitive?: boolean | null;
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
  /**
   * An edit into Only me (5.41): what becomes of the person's own links that
   * would still send it — `409 links_choice_needed` asks, while there are
   * any. Never on a new document.
   */
  own_links?: 'end' | 'keep';
  /**
   * Sent by an edit card that showed the whole of the document's details
   * (0.9.0, `features.version_details`): what it saves is its newest
   * version's own, confirmed for it. A one-field change (a chip, a tag, a
   * note) never sends it. Refused by older vaults: send it only to one that
   * says `version_details`.
   */
  confirm_details?: true;
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
  /** The household's (0.9.0, `features.household_owner`); absent from older vaults. */
  household_owned?: boolean;
  /**
   * Sensitive as the document says, and all said (0.9.0, AIR2,
   * `features.sensitive_documents`): as `DocumentView`'s. Absent from older vaults.
   */
  sensitive?: boolean | null;
  sensitive_effective?: boolean;
  status: DocumentView['status'];
  /** Who issued it, and when (0.4.10): "Bank statement · Barclays · Sep 2026". */
  issued_by?: string | null;
  issued?: DocumentView['issued'];
  /**
   * When it expires, and its tags (Phase 6): what the document itself
   * says to whoever finds it, for a collection's "Add documents" — its
   * Expires column, and its filter by tag. Absent from older vaults.
   */
  expires?: DocumentView['expires'];
  tags?: string[];
  /** A note with no title, named by its first words as `DocumentView.note_name` (0.9.0, N1). */
  note_name?: string;
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

/**
 * GET /documents/{id}/suggestions (5.37, `features.detail_suggestions`):
 * what its newest version's pages propose for it (`proposeDetails`),
 * worked out for this request and never kept. 'pending' while the vault is
 * still reading the pages; 'unavailable' when there are none it can read
 * (no file yet, a kind of file it does not read, a reading that failed).
 * `proposal` is empty unless 'ready' — and often then too: a page that
 * does not say proposes nothing.
 */
export interface DetailSuggestions {
  state: 'ready' | 'pending' | 'unavailable';
  /**
   * The version whose pages were read: a client offers the proposal only
   * while it is still the document's newest (the 5.37 review), and asks
   * again when a new one is added. Null unless 'ready'.
   */
  version_id: string | null;
  proposal: DetailProposal;
  /**
   * What the same pages read of the fields a renewal changes — its dates,
   * number and issuer — whatever the document holds now (0.9.0,
   * `features.version_details`): only for a version after the first, only
   * for the fields the document has a value for (an empty one is in
   * `proposal`), and only to whoever may change it. `renewalOffers` says
   * which differ. Absent otherwise, and from older vaults.
   */
  renewal?: DetailProposal;
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
  /**
   * Notifications by text (0.9.0, SMS2), each off until the person turns it
   * on, and only ever sent to their own confirmed number: the day's
   * reminders as one text with a count; the security alerts; and a link
   * they shared being opened. Absent from a vault without
   * `features.sms_notifications`.
   */
  daily_text?: boolean;
  alerts_text?: boolean;
  share_opened_text?: boolean;
  /**
   * Their quiet hours on the family's clock, "21:00" to "08:00" until they
   * choose (and may run past midnight; the same for both is none): a text
   * that falls in them waits until they end, unless it is about their own
   * account's safety.
   */
  quiet_from?: string;
  quiet_to?: string;
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
  /**
   * Where a code by text would go to confirm it's them (0.9.0, SMS3),
   * masked: an adult or a teen who asked for codes by text, with a confirmed
   * number, while the household's texts are set up. Null or absent when a
   * text is not offered. It never serves the step-ups of FACTOR_STEP_UPS.
   */
  text_to?: string | null;
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
 * field. Since 5.33, limiting what a viewer can see (`limit_access`), an
 * owner power too — and since 5.34 an owner's invitation that decides it: a
 * viewer who sees every family document, Adults only documents for a viewer
 * or a guest, or limits that replace those already set on that person.
 */
export const FACTOR_STEP_UPS: readonly string[] = [
  'manage_sign_ins',
  'open_identity',
  'identity_audience',
  'limit_access',
  // Since 5.34: renewing a guest's sign-in, or giving one back with a new
  // end (A28) — an owner power too.
  'renew_guest',
  // Since the Phase 5 exit (5.41): an owner writing another person's
  // identity details (their shared part) — an owner power too.
  'change_identity',
  // Since 5.41: whether the household's Only me documents can be shared
  // outside the family (PUT /household/sharing) — an owner power too.
  'only_me_sharing',
];

/**
 * `GET` and `PUT /api/v1/household/sharing` (5.41): whether this household's
 * Only me documents can be shared outside the family — on unless an owner
 * turned it off. Read by owners and adults; changed by an owner, with a
 * passkey or a code (`only_me_sharing`, A54). Turned off, every live link
 * that sent an Only me document is paused, and each link's maker is told
 * how many of theirs; turned back on, those are on again. The answer never
 * counts them: how many links other people had to their Only me documents
 * is theirs to know.
 */
export interface OnlyMeSharing {
  only_me_shareable: boolean;
  can_change: boolean;
}

/**
 * One of the person's own links that would still send a document they are
 * making Only me (5.41), as `409 links_choice_needed` names it in its
 * `detail` (JSON: `LinksChoiceNeeded`): whom it is for, a collection's name
 * for a collection's link, its end, and what it asks for. Never a token.
 */
export interface OwnLinkToEnd {
  id: string;
  kind: 'document' | 'collection';
  recipient_label: string | null;
  collection_name: string | null;
  expires_at: string;
  protection: ShareProtection[];
  /**
   * It ends whichever is chosen (the Phase 5 exit's fourth round): paused
   * after a restore, it waits for an owner to turn it back on, and no owner
   * can see an Only me document of somebody else's. Absent for an owner,
   * who can, and for every other link.
   */
  will_end?: true;
}

/**
 * `409 links_choice_needed`'s `detail`, parsed: the person's own links, and
 * whether keeping them is offered — not while the household shares no Only
 * me documents — and how many links others made stop with it.
 */
export interface LinksChoiceNeeded {
  links: OwnLinkToEnd[];
  keep_allowed: boolean;
  others: number;
}

/**
 * A visibility change's answer: the notice to say now, if any; and, into
 * Only me (5.41), what happened to the links that sent it — the person's
 * own, ended or kept as they chose, and how many of everybody else's
 * stopped. `links` is absent from older vaults, and on any other change.
 */
export interface VisibilityChange {
  notice: { title: string; body: string } | null;
  links?: { yours: number; yours_now: 'ended' | 'kept' | null; others: number };
}

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
