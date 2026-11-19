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

/**
 * The household's kinds, as the grouped list sees them (APP7): two
 * financial ones and an Essential among them, two bills, an identity and a
 * legal kind (never offered), and a category of an Essential alone (not
 * shown).
 */
const KINDS = [
  ...TYPES,
  {
    ...BANK_STATEMENT,
    key: 'credit_card_statement',
    label: 'Credit card statement',
  },
  { ...BANK_STATEMENT, key: 'pension', label: 'Pension', usually_essential: true },
  { ...BANK_STATEMENT, key: 'utility_bill', label: 'Utility bill', category: 'bills' },
  { ...BANK_STATEMENT, key: 'council_tax', label: 'Council tax', category: 'bills' },
  { ...BANK_STATEMENT, key: 'will', label: 'Will', category: 'legal' },
  {
    ...BANK_STATEMENT,
    key: 'deeds',
    label: 'Property deeds',
    category: 'property',
    usually_essential: true,
  },
];

const AHMED = {
  ...ME,
  id: 'm-ahmed',
  display_name: 'Ahmed',
  role: 'adult',
  is_me: false,
};
const AISHA = { ...ME, id: 'm-aisha', display_name: 'Aisha', role: 'teen', is_me: false };

const key = (over: Partial<AppKeyView> = {}): AppKeyView => ({
  id: 'k-1',
  client_id: 'fdvc_AAAAAAAAAAAAAAAAAAAAAA',
  name: null,
  permissions: ['documents.send'],
  created_at: '2026-11-01T09:00:00.000Z',
  expires_at: null,
  last_used_at: '2026-11-01T09:05:00.000Z',
  revoked_at: null,
  state: 'live',
  ...over,
});

const app = (over: Partial<ConnectedAppView> = {}): ConnectedAppView => ({
  id: '00000000-0000-4000-a000-000000000001',
  name: 'Acme Money',
  acts_as: 'person',
  member_id: 'm-ahmed',
  member_name: 'Ahmed',
  reviewer_member_id: null,
  reviewer_name: null,
  reviewer_needed: false,
  mine: false,
  created_at: '2026-11-01T09:00:00.000Z',
  state: 'active',
  paused_reason: null,
  scopes: ['documents.send'],
  allowed_kinds: ['passport'],
  default_visibility: null,
  auto_file: false,
  route_to_person: false,
  daily_files: 100,
  daily_bytes: 500 * MB,
  backfill: null,
  ip_allow: [],
  keys: [key()],
  last_used_at: '2026-11-15T09:00:00.000Z',
  today: { files: 12, bytes: 3 * MB },
  refused_today: 2,
  last_refusal: 'app_key_expired',
  counts: { waiting: 3, filed: 9 },
  connection_string: 'fdvapp2.c3RvcmVk',
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
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Just checking it is you' })).toBeNull(),
  );
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
            auto_file: true,
          },
          ip_allow: ['203.0.113.0/24'],
          keys: [
            key({ name: 'Live', expires_at: '2027-11-01T09:00:00.000Z' }),
            key({
              id: 'k-2',
              client_id: 'fdvc_BBBBBBBBBBBBBBBBBBBBBB',
              permissions: ['documents.send', 'documents.read'],
              last_used_at: null,
            }),
          ],
        }),
        MINE,
      ],
    });
    const card = await screen.findByRole('region', { name: 'Acme Money' });
    expect(within(card).getByText('Acting as Ahmed')).toBeInTheDocument();
    expect(within(card).getByText('On')).toBeInTheDocument();
    expect(
      within(card).getByText('Send documents to the Inbox, and see what became of them'),
    ).toBeInTheDocument();
    expect(within(card).getByText('Passport')).toBeInTheDocument();
    expect(within(card).getByText('As each kind says')).toBeInTheDocument();
    expect(within(card).getByText('12 of 100 files today, 3 MB of 500 MB')).toBeInTheDocument();
    expect(within(card).getByText('2 requests; the last: API key expired')).toBeInTheDocument();
    expect(within(card).getByText(/^Until 30 November: 400 files and 2 GB a day$/)).toBeVisible();
    // Filing what is sure by itself, for the older papers' window alone (APP4).
    expect(
      within(card).getByText(
        'Files what is sure and complete until 30 November; the rest waits for a look',
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Ledger' })).getByText(
        'Everything waits for a look',
      ),
    ).toBeInTheDocument();
    expect(within(card).getByText('203.0.113.0/24')).toBeInTheDocument();
    // Its API keys: name, client ID, permissions, days and use; never a secret.
    const keys = within(card).getByRole('list', { name: 'API keys' });
    expect(within(keys).getByText('Live')).toBeInTheDocument();
    expect(within(keys).getByText('Unnamed key')).toBeInTheDocument();
    expect(within(keys).getByText('fdvc_AAAAAAAAAAAAAAAAAAAAAA')).toBeInTheDocument();
    expect(within(keys).getByText('Send, Read')).toBeInTheDocument();
    expect(within(keys).getByText('1 November 2027')).toBeInTheDocument();
    expect(within(keys).getByText('Never')).toBeInTheDocument();
    expect(within(keys).getByText('Never used')).toBeInTheDocument();
    expect(within(keys).getByRole('button', { name: 'Revoke the key Live' })).toBeInTheDocument();
    // Two work: no third.
    expect(
      within(card).getByRole('button', { name: 'Generate an API key for Acme Money' }),
    ).toBeDisabled();
    // What it sent: every owner sees the app's totals (0.9.0-dev.68),
    // whoever's Inbox — counts alone.
    expect(within(card).queryByText('What it sent you')).toBeNull();
    expect(within(card).getByText('What it sent the family')).toBeInTheDocument();
    expect(
      within(card).getByText('3 waiting in the family’s Inboxes, 9 filed'),
    ).toBeInTheDocument();
    // The owner's own: waiting for them, and its counts the app's totals too.
    const mine = screen.getByRole('region', { name: 'Ledger' });
    expect(within(mine).getByText('Acting as you')).toBeInTheDocument();
    expect(within(mine).getByText('Waiting for you to turn it on')).toBeInTheDocument();
    expect(within(mine).getByText('None yet')).toBeInTheDocument();
    expect(within(mine).getByText('Not yet')).toBeInTheDocument();
    expect(
      within(mine).getByText('3 waiting in the family’s Inboxes, 9 filed'),
    ).toBeInTheDocument();
    expect(within(mine).getByRole('button', { name: 'Turn on Ledger' })).toBeInTheDocument();
    // The routes are published: no warning.
    expect(screen.queryByText(/FDV_PUBLIC_APPS/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Connect an app' })).toBeInTheDocument();
    expect(calls(state, 'GET', '/api/v1/connected-apps')).toHaveLength(1);
    await expectAccessible();
  });

  it('shows an adult only the apps acting as them, with what each sent and its keys; they turn one on and remove one', async () => {
    const state = at(
      '/settings/connected-apps',
      { connectedApps: [AHMEDS, MINE], stepUpNeeded: true },
      'adult',
    );
    const mine = await screen.findByRole('region', { name: 'Ledger' });
    expect(screen.queryByRole('region', { name: 'Acme Money' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Connect an app' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Apps acting as you' })).toBeInTheDocument();
    expect(within(mine).getByText('3 waiting in your Inbox, 9 filed')).toBeInTheDocument();
    // Its keys, to see; an owner's actions are not theirs.
    expect(
      within(within(mine).getByRole('list', { name: 'API keys' })).getByText(
        'fdvc_AAAAAAAAAAAAAAAAAAAAAA',
      ),
    ).toBeInTheDocument();
    for (const name of [/^Change/, /^Generate/, /^Pause/, /^Revoke/]) {
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

  it('connects an app with a passkey or a code, then opens its Generate key form', async () => {
    const state = at('/settings/connected-apps', { connectedApps: [], stepUpNeeded: true });
    expect(await screen.findByText('No app is connected.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Connect an app' }));
    const form = await screen.findByRole('region', { name: 'Connect an app' });
    await waitFor(() =>
      expect(within(form).getByRole('heading', { name: 'Connect an app' })).toHaveFocus(),
    );
    // Whom it may act as: itself (APP8), or owners and adults who sign in; never a teen.
    const who = within(form).getByLabelText('It acts as');
    expect(
      within(who)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Itself (the app)', 'Mansoor Seikh (you)', 'Ahmed · Adult']);
    expect(who).toHaveValue('app');
    expect(within(form).getByLabelText('Reviewed by')).toHaveValue('me');
    // No kind ticked to start with; identity papers never offered (APP7).
    expect(within(form).getByLabelText('Bank / investment statement')).not.toBeChecked();
    expect(within(form).queryByLabelText('Passport')).toBeNull();
    expect(within(form).queryByLabelText('Birth certificate')).toBeNull();
    await expectAccessible();

    fireEvent.change(within(form).getByLabelText(/^Name/), { target: { value: 'Acme Money' } });
    fireEvent.change(who, { target: { value: 'person:m-ahmed' } });
    // Acting as a person: they review what it sends, so nobody else is asked.
    expect(within(form).queryByLabelText('Reviewed by')).toBeNull();
    // No key to paste: the vault generates one.
    expect(within(form).queryByLabelText(/public key/)).toBeNull();
    fireEvent.click(within(form).getByLabelText('Bank / investment statement'));
    fireEvent.change(within(form).getByLabelText('Who sees what it sends'), {
      target: { value: 'adults' },
    });
    fireEvent.change(within(form).getByLabelText('Files'), { target: { value: '50' } });
    fireEvent.change(within(form).getByLabelText('Addresses it may send from'), {
      target: { value: '203.0.113.7\n\n198.51.100.0/24, feeds.example.com' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Connect' }));
    await confirmWithCode();

    // Its Generate key form, open at once, its heading in focus.
    const card = await screen.findByRole('region', { name: 'Acme Money' });
    const keyForm = await within(card).findByRole('form', {
      name: 'Generate an API key for Acme Money',
    });
    await waitFor(() =>
      expect(
        within(keyForm).getByRole('heading', { name: 'Generate an API key for Acme Money' }),
      ).toHaveFocus(),
    );
    expect(
      within(keyForm).getByText(
        'Acme Money is connected. It does nothing until Ahmed turns it on, in Settings → Connected apps. Generate its key now, to paste into the app.',
      ),
    ).toBeInTheDocument();
    const sent = calls(state, 'POST', '/api/v1/connected-apps').at(-1)?.body;
    expect(sent).toEqual({
      name: 'Acme Money',
      acts_as: 'person',
      member_id: 'm-ahmed',
      allowed_kinds: ['bank_statement'],
      default_visibility: 'adults',
      daily_files: 50,
      daily_bytes: 500 * MB,
      ip_allow: ['203.0.113.7', '198.51.100.0/24', 'feeds.example.com'],
      backfill: null,
      // Everything it sends waits for a look, unless an owner says (APP4).
      auto_file: false,
      // Each paper to the Inbox of the person it is about, unless an owner says (APP5).
      route_to_person: true,
      // Sending, and reading what it sent and is granted: downloading only when ticked.
      scopes: ['documents.send', 'documents.read'],
      // Its deletes let go, and 60 links an hour, unless an owner says (APP3).
      delete_mode: 'unlink',
      links_per_hour: 60,
    });
    // The list has it, waiting for Ahmed, with no key yet.
    expect(within(card).getByText('Waiting for its person to turn it on')).toBeInTheDocument();
    expect(state.connectedApps?.[0]?.keys).toEqual([]);
    await expectAccessible();
    // Cancelled: the form goes, and Generate key is there for later.
    fireEvent.click(within(keyForm).getByRole('button', { name: 'Cancel' }));
    expect(
      await within(card).findByRole('button', { name: 'Generate an API key for Acme Money' }),
    ).toBeEnabled();
  });

  it('groups the kinds it may send by category: a category ticks all its kinds, some of them are mixed (APP7)', async () => {
    const state = at('/settings/connected-apps', { connectedApps: [], types: KINDS });
    fireEvent.click(await screen.findByRole('button', { name: 'Connect an app' }));
    const form = await screen.findByRole('region', { name: 'Connect an app' });
    const kinds = within(form).getByRole('group', { name: 'Kinds it may send' });
    // A box for each category it may be given kinds of, in the categories'
    // order; never identity or legal, nor one of an Essential alone.
    const categories = within(kinds)
      .getAllByRole('checkbox', { name: /^All of / })
      .map((b) => b.getAttribute('id'));
    expect(
      categories.map((id) => document.querySelector(`label[for="${id}"]`)?.textContent),
    ).toEqual(['All of Financial', 'All of Bills & utilities']);
    for (const never of ['Passport', 'Will', 'Property deeds', /All of Identity/, /All of Legal/]) {
      expect(within(kinds).queryByLabelText(never)).toBeNull();
    }
    // Each category's kinds sit beneath it, in a group of their own.
    const financial = within(kinds).getByRole('group', { name: 'Financial' });
    expect(
      within(financial)
        .getAllByRole('checkbox')
        .map((b) => document.querySelector(`label[for="${b.id}"]`)?.textContent),
    ).toEqual(['Bank / investment statement', 'Credit card statement', 'Pension']);
    // An Essential shows, not to be ticked, saying why.
    const pension = within(financial).getByLabelText('Pension');
    expect(pension).toBeDisabled();
    expect(pension).toHaveAccessibleDescription('An Essential: never an app’s to send');

    const all = within(kinds).getByRole<HTMLInputElement>('checkbox', {
      name: 'All of Financial',
    });
    const bank = within(financial).getByLabelText('Bank / investment statement');
    const card = within(financial).getByLabelText('Credit card statement');
    /** The category's state: ticked, mixed (indeterminate) or not. */
    const stateOf = () => (all.indeterminate ? 'mixed' : all.checked ? 'all' : 'none');
    expect(stateOf()).toBe('none');
    // A native box: its mixed state is `indeterminate`, never an aria-checked of its own.
    expect(all).not.toHaveAttribute('aria-checked');
    expect(all.getAttribute('aria-controls')?.split(' ')).toContain(bank.id);

    // Ticking the category ticks all its kinds (never the Essential).
    fireEvent.click(all);
    expect(bank).toBeChecked();
    expect(card).toBeChecked();
    expect(pension).not.toBeChecked();
    expect(stateOf()).toBe('all');
    // One of them unticked: the category is mixed.
    fireEvent.click(card);
    expect(all).not.toBeChecked();
    expect(all.indeterminate).toBe(true);
    expect(stateOf()).toBe('mixed');
    await expectAccessible();
    // Ticked from mixed: all of them again; unticked: none.
    fireEvent.click(all);
    expect(card).toBeChecked();
    expect(stateOf()).toBe('all');
    fireEvent.click(all);
    expect(bank).not.toBeChecked();
    expect(card).not.toBeChecked();
    expect(stateOf()).toBe('none');
    // The kinds one by one: all of them ticks the category.
    fireEvent.click(bank);
    expect(stateOf()).toBe('mixed');
    fireEvent.click(card);
    expect(stateOf()).toBe('all');
    fireEvent.click(card);

    // What is sent is the flat list of kinds, as before.
    fireEvent.click(within(kinds).getByRole('checkbox', { name: 'All of Bills & utilities' }));
    fireEvent.change(within(form).getByLabelText(/^Name/), { target: { value: 'Acme Money' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Connect' }));
    await screen.findByRole('region', { name: 'Acme Money' });
    expect(calls(state, 'POST', '/api/v1/connected-apps').at(-1)?.body).toMatchObject({
      allowed_kinds: ['bank_statement', 'utility_bill', 'council_tax'],
    });
  });

  it('an allowed kind the vault would now refuse is named, then dropped from a change, never sent again (APP7)', async () => {
    const state = at('/settings/connected-apps', {
      connectedApps: [
        app({ allowed_kinds: ['bank_statement', 'passport', 'pension', 'gone_kind'] }),
      ],
      types: KINDS,
    });
    const card = await screen.findByRole('region', { name: 'Acme Money' });
    fireEvent.click(within(card).getByRole('button', { name: 'Change Acme Money' }));
    // The Essential shows unticked and not to be ticked; the identity kind not at all.
    expect(within(card).getByLabelText('Pension')).not.toBeChecked();
    expect(within(card).getByLabelText('Pension')).toBeDisabled();
    expect(within(card).queryByLabelText('Passport')).toBeNull();
    // What it will no longer send is said by name, and when.
    expect(
      within(card).getByText(
        'Will no longer send, once its kinds change: Passport, Pension, gone_kind',
      ),
    ).toBeInTheDocument();
    fireEvent.click(within(card).getByLabelText('Utility bill'));
    expect(
      within(card).getByText('Will no longer send: Passport, Pension, gone_kind'),
    ).toBeInTheDocument();
    await expectAccessible();
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('Saved. Acme Money may do what it now says here.'),
    ).toBeInTheDocument();
    expect(calls(state, 'PATCH', '/api/v1/connected-apps/').at(-1)?.body).toEqual({
      allowed_kinds: ['bank_statement', 'utility_bill'],
    });
  });

  it('takes names among the addresses it may send from, saying how a name is checked; five at most (APP7)', async () => {
    const state = at('/settings/connected-apps', { connectedApps: [] });
    fireEvent.click(await screen.findByRole('button', { name: 'Connect an app' }));
    const form = await screen.findByRole('region', { name: 'Connect an app' });
    const field = within(form).getByLabelText('Addresses it may send from');
    expect(field).toHaveAccessibleDescription(
      /a name \(feeds\.example\.com, up to 5\)\. Left empty, any address\. A name is checked against the addresses it points to now\. Apps on large cloud platforms may call from addresses their name doesn’t list; use their published address ranges instead\.$/,
    );
    fireEvent.change(within(form).getByLabelText(/^Name/), { target: { value: 'Acme Money' } });
    fireEvent.change(field, {
      target: { value: ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => `${n}.example.com`).join('\n') },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('5 names at most.')).toBeInTheDocument();
    expect(calls(state, 'POST', '/api/v1/connected-apps')).toHaveLength(0);
  });

  it('says what is wrong before connecting: a name', async () => {
    const state = at('/settings/connected-apps', { connectedApps: [] });
    fireEvent.click(await screen.findByRole('button', { name: 'Connect an app' }));
    const form = await screen.findByRole('region', { name: 'Connect an app' });
    fireEvent.click(within(form).getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('Give the app a name.')).toBeInTheDocument();
    expect(state.connectedApps).toEqual([]);
  });

  it('an owner pauses an app, and turns it back on with a passkey or a code', async () => {
    const state = at('/settings/connected-apps', { connectedApps: [AHMEDS] });
    const card = await screen.findByRole('region', { name: 'Acme Money' });
    fireEvent.click(within(card).getByRole('button', { name: 'Pause Acme Money' }));
    expect(
      await screen.findByText(
        'Acme Money is paused. What it sends is refused until it is turned back on.',
      ),
    ).toBeInTheDocument();
    expect(await within(card).findByText('Paused by an owner')).toBeInTheDocument();
    state.stepUpNeeded = true;
    fireEvent.click(within(card).getByRole('button', { name: 'Turn Acme Money back on' }));
    await confirmWithCode();
    expect(await screen.findByText('Acme Money is on again.')).toBeInTheDocument();
    expect(await within(card).findByText('On')).toBeInTheDocument();
    expect(calls(state, 'POST', '/pause')).toHaveLength(1);
    expect(calls(state, 'POST', '/resume')).toHaveLength(2);
  });

  it('says an app a restore paused is paused after the restore', async () => {
    at('/settings/connected-apps', {
      connectedApps: [app({ state: 'paused', paused_reason: 'restored' })],
    });
    const card = await screen.findByRole('region', { name: 'Acme Money' });
    expect(within(card).getByText('Paused after the restore')).toBeInTheDocument();
    expect(
      within(card).getByRole('button', { name: 'Turn Acme Money back on' }),
    ).toBeInTheDocument();
  });

  it('an owner changes its kinds and caps: only what changed is sent, after a passkey or a code', async () => {
    const state = at('/settings/connected-apps', {
      connectedApps: [app({ allowed_kinds: ['bank_statement'] })],
      stepUpNeeded: true,
      types: KINDS,
    });
    const card = await screen.findByRole('region', { name: 'Acme Money' });
    fireEvent.click(within(card).getByRole('button', { name: 'Change Acme Money' }));
    expect(within(card).getByLabelText('Bank / investment statement')).toBeChecked();
    expect(within(card).getByLabelText('Files')).toHaveValue('100');
    expect(within(card).getByLabelText('MB')).toHaveValue('500');
    await expectAccessible();
    fireEvent.click(within(card).getByLabelText('Utility bill'));
    fireEvent.change(within(card).getByLabelText('Files'), { target: { value: '200' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    await confirmWithCode();
    expect(
      await screen.findByText('Saved. Acme Money may do what it now says here.'),
    ).toBeInTheDocument();
    expect(calls(state, 'PATCH', '/api/v1/connected-apps/').at(-1)?.body).toEqual({
      allowed_kinds: ['bank_statement', 'utility_bill'],
      daily_files: 200,
    });
    expect(
      await within(card).findByText('Bank / investment statement, Utility bill'),
    ).toBeInTheDocument();
    expect(within(card).getByText('12 of 200 files today, 3 MB of 500 MB')).toBeInTheDocument();

    // A new name alone asks for nothing.
    state.stepUpNeeded = true;
    fireEvent.click(within(card).getByRole('button', { name: 'Change Acme Money' }));
    fireEvent.change(within(card).getByLabelText(/^Name/), { target: { value: 'Acme Money Pro' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('region', { name: 'Acme Money Pro' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls(state, 'PATCH', '/api/v1/connected-apps/').at(-1)?.body).toEqual({
      name: 'Acme Money Pro',
    });
  });

  it('an owner lets it show and delete: what a delete does, and links an hour, after a passkey or a code (APP3)', async () => {
    const state = at('/settings/connected-apps', {
      connectedApps: [AHMEDS],
      stepUpNeeded: true,
    });
    const card = await screen.findByRole('region', { name: 'Acme Money' });
    fireEvent.click(within(card).getByRole('button', { name: 'Change Acme Money' }));
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
      await screen.findByText('Saved. Acme Money may do what it now says here.'),
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

  it('an owner lets it file what is sure and complete, after a passkey or a code (APP4)', async () => {
    const state = at('/settings/connected-apps', {
      connectedApps: [AHMEDS],
      stepUpNeeded: true,
    });
    const card = await screen.findByRole('region', { name: 'Acme Money' });
    expect(within(card).getByText('Everything waits for a look')).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Change Acme Money' }));
    const auto = within(card).getByLabelText('File when everything is sure and complete');
    expect(auto).not.toBeChecked();
    expect(auto).toHaveAccessibleDescription(/Anything else waits in the Inbox/);
    await expectAccessible();
    fireEvent.click(auto);
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    await confirmWithCode();
    expect(
      await screen.findByText('Saved. Acme Money may do what it now says here.'),
    ).toBeInTheDocument();
    expect(calls(state, 'PATCH', '/api/v1/connected-apps/').at(-1)?.body).toEqual({
      auto_file: true,
    });
    expect(
      await within(card).findByText('Files what is sure and complete; the rest waits for a look'),
    ).toBeInTheDocument();

    // For older papers alone: offered with the window, while the app's own switch is off.
    state.stepUpNeeded = true;
    fireEvent.click(within(card).getByRole('button', { name: 'Change Acme Money' }));
    fireEvent.click(within(card).getByLabelText('File when everything is sure and complete'));
    fireEvent.click(within(card).getByLabelText('Let it send older papers for a while'));
    fireEvent.click(
      within(card).getByLabelText('File when everything is sure and complete, until then'),
    );
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    await confirmWithCode();
    expect(
      await within(card).findByText(
        /^Files what is sure and complete until .+; the rest waits for a look$/,
      ),
    ).toBeInTheDocument();
    expect(calls(state, 'PATCH', '/api/v1/connected-apps/').at(-1)?.body).toMatchObject({
      auto_file: false,
      backfill: { files_per_day: 100, bytes_per_day: 500 * MB, auto_file: true },
    });
  });

  it('an owner sends each paper to the Inbox of the person it is about, after a passkey or a code (APP5)', async () => {
    const state = at('/settings/connected-apps', {
      connectedApps: [AHMEDS],
      stepUpNeeded: true,
    });
    const card = await screen.findByRole('region', { name: 'Acme Money' });
    // An app from before keeps its person's Inbox.
    expect(within(card).getByText('Ahmed’s')).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Change Acme Money' }));
    const route = within(card).getByLabelText(
      'Send each paper to the Inbox of the person it’s about',
    );
    expect(route).not.toBeChecked();
    expect(route).toHaveAccessibleDescription(/The app is never told whose Inbox/);
    await expectAccessible();
    fireEvent.click(route);
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    await confirmWithCode();
    expect(calls(state, 'PATCH', '/api/v1/connected-apps/').at(-1)?.body).toEqual({
      route_to_person: true,
    });
    expect(
      await within(card).findByText('The person each paper is about, else Ahmed’s'),
    ).toBeInTheDocument();
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
    const card = await screen.findByRole('region', { name: 'Acme Money' });
    expect(within(card).getByText('What it sent')).toBeInTheDocument();
    expect(within(card).getByText('0 MB of 1 GB')).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Change what Acme Money may read' }));
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
        'Bank / investment statement is sensitive. Acme Money will be able to read it. Allow anyway?',
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
      await screen.findByText('Saved. Acme Money may read what it now says here.'),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(card).getByRole('button', { name: 'Change what Acme Money may read' }),
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
    fireEvent.click(within(card).getByRole('button', { name: 'Change what Acme Money may read' }));
    fireEvent.change(within(card).getByLabelText('Months back'), { target: { value: '48' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    expect(await within(card).findByText('How far back: 1 to 36 months.')).toBeInTheDocument();
  });

  it('an owner generates an API key: permissions ticked from the app’s, a validity, the secret shown once (APP6)', async () => {
    const copied = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: copied } });
    const state = at('/settings/connected-apps', {
      connectedApps: [app({ scopes: ['documents.send', 'documents.read'], keys: [] })],
      stepUpNeeded: true,
    });
    const card = await screen.findByRole('region', { name: 'Acme Money' });
    expect(
      within(card).getByText('No key yet. Generate one, and paste it into Acme Money.'),
    ).toBeVisible();
    expect(
      within(card).getByText('Acme Money needs an API key before it can reach the vault.'),
    ).toBeVisible();
    fireEvent.click(
      within(card).getByRole('button', { name: 'Generate an API key for Acme Money' }),
    );
    const form = await within(card).findByRole('form', {
      name: 'Generate an API key for Acme Money',
    });
    await waitFor(() =>
      expect(
        within(form).getByRole('heading', { name: 'Generate an API key for Acme Money' }),
      ).toHaveFocus(),
    );
    // Every permission the app has, ticked; none it has not.
    expect(
      within(form).getByLabelText('Send documents to the Inbox, and see what became of them'),
    ).toBeChecked();
    expect(
      within(form).getByLabelText('Read the details of documents it is allowed'),
    ).toBeChecked();
    expect(within(form).queryByLabelText('Download documents it is allowed')).toBeNull();
    const validity = within(form).getByLabelText('How long it lasts');
    expect(
      within(validity)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['30 days', '90 days', '1 year', 'Custom…', 'Never expires']);
    expect(validity).toHaveValue('365');
    await expectAccessible();

    // A custom validity out of range is said, not sent.
    fireEvent.change(validity, { target: { value: 'custom' } });
    fireEvent.change(within(form).getByLabelText('Days'), { target: { value: '4000' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Generate key' }));
    expect(await within(form).findByText('How long it lasts: 1 to 3650 days.')).toBeVisible();
    expect(calls(state, 'POST', '/keys')).toHaveLength(0);
    // Nothing ticked is said too.
    fireEvent.change(within(form).getByLabelText('Days'), { target: { value: '45' } });
    fireEvent.click(within(form).getByLabelText('Read the details of documents it is allowed'));
    fireEvent.change(within(form).getByLabelText(/^Name/), { target: { value: 'Live' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Generate key' }));
    await confirmWithCode();
    expect(calls(state, 'POST', '/keys').at(-1)?.body).toEqual({
      name: 'Live',
      permissions: ['documents.send'],
      expires_in_days: 45,
    });

    // Shown once: the client ID and the secret, with Copy, and the warning.
    const sheet = await screen.findByRole('dialog', { name: 'Copy this key now' });
    await waitFor(() =>
      expect(within(sheet).getByRole('heading', { name: 'Copy this key now' })).toHaveFocus(),
    );
    const made = state.connectedApps?.[0]?.keys[0];
    const secret = `fdvs_${'1'.padStart(43, 'S')}`;
    expect(within(sheet).getByText(made?.client_id ?? '?')).toBeVisible();
    expect(within(sheet).getByText(secret)).toBeVisible();
    expect(
      within(sheet).getByText(
        'The secret won’t be shown again. If it’s lost, generate a new key and revoke this one.',
      ),
    ).toBeVisible();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Copy the secret' }));
    await waitFor(() => expect(copied).toHaveBeenCalledWith(secret));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Copy the client ID' }));
    await waitFor(() => expect(copied).toHaveBeenCalledWith(made?.client_id));
    // The connection string: without the secret, unless ticked.
    const without = state.connectedApps?.[0]?.connection_string ?? '?';
    expect(within(sheet).getByText(without)).toBeVisible();
    fireEvent.click(within(sheet).getByLabelText('Include the secret in the connection string'));
    const shown = within(sheet).getByLabelText('Connection string').textContent ?? '';
    expect(shown).not.toBe(without);
    expect(JSON.parse(atob(shown.slice('fdvapp2.'.length)))).toMatchObject({ secret });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Copy the connection string' }));
    await waitFor(() => expect(copied).toHaveBeenCalledWith(shown));
    await expectAccessible();

    // Done: the secret goes with the sheet, and is nowhere on the page.
    fireEvent.click(within(sheet).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByText(secret)).toBeNull();
    expect(
      await screen.findByText(
        'Acme Money waits for Ahmed to turn it on again before it can use its new key.',
      ),
    ).toBeInTheDocument();
    // Listed, with what it may do and when it expires.
    const list = within(card).getByRole('list', { name: 'API keys' });
    expect(within(list).getByText('Live')).toBeVisible();
    expect(within(list).getByText(made?.client_id ?? '?')).toBeVisible();
    expect(within(list).getByText('Send')).toBeVisible();
    expect(within(list).getByText('Never used')).toBeVisible();
  });

  it('a key that never expires, and the vault’s refusal said on the form (APP6)', async () => {
    const state = at('/settings/connected-apps', {
      connectedApps: [app({ keys: [] })],
    });
    const card = await screen.findByRole('region', { name: 'Acme Money' });
    fireEvent.click(
      within(card).getByRole('button', { name: 'Generate an API key for Acme Money' }),
    );
    fireEvent.change(within(card).getByLabelText('How long it lasts'), {
      target: { value: 'never' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Generate key' }));
    const sheet = await screen.findByRole('dialog', { name: 'Copy this key now' });
    expect(calls(state, 'POST', '/keys').at(-1)?.body).toEqual({
      name: null,
      permissions: ['documents.send'],
      expires_in_days: null,
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const list = within(card).getByRole('list', { name: 'API keys' });
    expect(within(list).getByText('Unnamed key')).toBeVisible();
    expect(within(list).getByText('Never')).toBeVisible();
    // The vault refuses: its words, on the form, which stays open.
    fireEvent.click(
      within(card).getByRole('button', { name: 'Generate an API key for Acme Money' }),
    );
    state.connectedApps = state.connectedApps!.map((a) => ({ ...a, scopes: ['documents.read'] }));
    fireEvent.click(within(card).getByRole('button', { name: 'Generate key' }));
    expect(
      await within(card).findByText('Choose what the key may do, from the app’s.'),
    ).toBeVisible();
    expect(within(card).getByRole('button', { name: 'Generate key' })).toBeInTheDocument();
  });

  it('says each key in words: soon to expire, expired, revoked; two live keys at most (APP6)', async () => {
    const soon = new Date(Date.now() + 5 * 864e5 - 60_000).toISOString();
    at('/settings/connected-apps', {
      connectedApps: [
        app({
          keys: [
            key({ name: 'Old', state: 'expired', expires_at: '2026-10-01T09:00:00.000Z' }),
            key({
              id: 'k-2',
              client_id: 'fdvc_REVOKEDREVOKEDREVOKE',
              name: 'Leaked',
              state: 'revoked',
              revoked_at: '2026-11-03T09:00:00.000Z',
            }),
            key({
              id: 'k-3',
              client_id: 'fdvc_SOONSOONSOONSOONSOON',
              name: 'Soon',
              expires_at: soon,
            }),
            key({ id: 'k-4', client_id: 'fdvc_NEVERNEVERNEVERNEVER', name: 'Forever' }),
          ],
        }),
      ],
    });
    const card = await screen.findByRole('region', { name: 'Acme Money' });
    const rows = within(within(card).getByRole('list', { name: 'API keys' })).getAllByRole(
      'listitem',
    );
    expect(rows).toHaveLength(4);
    expect(within(rows[0] as HTMLElement).getByText(/Expired/)).toBeVisible();
    expect(within(rows[0] as HTMLElement).queryByRole('button', { name: /^Revoke/ })).toBeNull();
    expect(within(rows[1] as HTMLElement).getByText(/Revoked 3 November/)).toBeVisible();
    expect(within(rows[1] as HTMLElement).queryByRole('button', { name: /^Revoke/ })).toBeNull();
    expect(within(rows[2] as HTMLElement).getByText(/\(expires in 5 days\)$/)).toBeVisible();
    expect(within(rows[3] as HTMLElement).getByText('Never')).toBeVisible();
    expect(
      within(rows[3] as HTMLElement).getByRole('button', { name: 'Revoke the key Forever' }),
    ).toBeEnabled();
    // Two work: no third.
    const generate = within(card).getByRole('button', {
      name: 'Generate an API key for Acme Money',
    });
    expect(generate).toBeDisabled();
    expect(generate).toHaveAccessibleDescription(
      '2 keys at most work at once. Revoke one to generate another.',
    );
    await expectAccessible();
  });

  it('an owner revokes a key, asked first, with a passkey or a code (APP6)', async () => {
    const state = at('/settings/connected-apps', {
      connectedApps: [app({ keys: [key({ name: 'Live' })] })],
      stepUpNeeded: true,
    });
    const card = await screen.findByRole('region', { name: 'Acme Money' });
    fireEvent.click(within(card).getByRole('button', { name: 'Revoke the key Live' }));
    let ask = await screen.findByRole('alertdialog', { name: 'Revoke this key?' });
    expect(
      within(ask).getByText(/Acme Money stops working with the key Live at its next request/),
    ).toBeInTheDocument();
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(calls(state, 'DELETE', '/keys/')).toHaveLength(0);
    fireEvent.click(within(card).getByRole('button', { name: 'Revoke the key Live' }));
    ask = await screen.findByRole('alertdialog', { name: 'Revoke this key?' });
    fireEvent.click(within(ask).getByRole('button', { name: 'Revoke' }));
    await confirmWithCode();
    expect(await screen.findByText('The key Live was revoked.')).toBeInTheDocument();
    expect(calls(state, 'DELETE', '/keys/k-1').length).toBeGreaterThan(0);
    expect(state.connectedApps?.[0]?.keys[0]?.state).toBe('revoked');
    expect(await within(card).findByText(/^ ?Revoked /)).toBeVisible();
    expect(within(card).queryByRole('button', { name: 'Revoke the key Live' })).toBeNull();
    expect(
      within(card).getByText('Acme Money needs an API key before it can reach the vault.'),
    ).toBeVisible();
  });

  it('an owner removes an app, asked first: Cancel leaves it', async () => {
    const state = at('/settings/connected-apps', { connectedApps: [AHMEDS] });
    const card = await screen.findByRole('region', { name: 'Acme Money' });
    fireEvent.click(within(card).getByRole('button', { name: 'Remove Acme Money' }));
    let ask = await screen.findByRole('alertdialog', { name: 'Remove Acme Money?' });
    expect(within(ask).getByText(/What it sent stays in Ahmed’s Inbox/)).toBeInTheDocument();
    await expectAccessible();
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(state.connectedApps).toHaveLength(1);
    fireEvent.click(within(card).getByRole('button', { name: 'Remove Acme Money' }));
    ask = await screen.findByRole('alertdialog', { name: 'Remove Acme Money?' });
    fireEvent.click(within(ask).getByRole('button', { name: 'Remove' }));
    expect(
      await screen.findByText('Acme Money was removed. It can no longer send anything.'),
    ).toBeInTheDocument();
    expect(state.connectedApps).toEqual([]);
    expect(await screen.findByText('No app is connected.')).toBeInTheDocument();
  });

  it('warns while the app routes are not on the public address', async () => {
    at('/settings/connected-apps', { connectedApps: [AHMEDS], appsPublic: false });
    expect(await screen.findByText(appsNotPublicWords('Acme Money'))).toBeInTheDocument();
    cleanup();
    // With no app, nothing to warn about.
    at('/settings/connected-apps', { connectedApps: [], appsPublic: false });
    await screen.findByText('No app is connected.');
    expect(screen.queryByText(/FDV_PUBLIC_APPS/)).toBeNull();
  });
});

/**
 * An app acts as itself (0.9.0, APP8): by default, with a person who reviews
 * what it sends that is for nobody in particular — the owner connecting it
 * unless they choose another owner or adult, who is told and asked nothing.
 */
describe('Settings → Connected apps: an app acting as itself (0.9.0, APP8)', () => {
  /** Acme Money acting as itself, reviewed by Ahmed. */
  const ITSELF = app({
    acts_as: 'app',
    member_id: null,
    member_name: null,
    reviewer_member_id: 'm-ahmed',
    reviewer_name: 'Ahmed',
    mine: false,
    counts: null,
    route_to_person: true,
  });

  it('connects as itself by default, reviewed by the owner connecting it, and no person', async () => {
    const state = at('/settings/connected-apps', { connectedApps: [], stepUpNeeded: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Connect an app' }));
    const form = await screen.findByRole('region', { name: 'Connect an app' });
    fireEvent.change(within(form).getByLabelText(/^Name/), { target: { value: 'Acme Money' } });
    const who = within(form).getByLabelText('It acts as');
    expect(who).toHaveValue('app');
    expect(within(who).getByRole('option', { name: 'Itself (Acme Money)' })).toBeInTheDocument();
    // Its reviewer: owners and adults who sign in, never a teen; the owner first chosen.
    const reviewer = within(form).getByLabelText('Reviewed by');
    expect(
      within(reviewer)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Mansoor Seikh (you)', 'Ahmed · Adult']);
    expect(reviewer).toHaveValue('me');
    expect(reviewer).toHaveAccessibleDescription(/They are told, and need not turn anything on/);
    await expectAccessible();
    fireEvent.click(within(form).getByLabelText('Bank / investment statement'));
    fireEvent.click(within(form).getByRole('button', { name: 'Connect' }));
    await confirmWithCode();
    const card = await screen.findByRole('region', { name: 'Acme Money' });
    const sent = calls(state, 'POST', '/api/v1/connected-apps').at(-1)?.body as Record<
      string,
      unknown
    >;
    expect(sent).toMatchObject({ acts_as: 'app', reviewer_member_id: 'me' });
    expect(sent).not.toHaveProperty('member_id');
    // On at once: nobody else turns it on.
    expect(within(card).getByText('On')).toBeInTheDocument();
    expect(within(card).getByText('Acting as itself')).toBeInTheDocument();
  });

  it('connects with another reviewer, who needs no approval', async () => {
    const state = at('/settings/connected-apps', { connectedApps: [] });
    fireEvent.click(await screen.findByRole('button', { name: 'Connect an app' }));
    const form = await screen.findByRole('region', { name: 'Connect an app' });
    fireEvent.change(within(form).getByLabelText(/^Name/), { target: { value: 'Acme Money' } });
    fireEvent.change(within(form).getByLabelText('Reviewed by'), {
      target: { value: 'm-ahmed' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Connect' }));
    const card = await screen.findByRole('region', { name: 'Acme Money' });
    expect(calls(state, 'POST', '/api/v1/connected-apps').at(-1)?.body).toMatchObject({
      acts_as: 'app',
      reviewer_member_id: 'm-ahmed',
    });
    expect(within(card).getByText('On')).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Cancel' }));
    expect(await within(card).findByText('Ahmed')).toBeInTheDocument();
  });

  it('shows on the card that it acts as itself, who reviews it, and whose Inbox takes the rest', async () => {
    at('/settings/connected-apps', { connectedApps: [ITSELF] });
    const card = await screen.findByRole('region', { name: 'Acme Money' });
    expect(within(card).getByText('Acting as itself')).toBeInTheDocument();
    expect(within(card).getByText('Itself')).toBeInTheDocument();
    expect(within(card).getByText('Reviewed by')).toBeInTheDocument();
    expect(within(card).getByText('Ahmed')).toBeInTheDocument();
    expect(
      within(card).getByText('The person each paper is about, else Ahmed’s'),
    ).toBeInTheDocument();
    expect(within(card).queryByRole('note')).toBeNull();
    await expectAccessible();
  });

  it('says when nobody can review what it sends, and a card with no person renders', async () => {
    at('/settings/connected-apps', {
      connectedApps: [
        { ...ITSELF, reviewer_member_id: null, reviewer_name: null, reviewer_needed: true },
      ],
    });
    const card = await screen.findByRole('region', { name: 'Acme Money' });
    expect(within(card).getByRole('note')).toHaveTextContent(
      'Choose who reviews what Acme Money sends.',
    );
    expect(within(card).getByText('Nobody who can, now')).toBeInTheDocument();
    expect(
      within(card).getByText(
        'The person each paper is about, else nobody’s, until an owner chooses who',
      ),
    ).toBeInTheDocument();
    await expectAccessible();
  });

  it('changes its reviewer: only that is sent, with acts_as', async () => {
    const state = at('/settings/connected-apps', { connectedApps: [ITSELF], stepUpNeeded: true });
    const card = await screen.findByRole('region', { name: 'Acme Money' });
    fireEvent.click(within(card).getByRole('button', { name: 'Change Acme Money' }));
    expect(within(card).getByLabelText('It acts as')).toHaveValue('app');
    const reviewer = within(card).getByLabelText('Reviewed by');
    expect(reviewer).toHaveValue('m-ahmed');
    fireEvent.change(reviewer, { target: { value: 'me' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    await confirmWithCode();
    expect(calls(state, 'PATCH', '/api/v1/connected-apps/').at(-1)?.body).toEqual({
      acts_as: 'app',
      reviewer_member_id: 'me',
    });
    expect(await within(card).findByText('Mansoor Seikh (you)')).toBeInTheDocument();
  });

  it('changes it to act as a person, who then turns it on; and back to itself', async () => {
    const state = at('/settings/connected-apps', { connectedApps: [ITSELF] });
    const card = await screen.findByRole('region', { name: 'Acme Money' });
    fireEvent.click(within(card).getByRole('button', { name: 'Change Acme Money' }));
    fireEvent.change(within(card).getByLabelText('It acts as'), {
      target: { value: 'person:m-ahmed' },
    });
    expect(within(card).queryByLabelText('Reviewed by')).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('Saved. Acme Money waits for Ahmed to turn it on.'),
    ).toBeInTheDocument();
    expect(calls(state, 'PATCH', '/api/v1/connected-apps/').at(-1)?.body).toEqual({
      acts_as: 'person',
      member_id: 'm-ahmed',
    });
    expect(within(card).getByText('Acting as Ahmed')).toBeInTheDocument();
    // Back to itself: reviewed by the owner changing it, unless they choose.
    fireEvent.click(within(card).getByRole('button', { name: 'Change Acme Money' }));
    fireEvent.change(within(card).getByLabelText('It acts as'), { target: { value: 'app' } });
    expect(within(card).getByLabelText('Reviewed by')).toHaveValue('me');
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('Saved. Acme Money may do what it now says here.'),
    ).toBeInTheDocument();
    expect(calls(state, 'PATCH', '/api/v1/connected-apps/').at(-1)?.body).toEqual({
      acts_as: 'app',
      reviewer_member_id: 'me',
    });
  });
});
