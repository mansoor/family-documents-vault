import { cleanup, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { fresh, installFakeApi, signedIn, type FakeState } from './test-api.js';

/**
 * A screen typed into the address bar by a role that cannot use it (Phase
 * 6, the prototype's `notFor`): the screen's name and a sentence, and
 * nothing of the screen — nothing asked of the vault for it. The sidebar
 * never offered it; the vault refuses it all the same.
 */

type Role = 'owner' | 'adult' | 'teen' | 'viewer';

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

/** Every feature a role's screens hang on: batches, files sent, guests. */
function open(path: string, role: Role): FakeState {
  const state = fresh({ batches: [], incoming: [], guests: [] });
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

/**
 * Each screen, who cannot use it, its name, and what its own screen would
 * have asked the vault — never asked here.
 */
const CASES: Array<[path: string, roles: Role[], title: string, asks: RegExp]> = [
  ['/activity', ['viewer'], 'Activity', /\/audit/],
  ['/people', ['viewer'], 'People', /\/invitations|\/owner-changes/],
  ['/people/outside', ['adult', 'teen', 'viewer'], 'People outside the family', /\/guests/],
  ['/inbox', ['viewer'], 'Inbox', /\/batches|\/incoming/],
  ['/inbox/sent', ['teen', 'viewer'], 'Inbox', /\/incoming/],
  ['/inbox/batches/batch-1', ['viewer'], 'Inbox', /\/batches/],
  ['/sharing', ['teen', 'viewer'], 'Sharing', /\/shares|\/upload-requests/],
  ['/sharing/ask', ['teen', 'viewer'], 'Ask for documents', /\/upload-requests/],
  ['/after-restore', ['teen', 'viewer'], 'After a restore', /\/after-restore/],
  ['/add', ['viewer'], 'Add a document', /\/document-types/],
  ['/add/many', ['viewer'], 'Add many documents', /\/batches/],
  ['/settings/data', ['teen', 'viewer'], 'Your data', /\/exports/],
  ['/settings/storage', ['adult', 'teen', 'viewer'], 'Storage', /\/vaults/],
  // Server and reading (0.9.0): each part's address, its page's name.
  ['/settings/email', ['adult', 'teen', 'viewer'], 'Email, in and out', /\/smtp|\/mail-in/],
  ['/settings/email-in', ['adult', 'teen', 'viewer'], 'Email, in and out', /\/smtp|\/mail-in/],
  ['/settings/scanner', ['adult', 'teen', 'viewer'], 'Scanner folder', /\/watch-folder/],
  [
    '/settings/reading',
    ['adult', 'teen', 'viewer'],
    'Reading and the check',
    /\/household\/reading|\/reading-checks/,
  ],
  [
    '/settings/reading-check',
    ['adult', 'teen', 'viewer'],
    'Reading and the check',
    /\/household\/reading|\/reading-checks/,
  ],
];

describe('a page in two parts refuses with one sentence for both, at either part’s address (0.9.0)', () => {
  it.each([
    ['/settings/email', 'Only an owner can change the vault’s email settings.'],
    ['/settings/email-in', 'Only an owner can change the vault’s email settings.'],
    ['/settings/reading', 'Only an owner can change how the vault reads papers.'],
    ['/settings/reading-check', 'Only an owner can change how the vault reads papers.'],
  ])('%s: “%s”', async (path, why) => {
    for (const role of ['adult', 'teen', 'viewer'] as const) {
      open(path, role);
      expect(await screen.findByText(why)).toBeVisible();
      cleanup();
    }
  });
});

describe('For owners, an address that was a page', () => {
  it.each(['adult', 'teen', 'viewer'] as const)(
    'as a %s: Storage’s, not theirs to open, as For owners said',
    async (role) => {
      const state = open('/settings/owners', role);
      expect(await screen.findByRole('heading', { level: 1, name: 'Storage' })).toBeVisible();
      expect(window.location.pathname).toBe('/settings/storage');
      expect(screen.getByText(/^This isn’t something you can open\./)).toBeVisible();
      expect(screen.getByText('Only an owner can change where your files are kept.')).toBeVisible();
      await new Promise((r) => setTimeout(r, 50));
      expect(state.calls.map((c) => c.url).filter((u) => /\/vaults|\/smtp/.test(u))).toEqual([]);
    },
  );
});

describe('a screen a role cannot use, typed into the address bar', () => {
  for (const [path, roles, title, asks] of CASES) {
    for (const role of roles) {
      it(`${path}, as ${role === 'adult' ? 'an' : 'a'} ${role}: “${title}”, and that it isn’t theirs to open`, async () => {
        const state = open(path, role);
        expect(await screen.findByRole('heading', { level: 1, name: title })).toBeVisible();
        expect(screen.getByText(/^This isn’t something you can open\./)).toBeVisible();
        expect(screen.getByRole('link', { name: 'Go to Home' })).toHaveAttribute('href', '/');
        // It stays where it was typed: nothing moves them elsewhere.
        expect(window.location.pathname).toBe(path);
        // Nothing of the screen: nothing asked of the vault for it.
        await new Promise((r) => setTimeout(r, 50));
        expect(state.calls.map((c) => c.url).filter((u) => asks.test(u))).toEqual([]);
        await expectAccessible();
      });
    }
  }

  // Not these: the role rules give a viewer them, and the app sends a viewer
  // there — Home's Needs attention, and its word that an owner wants to
  // remove something they filed for good (5.24).
  it.each([
    ['/trash', 'viewer'],
    ['/reminders', 'viewer'],
    ['/trash', 'teen'],
    ['/activity', 'teen'],
    ['/people', 'teen'],
    ['/reminders', 'teen'],
    ['/inbox', 'teen'],
    ['/sharing', 'adult'],
    ['/after-restore', 'adult'],
    ['/settings/owners', 'owner'],
    ['/settings/data', 'adult'],
  ] as const)('%s, as a %s who may: the screen, as before', async (path, role) => {
    open(path, role);
    await waitFor(() => expect(screen.getAllByRole('heading', { level: 1 }).length).toBe(1));
    expect(screen.queryByText(/This isn’t something you can open/)).toBeNull();
  });

  it('a viewer’s Back from a person’s page goes to their documents, never to People (the review round)', async () => {
    open('/people/me', 'viewer');
    await screen.findByRole('heading', { level: 1, name: 'Mansoor Seikh' });
    expect(screen.getByRole('link', { name: 'Back' })).toHaveAttribute(
      'href',
      '/people/me/documents',
    );
  });

  it('a viewer who finds nobody there is offered Home, not People', async () => {
    open('/people/nobody', 'viewer');
    expect(await screen.findByText('We can’t find that person.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to Home' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'Back' })).toHaveAttribute('href', '/');
    expect(screen.queryByRole('link', { name: 'Back to People' })).toBeNull();
  });

  it('anybody of the family still goes back to People', async () => {
    open('/people/me', 'teen');
    await screen.findByRole('heading', { level: 1, name: 'Mansoor Seikh' });
    expect(screen.getByRole('link', { name: 'Back' })).toHaveAttribute('href', '/people');
  });
});
