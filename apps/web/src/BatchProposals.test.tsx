import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  levelItem,
  type BatchDefaults,
  type BatchItemView,
  type BatchReadFailure,
  type BatchReadState,
  type DetailProposal,
  type DocumentTypeView,
} from '@fdv/shared';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { batchPolling } from './screens/Batches.js';
import {
  AISHA,
  fresh,
  installFakeApi,
  ME,
  signedIn,
  type FakeBatch,
  type FakeState,
} from './test-api.js';

/**
 * The vault reads each item and suggests (Phase 6, I2), on the web: a
 * batch's page with a Level column — an icon and words, never colour alone —
 * the tags, the kind with how sure, a summary, and "Reading 3 of 20…" asked
 * again politely while the worker reads; and the card, filled from what the
 * pages say, each suggested detail marked until it is changed, a clash with
 * the pages' choice one press away.
 */

const WIDE = 1280;

function atWidth(px: number) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const minWidth = /\(min-width:\s*(\d+)px\)/.exec(query);
      const minHeight = /\(min-height:\s*(\d+)px\)/.exec(query);
      return {
        matches:
          (!minWidth || px >= Number(minWidth[1])) &&
          (!minHeight || 900 >= Number(minHeight[1])) &&
          Boolean(minWidth || minHeight),
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      };
    },
  });
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});
afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia');
});

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

/** A medical letter: a kind usually kept for the adults. */
const MEDICAL = {
  key: 'medical_record',
  label: 'Medical record',
  category: 'health',
  fields: [],
  expiry_driver: null,
  reminder_leads: [],
  usually_essential: false,
  default_visibility: 'adults',
  issued_by_label: 'Provider',
  builtin: true,
  hidden: false,
};

const DEFAULTS: BatchDefaults = {
  owner_member_id: 'me',
  type_key: null,
  visibility: 'household',
  physical_location: null,
  collection_id: null,
  tags: [],
  is_essential: false,
};

const day = (date: string) => ({ date, precision: 'day' as const });
const PASSPORT = (owner: string, c = 0.9): DetailProposal => ({
  type_key: { value: 'passport', confidence: 0.97, cue: 'kind_words' },
  owner_member_id: { value: owner, confidence: c, cue: 'name_labelled' },
  issued: { value: day('2021-03-14'), confidence: 0.89, cue: 'issue_label' },
  expires: { value: day('2031-03-14'), confidence: 0.94, cue: 'machine_lines' },
  identifier: { value: '533401872', confidence: 0.95, cue: 'machine_lines' },
  issued_by: { value: 'United Kingdom', confidence: 0.9, cue: 'machine_lines' },
});

/** An item as the vault answers it: levelled as the vault levels it (levelItem). */
function item(
  id: string,
  name: string,
  read: {
    reading?: BatchReadState;
    proposal?: DetailProposal;
    failure?: BatchReadFailure;
    duplicate?: BatchItemView['duplicate'];
  },
  types: DocumentTypeView[],
): BatchItemView {
  const reading = read.reading ?? (read.failure ? 'failed' : 'read');
  const duplicate = read.duplicate ?? null;
  const levelled = levelItem({
    state: 'waiting',
    reading,
    failure: read.failure ?? null,
    proposal: read.proposal ?? null,
    duplicate,
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
    name,
    content_type: 'application/pdf',
    byte_size: 2048,
    sha256: id.padEnd(64, '0'),
    arrived_at: '2026-10-06T09:05:00Z',
    state: 'waiting',
    reading,
    read_failure: read.failure ?? null,
    preview_state: 'ready',
    preview_pages: 1,
    duplicate,
    document_id: null,
    level: levelled.level,
    tags: levelled.tags,
    proposals: levelled.proposals,
    clashes: levelled.clashes,
  };
}

/** The app at `path`, wide, an owner, with this batch. */
function at(path: string, items: (types: DocumentTypeView[]) => BatchItemView[]): FakeState {
  atWidth(WIDE);
  const state = fresh({ members: [{ ...ME, role: 'owner' }, AISHA], batches: [] });
  state.types = [...state.types, MEDICAL];
  const batch: FakeBatch = {
    id: 'batch-1',
    name: 'Scanned post',
    created_at: '2026-10-06T09:00:00Z',
    ends_at: '2026-11-05T09:00:00Z',
    defaults: DEFAULTS,
    items: items(state.types as unknown as DocumentTypeView[]),
  };
  state.batches = [batch];
  installFakeApi(state);
  signedIn('owner');
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

/** Every level, and one not read yet. */
const EVERY_LEVEL = (types: DocumentTypeView[]) => [
  item('item-1', 'passport.pdf', { proposal: PASSPORT('me') }, types),
  item('item-2', 'aisha.pdf', { proposal: PASSPORT('m-0', 0.92) }, types),
  item('item-3', 'note.pdf', { proposal: {} }, types),
  item('item-4', 'blank.pdf', { failure: 'blank' }, types),
  item(
    'item-5',
    'copy.pdf',
    {
      proposal: PASSPORT('me'),
      duplicate: { of: 'document', document_id: 'doc-1', title: "Mansoor's passport" },
    },
    types,
  ),
  item('item-6', 'later.pdf', { reading: 'waiting' }, types),
];

describe('the batch page, read (I2)', () => {
  it('a Level column with an icon and words, the tags, the kind and how sure, and a summary', async () => {
    at('/inbox/batches/batch-1', EVERY_LEVEL);
    const table = await screen.findByRole('table', { name: 'Files in Scanned post' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['First page', 'File', 'Kind', 'Level', 'Actions']);
    const row = (name: string) =>
      within(table)
        .getAllByRole('row')
        .find((r) => r.textContent?.includes(name)) as HTMLElement;
    expect(row('passport.pdf')).toHaveTextContent('Passportsuggested · 97%');
    expect(row('passport.pdf')).toHaveTextContent('Ready');
    // The icon is the words' company, never in their place.
    const ready = within(row('passport.pdf')).getByText('Ready');
    expect(ready.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(row('aisha.pdf')).toHaveTextContent('Check');
    expect(row('aisha.pdf')).toHaveTextContent('The pages say Aisha, the batch says Mansoor Seikh');
    expect(row('note.pdf')).toHaveTextContent('Not recognised');
    expect(row('note.pdf')).toHaveTextContent('—');
    expect(row('blank.pdf')).toHaveTextContent('Problem');
    expect(row('blank.pdf')).toHaveTextContent('Couldn’t read the pages');
    expect(row('copy.pdf')).toHaveTextContent('Problem');
    expect(
      within(row('copy.pdf')).getByRole('link', {
        name: "Already in the vault: Mansoor's passport",
      }),
    ).toHaveAttribute('href', '/documents/doc-1');
    expect(row('later.pdf')).toHaveTextContent('Waiting to be read');
    // The summary, and how far the reading has got.
    expect(screen.getByText('1 Ready, 1 Check, 1 Not recognised, 2 Problems')).toBeVisible();
    expect(screen.getByText('Reading 6 of 6…')).toBeVisible();
    await expectAccessible();
  });

  it('while items are read: asked again politely, the line moving, said aloud only as it starts and ends; then no more asking', async () => {
    const was = { ...batchPolling };
    batchPolling.every = 30;
    try {
      const state = at('/inbox/batches/batch-1', (types) => [
        item('item-1', 'one.pdf', { proposal: PASSPORT('me') }, types),
        item('item-2', 'two.pdf', { reading: 'reading' }, types),
        item('item-3', 'three.pdf', { reading: 'waiting' }, types),
      ]);
      expect(await screen.findByText('Reading 2 of 3…')).toBeVisible();
      const heard = () =>
        document.querySelector('[aria-live="polite"].visually-hidden')?.textContent ?? '';
      // Arriving at a page already reading says nothing more than the page.
      expect(heard()).toBe('');
      const types = state.types as unknown as DocumentTypeView[];
      const b = state.batches?.[0] as FakeBatch;
      // One more read: the line moves, nothing is said.
      b.items[1] = item('item-2', 'two.pdf', { proposal: {} }, types);
      await waitFor(() => expect(screen.getByText('Reading 3 of 3…')).toBeVisible());
      expect(heard()).toBe('');
      // The last read: said once, and the asking stops.
      b.items[2] = item('item-3', 'three.pdf', { failure: 'password' }, types);
      await waitFor(() => expect(heard()).toBe('All read. 1 Ready, 1 Not recognised, 1 Problem'));
      expect(screen.queryByText(/^Reading \d+ of/)).toBeNull();
      const asked = () =>
        state.calls.filter((c) => c.method === 'GET' && c.url.endsWith('/batches/batch-1')).length;
      const then = asked();
      await new Promise((r) => setTimeout(r, 200));
      expect(asked()).toBe(then);
    } finally {
      Object.assign(batchPolling, was);
    }
  });
});

describe('the card, filled from the pages (I2)', () => {
  it('starts from what the pages say, each suggested detail marked; a detail changed loses its mark; it sends every field', async () => {
    const state = at('/inbox/batches/batch-1/items/item-1', EVERY_LEVEL);
    const kind = await screen.findByLabelText(/What it is/);
    await screen.findByRole('option', { name: 'Aisha' });
    expect(kind).toHaveValue('passport');
    // The marks are part of each label: heard with it.
    expect(screen.getByText('What it is').closest('label')).toHaveTextContent(
      'What it is suggested · 97%',
    );
    expect(screen.getByLabelText(/Whose it is/)).toHaveValue('me');
    expect(screen.getByText('Whose it is').closest('label')).toHaveTextContent('suggested · 90%');
    expect(screen.getByLabelText(/^Expires/)).toHaveValue('14 Mar 2031');
    expect(screen.getByText('Expires').closest('label')).toHaveTextContent('suggested · 94%');
    expect(screen.getByLabelText(/^Passport number|^Number/)).toHaveValue('533401872');
    expect(screen.getByLabelText(/^Issuing country/)).toHaveValue('United Kingdom');
    expect(screen.getByLabelText('Name')).toHaveValue("Mansoor's passport");
    await expectAccessible();
    // Changed: the person's own, unmarked.
    fireEvent.change(screen.getByLabelText(/^Expires/), { target: { value: '15 Mar 2031' } });
    await waitFor(() =>
      expect(screen.getByText('Expires').closest('label')).not.toHaveTextContent('suggested'),
    );
    expect(screen.getByText('What it is').closest('label')).toHaveTextContent('suggested · 97%');
    fireEvent.click(screen.getByRole('button', { name: 'Accept as a document' }));
    await waitFor(() =>
      expect(
        state.calls.filter((c) => c.method === 'POST' && /\/items\/item-1\/accept$/.test(c.url)),
      ).toHaveLength(1),
    );
    const sent = state.calls.find((c) => /\/items\/item-1\/accept$/.test(c.url));
    expect(sent?.body).toMatchObject({
      type_key: 'passport',
      owner_member_id: 'me',
      identifier: '533401872',
      issued_by: 'United Kingdom',
      issued: { date: '2021-03-14', precision: 'day' },
      expires: { date: '2031-03-15', precision: 'day' },
      visibility: 'household',
    });
  });

  it('a clash shows both, the batch’s on the card, and the pages’ one press away — by keyboard too', async () => {
    at('/inbox/batches/batch-1/items/item-2', EVERY_LEVEL);
    const who = await screen.findByLabelText(/Whose it is/);
    await screen.findByRole('option', { name: 'Aisha' });
    expect(who).toHaveValue('me');
    expect(screen.getByText('Whose it is').closest('label')).toHaveTextContent('from the batch');
    const box = screen.getByRole('group', { name: 'The pages and the batch disagree' });
    expect(box).toHaveTextContent(
      'The batch says Mansoor Seikh; the pages say Aisha suggested · 92%',
    );
    // The level and why, beside the page.
    expect(screen.getByText('Check')).toBeVisible();
    await expectAccessible();
    const use = within(box).getByRole('button', { name: 'Use Aisha, as the pages say' });
    use.focus();
    fireEvent.keyDown(use, { key: 'Enter' });
    fireEvent.click(use);
    await waitFor(() => expect(screen.getByLabelText(/Whose it is/)).toHaveValue('m-0'));
    await waitFor(() => expect(screen.getByLabelText(/Whose it is/)).toHaveFocus());
    expect(screen.getByLabelText('Name')).toHaveValue("Aisha's passport");
    // And back, one press.
    fireEvent.click(
      within(screen.getByRole('group', { name: 'The pages and the batch disagree' })).getByRole(
        'button',
        { name: 'Use Mansoor Seikh, as the batch says' },
      ),
    );
    await waitFor(() => expect(screen.getByLabelText(/Whose it is/)).toHaveValue('me'));
  });

  it('a kind usually kept for adults is kept so, and says why; pages that could not be read say why', async () => {
    at('/inbox/batches/batch-1/items/item-7', (types) => [
      ...EVERY_LEVEL(types),
      item(
        'item-7',
        'gp.pdf',
        {
          proposal: {
            type_key: { value: 'medical_record', confidence: 0.97, cue: 'kind_words' },
            owner_member_id: { value: 'm-0', confidence: 0.9, cue: 'name_labelled' },
          },
        },
        types,
      ),
    ]);
    await screen.findByLabelText(/What it is/);
    const vis = screen.getByRole('group', { name: 'Who can see this' });
    expect(within(vis).getByRole('button', { name: 'Adults only' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByText('Kept to adults: it looks like a medical record')).toBeVisible();
  });

  it('pages that could not be read: the card says why, and starts from the batch alone', async () => {
    at('/inbox/batches/batch-1/items/item-4', EVERY_LEVEL);
    await screen.findByLabelText(/What it is/);
    expect(screen.getByText('Problem')).toBeVisible();
    expect(screen.getByText(/The pages look blank/)).toBeVisible();
    expect(screen.getByLabelText(/What it is/)).toHaveValue('');
    expect(screen.getByText('Whose it is').closest('label')).toHaveTextContent('from the batch');
    await expectAccessible();
  });
});
