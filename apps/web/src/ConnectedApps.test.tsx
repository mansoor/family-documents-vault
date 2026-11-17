import { appsNotPublicWords, type AppKeyView, type ConnectedAppView } from '@fdv/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { amountWords, todayWords } from './screens/ConnectedApps.js';
import {
  BANK_STATEMENT,
  fresh,
  installFakeApi,
  ME,
  signedIn,
  TYPES,
  type FakeState,
} from './test-api.js';

/**
 * Settings → Connected apps (0.9.0, APP1): the apps an owner connects, each
 * acting as an owner or an adult, said in words — whom it acts as, its
 * state, what it may do and send, its day against its caps, its keys — and
 * what can be done about each: connecting one (a passkey or a code, never
 * the password), turning one on as its person, pausing and turning back
 * on, changing it, its keys, and removing it, always asked first.
 */

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

const MB = 1024 * 1024;
const KEY = 'ed25519:' + 'A'.repeat(43);
const KEY_2 = 'ed25519:' + 'B'.repeat(43);

const AHMED = {
  ...ME,
  id: 'm-ahmed',
  display_name: 'Ahmed',
  role: 'adult',
  is_me: false,
};
const AISHA = { ...ME, id: 'm-aisha', display_name: 'Aisha', role: 'teen', is_me: false };

const key = (over: Partial<AppKeyView> = {}): AppKeyView => ({
  key_id: '00000000-0000-4000-8000-000000000001',
  fingerprint: 'b16c 2d1b 9e0f 4a77 c3d2 0011 8f6e 51a9',
  added_by: 'owner',
  created_at: '2026-11-01T09:00:00.000Z',
  first_used_at: '2026-11-01T09:05:00.000Z',
  retires_at: null,
  ...over,
});

const app = (over: Partial<ConnectedAppView> = {}): ConnectedAppView => ({
  id: '00000000-0000-4000-a000-000000000001',
  name: 'MonTra',
  member_id: 'm-ahmed',
  member_name: 'Ahmed',
  mine: false,
  created_at: '2026-11-01T09:00:00.000Z',
  state: 'active',
  paused_reason: null,
  scopes: ['documents.send'],
  allowed_kinds: ['passport'],
  default_visibility: null,
  auto_file: false,
  daily_files: 100,
  daily_bytes: 500 * MB,
  backfill: null,
  ip_allow: [],
  keys: [key()],
  last_used_at: '2026-11-15T09:00:00.000Z',
  today: { files: 12, bytes: 3 * MB },
  refused_today: 2,
  last_refusal: 'signature_invalid',
  counts: { waiting: 3, filed: 9 },
  connection_string: 'fdvapp1.c3RvcmVk',
  address: { url: 'https://vault.example.test', public: true },
  ...over,
});

/** Ahmed's, as an owner sees it; and the signed-in person's own. */
const AHMEDS = app();
const MINE = app({
  id: '00000000-0000-4000-a000-000000000002',
  name: 'Ledger',
  member_id: 'me',
  member_name: 'Mansoor Seikh',
  state: 'waiting_for_approval',
  allowed_kinds: [],
  refused_today: 0,
  last_refusal: null,
  last_used_at: null,
  today: { files: 0, bytes: 0 },
});

function at(
  path: string,
  over: Partial<FakeState>,
  role: 'owner' | 'adult' | 'teen' | 'viewer' = 'owner',
) {
  const state = fresh({ members: [ME, AHMED, AISHA], ...over });
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

const calls = (state: FakeState, method: string, part: string) =>
  state.calls.filter((c) => c.method === method && c.url.includes(part));

/** The passkey-or-code prompt: no password field; the code typed and confirmed. */
async function confirmWithCode() {
  const ask = await screen.findByRole('dialog', { name: 'Just checking it is you' });
  expect(within(ask).queryByLabelText(/password/i)).toBeNull();
  expect(within(ask).getByText(/Your password isn’t enough for this\./)).toBeInTheDocument();
  fireEvent.change(within(ask).getByLabelText('Code from your authenticator app'), {
    target: { value: '123456' },
  });
  fireEvent.click(within(ask).getByRole('button', { name: 'Confirm' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}

describe('the words', () => {
  it('says a day against its caps', () => {
    expect(amountWords(0)).toBe('0 MB');
    expect(amountWords(640 * 1024)).toBe('640 KB');
    expect(amountWords(3 * MB)).toBe('3 MB');
    expect(amountWords(5 * 1024 * MB)).toBe('5 GB');
    expect(todayWords(AHMEDS)).toBe('12 of 100 files today, 3 MB of 500 MB');
  });
});

describe('Settings → Connected apps (0.9.0, APP1)', () => {
  it('is a section for owners and adults while the vault has them; not for a teen, nor without', async () => {
    at('/settings', { connectedApps: [] }, 'owner');
    let nav = await screen.findByRole('navigation', { name: 'Settings sections' });
    expect(await within(nav).findByRole('link', { name: /Connected apps/ })).toHaveAttribute(
      'href',
      '/settings/connected-apps',
    );
    cleanup();
    at('/settings', { connectedApps: [] }, 'adult');
    nav = await screen.findByRole('navigation', { name: 'Settings sections' });
    expect(await within(nav).findByRole('link', { name: /Connected apps/ })).toBeInTheDocument();
    cleanup();
    at('/settings', { connectedApps: [] }, 'teen');
    nav = await screen.findByRole('navigation', { name: 'Settings sections' });
    await within(nav).findByRole('link', { name: /Your account/ });
    expect(within(nav).queryByRole('link', { name: /Connected apps/ })).toBeNull();
    cleanup();
    // A vault without them offers no section, even to an owner…
    at('/settings', {}, 'owner');
    nav = await screen.findByRole('navigation', { name: 'Settings sections' });
    await within(nav).findByRole('link', { name: /Your account/ });
    expect(within(nav).queryByRole('link', { name: /Connected apps/ })).toBeNull();
    cleanup();
    // …and its address, typed in, is not something they can open.
    at('/settings/connected-apps', {}, 'owner');
    expect(await screen.findByText('This isn’t something you can open.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect an app' })).toBeNull();
  });

  it('lists every app to an owner, in words: whom it acts as, its state, what it may do, its day and its keys', async () => {
    const state = at('/settings/connected-apps', {
      connectedApps: [
        app({
          backfill: {
            until: '2026-11-30T12:00:00.000Z',
            files_per_day: 400,
            bytes_per_day: 2 * 1024 * MB,
          },
          ip_allow: ['203.0.113.0/24'],
          keys: [
            key({ retires_at: '2026-11-23T12:00:00.000Z' }),
            key({
              key_id: '00000000-0000-4000-8000-000000000002',
              fingerprint: '77aa 0b1c 2d3e 4f50 6172 8394 a5b6 c7d8',
              added_by: 'app',
            }),
          ],
        }),
        MINE,
      ],
    });
    const card = await screen.findByRole('region', { name: 'MonTra' });
    expect(within(card).getByText('Acting as Ahmed')).toBeInTheDocument();
    expect(within(card).getByText('On')).toBeInTheDocument();
    expect(
      within(card).getByText('Send documents to the Inbox, and see what became of them'),
    ).toBeInTheDocument();
    expect(within(card).getByText('Passport')).toBeInTheDocument();
    expect(within(card).getByText('As each kind says')).toBeInTheDocument();
    expect(within(card).getByText('12 of 100 files today, 3 MB of 500 MB')).toBeInTheDocument();
    expect(within(card).getByText('2 requests; the last: signature not valid')).toBeInTheDocument();
    expect(within(card).getByText(/^Until 30 November: 400 files and 2 GB a day$/)).toBeVisible();
    expect(within(card).getByText('203.0.113.0/24')).toBeInTheDocument();
    // Its keys, by fingerprint; the older retiring by itself.
    expect(within(card).getByText('b16c 2d1b 9e0f 4a77 c3d2 0011 8f6e 51a9')).toBeInTheDocument();
    expect(within(card).getByText(/retires on 23 November/)).toBeInTheDocument();
    expect(within(card).getByText(/added by the app/)).toBeInTheDocument();
    // What it sent is Ahmed's alone to see.
    expect(within(card).queryByText('What it sent you')).toBeNull();
    // The owner's own: waiting for them, and its counts theirs.
    const mine = screen.getByRole('region', { name: 'Ledger' });
    expect(within(mine).getByText('Acting as you')).toBeInTheDocument();
    expect(within(mine).getByText('Waiting for you to turn it on')).toBeInTheDocument();
    expect(within(mine).getByText('None yet')).toBeInTheDocument();
    expect(within(mine).getByText('Not yet')).toBeInTheDocument();
    expect(within(mine).getByText('3 waiting in your Inbox, 9 filed')).toBeInTheDocument();
    expect(within(mine).getByRole('button', { name: 'Turn on Ledger' })).toBeInTheDocument();
    // The routes are published: no warning.
    expect(screen.queryByText(/FDV_PUBLIC_APPS/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Connect an app' })).toBeInTheDocument();
    expect(calls(state, 'GET', '/api/v1/connected-apps')).toHaveLength(1);
    await expectAccessible();
  });

  it('shows an adult only the apps acting as them, with what each sent; they turn one on and remove one', async () => {
    const state = at(
      '/settings/connected-apps',
      { connectedApps: [AHMEDS, MINE], stepUpNeeded: true },
      'adult',
    );
    const mine = await screen.findByRole('region', { name: 'Ledger' });
    expect(screen.queryByRole('region', { name: 'MonTra' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Connect an app' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Apps acting as you' })).toBeInTheDocument();
    expect(within(mine).getByText('3 waiting in your Inbox, 9 filed')).toBeInTheDocument();
    // An owner's actions are not theirs.
    for (const name of [/^Change/, /^Add a key/, /^Pause/]) {
      expect(within(mine).queryByRole('button', { name })).toBeNull();
    }
    await expectAccessible();

    // Turned on with a passkey or a code, never the password.
    fireEvent.click(within(mine).getByRole('button', { name: 'Turn on Ledger' }));
    await confirmWithCode();
    expect(
      await screen.findByText('Ledger is on. What it sends arrives in your Inbox.'),
    ).toBeInTheDocument();
    expect(calls(state, 'POST', '/approve')).toHaveLength(2);
    expect(await within(mine).findByText('On')).toBeInTheDocument();
    expect(within(mine).queryByRole('button', { name: 'Turn on Ledger' })).toBeNull();

    // Removed, asked first.
    fireEvent.click(within(mine).getByRole('button', { name: 'Remove Ledger' }));
    const ask = await screen.findByRole('alertdialog', { name: 'Remove Ledger?' });
    expect(within(ask).getByText(/What it sent stays in your Inbox/)).toBeInTheDocument();
    fireEvent.click(within(ask).getByRole('button', { name: 'Remove' }));
    expect(
      await screen.findByText('Ledger was removed. It can no longer send anything.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Ledger' })).toBeNull();
    expect(screen.getByText('No app acts as you.')).toBeInTheDocument();
    expect(calls(state, 'DELETE', '/api/v1/connected-apps/')).toHaveLength(1);
  });

  it('connects an app with a passkey or a code, then shows the key it kept and what to paste, with Copy', async () => {
    const copied = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: copied } });
    const state = at('/settings/connected-apps', { connectedApps: [], stepUpNeeded: true });
    expect(await screen.findByText('No app is connected.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Connect an app' }));
    const form = await screen.findByRole('region', { name: 'Connect an app' });
    await waitFor(() =>
      expect(within(form).getByRole('heading', { name: 'Connect an app' })).toHaveFocus(),
    );
    // Whom it may act as: owners and adults who sign in; never a teen.
    const who = within(form).getByLabelText('Acting as');
    expect(
      within(who)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Mansoor Seikh (you)', 'Ahmed · Adult']);
    expect(who).toHaveValue('me');
    // No kind ticked to start with.
    expect(within(form).getByLabelText('Passport')).not.toBeChecked();
    expect(within(form).getByLabelText('Birth certificate')).not.toBeChecked();
    await expectAccessible();

    fireEvent.change(within(form).getByLabelText(/^Name/), { target: { value: 'MonTra' } });
    fireEvent.change(who, { target: { value: 'm-ahmed' } });
    fireEvent.change(within(form).getByLabelText(/public key/), { target: { value: KEY } });
    fireEvent.click(within(form).getByLabelText('Passport'));
    fireEvent.change(within(form).getByLabelText('Who sees what it sends'), {
      target: { value: 'adults' },
    });
    fireEvent.change(within(form).getByLabelText('Files'), { target: { value: '50' } });
    fireEvent.change(within(form).getByLabelText('Addresses it may send from'), {
      target: { value: '203.0.113.7\n\n198.51.100.0/24' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Connect' }));
    await confirmWithCode();

    const made = await screen.findByRole('region', { name: 'MonTra is connected' });
    await waitFor(() =>
      expect(within(made).getByRole('heading', { name: 'MonTra is connected' })).toHaveFocus(),
    );
    expect(
      within(made).getByText(
        'It does nothing until Ahmed turns it on, in Settings → Connected apps.',
      ),
    ).toBeInTheDocument();
    expect(within(made).getByText(/^Check this matches what MonTra shows:/)).toBeInTheDocument();
    const sent = calls(state, 'POST', '/api/v1/connected-apps').at(-1)?.body;
    expect(sent).toEqual({
      name: 'MonTra',
      member_id: 'm-ahmed',
      public_key: KEY,
      allowed_kinds: ['passport'],
      default_visibility: 'adults',
      daily_files: 50,
      daily_bytes: 500 * MB,
      ip_allow: ['203.0.113.7', '198.51.100.0/24'],
      backfill: null,
      // Sending, and reading what it sent and is granted: downloading only when ticked.
      scopes: ['documents.send', 'documents.read'],
      // Its deletes let go, and 60 links an hour, unless an owner says (APP3).
      delete_mode: 'unlink',
      links_per_hour: 60,
    });
    const created = state.connectedApps?.[0];
    expect(within(made).getByText(created?.keys[0]?.fingerprint ?? '?')).toHaveTextContent(
      /^[0-9a-f]{4}( [0-9a-f]{4}){7}$/,
    );
    expect(within(made).getByText(created?.connection_string ?? '?')).toBeInTheDocument();
    expect(within(made).getByText('Paste this into MonTra. It holds no secret.')).toBeVisible();
    fireEvent.click(within(made).getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(copied).toHaveBeenCalledWith(created?.connection_string));
    expect(await within(made).findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    // And the list has it, waiting for Ahmed.
    const card = await screen.findByRole('region', { name: 'MonTra' });
    expect(within(card).getByText('Waiting for its person to turn it on')).toBeInTheDocument();
    await expectAccessible();
    fireEvent.click(within(made).getByRole('button', { name: 'Done' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'MonTra is connected' })).toBeNull(),
    );
  });

  it('says what is wrong before connecting: a name, and the key', async () => {
    const state = at('/settings/connected-apps', { connectedApps: [] });
    fireEvent.click(await screen.findByRole('button', { name: 'Connect an app' }));
    const form = await screen.findByRole('region', { name: 'Connect an app' });
    fireEvent.click(within(form).getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('Give the app a name.')).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText(/^Name/), { target: { value: 'MonTra' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('Paste the app’s public key.')).toBeInTheDocument();
    // A key that is not one: the vault's words.
    fireEvent.change(within(form).getByLabelText(/public key/), { target: { value: 'nope' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText(/^Paste the app’s public key: "ed25519:"/)).toBeInTheDocument();
    expect(state.connectedApps).toEqual([]);
  });

  it('an owner pauses an app, and turns it back on with a passkey or a code', async () => {
    const state = at('/settings/connected-apps', { connectedApps: [AHMEDS] });
    const card = await screen.findByRole('region', { name: 'MonTra' });
    fireEvent.click(within(card).getByRole('button', { name: 'Pause MonTra' }));
    expect(
      await screen.findByText(
        'MonTra is paused. What it sends is refused until it is turned back on.',
      ),
    ).toBeInTheDocument();
    expect(await within(card).findByText('Paused by an owner')).toBeInTheDocument();
    state.stepUpNeeded = true;
    fireEvent.click(within(card).getByRole('button', { name: 'Turn MonTra back on' }));
    await confirmWithCode();
    expect(await screen.findByText('MonTra is on again.')).toBeInTheDocument();
    expect(await within(card).findByText('On')).toBeInTheDocument();
    expect(calls(state, 'POST', '/pause')).toHaveLength(1);
    expect(calls(state, 'POST', '/resume')).toHaveLength(2);
  });

  it('says an app a restore paused is paused after the restore', async () => {
    at('/settings/connected-apps', {
      connectedApps: [app({ state: 'paused', paused_reason: 'restored' })],
    });
    const card = await screen.findByRole('region', { name: 'MonTra' });
    expect(within(card).getByText('Paused after the restore')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Turn MonTra back on' })).toBeInTheDocument();
  });

  it('an owner changes its kinds and caps: only what changed is sent, after a passkey or a code', async () => {
    const state = at('/settings/connected-apps', {
      connectedApps: [AHMEDS],
      stepUpNeeded: true,
    });
    const card = await screen.findByRole('region', { name: 'MonTra' });
    fireEvent.click(within(card).getByRole('button', { name: 'Change MonTra' }));
    expect(within(card).getByLabelText('Passport')).toBeChecked();
    expect(within(card).getByLabelText('Files')).toHaveValue('100');
    expect(within(card).getByLabelText('MB')).toHaveValue('500');
    await expectAccessible();
    fireEvent.click(within(card).getByLabelText('Birth certificate'));
    fireEvent.change(within(card).getByLabelText('Files'), { target: { value: '200' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    await confirmWithCode();
    expect(
      await screen.findByText('Saved. MonTra may do what it now says here.'),
    ).toBeInTheDocument();
    expect(calls(state, 'PATCH', '/api/v1/connected-apps/').at(-1)?.body).toEqual({
      allowed_kinds: ['passport', 'birth_certificate'],
      daily_files: 200,
    });
    expect(await within(card).findByText('Passport, Birth certificate')).toBeInTheDocument();
    expect(within(card).getByText('12 of 200 files today, 3 MB of 500 MB')).toBeInTheDocument();

    // A new name alone asks for nothing.
    state.stepUpNeeded = true;
    fireEvent.click(within(card).getByRole('button', { name: 'Change MonTra' }));
    fireEvent.change(within(card).getByLabelText(/^Name/), { target: { value: 'MonTra Pro' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('region', { name: 'MonTra Pro' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls(state, 'PATCH', '/api/v1/connected-apps/').at(-1)?.body).toEqual({
      name: 'MonTra Pro',
    });
  });

  it('an owner lets it show and delete: what a delete does, and links an hour, after a passkey or a code (APP3)', async () => {
    const state = at('/settings/connected-apps', {
      connectedApps: [AHMEDS],
      stepUpNeeded: true,
    });
    const card = await screen.findByRole('region', { name: 'MonTra' });
    fireEvent.click(within(card).getByRole('button', { name: 'Change MonTra' }));
    const mode = within(card).getByLabelText('When it deletes a document it sent');
    expect(mode).toHaveValue('unlink');
    expect(mode).toHaveAccessibleDescription(/Only me papers/);
    expect(within(card).getByLabelText(/^Documents it may show its user/)).toHaveValue('60');
    await expectAccessible();
    fireEvent.click(
      within(card).getByLabelText(
        'Show its user documents it may read, for 10 minutes (with reading)',
      ),
    );
    fireEvent.click(
      within(card).getByLabelText('Delete the documents it sent, as you choose below'),
    );
    fireEvent.change(mode, { target: { value: 'trash' } });
    fireEvent.change(within(card).getByLabelText(/^Documents it may show its user/), {
      target: { value: '601' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    expect(await within(card).findByText('Links an hour: 1 to 600.')).toBeInTheDocument();
    fireEvent.change(within(card).getByLabelText(/^Documents it may show its user/), {
      target: { value: '20' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    await confirmWithCode();
    expect(
      await screen.findByText('Saved. MonTra may do what it now says here.'),
    ).toBeInTheDocument();
    expect(calls(state, 'PATCH', '/api/v1/connected-apps/').at(-1)?.body).toEqual({
      scopes: ['documents.send', 'documents.links', 'documents.delete'],
      delete_mode: 'trash',
      links_per_hour: 20,
    });
    expect(
      await within(card).findByText(
        'It moves it to the Trash, where it can be restored for 30 days.',
      ),
    ).toBeInTheDocument();
    expect(within(card).getByText('0 of 20 this hour; 0 opened this week')).toBeInTheDocument();
  });

  it('an owner says what it may read: a kind or a category and how far back, Sensitive asked once (APP2)', async () => {
    const BILLS = {
      key: 'utility_bill',
      label: 'Utility / bill',
      category: 'bills',
      fields: [],
      expiry_driver: null,
      reminder_leads: [],
      usually_essential: false,
      default_visibility: 'household',
      issued_by_label: null,
    };
    const state = at('/settings/connected-apps', {
      connectedApps: [
        app({
          scopes: ['documents.send', 'documents.read', 'documents.download'],
          grants: [],
          daily_read_bytes: 1024 ** 3,
          read_today: 0,
        }),
      ],
      types: [
        ...TYPES,
        ...(TYPES.some((t) => t.key === 'bank_statement') ? [] : [BANK_STATEMENT]),
        BILLS,
      ],
      stepUpNeeded: true,
    });
    const card = await screen.findByRole('region', { name: 'MonTra' });
    expect(within(card).getByText('What it sent')).toBeInTheDocument();
    expect(within(card).getByText('0 MB of 1 GB')).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Change what MonTra may read' }));
    expect(within(card).getByText('Nothing beyond what it sent.')).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Add a kind or category' }));
    const what = within(card).getByLabelText('What');
    const offered = within(what)
      .getAllByRole('option')
      .map((o) => o.textContent);
    // Only what an app may ever be given: never identity papers, a passport among them.
    expect(offered).toContain('Bank / investment statement');
    expect(offered).toContain('All of Bills & utilities');
    expect(offered).not.toContain('Passport');
    expect(offered).not.toContain('All of Identity');
    expect(offered).not.toContain('All of Medical');
    fireEvent.change(what, { target: { value: 'kind:bank_statement' } });
    fireEvent.change(within(card).getByLabelText('Months back'), { target: { value: '12' } });
    await expectAccessible();
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    await confirmWithCode();
    // The vault asks about Sensitive papers; the owner allows it.
    let ask = await screen.findByRole('alertdialog', { name: 'Sensitive papers' });
    expect(
      within(ask).getByText(
        'Bank / investment statement is sensitive. MonTra will be able to read it. Allow anyway?',
      ),
    ).toBeInTheDocument();
    // Cancel keeps what the owner chose, open, with the focus back on Save.
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(within(card).getByLabelText('What')).toHaveValue('kind:bank_statement');
    expect(within(card).getByLabelText('Months back')).toHaveValue('12');
    await waitFor(() => expect(within(card).getByRole('button', { name: 'Save' })).toHaveFocus());
    // Asked again, and allowed: saved, closed, the focus on its card's "What it may read".
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    ask = await screen.findByRole('alertdialog', { name: 'Sensitive papers' });
    fireEvent.click(within(ask).getByRole('button', { name: 'Allow' }));
    expect(
      await screen.findByText('Saved. MonTra may read what it now says here.'),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(card).getByRole('button', { name: 'Change what MonTra may read' }),
      ).toHaveFocus(),
    );
    const sent = calls(state, 'PUT', '/grants').map((c) => c.body);
    expect(sent.at(-1)).toEqual({
      grants: [{ kind: 'bank_statement', lookback_months: 12 }],
      confirm_sensitive: true,
    });
    expect(
      await within(card).findByText(
        'What it sent, and: Bank / investment statement: the last 12 months, sensitive papers included',
      ),
    ).toBeInTheDocument();
    // How far back is said in months, 1 to 36.
    fireEvent.click(within(card).getByRole('button', { name: 'Change what MonTra may read' }));
    fireEvent.change(within(card).getByLabelText('Months back'), { target: { value: '48' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    expect(await within(card).findByText('How far back: 1 to 36 months.')).toBeInTheDocument();
  });

  it('an owner adds its new key, sees what to paste, and retires the old one, asked first', async () => {
    const state = at('/settings/connected-apps', {
      connectedApps: [AHMEDS],
      stepUpNeeded: true,
    });
    const card = await screen.findByRole('region', { name: 'MonTra' });
    // Its only key cannot be retired.
    expect(within(card).queryByRole('button', { name: /^Retire the key/ })).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Add a key to MonTra' }));
    fireEvent.change(within(card).getByLabelText('MonTra’s new public key'), {
      target: { value: KEY_2 },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Add the key' }));
    await confirmWithCode();
    const made = await screen.findByRole('region', { name: 'MonTra’s new key' });
    const added = state.connectedApps?.[0]?.keys[1];
    expect(within(made).getByText(added?.fingerprint ?? '?')).toBeInTheDocument();
    expect(
      within(made).getByText(state.connectedApps?.[0]?.connection_string ?? '?'),
    ).toBeInTheDocument();
    expect(calls(state, 'POST', '/keys').at(-1)?.body).toEqual({ public_key: KEY_2 });
    // Two keys: no more can be added, and either can be retired.
    expect(await within(card).findByRole('button', { name: 'Add a key to MonTra' })).toBeDisabled();
    fireEvent.click(
      within(card).getByRole('button', {
        name: 'Retire the key b16c 2d1b 9e0f 4a77 c3d2 0011 8f6e 51a9',
      }),
    );
    const ask = await screen.findByRole('alertdialog', { name: 'Retire this key?' });
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(state.connectedApps?.[0]?.keys).toHaveLength(2);
    fireEvent.click(
      within(card).getByRole('button', {
        name: 'Retire the key b16c 2d1b 9e0f 4a77 c3d2 0011 8f6e 51a9',
      }),
    );
    fireEvent.click(
      within(await screen.findByRole('alertdialog', { name: 'Retire this key?' })).getByRole(
        'button',
        { name: 'Retire' },
      ),
    );
    expect(
      await screen.findByText('The key b16c 2d1b 9e0f 4a77 c3d2 0011 8f6e 51a9 was retired.'),
    ).toBeInTheDocument();
    expect(state.connectedApps?.[0]?.keys.map((k) => k.fingerprint)).toEqual([added?.fingerprint]);
    await waitFor(() =>
      expect(within(card).queryByText('b16c 2d1b 9e0f 4a77 c3d2 0011 8f6e 51a9')).toBeNull(),
    );
  });

  it('shows a key the app added as not confirmed, and an owner confirms it with a code (APP1 review)', async () => {
    const state = at('/settings/connected-apps', {
      connectedApps: [
        app({
          keys: [
            key(),
            key({
              key_id: '00000000-0000-4000-8000-000000000002',
              fingerprint: '77aa 1b2c 3d4e 5f60 7182 93a4 b5c6 d7e8',
              added_by: 'app',
              pending: true,
              first_used_at: null,
            }),
          ],
        }),
      ],
      stepUpNeeded: true,
    });
    const card = await screen.findByRole('region', { name: 'MonTra' });
    expect(
      within(card).getByText(/Not confirmed: it signs nothing until it is\./),
    ).toBeInTheDocument();
    fireEvent.click(
      within(card).getByRole('button', {
        name: 'Confirm the key 77aa 1b2c 3d4e 5f60 7182 93a4 b5c6 d7e8',
      }),
    );
    await confirmWithCode();
    // Confirmed by an owner for Ahmed's app: Ahmed turns it on again.
    expect(
      await screen.findByText('The key is confirmed. MonTra waits for Ahmed to turn it on again.'),
    ).toBeInTheDocument();
    expect(state.connectedApps?.[0]?.keys[1]?.pending).toBe(false);
    expect(calls(state, 'POST', '/confirm').length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(within(card).queryByText(/Not confirmed: it signs nothing/)).toBeNull(),
    );
  });

  it('an owner removes an app, asked first: Cancel leaves it', async () => {
    const state = at('/settings/connected-apps', { connectedApps: [AHMEDS] });
    const card = await screen.findByRole('region', { name: 'MonTra' });
    fireEvent.click(within(card).getByRole('button', { name: 'Remove MonTra' }));
    let ask = await screen.findByRole('alertdialog', { name: 'Remove MonTra?' });
    expect(within(ask).getByText(/What it sent stays in Ahmed’s Inbox/)).toBeInTheDocument();
    await expectAccessible();
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(state.connectedApps).toHaveLength(1);
    fireEvent.click(within(card).getByRole('button', { name: 'Remove MonTra' }));
    ask = await screen.findByRole('alertdialog', { name: 'Remove MonTra?' });
    fireEvent.click(within(ask).getByRole('button', { name: 'Remove' }));
    expect(
      await screen.findByText('MonTra was removed. It can no longer send anything.'),
    ).toBeInTheDocument();
    expect(state.connectedApps).toEqual([]);
    expect(await screen.findByText('No app is connected.')).toBeInTheDocument();
  });

  it('warns while the app routes are not on the public address', async () => {
    at('/settings/connected-apps', { connectedApps: [AHMEDS], appsPublic: false });
    expect(await screen.findByText(appsNotPublicWords('MonTra'))).toBeInTheDocument();
    cleanup();
    // With no app, nothing to warn about.
    at('/settings/connected-apps', { connectedApps: [], appsPublic: false });
    await screen.findByText('No app is connected.');
    expect(screen.queryByText(/FDV_PUBLIC_APPS/)).toBeNull();
  });
});
