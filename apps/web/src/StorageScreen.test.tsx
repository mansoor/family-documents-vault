import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VaultRow } from './api.js';
import { Session } from './session.js';
import { StorageScreen } from './StorageScreen.js';

const local: VaultRow = {
  id: 'v-local',
  kind: 'local',
  provider: null,
  label: 'This computer',
  endpoint: null,
  bucket: null,
  region: null,
  prefix: null,
  path_style: false,
  role: 'primary',
  status: 'ok',
  active: true,
  last_verified_at: '2026-09-22T00:00:00Z',
  last_error: null,
};
const providers = [
  {
    key: 'b2',
    name: 'Backblaze B2',
    endpoint: 'https://s3.{region}.backblazeb2.com',
    pathStyle: false,
    hint: 'h',
  },
  {
    key: 'minio',
    name: 'MinIO on my own server',
    endpoint: 'http://minio:9000',
    pathStyle: true,
    hint: 'h',
  },
];

function session(): Session {
  const s = new Session();
  s.accept({
    access_token: 'tok',
    expires_in: 900,
    refresh_token: 'hh.x',
    refresh_expires_in: 1,
    household_id: 'hh',
    member_id: 'mm',
    role: 'owner',
    scopes_unlocked: [],
  });
  return s;
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('StorageScreen', () => {
  it('lists places, marks the one in use, and runs the add-and-test flow', async () => {
    const calls: string[] = [];
    let vaults: VaultRow[] = [local];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const key = `${init?.method ?? 'GET'} ${url}`;
        calls.push(key);
        if (key === 'GET /api/v1/vaults') return Promise.resolve(Response.json({ items: vaults }));
        if (key === 'GET /api/v1/vaults/providers')
          return Promise.resolve(Response.json(providers));
        if (key === 'POST /api/v1/vaults') {
          const body = JSON.parse(init?.body as string) as { bucket: string; endpoint: string };
          expect(body.bucket).toBe('seikh-family-docs');
          expect(body.endpoint).toBe('http://minio:9000');
          vaults = [
            ...vaults,
            {
              ...local,
              id: 'v-s3',
              kind: 's3',
              label: 'MinIO on my own server',
              bucket: 'seikh-family-docs',
              endpoint: 'http://minio:9000',
              status: 'untested',
              active: false,
            },
          ];
          return Promise.resolve(Response.json(vaults[1], { status: 201 }));
        }
        if (key === 'POST /api/v1/vaults/v-s3/test') {
          vaults = vaults.map((v) => (v.id === 'v-s3' ? { ...v, status: 'ok' } : v));
          return Promise.resolve(
            Response.json({
              ok: true,
              message: 'Connected. Your files will be stored in seikh-family-docs at MinIO.',
            }),
          );
        }
        if (key === 'POST /api/v1/vaults/v-s3/activate') {
          vaults = vaults.map((v) => ({ ...v, active: v.id === 'v-s3' }));
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        return Promise.reject(new Error(`unmocked ${key}`));
      }),
    );

    render(
      <StorageScreen session={session()} onSignedOut={() => undefined} onBack={() => undefined} />,
    );
    expect(await screen.findByText('This computer')).toBeInTheDocument();
    expect(screen.getByText('In use')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'minio' } });
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'http://minio:9000' } });
    fireEvent.change(screen.getByLabelText('Bucket name'), {
      target: { value: 'seikh-family-docs' },
    });
    fireEvent.change(screen.getByLabelText('Key ID'), { target: { value: 'k' } });
    fireEvent.change(screen.getByLabelText('Application key'), { target: { value: 's' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test and save this place' }));

    expect(await screen.findByRole('status')).toHaveTextContent(/^Connected\./);
    expect(await screen.findByRole('button', { name: 'Use this' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Use this' }));
    await waitFor(() => expect(calls).toContain('POST /api/v1/vaults/v-s3/activate'));
    expect(await screen.findByText(/New files will be kept there/)).toBeInTheDocument();
  });
});
