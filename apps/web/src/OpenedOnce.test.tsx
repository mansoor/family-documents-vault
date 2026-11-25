import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { fresh, installFakeApi, ME, PASSPORT, signedIn, type FakeState } from './test-api.js';

/**
 * What Home's Opened is told (0.9.0-dev.102): only an open the person
 * started — a document opened beside the list, or its page arrived at —
 * and never again as the same thing is drawn again by itself: a reload, the
 * documents beside the list put back from this tab, everything drawn again
 * after an unlock, Open as a page of one just opened beside the list, or
 * the page of one just filed through Add.
 */

const WIDE = 1280;
function atWidth(px: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: px });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const minWidth = /\(min-width:\s*(\d+)px\)/.exec(query);
      const minHeight = /\(min-height:\s*(\d+)px\)/.exec(query);
      return {
        matches:
          (!minWidth || px >= Number(minWidth[1])) &&
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

const innerWidthWas = Object.getOwnPropertyDescriptor(window, 'innerWidth');
let made = 0;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, '', '/');
  made = 0;
  Object.assign(URL, {
    createObjectURL: vi.fn(() => `blob:page-${++made}`),
    revokeObjectURL: vi.fn(),
  });
});
afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia');
  if (innerWidthWas) Object.defineProperty(window, 'innerWidth', innerWidthWas);
  vi.restoreAllMocks();
});

const doc = (n: number) => ({
  ...PASSPORT,
  id: `doc-${n}`,
  title: `Paper ${String(n).padStart(2, '0')}`,
  latest_version_id: `v-${n}`,
  is_essential: false,
  tags: [],
  etag: `"${n}"`,
});

function at(path: string, over: Partial<FakeState> = {}, state?: FakeState): FakeState {
  atWidth(WIDE);
  const s =
    state ??
    fresh({
      members: [ME],
      documents: [doc(1), doc(2)],
      collections: [],
      sessionLock: true,
      ...over,
    });
  installFakeApi(s);
  signedIn('owner');
  if (!state) window.history.replaceState({}, '', path);
  render(<App />);
  return s;
}

/** The opens told to the vault, by document. */
const told = (s: FakeState) =>
  s.calls
    .filter((c) => c.method === 'POST' && c.url === '/api/v1/me/recently-opened')
    .map((c) => (c.body as { document_id: string }).document_id);

/** Drawn afresh as a reload draws it: the same address, history entry and tab storage. */
function reload(s: FakeState) {
  cleanup();
  at(window.location.pathname, {}, s);
}

async function openBeside(n: number) {
  const name = `Paper ${String(n).padStart(2, '0')}`;
  const grid = await screen.findByRole('grid', { name: /^Documents, sorted by/ });
  const link = await within(grid).findByRole('link', { name });
  act(() => link.focus());
  fireEvent.click(link);
  return screen.findByRole('dialog', { name });
}

describe('what Opened is told', () => {
  it('a document opened beside the list is told once, and not again when a reload puts it back', async () => {
    const s = at('/documents');
    await openBeside(1);
    await waitFor(() => expect(told(s)).toEqual(['doc-1']));
    reload(s);
    expect(await screen.findByRole('dialog', { name: 'Paper 01' })).toBeVisible();
    // Loaded again, drawn again: not opened again.
    await waitFor(() =>
      expect(
        s.calls.filter((c) => c.method === 'GET' && c.url === '/api/v1/documents/doc-1').length,
      ).toBeGreaterThan(1),
    );
    expect(told(s)).toEqual(['doc-1']);
    // Opened again by the person: told again.
    await openBeside(2);
    await waitFor(() => expect(told(s)).toEqual(['doc-1', 'doc-2']));
  });

  it('everything drawn again after an unlock tells nothing', async () => {
    const s = at('/documents');
    await openBeside(1);
    await waitFor(() => expect(told(s)).toEqual(['doc-1']));
    fireEvent.click(screen.getByRole('button', { name: 'Lock' }));
    await screen.findByRole('heading', { level: 1, name: 'The vault is locked' });
    fireEvent.change(screen.getByLabelText('Your password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByRole('dialog', { name: 'Paper 01' })).toBeVisible();
    await screen.findByRole('grid', { name: /^Documents, sorted by/ });
    expect(told(s)).toEqual(['doc-1']);
  });

  it('a document’s page is told once for each arrival: not again on a reload', async () => {
    const s = at('/documents/doc-2');
    await screen.findByRole('heading', { level: 1, name: 'Paper 02' });
    await waitFor(() => expect(told(s)).toEqual(['doc-2']));
    reload(s);
    await screen.findByRole('heading', { level: 1, name: 'Paper 02' });
    await waitFor(() =>
      expect(
        s.calls.filter((c) => c.method === 'GET' && c.url === '/api/v1/documents/doc-2').length,
      ).toBe(2),
    );
    expect(told(s)).toEqual(['doc-2']);
  });

  it('the page of a document just filed through Add tells nothing: it was added, not opened', async () => {
    const s = fresh({ members: [ME], documents: [doc(1)], collections: [] });
    window.history.replaceState(
      { usr: { justFiled: true }, key: 'filed', idx: 0 },
      '',
      '/documents/doc-1',
    );
    at('/documents/doc-1', {}, s);
    await screen.findByRole('heading', { level: 1, name: 'Paper 01' });
    await waitFor(() =>
      expect(s.calls.some((c) => c.url === '/api/v1/documents/doc-1/versions')).toBe(true),
    );
    expect(told(s)).toEqual([]);
  });

  it('Open as a page of one opened beside the list tells nothing more', async () => {
    const s = at('/documents');
    const beside = await openBeside(1);
    await waitFor(() => expect(told(s)).toEqual(['doc-1']));
    fireEvent.click(within(beside).getByRole('link', { name: 'Open as a page' }));
    await screen.findByRole('heading', { level: 1, name: 'Paper 01' });
    await waitFor(() => expect(window.location.pathname).toBe('/documents/doc-1'));
    await waitFor(() =>
      expect(
        s.calls.filter((c) => c.method === 'GET' && c.url === '/api/v1/documents/doc-1').length,
      ).toBeGreaterThan(1),
    );
    expect(told(s)).toEqual(['doc-1']);
  });
});
