import { createHash, randomUUID } from 'node:crypto';
import { BlockList, isIP, isIPv4 } from 'node:net';
import type { Readable } from 'node:stream';
import { itemAppHintsBinding, sealBytes } from '@fdv/crypto';
import {
  actAs,
  actAsVault,
  appendAudit,
  householdZone,
  withPrincipal,
  withSystem,
  type Db,
} from '@fdv/db';
import {
  APP_ACTS_AS,
  APP_ACTS_AS_DEFAULT,
  APP_ITSELF_READS_AS,
  APP_BACKFILL_MAX_DAYS,
  APP_CONNECTION_PREFIX,
  APP_DEFAULT_DAILY_BYTES,
  APP_DEFAULT_DAILY_FILES,
  APP_DEFAULT_LINKS_PER_HOUR,
  APP_DELETE_MODES,
  APP_LINKS_PER_HOUR_MAX,
  APP_DEFAULT_READ_BYTES,
  APP_GRANTABLE_CATEGORIES,
  APP_GRANTS_MAX,
  APP_HINTS,
  APP_LOOKBACK_MAX_MONTHS,
  APP_AUTH_FAILURES_PER_MINUTE,
  APP_IP_ALLOW_MAX,
  APP_IP_ALLOW_NAMES_MAX,
  APP_KEY_DAYS_MAX,
  APP_KEY_NAME_MAX,
  APP_KEYS_MAX,
  APP_NEVER_CATEGORIES,
  APP_NAME_MAX,
  APP_REFUSALS,
  APP_REQUESTS_PER_MINUTE,
  APP_SCOPES_DEFAULT,
  APP_SCOPES_OFFERED,
  APP_STATUS_MAX_IDS,
  BATCH_MAX_FILES,
  EXTERNAL_ID_PATTERN,
  INCOMING_KEEP_DAYS,
  NOTE_KIND,
  UPLOAD_KINDS,
  appAllowName,
  appBatchName,
  appInboxOf,
  appSensitiveConfirmWords,
  hintText,
  localToday,
  lockInEffect,
  nextLocalMidnight,
  sealedAppHints,
  seesAdults,
  suspensionInEffect,
  type AppActsAs,
  type AppConnection,
  type AppGrant,
  type AppHints,
  type AppIntakeMetadata,
  type AppIntakeState,
  type AppIntakeStates,
  type AppKeyState,
  type AppKeyView,
  type AppMe,
  type AppScope,
  type AppStateName,
  type ConnectedAppChange,
  type ConnectedAppGrantsInput,
  type ConnectedAppGrantView,
  type ConnectedAppInput,
  type ConnectedAppKeyInput,
  type ConnectedAppKeyMade,
  type ConnectedAppList,
  type ConnectedAppView,
  type Role,
  type Visibility,
} from '@fdv/shared';
import type { FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import type { AlertRequest } from '../alert-job.js';
import type { Principal, RequestMeta } from '../auth/service.js';
import { clientAddressOf } from '../client-address.js';
import { ApiError } from '../errors.js';
import type { DocumentService } from '../documents/service.js';
import type { BatchService } from '../uploads/batches.js';
import { AllowNames, type ResolveFamily } from './allow-names.js';
import { AppAutoFile } from './auto-file.js';
import { AppLinks } from './links.js';
import { appLine } from './lines.js';
import {
  addressBucket,
  newClientId,
  newSecret,
  readBasic,
  secretHash,
  secretMatches,
} from './keys.js';
import { AppReads } from './reads.js';

/**
 * Connected apps (0.9.0, APP1): an owner connects one, and it acts as the
 * one adult it is connected for, with an API key an owner generated (APP6).
 *
 * **The family's side** (Settings → Connected apps, signed in): an owner
 * connects an app — its name, whom it acts as (an owner or an adult with a
 * sign-in), the kinds it may send, who sees what it sends, its day's caps,
 * the addresses it may come from and a backfill allowance — after a
 * passkey or a code (the route's `connect_app`), then generates its API
 * keys, each with its own permissions and validity. One that acts as
 * somebody else waits until they turn it on themselves. Owners see every
 * app and change what it may do; its person sees theirs and may remove it.
 * Nobody else is given any.
 *
 * **The app's side** (`/api/v1/apps/*`, with a key): `authenticate` checks
 * a request in the contract's order, each with its own code — the key
 * (`Authorization: Basic`), the app's and the key's state, its address,
 * https, its person, the route's scope, and its rate. What it
 * sends goes through the batch path a paired computer's does (BatchService:
 * a batch an app a household day, sealed under its person's key), its
 * state kept by external id in connected_app_intake, followed from the
 * Inbox by the database (0109).
 *
 * Refusals are not a line each: the app keeps today's count and the last
 * code, and the first of a day is one notable line.
 */

/** What `authenticate` found: the app, its key and its person, as they are now. */
export interface AppCaller {
  appId: string;
  /** The API key the request came with (APP6). */
  keyId: string;
  householdId: string;
  /**
   * Whom it acts as (APP8): `app`, itself — no person, its own rows the
   * vault's to write on its behalf — or `person`, the one below.
   */
  actsAs: AppActsAs;
  /** The person it acts as: null when it acts as itself. */
  accountId: string | null;
  memberId: string | null;
  /** Its person's role; for an app acting as itself, what it reads as (`APP_ITSELF_READS_AS`). */
  role: Role;
  name: string;
  /** Its person's name; null when it acts as itself. */
  memberName: string | null;
  timezone: string;
  /** What this request may do: the app's scopes that its key has too (APP6). */
  scopes: AppScope[];
  state: AppStateName;
  pausedReason: 'owner' | 'restored' | null;
}

/** Which scope a route needs, and whether it answers an app paused or waiting (`GET /apps/me`). */
export interface AppRoute {
  scope: AppScope | null;
  anyState?: boolean;
}

export interface AppOptions {
  /** FDV_BASE_URL. */
  baseUrl: string;
  /** FDV_PUBLIC_URL, when there is a public-only site. */
  publicUrl: string | null;
  /** FDV_PUBLIC_APPS=on: the app routes are on the public-only site. */
  appsPublic: boolean;
  /** FDV_MAX_UPLOAD_BYTES. */
  maxUploadBytes: number;
  /** FDV_APP_DAILY_FILES and FDV_APP_DAILY_BYTES: the ceilings an owner sets caps up to. */
  ceilings: { files: number; bytes: number };
  serverVersion: string;
  instanceId: () => Promise<string | null>;
  /** Told by email: an app connected to somebody's sign-in, a key an app added. */
  alert: (a: AlertRequest) => Promise<void>;
  /** The clock, for the tests. */
  now?: () => number;
  /** The documents' service (APP2): a download's bytes. Without it, nothing is read. */
  documents?: DocumentService;
  /** The DNS for the names in an allow-list (APP7): Node's resolver, unless a test stands in. */
  resolveName?: ResolveFamily;
}

/** A file an app sends: the multipart part, and what the route knows of the rest of the body. */
export interface AppFile {
  filename: string;
  mime: string;
  stream: Readable;
  truncated: () => boolean;
  /** Reads the body to its end, refusing anything after the file. */
  finished: () => Promise<void>;
}

const STALE_ARRIVAL_MS = 15 * 60_000;
const HOUR = 3_600_000;
const DAY = 864e5;

const err = (status: number, code: keyof typeof APP_REFUSALS, opts: ApiError['options'] = {}) =>
  new ApiError(status, code, APP_REFUSALS[code], opts);
const notFound = () => new ApiError(404, 'not_found', 'Nothing by that id that this app may see.');
const notHere = () => new ApiError(404, 'not_found', 'That app is not here.');
const invalid = (message: string, detail: string) =>
  new ApiError(422, 'validation_failed', message, { detail });
const ownersOnly = () =>
  new ApiError(403, 'forbidden', 'Only an owner can connect an app, or change what it may do.');
const keyLimit = () =>
  new ApiError(
    409,
    'key_limit',
    `An app has ${APP_KEYS_MAX} live API keys at most. Revoke one first.`,
  );
const inProgress = () =>
  new ApiError(
    409,
    'upload_in_progress',
    'This external_id is still arriving. Ask its status after a moment.',
    { retriable: true, retryAfter: 5 },
  );
/** A moment's refusal, sent again later: nothing landed. */
const busy = () =>
  new ApiError(503, 'busy', 'The vault was busy just then. Try again.', {
    retriable: true,
    retryAfter: 1,
  });

/** The owners' email when an app acting as itself has nobody to review what it sends (APP8). */
export function reviewerNeededBody(app: string): string {
  return `${app} acts as itself, and nobody can review what it sends now: the person chosen has left, is locked or paused, or is no longer an adult. Until an owner chooses somebody in Settings → Connected apps, what it sends that isn’t for a particular person is refused for a moment, and ${app} tries again later.`;
}

/** An address in an app's allow-list, as the database keeps them (cidr, as text). */
export function addressAllowed(ip: string | null, allow: readonly string[]): boolean {
  if (allow.length === 0) return true;
  if (!ip) return false;
  const list = new BlockList();
  for (const entry of allow) {
    const [net = '', bits] = entry.split('/');
    const type = isIPv4(net) ? 'ipv4' : 'ipv6';
    list.addSubnet(net, Number(bits ?? (type === 'ipv4' ? 32 : 128)), type);
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (mapped) return list.check(mapped, 'ipv4') || list.check(ip, 'ipv6');
  return list.check(ip, isIPv4(ip) ? 'ipv4' : 'ipv6');
}

/** Whether FDV_BASE_URL is this machine alone, where plain http is taken. */
export function localBase(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Whether a request came from this machine itself: the socket's own
 * address, never a header — a vault on localhost takes plain http only so.
 */
export function loopbackSocket(req: FastifyRequest): boolean {
  const a = req.raw.socket?.remoteAddress ?? '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

/**
 * An allow-list as an owner wrote it (APP7): its addresses and networks, as
 * the database writes cidr, and its names, as `appAllowName` keeps them.
 */
export interface AllowList {
  nets: string[];
  names: string[];
}

/** Whether a network (as the database writes cidr) lies inside one of these. */
function withinAny(net: string, list: readonly string[]): boolean {
  const [addr = '', bits] = net.split('/');
  const type = isIPv4(addr) ? 'ipv4' : 'ipv6';
  const n = Number(bits ?? (type === 'ipv4' ? 32 : 128));
  return list.some((o) => {
    const [oAddr = '', oBits] = o.split('/');
    if ((isIPv4(oAddr) ? 'ipv4' : 'ipv6') !== type) return false;
    const ob = Number(oBits ?? (type === 'ipv4' ? 32 : 128));
    if (n < ob) return false;
    const one = new BlockList();
    one.addSubnet(oAddr, ob, type);
    return one.check(addr, type);
  });
}

/** Who sees what an app sends, narrowest first: "as each kind says" may be anybody. */
const VISIBILITY_RANK: Record<string, number> = { private: 0, adults: 1, household: 2 };
const visibilityRank = (v: string | null | undefined) =>
  v === null || v === undefined ? 3 : (VISIBILITY_RANK[v] ?? 3);

/**
 * Whether a change lets an app do more than it could: a kind added, a cap
 * raised, an address let in, a backfill given or made longer or larger,
 * what it sends seen more widely, filing automatically switched on (for
 * good or for a backfill). Narrowing, or a new name, is not.
 */
function widens(
  app: AppRow,
  set: Record<string, unknown>,
  ip: AllowList | undefined,
  now: number,
): boolean {
  if (Array.isArray(set.allowed_kinds)) {
    if ((set.allowed_kinds as string[]).some((k) => !app.allowed_kinds.includes(k))) return true;
  }
  if (typeof set.daily_files === 'number' && set.daily_files > app.daily_files) return true;
  if (typeof set.daily_bytes === 'number' && set.daily_bytes > Number(app.daily_bytes)) {
    return true;
  }
  // An address, a network wider than one it had, or a name it did not
  // have (APP7: a name may point anywhere), let in; or anywhere at all.
  if (ip !== undefined && app.ip_allow.length + app.ip_allow_names.length > 0) {
    if (ip.nets.length + ip.names.length === 0) return true;
    if (ip.nets.some((n) => !withinAny(n, app.ip_allow))) return true;
    if (ip.names.some((n) => !app.ip_allow_names.includes(n))) return true;
  }
  if (
    typeof set.daily_read_bytes === 'number' &&
    set.daily_read_bytes > Number(app.daily_read_bytes)
  ) {
    return true;
  }
  if (Array.isArray(set.scopes)) {
    if ((set.scopes as string[]).some((k) => !app.scopes.includes(k))) return true;
  }
  // Its deletes moving papers to the Trash, or more links an hour (APP3).
  if (set.delete_mode === 'trash' && app.delete_mode !== 'trash') return true;
  if (typeof set.links_per_hour === 'number' && set.links_per_hour > app.links_per_hour) {
    return true;
  }
  if ('default_visibility' in set) {
    if (
      visibilityRank(set.default_visibility as string | null) >
      visibilityRank(app.default_visibility)
    ) {
      return true;
    }
  }
  if (set.backfill_until instanceof Date) {
    const had = app.backfill_until && app.backfill_until.getTime() > now;
    if (
      !had ||
      set.backfill_until.getTime() > (app.backfill_until as Date).getTime() ||
      (set.backfill_files as number) > (app.backfill_files ?? 0) ||
      (set.backfill_bytes as number) > Number(app.backfill_bytes ?? 0) ||
      // Filing automatically for the window, where it did not (APP4).
      (set.backfill_auto_file === true && !app.backfill_auto_file)
    ) {
      return true;
    }
  }
  // Filing what it sends with nobody looking (APP4).
  if (set.auto_file === true && !app.auto_file) return true;
  // What it sends into other people's Inboxes than its person's (APP5).
  if (set.route_to_person === true && !app.route_to_person) return true;
  return false;
}

/**
 * A connection string: `fdvapp2.` and base64url of its JSON — the vault's
 * address and a key's client ID, and its secret only when the owner chose
 * so as the key was shown.
 */
export function connectionString(c: AppConnection): string {
  return `${APP_CONNECTION_PREFIX}${Buffer.from(JSON.stringify(c), 'utf8').toString('base64url')}`;
}

interface AppRow {
  id: string;
  name: string;
  /** Itself, or a person (APP8). */
  acts_as: AppActsAs;
  account_id: string | null;
  member_id: string | null;
  /** Who reviews what nothing routes, when it acts as itself (APP8). */
  reviewer_member_id: string | null;
  reviewer_told_at: Date | null;
  approval: 'waiting' | 'approved';
  scopes: string[];
  allowed_kinds: string[];
  default_visibility: Visibility | null;
  auto_file: boolean;
  daily_files: number;
  daily_bytes: string;
  backfill_until: Date | null;
  backfill_files: number | null;
  backfill_bytes: string | null;
  backfill_auto_file: boolean;
  ip_allow: string[];
  /** Host names (APP7). */
  ip_allow_names: string[];
  paused_reason: 'owner' | 'restored' | null;
  revoked_at: Date | null;
  last_used_at: Date | null;
  use_day: string | null;
  files_today: number;
  bytes_today: string;
  refused_on: string | null;
  refused_today: number;
  last_refusal: string | null;
  created_at: Date;
  daily_read_bytes: string;
  read_day: string | null;
  read_bytes_today: string;
  delete_mode: 'unlink' | 'trash';
  links_per_hour: number;
  route_to_person: boolean;
}

const APP_COLUMNS = [
  'a.id',
  'a.name',
  'a.acts_as',
  'a.account_id',
  'a.member_id',
  'a.reviewer_member_id',
  'a.reviewer_told_at',
  'a.approval',
  'a.scopes',
  'a.allowed_kinds',
  'a.default_visibility',
  'a.auto_file',
  'a.daily_files',
  'a.daily_bytes',
  'a.backfill_until',
  'a.backfill_files',
  'a.backfill_bytes',
  'a.backfill_auto_file',
  sql<string[]>`a.ip_allow::text[]`.as('ip_allow'),
  'a.ip_allow_names',
  'a.paused_reason',
  'a.revoked_at',
  'a.last_used_at',
  sql<string | null>`a.use_day::text`.as('use_day'),
  'a.files_today',
  'a.bytes_today',
  sql<string | null>`a.refused_on::text`.as('refused_on'),
  'a.refused_today',
  'a.last_refusal',
  'a.created_at',
  'a.daily_read_bytes',
  sql<string | null>`a.read_day::text`.as('read_day'),
  'a.read_bytes_today',
  'a.delete_mode',
  'a.links_per_hour',
  'a.route_to_person',
] as const;

interface KeyRow {
  id: string;
  app_id: string;
  client_id: string;
  name: string | null;
  permissions: string[];
  created_at: Date;
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
  revoked_reason: 'owner' | 'app_removed' | 'restore' | 'creator' | null;
}

/** A key's columns, as Settings lists it: never its secret's hash. */
const KEY_COLUMNS = [
  'id',
  'app_id',
  'client_id',
  'name',
  'permissions',
  'created_at',
  'expires_at',
  'last_used_at',
  'revoked_at',
  'revoked_reason',
] as const;

interface IntakeRow {
  id: string;
  external_id: string;
  state: 'arriving' | 'waiting' | 'filed' | 'refused' | 'removed';
  removed_reason: 'withdrawn' | 'declined' | 'expired' | null;
  refusal: 'kind_not_allowed' | 'unsupported_type' | 'too_large' | null;
  sha256: Buffer | null;
  byte_size: string | null;
  incoming_file_id: string | null;
  document_id: string | null;
  version_id: string | null;
  started_at: Date;
  received_at: Date | null;
  decided_at: Date | null;
  hints_sealed: Buffer | null;
  /** Let go of by the app (APP3): its document is no longer its own. */
  unlinked_at?: Date | null;
  /** Whose Inbox it went to (APP5); null: the app's person's. Never told to the app. */
  inbox_member_id?: string | null;
  /** The app's person; null for an app acting as itself (APP8). */
  member_id?: string | null;
  /** Sent as the app itself (APP8): a file of it filed names the app. */
  as_itself?: boolean;
}

/**
 * The state an app is answered for what it sent, as `POST /apps/intake`
 * answers it. Filed, and no longer readable by the app (APP2): unavailable,
 * never why — nor which document. Whether its own file can be downloaded
 * again (APP5): by `sent`, the external ids whose can.
 */
function stateOf(
  r: IntakeRow,
  readable: ReadonlySet<string> | null = null,
  sent: ReadonlySet<string> | null = null,
): AppIntakeState {
  const content_available = r.state === 'filed' && sent !== null && sent.has(r.external_id);
  // Let go of by the app (APP3), or no longer readable by it: unavailable.
  const gone =
    r.unlinked_at != null || (readable && !(r.document_id && readable.has(r.document_id)));
  if (r.state === 'filed' && gone) {
    return {
      external_id: r.external_id,
      state: 'unavailable',
      received_at: r.received_at ? r.received_at.toISOString() : null,
      sha256: r.sha256 ? r.sha256.toString('hex') : null,
      byte_size: r.byte_size === null ? null : Number(r.byte_size),
      document_id: null,
      version_id: null,
      filed_at: null,
      removed_reason: null,
      refusal: null,
      content_available,
    };
  }
  return {
    external_id: r.external_id,
    state: r.state === 'arriving' ? 'waiting' : r.state,
    received_at: r.received_at ? r.received_at.toISOString() : null,
    sha256: r.sha256 ? r.sha256.toString('hex') : null,
    byte_size: r.byte_size === null ? null : Number(r.byte_size),
    document_id: r.state === 'filed' ? r.document_id : null,
    version_id: r.state === 'filed' ? r.version_id : null,
    filed_at: r.state === 'filed' && r.decided_at ? r.decided_at.toISOString() : null,
    removed_reason: r.removed_reason,
    refusal: r.refusal,
    content_available,
  };
}

/** Whether an app works now, and why not. */
function appState(a: Pick<AppRow, 'approval' | 'paused_reason'>): AppStateName {
  if (a.approval === 'waiting') return 'waiting_for_approval';
  return a.paused_reason ? 'paused' : 'active';
}

/** The day's caps in effect: the backfill allowance's while it lasts. */
function capsOf(a: AppRow, now: number): { files: number; bytes: number; backfill: boolean } {
  if (a.backfill_until && a.backfill_until.getTime() > now) {
    return {
      files: a.backfill_files ?? a.daily_files,
      bytes: Number(a.backfill_bytes ?? a.daily_bytes),
      backfill: true,
    };
  }
  return { files: a.daily_files, bytes: Number(a.daily_bytes), backfill: false };
}

/** What it sent today: nothing, on a day it has not sent. */
function today(a: Pick<AppRow, 'use_day' | 'files_today' | 'bytes_today'>, day: string) {
  return a.use_day === day
    ? { files: a.files_today, bytes: Number(a.bytes_today) }
    : { files: 0, bytes: 0 };
}

/** Whether a key works now: not revoked, and not past its expiry. */
function keyState(k: Pick<KeyRow, 'revoked_at' | 'expires_at'>, now: number): AppKeyState {
  if (k.revoked_at) return 'revoked';
  return k.expires_at && k.expires_at.getTime() <= now ? 'expired' : 'live';
}

/** An app's key, as Settings lists it: never its secret, nor its hash. */
function keyView(k: KeyRow, now: number): AppKeyView {
  return {
    id: k.id,
    client_id: k.client_id,
    name: k.name,
    permissions: APP_SCOPES_OFFERED.filter((s) => k.permissions.includes(s)),
    created_at: k.created_at.toISOString(),
    expires_at: k.expires_at ? k.expires_at.toISOString() : null,
    last_used_at: k.last_used_at ? k.last_used_at.toISOString() : null,
    revoked_at: k.revoked_at ? k.revoked_at.toISOString() : null,
    revoked_reason: k.revoked_reason,
    state: keyState(k, now),
  };
}

export class AppService {
  /** Requests each app made this minute: the rate. */
  private readonly rate = new Map<string, { minute: number; n: number }>();
  /** Failed authentications from each address this minute (APP6). */
  private readonly failures: { minute: number; counts: Map<string, number> } = {
    minute: -1,
    counts: new Map(),
  };
  /** What an app reads (APP2). */
  readonly reads: AppReads | null;
  /** Its links and deletes (APP3). */
  readonly links: AppLinks | null;
  /** What it sends, filed automatically when sure and complete (APP4): the API's one consumer. */
  readonly autoFile: AppAutoFile;
  /** The names in allow-lists, looked up and cached (APP7). */
  private readonly names: AllowNames;

  constructor(
    private readonly db: Db,
    private readonly batches: BatchService,
    private readonly opts: AppOptions,
  ) {
    this.reads = opts.documents
      ? new AppReads(db, { documents: opts.documents, now: () => this.now() })
      : null;
    this.links =
      opts.documents && this.reads
        ? new AppLinks(db, {
            reads: this.reads,
            documents: opts.documents,
            address: () => this.address().url,
          })
        : null;
    this.autoFile = new AppAutoFile(db, batches, { now: () => this.now() });
    this.names = new AllowNames({
      ...(opts.resolveName ? { resolve: opts.resolveName } : {}),
      now: () => this.now(),
    });
  }

  /**
   * Whether a request's address is one an app may come from (APP7): any,
   * when its list is empty; else within one of its addresses or networks,
   * or one of the addresses a name of it points to now — an IPv6 address
   * exactly, as the name lists it. A name that cannot be looked up lets
   * nothing in. The names already known are asked first; the rest are
   * looked up at once, and the first that matches answers, never waiting
   * for a slower one.
   */
  private async fromAllowed(
    ip: string | null,
    allow: readonly string[],
    names: readonly string[],
  ): Promise<boolean> {
    if (allow.length === 0 && names.length === 0) return true;
    if (!ip) return false;
    if (allow.length > 0 && addressAllowed(ip, allow)) return true;
    const matches = (addresses: string[] | null) =>
      !!addresses && addresses.length > 0 && addressAllowed(ip, addresses);
    const unknown: string[] = [];
    for (const n of names) {
      const known = this.names.fresh(n);
      if (known === undefined) unknown.push(n);
      else if (matches(known)) return true;
    }
    if (unknown.length === 0) return false;
    return new Promise<boolean>((resolve) => {
      let left = unknown.length;
      const done = (yes: boolean) => {
        left -= 1;
        if (yes) resolve(true);
        else if (left === 0) resolve(false);
      };
      for (const n of unknown) {
        this.names.addresses(n).then(
          (a) => done(matches(a)),
          () => done(false),
        );
      }
    });
  }

  /** Which filed documents of these the app may still read: null while nothing is read. */
  private async readableOf(c: AppCaller, rows: readonly IntakeRow[]): Promise<Set<string> | null> {
    if (!this.reads) return null;
    const ids = rows.flatMap((r) => (r.state === 'filed' && r.document_id ? [r.document_id] : []));
    return this.reads.stillReadable(c, ids);
  }

  /**
   * Which of these sends' own files the app may download again (APP5), by
   * external id: null while nothing is read.
   */
  private async sentOf(c: AppCaller, rows: readonly IntakeRow[]): Promise<Set<string> | null> {
    // Never "available" where the route would answer 403: it needs the download scope.
    if (!this.reads || !c.scopes.includes('documents.download')) return null;
    const ids = rows.flatMap((r) =>
      r.state === 'filed' && !r.unlinked_at && r.version_id ? [r.external_id] : [],
    );
    return this.reads.sentAvailable(c, ids);
  }

  /** What became of a send, as the app is answered it (APP2, APP5): readable, and its file again. */
  private async stateFor(c: AppCaller, row: IntakeRow): Promise<AppIntakeState> {
    return stateOf(row, await this.readableOf(c, [row]), await this.sentOf(c, [row]));
  }

  /**
   * Whose Inbox a send goes to (APP5), when the app sends each paper to the
   * person it is about: the person its hint names — by id, or a name that
   * matches one person of the family — when they are an owner or an adult
   * of the household who signs in and may act now. Null for anything else,
   * and, for an app acting as a person, that person themselves. Asked as
   * its person (as the vault, for an app acting as itself, APP8): the family
   * as they may file for it, and the kind as the household has it.
   */
  private async inboxOf(c: AppCaller, app: AppRow, hints: AppHints): Promise<Principal | null> {
    if (!app.route_to_person || !hints.person || 'household' in hints.person) return null;
    return this.ownRows(c, async (trx) => {
      const kind = hints.kind
        ? await trx
            .selectFrom('effective_document_type')
            .select('belongs_to')
            .where('key', '=', hints.kind)
            .where('deleted_at', 'is', null)
            .executeTakeFirst()
        : undefined;
      const family = await trx
        .selectFrom('member')
        .select(['id', 'display_name'])
        .where('kind', '=', 'family')
        .execute();
      const signIns = await trx
        .selectFrom('account_household')
        .select([
          'account_id',
          'member_id',
          'role',
          'suspended_at',
          'suspended_until',
          'suspend_reason',
        ])
        .where('household_id', '=', c.householdId)
        .execute();
      const by = new Map(signIns.map((r) => [r.member_id, r]));
      const to = appInboxOf({
        hints,
        kind: kind ?? null,
        people: family.map((m) => ({ id: m.id, name: m.display_name })),
        receives: (id) => {
          const r = by.get(id);
          return (
            r !== undefined &&
            (r.role === 'owner' || r.role === 'adult') &&
            !lockInEffect(r) &&
            !suspensionInEffect(r)
          );
        },
      });
      const r = to && to !== c.memberId ? by.get(to) : undefined;
      if (!r) return null;
      return {
        accountId: r.account_id,
        sessionId: '',
        householdId: c.householdId,
        memberId: r.member_id,
        role: r.role,
        seesAdults: seesAdults(r.role, null),
      };
    });
  }

  /**
   * The person who reviews what an app acting as itself sends that nothing
   * routes (APP8), as they are now, to send to: an owner or an adult of the
   * family with a sign-in here, neither locked nor paused. Null when it has
   * none, or the one it has cannot take it now.
   */
  private async reviewerOf(c: AppCaller, app: AppRow): Promise<Principal | null> {
    const id = app.reviewer_member_id;
    if (!id) return null;
    const r = await this.ownRows(c, (trx) =>
      trx
        .selectFrom('account_household as ah')
        .innerJoin('member as m', (j) =>
          j.onRef('m.id', '=', 'ah.member_id').onRef('m.household_id', '=', 'ah.household_id'),
        )
        .select([
          'ah.account_id',
          'ah.member_id',
          'ah.role',
          'ah.suspended_at',
          'ah.suspended_until',
          'ah.suspend_reason',
        ])
        .where('ah.household_id', '=', c.householdId)
        .where('ah.member_id', '=', id)
        .where('m.kind', '=', 'family')
        .executeTakeFirst(),
    );
    if (!r || (r.role !== 'owner' && r.role !== 'adult')) return null;
    if (lockInEffect(r) || suspensionInEffect(r)) return null;
    return {
      accountId: r.account_id,
      sessionId: '',
      householdId: c.householdId,
      memberId: r.member_id,
      role: r.role,
      seesAdults: seesAdults(r.role, null),
    };
  }

  /**
   * An app acting as itself has nobody who can review what it sends (APP8):
   * the owners are told, once — a line in the activity log and an email —
   * to choose somebody. Told again only once a reviewer has been chosen, or
   * has taken a send, since.
   */
  private async reviewerNeeded(c: AppCaller): Promise<void> {
    const told = await this.ownRows(c, async (trx) => {
      const a = await trx
        .updateTable('connected_app')
        .set({ reviewer_told_at: sql<Date>`now()` })
        .where('id', '=', c.appId)
        .where('acts_as', '=', 'app')
        .where('reviewer_told_at', 'is', null)
        .where('revoked_at', 'is', null)
        .returning(['name'])
        .executeTakeFirst();
      if (!a) return null;
      await appendAudit(trx, {
        householdId: c.householdId,
        action: 'app.reviewer_needed',
        objectType: 'member',
        objectId: null,
        detail: { app_id: c.appId, app: a.name, as_itself: true },
      });
      return { name: a.name, owners: await this.owners(trx) };
    }).catch(() => null);
    if (!told) return;
    await this.opts
      .alert({
        householdId: c.householdId,
        accountIds: told.owners,
        subject: `Choose who reviews what ${told.name} sends`,
        body: reviewerNeededBody(told.name),
        emailOnly: true,
      })
      .catch(() => undefined);
  }

  /**
   * The person a send went to (APP5), as they are now, to act as: their
   * sign-in in this household. Null when they have none any more.
   */
  private async personOf(c: AppCaller, memberId: string): Promise<Principal | null> {
    const r = await this.ownRows(c, (trx) =>
      trx
        .selectFrom('account_household')
        .select(['account_id', 'member_id', 'role'])
        .where('household_id', '=', c.householdId)
        .where('member_id', '=', memberId)
        .executeTakeFirst(),
    );
    if (!r) return null;
    return {
      accountId: r.account_id,
      sessionId: '',
      householdId: c.householdId,
      memberId: r.member_id,
      role: r.role,
      seesAdults: seesAdults(r.role, null),
    };
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** The address an app must use: the public-only site's when apps are published there. */
  private address(): { url: string; public: boolean } {
    const pub = this.opts.appsPublic && this.opts.publicUrl;
    return pub
      ? { url: (this.opts.publicUrl as string).replace(/\/+$/, ''), public: true }
      : { url: this.opts.baseUrl.replace(/\/+$/, ''), public: false };
  }

  /**
   * The person an app acts as, as the batches see them: asking as
   * themselves, with no session. Only for an app acting as a person.
   */
  private principalOf(c: AppCaller): Principal {
    if (c.actsAs !== 'person' || !c.accountId || !c.memberId) {
      throw new Error('an app acting as itself has no person');
    }
    return {
      accountId: c.accountId,
      sessionId: '',
      householdId: c.householdId,
      memberId: c.memberId,
      role: c.role,
      seesAdults: seesAdults(c.role, null),
    };
  }

  /**
   * The app's own rows — what became of its sends, its caps, its lines in
   * the activity log — in a transaction of their own: as its person, for an
   * app acting as one; as the vault, on its behalf, for an app acting as
   * itself (APP8), which has no person and no account standing in for one.
   */
  private ownRows<T>(c: AppCaller, fn: (trx: Db) => Promise<T>): Promise<T> {
    return c.actsAs === 'person'
      ? withPrincipal(this.db, this.principalOf(c), fn)
      : withSystem(this.db, c.householdId, fn);
  }

  /**
   * The app's own rows inside the transaction of the person whose Inbox its
   * file goes to (APP5, APP8): as its own person, when that is somebody
   * else; as the vault, for an app acting as itself; or just so, when the
   * Inbox is its person's own.
   */
  private asAppIn(
    c: AppCaller,
    inbox: Principal,
  ): <T>(trx: Db, fn: (trx: Db) => Promise<T>) => Promise<T> {
    if (c.actsAs === 'app') return (trx, fn) => actAsVault(trx, fn);
    const p = this.principalOf(c);
    return inbox.memberId === p.memberId && inbox.accountId === p.accountId
      ? (trx, fn) => fn(trx)
      : (trx, fn) => actAs(trx, p, fn);
  }

  // ------------------------------------------------------------ API keys

  /**
   * A request's API key (APP6), checked in the order the contract gives,
   * each refusal with its own code: `Authorization: Basic` and no other
   * credential; an address that has failed too often this minute waits; the
   * client ID and its secret, compared in constant time, an unknown ID and
   * a wrong secret alike (`app_key_invalid`); the app removed, the key
   * revoked, the key expired; then as before — the app on and turned on,
   * its address, https, its person, the route's scope (the app's and the
   * key's both) and its rate. Nothing is cached: a key revoked is refused
   * on the very next request. Answers the app and its person as they are now.
   */
  async authenticate(req: FastifyRequest, route: AppRoute): Promise<{ caller: AppCaller }> {
    const h = req.headers;
    const now = this.now();
    const minute = Math.floor(now / 60_000);
    // 1. Basic, and nothing else that names a caller: no cookie, no bearer token.
    const creds = readBasic(h);
    if (creds.kind === 'none' || (h.cookie !== undefined && /\S/.test(h.cookie))) {
      throw err(401, 'app_key_required');
    }
    // 2. An address that keeps failing waits for its minute to end, before
    // anything is looked up.
    // An IPv6 address by its /64. This minute's counts alone are kept: at a
    // minute's turn the map is swapped for an empty one.
    const address = addressBucket(clientAddressOf(req) ?? '-');
    if (this.failures.minute !== minute) {
      this.failures.minute = minute;
      this.failures.counts = new Map();
    }
    const counts = this.failures.counts;
    if ((counts.get(address) ?? 0) >= APP_AUTH_FAILURES_PER_MINUTE) {
      const wait = Math.max(1, Math.ceil(((minute + 1) * 60_000 - now) / 1000));
      throw new ApiError(
        429,
        'rate_limited',
        `Too many requests with a key that did not work. Try again in ${wait} seconds.`,
        { retriable: true, retryAfter: wait },
      );
    }
    // Only a guess counts: an unknown client ID or a wrong secret. A right
    // secret — whatever is refused after it — is no guessing.
    const failed = (): void => {
      counts.set(address, (counts.get(address) ?? 0) + 1);
    };
    // 3. A key the vault made, and its secret: the same work, and the same
    // answer, for an unknown client ID as for a wrong secret.
    const found =
      creds.kind === 'basic'
        ? (
            await sql<{
              household_id: string;
              app_id: string;
              key_id: string;
              secret_hash: Buffer;
              permissions: string[];
              expires_at: Date | null;
              key_revoked: boolean;
              revoked: boolean;
              paused_reason: 'owner' | 'restored' | null;
              approval: 'waiting' | 'approved';
              ip_allow: string[];
              ip_allow_names: string[];
            }>`select household_id, app_id, key_id, secret_hash, permissions, expires_at,
                      key_revoked, revoked, paused_reason, approval, ip_allow, ip_allow_names
                 from connected_app_find(${creds.clientId})`.execute(this.db)
          ).rows[0]
        : undefined;
    const genuine = secretMatches(creds.kind === 'basic' ? creds.secret : '', found?.secret_hash);
    if (!found || !genuine) {
      failed();
      throw err(401, 'app_key_invalid');
    }
    const at = found;
    // From here the request is truly the app's: a refusal is counted on it.
    const refuse = async (e: ApiError): Promise<never> => {
      await this.noteRefusal(at.household_id, at.app_id, e.code).catch(() => undefined);
      throw e;
    };
    // 4. The app removed, then the key revoked or past its expiry.
    if (at.revoked) throw err(401, 'app_revoked');
    if (at.key_revoked) await refuse(err(401, 'app_key_revoked'));
    if (at.expires_at && at.expires_at.getTime() <= now) {
      await refuse(err(401, 'app_key_expired'));
    }
    // 5. On, and turned on by its person — but for GET /apps/me.
    if (!route.anyState) {
      if (at.paused_reason) await refuse(err(403, 'app_paused'));
      if (at.approval !== 'approved') await refuse(err(403, 'app_not_approved'));
    }
    // 6. From an address it may come from: one of its list, or one a name
    // of it points to now (APP7).
    if (
      !(await this.fromAllowed(clientAddressOf(req), at.ip_allow ?? [], at.ip_allow_names ?? []))
    ) {
      await refuse(err(403, 'address_not_allowed'));
    }
    // 7. Over https, as the trusted proxies say; plain http only for a vault
    // on this machine, asked from this machine: its address and the socket.
    if (req.protocol !== 'https' && !(localBase(this.opts.baseUrl) && loopbackSocket(req))) {
      await refuse(err(403, 'https_required'));
    }
    // 8. The key's use and the app's noted, and the app and its person
    // read as they are now.
    const app = await withSystem(this.db, at.household_id, async (trx) => {
      await trx
        .updateTable('connected_app_key')
        .set({ last_used_at: sql<Date>`now()` })
        .where('id', '=', at.key_id)
        .execute();
      await trx
        .updateTable('connected_app')
        .set({ last_used_at: sql<Date>`now()` })
        .where('id', '=', at.app_id)
        .execute();
      return trx
        .selectFrom('connected_app as a')
        .leftJoin('member as m', (j) =>
          j.onRef('m.id', '=', 'a.member_id').onRef('m.household_id', '=', 'a.household_id'),
        )
        .innerJoin('household as hh', 'hh.id', 'a.household_id')
        .leftJoin('account_household as ah', (j) =>
          j
            .onRef('ah.account_id', '=', 'a.account_id')
            .onRef('ah.household_id', '=', 'a.household_id'),
        )
        .select([
          'a.name',
          'a.scopes',
          'a.acts_as',
          'a.account_id',
          'a.member_id',
          'a.approval',
          'a.paused_reason',
          'a.revoked_at',
          'm.display_name',
          'hh.timezone',
          'ah.role',
          'ah.suspended_at',
          'ah.suspended_until',
          'ah.suspend_reason',
        ])
        .where('a.id', '=', at.app_id)
        .executeTakeFirst();
    });
    if (!app || app.revoked_at !== null) throw err(401, 'app_revoked');
    // An app acting as itself (APP8) has no person: its being live, and its
    // key, are what it is asked. One acting as a person asks theirs.
    const itself = app.acts_as === 'app';
    let role: Role = APP_ITSELF_READS_AS;
    if (!itself) {
      if (!app.role || !['owner', 'adult'].includes(app.role) || !app.account_id) {
        throw err(401, 'app_revoked');
      }
      role = app.role;
      // 9. Its person may act now.
      const person = {
        suspend_reason: app.suspend_reason ?? null,
        suspended_at: app.suspended_at ?? null,
        suspended_until: app.suspended_until ?? null,
      };
      if (lockInEffect(person)) await refuse(err(403, 'member_locked'));
      if (suspensionInEffect(person)) await refuse(err(403, 'member_paused'));
    }
    // 10. The route is in what the app may do and in what this key may:
    // both, as they are now.
    const scopes = APP_SCOPES_OFFERED.filter(
      (s) => app.scopes.includes(s) && at.permissions.includes(s),
    );
    if (route.scope && !scopes.includes(route.scope)) {
      await refuse(err(403, 'scope_not_granted'));
    }
    // And its rate: so many requests a minute, whichever key.
    const r = this.rate.get(at.app_id);
    const n = r && r.minute === minute ? r.n + 1 : 1;
    this.rate.set(at.app_id, { minute, n });
    if (n > APP_REQUESTS_PER_MINUTE) {
      const wait = Math.max(1, Math.ceil(((minute + 1) * 60_000 - now) / 1000));
      await refuse(
        new ApiError(
          429,
          'rate_limited',
          `Too many requests at once. Try again in ${wait} seconds.`,
          {
            retriable: true,
            retryAfter: wait,
          },
        ),
      );
    }
    return {
      caller: {
        appId: at.app_id,
        keyId: at.key_id,
        householdId: at.household_id,
        actsAs: itself ? 'app' : 'person',
        accountId: itself ? null : app.account_id,
        memberId: itself ? null : app.member_id,
        role,
        name: app.name,
        memberName: itself ? null : (app.display_name ?? null),
        timezone: householdZone(app.timezone),
        scopes,
        state: appState(app),
        pausedReason: app.paused_reason,
      },
    };
  }

  /**
   * A refusal, counted on the app: today's count and the last code;
   * the first of a household day is one notable line. Never a line each,
   * so a stranger with an app id cannot flood the log.
   */
  private async noteRefusal(householdId: string, appId: string, code: string): Promise<void> {
    await withSystem(this.db, householdId, async (trx) => {
      const hh = await trx.selectFrom('household').select('timezone').executeTakeFirstOrThrow();
      const day = localToday(householdZone(hh.timezone), new Date(this.now()));
      const row = await trx
        .updateTable('connected_app')
        .set({
          refused_today: sql<number>`case when refused_on = ${day}::date then refused_today + 1 else 1 end`,
          refused_on: day,
          last_refusal: code.slice(0, 64),
        })
        .where('id', '=', appId)
        .where('revoked_at', 'is', null)
        .returning(['refused_today', 'member_id', 'name'])
        .executeTakeFirst();
      if (row?.refused_today === 1) {
        await appendAudit(trx, {
          householdId,
          action: 'app.refused_today',
          objectType: 'member',
          objectId: row.member_id,
          detail: { app_id: appId, app: row.name, code },
        });
      }
    });
  }

  // ------------------------------------------------------------ GET /me

  /** `GET /apps/me`: the connection test, and what this app may do. */
  async me(c: AppCaller): Promise<AppMe> {
    const now = this.now();
    const { app, key, kinds, household, grants } = await withSystem(
      this.db,
      c.householdId,
      async (trx) => {
        const app = await trx
          .selectFrom('connected_app as a')
          .select(APP_COLUMNS)
          .where('a.id', '=', c.appId)
          .executeTakeFirstOrThrow();
        // The key this request came with, and none of the app's others.
        const key = await trx
          .selectFrom('connected_app_key')
          .select(KEY_COLUMNS)
          .where('id', '=', c.keyId)
          .executeTakeFirstOrThrow();
        const kinds =
          app.allowed_kinds.length === 0
            ? []
            : await trx
                .selectFrom('effective_document_type')
                .select(['key', 'label', 'category', 'fields', 'expiry_driver'])
                .where('key', 'in', app.allowed_kinds)
                .where('deleted_at', 'is', null)
                .where('key', '<>', NOTE_KIND)
                .orderBy('label')
                .execute();
        const household = await trx
          .selectFrom('household')
          .select(['name'])
          .executeTakeFirstOrThrow();
        const grants = await trx
          .selectFrom('connected_app_grant')
          .select(['kind_key', 'category', 'lookback_months'])
          .where('app_id', '=', c.appId)
          .orderBy('kind_key')
          .orderBy('category')
          .execute();
        return { app, key, kinds, household, grants };
      },
    );
    const readToday = app.read_day === localToday(c.timezone, new Date(now));
    const day = localToday(c.timezone, new Date(now));
    const caps = capsOf(app, now);
    const sent = today(app, day);
    return {
      app: { id: app.id, name: app.name, created_at: app.created_at.toISOString() },
      state: c.state,
      ...(c.pausedReason ? { paused_reason: c.pausedReason } : {}),
      // Whom it acts as (APP8), and nothing more of whom: an app acting as
      // itself is named for itself.
      acts_as: c.actsAs,
      acting_as: { name: c.memberName ?? app.name },
      vault: {
        instance_id: await this.opts.instanceId().catch(() => null),
        server_version: this.opts.serverVersion,
        display_name: household.name,
        now: new Date(now).toISOString(),
        time_zone: c.timezone,
      },
      scopes: c.scopes,
      send: {
        kinds: kinds.map((k) => ({
          key: k.key,
          label: k.label,
          category: k.category,
          fields: ((k.fields as Array<{ key?: unknown }> | null) ?? [])
            .map((f) => (typeof f?.key === 'string' ? f.key : null))
            .filter((f): f is string => f !== null),
          expires: k.expiry_driver !== null,
        })),
        hints: [...APP_HINTS],
        auto_file: app.auto_file,
      },
      ...(this.reads
        ? {
            read: {
              grants: grants.map((g): AppGrant =>
                g.kind_key
                  ? { kind: g.kind_key, lookback_months: g.lookback_months }
                  : { category: g.category as string, lookback_months: g.lookback_months },
              ),
            },
          }
        : {}),
      ...(this.links ? { delete_mode: app.delete_mode } : {}),
      limits: {
        max_upload_bytes: this.opts.maxUploadBytes,
        accepted_types: Object.keys(UPLOAD_KINDS),
        files_per_day: caps.files,
        files_today: sent.files,
        bytes_per_day: caps.bytes,
        bytes_today: sent.bytes,
        read_bytes_per_day: Number(app.daily_read_bytes ?? APP_DEFAULT_READ_BYTES),
        read_bytes_today: readToday ? Number(app.read_bytes_today) : 0,
        links_per_hour: app.links_per_hour ?? APP_DEFAULT_LINKS_PER_HOUR,
        requests_per_minute: APP_REQUESTS_PER_MINUTE,
        day_resets_at: nextLocalMidnight(c.timezone, new Date(now)).toISOString(),
      },
      backfill: caps.backfill
        ? {
            until: (app.backfill_until as Date).toISOString(),
            files_per_day: caps.files,
            bytes_per_day: caps.bytes,
            auto_file: app.backfill_auto_file,
          }
        : null,
      key: {
        client_id: key.client_id,
        name: key.name,
        permissions: APP_SCOPES_OFFERED.filter((s) => key.permissions.includes(s)),
        created_at: key.created_at.toISOString(),
        expires_at: key.expires_at ? key.expires_at.toISOString() : null,
        last_used_at: key.last_used_at ? key.last_used_at.toISOString() : null,
      },
    };
  }

  // ------------------------------------------------------------- intake

  /** Seconds to the household's next midnight: when a full day is not full any more. */
  private toMidnight(c: AppCaller): number {
    const now = this.now();
    return Math.max(
      1,
      Math.ceil((nextLocalMidnight(c.timezone, new Date(now)).getTime() - now) / 1000),
    );
  }

  private dayFull(c: AppCaller): ApiError {
    return err(429, 'app_day_full', { retriable: true, retryAfter: this.toMidnight(c) });
  }

  /**
   * The app still live, held while what it sends is written: one revoked,
   * paused or let go meanwhile lands nothing. Its row as it is now.
   */
  private async live(trx: Db, c: AppCaller): Promise<AppRow> {
    const a = (await trx
      .selectFrom('connected_app as a')
      .select(APP_COLUMNS)
      .where('a.id', '=', c.appId)
      .forNoKeyUpdate()
      .executeTakeFirst()) as AppRow | undefined;
    if (!a || a.revoked_at) throw err(401, 'app_revoked');
    if (a.paused_reason) throw err(403, 'app_paused');
    if (a.approval !== 'approved') throw err(403, 'app_not_approved');
    // Whom it acts as changed since the request was let in (APP8): sent
    // again, it is answered as the app is then — never written as it was.
    if (
      a.acts_as !== c.actsAs ||
      (c.actsAs === 'person' && (a.member_id !== c.memberId || a.account_id !== c.accountId))
    ) {
      throw busy();
    }
    return a;
  }

  /**
   * Today's batch of this app's, on the household's calendar, with room in
   * it: "From Acme Money, 16 November 2026", and a part more past BATCH_MAX_FILES.
   * As its person; the database lets a batch name only a live app of its
   * own member (0109). Who sees what it sends is the app's default.
   *
   * Sent to the person it is about (APP5): that person's batch, one an app
   * a person a day, made as them — the database lets a batch name an app
   * that routes for an owner or an adult of the family (0113) — with the
   * app's row held as its own person (`asApp`).
   */
  private async appBatch(
    p: Principal,
    c: AppCaller,
    day: string,
    past = 0,
    asApp: <T>(trx: Db, fn: (trx: Db) => Promise<T>) => Promise<T> = (trx, fn) => fn(trx),
  ): Promise<string> {
    return withPrincipal(this.db, p, async (trx) => {
      const app = await asApp(trx, (t) => this.live(t, c));
      const parts = await trx
        .selectFrom('intake_batch as b')
        .select(['b.id', 'b.app_part', 'b.default_visibility'])
        .select((eb) =>
          eb
            .selectFrom('incoming_file as f')
            .select((e) => e.fn.countAll<string>().as('n'))
            .whereRef('f.batch_id', '=', 'b.id')
            .where((e) =>
              e.or([
                e('f.state', 'in', ['received', 'accepted']),
                e.and([
                  e('f.state', '=', 'uploading'),
                  e('f.created_at', '>', new Date(this.now() - STALE_ARRIVAL_MS)),
                ]),
              ]),
            )
            .as('n'),
        )
        .where('b.app_id', '=', c.appId)
        .where('b.member_id', '=', p.memberId)
        .where('b.app_day', '=', day)
        .orderBy('b.app_part')
        .execute();
      const last = parts[parts.length - 1];
      if (last && Number(last.n ?? 0) < BATCH_MAX_FILES && (last.app_part ?? 0) > past) {
        // An owner narrowed who sees what it sends since today's batch was
        // made: the batch is narrowed with it, never widened.
        if (visibilityRank(app.default_visibility) < visibilityRank(last.default_visibility)) {
          await trx
            .updateTable('intake_batch')
            .set({ default_visibility: app.default_visibility })
            .where('id', '=', last.id)
            .execute();
        }
        return last.id;
      }
      const part = Math.max(past, last?.app_part ?? 0) + 1;
      const now = new Date(this.now());
      const made = await trx
        .insertInto('intake_batch')
        .values({
          household_id: c.householdId,
          created_by: p.accountId,
          member_id: p.memberId,
          name: appBatchName(app.name, day, part).slice(0, 200),
          default_visibility: app.default_visibility,
          app_id: c.appId,
          app_day: day,
          app_part: part,
          created_at: now,
          ends_at: new Date(now.getTime() + INCOMING_KEEP_DAYS * DAY),
        })
        .onConflict((oc) => oc.constraint('intake_batch_app_day_key').doNothing())
        .returning('id')
        .executeTakeFirst();
      if (made) return made.id;
      const meanwhile = await trx
        .selectFrom('intake_batch')
        .select('id')
        .where('app_id', '=', c.appId)
        .where('member_id', '=', p.memberId)
        .where('app_day', '=', day)
        .where('app_part', '=', part)
        .executeTakeFirst();
      if (!meanwhile) {
        throw new ApiError(503, 'busy', 'The vault was busy just then. Try again.', {
          retriable: true,
          retryAfter: 1,
        });
      }
      return meanwhile.id;
    });
  }

  /** Whether the app may send this kind, and the household has it. */
  private async kindAllowed(c: AppCaller, app: AppRow, kind: string): Promise<boolean> {
    if (!app.allowed_kinds.includes(kind)) return false;
    const t = await this.ownRows(c, (trx) =>
      trx
        .selectFrom('effective_document_type')
        .select('key')
        .where('key', '=', kind)
        .where('deleted_at', 'is', null)
        .executeTakeFirst(),
    );
    return t !== undefined && kind !== NOTE_KIND;
  }

  /**
   * `POST /apps/intake`: one file into an Inbox — the person it is about's
   * (APP5), its person's, or, for an app acting as itself, its reviewer's
   * (APP8) — or, for an external id sent before, what became of it.
   * Answered only once its bytes are stored and checked and its row
   * committed: from then the vault has it, and a restart loses nothing.
   */
  async send(
    c: AppCaller,
    metadata: AppIntakeMetadata,
    file: AppFile,
    meta: RequestMeta,
  ): Promise<{ status: 200 | 201; state: AppIntakeState }> {
    const { external_id: externalId, hints } = metadata;

    // The external id claimed, or what it was answered before.
    type Claim =
      | { kind: 'new'; id: string; prior: IntakeRow | null; app: AppRow }
      | { kind: 'replay'; row: IntakeRow };
    // This send's own token: every write it makes names it, so once a later
    // send has taken the id over, this one changes nothing.
    const attempt = randomUUID();
    const claim: Claim = await this.ownRows(c, async (trx) => {
      const app = await this.live(trx, c);
      const row = (await trx
        .selectFrom('connected_app_intake')
        .selectAll()
        .where('app_id', '=', c.appId)
        .where('external_id', '=', externalId)
        .forUpdate()
        .executeTakeFirst()) as IntakeRow | undefined;
      const fresh = {
        state: 'arriving' as const,
        removed_reason: null,
        refusal: null,
        sha256: null,
        byte_size: null,
        incoming_file_id: null,
        document_id: null,
        version_id: null,
        hints_sealed: null,
        received_at: null,
        decided_at: null,
        started_at: sql<Date>`now()`,
        attempt,
        inbox_member_id: null,
        // Whose send it is: its person's, or nobody's for an app acting as
        // itself (APP8) — the vault's to keep on its behalf; and so whose
        // file it is, as it was sent: the app's own when it acted as itself.
        member_id: c.memberId,
        as_itself: c.actsAs === 'app',
      };
      if (!row) {
        // Two first sends at once: the second finds the first's row, and is
        // told it is still arriving.
        const made = await trx
          .insertInto('connected_app_intake')
          .values({
            household_id: c.householdId,
            app_id: c.appId,
            external_id: externalId,
            ...fresh,
          })
          .onConflict((oc) => oc.constraint('connected_app_intake_one').doNothing())
          .returning('id')
          .executeTakeFirst();
        if (!made) throw inProgress();
        return { kind: 'new', id: made.id, prior: null, app };
      }
      if (row.state === 'arriving') {
        if (row.started_at.getTime() > this.now() - STALE_ARRIVAL_MS) throw inProgress();
      } else if (!(
        row.state === 'refused' ||
        (row.state === 'removed' && row.removed_reason === 'expired')
      )) {
        return { kind: 'replay', row };
      }
      // Refused, or expired undecided: the id is free again, whatever bytes come.
      await trx.updateTable('connected_app_intake').set(fresh).where('id', '=', row.id).execute();
      return { kind: 'new', id: row.id, prior: row.state === 'arriving' ? null : row, app };
    });

    if (claim.kind === 'replay') {
      // Its bytes read, never kept, and compared with the first send's.
      const hash = createHash('sha256');
      file.stream.on('data', (chunk: Buffer) => hash.update(chunk));
      await new Promise<void>((resolve, reject) => {
        file.stream.once('end', resolve);
        file.stream.once('error', reject);
        file.stream.resume();
      }).catch(() => undefined);
      await file.finished();
      if (!claim.row.sha256 || !hash.digest().equals(claim.row.sha256)) {
        throw err(409, 'external_id_conflict');
      }
      return { status: 200, state: await this.stateFor(c, claim.row) };
    }

    // What became of a send that did not land: put back as it was.
    const letGo = async () => {
      await this.ownRows(c, async (trx) => {
        if (claim.prior) {
          const was = claim.prior;
          await trx
            .updateTable('connected_app_intake')
            .set({
              state: was.state,
              removed_reason: was.removed_reason,
              refusal: was.refusal,
              sha256: was.sha256,
              byte_size: was.byte_size,
              incoming_file_id: was.incoming_file_id,
              document_id: was.document_id,
              version_id: was.version_id,
              hints_sealed: was.hints_sealed,
              started_at: was.started_at,
              received_at: was.received_at,
              decided_at: was.decided_at,
              inbox_member_id: was.inbox_member_id ?? null,
              member_id: was.member_id ?? null,
              as_itself: was.as_itself ?? false,
            })
            .where('id', '=', claim.id)
            .where('state', '=', 'arriving')
            .where('attempt', '=', attempt)
            .execute();
        } else {
          await trx
            .deleteFrom('connected_app_intake')
            .where('id', '=', claim.id)
            .where('state', '=', 'arriving')
            .where('attempt', '=', attempt)
            .execute();
        }
      }).catch(() => undefined);
    };
    const refused = async (refusal: 'kind_not_allowed' | 'unsupported_type' | 'too_large') => {
      await this.ownRows(c, (trx) =>
        trx
          .updateTable('connected_app_intake')
          .set({ state: 'refused', refusal, decided_at: sql<Date>`now()`, hints_sealed: null })
          .where('id', '=', claim.id)
          .where('state', '=', 'arriving')
          .where('attempt', '=', attempt)
          .execute(),
      ).catch(() => undefined);
    };
    const drain = async () => {
      file.stream.resume();
      await new Promise<void>((resolve) => {
        if (file.stream.readableEnded) resolve();
        else {
          file.stream.once('end', () => resolve());
          file.stream.once('error', () => resolve());
          file.stream.once('close', () => resolve());
        }
      });
      await file.finished();
    };

    // A kind it may not send: refused — a record of the refusal kept, never
    // the file or what the app said of it.
    if (hints.kind && !(await this.kindAllowed(c, claim.app, hints.kind))) {
      try {
        await drain();
      } catch (e) {
        await letGo();
        throw e;
      }
      await refused('kind_not_allowed');
      throw err(422, 'kind_not_allowed', { detail: 'kind' });
    }

    // A day already full is refused before a byte is kept.
    const now = this.now();
    const day = localToday(c.timezone, new Date(now));
    const caps = capsOf(claim.app, now);
    const sentToday = today(claim.app, day);
    if (sentToday.files >= caps.files || sentToday.bytes >= caps.bytes) {
      await letGo();
      throw this.dayFull(c);
    }

    // Whose Inbox it goes to (APP5): the person it is about, as their own
    // upload, the app's rows written as its own person in the same
    // transaction; else its own person's, as always — or, for an app acting
    // as itself (APP8), its reviewer's, its rows the vault's on its behalf.
    let to: Principal | null;
    let inbox: Principal;
    try {
      to = await this.inboxOf(c, claim.app, hints);
      if (to) inbox = to;
      else if (c.actsAs === 'person') inbox = this.principalOf(c);
      else {
        const reviewer = await this.reviewerOf(c, claim.app);
        // Nobody who can review it now: refused for a moment, and the
        // owners told, once, to choose somebody. The app is not removed.
        if (!reviewer) {
          await this.reviewerNeeded(c);
          throw busy();
        }
        inbox = reviewer;
      }
    } catch (e) {
      await letGo();
      throw e;
    }
    /** Sent to its reviewer, as nothing routed it (APP8). */
    const toReviewer = c.actsAs === 'app' && !to;
    const asApp = this.asAppIn(c, inbox);
    // The reviewer let go of, or changed, since it was chosen above.
    let reviewerGone = false;

    let sha: Buffer | null = null;
    let batchId: string | undefined;
    /**
     * The file whole and stored: within the day's caps, counted with the app
     * held, so two files at once never pass them together; said waiting; and
     * the activity log's line — as the app's own person, whoever's Inbox it
     * went to (the line names that Inbox's person), or as the vault for an
     * app acting as itself, the line naming the app alone (APP8).
     */
    const arrived = async (trx: Db, bytes: number): Promise<void> => {
      const app = await this.live(trx, c);
      const at = this.now();
      const d = localToday(c.timezone, new Date(at));
      const cap = capsOf(app, at);
      const sent = today(app, d);
      if (sent.files + 1 > cap.files || sent.bytes + bytes > cap.bytes) {
        throw this.dayFull(c);
      }
      await trx
        .updateTable('connected_app')
        .set({
          use_day: d,
          files_today: sent.files + 1,
          bytes_today: sent.bytes + bytes,
          last_used_at: sql<Date>`now()`,
          // Its reviewer took a send: told again, should they no longer can.
          ...(toReviewer && app.reviewer_told_at ? { reviewer_told_at: null } : {}),
        })
        .where('id', '=', c.appId)
        .execute();
      const landed = await trx
        .updateTable('connected_app_intake')
        .set({
          state: 'waiting',
          sha256: sha,
          byte_size: bytes,
          received_at: sql<Date>`now()`,
        })
        .where('id', '=', claim.id)
        .where('state', '=', 'arriving')
        .where('attempt', '=', attempt)
        .returning('id')
        .executeTakeFirst();
      // Taken over by a later send while its bytes came: its item is thrown
      // away, and the later send's stands.
      if (!landed) throw inProgress();
      await appendAudit(trx, {
        householdId: c.householdId,
        actorAccountId: c.accountId,
        action: 'app.sent',
        objectType: 'member',
        objectId: inbox.memberId,
        detail: appLine(c),
        ip: meta.ip,
      });
    };
    try {
      let past = 0;
      for (let tries = 0; ; tries++) {
        batchId = await this.appBatch(inbox, c, day, past, asApp);
        try {
          await this.batches.addItem(
            inbox,
            batchId,
            {
              filename: file.filename,
              mime: file.mime,
              // An app's file is never a health record kept as it is (H5).
              records: false,
              // Nobody is there to see it land: a paused sign-in is refused too (APP5).
              paused: true,
              stream: file.stream,
              truncated: file.truncated,
              finished: file.finished,
              stillAllowed: async (trx) => {
                // The app, and its own person as they are now — whoever's
                // Inbox it goes to (APP5): a lock or a pause since it was sent
                // lands nothing. An app acting as itself has no person; sent
                // to its reviewer, they are still its reviewer (APP8).
                await asApp(trx, async (t) => {
                  const app = await this.live(t, c);
                  if (c.actsAs === 'person') await this.personActs(t, c);
                  else if (toReviewer && app.reviewer_member_id !== inbox.memberId) {
                    reviewerGone = true;
                    throw busy();
                  }
                });
              },
              made: (trx, item) =>
                asApp(trx, async (trx) => {
                  const sealed =
                    Object.keys(hints).length > 0
                      ? sealBytes(
                          item.fileKey,
                          Buffer.from(sealedAppHints(hints), 'utf8'),
                          itemAppHintsBinding(item.id),
                        )
                      : null;
                  const tied = await trx
                    .updateTable('connected_app_intake')
                    .set({
                      incoming_file_id: item.id,
                      hints_sealed: sealed,
                      inbox_member_id: inbox.memberId,
                    })
                    .where('id', '=', claim.id)
                    .where('state', '=', 'arriving')
                    .where('attempt', '=', attempt)
                    .returning('id')
                    .executeTakeFirst();
                  // Taken over by a later send: this one makes no item.
                  if (!tied) throw inProgress();
                }),
              hashed: (h) => {
                sha = h;
              },
              arrived: (trx, bytes) => asApp(trx, (trx) => arrived(trx, bytes)),
            },
            meta,
          );
          break;
        } catch (e) {
          // Filled meanwhile by files sent at once: the next part.
          if (e instanceof ApiError && e.code === 'batch_full' && tries < 3) {
            past = await this.partOf(inbox, batchId);
            continue;
          }
          throw e;
        }
      }
    } catch (caught) {
      // The person it was going to can no longer have it (locked, paused,
      // their role changed) since it was routed (APP5), or its reviewer
      // since they were found (APP8): nothing landed, and sent again it goes
      // where the rule says then.
      const e =
        (to || toReviewer) && caught instanceof ApiError && caught.code === 'forbidden'
          ? busy()
          : caught;
      if (toReviewer && (reviewerGone || e !== caught)) await this.reviewerNeeded(c);
      if (batchId) await this.batches.dropIfEmpty(inbox, batchId).catch(() => undefined);
      if (e instanceof ApiError && e.code === 'too_large') {
        await refused('too_large');
      } else if (e instanceof ApiError && e.code === 'unsupported_type') {
        // Refused for what its bytes are: so said, once the body is known whole.
        const whole = await drain().then(
          () => true,
          () => false,
        );
        if (whole) await refused('unsupported_type');
        else await letGo();
      } else {
        await letGo();
      }
      throw e;
    }
    const row = await this.ownRows(c, (trx) =>
      trx
        .selectFrom('connected_app_intake')
        .selectAll()
        .where('id', '=', claim.id)
        .executeTakeFirstOrThrow(),
    );
    return { status: 201, state: stateOf(row) };
  }

  /**
   * The app's own person, as they are now, inside a send's transaction:
   * still an owner or an adult here, neither locked nor paused. Read after
   * the app's row is held. A send to somebody else's Inbox (APP5) is that
   * person's upload, so their own checks are not this person's. An app
   * acting as itself (APP8) has none.
   */
  private async personActs(trx: Db, c: AppCaller): Promise<void> {
    if (!c.accountId || !c.memberId) throw err(401, 'app_revoked');
    const me = await trx
      .selectFrom('account_household')
      .select(['role', 'suspended_at', 'suspended_until', 'suspend_reason'])
      .where('account_id', '=', c.accountId)
      .where('household_id', '=', c.householdId)
      .where('member_id', '=', c.memberId)
      .executeTakeFirst();
    if (!me || (me.role !== 'owner' && me.role !== 'adult')) throw err(401, 'app_revoked');
    if (lockInEffect(me)) throw err(403, 'member_locked');
    if (suspensionInEffect(me)) throw err(403, 'member_paused');
  }

  /** Which part of the day a batch is. */
  private async partOf(p: Principal, batchId: string): Promise<number> {
    const b = await withPrincipal(this.db, p, (trx) =>
      trx
        .selectFrom('intake_batch')
        .select('app_part')
        .where('id', '=', batchId)
        .executeTakeFirst(),
    );
    return b?.app_part ?? 0;
  }

  /**
   * Polling is one line an hour an app: "checked on files it sent",
   * written only when the last was more than an hour ago.
   */
  private async checked(c: AppCaller, trx: Db, meta: RequestMeta): Promise<void> {
    const due = await trx
      .updateTable('connected_app')
      .set({ checked_line_at: sql<Date>`now()` })
      .where('id', '=', c.appId)
      .where((eb) =>
        eb.or([
          eb('checked_line_at', 'is', null),
          eb('checked_line_at', '<', new Date(this.now() - HOUR)),
        ]),
      )
      .returning('id')
      .executeTakeFirst();
    if (due) {
      await appendAudit(trx, {
        householdId: c.householdId,
        actorAccountId: c.accountId,
        action: 'app.checked',
        objectType: 'member',
        objectId: c.memberId,
        detail: appLine(c),
        ip: meta.ip,
      });
    }
  }

  /** `GET /apps/intake/{external_id}`: what became of it; one never sent, or still arriving, is 404. */
  async status(c: AppCaller, externalId: string, meta: RequestMeta): Promise<AppIntakeState> {
    if (!EXTERNAL_ID_PATTERN.test(externalId)) throw notFound();
    const row = await this.ownRows(c, async (trx) => {
      const row = (await trx
        .selectFrom('connected_app_intake')
        .selectAll()
        .where('app_id', '=', c.appId)
        .where('external_id', '=', externalId)
        .executeTakeFirst()) as IntakeRow | undefined;
      if (!row || row.state === 'arriving') throw notFound();
      await this.checked(c, trx, meta);
      return row;
    });
    return this.stateFor(c, row);
  }

  /** `GET /apps/intake?external_ids=`: up to 100 at once, and those never sent. */
  async statuses(c: AppCaller, ids: string[], meta: RequestMeta): Promise<AppIntakeStates> {
    if (ids.length === 0 || ids.length > APP_STATUS_MAX_IDS) {
      throw invalid(`Ask for 1 to ${APP_STATUS_MAX_IDS} external_ids at a time.`, 'external_ids');
    }
    const bad = ids.find((id) => !EXTERNAL_ID_PATTERN.test(id));
    if (bad !== undefined) throw invalid('That is not an external_id.', 'external_ids');
    const asked = [...new Set(ids)];
    const rows = await this.ownRows(c, async (trx) => {
      const rows = (await trx
        .selectFrom('connected_app_intake')
        .selectAll()
        .where('app_id', '=', c.appId)
        .where('external_id', 'in', asked)
        .where('state', '<>', 'arriving')
        .execute()) as IntakeRow[];
      await this.checked(c, trx, meta);
      return rows;
    });
    const readable = await this.readableOf(c, rows);
    const sent = await this.sentOf(c, rows);
    const by = new Map(rows.map((r) => [r.external_id, r]));
    return {
      items: asked.flatMap((id) => {
        const r = by.get(id);
        return r ? [stateOf(r, readable, sent)] : [];
      }),
      unknown: asked.filter((id) => !by.has(id)),
    };
  }

  /**
   * `DELETE /apps/intake/{external_id}`: a waiting item taken out of the
   * Inbox, as its person's Remove would, and said `withdrawn`. A filed one
   * is `409 already_decided`; one removed or refused already is answered
   * as it is. One sent to the Inbox of somebody else than its person —
   * the person it is about (APP5), or the reviewer of an app acting as
   * itself (APP8) — is taken out of theirs, as them, the send's row and the
   * activity log's line written as the app's own person (as the vault, for
   * an app acting as itself) in the same transaction.
   */
  async withdraw(c: AppCaller, externalId: string, meta: RequestMeta): Promise<AppIntakeState> {
    if (!EXTERNAL_ID_PATTERN.test(externalId)) throw notFound();
    const read = () =>
      this.ownRows(c, async (trx) => {
        const row = (await trx
          .selectFrom('connected_app_intake')
          .selectAll()
          .where('app_id', '=', c.appId)
          .where('external_id', '=', externalId)
          .executeTakeFirst()) as IntakeRow | undefined;
        return row;
      });
    const row = await read();
    if (!row || row.state === 'arriving') throw notFound();
    if (row.state === 'filed') {
      throw new ApiError(
        409,
        'already_decided',
        'It has been filed already. To remove a filed document, delete it.',
      );
    }
    if (row.state !== 'waiting') return this.stateFor(c, row);
    const itemId = row.incoming_file_id;
    if (!itemId) throw notFound();
    // Whose Inbox it is in: its own person's, or the person it went to.
    const elsewhere = row.inbox_member_id ?? null;
    const to = elsewhere && elsewhere !== c.memberId ? await this.personOf(c, elsewhere) : null;
    if (c.actsAs === 'app' ? !to : elsewhere && elsewhere !== c.memberId && !to) {
      throw notFound();
    }
    const inbox = to ?? this.principalOf(c);
    const item = await withPrincipal(this.db, inbox, (trx) =>
      trx
        .selectFrom('incoming_file')
        .select('batch_id')
        .where('id', '=', itemId)
        .executeTakeFirst(),
    );
    if (!item?.batch_id) throw notFound();
    const asApp = this.asAppIn(c, inbox);
    await this.batches.removeItem(inbox, item.batch_id, itemId, meta, (trx) =>
      asApp(trx, async (trx) => {
        const out = await trx
          .updateTable('connected_app_intake')
          .set({
            state: 'removed',
            removed_reason: 'withdrawn',
            decided_at: sql<Date>`now()`,
            hints_sealed: null,
          })
          .where('id', '=', row.id)
          .where('state', '=', 'waiting')
          .returning('id')
          .executeTakeFirst();
        if (!out) {
          throw new ApiError(409, 'already_decided', 'It has been filed or removed already.');
        }
        await appendAudit(trx, {
          householdId: c.householdId,
          actorAccountId: c.accountId,
          action: 'app.withdrawn',
          objectType: 'member',
          objectId: inbox.memberId,
          detail: appLine(c),
          ip: meta.ip,
        });
      }),
    );
    const after = await read();
    if (!after) throw notFound();
    return stateOf(after);
  }

  // ---------------------------------------------------------- the keys

  /** The household's owners' sign-ins, for the emails about an app's keys. */
  private async owners(trx: Db): Promise<string[]> {
    const rows = await trx
      .selectFrom('account_household')
      .select('account_id')
      .where('role', '=', 'owner')
      .execute();
    return rows.map((o) => o.account_id);
  }

  /** A key revoked: the owners and the person the app acts as are told, by email. */
  private async keyRevokedAlert(
    householdId: string,
    accountIds: string[],
    app: string,
    member: string,
    clientId: string,
  ): Promise<void> {
    await this.opts
      .alert({
        householdId,
        accountIds: [...new Set(accountIds)],
        subject: `An API key of ${app} was revoked`,
        body: `The API key ${clientId} of ${app} was revoked; ${app} acts as ${member}. Whatever uses that key is refused from its next request. If you did not expect this, look at Settings → Connected apps.`,
        emailOnly: true,
      })
      .catch(() => undefined);
  }

  /**
   * An owner widened what an app acting as somebody else may do, or gave it
   * a key: it waits again until that person turns it on, with their own
   * passkey or code, so an owner never acts as another adult unseen. Inside
   * the change's transaction; whether it now waits. An app acting as itself
   * (APP8) acts as nobody: an owner's change is the owners' to make.
   */
  private async reapprove(
    trx: Db,
    p: Principal,
    app: { id: string; member_id: string | null; acts_as: AppActsAs },
  ): Promise<boolean> {
    if (app.acts_as !== 'person' || app.member_id === p.memberId) return false;
    const out = await trx
      .updateTable('connected_app')
      .set({ approval: 'waiting', approved_at: null })
      .where('id', '=', app.id)
      .where('approval', '=', 'approved')
      .returning('id')
      .executeTakeFirst();
    return out !== undefined;
  }

  /** Its person told that an app acting as them waits for them again. */
  private async askAgain(householdId: string, accountId: string, app: string): Promise<void> {
    await this.opts
      .alert({
        householdId,
        accountIds: [accountId],
        subject: `${app} waits for you to turn it on again`,
        body: `An owner changed what ${app} may do as you, or gave it a new key. It does nothing until you turn it on again in Settings → Connected apps. If you did not expect this, remove it there.`,
        emailOnly: true,
      })
      .catch(() => undefined);
  }

  /** A person told that an app was connected to act as them, and waits for them. */
  private async askFirst(householdId: string, accountId: string, app: string): Promise<void> {
    await this.opts
      .alert({
        householdId,
        accountIds: [accountId],
        subject: `${app} was connected to your sign-in`,
        body: `An owner connected ${app} to act as you: it can send documents into your Inbox. It does nothing until you turn it on in Settings → Connected apps. If you did not expect this, remove it there.`,
        emailOnly: true,
      })
      .catch(() => undefined);
  }

  /**
   * A person told, once, that they review what an app acting as itself
   * sends (APP8): its papers that are for nobody in particular come to their
   * Inbox. They are not asked to turn anything on.
   */
  private async toldReviewer(householdId: string, accountId: string, app: string): Promise<void> {
    await this.opts
      .alert({
        householdId,
        accountIds: [accountId],
        subject: `You’ll review what ${app} sends`,
        body: `An owner chose you to review what ${app} sends: what it sends that isn’t for a particular person comes to your Inbox, to file or remove. If you did not expect this, ask an owner to choose somebody else in Settings → Connected apps.`,
        emailOnly: true,
      })
      .catch(() => undefined);
  }

  // --------------------------------------------- the family's side (Settings)

  /** Whom an app may act as: an owner or an adult with a sign-in here. */
  private async actingMember(
    trx: Db,
    memberId: string,
    field = 'member_id',
  ): Promise<{ account_id: string; display_name: string }> {
    const m = await trx
      .selectFrom('account_household as ah')
      .innerJoin('member as m', (j) =>
        j.onRef('m.id', '=', 'ah.member_id').onRef('m.household_id', '=', 'ah.household_id'),
      )
      .select(['ah.account_id', 'm.display_name'])
      .where('ah.member_id', '=', memberId)
      .where('ah.role', 'in', ['owner', 'adult'])
      .where('m.kind', '=', 'family')
      .executeTakeFirst();
    if (!m) {
      throw invalid(
        field === 'member_id'
          ? 'An app acts as an owner or an adult who signs in.'
          : 'An app’s papers are reviewed by an owner or an adult who signs in.',
        field,
      );
    }
    return m;
  }

  /**
   * Whom an app is to act as, as an owner connects or changes it (APP8):
   * itself, with a reviewer — the one named, else the one it has, else the
   * owner asking — or a person, the one named, else the one it has. A
   * `member_id` without `acts_as` is a person, as it was before APP8.
   */
  private async whom(
    trx: Db,
    p: Principal,
    input: { acts_as?: unknown; member_id?: unknown; reviewer_member_id?: unknown },
    had: Pick<AppRow, 'acts_as' | 'member_id' | 'account_id' | 'reviewer_member_id'> | null,
  ): Promise<{
    acts_as: AppActsAs;
    account_id: string | null;
    member_id: string | null;
    reviewer_member_id: string | null;
    /** The person it acts as, or its reviewer: their sign-in and name. */
    person: { account_id: string; display_name: string };
  }> {
    // Left unsaid: a person named means a person (as before APP8), a
    // reviewer named means itself; else as it was, or itself for a new one.
    const asked =
      input.acts_as ??
      (input.member_id !== undefined
        ? 'person'
        : input.reviewer_member_id !== undefined
          ? 'app'
          : (had?.acts_as ?? APP_ACTS_AS_DEFAULT));
    if (!(APP_ACTS_AS as readonly unknown[]).includes(asked)) {
      throw invalid('An app acts as itself or as a person.', 'acts_as');
    }
    const actsAs = asked as AppActsAs;
    if (actsAs === 'person') {
      if (input.reviewer_member_id !== undefined) {
        throw invalid(
          'An app acting as a person has no reviewer: its person reviews.',
          'reviewer_member_id',
        );
      }
      const member =
        typeof input.member_id === 'string'
          ? input.member_id
          : had?.acts_as === 'person'
            ? had.member_id
            : null;
      if (!member) throw invalid('Choose whom it acts as.', 'member_id');
      const person = await this.actingMember(trx, member);
      return {
        acts_as: 'person',
        account_id: person.account_id,
        member_id: member,
        reviewer_member_id: null,
        person,
      };
    }
    if (input.member_id !== undefined) {
      throw invalid('An app acting as itself acts as nobody: choose who reviews it.', 'member_id');
    }
    const reviewer =
      typeof input.reviewer_member_id === 'string'
        ? input.reviewer_member_id
        : had?.acts_as === 'app' && had.reviewer_member_id
          ? had.reviewer_member_id
          : p.memberId;
    const person = await this.actingMember(trx, reviewer, 'reviewer_member_id');
    return {
      acts_as: 'app',
      account_id: null,
      member_id: null,
      reviewer_member_id: reviewer,
      person,
    };
  }

  /** Kinds, checked: each a kind the household has. */
  private async checkedKinds(trx: Db, kinds: string[]): Promise<string[]> {
    const want = [...new Set(kinds)];
    if (want.length > 200) throw invalid('200 kinds at most.', 'allowed_kinds');
    if (want.length === 0) return [];
    const found = await trx
      .selectFrom('effective_document_type')
      .select(['key', 'label', 'category', 'usually_essential'])
      .where('key', 'in', want)
      .where('deleted_at', 'is', null)
      .where('key', '<>', NOTE_KIND)
      .execute();
    if (found.length !== want.length) {
      throw invalid('Each kind must be one the household has.', 'allowed_kinds');
    }
    // Never an identity, legal or medical paper, nor a kind kept as an
    // Essential: an app is never given those to send, whatever an owner ticks.
    const never = found.find(
      (t) => APP_NEVER_CATEGORIES.includes(t.category) || t.usually_essential === true,
    );
    if (never) {
      throw invalid(
        `An app may not send ${never.label}: it is never given that kind.`,
        'allowed_kinds',
      );
    }
    return want;
  }

  /**
   * Addresses, networks and host names (APP7), checked and written as the
   * database keeps them: the networks as cidr, the names as `appAllowName`
   * keeps them. Ten entries at most, all told; five names of them.
   */
  private async checkedAddresses(trx: Db, list: string[]): Promise<AllowList> {
    if (list.length > APP_IP_ALLOW_MAX) {
      throw invalid(`${APP_IP_ALLOW_MAX} addresses, networks or names at most.`, 'ip_allow');
    }
    const nets: string[] = [];
    const names = new Set<string>();
    for (const entry of list) {
      const [net = '', bits, more] = entry.trim().split('/');
      const v = isIP(net);
      const max = v === 4 ? 32 : 128;
      // Not an address: a host name, or nothing the list takes.
      const name = v === 0 && bits === undefined ? appAllowName(entry) : null;
      if (name) {
        names.add(name);
        continue;
      }
      if (
        v === 0 ||
        more !== undefined ||
        (bits !== undefined && (!/^\d{1,3}$/.test(bits) || Number(bits) > max))
      ) {
        throw invalid(
          `“${entry}” is not an address, a network or a host name (203.0.113.7, 203.0.113.0/24, 2001:db8::/64, feeds.example.com).`,
          'ip_allow',
        );
      }
      nets.push(entry.trim());
    }
    if (names.size > APP_IP_ALLOW_NAMES_MAX) {
      throw invalid(`${APP_IP_ALLOW_NAMES_MAX} names at most.`, 'ip_allow');
    }
    if (nets.length === 0) return { nets: [], names: [...names].sort() };
    const out = await sql<{ net: string }>`
      select distinct network(x::inet)::text as net from unnest(${nets}::text[]) x`.execute(trx);
    return { nets: out.rows.map((r) => r.net).sort(), names: [...names].sort() };
  }

  /** Caps and a backfill, checked against the operator's ceilings. */
  private checkedCaps(input: {
    daily_files?: number;
    daily_bytes?: number;
    daily_read_bytes?: number;
    backfill?: ConnectedAppInput['backfill'];
    auto_file?: unknown;
    route_to_person?: unknown;
  }) {
    const { files, bytes } = this.opts.ceilings;
    const out: Record<string, unknown> = {};
    const whole = (v: unknown, lo: number, hi: number, field: string, words: string) => {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) {
        throw invalid(words, field);
      }
      return v;
    };
    if (input.daily_files !== undefined) {
      out.daily_files = whole(
        input.daily_files,
        1,
        files,
        'daily_files',
        `Files a day: 1 to ${files}.`,
      );
    }
    if (input.daily_read_bytes !== undefined) {
      out.daily_read_bytes = whole(
        input.daily_read_bytes,
        1024 * 1024,
        bytes,
        'daily_read_bytes',
        `Bytes a day it may download: 1 MB to ${bytes}.`,
      );
    }
    if (input.daily_bytes !== undefined) {
      out.daily_bytes = whole(
        input.daily_bytes,
        1024 * 1024,
        bytes,
        'daily_bytes',
        `Bytes a day: 1 MB to ${bytes}.`,
      );
    }
    // Filing automatically when sure and complete (APP4): the owner's switch.
    if (input.auto_file !== undefined) {
      if (typeof input.auto_file !== 'boolean') {
        throw invalid('File automatically: on or off.', 'auto_file');
      }
      out.auto_file = input.auto_file;
    }
    // Each paper to the Inbox of the person it is about (APP5): on for a
    // new app unless said; the owner's switch.
    if (input.route_to_person !== undefined) {
      if (typeof input.route_to_person !== 'boolean') {
        throw invalid('Send to the person it is about: on or off.', 'route_to_person');
      }
      out.route_to_person = input.route_to_person;
    }
    if (input.backfill !== undefined) {
      if (input.backfill === null) {
        out.backfill_until = null;
        out.backfill_files = null;
        out.backfill_bytes = null;
        out.backfill_auto_file = false;
      } else {
        const until = new Date(input.backfill.until);
        const now = this.now();
        if (
          Number.isNaN(until.getTime()) ||
          until.getTime() <= now ||
          until.getTime() > now + APP_BACKFILL_MAX_DAYS * DAY + 60_000
        ) {
          throw invalid(
            `A backfill ends within ${APP_BACKFILL_MAX_DAYS} days from now.`,
            'backfill.until',
          );
        }
        out.backfill_until = until;
        out.backfill_files = whole(
          input.backfill.files_per_day,
          1,
          files,
          'backfill.files_per_day',
          `Files a day: 1 to ${files}.`,
        );
        out.backfill_bytes = whole(
          input.backfill.bytes_per_day,
          1024 * 1024,
          bytes,
          'backfill.bytes_per_day',
          `Bytes a day: 1 MB to ${bytes}.`,
        );
        // For the window alone (APP4): off unless said.
        const auto = input.backfill.auto_file ?? false;
        if (typeof auto !== 'boolean') {
          throw invalid('File automatically: on or off.', 'backfill.auto_file');
        }
        out.backfill_auto_file = auto;
      }
    }
    return out;
  }

  /** What a delete does, and the links it may mint an hour (APP3), checked. */
  private checkedLinks(input: { delete_mode?: unknown; links_per_hour?: unknown }) {
    const out: Record<string, unknown> = {};
    if (input.delete_mode !== undefined) {
      if (!(APP_DELETE_MODES as readonly unknown[]).includes(input.delete_mode)) {
        throw invalid('What a delete does: unlink or trash.', 'delete_mode');
      }
      out.delete_mode = input.delete_mode;
    }
    if (input.links_per_hour !== undefined) {
      const n = input.links_per_hour;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > APP_LINKS_PER_HOUR_MAX) {
        throw invalid(`Links an hour: 1 to ${APP_LINKS_PER_HOUR_MAX}.`, 'links_per_hour');
      }
      out.links_per_hour = n;
    }
    return out;
  }

  /** An app's name, as the vault keeps it. */
  private static nameOf(v: unknown): string {
    const n = typeof v === 'string' ? hintText(v) : '';
    if (n.length < 1 || n.length > APP_NAME_MAX) {
      throw invalid(`Give the app a name, ${APP_NAME_MAX} characters at most.`, 'name');
    }
    return n;
  }

  /** The apps the caller sees: the owners every one, its person their own. Nobody else any. */
  async list(p: Principal): Promise<ConnectedAppList> {
    const items =
      p.role === 'owner' || p.role === 'adult'
        ? await withPrincipal(this.db, p, (trx) => this.views(trx, p, null))
        : [];
    return {
      items,
      apps_public: this.opts.appsPublic,
      ceilings: { daily_files: this.opts.ceilings.files, daily_bytes: this.opts.ceilings.bytes },
    };
  }

  /** Apps as Settings shows them: one, or every one the caller sees, revoked ones never. */
  private async views(trx: Db, p: Principal, only: string | null): Promise<ConnectedAppView[]> {
    let q = trx
      .selectFrom('connected_app as a')
      .leftJoin('member as m', (j) =>
        j.onRef('m.id', '=', 'a.member_id').onRef('m.household_id', '=', 'a.household_id'),
      )
      // Its reviewer (APP8), and whether they can review now: an owner or an
      // adult of the family with a sign-in, neither locked nor paused.
      .leftJoin('member as r', (j) =>
        j.onRef('r.id', '=', 'a.reviewer_member_id').onRef('r.household_id', '=', 'a.household_id'),
      )
      .leftJoin('account_household as rh', (j) =>
        j
          .onRef('rh.member_id', '=', 'a.reviewer_member_id')
          .onRef('rh.household_id', '=', 'a.household_id'),
      )
      .select(APP_COLUMNS)
      .select([
        'm.display_name',
        'r.display_name as reviewer_name',
        'r.kind as reviewer_kind',
        'rh.role as reviewer_role',
        'rh.suspended_at as reviewer_suspended_at',
        'rh.suspended_until as reviewer_suspended_until',
        'rh.suspend_reason as reviewer_suspend_reason',
      ])
      .where('a.revoked_at', 'is', null)
      .orderBy('a.created_at', 'desc');
    if (only) q = q.where('a.id', '=', only);
    const apps = (await q.execute()) as Array<
      AppRow & {
        display_name: string | null;
        reviewer_name: string | null;
        reviewer_kind: string | null;
        reviewer_role: Role | null;
        reviewer_suspended_at: Date | null;
        reviewer_suspended_until: Date | null;
        reviewer_suspend_reason: string | null;
      }
    >;
    if (apps.length === 0) return [];
    const ids = apps.map((a) => a.id);
    const keys = (await trx
      .selectFrom('connected_app_key')
      .select(KEY_COLUMNS)
      .where('app_id', 'in', ids)
      .orderBy('created_at')
      .orderBy('id')
      .execute()) as KeyRow[];
    const grants = await trx
      .selectFrom('connected_app_grant')
      .select(['app_id', 'kind_key', 'category', 'lookback_months', 'sensitive_kinds'])
      .where('app_id', 'in', ids)
      .orderBy('created_at')
      .execute();
    // The kinds Sensitive by default each grant covers now: confirmed only
    // while every one of them is.
    const sensitiveKinds =
      grants.length === 0
        ? []
        : await trx
            .selectFrom('effective_document_type')
            .select(['key', 'category', 'usually_essential'])
            .where('deleted_at', 'is', null)
            .where('sensitive_default', '=', true)
            .where('key', '<>', NOTE_KIND)
            .execute();
    // What it sent, waiting and filed: its person's alone (0109's rule).
    const counted = await trx
      .selectFrom('connected_app_intake')
      .select(['app_id', 'state'])
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('app_id', 'in', ids)
      .where('member_id', '=', p.memberId)
      // In their own Inbox (APP5): not what went to the person it was about.
      .where((eb) =>
        eb.or([eb('inbox_member_id', 'is', null), eb('inbox_member_id', '=', p.memberId)]),
      )
      .where('state', 'in', ['waiting', 'filed'])
      .groupBy(['app_id', 'state'])
      .execute();
    // Its links (APP3): minted in the last hour, and opened in the last week.
    const linked = this.links
      ? await trx
          .selectFrom('connected_app_link')
          .select([
            'app_id',
            sql<string>`count(*) filter (where created_at > now() - interval '1 hour')`.as('hour'),
            sql<string>`count(*) filter (where opened_at > now() - interval '7 days')`.as('week'),
          ])
          .where('app_id', 'in', ids)
          .groupBy('app_id')
          .execute()
      : [];
    const hh = await trx.selectFrom('household').select('timezone').executeTakeFirstOrThrow();
    const now = this.now();
    const day = localToday(householdZone(hh.timezone), new Date(now));
    const instance = await this.opts.instanceId().catch(() => null);
    const address = this.address();
    return apps.map((a) => {
      const all = keys.filter((k) => k.app_id === a.id);
      const newest = all.filter((k) => keyState(k, now) === 'live').pop();
      const mine = a.acts_as === 'person' && a.member_id === p.memberId;
      const reviewer = {
        suspended_at: a.reviewer_suspended_at,
        suspended_until: a.reviewer_suspended_until,
        suspend_reason: a.reviewer_suspend_reason,
      };
      const reviews =
        a.acts_as === 'app' &&
        a.reviewer_member_id !== null &&
        a.reviewer_kind === 'family' &&
        (a.reviewer_role === 'owner' || a.reviewer_role === 'adult') &&
        !lockInEffect(reviewer) &&
        !suspensionInEffect(reviewer);
      const n = (state: string) =>
        Number(counted.find((r) => r.app_id === a.id && r.state === state)?.n ?? 0);
      const sent = today(a, day);
      return {
        id: a.id,
        name: a.name,
        acts_as: a.acts_as,
        member_id: a.acts_as === 'person' ? a.member_id : null,
        member_name: a.acts_as === 'person' ? a.display_name : null,
        reviewer_member_id: a.acts_as === 'app' ? a.reviewer_member_id : null,
        reviewer_name: a.acts_as === 'app' ? a.reviewer_name : null,
        reviewer_needed: a.acts_as === 'app' && !reviews,
        mine,
        created_at: a.created_at.toISOString(),
        state: appState(a),
        paused_reason: a.paused_reason,
        scopes: a.scopes as AppScope[],
        allowed_kinds: a.allowed_kinds,
        default_visibility: a.default_visibility,
        auto_file: a.auto_file,
        route_to_person: a.route_to_person,
        daily_files: a.daily_files,
        daily_bytes: Number(a.daily_bytes),
        backfill:
          a.backfill_until && a.backfill_until.getTime() > now
            ? {
                until: a.backfill_until.toISOString(),
                files_per_day: a.backfill_files ?? a.daily_files,
                bytes_per_day: Number(a.backfill_bytes ?? a.daily_bytes),
                auto_file: a.backfill_auto_file,
              }
            : null,
        ip_allow: [...(a.ip_allow ?? []), ...(a.ip_allow_names ?? [])],
        keys: all.map((k) => keyView(k, now)),
        last_used_at: a.last_used_at ? a.last_used_at.toISOString() : null,
        today: sent,
        refused_today: a.refused_on === day ? a.refused_today : 0,
        last_refusal: a.refused_on === day ? a.last_refusal : null,
        counts: mine ? { waiting: n('waiting'), filed: n('filed') } : null,
        grants: grants
          .filter((g) => g.app_id === a.id)
          .map((g): ConnectedAppGrantView => {
            const covered = sensitiveKinds.filter(
              (k) =>
                !k.usually_essential &&
                (APP_GRANTABLE_CATEGORIES as readonly string[]).includes(k.category) &&
                AppService.covers({ kind: g.kind_key, category: g.category }, k),
            );
            return {
              kind: g.kind_key,
              category: g.category,
              lookback_months: g.lookback_months,
              sensitive_confirmed:
                covered.length > 0 && covered.every((k) => g.sensitive_kinds.includes(k.key)),
              sensitive_kinds: [...g.sensitive_kinds],
            };
          }),
        daily_read_bytes: Number(a.daily_read_bytes),
        read_today: a.read_day === day ? Number(a.read_bytes_today) : 0,
        ...(this.links
          ? {
              delete_mode: a.delete_mode,
              links_per_hour: a.links_per_hour,
              links_last_hour: Number(linked.find((l) => l.app_id === a.id)?.hour ?? 0),
              links_opened_week: Number(linked.find((l) => l.app_id === a.id)?.week ?? 0),
            }
          : {}),
        connection_string: newest
          ? connectionString({
              url: address.url,
              client_id: newest.client_id,
              instance_id: instance,
            })
          : '',
        address,
      };
    });
  }

  private async view(p: Principal, id: string): Promise<ConnectedAppView> {
    const [v] = await withPrincipal(this.db, p, (trx) => this.views(trx, p, id));
    if (!v) throw notHere();
    return v;
  }

  /**
   * `POST /connected-apps`: an owner connects an app (the route asked for
   * a passkey or a code). It acts as itself unless the owner says a person
   * (APP8): then on at once when it acts as them; otherwise it waits for its
   * person, who is emailed. One acting as itself is on at once, its papers
   * that are for nobody in particular reviewed by the owner connecting it
   * or the person they chose, who is told. It has no key until an owner
   * generates one (APP6).
   */
  async create(
    p: Principal,
    input: ConnectedAppInput,
    meta: RequestMeta,
  ): Promise<ConnectedAppView> {
    if (p.role !== 'owner') throw ownersOnly();
    const name = AppService.nameOf(input.name);
    if (!Array.isArray(input.allowed_kinds)) {
      throw invalid('Choose the kinds it may send.', 'allowed_kinds');
    }
    const caps = { ...this.checkedCaps(input), ...this.checkedLinks(input) };
    const made = await withPrincipal(this.db, p, async (trx) => {
      const who = await this.whom(trx, p, input, null);
      const kinds = await this.checkedKinds(trx, input.allowed_kinds);
      const ip = await this.checkedAddresses(trx, input.ip_allow ?? []);
      const own = who.acts_as === 'app' || who.member_id === p.memberId;
      const id = randomUUID();
      await trx
        .insertInto('connected_app')
        .values({
          id,
          household_id: p.householdId,
          name,
          acts_as: who.acts_as,
          account_id: who.account_id,
          member_id: who.member_id,
          reviewer_member_id: who.reviewer_member_id,
          created_by: p.accountId,
          approval: own ? 'approved' : 'waiting',
          approved_at: own ? new Date() : null,
          scopes: AppService.checkedScopes(input.scopes) ?? [...APP_SCOPES_DEFAULT],
          allowed_kinds: kinds,
          default_visibility: input.default_visibility ?? null,
          daily_files: APP_DEFAULT_DAILY_FILES,
          daily_bytes: APP_DEFAULT_DAILY_BYTES,
          ...caps,
          ip_allow: sql<string[]>`${ip.nets}::cidr[]` as unknown as string[],
          ip_allow_names: ip.names,
        })
        .execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'app.connected',
        objectType: 'member',
        // Whom it acts as; for an app acting as itself, its reviewer (APP8).
        objectId: who.member_id ?? who.reviewer_member_id,
        detail: { app_id: id, app: name, ...(who.acts_as === 'app' ? { acts_as: 'app' } : {}) },
        ip: meta.ip,
      });
      return { id, own, who };
    });
    if (made.who.acts_as === 'person' && !made.own) {
      await this.askFirst(p.householdId, made.who.person.account_id, name);
    }
    if (made.who.acts_as === 'app' && made.who.reviewer_member_id !== p.memberId) {
      await this.toldReviewer(p.householdId, made.who.person.account_id, name);
    }
    return this.view(p, made.id);
  }

  /**
   * `PATCH /connected-apps/{id}`: an owner changes what it may do (the
   * route asked for the step-up) — and whom it acts as (APP8): itself, with
   * a reviewer, or a person. Acting as another adult from now waits for
   * them to turn it on, and they are emailed; a new reviewer is told, and
   * asked nothing.
   */
  async update(
    p: Principal,
    id: string,
    input: ConnectedAppChange,
    meta: RequestMeta,
  ): Promise<ConnectedAppView> {
    if (p.role !== 'owner') throw ownersOnly();
    const set: Record<string, unknown> = {
      ...this.checkedCaps(input),
      ...this.checkedLinks(input),
    };
    if (input.name !== undefined) set.name = AppService.nameOf(input.name);
    const scopes = AppService.checkedScopes(input.scopes);
    if (scopes) set.scopes = scopes;
    if (input.default_visibility !== undefined) set.default_visibility = input.default_visibility;
    const asked = await withPrincipal(this.db, p, async (trx) => {
      const app = (await trx
        .selectFrom('connected_app as a')
        .select(APP_COLUMNS)
        .where('a.id', '=', id)
        .where('a.revoked_at', 'is', null)
        .forUpdate()
        .executeTakeFirst()) as AppRow | undefined;
      if (!app) throw notHere();
      let ip: AllowList | undefined;
      if (input.allowed_kinds !== undefined) {
        if (!Array.isArray(input.allowed_kinds)) {
          throw invalid('Choose the kinds it may send.', 'allowed_kinds');
        }
        set.allowed_kinds = await this.checkedKinds(trx, input.allowed_kinds);
      }
      if (input.ip_allow !== undefined) {
        ip = await this.checkedAddresses(trx, input.ip_allow);
        set.ip_allow = sql`${ip.nets}::cidr[]`;
        set.ip_allow_names = ip.names;
      }
      // Whom it acts as, and who reviews it (APP8).
      const whomAsked =
        input.acts_as !== undefined ||
        input.member_id !== undefined ||
        input.reviewer_member_id !== undefined;
      const who = whomAsked ? await this.whom(trx, p, input, app) : null;
      /** It acts as somebody else than before: a person, or itself. */
      const moved =
        who !== null && (who.acts_as !== app.acts_as || who.member_id !== app.member_id);
      const newReviewer =
        who !== null &&
        who.acts_as === 'app' &&
        who.reviewer_member_id !== (app.acts_as === 'app' ? app.reviewer_member_id : null);
      if (who && (moved || newReviewer)) {
        set.acts_as = who.acts_as;
        set.account_id = who.account_id;
        set.member_id = who.member_id;
        set.reviewer_member_id = who.reviewer_member_id;
        // A reviewer chosen: told again, should they no longer can.
        set.reviewer_told_at = null;
      }
      if (Object.keys(set).length === 0) return null;
      // Acting as another adult from now: they turn it on themselves, and
      // are emailed. As the owner changing it, or as itself: on.
      let first: string | null = null;
      if (moved && who) {
        const theirs = who.acts_as === 'person' && who.member_id !== p.memberId;
        set.approval = theirs ? 'waiting' : 'approved';
        set.approved_at = theirs ? null : new Date();
        if (theirs) first = who.person.account_id;
      }
      const again =
        !moved && widens(app, set, ip, this.now()) && (await this.reapprove(trx, p, app))
          ? app.account_id
          : null;
      await trx.updateTable('connected_app').set(set).where('id', '=', id).execute();
      const now = { ...app, ...(who ?? {}) };
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'app.changed',
        objectType: 'member',
        objectId: now.acts_as === 'app' ? now.reviewer_member_id : now.member_id,
        detail: {
          app_id: id,
          app: set.name ?? app.name,
          fields: Object.keys(input).sort(),
          ...(now.acts_as === 'app' ? { acts_as: 'app' } : {}),
          ...(again || first ? { approval: 'asked_again' } : {}),
        },
        ip: meta.ip,
      });
      return {
        name: (set.name as string | undefined) ?? app.name,
        again,
        first,
        reviewer: newReviewer && who && who.reviewer_member_id !== p.memberId ? who.person : null,
      };
    });
    if (asked?.again) await this.askAgain(p.householdId, asked.again, asked.name);
    if (asked?.first) await this.askFirst(p.householdId, asked.first, asked.name);
    if (asked?.reviewer) {
      await this.toldReviewer(p.householdId, asked.reviewer.account_id, asked.name);
    }
    return this.view(p, id);
  }

  /** What an app may do, checked: scopes this vault grants, at least one. Undefined when not sent. */
  private static checkedScopes(v: unknown): string[] | undefined {
    if (v === undefined) return undefined;
    if (
      !Array.isArray(v) ||
      v.length === 0 ||
      v.some((s) => !(APP_SCOPES_OFFERED as readonly unknown[]).includes(s))
    ) {
      throw invalid(`Choose what it may do, from: ${APP_SCOPES_OFFERED.join(', ')}.`, 'scopes');
    }
    return APP_SCOPES_OFFERED.filter((s) => (v as unknown[]).includes(s));
  }

  /**
   * `PUT /connected-apps/{id}/grants`: an owner sets what an app may read
   * beyond its own (the route asked for a passkey or a code) — each a kind
   * or a category an app may ever be given, and how far back. A kind
   * Sensitive by default, or a category holding one, asks once
   * (`confirm_sensitive`, else `409 sensitive_confirm` with the question);
   * a grant confirmed before stays so. More than it could read before, for
   * an app acting as somebody else, waits for them to turn it on again.
   */
  /**
   * Whether a grant covers a kind: its own key, or its category — never a
   * kind kept as an Essential, nor of a category an app may never read.
   */
  private static covers(
    g: { kind: string | null; category: string | null },
    k: { key: string; category: string },
  ): boolean {
    return g.kind ? k.key === g.kind : k.category === g.category;
  }

  async setGrants(
    p: Principal,
    id: string,
    input: ConnectedAppGrantsInput,
    meta: RequestMeta,
  ): Promise<ConnectedAppView> {
    if (p.role !== 'owner') throw ownersOnly();
    if (!input || !Array.isArray(input.grants) || input.grants.length > APP_GRANTS_MAX) {
      throw invalid(`Up to ${APP_GRANTS_MAX} grants: each a kind or a category.`, 'grants');
    }
    const wanted = input.grants.map((g, i) => {
      const kind = typeof g?.kind === 'string' ? g.kind : undefined;
      const category = typeof g?.category === 'string' ? g.category : undefined;
      const months = g?.lookback_months;
      if ((kind === undefined) === (category === undefined)) {
        throw invalid('Each grant is a kind or a category, not both.', `grants.${i}`);
      }
      if (
        typeof months !== 'number' ||
        !Number.isInteger(months) ||
        months < 1 ||
        months > APP_LOOKBACK_MAX_MONTHS
      ) {
        throw invalid(
          `How far back: 1 to ${APP_LOOKBACK_MAX_MONTHS} months.`,
          `grants.${i}.lookback_months`,
        );
      }
      if (
        category !== undefined &&
        !(APP_GRANTABLE_CATEGORIES as readonly string[]).includes(category)
      ) {
        throw invalid('An app may never read that category.', `grants.${i}.category`);
      }
      return { kind: kind ?? null, category: category ?? null, months };
    });
    const keyOf = (g: { kind: string | null; category: string | null }) =>
      g.kind ? `kind:${g.kind}` : `category:${g.category}`;
    if (new Set(wanted.map(keyOf)).size !== wanted.length) {
      throw invalid('Each kind or category once.', 'grants');
    }
    const asked = await withPrincipal(this.db, p, async (trx) => {
      const app = (await trx
        .selectFrom('connected_app as a')
        .select(APP_COLUMNS)
        .where('a.id', '=', id)
        .where('a.revoked_at', 'is', null)
        .forUpdate()
        .executeTakeFirst()) as AppRow | undefined;
      if (!app) throw notHere();
      const kinds = await trx
        .selectFrom('effective_document_type')
        .select(['key', 'label', 'category', 'usually_essential', 'sensitive_default'])
        .where('deleted_at', 'is', null)
        .where('key', '<>', NOTE_KIND)
        .execute();
      const kindBy = new Map(kinds.map((k) => [k.key, k]));
      const grantableKind = (k: { category: string; usually_essential: boolean }) =>
        (APP_GRANTABLE_CATEGORIES as readonly string[]).includes(k.category) &&
        !k.usually_essential;
      // Never an identity, legal or medical kind, nor one kept as an
      // Essential: an app reads none of them, whatever is ticked.
      for (const [i, g] of wanted.entries()) {
        if (!g.kind) continue;
        const k = kindBy.get(g.kind);
        if (!k) throw invalid('Each kind must be one the household has.', `grants.${i}.kind`);
        if (
          !(APP_GRANTABLE_CATEGORIES as readonly string[]).includes(k.category) ||
          k.usually_essential
        ) {
          throw invalid(`An app may never read ${k.label}.`, `grants.${i}.kind`);
        }
      }
      const had = await trx
        .selectFrom('connected_app_grant')
        .select(['id', 'kind_key', 'category', 'lookback_months', 'sensitive_kinds'])
        .where('app_id', '=', id)
        .execute();
      const hadBy = new Map(had.map((g) => [keyOf({ kind: g.kind_key, category: g.category }), g]));
      // The kinds Sensitive by default each grant covers, as the household
      // has them now; and of those, the ones nobody has confirmed on it yet.
      const sensitiveOf = (g: { kind: string | null; category: string | null }) =>
        kinds.filter(
          (k) => k.sensitive_default !== false && grantableKind(k) && AppService.covers(g, k),
        );
      const unconfirmed = (g: { kind: string | null; category: string | null }) => {
        const yes = hadBy.get(keyOf(g))?.sensitive_kinds ?? [];
        return sensitiveOf(g).filter((k) => !yes.includes(k.key));
      };
      const toConfirm = wanted.flatMap((g) => unconfirmed(g));
      if (toConfirm.length > 0 && input.confirm_sensitive !== true) {
        throw new ApiError(
          409,
          'sensitive_confirm',
          appSensitiveConfirmWords(app.name, [...new Set(toConfirm.map((k) => k.label))].sort()),
          { detail: [...new Set(toConfirm.map((k) => k.key))].sort().join(',') },
        );
      }
      // What each grant is to have: the kinds confirmed before, and those
      // confirmed now.
      const next = wanted.map((g) => {
        const before = hadBy.get(keyOf(g));
        const now = unconfirmed(g).map((k) => k.key);
        return {
          ...g,
          before,
          newly: now,
          sensitive: [...new Set([...(before?.sensitive_kinds ?? []), ...now])].sort(),
        };
      });
      // More than before: a kind or category new to it, further back, or
      // sensitive papers newly allowed.
      const wider = next.some(
        (g) => !g.before || g.months > g.before.lookback_months || g.newly.length > 0,
      );
      const keep = new Set(wanted.map(keyOf));
      const gone = had.filter((g) => !keep.has(keyOf({ kind: g.kind_key, category: g.category })));
      if (gone.length > 0) {
        await trx
          .deleteFrom('connected_app_grant')
          .where(
            'id',
            'in',
            gone.map((g) => g.id),
          )
          .execute();
      }
      for (const g of next) {
        const confirmedNow =
          g.newly.length > 0
            ? { sensitive_confirmed_at: new Date(), sensitive_confirmed_by: p.accountId }
            : {};
        if (g.before) {
          await trx
            .updateTable('connected_app_grant')
            .set({ lookback_months: g.months, sensitive_kinds: g.sensitive, ...confirmedNow })
            .where('id', '=', g.before.id)
            .execute();
        } else {
          await trx
            .insertInto('connected_app_grant')
            .values({
              household_id: p.householdId,
              app_id: id,
              kind_key: g.kind,
              category: g.category,
              lookback_months: g.months,
              sensitive_kinds: g.sensitive,
              ...confirmedNow,
            })
            .execute();
        }
      }
      const changed =
        gone.length > 0 ||
        next.some((g) => !g.before || g.before.lookback_months !== g.months || g.newly.length > 0);
      if (!changed) return null;
      const again = wider && (await this.reapprove(trx, p, app)) ? app.account_id : null;
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'app.changed',
        objectType: 'member',
        objectId: app.member_id,
        detail: {
          app_id: id,
          app: app.name,
          fields: ['grants'],
          // What it may read now, by key alone: never a document.
          grants: next.map((g) => ({
            ...(g.kind ? { kind: g.kind } : { category: g.category }),
            lookback_months: g.months,
            ...(g.newly.length > 0 ? { sensitive_confirmed: true } : {}),
          })),
          ...(again ? { approval: 'asked_again' } : {}),
        },
        ip: meta.ip,
      });
      return again ? { account: again, name: app.name } : null;
    });
    if (asked) await this.askAgain(p.householdId, asked.account, asked.name);
    return this.view(p, id);
  }

  /** Whether a change only renames: no step-up for that. */
  static onlyRenames(input: ConnectedAppChange): boolean {
    return Object.keys(input).every((k) => k === 'name');
  }

  /** `POST /connected-apps/{id}/approve`: its person turns it on (the route asked for the step-up). */
  async approve(p: Principal, id: string, meta: RequestMeta): Promise<ConnectedAppView> {
    await withPrincipal(this.db, p, async (trx) => {
      const app = await trx
        .selectFrom('connected_app')
        .select(['id', 'member_id', 'name', 'approval'])
        .where('id', '=', id)
        .where('revoked_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!app || app.member_id !== p.memberId) throw notHere();
      if (app.approval === 'approved') return;
      await trx
        .updateTable('connected_app')
        .set({ approval: 'approved', approved_at: sql<Date>`now()` })
        .where('id', '=', id)
        .execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'app.approved',
        objectType: 'member',
        objectId: app.member_id,
        detail: { app_id: id, app: app.name },
        ip: meta.ip,
      });
    });
    return this.view(p, id);
  }

  /** `POST /connected-apps/{id}/pause` and `/resume`: an owner's. Resuming clears a restore's pause too. */
  async pause(
    p: Principal,
    id: string,
    paused: boolean,
    meta: RequestMeta,
  ): Promise<ConnectedAppView> {
    if (p.role !== 'owner') throw ownersOnly();
    await withPrincipal(this.db, p, async (trx) => {
      const app = await trx
        .selectFrom('connected_app')
        .select(['id', 'member_id', 'name', 'paused_reason'])
        .where('id', '=', id)
        .where('revoked_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!app) throw notHere();
      if ((app.paused_reason !== null) === paused && (paused || app.paused_reason === null)) return;
      await trx
        .updateTable('connected_app')
        .set({ paused_reason: paused ? 'owner' : null })
        .where('id', '=', id)
        .execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: paused ? 'app.paused' : 'app.resumed',
        objectType: 'member',
        objectId: app.member_id,
        detail: {
          app_id: id,
          app: app.name,
          ...(!paused && app.paused_reason === 'restored' ? { after: 'restored' } : {}),
        },
        ip: meta.ip,
      });
    });
    return this.view(p, id);
  }

  /**
   * `POST /connected-apps/{id}/keys`: an owner generates an API key (the
   * route asked for a passkey or a code) — its name, its permissions (some
   * of the app's scopes) and how many days it lasts, or never. Two live at
   * most (`409 key_limit`). The secret is answered this once, and kept as a
   * hash alone. An app acting as somebody else waits for them to turn it on
   * again, as for any widening — unless the new key may do no more than a
   * live one already may (a rotation).
   */
  async generateKey(
    p: Principal,
    id: string,
    input: ConnectedAppKeyInput,
    meta: RequestMeta,
  ): Promise<ConnectedAppKeyMade> {
    if (p.role !== 'owner') throw ownersOnly();
    const clientId = newClientId();
    const secret = newSecret();
    const made = await withPrincipal(this.db, p, async (trx) => {
      const app = await trx
        .selectFrom('connected_app')
        .select(['id', 'acts_as', 'member_id', 'name', 'account_id', 'scopes'])
        .where('id', '=', id)
        .where('revoked_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!app) throw notHere();
      const name = AppService.keyNameOf(input.name);
      const permissions = AppService.checkedPermissions(input.permissions, app.scopes);
      const days = AppService.checkedDays(input.expires_in_days);
      const live = await trx
        .selectFrom('connected_app_key')
        .select('permissions')
        .where('app_id', '=', id)
        .where('revoked_at', 'is', null)
        .where((eb) =>
          eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`now()`)]),
        )
        .execute();
      if (live.length >= APP_KEYS_MAX) throw keyLimit();
      // A new key that may do no more than a live one already may (a
      // rotation) widens nothing: its person is not asked again (the
      // owner's decision, 18 Nov 2026). One that may do more is a widening.
      const widening = !live.some((k) => permissions.every((s) => k.permissions.includes(s)));
      const k = await trx
        .insertInto('connected_app_key')
        .values({
          household_id: p.householdId,
          app_id: id,
          client_id: clientId,
          secret_hash: secretHash(secret),
          name,
          permissions,
          created_by: p.accountId,
          expires_at: days === null ? null : sql<Date>`now() + make_interval(days => ${days}::int)`,
        })
        .returning(['id', 'expires_at'])
        .executeTakeFirstOrThrow()
        .catch((e: unknown) => {
          // Two owners at once: the database counts too.
          if ((e as { constraint?: string }).constraint === 'connected_app_key_two') {
            throw keyLimit();
          }
          throw e;
        });
      const again = widening && (await this.reapprove(trx, p, app));
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'app.key_added',
        objectType: 'member',
        objectId: app.member_id,
        detail: {
          app_id: id,
          app: app.name,
          client_id: clientId,
          permissions,
          expires_at: k.expires_at ? k.expires_at.toISOString() : null,
          ...(again ? { approval: 'asked_again' } : {}),
        },
        ip: meta.ip,
      });
      return { keyId: k.id, again: again ? app.account_id : null, name: app.name };
    });
    if (made.again) await this.askAgain(p.householdId, made.again, made.name);
    const view = await this.view(p, id);
    const key = view.keys.find((k) => k.id === made.keyId);
    if (!key) throw notHere();
    const instance = await this.opts.instanceId().catch(() => null);
    const url = this.address().url;
    return {
      key,
      client_id: clientId,
      secret,
      connection_string: connectionString({ url, client_id: clientId, instance_id: instance }),
      connection_string_with_secret: connectionString({
        url,
        client_id: clientId,
        instance_id: instance,
        secret,
      }),
    };
  }

  /** A key's name: optional, as plain text, APP_KEY_NAME_MAX characters at most. */
  private static keyNameOf(v: unknown): string | null {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') throw invalid('A key’s name is text.', 'name');
    const n = hintText(v).trim();
    if (n.length > APP_KEY_NAME_MAX) {
      throw invalid(`A key’s name is ${APP_KEY_NAME_MAX} characters at most.`, 'name');
    }
    return n.length === 0 ? null : n;
  }

  /** A key's permissions: at least one, each one the app itself may do; in the vault's order. */
  private static checkedPermissions(v: unknown, app: readonly string[]): AppScope[] {
    if (
      !Array.isArray(v) ||
      v.length === 0 ||
      v.some((s) => typeof s !== 'string' || !app.includes(s))
    ) {
      throw invalid(
        `Choose what the key may do, from what the app may do: ${app.join(', ')}.`,
        'permissions',
      );
    }
    return APP_SCOPES_OFFERED.filter((s) => (v as unknown[]).includes(s));
  }

  /** How long a key lasts: 1 to APP_KEY_DAYS_MAX days, or null for never. */
  private static checkedDays(v: unknown): number | null {
    if (v === null) return null;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > APP_KEY_DAYS_MAX) {
      throw invalid(
        `How long the key lasts: 1 to ${APP_KEY_DAYS_MAX} days, or never.`,
        'expires_in_days',
      );
    }
    return v;
  }

  /**
   * `DELETE /connected-apps/{id}/keys/{keyId}`: an owner revokes a key (the
   * route asked for a passkey or a code). It works for nothing from the
   * next request on; its last one too, which leaves the app without a
   * key. Already revoked: nothing changes. The owners and the person the
   * app acts as are emailed.
   */
  async revokeKey(p: Principal, id: string, keyId: string, meta: RequestMeta): Promise<void> {
    if (p.role !== 'owner') throw ownersOnly();
    const told = await withPrincipal(this.db, p, async (trx) => {
      const app = await trx
        .selectFrom('connected_app')
        .select(['id', 'acts_as', 'member_id', 'reviewer_member_id', 'name', 'account_id'])
        .where('id', '=', id)
        .where('revoked_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!app) throw notHere();
      const k = await trx
        .selectFrom('connected_app_key')
        .select(['id', 'client_id', 'name', 'revoked_at'])
        .where('id', '=', keyId)
        .where('app_id', '=', id)
        .executeTakeFirst();
      if (!k) throw new ApiError(404, 'not_found', 'That key is not here.');
      if (k.revoked_at) return null;
      await trx
        .updateTable('connected_app_key')
        .set({ revoked_at: sql<Date>`now()`, revoked_by: p.accountId, revoked_reason: 'owner' })
        .where('id', '=', k.id)
        .execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'app.key_retired',
        objectType: 'member',
        objectId: app.member_id ?? app.reviewer_member_id,
        detail: { app_id: id, app: app.name, client_id: k.client_id },
        ip: meta.ip,
      });
      return {
        owners: await this.owners(trx),
        app,
        // Whom it acts as, in the email's words (APP8: itself).
        member: app.member_id ? await this.memberName(trx, app.member_id) : 'itself',
        clientId: k.client_id,
      };
    });
    if (told) {
      await this.keyRevokedAlert(
        p.householdId,
        [...told.owners, ...(told.app.account_id ? [told.app.account_id] : [])],
        told.app.name,
        told.member,
        told.clientId,
      );
    }
  }

  /** Somebody of the family, by the name the household knows them by. */
  private async memberName(trx: Db, memberId: string): Promise<string> {
    const m = await trx
      .selectFrom('member')
      .select('display_name')
      .where('id', '=', memberId)
      .executeTakeFirst();
    return m?.display_name ?? 'somebody';
  }

  /**
   * `DELETE /connected-apps/{id}`: removed — revoked, and kept for the
   * activity log — by an owner or its person. Its next request is `401
   * app_revoked`; what it sent waits in the Inbox for its person.
   */
  async remove(p: Principal, id: string, meta: RequestMeta): Promise<void> {
    await withPrincipal(this.db, p, async (trx) => {
      const app = await trx
        .selectFrom('connected_app')
        .select(['id', 'member_id', 'name'])
        .where('id', '=', id)
        .where('revoked_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!app) throw notHere();
      const own = app.member_id === p.memberId;
      if (!own && p.role !== 'owner') throw notHere();
      await trx
        .updateTable('connected_app')
        .set({
          revoked_at: sql<Date>`now()`,
          revoked_by: p.accountId,
          revoked_reason: own ? 'member' : 'owner',
        })
        .where('id', '=', id)
        .execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'app.revoked',
        objectType: 'member',
        objectId: app.member_id,
        detail: { app_id: id, app: app.name, reason: own ? 'member' : 'owner' },
        ip: meta.ip,
      });
    });
  }
}

/**
 * The activity log's lines for what the database revoked in this very
 * transaction (0109's connected_apps_leave_with_role): a sign-in taken
 * away, or a role that can no longer act — and (0116, APP8) the apps acting
 * as themselves that person reviewed, let go of them as reviewer. Asked by
 * whoever changed it, after the change, inside its transaction.
 */
export async function logAppsEnded(
  trx: Db,
  p: Principal,
  person: { account_id: string; member_id: string },
  meta: RequestMeta,
  /**
   * For the owners' emails (APP8): the apps acting as themselves now
   * without a reviewer, by name; and what that person connected or
   * generated for such apps, stopped with them.
   */
  told?: (t: AppsEndedNotice) => void,
): Promise<number> {
  const ended = await trx
    .selectFrom('connected_app')
    .select(['id', 'name', 'revoked_reason'])
    .where('account_id', '=', person.account_id)
    .where('revoked_at', '=', sql<Date>`now()`)
    .where('revoked_reason', 'in', ['sign_in_removed', 'cannot_act'])
    .orderBy('created_at')
    .execute();
  for (const a of ended) {
    await appendAudit(trx, {
      householdId: p.householdId,
      actorAccountId: p.accountId,
      action: 'app.revoked',
      objectType: 'member',
      objectId: person.member_id,
      detail: { app_id: a.id, app: a.name, reason: a.revoked_reason },
      ip: meta.ip,
    });
  }
  const stopped = await creatorEnded(trx, p, person, meta, {
    reasons: ['sign_in_removed', 'cannot_act'],
  });
  // The apps acting as themselves they reviewed (APP8), which the database
  // let go of them as reviewer: the app stays; the owners are told, once,
  // to choose somebody else — a line here, and an email from `told`.
  const lost = await trx
    .updateTable('connected_app')
    .set({ reviewer_told_at: sql<Date>`now()` })
    .where('acts_as', '=', 'app')
    .where('reviewer_member_id', 'is', null)
    .where('reviewer_told_at', 'is', null)
    .where('revoked_at', 'is', null)
    .returning(['id', 'name'])
    .execute();
  for (const a of lost) {
    await appendAudit(trx, {
      householdId: p.householdId,
      action: 'app.reviewer_needed',
      objectType: 'member',
      objectId: null,
      detail: { app_id: a.id, app: a.name, as_itself: true },
      ip: meta.ip,
    });
  }
  if (told && (lost.length > 0 || stopped.length > 0)) {
    told({
      reviewers: lost.map((a) => a.name),
      stopped,
      owners: await otherOwners(trx, person.account_id),
    });
  }
  return ended.length;
}

/** What the owners are emailed of, as a person's leaving or stopping ended apps (APP8). */
export interface AppsEndedNotice {
  /** Apps acting as themselves now without a reviewer, by name. */
  reviewers: string[];
  /** What that person connected or generated for apps acting as themselves, stopped: in words. */
  stopped: string[];
  /** The owners to tell: every owner but that person. */
  owners: string[];
}

/** Every owner of the household but this sign-in. */
async function otherOwners(trx: Db, accountId: string): Promise<string[]> {
  const rows = await trx
    .selectFrom('account_household')
    .select('account_id')
    .where('role', '=', 'owner')
    .where('account_id', '<>', accountId)
    .execute();
  return rows.map((r) => r.account_id);
}

/**
 * What a person connected to act as itself, and the API keys they generated
 * for such apps, that the database stopped with them in this very
 * transaction (0116, APP8): a line each — the app "which they connected,
 * was removed", the key "that they generated was revoked" — and their words
 * for the owners' email.
 */
async function creatorEnded(
  trx: Db,
  p: { householdId: string; accountId: string },
  person: { account_id: string; member_id: string },
  meta: RequestMeta,
  o: { reasons: string[] },
): Promise<string[]> {
  const apps = await trx
    .selectFrom('connected_app')
    .select(['id', 'name', 'revoked_reason'])
    .where('acts_as', '=', 'app')
    .where('created_by', '=', person.account_id)
    .where('revoked_at', '=', sql<Date>`now()`)
    .where('revoked_reason', 'in', o.reasons as never)
    .orderBy('created_at')
    .execute();
  for (const a of apps) {
    await appendAudit(trx, {
      householdId: p.householdId,
      actorAccountId: p.accountId,
      action: 'app.revoked',
      objectType: 'member',
      objectId: person.member_id,
      detail: { app_id: a.id, app: a.name, reason: a.revoked_reason, creator: true },
      ip: meta.ip,
    });
  }
  const keys = await trx
    .selectFrom('connected_app_key as k')
    .innerJoin('connected_app as a', 'a.id', 'k.app_id')
    .select(['a.id', 'a.name', 'k.client_id'])
    .where('k.created_by', '=', person.account_id)
    .where('k.revoked_reason', '=', 'creator')
    .where('k.revoked_at', '=', sql<Date>`now()`)
    .orderBy('k.created_at')
    .execute();
  for (const k of keys) {
    await appendAudit(trx, {
      householdId: p.householdId,
      actorAccountId: p.accountId,
      action: 'app.key_retired',
      objectType: 'member',
      objectId: person.member_id,
      detail: { app_id: k.id, app: k.name, client_id: k.client_id, reason: 'creator' },
      ip: meta.ip,
    });
  }
  return [
    ...apps.map((a) => `${a.name}, which they connected, was removed`),
    ...keys.map((k) => `the API key ${k.client_id} they generated for ${k.name} was revoked`),
  ];
}

/**
 * The owners' email (APP8) as somebody's leaving or stopping ended what they
 * connected to act as itself, or left apps without a reviewer: once, with
 * every one of them.
 */
export function appsEndedAlert(
  householdId: string,
  who: string,
  t: AppsEndedNotice,
): AlertRequest | null {
  if (t.owners.length === 0 || (t.stopped.length === 0 && t.reviewers.length === 0)) return null;
  const parts = [
    ...(t.stopped.length > 0
      ? [
          `As ${who} left, stopped being an owner or was stopped: ${t.stopped.join('; ')}. If they are still wanted, an owner connects them again, or generates new keys, in Settings → Connected apps.`,
        ]
      : []),
    ...t.reviewers.map((app) => reviewerNeededBody(app)),
  ];
  return {
    householdId,
    accountIds: t.owners,
    subject:
      t.stopped.length > 0
        ? `Connected apps ${who} set up were stopped`
        : t.reviewers.length === 1
          ? `Choose who reviews what ${t.reviewers[0] as string} sends`
          : 'Choose who reviews what your connected apps send',
    body: parts.join('\n\n'),
    emailOnly: true,
  };
}

/**
 * The emergency controls: every app acting as somebody stopped at once
 * — signed out everywhere (`signed_out`), their password stopped by an
 * owner (`owner_stopped`) — by the database's own connected_apps_revoke_for(),
 * with a line for each; and (APP8) every app acting as itself they
 * connected, and every API key they generated for such an app. Never on an
 * ordinary password change. Inside the caller's transaction; how many apps
 * it stopped. `told` is given what to email the other owners of.
 */
export async function stopAppsOf(
  trx: Db,
  by: { householdId: string; actorAccountId: string },
  accountId: string,
  reason: 'signed_out' | 'owner_stopped',
  meta: RequestMeta,
  told?: (t: AppsEndedNotice) => void,
): Promise<number> {
  const stopped = await sql<{
    id: string;
    member_id: string | null;
    name: string;
    client_id: string | null;
  }>`
    select id, member_id, name, client_id
      from connected_apps_revoke_for(${accountId}::uuid, ${reason})`.execute(trx);
  const member = (
    await trx
      .selectFrom('account_household')
      .select('member_id')
      .where('account_id', '=', accountId)
      .executeTakeFirst()
  )?.member_id;
  const words: string[] = [];
  for (const a of stopped.rows) {
    if (a.client_id) {
      await appendAudit(trx, {
        householdId: by.householdId,
        actorAccountId: by.actorAccountId,
        action: 'app.key_retired',
        objectType: 'member',
        objectId: member ?? null,
        detail: { app_id: a.id, app: a.name, client_id: a.client_id, reason: 'creator' },
        ip: meta.ip,
      });
      words.push(`the API key ${a.client_id} they generated for ${a.name} was revoked`);
      continue;
    }
    // An app acting as itself they connected (APP8): its line names them.
    const itself = a.member_id === null;
    await appendAudit(trx, {
      householdId: by.householdId,
      actorAccountId: by.actorAccountId,
      action: 'app.revoked',
      objectType: 'member',
      objectId: itself ? (member ?? null) : a.member_id,
      detail: { app_id: a.id, app: a.name, reason, ...(itself ? { creator: true } : {}) },
      ip: meta.ip,
    });
    if (itself) words.push(`${a.name}, which they connected, was removed`);
  }
  if (told && words.length > 0) {
    told({ reviewers: [], stopped: words, owners: await otherOwners(trx, accountId) });
  }
  return stopped.rows.filter((a) => !a.client_id).length;
}
