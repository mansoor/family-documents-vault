import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { holdAccountLinkToken } from './link-token.js';
import { fresh, installFakeApi, signedIn } from './test-api.js';

// jsdom draws no canvas: the QR code is a picture of nothing here.
vi.mock('qrcode', () => ({
  default: { toDataURL: () => Promise.resolve('data:image/png;base64,') },
}));

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  holdAccountLinkToken();
});
afterEach(() => vi.unstubAllGlobals());

/**
 * Two-step sign-in, held to (0.9.0): a sign-in that must set it up — an
 * owner, or an adult where the household asks it, with neither a code nor
 * a passkey — is shown that, and nothing else, until it is set up; then the
 * app goes on, in the same sign-in.
 */
describe('two-step sign-in, set up first (0.9.0)', () => {
  const setUpAuthenticator = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Set up two-step sign-in' }));
    fireEvent.change(await screen.findByLabelText('Code from the app'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
  };

  it('a password sign-in that must set it up shows that, and nothing else, until it is', async () => {
    const state = fresh({ twoStep: false, twoStepSetupPending: true });
    installFakeApi(state);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }, { timeout: 5000 }));
    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: 'm@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await screen.findByRole('heading', { name: 'Set up two-step sign-in' });
    expect(await screen.findByText(/Owners must have two-step sign-in/)).toBeInTheDocument();
    // Nothing of the vault is asked for, or shown, meanwhile.
    expect(screen.queryByRole('heading', { name: 'The Seikh family' })).toBeNull();
    expect(state.calls.some((c) => c.url.startsWith('/api/v1/documents'))).toBe(false);

    await setUpAuthenticator();
    // On, in the same sign-in.
    await screen.findByRole('heading', { name: 'The Seikh family' });
    expect(
      state.calls.some((c) => c.method === 'POST' && c.url === '/api/v1/auth/totp/confirm'),
    ).toBe(true);
  });

  it('an answer that says so, to a sign-in already open, shows it too', async () => {
    const state = fresh({ twoStep: false, twoStepSetupPending: true });
    installFakeApi(state);
    signedIn();
    render(<App />);
    await screen.findByRole('heading', { name: 'Set up two-step sign-in' });
    // Signing out is there, and takes them to the start.
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Every important paper, in one place.' });
  });

  it('first run: the owner sets it up between the account and the questions', async () => {
    const state = fresh({
      setupRequired: true,
      members: [],
      twoStep: false,
      twoStepSetupAtSetup: true,
    });
    installFakeApi(state);
    render(<App />);
    await screen.findByRole('heading', { name: /Set up your family/ });
    fireEvent.change(screen.getByLabelText('Setup code'), { target: { value: 'from-the-env' } });
    fireEvent.change(screen.getByLabelText(/call your family/), {
      target: { value: 'The Seikh family' },
    });
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Mansoor' } });
    fireEvent.change(screen.getByLabelText('Your email'), { target: { value: 'm@example.test' } });
    fireEvent.change(screen.getByLabelText('Choose a password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create my vault' }));

    await screen.findByRole('heading', { name: 'Set up two-step sign-in' });
    await setUpAuthenticator();
    await screen.findByRole('heading', { name: 'A few quick questions' });
  });

  it('setup says when the setup code is missing', async () => {
    const state = fresh({ setupRequired: true, members: [] });
    installFakeApi(state);
    render(<App />);
    await screen.findByRole('heading', { name: /Set up your family/ });
    expect(screen.getByLabelText('Setup code')).toBeRequired();
    expect(screen.getByText(/FDV_SETUP_TOKEN/)).toBeInTheDocument();
  });

  it('an owner asks it of every adult, or stops, in Security', async () => {
    const state = fresh({ twoStepAdults: true });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/settings/security');
    render(<App />);
    const box = await screen.findByLabelText('Ask every adult to use two-step sign-in');
    expect(box).toBeChecked();
    fireEvent.click(box);
    await waitFor(() => expect(state.twoStepAdultSaves).toEqual([{ adults: false }]));
    await waitFor(() =>
      expect(screen.getByLabelText('Ask every adult to use two-step sign-in')).not.toBeChecked(),
    );
  });

  it('an owner whose factor is a passkey is asked for it after the password, not a code', async () => {
    const state = fresh({ passkeySecondStep: true });
    installFakeApi(state);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }, { timeout: 5000 }));
    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: 'm@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { name: 'One more step' });
    expect(screen.getByRole('button', { name: 'Use your passkey' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Code')).toBeNull();
    // Nothing of the vault was opened by the password.
    expect(screen.queryByRole('heading', { name: 'The Seikh family' })).toBeNull();
  });

  it('a sign-in that has a factor and has not given it confirms with it, never the password', async () => {
    const state = fresh({ twoStepSetupPending: true, twoStepReason: 'confirm' });
    installFakeApi(state);
    signedIn();
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm it’s you' }));
    await screen.findByRole('dialog', { name: 'Just checking it is you' });
    expect(screen.queryByLabelText('Or your password')).toBeNull();
    fireEvent.change(screen.getByLabelText(/code from your authenticator app/i), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByRole('heading', { name: 'The Seikh family' });
  });

  it('an adult is not shown it', async () => {
    const state = fresh();
    installFakeApi(state);
    signedIn('adult');
    window.history.replaceState({}, '', '/settings/privacy');
    render(<App />);
    await screen.findByRole('heading', { name: 'Privacy' });
    expect(screen.queryByLabelText('Ask every adult to use two-step sign-in')).toBeNull();
  });
});
