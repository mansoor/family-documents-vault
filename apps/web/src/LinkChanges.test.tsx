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

describe('a link changed from Sharing (0.9.0, LK)', () => {
  it('opens the form it was made with, filled in, and sends only what changed, with its version', async () => {
    const state = at('/sharing', { shares: [{ ...MINE }, { ...THEIRS }] });
    const live = await screen.findByRole('list', { name: 'Links that work now' });
    await within(live).findByText(/the embassy/);
    // Only the reader's own.
    expect(
      within(live).queryByRole('button', { name: /^Change the link .*the embassy/ }),
    ).toBeNull();
    const change = within(live).getByRole('button', {
      name: `Change the link to “Mansoor's passport”, shared with the visa agent`,
    });
    change.focus();
    fireEvent.click(change);
    const sheet = await screen.findByRole('dialog', {
      name: `Change the link to “Mansoor's passport”`,
    });
    // The app's one dialog (0.9.0-dev.67), wide: no longer a narrow panel.
    expectSharedDialog(sheet, `Change the link to “Mansoor's passport”`, 'Cancel');
    expect(sheet).toHaveClass('dialog-wide');
    expect(within(sheet).getByLabelText('Who is it for?')).toHaveValue('the visa agent');
    expect(within(sheet).getByLabelText('Can be opened')).toHaveValue('5');
    expect(within(sheet).getByLabelText('Keep its PIN')).toBeChecked();
    expect(within(sheet).getByRole('button', { name: 'Save the changes' })).toBeDisabled();
    expect(within(sheet).getByText('Nothing is changed yet.')).toBeInTheDocument();
    await expectAccessible();

    fireEvent.change(within(sheet).getByLabelText('Who is it for?'), {
      target: { value: 'the new agent' },
    });
    fireEvent.change(within(sheet).getByLabelText('Can be opened'), { target: { value: '3' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save the changes' }));
    expect(
      await screen.findByText(`The link to “Mansoor's passport” is changed.`),
    ).toBeInTheDocument();
    const sent = state.calls.filter((c) => c.url === `/api/v1/shares/${MINE.id}`);
    expect(sent.map((c) => [c.method, c.body, c.headers?.['if-match']])).toEqual([
      ['PATCH', { recipient_label: 'the new agent', max_opens: 3 }, '"1"'],
    ]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('asks who is asking before it reaches further, then shows a new PIN once, with Copy', async () => {
    const state = at('/sharing', { shares: [{ ...MINE }], stepUpNeeded: true });
    const copied = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: copied } });
    fireEvent.click(
      await screen.findByRole('button', {
        name: `Change the link to “Mansoor's passport”, shared with the visa agent`,
      }),
    );
    const sheet = await screen.findByRole('dialog', {
      name: `Change the link to “Mansoor's passport”`,
    });
    fireEvent.click(within(sheet).getByLabelText('A new four-digit PIN'));
    expect(within(sheet).getByText(/The old PIN stops working at once/)).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save the changes' }));
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
      await screen.findByRole('button', {
        name: `Change the link to “Mansoor's passport”, shared with the embassy`,
      }),
    );
    const sheet = await screen.findByRole('dialog', {
      name: `Change the link to “Mansoor's passport”`,
    });
    expect(
      within(sheet).getByText(/Only whoever made it can change its PIN or password/),
    ).toBeInTheDocument();
    expect(within(sheet).queryByLabelText('A new four-digit PIN')).toBeNull();
    expect(
      within(sheet).getByText(
        /It emails a code to j•••@e•••\.com when it is opened\. To send the code somewhere else, take this link back and make a new one\./,
      ),
    ).toBeInTheDocument();
    expect(
      within(sheet).getByText(/It opens only in the first browser that opened it/),
    ).toBeInTheDocument();
    await expectAccessible();
  });

  it('a link that has ended has no Change', async () => {
    at('/sharing', {
      shares: [{ ...MINE, state: 'revoked', changeable: false, revealable: false }],
    });
    await screen.findByRole('heading', { name: 'No longer working' });
    expect(screen.queryByRole('button', { name: /^Change the link/ })).toBeNull();
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
      await screen.findByText(/Only whoever asked can change its password/),
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
      within(sheet).getByText(/never what you ask for, and never its password/),
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
