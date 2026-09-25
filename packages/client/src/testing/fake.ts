import {
  checkCaptureMetadata,
  effectiveVisibility,
  PREVIEW_MAX_PAGES,
  type Capabilities,
  type CaptureMetadata,
  type DocumentTypeView,
  type DocumentView,
  type IssuerSuggestions,
  type ReminderView,
  type Tokens,
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
}

export interface FakeVaultState {
  setupRequired: boolean;
  email: string | null;
  password: string | null;
  sessions: FakeSession[];
  /** access token → session id */
  access: Map<string, string>;
  documents: FakeDocument[];
  /** What GET /document-types answers: a few real types, by default. */
  types: DocumentTypeView[];
  /** What GET /members answers: the one person the fake signs in as, by default. */
  members: Array<{ id: string; display_name: string; role: string; is_me: boolean }>;
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
  /** Every request, in order, for assertions. */
  calls: Array<{ method: string; path: string }>;
  /** When true, every request fails as if the network were down. */
  offline: boolean;
}

type FakeDocument = { id: string; title: string | null } & Omit<
  CaptureMetadata,
  'title' | 'issued' | 'expires' | 'tags'
>;

const FAKE_TYPES: DocumentTypeView[] = [
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
    key: 'bank_statement',
    label: 'Bank / investment statement',
    category: 'financial',
    fields: [],
    expiry_driver: null,
    reminder_leads: [],
    usually_essential: false,
    default_visibility: 'adults',
    issued_by_label: 'Institution',
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
  },
  {
    key: 'utility_bill',
    label: 'Utility / bill',
    category: 'bills',
    fields: [],
    expiry_driver: null,
    reminder_leads: [],
    usually_essential: false,
    default_visibility: 'household',
    issued_by_label: 'Provider',
  },
];

/**
 * The parts of a multipart body the fake cares about, in order: its fields
 * and whether each came before the file. Bytes are read as text, which is
 * enough for the details and a test's small PDF.
 */
function partsOf(body: unknown): Array<{ name: string; value: string | null }> | null {
  if (body instanceof Uint8Array) {
    const text = new TextDecoder().decode(body);
    const out: Array<{ name: string; value: string | null }> = [];
    const header =
      /Content-Disposition: form-data; name="([^"]*)"(; filename="[^"]*")?[^]*?\r\n\r\n/g;
    for (const m of text.matchAll(header)) {
      if (m[2]) {
        out.push({ name: m[1] as string, value: null });
        continue;
      }
      const start = (m.index ?? 0) + m[0].length;
      const end = text.indexOf('\r\n--', start);
      out.push({ name: m[1] as string, value: text.slice(start, end) });
    }
    return out;
  }
  const entries = (body as { entries?: () => Iterable<[string, unknown]> } | null)?.entries;
  if (typeof entries === 'function') {
    return [...entries.call(body)].map(([name, value]) => ({
      name,
      value: typeof value === 'string' ? value : null,
    }));
  }
  return null;
}

interface FakeUpload {
  kind: 'capture' | 'version';
  document_id: string;
  version_id: string;
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
    types: FAKE_TYPES.map((t) => ({ ...t })),
    members: [{ id: 'fake-member', display_name: 'Fake Owner', role: 'owner', is_me: true }],
    calls: [],
    offline: false,
  };
  let n = 0;
  const next = (prefix: string) => `${prefix}-${++n}`;

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
      role: 'owner',
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
        server_version: '0.4.12',
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
        role: 'owner',
        totp_enabled: false,
        totp_required: true,
      });
    }
    if (path === '/api/v1/documents') {
      const s = session();
      if (!('id' in s)) return s;
      if (init.method === 'POST') {
        const doc: FakeDocument = {
          id: next('document'),
          title: (body.title as string | null) ?? null,
          type_key: (body.type_key as string | null | undefined) ?? null,
          issued_by: tidy(body.issued_by as string | null | undefined),
        };
        state.documents.push(doc);
        return ok(viewOf(doc), 201);
      }
      // As the real vault: ?issued_by= filters, whatever the case.
      const by = param(url, 'issued_by');
      const items = by
        ? state.documents.filter((d) => d.issued_by?.toLowerCase() === by.trim().toLowerCase())
        : state.documents;
      return ok({ items: items.map(viewOf), next_cursor: null, has_more: false });
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
      let documentId = target;
      if (documentId === undefined) {
        // The card's details come before the file, or not at all (0.4.9).
        let metadata: CaptureMetadata = {};
        const parts = partsOf(init.body) ?? [];
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
          const problem = checkCaptureMetadata(metadata, {
            me: { member_id: 'fake-member', role: 'owner' },
            members: state.members,
            types: state.types,
          });
          if (problem) {
            return fail(
              problem.status,
              problem.status === 403 ? 'forbidden' : 'validation_failed',
              problem.message,
            );
          }
        }
        const doc: FakeDocument = {
          id: next('document'),
          title: metadata.title ?? null,
          type_key: metadata.type_key ?? null,
          owner_member_id: metadata.owner_member_id ?? null,
          issued_by: tidy(metadata.issued_by),
          visibility: effectiveVisibility(
            metadata,
            state.types.find((t) => t.key === metadata.type_key),
            'owner',
          ),
        };
        state.documents.push(doc);
        documentId = doc.id;
      }
      const made: FakeUpload = { kind, document_id: documentId, version_id: next('version') };
      state.captures.set(key.toLowerCase(), made);
      return ok(answer(made), 201);
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
    const pageOf = /^\/api\/v1\/versions\/([^/]+)\/pages\/(\d+)$/.exec(path);
    if (pageOf && init.method === 'GET') {
      const s = session();
      if (!('id' in s)) return s;
      const version = pageOf[1] as string;
      const n = Number(pageOf[2]);
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
    if (path === '/api/v1/document-types' && init.method === 'GET') {
      const s = session();
      if (!('id' in s)) return s;
      return ok({ items: state.types });
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

/** An issuer as the real vault keeps it: spaces tidied, and blank is nothing. */
function tidy(value: string | null | undefined): string | null {
  return value?.trim().split(/\s+/).join(' ') || null;
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

function viewOf(doc: FakeDocument): DocumentView {
  return {
    id: doc.id,
    title: doc.title,
    type_key: doc.type_key ?? null,
    owner_member_id: doc.owner_member_id ?? null,
    issued_by: doc.issued_by ?? null,
    visibility: doc.visibility ?? 'household',
  } as DocumentView;
}

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
    text: async () => new TextDecoder('latin1').decode(bytes),
    arrayBuffer: async () => bytes.slice().buffer,
  };
}
const empty = () => respond(204, undefined);
const fail = (status: number, code: string, message: string) =>
  respond(status, { error: { code, message, retriable: false, request_id: 'fake' } });
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
