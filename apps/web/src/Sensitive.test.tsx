import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { viewFrom, queryOf } from './documents-table.js';
import { filterChoices, type Known } from './screens/Documents.js';
import {
  fresh,
  installFakeApi,
  ME,
  PASSPORT,
  signedIn,
  TYPES,
  type FakeState,
} from './test-api.js';

/**
 * Sensitive (0.9.0, AIR2): the card's Sensitive — as its kind says (with
 * what that is now), Yes or No — sent only when changed; a lock on the
 * document's page, named Sensitive; the Documents table's filter; and the
 * kinds editor's Sensitive by default. A vault without it shows none.
 */

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});
afterEach(() => vi.unstubAllGlobals());

const PASSPORT_TYPE = {
  ...TYPES[0],
  builtin: true,
  hidden: false,
  belongs_to: 'person',
  sensitive_default: true,
};

/** A passport left as its kind says: sensitive. */
const KEPT = {
  ...PASSPORT,
  id: 'doc-kept',
  title: 'Mansoor passport',
  sensitive: null,
  sensitive_effective: true,
  etag: '"kept"',
};

function start(path: string, over: Partial<FakeState> = {}): FakeState {
  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  const state = fresh({
    types: clone([PASSPORT_TYPE]),
    members: [ME],
    sensitive: true,
    ...over,
  });
  installFakeApi(state);
  signedIn();
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

const sensitiveSelect = () => screen.getByLabelText<HTMLSelectElement>('Sensitive');
const optionsOf = (select: HTMLSelectElement) =>
  [...select.options].map((o) => o.textContent ?? '');
const patchOf = (state: FakeState) =>
  state.calls.find((c) => c.method === 'PATCH')?.body as Record<string, unknown> | undefined;

describe('Sensitive on the card (0.9.0, AIR2)', () => {
  it('says what its kind says, and sends nothing of it unless it is changed', async () => {
    const state = start(`/documents/${KEPT.id}/confirm`, { documents: [{ ...KEPT }] });
    await screen.findByRole('heading', { name: 'Is this right?' });
    await waitFor(() => expect(sensitiveSelect().value).toBe(''));
    expect(optionsOf(sensitiveSelect())).toEqual(['As its kind says (yes)', 'Yes', 'No']);
    expect(screen.getByText(/never sent to a cloud AI reader/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    await waitFor(() => expect(window.location.pathname).toBe(`/documents/${KEPT.id}`));
    expect('sensitive' in (patchOf(state) ?? {})).toBe(false);
  });

  it('No, chosen, is sent', async () => {
    const state = start(`/documents/${KEPT.id}/confirm`, { documents: [{ ...KEPT }] });
    await screen.findByRole('heading', { name: 'Is this right?' });
    await waitFor(() => expect(sensitiveSelect().value).toBe(''));
    fireEvent.change(sensitiveSelect(), { target: { value: 'no' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    await waitFor(() => expect(window.location.pathname).toBe(`/documents/${KEPT.id}`));
    expect(patchOf(state)).toMatchObject({ sensitive: false });
    expect(state.documents[0]).toMatchObject({ sensitive: false, sensitive_effective: false });
  });

  it('a vault without it asks nothing, and sends nothing of it', async () => {
    const state = start(`/documents/${KEPT.id}/confirm`, {
      documents: [{ ...KEPT, sensitive: undefined, sensitive_effective: undefined }],
      sensitive: false,
    });
    await screen.findByRole('heading', { name: 'Is this right?' });
    await screen.findByLabelText('Whose it is');
    expect(screen.queryByLabelText('Sensitive')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    await waitFor(() => expect(window.location.pathname).toBe(`/documents/${KEPT.id}`));
    expect('sensitive' in (patchOf(state) ?? {})).toBe(false);
  });
});

describe('the lock on a document’s page (0.9.0, AIR2)', () => {
  it('is there, named Sensitive, for a sensitive document', async () => {
    start(`/documents/${KEPT.id}`, { documents: [{ ...KEPT }] });
    expect(await screen.findByRole('img', { name: 'Sensitive' })).toBeInTheDocument();
  });

  it('is not, for one that is not', async () => {
    start(`/documents/${KEPT.id}`, {
      documents: [{ ...KEPT, sensitive: false, sensitive_effective: false }],
    });
    await screen.findByRole('heading', { name: KEPT.title });
    expect(screen.queryByRole('img', { name: 'Sensitive' })).toBeNull();
  });
});

describe('the Documents table’s Sensitive filter (0.9.0, AIR2)', () => {
  it('offers either, sensitive, or not; and asks the vault for it', () => {
    const known: Known = {
      members: [],
      names: new Map(),
      types: [],
      collections: [],
      tags: [],
      sensitive: true,
    };
    expect(filterChoices('sensitive', known, {} as Parameters<typeof filterChoices>[2])).toEqual([
      { value: '', label: 'Sensitive or not' },
      { value: 'yes', label: 'Sensitive' },
      { value: 'no', label: 'Not sensitive' },
    ]);
    const view = viewFrom(new URLSearchParams('sensitive=yes'), 'owner');
    expect(view.sensitive).toBe('yes');
    expect(queryOf(view).sensitive).toBe('yes');
    // A value it does not know is no filter.
    expect(viewFrom(new URLSearchParams('sensitive=maybe'), 'owner').sensitive).toBe('');
  });
});

describe('Kinds of document: Sensitive by default (0.9.0, AIR2)', () => {
  const lastPatch = (state: FakeState) =>
    [...state.calls].reverse().find((c) => c.method === 'PATCH' && c.url.includes('document-'));

  it('says it, and sends only a change', async () => {
    const state = start('/settings/kinds/passport');
    await screen.findByRole('heading', { name: 'Passport', level: 1 });
    const box = screen.getByRole('checkbox', { name: /Sensitive by default/ });
    expect(box).toBeChecked();
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('“Passport” is saved.');
    expect(lastPatch(state)?.body).toEqual({ sensitive_default: false });
  });

  it('a vault without it offers no such switch', async () => {
    start('/settings/kinds/passport', { sensitive: false });
    await screen.findByRole('heading', { name: 'Passport', level: 1 });
    expect(screen.queryByRole('checkbox', { name: /Sensitive by default/ })).toBeNull();
  });
});
