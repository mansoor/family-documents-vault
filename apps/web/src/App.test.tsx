import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';

const caps = (setup_required: boolean) => ({
  product: 'family-document-vault',
  server_version: '0.0.3',
  api_version: 1,
  min_client_version: '0.0.1',
  edition: 'self_hosted',
  protection_mode: 'standard',
  setup_required,
  features: {},
  limits: {},
  deprecations: [],
  branding: { display_name: 'The Seikh family' },
});

const tokens = {
  access_token: 'a.b.c',
  expires_in: 900,
  refresh_token: 'hh.secret',
  refresh_expires_in: 1,
  household_id: 'hh',
  member_id: 'mm',
  role: 'owner',
  scopes_unlocked: ['household'],
};

type Route = (init?: RequestInit) => Response | Error;

function mockApi(routes: Record<string, Route>) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const key = `${init?.method ?? 'GET'} ${url}`;
    const route = routes[key];
    if (!route) return Promise.reject(new Error(`unmocked ${key}`));
    const r = route(init);
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('App', () => {
  it('shows the failure copy when the vault is unreachable', async () => {
    mockApi({ 'GET /api/v1/capabilities': () => new TypeError('Failed to fetch') });
    render(<App />);
    expect(await screen.findByText('Not connected')).toBeInTheDocument();
    expect(screen.getByText(/can't reach the vault/)).toBeInTheDocument();
  });

  it('runs the first-run setup and lands on home', async () => {
    const fetchMock = mockApi({
      'GET /api/v1/capabilities': () => Response.json(caps(true)),
      'POST /api/v1/setup': () => Response.json(tokens, { status: 201 }),
      'GET /api/v1/me': () =>
        Response.json({ account_id: 'a', household_id: 'hh', member_id: 'mm', role: 'owner' }),
      'GET /api/v1/auth/sessions': () =>
        Response.json({ items: [{ id: 's1', current: true, user_agent: 'Windows' }] }),
    });
    render(<App />);
    expect(await screen.findByRole('heading', { name: /Set up your family/ })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/call your family/), {
      target: { value: 'The Seikh family' },
    });
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Mansoor' } });
    fireEvent.change(screen.getByLabelText('Your email'), { target: { value: 'm@example.test' } });
    fireEvent.change(screen.getByLabelText('Choose a password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create my vault' }));

    expect(await screen.findByText('You are signed in.')).toBeInTheDocument();
    expect(await screen.findByText(/Role: owner/)).toBeInTheDocument();
    expect(await screen.findByText(/Windows computer/)).toBeInTheDocument();

    const setupCall = fetchMock.mock.calls.find((c) => c[0] === '/api/v1/setup');
    expect(JSON.parse(setupCall?.[1]?.body as string)).toMatchObject({
      household_name: 'The Seikh family',
      email: 'm@example.test',
    });
    expect(JSON.parse(localStorage.getItem('fdv.session') ?? '{}')).toMatchObject({
      household_id: 'hh',
    });
  });

  it('shows sign-in when set up, and surfaces the server message on a wrong password', async () => {
    mockApi({
      'GET /api/v1/capabilities': () => Response.json(caps(false)),
      'POST /api/v1/auth/password': () =>
        Response.json(
          {
            error: { code: 'invalid_credentials', message: "That email and password don't match." },
          },
          { status: 401 },
        ),
    });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'The Seikh family' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'm@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'nope nope nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent("That email and password don't match."),
    );
  });

  it('resumes a stored session by refreshing, and falls back to sign-in when refused', async () => {
    localStorage.setItem(
      'fdv.session',
      JSON.stringify({
        refresh_token: 'hh.old',
        household_id: 'hh',
        member_id: 'mm',
        role: 'adult',
      }),
    );
    mockApi({
      'GET /api/v1/capabilities': () => Response.json(caps(false)),
      'POST /api/v1/auth/refresh': () =>
        Response.json(
          { error: { code: 'session_ended', message: 'Please sign in again.' } },
          { status: 401 },
        ),
    });
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(localStorage.getItem('fdv.session')).toBeNull();
  });
});
