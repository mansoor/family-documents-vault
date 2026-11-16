import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CabinetLayout } from '@fdv/shared';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { folderLanding, rememberLanding, takeLanding } from './landing.js';
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
 * Where the original is, as a place in my cabinet (0.9.0, C3): set on a
 * document's page and for many in the table, offered after a scan is filed,
 * said with the words written for it, and printed as folder labels whose
 * code opens the folder — after signing in, if need be.
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

/** Study cabinet › Drawer 2 › Identity (the passport's question) and Bank. */
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
            { id: 'f-bank', name: 'Bank', hidden: false, filter: { category: 'financial' } },
          ],
        },
      ],
    },
  ],
};

function at(
  path: string,
  over: Partial<FakeState> = {},
  role: 'owner' | 'viewer' = 'owner',
  state?: unknown,
): FakeState {
  atWidth(1280);
  const fake = fresh({
    members: [ME, AISHA],
    documents: [{ ...PASSPORT }, { ...STATEMENT }],
    cabinets: true,
    originalPlace: true,
    cabinet: { layout: LAYOUT, version: 1, updated_at: '2026-11-16T10:00:00Z' },
    ...over,
  });
  installFakeApi(fake);
  signedIn(role);
  window.history.replaceState(state ?? {}, '', path);
  render(<App />);
  return fake;
}

const patches = (state: FakeState) =>
  state.calls.filter((c) => c.method === 'PATCH').map((c) => [c.url, c.body]);

describe('a document’s page', () => {
  it('says the place, then the words, and the folder is a way there for whoever filed it', async () => {
    at('/documents/doc-1', {
      documents: [
        {
          ...PASSPORT,
          physical_location: 'behind the blue divider',
          original_place: { path: ['Study cabinet', 'Drawer 2', 'Identity'], folder_id: 'f-ids' },
        },
      ],
    });
    const place = await screen.findByRole('link', { name: 'Study cabinet › Drawer 2 › Identity' });
    expect(place).toHaveAttribute('href', '/documents?show=cabinet&folder=f-ids');
    expect(place.closest('dd')).toHaveTextContent(
      'Study cabinet › Drawer 2 › Identity · behind the blue divider',
    );
    expect(screen.getByRole('button', { name: 'Change folder…' })).toBeVisible();
  });

  it('is filed in a folder of my cabinet, its own folders offered first', async () => {
    const state = at('/documents/doc-1');
    fireEvent.click(await screen.findByRole('button', { name: 'File it in my cabinet…' }));
    const sheet = await screen.findByRole('dialog', { name: 'Where the original is filed' });
    const select = await within(sheet).findByRole('combobox', { name: 'Folder' });
    await waitFor(() =>
      expect(
        within(select).getByRole('group', { name: 'Its folders in your cabinet' }),
      ).toBeTruthy(),
    );
    expect(select).toHaveValue('f-ids');
    fireEvent.click(within(sheet).getByRole('button', { name: 'File it here' }));
    expect(
      await screen.findByRole('link', { name: 'Study cabinet › Drawer 2 › Identity' }),
    ).toBeVisible();
    expect(patches(state)).toEqual([
      ['/api/v1/documents/doc-1', { original_place: { folder_id: 'f-ids' } }],
    ]);
    const results = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });

  it('tells a viewer nothing of it, and offers nothing', async () => {
    at(
      '/documents/doc-1',
      {
        documents: [
          {
            ...PASSPORT,
            original_place: { path: ['Study cabinet', 'Drawer 2', 'Identity'], folder_id: null },
          },
        ],
      },
      'viewer',
    );
    expect(await screen.findByRole('heading', { name: "Mansoor's passport" })).toBeVisible();
    expect(screen.queryByText(/Study cabinet/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'File it in my cabinet…' })).toBeNull();
  });
});

describe('File it here, after a scan is filed', () => {
  it('offers the folder its question finds, one tap, and says where it went', async () => {
    // As Add leaves it: the router's state, as it keeps it in the history.
    const state = at('/documents/doc-1', {}, 'owner', {
      usr: { justFiled: true },
      key: 'filed',
      idx: 0,
    });
    const card = await screen.findByRole('region', { name: 'Where will the paper go?' });
    fireEvent.click(
      await within(card).findByRole('button', {
        name: 'File it in Study cabinet › Drawer 2 › Identity',
      }),
    );
    expect(
      await screen.findByText('Filed in Study cabinet › Drawer 2 › Identity.'),
    ).toBeInTheDocument();
    expect(patches(state)).toEqual([
      ['/api/v1/documents/doc-1', { original_place: { folder_id: 'f-ids' } }],
    ]);
  });

  it('is not offered on a page opened any other way', async () => {
    at('/documents/doc-1');
    await screen.findByRole('button', { name: 'File it in my cabinet…' });
    expect(screen.queryByRole('region', { name: 'Where will the paper go?' })).toBeNull();
  });
});

describe('many at once, in the table', () => {
  it('files the chosen in one folder, without words, in one request', async () => {
    const state = at('/documents');
    const t = await screen.findByRole('grid', { name: /^Documents, sorted by/ });
    await waitFor(() => expect(within(t).getAllByRole('row').length).toBeGreaterThan(2));
    fireEvent.click(within(t).getByRole('checkbox', { name: "Select “Mansoor's passport”" }));
    fireEvent.click(
      within(t).getByRole('checkbox', { name: 'Select “Barclays statement, September 2026”' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Set where it’s kept' }));
    const sheet = screen.getByRole('dialog', {
      name: 'Where the paper originals of 2 documents are kept',
    });
    const folder = await within(sheet).findByRole('combobox', { name: 'Folder in my cabinet' });
    fireEvent.change(folder, { target: { value: 'f-bank' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Set for 2 documents' }));
    expect(
      await screen.findByText('2 documents now filed in the folder you chose.'),
    ).toBeInTheDocument();
    expect(state.placeAsks).toEqual([{ document_ids: ['doc-2', 'doc-1'], folder_id: 'f-bank' }]);
    expect(patches(state)).toEqual([]);
  });
});

describe('folder labels', () => {
  it('prints a label for each folder chosen, its name and a code, nothing more', async () => {
    at('/cabinet/labels?folder=f-bank');
    expect(await screen.findByRole('heading', { name: 'Folder labels' })).toBeVisible();
    const preview = await screen.findByRole('region', { name: 'How the labels will look' });
    const codes = within(preview).getAllByRole('img');
    expect(codes.map((c) => c.getAttribute('aria-label'))).toEqual([
      'A code that opens the folder Bank',
    ]);
    expect(preview).toHaveTextContent(/^Bank$/);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Study cabinet › Drawer 2 › Identity' }));
    expect(within(preview).getAllByRole('img')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Print 2 labels' })).toBeEnabled();
  });
});

describe('a label’s code', () => {
  it('opens the folder for whoever is signed in', async () => {
    at('/folder/f-bank');
    await waitFor(() => expect(window.location.search).toBe('?show=cabinet&folder=f-bank'));
    expect(await screen.findByRole('heading', { name: 'Bank' })).toBeVisible();
  });

  it('says so when the folder is not one of theirs', async () => {
    at('/folder/someone-elses');
    expect(
      await screen.findByText(/That folder isn’t in your cabinet: a folder label opens/),
    ).toBeVisible();
  });

  it('remembers where to land for whoever signs in first, once, and only a folder', () => {
    expect(folderLanding('f-bank')).toBe('/documents?show=cabinet&folder=f-bank');
    expect(folderLanding('../settings')).toBe('/documents?show=cabinet');
    rememberLanding('/documents?show=cabinet&folder=f-bank');
    expect(takeLanding()).toBe('/documents?show=cabinet&folder=f-bank');
    expect(takeLanding()).toBeNull();
    rememberLanding('https://elsewhere.example/');
    rememberLanding('/settings/account');
    expect(takeLanding()).toBeNull();
  });
});
