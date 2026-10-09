import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import {
  AISHA,
  fresh,
  installFakeApi,
  ME,
  PASSPORT,
  signedIn,
  type FakeState,
} from './test-api.js';

/**
 * A document in two panes (Phase 6, R3): from 768 px its details on the
 * left — the facts, notes, versions, collections, sharing and what may be
 * done with it — and its pages on the right, in the viewer the review
 * queue's file uses (page-viewer.tsx). On a phone, one column: the details
 * first, then today's preview. Nothing anybody may see or do changes.
 */

type Who = 'owner' | 'adult' | 'teen' | 'viewer' | 'restricted' | 'guest';
const PHONE = 320;
const MID = 900;
const WIDE = 1280;

function atWidth(px: number, tall = 900) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const minWidth = /\(min-width:\s*(\d+)px\)/.exec(query);
      const minHeight = /\(min-height:\s*(\d+)px\)/.exec(query);
      return {
        matches:
          (!minWidth || px >= Number(minWidth[1])) &&
          (!minHeight || tall >= Number(minHeight[1])) &&
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

/** How many pictures of pages were made: one for each page that came. */
let made = 0;
beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  // jsdom has no object URLs; a page's is its number.
  made = 0;
  Object.assign(URL, {
    createObjectURL: vi.fn(() => `blob:page-${++made}`),
    revokeObjectURL: vi.fn(),
  });
});
afterEach(() => {
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

const RESTRICTION = {
  summary: 'You can see: Mansoor’s documents.',
  people: [],
  types: [],
  collections: [],
  include_adults_only: false,
  include_no_person_docs: false,
  expires_at: null,
};
const TRAVEL = {
  id: 'col-travel',
  name: 'Travel papers',
  description: null,
  audience: 'everyone' as const,
  owner_member_id: 'me',
  etag: '"t.1"',
  items: ['doc-1'],
};

/** The app at this address, at this width, signed in as this person. */
function at(
  path: string,
  px: number,
  who: Who = 'owner',
  over: Partial<FakeState> = {},
): FakeState {
  atWidth(px);
  const role = who === 'restricted' || who === 'guest' ? 'viewer' : who;
  const state = fresh({
    members: [
      {
        ...ME,
        role,
        ...(who === 'guest' ? { kind: 'guest' } : {}),
      },
      AISHA,
    ],
    documents: [{ ...PASSPORT, notes: 'Renewal form is in the blue folder.' }],
    collections: [{ ...TRAVEL, items: [...TRAVEL.items] }],
    ...(who === 'restricted' || who === 'guest' ? { myRestriction: RESTRICTION } : {}),
    ...(who === 'guest' ? { myKind: 'guest' } : {}),
    ...over,
  });
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

const details = () => screen.findByRole('region', { name: "Details of Mansoor's passport" });
const pages = () => screen.findByRole('region', { name: "Pages of Mansoor's passport" });
const pageCalls = (state: FakeState) =>
  state.calls.filter((c) => /\/pages\/\d+$/.test(c.url)).map((c) => c.url.split('/').pop());

/**
 * Everything the details offer and say, in order: headings, controls, and
 * the facts' names — not the pages, which a phone keeps among them.
 */
function inventory(region: HTMLElement): string[] {
  return [...region.querySelectorAll('h2, button, a[href], label.btn, dt')]
    .filter((e) => !e.closest('.doc-pages'))
    .map(
      (e) =>
        `${e.tagName.toLowerCase()}: ${(e.getAttribute('aria-label') ?? e.textContent ?? '').trim()}`,
    );
}

describe('a document in two panes (R3)', () => {
  it('at 1280 px: the details on the left and the pages on the right, each a named region, the details first', async () => {
    const state = at('/documents/doc-1', WIDE);
    const left = await details();
    const right = await pages();
    expect(left.closest('main')).toHaveClass('doc-panes');
    // In the DOM, and so for Tab and a screen reader: the details, then the pages.
    expect(left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The first page is shown on arrival, in the shared viewer.
    expect(await within(right).findByRole('img', { name: 'Page 1 of 2' })).toBeInTheDocument();
    expect(within(right).getByRole('group', { name: /^Page 1 of 2/ })).toHaveAttribute(
      'tabindex',
      '0',
    );
    expect(within(right).getByRole('button', { name: 'Fit to width' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Today's reader, at the page shown.
    expect(within(right).getByRole('link', { name: 'Read it full size' })).toHaveAttribute(
      'href',
      '/documents/doc-1/read?v=v-1&p=1',
    );
    // The details hold what the page held: Download among them, not in the pages.
    expect(within(left).getByRole('button', { name: 'Download' })).toBeInTheDocument();
    expect(within(right).queryByRole('button', { name: 'Download' })).not.toBeInTheDocument();
    expect(pageCalls(state)).toEqual(['1']);
    await expectAccessible();
  });

  it('at 900 px: two panes still, the pages beside the details', async () => {
    at('/documents/doc-1', MID);
    const left = await details();
    expect(left.closest('main')).toHaveClass('doc-panes');
    expect(
      await within(await pages()).findByRole('img', { name: 'Page 1 of 2' }),
    ).toBeInTheDocument();
  });

  it('at 320 px: one column, the facts first, then today’s preview, then the rest; no page is fetched', async () => {
    const state = at('/documents/doc-1', PHONE);
    const left = await details();
    const right = await pages();
    expect(left.closest('main')).not.toHaveClass('doc-panes');
    // In the DOM, and so for Tab and a screen reader: status and Download,
    // the facts, the pages within reach, then notes, history, … Move to the Trash.
    const order = [
      within(left).getByRole('button', { name: 'Download' }),
      left.querySelector('dl.facts') as HTMLElement,
      right,
      within(left).getByRole('heading', { name: 'Notes' }),
      within(left).getByRole('heading', { name: 'History' }),
      within(left).getByRole('button', { name: 'Move to the Trash' }),
    ];
    for (let i = 1; i < order.length; i += 1) {
      const [before, after] = [order[i - 1] as HTMLElement, order[i] as HTMLElement];
      expect(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // The preview that opens the reader, as before, now after the facts.
    expect(
      within(right).getByRole('link', { name: "Read Mansoor's passport, full size" }),
    ).toHaveAttribute('href', '/documents/doc-1/read');
    expect(within(right).queryByRole('button', { name: 'Next page' })).not.toBeInTheDocument();
    // Nothing a phone has today is lost: the actions are all in the details.
    expect(within(left).getByRole('button', { name: 'Download' })).toBeInTheDocument();
    expect(within(left).getByRole('button', { name: 'Move to the Trash' })).toBeInTheDocument();
    expect(pageCalls(state)).toEqual([]);
    await expectAccessible();
  });

  it('the page heading has the focus on arrival from the Documents table', async () => {
    at('/documents', WIDE);
    const table = await screen.findByRole('grid', { name: /^Documents, sorted by/ });
    fireEvent.click(await within(table).findByRole('link', { name: "Mansoor's passport" }));
    await details();
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: "Mansoor's passport" })).toHaveFocus(),
    );
  });

  it('Back to the Documents table finds it as it was left: the sort and the row chosen', async () => {
    at('/documents?sort=person', WIDE, 'owner', {
      documents: [
        { ...PASSPORT },
        { ...PASSPORT, id: 'doc-2', title: 'House deed', latest_version_id: 'v-2', etag: '"d"' },
      ],
    });
    const table = await screen.findByRole('grid', { name: /^Documents, sorted by/ });
    fireEvent.click(await within(table).findByRole('checkbox', { name: 'Select “House deed”' }));
    fireEvent.click(within(table).getByRole('link', { name: "Mansoor's passport" }));
    await within(await pages()).findByRole('img', { name: 'Page 1 of 2' });
    act(() => window.history.back());
    const again = await screen.findByRole('grid', { name: /^Documents, sorted by/ });
    await waitFor(() =>
      expect(within(again).getByRole('checkbox', { name: 'Select “House deed”' })).toBeChecked(),
    );
    expect(window.location.search).toBe('?sort=person');
  });
});

describe('who sees what, in either arrangement (R3)', () => {
  const ROLES: Who[] = ['owner', 'adult', 'teen', 'viewer', 'restricted', 'guest'];
  for (const who of ROLES) {
    it(`${who}: every section is where it was allowed to be, and the same at 1280 and 320 px`, async () => {
      const wide = at('/documents/doc-1', WIDE, who);
      const left = await details();
      await within(left).findByText('Renewal form is in the blue folder.');
      if (who === 'owner' || who === 'adult' || who === 'teen') {
        await within(left).findByRole('heading', { name: 'Collections' });
      }
      await waitFor(() =>
        expect(wide.calls.some((c) => c.url === '/api/v1/shares')).toBe(
          who === 'owner' || who === 'adult',
        ),
      );
      const atWide = inventory(left);
      cleanup();
      const phone = at('/documents/doc-1', PHONE, who);
      const leftPhone = await details();
      await within(leftPhone).findByText('Renewal form is in the blue folder.');
      if (who === 'owner' || who === 'adult' || who === 'teen') {
        await within(leftPhone).findByRole('heading', { name: 'Collections' });
      }
      await waitFor(() =>
        expect(phone.calls.some((c) => c.url === '/api/v1/shares')).toBe(
          who === 'owner' || who === 'adult',
        ),
      );
      expect(inventory(leftPhone)).toEqual(atWide);

      const has = (what: string) =>
        atWide.some((line) => line.includes(what.replace(/^(h2|label|button): /, '')));
      const family = who === 'owner' || who === 'adult' || who === 'teen';
      // Where the original is kept: the household's, never a viewer's or a guest's (5.41).
      expect(has('Original is kept')).toBe(family);
      expect(within(left).queryByText('Bedroom safe, top shelf') !== null).toBe(family);
      // Collections: for whoever may manage them (5.15).
      expect(has('h2: Collections')).toBe(family);
      // A link outside the family: an adult's (5.4).
      expect(has('button: Share a link')).toBe(who === 'owner' || who === 'adult');
      // Moving it to the Trash: whoever may change it (5.1).
      expect(has('button: Move to the Trash')).toBe(family);
      // Read by whoever sees it.
      expect(has('h2: Notes')).toBe(true);
      expect(has('h2: History')).toBe(true);
    });
  }

  it('a viewer’s and a guest’s pages: the same viewer, and nothing of where the original is', async () => {
    for (const who of ['viewer', 'guest'] as const) {
      at('/documents/doc-1', WIDE, who);
      const right = await pages();
      await within(right).findByRole('img', { name: 'Page 1 of 2' });
      expect(screen.queryByText('Bedroom safe, top shelf')).not.toBeInTheDocument();
      expect(screen.queryByText('Original is kept')).not.toBeInTheDocument();
      await expectAccessible();
      cleanup();
    }
  });
});

describe('the pages, at 1280 px (R3)', () => {
  it('turn with the buttons, and with Page Up and Page Down — or [ and ] — only in the viewer', async () => {
    const state = at('/documents/doc-1', WIDE);
    const right = await pages();
    await within(right).findByRole('img', { name: 'Page 1 of 2' });
    // Outside the viewer, the keys are the page's: nothing turns.
    const left = await details();
    fireEvent.keyDown(within(left).getByRole('button', { name: 'Download' }), { key: 'PageDown' });
    fireEvent.keyDown(document.body, { key: ']' });
    fireEvent.keyDown(screen.getByRole('heading', { level: 1 }), { key: 'PageDown' });
    expect(within(right).getByRole('img', { name: 'Page 1 of 2' })).toBeInTheDocument();
    expect(pageCalls(state)).toEqual(['1']);
    // In the viewer: Page Down, then [ back.
    fireEvent.keyDown(within(right).getByRole('group', { name: /^Page 1 of 2/ }), {
      key: 'PageDown',
    });
    expect(await within(right).findByRole('img', { name: 'Page 2 of 2' })).toBeInTheDocument();
    expect(within(right).getByRole('link', { name: 'Read it full size' })).toHaveAttribute(
      'href',
      '/documents/doc-1/read?v=v-1&p=2',
    );
    fireEvent.keyDown(within(right).getByRole('group', { name: /^Page 2 of 2/ }), { key: '[' });
    expect(await within(right).findByRole('img', { name: 'Page 1 of 2' })).toBeInTheDocument();
    // The buttons; a page seen once is not fetched again.
    fireEvent.click(within(right).getByRole('button', { name: 'Next page' }));
    expect(await within(right).findByRole('img', { name: 'Page 2 of 2' })).toBeInTheDocument();
    expect(within(right).getByRole('button', { name: 'Next page' })).toBeDisabled();
    expect(pageCalls(state)).toEqual(['1', '2']);
  });

  it('with single keys turned off, [ and ] turn nothing; Page Down still does', async () => {
    localStorage.setItem('fdv.shortcuts', 'off');
    at('/documents/doc-1', WIDE);
    const right = await pages();
    await within(right).findByRole('img', { name: 'Page 1 of 2' });
    const viewer = within(right).getByRole('group', { name: /^Page 1 of 2/ });
    expect(viewer).toHaveAttribute('aria-keyshortcuts', 'PageUp PageDown');
    fireEvent.keyDown(viewer, { key: ']' });
    expect(within(right).getByRole('img', { name: 'Page 1 of 2' })).toBeInTheDocument();
    fireEvent.keyDown(viewer, { key: 'PageDown' });
    expect(await within(right).findByRole('img', { name: 'Page 2 of 2' })).toBeInTheDocument();
  });

  it('an Essential document asks nothing on arrival: its pages wait for “Confirm it’s you”', async () => {
    const state = at('/documents/doc-1', WIDE, 'owner', { stepUpNeeded: true });
    const right = await pages();
    expect(
      await within(right).findByText('Confirm it’s you to see its pages.'),
    ).toBeInTheDocument();
    // No prompt until asked.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(within(right).getByRole('button', { name: 'Confirm it’s you' }));
    const prompt = await screen.findByRole('dialog');
    expect(prompt).toBeInTheDocument();
    expect(pageCalls(state)).toEqual(['1', '1']);
  });

  it('a PDF whose drawing failed says its pages could not be drawn, not that its kind is not drawn (W-R3-3)', async () => {
    // The vault says 0 pages for both: a kind it does not draw, and a drawing that failed.
    const state = at('/documents/doc-1', WIDE, 'owner', { pagesDrawn: 'unsupported' });
    const right = await pages();
    expect(
      await within(right).findByText('Its pages could not be drawn. Download it to open it.'),
    ).toBeInTheDocument();
    expect(within(right).queryByText(/does not draw this kind/)).not.toBeInTheDocument();
    expect(pageCalls(state)).toEqual([]);
  });

  it('a Word file says the vault does not draw its pages, and asks for none', async () => {
    const state = at('/documents/doc-1', WIDE, 'owner', {
      pagesDrawn: 'unsupported',
      versionMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const right = await pages();
    expect(
      await within(right).findByText(
        'The vault does not draw this kind of file’s pages. Download it to open it.',
      ),
    ).toBeInTheDocument();
    expect(within(right).queryByRole('button', { name: 'Next page' })).not.toBeInTheDocument();
    expect(
      within(right).queryByRole('link', { name: 'Read it full size' }),
    ).not.toBeInTheDocument();
    expect(pageCalls(state)).toEqual([]);
  });

  it('with no file yet, it says so; pages still being drawn say so, then appear', async () => {
    at('/documents/doc-1', WIDE, 'owner', {
      documents: [{ ...PASSPORT, latest_version_id: null, versions: 0 }],
    });
    expect(await within(await pages()).findByText('No file yet')).toBeInTheDocument();
    cleanup();

    at('/documents/doc-1', WIDE, 'owner', { pagesPending: 1 });
    const right = await pages();
    // Being drawn the first time it is asked for; then there, and counted.
    expect(await within(right).findByRole('img', { name: 'Page 1 of 2' })).toBeInTheDocument();
  });

  it('a long document says how long it is, and where the drawn pages end', async () => {
    at('/documents/doc-1', WIDE, 'owner', { pagesDrawn: 30, pageCount: 50 });
    const right = await pages();
    await within(right).findByRole('img', { name: 'Page 1 of 50' });
    expect(within(right).getByText('Page 1 of 50')).toBeInTheDocument();
  });
});

/** The page's own fetches as they leave, each held until `release` lets it through when asked. */
function holdPages(hold: (n: number) => boolean) {
  const real = window.fetch.bind(window);
  const asked: number[] = [];
  const waiting: (() => void)[] = [];
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const page = /\/versions\/[^/]+\/pages\/(\d+)$/.exec(url);
    if (page) {
      const n = Number(page[1]);
      asked.push(n);
      if (hold(n)) await new Promise<void>((go) => waiting.push(go));
    }
    return real(input, init);
  };
  return {
    asked,
    release: () => {
      for (const go of waiting.splice(0)) go();
    },
  };
}

describe('the review round (R3)', () => {
  it('W-R3-1: “Try again” leaves the focus on the page, not the top of the document', async () => {
    at('/documents/doc-1', WIDE);
    // Page 1 fails once.
    const real = window.fetch.bind(window);
    let failed = false;
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!failed && /\/pages\/1$/.test(url)) {
        failed = true;
        return Response.json(
          { error: { code: 'internal', message: 'Something went wrong.', request_id: 'r' } },
          { status: 500 },
        );
      }
      return real(input, init);
    };
    const right = await pages();
    const again = await within(right).findByRole('button', { name: 'Try again' });
    again.focus();
    fireEvent.click(again);
    await waitFor(() =>
      expect(within(right).getByRole('group', { name: /^Page 1 of 2/ })).toHaveFocus(),
    );
    await within(right).findByRole('img', { name: 'Page 1 of 2' });
    await waitFor(() =>
      expect(within(right).getByRole('group', { name: /^Page 1 of 2/ })).toHaveFocus(),
    );
  });

  it('W-R3-1: “Confirm it’s you” leaves the focus on the page, and cancelling the question brings it back there', async () => {
    at('/documents/doc-1', WIDE, 'owner', { stepUpNeeded: true });
    const right = await pages();
    const confirm = await within(right).findByRole('button', { name: 'Confirm it’s you' });
    confirm.focus();
    fireEvent.click(confirm);
    const prompt = await screen.findByRole('dialog');
    fireEvent.click(within(prompt).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() =>
      expect(within(right).getByRole('group', { name: /^Page 1 of 2/ })).toHaveFocus(),
    );
    // Asked again, as before.
    expect(
      await within(right).findByRole('button', { name: 'Confirm it’s you' }),
    ).toBeInTheDocument();
    expect(document.activeElement).not.toBe(document.body);
  });

  it('W-R3-2: turning fast fetches only the page stopped at, and turning back to it asks nothing', async () => {
    const state = at('/documents/doc-1', WIDE, 'owner', { pagesDrawn: 5, pageCount: 5 });
    const right = await pages();
    await within(right).findByRole('img', { name: 'Page 1 of 5' });
    const viewer = () => within(right).getByRole('group', { name: /^Page \d of 5/ });
    // A key held down, or pressed quickly: a turn every 40 ms.
    const quickly = () => act(() => new Promise<void>((r) => setTimeout(r, 40)));
    fireEvent.keyDown(viewer(), { key: 'PageDown' });
    await quickly();
    fireEvent.keyDown(viewer(), { key: 'PageDown' });
    await quickly();
    fireEvent.keyDown(viewer(), { key: 'PageDown' });
    await within(right).findByRole('img', { name: 'Page 4 of 5' });
    fireEvent.keyDown(viewer(), { key: 'PageUp' });
    await within(right).findByRole('img', { name: 'Page 3 of 5' });
    fireEvent.keyDown(viewer(), { key: 'PageDown' });
    await within(right).findByRole('img', { name: 'Page 4 of 5' });
    // Pages 2 and 3 on the way to 4 were never shown: not fetched, not logged.
    expect(pageCalls(state)).toEqual(['1', '4', '3']);
  });

  it('W-R3-2: a page that arrives after it was turned away from is kept: turning back fetches it no more', async () => {
    at('/documents/doc-1', WIDE, 'owner', { pagesDrawn: 5, pageCount: 5 });
    const held = holdPages((n) => n === 2);
    const right = await pages();
    await within(right).findByRole('img', { name: 'Page 1 of 5' });
    const viewer = () => within(right).getByRole('group', { name: /^Page \d of 5/ });
    fireEvent.keyDown(viewer(), { key: 'PageDown' });
    // Page 2 on its way, and away from it before it comes.
    await waitFor(() => expect(held.asked).toEqual([1, 2]));
    fireEvent.keyDown(viewer(), { key: 'PageDown' });
    await within(right).findByRole('img', { name: 'Page 3 of 5' });
    held.release();
    await waitFor(() => expect(made).toBe(3));
    fireEvent.keyDown(viewer(), { key: 'PageUp' });
    expect(await within(right).findByRole('img', { name: 'Page 2 of 5' })).toBeInTheDocument();
    expect(held.asked).toEqual([1, 2, 3]);
  });

  it('W-R3-2: turned back to while it is still on its way, it is not asked for twice', async () => {
    at('/documents/doc-1', WIDE, 'owner', { pagesDrawn: 5, pageCount: 5 });
    const held = holdPages((n) => n === 2);
    const right = await pages();
    await within(right).findByRole('img', { name: 'Page 1 of 5' });
    const viewer = () => within(right).getByRole('group', { name: /^Page \d of 5/ });
    fireEvent.keyDown(viewer(), { key: 'PageDown' });
    await waitFor(() => expect(held.asked).toEqual([1, 2]));
    fireEvent.keyDown(viewer(), { key: 'PageDown' });
    await within(right).findByRole('img', { name: 'Page 3 of 5' });
    fireEvent.keyDown(viewer(), { key: 'PageUp' });
    // Still on its way: waited for, not asked again.
    await new Promise((r) => setTimeout(r, 300));
    expect(held.asked).toEqual([1, 2, 3]);
    held.release();
    expect(await within(right).findByRole('img', { name: 'Page 2 of 5' })).toBeInTheDocument();
    expect(held.asked).toEqual([1, 2, 3]);
  });
});
