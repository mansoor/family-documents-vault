import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserRouter } from 'react-router';
import { App } from './App.js';
import { AppProvider } from './app-context.js';
import { FlyoutProvider, useChangesBeside, useFlyouts, type Flyouts } from './flyout-context.js';
import { flyoutsKey, FREE_AFTER_MS, SWEEP_EVERY_MS } from './flyout-store.js';
import { setShortcutsOn } from './shortcuts.js';
import { fresh, installFakeApi, ME, PASSPORT, signedIn, type FakeState } from './test-api.js';

/**
 * Documents beside the list (flyouts): a row of the Documents table opens
 * its document over the list, which stays; the tray at the right edge
 * holds every one open; Esc minimises, × closes; ten at most, a warning
 * from the 8th; minimised 15 minutes, freed; kept for a reload in this
 * tab; and below 700 px, across the screen with "N open" for the tray.
 */

const WIDE = 1280;
const PHONE = 375;

let width = WIDE;
function atWidth(px: number) {
  width = px;
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

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, '', '/');
  // jsdom has no object URLs: a page's picture is its own blob: address.
  let made = 0;
  Object.assign(URL, {
    createObjectURL: vi.fn(() => `blob:page-${++made}`),
    revokeObjectURL: vi.fn(),
  });
});
afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia');
  vi.useRealTimers();
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

/** The Documents table with `n` papers, at `px` wide. */
function at(n = 3, px = WIDE, path = '/documents'): FakeState {
  atWidth(px);
  const state = fresh({
    members: [ME],
    documents: Array.from({ length: n }, (_, i) => doc(i + 1)),
    collections: [],
  });
  installFakeApi(state);
  signedIn('owner');
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

const grid = () => screen.findByRole('grid', { name: /^Documents, sorted by/ });
const tray = () => screen.getByRole('navigation', { name: 'Open documents' });
const fetched = (state: FakeState, id: string) =>
  state.calls.filter((c) => c.method === 'GET' && c.url === `/api/v1/documents/${id}`).length;
const pagesOf = (state: FakeState, n: number) =>
  state.calls.filter((c) => c.url.startsWith(`/api/v1/versions/v-${n}/pages/`)).length;

/** Opens a paper from the table, as a plain click on its name; its flyout, once loaded. */
async function open(n: number) {
  const name = `Paper ${String(n).padStart(2, '0')}`;
  const link = await within(await grid()).findByRole('link', { name });
  act(() => link.focus());
  fireEvent.click(link);
  return screen.findByRole('dialog', { name });
}

describe('a document beside the list', () => {
  it('opens over the list, which stays; its heading has the focus; a dialog, not modal', async () => {
    at();
    const aside = await open(1);
    expect(aside).toHaveAttribute('aria-modal', 'false');
    expect(window.location.pathname).toBe('/documents');
    await waitFor(() =>
      expect(within(aside).getByRole('heading', { level: 2, name: 'Paper 01' })).toHaveFocus(),
    );
    // The list is still there, and so is the tray.
    expect(await grid()).toBeInTheDocument();
    expect(within(tray()).getByRole('button', { name: 'Paper 01, showing' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    // Its own buttons: Hide details next to Edit, then Open as a page,
    // Minimise and Close.
    expect(within(aside).getByRole('link', { name: 'Open as a page' })).toHaveAttribute(
      'href',
      '/documents/doc-1',
    );
    const hide = within(aside).getByRole('button', { name: 'Hide details' });
    expect(hide).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(hide);
    expect(within(aside).getByRole('button', { name: 'Show details' })).toBeInTheDocument();
    expect(aside.querySelector('.doc-fit-content')).not.toBeNull();
    // With another minimised in the tray too.
    await open(2);
    await expectAccessible();
  });

  it('Minimise and Esc put it in the tray, the focus back on its row; × closes it', async () => {
    at();
    const aside = await open(1);
    const row = await within(await grid()).findByRole('link', { name: 'Paper 01' });
    fireEvent.click(within(aside).getByRole('button', { name: 'Minimise Paper 01' }));
    expect(screen.queryByRole('dialog', { name: 'Paper 01' })).toBeNull();
    // Still drawn, out of sight and out of reach.
    expect(aside).not.toBeVisible();
    expect(aside).toHaveAttribute('inert');
    await waitFor(() => expect(row).toHaveFocus());
    expect(within(tray()).getByRole('button', { name: 'Paper 01, minimised' })).toBeInTheDocument();

    // Back from the tray, then Esc: minimised again, never closed.
    fireEvent.click(within(tray()).getByRole('button', { name: 'Paper 01, minimised' }));
    const again = await screen.findByRole('dialog', { name: 'Paper 01' });
    await waitFor(() =>
      expect(within(again).getByRole('heading', { level: 2, name: 'Paper 01' })).toHaveFocus(),
    );
    fireEvent.keyDown(within(again).getByRole('heading', { level: 2, name: 'Paper 01' }), {
      key: 'Escape',
    });
    expect(screen.queryByRole('dialog', { name: 'Paper 01' })).toBeNull();
    expect(within(tray()).getByRole('button', { name: 'Paper 01, minimised' })).toBeInTheDocument();
    await waitFor(() => expect(row).toHaveFocus());

    // × closes it: out of the tray, the focus on its row.
    fireEvent.click(within(tray()).getByRole('button', { name: 'Paper 01, minimised' }));
    const third = await screen.findByRole('dialog', { name: 'Paper 01' });
    fireEvent.click(within(third).getByRole('button', { name: 'Close Paper 01' }));
    expect(screen.queryByRole('navigation', { name: 'Open documents' })).toBeNull();
    await waitFor(() => expect(row).toHaveFocus());
    expect(document.querySelector('[data-flyouts-said]')).toHaveTextContent('“Paper 01” closed.');
  });

  it('going back to one minimised fetches nothing again: no second look in Activity', async () => {
    const state = at();
    await open(1);
    await waitFor(() => expect(pagesOf(state, 1)).toBeGreaterThan(0));
    const looks = pagesOf(state, 1);
    await open(2);
    expect(within(tray()).getByRole('button', { name: 'Paper 01, minimised' })).toBeInTheDocument();
    fireEvent.click(within(tray()).getByRole('button', { name: 'Paper 01, minimised' }));
    await screen.findByRole('dialog', { name: 'Paper 01' });
    fireEvent.click(within(tray()).getByRole('button', { name: 'Paper 02, minimised' }));
    await screen.findByRole('dialog', { name: 'Paper 02' });
    expect(fetched(state, 'doc-1')).toBe(1);
    expect(fetched(state, 'doc-2')).toBe(1);
    expect(pagesOf(state, 1)).toBe(looks);
  });

  it('every id inside is its own, with two open', async () => {
    at();
    const first = await open(1);
    // A section opened in one opens in the next (beside the list, its own).
    fireEvent.click(await within(first).findByRole('button', { name: /^History/ }));
    await within(first).findByRole('heading', { name: 'History' });
    const second = await open(2);
    await within(second).findByRole('heading', { name: 'History' });
    const ids = [...document.querySelectorAll('[id]')].map((el) => el.id);
    const twice = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(twice).toEqual([]);
    // And what is named by an id is in the same document.
    for (const el of second.querySelectorAll('[aria-labelledby]')) {
      const named = document.getElementById(el.getAttribute('aria-labelledby') ?? '');
      expect(second.contains(named)).toBe(true);
    }
    // The page's own open section is not the flyout's.
    expect(localStorage.getItem('fdv.actions.document.me')).toBeNull();
    expect(localStorage.getItem('fdv.actions.document-flyout.me')).toBe('history');
  });

  it('moved to the Trash from beside the list: closed, and said', async () => {
    at();
    const aside = await open(1);
    fireEvent.click(await within(aside).findByRole('button', { name: 'Move to the Trash' }));
    const sure = await screen.findByRole('alertdialog', { name: 'Move to the Trash?' });
    fireEvent.click(within(sure).getByRole('button', { name: 'Move to the Trash' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Paper 01' })).toBeNull());
    expect(window.location.pathname).toBe('/documents');
    await waitFor(() =>
      expect(document.querySelector('[data-flyouts-said]')).toHaveTextContent(
        '“Paper 01” moved to the Trash. You can bring it back from there.',
      ),
    );
  });

  it('Open as a page goes to its page, and it leaves the tray', async () => {
    at();
    const aside = await open(1);
    fireEvent.click(within(aside).getByRole('link', { name: 'Open as a page' }));
    await screen.findByRole('heading', { level: 1, name: 'Paper 01' });
    expect(window.location.pathname).toBe('/documents/doc-1');
    expect(screen.queryByRole('navigation', { name: 'Open documents' })).toBeNull();
  });

  it('Ctrl or the middle button on a row opens its page elsewhere, never beside the list', async () => {
    at();
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
    const t = await grid();
    const row = (await within(t).findByRole('link', { name: 'Paper 01' })).closest(
      'tr',
    ) as HTMLElement;
    fireEvent.click(within(row).getAllByRole('cell')[2] as HTMLElement, { ctrlKey: true });
    expect(opened).toHaveBeenCalledWith('/documents/doc-1', '_blank', 'noopener');
    fireEvent(
      within(row).getAllByRole('cell')[2] as HTMLElement,
      new MouseEvent('auxclick', { bubbles: true, button: 1 }),
    );
    expect(opened).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('the tray', () => {
  it('its × closes one without opening it, the focus kept in the tray; Delete does too', async () => {
    const state = at();
    await open(1);
    await open(2);
    await open(3);
    const t = tray();
    fireEvent.click(within(t).getByRole('button', { name: 'Close Paper 01' }));
    expect(within(t).queryByRole('button', { name: /^Paper 01/ })).toBeNull();
    expect(fetched(state, 'doc-1')).toBe(1);
    await waitFor(() =>
      expect(within(t).getByRole('button', { name: 'Paper 02, minimised' })).toHaveFocus(),
    );
    // Paper 03 is still in front.
    expect(screen.getByRole('dialog', { name: 'Paper 03' })).toBeVisible();
    fireEvent.keyDown(within(t).getByRole('button', { name: 'Paper 02, minimised' }), {
      key: 'Delete',
    });
    expect(within(t).queryByRole('button', { name: /^Paper 02/ })).toBeNull();
    await waitFor(() =>
      expect(within(t).getByRole('button', { name: 'Paper 03, showing' })).toHaveFocus(),
    );
  });

  it('Close all closes every one, the focus on the page', async () => {
    at();
    await open(1);
    await open(2);
    fireEvent.click(within(tray()).getByRole('button', { name: 'Close all' }));
    expect(screen.queryByRole('navigation', { name: 'Open documents' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'Documents' })).toHaveFocus(),
    );
    expect(sessionStorage.getItem(flyoutsKey('me'))).toBeNull();
  });

  it('from the 8th a warning, the count amber; the 11th asks which to close, minimised longest first', async () => {
    at(11);
    for (let n = 1; n <= 7; n++) await open(n);
    expect(screen.queryByText(/Many open documents slow the vault down/)).toBeNull();
    await open(8);
    expect(screen.getByRole('note')).toHaveTextContent(
      '8 documents open. Many open documents slow the vault down',
    );
    expect(tray().querySelector('.tray-count')).toHaveClass('tray-count-warn');
    fireEvent.click(screen.getByRole('button', { name: 'Put this warning away' }));
    expect(screen.queryByRole('note')).toBeNull();
    await open(9);
    await open(10);
    fireEvent.click(within(await grid()).getByRole('link', { name: 'Paper 11' }));
    const ask = await screen.findByRole('dialog', { name: '10 documents are open' });
    expect(ask).toHaveTextContent('To open “Paper 11”, close one of these first.');
    const rows = within(ask).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent(/Paper 01minimised · suggested/);
    expect(rows[9]).toHaveTextContent(/Paper 10showing/);
    fireEvent.click(within(rows[0] as HTMLElement).getByRole('button', { name: 'Close Paper 01' }));
    await screen.findByRole('dialog', { name: 'Paper 11' });
    expect(within(tray()).getAllByRole('listitem')).toHaveLength(10);
    expect(within(tray()).queryByRole('button', { name: /^Paper 01/ })).toBeNull();
  });
});

describe('freeing', () => {
  it('minimised 15 minutes, freed on the clock: nothing of it left but its icon, which opens it again', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const state = at();
    const first = await open(1);
    await waitFor(() => expect(first.querySelector('img[src^="blob:"]')).not.toBeNull());
    await open(2);
    expect(first).not.toBeVisible();
    act(() => {
      vi.advanceTimersByTime(FREE_AFTER_MS - SWEEP_EVERY_MS);
    });
    expect(first).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(2 * SWEEP_EVERY_MS);
    });
    expect(first).not.toBeInTheDocument();
    expect(document.querySelector('[data-flyout="doc-1"]')).toBeNull();
    // Only the one in front has pages drawn.
    for (const img of document.querySelectorAll('img[src^="blob:"]')) {
      expect(img.closest('[data-flyout="doc-2"]')).not.toBeNull();
    }
    const icon = within(tray()).getByRole('button', {
      name: 'Paper 01, freed to save memory, opens again when chosen',
    });
    expect(document.querySelector('[data-flyouts-said]')).toHaveTextContent(
      'A document minimised for 15 minutes was freed to save memory.',
    );
    fireEvent.click(icon);
    await screen.findByRole('dialog', { name: 'Paper 01' });
    expect(fetched(state, 'doc-1')).toBe(2);
  });

  it('and as the tab is shown again (a laptop waking), at once', async () => {
    at();
    await open(1);
    await open(2);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + FREE_AFTER_MS + 1000);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(document.querySelector('[data-flyout="doc-1"]')).toBeNull();
    expect(within(tray()).getByRole('button', { name: /^Paper 01, freed/ })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Paper 02' })).toBeVisible();
  });
});

describe('kept for a reload, and for nobody else', () => {
  it('comes back as tray icons: the one in front opens, the rest freed, their pages never asked for', async () => {
    sessionStorage.setItem(
      flyoutsKey('me'),
      JSON.stringify({
        items: [
          { id: 'doc-1', view: 'both' },
          { id: 'doc-2', view: 'content' },
        ],
        front: 'doc-2',
      }),
    );
    const state = at();
    const front = await screen.findByRole('dialog', { name: 'Paper 02' });
    // Its details as they were: hidden.
    expect(within(front).getByRole('button', { name: 'Show details' })).toBeInTheDocument();
    // The other freed, and not read to be named: unnamed until chosen.
    expect(within(tray()).getByRole('button', { name: /^A document, freed/ })).toBeInTheDocument();
    expect(fetched(state, 'doc-1')).toBe(0);
    expect(pagesOf(state, 1)).toBe(0);
    expect(document.querySelector('[data-flyout="doc-1"]')).toBeNull();
    // Chosen, it opens, and is named.
    fireEvent.click(within(tray()).getByRole('button', { name: /^A document, freed/ }));
    await screen.findByRole('dialog', { name: 'Paper 01' });
    expect(
      await within(tray()).findByRole('button', { name: 'Paper 01, showing' }),
    ).toBeInTheDocument();
  });

  it('one moved to the Trash meanwhile closes as it loads, and says so', async () => {
    sessionStorage.setItem(
      flyoutsKey('me'),
      JSON.stringify({ items: [{ id: 'doc-2', view: 'both' }], front: 'doc-2' }),
    );
    atWidth(WIDE);
    const state = fresh({
      members: [ME],
      documents: [doc(1), { ...doc(2), deleted_at: '2026-11-20T10:00:00Z' }],
      collections: [],
    });
    installFakeApi(state);
    signedIn('owner');
    window.history.replaceState({}, '', '/documents');
    render(<App />);
    await waitFor(() =>
      expect(document.querySelector('[data-flyouts-said]')).toHaveTextContent(
        '“Paper 02” is in the Trash, so it was closed.',
      ),
    );
    expect(screen.queryByRole('navigation', { name: 'Open documents' })).toBeNull();
  });

  it('a sign-out forgets them', async () => {
    at();
    await open(1);
    expect(sessionStorage.getItem(flyoutsKey('me'))).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Your account/ }));
    await act(async () => {
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    });
    await waitFor(() => expect(window.location.pathname).toBe('/sign-in'));
    expect(sessionStorage.getItem(flyoutsKey('me'))).toBeNull();
  });
});

describe('what changes beside the list', () => {
  it('Edit goes to its page and closes it there: the tray keeps no copy from before a save', async () => {
    at();
    const aside = await open(1);
    fireEvent.click(within(aside).getByRole('link', { name: 'Edit' }));
    await waitFor(() => expect(window.location.pathname).toBe('/documents/doc-1/confirm'));
    expect(screen.queryByRole('navigation', { name: 'Open documents' })).toBeNull();
    expect(document.querySelector('[data-flyout="doc-1"]')).toBeNull();
  });

  it('moved to the Trash there, its row goes at once and the list is asked again', async () => {
    const state = at();
    const aside = await open(1);
    const lists = () =>
      state.calls.filter((c) => c.method === 'GET' && c.url.startsWith('/api/v1/documents?'))
        .length;
    const before = lists();
    fireEvent.click(await within(aside).findByRole('button', { name: 'Move to the Trash' }));
    const sure = await screen.findByRole('alertdialog', { name: 'Move to the Trash?' });
    fireEvent.click(within(sure).getByRole('button', { name: 'Move to the Trash' }));
    await waitFor(() =>
      expect(within(screen.getByRole('grid')).queryByRole('link', { name: 'Paper 01' })).toBeNull(),
    );
    await waitFor(() => expect(lists()).toBeGreaterThan(before));
  });

  it('a Sensitive one minimised stays as it was, as any other, until it is freed', async () => {
    atWidth(WIDE);
    const state = fresh({
      members: [ME],
      documents: [{ ...doc(1), sensitive_effective: true }, doc(2)],
      collections: [],
    });
    installFakeApi(state);
    signedIn('owner');
    window.history.replaceState({}, '', '/documents');
    render(<App />);
    const aside = await open(1);
    await waitFor(() => expect(fetched(state, 'doc-1')).toBe(1));
    fireEvent.click(within(aside).getByRole('button', { name: 'Minimise Paper 01' }));
    expect(document.querySelector('[data-flyout="doc-1"]')).not.toBeNull();
    expect(within(tray()).getByRole('button', { name: 'Paper 01, minimised' })).toBeInTheDocument();
    await open(2);
    expect(document.querySelector('[data-flyout="doc-1"]')).not.toBeNull();
    fireEvent.click(within(tray()).getByRole('button', { name: 'Paper 01, minimised' }));
    await screen.findByRole('dialog', { name: 'Paper 01' });
    expect(fetched(state, 'doc-1')).toBe(1);
  });

  it('Alt and a click is a plain click: beside the list, never a new tab', async () => {
    at();
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
    const link = await within(await grid()).findByRole('link', { name: 'Paper 01' });
    fireEvent.click(link, { altKey: true });
    await screen.findByRole('dialog', { name: 'Paper 01' });
    expect(opened).not.toHaveBeenCalled();
  });

  it('the page’s heading, given the focus by Close all, takes it only while it has it', async () => {
    at(3, WIDE, '/');
    const row = await screen.findByRole('button', { name: /^Paper 01/ });
    fireEvent.click(row);
    await screen.findByRole('dialog', { name: 'Paper 01' });
    const h = screen.getByRole('heading', { level: 1 });
    expect(h).not.toHaveAttribute('tabindex');
    fireEvent.click(within(tray()).getByRole('button', { name: 'Close all' }));
    await waitFor(() => expect(h).toHaveFocus());
    expect(h).toHaveAttribute('tabindex', '-1');
    act(() => h.blur());
    expect(h).not.toHaveAttribute('tabindex');
  });
});

describe('keys', () => {
  it('] and [ go to the next and the previous; ? lists the keys', async () => {
    at();
    await open(1);
    await open(2);
    await open(3);
    fireEvent.keyDown(document.body, { key: ']' });
    expect(await screen.findByRole('dialog', { name: 'Paper 01' })).toBeVisible();
    fireEvent.keyDown(document.body, { key: '[' });
    expect(await screen.findByRole('dialog', { name: 'Paper 03' })).toBeVisible();
    fireEvent.keyDown(document.body, { key: 'ArrowUp', altKey: true });
    expect(await screen.findByRole('dialog', { name: 'Paper 02' })).toBeVisible();
    fireEvent.keyDown(document.body, { key: '?' });
    const keys = await screen.findByRole('dialog', { name: 'Keys for open documents' });
    expect(keys).toHaveTextContent(
      'Minimise the open document you are in, or, from the tray, the one in front',
    );
    fireEvent.click(within(keys).getByRole('button', { name: 'Done' }));
  });

  it('turned off in Settings, the keys of one character do nothing; Alt and the arrows still do', async () => {
    setShortcutsOn(false);
    at();
    await open(1);
    await open(2);
    fireEvent.keyDown(document.body, { key: ']' });
    fireEvent.keyDown(document.body, { key: '?' });
    expect(screen.getByRole('dialog', { name: 'Paper 02' })).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Keys for open documents' })).toBeNull();
    fireEvent.keyDown(document.body, { key: 'ArrowDown', altKey: true });
    expect(await screen.findByRole('dialog', { name: 'Paper 01' })).toBeVisible();
    setShortcutsOn(true);
  });

  it('never while typing', async () => {
    at();
    await open(1);
    const field = screen.getByRole('searchbox', { name: 'Search the vault' });
    fireEvent.keyDown(field, { key: 'Escape' });
    fireEvent.keyDown(field, { key: ']' });
    expect(screen.getByRole('dialog', { name: 'Paper 01' })).toBeVisible();
  });
});

describe('narrower than 700 px', () => {
  it('across the screen, and the tray is "N open" with a list', async () => {
    at(3, PHONE);
    fireEvent.click(await screen.findByRole('button', { name: /^Paper 01/ }));
    const aside = await screen.findByRole('dialog', { name: 'Paper 01' });
    expect(aside).toHaveClass('flyout-full');
    expect(screen.queryByRole('navigation', { name: 'Open documents' })).toBeNull();
    fireEvent.click(within(aside).getByRole('button', { name: 'Minimise Paper 01' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Paper 02/ }));
    await screen.findByRole('dialog', { name: 'Paper 02' });
    const pill = screen.getByRole('button', { name: '2 open' });
    fireEvent.click(pill);
    const list = await screen.findByRole('dialog', { name: '2 open' });
    expect(within(list).getByRole('button', { name: /^Paper 01minimised/ })).toBeInTheDocument();
    fireEvent.click(within(list).getByRole('button', { name: 'Close Paper 01' }));
    expect(within(list).queryByRole('button', { name: /^Paper 01/ })).toBeNull();
    fireEvent.click(within(list).getByRole('button', { name: /^Paper 02/ }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '1 open' })).toBeNull());
    expect(screen.getByRole('dialog', { name: 'Paper 02' })).toBeVisible();
  });

  it('nothing behind it is reachable while it covers the screen', async () => {
    at(3, PHONE);
    fireEvent.click(await screen.findByRole('button', { name: /^Paper 01/ }));
    const aside = await screen.findByRole('dialog', { name: 'Paper 01' });
    const main = document.querySelector('.shell-main') as HTMLElement;
    const bar = document.querySelector('.phone-bar') as HTMLElement;
    const bottom = screen.getByRole('navigation', { name: 'Main', hidden: true });
    for (const el of [main, bar, bottom]) expect(el).toHaveAttribute('inert');
    expect(screen.getByRole('button', { name: '1 open' })).not.toHaveAttribute('inert');
    fireEvent.click(within(aside).getByRole('button', { name: 'Minimise Paper 01' }));
    for (const el of [main, bar, bottom]) expect(el).not.toHaveAttribute('inert');
  });

  it('Back puts it in the tray, not off the list; a button leaves no entry behind', async () => {
    at(3, PHONE);
    const entry = () => (window.history.state as { fdvFlyout?: boolean } | null)?.fdvFlyout;
    fireEvent.click(await screen.findByRole('button', { name: /^Paper 01/ }));
    await screen.findByRole('dialog', { name: 'Paper 01' });
    await waitFor(() => expect(entry()).toBe(true));
    act(() => window.history.back());
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Paper 01' })).toBeNull());
    expect(window.location.pathname).toBe('/documents');
    expect(entry()).toBeUndefined();
    expect(screen.getByRole('button', { name: '1 open' })).toBeInTheDocument();
    // Shown again, then minimised by its button: its entry is taken off.
    fireEvent.click(screen.getByRole('button', { name: '1 open' }));
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: '1 open' })).getByRole('button', {
        name: /^Paper 01/,
      }),
    );
    const aside = await screen.findByRole('dialog', { name: 'Paper 01' });
    await waitFor(() => expect(entry()).toBe(true));
    fireEvent.click(within(aside).getByRole('button', { name: 'Minimise Paper 01' }));
    await waitFor(() => expect(entry()).toBeUndefined());
    expect(window.location.pathname).toBe('/documents');
  });
});

describe('the store beside the shell', () => {
  let got: Flyouts | null = null;
  let reloads = 0;
  function Probe() {
    got = useFlyouts();
    useChangesBeside(() => {
      reloads += 1;
    });
    return null;
  }
  function Host(props: { who: string }) {
    return (
      <AppProvider>
        <BrowserRouter>
          <FlyoutProvider memberId={props.who}>
            <Probe />
          </FlyoutProvider>
        </BrowserRouter>
      </AppProvider>
    );
  }

  it('a saved change tells the lists; somebody else signing in hears nothing of the last one', () => {
    installFakeApi(fresh({ members: [ME], documents: [doc(1)] }));
    signedIn('owner');
    reloads = 0;
    const view = render(<Host who="me" />);
    const loaded = { title: 'Paper 01', inTrash: false };
    act(() => got?.open('doc-1', { title: 'Paper 01' }));
    act(() => got?.loaded('doc-1', { ...loaded, stamp: 'a' }));
    expect(reloads).toBe(0);
    // Loaded again as it was: nothing changed.
    act(() => got?.loaded('doc-1', { ...loaded, stamp: 'a' }));
    expect(reloads).toBe(0);
    act(() => got?.loaded('doc-1', { ...loaded, stamp: 'b' }));
    expect(reloads).toBe(1);
    act(() => got?.minimise('doc-1'));
    expect(got?.said?.text).toBe('“Paper 01” minimised to the tray.');
    view.rerender(<Host who="m-2" />);
    expect(got?.said).toBeNull();
    expect(got?.set.items).toEqual([]);
    expect(got?.changes.gone.size).toBe(0);
  });
});
