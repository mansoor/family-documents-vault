import {
  APP_ACTS_AS_DEFAULT,
  APP_AUTH_FAILURES_PER_MINUTE,
  APP_BASIC_DEPRECATION,
  APP_CLIENT_ID_PATTERN,
  APP_CONNECTION_PREFIX,
  APP_GRANTABLE_CATEGORIES,
  APP_HINTS,
  APP_KEY_DAYS_MAX,
  APP_KEY_DEFAULT_DAYS,
  APP_KEY_NAME_MAX,
  APP_KEYS_MAX,
  APP_LINK_COOKIE,
  APP_LINK_OPEN_SECONDS,
  APP_LINK_PAGE,
  APP_LINK_SESSION_MINUTES,
  APP_LINK_SESSION_PATH,
  APP_SCOPES_DEFAULT,
  APP_SCOPES_OFFERED,
  APP_SECRET_PATTERN,
  APP_TOKEN_PATTERN,
  APP_TOKEN_SECONDS,
  APP_TOKENS_PER_KEY_PER_MINUTE,
  APP_REFUSALS,
  appInboxOf,
  appMayDownloadSent,
  appMayRead,
  appSensitiveConfirmWords,
  canShareToView,
  deriveStatus,
  localToday,
  parseAppMetadata,
  type AppChange,
  type AppDocument,
  type AppHints,
  type AppIntakeState,
  type AppKeyState,
  type AppKeyView,
  type AppMe,
  type AppScope,
  type ConnectedAppGrantView,
  type ConnectedAppKeyMade,
  type ConnectedAppView,
  type DateValue,
  type Role,
} from '@fdv/shared';
import { fromBase64, toBase64 } from '../apps.js';
import type { FetchLike, ResponseLike } from '../http.js';

/**
 * Connected apps in the fake vault (0.9.0, APP1): Settings → Connected apps
 * for whoever signs in, and the app routes — an API key checked as the
 * vault checks it (APP6), in the contract's order: the Basic header, the
 * failed tries of the minute, the client ID and secret, the app removed,
 * the key revoked or expired, the app's state, and the route's scope among
 * the key's permissions and the app's. What an app sends is kept on the app
 * alone, by its external id: no Inbox. Addresses, https and caps are the
 * real vault's to test.
 *
 * Reading (APP2): the fake's documents, by the vault's own rule
 * (`appMayRead`), through its grants; a feed kept as the vault keeps it —
 * what each app was told of each document, and a line each time that
 * changes — and downloads of the file's bytes.
 *
 * Links and deletes (APP3): a link minted for a document the app may read,
 * opened once within two minutes for a session of ten (its cookie on the
 * session's path alone), the rule asked again at each request; a view's
 * one page is a few bytes, as the fake draws nothing. Addresses are the
 * real vault's to test. A delete of its own document: let go of, or moved
 * to the Trash, as the owner chose.
 *
 * Filing automatically (APP4): an owner's switch, and its backfill's for
 * the window alone. The fake reads no pages: a test says what a file's
 * pages read (`readAppFile` on the fake vault), and the fake files it by
 * the vault's own rule (`appFilesItself`), or leaves it waiting.
 *
 * Its own sends again, and whose Inbox (APP5): the exact file a send became,
 * by its external id, by the vault's own rule (`appMayDownloadSent`); and
 * each send's Inbox worked out by the vault's own rule (`appInboxOf`) and
 * kept on the send (`inbox_member_id`) — never told to the app. A send to
 * the person it is about is filed automatically as them.
 *
 * API keys (APP6), by the vault's rules: an owner generates one in
 * Settings, after a passkey or a code (`ownerTwoStep`), with its own
 * permissions (some of the app's scopes) and how long it lasts (1 to 3650
 * days, or never); its secret is answered once and kept only as a SHA-256.
 * Two live at most (`409 key_limit`); an owner revokes one, and its next
 * request is `401 app_key_revoked`. A key for an app acting as somebody
 * else sends it back to them to turn on again. Never made, renewed or
 * retired by the app itself. A test expires a key with `fakeExpireAppKey`
 * (the fake vault's `expireAppKey`). Each check is made in the order the
 * vault's routes make it.
 *
 * Access tokens (0.9.0-dev.72), by the vault's rules: the key, as Basic, is
 * traded at `POST /apps/token` (`grant_type=client_credentials`, a form)
 * for a token kept on its key as a SHA-256 alone, fifteen minutes long;
 * every other app route takes `Bearer` with one, and ends it with its key
 * or its app. Basic there is still taken, with a `Deprecation` header. A
 * test ends every token with `fakeExpireAppTokens` (the fake vault's
 * `expireAppTokens`).
 *
 * Acting as itself (APP8), by the vault's rules: an app connected without a
 * person acts as itself, on at once, its papers that nothing routes going
 * to its reviewer's Inbox (by default the owner connecting it); a reviewer
 * who cannot take one now (`receives` false) refuses it `503 busy`, and
 * the owners are told once (an activity line). The activity log names the
 * app alone. One acting as a person is as before.
 */

/** A document of the fake's, as an app's reading needs it. */
export interface FakeReadableDoc {
  id: string;
  title: string | null;
  type_key: string | null;
  visibility: string;
  sensitive: boolean | null;
  is_essential: boolean;
  deleted: boolean;
  issued: DateValue | null;
  expires: DateValue | null;
  issued_by: string | null;
  extra: Record<string, unknown>;
  /** The day it was filed, YYYY-MM-DD. */
  filed_on: string;
  owner_member_id: string | null;
  household_owned: boolean;
  /** When it last changed, as far as the fake knows. */
  updated_at: string;
  version: { id: string; bytes: Uint8Array; mime: string; filename: string } | null;
}

/** An API key (APP6): its secret is never kept, only its SHA-256 (hex). */
export interface FakeAppKey {
  id: string;
  client_id: string;
  secret_sha256: string;
  name: string | null;
  permissions: AppScope[];
  created_at: string;
  /** null: it never expires. */
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  /** Why: an owner revoked it, or its app was removed (the vault's restore revokes every key too). */
  revoked_reason?: 'owner' | 'app_removed' | 'restore' | 'creator' | null;
  /** Its access tokens (0.9.0-dev.72): each one's SHA-256 (hex) and when it ends, never the token. */
  tokens?: Array<{ sha256: string; expires_at: number }>;
  /** Tokens it was given this minute. */
  minted?: { minute: number; n: number };
}

export interface FakeIntake {
  /** `filed` only as a test files it (`fileAppIntake`): the fake has no Inbox. */
  state: 'waiting' | 'filed' | 'refused' | 'removed';
  /** Filed: the document and the version it became. */
  document_id?: string | null;
  version_id?: string | null;
  filed_at?: string | null;
  /** Filed as a document of its own, not into one that was there: only such is the app's own. */
  made_document?: boolean;
  removed_reason: 'withdrawn' | 'declined' | 'expired' | null;
  refusal: 'kind_not_allowed' | null;
  sha256: string | null;
  byte_size: number | null;
  received_at: string | null;
  /** Let go of by the app (APP3): no longer its own. */
  unlinked?: boolean;
  /** What it said of the file, and the file, while it waits (APP4: the fake files it so). */
  hints?: AppHints;
  file?: { bytes: Uint8Array; filename: string; mime: string };
  /** Taken back by an Undo once filed (APP4): never filed automatically again. */
  auto_file_held?: boolean;
  /** Whose Inbox it went to (APP5): the app's person's, or the person it is about. */
  inbox_member_id?: string;
  /** Sent as the app itself (APP8): a file of it filed names the app, whatever it acts as by then. */
  as_itself?: boolean;
}

/** A link an app minted (APP3), and its session once opened. */
export interface FakeAppLink {
  token: string;
  /** The API key it was minted with (APP6): revoked or expired, the link ends. */
  key_id?: string;
  document_id: string;
  version_id: string;
  mode: 'view' | 'download';
  created_at: number;
  open_by: number;
  opened_at: number | null;
  cookie: string | null;
  session_until: number | null;
}

export interface FakeApp {
  id: string;
  name: string;
  /** Whom it acts as (APP8): itself, or `member_id`. Absent: a person, as an app from before. */
  acts_as?: 'app' | 'person';
  /** The person it acts as; null when it acts as itself. */
  member_id: string | null;
  /** Who reviews what nothing routes, when it acts as itself (APP8). */
  reviewer_member_id?: string | null;
  /** The owners were told it needs another reviewer (APP8): once, until one takes a send. */
  reviewer_told?: boolean;
  approval: 'waiting' | 'approved';
  paused: 'owner' | 'restored' | null;
  revoked: boolean;
  allowed_kinds: string[];
  default_visibility: ConnectedAppView['default_visibility'];
  daily_files: number;
  daily_bytes: number;
  keys: FakeAppKey[];
  created_at: string;
  intake: Map<string, FakeIntake>;
  files_today: number;
  bytes_today: number;
  last_used_at: string | null;
  /** What it may do (APP2). */
  scopes?: AppScope[];
  /** What it may read beyond its own (APP2). */
  grants?: ConnectedAppGrantView[];
  /** What it was last told of each document, and its feed (APP2). */
  seen?: Map<string, { fingerprint: string; available: boolean }>;
  feed?: Array<{ seq: number; id: string; change: 'changed' | 'unavailable'; at: string }>;
  /**
   * Its feed's lines up to this one are gone, as the vault lets them go
   * after 90 days: a test sets it to see `410 cursor_expired`.
   */
  feed_pruned_to?: number;
  /** Bytes a day it may download, and what it downloaded today: a test lowers it to see 429 and 413. */
  daily_read_bytes?: number;
  read_bytes_today?: number;
  /** What a delete does, and the links it may mint an hour (APP3). */
  delete_mode?: 'unlink' | 'trash';
  links_per_hour?: number;
  links?: FakeAppLink[];
  /** Filed automatically when sure and complete (APP4), and a backfill's window (with its own switch). */
  auto_file?: boolean;
  backfill?: {
    until: string;
    files_per_day: number;
    bytes_per_day: number;
    auto_file: boolean;
  } | null;
  /**
   * Each paper to the Inbox of the person it is about (APP5): on for an app
   * connected through the routes; one a test makes without it is an app
   * from before, which keeps its person's Inbox.
   */
  route_to_person?: boolean;
}

/** A backfill's window, while it lasts. */
const liveBackfill = (a: FakeApp, now = Date.now()) =>
  a.backfill && Date.parse(a.backfill.until) > now ? a.backfill : null;

/**
 * Whether an app files what it sends automatically now (APP4): on, turned
 * on, not paused or removed, sending, and its switch on — or its backfill's.
 */
export function fakeAppFilesAutomatically(a: FakeApp, now = Date.now()): boolean {
  if (a.revoked || a.paused || a.approval !== 'approved') return false;
  if (!(a.scopes ?? APP_SCOPES_DEFAULT).includes('documents.send')) return false;
  return a.auto_file === true || liveBackfill(a, now)?.auto_file === true;
}

export interface FakeAppDeps {
  apps: FakeApp[];
  /** The caller signed in, or the refusal to answer. */
  session: () => { memberId: string; role: Role } | ResponseLike;
  memberName: (id: string) => string;
  ownerTwoStep: () => boolean;
  /** Whether an adult signed in has a passkey or a code (CL2): yes unless a test says not. */
  memberTwoStep?: () => boolean;
  /** Whom an app may act as: an owner or an adult with a sign-in. */
  mayAct: (memberId: string) => boolean;
  kinds: () => Array<{
    key: string;
    label: string;
    category: string;
    fields: Array<{ key: string }>;
    expiry_driver: string | null;
    reminder_leads?: number[];
    usually_essential?: boolean;
    sensitive_default?: boolean;
    belongs_to?: 'person' | 'household' | null;
  }>;
  /** The family an app's person may file for, never a guest (APP5): a name hint is matched to them. */
  people?: () => Array<{ id: string; name: string }>;
  /** Whether a send may go to this person's Inbox (APP5): an owner or an adult who signs in and may act. */
  receives?: (memberId: string) => boolean;
  /** A version of the fake's, any one, by its id (APP5): what a send became. */
  versionOf?: (versionId: string) => {
    document_id: string;
    bytes: Uint8Array;
    mime: string;
    filename: string;
  } | null;
  /** The fake's documents, as an app's reading needs them (APP2). */
  documents?: () => FakeReadableDoc[];
  /** A document moved to the Trash by an app's delete (APP3). */
  trash?: (id: string) => void;
  /**
   * A line in the fake's activity log (APP8): what an app did, and the
   * owners told it needs a reviewer. `object` is the member a line is about.
   */
  log?: (line: {
    action: string;
    actorMemberId: string | null;
    object: string | null;
    detail: Record<string, unknown>;
  }) => void;
  ok: (body: unknown, status?: number, headers?: Record<string, string>) => ResponseLike;
  /** Bytes as they are, for a download (APP2). */
  raw: (status: number, bytes: Uint8Array, headers: Record<string, string>) => ResponseLike;
  fail: (status: number, code: string, message: string, detail?: string) => ResponseLike;
  empty: () => ResponseLike;
  next: (what: string) => string;
  timezone: () => string;
}

const APP_ROUTE =
  /^\/api\/v1\/apps\/(token|me|intake|intake\/[^/]+|intake\/[^/]+\/content|documents|documents\/[^/]+|documents\/[^/]+\/content|documents\/[^/]+\/links|changes)$/;

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const own = new Uint8Array(bytes.length);
  own.set(bytes);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', own));
}
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** A key's state now: revoked, past its expiry, or live. */
function keyState(k: FakeAppKey, now = Date.now()): AppKeyState {
  if (k.revoked_at !== null) return 'revoked';
  if (k.expires_at !== null && Date.parse(k.expires_at) <= now) return 'expired';
  return 'live';
}

/** An app's live keys: not revoked, not expired. */
function liveKeys(a: FakeApp, now = Date.now()): FakeAppKey[] {
  return a.keys.filter((k) => keyState(k, now) === 'live');
}

/** A key as Settings lists it: never its secret, nor its hash. */
function keyView(k: FakeAppKey): AppKeyView {
  return {
    id: k.id,
    client_id: k.client_id,
    name: k.name,
    permissions: [...k.permissions],
    created_at: k.created_at,
    expires_at: k.expires_at,
    last_used_at: k.last_used_at,
    revoked_at: k.revoked_at,
    revoked_reason: k.revoked_at === null ? null : (k.revoked_reason ?? 'owner'),
    state: keyState(k),
  };
}

/** `n` random bytes, base64url. */
const randomText = (n: number) => toBase64(crypto.getRandomValues(new Uint8Array(n)), true);

/** Two hex strings compared without stopping at the first difference. */
function sameHex(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * A Basic header's value, decoded: its user part and the rest; null for no
 * Basic at all. An app's key is one whose user part is a client ID
 * (`fdvc_…`); any other Basic value is somebody else's — a proxy's in
 * front of the vault — and goes on untouched, as the vault lets it.
 */
function basicOf(header: string | undefined): { user: string; rest: string | null } | null {
  const m = /^basic +([A-Za-z0-9+/]+={0,2})$/i.exec((header ?? '').trim());
  if (!m) return null;
  let decoded: string;
  try {
    decoded = new TextDecoder().decode(fromBase64(m[1] as string));
  } catch {
    return null;
  }
  const colon = decoded.indexOf(':');
  return colon === -1
    ? { user: decoded, rest: null }
    : { user: decoded.slice(0, colon), rest: decoded.slice(colon + 1) };
}

/** The token in `Bearer fdvt_…` (0.9.0-dev.72): an app's access token; null for anything else. */
const appTokenOf = (header: string | undefined): string | null => {
  const t = /^bearer +(\S+)$/i.exec((header ?? '').trim())?.[1];
  return t !== undefined && t.startsWith('fdvt_') ? t : null;
};

/**
 * Whether a request carries a connected app's API key (its Basic user part
 * `fdvc_…`) or an access token for one (`Bearer fdvt_…`).
 */
const presentsAppKey = (header: string | undefined) =>
  (basicOf(header)?.user.startsWith('fdvc_') ?? false) || appTokenOf(header) !== null;

/**
 * Every access token of these apps ended now, as time would end it (a
 * test's hook, 0.9.0-dev.72): the next request with one is `401
 * app_token_expired`, and a client asks for another.
 */
export function fakeExpireAppTokens(apps: readonly FakeApp[]): number {
  let n = 0;
  for (const a of apps) {
    for (const k of a.keys) {
      for (const t of k.tokens ?? []) {
        t.expires_at = Date.now() - 1000;
        n += 1;
      }
    }
  }
  return n;
}

/** An answer with one more header. */
const withHeader = (res: ResponseLike, name: string, value: string): ResponseLike => ({
  ...res,
  headers: { get: (n) => (n.toLowerCase() === name ? value : res.headers.get(n)) },
});

/** Failed authentications this minute, per fake vault (it knows no addresses: one bucket). */
const FAILURES = new WeakMap<FakeApp[], { minute: number; n: number }>();

/**
 * A key past its expiry now, as time would make it (a test's hook, APP6):
 * its next request is `401 app_key_expired`. False for a client ID no app
 * of these has.
 */
export function fakeExpireAppKey(apps: readonly FakeApp[], clientId: string): boolean {
  for (const a of apps) {
    const k = a.keys.find((x) => x.client_id === clientId);
    if (k) {
      k.created_at = new Date(Date.now() - 2 * 864e5).toISOString();
      k.expires_at = new Date(Date.now() - 1000).toISOString();
      return true;
    }
  }
  return false;
}

const KEY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whom an app acts as (APP8): one a test made by hand without saying is a person's. */
export const actsAs = (a: Pick<FakeApp, 'acts_as'>): 'app' | 'person' => a.acts_as ?? 'person';

/** What an app's line in the activity log says of it (APP8): the app alone, when it acts as itself. */
const lineOf = (a: FakeApp, more: Record<string, unknown> = {}) => ({
  app_id: a.id,
  app: a.name,
  ...(actsAs(a) === 'app' ? { as_itself: true } : {}),
  ...more,
});

export function fakeAppRoutes(d: FakeAppDeps) {
  /** App and key ids are UUIDs, as the vault writes them; an app client takes no other. */
  // Counted by the vault's own counter: these routes are made for each
  // request, and a second app must never be given the first one's id.
  const uuid = () =>
    `00000000-0000-4000-8000-${Number(d.next('uuid').split('-').pop()).toString(16).padStart(12, '0')}`;
  /** A connection string: the address and a key's client ID, and its secret only when asked. */
  const connection = (clientId: string, secret?: string) =>
    `${APP_CONNECTION_PREFIX}${toBase64(
      new TextEncoder().encode(
        JSON.stringify({
          url: 'https://fake.example',
          client_id: clientId,
          instance_id: null,
          ...(secret ? { secret } : {}),
        }),
      ),
      true,
    )}`;
  /**
   * A key for an app acting as somebody else: it waits for them to turn it
   * on again, as the vault does.
   */
  const reapprove = (a: FakeApp, who: { memberId: string }) => {
    // An app acting as itself acts as nobody (APP8): an owner's change is theirs.
    if (actsAs(a) === 'app') return;
    if (a.member_id !== who.memberId && a.approval === 'approved') a.approval = 'waiting';
  };
  const view = async (
    a: FakeApp,
    me: { memberId: string; role?: string },
  ): Promise<ConnectedAppView> => {
    // Each live key with what to paste into the app for it (0.9.0-dev.72).
    const keys = a.keys.map((k) => {
      const v = keyView(k);
      return v.state === 'live' ? { ...v, connection_string: connection(k.client_id) } : v;
    });
    const newest = liveKeys(a)[liveKeys(a).length - 1];
    const itself = actsAs(a) === 'app';
    const mine = !itself && a.member_id === me.memberId;
    const states = [...a.intake.values()];
    const reviewer = itself ? (a.reviewer_member_id ?? null) : null;
    return {
      id: a.id,
      name: a.name,
      acts_as: actsAs(a),
      member_id: itself ? null : a.member_id,
      member_name: itself || !a.member_id ? null : d.memberName(a.member_id),
      reviewer_member_id: reviewer,
      reviewer_name: reviewer ? d.memberName(reviewer) : null,
      reviewer_needed: itself && !(reviewer && d.receives?.(reviewer) === true),
      mine,
      created_at: a.created_at,
      state: a.approval === 'waiting' ? 'waiting_for_approval' : a.paused ? 'paused' : 'active',
      paused_reason: a.paused,
      scopes: [...(a.scopes ?? APP_SCOPES_DEFAULT)],
      allowed_kinds: a.allowed_kinds,
      default_visibility: a.default_visibility,
      auto_file: a.auto_file === true,
      route_to_person: a.route_to_person === true,
      daily_files: a.daily_files,
      daily_bytes: a.daily_bytes,
      backfill: liveBackfill(a),
      ip_allow: [],
      keys,
      last_used_at: a.last_used_at,
      today: { files: a.files_today, bytes: a.bytes_today },
      refused_today: 0,
      last_refusal: null,
      // An owner sees the app's totals (0.9.0-dev.68); its person theirs.
      counts:
        mine || me.role === 'owner'
          ? { waiting: states.filter((s) => s.state === 'waiting').length, filed: 0 }
          : null,
      grants: [...(a.grants ?? [])],
      daily_read_bytes: 1024 ** 3,
      read_today: 0,
      delete_mode: a.delete_mode ?? 'unlink',
      links_per_hour: a.links_per_hour ?? 60,
      links_last_hour: (a.links ?? []).filter((l) => l.created_at > Date.now() - 3_600_000).length,
      links_opened_week: (a.links ?? []).filter(
        (l) => l.opened_at !== null && l.opened_at > Date.now() - 7 * 864e5,
      ).length,
      connection_string: newest ? connection(newest.client_id) : '',
      address: { url: 'https://fake.example', public: false },
    };
  };
  /** The exact file a send of the app's became, while it may download it again (APP5). */
  const sentFile = (s: FakeIntake) => {
    if (s.state !== 'filed' || s.unlinked || !s.document_id || !s.version_id) return null;
    const v = d.versionOf?.(s.version_id) ?? null;
    const doc = (d.documents?.() ?? []).find((x) => x.id === s.document_id);
    if (!v || !doc || v.document_id !== doc.id) return null;
    const category = d.kinds().find((k) => k.key === doc.type_key)?.category ?? null;
    return appMayDownloadSent({
      deleted: doc.deleted,
      visibility: doc.visibility,
      file_removed: false,
      category,
      kind_category: category,
    })
      ? v
      : null;
  };
  const stateOf = (
    externalId: string,
    s: FakeIntake,
    readableIds: ReadonlySet<string> = new Set(),
    scopes: readonly AppScope[] | null = null,
  ): AppIntakeState => {
    // Filed, and no longer the app's to read, or let go of: unavailable, never why.
    const filed = s.state === 'filed';
    const still = filed && !s.unlinked && !!s.document_id && readableIds.has(s.document_id);
    return {
      external_id: externalId,
      state: filed && !still ? 'unavailable' : s.state,
      received_at: s.received_at,
      sha256: s.sha256,
      byte_size: s.byte_size,
      document_id: still ? (s.document_id ?? null) : null,
      version_id: still ? (s.version_id ?? null) : null,
      filed_at: still ? (s.filed_at ?? null) : null,
      removed_reason: s.removed_reason,
      refusal: s.refusal,
      // Never where the route would answer 403: it needs the download scope.
      content_available: !!scopes && scopes.includes('documents.download') && sentFile(s) !== null,
    };
  };

  /**
   * Whom an app is to act as (APP8), as the vault decides it: a person named
   * (as before), or itself with a reviewer — the one named, else the one it
   * has, else the owner asking. The wrong field for each is `422`.
   */
  const whomOf = (
    body: Record<string, unknown>,
    had: FakeApp | null,
    me: string,
  ):
    | { acts_as: 'app' | 'person'; member_id: string | null; reviewer_member_id: string | null }
    | { fail: ResponseLike } => {
    const asked =
      body.acts_as ??
      (body.member_id !== undefined
        ? 'person'
        : body.reviewer_member_id !== undefined
          ? 'app'
          : had
            ? actsAs(had)
            : APP_ACTS_AS_DEFAULT);
    const bad = (message: string, detail: string) => ({
      fail: d.fail(422, 'validation_failed', message, detail),
    });
    if (asked !== 'app' && asked !== 'person') {
      return bad('An app acts as itself or as a person.', 'acts_as');
    }
    if (asked === 'person') {
      if (body.reviewer_member_id !== undefined) {
        return bad('An app acting as a person has no reviewer.', 'reviewer_member_id');
      }
      const member =
        typeof body.member_id === 'string'
          ? body.member_id
          : had && actsAs(had) === 'person'
            ? had.member_id
            : null;
      if (!member || !d.mayAct(member)) {
        return bad('An app acts as an owner or an adult who signs in.', 'member_id');
      }
      return { acts_as: 'person', member_id: member, reviewer_member_id: null };
    }
    if (body.member_id !== undefined) {
      return bad('An app acting as itself acts as nobody.', 'member_id');
    }
    const reviewer =
      typeof body.reviewer_member_id === 'string'
        ? body.reviewer_member_id
        : had && actsAs(had) === 'app' && had.reviewer_member_id
          ? had.reviewer_member_id
          : me;
    if (!d.mayAct(reviewer)) {
      return bad(
        'An app’s papers are reviewed by an owner or an adult who signs in.',
        'reviewer_member_id',
      );
    }
    return { acts_as: 'app', member_id: null, reviewer_member_id: reviewer };
  };

  /** The family's side, signed in: Settings → Connected apps. */
  const family = async (
    path: string,
    method: string,
    body: Record<string, unknown>,
  ): Promise<ResponseLike | null> => {
    if (!path.startsWith('/api/v1/connected-apps')) return null;
    const who = d.session();
    if (!('memberId' in who)) return who;
    const seen = (a: FakeApp) =>
      !a.revoked &&
      (who.role === 'owner' || (who.role === 'adult' && a.member_id === who.memberId));
    if (path === '/api/v1/connected-apps' && method === 'GET') {
      const items: ConnectedAppView[] = [];
      for (const a of d.apps.filter(seen).reverse()) items.push(await view(a, who));
      return d.ok({
        items,
        apps_public: false,
        ceilings: { daily_files: 1000, daily_bytes: 5 * 1024 ** 3 },
      });
    }
    if (path === '/api/v1/connected-apps' && method === 'POST') {
      if (who.role !== 'owner')
        return d.fail(403, 'forbidden', 'Only an owner can connect an app.');
      if (!d.ownerTwoStep()) {
        return d.fail(
          403,
          'totp_required_for_owner',
          'Turn on two-step sign-in to connect an app, or change what it may do.',
        );
      }
      // Whom it acts as (APP8): a person named, as before; else itself.
      const whom = whomOf(body, null, who.memberId);
      if ('fail' in whom) return whom.fail;
      const member = whom.member_id;
      const now = new Date().toISOString();
      const a: FakeApp = {
        id: uuid(),
        name: (typeof body.name === 'string' ? body.name : '').trim() || 'App',
        acts_as: whom.acts_as,
        member_id: member,
        reviewer_member_id: whom.reviewer_member_id,
        approval: whom.acts_as === 'app' || member === who.memberId ? 'approved' : 'waiting',
        paused: null,
        revoked: false,
        allowed_kinds: Array.isArray(body.allowed_kinds) ? (body.allowed_kinds as string[]) : [],
        default_visibility:
          (body.default_visibility as ConnectedAppView['default_visibility']) ?? null,
        daily_files: typeof body.daily_files === 'number' ? body.daily_files : 100,
        daily_bytes: typeof body.daily_bytes === 'number' ? body.daily_bytes : 500 * 1024 * 1024,
        // No key yet: an owner generates one next (APP6).
        keys: [],
        created_at: now,
        intake: new Map(),
        files_today: 0,
        bytes_today: 0,
        last_used_at: null,
        // On for a new app unless the owner said not (APP5).
        route_to_person: true,
      };
      const route = routeOf(body);
      if ('fail' in route) return route.fail;
      Object.assign(a, route.set);
      if (body.scopes !== undefined) {
        const scopes = scopesOf(body.scopes);
        if (!scopes) return d.fail(422, 'validation_failed', 'Choose what it may do.', 'scopes');
        a.scopes = scopes;
      }
      const links = linksOf(body);
      if ('fail' in links) return links.fail;
      Object.assign(a, links.set);
      const auto = autoOf(body);
      if ('fail' in auto) return auto.fail;
      Object.assign(a, auto.set);
      d.apps.push(a);
      d.log?.({
        action: 'app.connected',
        actorMemberId: who.memberId,
        object: a.member_id ?? a.reviewer_member_id ?? null,
        detail: {
          app_id: a.id,
          app: a.name,
          ...(whom.acts_as === 'app' ? { acts_as: 'app' } : {}),
        },
      });
      return d.ok(await view(a, who), 201);
    }
    const at = new RegExp(
      `^/api/v1/connected-apps/([^/]+)(/approve|/pause|/resume|/grants|/keys(?:/([^/]+))?)?$`,
    ).exec(path);
    if (!at) return null;
    const what = at[2] ?? '';
    const find = () => d.apps.find((x) => x.id === at[1] && seen(x));
    const notHere = () => d.fail(404, 'not_found', 'That app is not here.');
    // An app's keys, each check in the order the vault's routes make them:
    // the ids, whose call it is, the second step, the key given, the app.
    if (what.startsWith('/keys')) {
      const keyId = at[3];
      const generate = keyId === undefined && method === 'POST';
      const revoke = keyId !== undefined && method === 'DELETE';
      if (!generate && !revoke) return null;
      if (!KEY_ID.test(at[1] as string) || (keyId !== undefined && !KEY_ID.test(keyId))) {
        return d.fail(422, 'validation_failed', 'Not an id.', keyId === undefined ? 'id' : 'keyId');
      }
      // An owner's alone, after a passkey or a code: generating and revoking alike.
      if (who.role !== 'owner') {
        return d.fail(
          403,
          'forbidden',
          generate
            ? 'Only an owner can generate an API key for an app.'
            : 'Only an owner can revoke an app’s API key.',
        );
      }
      if (!d.ownerTwoStep()) {
        return d.fail(
          403,
          'totp_required_for_owner',
          'Turn on two-step sign-in to connect an app, or change what it may do.',
        );
      }
      const a = find();
      if (!a) return notHere();
      if (revoke) {
        const k = a.keys.find((x) => x.id === keyId?.toLowerCase());
        if (!k) return d.fail(404, 'not_found', 'That key is not here.');
        if (k.revoked_at === null) {
          k.revoked_at = new Date().toISOString();
          k.revoked_reason = 'owner';
        }
        return d.empty();
      }
      // The body: its name, its permissions, how long it lasts; nothing else.
      const allowed = ['name', 'permissions', 'expires_in_days'];
      const extra = Object.keys(body).find((k) => !allowed.includes(k));
      if (extra !== undefined) {
        return d.fail(422, 'validation_failed', `Unknown field ${extra}.`, extra);
      }
      let name: string | null = null;
      if (body.name !== undefined && body.name !== null) {
        if (typeof body.name !== 'string' || body.name.trim().length > APP_KEY_NAME_MAX) {
          return d.fail(
            422,
            'validation_failed',
            `Give the key a name of ${APP_KEY_NAME_MAX} characters at most, or none.`,
            'name',
          );
        }
        name = body.name.trim() || null;
      }
      const appScopes = a.scopes ?? APP_SCOPES_DEFAULT;
      const p = body.permissions;
      if (
        !Array.isArray(p) ||
        p.length === 0 ||
        !p.every((s) => typeof s === 'string' && (appScopes as readonly string[]).includes(s))
      ) {
        return d.fail(
          422,
          'validation_failed',
          'Choose what the key may do, from what the app may do.',
          'permissions',
        );
      }
      // Left out: 90 days (0.9.0-dev.72); null, never, said on purpose.
      const days = body.expires_in_days === undefined ? APP_KEY_DEFAULT_DAYS : body.expires_in_days;
      if (
        days !== null &&
        (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > APP_KEY_DAYS_MAX)
      ) {
        return d.fail(
          422,
          'validation_failed',
          `How long it lasts: 1 to ${APP_KEY_DAYS_MAX} days, or never expires.`,
          'expires_in_days',
        );
      }
      const live = liveKeys(a);
      if (live.length >= APP_KEYS_MAX) {
        return d.fail(
          409,
          'key_limit',
          `An app has ${APP_KEYS_MAX} live API keys at most. Revoke one first.`,
        );
      }
      const clientId = `fdvc_${randomText(16)}`;
      const secret = `fdvs_${randomText(32)}`;
      const now = Date.now();
      const k: FakeAppKey = {
        id: uuid(),
        client_id: clientId,
        secret_sha256: hex(await sha256(new TextEncoder().encode(secret))),
        name,
        permissions: APP_SCOPES_OFFERED.filter((s) => (p as unknown[]).includes(s)),
        created_at: new Date(now).toISOString(),
        expires_at: days === null ? null : new Date(now + days * 864e5).toISOString(),
        last_used_at: null,
        revoked_at: null,
      };
      a.keys.push(k);
      // A key that may do no more than a live one already may (a rotation)
      // widens nothing (the owner's decision, 18 Nov 2026): its person is
      // not asked again. One that may do more is a widening.
      if (!live.some((x) => k.permissions.every((s) => x.permissions.includes(s)))) {
        reapprove(a, who);
      }
      const made: ConnectedAppKeyMade = {
        key: { ...keyView(k), connection_string: connection(clientId) },
        client_id: clientId,
        secret,
        connection_string: connection(clientId),
        connection_string_with_secret: connection(clientId, secret),
      };
      return d.ok(made, 201);
    }
    const a = find();
    if (!a) return notHere();
    if (what === '' && method === 'DELETE') {
      // Its keys are revoked with it.
      a.revoked = true;
      const now = new Date().toISOString();
      for (const k of a.keys) {
        if (k.revoked_at === null) {
          k.revoked_at = now;
          k.revoked_reason = 'app_removed';
        }
      }
      return d.empty();
    }
    if (what === '/approve' && method === 'POST') {
      if (a.member_id !== who.memberId) return d.fail(404, 'not_found', 'That app is not here.');
      a.approval = 'approved';
      return d.ok(await view(a, who));
    }
    if (who.role !== 'owner')
      return d.fail(403, 'forbidden', 'Only an owner can change what an app may do.');
    if (what === '/pause' && method === 'POST') {
      a.paused = 'owner';
      return d.ok(await view(a, who));
    }
    if (what === '/resume' && method === 'POST') {
      a.paused = null;
      return d.ok(await view(a, who));
    }
    if (what === '' && method === 'PATCH') {
      // Whom it acts as, and who reviews it (APP8): as the vault changes them.
      const asked =
        body.acts_as !== undefined ||
        body.member_id !== undefined ||
        body.reviewer_member_id !== undefined;
      if (asked) {
        const whom = whomOf(body, a, who.memberId);
        if ('fail' in whom) return whom.fail;
        const moved = whom.acts_as !== actsAs(a) || whom.member_id !== a.member_id;
        a.acts_as = whom.acts_as;
        a.member_id = whom.member_id;
        a.reviewer_member_id = whom.reviewer_member_id;
        a.reviewer_told = false;
        if (moved) {
          a.approval =
            whom.acts_as === 'person' && whom.member_id !== who.memberId ? 'waiting' : 'approved';
        }
      }
      if (typeof body.name === 'string') a.name = body.name;
      if (Array.isArray(body.allowed_kinds)) a.allowed_kinds = body.allowed_kinds as string[];
      if (typeof body.daily_files === 'number') a.daily_files = body.daily_files;
      if (body.scopes !== undefined) {
        const scopes = scopesOf(body.scopes);
        if (!scopes) return d.fail(422, 'validation_failed', 'Choose what it may do.', 'scopes');
        a.scopes = scopes;
      }
      const links = linksOf(body);
      if ('fail' in links) return links.fail;
      Object.assign(a, links.set);
      const auto = autoOf(body);
      if ('fail' in auto) return auto.fail;
      const route = routeOf(body);
      if ('fail' in route) return route.fail;
      // Filing automatically switched on (APP4), or sending to the person a
      // paper is about (APP5), widens: an app acting as somebody else waits
      // for them again, as the vault does.
      const widened =
        (auto.set.auto_file === true && a.auto_file !== true) ||
        (auto.set.backfill?.auto_file === true && liveBackfill(a)?.auto_file !== true) ||
        (route.set.route_to_person === true && a.route_to_person !== true);
      Object.assign(a, auto.set, route.set);
      if (widened && a.member_id !== who.memberId) a.approval = 'waiting';
      return d.ok(await view(a, who));
    }
    if (what === '/grants' && method === 'PUT') {
      const given = Array.isArray(body.grants)
        ? (body.grants as Array<Record<string, unknown>>)
        : [];
      const kinds = d.kinds();
      const grantable = (k: { category: string; usually_essential?: boolean }) =>
        (APP_GRANTABLE_CATEGORIES as readonly string[]).includes(k.category) &&
        k.usually_essential !== true;
      const grants: ConnectedAppGrantView[] = [];
      const asked: Array<{ key: string; label: string }> = [];
      for (const [i, g] of given.entries()) {
        const kind = typeof g.kind === 'string' ? g.kind : null;
        const category = typeof g.category === 'string' ? g.category : null;
        const months = g.lookback_months;
        if ((kind === null) === (category === null)) {
          return d.fail(422, 'validation_failed', 'A kind or a category.', `grants.${i}`);
        }
        if (typeof months !== 'number' || !Number.isInteger(months) || months < 1 || months > 36) {
          return d.fail(422, 'validation_failed', 'How far back: 1 to 36 months.', `grants.${i}`);
        }
        const k = kind ? kinds.find((x) => x.key === kind) : undefined;
        if (
          (category && !(APP_GRANTABLE_CATEGORIES as readonly string[]).includes(category)) ||
          (kind && (!k || !grantable(k)))
        ) {
          return d.fail(422, 'validation_failed', 'An app may never read that.', `grants.${i}`);
        }
        // The kinds Sensitive by default it covers now; each confirmed once.
        const covered = kinds.filter(
          (x) =>
            x.sensitive_default !== false &&
            grantable(x) &&
            (kind ? x.key === kind : x.category === category),
        );
        const before = (a.grants ?? []).find((x) => x.kind === kind && x.category === category);
        const had = before?.sensitive_kinds ?? [];
        const newly = covered.filter((x) => !had.includes(x.key));
        if (newly.length > 0 && body.confirm_sensitive !== true) asked.push(...newly);
        const sensitive = [...new Set([...had, ...newly.map((x) => x.key)])].sort();
        grants.push({
          kind,
          category,
          lookback_months: months,
          sensitive_confirmed:
            covered.length > 0 && covered.every((x) => sensitive.includes(x.key)),
          sensitive_kinds: sensitive,
        });
      }
      if (asked.length > 0) {
        return d.fail(
          409,
          'sensitive_confirm',
          appSensitiveConfirmWords(a.name, [...new Set(asked.map((x) => x.label))].sort()),
          [...new Set(asked.map((x) => x.key))].sort().join(','),
        );
      }
      a.grants = grants;
      return d.ok(await view(a, who));
    }
    return null;
  };

  /** Filing automatically (APP4), and a backfill's window, as an owner sets them. */
  const autoOf = (
    body: Record<string, unknown>,
  ): { set: Partial<FakeApp> } | { fail: ResponseLike } => {
    const set: Partial<FakeApp> = {};
    if (body.auto_file !== undefined) {
      if (typeof body.auto_file !== 'boolean') {
        return {
          fail: d.fail(422, 'validation_failed', 'File automatically: on or off.', 'auto_file'),
        };
      }
      set.auto_file = body.auto_file;
    }
    if (body.backfill === null) set.backfill = null;
    else if (body.backfill !== undefined) {
      const b = body.backfill as Record<string, unknown>;
      const auto = b.auto_file ?? false;
      if (typeof auto !== 'boolean') {
        return {
          fail: d.fail(
            422,
            'validation_failed',
            'File automatically: on or off.',
            'backfill.auto_file',
          ),
        };
      }
      set.backfill = {
        until: String(b.until),
        files_per_day: Number(b.files_per_day),
        bytes_per_day: Number(b.bytes_per_day),
        auto_file: auto,
      };
    }
    return { set };
  };

  /** Each paper to the Inbox of the person it is about (APP5), as an owner sets it. */
  const routeOf = (
    body: Record<string, unknown>,
  ): { set: Partial<FakeApp> } | { fail: ResponseLike } => {
    if (body.route_to_person === undefined) return { set: {} };
    if (typeof body.route_to_person !== 'boolean') {
      return {
        fail: d.fail(
          422,
          'validation_failed',
          'Send to the person it is about: on or off.',
          'route_to_person',
        ),
      };
    }
    return { set: { route_to_person: body.route_to_person } };
  };

  /** What a delete does, and links an hour (APP3), as an owner sets them. */
  const linksOf = (
    body: Record<string, unknown>,
  ): { set: Partial<FakeApp> } | { fail: ResponseLike } => {
    const set: Partial<FakeApp> = {};
    if (body.delete_mode !== undefined) {
      if (body.delete_mode !== 'unlink' && body.delete_mode !== 'trash') {
        return {
          fail: d.fail(
            422,
            'validation_failed',
            'What a delete does: unlink or trash.',
            'delete_mode',
          ),
        };
      }
      set.delete_mode = body.delete_mode;
    }
    if (body.links_per_hour !== undefined) {
      const n = body.links_per_hour;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 600) {
        return {
          fail: d.fail(422, 'validation_failed', 'Links an hour: 1 to 600.', 'links_per_hour'),
        };
      }
      set.links_per_hour = n;
    }
    return { set };
  };

  /** Scopes as an owner gives them: those this vault grants, at least one. */
  const scopesOf = (v: unknown): AppScope[] | null =>
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((s) => (APP_SCOPES_OFFERED as readonly unknown[]).includes(s))
      ? APP_SCOPES_OFFERED.filter((s) => (v as unknown[]).includes(s))
      : null;

  /** A document as the app is told of it, when it may read it (the vault's own rule). */
  type Told = {
    doc: AppDocument;
    fp: string;
    v: FakeReadableDoc['version'];
    /** Its current version is one this app sent: only then may the app delete it. */
    currentSent: boolean;
    /** The versions of it this app sent (filed, not let go of): version id → external id. */
    sent: Map<string, string>;
  };
  const readable = async (a: FakeApp): Promise<Map<string, Told>> => {
    const out = new Map<string, Told>();
    const today = localToday(d.timezone());
    const kinds = d.kinds();
    // Its own: a document a send of its made (not one it was filed into),
    // not let go of (APP3), whatever newer versions the family or another
    // app added since (the owner's decision, 18 Nov 2026).
    const own = new Map<string, string>();
    const filed = [...a.intake].filter(
      ([, s]) => s.state === 'filed' && s.document_id && !s.unlinked,
    );
    for (const [externalId, s] of filed) {
      if (s.made_document && s.document_id && !own.has(s.document_id)) {
        own.set(s.document_id, externalId);
      }
    }
    for (const x of d.documents?.() ?? []) {
      const kind = kinds.find((k) => k.key === x.type_key);
      const due = x.extra.due_date as DateValue | undefined;
      const paper = x.issued?.date ?? due?.date ?? x.filed_on;
      const ownId = own.get(x.id);
      const isOwn = ownId !== undefined;
      const sent = new Map<string, string>();
      for (const [externalId, s] of filed) {
        if (s.document_id === x.id && s.version_id && !sent.has(s.version_id)) {
          sent.set(s.version_id, externalId);
        }
      }
      const currentSent = x.version !== null && sent.has(x.version.id);
      const ok = appMayRead({
        document: {
          visibility: x.visibility,
          is_essential: x.is_essential,
          sensitive: x.sensitive,
          deleted: x.deleted,
          type_key: x.type_key,
          category: kind?.category ?? null,
          paper_date: paper,
        },
        kind: kind
          ? {
              category: kind.category,
              sensitive_default: kind.sensitive_default ?? true,
              usually_essential: kind.usually_essential ?? false,
            }
          : null,
        role: 'owner',
        own: isOwn,
        grants: (a.grants ?? []).map((g) => ({
          kind_key: g.kind,
          category: g.category,
          lookback_months: g.lookback_months,
          sensitive_kinds: g.sensitive_kinds,
        })),
        today,
      });
      if (!ok || !kind) continue;
      const text = (k: string) => (typeof x.extra[k] === 'string' ? x.extra[k].trim() : null);
      const amount = text('amount');
      const money = amount ? /^(-?[\d,]*\d(?:\.\d+)?)\s+([A-Z]{3})$/.exec(amount) : null;
      const year = x.extra.tax_year;
      const status = deriveStatus(
        {
          type: {
            key: kind.key,
            expiry_driver: kind.expiry_driver,
            reminder_leads: kind.reminder_leads ?? [],
          },
          owner_member_id: x.owner_member_id,
          household_owned: x.household_owned,
          expires: x.expires,
        },
        today,
      );
      const doc: AppDocument = {
        id: x.id,
        kind: { key: kind.key, label: kind.label, category: kind.category },
        title: x.title,
        paper_date: paper,
        issued: x.issued ? { date: x.issued.date, precision: x.issued.precision } : null,
        expires: x.expires ? { date: x.expires.date, precision: x.expires.precision } : null,
        due_date: due ? { date: due.date, precision: due.precision } : null,
        amount: amount
          ? {
              text: amount,
              value: money ? (money[1] as string).replace(/,/g, '') : null,
              currency: money ? (money[2] as string) : null,
            }
          : null,
        issuer: x.issued_by,
        account_last4: text('account_last4'),
        period: text('period'),
        tax_year:
          typeof year === 'number' && Number.isInteger(year)
            ? year
            : typeof year === 'string' && /^\d{4}$/.test(year)
              ? Number(year)
              : null,
        status: { value: status.value, label: status.label },
        version: x.version
          ? {
              id: x.version.id,
              sha256: hex(await sha256(x.version.bytes)),
              byte_size: x.version.bytes.length,
              content_type: x.version.mime,
            }
          : null,
        own: isOwn,
        external_id: isOwn ? (ownId ?? null) : null,
        updated_at: x.updated_at,
      };
      const said: Partial<AppDocument> = { ...doc };
      delete said.updated_at;
      out.set(x.id, { doc, fp: JSON.stringify(said), v: x.version, currentSent, sent });
    }
    return out;
  };
  /** The feed brought up to date: a line for each document new or changed, and each gone. */
  const refresh = (a: FakeApp, now: Map<string, Told>) => {
    const seen = (a.seen ??= new Map());
    const feed = (a.feed ??= []);
    const at = new Date().toISOString();
    // Counted on from its own last line: these routes are made for each request.
    let seq = feed[feed.length - 1]?.seq ?? 0;
    for (const [id, r] of [...now].sort(([x], [y]) => (x < y ? -1 : 1))) {
      const s = seen.get(id);
      if (!s || !s.available || s.fingerprint !== r.fp) {
        feed.push({ seq: ++seq, id, change: 'changed', at });
        seen.set(id, { fingerprint: r.fp, available: true });
      }
    }
    for (const [id, s] of seen) {
      if (s.available && !now.has(id)) {
        feed.push({ seq: ++seq, id, change: 'unavailable', at });
        s.available = false;
      }
    }
  };

  /**
   * A request with an API key (APP6), checked in the contract's order; the
   * app, its key and what this request may do (the key's permissions that
   * the app has too), or the refusal.
   */
  const authenticate = async (
    headers: Record<string, string>,
    scope: AppScope | null,
    anyState: boolean,
    tokenRoute = false,
  ): Promise<
    { a: FakeApp; key: FakeAppKey; scopes: AppScope[]; via: 'basic' | 'token' } | ResponseLike
  > => {
    // 1. An access token (0.9.0-dev.72) or Basic with an app's client ID,
    // and nothing else that names a caller; the token route, the key alone.
    const basic = basicOf(headers.authorization);
    const token = appTokenOf(headers.authorization);
    if (
      (token === null && (!basic || !basic.user.startsWith('fdvc_'))) ||
      (tokenRoute && token !== null) ||
      headers.cookie ||
      headers['signature'] ||
      headers['signature-input']
    ) {
      return d.fail(401, 'app_key_required', APP_REFUSALS.app_key_required);
    }
    // 2. Not too many failed tries this minute.
    const minute = Math.floor(Date.now() / 60_000);
    const tries = FAILURES.get(d.apps);
    const failedNow = tries && tries.minute === minute ? tries.n : 0;
    if (failedNow >= APP_AUTH_FAILURES_PER_MINUTE) {
      const wait = Math.max(1, Math.ceil(((minute + 1) * 60_000 - Date.now()) / 1000));
      return d.ok(
        {
          error: {
            code: 'rate_limited',
            message: `Too many failed tries. Try again in ${wait} seconds.`,
            retriable: true,
            request_id: 'fake',
          },
        },
        429,
        { 'retry-after': String(wait) },
      );
    }
    // Only a guess counts: an unknown client ID or a wrong secret. A right
    // secret — whatever is refused after it — is no guessing.
    const guessed = () => {
      FAILURES.set(d.apps, { minute, n: failedNow + 1 });
      return d.fail(401, 'app_key_invalid', APP_REFUSALS.app_key_invalid);
    };
    const refused = (status: number, code: keyof typeof APP_REFUSALS) =>
      d.fail(status, code, APP_REFUSALS[code]);
    let found: { a: FakeApp; key: FakeAppKey } | null = null;
    if (token !== null) {
      // 3a. A token, by its hash: one never given is a guess; one past its
      // end is asked for again.
      const given = hex(await sha256(new TextEncoder().encode(token)));
      let ends: number | null = null;
      for (const a of d.apps) {
        for (const key of a.keys) {
          const t = (key.tokens ?? []).find((x) => sameHex(x.sha256, given));
          if (t) {
            found = { a, key };
            ends = t.expires_at;
          }
        }
      }
      if (!found || ends === null || !APP_TOKEN_PATTERN.test(token)) {
        FAILURES.set(d.apps, { minute, n: failedNow + 1 });
        return refused(401, 'app_token_invalid');
      }
      if (ends <= Date.now()) return refused(401, 'app_token_expired');
    } else if (basic) {
      // 3b. The client ID and the secret: unknown and wrong alike, compared in full.
      const clientId = basic.user;
      const secret = basic.rest ?? '';
      const given = hex(await sha256(new TextEncoder().encode(secret)));
      for (const a of d.apps) {
        const key = a.keys.find((k) => k.client_id === clientId);
        if (key) found = { a, key };
      }
      const matches = sameHex(given, found?.key.secret_sha256 ?? '0'.repeat(64));
      if (
        !found ||
        !matches ||
        basic.rest === null ||
        !APP_CLIENT_ID_PATTERN.test(clientId) ||
        !APP_SECRET_PATTERN.test(secret)
      ) {
        return guessed();
      }
    }
    if (!found) return guessed();
    const { a, key } = found;
    // 4. The app removed; the key revoked or past its expiry.
    if (a.revoked) return refused(401, 'app_revoked');
    const state = keyState(key);
    if (state === 'revoked') return refused(401, 'app_key_revoked');
    if (state === 'expired') return refused(401, 'app_key_expired');
    // 5. On, and turned on by its person — but for GET /apps/me.
    if (!anyState && a.paused) return d.fail(403, 'app_paused', APP_REFUSALS.app_paused);
    if (!anyState && a.approval !== 'approved') {
      return d.fail(403, 'app_not_approved', APP_REFUSALS.app_not_approved);
    }
    a.last_used_at = new Date().toISOString();
    key.last_used_at = a.last_used_at;
    // 6. The route among what the key may do, and the app.
    const appScopes = a.scopes ?? APP_SCOPES_DEFAULT;
    const scopes = APP_SCOPES_OFFERED.filter(
      (s) => appScopes.includes(s) && key.permissions.includes(s),
    );
    if (scope && !scopes.includes(scope)) {
      return d.fail(403, 'scope_not_granted', APP_REFUSALS.scope_not_granted);
    }
    return { a, key, scopes, via: token !== null ? 'token' : 'basic' };
  };

  /**
   * `POST /apps/token` (0.9.0-dev.72): the grant, as a form, and a token
   * for the key, fifteen minutes long; so many a key a minute.
   */
  const mintToken = async (
    key: FakeAppKey,
    scopes: AppScope[],
    init: Parameters<FetchLike>[1],
  ): Promise<ResponseLike> => {
    const type = (init.headers['content-type'] ?? init.headers['Content-Type'] ?? '').toLowerCase();
    const text =
      typeof init.body === 'string'
        ? init.body
        : init.body instanceof Uint8Array
          ? new TextDecoder().decode(init.body)
          : null;
    if (!type.startsWith('application/x-www-form-urlencoded') || text === null) {
      return d.fail(400, 'invalid_request', APP_REFUSALS.invalid_request);
    }
    // The form's fields, each as many times as it was sent.
    const form = text
      .split('&')
      .filter(Boolean)
      .map((pair) => {
        const [k = '', v = ''] = pair.split('=');
        const plain = (x: string) => decodeURIComponent(x.replace(/\+/g, ' '));
        return [plain(k), plain(v)] as const;
      });
    const all = (name: string) => form.filter(([k]) => k === name).map(([, v]) => v);
    if (all('client_secret').length > 0 || all('grant_type').length !== 1) {
      return d.fail(400, 'invalid_request', APP_REFUSALS.invalid_request);
    }
    if (all('grant_type')[0] !== 'client_credentials') {
      return d.fail(400, 'unsupported_grant_type', APP_REFUSALS.unsupported_grant_type);
    }
    const minute = Math.floor(Date.now() / 60_000);
    const n = key.minted && key.minted.minute === minute ? key.minted.n + 1 : 1;
    key.minted = { minute, n };
    if (n > APP_TOKENS_PER_KEY_PER_MINUTE) {
      const wait = Math.max(1, Math.ceil(((minute + 1) * 60_000 - Date.now()) / 1000));
      return d.ok(
        {
          error: {
            code: 'rate_limited',
            message: `Too many access tokens asked for at once. Try again in ${wait} seconds.`,
            retriable: true,
            request_id: 'fake',
          },
        },
        429,
        { 'retry-after': String(wait) },
      );
    }
    const token = `fdvt_${randomText(32)}`;
    const now = Date.now();
    key.tokens = [
      ...(key.tokens ?? []).filter((t) => t.expires_at > now),
      {
        sha256: hex(await sha256(new TextEncoder().encode(token))),
        expires_at: now + APP_TOKEN_SECONDS * 1000,
      },
    ];
    return d.ok(
      {
        access_token: token,
        token_type: 'Bearer',
        expires_in: APP_TOKEN_SECONDS,
        scope: scopes.join(' '),
      },
      200,
      { 'cache-control': 'no-store', pragma: 'no-cache' },
    );
  };

  /**
   * The app's side, with its API key or a token for it; the key as Basic
   * anywhere but the token route answered with a `Deprecation` header
   * (0.9.0-dev.72), once it is let through.
   */
  const app = async (
    url: string,
    init: Parameters<FetchLike>[1],
    parts: Parameters<typeof appRoutes>[2],
  ): Promise<ResponseLike | null> => {
    const seen: { via: 'basic' | 'token' | null } = { via: null };
    const res = await appRoutes(url, init, parts, seen);
    return res && seen.via === 'basic'
      ? withHeader(res, 'deprecation', APP_BASIC_DEPRECATION)
      : res;
  };

  /** The app routes themselves. */
  const appRoutes: (
    url: string,
    init: Parameters<FetchLike>[1],
    parts: (body: unknown) => Array<{
      name: string;
      value: string | null;
      bytes?: Uint8Array;
      type?: string;
      filename?: string;
    }> | null,
    seen: { via: 'basic' | 'token' | null },
  ) => Promise<ResponseLike | null> = async (url, init, parts, seen) => {
    const target = url.replace(/^[a-z]+:\/\/[^/]+/i, '');
    const path = target.split('?')[0] as string;
    const method = init.method ?? 'GET';
    const headers = Object.fromEntries(
      Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    // An app's key is taken by the app routes alone; any other Basic value
    // (a proxy's in front of the vault) goes on untouched.
    if (!APP_ROUTE.test(path)) {
      return presentsAppKey(headers.authorization)
        ? d.fail(401, 'app_key_not_accepted', APP_REFUSALS.app_key_not_accepted)
        : null;
    }
    const body =
      init.body instanceof Uint8Array
        ? init.body
        : typeof init.body === 'string'
          ? new TextEncoder().encode(init.body)
          : new Uint8Array();
    const me = path === '/api/v1/apps/me';
    const tokenRoute = path === '/api/v1/apps/token';
    if (tokenRoute && method !== 'POST')
      return d.fail(404, 'not_found', 'That page does not exist.');
    const scope: AppScope | null =
      me || tokenRoute
        ? null
        : path.endsWith('/content')
          ? 'documents.download'
          : path.endsWith('/links')
            ? 'documents.links'
            : method === 'DELETE' && /^\/api\/v1\/apps\/documents\/[^/]+$/.test(path)
              ? 'documents.delete'
              : path.startsWith('/api/v1/apps/documents') || path === '/api/v1/apps/changes'
                ? 'documents.read'
                : 'documents.send';
    const authed = await authenticate(headers, scope, me || tokenRoute, tokenRoute);
    if (!('a' in authed)) return authed;
    const { a, key, scopes } = authed;
    if (tokenRoute) return mintToken(key, scopes, init);
    seen.via = authed.via;
    const params = new Map(
      (target.split('?')[1] ?? '')
        .split('&')
        .filter(Boolean)
        .map((p) => {
          const [k = '', v = ''] = p.split('=');
          return [decodeURIComponent(k), decodeURIComponent(v)] as const;
        }),
    );
    const query = { get: (k: string) => params.get(k) ?? null };
    const notFound = () => d.fail(404, 'not_found', 'Nothing by that id that this app may see.');
    const limitOf = (fallback: number): number | null => {
      const raw = query.get('limit');
      if (raw === null) return fallback;
      const n = Number(raw);
      return /^\d+$/.test(raw) && n >= 1 && n <= 100 ? n : null;
    };
    if (path === '/api/v1/apps/documents' && method === 'GET') {
      const limit = limitOf(50);
      if (limit === null) return d.fail(422, 'validation_failed', 'limit is 1 to 100.', 'limit');
      const all = [...(await readable(a)).values()]
        .map((r) => r.doc)
        .filter(
          (x) =>
            !query.get('kind') || (query.get('kind') as string).split(',').includes(x.kind.key),
        )
        .filter((x) => !query.get('category') || x.kind.category === query.get('category'))
        .filter((x) => !query.get('from') || x.paper_date >= (query.get('from') as string))
        .filter((x) => !query.get('to') || x.paper_date <= (query.get('to') as string))
        .filter((x) => !query.get('own') || String(x.own) === query.get('own'))
        .sort((x, y) =>
          x.paper_date !== y.paper_date
            ? x.paper_date < y.paper_date
              ? 1
              : -1
            : x.id < y.id
              ? -1
              : 1,
        );
      const cursor = query.get('cursor');
      const from = cursor === null ? 0 : Number(/^list-(\d+)$/.exec(cursor)?.[1] ?? NaN);
      if (Number.isNaN(from)) return d.fail(422, 'validation_failed', 'Not a cursor.', 'cursor');
      const items = all.slice(from, from + limit);
      return d.ok({
        items,
        next: all.length > from + limit ? `list-${from + limit}` : null,
      });
    }
    const linkAt = /^\/api\/v1\/apps\/documents\/([^/]+)\/links$/.exec(path);
    if (linkAt && method === 'POST') {
      let asked: unknown;
      try {
        asked = JSON.parse(new TextDecoder().decode(body));
      } catch {
        asked = null;
      }
      const mode = (asked as { mode?: unknown } | null)?.mode;
      if (mode !== 'view' && mode !== 'download') {
        return d.fail(422, 'validation_failed', 'mode is "view" or "download".', 'mode');
      }
      const extra = Object.keys(asked as object).find((k) => k !== 'mode');
      if (extra !== undefined) {
        return d.fail(422, 'validation_failed', `Unrecognized key: "${extra}"`, extra);
      }
      // Any link needs reading too; a download link, downloading as well.
      const needs: AppScope[] =
        mode === 'download' ? ['documents.read', 'documents.download'] : ['documents.read'];
      const missing = needs.find((x) => !scopes.includes(x));
      if (missing) {
        return d.fail(403, 'scope_not_granted', APP_REFUSALS.scope_not_granted, missing);
      }
      const r = (await readable(a)).get(linkAt[1] as string);
      const shown = r?.v ?? null;
      if (!r || !shown) return notFound();
      if (mode === 'view' && !canShareToView(shown.mime)) {
        return d.fail(409, 'view_unavailable', APP_REFUSALS.view_unavailable);
      }
      const now = Date.now();
      const links = (a.links ??= []);
      const hour = links
        .filter((l) => l.created_at > now - 3_600_000)
        .map((l) => l.created_at)
        .sort((x, y) => x - y);
      const cap = a.links_per_hour ?? 60;
      if (hour.length >= cap) {
        // Retriable, when the (n − cap)th of the hour, oldest first, is an hour old.
        const at = hour[hour.length - cap] ?? now;
        const wait = Math.max(1, Math.ceil((at + 3_600_000 - now) / 1000));
        return d.ok(
          {
            error: {
              code: 'app_links_full',
              message: APP_REFUSALS.app_links_full,
              retriable: true,
              request_id: 'fake',
            },
          },
          429,
          { 'retry-after': String(wait) },
        );
      }
      const token = toBase64(crypto.getRandomValues(new Uint8Array(32)), true);
      links.push({
        token,
        key_id: key.id,
        document_id: r.doc.id,
        version_id: shown.id,
        mode,
        created_at: now,
        open_by: now + APP_LINK_OPEN_SECONDS * 1000,
        opened_at: null,
        cookie: null,
        session_until: null,
      });
      return d.ok(
        {
          url: `https://fake.example/api/v1/app-links/${token}`,
          mode,
          open_by: new Date(now + APP_LINK_OPEN_SECONDS * 1000).toISOString(),
          session_minutes: APP_LINK_SESSION_MINUTES,
        },
        201,
      );
    }
    const deleteAt = /^\/api\/v1\/apps\/documents\/([^/]+)$/.exec(path);
    if (deleteAt && method === 'DELETE') {
      // Its own alone, its current file one it sent: one it reads by a
      // grant, may not read, or whose newest file is the family's (or
      // another app's), is 404.
      const r = (await readable(a)).get(deleteAt[1] as string);
      if (!r || !r.doc.own || !r.currentSent) return notFound();
      for (const s of a.intake.values()) {
        if (s.state === 'filed' && s.document_id === r.doc.id) s.unlinked = true;
      }
      if ((a.delete_mode ?? 'unlink') === 'trash') {
        d.trash?.(r.doc.id);
        return d.ok({ document_id: r.doc.id, result: 'trashed' });
      }
      return d.ok({ document_id: r.doc.id, result: 'unlinked' });
    }
    const docAt = /^\/api\/v1\/apps\/documents\/([^/]+)(\/content)?$/.exec(path);
    if (docAt && method === 'GET') {
      const r = (await readable(a)).get(docAt[1] as string);
      if (!r) return notFound();
      if (!docAt[2]) return d.ok(r.doc);
      const v = r.v;
      if (!v) return notFound();
      const etag = `"${v.id}"`;
      const total = v.bytes.length;
      const plain = {
        'content-type': v.mime,
        'content-disposition': `attachment; filename="${v.filename.replace(/"/g, '')}"`,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': 'no-store',
        'accept-ranges': 'bytes',
        etag,
      };
      if (headers['if-none-match'] === etag) return d.raw(304, new Uint8Array(), plain);
      // A Range: one, as the vault takes it — `a-b`, `a-` or the last `-n`.
      let start = 0;
      let end = total - 1;
      const asked = headers.range;
      if (asked !== undefined) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(asked.trim());
        const bad = () =>
          d.fail(416, 'range_not_satisfiable', 'That part of the file does not exist.');
        if (!m || (m[1] === '' && m[2] === '')) return bad();
        if (m[1] === '') start = Math.max(0, total - Number(m[2]));
        else {
          start = Number(m[1]);
          end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
        }
        if (total === 0 || start > end || start >= total) return bad();
      }
      const bytes = end - start + 1;
      const cap = a.daily_read_bytes ?? 1024 ** 3;
      if (bytes > cap) {
        return d.fail(413, 'larger_than_daily_read', APP_REFUSALS.larger_than_daily_read);
      }
      if ((a.read_bytes_today ?? 0) + bytes > cap) {
        return d.fail(429, 'app_read_day_full', APP_REFUSALS.app_read_day_full);
      }
      a.read_bytes_today = (a.read_bytes_today ?? 0) + bytes;
      const length = { 'content-length': String(bytes) };
      if (asked !== undefined) {
        return d.raw(206, v.bytes.slice(start, end + 1), {
          ...plain,
          ...length,
          'content-range': `bytes ${start}-${end}/${total}`,
        });
      }
      return d.raw(200, v.bytes, { ...plain, ...length });
    }
    if (path === '/api/v1/apps/changes' && method === 'GET') {
      const limit = limitOf(100);
      if (limit === null) return d.fail(422, 'validation_failed', 'limit is 1 to 100.', 'limit');
      const now = await readable(a);
      refresh(a, now);
      const feed = a.feed ?? [];
      const pruned = a.feed_pruned_to ?? 0;
      const cursor = query.get('cursor');
      const expired = () => d.fail(410, 'cursor_expired', APP_REFUSALS.cursor_expired);
      const after = (seq: number) => feed.some((f) => f.seq > seq);
      const snapshot = cursor === null ? null : /^snap-(\d+)-(\d+)$/.exec(cursor);
      if (cursor === null || snapshot) {
        // Everything it may read now, a page at a time; then the feed from
        // where it stood when the first page was asked.
        const head = snapshot
          ? Number(snapshot[1])
          : Math.max(feed[feed.length - 1]?.seq ?? 0, pruned);
        if (head < pruned) return expired();
        const from = snapshot ? Number(snapshot[2]) : 0;
        const all = [...now.values()].map((r) => r.doc).sort((x, y) => (x.id < y.id ? -1 : 1));
        const page = all.slice(from, from + limit);
        const changes: AppChange[] = page.map((doc) => ({
          change: 'changed',
          at: doc.updated_at,
          document: doc,
        }));
        if (all.length > from + limit) {
          return d.ok({ changes, cursor: `snap-${head}-${from + limit}`, more: true });
        }
        return d.ok({ changes, cursor: `feed-${head}`, more: after(head) });
      }
      const seqOf = /^feed-(\d+)$/.exec(cursor)?.[1];
      if (seqOf === undefined) return d.fail(422, 'validation_failed', 'Not a cursor.', 'cursor');
      const since = Number(seqOf);
      if (since < pruned) return expired();
      const rows = feed.filter((f) => f.seq > since).slice(0, limit);
      const changes: AppChange[] = [];
      for (const f of rows) {
        if (f.change === 'unavailable') {
          changes.push({ change: 'unavailable', at: f.at, document_id: f.id });
          continue;
        }
        const doc = now.get(f.id)?.doc;
        if (doc) changes.push({ change: 'changed', at: f.at, document: doc });
      }
      const last = rows[rows.length - 1]?.seq ?? since;
      return d.ok({ changes, cursor: `feed-${last}`, more: after(last) });
    }
    if (me && method === 'GET') {
      const kinds = d.kinds().filter((k) => a.allowed_kinds.includes(k.key));
      const said: AppMe = {
        app: { id: a.id, name: a.name, created_at: a.created_at },
        state: a.approval === 'waiting' ? 'waiting_for_approval' : a.paused ? 'paused' : 'active',
        ...(a.paused ? { paused_reason: a.paused } : {}),
        // Whom it acts as (APP8), and nothing more of whom.
        acts_as: actsAs(a),
        acting_as: { name: a.member_id ? d.memberName(a.member_id) : a.name },
        vault: {
          instance_id: null,
          server_version: '0.9.0',
          display_name: 'The fake family',
          now: new Date().toISOString(),
          time_zone: d.timezone(),
        },
        scopes: [...scopes],
        send: {
          kinds: kinds.map((k) => ({
            key: k.key,
            label: k.label,
            category: k.category,
            fields: k.fields.map((f) => f.key),
            expires: k.expiry_driver !== null,
          })),
          hints: [...APP_HINTS],
          auto_file: a.auto_file === true,
        },
        read: {
          grants: [...(a.grants ?? [])]
            .sort((x, y) => ((x.kind ?? '~') < (y.kind ?? '~') ? -1 : 1))
            .map((g) =>
              g.kind
                ? { kind: g.kind, lookback_months: g.lookback_months }
                : { category: g.category as string, lookback_months: g.lookback_months },
            ),
        },
        limits: {
          max_upload_bytes: 104_857_600,
          accepted_types: ['application/pdf', 'image/jpeg', 'image/png'],
          files_per_day: a.daily_files,
          files_today: a.files_today,
          bytes_per_day: a.daily_bytes,
          bytes_today: a.bytes_today,
          read_bytes_per_day: a.daily_read_bytes ?? 1024 ** 3,
          read_bytes_today: a.read_bytes_today ?? 0,
          links_per_hour: a.links_per_hour ?? 60,
          requests_per_minute: 120,
          day_resets_at: new Date(Date.now() + 864e5).toISOString(),
        },
        delete_mode: a.delete_mode ?? 'unlink',
        backfill: liveBackfill(a),
        // The key making this request, and nothing of the app's others.
        key: {
          client_id: key.client_id,
          name: key.name,
          permissions: [...key.permissions],
          created_at: key.created_at,
          expires_at: key.expires_at,
          last_used_at: key.last_used_at,
        },
      };
      return d.ok(said);
    }
    if (path === '/api/v1/apps/intake' && method === 'POST') {
      const got = parts(body) ?? [];
      const meta = got[0];
      const file = got[1];
      if (
        !meta ||
        meta.name !== 'metadata' ||
        meta.value === null ||
        !file ||
        file.name !== 'file' ||
        got.length !== 2
      ) {
        return d.fail(
          422,
          'validation_failed',
          'Send exactly two parts: metadata (JSON), then file.',
          'parts',
        );
      }
      let raw: unknown;
      try {
        raw = JSON.parse(meta.value);
      } catch {
        return d.fail(422, 'validation_failed', 'metadata is JSON.', 'metadata');
      }
      const checked = parseAppMetadata(raw);
      if (!checked.ok)
        return d.fail(422, 'validation_failed', checked.problem.message, checked.problem.detail);
      const { external_id: id, hints } = checked.value;
      const bytes = file.bytes ?? new Uint8Array();
      const sum = hex(await sha256(bytes));
      const before = a.intake.get(id);
      if (before && !(before.state === 'refused' || before.removed_reason === 'expired')) {
        if (before.sha256 !== sum) {
          return d.fail(
            409,
            'external_id_conflict',
            'This external_id was already used with other bytes.',
          );
        }
        return d.ok(stateOf(id, before, new Set((await readable(a)).keys()), scopes), 200, {
          'idempotent-replayed': 'true',
        });
      }
      if (hints.kind && !a.allowed_kinds.includes(hints.kind)) {
        a.intake.set(id, {
          state: 'refused',
          removed_reason: null,
          refusal: 'kind_not_allowed',
          sha256: null,
          byte_size: null,
          received_at: null,
        });
        return d.fail(
          422,
          'kind_not_allowed',
          'This app may not send this kind of document.',
          'kind',
        );
      }
      if (a.files_today >= a.daily_files) {
        return d.fail(429, 'app_day_full', 'This app has sent as much as it may today.');
      }
      // Whose Inbox (APP5): the person it is about, by the vault's own rule,
      // when the app sends there; else its own person's.
      const routed =
        a.route_to_person === true
          ? appInboxOf({
              hints,
              kind: d.kinds().find((k) => k.key === hints.kind) ?? null,
              people: d.people?.() ?? [],
              receives: (id) => d.receives?.(id) === true,
            })
          : null;
      // Nothing routes it: its person's Inbox — or, for an app acting as
      // itself (APP8), its reviewer's, while they can take it; else refused
      // for a moment, and the owners told once.
      let inbox = routed ?? a.member_id;
      if (!routed && actsAs(a) === 'app') {
        const reviewer = a.reviewer_member_id ?? null;
        if (!reviewer || d.receives?.(reviewer) !== true) {
          if (!a.reviewer_told) {
            a.reviewer_told = true;
            d.log?.({
              action: 'app.reviewer_needed',
              actorMemberId: null,
              object: null,
              detail: lineOf(a),
            });
          }
          return d.ok(
            {
              error: {
                code: 'busy',
                message: 'The vault was busy just then. Try again.',
                retriable: true,
                request_id: 'fake',
              },
            },
            503,
            { 'retry-after': '1' },
          );
        }
        inbox = reviewer;
        a.reviewer_told = false;
      }
      const s: FakeIntake = {
        state: 'waiting',
        removed_reason: null,
        refusal: null,
        sha256: sum,
        byte_size: bytes.length,
        received_at: new Date().toISOString(),
        ...(inbox ? { inbox_member_id: inbox } : {}),
        as_itself: actsAs(a) === 'app',
        // Kept while it waits, for the fake to file it as the vault would (APP4).
        hints,
        file: {
          bytes,
          filename: file.filename ?? 'file',
          mime: file.type ?? 'application/octet-stream',
        },
      };
      a.intake.set(id, s);
      a.files_today += 1;
      a.bytes_today += bytes.length;
      d.log?.({
        action: 'app.sent',
        actorMemberId: actsAs(a) === 'app' ? null : a.member_id,
        object: inbox,
        detail: lineOf(a),
      });
      return d.ok(stateOf(id, s), 201);
    }
    if (path === '/api/v1/apps/intake' && method === 'GET') {
      const query = target.split('?')[1] ?? '';
      const asked = /(?:^|&)external_ids=([^&]*)/.exec(query)?.[1] ?? '';
      const ids = asked
        .split(',')
        .map((x) => decodeURIComponent(x))
        .filter(Boolean);
      const still = new Set((await readable(a)).keys());
      return d.ok({
        items: ids.flatMap((id) => {
          const s = a.intake.get(id);
          return s ? [stateOf(id, s, still, scopes)] : [];
        }),
        unknown: ids.filter((id) => !a.intake.has(id)),
      });
    }
    // The exact file a send became, again (APP5): counted as its downloads are.
    const sentAt = /^\/api\/v1\/apps\/intake\/([^/]+)\/content$/.exec(path);
    if (sentAt && method === 'GET') {
      const s = a.intake.get(decodeURIComponent(sentAt[1] as string));
      const v = s ? sentFile(s) : null;
      if (!s || !v) return notFound();
      const etag = `"${s.version_id as string}"`;
      const plain = {
        'content-type': v.mime,
        'content-disposition': `attachment; filename="${v.filename.replace(/"/g, '')}"`,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': 'no-store',
        'accept-ranges': 'bytes',
        etag,
      };
      if (headers['if-none-match'] === etag) return d.raw(304, new Uint8Array(), plain);
      const cap = a.daily_read_bytes ?? 1024 ** 3;
      if (v.bytes.length > cap) {
        return d.fail(413, 'larger_than_daily_read', APP_REFUSALS.larger_than_daily_read);
      }
      if ((a.read_bytes_today ?? 0) + v.bytes.length > cap) {
        return d.fail(429, 'app_read_day_full', APP_REFUSALS.app_read_day_full);
      }
      a.read_bytes_today = (a.read_bytes_today ?? 0) + v.bytes.length;
      return d.raw(200, v.bytes, { ...plain, 'content-length': String(v.bytes.length) });
    }
    const one = /^\/api\/v1\/apps\/intake\/([^/]+)$/.exec(path);
    if (one) {
      const id = decodeURIComponent(one[1] as string);
      const s = a.intake.get(id);
      if (!s) return d.fail(404, 'not_found', 'Nothing by that id that this app may see.');
      if (method === 'DELETE' && s.state === 'filed') {
        return d.fail(409, 'already_decided', 'It has been filed already.');
      }
      if (method === 'DELETE' && s.state === 'waiting') {
        s.state = 'removed';
        s.removed_reason = 'withdrawn';
      }
      return d.ok(stateOf(id, s, new Set((await readable(a)).keys()), scopes));
    }
    return d.fail(404, 'not_found', 'Nothing by that id that this app may see.');
  };

  /**
   * What its user's browser asks (APP3): the token's address, which a GET
   * answers with a page that opens nothing and a POST opens (0.9.0-dev.68),
   * once, within two minutes; then the session's cookie on the session's
   * path alone. Each request asks the app's rule again: a document it may
   * no longer read, an app paused or removed, ends it.
   */
  const links = async (
    url: string,
    init: Parameters<FetchLike>[1],
  ): Promise<ResponseLike | null> => {
    const path = url.replace(/^[a-z]+:\/\/[^/]+/i, '').split('?')[0] as string;
    if (!path.startsWith('/api/v1/app-links/')) return null;
    const method = init.method ?? 'GET';
    const tokenAt = /^\/api\/v1\/app-links\/([^/]+)$/.exec(path);
    const opening = method === 'POST' && tokenAt !== null && tokenAt[1] !== 'session';
    if (method !== 'GET' && !opening) return d.fail(404, 'not_found', 'Nothing here.');
    const headers = Object.fromEntries(
      Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const redirect = (to: string, more: Record<string, string> = {}) =>
      d.raw(303, new Uint8Array(), { location: to, ...more });
    const all = () => d.apps.flatMap((a) => (a.links ?? []).map((l) => ({ a, l })));
    const good = async (a: FakeApp, l: FakeAppLink) => {
      // The key it was minted with, live now (APP6): revoking a key ends its links.
      const key = l.key_id === undefined ? undefined : a.keys.find((k) => k.id === l.key_id);
      if (l.key_id !== undefined && (!key || keyState(key) !== 'live')) return null;
      const scopes = (a.scopes ?? APP_SCOPES_DEFAULT).filter(
        (s) => !key || key.permissions.includes(s),
      );
      if (a.revoked || a.paused || a.approval !== 'approved') return null;
      if (!scopes.includes('documents.links') || !scopes.includes('documents.read')) return null;
      if (l.mode === 'download' && !scopes.includes('documents.download')) return null;
      return (await readable(a)).get(l.document_id) ?? null;
    };
    const ended = () => d.fail(410, 'link_ended', APP_REFUSALS.link_ended);
    const inSession = async () => {
      const cookie = /(?:^|;\s*)__Secure-fdv_app_link=([A-Za-z0-9_-]{43})/.exec(
        headers.cookie ?? '',
      )?.[1];
      const found = all().find(
        (x) => cookie && x.l.cookie === cookie && (x.l.session_until ?? 0) > Date.now(),
      );
      if (!found) return null;
      const r = await good(found.a, found.l);
      return r ? { ...found, r } : null;
    };
    if (path === APP_LINK_SESSION_PATH) {
      const s = await inSession();
      if (!s) return ended();
      return d.ok({
        app: s.a.name,
        mode: s.l.mode,
        title: s.r.doc.title,
        pages: s.l.mode === 'view' ? { state: 'ready', count: 1 } : { state: 'none', count: 0 },
        ends_at: new Date(s.l.session_until as number).toISOString(),
        opened_on: new Date(s.l.opened_at ?? Date.now()).toISOString().slice(0, 10),
      });
    }
    const pageAt = /^\/api\/v1\/app-links\/session\/pages\/(\d+)$/.exec(path);
    if (pageAt) {
      const s = await inSession();
      if (!s) return ended();
      if (s.l.mode !== 'view' || pageAt[1] !== '1') {
        return d.fail(404, 'no_preview', 'There is no such page.');
      }
      // The fake draws nothing: a page is a JPEG's first bytes.
      return d.raw(200, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
        'content-type': 'image/jpeg',
        'cache-control': 'private, no-store',
      });
    }
    if (path === `${APP_LINK_SESSION_PATH}/file`) {
      const s = await inSession();
      if (!s) return redirect(`${APP_LINK_PAGE}#ended`);
      // The version it was minted for: the current one then, or the app's own send.
      const v = d.versionOf?.(s.l.version_id) ?? s.r.v;
      if (s.l.mode !== 'download' || !v) return d.fail(404, 'not_found', 'Nothing here.');
      // Counted against the app's own day, as its downloads are.
      const cap = s.a.daily_read_bytes ?? 1024 ** 3;
      if ((s.a.read_bytes_today ?? 0) + v.bytes.length > cap) {
        return redirect(`${APP_LINK_PAGE}#full`);
      }
      s.a.read_bytes_today = (s.a.read_bytes_today ?? 0) + v.bytes.length;
      return d.raw(200, v.bytes, {
        'content-type': v.mime,
        'content-disposition': `attachment; filename="${v.filename.replace(/"/g, '')}"`,
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
        'content-length': String(v.bytes.length),
      });
    }
    const token = tokenAt?.[1] ?? '';
    if (!opening) {
      // The page a link's address gives: it opens nothing, and has no
      // script; its Open button is the open. One the vault could not have
      // made is "ended" at once.
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return redirect(`${APP_LINK_PAGE}#ended`);
      return d.raw(
        200,
        new TextEncoder().encode(
          `<!doctype html><h1>Open the document</h1><p>This link works once: open it here, in this browser.</p><form method="post" action="/api/v1/app-links/${token}"><button type="submit">Open</button></form>`,
        ),
        {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'referrer-policy': 'same-origin',
          'x-robots-tag': 'noindex, nofollow',
          'content-security-policy':
            "default-src 'none'; style-src 'nonce-fake'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        },
      );
    }
    // From anywhere but its own page: refused, and nothing used.
    const site = (headers['sec-fetch-site'] ?? '').toLowerCase();
    const origin = headers.origin;
    if (
      site === 'cross-site' ||
      site === 'same-site' ||
      (origin && origin !== 'null' && !/^https?:\/\/fake\.example(:\d+)?$/.test(origin))
    ) {
      return d.fail(403, 'forbidden', 'Open the link from the app, in the browser it sent you to.');
    }
    const found = all().find((x) => x.l.token === token);
    if (!found) return redirect(`${APP_LINK_PAGE}#ended`);
    const { a, l } = found;
    if (l.opened_at !== null) return redirect(`${APP_LINK_PAGE}#used`);
    if (l.open_by <= Date.now() || !(await good(a, l))) return redirect(`${APP_LINK_PAGE}#ended`);
    const now = Date.now();
    l.opened_at = now;
    l.cookie = toBase64(crypto.getRandomValues(new Uint8Array(32)), true);
    l.session_until = now + APP_LINK_SESSION_MINUTES * 60_000;
    return redirect(l.mode === 'view' ? APP_LINK_PAGE : `${APP_LINK_SESSION_PATH}/file`, {
      'set-cookie': `${APP_LINK_COOKIE}=${l.cookie}; Max-Age=${APP_LINK_SESSION_MINUTES * 60}; Path=${APP_LINK_SESSION_PATH}; HttpOnly; Secure; SameSite=Lax`,
    });
  };

  return { family, app, links };
}
