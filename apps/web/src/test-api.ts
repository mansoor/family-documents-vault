import { vi } from 'vitest';

/**
 * An in-memory stand-in for the API, good enough to drive the screens.
 * Each test starts from `fresh()` and can tweak the state before rendering.
 */

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
  /** Set to require a PIN on the shared-document page. */
  sharePin: string | null;
  shareValid: boolean;
  documents: Array<Record<string, unknown>>;
  types: Array<Record<string, unknown>>;
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
  /** False when the link has expired, been used or been revoked. */
  invitationValid: boolean;
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
    displayName: 'The Seikh family',
    members: [ME],
    invitations: [],
    ownerChanges: [],
    shares: [],
    activity: [],
    privateNoticeShown: false,
    sharePin: null,
    shareValid: true,
    documents: [PASSPORT],
    types: TYPES,
    suggestions: [],
    sealed: [],
    passkeys: [],
    stepUpNeeded: false,
    invitationValid: true,
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
        features: { passkeys: true },
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
    // The real server decides the role from the session, not the client,
    // so refreshing must not hand back a role the test did not sign in as.
    if (path === '/api/v1/auth/refresh') return json({ ...TOKENS, role: storedRole() });
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
    if (path.startsWith('/api/v1/audit')) return json({ items: state.activity, next: null });
    if (path.endsWith('/visibility') && method === 'POST') {
      const to = (body as { visibility: string }).visibility;
      const doc = state.documents.find((d) => path.includes(String(d.id)));
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
          ...(b.with_pin ? { pin: '4821' } : {}),
        },
        201,
      );
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
      }
      return Promise.resolve(new Response(null, { status: 204 }));
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
        email: 'sam@example.test',
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
