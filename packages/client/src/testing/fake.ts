import {
  can,
  canEditIdentity,
  canSee,
  canSeeCollection,
  canSeeIdentity,
  CATEGORY_LABELS,
  checkCaptureMetadata,
  checkExtra,
  COLLECTION_AUDIENCES,
  COLLECTION_DESCRIPTION_MAX,
  COLLECTION_ITEMS_PAGE,
  COLLECTION_ITEMS_PAGE_MAX,
  COLLECTION_NAME_MAX,
  collectionItemHint,
  CORE_FIELDS,
  DECEASED_REFUSAL,
  DECEASED_SIGNED_IN,
  deriveStatus,
  effectiveVisibility,
  EXPIRY_ALWAYS_REQUIRED,
  GUEST_ALWAYS_LIMITED,
  GUEST_MAX_DAYS,
  GUEST_ONLY_VIEWER,
  guestAccessEnded,
  guestAccessEndedWords,
  guestEndProblem,
  IDENTITY_AUDIENCES,
  IDENTITY_EDIT_REFUSAL,
  IDENTITY_NOTICE_HOURS,
  identityAudienceRank,
  identityChanges,
  identityFilled,
  identityTooLong,
  IDENTITY_TOO_LONG,
  inCollectionAudience,
  incomingFileName,
  LOCK_MAX_DAYS,
  LOCK_NOTE_MAX,
  maskIdentity,
  mergeIdentityWrite,
  onlyEveryone,
  restrictionSummary,
  youCanSee,
  revealIdentity,
  libraryHasName,
  missingFields,
  nextReminder,
  PHOTO_MAX_BYTES,
  PHOTO_TYPES,
  PREVIEW_MAX_PAGES,
  PRIVATE_BY_DEFAULT,
  PRIVATE_TO_THEM,
  PURGE_NOTICE_HOURS,
  refusalFor,
  RESET_LINK_MINUTES,
  resetCommand,
  shareEndWords,
  suspensionInEffect,
  TYPE_IN_USE,
  TYPE_LABEL_MAX,
  UNSEEN_DOCUMENTS,
  type AccessGrant,
  type AccessPreview,
  type Capabilities,
  type CaptureMetadata,
  type CollectionAudience,
  type CollectionDetail,
  type CollectionView,
  type CoreField,
  type CoreFieldRule,
  type DateValue,
  type DocumentAttributeView,
  type DocumentTypeImpact,
  type DocumentTypeView,
  type TypeField,
  type DocumentView,
  type IncomingFileView,
  type UploadRequestView,
  type IdentityAudience,
  type IdentityAudienceView,
  type IdentityFields,
  type IdentityPart,
  type IdentityPartView,
  type IssuerSuggestions,
  type Invitation,
  type MemberAccess,
  type MemberAccount,
  type MemberKind,
  type MemberSuspension,
  type MyRestriction,
  type OfflineGrant,
  type OfflineItem,
  type PausedSignIn,
  type ReminderView,
  type ResetNotice,
  type ResetPath,
  type Role,
  type Tokens,
  type VersionView,
  type Visibility,
} from '@fdv/shared';
import type { FetchLike, ResponseLike } from '../http.js';

/**
 * A vault in memory, for testing clients without a server.
 *
 * It covers the endpoints a client's session and capture paths lean on,
 * and it behaves the way the real API does where behaving differently
 * would hide bugs: refresh tokens rotate, and presenting a spent one ends
 * the session. `contract.ts` runs the same scenarios against this and
 * against the real API, so the two cannot drift apart unnoticed.
 */

interface FakeSession {
  id: string;
  refresh: string;
  previous: string | null;
  revoked: boolean;
  /** The app installation that signed in (X-FDV-Installation), as the real vault keeps it. */
  installation?: string | null;
  /** When the refresh token was last replaced, and whether its one replay is spent. */
  rotatedAt?: number;
  graceUsed?: boolean;
  /** Tokens a grace replay touched: presented again, they end the session. */
  graceTokens?: string[];
  /**
   * Every token it has been given and replaced (5.30): as the real vault's
   * tokens name their session, any of them presented again ends it.
   */
  spent?: string[];
  /** Why it ended, as the real vault says it: since 5.28 `suspended`, by a lock. */
  endedBecause?: 'revoked' | 'reused' | 'suspended';
  /** Its offline grant, as the real vault keeps it on the session (0.4.13). */
  offlineGrant?: OfflineGrant | null;
  /**
   * Whose it is, when it is not the fake's own person's (5.28): somebody
   * in `signIns`, who signed in with their own password.
   */
  memberId?: string;
}

export interface FakeVaultState {
  setupRequired: boolean;
  email: string | null;
  password: string | null;
  sessions: FakeSession[];
  /** access token → session id */
  access: Map<string, string>;
  documents: FakeDocument[];
  /**
   * The household's types: a few real ones, by default. GET /document-types
   * answers them as the real vault does (0.5.6): one set `hidden` is left
   * out unless a document uses it, or the client asks with `?all=true`.
   */
  types: DocumentTypeView[];
  /** What GET /document-attributes answers (0.5.6). */
  attributes: DocumentAttributeView[];
  /** What GET /members answers: the one person the fake signs in as, by default. */
  members: Array<{
    id: string;
    display_name: string;
    /** Null for somebody with no sign-in (yet). */
    role: string | null;
    is_me: boolean;
    /** Their photo, once made (0.5.19). */
    photo?: { id: string } | null;
    /** A photo on its way: the next GET /members answers it made, as the vault's worker would. */
    photo_status?: 'processing' | 'failed' | null;
    can_change_photo?: boolean;
    /** Their details (5.25): changed by PATCH /members/{id}, each change a new version. */
    date_of_birth?: string | null;
    relationship?: string | null;
    is_deceased?: boolean;
    version?: number;
    can_edit?: boolean;
    /**
     * Of the family, or a guest from outside it (5.34): a guest is left out
     * of GET /members but for themselves, and an owner lists them with
     * `?kind=guest`. Their sign-in ends at `access_expires_at`.
     */
    kind?: MemberKind;
    access_expires_at?: string | null;
  }>;
  /**
   * Invitations (5.34): what POST /invitations makes and POST
   * /invitations/accept spends — the person made at once (a guest never
   * among the family), their sign-in, role, limits and end once accepted.
   */
  invitations: FakeInvitation[];
  /**
   * The owner's view of each person's sign-in (5.25), by member id: what
   * GET /members/{id}/account answers an owner with two-step sign-in. The
   * fake's owner has none unless a test says (`ownerTwoStep`), and is
   * refused it, as the real vault refuses an owner with only a password.
   */
  memberAccounts: Map<string, MemberAccount>;
  ownerTwoStep: boolean;
  /**
   * People's identity details (5.26), by member id: each part's fields, as
   * the real vault keeps them sealed, and its version. The fake signs in as
   * `fake-member`; another person's Only me part is not there for it.
   */
  identities: Map<
    string,
    Partial<Record<IdentityPart, { fields: IdentityFields; version: number; updated_at: string }>>
  >;
  /** Who reads other people's shared identity details (A34), and a widening waiting its 72 hours. */
  identityAudience: IdentityAudience;
  /**
   * People whose sign-in is switched off, by member id: they could not be
   * told of a wider audience, so it is refused while there are any (5.26).
   */
  signInsOff: string[];
  /**
   * Other people's sign-ins (5.28): each signs in with its own email and
   * password as the person it names, one of `members`, and its sessions are
   * theirs. Its tokens and GET /me, locking and unlocking, the account card
   * and GET /after-restore know who is asking; everything else the fake
   * answers as its one person, whoever asks.
   */
  signIns: Array<{ member_id: string; email: string; password: string }>;
  /**
   * Sign-ins locked by an owner or paused after a restore (5.28), by member
   * id — the fake's own person, `fake-member`, included: a test sets one to
   * show a phone its paused screens. While one is in effect (a lock past
   * its `until` is over, by the clock) the person's sign-in is refused once
   * the password is right (`403 membership_suspended`) and their sessions
   * answer `401 session_ended` with the reason `suspended`, as the real
   * vault's do. `pauseSignIns()` pauses them as a restore does.
   */
  suspensions: Map<string, MemberSuspension>;
  /** The household's clock (5.28): the end of a lock is said in it. UTC, as a new vault's. */
  timezone: string;
  /**
   * What an owner has limited each viewer to (5.33), by member id: what PUT
   * and DELETE /members/{id}/access write, what the preview counts by the
   * real vault's rule, and what GET /me tells the viewer. The fake's lists
   * of documents are not narrowed by it: a phone is (5.36).
   */
  restrictions: Map<string, FakeRestriction>;
  /**
   * Whether whoever runs the vault gave it a mail server (FDV_SMTP_URL),
   * as the contract's real vault has: a reset an owner starts (5.29) then
   * goes by it, `mail`. Without one, `handover` for somebody who keeps
   * nothing private, `operator` for anybody in `keepsPrivate`.
   */
  operatorMail: boolean;
  /**
   * People who keep something private (5.29), by member id: the fake keeps
   * no record of what, as the real vault tells an owner nothing of what.
   */
  keepsPrivate: string[];
  /**
   * That an owner made a link to hand over for somebody's sign-in (5.29),
   * by member id: GET /me's `reset_notice` for them until DELETE
   * /me/reset-notice.
   */
  resetNotices: Map<string, ResetNotice>;
  /** Every password reset an owner started (5.29), in order, for assertions: never a link. */
  resetsStarted: Array<{ member_id: string; path: ResetPath; stop_now: boolean }>;
  identityPending: IdentityAudienceView['pending'];
  /** The photo on its way for each person, by member id: made at the next GET /members (0.5.19). */
  photosOnTheirWay: Map<string, string>;
  /**
   * The role the fake signs everybody in as: an owner, unless a test says
   * otherwise. A viewer is not told who added each version (0.5.11).
   */
  role: Role;
  /** Upload keys and what each made; a key is for one kind of request. */
  captures: Map<string, FakeUpload>;
  /** What GET /reminders answers, whatever the state asked for. */
  reminders: ReminderView[];
  /** What GET /documents/{id}/issuer-suggestions answers, by document; "unavailable" if unset. */
  issuerSuggestions: Map<string, IssuerSuggestions>;
  /**
   * What GET /versions/{id}/pages/{n} answers, by version: how many pages
   * are drawn, or a kind of file the vault cannot draw. A version the fake
   * made and nobody set here is still being drawn (`preview_pending`).
   */
  pages: Map<string, number | 'unsupported'>;
  /**
   * Essentials a phone may keep (0.4.13): the set GET /offline/essentials
   * answers (Only me items only under a grant that includes them), the
   * grant in force, and the ids of the opens already received.
   */
  offlineEssentials: { items: OfflineItem[]; received: Set<string> };
  /**
   * Collections of documents (0.5.12), as the real vault keeps them: each made by
   * the one member the fake signs in as — or, put here by a test, by one of
   * `state.members`, or by somebody with no sign-in there — and marked
   * deleted, never removed.
   */
  collections: FakeCollection[];
  /**
   * Requests to send documents (0.5.21), as GET /upload-requests answers
   * them: made by the one member the fake signs in as. A test may set a
   * request's `files_received` to stand for files that came in (5.31's
   * incoming push).
   */
  uploadRequests: UploadRequestView[];
  /**
   * Files sent through a request and waiting to be looked at (0.5.23), as
   * GET /incoming answers them, with their bytes: a test puts one here as a
   * sender would send it, ready (its scan and pages done) unless it says.
   */
  incoming: FakeIncoming[];
  /** Every request, in order, for assertions. */
  calls: Array<{ method: string; path: string }>;
  /** When true, every request fails as if the network were down. */
  offline: boolean;
}

/** A viewer's limits, as the fake keeps them (5.33): the flags always said. */
/** An invitation as the fake keeps it (5.34): its secrets in the clear, as only a fake may. */
export interface FakeInvitation {
  view: Invitation;
  token: string;
  code: string;
  restriction: AccessGrant | null;
  by_owner: boolean;
}

export interface FakeRestriction extends AccessGrant {
  limits_people: boolean;
  limits_types: boolean;
  reconfirm_since: string | null;
  private_confirmed: boolean;
  updated_at: string;
}

/** A file sent in, as the fake keeps one (0.5.23): its view, and what it is. */
export type FakeIncoming = IncomingFileView & {
  bytes: Uint8Array;
  /** Filed or refused: no longer waiting, and answered `already_decided`. */
  decided?: 'accepted' | 'rejected';
};

type FakeDocument = {
  id: string;
  title: string | null;
  revision?: number;
  /** In the Trash since (5.1): out of every list but the Trash's. */
  deleted_at?: string | null;
  /** An owner asked to remove it for good, then (5.24). */
  purge_requested_at?: string | null;
  /**
   * Filed by somebody other than the one person the fake signs in as: a test
   * sets it, to have an owner ask before removing it for good (5.24).
   */
  filedBySomeoneElse?: boolean;
} & Omit<CaptureMetadata, 'title'>;

/** A collection of documents, as the fake keeps one (0.5.12). */
export interface FakeCollection {
  id: string;
  name: string;
  description: string | null;
  audience: CollectionAudience;
  owner_member_id: string;
  created_at: string;
  updated_at: string;
  /** Moved by a change to its name, words or audience — never its items — as its ETag says. */
  revision: number;
  deleted: boolean;
  /** In the order they were put in it. */
  items: Array<{ document_id: string; added_at: string }>;
}

/** What the fake keeps from an edit; anything else it refuses to pretend to keep. */
const FAKE_EDITABLE = [
  'type_key',
  'extra',
  'title',
  'owner_member_id',
  'identifier',
  'issued_by',
  'expires',
  'notes',
];

/** A document's version, as an If-Match names it: changed by every edit. */
const etagOf = (doc: FakeDocument) => `"${doc.id}.${doc.revision ?? 1}"`;

/**
 * The fixed fields as a built-in asks for them (0.5.6): every one shown, in
 * the app's own words — but an expiry only for a type that expires, and the
 * issuer by the type's word for it. Required, and named, as the built-in
 * says (0.5.7: a passport's number and expiry).
 */
function coreOf(
  type: { expiry_driver: string | null; issued_by_label?: string | null },
  own: Partial<Record<CoreField, Partial<CoreFieldRule>>> = {},
): Record<CoreField, CoreFieldRule> {
  const core = Object.fromEntries(
    CORE_FIELDS.map((f) => [f, { shown: true, required: false, label: null, ...own[f] }]),
  ) as Record<CoreField, CoreFieldRule>;
  core.expires.shown = type.expiry_driver !== null;
  core.issued_by.label = type.issued_by_label ?? null;
  return core;
}

const builtin = (
  t: Omit<DocumentTypeView, 'builtin' | 'hidden' | 'core'>,
  core: Partial<Record<CoreField, Partial<CoreFieldRule>>> = {},
): DocumentTypeView => ({
  short_label: null,
  issuer_noun: null,
  ...t,
  builtin: true,
  hidden: false,
  core: coreOf(t, core),
});

const FAKE_TYPES: DocumentTypeView[] = [
  builtin(
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
    { identifier: { required: true, label: 'Passport number' }, expires: { required: true } },
  ),
  builtin({
    key: 'bank_statement',
    label: 'Bank / investment statement',
    category: 'financial',
    fields: [
      { key: 'account_last4', label: 'Account (last 4)', kind: 'text', required: false },
      { key: 'period', label: 'Period', kind: 'text', required: false },
    ],
    expiry_driver: null,
    reminder_leads: [],
    usually_essential: false,
    default_visibility: 'adults',
    issued_by_label: 'Institution',
    short_label: 'Bank statement',
    issuer_noun: 'statement',
  }),
  builtin({
    key: 'birth_certificate',
    label: 'Birth certificate',
    category: 'identity',
    fields: [
      { key: 'registration_no', label: 'Registration number', kind: 'text', required: false },
      { key: 'place_of_birth', label: 'Place of birth', kind: 'text', required: false },
    ],
    expiry_driver: null,
    reminder_leads: [],
    usually_essential: true,
    default_visibility: 'household',
    issued_by_label: null,
  }),
  builtin({
    key: 'utility_bill',
    label: 'Utility / bill',
    category: 'bills',
    fields: [
      { key: 'account', label: 'Account', kind: 'text', required: false },
      { key: 'amount', label: 'Amount', kind: 'text', required: false },
    ],
    expiry_driver: 'expires_on',
    reminder_leads: [7, 1],
    usually_essential: false,
    default_visibility: 'household',
    issued_by_label: 'Provider',
    short_label: 'Bill',
    issuer_noun: 'bill',
  }),
];

/** What GET /document-attributes answers: some of the library the real vault starts with. */
const FAKE_ATTRIBUTES: DocumentAttributeView[] = [
  { key: 'account_last4', label: 'Account (last 4)', kind: 'text', choices: null, builtin: true },
  { key: 'period', label: 'Period', kind: 'text', choices: null, builtin: true },
  { key: 'place_of_birth', label: 'Place of birth', kind: 'text', choices: null, builtin: true },
  {
    key: 'registration_no',
    label: 'Registration number',
    kind: 'text',
    choices: null,
    builtin: true,
  },
  { key: 'tax_year', label: 'Tax year', kind: 'year', choices: null, builtin: true },
  // What a bill reminds from, when its household says so (0.5.15).
  { key: 'due_date', label: 'Due date', kind: 'date', choices: null, builtin: true },
];

/**
 * The date a kind reminds from, as the real vault answers it (0038): the
 * one it keeps, while it shows that date and has lead times; else null.
 * The fake keeps a kind's date in `remind_from` and its lead times in
 * `reminder_leads`, and answers both as the vault does (`typeAnswer`).
 */
function remindingFrom(t: DocumentTypeView): string | null {
  const from = t.remind_from ?? null;
  if (from === null || t.reminder_leads.length === 0) return null;
  if (from === 'expires') return t.expiry_driver !== null ? from : null;
  return t.fields.some((f) => f.key === from && f.kind === 'date') ? from : null;
}

/**
 * One part of a multipart body: a field's value, or a file (value null)
 * with its name, type and size as the fake can tell them.
 */
interface Part {
  name: string;
  value: string | null;
  filename?: string;
  type?: string;
  size?: number;
}

/**
 * The parts of a multipart body the fake cares about, in order: its fields
 * and whether each came before the file, and the file's name, type and
 * size. Bytes are read as text, which is enough for the details and a
 * test's small PDF (a binary file's size is only near enough).
 */
function partsOf(body: unknown): Part[] | null {
  if (body instanceof Uint8Array) {
    const text = new TextDecoder().decode(body);
    const out: Part[] = [];
    const header =
      /Content-Disposition: form-data; name="([^"]*)"(; filename="([^"]*)")?([^]*?)\r\n\r\n/g;
    for (const m of text.matchAll(header)) {
      const start = (m.index ?? 0) + m[0].length;
      const end = text.indexOf('\r\n--', start);
      if (m[2]) {
        out.push({
          name: m[1] as string,
          value: null,
          filename: m[3] as string,
          type:
            /Content-Type: ([^\r\n]+)/i.exec(m[4] ?? '')?.[1]?.trim() ?? 'application/octet-stream',
          size: new TextEncoder().encode(text.slice(start, end)).length,
        });
        continue;
      }
      out.push({ name: m[1] as string, value: text.slice(start, end) });
    }
    return out;
  }
  const entries = (body as { entries?: () => Iterable<[string, unknown]> } | null)?.entries;
  if (typeof entries === 'function') {
    return [...entries.call(body)].map(([name, value]) => {
      if (typeof value === 'string') return { name, value };
      // A platform File or Blob: what it says of itself.
      const file = value as { name?: unknown; type?: unknown; size?: unknown } | null;
      return {
        name,
        value: null,
        filename: typeof file?.name === 'string' ? file.name : 'file',
        type: typeof file?.type === 'string' && file.type ? file.type : 'application/octet-stream',
        size: typeof file?.size === 'number' ? file.size : 0,
      };
    });
  }
  return null;
}

interface FakeUpload {
  kind: 'capture' | 'version';
  document_id: string;
  version_id: string;
  /** The version as GET /documents/{id}/versions lists it (0.5.11). */
  version_no: number;
  filename: string;
  mime: string;
  byte_size: number;
  uploaded_at: string;
}

/** The fake's installation id, as a real vault reports its own. */
export const FAKE_INSTANCE_ID = '3b9e1d2c-7a6f-4e5d-9c8b-1a2f3e4d5c6b';

/** Upload keys are UUIDs, written the usual way. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How many days a phone shows its Essentials without reaching the vault: the vault's default. */
const FAKE_OFFLINE_MAX_DAYS = 90;

/** The one person the fake signs in as, unless somebody in `signIns` signs in (5.28). */
const ME = 'fake-member';

export function createFakeVault(): {
  fetch: FetchLike;
  state: FakeVaultState;
  /**
   * What a restore does to sign-ins (5.28, A55): every one but the owners'
   * paused, for an owner to turn back on — the fake's own person's too,
   * when `role` is not an owner — a lock in force kept as a lock, with no
   * end of its own any more; and every session ended, as a restore ends
   * them (`revoked`).
   */
  pauseSignIns: () => void;
} {
  const state: FakeVaultState = {
    setupRequired: true,
    email: null,
    password: null,
    sessions: [],
    access: new Map(),
    documents: [],
    captures: new Map(),
    reminders: [],
    issuerSuggestions: new Map(),
    pages: new Map(),
    offlineEssentials: { items: [], received: new Set() },
    // Each reminds from Expires where it expires and has lead times, as
    // every kind did before 0.5.15.
    types: FAKE_TYPES.map((t) => ({
      ...t,
      remind_from: t.expiry_driver !== null && t.reminder_leads.length > 0 ? 'expires' : null,
    })),
    attributes: FAKE_ATTRIBUTES.map((a) => ({ ...a })),
    members: [{ id: 'fake-member', display_name: 'Fake Owner', role: 'owner', is_me: true }],
    invitations: [],
    photosOnTheirWay: new Map(),
    memberAccounts: new Map(),
    ownerTwoStep: false,
    identities: new Map(),
    identityAudience: 'owners_and_self',
    identityPending: null,
    signInsOff: [],
    signIns: [],
    suspensions: new Map(),
    timezone: 'UTC',
    restrictions: new Map(),
    operatorMail: true,
    keepsPrivate: [],
    resetNotices: new Map(),
    resetsStarted: [],
    role: 'owner',
    collections: [],
    uploadRequests: [],
    incoming: [],
    calls: [],
    offline: false,
  };
  let n = 0;
  const next = (prefix: string) => `${prefix}-${++n}`;
  /** A document's versions: what each upload to it, or the capture that made it, stored. */
  const versionsOf = (documentId: string) =>
    [...state.captures.values()].filter((c) => c.document_id === documentId);

  // Kinds of document, managed (0.5.10): each kind's version, which every
  // change moves on, as its ETag says.
  const revisions = new Map<string, number>();
  const typeTag = (t: DocumentTypeView) => `"${t.key}.${revisions.get(t.key) ?? 1}"`;
  const bump = (t: DocumentTypeView) => revisions.set(t.key, (revisions.get(t.key) ?? 1) + 1);
  /**
   * A kind as the real vault answers it: its ETag, and an expiry required
   * exactly when it expires, whatever its rule once said (0.5.10). The date
   * it reminds from and its lead times (0.5.15); `reminder_leads` is
   * Expires's alone, `[]` while a date field reminds, as an older phone
   * reads it; and the reminding field always required.
   */
  const typeAnswer = (t: DocumentTypeView): DocumentTypeView => {
    const from = remindingFrom(t);
    return {
      ...t,
      fields: t.fields.map((f) => (f.key === from ? { ...f, required: true } : f)),
      reminder_leads: t.remind_from && t.remind_from !== 'expires' ? [] : [...t.reminder_leads],
      remind_from: from,
      remind_leads: [...t.reminder_leads],
      ...(t.core
        ? {
            core: {
              ...t.core,
              expires: { ...t.core.expires, required: t.expiry_driver !== null },
            },
          }
        : {}),
      etag: typeTag(t),
    };
  };
  /**
   * What a kind reminds from after a change, by the rules the real vault
   * keeps (`nextReminder`, 0.5.15), worked out on `next`, the kind as it
   * will be: a refusal, or null with `next` changed.
   */
  const remind = (
    before: DocumentTypeView | null,
    next: DocumentTypeView,
    body: Record<string, unknown>,
  ): ResponseLike | null => {
    const out = nextReminder(
      {
        remind_from: body.remind_from as string | null | undefined,
        remind_leads: body.remind_leads as number[] | undefined,
        reminder_leads: body.reminder_leads as number[] | undefined,
        fields: body.fields as TypeChange['fields'],
      },
      before
        ? {
            reminding: { from: remindingFrom(before), leads: leadsOf(before.reminder_leads) },
            expires: before.expiry_driver !== null,
          }
        : null,
      {
        expires: next.expiry_driver !== null,
        dates: next.fields.filter((f) => f.kind === 'date').map((f) => f.key),
      },
    );
    if ('problem' in out) {
      return fail(422, 'validation_failed', out.problem.message, out.problem.detail);
    }
    next.remind_from = out.from;
    next.reminder_leads = out.leads;
    if (out.from !== null && out.from !== 'expires') {
      next.fields = next.fields.map((f) => (f.key === out.from ? { ...f, required: true } : f));
    }
    return null;
  };
  /**
   * A change to a kind's fixed fields and its own fields, as the real vault
   * makes it: each fixed field key by key (Expires on or off is whether it
   * expires, and an expiry is required exactly when it does), its own
   * fields from the library by key, names 80 characters at most. A refusal,
   * or null.
   */
  const changeType = (t: DocumentTypeView, change: TypeChange): ResponseLike | null => {
    const asked = change.core?.expires;
    if (asked?.required !== undefined) {
      const expires = asked.shown ?? t.expiry_driver !== null;
      if (asked.required !== expires) {
        return fail(
          422,
          'validation_failed',
          expires ? EXPIRY_ALWAYS_REQUIRED : 'A field has to be shown to be required.',
          'expires',
        );
      }
    }
    const long = tooLong([
      ...CORE_FIELDS.map((f) => [change.core?.[f]?.label, 'A field’s name'] as const),
      ...(change.fields ?? []).map((f) => [f.label, 'A field’s name'] as const),
    ]);
    if (long) return long;
    const core = t.core ?? coreOf(t);
    for (const f of CORE_FIELDS) {
      const rule = change.core?.[f];
      if (!rule) continue;
      if (rule.shown !== undefined) core[f].shown = rule.shown;
      if (rule.required !== undefined && f !== 'expires') core[f].required = rule.required;
      if (rule.label !== undefined) core[f].label = tidy(rule.label);
    }
    t.core = core;
    t.expiry_driver = core.expires.shown ? (t.expiry_driver ?? 'expires_on') : null;
    core.expires.required = t.expiry_driver !== null;
    t.issued_by_label = core.issued_by.label;
    for (const f of CORE_FIELDS) {
      if (f !== 'expires' && core[f].required && !core[f].shown) {
        return fail(422, 'validation_failed', 'A field has to be shown to be required.', f);
      }
    }
    if (change.fields) {
      const keys = change.fields.map((f) => f.key);
      if (new Set(keys).size !== keys.length) {
        return fail(422, 'validation_failed', 'Each field can be asked for once.', 'fields');
      }
      const fields: TypeField[] = [];
      for (const f of change.fields) {
        const had = t.fields.find((x) => x.key === f.key);
        const lib = state.attributes.find((a) => a.key === f.key);
        const kind = had?.kind ?? lib?.kind;
        if (!kind)
          return fail(422, 'validation_failed', 'That field is not in the library.', f.key);
        fields.push({
          key: f.key,
          label: tidy(f.label) ?? had?.label ?? lib?.label ?? f.key,
          kind,
          required: f.required ?? had?.required ?? false,
          ...(kind === 'choice' ? { choices: lib?.choices ?? had?.choices ?? [] } : {}),
        });
      }
      t.fields = fields;
    }
    return null;
  };

  /** Somebody's role now: the fake's own person's is `role`; a person without a sign-in, none. */
  const roleOfMember = (memberId: string): Role | null =>
    memberId === ME
      ? state.role
      : ((state.members.find((m) => m.id === memberId)?.role as Role | undefined) ?? null);
  /** Whose a session is (5.28): the fake's own person, or somebody in `signIns`. */
  const whoOf = (s: FakeSession): { memberId: string; role: Role } => ({
    memberId: s.memberId ?? ME,
    role: s.memberId === undefined ? state.role : (roleOfMember(s.memberId) ?? 'viewer'),
  });
  /** A lock or a pause in effect for somebody now (5.28): a lock past its end is over. */
  const suspensionOf = (memberId: string): MemberSuspension | null => {
    const s = state.suspensions.get(memberId);
    return s && suspensionInEffect({ suspended_at: s.since, suspended_until: s.until }) ? s : null;
  };
  /**
   * Which way a reset an owner starts for somebody goes now (5.29): none for
   * an owner (A50) or somebody locked or paused; the operator's mail when
   * there is some; otherwise a link to hand over, unless they keep anything
   * private.
   */
  const resetPathOf = (memberId: string): ResetPath | null => {
    if (roleOfMember(memberId) === 'owner' || suspensionOf(memberId) !== null) return null;
    if (state.operatorMail) return 'mail';
    return state.keepsPrivate.includes(memberId) ? 'operator' : 'handover';
  };
  /** A guest's sign-in past its end (5.34, A28): it signs nobody in, and its sessions answer nothing. */
  const guestEndOf = (memberId: string): string | null => {
    const m = state.members.find((x) => x.id === memberId);
    return m?.kind === 'guest' && guestAccessEnded(m.access_expires_at)
      ? (m.access_expires_at as string)
      : null;
  };
  /** Everybody with a sign-in: the fake's own person, and each of `members` with a role. */
  const withSignIn = () => [
    ME,
    ...state.members.filter((m) => m.id !== ME && Boolean(m.role)).map((m) => m.id),
  ];

  // ----------------------------------------------- a viewer's limits (5.33)

  /** The documents of the collections a grant gives: for Everyone, and not deleted (A17). */
  const collectionDocuments = (g: AccessGrant) =>
    new Set(
      state.collections
        .filter((c) => g.collections.includes(c.id) && !c.deleted && c.audience === 'everyone')
        .flatMap((c) => c.items.map((i) => i.document_id)),
    );
  /** The real vault's rule (0054's doc_in_grant), for one document. */
  const grantGives = (
    memberId: string | null,
    g: AccessGrant,
    d: FakeDocument,
    inCollections: Set<string>,
  ): boolean => {
    if (g.expires_at !== null && Date.parse(g.expires_at) <= Date.now()) return false;
    const visibility = d.visibility ?? 'household';
    const owner = d.owner_member_id ?? null;
    const ceiling =
      visibility === 'household' ||
      (visibility === 'adults' && g.include_adults_only) ||
      (visibility === 'private' && owner !== null && owner === memberId);
    if (!ceiling) return false;
    if (owner !== null && owner === memberId) return true;
    const limitsPeople = g.limits_people === true || g.people.length > 0;
    const limitsTypes = g.limits_types === true || g.types.length > 0;
    const byPerson =
      owner === null
        ? g.include_no_person_docs
        : limitsPeople
          ? g.people.includes(owner)
          : limitsTypes;
    if (byPerson && (!limitsTypes || g.types.includes(d.type_key ?? ''))) return true;
    return (owner !== null || g.include_no_person_docs) && inCollections.has(d.id);
  };
  /** Somebody's limits as an owner is shown them. */
  const accessView = (memberId: string): MemberAccess | null => {
    const r = state.restrictions.get(memberId);
    if (!r) return null;
    const { reconfirm_since, private_confirmed, updated_at, ...grant } = r;
    // Only collections that still grant, as the real vault shows them.
    const collections = grant.collections.filter((id) =>
      state.collections.some((c) => c.id === id && !c.deleted && c.audience === 'everyone'),
    );
    return {
      member_id: memberId,
      ...grant,
      collections,
      summary: restrictionSummary(
        {
          people: grant.people.length,
          types: grant.types.length,
          collections: collections.length,
          include_adults_only: grant.include_adults_only,
          include_no_person_docs: grant.include_no_person_docs,
          expires_at: grant.expires_at,
          limits_people: grant.limits_people,
          limits_types: grant.limits_types,
        },
        state.timezone,
      ),
      reconfirm_since,
      private_confirmed,
      updated_at,
    };
  };
  /** What a restricted viewer is told on GET /me: names they are given. */
  const myRestriction = (memberId: string): MyRestriction | null => {
    const r = state.restrictions.get(memberId);
    if (!r) return null;
    const people = state.members
      .filter((m) => r.people.includes(m.id))
      .map((m) => ({ id: m.id, display_name: m.display_name }));
    const types = state.types
      .filter((t) => r.types.includes(t.key))
      .map((t) => ({ key: t.key, label: t.short_label ?? t.label }));
    const collections = state.collections
      .filter((c) => r.collections.includes(c.id) && !c.deleted && c.audience === 'everyone')
      .map((c) => ({ id: c.id, name: c.name }));
    return {
      summary: youCanSee(
        {
          people,
          types,
          collections,
          include_no_person_docs: r.include_no_person_docs,
          expires_at: r.expires_at,
        },
        state.timezone,
        Date.now(),
        // A guest owns nothing (5.34).
        { own: state.members.find((m) => m.id === memberId)?.kind !== 'guest' },
      ),
      people,
      types,
      collections,
      include_adults_only: r.include_adults_only,
      include_no_person_docs: r.include_no_person_docs,
      expires_at: r.expires_at,
    };
  };
  /**
   * A grant as the real vault checks it (5.33): the people, kinds and
   * collections of the family, a collection for Everyone (A17), an end in
   * the future. A refusal, or the grant tidied.
   */
  /** The shape of a grant as the real vault parses it (zod): a refusal, or the grant. */
  const grantShape = (b: Record<string, unknown>): AccessGrant | ResponseLike => {
    const known = [
      'people',
      'types',
      'collections',
      'include_adults_only',
      'include_no_person_docs',
      'expires_at',
      'limits_people',
      'limits_types',
      'confirm_private',
    ];
    const bad = Object.keys(b).find((k) => !known.includes(k));
    if (bad) return fail(422, 'validation_failed', `Unrecognized key: "${bad}"`);
    for (const k of ['people', 'types', 'collections']) {
      if (b[k] !== undefined && !Array.isArray(b[k])) {
        return fail(422, 'validation_failed', 'Invalid input: expected array');
      }
    }
    const list = (v: unknown) =>
      Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string'))] : [];
    const flag = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
    const limitsPeople = flag(b.limits_people);
    const limitsTypes = flag(b.limits_types);
    return {
      people: list(b.people),
      types: list(b.types),
      collections: list(b.collections),
      include_adults_only: b.include_adults_only === true,
      include_no_person_docs: b.include_no_person_docs === true,
      expires_at: typeof b.expires_at === 'string' ? b.expires_at : null,
      ...(limitsPeople !== undefined ? { limits_people: limitsPeople } : {}),
      ...(limitsTypes !== undefined ? { limits_types: limitsTypes } : {}),
    };
  };
  /**
   * What a grant names, as the real vault checks it once it knows whom
   * (5.33): an end in the future, or the one it has; people, kinds and
   * collections of the family — a collection deleted since left out, one
   * for anybody narrower than Everyone refused (A17).
   */
  const checkedGrant = (
    g: AccessGrant,
    storedEnd: string | null = null,
  ): AccessGrant | ResponseLike => {
    if (
      g.expires_at !== null &&
      Date.parse(g.expires_at) <= Date.now() &&
      (storedEnd === null || Date.parse(storedEnd) !== Date.parse(g.expires_at))
    ) {
      return fail(422, 'validation_failed', 'Choose an end in the future, or none.', 'expires_at');
    }
    if (g.people.some((id) => id !== ME && !state.members.some((m) => m.id === id))) {
      return fail(422, 'validation_failed', 'Choose people from the family.', 'people');
    }
    if (g.types.some((key) => !state.types.some((t) => t.key === key))) {
      return fail(422, 'validation_failed', 'Choose kinds of document the family has.', 'types');
    }
    for (const id of g.collections) {
      const c = state.collections.find((x) => x.id === id);
      if (!c)
        return fail(422, 'validation_failed', 'Choose collections of the family.', 'collections');
      if (!c.deleted && c.audience !== 'everyone') {
        return fail(422, 'validation_failed', onlyEveryone(c.name, c.audience), 'collections');
      }
    }
    return {
      ...g,
      collections: g.collections.filter((id) =>
        state.collections.some((c) => c.id === id && !c.deleted),
      ),
    };
  };
  /** A collection deleted, or made for fewer than Everyone, leaves every grant (0055). */
  const leavesGrants = (collectionId: string) => {
    for (const r of state.restrictions.values()) {
      r.collections = r.collections.filter((c) => c !== collectionId);
    }
  };
  /** Whether a grant names people, or kinds, once written (the real vault's limitsAfter). */
  const limitsAfter = (named: string[], said: boolean | undefined, had: boolean | undefined) =>
    named.length > 0 || (said ?? had ?? false);

  const tokensFor = (s: FakeSession): Tokens => {
    const access = next('access');
    state.access.set(access, s.id);
    const who = whoOf(s);
    return {
      access_token: access,
      expires_in: 900,
      refresh_token: s.refresh,
      refresh_expires_in: 2_592_000,
      household_id: 'fake-household',
      member_id: who.memberId,
      role: who.role,
      scopes_unlocked: ['household', 'adults', 'member'],
    };
  };
  const open = (installation: string | null = null, memberId?: string): Tokens => {
    const s: FakeSession = {
      id: next('session'),
      refresh: next('refresh'),
      previous: null,
      revoked: false,
      installation,
      rotatedAt: Date.now(),
      graceUsed: false,
      ...(memberId !== undefined ? { memberId } : {}),
    };
    state.sessions.push(s);
    return tokensFor(s);
  };

  const pauseSignIns = () => {
    const now = new Date().toISOString();
    for (const id of withSignIn()) {
      const held = state.suspensions.get(id);
      const lockedNow = held?.reason === 'locked' && suspensionOf(id) !== null;
      if (roleOfMember(id) !== 'owner' && held?.reason !== 'restored' && !lockedNow) {
        state.suspensions.set(id, {
          reason: 'restored',
          since: now,
          until: null,
          note: null,
          by: null,
        });
      }
    }
    // A backup cannot know whether a lock was made longer since: kept until an owner unlocks it.
    for (const s of state.suspensions.values()) if (s.reason === 'locked') s.until = null;
    for (const s of state.sessions) {
      if (s.revoked) continue;
      s.revoked = true;
      s.endedBecause = 'revoked';
    }
  };

  /**
   * POST /invitations (5.34), refused as the real vault refuses, in its
   * order: who may invite for the role; a guest's own rules (a viewer,
   * limited, an end within a year); an adult's viewer limited, without
   * Adults only documents (A27); an owner's decision about what a viewer
   * sees asks for two-step sign-in; an address already signed in with.
   */
  const invite = (who: { memberId: string; role: Role }, b: Record<string, unknown>) => {
    const role = String(b.role) as Role;
    if (!['owner', 'adult', 'teen', 'viewer'].includes(role)) {
      return fail(422, 'validation_failed', 'Invalid option: expected one of the roles');
    }
    const capability =
      role === 'owner' || role === 'adult' ? 'member.invite_adult' : 'member.invite';
    if (!can(who.role, capability)) return fail(403, 'forbidden', refusalFor(capability));
    const kind: MemberKind = b.kind === 'guest' ? 'guest' : 'family';
    const shaped =
      b.restriction && typeof b.restriction === 'object'
        ? grantShape(b.restriction as Record<string, unknown>)
        : null;
    if (shaped && isResponse(shaped)) return shaped;
    const end = typeof b.access_expires_at === 'string' ? b.access_expires_at : null;
    if (kind === 'guest') {
      if (role !== 'viewer') {
        return fail(422, 'validation_failed', 'A guest is always a viewer.', 'role');
      }
      if (!shaped) {
        return fail(
          422,
          'validation_failed',
          'A guest is always limited to what they are given. Choose what they can see.',
          'restriction',
        );
      }
      const problem = end ? guestEndProblem(new Date(end)) : 'Choose the day their access ends.';
      if (problem) return fail(422, 'validation_failed', problem, 'access_expires_at');
    } else if (end) {
      return fail(
        422,
        'validation_failed',
        'Only a guest’s access ends on a day. Somebody of the family keeps theirs.',
        'access_expires_at',
      );
    }
    if (shaped && role !== 'viewer') {
      return fail(422, 'validation_failed', 'Only a viewer can be limited to some documents.');
    }
    if (role === 'viewer' && who.role !== 'owner') {
      if (!shaped) {
        return fail(
          403,
          'forbidden',
          'Only an owner can invite a viewer who sees every family document. Choose what they can see.',
        );
      }
      if (shaped.include_adults_only) {
        return fail(403, 'forbidden', 'Only an owner can let a viewer see Adults only documents.');
      }
    }
    // An owner's decision (A27, D6, A54): a viewer who sees every family
    // document, Adults only documents, any guest an owner invites (the 5.34
    // review), or an owner's limits replacing those already set (S533-02):
    // a passkey or a code, asked before anything else of the vault.
    const replaces =
      who.role === 'owner' &&
      shaped !== null &&
      typeof b.member_id === 'string' &&
      state.restrictions.has(b.member_id);
    const decides =
      (role === 'viewer' &&
        (!shaped || shaped.include_adults_only || (kind === 'guest' && who.role === 'owner'))) ||
      replaces;
    if (decides && !state.ownerTwoStep) {
      return fail(
        403,
        'totp_required_for_owner',
        'Turn on two-step sign-in to limit what a viewer can see.',
      );
    }
    const email = typeof b.email === 'string' ? b.email.toLowerCase() : '';
    if (email === state.email || state.signIns.some((x) => x.email.toLowerCase() === email)) {
      return fail(
        409,
        'email_in_use',
        'That email address already has a sign-in here. They can sign in with it instead.',
      );
    }
    const checked = shaped ? checkedGrant(shaped) : null;
    if (checked && isResponse(checked)) return checked;
    let member =
      typeof b.member_id === 'string' ? state.members.find((m) => m.id === b.member_id) : undefined;
    if (typeof b.member_id === 'string') {
      if (!member) return fail(404, 'not_found', 'That person is not in the family.');
      if (member.role) return fail(409, 'already_signed_in', 'That person already has a sign-in.');
      if ((member.kind ?? 'family') !== kind) {
        return kind === 'guest'
          ? fail(
              409,
              'not_a_guest',
              `${member.display_name} is of the family. A guest is somebody from outside it: invite them by their name.`,
            )
          : fail(
              409,
              'guest',
              `${member.display_name} is from outside the family. Invite them as a guest.`,
            );
      }
      // A guest who has had a sign-in is given it back by an owner, never
      // invited again as the same person (the 5.34 review).
      const accepted = state.invitations.some(
        (i) => i.view.member_id === member?.id && i.view.state === 'accepted',
      );
      if (kind === 'guest' && accepted) {
        return fail(
          409,
          'had_sign_in',
          `${member.display_name} has had a sign-in here. An owner can give it back, with a new end, from People outside the family; or invite them by their name as somebody new.`,
        );
      }
      // An adult's invitation keeps an owner's limits: never Adults only ones.
      if (who.role !== 'owner' && state.restrictions.get(member.id)?.include_adults_only) {
        return fail(
          403,
          'forbidden',
          'An owner gave them Adults only documents, so only an owner can invite them.',
        );
      }
    } else {
      member = {
        id: next('member'),
        display_name: typeof b.display_name === 'string' ? b.display_name : '',
        role: null,
        is_me: false,
        kind,
        relationship: typeof b.relationship === 'string' ? b.relationship : null,
      };
      state.members.push(member);
    }
    const view: Invitation = {
      id: next('invitation'),
      member_id: member.id,
      display_name: member.display_name,
      email,
      role,
      invited_by: state.members.find((m) => m.id === who.memberId)?.display_name ?? null,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      state: 'pending',
      attempts_left: 5,
      limited: checked !== null,
      kind,
      access_expires_at: end ? new Date(end).toISOString() : null,
    };
    const token = next('invitation-token');
    const code = 'ABCD-EFGH';
    state.invitations.push({
      view,
      token,
      code,
      restriction: checked,
      by_owner: who.role === 'owner',
    });
    return ok({ invitation: view, link_token: token, code }, 201);
  };

  /** POST /invitations/accept (5.34): the link, the code and a password of their own. */
  const acceptInvitation = (b: Record<string, unknown>, installation: string | null) => {
    const found = state.invitations.find((i) => i.token === b.token && i.view.state === 'pending');
    if (!found) {
      return fail(
        404,
        'invitation_not_valid',
        'That invitation link is not valid any more. Ask whoever invited you to send a new one.',
      );
    }
    const typed = (typeof b.code === 'string' ? b.code : '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
    if (typed !== found.code.replace(/[^A-Z0-9]/g, '')) {
      return fail(401, 'invitation_code_wrong', 'That code is not right.');
    }
    const v = found.view;
    if (v.kind === 'guest' && guestAccessEnded(v.access_expires_at)) {
      return fail(
        409,
        'access_ended',
        'The access this invitation gives has already ended. Ask whoever invited you for a new one.',
      );
    }
    const email = typeof b.email === 'string' ? b.email.toLowerCase() : v.email;
    if (email === state.email || state.signIns.some((x) => x.email.toLowerCase() === email)) {
      return fail(
        409,
        'email_taken',
        'That address already has a sign-in here. Choose another one.',
      );
    }
    const member = state.members.find((m) => m.id === v.member_id);
    if (!member)
      return fail(404, 'invitation_not_valid', 'That invitation link is not valid any more.');
    member.role = v.role;
    if (v.kind === 'guest') member.access_expires_at = v.access_expires_at ?? null;
    const had = state.restrictions.get(member.id);
    // An adult's keeps what an owner set, so never Adults only documents an
    // owner gave since (the 5.34 review): asked again now.
    if (had && !found.by_owner && had.include_adults_only) {
      return fail(
        409,
        'owner_needed',
        'This invitation cannot be accepted as it is. Ask an owner of the family to invite you.',
      );
    }
    if (found.restriction && (!had || found.by_owner)) {
      state.restrictions.set(member.id, {
        ...found.restriction,
        include_adults_only: found.by_owner && found.restriction.include_adults_only,
        limits_people:
          found.restriction.limits_people === true || found.restriction.people.length > 0,
        limits_types: found.restriction.limits_types === true || found.restriction.types.length > 0,
        reconfirm_since: null,
        private_confirmed: false,
        updated_at: new Date().toISOString(),
      });
    }
    state.signIns.push({
      member_id: member.id,
      email,
      password: typeof b.password === 'string' ? b.password : '',
    });
    v.state = 'accepted';
    return ok(open(installation, member.id), 201);
  };

  const fetch: FetchLike = async (url, init) => {
    const path = url.replace(/^[a-z]+:\/\/[^/]+/i, '').split('?')[0] as string;
    state.calls.push({ method: init.method, path });
    if (state.offline) throw new TypeError('Network request failed');
    const body =
      typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const auth = init.headers.authorization?.replace(/^Bearer /, '');
    const session = () => {
      const id = auth ? state.access.get(auth) : undefined;
      const s = state.sessions.find((x) => x.id === id);
      if (!s) return fail(401, 'unauthenticated', 'Sign in first.');
      if (s.revoked) return ended(s.endedBecause ?? 'revoked');
      // Locked, or paused after a restore (5.28): a session a lock did not
      // end — a test's own suspension — answers nothing while it lasts.
      if (suspensionOf(whoOf(s).memberId)) return ended('suspended');
      // A guest's sign-in past its end (5.34): as the real vault, `access_ended`.
      if (guestEndOf(whoOf(s).memberId)) return ended('access_ended');
      return s;
    };

    if (path === '/api/v1/capabilities') {
      const caps: Capabilities = {
        product: 'family-document-vault',
        server_version: '0.4.13',
        api_version: 1,
        min_client_version: '0.0.1',
        edition: 'self_hosted',
        protection_mode: 'standard',
        setup_required: state.setupRequired,
        features: {
          passkeys: true,
          private_mode: false,
          email_ingest: false,
          push: false,
          share_links: true,
          bulk_import: false,
          multi_household: false,
          idempotent_capture: true,
          capture_metadata: true,
          issued_by: true,
          page_previews: true,
          offline_essentials: true,
          // As the real vault (0.5.11): the household's own kinds of document.
          custom_types: true,
          // And collections of documents (0.5.12).
          collections: true,
          // Reminders from any date (0.5.15), said on since the web's
          // editor for them shipped (0.5.16), as the vault says.
          reminder_dates: true,
          // People's photos (0.5.19).
          member_photos: true,
          // A link's options (5.18): an end at a time, to view, so many opens.
          share_options: true,
          // A collection shared outside (5.19), as the vault says.
          collection_shares: true,
          // A password and one browser only (5.20); an emailed code only
          // with the operator's mail server, which a fake has none of.
          share_second_factor: true,
          share_email_code: false,
          // A person's details, and the owner's view of a sign-in (5.25).
          member_edit: true,
          // Asking somebody to send documents, and looking before filing (5.23).
          upload_requests: true,
          // People's identity details, and who sees them (5.26).
          member_identity: true,
          // Locking a sign-in, and sign-ins paused after a restore (5.28).
          member_admin: true,
          // Signing somebody out everywhere (5.30).
          sign_out_everywhere: true,
          // What a viewer can see, limited by an owner (5.33).
          access_restrictions: true,
          // Someone outside the family (5.34).
          guests: true,
        },
        limits: {
          max_upload_bytes: 104_857_600,
          max_members: null,
          max_storage_bytes: null,
          share_max_days: 90,
          guest_max_days: GUEST_MAX_DAYS,
        },
        deprecations: [],
        branding: { display_name: 'A fake family' },
        instance_id: FAKE_INSTANCE_ID,
      };
      return ok(caps);
    }
    if (path === '/api/v1/setup' && init.method === 'POST') {
      if (!state.setupRequired) return fail(409, 'already_set_up', 'This vault is already set up.');
      state.setupRequired = false;
      state.email = String(body.email).toLowerCase();
      state.password = String(body.password);
      return ok(open(init.headers['x-fdv-installation'] ?? null), 201);
    }
    if (path === '/api/v1/auth/password' && init.method === 'POST') {
      // The fake's own person, or somebody else with a sign-in (5.28).
      const email = String(body.email).toLowerCase();
      const other =
        email === state.email
          ? undefined
          : state.signIns.find((x) => x.email.toLowerCase() === email);
      const known = email === state.email || other !== undefined;
      if (!known || body.password !== (other ? other.password : state.password)) {
        return fail(401, 'invalid_credentials', "That email and password don't match.");
      }
      // Locked, or paused after a restore: said only now the password is right.
      const held = suspensionOf(other ? other.member_id : ME);
      if (held) return membershipSuspended(held, state.timezone);
      // A guest's sign-in past its end (5.34): said only now, with the day.
      const end = other ? guestEndOf(other.member_id) : null;
      if (end) {
        // With its reason, as the real vault says it.
        return respond(403, {
          error: {
            code: 'access_ended',
            message: guestAccessEndedWords(end, state.timezone),
            reason: 'access_ended',
            retriable: false,
            request_id: 'fake',
          },
        });
      }
      return ok(open(init.headers['x-fdv-installation'] ?? null, other?.member_id));
    }
    if (path === '/api/v1/auth/refresh' && init.method === 'POST') {
      const presented = String(body.refresh_token);
      const current = state.sessions.find((s) => s.refresh === presented);
      const replayed = state.sessions.find((s) => s.previous === presented);
      const installation = init.headers['x-fdv-installation'] ?? null;
      // A session already ended says why.
      if (replayed?.revoked) return ended(replayed.endedBecause ?? 'revoked');
      const touched = state.sessions.find((s) => !s.revoked && s.graceTokens?.includes(presented));
      if (touched) {
        touched.revoked = true;
        touched.endedBecause = 'reused';
        return ended('reused');
      }
      if (replayed) {
        // As the real vault (0.4.11): the token just replaced, once, within
        // 30 s, from the session's own installation — an answer lost on the
        // way. The token it displaces becomes the previous one.
        const grace =
          !replayed.graceUsed &&
          replayed.installation != null &&
          replayed.installation === installation &&
          Date.now() - (replayed.rotatedAt ?? 0) <= 30_000;
        if (grace) {
          // Locked, or paused after a restore (5.28): no new token.
          if (suspensionOf(whoOf(replayed).memberId)) return ended('suspended');
          replayed.graceTokens = [
            ...(replayed.graceTokens ?? []),
            presented,
            replayed.refresh,
          ].slice(-8);
          replayed.spent = [...(replayed.spent ?? []), replayed.refresh];
          replayed.previous = replayed.refresh;
          replayed.refresh = next('refresh');
          replayed.graceUsed = true;
          replayed.rotatedAt = Date.now();
          return ok(tokensFor(replayed));
        }
        // A spent token, presented again, is theft: the whole session goes.
        replayed.revoked = true;
        replayed.endedBecause = 'reused';
        return ended('reused');
      }
      // Token families (5.30): any token a session was given, presented
      // once it has been replaced, ends it — however many refreshes ago.
      const family = current ? undefined : state.sessions.find((s) => s.spent?.includes(presented));
      if (family) {
        if (family.revoked) return ended(family.endedBecause ?? 'revoked');
        family.revoked = true;
        family.endedBecause = 'reused';
        return ended('reused');
      }
      if (!current) return ended('revoked');
      if (current.revoked) return ended(current.endedBecause ?? 'revoked');
      if (suspensionOf(whoOf(current).memberId)) return ended('suspended');
      if (guestEndOf(whoOf(current).memberId)) return ended('access_ended');
      current.spent = [...(current.spent ?? []), current.refresh];
      current.previous = current.refresh;
      current.refresh = next('refresh');
      current.rotatedAt = Date.now();
      current.graceUsed = false;
      return ok(tokensFor(current));
    }
    if (path === '/api/v1/auth/logout' && init.method === 'POST') {
      const s = session();
      if (!('id' in s)) return s;
      s.revoked = true;
      return empty();
    }
    if (path === '/api/v1/me') {
      const s = session();
      if (!('id' in s)) return s;
      const who = whoOf(s);
      return ok({
        account_id: s.memberId === undefined ? 'fake-account' : `fake-account-${s.memberId}`,
        household_id: 'fake-household',
        member_id: who.memberId,
        role: who.role,
        totp_enabled: false,
        totp_required: true,
        // 5.29: an owner made a link to hand over for this sign-in.
        reset_notice: state.resetNotices.get(who.memberId) ?? null,
        handover_since: null,
        // 5.33: what an owner has limited this viewer to.
        restriction: who.role === 'viewer' ? myRestriction(who.memberId) : null,
        // 5.34: a guest, and when their sign-in ends.
        kind: state.members.find((m) => m.id === who.memberId)?.kind ?? 'family',
        access_expires_at:
          state.members.find((m) => m.id === who.memberId)?.access_expires_at ?? null,
      });
    }
    if (path === '/api/v1/me/reset-notice' && init.method === 'DELETE') {
      const s = session();
      if (!('id' in s)) return s;
      state.resetNotices.delete(whoOf(s).memberId);
      return empty();
    }
    /** A document as the real vault answers it, with its status in words (0.5.7). */
    const viewOf = (doc: FakeDocument) => documentView(doc, state.types, { role: state.role });
    /** As a list answers it: an Only me document's notes and details stay sealed (0.5.8). */
    const listedOf = (doc: FakeDocument) =>
      documentView(doc, state.types, { listed: true, role: state.role });
    /**
     * The details sent for a document, checked as the real vault checks
     * them (0.5.7): against the type it will have, merged into what it
     * holds, null taking a key away. A refusal names the key.
     */
    const detailsFor = (typeKey: string | null | undefined, sent: unknown, held = {}) => {
      const fields = state.types.find((t) => t.key === typeKey)?.fields ?? [];
      const checked = checkExtra((sent ?? {}) as Record<string, unknown>, fields, held);
      if ('problem' in checked) {
        return fail(422, 'invalid_extra', checked.problem.message, checked.problem.key);
      }
      const merged: Record<string, unknown> = { ...held };
      for (const key of checked.remove) delete merged[key];
      return Object.assign(merged, checked.set);
    };
    /** A capture's details for a kind the fake no longer has: each by the library's field, or left out. */
    const libraryDetails = (sent: Record<string, unknown>) => {
      const kept: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(sent)) {
        const lib = state.attributes.find((a) => a.key === key);
        if (!lib) continue;
        const checked = checkExtra({ [key]: value }, [
          { key, label: lib.label, kind: lib.kind, choices: lib.choices ?? [] },
        ]);
        if ('set' in checked) Object.assign(kept, checked.set);
      }
      return kept;
    };
    if (path === '/api/v1/documents') {
      const s = session();
      if (!('id' in s)) return s;
      if (init.method === 'POST') {
        const type_key = (body.type_key as string | null | undefined) ?? null;
        if (type_key !== null && !state.types.some((t) => t.key === type_key)) {
          return fail(422, 'validation_failed', 'That kind of document is not on the list.');
        }
        const extra = detailsFor(type_key, body.extra);
        if (isResponse(extra)) return extra;
        // As the real vault: the type's default, when nothing is asked for,
        // and Only me — asked for or the default — only for your own (0.5.10).
        const visibility =
          (body.visibility as Visibility | undefined) ??
          state.types.find((t) => t.key === type_key)?.default_visibility;
        const owner = (body.owner_member_id as string | null | undefined) ?? null;
        if (visibility === 'private' && owner !== 'fake-member') {
          return fail(
            422,
            'validation_failed',
            body.visibility === 'private' ? PRIVATE_TO_THEM : PRIVATE_BY_DEFAULT,
            'visibility',
          );
        }
        const doc: FakeDocument = {
          id: next('document'),
          title: (body.title as string | null) ?? null,
          type_key,
          owner_member_id: owner,
          identifier: tidy(body.identifier as string | null | undefined),
          issued_by: tidy(body.issued_by as string | null | undefined),
          issued: (body.issued as DateValue | null | undefined) ?? null,
          expires: (body.expires as DateValue | null | undefined) ?? null,
          physical_location: note(body.physical_location as string | null | undefined),
          tags: tagsOf(body.tags as string[] | undefined),
          notes: note(body.notes as string | null | undefined),
          ...(visibility !== undefined ? { visibility } : {}),
          extra,
        };
        state.documents.push(doc);
        return ok(viewOf(doc), 201);
      }
      // As the real vault: ?issued_by= filters, whatever the case.
      const by = param(url, 'issued_by');
      // The Trash is its own list (5.1), and an owner's requests to remove
      // for good are asked for by themselves (5.24).
      const inTrash = param(url, 'deleted') === 'true';
      const asked = param(url, 'purge_requested');
      const items = state.documents
        .filter((d) => Boolean(d.deleted_at) === inTrash)
        .filter((d) => asked === undefined || Boolean(d.purge_requested_at) === (asked === 'true'))
        .filter((d) => !by || d.issued_by?.toLowerCase() === by.trim().toLowerCase());
      return ok({ items: items.map(listedOf), next_cursor: null, has_more: false });
    }
    // Into the Trash, out of it, and out of the vault for good (5.1, 5.24),
    // as the real vault keeps them.
    const trashAt = /^\/api\/v1\/documents\/([^/]+)(\/restore|\/purge)?$/.exec(path);
    if (
      trashAt &&
      ((trashAt[2] === undefined && init.method === 'DELETE') ||
        (trashAt[2] !== undefined && init.method === 'POST'))
    ) {
      const s = session();
      if (!('id' in s)) return s;
      const doc = state.documents.find((d) => d.id === decodeURIComponent(trashAt[1] as string));
      if (!doc) return fail(404, 'not_found', 'That document is not in the vault.');
      if (trashAt[2] === undefined) {
        doc.deleted_at ??= new Date().toISOString();
        return empty();
      }
      if (trashAt[2] === '/restore') {
        doc.deleted_at = null;
        doc.purge_requested_at = null;
        return ok(viewOf(doc));
      }
      if (!can(state.role, 'document.purge')) {
        return fail(403, 'forbidden', refusalFor('document.purge'));
      }
      if (!doc.deleted_at) {
        return fail(
          409,
          'not_in_trash',
          'Only a document in the Trash can be removed for good. Move it to the Trash first.',
        );
      }
      // At once only what they filed: one filed by somebody else, still here,
      // is asked about first even when it is theirs (the 5.24 review, M524-1).
      const theirs = doc.filedBySomeoneElse !== true;
      if (!theirs && !doc.purge_requested_at) {
        doc.purge_requested_at = new Date().toISOString();
        return ok(listedOf(doc), 202);
      }
      const from = Date.parse(doc.purge_requested_at ?? '') + PURGE_NOTICE_HOURS * 3_600_000;
      if (!theirs && Date.now() < from) {
        return fail(
          409,
          'purge_not_yet',
          'Whoever filed it has been told, and can bring it back until then.',
          new Date(from).toISOString(),
        );
      }
      state.documents = state.documents.filter((d) => d !== doc);
      return empty();
    }
    // One document, and an edit to it: the details merged, as the real
    // vault merges them (0.5.7), so a client never wipes what it did not show.
    const one = /^\/api\/v1\/documents\/([^/]+)$/.exec(path);
    if (one && (init.method === 'GET' || init.method === 'PATCH')) {
      const s = session();
      if (!('id' in s)) return s;
      // One in the Trash is not there for this, as in the real vault (5.1).
      const doc = state.documents.find(
        (d) => d.id === decodeURIComponent(one[1] as string) && !d.deleted_at,
      );
      if (!doc) return fail(404, 'not_found', 'That document is not in the vault.');
      if (init.method === 'GET') return ok(viewOf(doc));
      // As the real vault: an edit made to a version somebody has since
      // changed is refused, not laid over theirs.
      const ifMatch = init.headers['if-match'];
      if (ifMatch && ifMatch !== etagOf(doc)) {
        return fail(409, 'conflict', 'Someone else changed this document. Reload and try again.');
      }
      // A field the fake does not keep fails loudly, so a client test never
      // passes against an edit the fake quietly dropped.
      const unkept = Object.keys(body).filter((k) => !FAKE_EDITABLE.includes(k));
      if (unkept.length) {
        return fail(
          501,
          'not_implemented',
          `The fake vault does not keep ${unkept.join(', ')} on an edit.`,
        );
      }
      const type_key =
        body.type_key !== undefined ? (body.type_key as string | null) : (doc.type_key ?? null);
      if (type_key !== null && !state.types.some((t) => t.key === type_key)) {
        return fail(422, 'validation_failed', 'That kind of document is not on the list.');
      }
      let extra = doc.extra ?? {};
      if (body.extra !== undefined) {
        const merged = detailsFor(type_key, body.extra, extra);
        if (isResponse(merged)) return merged;
        extra = merged;
      }
      Object.assign(doc, { type_key, extra });
      if (body.title !== undefined) doc.title = (body.title as string | null) ?? null;
      if (body.owner_member_id !== undefined) {
        doc.owner_member_id = body.owner_member_id as string | null;
      }
      // Trimmed, as the vault keeps an identifier: its inner spaces are its own.
      if (body.identifier !== undefined) {
        doc.identifier = (body.identifier as string | null)?.trim() || null;
      }
      if (body.issued_by !== undefined) doc.issued_by = tidy(body.issued_by as string | null);
      if (body.expires !== undefined) doc.expires = body.expires as DateValue | null;
      if (body.notes !== undefined) doc.notes = note(body.notes as string | null);
      doc.revision = (doc.revision ?? 1) + 1;
      return ok(viewOf(doc));
    }
    // Uploads, the way the real vault treats their keys: a retry is answered
    // with what the first try made, marked as a replay; a key used for one
    // request is refused for any other, without saying what it made.
    const uploadTo = /^\/api\/v1\/documents\/([^/]+)\/versions$/.exec(path);
    if ((path === '/api/v1/capture' || uploadTo) && init.method === 'POST') {
      const s = session();
      if (!('id' in s)) return s;
      const key = init.headers['idempotency-key'];
      if (!key)
        return fail(422, 'validation_failed', 'Uploads need an Idempotency-Key header (a UUID).');
      if (!UUID.test(key)) return fail(422, 'validation_failed', 'Idempotency-Key must be a UUID.');
      const type = init.headers['content-type'] ?? '';
      if (!(init.body instanceof Uint8Array) && !/^multipart\/form-data/.test(type)) {
        // A platform FormData sets its own content type; bytes must say so.
        if (!init.body) return fail(422, 'validation_failed', 'Attach one file.');
      }
      const kind = uploadTo ? 'version' : 'capture';
      const target = uploadTo?.[1];
      // As the real vault: a document that is not there is not there,
      // whatever the key.
      if (target !== undefined && !state.documents.some((d) => d.id === target)) {
        return fail(404, 'not_found', 'That document is not in the vault.');
      }
      const prior = state.captures.get(key.toLowerCase());
      if (prior) {
        if (prior.kind !== kind || (target !== undefined && prior.document_id !== target)) {
          return fail(
            409,
            'idempotency_key_reused',
            'That upload key was already used for something else.',
          );
        }
        return respond(201, answer(prior), { 'idempotent-replayed': 'true' });
      }
      const parts = partsOf(init.body) ?? [];
      let documentId = target;
      if (documentId === undefined) {
        // The card's details come before the file, or not at all (0.4.9).
        let metadata: CaptureMetadata = {};
        let loose: Record<string, unknown> | null = null;
        const file = parts.findIndex((p) => p.value === null);
        const meta = parts.findIndex((p) => p.name === 'metadata');
        if (meta > file && file >= 0) {
          return fail(422, 'validation_failed', 'Send the details before the file.');
        }
        if (meta >= 0) {
          try {
            metadata = JSON.parse(parts[meta]?.value ?? '') as CaptureMetadata;
          } catch {
            return fail(422, 'validation_failed', 'The details must be sent as JSON.');
          }
          // As the real vault (0.5.10): a kind it does not have — deleted
          // while the phone was offline — is not a refusal. The scan is filed
          // with no kind, for as few people as it could be, and its details
          // kept where the library has the field.
          if (metadata.type_key != null && !state.types.some((t) => t.key === metadata.type_key)) {
            const { extra: sentExtra, ...rest } = metadata;
            metadata = {
              ...rest,
              type_key: null,
              visibility:
                metadata.visibility ??
                ((metadata.owner_member_id ?? null) === 'fake-member' ? 'private' : 'adults'),
            };
            loose = sentExtra ?? null;
          }
          // As the real vault: a type the household has hidden is still
          // taken, since a phone queues a scan against the list it had.
          const problem = checkCaptureMetadata(metadata, {
            me: { member_id: 'fake-member', role: 'owner' },
            members: state.members,
            types: state.types,
          });
          if (problem) {
            return fail(
              problem.status,
              problem.field === 'extra'
                ? 'invalid_extra'
                : problem.status === 403
                  ? 'forbidden'
                  : 'validation_failed',
              problem.message,
              problem.key,
            );
          }
        }
        const extra = loose ? libraryDetails(loose) : detailsFor(metadata.type_key, metadata.extra);
        if (isResponse(extra)) return extra;
        const doc: FakeDocument = {
          id: next('document'),
          title: metadata.title ?? null,
          type_key: metadata.type_key ?? null,
          owner_member_id: metadata.owner_member_id ?? null,
          identifier: tidy(metadata.identifier),
          issued_by: tidy(metadata.issued_by),
          issued: metadata.issued ?? null,
          expires: metadata.expires ?? null,
          physical_location: note(metadata.physical_location),
          tags: tagsOf(metadata.tags),
          notes: note(metadata.notes),
          extra,
          visibility: effectiveVisibility(
            metadata,
            state.types.find((t) => t.key === metadata.type_key),
            'owner',
          ),
        };
        state.documents.push(doc);
        documentId = doc.id;
      }
      const file = parts.find((p) => p.value === null);
      const made: FakeUpload = {
        kind,
        document_id: documentId,
        version_id: next('version'),
        version_no: versionsOf(documentId).length + 1,
        filename: file?.filename ?? 'file',
        mime: file?.type ?? 'application/octet-stream',
        byte_size: file?.size ?? 0,
        uploaded_at: new Date().toISOString(),
      };
      state.captures.set(key.toLowerCase(), made);
      return ok(answer(made), 201);
    }
    // A document's history (0.5.11): its versions, newest first, and who
    // added each — never to a viewer, who is not told what the family has
    // been doing (on the activity log's terms, as the real vault).
    if (uploadTo && init.method === 'GET') {
      const s = session();
      if (!('id' in s)) return s;
      const id = decodeURIComponent(uploadTo[1] as string);
      if (!state.documents.some((d) => d.id === id)) {
        return fail(404, 'not_found', 'That document is not in the vault.');
      }
      const named = can(state.role, 'audit.read');
      const me = state.members.find((m) => m.is_me);
      const items: VersionView[] = versionsOf(id)
        .sort((a, b) => b.version_no - a.version_no)
        .map((v) => {
          const drawn = state.pages.get(v.version_id);
          return {
            id: v.version_id,
            document_id: v.document_id,
            version_no: v.version_no,
            filename: v.filename,
            mime: v.mime,
            byte_size: v.byte_size,
            // Not worked out by the fake: a stand-in of the right shape.
            sha256: '0'.repeat(64),
            page_count: null,
            ocr_status: 'pending',
            uploaded_at: v.uploaded_at,
            preview_pages: drawn === undefined ? null : drawn === 'unsupported' ? 0 : drawn,
            uploaded_by_name: named ? (me?.display_name ?? null) : null,
          };
        });
      return ok({ items });
    }
    if (path === '/api/v1/issuers' && init.method === 'GET') {
      const s = session();
      if (!('id' in s)) return s;
      // As the real vault: one entry per issuer whatever the case, in its
      // most used spelling; ?q= is a prefix; ?type_key= keeps only those
      // used for that type; most used first, then alphabetically.
      const q = param(url, 'q')?.trim().toLowerCase();
      const type = param(url, 'type_key');
      const byKey = new Map<
        string,
        { count: number; types: Set<string>; spellings: Map<string, number> }
      >();
      for (const d of state.documents) {
        if (!d.issued_by) continue;
        const k = d.issued_by.toLowerCase();
        const c = byKey.get(k) ?? { count: 0, types: new Set(), spellings: new Map() };
        c.count += 1;
        if (d.type_key) c.types.add(d.type_key);
        c.spellings.set(d.issued_by, (c.spellings.get(d.issued_by) ?? 0) + 1);
        byKey.set(k, c);
      }
      const items = [...byKey.entries()]
        .filter(([k, c]) => (!q || k.startsWith(q)) && (!type || c.types.has(type)))
        .map(([, c]) => ({
          issued_by: [...c.spellings.entries()].sort(
            (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
          )[0]?.[0] as string,
          count: c.count,
        }))
        .sort((a, b) => b.count - a.count || (a.issued_by < b.issued_by ? -1 : 1));
      return ok({ items });
    }
    const suggestFor = /^\/api\/v1\/documents\/([^/]+)\/issuer-suggestions$/.exec(path);
    if (suggestFor && init.method === 'GET') {
      const s = session();
      if (!('id' in s)) return s;
      const id = decodeURIComponent(suggestFor[1] as string);
      if (!state.documents.some((d) => d.id === id)) {
        return fail(404, 'not_found', 'That document is not in the vault.');
      }
      return ok(state.issuerSuggestions.get(id) ?? { state: 'unavailable', items: [] });
    }
    const uploadKey = /^\/api\/v1\/uploads\/([^/]+)$/.exec(path);
    if (uploadKey && init.method === 'GET') {
      const s = session();
      if (!('id' in s)) return s;
      const made = state.captures.get(decodeURIComponent(uploadKey[1] as string).toLowerCase());
      if (!made) return fail(404, 'not_found', 'That upload is not known here.');
      return ok({ state: 'done', document_id: made.document_id, version_id: made.version_id });
    }
    // A page as the vault drew it (0.4.12): not found for a version it never
    // made, still being drawn until a test says otherwise, then a JPEG.
    const pageOf = /^\/api\/v1\/versions\/([^/]+)\/pages\/([^/]+)$/.exec(path);
    if (pageOf && init.method === 'GET') {
      const s = session();
      if (!('id' in s)) return s;
      const version = pageOf[1] as string;
      const n = Number(pageOf[2]);
      // As the real route: a page is a whole number from 1.
      if (!/^\d+$/.test(pageOf[2] as string) || n < 1) {
        return fail(422, 'validation_failed', 'That is not a page number.');
      }
      const made = [...state.captures.values()].some((c) => c.version_id === version);
      if (!made && !state.pages.has(version)) {
        return fail(404, 'not_found', 'That page does not exist.');
      }
      const drawn = state.pages.get(version);
      if (drawn === 'unsupported') {
        return fail(
          404,
          'no_preview',
          "There's no preview for this kind of file. You can save a copy to open it.",
        );
      }
      if (n > PREVIEW_MAX_PAGES || (typeof drawn === 'number' && n > drawn)) {
        return fail(
          404,
          'no_preview',
          "There's no preview of this page. You can save a copy to open it.",
        );
      }
      if (drawn === undefined) {
        return respond(
          404,
          {
            error: {
              code: 'preview_pending',
              message: 'The preview is being made. Try again in a moment.',
              retriable: true,
              request_id: 'fake',
            },
          },
          { 'retry-after': '3' },
        );
      }
      return picture(FAKE_PAGE);
    }
    // Essentials a phone may keep (0.4.13), as the real vault answers them.
    if (path.startsWith('/api/v1/offline/')) {
      const s = session();
      if (!('id' in s)) return s;
      const o = state.offlineEssentials;
      // The grant is the session's, as the real vault keeps it; lapsed is none.
      const grant =
        s.offlineGrant && Date.parse(s.offlineGrant.expires_at) > Date.now()
          ? s.offlineGrant
          : null;
      const visible = (i: OfflineItem) => !i.private || grant?.include_private === true;
      if (path === '/api/v1/offline/grant' && init.method === 'POST') {
        // As the real vault: an app installation (the session's) first, then the password.
        if (!s.installation) {
          return fail(422, 'validation_failed', 'Only the app keeps documents on a phone.');
        }
        if (body.password !== state.password)
          return fail(401, 'invalid_credentials', "That password isn't right.");
        const now = Date.now();
        s.offlineGrant = {
          granted_at: new Date(now).toISOString(),
          expires_at: new Date(now + 30 * 86_400_000).toISOString(),
          include_private: body.include_private === true,
        };
        return ok(s.offlineGrant);
      }
      if (path === '/api/v1/offline/grant' && init.method === 'DELETE') {
        s.offlineGrant = null;
        return empty();
      }
      if (path === '/api/v1/offline/essentials' && init.method === 'GET') {
        // No grant in force: keep nothing.
        return ok({
          items: grant ? o.items.filter(visible) : [],
          grant,
          max_offline_days: FAKE_OFFLINE_MAX_DAYS,
          server_time: new Date().toISOString(),
          truncated: false,
        });
      }
      const pageOf = /^\/api\/v1\/offline\/pages\/([^/]+)\/(\d+)$/.exec(path);
      if (pageOf && init.method === 'GET') {
        const item = o.items.find((i) => i.version.id === pageOf[1] && visible(i));
        if (!item) return fail(404, 'not_found', 'That page does not exist.');
        if (!grant) {
          return fail(
            403,
            'offline_grant_required',
            'Please confirm it is you to keep Essentials on this phone.',
          );
        }
        const drawn = item.version.preview_pages;
        if (drawn === null) {
          return respond(
            404,
            {
              error: {
                code: 'preview_pending',
                message: 'The preview is being made. Try again in a moment.',
                retriable: true,
                request_id: 'fake',
              },
            },
            { 'retry-after': '3' },
          );
        }
        if (Number(pageOf[2]) > drawn) {
          return fail(
            404,
            'no_preview',
            "There's no preview of this page. You can save a copy to open it.",
          );
        }
        return picture(FAKE_PAGE);
      }
      if (path === '/api/v1/offline/opens' && init.method === 'POST') {
        const events = (body.events as Array<{ id: string; version_id: string }> | undefined) ?? [];
        if (events.length > 200) return fail(422, 'validation_failed', 'At most 200 at a time.');
        const result = { accepted: 0, duplicates: 0, dropped: 0 };
        for (const e of events) {
          if (!o.items.some((i) => i.version.id === e.version_id)) result.dropped += 1;
          else if (o.received.has(e.id)) result.duplicates += 1;
          else {
            o.received.add(e.id);
            result.accepted += 1;
          }
        }
        return ok(result);
      }
    }
    if (path === '/api/v1/document-types' && init.method === 'GET') {
      const s = session();
      if (!('id' in s)) return s;
      // As the real vault (0.5.6): a hidden type stays while a document uses
      // it — app 0.2.0 looks its documents' types up in this list — and
      // ?all=true lists every one.
      const all = param(url, 'all') === 'true';
      const inUse = (key: string) => state.documents.some((d) => d.type_key === key);
      return ok({
        items: state.types.filter((t) => all || !t.hidden || inUse(t.key)).map(typeAnswer),
      });
    }
    if (path === '/api/v1/document-attributes' && init.method === 'GET') {
      const s = session();
      if (!('id' in s)) return s;
      return ok({ items: state.attributes });
    }
    // Kinds of document, managed (0.5.10), as the real vault manages them.
    // The fake signs in as an owner, who may do all of it.
    if (path === '/api/v1/document-attributes' && init.method === 'POST') {
      const s = session();
      if (!('id' in s)) return s;
      const long = tooLong([
        [body.label, 'The name'],
        ...((body.choices as string[] | null | undefined) ?? []).map(
          (c) => [c, 'An answer'] as const,
        ),
      ]);
      if (long) return long;
      const label = tidy(body.label as string | undefined);
      if (!label) return fail(422, 'validation_failed', 'Give the field a name.', 'label');
      // A name the library has, a built-in's included, in any case (0.5.15).
      const same = state.attributes.find((a) => a.label.toLowerCase() === label.toLowerCase());
      if (same) return fail(422, 'validation_failed', libraryHasName(same.label), 'label');
      const kind = body.kind as DocumentAttributeView['kind'];
      const answers = [
        ...new Set(((body.choices as string[] | null | undefined) ?? []).map(tidy)),
      ].filter((c): c is string => c !== null);
      if (kind === 'choice' && answers.length === 0) {
        return fail(422, 'validation_failed', 'Give a choice at least one answer.', 'choices');
      }
      if (kind !== 'choice' && answers.length > 0) {
        return fail(
          422,
          'validation_failed',
          'Only a choice has answers to choose from.',
          'choices',
        );
      }
      const made: DocumentAttributeView = {
        key: ownKey(),
        label,
        kind,
        choices: kind === 'choice' ? answers : null,
        builtin: false,
      };
      state.attributes.push(made);
      return ok(made, 201);
    }
    if (path === '/api/v1/document-types' && init.method === 'POST') {
      const s = session();
      if (!('id' in s)) return s;
      const long = tooLong([
        [body.label, 'The name'],
        [body.short_label, 'The short name'],
        [body.issuer_noun, 'The word after who issued it'],
      ]);
      if (long) return long;
      const label = tidy(body.label as string | undefined);
      if (!label) {
        return fail(422, 'validation_failed', 'Give the kind of document a name.', 'label');
      }
      const category = (body.category as string | undefined) ?? 'other';
      if (!(category in CATEGORY_LABELS)) {
        return fail(
          422,
          'validation_failed',
          'Choose one of the categories the vault has.',
          'category',
        );
      }
      // As the real vault: the household's own is archived, never hidden.
      if (body.hidden !== undefined) {
        return fail(
          422,
          'validation_failed',
          'A kind of document of your own is archived, not hidden.',
          'hidden',
        );
      }
      const sent = (body.core ?? {}) as TypeChange['core'];
      const expires = sent?.expires?.shown === true;
      const t: DocumentTypeView = {
        key: ownKey(),
        label,
        category,
        fields: [],
        expiry_driver: expires ? 'expires_on' : null,
        // What it reminds from is worked out below, on the kind as made.
        reminder_leads: [],
        remind_from: null,
        usually_essential: (body.usually_essential as boolean | undefined) ?? false,
        default_visibility: (body.default_visibility as Visibility | undefined) ?? 'household',
        issued_by_label: null,
        builtin: false,
        hidden: false,
        core: coreOf({ expiry_driver: expires ? 'expires_on' : null }),
        short_label: tidy(body.short_label as string | null | undefined),
        issuer_noun: tidy(body.issuer_noun as string | null | undefined),
      };
      const problem =
        changeType(t, { core: sent, fields: body.fields as TypeChange['fields'] }) ??
        remind(null, t, body);
      if (problem) return problem;
      state.types.push(t);
      return ok(typeAnswer(t), 201);
    }
    const typeAt = /^\/api\/v1\/document-types\/([^/]+)(\/archive|\/restore|\/impact)?$/.exec(path);
    if (typeAt) {
      const s = session();
      if (!('id' in s)) return s;
      const t = state.types.find((x) => x.key === decodeURIComponent(typeAt[1] as string));
      if (!t) return fail(404, 'not_found', 'That kind of document is not on the list.');
      const action = typeAt[2];
      const used = state.documents.filter((d) => d.type_key === t.key);
      if (action === undefined && init.method === 'PATCH') {
        // As the real vault: a change made to a kind somebody has since
        // changed is refused, not laid over theirs.
        const ifMatch = init.headers['if-match'];
        if (ifMatch && ifMatch !== typeTag(t)) {
          // The kind as it now is, to reload from.
          return fail(
            409,
            'conflict',
            'Someone else changed this kind of document. Reload and try again.',
            JSON.stringify(typeAnswer(t)),
          );
        }
        const named = ['label', 'category', 'short_label', 'issuer_noun'].some(
          (k) => body[k] !== undefined,
        );
        if (t.builtin && named) {
          return fail(
            422,
            'validation_failed',
            'A built-in kind of document keeps its name and category. Add a kind of your own to call it something else.',
          );
        }
        if (!t.builtin && body.hidden !== undefined) {
          return fail(
            422,
            'validation_failed',
            'A kind of document of your own is archived, not hidden.',
            'hidden',
          );
        }
        if (body.category !== undefined && !((body.category as string) in CATEGORY_LABELS)) {
          return fail(
            422,
            'validation_failed',
            'Choose one of the categories the vault has.',
            'category',
          );
        }
        const long = tooLong([
          [body.label, 'The name'],
          [body.short_label, 'The short name'],
          [body.issuer_noun, 'The word after who issued it'],
        ]);
        if (long) return long;
        const next: DocumentTypeView = JSON.parse(JSON.stringify(t)) as DocumentTypeView;
        if (body.label !== undefined) {
          const label = tidy(body.label as string);
          if (!label) {
            return fail(422, 'validation_failed', 'Give the kind of document a name.', 'label');
          }
          next.label = label;
        }
        if (body.category !== undefined) next.category = body.category as string;
        if (body.short_label !== undefined)
          next.short_label = tidy(body.short_label as string | null);
        if (body.issuer_noun !== undefined)
          next.issuer_noun = tidy(body.issuer_noun as string | null);
        if (body.default_visibility !== undefined) {
          next.default_visibility = body.default_visibility as Visibility;
        }
        if (body.usually_essential !== undefined) {
          next.usually_essential = body.usually_essential as boolean;
        }
        if (body.hidden !== undefined) next.hidden = body.hidden as boolean;
        // Its fields and Expires, then what it reminds from on the kind as
        // it will be — Expires switched on with no lead times: 30 days, as
        // a new kind (0.5.15: `nextReminder`, as the vault).
        const problem =
          changeType(next, {
            core: body.core as TypeChange['core'],
            fields: body.fields as TypeChange['fields'],
          }) ?? remind(t, next, body);
        if (problem) return problem;
        Object.assign(t, next);
        bump(t);
        return ok(typeAnswer(t));
      }
      if (action === undefined && init.method === 'DELETE') {
        if (t.builtin) {
          return fail(
            422,
            'validation_failed',
            "A built-in kind of document can't be deleted. Hide it instead.",
          );
        }
        if (used.length > 0) return fail(409, 'type_in_use', TYPE_IN_USE);
        state.types.splice(state.types.indexOf(t), 1);
        // Out of every restriction that named it, as the real vault's rows
        // go with it (0054): limits_types stays as it was, so limits that
        // named only it give nothing by kind (R532-01, the 5.33 review).
        for (const r of state.restrictions.values()) {
          r.types = r.types.filter((k) => k !== t.key);
        }
        return empty();
      }
      if ((action === '/archive' || action === '/restore') && init.method === 'POST') {
        const hidden = action === '/archive';
        if (t.hidden !== hidden) {
          t.hidden = hidden;
          bump(t);
        }
        return ok(typeAnswer(t));
      }
      if (action === '/impact' && init.method === 'GET') {
        const count = (has: (d: FakeDocument) => boolean) => {
          const n = used.filter(has).length;
          return { with_value: n, without_value: used.length - n };
        };
        const given = (v: unknown) =>
          v !== undefined &&
          v !== null &&
          !(typeof v === 'string' && v.trim() === '') &&
          !(Array.isArray(v) && v.length === 0);
        // Its reminders not dealt with yet, and by the date each is about (0.5.15).
        const open = state.reminders.filter(
          (r) =>
            r.kind === 'derived' &&
            ['scheduled', 'due', 'snoozed'].includes(r.status) &&
            used.some((d) => d.id === r.document_id),
        );
        const bySource: Record<string, number> = {};
        for (const r of open) {
          const source = r.source ?? 'expires';
          bySource[source] = (bySource[source] ?? 0) + 1;
        }
        const impact: DocumentTypeImpact = {
          key: t.key,
          documents: used.length,
          in_trash: 0,
          core: Object.fromEntries(
            CORE_FIELDS.map((f) => [f, count((d) => given((d as Record<string, unknown>)[f]))]),
          ) as DocumentTypeImpact['core'],
          fields: [
            ...t.fields.map((f) => ({
              key: f.key,
              label: f.label,
              ...count((d) => given(d.extra?.[f.key])),
            })),
            // Then every other field one of them keeps a value for, as the
            // vault counts them (a field the kind dropped: 5.12).
            ...[
              ...new Set(
                used.flatMap((d) => Object.keys(d.extra ?? {}).filter((k) => given(d.extra?.[k]))),
              ),
            ]
              .filter((k) => !t.fields.some((f) => f.key === k))
              .sort()
              .map((key) => ({ key, label: null, ...count((d) => given(d.extra?.[key])) })),
          ],
          reminders: open.length,
          reminders_by_source: bySource,
          unseen: UNSEEN_DOCUMENTS,
        };
        return ok(impact);
      }
    }
    // Collections of documents (0.5.12), as the real vault keeps them: a collection
    // exists only for its maker and whoever is in its audience (a viewer is
    // in none); each reader is given the documents in it they can see,
    // counted as they see them; only its maker changes it, while they are
    // in its audience, and deletes it whatever their role; an owner deletes
    // one nobody may change any more.
    const me = { role: state.role, memberId: 'fake-member' };
    const collectionAt = /^\/api\/v1\/collections\/([^/]+)(\/items(?:\/([^/]+))?)?$/.exec(path);
    const docCollections = /^\/api\/v1\/documents\/([^/]+)\/collections$/.exec(path);
    if (path === '/api/v1/collections' || collectionAt || docCollections) {
      const s = session();
      if (!('id' in s)) return s;
      const shown = (l: FakeCollection) => !l.deleted && canSeeCollection(me, l);
      const onIt = (l: FakeCollection) =>
        l.items
          .map((i) => ({ ...i, doc: state.documents.find((d) => d.id === i.document_id) }))
          .filter(
            (i): i is typeof i & { doc: FakeDocument } =>
              i.doc !== undefined &&
              canSee(me, {
                visibility: i.doc.visibility ?? 'household',
                owner_member_id: i.doc.owner_member_id ?? null,
              }),
          );
      const collectionTag = (l: FakeCollection) => `"${l.id}.${l.revision}"`;
      const collectionView = (l: FakeCollection): CollectionView => ({
        id: l.id,
        name: l.name,
        description: l.description,
        audience: l.audience,
        owner_member_id: l.owner_member_id,
        mine: l.owner_member_id === me.memberId,
        item_count: onIt(l).length,
        created_at: l.created_at,
        updated_at: l.updated_at,
        etag: collectionTag(l),
        // The fake shares nothing outside the family (5.19): no link works for any.
        shared_outside: null,
      });
      /** A collection and a page of what is in it: its first, unless asked. */
      const detail = (
        l: FakeCollection,
        from = 0,
        limit = COLLECTION_ITEMS_PAGE,
      ): CollectionDetail => {
        const all = onIt(l);
        const shown = all.slice(from, from + limit);
        const more = from + limit < all.length;
        const last = shown[shown.length - 1];
        return {
          ...collectionView(l),
          items: shown.map((i) => ({
            document: listedOf(i.doc),
            added_at: i.added_at,
            hint:
              l.owner_member_id === me.memberId
                ? collectionItemHint(l.audience, {
                    visibility: i.doc.visibility ?? 'household',
                    owner_member_id: i.doc.owner_member_id ?? null,
                  })
                : null,
          })),
          next_cursor: more && last ? `after.${last.document_id}` : null,
          has_more: more,
        };
      };
      /**
       * The page GET /collections/{id} asks for: 50 unless `limit` says (200 at
       * most), after the document `cursor` names — one the reader is given
       * in it, or the cursor is not valid.
       */
      const paged = (l: FakeCollection): CollectionDetail | ResponseLike => {
        const asked = param(url, 'limit');
        const limit = asked === undefined ? COLLECTION_ITEMS_PAGE : Number(asked);
        if (!Number.isInteger(limit) || limit < 1 || limit > COLLECTION_ITEMS_PAGE_MAX) {
          return fail(422, 'validation_failed', 'That page size is not valid.');
        }
        const cursor = param(url, 'cursor');
        if (cursor === undefined) return detail(l, 0, limit);
        const after = /^after\.(.+)$/.exec(cursor)?.[1];
        const at = onIt(l).findIndex((i) => i.document_id === after);
        if (at < 0) return fail(422, 'validation_failed', 'That page cursor is not valid.');
        return detail(l, at + 1, limit);
      };
      /**
       * Whose role now, of the member who made a collection: the fake's own,
       * or one of `state.members`.
       */
      const roleOf = (memberId: string): Role | undefined =>
        memberId === me.memberId
          ? state.role
          : (state.members.find((m) => m.id === memberId)?.role as Role | undefined);
      /** Nobody may change it any more: its maker has no sign-in, or is outside its audience. */
      const stranded = (l: FakeCollection) => {
        const role = roleOf(l.owner_member_id);
        return role === undefined || !inCollectionAudience(role, l.audience);
      };
      // By name, whatever the case; made first, first (a stable sort).
      const byName = (a: FakeCollection, b: FakeCollection) => {
        const [x, y] = [a.name.toLowerCase(), b.name.toLowerCase()];
        return x < y ? -1 : x > y ? 1 : 0;
      };
      const manage = () =>
        can(state.role, 'collection.manage')
          ? null
          : fail(403, 'forbidden', refusalFor('collection.manage'));
      /** The name, words and audience asked for, as the real vault takes them; or a refusal. */
      const fields = (
        l: Pick<FakeCollection, 'name' | 'description' | 'audience'>,
      ): ResponseLike | Pick<FakeCollection, 'name' | 'description' | 'audience'> => {
        const out = { ...l };
        if (body.name !== undefined) {
          const name = tidy(body.name as string);
          if (!name) return fail(422, 'validation_failed', 'Give the collection a name.', 'name');
          if (name.length > COLLECTION_NAME_MAX) {
            return fail(
              422,
              'validation_failed',
              `A collection’s name is too long: ${COLLECTION_NAME_MAX} characters at most.`,
              'name',
            );
          }
          out.name = name;
        }
        if (body.description !== undefined) {
          const words = (body.description as string | null)?.trim() || null;
          if ((words?.length ?? 0) > COLLECTION_DESCRIPTION_MAX) {
            return fail(
              422,
              'validation_failed',
              `What a collection is for is too long: ${COLLECTION_DESCRIPTION_MAX} characters at most.`,
              'description',
            );
          }
          out.description = words;
        }
        if (body.audience !== undefined) {
          const audience = body.audience as CollectionAudience;
          if (!COLLECTION_AUDIENCES.includes(audience)) {
            return fail(422, 'validation_failed', 'Say who the collection is for.', 'audience');
          }
          if (!inCollectionAudience(state.role, audience)) {
            return fail(403, 'forbidden', 'Only an adult can make a collection for the adults.');
          }
          out.audience = audience;
        }
        return out;
      };

      if (path === '/api/v1/collections' && init.method === 'GET') {
        return ok({ items: state.collections.filter(shown).sort(byName).map(collectionView) });
      }
      if (path === '/api/v1/collections' && init.method === 'POST') {
        const refused = manage();
        if (refused) return refused;
        if (body.name === undefined) {
          return fail(422, 'validation_failed', 'Give the collection a name.', 'name');
        }
        if (body.audience === undefined) {
          return fail(422, 'validation_failed', 'Say who the collection is for.', 'audience');
        }
        const asked = fields({ name: '', description: null, audience: 'only_me' });
        if (isResponse(asked)) return asked;
        const at = new Date().toISOString();
        const l: FakeCollection = {
          id: next('collection'),
          ...asked,
          owner_member_id: me.memberId,
          created_at: at,
          updated_at: at,
          revision: 1,
          deleted: false,
          items: [],
        };
        state.collections.push(l);
        return respond(201, detail(l), { etag: collectionTag(l) });
      }
      if (docCollections && init.method === 'GET') {
        const doc = state.documents.find(
          (d) => d.id === decodeURIComponent(docCollections[1] as string),
        );
        if (!doc) return fail(404, 'not_found', 'That document is not in the vault.');
        const on = state.collections.filter(
          (l) => shown(l) && l.items.some((i) => i.document_id === doc.id),
        );
        return ok({ items: on.sort(byName).map(collectionView) });
      }
      if (collectionAt) {
        const found = state.collections.find(
          (x) => x.id === decodeURIComponent(collectionAt[1] as string),
        );
        const l = found && shown(found) ? found : undefined;
        const mine = l !== undefined && l.owner_member_id === me.memberId;
        const notYours = () =>
          fail(403, 'forbidden', 'Only the person who made this collection can change it.');
        // Its maker deletes it whatever their role now; anybody else needs
        // collection.manage, and then an owner only one nobody may change any more.
        if (!collectionAt[2] && init.method === 'DELETE') {
          const refused = mine ? null : manage();
          if (refused) return refused;
          if (!l) return fail(404, 'not_found', 'That collection does not exist.');
          if (!mine && (state.role !== 'owner' || !stranded(l))) return notYours();
          l.deleted = true;
          leavesGrants(l.id);
          return empty();
        }
        const changing = init.method !== 'GET';
        const refused = changing ? manage() : null;
        if (refused) return refused;
        if (!l) return fail(404, 'not_found', 'That collection does not exist.');
        if (!collectionAt[2] && init.method === 'GET') {
          const page = paged(l);
          return isResponse(page) ? page : respond(200, page, { etag: collectionTag(l) });
        }
        if (changing && !mine) return notYours();
        if (changing && !inCollectionAudience(state.role, l.audience)) {
          return fail(
            403,
            'forbidden',
            'This collection is for people you are no longer one of. You can still delete it, but not change it.',
          );
        }
        if (!collectionAt[2] && init.method === 'PATCH') {
          const ifMatch = init.headers['if-match'];
          if (ifMatch && ifMatch !== collectionTag(l)) {
            return fail(
              409,
              'conflict',
              'This collection was changed since you opened it. Reload and try again.',
              JSON.stringify(detail(l)),
            );
          }
          const asked = fields(l);
          if (isResponse(asked)) return asked;
          if (
            asked.name !== l.name ||
            asked.description !== l.description ||
            asked.audience !== l.audience
          ) {
            const wasEveryone = l.audience === 'everyone';
            Object.assign(l, asked, { updated_at: new Date().toISOString() });
            l.revision += 1;
            // Made for fewer than Everyone, it leaves every grant (0055).
            if (wasEveryone && l.audience !== 'everyone') leavesGrants(l.id);
          }
          return respond(200, detail(l), { etag: collectionTag(l) });
        }
        if (collectionAt[2] && !collectionAt[3] && init.method === 'POST') {
          const ids = [...new Set((body.document_ids as string[] | undefined) ?? [])];
          if (ids.length === 0) {
            return fail(422, 'validation_failed', 'Choose a document to put in the collection.');
          }
          // Each one the maker can see, or none is put in.
          const seen = (id: string) => {
            const d = state.documents.find((x) => x.id === id);
            return (
              d !== undefined &&
              canSee(me, {
                visibility: d.visibility ?? 'household',
                owner_member_id: d.owner_member_id ?? null,
              })
            );
          };
          if (!ids.every(seen)) return fail(404, 'not_found', 'That document is not in the vault.');
          for (const id of ids) {
            if (l.items.some((i) => i.document_id === id)) continue;
            l.items.push({ document_id: id, added_at: new Date().toISOString() });
          }
          return respond(200, detail(l), { etag: collectionTag(l) });
        }
        if (collectionAt[3] && init.method === 'DELETE') {
          const id = decodeURIComponent(collectionAt[3]);
          if (!state.documents.some((d) => d.id === id)) {
            return fail(404, 'not_found', 'That document is not in the vault.');
          }
          const at = l.items.findIndex((i) => i.document_id === id);
          if (at < 0) return fail(404, 'not_found', 'That document is not in this collection.');
          l.items.splice(at, 1);
          return empty();
        }
      }
    }
    // What came in through a request, looked at before it is filed (0.5.23):
    // the reviewer's side. A teen or a viewer is told there is nothing here.
    const incomingAt =
      /^\/api\/v1\/incoming(?:\/([^/]+)\/(pages\/(\d+)|content|accept|reject))?$/.exec(path);
    if (incomingAt) {
      const s = session();
      if (!('id' in s)) return s;
      const notHere = () => fail(404, 'not_found', 'That file is not waiting for you.');
      if (!can(state.role, 'upload_request.create')) return notHere();
      const [, id, what, n] = incomingAt;
      if (!id && init.method === 'GET') {
        return ok({
          items: state.incoming
            .filter((f) => !f.decided)
            .map(({ bytes: _bytes, decided: _decided, ...view }) => view),
        });
      }
      const f = state.incoming.find((x) => x.id === decodeURIComponent(id ?? ''));
      if (!f) return notHere();
      const decided = () =>
        fail(409, 'already_decided', 'Somebody has filed or refused this file already.');
      const notReady = () =>
        respond(409, {
          error: {
            code: 'incoming_not_ready',
            message: 'This file is still being got ready to look at. Try again in a minute.',
            retriable: true,
            request_id: 'fake',
          },
        });
      if (what?.startsWith('pages/') && init.method === 'GET') {
        if (f.decided) return decided();
        if (f.preview_state === 'pending') {
          return fail(404, 'preview_pending', 'The preview is being made. Try again in a moment.');
        }
        if (f.preview_state !== 'ready' || Number(n) > (f.preview_pages ?? 0)) {
          return fail(404, 'no_preview', "There's no preview of this page.");
        }
        return picture(FAKE_PAGE);
      }
      if (what === 'content' && init.method === 'GET') {
        if (f.decided) return decided();
        if (f.scan_state === 'pending') return notReady();
        return attachment(f.bytes, {
          'content-type': f.content_type,
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(incomingFileName(f.name, f.content_type))}`,
          'x-content-type-options': 'nosniff',
          ...(f.scan_state === 'clean' ? {} : { 'x-fdv-scan': 'unscanned' }),
        });
      }
      if (what === 'reject' && init.method === 'POST') {
        if (f.decided) return decided();
        f.decided = 'rejected';
        return empty();
      }
      if (what === 'accept' && init.method === 'POST') {
        if (f.decided) return decided();
        const into = typeof body.into_document_id === 'string' ? body.into_document_id : null;
        const fields = ['owner_member_id', 'type_key', 'title', 'visibility'];
        if (into && fields.some((k) => body[k] !== undefined)) {
          return fail(
            422,
            'validation_failed',
            'Add it to a document, or make a new one with these details: not both.',
          );
        }
        if (f.scan_state === 'pending') return notReady();
        let documentId: string;
        if (into) {
          if (!state.documents.some((d) => d.id === into)) {
            return fail(404, 'not_found', 'That document is not in the vault.');
          }
          documentId = into;
        } else {
          const metadata: CaptureMetadata = {
            ...(body.owner_member_id !== undefined
              ? { owner_member_id: body.owner_member_id as string | null }
              : {}),
            ...(body.type_key !== undefined ? { type_key: body.type_key as string | null } : {}),
            ...(body.title !== undefined ? { title: (body.title as string | null) || null } : {}),
            ...(body.visibility !== undefined ? { visibility: body.visibility as Visibility } : {}),
          };
          const problem = checkCaptureMetadata(metadata, {
            me: { member_id: 'fake-member', role: state.role },
            members: state.members,
            types: state.types,
          });
          // Refused as the vault refuses it, naming the detail: a kind the
          // household does not have included (not filed with no kind, as a
          // phone's queued capture is: this is chosen now, from the list).
          if (problem) {
            return fail(
              problem.status,
              problem.status === 403 ? 'forbidden' : 'validation_failed',
              problem.message,
              problem.key ?? problem.field,
            );
          }
          const doc: FakeDocument = {
            id: next('document'),
            title: metadata.title ?? null,
            type_key: metadata.type_key ?? null,
            owner_member_id: metadata.owner_member_id ?? null,
            visibility: effectiveVisibility(
              metadata,
              state.types.find((t) => t.key === metadata.type_key),
              state.role,
            ),
          };
          state.documents.push(doc);
          documentId = doc.id;
        }
        const made: FakeUpload = {
          kind: into ? 'version' : 'capture',
          document_id: documentId,
          version_id: next('version'),
          version_no: versionsOf(documentId).length + 1,
          filename: incomingFileName(f.name, f.content_type),
          mime: f.content_type,
          byte_size: f.bytes.length,
          uploaded_at: new Date().toISOString(),
        };
        // Kept as an upload is, under a key nobody will send.
        state.captures.set(next('incoming-upload'), made);
        f.decided = 'accepted';
        return ok({ document_id: documentId, version_id: made.version_id }, 201);
      }
    }
    // Asking somebody to send documents (0.5.21): the family's side. A teen
    // or a viewer is told there is nothing here, as the vault tells them.
    const uploadAt = /^\/api\/v1\/upload-requests(?:\/([^/]+)(\/resume)?)?$/.exec(path);
    if (uploadAt) {
      const s = session();
      if (!('id' in s)) return s;
      if (!can(state.role, 'upload_request.create')) {
        return fail(404, 'not_found', 'That page does not exist.');
      }
      const [, id, resume] = uploadAt;
      if (!id && init.method === 'GET') {
        return ok({ items: state.uploadRequests, email_code_available: false });
      }
      if (!id && init.method === 'POST') {
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        if (!title) return fail(422, 'validation_failed', 'Give the request a title.');
        const end = new Date(typeof body.expires_at === 'string' ? body.expires_at : NaN);
        const now = Date.now();
        if (Number.isNaN(end.getTime()) || end.getTime() < now + 5 * 60_000) {
          return fail(422, 'expiry_out_of_range', 'Choose a time at least 5 minutes from now.');
        }
        if (end.getTime() > now + 90 * 864e5 + 5 * 60_000) {
          return fail(422, 'expiry_out_of_range', 'A request can last 90 days at most.');
        }
        if (body.email_code === true) {
          return fail(
            422,
            'email_code_unavailable',
            'This vault cannot send email codes: whoever runs it has not given it a mail server.',
          );
        }
        const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
        const made: UploadRequestView = {
          id: next('upload-request'),
          title,
          message: text(body.message),
          items: (Array.isArray(body.items) ? (body.items as string[]) : []).map((label) => ({
            id: next('item'),
            label,
          })),
          recipient_label: text(body.recipient_label),
          recipient_email: text(body.recipient_email),
          requested_by_name: state.members.find((m) => m.is_me)?.display_name ?? null,
          mine: true,
          created_at: new Date(now).toISOString(),
          expires_at: end.toISOString(),
          protection: body.with_password || body.password ? ['password'] : [],
          max_visits: typeof body.max_visits === 'number' ? body.max_visits : null,
          visits_used: 0,
          max_files: typeof body.max_files === 'number' ? body.max_files : 10,
          files_used: 0,
          max_total_bytes:
            typeof body.max_total_bytes === 'number' ? body.max_total_bytes : 200 * 1024 * 1024,
          bytes_used: 0,
          accept_types: body.accept_types === 'office' ? 'office' : 'standard',
          review_by: body.review_by === 'adults' ? 'adults' : 'me',
          suggested_member_id: text(body.suggested_member_id),
          suggested_type_key: text(body.suggested_type_key),
          close_after_submit: body.close_after_submit === true,
          state: 'active',
          paused_reason: null,
          closed_reason: null,
          files_received: 0,
        };
        state.uploadRequests.unshift(made);
        return ok(
          {
            request: made,
            link_token: next('drop-token'),
            link_url: null,
            ...(body.with_password ? { password: 'abcd-efgh-jkmn' } : {}),
          },
          201,
        );
      }
      const r = state.uploadRequests.find((x) => x.id === id);
      if (!r) return fail(404, 'not_found', 'That request does not exist.');
      if (!resume && init.method === 'DELETE') {
        Object.assign(r, { state: 'revoked', recipient_email: null });
        return empty();
      }
      if (resume && init.method === 'POST') {
        if (!can(state.role, 'restore.review')) {
          return fail(403, 'forbidden', refusalFor('restore.review'));
        }
        if (r.state !== 'paused')
          return fail(404, 'not_found', 'That paused request does not exist.');
        Object.assign(r, { state: 'active', paused_reason: null });
        return ok(r);
      }
    }
    if (path === '/api/v1/members' && init.method === 'GET') {
      const s = session();
      if (!('id' in s)) return s;
      // The worker, as far as the fake has one: a photo on its way is made
      // by the time anybody asks again.
      for (const [memberId, photoId] of state.photosOnTheirWay) {
        const m = state.members.find((x) => x.id === memberId);
        if (m) Object.assign(m, { photo: { id: photoId }, photo_status: null });
      }
      state.photosOnTheirWay.clear();
      // The family (5.34): a guest only to themselves. An owner's
      // `?kind=guest`: the guests alone.
      const me = whoOf(s);
      if (param(url, 'kind') === 'guest') {
        if (me.role !== 'owner') {
          return fail(403, 'forbidden', 'Only an owner sees the people outside the family.');
        }
        return ok({
          items: state.members.filter((m) => m.kind === 'guest').map(memberAnswer),
        });
      }
      return ok({
        items: state.members
          .filter((m) => m.kind !== 'guest' || m.id === me.memberId)
          .map(memberAnswer),
      });
    }
    // Invitations (5.34): the rules the real vault keeps for a guest, and
    // for an owner's decision about what a viewer sees.
    if (path === '/api/v1/invitations' && init.method === 'GET') {
      const s = session();
      if (!('id' in s)) return s;
      if (!can(whoOf(s).role, 'member.invite')) {
        return fail(403, 'forbidden', refusalFor('member.invite'));
      }
      return ok({ items: state.invitations.map((i) => i.view) });
    }
    if (path === '/api/v1/invitations' && init.method === 'POST') {
      const s = session();
      if (!('id' in s)) return s;
      return invite(whoOf(s), body);
    }
    if (path === '/api/v1/invitations/accept' && init.method === 'POST') {
      return acceptInvitation(body, init.headers['x-fdv-installation'] ?? null);
    }
    // A guest's sign-in renewed (5.34, A28), refused in the real vault's order.
    const renewAt = /^\/api\/v1\/members\/([^/]+)\/renew$/.exec(path);
    if (renewAt && init.method === 'POST') {
      const s = session();
      if (!('id' in s)) return s;
      if (!can(whoOf(s).role, 'role.change')) {
        return fail(403, 'forbidden', refusalFor('role.change'));
      }
      const keys = Object.keys(body);
      if (
        typeof body.access_expires_at !== 'string' ||
        keys.some((k) => k !== 'access_expires_at')
      ) {
        return fail(422, 'validation_failed', 'Say when their access ends.', 'access_expires_at');
      }
      if (!state.ownerTwoStep) {
        return fail(
          403,
          'totp_required_for_owner',
          "Turn on two-step sign-in to renew a guest's sign-in.",
        );
      }
      const problem = guestEndProblem(new Date(body.access_expires_at));
      if (problem) return fail(422, 'validation_failed', problem, 'access_expires_at');
      const m = state.members.find((x) => x.id === decodeURIComponent(renewAt[1] as string));
      if (!m || !m.role) return fail(404, 'not_found', 'They have no sign-in to renew.');
      if (m.kind !== 'guest') {
        return fail(
          409,
          'not_a_guest',
          `${m.display_name} is of the family: their sign-in has no end to renew.`,
        );
      }
      m.access_expires_at = new Date(body.access_expires_at).toISOString();
      return ok({ member_id: m.id, access_expires_at: m.access_expires_at });
    }
    // A change of role (5.34's rule only, beside a plain change): a guest is
    // a viewer and nothing else.
    const roleAt = /^\/api\/v1\/members\/([^/]+)\/role$/.exec(path);
    if (roleAt && init.method === 'POST') {
      const s = session();
      if (!('id' in s)) return s;
      if (!can(whoOf(s).role, 'role.change')) {
        return fail(403, 'forbidden', refusalFor('role.change'));
      }
      const m = state.members.find((x) => x.id === decodeURIComponent(roleAt[1] as string));
      if (!m || !m.role) return fail(404, 'not_found', 'That sign-in does not exist.');
      const to = String(body.role) as Role;
      if (m.role === to) {
        return ok({
          applied: false,
          role: to,
          message: `${m.display_name} is already that.`,
          effects: [],
        });
      }
      if (m.kind === 'guest') return fail(409, 'guest', GUEST_ONLY_VIEWER(m.display_name));
      m.role = to;
      return ok({
        applied: true,
        role: to,
        message: `${m.display_name}'s role changed.`,
        effects: [],
      });
    }
    // A person's photo (0.5.19), as the vault takes one: the crop first, then
    // the picture, and nothing else; a photo, by what it says it is.
    const photoAt = /^\/api\/v1\/members\/([^/]+)\/photo(?:\/([^/]+))?$/.exec(path);
    if (photoAt) {
      const s = session();
      if (!('id' in s)) return s;
      const m = state.members.find((x) => x.id === decodeURIComponent(photoAt[1] as string));
      if (photoAt[2] !== undefined) {
        if (init.method !== 'GET') return fail(404, 'not_found', 'Not here.');
        return m?.photo && m.photo.id === decodeURIComponent(photoAt[2])
          ? picture(FAKE_PAGE)
          : fail(404, 'no_photo', 'There is no photo here.');
      }
      if (!m) return fail(404, 'not_found', 'That person is not in the family.');
      if (init.method === 'DELETE') {
        Object.assign(m, { photo: null, photo_status: null });
        state.photosOnTheirWay.delete(m.id);
        return empty();
      }
      if (init.method !== 'PUT') return fail(404, 'not_found', 'Not here.');
      if (state.role === 'viewer') return fail(403, 'forbidden', refusalFor('member.photo'));
      const parts = partsOf(init.body) ?? [];
      const order = parts.map((p) => (p.value === null ? `file:${p.name}` : p.name)).join(',');
      if (order !== 'file:file' && order !== 'crop,file:file') {
        return fail(422, 'validation_failed', 'Send the crop first, then the photo.');
      }
      const file = parts[parts.length - 1] as Part;
      if (!PHOTO_TYPES.includes(file.type ?? '')) {
        return fail(415, 'unsupported_type', 'Choose a photo: JPEG, PNG, WebP or HEIC.');
      }
      if ((file.size ?? 0) > PHOTO_MAX_BYTES) {
        return fail(413, 'too_large', 'That photo is too big. Choose one of 20 MB or less.');
      }
      state.photosOnTheirWay.set(m.id, next('photo'));
      m.photo_status = 'processing';
      return ok(memberAnswer(m), 202);
    }
    // A person's details (5.25), changed as the caller saw them: If-Match on
    // their version, and an older one is a conflict, with them as they are.
    // People's identity details (5.26), as the real vault answers them.
    /**
     * The audience in effect: a widening whose 72 hours are up reads from
     * then, whichever request asks first (the 5.26 review).
     */
    const effectiveAudience = (): IdentityAudience => {
      const pending = state.identityPending;
      if (pending && Date.parse(pending.notice_until) <= Date.now()) {
        state.identityAudience = pending.to;
        state.identityPending = null;
      }
      return state.identityAudience;
    };
    /** What takes a passkey or a code, refused to whoever has neither, in its own words. */
    const needsTwoStep = (why: string) =>
      fail(
        403,
        state.role === 'owner' ? 'totp_required_for_owner' : 'two_step_required',
        `Turn on two-step sign-in ${why}.`,
      );
    if (path === '/api/v1/household/identity-audience') {
      const s = session();
      if (!('id' in s)) return s;
      effectiveAudience();
      const view = (): IdentityAudienceView => ({
        audience: state.identityAudience,
        pending: state.identityPending,
        can_change: can(state.role, 'identity.audience'),
      });
      if (init.method === 'GET') return ok(view());
      if (init.method !== 'PUT') return fail(404, 'not_found', 'Not here.');
      if (!can(state.role, 'identity.audience')) {
        return fail(403, 'forbidden', refusalFor('identity.audience'));
      }
      const to = (body as { audience?: string }).audience as IdentityAudience;
      if (!IDENTITY_AUDIENCES.includes(to)) {
        return fail(422, 'validation_failed', 'Choose who can see identity details.');
      }
      if (!state.ownerTwoStep) return needsTwoStep('to change who can see identity details');
      if (identityAudienceRank(to) <= identityAudienceRank(state.identityAudience)) {
        state.identityAudience = to;
        state.identityPending = null;
      } else if (state.identityPending?.to !== to) {
        // Everybody with a sign-in is told: anybody who cannot sign in holds
        // it back — switched off, and since 5.28 locked or paused, any role.
        const off = state.members
          .filter((m) => state.signInsOff.includes(m.id) || suspensionOf(m.id) !== null)
          .sort((a, b) =>
            a.display_name < b.display_name ? -1 : a.display_name > b.display_name ? 1 : 0,
          );
        if (off.length > 0) {
          return fail(
            409,
            'member_cannot_be_told',
            `${off.map((m) => m.display_name).join(', ')} cannot sign in just now, so could not be told, or mark anything Only me first. Let more people see identity details once everybody can sign in.`,
          );
        }
        const now = Date.now();
        state.identityPending = {
          to,
          requested_at: new Date(now).toISOString(),
          notice_until: new Date(now + IDENTITY_NOTICE_HOURS * 3_600_000).toISOString(),
        };
      }
      return ok(view());
    }
    // Locking a sign-in (5.28, A50–A52), and turning on again one a restore
    // paused (A55), as the real vault answers them, to whoever asks by their
    // session. Refused in its order: who may (403), what was sent (422), the
    // owner power (A54) as the account card asks it, then the person.
    const lockAt = /^\/api\/v1\/members\/([^/]+)\/(lock|resume)$/.exec(path);
    if (lockAt && (init.method === 'POST' || (lockAt[2] === 'lock' && init.method === 'DELETE'))) {
      const s = session();
      if (!('id' in s)) return s;
      const me = whoOf(s);
      const resuming = lockAt[2] === 'resume';
      const locking = !resuming && init.method === 'POST';
      const capability = resuming ? 'restore.review' : 'member.suspend';
      if (!can(me.role, capability)) return fail(403, 'forbidden', refusalFor(capability));
      const asked = locking ? lockOf(body) : { until: null, note: null };
      if (typeof asked === 'string') return fail(422, 'validation_failed', asked);
      if (!state.ownerTwoStep) {
        return fail(
          403,
          'totp_required_for_owner',
          "Turn on two-step sign-in to manage other people's sign-ins.",
        );
      }
      const id = decodeURIComponent(lockAt[1] as string);
      const m = state.members.find((x) => x.id === id);
      const role = roleOfMember(id);
      if (!m || !role) return fail(404, 'not_found', 'They have no sign-in to lock.');
      const held = suspensionOf(id);
      if (resuming) {
        if (state.suspensions.get(id)?.reason !== 'restored') {
          return fail(
            409,
            'not_paused',
            `${m.display_name}'s sign-in is not waiting after a restore.`,
          );
        }
        state.suspensions.delete(id);
        return empty();
      }
      if (!locking) {
        // Never locked, past its end, or paused after a restore (resumed, not unlocked).
        if (held?.reason !== 'locked') {
          return fail(409, 'not_locked', `${m.display_name}'s sign-in is not locked.`);
        }
        state.suspensions.delete(id);
        return empty();
      }
      if (id === me.memberId) {
        return fail(422, 'validation_failed', 'You cannot lock your own sign-in.');
      }
      if (role === 'owner') {
        return fail(
          409,
          'owner_notice_required',
          `${m.display_name} is an owner, and one owner's sign-in is never locked by another. Ask for their role to be changed first — that takes seven days, and they are told about it.`,
        );
      }
      if (held?.reason === 'locked') {
        return fail(
          409,
          'already_locked',
          `${m.display_name}'s sign-in is locked already. Unlock it first to lock it differently.`,
        );
      }
      const now = Date.now();
      if (asked.until !== null && Date.parse(asked.until) <= now) {
        return fail(422, 'validation_failed', 'Choose a time in the future to unlock.');
      }
      if (asked.until !== null && Date.parse(asked.until) > now + LOCK_MAX_DAYS * 86_400_000) {
        return fail(
          422,
          'validation_failed',
          'A lock can end by itself within a year at most. Leave the end out to keep it until you unlock it.',
        );
      }
      // Somebody paused after a restore may be locked: the lock takes the pause's place.
      const suspension: MemberSuspension = {
        reason: 'locked',
        since: new Date(now).toISOString(),
        until: asked.until,
        note: asked.note,
        by: state.members.find((x) => x.id === me.memberId)?.display_name ?? 'An owner',
      };
      state.suspensions.set(id, suspension);
      // Their sessions end, and say why. The fake keeps no links of anybody
      // but its own person, so `end_links` has nothing to end.
      for (const x of state.sessions) {
        if (x.revoked || whoOf(x).memberId !== id) continue;
        x.revoked = true;
        x.endedBecause = 'suspended';
      }
      // A wider audience for identity details still waiting is withdrawn:
      // they could neither be told nor mark anything Only me (5.26).
      effectiveAudience();
      state.identityPending = null;
      return ok({ member_id: id, suspension: { ...suspension } });
    }
    // A password reset an owner starts (5.29, D5), as the real vault answers
    // it: who may (403), what was sent (422), the owner power (A54) as the
    // account card asks it, then the person (404, 422, 409). Never a link
    // but in `handover`, shown this once.
    const resetAt = /^\/api\/v1\/members\/([^/]+)\/password-reset$/.exec(path);
    if (resetAt && init.method === 'POST') {
      const s = session();
      if (!('id' in s)) return s;
      const me = whoOf(s);
      if (!can(me.role, 'member.reset_password')) {
        return fail(403, 'forbidden', refusalFor('member.reset_password'));
      }
      const b = body ?? {};
      if (
        Object.keys(b).some((k) => k !== 'stop_now') ||
        (b.stop_now !== undefined && typeof b.stop_now !== 'boolean')
      ) {
        return fail(422, 'validation_failed', 'Please check the form.');
      }
      if (!state.ownerTwoStep) {
        return fail(
          403,
          'totp_required_for_owner',
          "Turn on two-step sign-in to manage other people's sign-ins.",
        );
      }
      const id = decodeURIComponent(resetAt[1] as string);
      const m = state.members.find((x) => x.id === id);
      const role = roleOfMember(id);
      if (!m || !role) return fail(404, 'not_found', 'They have no sign-in to reset.');
      if (id === me.memberId) {
        return fail(
          422,
          'validation_failed',
          'You cannot reset your own password here. Change it in Settings, or use “Forgotten your password?” on the sign-in page.',
        );
      }
      if (role === 'owner') {
        return fail(
          409,
          'owner_notice_required',
          `${m.display_name} is an owner, and one owner's password is never reset by another. Ask for their role to be changed first — that takes seven days, and they are told about it.`,
        );
      }
      const held = suspensionOf(id);
      if (held) {
        return fail(
          409,
          'locked',
          held.reason === 'restored'
            ? `${m.display_name}'s sign-in is waiting after a restore. Turn it back on first, then reset their password.`
            : `${m.display_name}'s sign-in is locked. Unlock it first, then reset their password.`,
        );
      }
      const how = resetPathOf(id) as ResetPath;
      const stopNow = b.stop_now === true;
      // No link can reach them on the operator's path: no stop either (5.29 review).
      if (stopNow && how === 'operator') {
        return fail(
          409,
          'stop_now_unavailable',
          `${m.display_name}'s password can't be stopped from here: no link to set a new one can reach them on this vault. Lock their sign-in to keep them out, and ask whoever runs the server for a reset.`,
        );
      }
      if (stopNow) {
        // Their password stops now (A48): nobody is given one.
        const theirs = state.signIns.find((x) => x.member_id === id);
        if (theirs) theirs.password = '';
        for (const x of state.sessions) {
          if (x.revoked || whoOf(x).memberId !== id) continue;
          x.revoked = true;
          x.endedBecause = 'revoked';
        }
      }
      const by = state.members.find((x) => x.id === me.memberId)?.display_name ?? null;
      const now = Date.now();
      if (how === 'handover') {
        state.resetNotices.set(id, { by, at: new Date(now).toISOString() });
      }
      state.resetsStarted.push({ member_id: id, path: how, stop_now: stopNow });
      const theirEmail =
        state.signIns.find((x) => x.member_id === id)?.email ?? `${id}@example.test`;
      return ok({
        member_id: id,
        path: how,
        stop_now: stopNow,
        ...(how !== 'operator'
          ? { expires_at: new Date(now + RESET_LINK_MINUTES * 60_000).toISOString() }
          : {}),
        ...(how === 'handover'
          ? { link: `http://vault.test/reset#${'h'.repeat(40)}${String(++n).padStart(3, '0')}` }
          : {}),
        ...(how === 'operator' ? { command: resetCommand(theirEmail) } : {}),
      });
    }
    // Signing somebody out everywhere (5.30, A53), as the real vault answers
    // it: who may (403), the owner power (A54), then the person (404). Their
    // sessions end (`revoked`) — oneself, every one but the one asking — and
    // their sign-in stays as it is.
    const outAt = /^\/api\/v1\/members\/([^/]+)\/sessions$/.exec(path);
    if (outAt && init.method === 'DELETE') {
      const s = session();
      if (!('id' in s)) return s;
      const me = whoOf(s);
      if (!can(me.role, 'member.sign_out')) {
        return fail(403, 'forbidden', refusalFor('member.sign_out'));
      }
      if (!state.ownerTwoStep) {
        return fail(
          403,
          'totp_required_for_owner',
          "Turn on two-step sign-in to manage other people's sign-ins.",
        );
      }
      const id = decodeURIComponent(outAt[1] as string);
      if (!roleOfMember(id) || (id !== ME && !state.members.some((x) => x.id === id))) {
        return fail(404, 'not_found', 'They have no sign-in to sign out.');
      }
      let ended = 0;
      for (const x of state.sessions) {
        if (x.revoked || x.id === s.id || whoOf(x).memberId !== id) continue;
        x.revoked = true;
        x.endedBecause = 'revoked';
        ended += 1;
      }
      // Their devices go with their sessions.
      const card = id === me.memberId ? undefined : state.memberAccounts.get(id);
      if (card) card.devices = [];
      return ok({ member_id: id, sessions_ended: ended });
    }
    // After a restore (5.16): what it paused that the caller may decide
    // about, as the real vault lists it. The fake keeps no links; requests
    // to send documents (5.21) as the vault lists them; and the sign-ins it
    // paused (5.28), an owner's alone to turn back on.
    if (path === '/api/v1/after-restore' && init.method === 'GET') {
      const s = session();
      if (!('id' in s)) return s;
      const me = whoOf(s);
      const owner = can(me.role, 'restore.review');
      const signIns: PausedSignIn[] = owner
        ? withSignIn()
            .flatMap((id) => {
              const paused = state.suspensions.get(id);
              const role = roleOfMember(id);
              if (paused?.reason !== 'restored' || !role) return [];
              const name = state.members.find((x) => x.id === id)?.display_name ?? '';
              return [{ member_id: id, display_name: name, role, paused_at: paused.since }];
            })
            .sort((a, b) =>
              a.display_name !== b.display_name
                ? a.display_name < b.display_name
                  ? -1
                  : 1
                : a.member_id < b.member_id
                  ? -1
                  : 1,
            )
        : [];
      return ok({
        links: [],
        upload_requests: can(me.role, 'upload_request.create')
          ? state.uploadRequests.filter(
              (r) => r.state === 'paused' && r.paused_reason === 'restored' && (owner || r.mine),
            )
          : [],
        sign_ins: signIns,
      });
    }
    // What a viewer can see (5.33), as the real vault answers: who may (403),
    // what is sent (422), the owner power (A54), then whom (404, 409).
    // What a viewer can see (5.33), refused in the real vault's order (the
    // 5.33 review, L533-06). A PUT: anybody but an owner 403; a body of the
    // wrong shape 422; no two-step sign-in 403; nobody of the family 404;
    // anybody but a viewer 409 not_a_viewer; what the grant names 422;
    // somebody who keeps Only me documents 409 confirm_private.
    const accessAt = /^\/api\/v1\/members\/([^/]+)\/access(\/preview)?$/.exec(path);
    if (accessAt || path === '/api/v1/access/preview') {
      const s = session();
      if (!('id' in s)) return s;
      const me = whoOf(s);
      const id = accessAt ? decodeURIComponent(accessAt[1] as string) : null;
      const known = (x: string) => x === ME || state.members.some((m) => m.id === x);
      const nameOf = (x: string) => state.members.find((m) => m.id === x)?.display_name ?? 'They';
      const notAViewer = (x: string) => {
        const role = roleOfMember(x);
        return role && role !== 'viewer'
          ? fail(
              409,
              'not_a_viewer',
              `Only a viewer can be limited to some documents. ${nameOf(x)} is not a viewer.`,
            )
          : null;
      };
      if (!accessAt || accessAt[2] !== undefined) {
        if (init.method !== 'GET') return fail(404, 'not_found', 'Not here.');
        const flag = (k: string) => {
          const v = param(url, k);
          return v === 'true' ? true : v === 'false' ? false : undefined;
        };
        const shaped = grantShape({
          ...Object.fromEntries(
            ['people', 'types', 'collections'].map((k) => [
              k,
              (param(url, k) ?? '').split(',').filter(Boolean),
            ]),
          ),
          include_adults_only: param(url, 'include_adults_only') === 'true',
          include_no_person_docs: param(url, 'include_no_person_docs') === 'true',
          ...(param(url, 'expires_at') ? { expires_at: param(url, 'expires_at') } : {}),
          ...(flag('limits_people') !== undefined ? { limits_people: flag('limits_people') } : {}),
          ...(flag('limits_types') !== undefined ? { limits_types: flag('limits_types') } : {}),
        });
        if (isResponse(shaped)) return shaped;
        if (me.role !== 'owner') {
          if (!can(me.role, 'member.invite')) {
            return fail(403, 'forbidden', 'Only an owner can limit what someone can see.');
          }
          if (shaped.include_adults_only) {
            return fail(
              403,
              'forbidden',
              'Only an owner can let a viewer see Adults only documents.',
            );
          }
        }
        if (id !== null && !known(id))
          return fail(404, 'not_found', 'That person is not in the family.');
        const refused = id !== null ? notAViewer(id) : null;
        if (refused) return refused;
        const had = id !== null ? state.restrictions.get(id) : undefined;
        const asked = checkedGrant(shaped, had?.expires_at ?? null);
        if (isResponse(asked)) return asked;
        const counting: AccessGrant = {
          ...asked,
          limits_people: limitsAfter(asked.people, asked.limits_people, had?.limits_people),
          limits_types: limitsAfter(asked.types, asked.limits_types, had?.limits_types),
        };
        const inCollections = collectionDocuments(counting);
        const counted: AccessPreview = {
          documents: state.documents.filter(
            (d) =>
              !d.deleted_at &&
              (d.visibility ?? 'household') !== 'private' &&
              grantGives(id, counting, d, inCollections),
          ).length,
          // To an owner with two-step sign-in, as the real vault tells one
          // who just gave a passkey or a code.
          ...(id !== null && me.role === 'owner' && state.ownerTwoStep
            ? { keeps_private: state.keepsPrivate.includes(id) }
            : {}),
        };
        return ok(counted);
      }
      if (init.method !== 'PUT' && init.method !== 'DELETE') {
        return fail(404, 'not_found', 'Not here.');
      }
      if (!can(me.role, 'role.change')) return fail(403, 'forbidden', refusalFor('role.change'));
      const shaped = init.method === 'PUT' ? grantShape(body) : null;
      if (shaped && isResponse(shaped)) return shaped;
      if (!state.ownerTwoStep) {
        return fail(
          403,
          'totp_required_for_owner',
          'Turn on two-step sign-in to limit what a viewer can see.',
        );
      }
      const theirs = id as string;
      if (!known(theirs)) return fail(404, 'not_found', 'That person is not in the family.');
      if (init.method === 'DELETE') {
        // A guest is always limited (5.34).
        if (state.members.find((m) => m.id === theirs)?.kind === 'guest') {
          return fail(409, 'guest_always_limited', GUEST_ALWAYS_LIMITED);
        }
        state.restrictions.delete(theirs);
        return empty();
      }
      const refused = notAViewer(theirs);
      if (refused) return refused;
      const was = state.restrictions.get(theirs);
      const asked = checkedGrant(shaped as AccessGrant, was?.expires_at ?? null);
      if (isResponse(asked)) return asked;
      const keeps = state.keepsPrivate.includes(theirs);
      if (keeps && !was?.private_confirmed && body.confirm_private !== true) {
        return fail(
          409,
          'confirm_private',
          `${nameOf(theirs)} keeps documents only they can see. Limited, they still see those, and nothing else of the family’s that you do not give them. Confirm to go ahead: they will be told.`,
        );
      }
      state.restrictions.set(theirs, {
        ...asked,
        // An empty list keeps what it says now, unless the owner says otherwise.
        limits_people: limitsAfter(asked.people, asked.limits_people, was?.limits_people),
        limits_types: limitsAfter(asked.types, asked.limits_types, was?.limits_types),
        reconfirm_since: null,
        private_confirmed: keeps || (was?.private_confirmed ?? false),
        updated_at: new Date().toISOString(),
      });
      return ok(accessView(theirs));
    }
    const identityAt = /^\/api\/v1\/members\/([^/]+)\/identity(\/reveal)?$/.exec(path);
    if (identityAt) {
      const s = session();
      if (!('id' in s)) return s;
      const id = decodeURIComponent(identityAt[1] as string);
      const me = { role: state.role, memberId: 'fake-member' };
      const self = id === me.memberId;
      if (!state.members.some((m) => m.id === id)) {
        return fail(404, 'not_found', 'That page does not exist.');
      }
      const audience = effectiveAudience();
      if (!canSeeIdentity(me, { id }, audience)) {
        return fail(404, 'not_found', 'That page does not exist.');
      }
      const record = state.identities.get(id) ?? {};
      state.identities.set(id, record);
      const partView = (part: IdentityPart): IdentityPartView => {
        const kept = record[part];
        const masked = maskIdentity(kept?.fields ?? {});
        return {
          fields: masked.fields,
          masked: masked.masked,
          filled: identityFilled(kept?.fields ?? {}),
          version: kept?.version ?? 0,
          updated_at: kept?.updated_at ?? null,
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
      if (identityAt[2] !== undefined) {
        if (init.method !== 'POST') return fail(404, 'not_found', 'Not here.');
        const b = body as { part?: IdentityPart; keys?: string[] };
        const part = b.part ?? 'shared';
        if (part === 'only_me' && !self) return fail(404, 'not_found', 'That page does not exist.');
        // Somebody else's numbers take a passkey or a code, whoever asks.
        if (!self && !state.ownerTwoStep) {
          return needsTwoStep("to see another person's identity numbers");
        }
        return ok({ part, values: revealIdentity(record[part]?.fields ?? {}, b.keys ?? []) });
      }
      if (init.method === 'GET') return ok(view());
      if (init.method !== 'PUT') return fail(404, 'not_found', 'Not here.');
      const b = body as { part?: IdentityPart; version?: number; fields?: IdentityFields };
      const part = b.part;
      if (part !== 'shared' && part !== 'only_me') {
        return fail(422, 'validation_failed', 'Say which part.');
      }
      if (part === 'only_me' && !self) return fail(404, 'not_found', 'That page does not exist.');
      if (!canEditIdentity(me, { id }, part)) return fail(403, 'forbidden', IDENTITY_EDIT_REFUSAL);
      const kept = record[part];
      const version = kept?.version ?? 0;
      if (b.version !== version) {
        return fail(
          409,
          'conflict',
          'Someone else changed these details. Reload and try again.',
          JSON.stringify({ part, version }),
        );
      }
      const next = mergeIdentityWrite(kept?.fields ?? {}, b.fields ?? {}, () => true);
      if (identityChanges(kept?.fields ?? {}, next).length > 0) {
        if (identityTooLong(next)) return fail(422, 'validation_failed', IDENTITY_TOO_LONG);
        record[part] = { fields: next, version: version + 1, updated_at: new Date().toISOString() };
      }
      return ok(view());
    }
    const memberAt = /^\/api\/v1\/members\/([^/]+)(\/account)?$/.exec(path);
    if (memberAt) {
      const s = session();
      if (!('id' in s)) return s;
      const m = state.members.find((x) => x.id === decodeURIComponent(memberAt[1] as string));
      if (memberAt[2] !== undefined) {
        if (init.method !== 'GET' || whoOf(s).role !== 'owner') {
          return fail(404, 'not_found', 'That page does not exist.');
        }
        if (!state.ownerTwoStep) {
          return fail(
            403,
            'totp_required_for_owner',
            "Turn on two-step sign-in to manage other people's sign-ins.",
          );
        }
        // The card a test gave them, or one for somebody in `signIns` (5.28).
        const theirs = m ? state.signIns.find((x) => x.member_id === m.id) : undefined;
        const card =
          (m ? state.memberAccounts.get(m.id) : undefined) ??
          (m && theirs
            ? {
                member_id: m.id,
                role: m.role as Role,
                email: theirs.email,
                two_step: false,
                passkeys: 0,
                last_signed_in_at: null,
                devices: [],
                // Of the family, or a guest, and a guest's end (5.34).
                kind: m.kind ?? 'family',
                access_expires_at: m.access_expires_at ?? null,
              }
            : undefined);
        if (!card || !m) return fail(404, 'not_found', 'They have no sign-in to show.');
        // A lock, or a pause after a restore (5.28): one past its end is over.
        return ok({
          ...card,
          suspension: suspensionOf(m.id),
          max_offline_days: FAKE_OFFLINE_MAX_DAYS,
          // Which way a reset an owner starts would go (5.29).
          reset_path: resetPathOf(m.id),
          // A viewer's limits (5.33).
          access: card.role === 'viewer' ? accessView(m.id) : null,
        });
      }
      // A guest who never signed in, removed by an owner (the 5.34 review).
      if (init.method === 'DELETE') {
        if (whoOf(s).role !== 'owner') return fail(403, 'forbidden', refusalFor('member.remove'));
        if (!m) return fail(404, 'not_found', 'That person is not here.');
        if (m.kind !== 'guest') {
          return fail(409, 'not_a_guest', `${m.display_name} is of the family, and stays in it.`);
        }
        const accepted = state.invitations.some(
          (i) => i.view.member_id === m.id && i.view.state === 'accepted',
        );
        if (m.role || accepted) {
          return fail(
            409,
            'had_sign_in',
            `${m.display_name} has had a sign-in here. Take it away instead; an owner can give it back.`,
          );
        }
        state.members = state.members.filter((x) => x.id !== m.id);
        state.invitations = state.invitations.filter((i) => i.view.member_id !== m.id);
        state.restrictions.delete(m.id);
        return empty();
      }
      if (init.method !== 'PATCH') return fail(404, 'not_found', 'Not here.');
      if (!m) return fail(404, 'not_found', 'That person is not in the family.');
      if (state.role === 'viewer') return fail(403, 'forbidden', refusalFor('member.edit'));
      const b = body as {
        display_name?: string;
        date_of_birth?: string | null;
        relationship?: string | null;
        is_deceased?: boolean;
      };
      const passing = b.is_deceased !== undefined && b.is_deceased !== (m.is_deceased ?? false);
      if (passing && state.role !== 'owner') return fail(403, 'forbidden', DECEASED_REFUSAL);
      const version = m.version ?? 1;
      const ifMatch = init.headers['if-match'];
      if (ifMatch !== undefined && ifMatch !== `"${version}"`) {
        return fail(
          409,
          'conflict',
          'Someone else changed these details. Reload and try again.',
          JSON.stringify(memberAnswer(m)),
        );
      }
      if (passing && b.is_deceased === true && m.role) {
        return fail(409, 'signed_in', DECEASED_SIGNED_IN(m.display_name));
      }
      const next = {
        display_name: b.display_name?.trim() ?? m.display_name,
        date_of_birth: b.date_of_birth !== undefined ? b.date_of_birth : (m.date_of_birth ?? null),
        relationship:
          b.relationship !== undefined ? b.relationship?.trim() || null : (m.relationship ?? null),
        is_deceased: b.is_deceased ?? m.is_deceased ?? false,
      };
      const moved =
        next.display_name !== m.display_name ||
        next.date_of_birth !== (m.date_of_birth ?? null) ||
        next.relationship !== (m.relationship ?? null) ||
        next.is_deceased !== (m.is_deceased ?? false);
      if (moved) Object.assign(m, next, { version: version + 1 });
      return respond(200, memberAnswer(m), { etag: `"${m.version ?? 1}"` });
    }
    if (path === '/api/v1/reminders' && init.method === 'GET') {
      const s = session();
      if (!('id' in s)) return s;
      return ok({ items: state.reminders });
    }
    return fail(404, 'not_found', `The fake vault has no ${init.method} ${path}.`);
  };

  return { fetch, state, pauseSignIns };
}

/**
 * A moment as the real vault takes one for a lock's end: ISO, with its
 * seconds and its offset (5.28; zod's datetime({ offset: true })). One
 * without seconds is refused there, and so here (the 5.28 review, R528-5).
 */
const ISO_MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * POST /members/{id}/lock's body as the real vault reads it (5.28): nothing
 * it does not know; an end at a moment with its offset, or none; a note
 * trimmed, 500 characters at most, and an empty one none. What is wrong,
 * in words; or what was asked, the end as the vault writes it.
 */
function lockOf(
  body: Record<string, unknown>,
): string | { until: string | null; note: string | null } {
  const { until, end_links: endLinks, note } = body;
  if (
    until !== undefined &&
    until !== null &&
    (typeof until !== 'string' || !ISO_MOMENT.test(until) || Number.isNaN(Date.parse(until)))
  ) {
    return 'Invalid ISO datetime';
  }
  if (endLinks !== undefined && typeof endLinks !== 'boolean') {
    return 'Invalid input: expected boolean';
  }
  if (note !== undefined && note !== null && typeof note !== 'string') {
    return 'Invalid input: expected string';
  }
  const words = typeof note === 'string' ? note.trim() : '';
  if (words.length > LOCK_NOTE_MAX) return `A note can be ${LOCK_NOTE_MAX} characters at most.`;
  const unknown = Object.keys(body).find((k) => !['until', 'end_links', 'note'].includes(k));
  if (unknown !== undefined) return `Unrecognized key: "${unknown}"`;
  return {
    until: typeof until === 'string' ? new Date(until).toISOString() : null,
    note: words || null,
  };
}

/** A change to a kind's fields, as POST and PATCH /document-types send it (0.5.10). */
interface TypeChange {
  core?: Partial<Record<CoreField, Partial<CoreFieldRule>>> | undefined;
  fields?: Array<{ key: string; label?: string; required?: boolean }> | undefined;
}

/** A household's own key, as the real vault makes one: 'h_' and ten base32 characters. */
function ownKey(): string {
  const base32 = 'abcdefghijklmnopqrstuvwxyz234567';
  let key = 'h_';
  for (let i = 0; i < 10; i++) key += base32[Math.floor(Math.random() * 32)];
  return key;
}

/** Lead times as the real vault keeps them: each once, furthest first. */
function leadsOf(leads: number[]): number[] {
  return [...new Set(leads)].sort((a, b) => b - a);
}

/**
 * The first name, of those sent, longer than the real vault keeps one
 * (TYPE_LABEL_MAX, once tidied), refused in its words; or null.
 */
function tooLong(names: ReadonlyArray<readonly [unknown, string]>): ResponseLike | null {
  for (const [value, what] of names) {
    if (typeof value === 'string' && (tidy(value)?.length ?? 0) > TYPE_LABEL_MAX) {
      return fail(
        422,
        'validation_failed',
        `${what} is too long: ${TYPE_LABEL_MAX} characters at most.`,
      );
    }
  }
  return null;
}

/** An issuer as the real vault keeps it: spaces tidied, and blank is nothing. */
function tidy(value: string | null | undefined): string | null {
  return value?.trim().split(/\s+/).join(' ') || null;
}

/** Notes as the real vault keeps them: trimmed, and blank is nothing. */
function note(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

/** Tags as the real vault keeps them: trimmed, lower case, each once, fifty at most. */
function tagsOf(tags: ReadonlyArray<string> | null | undefined): string[] {
  return [...new Set((tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 50);
}

/** One query parameter, decoded; the client's library has no URLSearchParams. */
function param(url: string, name: string): string | undefined {
  const raw = new RegExp(`[?&]${name}=([^&]*)`).exec(url)?.[1];
  return raw === undefined ? undefined : decodeURIComponent(raw.split('+').join(' '));
}

/** A capture's answer, or a new version's: the shape each endpoint returns. */
function answer(made: FakeUpload) {
  return made.kind === 'capture'
    ? { document_id: made.document_id, version_id: made.version_id, job_id: null, state: 'stored' }
    : { id: made.version_id, document_id: made.document_id };
}

/**
 * A document as the real vault answers it: the fields the fake keeps, its
 * notes and details, and its status — worked out as the vault works it
 * out, so a type's missing required field reads "Needs a passport number"
 * (0.5.7). In a list, an Only me document's notes and details stay sealed:
 * null and empty, with `has_notes` (0.5.8).
 */
function documentView(
  doc: FakeDocument,
  types: ReadonlyArray<DocumentTypeView>,
  opts: { listed?: boolean; role?: string } = {},
): DocumentView {
  const type = types.find((t) => t.key === doc.type_key);
  const expires = doc.expires ?? null;
  const sealed = opts.listed === true && doc.visibility === 'private';
  return {
    id: doc.id,
    title: doc.title,
    type_key: doc.type_key ?? null,
    owner_member_id: doc.owner_member_id ?? null,
    identifier: doc.identifier ?? null,
    issued_by: doc.issued_by ?? null,
    issued: doc.issued ?? null,
    expires,
    physical_location: doc.physical_location ?? null,
    tags: doc.tags ?? [],
    visibility: doc.visibility ?? 'household',
    notes: sealed ? null : (doc.notes ?? null),
    has_notes: (doc.notes ?? null) !== null,
    extra: sealed ? {} : (doc.extra ?? {}),
    // The fake's one signed-in person files every document it holds, unless
    // a test says somebody else did (5.24).
    filed_by_me: doc.filedBySomeoneElse !== true,
    deleted_at: doc.deleted_at ?? null,
    // As the real vault (5.24): an owner's request, and from when it may go.
    purge_requested_at: doc.purge_requested_at ?? null,
    purge_allowed_from: doc.purge_requested_at
      ? new Date(Date.parse(doc.purge_requested_at) + PURGE_NOTICE_HOURS * 3_600_000).toISOString()
      : null,
    // Whether an owner may remove it at once: one they filed (5.24).
    purge_at_once:
      Boolean(doc.deleted_at) && opts.role === 'owner' && doc.filedBySomeoneElse !== true,
    file_removed: false,
    etag: etagOf(doc),
    status: deriveStatus(
      {
        type: type ?? null,
        owner_member_id: doc.owner_member_id ?? null,
        expires,
        missing: missingFields(type, { ...doc, expires }),
      },
      new Date().toISOString().slice(0, 10),
    ),
  } as DocumentView;
}

/** A person as GET /members answers one: their photo's three fields always said (0.5.19). */
function memberAnswer(m: FakeVaultState['members'][number]) {
  return {
    ...m,
    // Of the family, or a guest, and a guest's end (5.34).
    kind: m.kind ?? 'family',
    access_expires_at: m.access_expires_at ?? null,
    date_of_birth: m.date_of_birth ?? null,
    relationship: m.relationship ?? null,
    is_deceased: m.is_deceased ?? false,
    photo: m.photo ?? null,
    photo_status: m.photo_status ?? null,
    can_change_photo: m.can_change_photo ?? m.role !== 'viewer',
    // Their details (5.25): a version, and whether they may be changed.
    version: m.version ?? 1,
    can_edit: m.can_edit ?? m.role !== 'viewer',
  };
}

/** A refusal the fake has already made, rather than a value to use. */
const isResponse = (v: unknown): v is ResponseLike =>
  typeof v === 'object' && v !== null && 'status' in v && 'ok' in v && 'json' in v;

function respond(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): ResponseLike {
  const text = body === undefined ? '' : JSON.stringify(body);
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status < 400,
    status,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    json: async () => JSON.parse(text) as unknown,
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer,
  };
}

const ok = (body: unknown, status = 200) => respond(status, body);
/** A JPEG's first and last markers: enough to be one, for a client under test. */
const FAKE_PAGE = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]);
function picture(bytes: Uint8Array): ResponseLike {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name) =>
        ({ 'content-type': 'image/jpeg', 'cache-control': 'private, no-store' })[
          name.toLowerCase()
        ] ?? null,
    },
    json: async () => {
      throw new SyntaxError('A picture is not JSON.');
    },
    text: async () => String.fromCharCode(...bytes),
    arrayBuffer: async () => bytes.slice().buffer,
  };
}
/** A file as an attachment, with the headers given (0.5.23's copy of a file sent in). */
function attachment(bytes: Uint8Array, headers: Record<string, string>): ResponseLike {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    json: async () => {
      throw new SyntaxError('A file is not JSON.');
    },
    text: async () => new TextDecoder().decode(bytes),
    arrayBuffer: async () => bytes.slice().buffer,
  };
}
const empty = () => respond(204, undefined);
const fail = (status: number, code: string, message: string, detail?: string) =>
  respond(status, {
    error: {
      code,
      message,
      ...(detail !== undefined ? { detail } : {}),
      retriable: false,
      request_id: 'fake',
    },
  });
/**
 * A session that has ended, and why, as the real vault says it (0.4.11):
 * since 5.28 `suspended`, its person's sign-in locked or paused.
 */
const ended = (
  reason: 'expired' | 'revoked' | 'reused' | 'removed' | 'malformed' | 'suspended' | 'access_ended',
) =>
  respond(401, {
    error: {
      code: 'session_ended',
      message: 'Please sign in again.',
      reason,
      retriable: false,
      request_id: 'fake',
    },
  });
/**
 * A sign-in refused for a lock or a pause after a restore (5.28), as the
 * real vault says it once the password is right: to the person, so until
 * when, on the household's clock.
 */
const membershipSuspended = (s: MemberSuspension, timezone: string) =>
  respond(403, {
    error: {
      code: 'membership_suspended',
      message:
        s.reason === 'restored'
          ? 'The vault was restored from a backup, and your sign-in waits for an owner to turn it back on. Ask one of them.'
          : s.until
            ? `An owner has locked your sign-in until ${shareEndWords(new Date(s.until), timezone)} (${timezone}). Ask one of them if you need to get in sooner.`
            : 'An owner has locked your sign-in. Ask one of them if you need to get in.',
      retriable: false,
      request_id: 'fake',
      reason: s.reason,
    },
  });
