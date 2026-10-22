import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { fresh, installFakeApi, signedIn, type FakeState } from './test-api.js';

/**
 * The scanner folder (0.8.0, S3), on the web: an owner's page in Settings →
 * For owners, which says how the worker found the folder and why it is off,
 * turns it on only while it is offered, and chooses whose Inbox it fills;
 * and "A scanned file couldn't be added" in that person's Needs attention.
 */

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});
afterEach(cleanup);

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

function at(
  path: string,
  over: Partial<FakeState>,
  role: 'owner' | 'adult' | 'teen' | 'viewer' = 'owner',
) {
  const state = fresh(over);
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

const CANDIDATES = [
  { member_id: 'me', display_name: 'Mansoor', role: 'owner' },
  { member_id: 'm-ahmed', display_name: 'Ahmed', role: 'adult' },
  { member_id: 'm-tia', display_name: 'Tia', role: 'teen' },
];
const folder = (over: Record<string, unknown> = {}) => ({
  available: true,
  folder: {
    state: 'ready',
    dir: '/watch',
    checked_at: new Date().toISOString(),
    words: 'The folder /watch is ready.',
  },
  enabled: false,
  member_id: null,
  member_name: null,
  paused: null,
  last_added_at: null,
  stuck_files: 0,
  stuck_words: null,
  candidates: CANDIDATES,
  ...over,
});
const puts = (state: FakeState) =>
  state.calls.filter((c) => c.method === 'PUT' && c.url === '/api/v1/watch-folder');

describe('the scanner folder’s page (S3)', () => {
  it('is in For owners, says the folder is ready, and turns it on for someone who adds documents', async () => {
    const state = at('/settings/owners', { watchFolder: folder() });
    fireEvent.click(await screen.findByRole('link', { name: /Scanner folder/ }));
    expect(
      await screen.findByRole('heading', { name: 'Scanner folder', level: 1 }),
    ).toBeInTheDocument();
    expect(await screen.findByText('The folder /watch is ready.')).toBeInTheDocument();
    const box = screen.getByRole('checkbox', { name: 'Add what the scanner saves' });
    expect(box).not.toBeChecked();
    expect(box).toBeEnabled();
    const who = screen.getByLabelText('Whose Inbox it fills');
    // Themselves by default; never a viewer, who is not offered.
    await waitFor(() => expect(screen.getByLabelText('Whose Inbox it fills')).toHaveValue('me'));
    expect(
      within(who)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Mansoor (you)', 'Ahmed · Adult', 'Tia · Teen']);
    await expectAccessible();
    fireEvent.click(box);
    fireEvent.change(who, { target: { value: 'm-ahmed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const said = await screen.findByText(
      'Saved. What the scanner saves now goes to Ahmed’s Inbox.',
    );
    await waitFor(() => expect(said).toHaveFocus());
    expect(puts(state).map((c) => c.body)).toEqual([{ enabled: true, member_id: 'm-ahmed' }]);
  });

  it('says why it is off, and cannot be turned on, while the folder is not ready', async () => {
    at('/settings/scanner', {
      watchFolder: folder({
        available: false,
        folder: {
          state: 'not_writable',
          dir: '/watch',
          checked_at: new Date().toISOString(),
          words:
            'The vault can’t write to /watch, so it couldn’t delete a file once it is stored. Give the folder to the containers’ user (uid 1000).',
        },
      }),
    });
    expect(await screen.findByText(/can’t write to \/watch/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Add what the scanner saves' })).toBeDisabled();
    expect(screen.getByText('It can be turned on once the folder is ready.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await expectAccessible();
  });

  it('says when it is paused, and why', async () => {
    at('/settings/scanner', {
      watchFolder: folder({
        enabled: true,
        member_id: 'm-ahmed',
        member_name: 'Ahmed',
        paused: {
          reason: 'locked',
          words: 'Paused: Ahmed’s sign-in is locked. Scans wait in the folder until then.',
        },
      }),
    });
    expect(
      await screen.findByText(
        'Paused: Ahmed’s sign-in is locked. Scans wait in the folder until then.',
      ),
    ).toBeInTheDocument();
    // The form starts from what the vault has, once it has loaded.
    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: 'Add what the scanner saves' })).toBeChecked();
      expect(screen.getByLabelText('Whose Inbox it fills')).toHaveValue('m-ahmed');
    });
  });

  it('says whose Inbox it fills though they can’t add now, and when stored scans couldn’t be deleted', async () => {
    at('/settings/scanner', {
      watchFolder: folder({
        enabled: true,
        member_id: 'm-bea',
        member_name: 'Bea',
        paused: { reason: 'cannot_add', words: 'Paused: Bea can’t add documents now.' },
        stuck_files: 2,
        stuck_words:
          '2 scans are still in the scanner folder, not encrypted, though the vault has dealt with them.',
      }),
    });
    const who = await screen.findByLabelText('Whose Inbox it fills');
    await waitFor(() => expect(screen.getByLabelText('Whose Inbox it fills')).toHaveValue('m-bea'));
    const kept = within(who).getByRole('option', { name: 'Bea (can’t add now)' });
    expect(kept).toBeDisabled();
    expect(screen.getByText(/2 scans are still in the scanner folder/)).toBeInTheDocument();
    await expectAccessible();
  });

  it('says when processed is not the vault’s, when kept scans are left behind, and roots refused (the O1 review)', async () => {
    at('/settings/scanner', {
      watchFolder: folder({
        choice: {
          dir: '/watch/office',
          default_dir: null,
          roots: ['/watch'],
          refused_roots: ['/'],
          refused_words: 'The server names a folder for scanners that the vault refuses: /.',
        },
        keep_days: 7,
        kept_warning:
          'Scans kept here are not encrypted until they’re deleted; anyone who can open the server’s folder can read them. Anything else saved into processed is never touched, but isn’t added either.',
        processed_words:
          'The scanner folder has a folder called “processed” that the vault didn’t make.',
        kept_left: 1,
        kept_left_words: '1 kept scan is in a scanner folder the vault no longer uses.',
        kept_changed: 2,
        kept_changed_words: '2 kept scans changed since they were kept, left in place.',
        kept_untracked: 1,
        kept_untracked_words: '1 scan kept before a restore isn’t tracked.',
      }),
    });
    expect(
      await screen.findByText(/a folder called “processed” that the vault didn’t make/),
    ).toBeInTheDocument();
    expect(screen.getByText(/1 kept scan is in a scanner folder/)).toBeInTheDocument();
    expect(screen.getByText(/2 kept scans changed since they were kept/)).toBeInTheDocument();
    expect(screen.getByText(/1 scan kept before a restore isn’t tracked/)).toBeInTheDocument();
    expect(screen.getByText(/that the vault refuses: \//)).toBeInTheDocument();
    expect(
      screen.getByText(
        /Anything else saved into processed is never touched, but isn’t added either/,
      ),
    ).toBeInTheDocument();
    await expectAccessible();
  });

  it('is an owner’s: an adult is told so, and the vault is not asked', async () => {
    const state = at('/settings/scanner', { watchFolder: folder() }, 'adult');
    expect(
      await screen.findByText('Only an owner can set up the scanner folder.'),
    ).toBeInTheDocument();
    expect(state.calls.some((c) => c.url === '/api/v1/watch-folder')).toBe(false);
  });
});

describe('a scanned file that couldn’t be added (S3)', () => {
  const NOTE = {
    id: 'wn-1',
    file_name: 'letter.zip',
    reason: 'unsupported',
    left_in_place: false,
    title: 'A scanned file couldn’t be added',
    words:
      'letter.zip was moved to the scanner folder’s rejected folder. It isn’t a kind of file the vault keeps.',
    at: new Date().toISOString(),
  };

  it('is in its person’s Needs attention on Home, by name and why, and dismissed', async () => {
    const state = at('/', { watchNotices: [NOTE] }, 'adult');
    const words = await screen.findByText(/letter\.zip was moved/);
    const block = words.closest('section') as HTMLElement;
    expect(block).toHaveTextContent(
      'A scanned file couldn’t be added. letter.zip was moved to the scanner folder’s rejected folder.',
    );
    // Not "Everything is fine" beside it.
    expect(screen.queryByText(/Everything is fine/)).toBeNull();
    await expectAccessible();
    fireEvent.click(
      within(block).getByRole('button', { name: 'Dismiss the note about letter.zip' }),
    );
    const said = await screen.findByText(
      'Dismissed. letter.zip is still in the scanner folder’s rejected folder.',
    );
    await waitFor(() => expect(said).toHaveFocus());
    expect(
      state.calls.filter(
        (c) => c.method === 'POST' && c.url === '/api/v1/watch-folder/notices/wn-1/dismiss',
      ),
    ).toHaveLength(1);
    expect(screen.queryByText(/letter\.zip was moved/)).toBeNull();
  });

  it('is on the Needs attention page too', async () => {
    at('/reminders', { watchNotices: [NOTE] });
    expect(await screen.findByText(/letter\.zip was moved/)).toBeInTheDocument();
    expect(screen.queryByText(/Everything is fine/)).toBeNull();
  });

  it('is not asked for by a viewer, who adds nothing', async () => {
    const state = at('/', { watchNotices: [NOTE] }, 'viewer');
    await screen.findByText(/Everything is fine|Nothing here for you yet/);
    expect(state.calls.some((c) => c.url.startsWith('/api/v1/watch-folder'))).toBe(false);
  });
});
