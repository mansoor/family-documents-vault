import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  levelItem,
  type BatchDefaults,
  type BatchItemView,
  type BatchRenewal,
  type DetailProposal,
  type DocumentTypeView,
} from '@fdv/shared';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { versionUndoStore } from './batch-review.js';
import {
  AISHA,
  fresh,
  installFakeApi,
  ME,
  PASSPORT,
  signedIn,
  type FakeBatch,
  type FakeState,
} from './test-api.js';

/**
 * Duplicates as versions (0.8.0, S1), on the web: a file already in the
 * vault — "Already in the vault: Mansoor's passport", Discard this copy
 * first and Accept anyway after it; one that is probably a renewal of a
 * document — "Add as a new version of Mansoor's passport" beside Accept,
 * "or another…" for the rest, then a toast with Undo; and the batch's page
 * saying "Same as …" or "New version of …?". Only what the vault gives is
 * shown: a duplicate of something the uploader cannot see comes with
 * nothing, and the card says nothing.
 */

function atWidth(px: number) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const minWidth = /\(min-width:\s*(\d+)px\)/.exec(query);
      return {
        matches: Boolean(minWidth) && px >= Number(minWidth?.[1]),
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
  versionUndoStore.set(null);
});
afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia');
  versionUndoStore.set(null);
});

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

const DEFAULTS: BatchDefaults = {
  owner_member_id: null,
  type_key: null,
  visibility: 'household',
  physical_location: null,
  collection_id: null,
  tags: [],
  is_essential: false,
};

const day = (date: string) => ({ date, precision: 'day' as const });
const RENEWED: DetailProposal = {
  type_key: { value: 'passport', confidence: 0.97, cue: 'kind_words' },
  owner_member_id: { value: 'me', confidence: 0.92, cue: 'name_labelled' },
  issued: { value: day('2026-09-01'), confidence: 0.89, cue: 'issue_label' },
  expires: { value: day('2036-09-01'), confidence: 0.94, cue: 'machine_lines' },
  identifier: { value: '700123456', confidence: 0.95, cue: 'machine_lines' },
  issued_by: { value: 'United Kingdom', confidence: 0.9, cue: 'machine_lines' },
};

/** An item as the vault answers it, levelled as the vault levels it. */
function item(
  id: string,
  name: string,
  types: DocumentTypeView[],
  o: { duplicate?: BatchItemView['duplicate']; renewals?: BatchRenewal[] } = {},
): BatchItemView {
  const duplicate = o.duplicate ?? null;
  const levelled = levelItem({
    state: 'waiting',
    reading: 'read',
    failure: null,
    proposal: RENEWED,
    duplicate,
    // As the vault levels it: a near match is Check (S1).
    renewal: o.renewals?.[0] ?? null,
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
    reading: 'read',
    read_failure: null,
    preview_state: 'ready',
    preview_pages: 1,
    duplicate,
    renewals: o.renewals ?? [],
    document_id: null,
    level: levelled.level,
    tags: levelled.tags,
    proposals: levelled.proposals,
    clashes: levelled.clashes,
  };
}

const OTHER = {
  ...PASSPORT,
  id: 'doc-old',
  title: "Mansoor's old passport",
  identifier: '400111222',
  etag: '"old"',
};

/** The app at `path`, an owner, with a batch of these items. */
function at(
  path: string,
  items: (types: DocumentTypeView[]) => BatchItemView[],
  over: Partial<FakeState> & { width?: number } = {},
): FakeState {
  const { width = 1280, ...rest } = over;
  atWidth(width);
  const state = fresh({
    members: [{ ...ME, role: 'owner' }, AISHA],
    batches: [],
    documents: [PASSPORT, OTHER],
    ...rest,
  });
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

const SAME = {
  of: 'document' as const,
  document_id: 'doc-1',
  title: "Mansoor's passport",
};
const NEAR: BatchRenewal = { document_id: 'doc-1', title: "Mansoor's passport", by: 'details' };
const NEAR_OLD: BatchRenewal = {
  document_id: 'doc-old',
  title: "Mansoor's old passport",
  by: 'details',
};

describe('duplicates as versions (S1)', () => {
  it('the same file as a document they can see: Already in the vault, with a link; Discard this copy first, Accept anyway after it', async () => {
    const state = at('/inbox/batches/batch-1/items/item-1', (types) => [
      item('item-1', 'copy.pdf', types, { duplicate: SAME }),
      item('item-2', 'next.pdf', types),
    ]);
    const discard = await screen.findByRole('button', { name: 'Discard this copy' });
    const box = discard.closest('.problem-box') as HTMLElement;
    expect(box).toHaveTextContent("Already in the vault: Mansoor's passport");
    expect(within(box).getByRole('link', { name: "Mansoor's passport" })).toHaveAttribute(
      'href',
      '/documents/doc-1',
    );
    expect(discard).toHaveClass('btn-primary');
    const anyway = screen.getByRole('button', { name: /Accept anyway/ });
    expect(anyway).toHaveClass('btn-quiet');
    expect(anyway).not.toHaveClass('btn-primary');
    // Nothing to add it to: the same file is not a new version of itself.
    expect(screen.queryByRole('button', { name: /Add as a new version/ })).toBeNull();
    await expectAccessible();

    // Discard: dropped, as Remove drops it, without asking; on to the next.
    fireEvent.click(discard);
    await waitFor(() =>
      expect(window.location.pathname).toBe('/inbox/batches/batch-1/items/item-2'),
    );
    expect(state.batches?.[0]?.items.find((i) => i.id === 'item-1')?.removed).toBe(true);
    expect(
      await screen.findByText(
        'Discarded “copy.pdf”: the copy already in the vault stays as it is.',
      ),
    ).toBeVisible();
    expect(state.batchAccepts ?? []).toEqual([]);
  });

  it('Accept anyway files it as a document of its own', async () => {
    const state = at('/inbox/batches/batch-1/items/item-1', (types) => [
      item('item-1', 'copy.pdf', types, { duplicate: SAME }),
    ]);
    fireEvent.click(await screen.findByRole('button', { name: /Accept anyway/ }));
    await waitFor(() => expect(state.batchAccepts).toHaveLength(1));
    expect(state.batchAccepts?.[0]?.body).not.toHaveProperty('into_document_id');
  });

  it('the same file as one they cannot see: the vault says nothing, and neither does the card', async () => {
    at('/inbox/batches/batch-1/items/item-1', (types) => [item('item-1', 'scan.pdf', types)]);
    await screen.findByRole('button', { name: /Accept and next/ });
    expect(screen.queryByText(/Already in the vault/)).toBeNull();
    expect(screen.queryByText(/Same as/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard this copy' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Add as a new version/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Accept and next/ })).toHaveClass('btn-primary');
  });

  it('a near match: Add as a new version beside Accept sends the card’s dates and number, moves on, and the toast’s Undo takes it back', async () => {
    const state = at('/inbox/batches/batch-1/items/item-1', (types) => [
      item('item-1', 'renewed.pdf', types, { renewals: [NEAR] }),
    ]);
    const box = (await screen.findByText(/Looks like a new copy of/)).closest(
      '.problem-box',
    ) as HTMLElement;
    expect(within(box).getByRole('link', { name: "Mansoor's passport" })).toHaveAttribute(
      'href',
      '/documents/doc-1',
    );
    expect(box).toHaveTextContent('The pages give the same kind, person and issuer.');
    // Accept is still the first choice; this is beside it.
    expect(screen.getByRole('button', { name: /Accept and next/ })).toHaveClass('btn-primary');
    expect(screen.queryByRole('button', { name: 'or another…' })).toBeNull();
    await expectAccessible();
    fireEvent.click(
      screen.getByRole('button', { name: "Add as a new version of Mansoor's passport" }),
    );
    await waitFor(() => expect(state.batchAccepts).toHaveLength(1));
    expect(state.batchAccepts?.[0]).toEqual({
      item: 'item-1',
      body: {
        into_document_id: 'doc-1',
        issued: day('2026-09-01'),
        expires: day('2036-09-01'),
        identifier: '700123456',
      },
    });
    // The last of the batch: back to the queue, the toast there, with Undo.
    await waitFor(() => expect(window.location.pathname).toBe('/inbox/batches/batch-1'));
    const toast = await screen.findByRole('region', { name: 'What was just done' });
    expect(toast).toHaveTextContent(
      "“renewed.pdf” is now the newest copy of Mansoor's passport. You can undo this for 5 minutes.",
    );
    expect(document.querySelector('main')).toHaveClass('has-toast');
    await expectAccessible();
    fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'What was just done' })).toHaveTextContent(
        "Undone: “renewed.pdf” is back in the queue, and Mansoor's passport is as it was.",
      ),
    );
    expect(state.undoCalls).toEqual([{ batch: 'batch-1', item_ids: ['item-1'] }]);
    expect(state.documents.find((d) => d.id === 'doc-1')).toMatchObject({
      identifier: PASSPORT.identifier,
      versions: 1,
    });
  });

  it('several near matches: the best one, and “or another…” for the rest', async () => {
    const state = at('/inbox/batches/batch-1/items/item-1', (types) => [
      item('item-1', 'renewed.pdf', types, { renewals: [NEAR, NEAR_OLD] }),
      item('item-2', 'next.pdf', types),
    ]);
    fireEvent.click(await screen.findByRole('button', { name: 'or another…' }));
    const others = await screen.findByRole('list', { name: 'Or add it to another' });
    const old = within(others).getByRole('button', {
      name: "Add as a new version of Mansoor's old passport",
    });
    await waitFor(() => expect(old).toHaveFocus());
    await expectAccessible();
    fireEvent.click(old);
    await waitFor(() => expect(state.batchAccepts).toHaveLength(1));
    expect(state.batchAccepts?.[0]?.body).toMatchObject({ into_document_id: 'doc-old' });
    // On to the next, the toast with it.
    await waitFor(() =>
      expect(window.location.pathname).toBe('/inbox/batches/batch-1/items/item-2'),
    );
    expect(await screen.findByRole('region', { name: 'What was just done' })).toHaveTextContent(
      "is now the newest copy of Mansoor's old passport",
    );
  });

  it('refused by the vault — not theirs to change — the card stays, and says why', async () => {
    const state = at(
      '/inbox/batches/batch-1/items/item-1',
      (types) => [item('item-1', 'renewed.pdf', types, { renewals: [NEAR] })],
      {
        acceptRefuse: {
          'item-1': {
            status: 403,
            code: 'forbidden',
            message: 'You can only change your own documents.',
          },
        },
      },
    );
    fireEvent.click(
      await screen.findByRole('button', { name: "Add as a new version of Mansoor's passport" }),
    );
    expect(await screen.findByText('You can only change your own documents.')).toBeVisible();
    expect(window.location.pathname).toBe('/inbox/batches/batch-1/items/item-1');
    expect(state.batches?.[0]?.items[0]?.state).toBe('waiting');
    expect(versionUndoStore.get()).toBeNull();
  });

  it('a vault from before 0.8.0 offers nothing to add it to', async () => {
    at(
      '/inbox/batches/batch-1/items/item-1',
      (types) => [item('item-1', 'renewed.pdf', types, { renewals: [NEAR] })],
      { batchVersions: false },
    );
    await screen.findByRole('button', { name: /Accept and next/ });
    expect(screen.queryByText(/Looks like a new copy/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Add as a new version/ })).toBeNull();
  });

  it('the batch’s page says “Same as …” and “New version of …?”, each a link to the document', async () => {
    at('/inbox/batches/batch-1', (types) => [
      item('item-1', 'copy.pdf', types, { duplicate: SAME }),
      item('item-2', 'renewed.pdf', types, { renewals: [NEAR, NEAR_OLD] }),
      item('item-3', 'other.pdf', types),
    ]);
    const table = await screen.findByRole('grid', { name: /^Files in Scanned post/ });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(
      within(rows[0] as HTMLElement).getByRole('link', { name: "Same as Mansoor's passport" }),
    ).toHaveAttribute('href', '/documents/doc-1');
    expect(
      within(rows[1] as HTMLElement).getByRole('link', {
        name: "New version of Mansoor's passport?",
      }),
    ).toHaveAttribute('href', '/documents/doc-1');
    expect(rows[2]).not.toHaveTextContent(/Same as|New version of/);
    // A near match is Check: Accept all Ready counts only the file with none.
    expect(rows[1]).toHaveTextContent('Check');
    expect(screen.getByRole('button', { name: 'Accept all Ready (1)' })).toBeVisible();
    await expectAccessible();
  });
});
