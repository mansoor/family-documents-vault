import { fireEvent, render, screen, within } from '@testing-library/react';
import { PASSWORD_RULES_DEFAULT } from '@fdv/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { holdAccountLinkToken } from './link-token.js';
import { securityCards } from './settings-sections.js';
import { fresh, installFakeApi, signedIn } from './test-api.js';

/**
 * Password rules: an owner sets them in Settings → Security, first on the
 * page; every form that sets a sign-in password says them under the field,
 * says what the password typed still lacks, and shows the vault's refusal.
 */

const RESET_TOKEN = 'reset-secret-0123456789abcdef';
const JOIN_TOKEN = 'join-secret-0123456789abcdef';
const TWELVE_AND_A_NUMBER = { ...PASSWORD_RULES_DEFAULT, min_length: 12, needs_number: true };
const HINT_12 =
  'At least 12 characters, with a number. Not a common password, nor your name or email address.';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('Settings → Security', () => {
  it('an owner sets the rules in a card first on the page, saved with Save', async () => {
    const state = fresh({ passwordRules: { ...PASSWORD_RULES_DEFAULT } });
    installFakeApi(state);
    signedIn('owner');
    window.history.replaceState({}, '', '/settings/security');
    render(<App />);
    const heading = await screen.findByRole('heading', { name: 'Password rules' });
    // First on the page, before two-step sign-in for adults.
    const cards = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(cards[0]).toBe('Password rules');
    expect(cards).toContain('Two-step sign-in for adults');
    const card = heading.closest('section') as HTMLElement;
    const length = await within(card).findByLabelText('At least this many characters');
    expect(length).toHaveValue(10);
    expect(within(card).getByLabelText(/Refuse common and easily guessed passwords/)).toBeChecked();
    const save = within(card).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    // Out of range: said, and not saved, though something else has changed.
    fireEvent.click(within(card).getByLabelText('A number'));
    expect(save).toBeEnabled();
    fireEvent.change(length, { target: { value: '70' } });
    expect(save).toBeDisabled();
    expect(length).toHaveAttribute('aria-invalid', 'true');
    expect(card.querySelector('#password-rules-length-hint')).toHaveClass('error');
    fireEvent.change(length, { target: { value: '12' } });
    expect(save).toBeEnabled();
    expect(state.calls.some((c) => c.method === 'PUT')).toBe(false);
    fireEvent.click(save);
    expect(await within(card).findByText(`Saved: ${HINT_12}`)).toBeInTheDocument();
    expect(state.passwordRulesSaves).toEqual([TWELVE_AND_A_NUMBER]);

    // Looser: the vault asks to confirm it's you first.
    state.stepUpNeeded = true;
    fireEvent.click(within(card).getByLabelText('A number'));
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText(/Please confirm it is you to loosen the password rules/),
    ).toBeInTheDocument();
    expect(state.passwordRulesSaves).toHaveLength(1);
  });

  it('is an owner’s alone, and only where the vault has the rules', async () => {
    const caps = (on: boolean) => ({ features: { password_rules: on } }) as never;
    expect(securityCards('owner', caps(true)).passwordRules).toBe(true);
    expect(securityCards('adult', caps(true)).passwordRules).toBe(false);
    expect(securityCards('owner', caps(false)).passwordRules).toBe(false);

    installFakeApi(fresh({ passwordRules: { ...PASSWORD_RULES_DEFAULT } }));
    signedIn('owner');
    window.history.replaceState({}, '', '/settings');
    render(<App />);
    expect(
      await screen.findByText('Password rules; two-step sign-in for adults', {}, { timeout: 3000 }),
    ).toBeInTheDocument();
  });
});

describe('the forms that set a password', () => {
  it('changing your own: the rules under the field, what it still lacks, and the vault’s refusal', async () => {
    const state = fresh({ passwordRules: TWELVE_AND_A_NUMBER });
    installFakeApi(state);
    signedIn('adult');
    window.history.replaceState({}, '', '/settings/account');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change your password' }));
    expect(
      await screen.findByText(`${HINT_12} A few words you will remember work best.`),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Your password now'), {
      target: { value: 'correct horse battery' },
    });
    const next = screen.getByLabelText('Your new password');
    fireEvent.change(next, { target: { value: 'short' } });
    expect(screen.getByText('Use at least 12 characters, with a number.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change it' })).toBeDisabled();
    fireEvent.change(next, { target: { value: 'long enough but no digits' } });
    expect(screen.getByText('Add a number.')).toBeInTheDocument();
    fireEvent.change(next, { target: { value: 'password12345' } });
    expect(screen.queryByText('Add a number.')).not.toBeInTheDocument();
    // The vault alone knows it is common.
    state.passwordRefusal = 'That password is too common: choose another.';
    fireEvent.click(screen.getByRole('button', { name: 'Change it' }));
    expect(
      await screen.findByText('That password is too common: choose another.'),
    ).toBeInTheDocument();
    expect(state.passwordChanged ?? null).toBeNull();
  });

  it('a vault from before the rules: 10 characters, and nothing said of common passwords', async () => {
    installFakeApi(fresh());
    signedIn('adult');
    window.history.replaceState({}, '', '/settings/account');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change your password' }));
    expect(
      await screen.findByText('At least 10 characters. A few words you will remember work best.'),
    ).toBeInTheDocument();
  });

  it('a reset link says the household’s rules, and shows the refusal', async () => {
    const state = fresh({
      passwordRules: TWELVE_AND_A_NUMBER,
      passwordRefusal: 'That password is too common: choose another.',
    });
    installFakeApi(state);
    window.history.replaceState({}, '', `/reset#${RESET_TOKEN}`);
    holdAccountLinkToken();
    render(<App />);
    await screen.findByRole('heading', { name: 'Set a new password' });
    expect(
      screen.getByText(`${HINT_12} This also unlocks your own private documents.`),
    ).toBeInTheDocument();
    const field = screen.getByLabelText('Your new password');
    fireEvent.change(field, { target: { value: 'eleven char' } });
    expect(screen.getByText('Use at least 12 characters, with a number.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set my new password' })).toBeDisabled();
    fireEvent.change(field, { target: { value: 'password12345' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set my new password' }));
    expect(
      await screen.findByText('That password is too common: choose another.'),
    ).toBeInTheDocument();
  });

  it('an invitation says the household’s rules under the password', async () => {
    installFakeApi(fresh({ passwordRules: TWELVE_AND_A_NUMBER }));
    window.history.replaceState({}, '', `/join#${JOIN_TOKEN}`);
    holdAccountLinkToken();
    render(<App />);
    await screen.findByRole('heading', { name: 'Join The Seikh family' });
    expect(
      screen.getByText(`${HINT_12} This also unlocks your own private documents.`),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('The code they gave you'), {
      target: { value: 'ABCD-EFGH' },
    });
    fireEvent.change(screen.getByLabelText('Choose a password'), {
      target: { value: 'twelve chars' },
    });
    expect(screen.getByText('Add a number.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Join the family vault' })).toBeDisabled();
  });
});
