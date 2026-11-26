import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SECURITY_QUESTIONS_WARNING } from '@fdv/shared';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { fresh, installFakeApi, signedIn, type FakeState } from './test-api.js';

/**
 * Getting back in (0.9.0-dev.104), on the web: a sign-in refused because its
 * code by text can't be sent, and a recovery code standing in; the security
 * questions answered in place of the second step; the page that follows,
 * which sets two-step sign-in up again and shows the new recovery codes
 * once; and Your account's recovery codes and security questions.
 */

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
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

const bodyOf = (state: FakeState, method: string, end: string) =>
  state.calls.filter((c) => c.method === method && c.url.endsWith(end)).at(-1)?.body as
    Record<string, unknown> | undefined;

const signIn = async () => {
  fireEvent.change(await screen.findByLabelText('Email'), {
    target: { value: 'sami@example.test' },
  });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a long password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
};

describe('signing in without the second step', () => {
  it('a code by text that can’t be sent refuses the sign-in, and a recovery code stands in; then two-step sign-in is set up again and new codes shown once', async () => {
    const state = fresh({
      recovery: { ways: ['recovery_code', 'security_questions'], textDown: true },
      // Their authenticator app was taken away with the rest.
      twoStep: false,
    });
    installFakeApi(state);
    window.history.replaceState({}, '', '/sign-in');
    render(<App />);
    await signIn();
    await screen.findByText(
      'We couldn’t send your code by text. Use a recovery code or your security questions, or ask an owner to send you a password reset.',
    );
    await expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Use a recovery code' }));
    await screen.findByRole('heading', { name: 'Use a recovery code' });
    fireEvent.change(screen.getByLabelText('Recovery code'), { target: { value: 'wrong-code' } });
    // A new password, in the same step.
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Choose a new password'), {
      target: { value: 'a brand new password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText('That recovery code isn’t right, or it was used already.');
    fireEvent.change(screen.getByLabelText('Recovery code'), {
      target: { value: 'ABCDE-FGHJK' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() =>
      expect(bodyOf(state, 'POST', '/api/v1/auth/mfa/recovery-code')).toEqual({
        mfa_token: 'mfa',
        code: 'ABCDE-FGHJK',
        new_password: 'a brand new password',
      }),
    );
    // Only setting a second step up again, and then the codes made for it.
    await screen.findByRole('heading', { name: 'Set up two-step sign-in again' });
    fireEvent.click(await screen.findByRole('button', { name: 'Set up two-step sign-in' }));
    fireEvent.change(await screen.findByLabelText('Code from the app'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    const shown = await screen.findByTestId('recovery-codes');
    expect(within(shown).getAllByRole('listitem')).toHaveLength(10);
    expect(within(shown).getByText('code0-abcde')).toBeInTheDocument();
    expect(state.recovery?.madeCalls).toBe(1);
    await expectAccessible();
    fireEvent.click(within(shown).getByRole('button', { name: 'I’ve kept them' }));
    await waitFor(() => expect(screen.queryByTestId('recovery-codes')).not.toBeInTheDocument());
  });

  it('the security questions answered in place of the second step', async () => {
    const state = fresh({
      recovery: { ways: ['security_questions'] },
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
    await signIn();
    await screen.findByText('Enter the six-digit code we texted to •••• •••404.');
    expect(screen.queryByRole('button', { name: 'Use a recovery code' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Answer your security questions' }));
    const first = await screen.findByLabelText('What was the name of your first pet?');
    fireEvent.change(first, { target: { value: 'Biscuit' } });
    fireEvent.change(screen.getByLabelText('What was your first job?'), {
      target: { value: 'Paper round' },
    });
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('What was my first bike called?'), {
      target: { value: 'Red Racer' },
    });
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Choose a new password'), {
      target: { value: 'a brand new password' },
    });
    await expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() =>
      expect(bodyOf(state, 'POST', '/api/v1/auth/mfa/answers')).toEqual({
        mfa_token: 'mfa-token',
        answers: ['Biscuit', 'Paper round', 'Red Racer'],
        new_password: 'a brand new password',
      }),
    );
    await screen.findByRole('heading', { name: 'Set up two-step sign-in again' });
  });
});

describe('making the codes after a recovery', () => {
  it('codes not made as the second step was set up are made on request', async () => {
    const state = fresh({ recovery: { ways: [], failMake: 1 }, twoStep: false });
    state.twoStepSetupPending = true;
    state.twoStepReason = 'recovered';
    installFakeApi(state);
    signedIn();
    render(<App />);
    await screen.findByRole('heading', { name: 'Set up two-step sign-in again' });
    fireEvent.click(await screen.findByRole('button', { name: 'Set up two-step sign-in' }));
    fireEvent.change(await screen.findByLabelText('Code from the app'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Make my recovery codes' }));
    const shown = await screen.findByTestId('recovery-codes');
    expect(within(shown).getAllByRole('listitem')).toHaveLength(10);
  });
});

describe('Your account → recovery codes and security questions', () => {
  it('no codes beside a second step: said, made on request and shown once', async () => {
    const state = fresh({ recovery: { ways: [], secondStep: true } });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/settings/account');
    render(<App />);
    const card = (await screen.findByRole('heading', { name: 'Recovery codes' })).closest(
      'section',
    ) as HTMLElement;
    await within(card).findByText(/You have no recovery codes\. Make them now/);
    fireEvent.click(within(card).getByRole('button', { name: 'Make recovery codes' }));
    const shown = await screen.findByTestId('recovery-codes');
    expect(within(shown).getAllByRole('listitem')).toHaveLength(10);
    expect(within(shown).getByRole('button', { name: 'Download' })).toBeInTheDocument();
    expect(within(shown).getByRole('button', { name: 'Print' })).toBeInTheDocument();
    fireEvent.click(within(shown).getByRole('button', { name: 'I’ve kept them' }));
    const after = (await screen.findByRole('heading', { name: 'Recovery codes' })).closest(
      'section',
    ) as HTMLElement;
    await within(after).findByText(/^10 of 10 left, made /);
    // A new set replaces the old: asked first.
    fireEvent.click(within(after).getByRole('button', { name: 'Make new codes' }));
    await screen.findByRole('heading', { name: 'Make new recovery codes?' });
    await expectAccessible();
  });

  it('an authenticator app set up here, with no codes yet: they are made beside it and shown once', async () => {
    const state = fresh({ recovery: { ways: [] }, twoStep: false });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/settings/account');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Set up two-step sign-in' }));
    fireEvent.change(await screen.findByLabelText('Code from the app'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    const shown = await screen.findByTestId('recovery-codes');
    expect(within(shown).getAllByRole('listitem')).toHaveLength(10);
    expect(state.recovery?.madeCalls).toBe(1);
  });

  it('security questions: the warning said, three chosen and answered, never shown again', async () => {
    const state = fresh({ recovery: { ways: [], secondStep: true } });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/settings/account');
    render(<App />);
    const card = (await screen.findByRole('heading', { name: 'Security questions' })).closest(
      'section',
    ) as HTMLElement;
    expect(within(card).getByText(SECURITY_QUESTIONS_WARNING)).toBeInTheDocument();
    fireEvent.click(await within(card).findByRole('button', { name: 'Set security questions' }));
    fireEvent.change(within(card).getByLabelText('Answer 1'), { target: { value: 'Biscuit' } });
    fireEvent.change(within(card).getByLabelText('Answer 2'), { target: { value: 'abc' } });
    fireEvent.change(within(card).getByLabelText('Answer 3'), { target: { value: 'Red Racer' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Save these questions' }));
    await within(card).findByText('Each answer needs at least 4 letters or numbers.');
    fireEvent.change(within(card).getByLabelText('Question 3'), { target: { value: 'own' } });
    fireEvent.change(within(card).getByLabelText('Your question'), {
      target: { value: 'What was my first bike called?' },
    });
    fireEvent.change(within(card).getByLabelText('Answer 2'), {
      target: { value: 'St Mary’s' },
    });
    await expectAccessible();
    fireEvent.click(within(card).getByRole('button', { name: 'Save these questions' }));
    await waitFor(() =>
      expect(bodyOf(state, 'PUT', '/api/v1/auth/security-questions')).toEqual({
        questions: [
          { key: 'first_school', answer: 'Biscuit' },
          { key: 'first_pet', answer: 'St Mary’s' },
          { key: 'own', text: 'What was my first bike called?', answer: 'Red Racer' },
        ],
      }),
    );
    await within(card).findByRole('button', { name: 'Change them' });
    expect(card).not.toHaveTextContent(/Biscuit|Red Racer/);
  });
});
