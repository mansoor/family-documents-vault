import {
  APP_AUTO_FILE_WORDS,
  APP_ROUTE_WORDS,
  APP_BACKFILL_MAX_DAYS,
  APP_DEFAULT_DAILY_BYTES,
  APP_DEFAULT_DAILY_FILES,
  APP_DEFAULT_LINKS_PER_HOUR,
  APP_DELETE_MODE_DEFAULT,
  APP_DELETE_MODE_WORDS,
  APP_DELETE_MODES,
  APP_GRANTABLE_CATEGORIES,
  APP_GRANTS_MAX,
  APP_IP_ALLOW_MAX,
  APP_IP_ALLOW_NAME_HINT,
  APP_IP_ALLOW_NAMES_MAX,
  APP_NEVER_CATEGORIES,
  APP_KEY_DAYS_MAX,
  APP_KEY_NAME_MAX,
  APP_KEY_VALIDITY_DAYS,
  APP_KEY_WARN_DAYS,
  APP_KEYS_MAX,
  APP_LINKS_PER_HOUR_MAX,
  APP_LOOKBACK_MAX_MONTHS,
  APP_NAME_MAX,
  APP_REFUSAL_SHORT,
  APP_SCOPE_WORDS,
  APP_SCOPES_OFFERED,
  APP_STATE_WORDS,
  appsNotPublicWords,
  appAllowName,
  CATEGORY_LABELS,
  categoryLabel,
  localToday,
  lookbackWords,
  NOTE_KIND,
  roleLabel,
  type AppDeleteMode,
  type AppKeyView,
  type AppScope,
  type ConnectedAppChange,
  type ConnectedAppGrantsInput,
  type ConnectedAppInput,
  type ConnectedAppKeyInput,
  type ConnectedAppKeyMade,
  type ConnectedAppList,
  type ConnectedAppView,
  type DocumentTypeView,
  type Member,
  type Visibility,
} from '@fdv/shared';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from 'react';
import { api, ApiRequestError } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { dayWordsOf, familyZoneNow, shortWhenWords } from '../family-time.js';
import { storedRole } from '../session.js';
import {
  Button,
  Check,
  ConfirmDialog,
  ErrorNote,
  Field,
  LoadFailed,
  Select,
  Sheet,
} from '../ui.js';
import { SettingsPage } from './Settings.js';

/**
 * Connected apps (/settings/connected-apps, 0.9.0 APP1): an app an owner
 * connects, which sends documents into the Inbox of the person it acts as —
 * an owner or an adult who signs in.
 *
 * An owner sees every app, connects one (a passkey or an authenticator's
 * code, never the password: `connect_app`), pauses it, turns it back on,
 * changes what it may do, generates and revokes its API keys, and removes
 * it. An
 * adult sees only the apps acting as them: turns one on (it waits for them
 * when an owner connected it as them), and removes it. What it sent that
 * waits, and was filed, is its person's alone to see.
 *
 * Reading (APP2): an owner chooses whether it may read and download, and
 * what it may read beyond what it sent — a kind or a category, and how far
 * back — asked once when that takes in papers Sensitive by their kind.
 * Never identity, legal or medical papers: only the categories an app may
 * ever be given are offered.
 *
 * Links and deletes (APP3): whether it may show its user a document (a link
 * that opens once, for ten minutes) and how many links an hour; whether it
 * may delete what it sent, and what a delete does — let go of it, keeping
 * it in the vault, or move it to the Trash.
 *
 * API keys (APP6): the app proves who it is with a key an owner generates
 * here — a name, its own permissions (some of the app's) and how long it
 * lasts. Its client ID and secret are shown once, in a sheet with Copy, and
 * never again: the vault keeps only a hash. Two work at once at most; an
 * owner revokes one, asked first, and the app's next request with it is
 * refused.
 */

const MB = 1024 * 1024;
const GB = 1024 * MB;
const DAY = 24 * 60 * 60 * 1000;

/** "0 MB", "640 KB", "3 MB", "1.5 GB": a day's bytes, as Settings says them. */
export function amountWords(bytes: number): string {
  if (bytes <= 0) return '0 MB';
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < GB) return `${Math.round(bytes / MB)} MB`;
  return `${Math.round((bytes / GB) * 10) / 10} GB`;
}

/** "12 of 100 files today, 3 MB of 500 MB". */
export function todayWords(app: Pick<ConnectedAppView, 'today' | 'daily_files' | 'daily_bytes'>) {
  return `${app.today.files} of ${app.daily_files} files today, ${amountWords(app.today.bytes)} of ${amountWords(app.daily_bytes)}`;
}

/** A day as the page says it: "23 November", on the family's calendar. */
const day = (iso: string) => dayWordsOf(iso, familyZoneNow(), { year: 'other' });

/** Whom it acts as, for the reader: "you", or their name. */
const whom = (app: Pick<ConnectedAppView, 'mine' | 'member_name'>) =>
  app.mine ? 'you' : app.member_name;

/** Its state in words; a pause says by whom. */
function stateWords(app: ConnectedAppView): string {
  if (app.state === 'paused') {
    return app.paused_reason === 'restored' ? 'Paused after the restore' : 'Paused by an owner';
  }
  if (app.state === 'waiting_for_approval') {
    return app.mine ? 'Waiting for you to turn it on' : APP_STATE_WORDS.waiting_for_approval;
  }
  return APP_STATE_WORDS[app.state];
}

const STATE_CLASS: Record<ConnectedAppView['state'], string> = {
  active: 'status status-ok',
  paused: 'status status-warn',
  waiting_for_approval: 'status status-neutral',
};

/** Who sees what it sends: null as each kind says. */
function seenWords(v: Visibility | null, who: string): string {
  if (v === null) return 'As each kind says';
  if (v === 'adults') return 'Adults only';
  if (v === 'household') return 'Everyone';
  return who === 'you' ? 'Only me' : `Only ${who}`;
}

// ------------------------------------------------------------------ the form

/** What filing automatically means, under its switch (APP4). */
const AUTO_FILE_NOTE =
  'Filed without anybody looking only when the pages agree on the kind and whose it is, nothing is missing, and it is not a near match or a copy of something here. Anything else waits in the Inbox. Never identity, legal or medical papers.';

/** Whose Inbox what it sends goes to, under its switch (APP5). */
const ROUTE_NOTE =
  'When the app says whom a paper is about, and they are an adult here who signs in, it goes to their Inbox for them to look at and file. Anything else goes to the Inbox of the person it acts as. The app is never told whose Inbox.';

/** The form's fields, as typed. */
interface AppForm {
  name: string;
  member: string;
  kinds: string[];
  /** '' is "as each kind says". */
  seen: '' | Visibility;
  files: string;
  mb: string;
  ip: string;
  backfill: boolean;
  until: string;
  backfillFiles: string;
  backfillMb: string;
  /** Filed with nobody looking when everything is sure and complete (APP4). */
  autoFile: boolean;
  /** And for the older papers' window alone (APP4). */
  backfillAuto: boolean;
  /** Each paper to the Inbox of the person it is about (APP5). */
  route: boolean;
  /** What it may do: send, read, download, show, delete. */
  scopes: AppScope[];
  /** What a delete does (APP3). */
  deleteMode: AppDeleteMode;
  /** Links it may make an hour (APP3), as typed. */
  links: string;
}

type Ceilings = ConnectedAppList['ceilings'];

/** What the form says, checked: or what is wrong, in words. */
type Read =
  | {
      ok: true;
      value: Omit<ConnectedAppInput, 'member_id'> & { ip_allow: string[] };
    }
  | { ok: false; error: string };

const lines = (text: string) =>
  text
    .split(/[\n,]/)
    .map((l) => l.trim())
    .filter(Boolean);

const whole = (text: string, lo: number, hi: number): number | null => {
  const t = text.trim();
  if (!/^\d{1,10}$/.test(t)) return null;
  const n = Number(t);
  return n >= lo && n <= hi ? n : null;
};

/** The last day a backfill may end on, and the first: today and 30 days ahead, on the family's calendar. */
function backfillDays(): { min: string; max: string } {
  const zone = familyZoneNow();
  return {
    min: localToday(zone),
    max: localToday(zone, new Date(Date.now() + APP_BACKFILL_MAX_DAYS * DAY - 60_000)),
  };
}

/** The moment a backfill ends: the end of the day chosen, never past 30 days from now. */
function backfillUntil(ymd: string): string {
  const end = new Date(`${ymd}T23:59:59`).getTime();
  return new Date(Math.min(end, Date.now() + APP_BACKFILL_MAX_DAYS * DAY)).toISOString();
}

function readForm(f: AppForm, ceilings: Ceilings): Read {
  const name = f.name.trim();
  if (!name) return { ok: false, error: 'Give the app a name.' };
  if (name.length > APP_NAME_MAX) {
    return { ok: false, error: `A name is ${APP_NAME_MAX} characters at most.` };
  }
  const maxMb = Math.floor(ceilings.daily_bytes / MB);
  const files = whole(f.files, 1, ceilings.daily_files);
  if (files === null) return { ok: false, error: `Files a day: 1 to ${ceilings.daily_files}.` };
  const mb = whole(f.mb, 1, maxMb);
  if (mb === null) return { ok: false, error: `MB a day: 1 to ${maxMb}.` };
  if (f.scopes.length === 0) return { ok: false, error: 'Choose what it may do.' };
  const links = whole(f.links, 1, APP_LINKS_PER_HOUR_MAX);
  if (links === null) {
    return { ok: false, error: `Links an hour: 1 to ${APP_LINKS_PER_HOUR_MAX}.` };
  }
  const ip = lines(f.ip);
  if (ip.length > APP_IP_ALLOW_MAX) {
    return { ok: false, error: `${APP_IP_ALLOW_MAX} addresses, networks or names at most.` };
  }
  // Names (APP7): the vault checks each, and these caps, again.
  const names = new Set(ip.map(appAllowName).filter((n): n is string => n !== null));
  if (names.size > APP_IP_ALLOW_NAMES_MAX) {
    return { ok: false, error: `${APP_IP_ALLOW_NAMES_MAX} names at most.` };
  }
  let backfill: ConnectedAppInput['backfill'] = null;
  if (f.backfill) {
    const { min, max } = backfillDays();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.until) || f.until < min || f.until > max) {
      return {
        ok: false,
        error: `Older papers: choose a day within the next ${APP_BACKFILL_MAX_DAYS} days.`,
      };
    }
    const bf = whole(f.backfillFiles, 1, ceilings.daily_files);
    if (bf === null) {
      return { ok: false, error: `Older papers, files a day: 1 to ${ceilings.daily_files}.` };
    }
    const bm = whole(f.backfillMb, 1, maxMb);
    if (bm === null) return { ok: false, error: `Older papers, MB a day: 1 to ${maxMb}.` };
    backfill = {
      until: backfillUntil(f.until),
      files_per_day: bf,
      bytes_per_day: bm * MB,
      auto_file: f.backfillAuto,
    };
  }
  return {
    ok: true,
    value: {
      name,
      allowed_kinds: f.kinds,
      default_visibility: f.seen === '' ? null : f.seen,
      daily_files: files,
      daily_bytes: mb * MB,
      ip_allow: ip,
      backfill,
      auto_file: f.autoFile,
      route_to_person: f.route,
      scopes: APP_SCOPES_OFFERED.filter((s) => f.scopes.includes(s)),
      delete_mode: f.deleteMode,
      links_per_hour: links,
    },
  };
}

/** A new app's form: nobody's kinds ticked, the vault's own daily caps. */
function blankForm(me: string): AppForm {
  return {
    name: '',
    member: me,
    kinds: [],
    seen: '',
    files: String(APP_DEFAULT_DAILY_FILES),
    mb: String(Math.round(APP_DEFAULT_DAILY_BYTES / MB)),
    ip: '',
    backfill: false,
    until: '',
    backfillFiles: String(APP_DEFAULT_DAILY_FILES),
    backfillMb: String(Math.round(APP_DEFAULT_DAILY_BYTES / MB)),
    // Everything it sends waits for a look, until an owner says otherwise.
    autoFile: false,
    backfillAuto: false,
    // Each paper to the person it is about, unless an owner says otherwise.
    route: true,
    // Sending, and reading what it sent and what it is granted; downloading,
    // showing and deleting only when an owner ticks them.
    scopes: ['documents.send', 'documents.read'],
    deleteMode: APP_DELETE_MODE_DEFAULT,
    links: String(APP_DEFAULT_LINKS_PER_HOUR),
  };
}

/** An app's form, as it is now. */
function formOf(app: ConnectedAppView): AppForm {
  return {
    name: app.name,
    member: app.member_id,
    kinds: [...app.allowed_kinds],
    seen: app.default_visibility ?? '',
    files: String(app.daily_files),
    mb: String(Math.round(app.daily_bytes / MB)),
    ip: app.ip_allow.join('\n'),
    backfill: app.backfill !== null,
    until: app.backfill ? localToday(familyZoneNow(), new Date(app.backfill.until)) : '',
    backfillFiles: String(app.backfill?.files_per_day ?? app.daily_files),
    backfillMb: String(Math.round((app.backfill?.bytes_per_day ?? app.daily_bytes) / MB)),
    autoFile: app.auto_file,
    backfillAuto: app.backfill?.auto_file ?? false,
    route: app.route_to_person,
    scopes: [...app.scopes],
    deleteMode: app.delete_mode ?? APP_DELETE_MODE_DEFAULT,
    links: String(app.links_per_hour ?? APP_DEFAULT_LINKS_PER_HOUR),
  };
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/** What changed between the form as it started and as it is: only that is sent. */
function changeOf(start: AppForm, now: AppForm, value: Extract<Read, { ok: true }>['value']) {
  const change: ConnectedAppChange = {};
  if (now.name.trim() !== start.name) change.name = value.name;
  if (!sameSet(now.kinds, start.kinds)) change.allowed_kinds = value.allowed_kinds;
  if (now.seen !== start.seen) change.default_visibility = value.default_visibility ?? null;
  if (now.files.trim() !== start.files) change.daily_files = value.daily_files as number;
  if (now.mb.trim() !== start.mb) change.daily_bytes = value.daily_bytes as number;
  if (!sameSet(lines(now.ip), lines(start.ip))) change.ip_allow = value.ip_allow;
  const backfillMoved =
    now.backfill !== start.backfill ||
    (now.backfill &&
      (now.until !== start.until ||
        now.backfillFiles.trim() !== start.backfillFiles ||
        now.backfillMb.trim() !== start.backfillMb ||
        now.backfillAuto !== start.backfillAuto));
  if (backfillMoved) change.backfill = value.backfill ?? null;
  if (now.autoFile !== start.autoFile) change.auto_file = now.autoFile;
  if (now.route !== start.route) change.route_to_person = now.route;
  if (!sameSet(now.scopes, start.scopes)) change.scopes = value.scopes as AppScope[];
  if (now.deleteMode !== start.deleteMode) change.delete_mode = now.deleteMode;
  if (now.links.trim() !== start.links) change.links_per_hour = value.links_per_hour as number;
  return change;
}

/** A grant as the editor holds it: what (`kind:…` or `category:…`), and how many months back. */
interface GrantRow {
  what: string;
  months: string;
}

/**
 * What an app may be granted to read: the categories it may ever be given,
 * and their kinds — never a note, a kind kept as an Essential, or a hidden
 * one (unless granted already).
 */
export function grantChoices(
  types: DocumentTypeView[],
  granted: readonly string[] = [],
): Array<{ value: string; label: string }> {
  const grantable = APP_GRANTABLE_CATEGORIES as readonly string[];
  const kinds = types.filter(
    (t, i) =>
      t.key !== NOTE_KIND &&
      types.findIndex((x) => x.key === t.key) === i &&
      grantable.includes(t.category) &&
      !t.usually_essential &&
      (!t.hidden || granted.includes(`kind:${t.key}`)),
  );
  return [
    ...grantable.map((c) => ({ value: `category:${c}`, label: `All of ${categoryLabel(c)}` })),
    ...kinds.map((t) => ({ value: `kind:${t.key}`, label: t.label })),
  ];
}

/** Each grant in words: "Bank statement: the last 12 months". */
export function grantWords(
  app: Pick<ConnectedAppView, 'grants'>,
  types: DocumentTypeView[],
): string[] {
  return (app.grants ?? []).map((g) => {
    const what = g.kind
      ? (types.find((t) => t.key === g.kind)?.label ?? g.kind)
      : `All of ${categoryLabel(g.category)}`;
    return `${what}: ${lookbackWords(g.lookback_months)}${
      g.sensitive_confirmed ? ', sensitive papers included' : ''
    }`;
  });
}

/** The grants as the editor sends them, checked: or what is wrong, in words. */
function readGrants(rows: GrantRow[]): ConnectedAppGrantsInput | string {
  if (rows.length > APP_GRANTS_MAX) return `${APP_GRANTS_MAX} at most.`;
  const seen = new Set<string>();
  const grants: ConnectedAppGrantsInput['grants'] = [];
  for (const r of rows) {
    if (!r.what) return 'Choose a kind or a category for each.';
    if (seen.has(r.what)) return 'Each kind or category once.';
    seen.add(r.what);
    const months = whole(r.months, 1, APP_LOOKBACK_MAX_MONTHS);
    if (months === null) return `How far back: 1 to ${APP_LOOKBACK_MAX_MONTHS} months.`;
    const [sort, key = ''] = r.what.split(':');
    grants.push(
      sort === 'kind'
        ? { kind: key, lookback_months: months }
        : { category: key, lookback_months: months },
    );
  }
  return { grants };
}

// ------------------------------------------------------------ API keys (APP6)

/** Each permission in a word or two, as a key's row says them. */
const PERMISSION_WORDS: Readonly<Record<AppScope, string>> = {
  'documents.send': 'Send',
  'documents.read': 'Read',
  'documents.download': 'Download',
  'documents.links': 'Show its user',
  'documents.delete': 'Delete',
};

/** A key's permissions in words: "Send, Read". */
export const permissionWords = (p: readonly AppScope[]) =>
  APP_SCOPES_OFFERED.filter((s) => p.includes(s))
    .map((s) => PERMISSION_WORDS[s])
    .join(', ');

/** How long a new key lasts, as chosen: a number of days the vault offers, a number typed, or never. */
type Validity = `${(typeof APP_KEY_VALIDITY_DAYS)[number]}` | 'custom' | 'never';

const VALIDITY_WORDS: Record<Validity, string> = {
  '30': '30 days',
  '90': '90 days',
  '365': '1 year',
  custom: 'Custom…',
  never: 'Never expires',
};

/** The Generate key form, as typed. */
export interface KeyForm {
  name: string;
  permissions: AppScope[];
  validity: Validity;
  /** The days typed, for a custom validity. */
  days: string;
}

/** A new key's form: named nothing, every permission the app has ticked, for a year. */
export function blankKeyForm(app: Pick<ConnectedAppView, 'scopes'>): KeyForm {
  return { name: '', permissions: [...app.scopes], validity: '365', days: '' };
}

/** The form, checked: what to send, or what is wrong, in words. */
export function readKeyForm(
  f: KeyForm,
  app: Pick<ConnectedAppView, 'scopes'>,
): { ok: true; value: ConnectedAppKeyInput } | { ok: false; error: string } {
  const name = f.name.trim();
  if (name.length > APP_KEY_NAME_MAX) {
    return { ok: false, error: `A key’s name is ${APP_KEY_NAME_MAX} characters at most.` };
  }
  const permissions = APP_SCOPES_OFFERED.filter(
    (s) => f.permissions.includes(s) && app.scopes.includes(s),
  );
  if (permissions.length === 0) return { ok: false, error: 'Choose what the key may do.' };
  let days: number | null = null;
  if (f.validity === 'custom') {
    days = whole(f.days, 1, APP_KEY_DAYS_MAX);
    if (days === null)
      return { ok: false, error: `How long it lasts: 1 to ${APP_KEY_DAYS_MAX} days.` };
  } else if (f.validity !== 'never') {
    days = Number(f.validity);
  }
  return {
    ok: true,
    value: { name: name === '' ? null : name, permissions, expires_in_days: days },
  };
}

/** Whole days until a moment, rounded up: "in 3 days". */
const daysUntil = (iso: string, now: number) => Math.ceil((Date.parse(iso) - now) / DAY);

/**
 * When a key stops working, in words: "Never"; its day; and, for a live key
 * within APP_KEY_WARN_DAYS of it, how soon.
 */
export function keyExpiryWords(
  k: Pick<AppKeyView, 'expires_at' | 'state'>,
  now = Date.now(),
): { words: string; soon: boolean } {
  if (k.expires_at === null) return { words: 'Never', soon: false };
  const left = daysUntil(k.expires_at, now);
  if (k.state === 'live' && left <= APP_KEY_WARN_DAYS) {
    return {
      words: `${day(k.expires_at)} (expires in ${left <= 1 ? '1 day' : `${left} days`})`,
      soon: true,
    };
  }
  return { words: day(k.expires_at), soon: false };
}

/** A key that no longer works, in words: "Revoked 3 November", "Expired"; null while it works. */
export function keyStateWords(k: Pick<AppKeyView, 'state' | 'revoked_at'>): string | null {
  if (k.state === 'revoked') return k.revoked_at ? `Revoked ${day(k.revoked_at)}` : 'Revoked';
  if (k.state === 'expired') return 'Expired';
  return null;
}

/** A key as a sentence names it: its name, or its client ID. */
const keyName = (k: Pick<AppKeyView, 'name' | 'client_id'>) => k.name ?? k.client_id;

const liveKeys = (app: Pick<ConnectedAppView, 'keys'>) =>
  app.keys.filter((k) => k.state === 'live');

/** Whom an app may act as: an owner or an adult who signs in. */
const actsAs = (m: Member) =>
  m.has_account && !m.is_deceased && (m.role === 'owner' || m.role === 'adult');

/** The kinds an app may be allowed: the household's, but notes and hidden ones (unless allowed already). */
const offeredKinds = (types: DocumentTypeView[], allowed: readonly string[]) =>
  types.filter((t) => t.key !== NOTE_KIND && (!t.hidden || allowed.includes(t.key)));

/** Why an app is never given a kind to send, as the vault refuses it; null when it may be. */
const neverWhy = (t: DocumentTypeView): string | null =>
  APP_NEVER_CATEGORIES.includes(t.category)
    ? 'Identity, legal and medical papers are never an app’s to send'
    : t.usually_essential
      ? 'An Essential: never an app’s to send'
      : null;

/** One category of the kinds it may send (APP7): its kinds, those it may be given and not. */
export interface KindGroup {
  category: string;
  kinds: DocumentTypeView[];
}

/**
 * The kinds an app may send, by category (APP7), in the categories' own
 * order: never identity, legal or medical (not offered at all), and no
 * category none of whose kinds it may be given.
 */
export function kindGroups(types: DocumentTypeView[], allowed: readonly string[]): KindGroup[] {
  const order = Object.keys(CATEGORY_LABELS);
  const rank = (c: string) => (order.includes(c) ? order.indexOf(c) : order.length);
  const by = new Map<string, DocumentTypeView[]>();
  for (const t of offeredKinds(types, allowed)) {
    if (APP_NEVER_CATEGORIES.includes(t.category)) continue;
    by.set(t.category, [...(by.get(t.category) ?? []), t]);
  }
  return [...by.entries()]
    .filter(([, kinds]) => kinds.some((t) => neverWhy(t) === null))
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([category, kinds]) => ({ category, kinds }));
}

/**
 * A category's box (APP7): ticked when every kind of it the app may be
 * given is, mixed when some are (`indeterminate`, which a screen reader
 * says as mixed), and ticking it ticks them all, unticking unticks them.
 */
function CategoryCheck(props: {
  id: string;
  group: KindGroup;
  chosen: readonly string[];
  controls: string;
  onChange: (on: boolean) => void;
}) {
  const box = useRef<HTMLInputElement>(null);
  const open = props.group.kinds.filter((t) => neverWhy(t) === null);
  const some = open.filter((t) => props.chosen.includes(t.key)).length;
  const all = open.length > 0 && some === open.length;
  const mixed = some > 0 && !all;
  useLayoutEffect(() => {
    if (box.current) box.current.indeterminate = mixed;
  });
  return (
    <div className="check app-kinds-category">
      <input
        id={props.id}
        ref={box}
        type="checkbox"
        checked={all}
        aria-controls={props.controls}
        onChange={() => props.onChange(!all)}
      />
      <label htmlFor={props.id}>
        <span className="visually-hidden">All of</span> {categoryLabel(props.group.category)}
      </label>
    </div>
  );
}

/**
 * The kinds it may send, grouped by category (APP7): each category a box
 * for all its kinds, its kinds beneath it. An Essential kind shows, not to
 * be ticked, saying why. What is sent is the flat list of kinds, as before.
 *
 * Changing an app (`saved`, its kinds as they are): a kind it has that is
 * no longer offered — one the vault would refuse, or one the household no
 * longer has — is dropped as its kinds change, and said by name first.
 */
function KindsByCategory(props: {
  id: string;
  types: DocumentTypeView[];
  chosen: string[];
  onChange: (kinds: string[]) => void;
  saved?: readonly string[];
}) {
  const { id, chosen } = props;
  const groups = kindGroups(props.types, chosen);
  const known = new Map(props.types.map((t) => [t.key, t]));
  const never = new Set(props.types.filter((t) => neverWhy(t) !== null).map((t) => t.key));
  const gone = (k: string) => never.has(k) || !known.has(k);
  // A change never keeps a kind the vault would refuse.
  const put = (next: string[]) => props.onChange(next.filter((k) => !gone(k)));
  const dropped = (props.saved ?? []).filter(gone);
  const droppingNow = dropped.length > 0 && !dropped.some((k) => chosen.includes(k));
  const names = dropped.map((k) => known.get(k)?.label ?? k).join(', ');
  return (
    <>
      {dropped.length > 0 && (
        <p className="muted" id={`${id}-kinds-dropped`}>
          {droppingNow
            ? `Will no longer send: ${names}`
            : `Will no longer send, once its kinds change: ${names}`}
        </p>
      )}
      <div className="app-kinds">
        {groups.map((g) => {
          const gid = `${id}-cat-${g.category}`;
          const open = g.kinds.filter((t) => neverWhy(t) === null).map((t) => t.key);
          return (
            <div key={g.category} className="app-kinds-group">
              <CategoryCheck
                id={gid}
                group={g}
                chosen={chosen}
                controls={g.kinds.map((t) => `${id}-kind-${t.key}`).join(' ')}
                onChange={(on) =>
                  put(
                    on
                      ? [...chosen, ...open.filter((k) => !chosen.includes(k))]
                      : chosen.filter((k) => !open.includes(k)),
                  )
                }
              />
              <div role="group" aria-label={categoryLabel(g.category)} className="app-kinds-list">
                {g.kinds.map((t) => (
                  <Check
                    key={t.key}
                    id={`${id}-kind-${t.key}`}
                    label={t.label}
                    checked={chosen.includes(t.key) && !never.has(t.key)}
                    disabled={never.has(t.key)}
                    {...(never.has(t.key) ? { note: neverWhy(t) } : {})}
                    onChange={(on) =>
                      put(on ? [...chosen, t.key] : chosen.filter((k) => k !== t.key))
                    }
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function AppFields(props: {
  id: string;
  form: AppForm;
  set: (f: AppForm) => void;
  types: DocumentTypeView[];
  ceilings: Ceilings;
  /** Connecting: whom it acts as is asked too. */
  connect?: { people: Member[]; me: string };
  /** Whom it acts as, for "Only …": "you", or their name. */
  who: string;
  /** Changing it: its kinds as they are saved (APP7), to say which go. */
  savedKinds?: readonly string[];
}) {
  const { form, set, id } = props;
  const put = (more: Partial<AppForm>) => set({ ...form, ...more });
  const maxMb = Math.floor(props.ceilings.daily_bytes / MB);
  const days = backfillDays();
  return (
    <>
      <Field
        id={`${id}-name`}
        label="Name"
        value={form.name}
        maxLength={APP_NAME_MAX}
        required={false}
        requiredMark
        note="As the family sees it, beside what it sends."
        onChange={(v) => put({ name: v })}
      />
      {props.connect && (
        <>
          <div className="field">
            <label htmlFor={`${id}-who`}>Acting as</label>
            <select
              id={`${id}-who`}
              value={form.member}
              aria-describedby={`${id}-who-note`}
              onChange={(e) => put({ member: e.target.value })}
            >
              {props.connect.people.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id === props.connect?.me
                    ? `${m.display_name} (you)`
                    : `${m.display_name} · ${m.role ? roleLabel(m.role) : ''}`}
                </option>
              ))}
            </select>
            <p id={`${id}-who-note`} className="muted field-note">
              What it sends goes into their Inbox. An owner or an adult who signs in. Somebody else
              turns it on themselves before it can send anything.
            </p>
          </div>
        </>
      )}
      <fieldset className="limits-set">
        <legend className="field-label">What it may do</legend>
        <div className="limits-list">
          {APP_SCOPES_OFFERED.map((s) => (
            <Check
              key={s}
              id={`${id}-scope-${s.replace('.', '-')}`}
              label={APP_SCOPE_WORDS[s]}
              checked={form.scopes.includes(s)}
              onChange={(on) =>
                put({
                  scopes: on ? [...form.scopes, s] : form.scopes.filter((x) => x !== s),
                })
              }
            />
          ))}
        </div>
        <p className="muted">
          It reads what it sent, and what you allow it below once it is connected. Never identity,
          legal or medical papers, nothing Only me or Essential, nothing marked Sensitive.
        </p>
      </fieldset>
      <Select
        id={`${id}-delete`}
        label="When it deletes a document it sent"
        value={form.deleteMode}
        describedBy={`${id}-delete-note`}
        options={APP_DELETE_MODES.map((m) => ({ value: m, label: APP_DELETE_MODE_WORDS[m] }))}
        onChange={(v) => put({ deleteMode: v as AppDeleteMode })}
      />
      <p id={`${id}-delete-note`} className="muted field-note">
        Only a document a file it sent became — not a paper of yours its file was added to — while
        nobody has added a newer file. Only me papers, and anything it may not read, it cannot
        touch.
      </p>
      <Field
        id={`${id}-links`}
        label="Documents it may show its user, an hour"
        value={form.links}
        inputMode="numeric"
        required={false}
        note={`Each opens once, within 2 minutes, for 10 minutes, in one browser. Up to ${APP_LINKS_PER_HOUR_MAX}.`}
        onChange={(v) => put({ links: v })}
      />
      <fieldset className="limits-set">
        <legend className="field-label">Kinds it may send</legend>
        <p className="muted" id={`${id}-kinds-note`}>
          Anything it says is another kind is refused. Never identity, legal or medical papers, nor
          a kind kept as an Essential.
        </p>
        <KindsByCategory
          id={id}
          types={props.types}
          chosen={form.kinds}
          onChange={(kinds) => put({ kinds })}
          {...(props.savedKinds ? { saved: props.savedKinds } : {})}
        />
      </fieldset>
      <Select
        id={`${id}-seen`}
        label="Who sees what it sends"
        value={form.seen}
        options={(['', 'adults', 'household', 'private'] as const).map((v) => ({
          value: v,
          label: seenWords(v === '' ? null : v, props.who),
        }))}
        onChange={(v) => put({ seen: v as AppForm['seen'] })}
      />
      <Check
        id={`${id}-auto`}
        checked={form.autoFile}
        label={APP_AUTO_FILE_WORDS}
        note={AUTO_FILE_NOTE}
        onChange={(on) => put({ autoFile: on })}
      />
      <Check
        id={`${id}-route`}
        checked={form.route}
        label={APP_ROUTE_WORDS}
        note={ROUTE_NOTE}
        onChange={(on) => put({ route: on })}
      />
      <fieldset className="limits-set">
        <legend className="field-label">The most it may send in a day</legend>
        <div className="row">
          <Field
            id={`${id}-files`}
            label="Files"
            value={form.files}
            inputMode="numeric"
            required={false}
            note={`Up to ${props.ceilings.daily_files}.`}
            onChange={(v) => put({ files: v })}
          />
          <Field
            id={`${id}-mb`}
            label="MB"
            value={form.mb}
            inputMode="numeric"
            required={false}
            note={`Up to ${maxMb}.`}
            onChange={(v) => put({ mb: v })}
          />
        </div>
      </fieldset>
      <div className="field">
        <label htmlFor={`${id}-ip`}>Addresses it may send from</label>
        <textarea
          id={`${id}-ip`}
          value={form.ip}
          rows={3}
          spellCheck={false}
          autoCapitalize="off"
          aria-describedby={`${id}-ip-note`}
          onChange={(e) => put({ ip: e.target.value })}
        />
        <p id={`${id}-ip-note`} className="muted field-note">
          {`One a line, up to ${APP_IP_ALLOW_MAX}: an address (203.0.113.7), a network (203.0.113.0/24) or a name (feeds.example.com, up to ${APP_IP_ALLOW_NAMES_MAX}). Left empty, any address.`}{' '}
          {APP_IP_ALLOW_NAME_HINT}
        </p>
      </div>
      <Check
        id={`${id}-backfill`}
        checked={form.backfill}
        label="Let it send older papers for a while"
        note={`More a day than usual, until a day within the next ${APP_BACKFILL_MAX_DAYS} days.`}
        onChange={(on) => put({ backfill: on, until: on && !form.until ? days.max : form.until })}
      />
      {form.backfill && (
        <fieldset className="limits-set">
          <legend className="field-label">Older papers</legend>
          <div className="field">
            <label htmlFor={`${id}-until`}>Until</label>
            <input
              id={`${id}-until`}
              type="date"
              value={form.until}
              min={days.min}
              max={days.max}
              onChange={(e) => put({ until: e.target.value })}
            />
          </div>
          <div className="row">
            <Field
              id={`${id}-bf-files`}
              label="Files a day"
              value={form.backfillFiles}
              inputMode="numeric"
              required={false}
              onChange={(v) => put({ backfillFiles: v })}
            />
            <Field
              id={`${id}-bf-mb`}
              label="MB a day"
              value={form.backfillMb}
              inputMode="numeric"
              required={false}
              onChange={(v) => put({ backfillMb: v })}
            />
          </div>
          {!form.autoFile && (
            <Check
              id={`${id}-bf-auto`}
              checked={form.backfillAuto}
              label={`${APP_AUTO_FILE_WORDS}, until then`}
              note="So the older papers that are sure file themselves, and only the rest wait in the Inbox."
              onChange={(on) => put({ backfillAuto: on })}
            />
          )}
        </fieldset>
      )}
    </>
  );
}

// ------------------------------------------------------------- the screen

/** A key just generated: its secret, shown this once, and the app it is for. */
interface Shown {
  app: ConnectedAppView;
  made: ConnectedAppKeyMade;
}

/** The Generate key form, open on one app's card: on the screen, so a passkey asked for never loses it. */
interface KeyEdit {
  appId: string;
  form: KeyForm;
  error: string | null;
  /** Opened as the app was connected: the form says so. */
  connected: boolean;
}

export function ConnectedAppsScreen() {
  const { authVersion, guarded, withToken, session } = useApp();
  const owner = storedRole() === 'owner';
  const {
    data,
    error: loadError,
    reload,
  } = useLoad(
    async (t) => {
      const [list, types, members] = await Promise.all([
        api.connectedApps.list(t),
        api.documentTypes(t, { all: true }).then((r) => r.items),
        owner ? api.members(t).then((r) => r.items) : Promise.resolve([] as Member[]),
      ]);
      return { list, types, members };
    },
    [authVersion, owner],
  );
  // The reader, whom a new app acts as unless another is chosen.
  const me = data?.members.find((m) => m.is_me)?.id ?? session.info?.member_id ?? '';
  const [connecting, setConnecting] = useState<AppForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ConnectedAppView | null>(null);
  const [revoking, setRevoking] = useState<{ app: ConnectedAppView; key: AppKeyView } | null>(null);
  /** A key's secret, shown once: gone from here as its sheet closes. */
  const [shown, setShown] = useState<Shown | null>(null);
  const [keyEdit, setKeyEdit] = useState<KeyEdit | null>(null);
  /** The vault's question before an app reads papers Sensitive by their kind (APP2). */
  const [asking, setAsking] = useState<{
    app: ConnectedAppView;
    input: ConnectedAppGrantsInput;
    question: string;
  } | null>(null);
  /**
   * What an app may read, being changed: on the screen, not its card, so a
   * question about Sensitive papers, or a passkey asked for, never loses
   * what the owner chose; and each card's buttons, for the focus to go back
   * to.
   */
  const [grantEdit, setGrantEdit] = useState<{ appId: string; rows: GrantRow[] } | null>(null);
  const grantButtons = useRef(new Map<string, HTMLButtonElement | null>());
  const grantSaves = useRef(new Map<string, HTMLButtonElement | null>());
  /** Saved: the card whose "What it may read" takes the focus after this render. */
  const focusGrantsOf = useRef<string | null>(null);
  /** Where the focus goes back to from the question about Sensitive papers: the editor's Save. */
  const askReturn = useRef<HTMLButtonElement | null>(null);
  const connectButton = useRef<HTMLButtonElement>(null);
  const statusLine = useRef<HTMLParagraphElement>(null);
  const connectHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (said) statusLine.current?.focus();
  }, [said]);
  // After the status line's: what an app may read, saved, puts the focus
  // back on its card's button.
  useEffect(() => {
    const id = focusGrantsOf.current;
    if (!id) return;
    focusGrantsOf.current = null;
    grantButtons.current.get(id)?.focus();
  });
  // The form's heading in focus as it opens, from the button that is gone.
  const open = connecting !== null;
  useEffect(() => {
    if (open) connectHeading.current?.focus();
  }, [open]);

  /** One action of a card's: said, the list asked again, a refusal said. */
  const act = async <T,>(
    run: () => Promise<T | null>,
    words: (done: T) => string,
  ): Promise<T | null> => {
    setBusy(true);
    setError(null);
    setSaid(null);
    try {
      const done = await run();
      if (done !== null) {
        setSaid(words(done));
        await reload();
      }
      return done;
    } catch (err) {
      setError(describeError(err));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    if (!connecting || !data || busy) return;
    const read = readForm(connecting, data.list.ceilings);
    if (!read.ok) return setError(read.error);
    const body: ConnectedAppInput = { ...read.value, member_id: connecting.member };
    setBusy(true);
    setError(null);
    setSaid(null);
    try {
      const app = await guarded((t) => api.connectedApps.create(t, body));
      if (app) {
        setConnecting(null);
        await reload();
        // Its key next, in the same sitting: the app can do nothing without one.
        setKeyEdit({ appId: app.id, form: blankKeyForm(app), error: null, connected: true });
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  /** A key generated, with a passkey or a code: its secret shown once, in a sheet. */
  const generate = async (app: ConnectedAppView, edit: KeyEdit) => {
    if (busy) return;
    const read = readKeyForm(edit.form, app);
    if (!read.ok) return setKeyEdit({ ...edit, error: read.error });
    setBusy(true);
    setError(null);
    setSaid(null);
    setKeyEdit({ ...edit, error: null });
    try {
      const made = await guarded((t) => api.connectedApps.generateKey(t, app.id, read.value));
      if (made) {
        setKeyEdit(null);
        setShown({ app, made });
        await reload();
      }
    } catch (err) {
      setKeyEdit({ ...edit, error: describeError(err) });
    } finally {
      setBusy(false);
    }
  };

  /** What an app may read, saved; asked first, by the vault, about papers Sensitive by their kind. */
  const saveGrants = async (
    app: ConnectedAppView,
    input: ConnectedAppGrantsInput,
  ): Promise<'done' | 'failed' | 'asked'> => {
    setBusy(true);
    setError(null);
    setSaid(null);
    try {
      const a = await guarded((t) => api.connectedApps.setGrants(t, app.id, input));
      if (a === null) return 'failed';
      await reload();
      // Saved: said, the editor closed, and the focus back on its card's
      // "What it may read" (below), not the status line.
      setSaid(
        a.state === 'waiting_for_approval' && !a.mine
          ? `Saved. ${a.name} waits for ${a.member_name} to turn it on again.`
          : `Saved. ${a.name} may read what it now says here.`,
      );
      focusGrantsOf.current = app.id;
      setGrantEdit(null);
      return 'done';
    } catch (err) {
      // Papers Sensitive by their kind: the vault's question, the editor kept
      // open behind it.
      if (err instanceof ApiRequestError && err.code === 'sensitive_confirm') {
        askReturn.current = grantSaves.current.get(app.id) ?? null;
        setAsking({ app, input, question: err.message });
        return 'asked';
      }
      setError(describeError(err));
      return 'failed';
    } finally {
      setBusy(false);
    }
  };

  const items = data?.list.items ?? [];
  const names = [...new Set(items.map((a) => a.name))];
  const people = (data?.members ?? []).filter(actsAs);
  return (
    <SettingsPage title="Connected apps">
      <p className="lede">
        {owner
          ? 'An app you connect sends documents into the Inbox of the person it acts as, using an API key you generate here. If you allow it, it reads what it sent, and the kinds of papers you choose, for as far back as you choose. Never identity, legal or medical papers, nothing Only me or Essential, and nothing marked Sensitive.'
          : 'An app an owner connects as you sends documents into your Inbox, using an API key an owner generates. If an owner allows it, it reads what it sent, and the kinds of papers they choose, as you. Never identity, legal or medical papers, nothing Only me or Essential, and nothing marked Sensitive.'}
      </p>
      <p className="status-line" role="status" ref={statusLine} tabIndex={-1}>
        {said}
      </p>
      <ErrorNote message={error} />
      {data && !data.list.apps_public && items.length > 0 && (
        <p className="status status-warn" role="note">
          {appsNotPublicWords(names.length === 1 ? (names[0] ?? 'An app') : 'An app')}
        </p>
      )}
      {owner && data && !connecting && (
        <div className="row">
          <Button
            ref={connectButton}
            onClick={() => {
              setError(null);
              setSaid(null);
              setConnecting(blankForm(me));
            }}
          >
            Connect an app
          </Button>
        </div>
      )}
      {owner && data && connecting && (
        <section className="card stack" aria-labelledby="app-connect-h">
          <h2 id="app-connect-h" ref={connectHeading} tabIndex={-1} className="section-h">
            Connect an app
          </h2>
          <form className="stack" noValidate onSubmit={(e) => void connect(e)}>
            <AppFields
              id="app-new"
              form={connecting}
              set={setConnecting}
              types={data.types}
              ceilings={data.list.ceilings}
              connect={{ people, me }}
              who={
                connecting.member === me
                  ? 'you'
                  : (people.find((m) => m.id === connecting.member)?.display_name ?? 'them')
              }
            />
            <p className="muted">
              Connecting asks for your passkey, or a code from your authenticator app. Then you
              generate its API key.
            </p>
            <div className="row">
              <Button type="submit" disabled={busy}>
                {busy ? 'Connecting…' : 'Connect'}
              </Button>
              <Button
                kind="quiet"
                onClick={() => {
                  setConnecting(null);
                  setError(null);
                  requestAnimationFrame(() => connectButton.current?.focus());
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        </section>
      )}
      {data === null && loadError ? (
        <LoadFailed message={loadError} what="connected apps" onRetry={() => void reload()} />
      ) : data ? (
        <section aria-labelledby="apps-h" className="stack">
          <h2 id="apps-h" className="section-h">
            {owner ? 'Apps connected' : 'Apps acting as you'}
          </h2>
          {items.length === 0 ? (
            <p className="muted">{owner ? 'No app is connected.' : 'No app acts as you.'}</p>
          ) : (
            items.map((app) => (
              <AppCard
                key={app.id}
                app={app}
                owner={owner}
                busy={busy}
                types={data.types}
                ceilings={data.list.ceilings}
                onApprove={() =>
                  void act(
                    () => guarded((t) => api.connectedApps.approve(t, app.id)),
                    (a) => `${a.name} is on. What it sends arrives in your Inbox.`,
                  )
                }
                onPause={() =>
                  void act(
                    () => withToken((t) => api.connectedApps.pause(t, app.id)),
                    (a) =>
                      `${a.name} is paused. What it sends is refused until it is turned back on.`,
                  )
                }
                onResume={() =>
                  void act(
                    () => guarded((t) => api.connectedApps.resume(t, app.id)),
                    (a) =>
                      a.state === 'waiting_for_approval'
                        ? `${a.name} is no longer paused. It still waits for ${a.member_name} to turn it on.`
                        : `${a.name} is on again.`,
                  )
                }
                onChange={(change) =>
                  act(
                    () => guarded((t) => api.connectedApps.update(t, app.id, change)),
                    (a) => `Saved. ${a.name} may do what it now says here.`,
                  ).then((done) => done !== null)
                }
                onGrants={(input) => saveGrants(app, input)}
                grantRows={grantEdit?.appId === app.id ? grantEdit.rows : null}
                setGrantRows={(rows) =>
                  setGrantEdit(rows === null ? null : { appId: app.id, rows })
                }
                onGrantsButton={(el) => {
                  grantButtons.current.set(app.id, el);
                }}
                onGrantsSave={(el) => {
                  grantSaves.current.set(app.id, el);
                }}
                keyEdit={keyEdit?.appId === app.id ? keyEdit : null}
                setKeyEdit={(edit) => setKeyEdit(edit)}
                onGenerate={(edit) => void generate(app, edit)}
                onRevoke={(key) => setRevoking({ app, key })}
                onRemove={() => setRemoving(app)}
              />
            ))
          )}
        </section>
      ) : null}
      {shown && (
        <KeyShownSheet
          shown={shown}
          returnFocus={connectButton}
          onDone={() => {
            const { app } = shown;
            // The secret goes with the sheet: nothing here keeps it.
            setShown(null);
            setSaid(
              app.mine
                ? `${app.name}’s new key is ready.`
                : `${app.name} waits for ${app.member_name} to turn it on again before it can use its new key.`,
            );
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.name}?`}
          confirmLabel="Remove"
          busyLabel="Removing…"
          danger
          busy={busy}
          returnFocus={connectButton}
          onConfirm={() =>
            void act(
              () =>
                withToken((t) => api.connectedApps.remove(t, removing.id)).then((r) =>
                  r === null ? null : true,
                ),
              () => `${removing.name} was removed. It can no longer send anything.`,
            ).finally(() => setRemoving(null))
          }
          onCancel={() => setRemoving(null)}
        >
          <p>
            {`It can no longer send anything, and its keys stop working. What it sent stays in ${
              removing.mine ? 'your' : `${removing.member_name}’s`
            } Inbox. To use it again, connect it again.`}
          </p>
        </ConfirmDialog>
      )}
      {asking && (
        <ConfirmDialog
          title="Sensitive papers"
          confirmLabel="Allow"
          busyLabel="Saving…"
          busy={busy}
          returnFocus={askReturn}
          onConfirm={() => {
            const { app, input } = asking;
            setAsking(null);
            void saveGrants(app, { ...input, confirm_sensitive: true });
          }}
          onCancel={() => setAsking(null)}
        >
          <p>{asking.question}</p>
        </ConfirmDialog>
      )}
      {revoking && (
        <ConfirmDialog
          title="Revoke this key?"
          confirmLabel="Revoke"
          busyLabel="Revoking…"
          danger
          busy={busy}
          returnFocus={connectButton}
          onConfirm={() =>
            void act(
              () =>
                guarded((t) =>
                  api.connectedApps.revokeKey(t, revoking.app.id, revoking.key.id),
                ).then((r) => (r === null ? null : true)),
              () => `The key ${keyName(revoking.key)} was revoked.`,
            ).finally(() => setRevoking(null))
          }
          onCancel={() => setRevoking(null)}
        >
          <p>
            {`${revoking.app.name} stops working with the key ${keyName(revoking.key)} at its next request. This can’t be undone: to connect it again, generate a new key. Revoking asks for your passkey, or a code from your authenticator app.`}
          </p>
        </ConfirmDialog>
      )}
    </SettingsPage>
  );
}

/** One value to copy, with its own Copy button that says when it has copied. */
function CopyRow(props: { id: string; label: string; value: string; copyLabel: string }) {
  // What was copied: a new value has not been, yet.
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <div className="field key-copy">
      <span className="field-label" id={`${props.id}-l`}>
        {props.label}
      </span>
      <code id={props.id} aria-labelledby={`${props.id}-l`} className="key-value">
        {props.value}
      </code>
      <div className="row">
        <Button
          kind="quiet"
          ariaLabel={props.copyLabel}
          onClick={() => {
            void navigator.clipboard?.writeText(props.value).then(
              () => setCopied(props.value),
              () => setCopied(null),
            );
          }}
        >
          {copied === props.value ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}

/**
 * A key just generated: its client ID and its secret, with Copy, and what
 * to paste into the app — with the secret in it only if the owner ticks
 * it. Shown this once: the vault keeps only a hash of the secret.
 */
function KeyShownSheet(props: {
  shown: Shown;
  returnFocus: RefObject<HTMLElement | null>;
  onDone: () => void;
}) {
  const { app, made } = props.shown;
  const [withSecret, setWithSecret] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const connection = withSecret ? made.connection_string_with_secret : made.connection_string;
  return (
    <Sheet
      label="Copy this key now"
      busy={false}
      returnFocus={props.returnFocus}
      onClose={props.onDone}
      className="card stack"
    >
      <h2 ref={heading} tabIndex={-1} style={{ fontSize: 20 }}>
        Copy this key now
      </h2>
      <p>{`A new API key for ${app.name}${made.key.name ? `: ${made.key.name}` : ''}.`}</p>
      <p className="status status-warn" role="note">
        The secret won’t be shown again. If it’s lost, generate a new key and revoke this one.
      </p>
      <CopyRow
        id="key-made-client"
        label="Client ID"
        value={made.client_id}
        copyLabel="Copy the client ID"
      />
      <CopyRow
        id="key-made-secret"
        label="Secret"
        value={made.secret}
        copyLabel="Copy the secret"
      />
      <Check
        id="key-made-with-secret"
        checked={withSecret}
        label="Include the secret in the connection string"
        note={
          withSecret
            ? 'Anyone with this string can use the key. Paste it straight into the app, and nowhere else.'
            : 'Without it, the app asks for the secret on its own.'
        }
        onChange={setWithSecret}
      />
      <CopyRow
        id="key-made-connection"
        label="Connection string"
        value={connection}
        copyLabel="Copy the connection string"
      />
      <p className="muted">
        {app.mine
          ? `Paste these into ${app.name}.`
          : `Paste these into ${app.name}. It can use the key once ${app.member_name} turns it on again.`}
      </p>
      <div className="row">
        <Button onClick={props.onDone}>Done</Button>
      </div>
    </Sheet>
  );
}

/** The Generate key form, on an app's card: its heading takes the focus as it opens. */
function KeyFormView(props: {
  app: ConnectedAppView;
  edit: KeyEdit;
  busy: boolean;
  set: (edit: KeyEdit | null) => void;
  onGenerate: (edit: KeyEdit) => void;
  onCancel: () => void;
}) {
  const { app, edit, busy } = props;
  const f = edit.form;
  const put = (more: Partial<KeyForm>) => props.set({ ...edit, form: { ...f, ...more } });
  const id = `app-${app.id}-key`;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const scopes = APP_SCOPES_OFFERED.filter((s) => app.scopes.includes(s));
  return (
    <form
      className="stack"
      noValidate
      aria-labelledby={`${id}-h`}
      onSubmit={(e) => {
        e.preventDefault();
        props.onGenerate(edit);
      }}
    >
      <h4 id={`${id}-h`} ref={heading} tabIndex={-1} className="field-label">
        {`Generate an API key for ${app.name}`}
      </h4>
      {edit.connected && (
        <p>
          {app.state === 'waiting_for_approval'
            ? `${app.name} is connected. It does nothing until ${app.member_name} turns it on, in Settings → Connected apps. Generate its key now, to paste into the app.`
            : `${app.name} is connected. Generate its key now, to paste into the app.`}
        </p>
      )}
      <Field
        id={`${id}-name`}
        label="Name (optional)"
        value={f.name}
        maxLength={APP_KEY_NAME_MAX}
        required={false}
        note="So you can tell its keys apart: “Live”, “Test”."
        onChange={(v) => put({ name: v })}
      />
      <fieldset className="limits-set">
        <legend className="field-label">What the key may do</legend>
        <div className="limits-list">
          {scopes.map((s) => (
            <Check
              key={s}
              id={`${id}-perm-${s.replace('.', '-')}`}
              label={APP_SCOPE_WORDS[s]}
              checked={f.permissions.includes(s)}
              onChange={(on) =>
                put({
                  permissions: on ? [...f.permissions, s] : f.permissions.filter((x) => x !== s),
                })
              }
            />
          ))}
        </div>
        <p className="muted">Never more than the app itself may do.</p>
      </fieldset>
      <Select
        id={`${id}-validity`}
        label="How long it lasts"
        value={f.validity}
        options={[
          ...APP_KEY_VALIDITY_DAYS.map((d) => `${d}` as Validity),
          'custom' as const,
          'never' as const,
        ].map((v) => ({
          value: v,
          label: VALIDITY_WORDS[v],
        }))}
        onChange={(v) => put({ validity: v as Validity })}
      />
      {f.validity === 'custom' && (
        <Field
          id={`${id}-days`}
          label="Days"
          value={f.days}
          inputMode="numeric"
          required={false}
          note={`1 to ${APP_KEY_DAYS_MAX}.`}
          onChange={(v) => put({ days: v })}
        />
      )}
      <p className="muted">
        {`Generating asks for your passkey, or a code from your authenticator app. The secret is shown once.${
          app.mine
            ? ''
            : ` ${app.member_name} turns ${app.name} on again before it can use the key.`
        }`}
      </p>
      <ErrorNote message={edit.error} />
      <div className="row">
        <Button type="submit" disabled={busy}>
          {busy ? 'Generating…' : 'Generate key'}
        </Button>
        <Button kind="quiet" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** One app's API keys: each one's name, client ID, permissions, days and use; Revoke for an owner. */
function KeyList(props: {
  app: ConnectedAppView;
  owner: boolean;
  busy: boolean;
  headingId: string;
  onRevoke: (key: AppKeyView) => void;
}) {
  const { app, owner, busy } = props;
  if (app.keys.length === 0) {
    return (
      <p className="muted">
        {owner
          ? `No key yet. Generate one, and paste it into ${app.name}.`
          : `No key yet: an owner generates one.`}
      </p>
    );
  }
  return (
    <ul className="list app-keys" aria-labelledby={props.headingId}>
      {app.keys.map((k) => {
        const expiry = keyExpiryWords(k);
        const ended = keyStateWords(k);
        return (
          <li key={k.id} className="app-key">
            <span className="stack app-key-facts">
              <span>
                <strong>{k.name ?? 'Unnamed key'}</strong>
                {ended && <span className="status status-neutral">{` ${ended}`}</span>}
              </span>
              <dl className="facts">
                <dt>Client ID</dt>
                <dd>
                  <code>{k.client_id}</code>
                </dd>
                <dt>May</dt>
                <dd>{permissionWords(k.permissions)}</dd>
                <dt>Created</dt>
                <dd>{day(k.created_at)}</dd>
                <dt>Expires</dt>
                <dd>
                  {expiry.soon ? (
                    <strong className="status status-warn">{expiry.words}</strong>
                  ) : (
                    expiry.words
                  )}
                </dd>
                <dt>Last used</dt>
                <dd>{k.last_used_at ? shortWhenWords(k.last_used_at) : 'Never used'}</dd>
              </dl>
            </span>
            {owner && k.state === 'live' && (
              <Button
                kind="quiet"
                danger
                disabled={busy}
                ariaLabel={`Revoke the key ${keyName(k)}`}
                onClick={() => props.onRevoke(k)}
              >
                Revoke
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** One app: what it is, what it may do, how its day is going, and what can be done about it. */
function AppCard(props: {
  app: ConnectedAppView;
  owner: boolean;
  busy: boolean;
  types: DocumentTypeView[];
  ceilings: Ceilings;
  onApprove: () => void;
  onPause: () => void;
  onResume: () => void;
  onChange: (change: ConnectedAppChange) => Promise<boolean>;
  /** What it may read, saved: done, refused, or asked about Sensitive papers first. */
  onGrants: (input: ConnectedAppGrantsInput) => Promise<'done' | 'failed' | 'asked'>;
  /** What it may read, as the owner is changing it; null while not. */
  grantRows: GrantRow[] | null;
  setGrantRows: (rows: GrantRow[] | null) => void;
  /** Its "What it may read" and its editor's Save, told to the screen as they mount. */
  onGrantsButton: (el: HTMLButtonElement | null) => void;
  onGrantsSave: (el: HTMLButtonElement | null) => void;
  /** Its Generate key form, while open; null while not. */
  keyEdit: KeyEdit | null;
  setKeyEdit: (edit: KeyEdit | null) => void;
  onGenerate: (edit: KeyEdit) => void;
  onRevoke: (key: AppKeyView) => void;
  onRemove: () => void;
}) {
  const { app, owner, busy, keyEdit } = props;
  const [changing, setChanging] = useState<{ start: AppForm; now: AppForm } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const { grantRows, setGrantRows, onGrantsButton, onGrantsSave } = props;
  const grantsButton = useRef<HTMLButtonElement | null>(null);
  const generateButton = useRef<HTMLButtonElement | null>(null);
  const h = `app-${app.id}-h`;
  const label = (key: string) => props.types.find((t) => t.key === key)?.label ?? key;
  const kinds = app.allowed_kinds.map(label);
  const reads = app.scopes.includes('documents.read');
  const granted = grantWords(app, props.types);
  const live = liveKeys(app);
  const full = live.length >= APP_KEYS_MAX;

  const saveGrants = async (e: FormEvent) => {
    e.preventDefault();
    if (!grantRows || busy) return;
    const input = readGrants(grantRows);
    if (typeof input === 'string') return setFormError(input);
    setFormError(null);
    // Saved, the screen closes the editor; asked about Sensitive papers, it
    // stays open until the answer.
    await props.onGrants(input);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!changing || busy) return;
    const read = readForm(changing.now, props.ceilings);
    if (!read.ok) return setFormError(read.error);
    const change = changeOf(changing.start, changing.now, read.value);
    setFormError(null);
    if (Object.keys(change).length === 0) {
      setChanging(null);
      return;
    }
    if (await props.onChange(change)) setChanging(null);
  };

  return (
    <section className="card stack" aria-labelledby={h}>
      <div className="card-head">
        <h3 id={h} style={{ fontSize: 18, margin: 0 }}>
          {app.name}
        </h3>
        <span className={STATE_CLASS[app.state]}>{stateWords(app)}</span>
      </div>
      <p className="muted">{`Acting as ${whom(app)}`}</p>
      {changing ? (
        <form className="stack" noValidate onSubmit={(e) => void save(e)}>
          <AppFields
            id={`app-${app.id}`}
            form={changing.now}
            set={(now) => setChanging({ ...changing, now })}
            types={props.types}
            ceilings={props.ceilings}
            who={whom(app)}
            savedKinds={app.allowed_kinds}
          />
          <ErrorNote message={formError} />
          <div className="row">
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button
              kind="quiet"
              onClick={() => {
                setChanging(null);
                setFormError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <dl className="facts">
          <dt>What it may do</dt>
          <dd>{app.scopes.map((s) => APP_SCOPE_WORDS[s]).join('. ')}</dd>
          <dt>What it may read</dt>
          <dd>
            {!reads
              ? 'Nothing'
              : granted.length > 0
                ? `What it sent, and: ${granted.join('; ')}`
                : 'What it sent'}
          </dd>
          {app.scopes.includes('documents.download') && app.daily_read_bytes !== undefined && (
            <>
              <dt>Downloaded today</dt>
              <dd>{`${amountWords(app.read_today ?? 0)} of ${amountWords(app.daily_read_bytes)}`}</dd>
            </>
          )}
          {app.scopes.includes('documents.links') && app.links_per_hour !== undefined && (
            <>
              <dt>Documents shown</dt>
              <dd>
                {`${app.links_last_hour ?? 0} of ${app.links_per_hour} this hour; ${
                  app.links_opened_week ?? 0
                } opened this week`}
              </dd>
            </>
          )}
          {app.scopes.includes('documents.delete') && (
            <>
              <dt>When it deletes</dt>
              <dd>{APP_DELETE_MODE_WORDS[app.delete_mode ?? APP_DELETE_MODE_DEFAULT]}</dd>
            </>
          )}
          <dt>Kinds it may send</dt>
          <dd>{kinds.length > 0 ? kinds.join(', ') : 'None yet'}</dd>
          <dt>Who sees what it sends</dt>
          <dd>{seenWords(app.default_visibility, whom(app))}</dd>
          <dt>Filing</dt>
          <dd>
            {app.auto_file
              ? 'Files what is sure and complete; the rest waits for a look'
              : app.backfill?.auto_file
                ? `Files what is sure and complete until ${day(app.backfill.until)}; the rest waits for a look`
                : 'Everything waits for a look'}
          </dd>
          <dt>Whose Inbox</dt>
          <dd>
            {app.route_to_person
              ? `The person each paper is about, else ${app.mine ? 'yours' : `${app.member_name}’s`}`
              : app.mine
                ? 'Yours'
                : `${app.member_name}’s`}
          </dd>
          <dt>Last used</dt>
          <dd>{app.last_used_at ? shortWhenWords(app.last_used_at) : 'Not yet'}</dd>
          <dt>Today</dt>
          <dd>{todayWords(app)}</dd>
          {app.counts && (
            <>
              <dt>What it sent you</dt>
              <dd>{`${app.counts.waiting} waiting in your Inbox, ${app.counts.filed} filed`}</dd>
            </>
          )}
          {app.refused_today > 0 && (
            <>
              <dt>Refused today</dt>
              <dd>
                {`${app.refused_today} ${app.refused_today === 1 ? 'request' : 'requests'}`}
                {app.last_refusal
                  ? `; the last: ${APP_REFUSAL_SHORT[app.last_refusal] ?? app.last_refusal}`
                  : ''}
              </dd>
            </>
          )}
          {app.backfill && (
            <>
              <dt>Older papers</dt>
              <dd>
                {`Until ${day(app.backfill.until)}: ${app.backfill.files_per_day} files and ${amountWords(app.backfill.bytes_per_day)} a day`}
              </dd>
            </>
          )}
          <dt>Addresses</dt>
          <dd>{app.ip_allow.length > 0 ? app.ip_allow.join(', ') : 'Any'}</dd>
        </dl>
      )}
      <div className="stack">
        <h4 className="field-label" id={`${h}-keys`}>
          API keys
        </h4>
        <KeyList
          app={app}
          owner={owner}
          busy={busy}
          headingId={`${h}-keys`}
          onRevoke={props.onRevoke}
        />
        {owner && full && (
          <p className="muted" id={`${h}-keys-full`}>
            {`${APP_KEYS_MAX} keys at most work at once. Revoke one to generate another.`}
          </p>
        )}
      </div>
      {live.length === 0 ? (
        <p className="muted">{`${app.name} needs an API key before it can reach the vault.`}</p>
      ) : (
        owner &&
        app.connection_string &&
        !changing && (
          <details>
            <summary>{`What to paste into ${app.name}`}</summary>
            <div className="stack">
              <code style={{ wordBreak: 'break-all' }}>{app.connection_string}</code>
              <span className="muted">
                The address and its newest key’s client ID. The secret is not in it.
              </span>
              <div className="row">
                <Button
                  kind="quiet"
                  ariaLabel={`Copy what to paste into ${app.name}`}
                  onClick={() => {
                    void navigator.clipboard?.writeText(app.connection_string).then(
                      () => setCopied(true),
                      () => setCopied(false),
                    );
                  }}
                >
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
            </div>
          </details>
        )
      )}
      {keyEdit && owner && (
        <KeyFormView
          app={app}
          edit={keyEdit}
          busy={busy}
          set={props.setKeyEdit}
          onGenerate={props.onGenerate}
          onCancel={() => {
            props.setKeyEdit(null);
            requestAnimationFrame(() => generateButton.current?.focus());
          }}
        />
      )}
      {grantRows !== null && (
        <form className="stack" noValidate onSubmit={(e) => void saveGrants(e)}>
          <fieldset className="limits-set">
            <legend className="field-label">{`What ${app.name} may read, beyond what it sent`}</legend>
            <p className="muted">
              A kind, or every kind of a category, and how many months back on the paper’s date (up
              to {APP_LOOKBACK_MAX_MONTHS}). Identity, legal and medical papers are never offered.
            </p>
            {grantRows.length === 0 && <p className="muted">Nothing beyond what it sent.</p>}
            {grantRows.map((r, i) => (
              <div className="row" key={i}>
                <Select
                  id={`app-${app.id}-grant-${i}`}
                  label="What"
                  value={r.what}
                  options={[
                    { value: '', label: 'Choose…' },
                    ...grantChoices(
                      props.types,
                      grantRows.map((x) => x.what),
                    ),
                  ]}
                  onChange={(v) =>
                    setGrantRows(grantRows.map((x, j) => (j === i ? { ...x, what: v } : x)))
                  }
                />
                <Field
                  id={`app-${app.id}-grant-${i}-months`}
                  label="Months back"
                  value={r.months}
                  inputMode="numeric"
                  required={false}
                  onChange={(v) =>
                    setGrantRows(grantRows.map((x, j) => (j === i ? { ...x, months: v } : x)))
                  }
                />
                <Button
                  kind="quiet"
                  ariaLabel={`Take away line ${i + 1}`}
                  onClick={() => setGrantRows(grantRows.filter((_, j) => j !== i))}
                >
                  Take away
                </Button>
              </div>
            ))}
            <div className="row">
              <Button
                kind="quiet"
                onClick={() => setGrantRows([...grantRows, { what: '', months: '12' }])}
              >
                Add a kind or category
              </Button>
            </div>
          </fieldset>
          <p className="muted">
            Saving asks for your passkey, or a code from your authenticator app.
          </p>
          <ErrorNote message={formError} />
          <div className="row">
            <Button type="submit" disabled={busy} ref={onGrantsSave}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button
              kind="quiet"
              onClick={() => {
                setGrantRows(null);
                setFormError(null);
                requestAnimationFrame(() => grantsButton.current?.focus());
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {!changing && keyEdit === null && grantRows === null && (
        <div className="row">
          {app.mine && app.state === 'waiting_for_approval' && (
            <Button disabled={busy} ariaLabel={`Turn on ${app.name}`} onClick={props.onApprove}>
              Turn on
            </Button>
          )}
          {owner && app.state === 'active' && (
            <Button
              kind="quiet"
              disabled={busy}
              ariaLabel={`Pause ${app.name}`}
              onClick={props.onPause}
            >
              Pause
            </Button>
          )}
          {owner && app.state === 'paused' && (
            <Button
              kind="quiet"
              disabled={busy}
              ariaLabel={`Turn ${app.name} back on`}
              onClick={props.onResume}
            >
              Turn back on
            </Button>
          )}
          {owner && (
            <Button
              kind="quiet"
              disabled={busy}
              ariaLabel={`Change ${app.name}`}
              onClick={() => {
                const start = formOf(app);
                setFormError(null);
                setChanging({ start, now: start });
              }}
            >
              Change
            </Button>
          )}
          {owner && reads && (
            <Button
              ref={(el) => {
                grantsButton.current = el;
                onGrantsButton(el);
              }}
              kind="quiet"
              disabled={busy}
              ariaLabel={`Change what ${app.name} may read`}
              onClick={() => {
                setFormError(null);
                setGrantRows(
                  (app.grants ?? []).map((g) => ({
                    what: g.kind ? `kind:${g.kind}` : `category:${g.category ?? ''}`,
                    months: String(g.lookback_months),
                  })),
                );
              }}
            >
              What it may read
            </Button>
          )}
          {owner && (
            <Button
              ref={generateButton}
              kind="quiet"
              disabled={busy || full}
              {...(full ? { describedBy: `${h}-keys-full` } : {})}
              ariaLabel={`Generate an API key for ${app.name}`}
              onClick={() =>
                props.setKeyEdit({
                  appId: app.id,
                  form: blankKeyForm(app),
                  error: null,
                  connected: false,
                })
              }
            >
              Generate key
            </Button>
          )}
          {(owner || app.mine) && (
            <Button
              kind="quiet"
              danger
              disabled={busy}
              ariaLabel={`Remove ${app.name}`}
              onClick={props.onRemove}
            >
              Remove
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
