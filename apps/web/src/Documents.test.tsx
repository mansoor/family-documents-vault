import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { HIDDEN_COLUMNS_KEY } from './documents-table.js';
import {
  AISHA,
  fresh,
  installFakeApi,
  ME,
  PASSPORT,
  STATEMENT,
  signedIn,
  TOKENS,
  type FakeCollection,
  type FakeState,
} from './test-api.js';

/**
 * Documents as a table (Phase 6, R2): from 768 px a table — a column for
 * each fact, each a sort; filters in the address; columns this device
 * remembers; and boxes to choose many, with what may be done with all of
 * them. On a phone, today's rows, the filters in a sheet, Select as today.
 * Where the original is kept is the household's: never a viewer's or a
 * guest's, in any column, sort, filter or action.
 */

type Role = 'owner' | 'adult' | 'teen' | 'viewer';
const PHONE = 375;
const MID = 900;
const WIDE = 1280;

let width = WIDE;
let height = 900;
function atWidth(px: number, tall = 900) {
  width = px;
  height = tall;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const minWidth = /\(min-width:\s*(\d+)px\)/.exec(query);
      const minHeight = /\(min-height:\s*(\d+)px\)/.exec(query);
      return {
        matches:
          (!minWidth || width >= Number(minWidth[1])) &&
          (!minHeight || height >= Number(minHeight[1])) &&
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
});

const SARA = {
  ...AISHA,
  id: 'm-2',
  display_name: 'Sara Seikh',
  has_account: true,
  role: 'adult',
  colour: 3,
};

/** A document as a list gives it: each test's own on top of the passport's. */
const doc = (over: Record<string, unknown>) => ({
  ...PASSPORT,
  is_essential: false,
  tags: [],
  ...over,
  etag: `"${String(over.id)}"`,
});

const VISA = doc({
  id: 'doc-3',
  title: "Sara's visa",
  owner_member_id: 'm-2',
  issued: { date: '2019-05-01', precision: 'day' },
  expires: { date: '2026-08-01', precision: 'day' },
  physical_location: 'Desk drawer',
  filed_by_me: false,
  status: { value: 'expired', label: 'Expired 1 Aug 2026' },
});
const DEED = doc({
  id: 'doc-4',
  type_key: null,
  category: 'property',
  title: 'House deed',
  owner_member_id: null,
  issued: null,
  expires: null,
  physical_location: null,
  status: { value: 'needs_info', label: 'Needs a name' },
});

const TRAVEL: FakeCollection = {
  id: 'collection-t',
  name: 'Travel',
  description: null,
  audience: 'everyone',
  owner_member_id: 'me',
  etag: '"t.1"',
  items: ['doc-1', 'doc-3'],
};

/** The family's documents, and a collection to put them in. */
const FAMILY: Partial<FakeState> = {
  members: [ME, SARA, AISHA],
  documents: [{ ...PASSPORT, tags: ['travel'] }, { ...STATEMENT }, VISA, DEED],
  collections: [TRAVEL],
};

/** The app at `path`, `px` wide, signed in as `role`. */
function at(
  path: string,
  over: Partial<FakeState> = {},
  role: Role = 'owner',
  px: number = WIDE,
): FakeState {
  atWidth(px);
  // Each test its own copies: the fake changes what it is given.
  const state = fresh({
    ...FAMILY,
    ...over,
    documents: (over.documents ?? FAMILY.documents ?? []).map((d) => ({ ...d })),
    collections: (over.collections ?? FAMILY.collections ?? []).map((c) => ({
      ...c,
      items: [...c.items],
    })),
  });
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

const table = () => screen.findByRole('grid', { name: /^Documents, sorted by/ });
const headers = (t: HTMLElement) =>
  within(t)
    .getAllByRole('columnheader')
    .filter((th) => !th.classList.contains('col-pick'))
    .map((th) => th.textContent?.replace(/[▲▼]/g, '').trim())
    .filter((x) => x);
/** The titles in the table, top to bottom. */
const titles = (t: HTMLElement) =>
  within(t)
    .getAllByRole('row')
    .slice(1)
    .map((r) => r.querySelector('.cell-title')?.textContent ?? null);
/** How many the bar says are chosen; null with none chosen and no bar. */
const selected = () => document.querySelector('.bulk-count')?.textContent ?? null;
/** What Tab can reach in the grid. */
const gridStops = (t: HTMLElement) =>
  [...t.querySelectorAll<HTMLElement>('[tabindex], a, button, input')].filter(
    (el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled,
  );
/**
 * A press of the mouse as a browser makes it, which jsdom does not: the
 * focus goes to what can take it under the pointer — or, where nothing can
 * (a label's words), leaves what had it for nowhere; then the click.
 */
function press(el: HTMLElement) {
  fireEvent.mouseDown(el);
  const to = el.closest<HTMLElement>('a[href], button, input, select, textarea, [tabindex]');
  act(() => {
    if (to) to.focus();
    else (document.activeElement as HTMLElement | null)?.blur();
  });
  fireEvent.mouseUp(el);
  fireEvent.click(el);
}
const documentCalls = (state: FakeState) =>
  state.calls.filter((c) => c.method === 'GET' && /\/api\/v1\/documents\?/.test(c.url));
const lastQuery = (state: FakeState) =>
  new URLSearchParams(documentCalls(state).at(-1)?.url.split('?')[1] ?? '');

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

describe('the Documents table, from 768 px (R2)', () => {
  it('has a column for each fact, sorted by title, the sorted column saying so', async () => {
    const state = at('/documents');
    const t = await table();
    await waitFor(() => expect(titles(t)).toHaveLength(4));
    expect(headers(t)).toEqual([
      'Title',
      'Kind',
      'Person',
      'Issued',
      'Expires',
      'Status',
      'Who can see it',
      'Location',
      'Collections',
    ]);
    const th = (name: string) =>
      within(t)
        .getByRole('button', { name: new RegExp(`^${name}`) })
        .closest('th') as HTMLElement;
    expect(th('Title')).toHaveAttribute('aria-sort', 'ascending');
    expect(th('Issued')).not.toHaveAttribute('aria-sort');
    expect(lastQuery(state).get('sort')).toBe('title');
    expect(lastQuery(state).get('direction')).toBe('asc');
    expect(titles(t)).toEqual([
      'Barclays statement, September 2026',
      'House deed',
      "Mansoor's passport",
      "Sara's visa",
    ]);
    // What each cell says: whose, its kind, its dates, its status, who sees it,
    // where it is kept and its collections; a blank, a dash heard as none.
    const visa = within(t).getByRole('link', { name: "Sara's visa" }).closest('tr') as HTMLElement;
    // Whose, by the name the family uses for them: first names, unless two share one.
    expect(within(visa).getByText('Sara')).toBeInTheDocument();
    expect(within(visa).getByText('Passport')).toBeInTheDocument();
    expect(within(visa).getByText('1 May 2019')).toBeInTheDocument();
    expect(within(visa).getByText('Expired 1 Aug 2026')).toBeInTheDocument();
    expect(within(visa).getByText('Desk drawer')).toBeInTheDocument();
    expect(within(visa).getByText('Travel')).toBeInTheDocument();
    const deed = within(t).getByRole('link', { name: 'House deed' }).closest('tr') as HTMLElement;
    expect(within(deed).getAllByText('None').length).toBeGreaterThan(3);

    // A column's name sorts by it; again, the other way.
    fireEvent.click(within(t).getByRole('button', { name: /^Issued/ }));
    await waitFor(() => expect(th('Issued')).toHaveAttribute('aria-sort', 'ascending'));
    expect(th('Title')).not.toHaveAttribute('aria-sort');
    expect(window.location.search).toBe('?sort=issued');
    await waitFor(() => expect(lastQuery(state).get('sort')).toBe('issued'));
    await waitFor(() => expect(titles(t)[0]).toBe("Sara's visa"));
    // Blanks last.
    expect(titles(t).slice(-1)).toEqual(['House deed']);
    fireEvent.click(within(t).getByRole('button', { name: /^Issued/ }));
    await waitFor(() => expect(th('Issued')).toHaveAttribute('aria-sort', 'descending'));
    expect(window.location.search).toBe('?sort=issued&dir=desc');
    await waitFor(() => expect(titles(t)[0]).toBe('Barclays statement, September 2026'));
    expect(titles(t).slice(-1)).toEqual(['House deed']);
    expect(lastQuery(state).get('direction')).toBe('desc');
    // The table's own name says how it is sorted.
    expect(t).toHaveAccessibleName('Documents, sorted by Issued, latest first');
  });

  it('keeps its filters in the address: a link shows the same view, and Back the one before', async () => {
    const state = at(`/documents?person=m-2&status=expired`);
    const t = await table();
    await waitFor(() => expect(titles(t)).toEqual(["Sara's visa"]));
    expect(lastQuery(state).get('member_id')).toBe('m-2');
    expect(lastQuery(state).get('status')).toBe('expired');
    const filters = screen.getByRole('group', { name: 'Filters' });
    expect(within(filters).getByRole('combobox', { name: 'Person' })).toHaveValue('m-2');
    expect(within(filters).getByRole('combobox', { name: 'Status' })).toHaveValue('expired');

    // A filter more: the address says so, and a new entry in history.
    fireEvent.change(within(filters).getByRole('combobox', { name: 'Status' }), {
      target: { value: '' },
    });
    await waitFor(() => expect(window.location.search).toBe('?person=m-2'));
    fireEvent.change(within(filters).getByRole('combobox', { name: 'Collection' }), {
      target: { value: 'collection-t' },
    });
    await waitFor(() => expect(window.location.search).toBe('?person=m-2&collection=collection-t'));
    await waitFor(() => expect(lastQuery(state).get('collection_id')).toBe('collection-t'));
    await waitFor(() => expect(titles(t)).toEqual(["Sara's visa"]));
    // Back: the view before.
    act(() => window.history.back());
    await waitFor(() => expect(window.location.search).toBe('?person=m-2'));
    await waitFor(() =>
      expect(within(filters).getByRole('combobox', { name: 'Collection' })).toHaveValue(''),
    );
    // Nobody's; and in no collection.
    fireEvent.change(within(filters).getByRole('combobox', { name: 'Person' }), {
      target: { value: 'none' },
    });
    await waitFor(() => expect(titles(t)).toEqual(['House deed']));
    expect(lastQuery(state).get('member_id')).toBe('none');
    // Nothing that matches says so; Clear filters is every document again.
    fireEvent.change(within(filters).getByRole('combobox', { name: 'Kind' }), {
      target: { value: 'passport' },
    });
    await screen.findByText('Nothing matches these filters.');
    fireEvent.click(within(filters).getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(titles(t)).toHaveLength(4));
    expect(window.location.search).toBe('');
  });

  it('hides a column from the Columns menu, and remembers it on this device', async () => {
    at('/documents');
    let t = await table();
    const columns = screen.getByRole('button', { name: 'Columns' });
    expect(columns).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(columns);
    expect(columns).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('group', { name: 'Columns shown' });
    // The title is always there: not a choice.
    expect(within(menu).queryByRole('checkbox', { name: 'Title' })).not.toBeInTheDocument();
    fireEvent.click(within(menu).getByRole('checkbox', { name: 'Kind' }));
    fireEvent.click(within(menu).getByRole('checkbox', { name: 'Location' }));
    expect(headers(t)).not.toContain('Kind');
    expect(headers(t)).not.toContain('Location');
    expect(JSON.parse(localStorage.getItem(HIDDEN_COLUMNS_KEY) ?? '[]')).toEqual([
      'kind',
      'location',
    ]);
    // Escape closes it, back on its button.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Columns shown' })).not.toBeInTheDocument();
    await waitFor(() => expect(columns).toHaveFocus());

    // Another visit, on this device: as it was left.
    cleanup();
    at('/documents');
    t = await table();
    expect(headers(t)).not.toContain('Kind');
    expect(headers(t)).toContain('Person');
    // Back again.
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Kind' }));
    expect(headers(t)).toContain('Kind');

    // A browser that keeps nothing: every column, and no harm done.
    cleanup();
    // On the prototype: a Storage takes a property set on it as an item.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const { getItem, setItem } = Storage.prototype;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
      if (key === HIDDEN_COLUMNS_KEY) throw new Error('denied');
      return getItem.call(this, key);
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === HIDDEN_COLUMNS_KEY) throw new Error('denied');
      setItem.call(this, key, value);
    });
    at('/documents');
    t = await table();
    expect(headers(t)).toContain('Location');
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Person' }));
    expect(headers(t)).not.toContain('Person');
  });

  it('a viewer and a guest: no Location anywhere, no boxes and nothing to do with many', async () => {
    for (const guest of [false, true]) {
      const state = at(
        // A link that asks for it is the title's sort.
        '/documents?sort=location&dir=desc',
        {
          ...(guest ? { myKind: 'guest' as const } : {}),
          documents: [{ ...PASSPORT, physical_location: null }],
        },
        'viewer',
      );
      const t = await table();
      await waitFor(() => expect(titles(t)).toEqual(["Mansoor's passport"]));
      expect(headers(t)).not.toContain('Location');
      expect(lastQuery(state).get('sort')).toBe('title');
      expect(lastQuery(state).has('location')).toBe(false);
      expect(within(t).queryAllByRole('checkbox')).toEqual([]);
      expect(screen.getByText('Open a document to read or download it.')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
      expect(screen.queryByRole('checkbox', { name: 'Location' })).not.toBeInTheDocument();
      expect(screen.queryByRole('region', { name: /chosen documents/ })).not.toBeInTheDocument();
      cleanup();
    }
  });

  it('offers each action only where every one chosen allows it, and says why not', async () => {
    // An owner: all four, for any of theirs.
    at('/documents');
    let t = await table();
    await waitFor(() => expect(titles(t)).toHaveLength(4));
    fireEvent.click(within(t).getByRole('checkbox', { name: "Select “Mansoor's passport”" }));
    fireEvent.click(within(t).getByRole('checkbox', { name: 'Select “House deed”' }));
    let bar = screen.getByRole('region', { name: 'What to do with the chosen documents' });
    expect(within(bar).getByText('2 selected')).toBeInTheDocument();
    expect(
      within(bar)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([
      'Add to a collection',
      'Set where it’s kept',
      'Who can see it',
      'Move to Trash',
      'Clear selection',
    ]);
    // Only me is for documents that are yours: with nobody's chosen, not offered.
    fireEvent.click(within(bar).getByRole('button', { name: 'Who can see it' }));
    const sheet = screen.getByRole('dialog', { name: 'Who can see 2 documents' });
    expect(within(sheet).queryByRole('button', { name: 'Only me' })).not.toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    cleanup();

    // A teen: their own only; chosen with somebody else's, not offered, and why.
    at(
      '/documents',
      {
        documents: [
          doc({
            id: 'doc-own',
            title: 'My library card',
            owner_member_id: 'me',
            filed_by_me: true,
          }),
          doc({ id: 'doc-sara', title: "Sara's card", owner_member_id: 'm-2', filed_by_me: false }),
        ],
      },
      'teen',
    );
    t = await table();
    await waitFor(() => expect(titles(t)).toHaveLength(2));
    fireEvent.click(within(t).getByRole('checkbox', { name: 'Select “My library card”' }));
    bar = screen.getByRole('region', { name: 'What to do with the chosen documents' });
    expect(within(bar).getByRole('button', { name: 'Move to Trash' })).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'Set where it’s kept' })).toBeInTheDocument();
    fireEvent.click(within(t).getByRole('checkbox', { name: "Select “Sara's card”" }));
    expect(within(bar).queryByRole('button', { name: 'Move to Trash' })).not.toBeInTheDocument();
    expect(
      within(bar).queryByRole('button', { name: 'Set where it’s kept' }),
    ).not.toBeInTheDocument();
    expect(within(bar).queryByRole('button', { name: 'Who can see it' })).not.toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'Add to a collection' })).toBeInTheDocument();
    expect(
      within(bar).getByText(
        '1 of these isn’t yours to change: Set where it’s kept and Move to Trash are offered when every one you chose is.',
      ),
    ).toBeInTheDocument();
    expect(
      within(bar).getByText(
        'Who can see it is offered when it can be changed the same way for every one you chose.',
      ),
    ).toBeInTheDocument();
    await expectAccessible();
  });

  it('moves many to the Trash once asked, and says plainly which it could not', async () => {
    const state = at('/documents', {
      refuseWith: (method, path) =>
        method === 'DELETE' && path === '/api/v1/documents/doc-3'
          ? {
              status: 409,
              code: 'conflict',
              message: 'Someone else changed this document. Reload and try again.',
            }
          : undefined,
    });
    const t = await table();
    await waitFor(() => expect(titles(t)).toHaveLength(4));
    for (const name of ["Mansoor's passport", "Sara's visa", 'House deed']) {
      fireEvent.click(within(t).getByRole('checkbox', { name: `Select “${name}”` }));
    }
    const bar = screen.getByRole('region', { name: 'What to do with the chosen documents' });
    const trash = within(bar).getByRole('button', { name: 'Move to Trash' });
    fireEvent.click(trash);
    // Asked first, in the app's own words; Cancel is an answer.
    let ask = screen.getByRole('alertdialog', { name: 'Move 3 documents to the Trash?' });
    expect(ask).toHaveAccessibleDescription(
      'They leave every list, search and reminder. You can bring them back from the Trash.',
    );
    await waitFor(() => expect(within(ask).getByRole('button', { name: 'Cancel' })).toHaveFocus());
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(state.calls.filter((c) => c.method === 'DELETE')).toEqual([]);
    await waitFor(() => expect(trash).toHaveFocus());

    fireEvent.click(trash);
    ask = screen.getByRole('alertdialog', { name: 'Move 3 documents to the Trash?' });
    fireEvent.click(within(ask).getByRole('button', { name: 'Move to Trash' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(state.calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([
      // In the table's order: by title.
      '/api/v1/documents/doc-4',
      '/api/v1/documents/doc-1',
      '/api/v1/documents/doc-3',
    ]);
    // What it did, and what it could not, by name and in the vault's words.
    expect(
      await screen.findByText(
        '2 documents moved to the Trash. You can bring them back from there.',
      ),
    ).toBeInTheDocument();
    const failed = screen.getByRole('alert');
    expect(
      within(failed).getByText('1 of the 3 could not be moved to the Trash:'),
    ).toBeInTheDocument();
    expect(
      within(failed).getByText(
        "“Sara's visa”: Someone else changed this document. Reload and try again.",
      ),
    ).toBeInTheDocument();
    // The focus is on what happened; what failed is still chosen, the rest gone.
    await waitFor(() => expect(document.querySelector('.bulk-outcome')).toHaveFocus());
    await waitFor(() =>
      expect(titles(t)).toEqual(['Barclays statement, September 2026', "Sara's visa"]),
    );
    expect(within(t).getByRole('checkbox', { name: "Select “Sara's visa”" })).toBeChecked();
    expect(selected()).toBe('1 selected');
  });

  it('sets where many are kept, one place for all, each as it was seen', async () => {
    const state = at('/documents');
    const t = await table();
    await waitFor(() => expect(titles(t)).toHaveLength(4));
    fireEvent.click(within(t).getByRole('checkbox', { name: "Select “Mansoor's passport”" }));
    fireEvent.click(within(t).getByRole('checkbox', { name: 'Select “House deed”' }));
    const button = screen.getByRole('button', { name: 'Set where it’s kept' });
    fireEvent.click(button);
    const sheet = screen.getByRole('dialog', {
      name: 'Where the paper originals of 2 documents are kept',
    });
    const field = within(sheet).getByRole('combobox', {
      name: 'Where the paper originals are kept',
    });
    await waitFor(() => expect(field).toHaveFocus());
    fireEvent.click(within(sheet).getByRole('button', { name: 'Set for 2 documents' }));
    expect(within(sheet).getByRole('alert')).toHaveTextContent('Say where they are kept.');
    fireEvent.change(field, { target: { value: 'Fire safe' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Set for 2 documents' }));
    expect(await screen.findByText('2 documents now kept in “Fire safe”.')).toBeInTheDocument();
    const patches = state.calls.filter((c) => c.method === 'PATCH');
    expect(patches.map((c) => [c.url, c.body, c.headers?.['if-match']])).toEqual([
      ['/api/v1/documents/doc-4', { physical_location: 'Fire safe' }, '"doc-4"'],
      ['/api/v1/documents/doc-1', { physical_location: 'Fire safe' }, '"abc"'],
    ]);
    // Done with: nothing chosen any more.
    await waitFor(() => expect(screen.queryByText(/selected$/)).not.toBeInTheDocument());
  });

  it('changes who can see many once asked, and says Only me’s words once', async () => {
    const state = at('/documents', {
      documents: [
        doc({ id: 'doc-a', title: 'Gym card', owner_member_id: 'me' }),
        doc({ id: 'doc-b', title: 'Library card', owner_member_id: 'me' }),
        doc({ id: 'doc-c', title: 'Old card', owner_member_id: 'me', visibility: 'private' }),
      ],
    });
    const t = await table();
    await waitFor(() => expect(titles(t)).toHaveLength(3));
    for (const name of ['Gym card', 'Library card', 'Old card']) {
      fireEvent.click(within(t).getByRole('checkbox', { name: `Select “${name}”` }));
    }
    const bar = screen.getByRole('region', { name: 'What to do with the chosen documents' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Who can see it' }));
    const sheet = screen.getByRole('dialog', { name: 'Who can see 3 documents' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Only me' }));
    expect(
      within(sheet).getByText('Nobody else, including the owner of this vault.'),
    ).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Continue' }));
    const ask = screen.getByRole('alertdialog', { name: 'Make 2 documents Only me?' });
    expect(ask).toHaveAccessibleDescription(
      'Nobody else, including the owner of this vault. 1 is Only me already, and stays as it is.',
    );
    fireEvent.click(within(ask).getByRole('button', { name: 'Change who can see them' }));
    // The vault's words for it, once, before anything else.
    const notice = await screen.findByRole('dialog', { name: 'Only you can open this' });
    expect(
      state.calls
        .filter((c) => c.method === 'POST' && c.url.endsWith('/visibility'))
        .map((c) => c.url),
    ).toEqual(['/api/v1/documents/doc-a/visibility', '/api/v1/documents/doc-b/visibility']);
    fireEvent.click(within(notice).getByRole('button', { name: 'I understand' }));
    expect(await screen.findByText('2 documents now Only me.')).toBeInTheDocument();
  });

  it('says, before it asks, that Only me documents would be seen by more people (W7)', async () => {
    at('/documents', {
      documents: [
        doc({ id: 'doc-a', title: 'Diary', owner_member_id: 'me', visibility: 'private' }),
        doc({ id: 'doc-b', title: 'Gym card', owner_member_id: 'me' }),
      ],
    });
    const t = await table();
    await waitFor(() => expect(titles(t)).toHaveLength(2));
    for (const name of ['Diary', 'Gym card']) {
      fireEvent.click(within(t).getByRole('checkbox', { name: `Select “${name}”` }));
    }
    const bar = screen.getByRole('region', { name: 'What to do with the chosen documents' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Who can see it' }));
    const sheet = screen.getByRole('dialog', { name: 'Who can see 2 documents' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Adults only' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Continue' }));
    const ask = screen.getByRole('alertdialog', { name: 'Make 2 documents Adults only?' });
    expect(ask).toHaveAccessibleDescription(
      'The teens and viewers will not see them. 1 of these is Only me now: Adults only lets every adult see it.',
    );
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    // To Everyone, the same, in its words.
    fireEvent.click(within(bar).getByRole('button', { name: 'Who can see it' }));
    const again = screen.getByRole('dialog', { name: 'Who can see 2 documents' });
    fireEvent.click(within(again).getByRole('button', { name: 'Everyone in the family' }));
    fireEvent.click(within(again).getByRole('button', { name: 'Continue' }));
    expect(
      screen.getByRole('alertdialog', { name: 'Let everyone in the family see 1 document?' }),
    ).toHaveAccessibleDescription(
      'Anybody with a sign-in here can open them. 1 of these is Only me now: everyone in the family will see it. 1 is Everyone already, and stays as it is.',
    );
  });

  it('a run stopped short says what it did not do, and keeps those chosen (W9)', async () => {
    at('/documents', {
      stepUpNeeded: true,
      documents: [
        doc({ id: 'doc-a', title: 'Diary', owner_member_id: 'me', visibility: 'private' }),
        doc({ id: 'doc-b', title: 'Letters', owner_member_id: 'me', visibility: 'private' }),
      ],
    });
    const t = await table();
    await waitFor(() => expect(titles(t)).toHaveLength(2));
    for (const name of ['Diary', 'Letters']) {
      fireEvent.click(within(t).getByRole('checkbox', { name: `Select “${name}”` }));
    }
    const bar = screen.getByRole('region', { name: 'What to do with the chosen documents' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Who can see it' }));
    const sheet = screen.getByRole('dialog', { name: 'Who can see 2 documents' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Everyone in the family' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Continue' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: 'Change who can see them',
      }),
    );
    // Out of Only me asks who is asking; not answered.
    const prompt = await screen.findByRole('dialog', { name: 'Just checking it is you' });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Cancel' }));
    expect(
      await screen.findByText(
        'Nothing was changed: you did not confirm it is you. 2 documents are still chosen.',
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(selected()).toBe('2 selected'));
    expect(within(t).getByRole('checkbox', { name: 'Select “Diary”' })).toBeChecked();
    expect(within(t).getByRole('checkbox', { name: 'Select “Letters”' })).toBeChecked();
  });

  it('puts many into a collection at once', async () => {
    const state = at('/documents');
    const t = await table();
    await waitFor(() => expect(titles(t)).toHaveLength(4));
    fireEvent.click(within(t).getByRole('checkbox', { name: 'Select “House deed”' }));
    fireEvent.click(
      within(t).getByRole('checkbox', { name: 'Select “Barclays statement, September 2026”' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add to a collection' }));
    const sheet = await screen.findByRole('dialog', { name: 'Add 2 documents to a collection' });
    fireEvent.click(await within(sheet).findByRole('button', { name: 'Add to “Travel”' }));
    await within(sheet).findByText('2 documents added to “Travel”.');
    const put = state.calls.find((c) => c.method === 'POST' && c.url.endsWith('/items'));
    expect(put?.body).toEqual({ document_ids: ['doc-2', 'doc-4'] });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Done' }));
    expect(await screen.findByText('2 documents added to “Travel”.')).toBeInTheDocument();
  });

  it('a row is a link to its document; boxes are labelled, and the header’s chooses every row shown', async () => {
    at('/documents');
    const t = await table();
    await waitFor(() => expect(titles(t)).toHaveLength(4));
    // The keyboard's way to a document is its title, a real link.
    expect(within(t).getByRole('link', { name: "Mansoor's passport" })).toHaveAttribute(
      'href',
      '/documents/doc-1',
    );
    const all = within(t).getByRole('checkbox', { name: 'Select all 4 shown' });
    act(() => all.focus());
    fireEvent.click(all);
    expect(within(t).getAllByRole('checkbox', { checked: true })).toHaveLength(5);
    expect(selected()).toBe('4 selected');
    // How many are chosen is said as it changes (W1).
    expect(screen.getByText('4 selected', { selector: '.visually-hidden' })).toHaveAttribute(
      'role',
      'status',
    );
    // One taken out: the header's is neither, said as mixed.
    fireEvent.click(within(t).getByRole('checkbox', { name: 'Select “House deed”' }));
    expect((all as HTMLInputElement).indeterminate).toBe(true);
    expect(all).not.toBeChecked();
    fireEvent.click(all);
    expect(all).toBeChecked();
    fireEvent.click(all);
    expect(within(t).queryAllByRole('checkbox', { checked: true })).toEqual([]);
    expect(
      screen.getByText('Tick documents to do something with many at once.'),
    ).toBeInTheDocument();
    // A click on the row, not on its box, opens it.
    fireEvent.click(within(t).getByText('Desk drawer'));
    await screen.findByRole('heading', { name: "Sara's visa", level: 1 });
  });

  it('is one stop for Tab: the arrows move between its cells, and what to do with the chosen comes straight after it (W1)', async () => {
    at('/documents');
    const t = await table();
    await waitFor(() => expect(titles(t)).toHaveLength(4));
    /** What Tab can reach in the grid. */
    const stops = () =>
      [...t.querySelectorAll<HTMLElement>('[tabindex], a, button, input')].filter(
        (el) => el.tabIndex >= 0,
      );
    // One, the first row's box.
    const first = within(t).getByRole('checkbox', {
      name: 'Select “Barclays statement, September 2026”',
    });
    expect(stops()).toEqual([first]);
    act(() => first.focus());
    fireEvent.click(first);
    // Right: its title; down: the next row's title; up, and up again: the head.
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    const barclays = within(t).getByRole('link', { name: 'Barclays statement, September 2026' });
    expect(barclays).toHaveFocus();
    fireEvent.keyDown(barclays, { key: 'ArrowDown' });
    const deed = within(t).getByRole('link', { name: 'House deed' });
    expect(deed).toHaveFocus();
    // Still one stop for Tab: wherever the focus last was.
    expect(stops()).toEqual([deed]);
    fireEvent.keyDown(deed, { key: 'ArrowUp' });
    fireEvent.keyDown(barclays, { key: 'ArrowUp' });
    expect(within(t).getByRole('button', { name: /^Title/ })).toHaveFocus();
    // A cell with no control of its own takes the focus itself.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(
      within(t).getAllByText('Bank / investment statement')[0]?.closest('td'),
    );
    // Home, End; with Control, the first cell and the last.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' });
    expect(document.activeElement?.closest('td')).toBe(
      within(t).getAllByRole('row')[1]?.lastElementChild,
    );
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'End', ctrlKey: true });
    expect(document.activeElement?.closest('td')).toBe(
      within(t).getAllByRole('row').at(-1)?.lastElementChild,
    );
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home', ctrlKey: true });
    expect(document.activeElement).toBe(
      within(t).getByRole('checkbox', { name: 'Select all 4 shown' }),
    );
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'PageDown' });
    expect(document.activeElement).toBe(
      within(t).getByRole('checkbox', { name: "Select “Sara's visa”" }),
    );
    // After the grid, in the page's order, the next stop is the bar's first action.
    const bar = screen.getByRole('region', { name: 'What to do with the chosen documents' });
    const everything = [
      ...document.querySelectorAll<HTMLElement>('a, button, input, select, [tabindex]'),
    ].filter((el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled);
    const from = everything.indexOf(document.activeElement as HTMLElement);
    expect(everything[from + 1]).toBe(within(bar).getAllByRole('button')[0]);
  });

  it('shows the whole of words cut short, on hover and on focus, measured as they are then, and Escape puts them away (W11)', async () => {
    // jsdom lays nothing out: here, every cell's words are wider than it.
    const cut = (el: Element, wide: number) => ((el as HTMLElement).dataset?.clip ? wide : 0);
    vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function (this: Element) {
      return cut(this, 400);
    });
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
      return cut(this, 100);
    });
    // The kinds come after the rows.
    let types: () => void = () => undefined;
    at('/documents', {
      hold: (method, path) =>
        method === 'GET' && path === '/api/v1/document-types'
          ? new Promise<void>((go) => {
              types = go;
            })
          : undefined,
    });
    const t = await table();
    await waitFor(() => expect(titles(t)).toHaveLength(4));
    const tip = () => document.querySelector('.clip-tip');
    const place = within(t).getByText('Desk drawer');
    // No cell is a stop for Tab of its own.
    expect(place).not.toHaveAttribute('tabindex', '0');
    fireEvent.mouseOver(place);
    expect(tip()).toHaveTextContent('Desk drawer');
    // Said on the page already: not a second time to a screen reader.
    expect(tip()).toHaveAttribute('aria-hidden', 'true');
    fireEvent.mouseOut(place);
    expect(tip()).toBeNull();
    // By the arrows, the cell is focused, and its words shown.
    const box = within(t).getByRole('checkbox', { name: "Select “Sara's visa”" });
    act(() => box.focus());
    for (let i = 0; i < 8; i++) {
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowRight' });
    }
    expect(document.activeElement).toBe(place.closest('td'));
    expect(tip()).toHaveTextContent('Desk drawer');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(tip()).toBeNull();
    // The kinds arrive: the Kind cell is measured as it is now.
    act(() => types());
    await waitFor(() => expect(within(t).getAllByText('Passport').length).toBeGreaterThan(0));
    for (let i = 0; i < 6; i++) {
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowLeft' });
    }
    expect(document.activeElement?.textContent).toBe('Passport');
    expect(tip()).toHaveTextContent('Passport');
    // A title's words are its link's, which takes the focus itself.
    const link = within(t).getByRole('link', { name: 'Barclays statement, September 2026' });
    act(() => link.focus());
    expect(tip()).toHaveTextContent('Barclays statement, September 2026');
    act(() => link.blur());
    expect(tip()).toBeNull();
  });

  it('the arrows leave the scrolling to the table, which scrolls only as far as it must (F2)', async () => {
    at('/documents', {}, 'owner', MID);
    const t = await table();
    await waitFor(() => expect(titles(t)).toHaveLength(4));
    // No scroll-padding: with it, a browser scrolls a pinned cell or the head
    // "into view" as it takes the focus — back to the left, and up.
    const wrap = t.closest('.tbl-wrap') as HTMLElement;
    expect(wrap.style.scrollPaddingLeft).toBe('');
    expect(wrap.style.scrollPaddingTop).toBe('');
    // Nor its own scroll, which puts a row out of sight in the middle of the box.
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    const first = within(t).getByRole('checkbox', {
      name: 'Select “Barclays statement, September 2026”',
    });
    act(() => first.focus());
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(within(t).getByRole('checkbox', { name: 'Select “House deed”' })).toHaveFocus();
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' });
    expect(within(t).getByRole('checkbox', { name: 'Select all 4 shown' })).toHaveFocus();
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
  });

  it('a focused cell is scrolled clear of the pinned box and title (W3)', async () => {
    at('/documents', {}, 'owner', MID);
    const t = await table();
    await waitFor(() => expect(titles(t)).toHaveLength(4));
    const wrap = t.closest('.tbl-wrap') as HTMLDivElement;
    // A box 600 px wide, its left at 0, scrolled 300 px across; the box and
    // title pinned over its first 212 px; and the Kind cell, at 80-176, under them.
    let left = 300;
    Object.defineProperty(wrap, 'scrollLeft', {
      configurable: true,
      get: () => left,
      set: (v: number) => {
        left = v;
      },
    });
    Object.defineProperty(wrap, 'clientWidth', { configurable: true, get: () => 600 });
    Object.defineProperty(wrap, 'clientHeight', { configurable: true, get: () => 400 });
    const rect = (l: number, w: number, top = 60) =>
      ({ left: l, right: l + w, top, bottom: top + 40, width: w, height: 40 }) as DOMRect;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      if (this === wrap) return rect(0, 600, 0);
      if (this.matches('thead')) return rect(0, 1000, 0);
      if (this.matches('thead .col-pick')) return rect(0, 44, 0);
      if (this.matches('thead .col-title')) return rect(44, 168, 0);
      if (this.matches('td') && this.textContent === 'Passport') return rect(80, 96);
      return rect(400, 50);
    });
    const kind = within(t).getAllByText('Passport')[0]?.closest('td') as HTMLElement;
    act(() => kind.focus());
    // Scrolled back by what the pinned columns covered: 212 - 80.
    expect(left).toBe(300 - 132);
  });

  it('a click beside a row’s box is the box’s; and Back from a document finds what was chosen, and every page shown (W4)', async () => {
    const many = Array.from({ length: 130 }, (_, i) =>
      doc({
        id: `doc-${String(i).padStart(3, '0')}`,
        title: `Statement ${String(i).padStart(3, '0')}`,
      }),
    );
    at('/documents', { documents: many, collections: [] });
    const t = await table();
    await waitFor(() => expect(titles(t)).toHaveLength(100));
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(titles(t)).toHaveLength(130));
    fireEvent.click(within(t).getByRole('checkbox', { name: 'Select “Statement 120”' }));
    // A near miss on the next box: its cell, not the box.
    const cell = within(t)
      .getByRole('checkbox', { name: 'Select “Statement 121”' })
      .closest('td') as HTMLElement;
    fireEvent.click(cell);
    expect(window.location.pathname).toBe('/documents');
    // To a document, and Back.
    fireEvent.click(within(t).getByRole('link', { name: 'Statement 125' }));
    await screen.findByRole('heading', { name: 'Statement 125', level: 1 });
    act(() => window.history.back());
    const again = await table();
    await waitFor(() => expect(titles(again)).toHaveLength(130));
    expect(within(again).getByRole('checkbox', { name: 'Select “Statement 120”' })).toBeChecked();
    expect(selected()).toBe('1 selected');
  }, 60_000);

  it('a new sort or filter starts the choosing again', async () => {
    at('/documents');
    const t = await table();
    await waitFor(() => expect(titles(t)).toHaveLength(4));
    fireEvent.click(within(t).getByRole('checkbox', { name: 'Select “House deed”' }));
    expect(selected()).toBe('1 selected');
    fireEvent.click(within(t).getByRole('button', { name: /^Person/ }));
    // The rows again, in their new order: none of them chosen.
    await waitFor(() => expect(window.location.search).toBe('?sort=person'));
    await waitFor(() => expect(titles(t)).toHaveLength(4));
    expect(within(t).getByRole('checkbox', { name: 'Select “House deed”' })).not.toBeChecked();
    expect(selected()).toBeNull();
  });

  it('Clear selection and Dismiss give the focus back to the header’s box (W13)', async () => {
    at('/documents');
    const t = await table();
    await waitFor(() => expect(titles(t)).toHaveLength(4));
    const all = within(t).getByRole('checkbox', { name: 'Select all 4 shown' });
    fireEvent.click(within(t).getByRole('checkbox', { name: 'Select “House deed”' }));
    const clear = screen.getByRole('button', { name: 'Clear selection' });
    act(() => clear.focus());
    fireEvent.click(clear);
    await waitFor(() => expect(all).toHaveFocus());
    // After an action, its outcome; Dismiss, and back to the box.
    fireEvent.click(within(t).getByRole('checkbox', { name: 'Select “House deed”' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Move to Trash' }),
    );
    const dismiss = await screen.findByRole('button', { name: 'Dismiss' });
    act(() => dismiss.focus());
    fireEvent.click(dismiss);
    await waitFor(() =>
      expect(within(t).getByRole('checkbox', { name: 'Select all 3 shown' })).toHaveFocus(),
    );
  });

  it('the Columns menu shuts when the focus leaves it (W14)', async () => {
    at('/documents');
    await table();
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    const kind = screen.getByRole('checkbox', { name: 'Kind' });
    act(() => kind.focus());
    expect(screen.getByRole('group', { name: 'Columns shown' })).toBeInTheDocument();
    // Within it, it stays.
    act(() => screen.getByRole('checkbox', { name: 'Person' }).focus());
    expect(screen.getByRole('group', { name: 'Columns shown' })).toBeInTheDocument();
    act(() => screen.getByRole('combobox', { name: 'Person' }).focus());
    expect(screen.queryByRole('group', { name: 'Columns shown' })).not.toBeInTheDocument();
  });

  it('a press on a column’s name in the Columns menu shows or hides it, and the menu stays (F1)', async () => {
    at('/documents');
    const t = await table();
    await waitFor(() => expect(titles(t)).toHaveLength(4));
    const columns = screen.getByRole('button', { name: 'Columns' });
    press(columns);
    expect(columns).toHaveFocus();
    // Its name, not its box: words that cannot take the focus.
    press(within(screen.getByRole('group', { name: 'Columns shown' })).getByText('Location'));
    const menu = screen.getByRole('group', { name: 'Columns shown' });
    expect(within(menu).getByRole('checkbox', { name: 'Location' })).not.toBeChecked();
    expect(headers(t)).not.toContain('Location');
    // And from another column's box, in focus: the same.
    act(() => within(menu).getByRole('checkbox', { name: 'Kind' }).focus());
    press(within(menu).getByText('Location'));
    expect(screen.getByRole('group', { name: 'Columns shown' })).toBeInTheDocument();
    expect(headers(t)).toContain('Location');
  });

  it('is one stop for Tab still, after its last column goes, or its last row (F3)', async () => {
    at('/documents');
    const t = await table();
    await waitFor(() => expect(titles(t)).toHaveLength(4));
    // The last column's cell, then that column hidden.
    const first = within(t).getByRole('checkbox', {
      name: 'Select “Barclays statement, September 2026”',
    });
    act(() => first.focus());
    fireEvent.keyDown(first, { key: 'End' });
    const last = headers(t).at(-1) as string;
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    fireEvent.click(screen.getByRole('checkbox', { name: last }));
    expect(headers(t)).not.toContain(last);
    const deed = within(t).getByRole('checkbox', { name: 'Select “House deed”' });
    act(() => deed.focus());
    expect(gridStops(t)).toEqual([deed]);
    // The last row's box, then that row moved to the Trash; Dismiss.
    const visa = within(t).getByRole('checkbox', { name: "Select “Sara's visa”" });
    act(() => visa.focus());
    fireEvent.click(visa);
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Move to Trash' }),
    );
    const dismiss = await screen.findByRole('button', { name: 'Dismiss' });
    await waitFor(() => expect(titles(t)).toHaveLength(3));
    act(() => dismiss.focus());
    fireEvent.click(dismiss);
    const all = within(t).getByRole('checkbox', { name: 'Select all 3 shown' });
    await waitFor(() => expect(all).toHaveFocus());
    expect(gridStops(t)).toEqual([all]);
  });

  it('an empty table is still a stop for Tab; and with the last documents gone, Dismiss gives the focus to the heading (F4)', async () => {
    at('/documents', { documents: [] });
    let t = await table();
    await screen.findByText('Nothing here yet.');
    // Not the header's box, which has nothing to choose: the first sort.
    expect(within(t).getByRole('checkbox', { name: /^Select all/ })).toBeDisabled();
    expect(gridStops(t)).toEqual([within(t).getByRole('button', { name: /^Title/ })]);
    cleanup();

    at('/documents');
    t = await table();
    await waitFor(() => expect(titles(t)).toHaveLength(4));
    fireEvent.click(within(t).getByRole('checkbox', { name: 'Select all 4 shown' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Move to Trash' }),
    );
    const dismiss = await screen.findByRole('button', { name: 'Dismiss' });
    await screen.findByText('Nothing here yet.');
    act(() => dismiss.focus());
    fireEvent.click(dismiss);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Documents', level: 1 })).toHaveFocus(),
    );
  });

  it('the next person to sign in at this tab, pressing Back, finds none of the last one’s choices (F5)', async () => {
    at('/documents');
    const t = await table();
    await waitFor(() => expect(titles(t)).toHaveLength(4));
    fireEvent.click(within(t).getByRole('checkbox', { name: 'Select “House deed”' }));
    expect(selected()).toBe('1 selected');
    fireEvent.click(within(t).getByRole('link', { name: 'House deed' }));
    await screen.findByRole('heading', { name: 'House deed', level: 1 });
    // Signed out, from the document.
    fireEvent.click(screen.getByRole('button', { name: /^Your account/ }));
    const signOut = await screen.findByRole('menuitem', { name: 'Sign out' });
    await act(async () => {
      fireEvent.click(signOut);
    });
    // Sara signs in, at the same tab.
    const fake = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      String(input instanceof Request ? input.url : input).includes('/api/v1/auth/password')
        ? Promise.resolve(Response.json({ ...TOKENS, member_id: 'm-2', role: 'adult' }))
        : fake(input, init),
    );
    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: 'sara@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    // Back: the table as Sara has it, nothing of Mansoor's chosen.
    act(() => window.history.back());
    const again = await table();
    const deed = await within(again).findByRole('checkbox', { name: 'Select “House deed”' });
    expect(deed).not.toBeChecked();
    expect(selected()).toBeNull();
  });

  it('a "+1" collection names the rest: in a tip, and to a screen reader (W10)', async () => {
    at('/documents', {
      collections: [TRAVEL, { ...TRAVEL, id: 'collection-x', name: 'Tax', items: ['doc-3'] }],
    });
    const t = await table();
    await waitFor(() => expect(titles(t)).toHaveLength(4));
    const visa = within(t).getByRole('link', { name: "Sara's visa" }).closest('tr') as HTMLElement;
    const cell = within(visa).getByText('Tax').closest('td') as HTMLElement;
    // Heard whole: "Tax, Travel", never "+1".
    expect(within(cell).getByText(', Travel')).toHaveClass('visually-hidden');
    expect(within(cell).getByText('+1')).toHaveAttribute('aria-hidden', 'true');
    // Shown whole on hover, though nothing is cut.
    fireEvent.mouseOver(within(cell).getByText('+1'));
    expect(document.querySelector('.clip-tip')).toHaveTextContent('Tax, Travel');
  });

  it('a tip goes with its row, though the pointer never left it', async () => {
    at('/documents', {
      collections: [TRAVEL, { ...TRAVEL, id: 'collection-x', name: 'Tax', items: ['doc-3'] }],
    });
    const t = await table();
    await waitFor(() => expect(titles(t)).toHaveLength(4));
    const visa = within(t).getByRole('link', { name: "Sara's visa" }).closest('tr') as HTMLElement;
    fireEvent.mouseOver(within(visa).getByText('+1'));
    expect(document.querySelector('.clip-tip')).toHaveTextContent('Tax, Travel');
    // The row to the Trash, the pointer where it was: nothing says it left.
    fireEvent.click(within(visa).getByRole('checkbox', { name: "Select “Sara's visa”" }));
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Move to Trash' }),
    );
    await waitFor(() => expect(titles(t)).toHaveLength(3));
    expect(document.querySelector('.clip-tip')).toBeNull();
  });

  it('after Show more, the focus is on the first of the new rows; the button is never off to one side (W2)', async () => {
    const many = Array.from({ length: 130 }, (_, i) =>
      doc({
        id: `doc-${String(i).padStart(3, '0')}`,
        title: `Statement ${String(i).padStart(3, '0')}`,
      }),
    );
    let release: () => void = () => undefined;
    let holding = false;
    at('/documents', {
      documents: many,
      collections: [],
      hold: (method, path) =>
        holding && method === 'GET' && path === '/api/v1/documents'
          ? new Promise<void>((go) => {
              release = go;
            })
          : undefined,
    });
    const t = await table();
    await waitFor(() => expect(titles(t)).toHaveLength(100));
    const more = screen.getByRole('button', { name: 'Show more' });
    expect(t.closest('.tbl-wrap')).not.toContainElement(more);
    act(() => more.focus());
    holding = true;
    fireEvent.click(more);
    // While it is on its way the button keeps the focus: not disabled, said so.
    const loading = await screen.findByRole('button', { name: 'Loading more…' });
    expect(loading).toHaveAttribute('aria-disabled', 'true');
    expect(loading).not.toBeDisabled();
    expect(loading).toHaveFocus();
    holding = false;
    act(() => release());
    await waitFor(() => expect(titles(t)).toHaveLength(130));
    await waitFor(() =>
      expect(within(t).getByRole('link', { name: 'Statement 100' })).toHaveFocus(),
    );
  }, 60_000);

  it('shows more after the last page’s cursor, and says how many there are', async () => {
    const many = Array.from({ length: 130 }, (_, i) =>
      doc({
        id: `doc-${String(i).padStart(3, '0')}`,
        title: `Statement ${String(i).padStart(3, '0')}`,
      }),
    );
    const state = at('/documents', { documents: many, collections: [] });
    const t = await table();
    await waitFor(() => expect(titles(t)).toHaveLength(100));
    expect(screen.getByText('130 documents')).toBeInTheDocument();
    expect(screen.getByText('100 of 130 shown')).toBeInTheDocument();
    // No collections: no column and no filter for them.
    expect(headers(t)).not.toContain('Collections');
    expect(screen.queryByRole('combobox', { name: 'Collection' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(titles(t)).toHaveLength(130));
    expect(lastQuery(state).get('cursor')).toBe('100');
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  }, 60_000);

  it('says plainly when there is nothing, and when the vault cannot be reached', async () => {
    at('/documents', { documents: [] });
    const t = await table();
    expect(await within(t).findByText('Nothing here yet.')).toBeInTheDocument();
    cleanup();
    at('/documents', {
      refuseWith: (method, path) =>
        method === 'GET' && path === '/api/v1/documents'
          ? { status: 500, code: 'internal', message: 'Something went wrong in the vault.' }
          : undefined,
    });
    expect(await screen.findByText('Something went wrong in the vault.')).toBeInTheDocument();
    expect(
      within(await table()).getByText('The documents could not be loaded.'),
    ).toBeInTheDocument();
  });

  it('is the same table between 768 and 1023 px', async () => {
    at('/documents', {}, 'owner', MID);
    const t = await table();
    await waitFor(() => expect(titles(t)).toHaveLength(4));
    expect(t.querySelector('th.col-title')).not.toBeNull();
    expect(t.querySelector('th.col-pick')).not.toBeNull();
    await expectAccessible();
  });

  it('has nothing axe finds, with documents chosen and an action open', async () => {
    at('/documents');
    const t = await table();
    await waitFor(() => expect(titles(t)).toHaveLength(4));
    await expectAccessible();
    fireEvent.click(within(t).getByRole('checkbox', { name: 'Select “House deed”' }));
    await expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    await expectAccessible();
  });
});

describe('Documents on a phone (under 768 px)', () => {
  it('is today’s rows, with the filters and the sort in a sheet, and Select as today', async () => {
    const state = at('/documents', {}, 'owner', PHONE);
    await screen.findByRole('heading', { name: 'Documents', level: 1 });
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
    // Each row, with its ⋯ as everywhere.
    expect(
      await screen.findByRole('button', { name: 'Actions for “House deed”' }),
    ).toBeInTheDocument();
    expect(screen.getByText('4 documents')).toBeInTheDocument();
    const open = screen.getByRole('button', { name: 'Filters' });
    fireEvent.click(open);
    const sheet = screen.getByRole('dialog', { name: 'Filters' });
    fireEvent.change(within(sheet).getByRole('combobox', { name: 'Status' }), {
      target: { value: 'expired' },
    });
    await waitFor(() => expect(window.location.search).toBe('?status=expired'));
    await waitFor(() => expect(lastQuery(state).get('status')).toBe('expired'));
    fireEvent.change(within(sheet).getByRole('combobox', { name: 'Sort by' }), {
      target: { value: 'expires:desc' },
    });
    await waitFor(() =>
      expect(window.location.search).toBe('?sort=expires&dir=desc&status=expired'),
    );
    await expectAccessible();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Filters (1)' })).toHaveFocus());

    // Select, as today: into a collection, and nothing else.
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    expect(screen.getByRole('button', { name: 'Add to a collection' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Move to Trash' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: "Select “Sara's visa”" })).toBeInTheDocument();
  });

  it('a viewer’s sheet has no sort by where originals are kept', async () => {
    at('/documents', { documents: [{ ...PASSPORT }] }, 'viewer', PHONE);
    await screen.findByRole('button', { name: /^Mansoor's passport/ });
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    const sort = within(screen.getByRole('dialog', { name: 'Filters' })).getByRole('combobox', {
      name: 'Sort by',
    });
    const labels = within(sort)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(labels.some((l) => l?.startsWith('Location'))).toBe(false);
    expect(labels).toContain('Title, A to Z');
    // And no Select: a viewer has nothing to put anywhere.
    expect(screen.queryByRole('button', { name: 'Select' })).not.toBeInTheDocument();
  });
});
