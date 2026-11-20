import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Capabilities, OffsiteSettings, OffsiteView, Role } from '@fdv/shared';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { statusWords } from './backups.js';
import { settingsGroups } from './settings-sections.js';
import { AISHA, fresh, installFakeApi, ME, signedIn, type FakeState } from './test-api.js';

/**
 * Settings → Server and reading → Backups (0.9.0-dev.76), an owner's: what a
 * backup holds (the database, not the files), and a copy of each somewhere
 * else — saved, tested, then turned on; the secret key never shown again.
 */

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});
afterEach(cleanup);

const NOT_SET_UP: OffsiteView = { available: true, settings: null, covers: 'database' };

function at(path: string, over: Partial<FakeState>, role: Role = 'owner') {
  const state = fresh({ members: [{ ...ME, role }, AISHA], ...over });
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

describe('Settings → Backups', () => {
  it('is an owner’s section, on a vault that offers it', async () => {
    const caps = { features: { backup_offsite: true } } as unknown as Capabilities;
    const server = (role: Role, c: Capabilities | null = caps) =>
      settingsGroups(role, c, role === 'owner')
        .find((g) => g.key === 'server')
        ?.sections.map((s) => [s.label, s.to]);
    expect(server('owner')).toContainEqual(['Backups', '/settings/backups']);
    expect(server('owner', null)).not.toContainEqual(['Backups', '/settings/backups']);
    expect(server('adult')).toBeUndefined();
    at('/settings/backups', { offsite: { view: NOT_SET_UP } }, 'adult');
    expect(
      await screen.findByText('Only an owner can set up where backups are copied.'),
    ).toBeVisible();
  });

  it('says a backup does not hold the files, then saves, tests and turns on the copy', async () => {
    const state = at('/settings/backups', { offsite: { view: { ...NOT_SET_UP } } });
    expect(await screen.findByRole('heading', { level: 1, name: 'Backups' })).toBeVisible();
    expect(screen.getByTestId('backups-files-note')).toHaveTextContent(
      'A backup does not hold the document files themselves.',
    );
    expect(await screen.findByTestId('offsite-status')).toHaveTextContent(
      'Not set up. Backups stay on this server only.',
    );
    fireEvent.change(screen.getByLabelText('Address'), {
      target: { value: 'https://s3.eu-central-003.backblazeb2.com' },
    });
    fireEvent.change(screen.getByLabelText('Bucket name'), { target: { value: 'family' } });
    fireEvent.change(screen.getByLabelText('Access key ID'), { target: { value: 'AKID' } });
    // The secret is asked for first.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Type the secret key.')).toBeVisible();
    expect(state.offsite?.saves ?? []).toEqual([]);
    fireEvent.change(screen.getByLabelText('Secret key'), { target: { value: 's3cret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('Saved. Now send a test: nothing is copied until one goes.'),
    ).toBeVisible();
    expect(state.offsite?.saves?.[0]).toMatchObject({
      endpoint: 'https://s3.eu-central-003.backblazeb2.com',
      bucket: 'family',
      access_key_id: 'AKID',
      secret_access_key: 's3cret',
      retain_count: 30,
      path_style: true,
    });
    // Off until a test passes.
    expect(screen.getByRole('button', { name: 'Turn on the copy' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Send a test' }));
    expect(await screen.findByText('The test went.')).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Turn on the copy' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Turn on the copy' }));
    expect(await screen.findByRole('button', { name: 'Turn off the copy' })).toBeVisible();
    expect(state.offsite?.turned).toEqual([true]);
    expect(screen.getByTestId('offsite-status')).toHaveTextContent(
      'On. The first copy goes after the next nightly backup.',
    );
    // The secret is never shown again, only that it is set.
    expect(screen.getByLabelText('Secret key')).toHaveValue('');
    const results = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });

  it('says when the key cannot delete, so old copies are left to the bucket', async () => {
    at('/settings/backups', { offsite: { view: { ...NOT_SET_UP }, canDelete: false } });
    await screen.findByTestId('offsite-status');
    fireEvent.change(screen.getByLabelText('Bucket name'), { target: { value: 'family' } });
    fireEvent.change(screen.getByLabelText('Access key ID'), { target: { value: 'AKID' } });
    fireEvent.change(screen.getByLabelText('Secret key'), { target: { value: 's3cret' } });
    fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'eu-west-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved. Now send a test: nothing is copied until one goes.');
    expect(screen.queryByTestId('offsite-no-delete')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send a test' }));
    expect(await screen.findByTestId('offsite-no-delete')).toHaveTextContent(
      'This key can’t delete, so old copies are not removed here',
    );
  });

  it('says what became of the copy', () => {
    const base: OffsiteSettings = {
      endpoint: null,
      region: 'eu-west-2',
      bucket: 'b',
      prefix: null,
      path_style: false,
      access_key_id: 'AKID',
      secret_access_key: 'set',
      retain_count: 30,
      enabled: true,
      status: 'ok',
      last_tested_at: null,
      test_problem: null,
      can_delete: true,
      last_attempt_at: null,
      last_copy_at: null,
      last_copy_object: null,
      last_copy_bytes: null,
      last_result: null,
      last_problem: null,
      late: false,
    };
    const say = (s: Partial<OffsiteSettings>) =>
      statusWords({ available: true, covers: 'database', settings: { ...base, ...s } });
    expect(say({ last_result: 'failed', last_problem: 'credentials_rejected' })).toBe(
      'On, but the last copy did not go: The access key ID or secret key was not accepted.',
    );
    expect(say({ late: true })).toMatch(/no copy has gone lately/);
    expect(say({ enabled: false, status: 'failed', test_problem: 'unreachable' })).toBe(
      'Off. The last test did not go: The vault could not reach the address.',
    );
    expect(say({ enabled: false, status: 'untested' })).toMatch(/not yet tested/);
  });
});
