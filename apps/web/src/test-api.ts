import {
  can,
  canChangeDetails,
  canEditIdentity,
  canSee,
  canSeeIdentity,
  IDENTITY_EDIT_REFUSAL,
  IDENTITY_TOO_LONG,
  identityAudienceRank,
  identityChanges,
  identityFilled,
  maskIdentity,
  mergeIdentityWrite,
  revealIdentity,
  type IdentityAudience,
  type IdentityAudienceView,
  type IdentityFields,
  type IdentityPart,
  type IdentityPartView,
  type Visibility,
  canSeeCollection,
  collectionItemHint,
  collectionShareItem,
  COLLECTION_SHARE_REASONS,
  inCollectionAudience,
  guestEndProblem,
  LOCK_MAX_DAYS,
  LOCK_NOTE_MAX,
  maskEmail,
  nextReminder,
  resetCommand,
  reminderOf,
  restrictionSummary,
  roleChangeEffects,
  dropFileName,
  uploadRequestTypes,
  type AccessGrant,
  type DocumentTypeView,
  type MemberAccess,
  type MemberAccount,
  type MyRestriction,
  type OwnerResetResult,
  type ReminderProblem,
  type ResetNotice,
  type Role,
} from '@fdv/shared';
import { vi } from 'vitest';

/**
 * An in-memory stand-in for the API, good enough to drive the screens.
 * Each test starts from `fresh()` and can tweak the state before rendering.
 */

/** What a link made here asks for besides itself (5.20), as the vault says it. */
function factorsOf(b: {
  with_pin?: boolean;
  with_password?: boolean;
  password?: string;
  code_email?: string;
  this_device_only?: boolean;
}) {
  return {
    protection: [
      ...(b.with_pin ? ['pin'] : b.with_password || b.password ? ['password'] : []),
      ...(b.code_email ? ['code'] : []),
    ],
    code_to: b.code_email ? maskEmail(b.code_email) : null,
    this_device_only: b.this_device_only === true,
  };
}

/**
 * The request the page at /drop opens (5.22), as the vault keeps it: what
 * Open asks for, what it takes, and what this browser has sent.
 */
export interface FakeDrop {
  /** False once it is taken back, closed, past its end or locked: link_not_valid. */
  valid: boolean;
  /** Opened as many times as it allows. */
  usedUp?: boolean;
  /** Bound to another browser (this device only). */
  otherDevice?: boolean;
  password?: string | null;
  code?: string | null;
  codeTo?: string;
  codesSent?: number;
  thisDevice?: boolean;
  /** Wrong tries left before it locks; left out, plenty. */
  triesLeft?: number;
  title?: string;
  message?: string | null;
  items: Array<{ id: string; label: string }>;
  accept?: 'standard' | 'office';
  maxFiles?: number;
  maxBytes?: number;
  /** The vault's limit for one file. */
  maxFileBytes?: number;
  expiresAt?: string;
  /** This browser has it open: its cookie names a session that is live. */
  session: boolean;
  /**
   * Which session the browser's cookie names. Each Open makes another under
   * the same cookie name (5.21), so a second Open in one browser leaves the
   * first one's files where nothing can reach them.
   */
  sessionNo?: number;
  opens: number;
  /**
   * Every file in, of every session (all count against the request's room);
   * a session lists, removes and sends only its own, until Finish sends them.
   * A file with no session is the current one's.
   */
  files: Array<{
    id: string;
    name: string;
    content_type: string;
    byte_size: number;
    item_id: string | null;
    session?: number;
    submitted?: boolean;
  }>;
  /** Answer the next this-many calls with 503 busy. */
  busy?: number;
  /** The next this-many GET /drop/session never answer: the connection drops. */
  sessionDrops?: number;
  /** And the next this-many answer 503 busy. */
  sessionBusy?: number;
  /**
   * The browser's cookie under this request's name holds another request's
   * session: a vault before the 5.22 review's N522S-2 answered it as that one.
   */
  foreignSession?: boolean;
  /** What Finish sent. */
  finished?: { note: string | null; files: number };
  closeAfter?: boolean;
}

/** The request's id the page at /drop is given at Open. */
export const DROP_REQUEST_ID = '6f1c2b3a-9d8e-4c7b-8a6f-5e4d3c2b1a10';

export function freshDrop(over: Partial<FakeDrop> = {}): FakeDrop {
  return {
    valid: true,
    items: [
      { id: 'item-w2', label: 'W-2' },
      { id: 'item-1099', label: '1099' },
    ],
    message: 'Everything for the 2025 return, please.\nThe 1099s by Friday.',
    session: false,
    opens: 0,
    files: [],
    ...over,
  };
}

/** A collection of documents as the vault keeps it (0.5.12). The signed-in member is "me". */
export interface FakeCollection {
  id: string;
  name: string;
  description: string | null;
  audience: 'everyone' | 'teens' | 'adults' | 'only_me';
  owner_member_id: string | null;
  etag: string;
  /** The documents in it, by id, in the order they were put there. */
  items: string[];
  /** Shared outside by a link that still works (5.19); left out, it is not. */
  shared_outside?: { with: string[]; following: boolean } | null;
}

export interface FakeState {
  setupRequired: boolean;
  displayName: string;
  members: Array<Record<string, unknown>>;
  invitations: Array<Record<string, unknown> & { id: string }>;
  ownerChanges: Array<Record<string, unknown> & { id: string }>;
  shares: Array<Record<string, unknown> & { id: string }>;
  activity: Array<{
    id: number;
    at: string;
    text: string;
    notable: boolean;
    document_id: string | null;
  }>;
  /** True once the "only you can open this" moment has been shown. */
  privateNoticeShown: boolean;
  /**
   * 5.22: requests to send documents, as GET /upload-requests gives them
   * (UploadRequestView), newest first. Left out, none.
   */
  uploadRequests?: Array<Record<string, unknown> & { id: string }>;
  /** CreatedUploadRequest.link_url: the public-only site's link, when the vault has one. */
  dropLinkUrl?: string | null;
  /** The request the page at /drop opens (5.22); left out, a plain one that works. */
  drop?: FakeDrop;
  /** The password last set through either password route. */
  passwordChanged: string | null;
  /** The address the forgotten-password form was submitted with. */
  forgotFor: string | null;
  resetValid: boolean;
  resetByOperator: boolean;
  /** Set to require a PIN on the shared-document page. */
  sharePin: string | null;
  shareValid: boolean;
  /** Opens counted by /api/v1/shared/unlock (5.16), and whether this browser has one open. */
  shareOpens: number;
  shareSession: boolean;
  /** CreatedShare.link_url: the vault's FDV_PUBLIC_URL link, when it has one (5.16). */
  shareLinkUrl?: string | null;
  /**
   * The link the page at /s opens (5.18): to view or to download, how many
   * opens it has left (null: no limit; 0: used up), how many downloads, and
   * its pages when it is for viewing. Left out: to download, no limits.
   */
  sharePermission?: 'view' | 'download';
  shareOpensLeft?: number | null;
  shareDownloadsLeft?: number | null;
  sharePages?: {
    state: 'drawing' | 'ready' | 'failed';
    shown: number | null;
    total: number | null;
  };
  /** The newest version's kind of file, as GET /documents/{id}/versions says: a PDF when left out. */
  versionMime?: string;
  /** limits.share_max_days in the capability document (5.18 review); left out, not said. */
  shareMaxDays?: number;
  /** Whether this session has downloaded the shared document already (SharedItem.downloaded). */
  shareDownloaded?: boolean;
  /**
   * 5.20: `features.share_second_factor` (left out: said) and
   * `features.share_email_code` — the operator's mail server is set (left
   * out: not). And the link the page at /s opens: its password instead of a
   * PIN, the code it emails (to `shareCodeTo`, masked), whether it is for
   * one device, and whether this browser is another.
   */
  shareSecondFactor?: boolean;
  operatorMail?: boolean;
  sharePassword?: string | null;
  shareCode?: string | null;
  shareCodeTo?: string;
  shareCodesSent?: number;
  /** The vault refuses the address a code would go to (validation_failed on code_email). */
  refuseCodeEmail?: boolean;
  shareDeviceOnly?: boolean;
  shareOtherDevice?: boolean;
  /** How many times /api/v1/shared/items was asked. */
  shareItemsAsked?: number;
  /** Answer the next this-many asks of /api/v1/shared/items with a 503. */
  shareItemsFailing?: number;
  documents: Array<Record<string, unknown>>;
  /** Hold a document's DELETE until this settles (5.1). */
  holdDelete?: Promise<void>;
  /**
   * Hold any request until the promise this gives for it settles (5.4): a
   * slow vault, for what happens on screen meanwhile. Undefined answers
   * at once.
   */
  hold?: (method: string, path: string) => Promise<void> | undefined;
  /**
   * A file sent on the page at /drop (5.22): its answer held until this
   * settles — after every byte has gone, or, with `dropCommitFirst`, with
   * the vault holding the file already while the browser still shows it
   * going (the 5.22 review's Stop pressed too late).
   */
  holdAnswer?: () => Promise<void> | undefined;
  dropCommitFirst?: boolean;
  /** The vault keeps the file, and its answer never reaches the browser (N522W-1). */
  dropAnswerLost?: boolean;
  /** The connection drops before the vault has the file. */
  dropConnectionLost?: boolean;
  /** Every byte goes, and then the connection, before the vault keeps it. */
  dropLostAfterBytes?: boolean;
  /** Answer GET /documents in pages of this many, with a cursor (5.1). */
  pageSize?: number;
  types: Array<Record<string, unknown>>;
  /** GET /document-attributes: the library a type's fields come from (0.5.6). */
  attributes?: Array<Record<string, unknown>>;
  /** GET /document-types/{key}/impact, by key; a kind not here has no documents (5.12). */
  impact?: Record<string, Record<string, unknown>>;
  /**
   * `features.reminder_dates` (0.5.16): a kind reminds from any date it
   * shows. Left out, the vault says it has them, as every vault since.
   */
  reminderDates?: boolean;
  /**
   * The reminders the vault holds, as GET /reminders gives them
   * (ReminderView): `due` ones by `?state=due`, `scheduled` and `snoozed`
   * ones by `?state=upcoming`. Left out, there are none.
   */
  reminders?: Array<Record<string, unknown>>;
  /**
   * The household's time zone, as GET /profile gives it: reminders fall due
   * on its calendar. Left out, 'UTC', the vault's default.
   */
  timezone?: string;
  suggestions: Array<Record<string, unknown>>;
  /** Hits the second pass (FND-08) returns; matched on the snippet text. */
  sealed: Array<Record<string, unknown>>;
  passkeys: Array<{
    id: string;
    label: string | null;
    created_at: string;
    last_used_at: string | null;
    backed_up: boolean | null;
    transports: string[];
  }>;
  lastQuery?: string;
  /** True until a credential has been presented again (SEC-17). */
  stepUpNeeded: boolean;
  /** When an owner's request to remove for good is said to be made (5.24); left out, now. */
  purgeAskedAt?: string;
  /**
   * The owner's view of a sign-in (5.25): whether the signed-in owner has
   * two-step sign-in (left out: they do; false: a password alone, refused
   * the card, A54), each person's card by member id, and whether the card
   * asks for a passkey or a code first (a password does not do).
   */
  twoStep?: boolean;
  accounts?: Record<string, MemberAccount>;
  /**
   * A restricted viewer's restriction in a sentence, by member (5.32): what
   * "After a restore" shows beside a paused sign-in.
   */
  restrictions?: Record<string, string>;
  accountStepUp?: boolean;
  /**
   * `features.member_admin` (5.28): an owner locks and unlocks a sign-in,
   * and turns one a restore paused back on. Left out, the vault says so; a
   * card then says whether it is locked (`suspension`, null when not) and
   * how long a phone keeps its offline copies (`max_offline_days`, 90 when
   * the card does not say). False: a vault from before, whose cards say
   * neither, and whose After a restore lists no sign-ins.
   */
  memberAdmin?: boolean;
  /**
   * A password reset an owner starts (5.29): each POST
   * /members/{id}/password-reset that arrived, and the way it went — the
   * card's `reset_path` (a test sets it), or `resetGoes` when a test says the
   * vault found otherwise as it was done.
   */
  resetsStarted?: Array<{ id: string; body: unknown }>;
  resetGoes?: OwnerResetResult['path'];
  /** GET /me's `reset_notice` (5.29): an owner made a link to hand over for me. */
  resetNotice?: ResetNotice | null;
  /** GET /me's `handover_since` (5.29): when such a link was last used. */
  handoverSince?: string | null;
  /** Who made the reset link the page at /reset shows (5.29); left out, `resetByOperator` says. */
  resetIssuedBy?: 'self' | 'operator' | 'owner';
  /**
   * `features.sign_out_everywhere` (5.30): an owner signs somebody out
   * everywhere. Left out, the vault says so; false, a vault from before.
   */
  signOutEverywhere?: boolean;
  /** Every PATCH /members/{id} that arrived: whose, what, and the If-Match. */
  memberEdits?: Array<{ id: string; body: unknown; ifMatch: string | null }>;
  /**
   * The passport's pages as the vault drew them (0.4.12): how many, or a
   * kind it cannot draw; and how many more times a page is still "being
   * made" before it is ready.
   */
  pagesDrawn: number | 'unsupported';
  pagesPending: number;
  /** The passport's real length, which can be more than is drawn. */
  pageCount: number;
  /**
   * Refresh tokens rotate, and a spent one presented again ends the
   * session — as the real server does. Until 0.4.3 this fake handed back
   * the same token for ever, which is why no test ever caught the web app
   * refreshing twice at once and signing somebody out.
   */
  refreshToken: string;
  spentRefresh: string | null;
  sessionEnded: boolean;
  refreshCalls: number;
  /** Every request but the capability document fails, as if offline. */
  offline: boolean;
  /** False when the link has expired, been used or been revoked. */
  invitationValid: boolean;
  calls: Array<{ method: string; url: string; body?: unknown; headers?: Record<string, string> }>;
  /** Captures that fail as if the connection went, before the next succeeds. */
  captureFailures?: number;
  /** Captures that are stored, and then their answer is lost on the way back. */
  captureAnswersLost?: number;
  /** Upload keys that made a document, for GET /uploads/{key}. */
  uploads?: Record<string, string>;
  /** Every capture that arrived: its form fields in order, and its details. */
  captures?: Array<{ fields: string[]; metadata: Record<string, unknown> | null }>;
  /**
   * Collections of documents (5.15), kept as the vault keeps them (0.5.12).
   * Given, the vault has collections (`features.collections`); left out, it is a vault
   * from before them, and every collection route is unanswered.
   */
  collections?: FakeCollection[];
  /** Answer GET /collections/{id} in pages of this many, with a cursor. */
  collectionPageSize?: number;
  /**
   * People's photos (5.17c): how many GET /members a photo on its way waits
   * for before it is made (1: the next), whether the vault refuses it
   * instead, and every photo sent — its form's fields, in order, and its crop.
   */
  photoReadyAfter?: number;
  photoRefused?: boolean;
  photoUploads?: Array<{
    member: string;
    fields: string[];
    crop: Record<string, number> | null;
  }>;
  /**
   * `features.collection_shares` (5.19): a collection can be shared outside.
   * Left out, the vault says so when it has collections.
   */
  collectionShares?: boolean;
  /**
   * The link the page at /s opens is to a collection (5.19): its name, and
   * the documents it gives now. Left out, it is to one document.
   */
  shareCollection?: {
    name: string | null;
    items: Array<{ id: string; title: string; filename: string }>;
  };
  /**
   * Files sent through a request, waiting to be looked at (5.23), as GET
   * /incoming gives them (IncomingFileView). Given, the vault says it has
   * upload requests (`features.upload_requests`); filing one makes a
   * document here, refusing one takes it away.
   */
  incoming?: Array<Record<string, unknown>>;
  /**
   * GET /documents/{id}/issuer-suggestions, by document id: who its pages
   * say issued it. A document not here answers 'unavailable'.
   */
  issuerSuggestions?: Record<
    string,
    {
      state: 'ready' | 'pending' | 'unavailable';
      items: Array<{ value: string; source: 'known' | 'page' }>;
    }
  >;
  /**
   * People's identity details (5.27, over 5.26's API), by member id: each
   * part's fields, as the vault keeps them sealed, and its version. Given,
   * the vault says it keeps them (`features.member_identity`). The one
   * signed in is "me"; another person's Only me part is not there for them.
   */
  identities?: Record<
    string,
    Partial<Record<IdentityPart, { fields: IdentityFields; version: number }>>
  >;
  /** Who reads other people's shared identity details (A34); left out, the narrowest. */
  identityAudience?: IdentityAudience;
  /** A wider audience waiting its 72 hours. */
  identityPending?: IdentityAudienceView['pending'];
  /**
   * A PUT is refused as too long (422), as the vault refuses a part over
   * 128 KiB: every one, or only that part's.
   */
  identityTooLong?: boolean | IdentityPart;
  /** People with a sign-in who cannot sign in to be told of a wider audience: 409. */
  cannotBeTold?: string[];
  /**
   * `features.access_restrictions` (5.33): an owner limits what a viewer can
   * see. Left out, the vault says so; false, a vault from before.
   */
  accessRestrictions?: boolean;
  /** GET /me's `restriction` (5.33): what an owner limited me to. */
  myRestriction?: MyRestriction | null;
  /**
   * 5.34: GET /me's `kind` and `access_expires_at` (left out: of the
   * family), and the people outside the family, as GET /members?kind=guest
   * answers an owner. Each renewal (POST /members/{id}/renew) arrives in
   * `renewals`.
   */
  myKind?: 'family' | 'guest';
  myAccessEnd?: string | null;
  guests?: Array<Record<string, unknown> & { id: string }>;
  renewals?: Array<{ member_id: string; access_expires_at: string }>;
  /** What an invitation link's preview says over the usual one (5.34: a guest's). */
  invitationPreview?: Record<string, unknown>;
  /** Whom DELETE /members/{id}/sessions signed out everywhere, in order. */
  signedOut?: string[];
  /** People who keep Only me documents (5.33): limiting them asks the owner first. */
  keepsPrivate?: string[];
  /** Every PUT and DELETE /members/{id}/access that arrived, in order (5.33). */
  accessWrites?: Array<{ id: string; method: string; body: unknown }>;
  /** What putting documents in a collection says of who else will see them (5.33). */
  collectionWarnings?: string[];
}

export const TOKENS = {
  access_token: 'a.b.c',
  expires_in: 900,
  refresh_token: 'hh.secret',
  refresh_expires_in: 1,
  household_id: 'hh',
  member_id: 'me',
  role: 'owner',
  scopes_unlocked: ['household', 'adults', 'member'],
};

export const ME = {
  id: 'me',
  display_name: 'Mansoor Seikh',
  date_of_birth: null,
  relationship: null,
  is_deceased: false,
  colour: 0,
  has_account: true,
  role: 'owner',
  is_me: true,
  document_count: 1,
  photo: null,
  photo_status: null,
  can_change_photo: true,
};

export const PASSPORT = {
  id: 'doc-1',
  type_key: 'passport',
  title: "Mansoor's passport",
  owner_member_id: 'me',
  category: 'identity',
  visibility: 'household',
  issued: { date: '2021-03-14', precision: 'day' },
  expires: { date: '2031-03-31', precision: 'month' },
  identifier: '563914782',
  physical_location: 'Bedroom safe, top shelf',
  is_essential: true,
  tags: ['travel'],
  notes: null,
  extra: {},
  status: { value: 'active', label: 'Valid for 4 years 6 months' },
  versions: 1,
  latest_version_id: 'v-1',
  created_at: '2026-09-20T09:14:00Z',
  updated_at: '2026-09-20T09:14:00Z',
  deleted_at: null,
  // Filed by whoever is signed in (A72: a teen changes who sees only these).
  filed_by_me: true,
  etag: '"abc"',
};

/** A type named for who issued it: "Barclays statement, September 2026" (0.4.10). */
export const BANK_STATEMENT = {
  key: 'bank_statement',
  label: 'Bank / investment statement',
  category: 'financial',
  fields: [],
  expiry_driver: null,
  reminder_leads: [],
  usually_essential: false,
  default_visibility: 'adults',
  issued_by_label: 'Institution',
};

export const TYPES = [
  {
    key: 'passport',
    label: 'Passport',
    category: 'identity',
    fields: [],
    expiry_driver: 'expires_on',
    reminder_leads: [270, 180],
    usually_essential: true,
    default_visibility: 'household',
    issued_by_label: 'Issuing country',
  },
  {
    key: 'birth_certificate',
    label: 'Birth certificate',
    category: 'identity',
    fields: [],
    expiry_driver: null,
    reminder_leads: [],
    usually_essential: true,
    default_visibility: 'household',
    issued_by_label: null,
  },
  BANK_STATEMENT,
];

/** A statement from Barclays, for September 2026. */
export const STATEMENT = {
  ...PASSPORT,
  id: 'doc-2',
  type_key: 'bank_statement',
  title: 'Barclays statement, September 2026',
  category: 'financial',
  visibility: 'adults',
  issued: { date: '2026-09-30', precision: 'month' },
  expires: null,
  identifier: null,
  issued_by: 'Barclays',
  physical_location: null,
  is_essential: false,
  tags: [],
  status: { value: 'valid', label: 'Filed' },
  latest_version_id: 'v-2',
  etag: '"statement"',
};

/** A passkey already enrolled on some device. */
export const PASSKEY = {
  id: 'pk-1',
  label: "Mansoor's phone",
  created_at: '2026-09-20T09:14:00Z',
  last_used_at: null,
  backed_up: true,
  transports: ['internal'],
};

/** A hit that only the owner's own session can see. */
export const SEALED_HIT = {
  document_id: 'doc-sealed',
  title: 'Notes to myself',
  type_key: null,
  category: null,
  owner_member_id: 'me',
  status: { value: 'active', label: 'Filed' },
  snippet: 'Ask about the <em>estate</em> agent in March',
  matched_in: 'content',
  rank: 0,
};

/** A child in the household: the person a per-member suggestion is about. */
export const AISHA = {
  ...ME,
  id: 'm-0',
  display_name: 'Aisha',
  date_of_birth: '2016-04-02',
  is_me: false,
  has_account: false,
  role: null,
  colour: 1,
  document_count: 0,
};

/** A missing-document suggestion, as GET /suggestions returns it. */
export const MISSING_BIRTH_CERTIFICATE = {
  key: 'minor_needs_birth_certificate:m-0',
  rule_key: 'minor_needs_birth_certificate',
  member_id: 'm-0',
  member_name: 'Aisha',
  type_key: 'birth_certificate',
  type_label: 'Birth certificate',
  title: 'No birth certificate for Aisha',
  why: 'Schools, passports and benefits all ask for it.',
  missing: 1,
  dismissed: false,
};

export function fresh(over: Partial<FakeState> = {}): FakeState {
  return {
    setupRequired: false,
    refreshToken: 'hh.secret',
    spentRefresh: null,
    sessionEnded: false,
    refreshCalls: 0,
    offline: false,
    displayName: 'The Seikh family',
    members: [ME],
    invitations: [],
    ownerChanges: [],
    shares: [],
    activity: [],
    privateNoticeShown: false,
    passwordChanged: null,
    forgotFor: null,
    resetValid: true,
    resetByOperator: false,
    sharePin: null,
    shareValid: true,
    shareOpens: 0,
    shareSession: false,
    documents: [PASSPORT],
    types: TYPES,
    suggestions: [],
    sealed: [],
    passkeys: [],
    stepUpNeeded: false,
    pagesDrawn: 2,
    pagesPending: 0,
    pageCount: 2,
    invitationValid: true,
    calls: [],
    ...over,
  };
}

/** A person as GET /members answers one since 5.25: their version, and whether the reader may change them. */
function withDetails(m: Record<string, unknown>) {
  return {
    ...m,
    version: (m.version as number | undefined) ?? 1,
    can_edit:
      (m.can_edit as boolean | undefined) ??
      canChangeDetails(
        { role: storedRole() as Role, memberId: 'me' },
        {
          id: String(m.id),
          role: (m.role as 'owner' | 'adult' | 'teen' | 'viewer' | null) ?? null,
        },
      ),
  };
}

export function installFakeApi(state: FakeState) {
  const json = (body: unknown, status = 200) => Promise.resolve(Response.json(body, { status }));
  const refuse = (status: number, code: string, message: string, more: object = {}) =>
    json({ error: { code, message, retriable: false, request_id: 'r', ...more } }, status);
  /** SEC-17, as the vault asks it, saying what the credential is for. */
  const stepUp = (action: 'open_private_document' | 'open_essential' | 'widen_type_visibility') =>
    refuse(
      403,
      'step_up_required',
      `Please confirm it is you ${
        {
          open_private_document: 'to open a document only you can see',
          open_essential: 'to open an Essential document',
          widen_type_visibility: 'to let more people see a kind of document',
        }[action]
      }.`,
      { action },
    );
  /** What opening a document asks for: "only me" first, then Essentials. */
  const askedToOpen = (doc: Record<string, unknown> | undefined) =>
    doc?.visibility === 'private'
      ? ('open_private_document' as const)
      : doc?.is_essential
        ? ('open_essential' as const)
        : null;
  /**
   * What taking a check away asks for (5.4): out of "only me", what opening
   * it asks; Essential turned off, what opening an Essential asks.
   */
  const askedToLoosen = (
    doc: Record<string, unknown> | undefined,
    change: { visibility?: unknown; is_essential?: unknown },
  ) =>
    change.visibility !== undefined &&
    change.visibility !== 'private' &&
    doc?.visibility === 'private'
      ? ('open_private_document' as const)
      : change.is_essential === false && doc?.is_essential
        ? ('open_essential' as const)
        : null;
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const path = url.split('?')[0] ?? url;
    const query = new URLSearchParams(url.split('?')[1] ?? '');
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    state.calls.push({ method, url, body, headers: init?.headers as Record<string, string> });
    const held = state.hold?.(method, path);
    const answer = () => respond(url, method, path, query, body, init);
    return held ? held.then(answer) : answer();
  });

  const respond = (
    url: string,
    method: string,
    path: string,
    query: URLSearchParams,
    body: unknown,
    init?: RequestInit,
  ): Promise<Response> => {
    if (state.offline && path !== '/api/v1/capabilities') {
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    if (path === '/api/v1/capabilities') {
      return json({
        product: 'family-document-vault',
        server_version: '0.1.5',
        api_version: 1,
        min_client_version: '0.0.1',
        edition: 'self_hosted',
        protection_mode: 'standard',
        setup_required: state.setupRequired,
        features: {
          passkeys: true,
          custom_types: true,
          ...(state.collections ? { collections: true } : {}),
          ...(state.collections && state.collectionShares !== false
            ? { collection_shares: true }
            : {}),
          reminder_dates: state.reminderDates ?? true,
          share_options: true,
          share_second_factor: state.shareSecondFactor ?? true,
          share_email_code: state.operatorMail === true,
          member_edit: true,
          ...(state.memberAdmin !== false ? { member_admin: true } : {}),
          ...(state.signOutEverywhere !== false ? { sign_out_everywhere: true } : {}),
          ...(state.incoming ? { upload_requests: true } : {}),
          ...(state.identities ? { member_identity: true } : {}),
          ...(state.accessRestrictions !== false ? { access_restrictions: true } : {}),
          // Someone outside the family (5.34): said when a test gives guests.
          ...(state.guests ? { guests: true } : {}),
        },
        limits: state.shareMaxDays ? { share_max_days: state.shareMaxDays } : {},
        deprecations: [],
        branding: { display_name: state.displayName },
      });
    }
    if (path === '/api/v1/setup' && method === 'POST') {
      state.setupRequired = false;
      state.displayName = (body as { household_name: string }).household_name;
      return json(TOKENS, 201);
    }
    if (path === '/api/v1/auth/password') {
      state.refreshToken = TOKENS.refresh_token;
      state.spentRefresh = null;
      state.sessionEnded = false;
      return json(TOKENS);
    }
    if (path === '/api/v1/auth/refresh') {
      state.refreshCalls++;
      const presented = (body as { refresh_token: string }).refresh_token;
      if (presented === state.spentRefresh) state.sessionEnded = true;
      if (state.sessionEnded || presented !== state.refreshToken) {
        return json(
          {
            error: {
              code: 'session_ended',
              message: 'That session has ended. Sign in again.',
              retriable: false,
              request_id: 'r',
            },
          },
          401,
        );
      }
      state.spentRefresh = presented;
      state.refreshToken = `hh.secret.${state.refreshCalls}`;
      // The real server decides the role from the session, not the client,
      // so refreshing must not hand back a role the test did not sign in as.
      return json({ ...TOKENS, refresh_token: state.refreshToken, role: storedRole() });
    }
    if (path === '/api/v1/me')
      return json({
        account_id: 'a',
        household_id: 'hh',
        member_id: 'me',
        role: storedRole(),
        totp_enabled: state.twoStep !== false,
        totp_required: state.twoStep === false && storedRole() === 'owner',
        reset_notice: state.resetNotice ?? null,
        handover_since: state.handoverSince ?? null,
        restriction: state.myRestriction ?? null,
        kind: state.myKind ?? 'family',
        access_expires_at: state.myAccessEnd ?? null,
      });
    if (path === '/api/v1/me/reset-notice' && method === 'DELETE') {
      state.resetNotice = null;
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (path === '/api/v1/auth/sessions') return json({ items: [] });
    if (path === '/api/v1/auth/passkeys' && method === 'GET')
      return json({ items: state.passkeys });
    if (path.startsWith('/api/v1/auth/passkeys/') && method === 'DELETE') {
      const id = path.slice('/api/v1/auth/passkeys/'.length);
      state.passkeys = state.passkeys.filter((k) => k.id !== id);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (path === '/api/v1/exports' && method === 'POST') {
      // SEC-17: the first attempt asks who is asking, until a credential
      // has been presented.
      if (state.stepUpNeeded) {
        return json(
          {
            error: {
              code: 'step_up_required',
              message: 'Please confirm it is you to export everything.',
              action: 'export_everything',
              retriable: false,
              request_id: 'r',
            },
          },
          403,
        );
      }
      return json({ id: 'ex-1', state: 'queued' }, 202);
    }
    if (path === '/api/v1/auth/step-up' && method === 'POST') {
      const b = body as { password?: string; code?: string };
      // A code from the authenticator app (5.25): what the owner's powers ask.
      if (b?.code !== undefined) {
        if (b.code !== '123456') {
          return json(
            {
              error: {
                code: 'invalid_credentials',
                message: "That didn't match.",
                retriable: false,
                request_id: 'r',
              },
            },
            401,
          );
        }
        state.stepUpNeeded = false;
        state.accountStepUp = false;
        return json({ verified_at: new Date().toISOString(), expires_in: 300 });
      }
      if (b?.password !== 'correct horse battery') {
        return json(
          {
            error: {
              code: 'invalid_credentials',
              message: "That didn't match.",
              retriable: false,
              request_id: 'r',
            },
          },
          401,
        );
      }
      state.stepUpNeeded = false;
      return json({ verified_at: new Date().toISOString(), expires_in: 300 });
    }
    if (path === '/api/v1/auth/step-up') return json({ verified_at: null, expires_in: 0 });
    if (path === '/api/v1/exports') return json({ items: [] });
    if (path === '/api/v1/reminders') {
      // As the vault lists them: due, or coming up (scheduled, snoozed).
      const want = query.get('state') ?? 'all';
      const items = (state.reminders ?? []).filter((r) =>
        want === 'due'
          ? r.status === 'due'
          : want === 'upcoming'
            ? r.status === 'scheduled' || r.status === 'snoozed'
            : ['scheduled', 'due', 'snoozed'].includes(String(r.status)),
      );
      return json({ items });
    }
    const reminderAt = /^\/api\/v1\/reminders\/([^/]+)\/(snooze|acknowledge)$/.exec(path);
    if (reminderAt && method === 'POST') {
      const r = (state.reminders ?? []).find((x) => x.id === reminderAt[1]);
      if (!r) return refuse(404, 'not_found', 'That reminder does not exist.');
      if (reminderAt[2] === 'acknowledge') Object.assign(r, { status: 'acknowledged' });
      else {
        const until = (body as { until: string }).until;
        Object.assign(r, { status: 'snoozed', snoozed_until: until, label: `Later · ${until}` });
      }
      return json(r);
    }
    if (path === '/api/v1/suggestions') {
      const dismissed = query.get('dismissed') === 'true';
      const items = state.suggestions.filter((x) => Boolean(x.dismissed) === dismissed);
      return json({
        items,
        profile_answered: true,
        dismissed_count: state.suggestions.filter((x) => x.dismissed).length,
      });
    }
    if (path.startsWith('/api/v1/suggestions/') && path.endsWith('/dismiss')) {
      const key = decodeURIComponent(path.slice('/api/v1/suggestions/'.length, -'/dismiss'.length));
      const row = state.suggestions.find((x) => x.key === key);
      if (row) row.dismissed = method === 'POST';
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (path === '/api/v1/notifications/push-key')
      return json({ public_key: null, enabled: false });
    if (path === '/api/v1/notifications/preferences')
      return json({ daily_push: true, daily_email: false, weekly_email: true });
    if (path === '/api/v1/devices') return json({ items: [] });
    if (path === '/api/v1/notifications/smtp')
      return json({ configured: false, status: 'untested', secure: false });
    if (path === '/api/v1/notifications/smtp/providers') return json([]);
    if (path === '/api/v1/profile' && method === 'PUT')
      return json({ household_name: state.displayName, ...(body as object) });
    if (path === '/api/v1/profile') {
      // Every role reads the household's name and time zone.
      return json({
        household_name: state.displayName,
        timezone: state.timezone ?? 'UTC',
        owns_home: null,
        rents_home: null,
        vehicle_count: null,
        has_pets: null,
        has_business: null,
        country: null,
        answered_at: null,
      });
    }
    // The people outside the family (5.34): an owner's to list.
    if (path === '/api/v1/members' && method === 'GET' && query.get('kind') === 'guest') {
      if (storedRole() !== 'owner') {
        return refuse(403, 'forbidden', 'Only an owner sees the people outside the family.');
      }
      return json({ items: state.guests ?? [] });
    }
    // A guest's sign-in renewed (5.34), refused in the vault's order.
    const renewAt = /^\/api\/v1\/members\/([^/]+)\/renew$/.exec(path);
    if (renewAt && method === 'POST') {
      if (storedRole() !== 'owner') {
        return refuse(403, 'forbidden', 'Only an owner can change what someone is allowed to do.');
      }
      if (state.twoStep === false) {
        return refuse(
          403,
          'totp_required_for_owner',
          "Turn on two-step sign-in to renew a guest's sign-in.",
        );
      }
      if (state.accountStepUp) {
        return refuse(
          403,
          'step_up_required',
          "Please confirm it is you to renew a guest's sign-in.",
          {
            action: 'renew_guest',
          },
        );
      }
      const b = body as { access_expires_at: string };
      const g = (state.guests ?? []).find((x) => x.id === renewAt[1]);
      if (!g) return refuse(404, 'not_found', 'They have no sign-in to renew.');
      g.access_expires_at = b.access_expires_at;
      (state.renewals ??= []).push({ member_id: g.id, access_expires_at: b.access_expires_at });
      return json({ member_id: g.id, access_expires_at: b.access_expires_at });
    }
    if (path === '/api/v1/members' && method === 'GET') {
      // The worker, as far as this vault has one (5.17c): a photo on its
      // way is made once it has been asked about `photoReadyAfter` times.
      for (const m of state.members) {
        if (m.photo_status !== 'processing') continue;
        const asked = ((m.photo_asks as number | undefined) ?? 0) + 1;
        m.photo_asks = asked;
        if (asked < (state.photoReadyAfter ?? 1)) continue;
        if (state.photoRefused) Object.assign(m, { photo_status: 'failed' });
        else {
          Object.assign(m, { photo: { id: `p-${String(m.id)}-${asked}` }, photo_status: null });
        }
      }
      return json({ items: state.members.map(withDetails) });
    }
    // People's identity details (5.26's API, for 5.27): masked as the
    // vault masks them; a reveal asks who is asking — somebody else's with a
    // passkey or a code, refused outright without two-step sign-in.
    const me = { role: storedRole() as Role, memberId: 'me' };
    const audienceNow = (): IdentityAudience => {
      const waiting = state.identityPending;
      if (waiting && Date.parse(waiting.notice_until) <= Date.now()) {
        state.identityAudience = waiting.to;
        state.identityPending = null;
      }
      return state.identityAudience ?? 'owners_and_self';
    };
    if (state.identities && path === '/api/v1/household/identity-audience') {
      const view = (): IdentityAudienceView => ({
        audience: audienceNow(),
        pending: state.identityPending ?? null,
        can_change: can(me.role, 'identity.audience'),
      });
      if (method === 'GET') return json(view());
      if (!can(me.role, 'identity.audience')) {
        return refuse(403, 'forbidden', 'Only an owner can change who sees identity details.');
      }
      if (state.twoStep === false) {
        return refuse(
          403,
          'totp_required_for_owner',
          'Turn on two-step sign-in to change who can see identity details.',
        );
      }
      if (state.stepUpNeeded) {
        return refuse(
          403,
          'step_up_required',
          'Please confirm it is you to change who can see identity details.',
          { action: 'identity_audience' },
        );
      }
      const to = (body as { audience: IdentityAudience }).audience;
      const now = audienceNow();
      if (identityAudienceRank(to) <= identityAudienceRank(now)) {
        state.identityAudience = to;
        state.identityPending = null;
      } else if (state.identityPending?.to !== to) {
        if ((state.cannotBeTold ?? []).length > 0) {
          return refuse(
            409,
            'member_cannot_be_told',
            `${(state.cannotBeTold ?? []).join(', ')} cannot sign in just now, so could not be told, or mark anything Only me first. Let more people see identity details once everybody can sign in.`,
          );
        }
        state.identityPending = {
          to,
          requested_at: new Date().toISOString(),
          notice_until: new Date(Date.now() + 72 * 3_600_000).toISOString(),
        };
      }
      return json(view());
    }
    const identityAt = /^\/api\/v1\/members\/([^/]+)\/identity(\/reveal)?$/.exec(path);
    if (state.identities && identityAt) {
      const id = identityAt[1] as string;
      const self = id === me.memberId;
      const nobody = () => refuse(404, 'not_found', 'That page does not exist.');
      if (!state.members.some((m) => m.id === id)) return nobody();
      const audience = audienceNow();
      if (!canSeeIdentity(me, { id }, audience)) return nobody();
      const record = (state.identities[id] ??= {});
      const visible = (docId: string) => {
        const doc = state.documents.find((d) => d.id === docId);
        return doc
          ? canSee(me, doc as { visibility: Visibility; owner_member_id: string | null })
          : false;
      };
      const partView = (part: IdentityPart): IdentityPartView => {
        const fields = record[part]?.fields ?? {};
        // A government ID's document, only to a reader who may see it.
        const linked: IdentityFields = fields.ids
          ? {
              ...fields,
              ids: fields.ids.map((i) => {
                if (!i.document_id || visible(i.document_id)) return i;
                const unlinked = { ...i };
                delete unlinked.document_id;
                return unlinked;
              }),
            }
          : fields;
        const masked = maskIdentity(linked);
        return {
          fields: masked.fields,
          masked: masked.masked,
          filled: identityFilled(fields),
          version: record[part]?.version ?? 0,
          updated_at: record[part] ? '2026-10-01T09:00:00Z' : null,
        };
      };
      const view = () => ({
        member_id: id,
        audience,
        can_edit: {
          shared: canEditIdentity(me, { id }, 'shared'),
          only_me: canEditIdentity(me, { id }, 'only_me'),
        },
        versions: {
          shared: record.shared?.version ?? 0,
          only_me: self ? (record.only_me?.version ?? 0) : null,
        },
        shared: partView('shared'),
        only_me: self ? partView('only_me') : null,
      });
      if (identityAt[2]) {
        const b = body as { part?: IdentityPart; keys: string[] };
        const part = b.part ?? 'shared';
        if (part === 'only_me' && !self) return nobody();
        if (!self && state.twoStep === false) {
          return refuse(
            403,
            me.role === 'owner' ? 'totp_required_for_owner' : 'two_step_required',
            'Turn on two-step sign-in to see another person’s identity numbers.',
          );
        }
        if (state.stepUpNeeded) {
          return refuse(
            403,
            'step_up_required',
            self
              ? 'Please confirm it is you to see your identity numbers.'
              : 'Please confirm it is you to see another person’s identity numbers.',
            { action: self ? 'reveal_identity' : 'open_identity' },
          );
        }
        return json({ part, values: revealIdentity(record[part]?.fields ?? {}, b.keys) });
      }
      if (method === 'GET') return json(view());
      const b = body as { part: IdentityPart; version: number; fields: IdentityFields };
      if (b.part === 'only_me' && !self) return nobody();
      if (!canEditIdentity(me, { id }, b.part)) {
        return refuse(403, 'forbidden', IDENTITY_EDIT_REFUSAL);
      }
      const kept = record[b.part];
      const version = kept?.version ?? 0;
      if (b.version !== version) {
        return refuse(
          409,
          'conflict',
          'Someone else changed these details. Reload and try again.',
          {
            detail: JSON.stringify({ part: b.part, version }),
          },
        );
      }
      // As the vault checks a part (identity.ts): one id once a list, and a
      // contact with its value.
      for (const list of ['emails', 'phones', 'addresses', 'ids', 'custom'] as const) {
        const ids = ((b.fields[list] ?? []) as Array<{ id: string }>).map((e) => e.id);
        if (new Set(ids).size !== ids.length) {
          return refuse(422, 'validation_failed', 'Each entry in a list has an id of its own.');
        }
      }
      for (const c of [...(b.fields.emails ?? []), ...(b.fields.phones ?? [])]) {
        if (typeof c.value !== 'string' || c.value.trim() === '') {
          return refuse(
            422,
            'validation_failed',
            'Invalid input: expected string, received undefined',
          );
        }
      }
      if (state.identityTooLong === true || state.identityTooLong === b.part) {
        return refuse(422, 'validation_failed', IDENTITY_TOO_LONG);
      }
      const next = mergeIdentityWrite(kept?.fields ?? {}, b.fields, visible);
      if (identityChanges(kept?.fields ?? {}, next).length > 0) {
        record[b.part] = { fields: next, version: version + 1 };
      }
      return json(view());
    }
    // An owner power over somebody else's sign-in (A54): an owner with
    // neither two-step sign-in nor a passkey is refused; otherwise it asks
    // for a passkey or a code, until one has been given. Null: go ahead.
    const ownerPower = () => {
      if (state.twoStep === false) {
        return refuse(
          403,
          'totp_required_for_owner',
          "Turn on two-step sign-in to manage other people's sign-ins.",
        );
      }
      if (state.accountStepUp) {
        return refuse(
          403,
          'step_up_required',
          "Please confirm it is you to manage other people's sign-ins.",
          { action: 'manage_sign_ins' },
        );
      }
      return null;
    };
    // Locking a sign-in, unlocking it, and turning one a restore paused back
    // on (5.28), refused in the vault's order: who may, the owner power,
    // then the person.
    const lockAt = /^\/api\/v1\/members\/([^/]+)\/(lock|resume)$/.exec(path);
    if (lockAt && state.memberAdmin !== false) {
      const id = lockAt[1] as string;
      const resuming = lockAt[2] === 'resume';
      if (method !== 'POST' && (resuming || method !== 'DELETE')) {
        return refuse(405, 'method_not_allowed', 'Not here.');
      }
      if (storedRole() !== 'owner') {
        return refuse(
          403,
          'forbidden',
          resuming
            ? 'Only an owner can turn things back on after a restore.'
            : "Only an owner can lock or unlock someone's sign-in.",
        );
      }
      const locking = !resuming && method === 'POST';
      const b = (body ?? {}) as Record<string, unknown>;
      if (locking) {
        const unknown = Object.keys(b).filter((k) => !['until', 'end_links', 'note'].includes(k));
        if (unknown.length > 0) {
          return refuse(422, 'validation_failed', `Unrecognized key: "${unknown[0]}"`);
        }
        if (typeof b.note === 'string' && b.note.trim().length > LOCK_NOTE_MAX) {
          return refuse(
            422,
            'validation_failed',
            `A note can be ${LOCK_NOTE_MAX} characters at most.`,
          );
        }
        if (
          b.until != null &&
          (typeof b.until !== 'string' || Number.isNaN(new Date(b.until).getTime()))
        ) {
          return refuse(422, 'validation_failed', 'Invalid datetime');
        }
      }
      const power = ownerPower();
      if (power) return power;
      const card = state.accounts?.[id];
      if (!card) return refuse(404, 'not_found', 'They have no sign-in to lock.');
      const named = state.members.find((m) => m.id === id)?.display_name;
      const name = typeof named === 'string' ? named : 'They';
      const now = card.suspension ?? null;
      if (resuming) {
        if (now?.reason !== 'restored') {
          return refuse(409, 'not_paused', `${name}'s sign-in is not waiting after a restore.`);
        }
        card.suspension = null;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (method === 'DELETE') {
        if (now?.reason !== 'locked') {
          return refuse(409, 'not_locked', `${name}'s sign-in is not locked.`);
        }
        card.suspension = null;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (id === 'me') {
        return refuse(422, 'validation_failed', 'You cannot lock your own sign-in.');
      }
      if (card.role === 'owner') {
        return refuse(
          409,
          'owner_notice_required',
          `${name} is an owner, and one owner's sign-in is never locked by another. Ask for their role to be changed first — that takes seven days, and they are told about it.`,
        );
      }
      if (now?.reason === 'locked') {
        return refuse(
          409,
          'already_locked',
          `${name}'s sign-in is locked already. Unlock it first to lock it differently.`,
        );
      }
      const until = typeof b.until === 'string' ? new Date(b.until) : null;
      if (until && until.getTime() <= Date.now()) {
        return refuse(422, 'validation_failed', 'Choose a time in the future to unlock.');
      }
      if (until && until.getTime() > Date.now() + LOCK_MAX_DAYS * 864e5) {
        return refuse(
          422,
          'validation_failed',
          'A lock can end by itself within a year at most. Leave the end out to keep it until you unlock it.',
        );
      }
      // Signed out everywhere: their devices go with their sessions.
      card.suspension = {
        reason: 'locked',
        since: new Date().toISOString(),
        until: until?.toISOString() ?? null,
        note: typeof b.note === 'string' && b.note.trim() ? b.note.trim() : null,
        by: ME.display_name,
      };
      card.devices = [];
      return json({ member_id: id, suspension: card.suspension });
    }
    // A password reset an owner starts (5.29), refused in the vault's order:
    // who may, what was sent, the owner power, then the person.
    const resetAt = /^\/api\/v1\/members\/([^/]+)\/password-reset$/.exec(path);
    if (resetAt && method === 'POST') {
      const id = resetAt[1] as string;
      if (storedRole() !== 'owner') {
        return refuse(403, 'forbidden', "Only an owner can start a reset of someone's password.");
      }
      const b = (body ?? {}) as Record<string, unknown>;
      if (Object.keys(b).some((k) => k !== 'stop_now')) {
        return refuse(422, 'validation_failed', 'Unrecognized key');
      }
      const power = ownerPower();
      if (power) return power;
      const card = state.accounts?.[id];
      if (!card) return refuse(404, 'not_found', 'They have no sign-in to reset.');
      const named = state.members.find((m) => m.id === id)?.display_name;
      const name = typeof named === 'string' ? named : 'They';
      if (card.role === 'owner') {
        return refuse(
          409,
          'owner_notice_required',
          `${name} is an owner, and one owner's password is never reset by another. Ask for their role to be changed first — that takes seven days, and they are told about it.`,
        );
      }
      if (card.suspension) {
        return refuse(
          409,
          'locked',
          `${name}'s sign-in is locked. Unlock it first, then reset their password.`,
        );
      }
      state.resetsStarted = [...(state.resetsStarted ?? []), { id, body: b }];
      const goes = state.resetGoes ?? card.reset_path ?? 'operator';
      const stopNow = b.stop_now === true;
      if (stopNow && goes === 'operator') {
        return refuse(
          409,
          'stop_now_unavailable',
          `${name}'s password can't be stopped from here: no link to set a new one can reach them on this vault. Lock their sign-in to keep them out, and ask whoever runs the server for a reset.`,
        );
      }
      if (stopNow) card.devices = [];
      const until = new Date(Date.now() + 36e5).toISOString();
      const answer: OwnerResetResult = { member_id: id, path: goes, stop_now: stopNow };
      if (goes !== 'operator') answer.expires_at = until;
      if (goes === 'handover') {
        answer.link = 'http://vault.example/reset#hHhHhHhHhHhHhHhHhHhHhHhHhHhHhHhHhHhHhHhHhHh';
      }
      if (goes === 'operator') answer.command = resetCommand(card.email);
      return json(answer);
    }
    // What a viewer can see (5.33), refused in the vault's order: who may,
    // what was sent, the owner power (limit_access), then the person.
    const accessAt = /^\/api\/v1\/members\/([^/]+)\/access(\/preview)?$/.exec(path);
    if ((accessAt || path === '/api/v1/access/preview') && state.accessRestrictions !== false) {
      const id = accessAt ? (accessAt[1] as string) : null;
      if (!accessAt || accessAt[2]) {
        if (method !== 'GET') return refuse(404, 'not_found', 'Not here.');
        const list = (k: string) => (query.get(k) ?? '').split(',').filter(Boolean);
        const grant: AccessGrant = {
          people: list('people'),
          types: list('types'),
          collections: list('collections'),
          include_adults_only: query.get('include_adults_only') === 'true',
          include_no_person_docs: query.get('include_no_person_docs') === 'true',
          expires_at: query.get('expires_at'),
        };
        const inCollections = new Set(
          (state.collections ?? [])
            .filter((c) => grant.collections.includes(c.id) && c.audience === 'everyone')
            .flatMap((c) => c.items),
        );
        // The vault's rule (0054), as far as these documents go.
        const gives = (d: Record<string, unknown>) => {
          const owner = (d.owner_member_id as string | null | undefined) ?? null;
          const vis = typeof d.visibility === 'string' ? d.visibility : 'household';
          if (d.deleted_at || vis === 'private') return false;
          if (vis === 'adults' && !grant.include_adults_only) return false;
          if (owner !== null && owner === id) return true;
          const byPerson =
            owner === null
              ? grant.include_no_person_docs
              : grant.people.length > 0
                ? grant.people.includes(owner)
                : grant.types.length > 0;
          if (byPerson && (grant.types.length === 0 || grant.types.includes(String(d.type_key))))
            return true;
          return (
            (owner !== null || grant.include_no_person_docs) && inCollections.has(String(d.id))
          );
        };
        return json({
          documents: state.documents.filter(gives).length,
          keeps_private: id !== null && (state.keepsPrivate ?? []).includes(id),
        });
      }
      if (method !== 'PUT' && method !== 'DELETE') return refuse(404, 'not_found', 'Not here.');
      if (storedRole() !== 'owner') {
        return refuse(403, 'forbidden', 'Only an owner can change what someone is allowed to do.');
      }
      if (state.twoStep === false) {
        return refuse(
          403,
          'totp_required_for_owner',
          'Turn on two-step sign-in to limit what a viewer can see.',
        );
      }
      if (state.accountStepUp) {
        return refuse(
          403,
          'step_up_required',
          'Please confirm it is you to limit what a viewer can see.',
          {
            action: 'limit_access',
          },
        );
      }
      const theirs = id as string;
      const card = state.accounts?.[theirs];
      state.accessWrites = [...(state.accessWrites ?? []), { id: theirs, method, body }];
      if (method === 'DELETE') {
        if (card) card.access = null;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      const b = (body ?? {}) as Partial<AccessGrant> & { confirm_private?: boolean };
      const named = state.members.find((m) => m.id === theirs)?.display_name;
      const name = typeof named === 'string' ? named : 'They';
      const was = card?.access ?? null;
      if (
        (state.keepsPrivate ?? []).includes(theirs) &&
        !was?.private_confirmed &&
        !b.confirm_private
      ) {
        return refuse(
          409,
          'confirm_private',
          `${name} keeps documents only they can see. Limited, they still see those, and nothing else of the family’s that you do not give them. Confirm to go ahead: they will be told.`,
        );
      }
      // As the vault keeps the flags: an empty list leaves them as they are
      // unless the body says otherwise (the 5.33 review).
      const flag = (named: string[], said: boolean | undefined, had: boolean | undefined) =>
        named.length > 0 || (said ?? had ?? false);
      const limitsPeople = flag(b.people ?? [], b.limits_people, was?.limits_people);
      const limitsTypes = flag(b.types ?? [], b.limits_types, was?.limits_types);
      const access: MemberAccess = {
        member_id: theirs,
        people: b.people ?? [],
        types: b.types ?? [],
        collections: b.collections ?? [],
        include_adults_only: b.include_adults_only ?? false,
        include_no_person_docs: b.include_no_person_docs ?? false,
        expires_at: b.expires_at ?? null,
        limits_people: limitsPeople,
        limits_types: limitsTypes,
        summary: restrictionSummary(
          {
            people: b.people?.length ?? 0,
            types: b.types?.length ?? 0,
            collections: b.collections?.length ?? 0,
            include_adults_only: b.include_adults_only ?? false,
            include_no_person_docs: b.include_no_person_docs ?? false,
            expires_at: b.expires_at ?? null,
            limits_people: limitsPeople,
            limits_types: limitsTypes,
          },
          state.timezone ?? 'UTC',
        ),
        reconfirm_since: null,
        private_confirmed: Boolean(b.confirm_private) || (was?.private_confirmed ?? false),
        updated_at: new Date().toISOString(),
      };
      if (card) card.access = access;
      return json(access);
    }
    // Signing somebody out everywhere (5.30), refused in the vault's order:
    // who may, the owner power, then the person. Their devices go.
    const outAt = /^\/api\/v1\/members\/([^/]+)\/sessions$/.exec(path);
    if (outAt && method === 'DELETE' && state.signOutEverywhere !== false) {
      if (storedRole() !== 'owner') {
        return refuse(403, 'forbidden', 'Only an owner can sign someone out everywhere.');
      }
      const power = ownerPower();
      if (power) return power;
      const id = outAt[1] as string;
      const card = state.accounts?.[id];
      if (!card) return refuse(404, 'not_found', 'They have no sign-in to sign out.');
      (state.signedOut ??= []).push(id);
      const ended = card.devices.length;
      card.devices = [];
      return json({ member_id: id, sessions_ended: ended });
    }
    // A person's details (5.25), made to the version seen; the owner's view
    // of a sign-in, asked with a passkey or a code (A54).
    const memberAt = /^\/api\/v1\/members\/([^/]+)(\/account)?$/.exec(path);
    if (memberAt && memberAt[2] && method === 'GET') {
      if (storedRole() !== 'owner') return refuse(404, 'not_found', 'That page does not exist.');
      const power = ownerPower();
      if (power) return power;
      const card = state.accounts?.[memberAt[1] as string];
      if (!card) return refuse(404, 'not_found', 'They have no sign-in to show.');
      // Since 5.28 a card says whether it is locked, and how long a phone
      // keeps its offline copies; a vault from before says neither.
      return json(
        state.memberAdmin === false ? card : { suspension: null, max_offline_days: 90, ...card },
      );
    }
    // A guest who never signed in, removed (the 5.34 review): owners only,
    // and nobody who has had a sign-in. Their invitations go with them.
    if (memberAt && !memberAt[2] && method === 'DELETE') {
      if (storedRole() !== 'owner') {
        return refuse(403, 'forbidden', 'Only an owner can remove someone.');
      }
      const g = (state.guests ?? []).find((x) => x.id === memberAt[1]);
      if (!g) {
        return state.members.some((x) => x.id === memberAt[1])
          ? refuse(409, 'not_a_guest', 'They are of the family, and stay in it.')
          : refuse(404, 'not_found', 'That person is not here.');
      }
      if (g.has_account || g.sign_in_removed) {
        return refuse(
          409,
          'had_sign_in',
          `${String(g.display_name)} has had a sign-in here. Take it away instead; an owner can give it back.`,
        );
      }
      state.guests = (state.guests ?? []).filter((x) => x.id !== g.id);
      state.invitations = state.invitations.filter((i) => i.member_id !== g.id);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (memberAt && !memberAt[2] && method === 'PATCH') {
      // A guest's details too (the 5.34 review), from People outside the family.
      const m =
        state.members.find((x) => x.id === memberAt[1]) ??
        (state.guests ?? []).find((x) => x.id === memberAt[1]);
      if (!m) return refuse(404, 'not_found', 'That person is not in the family.');
      const b = body as Record<string, unknown>;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const ifMatch = headers['if-match'] ?? null;
      state.memberEdits = [...(state.memberEdits ?? []), { id: String(m.id), body: b, ifMatch }];
      const version = (m.version as number | undefined) ?? 1;
      if (ifMatch !== null && ifMatch !== `"${version}"`) {
        return refuse(
          409,
          'conflict',
          'Someone else changed these details. Reload and try again.',
          {
            detail: JSON.stringify(withDetails(m)),
          },
        );
      }
      if (b.is_deceased !== undefined && b.is_deceased !== m.is_deceased) {
        if (state.stepUpNeeded) {
          return refuse(
            403,
            'step_up_required',
            'Please confirm it is you to change who is in the family.',
            {
              action: 'change_people',
            },
          );
        }
      }
      Object.assign(m, b, { version: version + 1 });
      return json(withDetails(m));
    }
    if (path === '/api/v1/members' && method === 'POST') {
      const b = body as {
        display_name: string;
        relationship?: string | null;
        date_of_birth?: string | null;
      };
      const m = {
        ...ME,
        id: `m-${state.members.length}`,
        display_name: b.display_name,
        relationship: b.relationship ?? null,
        date_of_birth: b.date_of_birth ?? null,
        is_me: false,
        has_account: false,
        role: null,
        document_count: 0,
        colour: state.members.length,
        photo: null,
        photo_status: null,
        can_change_photo: true,
      };
      state.members.push(m);
      return json(m, 201);
    }
    // A person's photo (5.17c): the crop first, then the photo; made at a
    // later GET /members; fetched, with the token, as a JPEG.
    const photoAt = /^\/api\/v1\/members\/([^/]+)\/photo(?:\/([^/]+))?$/.exec(path);
    if (photoAt) {
      const m = state.members.find((x) => x.id === photoAt[1]);
      if (photoAt[2]) {
        const photo = m?.photo as { id: string } | null | undefined;
        if (method !== 'GET' || !photo || photo.id !== photoAt[2]) {
          return refuse(404, 'no_photo', 'There is no photo here.');
        }
        return Promise.resolve(
          new Response(`photo ${photo.id}`, {
            status: 200,
            headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, no-store' },
          }),
        );
      }
      if (!m) return refuse(404, 'not_found', 'That person is not in the family.');
      if (method === 'DELETE') {
        Object.assign(m, { photo: null, photo_status: null });
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      const form = init?.body as FormData | undefined;
      const fields = form ? [...form.keys()] : [];
      const crop = form?.get('crop');
      state.photoUploads = [
        ...(state.photoUploads ?? []),
        {
          member: String(m.id),
          fields,
          crop: typeof crop === 'string' ? (JSON.parse(crop) as Record<string, number>) : null,
        },
      ];
      Object.assign(m, { photo_status: 'processing', photo_asks: 0 });
      return json(m, 202);
    }
    if (path === '/api/v1/auth/password/change' && method === 'POST') {
      const b = body as { current_password?: string; new_password: string };
      if (state.stepUpNeeded && !b.current_password) {
        return json(
          {
            error: {
              code: 'step_up_required',
              message: 'Please confirm it is you to set a new password.',
              action: 'change_password',
              retriable: false,
              request_id: 'r',
            },
          },
          403,
        );
      }
      if (b.current_password && b.current_password !== 'correct horse battery') {
        return json(
          {
            error: {
              code: 'invalid_credentials',
              message: "That isn't your current password.",
              retriable: false,
              request_id: 'r',
            },
          },
          401,
        );
      }
      state.passwordChanged = b.new_password;
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (path === '/api/v1/auth/password/forgot' && method === 'POST') {
      state.forgotFor = (body as { email: string }).email;
      return json(
        { message: 'If that address has a sign-in here, a link is on its way to it.' },
        202,
      );
    }
    if (path.startsWith('/api/v1/password-resets/')) {
      if (!state.resetValid) {
        return json(
          {
            error: {
              code: 'reset_not_valid',
              message: 'That link is not valid any more. Ask for a new one from the sign-in page.',
              retriable: false,
              request_id: 'r',
            },
          },
          404,
        );
      }
      // Since 0.5.17 the token comes in a body: /lookup shows the link,
      // /complete spends it. Anything else is a path form.
      if (method === 'POST' && path !== '/api/v1/password-resets/lookup') {
        state.passwordChanged = (body as { password: string }).password;
        return json({ email: 'mansoor@example.test' });
      }
      return json({
        household_name: 'The Seikh family',
        email: 'mansoor@example.test',
        issued_by_operator: state.resetByOperator || state.resetIssuedBy === 'owner',
        ...(state.resetIssuedBy ? { issued_by: state.resetIssuedBy } : {}),
        expires_at: new Date(Date.now() + 36e5).toISOString(),
      });
    }
    if (path.startsWith('/api/v1/audit')) return json({ items: state.activity, next: null });
    if (path.endsWith('/visibility') && method === 'POST') {
      const to = (body as { visibility: string }).visibility;
      const doc = state.documents.find((d) => path.includes(String(d.id)));
      // Out of "only me" asks what opening it asks (5.4).
      const ask = askedToLoosen(doc, { visibility: to });
      if (state.stepUpNeeded && ask) return stepUp(ask);
      if (doc) doc.visibility = to;
      const firstTime = to === 'private' && !state.privateNoticeShown;
      if (firstTime) state.privateNoticeShown = true;
      return json({
        notice: firstTime
          ? {
              title: 'Only you can open this',
              body: 'Nobody can open it after you, unless you leave a key. Leaving a key with someone you trust is not built yet; when it is, this document will be on the list.',
            }
          : null,
      });
    }
    if (path === '/api/v1/shares' && method === 'GET') return json({ items: state.shares });
    if (path.endsWith('/share') && method === 'POST') {
      const documentId = path.split('/')[4] as string;
      const doc = state.documents.find((d) => d.id === documentId && !d.deleted_at);
      // In the vault's order: a link asks what opening it asks, then who
      // may share, then whether there is anything to send (5.4).
      const ask = askedToOpen(doc);
      if (state.stepUpNeeded && ask) return stepUp(ask);
      if (!['owner', 'adult'].includes(storedRole())) {
        return refuse(403, 'forbidden', 'Only an adult can share a document outside the family.');
      }
      if (!doc) return refuse(404, 'not_found', 'That document is not in the vault.');
      if (!doc.latest_version_id) {
        return refuse(
          422,
          'nothing_to_share',
          'There is no file on this document yet, so there is nothing to send.',
        );
      }
      const b = body as {
        recipient_label?: string;
        with_pin?: boolean;
        expires_at?: string;
        expires_in_days?: number;
        permission?: 'view' | 'download';
        max_opens?: number | null;
        with_password?: boolean;
        password?: string;
        code_email?: string;
        this_device_only?: boolean;
      };
      // 5.20: an emailed code only with the operator's mail server (A21).
      if (b.code_email !== undefined && state.operatorMail !== true) {
        return refuse(
          422,
          'email_code_unavailable',
          'Emailing a code needs the mail server of whoever runs this vault, and none is set up.',
        );
      }
      // An address the vault refuses, as its schema does (W520-5).
      if (b.code_email !== undefined && state.refuseCodeEmail) {
        return refuse(
          422,
          'validation_failed',
          'That is not an email address. Check it: name@example.com.',
          { detail: 'code_email: That is not an email address. Check it: name@example.com.' },
        );
      }
      // The vault's own refusals (5.18), in its words.
      const end = b.expires_at
        ? new Date(b.expires_at)
        : new Date(Date.now() + (b.expires_in_days ?? 7) * 864e5);
      if (end.getTime() < Date.now() + 5 * 60_000) {
        return refuse(422, 'expiry_out_of_range', 'Choose a time at least 5 minutes from now.');
      }
      const maxDays = state.shareMaxDays ?? 90;
      if (end.getTime() > Date.now() + maxDays * 864e5) {
        return refuse(422, 'expiry_out_of_range', `A link can last ${maxDays} days at most.`);
      }
      if (b.permission === 'view' && state.versionMime && state.versionMime !== 'application/pdf') {
        return refuse(
          422,
          'view_not_possible',
          'Word and Excel files can only be shared to download: the vault cannot draw their pages.',
        );
      }
      const opened = b.max_opens ? `opened 0 of ${b.max_opens} times` : 'not opened yet';
      const share = {
        id: `sh-${state.shares.length}`,
        document_id: documentId,
        document_title: 'Mansoor’s passport',
        recipient_label: b.recipient_label ?? null,
        created_by_name: 'Mansoor Seikh',
        created_at: new Date().toISOString(),
        expires_at: end.toISOString(),
        has_pin: Boolean(b.with_pin),
        open_count: 0,
        last_opened_at: null,
        state: 'active',
        flow: 'v2',
        permission: b.permission ?? 'download',
        max_opens: b.max_opens ?? null,
        max_downloads: null,
        downloads_used: 0,
        pages:
          b.permission === 'view'
            ? (state.sharePages ?? {
                state: 'drawing',
                shown: state.pageCount,
                total: state.pageCount,
              })
            : null,
        ...factorsOf(b),
        summary: `${b.recipient_label ? `Shared with ${b.recipient_label}` : 'Shared by link'}, ${opened}${b.permission === 'view' ? '; to view only' : ''}. Stops working on 30 September at 17:00.`,
      };
      state.shares.push(share);
      return json(
        {
          share,
          link_token: 'share-secret-0123456789abcdef',
          link_url: state.shareLinkUrl ?? null,
          ...(b.with_pin ? { pin: '4821' } : {}),
          ...(b.with_password ? { password: 'k7mq-p2xa-9htw' } : {}),
        },
        201,
      );
    }
    // What came in through a request, looked at before it is filed (5.23).
    // A teen or a viewer is told there is nothing here, as the vault tells them.
    const incomingAt =
      /^\/api\/v1\/incoming(?:\/([^/]+)\/(pages\/\d+|content|accept|reject))?$/.exec(path);
    if (incomingAt && state.incoming) {
      if (!can(storedRole() as Role, 'upload_request.create')) {
        return refuse(404, 'not_found', 'That file is not waiting for you.');
      }
      const [, id, what] = incomingAt;
      if (!id) return json({ items: state.incoming });
      const at = state.incoming.findIndex((f) => f.id === id);
      const file = state.incoming[at];
      if (!file) return refuse(404, 'not_found', 'That file is not waiting for you.');
      if (what?.startsWith('pages/')) {
        return Promise.resolve(
          new Response(`${what} of ${String(file.name)}`, {
            status: 200,
            headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, no-store' },
          }),
        );
      }
      if (what === 'content') {
        return Promise.resolve(
          new Response('%PDF-1.4', {
            status: 200,
            headers: {
              'content-type': String(file.content_type),
              'content-disposition': 'attachment',
              'x-content-type-options': 'nosniff',
              'x-fdv-scan': 'unscanned',
            },
          }),
        );
      }
      if (what === 'reject' && method === 'POST') {
        state.incoming.splice(at, 1);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (what === 'accept' && method === 'POST') {
        const b = body as Record<string, unknown>;
        state.incoming.splice(at, 1);
        const into = typeof b.into_document_id === 'string' ? b.into_document_id : null;
        if (into) return json({ document_id: into, version_id: 'v-incoming' }, 201);
        const made = {
          ...PASSPORT,
          id: `doc-incoming-${state.documents.length + 1}`,
          title: (b.title as string | null) ?? null,
          type_key: (b.type_key as string | null) ?? null,
          owner_member_id: (b.owner_member_id as string | null) ?? null,
          visibility: b.visibility ?? 'household',
          is_essential: false,
          tags: [],
          latest_version_id: 'v-incoming',
          sent_through:
            typeof file.recipient_label === 'string'
              ? `Sent through a request link (${file.recipient_label})`
              : 'Sent through a request link',
          etag: '"incoming"',
        };
        state.documents.push(made);
        return json({ document_id: made.id, version_id: 'v-incoming' }, 201);
      }
    }
    // After a restore, and turning a link back on (5.16): an owner decides
    // every link; anybody else is shown the ones they made, only to take
    // back — no one else turns a link back on, not even its maker (A55).
    if (path === '/api/v1/after-restore' && method === 'GET') {
      const owner = storedRole() === 'owner';
      const mine = (x: Record<string, unknown>) => x.created_by_name === ME.display_name;
      // One paused only because its maker's sign-in is locked (5.28) is not
      // the restore's: it opens again with the unlock.
      const restored = (x: Record<string, unknown>) =>
        x.state === 'paused' &&
        x.paused_reason !== 'locked' &&
        x.paused_reason !== 'sign_in_paused';
      return json({
        links: state.shares.filter((x) => restored(x) && (owner || mine(x))),
        // 5.21: the paused requests the reader may decide about — an owner,
        // all they review; anybody else, their own.
        upload_requests: (state.uploadRequests ?? []).filter(
          (r) => restored(r) && (owner || r.mine === true),
        ),
        // 5.28: the sign-ins it paused, an owner's alone to turn back on,
        // by name; absent from a vault from before.
        ...(state.memberAdmin === false
          ? {}
          : {
              sign_ins: owner
                ? Object.values(state.accounts ?? {})
                    .filter((a) => a.suspension?.reason === 'restored')
                    .map((a) => ({
                      member_id: a.member_id,
                      display_name: ((n) => (typeof n === 'string' ? n : ''))(
                        state.members.find((m) => m.id === a.member_id)?.display_name,
                      ),
                      role: a.role,
                      paused_at: a.suspension?.since ?? '',
                      restriction: state.restrictions?.[a.member_id]
                        ? { summary: state.restrictions[a.member_id] as string }
                        : null,
                    }))
                    .sort((x, y) => x.display_name.localeCompare(y.display_name))
                : [],
            }),
      });
    }
    if (path.startsWith('/api/v1/shares/') && path.endsWith('/resume') && method === 'POST') {
      if (storedRole() !== 'owner') {
        return refuse(403, 'forbidden', 'Only an owner can turn things back on after a restore.');
      }
      const link = state.shares.find((x) => x.id === path.split('/')[4]);
      // Only a restore's own pause is turned on, as the vault does: one paused
      // by its maker's sign-in is no paused link to it (the 5.28 second round).
      if (!link || link.state !== 'paused' || link.paused_reason !== 'restored') {
        return refuse(404, 'not_found', 'That paused link does not exist.');
      }
      // A link whose maker's sign-in still waits after the restore (5.28,
      // `maker_paused` in a test's state), or is locked (`maker_paused:
      // 'locked'`): turned on, and paused by them.
      Object.assign(
        link,
        link.maker_paused === true
          ? { state: 'paused', paused_reason: 'sign_in_paused' }
          : link.maker_paused === 'locked'
            ? { state: 'paused', paused_reason: 'locked' }
            : { state: 'active', paused_at: null, paused_reason: null },
      );
      return json(link);
    }
    // Asking for documents (5.22, the API of 5.21): owners and adults; a
    // teen or a viewer is told there is nothing here, as the vault tells them.
    if (path === '/api/v1/upload-requests' || path.startsWith('/api/v1/upload-requests/')) {
      const role = storedRole();
      if (role !== 'owner' && role !== 'adult') {
        return refuse(404, 'not_found', 'That page does not exist.');
      }
      const list = (state.uploadRequests ??= []);
      if (path === '/api/v1/upload-requests' && method === 'GET') {
        return json({ items: list, email_code_available: state.operatorMail === true });
      }
      if (path === '/api/v1/upload-requests' && method === 'POST') {
        const b = body as Record<string, unknown>;
        const title = typeof b.title === 'string' ? b.title.trim() : '';
        if (!title) return refuse(422, 'validation_failed', 'Give the request a title.');
        const end = new Date(String(b.expires_at));
        if (Number.isNaN(end.getTime()) || end.getTime() < Date.now() + 5 * 60_000) {
          return refuse(422, 'expiry_out_of_range', 'Choose a time at least 5 minutes from now.');
        }
        if (end.getTime() > Date.now() + 90 * 864e5 + 5 * 60_000) {
          return refuse(422, 'expiry_out_of_range', 'A request can last 90 days at most.');
        }
        if (b.email_code === true && state.operatorMail !== true) {
          return refuse(
            422,
            'email_code_unavailable',
            'This vault cannot send email codes: whoever runs it has not given it a mail server.',
          );
        }
        if (b.email_code === true && state.refuseCodeEmail) {
          return refuse(422, 'validation_failed', 'That is not an address the vault can send to.', {
            detail: 'recipient_email',
          });
        }
        const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
        const made = {
          id: `req-${list.length + 1}`,
          title,
          message: text(b.message),
          items: ((b.items as string[] | undefined) ?? []).map((label, i) => ({
            id: `item-${i + 1}`,
            label,
          })),
          recipient_label: text(b.recipient_label),
          recipient_email: text(b.recipient_email),
          requested_by_name: ME.display_name,
          mine: true,
          created_at: new Date().toISOString(),
          expires_at: end.toISOString(),
          protection: [
            ...(b.with_password || b.password ? ['password'] : []),
            ...(b.email_code ? ['email_code'] : []),
            ...(b.this_device_only ? ['this_device'] : []),
          ],
          max_visits: typeof b.max_visits === 'number' ? b.max_visits : null,
          visits_used: 0,
          max_files: typeof b.max_files === 'number' ? b.max_files : 10,
          files_used: 0,
          max_total_bytes:
            typeof b.max_total_bytes === 'number' ? b.max_total_bytes : 200 * 1024 * 1024,
          bytes_used: 0,
          accept_types: b.accept_types === 'office' ? 'office' : 'standard',
          review_by: b.review_by === 'adults' ? 'adults' : 'me',
          suggested_member_id: text(b.suggested_member_id),
          suggested_type_key: null,
          close_after_submit: b.close_after_submit === true,
          state: 'active',
          paused_reason: null,
          closed_reason: null,
          files_received: 0,
        };
        list.unshift(made);
        return json(
          {
            request: made,
            link_token: 'drop-secret-0123456789abcdef',
            link_url: state.dropLinkUrl ?? null,
            ...(b.with_password ? { password: 'k7mq-p2xa-9htw' } : {}),
          },
          201,
        );
      }
      const at = /^\/api\/v1\/upload-requests\/([^/]+)(\/resume)?$/.exec(path);
      const r = at ? list.find((x) => x.id === at[1]) : undefined;
      if (!at || !r) return refuse(404, 'not_found', 'That request does not exist.');
      if (!at[2] && method === 'DELETE') {
        Object.assign(r, { state: 'revoked', recipient_email: null });
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (at[2] && method === 'POST') {
        if (role !== 'owner') {
          return refuse(403, 'forbidden', 'Only an owner can turn things back on after a restore.');
        }
        // Only a restore's own pause, as the vault: one paused by its
        // requester's sign-in has no pause of its own (the 5.28 second round).
        if (r.state !== 'paused' || r.paused_reason !== 'restored') {
          return refuse(404, 'not_found', 'That paused request does not exist.');
        }
        // Its requester's sign-in still waiting after the restore, or locked
        // (`requester_paused` in a test's state): turned on, and paused by them.
        const by = r.requester_paused;
        Object.assign(
          r,
          by === 'sign_in_paused' || by === 'locked'
            ? { state: 'paused', paused_reason: by }
            : { state: 'active', paused_reason: null },
        );
        return json(r);
      }
    }
    // The page a request opens (5.22): /drop, the token in a body, Open
    // counted, a session after, named by X-FDV-Drop-Request.
    if (path.startsWith('/api/v1/drop/')) {
      const d = (state.drop ??= freshDrop());
      const dropGone = () =>
        refuse(
          404,
          'link_not_valid',
          'That link is not valid any more. Ask whoever sent it for a new one.',
        );
      const ended = () =>
        refuse(
          401,
          'drop_session_ended',
          'This page has been open too long, or was opened somewhere else. Open the link you were sent again.',
        );
      if ((d.busy ?? 0) > 0) {
        d.busy = (d.busy ?? 0) - 1;
        return refuse(503, 'busy', 'The vault was busy just then. Try again.', {
          retriable: true,
        });
      }
      const accept = d.accept ?? 'standard';
      const maxBytes = d.maxBytes ?? 200 * 1024 * 1024;
      const used = d.files.reduce((n, f) => n + f.byte_size, 0);
      // The browser's session's own files, not yet sent with Finish.
      const mine = () =>
        d.files.filter(
          (f) => !f.submitted && (f.session === undefined || f.session === (d.sessionNo ?? 1)),
        );
      const view = () => ({
        request_id: DROP_REQUEST_ID,
        household_name: 'The Seikh family',
        requested_by: 'Mansoor Seikh',
        title: d.title ?? 'Tax papers for 2025',
        message: d.message ?? null,
        items: d.items,
        accept_types: accept,
        accepted: uploadRequestTypes(accept),
        max_files: d.maxFiles ?? 10,
        files_left: Math.max(0, (d.maxFiles ?? 10) - d.files.length),
        bytes_left: maxBytes - used,
        max_file_bytes: Math.min(d.maxFileBytes ?? 100 * 1024 * 1024, maxBytes - used),
        file_limit_bytes: d.maxFileBytes ?? 100 * 1024 * 1024,
        expires_at: d.expiresAt ?? new Date(Date.now() + 14 * 864e5).toISOString(),
        session_expires_at: new Date(Date.now() + 4 * 3600e3).toISOString(),
        files: mine().map((f) => ({
          id: f.id,
          name: f.name,
          content_type: f.content_type,
          byte_size: f.byte_size,
          item_id: f.item_id,
        })),
      });
      const protection = [
        ...(d.password ? ['password'] : []),
        ...(d.code ? ['email_code'] : []),
        ...(d.thisDevice ? ['this_device'] : []),
      ];
      const usedUp = () =>
        refuse(
          410,
          'request_used_up',
          'This link has been opened as many times as it allows, so it cannot be opened again. Ask whoever sent it for a new one.',
        );
      const otherDevice = () =>
        refuse(
          403,
          'other_device',
          'This link was opened on another device, and works only there. Ask whoever sent it for a new one.',
        );
      if (path === '/api/v1/drop/preview' && method === 'POST') {
        if (!d.valid) return dropGone();
        // Used up — unless its last visit is this browser's live session (N522S-3).
        if (d.usedUp && !d.session) return usedUp();
        return json({
          household_name: 'The Seikh family',
          requested_by: 'Mansoor Seikh',
          protection,
          expires_at: d.expiresAt ?? new Date(Date.now() + 14 * 864e5).toISOString(),
          request_id: DROP_REQUEST_ID,
          code_to:
            d.code && !d.otherDevice ? maskEmail(d.codeTo ?? 'jane.smith@example.com') : null,
          other_device: Boolean(d.otherDevice),
        });
      }
      if (path === '/api/v1/drop/code' && method === 'POST') {
        if (!d.valid) return dropGone();
        if (d.otherDevice) return otherDevice();
        if (!d.code) {
          return refuse(422, 'no_email_code', 'This link does not use an emailed code.');
        }
        d.codesSent = (d.codesSent ?? 0) + 1;
        return json({
          sent_to: maskEmail(d.codeTo ?? 'jane.smith@example.com'),
          expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        });
      }
      if (path === '/api/v1/drop/unlock' && method === 'POST') {
        if (!d.valid) return dropGone();
        if (d.usedUp) return usedUp();
        if (d.otherDevice) return otherDevice();
        const given = body as { password?: string; code?: string };
        if ((d.password && given.password !== d.password) || (d.code && given.code !== d.code)) {
          const left = (d.triesLeft ?? 10) - 1;
          d.triesLeft = left;
          if (left <= 0) d.valid = false;
          return refuse(
            401,
            'secret_wrong',
            left > 0
              ? 'That is not right. Check what you were sent, and try again.'
              : 'That was wrong too many times, so the link has stopped working.',
          );
        }
        d.opens += 1;
        // A session of its own, under the same cookie name as any before.
        d.sessionNo = (d.session ? (d.sessionNo ?? 1) : 0) + 1;
        d.session = true;
        return json(view());
      }
      // Inside a session: it must say which request it is about.
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (path === '/api/v1/drop/session' && (d.sessionDrops ?? 0) > 0) {
        d.sessionDrops = (d.sessionDrops ?? 0) - 1;
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      if (path === '/api/v1/drop/session' && (d.sessionBusy ?? 0) > 0) {
        d.sessionBusy = (d.sessionBusy ?? 0) - 1;
        return refuse(503, 'busy', 'The vault was busy just then. Try again.', { retriable: true });
      }
      if (!d.session || headers['x-fdv-drop-request'] !== DROP_REQUEST_ID) return ended();
      if (!d.valid) return dropGone();
      if (path === '/api/v1/drop/session' && method === 'GET') {
        return json(
          d.foreignSession
            ? { ...view(), request_id: 'another-request-0000', title: 'Somebody else’s request' }
            : view(),
        );
      }
      if (path === '/api/v1/drop/files' && method === 'POST') {
        const form = init?.body as FormData;
        const file = form.get('file') as File;
        const itemId = form.get('item_id') as string | null;
        if (d.files.length >= (d.maxFiles ?? 10)) {
          return refuse(
            409,
            'files_used_up',
            `This request takes ${d.maxFiles ?? 10} files, and that many have been sent.`,
          );
        }
        if (file.size > (d.maxFileBytes ?? 100 * 1024 * 1024)) {
          return refuse(413, 'too_large', 'That file is too big: one file can be 100 MB at most.');
        }
        if (/\.(docm|xlsm)$/i.test(file.name)) {
          return refuse(
            415,
            'macros_refused',
            "Word and Excel files with macros, or that load something from elsewhere, can't be sent here. Save it as an ordinary Word or Excel file, or as a PDF, and send that.",
          );
        }
        if (!uploadRequestTypes(accept).includes(file.type)) {
          return refuse(
            415,
            'unsupported_type',
            accept === 'office'
              ? 'That kind of file cannot be sent here. PDFs, photos, and Word or Excel files are fine.'
              : 'That kind of file cannot be sent here. PDFs and photos are fine.',
          );
        }
        const sent = {
          id: `file-${d.files.length + 1}-${file.name}`,
          // Kept as the vault keeps a name (NFC, spaces run together).
          name: dropFileName(file.name),
          content_type: file.type,
          byte_size: file.size,
          item_id: itemId,
        };
        d.files.push({ ...sent, session: d.sessionNo ?? 1 });
        return json(sent, 201);
      }
      const fileAt = /^\/api\/v1\/drop\/files\/([^/]+)$/.exec(path);
      if (fileAt && method === 'DELETE') {
        const id = decodeURIComponent(fileAt[1] as string);
        if (!mine().some((f) => f.id === id)) {
          return refuse(404, 'not_found', 'That file is not here.');
        }
        d.files = d.files.filter((f) => f.id !== id);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (path === '/api/v1/drop/finish' && method === 'POST') {
        const sending = mine();
        if (sending.length === 0) {
          return refuse(422, 'nothing_to_send', 'Add a file first, then press Finish.');
        }
        const note = (body as { note?: string } | undefined)?.note ?? null;
        for (const f of sending) f.submitted = true;
        d.finished = { note, files: sending.length };
        if (d.closeAfter) d.valid = false;
        return json({ files: sending.length, closed: Boolean(d.closeAfter) });
      }
    }
    // The page at /s (5.16): the token in a body, Open counted, a session after.
    const linkGone = () =>
      refuse(
        404,
        'link_not_valid',
        'That link is not valid any more. Ask whoever sent it for a new one.',
      );
    const view = state.sharePermission === 'view';
    const sharedItem = (id: string, title: string, filename: string) => ({
      id,
      title,
      type_label: 'Lease or tenancy agreement',
      filename,
      content_type: 'application/pdf',
      byte_size: 1024,
      pages: view ? (state.sharePages ?? { state: 'ready', shown: 2, total: 2 }) : null,
      downloaded: Boolean(state.shareDownloaded),
    });
    const linkSession = () => ({
      household_name: 'The Seikh family',
      shared_by: 'Mansoor Seikh',
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      session_expires_at: new Date(Date.now() + 4 * 3600e3).toISOString(),
      items: state.shareCollection
        ? state.shareCollection.items.map((i) => sharedItem(i.id, i.title, i.filename))
        : [sharedItem('doc-shared', 'Flat 3 tenancy agreement', 'tenancy.pdf')],
      permission: state.sharePermission ?? 'download',
      downloads_left: view ? null : (state.shareDownloadsLeft ?? null),
      ...(state.shareCollection
        ? { kind: 'collection', collection_name: state.shareCollection.name }
        : { kind: 'document' }),
    });
    // Opened as often as it allows (5.18): said plainly, before and at Open.
    const usedUp = () =>
      refuse(
        410,
        'link_used_up',
        'This link has been opened as many times as it allows, so it cannot be opened again. Ask whoever sent it for a new one.',
      );
    // 5.20: what Open asks for, and one device only.
    const protection = [
      ...(state.sharePin ? ['pin'] : state.sharePassword ? ['password'] : []),
      ...(state.shareCode ? ['code'] : []),
    ];
    const otherDevice = () =>
      refuse(
        403,
        'other_device',
        'This link has been opened in another browser already, and it only opens there. Open it in the browser you opened it in first, or ask whoever sent it for a new one.',
      );
    if (path === '/api/v1/shared/preview' && method === 'POST') {
      if (!state.shareValid) return linkGone();
      if (state.shareOpensLeft === 0) return usedUp();
      const withheld = protection.length > 0 || Boolean(state.shareOtherDevice);
      return json({
        household_name: 'The Seikh family',
        shared_by: 'Mansoor Seikh',
        protection,
        expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
        document_title: withheld || state.shareCollection ? null : 'Flat 3 tenancy agreement',
        permission: state.sharePermission ?? 'download',
        opens_left: state.shareOpensLeft ?? null,
        ...(state.shareCollection
          ? {
              kind: 'collection',
              collection_name: withheld ? null : state.shareCollection.name,
            }
          : { kind: 'document' }),
        code_to: state.shareCode ? maskEmail(state.shareCodeTo ?? 'jane.smith@example.com') : null,
        this_device_only: Boolean(state.shareDeviceOnly),
        other_device: Boolean(state.shareOtherDevice),
      });
    }
    if (path === '/api/v1/shared/code' && method === 'POST') {
      if (!state.shareValid) return linkGone();
      if (state.shareOtherDevice) return otherDevice();
      if (!state.shareCode) {
        return refuse(409, 'no_code_needed', 'This link does not ask for a code.');
      }
      state.shareCodesSent = (state.shareCodesSent ?? 0) + 1;
      if (state.shareCodesSent > 3) {
        return refuse(
          429,
          'code_limit',
          '3 codes have been sent in the last 15 minutes. Use the newest one, or wait a little and send another.',
        );
      }
      return json({
        sent_to: maskEmail(state.shareCodeTo ?? 'jane.smith@example.com'),
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
    }
    if (path === '/api/v1/shared/unlock' && method === 'POST') {
      if (!state.shareValid) return linkGone();
      if (state.shareOpensLeft === 0) return usedUp();
      if (state.shareOtherDevice) return otherDevice();
      const given = body as { secret?: string; code?: string };
      if (state.sharePin && given.secret !== state.sharePin) {
        return refuse(
          401,
          'pin_wrong',
          'That PIN is not right. Check with whoever sent you the link.',
        );
      }
      // Whichever is wrong, the same words (A23).
      if (
        (state.sharePassword && given.secret !== state.sharePassword) ||
        (state.shareCode && given.code !== state.shareCode)
      ) {
        return refuse(
          401,
          'secret_wrong',
          state.sharePassword && state.shareCode
            ? 'The password or the code is not right. Check the password with whoever sent you the link. Only the newest code works, once, for 10 minutes: send a new one if it has run out.'
            : state.sharePassword
              ? 'That password is not right. Check with whoever sent you the link.'
              : 'That code is not right, or it has run out. Only the newest code works, once, for 10 minutes: send a new one.',
        );
      }
      state.shareOpens += 1;
      state.shareSession = true;
      if (typeof state.shareOpensLeft === 'number') state.shareOpensLeft -= 1;
      return json(linkSession());
    }
    if (path === '/api/v1/shared/items' && method === 'GET') {
      state.shareItemsAsked = (state.shareItemsAsked ?? 0) + 1;
      // The vault out of reach for a moment.
      if ((state.shareItemsFailing ?? 0) > 0) {
        state.shareItemsFailing = (state.shareItemsFailing ?? 0) - 1;
        return refuse(503, 'not_ready', 'The vault is starting up or cannot reach its database.');
      }
      if (!state.shareValid) return linkGone();
      if (!state.shareSession) {
        return refuse(
          401,
          'share_session_ended',
          'This page has been open too long, or was opened somewhere else. Open the link you were sent again.',
        );
      }
      return json(linkSession());
    }
    if (path.startsWith('/api/v1/shares/') && method === 'DELETE') {
      const id = path.slice('/api/v1/shares/'.length);
      state.shares = state.shares.filter((x) => x.id !== id);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (path.startsWith('/api/v1/shared/') && path.endsWith('/open')) {
      if (state.sharePin && (body as { pin?: string }).pin !== state.sharePin) {
        return json(
          {
            error: {
              code: 'pin_wrong',
              message: 'That PIN is not right. Check with whoever sent you the link.',
              retriable: false,
              request_id: 'r',
            },
          },
          401,
        );
      }
      return json({
        document_title: 'Flat 3 tenancy agreement',
        document_type: 'Lease or tenancy agreement',
        shared_by: 'Mansoor Seikh',
        expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
        byte_size: 1024,
        content_type: 'application/pdf',
        filename: 'tenancy.pdf',
      });
    }
    if (path.startsWith('/api/v1/shared/') && method === 'GET') {
      if (!state.shareValid) {
        return json(
          {
            error: {
              code: 'link_not_valid',
              message: 'That link is not valid any more. Ask whoever sent it for a new one.',
              retriable: false,
              request_id: 'r',
            },
          },
          404,
        );
      }
      return json({
        household_name: 'The Seikh family',
        needs_pin: Boolean(state.sharePin),
        expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
        document_title: state.sharePin ? null : 'Flat 3 tenancy agreement',
        shared_by: 'Mansoor Seikh',
      });
    }
    if (path === '/api/v1/owner-changes' && method === 'GET')
      return json({ items: state.ownerChanges });
    if (path.startsWith('/api/v1/owner-changes/') && path.endsWith('/refuse')) {
      const id = path.split('/')[4] as string;
      state.ownerChanges = state.ownerChanges.filter((r) => r.id !== id);
      return json({ id, state: 'refused' });
    }
    if (path.startsWith('/api/v1/owner-changes/') && method === 'DELETE') {
      const id = path.slice('/api/v1/owner-changes/'.length);
      state.ownerChanges = state.ownerChanges.filter((r) => r.id !== id);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (path.endsWith('/role') && method === 'POST') {
      const memberId = path.split('/')[4] as string;
      const role = (body as { role: string }).role;
      const target = state.members.find((m) => m.id === memberId);
      if (target?.role === 'owner' && role !== 'owner') {
        state.ownerChanges.push({
          id: 'ocr-1',
          target_member_id: memberId,
          target_name: String(target.display_name),
          requested_by_name: 'Mansoor Seikh',
          action: 'demote',
          requested_at: new Date().toISOString(),
          opens_at: new Date(Date.now() + 7 * 864e5).toISOString(),
          lapses_at: new Date(Date.now() + 30 * 864e5).toISOString(),
          state: 'waiting',
          about_me: false,
          summary: `Mansoor Seikh asked for ${String(target.display_name)} to stop being an owner. Nothing changes until then.`,
        });
        return json({
          applied: false,
          role: 'owner',
          message: 'Every owner has been told. They can refuse before then.',
          effects: [],
        });
      }
      // What else it did (5.30), as the vault answers it: a phone keeping
      // Essentials, a request, an export — each one of them, here.
      const from = (target?.role ?? 'adult') as Role;
      const effects = target ? roleChangeEffects(from, role as Role) : [];
      if (target) target.role = role;
      return json({
        applied: true,
        role,
        message: [
          `They are now ${role}.`,
          ...(effects.includes('offline_ended')
            ? ['Their phone removes the Essentials it keeps at its next sync.']
            : []),
        ].join(' '),
        effects: effects.map((effect) => ({ effect, count: 1 })),
      });
    }
    if (path.endsWith('/sign-in') && method === 'DELETE') {
      const memberId = path.split('/')[4] as string;
      // A guest's too (the 5.34 review), from People outside the family.
      const target =
        state.members.find((m) => m.id === memberId) ??
        (state.guests ?? []).find((m) => m.id === memberId);
      if (target) {
        target.has_account = false;
        target.role = null;
        target.sign_in_removed = true;
        if (target.kind === 'guest') target.access_expires_at = null;
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (path.endsWith('/sign-in') && method === 'POST') {
      const memberId = path.split('/')[4] as string;
      const target =
        state.members.find((m) => m.id === memberId) ??
        (state.guests ?? []).find((m) => m.id === memberId);
      const { role, access_expires_at: end } = body as {
        role: string;
        access_expires_at?: string;
      };
      // A guest's comes back with a new end, asked as renewing is (5.34) —
      // and first, before the ordinary step-up, as the vault asks them (the
      // 5.34 review's second round).
      const guest = target?.kind === 'guest';
      if (guest || end) {
        if (state.twoStep === false) {
          return refuse(
            403,
            'totp_required_for_owner',
            "Turn on two-step sign-in to renew a guest's sign-in.",
          );
        }
        if (state.accountStepUp) {
          return refuse(
            403,
            'step_up_required',
            "Please confirm it is you to renew a guest's sign-in.",
            { action: 'renew_guest' },
          );
        }
      }
      if (state.stepUpNeeded) {
        return refuse(
          403,
          'step_up_required',
          'Please confirm it is you to change who is in the family.',
          { action: 'change_people' },
        );
      }
      if (target?.kind === 'guest') {
        const problem = end ? guestEndProblem(new Date(end)) : 'Choose the day their access ends.';
        if (problem) return refuse(422, 'validation_failed', problem);
        target.access_expires_at = end;
      }
      if (target) {
        target.has_account = true;
        target.role = role;
        target.sign_in_removed = false;
      }
      return json({
        message: `${String(target?.display_name)} can sign in again with their own password.`,
      });
    }
    if (path === '/api/v1/invitations' && method === 'GET')
      return json({ items: state.invitations });
    if (path === '/api/v1/invitations' && method === 'POST') {
      const b = body as {
        display_name?: string;
        member_id?: string;
        email: string;
        role: string;
        restriction?: AccessGrant | null;
        kind?: 'family' | 'guest';
        access_expires_at?: string;
        relationship?: string | null;
      };
      // An owner's decision about what a viewer sees comes first, with a
      // passkey or a code (A54; the 5.34 review: every guest an owner
      // invites), then the ordinary step-up, as the vault asks them.
      const owner = storedRole() === 'owner';
      if (
        owner &&
        (b.kind === 'guest' ||
          (b.role === 'viewer' && !b.restriction) ||
          b.restriction?.include_adults_only === true)
      ) {
        if (state.twoStep === false) {
          return refuse(
            403,
            'totp_required_for_owner',
            'Turn on two-step sign-in to limit what a viewer can see.',
          );
        }
        if (state.accountStepUp) {
          return refuse(
            403,
            'step_up_required',
            'Please confirm it is you to limit what a viewer can see.',
            { action: 'limit_access' },
          );
        }
      }
      if (state.stepUpNeeded) {
        return refuse(
          403,
          'step_up_required',
          'Please confirm it is you to change who is in the family.',
          { action: 'change_people' },
        );
      }
      if (b.kind === 'guest') {
        const problem = b.access_expires_at
          ? guestEndProblem(new Date(b.access_expires_at))
          : 'Choose the day their access ends.';
        if (problem) return refuse(422, 'validation_failed', problem);
      }
      // A guest is always limited (5.34).
      if (b.kind === 'guest' && !b.restriction) {
        return refuse(
          422,
          'validation_failed',
          'A guest is always limited to what they are given. Choose what they can see.',
        );
      }
      // An adult's viewer comes with limits (5.33, A27).
      if (b.role === 'viewer' && storedRole() !== 'owner' && !b.restriction) {
        return refuse(
          403,
          'forbidden',
          'Only an owner can invite a viewer who sees every family document. Choose what they can see.',
        );
      }
      const invitation = {
        kind: b.kind ?? 'family',
        access_expires_at: b.access_expires_at ?? null,
        relationship: b.relationship ?? null,
        restriction: b.restriction ?? null,
        limited: Boolean(b.restriction),
        id: `inv-${state.invitations.length}`,
        member_id: b.member_id ?? `m-${state.members.length}`,
        display_name: b.display_name ?? 'Someone',
        email: b.email,
        role: b.role,
        invited_by: 'Mansoor Seikh',
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
        state: 'pending',
        attempts_left: 5,
      };
      state.invitations.push(invitation);
      return json(
        { invitation, link_token: 'link-secret-0123456789abcdef', code: 'ABCD-EFGH' },
        201,
      );
    }
    if (path.startsWith('/api/v1/invitations/') && !state.invitationValid) {
      return json(
        {
          error: {
            code: 'invitation_not_valid',
            message:
              'That invitation link is not valid any more. Ask whoever invited you to send a new one.',
            retriable: false,
            request_id: 'r',
          },
        },
        404,
      );
    }
    if (path.startsWith('/api/v1/invitations/') && path.endsWith('/accept')) {
      if ((body as { code: string }).code.toUpperCase().replace(/[^A-Z0-9]/g, '') !== 'ABCDEFGH') {
        return json(
          {
            error: {
              code: 'invitation_code_wrong',
              message: 'That code is not right. 4 tries left.',
              retriable: false,
              request_id: 'r',
            },
          },
          401,
        );
      }
      return json(TOKENS, 201);
    }
    // The path form, and since 0.5.17 the token in a body.
    if (
      path.startsWith('/api/v1/invitations/') &&
      (method === 'GET' || (method === 'POST' && path === '/api/v1/invitations/lookup'))
    ) {
      return json({
        household_name: 'The Seikh family',
        display_name: 'Sam',
        // Masked, as the vault shows it before the code (5.3).
        email: 's•••@example.test',
        role: 'adult',
        role_label: 'Adult',
        invited_by: 'Mansoor Seikh',
        expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
        ...state.invitationPreview,
      });
    }
    if (path.startsWith('/api/v1/invitations/') && method === 'DELETE') {
      const id = path.slice('/api/v1/invitations/'.length);
      state.invitations = state.invitations.filter((i) => i.id !== id);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    // Kinds of document, managed (5.12), as the vault manages them (0.5.10).
    if (path === '/api/v1/document-types' && method === 'GET') {
      // A hidden kind is listed with ?all=true (the editor's list), and,
      // marked hidden, while a document uses it, so that one still says
      // what it is — as the vault lists them (0.5.6).
      const all = query.get('all') === 'true';
      const used = (key: unknown) => state.documents.some((d) => d.type_key === key);
      return json({ items: state.types.filter((t) => all || !t.hidden || used(t.key)) });
    }
    if (path === '/api/v1/document-attributes' && method === 'GET') {
      return json({ items: state.attributes ?? [] });
    }
    if (path === '/api/v1/document-attributes' && method === 'POST') {
      const b = body as { label: string; kind: string; choices?: string[] | null };
      const made = {
        key: `h_field${(state.attributes ?? []).length}`,
        label: b.label,
        kind: b.kind,
        choices: b.kind === 'choice' ? (b.choices ?? []) : null,
        builtin: false,
      };
      state.attributes = [...(state.attributes ?? []), made];
      return json(made, 201);
    }
    if (path === '/api/v1/document-types' && method === 'POST') {
      const made = changedKind(
        {
          key: `h_kind${state.types.length}`,
          label: '',
          category: 'other',
          fields: [],
          expiry_driver: null,
          reminder_leads: [],
          remind_from: null,
          remind_leads: [],
          usually_essential: false,
          default_visibility: 'household',
          issued_by_label: null,
          builtin: false,
          hidden: false,
          core: {},
        },
        body as Record<string, unknown>,
        state.attributes ?? [],
        true,
      );
      if ('problem' in made) {
        return refuse(422, 'validation_failed', made.problem.message, {
          detail: made.problem.detail,
        });
      }
      // Never pushed: `types` may be the shared TYPES of another test.
      state.types = [...state.types, { ...made.kind, etag: `"${String(made.kind.key)}.1"` }];
      return json(state.types[state.types.length - 1], 201);
    }
    const kindAt = /^\/api\/v1\/document-types\/([^/]+)(\/archive|\/restore|\/impact)?$/.exec(path);
    if (kindAt) {
      const kind = state.types.find((t) => t.key === decodeURIComponent(kindAt[1] as string));
      if (!kind) return refuse(404, 'not_found', 'That kind of document is not on the list.');
      const keep = (next: Record<string, unknown>) => {
        const saved = { ...next, etag: `"${String(kind.key)}.${state.calls.length}"` };
        state.types = state.types.map((t) => (t === kind ? saved : t));
        return json(saved);
      };
      if (kindAt[2] === '/impact') {
        return json(
          state.impact?.[String(kind.key)] ?? {
            key: kind.key,
            documents: 0,
            in_trash: 0,
            core: Object.fromEntries(
              [
                'identifier',
                'issued_by',
                'issued',
                'expires',
                'physical_location',
                'tags',
                'notes',
              ].map((f) => [f, { with_value: 0, without_value: 0 }]),
            ),
            fields: [],
            reminders: 0,
            reminders_by_source: {},
            unseen: "Documents you can't see may also be affected.",
          },
        );
      }
      if (kindAt[2] && method === 'POST') {
        return keep({ ...kind, hidden: kindAt[2] === '/archive' });
      }
      if (method === 'PATCH') {
        const ifMatch = (init?.headers as Record<string, string> | undefined)?.['if-match'];
        if (ifMatch && ifMatch !== kind.etag) {
          return refuse(
            409,
            'conflict',
            'Someone else changed this kind of document. Reload and try again.',
          );
        }
        // Letting more people see its next document: an owner's, confirmed.
        const reach: Record<string, number> = { private: 1, adults: 2, household: 3 };
        const to = (body as { default_visibility?: string }).default_visibility;
        if (to && (reach[to] ?? 0) > (reach[String(kind.default_visibility)] ?? 0)) {
          if (storedRole() !== 'owner') {
            return refuse(
              403,
              'forbidden',
              'Only an owner can let more people see a kind of document from now on.',
            );
          }
          if (state.stepUpNeeded) return stepUp('widen_type_visibility');
        }
        const next = changedKind(
          kind,
          body as Record<string, unknown>,
          state.attributes ?? [],
          false,
        );
        if ('problem' in next) {
          return refuse(422, 'validation_failed', next.problem.message, {
            detail: next.problem.detail,
          });
        }
        return keep(next.kind);
      }
    }
    if (
      state.collections &&
      (path === '/api/v1/collections' ||
        path.startsWith('/api/v1/collections/') ||
        /^\/api\/v1\/documents\/[^/]+\/collections$/.test(path))
    ) {
      const ifMatch = (init?.headers as Record<string, string> | undefined)?.['if-match'];
      return answerCollections(state, method, path, query, body, ifMatch);
    }
    if (path === '/api/v1/documents/counts') {
      return json({
        by_member: [{ member_id: 'me', count: state.documents.length }],
        by_category: [{ category: 'identity', count: state.documents.length }],
      });
    }
    if (path === '/api/v1/documents' && method === 'GET') {
      // The Trash is its own list (5.1), as the vault's `deleted=true` is.
      const inTrash = query.get('deleted') === 'true';
      let items = state.documents.filter((d) => Boolean(d.deleted_at) === inTrash);
      // An owner's requests to remove for good, by themselves (5.24).
      const asked = query.get('purge_requested');
      if (asked) items = items.filter((d) => Boolean(d.purge_requested_at) === (asked === 'true'));
      if (state.pageSize) {
        const start = Number(query.get('cursor') ?? 0);
        const more = start + state.pageSize < items.length;
        return json({
          items: items.slice(start, start + state.pageSize).map(listed),
          next_cursor: more ? String(start + state.pageSize) : null,
          has_more: more,
        });
      }
      const cat = query.get('category');
      if (cat) items = items.filter((d) => d.category === cat);
      const from = query.get('issued_by');
      if (from) items = items.filter((d) => sameIssuer(d.issued_by, from));
      // One person's (5.17c): their documents, and their profile's first few.
      const whose = query.get('member_id');
      if (whose) items = items.filter((d) => d.owner_member_id === whose);
      return json({ items: items.map(listed), next_cursor: null, has_more: false });
    }
    if (path === '/api/v1/issuers') {
      // Distinct, most used first; those used for type_key before the rest.
      const typeKey = query.get('type_key');
      const q = (query.get('q') ?? '').trim().toLowerCase();
      const rows = new Map<string, { issued_by: string; count: number; forType: boolean }>();
      for (const d of state.documents) {
        const name = typeof d.issued_by === 'string' ? d.issued_by.trim() : '';
        if (!name || !name.toLowerCase().includes(q)) continue;
        if (query.get('category') && d.category !== query.get('category')) continue;
        if (query.get('member_id') && d.owner_member_id !== query.get('member_id')) continue;
        const row = rows.get(name.toLowerCase()) ?? { issued_by: name, count: 0, forType: false };
        row.count += 1;
        if (typeKey && d.type_key === typeKey) row.forType = true;
        rows.set(name.toLowerCase(), row);
      }
      const items = [...rows.values()]
        // As the vault: for a type, only those who have issued that type.
        .filter((r) => !typeKey || r.forType)
        .sort(
          (a, b) =>
            Number(b.forType) - Number(a.forType) ||
            b.count - a.count ||
            a.issued_by.localeCompare(b.issued_by),
        )
        .map(({ issued_by, count }) => ({ issued_by, count }));
      return json({ items });
    }
    if (path === '/api/v1/capture') {
      if (state.captureFailures) {
        state.captureFailures -= 1;
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      const form = init?.body as FormData;
      const fields = [...form.keys()];
      const raw = form.get('metadata');
      const metadata =
        typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : null;
      (state.captures ??= []).push({ fields, metadata });
      const doc = {
        ...PASSPORT,
        id: 'doc-new',
        type_key: (metadata?.type_key as string | undefined) ?? null,
        title: (metadata?.title as string | undefined) ?? null,
        owner_member_id: (metadata?.owner_member_id as string | undefined) ?? null,
        issued_by: (metadata?.issued_by as string | undefined) ?? null,
        visibility: (metadata?.visibility as string | undefined) ?? 'household',
        notes: (metadata?.notes as string | undefined) ?? null,
        extra: (metadata?.extra as Record<string, unknown> | undefined) ?? {},
        category: null,
        status: metadata?.type_key
          ? { value: 'valid', label: 'Valid' }
          : { value: 'needs_info', label: 'Needs a name' },
        etag: '"new"',
      };
      state.documents.push(doc);
      const key = (init?.headers as Record<string, string> | undefined)?.['idempotency-key'];
      if (key) (state.uploads ??= {})[key] = doc.id;
      if (state.captureAnswersLost) {
        state.captureAnswersLost -= 1;
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      return json(
        { document_id: 'doc-new', version_id: 'v-new', job_id: null, state: 'stored' },
        201,
      );
    }
    const uploadMatch = /^\/api\/v1\/uploads\/([^/]+)$/.exec(path);
    if (uploadMatch) {
      const made = state.uploads?.[uploadMatch[1] as string];
      return made
        ? json({ state: 'done', document_id: made, version_id: 'v-new' })
        : json({ error: { code: 'not_found', message: 'That upload is not known here.' } }, 404);
    }
    const suggestionsMatch = /^\/api\/v1\/documents\/([^/]+)\/issuer-suggestions$/.exec(path);
    if (suggestionsMatch) {
      return json(
        state.issuerSuggestions?.[suggestionsMatch[1] as string] ?? {
          state: 'unavailable',
          items: [],
        },
      );
    }
    const restoreMatch = /^\/api\/v1\/documents\/([^/]+)\/restore$/.exec(path);
    if (restoreMatch && method === 'POST') {
      const doc = state.documents.find((d) => d.id === restoreMatch[1]);
      // Bringing it back cancels an owner's request to remove it (5.24).
      if (doc)
        Object.assign(doc, {
          deleted_at: null,
          purge_requested_at: null,
          purge_allowed_from: null,
        });
      return json(doc);
    }
    // Removing for good (5.24), as the vault does it: owners only, asking to
    // confirm it's you; at once for one they filed;
    // anybody else's asked about first, and removed a day after.
    const purgeMatch = /^\/api\/v1\/documents\/([^/]+)\/purge$/.exec(path);
    if (purgeMatch && method === 'POST') {
      const doc = state.documents.find((d) => d.id === purgeMatch[1]);
      if (!doc) return refuse(404, 'not_found', 'That document is not in the vault.');
      if (!doc.deleted_at) {
        return refuse(409, 'not_in_trash', 'Only a document in the Trash can be removed for good.');
      }
      if (state.stepUpNeeded) {
        return refuse(
          403,
          'step_up_required',
          'Please confirm it is you to remove a document for good.',
          {
            action: 'remove_for_good',
          },
        );
      }
      // At once what the vault says may go at once (purge_at_once): one they
      // filed, or theirs when its filer has gone.
      const theirs = doc.purge_at_once === true;
      if (!theirs && !doc.purge_requested_at) {
        doc.purge_requested_at = state.purgeAskedAt ?? new Date().toISOString();
        doc.purge_allowed_from = new Date(
          Date.parse(doc.purge_requested_at as string) + 24 * 3_600_000,
        ).toISOString();
        return json(listed(doc), 202);
      }
      if (!theirs && Date.parse(doc.purge_allowed_from as string) > Date.now()) {
        return refuse(
          409,
          'purge_not_yet',
          'Whoever filed it has been told, and can bring it back until then.',
        );
      }
      state.documents = state.documents.filter((d) => d !== doc);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    const docMatch = /^\/api\/v1\/documents\/([^/]+)$/.exec(path);
    if (docMatch) {
      const doc = state.documents.find((d) => d.id === docMatch[1]);
      if (!doc)
        return json(
          { error: { code: 'not_found', message: 'That document is not in the vault.' } },
          404,
        );
      if (method === 'DELETE') {
        const answer = () => {
          doc.deleted_at = '2026-09-26T10:04:00Z';
          return new Response(null, { status: 204 });
        };
        return state.holdDelete ? state.holdDelete.then(answer) : Promise.resolve(answer());
      }
      if (method === 'PATCH') {
        // As the vault: taking a check away asks for it first (5.4), and a
        // write made from an older copy is refused, with the document as it
        // is now.
        const ask = askedToLoosen(doc, body as object);
        if (state.stepUpNeeded && ask) return stepUp(ask);
        const ifMatch = (init?.headers as Record<string, string> | undefined)?.['if-match'];
        if (ifMatch && ifMatch !== doc.etag) {
          return json(
            {
              error: {
                code: 'conflict',
                message: 'Someone else changed this document. Reload and try again.',
                retriable: false,
                request_id: 'r',
                detail: JSON.stringify(doc),
              },
            },
            409,
          );
        }
        // Details merge, and null takes one away (0.5.7).
        const change = { ...(body as Record<string, unknown>) };
        if (change.extra && typeof change.extra === 'object') {
          const merged = { ...((doc.extra as Record<string, unknown> | undefined) ?? {}) };
          for (const [k, v] of Object.entries(change.extra)) {
            if (v === null) delete merged[k];
            else merged[k] = v;
          }
          change.extra = merged;
        }
        // A new ETag for every change, as the vault's comes from when it was made.
        Object.assign(doc, change, { etag: `"edit-${state.calls.length}"` });
        return json(doc);
      }
      return json(doc);
    }
    const versionsOf = /^\/api\/v1\/documents\/([^/]+)\/versions$/.exec(path);
    if (versionsOf) {
      // Each document's own current version: the passport's is v-1.
      const doc = state.documents.find((d) => d.id === versionsOf[1]);
      if (method === 'POST') {
        return json(
          {
            id: 'v-new',
            document_id: versionsOf[1],
            version_no: 2,
            filename: 'renewed.pdf',
            mime: 'application/pdf',
            byte_size: 1024,
            sha256: 'y',
            page_count: 1,
            ocr_status: 'pending',
            uploaded_at: '2026-09-26T10:00:00Z',
            uploaded_by_name: 'Mansoor Seikh',
            preview_pages: null,
          },
          201,
        );
      }
      // Details with no file yet have no versions.
      if (doc && doc.latest_version_id === null) return json({ items: [] });
      return json({
        items: [
          {
            id: (doc?.latest_version_id as string | undefined) ?? 'v-1',
            document_id: versionsOf[1],
            version_no: 1,
            filename: 'passport.pdf',
            mime: state.versionMime ?? 'application/pdf',
            byte_size: 2048,
            sha256: 'x',
            page_count: state.pageCount,
            ocr_status: 'done',
            uploaded_at: '2026-09-20T09:14:00Z',
            uploaded_by_name: 'Mansoor Seikh',
            // Sent through a request (5.23), as its reviewers are told.
            sent_through: (doc?.sent_through as string | undefined) ?? null,
            preview_pages:
              state.pagesDrawn === 'unsupported'
                ? 0
                : state.pagesPending > 0
                  ? null
                  : state.pagesDrawn,
            // Its record came back with a restore, its file did not (5.24).
            file_removed: doc?.file_removed === true,
          },
        ],
      });
    }
    const pageOf = /^\/api\/v1\/versions\/[^/]+\/pages\/(\d+)$/.exec(path);
    if (pageOf) {
      const refuse = (code: string, message: string, headers: Record<string, string> = {}) =>
        Promise.resolve(
          Response.json(
            { error: { code, message, retriable: code === 'preview_pending', request_id: 'r' } },
            { status: 404, headers },
          ),
        );
      if (state.pagesDrawn === 'unsupported') {
        return refuse(
          'no_preview',
          "There's no preview for this kind of file. You can save a copy to open it.",
        );
      }
      if (state.pagesPending > 0) {
        state.pagesPending -= 1;
        // No waiting in a test: "try again" means now.
        return refuse('preview_pending', 'The preview is being made.', { 'retry-after': '0' });
      }
      const n = Number(pageOf[1]);
      if (n > state.pagesDrawn) {
        return refuse(
          'no_preview',
          "There's no preview of this page. You can save a copy to open it.",
        );
      }
      return Promise.resolve(
        new Response(`page ${n}`, {
          status: 200,
          headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, no-store' },
        }),
      );
    }
    const contentOf = /^\/api\/v1\/versions\/([^/]+)\/content$/.exec(path);
    if (contentOf) {
      // An Only me or an Essential document asks who is asking first (SEC-17).
      const doc = state.documents.find((d) => d.latest_version_id === contentOf[1]);
      const ask = askedToOpen(doc);
      if (state.stepUpNeeded && ask) return stepUp(ask);
      return Promise.resolve(
        new Response('%PDF-1.4', {
          status: 200,
          headers: { 'content-type': 'application/pdf', 'cache-control': 'private, no-store' },
        }),
      );
    }
    if (/^\/api\/v1\/versions\/[^/]+\/thumbnail$/.test(path))
      return json({ error: { code: 'no_thumbnail', message: 'No preview yet.' } }, 404);
    if (path === '/api/v1/search') {
      const q = query.get('q') ?? '';
      state.lastQuery = q;
      const needle = q.trim().toLowerCase();
      // Documents whose name or issuer has the words, as the index would.
      const named = state.documents
        .filter((d) =>
          [d.title, d.issued_by].some(
            (v) => typeof v === 'string' && needle !== '' && v.toLowerCase().includes(needle),
          ),
        )
        .map((d) => ({
          document_id: d.id,
          title: d.title,
          type_key: d.type_key,
          category: d.category,
          owner_member_id: d.owner_member_id,
          status: d.status,
          issued_by: d.issued_by ?? null,
          issued: d.issued ?? null,
          snippet: '',
          matched_in: 'title',
        }));
      const from = query.get('issued_by');
      // The words inside doc-1's pages, while they are in the index: made
      // Only me, they move to the sealed table, out of the first pass.
      const inPages = state.documents.find((d) => d.id === 'doc-1')?.visibility !== 'private';
      const items = [
        ...(q.includes('4471') && inPages
          ? [
              {
                document_id: 'doc-1',
                title: 'Home insurance policy',
                type_key: 'insurance_policy',
                category: 'insurance',
                owner_member_id: 'me',
                status: { value: 'active', label: 'Valid for 5 months' },
                snippet: '…policy number <em>4471</em>-QB <script>x</script>…',
                matched_in: 'content',
              },
            ]
          : []),
        ...named,
      ].filter((h) => !from || sameIssuer((h as { issued_by?: unknown }).issued_by, from));
      return json({
        items,
        sealed_pending: state.sealed.length
          ? { count: state.sealed.length, token: 'sealed-handle' }
          : { count: 0 },
      });
    }
    if (path === '/api/v1/search/sealed') {
      const q = query.get('token') === 'sealed-handle' ? (state.lastQuery ?? '') : '';
      const items = state.sealed.filter((s) => {
        const snippet = typeof s.snippet === 'string' ? s.snippet : '';
        return snippet.toLowerCase().includes(q.toLowerCase());
      });
      return json({ items, searched: state.sealed.length });
    }
    return Promise.reject(new Error(`unmocked ${method} ${url}`));
  };
  vi.stubGlobal('fetch', fn);
  // A file sent on the page at /drop (5.22) goes by XMLHttpRequest, for its
  // progress: answered by the same fake, halfway first, then whole — held
  // in between while `hold` says so.
  class FakeXhr {
    status = 0;
    responseText = '';
    upload: {
      onprogress: ((e: ProgressEventInit) => void) | null;
      onload: (() => void) | null;
    } = { onprogress: null, onload: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    private method = 'GET';
    private url = '';
    private headers: Record<string, string> = {};
    private answered = new Headers();
    private stopped = false;
    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    }
    getResponseHeader(name: string) {
      return this.answered.get(name);
    }
    abort() {
      if (this.stopped) return;
      this.stopped = true;
      this.onabort?.();
    }
    send(form: FormData) {
      const path = this.url.split('?')[0] ?? this.url;
      const file = form.get('file') as File | null;
      const total = file?.size ?? 0;
      state.calls.push({
        method: this.method,
        url: this.url,
        body: Object.fromEntries(
          [...form.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : v.name]),
        ),
        headers: this.headers,
      });
      void (async () => {
        await Promise.resolve();
        if (this.stopped) return;
        this.upload.onprogress?.({ lengthComputable: true, loaded: Math.floor(total / 2), total });
        await state.hold?.(this.method, path);
        if (this.stopped) return;
        if (state.dropConnectionLost) {
          this.onerror?.();
          return;
        }
        const answer = () =>
          respond(this.url, this.method, path, new URLSearchParams(), undefined, {
            method: this.method,
            body: form,
            headers: this.headers,
          });
        // A request that takes no more files says so at once, before the
        // body has gone (5.21: its room is reserved before a byte is read).
        const d = state.drop;
        if (d && d.files.length >= (d.maxFiles ?? 10)) {
          const refused = await answer();
          this.status = refused.status;
          this.responseText = await refused.text();
          this.answered = refused.headers;
          this.onload?.();
          return;
        }
        // The vault may keep the file before the browser has said that every
        // byte went: a Stop pressed then is too late (the 5.22 review).
        let res = state.dropCommitFirst ? await answer() : undefined;
        if (state.dropCommitFirst) await state.holdAnswer?.();
        if (this.stopped) return;
        this.upload.onprogress?.({ lengthComputable: true, loaded: total, total });
        this.upload.onload?.();
        if (state.dropLostAfterBytes) {
          this.onerror?.();
          return;
        }
        if (!state.dropCommitFirst) await state.holdAnswer?.();
        if (this.stopped) return;
        res ??= await answer();
        if (this.stopped) return;
        // Kept by the vault; the answer lost on its way back.
        if (state.dropAnswerLost) {
          this.onerror?.();
          return;
        }
        this.status = res.status;
        this.responseText = res.status === 204 ? '' : await res.text();
        this.answered = res.headers;
        this.onload?.();
      })();
    }
  }
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  return fn;
}

/**
 * Collections of documents, as the vault answers them (0.5.12): each reader is
 * given the collections their role and the collection's audience allow — a viewer
 * none but their own — and, in each, the documents they could see anyway,
 * counted so. Only a collection's maker changes it, while in its audience (A18);
 * its maker deletes it, or an owner once nobody may change it. A page's
 * cursor names the last document given. Several put in at once — up to
 * 200 — go in together or not at all.
 */
function answerCollections(
  state: FakeState,
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
  ifMatch: string | undefined,
): Promise<Response> {
  const json = (b: unknown, status = 200) => Promise.resolve(Response.json(b, { status }));
  const done = () => Promise.resolve(new Response(null, { status: 204 }));
  const refuse = (status: number, code: string, message: string, more: object = {}) =>
    json({ error: { code, message, retriable: false, request_id: 'r', ...more } }, status);
  const noCollection = () => refuse(404, 'not_found', 'That collection does not exist.');
  const noDocument = () => refuse(404, 'not_found', 'That document is not in the vault.');
  const role = storedRole() as Role;
  const reader = { role, memberId: 'me' };
  const all = state.collections ?? [];
  // And a viewer, the collections an owner gave them (5.33), as the vault's rule does.
  const seesCollection = (l: FakeCollection) =>
    canSeeCollection(reader, l) ||
    (role === 'viewer' &&
      l.audience === 'everyone' &&
      (state.myRestriction?.collections ?? []).some((c) => c.id === l.id));
  const seesDoc = (d: Record<string, unknown> | undefined): d is Record<string, unknown> =>
    d !== undefined &&
    !d.deleted_at &&
    canSee(reader, {
      visibility: String(d.visibility),
      owner_member_id: (d.owner_member_id as string | null | undefined) ?? null,
    });
  const docsOn = (l: FakeCollection) =>
    l.items.map((id) => state.documents.find((d) => d.id === id)).filter(seesDoc);
  const view = (l: FakeCollection) => ({
    id: l.id,
    name: l.name,
    description: l.description,
    audience: l.audience,
    owner_member_id: l.owner_member_id,
    mine: l.owner_member_id === 'me',
    item_count: docsOn(l).length,
    created_at: '2026-09-26T10:00:00Z',
    updated_at: '2026-09-26T10:00:00Z',
    etag: l.etag,
    shared_outside: l.shared_outside ?? null,
  });
  const detail = (l: FakeCollection, from = 0, limit = state.collectionPageSize ?? 50) => {
    const docs = docsOn(l);
    const more = from + limit < docs.length;
    const shown = docs.slice(from, from + limit);
    const last = shown[shown.length - 1];
    return {
      ...view(l),
      items: shown.map((d) => ({
        document: listed(d),
        added_at: '2026-09-26T10:00:00Z',
        hint:
          l.owner_member_id === 'me'
            ? collectionItemHint(l.audience, {
                visibility: String(d.visibility),
                owner_member_id: (d.owner_member_id as string | null | undefined) ?? null,
              })
            : null,
      })),
      // As the vault's: the last document given, and nothing about where
      // it stands among those the reader is not given.
      next_cursor: more && last ? btoa(JSON.stringify({ after: last.id })) : null,
      has_more: more,
    };
  };
  /**
   * Where the page after `cursor` starts: after the document it names, as
   * the reader is given the collection now. One they are not given now — taken
   * out, moved to the Trash — is a cursor that is not valid.
   */
  const startAfter = (l: FakeCollection, cursor: string): number | null => {
    let after: unknown;
    try {
      after = (JSON.parse(atob(cursor)) as { after?: unknown }).after;
    } catch {
      return null;
    }
    const at = docsOn(l).findIndex((d) => d.id === after);
    return at === -1 ? null : at + 1;
  };
  /**
   * An owner may delete somebody else's collection only when nobody may change
   * it any more: its maker has no sign-in, or is not one of its audience.
   */
  const stranded = (l: FakeCollection) => {
    const maker = state.members.find((m) => m.id === l.owner_member_id);
    const makerRole = maker?.role as Role | null | undefined;
    return !makerRole || !inCollectionAudience(makerRole, l.audience);
  };
  const manage = () =>
    role === 'viewer'
      ? refuse(
          403,
          'forbidden',
          'Viewers can open and download documents, but not make collections of them.',
        )
      : null;
  /** Only its maker, in its audience, changes a collection (A18). */
  const refusedChange = (l: FakeCollection) =>
    manage() ??
    (l.owner_member_id !== 'me'
      ? refuse(403, 'forbidden', 'Only the person who made this collection can change it.')
      : !inCollectionAudience(role, l.audience)
        ? refuse(
            403,
            'forbidden',
            'This collection is for people you are no longer one of. You can still delete it, but not change it.',
          )
        : null);
  const tidy = (name: unknown) =>
    typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';

  const onDocument = /^\/api\/v1\/documents\/([^/]+)\/collections$/.exec(path);
  if (onDocument) {
    const id = onDocument[1] as string;
    if (!seesDoc(state.documents.find((d) => d.id === id))) return noDocument();
    return json({ items: all.filter((l) => seesCollection(l) && l.items.includes(id)).map(view) });
  }
  if (path === '/api/v1/collections' && method === 'GET') {
    const seen = all.filter(seesCollection).sort((a, b) => a.name.localeCompare(b.name));
    return json({ items: seen.map(view) });
  }
  if (path === '/api/v1/collections' && method === 'POST') {
    const b = body as {
      name?: unknown;
      audience?: FakeCollection['audience'];
      description?: string | null;
    };
    const refused = manage();
    if (refused) return refused;
    const name = tidy(b.name);
    if (!name) {
      return refuse(422, 'validation_failed', 'Give the collection a name.', { detail: 'name' });
    }
    if (!b.audience) {
      return refuse(422, 'validation_failed', 'Say who the collection is for.', {
        detail: 'audience',
      });
    }
    if (!inCollectionAudience(role, b.audience)) {
      return refuse(403, 'forbidden', 'Only an adult can make a collection for the adults.');
    }
    const made: FakeCollection = {
      id: `collection-${all.length + 1}`,
      name,
      description: b.description?.trim() || null,
      audience: b.audience,
      owner_member_id: 'me',
      etag: `"collection-${all.length + 1}.1"`,
      items: [],
    };
    // Never pushed: the array may be another test's.
    state.collections = [...all, made];
    return json(detail(made), 201);
  }
  // Sharing a collection outside (5.19), as the vault answers it: who may,
  // then the collection, then — for a link — confirming it's you, always.
  const sharing = /^\/api\/v1\/collections\/([^/]+)\/(share-preview|shares)$/.exec(path);
  if (sharing) {
    if (!['owner', 'adult'].includes(role)) {
      return refuse(403, 'forbidden', 'Only an adult can share a document outside the family.');
    }
    const l = all.find((x) => x.id === sharing[1]);
    if (!l || !seesCollection(l)) return noCollection();
    if (l.audience === 'only_me') {
      return refuse(
        422,
        'collection_only_me',
        'An Only me collection is yours alone, so it cannot be shared outside the family. Change who it is for first.',
      );
    }
    const drawable = !state.versionMime || state.versionMime === 'application/pdf';
    if (sharing[2] === 'share-preview' && method === 'GET') {
      return json({
        collection_id: l.id,
        collection_name: l.name,
        audience: l.audience,
        items: docsOn(l).map((d) => {
          const offer = collectionShareItem(l.audience, {
            visibility: String(d.visibility),
            has_file: Boolean(d.latest_version_id),
          });
          return {
            document_id: d.id,
            title: d.title ?? null,
            type_label: null,
            ticked: offer.ticked,
            lock: offer.lock,
            reason: offer.lock ? COLLECTION_SHARE_REASONS[offer.lock] : null,
            viewable: drawable,
          };
        }),
      });
    }
    if (sharing[2] === 'shares' && method === 'POST') {
      if (state.stepUpNeeded) {
        return refuse(
          403,
          'step_up_required',
          'Please confirm it is you to share a collection outside the family.',
          { action: 'share_collection' },
        );
      }
      const b = body as {
        document_ids: string[];
        follow_collection?: boolean;
        recipient_label?: string;
        expires_at?: string;
        permission?: 'view' | 'download';
        max_opens?: number | null;
        with_pin?: boolean;
        with_password?: boolean;
        password?: string;
        code_email?: string;
        this_device_only?: boolean;
      };
      if (!b.document_ids.every((id) => docsOn(l).some((d) => d.id === id))) {
        return refuse(404, 'not_found', 'That document is not in this collection.');
      }
      const end = new Date(b.expires_at ?? Date.now() + 7 * 864e5);
      const share = {
        id: `sh-${state.shares.length}`,
        document_id: null,
        document_title: null,
        collection_id: l.id,
        collection_name: l.name,
        follow_collection: Boolean(b.follow_collection),
        recipient_label: b.recipient_label ?? null,
        created_by_name: 'Mansoor Seikh',
        created_at: new Date().toISOString(),
        expires_at: end.toISOString(),
        has_pin: Boolean(b.with_pin),
        open_count: 0,
        last_opened_at: null,
        state: 'active',
        flow: 'v2',
        permission: b.permission ?? 'download',
        max_opens: b.max_opens ?? null,
        max_downloads: null,
        downloads_used: 0,
        pages: null,
        ...factorsOf(b),
        summary: `${b.recipient_label ? `Shared with ${b.recipient_label}` : 'Shared by link'}, not opened yet. Stops working on 30 September at 17:00.${b.follow_collection ? ' Keeps up with the collection.' : ''}`,
      };
      state.shares.push(share);
      const was = l.shared_outside ?? { with: [], following: false };
      state.collections = all.map((x) =>
        x.id === l.id
          ? {
              ...x,
              shared_outside: {
                with: b.recipient_label ? [...was.with, b.recipient_label] : was.with,
                following: was.following || Boolean(b.follow_collection),
              },
            }
          : x,
      );
      return json(
        {
          share,
          link_token: 'share-secret-0123456789abcdef',
          link_url: state.shareLinkUrl ?? null,
          ...(b.with_pin ? { pin: '4821' } : {}),
          ...(b.with_password ? { password: 'k7mq-p2xa-9htw' } : {}),
        },
        201,
      );
    }
  }
  const at = /^\/api\/v1\/collections\/([^/]+)(\/items(?:\/([^/]+))?)?$/.exec(path);
  if (at?.[2] && !at[3] && method === 'POST') {
    // As the vault's route takes them, before it looks for the collection: one
    // at least, and at most 200.
    const refused = manage();
    if (refused) return refused;
    const ids = (body as { document_ids?: unknown } | undefined)?.document_ids;
    if (!Array.isArray(ids) || ids.length < 1) {
      return refuse(422, 'validation_failed', 'Too small: expected array to have >=1 items');
    }
    if (ids.length > 200) {
      return refuse(422, 'validation_failed', 'Too big: expected array to have <=200 items');
    }
  }
  const collection = at ? all.find((l) => l.id === at[1]) : undefined;
  if (!at || !collection || !seesCollection(collection)) return noCollection();
  const replace = (next: FakeCollection) => {
    state.collections = (state.collections ?? []).map((l) => (l.id === collection.id ? next : l));
    return next;
  };
  if (!at[2]) {
    if (method === 'GET') {
      const cursor = query.get('cursor');
      const from = cursor === null ? 0 : startAfter(collection, cursor);
      if (from === null) {
        return refuse(422, 'validation_failed', 'That page cursor is not valid.');
      }
      const limit = query.get('limit');
      return json(detail(collection, from, limit ? Number(limit) : undefined));
    }
    if (method === 'PATCH') {
      const refused = refusedChange(collection);
      if (refused) return refused;
      if (ifMatch && ifMatch !== collection.etag) {
        return refuse(
          409,
          'conflict',
          'Someone else changed this collection. Reload and try again.',
          {
            detail: JSON.stringify(view(collection)),
          },
        );
      }
      const b = body as {
        name?: unknown;
        audience?: FakeCollection['audience'];
        description?: string | null;
      };
      const name = b.name === undefined ? collection.name : tidy(b.name);
      if (!name)
        return refuse(422, 'validation_failed', 'Give the collection a name.', { detail: 'name' });
      const changed = replace({
        ...collection,
        name,
        audience: b.audience ?? collection.audience,
        description:
          b.description === undefined ? collection.description : b.description?.trim() || null,
        etag: `"${collection.id}.${state.calls.length}"`,
      });
      return json(detail(changed));
    }
    if (method === 'DELETE') {
      // Its maker, whatever their role now; an owner, only when stranded.
      if (collection.owner_member_id !== 'me') {
        const refused = manage();
        if (refused) return refused;
        if (role !== 'owner' || !stranded(collection)) {
          return refuse(
            403,
            'forbidden',
            'Only the person who made this collection can change it.',
          );
        }
      }
      state.collections = (state.collections ?? []).filter((l) => l.id !== collection.id);
      return done();
    }
  }
  const refused = refusedChange(collection);
  if (refused) return refused;
  if (!at[3] && method === 'POST') {
    const ids = (body as { document_ids: string[] }).document_ids;
    // All of them, or none.
    if (!ids.every((id) => seesDoc(state.documents.find((d) => d.id === id)))) return noDocument();
    const changed = replace({
      ...collection,
      items: [
        ...collection.items,
        ...ids.filter((id, i) => !collection.items.includes(id) && ids.indexOf(id) === i),
      ],
    });
    // Who else will now see them (5.33): a viewer the collection is given to.
    return json({
      ...detail(changed),
      ...(state.collectionWarnings?.length ? { warnings: state.collectionWarnings } : {}),
    });
  }
  if (at[3] && method === 'DELETE') {
    const id = decodeURIComponent(at[3]);
    if (!collection.items.includes(id)) {
      return refuse(404, 'not_found', 'That document is not in this collection.');
    }
    replace({ ...collection, items: collection.items.filter((d) => d !== id) });
    return done();
  }
  return Promise.reject(new Error(`unmocked ${method} ${path}`));
}

/**
 * A document as a list gives it: an Only me document's notes and details
 * are sealed, opened only in its owner's own request for it (0.5.8).
 */
function listed(d: Record<string, unknown>): Record<string, unknown> {
  if (d.visibility !== 'private') return d;
  return { ...d, notes: null, has_notes: d.notes != null, extra: {} };
}

/**
 * A kind of document with a change made to it, as the vault makes it
 * (0.5.10): each fixed field key by key (Expires shown is whether it
 * expires), its own fields from the library by key. Then the date it
 * reminds from and how long before, by the vault's own rules (nextReminder,
 * 0.5.15): answered as the vault answers them, `reminder_leads` Expires's
 * alone, and the reminding field always required — or the refusal.
 */
function changedKind(
  kind: Record<string, unknown>,
  change: Record<string, unknown>,
  library: Array<Record<string, unknown>>,
  made: boolean,
): { kind: Record<string, unknown> } | { problem: ReminderProblem } {
  const next: Record<string, unknown> = { ...kind };
  for (const k of ['label', 'category', 'default_visibility', 'usually_essential', 'hidden']) {
    if (change[k] !== undefined) next[k] = change[k];
  }
  type Rule = { shown?: boolean; required?: boolean; label?: string | null };
  const core: Record<string, Rule> = { ...((kind.core ?? {}) as Record<string, Rule>) };
  for (const [f, rule] of Object.entries((change.core ?? {}) as Record<string, Rule>)) {
    core[f] = { shown: true, required: false, label: null, ...core[f], ...rule };
  }
  next.core = core;
  if (core.expires?.shown !== undefined) {
    // One that expires requires its expiry (the 5.11 review).
    core.expires = { ...core.expires, required: core.expires.shown };
    next.expiry_driver = core.expires.shown ? (kind.expiry_driver ?? 'expires_on') : null;
  }
  if (core.issued_by?.label !== undefined) next.issued_by_label = core.issued_by.label;
  if (Array.isArray(change.fields)) {
    const had = (kind.fields ?? []) as Array<Record<string, unknown>>;
    next.fields = (change.fields as Array<{ key: string; required?: boolean }>).map((f) => {
      const was = had.find((x) => x.key === f.key);
      const lib = library.find((a) => a.key === f.key);
      return {
        key: f.key,
        label: was?.label ?? lib?.label ?? f.key,
        kind: was?.kind ?? lib?.kind ?? 'text',
        required: f.required ?? false,
      };
    });
  }
  // What it reminds from, worked out on the kind as it will be.
  const view = kind as unknown as DocumentTypeView;
  const fields = (next.fields ?? []) as Array<{ key: string; kind: string; required?: boolean }>;
  const out = nextReminder(
    {
      remind_from: change.remind_from as string | null | undefined,
      remind_leads: change.remind_leads as number[] | undefined,
      reminder_leads: change.reminder_leads as number[] | undefined,
      fields: change.fields as Array<{ key: string; required?: boolean }> | undefined,
    },
    made ? null : { reminding: reminderOf(view), expires: view.expiry_driver !== null },
    {
      expires: next.expiry_driver !== null,
      dates: fields.filter((f) => f.kind === 'date').map((f) => f.key),
    },
  );
  if ('problem' in out) return out;
  next.remind_from = out.from;
  next.remind_leads = out.leads;
  next.reminder_leads = out.from !== null && out.from !== 'expires' ? [] : out.leads;
  if (out.from !== null && out.from !== 'expires') {
    next.fields = fields.map((f) => (f.key === out.from ? { ...f, required: true } : f));
  }
  return { kind: next };
}

/** One issuer however it was written, as the server compares them. */
function sameIssuer(value: unknown, wanted: string): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === wanted.trim().toLowerCase();
}

/** Whatever role `signedIn()` last stored, defaulting to owner. */
function storedRole(): string {
  try {
    const raw = localStorage.getItem('fdv.session');
    return raw ? ((JSON.parse(raw) as { role?: string }).role ?? 'owner') : 'owner';
  } catch {
    return 'owner';
  }
}

export function signedIn(role: 'owner' | 'adult' | 'teen' | 'viewer' = 'owner') {
  localStorage.setItem(
    'fdv.session',
    JSON.stringify({
      refresh_token: 'hh.secret',
      household_id: 'hh',
      member_id: 'me',
      role,
    }),
  );
}
