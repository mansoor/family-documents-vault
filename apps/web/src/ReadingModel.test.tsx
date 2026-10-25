import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  levelItem,
  type BatchDefaults,
  type BatchItemView,
  type DetailProposal,
  type DocumentTypeView,
} from '@fdv/shared';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { AISHA, fresh, installFakeApi, ME, signedIn, type FakeState } from './test-api.js';

/**
 * The vault's reading model (0.9.0, R2), on the web: Settings → Server and
 * reading → Reading and the check turns it on or off, an owner's alone; and a card whose kind it
 * suggested says so — "suggested by the vault's reading model" — unsure,
 * in the same plain style as the other marks.
 */

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});
afterEach(cleanup);

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

function at(
  path: string,
  over: Partial<FakeState>,
  role: 'owner' | 'adult' | 'teen' | 'viewer' = 'owner',
) {
  const state = fresh(over);
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

describe('Settings → Server and reading → Reading and the check (R2)', () => {
  it('is in Server and reading, says what the model does, and turns it off and on again', async () => {
    const state = at('/settings', { readingModel: true });
    const row = await screen.findByRole('link', {
      name: /^Reading and the check.*reading model/,
    });
    fireEvent.click(row);
    await screen.findByRole('heading', { level: 1, name: 'Reading and the check' });
    // Its first part.
    expect(screen.getByRole('heading', { level: 2, name: 'Reading' })).toBeInTheDocument();
    const box = await screen.findByRole('checkbox', { name: 'Use the reading model' });
    expect(box).toBeChecked();
    expect(screen.getByText(/never makes a document Ready on its own/)).toBeInTheDocument();
    expect(screen.getByText(/nothing it reads leaves the server/)).toBeInTheDocument();
    await expectAccessible();

    fireEvent.click(box);
    const said = await screen.findByText(
      'Turned off. Papers read from now on are read by the rules alone.',
    );
    await waitFor(() => expect(said).toHaveFocus());
    expect(state.readingModel).toBe(false);
    expect(
      state.calls.some((c) => c.method === 'PUT' && c.url.endsWith('/api/v1/household/reading')),
    ).toBe(true);
    expect(screen.getByRole('checkbox', { name: 'Use the reading model' })).not.toBeChecked();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Use the reading model' }));
    await screen.findByText('Turned on. Papers read from now on are read with the reading model.');
    expect(state.readingModel).toBe(true);
  });

  it('is an owner’s: an adult is told it is not for them, and never asks', async () => {
    const state = at('/settings/reading', { readingModel: true }, 'adult');
    expect(await screen.findByText('This isn’t something you can open.')).toBeInTheDocument();
    expect(
      screen.getByText('Only an owner can change how the vault reads papers.'),
    ).toBeInTheDocument();
    expect(state.calls.some((c) => c.url.includes('/household/reading'))).toBe(false);
  });

  it('a worker without the weights loaded: Settings says so, and the switch stays (the R2 review)', async () => {
    at('/settings/reading', { readingModel: true, readingModelLoaded: false });
    expect(
      await screen.findByText(/The reading model isn’t loaded on this server/),
    ).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Use the reading model' })).toBeChecked();
    await expectAccessible();
    cleanup();
    // Loaded: nothing said of it.
    at('/settings/reading', { readingModel: true });
    await screen.findByRole('checkbox', { name: 'Use the reading model' });
    expect(screen.queryByText(/isn’t loaded on this server/)).toBeNull();
  });
});

const DEFAULTS: BatchDefaults = {
  owner_member_id: null,
  type_key: null,
  visibility: 'household',
  physical_location: null,
  collection_id: null,
  tags: [],
  is_essential: false,
};

function item(id: string, proposal: DetailProposal, types: DocumentTypeView[]): BatchItemView {
  const levelled = levelItem({
    state: 'waiting',
    reading: 'read',
    failure: null,
    proposal,
    duplicate: null,
    defaults: DEFAULTS,
    types,
    people: [
      { id: 'me', name: 'Mansoor Seikh' },
      { id: 'm-0', name: 'Aisha' },
    ],
    role: 'owner',
    me: 'me',
  });
  return {
    id,
    batch_id: 'batch-1',
    name: `${id}.pdf`,
    content_type: 'application/pdf',
    byte_size: 2048,
    sha256: id.padEnd(64, '0'),
    arrived_at: '2026-10-06T09:05:00Z',
    state: 'waiting',
    reading: 'read',
    read_failure: null,
    preview_state: 'ready',
    preview_pages: 1,
    duplicate: null,
    document_id: null,
    level: levelled.level,
    tags: levelled.tags,
    proposals: levelled.proposals,
    clashes: levelled.clashes,
  };
}

describe('a card whose kind the reading model suggested (R2)', () => {
  it('says "suggested by the vault’s reading model", unsure, and is Check', async () => {
    const state = fresh({ members: [{ ...ME, role: 'owner' }, AISHA], batches: [] });
    state.batches = [
      {
        id: 'batch-1',
        name: 'Scanned post',
        created_at: '2026-10-06T09:00:00Z',
        ends_at: '2026-11-05T09:00:00Z',
        defaults: DEFAULTS,
        items: [
          item(
            'item-1',
            {
              type_key: { value: 'passport', confidence: 0.78, cue: 'kind_words', model: 'alone' },
              owner_member_id: { value: 'me', confidence: 0.95, cue: 'name_labelled' },
            },
            state.types as unknown as DocumentTypeView[],
          ),
        ],
      },
    ];
    installFakeApi(state);
    signedIn('owner');
    window.history.replaceState({}, '', '/inbox/batches/batch-1/items/item-1');
    render(<App />);
    expect(await screen.findByLabelText(/What it is/)).toHaveValue('passport');
    const kindLabel = screen.getByText('What it is').closest('label') as HTMLElement;
    expect(kindLabel).toHaveTextContent('suggested by the vault’s reading model · 78%');
    expect(kindLabel).toHaveTextContent('unsure');
    expect(screen.getByText('Kind suggested by the vault’s reading model')).toBeInTheDocument();
    await expectAccessible();
  });
});
