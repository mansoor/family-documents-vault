import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { cabinetSize, type CabinetLayout, type CabinetPreview } from '@fdv/shared';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { filterSays, ticked } from './filter-testing.js';
import { App } from './App.js';
import { changeWords } from './cabinet.js';
import { issuersChanged } from './issuer-store.js';
import {
  AISHA,
  fresh,
  installFakeApi,
  ME,
  PASSPORT,
  STATEMENT,
  signedIn,
  type FakeState,
} from './test-api.js';

/**
 * My cabinet on the web (0.9.0, C1): a way to see the same documents,
 * beside the table — cabinets as cards, drawers and folders down the side,
 * a folder's papers beside them — that each person arranges for themselves.
 */

const WIDE = 1280;
function atWidth(px: number) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const min = /\(min-width:\s*(\d+)px\)/.exec(query);
      return {
        matches: Boolean(min) && px >= Number(min?.[1]),
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
  cleanup();
  Reflect.deleteProperty(window, 'matchMedia');
  vi.restoreAllMocks();
});

const thisYear = new Date().getFullYear();
const lastYear = thisYear - 1;

/** Aisha's passport, issued last year; Mansoor's this year; his statement this year too. */
const DOCS = [
  { ...PASSPORT, issued: { date: `${thisYear}-01-02`, precision: 'day' } },
  {
    ...PASSPORT,
    id: 'doc-5',
    title: "Aisha's passport",
    owner_member_id: AISHA.id,
    issued: { date: `${lastYear}-03-03`, precision: 'day' },
    etag: '"aisha"',
  },
  { ...STATEMENT, issued: { date: `${thisYear}-02-01`, precision: 'day' } },
];

const year = (y: number) => ({ dated_from: `${y}-01-01`, dated_to: `${y}-12-31` });

/** Mansoor › Identity › this year and last year (empty); Financial › this year. */
const LAYOUT: CabinetLayout = {
  levels: ['person', 'topic', 'year'],
  cabinets: [
    {
      id: 'c-me',
      name: 'Mansoor',
      hidden: false,
      drawn: { value: 'me' },
      drawers: [
        {
          id: 'd-id',
          name: 'Identity',
          hidden: false,
          folders: [
            {
              id: 'f-id-this',
              name: String(thisYear),
              hidden: false,
              filter: {
                notes: 'exclude',
                member_id: 'me',
                category: 'identity',
                ...year(thisYear),
              },
            },
            {
              id: 'f-id-last',
              name: String(lastYear),
              hidden: false,
              filter: {
                notes: 'exclude',
                member_id: 'me',
                category: 'identity',
                ...year(lastYear),
              },
            },
          ],
        },
        {
          id: 'd-fin',
          name: 'Financial',
          hidden: false,
          folders: [
            {
              id: 'f-fin',
              name: String(thisYear),
              hidden: false,
              filter: {
                notes: 'exclude',
                member_id: 'me',
                category: 'financial',
                ...year(thisYear),
              },
            },
          ],
        },
      ],
    },
    {
      id: 'c-aisha',
      name: 'Aisha',
      hidden: false,
      drawn: { value: AISHA.id },
      drawers: [
        {
          id: 'd-aisha-id',
          name: 'Identity',
          hidden: false,
          folders: [
            {
              id: 'f-aisha',
              name: String(lastYear),
              hidden: false,
              filter: {
                notes: 'exclude',
                member_id: AISHA.id,
                category: 'identity',
                ...year(lastYear),
              },
            },
          ],
        },
      ],
    },
  ],
};

const PREVIEW: CabinetPreview = {
  layout: LAYOUT,
  counts: { 'f-id-this': 1, 'f-id-last': 0, 'f-fin': 1, 'f-aisha': 1 },
  documents: 4,
  left_out: 1,
  size: cabinetSize(LAYOUT),
};

function at(path: string, over: Partial<FakeState> = {}): FakeState {
  atWidth(WIDE);
  const state = fresh({
    members: [ME, AISHA],
    documents: DOCS.map((d) => ({ ...d })),
    cabinets: true,
    ...over,
  });
  installFakeApi(state);
  signedIn('owner');
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } },
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

const toggle = () => screen.findByRole('group', { name: 'Show documents as' });

describe('Table or Cabinet', () => {
  it('offers the cabinet beside the table, and goes there and back', async () => {
    at('/documents');
    const group = await toggle();
    expect(within(group).getByRole('button', { name: 'Table' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(within(group).getByRole('button', { name: 'Cabinet' }));
    expect(await screen.findByRole('heading', { name: 'Your cabinet is empty' })).toBeVisible();
    expect(window.location.search).toBe('?show=cabinet');
    expect(within(await toggle()).getByRole('button', { name: 'Cabinet' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(within(await toggle()).getByRole('button', { name: 'Table' }));
    expect(await screen.findByRole('grid', { name: /^Documents, sorted by/ })).toBeVisible();
  });

  it('is not offered by a vault that has no cabinets', async () => {
    at('/documents?show=cabinet', { cabinets: false });
    expect(await screen.findByRole('grid', { name: /^Documents, sorted by/ })).toBeVisible();
    expect(screen.queryByRole('group', { name: 'Show documents as' })).toBeNull();
  });
});

describe('browsing my cabinet', () => {
  it('shows cabinets as cards, drawers with their folders, and a folder’s papers', async () => {
    const state = at('/documents?show=cabinet', {
      cabinet: { layout: LAYOUT, version: 3, updated_at: new Date().toISOString() },
    });
    const cards = await screen.findByRole('list', { name: 'Your cabinets' });
    // Aisha's one drawer is passed over: her card says how many folders it opens on.
    expect(
      within(cards)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Mansoor2 drawers', 'Aisha1 folder']);
    expect(screen.getByText(/Arranged by Person › Topic › Year/)).toBeVisible();
    expect(screen.getByText(/Only you see this arrangement/)).toBeVisible();
    const tree = screen.getByRole('navigation', { name: 'Drawers and folders in Mansoor' });
    // The first drawer open.
    expect(within(tree).getByRole('button', { name: /^Identity/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    // Financial holds one folder: one row that opens it, no drawer to open first.
    const fin = await within(tree).findByRole('button', {
      name: new RegExp(`^${thisYear}, in the Financial drawer, ?1 document$`),
    });
    expect(fin).not.toHaveAttribute('aria-expanded');
    // Each folder says how many it holds, to a screen reader too.
    const thisOne = await within(tree).findByRole('button', {
      name: new RegExp(`^${thisYear}, ?1 document$`),
    });
    expect(
      within(tree).getByRole('button', { name: new RegExp(`^${lastYear}, ?0 documents$`) }),
    ).toBeVisible();
    fireEvent.click(thisOne);
    await waitFor(() => expect(window.location.search).toContain('folder=f-id-this'));
    const pane = await screen.findByRole('region', { name: String(thisYear) });
    expect(within(pane).getByText(`Mansoor › Identity › ${thisYear}`)).toBeVisible();
    expect(await within(pane).findByText("Mansoor's passport")).toBeVisible();
    expect(within(pane).queryByText("Aisha's passport")).toBeNull();
    expect(within(pane).getByText(/Fills itself: Identity papers dated/)).toBeVisible();
    // Open in the table carries the folder's question.
    const open = within(pane).getByRole('link', { name: 'Open in the table' });
    const href = new URL(open.getAttribute('href') ?? '', 'http://x');
    expect(Object.fromEntries(href.searchParams)).toEqual({
      person: 'me',
      category: 'identity',
      dated_from: `${thisYear}-01-01`,
      dated_to: `${thisYear}-12-31`,
    });
    // The folder's papers are the vault's answer for it: a folder of one
    // year is one plain list, never a lone divider of its own year.
    expect(
      state.calls.some(
        (c) =>
          c.method === 'GET' &&
          c.url === '/api/v1/cabinet/folders/f-id-this/documents?divider=all&limit=50',
      ),
    ).toBe(true);
    expect(within(pane).queryByRole('button', { name: new RegExp(`^${thisYear}`) })).toBeNull();
    await expectAccessible();
  });

  it('offers Print in a paper’s ⋯, as the table does; Escape gives the focus back to the ⋯ (0.9.0-dev.102)', async () => {
    at('/documents?show=cabinet&folder=f-id-this', {
      cabinet: { layout: LAYOUT, version: 1, updated_at: new Date().toISOString() },
    });
    const pane = await screen.findByRole('region', { name: String(thisYear) });
    const name = "Actions for “Mansoor's passport”";
    const more = await within(pane).findByRole('button', { name });
    more.focus();
    fireEvent.click(more);
    const menu = await screen.findByRole('menu', { name });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent)
        .slice(0, 3),
    ).toEqual(['Open', 'Download', 'Print']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Print' }));
    const dialog = await screen.findByRole('dialog', { name: "Print “Mansoor's passport”" });
    fireEvent.keyDown(within(dialog).getByRole('checkbox', { name: 'Its pages' }), {
      key: 'Escape',
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Print/ })).toBeNull());
    await waitFor(() => expect(more).toHaveFocus());
  });

  it('says plainly when a folder holds nothing', async () => {
    at('/documents?show=cabinet&folder=f-id-last', {
      cabinet: { layout: LAYOUT, version: 1, updated_at: new Date().toISOString() },
    });
    expect(
      await screen.findByText(
        'Nothing in this folder yet. Papers that fit will appear here by themselves.',
      ),
    ).toBeVisible();
  });

  it('opens the cabinet a folder is in, from its address', async () => {
    at('/documents?show=cabinet&folder=f-aisha', {
      cabinet: { layout: LAYOUT, version: 1, updated_at: new Date().toISOString() },
    });
    expect(await screen.findByRole('button', { name: /^Aisha/, pressed: true })).toBeVisible();
    expect(await screen.findByText("Aisha's passport")).toBeVisible();
  });

  it('carries a folder into the table, each part of it taken off by itself', async () => {
    at(`/documents?category=identity&dated_from=${thisYear}-01-01&dated_to=${thisYear}-12-31`);
    const grid = await screen.findByRole('grid', { name: /^Documents, sorted by/ });
    // Its row, not the loading one: a busy machine draws that first.
    expect(await within(grid).findByText("Mansoor's passport")).toBeVisible();
    expect(within(grid).getAllByRole('row')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: `Take off the filter Dated ${thisYear}` }));
    await waitFor(() => expect(within(grid).getAllByRole('row')).toHaveLength(3));
    expect(screen.getByText('Topic: Identity')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Take off the filter Topic: Identity' }));
    await waitFor(() => expect(window.location.search).toBe(''));
  });
});

describe('levels with one group, passed over while browsing', () => {
  const folder = (id: string, name: string, filter: Record<string, string>) => ({
    id,
    name,
    hidden: false,
    filter: { notes: 'exclude', ...filter },
  });
  /**
   * By topic, then year, then person. Identity: this year for Mansoor and
   * Aisha, last year for Aisha alone. Financial: one drawer, this year, one
   * folder, Mansoor's.
   */
  const SKIPPED: CabinetLayout = {
    levels: ['topic', 'year', 'person'],
    cabinets: [
      {
        id: 'c-id',
        name: 'Identity',
        hidden: false,
        drawn: { value: 'identity' },
        drawers: [
          {
            id: 'd-this',
            name: String(thisYear),
            hidden: false,
            folders: [
              folder('f-this-me', 'Mansoor', {
                category: 'identity',
                member_id: 'me',
                ...year(thisYear),
              }),
              folder('f-this-aisha', 'Aisha', {
                category: 'identity',
                member_id: AISHA.id,
                ...year(thisYear),
              }),
            ],
          },
          {
            id: 'd-last',
            name: String(lastYear),
            hidden: false,
            folders: [
              folder('f-last-aisha', 'Aisha', {
                category: 'identity',
                member_id: AISHA.id,
                ...year(lastYear),
              }),
            ],
          },
        ],
      },
      {
        id: 'c-fin',
        name: 'Financial',
        hidden: false,
        drawn: { value: 'financial' },
        drawers: [
          {
            id: 'd-fin',
            name: String(thisYear),
            hidden: false,
            folders: [
              folder('f-fin-me', 'Mansoor', {
                category: 'financial',
                member_id: 'me',
                ...year(thisYear),
              }),
            ],
          },
        ],
      },
      {
        id: 'c-med',
        name: 'Medical',
        hidden: false,
        drawn: { value: 'medical' },
        drawers: [
          {
            id: 'd-med-last',
            name: String(lastYear),
            hidden: false,
            folders: [
              folder('f-med-last', 'Aisha', {
                category: 'medical',
                member_id: AISHA.id,
                ...year(lastYear),
              }),
            ],
          },
          {
            id: 'd-med-this',
            name: String(thisYear),
            hidden: false,
            folders: [
              folder('f-med-me', 'Mansoor', {
                category: 'medical',
                member_id: 'me',
                ...year(thisYear),
              }),
              folder('f-med-aisha', 'Aisha', {
                category: 'medical',
                member_id: AISHA.id,
                ...year(thisYear),
              }),
            ],
          },
        ],
      },
    ],
  };
  const open = (path: string) =>
    at(path, { cabinet: { layout: SKIPPED, version: 4, updated_at: new Date().toISOString() } });

  it('shows a drawer with one folder as one row that opens it, its path still naming the drawer, and Back goes where it was', async () => {
    const state = open('/documents?show=cabinet');
    const tree = await screen.findByRole('navigation', { name: 'Drawers and folders in Identity' });
    // The drawer of two folders opens and closes as before.
    expect(
      within(tree).getByRole('button', { name: new RegExp(`^${thisYear} ?2 folders$`) }),
    ).toHaveAttribute('aria-expanded', 'true');
    // Last year holds Aisha's folder alone: one row, no drawer to open first.
    const row = await within(tree).findByRole('button', {
      name: new RegExp(`^Aisha, in the ${lastYear} drawer, ?1 document$`),
    });
    expect(row).not.toHaveAttribute('aria-expanded');
    fireEvent.click(row);
    await waitFor(() => expect(window.location.search).toContain('folder=f-last-aisha'));
    expect(row).toHaveAttribute('aria-current', 'true');
    const pane = await screen.findByRole('region', { name: 'Aisha' });
    expect(within(pane).getByText(`Identity › ${lastYear} › Aisha`)).toBeVisible();
    expect(await within(pane).findByText("Aisha's passport")).toBeVisible();
    // A folder of one year is one list: no lone divider of its year to open.
    expect(within(pane).queryByRole('button', { name: new RegExp(`^${lastYear}`) })).toBeNull();
    expect(state.calls.some((c) => c.url.includes('/f-last-aisha/documents?divider=all'))).toBe(
      true,
    );
    // The layout is kept whole: nothing was saved to pass the drawer over.
    expect(state.calls.some((c) => c.method === 'PUT')).toBe(false);
    await expectAccessible();
    // Back: the cabinet as it was, no folder chosen; never somewhere new.
    act(() => window.history.back());
    await waitFor(() => expect(window.location.search).toBe('?show=cabinet'));
    expect(await screen.findByText('Choose a folder to see what is in it.')).toBeVisible();
  });

  it('opens a cabinet with one drawer straight on its folders, saying which drawer they are in', async () => {
    open('/documents?show=cabinet&cabinet=c-id');
    const cards = await screen.findByRole('list', { name: 'Your cabinets' });
    expect(
      within(cards)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Identity2 drawers', 'Financial1 folder', 'Medical2 drawers']);
    fireEvent.click(within(cards).getByRole('button', { name: /^Financial/ }));
    const tree = await screen.findByRole('navigation', {
      name: 'Drawers and folders in Financial',
    });
    expect(within(tree).getByText(`In the ${thisYear} drawer.`)).toBeVisible();
    // No drawer to open: its folders are there straight away.
    expect(
      within(tree)
        .getAllByRole('button')
        .filter((b) => b.hasAttribute('aria-expanded')),
    ).toEqual([]);
    fireEvent.click(within(tree).getByRole('button', { name: /^Mansoor, ?1 document$/ }));
    await waitFor(() => expect(window.location.search).toContain('folder=f-fin-me'));
    const pane = await screen.findByRole('region', { name: 'Mansoor' });
    expect(within(pane).getByText(`Financial › ${thisYear} › Mansoor`)).toBeVisible();
    expect(await within(pane).findByText('Barclays statement, September 2026')).toBeVisible();
    await expectAccessible();
    // Back: the Financial cabinet, its folders still there.
    act(() => window.history.back());
    await waitFor(() => expect(window.location.search).toBe('?show=cabinet&cabinet=c-fin'));
    expect(
      await screen.findByRole('navigation', { name: 'Drawers and folders in Financial' }),
    ).toBeVisible();
    expect(screen.getByText('Choose a folder to see what is in it.')).toBeVisible();
  });

  it('opens the first drawer of folders in each cabinet chosen, whatever was open in the one before', async () => {
    open('/documents?show=cabinet');
    const cards = await screen.findByRole('list', { name: 'Your cabinets' });
    const drawer = (tree: HTMLElement, y: number) =>
      within(tree).getByRole('button', { name: new RegExp(`^${y} ?2 folders$`) });
    let tree = await screen.findByRole('navigation', { name: 'Drawers and folders in Identity' });
    expect(drawer(tree, thisYear)).toHaveAttribute('aria-expanded', 'true');
    // Medical: its first drawer is one folder's row; the next, of two, opens.
    fireEvent.click(within(cards).getByRole('button', { name: /^Medical/ }));
    tree = await screen.findByRole('navigation', { name: 'Drawers and folders in Medical' });
    expect(drawer(tree, thisYear)).toHaveAttribute('aria-expanded', 'true');
    expect(
      within(tree).getByRole('button', { name: new RegExp(`^Aisha, in the ${lastYear} drawer`) }),
    ).not.toHaveAttribute('aria-expanded');
    // Closed here, then a cabinet of one drawer, then Identity again: its first opens anew.
    fireEvent.click(drawer(tree, thisYear));
    expect(drawer(tree, thisYear)).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(within(cards).getByRole('button', { name: /^Financial/ }));
    expect(
      await screen.findByRole('navigation', { name: 'Drawers and folders in Financial' }),
    ).toBeVisible();
    fireEvent.click(within(cards).getByRole('button', { name: /^Identity/ }));
    tree = await screen.findByRole('navigation', { name: 'Drawers and folders in Identity' });
    expect(drawer(tree, thisYear)).toHaveAttribute('aria-expanded', 'true');
    await expectAccessible();
  });

  it('keeps every drawer while arranging: passing over is only for browsing', async () => {
    open('/documents?show=cabinet&arrange=1');
    expect(
      await screen.findByRole('textbox', { name: `Name of the drawer ${thisYear} in Financial` }),
    ).toBeVisible();
    expect(
      screen.getByRole('textbox', { name: `Name of the drawer ${lastYear} in Identity` }),
    ).toBeVisible();
  });
});

describe('what the cabinet holds in all (19 Nov 2026)', () => {
  /** Identity for everyone; Mansoor's financial; his passport pinned there too; a scan with no topic. */
  const HELD: CabinetLayout = {
    levels: ['topic', 'year', 'person'],
    cabinets: [
      {
        id: 'c',
        name: 'Papers',
        hidden: false,
        drawn: { value: 'c' },
        drawers: [
          {
            id: 'd',
            name: 'Drawer',
            hidden: false,
            folders: [
              { id: 'f-a', name: 'Identity', hidden: false, filter: { category: 'identity' } },
              {
                id: 'f-b',
                name: 'My money',
                hidden: false,
                filter: { member_id: 'me', category: 'financial' },
              },
            ],
          },
        ],
      },
    ],
  };
  const SCAN = {
    ...PASSPORT,
    id: 'doc-scan',
    title: 'A scan to sort',
    type_key: null,
    category: null,
    etag: '"scan"',
  };

  it('says how many documents it holds, as the table does; which are in no folder; which in several', async () => {
    at('/documents?show=cabinet', {
      documents: [...DOCS, SCAN].map((d) => ({ ...d })),
      cabinet: { layout: HELD, version: 1, updated_at: new Date().toISOString() },
      cabinetPins: [{ folder_id: 'f-b', document_id: PASSPORT.id }],
    });
    // Each paper once: four, though the folders hold three and two.
    expect(await screen.findByText(/^· 4 documents$/)).toBeVisible();
    const tree = screen.getByRole('navigation', { name: 'Drawers and folders in Papers' });
    expect(
      await within(tree).findByRole('button', { name: /^Identity, ?2 documents$/ }),
    ).toBeVisible();
    expect(within(tree).getByRole('button', { name: /^My money, ?2 documents$/ })).toBeVisible();
    expect(
      screen.getByText(
        '1 is in more than one folder, so the folders add up to more than 4 documents.',
        {
          exact: false,
        },
      ),
    ).toBeVisible();
    // Those in no folder, listed.
    fireEvent.click(screen.getByRole('link', { name: '1 isn’t in any folder' }));
    await waitFor(() => expect(window.location.search).toContain('unfiled=1'));
    const pane = await screen.findByRole('region', { name: 'Not in any folder' });
    expect(await within(pane).findByText('A scan to sort')).toBeVisible();
    expect(within(pane).queryByText("Mansoor's passport")).toBeNull();
    await expectAccessible();
    // The table says the same total.
    fireEvent.click(within(await toggle()).getByRole('button', { name: 'Table' }));
    expect(await screen.findByText('4 documents')).toBeVisible();
  });
});

describe('arranging my cabinet', () => {
  it('draws it, lets each part be renamed, hidden, moved and merged, and saves it', async () => {
    const state = at('/documents?show=cabinet', { cabinetPreview: () => PREVIEW });
    fireEvent.click(await screen.findByRole('button', { name: 'Arrange my cabinet' }));
    const by = await screen.findByRole('group', { name: 'Start from' });
    expect(within(by).getAllByRole('button')).toHaveLength(3);
    expect(within(by).getByRole('button', { name: 'Person › Topic › Year' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(state.cabinetPreviewAsks?.[0]?.levels).toEqual(['person', 'topic', 'year']);
    expect(await screen.findByText(/4 documents in 4 folders/)).toBeVisible();
    expect(screen.getByText(/1 document has no topic or kind yet/)).toBeVisible();
    // Renamed.
    const name = screen.getByRole('textbox', { name: 'Name of the cabinet Mansoor' });
    fireEvent.change(name, { target: { value: 'Mine' } });
    // Hidden.
    const aisha = screen
      .getAllByRole('textbox', { name: 'Name of the cabinet Aisha' })[0]
      ?.closest('.arrange-row') as HTMLElement;
    fireEvent.click(within(aisha).getByRole('checkbox', { name: 'Show' }));
    expect(await screen.findByText('Aisha is hidden.')).toBeInTheDocument();
    // Moved, the focus kept on what moved.
    const moveDown = screen.getByRole('button', { name: 'Move Identity in Mine down' });
    fireEvent.click(moveDown);
    expect(await screen.findByText('Identity moved down.')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Move Identity in Mine up' })).toHaveFocus(),
    );
    // Two years of one drawer merged into one folder.
    fireEvent.click(
      screen.getByRole('button', {
        name: `Merge ${lastYear} in Mine › Identity into ${thisYear}`,
      }),
    );
    expect(await screen.findByText(`${lastYear} merged into ${thisYear}.`)).toBeInTheDocument();
    // Two drawers as one: Identity's folder joins Financial's.
    fireEvent.click(screen.getByRole('button', { name: 'Merge Identity in Mine into Financial' }));
    expect(await screen.findByText('Identity merged into Financial.')).toBeInTheDocument();
    // Two folders that ask different things cannot be one: said, nothing changed.
    fireEvent.click(
      screen.getByRole('button', {
        name: `Merge ${thisYear} and ${lastYear} in Mine › Financial into ${thisYear}`,
      }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot be one folder/);

    fireEvent.click(screen.getByRole('button', { name: 'Use this arrangement' }));
    await waitFor(() => expect(state.cabinetSaves).toHaveLength(1));
    const sent = state.cabinetSaves?.[0];
    expect(sent?.version).toBe(0);
    const [mine, theirs] = sent?.layout.cabinets ?? [];
    expect(mine?.name).toBe('Mine');
    expect(theirs?.hidden).toBe(true);
    // One drawer now, Financial, holding Identity's two years as one folder.
    expect(mine?.drawers.map((d) => d.name)).toEqual(['Financial']);
    expect(mine?.drawers[0]?.folders.map((f) => [f.name, f.filter])).toEqual([
      [
        String(thisYear),
        { notes: 'exclude', member_id: 'me', category: 'financial', ...year(thisYear) },
      ],
      [
        `${thisYear} and ${lastYear}`,
        {
          notes: 'exclude',
          member_id: 'me',
          category: 'identity',
          dated_from: `${lastYear}-01-01`,
          dated_to: `${thisYear}-12-31`,
        },
      ],
    ]);
    // Back to browsing, the hidden cabinet not among the cards; its one
    // drawer passed over, the card says how many folders it opens on.
    const cards = await screen.findByRole('list', { name: 'Your cabinets' });
    expect(
      within(cards)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Mine2 folders']);
  });

  it('refuses to lay a save over one made elsewhere, and keeps the arrangement', async () => {
    const state = at('/documents?show=cabinet&arrange=1', {
      cabinet: { layout: LAYOUT, version: 2, updated_at: new Date().toISOString() },
    });
    expect(await screen.findByRole('list', { name: 'Levels, in order' })).toBeVisible();
    // Saved in another window meanwhile.
    state.cabinet = { layout: LAYOUT, version: 3, updated_at: new Date().toISOString() };
    fireEvent.change(screen.getByRole('textbox', { name: 'Name of the cabinet Aisha' }), {
      target: { value: 'Aisha K' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use this arrangement' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/changed somewhere else/);
    expect(state.cabinet.version).toBe(3);
    // Used again: now made to the version read since.
    fireEvent.click(screen.getByRole('button', { name: 'Use this arrangement' }));
    await waitFor(() => expect(state.cabinet?.version).toBe(4));
    expect(state.cabinet?.layout?.cabinets[1]?.name).toBe('Aisha K');
  });

  it('keeps Cancel and Use this arrangement in a bar at the foot, last in the page, each working', async () => {
    const state = at('/documents?show=cabinet&arrange=1', {
      cabinet: { layout: LAYOUT, version: 2, updated_at: new Date().toISOString() },
    });
    const bar = await screen.findByRole('region', { name: 'Save or cancel this arrangement' });
    expect(bar).toHaveClass('arrange-bar');
    const arrange = screen.getByRole('heading', { name: 'Arrange my cabinet' }).closest('section');
    // After the drawing, so Tab reaches it last; the only Use this arrangement there is.
    expect(arrange?.lastElementChild).toBe(bar);
    expect(
      screen
        .getByRole('region', { name: 'Your cabinet will look like this' })
        .compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Use this arrangement' })).toHaveLength(1);
    expect(within(bar).getByRole('button', { name: 'Cancel' })).toBeVisible();
    // Use this arrangement, from the bar: saved.
    fireEvent.change(screen.getByRole('textbox', { name: 'Name of the cabinet Aisha' }), {
      target: { value: 'Aisha K' },
    });
    fireEvent.click(within(bar).getByRole('button', { name: 'Use this arrangement' }));
    await waitFor(() => expect(state.cabinetSaves).toHaveLength(1));
    expect(state.cabinetSaves?.[0]?.layout.cabinets[1]?.name).toBe('Aisha K');
    expect(await screen.findByRole('list', { name: 'Your cabinets' })).toBeVisible();
    // Cancel, from the bar: back to the cabinet, nothing more saved. Arrange
    // my cabinet is in Cabinet's ▾ beside Table.
    fireEvent.click(screen.getByRole('button', { name: 'More for the cabinet' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Arrange my cabinet' }));
    const again = await screen.findByRole('region', { name: 'Save or cancel this arrangement' });
    fireEvent.click(within(again).getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('list', { name: 'Your cabinets' })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Save or cancel this arrangement' })).toBeNull();
    expect(state.cabinetSaves).toHaveLength(1);
  });

  it('keeps the bar’s height on the screen as it changes, so a part tabbed to stops above it', async () => {
    const watchers: Array<() => void> = [];
    class Watch {
      constructor(cb: ResizeObserverCallback) {
        watchers.push(() => cb([], this));
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', Watch);
    let height = 72;
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        return { height: this.classList.contains('arrange-bar') ? height : 0 } as DOMRect;
      });
    try {
      at('/documents?show=cabinet&arrange=1', {
        cabinet: { layout: LAYOUT, version: 2, updated_at: new Date().toISOString() },
      });
      const bar = await screen.findByRole('region', { name: 'Save or cancel this arrangement' });
      const arrange = bar.closest('section') as HTMLElement;
      await waitFor(() => expect(arrange.style.getPropertyValue('--arrange-bar-h')).toBe('72px'));
      // Taller: a refusal said in it, or its buttons on two rows.
      height = 131.4;
      act(() => {
        for (const w of watchers) w();
      });
      expect(arrange.style.getPropertyValue('--arrange-bar-h')).toBe('132px');
    } finally {
      rect.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('says a refused save in the bar, beside its buttons', async () => {
    const state = at('/documents?show=cabinet&arrange=1', {
      cabinet: { layout: LAYOUT, version: 2, updated_at: new Date().toISOString() },
    });
    const bar = await screen.findByRole('region', { name: 'Save or cancel this arrangement' });
    state.cabinet = { layout: LAYOUT, version: 3, updated_at: new Date().toISOString() };
    fireEvent.click(within(bar).getByRole('button', { name: 'Use this arrangement' }));
    expect(await within(bar).findByRole('alert')).toHaveTextContent(/changed somewhere else/);
  });

  it('reads a layout with no levels as no arrangement yet: the first drawing, nothing of it kept', async () => {
    const state = at('/documents?show=cabinet', {
      cabinet: {
        layout: { ...LAYOUT, levels: null },
        version: 4,
        updated_at: new Date().toISOString(),
      },
      cabinetPreview: () => PREVIEW,
    });
    expect(await screen.findByRole('heading', { name: 'Your cabinet is empty' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Arrange my cabinet' }));
    await waitFor(() => expect(state.cabinetPreviewAsks).toHaveLength(1));
    expect(state.cabinetPreviewAsks?.[0]?.layout).toBeUndefined();
    expect(await screen.findByText(/4 documents in 4 folders/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Use this arrangement' }));
    await waitFor(() => expect(state.cabinetSaves).toHaveLength(1));
    // Made over the version there, every cabinet drawn.
    expect(state.cabinetSaves?.[0]?.version).toBe(4);
    expect(state.cabinetSaves?.[0]?.layout.cabinets.every((c) => c.drawn)).toBe(true);
  });

  it('is accessible while arranging', async () => {
    at('/documents?show=cabinet&arrange=1', { cabinetPreview: () => PREVIEW });
    expect(await screen.findByText(/4 documents in 4 folders/)).toBeVisible();
    await expectAccessible();
  });
});

describe('a folder in the table, whole (the review)', () => {
  /** A merged folder (two people, two kinds) and one of two statuses. */
  const MERGED: CabinetLayout = {
    levels: ['topic', 'year', 'person'],
    cabinets: [
      {
        id: 'c',
        name: 'Family',
        hidden: false,
        drawn: { value: 'c' },
        drawers: [
          {
            id: 'd',
            name: 'Papers',
            hidden: false,
            folders: [
              {
                id: 'merged',
                name: 'Both of us',
                hidden: false,
                filter: {
                  notes: 'exclude',
                  member_id: `me,${AISHA.id}`,
                  type_key: 'passport,bank_statement',
                },
              },
              {
                id: 'statuses',
                name: 'To look at',
                hidden: false,
                filter: { notes: 'exclude', status: 'valid,expired' },
              },
            ],
          },
        ],
      },
    ],
  };

  for (const [folder, want] of [
    ['merged', 3],
    ['statuses', 1],
  ] as const) {
    it(`opens ${folder === 'merged' ? 'a merged folder' : 'a folder of several statuses'} with the folder’s own count`, async () => {
      at(`/documents?show=cabinet&folder=${folder}`, {
        cabinet: { layout: MERGED, version: 1, updated_at: new Date().toISOString() },
      });
      const pane = await screen.findByRole('region', {
        name: folder === 'merged' ? 'Both of us' : 'To look at',
      });
      expect(await within(pane).findByText(new RegExp(`${want} documents?\\.$`))).toBeVisible();
      const tree = screen.getByRole('navigation', { name: 'Drawers and folders in Family' });
      expect(
        within(tree).getByRole('button', { name: new RegExp(`, ?${want} documents?$`) }),
      ).toHaveAttribute('aria-current', 'true');
      fireEvent.click(within(pane).getByRole('link', { name: 'Open in the table' }));
      expect(
        await screen.findByText(`${want} document${want === 1 ? '' : 's'} match these filters`),
      ).toBeVisible();
      // Its choices the table's own (0.9.0-dev.92): ticked, and a chip each,
      // named in words, never by an id or a key.
      const filters = screen.getByRole('group', { name: 'Filters' });
      const chips = screen.getByRole('group', { name: 'Filters chosen' });
      if (folder === 'merged') {
        expect(ticked(filters, 'Person')).toEqual(['Mansoor Seikh', 'Aisha']);
        expect(within(chips).getByText('Person: Aisha')).toBeVisible();
        expect(ticked(filters, 'Kind')).toHaveLength(2);
        expect(chips.textContent).not.toMatch(/passport|bank_statement/);
        // One of them taken off: the other kept.
        fireEvent.click(
          within(chips).getByRole('button', { name: 'Take off the filter Person: Aisha' }),
        );
        await waitFor(() =>
          expect(new URLSearchParams(window.location.search).getAll('person')).toEqual(['me']),
        );
      } else {
        expect(ticked(filters, 'Status')).toHaveLength(2);
        expect(filterSays(filters, 'Status')).toBe('Status · 2');
      }
    });
  }

  it('says when a folder asks for more than the table can show', async () => {
    at('/documents?category=identity&partial=1');
    expect(
      await screen.findByText(
        'This folder asks for more than the table can show; its count may differ.',
      ),
    ).toBeVisible();
  });

  it('on a phone, shows each of a folder’s filters, each taken off by itself', async () => {
    atWidth(375);
    const state = fresh({
      members: [ME, AISHA],
      documents: DOCS.map((d) => ({ ...d })),
      cabinets: true,
    });
    installFakeApi(state);
    signedIn('owner');
    window.history.replaceState(
      {},
      '',
      `/documents?category=identity&dated_from=${thisYear}-01-01&dated_to=${thisYear}-12-31`,
    );
    render(<App />);
    const chips = await screen.findByRole('group', { name: 'Filters chosen' });
    expect(within(chips).getByText('Topic: Identity')).toBeVisible();
    expect(within(chips).getByText(`Dated ${thisYear}`)).toBeVisible();
    fireEvent.click(
      within(chips).getByRole('button', { name: 'Take off the filter Topic: Identity' }),
    );
    await waitFor(() => expect(window.location.search).not.toContain('category'));
    expect(window.location.search).toContain('dated_from');
  });
  it('carries a folder of an issuer into the table by the household’s name, the same issuer’s papers in it', async () => {
    const state = fresh({
      members: [ME, AISHA],
      documents: [
        { ...STATEMENT, id: 'doc-b1', etag: '"b1"', issued_by: 'Barclays' },
        {
          ...STATEMENT,
          id: 'doc-b2',
          etag: '"b2"',
          title: 'Barclays Bank UK letter',
          issued_by: 'BARCLAYS BANK UK PLC',
        },
        { ...STATEMENT, id: 'doc-h', etag: '"h"', title: 'HSBC letter', issued_by: 'HSBC' },
      ],
      cabinets: true,
      issuerAliases: [{ from: 'barclays bank uk', to: 'barclays', path: [] }],
    });
    installFakeApi(state);
    signedIn('owner');
    window.history.replaceState({}, '', '/documents?issuer=barclays');
    render(<App />);
    const chips = await screen.findByRole('group', { name: 'Filters chosen' });
    expect(await within(chips).findByText('From Barclays')).toBeVisible();
    expect(await screen.findByText('2 documents match these filters')).toBeVisible();
    expect(screen.queryByText('HSBC letter')).toBeNull();
    // The household's list changes in this tab: the chip says the new name at once.
    act(() => {
      state.issuerAliases = [
        { from: 'barclays', to: 'hsbc', path: [] },
        { from: 'barclays bank uk', to: 'hsbc', path: ['barclays'] },
      ];
      issuersChanged();
    });
    expect(await within(chips).findByText('From HSBC')).toBeVisible();
    fireEvent.click(within(chips).getByRole('button', { name: 'Take off the filter From HSBC' }));
    await waitFor(() => expect(window.location.search).not.toContain('issuer'));
  });
});

describe('a save refused for one made elsewhere (the review)', () => {
  it('offers to load the newer arrangement instead, letting this one go', async () => {
    const state = at('/documents?show=cabinet&arrange=1', {
      cabinet: { layout: LAYOUT, version: 2, updated_at: new Date().toISOString() },
    });
    await screen.findByRole('list', { name: 'Levels, in order' });
    const theirs: CabinetLayout = {
      ...LAYOUT,
      cabinets: LAYOUT.cabinets.map((c) => ({ ...c, name: `${c.name} (theirs)` })),
    };
    state.cabinet = { layout: theirs, version: 3, updated_at: new Date().toISOString() };
    fireEvent.change(screen.getByRole('textbox', { name: 'Name of the cabinet Aisha' }), {
      target: { value: 'Mine here' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use this arrangement' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/changed somewhere else/);
    fireEvent.click(screen.getByRole('button', { name: 'Load the newer arrangement' }));
    expect(
      await screen.findByRole('textbox', { name: 'Name of the cabinet Aisha (theirs)' }),
    ).toBeVisible();
    expect(screen.queryByDisplayValue('Mine here')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Use this arrangement' }));
    await waitFor(() => expect(state.cabinet?.version).toBe(4));
    expect(state.cabinet?.layout?.cabinets.map((c) => c.name)).toEqual([
      'Mansoor (theirs)',
      'Aisha (theirs)',
    ]);
  });
});

describe('Also in, on a document’s page', () => {
  it('names the reader’s folders it is in, each a way there', async () => {
    at('/documents/doc-1', {
      cabinet: { layout: LAYOUT, version: 1, updated_at: new Date().toISOString() },
    });
    const link = await screen.findByRole('link', { name: `Mansoor › Identity › ${thisYear}` });
    expect(link).toHaveAttribute('href', '/documents?show=cabinet&folder=f-id-this');
    expect(screen.getByText('Also in')).toBeVisible();
  });

  it('says nothing where the reader has no cabinet', async () => {
    at('/documents/doc-1');
    expect(await screen.findByRole('heading', { name: "Mansoor's passport" })).toBeVisible();
    expect(screen.queryByText('Also in')).toBeNull();
  });
});

describe('dividers and pins (C2)', () => {
  type Folder = CabinetLayout['cabinets'][number]['drawers'][number]['folders'][number];
  /** One cabinet, one drawer: every paper, Aisha's, and money. */
  const FOLDERS = (dividers?: Folder['dividers']): CabinetLayout => ({
    levels: ['topic', 'year', 'person'],
    cabinets: [
      {
        id: 'c',
        name: 'Home',
        hidden: false,
        drawn: { value: 'c' },
        drawers: [
          {
            id: 'd',
            name: 'People',
            hidden: false,
            folders: [
              {
                id: 'f-all',
                name: 'Everything',
                hidden: false,
                filter: { notes: 'exclude' },
                ...(dividers ? { dividers } : {}),
              },
              { id: 'f-aisha', name: 'Aisha', hidden: false, filter: { member_id: AISHA.id } },
              { id: 'f-fin', name: 'Money', hidden: false, filter: { category: 'financial' } },
            ],
          },
        ],
      },
    ],
  });
  const cabinet = (layout: CabinetLayout) => ({
    cabinet: { layout, version: 2, updated_at: new Date().toISOString() },
  });

  it('groups a folder’s papers behind year dividers, newest first, each counted and opened in turn', async () => {
    const state = at('/documents?show=cabinet&folder=f-all', cabinet(FOLDERS()));
    const pane = await screen.findByRole('region', { name: 'Everything' });
    const newest = await within(pane).findByRole('button', {
      name: new RegExp(`^${thisYear}, ?2 documents$`),
    });
    expect(newest).toHaveAttribute('aria-expanded', 'true');
    const older = within(pane).getByRole('button', {
      name: new RegExp(`^${lastYear}, ?1 document$`),
    });
    expect(older).toHaveAttribute('aria-expanded', 'false');
    expect(await within(pane).findByText("Mansoor's passport")).toBeVisible();
    expect(within(pane).queryByText("Aisha's passport")).toBeNull();
    fireEvent.click(older);
    expect(older).toHaveAttribute('aria-expanded', 'true');
    expect(await within(pane).findByText("Aisha's passport")).toBeVisible();
    expect(
      state.calls.some((c) => c.url.includes(`divider=${encodeURIComponent(`year:${lastYear}`)}`)),
    ).toBe(true);
    await expectAccessible();
  });

  it('groups them behind the folder’s own ranges, the rest behind Other years', async () => {
    at(
      '/documents?show=cabinet&folder=f-all',
      cabinet(
        FOLDERS({
          levels: ['year'],
          ranges: [
            { name: 'This year', from: `${thisYear}-01-01`, to: null },
            { name: 'Long ago', from: null, to: '1999-12-31' },
          ],
        }),
      ),
    );
    const pane = await screen.findByRole('region', { name: 'Everything' });
    expect(
      await within(pane).findByRole('button', { name: /^This year.*2 documents$/ }),
    ).toBeVisible();
    expect(within(pane).getByRole('button', { name: /^Long ago.*0 documents$/ })).toBeVisible();
    expect(within(pane).getByRole('button', { name: /^Other years.*1 document$/ })).toBeVisible();
    expect(within(pane).getByText(`since ${thisYear}`)).toBeVisible();
  });

  it('shows a pinned paper first, marked, and Unpin takes it out', async () => {
    const state = at('/documents?show=cabinet&folder=f-fin', {
      ...cabinet(FOLDERS()),
      cabinetPins: [{ folder_id: 'f-fin', document_id: 'doc-5' }],
    });
    const pane = await screen.findByRole('region', { name: 'Money' });
    const pinned = await within(pane).findByRole('region', { name: 'Pinned here' });
    expect(within(pinned).getByText("Aisha's passport")).toBeVisible();
    expect(within(pinned).getByText(/Pinned/, { selector: '.pin-mark' })).toBeVisible();
    // Counted once, beside the folder's own: Money holds the statement and the pin.
    const tree = screen.getByRole('navigation', { name: 'Drawers and folders in Home' });
    expect(within(tree).getByRole('button', { name: /^Money, ?2 documents$/ })).toBeVisible();
    fireEvent.click(within(pinned).getByRole('button', { name: "Unpin Aisha's passport" }));
    await waitFor(() =>
      expect(within(pane).queryByRole('region', { name: 'Pinned here' })).toBeNull(),
    );
    expect(state.pinCalls).toEqual([{ method: 'DELETE', folder: 'f-fin', ids: ['doc-5'] }]);
    expect(await screen.findByText("Aisha's passport is unpinned from Money.")).toBeInTheDocument();
    expect(await within(tree).findByRole('button', { name: /^Money, ?1 document$/ })).toBeVisible();
  });

  it('pins a paper from its page into a folder chosen, and says it is pinned there', async () => {
    const state = at('/documents/doc-1', cabinet(FOLDERS()));
    fireEvent.click(await screen.findByRole('button', { name: 'Pin to a folder…' }));
    const sheet = await screen.findByRole('dialog', { name: 'Pin this paper to a folder' });
    fireEvent.change(await within(sheet).findByLabelText('Folder'), {
      target: { value: 'f-aisha' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Pin' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Pin this paper to a folder' })).toBeNull(),
    );
    expect(state.pinCalls).toEqual([{ method: 'POST', folder: 'f-aisha', ids: ['doc-1'] }]);
    const link = await screen.findByRole('link', { name: 'Home › People › Aisha' });
    expect(link.parentElement?.textContent).toContain('Pinned');
    expect(
      await screen.findByText('This paper pinned to Home › People › Aisha.'),
    ).toBeInTheDocument();
  });

  it('pins every paper chosen in the table, from the bar', async () => {
    const state = at('/documents', cabinet(FOLDERS()));
    const table = await screen.findByRole('grid', { name: /^Documents, sorted by/ });
    fireEvent.click(
      await within(table).findByRole('checkbox', { name: "Select “Mansoor's passport”" }),
    );
    fireEvent.click(within(table).getByRole('checkbox', { name: "Select “Aisha's passport”" }));
    const bar = screen.getByRole('region', { name: 'What to do with the chosen documents' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Pin to a folder…' }));
    const sheet = await screen.findByRole('dialog', { name: 'Pin 2 documents to a folder' });
    await within(sheet).findByLabelText('Folder');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Pin' }));
    await waitFor(() => expect(state.pinCalls).toHaveLength(1));
    expect(state.pinCalls?.[0]?.folder).toBe('f-all');
    expect([...(state.pinCalls?.[0]?.ids ?? [])].sort()).toEqual(['doc-1', 'doc-5']);
  });

  it('sets a folder’s own ranges while arranging, refuses two that share days, and offers school stages', async () => {
    const state = at('/documents?show=cabinet&arrange=1', cabinet(FOLDERS()));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Dividers: by year, for Aisha in Home › People' }),
    );
    const editor = screen.getByRole('group', { name: 'Dividers in Aisha' });
    fireEvent.click(within(editor).getByRole('radio', { name: 'My own date ranges' }));
    fireEvent.change(within(editor).getByRole('textbox', { name: 'Name of divider 1' }), {
      target: { value: 'Early' },
    });
    fireEvent.change(within(editor).getByRole('textbox', { name: 'Early starts' }), {
      target: { value: '2014' },
    });
    fireEvent.change(within(editor).getByRole('textbox', { name: 'Early ends' }), {
      target: { value: '2020' },
    });
    expect(within(editor).getByRole('textbox', { name: 'Early ends' })).toHaveValue('2020');
    fireEvent.click(within(editor).getByRole('button', { name: 'Add a divider' }));
    fireEvent.change(within(editor).getByRole('textbox', { name: 'Name of divider 2' }), {
      target: { value: 'Later' },
    });
    fireEvent.change(within(editor).getByRole('textbox', { name: 'Later starts' }), {
      target: { value: '2020-09-01' },
    });
    expect(within(editor).getByText(/“Early”.*“Later”.*share days/)).toBeVisible();
    // Aisha's birthday: her school stages, which never overlap — asked first,
    // as they replace the dividers already there.
    fireEvent.click(
      within(editor).getByRole('button', { name: 'Use school stages from Aisha’s birthday' }),
    );
    const ask = await screen.findByRole('alertdialog', { name: 'Replace the dividers of Aisha?' });
    fireEvent.click(within(ask).getByRole('button', { name: 'Use school stages' }));
    expect(within(editor).queryByText(/share days/)).toBeNull();
    expect(within(editor).getByRole('textbox', { name: 'Elementary starts' })).toHaveValue(
      '2021-09-01',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Use this arrangement' }));
    await waitFor(() => expect(state.cabinetSaves).toHaveLength(1));
    const folder = state.cabinetSaves?.[0]?.layout.cabinets[0]?.drawers[0]?.folders[1];
    expect(folder?.dividers?.ranges.map((r) => r.name)).toEqual([
      'College',
      'High school',
      'Middle school',
      'Elementary',
    ]);
  });

  it('keeps what is typed, and gives a year shared between two ranges to the later one: the owner’s example', async () => {
    const state = at('/documents?show=cabinet&arrange=1', cabinet(FOLDERS()));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Dividers: by year, for Aisha in Home › People' }),
    );
    const editor = screen.getByRole('group', { name: 'Dividers in Aisha' });
    fireEvent.click(within(editor).getByRole('radio', { name: 'My own date ranges' }));
    const rows: Array<[string, string, string]> = [
      ['Elementary', '2014', '2020'],
      ['Middle school', '2020', '2023'],
      ['High school', '2023', '2027'],
      ['College', '2027', ''],
    ];
    for (const [i, [name, from, to]] of rows.entries()) {
      if (i > 0) fireEvent.click(within(editor).getByRole('button', { name: 'Add a divider' }));
      fireEvent.change(within(editor).getByRole('textbox', { name: `Name of divider ${i + 1}` }), {
        target: { value: name },
      });
      fireEvent.change(within(editor).getByRole('textbox', { name: `${name} starts` }), {
        target: { value: from },
      });
      if (to) {
        fireEvent.change(within(editor).getByRole('textbox', { name: `${name} ends` }), {
          target: { value: to },
        });
      }
    }
    // As typed, never turned into another form; the days under each row.
    expect(within(editor).getByRole('textbox', { name: 'Elementary ends' })).toHaveValue('2020');
    expect(within(editor).getByText('1 Jan 2014 – 31 Dec 2019')).toBeVisible();
    expect(within(editor).getByText('1 Jan 2020 – 31 Dec 2022')).toBeVisible();
    expect(within(editor).getByText('from 1 Jan 2027')).toBeVisible();
    expect(within(editor).queryByText(/share days/)).toBeNull();
    // A full date typed keeps its every figure, to the last one.
    const ends = within(editor).getByRole('textbox', { name: 'College ends' });
    fireEvent.change(ends, { target: { value: '2031-12-31' } });
    expect(ends).toHaveValue('2031-12-31');
    fireEvent.click(screen.getByRole('button', { name: 'Use this arrangement' }));
    await waitFor(() => expect(state.cabinetSaves).toHaveLength(1));
    const folder = state.cabinetSaves?.[0]?.layout.cabinets[0]?.drawers[0]?.folders[1];
    expect(folder?.dividers?.ranges).toEqual([
      { name: 'Elementary', from: '2014', to: '2020' },
      { name: 'Middle school', from: '2020', to: '2023' },
      { name: 'High school', from: '2023', to: '2027' },
      { name: 'College', from: '2027', to: '2031-12-31' },
    ]);
  });

  it('asks before a new arrangement lets pins go, saying how many', async () => {
    // Last year's Identity folder, empty but for a pin: no drawing by Person › Kind keeps it.
    const state = at('/documents?show=cabinet&arrange=1', {
      ...cabinet(LAYOUT),
      cabinetPins: [{ folder_id: 'f-id-last', document_id: 'doc-5' }],
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Person › Kind' }));
    expect(
      await screen.findByRole('textbox', { name: 'Name of the cabinet My cabinet' }),
    ).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Use this arrangement' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Use this arrangement' }));
    const ask = await screen.findByRole('alertdialog', { name: 'Let 1 pinned paper go?' });
    expect(state.cabinetSaves ?? []).toHaveLength(0);
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(state.cabinetSaves ?? []).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Use this arrangement' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog', { name: 'Let 1 pinned paper go?' })).getByRole(
        'button',
        { name: 'Use this arrangement' },
      ),
    );
    await waitFor(() => expect(state.cabinetSaves).toHaveLength(1));
  });

  it('moves a folder’s pins with it when it is merged into the one above', async () => {
    const state = at('/documents?show=cabinet&arrange=1', {
      ...cabinet({
        levels: ['topic', 'year', 'person'],
        cabinets: [
          {
            id: 'c',
            name: 'Home',
            hidden: false,
            drawn: { value: 'c' },
            drawers: [
              {
                id: 'd',
                name: 'Years',
                hidden: false,
                folders: [
                  { id: 'y1', name: '2024', hidden: false, filter: year(2024) },
                  { id: 'y2', name: '2025', hidden: false, filter: year(2025) },
                ],
              },
            ],
          },
        ],
      }),
      cabinetPins: [{ folder_id: 'y2', document_id: 'doc-1' }],
    });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Merge 2025 in Home › Years into 2024' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Use this arrangement' }));
    await waitFor(() => expect(state.cabinetSaves).toHaveLength(1));
    expect(state.cabinetSaves?.[0]?.pins_moved).toEqual([{ from: 'y2', to: 'y1' }]);
    expect(state.cabinetPins).toEqual([{ folder_id: 'y1', document_id: 'doc-1' }]);
  });
});

describe('levels you choose (0.9.0-dev.90)', () => {
  const saved = (layout: CabinetLayout, over: Partial<FakeState> = {}) =>
    at('/documents?show=cabinet&arrange=1', {
      cabinet: { layout, version: 2, updated_at: new Date().toISOString() },
      ...over,
    });
  /** A cabinet no drawing made, as no release keeps one: never read. */
  const LOOSE = {
    id: 'c-hand',
    name: 'My folders',
    hidden: false,
    drawers: [
      {
        id: 'd-hand',
        name: 'Scans',
        hidden: false,
        folders: [{ id: 'f-hand', name: 'Scans', hidden: false, filter: { tag: 'scan' } }],
      },
    ],
  };
  const levelsShown = () =>
    within(screen.getByRole('list', { name: 'Levels, in order' }))
      .getAllByRole('listitem')
      .map((li) => li.textContent?.replace(/[↑↓×⋮]/g, '').trim());

  it('chooses and orders the levels with ↑ and ↓, the focus kept, every cabinet drawn by them', async () => {
    const state = saved({ ...LAYOUT, cabinets: [...LAYOUT.cabinets, LOOSE] });
    await screen.findByRole('list', { name: 'Levels, in order' });
    expect(levelsShown()).toEqual([
      '1Personwhose it isCabinet',
      '2Topicwhat it is aboutDrawer',
      '3Yearissued, else addedFolder',
    ]);
    // Topic up: the cabinets by topic, drawn by the vault over what is there.
    fireEvent.click(screen.getByRole('button', { name: 'Move Topic up' }));
    expect(
      await screen.findByText('Topic moved up: now level 1, the cabinets.'),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Move Topic down' })).toHaveFocus(),
    );
    await waitFor(() =>
      expect(state.cabinetPreviewAsks?.at(-1)?.levels).toEqual(['topic', 'person', 'year']),
    );
    // One structure: the cabinet no drawing made is not there to draw over.
    expect(state.cabinetPreviewAsks?.at(-1)?.layout?.cabinets.map((c) => c.id)).toEqual([
      'c-me',
      'c-aisha',
    ]);
    expect(
      await screen.findByRole('textbox', { name: 'Name of the cabinet Identity' }),
    ).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Name of the cabinet My folders' })).toBeNull();
    expect(screen.queryByText('Arranged by hand')).toBeNull();
    expect(screen.queryByText(/beside the drawn ones/)).toBeNull();
    const scopes = screen.getByRole('list', { name: 'What to arrange' });
    expect(within(scopes).queryByText('My folders')).toBeNull();
    // A fourth level is a divider, and costs no folders.
    fireEvent.click(screen.getByRole('button', { name: '+ Kind' }));
    expect(levelsShown()[3]).toBe('4Kindbank statement, payslip…Divider');
    await waitFor(() =>
      expect(state.cabinetPreviewAsks?.at(-1)?.levels).toEqual(['topic', 'person', 'year', 'kind']),
    );
    // Who issued it is a level to choose (0.9.0-dev.91), no longer coming next.
    expect(screen.getByRole('button', { name: '+ Who issued it' })).toBeEnabled();
    expect(screen.queryByText('coming next')).toBeNull();
    // Two levels at least: removing stops there.
    fireEvent.click(screen.getByRole('button', { name: 'Remove Kind' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Year' }));
    expect(screen.getByRole('button', { name: 'Remove Topic' })).toBeDisabled();
    expect(screen.getByText(/A paper would be found at:/).parentElement?.textContent).toMatch(
      /My cabinet › Financial › Me · dividers by year/,
    );
    await waitFor(() =>
      expect(state.cabinetPreviewAsks?.at(-1)?.levels).toEqual(['topic', 'person']),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Use this arrangement' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Use this arrangement' }));
    await waitFor(() => expect(state.cabinetSaves).toHaveLength(1));
    const sent = state.cabinetSaves?.[0]?.layout;
    expect(sent?.levels).toEqual(['topic', 'person']);
    expect(sent?.cabinets.some((c) => c.id === 'c-hand')).toBe(false);
    expect(sent?.cabinets.every((c) => c.drawn)).toBe(true);
    // The bar says how it is arranged.
    expect(await screen.findByText(/Arranged by Topic › Person/)).toBeVisible();
  });

  it('moves a level by dragging its row, as the arrows do', async () => {
    const state = saved(LAYOUT);
    const list = await screen.findByRole('list', { name: 'Levels, in order' });
    const rows = within(list).getAllByRole('listitem');
    const person = rows[0] as HTMLElement;
    const yearRow = rows[2] as HTMLElement;
    const dataTransfer = { effectAllowed: '', setData: () => undefined };
    fireEvent.dragStart(yearRow, { dataTransfer });
    fireEvent.dragOver(person, { dataTransfer });
    fireEvent.drop(person, { dataTransfer });
    await waitFor(() =>
      expect(state.cabinetPreviewAsks?.at(-1)?.levels).toEqual(['year', 'person', 'topic']),
    );
    expect(
      await screen.findByText('Year moved up: now level 1, the cabinets.'),
    ).toBeInTheDocument();
  });

  it('warns of too many folders in amber, moves the level down for me, and refuses only past the limits', async () => {
    const wide = (n: number, levels: CabinetLayout['levels']): CabinetLayout => ({
      levels,
      cabinets: [
        {
          id: 'w',
          name: 'Mansoor',
          hidden: false,
          drawn: { value: 'me' },
          drawers: [
            {
              id: 'wd',
              name: 'Financial',
              hidden: false,
              folders: Array.from({ length: n }, (_, i) => ({
                id: `wf${i}`,
                name: `Kind ${i}`,
                hidden: false,
                filter: { notes: 'exclude', tag: `k${i}` },
              })),
            },
          ],
        },
      ],
    });
    const state = saved(LAYOUT, {
      cabinetPreview: (ask) => {
        const n = ask.levels[2] === 'kind' ? 45 : ask.levels[1] === 'kind' ? 301 : 3;
        const layout = wide(n, ask.levels);
        return { layout, counts: {}, documents: n, left_out: 0, size: cabinetSize(layout) };
      },
    });
    await screen.findByRole('list', { name: 'Levels, in order' });
    fireEvent.click(screen.getByRole('button', { name: '+ Kind' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Move Kind up' }));
    const warn = await screen.findByText('That is a lot of folders.');
    const box = warn.closest('.level-warn') as HTMLElement;
    expect(box).toHaveTextContent(/The drawer Mansoor › Financial alone holds 45 folders\./);
    expect(box).toHaveTextContent(/Move Kind below the folders, where it becomes dividers/);
    await expectAccessible();
    fireEvent.click(within(box).getByRole('button', { name: 'Move it down for me' }));
    await waitFor(() =>
      expect(state.cabinetPreviewAsks?.at(-1)?.levels).toEqual(['person', 'topic', 'year', 'kind']),
    );
    await waitFor(() => expect(screen.queryByText('That is a lot of folders.')).toBeNull());
    expect(
      await screen.findByText('Kind moved down: now level 4, dividers inside each folder.'),
    ).toBeInTheDocument();
    // Past what a cabinet can hold: red, and not used.
    fireEvent.click(screen.getByRole('button', { name: 'Move Kind up' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Move Kind up' }));
    expect(await screen.findByText('That is more than a cabinet can hold.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Use this arrangement' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save anyway' })).toBeNull();
    // Amber again: saved anyway.
    fireEvent.click(screen.getByRole('button', { name: 'Move Kind down' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save anyway' }));
    await waitFor(() => expect(state.cabinetSaves).toHaveLength(1));
    expect(state.cabinetSaves?.[0]?.layout.levels).toEqual(['person', 'topic', 'kind', 'year']);
  });

  it('arranges one cabinet its own way from its ⋯ menu, marks it, and uses the default again', async () => {
    const BY_TOPIC: CabinetLayout = {
      levels: ['topic', 'year', 'person'],
      cabinets: [
        {
          id: 'c-fin',
          name: 'Financial',
          hidden: false,
          drawn: { value: 'financial' },
          drawers: [
            {
              id: 'd-fin',
              name: String(thisYear),
              hidden: false,
              folders: [
                {
                  id: 'f-fin-me',
                  name: 'Mansoor',
                  hidden: false,
                  filter: {
                    notes: 'exclude',
                    category: 'financial',
                    member_id: 'me',
                    ...year(thisYear),
                  },
                  dividers: { levels: [], ranges: [] },
                },
              ],
            },
          ],
        },
      ],
    };
    const state = saved(BY_TOPIC);
    const scopes = await screen.findByRole('list', { name: 'What to arrange' });
    expect(within(scopes).getByText('Follows the default')).toBeVisible();
    const more = within(scopes).getByRole('button', { name: 'More for Financial' });
    fireEvent.click(more);
    const menu = await screen.findByRole('menu', { name: 'Financial' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((m) => m.textContent),
    ).toEqual(['Arrange this cabinet…']);
    await waitFor(() => expect(within(menu).getByRole('menuitem')).toHaveFocus());
    await expectAccessible();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(more).toHaveFocus();
    fireEvent.click(more);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Arrange this cabinet…' }));
    // The cabinet itself comes from the default's first level: fixed.
    expect(await screen.findByRole('heading', { name: 'Financial' })).toBeVisible();
    expect(levelsShown()).toEqual([
      '1Topicthe cabinet itself, set by the defaultCabinet',
      '2Yearissued, else addedDrawer',
      '3Personwhose it isFolder',
    ]);
    // Fixed: never moved or removed; only the levels below it are chosen.
    expect(screen.queryByRole('button', { name: 'Move Topic up' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Move Topic down' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove Topic' })).toBeNull();
    expect(screen.queryByRole('button', { name: '+ Topic' })).toBeNull();
    expect(
      screen.getByText(
        /If the default’s first level changes, this cabinet follows the default again\./,
      ),
    ).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Move Person up' }));
    await waitFor(() =>
      expect(state.cabinetPreviewAsks?.at(-1)).toMatchObject({
        levels: ['topic', 'year', 'person'],
        cabinet: { id: 'c-fin', levels: ['person', 'year'] },
      }),
    );
    expect(await within(scopes).findByText('Own arrangement')).toBeVisible();
    expect(
      await screen.findByRole('textbox', { name: 'Name of the drawer Mansoor in Financial' }),
    ).toBeVisible();
    // Its menu now offers the default again.
    fireEvent.click(within(scopes).getByRole('button', { name: 'More for Financial' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Use the default again' }));
    await waitFor(() =>
      expect(state.cabinetPreviewAsks?.at(-1)).toMatchObject({
        cabinet: { id: 'c-fin', levels: null },
      }),
    );
    expect(await within(scopes).findByText('Follows the default')).toBeVisible();
    // Its own again, and kept.
    fireEvent.click(screen.getByRole('button', { name: 'Move Person up' }));
    expect(await within(scopes).findByText('Own arrangement')).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Use this arrangement' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Use this arrangement' }));
    await waitFor(() => expect(state.cabinetSaves).toHaveLength(1));
    const sent = state.cabinetSaves?.[0]?.layout;
    expect(sent?.cabinets.find((c) => c.id === 'c-fin')?.drawn).toEqual({
      value: 'financial',
      levels: ['person', 'year'],
    });
    // Browsing, its card says so.
    const cards = await screen.findByRole('list', { name: 'Your cabinets' });
    expect(within(cards).getByText('Own arrangement')).toBeVisible();
    expect(screen.queryByText('Arranged by hand')).toBeNull();
  });

  it('browses a folder divided by two levels: each kind a tab, its years inside it', async () => {
    const layout: CabinetLayout = {
      levels: ['person', 'topic', 'year', 'kind'],
      cabinets: [
        {
          id: 'c',
          name: 'Home',
          hidden: false,
          drawn: { value: 'me' },
          drawers: [
            {
              id: 'd',
              name: 'Papers',
              hidden: false,
              folders: [
                {
                  id: 'f-all',
                  name: 'Everything',
                  hidden: false,
                  filter: { notes: 'exclude' },
                  dividers: { levels: ['kind', 'year'], ranges: [] },
                },
              ],
            },
          ],
        },
      ],
    };
    const state = at('/documents?show=cabinet&folder=f-all', {
      cabinet: { layout, version: 2, updated_at: new Date().toISOString() },
    });
    const pane = await screen.findByRole('region', { name: 'Everything' });
    // The statement, of one year: one tab, the first, open. Passports of two
    // years: a tab of its own, each year a tab inside it.
    const statement = await within(pane).findByRole('button', {
      name: /statement, ?1 document$/i,
    });
    expect(statement.closest('h3')).not.toBeNull();
    expect(statement).toHaveAttribute('aria-expanded', 'true');
    const passports = within(pane).getByRole('button', { name: /^Passport, ?2 documents$/ });
    expect(passports.closest('h3')).not.toBeNull();
    expect(passports).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(passports);
    expect(passports).toHaveAttribute('aria-expanded', 'true');
    const newest = within(pane).getByRole('button', {
      name: new RegExp(`^${thisYear}, ?1 document$`),
    });
    expect(newest.closest('h4')).not.toBeNull();
    fireEvent.click(newest);
    expect(await within(pane).findByText("Mansoor's passport")).toBeVisible();
    const older = within(pane).getByRole('button', {
      name: new RegExp(`^${lastYear}, ?1 document$`),
    });
    fireEvent.click(older);
    expect(await within(pane).findByText("Aisha's passport")).toBeVisible();
    expect(
      state.calls.some((c) =>
        c.url.includes(`divider=${encodeURIComponent(`kind:passport/year:${lastYear}`)}`),
      ),
    ).toBe(true);
    await expectAccessible();
    fireEvent.click(passports);
    expect(passports).toHaveAttribute('aria-expanded', 'false');
    expect(within(pane).queryByText("Aisha's passport")).toBeNull();
  });
});

describe('levels you choose: focus, scope and words (the review)', () => {
  const savedAt = (layout: CabinetLayout, over: Partial<FakeState> = {}) =>
    at('/documents?show=cabinet&arrange=1', {
      cabinet: { layout, version: 2, updated_at: new Date().toISOString() },
      ...over,
    });

  it('keeps the focus on a level that is there after adding, removing and moving one down', async () => {
    const wide = (n: number, levels: CabinetLayout['levels']): CabinetLayout => ({
      levels,
      cabinets: [
        {
          id: 'w',
          name: 'Mansoor',
          hidden: false,
          drawn: { value: 'me' },
          drawers: [
            {
              id: 'wd',
              name: 'Financial',
              hidden: false,
              folders: Array.from({ length: n }, (_, i) => ({
                id: `wf${i}`,
                name: `Kind ${i}`,
                hidden: false,
                filter: { notes: 'exclude', tag: `k${i}` },
              })),
            },
          ],
        },
      ],
    });
    savedAt(LAYOUT, {
      cabinetPreview: (ask) => {
        const layout = wide(ask.levels[2] === 'kind' ? 45 : 3, ask.levels);
        return { layout, counts: {}, documents: 3, left_out: 0, size: cabinetSize(layout) };
      },
    });
    await screen.findByRole('list', { name: 'Levels, in order' });
    // Added: its chip is gone, the focus on the level added.
    fireEvent.click(screen.getByRole('button', { name: '+ Kind' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Move Kind up' })).toHaveFocus());
    expect(
      await screen.findByText('Kind added: now level 4, dividers inside each folder.'),
    ).toBeInTheDocument();
    // Removed: the focus on the level that took its place, else the one before.
    fireEvent.click(screen.getByRole('button', { name: 'Remove Kind' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove Year' })).toHaveFocus());
    fireEvent.click(screen.getByRole('button', { name: 'Remove Topic' }));
    // Two levels left: Year's own remove is off, so its move.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Move Year up' })).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
    // Three levels again, Kind the folders: 45 in a drawer, and Year put in above it for me.
    fireEvent.click(screen.getByRole('button', { name: '+ Kind' }));
    const warn = await screen.findByText('That is a lot of folders.');
    const box = warn.closest('.level-warn') as HTMLElement;
    expect(box).toHaveTextContent(/Add Topic above Kind, which then goes below the folders/);
    fireEvent.click(within(box).getByRole('button', { name: 'Move it down for me' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Move Kind up' })).toHaveFocus());
    expect(
      await screen.findByText(
        'Topic added. Kind moved down: now level 4, dividers inside each folder.',
      ),
    ).toBeInTheDocument();
  });

  it('never warns of a cabinet with its own arrangement, for the default', async () => {
    const own: CabinetLayout['cabinets'][number] = {
      ...(LAYOUT.cabinets[1] as CabinetLayout['cabinets'][number]),
      drawn: { value: AISHA.id, levels: ['kind', 'year'] },
    };
    savedAt({
      ...LAYOUT,
      cabinets: [LAYOUT.cabinets[0] as CabinetLayout['cabinets'][number], own],
    });
    await screen.findByRole('list', { name: 'Levels, in order' });
    expect(screen.queryByText('That is a lot of folders.')).toBeNull();
    expect(screen.queryByText('That is more than a cabinet can hold.')).toBeNull();
  });

  it('says what saving lets go: own arrangements going to two levels, and pinned papers', () => {
    const saved: CabinetLayout = {
      levels: ['topic', 'year', 'person'],
      cabinets: [
        {
          id: 'c-fin',
          name: 'Financial',
          hidden: false,
          drawn: { value: 'financial', levels: ['person', 'kind'] },
          drawers: [],
        },
      ],
    };
    const two = changeWords(saved, { levels: ['topic', 'kind'], cabinets: [] });
    expect(two).toMatch(/Financial has its own arrangement, which is let go: with two levels/);
    const first = changeWords(saved, { levels: ['person', 'year', 'topic'], cabinets: [] });
    expect(first).toMatch(/Financial has its own arrangement, which is let go: the first level/);
    // The first level the same, three levels still: kept.
    expect(changeWords(saved, { levels: ['topic', 'person', 'year'], cabinets: [] })).not.toMatch(
      /let go:/,
    );
    // Dividers only: nothing lost, unless a pin would be.
    expect(changeWords(saved, { levels: ['topic', 'year', 'person', 'kind'], cabinets: [] })).toBe(
      'Only the dividers change: no folder is redrawn, and folders whose dividers you set yourself keep them.',
    );
    const pinned = changeWords(
      saved,
      { levels: ['topic', 'year', 'person', 'kind'], cabinets: [] },
      2,
    );
    expect(pinned).not.toMatch(/nothing is lost/);
    expect(pinned).toMatch(/2 pinned papers are in folders this arrangement doesn’t keep/);
  });

  it('offers a folder’s dividers as arranged, from its cabinet’s levels as they are now', async () => {
    const drawn: CabinetLayout = {
      levels: ['person', 'topic', 'year', 'kind'],
      cabinets: [
        {
          ...(LAYOUT.cabinets[0] as CabinetLayout['cabinets'][number]),
          drawers: (LAYOUT.cabinets[0]?.drawers ?? []).map((d) => ({
            ...d,
            folders: d.folders.map((f) => ({
              ...f,
              dividers: { levels: ['kind' as const], ranges: [] },
            })),
          })),
        },
      ],
    };
    const state = savedAt(drawn);
    const button = await screen.findByRole('button', {
      name: `Dividers: by kind, for ${thisYear} in Mansoor › Financial`,
    });
    fireEvent.click(button);
    const editor = await screen.findByRole('group', { name: `Dividers in ${thisYear}` });
    expect(within(editor).getByRole('radio', { name: 'As arranged: by kind' })).toBeChecked();
    // No dividers: "As arranged" still offered, and puts them back.
    fireEvent.click(within(editor).getByRole('radio', { name: 'No dividers' }));
    expect(within(editor).getByRole('radio', { name: 'No dividers' })).toBeChecked();
    fireEvent.click(within(editor).getByRole('radio', { name: 'As arranged: by kind' }));
    expect(within(editor).getByRole('radio', { name: 'As arranged: by kind' })).toBeChecked();
    // Kind no longer a level: the editor still open, nothing is "as arranged" by kind.
    fireEvent.click(screen.getByRole('button', { name: 'Remove Kind' }));
    await waitFor(() =>
      expect(state.cabinetPreviewAsks?.at(-1)?.levels).toEqual(['person', 'topic', 'year']),
    );
    const open = await screen.findByRole('group', { name: `Dividers in ${thisYear}` });
    expect(within(open).queryByRole('radio', { name: /As arranged/ })).toBeNull();
    expect(within(open).getByRole('radio', { name: 'No dividers' })).toBeChecked();
  });
});

describe('Who issued it as a level (0.9.0-dev.91)', () => {
  /** Barclays twice, and once as Barclays Bank UK: the same bank, written two ways. */
  const PAPERS = [
    { ...STATEMENT, id: 'doc-b1', etag: '"b1"', issued_by: 'Barclays' },
    { ...STATEMENT, id: 'doc-b2', etag: '"b2"', issued_by: 'Barclays' },
    {
      ...STATEMENT,
      id: 'doc-b3',
      etag: '"b3"',
      title: 'Barclays Bank UK letter',
      issued_by: 'Barclays Bank UK PLC',
    },
    { ...STATEMENT, id: 'doc-none', etag: '"none"', title: 'No issuer', issued_by: null },
  ];
  const arranging = () =>
    at('/documents?show=cabinet&arrange=1', {
      documents: PAPERS.map((d) => ({ ...d })),
      cabinet: { layout: LAYOUT, version: 2, updated_at: new Date().toISOString() },
    });

  it('adds Who issued it as a level, suggests what looks like one, and says Same for everybody', async () => {
    const state = arranging();
    fireEvent.click(await screen.findByRole('button', { name: '+ Who issued it' }));
    await waitFor(() =>
      expect(state.cabinetPreviewAsks?.at(-1)?.levels).toEqual([
        'person',
        'topic',
        'year',
        'issuer',
      ]),
    );
    const box = await screen.findByRole('region', { name: 'These issuers look like one' });
    expect(box.textContent).toMatch(
      /“Barclays” \(2 papers\) and “Barclays Bank UK PLC” \(1 paper\) look like one\./,
    );
    expect(within(box).getByRole('link', { name: 'Settings › Who issued it' })).toHaveAttribute(
      'href',
      '/settings/issuers',
    );
    await expectAccessible();
    const asked = state.cabinetPreviewAsks?.length ?? 0;
    fireEvent.click(
      within(box).getByRole('button', { name: 'Same: “Barclays Bank UK PLC” is “Barclays”' }),
    );
    await waitFor(() =>
      expect(state.issuerChanges).toEqual([
        { how: 'same', from: 'barclays bank uk', to: 'barclays' },
      ]),
    );
    expect(
      await screen.findByText('“Barclays Bank UK PLC” is now the same issuer as “Barclays”.'),
    ).toBeInTheDocument();
    // Drawn again, the same levels, and nothing left to suggest.
    await waitFor(() => expect(state.cabinetPreviewAsks?.length).toBe(asked + 1));
    expect(state.cabinetPreviewAsks?.at(-1)?.levels).toEqual(['person', 'topic', 'year', 'issuer']);
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'These issuers look like one' })).toBeNull(),
    );
    // None left: the focus on the Who issued it level, never lost.
    await waitFor(() =>
      expect(document.activeElement?.closest('[data-level="issuer"]')).not.toBeNull(),
    );
  });

  it('keeps the focus beside the next suggestion when one is answered, and says so', async () => {
    const state = at('/documents?show=cabinet&arrange=1', {
      documents: [
        ...PAPERS.map((d) => ({ ...d })),
        { ...STATEMENT, id: 'doc-h1', etag: '"h1"', title: 'HSBC one', issued_by: 'HSBC' },
        { ...STATEMENT, id: 'doc-h2', etag: '"h2"', title: 'HSBC two', issued_by: 'HSBC' },
        { ...STATEMENT, id: 'doc-h3', etag: '"h3"', title: 'HSBC UK', issued_by: 'HSBC UK' },
      ],
      cabinet: { layout: LAYOUT, version: 2, updated_at: new Date().toISOString() },
    });
    fireEvent.click(await screen.findByRole('button', { name: '+ Who issued it' }));
    const box = await screen.findByRole('region', { name: 'These issuers look like one' });
    expect(within(box).getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(
      within(box).getByRole('button', {
        name: 'Separate: keep “Barclays Bank UK PLC” and “Barclays” apart',
      }),
    );
    await waitFor(() => expect(state.issuerChanges).toHaveLength(1));
    // The one left in its place has the focus; what happened is said.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Same: “HSBC UK” is “HSBC”' }),
      ),
    );
    expect(
      screen.getByText('“Barclays Bank UK PLC” and “Barclays” are kept separate.'),
    ).toBeInTheDocument();
  });

  it('keeps two apart with Separate, and suggests nothing where Who issued it is no level', async () => {
    const state = arranging();
    await screen.findByRole('list', { name: 'Levels, in order' });
    expect(screen.queryByRole('region', { name: 'These issuers look like one' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '+ Who issued it' }));
    const box = await screen.findByRole('region', { name: 'These issuers look like one' });
    fireEvent.click(
      within(box).getByRole('button', {
        name: 'Separate: keep “Barclays Bank UK PLC” and “Barclays” apart',
      }),
    );
    await waitFor(() =>
      expect(state.issuerChanges).toEqual([
        { how: 'separate', from: 'barclays bank uk', to: 'barclays' },
      ]),
    );
    expect(
      await screen.findByText('“Barclays Bank UK PLC” and “Barclays” are kept separate.'),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'These issuers look like one' })).toBeNull(),
    );
  });

  it('opens a folder divided by who issued it, the household’s names, No issuer given last', async () => {
    const layout: CabinetLayout = {
      levels: ['topic', 'person', 'year', 'issuer'],
      cabinets: [
        {
          id: 'c-fin',
          name: 'Financial',
          hidden: false,
          drawn: { value: 'financial' },
          drawers: [
            {
              id: 'd-me',
              name: 'Mansoor',
              hidden: false,
              folders: [
                {
                  id: 'f-now',
                  name: '2026',
                  hidden: false,
                  filter: {
                    notes: 'exclude',
                    category: 'financial',
                    member_id: ME.id,
                    ...year(2026),
                  },
                  dividers: { levels: ['issuer'], ranges: [] },
                },
              ],
            },
          ],
        },
      ],
    };
    at(`/documents?show=cabinet&cabinet=c-fin&folder=f-now`, {
      documents: PAPERS.map((d) => ({ ...d, owner_member_id: ME.id })),
      cabinet: { layout, version: 2, updated_at: new Date().toISOString() },
      issuerAliases: [{ from: 'barclays bank uk', to: 'barclays', path: [] }],
    });
    await waitFor(() => expect(document.querySelectorAll('.cab-divider-tab').length).toBe(2));
    const tabs = [...document.querySelectorAll('.cab-divider-tab .cab-divider-name')].map(
      (n) => n.textContent,
    );
    // Barclays Bank UK is Barclays to this household: one divider, its name theirs.
    expect(tabs).toEqual(['Barclays', 'No issuer given']);
    expect(document.querySelector('.cab-divider-tab')?.textContent).toMatch(/3/);
    await expectAccessible();
  });
});
