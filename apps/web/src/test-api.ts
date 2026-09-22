import { vi } from 'vitest';

/**
 * An in-memory stand-in for the API, good enough to drive the screens.
 * Each test starts from `fresh()` and can tweak the state before rendering.
 */

export interface FakeState {
  setupRequired: boolean;
  displayName: string;
  members: Array<Record<string, unknown>>;
  documents: Array<Record<string, unknown>>;
  types: Array<Record<string, unknown>>;
  suggestions: Array<Record<string, unknown>>;
  /** Hits the second pass (FND-08) returns; matched on the snippet text. */
  sealed: Array<Record<string, unknown>>;
  lastQuery?: string;
  calls: Array<{ method: string; url: string; body?: unknown; headers?: Record<string, string> }>;
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
];

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
    displayName: 'The Seikh family',
    members: [ME],
    documents: [PASSPORT],
    types: TYPES,
    suggestions: [],
    sealed: [],
    calls: [],
    ...over,
  };
}

export function installFakeApi(state: FakeState) {
  const json = (body: unknown, status = 200) => Promise.resolve(Response.json(body, { status }));
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const path = url.split('?')[0] ?? url;
    const query = new URLSearchParams(url.split('?')[1] ?? '');
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    state.calls.push({ method, url, body, headers: init?.headers as Record<string, string> });

    if (path === '/api/v1/capabilities') {
      return json({
        product: 'family-document-vault',
        server_version: '0.1.5',
        api_version: 1,
        min_client_version: '0.0.1',
        edition: 'self_hosted',
        protection_mode: 'standard',
        setup_required: state.setupRequired,
        features: {},
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
    if (path === '/api/v1/auth/password') return json(TOKENS);
    if (path === '/api/v1/auth/refresh') return json(TOKENS);
    if (path === '/api/v1/me')
      return json({
        account_id: 'a',
        household_id: 'hh',
        member_id: 'me',
        role: 'owner',
        totp_enabled: true,
        totp_required: false,
      });
    if (path === '/api/v1/auth/sessions') return json({ items: [] });
    if (path === '/api/v1/exports') return json({ items: [] });
    if (path === '/api/v1/reminders') return json({ items: [] });
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
    if (path === '/api/v1/document-types') return json({ items: state.types });
    if (path === '/api/v1/documents/counts') {
      return json({
        by_member: [{ member_id: 'me', count: state.documents.length }],
        by_category: [{ category: 'identity', count: state.documents.length }],
      });
    }
    if (path === '/api/v1/documents' && method === 'GET') {
      let items = state.documents;
      const cat = query.get('category');
      if (cat) items = items.filter((d) => d.category === cat);
      return json({ items, next_cursor: null, has_more: false });
    }
    if (path === '/api/v1/capture') {
      const doc = {
        ...PASSPORT,
        id: 'doc-new',
        type_key: null,
        title: null,
        category: null,
        status: { value: 'needs_info', label: 'Needs a name' },
        etag: '"new"',
      };
      state.documents.push(doc);
      return json(
        { document_id: 'doc-new', version_id: 'v-new', job_id: null, state: 'stored' },
        201,
      );
    }
    const docMatch = /^\/api\/v1\/documents\/([^/]+)$/.exec(path);
    if (docMatch) {
      const doc = state.documents.find((d) => d.id === docMatch[1]);
      if (!doc)
        return json(
          { error: { code: 'not_found', message: 'That document is not in the vault.' } },
          404,
        );
      if (method === 'PATCH') {
        Object.assign(doc, body as object, { etag: '"next"' });
        return json(doc);
      }
      return json(doc);
    }
    if (/^\/api\/v1\/documents\/[^/]+\/versions$/.test(path)) {
      return json({
        items: [
          {
            id: 'v-1',
            document_id: 'doc-1',
            version_no: 1,
            filename: 'passport.pdf',
            mime: 'application/pdf',
            byte_size: 2048,
            sha256: 'x',
            page_count: 1,
            ocr_status: 'done',
            uploaded_at: '2026-09-20T09:14:00Z',
          },
        ],
      });
    }
    if (/^\/api\/v1\/versions\/[^/]+\/thumbnail$/.test(path))
      return json({ error: { code: 'no_thumbnail', message: 'No preview yet.' } }, 404);
    if (path === '/api/v1/search') {
      const q = query.get('q') ?? '';
      state.lastQuery = q;
      return json({
        items: q.includes('4471')
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
          : [],
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
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

export function signedIn() {
  localStorage.setItem(
    'fdv.session',
    JSON.stringify({
      refresh_token: 'hh.secret',
      household_id: 'hh',
      member_id: 'me',
      role: 'owner',
    }),
  );
}
