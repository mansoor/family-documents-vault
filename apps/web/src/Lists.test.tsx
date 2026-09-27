import { LIST_HINT_TEENS } from '@fdv/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { VIEWERS_NEED_A_GRANT } from './lists.js';
import {
  AISHA,
  fresh,
  installFakeApi,
  ME,
  PASSPORT,
  signedIn,
  STATEMENT,
  type FakeList,
  type FakeState,
} from './test-api.js';

/**
 * Lists on the web (5.15): the Lists screen and a list's page, making and
 * changing a list with who it is for, "Add to a list" from any row's ⋯ and
 * from a document's page, Select in search, and taking a document off a
 * list, which asks first. Every number on screen is the vault's.
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

/** The signed-in member's list for everyone. */
const HOLIDAY: FakeList = {
  id: 'list-h',
  name: 'Holiday',
  description: null,
  audience: 'everyone',
  owner_member_id: 'me',
  etag: '"holiday.1"',
  items: [],
};

/** Another adult, who makes lists of their own. */
const SAM = {
  ...ME,
  id: 'm-1',
  display_name: 'Sam',
  is_me: false,
  role: 'adult',
  colour: 2,
};

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

/** "Add to a list" from the ⋯ called `name`, onto `list`; the sheet, done with. */
async function addFromMenu(name: string, title: string, list: string) {
  const { more, menu } = await openMenu(name);
  fireEvent.click(await within(menu).findByRole('menuitem', { name: 'Add to a list' }));
  const sheet = await screen.findByRole('dialog', { name: `Add “${title}” to a list` });
  fireEvent.click(await within(sheet).findByRole('button', { name: `Add to “${list}”` }));
  const said = `“${title}” is on “${list}” now.`;
  expect(await within(sheet).findByText(said)).toHaveFocus();
  expect(within(sheet).getByText('On this list')).toBeInTheDocument();
  return { more, sheet };
}

const posts = (state: FakeState) =>
  state.calls
    .filter((c) => c.method === 'POST' && c.url.endsWith('/items'))
    .map((c) => ({ url: c.url, body: c.body }));

describe('lists on the web (5.15)', () => {
  it("Add to a list from a search result, a person's page and Home", async () => {
    const state = at('/search?q=passport', {
      documents: [{ ...PASSPORT }, { ...STATEMENT }, { ...COUNCIL_TAX }],
      members: [ME, AISHA],
      lists: [{ ...HOLIDAY }],
    });

    // A search result: its ⋯ fetches the document, then offers Add to a list.
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

    // Home, whose Lists count what the reader sees on each, as the vault says.
    reopen(state, '/');
    const tile = await screen.findByRole('link', { name: /^Holiday/ });
    expect(tile).toHaveTextContent('2 documents');
    await addFromMenu(
      'Actions for “Barclays statement, September 2026”',
      'Barclays statement, September 2026',
      'Holiday',
    );

    // One document each time, in the order they were put on.
    expect(posts(state)).toEqual([
      { url: '/api/v1/lists/list-h/items', body: { document_ids: ['doc-1'] } },
      { url: '/api/v1/lists/list-h/items', body: { document_ids: ['doc-3'] } },
      { url: '/api/v1/lists/list-h/items', body: { document_ids: ['doc-2'] } },
    ]);
    expect(state.lists?.[0]?.items).toEqual(['doc-1', 'doc-3', 'doc-2']);
  });

  it('the picker explains Teens and up, and that viewers need a grant', async () => {
    const state = at('/lists', { lists: [] }, 'teen');
    fireEvent.click(await screen.findByRole('button', { name: 'Make a list' }));
    const who = screen.getByRole('group', { name: 'Who it is for' });

    // A teen is offered only what a teen is in: never the adults.
    expect(
      within(who)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Everyone in the family', 'Teens and up', 'Only me']);
    // Nothing is chosen for them, and a viewer is in none of them.
    expect(within(who).queryByRole('button', { pressed: true })).not.toBeInTheDocument();
    expect(screen.getByText(VIEWERS_NEED_A_GRANT)).toBeInTheDocument();
    expect(
      screen.getByText('Whoever sees a list sees only the documents on it they could see already.'),
    ).toBeInTheDocument();

    fireEvent.click(within(who).getByRole('button', { name: 'Teens and up' }));
    expect(within(who).getByRole('button', { name: 'Teens and up' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(
      screen.getByText('Owners, adults and teens: anyone from a teen up.'),
    ).toBeInTheDocument();
    expect(screen.getByText(VIEWERS_NEED_A_GRANT)).toBeInTheDocument();
    await expectAccessible();

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Revision timetable' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make the list' }));
    expect(
      await screen.findByRole('heading', { name: 'Revision timetable', level: 1 }),
    ).toBeInTheDocument();
    expect(state.calls.find((c) => c.method === 'POST' && c.url === '/api/v1/lists')?.body).toEqual(
      { name: 'Revision timetable', audience: 'teens', description: null },
    );
    // What was made is said, and heard: it has the focus.
    await waitFor(() => expect(screen.getByText(/“Revision timetable” is made\./)).toHaveFocus());
    expect(
      screen.getByText(/Owners, adults and teens: anyone from a teen up\./),
    ).toBeInTheDocument();

    // An adult is offered all four, in this order, and must choose one.
    cleanup();
    const adults = at('/lists', { lists: [] }, 'adult');
    fireEvent.click(await screen.findByRole('button', { name: 'Make a list' }));
    const four = screen.getByRole('group', { name: 'Who it is for' });
    expect(
      within(four)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Everyone in the family', 'Adults', 'Teens and up', 'Only me']);
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'The will' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make the list' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Say who the list is for.');
    expect(adults.calls.some((c) => c.method === 'POST' && c.url === '/api/v1/lists')).toBe(false);
    fireEvent.click(within(four).getByRole('button', { name: 'Adults' }));
    expect(
      screen.getByText('Owners and adults. Teens won’t see it, or know it is here.'),
    ).toBeInTheDocument();
  });

  it('removing asks first', async () => {
    const state = at('/lists/list-h', {
      documents: [{ ...PASSPORT }, { ...COUNCIL_TAX, owner_member_id: 'me' }],
      lists: [{ ...HOLIDAY, items: ['doc-1', 'doc-3'] }],
    });
    expect(await screen.findByRole('heading', { name: 'Holiday', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('2 documents')).toBeInTheDocument();
    const deletes = () => state.calls.filter((c) => c.method === 'DELETE').map((c) => c.url);

    const first = await openMenu();
    expect(offered(first.menu)).toContain('Take off this list');
    fireEvent.click(within(first.menu).getByRole('menuitem', { name: 'Take off this list' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Take it off this list?' });
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus(),
    );
    expect(dialog).toHaveTextContent(
      "“Mansoor's passport” comes off “Holiday”. It stays in the vault, and on any other list it is on.",
    );
    await expectAccessible();

    // Cancel is an answer: nothing is taken off, and focus is back on the ⋯.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(first.more).toHaveFocus();
    expect(deletes()).toEqual([]);

    const again = await openMenu();
    fireEvent.click(within(again.menu).getByRole('menuitem', { name: 'Take off this list' }));
    const sure = await screen.findByRole('alertdialog', { name: 'Take it off this list?' });
    fireEvent.click(within(sure).getByRole('button', { name: 'Take it off' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: PASSPORT_MENU })).not.toBeInTheDocument(),
    );
    expect(deletes()).toEqual(['/api/v1/lists/list-h/items/doc-1']);
    expect(await screen.findByText('1 document')).toBeInTheDocument();
    // Focus went to the row that is left, not to nowhere.
    expect(document.activeElement?.closest('li')).toHaveTextContent('Council tax bill');
    // Still in the vault: only the list changed.
    expect(state.documents.find((d) => d.id === 'doc-1')?.deleted_at).toBeNull();

    // Deleting the list asks first too.
    fireEvent.click(screen.getByRole('button', { name: 'Delete this list' }));
    const del = await screen.findByRole('alertdialog', { name: 'Delete this list?' });
    expect(del).toHaveTextContent('The documents on it stay in the vault');
    fireEvent.keyDown(within(del).getByRole('button', { name: 'Cancel' }), { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(deletes()).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Delete this list' }));
    const gone = await screen.findByRole('alertdialog', { name: 'Delete this list?' });
    fireEvent.click(within(gone).getByRole('button', { name: 'Delete the list' }));
    const said = await screen.findByText(
      'The list “Holiday” is deleted. Its documents are still in the vault.',
    );
    await waitFor(() => expect(said).toHaveFocus());
    expect(window.location.pathname).toBe('/lists');
    expect(deletes()).toEqual(['/api/v1/lists/list-h/items/doc-1', '/api/v1/lists/list-h']);
    expect(await screen.findByText('No lists yet.')).toBeInTheDocument();
  });

  it('Select in search results puts several on a list at once, or none', async () => {
    const tax: Record<string, unknown> = { ...COUNCIL_TAX };
    const state = at('/search', {
      documents: [{ ...PASSPORT }, { ...STATEMENT }, tax],
      lists: [{ ...HOLIDAY }],
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Select' }));
    const passport = screen.getByRole('checkbox', { name: "Select “Mansoor's passport”" });
    expect(passport).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Add to a list' })).toBeDisabled();
    fireEvent.click(passport);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select “Council tax bill”' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    await expectAccessible();

    // One of them goes to the Trash meanwhile: none is put on.
    tax.deleted_at = '2026-09-26T10:04:00Z';
    fireEvent.click(screen.getByRole('button', { name: 'Add to a list' }));
    const sheet = await screen.findByRole('dialog', { name: 'Add 2 documents to a list' });
    fireEvent.click(await within(sheet).findByRole('button', { name: 'Add to “Holiday”' }));
    expect(await within(sheet).findByRole('alert')).toHaveTextContent(
      'That document is not in the vault.',
    );
    expect(state.lists?.[0]?.items).toEqual([]);

    // Back, both go on together, in one request.
    tax.deleted_at = null;
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add to “Holiday”' }));
    expect(await within(sheet).findByText('2 documents added to “Holiday”.')).toBeInTheDocument();
    expect(posts(state).at(-1)).toEqual({
      url: '/api/v1/lists/list-h/items',
      body: { document_ids: ['doc-1', 'doc-3'] },
    });
    expect(state.lists?.[0]?.items).toEqual(['doc-1', 'doc-3']);

    // Done: Select is over, and what happened is still said.
    fireEvent.click(within(sheet).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByText('2 documents added to “Holiday”.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select' })).toHaveFocus();
  });

  it('the maker sees per-item hints; anybody else sees none, and cannot change it', async () => {
    const state = at('/lists', {
      documents: [{ ...STATEMENT }],
      members: [ME, SAM],
      lists: [
        { ...HOLIDAY, items: ['doc-2'] },
        {
          id: 'list-s',
          name: 'Sam’s tax',
          description: 'For the accountant, in March.',
          audience: 'adults',
          owner_member_id: 'm-1',
          etag: '"sam.1"',
          items: ['doc-2'],
        },
      ],
    });
    const holiday = await screen.findByRole('link', { name: /^Holiday/ });
    expect(holiday).toHaveTextContent('1 document · Everyone in the family · Yours');
    expect(screen.getByRole('link', { name: /^Sam’s tax/ })).toHaveTextContent(
      '1 document · Adults · Made by Sam',
    );

    // The maker's own: the adults-only statement is on a list for everyone,
    // and the maker alone is told the teens are not given it.
    fireEvent.click(holiday);
    expect(await screen.findByText(LIST_HINT_TEENS)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit “Holiday”' })).toBeInTheDocument();
    await expectAccessible();

    // Somebody else's: no hint, no Edit, no Delete, and nothing to take off.
    reopen(state, '/lists/list-s');
    expect(await screen.findByRole('heading', { name: 'Sam’s tax', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('For the accountant, in March.')).toBeInTheDocument();
    expect(screen.getByText('Only Sam, who made this list, can change it.')).toBeInTheDocument();
    expect(screen.queryByText(LIST_HINT_TEENS)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete this list' })).not.toBeInTheDocument();
    const { menu } = await openMenu('Actions for “Barclays statement, September 2026”');
    expect(offered(menu)).toContain('Add to a list');
    expect(offered(menu)).not.toContain('Take off this list');
  });

  it('renaming is made to the list as it was seen', async () => {
    const state = at('/lists/list-h', {
      documents: [{ ...PASSPORT }],
      lists: [{ ...HOLIDAY, items: ['doc-1'] }],
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit “Holiday”' }));
    const name = screen.getByLabelText(/^Name/);
    expect(name).toHaveValue('Holiday');
    expect(
      within(screen.getByRole('group', { name: 'Who it is for' })).getByRole('button', {
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
    const list = state.lists?.[0] as FakeList;
    state.lists = [{ ...list, name: 'Lisbon, August', etag: '"elsewhere"' }];
    fireEvent.click(screen.getByRole('button', { name: 'Edit “Summer in Lisbon”' }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Porto' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText(
        'This list was changed somewhere else, so it has been loaded again. Try again if it still needs changing.',
      ),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: 'Lisbon, August', level: 1 }),
    ).toBeInTheDocument();
    expect(state.lists?.[0]?.name).toBe('Lisbon, August');
  });

  it('the document page puts it on a list, a new one too, and names the lists it is on', async () => {
    const state = at('/documents/doc-1', {
      documents: [{ ...PASSPORT }],
      lists: [
        {
          ...HOLIDAY,
          id: 'list-m',
          name: 'Mortgage',
          audience: 'adults',
          etag: '"m.1"',
          items: ['doc-1'],
        },
      ],
    });
    const lists = await screen.findByRole('region', { name: 'Lists' });
    expect(await within(lists).findByRole('link', { name: /^Mortgage/ })).toBeInTheDocument();
    const add = within(lists).getByRole('button', { name: 'Add to a list' });
    add.focus();
    fireEvent.click(add);
    const sheet = await screen.findByRole('dialog', { name: "Add “Mansoor's passport” to a list" });
    expect(await within(sheet).findByText('On this list')).toBeInTheDocument();

    // A new list, made here, and the passport put on it.
    fireEvent.click(within(sheet).getByRole('button', { name: 'Make a new list' }));
    fireEvent.change(within(sheet).getByLabelText(/^Name/), { target: { value: 'Trip' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Only me' }));
    expect(
      within(sheet).getByText(
        'Only you. Nobody else will see it, or know it is here, not even an owner.',
      ),
    ).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Make it and add' }));
    expect(
      await within(sheet).findByText("“Mansoor's passport” is on “Trip” now."),
    ).toBeInTheDocument();
    expect(state.lists?.map((l) => [l.name, l.audience, l.items])).toEqual([
      ['Mortgage', 'adults', ['doc-1']],
      ['Trip', 'only_me', ['doc-1']],
    ]);
    await expectAccessible();

    fireEvent.click(within(sheet).getByRole('button', { name: 'Done' }));
    expect(add).toHaveFocus();
    expect(await within(lists).findByRole('link', { name: /^Trip/ })).toBeInTheDocument();
  });

  it('a long list comes a page at a time, and its count is all the reader sees', async () => {
    at('/lists/list-h', {
      documents: [{ ...PASSPORT }, { ...COUNCIL_TAX }],
      lists: [{ ...HOLIDAY, items: ['doc-1', 'doc-3'] }],
      listPageSize: 1,
    });
    expect(await screen.findByRole('button', { name: /^Mansoor's passport/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Council tax bill/ })).not.toBeInTheDocument();
    expect(screen.getByText('2 documents')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByRole('button', { name: /^Council tax bill/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  });

  it('a viewer sees no Lists entry, and nothing about lists anywhere', async () => {
    const state = at('/', { documents: [{ ...PASSPORT }], lists: [{ ...HOLIDAY }] }, 'viewer');
    expect(await screen.findByRole('heading', { name: 'Recently added' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Lists' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'All lists' })).not.toBeInTheDocument();
    const { menu } = await openMenu();
    expect(offered(menu)).toEqual(['Open', 'Download']);

    reopen(state, '/documents/doc-1');
    expect(
      await screen.findByRole('heading', { name: "Mansoor's passport", level: 1 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add to a list' })).not.toBeInTheDocument();

    reopen(state, '/search');
    expect(await screen.findByRole('button', { name: /^Mansoor's passport/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Select' })).not.toBeInTheDocument();
    // Never asked for: a viewer's lists are not the family's to show.
    expect(state.calls.some((c) => c.url.includes('/lists'))).toBe(false);
  });

  it('a vault from before lists offers none', async () => {
    const state = at('/', { documents: [{ ...PASSPORT }] });
    expect(await screen.findByRole('heading', { name: 'Recently added' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Lists' })).not.toBeInTheDocument();
    const { menu } = await openMenu();
    expect(offered(menu)).not.toContain('Add to a list');
    expect(state.calls.some((c) => c.url.includes('/lists'))).toBe(false);
  });
});
