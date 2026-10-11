import { sharedOutsideWords } from '@fdv/shared';
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
 * Adding documents from a collection's own page (Phase 6): "Add documents",
 * for whoever may put documents in it, opens a picker — a wide dialog with
 * R2's grid from 768 px, the whole screen with rows on a phone — that finds
 * documents by search or the table's list, narrows them by person, kind,
 * status and tag, marks what is in the collection already, and adds those
 * chosen with the vault's own call, all at once or none, saying what the
 * ⋯'s Add to a collection says.
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

/** Aisha's council tax bill, for the house. */
const COUNCIL_TAX = {
  ...PASSPORT,
  id: 'doc-3',
  type_key: null,
  title: 'Council tax bill',
  owner_member_id: 'm-0',
  category: 'home',
  issued: { date: '2026-04-01', precision: 'day' },
  expires: null,
  identifier: null,
  is_essential: false,
  tags: ['house'],
  status: { value: 'valid', label: 'Filed' },
  latest_version_id: 'v-3',
  etag: '"tax"',
};

/** Aisha's passport, run out. */
const AISHAS_PASSPORT = {
  ...PASSPORT,
  id: 'doc-4',
  title: "Aisha's passport",
  owner_member_id: 'm-0',
  identifier: null,
  is_essential: false,
  issued: { date: '2015-02-01', precision: 'day' },
  expires: { date: '2025-01-31', precision: 'month' },
  status: { value: 'expired', label: 'Expired' },
  latest_version_id: 'v-4',
  etag: '"aisha"',
};

/** The signed-in person's Only me will. */
const WILL = {
  ...PASSPORT,
  id: 'doc-5',
  type_key: null,
  title: 'My will',
  category: 'legal',
  visibility: 'private',
  issued: null,
  expires: null,
  identifier: null,
  is_essential: false,
  tags: [],
  status: { value: 'valid', label: 'Filed' },
  latest_version_id: 'v-5',
  etag: '"will"',
};

const DOCS = [PASSPORT, STATEMENT, COUNCIL_TAX, AISHAS_PASSPORT, WILL];

/** The signed-in person's collection for everyone, with their passport in it. */
const HOLIDAY: FakeCollection = {
  id: 'collection-h',
  name: 'Holiday',
  description: null,
  audience: 'everyone',
  owner_member_id: 'me',
  etag: '"holiday.1"',
  items: ['doc-1'],
};

const SAM = { ...ME, id: 'm-1', display_name: 'Sam', is_me: false, role: 'adult', colour: 2 };

/** The app at a collection's page, signed in as `role`, at `px` wide. */
function at(
  over: Partial<FakeState> = {},
  role: Role = 'owner',
  px = 1280,
  path = '/collections/collection-h',
): FakeState {
  atWidth(px);
  const state = fresh({
    documents: DOCS.map((d) => ({ ...d })),
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

const PICKER = 'Add documents to “Holiday”';

async function openPicker() {
  const button = await screen.findByRole('button', { name: 'Add documents' });
  button.focus();
  fireEvent.click(button);
  const dialog = await screen.findByRole('dialog', { name: PICKER });
  // The list has come: the first of it is there to choose.
  await within(dialog).findByRole('checkbox', { name: "Choose “Aisha's passport”" });
  return { button, dialog };
}

/** The titles found, in order, as the picker shows them. */
const shown = (dialog: HTMLElement) =>
  [...dialog.querySelectorAll('.picker-title, .picker-list .doc-title')].map((e) => e.textContent);

const posts = (state: FakeState) =>
  state.calls
    .filter((c) => c.method === 'POST' && c.url.endsWith('/items'))
    .map((c) => ({ url: c.url, body: c.body }));

const choose = (dialog: HTMLElement, title: string) =>
  fireEvent.click(within(dialog).getByRole('checkbox', { name: `Choose “${title}”` }));

const select = (dialog: HTMLElement, label: string, value: string) =>
  fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });

describe("a collection's Add documents (Phase 6)", () => {
  it('is offered only to whoever may put documents in that collection', async () => {
    // Its maker, an owner or an adult: the button, beside its heading.
    for (const role of ['owner', 'adult', 'teen'] as const) {
      at({}, role);
      expect(await screen.findByRole('button', { name: 'Add documents' })).toBeInTheDocument();
      cleanup();
    }

    // Somebody else's collection: the ⋯'s Add to a collection would not offer it either.
    at({ collections: [{ ...HOLIDAY, owner_member_id: 'm-1' }] });
    expect(await screen.findByText('Only Sam, who made this collection, can change it.'));
    expect(screen.queryByRole('button', { name: 'Add documents' })).not.toBeInTheDocument();
    cleanup();

    // Theirs, but for people they are no longer one of (A18).
    at({ collections: [{ ...HOLIDAY, audience: 'adults' }] }, 'teen');
    expect(await screen.findByText(/This collection is for people you are no longer one of/));
    expect(screen.queryByRole('button', { name: 'Add documents' })).not.toBeInTheDocument();
    cleanup();

    // A viewer, given the collection (5.33), or who made it before they were one.
    for (const owner of ['m-9', 'me']) {
      at(
        {
          collections: [{ ...HOLIDAY, owner_member_id: owner }],
          myRestriction: {
            summary: 'You can see: the collection “Holiday”.',
            people: [],
            types: [],
            collections: [{ id: 'collection-h', name: 'Holiday' }],
            include_adults_only: false,
            include_no_person_docs: false,
            expires_at: null,
          },
        },
        'viewer',
      );
      expect(await screen.findByRole('heading', { name: 'In this collection' }));
      expect(await screen.findByText('1 document')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Add documents' })).not.toBeInTheDocument();
      cleanup();
    }
  });

  it('opens a named dialog that keeps the focus, and gives it back', async () => {
    at();
    const { button, dialog } = await openPicker();
    // Named, and the search has the focus first.
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('heading', { name: PICKER })).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Search')).toHaveFocus();
    // Tab stays inside: from the last back to the first, and back again.
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    cancel.focus();
    fireEvent.keyDown(cancel, { key: 'Tab' });
    expect(within(dialog).getByLabelText('Search')).toHaveFocus();
    fireEvent.keyDown(within(dialog).getByLabelText('Search'), { key: 'Tab', shiftKey: true });
    expect(cancel).toHaveFocus();
    // Escape is an answer: closed, nothing added, the focus where it was.
    fireEvent.keyDown(cancel, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
    // Cancel too.
    fireEvent.click(button);
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: PICKER })).getByRole('button', {
        name: 'Cancel',
      }),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it('search and each filter narrow what is found, the count said politely', async () => {
    const state = at();
    const { dialog } = await openPicker();
    const count = dialog.querySelector('.picker-count') as HTMLElement;
    expect(count).toHaveAttribute('role', 'status');
    expect(count).toHaveTextContent('5 documents');
    expect(shown(dialog)).toEqual([
      "Aisha's passport",
      'Barclays statement, September 2026',
      'Council tax bill',
      "Mansoor's passport",
      'My will',
    ]);
    // Each control has a name.
    for (const label of ['Search', 'Person', 'Kind', 'Status', 'Tag']) {
      expect(within(dialog).getByLabelText(label)).toBeInTheDocument();
    }

    // By person, kind, status and tag: the Documents table's own filters, asked of the vault.
    select(dialog, 'Person', 'm-0');
    await waitFor(() => expect(shown(dialog)).toEqual(["Aisha's passport", 'Council tax bill']));
    expect(count).toHaveTextContent('2 documents match these filters');
    expect(state.calls.some((c) => c.url.includes('member_id=m-0'))).toBe(true);
    select(dialog, 'Person', '');
    select(dialog, 'Kind', 'bank_statement');
    await waitFor(() => expect(shown(dialog)).toEqual(['Barclays statement, September 2026']));
    select(dialog, 'Kind', '');
    select(dialog, 'Status', 'expired');
    await waitFor(() => expect(shown(dialog)).toEqual(["Aisha's passport"]));
    select(dialog, 'Status', '');
    select(dialog, 'Tag', 'house');
    await waitFor(() => expect(shown(dialog)).toEqual(['Council tax bill']));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(shown(dialog)).toHaveLength(5));

    // By words: the app's own search.
    fireEvent.change(within(dialog).getByLabelText('Search'), { target: { value: 'Barclays' } });
    await waitFor(() => expect(shown(dialog)).toEqual(['Barclays statement, September 2026']));
    expect(count).toHaveTextContent('1 document found');
    expect(state.calls.some((c) => c.url.startsWith('/api/v1/search?q=Barclays'))).toBe(true);

    // Words and filters together: whose by the search, the rest by what each says of itself.
    fireEvent.change(within(dialog).getByLabelText('Search'), { target: { value: 'passport' } });
    await waitFor(() => expect(shown(dialog)).toEqual(["Mansoor's passport", "Aisha's passport"]));
    select(dialog, 'Person', 'm-0');
    await waitFor(() => expect(shown(dialog)).toEqual(["Aisha's passport"]));
    expect(state.calls.some((c) => /\/api\/v1\/search\?.*member_id=m-0/.test(c.url))).toBe(true);
    select(dialog, 'Person', '');
    select(dialog, 'Status', 'active');
    await waitFor(() => expect(shown(dialog)).toEqual(["Mansoor's passport"]));
    select(dialog, 'Status', '');
    select(dialog, 'Kind', 'bank_statement');
    await waitFor(() => expect(shown(dialog)).toEqual([]));
    expect(within(dialog).getByText(/Nothing matches/)).toBeInTheDocument();
    select(dialog, 'Kind', '');
    select(dialog, 'Tag', 'house');
    await waitFor(() => expect(shown(dialog)).toEqual([]));
    select(dialog, 'Tag', 'travel');
    await waitFor(() => expect(shown(dialog)).toEqual(["Mansoor's passport", "Aisha's passport"]));
    // The grid's columns, as the table's: what each found document says.
    const row = within(dialog)
      .getAllByRole('row')
      .find((r) => r.textContent?.includes("Aisha's passport")) as HTMLElement;
    expect(row.textContent).toContain('Passport');
    expect(row.textContent).toContain('Aisha');
    expect(row.textContent).toContain('1 Feb 2015');
    expect(row.textContent).toContain('Jan 2025');
    await expectAccessible();
  });

  it('marks what is in the collection already, and never offers it', async () => {
    at();
    const { dialog } = await openPicker();
    const marked = () =>
      within(dialog)
        .getAllByRole('row')
        .find((r) => r.textContent?.includes("Mansoor's passport")) as HTMLTableRowElement;
    expect(marked()).toHaveTextContent('In this collection');
    expect(
      within(dialog).queryByRole('checkbox', { name: "Choose “Mansoor's passport”" }),
    ).not.toBeInTheDocument();
    // Pressing its row chooses nothing.
    fireEvent.click(marked().cells[1] as HTMLElement);
    expect(within(dialog).getByText('Nothing chosen yet')).toBeInTheDocument();
    // Nor does choosing all of them shown.
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Select all 4 shown' }));
    expect(within(dialog).getByText('4 chosen')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Select all 4 shown' }));

    // Found by search too: the vault's list of what is in it says so.
    fireEvent.change(within(dialog).getByLabelText('Search'), { target: { value: 'passport' } });
    await waitFor(() => expect(shown(dialog)).toEqual(["Mansoor's passport", "Aisha's passport"]));
    expect(marked()).toHaveTextContent('In this collection');
    expect(
      within(dialog).queryByRole('checkbox', { name: "Choose “Mansoor's passport”" }),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).getByRole('checkbox', { name: "Choose “Aisha's passport”" }),
    ).toBeInTheDocument();
  });

  it('adds many at once with the vault’s own call, says so, and gives the note the focus', async () => {
    const state = at();
    const { button, dialog } = await openPicker();
    const add = () => within(dialog).getByRole('button', { name: /^Add .*“Holiday”$/ });
    // Nothing chosen: nothing to add.
    expect(add()).toBeDisabled();
    expect(add()).toHaveTextContent('Add to “Holiday”');
    choose(dialog, 'Barclays statement, September 2026');
    // A row pressed anywhere chooses it.
    const taxRow = within(dialog)
      .getAllByRole('row')
      .find((r) => r.textContent?.includes('Council tax bill')) as HTMLTableRowElement;
    fireEvent.click(taxRow.cells[2] as HTMLElement);
    expect(within(dialog).getByText('2 chosen')).toHaveAttribute('role', 'status');
    // Chosen in one search, and still chosen in the next.
    fireEvent.change(within(dialog).getByLabelText('Search'), { target: { value: 'Aisha' } });
    await waitFor(() => expect(shown(dialog)).toEqual(["Aisha's passport"]));
    choose(dialog, "Aisha's passport");
    expect(add()).toBeEnabled();
    expect(add()).toHaveTextContent('Add 3 to “Holiday”');
    fireEvent.click(add());

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(posts(state)).toEqual([
      {
        url: '/api/v1/collections/collection-h/items',
        body: { document_ids: ['doc-2', 'doc-3', 'doc-4'] },
      },
    ]);
    const said = await screen.findByText('3 documents added to “Holiday”.');
    await waitFor(() => expect(said.closest('.bulk-outcome')).toHaveFocus());
    // The collection's list, loaded again.
    expect(await screen.findByText('4 documents')).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: /^Barclays statement, September 2026/ }),
    ).toBeInTheDocument();
    await expectAccessible();
    // Put away: back to the button.
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(button).toHaveFocus();
  });

  it('a refusal names what is not there any more; the rest stay chosen, and nothing went in', async () => {
    const state = at();
    const { dialog } = await openPicker();
    choose(dialog, 'Barclays statement, September 2026');
    choose(dialog, 'Council tax bill');
    // Gone meanwhile, somewhere else.
    state.documents = state.documents.filter((d) => d.id !== 'doc-3');
    const add = within(dialog).getByRole('button', { name: 'Add 2 to “Holiday”' });
    fireEvent.click(add);
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(
      'None of the 2 went into “Holiday”. This one is no longer in the vault, or no longer yours to see, so it is chosen no longer:',
    );
    expect(within(alert).getByText('“Council tax bill”')).toBeInTheDocument();
    expect(alert).toHaveTextContent('The other one is still chosen: add it again.');
    expect(within(dialog).getByText('1 chosen')).toBeInTheDocument();
    expect(
      within(dialog).getByRole('checkbox', { name: 'Choose “Barclays statement, September 2026”' }),
    ).toBeChecked();
    expect(within(dialog).getByRole('button', { name: 'Add 1 to “Holiday”' })).toHaveFocus();
    expect(state.collections?.[0]?.items).toEqual(['doc-1']);
    // What is found is asked for again: the one gone is not there.
    await waitFor(() => expect(shown(dialog)).not.toContain('Council tax bill'));

    // Refused for another reason: said, and every one still chosen.
    choose(dialog, 'My will');
    (state.collections as FakeCollection[])[0] = {
      ...(state.collections?.[0] as FakeCollection),
      owner_member_id: 'm-1',
    };
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add 2 to “Holiday”' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        'None of the 2 went into “Holiday”. Only the person who made this collection can change it.',
      ),
    );
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'They are still chosen, to try again.',
    );
    expect(within(dialog).getByText('2 chosen')).toBeInTheDocument();
    expect(state.collections?.[0]?.items).toEqual(['doc-1']);
    await expectAccessible();
  });

  it('says who else will see them (5.33), and asks first when the collection is shared outside (5.19)', async () => {
    // Given to a viewer: the vault's words, with what went in.
    at({ collectionWarnings: ['Jane (viewer) will be able to see these.'] });
    let { dialog } = await openPicker();
    choose(dialog, 'Council tax bill');
    choose(dialog, 'My will');
    // Not shared outside: nothing to ask.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add 2 to “Holiday”' }));
    expect(
      await screen.findByText(
        '2 documents added to “Holiday”. Jane (viewer) will be able to see these.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    cleanup();

    // Shared outside by a link that keeps up with it: said beside the button, and asked.
    const shared = { with: ['the visa agent'], following: true };
    const words = sharedOutsideWords(shared, 'owner');
    const state = at({ collections: [{ ...HOLIDAY, items: ['doc-1'], shared_outside: shared }] });
    ({ dialog } = await openPicker());
    expect(within(dialog).getByText(words)).toBeInTheDocument();
    choose(dialog, 'Council tax bill');
    const add = within(dialog).getByRole('button', { name: 'Add 1 to “Holiday”' });
    expect(add).toHaveAccessibleDescription(words);
    add.focus();
    fireEvent.click(add);
    let ask = await screen.findByRole('alertdialog', { name: 'Add 1 document to “Holiday”?' });
    expect(ask).toHaveAccessibleDescription(words);
    await expectAccessible();
    // Cancel is an answer: nothing went in, and the picker is as it was.
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(posts(state)).toEqual([]);
    expect(add).toHaveFocus();
    fireEvent.click(add);
    ask = await screen.findByRole('alertdialog', { name: 'Add 1 document to “Holiday”?' });
    fireEvent.click(within(ask).getByRole('button', { name: 'Add 1 document' }));
    expect(await screen.findByText('1 document added to “Holiday”.')).toBeInTheDocument();
    expect(posts(state)).toEqual([
      { url: '/api/v1/collections/collection-h/items', body: { document_ids: ['doc-3'] } },
    ]);
    cleanup();

    // A teen is told what they put in stays in the family, as the ⋯ tells them.
    at({ collections: [{ ...HOLIDAY, items: ['doc-1'], shared_outside: shared }] }, 'teen');
    ({ dialog } = await openPicker());
    expect(within(dialog).getByText(sharedOutsideWords(shared, 'teen'))).toBeInTheDocument();
  });

  it('an Only me document goes in as the ⋯ puts it in: offered, and sent the same way', async () => {
    const state = at();
    // Found and offered: whoever may see it may put it in a collection of theirs.
    const { dialog } = await openPicker();
    expect(within(dialog).getByRole('checkbox', { name: 'Choose “My will”' })).toBeEnabled();
    choose(dialog, 'My will');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add 1 to “Holiday”' }));
    expect(await screen.findByText('1 document added to “Holiday”.')).toBeInTheDocument();
    const fromPicker = posts(state);
    expect(fromPicker).toEqual([
      { url: '/api/v1/collections/collection-h/items', body: { document_ids: ['doc-5'] } },
    ]);

    // The same document from its row's ⋯ (Add to a collection): the same call.
    cleanup();
    const again = at({ collections: [{ ...HOLIDAY, items: [] }] }, 'owner', 320, '/documents');
    const more = await screen.findByRole('button', { name: 'Actions for “My will”' });
    fireEvent.click(more);
    fireEvent.click(
      within(await screen.findByRole('menu')).getByRole('menuitem', {
        name: 'Add to a collection',
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Add to “Holiday”' }));
    await screen.findByText('“My will” is in “Holiday” now.');
    expect(posts(again)).toEqual(fromPicker);
  });

  it('the grid works by keyboard as R2’s does, and Show more brings the next page', async () => {
    const many = Array.from({ length: 103 }, (_, i) => ({
      ...COUNCIL_TAX,
      id: `bill-${String(i).padStart(3, '0')}`,
      title: `Bill ${String(i).padStart(3, '0')}`,
      etag: `"b${i}"`,
    }));
    at();
    let { dialog } = await openPicker();
    let grid = within(dialog).getByRole('grid');
    // One stop for Tab: the first row's box.
    const first = within(grid).getByRole('checkbox', { name: "Choose “Aisha's passport”" });
    expect(first).toHaveAttribute('tabindex', '0');
    expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    const second = within(grid).getByRole('checkbox', {
      name: 'Choose “Barclays statement, September 2026”',
    });
    expect(second).toHaveFocus();
    // Space on the box chooses, as a box does.
    fireEvent.click(second);
    expect(within(dialog).getByText('1 chosen')).toBeInTheDocument();
    // Along the row, and back.
    fireEvent.keyDown(second, { key: 'ArrowRight' });
    expect(document.activeElement).toHaveTextContent('Barclays statement, September 2026');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' });
    expect(document.activeElement).toHaveTextContent('—');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' });
    expect(second).toHaveFocus();
    // Up to the head: its box chooses all of them shown.
    fireEvent.keyDown(second, { key: 'ArrowUp' });
    fireEvent.keyDown(first, { key: 'ArrowUp' });
    expect(within(grid).getByRole('checkbox', { name: /^Select all \d+ shown$/ })).toHaveFocus();
    // Past a row in the collection already, which has no box: its cell takes the focus.
    const inRow = within(grid)
      .getAllByRole('row')
      .find((r) => r.textContent?.includes("Mansoor's passport")) as HTMLTableRowElement;
    (inRow.cells[0] as HTMLElement).focus();
    fireEvent.keyDown(inRow.cells[0] as HTMLElement, { key: 'ArrowDown' });
    expect(within(grid).getByRole('checkbox', { name: 'Choose “My will”' })).toHaveFocus();

    // A page at a time, as the table: the next, with the focus on the first of it.
    cleanup();
    at({ documents: [...DOCS, ...many].map((d) => ({ ...d })) });
    ({ dialog } = await openPicker());
    grid = within(dialog).getByRole('grid');
    expect(within(dialog).getByText('100 of 108 shown')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(shown(dialog)).toHaveLength(108));
    await waitFor(() =>
      expect(within(grid).getByRole('checkbox', { name: 'Choose “Bill 098”' })).toHaveFocus(),
    );
    expect(within(dialog).queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  });

  it('on a phone, the whole screen, with rows to choose', async () => {
    const state = at({}, 'adult', 320);
    const { dialog } = await openPicker();
    expect(dialog).toHaveClass('picker');
    expect(within(dialog).queryByRole('grid')).not.toBeInTheDocument();
    const list = within(dialog).getByRole('list', { name: 'Documents found' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    // The one in the collection already, marked, with nothing to choose.
    const inside = within(list)
      .getAllByRole('listitem')
      .find((li) => li.textContent?.includes("Mansoor's passport")) as HTMLElement;
    expect(inside).toHaveTextContent('In this collection');
    expect(within(inside).queryByRole('checkbox')).not.toBeInTheDocument();
    // A row, pressed anywhere, chooses: its box is named for it.
    fireEvent.click(within(list).getByText('Council tax bill'));
    expect(
      within(dialog).getByRole('checkbox', { name: 'Choose “Council tax bill”' }),
    ).toBeChecked();
    expect(within(list).getByText('Passport · Aisha · Expires Jan 2025')).toBeInTheDocument();
    await expectAccessible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add 1 to “Holiday”' }));
    const said = await screen.findByText('1 document added to “Holiday”.');
    await waitFor(() => expect(said.closest('.bulk-outcome')).toHaveFocus());
    expect(posts(state)).toEqual([
      { url: '/api/v1/collections/collection-h/items', body: { document_ids: ['doc-3'] } },
    ]);
  });
});
