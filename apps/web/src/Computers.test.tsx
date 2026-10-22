import type { PairedDevice } from '@fdv/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { pairingAddressCheck } from '@fdv/shared';
import { addressToType } from './screens/Computers.js';
import { fresh, installFakeApi, signedIn, type FakeState } from './test-api.js';

/**
 * Your computers (0.8.0, D1): pairing a computer that sends scans — the
 * section, the code shown large with its countdown and the address, the
 * list, removing one — and an owner's view of everybody's.
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

const computer = (over: Partial<PairedDevice>): PairedDevice => ({
  id: 'd-1',
  name: 'Kitchen laptop',
  platform: 'windows',
  member_id: 'me',
  member_name: 'Mansoor Seikh',
  mine: true,
  added_at: '2026-10-01T09:00:00.000Z',
  last_used_at: '2026-10-12T18:30:00.000Z',
  ...over,
});
const AISHAS = computer({
  id: 'd-2',
  name: 'Aisha’s Mac',
  platform: 'macos',
  member_id: 'm-aisha',
  member_name: 'Aisha',
  mine: false,
  last_used_at: null,
});

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

describe('Your computers (0.8.0, D1)', () => {
  it('is a section of Settings for whoever may add documents, and not for a viewer', async () => {
    at('/settings', { computers: [] }, 'adult');
    const nav = await screen.findByRole('navigation', { name: 'Settings sections' });
    expect(await within(nav).findByRole('link', { name: /Your computers/ })).toHaveAttribute(
      'href',
      '/settings/computers',
    );
    await expectAccessible();
    cleanup();
    at('/settings', { computers: [] }, 'viewer');
    const viewers = await screen.findByRole('navigation', { name: 'Settings sections' });
    await within(viewers).findByRole('link', { name: /Your account/ });
    expect(within(viewers).queryByRole('link', { name: /Your computers/ })).toBeNull();
    cleanup();
    // Typed in by a viewer: who it is for, and nothing of the page.
    at('/settings/computers', { computers: [] }, 'viewer');
    expect(await screen.findByText('This isn’t something you can open.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a computer' })).toBeNull();
  });

  it('a vault that cannot pair computers offers no section', async () => {
    at('/settings', {}, 'owner');
    const nav = await screen.findByRole('navigation', { name: 'Settings sections' });
    await within(nav).findByRole('link', { name: /Your account/ });
    expect(within(nav).queryByRole('link', { name: /Your computers/ })).toBeNull();
  });

  it('asks who is asking, then shows the code large, the address to type, a countdown, and where the uploader comes from', async () => {
    const state = at('/settings/computers', { computers: [], stepUpNeeded: true }, 'adult');
    expect(await screen.findByText('None yet.')).toBeInTheDocument();
    await expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Add a computer' }));
    await screen.findByRole('dialog', { name: 'Just checking it is you' });
    expect(screen.getByText(/to change how you sign in/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Or your password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a computer' });
    expect(state.pairings).toBe(1);
    // The code, once and large, read out a character at a time.
    // The vault's code, and the check of the address the dialog shows.
    const check = pairingAddressCheck('https://vault.example.test');
    expect(check).toMatch(/^[A-Z0-9]{3}$/);
    const code = within(dialog).getByText(`KX7P-3M9Q-${check}`);
    expect(code).toHaveClass('pairing-code');
    // Read a character at a time, as text a screen reader is given; the
    // large code is for the eye.
    expect(code).toHaveAttribute('aria-hidden', 'true');
    expect(code).not.toHaveAttribute('aria-label');
    expect(
      within(dialog).getByText(`Code: K X 7 P 3 M 9 Q ${check.split('').join(' ')}`),
    ).toHaveClass('visually-hidden');
    expect(within(dialog).getByText('https://vault.example.test')).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        'Ask whoever runs your vault for the Family Documents Vault uploader.',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/^\d+:\d\d$/).textContent).toMatch(/^(10:00|9:5\d)$/);
    expect(
      within(dialog).getByText(/once you close this, it cannot be seen again/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Add a computer' })).toHaveFocus(),
    );
    await expectAccessible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The code nobody used is ended as the dialog closes.
    await waitFor(() => expect(state.pairingsEnded).toBe(1));
  });

  it('links to the uploader when the vault says where it is', async () => {
    at(
      '/settings/computers',
      { computers: [], pairing: { download_url: 'https://example.test/uploader' } },
      'teen',
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Add a computer' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a computer' });
    expect(
      within(dialog).getByRole('link', { name: 'download the Family Documents Vault uploader' }),
    ).toHaveAttribute('href', 'https://example.test/uploader');
    await expectAccessible();
  });

  it('a code that has run out says so, and offers a new one', async () => {
    const state = at(
      '/settings/computers',
      { computers: [], pairing: { expires_at: new Date(Date.now() + 1500).toISOString() } },
      'adult',
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Add a computer' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a computer' });
    expect(
      await within(dialog).findByText('This code has run out. Make a new one.', undefined, {
        timeout: 4000,
      }),
    ).toBeInTheDocument();
    const check = pairingAddressCheck('https://vault.example.test');
    expect(within(dialog).getByText(`KX7P-3M9Q-${check}`)).toHaveClass('pairing-code-ran');
    state.pairing = {};
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make a new code' }));
    await waitFor(() => expect(state.pairings).toBe(2));
    // Focus goes to the new code, never to nowhere.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByText(`KX7P-3M9Q-${check}`).parentElement,
      ),
    );
    expect(within(dialog).queryByText('This code has run out. Make a new one.')).toBeNull();
    await expectAccessible();
  });

  it('says so once the computer is paired', async () => {
    at(
      '/settings/computers',
      { computers: [], pairedMeanwhile: [computer({ id: 'd-new', name: 'Study PC' })] },
      'adult',
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Add a computer' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a computer' });
    // The vault asked every few seconds while the code is shown: two asks'
    // time, since under a loaded run the first answer can come late.
    expect(
      await within(dialog).findByText(
        '“Study PC” is paired. What it sends arrives in your uploads, a batch a day.',
        undefined,
        { timeout: 30_000 },
      ),
    ).toBeInTheDocument();
    await expectAccessible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(await screen.findByText('Study PC')).toBeInTheDocument();
  }, 45_000);

  it('lists your computers, and removes one after asking', async () => {
    const state = at('/settings/computers', { computers: [computer({})] }, 'adult');
    expect(await screen.findByText('Kitchen laptop')).toBeInTheDocument();
    expect(document.title).toBe('Settings: your computers – Family Document Vault');
    expect(screen.getByText(/Windows · added/)).toBeInTheDocument();
    expect(screen.getByText(/last sent/)).toBeInTheDocument();
    await expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Kitchen laptop' }));
    const asked = await screen.findByRole('alertdialog', { name: 'Remove “Kitchen laptop”?' });
    expect(within(asked).getByText(/It can no longer send scans/)).toBeInTheDocument();
    await expectAccessible();
    fireEvent.click(within(asked).getByRole('button', { name: 'Remove' }));
    expect(
      await screen.findByText('“Kitchen laptop” was removed. It can no longer send scans.'),
    ).toBeInTheDocument();
    expect(state.computers).toEqual([]);
    expect(
      state.calls.some((c) => c.method === 'DELETE' && c.url === '/api/v1/paired-devices/d-1'),
    ).toBe(true);
    expect(await screen.findByText('None yet.')).toBeInTheDocument();
  });

  it('an owner sees everybody’s by name and person, never what one sent, and may remove any', async () => {
    const state = at('/settings/computers', { computers: [computer({}), AISHAS] }, 'owner');
    const others = await screen.findByRole('region', { name: 'Everybody else’s' });
    expect(within(others).getByText('Aisha’s Mac')).toBeInTheDocument();
    expect(within(others).getByText(/Aisha · Mac · added/)).toBeInTheDocument();
    expect(within(others).queryByText(/last sent/)).toBeNull();
    await expectAccessible();
    fireEvent.click(within(others).getByRole('button', { name: 'Remove Aisha’s Aisha’s Mac' }));
    const asked = await screen.findByRole('alertdialog');
    fireEvent.click(within(asked).getByRole('button', { name: 'Remove' }));
    expect(
      await screen.findByText(
        'Aisha’s computer “Aisha’s Mac” was removed. It can no longer send scans.',
      ),
    ).toBeInTheDocument();
    expect(state.computers?.map((d) => d.id)).toEqual(['d-1']);
  });

  it('an adult sees their own alone', async () => {
    at('/settings/computers', { computers: [computer({}), AISHAS] }, 'adult');
    expect(await screen.findByText('Kitchen laptop')).toBeInTheDocument();
    expect(screen.queryByText('Aisha’s Mac')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Everybody else’s' })).toBeNull();
  });
});

describe('the address the app is told', () => {
  it('is the vault’s, unless that names this computer while the page is somewhere else', () => {
    expect(addressToType('https://vault.example.test', 'https://vault.example.test')).toBe(
      'https://vault.example.test',
    );
    expect(addressToType('http://localhost:8080', 'http://192.168.1.20:8080')).toBe(
      'http://192.168.1.20:8080',
    );
    expect(addressToType('http://localhost:8080', 'http://localhost:8080')).toBe(
      'http://localhost:8080',
    );
  });
});
