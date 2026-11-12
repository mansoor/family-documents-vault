import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SMS_CLOUD_URL, SMS_FACTOR_WARNING, type SmsSettingsView } from '@fdv/shared';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { holdAccountLinkToken } from './link-token.js';
import { SharePage } from './screens/SharePage.js';
import { AISHA, fresh, installFakeApi, ME, signedIn, type FakeState } from './test-api.js';

/**
 * Codes by text (0.9.0, SMS3), on the web: the share sheet's Text option and
 * the recipient's page asking for the texted code; an owner's invitation
 * with the code texted as well; Your account's two switches, with what a
 * text does not protect against said plainly; and "Text me a code" at
 * sign-in, when confirming it's you, and on a reset's page.
 */

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  holdAccountLinkToken();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

const READY: SmsSettingsView = {
  settings: null,
  ready: true,
  sent_this_month: 0,
  monthly_cap: 200,
  cloud_url: SMS_CLOUD_URL,
};

/** A vault that sends texts and offers codes by text. */
const texts = (over: Partial<FakeState> = {}) =>
  fresh({ sms: { view: READY }, smsCodes: true, timezone: 'Europe/London', ...over });

const bodyOf = (state: FakeState, method: string, end: string) =>
  state.calls.filter((c) => c.method === method && c.url.endsWith(end)).at(-1)?.body as
    Record<string, unknown> | undefined;

describe('a share link’s code by text', () => {
  it('the sheet offers Text beside Email, sends the number, and says where the code goes', async () => {
    const state = texts({ operatorMail: true });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/documents/doc-1');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Share a link' }));
    const protect = await screen.findByRole('group', { name: 'Protect it' });
    fireEvent.click(within(protect).getByLabelText(/send them a code/));
    fireEvent.click(await screen.findByLabelText('By text message'));
    expect(screen.queryByLabelText('Their email address')).not.toBeInTheDocument();
    expect(screen.getByText(/not a lost phone or a number moved/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Their mobile number'), {
      target: { value: '07700 900456' },
    });
    await expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Make the link' }));
    await screen.findByText(/a code is texted to •••• •••456/);
    expect(bodyOf(state, 'POST', '/share')).toMatchObject({
      second_factor: 'sms',
      recipient_phone: '07700 900456',
    });
    expect(bodyOf(state, 'POST', '/share')).not.toHaveProperty('code_email');
  });

  it('without texts set up, only the emailed code is offered, as before', async () => {
    const state = texts({ operatorMail: true, sms: { view: { ...READY, ready: false } } });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/documents/doc-1');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Share a link' }));
    const protect = await screen.findByRole('group', { name: 'Protect it' });
    expect(within(protect).getByLabelText(/email them a code/)).toBeInTheDocument();
    expect(screen.queryByLabelText('By text message')).not.toBeInTheDocument();
  });

  it('the recipient is asked for the texted code, never shown the number', async () => {
    const state = fresh({ shareCode: '482915', shareCodeByText: true });
    installFakeApi(state);
    render(<SharePage token="share-secret-0123456789abcdef" />);
    await screen.findByText(/it asks for a code, which we text to you/);
    expect(screen.getByTestId('share-code')).toHaveTextContent(/We text a code to •••• •••456/);
    fireEvent.click(screen.getByRole('button', { name: 'Text me a code' }));
    await screen.findByText('We sent a code to •••• •••456.');
    fireEvent.change(screen.getByLabelText('The code from the text'), {
      target: { value: '482915' },
    });
    await expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await screen.findByRole('heading', { name: 'Flat 3 tenancy agreement' });
  });
});

describe('an invitation’s code by text', () => {
  it('an owner may give their mobile, and is told the code went', async () => {
    const state = texts({ members: [ME, AISHA] });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/people');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Invite someone to sign in' }));
    fireEvent.change(screen.getByLabelText('Their name'), { target: { value: 'Sam' } });
    fireEvent.change(screen.getByLabelText('Their email address'), {
      target: { value: 'sam@example.test' },
    });
    fireEvent.change(await screen.findByLabelText('Their mobile number (optional)'), {
      target: { value: '07700 900777' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Adult' }));
    fireEvent.click(screen.getByRole('button', { name: 'Make the invitation' }));
    await screen.findByRole('heading', { name: 'Send these to Sam' });
    expect(screen.getByText(/We texted the code to •••• •••777/)).toBeInTheDocument();
    expect(bodyOf(state, 'POST', '/api/v1/invitations')).toMatchObject({
      invitee_phone: '07700 900777',
    });
    await expectAccessible();
  });

  it('an adult is not offered it', async () => {
    const state = texts({ members: [{ ...ME, role: 'adult' }, AISHA] });
    installFakeApi(state);
    signedIn('adult');
    window.history.replaceState({}, '', '/people');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Invite someone to sign in' }));
    await screen.findByLabelText('Their email address');
    expect(screen.queryByLabelText('Their mobile number (optional)')).not.toBeInTheDocument();
  });
});

describe('Your account → Codes by text', () => {
  it('two switches, each the person’s own, and what a text does not protect against', async () => {
    const state = texts();
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/settings/account');
    render(<App />);
    const card = (await screen.findByRole('heading', { name: 'Codes by text' })).closest(
      'section',
    ) as HTMLElement;
    expect(within(card).getByText(SMS_FACTOR_WARNING)).toBeInTheDocument();
    fireEvent.click(
      within(card).getByLabelText('Ask for a code by text when my password is reset'),
    );
    await waitFor(() =>
      expect(bodyOf(state, 'PUT', '/api/v1/auth/text-codes')).toEqual({ reset: true }),
    );
    await waitFor(() =>
      expect(
        within(card).getByLabelText('Ask for a code by text when my password is reset'),
      ).toBeChecked(),
    );
    fireEvent.click(within(card).getByLabelText('Text me a code when I sign in'));
    await waitFor(() =>
      expect(bodyOf(state, 'PUT', '/api/v1/auth/text-codes')).toEqual({ sign_in: true }),
    );
    await expectAccessible();
  });

  it('says why they cannot be turned on, and turns nothing on', async () => {
    const state = texts({
      textCodes: {
        sign_in: false,
        reset: false,
        phone: null,
        phone_confirmed: false,
        sms_ready: true,
        can_turn_on: false,
        why_not: 'Add your mobile number first, and confirm it with the code we text to it.',
        step_up: true,
      },
    });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/settings/account');
    render(<App />);
    await screen.findByText(/Add your mobile number first/);
    expect(screen.getByLabelText('Text me a code when I sign in')).toBeDisabled();
  });

  it('is not there on a vault without codes by text', async () => {
    installFakeApi(texts({ smsCodes: false }));
    signedIn();
    window.history.replaceState({}, '', '/settings/account');
    render(<App />);
    await screen.findByRole('heading', { name: 'Two-step sign-in' });
    expect(screen.queryByRole('heading', { name: 'Codes by text' })).not.toBeInTheDocument();
  });
});

describe('“Text me a code”', () => {
  it('at sign-in, when a text is the second step: texted already, and sent as a text code', async () => {
    const state = texts({
      signInByText: {
        mfa_required: true,
        mfa_token: 'mfa-token',
        methods: ['text'],
        text_to: '•••• •••404',
        text_sent: true,
      },
    });
    installFakeApi(state);
    window.history.replaceState({}, '', '/sign-in');
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: 'sami@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a long password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText('Enter the six-digit code we texted to •••• •••404.');
    expect(screen.getByRole('status')).toHaveTextContent('We texted a code to •••• •••404.');
    expect(
      screen.queryByRole('button', { name: 'Use my authenticator app instead' }),
    ).not.toBeInTheDocument();
    await expectAccessible();
    fireEvent.change(screen.getByLabelText('Code from the text'), { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() =>
      expect(bodyOf(state, 'POST', '/api/v1/auth/mfa')).toEqual({
        mfa_token: 'mfa-token',
        code: '654321',
        method: 'text',
      }),
    );
  });

  it('at sign-in beside an authenticator app: offered, and sent only when asked', async () => {
    const state = texts({
      signInByText: {
        mfa_required: true,
        mfa_token: 'mfa-token',
        methods: ['totp', 'text'],
        text_to: '•••• •••101',
        text_sent: false,
      },
    });
    installFakeApi(state);
    window.history.replaceState({}, '', '/sign-in');
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: 'owner@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a long password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText('Enter the six-digit code from your authenticator app.');
    expect(state.calls.some((c) => c.url === '/api/v1/auth/mfa/text')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Text me a code instead' }));
    await screen.findByText('We texted a code to •••• •••101.');
    expect(screen.getByRole('button', { name: 'Use my authenticator app instead' })).toBeVisible();
  });

  it('when confirming it’s you: offered where a text may serve, and confirms with it', async () => {
    const state = texts({ stepUpNeeded: true, stepUpTextTo: '•••• •••303' });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/settings/data');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Make an export' }));
    await screen.findByRole('dialog', { name: 'Just checking it is you' });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Or text me a code at •••• •••303' }),
    );
    await screen.findByText('We texted a code to •••• •••303.');
    fireEvent.change(screen.getByLabelText('Code from the text'), { target: { value: '654321' } });
    await expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(bodyOf(state, 'POST', '/api/v1/auth/step-up')).toEqual({ text_code: '654321' });
  });

  it('when confirming it’s you, not offered to whoever has no text to give', async () => {
    installFakeApi(texts({ stepUpNeeded: true, stepUpTextTo: null }));
    signedIn();
    window.history.replaceState({}, '', '/settings/data');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Make an export' }));
    await screen.findByRole('dialog', { name: 'Just checking it is you' });
    await screen.findByLabelText('Or your password');
    expect(screen.queryByRole('button', { name: /text me a code/i })).not.toBeInTheDocument();
  });

  it('on a reset’s page, when the person asked for one: texted, and sent with the password', async () => {
    const state = texts({ resetTextTo: '•••• •••202' });
    installFakeApi(state);
    window.history.replaceState({}, '', '/reset#reset-secret-0123456789abcdef');
    holdAccountLinkToken();
    render(<App />);
    await screen.findByRole('heading', { name: 'Set a new password' });
    const box = screen.getByTestId('reset-text-code');
    expect(box).toHaveTextContent(/We text it to •••• •••202/);
    fireEvent.change(screen.getByLabelText('Your new password'), {
      target: { value: 'a brand new password' },
    });
    expect(screen.getByRole('button', { name: 'Set my new password' })).toBeDisabled();
    fireEvent.click(within(box).getByRole('button', { name: 'Text me the code' }));
    await within(box).findByText(/We texted a code to •••• •••202/);
    fireEvent.change(screen.getByLabelText('The code from the text'), {
      target: { value: '654321' },
    });
    await expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Set my new password' }));
    await screen.findByRole('heading', { name: 'That is done' });
    expect(bodyOf(state, 'POST', '/api/v1/password-resets/complete')).toMatchObject({
      password: 'a brand new password',
      code: '654321',
    });
  });
});
