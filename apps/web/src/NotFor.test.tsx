import { render, screen, waitFor } from '@testing-library/react';
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
  ['/settings/owners', ['adult', 'teen', 'viewer'], 'For owners', /\/vaults|\/smtp/],
  ['/settings/storage', ['adult', 'teen', 'viewer'], 'Where your files are kept', /\/vaults/],
  ['/settings/email', ['adult', 'teen', 'viewer'], 'Where email comes from', /\/smtp/],
];

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
});
