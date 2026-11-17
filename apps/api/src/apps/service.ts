import { randomUUID } from 'node:crypto';
import { BlockList, isIP, isIPv4 } from 'node:net';
import type { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { itemAppHintsBinding, sealBytes } from '@fdv/crypto';
import { appendAudit, householdZone, withPrincipal, withSystem, type Db } from '@fdv/db';
import {
  APP_BACKFILL_MAX_DAYS,
  APP_CONNECTION_PREFIX,
  APP_DEFAULT_DAILY_BYTES,
  APP_DEFAULT_DAILY_FILES,
  APP_DEFAULT_LINKS_PER_HOUR,
  APP_DEFAULT_READ_BYTES,
  APP_HINTS,
  APP_IP_ALLOW_MAX,
  APP_KEY_RETIRE_DAYS,
  APP_KEYS_MAX,
  APP_NEVER_CATEGORIES,
  APP_NAME_MAX,
  APP_REFUSALS,
  APP_REQUESTS_PER_MINUTE,
  APP_SCOPES_OFFERED,
  APP_SIGNATURE_WINDOW_SECONDS,
  APP_STATUS_MAX_IDS,
  BATCH_MAX_FILES,
  EXTERNAL_ID_PATTERN,
  INCOMING_KEEP_DAYS,
  NOTE_KIND,
  UPLOAD_KINDS,
  appBatchName,
  hintText,
  localToday,
  lockInEffect,
  nextLocalMidnight,
  sealedAppHints,
  seesAdults,
  suspensionInEffect,
  type AppConnection,
  type AppIntakeMetadata,
  type AppIntakeState,
  type AppIntakeStates,
  type AppKeyAdded,
  type AppKeyView,
  type AppMe,
  type AppScope,
  type AppStateName,
  type ConnectedAppChange,
  type ConnectedAppInput,
  type ConnectedAppKeyAdded,
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
import type { BatchService } from '../uploads/batches.js';
import {
  fingerprintOf,
  parseSignature,
  pathAndQuery,
  rawPublicKey,
  signatureBase,
  verifies,
  type ParsedSignature,
} from './signing.js';

/**
 * Connected apps (0.9.0, APP1): an owner connects one, and it signs every
 * request it makes, as the one adult it acts as.
 *
 * **The family's side** (Settings → Connected apps, signed in): an owner
 * connects an app — its name, whom it acts as (an owner or an adult with a
 * sign-in), its public key, the kinds it may send, who sees what it sends,
 * its day's caps, the addresses it may come from and a backfill allowance —
 * after a passkey or a code (the route's `connect_app`). One that acts as
 * somebody else waits until they turn it on themselves. Owners see every
 * app and change what it may do; its person sees theirs and may remove it.
 * Nobody else is given any.
 *
 * **The app's side** (`/api/v1/apps/*`, signed): `authenticate` checks a
 * request in the contract's order, each with its own code — the headers,
 * the keyid, the app's state, its address, https, the window, the
 * signature, the nonce (kept once the signature verifies, so a stranger
 * fills nothing), its person, the route's scope, and its rate. What it
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
  keyId: string;
  householdId: string;
  accountId: string;
  memberId: string;
  role: Role;
  name: string;
  memberName: string;
  timezone: string;
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
}

/** A file an app sends: the multipart part, and what the route knows of the rest of the body. */
export interface AppFile {
  filename: string;
  mime: string;
  stream: Readable;
  truncated: () => boolean;
  /** Reads the body to its end, refusing anything after the file. */
  finished: () => Promise<void>;
  /** Whether the body's bytes, now all read, are what Content-Digest says. */
  digestOk: () => Promise<boolean>;
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
const digestMismatch = () => err(400, 'content_digest_mismatch');
const inProgress = () =>
  new ApiError(
    409,
    'upload_in_progress',
    'This external_id is still arriving. Ask its status after a moment.',
    { retriable: true, retryAfter: 5 },
  );

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
 * what it sends seen more widely. Narrowing, or a new name, is not.
 */
function widens(
  app: AppRow,
  set: Record<string, unknown>,
  ip: string[] | undefined,
  now: number,
): boolean {
  if (Array.isArray(set.allowed_kinds)) {
    if ((set.allowed_kinds as string[]).some((k) => !app.allowed_kinds.includes(k))) return true;
  }
  if (typeof set.daily_files === 'number' && set.daily_files > app.daily_files) return true;
  if (typeof set.daily_bytes === 'number' && set.daily_bytes > Number(app.daily_bytes)) {
    return true;
  }
  if (ip !== undefined && app.ip_allow.length > 0) {
    if (ip.length === 0 || ip.some((n) => !withinAny(n, app.ip_allow))) return true;
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
      (set.backfill_bytes as number) > Number(app.backfill_bytes ?? 0)
    ) {
      return true;
    }
  }
  return false;
}

/** A connection string: `fdvapp1.` and base64url of its JSON. No secret is in it. */
export function connectionString(c: AppConnection): string {
  return `${APP_CONNECTION_PREFIX}${Buffer.from(JSON.stringify(c), 'utf8').toString('base64url')}`;
}

interface AppRow {
  id: string;
  name: string;
  account_id: string;
  member_id: string;
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
}

const APP_COLUMNS = [
  'a.id',
  'a.name',
  'a.account_id',
  'a.member_id',
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
] as const;

interface KeyRow {
  id: string;
  public_key: Buffer;
  added_by: 'owner' | 'app';
  created_at: Date;
  confirmed_at: Date | null;
  first_used_at: Date | null;
  retired_at: Date | null;
}

const KEY_COLUMNS = [
  'id',
  'public_key',
  'added_by',
  'created_at',
  'confirmed_at',
  'first_used_at',
  'retired_at',
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
}

/** The state an app is answered for what it sent, as `POST /apps/intake` answers it. */
function stateOf(r: IntakeRow): AppIntakeState {
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

/** An app's key, as an app or Settings is told of it. */
function keyView(k: KeyRow, all: readonly KeyRow[]): AppKeyView {
  // Seven days after a newer, confirmed key of its app was first used, it
  // retires by itself.
  const newer = all
    .filter(
      (n) =>
        n.id !== k.id &&
        n.retired_at === null &&
        n.confirmed_at !== null &&
        n.created_at > k.created_at,
    )
    .map((n) => n.first_used_at)
    .filter((d): d is Date => d !== null)
    .sort((x, y) => x.getTime() - y.getTime())[0];
  return {
    key_id: k.id,
    fingerprint: fingerprintOf(k.public_key),
    added_by: k.added_by,
    created_at: k.created_at.toISOString(),
    pending: k.confirmed_at === null,
    first_used_at: k.first_used_at ? k.first_used_at.toISOString() : null,
    retires_at: newer ? new Date(newer.getTime() + APP_KEY_RETIRE_DAYS * DAY).toISOString() : null,
  };
}

/** A key live now: not retired, and not past seven days after a newer one's first use. */
function liveKeys(keys: readonly KeyRow[], now: number): KeyRow[] {
  return keys.filter((k) => {
    if (k.retired_at) return false;
    const until = keyView(k, keys).retires_at;
    return !until || new Date(until).getTime() > now;
  });
}

export class AppService {
  /** Signed requests each app made this minute: the rate. */
  private readonly rate = new Map<string, { minute: number; n: number }>();

  constructor(
    private readonly db: Db,
    private readonly batches: BatchService,
    private readonly opts: AppOptions,
  ) {}

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

  /** The person an app acts as, as the batches see them: asking as themselves, with no session. */
  private principalOf(c: AppCaller): Principal {
    return {
      accountId: c.accountId,
      sessionId: '',
      householdId: c.householdId,
      memberId: c.memberId,
      role: c.role,
      seesAdults: seesAdults(c.role, null),
    };
  }

  // ------------------------------------------------------------ signing

  /**
   * A signed request, checked in the order the contract gives, each refusal
   * with its own code. The nonce is kept only once the signature verifies.
   * Answers the app and its person as they are now, and the signature, for
   * the body's digest.
   */
  async authenticate(
    req: FastifyRequest,
    route: AppRoute,
  ): Promise<{ caller: AppCaller; signature: ParsedSignature }> {
    // 1. Signature headers, and nothing else that names a caller.
    const h = req.headers;
    const other = h.authorization !== undefined || (h.cookie !== undefined && /\S/.test(h.cookie));
    const parsed = parseSignature(h);
    if (other || ('code' in parsed && parsed.code === 'app_signature_required')) {
      throw err(401, 'app_signature_required');
    }
    // 2. As the profile says.
    if ('code' in parsed) throw err(401, 'signature_malformed', { detail: parsed.detail });
    const s = parsed;
    // 3. A live key of a live app.
    const found = await sql<{
      household_id: string;
      public_key: Buffer;
      key_live: boolean;
      key_pending: boolean;
      revoked: boolean;
      paused_reason: 'owner' | 'restored' | null;
      approval: 'waiting' | 'approved';
      ip_allow: string[];
      signed_after: Date | null;
    }>`select household_id, public_key, key_live, key_pending, revoked, paused_reason, approval,
              ip_allow, signed_after
         from connected_app_find(${s.appId}::uuid, ${s.keyId}::uuid)`.execute(this.db);
    const at = found.rows[0];
    // A removed app's keys retired with it: it is told it was removed.
    if (at?.revoked) throw err(401, 'app_revoked');
    if (!at || !at.key_live) throw err(401, 'app_key_unknown');
    // A key the app added itself signs nothing until it is confirmed in Settings.
    if (at.key_pending) throw err(401, 'app_key_pending');
    // The base, and whether the signature verifies, worked out once: a
    // refusal is written against the app only when the request is truly
    // its own, so a stranger who knows an app's id writes nothing.
    const { path, query } = pathAndQuery(req.raw.url ?? req.url);
    const base = signatureBase({
      method: req.method,
      path,
      query,
      digestHeader: s.digestHeader,
      params: s.params,
    });
    let verified: boolean | null = null;
    const isGenuine = () => (verified ??= verifies(at.public_key, base, s.signature));
    const refuse = async (e: ApiError): Promise<never> => {
      if (isGenuine()) {
        await this.noteRefusal(at.household_id, s.appId, e.code).catch(() => undefined);
      }
      throw e;
    };
    // 4. On, and turned on by its person — but for GET /apps/me.
    if (!route.anyState) {
      if (at.paused_reason) await refuse(err(403, 'app_paused'));
      if (at.approval !== 'approved') await refuse(err(403, 'app_not_approved'));
    }
    // 5. From an address it may come from.
    if (!addressAllowed(clientAddressOf(req), at.ip_allow ?? [])) {
      await refuse(err(403, 'address_not_allowed'));
    }
    // 6. Over https, as the trusted proxies say; plain http only for a vault
    // on this machine, asked from this machine: its address and the socket.
    if (req.protocol !== 'https' && !(localBase(this.opts.baseUrl) && loopbackSocket(req))) {
      await refuse(err(403, 'https_required'));
    }
    // 7. Within the window, to the millisecond, so a nonce is always kept
    // past the last moment its `created` is taken; and never from before a
    // restore, whose forgotten nonces would otherwise open a replay.
    const now = this.now();
    const offMs = s.created * 1000 - now;
    if (Math.abs(offMs) > APP_SIGNATURE_WINDOW_SECONDS * 1000) {
      const off = Math.round(Math.abs(offMs) / 1000);
      await refuse(
        err(401, 'signature_stale', {
          detail: `created ${off} seconds ${offMs > 0 ? 'ahead of' : 'behind'} the vault's clock`,
        }),
      );
    }
    if (at.signed_after && s.created * 1000 < at.signed_after.getTime()) {
      await refuse(
        err(401, 'signature_stale', { detail: 'created before the vault was restored' }),
      );
    }
    // 8. The signature verifies.
    if (!isGenuine()) throw err(401, 'signature_invalid');
    // 9. The nonce is new: kept for its window, the key's first use and the
    // app's last noted, and the app and its person read as they are now.
    const read = await withSystem(this.db, at.household_id, async (trx) => {
      await trx
        .deleteFrom('connected_app_nonce')
        .where('app_id', '=', s.appId)
        .where('expires_at', '<', new Date(now))
        .execute();
      const kept = await trx
        .insertInto('connected_app_nonce')
        .values({
          household_id: at.household_id,
          app_id: s.appId,
          nonce: s.nonce,
          // A second past the window's last accepted instant.
          expires_at: new Date((s.created + APP_SIGNATURE_WINDOW_SECONDS + 1) * 1000),
        })
        .onConflict((oc) => oc.columns(['app_id', 'nonce']).doNothing())
        .returning('nonce')
        .executeTakeFirst();
      if (!kept) return null;
      await trx
        .updateTable('connected_app_key')
        .set({ first_used_at: sql<Date>`now()` })
        .where('id', '=', s.keyId)
        .where('first_used_at', 'is', null)
        .execute();
      await trx
        .updateTable('connected_app')
        .set({ last_used_at: sql<Date>`now()` })
        .where('id', '=', s.appId)
        .execute();
      return trx
        .selectFrom('connected_app as a')
        .innerJoin('member as m', (j) =>
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
        .where('a.id', '=', s.appId)
        .executeTakeFirst();
    });
    if (read === null) await refuse(err(401, 'nonce_reused'));
    const app = read as NonNullable<typeof read>;
    if (!app || app.revoked_at !== null || !app.role || !['owner', 'adult'].includes(app.role)) {
      throw err(401, 'app_revoked');
    }
    // 10. Its person may act now.
    const person = {
      suspend_reason: app.suspend_reason ?? null,
      suspended_at: app.suspended_at ?? null,
      suspended_until: app.suspended_until ?? null,
    };
    if (lockInEffect(person)) await refuse(err(403, 'member_locked'));
    if (suspensionInEffect(person)) await refuse(err(403, 'member_paused'));
    // 11. The route is in its scopes.
    if (route.scope && !app.scopes.includes(route.scope)) {
      await refuse(err(403, 'scope_not_granted'));
    }
    // And its rate: so many signed requests a minute.
    const minute = Math.floor(now / 60_000);
    const r = this.rate.get(s.appId);
    const n = r && r.minute === minute ? r.n + 1 : 1;
    this.rate.set(s.appId, { minute, n });
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
        appId: s.appId,
        keyId: s.keyId,
        householdId: at.household_id,
        accountId: app.account_id,
        memberId: app.member_id,
        role: app.role,
        name: app.name,
        memberName: app.display_name,
        timezone: householdZone(app.timezone),
        scopes: app.scopes as AppScope[],
        state: appState(app),
        pausedReason: app.paused_reason,
      },
      signature: s,
    };
  }

  /** A refusal after the signature was taken (a body's digest), counted as the rest are. */
  async countRefusal(c: AppCaller, code: string): Promise<void> {
    await this.noteRefusal(c.householdId, c.appId, code).catch(() => undefined);
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
    const { app, keys, kinds, household } = await withSystem(
      this.db,
      c.householdId,
      async (trx) => {
        const app = await trx
          .selectFrom('connected_app as a')
          .select(APP_COLUMNS)
          .where('a.id', '=', c.appId)
          .executeTakeFirstOrThrow();
        const keys = (await trx
          .selectFrom('connected_app_key')
          .select(KEY_COLUMNS)
          .where('app_id', '=', c.appId)
          .orderBy('created_at')
          .execute()) as KeyRow[];
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
        return { app, keys, kinds, household };
      },
    );
    const day = localToday(c.timezone, new Date(now));
    const caps = capsOf(app, now);
    const sent = today(app, day);
    return {
      app: { id: app.id, name: app.name, created_at: app.created_at.toISOString() },
      state: c.state,
      ...(c.pausedReason ? { paused_reason: c.pausedReason } : {}),
      acting_as: { name: c.memberName },
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
        auto_file: false,
      },
      limits: {
        max_upload_bytes: this.opts.maxUploadBytes,
        accepted_types: Object.keys(UPLOAD_KINDS),
        files_per_day: caps.files,
        files_today: sent.files,
        bytes_per_day: caps.bytes,
        bytes_today: sent.bytes,
        read_bytes_per_day: APP_DEFAULT_READ_BYTES,
        read_bytes_today: 0,
        links_per_hour: APP_DEFAULT_LINKS_PER_HOUR,
        requests_per_minute: APP_REQUESTS_PER_MINUTE,
        day_resets_at: nextLocalMidnight(c.timezone, new Date(now)).toISOString(),
      },
      backfill: caps.backfill
        ? {
            until: (app.backfill_until as Date).toISOString(),
            files_per_day: caps.files,
            bytes_per_day: caps.bytes,
            auto_file: false,
          }
        : null,
      keys: liveKeys(keys, now).map((k) => {
        const v = keyView(k, keys);
        return {
          key_id: v.key_id,
          fingerprint: v.fingerprint,
          added_by: v.added_by,
          created_at: v.created_at,
          pending: v.pending === true,
          retires_at: v.retires_at,
        };
      }),
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
    return a;
  }

  /**
   * Today's batch of this app's, on the household's calendar, with room in
   * it: "From MonTra, 16 November 2026", and a part more past BATCH_MAX_FILES.
   * As its person; the database lets a batch name only a live app of its
   * own member (0109). Who sees what it sends is the app's default.
   */
  private async appBatch(p: Principal, c: AppCaller, day: string, past = 0): Promise<string> {
    return withPrincipal(this.db, p, async (trx) => {
      const app = await this.live(trx, c);
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
          created_by: c.accountId,
          member_id: c.memberId,
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
  private async kindAllowed(p: Principal, app: AppRow, kind: string): Promise<boolean> {
    if (!app.allowed_kinds.includes(kind)) return false;
    const t = await withPrincipal(this.db, p, (trx) =>
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
   * `POST /apps/intake`: one file into its person's Inbox, or, for an
   * external id sent before, what became of it. Answered only once its
   * bytes are stored and checked and its row committed: from then the
   * vault has it, and a restart loses nothing.
   */
  async send(
    c: AppCaller,
    metadata: AppIntakeMetadata,
    file: AppFile,
    meta: RequestMeta,
  ): Promise<{ status: 200 | 201; state: AppIntakeState }> {
    const p = this.principalOf(c);
    const { external_id: externalId, hints } = metadata;

    // The external id claimed, or what it was answered before.
    type Claim =
      | { kind: 'new'; id: string; prior: IntakeRow | null; app: AppRow }
      | { kind: 'replay'; row: IntakeRow };
    // This send's own token: every write it makes names it, so once a later
    // send has taken the id over, this one changes nothing.
    const attempt = randomUUID();
    const claim: Claim = await withPrincipal(this.db, p, async (trx) => {
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
      };
      if (!row) {
        // Two first sends at once: the second finds the first's row, and is
        // told it is still arriving.
        const made = await trx
          .insertInto('connected_app_intake')
          .values({
            household_id: c.householdId,
            app_id: c.appId,
            member_id: c.memberId,
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
      if (!(await file.digestOk())) throw digestMismatch();
      if (!claim.row.sha256 || !hash.digest().equals(claim.row.sha256)) {
        throw err(409, 'external_id_conflict');
      }
      return { status: 200, state: stateOf(claim.row) };
    }

    // What became of a send that did not land: put back as it was.
    const letGo = async () => {
      await withPrincipal(this.db, p, async (trx) => {
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
      await withPrincipal(this.db, p, (trx) =>
        trx
          .updateTable('connected_app_intake')
          .set({ state: 'refused', refusal, decided_at: sql<Date>`now()`, hints_sealed: null })
          .where('id', '=', claim.id)
          .where('state', '=', 'arriving')
          .where('attempt', '=', attempt)
          .execute(),
      ).catch(() => undefined);
    };
    const drainAndCheck = async () => {
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
      return file.digestOk();
    };

    // A kind it may not send: refused — a record of the refusal kept, never
    // the file or what the app said of it.
    if (hints.kind && !(await this.kindAllowed(p, claim.app, hints.kind))) {
      try {
        if (!(await drainAndCheck())) throw digestMismatch();
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

    let sha: Buffer | null = null;
    let batchId: string | undefined;
    try {
      let past = 0;
      for (let tries = 0; ; tries++) {
        batchId = await this.appBatch(p, c, day, past);
        try {
          await this.batches.addItem(
            p,
            batchId,
            {
              filename: file.filename,
              mime: file.mime,
              // An app's file is never a health record kept as it is (H5).
              records: false,
              stream: file.stream,
              truncated: file.truncated,
              finished: async () => {
                await file.finished();
                // The body's digest, now that all of it has been read: a body
                // changed in flight keeps nothing.
                if (!(await file.digestOk())) throw digestMismatch();
              },
              stillAllowed: async (trx) => {
                await this.live(trx, c);
              },
              made: async (trx, item) => {
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
                  .set({ incoming_file_id: item.id, hints_sealed: sealed })
                  .where('id', '=', claim.id)
                  .where('state', '=', 'arriving')
                  .where('attempt', '=', attempt)
                  .returning('id')
                  .executeTakeFirst();
                // Taken over by a later send: this one makes no item.
                if (!tied) throw inProgress();
              },
              hashed: (h) => {
                sha = h;
              },
              arrived: async (trx, bytes) => {
                // Within the day's caps, counted with the app held, so two
                // files at once never pass them together.
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
                // Taken over by a later send while its bytes came: its item
                // is thrown away, and the later send's stands.
                if (!landed) throw inProgress();
                await appendAudit(trx, {
                  householdId: c.householdId,
                  actorAccountId: c.accountId,
                  action: 'app.sent',
                  objectType: 'member',
                  objectId: c.memberId,
                  detail: { app_id: c.appId, app: c.name },
                  ip: meta.ip,
                });
              },
            },
            meta,
          );
          break;
        } catch (e) {
          // Filled meanwhile by files sent at once: the next part.
          if (e instanceof ApiError && e.code === 'batch_full' && tries < 3) {
            past = await this.partOf(p, batchId);
            continue;
          }
          throw e;
        }
      }
    } catch (e) {
      if (batchId) await this.batches.dropIfEmpty(p, batchId).catch(() => undefined);
      if (e instanceof ApiError && e.code === 'too_large') {
        await refused('too_large');
      } else if (e instanceof ApiError && e.code === 'unsupported_type') {
        // Refused for what its bytes are: so said, once the body is known whole.
        const whole = await drainAndCheck().catch(() => false);
        if (whole) await refused('unsupported_type');
        else {
          await letGo();
          throw digestMismatch();
        }
      } else {
        await letGo();
      }
      throw e;
    }
    const row = await withPrincipal(this.db, p, (trx) =>
      trx
        .selectFrom('connected_app_intake')
        .selectAll()
        .where('id', '=', claim.id)
        .executeTakeFirstOrThrow(),
    );
    return { status: 201, state: stateOf(row) };
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
        detail: { app_id: c.appId, app: c.name },
        ip: meta.ip,
      });
    }
  }

  /** `GET /apps/intake/{external_id}`: what became of it; one never sent, or still arriving, is 404. */
  async status(c: AppCaller, externalId: string, meta: RequestMeta): Promise<AppIntakeState> {
    if (!EXTERNAL_ID_PATTERN.test(externalId)) throw notFound();
    const p = this.principalOf(c);
    return withPrincipal(this.db, p, async (trx) => {
      const row = (await trx
        .selectFrom('connected_app_intake')
        .selectAll()
        .where('app_id', '=', c.appId)
        .where('external_id', '=', externalId)
        .executeTakeFirst()) as IntakeRow | undefined;
      if (!row || row.state === 'arriving') throw notFound();
      await this.checked(c, trx, meta);
      return stateOf(row);
    });
  }

  /** `GET /apps/intake?external_ids=`: up to 100 at once, and those never sent. */
  async statuses(c: AppCaller, ids: string[], meta: RequestMeta): Promise<AppIntakeStates> {
    if (ids.length === 0 || ids.length > APP_STATUS_MAX_IDS) {
      throw invalid(`Ask for 1 to ${APP_STATUS_MAX_IDS} external_ids at a time.`, 'external_ids');
    }
    const bad = ids.find((id) => !EXTERNAL_ID_PATTERN.test(id));
    if (bad !== undefined) throw invalid('That is not an external_id.', 'external_ids');
    const asked = [...new Set(ids)];
    const p = this.principalOf(c);
    return withPrincipal(this.db, p, async (trx) => {
      const rows = (await trx
        .selectFrom('connected_app_intake')
        .selectAll()
        .where('app_id', '=', c.appId)
        .where('external_id', 'in', asked)
        .where('state', '<>', 'arriving')
        .execute()) as IntakeRow[];
      await this.checked(c, trx, meta);
      const by = new Map(rows.map((r) => [r.external_id, r]));
      return {
        items: asked.flatMap((id) => {
          const r = by.get(id);
          return r ? [stateOf(r)] : [];
        }),
        unknown: asked.filter((id) => !by.has(id)),
      };
    });
  }

  /**
   * `DELETE /apps/intake/{external_id}`: a waiting item taken out of the
   * Inbox, as its person's Remove would, and said `withdrawn`. A filed one
   * is `409 already_decided`; one removed or refused already is answered
   * as it is.
   */
  async withdraw(c: AppCaller, externalId: string, meta: RequestMeta): Promise<AppIntakeState> {
    if (!EXTERNAL_ID_PATTERN.test(externalId)) throw notFound();
    const p = this.principalOf(c);
    const read = () =>
      withPrincipal(this.db, p, async (trx) => {
        const row = (await trx
          .selectFrom('connected_app_intake as i')
          .leftJoin('incoming_file as f', 'f.id', 'i.incoming_file_id')
          .selectAll('i')
          .select('f.batch_id')
          .where('i.app_id', '=', c.appId)
          .where('i.external_id', '=', externalId)
          .executeTakeFirst()) as (IntakeRow & { batch_id: string | null }) | undefined;
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
    if (row.state !== 'waiting') return stateOf(row);
    if (!row.batch_id || !row.incoming_file_id) throw notFound();
    await this.batches.removeItem(p, row.batch_id, row.incoming_file_id, meta, async (trx) => {
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
        objectId: c.memberId,
        detail: { app_id: c.appId, app: c.name },
        ip: meta.ip,
      });
    });
    const after = await read();
    if (!after) throw notFound();
    return stateOf(after);
  }

  // ---------------------------------------------------------- the keys

  /**
   * `POST /apps/keys`: a key the app adds for rotation, signed with a
   * current one. It is pending — it signs nothing — until an owner, or the
   * person the app acts as, confirms it in Settings, so a stolen key cannot
   * add one of its own that outlives it. Two live at most (`409 key_limit`,
   * pending ones counted); one already live in the household is `409
   * key_exists`. The owners are emailed, and the person it acts as.
   */
  async appAddsKey(c: AppCaller, publicKey: unknown, meta: RequestMeta): Promise<AppKeyAdded> {
    const raw = typeof publicKey === 'string' ? rawPublicKey(publicKey) : null;
    if (!raw) {
      throw invalid(
        'public_key is "ed25519:" and 43 base64url characters, or a PEM PUBLIC KEY.',
        'public_key',
      );
    }
    const made = await withSystem(this.db, c.householdId, async (trx) => {
      const k = await this.insertKey(trx, c.householdId, c.appId, raw, 'app');
      await appendAudit(trx, {
        householdId: c.householdId,
        actorAccountId: c.accountId,
        action: 'app.key_added',
        objectType: 'member',
        objectId: c.memberId,
        detail: { app_id: c.appId, app: c.name, by: 'app', fingerprint: fingerprintOf(raw) },
        ip: meta.ip,
      });
      const owners = await trx
        .selectFrom('account_household')
        .select('account_id')
        .where('role', '=', 'owner')
        .execute();
      return { k, owners: owners.map((o) => o.account_id) };
    });
    await this.opts
      .alert({
        householdId: c.householdId,
        accountIds: [...new Set([...made.owners, c.accountId])],
        subject: `A new key was added to ${c.name}`,
        body: `${c.name}, a connected app acting as ${c.memberName}, added a new key to sign its requests with (${fingerprintOf(raw)}). It works only once an owner or ${c.memberName} confirms it in Settings → Connected apps. If you did not expect this, do not confirm it, and remove the app there.`,
        emailOnly: true,
      })
      .catch(() => undefined);
    return {
      key_id: made.k.id,
      keyid: `${c.appId}.${made.k.id}`,
      fingerprint: fingerprintOf(raw),
      created_at: made.k.created_at.toISOString(),
      pending: true,
    };
  }

  /** A key inserted: `key_limit`, `key_exists` as the contract says. */
  private async insertKey(
    trx: Db,
    householdId: string,
    appId: string,
    raw: Buffer,
    by: 'owner' | 'app',
  ): Promise<{ id: string; created_at: Date }> {
    const keys = (await trx
      .selectFrom('connected_app_key')
      .select(KEY_COLUMNS)
      .where('app_id', '=', appId)
      .execute()) as KeyRow[];
    const live = liveKeys(keys, this.now());
    // Keys past their seven days, retired now that they are looked at.
    const lapsed = keys.filter((k) => k.retired_at === null && !live.includes(k)).map((k) => k.id);
    if (lapsed.length > 0) {
      await trx
        .updateTable('connected_app_key')
        .set({ retired_at: sql<Date>`now()` })
        .where('id', 'in', lapsed)
        .execute();
    }
    const taken = await trx
      .selectFrom('connected_app_key')
      .select('id')
      .where('public_key', '=', raw)
      .where('retired_at', 'is', null)
      .executeTakeFirst();
    if (taken) {
      throw new ApiError(409, 'key_exists', 'That key is already in use. Make a new key pair.');
    }
    if (live.length >= APP_KEYS_MAX) {
      throw new ApiError(
        409,
        'key_limit',
        `An app has ${APP_KEYS_MAX} keys at most. Retire the old key first.`,
      );
    }
    return trx
      .insertInto('connected_app_key')
      .values({
        household_id: householdId,
        app_id: appId,
        public_key: raw,
        added_by: by,
        // An owner's key is confirmed as it is added; the app's waits.
        confirmed_at: by === 'owner' ? sql<Date>`now()` : null,
      })
      .returning(['id', 'created_at'])
      .executeTakeFirstOrThrow();
  }

  /**
   * `DELETE /apps/keys/{key_id}`: a key the app added itself; never one an
   * owner added (`409 key_added_by_owner`: that is Settings' to retire), the
   * key that signs this request, nor the last. The owners and the person it
   * acts as are emailed.
   */
  async appRetiresKey(c: AppCaller, keyId: string, meta: RequestMeta): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(keyId)) throw notFound();
    const told = await withSystem(this.db, c.householdId, async (trx) => {
      await trx
        .selectFrom('connected_app')
        .select('id')
        .where('id', '=', c.appId)
        .forUpdate()
        .execute();
      const keys = (await trx
        .selectFrom('connected_app_key')
        .select(KEY_COLUMNS)
        .where('app_id', '=', c.appId)
        .execute()) as KeyRow[];
      const live = liveKeys(keys, this.now());
      const k = live.find((x) => x.id === keyId.toLowerCase());
      if (!k) throw notFound();
      if (k.added_by !== 'app') {
        throw new ApiError(
          409,
          'key_added_by_owner',
          'An owner added that key: it is retired in Settings → Connected apps.',
        );
      }
      if (k.id === c.keyId || live.length <= 1) {
        throw new ApiError(
          409,
          'key_in_use',
          'That key signs this request, or is the app’s last key. Sign with the other key first.',
        );
      }
      await trx
        .updateTable('connected_app_key')
        .set({ retired_at: sql<Date>`now()` })
        .where('id', '=', k.id)
        .execute();
      await appendAudit(trx, {
        householdId: c.householdId,
        actorAccountId: c.accountId,
        action: 'app.key_retired',
        objectType: 'member',
        objectId: c.memberId,
        detail: {
          app_id: c.appId,
          app: c.name,
          by: 'app',
          fingerprint: fingerprintOf(k.public_key),
        },
        ip: meta.ip,
      });
      return { owners: await this.owners(trx), fingerprint: fingerprintOf(k.public_key) };
    });
    await this.keyRetiredAlert(
      c.householdId,
      [...told.owners, c.accountId],
      c.name,
      c.memberName,
      told.fingerprint,
    );
  }

  /** The household's owners' sign-ins, for the emails about an app's keys. */
  private async owners(trx: Db): Promise<string[]> {
    const rows = await trx
      .selectFrom('account_household')
      .select('account_id')
      .where('role', '=', 'owner')
      .execute();
    return rows.map((o) => o.account_id);
  }

  /** A key retired: the owners and the person the app acts as are told, by email. */
  private async keyRetiredAlert(
    householdId: string,
    accountIds: string[],
    app: string,
    member: string,
    fingerprint: string,
  ): Promise<void> {
    await this.opts
      .alert({
        householdId,
        accountIds: [...new Set(accountIds)],
        subject: `A key of ${app} was retired`,
        body: `A key ${app} signed its requests with (${fingerprint}) was retired; ${app} acts as ${member}. If you did not expect this, look at Settings → Connected apps.`,
        emailOnly: true,
      })
      .catch(() => undefined);
  }

  /**
   * An owner widened what an app acting as somebody else may do, or gave it
   * a key: it waits again until that person turns it on, with their own
   * passkey or code, so an owner never acts as another adult unseen. Inside
   * the change's transaction; whether it now waits.
   */
  private async reapprove(
    trx: Db,
    p: Principal,
    app: { id: string; member_id: string },
  ): Promise<boolean> {
    if (app.member_id === p.memberId) return false;
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

  // --------------------------------------------- the family's side (Settings)

  /** Whom an app may act as: an owner or an adult with a sign-in here. */
  private async actingMember(
    trx: Db,
    memberId: string,
  ): Promise<{ account_id: string; display_name: string }> {
    const m = await trx
      .selectFrom('account_household as ah')
      .innerJoin('member as m', (j) =>
        j.onRef('m.id', '=', 'ah.member_id').onRef('m.household_id', '=', 'ah.household_id'),
      )
      .select(['ah.account_id', 'm.display_name'])
      .where('ah.member_id', '=', memberId)
      .where('ah.role', 'in', ['owner', 'adult'])
      .executeTakeFirst();
    if (!m) {
      throw invalid('An app acts as an owner or an adult who signs in.', 'member_id');
    }
    return m;
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

  /** Addresses and networks, checked and written as the database keeps them. */
  private async checkedAddresses(trx: Db, list: string[]): Promise<string[]> {
    if (list.length > APP_IP_ALLOW_MAX) {
      throw invalid(`${APP_IP_ALLOW_MAX} addresses or networks at most.`, 'ip_allow');
    }
    for (const entry of list) {
      const [net = '', bits, more] = entry.trim().split('/');
      const v = isIP(net);
      const max = v === 4 ? 32 : 128;
      if (
        v === 0 ||
        more !== undefined ||
        (bits !== undefined && (!/^\d{1,3}$/.test(bits) || Number(bits) > max))
      ) {
        throw invalid(
          `“${entry}” is not an address or a network (203.0.113.7, 203.0.113.0/24, 2001:db8::/64).`,
          'ip_allow',
        );
      }
    }
    if (list.length === 0) return [];
    const out = await sql<{ net: string }>`
      select distinct network(x::inet)::text as net from unnest(${list.map((x) => x.trim())}::text[]) x`.execute(
      trx,
    );
    return out.rows.map((r) => r.net).sort();
  }

  /** Caps and a backfill, checked against the operator's ceilings. */
  private checkedCaps(input: {
    daily_files?: number;
    daily_bytes?: number;
    backfill?: ConnectedAppInput['backfill'];
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
    if (input.daily_bytes !== undefined) {
      out.daily_bytes = whole(
        input.daily_bytes,
        1024 * 1024,
        bytes,
        'daily_bytes',
        `Bytes a day: 1 MB to ${bytes}.`,
      );
    }
    if (input.backfill !== undefined) {
      if (input.backfill === null) {
        out.backfill_until = null;
        out.backfill_files = null;
        out.backfill_bytes = null;
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
      }
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
      .innerJoin('member as m', (j) =>
        j.onRef('m.id', '=', 'a.member_id').onRef('m.household_id', '=', 'a.household_id'),
      )
      .select(APP_COLUMNS)
      .select('m.display_name')
      .where('a.revoked_at', 'is', null)
      .orderBy('a.created_at', 'desc');
    if (only) q = q.where('a.id', '=', only);
    const apps = (await q.execute()) as Array<AppRow & { display_name: string }>;
    if (apps.length === 0) return [];
    const ids = apps.map((a) => a.id);
    const keys = (await trx
      .selectFrom('connected_app_key')
      .select([
        'id',
        'app_id',
        'public_key',
        'added_by',
        'created_at',
        'confirmed_at',
        'first_used_at',
        'retired_at',
      ])
      .where('app_id', 'in', ids)
      .orderBy('created_at')
      .execute()) as Array<KeyRow & { app_id: string }>;
    // What it sent, waiting and filed: its person's alone (0109's rule).
    const counted = await trx
      .selectFrom('connected_app_intake')
      .select(['app_id', 'state'])
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('app_id', 'in', ids)
      .where('member_id', '=', p.memberId)
      .where('state', 'in', ['waiting', 'filed'])
      .groupBy(['app_id', 'state'])
      .execute();
    const hh = await trx.selectFrom('household').select('timezone').executeTakeFirstOrThrow();
    const now = this.now();
    const day = localToday(householdZone(hh.timezone), new Date(now));
    const instance = await this.opts.instanceId().catch(() => null);
    const address = this.address();
    return apps.map((a) => {
      const all = keys.filter((k) => k.app_id === a.id);
      const live = liveKeys(all, now);
      const newest = live[live.length - 1];
      const mine = a.member_id === p.memberId;
      const n = (state: string) =>
        Number(counted.find((r) => r.app_id === a.id && r.state === state)?.n ?? 0);
      const sent = today(a, day);
      return {
        id: a.id,
        name: a.name,
        member_id: a.member_id,
        member_name: a.display_name,
        mine,
        created_at: a.created_at.toISOString(),
        state: appState(a),
        paused_reason: a.paused_reason,
        scopes: a.scopes as AppScope[],
        allowed_kinds: a.allowed_kinds,
        default_visibility: a.default_visibility,
        auto_file: a.auto_file,
        daily_files: a.daily_files,
        daily_bytes: Number(a.daily_bytes),
        backfill:
          a.backfill_until && a.backfill_until.getTime() > now
            ? {
                until: a.backfill_until.toISOString(),
                files_per_day: a.backfill_files ?? a.daily_files,
                bytes_per_day: Number(a.backfill_bytes ?? a.daily_bytes),
              }
            : null,
        ip_allow: a.ip_allow ?? [],
        keys: live.map((k) => keyView(k, all)),
        last_used_at: a.last_used_at ? a.last_used_at.toISOString() : null,
        today: sent,
        refused_today: a.refused_on === day ? a.refused_today : 0,
        last_refusal: a.refused_on === day ? a.last_refusal : null,
        counts: mine ? { waiting: n('waiting'), filed: n('filed') } : null,
        connection_string: newest
          ? connectionString({
              url: address.url,
              app_id: a.id,
              key_id: newest.id,
              instance_id: instance,
              fingerprint: fingerprintOf(newest.public_key),
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
   * a passkey or a code). On at once when it acts as them; otherwise it
   * waits for its person, who is emailed.
   */
  async create(
    p: Principal,
    input: ConnectedAppInput,
    meta: RequestMeta,
  ): Promise<ConnectedAppView> {
    if (p.role !== 'owner') throw ownersOnly();
    const name = AppService.nameOf(input.name);
    const raw = typeof input.public_key === 'string' ? rawPublicKey(input.public_key) : null;
    if (!raw) {
      throw invalid(
        'Paste the app’s public key: "ed25519:" and 43 characters, or a PEM PUBLIC KEY block.',
        'public_key',
      );
    }
    if (!Array.isArray(input.allowed_kinds)) {
      throw invalid('Choose the kinds it may send.', 'allowed_kinds');
    }
    const caps = this.checkedCaps(input);
    const made = await withPrincipal(this.db, p, async (trx) => {
      const person = await this.actingMember(trx, input.member_id);
      const kinds = await this.checkedKinds(trx, input.allowed_kinds);
      const ip = await this.checkedAddresses(trx, input.ip_allow ?? []);
      const own = input.member_id === p.memberId;
      const id = randomUUID();
      await trx
        .insertInto('connected_app')
        .values({
          id,
          household_id: p.householdId,
          name,
          account_id: person.account_id,
          member_id: input.member_id,
          created_by: p.accountId,
          approval: own ? 'approved' : 'waiting',
          approved_at: own ? new Date() : null,
          scopes: [...APP_SCOPES_OFFERED],
          allowed_kinds: kinds,
          default_visibility: input.default_visibility ?? null,
          daily_files: APP_DEFAULT_DAILY_FILES,
          daily_bytes: APP_DEFAULT_DAILY_BYTES,
          ...caps,
          ip_allow: sql<string[]>`${ip}::cidr[]` as unknown as string[],
        })
        .execute();
      await this.insertKey(trx, p.householdId, id, raw, 'owner');
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'app.connected',
        objectType: 'member',
        objectId: input.member_id,
        detail: { app_id: id, app: name, fingerprint: fingerprintOf(raw) },
        ip: meta.ip,
      });
      return { id, own, person };
    });
    if (!made.own) {
      await this.opts
        .alert({
          householdId: p.householdId,
          accountIds: [made.person.account_id],
          subject: `${name} was connected to your sign-in`,
          body: `An owner connected ${name} to act as you: it can send documents into your Inbox. It does nothing until you turn it on in Settings → Connected apps. If you did not expect this, remove it there.`,
          emailOnly: true,
        })
        .catch(() => undefined);
    }
    return this.view(p, made.id);
  }

  /** `PATCH /connected-apps/{id}`: an owner changes what it may do (the route asked for the step-up). */
  async update(
    p: Principal,
    id: string,
    input: ConnectedAppChange,
    meta: RequestMeta,
  ): Promise<ConnectedAppView> {
    if (p.role !== 'owner') throw ownersOnly();
    const set: Record<string, unknown> = { ...this.checkedCaps(input) };
    if (input.name !== undefined) set.name = AppService.nameOf(input.name);
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
      let ip: string[] | undefined;
      if (input.allowed_kinds !== undefined) {
        if (!Array.isArray(input.allowed_kinds)) {
          throw invalid('Choose the kinds it may send.', 'allowed_kinds');
        }
        set.allowed_kinds = await this.checkedKinds(trx, input.allowed_kinds);
      }
      if (input.ip_allow !== undefined) {
        ip = await this.checkedAddresses(trx, input.ip_allow);
        set.ip_allow = sql`${ip}::cidr[]`;
      }
      if (Object.keys(set).length === 0) return null;
      const again =
        widens(app, set, ip, this.now()) && (await this.reapprove(trx, p, app))
          ? app.account_id
          : null;
      await trx.updateTable('connected_app').set(set).where('id', '=', id).execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'app.changed',
        objectType: 'member',
        objectId: app.member_id,
        detail: {
          app_id: id,
          app: set.name ?? app.name,
          fields: Object.keys(input).sort(),
          ...(again ? { approval: 'asked_again' } : {}),
        },
        ip: meta.ip,
      });
      return again ? { account: again, name: (set.name as string | undefined) ?? app.name } : null;
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

  /** `POST /connected-apps/{id}/keys`: an owner adds a key (the route asked for the step-up). */
  async addKey(
    p: Principal,
    id: string,
    publicKey: unknown,
    meta: RequestMeta,
  ): Promise<ConnectedAppKeyAdded> {
    if (p.role !== 'owner') throw ownersOnly();
    const raw = typeof publicKey === 'string' ? rawPublicKey(publicKey) : null;
    if (!raw) {
      throw invalid(
        'Paste the app’s public key: "ed25519:" and 43 characters, or a PEM PUBLIC KEY block.',
        'public_key',
      );
    }
    const key = await withPrincipal(this.db, p, async (trx) => {
      const app = await trx
        .selectFrom('connected_app')
        .select(['id', 'member_id', 'name', 'account_id'])
        .where('id', '=', id)
        .where('revoked_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!app) throw notHere();
      const k = await this.insertKey(trx, p.householdId, id, raw, 'owner');
      const again = await this.reapprove(trx, p, app);
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'app.key_added',
        objectType: 'member',
        objectId: app.member_id,
        detail: { app_id: id, app: app.name, by: 'owner', fingerprint: fingerprintOf(raw) },
        ip: meta.ip,
      });
      return { ...k, again: again ? app.account_id : null, name: app.name };
    });
    if (key.again) await this.askAgain(p.householdId, key.again, key.name);
    const view = await this.view(p, id);
    const added = view.keys.find((k) => k.key_id === key.id);
    if (!added) throw notHere();
    return { key: added, connection_string: view.connection_string };
  }

  /**
   * `DELETE /connected-apps/{id}/keys/{keyId}`: an owner retires a key,
   * pending or not; never the last. The owners and the person the app acts
   * as are emailed.
   */
  async retireKey(p: Principal, id: string, keyId: string, meta: RequestMeta): Promise<void> {
    if (p.role !== 'owner') throw ownersOnly();
    const told = await withPrincipal(this.db, p, async (trx) => {
      const app = await trx
        .selectFrom('connected_app')
        .select(['id', 'member_id', 'name', 'account_id'])
        .where('id', '=', id)
        .where('revoked_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!app) throw notHere();
      const keys = (await trx
        .selectFrom('connected_app_key')
        .select(KEY_COLUMNS)
        .where('app_id', '=', id)
        .execute()) as KeyRow[];
      const live = liveKeys(keys, this.now());
      const k = live.find((x) => x.id === keyId);
      if (!k) throw new ApiError(404, 'not_found', 'That key is not here.');
      if (live.length <= 1) {
        throw new ApiError(
          409,
          'key_in_use',
          'That is the app’s last key. Add its new key first, or remove the app.',
        );
      }
      await trx
        .updateTable('connected_app_key')
        .set({ retired_at: sql<Date>`now()` })
        .where('id', '=', k.id)
        .execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'app.key_retired',
        objectType: 'member',
        objectId: app.member_id,
        detail: {
          app_id: id,
          app: app.name,
          by: 'owner',
          fingerprint: fingerprintOf(k.public_key),
        },
        ip: meta.ip,
      });
      return {
        owners: await this.owners(trx),
        app,
        member: await this.memberName(trx, app.member_id),
        fingerprint: fingerprintOf(k.public_key),
      };
    });
    await this.keyRetiredAlert(
      p.householdId,
      [...told.owners, told.app.account_id],
      told.app.name,
      told.member,
      told.fingerprint,
    );
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
   * `POST /connected-apps/{id}/keys/{keyId}/confirm`: a key the app added
   * itself, confirmed by an owner or the person the app acts as (the route
   * asked for a passkey or a code); only then does it sign. An owner
   * confirming one for an app acting as somebody else sends it back to
   * them to turn on again, as an owner's own key would.
   */
  async confirmKey(
    p: Principal,
    id: string,
    keyId: string,
    meta: RequestMeta,
  ): Promise<ConnectedAppView> {
    const asked = await withPrincipal(this.db, p, async (trx) => {
      const app = await trx
        .selectFrom('connected_app')
        .select(['id', 'member_id', 'name', 'account_id'])
        .where('id', '=', id)
        .where('revoked_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!app || (p.role !== 'owner' && app.member_id !== p.memberId)) throw notHere();
      const keys = (await trx
        .selectFrom('connected_app_key')
        .select(KEY_COLUMNS)
        .where('app_id', '=', id)
        .execute()) as KeyRow[];
      const k = liveKeys(keys, this.now()).find((x) => x.id === keyId);
      if (!k) throw new ApiError(404, 'not_found', 'That key is not here.');
      if (k.confirmed_at !== null) return null;
      await trx
        .updateTable('connected_app_key')
        .set({ confirmed_at: sql<Date>`now()` })
        .where('id', '=', k.id)
        .execute();
      const again = await this.reapprove(trx, p, app);
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'app.key_confirmed',
        objectType: 'member',
        objectId: app.member_id,
        detail: {
          app_id: id,
          app: app.name,
          fingerprint: fingerprintOf(k.public_key),
          ...(again ? { approval: 'asked_again' } : {}),
        },
        ip: meta.ip,
      });
      return again ? { account: app.account_id, name: app.name } : null;
    });
    if (asked) await this.askAgain(p.householdId, asked.account, asked.name);
    return this.view(p, id);
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
 * away, or a role that can no longer act. Asked by whoever changed it,
 * after the change, inside its transaction.
 */
export async function logAppsEnded(
  trx: Db,
  p: Principal,
  person: { account_id: string; member_id: string },
  meta: RequestMeta,
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
  return ended.length;
}

/**
 * The emergency controls: every app acting as somebody stopped at once
 * — signed out everywhere (`signed_out`), their password stopped by an
 * owner (`owner_stopped`) — by the database's own connected_apps_revoke_for(),
 * with a line for each. Never on an ordinary password change. Inside the
 * caller's transaction; how many it stopped.
 */
export async function stopAppsOf(
  trx: Db,
  by: { householdId: string; actorAccountId: string },
  accountId: string,
  reason: 'signed_out' | 'owner_stopped',
  meta: RequestMeta,
): Promise<number> {
  const stopped = await sql<{ id: string; member_id: string; name: string }>`
    select id, member_id, name from connected_apps_revoke_for(${accountId}::uuid, ${reason})`.execute(
    trx,
  );
  for (const a of stopped.rows) {
    await appendAudit(trx, {
      householdId: by.householdId,
      actorAccountId: by.actorAccountId,
      action: 'app.revoked',
      objectType: 'member',
      objectId: a.member_id,
      detail: { app_id: a.id, app: a.name, reason },
      ip: meta.ip,
    });
  }
  return stopped.rows.length;
}
