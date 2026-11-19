import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { expectSharedDialog } from './dialog-testing.js';
import { fresh, installFakeApi, ME, PASSPORT, signedIn, type FakeState } from './test-api.js';

/**
 * Links and requests changed after they are made, and requests shown again
 * (0.9.0, LK; the owner's decision of 15 Nov 2026): from Sharing, Change
 * opens the form a link or a request was made with, filled in as it is now,
 * and sends only what changed, with its version; Show the link shows a
 * request's link again, as a share link's is.
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

const DAY = 864e5;
const made = Date.now() - DAY;

/** A link the signed-in member made, and one somebody else made. */
const MINE = {
  id: 'sh-mine',
  document_id: PASSPORT.id,
  document_title: "Mansoor's passport",
  collection_id: null,
  collection_name: null,
  recipient_label: 'the visa agent',
  created_by_name: 'Mansoor Seikh',
  created_at: new Date(made).toISOString(),
  expires_at: new Date(made + 7 * DAY).toISOString(),
  has_pin: true,
  open_count: 0,
  last_opened_at: null,
  state: 'active',
  flow: 'v2',
  permission: 'download',
  max_opens: 5,
  protection: ['pin'],
  revealable: true,
  changeable: true,
  latest_end: new Date(made + 90 * DAY).toISOString(),
  show_title: null,
  version: 1,
  summary: 'Shared with the visa agent, not opened yet.',
};
const THEIRS = {
  ...MINE,
  id: 'sh-theirs',
  recipient_label: 'the embassy',
  created_by_name: 'Sana',
  revealable: false,
  changeable: false,
  summary: 'Shared with the embassy, not opened yet.',
};

function request(over: Record<string, unknown> = {}): Record<string, unknown> & { id: string } {
  return {
    id: 'req-a',
    title: 'Tax papers for 2025',
    message: 'The usual ones, please.',
    items: [{ id: 'i1', label: 'W-2' }],
    recipient_label: 'Jane, accountant',
    recipient_email: null,
    requested_by_name: ME.display_name,
    mine: true,
    created_at: new Date(made).toISOString(),
    expires_at: new Date(made + 10 * DAY).toISOString(),
    protection: ['password'],
    max_visits: 3,
    visits_used: 1,
    max_files: 10,
    files_used: 2,
    max_total_bytes: 200 * 1024 * 1024,
    bytes_used: 2048,
    accept_types: 'standard',
    review_by: 'me',
    suggested_member_id: null,
    suggested_type_key: null,
    close_after_submit: false,
    state: 'active',
    paused_reason: null,
    closed_reason: null,
    files_received: 2,
    revealable: true,
    changeable: true,
    latest_end: new Date(made + 90 * DAY).toISOString(),
    version: 1,
    ...over,
  };
}

function at(path: string, over: Partial<FakeState> = {}): FakeState {
  const state = fresh({ documents: [PASSPORT], timezone: 'Europe/London', ...over });
  installFakeApi(state);
  signedIn('owner');
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

/** Confirms it's you, in the step-up sheet the vault asked for. */
async function confirmItsMe() {
  await screen.findByRole('dialog', { name: 'Just checking it is you' });
  fireEvent.change(screen.getByLabelText('Or your password'), {
    target: { value: 'correct horse battery' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
}

describe('a link changed from Sharing (0.9.0, LK; on its own page since 0.9.0-dev.69)', () => {
  it('opens the form it was made with, filled in, in cards, and sends only what changed, with its version', async () => {
    const state = at('/sharing', { shares: [{ ...MINE }, { ...THEIRS }] });
    const live = await screen.findByRole('list', { name: 'Links that work now' });
    await within(live).findByText(/the embassy/);
    // Only the reader's own.
    expect(within(live).queryByRole('link', { name: /^Change the link .*the embassy/ })).toBeNull();
    fireEvent.click(
      within(live).getByRole('link', {
        name: `Change the link to “Mansoor's passport”, shared with the visa agent`,
      }),
    );
    // A page of its own, laid out as a request's change is (18 Nov 2026).
    await screen.findByRole('heading', { name: 'Change a link' });
    expect(window.location.pathname).toBe(`/sharing/links/${MINE.id}`);
    expect(screen.queryByRole('dialog')).toBeNull();
    for (const card of ['Who it is for', 'Keeping it safe', 'What they can do']) {
      expect(screen.getByRole('heading', { name: card, level: 2 })).toBeInTheDocument();
    }
    expect(await screen.findByLabelText('Who is it for?')).toHaveValue('the visa agent');
    // Sending is for a new link: never offered on Change.
    expect(screen.queryByLabelText('Email the link to')).toBeNull();
    expect(screen.queryByLabelText('Text the link to')).toBeNull();
    expect(screen.getByLabelText('Can be opened')).toHaveValue('5');
    expect(screen.getByLabelText('Keep its PIN')).toBeChecked();
    // One order of buttons: what the page is for first, Cancel last.
    const save = screen.getByRole('button', { name: 'Save the changes' });
    const cancel = screen.getByRole('link', { name: 'Cancel' });
    expect(save.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(save).toBeDisabled();
    expect(screen.getByText('Nothing is changed yet.')).toBeInTheDocument();
    await expectAccessible();

    fireEvent.change(screen.getByLabelText('Who is it for?'), {
      target: { value: 'the new agent' },
    });
    fireEvent.change(screen.getByLabelText('Can be opened'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save the changes' }));
    // Back to Sharing, saying so.
    expect(
      await screen.findByText(`The link to “Mansoor's passport” is changed.`),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe('/sharing');
    const sent = state.calls.filter((c) => c.url === `/api/v1/shares/${MINE.id}`);
    expect(sent.map((c) => [c.method, c.body, c.headers?.['if-match']])).toEqual([
      ['PATCH', { recipient_label: 'the new agent', max_opens: 3 }, '"1"'],
    ]);
  });

  it('asks who is asking before it reaches further, then shows a new PIN once, with Copy', async () => {
    const state = at(`/sharing/links/${MINE.id}`, { shares: [{ ...MINE }], stepUpNeeded: true });
    const copied = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: copied } });
    fireEvent.click(await screen.findByLabelText('A new four-digit PIN'));
    expect(screen.getByText(/The old PIN stops working at once/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save the changes' }));
    await confirmItsMe();
    const shown = await screen.findByRole('heading', { name: 'The new PIN' });
    expect(shown).toBeInTheDocument();
    expect(screen.getByText('4821')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy the PIN' }));
    await waitFor(() => expect(copied).toHaveBeenCalledWith('4821'));
    const sent = state.calls.filter((c) => c.url === `/api/v1/shares/${MINE.id}`);
    expect(sent.map((c) => c.body)).toEqual([{ secret: 'pin' }, { secret: 'pin' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(
      await screen.findByText(`The link to “Mansoor's passport” is changed.`),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('4821');
  });

  it('changed somewhere else meanwhile: says so, and Load it again starts from it as it is now', async () => {
    const state = at(`/sharing/links/${MINE.id}`, { shares: [{ ...MINE }] });
    fireEvent.change(await screen.findByLabelText('Who is it for?'), {
      target: { value: 'the new agent' },
    });
    // Somebody else's change lands first.
    Object.assign(state.shares[0] as Record<string, unknown>, {
      version: 2,
      recipient_label: 'the consulate',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save the changes' }));
    const alert = await screen.findByText(
      /This link was changed somewhere else since you opened it/,
    );
    expect(alert.closest('[role="alert"]')).not.toBeNull();
    await expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Load it again' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Who is it for?')).toHaveValue('the consulate'),
    );
    expect(screen.queryByText(/changed somewhere else/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Who is it for?'), {
      target: { value: 'the new agent' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save the changes' }));
    expect(
      await screen.findByText(`The link to “Mansoor's passport” is changed.`),
    ).toBeInTheDocument();
    const sent = state.calls.filter(
      (c) => c.url === `/api/v1/shares/${MINE.id}` && c.method === 'PATCH',
    );
    expect(sent.map((c) => c.headers?.['if-match'])).toEqual(['"1"', '"2"']);
  });

  it('ended meanwhile: says so, and leads back to Sharing', async () => {
    const state = at(`/sharing/links/${MINE.id}`, { shares: [{ ...MINE }] });
    fireEvent.change(await screen.findByLabelText('Can be opened'), { target: { value: '2' } });
    (state.shares[0] as Record<string, unknown>).state = 'revoked';
    fireEvent.click(screen.getByRole('button', { name: 'Save the changes' }));
    expect(await screen.findByText(/This link has ended, so it can’t be changed/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to Sharing' })).toHaveAttribute(
      'href',
      '/sharing',
    );
  });

  it('an owner changing somebody else’s link is told its PIN stays theirs, and where its code goes', async () => {
    at('/sharing', {
      shares: [
        {
          ...THEIRS,
          changeable: true,
          mine: false,
          protection: ['pin', 'code'],
          code_to: 'j•••@e•••.com',
          second_factor: 'email',
          this_device_only: true,
        },
      ],
    });
    fireEvent.click(
      await screen.findByRole('link', {
        name: `Change the link to “Mansoor's passport”, shared with the embassy`,
      }),
    );
    await screen.findByRole('heading', { name: 'Change a link' });
    expect(
      await screen.findByText(/Only whoever made it can change its PIN or password/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('A new four-digit PIN')).toBeNull();
    expect(
      screen.getByText(
        /It emails a code to j•••@e•••\.com when it is opened\. To send the code somewhere else, take this link back and make a new one\./,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/It opens only in the first browser that opened it/),
    ).toBeInTheDocument();
    await expectAccessible();
  });

  it('a link that has ended has no Change', async () => {
    at('/sharing', {
      shares: [{ ...MINE, state: 'revoked', changeable: false, revealable: false }],
    });
    await screen.findByRole('heading', { name: 'No longer working' });
    expect(screen.queryByRole('link', { name: /^Change the link/ })).toBeNull();
  });

  it('from the document’s Share panel: Show the link, and Change on its page, back to the panel', async () => {
    at(`/documents/${PASSPORT.id}`, {
      shares: [{ ...MINE }],
      revealedShares: {
        [MINE.id]: { link_token: 'kept-link-secret', link_url: null, pin: '4821' },
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Share a link' }));
    const listed = await screen.findByRole('list', { name: 'Its links that work now' });
    // The same reveal as Sharing's (18 Nov 2026).
    fireEvent.click(
      await within(listed).findByRole('button', {
        name: `Show the link to “Mansoor's passport”, shared with the visa agent`,
      }),
    );
    const sheet = await screen.findByRole('dialog', { name: `The link to “Mansoor's passport”` });
    expectSharedDialog(sheet, `The link to “Mansoor's passport”`, 'Hide it');
    expect(
      within(sheet).getByText(`${window.location.origin}/s#kept-link-secret`),
    ).toBeInTheDocument();
    expect(within(sheet).getByText('4821')).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Copy the PIN' })).toBeInTheDocument();
    await expectAccessible();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Hide it' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(
      within(listed).getByRole('link', {
        name: `Change the link to “Mansoor's passport”, shared with the visa agent`,
      }),
    );
    await screen.findByRole('heading', { name: 'Change a link' });
    fireEvent.change(await screen.findByLabelText('Can be opened'), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save the changes' }));
    // Back on the document's page, its Share panel open, saying so.
    expect(
      await screen.findByText(`The link to “Mansoor's passport” is changed.`),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe(`/documents/${PASSPORT.id}`);
    expect(window.location.hash).toBe('#share');
  });
});

describe('a request shown again and changed (0.9.0, LK)', () => {
  it('shows a request’s link and password again, with Copy, and hides them', async () => {
    at('/sharing', {
      uploadRequests: [request(), request({ id: 'req-b', title: 'Lease', revealable: false })],
      revealedRequests: {
        'req-a': {
          link_token: 'kept-drop-secret-0123456789',
          link_url: null,
          password: 'abcd-efgh-jkmn',
        },
      },
    });
    const live = await screen.findByRole('list', { name: 'Requests that work now' });
    expect(
      (await within(live).findAllByRole('button', { name: /^Show the link for/ })).map(
        (b) => b.textContent,
      ),
    ).toEqual(['Show the link']);
    fireEvent.click(
      within(live).getByRole('button', {
        name: 'Show the link for the request “Tax papers for 2025” to Jane, accountant',
      }),
    );
    const sheet = await screen.findByRole('dialog', {
      name: 'The link for the request “Tax papers for 2025” to Jane, accountant',
    });
    expectSharedDialog(
      sheet,
      'The link for the request “Tax papers for 2025” to Jane, accountant',
      'Hide it',
    );
    expect(
      within(sheet).getByText(`${window.location.origin}/drop#kept-drop-secret-0123456789`),
    ).toBeInTheDocument();
    expect(within(sheet).getByText('abcd-efgh-jkmn')).toBeInTheDocument();
    await expectAccessible();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Hide it' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body.textContent).not.toContain('abcd-efgh-jkmn');
  });

  it('says so when it was made before the vault kept a copy', async () => {
    at('/sharing', { uploadRequests: [request()] });
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Show the link for the request “Tax papers for 2025” to Jane, accountant',
      }),
    );
    expect(await screen.findByText(/made before the vault kept a copy/)).toBeInTheDocument();
  });

  it('Change opens the form it was made with, filled in; what it asks for is said, not offered', async () => {
    const state = at('/sharing', { uploadRequests: [request()] });
    fireEvent.click(
      await screen.findByRole('link', {
        name: 'Change the request “Tax papers for 2025” to Jane, accountant',
      }),
    );
    await screen.findByRole('heading', { name: 'Change a request' });
    expect(await screen.findByLabelText('Who is it for?')).toHaveValue('Jane, accountant');
    expect(screen.getByLabelText('Only so many visits')).toBeChecked();
    expect(screen.getByLabelText('Visits, at most')).toHaveValue('3');
    expect(screen.getByLabelText('Keep its password')).toBeChecked();
    // Its title and message are changed here too (16 Nov 2026); the things
    // to send are said, not offered.
    expect(screen.getByLabelText(/^Title/)).toHaveValue('Tax papers for 2025');
    expect(screen.getByLabelText('A message for them')).toHaveValue('The usual ones, please.');
    expect(screen.getByRole('list', { name: 'Things to send' })).toHaveTextContent('W-2');
    expect(
      screen.getByText(/The things to send, and who looks at what comes in, stay/),
    ).toBeInTheDocument();
    await expectAccessible();

    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: '2025 tax papers' } });
    fireEvent.change(screen.getByLabelText('Visits, at most'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Also Word and Excel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save the changes' }));
    expect(
      await screen.findByText('The request “2025 tax papers” to Jane, accountant is changed.'),
    ).toBeInTheDocument();
    const sent = state.calls.filter((c) => c.url === '/api/v1/upload-requests/req-a');
    expect(sent.map((c) => [c.method, c.body, c.headers?.['if-match']])).toEqual([
      ['PATCH', { title: '2025 tax papers', max_visits: 5, accept_types: 'office' }, '"1"'],
    ]);
  });

  it('an owner changing somebody else’s request is told its password stays theirs', async () => {
    at('/sharing/ask/req-b', {
      uploadRequests: [
        request({
          id: 'req-b',
          mine: false,
          requested_by_name: 'Sana',
          review_by: 'adults',
          protection: ['password', 'email_code', 'this_device'],
          recipient_email: 'jane.smith@example.com',
        }),
      ],
    });
    await screen.findByRole('heading', { name: 'Change a request' });
    expect(
      await screen.findByText(/Only whoever asked can change its PIN or password/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('A new password')).toBeNull();
    expect(
      screen.getByText(
        /It emails a code to j•••@e•••\.com when it is opened\. To send the code somewhere else, take this request back and make a new one\./,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/It opens only in the first browser that opened it/),
    ).toBeInTheDocument();
    await expectAccessible();
  });

  it('emails a request’s link from Show the link, never its password', async () => {
    const state = at('/sharing', {
      operatorMail: true,
      uploadRequests: [request({ emailable: true })],
      revealedRequests: {
        'req-a': {
          link_token: 'kept-drop-secret-0123456789',
          link_url: null,
          password: 'abcd-efgh-jkmn',
        },
      },
    });
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Show the link for the request “Tax papers for 2025” to Jane, accountant',
      }),
    );
    const sheet = await screen.findByRole('dialog', {
      name: 'The link for the request “Tax papers for 2025” to Jane, accountant',
    });
    expect(
      within(sheet).getByText(/never what you ask for, and never its PIN or password/),
    ).toBeInTheDocument();
    fireEvent.change(within(sheet).getByLabelText('Email the link to'), {
      target: { value: 'jane.smith@example.com' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Email the link' }));
    expect(await within(sheet).findByText('Sent to j•••@e•••.com.')).toBeInTheDocument();
    expect(state.requestEmails).toEqual([
      { request_id: 'req-a', to: 'jane.smith@example.com', message: null },
    ]);
    await expectAccessible();
  });

  it('a new password is shown once; a request that has ended cannot be changed', async () => {
    at('/sharing/ask/req-a', { uploadRequests: [request()] });
    await screen.findByRole('heading', { name: 'Change a request' });
    fireEvent.click(await screen.findByLabelText('A new password'));
    fireEvent.click(screen.getByRole('button', { name: 'Save the changes' }));
    expect(await screen.findByRole('heading', { name: 'The new password' })).toBeInTheDocument();
    expect(screen.getByText('abcd-efgh-new1')).toBeInTheDocument();
    cleanup();

    at('/sharing/ask/req-c', {
      uploadRequests: [request({ id: 'req-c', state: 'revoked', changeable: false })],
    });
    expect(await screen.findByText(/That request can’t be changed/)).toBeInTheDocument();
  });
});

describe('requests and links alike (0.9.0-dev.69; the owner’s feedback of 18 Nov 2026)', () => {
  const READY = {
    settings: null,
    ready: true,
    sent_this_month: 0,
    monthly_cap: 200,
    cloud_url: 'https://api.sms-gate.app/3rdparty/v1',
  };

  it('a request’s PIN: a new one on Change, shown once, and its PIN shown again with Show the link', async () => {
    const state = at('/sharing/ask/req-a', {
      uploadRequests: [request({ protection: ['pin'] })],
    });
    await screen.findByRole('heading', { name: 'Change a request' });
    expect(await screen.findByLabelText('Keep its PIN')).toBeChecked();
    fireEvent.click(screen.getByLabelText('A new four-digit PIN'));
    fireEvent.click(screen.getByRole('button', { name: 'Save the changes' }));
    expect(await screen.findByRole('heading', { name: 'The new PIN' })).toBeInTheDocument();
    expect(screen.getByText('7302')).toBeInTheDocument();
    const sent = state.calls.filter((c) => c.url === '/api/v1/upload-requests/req-a');
    expect(sent.map((c) => c.body)).toEqual([{ secret: 'pin' }]);
    cleanup();

    at('/sharing', {
      uploadRequests: [request({ protection: ['pin'] })],
      revealedRequests: {
        'req-a': { link_token: 'kept-drop-secret', link_url: null, pin: '7302' },
      },
    });
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Show the link for the request “Tax papers for 2025” to Jane, accountant',
      }),
    );
    const sheet = await screen.findByRole('dialog', {
      name: 'The link for the request “Tax papers for 2025” to Jane, accountant',
    });
    expect(within(sheet).getByText('7302')).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Copy the PIN' })).toBeInTheDocument();
    expect(within(sheet).getByText(/Tell them the PIN some other way/)).toBeInTheDocument();
  });

  it('a request changed somewhere else, or ended, is said as a link’s is', async () => {
    const state = at('/sharing/ask/req-a', { uploadRequests: [request()] });
    fireEvent.change(await screen.findByLabelText('Who is it for?'), {
      target: { value: 'Jane Smith' },
    });
    Object.assign(state.uploadRequests?.[0] as Record<string, unknown>, {
      version: 2,
      recipient_label: 'Jane, the accountant',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save the changes' }));
    expect(
      await screen.findByText(/This request was changed somewhere else since you opened it/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load it again' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Who is it for?')).toHaveValue('Jane, the accountant'),
    );

    fireEvent.change(screen.getByLabelText('Who is it for?'), { target: { value: 'Jane' } });
    (state.uploadRequests?.[0] as Record<string, unknown>).state = 'revoked';
    fireEvent.click(screen.getByRole('button', { name: 'Save the changes' }));
    expect(await screen.findByText(/This request has ended, so it can’t be changed/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to Sharing' })).toBeInTheDocument();
  });

  it('Text the link, from Show the link: the number masked, and the row says where it went', async () => {
    const state = at('/sharing', {
      sms: { view: READY },
      shares: [{ ...MINE, textable: true, mine: true }],
      revealedShares: {
        [MINE.id]: { link_token: 'kept-link-secret', link_url: null, pin: '4821' },
      },
    });
    fireEvent.click(
      await screen.findByRole('button', {
        name: `Show the link to “Mansoor's passport”, shared with the visa agent`,
      }),
    );
    const sheet = await screen.findByRole('dialog', { name: `The link to “Mansoor's passport”` });
    expect(
      within(sheet).getByText(/never what it is to, and never its PIN or password/),
    ).toBeVisible();
    // A number that can't be one is said under it, and nothing is sent.
    fireEvent.change(within(sheet).getByLabelText('Text the link to'), {
      target: { value: '0770' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Text the link' }));
    expect(await within(sheet).findByText(/That is not a mobile number/)).toBeInTheDocument();
    expect(within(sheet).getByLabelText('Text the link to')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(state.linkTexts ?? []).toEqual([]);
    fireEvent.change(within(sheet).getByLabelText('Text the link to'), {
      target: { value: '07700 900123' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Text the link' }));
    expect(await within(sheet).findByText('Sent to •••• •••123.')).toBeInTheDocument();
    expect(state.linkTexts).toEqual([{ share_id: MINE.id, to: '07700 900123' }]);
    await expectAccessible();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Hide it' }));
    // Its row says where it went, as an email's does.
    const live = await screen.findByRole('list', { name: 'Links that work now' });
    expect(await within(live).findByText('Texted to •••• •••123')).toBeInTheDocument();
  });

  it('Text the link is not offered while the household’s texts are not set up', async () => {
    at('/sharing', {
      shares: [{ ...MINE, textable: false }],
      revealedShares: { [MINE.id]: { link_token: 'kept-link-secret', link_url: null } },
    });
    fireEvent.click(
      await screen.findByRole('button', {
        name: `Show the link to “Mansoor's passport”, shared with the visa agent`,
      }),
    );
    const sheet = await screen.findByRole('dialog', { name: `The link to “Mansoor's passport”` });
    expect(within(sheet).getByRole('button', { name: 'Copy the link' })).toBeVisible();
    expect(within(sheet).queryByLabelText('Text the link to')).toBeNull();
  });
});
