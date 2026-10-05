import { COLLECTION_HINT_TEENS } from '@fdv/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { UNREACHABLE } from './app-context.js';
import { NEVER_WIDENS, VIEWERS_NEED_A_GRANT } from './collections.js';
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
 * Collections on the web (5.15): the Collections screen and a collection's page, making and
 * changing a collection with who it is for, "Add to a collection" from any row's ⋯ and
 * from a document's page, Select in search, and taking a document out of a
 * collection, which asks first. Every number on screen is the vault's.
 */

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});
afterEach(() => {
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

const PASSPORT_MENU = "Actions for “Mansoor's passport”";

/** A council tax bill in Aisha's name. */
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

/** The signed-in member's collection for everyone. */
const HOLIDAY: FakeCollection = {
  id: 'collection-h',
  name: 'Holiday',
  description: null,
  audience: 'everyone',
  owner_member_id: 'me',
  etag: '"holiday.1"',
  items: [],
};

/** Another adult, who makes collections of their own. */
const SAM = {
  ...ME,
  id: 'm-1',
  display_name: 'Sam',
  is_me: false,
  role: 'adult',
  colour: 2,
};

/** What Teens and up means, told apart from Everyone in the family (A17). */
const TEENS_AND_UP =
  'The same people as Everyone in the family: owners, adults and teens. Unlike Everyone, it can never be granted to a viewer.';

/** The app at `path`, signed in as `role`, with `over` in the vault. */
function at(
  path: string,
  over: Partial<FakeState> = {},
  role: 'owner' | 'adult' | 'teen' | 'viewer' = 'owner',
): FakeState {
  const state = fresh(over);
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

/** The same vault, the app opened again at `path`. */
function reopen(state: FakeState, path: string) {
  cleanup();
  installFakeApi(state);
  window.history.replaceState({}, '', path);
  render(<App />);
}

/** The ⋯ for one row, focused and pressed, and the menu it opens. */
async function openMenu(name = PASSPORT_MENU) {
  const more = await screen.findByRole('button', { name });
  more.focus();
  fireEvent.click(more);
  const menu = await screen.findByRole('menu', { name });
  return { more, menu };
}

const offered = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole('menuitem')
    .map((item) => item.textContent);

/** "Add to a collection" from the ⋯ called `name`, into `collection`; the sheet, done with. */
async function addFromMenu(name: string, title: string, collection: string) {
  const { more, menu } = await openMenu(name);
  fireEvent.click(await within(menu).findByRole('menuitem', { name: 'Add to a collection' }));
  const sheet = await screen.findByRole('dialog', { name: `Add “${title}” to a collection` });
  fireEvent.click(await within(sheet).findByRole('button', { name: `Add to “${collection}”` }));
  const said = `“${title}” is in “${collection}” now.`;
  expect(await within(sheet).findByText(said)).toHaveFocus();
  expect(within(sheet).getByText('In this collection')).toBeInTheDocument();
  return { more, sheet };
}

const posts = (state: FakeState) =>
  state.calls
    .filter((c) => c.method === 'POST' && c.url.endsWith('/items'))
    .map((c) => ({ url: c.url, body: c.body }));

describe('collections on the web (5.15)', () => {
  it("Add to a collection from a search result, a person's page and Home", async () => {
    const state = at('/search?q=passport', {
      documents: [{ ...PASSPORT }, { ...STATEMENT }, { ...COUNCIL_TAX }],
      members: [ME, AISHA],
      collections: [{ ...HOLIDAY }],
    });

    // A search result: its ⋯ fetches the document, then offers Add to a collection.
    const found = await addFromMenu(PASSPORT_MENU, "Mansoor's passport", 'Holiday');
    await expectAccessible();
    fireEvent.click(within(found.sheet).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(found.more).toHaveFocus();

    // A person's page.
    reopen(state, '/people/m-0');
    const theirs = await addFromMenu(
      'Actions for “Council tax bill”',
      'Council tax bill',
      'Holiday',
    );
    fireEvent.keyDown(within(theirs.sheet).getByRole('button', { name: 'Done' }), {
      key: 'Escape',
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // Home, whose Collections count what the reader sees in each, as the vault says.
    reopen(state, '/');
    const tile = await screen.findByRole('link', { name: /^Holiday/ });
    expect(tile).toHaveTextContent('2 documents');
    await addFromMenu(
      'Actions for “Barclays statement, September 2026”',
      'Barclays statement, September 2026',
      'Holiday',
    );

    // One document each time, in the order they were put in.
    expect(posts(state)).toEqual([
      { url: '/api/v1/collections/collection-h/items', body: { document_ids: ['doc-1'] } },
      { url: '/api/v1/collections/collection-h/items', body: { document_ids: ['doc-3'] } },
      { url: '/api/v1/collections/collection-h/items', body: { document_ids: ['doc-2'] } },
    ]);
    expect(state.collections?.[0]?.items).toEqual(['doc-1', 'doc-3', 'doc-2']);
  });

  it('the picker explains Teens and up, and that viewers need a grant', async () => {
    const state = at('/collections', { collections: [] }, 'teen');
    fireEvent.click(await screen.findByRole('button', { name: 'Make a collection' }));
    // Asked for before the collection is made, as its name is: marked so, in words.
    const who = screen.getByRole('group', { name: /^Who it is for/ });
    expect(who).toHaveAccessibleName('Who it is for required');

    // A teen is offered only what a teen is in: never the adults.
    expect(
      within(who)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Everyone in the family', 'Teens and up', 'Only me']);
    // Nothing is chosen for them, so nothing is said yet about who sees it.
    expect(within(who).queryByRole('button', { pressed: true })).not.toBeInTheDocument();
    expect(screen.queryByText(VIEWERS_NEED_A_GRANT)).not.toBeInTheDocument();
    expect(screen.getByText(NEVER_WIDENS)).toBeInTheDocument();

    // Everyone: all who file documents here, and a viewer only by a grant (A17).
    fireEvent.click(within(who).getByRole('button', { name: 'Everyone in the family' }));
    expect(
      screen.getByText(
        'Owners, adults and teens: everyone in the family who files documents here.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(VIEWERS_NEED_A_GRANT)).toBeInTheDocument();

    // Teens and up: the same people, told apart from Everyone by the one
    // thing that differs — no viewer is ever given it, granted or not.
    fireEvent.click(within(who).getByRole('button', { name: 'Teens and up' }));
    expect(within(who).getByRole('button', { name: 'Teens and up' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByText(TEENS_AND_UP)).toBeInTheDocument();
    expect(screen.queryByText(VIEWERS_NEED_A_GRANT)).not.toBeInTheDocument();

    // Only me: nobody else, so nothing about viewers either.
    fireEvent.click(within(who).getByRole('button', { name: 'Only me' }));
    expect(
      screen.getByText('Only you. Nobody else will see it, or know it is here, not even an owner.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(VIEWERS_NEED_A_GRANT)).not.toBeInTheDocument();
    fireEvent.click(within(who).getByRole('button', { name: 'Teens and up' }));
    await expectAccessible();

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Revision timetable' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make the collection' }));
    expect(
      await screen.findByRole('heading', { name: 'Revision timetable', level: 1 }),
    ).toBeInTheDocument();
    expect(
      state.calls.find((c) => c.method === 'POST' && c.url === '/api/v1/collections')?.body,
    ).toEqual({ name: 'Revision timetable', audience: 'teens', description: null });
    // What was made is said, and heard: it has the focus.
    await waitFor(() => expect(screen.getByText(/“Revision timetable” is made\./)).toHaveFocus());
    expect(screen.getByText(/The same people as Everyone in the family/)).toHaveTextContent(
      `Who it is for: Teens and up. ${TEENS_AND_UP}`,
    );

    // An adult is offered all four, in this order, and must choose one.
    cleanup();
    const adults = at('/collections', { collections: [] }, 'adult');
    fireEvent.click(await screen.findByRole('button', { name: 'Make a collection' }));
    const four = screen.getByRole('group', { name: /^Who it is for/ });
    expect(
      within(four)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Everyone in the family', 'Adults', 'Teens and up', 'Only me']);
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'The will' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make the collection' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Say who the collection is for.');
    // Where the answer goes: the first of the choices.
    expect(within(four).getByRole('button', { name: 'Everyone in the family' })).toHaveFocus();
    expect(adults.calls.some((c) => c.method === 'POST' && c.url === '/api/v1/collections')).toBe(
      false,
    );
    fireEvent.click(within(four).getByRole('button', { name: 'Adults' }));
    expect(
      screen.getByText('Owners and adults. Teens won’t see it, or know it is here.'),
    ).toBeInTheDocument();
  });

  it('removing asks first', async () => {
    const state = at('/collections/collection-h', {
      documents: [{ ...PASSPORT }, { ...COUNCIL_TAX, owner_member_id: 'me' }],
      collections: [{ ...HOLIDAY, items: ['doc-1', 'doc-3'] }],
    });
    expect(await screen.findByRole('heading', { name: 'Holiday', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('2 documents')).toBeInTheDocument();
    const deletes = () => state.calls.filter((c) => c.method === 'DELETE').map((c) => c.url);

    const first = await openMenu();
    expect(offered(first.menu)).toContain('Take out of this collection');
    fireEvent.click(
      within(first.menu).getByRole('menuitem', { name: 'Take out of this collection' }),
    );
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Take it out of this collection?',
    });
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus(),
    );
    expect(dialog).toHaveTextContent(
      "“Mansoor's passport” comes out of “Holiday”. It stays in the vault, and in any other collection it is in.",
    );
    await expectAccessible();

    // Cancel is an answer: nothing is taken out, and focus is back on the ⋯.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(first.more).toHaveFocus();
    expect(deletes()).toEqual([]);

    const again = await openMenu();
    fireEvent.click(
      within(again.menu).getByRole('menuitem', { name: 'Take out of this collection' }),
    );
    const sure = await screen.findByRole('alertdialog', {
      name: 'Take it out of this collection?',
    });
    fireEvent.click(within(sure).getByRole('button', { name: 'Take it out' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: PASSPORT_MENU })).not.toBeInTheDocument(),
    );
    expect(deletes()).toEqual(['/api/v1/collections/collection-h/items/doc-1']);
    expect(await screen.findByText('1 document')).toBeInTheDocument();
    // Focus went to the row that is left, not to nowhere.
    expect(document.activeElement?.closest('li')).toHaveTextContent('Council tax bill');
    // Still in the vault: only the collection changed.
    expect(state.documents.find((d) => d.id === 'doc-1')?.deleted_at).toBeNull();

    // Deleting the collection asks first too.
    fireEvent.click(screen.getByRole('button', { name: 'Delete this collection' }));
    const del = await screen.findByRole('alertdialog', { name: 'Delete this collection?' });
    expect(del).toHaveTextContent('The documents in it stay in the vault');
    fireEvent.keyDown(within(del).getByRole('button', { name: 'Cancel' }), { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(deletes()).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Delete this collection' }));
    const gone = await screen.findByRole('alertdialog', { name: 'Delete this collection?' });
    fireEvent.click(within(gone).getByRole('button', { name: 'Delete the collection' }));
    const said = await screen.findByText(
      'The collection “Holiday” is deleted. Its documents are still in the vault.',
    );
    await waitFor(() => expect(said).toHaveFocus());
    expect(window.location.pathname).toBe('/collections');
    expect(deletes()).toEqual([
      '/api/v1/collections/collection-h/items/doc-1',
      '/api/v1/collections/collection-h',
    ]);
    expect(await screen.findByText('No collections yet.')).toBeInTheDocument();
  });

  it('Select in search results puts several in a collection at once, or none', async () => {
    const tax: Record<string, unknown> = { ...COUNCIL_TAX };
    const state = at('/search', {
      documents: [{ ...PASSPORT }, { ...STATEMENT }, tax],
      collections: [{ ...HOLIDAY }],
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Select' }));
    const passport = screen.getByRole('checkbox', { name: "Select “Mansoor's passport”" });
    expect(passport).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Add to a collection' })).toBeDisabled();
    fireEvent.click(passport);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select “Council tax bill”' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    await expectAccessible();

    // One of them goes to the Trash meanwhile: none is put in.
    tax.deleted_at = '2026-09-26T10:04:00Z';
    fireEvent.click(screen.getByRole('button', { name: 'Add to a collection' }));
    const sheet = await screen.findByRole('dialog', { name: 'Add 2 documents to a collection' });
    fireEvent.click(await within(sheet).findByRole('button', { name: 'Add to “Holiday”' }));
    expect(await within(sheet).findByRole('alert')).toHaveTextContent(
      'None of the 2 went into “Holiday”: one of them is no longer in the vault, or no longer yours to see.',
    );
    expect(state.collections?.[0]?.items).toEqual([]);

    // Back, both go in together, in one request.
    tax.deleted_at = null;
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add to “Holiday”' }));
    expect(await within(sheet).findByText('2 documents added to “Holiday”.')).toBeInTheDocument();
    expect(posts(state).at(-1)).toEqual({
      url: '/api/v1/collections/collection-h/items',
      body: { document_ids: ['doc-1', 'doc-3'] },
    });
    expect(state.collections?.[0]?.items).toEqual(['doc-1', 'doc-3']);

    // Done: Select is over, and what happened is still said.
    fireEvent.click(within(sheet).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByText('2 documents added to “Holiday”.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select' })).toHaveFocus();
  });

  it('the maker sees per-item hints; anybody else sees none, and cannot change it', async () => {
    const state = at('/collections', {
      documents: [{ ...STATEMENT }],
      members: [ME, SAM],
      collections: [
        { ...HOLIDAY, items: ['doc-2'] },
        {
          // For everyone, as the maker's own is: the adults-only statement
          // would earn Sam a hint, and a hint here would be Sam's alone.
          id: 'collection-s',
          name: 'Sam’s tax',
          description: 'For the accountant, in March.',
          audience: 'everyone',
          owner_member_id: 'm-1',
          etag: '"sam.1"',
          items: ['doc-2'],
        },
      ],
    });
    const holiday = await screen.findByRole('link', { name: /^Holiday/ });
    expect(holiday).toHaveTextContent('1 document · Everyone in the family · Yours');
    expect(screen.getByRole('link', { name: /^Sam’s tax/ })).toHaveTextContent(
      '1 document · Everyone in the family · Made by Sam',
    );

    // The maker's own: the adults-only statement is in a collection for everyone,
    // and the maker alone is told the teens are not given it.
    fireEvent.click(holiday);
    expect(await screen.findByText(COLLECTION_HINT_TEENS)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit “Holiday”' })).toBeInTheDocument();
    await expectAccessible();

    // Somebody else's: no hint, no Edit, no Delete, and nothing to take out.
    reopen(state, '/collections/collection-s');
    expect(await screen.findByRole('heading', { name: 'Sam’s tax', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('For the accountant, in March.')).toBeInTheDocument();
    expect(
      screen.getByText('Only Sam, who made this collection, can change it.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(COLLECTION_HINT_TEENS)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Delete this collection' }),
    ).not.toBeInTheDocument();
    const { menu } = await openMenu('Actions for “Barclays statement, September 2026”');
    expect(offered(menu)).toContain('Add to a collection');
    expect(offered(menu)).not.toContain('Take out of this collection');
  });

  it('renaming is made to the collection as it was seen', async () => {
    const state = at('/collections/collection-h', {
      documents: [{ ...PASSPORT }],
      collections: [{ ...HOLIDAY, items: ['doc-1'] }],
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit “Holiday”' }));
    const name = screen.getByLabelText(/^Name/);
    expect(name).toHaveValue('Holiday');
    expect(
      within(screen.getByRole('group', { name: 'Who it is for required' })).getByRole('button', {
        name: 'Everyone in the family',
      }),
    ).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(name, { target: { value: 'Summer in Lisbon' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByRole('heading', { name: 'Summer in Lisbon', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText('“Summer in Lisbon” is saved.')).toHaveFocus();
    const patch = state.calls.find((c) => c.method === 'PATCH');
    expect(patch?.headers?.['if-match']).toBe('"holiday.1"');
    expect(patch?.body).toEqual({
      name: 'Summer in Lisbon',
      audience: 'everyone',
      description: null,
    });

    // Changed somewhere else since: nothing is overwritten, and it says so.
    const collection = state.collections?.[0] as FakeCollection;
    state.collections = [{ ...collection, name: 'Lisbon, August', etag: '"elsewhere"' }];
    fireEvent.click(screen.getByRole('button', { name: 'Edit “Summer in Lisbon”' }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Porto' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText(
        'This collection was changed somewhere else, so it has been loaded again. Try again if it still needs changing.',
      ),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: 'Lisbon, August', level: 1 }),
    ).toBeInTheDocument();
    expect(state.collections?.[0]?.name).toBe('Lisbon, August');
  });

  it('the document page puts it in a collection, a new one too, and names the collections it is in', async () => {
    const state = at('/documents/doc-1', {
      documents: [{ ...PASSPORT }],
      collections: [
        {
          ...HOLIDAY,
          id: 'collection-m',
          name: 'Mortgage',
          audience: 'adults',
          etag: '"m.1"',
          items: ['doc-1'],
        },
      ],
    });
    const collections = await screen.findByRole('region', { name: 'Collections' });
    expect(await within(collections).findByRole('link', { name: /^Mortgage/ })).toBeInTheDocument();
    const add = within(collections).getByRole('button', { name: 'Add to a collection' });
    add.focus();
    fireEvent.click(add);
    const sheet = await screen.findByRole('dialog', {
      name: "Add “Mansoor's passport” to a collection",
    });
    expect(await within(sheet).findByText('In this collection')).toBeInTheDocument();

    // A new collection, made here, and the passport put in it.
    fireEvent.click(within(sheet).getByRole('button', { name: 'Make a new collection' }));
    fireEvent.change(within(sheet).getByLabelText(/^Name/), { target: { value: 'Trip' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Only me' }));
    expect(
      within(sheet).getByText(
        'Only you. Nobody else will see it, or know it is here, not even an owner.',
      ),
    ).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Make it and add' }));
    expect(
      await within(sheet).findByText("“Mansoor's passport” is in “Trip” now."),
    ).toBeInTheDocument();
    expect(state.collections?.map((l) => [l.name, l.audience, l.items])).toEqual([
      ['Mortgage', 'adults', ['doc-1']],
      ['Trip', 'only_me', ['doc-1']],
    ]);
    await expectAccessible();

    fireEvent.click(within(sheet).getByRole('button', { name: 'Done' }));
    expect(add).toHaveFocus();
    expect(await within(collections).findByRole('link', { name: /^Trip/ })).toBeInTheDocument();
  });

  it('a long collection comes a page at a time, and its count is all the reader sees', async () => {
    at('/collections/collection-h', {
      documents: [{ ...PASSPORT }, { ...COUNCIL_TAX }],
      collections: [{ ...HOLIDAY, items: ['doc-1', 'doc-3'] }],
      collectionPageSize: 1,
    });
    expect(await screen.findByRole('button', { name: /^Mansoor's passport/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Council tax bill/ })).not.toBeInTheDocument();
    expect(screen.getByText('2 documents')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByRole('button', { name: /^Council tax bill/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  });

  it('a viewer given no collection sees no Collections entry, and nothing about collections anywhere', async () => {
    const state = at(
      '/',
      { documents: [{ ...PASSPORT }], collections: [{ ...HOLIDAY }] },
      'viewer',
    );
    expect(await screen.findByRole('heading', { name: 'Recently added' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Collections' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'All collections' })).not.toBeInTheDocument();
    const { menu } = await openMenu();
    expect(offered(menu)).toEqual(['Open', 'Download']);

    reopen(state, '/documents/doc-1');
    expect(
      await screen.findByRole('heading', { name: "Mansoor's passport", level: 1 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add to a collection' })).not.toBeInTheDocument();

    reopen(state, '/search');
    expect(await screen.findByRole('button', { name: /^Mansoor's passport/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Select' })).not.toBeInTheDocument();
    // A viewer's Home asks only for the collections given to them, and any
    // they made before they were a viewer (5.33, U515-11) — here none; a
    // document's collections are never asked for.
    expect(
      state.calls.filter((c) => c.url.includes('/collections')).map((c) => [c.method, c.url]),
    ).toEqual([['GET', '/api/v1/collections']]);
  });

  it('a vault from before collections offers none', async () => {
    const state = at('/', { documents: [{ ...PASSPORT }] });
    expect(await screen.findByRole('heading', { name: 'Recently added' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Collections' })).not.toBeInTheDocument();
    const { menu } = await openMenu();
    expect(offered(menu)).not.toContain('Add to a collection');
    expect(state.calls.some((c) => c.url.includes('/collections'))).toBe(false);
  });

  it('in Select, pressing a row ticks its box and never leaves the results', async () => {
    at('/search', {
      documents: [{ ...PASSPORT }, { ...COUNCIL_TAX }],
      collections: [{ ...HOLIDAY }],
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Select' }));
    const tax = screen.getByRole('checkbox', { name: 'Select “Council tax bill”' });

    // Pressed anywhere on it, the box is ticked, and what is chosen stays.
    fireEvent.click(screen.getByText('Council tax bill'));
    expect(window.location.pathname).toBe('/search');
    expect(tax).toBeChecked();
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    // The whole row is the box's label: a thumb's width, not the box's.
    expect(tax.closest('label')).toHaveTextContent('Council tax bill');
    fireEvent.click(screen.getByText('Council tax bill'));
    expect(tax).not.toBeChecked();
    expect(screen.getByText('0 selected')).toBeInTheDocument();

    // A search result too.
    fireEvent.change(screen.getByLabelText('Search everything'), {
      target: { value: 'passport' },
    });
    await screen.findByText(/searched inside the pages too/);
    fireEvent.click(screen.getByText("Mansoor's passport"));
    expect(screen.getByRole('checkbox', { name: "Select “Mansoor's passport”" })).toBeChecked();
    expect(window.location.pathname).toBe('/search');
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    // Its ⋯ is still its own, beside the label.
    const { menu } = await openMenu();
    expect(
      await within(menu).findByRole('menuitem', { name: 'Add to a collection' }),
    ).toBeVisible();
    fireEvent.keyDown(menu, { key: 'Escape' });
    await expectAccessible();
  });

  it('a chosen row that its own ⋯ takes out of the results is chosen no longer', async () => {
    const state = at('/search', {
      documents: [{ ...PASSPORT }, { ...STATEMENT }, { ...COUNCIL_TAX }],
      collections: [{ ...HOLIDAY }],
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Select' }));
    for (const title of [
      "Mansoor's passport",
      'Barclays statement, September 2026',
      'Council tax bill',
    ]) {
      fireEvent.click(screen.getByRole('checkbox', { name: `Select “${title}”` }));
    }
    expect(screen.getByText('3 selected')).toBeInTheDocument();

    // To the Trash from its own ⋯: out of the results, and out of the choice.
    const { menu } = await openMenu('Actions for “Council tax bill”');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to Trash' }));
    const sure = await screen.findByRole('alertdialog', { name: 'Move to Trash?' });
    fireEvent.click(within(sure).getByRole('button', { name: 'Move to Trash' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('checkbox', { name: 'Select “Council tax bill”' }),
      ).not.toBeInTheDocument(),
    );
    expect(await screen.findByText('2 selected')).toBeInTheDocument();
    // Focus went to the row before it, and in Select a row is its box.
    expect(
      screen.getByRole('checkbox', { name: 'Select “Barclays statement, September 2026”' }),
    ).toHaveFocus();

    // Another search: what was chosen in the last one stays chosen.
    fireEvent.change(screen.getByLabelText('Search everything'), {
      target: { value: 'passport' },
    });
    await screen.findByText(/searched inside the pages too/);
    expect(
      screen.queryByRole('checkbox', { name: 'Select “Barclays statement, September 2026”' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add to a collection' }));
    const sheet = await screen.findByRole('dialog', { name: 'Add 2 documents to a collection' });
    fireEvent.click(await within(sheet).findByRole('button', { name: 'Add to “Holiday”' }));
    expect(await within(sheet).findByText('2 documents added to “Holiday”.')).toBeInTheDocument();
    expect(state.collections?.[0]?.items).toEqual(['doc-1', 'doc-2']);
  });

  it('a collection that has gone while it was open says only that', async () => {
    const state = at('/collections/collection-h', {
      documents: [{ ...PASSPORT }, { ...COUNCIL_TAX }],
      collections: [{ ...HOLIDAY, items: ['doc-1', 'doc-3'] }],
      collectionPageSize: 1,
    });
    expect(await screen.findByRole('heading', { name: 'Holiday', level: 1 })).toBeInTheDocument();

    // Deleted somewhere else, and then Show more.
    state.collections = [];
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That collection does not exist.');
    expect(screen.queryByRole('heading', { name: 'Holiday' })).not.toBeInTheDocument();
    expect(screen.queryByText('2 documents')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: PASSPORT_MENU })).not.toBeInTheDocument();

    // The same when it is loaded again, after a row's ⋯ changed something.
    state.collections = [{ ...HOLIDAY, items: ['doc-1', 'doc-3'] }];
    reopen(state, '/collections/collection-h');
    expect(await screen.findByRole('heading', { name: 'Holiday', level: 1 })).toBeInTheDocument();
    state.collections = [];
    const { menu } = await openMenu();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Stop it being Essential' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That collection does not exist.');
    expect(screen.queryByRole('heading', { name: 'Holiday' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: PASSPORT_MENU })).not.toBeInTheDocument();

    // Add to a collection lets go of one that has gone meanwhile, and keeps the rest.
    state.collections = [
      { ...HOLIDAY },
      { ...HOLIDAY, id: 'collection-t', name: 'Trip', etag: '"t"' },
    ];
    reopen(state, '/');
    const home = await openMenu();
    fireEvent.click(within(home.menu).getByRole('menuitem', { name: 'Add to a collection' }));
    const sheet = await screen.findByRole('dialog', {
      name: "Add “Mansoor's passport” to a collection",
    });
    await within(sheet).findByRole('button', { name: 'Add to “Holiday”' });
    state.collections = state.collections?.filter((l) => l.id !== 'collection-h');
    // Pressed as a person presses it: the focus is on it.
    const holiday = within(sheet).getByRole('button', { name: 'Add to “Holiday”' });
    holiday.focus();
    fireEvent.click(holiday);
    expect(await within(sheet).findByRole('alert')).toHaveTextContent(
      '“Holiday” is not there any more, so nothing went into it.',
    );
    expect(
      within(sheet).queryByRole('button', { name: 'Add to “Holiday”' }),
    ).not.toBeInTheDocument();
    // Its Add button went, and the focus with it: to the next collection's, in the sheet.
    expect(within(sheet).getByRole('button', { name: 'Add to “Trip”' })).toBeEnabled();
    expect(within(sheet).getByRole('button', { name: 'Add to “Trip”' })).toHaveFocus();
  });

  it('Home’s collections are counted again after a row’s ⋯ changes what is in them', async () => {
    const state = at('/', {
      documents: [{ ...PASSPORT }, { ...STATEMENT }],
      collections: [{ ...HOLIDAY, items: ['doc-1'] }],
    });
    expect(await screen.findByRole('link', { name: /^Holiday/ })).toHaveTextContent(
      'Holiday1 document',
    );

    // Put in it from a row's ⋯: counted again once the sheet is done with.
    const { sheet } = await addFromMenu(
      'Actions for “Barclays statement, September 2026”',
      'Barclays statement, September 2026',
      'Holiday',
    );
    fireEvent.click(within(sheet).getByRole('button', { name: 'Done' }));
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /^Holiday/ })).toHaveTextContent(
        'Holiday2 documents',
      ),
    );

    // Moved to the Trash from its row: out of every collection, and counted so.
    const { menu } = await openMenu();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to Trash' }));
    const sure = await screen.findByRole('alertdialog', { name: 'Move to Trash?' });
    fireEvent.click(within(sure).getByRole('button', { name: 'Move to Trash' }));
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /^Holiday/ })).toHaveTextContent('Holiday1 document'),
    );
    expect(state.documents.find((d) => d.id === 'doc-1')?.deleted_at).not.toBeNull();
  });

  it('Home’s way to the collections stays while they load, and when they cannot be loaded', async () => {
    let release = () => {};
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = at('/', {
      documents: [{ ...PASSPORT }],
      collections: [{ ...HOLIDAY }],
      hold: (method, path) =>
        method === 'GET' && path === '/api/v1/collections' ? slow : undefined,
    });
    expect(await screen.findByRole('heading', { name: 'Collections' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All collections' })).toHaveAttribute(
      'href',
      '/collections',
    );
    release();
    expect(await screen.findByRole('link', { name: /^Holiday/ })).toHaveTextContent(
      'Holiday0 documents',
    );

    // Not to be had: it says so, and the way to them is still there.
    state.hold = (method, path) =>
      method === 'GET' && path === '/api/v1/collections'
        ? Promise.reject(new TypeError('Failed to fetch'))
        : undefined;
    reopen(state, '/');
    expect(await screen.findByRole('alert')).toHaveTextContent(UNREACHABLE);
    expect(screen.getByRole('heading', { name: 'Collections' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All collections' })).toHaveAttribute(
      'href',
      '/collections',
    );

    // Nothing to be had at all: Home says so once, not once more for the
    // collections. They fail first here, and Home's own loads after them.
    let fail = () => {};
    const home = new Promise<void>((_, reject) => {
      fail = () => reject(new TypeError('Failed to fetch'));
    });
    state.hold = (method, path) =>
      method === 'GET' && path === '/api/v1/collections'
        ? Promise.reject(new TypeError('Failed to fetch'))
        : method === 'GET' && path === '/api/v1/members'
          ? home
          : undefined;
    reopen(state, '/');
    const collections = await screen.findByRole('region', { name: 'Collections' });
    expect(await within(collections).findByRole('alert')).toHaveTextContent(UNREACHABLE);
    fail();
    await waitFor(() => expect(within(collections).queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getAllByRole('alert').map((a) => a.textContent)).toEqual([UNREACHABLE]);
    expect(screen.getByRole('link', { name: 'All collections' })).toHaveAttribute(
      'href',
      '/collections',
    );
  });

  it('Add to a collection offers only collections the reader may change, and says why when none', async () => {
    const state = at(
      '/',
      {
        documents: [{ ...PASSPORT }],
        members: [ME, SAM],
        collections: [
          { ...HOLIDAY },
          // Sam's, for everyone: a teen sees it, and cannot change it (A18).
          {
            ...HOLIDAY,
            id: 'collection-s',
            name: 'Sam’s trip',
            owner_member_id: 'm-1',
            etag: '"s"',
          },
          // The reader's own, for the adults, made before they were a teen.
          { ...HOLIDAY, id: 'collection-w', name: 'The will', audience: 'adults', etag: '"w"' },
        ],
      },
      'teen',
    );
    const opened = async () => {
      const { menu } = await openMenu();
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Add to a collection' }));
      return screen.findByRole('dialog', { name: "Add “Mansoor's passport” to a collection" });
    };
    const sheet = await opened();
    await within(sheet).findByRole('button', { name: 'Add to “Holiday”' });
    expect(
      within(sheet)
        .getAllByRole('listitem')
        .map((li) => li.querySelector('strong')?.textContent),
    ).toEqual(['Holiday']);
    expect(within(sheet).queryByText('Sam’s trip')).not.toBeInTheDocument();
    expect(within(sheet).queryByText('The will')).not.toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Done' }));

    // Only the one they made for the adults: not "none made", but why.
    state.collections = (state.collections ?? []).filter((l) => l.id !== 'collection-h');
    reopen(state, '/');
    const again = await opened();
    expect(
      await within(again).findByText(
        'The collection you made is for people you are no longer one of: you can still delete it, but not put documents in it.',
      ),
    ).toBeInTheDocument();
    expect(within(again).queryByText(/You haven’t made a collection yet/)).not.toBeInTheDocument();
    expect(
      within(again).getByRole('button', { name: 'Make a new collection' }),
    ).toBeInTheDocument();
    await expectAccessible();
  });

  it('an owner may delete a collection nobody can change any more, and only such a collection', async () => {
    const teen = { ...SAM, role: 'teen' };
    const state = at('/collections/collection-a', {
      documents: [{ ...PASSPORT }],
      members: [ME, teen],
      collections: [
        {
          id: 'collection-a',
          name: 'Sam’s savings',
          description: null,
          audience: 'adults',
          owner_member_id: 'm-1',
          etag: '"a"',
          items: ['doc-1'],
        },
        {
          id: 'collection-e',
          name: 'Sam’s revision',
          description: null,
          audience: 'everyone',
          owner_member_id: 'm-1',
          etag: '"e"',
          items: [],
        },
      ],
    });
    expect(
      await screen.findByRole('heading', { name: 'Sam’s savings', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Nobody can change this collection any more/)).toBeInTheDocument();
    const del = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete this collection' }));
      const sure = await screen.findByRole('alertdialog', { name: 'Delete this collection?' });
      fireEvent.click(within(sure).getByRole('button', { name: 'Delete the collection' }));
    };

    // Sam is an adult again before the owner presses: the vault says no.
    state.members = [ME, SAM];
    await del();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only the person who made this collection can change it.',
    );
    expect(state.collections?.map((l) => l.id)).toEqual(['collection-a', 'collection-e']);

    // A teen once more: nobody can change it, so its owner may clear it.
    state.members = [ME, teen];
    await del();
    expect(
      await screen.findByText(
        'The collection “Sam’s savings” is deleted. Its documents are still in the vault.',
      ),
    ).toBeInTheDocument();
    expect(state.collections?.map((l) => l.id)).toEqual(['collection-e']);

    // Sam's collection for everyone, which Sam, a teen, is one of: no Delete.
    reopen(state, '/collections/collection-e');
    expect(
      await screen.findByRole('heading', { name: 'Sam’s revision', level: 1 }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Only Sam, who made this collection, can change it.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Delete this collection' }),
    ).not.toBeInTheDocument();
  });

  it('a page after one whose last document has gone starts the collection again', async () => {
    const state = at('/collections/collection-h', {
      documents: [{ ...PASSPORT }, { ...COUNCIL_TAX }],
      collections: [{ ...HOLIDAY, items: ['doc-1', 'doc-3'] }],
      collectionPageSize: 1,
    });
    expect(await screen.findByRole('button', { name: /^Mansoor's passport/ })).toBeInTheDocument();

    // The passport comes out of it somewhere else: the page after it has nowhere to start.
    state.collections = [{ ...HOLIDAY, items: ['doc-3'] }];
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(
      await screen.findByText(
        'This collection changed while you were looking, so it has been loaded again.',
      ),
    ).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /^Council tax bill/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Mansoor's passport/ })).not.toBeInTheDocument();
    expect(screen.getByText('1 document')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  });

  it('a chosen row its ⋯ took out stays unchosen when another row’s ⋯ asks again meanwhile', async () => {
    const state = at('/search', {
      documents: [{ ...PASSPORT }, { ...STATEMENT }, { ...COUNCIL_TAX }],
      collections: [{ ...HOLIDAY }],
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Select' }));
    fireEvent.click(screen.getByRole('checkbox', { name: "Select “Mansoor's passport”" }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select “Council tax bill”' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    // The documents are slow to come back from now on.
    let release = () => {};
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.hold = (method, path) =>
      method === 'GET' && path === '/api/v1/documents' ? slow : undefined;
    const browses = () =>
      state.calls.filter((c) => c.method === 'GET' && c.url.split('?')[0] === '/api/v1/documents')
        .length;
    const before = browses();

    // The bill to the Trash: the results are asked for again...
    const bill = await openMenu('Actions for “Council tax bill”');
    fireEvent.click(within(bill.menu).getByRole('menuitem', { name: 'Move to Trash' }));
    const sure = await screen.findByRole('alertdialog', { name: 'Move to Trash?' });
    fireEvent.click(within(sure).getByRole('button', { name: 'Move to Trash' }));
    await waitFor(() => expect(browses()).toBe(before + 1));

    // ...and before they come, the statement made Essential asks again.
    const statement = await openMenu('Actions for “Barclays statement, September 2026”');
    fireEvent.click(within(statement.menu).getByRole('menuitem', { name: 'Make it Essential' }));
    expect(
      await screen.findByText('“Barclays statement, September 2026” is Essential now.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(browses()).toBe(before + 2));

    // The second asking answers for both: the bill has left, and its pick with it.
    release();
    await waitFor(() =>
      expect(
        screen.queryByRole('checkbox', { name: 'Select “Council tax bill”' }),
      ).not.toBeInTheDocument(),
    );
    expect(await screen.findByText('1 selected')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: "Select “Mansoor's passport”" })).toBeChecked();
  });

  it('a row put in another collection from a collection’s page leaves the page as it was', async () => {
    const state = at('/collections/collection-h', {
      documents: [{ ...PASSPORT }, { ...COUNCIL_TAX }],
      collections: [
        { ...HOLIDAY, items: ['doc-1', 'doc-3'] },
        { ...HOLIDAY, id: 'collection-t', name: 'Trip', etag: '"t"' },
      ],
      collectionPageSize: 1,
    });
    expect(await screen.findByRole('button', { name: /^Mansoor's passport/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByRole('button', { name: /^Council tax bill/ })).toBeInTheDocument();

    // Already in this one, and put in another from its ⋯.
    const { more, menu } = await openMenu('Actions for “Council tax bill”');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Add to a collection' }));
    const sheet = await screen.findByRole('dialog', {
      name: 'Add “Council tax bill” to a collection',
    });
    fireEvent.click(await within(sheet).findByRole('button', { name: 'Add to “Trip”' }));
    expect(await within(sheet).findByText('“Council tax bill” is in “Trip” now.')).toHaveFocus();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Done' }));
    expect(state.collections?.map((l) => l.items)).toEqual([['doc-1', 'doc-3'], ['doc-3']]);
    // Nothing on this page changed: what Show more brought is still here,
    // and focus is back on the ⋯ that opened the sheet.
    expect(more).toHaveFocus();
    expect(screen.getByRole('button', { name: /^Mansoor's passport/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Council tax bill/ })).toBeInTheDocument();
  });

  it('a collection’s page says the vault is out of reach only while it is', async () => {
    const state = at('/collections/collection-h', {
      documents: [{ ...PASSPORT }],
      collections: [{ ...HOLIDAY, items: ['doc-1'] }],
    });
    expect(await screen.findByRole('heading', { name: 'Holiday', level: 1 })).toBeInTheDocument();

    // Out of reach when the collection is loaded again after its row's ⋯.
    state.hold = (method, path) =>
      method === 'GET' && path === '/api/v1/collections/collection-h'
        ? Promise.reject(new TypeError('Failed to fetch'))
        : undefined;
    const first = await openMenu();
    fireEvent.click(within(first.menu).getByRole('menuitem', { name: 'Stop it being Essential' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(UNREACHABLE);

    // Back, and loaded again: the page says nothing of it any more.
    delete state.hold;
    const second = await openMenu();
    fireEvent.click(within(second.menu).getByRole('menuitem', { name: 'Make it Essential' }));
    expect(await screen.findByText("“Mansoor's passport” is Essential now.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Holiday', level: 1 })).toBeInTheDocument();
  });

  it('a collection’s page says a viewer needs a grant under Everyone alone', async () => {
    const collections: FakeCollection[] = [
      { ...HOLIDAY, id: 'collection-e', name: 'For everyone' },
      { ...HOLIDAY, id: 'collection-a', name: 'For adults', audience: 'adults' },
      { ...HOLIDAY, id: 'collection-t', name: 'For teens and up', audience: 'teens' },
      { ...HOLIDAY, id: 'collection-m', name: 'For me', audience: 'only_me' },
    ];
    const said = {
      'collection-e': `Who it is for: Everyone in the family. Owners, adults and teens: everyone in the family who files documents here. ${VIEWERS_NEED_A_GRANT}`,
      'collection-a':
        'Who it is for: Adults. Owners and adults. Teens won’t see it, or know it is here.',
      'collection-t': `Who it is for: Teens and up. ${TEENS_AND_UP}`,
      'collection-m':
        'Who it is for: Only me. Only you. Nobody else will see it, or know it is here, not even an owner.',
    };
    const state = at('/collections/collection-e', { collections });
    for (const [id, line] of Object.entries(said)) {
      if (id !== 'collection-e') reopen(state, `/collections/${id}`);
      const name = collections.find((l) => l.id === id)?.name as string;
      expect(await screen.findByRole('heading', { name, level: 1 })).toBeInTheDocument();
      // All of the line, exactly: the grant sentence is in it, or not at all.
      expect(screen.getByText(/^Who it is for:/).textContent).toBe(line);
    }
  });

  it('Select puts at most 200 in a collection at once', async () => {
    // Search asks the vault a quarter of a second after the last key; here
    // at once, so the 26 searches cost only the drawing of their rows.
    const later = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((run: () => void, ms?: number) =>
      later(run, ms === 250 ? 0 : ms),
    );
    // 201 receipts from 26 shops, chosen a shop at a time: what is chosen
    // stays chosen from one search to the next, and each tick draws again
    // only the few rows of one shop.
    const shops = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((letter) => `Shop ${letter}`);
    const receipts = Array.from({ length: 201 }, (_, i) => ({
      ...COUNCIL_TAX,
      id: `doc-r${i + 1}`,
      title: `Receipt ${i + 1} from ${shops[i % shops.length]}`,
      etag: `"r${i + 1}"`,
    }));
    // Straight to the first shop's receipts: the browse of all 201 is never drawn.
    const state = at(`/search?q=${encodeURIComponent(shops[0] as string)}`, {
      documents: receipts,
      collections: [{ ...HOLIDAY }],
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Select' }));
    const box = (title: string) =>
      document.querySelector<HTMLInputElement>(`input[aria-label="Select “${title}”"]`);
    const picks = () => document.querySelectorAll<HTMLInputElement>('input.pick');
    for (const [i, shop] of shops.entries()) {
      if (i > 0) {
        fireEvent.change(screen.getByLabelText('Search everything'), { target: { value: shop } });
      }
      // Its receipts are on screen, and no other shop's.
      const theirs = receipts.filter((r) => r.title.endsWith(` from ${shop}`)).length;
      await waitFor(() => {
        expect(box(`Receipt ${i + 1} from ${shop}`)).not.toBeNull();
        expect(picks()).toHaveLength(theirs);
      });
      for (const pick of picks()) fireEvent.click(pick);
    }
    expect(screen.getByText('201 selected')).toBeInTheDocument();
    expect(screen.getByText('Up to 200 can go in a collection at once.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add to a collection' })).toBeDisabled();

    // One fewer, and they go in, all 200 in one request.
    fireEvent.click(box('Receipt 182 from Shop Z') as HTMLInputElement);
    expect(screen.getByText('200 selected')).toBeInTheDocument();
    expect(screen.queryByText('Up to 200 can go in a collection at once.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add to a collection' }));
    const sheet = await screen.findByRole('dialog', { name: 'Add 200 documents to a collection' });
    fireEvent.click(await within(sheet).findByRole('button', { name: 'Add to “Holiday”' }));
    expect(await within(sheet).findByText('200 documents added to “Holiday”.')).toBeInTheDocument();
    expect(posts(state)).toHaveLength(1);
    expect(state.collections?.[0]?.items).toHaveLength(200);
    expect(state.collections?.[0]?.items).not.toContain('doc-r182');
  }, 30_000);

  it('nothing links to /lists: Home, the Collections screen, a collection and a document say /collections (5.17b)', async () => {
    const hrefs: string[] = [];
    const drawn = () => {
      for (const a of document.querySelectorAll('a')) hrefs.push(a.getAttribute('href') ?? '');
    };
    const state = at('/', {
      documents: [{ ...PASSPORT }],
      collections: [{ ...HOLIDAY, items: ['doc-1'] }],
    });
    expect(await screen.findByRole('link', { name: /^Holiday/ })).toHaveAttribute(
      'href',
      '/collections/collection-h',
    );
    drawn();
    reopen(state, '/collections');
    expect(
      await screen.findByRole('heading', { name: 'Collections', level: 1 }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /^Holiday/ })).toBeInTheDocument();
    drawn();
    reopen(state, '/collections/collection-h');
    expect(await screen.findByRole('heading', { name: 'Holiday', level: 1 })).toBeInTheDocument();
    expect(await screen.findByText('In this collection')).toBeInTheDocument();
    drawn();
    reopen(state, '/documents/doc-1');
    const collections = await screen.findByRole('region', { name: 'Collections' });
    expect(await within(collections).findByRole('link', { name: /^Holiday/ })).toHaveAttribute(
      'href',
      '/collections/collection-h',
    );
    drawn();
    expect(hrefs).toContain('/collections');
    expect(hrefs.filter((h) => /\/lists\b/.test(h))).toEqual([]);
    expect(state.calls.filter((c) => /\/lists\b/.test(c.url))).toEqual([]);
  });
});
