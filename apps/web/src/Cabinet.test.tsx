import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CabinetLayout, CabinetPreview } from '@fdv/shared';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
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
  arranged_by: 'person_category_year',
  cabinets: [
    {
      id: 'c-me',
      name: 'Mansoor',
      hidden: false,
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
};

function at(path: string, over: Partial<FakeState> = {}): FakeState {
  atWidth(WIDE);
  const state = fresh({
    members: [ME, AISHA],
    documents: DOCS.map((d) => ({ ...d })),
    cabinets: true,
    cabinetPreviews: { person_category_year: PREVIEW },
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
    expect(screen.getByText(/Arranged by person, then topic, then year/)).toBeVisible();
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
    arranged_by: 'category_year_person',
    cabinets: [
      {
        id: 'c-id',
        name: 'Identity',
        hidden: false,
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
    arranged_by: null,
    cabinets: [
      {
        id: 'c',
        name: 'Papers',
        hidden: false,
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
    const state = at('/documents?show=cabinet');
    fireEvent.click(await screen.findByRole('button', { name: 'Arrange my cabinet' }));
    const by = await screen.findByRole('group', { name: 'Arrange by' });
    expect(within(by).getAllByRole('radio')).toHaveLength(3);
    expect(
      within(by).getByRole('radio', { name: /By person, then topic, then year/ }),
    ).toBeChecked();
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
    const by = await screen.findByRole('group', { name: 'Arrange by' });
    expect(within(by).getByRole('radio', { name: /My cabinet as it is/ })).toBeChecked();
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

  it('is accessible while arranging', async () => {
    at('/documents?show=cabinet&arrange=1');
    expect(await screen.findByText(/4 documents in 4 folders/)).toBeVisible();
    await expectAccessible();
  });
});

describe('a folder in the table, whole (the review)', () => {
  /** A merged folder (two people, two kinds) and one of two statuses. */
  const MERGED: CabinetLayout = {
    arranged_by: null,
    cabinets: [
      {
        id: 'c',
        name: 'Family',
        hidden: false,
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
      if (folder === 'merged') {
        // Named in words, never by an id or a key.
        const person = screen.getByRole('combobox', { name: 'Person' });
        expect(within(person).getByRole('option', { selected: true })).toHaveTextContent(
          'Mansoor Seikh or Aisha',
        );
        const kind = screen.getByRole('combobox', { name: 'Kind' });
        expect(within(kind).getByRole('option', { selected: true }).textContent).not.toMatch(
          /passport|bank_statement/,
        );
      } else {
        const status = screen.getByRole('combobox', { name: 'Status' });
        expect(within(status).getByRole('option', { selected: true }).textContent).toMatch(/ or /);
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
    const chips = await screen.findByRole('group', { name: 'Folder filters' });
    expect(within(chips).getByText('Topic: Identity')).toBeVisible();
    expect(within(chips).getByText(`Dated ${thisYear}`)).toBeVisible();
    fireEvent.click(
      within(chips).getByRole('button', { name: 'Take off the filter Topic: Identity' }),
    );
    await waitFor(() => expect(window.location.search).not.toContain('category'));
    expect(window.location.search).toContain('dated_from');
  });
});

describe('a save refused for one made elsewhere (the review)', () => {
  it('offers to load the newer arrangement instead, letting this one go', async () => {
    const state = at('/documents?show=cabinet&arrange=1', {
      cabinet: { layout: LAYOUT, version: 2, updated_at: new Date().toISOString() },
    });
    await screen.findByRole('group', { name: 'Arrange by' });
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
    arranged_by: null,
    cabinets: [
      {
        id: 'c',
        name: 'Home',
        hidden: false,
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
          years: true,
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
    const state = at('/documents?show=cabinet&arrange=1', {
      ...cabinet(FOLDERS()),
      cabinetPins: [{ folder_id: 'f-all', document_id: 'doc-5' }],
    });
    fireEvent.click(
      await screen.findByRole('radio', { name: /^By person, then topic, then year/ }),
    );
    expect(await screen.findByText(/You have 1 pinned paper/)).toBeVisible();
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
        arranged_by: null,
        cabinets: [
          {
            id: 'c',
            name: 'Home',
            hidden: false,
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
