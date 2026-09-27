import {
  canSee,
  canSeeList,
  inListAudience,
  listItemHint,
  nextReminder,
  reminderOf,
  type DocumentTypeView,
  type ReminderProblem,
  type Role,
} from '@fdv/shared';
import { vi } from 'vitest';

/**
 * An in-memory stand-in for the API, good enough to drive the screens.
 * Each test starts from `fresh()` and can tweak the state before rendering.
 */

/** A list of documents as the vault keeps it (0.5.12). The signed-in member is "me". */
export interface FakeList {
  id: string;
  name: string;
  description: string | null;
  audience: 'everyone' | 'teens' | 'adults' | 'only_me';
  owner_member_id: string | null;
  etag: string;
  /** The documents on it, by id, in the order they were put there. */
  items: string[];
}

export interface FakeState {
  setupRequired: boolean;
  displayName: string;
  members: Array<Record<string, unknown>>;
  invitations: Array<Record<string, unknown> & { id: string }>;
  ownerChanges: Array<Record<string, unknown> & { id: string }>;
  shares: Array<Record<string, unknown> & { id: string }>;
  activity: Array<{
    id: number;
    at: string;
    text: string;
    notable: boolean;
    document_id: string | null;
  }>;
  /** True once the "only you can open this" moment has been shown. */
  privateNoticeShown: boolean;
  /** The password last set through either password route. */
  passwordChanged: string | null;
  /** The address the forgotten-password form was submitted with. */
  forgotFor: string | null;
  resetValid: boolean;
  resetByOperator: boolean;
  /** Set to require a PIN on the shared-document page. */
  sharePin: string | null;
  shareValid: boolean;
  /** Opens counted by /api/v1/shared/unlock (5.16), and whether this browser has one open. */
  shareOpens: number;
  shareSession: boolean;
  /** CreatedShare.link_url: the vault's FDV_PUBLIC_URL link, when it has one (5.16). */
  shareLinkUrl?: string | null;
  documents: Array<Record<string, unknown>>;
  /** Hold a document's DELETE until this settles (5.1). */
  holdDelete?: Promise<void>;
  /**
   * Hold any request until the promise this gives for it settles (5.4): a
   * slow vault, for what happens on screen meanwhile. Undefined answers
   * at once.
   */
  hold?: (method: string, path: string) => Promise<void> | undefined;
  /** Answer GET /documents in pages of this many, with a cursor (5.1). */
  pageSize?: number;
  types: Array<Record<string, unknown>>;
  /** GET /document-attributes: the library a type's fields come from (0.5.6). */
  attributes?: Array<Record<string, unknown>>;
  /** GET /document-types/{key}/impact, by key; a kind not here has no documents (5.12). */
  impact?: Record<string, Record<string, unknown>>;
  /**
   * `features.reminder_dates` (0.5.16): a kind reminds from any date it
   * shows. Left out, the vault says it has them, as every vault since.
   */
  reminderDates?: boolean;
  /**
   * The reminders the vault holds, as GET /reminders gives them
   * (ReminderView): `due` ones by `?state=due`, `scheduled` and `snoozed`
   * ones by `?state=upcoming`. Left out, there are none.
   */
  reminders?: Array<Record<string, unknown>>;
  /**
   * The household's time zone, as GET /profile gives it: reminders fall due
   * on its calendar. Left out, 'UTC', the vault's default.
   */
  timezone?: string;
  suggestions: Array<Record<string, unknown>>;
  /** Hits the second pass (FND-08) returns; matched on the snippet text. */
  sealed: Array<Record<string, unknown>>;
  passkeys: Array<{
    id: string;
    label: string | null;
    created_at: string;
    last_used_at: string | null;
    backed_up: boolean | null;
    transports: string[];
  }>;
  lastQuery?: string;
  /** True until a credential has been presented again (SEC-17). */
  stepUpNeeded: boolean;
  /**
   * The passport's pages as the vault drew them (0.4.12): how many, or a
   * kind it cannot draw; and how many more times a page is still "being
   * made" before it is ready.
   */
  pagesDrawn: number | 'unsupported';
  pagesPending: number;
  /** The passport's real length, which can be more than is drawn. */
  pageCount: number;
  /**
   * Refresh tokens rotate, and a spent one presented again ends the
   * session — as the real server does. Until 0.4.3 this fake handed back
   * the same token for ever, which is why no test ever caught the web app
   * refreshing twice at once and signing somebody out.
   */
  refreshToken: string;
  spentRefresh: string | null;
  sessionEnded: boolean;
  refreshCalls: number;
  /** Every request but the capability document fails, as if offline. */
  offline: boolean;
  /** False when the link has expired, been used or been revoked. */
  invitationValid: boolean;
  calls: Array<{ method: string; url: string; body?: unknown; headers?: Record<string, string> }>;
  /** Captures that fail as if the connection went, before the next succeeds. */
  captureFailures?: number;
  /** Captures that are stored, and then their answer is lost on the way back. */
  captureAnswersLost?: number;
  /** Upload keys that made a document, for GET /uploads/{key}. */
  uploads?: Record<string, string>;
  /** Every capture that arrived: its form fields in order, and its details. */
  captures?: Array<{ fields: string[]; metadata: Record<string, unknown> | null }>;
  /**
   * Lists of documents (5.15), kept as the vault keeps them (0.5.12).
   * Given, the vault has lists (`features.lists`); left out, it is a vault
   * from before them, and every list route is unanswered.
   */
  lists?: FakeList[];
  /** Answer GET /lists/{id} in pages of this many, with a cursor. */
  listPageSize?: number;
  /**
   * GET /documents/{id}/issuer-suggestions, by document id: who its pages
   * say issued it. A document not here answers 'unavailable'.
   */
  issuerSuggestions?: Record<
    string,
    {
      state: 'ready' | 'pending' | 'unavailable';
      items: Array<{ value: string; source: 'known' | 'page' }>;
    }
  >;
}

export const TOKENS = {
  access_token: 'a.b.c',
  expires_in: 900,
  refresh_token: 'hh.secret',
  refresh_expires_in: 1,
  household_id: 'hh',
  member_id: 'me',
  role: 'owner',
  scopes_unlocked: ['household', 'adults', 'member'],
};

export const ME = {
  id: 'me',
  display_name: 'Mansoor Seikh',
  date_of_birth: null,
  relationship: null,
  is_deceased: false,
  colour: 0,
  has_account: true,
  role: 'owner',
  is_me: true,
  document_count: 1,
};

export const PASSPORT = {
  id: 'doc-1',
  type_key: 'passport',
  title: "Mansoor's passport",
  owner_member_id: 'me',
  category: 'identity',
  visibility: 'household',
  issued: { date: '2021-03-14', precision: 'day' },
  expires: { date: '2031-03-31', precision: 'month' },
  identifier: '563914782',
  physical_location: 'Bedroom safe, top shelf',
  is_essential: true,
  tags: ['travel'],
  notes: null,
  extra: {},
  status: { value: 'active', label: 'Valid for 4 years 6 months' },
  versions: 1,
  latest_version_id: 'v-1',
  created_at: '2026-09-20T09:14:00Z',
  updated_at: '2026-09-20T09:14:00Z',
  deleted_at: null,
  etag: '"abc"',
};

/** A type named for who issued it: "Barclays statement, September 2026" (0.4.10). */
export const BANK_STATEMENT = {
  key: 'bank_statement',
  label: 'Bank / investment statement',
  category: 'financial',
  fields: [],
  expiry_driver: null,
  reminder_leads: [],
  usually_essential: false,
  default_visibility: 'adults',
  issued_by_label: 'Institution',
};

export const TYPES = [
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
    key: 'birth_certificate',
    label: 'Birth certificate',
    category: 'identity',
    fields: [],
    expiry_driver: null,
    reminder_leads: [],
    usually_essential: true,
    default_visibility: 'household',
    issued_by_label: null,
  },
  BANK_STATEMENT,
];

/** A statement from Barclays, for September 2026. */
export const STATEMENT = {
  ...PASSPORT,
  id: 'doc-2',
  type_key: 'bank_statement',
  title: 'Barclays statement, September 2026',
  category: 'financial',
  visibility: 'adults',
  issued: { date: '2026-09-30', precision: 'month' },
  expires: null,
  identifier: null,
  issued_by: 'Barclays',
  physical_location: null,
  is_essential: false,
  tags: [],
  status: { value: 'valid', label: 'Filed' },
  latest_version_id: 'v-2',
  etag: '"statement"',
};

/** A passkey already enrolled on some device. */
export const PASSKEY = {
  id: 'pk-1',
  label: "Mansoor's phone",
  created_at: '2026-09-20T09:14:00Z',
  last_used_at: null,
  backed_up: true,
  transports: ['internal'],
};

/** A hit that only the owner's own session can see. */
export const SEALED_HIT = {
  document_id: 'doc-sealed',
  title: 'Notes to myself',
  type_key: null,
  category: null,
  owner_member_id: 'me',
  status: { value: 'active', label: 'Filed' },
  snippet: 'Ask about the <em>estate</em> agent in March',
  matched_in: 'content',
  rank: 0,
};

/** A child in the household: the person a per-member suggestion is about. */
export const AISHA = {
  ...ME,
  id: 'm-0',
  display_name: 'Aisha',
  date_of_birth: '2016-04-02',
  is_me: false,
  has_account: false,
  role: null,
  colour: 1,
  document_count: 0,
};

/** A missing-document suggestion, as GET /suggestions returns it. */
export const MISSING_BIRTH_CERTIFICATE = {
  key: 'minor_needs_birth_certificate:m-0',
  rule_key: 'minor_needs_birth_certificate',
  member_id: 'm-0',
  member_name: 'Aisha',
  type_key: 'birth_certificate',
  type_label: 'Birth certificate',
  title: 'No birth certificate for Aisha',
  why: 'Schools, passports and benefits all ask for it.',
  missing: 1,
  dismissed: false,
};

export function fresh(over: Partial<FakeState> = {}): FakeState {
  return {
    setupRequired: false,
    refreshToken: 'hh.secret',
    spentRefresh: null,
    sessionEnded: false,
    refreshCalls: 0,
    offline: false,
    displayName: 'The Seikh family',
    members: [ME],
    invitations: [],
    ownerChanges: [],
    shares: [],
    activity: [],
    privateNoticeShown: false,
    passwordChanged: null,
    forgotFor: null,
    resetValid: true,
    resetByOperator: false,
    sharePin: null,
    shareValid: true,
    shareOpens: 0,
    shareSession: false,
    documents: [PASSPORT],
    types: TYPES,
    suggestions: [],
    sealed: [],
    passkeys: [],
    stepUpNeeded: false,
    pagesDrawn: 2,
    pagesPending: 0,
    pageCount: 2,
    invitationValid: true,
    calls: [],
    ...over,
  };
}

export function installFakeApi(state: FakeState) {
  const json = (body: unknown, status = 200) => Promise.resolve(Response.json(body, { status }));
  const refuse = (status: number, code: string, message: string, more: object = {}) =>
    json({ error: { code, message, retriable: false, request_id: 'r', ...more } }, status);
  /** SEC-17, as the vault asks it, saying what the credential is for. */
  const stepUp = (action: 'open_private_document' | 'open_essential' | 'widen_type_visibility') =>
    refuse(
      403,
      'step_up_required',
      `Please confirm it is you ${
        {
          open_private_document: 'to open a document only you can see',
          open_essential: 'to open an Essential document',
          widen_type_visibility: 'to let more people see a kind of document',
        }[action]
      }.`,
      { action },
    );
  /** What opening a document asks for: "only me" first, then Essentials. */
  const askedToOpen = (doc: Record<string, unknown> | undefined) =>
    doc?.visibility === 'private'
      ? ('open_private_document' as const)
      : doc?.is_essential
        ? ('open_essential' as const)
        : null;
  /**
   * What taking a check away asks for (5.4): out of "only me", what opening
   * it asks; Essential turned off, what opening an Essential asks.
   */
  const askedToLoosen = (
    doc: Record<string, unknown> | undefined,
    change: { visibility?: unknown; is_essential?: unknown },
  ) =>
    change.visibility !== undefined &&
    change.visibility !== 'private' &&
    doc?.visibility === 'private'
      ? ('open_private_document' as const)
      : change.is_essential === false && doc?.is_essential
        ? ('open_essential' as const)
        : null;
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const path = url.split('?')[0] ?? url;
    const query = new URLSearchParams(url.split('?')[1] ?? '');
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    state.calls.push({ method, url, body, headers: init?.headers as Record<string, string> });
    const held = state.hold?.(method, path);
    const answer = () => respond(url, method, path, query, body, init);
    return held ? held.then(answer) : answer();
  });

  const respond = (
    url: string,
    method: string,
    path: string,
    query: URLSearchParams,
    body: unknown,
    init?: RequestInit,
  ): Promise<Response> => {
    if (state.offline && path !== '/api/v1/capabilities') {
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    if (path === '/api/v1/capabilities') {
      return json({
        product: 'family-document-vault',
        server_version: '0.1.5',
        api_version: 1,
        min_client_version: '0.0.1',
        edition: 'self_hosted',
        protection_mode: 'standard',
        setup_required: state.setupRequired,
        features: {
          passkeys: true,
          custom_types: true,
          ...(state.lists ? { lists: true } : {}),
          reminder_dates: state.reminderDates ?? true,
        },
        limits: {},
        deprecations: [],
        branding: { display_name: state.displayName },
      });
    }
    if (path === '/api/v1/setup' && method === 'POST') {
      state.setupRequired = false;
      state.displayName = (body as { household_name: string }).household_name;
      return json(TOKENS, 201);
    }
    if (path === '/api/v1/auth/password') {
      state.refreshToken = TOKENS.refresh_token;
      state.spentRefresh = null;
      state.sessionEnded = false;
      return json(TOKENS);
    }
    if (path === '/api/v1/auth/refresh') {
      state.refreshCalls++;
      const presented = (body as { refresh_token: string }).refresh_token;
      if (presented === state.spentRefresh) state.sessionEnded = true;
      if (state.sessionEnded || presented !== state.refreshToken) {
        return json(
          {
            error: {
              code: 'session_ended',
              message: 'That session has ended. Sign in again.',
              retriable: false,
              request_id: 'r',
            },
          },
          401,
        );
      }
      state.spentRefresh = presented;
      state.refreshToken = `hh.secret.${state.refreshCalls}`;
      // The real server decides the role from the session, not the client,
      // so refreshing must not hand back a role the test did not sign in as.
      return json({ ...TOKENS, refresh_token: state.refreshToken, role: storedRole() });
    }
    if (path === '/api/v1/me')
      return json({
        account_id: 'a',
        household_id: 'hh',
        member_id: 'me',
        role: storedRole(),
        totp_enabled: true,
        totp_required: false,
      });
    if (path === '/api/v1/auth/sessions') return json({ items: [] });
    if (path === '/api/v1/auth/passkeys' && method === 'GET')
      return json({ items: state.passkeys });
    if (path.startsWith('/api/v1/auth/passkeys/') && method === 'DELETE') {
      const id = path.slice('/api/v1/auth/passkeys/'.length);
      state.passkeys = state.passkeys.filter((k) => k.id !== id);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (path === '/api/v1/exports' && method === 'POST') {
      // SEC-17: the first attempt asks who is asking, until a credential
      // has been presented.
      if (state.stepUpNeeded) {
        return json(
          {
            error: {
              code: 'step_up_required',
              message: 'Please confirm it is you to export everything.',
              action: 'export_everything',
              retriable: false,
              request_id: 'r',
            },
          },
          403,
        );
      }
      return json({ id: 'ex-1', state: 'queued' }, 202);
    }
    if (path === '/api/v1/auth/step-up' && method === 'POST') {
      const b = body as { password?: string };
      if (b?.password !== 'correct horse battery') {
        return json(
          {
            error: {
              code: 'invalid_credentials',
              message: "That didn't match.",
              retriable: false,
              request_id: 'r',
            },
          },
          401,
        );
      }
      state.stepUpNeeded = false;
      return json({ verified_at: new Date().toISOString(), expires_in: 300 });
    }
    if (path === '/api/v1/auth/step-up') return json({ verified_at: null, expires_in: 0 });
    if (path === '/api/v1/exports') return json({ items: [] });
    if (path === '/api/v1/reminders') {
      // As the vault lists them: due, or coming up (scheduled, snoozed).
      const want = query.get('state') ?? 'all';
      const items = (state.reminders ?? []).filter((r) =>
        want === 'due'
          ? r.status === 'due'
          : want === 'upcoming'
            ? r.status === 'scheduled' || r.status === 'snoozed'
            : ['scheduled', 'due', 'snoozed'].includes(String(r.status)),
      );
      return json({ items });
    }
    const reminderAt = /^\/api\/v1\/reminders\/([^/]+)\/(snooze|acknowledge)$/.exec(path);
    if (reminderAt && method === 'POST') {
      const r = (state.reminders ?? []).find((x) => x.id === reminderAt[1]);
      if (!r) return refuse(404, 'not_found', 'That reminder does not exist.');
      if (reminderAt[2] === 'acknowledge') Object.assign(r, { status: 'acknowledged' });
      else {
        const until = (body as { until: string }).until;
        Object.assign(r, { status: 'snoozed', snoozed_until: until, label: `Later · ${until}` });
      }
      return json(r);
    }
    if (path === '/api/v1/suggestions') {
      const dismissed = query.get('dismissed') === 'true';
      const items = state.suggestions.filter((x) => Boolean(x.dismissed) === dismissed);
      return json({
        items,
        profile_answered: true,
        dismissed_count: state.suggestions.filter((x) => x.dismissed).length,
      });
    }
    if (path.startsWith('/api/v1/suggestions/') && path.endsWith('/dismiss')) {
      const key = decodeURIComponent(path.slice('/api/v1/suggestions/'.length, -'/dismiss'.length));
      const row = state.suggestions.find((x) => x.key === key);
      if (row) row.dismissed = method === 'POST';
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (path === '/api/v1/notifications/push-key')
      return json({ public_key: null, enabled: false });
    if (path === '/api/v1/notifications/preferences')
      return json({ daily_push: true, daily_email: false, weekly_email: true });
    if (path === '/api/v1/devices') return json({ items: [] });
    if (path === '/api/v1/notifications/smtp')
      return json({ configured: false, status: 'untested', secure: false });
    if (path === '/api/v1/notifications/smtp/providers') return json([]);
    if (path === '/api/v1/profile' && method === 'PUT')
      return json({ household_name: state.displayName, ...(body as object) });
    if (path === '/api/v1/profile') {
      // Every role reads the household's name and time zone.
      return json({
        household_name: state.displayName,
        timezone: state.timezone ?? 'UTC',
        owns_home: null,
        rents_home: null,
        vehicle_count: null,
        has_pets: null,
        has_business: null,
        country: null,
        answered_at: null,
      });
    }
    if (path === '/api/v1/members' && method === 'GET') return json({ items: state.members });
    if (path === '/api/v1/members' && method === 'POST') {
      const m = {
        ...ME,
        id: `m-${state.members.length}`,
        display_name: (body as { display_name: string }).display_name,
        is_me: false,
        has_account: false,
        role: null,
        document_count: 0,
        colour: state.members.length,
      };
      state.members.push(m);
      return json(m, 201);
    }
    if (path === '/api/v1/auth/password/change' && method === 'POST') {
      const b = body as { current_password?: string; new_password: string };
      if (state.stepUpNeeded && !b.current_password) {
        return json(
          {
            error: {
              code: 'step_up_required',
              message: 'Please confirm it is you to set a new password.',
              action: 'change_password',
              retriable: false,
              request_id: 'r',
            },
          },
          403,
        );
      }
      if (b.current_password && b.current_password !== 'correct horse battery') {
        return json(
          {
            error: {
              code: 'invalid_credentials',
              message: "That isn't your current password.",
              retriable: false,
              request_id: 'r',
            },
          },
          401,
        );
      }
      state.passwordChanged = b.new_password;
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (path === '/api/v1/auth/password/forgot' && method === 'POST') {
      state.forgotFor = (body as { email: string }).email;
      return json(
        { message: 'If that address has a sign-in here, a link is on its way to it.' },
        202,
      );
    }
    if (path.startsWith('/api/v1/password-resets/')) {
      if (!state.resetValid) {
        return json(
          {
            error: {
              code: 'reset_not_valid',
              message: 'That link is not valid any more. Ask for a new one from the sign-in page.',
              retriable: false,
              request_id: 'r',
            },
          },
          404,
        );
      }
      if (method === 'POST') {
        state.passwordChanged = (body as { password: string }).password;
        return json({ email: 'mansoor@example.test' });
      }
      return json({
        household_name: 'The Seikh family',
        email: 'mansoor@example.test',
        issued_by_operator: state.resetByOperator,
        expires_at: new Date(Date.now() + 36e5).toISOString(),
      });
    }
    if (path.startsWith('/api/v1/audit')) return json({ items: state.activity, next: null });
    if (path.endsWith('/visibility') && method === 'POST') {
      const to = (body as { visibility: string }).visibility;
      const doc = state.documents.find((d) => path.includes(String(d.id)));
      // Out of "only me" asks what opening it asks (5.4).
      const ask = askedToLoosen(doc, { visibility: to });
      if (state.stepUpNeeded && ask) return stepUp(ask);
      if (doc) doc.visibility = to;
      const firstTime = to === 'private' && !state.privateNoticeShown;
      if (firstTime) state.privateNoticeShown = true;
      return json({
        notice: firstTime
          ? {
              title: 'Only you can open this',
              body: 'Nobody can open it after you, unless you leave a key. Leaving a key with someone you trust is not built yet; when it is, this document will be on the list.',
            }
          : null,
      });
    }
    if (path === '/api/v1/shares' && method === 'GET') return json({ items: state.shares });
    if (path.endsWith('/share') && method === 'POST') {
      const documentId = path.split('/')[4] as string;
      const doc = state.documents.find((d) => d.id === documentId && !d.deleted_at);
      // In the vault's order: a link asks what opening it asks, then who
      // may share, then whether there is anything to send (5.4).
      const ask = askedToOpen(doc);
      if (state.stepUpNeeded && ask) return stepUp(ask);
      if (!['owner', 'adult'].includes(storedRole())) {
        return refuse(403, 'forbidden', 'Only an adult can share a document outside the family.');
      }
      if (!doc) return refuse(404, 'not_found', 'That document is not in the vault.');
      if (!doc.latest_version_id) {
        return refuse(
          422,
          'nothing_to_share',
          'There is no file on this document yet, so there is nothing to send.',
        );
      }
      const b = body as { recipient_label?: string; with_pin?: boolean };
      const share = {
        id: `sh-${state.shares.length}`,
        document_id: documentId,
        document_title: 'Mansoor’s passport',
        recipient_label: b.recipient_label ?? null,
        created_by_name: 'Mansoor Seikh',
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
        has_pin: Boolean(b.with_pin),
        open_count: 0,
        last_opened_at: null,
        state: 'active',
        summary: `${b.recipient_label ? `Shared with ${b.recipient_label}` : 'Shared by link'}, not opened yet. Stops working on 30 September.`,
      };
      state.shares.push(share);
      return json(
        {
          share,
          link_token: 'share-secret-0123456789abcdef',
          link_url: state.shareLinkUrl ?? null,
          ...(b.with_pin ? { pin: '4821' } : {}),
        },
        201,
      );
    }
    // After a restore, and turning a link back on (5.16): an owner decides
    // every link; anybody else is shown the ones they made, only to take
    // back — no one else turns a link back on, not even its maker (A55).
    if (path === '/api/v1/after-restore' && method === 'GET') {
      const owner = storedRole() === 'owner';
      const mine = (x: Record<string, unknown>) => x.created_by_name === ME.display_name;
      return json({
        links: state.shares.filter((x) => x.state === 'paused' && (owner || mine(x))),
      });
    }
    if (path.startsWith('/api/v1/shares/') && path.endsWith('/resume') && method === 'POST') {
      if (storedRole() !== 'owner') {
        return refuse(403, 'forbidden', 'Only an owner can turn things back on after a restore.');
      }
      const link = state.shares.find((x) => x.id === path.split('/')[4]);
      if (!link || link.state !== 'paused') {
        return refuse(404, 'not_found', 'That paused link does not exist.');
      }
      Object.assign(link, { state: 'active', paused_at: null, paused_reason: null });
      return json(link);
    }
    // The page at /s (5.16): the token in a body, Open counted, a session after.
    const linkGone = () =>
      refuse(
        404,
        'link_not_valid',
        'That link is not valid any more. Ask whoever sent it for a new one.',
      );
    const linkSession = () => ({
      household_name: 'The Seikh family',
      shared_by: 'Mansoor Seikh',
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      session_expires_at: new Date(Date.now() + 4 * 3600e3).toISOString(),
      items: [
        {
          id: 'doc-shared',
          title: 'Flat 3 tenancy agreement',
          type_label: 'Lease or tenancy agreement',
          filename: 'tenancy.pdf',
          content_type: 'application/pdf',
          byte_size: 1024,
        },
      ],
    });
    if (path === '/api/v1/shared/preview' && method === 'POST') {
      if (!state.shareValid) return linkGone();
      return json({
        household_name: 'The Seikh family',
        shared_by: 'Mansoor Seikh',
        protection: state.sharePin ? ['pin'] : [],
        expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
        document_title: state.sharePin ? null : 'Flat 3 tenancy agreement',
      });
    }
    if (path === '/api/v1/shared/unlock' && method === 'POST') {
      if (!state.shareValid) return linkGone();
      if (state.sharePin && (body as { secret?: string }).secret !== state.sharePin) {
        return refuse(
          401,
          'pin_wrong',
          'That PIN is not right. Check with whoever sent you the link.',
        );
      }
      state.shareOpens += 1;
      state.shareSession = true;
      return json(linkSession());
    }
    if (path === '/api/v1/shared/items' && method === 'GET') {
      if (!state.shareSession) {
        return refuse(
          401,
          'share_session_ended',
          'This page has been open too long, or was opened somewhere else. Open the link you were sent again.',
        );
      }
      return json(linkSession());
    }
    if (path.startsWith('/api/v1/shares/') && method === 'DELETE') {
      const id = path.slice('/api/v1/shares/'.length);
      state.shares = state.shares.filter((x) => x.id !== id);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (path.startsWith('/api/v1/shared/') && path.endsWith('/open')) {
      if (state.sharePin && (body as { pin?: string }).pin !== state.sharePin) {
        return json(
          {
            error: {
              code: 'pin_wrong',
              message: 'That PIN is not right. Check with whoever sent you the link.',
              retriable: false,
              request_id: 'r',
            },
          },
          401,
        );
      }
      return json({
        document_title: 'Flat 3 tenancy agreement',
        document_type: 'Lease or tenancy agreement',
        shared_by: 'Mansoor Seikh',
        expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
        byte_size: 1024,
        content_type: 'application/pdf',
        filename: 'tenancy.pdf',
      });
    }
    if (path.startsWith('/api/v1/shared/') && method === 'GET') {
      if (!state.shareValid) {
        return json(
          {
            error: {
              code: 'link_not_valid',
              message: 'That link is not valid any more. Ask whoever sent it for a new one.',
              retriable: false,
              request_id: 'r',
            },
          },
          404,
        );
      }
      return json({
        household_name: 'The Seikh family',
        needs_pin: Boolean(state.sharePin),
        expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
        document_title: state.sharePin ? null : 'Flat 3 tenancy agreement',
        shared_by: 'Mansoor Seikh',
      });
    }
    if (path === '/api/v1/owner-changes' && method === 'GET')
      return json({ items: state.ownerChanges });
    if (path.startsWith('/api/v1/owner-changes/') && path.endsWith('/refuse')) {
      const id = path.split('/')[4] as string;
      state.ownerChanges = state.ownerChanges.filter((r) => r.id !== id);
      return json({ id, state: 'refused' });
    }
    if (path.startsWith('/api/v1/owner-changes/') && method === 'DELETE') {
      const id = path.slice('/api/v1/owner-changes/'.length);
      state.ownerChanges = state.ownerChanges.filter((r) => r.id !== id);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (path.endsWith('/role') && method === 'POST') {
      const memberId = path.split('/')[4] as string;
      const role = (body as { role: string }).role;
      const target = state.members.find((m) => m.id === memberId);
      if (target?.role === 'owner' && role !== 'owner') {
        state.ownerChanges.push({
          id: 'ocr-1',
          target_member_id: memberId,
          target_name: String(target.display_name),
          requested_by_name: 'Mansoor Seikh',
          action: 'demote',
          requested_at: new Date().toISOString(),
          opens_at: new Date(Date.now() + 7 * 864e5).toISOString(),
          lapses_at: new Date(Date.now() + 30 * 864e5).toISOString(),
          state: 'waiting',
          about_me: false,
          summary: `Mansoor Seikh asked for ${String(target.display_name)} to stop being an owner. Nothing changes until then.`,
        });
        return json({
          applied: false,
          role: 'owner',
          message: 'Every owner has been told. They can refuse before then.',
        });
      }
      if (target) target.role = role;
      return json({ applied: true, role, message: `They are now ${role}.` });
    }
    if (path.endsWith('/sign-in') && method === 'DELETE') {
      const memberId = path.split('/')[4] as string;
      const target = state.members.find((m) => m.id === memberId);
      if (target) {
        target.has_account = false;
        target.role = null;
        target.sign_in_removed = true;
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (path.endsWith('/sign-in') && method === 'POST') {
      const memberId = path.split('/')[4] as string;
      const target = state.members.find((m) => m.id === memberId);
      const { role } = body as { role: string };
      if (target) {
        target.has_account = true;
        target.role = role;
        target.sign_in_removed = false;
      }
      return json({
        message: `${String(target?.display_name)} can sign in again with their own password.`,
      });
    }
    if (path === '/api/v1/invitations' && method === 'GET')
      return json({ items: state.invitations });
    if (path === '/api/v1/invitations' && method === 'POST') {
      const b = body as { display_name?: string; member_id?: string; email: string; role: string };
      const invitation = {
        id: `inv-${state.invitations.length}`,
        member_id: b.member_id ?? `m-${state.members.length}`,
        display_name: b.display_name ?? 'Someone',
        email: b.email,
        role: b.role,
        invited_by: 'Mansoor Seikh',
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
        state: 'pending',
        attempts_left: 5,
      };
      state.invitations.push(invitation);
      return json(
        { invitation, link_token: 'link-secret-0123456789abcdef', code: 'ABCD-EFGH' },
        201,
      );
    }
    if (path.startsWith('/api/v1/invitations/') && !state.invitationValid) {
      return json(
        {
          error: {
            code: 'invitation_not_valid',
            message:
              'That invitation link is not valid any more. Ask whoever invited you to send a new one.',
            retriable: false,
            request_id: 'r',
          },
        },
        404,
      );
    }
    if (path.startsWith('/api/v1/invitations/') && path.endsWith('/accept')) {
      if ((body as { code: string }).code.toUpperCase().replace(/[^A-Z0-9]/g, '') !== 'ABCDEFGH') {
        return json(
          {
            error: {
              code: 'invitation_code_wrong',
              message: 'That code is not right. 4 tries left.',
              retriable: false,
              request_id: 'r',
            },
          },
          401,
        );
      }
      return json(TOKENS, 201);
    }
    if (path.startsWith('/api/v1/invitations/') && method === 'GET') {
      return json({
        household_name: 'The Seikh family',
        display_name: 'Sam',
        // Masked, as the vault shows it before the code (5.3).
        email: 's•••@example.test',
        role: 'adult',
        role_label: 'Adult',
        invited_by: 'Mansoor Seikh',
        expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      });
    }
    if (path.startsWith('/api/v1/invitations/') && method === 'DELETE') {
      const id = path.slice('/api/v1/invitations/'.length);
      state.invitations = state.invitations.filter((i) => i.id !== id);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    // Kinds of document, managed (5.12), as the vault manages them (0.5.10).
    if (path === '/api/v1/document-types' && method === 'GET') {
      // A hidden kind is listed with ?all=true (the editor's list), and,
      // marked hidden, while a document uses it, so that one still says
      // what it is — as the vault lists them (0.5.6).
      const all = query.get('all') === 'true';
      const used = (key: unknown) => state.documents.some((d) => d.type_key === key);
      return json({ items: state.types.filter((t) => all || !t.hidden || used(t.key)) });
    }
    if (path === '/api/v1/document-attributes' && method === 'GET') {
      return json({ items: state.attributes ?? [] });
    }
    if (path === '/api/v1/document-attributes' && method === 'POST') {
      const b = body as { label: string; kind: string; choices?: string[] | null };
      const made = {
        key: `h_field${(state.attributes ?? []).length}`,
        label: b.label,
        kind: b.kind,
        choices: b.kind === 'choice' ? (b.choices ?? []) : null,
        builtin: false,
      };
      state.attributes = [...(state.attributes ?? []), made];
      return json(made, 201);
    }
    if (path === '/api/v1/document-types' && method === 'POST') {
      const made = changedKind(
        {
          key: `h_kind${state.types.length}`,
          label: '',
          category: 'other',
          fields: [],
          expiry_driver: null,
          reminder_leads: [],
          remind_from: null,
          remind_leads: [],
          usually_essential: false,
          default_visibility: 'household',
          issued_by_label: null,
          builtin: false,
          hidden: false,
          core: {},
        },
        body as Record<string, unknown>,
        state.attributes ?? [],
        true,
      );
      if ('problem' in made) {
        return refuse(422, 'validation_failed', made.problem.message, {
          detail: made.problem.detail,
        });
      }
      // Never pushed: `types` may be the shared TYPES of another test.
      state.types = [...state.types, { ...made.kind, etag: `"${String(made.kind.key)}.1"` }];
      return json(state.types[state.types.length - 1], 201);
    }
    const kindAt = /^\/api\/v1\/document-types\/([^/]+)(\/archive|\/restore|\/impact)?$/.exec(path);
    if (kindAt) {
      const kind = state.types.find((t) => t.key === decodeURIComponent(kindAt[1] as string));
      if (!kind) return refuse(404, 'not_found', 'That kind of document is not on the list.');
      const keep = (next: Record<string, unknown>) => {
        const saved = { ...next, etag: `"${String(kind.key)}.${state.calls.length}"` };
        state.types = state.types.map((t) => (t === kind ? saved : t));
        return json(saved);
      };
      if (kindAt[2] === '/impact') {
        return json(
          state.impact?.[String(kind.key)] ?? {
            key: kind.key,
            documents: 0,
            in_trash: 0,
            core: Object.fromEntries(
              [
                'identifier',
                'issued_by',
                'issued',
                'expires',
                'physical_location',
                'tags',
                'notes',
              ].map((f) => [f, { with_value: 0, without_value: 0 }]),
            ),
            fields: [],
            reminders: 0,
            reminders_by_source: {},
            unseen: "Documents you can't see may also be affected.",
          },
        );
      }
      if (kindAt[2] && method === 'POST') {
        return keep({ ...kind, hidden: kindAt[2] === '/archive' });
      }
      if (method === 'PATCH') {
        const ifMatch = (init?.headers as Record<string, string> | undefined)?.['if-match'];
        if (ifMatch && ifMatch !== kind.etag) {
          return refuse(
            409,
            'conflict',
            'Someone else changed this kind of document. Reload and try again.',
          );
        }
        // Letting more people see its next document: an owner's, confirmed.
        const reach: Record<string, number> = { private: 1, adults: 2, household: 3 };
        const to = (body as { default_visibility?: string }).default_visibility;
        if (to && (reach[to] ?? 0) > (reach[String(kind.default_visibility)] ?? 0)) {
          if (storedRole() !== 'owner') {
            return refuse(
              403,
              'forbidden',
              'Only an owner can let more people see a kind of document from now on.',
            );
          }
          if (state.stepUpNeeded) return stepUp('widen_type_visibility');
        }
        const next = changedKind(
          kind,
          body as Record<string, unknown>,
          state.attributes ?? [],
          false,
        );
        if ('problem' in next) {
          return refuse(422, 'validation_failed', next.problem.message, {
            detail: next.problem.detail,
          });
        }
        return keep(next.kind);
      }
    }
    if (
      state.lists &&
      (path === '/api/v1/lists' ||
        path.startsWith('/api/v1/lists/') ||
        /^\/api\/v1\/documents\/[^/]+\/lists$/.test(path))
    ) {
      const ifMatch = (init?.headers as Record<string, string> | undefined)?.['if-match'];
      return answerLists(state, method, path, query, body, ifMatch);
    }
    if (path === '/api/v1/documents/counts') {
      return json({
        by_member: [{ member_id: 'me', count: state.documents.length }],
        by_category: [{ category: 'identity', count: state.documents.length }],
      });
    }
    if (path === '/api/v1/documents' && method === 'GET') {
      // The Trash is its own list (5.1), as the vault's `deleted=true` is.
      const inTrash = query.get('deleted') === 'true';
      let items = state.documents.filter((d) => Boolean(d.deleted_at) === inTrash);
      if (state.pageSize) {
        const start = Number(query.get('cursor') ?? 0);
        const more = start + state.pageSize < items.length;
        return json({
          items: items.slice(start, start + state.pageSize).map(listed),
          next_cursor: more ? String(start + state.pageSize) : null,
          has_more: more,
        });
      }
      const cat = query.get('category');
      if (cat) items = items.filter((d) => d.category === cat);
      const from = query.get('issued_by');
      if (from) items = items.filter((d) => sameIssuer(d.issued_by, from));
      return json({ items: items.map(listed), next_cursor: null, has_more: false });
    }
    if (path === '/api/v1/issuers') {
      // Distinct, most used first; those used for type_key before the rest.
      const typeKey = query.get('type_key');
      const q = (query.get('q') ?? '').trim().toLowerCase();
      const rows = new Map<string, { issued_by: string; count: number; forType: boolean }>();
      for (const d of state.documents) {
        const name = typeof d.issued_by === 'string' ? d.issued_by.trim() : '';
        if (!name || !name.toLowerCase().includes(q)) continue;
        if (query.get('category') && d.category !== query.get('category')) continue;
        if (query.get('member_id') && d.owner_member_id !== query.get('member_id')) continue;
        const row = rows.get(name.toLowerCase()) ?? { issued_by: name, count: 0, forType: false };
        row.count += 1;
        if (typeKey && d.type_key === typeKey) row.forType = true;
        rows.set(name.toLowerCase(), row);
      }
      const items = [...rows.values()]
        // As the vault: for a type, only those who have issued that type.
        .filter((r) => !typeKey || r.forType)
        .sort(
          (a, b) =>
            Number(b.forType) - Number(a.forType) ||
            b.count - a.count ||
            a.issued_by.localeCompare(b.issued_by),
        )
        .map(({ issued_by, count }) => ({ issued_by, count }));
      return json({ items });
    }
    if (path === '/api/v1/capture') {
      if (state.captureFailures) {
        state.captureFailures -= 1;
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      const form = init?.body as FormData;
      const fields = [...form.keys()];
      const raw = form.get('metadata');
      const metadata =
        typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : null;
      (state.captures ??= []).push({ fields, metadata });
      const doc = {
        ...PASSPORT,
        id: 'doc-new',
        type_key: (metadata?.type_key as string | undefined) ?? null,
        title: (metadata?.title as string | undefined) ?? null,
        owner_member_id: (metadata?.owner_member_id as string | undefined) ?? null,
        issued_by: (metadata?.issued_by as string | undefined) ?? null,
        visibility: (metadata?.visibility as string | undefined) ?? 'household',
        notes: (metadata?.notes as string | undefined) ?? null,
        extra: (metadata?.extra as Record<string, unknown> | undefined) ?? {},
        category: null,
        status: metadata?.type_key
          ? { value: 'valid', label: 'Valid' }
          : { value: 'needs_info', label: 'Needs a name' },
        etag: '"new"',
      };
      state.documents.push(doc);
      const key = (init?.headers as Record<string, string> | undefined)?.['idempotency-key'];
      if (key) (state.uploads ??= {})[key] = doc.id;
      if (state.captureAnswersLost) {
        state.captureAnswersLost -= 1;
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      return json(
        { document_id: 'doc-new', version_id: 'v-new', job_id: null, state: 'stored' },
        201,
      );
    }
    const uploadMatch = /^\/api\/v1\/uploads\/([^/]+)$/.exec(path);
    if (uploadMatch) {
      const made = state.uploads?.[uploadMatch[1] as string];
      return made
        ? json({ state: 'done', document_id: made, version_id: 'v-new' })
        : json({ error: { code: 'not_found', message: 'That upload is not known here.' } }, 404);
    }
    const suggestionsMatch = /^\/api\/v1\/documents\/([^/]+)\/issuer-suggestions$/.exec(path);
    if (suggestionsMatch) {
      return json(
        state.issuerSuggestions?.[suggestionsMatch[1] as string] ?? {
          state: 'unavailable',
          items: [],
        },
      );
    }
    const restoreMatch = /^\/api\/v1\/documents\/([^/]+)\/restore$/.exec(path);
    if (restoreMatch && method === 'POST') {
      const doc = state.documents.find((d) => d.id === restoreMatch[1]);
      if (doc) doc.deleted_at = null;
      return json(doc);
    }
    const docMatch = /^\/api\/v1\/documents\/([^/]+)$/.exec(path);
    if (docMatch) {
      const doc = state.documents.find((d) => d.id === docMatch[1]);
      if (!doc)
        return json(
          { error: { code: 'not_found', message: 'That document is not in the vault.' } },
          404,
        );
      if (method === 'DELETE') {
        const answer = () => {
          doc.deleted_at = '2026-09-26T10:04:00Z';
          return new Response(null, { status: 204 });
        };
        return state.holdDelete ? state.holdDelete.then(answer) : Promise.resolve(answer());
      }
      if (method === 'PATCH') {
        // As the vault: taking a check away asks for it first (5.4), and a
        // write made from an older copy is refused, with the document as it
        // is now.
        const ask = askedToLoosen(doc, body as object);
        if (state.stepUpNeeded && ask) return stepUp(ask);
        const ifMatch = (init?.headers as Record<string, string> | undefined)?.['if-match'];
        if (ifMatch && ifMatch !== doc.etag) {
          return json(
            {
              error: {
                code: 'conflict',
                message: 'Someone else changed this document. Reload and try again.',
                retriable: false,
                request_id: 'r',
                detail: JSON.stringify(doc),
              },
            },
            409,
          );
        }
        // Details merge, and null takes one away (0.5.7).
        const change = { ...(body as Record<string, unknown>) };
        if (change.extra && typeof change.extra === 'object') {
          const merged = { ...((doc.extra as Record<string, unknown> | undefined) ?? {}) };
          for (const [k, v] of Object.entries(change.extra)) {
            if (v === null) delete merged[k];
            else merged[k] = v;
          }
          change.extra = merged;
        }
        // A new ETag for every change, as the vault's comes from when it was made.
        Object.assign(doc, change, { etag: `"edit-${state.calls.length}"` });
        return json(doc);
      }
      return json(doc);
    }
    const versionsOf = /^\/api\/v1\/documents\/([^/]+)\/versions$/.exec(path);
    if (versionsOf) {
      // Each document's own current version: the passport's is v-1.
      const doc = state.documents.find((d) => d.id === versionsOf[1]);
      if (method === 'POST') {
        return json(
          {
            id: 'v-new',
            document_id: versionsOf[1],
            version_no: 2,
            filename: 'renewed.pdf',
            mime: 'application/pdf',
            byte_size: 1024,
            sha256: 'y',
            page_count: 1,
            ocr_status: 'pending',
            uploaded_at: '2026-09-26T10:00:00Z',
            uploaded_by_name: 'Mansoor Seikh',
            preview_pages: null,
          },
          201,
        );
      }
      // Details with no file yet have no versions.
      if (doc && doc.latest_version_id === null) return json({ items: [] });
      return json({
        items: [
          {
            id: (doc?.latest_version_id as string | undefined) ?? 'v-1',
            document_id: versionsOf[1],
            version_no: 1,
            filename: 'passport.pdf',
            mime: 'application/pdf',
            byte_size: 2048,
            sha256: 'x',
            page_count: state.pageCount,
            ocr_status: 'done',
            uploaded_at: '2026-09-20T09:14:00Z',
            uploaded_by_name: 'Mansoor Seikh',
            preview_pages:
              state.pagesDrawn === 'unsupported'
                ? 0
                : state.pagesPending > 0
                  ? null
                  : state.pagesDrawn,
          },
        ],
      });
    }
    const pageOf = /^\/api\/v1\/versions\/[^/]+\/pages\/(\d+)$/.exec(path);
    if (pageOf) {
      const refuse = (code: string, message: string, headers: Record<string, string> = {}) =>
        Promise.resolve(
          Response.json(
            { error: { code, message, retriable: code === 'preview_pending', request_id: 'r' } },
            { status: 404, headers },
          ),
        );
      if (state.pagesDrawn === 'unsupported') {
        return refuse(
          'no_preview',
          "There's no preview for this kind of file. You can save a copy to open it.",
        );
      }
      if (state.pagesPending > 0) {
        state.pagesPending -= 1;
        // No waiting in a test: "try again" means now.
        return refuse('preview_pending', 'The preview is being made.', { 'retry-after': '0' });
      }
      const n = Number(pageOf[1]);
      if (n > state.pagesDrawn) {
        return refuse(
          'no_preview',
          "There's no preview of this page. You can save a copy to open it.",
        );
      }
      return Promise.resolve(
        new Response(`page ${n}`, {
          status: 200,
          headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, no-store' },
        }),
      );
    }
    const contentOf = /^\/api\/v1\/versions\/([^/]+)\/content$/.exec(path);
    if (contentOf) {
      // An Only me or an Essential document asks who is asking first (SEC-17).
      const doc = state.documents.find((d) => d.latest_version_id === contentOf[1]);
      const ask = askedToOpen(doc);
      if (state.stepUpNeeded && ask) return stepUp(ask);
      return Promise.resolve(
        new Response('%PDF-1.4', {
          status: 200,
          headers: { 'content-type': 'application/pdf', 'cache-control': 'private, no-store' },
        }),
      );
    }
    if (/^\/api\/v1\/versions\/[^/]+\/thumbnail$/.test(path))
      return json({ error: { code: 'no_thumbnail', message: 'No preview yet.' } }, 404);
    if (path === '/api/v1/search') {
      const q = query.get('q') ?? '';
      state.lastQuery = q;
      const needle = q.trim().toLowerCase();
      // Documents whose name or issuer has the words, as the index would.
      const named = state.documents
        .filter((d) =>
          [d.title, d.issued_by].some(
            (v) => typeof v === 'string' && needle !== '' && v.toLowerCase().includes(needle),
          ),
        )
        .map((d) => ({
          document_id: d.id,
          title: d.title,
          type_key: d.type_key,
          category: d.category,
          owner_member_id: d.owner_member_id,
          status: d.status,
          issued_by: d.issued_by ?? null,
          issued: d.issued ?? null,
          snippet: '',
          matched_in: 'title',
        }));
      const from = query.get('issued_by');
      // The words inside doc-1's pages, while they are in the index: made
      // Only me, they move to the sealed table, out of the first pass.
      const inPages = state.documents.find((d) => d.id === 'doc-1')?.visibility !== 'private';
      const items = [
        ...(q.includes('4471') && inPages
          ? [
              {
                document_id: 'doc-1',
                title: 'Home insurance policy',
                type_key: 'insurance_policy',
                category: 'insurance',
                owner_member_id: 'me',
                status: { value: 'active', label: 'Valid for 5 months' },
                snippet: '…policy number <em>4471</em>-QB <script>x</script>…',
                matched_in: 'content',
              },
            ]
          : []),
        ...named,
      ].filter((h) => !from || sameIssuer((h as { issued_by?: unknown }).issued_by, from));
      return json({
        items,
        sealed_pending: state.sealed.length
          ? { count: state.sealed.length, token: 'sealed-handle' }
          : { count: 0 },
      });
    }
    if (path === '/api/v1/search/sealed') {
      const q = query.get('token') === 'sealed-handle' ? (state.lastQuery ?? '') : '';
      const items = state.sealed.filter((s) => {
        const snippet = typeof s.snippet === 'string' ? s.snippet : '';
        return snippet.toLowerCase().includes(q.toLowerCase());
      });
      return json({ items, searched: state.sealed.length });
    }
    return Promise.reject(new Error(`unmocked ${method} ${url}`));
  };
  vi.stubGlobal('fetch', fn);
  return fn;
}

/**
 * Lists of documents, as the vault answers them (0.5.12): each reader is
 * given the lists their role and the list's audience allow — a viewer
 * none but their own — and, on each, the documents they could see anyway,
 * counted so. Only a list's maker changes it, while in its audience (A18);
 * its maker deletes it, or an owner once nobody may change it. A page's
 * cursor names the last document given. Several put on at once — up to
 * 200 — go on together or not at all.
 */
function answerLists(
  state: FakeState,
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
  ifMatch: string | undefined,
): Promise<Response> {
  const json = (b: unknown, status = 200) => Promise.resolve(Response.json(b, { status }));
  const done = () => Promise.resolve(new Response(null, { status: 204 }));
  const refuse = (status: number, code: string, message: string, more: object = {}) =>
    json({ error: { code, message, retriable: false, request_id: 'r', ...more } }, status);
  const noList = () => refuse(404, 'not_found', 'That list does not exist.');
  const noDocument = () => refuse(404, 'not_found', 'That document is not in the vault.');
  const role = storedRole() as Role;
  const reader = { role, memberId: 'me' };
  const all = state.lists ?? [];
  const seesList = (l: FakeList) => canSeeList(reader, l);
  const seesDoc = (d: Record<string, unknown> | undefined): d is Record<string, unknown> =>
    d !== undefined &&
    !d.deleted_at &&
    canSee(reader, {
      visibility: String(d.visibility),
      owner_member_id: (d.owner_member_id as string | null | undefined) ?? null,
    });
  const docsOn = (l: FakeList) =>
    l.items.map((id) => state.documents.find((d) => d.id === id)).filter(seesDoc);
  const view = (l: FakeList) => ({
    id: l.id,
    name: l.name,
    description: l.description,
    audience: l.audience,
    owner_member_id: l.owner_member_id,
    mine: l.owner_member_id === 'me',
    item_count: docsOn(l).length,
    created_at: '2026-09-26T10:00:00Z',
    updated_at: '2026-09-26T10:00:00Z',
    etag: l.etag,
  });
  const detail = (l: FakeList, from = 0, limit = state.listPageSize ?? 50) => {
    const docs = docsOn(l);
    const more = from + limit < docs.length;
    const shown = docs.slice(from, from + limit);
    const last = shown[shown.length - 1];
    return {
      ...view(l),
      items: shown.map((d) => ({
        document: listed(d),
        added_at: '2026-09-26T10:00:00Z',
        hint:
          l.owner_member_id === 'me'
            ? listItemHint(l.audience, {
                visibility: String(d.visibility),
                owner_member_id: (d.owner_member_id as string | null | undefined) ?? null,
              })
            : null,
      })),
      // As the vault's: the last document given, and nothing about where
      // it stands among those the reader is not given.
      next_cursor: more && last ? btoa(JSON.stringify({ after: last.id })) : null,
      has_more: more,
    };
  };
  /**
   * Where the page after `cursor` starts: after the document it names, as
   * the reader is given the list now. One they are not given now — taken
   * off, moved to the Trash — is a cursor that is not valid.
   */
  const startAfter = (l: FakeList, cursor: string): number | null => {
    let after: unknown;
    try {
      after = (JSON.parse(atob(cursor)) as { after?: unknown }).after;
    } catch {
      return null;
    }
    const at = docsOn(l).findIndex((d) => d.id === after);
    return at === -1 ? null : at + 1;
  };
  /**
   * An owner may delete somebody else's list only when nobody may change
   * it any more: its maker has no sign-in, or is not one of its audience.
   */
  const stranded = (l: FakeList) => {
    const maker = state.members.find((m) => m.id === l.owner_member_id);
    const makerRole = maker?.role as Role | null | undefined;
    return !makerRole || !inListAudience(makerRole, l.audience);
  };
  const manage = () =>
    role === 'viewer'
      ? refuse(
          403,
          'forbidden',
          'Viewers can open and download documents, but not make lists of them.',
        )
      : null;
  /** Only its maker, in its audience, changes a list (A18). */
  const refusedChange = (l: FakeList) =>
    manage() ??
    (l.owner_member_id !== 'me'
      ? refuse(403, 'forbidden', 'Only the person who made this list can change it.')
      : !inListAudience(role, l.audience)
        ? refuse(
            403,
            'forbidden',
            'This list is for people you are no longer one of. You can still delete it, but not change it.',
          )
        : null);
  const tidy = (name: unknown) =>
    typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';

  const onDocument = /^\/api\/v1\/documents\/([^/]+)\/lists$/.exec(path);
  if (onDocument) {
    const id = onDocument[1] as string;
    if (!seesDoc(state.documents.find((d) => d.id === id))) return noDocument();
    return json({ items: all.filter((l) => seesList(l) && l.items.includes(id)).map(view) });
  }
  if (path === '/api/v1/lists' && method === 'GET') {
    const seen = all.filter(seesList).sort((a, b) => a.name.localeCompare(b.name));
    return json({ items: seen.map(view) });
  }
  if (path === '/api/v1/lists' && method === 'POST') {
    const b = body as {
      name?: unknown;
      audience?: FakeList['audience'];
      description?: string | null;
    };
    const refused = manage();
    if (refused) return refused;
    const name = tidy(b.name);
    if (!name) {
      return refuse(422, 'validation_failed', 'Give the list a name.', { detail: 'name' });
    }
    if (!b.audience) {
      return refuse(422, 'validation_failed', 'Say who the list is for.', { detail: 'audience' });
    }
    if (!inListAudience(role, b.audience)) {
      return refuse(403, 'forbidden', 'Only an adult can make a list for the adults.');
    }
    const made: FakeList = {
      id: `list-${all.length + 1}`,
      name,
      description: b.description?.trim() || null,
      audience: b.audience,
      owner_member_id: 'me',
      etag: `"list-${all.length + 1}.1"`,
      items: [],
    };
    // Never pushed: the array may be another test's.
    state.lists = [...all, made];
    return json(detail(made), 201);
  }
  const at = /^\/api\/v1\/lists\/([^/]+)(\/items(?:\/([^/]+))?)?$/.exec(path);
  if (at?.[2] && !at[3] && method === 'POST') {
    // As the vault's route takes them, before it looks for the list: one
    // at least, and at most 200.
    const refused = manage();
    if (refused) return refused;
    const ids = (body as { document_ids?: unknown } | undefined)?.document_ids;
    if (!Array.isArray(ids) || ids.length < 1) {
      return refuse(422, 'validation_failed', 'Too small: expected array to have >=1 items');
    }
    if (ids.length > 200) {
      return refuse(422, 'validation_failed', 'Too big: expected array to have <=200 items');
    }
  }
  const list = at ? all.find((l) => l.id === at[1]) : undefined;
  if (!at || !list || !seesList(list)) return noList();
  const replace = (next: FakeList) => {
    state.lists = (state.lists ?? []).map((l) => (l.id === list.id ? next : l));
    return next;
  };
  if (!at[2]) {
    if (method === 'GET') {
      const cursor = query.get('cursor');
      const from = cursor === null ? 0 : startAfter(list, cursor);
      if (from === null) {
        return refuse(422, 'validation_failed', 'That page cursor is not valid.');
      }
      const limit = query.get('limit');
      return json(detail(list, from, limit ? Number(limit) : undefined));
    }
    if (method === 'PATCH') {
      const refused = refusedChange(list);
      if (refused) return refused;
      if (ifMatch && ifMatch !== list.etag) {
        return refuse(409, 'conflict', 'Someone else changed this list. Reload and try again.', {
          detail: JSON.stringify(view(list)),
        });
      }
      const b = body as {
        name?: unknown;
        audience?: FakeList['audience'];
        description?: string | null;
      };
      const name = b.name === undefined ? list.name : tidy(b.name);
      if (!name)
        return refuse(422, 'validation_failed', 'Give the list a name.', { detail: 'name' });
      const changed = replace({
        ...list,
        name,
        audience: b.audience ?? list.audience,
        description: b.description === undefined ? list.description : b.description?.trim() || null,
        etag: `"${list.id}.${state.calls.length}"`,
      });
      return json(detail(changed));
    }
    if (method === 'DELETE') {
      // Its maker, whatever their role now; an owner, only when stranded.
      if (list.owner_member_id !== 'me') {
        const refused = manage();
        if (refused) return refused;
        if (role !== 'owner' || !stranded(list)) {
          return refuse(403, 'forbidden', 'Only the person who made this list can change it.');
        }
      }
      state.lists = (state.lists ?? []).filter((l) => l.id !== list.id);
      return done();
    }
  }
  const refused = refusedChange(list);
  if (refused) return refused;
  if (!at[3] && method === 'POST') {
    const ids = (body as { document_ids: string[] }).document_ids;
    // All of them, or none.
    if (!ids.every((id) => seesDoc(state.documents.find((d) => d.id === id)))) return noDocument();
    const changed = replace({
      ...list,
      items: [
        ...list.items,
        ...ids.filter((id, i) => !list.items.includes(id) && ids.indexOf(id) === i),
      ],
    });
    return json(detail(changed));
  }
  if (at[3] && method === 'DELETE') {
    const id = decodeURIComponent(at[3]);
    if (!list.items.includes(id)) {
      return refuse(404, 'not_found', 'That document is not on this list.');
    }
    replace({ ...list, items: list.items.filter((d) => d !== id) });
    return done();
  }
  return Promise.reject(new Error(`unmocked ${method} ${path}`));
}

/**
 * A document as a list gives it: an Only me document's notes and details
 * are sealed, opened only in its owner's own request for it (0.5.8).
 */
function listed(d: Record<string, unknown>): Record<string, unknown> {
  if (d.visibility !== 'private') return d;
  return { ...d, notes: null, has_notes: d.notes != null, extra: {} };
}

/**
 * A kind of document with a change made to it, as the vault makes it
 * (0.5.10): each fixed field key by key (Expires shown is whether it
 * expires), its own fields from the library by key. Then the date it
 * reminds from and how long before, by the vault's own rules (nextReminder,
 * 0.5.15): answered as the vault answers them, `reminder_leads` Expires's
 * alone, and the reminding field always required — or the refusal.
 */
function changedKind(
  kind: Record<string, unknown>,
  change: Record<string, unknown>,
  library: Array<Record<string, unknown>>,
  made: boolean,
): { kind: Record<string, unknown> } | { problem: ReminderProblem } {
  const next: Record<string, unknown> = { ...kind };
  for (const k of ['label', 'category', 'default_visibility', 'usually_essential', 'hidden']) {
    if (change[k] !== undefined) next[k] = change[k];
  }
  type Rule = { shown?: boolean; required?: boolean; label?: string | null };
  const core: Record<string, Rule> = { ...((kind.core ?? {}) as Record<string, Rule>) };
  for (const [f, rule] of Object.entries((change.core ?? {}) as Record<string, Rule>)) {
    core[f] = { shown: true, required: false, label: null, ...core[f], ...rule };
  }
  next.core = core;
  if (core.expires?.shown !== undefined) {
    // One that expires requires its expiry (the 5.11 review).
    core.expires = { ...core.expires, required: core.expires.shown };
    next.expiry_driver = core.expires.shown ? (kind.expiry_driver ?? 'expires_on') : null;
  }
  if (core.issued_by?.label !== undefined) next.issued_by_label = core.issued_by.label;
  if (Array.isArray(change.fields)) {
    const had = (kind.fields ?? []) as Array<Record<string, unknown>>;
    next.fields = (change.fields as Array<{ key: string; required?: boolean }>).map((f) => {
      const was = had.find((x) => x.key === f.key);
      const lib = library.find((a) => a.key === f.key);
      return {
        key: f.key,
        label: was?.label ?? lib?.label ?? f.key,
        kind: was?.kind ?? lib?.kind ?? 'text',
        required: f.required ?? false,
      };
    });
  }
  // What it reminds from, worked out on the kind as it will be.
  const view = kind as unknown as DocumentTypeView;
  const fields = (next.fields ?? []) as Array<{ key: string; kind: string; required?: boolean }>;
  const out = nextReminder(
    {
      remind_from: change.remind_from as string | null | undefined,
      remind_leads: change.remind_leads as number[] | undefined,
      reminder_leads: change.reminder_leads as number[] | undefined,
      fields: change.fields as Array<{ key: string; required?: boolean }> | undefined,
    },
    made ? null : { reminding: reminderOf(view), expires: view.expiry_driver !== null },
    {
      expires: next.expiry_driver !== null,
      dates: fields.filter((f) => f.kind === 'date').map((f) => f.key),
    },
  );
  if ('problem' in out) return out;
  next.remind_from = out.from;
  next.remind_leads = out.leads;
  next.reminder_leads = out.from !== null && out.from !== 'expires' ? [] : out.leads;
  if (out.from !== null && out.from !== 'expires') {
    next.fields = fields.map((f) => (f.key === out.from ? { ...f, required: true } : f));
  }
  return { kind: next };
}

/** One issuer however it was written, as the server compares them. */
function sameIssuer(value: unknown, wanted: string): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === wanted.trim().toLowerCase();
}

/** Whatever role `signedIn()` last stored, defaulting to owner. */
function storedRole(): string {
  try {
    const raw = localStorage.getItem('fdv.session');
    return raw ? ((JSON.parse(raw) as { role?: string }).role ?? 'owner') : 'owner';
  } catch {
    return 'owner';
  }
}

export function signedIn(role: 'owner' | 'adult' | 'teen' | 'viewer' = 'owner') {
  localStorage.setItem(
    'fdv.session',
    JSON.stringify({
      refresh_token: 'hh.secret',
      household_id: 'hh',
      member_id: 'me',
      role,
    }),
  );
}
