import { NOTE_KIND } from '@fdv/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { useState } from 'react';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from './app-context.js';
import { flyoutDetailsWidthKey, TWO_PANES_FROM } from './doc-panes.js';
import { DocumentView, type DocumentViewClosed } from './screens/Document.js';
import { fresh, installFakeApi, ME, PASSPORT, signedIn, type FakeState } from './test-api.js';

/**
 * A document's view beside the list (flyouts), before anything opens it
 * there: the same view as its page, hosted by something that is not its
 * page. It never reads or changes the address — the version looked at is
 * its own, the Trash and a note are told to its host — and its own width,
 * not the window's, decides its panes, the details width kept apart from
 * the page's.
 */

/** What the address was each time the page under it drew: it must never move. */
let seen: string[] = [];
function AddressProbe() {
  const at = useLocation();
  seen.push(`${at.key}|${at.pathname}${at.search}${at.hash}`);
  return null;
}

let closedWith: DocumentViewClosed[] = [];
/**
 * Set by the host's button: both panes, or its pages alone. A row in the
 * list under it opens another document in the same place.
 */
function Host(props: { id: string }) {
  const [view, setView] = useState<'both' | 'content'>('both');
  const [id, setId] = useState(props.id);
  return (
    <>
      <AddressProbe />
      <main>
        <p>The list under it</p>
        {['doc-1', 'doc-2', 'doc-l'].map((other) => (
          <button key={other} type="button" onClick={() => setId(other)}>
            Open {other}
          </button>
        ))}
      </main>
      {/* Where its host will put it: beside the list. */}
      <aside aria-label="Beside the list">
        <DocumentView
          id={id}
          host="flyout"
          view={view}
          onClosed={(why) => closedWith.push(why)}
          tools={
            <button
              type="button"
              onClick={() => setView((v) => (v === 'both' ? 'content' : 'both'))}
            >
              {view === 'both' ? 'Hide details' : 'Show details'}
            </button>
          }
        />
      </aside>
    </>
  );
}

function open(state: FakeState, id = 'doc-1', path = '/documents', then?: () => void) {
  installFakeApi(state);
  then?.();
  signedIn('owner');
  window.history.replaceState({}, '', path);
  render(
    <AppProvider>
      <BrowserRouter>
        <Routes>
          <Route path="*" element={<Host id={id} />} />
        </Routes>
      </BrowserRouter>
    </AppProvider>,
  );
}

/** The address never moved: one history entry, as it was. */
function addressKept(path = '/documents') {
  expect(window.location.pathname + window.location.search + window.location.hash).toBe(path);
  expect(new Set(seen).size).toBe(1);
}

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

/** Its own width, as a browser lays it out; null: none (jsdom's 0). */
let fitWidth = 0;
const observers: { cb: ResizeObserverCallback; els: Element[] }[] = [];
class FakeResizeObserver {
  cb: ResizeObserverCallback;
  els: Element[] = [];
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
    observers.push(this);
  }
  observe(el: Element) {
    this.els.push(el);
  }
  unobserve() {}
  disconnect() {
    this.els = [];
  }
}
/** The flyout made this wide: its observer told, as a browser tells it. */
function resizeTo(px: number) {
  fitWidth = px;
  act(() => {
    for (const o of observers)
      if (o.els.some((e) => e.classList.contains('doc-fit')))
        o.cb([], o as unknown as ResizeObserver);
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  seen = [];
  closedWith = [];
  fitWidth = 0;
  observers.length = 0;
  Object.assign(URL, {
    createObjectURL: vi.fn(() => 'blob:page'),
    revokeObjectURL: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('doc-fit') ? fitWidth : 0;
    },
  });
});
afterEach(() => {
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Another document, for the same place. */
const COUNCIL_TAX = {
  ...PASSPORT,
  id: 'doc-2',
  title: 'Council tax bill',
  latest_version_id: 'v-ct',
};
const LICENCE = {
  ...PASSPORT,
  id: 'doc-l',
  title: 'Aisha’s licence',
  versions: 2,
  latest_version_id: 'v-2',
  etag: '"l-1"',
};
/** The licence's version 1, as it was when version 2 replaced it. */
const OLDER = {
  id: 'v-1',
  document_id: 'doc-l',
  version_no: 1,
  filename: 'licence-2015.pdf',
  mime: 'application/pdf',
  byte_size: 2048,
  sha256: 'o',
  page_count: 1,
  ocr_status: 'done',
  uploaded_at: '2015-03-02T09:00:00Z',
  uploaded_by_name: 'Mansoor Seikh',
  preview_pages: 1,
  file_removed: false,
  details: {
    issued: { date: '2015-03-01', precision: 'day' },
    expires: { date: '2025-03-01', precision: 'day' },
    identifier: 'KHAN9-123',
    issued_by: 'DVLA',
    extra: {},
    kept_at: '2026-11-06T10:00:00Z',
  },
  details_kept: true,
  details_unconfirmed: false,
};

const details = () => screen.findByRole('region', { name: "Details of Mansoor's passport" });
const pages = () => screen.findByRole('region', { name: "Pages of Mansoor's passport" });
const fit = () => document.querySelector('.doc-fit') as HTMLElement;

describe('a document beside the list: the same view, another host', () => {
  it('its name as a heading, Edit as a page, its details and pages — and no page of its own', async () => {
    const state = fresh({ members: [ME], documents: [{ ...PASSPORT }] });
    open(state);
    expect(
      await screen.findByRole('heading', { level: 2, name: "Mansoor's passport" }),
    ).toHaveAttribute('tabindex', '-1');
    await details();
    await pages();
    expect(screen.getByRole('link', { name: 'Edit' })).toHaveAttribute(
      'href',
      '/documents/doc-1/confirm',
    );
    // The page under it is the list's: no main of its own, no bar, no Back.
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getByRole('complementary').querySelector('main')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Back' })).not.toBeInTheDocument();
    // Its details carry their own id, not the page's.
    expect(document.getElementById('doc-details')).toBeNull();
    // Fetched once, as its page fetches it: one look, one line in the log.
    await waitFor(() => expect(screen.getByText('Download')).toBeInTheDocument());
    expect(
      state.calls.filter((c) => c.method === 'GET' && /\/documents\/doc-1$/.test(c.url)),
    ).toHaveLength(1);
    addressKept();
    await expectAccessible();
  });

  it('its pages turn with the scroll wheel and the arrows, as on its page, and the address stays', async () => {
    open(fresh({ members: [ME], documents: [{ ...PASSPORT }] }));
    const right = await pages();
    await within(right).findByRole('img', { name: 'Page 1 of 2' });
    fireEvent.click(within(right).getByRole('button', { name: 'Fit page' }));
    const viewer = within(right).getByRole('group', { name: /^Page 1 of 2/ });
    expect(fireEvent.wheel(viewer, { deltaY: 100 })).toBe(false); // used: not the browser's
    expect(await within(right).findByRole('img', { name: 'Page 2 of 2' })).toBeInTheDocument();
    fireEvent.keyDown(viewer, { key: 'ArrowLeft' });
    expect(await within(right).findByRole('img', { name: 'Page 1 of 2' })).toBeInTheDocument();
    addressKept();
  });

  it('an older version looked at is its own: the address is never changed', async () => {
    const state = fresh({
      members: [ME],
      documents: [{ ...LICENCE }],
      olderVersions: { 'doc-l': [{ ...OLDER }] },
    });
    open(state, 'doc-l', '/documents?sort=title');
    fireEvent.click(await screen.findByRole('button', { name: /^History/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'View version 1' }));
    await screen.findByRole('heading', { name: /^Version 1 of 2: .* not the current version$/ });
    await screen.findByRole('region', { name: 'Pages of Aisha’s licence, version 1' });
    // Edit is the current version's: none while an older one is shown.
    expect(screen.queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument();
    addressKept('/documents?sort=title');

    // Back to the current version: held here too.
    fireEvent.click(screen.getByRole('button', { name: /^Back to the current version/ }));
    await screen.findByRole('region', { name: 'Pages of Aisha’s licence' });
    expect(await screen.findByRole('link', { name: 'Edit' })).toBeInTheDocument();
    addressKept('/documents?sort=title');
  });

  it('moving it to the Trash tells its host, with what to say, and goes nowhere', async () => {
    const state = fresh({ members: [ME], documents: [{ ...PASSPORT }] });
    open(state);
    await details();
    fireEvent.click(await screen.findByRole('button', { name: 'Move to the Trash' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Move to the Trash?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move to the Trash' }));
    await waitFor(() =>
      expect(closedWith).toEqual([
        {
          reason: 'trashed',
          said: "“Mansoor's passport” moved to the Trash. You can bring it back from there.",
        },
      ]),
    );
    expect(
      state.calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/documents/doc-1')),
    ).toBe(true);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByText('The list under it')).toBeInTheDocument();
    addressKept();
  });

  it('a note tells its host, once, rather than going to Notes', async () => {
    const state = fresh({
      members: [ME],
      documents: [{ ...PASSPORT, id: 'note-1', type_key: NOTE_KIND, title: 'Wi-Fi' }],
    });
    open(state, 'note-1');
    await waitFor(() => expect(closedWith).toEqual([{ reason: 'note', noteId: 'note-1' }]));
    expect(screen.queryByRole('region', { name: /^Details of/ })).not.toBeInTheDocument();
    addressKept();
  });

  it('a link to a section in the address is the page under it’s, not this view’s', async () => {
    const state = fresh({ members: [ME], documents: [{ ...PASSPORT }] });
    open(state, 'doc-1', '/documents#share');
    await details();
    await waitFor(() => expect(screen.getByText('Download')).toBeInTheDocument());
    expect(
      screen.queryByRole('heading', { name: 'Send this to someone outside the family' }),
    ).not.toBeInTheDocument();
    addressKept('/documents#share');
  });

  it('a link’s Change comes back to the document’s own page, its Share panel open', async () => {
    const made = Date.now() - 864e5;
    const state = fresh({
      members: [ME],
      documents: [{ ...PASSPORT }],
      shares: [
        {
          id: 'sh-mine',
          document_id: PASSPORT.id,
          document_title: "Mansoor's passport",
          collection_id: null,
          collection_name: null,
          recipient_label: 'the visa agent',
          created_by_name: 'Mansoor Seikh',
          created_at: new Date(made).toISOString(),
          expires_at: new Date(made + 7 * 864e5).toISOString(),
          has_pin: true,
          open_count: 0,
          last_opened_at: null,
          state: 'active',
          flow: 'v2',
          permission: 'download',
          max_opens: 5,
          protection: ['pin'],
          revealable: true,
          changeable: true,
          latest_end: new Date(made + 90 * 864e5).toISOString(),
          show_title: null,
          version: 1,
          summary: 'Shared with the visa agent, not opened yet.',
        },
      ],
    });
    open(state, 'doc-1', '/documents?sort=title');
    fireEvent.click(await screen.findByRole('button', { name: 'Share a link' }));
    const listed = await screen.findByRole('list', { name: 'Its links that work now' });
    addressKept('/documents?sort=title');
    fireEvent.click(
      within(listed).getByRole('link', {
        name: `Change the link to “Mansoor's passport”, shared with the visa agent`,
      }),
    );
    // Change is a page; back from it is the document's, not the list's.
    await waitFor(() => expect(window.location.pathname).toBe('/sharing/links/sh-mine'));
    expect((window.history.state as { usr?: { back?: string } } | null)?.usr?.back).toBe(
      '/documents/doc-1#share',
    );
  });

  it('a document that cannot be loaded still has its host’s buttons', async () => {
    const state = fresh({ members: [ME], documents: [{ ...PASSPORT }] });
    open(state, 'doc-gone');
    expect(await screen.findByRole('heading', { level: 2, name: 'Document' })).toBeInTheDocument();
    await waitFor(() =>
      expect(within(screen.getByRole('complementary')).getByRole('alert')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Hide details' })).toBeInTheDocument();
    // While loading too, before anything is known.
    addressKept();
  });
});

describe('another document in the same place starts afresh', () => {
  it('an open Trash question goes with its document, and never closes the next', async () => {
    const state = fresh({ members: [ME], documents: [{ ...PASSPORT }, { ...COUNCIL_TAX }] });
    open(state);
    await details();
    fireEvent.click(await screen.findByRole('button', { name: 'Move to the Trash' }));
    await screen.findByRole('alertdialog', { name: 'Move to the Trash?' });
    fireEvent.click(screen.getByRole('button', { name: 'Open doc-2' }));
    await screen.findByRole('region', { name: 'Details of Council tax bill' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(closedWith).toEqual([]);
    expect(state.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('an older version looked at is that document’s alone', async () => {
    const state = fresh({
      members: [ME],
      documents: [{ ...LICENCE }, { ...PASSPORT }],
      olderVersions: { 'doc-l': [{ ...OLDER }] },
    });
    open(state, 'doc-l');
    fireEvent.click(await screen.findByRole('button', { name: /^History/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'View version 1' }));
    await screen.findByRole('region', { name: 'Pages of Aisha’s licence, version 1' });
    fireEvent.click(screen.getByRole('button', { name: 'Open doc-1' }));
    await details();
    fireEvent.click(screen.getByRole('button', { name: 'Open doc-l' }));
    await screen.findByRole('region', { name: 'Pages of Aisha’s licence' });
    expect(screen.queryByRole('heading', { name: /^Version 1 of 2/ })).not.toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Edit' })).toBeInTheDocument();
    addressKept();
  });

  it('a late answer for the document before is never shown', async () => {
    const state = fresh({ members: [ME], documents: [{ ...PASSPORT }, { ...COUNCIL_TAX }] });
    // The first document's answer held back until the next is shown.
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    open(state, 'doc-1', '/documents', () => {
      const fake = globalThis.fetch;
      vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        return /\/documents\/doc-1$/.test(url)
          ? held.then(() => fake(input, init))
          : fake(input, init);
      });
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Open doc-2' }));
    await screen.findByRole('region', { name: 'Details of Council tax bill' });
    await act(async () => {
      release();
      await held;
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.queryByRole('region', { name: "Details of Mansoor's passport" })).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Council tax bill' })).toBeInTheDocument();
  });
});

describe('Hide details: its pages alone (view "content")', () => {
  it('the pages across the whole width, the details kept but hidden, and shown again as they were', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    fitWidth = 1000;
    const state = fresh({ members: [ME], documents: [{ ...PASSPORT }] });
    open(state);
    const before = await details();
    await pages();
    fireEvent.click(screen.getByRole('button', { name: 'Hide details' }));
    expect(fit()).toHaveClass('doc-fit-content');
    expect(screen.queryByRole('region', { name: "Details of Mansoor's passport" })).toBeNull();
    expect(
      screen.queryByRole('separator', { name: 'Width of the details' }),
    ).not.toBeInTheDocument();
    expect(await pages()).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Show details' }));
    // The same pane, never drawn again.
    expect(await details()).toBe(before);
    expect(fit()).toHaveClass('doc-fit-two');
    addressKept();
  });
});

describe('its own width decides its panes, never the window’s', () => {
  it(`two panes from ${TWO_PANES_FROM} px, one column below it — as it is resized`, async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    fitWidth = 900;
    const state = fresh({ members: [ME], documents: [{ ...PASSPORT }] });
    open(state);
    const pane = await details();
    const bar = await screen.findByRole('separator', { name: 'Width of the details' });
    expect(bar).toHaveAttribute('aria-controls', pane.id);
    expect(fit()).toHaveClass('doc-fit-two');
    // 40% of its own 900 px, as the page starts it at that width.
    expect(bar).toHaveAttribute('aria-valuenow', '360');
    expect(fit().style.getPropertyValue('--doc-details-w')).toBe('360px');

    resizeTo(TWO_PANES_FROM - 1);
    expect(fit()).toHaveClass('doc-fit-one');
    expect(
      screen.queryByRole('separator', { name: 'Width of the details' }),
    ).not.toBeInTheDocument();
    // The details first, the pages under them.
    const [first, last] = [await details(), await pages()];
    expect(first.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    resizeTo(TWO_PANES_FROM);
    expect(fit()).toHaveClass('doc-fit-two');
    expect(await screen.findByRole('separator', { name: 'Width of the details' })).toBeVisible();
  });

  it('not yet measured (no layout): one column', async () => {
    const state = fresh({ members: [ME], documents: [{ ...PASSPORT }] });
    open(state);
    await details();
    expect(fit()).toHaveClass('doc-fit-one');
    expect(
      screen.queryByRole('separator', { name: 'Width of the details' }),
    ).not.toBeInTheDocument();
  });

  it('its details width is kept under its own key: the page’s is neither read nor changed', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const PAGE_KEY = 'fdv.document.details-width.me';
    localStorage.setItem(PAGE_KEY, '600');
    fitWidth = 1000;
    const state = fresh({ members: [ME], documents: [{ ...PASSPORT }] });
    open(state);
    const bar = await screen.findByRole('separator', { name: 'Width of the details' });
    // Where it starts at 1000 px, not the page's 600.
    expect(bar).toHaveAttribute('aria-valuenow', '400');
    fireEvent.keyDown(bar, { key: 'ArrowRight', shiftKey: true });
    expect(bar).toHaveAttribute('aria-valuenow', '464');
    expect(localStorage.getItem(flyoutDetailsWidthKey('me'))).toBe('464');
    expect(localStorage.getItem(PAGE_KEY)).toBe('600');
  });
});
