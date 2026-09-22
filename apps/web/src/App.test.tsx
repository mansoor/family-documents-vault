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
});
