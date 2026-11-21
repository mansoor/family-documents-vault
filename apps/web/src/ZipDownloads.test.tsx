import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import {
  fresh,
  installFakeApi,
  ME,
  PASSPORT,
  signedIn,
  type FakeCollection,
  type FakeState,
} from './test-api.js';

/**
 * Downloading several at once on the web (0.9.0, DL; the owner's asks of 15
 * Nov 2026): Download in the Documents table's bar — one file as itself,
 * several as one ZIP — and on a collection's page, whose top row reads Add
 * documents · Fill from a checklist · Share this collection · Add managers;
 * a Sensitive document among them asks to confirm it's you. And the
 * Documents page's second control — Columns, Arrange my cabinet — sits in
 * one slot in both views.
 */

const CSS = (() => {
  const file = ['src/styles.css', 'apps/web/src/styles.css']
    .map((p) => resolve(process.cwd(), p))
    .find((p) => existsSync(p));
  return file ? readFileSync(file, 'utf8') : '';
})();

/**
 * Each download the page started: a file's name (one saved from the tab),
 * or the address it followed (a ZIP's ticket, saved by the browser to disk).
 */
let saved: string[] = [];

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  saved = [];
  // A wide screen: the Documents table, not the phone's list.
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: /min-width/.test(query),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:zip'), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    saved.push(this.download || (this.getAttribute('href') ?? ''));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const SAM = { ...ME, id: 'm-1', display_name: 'Sam', is_me: false, role: 'adult', colour: 2 };
const DEED = {
  ...PASSPORT,
  id: 'doc-2',
  title: 'House deed',
  latest_version_id: 'v-2',
  etag: '"deed"',
};
const TRIP: FakeCollection = {
  id: 'collection-t',
  name: 'Trip',
  description: null,
  audience: 'everyone',
  owner_member_id: 'me',
  etag: '"trip.1"',
  items: ['doc-1', 'doc-2'],
};

function at(path: string, over: Partial<FakeState> = {}, role: 'owner' | 'adult' = 'owner') {
  const state = fresh({
    documents: [{ ...PASSPORT }, { ...DEED }],
    members: [ME, SAM],
    zipDownload: true,
    ...over,
  });
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

const bar = () => screen.getByRole('region', { name: 'What to do with the chosen documents' });

async function choose(...titles: string[]) {
  const table = await screen.findByRole('grid');
  await waitFor(() => expect(within(table).getAllByRole('row').length).toBeGreaterThan(2));
  for (const t of titles) {
    fireEvent.click(within(table).getByRole('checkbox', { name: `Select “${t}”` }));
  }
}

describe('Download in the Documents table’s bar (DL)', () => {
  it('several: a ticket for one ZIP of those ticked, followed as a link the browser saves to disk', async () => {
    const state = at('/documents');
    await choose("Mansoor's passport", 'House deed');
    const buttons = within(bar())
      .getAllByRole('button')
      .map((b) => b.textContent);
    // Download first, after how many are chosen.
    expect(buttons[0]).toBe('Download');
    fireEvent.click(within(bar()).getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(saved).toEqual(['/api/v1/downloads/ticket-1']));
    expect(state.zipAsks?.map((a) => [a.path, [...(a.document_ids ?? [])].sort()])).toEqual([
      ['/api/v1/documents/download/ticket', ['doc-1', 'doc-2']],
    ]);
  });

  it('one with a file: that file, as its own Download gives it — no ZIP', async () => {
    const state = at('/documents');
    await choose('House deed');
    fireEvent.click(within(bar()).getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).not.toMatch(/\.zip$/);
    expect(state.zipAsks ?? []).toEqual([]);
  });

  it('a Sensitive one among them asks to confirm it’s you, then downloads', async () => {
    const state = at('/documents', { zipSensitive: true, stepUpNeeded: true });
    await choose("Mansoor's passport", 'House deed');
    fireEvent.click(within(bar()).getByRole('button', { name: 'Download' }));
    await screen.findByRole('dialog', { name: 'Just checking it is you' });
    fireEvent.change(screen.getByLabelText('Or your password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(saved).toEqual(['/api/v1/downloads/ticket-1']));
    expect(state.zipAsks).toHaveLength(1);
  });

  it('what the vault refuses is said in the bar, in its words', async () => {
    at('/documents', {
      zipRefuse: {
        status: 422,
        code: 'zip_too_large',
        message:
          'That is more than one download holds (200 documents or 1 GB). To download everything, use Settings → Export.',
      },
    });
    await choose("Mansoor's passport", 'House deed');
    fireEvent.click(within(bar()).getByRole('button', { name: 'Download' }));
    expect(await within(bar()).findByText(/use Settings → Export/)).toBeVisible();
    expect(saved).toEqual([]);
  });

  it('one whose versions cannot be read says so, rather than nothing', async () => {
    at('/documents', {
      refuseWith: (method, path) =>
        method === 'GET' && path === '/api/v1/documents/doc-2/versions'
          ? { status: 404, code: 'not_found', message: 'That document does not exist.' }
          : undefined,
    });
    await choose('House deed');
    fireEvent.click(within(bar()).getByRole('button', { name: 'Download' }));
    expect(await within(bar()).findByText('That document does not exist.')).toBeVisible();
    expect(saved).toEqual([]);
  });

  it('a vault without ZIPs offers Download for one with a file only', async () => {
    at('/documents', { zipDownload: false });
    await choose("Mansoor's passport", 'House deed');
    expect(within(bar()).queryByRole('button', { name: 'Download' })).toBeNull();
  });
});

describe('a collection’s page (DL)', () => {
  it('its top row: Add documents, Fill from a checklist, Share this collection, Add managers — then Download and Print', async () => {
    at('/collections/collection-t', { collections: [{ ...TRIP }] });
    await screen.findByRole('heading', { name: 'Trip', level: 1 });
    const add = await screen.findByRole('button', { name: 'Add documents' });
    const row = add.parentElement as HTMLElement;
    await waitFor(() =>
      expect(within(row).getByRole('button', { name: 'Fill from a checklist' })).toBeVisible(),
    );
    expect(
      within(row)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([
      'Add documents',
      'Fill from a checklist',
      'Share this collection',
      'Add managers',
      'Download',
      'Print',
    ]);
  });

  it('Download: the whole collection as one ZIP; Sensitive asks to confirm it’s you first', async () => {
    const state = at('/collections/collection-t', {
      collections: [{ ...TRIP }],
      zipSensitive: true,
      stepUpNeeded: true,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
    await screen.findByRole('dialog', { name: 'Just checking it is you' });
    fireEvent.change(screen.getByLabelText('Or your password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(saved).toEqual(['/api/v1/downloads/ticket-1']));
    expect(state.zipAsks).toEqual([{ path: '/api/v1/collections/collection-t/download/ticket' }]);
  });

  it('nothing in it to download: said in plain words, and nothing saved', async () => {
    at('/collections/collection-t', {
      collections: [{ ...TRIP }],
      zipRefuse: {
        status: 422,
        code: 'nothing_to_zip',
        message: 'None of these has a file you can download.',
      },
    });
    const download = await screen.findByRole('button', { name: 'Download' });
    expect(download).not.toHaveAttribute('aria-disabled');
    fireEvent.click(download);
    expect(
      await screen.findByText(/Nothing in this collection has a file you can download/),
    ).toBeVisible();
    expect(saved).toEqual([]);
  });

  it('only whoever may choose managers is offered Add managers; nobody is offered Download of an empty one', async () => {
    at(
      '/collections/collection-t',
      {
        collections: [
          {
            ...TRIP,
            items: [],
            owner_member_id: 'm-1',
            managers: [
              {
                member_id: 'me',
                may_change_audience: false,
                may_delete: false,
                may_choose_managers: false,
              },
            ],
          },
        ],
      },
      'adult',
    );
    await screen.findByRole('button', { name: 'Add documents' });
    expect(screen.queryByRole('button', { name: 'Add managers' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
  });
});

describe('the Documents page’s second control (DL)', () => {
  it('Columns in the table and Arrange my cabinet in the cabinet sit in the same slot, right after Table and Cabinet', async () => {
    at('/documents', {
      cabinets: true,
      // An arrangement kept, every cabinet in it hidden: enough to arrange again.
      cabinet: {
        layout: { arranged_by: 'person_category_year', cabinets: [] },
        version: 1,
        updated_at: new Date().toISOString(),
      },
    });
    const tableToggle = await screen.findByRole('group', { name: 'Show documents as' });
    const columns = screen.getByRole('button', { name: 'Columns' });
    const tableSlot = columns.closest('.table-head-tool');
    expect(tableSlot).not.toBeNull();
    expect(tableToggle.nextElementSibling).toBe(tableSlot);
    expect(tableSlot?.parentElement?.className).toBe('table-head');
    // The slot is as wide as the wider control, so neither moves.
    expect(CSS).toMatch(/\.table-head-tool\s*\{[^}]*min-width:\s*11\.5rem/);

    // The cabinet: the same slot, right after the same toggle, holds Arrange my cabinet.
    fireEvent.click(within(tableToggle).getByRole('button', { name: 'Cabinet' }));
    const cabinetToggle = await screen.findByRole('group', { name: 'Show documents as' });
    await waitFor(() =>
      expect(
        within(cabinetToggle).getByRole('button', { name: 'Cabinet', pressed: true }),
      ).toBeVisible(),
    );
    const arrange = await waitFor(() => {
      const found = screen
        .getAllByRole('button', { name: 'Arrange my cabinet' })
        .find((b) => b.closest('.table-head-tool'));
      expect(found).toBeDefined();
      return found as HTMLElement;
    });
    const cabinetSlot = arrange.closest('.table-head-tool');
    expect(cabinetToggle.nextElementSibling).toBe(cabinetSlot);
    expect(cabinetSlot?.parentElement?.className).toBe('table-head');
    expect(arrange.className).toBe(columns.className);
  });
});
