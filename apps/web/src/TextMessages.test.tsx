import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  SMS_CLOUD_URL,
  SMS_CLOUD_WARNING,
  type Capabilities,
  type Role,
  type SmsSettingsView,
} from '@fdv/shared';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { settingsGroups } from './settings-sections.js';
import { AISHA, fresh, installFakeApi, ME, signedIn, type FakeState } from './test-api.js';

/**
 * Text messages (0.9.0, SMS1), on the web: Settings → Server and reading →
 * Text messages, an owner's — how the vault reaches SMS Gate, its sign-in,
 * the country and the month's limit; saved, then a test that must go — and
 * a person's mobile number on their profile, confirmed by a code texted to
 * it, removed only once asked.
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

const NOT_SET_UP: SmsSettingsView = {
  settings: null,
  ready: false,
  sent_this_month: 0,
  monthly_cap: 200,
  cloud_url: SMS_CLOUD_URL,
};

const WORKING: SmsSettingsView = {
  settings: {
    mode: 'local',
    base_url: 'http://192.168.1.20:8080',
    username: 'sms',
    password: 'set',
    country: 'GB',
    monthly_cap: 200,
    status: 'ok',
    last_verified_at: '2026-11-11T10:00:00.000Z',
    last_error: null,
    updated_at: '2026-11-11T10:00:00.000Z',
  },
  ready: true,
  sent_this_month: 3,
  monthly_cap: 200,
  cloud_url: SMS_CLOUD_URL,
};

function at(
  path: string,
  over: Partial<FakeState>,
  role: 'owner' | 'adult' | 'teen' | 'viewer' = 'owner',
) {
  const state = fresh({ members: [{ ...ME, role }, AISHA], ...over });
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

describe('Settings → Text messages (SMS1)', () => {
  it('is an owner’s section, beside the others of the server, on a vault that offers it', async () => {
    const caps = { features: { sms_texts: true } } as unknown as Capabilities;
    const server = (role: Role, c: Capabilities | null = caps) =>
      settingsGroups(role, c, role === 'owner')
        .find((g) => g.key === 'server')
        ?.sections.map((s) => [s.label, s.to]);
    expect(server('owner')).toContainEqual(['Text messages', '/settings/texts']);
    // An older vault, which cannot send texts: not offered.
    expect(server('owner', null)).not.toContainEqual(['Text messages', '/settings/texts']);
    expect(server('adult')).toBeUndefined();
    at('/settings/texts', { sms: { view: NOT_SET_UP } });
    expect(await screen.findByRole('heading', { level: 1, name: 'Text messages' })).toBeVisible();
    cleanup();
    at('/settings/texts', { sms: { view: NOT_SET_UP } }, 'adult');
    expect(await screen.findByText('Only an owner can set up text messages.')).toBeVisible();
  });

  it('sets up the local server, then a test that must go turns texts on', async () => {
    const state = at('/settings/texts', { sms: { view: { ...NOT_SET_UP } } });
    expect(await screen.findByTestId('sms-status')).toHaveTextContent(
      'Not set up. Fill in the form, save, then send a test.',
    );
    expect(screen.getByText('0 of 200 texts sent this month.')).toBeVisible();
    expect(
      screen.getByRole('radio', { name: 'Local server on your network — recommended' }),
    ).toBeChecked();
    // The password is asked for first.
    fireEvent.change(screen.getByLabelText('Address'), {
      target: { value: 'http://192.168.1.20:8080' },
    });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'sms' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Type the password the SMS Gate app shows.',
    );
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'gate-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('Saved. Now send a test: no text is sent until one goes.'),
    ).toBeVisible();
    expect(state.sms?.saves).toEqual([
      {
        mode: 'local',
        base_url: 'http://192.168.1.20:8080',
        username: 'sms',
        password: 'gate-secret',
        country: 'GB',
        monthly_cap: 200,
      },
    ]);
    expect(screen.getByTestId('sms-status')).toHaveTextContent('Saved, not yet tested.');
    // The password is never shown again.
    expect(screen.getByLabelText('Password')).toHaveValue('');

    fireEvent.change(screen.getByLabelText('Mobile number'), {
      target: { value: '07700 900123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send a test' }));
    expect(await screen.findByText('The test text went.')).toBeVisible();
    expect(state.sms?.tested).toEqual(['07700 900123']);
    await waitFor(() => expect(screen.getByTestId('sms-status')).toHaveTextContent(/^Working\./));
    await expectAccessible();
  });

  it('warns of the cloud relay, and sends to its address alone', async () => {
    const state = at('/settings/texts', { sms: { view: { ...NOT_SET_UP } } });
    fireEvent.click(await screen.findByRole('radio', { name: 'SMS Gate cloud' }));
    expect(screen.getByText(SMS_CLOUD_WARNING)).toBeVisible();
    expect(screen.queryByLabelText('Address')).toBeNull();
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'ABCD' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/^Saved\./);
    expect(state.sms?.saves?.[0]).toMatchObject({ mode: 'cloud', base_url: null });
  });

  it('says why a test did not go, and turning texts off asks first', async () => {
    at('/settings/texts', {
      sms: {
        view: structuredClone(WORKING),
        test: {
          ok: false,
          state: 'not_sent',
          words: 'SMS Gate refused the username or password.',
        },
      },
    });
    expect(await screen.findByTestId('sms-status')).toHaveTextContent(/^Working\./);
    expect(screen.getByText('3 of 200 texts sent this month.')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Mobile number'), {
      target: { value: '+447700900123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send a test' }));
    expect(await screen.findByText('SMS Gate refused the username or password.')).toBeVisible();
    await waitFor(() =>
      expect(screen.getByTestId('sms-status')).toHaveTextContent(/^Not working: SMS Gate refused/),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Turn off text messages' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Turn off text messages?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    expect(
      await screen.findByText('Removed, with its password. The vault sends no texts now.'),
    ).toBeVisible();
  });
});

describe('a mobile number on a profile (SMS1)', () => {
  it('somebody adds their own, and the code texted to it confirms it', async () => {
    at('/people/me', { sms: { view: structuredClone(WORKING) } }, 'adult');
    const block = await screen.findByRole('region', { name: 'Mobile number' });
    fireEvent.change(within(block).getByLabelText('Mobile number'), {
      target: { value: '07700 900456' },
    });
    fireEvent.click(within(block).getByRole('button', { name: 'Add the number' }));
    expect(await within(block).findByTestId('mobile-masked')).toHaveTextContent('•••• •••456');
    expect(within(block).getByText('· Not confirmed yet')).toBeVisible();
    expect(within(block).getByText(/We texted a 6-digit code to that number/)).toBeVisible();
    fireEvent.change(within(block).getByLabelText('Code from the text'), {
      target: { value: '000000' },
    });
    fireEvent.click(within(block).getByRole('button', { name: 'Confirm' }));
    expect(await within(block).findByRole('alert')).toHaveTextContent('That code isn’t right.');
    fireEvent.change(within(block).getByLabelText('Code from the text'), {
      target: { value: '123456' },
    });
    fireEvent.click(within(block).getByRole('button', { name: 'Confirm' }));
    expect(await within(block).findByText('· Confirmed')).toBeVisible();
    await expectAccessible();
  });

  it('removing it asks first', async () => {
    at('/people/m-0', {
      sms: {
        view: structuredClone(WORKING),
        phones: { 'm-0': { masked: '•••• •••789', confirmed: true, code: '123456' } },
      },
    });
    const block = await screen.findByRole('region', { name: 'Mobile number' });
    expect(await within(block).findByTestId('mobile-masked')).toHaveTextContent('•••• •••789');
    fireEvent.click(within(block).getByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Remove Aisha’s mobile number?',
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(within(block).getByTestId('mobile-masked')).toBeVisible();
    fireEvent.click(within(block).getByRole('button', { name: 'Remove' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }),
    );
    await waitFor(() => expect(within(block).queryByTestId('mobile-masked')).toBeNull());
  });

  it('not set up: an owner is told where to set it up; anybody else sees nothing of it', async () => {
    at('/people/m-0', { sms: { view: { ...NOT_SET_UP } } });
    const block = await screen.findByRole('region', { name: 'Mobile number' });
    expect(
      within(block).getByRole('link', { name: 'Set up text messages in Settings' }),
    ).toHaveAttribute('href', '/settings/texts');
    cleanup();
    at('/people/me', { sms: { view: { ...NOT_SET_UP } } }, 'adult');
    await screen.findByRole('heading', { name: 'Your documents' });
    expect(screen.queryByRole('region', { name: 'Mobile number' })).toBeNull();
  });
});
