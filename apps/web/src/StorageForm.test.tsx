import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';
import type { NewVault, Provider } from './api.js';
import { AddPlace } from './screens/Settings.js';

/**
 * Settings → Storage (where your files are kept) → Add another place (the owner,
 * 23 Oct): each half of a key called what its provider calls it, and how
 * the bucket is addressed shown and changeable under Advanced — the
 * provider's own way unless changed (MinIO and "something else": path
 * style; the hosted ones: virtual-hosted).
 */

const PROVIDERS: Provider[] = [
  {
    key: 'b2',
    name: 'Backblaze B2',
    endpoint: 'https://s3.{region}.backblazeb2.com',
    pathStyle: false,
    hint: '',
  },
  { key: 'aws', name: 'Amazon S3', endpoint: null, pathStyle: false, hint: '' },
  {
    key: 'minio',
    name: 'MinIO on my own server',
    endpoint: 'http://minio:9000',
    pathStyle: true,
    hint: '',
  },
  {
    key: 'other',
    name: 'Something else with an S3 address',
    endpoint: '',
    pathStyle: true,
    hint: '',
  },
];

function form() {
  const onAdd = vi.fn<(body: NewVault) => Promise<{ ok: boolean; message: string } | null>>(
    async () => ({ ok: true, message: 'Saved.' }),
  );
  render(<AddPlace providers={PROVIDERS} onAdd={onAdd} />);
  return onAdd;
}

function fill(endpoint: string) {
  fireEvent.change(screen.getByLabelText('Address'), { target: { value: endpoint } });
  fireEvent.change(screen.getByLabelText('Bucket name'), { target: { value: 'family' } });
  fireEvent.change(screen.getByLabelText(/^(Access key|Key ID)/), { target: { value: 'AKID' } });
  fireEvent.change(screen.getByLabelText(/^(Secret|Application key)/), {
    target: { value: 's3cr3t' },
  });
}

describe('adding a place for the files', () => {
  it('calls the two halves of a key what the provider calls them, and says which is the secret', async () => {
    form();
    expect(screen.getByLabelText('Key ID (keyID)')).toBeInTheDocument();
    expect(screen.getByLabelText('Application key (applicationKey)')).toHaveAttribute(
      'type',
      'password',
    );
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'minio' } });
    expect(screen.getByLabelText('Access key')).toHaveAccessibleDescription(
      'Names the key, like a user name; it is not secret.',
    );
    expect(screen.getByLabelText('Secret key')).toHaveAccessibleDescription(
      /^The key.s password, shown once when you make the key\. The vault keeps it encrypted\.$/,
    );
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'aws' } });
    expect(screen.getByLabelText('Access key ID')).toBeInTheDocument();
    expect(screen.getByLabelText('Secret access key')).toBeInTheDocument();
    const results = await axe.run(document.body, {
      // jsdom has no layout; the form alone stands outside the page's landmarks.
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });

  it('MinIO is path style unless changed, and the choice under Advanced is what is sent', async () => {
    const onAdd = form();
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'minio' } });
    const advanced = screen.getByRole('button', { name: 'Advanced' });
    expect(advanced).toHaveAttribute('aria-expanded', 'false');
    expect(advanced).toHaveAccessibleDescription(
      'How the bucket is addressed: path style, as MinIO on my own server expects.',
    );
    fill('http://minio:9000');
    fireEvent.click(screen.getByRole('button', { name: 'Test and save this place' }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
    expect(onAdd.mock.calls[0]?.[0]).toMatchObject({ provider: 'minio', path_style: true });

    // A MinIO set up with a domain for its buckets: virtual-hosted, chosen.
    fireEvent.click(advanced);
    expect(advanced).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByLabelText(/^Virtual-hosted style/));
    expect(advanced).toHaveAccessibleDescription(
      'How the bucket is addressed: virtual-hosted style.',
    );
    fill('https://s3.example.org');
    fireEvent.click(screen.getByRole('button', { name: 'Test and save this place' }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(2));
    expect(onAdd.mock.calls[1]?.[0]).toMatchObject({ provider: 'minio', path_style: false });
  });

  it('a hosted provider is virtual-hosted unless changed; another provider starts again from its own', async () => {
    const onAdd = form();
    expect(screen.getByRole('button', { name: 'Advanced' })).toHaveAccessibleDescription(
      'How the bucket is addressed: virtual-hosted style, as Backblaze B2 expects.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    fireEvent.click(screen.getByLabelText(/^Path style/));
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'other' } });
    expect(screen.getByRole('button', { name: 'Advanced' })).toHaveAccessibleDescription(
      'How the bucket is addressed: path style, as Something else with an S3 address expects.',
    );
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'b2' } });
    fill('https://s3.us-west-004.backblazeb2.com');
    fireEvent.click(screen.getByRole('button', { name: 'Test and save this place' }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
    expect(onAdd.mock.calls[0]?.[0]).toMatchObject({ provider: 'b2', path_style: false });
  });

  it('Amazon S3 has no address and no Advanced: the SDK addresses it itself', () => {
    const onAdd = form();
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'aws' } });
    expect(screen.queryByRole('button', { name: 'Advanced' })).toBeNull();
    expect(screen.queryByLabelText('Address')).toBeNull();
    expect(onAdd).not.toHaveBeenCalled();
  });
});
