import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
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
 * The household, and what each kind usually belongs to (0.9.0, the owner's
 * decisions of 11 Nov 2026): whose a document is reads The household, a
 * person, or Not sure yet; editing one keeps what it says — never whoever
 * is signed in, which saving would make it; a new bill starts as the
 * household's; the Documents table filters by both; and the Kinds editor
 * says whom a kind belongs to, and renames any field.
 */

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});
afterEach(() => vi.unstubAllGlobals());

type Rule = { shown: boolean; required: boolean; label: string | null };
function core(over: Record<string, Partial<Rule>> = {}): Record<string, Rule> {
  return Object.fromEntries(
    ['identifier', 'issued_by', 'issued', 'expires', 'physical_location', 'tags', 'notes'].map(
      (f) => [f, { shown: true, required: false, label: null, ...over[f] }],
    ),
  );
}

/** A bill, as 0087 makes it: the household's, a Due date, its amount a bill's. */
const BILL_TYPE = {
  key: 'utility_bill',
  label: 'Utility / bill',
  category: 'bills',
  fields: [
    { key: 'account', label: 'Account', kind: 'text', required: false },
    { key: 'amount', label: 'Bill amount', kind: 'text', required: false },
    { key: 'due_date', label: 'Due date', kind: 'date', required: true },
  ],
  expiry_driver: null,
  reminder_leads: [],
  remind_from: 'due_date',
  remind_leads: [7, 1],
  usually_essential: false,
  default_visibility: 'household',
  issued_by_label: 'Provider',
  builtin: true,
  hidden: false,
  short_label: 'Bill',
  issuer_noun: 'bill',
  belongs_to: 'household',
  etag: '"utility_bill.1"',
  core: core({ expires: { shown: false }, issued_by: { label: 'Provider' } }),
};

const PASSPORT_TYPE = { ...TYPES[0], builtin: true, hidden: false, belongs_to: 'person' };

const SARA = {
  ...ME,
  id: 'sara',
  display_name: 'Sara Seikh',
  is_me: false,
  has_account: false,
  role: null,
};

const LIBRARY = [
  { key: 'account', label: 'Account', kind: 'text', choices: null, builtin: true },
  { key: 'amount', label: 'Amount', kind: 'text', choices: null, builtin: true },
  { key: 'due_date', label: 'Due date', kind: 'date', choices: null, builtin: true },
];

/** A gas bill, the household's. */
const GAS = {
  ...PASSPORT,
  id: 'doc-gas',
  type_key: 'utility_bill',
  title: 'British Gas bill',
  owner_member_id: null,
  household_owned: true,
  category: 'bills',
  identifier: null,
  expires: null,
  issued: null,
  physical_location: null,
  is_essential: false,
  tags: [],
  extra: { due_date: { date: '2026-12-01', precision: 'day' } },
  status: { value: 'valid', label: '' },
  latest_version_id: 'v-gas',
  etag: '"gas"',
};

/** A scan nobody has said whose it is yet. */
const UNSURE = {
  ...PASSPORT,
  id: 'doc-unsure',
  title: 'A passport',
  owner_member_id: null,
  household_owned: false,
  status: { value: 'needs_info', label: 'Needs a person' },
  etag: '"unsure"',
};

function start(path: string, over: Partial<FakeState> = {}): FakeState {
  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  const state = fresh({
    types: clone([PASSPORT_TYPE, BILL_TYPE]),
    attributes: clone(LIBRARY),
    members: [ME, SARA],
    householdOwner: true,
    ...over,
  });
  installFakeApi(state);
  signedIn();
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

const whose = () => screen.getByLabelText<HTMLSelectElement>('Whose it is');
const optionsOf = (select: HTMLSelectElement) =>
  [...select.options].map((o) => o.textContent ?? '');

describe('whose a document is, on the card (0.9.0)', () => {
  it('editing the household’s keeps The household: it never becomes whoever is signed in', async () => {
    const state = start(`/documents/${GAS.id}/confirm`, { documents: [{ ...GAS }] });
    await screen.findByRole('heading', { name: 'Is this right?' });
    await waitFor(() => expect(whose().value).toBe('household'));
    expect(whose().selectedOptions[0]?.textContent).toBe('The household');
    // The household, each person, and Not sure yet, in that order.
    expect(optionsOf(whose())).toEqual([
      'The household',
      'Mansoor Seikh',
      'Sara Seikh',
      'Not sure yet',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    await waitFor(() => expect(window.location.pathname).toBe(`/documents/${GAS.id}`));
    const patch = state.calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toMatchObject({ owner_member_id: null, household_owned: true });
    expect(state.documents[0]).toMatchObject({ owner_member_id: null, household_owned: true });
  });

  it('editing one nobody is chosen for keeps Not sure yet', async () => {
    const state = start(`/documents/${UNSURE.id}/confirm`, { documents: [{ ...UNSURE }] });
    await screen.findByRole('heading', { name: 'Is this right?' });
    await waitFor(() => expect(whose().value).toBe(''));
    expect(whose().selectedOptions[0]?.textContent).toBe('Not sure yet');
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    await waitFor(() => expect(window.location.pathname).toBe(`/documents/${UNSURE.id}`));
    const patch = state.calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toMatchObject({ owner_member_id: null, household_owned: false });
  });

  it('a person chosen for the household’s is theirs, and the household’s no longer', async () => {
    const state = start(`/documents/${GAS.id}/confirm`, { documents: [{ ...GAS }] });
    await screen.findByRole('heading', { name: 'Is this right?' });
    await waitFor(() => expect(whose().value).toBe('household'));
    fireEvent.change(whose(), { target: { value: 'sara' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    await waitFor(() => expect(window.location.pathname).toBe(`/documents/${GAS.id}`));
    expect(state.calls.find((c) => c.method === 'PATCH')?.body).toMatchObject({
      owner_member_id: 'sara',
      household_owned: false,
    });
  });

  it('a new bill starts as the household’s, a passport as yours; once chosen, the kind moves nothing', async () => {
    const state = start('/add');
    const input = await screen.findByLabelText<HTMLInputElement>('Choose a file');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /choose a file/i })).toBeEnabled(),
    );
    fireEvent.change(input, {
      target: { files: [new File(['%PDF-1.4'], 'scan.pdf', { type: 'application/pdf' })] },
    });
    await screen.findByRole('heading', { name: 'Is this right?' });
    const kind = screen.getByLabelText('What it is');
    fireEvent.change(kind, { target: { value: 'utility_bill' } });
    expect(whose().value).toBe('household');
    fireEvent.change(kind, { target: { value: 'passport' } });
    expect(whose().value).toBe('me');
    fireEvent.change(kind, { target: { value: 'utility_bill' } });
    expect(whose().value).toBe('household');
    // Chosen by hand: Not sure yet stays, whatever the kind.
    fireEvent.change(whose(), { target: { value: '' } });
    fireEvent.change(kind, { target: { value: 'passport' } });
    fireEvent.change(kind, { target: { value: 'utility_bill' } });
    expect(whose().value).toBe('');
    fireEvent.change(whose(), { target: { value: 'household' } });
    fireEvent.change(screen.getByLabelText(/^Due date/), { target: { value: '1 Dec 2026' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    await waitFor(() => expect(state.captures?.length).toBeGreaterThan(0));
    expect(state.captures?.at(-1)?.metadata).toMatchObject({
      type_key: 'utility_bill',
      owner_member_id: null,
      household_owned: true,
    });
  });

  it('a vault without the household offers no household, and sends nothing of it', async () => {
    const state = start(`/documents/${UNSURE.id}/confirm`, {
      documents: [{ ...UNSURE, household_owned: undefined }],
      householdOwner: false,
    });
    await screen.findByRole('heading', { name: 'Is this right?' });
    await screen.findByLabelText('Whose it is');
    expect(optionsOf(whose())).toEqual(['Not sure yet', 'Mansoor Seikh', 'Sara Seikh']);
    fireEvent.click(screen.getByRole('button', { name: 'Save to the vault' }));
    await waitFor(() => expect(window.location.pathname).toBe(`/documents/${UNSURE.id}`));
    const body = state.calls.find((c) => c.method === 'PATCH')?.body as Record<string, unknown>;
    expect(body.owner_member_id).toBeNull();
    expect('household_owned' in body).toBe(false);
  });
});

describe('the Documents table’s person filter (0.9.0)', () => {
  it('offers The household and Not sure yet beside the people', () => {
    const known: Known = {
      members: [ME, SARA] as unknown as Known['members'],
      names: new Map(),
      types: [],
      collections: [],
      tags: [],
    };
    const choices = filterChoices('person', known, {} as Parameters<typeof filterChoices>[2]);
    expect(choices).toEqual([
      { value: '', label: 'All people' },
      { value: 'household', label: 'The household' },
      { value: 'me', label: 'Mansoor Seikh' },
      { value: 'sara', label: 'Sara Seikh' },
      { value: 'none', label: 'Not sure yet' },
    ]);
  });
});

describe('Kinds of document: whom it belongs to, and Rename for every field (0.9.0)', () => {
  const lastPatch = (state: FakeState) =>
    [...state.calls].reverse().find((c) => c.method === 'PATCH' && c.url.includes('document-'));
  const group = (name: string) => screen.getByRole('group', { name });

  it('Rename shows the name box; unticked, the app’s own word is sent back', async () => {
    const state = start('/settings/kinds/utility_bill');
    await screen.findByRole('heading', { name: 'Utility / bill', level: 1 });
    // Issued by is called Provider: Rename is ticked, its box shown.
    const issuer = group('Issued by');
    expect(within(issuer).getByRole('checkbox', { name: 'Rename' })).toBeChecked();
    expect(within(issuer).getByLabelText('What the card calls it')).toHaveValue('Provider');
    // Number is the app's own word: no box until Rename is ticked.
    const number = group('Number');
    expect(within(number).getByRole('checkbox', { name: 'Rename' })).not.toBeChecked();
    expect(within(number).queryByLabelText('What the card calls it')).toBeNull();
    fireEvent.click(within(number).getByRole('checkbox', { name: 'Rename' }));
    fireEvent.change(within(number).getByLabelText('What the card calls it'), {
      target: { value: 'Account number' },
    });
    // Where the original is, Tags and Notes can be renamed too.
    for (const name of ['Issued', 'Where the original is', 'Tags', 'Notes']) {
      expect(within(group(name)).getByRole('checkbox', { name: 'Rename' })).toBeInTheDocument();
    }
    fireEvent.click(within(issuer).getByRole('checkbox', { name: 'Rename' }));
    expect(within(issuer).queryByLabelText('What the card calls it')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('“Utility / bill” is saved.');
    expect(lastPatch(state)?.body).toEqual({
      core: { identifier: { label: 'Account number' }, issued_by: { label: null } },
    });
  });

  it('a built-in’s own field renamed for this household, and back to the library’s word', async () => {
    const state = start('/settings/kinds/utility_bill');
    await screen.findByRole('heading', { name: 'Utility / bill', level: 1 });
    // Bill amount is the bill's word for the library's Amount: renamed already.
    const amount = group('Bill amount');
    expect(within(amount).getByRole('checkbox', { name: 'Rename' })).toBeChecked();
    const account = group('Account');
    expect(within(account).queryByLabelText('What the card calls it')).toBeNull();
    fireEvent.click(within(account).getByRole('checkbox', { name: 'Rename' }));
    fireEvent.change(within(account).getByLabelText('What the card calls it'), {
      target: { value: 'Customer no.' },
    });
    fireEvent.click(within(amount).getByRole('checkbox', { name: 'Rename' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('“Utility / bill” is saved.');
    expect(lastPatch(state)?.body).toEqual({
      fields: [
        { key: 'account', required: false, label: 'Customer no.' },
        { key: 'amount', required: false, label: 'Amount' },
        { key: 'due_date', required: true },
      ],
    });
  });

  it('says whom a new one usually belongs to, and sends only a change', async () => {
    const state = start('/settings/kinds/passport');
    await screen.findByRole('heading', { name: 'Passport', level: 1 });
    const belongs = group('Usually belongs to');
    expect(within(belongs).getByRole('button', { name: 'A person' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(within(belongs).getByRole('button', { name: 'The household' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('“Passport” is saved.');
    expect(lastPatch(state)?.body).toEqual({ belongs_to: 'household' });
  });

  it('a vault without it offers no choice of whom a kind belongs to', async () => {
    start('/settings/kinds/passport', { householdOwner: false });
    await screen.findByRole('heading', { name: 'Passport', level: 1 });
    expect(screen.queryByRole('group', { name: 'Usually belongs to' })).toBeNull();
  });
});
