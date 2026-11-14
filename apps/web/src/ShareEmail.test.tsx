import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
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
    summary: 'Shared with the visa agent, not opened yet.',
  };
  const TOKEN = 'kept-link-secret-0123456789abcdef';

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
