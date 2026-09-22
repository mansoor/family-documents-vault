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

export function fresh(over: Partial<FakeState> = {}): FakeState {
  return {
    setupRequired: false,
    displayName: 'The Seikh family',
    members: [ME],
    documents: [PASSPORT],
    types: TYPES,
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
        sealed_pending: { count: 0 },
      });
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
