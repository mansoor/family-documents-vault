import { SHARE_CODE_TRUTH, SHARE_CODE_UNAVAILABLE, zonedParts } from '@fdv/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { AISHA, fresh, installFakeApi, ME, signedIn } from './test-api.js';

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

const TOKEN = 'drop-secret-0123456789abcdef';

/** A request as GET /upload-requests gives it (UploadRequestView). */
function request(over: Record<string, unknown> = {}): Record<string, unknown> & { id: string } {
  return {
    id: 'req-a',
    title: 'Tax papers for 2025',
    message: null,
    items: [{ id: 'i1', label: 'W-2' }],
    recipient_label: 'Jane, accountant',
    recipient_email: null,
    requested_by_name: ME.display_name,
    mine: true,
    created_at: '2026-09-30T10:00:00Z',
    expires_at: new Date(Date.now() + 10 * 864e5).toISOString(),
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
    ...over,
  };
}

/** The form, opened from Sharing, as an owner unless said. */
async function openForm(over: Parameters<typeof fresh>[0] = {}, role: 'owner' | 'adult' = 'owner') {
  const state = fresh({ timezone: 'Europe/London', ...over });
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', '/settings/sharing');
  render(<App />);
  fireEvent.click(await screen.findByRole('link', { name: 'Ask for documents' }));
  await screen.findByRole('heading', { name: 'What you are asking for' });
  // Loaded: the button waits for what the vault can do.
  await waitFor(() => expect(screen.getByRole('button', { name: 'Make the link' })).toBeEnabled());
  return state;
}

const madeBody = (state: ReturnType<typeof fresh>) =>
  state.calls.find((c) => c.method === 'POST' && c.url === '/api/v1/upload-requests')?.body as
    Record<string, unknown> | undefined;

/**
 * Ask for documents (5.22): the form owners and adults fill, the hand-over
 * that shows the link and a made-up password once, and Sharing's list of
 * requests.
 */
describe('asking for documents', () => {
  it('an owner asks from Sharing: what was chosen is sent, and the hand-over gives the /drop# link', async () => {
    const state = await openForm();
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: ' Tax papers ' } });
    fireEvent.change(screen.getByLabelText('A message for them'), {
      target: { value: 'Everything for the return.' },
    });
    // Named things to send: one to start, another added, an empty one left out.
    fireEvent.change(screen.getByLabelText('Thing to send 1'), { target: { value: 'W-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add another' }));
    await waitFor(() => expect(screen.getByLabelText('Thing to send 2')).toHaveFocus());
    fireEvent.change(screen.getByLabelText('Thing to send 2'), { target: { value: '1099' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add another' }));
    fireEvent.change(screen.getByLabelText('Who is it for?'), {
      target: { value: 'Jane, accountant' },
    });
    const protect = screen.getByRole('group', { name: 'Protect it' });
    fireEvent.click(within(protect).getByLabelText(/ask for a password/));
    fireEvent.click(within(protect).getByLabelText('This browser only'));
    fireEvent.click(within(protect).getByLabelText('Only so many visits'));
    fireEvent.change(screen.getByLabelText('Visits, at most'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Files, at most'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('In all (MB)'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Also Word and Excel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Any adult' }));
    fireEvent.click(screen.getByLabelText('Close it once they press Finish'));
    await expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Make the link' }));

    const handover = await screen.findByTestId('request-handover');
    expect(
      within(handover).getByRole('heading', { name: 'The link for Jane, accountant' }),
    ).toBeInTheDocument();
    expect(within(handover).getByText(new RegExp(`/drop#${TOKEN}$`))).toBeInTheDocument();
    expect(within(handover).getByText('It asks for W-2, 1099.')).toBeInTheDocument();
    expect(within(handover).getByText(/They can send 5 files, 50 MB in all/)).toBeInTheDocument();
    expect(within(handover).getByText('It can be opened twice.')).toBeInTheDocument();
    expect(
      within(handover).getByText('It opens only in the first browser that opens it.'),
    ).toBeInTheDocument();
    expect(madeBody(state)).toMatchObject({
      title: 'Tax papers',
      message: 'Everything for the return.',
      items: ['W-2', '1099'],
      recipient_label: 'Jane, accountant',
      with_password: true,
      this_device_only: true,
      max_visits: 2,
      max_files: 5,
      max_total_bytes: 50 * 1024 * 1024,
      accept_types: 'office',
      review_by: 'adults',
      close_after_submit: true,
    });
    expect(madeBody(state)).not.toHaveProperty('email_code');
    expect(madeBody(state)).not.toHaveProperty('suggested_member_id');
    await expectAccessible();
  });

  it('the password is shown once', async () => {
    const state = await openForm();
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'Tax papers' } });
    fireEvent.click(screen.getByLabelText(/ask for a password/));
    expect(screen.getByRole('button', { name: 'Make one up for me' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Make the link' }));

    // Here, once, with how to give it.
    const shown = await screen.findByTestId('request-password');
    expect(shown).toHaveTextContent('k7mq-p2xa-9htw');
    expect(shown).toHaveTextContent(/shown only now/);
    expect(shown).toHaveTextContent(/dashes and all/);
    expect(madeBody(state)).toMatchObject({ with_password: true });
    expect(madeBody(state)).not.toHaveProperty('password');

    // Done: back to Sharing, where the request is listed and the password is nowhere.
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    const list = await screen.findByRole('list', { name: 'Requests that work now' });
    await within(list).findByText('“Tax papers”');
    expect(screen.queryByText('k7mq-p2xa-9htw')).not.toBeInTheDocument();
    expect(screen.queryByTestId('request-password')).not.toBeInTheDocument();
    // Nor does the list hold it: the vault never gives it again.
    expect(JSON.stringify(state.uploadRequests)).not.toContain('k7mq-p2xa-9htw');
  });

  it('a typed password is 8 characters at least, goes as typed, and is not shown back', async () => {
    const state = await openForm();
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'Tax papers' } });
    fireEvent.click(screen.getByLabelText(/ask for a password/));
    fireEvent.click(screen.getByRole('button', { name: 'I’ll type one' }));
    fireEvent.change(screen.getByLabelText('The password'), { target: { value: 'short' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/At least 8 characters/);
    fireEvent.click(screen.getByRole('button', { name: 'Make the link' }));
    expect(madeBody(state)).toBeUndefined();
    fireEvent.change(screen.getByLabelText('The password'), {
      target: { value: 'River Otter 7' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Make the link' }));
    await screen.findByTestId('request-handover');
    expect(madeBody(state)).toMatchObject({ password: 'River Otter 7' });
    expect(screen.queryByTestId('request-password')).not.toBeInTheDocument();
    expect(screen.getByText('They will be asked for the password you chose.')).toBeInTheDocument();
  });

  it('the code option is disabled, with the reason, when operator mail is off', async () => {
    const state = await openForm({ operatorMail: false });
    const protect = screen.getByRole('group', { name: 'Protect it' });
    const code = within(protect).getByLabelText(/email them a code/);
    expect(code).toBeDisabled();
    expect(code).not.toBeChecked();
    // The reason, said with it and heard with it.
    const why = screen.getByTestId('ask-code-unavailable');
    expect(why).toHaveTextContent(SHARE_CODE_UNAVAILABLE);
    expect(code).toHaveAccessibleDescription(new RegExp(SHARE_CODE_UNAVAILABLE.slice(0, 40)));
    expect(screen.queryByLabelText('Their email address')).not.toBeInTheDocument();
    // A password, this browser only and visits are there all the same.
    expect(within(protect).getByLabelText(/ask for a password/)).toBeEnabled();
    expect(within(protect).getByLabelText('This browser only')).toBeEnabled();
    expect(within(protect).getByLabelText('Only so many visits')).toBeEnabled();
    await expectAccessible();
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'Tax papers' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make the link' }));
    await screen.findByTestId('request-handover');
    expect(madeBody(state)).not.toHaveProperty('email_code');
    expect(madeBody(state)).not.toHaveProperty('recipient_email');
  });

  it('with operator mail, a code goes to the address typed, with the plain truth', async () => {
    const state = await openForm({ operatorMail: true });
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'Tax papers' } });
    const code = screen.getByLabelText(/email them a code/);
    expect(code).toBeEnabled();
    expect(code).toHaveAccessibleDescription(SHARE_CODE_TRUTH);
    fireEvent.click(code);
    fireEvent.change(screen.getByLabelText('Their email address'), {
      target: { value: 'not an address' },
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/name@example.com/);
    fireEvent.click(screen.getByRole('button', { name: 'Make the link' }));
    expect(madeBody(state)).toBeUndefined();
    fireEvent.change(screen.getByLabelText('Their email address'), {
      target: { value: ' jane.smith@example.com ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Make the link' }));
    await screen.findByTestId('request-handover');
    expect(madeBody(state)).toMatchObject({
      email_code: true,
      recipient_email: 'jane.smith@example.com',
    });
    expect(screen.getByText(/a code is emailed to j•••@e•••\.com/)).toBeInTheDocument();
  });

  it('a title is asked for, and an end past 90 days is refused before anything is sent', async () => {
    const state = await openForm();
    fireEvent.click(screen.getByRole('button', { name: 'Make the link' }));
    expect(await screen.findByText('Say what you are asking for.')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Title/)).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'Tax papers' } });
    const far = zonedParts(new Date(Date.now() + 100 * 864e5), 'Europe/London').date;
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: far } });
    expect(screen.getByText('A request can last 90 days at most.')).toHaveAttribute(
      'role',
      'alert',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Make the link' }));
    expect(madeBody(state)).toBeUndefined();
  });

  it('from a person’s page, the request says whose they probably are', async () => {
    const state = fresh({ members: [ME, AISHA] });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/people/m-0');
    render(<App />);
    fireEvent.click(await screen.findByRole('link', { name: 'Ask someone for Aisha’s documents' }));
    await screen.findByRole('heading', { name: 'What you are asking for' });
    await waitFor(() =>
      expect(screen.getByLabelText('Whose documents are they?')).toHaveValue('m-0'),
    );
    expect(screen.getByText(/You will be told it is probably Aisha’s/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'School reports' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make the link' }));
    await screen.findByTestId('request-handover');
    expect(madeBody(state)).toMatchObject({ suggested_member_id: 'm-0' });
    // Done goes back to her page.
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await screen.findByRole('link', { name: 'Ask someone for Aisha’s documents' });
  });

  it('a teen or a viewer is never offered it, and never asks', async () => {
    for (const role of ['teen', 'viewer'] as const) {
      const state = fresh({ members: [{ ...ME, role }, AISHA] });
      installFakeApi(state);
      signedIn(role);
      window.history.replaceState({}, '', '/people/m-0');
      const { unmount } = render(<App />);
      await screen.findByRole('heading', { name: 'Aisha' });
      expect(screen.queryByRole('link', { name: /Ask someone for/ })).not.toBeInTheDocument();
      unmount();
      window.history.replaceState({}, '', '/settings/sharing/ask');
      const again = render(<App />);
      expect(
        await screen.findByText('Only an owner or an adult can ask someone to send documents.'),
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Make the link' })).not.toBeInTheDocument();
      again.unmount();
      window.history.replaceState({}, '', '/settings/sharing');
      const sharing = render(<App />);
      await screen.findByRole('heading', { name: 'Sharing' });
      expect(
        screen.queryByRole('heading', { name: 'Asking for documents' }),
      ).not.toBeInTheDocument();
      sharing.unmount();
      expect(state.calls.some((c) => c.url.startsWith('/api/v1/upload-requests'))).toBe(false);
    }
  });
});

describe('Sharing lists requests (5.22)', () => {
  const openSharing = async (
    requests: Array<Record<string, unknown> & { id: string }>,
    role: 'owner' | 'adult' = 'owner',
  ) => {
    const state = fresh({ uploadRequests: requests });
    installFakeApi(state);
    signedIn(role);
    window.history.replaceState({}, '', '/settings/sharing');
    render(<App />);
    await screen.findByRole('heading', { name: 'Asking for documents' });
    return state;
  };

  it('files received, visits used and where each stands; ended ones apart', async () => {
    await openSharing([
      request(),
      request({
        id: 'req-b',
        title: 'Lease papers',
        recipient_label: null,
        mine: false,
        requested_by_name: 'Sam',
        review_by: 'adults',
        max_visits: null,
        visits_used: 0,
        files_received: 0,
      }),
      request({ id: 'req-c', title: 'Old request', state: 'revoked', files_received: 1 }),
    ]);
    const live = await screen.findByRole('list', { name: 'Requests that work now' });
    const [first, second] = within(live).getAllByRole('listitem');
    expect(first).toHaveTextContent('“Tax papers for 2025”');
    expect(first).toHaveTextContent('For Jane, accountant');
    expect(first).toHaveTextContent('2 files received · 1 of 3 visits used');
    expect(first).toHaveTextContent(/Working until/);
    expect(second).toHaveTextContent('Asked by Sam · Any adult looks at what comes in');
    expect(second).toHaveTextContent('No files yet · Not opened yet');
    const ended = screen.getByRole('list', { name: 'Requests that have ended' });
    expect(within(ended).getByText('Taken back')).toBeInTheDocument();
    expect(within(ended).queryByRole('button')).not.toBeInTheDocument();
    await expectAccessible();
  });

  it('a request is taken back after asking, and the focus comes back to the page', async () => {
    const state = await openSharing([request()]);
    const live = await screen.findByRole('list', { name: 'Requests that work now' });
    const takeBack = within(live).getByRole('button', {
      name: 'Take back the request “Tax papers for 2025” to Jane, accountant',
    });
    fireEvent.click(takeBack);
    const dialog = await screen.findByRole('alertdialog', { name: 'Take this request back?' });
    expect(dialog).toHaveTextContent(/What they have sent already stays/);
    // Cancel is a real answer: nothing is taken back.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(takeBack).toHaveFocus());
    expect(state.calls.some((c) => c.method === 'DELETE')).toBe(false);

    fireEvent.click(takeBack);
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Take it back' }),
    );
    const said = await screen.findByText(
      /The request “Tax papers for 2025” to Jane, accountant is taken back/,
    );
    await waitFor(() => expect(said).toHaveFocus());
    expect(
      state.calls.some((c) => c.method === 'DELETE' && c.url === '/api/v1/upload-requests/req-a'),
    ).toBe(true);
    expect(
      within(screen.getByRole('list', { name: 'Requests that have ended' })).getByText(
        'Taken back',
      ),
    ).toBeInTheDocument();
  });

  it('an owner turns a request a restore paused back on; an adult is not offered to', async () => {
    const paused = request({ state: 'paused', paused_reason: 'restored' });
    const state = await openSharing([paused]);
    const live = await screen.findByRole('list', { name: 'Requests that work now' });
    expect(within(live).getByText('Paused after a restore')).toBeInTheDocument();
    fireEvent.click(within(live).getByRole('button', { name: 'Turn back on' }));
    const said = await screen.findByText(/works again\./);
    await waitFor(() => expect(said).toHaveFocus());
    expect(state.calls.some((c) => c.url === '/api/v1/upload-requests/req-a/resume')).toBe(true);
    await waitFor(() => expect(within(live).getByText(/Working until/)).toBeInTheDocument());
  });

  it('to an adult a paused request offers only Take it back', async () => {
    await openSharing([request({ state: 'paused', paused_reason: 'restored' })], 'adult');
    const live = await screen.findByRole('list', { name: 'Requests that work now' });
    expect(within(live).getByText('Paused after a restore')).toBeInTheDocument();
    expect(within(live).queryByRole('button', { name: 'Turn back on' })).not.toBeInTheDocument();
    expect(within(live).getByRole('button', { name: /Take back/ })).toBeInTheDocument();
  });
});

describe('the share sheet’s protections, at 320 px (5.22 polish)', () => {
  it('“This browser only” has its note just under its label, in its own box, heard with it', async () => {
    const state = fresh({ timezone: 'Europe/London' });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/documents/doc-1');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Share a link' }));
    const protect = await screen.findByRole('group', { name: 'Protect it' });
    const box = within(protect).getByLabelText('This browser only');
    const note = within(protect).getByText(/only one it will open in/);
    // In the box's grid (.check-noted), not a sibling under the row's tap height.
    expect(note.closest('.check')).toBe(box.closest('.check'));
    expect(box.closest('.check')).toHaveClass('check-noted');
    expect(note).toHaveAttribute('id', 'share-device-note');
    expect(box).toHaveAccessibleDescription(/only one it will open in/);
    await expectAccessible();
  });
});
