import { SHARE_CODE_TRUTH, SHARE_CODE_UNAVAILABLE } from '@fdv/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { SharePage } from './screens/SharePage.js';
import { fresh, installFakeApi, signedIn } from './test-api.js';

const TOKEN = 'share-secret-0123456789abcdef';

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});
afterEach(() => {
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

/**
 * A second factor for someone with no account (5.20), at both ends: the
 * share sheet's protections — a PIN or a password, an emailed code (only
 * where the vault's operator has given it a mail server), this device only
 * — and the hand-over that shows a password once; and the page at /s asking
 * for them.
 */
describe('the protection choices (5.20)', () => {
  const openSheet = async (over: Parameters<typeof fresh>[0] = {}) => {
    const state = fresh({ timezone: 'Europe/London', ...over });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/documents/doc-1');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Share a link' }));
    await screen.findByRole('group', { name: 'Protect it' });
    return state;
  };
  const shareBody = (state: ReturnType<typeof fresh>) =>
    state.calls.find((c) => c.method === 'POST' && c.url.endsWith('/share'))?.body as
      Record<string, unknown> | undefined;

  it('a password, a code by email with the plain truth, and this device only; the password shown once', async () => {
    const state = await openSheet({ operatorMail: true });
    const protect = screen.getByRole('group', { name: 'Protect it' });
    // A PIN or a password, never both.
    const pin = within(protect).getByLabelText(/four-digit PIN/);
    const password = within(protect).getByLabelText(/ask for a password/);
    fireEvent.click(pin);
    fireEvent.click(password);
    expect(pin).not.toBeChecked();
    expect(password).toBeChecked();
    expect(screen.getByRole('button', { name: 'Make one up for me' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // A code, to the address typed here, with what it does and does not prove.
    expect(screen.getByText(SHARE_CODE_TRUTH)).toBeInTheDocument();
    fireEvent.click(within(protect).getByLabelText(/email them a code/));
    fireEvent.change(screen.getByLabelText('Their email address'), {
      target: { value: 'not an address' },
    });
    expect(screen.getByRole('button', { name: 'Make the link' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(/name@example.com/);
    fireEvent.change(screen.getByLabelText('Their email address'), {
      target: { value: ' jane.smith@example.com ' },
    });
    fireEvent.click(within(protect).getByLabelText('This device only'));
    expect(screen.getByText(/will not open on their computer/)).toBeInTheDocument();
    await expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Make the link' }));

    // The password, once, with how to give it.
    const handed = await screen.findByTestId('share-password');
    expect(handed).toHaveTextContent('k7mq-p2xa-9htw');
    expect(handed).toHaveTextContent(/shown only now/);
    expect(shareBody(state)).toMatchObject({
      with_pin: false,
      with_password: true,
      code_email: 'jane.smith@example.com',
      this_device_only: true,
    });
    expect(shareBody(state)).not.toHaveProperty('password');
    expect(screen.getByText(/a code is emailed to j•••@e•••\.com/)).toBeInTheDocument();
    expect(
      screen.getByText('It opens only in the first browser that opens it.'),
    ).toBeInTheDocument();
    await expectAccessible();

    // Done: gone, and nowhere to be found again.
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await screen.findByRole('button', { name: 'Share a link' });
    expect(screen.queryByText('k7mq-p2xa-9htw')).not.toBeInTheDocument();
  });

  it('without operator mail, the emailed code is not offered, and the reason is', async () => {
    const state = await openSheet({ operatorMail: false });
    const protect = screen.getByRole('group', { name: 'Protect it' });
    expect(within(protect).queryByLabelText(/email them a code/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Their email address')).not.toBeInTheDocument();
    expect(screen.getByTestId('share-code-unavailable')).toHaveTextContent(SHARE_CODE_UNAVAILABLE);
    // A password and this device only are there all the same.
    expect(within(protect).getByLabelText(/ask for a password/)).toBeInTheDocument();
    expect(within(protect).getByLabelText('This device only')).toBeInTheDocument();
    await expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Make the link' }));
    await screen.findByText(/\/s#share-secret-0123456789abcdef$/);
    expect(shareBody(state)).not.toHaveProperty('code_email');
  });

  it('a typed password is 8 characters at least, and goes as typed', async () => {
    const state = await openSheet();
    fireEvent.click(screen.getByLabelText(/ask for a password/));
    fireEvent.click(screen.getByRole('button', { name: 'I’ll type one' }));
    fireEvent.change(screen.getByLabelText('The password'), { target: { value: 'short' } });
    expect(screen.getByRole('button', { name: 'Make the link' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(/At least 8 characters/);
    fireEvent.change(screen.getByLabelText('The password'), {
      target: { value: 'river otter lantern' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Make the link' }));
    await screen.findByText(/\/s#share-secret-0123456789abcdef$/);
    expect(shareBody(state)).toMatchObject({ password: 'river otter lantern', with_pin: false });
    // Theirs, so not shown back: they are told it will be asked for.
    expect(screen.queryByTestId('share-password')).not.toBeInTheDocument();
    expect(screen.getByText('They will be asked for the password you chose.')).toBeInTheDocument();
  });

  it('an older vault is offered the PIN alone, and sent nothing it does not know', async () => {
    const state = await openSheet({ shareSecondFactor: false, operatorMail: false });
    const protect = screen.getByRole('group', { name: 'Protect it' });
    expect(within(protect).getByLabelText(/four-digit PIN/)).toBeInTheDocument();
    expect(within(protect).queryByLabelText(/password/)).not.toBeInTheDocument();
    expect(within(protect).queryByLabelText('This device only')).not.toBeInTheDocument();
    expect(screen.queryByTestId('share-code-unavailable')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Make the link' }));
    await screen.findByText(/\/s#share-secret-0123456789abcdef$/);
    expect(Object.keys(shareBody(state) ?? {}).sort()).toEqual(
      ['expires_at', 'permission', 'with_pin'].sort(),
    );
  });
});

describe('the page a link opens, with a second factor (5.20)', () => {
  it('asks for a code, sends it to the address masked, and never asks for one', async () => {
    const state = fresh({ shareCode: '482915', shareCodeTo: 'jane.smith@example.com' });
    installFakeApi(state);
    render(<SharePage token={TOKEN} />);

    await screen.findByText(/it asks for a code, which we email to you/);
    // Which inbox, masked; the title waits; nothing to type an address in.
    expect(screen.getByText('j•••@e•••.com')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'A shared document' })).toBeInTheDocument();
    expect(document.querySelector('input[type=email]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open' })).toBeDisabled();
    await expectAccessible();

    fireEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'We sent a code to j•••@e•••.com. It works once, for 10 minutes.',
    );
    fireEvent.change(screen.getByLabelText('The code from the email'), {
      target: { value: '111111' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await screen.findByText(/That code is not right/);
    expect(state.shareOpens).toBe(0);
    // As it reads in the email: "482 915".
    fireEvent.change(screen.getByLabelText('The code from the email'), {
      target: { value: '482 915' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await screen.findByRole('heading', { name: 'Flat 3 tenancy agreement' });

    const sent = state.calls.filter((c) => c.url === '/api/v1/shared/code');
    expect(sent.map((c) => c.body)).toEqual([{ token: TOKEN }]);
    const unlocks = state.calls.filter((c) => c.url === '/api/v1/shared/unlock');
    expect(unlocks.at(-1)?.body).toEqual({ token: TOKEN, code: '482915' });
    for (const c of state.calls) expect(JSON.stringify(c.body ?? {})).not.toContain('@');
  });

  it('with a password and a code, both are asked for, and a wrong one of either reads the same', async () => {
    const state = fresh({ sharePassword: 'river otter lantern', shareCode: '482915' });
    installFakeApi(state);
    render(<SharePage token={TOKEN} />);

    await screen.findByText(/put a password on it\. It also asks for a code/);
    fireEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
    await screen.findByLabelText('The code from the email');
    const unlocks = () => state.calls.filter((c) => c.url === '/api/v1/shared/unlock').length;
    const tryWith = async (password: string, code: string) => {
      const before = unlocks();
      fireEvent.change(screen.getByLabelText('The password they gave you'), {
        target: { value: password },
      });
      fireEvent.change(screen.getByLabelText('The code from the email'), {
        target: { value: code },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      await waitFor(() => expect(unlocks()).toBe(before + 1));
    };
    await tryWith('not it at all', '482915');
    const wrongPassword = (await screen.findByRole('alert')).textContent;
    await tryWith('river otter lantern', '111111');
    const wrongCode = (await screen.findByRole('alert')).textContent;
    expect(wrongPassword).toBe(wrongCode);
    expect(wrongCode).toMatch(/The password or the code is not right/);
    await tryWith('river otter lantern', '482915');
    await screen.findByRole('heading', { name: 'Flat 3 tenancy agreement' });
  });

  it('this device only is said before Open, and another browser is told it cannot open here', async () => {
    installFakeApi(fresh({ shareDeviceOnly: true }));
    const { unmount } = render(<SharePage token={TOKEN} />);
    await screen.findByText(/It opens only on the first device that opens it/);
    unmount();

    const state = fresh({ shareDeviceOnly: true, shareOtherDevice: true });
    installFakeApi(state);
    render(<SharePage token={TOKEN} />);
    await screen.findByRole('heading', { name: 'This link cannot be opened' });
    expect(screen.getByText(/opened on another device already/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open' })).not.toBeInTheDocument();
    expect(state.calls.map((c) => c.url)).toEqual(['/api/v1/shared/preview']);
    expect(screen.queryByText(/tenancy/i)).not.toBeInTheDocument();
    await expectAccessible();
  });
});
