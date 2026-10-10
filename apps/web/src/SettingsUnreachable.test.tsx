import { fireEvent, render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { fresh, installFakeApi, signedIn, type FakeState } from './test-api.js';

/**
 * Settings when the vault can't be reached (Phase 6, the small fixes): each
 * panel says so, with a Try again of its own — never "Set up", an empty
 * list or the defaults ticked, as if that were how things are.
 */

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

const UNREACHABLE = /can't reach the vault right now/;

/** Settings at `path`, an owner, the vault out of reach. */
function unreachable(path: string, over: Partial<FakeState> = {}): FakeState {
  const state = fresh({ offline: true, ...over });
  installFakeApi(state);
  signedIn('owner');
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

const tryAgain = (what: string) => screen.findByRole('button', { name: `Try again: ${what}` });

describe('Settings when the vault can’t be reached', () => {
  it('Your account: password, two-step, passkeys and devices each say so, with Try again', async () => {
    const state = unreachable('/settings/account');
    for (const what of ['your password', 'two-step sign-in', 'passkeys', 'signed-in devices']) {
      expect(await tryAgain(what)).toBeVisible();
    }
    expect(screen.getAllByText(UNREACHABLE)).toHaveLength(4);
    // Nothing said as if it were so.
    expect(screen.queryByRole('button', { name: 'Set up two-step sign-in' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change your password' })).toBeNull();
    expect(screen.queryByText('None yet.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a passkey on this device' })).toBeNull();
    const devices = screen.getByRole('heading', { name: 'Signed-in devices' }).closest('section');
    expect(within(devices as HTMLElement).queryByRole('list')).toBeNull();
    await expectAccessible();
    // Reached again: Try again shows each as it is.
    state.offline = false;
    fireEvent.click(await tryAgain('two-step sign-in'));
    expect(await screen.findByText(/^On\. Signing in asks for a code/)).toBeVisible();
    fireEvent.click(await tryAgain('signed-in devices'));
    expect(await within(devices as HTMLElement).findByRole('list')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again: signed-in devices' })).toBeNull();
    fireEvent.click(await tryAgain('passkeys'));
    expect(await screen.findByText('None yet.')).toBeVisible();
    fireEvent.click(await tryAgain('your password'));
    expect(await screen.findByRole('button', { name: 'Change your password' })).toBeVisible();
  });

  it('Notifications: what you want is never the defaults ticked, and where you hear from says so', async () => {
    unreachable('/settings/notifications');
    expect(await tryAgain('what you want')).toBeVisible();
    expect(await tryAgain('where you hear from the vault')).toBeVisible();
    expect(await tryAgain('notifications on this device')).toBeVisible();
    expect(screen.queryByRole('checkbox')).toBeNull();
    await expectAccessible();
  });

  it('Your data: the exports say so, and no export is offered as if the vault were there', async () => {
    unreachable('/settings/data');
    expect(await tryAgain('your exports')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Make an export' })).toBeNull();
    await expectAccessible();
  });

  it('Where email comes from: never an empty form, as if no mail server were set up', async () => {
    unreachable('/settings/email');
    expect(await tryAgain('the mail server')).toBeVisible();
    expect(screen.queryByRole('textbox')).toBeNull();
    await expectAccessible();
  });

  it('Household: the Only me card says so, with Try again', async () => {
    unreachable('/settings/household');
    expect(await tryAgain('Only me documents')).toBeVisible();
    await expectAccessible();
  });

  it('Family: who sees identity details says so, with Try again', async () => {
    unreachable('/settings/family', { identities: {} });
    expect(await tryAgain('who sees identity details')).toBeVisible();
    await expectAccessible();
  });
});
