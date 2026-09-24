import type { Capabilities, DocumentView, ReminderView, Tokens } from '@fdv/shared';
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
}

export interface FakeVaultState {
  setupRequired: boolean;
  email: string | null;
  password: string | null;
  sessions: FakeSession[];
  /** access token → session id */
  access: Map<string, string>;
  documents: Array<{ id: string; title: string | null }>;
  /** Upload keys and what each made; a key is for one kind of request. */
  captures: Map<string, FakeUpload>;
  /** What GET /reminders answers, whatever the state asked for. */
  reminders: ReminderView[];
  /** Every request, in order, for assertions. */
  calls: Array<{ method: string; path: string }>;
  /** When true, every request fails as if the network were down. */
  offline: boolean;
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
  const open = (): Tokens => {
    const s: FakeSession = {
      id: next('session'),
      refresh: next('refresh'),
      previous: null,
      revoked: false,
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
      if (s.revoked) return fail(401, 'session_ended', 'That session has ended. Sign in again.');
      return s;
    };

    if (path === '/api/v1/capabilities') {
      const caps: Capabilities = {
        product: 'family-document-vault',
        server_version: '0.4.8',
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
      return ok(open(), 201);
    }
    if (path === '/api/v1/auth/password' && init.method === 'POST') {
      if (String(body.email).toLowerCase() !== state.email || body.password !== state.password) {
        return fail(401, 'invalid_credentials', "That email and password don't match.");
      }
      return ok(open());
    }
    if (path === '/api/v1/auth/refresh' && init.method === 'POST') {
      const presented = String(body.refresh_token);
      const current = state.sessions.find((s) => s.refresh === presented);
      const replayed = state.sessions.find((s) => s.previous === presented);
      if (replayed) {
        // A spent token, presented again, is theft: the whole session goes.
        replayed.revoked = true;
        return fail(401, 'session_ended', 'That session has ended. Sign in again.');
      }
      if (!current || current.revoked) {
        return fail(401, 'session_ended', 'That session has ended. Sign in again.');
      }
      current.previous = current.refresh;
      current.refresh = next('refresh');
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
        const doc = { id: next('document'), title: (body.title as string | null) ?? null };
        state.documents.push(doc);
        return ok(viewOf(doc), 201);
      }
      return ok({ items: state.documents.map(viewOf), next_cursor: null, has_more: false });
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
        const doc = { id: next('document'), title: null };
        state.documents.push(doc);
        documentId = doc.id;
      }
      const made: FakeUpload = { kind, document_id: documentId, version_id: next('version') };
      state.captures.set(key.toLowerCase(), made);
      return ok(answer(made), 201);
    }
    const uploadKey = /^\/api\/v1\/uploads\/([^/]+)$/.exec(path);
    if (uploadKey && init.method === 'GET') {
      const s = session();
      if (!('id' in s)) return s;
      const made = state.captures.get(decodeURIComponent(uploadKey[1] as string).toLowerCase());
      if (!made) return fail(404, 'not_found', 'That upload is not known here.');
      return ok({ state: 'done', document_id: made.document_id, version_id: made.version_id });
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

/** A capture's answer, or a new version's: the shape each endpoint returns. */
function answer(made: FakeUpload) {
  return made.kind === 'capture'
    ? { document_id: made.document_id, version_id: made.version_id, job_id: null, state: 'stored' }
    : { id: made.version_id, document_id: made.document_id };
}

function viewOf(doc: { id: string; title: string | null }): DocumentView {
  return { id: doc.id, title: doc.title } as DocumentView;
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
const empty = () => respond(204, undefined);
const fail = (status: number, code: string, message: string) =>
  respond(status, { error: { code, message, retriable: false, request_id: 'fake' } });
