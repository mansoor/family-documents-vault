import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { addFolderTree, type CabinetFromFolders, type CabinetLayout } from '@fdv/shared';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { fresh, installFakeApi, ME, PASSPORT, signedIn, type FakeState } from './test-api.js';

/**
 * The folder a paper came from (0.9.0, C4): said on a document's page as a
 * way to the other papers from it, forgotten after a confirm, and its tree
 * kept as the reader's cabinet — looked over first, added beside what is
 * there, and confirmed when there is a cabinet already.
 */

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
  sessionStorage.clear();
  window.history.replaceState({}, '', '/');
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'matchMedia');
});

const LAYOUT: CabinetLayout = {
  arranged_by: null,
  cabinets: [
    {
      id: 'c-study',
      name: 'Study cabinet',
      hidden: false,
      drawers: [
        {
          id: 'd-two',
          name: 'Drawer 2',
          hidden: false,
          folders: [
            { id: 'f-ids', name: 'Identity', hidden: false, filter: { category: 'identity' } },
          ],
        },
      ],
    },
  ],
};

const FOLDERS = [
  { path: 'Taxes', documents: 1 },
  { path: 'Taxes/2025', documents: 2 },
];

/** What the vault draws for these folders on this layout, as GET /cabinet/from-folders answers. */
function drawn(layout: CabinetLayout | null, version: number): CabinetFromFolders {
  let n = 0;
  return {
    version,
    folders: FOLDERS,
    ...addFolderTree(layout, FOLDERS, () => `new-${++n}`),
  };
}

function at(
  path: string,
  over: Partial<FakeState> = {},
  role: 'owner' | 'viewer' = 'owner',
): FakeState {
  atWidth(1280);
  const fake = fresh({
    members: [ME],
    documents: [{ ...PASSPORT, source_folder: 'Taxes/2025' }],
    cabinets: true,
    cabinet: { layout: LAYOUT, version: 1, updated_at: '2026-11-16T10:00:00Z' },
    fromFolders: drawn(LAYOUT, 1),
    ...over,
  });
  installFakeApi(fake);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  return fake;
}

describe('a document’s page', () => {
  it('says the folder it came from, as a way to the papers from it, and forgets it after asking', async () => {
    const state = at('/documents/doc-1');
    const link = await screen.findByRole('link', { name: 'Taxes/2025' });
    expect(link).toHaveAttribute('href', '/documents?source_folder=Taxes%2F2025');
    expect(link.closest('dd')?.previousElementSibling).toHaveTextContent('Came from the folder');
    fireEvent.click(screen.getByRole('button', { name: 'Forget it…' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Forget the folder this came from?',
    });
    expect(dialog).toHaveTextContent('can’t be undone');
    const results = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results.violations.map((v) => v.id)).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Forget it' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Taxes/2025' })).toBeNull());
    expect(state.calls.filter((c) => c.method === 'PATCH').map((c) => [c.url, c.body])).toEqual([
      ['/api/v1/documents/doc-1', { source_folder: null }],
    ]);
  });

  it('tells a viewer nothing of it', async () => {
    at('/documents/doc-1', {}, 'viewer');
    expect(await screen.findByRole('heading', { name: "Mansoor's passport" })).toBeVisible();
    expect(screen.queryByText('Came from the folder')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Forget it…' })).toBeNull();
  });
});

describe('the table', () => {
  it('says it shows the papers from one folder, and takes that away', async () => {
    at('/documents?source_folder=Taxes%2F2025');
    expect(await screen.findByText('From the folder ‘Taxes/2025’')).toBeVisible();
  });
});

describe('Keep this folder tree as my cabinet', () => {
  it('is offered beside my cabinet, looked over, and added beside it after a confirm', async () => {
    const state = at('/documents?show=cabinet');
    const offer = await screen.findByRole('link', { name: 'Keep my folder tree' });
    // Offered from the counts alone: nothing is drawn until it is asked for.
    expect(state.calls.some((c) => c.url.includes('/cabinet/from-folders'))).toBe(false);
    fireEvent.click(offer);
    expect(
      await screen.findByRole('heading', { name: 'Keep this folder tree as my cabinet' }),
    ).toBeVisible();
    const tree = await screen.findByRole('list', { name: 'New in “My folders”' });
    expect(within(tree).getByText('Taxes', { selector: 'strong' })).toBeVisible();
    expect(within(tree).getByText('2025')).toBeVisible();
    expect(
      screen.getByText(/2 new folders, 1 new drawer, in the cabinet “My folders”/),
    ).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Keep this folder tree' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Add 2 folders to your cabinet?',
    });
    expect(dialog).toHaveTextContent('Your other cabinets, drawers and folders stay as they are');
    // Nothing saved until it is confirmed.
    expect(state.cabinetSaves ?? []).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add the folders' }));
    await waitFor(() => expect(state.cabinetSaves).toHaveLength(1));
    const saved = state.cabinetSaves?.[0];
    expect(saved?.version).toBe(1);
    expect(saved?.layout.cabinets[0]).toEqual(LAYOUT.cabinets[0]);
    expect(saved?.layout.cabinets[1]?.name).toBe('My folders');
  });

  it('builds a first cabinet from the tree when there is none, looked over first', async () => {
    const state = at('/documents?show=cabinet', {
      cabinet: { layout: null, version: 0, updated_at: null },
      fromFolders: drawn(null, 0),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Use my folder tree' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Keep this folder tree' }));
    await waitFor(() => expect(state.cabinetSaves).toHaveLength(1));
    expect(state.cabinetSaves?.[0]?.layout.cabinets.map((c) => c.name)).toEqual(['My folders']);
  });

  it('says so when every folder is in the cabinet already, and offers nothing', async () => {
    const kept = drawn(LAYOUT, 1);
    at('/documents?show=cabinet&from=folders', {
      cabinet: { layout: kept.layout, version: 2, updated_at: '2026-11-16T10:00:00Z' },
      fromFolders: drawn(kept.layout, 2),
    });
    expect(
      await screen.findByText('Your cabinet has a folder for each of them already.'),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Keep this folder tree' })).toBeNull();
  });
});
