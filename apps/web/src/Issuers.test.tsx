import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { fresh, installFakeApi, ME, STATEMENT, signedIn, type FakeState } from './test-api.js';

/**
 * Settings › Who issued it (0.9.0-dev.91): the household's "Same as" list
 * of issuers, kept by owners and adults — what looks like one suggested,
 * with Same and Separate; every issuer with how many papers, the spellings
 * said to be the same as it, each with Separate, and Same as… another.
 */

type Role = 'owner' | 'adult' | 'teen' | 'viewer';
const WIDE = 1280;

function atWidth(px: number) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const min = /\(min-width:\s*(\d+)px\)/.exec(query);
      return {
        matches: Boolean(min) && px >= Number(min?.[1]),
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
  window.history.replaceState({}, '', '/');
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'matchMedia');
  vi.restoreAllMocks();
});

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } },
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

/** Barclays twice, Barclays Bank UK once, HSBC once. */
const PAPERS = [
  { ...STATEMENT, id: 'doc-b1', etag: '"b1"', issued_by: 'Barclays' },
  { ...STATEMENT, id: 'doc-b2', etag: '"b2"', issued_by: 'Barclays' },
  { ...STATEMENT, id: 'doc-b3', etag: '"b3"', issued_by: 'Barclays Bank UK' },
  { ...STATEMENT, id: 'doc-h1', etag: '"h1"', issued_by: 'HSBC' },
];

function at(role: Role, over: Partial<FakeState> = {}): FakeState {
  atWidth(WIDE);
  const state = fresh({
    members: [ME],
    documents: PAPERS.map((d) => ({ ...d })),
    cabinets: true,
    ...over,
  });
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', '/settings/issuers');
  render(<App />);
  return state;
}

describe('Settings › Who issued it', () => {
  it('suggests what looks like one, and joins it with Same, said and listed', async () => {
    const state = at('owner');
    const like = await screen.findByRole('region', { name: 'These look like one' });
    expect(like.textContent).toMatch(
      /“Barclays” \(2 papers\) and “Barclays Bank UK” \(1 paper\) look like one\./,
    );
    const all = screen.getByRole('region', { name: 'Every issuer' });
    expect(within(all).getByText('HSBC', { selector: '.doc-title' })).toBeVisible();
    await expectAccessible();
    fireEvent.click(
      within(like).getByRole('button', { name: 'Same: “Barclays Bank UK” is “Barclays”' }),
    );
    expect(
      await screen.findByText('“Barclays Bank UK” is now the same issuer as “Barclays”.'),
    ).toBeInTheDocument();
    expect(state.issuerChanges).toEqual([
      { how: 'same', from: 'barclays bank uk', to: 'barclays' },
    ]);
    // One issuer now, written two ways; nothing left to suggest.
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'These look like one' })).toBeNull(),
    );
    const members = screen.getByRole('list', { name: 'Also written as, for Barclays' });
    expect(within(members).getByText('Barclays Bank UK')).toBeVisible();
    await expectAccessible();
  });

  it('separates one written another way, and keeps a suggestion apart', async () => {
    const state = at('adult', {
      issuerAliases: [{ from: 'barclays bank uk', to: 'barclays', path: [] }],
    });
    const members = await screen.findByRole('list', { name: 'Also written as, for Barclays' });
    fireEvent.click(
      within(members).getByRole('button', { name: 'Separate “Barclays Bank UK” from “Barclays”' }),
    );
    expect(
      await screen.findByText('“Barclays Bank UK” is separate from “Barclays” again.'),
    ).toBeInTheDocument();
    expect(state.issuerChanges).toEqual([
      { how: 'separate', from: 'barclays bank uk', to: 'barclays' },
    ]);
    expect(state.issuerAliases).toEqual([]);
    // Said separate: not suggested again.
    expect(screen.queryByRole('region', { name: 'These look like one' })).toBeNull();
  });

  it('joins one issuer to another by hand in one sheet, the focus back where it was asked', async () => {
    const state = at('owner');
    const all = await screen.findByRole('region', { name: 'Every issuer' });
    await within(all).findByText('HSBC', { selector: '.doc-title' });
    // One picker for the whole page, not one in every row.
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    const opener = within(all).getByRole('button', { name: 'Same as… for HSBC' });
    opener.focus();
    fireEvent.click(opener);
    const sheet = await screen.findByRole('dialog', { name: '“HSBC” is the same as…' });
    const pick = within(sheet).getByRole('combobox', { name: 'Same as' });
    expect(within(pick).queryByRole('option', { name: /^HSBC/ })).toBeNull();
    expect(within(sheet).getByRole('button', { name: 'Same' })).toBeDisabled();
    await expectAccessible();
    // Escape: closed, nothing changed, the focus back on its button.
    fireEvent.keyDown(sheet, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(state.issuerChanges ?? []).toEqual([]);
    fireEvent.click(opener);
    const again = await screen.findByRole('dialog', { name: '“HSBC” is the same as…' });
    fireEvent.change(within(again).getByRole('combobox', { name: 'Same as' }), {
      target: { value: 'barclays' },
    });
    fireEvent.click(within(again).getByRole('button', { name: 'Same' }));
    await waitFor(() =>
      expect(state.issuerChanges).toEqual([{ how: 'same', from: 'hsbc', to: 'barclays' }]),
    );
    // Read again: HSBC is written another way of Barclays now, and that is said.
    const members = await screen.findByRole('list', { name: 'Also written as, for Barclays' });
    expect(within(members).getByText('HSBC')).toBeVisible();
    expect(screen.getByText('“HSBC” is now the same issuer as “Barclays”.')).toHaveFocus();
  });

  it('is for owners and adults: a teen is told so, and is offered no section', async () => {
    at('teen');
    expect(
      await screen.findByText('Only owners and adults say which issuers are the same.'),
    ).toBeVisible();
    const nav = await screen.findByRole('navigation', { name: 'Settings sections' });
    expect(within(nav).queryByRole('link', { name: /Who issued it/ })).toBeNull();
  });

  it('is in the Household group of the menu for an owner', async () => {
    at('owner');
    const nav = await screen.findByRole('navigation', { name: 'Settings sections' });
    const link = within(nav).getByRole('link', { name: /Who issued it/ });
    expect(link).toHaveAttribute('href', '/settings/issuers');
    expect(link).toHaveAttribute('aria-current', 'page');
  });
});
