import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import {
  fresh,
  installFakeApi,
  PASSPORT,
  signedIn,
  STATEMENT,
  type FakeState,
} from './test-api.js';

/**
 * Home's Recent (0.9.0-dev.102): one section with two tabs — what was
 * added, and what this person opened — the one chosen remembered in this
 * browser; and Print in each row's ⋯, as in the Documents table's.
 */

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, '', '/');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function home(over: Partial<FakeState> = {}): FakeState {
  const state = fresh({ documents: [{ ...PASSPORT }, { ...STATEMENT }], ...over });
  installFakeApi(state);
  signedIn('owner');
  render(<App />);
  return state;
}

const recent = () => screen.findByRole('region', { name: 'Recent' });
const tab = (name: 'Added' | 'Opened') => screen.findByRole('tab', { name });
const rowTitles = (region: HTMLElement) =>
  [...region.querySelectorAll('.docrow .doc-title')].map((t) => t.textContent);

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } },
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

describe('Home’s Recent', () => {
  it('is one section, Added first: what Recently added showed, nothing of Opened asked for', async () => {
    const state = home();
    const region = await recent();
    expect(within(region).getByRole('heading', { name: 'Recent' })).toBeVisible();
    const list = within(region).getByRole('tablist', { name: 'Recent' });
    expect(
      within(list)
        .getAllByRole('tab')
        .map((t) => [t.textContent, t.getAttribute('aria-selected')]),
    ).toEqual([
      ['Added', 'true'],
      ['Opened', 'false'],
    ]);
    const panel = within(region).getByRole('tabpanel', { name: 'Added' });
    await waitFor(() =>
      expect(rowTitles(panel)).toEqual([
        "Mansoor's passport",
        'Barclays statement, September 2026',
      ]),
    );
    expect(state.calls.some((c) => c.url.startsWith('/api/v1/me/recently-opened'))).toBe(false);
    // Only Recent: no second section like it.
    expect(screen.queryByRole('heading', { name: 'Recently added' })).toBeNull();
    await expectAccessible();
  });

  it('Opened lists what this person opened, newest first; says so when nothing was', async () => {
    home({ recentlyOpened: ['doc-2', 'doc-1'] });
    fireEvent.click(await tab('Opened'));
    const region = await recent();
    const panel = within(region).getByRole('tabpanel', { name: 'Opened' });
    await waitFor(() =>
      expect(rowTitles(panel)).toEqual([
        'Barclays statement, September 2026',
        "Mansoor's passport",
      ]),
    );
    // Each row's ⋯, as Added's.
    expect(
      within(panel).getByRole('button', {
        name: 'Actions for “Barclays statement, September 2026”',
      }),
    ).toBeVisible();
    await expectAccessible();
  });

  it('says “Loading…” while Opened is on its way, then “Nothing opened yet.” where nothing was opened', async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    home({
      hold: (method, path) =>
        method === 'GET' && path === '/api/v1/me/recently-opened' ? held : undefined,
    });
    fireEvent.click(await tab('Opened'));
    const region = await recent();
    // Its panel, a stop for Tab with or without rows.
    expect(within(region).getByRole('tabpanel', { name: 'Opened' })).toHaveAttribute(
      'tabindex',
      '0',
    );
    expect(await within(region).findByText('Loading…')).toBeVisible();
    expect(within(region).queryByText('Nothing opened yet.')).toBeNull();
    release();
    expect(await within(region).findByText('Nothing opened yet.')).toBeVisible();
    expect(within(region).queryByText('Loading…')).toBeNull();
    expect(rowTitles(region)).toEqual([]);
  });

  it('remembers the tab chosen in this browser, and Home opens on it', async () => {
    const state = home({ recentlyOpened: ['doc-2'] });
    fireEvent.click(await tab('Opened'));
    expect(await tab('Opened')).toHaveAttribute('aria-selected', 'true');
    expect(localStorage.getItem('fdv.home-recent.me')).toBe('opened');
    // Home again, as a reload draws it: on Opened.
    const calls = state.calls.length;
    window.history.replaceState({}, '', '/');
    document.body.innerHTML = '';
    render(<App />);
    expect(await tab('Opened')).toHaveAttribute('aria-selected', 'true');
    const panel = within(await recent()).getByRole('tabpanel', { name: 'Opened' });
    await waitFor(() => expect(rowTitles(panel)).toEqual(['Barclays statement, September 2026']));
    expect(
      state.calls.slice(calls).some((c) => c.url === '/api/v1/me/recently-opened?limit=5'),
    ).toBe(true);
    // Added again: remembered too.
    fireEvent.click(await tab('Added'));
    expect(localStorage.getItem('fdv.home-recent.me')).toBeNull();
  });

  it('moves between its tabs with the arrow keys, Home and End, the focus going with the choice', async () => {
    home();
    const added = await tab('Added');
    const opened = await tab('Opened');
    expect(added).toHaveAttribute('tabindex', '0');
    expect(opened).toHaveAttribute('tabindex', '-1');
    added.focus();
    fireEvent.keyDown(added, { key: 'ArrowRight' });
    expect(opened).toHaveFocus();
    expect(opened).toHaveAttribute('aria-selected', 'true');
    expect(opened).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(opened, { key: 'ArrowRight' });
    expect(added).toHaveFocus();
    fireEvent.keyDown(added, { key: 'End' });
    expect(opened).toHaveFocus();
    fireEvent.keyDown(opened, { key: 'Home' });
    expect(added).toHaveFocus();
    expect(added).toHaveAttribute('aria-selected', 'true');
  });

  it('a document opened from its row is told to the vault, and is first in Opened', async () => {
    const state = home({ recentlyOpened: ['doc-1'] });
    fireEvent.click(await tab('Opened'));
    const region = await recent();
    await waitFor(() => expect(rowTitles(region)).toEqual(["Mansoor's passport"]));
    fireEvent.click(await tab('Added'));
    const row = await within(region).findByRole('button', { name: /^Barclays statement/ });
    fireEvent.click(row);
    await waitFor(() =>
      expect(
        state.calls.filter((c) => c.method === 'POST' && c.url === '/api/v1/me/recently-opened'),
      ).toEqual([expect.objectContaining({ body: { document_id: 'doc-2' } })]),
    );
    expect(state.recentlyOpened).toEqual(['doc-2', 'doc-1']);
  });

  it('a list’s own fetches are never an open', async () => {
    const state = home();
    // Each row's ⋯ fetches nothing that counts; nor does Home's own list.
    const more = await screen.findByRole('button', { name: "Actions for “Mansoor's passport”" });
    fireEvent.click(more);
    await screen.findByRole('menu', { name: "Actions for “Mansoor's passport”" });
    expect(state.calls.some((c) => c.method === 'POST' && c.url.includes('recently-opened'))).toBe(
      false,
    );
  });
});

describe('Print in Home’s ⋯', () => {
  it('is offered beside Download, on both tabs, and Escape gives the focus back to the ⋯', async () => {
    home({ recentlyOpened: ['doc-1'] });
    const name = "Actions for “Mansoor's passport”";
    for (const which of ['Added', 'Opened'] as const) {
      fireEvent.click(await tab(which));
      const panel = within(await recent()).getByRole('tabpanel', { name: which });
      const more = await within(panel).findByRole('button', { name });
      // Pressed, as a click gives it the focus.
      more.focus();
      fireEvent.click(more);
      const menu = await screen.findByRole('menu', { name });
      const items = within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent);
      expect(items.slice(0, 3)).toEqual(['Open', 'Download', 'Print']);
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Print' }));
      const dialog = await screen.findByRole('dialog', { name: "Print “Mansoor's passport”" });
      expect(window.location.pathname).toBe('/');
      fireEvent.keyDown(within(dialog).getByRole('checkbox', { name: 'Its pages' }), {
        key: 'Escape',
      });
      await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Print/ })).toBeNull());
      await waitFor(() => expect(more).toHaveFocus());
    }
  });
});
