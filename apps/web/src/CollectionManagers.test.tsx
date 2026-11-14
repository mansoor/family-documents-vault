import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import {
  fresh,
  installFakeApi,
  ME,
  PASSPORT,
  signedIn,
  type FakeCollection,
  type FakeState,
} from './test-api.js';

/**
 * A collection's managers on the web (0.9.0): its maker picks somebody of the
 * family who can see it, with three switches in plain words, and takes them
 * away only once asked; a manager is offered what they may do — by the
 * vault's `my_powers`, never by "am I its maker".
 */

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const SAM = { ...ME, id: 'm-1', display_name: 'Sam', is_me: false, role: 'adult', colour: 2 };
const TIA = { ...ME, id: 'm-2', display_name: 'Tia', is_me: false, role: 'teen', colour: 3 };
const VIC = { ...ME, id: 'm-3', display_name: 'Vic', is_me: false, role: 'viewer', colour: 4 };

const TRIP: FakeCollection = {
  id: 'collection-t',
  name: 'Trip',
  description: null,
  audience: 'everyone',
  owner_member_id: 'me',
  etag: '"trip.1"',
  items: ['doc-1'],
};

function at(over: Partial<FakeState>, role: 'owner' | 'adult' | 'teen' = 'owner'): FakeState {
  const state = fresh({
    documents: [{ ...PASSPORT }],
    members: [ME, SAM, TIA, VIC],
    ...over,
  });
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', '/collections/collection-t');
  render(<App />);
  return state;
}

describe('collection managers on the web (0.9.0)', () => {
  it('its maker makes somebody a manager, with switches in plain words, and only the family who can see it are offered', async () => {
    const state = at({ collections: [{ ...TRIP }] });
    const section = await screen.findByRole('region', { name: 'Managers' });
    expect(within(section).getByText('Nobody else manages it yet.')).toBeInTheDocument();
    const pick = within(section).getByLabelText('Make someone a manager');
    // Sam and Tia, never Vic (a viewer) or the maker.
    expect(
      within(pick)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Choose someone', 'Sam', 'Tia']);
    for (const words of [
      'Can also change who it’s for',
      'Can also delete it',
      'Can also choose managers',
    ]) {
      expect(within(section).getByLabelText(words)).not.toBeChecked();
    }
    fireEvent.change(pick, { target: { value: 'm-1' } });
    fireEvent.click(within(section).getByLabelText('Can also delete it'));
    fireEvent.click(within(section).getByRole('button', { name: 'Make a manager' }));
    expect(await within(section).findByText('Sam now manages “Trip”.')).toBeInTheDocument();
    expect(state.managerCalls?.at(-1)).toMatchObject({
      method: 'POST',
      body: {
        member_id: 'm-1',
        may_change_audience: false,
        may_delete: true,
        may_choose_managers: false,
      },
    });
    expect(within(section).getByLabelText('Can also delete it (Sam)')).toBeChecked();
    const results = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });

  it('asks before a manager is removed, and Cancel keeps them', async () => {
    const state = at({
      collections: [
        {
          ...TRIP,
          managers: [
            {
              member_id: 'm-1',
              may_change_audience: false,
              may_delete: false,
              may_choose_managers: false,
            },
          ],
        },
      ],
    });
    const section = await screen.findByRole('region', { name: 'Managers' });
    fireEvent.click(within(section).getByRole('button', { name: 'Remove Sam as a manager' }));
    let sure = await screen.findByRole('alertdialog', { name: 'Remove Sam as a manager?' });
    fireEvent.click(within(sure).getByRole('button', { name: 'Cancel' }));
    expect(state.managerCalls?.some((c) => c.method === 'DELETE') ?? false).toBe(false);
    fireEvent.click(within(section).getByRole('button', { name: 'Remove Sam as a manager' }));
    sure = await screen.findByRole('alertdialog', { name: 'Remove Sam as a manager?' });
    fireEvent.click(within(sure).getByRole('button', { name: 'Remove' }));
    expect(await within(section).findByText('Sam no longer manages “Trip”.')).toBeInTheDocument();
    expect(state.managerCalls?.filter((c) => c.method === 'DELETE')).toEqual([
      expect.objectContaining({ path: '/api/v1/collections/collection-t/managers/m-1' }),
    ]);
    expect(state.collections?.[0]?.managers).toEqual([]);
  });

  it('a manager is offered by my_powers: edit and add, but not who it is for, deleting or choosing managers unless let', async () => {
    at(
      {
        collections: [
          {
            ...TRIP,
            owner_member_id: 'm-1',
            managers: [
              {
                member_id: 'me',
                may_change_audience: false,
                may_delete: false,
                may_choose_managers: false,
              },
            ],
          },
        ],
      },
      'adult',
    );
    expect(await screen.findByRole('heading', { name: 'Trip', level: 1 })).toBeInTheDocument();
    expect(
      await screen.findByText(/Sam, who made this collection, chose you to manage it\./),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit “Trip”' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add documents' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete this collection' })).toBeNull();
    // Who manages it, said; nothing to change there.
    const section = await screen.findByRole('region', { name: 'Managers' });
    expect(within(section).queryByLabelText('Make someone a manager')).toBeNull();
    expect(within(section).getByText('Can add and remove documents, and rename it')).toBeVisible();
    // Editing: who it is for is said, not offered.
    fireEvent.click(screen.getByRole('button', { name: 'Edit “Trip”' }));
    expect(
      await screen.findByText(
        /Only the person who made it, or a manager they let, can change who it’s for\./,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: /Who it is for/ })).toBeNull();
  });

  it('a manager who may choose managers is offered only the switches they have', async () => {
    const state = at(
      {
        collections: [
          {
            ...TRIP,
            owner_member_id: 'm-1',
            managers: [
              {
                member_id: 'me',
                may_change_audience: false,
                may_delete: true,
                may_choose_managers: true,
              },
            ],
          },
        ],
      },
      'adult',
    );
    const section = await screen.findByRole('region', { name: 'Managers' });
    expect(within(section).queryByLabelText('Can also change who it’s for')).toBeNull();
    expect(within(section).getByLabelText('Can also delete it')).toBeInTheDocument();
    expect(within(section).getByLabelText('Can also choose managers')).toBeInTheDocument();
    // And may delete it.
    expect(screen.getByRole('button', { name: 'Delete this collection' })).toBeInTheDocument();
    fireEvent.change(within(section).getByLabelText('Make someone a manager'), {
      target: { value: 'm-2' },
    });
    fireEvent.click(within(section).getByRole('button', { name: 'Make a manager' }));
    expect(await within(section).findByText('Tia now manages “Trip”.')).toBeInTheDocument();
    // On Tia's row, what the reader has not got is not offered to turn on.
    await waitFor(() =>
      expect(within(section).getByLabelText('Can also change who it’s for (Tia)')).toBeDisabled(),
    );
    expect(within(section).getByLabelText('Can also delete it (Tia)')).toBeEnabled();
    expect(state.managerCalls?.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('an owner, once its maker can no longer change it, may take its managers away and delete it, but not choose any', async () => {
    const ANA = { ...ME, id: 'm-4', display_name: 'Ana', is_me: false, role: 'adult', colour: 5 };
    const state = at({
      members: [ME, { ...SAM, role: 'teen' }, TIA, VIC, ANA],
      collections: [
        {
          ...TRIP,
          audience: 'adults',
          owner_member_id: 'm-1',
          managers: [
            {
              member_id: 'm-4',
              may_change_audience: false,
              may_delete: false,
              may_choose_managers: false,
            },
          ],
        },
      ],
    });
    const section = await screen.findByRole('region', { name: 'Managers' });
    expect(within(section).queryByLabelText('Make someone a manager')).toBeNull();
    expect(within(section).queryByLabelText('Can also delete it (Ana)')).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete this collection' })).toBeInTheDocument();
    fireEvent.click(within(section).getByRole('button', { name: 'Remove Ana as a manager' }));
    const sure = await screen.findByRole('alertdialog', { name: 'Remove Ana as a manager?' });
    fireEvent.click(within(sure).getByRole('button', { name: 'Remove' }));
    expect(await within(section).findByText('Ana no longer manages “Trip”.')).toBeInTheDocument();
    expect(state.collections?.[0]?.managers).toEqual([]);
  });

  it('a vault without managers draws no Managers section, and only the maker changes it', async () => {
    at({ collections: [{ ...TRIP, owner_member_id: 'm-1' }], collectionManagers: false }, 'adult');
    expect(await screen.findByRole('heading', { name: 'Trip', level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Managers' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit “Trip”' })).toBeNull();
  });
});
