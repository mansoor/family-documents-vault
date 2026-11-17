import {
  APP_EMPTY_DIGEST,
  APP_GRANTABLE_CATEGORIES,
  APP_HINTS,
  APP_LINK_COOKIE,
  APP_LINK_OPEN_SECONDS,
  APP_LINK_PAGE,
  APP_LINK_SESSION_MINUTES,
  APP_LINK_SESSION_PATH,
  APP_SCOPES_DEFAULT,
  APP_SCOPES_OFFERED,
  APP_SIGNATURE_WINDOW_SECONDS,
  APP_REFUSALS,
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
  type AppKeyView,
  type AppMe,
  type AppScope,
  type ConnectedAppGrantView,
  type ConnectedAppView,
  type DateValue,
  type Role,
} from '@fdv/shared';
import { fromBase64, signatureBaseOf, toBase64 } from '../apps.js';
import type { FetchLike, ResponseLike } from '../http.js';

/**
 * Connected apps in the fake vault (0.9.0, APP1): Settings → Connected apps
 * for whoever signs in, and the signed app routes — the signature checked
 * for real (Ed25519, Web Crypto), in the contract's order: the headers, the
 * keyid, the app's state, the window, the signature, the nonce, the scope,
 * the body's digest. What an app sends is kept on the app alone, by its
 * external id: no Inbox. Addresses, https and caps are the real vault's to
 * test.
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

export interface FakeAppKey {
  id: string;
  raw: Uint8Array;
  added_by: 'owner' | 'app';
  created_at: string;
  retired: boolean;
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
}

/** A link an app minted (APP3), and its session once opened. */
export interface FakeAppLink {
  token: string;
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
  member_id: string;
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
  nonces: Set<string>;
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
  }>;
  /** The fake's documents, as an app's reading needs them (APP2). */
  documents?: () => FakeReadableDoc[];
  /** A document moved to the Trash by an app's delete (APP3). */
  trash?: (id: string) => void;
  ok: (body: unknown, status?: number, headers?: Record<string, string>) => ResponseLike;
  /** Bytes as they are, for a download (APP2). */
  raw: (status: number, bytes: Uint8Array, headers: Record<string, string>) => ResponseLike;
  fail: (status: number, code: string, message: string, detail?: string) => ResponseLike;
  empty: () => ResponseLike;
  next: (what: string) => string;
  timezone: () => string;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const APP_ROUTE =
  /^\/api\/v1\/apps\/(me|intake|intake\/[^/]+|keys|keys\/[^/]+|documents|documents\/[^/]+|documents\/[^/]+\/content|documents\/[^/]+\/links|changes)$/;

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const own = new Uint8Array(bytes.length);
  own.set(bytes);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', own));
}
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
async function fingerprint(raw: Uint8Array): Promise<string> {
  return (
    hex(await sha256(raw))
      .slice(0, 32)
      .match(/.{4}/g) as string[]
  ).join(' ');
}
function rawKey(text: unknown): Uint8Array | null {
  if (typeof text !== 'string') return null;
  const m = /^ed25519:([A-Za-z0-9_-]{43})$/.exec(text.trim());
  if (!m) return null;
  const raw = fromBase64(m[1] as string);
  return raw.length === 32 ? raw : null;
}
const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

export function fakeAppRoutes(d: FakeAppDeps) {
  /** App and key ids are UUIDs, as the vault writes them; an app client takes no other. */
  // Counted by the vault's own counter: these routes are made for each
  // request, and a second app must never be given the first one's id.
  const uuid = () =>
    `00000000-0000-4000-8000-${Number(d.next('uuid').split('-').pop()).toString(16).padStart(12, '0')}`;
  const view = async (a: FakeApp, me: { memberId: string }): Promise<ConnectedAppView> => {
    const live = a.keys.filter((k) => !k.retired);
    const keys: AppKeyView[] = [];
    for (const k of live) {
      keys.push({
        key_id: k.id,
        fingerprint: await fingerprint(k.raw),
        added_by: k.added_by,
        created_at: k.created_at,
        first_used_at: null,
        retires_at: null,
      });
    }
    const newest = keys[keys.length - 1];
    const json = JSON.stringify({
      url: 'https://fake.example',
      app_id: a.id,
      key_id: newest?.key_id ?? '',
      instance_id: null,
      fingerprint: newest?.fingerprint ?? '',
    });
    const mine = a.member_id === me.memberId;
    const states = [...a.intake.values()];
    return {
      id: a.id,
      name: a.name,
      member_id: a.member_id,
      member_name: d.memberName(a.member_id),
      mine,
      created_at: a.created_at,
      state: a.approval === 'waiting' ? 'waiting_for_approval' : a.paused ? 'paused' : 'active',
      paused_reason: a.paused,
      scopes: [...(a.scopes ?? APP_SCOPES_DEFAULT)],
      allowed_kinds: a.allowed_kinds,
      default_visibility: a.default_visibility,
      auto_file: a.auto_file === true,
      daily_files: a.daily_files,
      daily_bytes: a.daily_bytes,
      backfill: liveBackfill(a),
      ip_allow: [],
      keys,
      last_used_at: a.last_used_at,
      today: { files: a.files_today, bytes: a.bytes_today },
      refused_today: 0,
      last_refusal: null,
      counts: mine
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
      connection_string: `fdvapp1.${toBase64(new TextEncoder().encode(json), true)}`,
      address: { url: 'https://fake.example', public: false },
    };
  };
  const stateOf = (
    externalId: string,
    s: FakeIntake,
    readableIds: ReadonlySet<string> = new Set(),
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
    };
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
      const raw = rawKey(body.public_key);
      if (!raw)
        return d.fail(422, 'validation_failed', 'Paste the app’s public key.', 'public_key');
      const member = typeof body.member_id === 'string' ? body.member_id : '';
      if (!d.mayAct(member)) {
        return d.fail(
          422,
          'validation_failed',
          'An app acts as an owner or an adult who signs in.',
          'member_id',
        );
      }
      if (
        d.apps.some((a) => !a.revoked && a.keys.some((k) => !k.retired && sameBytes(k.raw, raw)))
      ) {
        return d.fail(409, 'key_exists', 'That key is already in use. Make a new key pair.');
      }
      const now = new Date().toISOString();
      const a: FakeApp = {
        id: uuid(),
        name: (typeof body.name === 'string' ? body.name : '').trim() || 'App',
        member_id: member,
        approval: member === who.memberId ? 'approved' : 'waiting',
        paused: null,
        revoked: false,
        allowed_kinds: Array.isArray(body.allowed_kinds) ? (body.allowed_kinds as string[]) : [],
        default_visibility:
          (body.default_visibility as ConnectedAppView['default_visibility']) ?? null,
        daily_files: typeof body.daily_files === 'number' ? body.daily_files : 100,
        daily_bytes: typeof body.daily_bytes === 'number' ? body.daily_bytes : 500 * 1024 * 1024,
        keys: [{ id: uuid(), raw, added_by: 'owner', created_at: now, retired: false }],
        created_at: now,
        intake: new Map(),
        nonces: new Set(),
        files_today: 0,
        bytes_today: 0,
        last_used_at: null,
      };
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
      return d.ok(await view(a, who), 201);
    }
    const at = new RegExp(
      `^/api/v1/connected-apps/([^/]+)(/approve|/pause|/resume|/grants|/keys(?:/([^/]+))?)?$`,
    ).exec(path);
    const a = at ? d.apps.find((x) => x.id === at[1] && seen(x)) : undefined;
    if (!at) return null;
    if (!a) return d.fail(404, 'not_found', 'That app is not here.');
    const what = at[2] ?? '';
    if (what === '' && method === 'DELETE') {
      a.revoked = true;
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
      // Filing automatically switched on (APP4) widens: an app acting as
      // somebody else waits for them again, as the vault does.
      const widened =
        (auto.set.auto_file === true && a.auto_file !== true) ||
        (auto.set.backfill?.auto_file === true && liveBackfill(a)?.auto_file !== true);
      Object.assign(a, auto.set);
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
  type Told = { doc: AppDocument; fp: string; v: FakeReadableDoc['version'] };
  const readable = async (a: FakeApp): Promise<Map<string, Told>> => {
    const out = new Map<string, Told>();
    const today = localToday(d.timezone());
    const kinds = d.kinds();
    // Its own: a document a send of its made (not one it was filed into),
    // not let go of (APP3), while its current version is one the app sent.
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
      const isOwn =
        ownId !== undefined &&
        filed.some(([, s]) => s.document_id === x.id && s.version_id === (x.version?.id ?? null));
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
      out.set(x.id, { doc, fp: JSON.stringify(said), v: x.version });
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

  /** A signed request, checked in the contract's order; the app, or the refusal. */
  const signed = async (
    method: string,
    target: string,
    headers: Record<string, string>,
    body: Uint8Array,
    scope: AppScope | null,
    anyState: boolean,
  ): Promise<FakeApp | ResponseLike> => {
    const input = headers['signature-input'];
    const sig = headers['signature'];
    const digest = headers['content-digest'];
    if (!input || !sig || !digest || headers.authorization) {
      return d.fail(401, 'app_signature_required', 'Sign this request as a connected app.');
    }
    const m = new RegExp(
      `^fdv=(\\("@method" "@path" "@query" "content-digest"\\);created=(\\d+);keyid="(${UUID}|[a-z]+-\\d+)\\.(${UUID}|[a-z]+-\\d+)";nonce="([A-Za-z0-9_-]{22,64})";alg="ed25519";tag="fdv-app")$`,
    ).exec(input);
    const s = /^fdv=:([A-Za-z0-9+/]+={0,2}):$/.exec(sig);
    const g = /^sha-256=:([A-Za-z0-9+/]{43}=):$/.exec(digest);
    if (!m || !s || !g)
      return d.fail(
        401,
        'signature_malformed',
        'The request’s signature is not written as the vault expects.',
      );
    const a = d.apps.find((x) => x.id === m[3]);
    if (a?.revoked) return d.fail(401, 'app_revoked', 'This app has been removed from the vault.');
    const key = a?.keys.find((k) => k.id === m[4] && !k.retired);
    if (!a || !key) return d.fail(401, 'app_key_unknown', 'The vault does not know this key.');
    if (!anyState && a.paused) return d.fail(403, 'app_paused', 'An owner has paused this app.');
    if (!anyState && a.approval !== 'approved') {
      return d.fail(
        403,
        'app_not_approved',
        'The person this app acts as has not turned it on yet.',
      );
    }
    if (Math.abs(Number(m[2]) - Math.floor(Date.now() / 1000)) > APP_SIGNATURE_WINDOW_SECONDS) {
      return d.fail(401, 'signature_stale', 'The request was signed too long ago.');
    }
    const base = signatureBaseOf({ method, target, contentDigest: digest, params: m[1] as string });
    const pub = await crypto.subtle.importKey('raw', key.raw, { name: 'Ed25519' }, false, [
      'verify',
    ]);
    const verified = await crypto.subtle.verify(
      { name: 'Ed25519' },
      pub,
      fromBase64(s[1] as string),
      new TextEncoder().encode(base),
    );
    if (!verified)
      return d.fail(401, 'signature_invalid', 'The request’s signature does not verify.');
    if (a.nonces.has(m[5] as string))
      return d.fail(401, 'nonce_reused', 'This request was sent before.');
    a.nonces.add(m[5] as string);
    a.last_used_at = new Date().toISOString();
    if (scope && !(a.scopes ?? APP_SCOPES_DEFAULT).includes(scope)) {
      return d.fail(403, 'scope_not_granted', 'The owner did not allow this app to do that.');
    }
    const want = body.length === 0 ? APP_EMPTY_DIGEST : `sha-256=:${toBase64(await sha256(body))}:`;
    if (want !== digest) {
      return d.fail(
        400,
        'content_digest_mismatch',
        'The body did not match its digest, so nothing was kept.',
      );
    }
    return a;
  };

  /** The app's side, signed. */
  const app: (
    url: string,
    init: Parameters<FetchLike>[1],
    parts: (body: unknown) => Array<{
      name: string;
      value: string | null;
      bytes?: Uint8Array;
      type?: string;
      filename?: string;
    }> | null,
  ) => Promise<ResponseLike | null> = async (url, init, parts) => {
    const target = url.replace(/^[a-z]+:\/\/[^/]+/i, '');
    const path = target.split('?')[0] as string;
    const method = init.method ?? 'GET';
    const headers = Object.fromEntries(
      Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const signedRequest =
      headers['signature'] !== undefined || headers['signature-input'] !== undefined;
    if (!APP_ROUTE.test(path)) {
      return signedRequest
        ? d.fail(401, 'app_signature_not_accepted', 'A connected app can only use the app routes.')
        : null;
    }
    const body =
      init.body instanceof Uint8Array
        ? init.body
        : typeof init.body === 'string'
          ? new TextEncoder().encode(init.body)
          : new Uint8Array();
    const me = path === '/api/v1/apps/me';
    const scope: AppScope | null =
      me || path.startsWith('/api/v1/apps/keys')
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
    const a = await signed(method, target, headers, body, scope, me);
    if (!('intake' in a)) return a;
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
      // Any link needs reading too; a download link, downloading as well.
      const needs: AppScope[] =
        mode === 'download' ? ['documents.read', 'documents.download'] : ['documents.read'];
      const missing = needs.find((x) => !(a.scopes ?? APP_SCOPES_DEFAULT).includes(x));
      if (missing) {
        return d.fail(403, 'scope_not_granted', APP_REFUSALS.scope_not_granted, missing);
      }
      const r = (await readable(a)).get(linkAt[1] as string);
      if (!r || !r.v) return notFound();
      if (mode === 'view' && !canShareToView(r.v.mime)) {
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
        document_id: r.doc.id,
        version_id: r.v.id,
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
      // Its own alone: one it reads by a grant, or may not read, is 404.
      const r = (await readable(a)).get(deleteAt[1] as string);
      if (!r || !r.doc.own) return notFound();
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
      if (!r.v) return notFound();
      const etag = `"${r.v.id}"`;
      const total = r.v.bytes.length;
      const plain = {
        'content-type': r.v.mime,
        'content-disposition': `attachment; filename="${r.v.filename.replace(/"/g, '')}"`,
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
        return d.raw(206, r.v.bytes.slice(start, end + 1), {
          ...plain,
          ...length,
          'content-range': `bytes ${start}-${end}/${total}`,
        });
      }
      return d.raw(200, r.v.bytes, { ...plain, ...length });
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
        acting_as: { name: d.memberName(a.member_id) },
        vault: {
          instance_id: null,
          server_version: '0.9.0',
          display_name: 'The fake family',
          now: new Date().toISOString(),
          time_zone: d.timezone(),
        },
        scopes: [...(a.scopes ?? APP_SCOPES_DEFAULT)],
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
        keys: [],
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
        return d.ok(stateOf(id, before, new Set((await readable(a)).keys())), 200, {
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
      const s: FakeIntake = {
        state: 'waiting',
        removed_reason: null,
        refusal: null,
        sha256: sum,
        byte_size: bytes.length,
        received_at: new Date().toISOString(),
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
          return s ? [stateOf(id, s, still)] : [];
        }),
        unknown: ids.filter((id) => !a.intake.has(id)),
      });
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
      return d.ok(stateOf(id, s, new Set((await readable(a)).keys())));
    }
    return d.fail(404, 'not_found', 'Nothing by that id that this app may see.');
  };

  /**
   * What its user's browser asks (APP3): the token, once, within two
   * minutes, then the session's cookie on the session's path alone. Each
   * request asks the app's rule again: a document it may no longer read,
   * an app paused or removed, ends it.
   */
  const links = async (
    url: string,
    init: Parameters<FetchLike>[1],
  ): Promise<ResponseLike | null> => {
    const path = url.replace(/^[a-z]+:\/\/[^/]+/i, '').split('?')[0] as string;
    if (!path.startsWith('/api/v1/app-links/')) return null;
    const method = init.method ?? 'GET';
    if (method !== 'GET') return d.fail(404, 'not_found', 'Nothing here.');
    const headers = Object.fromEntries(
      Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const redirect = (to: string, more: Record<string, string> = {}) =>
      d.raw(303, new Uint8Array(), { location: to, ...more });
    const all = () => d.apps.flatMap((a) => (a.links ?? []).map((l) => ({ a, l })));
    const good = async (a: FakeApp, l: FakeAppLink) => {
      const scopes = a.scopes ?? APP_SCOPES_DEFAULT;
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
      const v = s.r.v;
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
    const token = /^\/api\/v1\/app-links\/([^/]+)$/.exec(path)?.[1] ?? '';
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
