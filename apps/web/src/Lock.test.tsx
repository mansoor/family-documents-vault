import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { flyoutsKey } from './flyout-store.js';
import { LOCK_HINT_KEY, LOCK_PENDING_KEY } from './session-lock.js';
import { fresh, installFakeApi, ME, PASSPORT, signedIn, type FakeState } from './test-api.js';

/**
 * Lock (0.9.0-dev.86): Lock in the bar on top lets go of every document open
 * beside the list and shows the lock screen in place of the whole app; one
 * confirmation brings it back, the one in front opened again and the rest in
 * the tray. Any call answered 423 shows it too, and so does a reload.
 */

const WIDE = 1280;
let width = WIDE;
const innerWidthWas = Object.getOwnPropertyDescriptor(window, 'innerWidth');
function atWidth(px: number) {
  width = px;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: px });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const minWidth = /\(min-width:\s*(\d+)px\)/.exec(query);
      const minHeight = /\(min-height:\s*(\d+)px\)/.exec(query);
      return {
        matches:
          (!minWidth || width >= Number(minWidth[1])) &&
          (!minHeight || 900 >= Number(minHeight[1])) &&
          Boolean(minWidth || minHeight),
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      };
    },
  });
}

let made: string[] = [];
let revoked: string[] = [];
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, '', '/');
  made = [];
  revoked = [];
  // jsdom has no object URLs: each page's picture is its own blob: address.
  Object.assign(URL, {
    createObjectURL: vi.fn(() => {
      const url = `blob:page-${made.length + 1}`;
      made.push(url);
      return url;
    }),
    revokeObjectURL: vi.fn((url: string) => void revoked.push(url)),
  });
});
afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia');
  if (innerWidthWas) Object.defineProperty(window, 'innerWidth', innerWidthWas);
  vi.restoreAllMocks();
});

const doc = (n: number) => ({
  ...PASSPORT,
  id: `doc-${n}`,
  title: `Paper ${String(n).padStart(2, '0')}`,
  latest_version_id: `v-${n}`,
  is_essential: false,
  tags: [],
  etag: `"${n}"`,
});

function at(over: Partial<FakeState> = {}, path = '/documents'): FakeState {
  atWidth(WIDE);
  const state = fresh({
    members: [ME],
    documents: [doc(1), doc(2), doc(3)],
    collections: [],
    sessionLock: true,
    ...over,
  });
  installFakeApi(state);
  signedIn('owner');
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

const grid = () => screen.findByRole('grid', { name: /^Documents, sorted by/ });
const tray = () => screen.getByRole('navigation', { name: 'Open documents' });
const fetched = (state: FakeState, id: string) =>
  state.calls.filter((c) => c.method === 'GET' && c.url === `/api/v1/documents/${id}`).length;
const lockHeading = () => screen.findByRole('heading', { level: 1, name: 'The vault is locked' });

async function open(n: number) {
  const name = `Paper ${String(n).padStart(2, '0')}`;
  const link = await within(await grid()).findByRole('link', { name });
  act(() => link.focus());
  fireEvent.click(link);
  return screen.findByRole('dialog', { name });
}

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

/** Two open side by side, Paper 01 the pane used last, Paper 03 minimised in the tray. */
async function threeOpen() {
  await open(3);
  await open(2);
  const front = await open(1);
  await waitFor(() => expect(front.querySelector('img[src^="blob:"]')).not.toBeNull());
  fireEvent.click(within(front).getByRole('button', { name: 'Side by side' }));
  const picker = await screen.findByRole('dialog', { name: 'Side by side' });
  fireEvent.click(within(picker).getByRole('button', { name: /^Paper 02/ }));
  await waitFor(() => expect(document.querySelectorAll('.flyout-side')).toHaveLength(2));
  // Paper 01 the one used last, its pages drawn.
  act(() =>
    within(screen.getByRole('dialog', { name: 'Paper 01' }))
      .getByRole('heading', { level: 2, name: 'Paper 01' })
      .focus(),
  );
  await waitFor(() =>
    expect(document.querySelectorAll('img[src^="blob:"]').length).toBeGreaterThan(1),
  );
}

describe('Lock', () => {
  it('is in the bar on top only where the vault offers it', async () => {
    at({ sessionLock: false });
    await grid();
    expect(screen.queryByRole('button', { name: 'Lock' })).toBeNull();
  });

  it('lets go of every document beside the list, side by side too, and hides the list and the tray', async () => {
    const state = at();
    await threeOpen();
    fireEvent.click(screen.getByRole('button', { name: 'Lock' }));
    const heading = await lockHeading();
    // The focus on its heading, which says it; the tray coming back said,
    // as something was open.
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByText(/Your open documents come back in the tray\./)).toBeInTheDocument();
    // Nothing of the page: no list, no tray, no document, no bar.
    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Open documents' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('banner')).toBeNull();
    expect(document.body).not.toHaveTextContent('Paper 0');
    // No picture of a page left, and every one made let go of.
    expect(document.querySelectorAll('img[src^="blob:"]')).toHaveLength(0);
    expect(made.length).toBeGreaterThan(1);
    expect([...revoked].sort()).toEqual([...made].sort());
    // The vault was asked to keep it.
    await waitFor(() =>
      expect(state.calls.some((c) => c.method === 'POST' && c.url === '/api/v1/auth/lock')).toBe(
        true,
      ),
    );
    expect(state.locked).toBe(true);
    // What is kept for the tray: the one in front, and none side by side.
    const kept = JSON.parse(sessionStorage.getItem(flyoutsKey('me')) ?? '{}') as {
      front?: string;
      side?: string[];
      items?: Array<{ id: string }>;
    };
    expect(kept.front).toBe('doc-1');
    expect(kept.side).toBeUndefined();
    expect(kept.items?.map((i) => i.id)).toEqual(['doc-3', 'doc-2', 'doc-1']);
    // The window's title names no page.
    expect(document.title).toBe('Locked – Family Document Vault');
    await expectAccessible();
  });

  it('one confirmation brings it back: the one in front opened again, the others in the tray', async () => {
    const state = at();
    await threeOpen();
    const before = fetched(state, 'doc-1');
    fireEvent.click(screen.getByRole('button', { name: 'Lock' }));
    await lockHeading();
    // A wrong password first: said, and still locked.
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'not it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("That didn't match. Try again.");
    expect(screen.queryByRole('grid')).toBeNull();
    fireEvent.change(screen.getByLabelText('Your password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await grid();
    // The focus to the page's heading, once it is drawn again.
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'Documents' })).toHaveFocus(),
    );
    expect(state.unlocks).toEqual([{ password: 'not it' }, { password: 'correct horse battery' }]);
    // The one in front, opened again; the others freed, in the tray.
    const front = await screen.findByRole('dialog', { name: 'Paper 01' });
    expect(fetched(state, 'doc-1')).toBe(before + 1);
    expect(document.querySelectorAll('.flyout-side')).toHaveLength(0);
    expect(front).toBeVisible();
    expect(within(tray()).getAllByRole('button', { name: /, freed/ })).toHaveLength(2);
    expect(localStorage.getItem(LOCK_HINT_KEY)).toBeNull();
    expect(localStorage.getItem(LOCK_PENDING_KEY)).toBeNull();
    expect(document.title).toBe('Documents – Family Document Vault');
  });

  it('with nothing open, says nothing of the tray', async () => {
    at();
    await grid();
    fireEvent.click(screen.getByRole('button', { name: 'Lock' }));
    await lockHeading();
    expect(screen.getByText('Nothing in it is shown until you confirm it’s you.')).toBeVisible();
    expect(screen.queryByText(/come back in the tray/)).toBeNull();
  });

  it('too many tries are said in the words of confirming it’s you', async () => {
    at({
      refuseWith: (method, path) =>
        method === 'POST' && path === '/api/v1/auth/unlock'
          ? {
              status: 429,
              code: 'sign_in_throttled',
              message: 'Too many tries to sign in. Sign in with a passkey, or wait.',
              retryAfter: 60,
            }
          : undefined,
    });
    await grid();
    fireEvent.click(screen.getByRole('button', { name: 'Lock' }));
    await lockHeading();
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'not it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    const said = await screen.findByRole('alert');
    expect(said).toHaveTextContent('Too many tries just now. Try again in 60 seconds.');
    expect(said).not.toHaveTextContent(/sign in/i);
  });

  it('notes not saved are asked about first, and let go of as it locks', async () => {
    const state = at();
    await grid();
    sessionStorage.setItem(
      'fdv.note-draft.hh.me.doc-1',
      JSON.stringify({ text: 'half a thought' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Lock' }));
    const ask = await screen.findByRole('alertdialog', {
      name: 'Lock, and let go of notes not saved?',
    });
    fireEvent.click(within(ask).getByRole('button', { name: 'Keep writing' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(state.locked).toBeUndefined();
    expect(sessionStorage.getItem('fdv.note-draft.hh.me.doc-1')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Lock' }));
    fireEvent.click(
      within(
        await screen.findByRole('alertdialog', { name: 'Lock, and let go of notes not saved?' }),
      ).getByRole('button', { name: 'Lock' }),
    );
    await lockHeading();
    expect(sessionStorage.getItem('fdv.note-draft.hh.me.doc-1')).toBeNull();
    await waitFor(() => expect(state.locked).toBe(true));
  });

  it('a code used already is said so, in the vault’s words', async () => {
    at({ twoStep: true });
    await grid();
    fireEvent.click(screen.getByRole('button', { name: 'Lock' }));
    await lockHeading();
    const field = await screen.findByLabelText('Or a code from your authenticator app');
    fireEvent.change(field, { target: { value: '654320' } });
    fireEvent.submit(field.closest('form') as HTMLFormElement);
    expect(await screen.findByRole('alert')).toHaveTextContent('That code was used already.');
    fireEvent.change(field, { target: { value: '123456' } });
    fireEvent.submit(field.closest('form') as HTMLFormElement);
    await grid();
  });

  it('a 423 from any call shows the lock screen: another tab locked it', async () => {
    const state = at();
    await open(1);
    // Locked elsewhere: the next call is answered 423.
    state.locked = true;
    fireEvent.click(within(await grid()).getByRole('link', { name: 'Paper 02' }));
    await lockHeading();
    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    // Kept for every tab once the vault has said it is locked.
    await waitFor(() => expect(localStorage.getItem(LOCK_HINT_KEY)).toBe('me'));
  });

  it('a late 423, the vault unlocked meanwhile: the lock screen goes, nothing is locked again', async () => {
    const state = at();
    await open(1);
    // Answered 423 once, as if from before another tab unlocked it.
    let once = true;
    state.refuseWith = (_method, path) => {
      if (!once || path !== '/api/v1/documents/doc-2') return undefined;
      once = false;
      return { status: 423, code: 'session_locked', message: 'The vault is locked.' };
    };
    fireEvent.click(within(await grid()).getByRole('link', { name: 'Paper 02' }));
    await lockHeading();
    // Never kept for the other tabs on a 423 alone.
    expect(localStorage.getItem(LOCK_HINT_KEY)).toBeNull();
    await grid();
    expect(state.calls.some((c) => c.method === 'POST' && c.url === '/api/v1/auth/lock')).toBe(
      false,
    );
    expect(state.locked).toBeUndefined();
    expect(localStorage.getItem(LOCK_HINT_KEY)).toBeNull();
  });

  it('a reload of a locked session shows the lock screen at once, asking for no document', async () => {
    localStorage.setItem(LOCK_HINT_KEY, 'me');
    const state = at({ locked: true });
    await lockHeading();
    await waitFor(() => expect(state.calls.some((c) => c.url === '/api/v1/me')).toBe(true));
    expect(state.calls.filter((c) => c.url.startsWith('/api/v1/documents'))).toEqual([]);
    expect(screen.queryByRole('grid')).toBeNull();
  });

  it('a lock asked for here and not yet taken is sent again as the screen is drawn', async () => {
    localStorage.setItem(LOCK_HINT_KEY, 'me');
    localStorage.setItem(LOCK_PENDING_KEY, 'me');
    const state = at({ locked: false });
    await lockHeading();
    await waitFor(() => expect(state.locked).toBe(true));
    await waitFor(() => expect(localStorage.getItem(LOCK_PENDING_KEY)).toBeNull());
    expect(screen.queryByRole('grid')).toBeNull();
  });

  it('a note of a lock the vault says is not there, and none asked for: the page comes back', async () => {
    localStorage.setItem(LOCK_HINT_KEY, 'me');
    const state = at({ locked: false });
    await lockHeading();
    await grid();
    expect(localStorage.getItem(LOCK_HINT_KEY)).toBeNull();
    expect(state.calls.some((c) => c.method === 'POST' && c.url === '/api/v1/auth/lock')).toBe(
      false,
    );
  });

  it('Lock pressed offline is locked here at once, and sent once the browser is back online', async () => {
    const state = at();
    await grid();
    state.offline = true;
    fireEvent.click(screen.getByRole('button', { name: 'Lock' }));
    await lockHeading();
    expect(screen.queryByRole('grid')).toBeNull();
    await waitFor(() => expect(localStorage.getItem(LOCK_PENDING_KEY)).toBe('me'));
    expect(state.locked).toBeUndefined();
    state.offline = false;
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => expect(state.locked).toBe(true));
    await waitFor(() => expect(localStorage.getItem(LOCK_PENDING_KEY)).toBeNull());
    // And kept locked: still the lock screen.
    expect(screen.getByRole('heading', { level: 1, name: 'The vault is locked' })).toBeVisible();
  });

  it('another tab unlocking it unlocks this one', async () => {
    const state = at();
    await grid();
    fireEvent.click(screen.getByRole('button', { name: 'Lock' }));
    await lockHeading();
    state.locked = false;
    act(() => {
      localStorage.removeItem(LOCK_HINT_KEY);
      window.dispatchEvent(new StorageEvent('storage', { key: LOCK_HINT_KEY, newValue: null }));
    });
    await grid();
  });

  it('signing out from the lock screen goes to the sign-in page', async () => {
    const state = at();
    await grid();
    fireEvent.click(screen.getByRole('button', { name: 'Lock' }));
    await lockHeading();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('button', { name: 'Sign in' });
    expect(window.location.pathname).toBe('/sign-in');
    expect(state.calls.some((c) => c.method === 'POST' && c.url === '/api/v1/auth/logout')).toBe(
      true,
    );
    expect(localStorage.getItem('fdv.session')).toBeNull();
    expect(localStorage.getItem(LOCK_HINT_KEY)).toBeNull();
    expect(sessionStorage.getItem(flyoutsKey('me'))).toBeNull();
  });
});
