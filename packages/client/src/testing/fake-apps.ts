import {
  APP_EMPTY_DIGEST,
  APP_HINTS,
  APP_SCOPES_OFFERED,
  APP_SIGNATURE_WINDOW_SECONDS,
  parseAppMetadata,
  type AppIntakeState,
  type AppKeyView,
  type AppMe,
  type ConnectedAppView,
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
 * external id: no Inbox, no reading. Addresses, https and caps are the real
 * vault's to test.
 */

export interface FakeAppKey {
  id: string;
  raw: Uint8Array;
  added_by: 'owner' | 'app';
  created_at: string;
  retired: boolean;
}

export interface FakeIntake {
  state: 'waiting' | 'refused' | 'removed';
  removed_reason: 'withdrawn' | 'declined' | 'expired' | null;
  refusal: 'kind_not_allowed' | null;
  sha256: string | null;
  byte_size: number | null;
  received_at: string | null;
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
  }>;
  ok: (body: unknown, status?: number, headers?: Record<string, string>) => ResponseLike;
  fail: (status: number, code: string, message: string, detail?: string) => ResponseLike;
  empty: () => ResponseLike;
  next: (what: string) => string;
  timezone: () => string;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const APP_ROUTE = /^\/api\/v1\/apps\/(me|intake|intake\/[^/]+|keys|keys\/[^/]+)$/;

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
  let made = 0;
  const uuid = () => `00000000-0000-4000-8000-${(++made).toString(16).padStart(12, '0')}`;
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
      scopes: [...APP_SCOPES_OFFERED],
      allowed_kinds: a.allowed_kinds,
      default_visibility: a.default_visibility,
      auto_file: false,
      daily_files: a.daily_files,
      daily_bytes: a.daily_bytes,
      backfill: null,
      ip_allow: [],
      keys,
      last_used_at: a.last_used_at,
      today: { files: a.files_today, bytes: a.bytes_today },
      refused_today: 0,
      last_refusal: null,
      counts: mine
        ? { waiting: states.filter((s) => s.state === 'waiting').length, filed: 0 }
        : null,
      connection_string: `fdvapp1.${toBase64(new TextEncoder().encode(json), true)}`,
      address: { url: 'https://fake.example', public: false },
    };
  };
  const stateOf = (externalId: string, s: FakeIntake): AppIntakeState => ({
    external_id: externalId,
    state: s.state,
    received_at: s.received_at,
    sha256: s.sha256,
    byte_size: s.byte_size,
    document_id: null,
    version_id: null,
    filed_at: null,
    removed_reason: s.removed_reason,
    refusal: s.refusal,
  });

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
      d.apps.push(a);
      return d.ok(await view(a, who), 201);
    }
    const at = new RegExp(
      `^/api/v1/connected-apps/([^/]+)(/approve|/pause|/resume|/keys(?:/([^/]+))?)?$`,
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
      return d.ok(await view(a, who));
    }
    return null;
  };

  /** A signed request, checked in the contract's order; the app, or the refusal. */
  const signed = async (
    method: string,
    target: string,
    headers: Record<string, string>,
    body: Uint8Array,
    scope: boolean,
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
    if (scope && !APP_SCOPES_OFFERED.includes('documents.send')) {
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
    parts: (
      body: unknown,
    ) => Array<{ name: string; value: string | null; bytes?: Uint8Array; type?: string }> | null,
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
    const a = await signed(
      method,
      target,
      headers,
      body,
      !me && !path.startsWith('/api/v1/apps/keys'),
      me,
    );
    if (!('intake' in a)) return a;
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
        scopes: [...APP_SCOPES_OFFERED],
        send: {
          kinds: kinds.map((k) => ({
            key: k.key,
            label: k.label,
            category: k.category,
            fields: k.fields.map((f) => f.key),
            expires: k.expiry_driver !== null,
          })),
          hints: [...APP_HINTS],
          auto_file: false,
        },
        limits: {
          max_upload_bytes: 104_857_600,
          accepted_types: ['application/pdf', 'image/jpeg', 'image/png'],
          files_per_day: a.daily_files,
          files_today: a.files_today,
          bytes_per_day: a.daily_bytes,
          bytes_today: a.bytes_today,
          read_bytes_per_day: 1024 ** 3,
          read_bytes_today: 0,
          links_per_hour: 60,
          requests_per_minute: 120,
          day_resets_at: new Date(Date.now() + 864e5).toISOString(),
        },
        backfill: null,
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
        return d.ok(stateOf(id, before), 200, { 'idempotent-replayed': 'true' });
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
      return d.ok({
        items: ids.flatMap((id) => {
          const s = a.intake.get(id);
          return s ? [stateOf(id, s)] : [];
        }),
        unknown: ids.filter((id) => !a.intake.has(id)),
      });
    }
    const one = /^\/api\/v1\/apps\/intake\/([^/]+)$/.exec(path);
    if (one) {
      const id = decodeURIComponent(one[1] as string);
      const s = a.intake.get(id);
      if (!s) return d.fail(404, 'not_found', 'Nothing by that id that this app may see.');
      if (method === 'DELETE' && s.state === 'waiting') {
        s.state = 'removed';
        s.removed_reason = 'withdrawn';
      }
      return d.ok(stateOf(id, s));
    }
    return d.fail(404, 'not_found', 'Nothing by that id that this app may see.');
  };

  return { family, app };
}
