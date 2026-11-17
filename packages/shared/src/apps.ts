/**
 * Connected apps (0.9.0, APP1): an app an owner connects, which signs every
 * request with its own Ed25519 key and sends documents into the Inbox of
 * the person it acts as.
 *
 * The integrator's side is `docs/api-changelog.md` and the contract the
 * vault keeps with them; this module is what the API, the web, the fake
 * vault and `@fdv/client`'s app client share of it: the scopes, the hints
 * an app may send and how each is checked, the name of an app's batch, the
 * states of what it sent, and the words a person is shown.
 *
 * MIT, with the rest of @fdv/shared.
 */

import { deviceBatchName } from './devices.js';
import type { DateValue, Visibility } from './documents.js';

// ------------------------------------------------------------- scopes

/** What an app may do. APP1 grants `documents.send` alone. */
export const APP_SCOPES = [
  'documents.send',
  'documents.read',
  'documents.download',
  'documents.links',
  'documents.delete',
] as const;
export type AppScope = (typeof APP_SCOPES)[number];

/** The scopes this vault can grant now: the rest come with their features. */
export const APP_SCOPES_OFFERED: readonly AppScope[] = ['documents.send'];

/** Each scope in words, as Settings says what an app may do. */
export const APP_SCOPE_WORDS: Readonly<Record<AppScope, string>> = {
  'documents.send': 'Send documents to the Inbox, and see what became of them',
  'documents.read': 'Read the details of documents it is allowed',
  'documents.download': 'Download documents it is allowed',
  'documents.links': 'Open documents it is allowed, for its user',
  'documents.delete': 'Let go of the documents it sent',
};

/**
 * The categories an app may ever be granted to read (APP2): an
 * allow-list, so a category added later is closed until it is named.
 * Never identity, legal, medical, education or pets.
 */
export const APP_GRANTABLE_CATEGORIES = [
  'financial',
  'tax',
  'bills',
  'insurance',
  'work',
  'property',
  'other',
] as const;

/**
 * The categories whose papers an app's reading never files, whatever its
 * allowed kinds say: held as Check, "Not a kind MonTra sends".
 */
export const APP_NEVER_CATEGORIES: readonly string[] = ['identity', 'legal', 'medical'];

// ---------------------------------------------------------- limits

/** The day's caps an app starts with, within the operator's ceilings. */
export const APP_DEFAULT_DAILY_FILES = 100;
export const APP_DEFAULT_DAILY_BYTES = 500 * 1024 * 1024;
/** The operator's ceilings, unless FDV_APP_DAILY_FILES and FDV_APP_DAILY_BYTES say otherwise. */
export const APP_CEILING_DAILY_FILES = 1000;
export const APP_CEILING_DAILY_BYTES = 5 * 1024 ** 3;
/** Bytes a day an app may download (APP2), and links an hour (APP3): said in `limits`. */
export const APP_DEFAULT_READ_BYTES = 1024 ** 3;
export const APP_DEFAULT_LINKS_PER_HOUR = 60;
/** Signed requests a minute, for each app. */
export const APP_REQUESTS_PER_MINUTE = 120;
/** A backfill allowance ends at most this many days ahead. */
export const APP_BACKFILL_MAX_DAYS = 30;
/** Addresses and networks an app's allow-list holds at most. */
export const APP_IP_ALLOW_MAX = 10;
/** The longest an app's name may be. */
export const APP_NAME_MAX = 60;
/** The `metadata` part of an intake, at most. */
export const APP_METADATA_MAX_BYTES = 16 * 1024;
/** `GET /apps/intake?external_ids=` takes this many at most. */
export const APP_STATUS_MAX_IDS = 100;
/** How far `created` may be from the vault's clock, in seconds. */
export const APP_SIGNATURE_WINDOW_SECONDS = 300;
/** Live keys an app holds at most, for rotation. */
export const APP_KEYS_MAX = 2;
/** An older key retires by itself this many days after a newer one is first used. */
export const APP_KEY_RETIRE_DAYS = 7;

// ------------------------------------------------------------ signing

/** The one signature's label, and the tag that keeps it to this protocol. */
export const APP_SIGNATURE_LABEL = 'fdv';
export const APP_SIGNATURE_TAG = 'fdv-app';
/** The components signed, exactly these, in this order. */
export const APP_SIGNED_COMPONENTS = ['@method', '@path', '@query', 'content-digest'] as const;
/** The digest of no body at all: what a GET or a DELETE carries. */
export const APP_EMPTY_DIGEST = 'sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:';

/** A connection string's prefix: no secret is in it. */
export const APP_CONNECTION_PREFIX = 'fdvapp1.';

/** What a connection string holds. */
export interface AppConnection {
  url: string;
  app_id: string;
  key_id: string;
  instance_id: string | null;
  fingerprint: string;
}

// ------------------------------------------------------------- intake

/**
 * An app's own id for what it sends: opaque, unique within the app, its
 * idempotency key. Never starting with a dot: a path segment that does is
 * refused by the vault's proxies before it reaches the vault.
 */
export const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9_:-][A-Za-z0-9._:-]{0,127}$/;

/** The hints an app may send, as `GET /apps/me` lists them. */
export const APP_HINTS = [
  'person',
  'kind',
  'title',
  'issuer',
  'issued',
  'expires',
  'due_date',
  'amount',
  'tax_year',
  'account_last4',
  'period',
  'tags',
] as const;
export type AppHintName = (typeof APP_HINTS)[number];

/** Whose a paper is, as an app may say it. */
export type AppPersonHint = { member_id: string } | { name: string } | { household: true };

/** The hints, as checked: every text plain, control characters gone. */
export interface AppHints {
  person?: AppPersonHint;
  kind?: string;
  title?: string;
  issuer?: string;
  issued?: DateValue;
  expires?: DateValue;
  due_date?: DateValue;
  amount?: { value: string; currency: string };
  tax_year?: number;
  account_last4?: string;
  period?: string;
  tags?: string[];
}

/** An intake's `metadata` part, as checked. */
export interface AppIntakeMetadata {
  external_id: string;
  hints: AppHints;
}

/** A problem with what an app sent: in words, and the field it is about. */
export interface AppMetadataProblem {
  message: string;
  detail: string;
}

/** Text as a hint is kept: control characters gone, spaces made one, trimmed. */
export function hintText(v: string): string {
  return v
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The last day of a month, as YYYY-MM-DD. */
function lastDay(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month, 0));
  return d.toISOString().slice(0, 10);
}

/**
 * A hint's date — `YYYY-MM-DD`, `YYYY-MM` or `YYYY` — as the vault keeps one:
 * with month or year precision, the last day of the period. Null when it is
 * not a date.
 */
export function hintDate(v: unknown): DateValue | null {
  if (typeof v !== 'string') return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (mo < 1 || mo > 12 || d < 1) return null;
    if (v > lastDay(y, mo) || y < 1900 || y > 2200) return null;
    return { date: v, precision: 'day' };
  }
  m = /^(\d{4})-(\d{2})$/.exec(v);
  if (m) {
    const [y, mo] = [Number(m[1]), Number(m[2])];
    if (mo < 1 || mo > 12 || y < 1900 || y > 2200) return null;
    return { date: lastDay(y, mo), precision: 'month' };
  }
  m = /^(\d{4})$/.exec(v);
  if (m) {
    const y = Number(m[1]);
    if (y < 1900 || y > 2200) return null;
    return { date: `${y}-12-31`, precision: 'year' };
  }
  return null;
}

/** An amount as the vault files it: "2,450.10 USD". */
export function amountText(a: { value: string; currency: string }): string {
  const negative = a.value.startsWith('-');
  const [whole = '0', frac] = a.value.replace(/^-/, '').split('.');
  const grouped = whole.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${frac !== undefined ? `.${frac}` : ''} ${a.currency}`;
}

/**
 * An intake's `metadata` part, checked: `external_id` required; each
 * hint only as `GET /apps/me` lists them, each as the contract says. A
 * problem is said in words, with the field it is about.
 */
export function parseAppMetadata(
  raw: unknown,
): { ok: true; value: AppIntakeMetadata } | { ok: false; problem: AppMetadataProblem } {
  const bad = (message: string, detail: string) =>
    ({ ok: false, problem: { message, detail } }) as const;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return bad('Send metadata as a JSON object.', 'metadata');
  }
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (k !== 'external_id' && k !== 'hints') return bad(`Unknown field: ${k}.`, k);
  }
  if (typeof r.external_id !== 'string' || !EXTERNAL_ID_PATTERN.test(r.external_id)) {
    return bad(
      'external_id is required: 1 to 128 letters, digits, dots, underscores, colons or dashes, not starting with a dot.',
      'external_id',
    );
  }
  const hints: AppHints = {};
  const h = r.hints;
  if (h !== undefined && h !== null) {
    if (typeof h !== 'object' || Array.isArray(h)) return bad('hints is an object.', 'hints');
    const given = h as Record<string, unknown>;
    for (const k of Object.keys(given)) {
      if (!(APP_HINTS as readonly string[]).includes(k)) {
        return bad(`Unknown hint: ${k}.`, `hints.${k}`);
      }
    }
    const text = (k: string, max: number): string | null | undefined => {
      const v = given[k];
      if (v === undefined) return undefined;
      if (typeof v !== 'string') return null;
      const t = hintText(v);
      return t.length >= 1 && t.length <= max ? t : null;
    };
    if (given.person !== undefined) {
      const p = given.person as Record<string, unknown> | null;
      const keys = p && typeof p === 'object' && !Array.isArray(p) ? Object.keys(p) : [];
      if (keys.length === 1 && keys[0] === 'member_id' && typeof p?.member_id === 'string') {
        if (!UUID.test(p.member_id)) return bad('person.member_id is a UUID.', 'hints.person');
        hints.person = { member_id: p.member_id.toLowerCase() };
      } else if (keys.length === 1 && keys[0] === 'name' && typeof p?.name === 'string') {
        const name = hintText(p.name);
        if (name.length < 1 || name.length > 120) {
          return bad('person.name is 1 to 120 characters.', 'hints.person');
        }
        hints.person = { name };
      } else if (keys.length === 1 && keys[0] === 'household' && p?.household === true) {
        hints.person = { household: true };
      } else {
        return bad(
          'person is { "member_id" }, { "name" } or { "household": true }.',
          'hints.person',
        );
      }
    }
    if (given.kind !== undefined) {
      if (typeof given.kind !== 'string' || !/^[a-z0-9_]{1,64}$/.test(given.kind)) {
        return bad('kind is a kind key from GET /apps/me.', 'hints.kind');
      }
      hints.kind = given.kind;
    }
    const title = text('title', 200);
    if (title === null) return bad('title is 1 to 200 characters.', 'hints.title');
    if (title !== undefined) hints.title = title;
    const issuer = text('issuer', 120);
    if (issuer === null) return bad('issuer is 1 to 120 characters.', 'hints.issuer');
    if (issuer !== undefined) hints.issuer = issuer;
    for (const k of ['issued', 'expires', 'due_date'] as const) {
      if (given[k] === undefined) continue;
      const d = hintDate(given[k]);
      if (!d) return bad(`${k} is YYYY-MM-DD, YYYY-MM or YYYY.`, `hints.${k}`);
      hints[k] = d;
    }
    if (given.amount !== undefined) {
      const a = given.amount as Record<string, unknown> | null;
      if (
        !a ||
        typeof a !== 'object' ||
        Array.isArray(a) ||
        Object.keys(a).some((k) => k !== 'value' && k !== 'currency') ||
        typeof a.value !== 'string' ||
        !/^-?\d{1,12}(\.\d{1,4})?$/.test(a.value) ||
        typeof a.currency !== 'string' ||
        !/^[A-Z]{3}$/.test(a.currency)
      ) {
        return bad(
          'amount is { "value": "1234.56", "currency": "USD" }: up to 12 digits, then up to 4 decimals, and an ISO 4217 code.',
          'hints.amount',
        );
      }
      hints.amount = { value: a.value, currency: a.currency };
    }
    if (given.tax_year !== undefined) {
      const y = given.tax_year;
      if (typeof y !== 'number' || !Number.isInteger(y) || y < 1900 || y > 2100) {
        return bad('tax_year is a year from 1900 to 2100.', 'hints.tax_year');
      }
      hints.tax_year = y;
    }
    if (given.account_last4 !== undefined) {
      if (typeof given.account_last4 !== 'string' || !/^\d{4}$/.test(given.account_last4)) {
        return bad('account_last4 is exactly 4 digits.', 'hints.account_last4');
      }
      hints.account_last4 = given.account_last4;
    }
    const period = text('period', 80);
    if (period === null) return bad('period is 1 to 80 characters.', 'hints.period');
    if (period !== undefined) hints.period = period;
    if (given.tags !== undefined) {
      const t = given.tags;
      if (!Array.isArray(t) || t.length > 10) {
        return bad('tags is a list of at most 10 tags.', 'hints.tags');
      }
      const tags: string[] = [];
      for (const v of t) {
        const one = typeof v === 'string' ? hintText(v) : '';
        if (one.length < 1 || one.length > 60) {
          return bad('Each tag is 1 to 60 characters.', 'hints.tags');
        }
        if (!tags.includes(one)) tags.push(one);
      }
      hints.tags = tags;
    }
  }
  return { ok: true, value: { external_id: r.external_id, hints } };
}

/**
 * The name of an app's batch for a day, on the household's calendar
 * (YYYY-MM-DD), and its part past the first 200 files: "From MonTra, 16
 * November 2026", "From MonTra, 16 November 2026 (2)".
 */
export function appBatchName(app: string, day: string, part = 1): string {
  const name = deviceBatchName(app, day);
  return part > 1 ? `${name} (${part})` : name;
}

// ------------------------------------------------------------- states

/** What became of something an app sent . */
export type AppIntakeStateName = 'waiting' | 'filed' | 'refused' | 'removed' | 'unavailable';

/** One state, as `POST /apps/intake` and `GET /apps/intake/{external_id}` answer it. */
export interface AppIntakeState {
  external_id: string;
  state: AppIntakeStateName;
  received_at: string | null;
  sha256: string | null;
  byte_size: number | null;
  document_id: string | null;
  version_id: string | null;
  filed_at: string | null;
  removed_reason: 'withdrawn' | 'declined' | 'expired' | null;
  refusal: 'kind_not_allowed' | 'unsupported_type' | 'too_large' | null;
}

/** `GET /apps/intake?external_ids=`: the states, and the ids this app never sent. */
export interface AppIntakeStates {
  items: AppIntakeState[];
  unknown: string[];
}

// -------------------------------------------------------- GET /apps/me

/** Whether an app works now. */
export type AppStateName = 'active' | 'paused' | 'waiting_for_approval';

/** A kind an app may send, as `GET /apps/me` lists it. */
export interface AppSendKind {
  key: string;
  label: string;
  category: string;
  /** The kind's own detail fields: which hints it can file. */
  fields: string[];
  /** Whether it shows an Expires date ("Payment due" for a credit card statement). */
  expires: boolean;
}

/** A key, as an app or Settings is told of it: never the key itself. */
export interface AppKeyView {
  key_id: string;
  fingerprint: string;
  added_by: 'owner' | 'app';
  created_at: string;
  /**
   * Added by the app itself and not yet confirmed in Settings: it signs
   * nothing until an owner, or the person the app acts as, confirms it.
   */
  pending?: boolean;
  /** When it was first used to sign: Settings says it. */
  first_used_at?: string | null;
  /** When it retires by itself: seven days after a newer key was first used; else null. */
  retires_at: string | null;
}

/** `GET /api/v1/apps/me`: the connection test, and what this app may do. */
export interface AppMe {
  app: { id: string; name: string; created_at: string };
  state: AppStateName;
  paused_reason?: 'owner' | 'restored';
  acting_as: { name: string };
  vault: {
    instance_id: string | null;
    server_version: string;
    display_name: string;
    now: string;
    time_zone: string;
  };
  scopes: AppScope[];
  send: { kinds: AppSendKind[]; hints: AppHintName[]; auto_file: boolean };
  limits: {
    max_upload_bytes: number;
    accepted_types: string[];
    files_per_day: number;
    files_today: number;
    bytes_per_day: number;
    bytes_today: number;
    read_bytes_per_day: number;
    read_bytes_today: number;
    links_per_hour: number;
    requests_per_minute: number;
    day_resets_at: string;
  };
  backfill: {
    until: string;
    files_per_day: number;
    bytes_per_day: number;
    auto_file: boolean;
  } | null;
  keys: AppKeyView[];
}

/** `POST /api/v1/apps/keys`: a key added by the app. */
export interface AppKeyAdded {
  key_id: string;
  keyid: string;
  fingerprint: string;
  created_at: string;
  /** Always true: it signs nothing until an owner, or the person the app acts as, confirms it. */
  pending?: boolean;
}

// ------------------------------------------------- Settings (the family)

/** An app as Settings → Connected apps shows it. */
export interface ConnectedAppView {
  id: string;
  name: string;
  /** Whom it acts as. */
  member_id: string;
  member_name: string;
  /** It acts as the caller. */
  mine: boolean;
  created_at: string;
  state: AppStateName;
  paused_reason: 'owner' | 'restored' | null;
  scopes: AppScope[];
  allowed_kinds: string[];
  /** Who sees what it sends: null as each kind says. */
  default_visibility: Visibility | null;
  auto_file: boolean;
  daily_files: number;
  daily_bytes: number;
  backfill: { until: string; files_per_day: number; bytes_per_day: number } | null;
  ip_allow: string[];
  keys: AppKeyView[];
  last_used_at: string | null;
  today: { files: number; bytes: number };
  refused_today: number;
  last_refusal: string | null;
  /** How many of what it sent wait, and were filed: its person's alone to know; null to anybody else. */
  counts: { waiting: number; filed: number } | null;
  /** What to paste into the app: no secret is in it. */
  connection_string: string;
  /** The address the app must use, and whether it is the public-only site's. */
  address: { url: string; public: boolean };
}

/** `POST /api/v1/connected-apps`. */
export interface ConnectedAppInput {
  name: string;
  member_id: string;
  public_key: string;
  allowed_kinds: string[];
  default_visibility?: Visibility | null;
  daily_files?: number;
  daily_bytes?: number;
  ip_allow?: string[];
  backfill?: { until: string; files_per_day: number; bytes_per_day: number } | null;
}

/** `PATCH /api/v1/connected-apps/{id}`: what is sent changes; the rest stays. */
export type ConnectedAppChange = Partial<
  Pick<
    ConnectedAppInput,
    | 'name'
    | 'allowed_kinds'
    | 'default_visibility'
    | 'daily_files'
    | 'daily_bytes'
    | 'ip_allow'
    | 'backfill'
  >
>;

/** `POST /api/v1/connected-apps/{id}/keys`'s answer: the key, and the string to paste again. */
export interface ConnectedAppKeyAdded {
  key: AppKeyView;
  connection_string: string;
}

/** The apps the caller may see, and what the vault says about where apps reach it. */
export interface ConnectedAppList {
  items: ConnectedAppView[];
  /** The operator has published the app routes on the public-only site (FDV_PUBLIC_APPS=on). */
  apps_public: boolean;
  /** The ceilings an owner may set caps up to. */
  ceilings: { daily_files: number; daily_bytes: number };
}

/** Each state in words, as Settings says it. */
export const APP_STATE_WORDS: Readonly<Record<AppStateName, string>> = {
  active: 'On',
  paused: 'Paused',
  waiting_for_approval: 'Waiting for its person to turn it on',
};

/** Said when an app is connected and the operator has not published its routes. */
export const appsNotPublicWords = (app: string): string =>
  `${app} runs on the internet and can only reach this vault at its public address. Ask whoever runs your vault to turn on FDV_PUBLIC_APPS.`;

/** The refusals an app's request may be answered, in words a person may be shown. */
export const APP_REFUSALS = {
  app_signature_required: 'Sign this request as a connected app.',
  signature_malformed: 'The request’s signature is not written as the vault expects.',
  app_key_unknown: 'The vault does not know this key, or it has been retired.',
  app_key_pending:
    'This key waits for an owner, or the person the app acts as, to confirm it in Settings.',
  app_revoked: 'This app has been removed from the vault. Connect it again.',
  app_paused: 'An owner has paused this app.',
  app_not_approved: 'The person this app acts as has not turned it on yet.',
  address_not_allowed: 'This app may not reach the vault from this address.',
  https_required: 'Use https to reach the vault.',
  signature_stale: 'The request was signed too long ago, or the app’s clock is wrong.',
  signature_invalid: 'The request’s signature does not verify.',
  nonce_reused: 'This request was sent before. Sign it again.',
  member_locked: 'An owner has locked the sign-in of the person this app acts as.',
  member_paused:
    'After a restore, the sign-in of the person this app acts as waits for an owner to turn it back on.',
  scope_not_granted: 'The owner did not allow this app to do that.',
  content_digest_mismatch: 'The body did not match its digest, so nothing was kept.',
  app_signature_not_accepted: 'A connected app can only use the app routes.',
  kind_not_allowed: 'This app may not send this kind of document.',
  external_id_conflict: 'This external_id was already used with other bytes.',
  app_day_full: 'This app has sent as much as it may today.',
  length_required: 'Send Content-Length.',
} as const;

/** A refusal's code as Settings says it: "signature not valid". */
export const APP_REFUSAL_SHORT: Readonly<Record<string, string>> = {
  signature_malformed: 'signature not written right',
  app_key_unknown: 'key not known',
  app_key_pending: 'key not confirmed yet',
  app_paused: 'paused',
  app_not_approved: 'not turned on yet',
  address_not_allowed: 'address not allowed',
  https_required: 'not over https',
  signature_stale: 'clock off',
  signature_invalid: 'signature not valid',
  nonce_reused: 'request sent twice',
  member_locked: 'sign-in locked',
  member_paused: 'sign-in paused',
  scope_not_granted: 'not allowed',
  content_digest_mismatch: 'body changed',
  kind_not_allowed: 'kind not allowed',
  app_day_full: 'day full',
  rate_limited: 'too many requests',
};

/**
 * Hints as sealed beside an item (`{ v: 1, hints }`), opened and checked
 * again as an intake's are: anything not as the contract says is no hint.
 */
export function storedAppHints(raw: unknown): AppHints {
  if (!raw || typeof raw !== 'object' || (raw as { v?: unknown }).v !== 1) return {};
  const checked = parseAppMetadata({
    external_id: 'stored',
    hints: (raw as { hints?: unknown }).hints,
  });
  return checked.ok ? checked.value.hints : {};
}

/** Hints as they are sealed beside an item: dates back to the text they were sent as. */
export function sealedAppHints(hints: AppHints): string {
  const date = (d: DateValue) =>
    d.precision === 'year'
      ? d.date.slice(0, 4)
      : d.precision === 'month'
        ? d.date.slice(0, 7)
        : d.date;
  const out: Record<string, unknown> = { ...hints };
  for (const k of ['issued', 'expires', 'due_date'] as const) {
    const v = hints[k];
    if (v) out[k] = date(v);
  }
  return JSON.stringify({ v: 1, hints: out });
}
