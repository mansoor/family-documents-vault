import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { fresh, installFakeApi, signedIn, type FakeState } from './test-api.js';

/**
 * The refresh token in the vault's HttpOnly cookie, never in localStorage
 * (0.9.0); a token an older version kept spent once for one; and "Sign out
 * my other devices" in Settings → Your account.
 */

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});
afterEach(cleanup);

const kept = () =>
  JSON.parse(localStorage.getItem('fdv.session') ?? 'null') as {
    refresh_token: string;
    member_id: string;
  } | null;

const refreshes = (state: FakeState) =>
  state.calls.filter((c) => c.url.endsWith('/api/v1/auth/refresh'));

describe('the refresh token in a cookie (0.9.0)', () => {
  it('renews with the cookie, asks for it as one on every request, and keeps no token', async () => {
    const state = fresh();
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/settings/account');
    render(<App />);
    await screen.findByRole('heading', { name: 'Your account' });
    await waitFor(() => expect(state.refreshesBy).toEqual(['cookie']));
    for (const c of state.calls.filter((x) => x.url.startsWith('/api/'))) {
      expect(c.headers?.['x-fdv-refresh'], c.url).toBe('cookie');
    }
    expect(refreshes(state)[0]?.body).toEqual({});
    expect(kept()?.refresh_token).toBe('');
  });

  it('a refresh token an older version kept is spent once for the cookie, then forgotten', async () => {
    const state = fresh();
    installFakeApi(state);
    localStorage.setItem(
      'fdv.session',
      JSON.stringify({
        refresh_token: 'hh.secret',
        household_id: 'hh',
        member_id: 'me',
        role: 'owner',
      }),
    );
    window.history.replaceState({}, '', '/settings/account');
    render(<App />);
    await screen.findByRole('heading', { name: 'Your account' });
    await waitFor(() => expect(state.refreshesBy).toEqual(['body']));
    expect(refreshes(state)[0]?.body).toEqual({ refresh_token: 'hh.secret' });
    // Still signed in, as the same person; the token gone from the page's reach.
    expect(kept()).toMatchObject({ refresh_token: '', member_id: 'me' });
    expect(localStorage.getItem('fdv.session')).not.toContain('hh.secret');
  });

  it('a sign-in keeps no refresh token in localStorage, whatever the answer says', async () => {
    const state = fresh();
    installFakeApi(state);
    window.history.replaceState({}, '', '/sign-in');
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: 'me@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(kept()).not.toBeNull());
    expect(kept()?.refresh_token).toBe('');
  });
});

describe('Sign out my other devices (0.9.0)', () => {
  const sessions = () => [
    {
      id: 's-here',
      current: true,
      user_agent: null,
      ip: null,
      created_at: '2026-11-01T09:00:00.000Z',
      last_used_at: '2026-11-19T09:00:00.000Z',
      label: 'Firefox on a Mac',
    },
    {
      id: 's-phone',
      current: false,
      user_agent: null,
      ip: null,
      created_at: '2026-11-02T09:00:00.000Z',
      last_used_at: '2026-11-18T09:00:00.000Z',
      label: 'the app on a Google Pixel 8a',
    },
    {
      id: 's-laptop',
      current: false,
      user_agent: null,
      ip: null,
      created_at: '2026-11-03T09:00:00.000Z',
      last_used_at: '2026-11-17T09:00:00.000Z',
      label: 'Chrome on a Windows computer',
    },
  ];

  it('asks first, then confirms it is you, then signs every other device out', async () => {
    const state = fresh({ sessions: sessions(), stepUpNeeded: true });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/settings/account');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out my other devices' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Sign out your other devices?' });
    // Asked, and nothing done yet.
    expect(state.calls.filter((c) => c.url.endsWith('/sign-out-others')).length).toBe(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign them out' }));
    // Confirming it's you, with the password.
    fireEvent.change(await screen.findByLabelText('Or your password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Your 2 other devices are signed out.')).toBeInTheDocument();
    expect(state.sessions?.map((s) => s.id)).toEqual(['s-here']);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Sign out my other devices' })).toBeNull(),
    );
  });

  it('Cancel signs nobody out', async () => {
    const state = fresh({ sessions: sessions() });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/settings/account');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out my other devices' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Sign out your other devices?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(state.calls.filter((c) => c.url.endsWith('/sign-out-others'))).toEqual([]);
    expect(state.sessions).toHaveLength(3);
  });

  it('is not offered when this is the only device signed in', async () => {
    const state = fresh({
      sessions: [sessions()[0] as NonNullable<FakeState['sessions']>[number]],
    });
    installFakeApi(state);
    signedIn();
    window.history.replaceState({}, '', '/settings/account');
    render(<App />);
    await screen.findByText(/this one/);
    expect(screen.queryByRole('button', { name: 'Sign out my other devices' })).toBeNull();
  });
});

describe('signing out when the vault could not be told (0.9.0)', () => {
  const logouts = (state: FakeState) =>
    state.calls.filter((c) => c.url.endsWith('/api/v1/auth/logout'));
  const signOut = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Menu' }));
    const drawer = await screen.findByRole('dialog', { name: 'Menu' });
    await act(async () => {
      fireEvent.click(within(drawer).getByRole('button', { name: 'Sign out' }));
    });
    await waitFor(() => expect(localStorage.getItem('fdv.session')).toBeNull());
  };

  it('a sign-out the vault refused is finished with the cookie', async () => {
    const state = fresh();
    let refused = 0;
    state.refuseWith = (method, path) =>
      path === '/api/v1/auth/logout' && refused++ === 0
        ? { status: 503, code: 'not_ready', message: 'The vault is starting up.' }
        : undefined;
    installFakeApi(state);
    signedIn();
    render(<App />);
    await signOut();
    await waitFor(() => expect(logouts(state)).toHaveLength(2));
    const [withToken, byCookie] = logouts(state);
    expect(withToken?.headers?.authorization).toMatch(/^Bearer /);
    expect(byCookie?.headers?.authorization).toBeUndefined();
    expect(byCookie?.headers?.['x-fdv-refresh']).toBe('cookie');
    expect(localStorage.getItem('fdv.logout-pending')).toBeNull();
  });

  it('offline, the sign-out is remembered and sent as the app next loads, before the sign-in page', async () => {
    const state = fresh();
    installFakeApi(state);
    signedIn();
    render(<App />);
    await screen.findByRole('button', { name: 'Menu' });
    state.offline = true;
    await signOut();
    expect(localStorage.getItem('fdv.logout-pending')).toBe('1');
    cleanup();

    // The next load, back online.
    state.offline = false;
    state.calls.length = 0;
    window.history.replaceState({}, '', '/');
    render(<App />);
    await screen.findByRole('heading', { name: 'Every important paper, in one place.' });
    const sent = logouts(state);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers?.authorization).toBeUndefined();
    expect(sent[0]?.headers?.['x-fdv-refresh']).toBe('cookie');
    expect(localStorage.getItem('fdv.logout-pending')).toBeNull();
  });

  it('a new sign-in before the next load is not ended by the old sign-out', async () => {
    localStorage.setItem('fdv.logout-pending', '1');
    const state = fresh();
    state.offline = true;
    installFakeApi(state);
    window.history.replaceState({}, '', '/sign-in');
    render(<App />);
    state.offline = false;
    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: 'me@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(kept()).not.toBeNull());
    expect(localStorage.getItem('fdv.logout-pending')).toBeNull();
  });
});
