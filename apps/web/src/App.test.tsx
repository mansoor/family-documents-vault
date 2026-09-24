import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import {
  AISHA,
  fresh,
  installFakeApi,
  ME,
  MISSING_BIRTH_CERTIFICATE,
  PASSKEY,
  SEALED_HIT,
  signedIn,
} from './test-api.js';

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});
afterEach(() => vi.unstubAllGlobals());

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

describe('App', () => {
  it('shows the failure copy when the vault is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    render(<App />);
    await screen.findByText('Not connected');
    expect(screen.getByText(/can't reach the vault/)).toBeInTheDocument();
  });

  it('runs the whole first-run wizard: account → questions → people → starting list', async () => {
    const state = fresh({ setupRequired: true, members: [] });
    installFakeApi(state);
    render(<App />);

    await screen.findByRole('heading', { name: /Set up your family/ });
    await expectAccessible();
    fireEvent.change(screen.getByLabelText(/call your family/), {
      target: { value: 'The Seikh family' },
    });
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Mansoor' } });
    fireEvent.change(screen.getByLabelText('Your email'), { target: { value: 'm@example.test' } });
    fireEvent.change(screen.getByLabelText('Choose a password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create my vault' }));

    await screen.findByRole('heading', { name: 'A few quick questions' });
    fireEvent.click(screen.getByRole('button', { name: 'We own it' }));
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Children' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await screen.findByRole('heading', { name: 'Who is in the family?' });
    const profileCall = state.calls.find((c) => c.method === 'PUT' && c.url === '/api/v1/profile');
    expect(profileCall?.body).toMatchObject({
      owns_home: true,
      rents_home: false,
      vehicle_count: 2,
    });

    fireEvent.change(screen.getByLabelText('Name of another family member'), {
      target: { value: 'Aisha' },
    });
    // A child's date of birth is what makes the birth-certificate
    // suggestion possible later; it is optional and asked for once.
    fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: '2016-04-02' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByText('Aisha');
    expect(
      state.calls.find((c) => c.method === 'POST' && c.url === '/api/v1/members')?.body,
    ).toMatchObject({ display_name: 'Aisha', date_of_birth: '2016-04-02' });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await screen.findByRole('heading', { name: 'Your starting list' });
    expect(screen.getByText('Home insurance and deed')).toBeInTheDocument();
    expect(screen.getByText(/For your 2 vehicles/)).toBeInTheDocument();
    await expectAccessible();
  });

  it('signs in and shows home with the household name, people, tiles and recent documents', async () => {
    const state = fresh();
    installFakeApi(state);
    render(<App />);
    await screen.findByRole('heading', { name: 'Every important paper, in one place.' });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: 'm@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await screen.findByRole('heading', { name: 'The Seikh family' });
    await screen.findByText('Everything is fine. Nothing needs your attention.');
    await screen.findByText('1 item');
    expect(screen.getAllByText('Identity').length).toBeGreaterThan(0);
    expect(screen.getByText("Mansoor's passport")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add a document' })).toBeInTheDocument();
    await expectAccessible();
  });

  it('opens a document, edits it on the confirm card, and saves with the ETag', async () => {
    const state = fresh();
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/documents/doc-1');
    render(<App />);
    await screen.findByRole('heading', { name: "Mansoor's passport" });
    expect(screen.getByText('14 Mar 2021')).toBeInTheDocument();
    expect(screen.getByText('March 2031')).toBeInTheDocument();
    expect(screen.getByText('Bedroom safe, top shelf')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'Edit' }));
    await screen.findByRole('heading', { name: 'Is this right?' });
    fireEvent.change(screen.getByLabelText('Expires'), { target: { value: '2032-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));

    await waitFor(() => {
      const patch = state.calls.find((c) => c.method === 'PATCH');
      expect(patch?.headers?.['if-match']).toBe('"abc"');
      expect(patch?.body).toMatchObject({ expires: { date: '2032-01-31', precision: 'month' } });
    });
  });

  it('reloading Settings with an expired access token signs nobody out', async () => {
    // Settings loads four panels at once, and after a reload none of them
    // has an access token. Until 0.4.3 each refreshed on its own; the
    // server saw one refresh token presented four times, took it as theft
    // and ended the session — so a reload of Settings was a sign-out.
    const state = fresh();
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/settings');
    render(<App />);
    await waitFor(() =>
      expect(state.calls.filter((c) => c.url.startsWith('/api/v1/auth/sessions'))).toHaveLength(1),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(state.refreshCalls).toBe(1);
    expect(state.sessionEnded).toBe(false);
    expect(window.location.pathname).toBe('/settings');
  });

  it('losing the network says so, instead of showing an empty household', async () => {
    const state = fresh({ offline: true });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/');
    render(<App />);
    expect(await screen.findByText(/can't reach the vault right now/)).toBeInTheDocument();
    // Said on the screen that asked, not by replacing the whole app.
    expect(screen.queryByText('Not connected')).toBeNull();
    // No answer is not "signed out": the session is still there for later.
    expect(localStorage.getItem('fdv.session')).not.toBeNull();
  });

  it('searches and renders snippets with highlights but without scripts', async () => {
    const state = fresh();
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/search');
    render(<App />);
    const box = await screen.findByLabelText('Search everything');
    fireEvent.change(box, { target: { value: 'policy 4471' } });
    await screen.findByText('Home insurance policy');
    const em = document.querySelector('.snippet em');
    expect(em?.textContent).toBe('4471');
    expect(document.querySelector('.snippet script')).toBeNull();
    expect(screen.getByText(/searched inside the pages too/)).toBeInTheDocument();
  });

  it('falls back to sign-in when the stored session is refused', async () => {
    const state = fresh();
    const fetchMock = installFakeApi(state);
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        Response.json({
          product: 'family-document-vault',
          server_version: '0.1.5',
          api_version: 1,
          min_client_version: '0.0.1',
          edition: 'self_hosted',
          protection_mode: 'standard',
          setup_required: false,
          features: {},
          limits: {},
          deprecations: [],
          branding: { display_name: 'The Seikh family' },
        }),
      ),
    );
    // Any subsequent call answers 401 for the refresh.
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/auth/refresh')) {
        return Promise.resolve(
          Response.json(
            { error: { code: 'session_ended', message: 'Please sign in again.' } },
            { status: 401 },
          ),
        );
      }
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    signedIn();
    render(<App />);
    await screen.findByRole('heading', { name: 'Every important paper, in one place.' });
    expect(localStorage.getItem('fdv.session')).toBeNull();
  });
  it('draws an outline for a document the family does not have, and offers to add it', async () => {
    const state = fresh({
      members: [ME, AISHA],
      suggestions: [{ ...MISSING_BIRTH_CERTIFICATE }],
    });
    installFakeApi(state);
    signedIn();
    render(<App />);

    await screen.findByText('We noticed something missing');
    expect(screen.getByText('No birth certificate for Aisha')).toBeInTheDocument();
    expect(screen.getByText(/Schools, passports and benefits/)).toBeInTheDocument();
    await expectAccessible();

    // Missing is not an alarm: the red strip stays calm.
    expect(screen.getByText(/Everything is fine/)).toBeInTheDocument();

    // And it leads to Add with the type and the person already chosen.
    fireEvent.click(screen.getByRole('link', { name: /Add it/ }));
    await screen.findByRole('heading', { name: 'Add a document' });
    expect(window.location.search).toBe('?type=birth_certificate&member=m-0');
    expect(await screen.findByText(/Adding a birth certificate for Aisha/)).toBeInTheDocument();
  });

  it('"Not for us" hides a suggestion, and it can be brought back', async () => {
    const state = fresh({ suggestions: [{ ...MISSING_BIRTH_CERTIFICATE }] });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/reminders');
    render(<App />);

    await screen.findByText('No birth certificate for Aisha');
    fireEvent.click(screen.getByRole('button', { name: 'Not for us' }));

    await waitFor(() =>
      expect(screen.queryByText('No birth certificate for Aisha')).not.toBeInTheDocument(),
    );
    expect(
      state.calls.some(
        (c) =>
          c.method === 'POST' &&
          c.url === '/api/v1/suggestions/minor_needs_birth_certificate%3Am-0/dismiss',
      ),
    ).toBe(true);

    fireEvent.click(await screen.findByRole('button', { name: '1 hidden' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show it again' }));
    await screen.findByText('No birth certificate for Aisha');
  });
  it('searches the caller’s own private documents in a second pass', async () => {
    const state = fresh({ sealed: [{ ...SEALED_HIT }] });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/search');
    render(<App />);
    const box = await screen.findByLabelText('Search everything');
    fireEvent.change(box, { target: { value: 'estate' } });

    // The indexed pass has nothing; the sealed pass does.
    await screen.findByText('Also in your private documents');
    expect(screen.getByText(/Only you can see these/)).toBeInTheDocument();
    expect(screen.getByText('Notes to myself')).toBeInTheDocument();
    expect(document.querySelector('.snippet em')?.textContent).toBe('estate');
    // The count covers both passes: no "0 documents" above a result.
    expect(screen.getByText(/1 document, searched inside the pages too/)).toBeInTheDocument();
    expect(state.calls.some((c) => c.url === '/api/v1/search/sealed?token=sealed-handle')).toBe(
      true,
    );
    await expectAccessible();
  });

  it('says so plainly when nothing in the private documents matched', async () => {
    const state = fresh({ sealed: [{ ...SEALED_HIT }] });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/search');
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Search everything'), {
      target: { value: 'zqxjkv' },
    });
    await screen.findByText('Nothing in your 1 private document matched.');
  });
  it('lists passkeys, removes one, and says why it cannot add another here', async () => {
    const state = fresh({ passkeys: [{ ...PASSKEY }] });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/settings');
    render(<App />);

    await screen.findByRole('heading', { name: 'Passkeys' });
    await screen.findByText("Mansoor's phone");
    expect(screen.getByText(/synced to your other devices/)).toBeInTheDocument();
    // jsdom has no authenticator, so the honest thing is to say so rather
    // than offer a button that cannot work.
    expect(screen.getByText('This browser cannot make passkeys.')).toBeInTheDocument();
    await expectAccessible();

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0] as HTMLElement);
    await waitFor(() => expect(screen.queryByText("Mansoor's phone")).not.toBeInTheDocument());
    expect(
      state.calls.some((c) => c.method === 'DELETE' && c.url === '/api/v1/auth/passkeys/pk-1'),
    ).toBe(true);
    await screen.findByText('None yet.');
  });
  it('asks who is asking before exporting, then carries on by itself', async () => {
    const state = fresh({ stepUpNeeded: true });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/settings');
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Make an export' }));
    await screen.findByRole('dialog', { name: 'Just checking it is you' });
    expect(screen.getByText(/to export everything/)).toBeInTheDocument();
    await expectAccessible();

    // The wrong password does not get through.
    fireEvent.change(screen.getByLabelText('Or your password'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByText("That didn't match. Try again.");

    fireEvent.change(screen.getByLabelText('Or your password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    // The prompt closes and the export the person asked for happens —
    // they do not have to press the button again.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const exportCalls = state.calls.filter(
      (c) => c.method === 'POST' && c.url === '/api/v1/exports',
    );
    expect(exportCalls).toHaveLength(2);
  });

  it('cancelling the prompt does nothing at all', async () => {
    const state = fresh({ stepUpNeeded: true });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/settings');
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Make an export' }));
    await screen.findByRole('dialog', { name: 'Just checking it is you' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(
      state.calls.filter((c) => c.method === 'POST' && c.url === '/api/v1/exports'),
    ).toHaveLength(1);
  });
  it('invites another adult and shows the two halves exactly once', async () => {
    const state = fresh({ members: [ME, AISHA] });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/people');
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Invite someone to sign in' }));
    fireEvent.change(screen.getByLabelText('Their name'), { target: { value: 'Sam' } });
    fireEvent.change(screen.getByLabelText('Their email address'), {
      target: { value: 'sam@example.test' },
    });
    // An owner may hand out any role; the description changes with the choice.
    fireEvent.click(screen.getByRole('button', { name: 'Teen' }));
    expect(screen.getByText(/anything shared with the whole family/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Adult' }));

    fireEvent.click(screen.getByRole('button', { name: 'Make the invitation' }));
    await screen.findByRole('heading', { name: 'Send these to Sam' });
    expect(screen.getByText(/\/join\/link-secret-0123456789abcdef/)).toBeInTheDocument();
    expect(screen.getByText('ABCD-EFGH')).toBeInTheDocument();
    expect(screen.getByText(/only time they are shown/)).toBeInTheDocument();
    await expectAccessible();

    // Closing the card puts them in the waiting list, without the secrets.
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await screen.findByRole('heading', { name: 'Waiting to be accepted' });
    expect(screen.queryByText('ABCD-EFGH')).not.toBeInTheDocument();
  });

  it('a teen is not offered the invite button at all', async () => {
    const state = fresh();
    installFakeApi(state);
    signedIn('teen');
    window.history.replaceState({}, '', '/people');
    render(<App />);

    await screen.findByRole('heading', { name: 'People' });
    expect(
      screen.queryByRole('button', { name: 'Invite someone to sign in' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add someone' })).not.toBeInTheDocument();
    // And the screen never asks the server for something it may not have.
    expect(state.calls.some((c) => c.url === '/api/v1/invitations')).toBe(false);
  });

  it('a viewer is shown nothing they would be refused', async () => {
    const state = fresh({ suggestions: [MISSING_BIRTH_CERTIFICATE], members: [ME, AISHA] });
    installFakeApi(state);
    signedIn('viewer');
    render(<App />);

    // What they came for is there…
    await screen.findByText("Mansoor's passport");
    // …and the things a viewer cannot do are simply not on the screen: no
    // add button, no add-a-person chip, and no list of jobs for somebody
    // else to do.
    expect(screen.queryByLabelText('Add a document')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Add a person')).not.toBeInTheDocument();
    expect(screen.queryByText('We noticed something missing')).not.toBeInTheDocument();
    await expectAccessible();
  });

  it('asking to take away an owner’s role says it waits, and they can refuse', async () => {
    const coOwner = { ...AISHA, id: 'm-1', display_name: 'Sam', has_account: true, role: 'owner' };
    const state = fresh({ members: [ME, coOwner] });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/people/m-1');
    render(<App />);

    await screen.findByRole('heading', { name: 'What Sam can do' });
    fireEvent.click(screen.getByRole('button', { name: 'Adult' }));
    // Before pressing anything, the screen says what will and will not
    // happen — the seven days are the feature, not a technicality.
    expect(screen.getByText(/takes seven days/)).toBeInTheDocument();
    await expectAccessible();

    fireEvent.click(screen.getByRole('button', { name: 'Change what they can do' }));
    await screen.findByText(/Every owner has been told/);
    // Sam is still an owner until it is carried out.
    expect(state.members.find((m) => m.id === 'm-1')?.role).toBe('owner');

    // And it is waiting on the People screen, where nobody has to look for it.
    window.history.replaceState({}, '', '/people');
    fireEvent.click(screen.getByRole('link', { name: 'People' }));
    await screen.findByText(/asked for Sam to stop being an owner/);
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw it' }));
    await waitFor(() => expect(screen.queryByText(/stop being an owner/)).not.toBeInTheDocument());
  });

  it('taking a sign-in away says what survives it', async () => {
    const kid = { ...AISHA, id: 'm-1', display_name: 'Aisha', has_account: true, role: 'teen' };
    const state = fresh({ members: [ME, kid] });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/people/m-1');
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Take away their sign-in' }));
    expect(screen.getByText(/their documents are untouched/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, take their sign-in away' }));
    await waitFor(() => expect(state.members.find((m) => m.id === 'm-1')?.role).toBeNull());

    // The way back is their own sign-in, given back — not an invitation,
    // which would hand their private documents to whoever accepted it.
    expect(
      await screen.findByRole('heading', { name: 'Give Aisha their sign-in back' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Nobody else can be given this sign-in/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Teen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Give it back' }));
    await waitFor(() => expect(state.members.find((m) => m.id === 'm-1')?.role).toBe('teen'));
  });

  it('shares one document by link, and says exactly what the link can do', async () => {
    const state = fresh();
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/documents/doc-1');
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Share a link' }));
    fireEvent.change(screen.getByLabelText('Who is it for?'), {
      target: { value: 'the letting agent' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Make the link' }));

    await screen.findByText(/\/shared\/share-secret-0123456789abcdef/);
    expect(
      screen.getByText(/this one document until it expires, and nothing else/),
    ).toBeInTheDocument();
    expect(screen.getByText(/every time it is opened/)).toBeInTheDocument();
    await expectAccessible();

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    // Back to the document, with the live link listed and takeable back.
    await screen.findByText(/Shared with the letting agent, not opened yet/);
    fireEvent.click(screen.getByRole('button', { name: 'Take it back' }));
    await waitFor(() => expect(state.shares).toHaveLength(0));
  });

  it('a PIN is shown separately, with the reason', async () => {
    const state = fresh();
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/documents/doc-1');
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Share a link' }));
    fireEvent.click(screen.getByLabelText(/four-digit PIN/));
    fireEvent.click(screen.getByRole('button', { name: 'Make the link' }));

    await screen.findByText('4821');
    expect(screen.getByText(/not the same message/)).toBeInTheDocument();
  });

  it('the person at the other end gets the document and nothing else', async () => {
    installFakeApi(fresh());
    window.history.replaceState({}, '', '/shared/share-secret-0123456789abcdef');
    render(<App />);

    await screen.findByRole('heading', { name: 'Flat 3 tenancy agreement' });
    expect(screen.getByText('Mansoor Seikh')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Download tenancy.pdf/ })).toBeInTheDocument();
    expect(screen.getByText(/They can see that you opened it/)).toBeInTheDocument();
    // No sign of the rest of the vault: no navigation, no search, no sign-in.
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
    await expectAccessible();
  });

  it('a PIN on a link withholds the title until it is right', async () => {
    installFakeApi(fresh({ sharePin: '4821' }));
    window.history.replaceState({}, '', '/shared/share-secret-0123456789abcdef');
    render(<App />);

    await screen.findByText(/put a PIN on it/);
    // The title is not on the page yet.
    expect(screen.queryByText('Flat 3 tenancy agreement')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/four-digit PIN they gave you/), {
      target: { value: '0000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open the document' }));
    await screen.findByText(/That PIN is not right/);

    fireEvent.change(screen.getByLabelText(/four-digit PIN they gave you/), {
      target: { value: '4821' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open the document' }));
    await screen.findByRole('heading', { name: 'Flat 3 tenancy agreement' });
  });

  it('a link that has been taken back says so, without saying what it was', async () => {
    installFakeApi(fresh({ shareValid: false }));
    window.history.replaceState({}, '', '/shared/nope');
    render(<App />);

    await screen.findByRole('heading', { name: 'This link cannot be opened' });
    expect(screen.getByText(/Ask whoever sent it/)).toBeInTheDocument();
    expect(screen.queryByText(/tenancy/i)).not.toBeInTheDocument();
  });

  it('the activity log reads like sentences with times', async () => {
    const state = fresh({
      activity: [
        {
          id: 3,
          at: new Date(Date.now() - 864e5).toISOString(),
          text: 'Sarah downloaded “Home insurance policy”',
          notable: false,
          document_id: 'doc-1',
        },
        {
          id: 2,
          at: new Date(Date.now() - 3 * 864e5).toISOString(),
          text: 'Sarah changed where the files are kept',
          notable: true,
          document_id: null,
        },
      ],
    });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/settings/activity');
    render(<App />);

    await screen.findByText('Sarah downloaded “Home insurance policy”');
    expect(screen.getByText(/^yesterday, /)).toBeInTheDocument();
    expect(screen.getByText(/private documents are only ever in your copy/)).toBeInTheDocument();
    await expectAccessible();
  });

  it('marking a document private says the thing that has to be said, once', async () => {
    const state = fresh();
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/documents/doc-1');
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Change who can see this' }));
    fireEvent.click(screen.getByRole('button', { name: 'Only me' }));
    expect(screen.getByText(/Nobody else, including the owner of this vault/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // The sentence, at the moment it becomes true.
    await screen.findByRole('heading', { name: 'Only you can open this' });
    expect(screen.getByText(/unless you leave a key/)).toBeInTheDocument();
    await expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'I understand' }));

    // And never again for this document: the server decides, and says null.
    await screen.findByRole('button', { name: 'Change who can see this' });
    fireEvent.click(screen.getByRole('button', { name: 'Change who can see this' }));
    fireEvent.click(screen.getByRole('button', { name: 'Everyone in the family' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { name: 'Only you can open this' }),
      ).not.toBeInTheDocument(),
    );
  });

  it('changes a password, and says what comes with it', async () => {
    const state = fresh();
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/settings');
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Change your password' }));
    // The thing a person would not guess: it is also the key to their own
    // private documents, and the other devices go.
    expect(screen.getByText(/also unlocks your own private documents/)).toBeInTheDocument();
    expect(screen.getByText(/Every other device/)).toBeInTheDocument();
    await expectAccessible();

    fireEvent.change(screen.getByLabelText('Your password now'), {
      target: { value: 'wrong one entirely' },
    });
    fireEvent.change(screen.getByLabelText('Your new password'), {
      target: { value: 'a whole new password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Change it' }));
    await screen.findByText("That isn't your current password.");

    fireEvent.change(screen.getByLabelText('Your password now'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Change it' }));
    await screen.findByText(/Your password is changed/);
    expect(state.passwordChanged).toBe('a whole new password');
  });

  it('somebody with only a passkey is asked to prove it is them instead', async () => {
    const state = fresh({ stepUpNeeded: true });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/settings');
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Change your password' }));
    fireEvent.change(screen.getByLabelText('Your new password'), {
      target: { value: 'set without the old one' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Change it' }));

    await screen.findByRole('dialog', { name: 'Just checking it is you' });
    expect(screen.getByText(/to set a new password/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Or your password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    // The prompt hands control back and the change goes through by itself.
    await waitFor(() => expect(state.passwordChanged).toBe('set without the old one'));
  });

  it('a forgotten password answers the same way whoever asks', async () => {
    const state = fresh();
    installFakeApi(state);
    window.history.replaceState({}, '', '/sign-in');
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'I have forgotten my password' }));
    await screen.findByRole('heading', { name: 'Forgotten your password' });
    fireEvent.change(screen.getByLabelText('Your email'), {
      target: { value: 'nobody@example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send me a link' }));

    await screen.findByText(/If that address has a sign-in here/);
    // And it says the two things a self-hoster needs to know when nothing
    // arrives, including why another adult cannot do it for them.
    expect(screen.getByText(/ask whoever runs the\s+vault/)).toBeInTheDocument();
    expect(screen.getByText(/way into your private documents/)).toBeInTheDocument();
    await expectAccessible();
  });

  it('the reset link says whose account it is, then sends you to sign in again', async () => {
    const state = fresh();
    installFakeApi(state);
    window.history.replaceState({}, '', '/reset/reset-secret-0123456789abcdef');
    render(<App />);

    await screen.findByRole('heading', { name: 'Set a new password' });
    expect(screen.getByText('mansoor@example.test')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Your new password'), {
      target: { value: 'a brand new password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Set my new password' }));

    // Not signed in by it: two-step sign-in must still be asked for.
    await screen.findByRole('heading', { name: 'That is done' });
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(state.passwordChanged).toBe('a brand new password');
  });

  it('a reset link that has been used says so, and offers a new one', async () => {
    installFakeApi(fresh({ resetValid: false }));
    window.history.replaceState({}, '', '/reset/nope');
    render(<App />);

    await screen.findByRole('heading', { name: 'This link cannot be used' });
    fireEvent.click(screen.getByRole('button', { name: 'Ask for a new one' }));
    await screen.findByRole('heading', { name: 'Forgotten your password' });
  });

  it('joining says whose vault it is before asking for anything', async () => {
    const state = fresh();
    installFakeApi(state);
    window.history.replaceState({}, '', '/join/link-secret-0123456789abcdef');
    render(<App />);

    await screen.findByRole('heading', { name: 'Join The Seikh family' });
    expect(screen.getByText('Mansoor Seikh')).toBeInTheDocument();
    expect(screen.getByText(/Cannot change storage or remove people/)).toBeInTheDocument();
    await expectAccessible();

    // The address they sign in with is theirs to choose: resets go there.
    const address = screen.getByLabelText('The email you will sign in with');
    expect((address as HTMLInputElement).value).toMatch(/@/);
    expect(screen.getByText(/an address only you can read/)).toBeInTheDocument();
    fireEvent.change(address, { target: { value: 'me@my-own.example.test' } });
    expect((address as HTMLInputElement).value).toBe('me@my-own.example.test');

    // A wrong code is an ordinary mistake, and says how many tries are left.
    fireEvent.change(screen.getByLabelText('The code they gave you'), {
      target: { value: 'ZZZZ-ZZZZ' },
    });
    fireEvent.change(screen.getByLabelText('Choose a password'), {
      target: { value: 'a long enough password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Join the family vault' }));
    await screen.findByText('That code is not right. 4 tries left.');

    fireEvent.change(screen.getByLabelText('The code they gave you'), {
      target: { value: 'abcd efgh' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Join the family vault' }));
    // Straight into the signed-in app: no second sign-in step.
    await screen.findByRole('heading', { name: 'The Seikh family' });
  });

  it('an invitation that is no longer valid says so, and offers the way back', async () => {
    installFakeApi(fresh({ invitationValid: false }));
    window.history.replaceState({}, '', '/join/nope');
    render(<App />);
    await screen.findByRole('heading', { name: 'This invitation cannot be used' });
    expect(screen.getByText(/Ask whoever invited you/)).toBeInTheDocument();
    await expectAccessible();
  });
  it('the same file chosen again after a failure is sent again, with the same key', async () => {
    // A capture whose answer is lost may have been stored: sending it again
    // with the same key is answered with what was stored, not a second
    // copy. The file input is cleared after each choice, or choosing the
    // same file again would not reach the app at all.
    const state = fresh({ captureFailures: 100 });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/add');
    render(<App />);
    const input = await screen.findByLabelText<HTMLInputElement>('Choose a file');
    const file = new File(['%PDF-1.4'], 'passport.pdf', {
      type: 'application/pdf',
      lastModified: 1,
    });

    fireEvent.change(input, { target: { files: [file] } });
    await screen.findByText(/can't reach|cannot reach|isn't answering|not answering/i);
    expect(input.value).toBe('');

    state.captureFailures = 0;
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(window.location.pathname).toBe('/documents/doc-new/confirm'));
    const keys = state.calls
      .filter((c) => c.url.startsWith('/api/v1/capture'))
      .map((c) => c.headers?.['idempotency-key']);
    expect(keys.length).toBeGreaterThan(1);
    expect(new Set(keys).size).toBe(1);
  });
});
