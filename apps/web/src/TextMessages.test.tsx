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

describe('Settings → Text messages through Twilio (0.9.0-dev.71)', () => {
  const SID = `AC${'0123456789abcdef'.repeat(2)}`;
  const MG = `MG${'fedcba9876543210'.repeat(2)}`;
  const TWILIO_WORKING: SmsSettingsView = {
    ...WORKING,
    settings: {
      ...(WORKING.settings as NonNullable<SmsSettingsView['settings']>),
      provider: 'twilio',
      mode: null,
      base_url: null,
      username: null,
      password: 'not_set',
      twilio: {
        account_sid: SID,
        auth_token: 'set',
        from: '+447700900999',
        messaging_service_sid: null,
      },
    },
  };

  it('chooses Twilio, asks for its Auth Token, says who pays, then a test turns texts on', async () => {
    const state = at('/settings/texts', { sms: { view: { ...NOT_SET_UP } } });
    expect(await screen.findByRole('radio', { name: 'SMS Gate for Android' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: 'Twilio' }));
    // SMS Gate's own fields go; Twilio's come, with who pays for the texts.
    expect(screen.queryByLabelText('Address')).toBeNull();
    expect(screen.queryByLabelText('Username')).toBeNull();
    expect(screen.getByTestId('sms-twilio-costs')).toHaveTextContent(
      /Twilio charges your own Twilio account for every text/,
    );
    fireEvent.change(screen.getByLabelText('Account SID'), { target: { value: 'AC123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Type the Account SID/);
    fireEvent.change(screen.getByLabelText('Account SID'), { target: { value: SID } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Type the Auth Token the Twilio Console shows.',
    );
    fireEvent.change(screen.getByLabelText('Auth Token'), { target: { value: 'tw-token' } });
    fireEvent.change(screen.getByLabelText('From number'), {
      target: { value: '+44 7700 900999' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('Saved. Now send a test: no text is sent until one goes.'),
    ).toBeVisible();
    expect(state.sms?.saves).toEqual([
      {
        provider: 'twilio',
        account_sid: SID,
        auth_token: 'tw-token',
        from: '+447700900999',
        messaging_service_sid: null,
        country: 'GB',
        monthly_cap: 200,
      },
    ]);
    // The token is never shown again.
    expect(screen.getByLabelText('Auth Token')).toHaveValue('');
    expect(screen.getByText(/One is saved, and never shown/)).toBeVisible();
    fireEvent.change(screen.getByLabelText('Mobile number'), {
      target: { value: '07700 900123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send a test' }));
    expect(await screen.findByText('The test text went.')).toBeVisible();
    await waitFor(() => expect(screen.getByTestId('sms-status')).toHaveTextContent(/^Working\./));
    await expectAccessible();
  });

  it('sends through a Messaging Service instead, keeping the token saved for the same account', async () => {
    const state = at('/settings/texts', { sms: { view: structuredClone(TWILIO_WORKING) } });
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Twilio' })).toBeChecked());
    expect(screen.getByLabelText('Account SID')).toHaveValue(SID);
    expect(screen.getByLabelText('From number')).toHaveValue('+447700900999');
    fireEvent.click(screen.getByRole('radio', { name: 'A Messaging Service' }));
    expect(screen.queryByLabelText('From number')).toBeNull();
    fireEvent.change(screen.getByLabelText('Messaging Service SID'), { target: { value: MG } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/^Saved\./);
    expect(state.sms?.saves?.[0]).toEqual({
      provider: 'twilio',
      account_sid: SID,
      from: null,
      messaging_service_sid: MG,
      country: 'GB',
      monthly_cap: 200,
    });
    // Another account needs its own token.
    fireEvent.change(screen.getByLabelText('Account SID'), {
      target: { value: `AC${'1'.repeat(32)}` },
    });
    expect(screen.getByText(/You changed the Account SID: type its Auth Token/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Type the Auth Token again for the new Account SID.',
    );
  });

  it('switching provider says it waits for a test, and the password or token is typed again', async () => {
    const state = at('/settings/texts', { sms: { view: structuredClone(WORKING) } });
    expect(await screen.findByTestId('sms-status')).toHaveTextContent(/^Working\./);
    // The form has started from what the vault has.
    await waitFor(() =>
      expect(screen.getByLabelText('Address')).toHaveValue('http://192.168.1.20:8080'),
    );
    expect(screen.queryByTestId('sms-switching')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Twilio' }));
    expect(screen.getByTestId('sms-switching')).toHaveTextContent(
      'Saving switches the vault to Twilio: SMS Gate’s settings and password are forgotten, and no text is sent until a test goes.',
    );
    fireEvent.change(screen.getByLabelText('Account SID'), { target: { value: SID } });
    fireEvent.change(screen.getByLabelText('From number'), {
      target: { value: '+447700900999' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Type the Auth Token the Twilio Console shows.',
    );
    fireEvent.change(screen.getByLabelText('Auth Token'), { target: { value: 'tw-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('Saved. Now send a test: no text is sent until one goes.'),
    ).toBeVisible();
    expect(screen.getByTestId('sms-status')).toHaveTextContent('Saved, not yet tested.');
    expect(state.sms?.saves?.[0]).toMatchObject({ provider: 'twilio' });
    // And back: SMS Gate's password is asked for again. (Clicked until the
    // form has taken in the settings just saved, which it does once loaded.)
    await waitFor(() => {
      fireEvent.click(screen.getByRole('radio', { name: 'SMS Gate for Android' }));
      expect(screen.getByTestId('sms-switching')).toHaveTextContent(
        /^Saving switches the vault to SMS Gate/,
      );
    });
    fireEvent.change(screen.getByLabelText('Address'), {
      target: { value: 'http://192.168.1.20:8080' },
    });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'sms' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Type the password the SMS Gate app shows.',
    );
    // Turning texts off says what is forgotten.
    cleanup();
    at('/settings/texts', { sms: { view: structuredClone(TWILIO_WORKING) } });
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off text messages' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Turn off text messages?' });
    expect(dialog).toHaveTextContent(/The vault forgets Twilio and its Auth Token, and sends/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    expect(
      await screen.findByText('Removed, with its Auth Token. The vault sends no texts now.'),
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
