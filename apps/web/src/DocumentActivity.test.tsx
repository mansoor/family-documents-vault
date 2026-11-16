import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { fresh, installFakeApi, PASSPORT, signedIn, type FakeState } from './test-api.js';

/**
 * One document's activity (0.9.0, DA; the owner's ask of 16 Nov 2026): an
 * Activity button on a document's page, for whoever reads the activity log,
 * opens the Activity page with that document's lines alone, said by a chip
 * whose × shows the whole log again. Without the vault's say-so, nothing
 * changes.
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
      return {
        matches: Boolean(minWidth) && width >= Number(minWidth?.[1]),
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
  atWidth(1280);
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'matchMedia');
  vi.restoreAllMocks();
});

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

const line = (id: number, text: string, documentId: string | null = null) => ({
  id,
  at: `2026-11-${String(id).padStart(2, '0')}T12:00:00Z`,
  text,
  notable: false,
  document_id: documentId,
  actor_member_id: null,
  kind: 'opened' as never,
});
const WHOLE = [
  line(9, 'Sara downloaded “Water bill”', 'doc-9'),
  line(8, "Shared link (the embassy) opened “Mansoor's passport”", 'doc-1'),
  line(7, 'Owner signed in'),
  line(6, 'Shared link (the travel agent) opened the collection “Travel”'),
  line(5, "Owner made a link to “Mansoor's passport” for the embassy", 'doc-1'),
];
const ABOUT = [WHOLE[1], WHOLE[3], WHOLE[4]] as FakeState['activity'];
const CHIP = "About ‘Mansoor's passport’";

function open(path: string, over: Partial<FakeState>, role: Role = 'owner', capable = true) {
  const state = fresh({
    activity: WHOLE,
    ...(capable ? { documentActivity: { 'doc-1': ABOUT } } : {}),
    ...over,
  });
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

const shownLines = () =>
  within(screen.getByRole('table', { name: /What has been happening/ }))
    .getAllByRole('row')
    .slice(1)
    .map((r) => r.querySelectorAll('td')[2]?.textContent ?? r.textContent);

describe("a document's Activity button", () => {
  it('is in its row of actions for whoever reads the log, and opens its lines alone', async () => {
    const state = open('/documents/doc-1', {});
    const row = await screen.findByRole('toolbar', { name: 'Document actions' });
    const button = within(row).getByRole('link', { name: 'Activity' });
    expect(button).toHaveAttribute('href', '/activity?document=doc-1');
    // One of the toolbar's stops: reached with the arrow keys, as the rest.
    fireEvent.keyDown(within(row).getByRole('button', { name: /^History/ }), {
      key: 'End',
    });
    expect(document.activeElement).toBe(within(row).getByRole('button', { name: /Trash/ }));
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(button);

    fireEvent.click(button);
    expect(await screen.findByText(CHIP)).toBeVisible();
    await waitFor(() => expect(shownLines()).toEqual(ABOUT.map((l) => l.text)));
    expect(window.location.search).toBe('?document=doc-1');
    expect(state.calls.some((c) => c.url.includes('/api/v1/documents/doc-1/activity'))).toBe(true);
    await expectAccessible();
  });

  it('is there for a teen too, and never for a viewer', async () => {
    open('/documents/doc-1', {}, 'teen');
    const row = await screen.findByRole('toolbar', { name: 'Document actions' });
    expect(within(row).getByRole('link', { name: 'Activity' })).toBeVisible();
    cleanup();
    open('/documents/doc-1', {}, 'viewer');
    await screen.findByRole('heading', { name: "Mansoor's passport" });
    expect(screen.queryByRole('link', { name: 'Activity' })).toBeNull();
  });

  it('is not offered by a vault that does not say it can', async () => {
    open('/documents/doc-1', {}, 'owner', false);
    const row = await screen.findByRole('toolbar', { name: 'Document actions' });
    expect(within(row).queryByRole('link', { name: 'Activity' })).toBeNull();
  });
});

describe('the Activity page for one document', () => {
  it('names it in a chip whose × shows the whole log again', async () => {
    open('/activity?document=doc-1&kind=opened', {});
    const remove = await screen.findByRole('button', { name: `Take off the filter ${CHIP}` });
    await waitFor(() => expect(shownLines()).toEqual(ABOUT.map((l) => l.text)));
    expect(
      screen.getByRole('table', {
        name: "What has been happening, about ‘Mansoor's passport’, newest first",
      }),
    ).toBeInTheDocument();
    // Clear filters keeps the document: it has its own ×.
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(window.location.search).toBe('?document=doc-1'));
    expect(screen.getByText(CHIP)).toBeVisible();

    fireEvent.click(remove);
    await waitFor(() => expect(shownLines()).toEqual(WHOLE.map((l) => l.text)));
    expect(window.location.search).toBe('');
    expect(screen.queryByText(CHIP)).toBeNull();
    // The focus stays where the chip was: among the filters.
    expect(document.activeElement).toBe(screen.getByRole('group', { name: 'Filters' }));
    expect(
      screen.getByRole('table', { name: 'What has been happening, newest first' }),
    ).toBeInTheDocument();
  });

  it('says so plainly when nothing is about it, on a phone too', async () => {
    open('/activity?document=doc-1', { documentActivity: { 'doc-1': [] } });
    expect(
      await screen.findByText('Nothing in the activity log is about this document yet.'),
    ).toBeVisible();
    expect(screen.getByText(CHIP)).toBeVisible();
    await expectAccessible();
    cleanup();
    atWidth(320);
    open('/activity?document=doc-1', { documentActivity: { 'doc-1': [] } });
    expect(
      await screen.findByText('Nothing in the activity log is about this document yet.'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: `Take off the filter ${CHIP}` })).toBeVisible();
  });

  it('shows older lines of that document alone', async () => {
    const state = open('/activity?document=doc-1', { activityPage: 2 });
    await waitFor(() => expect(shownLines()).toEqual(ABOUT.slice(0, 2).map((l) => l.text)));
    fireEvent.click(screen.getByRole('button', { name: 'Show older' }));
    await waitFor(() => expect(shownLines()).toEqual(ABOUT.map((l) => l.text)));
    expect(screen.queryByRole('button', { name: 'Show older' })).toBeNull();
    expect(
      state.calls.some((c) => c.url.includes('/api/v1/documents/doc-1/activity?before=6')),
    ).toBe(true);
    expect(state.calls.some((c) => c.url.startsWith('/api/v1/audit'))).toBe(false);
  });

  it('never names a sensitive document', async () => {
    open('/activity?document=doc-1', {
      documents: [{ ...PASSPORT, sensitive_effective: true }] as never,
    });
    expect(await screen.findByText('About a sensitive document')).toBeVisible();
    expect(screen.queryByText(CHIP)).toBeNull();
  });

  it('is the whole log, as before, on a vault that cannot', async () => {
    open('/activity?document=doc-1', {}, 'owner', false);
    await waitFor(() => expect(shownLines()).toEqual(WHOLE.map((l) => l.text)));
    expect(screen.queryByText(CHIP)).toBeNull();
  });
});
