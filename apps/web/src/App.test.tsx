import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';

const caps = {
  product: 'family-document-vault',
  server_version: '0.2.0',
  api_version: 1,
  min_client_version: '0.0.1',
  edition: 'self_hosted',
  protection_mode: 'standard',
  features: {},
  limits: {},
  deprecations: [],
  branding: { display_name: 'The Seikh family' },
};

function mockFetch(response: Response | Error) {
  const fn = vi.fn(() =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('App', () => {
  it('shows the household name and server version once connected', async () => {
    mockFetch(Response.json(caps));
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'The Seikh family' })).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText(/Server 0\.2\.0/)).toBeInTheDocument();
  });

  it('shows a plain-language failure when the vault cannot be reached', async () => {
    mockFetch(new TypeError('Failed to fetch'));
    render(<App />);
    expect(await screen.findByText('Not connected')).toBeInTheDocument();
    expect(screen.getByText(/can't reach the vault/)).toBeInTheDocument();
  });

  it('surfaces the server error message verbatim when the API answers with the envelope', async () => {
    mockFetch(
      Response.json(
        { error: { code: 'not_ready', message: 'The vault is starting up.', retriable: true } },
        { status: 503 },
      ),
    );
    render(<App />);
    expect(await screen.findByText('The vault is starting up.')).toBeInTheDocument();
  });
});
