import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserRouter } from 'react-router';
import { App } from './App.js';
import { AppProvider } from './app-context.js';
import { FlyoutProvider, useChangesBeside, useFlyouts, type Flyouts } from './flyout-context.js';
import { flyoutsKey, FREE_AFTER_MS, paneWidthKey, SWEEP_EVERY_MS } from './flyout-store.js';
import { setShortcutsOn } from './shortcuts.js';
import { fresh, installFakeApi, ME, PASSPORT, signedIn, type FakeState } from './test-api.js';

/**
 * Documents beside the list (flyouts): a row of the Documents table opens
 * its document over the list, which stays; the tray at the right edge
 * holds every one open; Esc minimises, × closes; ten at most, a warning
 * from the 8th; minimised 15 minutes, freed; kept for a reload in this
 * tab; below 700 px, across the screen with "N open" for the tray; and
 * from 1,100 px, two or three side by side.
 */

const WIDE = 1280;
/** Room for three side by side, each at least 300 px (1,600 less the sidebar, tray and list). */
const ROOMY = 1600;
/** Wide enough for one beside the list, not for side by side. */
const LAPTOP = 1000;
const PHONE = 375;

const innerWidthWas = Object.getOwnPropertyDescriptor(window, 'innerWidth');
let width = WIDE;
function atWidth(px: number) {
  width = px;
  // The room side by side is worked out from the window's width.
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
  if (innerWidthWas) Object.defineProperty(window, 'innerWidth', innerWidthWas);
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
      for (const id of (el.getAttribute('aria-labelledby') ?? '').split(/\s+/)) {
        expect(second.contains(document.getElementById(id))).toBe(true);
      }
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

  // About 10 s alone, and past the 15 s default while the whole gate runs at once.
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
  }, 30_000);
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

describe('side by side', () => {
  /** The panes side by side, left to right. */
  const panes = () =>
    [...document.querySelectorAll('.flyout-side')].map((el) => el.getAttribute('data-flyout'));
  /** The one with the green line: the pane used last. */
  const greenLine = () =>
    [...document.querySelectorAll('.flyout-last')].map((el) => el.getAttribute('data-flyout'));
  const bar = () => screen.getByRole('region', { name: 'Side by side' });
  const heading = (name: string) =>
    within(screen.getByRole('dialog', { name })).getByRole('heading', { level: 2, name });
  const nameOf = (id: string) => `Paper ${id.replace('doc-', '').padStart(2, '0')}`;

  /** Opens `a` then `b` from the list, then `a` beside `b` from the picker. */
  async function pair(a: number, b: number) {
    await open(a);
    const front = await open(b);
    fireEvent.click(within(front).getByRole('button', { name: 'Side by side' }));
    const picker = await screen.findByRole('dialog', { name: 'Side by side' });
    const name = `Paper ${String(a).padStart(2, '0')}`;
    fireEvent.click(within(picker).getByRole('button', { name: new RegExp(`^${name}`) }));
    await waitFor(() => expect(heading(name)).toHaveFocus());
  }

  it('the picker offers the open ones; the one chosen goes beside the one in front', async () => {
    at();
    await open(1);
    const front = await open(2);
    const button = within(front).getByRole('button', { name: 'Side by side' });
    expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    fireEvent.click(button);
    const picker = await screen.findByRole('dialog', { name: 'Side by side' });
    expect(picker).toHaveTextContent('Choose a document to show beside “Paper 02”');
    expect(within(picker).getByRole('button', { name: 'Choose from the list' })).toBeVisible();
    // Only the others: Paper 02 is the one showing.
    expect(within(picker).queryByRole('button', { name: /^Paper 02/ })).toBeNull();
    fireEvent.click(within(picker).getByRole('button', { name: /^Paper 01minimised/ }));
    await waitFor(() => expect(heading('Paper 01')).toHaveFocus());
    // Both shown, each a dialog that is not modal, named by its heading.
    for (const name of ['Paper 01', 'Paper 02']) {
      const pane = screen.getByRole('dialog', { name });
      expect(pane).toBeVisible();
      expect(pane).toHaveAttribute('aria-modal', 'false');
    }
    expect(panes()).toEqual(['doc-2', 'doc-1']);
    // The one chosen is the pane used last: the green line, and said so.
    expect(greenLine()).toEqual(['doc-1']);
    expect(screen.getByRole('dialog', { name: 'Paper 01' })).toHaveAccessibleDescription(
      'Used last: a document opened from the list takes its place.',
    );
    expect(within(tray()).getByRole('button', { name: 'Paper 02, showing' })).toBeInTheDocument();
    expect(within(tray()).getByRole('button', { name: 'Paper 01, showing' })).toBeInTheDocument();
    // No Side by side on either now: the bar above them has the rest.
    expect(screen.queryByRole('button', { name: 'Side by side' })).toBeNull();
    // At 1,280 px three would each be under 300 px: no third offered.
    expect(within(bar()).queryByRole('button', { name: 'Add a third' })).toBeNull();
    expect(within(bar()).getByRole('button', { name: 'Scroll together' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    // The focus in the other pane makes it the one used last.
    act(() => heading('Paper 02').focus());
    expect(greenLine()).toEqual(['doc-2']);
  });

  // About 10 s alone, and past the 15 s default while the whole gate runs at once.
  it('Add a third from the list; a document clicked in the list then replaces the pane with the green line', async () => {
    at(5, ROOMY);
    await pair(1, 2);
    fireEvent.click(within(bar()).getByRole('button', { name: 'Add a third' }));
    const picker = await screen.findByRole('dialog', { name: 'Add a third' });
    expect(within(picker).getByText('No other documents are open.')).toBeInTheDocument();
    fireEvent.click(within(picker).getByRole('button', { name: 'Choose from the list' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add a third' })).toBeNull());
    // Said in the one it goes beside, over none of the list's rows.
    expect(
      screen.getByRole('dialog', { name: 'Paper 01' }).querySelector('.flyout-pick'),
    ).toHaveTextContent('Choose a document in the list to show beside this one.');
    expect(document.querySelectorAll('.flyout-pick')).toHaveLength(1);
    // Paper 03 from the list: the third, at the right, the pane used last.
    const third = await open(3);
    await waitFor(() => expect(heading('Paper 03')).toHaveFocus());
    expect(third).toBeVisible();
    expect(document.querySelector('.flyout-pick')).toBeNull();
    expect(panes()).toEqual(['doc-2', 'doc-1', 'doc-3']);
    expect(greenLine()).toEqual(['doc-3']);
    // Three side by side: no fourth offered.
    expect(within(bar()).queryByRole('button', { name: 'Add a third' })).toBeNull();

    // Paper 02 used last, then Paper 04 clicked in the list: in its place.
    act(() => heading('Paper 02').focus());
    expect(greenLine()).toEqual(['doc-2']);
    await open(4);
    expect(panes()).toEqual(['doc-4', 'doc-1', 'doc-3']);
    expect(greenLine()).toEqual(['doc-4']);
    // Nothing else set aside: Paper 02 in the tray, minimised; four open.
    expect(screen.queryByRole('dialog', { name: 'Paper 02' })).toBeNull();
    expect(within(tray()).getByRole('button', { name: 'Paper 02, minimised' })).toBeInTheDocument();
    expect(within(tray()).getAllByRole('listitem')).toHaveLength(4);
    expect(document.querySelector('[data-flyouts-said]')).toHaveTextContent(
      '“Paper 04” replaced “Paper 02”, which is minimised to the tray.',
    );
    // Kept for a reload: which, in their order, ids and views only.
    const kept = JSON.parse(sessionStorage.getItem(flyoutsKey('me')) ?? '{}') as {
      side?: string[];
      front?: string;
    };
    expect(kept.side).toEqual(['doc-4', 'doc-1', 'doc-3']);
    expect(kept.front).toBe('doc-4');
    expect(sessionStorage.getItem(flyoutsKey('me'))).not.toMatch(/Paper/);

    // Every id is its own with three open, and what each names is its own.
    const ids = [...document.querySelectorAll('[id]')].map((el) => el.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    for (const id of ['doc-4', 'doc-1', 'doc-3']) {
      const pane = document.querySelector(`[data-flyout="${id}"]`) as HTMLElement;
      for (const el of pane.querySelectorAll('[aria-labelledby]')) {
        for (const named of (el.getAttribute('aria-labelledby') ?? '').split(/\s+/)) {
          expect(pane.contains(document.getElementById(named))).toBe(true);
        }
      }
      // Its sections are named with its document: no two Notes alike.
      const notes = within(pane).queryByRole('region', { name: /^Notes / });
      if (notes) expect(notes).toHaveAccessibleName(`Notes ${nameOf(id)}`);
    }
    await expectAccessible();
  }, 30_000);

  it('Esc minimises the pane it is in, the others stay; One at a time keeps the one used last', async () => {
    at(3, ROOMY);
    await open(3);
    await pair(1, 2);
    fireEvent.click(within(bar()).getByRole('button', { name: 'Add a third' }));
    const picker = await screen.findByRole('dialog', { name: 'Add a third' });
    fireEvent.click(within(picker).getByRole('button', { name: /^Paper 03/ }));
    await waitFor(() => expect(heading('Paper 03')).toHaveFocus());
    expect(panes()).toEqual(['doc-2', 'doc-1', 'doc-3']);

    // Esc in the middle one: that one alone to the tray.
    act(() => heading('Paper 01').focus());
    fireEvent.keyDown(heading('Paper 01'), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Paper 01' })).toBeNull();
    expect(within(tray()).getByRole('button', { name: 'Paper 01, minimised' })).toBeInTheDocument();
    expect(panes()).toEqual(['doc-2', 'doc-3']);
    // The one now in its place is the pane used last, and has the focus.
    expect(greenLine()).toEqual(['doc-3']);
    await waitFor(() => expect(heading('Paper 03')).toHaveFocus());

    // One at a time: the one used last stays, the other to the tray.
    act(() => heading('Paper 02').focus());
    fireEvent.click(within(bar()).getByRole('button', { name: 'One at a time' }));
    expect(screen.queryByRole('region', { name: 'Side by side' })).toBeNull();
    expect(panes()).toEqual([]);
    expect(screen.getByRole('dialog', { name: 'Paper 02' })).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Paper 03' })).toBeNull();
    expect(within(tray()).getByRole('button', { name: 'Paper 03, minimised' })).toBeInTheDocument();
    await waitFor(() => expect(heading('Paper 02')).toHaveFocus());
    expect(
      within(screen.getByRole('dialog', { name: 'Paper 02' })).getByRole('button', {
        name: 'Side by side',
      }),
    ).toBeInTheDocument();
  });

  it('Scroll together: one page view scrolled, the other follows by its share', async () => {
    at();
    await pair(1, 2);
    const viewOf = (id: string) =>
      document.querySelector<HTMLElement>(`[data-flyout="${id}"] .viewer:not(.viewer-none)`);
    await waitFor(() => expect(viewOf('doc-1')).not.toBeNull());
    await waitFor(() => expect(viewOf('doc-2')).not.toBeNull());
    // jsdom lays nothing out: each view as tall as said, scrolled as set.
    const sized = (el: HTMLElement, scrollHeight: number) => {
      let top = 0;
      Object.defineProperties(el, {
        scrollHeight: { configurable: true, get: () => scrollHeight },
        clientHeight: { configurable: true, get: () => 500 },
        scrollTop: {
          configurable: true,
          get: () => top,
          set: (v: number) => {
            top = v;
          },
        },
      });
      return el;
    };
    const one = sized(viewOf('doc-1') as HTMLElement, 2000); // 1,500 to scroll
    const two = sized(viewOf('doc-2') as HTMLElement, 1000); // 500 to scroll

    // Off: each scrolls on its own.
    one.scrollTop = 300;
    fireEvent.scroll(one);
    expect(two.scrollTop).toBe(0);

    const toggle = within(bar()).getByRole('button', { name: 'Scroll together' });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    // Half of one is half of the other.
    one.scrollTop = 750;
    fireEvent.scroll(one);
    expect(two.scrollTop).toBe(250);
    // What was set there is not followed back.
    fireEvent.scroll(two);
    expect(one.scrollTop).toBe(750);
    // The other way: all the way down.
    two.scrollTop = 500;
    fireEvent.scroll(two);
    expect(one.scrollTop).toBe(1500);
    two.scrollTop = 100;
    fireEvent.scroll(two);
    expect(one.scrollTop).toBe(300);

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    one.scrollTop = 0;
    fireEvent.scroll(one);
    expect(two.scrollTop).toBe(100);
  });

  it('a narrower window takes three back to two, the one used last staying', async () => {
    at(4, ROOMY);
    await open(3);
    await open(4);
    await pair(1, 2);
    fireEvent.click(within(bar()).getByRole('button', { name: 'Add a third' }));
    const picker = await screen.findByRole('dialog', { name: 'Add a third' });
    fireEvent.click(within(picker).getByRole('button', { name: /^Paper 03/ }));
    await waitFor(() => expect(panes()).toEqual(['doc-2', 'doc-1', 'doc-3']));
    act(() => heading('Paper 01').focus());
    act(() => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: WIDE });
      window.dispatchEvent(new Event('resize'));
    });
    // The leftmost not used last goes to the tray.
    expect(panes()).toEqual(['doc-1', 'doc-3']);
    expect(greenLine()).toEqual(['doc-1']);
    expect(within(tray()).getByRole('button', { name: 'Paper 02, minimised' })).toBeInTheDocument();
    expect(within(bar()).queryByRole('button', { name: 'Add a third' })).toBeNull();
  });

  it('a pane replaced leaves the others where they are in the page: the same node, never moved', async () => {
    at(4);
    await pair(1, 2);
    expect(panes()).toEqual(['doc-2', 'doc-1']);
    const kept = document.querySelector('[data-flyout="doc-2"]') as HTMLElement;
    const moved: Node[] = [];
    const watching = new MutationObserver((records) => {
      for (const r of records) moved.push(...r.removedNodes);
    });
    watching.observe(kept.parentElement as HTMLElement, { childList: true });
    // Paper 01, at the right, is the one used last: Paper 03 takes its place.
    await open(3);
    watching.disconnect();
    expect(panes()).toEqual(['doc-2', 'doc-3']);
    expect(document.querySelector('[data-flyout="doc-2"]')).toBe(kept);
    expect(moved).not.toContain(kept);
  });

  it('its own Minimise or × never makes a pane the one used last', async () => {
    at(4, ROOMY);
    await open(3);
    await pair(1, 2);
    fireEvent.click(within(bar()).getByRole('button', { name: 'Add a third' }));
    const picker = await screen.findByRole('dialog', { name: 'Add a third' });
    fireEvent.click(within(picker).getByRole('button', { name: /^Paper 03/ }));
    await waitFor(() => expect(greenLine()).toEqual(['doc-3']));
    // Pressed, focused and clicked: × on the leftmost.
    const x = within(screen.getByRole('dialog', { name: 'Paper 02' })).getByRole('button', {
      name: 'Close Paper 02',
    });
    fireEvent.pointerDown(x);
    act(() => x.focus());
    expect(greenLine()).toEqual(['doc-3']);
    fireEvent.click(x);
    expect(panes()).toEqual(['doc-1', 'doc-3']);
    expect(greenLine()).toEqual(['doc-3']);
    // Minimise likewise.
    const min = within(screen.getByRole('dialog', { name: 'Paper 01' })).getByRole('button', {
      name: 'Minimise Paper 01',
    });
    fireEvent.pointerDown(min);
    act(() => min.focus());
    expect(greenLine()).toEqual(['doc-3']);
  });

  it('choosing from the list: the one showing chosen again still waits; once nothing is in front, a click opens as ever', async () => {
    at(4);
    const one = await open(1);
    fireEvent.click(within(one).getByRole('button', { name: 'Side by side' }));
    const picker = await screen.findByRole('dialog', { name: 'Side by side' });
    fireEvent.click(within(picker).getByRole('button', { name: 'Choose from the list' }));
    await waitFor(() => expect(document.querySelector('.flyout-pick')).not.toBeNull());
    // Paper 01 itself: still waiting for another.
    await open(1);
    expect(document.querySelector('.flyout-pick')).not.toBeNull();
    expect(document.querySelector('[data-flyouts-said]')).toHaveTextContent(
      '“Paper 01” is the one showing: choose another to go beside it.',
    );
    // Minimised by its button: nothing to go beside, so no longer waiting.
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Paper 01' })).getByRole('button', {
        name: 'Minimise Paper 01',
      }),
    );
    expect(document.querySelector('.flyout-pick')).toBeNull();
    // The next click opens as ever, one at a time.
    const two = await open(2);
    expect(two).toBeVisible();
    expect(panes()).toEqual([]);
    // And after the one showing is closed from the tray while waiting.
    fireEvent.click(within(two).getByRole('button', { name: 'Side by side' }));
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Side by side' })).getByRole('button', {
        name: 'Choose from the list',
      }),
    );
    await waitFor(() => expect(document.querySelector('.flyout-pick')).not.toBeNull());
    fireEvent.click(within(tray()).getByRole('button', { name: 'Close Paper 02' }));
    expect(await open(3)).toBeVisible();
    expect(panes()).toEqual([]);
  });

  it('at the 11th, one of those side by side closed: the new one goes beside the other', async () => {
    at(11);
    for (let n = 1; n <= 8; n++) await open(n);
    await pair(9, 10);
    expect(panes()).toEqual(['doc-10', 'doc-9']);
    fireEvent.click(within(await grid()).getByRole('link', { name: 'Paper 11' }));
    const ask = await screen.findByRole('dialog', { name: '10 documents are open' });
    fireEvent.click(within(ask).getByRole('button', { name: 'Close Paper 09' }));
    await screen.findByRole('dialog', { name: 'Paper 11' });
    expect(panes()).toEqual(['doc-10', 'doc-11']);
    expect(greenLine()).toEqual(['doc-11']);
    expect(within(tray()).getAllByRole('listitem')).toHaveLength(10);
  }, 45_000);

  it('a reload puts them back side by side, loaded, the rest freed', async () => {
    sessionStorage.setItem(
      flyoutsKey('me'),
      JSON.stringify({
        items: [
          { id: 'doc-1', view: 'both' },
          { id: 'doc-2', view: 'content' },
          { id: 'doc-3', view: 'both' },
        ],
        front: 'doc-3',
        side: ['doc-3', 'doc-2'],
      }),
    );
    const state = at();
    await screen.findByRole('dialog', { name: 'Paper 03' });
    const two = await screen.findByRole('dialog', { name: 'Paper 02' });
    expect(within(two).getByRole('button', { name: 'Show details' })).toBeInTheDocument();
    expect(panes()).toEqual(['doc-3', 'doc-2']);
    expect(greenLine()).toEqual(['doc-3']);
    expect(within(tray()).getByRole('button', { name: /^A document, freed/ })).toBeInTheDocument();
    expect(fetched(state, 'doc-1')).toBe(0);
  });

  it('not offered below 1,100 px, and a set side by side comes back one at a time', async () => {
    sessionStorage.setItem(
      flyoutsKey('me'),
      JSON.stringify({
        items: [
          { id: 'doc-1', view: 'both' },
          { id: 'doc-2', view: 'both' },
        ],
        front: 'doc-2',
        side: ['doc-1', 'doc-2'],
      }),
    );
    const state = at(3, LAPTOP);
    const front = await screen.findByRole('dialog', { name: 'Paper 02' });
    expect(screen.queryByRole('region', { name: 'Side by side' })).toBeNull();
    expect(panes()).toEqual([]);
    expect(within(tray()).getByRole('button', { name: /^A document, freed/ })).toBeInTheDocument();
    expect(fetched(state, 'doc-1')).toBe(0);
    expect(within(front).queryByRole('button', { name: 'Side by side' })).toBeNull();
    const other = await open(3);
    expect(within(other).queryByRole('button', { name: 'Side by side' })).toBeNull();
    // Kept one at a time from now on.
    expect(sessionStorage.getItem(flyoutsKey('me'))).not.toMatch(/side/);
  });
});

describe('the width of the one beside the list', () => {
  // At 1,600 px with the sidebar at 216: 992 px to start with (62vw), at
  // least 360, and at most 1,068 (the window less the sidebar, the tray
  // and the list's 240 px).
  const START = 992;
  const MAX = 1068;
  const EDGE = 'Width of the document beside the list';
  const edgeOf = (aside: HTMLElement) => within(aside).getByRole('separator', { name: EDGE });
  const chosen = (aside: HTMLElement) => aside.style.getPropertyValue('--flyout-w');
  const kept = () => localStorage.getItem(paneWidthKey('me'));
  const resized = (px: number) =>
    act(() => {
      atWidth(px);
      window.dispatchEvent(new Event('resize'));
    });
  /** Pressed on the edge, as the main button or a finger. */
  const press = (edge: HTMLElement, x: number, pointerId = 1, pointerType = 'mouse') =>
    fireEvent.pointerDown(edge, { pointerId, pointerType, button: 0, buttons: 1, clientX: x });
  /** Moved with it held. */
  const move = (edge: HTMLElement, x: number, pointerId = 1, pointerType = 'mouse') =>
    fireEvent.pointerMove(edge, { pointerId, pointerType, buttons: 1, clientX: x });
  /** Pressed, moved to `x`, and drawn there. */
  async function held(aside: HTMLElement, from: number, x: number, pointerId = 1) {
    const edge = edgeOf(aside);
    press(edge, from, pointerId);
    move(edge, x, pointerId);
    await waitFor(() => expect(chosen(aside)).toBe(`${START + from - x}px`));
    return edge;
  }

  it('its edge facing the list: ← and → in steps, Home and End, Enter back to the usual; kept in this browser', async () => {
    at(3, ROOMY);
    const aside = await open(1);
    const edge = edgeOf(aside);
    expect(edge).toHaveAttribute('aria-orientation', 'vertical');
    expect(edge).toHaveAttribute('tabindex', '0');
    expect(edge).toHaveAttribute('aria-controls', aside.id);
    expect(edge).toHaveAttribute('aria-valuenow', String(START));
    expect(edge).toHaveAttribute('aria-valuemin', '360');
    expect(edge).toHaveAttribute('aria-valuemax', String(MAX));
    expect(edge).toHaveAttribute('aria-valuetext', `${START} pixels wide`);
    expect(chosen(aside)).toBe('');
    await expectAccessible();

    // ← moves the edge left: wider, 16 px; Shift, 64; → narrower.
    fireEvent.keyDown(edge, { key: 'ArrowLeft' });
    expect(edge).toHaveAttribute('aria-valuenow', String(START + 16));
    expect(chosen(aside)).toBe(`${START + 16}px`);
    expect(kept()).toBe(String(START + 16));
    fireEvent.keyDown(edge, { key: 'ArrowRight', shiftKey: true });
    expect(edge).toHaveAttribute('aria-valuenow', String(START + 16 - 64));
    // The limits, and no further.
    fireEvent.keyDown(edge, { key: 'End' });
    expect(edge).toHaveAttribute('aria-valuenow', String(MAX));
    fireEvent.keyDown(edge, { key: 'ArrowLeft' });
    expect(edge).toHaveAttribute('aria-valuenow', String(MAX));
    fireEvent.keyDown(edge, { key: 'Home' });
    expect(edge).toHaveAttribute('aria-valuenow', '360');
    fireEvent.keyDown(edge, { key: 'ArrowRight' });
    expect(edge).toHaveAttribute('aria-valuenow', '360');
    expect(kept()).toBe('360');

    // Enter: the usual width again, nothing kept.
    fireEvent.keyDown(edge, { key: 'Enter' });
    expect(edge).toHaveAttribute('aria-valuenow', String(START));
    expect(chosen(aside)).toBe('');
    expect(kept()).toBeNull();
    // And a double-click.
    fireEvent.keyDown(edge, { key: 'ArrowRight' });
    expect(kept()).toBe(String(START - 16));
    fireEvent.doubleClick(edge);
    expect(edge).toHaveAttribute('aria-valuenow', String(START));
    expect(kept()).toBeNull();

    // Another opened alone has the width chosen too; one minimised has no edge.
    fireEvent.keyDown(edge, { key: 'ArrowRight' });
    const other = await open(2);
    expect(aside).not.toBeVisible();
    expect(within(aside).queryByRole('separator', { name: EDGE, hidden: true })).toBeNull();
    expect(edgeOf(other)).toHaveAttribute('aria-valuenow', String(START - 16));
    expect(chosen(other)).toBe(`${START - 16}px`);
    // Only the number is kept, nothing of any document.
    expect(kept()).toBe(String(START - 16));
    await expectAccessible();
  });

  it('dragged with the pointer: once a frame, straight onto the pane, kept as it lets go; no words chosen on the way', async () => {
    at(3, ROOMY);
    const aside = await open(1);
    const grid1 = await grid();
    const edge = edgeOf(aside);
    const frames = vi.spyOn(window, 'requestAnimationFrame');
    const writes = vi.spyOn(Storage.prototype, 'setItem');

    // Pressed: the page marked (no words chosen), the focus here. Not
    // default-prevented, so a menu open elsewhere still hears the press.
    expect(press(edge, 600)).toBe(true);
    expect(edge).toHaveFocus();
    expect(document.documentElement).toHaveClass('flyout-resizing');
    // Three moves before the next frame: drawn once, with the last.
    for (const x of [590, 570, 550]) move(edge, x);
    expect(frames).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(chosen(aside)).toBe(`${START + 50}px`));
    expect(edge).toHaveAttribute('aria-valuenow', String(START + 50));
    // Nothing kept, nothing of the page drawn again, until it lets go.
    expect(writes.mock.calls.filter(([key]) => key === paneWidthKey('me'))).toEqual([]);
    expect(kept()).toBeNull();
    // Past the widest: held there.
    move(edge, 100);
    fireEvent.pointerUp(edge, { pointerId: 1, pointerType: 'mouse', clientX: 100 });
    expect(document.documentElement).not.toHaveClass('flyout-resizing');
    expect(chosen(aside)).toBe(`${MAX}px`);
    expect(edge).toHaveAttribute('aria-valuenow', String(MAX));
    expect(kept()).toBe(String(MAX));
    // The list is the same list, never drawn again from nothing.
    expect(await grid()).toBe(grid1);

    // A finger too; narrower, to the narrowest and no further.
    press(edge, 300, 7, 'touch');
    move(edge, 1500, 7, 'touch');
    fireEvent.pointerUp(edge, { pointerId: 7, pointerType: 'touch', clientX: 1500 });
    expect(kept()).toBe('360');
    expect(edge).toHaveAttribute('aria-valuenow', '360');

    // A press that never moves chooses nothing; the right button takes no hold.
    localStorage.removeItem(paneWidthKey('me'));
    press(edge, 500, 2);
    fireEvent.pointerUp(edge, { pointerId: 2, pointerType: 'mouse', button: 0, clientX: 500 });
    expect(kept()).toBeNull();
    fireEvent.pointerDown(edge, { pointerId: 3, pointerType: 'mouse', button: 2, clientX: 500 });
    move(edge, 400, 3);
    fireEvent.pointerUp(edge, { pointerId: 3, pointerType: 'mouse', button: 2, clientX: 400 });
    expect(kept()).toBeNull();
    expect(document.documentElement).not.toHaveClass('flyout-resizing');
  });

  it('given up mid-drag — Esc, the pointer cancelled, its capture lost, the window left — as wide as before, and Esc minimises nothing', async () => {
    at(3, ROOMY);
    const aside = await open(1);

    // Esc: back to the usual width, nothing kept, the document still there.
    let edge = await held(aside, 600, 550);
    fireEvent.keyDown(edge, { key: 'Escape' });
    expect(chosen(aside)).toBe('');
    expect(edge).toHaveAttribute('aria-valuenow', String(START));
    expect(document.documentElement).not.toHaveClass('flyout-resizing');
    expect(kept()).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Paper 01' })).toBeVisible();
    // A move after it does nothing.
    move(edge, 400);
    expect(chosen(aside)).toBe('');

    // With a width chosen before: back to that one.
    fireEvent.keyDown(edge, { key: 'ArrowRight' });
    expect(chosen(aside)).toBe(`${START - 16}px`);
    press(edge, 600);
    move(edge, 550);
    await waitFor(() => expect(chosen(aside)).toBe(`${START - 16 + 50}px`));
    fireEvent.pointerCancel(edge, { pointerId: 1, pointerType: 'mouse' });
    expect(chosen(aside)).toBe(`${START - 16}px`);
    expect(edge).toHaveAttribute('aria-valuenow', String(START - 16));
    expect(kept()).toBe(String(START - 16));
    fireEvent.doubleClick(edge);
    expect(kept()).toBeNull();

    // Its capture lost with no release: given up.
    edge = await held(aside, 600, 560, 4);
    fireEvent.lostPointerCapture(edge, { pointerId: 4, pointerType: 'mouse' });
    expect(chosen(aside)).toBe('');
    expect(kept()).toBeNull();

    // The window left mid-drag: given up.
    await held(aside, 600, 570, 5);
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(chosen(aside)).toBe('');
    expect(document.documentElement).not.toHaveClass('flyout-resizing');
    expect(kept()).toBeNull();

    // A mouse moving with no button down: its release was missed; let go there.
    edge = await held(aside, 600, 580, 6);
    fireEvent.pointerMove(edge, { pointerId: 6, pointerType: 'mouse', buttons: 0, clientX: 300 });
    expect(document.documentElement).not.toHaveClass('flyout-resizing');
    expect(chosen(aside)).toBe(`${START + 20}px`);
    expect(kept()).toBe(String(START + 20));
    move(edge, 300, 6);
    expect(chosen(aside)).toBe(`${START + 20}px`);
  });

  it('the edge gone mid-drag (minimised): the pane as wide as before, nothing held', async () => {
    at(3, ROOMY);
    const aside = await open(1);
    await held(aside, 600, 550);
    fireEvent.click(within(aside).getByRole('button', { name: 'Minimise Paper 01' }));
    expect(aside).not.toBeVisible();
    expect(within(aside).queryByRole('separator', { name: EDGE, hidden: true })).toBeNull();
    expect(chosen(aside)).toBe('');
    expect(document.documentElement).not.toHaveClass('flyout-resizing');
    expect(kept()).toBeNull();
    // Back from the tray, as wide as ever.
    fireEvent.click(within(tray()).getByRole('button', { name: 'Paper 01, minimised' }));
    const again = await screen.findByRole('dialog', { name: 'Paper 01' });
    expect(edgeOf(again)).toHaveAttribute('aria-valuenow', String(START));
  });

  it('its frame is cancelled alone: a timer that has the same number still runs', async () => {
    at(3, ROOMY);
    const aside = await open(1);
    const edge = edgeOf(aside);
    const timer = vi.fn();
    const id = window.setTimeout(timer, 30);
    // The frame asked for comes back with the timer's number, and never runs.
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => id);
    const cancelled = vi.spyOn(window, 'cancelAnimationFrame');
    press(edge, 600);
    move(edge, 550);
    fireEvent.pointerCancel(edge, { pointerId: 1, pointerType: 'mouse' });
    expect(cancelled).toHaveBeenCalledWith(id);
    await waitFor(() => expect(timer).toHaveBeenCalledTimes(1));
  });

  it('its widest follows the sidebar folded and opened again', async () => {
    at(3, ROOMY);
    const edge = edgeOf(await open(1));
    expect(edge).toHaveAttribute('aria-valuemax', String(MAX));
    // Folded to its icons (72 px): 144 px more room.
    fireEvent.click(screen.getByRole('button', { name: 'Collapse the sidebar' }));
    await waitFor(() => expect(edge).toHaveAttribute('aria-valuemax', String(MAX + 216 - 72)));
    fireEvent.keyDown(edge, { key: 'End' });
    expect(edge).toHaveAttribute('aria-valuenow', String(MAX + 144));
    // Open again: the room as before, the width chosen held within it.
    fireEvent.click(screen.getByRole('button', { name: 'Expand the sidebar' }));
    await waitFor(() => expect(edge).toHaveAttribute('aria-valuemax', String(MAX)));
    expect(edge).toHaveAttribute('aria-valuenow', String(MAX));
    expect(kept()).toBe(String(MAX + 144));
  });

  it('a set side by side put back after a reload forgets it too', async () => {
    localStorage.setItem(paneWidthKey('me'), '500');
    sessionStorage.setItem(
      flyoutsKey('me'),
      JSON.stringify({
        items: [
          { id: 'doc-1', view: 'both' },
          { id: 'doc-2', view: 'both' },
        ],
        front: 'doc-2',
        side: ['doc-1', 'doc-2'],
      }),
    );
    at(3, ROOMY);
    const bar = await screen.findByRole('region', { name: 'Side by side' });
    await waitFor(() => expect(kept()).toBeNull());
    fireEvent.click(within(bar).getByRole('button', { name: 'One at a time' }));
    const alone = await screen.findByRole('dialog', { name: 'Paper 02' });
    expect(edgeOf(alone)).toHaveAttribute('aria-valuenow', String(START));
    expect(chosen(alone)).toBe('');
  });

  it('remembered for this person in this browser, held within a narrower window and back as it grows', async () => {
    localStorage.setItem(paneWidthKey('me'), '1000');
    localStorage.setItem(paneWidthKey('m-2'), '500');
    at(3, ROOMY);
    const aside = await open(1);
    const edge = edgeOf(aside);
    expect(edge).toHaveAttribute('aria-valuenow', '1000');
    expect(chosen(aside)).toBe('1000px');

    // Narrower: as wide as it can be there, the usual 794 at 1,280 px.
    resized(WIDE);
    expect(edge).toHaveAttribute('aria-valuemax', '794');
    expect(edge).toHaveAttribute('aria-valuenow', '794');
    // The width chosen is not lost: the stylesheet holds the pane within the room.
    expect(kept()).toBe('1000');
    expect(chosen(aside)).toBe('1000px');
    // Wider again, the width chosen is back.
    resized(ROOMY);
    expect(edge).toHaveAttribute('aria-valuenow', '1000');
    expect(edge).toHaveAttribute('aria-valuemax', String(MAX));
  });

  it('side by side forgets it: each pane its share, and one at a time again starts as usual', async () => {
    at(3, ROOMY);
    await open(1);
    const front = await open(2);
    fireEvent.keyDown(edgeOf(front), { key: 'Home' });
    expect(kept()).toBe('360');
    fireEvent.click(within(front).getByRole('button', { name: 'Side by side' }));
    const picker = await screen.findByRole('dialog', { name: 'Side by side' });
    fireEvent.click(within(picker).getByRole('button', { name: /^Paper 01minimised/ }));
    await screen.findByRole('region', { name: 'Side by side' });
    const sides = [...document.querySelectorAll<HTMLElement>('.flyout-side')];
    expect(sides).toHaveLength(2);
    for (const pane of sides) {
      expect(chosen(pane)).toBe('');
      expect(within(pane).queryByRole('separator', { name: EDGE })).toBeNull();
    }
    expect(kept()).toBeNull();
    await expectAccessible();

    fireEvent.click(
      within(screen.getByRole('region', { name: 'Side by side' })).getByRole('button', {
        name: 'One at a time',
      }),
    );
    const alone = await screen.findByRole('dialog', { name: 'Paper 01' });
    expect(edgeOf(alone)).toHaveAttribute('aria-valuenow', String(START));
    expect(chosen(alone)).toBe('');
    expect(kept()).toBeNull();
  });

  it('none narrower than 700 px, where it covers the screen', async () => {
    localStorage.setItem(paneWidthKey('me'), '500');
    at(3, PHONE);
    fireEvent.click(await screen.findByRole('button', { name: /^Paper 01/ }));
    const aside = await screen.findByRole('dialog', { name: 'Paper 01' });
    expect(aside).toHaveClass('flyout-full');
    expect(within(aside).queryByRole('separator', { name: EDGE, hidden: true })).toBeNull();
    expect(chosen(aside)).toBe('');
    // Still kept for a wider window.
    expect(kept()).toBe('500');
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

  it('each person’s width: somebody else signing in has their own, and their choices are theirs', () => {
    installFakeApi(fresh({ members: [ME], documents: [doc(1)] }));
    signedIn('owner');
    localStorage.setItem(paneWidthKey('me'), '500');
    localStorage.setItem(paneWidthKey('m-2'), '700');
    const view = render(<Host who="me" />);
    expect(got?.paneWidth).toBe(500);
    view.rerender(<Host who="m-2" />);
    expect(got?.paneWidth).toBe(700);
    act(() => got?.setPaneWidth(640));
    expect(localStorage.getItem(paneWidthKey('m-2'))).toBe('640');
    expect(localStorage.getItem(paneWidthKey('me'))).toBe('500');
    view.rerender(<Host who="me" />);
    expect(got?.paneWidth).toBe(500);
    localStorage.removeItem(paneWidthKey('m-2'));
    view.rerender(<Host who="m-2" />);
    expect(got?.paneWidth).toBeNull();
  });
});
