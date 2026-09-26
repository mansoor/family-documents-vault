import {
  can,
  canSee,
  canSeeList,
  CATEGORY_LABELS,
  checkCaptureMetadata,
  checkExtra,
  CORE_FIELDS,
  deriveStatus,
  effectiveVisibility,
  EXPIRY_ALWAYS_REQUIRED,
  inListAudience,
  LIST_AUDIENCES,
  LIST_DESCRIPTION_MAX,
  LIST_NAME_MAX,
  listItemHint,
  missingFields,
  PREVIEW_MAX_PAGES,
  PRIVATE_BY_DEFAULT,
  PRIVATE_TO_THEM,
  refusalFor,
  TYPE_IN_USE,
  TYPE_LABEL_MAX,
  UNSEEN_DOCUMENTS,
  type Capabilities,
  type CaptureMetadata,
  type CoreField,
  type CoreFieldRule,
  type DateValue,
  type DocumentAttributeView,
  type DocumentTypeImpact,
  type DocumentTypeView,
  type TypeField,
  type DocumentView,
  type IssuerSuggestions,
  type ListAudience,
  type ListDetail,
  type ListView,
  type OfflineGrant,
  type OfflineItem,
  type ReminderView,
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
  /** Why it ended, as the real vault says it. */
  endedBecause?: 'revoked' | 'reused';
  /** Its offline grant, as the real vault keeps it on the session (0.4.13). */
  offlineGrant?: OfflineGrant | null;
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
  members: Array<{ id: string; display_name: string; role: string; is_me: boolean }>;
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
   * Lists of documents (0.5.12), as the real vault keeps them: each made by
   * the one member the fake signs in as, and marked deleted, never removed.
   */
  lists: FakeList[];
  /** Every request, in order, for assertions. */
  calls: Array<{ method: string; path: string }>;
  /** When true, every request fails as if the network were down. */
  offline: boolean;
}

type FakeDocument = { id: string; title: string | null; revision?: number } & Omit<
  CaptureMetadata,
  'title'
>;

/** A list of documents, as the fake keeps one (0.5.12). */
export interface FakeList {
  id: string;
  name: string;
  description: string | null;
  audience: ListAudience;
  owner_member_id: string;
  created_at: string;
  updated_at: string;
  /** Moved by a change to its name, words or audience — never its items — as its ETag says. */
  revision: number;
  deleted: boolean;
  /** In the order they were put on it. */
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
];

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

export function createFakeVault(): { fetch: FetchLike; state: FakeVaultState } {
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
    types: FAKE_TYPES.map((t) => ({ ...t })),
    attributes: FAKE_ATTRIBUTES.map((a) => ({ ...a })),
    members: [{ id: 'fake-member', display_name: 'Fake Owner', role: 'owner', is_me: true }],
    role: 'owner',
    lists: [],
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
   * exactly when it expires, whatever its rule once said (0.5.10).
   */
  const typeAnswer = (t: DocumentTypeView): DocumentTypeView => ({
    ...t,
    ...(t.core
      ? { core: { ...t.core, expires: { ...t.core.expires, required: t.expiry_driver !== null } } }
      : {}),
    etag: typeTag(t),
  });
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

  const tokensFor = (s: FakeSession): Tokens => {
    const access = next('access');
    state.access.set(access, s.id);
    return {
      access_token: access,
      expires_in: 900,
      refresh_token: s.refresh,
      refresh_expires_in: 2_592_000,
      household_id: 'fake-household',
      member_id: 'fake-member',
      role: state.role,
      scopes_unlocked: ['household', 'adults', 'member'],
    };
  };
  const open = (installation: string | null = null): Tokens => {
    const s: FakeSession = {
      id: next('session'),
      refresh: next('refresh'),
      previous: null,
      revoked: false,
      installation,
      rotatedAt: Date.now(),
      graceUsed: false,
    };
    state.sessions.push(s);
    return tokensFor(s);
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
          // And lists of documents (0.5.12).
          lists: true,
        },
        limits: { max_upload_bytes: 104_857_600, max_members: null, max_storage_bytes: null },
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
      if (String(body.email).toLowerCase() !== state.email || body.password !== state.password) {
        return fail(401, 'invalid_credentials', "That email and password don't match.");
      }
      return ok(open(init.headers['x-fdv-installation'] ?? null));
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
          replayed.graceTokens = [
            ...(replayed.graceTokens ?? []),
            presented,
            replayed.refresh,
          ].slice(-8);
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
      if (!current) return ended('revoked');
      if (current.revoked) return ended(current.endedBecause ?? 'revoked');
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
      return ok({
        account_id: 'fake-account',
        household_id: 'fake-household',
        member_id: 'fake-member',
        role: state.role,
        totp_enabled: false,
        totp_required: true,
      });
    }
    /** A document as the real vault answers it, with its status in words (0.5.7). */
    const viewOf = (doc: FakeDocument) => documentView(doc, state.types);
    /** As a list answers it: an Only me document's notes and details stay sealed (0.5.8). */
    const listedOf = (doc: FakeDocument) => documentView(doc, state.types, { listed: true });
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
      const items = by
        ? state.documents.filter((d) => d.issued_by?.toLowerCase() === by.trim().toLowerCase())
        : state.documents;
      return ok({ items: items.map(listedOf), next_cursor: null, has_more: false });
    }
    // One document, and an edit to it: the details merged, as the real
    // vault merges them (0.5.7), so a client never wipes what it did not show.
    const one = /^\/api\/v1\/documents\/([^/]+)$/.exec(path);
    if (one && (init.method === 'GET' || init.method === 'PATCH')) {
      const s = session();
      if (!('id' in s)) return s;
      const doc = state.documents.find((d) => d.id === decodeURIComponent(one[1] as string));
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
          max_offline_days: 90,
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
        reminder_leads: leadsOf(
          (body.reminder_leads as number[] | undefined) ?? (expires ? [30] : []),
        ),
        usually_essential: (body.usually_essential as boolean | undefined) ?? false,
        default_visibility: (body.default_visibility as Visibility | undefined) ?? 'household',
        issued_by_label: null,
        builtin: false,
        hidden: false,
        core: coreOf({ expiry_driver: expires ? 'expires_on' : null }),
        short_label: tidy(body.short_label as string | null | undefined),
        issuer_noun: tidy(body.issuer_noun as string | null | undefined),
      };
      const problem = changeType(t, { core: sent, fields: body.fields as TypeChange['fields'] });
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
        if (body.reminder_leads !== undefined) {
          next.reminder_leads = leadsOf(body.reminder_leads as number[]);
        } else if (
          t.expiry_driver === null &&
          (body.core as TypeChange['core'])?.expires?.shown === true &&
          t.reminder_leads.length === 0
        ) {
          // Expires switched on with no lead times: 30 days, as a new kind.
          next.reminder_leads = [30];
        }
        if (body.default_visibility !== undefined) {
          next.default_visibility = body.default_visibility as Visibility;
        }
        if (body.usually_essential !== undefined) {
          next.usually_essential = body.usually_essential as boolean;
        }
        if (body.hidden !== undefined) next.hidden = body.hidden as boolean;
        const problem = changeType(next, {
          core: body.core as TypeChange['core'],
          fields: body.fields as TypeChange['fields'],
        });
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
          reminders: state.reminders.filter(
            (r) =>
              r.kind === 'derived' &&
              ['scheduled', 'due', 'snoozed'].includes(r.status) &&
              used.some((d) => d.id === r.document_id),
          ).length,
          unseen: UNSEEN_DOCUMENTS,
        };
        return ok(impact);
      }
    }
    // Lists of documents (0.5.12), as the real vault keeps them: a list
    // exists only for whoever is in its audience (a viewer is in none);
    // each reader is given the documents on it they can see, counted as
    // they see them; only its maker changes it.
    const me = { role: state.role, memberId: 'fake-member' };
    const listAt = /^\/api\/v1\/lists\/([^/]+)(\/items(?:\/([^/]+))?)?$/.exec(path);
    const docLists = /^\/api\/v1\/documents\/([^/]+)\/lists$/.exec(path);
    if (path === '/api/v1/lists' || listAt || docLists) {
      const s = session();
      if (!('id' in s)) return s;
      const shown = (l: FakeList) => !l.deleted && canSeeList(me, l);
      const onIt = (l: FakeList) =>
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
      const listTag = (l: FakeList) => `"${l.id}.${l.revision}"`;
      const listView = (l: FakeList): ListView => ({
        id: l.id,
        name: l.name,
        description: l.description,
        audience: l.audience,
        owner_member_id: l.owner_member_id,
        mine: l.owner_member_id === me.memberId,
        item_count: onIt(l).length,
        created_at: l.created_at,
        updated_at: l.updated_at,
        etag: listTag(l),
      });
      const detail = (l: FakeList): ListDetail => ({
        ...listView(l),
        items: onIt(l).map((i) => ({
          document: listedOf(i.doc),
          added_at: i.added_at,
          hint:
            l.owner_member_id === me.memberId
              ? listItemHint(l.audience, {
                  visibility: i.doc.visibility ?? 'household',
                  owner_member_id: i.doc.owner_member_id ?? null,
                })
              : null,
        })),
      });
      // By name, whatever the case; made first, first (a stable sort).
      const byName = (a: FakeList, b: FakeList) => {
        const [x, y] = [a.name.toLowerCase(), b.name.toLowerCase()];
        return x < y ? -1 : x > y ? 1 : 0;
      };
      const manage = () =>
        can(state.role, 'list.manage') ? null : fail(403, 'forbidden', refusalFor('list.manage'));
      /** The name, words and audience asked for, as the real vault takes them; or a refusal. */
      const fields = (
        l: Pick<FakeList, 'name' | 'description' | 'audience'>,
      ): ResponseLike | Pick<FakeList, 'name' | 'description' | 'audience'> => {
        const out = { ...l };
        if (body.name !== undefined) {
          const name = tidy(body.name as string);
          if (!name) return fail(422, 'validation_failed', 'Give the list a name.', 'name');
          if (name.length > LIST_NAME_MAX) {
            return fail(
              422,
              'validation_failed',
              `A list’s name is too long: ${LIST_NAME_MAX} characters at most.`,
              'name',
            );
          }
          out.name = name;
        }
        if (body.description !== undefined) {
          const words = (body.description as string | null)?.trim() || null;
          if ((words?.length ?? 0) > LIST_DESCRIPTION_MAX) {
            return fail(
              422,
              'validation_failed',
              `What a list is for is too long: ${LIST_DESCRIPTION_MAX} characters at most.`,
              'description',
            );
          }
          out.description = words;
        }
        if (body.audience !== undefined) {
          const audience = body.audience as ListAudience;
          if (!LIST_AUDIENCES.includes(audience)) {
            return fail(422, 'validation_failed', 'Say who the list is for.', 'audience');
          }
          if (!inListAudience(state.role, audience)) {
            return fail(403, 'forbidden', 'Only an adult can make a list for the adults.');
          }
          out.audience = audience;
        }
        return out;
      };

      if (path === '/api/v1/lists' && init.method === 'GET') {
        return ok({ items: state.lists.filter(shown).sort(byName).map(listView) });
      }
      if (path === '/api/v1/lists' && init.method === 'POST') {
        const refused = manage();
        if (refused) return refused;
        if (body.name === undefined) {
          return fail(422, 'validation_failed', 'Give the list a name.', 'name');
        }
        if (body.audience === undefined) {
          return fail(422, 'validation_failed', 'Say who the list is for.', 'audience');
        }
        const asked = fields({ name: '', description: null, audience: 'only_me' });
        if (isResponse(asked)) return asked;
        const at = new Date().toISOString();
        const l: FakeList = {
          id: next('list'),
          ...asked,
          owner_member_id: me.memberId,
          created_at: at,
          updated_at: at,
          revision: 1,
          deleted: false,
          items: [],
        };
        state.lists.push(l);
        return respond(201, detail(l), { etag: listTag(l) });
      }
      if (docLists && init.method === 'GET') {
        const doc = state.documents.find((d) => d.id === decodeURIComponent(docLists[1] as string));
        if (!doc) return fail(404, 'not_found', 'That document is not in the vault.');
        const on = state.lists.filter(
          (l) => shown(l) && l.items.some((i) => i.document_id === doc.id),
        );
        return ok({ items: on.sort(byName).map(listView) });
      }
      if (listAt) {
        const changing = init.method !== 'GET';
        const refused = changing ? manage() : null;
        if (refused) return refused;
        const l = state.lists.find((x) => x.id === decodeURIComponent(listAt[1] as string));
        if (!l || !shown(l)) return fail(404, 'not_found', 'That list does not exist.');
        if (!listAt[2] && init.method === 'GET') {
          return respond(200, detail(l), { etag: listTag(l) });
        }
        if (changing && l.owner_member_id !== me.memberId) {
          return fail(403, 'forbidden', 'Only the person who made this list can change it.');
        }
        if (!listAt[2] && init.method === 'PATCH') {
          const ifMatch = init.headers['if-match'];
          if (ifMatch && ifMatch !== listTag(l)) {
            return fail(
              409,
              'conflict',
              'This list was changed since you opened it. Reload and try again.',
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
            Object.assign(l, asked, { updated_at: new Date().toISOString() });
            l.revision += 1;
          }
          return respond(200, detail(l), { etag: listTag(l) });
        }
        if (!listAt[2] && init.method === 'DELETE') {
          l.deleted = true;
          return empty();
        }
        if (listAt[2] && !listAt[3] && init.method === 'POST') {
          const ids = [...new Set((body.document_ids as string[] | undefined) ?? [])];
          if (ids.length === 0) {
            return fail(422, 'validation_failed', 'Choose a document to put on the list.');
          }
          // Each one the maker can see, or none is put on.
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
          return respond(200, detail(l), { etag: listTag(l) });
        }
        if (listAt[3] && init.method === 'DELETE') {
          const id = decodeURIComponent(listAt[3]);
          if (!state.documents.some((d) => d.id === id)) {
            return fail(404, 'not_found', 'That document is not in the vault.');
          }
          const at = l.items.findIndex((i) => i.document_id === id);
          if (at < 0) return fail(404, 'not_found', 'That document is not on this list.');
          l.items.splice(at, 1);
          return empty();
        }
      }
    }
    if (path === '/api/v1/members' && init.method === 'GET') {
      const s = session();
      if (!('id' in s)) return s;
      return ok({ items: state.members });
    }
    if (path === '/api/v1/reminders' && init.method === 'GET') {
      const s = session();
      if (!('id' in s)) return s;
      return ok({ items: state.reminders });
    }
    return fail(404, 'not_found', `The fake vault has no ${init.method} ${path}.`);
  };

  return { fetch, state };
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
  opts: { listed?: boolean } = {},
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
/** A session that has ended, and why, as the real vault says it (0.4.11). */
const ended = (reason: 'expired' | 'revoked' | 'reused' | 'removed' | 'malformed') =>
  respond(401, {
    error: {
      code: 'session_ended',
      message: 'Please sign in again.',
      reason,
      retriable: false,
      request_id: 'fake',
    },
  });
