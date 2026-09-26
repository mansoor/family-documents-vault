import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { whenExactly } from '@fdv/shared';
import { App } from './App.js';
import {
  AISHA,
  fresh,
  installFakeApi,
  ME,
  MISSING_BIRTH_CERTIFICATE,
  PASSKEY,
  PASSPORT,
  SEALED_HIT,
  signedIn,
  STATEMENT,
  TYPES,
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
    fireEvent.change(screen.getByLabelText(/^Expires/), { target: { value: '2032-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));

    await waitFor(() => {
      const patch = state.calls.find((c) => c.method === 'PATCH');
      expect(patch?.headers?.['if-match']).toBe('"abc"');
      expect(patch?.body).toMatchObject({ expires: { date: '2032-01-31', precision: 'month' } });
    });
  });

  describe('reading a document, full size (0.4.12)', () => {
    beforeEach(() => {
      // jsdom has no object URLs; a page's is its number.
      let made = 0;
      Object.assign(URL, {
        createObjectURL: vi.fn(() => `blob:page-${++made}`),
        revokeObjectURL: vi.fn(),
      });
    });
    const pageCalls = (state: ReturnType<typeof fresh>) =>
      state.calls.filter((c) => /\/pages\/\d+$/.test(c.url)).map((c) => c.url.split('/').pop());

    it('tapping the preview opens the pages, and the arrows and keys turn them', async () => {
      const state = fresh({ pagesPending: 1 });
      installFakeApi(state);
      signedIn();
      window.history.replaceState({}, '', '/documents/doc-1');
      render(<App />);

      fireEvent.click(
        await screen.findByRole('link', { name: "Read Mansoor's passport, full size" }),
      );
      // Being drawn the first time it is asked for; then there.
      expect(
        await screen.findByRole('img', { name: "Page 1 of Mansoor's passport" }),
      ).toBeInTheDocument();
      expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
      await expectAccessible();

      fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
      await screen.findByRole('img', { name: "Page 2 of Mansoor's passport" });
      expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();

      fireEvent.keyDown(window, { key: 'ArrowLeft' });
      await screen.findByRole('img', { name: "Page 1 of Mansoor's passport" });
      // Larger, and back to fit.
      fireEvent.click(screen.getByRole('button', { name: 'Larger' }));
      expect(screen.getByRole('img', { name: /^Page 1/ })).toHaveStyle({ width: '150%' });
      fireEvent.keyDown(window, { key: '-' });
      expect(screen.getByRole<HTMLImageElement>('img', { name: /^Page 1/ }).style.width).toBe('');

      // Only the pages looked at were fetched: each one is in the activity log.
      expect(pageCalls(state)).toEqual(['1', '1', '2', '1']);
    });

    it('a long document says how long it is, and where the drawn pages end', async () => {
      const state = fresh({ pagesDrawn: 30, pageCount: 50 });
      installFakeApi(state);
      signedIn();
      window.history.replaceState({}, '', '/documents/doc-1/read?v=v-1&p=30');
      render(<App />);
      await screen.findByRole('img', { name: "Page 30 of Mansoor's passport" });
      expect(screen.getByText('Page 30 of 50')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
      expect(
        screen.getByText("Pages 31–50 aren't shown here. Download the file to read them."),
      ).toBeInTheDocument();
    });

    it('keys belong to the browser with a modifier, and to scrolling when a page is larger', async () => {
      const state = fresh();
      installFakeApi(state);
      signedIn();
      window.history.replaceState({}, '', '/documents/doc-1/read');
      render(<App />);
      await screen.findByRole('img', { name: "Page 1 of Mansoor's passport" });
      // Alt+Right is the browser's "forward": not a page turn.
      fireEvent.keyDown(window, { key: 'ArrowRight', altKey: true });
      expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
      // Made larger, the arrows scroll the page instead of turning it.
      fireEvent.keyDown(window, { key: '+' });
      fireEvent.keyDown(window, { key: 'ArrowRight' });
      expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
      fireEvent.keyDown(window, { key: '-' });
      fireEvent.keyDown(window, { key: 'ArrowRight' });
      await screen.findByRole('img', { name: "Page 2 of Mansoor's passport" });
    });

    it('a kind of file the vault cannot draw says so, and offers the file itself', async () => {
      const state = fresh({ pagesDrawn: 'unsupported' });
      installFakeApi(state);
      signedIn();
      window.history.replaceState({}, '', '/documents/doc-1/read');
      render(<App />);
      expect(
        await screen.findByText(
          "There's no preview for this kind of file. You can save a copy to open it.",
        ),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
      // Nothing to turn or enlarge.
      expect(screen.queryByRole('toolbar', { name: 'Pages' })).not.toBeInTheDocument();
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

    await screen.findByText(/We noticed something missing/);
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
    expect(screen.queryByText(/We noticed something missing/)).not.toBeInTheDocument();
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
    // Exactly when, in the table (5.1); in words when you point at it.
    expect(screen.getByTitle(/^yesterday, /)).toBeInTheDocument();
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
    // The one it was sent to is shown masked, and kept if they leave it empty (5.3).
    const address = screen.getByLabelText('The email you will sign in with');
    expect((address as HTMLInputElement).value).toBe('');
    expect(
      screen.getByText(/keep the address this was sent to \(s•••@example\.test\)/),
    ).toBeInTheDocument();
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
  it('a Save that fails is sent again with the same key, and the card stays filled', async () => {
    // A capture whose answer is lost may have been stored: sending it again
    // with the same key is answered with what was stored, not a second copy.
    const state = fresh({ captureFailures: 100 });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/add');
    render(<App />);
    const input = await screen.findByLabelText<HTMLInputElement>('Choose a file');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /choose a file/i })).toBeEnabled(),
    );
    const file = new File(['%PDF-1.4'], 'passport.pdf', {
      type: 'application/pdf',
      lastModified: 1,
    });
    fireEvent.change(input, { target: { files: [file] } });
    expect(input.value).toBe('');

    await screen.findByRole('heading', { name: 'Is this right?' });
    fireEvent.change(screen.getByLabelText('What it is'), { target: { value: 'passport' } });
    fireEvent.change(screen.getByLabelText(/^Expires/), { target: { value: 'March 2031' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    await screen.findByText(/can't reach|cannot reach|isn't answering|not answering/i);
    expect(screen.getByLabelText<HTMLSelectElement>('What it is').value).toBe('passport');

    state.captureFailures = 0;
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    await waitFor(() => expect(window.location.pathname).toBe('/documents/doc-new'));
    const keys = state.calls
      .filter((c) => c.url.startsWith('/api/v1/capture'))
      .map((c) => c.headers?.['idempotency-key']);
    expect(keys.length).toBeGreaterThan(1);
    expect(new Set(keys).size).toBe(1);
  });

  it('Add asks for the details before anything is uploaded, then sends them ahead of the file', async () => {
    const state = fresh();
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/add');
    render(<App />);
    const input = await screen.findByLabelText<HTMLInputElement>('Choose a file');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /choose a file/i })).toBeEnabled(),
    );
    fireEvent.change(input, {
      target: { files: [new File(['%PDF-1.4'], 'passport.pdf', { type: 'application/pdf' })] },
    });
    await screen.findByRole('heading', { name: 'Is this right?' });
    expect(screen.getByText(/passport\.pdf/)).toBeTruthy();
    // Nothing has been sent yet.
    expect(state.calls.filter((c) => c.url.startsWith('/api/v1/capture'))).toHaveLength(0);

    fireEvent.change(screen.getByLabelText('What it is'), { target: { value: 'passport' } });
    fireEvent.change(screen.getByLabelText(/^Expires/), { target: { value: 'March 2031' } });
    expect(
      screen.getByText("We'll remind you 9 months and 6 months before it expires."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    await waitFor(() => expect(window.location.pathname).toBe('/documents/doc-new'));

    expect(state.captures).toHaveLength(1);
    const [sent] = state.captures ?? [];
    expect(sent?.fields).toEqual(['metadata', 'file']);
    expect(sent?.metadata).toMatchObject({
      type_key: 'passport',
      title: "Mansoor's passport",
      owner_member_id: 'me',
      visibility: 'household',
      expires: { date: '2031-03-31', precision: 'month' },
    });
    expect(sent?.metadata).not.toHaveProperty('category');
  });

  it('the name uses the chosen person', async () => {
    const state = fresh({ members: [ME, AISHA] });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/add');
    render(<App />);
    const input = await screen.findByLabelText<HTMLInputElement>('Choose a file');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /choose a file/i })).toBeEnabled(),
    );
    fireEvent.change(input, {
      target: { files: [new File(['%PDF-1.4'], 'scan.pdf', { type: 'application/pdf' })] },
    });
    await screen.findByRole('heading', { name: 'Is this right?' });
    fireEvent.change(screen.getByLabelText('What it is'), { target: { value: 'passport' } });
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe("Mansoor's passport");
    fireEvent.change(screen.getByLabelText('Whose it is'), { target: { value: AISHA.id } });
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe("Aisha's passport");
    // Only me is for your own documents.
    expect(screen.getByRole('button', { name: 'Only me' })).toBeDisabled();
    // A name somebody typed is theirs to keep.
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Old passport' } });
    fireEvent.change(screen.getByLabelText('Whose it is'), { target: { value: ME.id } });
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('Old passport');
  });

  it('Skip still saves, with no details', async () => {
    const state = fresh();
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/add');
    render(<App />);
    const input = await screen.findByLabelText<HTMLInputElement>('Choose a file');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /choose a file/i })).toBeEnabled(),
    );
    fireEvent.change(input, {
      target: { files: [new File(['%PDF-1.4'], 'scan.pdf', { type: 'application/pdf' })] },
    });
    await screen.findByRole('heading', { name: 'Is this right?' });
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    await waitFor(() => expect(window.location.pathname).toBe('/documents/doc-new'));
    expect(state.captures).toEqual([{ fields: ['file'], metadata: null }]);
  });

  it('a date the card cannot read keeps the card open and says how to write it', async () => {
    const state = fresh();
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/add');
    render(<App />);
    const input = await screen.findByLabelText<HTMLInputElement>('Choose a file');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /choose a file/i })).toBeEnabled(),
    );
    fireEvent.change(input, {
      target: { files: [new File(['%PDF-1.4'], 'scan.pdf', { type: 'application/pdf' })] },
    });
    await screen.findByRole('heading', { name: 'Is this right?' });
    fireEvent.change(screen.getByLabelText('What it is'), { target: { value: 'passport' } });
    fireEvent.change(screen.getByLabelText(/^Expires/), { target: { value: 'next spring' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    await screen.findByText('The expiry date: try 14 Mar 2031, March 2031, or just 2031.');
    expect(state.captures ?? []).toHaveLength(0);
  });

  /** To the card, with a file chosen. */
  const toCard = async () => {
    const input = await screen.findByLabelText<HTMLInputElement>('Choose a file');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /choose a file/i })).toBeEnabled(),
    );
    fireEvent.change(input, {
      target: {
        files: [new File(['%PDF-1.4'], 'scan.pdf', { type: 'application/pdf', lastModified: 7 })],
      },
    });
    await screen.findByRole('heading', { name: 'Is this right?' });
  };
  const keysOf = (state: ReturnType<typeof fresh>) =>
    state.calls
      .filter((c) => c.url.startsWith('/api/v1/capture'))
      .map((c) => c.headers?.['idempotency-key']);

  it('a Save whose answer was lost, sent again after the card changed, puts the new details on what it made', async () => {
    const state = fresh({ captureAnswersLost: 1 });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/add');
    render(<App />);
    await toCard();
    fireEvent.change(screen.getByLabelText('What it is'), { target: { value: 'passport' } });
    fireEvent.change(screen.getByLabelText(/^Expires/), { target: { value: 'March 2031' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    await screen.findByText(/can't reach|cannot reach|isn't answering|not answering/i);

    // Changed before trying again: Only me.
    fireEvent.click(screen.getByRole('button', { name: 'Only me' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    await waitFor(() => expect(window.location.pathname).toBe('/documents/doc-new'));

    expect(keysOf(state)).toHaveLength(1);
    const asked = state.calls.filter((c) => c.url.startsWith('/api/v1/uploads/'));
    expect(asked).toHaveLength(1);
    expect(
      state.calls.some((c) => c.method === 'PATCH' && c.url === '/api/v1/documents/doc-new'),
    ).toBe(true);
    const moved = state.calls.find((c) => c.url === '/api/v1/documents/doc-new/visibility');
    expect(moved?.body).toEqual({ visibility: 'private' });
    expect(state.documents.find((d) => d.id === 'doc-new')?.visibility).toBe('private');
  });

  it('a Save that never landed, sent again after the card changed, goes with a new key', async () => {
    const state = fresh({ captureFailures: 1 });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/add');
    render(<App />);
    await toCard();
    fireEvent.change(screen.getByLabelText('What it is'), { target: { value: 'passport' } });
    fireEvent.change(screen.getByLabelText(/^Expires/), { target: { value: 'March 2031' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    await screen.findByText(/can't reach|cannot reach|isn't answering|not answering/i);
    fireEvent.change(screen.getByLabelText('What it is'), {
      target: { value: 'birth_certificate' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    await waitFor(() => expect(window.location.pathname).toBe('/documents/doc-new'));
    const keys = keysOf(state);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    expect(state.captures?.at(-1)?.metadata).toMatchObject({ type_key: 'birth_certificate' });
  });

  it('editing a document and changing its type keeps who can see it', async () => {
    const state = fresh({ documents: [{ ...PASSPORT, visibility: 'private' }] });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', `/documents/${PASSPORT.id}/confirm`);
    render(<App />);
    fireEvent.change(await screen.findByLabelText('What it is'), {
      target: { value: 'birth_certificate' },
    });
    expect(screen.getByRole('button', { name: 'Only me' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    await waitFor(() => expect(window.location.pathname).toBe(`/documents/${PASSPORT.id}`));
    const patch = state.calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).not.toHaveProperty('visibility');
    expect(state.calls.some((c) => c.url.endsWith('/visibility'))).toBe(false);
  });

  it('editing a document out of Only me asks to confirm it is you first (5.4)', async () => {
    const passport = { ...PASSPORT, visibility: 'private' };
    const state = fresh({ documents: [passport], stepUpNeeded: true });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', `/documents/${PASSPORT.id}/confirm`);
    render(<App />);
    await screen.findByLabelText('What it is');
    fireEvent.click(screen.getByRole('button', { name: 'Everyone' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));

    await screen.findByRole('dialog', { name: 'Just checking it is you' });
    expect(screen.getByText(/to open a document only you can see/)).toBeInTheDocument();
    expect(passport.visibility).toBe('private');
    fireEvent.change(screen.getByLabelText('Or your password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    // Confirmed, the save carries on by itself.
    await waitFor(() => expect(window.location.pathname).toBe(`/documents/${PASSPORT.id}`));
    expect(passport.visibility).toBe('household');
  });

  it('a teen is never offered Adults only, and a type that defaults to it starts as Everyone', async () => {
    const medical = {
      ...TYPES[0],
      key: 'medical_record',
      label: 'Medical record',
      expiry_driver: null,
      reminder_leads: [],
      default_visibility: 'adults' as const,
    };
    const state = fresh({ members: [{ ...ME, role: 'teen' }], types: [...TYPES, medical] });
    installFakeApi(state);
    signedIn('teen');
    window.history.replaceState({}, '', '/add');
    render(<App />);
    await toCard();
    fireEvent.change(screen.getByLabelText('What it is'), { target: { value: 'medical_record' } });
    expect(screen.getByRole('button', { name: 'Adults only' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Everyone' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('a landed Only me document handed to somebody else is un-privated first, then given', async () => {
    const state = fresh({ members: [ME, AISHA], captureAnswersLost: 1 });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/add');
    render(<App />);
    await toCard();
    fireEvent.click(screen.getByRole('button', { name: 'Only me' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    await screen.findByText(/can't reach|cannot reach|isn't answering|not answering/i);
    fireEvent.change(screen.getByLabelText('Whose it is'), { target: { value: AISHA.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    await waitFor(() => expect(window.location.pathname).toBe('/documents/doc-new'));
    const writes = state.calls
      .filter((c) => c.method !== 'GET' && c.url.startsWith('/api/v1/documents/doc-new'))
      .map((c) => `${c.method} ${c.url}`);
    expect(writes).toEqual([
      'POST /api/v1/documents/doc-new/visibility',
      'PATCH /api/v1/documents/doc-new',
    ]);
  });

  it("a teen's retry after a lost answer changes only what changed, never who can see it", async () => {
    const state = fresh({ members: [{ ...ME, role: 'teen' }, AISHA], captureAnswersLost: 1 });
    installFakeApi(state);
    signedIn('teen');
    window.history.replaceState({}, '', `/add?member=${AISHA.id}`);
    render(<App />);
    await toCard();
    // Their own documents only: nobody else is offered, whatever the link said.
    const who = screen.getByLabelText<HTMLSelectElement>('Whose it is');
    expect(who.value).toBe(ME.id);
    expect([...who.options].map((o) => o.value)).not.toContain(AISHA.id);

    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    await screen.findByText(/can't reach|cannot reach|isn't answering|not answering/i);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'School letter' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    await waitFor(() => expect(window.location.pathname).toBe('/documents/doc-new'));
    expect(state.calls.some((c) => c.url.endsWith('/visibility'))).toBe(false);
    expect(state.calls.some((c) => c.method === 'PATCH')).toBe(true);
  });

  describe('who issued it (0.4.10)', () => {
    /** Another statement, from another bank, the month before. */
    const HSBC = {
      ...STATEMENT,
      id: 'doc-3',
      title: 'HSBC statement, August 2026',
      issued_by: 'HSBC',
      issued: { date: '2026-08-31', precision: 'month' },
    };
    const BILL = {
      ...STATEMENT,
      id: 'doc-5',
      type_key: 'utility_bill',
      category: 'household',
      title: 'British Gas bill',
      issued_by: 'British Gas',
    };

    it('a list row says what it is, who issued it and when', async () => {
      const state = fresh({ documents: [PASSPORT, STATEMENT] });
      installFakeApi(state);
      signedIn();
      render(<App />);
      await screen.findByText('Barclays statement, September 2026');
      expect(await screen.findByText('Bank statement · Barclays · Sep 2026')).toBeInTheDocument();
      // Who can see it is still said, beside the line rather than in it.
      expect(screen.getByText('· Adults only', { exact: false })).toBeInTheDocument();
      expect(screen.getByText('Passport · Mar 2021')).toBeInTheDocument();
    });

    it('the card asks for the issuer in the type’s own word, and offers the household’s only as a tap', async () => {
      const state = fresh({ documents: [PASSPORT, STATEMENT, HSBC] });
      installFakeApi(state);
      signedIn();
      window.history.replaceState({}, '', '/add');
      render(<App />);
      await toCard();
      // No type yet: the plain words.
      expect(screen.getByLabelText('Issued by')).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText('What it is'), {
        target: { value: 'bank_statement' },
      });
      const field = screen.getByLabelText<HTMLInputElement>('Institution');
      await waitFor(() =>
        expect(state.calls.some((c) => c.url === '/api/v1/issuers?type_key=bank_statement')).toBe(
          true,
        ),
      );
      const chip = await screen.findByRole('button', { name: 'From Barclays?' });
      expect(screen.getByRole('button', { name: 'From HSBC?' })).toBeInTheDocument();
      // Offered, not filled in.
      expect(field.value).toBe('');
      await expectAccessible();

      fireEvent.change(screen.getByLabelText('Issued'), { target: { value: 'September 2026' } });
      chip.focus();
      fireEvent.click(chip);
      expect(field.value).toBe('Barclays');
      // The chip has gone; the keyboard's place is on the field it filled.
      expect(document.activeElement).toBe(field);
      // Nobody typed a name, so it follows the issuer and the month.
      expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe(
        'Barclays statement, September 2026',
      );
      // Answered: the questions go.
      expect(screen.queryByRole('button', { name: /^From / })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
      await waitFor(() => expect(window.location.pathname).toBe('/documents/doc-new'));
      expect(state.captures?.[0]?.metadata).toMatchObject({
        type_key: 'bank_statement',
        title: 'Barclays statement, September 2026',
        issued_by: 'Barclays',
        issued: { date: '2026-09-30', precision: 'month' },
      });
    });

    it('a name somebody typed is kept when the issuer is chosen', async () => {
      const state = fresh({ documents: [STATEMENT] });
      installFakeApi(state);
      signedIn();
      window.history.replaceState({}, '', '/add');
      render(<App />);
      await toCard();
      fireEvent.change(screen.getByLabelText('What it is'), {
        target: { value: 'bank_statement' },
      });
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Joint account' } });
      fireEvent.click(await screen.findByRole('button', { name: 'From Barclays?' }));
      expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('Joint account');
    });

    it('a file named for its issuer offers that issuer first', async () => {
      // British Gas is used more, but the file's name says Barclays.
      const state = fresh({
        documents: [STATEMENT, BILL, { ...BILL, id: 'doc-4' }],
      });
      installFakeApi(state);
      signedIn();
      window.history.replaceState({}, '', '/add');
      render(<App />);
      const input = await screen.findByLabelText<HTMLInputElement>('Choose a file');
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /choose a file/i })).toBeEnabled(),
      );
      fireEvent.change(input, {
        target: {
          files: [new File(['%PDF-1.4'], 'barclays_statement.pdf', { type: 'application/pdf' })],
        },
      });
      await screen.findByRole('heading', { name: 'Is this right?' });
      await screen.findByRole('button', { name: 'From British Gas?' });
      const offered = within(screen.getByRole('group', { name: 'Who it might be from' }))
        .getAllByRole('button')
        .map((b) => b.textContent);
      expect(offered).toEqual(['From Barclays?', 'From British Gas?']);
      expect(screen.getByLabelText<HTMLInputElement>('Issued by').value).toBe('');
    });

    it('editing a document offers who its pages say issued it, asking again while they are read', async () => {
      vi.useFakeTimers({
        shouldAdvanceTime: true,
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
      });
      try {
        const state = fresh({
          documents: [{ ...STATEMENT, title: null, issued_by: null }],
          issuerSuggestions: { 'doc-2': { state: 'pending', items: [] } },
        });
        installFakeApi(state);
        signedIn();
        window.history.replaceState({}, '', '/documents/doc-2/confirm');
        render(<App />);
        const asked = () => state.calls.filter((c) => c.url.endsWith('/issuer-suggestions')).length;
        const field = await screen.findByLabelText<HTMLInputElement>('Institution');
        await waitFor(() => expect(asked()).toBe(1));
        expect(screen.queryByRole('button', { name: /^From / })).not.toBeInTheDocument();

        // Still being read: asked again five seconds later.
        await act(() => vi.advanceTimersByTimeAsync(5_000));
        await waitFor(() => expect(asked()).toBe(2));

        // Read now: the page's answer is offered, and not filled in.
        state.issuerSuggestions = {
          'doc-2': { state: 'ready', items: [{ value: 'Barclays', source: 'page' }] },
        };
        await act(() => vi.advanceTimersByTimeAsync(5_000));
        const chip = await screen.findByRole('button', { name: 'From Barclays?' });
        expect(field.value).toBe('');
        const settled = asked();

        fireEvent.click(chip);
        expect(field.value).toBe('Barclays');
        // Answered: nobody is asked again.
        await act(() => vi.advanceTimersByTimeAsync(10_000));
        expect(asked()).toBe(settled);

        fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
        await waitFor(() => {
          const patch = state.calls.find((c) => c.method === 'PATCH');
          expect(patch?.body).toMatchObject({
            issued_by: 'Barclays',
            title: 'Barclays statement, September 2026',
          });
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('editing asks no more after a minute of pages still being read', async () => {
      vi.useFakeTimers({
        shouldAdvanceTime: true,
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
      });
      try {
        const state = fresh({
          documents: [{ ...STATEMENT, issued_by: null }],
          issuerSuggestions: { 'doc-2': { state: 'pending', items: [] } },
        });
        installFakeApi(state);
        signedIn();
        window.history.replaceState({}, '', '/documents/doc-2/confirm');
        render(<App />);
        const asked = () => state.calls.filter((c) => c.url.endsWith('/issuer-suggestions')).length;
        await screen.findByLabelText('Institution');
        await waitFor(() => expect(asked()).toBe(1));
        for (let i = 0; i < 15; i++) await act(() => vi.advanceTimersByTimeAsync(5_000));
        // Once, then every five seconds for a minute.
        expect(asked()).toBe(13);
      } finally {
        vi.useRealTimers();
      }
    });

    it('search offers who issued things as chips, and they narrow the results', async () => {
      const state = fresh({ documents: [PASSPORT, STATEMENT, HSBC] });
      installFakeApi(state);
      signedIn();
      window.history.replaceState({}, '', '/search');
      render(<App />);
      const barclays = await screen.findByRole('button', { name: 'Barclays' });
      expect(barclays).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getByRole('group', { name: 'Who it is from' })).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('Search everything'), {
        target: { value: 'statement' },
      });
      await screen.findByText('HSBC statement, August 2026');
      expect(screen.getByText('Barclays statement, September 2026')).toBeInTheDocument();
      expect(screen.getByText('Bank statement · HSBC · Aug 2026')).toBeInTheDocument();

      fireEvent.click(barclays);
      await waitFor(() =>
        expect(screen.queryByText('HSBC statement, August 2026')).not.toBeInTheDocument(),
      );
      expect(screen.getByText('Barclays statement, September 2026')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Barclays' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(
        state.calls.some((c) => c.url === '/api/v1/search?q=statement&issued_by=Barclays'),
      ).toBe(true);
      await expectAccessible();

      // With nothing typed, the chip browses.
      fireEvent.change(screen.getByLabelText('Search everything'), { target: { value: '' } });
      await waitFor(() =>
        expect(
          state.calls.some(
            (c) => c.url.startsWith('/api/v1/documents?') && c.url.includes('issued_by=Barclays'),
          ),
        ).toBe(true),
      );
      await screen.findByText('Bank statement · Barclays · Sep 2026');
      expect(screen.queryByText("Mansoor's passport")).not.toBeInTheDocument();
    });

    it('search shows no issuer chips when nothing has an issuer', async () => {
      const state = fresh();
      installFakeApi(state);
      signedIn();
      window.history.replaceState({}, '', '/search');
      render(<App />);
      await screen.findByText("Mansoor's passport");
      await waitFor(() =>
        expect(state.calls.some((c) => c.url.startsWith('/api/v1/issuers'))).toBe(true),
      );
      expect(screen.queryByRole('group', { name: 'Who it is from' })).not.toBeInTheDocument();
    });

    it('the document page names the issuer in the type’s own word', async () => {
      const state = fresh({ documents: [STATEMENT] });
      installFakeApi(state);
      signedIn();
      window.history.replaceState({}, '', '/documents/doc-2');
      render(<App />);
      await screen.findByRole('heading', { name: 'Barclays statement, September 2026' });
      const label = await screen.findByText('Institution');
      expect(label.tagName).toBe('DT');
      expect(label.nextElementSibling?.textContent).toBe('Barclays');
    });
  });
});

describe("a type's details (5.8)", () => {
  /** A passport kept without its number: the vault says what it needs. */
  const needy = () => ({
    ...PASSPORT,
    identifier: null,
    status: { value: 'needs_info', label: 'Needs a passport number' },
  });

  it('the words that say what a document needs appear wherever its status shows', async () => {
    const state = fresh({ documents: [needy()] });
    installFakeApi(state);
    signedIn();
    render(<App />);
    // Home: in what needs attention, and on the document's own row.
    await screen.findByRole('heading', { name: 'The Seikh family' });
    await waitFor(() =>
      expect(screen.getAllByText('Needs a passport number').length).toBeGreaterThanOrEqual(2),
    );
    expect(
      screen.queryByText('Everything is fine. Nothing needs your attention.'),
    ).not.toBeInTheDocument();
  });

  it('the document itself, the Needs attention list and search say it too', async () => {
    const state = fresh({ documents: [needy()] });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/documents/doc-1');
    const { unmount } = render(<App />);
    await screen.findByRole('heading', { name: "Mansoor's passport" });
    expect(screen.getByText('Needs a passport number')).toHaveClass('status', 'status-warn');
    unmount();

    window.history.replaceState({}, '', '/reminders');
    const again = render(<App />);
    await screen.findByRole('heading', { name: 'Needs attention' });
    expect(await screen.findByText('Needs a passport number')).toBeInTheDocument();
    again.unmount();

    window.history.replaceState({}, '', '/search');
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Search everything'), {
      target: { value: 'passport' },
    });
    await screen.findByText("Mansoor's passport");
    expect(screen.getByText('Needs a passport number')).toBeInTheDocument();
  });
});

describe('the quick fixes (5.1)', () => {
  it('Move to Trash asks in the app’s own dialog: Cancel and Escape keep it, confirming moves it', async () => {
    // A copy: the fake moves it to the Trash, and the next test must not find it there.
    const state = fresh({ documents: [{ ...PASSPORT }] });
    installFakeApi(state);
    signedIn();
    const browserConfirm = vi.spyOn(window, 'confirm');
    window.history.replaceState({}, '', '/documents/doc-1');
    render(<App />);
    await screen.findByRole('heading', { name: "Mansoor's passport" });
    const deletes = () => state.calls.filter((c) => c.method === 'DELETE');

    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Move to Trash?' });
    // Enter never does it by accident: the answer that keeps it is where focus starts.
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await expectAccessible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    await screen.findByRole('alertdialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(deletes()).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    const again = await screen.findByRole('alertdialog');
    fireEvent.click(within(again).getByRole('button', { name: 'Move to Trash' }));
    await waitFor(() =>
      expect(deletes().map((c) => c.url)).toEqual([expect.stringMatching(/\/documents\/doc-1$/)]),
    );
    expect(browserConfirm).not.toHaveBeenCalled();
  });

  it('a viewer, who cannot move anything to the Trash, is not offered it', async () => {
    installFakeApi(fresh({ documents: [{ ...PASSPORT }] }));
    signedIn('viewer');
    window.history.replaceState({}, '', '/documents/doc-1');
    render(<App />);
    await screen.findByRole('heading', { name: "Mansoor's passport" });
    expect(screen.queryByRole('button', { name: 'Move to Trash' })).not.toBeInTheDocument();
  });

  it('the Trash lists what was moved there, and brings it back', async () => {
    const state = fresh({ documents: [{ ...PASSPORT, deleted_at: '2026-09-26T10:04:00Z' }] });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/settings/trash');
    render(<App />);
    await screen.findByRole('heading', { name: 'Trash' });
    expect(await screen.findByText("Mansoor's passport")).toBeInTheDocument();
    expect(
      screen.getByText(`Moved to the Trash ${whenExactly('2026-09-26T10:04:00Z')}`),
    ).toBeInTheDocument();
    await expectAccessible();

    fireEvent.click(screen.getByRole('button', { name: "Bring it back: Mansoor's passport" }));
    expect(await screen.findByText('The Trash is empty.')).toBeInTheDocument();
    const news = screen.getByRole('status');
    expect(news).toHaveTextContent('is back');
    // The button that had focus went with its row: the news has it now.
    expect(news).toHaveFocus();
    expect(
      state.calls.some((c) => c.method === 'POST' && c.url.endsWith('/documents/doc-1/restore')),
    ).toBe(true);
  });

  it('a document’s history says who added each version, and exactly when', async () => {
    installFakeApi(fresh({ documents: [{ ...PASSPORT }] }));
    signedIn();
    window.history.replaceState({}, '', '/documents/doc-1');
    render(<App />);
    expect(
      await screen.findByText(
        new RegExp(`added ${whenExactly('2026-09-20T09:14:00Z')} by Mansoor Seikh`),
      ),
    ).toBeInTheDocument();
  });

  it('"We noticed something missing" folds away, says how many, and is remembered', async () => {
    installFakeApi(fresh({ suggestions: [{ ...MISSING_BIRTH_CERTIFICATE }] }));
    signedIn();
    const first = render(<App />);
    const toggle = await screen.findByRole('button', { name: 'We noticed something missing (1)' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('No birth certificate for Aisha')).toBeVisible();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('No birth certificate for Aisha')).not.toBeVisible();
    await expectAccessible();

    // Folded it stays, on this browser.
    first.unmount();
    render(<App />);
    const later = await screen.findByRole('button', { name: 'We noticed something missing (1)' });
    expect(later).toHaveAttribute('aria-expanded', 'false');
  });

  it('"What has been happening" is a table: exactly when, and what happened', async () => {
    const state = fresh({
      activity: [
        {
          id: 1,
          at: '2026-09-25T14:05:00Z',
          text: 'Mansoor moved “Water bill” to the Trash',
          notable: false,
          document_id: null,
        },
      ],
    });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/settings/activity');
    render(<App />);
    const table = await screen.findByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['When', 'What happened']);
    expect(
      await within(table).findByText('Mansoor moved “Water bill” to the Trash'),
    ).toBeInTheDocument();
    expect(within(table).getByText(whenExactly('2026-09-25T14:05:00Z'))).toBeInTheDocument();
    await expectAccessible();
  });

  it('while it is on its way, neither Cancel nor Escape pretends to take it back', async () => {
    let release: () => void = () => undefined;
    const state = fresh({
      documents: [{ ...PASSPORT }],
      holdDelete: new Promise<void>((r) => {
        release = r;
      }),
    });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/documents/doc-1');
    render(<App />);
    await screen.findByRole('heading', { name: "Mansoor's passport" });
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move to Trash' }));
    expect(
      await within(dialog).findByRole('button', { name: 'Moving to Trash…' }),
    ).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    await act(async () => release());
    await screen.findByText(/Everything is fine|thing.* need/);
  });

  it('a teen is offered the Trash, and a way back, only for their own documents', async () => {
    const theirs = { ...PASSPORT, owner_member_id: 'm-0' };
    installFakeApi(fresh({ documents: [theirs] }));
    signedIn('teen');
    window.history.replaceState({}, '', '/documents/doc-1');
    const first = render(<App />);
    await screen.findByRole('heading', { name: "Mansoor's passport" });
    expect(screen.queryByRole('button', { name: 'Move to Trash' })).not.toBeInTheDocument();
    first.unmount();

    installFakeApi(fresh({ documents: [{ ...theirs, deleted_at: '2026-09-26T10:04:00Z' }] }));
    // A new fake vault: the first one rotated the refresh token it knew.
    signedIn('teen');
    window.history.replaceState({}, '', '/settings/trash');
    render(<App />);
    expect(await screen.findByText("Mansoor's passport")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Bring it back/ })).not.toBeInTheDocument();
  });

  it('the Trash shows every page, not only the first', async () => {
    const binned = (id: string, title: string) => ({
      ...PASSPORT,
      id,
      title,
      deleted_at: '2026-09-26T10:04:00Z',
    });
    installFakeApi(
      fresh({ documents: [binned('d-1', 'Old lease'), binned('d-2', 'Old policy')], pageSize: 1 }),
    );
    signedIn();
    window.history.replaceState({}, '', '/settings/trash');
    render(<App />);
    expect(await screen.findByText('Old lease')).toBeInTheDocument();
    expect(screen.queryByText('Old policy')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show older' }));
    expect(await screen.findByText('Old policy')).toBeInTheDocument();
    // The end: no button to come round again.
    expect(screen.queryByRole('button', { name: 'Show older' })).not.toBeInTheDocument();
  });
});
