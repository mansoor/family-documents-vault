import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { fresh, installFakeApi, signedIn, type FakeState } from './test-api.js';

/**
 * The scanner folder and the email-in mailbox set from Settings, and kept
 * scans (0.9.0, O1), on the web: an owner chooses the folder — typed, or
 * browsed to through the folders the worker lists — and Verifies it, each
 * check said; sets how many days scans are kept, with what that means;
 * and sets up the household mailbox with an app password that is sent
 * once and never shown, and Tests it, what it found said.
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

function at(path: string, over: Partial<FakeState>) {
  const state = fresh(over);
  installFakeApi(state);
  signedIn('owner');
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

/** Long enough for the page to ask after the worker's answer a few times. */
const WAIT = { timeout: 5_000 };

const folder = (over: Record<string, unknown> = {}) => ({
  available: true,
  folder: {
    state: 'ready',
    dir: '/watch',
    checked_at: new Date().toISOString(),
    words: 'The scanner folder is ready: /watch in the worker.',
  },
  choice: { dir: null, default_dir: '/watch', roots: ['/watch', '/scans'] },
  keep_days: 7,
  kept_warning:
    'Scans kept here are not encrypted until they’re deleted; anyone who can open the server’s folder can read them.',
  enabled: false,
  member_id: null,
  member_name: null,
  paused: null,
  last_added_at: null,
  stuck_files: 0,
  stuck_words: null,
  candidates: [{ member_id: 'me', display_name: 'Mansoor', role: 'owner' }],
  ...over,
});
const step = (check: string, ok: boolean | null, words: string) => ({ check, ok, words });
const VERIFIED = {
  path: '/scans/office',
  ok: true,
  free_bytes: 50 * 1024 ** 3,
  words: '/scans/office is ready for scans.',
  steps: [
    step('exists', true, 'The folder is there.'),
    step('folder', true, 'It is a folder.'),
    step('inside', true, 'It is inside the folders the vault may use, with no link out of them.'),
    step('not_vault', true, 'It isn’t one of the vault’s own folders.'),
    step('read', true, 'The vault can see what is in it.'),
    step('create', true, 'The vault can make a file in it.'),
    step('move', true, 'The vault can move a file in it.'),
    step('delete', true, 'The vault can delete a file in it.'),
    step('space', true, 'There is 50 GB free.'),
  ],
};
const REFUSED = {
  path: '/scans/upstairs',
  ok: false,
  free_bytes: null,
  words:
    '/scans/upstairs can’t be used yet. The vault can’t make a file in it, so it couldn’t keep scans or say why it rejected one. Give the folder to the containers’ user (uid 1000).',
  steps: [
    step('exists', true, 'The folder is there.'),
    step('folder', true, 'It is a folder.'),
    step('inside', true, 'It is inside the folders the vault may use, with no link out of them.'),
    step('not_vault', true, 'It isn’t one of the vault’s own folders.'),
    step('read', true, 'The vault can see what is in it.'),
    step(
      'create',
      false,
      'The vault can’t make a file in it, so it couldn’t keep scans or say why it rejected one. Give the folder to the containers’ user (uid 1000).',
    ),
    step('move', null, 'Moving a file in it: not checked, as something before it failed.'),
    step('delete', null, 'Deleting a file in it: not checked, as something before it failed.'),
    step('space', true, 'There is 50 GB free.'),
  ],
};
const putsOf = (state: FakeState, url: string) =>
  state.calls.filter((c) => c.method === 'PUT' && c.url === url);

describe('the scanner folder chosen in Settings (O1)', () => {
  it('browses to a folder, Verifies it, says each check, and saves it with how long scans are kept', async () => {
    const state = at('/settings/scanner', {
      watchFolder: folder(),
      browseAnswers: { '/scans': ['office', 'upstairs'], '/scans/office': [] },
      verifyAnswers: { '/scans/office': VERIFIED, '/scans/upstairs': REFUSED },
    });
    const field = await screen.findByLabelText('Folder, as the worker sees it');
    // The server's own, to start with; and where a folder may be chosen.
    await waitFor(() =>
      expect(screen.getByLabelText('Folder, as the worker sees it')).toHaveValue('/watch'),
    );
    expect(
      screen.getByText(/A folder inside \/watch, \/scans: the folders the server set aside/),
    ).toBeInTheDocument();
    expect(screen.getByText(/The server’s own is \/watch\./)).toBeInTheDocument();
    // Kept scans: 7 days, and what that means.
    expect(screen.getByLabelText('Keep each scan for this many days')).toHaveValue(7);
    expect(
      screen.getByText(
        'Scans kept here are not encrypted until they’re deleted; anyone who can open the server’s folder can read them.',
      ),
    ).toBeInTheDocument();
    // Browsed, from a root: the folders inside it, each chosen with a press.
    fireEvent.click(screen.getByRole('button', { name: 'Browse /scans' }));
    const list = await screen.findByRole('navigation', { name: 'Folders in /scans' }, WAIT);
    expect(
      within(list)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Choose /scans/office', 'Choose /scans/upstairs']);
    // A folder that can't be used: said, step by step.
    fireEvent.click(within(list).getByRole('button', { name: 'Choose /scans/upstairs' }));
    expect(field).toHaveValue('/scans/upstairs');
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText(REFUSED.words, {}, WAIT)).toBeInTheDocument();
    const steps = screen.getByRole('list', { name: 'What was checked of /scans/upstairs' });
    expect(within(steps).getAllByRole('listitem')).toHaveLength(9);
    expect(within(steps).getByText(/Moving a file in it: not checked/)).toBeInTheDocument();
    await expectAccessible();
    // Another, that can.
    fireEvent.change(field, { target: { value: '/scans/office' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(
      await screen.findByText('/scans/office is ready for scans.', {}, WAIT),
    ).toBeInTheDocument();
    expect(screen.getByText('There is 50 GB free.')).toBeInTheDocument();
    expect(state.checksAsked).toEqual([
      { kind: 'browse', path: '/scans' },
      { kind: 'browse', path: '/scans/upstairs' },
      { kind: 'folder', path: '/scans/upstairs' },
      { kind: 'folder', path: '/scans/office' },
    ]);
    // Saved with 30 days kept.
    fireEvent.change(screen.getByLabelText('Keep each scan for this many days'), {
      target: { value: '30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putsOf(state, '/api/v1/watch-folder')).toHaveLength(1));
    expect(putsOf(state, '/api/v1/watch-folder')[0]?.body).toEqual({
      enabled: false,
      member_id: 'me',
      dir: '/scans/office',
      keep_days: 30,
    });
    await expectAccessible();
  });

  it('the server’s own folder is saved as the server’s own; days out of range are said, not sent', async () => {
    const state = at('/settings/scanner', {
      watchFolder: folder({
        choice: { dir: '/scans/office', default_dir: '/watch', roots: ['/scans'] },
      }),
    });
    const field = await screen.findByLabelText('Folder, as the worker sees it');
    await waitFor(() => expect(field).toHaveValue('/scans/office'));
    fireEvent.click(screen.getByRole('button', { name: 'Use the server’s folder' }));
    expect(field).toHaveValue('/watch');
    const keep = screen.getByLabelText('Keep each scan for this many days');
    fireEvent.change(keep, { target: { value: '400' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Keep scans for 0 to 365 days.', {}, WAIT)).toBeInTheDocument();
    expect(putsOf(state, '/api/v1/watch-folder')).toEqual([]);
    fireEvent.change(keep, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putsOf(state, '/api/v1/watch-folder')).toHaveLength(1));
    expect(putsOf(state, '/api/v1/watch-folder')[0]?.body).toMatchObject({
      dir: null,
      keep_days: 0,
    });
  });

  it('a path the server refuses is said in its words', async () => {
    at('/settings/scanner', { watchFolder: folder() });
    const field = await screen.findByLabelText('Folder, as the worker sees it');
    // The form starts from what the vault has: only then is it changed.
    await waitFor(() => expect(field).toHaveValue('/watch'));
    fireEvent.change(field, { target: { value: '/home/me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText(/That folder isn’t one the vault may use/, {}, WAIT),
    ).toBeInTheDocument();
  });
});

const mailIn = (over: Record<string, unknown> = {}) => ({
  available: false,
  enabled: false,
  server: {
    state: 'not_configured',
    address: null,
    folder: null,
    after: 'move',
    sender_check: false,
    filing: null,
    filing_words: null,
    poll_seconds: 300,
    checked_at: new Date().toISOString(),
    words: 'No household mailbox is set up yet. Set one up below, or on the server.',
  },
  last_checked_at: null,
  last_error: null,
  last_added_at: null,
  unknown_senders: 0,
  unverified: 0,
  waiting: 0,
  counts: [],
  sender_warning: null,
  confirm: { send_from: false, emailed: false },
  confirm_warning: null,
  source: 'none',
  mailbox: null,
  ...over,
});

describe('the household mailbox set up in Settings (O1)', () => {
  it('sets it up with an app password sent once, never shown, and tests it, what it found said', async () => {
    const state = at('/settings/email-in', {
      mailIn: mailIn(),
      mailboxTestAnswer: {
        source: 'settings',
        problem: null,
        messages: 3,
        move: true,
        uidplus: true,
        authserv_id_seen: 'mx.google.com',
        authserv_id_set: 'mx.google.com',
        ok: true,
        lines: [
          'Signed in, and opened INBOX: 3 messages are there. Only the newest emails’ Authentication-Results headers were read (three at most); nothing was moved or marked.',
          'The server can move and delete one email alone (MOVE and UIDPLUS).',
          'The newest three messages’ Authentication-Results all name mx.google.com, as set.',
        ],
      },
    });
    expect(
      await screen.findByRole('heading', { name: 'Set up the mailbox', level: 2 }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Port')).toHaveValue(993);
    expect(screen.getByLabelText('Folder')).toHaveValue('INBOX');
    expect(screen.getByText(/Gmail: mx\.google\.com\./)).toBeInTheDocument();
    expect(screen.getByLabelText('App password')).toHaveAttribute('type', 'password');
    await expectAccessible();
    fireEvent.change(screen.getByLabelText('Mail server (IMAP)'), {
      target: { value: 'imap.gmail.com' },
    });
    fireEvent.change(screen.getByLabelText('Sign-in'), {
      target: { value: 'family.docs@gmail.com' },
    });
    fireEvent.change(screen.getByLabelText('App password'), {
      target: { value: 'abcd efgh ijkl' },
    });
    fireEvent.change(screen.getByLabelText('The provider’s authserv-id'), {
      target: { value: 'mx.google.com' },
    });
    fireEvent.change(screen.getByLabelText('How often it is checked'), {
      target: { value: '120' },
    });
    // Not tested until saved.
    expect(screen.getByRole('button', { name: 'Test the mailbox' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save the mailbox' }));
    await waitFor(() => expect(state.mailboxSaves).toHaveLength(1));
    expect(state.mailboxSaves?.[0]).toEqual({
      host: 'imap.gmail.com',
      port: 993,
      username: 'family.docs@gmail.com',
      password: 'abcd efgh ijkl',
      folder: 'INBOX',
      after: 'move',
      authserv_id: 'mx.google.com',
      poll_seconds: 120,
    });
    expect(
      await screen.findByText(
        'Saved. The vault checks this mailbox from now on: test it to be sure.',
        {},
        WAIT,
      ),
    ).toBeInTheDocument();
    // Never shown again: the field is empty, and says one is kept.
    expect(screen.getByLabelText('App password')).toHaveValue('');
    expect(screen.getByText(/One is saved, and never shown/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('abcd efgh ijkl');
    // Changed without a password: the one saved is kept.
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: 'Scans' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save the mailbox' }));
    await waitFor(() => expect(state.mailboxSaves).toHaveLength(2));
    expect(state.mailboxSaves?.[1]).not.toHaveProperty('password');
    // The server changed (the O1 review, H1): the password asked for again,
    // and nothing saved until it is typed.
    await waitFor(() => expect(screen.getByLabelText('Folder')).toHaveValue('Scans'));
    fireEvent.change(screen.getByLabelText('Mail server (IMAP)'), {
      target: { value: 'imap.fastmail.com' },
    });
    expect(screen.getByText(/You changed the server or the sign-in/)).toBeInTheDocument();
    expect(screen.getByLabelText('App password')).toHaveAttribute('aria-invalid', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Save the mailbox' }));
    expect(
      await screen.findByText('Type the app password again for the new server.'),
    ).toBeInTheDocument();
    expect(state.mailboxSaves).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Mail server (IMAP)'), {
      target: { value: 'imap.gmail.com' },
    });
    expect(screen.queryByText(/You changed the server or the sign-in/)).toBeNull();
    // Tested: what it found, line by line.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Test the mailbox' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Test the mailbox' }));
    const found = await screen.findByRole('list', { name: 'What the test found' }, WAIT);
    expect(
      within(found)
        .getAllByRole('listitem')
        .map((l) => l.textContent?.trim()),
    ).toEqual([
      '✓ Signed in, and opened INBOX: 3 messages are there. Only the newest emails’ Authentication-Results headers were read (three at most); nothing was moved or marked.',
      '· The server can move and delete one email alone (MOVE and UIDPLUS).',
      '· The newest three messages’ Authentication-Results all name mx.google.com, as set.',
    ]);
    expect(state.checksAsked).toEqual([{ kind: 'mailbox', path: null }]);
    await expectAccessible();
    // And taken away: the server's own, or none, again.
    fireEvent.click(screen.getByRole('button', { name: 'Remove this mailbox' }));
    expect(await screen.findByText(/Removed, with its password/, {}, WAIT)).toBeInTheDocument();
    expect(putsOf(state, '/api/v1/mail-in')).toEqual([]);
  });

  it('a test that failed says why, and the server’s own mailbox is named while none is set up here', async () => {
    at('/settings/email-in', {
      mailIn: mailIn({
        source: 'server',
        available: true,
        mailbox: {
          host: 'imap.gmail.com',
          port: 993,
          username: 'family.docs@gmail.com',
          password: 'set',
          folder: 'INBOX',
          after: 'delete',
          authserv_id: null,
          poll_seconds: 300,
          updated_at: new Date().toISOString(),
        },
      }),
      mailboxTestAnswer: {
        source: 'settings',
        problem: 'login_failed',
        messages: null,
        move: null,
        uidplus: null,
        authserv_id_seen: null,
        authserv_id_set: null,
        ok: false,
        lines: [
          'The mailbox refused the sign-in. Check the sign-in and the app password (an app password, not the account’s own).',
        ],
      },
    });
    expect(
      await screen.findByText(
        /The vault checks the server’s own mailbox \(FDV_MAIL_IN_\*\)/,
        {},
        WAIT,
      ),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText('Once its attachments are in')).toHaveValue('delete'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Test the mailbox' }));
    const why = await screen.findByRole('list', { name: 'Why the test failed' }, WAIT);
    expect(within(why).getByText(/refused the sign-in/)).toBeInTheDocument();
    await expectAccessible();
  });
});
