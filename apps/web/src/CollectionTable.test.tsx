import { COLLECTION_HINT_PRIVATE, COLLECTION_HINT_TEENS } from '@fdv/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import {
  AISHA,
  fresh,
  installFakeApi,
  ME,
  PASSPORT,
  signedIn,
  STATEMENT,
  type FakeCollection,
  type FakeState,
} from './test-api.js';

/**
 * A collection's documents as the Documents table (0.9.0; the owner's ask of
 * 24 Oct): from 768 px the table itself — its columns, sorts, boxes, the bar
 * for the chosen and a ⋯ on each row — for the documents in that one
 * collection the reader may see, and nothing else; Remove from this
 * collection in the ⋯ and in the bar, for its maker, said with Undo; and on
 * a phone, the list of rows. The vault's own rule for what each reader is
 * given is proved in the API's collection-table tests.
 */

type Role = 'owner' | 'adult' | 'teen' | 'viewer';

let width = 1280;
function atWidth(px: number) {
  width = px;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const minWidth = /\(min-width:\s*(\d+)px\)/.exec(query);
      const minHeight = /\(min-height:\s*(\d+)px\)/.exec(query);
      return {
        matches:
          (!minWidth || width >= Number(minWidth[1])) &&
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

const SAM = { ...ME, id: 'm-1', display_name: 'Sam', is_me: false, role: 'adult', colour: 2 };

const COUNCIL_TAX = {
  ...PASSPORT,
  id: 'doc-3',
  type_key: null,
  title: 'Council tax bill',
  owner_member_id: 'm-0',
  category: 'home',
  is_essential: false,
  latest_version_id: 'v-3',
  etag: '"tax"',
};
const AISHAS_PASSPORT = {
  ...PASSPORT,
  id: 'doc-4',
  title: "Aisha's passport",
  owner_member_id: 'm-0',
  is_essential: false,
  etag: '"aisha"',
};
/** The reader's own Only me will. */
const WILL = {
  ...PASSPORT,
  id: 'doc-5',
  type_key: null,
  title: 'My will',
  category: 'legal',
  visibility: 'private',
  is_essential: false,
  etag: '"will"',
};
/** Sam's own, Only me: never the reader's to see, nor to count. */
const SAMS_LETTER = {
  ...PASSPORT,
  id: 'doc-9',
  type_key: null,
  title: 'Sam’s private letter',
  owner_member_id: 'm-1',
  visibility: 'private',
  is_essential: false,
  etag: '"sam"',
};

const HOLIDAY: FakeCollection = {
  id: 'collection-h',
  name: 'Holiday',
  description: null,
  audience: 'everyone',
  owner_member_id: 'me',
  etag: '"holiday.1"',
  items: ['doc-1', 'doc-2', 'doc-3', 'doc-5', 'doc-9'],
};

function at(
  over: Partial<FakeState> = {},
  role: Role = 'owner',
  px = 1280,
  path = '/collections/collection-h',
): FakeState {
  atWidth(px);
  const state = fresh({
    documents: [PASSPORT, STATEMENT, COUNCIL_TAX, AISHAS_PASSPORT, WILL, SAMS_LETTER].map((d) => ({
      ...d,
    })),
    members: [{ ...ME, role }, AISHA, SAM],
    collections: [{ ...HOLIDAY, items: [...HOLIDAY.items] }],
    ...over,
  });
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

const grid = () => screen.findByRole('grid', { name: /^In “Holiday”, sorted by/ });
const titles = (t: HTMLElement) =>
  [...t.querySelectorAll('tbody tr:not(.empty-row) .cell-title')].map((c) => c.textContent);
const deletes = (state: FakeState) =>
  state.calls.filter((c) => c.method === 'DELETE').map((c) => c.url);

describe('a collection’s documents as the Documents table (0.9.0)', () => {
  it('shows only what is in it that the reader may see, sorted and counted as the table does', async () => {
    const state = at();
    const t = await grid();
    await waitFor(() =>
      expect(titles(t)).toEqual([
        'Barclays statement, September 2026',
        'Council tax bill',
        "Mansoor's passport",
        'My will',
      ]),
    );
    // Never one outside it, nor another's Only me in it — in a row or the count.
    expect(screen.queryByText("Aisha's passport")).not.toBeInTheDocument();
    expect(screen.queryByText('Sam’s private letter')).not.toBeInTheDocument();
    expect(screen.getByText('4 documents')).toBeInTheDocument();
    // The table's own call, for this collection.
    expect(
      state.calls.some(
        (c) =>
          c.url.startsWith('/api/v1/documents?') && c.url.includes('collection_id=collection-h'),
      ),
    ).toBe(true);
    // The table's columns, a ⋯ on each row, and — for its maker — who of its
    // audience is not given each one (5.14).
    const heads = within(t)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(heads.some((h) => h?.startsWith('Title'))).toBe(true);
    expect(heads).toContain('Who can see it');
    expect(heads).toContain('Not seen by');
    expect(heads.at(-1)).toBe('Actions');
    const row = (title: string) =>
      within(t)
        .getAllByRole('row')
        .find((r) => r.textContent?.includes(title)) as HTMLElement;
    expect(within(row('Barclays statement')).getByText('Teens')).toBeInTheDocument();
    expect(
      within(row('Barclays statement')).getByText('Teens').closest('[data-clip]'),
    ).toHaveAttribute('data-clip', COLLECTION_HINT_TEENS);
    expect(within(row('My will')).getByText('Everyone but you')).toBeInTheDocument();
    expect(
      within(row('My will')).getByText('Everyone but you').closest('[data-clip]'),
    ).toHaveAttribute('data-clip', COLLECTION_HINT_PRIVATE);
    expect(
      within(row("Mansoor's passport")).getByRole('button', {
        name: "Actions for “Mansoor's passport”",
      }),
    ).toBeInTheDocument();
    // Its own filters, never which collection: that is the page's.
    const filters = screen.getByRole('group', { name: 'Filters' });
    expect(within(filters).queryByRole('combobox', { name: 'Collection' })).toBeNull();
    expect(within(filters).getByRole('combobox', { name: 'Person' })).toBeInTheDocument();
    await expectAccessible();

    // Sorted by a column, as the table is: the other way, in the address.
    fireEvent.click(within(t).getByRole('button', { name: /^Title/ }));
    await waitFor(() =>
      expect(titles(t)).toEqual([
        'My will',
        "Mansoor's passport",
        'Council tax bill',
        'Barclays statement, September 2026',
      ]),
    );
    expect(window.location.pathname).toBe('/collections/collection-h');
    expect(window.location.search).toBe('?dir=desc');
    expect(within(t).getByRole('columnheader', { name: /^Title/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    // Filtered within it: only the collection's, still.
    fireEvent.change(within(filters).getByRole('combobox', { name: 'Person' }), {
      target: { value: 'm-0' },
    });
    await waitFor(() => expect(titles(t)).toEqual(['Council tax bill']));
    expect(screen.getByText('1 document match these filters')).toBeInTheDocument();
  });

  it('starts without the Collections column — every row is in this one — still offered under Columns, remembered apart from Documents (0.9.0)', async () => {
    const state = at();
    const t = await grid();
    await waitFor(() => expect(titles(t)).toHaveLength(4));
    const heads = () =>
      within(t)
        .getAllByRole('columnheader')
        .map((h) => h.textContent?.replace(/[▲▼]/g, '').trim());
    expect(heads()).not.toContain('Collections');
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    const box = screen.getByRole('checkbox', { name: 'Collections' });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    await waitFor(() => expect(heads()).toContain('Collections'));
    expect(JSON.parse(localStorage.getItem('fdv.collection.hidden-columns') ?? 'null')).toEqual([]);
    // Documents' own columns are as they were: Collections shown there.
    expect(localStorage.getItem('fdv.documents.hidden-columns')).toBeNull();
    cleanup();
    installFakeApi(state);
    window.history.replaceState({}, '', '/documents');
    render(<App />);
    const docs = await screen.findByRole('grid', { name: /^Documents, sorted by/ });
    await waitFor(() =>
      expect(
        within(docs)
          .getAllByRole('columnheader')
          .map((h) => h.textContent?.replace(/[▲▼]/g, '').trim()),
      ).toContain('Collections'),
    );
  });

  it('says its own words when nothing is in it', async () => {
    at({ collections: [{ ...HOLIDAY, items: [] }] });
    const t = await grid();
    expect(
      await within(t).findByText(
        'Nothing in this collection yet. Use Add documents, above, or Add to a collection in the ⋯ beside any document.',
      ),
    ).toBeInTheDocument();
  });

  it('takes the chosen out at once from the bar, with Undo, the documents untouched', async () => {
    const state = at();
    const t = await grid();
    await waitFor(() => expect(titles(t)).toHaveLength(4));
    fireEvent.click(within(t).getByRole('checkbox', { name: "Select “Mansoor's passport”" }));
    fireEvent.click(within(t).getByRole('checkbox', { name: 'Select “Council tax bill”' }));
    const bar = screen.getByRole('region', { name: 'What to do with the chosen documents' });
    expect(within(bar).getByText('2 selected')).toBeInTheDocument();
    expect(
      within(bar)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toContain('Remove from this collection');
    await expectAccessible();
    fireEvent.click(within(bar).getByRole('button', { name: 'Remove from this collection' }));
    const toast = await screen.findByRole('region', { name: 'What was just done' });
    expect(toast).toHaveTextContent(
      '2 documents taken out of “Holiday”. They are still in the vault.',
    );
    // The bar went with them: the focus is on what was done, Undo a Tab away.
    await waitFor(() => expect(toast).toHaveFocus());
    // Each by the vault's own call for one, in the table's order.
    expect(deletes(state)).toEqual([
      '/api/v1/collections/collection-h/items/doc-3',
      '/api/v1/collections/collection-h/items/doc-1',
    ]);
    await waitFor(() =>
      expect(titles(t)).toEqual(['Barclays statement, September 2026', 'My will']),
    );
    expect(await screen.findByText('2 documents')).toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'What to do with the chosen documents' }),
    ).toBeNull();
    // Nothing about the documents themselves changed.
    expect(state.calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(state.documents.filter((d) => d.deleted_at)).toEqual([]);
    await expectAccessible();

    // Undo: both back, by the vault's own Add.
    fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }));
    expect(
      await within(toast).findByText('2 documents are back in “Holiday”.'),
    ).toBeInTheDocument();
    expect(
      state.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/items')).map((c) => c.body),
    ).toEqual([{ document_ids: ['doc-3', 'doc-1'] }]);
    await waitFor(() => expect(titles(t)).toHaveLength(4));
    // Escape puts it away.
    fireEvent.keyDown(toast, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'What was just done' })).toBeNull();
  });

  it('a row’s ⋯ takes it out at once, the focus on the next row’s ⋯, with Undo', async () => {
    const state = at();
    const t = await grid();
    await waitFor(() => expect(titles(t)).toHaveLength(4));
    const more = within(t).getByRole('button', { name: 'Actions for “Council tax bill”' });
    more.focus();
    fireEvent.click(more);
    const menu = await screen.findByRole('menu', { name: 'Actions for “Council tax bill”' });
    const items = within(menu)
      .getAllByRole('menuitem')
      .map((i) => i.textContent);
    expect(items).toContain('Remove from this collection');
    expect(items).not.toContain('Mark as no longer needed');
    // A press inside the menu is the menu's: the row does not open.
    fireEvent.click(menu);
    expect(window.location.pathname).toBe('/collections/collection-h');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Remove from this collection' }));
    await waitFor(() => expect(titles(t)).not.toContain('Council tax bill'));
    expect(deletes(state)).toEqual(['/api/v1/collections/collection-h/items/doc-3']);
    expect(screen.getByRole('region', { name: 'What was just done' })).toHaveTextContent(
      '“Council tax bill” is out of “Holiday”. It is still in the vault.',
    );
    expect(document.activeElement).toHaveAccessibleName("Actions for “Mansoor's passport”");
    fireEvent.click(
      within(screen.getByRole('region', { name: 'What was just done' })).getByRole('button', {
        name: 'Undo',
      }),
    );
    await waitFor(() => expect(titles(t)).toContain('Council tax bill'));
  });

  it('what a row’s ⋯ has to say is said above the table', async () => {
    at();
    const t = await grid();
    await waitFor(() => expect(titles(t)).toHaveLength(4));
    fireEvent.click(within(t).getByRole('button', { name: "Actions for “Mansoor's passport”" }));
    const menu = await screen.findByRole('menu', { name: "Actions for “Mansoor's passport”" });
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Essential/ }));
    const said = await screen.findByText(/^“Mansoor's passport” is (not )?Essential/);
    expect(said.closest('td')).toBeNull();
    expect(said.closest('.bulk-outcome')).not.toBeNull();
  });

  it('somebody else’s collection: theirs to change, so no Remove, and no word of who is not given each', async () => {
    const theirs: FakeCollection = { ...HOLIDAY, owner_member_id: 'm-1' };
    at({ collections: [theirs] }, 'adult');
    const t = await grid();
    await waitFor(() => expect(titles(t)).toHaveLength(4));
    expect(screen.queryByText('Sam’s private letter')).not.toBeInTheDocument();
    expect(within(t).queryByRole('columnheader', { name: 'Not seen by' })).toBeNull();
    fireEvent.click(within(t).getByRole('checkbox', { name: "Select “Mansoor's passport”" }));
    const bar = screen.getByRole('region', { name: 'What to do with the chosen documents' });
    expect(within(bar).queryByRole('button', { name: 'Remove from this collection' })).toBeNull();
    fireEvent.click(within(t).getByRole('button', { name: "Actions for “Mansoor's passport”" }));
    const menu = await screen.findByRole('menu', { name: "Actions for “Mansoor's passport”" });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).not.toContain('Remove from this collection');
  });

  it('on a phone too, only its maker is told who is not given each', async () => {
    const theirs: FakeCollection = { ...HOLIDAY, owner_member_id: 'm-1' };
    at({ collections: [theirs] }, 'adult', 375);
    const section = await screen.findByRole('region', { name: 'In this collection' });
    expect(await within(section).findByText('Barclays statement, September 2026')).toBeVisible();
    expect(within(section).queryByText(COLLECTION_HINT_TEENS)).toBeNull();
    expect(within(section).queryByText(COLLECTION_HINT_PRIVATE)).toBeNull();
  });

  it('a teen is given what any list gives them: never Adults only, nor another’s Only me', async () => {
    const teens: FakeCollection = { ...HOLIDAY, owner_member_id: 'm-1', audience: 'teens' };
    at({ collections: [teens] }, 'teen');
    const t = await grid();
    // The will is the teen's own (they are "me" here); the statement is for adults.
    await waitFor(() =>
      expect(titles(t)).toEqual(['Council tax bill', "Mansoor's passport", 'My will']),
    );
    expect(screen.getByText('3 documents')).toBeInTheDocument();
    expect(screen.queryByText('Barclays statement, September 2026')).not.toBeInTheDocument();
  });

  it('on a phone, its rows as Documents shows them, with the filters in a sheet', async () => {
    at({}, 'owner', 375);
    const section = await screen.findByRole('region', { name: 'In this collection' });
    expect(await within(section).findByText('4 documents')).toBeInTheDocument();
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
    const rows = within(section).getAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('.doc-title')?.textContent)).toEqual([
      'Barclays statement, September 2026',
      'Council tax bill',
      "Mansoor's passport",
      'My will',
    ]);
    // Its maker is told who is not given each, as before.
    expect(within(section).getByText(COLLECTION_HINT_TEENS)).toBeInTheDocument();
    expect(within(section).getByText(COLLECTION_HINT_PRIVATE)).toBeInTheDocument();
    fireEvent.click(within(section).getByRole('button', { name: 'Filters' }));
    const sheet = await screen.findByRole('dialog', { name: 'Filters' });
    expect(within(sheet).queryByLabelText('Collection')).toBeNull();
    expect(within(sheet).getByLabelText('Sort by')).toBeInTheDocument();
    await expectAccessible();
    cleanup();
  });
});
