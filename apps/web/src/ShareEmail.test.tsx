import { LINK_TEXTS_NOT_SET_UP, SHARE_LINK_EMAIL_UNAVAILABLE } from '@fdv/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { expectSharedDialog } from './dialog-testing.js';
import { fresh, installFakeApi, PASSPORT, signedIn, type FakeState } from './test-api.js';

/**
 * "Email the link" (0.9.0; the owner's decision of 13 Nov 2026): the vault
 * emails a link to its recipient for whoever made it, with the operator's
 * mail server alone. It is another way to send it, beside Copy the link —
 * never in its place — and the PIN or password is still told another way.
 */

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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

/** The link made from the document's page, as the sheet shows it once made. */
async function made(over: Partial<FakeState>) {
  const state = fresh({ documents: [PASSPORT], ...over });
  installFakeApi(state);
  signedIn();
  window.history.replaceState({}, '', `/documents/${PASSPORT.id}`);
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Share a link' }));
  fireEvent.click(await screen.findByLabelText(/Also ask for a four-digit PIN/));
  fireEvent.click(await screen.findByRole('button', { name: 'Make the link' }));
  await screen.findByRole('button', { name: 'Copy the link' });
  return state;
}

describe('Email the link, beside Copy the link (0.9.0)', () => {
  it('with the operator’s mail server: both are offered; it sends, and says where, masked', async () => {
    const state = await made({ operatorMail: true });
    // Copy the link stays, next to Email the link; the PIN is still told another way.
    const copy = screen.getByRole('button', { name: 'Copy the link' });
    const email = screen.getByRole('button', { name: 'Email the link' });
    expect(copy).toBeVisible();
    expect(email).toBeVisible();
    expect(copy.compareDocumentPosition(email) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByText(/some other way — a phone call, not the same message/).length).toBe(
      1,
    );
    expect(screen.getByText(/never its PIN or password/)).toBeInTheDocument();
    await expectAccessible();

    // Not an address: said, and nothing is sent.
    fireEvent.change(screen.getByLabelText('Email the link to'), {
      target: { value: 'jane@' },
    });
    fireEvent.click(email);
    expect(await screen.findByText(/That is not an email address/)).toBeInTheDocument();
    expect(state.linkEmails ?? []).toEqual([]);

    fireEvent.change(screen.getByLabelText('Email the link to'), {
      target: { value: 'jane.smith@example.com' },
    });
    fireEvent.change(screen.getByLabelText('A short message, if you like'), {
      target: { value: '  For the flat.  ' },
    });
    fireEvent.click(email);
    expect(await screen.findByText('Sent to j•••@e•••.com.')).toBeInTheDocument();
    expect(state.linkEmails?.map((e) => [e.to, e.message])).toEqual([
      ['jane.smith@example.com', 'For the flat.'],
    ]);
    // Copy still works, after.
    const copied = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: copied } });
    fireEvent.click(screen.getByRole('button', { name: 'Copy the link' }));
    await screen.findByRole('button', { name: 'Copied' });
    expect(copied).toHaveBeenCalledWith(
      `${window.location.origin}/s#share-secret-0123456789abcdef`,
    );
  });

  it('a message with a web address is refused before anything is sent', async () => {
    const state = await made({ operatorMail: true });
    fireEvent.change(screen.getByLabelText('Email the link to'), {
      target: { value: 'jane@example.com' },
    });
    fireEvent.change(screen.getByLabelText('A short message, if you like'), {
      target: { value: 'Log in at paypal-secure.com/login' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Email the link' }));
    expect(
      await screen.findByText(/Leave web addresses and website names out/),
    ).toBeInTheDocument();
    expect(state.linkEmails ?? []).toEqual([]);
  });

  it('without the operator’s mail server: Copy the link alone, and nothing about email', async () => {
    await made({ operatorMail: false });
    expect(screen.getByRole('button', { name: 'Copy the link' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Email the link' })).toBeNull();
    expect(screen.queryByLabelText('Email the link to')).toBeNull();
    expect(screen.queryByTestId('email-the-link')).toBeNull();
  });
});

describe('Email the link from Sharing, for a link the reader made (0.9.0)', () => {
  const MINE = {
    id: 'sh-mine',
    document_id: PASSPORT.id,
    document_title: "Mansoor's passport",
    collection_id: null,
    collection_name: null,
    recipient_label: 'the visa agent',
    created_by_name: 'Mansoor Seikh',
    created_at: '2026-11-10T10:00:00Z',
    expires_at: '2099-11-17T10:00:00Z',
    has_pin: true,
    open_count: 0,
    last_opened_at: null,
    state: 'active',
    flow: 'v2',
    permission: 'download',
    revealable: true,
    emailable: true,
    emailed_to: 'v•••@a•••.com',
    mine: true,
    summary: 'Shared with the visa agent, not opened yet.',
  };
  const TOKEN = 'kept-link-secret-0123456789abcdef';

  it('says on each link where it was emailed, and by whom when somebody else sent it (16 Nov 2026)', async () => {
    const theirs = {
      ...MINE,
      id: 'sh-theirs',
      recipient_label: 'the bank',
      created_by_name: 'Aisha',
      mine: false,
      revealable: false,
      emailable: false,
      emailed_to: 'b•••@b•••.com',
      emailed_by_name: 'Aisha',
    };
    const state = fresh({ documents: [PASSPORT], operatorMail: true, shares: [MINE, theirs] });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/sharing');
    render(<App />);
    const live = await screen.findByRole('list', { name: 'Links that work now' });
    expect(await within(live).findByText('Emailed to v•••@a•••.com')).toBeVisible();
    expect(within(live).getByText('Emailed to b•••@b•••.com by Aisha')).toBeVisible();
    await expectAccessible();
  });

  it('shows the link again with Copy, and emails it after confirming it’s you', async () => {
    const state = fresh({
      documents: [PASSPORT],
      operatorMail: true,
      shares: [MINE],
      revealedShares: { [MINE.id]: { link_token: TOKEN, link_url: null, pin: '4821' } },
      stepUpNeeded: true,
    });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/sharing');
    render(<App />);
    const live = await screen.findByRole('list', { name: 'Links that work now' });
    fireEvent.click(
      await within(live).findByRole('button', {
        name: "Show the link to “Mansoor's passport”, shared with the visa agent",
      }),
    );
    await screen.findByRole('dialog', { name: 'Just checking it is you' });
    fireEvent.change(screen.getByLabelText('Or your password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    const sheet = await screen.findByRole('dialog', {
      name: "The link to “Mansoor's passport”",
    });
    // Show the link: the app's one dialog (0.9.0-dev.67), wide.
    expectSharedDialog(sheet, "The link to “Mansoor's passport”", 'Hide it');
    expect(sheet).toHaveClass('dialog-wide');
    // Both ways to send it, and where it was emailed before, masked.
    expect(within(sheet).getByRole('button', { name: 'Copy the link' })).toBeVisible();
    expect(within(sheet).getByRole('button', { name: 'Email the link' })).toBeVisible();
    expect(within(sheet).getByText(/last had the vault email it to v•••@a•••.com/)).toBeVisible();
    fireEvent.change(within(sheet).getByLabelText('Email the link to'), {
      target: { value: 'visa@agent.example' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Email the link' }));
    expect(await within(sheet).findByText('Sent to v•••@a•••.example.')).toBeInTheDocument();
    await waitFor(() =>
      expect(state.linkEmails).toEqual([
        { share_id: MINE.id, to: 'visa@agent.example', message: null },
      ]),
    );
    await expectAccessible();
  });

  it('is not offered on a link somebody else made, nor without the operator’s mail server', async () => {
    const theirs = { ...MINE, id: 'sh-theirs', revealable: false, emailable: false };
    const state = fresh({
      documents: [PASSPORT],
      operatorMail: false,
      shares: [{ ...MINE, emailable: false }, theirs],
      revealedShares: { [MINE.id]: { link_token: TOKEN, link_url: null } },
    });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/sharing');
    render(<App />);
    const live = await screen.findByRole('list', { name: 'Links that work now' });
    fireEvent.click(
      (await within(live).findAllByRole('button', { name: /^Show the link to/ }))[0] as HTMLElement,
    );
    const sheet = await screen.findByRole('dialog', { name: /^The link to/ });
    expect(within(sheet).getByRole('button', { name: 'Copy the link' })).toBeVisible();
    expect(within(sheet).queryByRole('button', { name: 'Email the link' })).toBeNull();
  });
});

describe('a new link sent by the vault from “Who is it for?” (0.9.0-dev.69; 18 Nov 2026)', () => {
  const READY = {
    settings: null,
    ready: true,
    sent_this_month: 0,
    monthly_cap: 200,
    cloud_url: 'https://api.sms-gate.app/3rdparty/v1',
  };

  async function sheet(over: Partial<FakeState>) {
    const state = fresh({ documents: [PASSPORT], ...over });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', `/documents/${PASSPORT.id}`);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Share a link' }));
    await screen.findByLabelText('Who is it for?');
    return state;
  }

  it('emails and texts it once made, says where, and gives Copy and Send after', async () => {
    const shared = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, share: shared });
    const state = await sheet({ operatorMail: true, sms: { view: READY } });
    const email = screen.getByLabelText('Email the link to');
    const phone = screen.getByLabelText('Text the link to');
    await waitFor(() => expect(phone).toBeEnabled());
    fireEvent.change(email, { target: { value: 'visa@agent.example' } });
    fireEvent.change(phone, { target: { value: '07700 900123' } });
    fireEvent.click(screen.getByLabelText(/Also ask for a four-digit PIN/));
    await expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Make the link' }));

    const handover = await screen.findByTestId('share-handover');
    const sent = within(handover).getByRole('list', { name: 'What the vault sent' });
    expect(within(sent).getByText('Emailed to v•••@a•••.example')).toBeInTheDocument();
    expect(within(sent).getByText('Texted to •••• •••123')).toBeInTheDocument();
    expect(within(handover).getByText(/Its PIN was not sent with it/)).toBeInTheDocument();
    expect(state.linkEmails).toEqual([
      { share_id: 'sh-0', to: 'visa@agent.example', message: null },
    ]);
    expect(state.linkTexts).toEqual([{ share_id: 'sh-0', to: '07700 900123' }]);
    // Neither went in the link itself.
    const made = state.calls.find((c) => c.method === 'POST' && c.url.endsWith('/share'));
    expect(JSON.stringify(made?.body)).not.toContain('visa@agent');
    expect(JSON.stringify(made?.body)).not.toContain('07700');
    // Copy, and Send through the browser's own share sheet: the link alone.
    const copy = within(handover).getByRole('button', { name: 'Copy the link' });
    expect(sent.compareDocumentPosition(copy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(
      within(handover).getByRole('button', { name: 'Send the link from another app' }),
    );
    expect(shared).toHaveBeenCalledWith({
      title: 'A shared link',
      url: `${window.location.origin}/s#share-secret-0123456789abcdef`,
    });
    expect(JSON.stringify(shared.mock.calls)).not.toContain('4821');
    // The PIN, with Copy, as Show the link gives it.
    expect(within(handover).getByRole('button', { name: 'Copy the PIN' })).toBeInTheDocument();
    await expectAccessible();
  });

  it('a code ticked with nowhere yet to go starts at the address the link goes to', async () => {
    await sheet({ operatorMail: true });
    fireEvent.change(screen.getByLabelText('Email the link to'), {
      target: { value: 'visa@agent.example' },
    });
    fireEvent.click(screen.getByLabelText(/email them a code/));
    expect(screen.getByLabelText('Their email address')).toHaveValue('visa@agent.example');
  });

  it('without texts set up the number is off and says so; nothing is sent where nothing was typed', async () => {
    const state = await sheet({ operatorMail: true });
    const phone = screen.getByLabelText('Text the link to');
    expect(phone).toBeDisabled();
    expect(screen.getByText(LINK_TEXTS_NOT_SET_UP)).toBeInTheDocument();
    // Not an address: said under it, and the link waits.
    fireEvent.change(screen.getByLabelText('Email the link to'), { target: { value: 'visa@' } });
    expect(screen.getByText(/That is not an email address/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make the link' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Email the link to'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make the link' }));
    const handover = await screen.findByTestId('share-handover');
    expect(within(handover).queryByRole('list', { name: 'What the vault sent' })).toBeNull();
    expect(state.linkEmails ?? []).toEqual([]);
    expect(within(handover).queryByLabelText('Text the link to')).toBeNull();
  });

  it('without the operator’s mail, the address is off and says why', async () => {
    await sheet({ operatorMail: false });
    expect(screen.getByLabelText('Email the link to')).toBeDisabled();
    expect(screen.getByText(SHARE_LINK_EMAIL_UNAVAILABLE)).toBeInTheDocument();
    await expectAccessible();
  });
});
