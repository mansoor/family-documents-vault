import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import {
  AISHA,
  fresh,
  installFakeApi,
  ME,
  PASSPORT,
  signedIn,
  type FakeCollection,
  type FakeState,
} from './test-api.js';

/**
 * The app's shell (Phase 6, R1): a sidebar and a bar on top from 768 px, the
 * sidebar its icons alone below 1024 px, and on a phone today's bottom bar
 * with a drawer for the rest. Each section only for whom its screen is;
 * Settings holds settings only; and every address Settings had still works.
 */

type Role = 'owner' | 'adult' | 'teen' | 'viewer';
const PHONE = 375;
const MID = 900;
const WIDE = 1280;

/** The window this wide (and tall), as the browser's media queries would say. */
let width = 1280;
let height = 900;
const widthWatchers = new Set<() => void>();
function atWidth(px: number, tall = 900) {
  width = px;
  height = tall;
  widthWatchers.clear();
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
        addEventListener: (_: string, fn: () => void) => widthWatchers.add(fn),
        removeEventListener: (_: string, fn: () => void) => widthWatchers.delete(fn),
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      };
    },
  });
}

/** The window turned or resized to this width (and height), as the media queries tell it. */
function resizeTo(px: number, tall = height) {
  act(() => {
    width = px;
    height = tall;
    for (const watcher of [...widthWatchers]) watcher();
  });
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});
afterEach(() => {
  // jsdom has none of its own.
  Reflect.deleteProperty(window, 'matchMedia');
});

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

/** A file sent through a request, waiting for whoever reviews it (5.23). */
const W2 = {
  id: 'in-1',
  request_id: 'req-1',
  request_title: 'Your tax papers',
  recipient_label: 'Jane, accountant',
  item_label: 'W-2',
  name: 'W-2 2025.pdf',
  content_type: 'application/pdf',
  byte_size: 120 * 1024,
  sender_note: null,
  sent_at: '2026-10-01T09:00:00Z',
  removed_at: '2026-10-31T09:00:00Z',
  scan_state: 'unscanned',
  preview_state: 'ready',
  preview_pages: 2,
  suggested_member_id: 'm-0',
  suggested_type_key: 'passport',
  review_by: 'me',
  moved_to_owners: false,
};

/** A collection an owner gave a viewer (5.33). */
const GIVEN: FakeCollection = {
  id: 'collection-g',
  name: 'For the accountant',
  description: null,
  audience: 'everyone',
  owner_member_id: 'm-9',
  etag: '"g.1"',
  items: ['doc-1'],
};

const LIMITED = {
  summary: 'You can see: the collection “For the accountant”.',
  people: [],
  types: [],
  collections: [{ id: 'collection-g', name: 'For the accountant' }],
  include_adults_only: false,
  include_no_person_docs: false,
  expires_at: null,
};

/** Everything a vault can have switched on, so each section is there to be shown. */
const EVERYTHING: Partial<FakeState> = {
  incoming: [{ ...W2 }],
  guests: [],
  collections: [],
  identities: {},
};

/** The app at `path`, `px` wide, signed in as `role`. */
function at(
  path: string,
  over: Partial<FakeState> = {},
  role: Role = 'owner',
  px: number = WIDE,
  tall = 900,
): FakeState {
  atWidth(px, tall);
  const state = fresh({ members: [{ ...ME, role }, AISHA], ...over });
  installFakeApi(state);
  signedIn(role);
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

/** What a link is called: its label, or its words less what is hidden from a screen reader. */
function nameOf(link: HTMLElement): string {
  const label = link.getAttribute('aria-label');
  if (label) return label;
  const copy = link.cloneNode(true) as HTMLElement;
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return (copy.textContent ?? '').trim();
}

/** The sections in a navigation, by name, in order. */
function namesIn(nav: HTMLElement): string[] {
  return within(nav).getAllByRole('link').map(nameOf);
}

const sidebar = () => screen.findByRole('navigation', { name: 'Sections' });

/**
 * The bar on top: the page's banner. (A screen's own header is inside its
 * main, and so no banner, which axe knows and Testing Library does not.)
 */
const appBar = () => document.querySelector('header.app-bar') as HTMLElement;

describe('the sidebar, from 1024 px (R1)', () => {
  it.each([
    [
      'owner',
      [
        'Home',
        'Documents',
        'People',
        'Collections',
        'Needs attention',
        'Inbox, 1 waiting',
        'Sharing',
        'Activity',
        'Trash',
        'Settings',
      ],
    ],
    [
      'adult',
      [
        'Home',
        'Documents',
        'People',
        'Collections',
        'Needs attention',
        'Inbox, 1 waiting',
        'Sharing',
        'Activity',
        'Trash',
        'Settings',
      ],
    ],
    // A teen asks nobody for documents, and shares nothing outside.
    [
      'teen',
      [
        'Home',
        'Documents',
        'People',
        'Collections',
        'Needs attention',
        'Activity',
        'Trash',
        'Settings',
      ],
    ],
    // A viewer is given documents, not the family, and has no collection given.
    ['viewer', ['Home', 'Documents', 'Settings']],
  ] as const)('shows a %s each section that is theirs, and only those', async (role, names) => {
    const state = at('/', EVERYTHING, role);
    const nav = await sidebar();
    await waitFor(() => expect(namesIn(nav)).toEqual(names));
    // Nobody but whoever reviews is asked what waits (5.23).
    expect(state.calls.some((c) => c.url === '/api/v1/incoming')).toBe(
      role === 'owner' || role === 'adult',
    );
  });

  it('a viewer given a collection has Collections too', async () => {
    at('/', { collections: [GIVEN], myRestriction: LIMITED }, 'viewer');
    const nav = await sidebar();
    await waitFor(() =>
      expect(namesIn(nav)).toEqual(['Home', 'Documents', 'Collections', 'Settings']),
    );
    expect(within(nav).getByRole('link', { name: 'Collections' })).toHaveAttribute(
      'href',
      '/collections',
    );
  });

  it('a guest has Home, Documents, the collection they were given, and Settings', async () => {
    at(
      '/',
      {
        ...EVERYTHING,
        collections: [GIVEN],
        members: [{ ...ME, role: 'viewer', kind: 'guest', display_name: 'Jane Smith' }],
        myKind: 'guest',
        myRestriction: LIMITED,
      },
      'viewer',
    );
    const nav = await sidebar();
    await waitFor(() =>
      expect(namesIn(nav)).toEqual(['Home', 'Documents', 'Collections', 'Settings']),
    );
    // Nothing to add, and the account menu calls them a guest.
    const bar = appBar();
    expect(within(bar).queryByRole('link', { name: 'Add' })).toBeNull();
    fireEvent.click(await within(bar).findByRole('button', { name: 'Your account: Jane Smith' }));
    const menu = await screen.findByRole('menu', { name: 'Your account' });
    expect(menu.parentElement).toHaveTextContent('Jane SmithGuest');
  });

  it('marks the page it is on, and moves it as the page changes', async () => {
    at('/', EVERYTHING);
    const nav = await sidebar();
    const current = () =>
      within(nav)
        .getAllByRole('link')
        .filter((a) => a.getAttribute('aria-current') === 'page')
        .map((a) => a.textContent);
    await waitFor(() => expect(current()).toEqual(['Home']));
    fireEvent.click(within(nav).getByRole('link', { name: 'Trash' }));
    await screen.findByRole('heading', { name: 'Trash', level: 1 });
    expect(current()).toEqual(['Trash']);
    fireEvent.click(within(nav).getByRole('link', { name: 'Settings' }));
    await screen.findByRole('heading', { name: 'Settings', level: 1 });
    expect(current()).toEqual(['Settings']);
    // A part of a section is the section's: a document is Documents', a
    // settings page Settings'.
    fireEvent.click(screen.getByRole('link', { name: /How you hear about things/ }));
    await screen.findByRole('heading', { name: 'How you hear about things', level: 1 });
    expect(current()).toEqual(['Settings']);
    cleanup();
    at(`/documents/${PASSPORT.id}`, EVERYTHING);
    const again = await sidebar();
    await screen.findByRole('heading', { name: "Mansoor's passport", level: 1 });
    expect(within(again).getByRole('link', { name: 'Documents' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('Documents opens the Documents table (R2)', async () => {
    at('/', EVERYTHING);
    fireEvent.click(within(await sidebar()).getByRole('link', { name: 'Documents' }));
    await screen.findByRole('heading', { name: 'Documents', level: 1 });
    expect(window.location.pathname).toBe('/documents');
    const table = await screen.findByRole('grid', { name: /^Documents, sorted by Title/ });
    expect(
      await within(table).findByRole('link', { name: "Mansoor's passport" }),
    ).toBeInTheDocument();
  });

  it('a new page takes focus to its heading; the first does not', async () => {
    at('/', EVERYTHING);
    const nav = await sidebar();
    const home = await screen.findByRole('heading', { name: 'The Seikh family', level: 1 });
    expect(home).not.toHaveFocus();
    const trash = within(nav).getByRole('link', { name: 'Trash' });
    trash.focus();
    fireEvent.click(trash);
    const heading = await screen.findByRole('heading', { name: 'Trash', level: 1 });
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it('the skip link goes straight to the page', async () => {
    at('/', EVERYTHING);
    await sidebar();
    const skip = screen.getByRole('link', { name: 'Skip to main content' });
    // The first thing Tab reaches.
    expect(document.querySelector('a[href], button, input')).toBe(skip);
    fireEvent.click(skip);
    await waitFor(() => expect(screen.getByRole('main')).toHaveFocus());
  });

  it('has its landmarks, and nothing axe finds, wide and in the middle', async () => {
    at('/', EVERYTHING);
    await sidebar();
    await screen.findByRole('heading', { name: 'Recently added' });
    expect(appBar().closest('main')).toBeNull();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('search')).toBeInTheDocument();
    await expectAccessible();
    cleanup();
    at('/', EVERYTHING, 'owner', MID);
    await sidebar();
    await screen.findByRole('heading', { name: 'Recently added' });
    await expectAccessible();
  });
});

describe('across the widths', () => {
  it('a window resized across 768 px keeps what is on the page; the layout follows it', async () => {
    at('/people', EVERYTHING);
    await sidebar();
    fireEvent.click(await screen.findByRole('button', { name: 'Add someone' }));
    const name = await screen.findByLabelText('Name of another family member');
    fireEvent.change(name, { target: { value: 'Zain' } });
    resizeTo(PHONE);
    expect(await screen.findByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Sections' })).toBeNull();
    // The same field, not one drawn again: what was typed is still there.
    expect(screen.getByLabelText('Name of another family member')).toBe(name);
    expect(name).toHaveValue('Zain');
    // The drawer open, then the window grown: it goes, and does not come back.
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    await screen.findByRole('dialog', { name: 'Menu' });
    resizeTo(MID);
    expect(await screen.findByRole('navigation', { name: 'Sections' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull();
    resizeTo(PHONE);
    await screen.findByRole('navigation', { name: 'Main' });
    expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull();
    expect(name).toHaveValue('Zain');
  });
});

describe('a short window: the phone’s layout, whatever its width (the review)', () => {
  it.each([
    [900, 500],
    [1000, 560],
    [844, 390],
  ])('at %ix%i the drawer reaches every section; the rail would not fit', async (wide, tall) => {
    at('/', EVERYTHING, 'owner', wide, tall);
    await screen.findByRole('navigation', { name: 'Main' });
    expect(screen.queryByRole('navigation', { name: 'Sections' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    const drawer = await screen.findByRole('dialog', { name: 'Menu' });
    await waitFor(() =>
      expect(namesIn(within(drawer).getByRole('navigation', { name: 'Sections' }))).toEqual([
        'Documents',
        'Collections',
        'Inbox, 1 waiting',
        'Sharing',
        'Activity',
        'Trash',
        'Settings',
      ]),
    );
  });

  it('tall enough again, the icons’ rail comes back', async () => {
    at('/', EVERYTHING, 'owner', 900, 500);
    await screen.findByRole('navigation', { name: 'Main' });
    resizeTo(900, 700);
    expect(await sidebar()).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
  });
});

describe('an address that names a place on the page (the review)', () => {
  it('goes there, and focus with it, not to the top and the heading', async () => {
    const scrolled: Element[] = [];
    // jsdom has no scrolling: what was asked to come into view is written down.
    const had = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value(this: Element) {
        scrolled.push(this);
      },
    });
    try {
      at('/', EVERYTHING);
      await sidebar();
      await screen.findByRole('heading', { name: 'Recently added' });
      // As "Set up two-step sign-in" does, from a person's page.
      act(() => {
        window.history.pushState({}, '', '/settings#two-step');
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
      await screen.findByRole('heading', { name: 'Settings', level: 1 });
      const card = document.getElementById('two-step') as HTMLElement;
      await waitFor(() => expect(card).toHaveFocus());
      expect(scrolled).toContain(card);
      expect(screen.getByRole('heading', { name: 'Settings', level: 1 })).not.toHaveFocus();
    } finally {
      if (had) Object.defineProperty(Element.prototype, 'scrollIntoView', had);
      else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    }
  });
});

describe('the sidebar narrowed to its icons, 768–1023 px', () => {
  it('names each icon, and shows the name beside it on hover or focus', async () => {
    at('/', EVERYTHING, 'owner', MID);
    const nav = await sidebar();
    const inbox = await within(nav).findByRole('link', { name: 'Inbox, 1 waiting' });
    // The name is heard, and drawn beside the icon by styles.css.
    expect(inbox).toHaveAttribute('data-label', 'Inbox');
    expect(within(inbox).getByText('Inbox')).toHaveClass('visually-hidden');
    for (const name of ['Home', 'Documents', 'People', 'Trash', 'Settings']) {
      expect(within(nav).getByRole('link', { name })).toHaveAttribute('data-label', name);
    }
    // Wide, the names are there to read: no tooltip.
    cleanup();
    at('/', EVERYTHING);
    const wide = await sidebar();
    expect(within(wide).getByRole('link', { name: 'Home' })).not.toHaveAttribute('data-label');
  });
});

describe('the bar on top', () => {
  it('searches across the vault: `/` comes to it, and Enter opens Search with the words', async () => {
    at('/', EVERYTHING);
    await sidebar();
    const field = screen.getByRole('searchbox', { name: 'Search the vault' });
    expect(field).not.toHaveFocus();
    fireEvent.keyDown(document.body, { key: '/' });
    await waitFor(() => expect(field).toHaveFocus());
    fireEvent.change(field, { target: { value: 'passport' } });
    fireEvent.submit(field.closest('form') as HTMLFormElement);
    await screen.findByRole('heading', { name: 'Search', level: 1 });
    expect(window.location.pathname + window.location.search).toBe('/search?q=passport');
    expect(screen.getByLabelText('Search everything')).toHaveValue('passport');
  });

  it('`n` puts focus on Add, and never leaves the page: nothing half-typed is lost (the review)', async () => {
    at('/people', EVERYTHING);
    await sidebar();
    // Half-way through adding somebody, focus on a button rather than a field.
    fireEvent.click(await screen.findByRole('button', { name: 'Add someone' }));
    const name = await screen.findByLabelText('Name of another family member');
    fireEvent.change(name, { target: { value: 'Zain' } });
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    cancel.focus();
    fireEvent.keyDown(cancel, { key: 'n' });
    const add = within(appBar()).getByRole('link', { name: 'Add' });
    await waitFor(() => expect(add).toHaveFocus());
    expect(window.location.pathname).toBe('/people');
    expect(name).toHaveValue('Zain');
    // Add itself goes to Add, until bulk intake makes it a menu (I1).
    expect(add).toHaveAttribute('href', '/add');
    expect(add).toHaveAttribute('aria-keyshortcuts', 'n');
  });

  it('a key held down does nothing', async () => {
    at('/', EVERYTHING);
    await sidebar();
    fireEvent.keyDown(document.body, { key: '/', repeat: true });
    fireEvent.keyDown(document.body, { key: 'n', repeat: true });
    expect(screen.getByRole('searchbox', { name: 'Search the vault' })).not.toHaveFocus();
    expect(within(appBar()).getByRole('link', { name: 'Add' })).not.toHaveFocus();
  });

  it('turned off in Settings, on this device, neither key does anything (WCAG 2.1.4)', async () => {
    at('/settings', EVERYTHING);
    // Asked for afresh each time, and waited for: a page drawn after the
    // vault answered may not yet be listening to the choice when it is
    // clicked (useSyncExternalStore subscribes in an effect), and catches
    // up a moment later — on a loaded machine, after the click.
    const box = () => screen.getByRole('checkbox', { name: 'Single-key shortcuts (/ and n)' });
    await screen.findByRole('checkbox', { name: 'Single-key shortcuts (/ and n)' });
    expect(box()).toBeChecked();
    expect(box()).toHaveAccessibleDescription(/\/ goes to the search box and n to Add/);
    fireEvent.click(box());
    await waitFor(() => expect(box()).not.toBeChecked());
    expect(localStorage.getItem('fdv.shortcuts')).toBe('off');
    // Nor said to be there.
    const field = screen.getByRole('searchbox', { name: 'Search the vault' });
    expect(field).not.toHaveAttribute('aria-keyshortcuts');
    expect(within(appBar()).getByRole('link', { name: 'Add' })).not.toHaveAttribute(
      'aria-keyshortcuts',
    );
    expect(appBar().querySelector('kbd')).toBeNull();
    fireEvent.keyDown(document.body, { key: '/' });
    fireEvent.keyDown(document.body, { key: 'n' });
    expect(field).not.toHaveFocus();
    expect(within(appBar()).getByRole('link', { name: 'Add' })).not.toHaveFocus();
    // Kept: the next time the vault is opened on this device, still off.
    cleanup();
    at('/', EVERYTHING);
    await sidebar();
    fireEvent.keyDown(document.body, { key: '/' });
    expect(screen.getByRole('searchbox', { name: 'Search the vault' })).not.toHaveFocus();
    // And on again.
    cleanup();
    at('/settings', EVERYTHING);
    await screen.findByRole('checkbox', { name: 'Single-key shortcuts (/ and n)' });
    fireEvent.click(box());
    await waitFor(() => expect(box()).toBeChecked());
    expect(localStorage.getItem('fdv.shortcuts')).toBeNull();
    fireEvent.keyDown(document.body, { key: '/' });
    await waitFor(() =>
      expect(screen.getByRole('searchbox', { name: 'Search the vault' })).toHaveFocus(),
    );
  });

  it('a browser that keeps nothing (a private window) still turns them off, for now', async () => {
    at('/settings', EVERYTHING);
    // Asked for afresh and waited for, as above.
    const box = () => screen.getByRole('checkbox', { name: 'Single-key shortcuts (/ and n)' });
    await screen.findByRole('checkbox', { name: 'Single-key shortcuts (/ and n)' });
    // From here on this browser keeps nothing it is given.
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      fireEvent.click(box());
      await waitFor(() => expect(box()).not.toBeChecked());
      fireEvent.keyDown(document.body, { key: '/' });
      expect(screen.getByRole('searchbox', { name: 'Search the vault' })).not.toHaveFocus();
      fireEvent.click(box());
      await waitFor(() => expect(box()).toBeChecked());
    } finally {
      setItem.mockRestore();
    }
  });

  it('neither key does anything while typing, nor with a dialog or a menu open', async () => {
    at('/', EVERYTHING);
    await sidebar();
    const field = screen.getByRole('searchbox', { name: 'Search the vault' });
    field.focus();
    fireEvent.keyDown(field, { key: 'n' });
    fireEvent.keyDown(field, { key: '/' });
    // A field in a screen, too.
    fireEvent.click(within(await sidebar()).getByRole('link', { name: 'People' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add someone' }));
    const name = await screen.findByLabelText('Name of another family member');
    name.focus();
    fireEvent.keyDown(name, { key: 'n' });
    fireEvent.keyDown(name, { key: '/' });
    expect(window.location.pathname).toBe('/people');
    expect(name).toHaveFocus();
    // The account menu open: its keys are its own.
    fireEvent.click(screen.getByRole('button', { name: /^Your account/ }));
    await screen.findByRole('menu', { name: 'Your account' });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'n' });
    expect(window.location.pathname).toBe('/people');
  });

  it('`n` does nothing for a viewer, who adds nothing', async () => {
    at('/', {}, 'viewer');
    await sidebar();
    const before = document.activeElement;
    fireEvent.keyDown(document.body, { key: 'n' });
    await screen.findByRole('heading', { name: 'Recently added' });
    expect(window.location.pathname).toBe('/');
    expect(document.activeElement).toBe(before);
  });

  it('the account menu: your name, Settings, and Sign out', async () => {
    at('/', EVERYTHING);
    await sidebar();
    const button = await screen.findByRole('button', { name: 'Your account: Mansoor Seikh' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(button);
    const menu = await screen.findByRole('menu', { name: 'Your account' });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(menu.parentElement).toHaveTextContent('Mansoor SeikhOwner');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['Settings', 'Sign out']);
    await waitFor(() => expect(items[0]).toHaveFocus());
    // The arrows move between them, and Escape gives focus back.
    fireEvent.keyDown(items[0] as HTMLElement, { key: 'ArrowDown' });
    expect(items[1]).toHaveFocus();
    await expectAccessible();
    fireEvent.keyDown(items[1] as HTMLElement, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await waitFor(() => expect(button).toHaveFocus());
    // Sign out signs out.
    fireEvent.click(button);
    await act(async () => {
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    });
    await waitFor(() => expect(window.location.pathname).toBe('/sign-in'));
    expect(localStorage.getItem('fdv.session')).toBeNull();
  });
});

describe('the Inbox count', () => {
  it('says what waits for this person, and follows it as files are filed', async () => {
    const second = { ...W2, id: 'in-2', name: '1099 2025.pdf' };
    const state = at('/', { ...EVERYTHING, incoming: [{ ...W2 }, second] });
    const nav = await sidebar();
    const inbox = await within(nav).findByRole('link', { name: 'Inbox, 2 waiting' });
    expect(within(inbox).getByText('2')).toHaveAttribute('aria-hidden', 'true');
    // One filed or refused elsewhere: the next page asks again.
    state.incoming = [second];
    fireEvent.click(within(nav).getByRole('link', { name: 'Activity' }));
    expect(await within(nav).findByRole('link', { name: 'Inbox, 1 waiting' })).toBeInTheDocument();
    // None: no count at all.
    state.incoming = [];
    fireEvent.click(inbox);
    await screen.findByRole('heading', { name: 'Files sent to you', level: 1 });
    await waitFor(() =>
      expect(within(nav).getByRole('link', { name: 'Inbox' })).toBeInTheDocument(),
    );
    expect(within(nav).getByRole('link', { name: 'Inbox' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});

describe('on a phone: the bottom bar and the drawer', () => {
  it('keeps today’s bottom bar, Reminders now Needs attention', async () => {
    at('/', EVERYTHING, 'owner', PHONE);
    const bar = await screen.findByRole('navigation', { name: 'Main' });
    expect(namesIn(bar)).toEqual(['Home', 'Search', 'Add a document', 'Needs attention', 'People']);
    expect(within(bar).getByRole('link', { name: 'Add a document' })).toHaveAttribute(
      'href',
      '/add',
    );
    expect(within(bar).getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    // No sidebar, and no bar on top with search.
    expect(screen.queryByRole('navigation', { name: 'Sections' })).toBeNull();
    expect(screen.queryByRole('search')).toBeNull();
    // Neither key does anything here: no bar on top to go to, and leaving
    // the page would lose what is on it (the review).
    const before = document.activeElement;
    fireEvent.keyDown(document.body, { key: '/' });
    fireEvent.keyDown(document.body, { key: 'n' });
    expect(window.location.pathname).toBe('/');
    expect(document.activeElement).toBe(before);
    fireEvent.click(within(bar).getByRole('link', { name: 'Search' }));
    await screen.findByRole('heading', { name: 'Search', level: 1 });
    expect(within(bar).getByRole('link', { name: 'Search' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('a viewer’s bar has Documents and their collections instead', async () => {
    at('/', { collections: [GIVEN], myRestriction: LIMITED }, 'viewer', PHONE);
    const bar = await screen.findByRole('navigation', { name: 'Main' });
    await waitFor(() =>
      expect(namesIn(bar)).toEqual(['Home', 'Search', 'Documents', 'Collections']),
    );
  });

  it('the drawer has the other sections, Settings and Sign out', async () => {
    at('/', EVERYTHING, 'owner', PHONE);
    fireEvent.click(await screen.findByRole('button', { name: 'Menu' }));
    const drawer = await screen.findByRole('dialog', { name: 'Menu' });
    const sections = within(drawer).getByRole('navigation', { name: 'Sections' });
    await waitFor(() =>
      expect(namesIn(sections)).toEqual([
        'Documents',
        'Collections',
        'Inbox, 1 waiting',
        'Sharing',
        'Activity',
        'Trash',
        'Settings',
      ]),
    );
    expect(drawer).toHaveTextContent('Mansoor Seikh');
    expect(within(drawer).getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    await expectAccessible();
    // Choosing one goes there, and the drawer closes.
    fireEvent.click(within(sections).getByRole('link', { name: 'Trash' }));
    const heading = await screen.findByRole('heading', { name: 'Trash', level: 1 });
    expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull();
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it('the drawer is a modal: focus starts in it, stays in it, and goes back to Menu', async () => {
    at('/', EVERYTHING, 'owner', PHONE);
    const menu = await screen.findByRole('button', { name: 'Menu' });
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    menu.focus();
    fireEvent.click(menu);
    const drawer = await screen.findByRole('dialog', { name: 'Menu' });
    expect(drawer).toHaveAttribute('aria-modal', 'true');
    expect(menu).toHaveAttribute('aria-expanded', 'true');
    const first = within(drawer).getByRole('link', { name: 'Documents' });
    await waitFor(() => expect(first).toHaveFocus());
    // Tab past the last goes round to the first; Shift+Tab from the first, to the last.
    const close = within(drawer).getByRole('button', { name: 'Close the menu' });
    const signOut = within(drawer).getByRole('button', { name: 'Sign out' });
    signOut.focus();
    fireEvent.keyDown(signOut, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(signOut).toHaveFocus();
    // Escape closes it, and focus goes back to Menu.
    fireEvent.keyDown(signOut, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull());
    await waitFor(() => expect(menu).toHaveFocus());
    // The close button and a tap beside it do the same.
    fireEvent.click(menu);
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Menu' })).getByRole('button', {
        name: 'Close the menu',
      }),
    );
    await waitFor(() => expect(menu).toHaveFocus());
    fireEvent.click(menu);
    const again = await screen.findByRole('dialog', { name: 'Menu' });
    fireEvent.click(again.parentElement as HTMLElement);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull());
    await waitFor(() => expect(menu).toHaveFocus());
  });

  it('a viewer’s drawer has Documents and Settings', async () => {
    at('/', {}, 'viewer', PHONE);
    fireEvent.click(await screen.findByRole('button', { name: 'Menu' }));
    const drawer = await screen.findByRole('dialog', { name: 'Menu' });
    expect(namesIn(within(drawer).getByRole('navigation', { name: 'Sections' }))).toEqual([
      'Documents',
      'Settings',
    ]);
  });

  it('signs out from the drawer', async () => {
    at('/', EVERYTHING, 'owner', PHONE);
    fireEvent.click(await screen.findByRole('button', { name: 'Menu' }));
    const drawer = await screen.findByRole('dialog', { name: 'Menu' });
    await act(async () => {
      fireEvent.click(within(drawer).getByRole('button', { name: 'Sign out' }));
    });
    await waitFor(() => expect(window.location.pathname).toBe('/sign-in'));
  });

  it('nothing axe finds, the drawer closed', async () => {
    at('/', EVERYTHING, 'owner', PHONE);
    await screen.findByRole('navigation', { name: 'Main' });
    await screen.findByRole('heading', { name: 'Recently added' });
    await expectAccessible();
  });
});

describe('Settings holds settings only', () => {
  /** The rows Settings opens, by title, in order. */
  const rows = (main: HTMLElement) =>
    [...main.querySelectorAll('a.rowbtn .doc-title')].map((t) => t.textContent);

  it('your account, notifications, the household and your data, for an owner', async () => {
    // A restore paused a link: After a restore is Home's, not here.
    const state = at('/settings', {
      ...EVERYTHING,
      shares: [{ id: 'sh-1', state: 'paused', document_title: 'Lease', created_by_name: 'M' }],
    });
    const main = (await screen.findByRole('heading', { name: 'Settings', level: 1 })).closest(
      'main',
    ) as HTMLElement;
    expect(
      within(main)
        .getAllByRole('heading', { level: 2 })
        .map((h) => h.textContent),
    ).toEqual(['Your account', 'Notifications', 'Household', 'Your data']);
    expect(within(main).getByRole('button', { name: 'Change your password' })).toBeInTheDocument();
    expect(
      await within(main).findByRole('heading', { name: 'Two-step sign-in' }),
    ).toBeInTheDocument();
    expect(within(main).getByRole('heading', { name: 'Passkeys' })).toBeInTheDocument();
    expect(within(main).getByRole('heading', { name: 'Signed-in devices' })).toBeInTheDocument();
    expect(within(main).getByRole('heading', { name: 'Export everything' })).toBeInTheDocument();
    expect(rows(main)).toEqual([
      'How you hear about things',
      'Family',
      // The household's rule for Only me documents (5.41): a setting, so here.
      'Household',
      'Kinds of document',
      'Where your files are kept',
      'Where email comes from',
    ]);
    // None of what has a place of its own (the rows above), not even After a
    // restore while it waits; and no Sign out, which is the account menu's.
    await waitFor(() =>
      expect(state.calls.some((c) => c.url === '/api/v1/after-restore')).toBe(false),
    );
    expect(within(main).queryByRole('link', { name: /After a restore/ })).toBeNull();
    expect(within(main).queryByRole('link', { name: /What has been happening/ })).toBeNull();
    expect(within(main).queryByRole('button', { name: 'Sign out' })).toBeNull();
    // Said where they went instead.
    expect(main).toHaveTextContent('Settings holds settings only.');
    expect(within(main).getByRole('link', { name: 'Files sent to you' })).toHaveAttribute(
      'href',
      '/inbox',
    );
    expect(within(main).getByRole('link', { name: 'People outside the family' })).toHaveAttribute(
      'href',
      '/people/outside',
    );
    await expectAccessible();
  });

  it('an adult keeps the kinds of document, and reads the Only me rule, under Household', async () => {
    at('/settings', EVERYTHING, 'adult');
    const main = (await screen.findByRole('heading', { name: 'Settings', level: 1 })).closest(
      'main',
    ) as HTMLElement;
    expect(rows(main)).toEqual(['How you hear about things', 'Household', 'Kinds of document']);
    expect(within(main).getByRole('link', { name: /^Household/ })).toHaveAttribute(
      'href',
      '/settings/household',
    );
    expect(within(main).getByRole('heading', { name: 'Your data', level: 2 })).toBeInTheDocument();
  });

  it.each(['teen', 'viewer'] as const)(
    'a %s has their account and notifications, and no export they would be refused',
    async (role) => {
      at('/settings', EVERYTHING, role);
      const main = (await screen.findByRole('heading', { name: 'Settings', level: 1 })).closest(
        'main',
      ) as HTMLElement;
      expect(
        within(main)
          .getAllByRole('heading', { level: 2 })
          .map((h) => h.textContent),
      ).toEqual(['Your account', 'Notifications']);
      expect(rows(main)).toEqual(['How you hear about things']);
      expect(within(main).queryByRole('heading', { name: 'Export everything' })).toBeNull();
    },
  );

  it('where email comes from is a setting of its own, an owner’s', async () => {
    at('/settings', EVERYTHING);
    fireEvent.click(await screen.findByRole('link', { name: /Where email comes from/ }));
    await screen.findByRole('heading', { name: 'Where email comes from', level: 1 });
    expect(await screen.findByLabelText('Provider')).toBeInTheDocument();
    cleanup();
    at('/settings/email', EVERYTHING, 'adult');
    expect(
      await screen.findByText('Only an owner can change how the vault sends email.'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Provider')).toBeNull();
  });
});

describe('every address Settings had still works (R1)', () => {
  it.each([
    ['/settings/activity', '/activity', 'What has been happening'],
    ['/settings/trash', '/trash', 'Trash'],
    ['/settings/sharing', '/sharing', 'Sharing'],
    ['/settings/sharing/ask?person=m-0', '/sharing/ask?person=m-0', 'Ask for documents'],
    ['/settings/guests', '/people/outside', 'People outside the family'],
    ['/settings/after-restore', '/after-restore', 'After a restore'],
    // Since I1 the Inbox has the person's own uploads too: the files sent
    // to them, which the old address and its email were for, are a tab.
    ['/incoming', '/inbox/sent', 'Files sent to you'],
    ['/incoming/in-1', '/inbox/in-1', 'W-2 2025.pdf'],
  ])('%s is %s, in place of the old one', async (from, to, title) => {
    const before = window.history.length;
    at(from, EVERYTHING);
    await screen.findByRole('heading', { name: title, level: 1 });
    expect(window.location.pathname + window.location.search).toBe(to);
    // Replaced, not added: Back does not bounce off the old address.
    expect(window.history.length).toBe(before);
  });

  it('what the last screen said comes with it', async () => {
    atWidth(WIDE);
    installFakeApi(fresh({ ...EVERYTHING, incoming: [] }));
    signedIn('owner');
    window.history.replaceState({ usr: { said: 'It was refused.' }, key: 'k' }, '', '/incoming');
    render(<App />);
    expect(await screen.findByText('It was refused.')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/inbox/sent');
  });
});

/**
 * What jsdom cannot lay out, held to styles.css: the shell's rules, read
 * from the stylesheet as the share sheets' are (Chromium checked them at
 * 320, 768 and 1280 px, with axe, for R1's screenshots).
 */
describe('the shell’s styles', () => {
  const css = (() => {
    const file = ['src/styles.css', 'apps/web/src/styles.css']
      .map((p) => resolve(process.cwd(), p))
      .find((p) => existsSync(p));
    return (file ? readFileSync(file, 'utf8') : '').replace(/\/\*[\s\S]*?\*\//g, '');
  })();
  /** The declarations of the rule with exactly this selector. */
  const rule = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
  };

  it('the bottom bar fits at 320 px: each word wraps in its share, never off the edge', () => {
    const item = rule('.nav-item');
    expect(item).toMatch(/flex:\s*1 1 0/);
    expect(item).toMatch(/min-width:\s*0/);
    expect(item).toMatch(/text-align:\s*center/);
    expect(rule('.fab')).toMatch(/flex:\s*none/);
  });

  it('narrowed, each icon’s name shows beside it on hover and on focus, and is not read twice', () => {
    // Drawn with empty alternative text: generated content is part of a
    // link's name otherwise, "Home Home" (the review; Chromium checked).
    expect(rule('.shell-mid .side-link::after')).toMatch(
      /content:\s*attr\(data-label\)\s*\/\s*(''|"")/,
    );
    expect(rule('.shell-mid .side-link::after')).toMatch(/opacity:\s*0/);
    expect(
      rule('.shell-mid .side-link:hover::after,\n.shell-mid .side-link:focus-visible::after'),
    ).toMatch(/opacity:\s*1/);
    // Over whatever the page positions beside it (a preview, Search's bar),
    // and under the bar on top and the menus.
    const z = (selector: string) => Number(/z-index:\s*(\d+)/.exec(rule(selector))?.[1]);
    expect(z('.shell-mid .sidebar')).toBeGreaterThan(z('.select-bar'));
    expect(z('.shell-mid .sidebar')).toBeLessThan(z('.app-bar'));
    expect(z('.shell-mid .sidebar')).toBeLessThan(z('.menu-layer'));
  });

  it('the skip link is out of sight until it has focus', () => {
    expect(rule('.skip-link')).toMatch(/top:\s*-\d+px/);
    expect(rule('.skip-link:focus')).toMatch(/top:\s*\d+px/);
  });

  it('beside the sidebar, forms and reading keep a readable width; lists go wider', () => {
    expect(rule('.shell-wide .page,\n.shell-mid .page')).toMatch(/max-width:\s*720px/);
    expect(rule('.shell-wide .page.page-wide,\n.shell-mid .page.page-wide')).toMatch(
      /max-width:\s*1120px/,
    );
    expect(rule('.shell-wide .page-wide > p,\n.shell-mid .page-wide > p')).toMatch(
      /max-width:\s*72ch/,
    );
  });

  it('what sticks to the top of a page sits under the bar on top, and the reader fits the window', () => {
    expect(rule('.app-bar')).toMatch(/position:\s*sticky/);
    expect(rule('.shell .select-bar')).toMatch(/top:\s*var\(--shell-top\)/);
    expect(rule('.shell .page.reader')).toMatch(/height:\s*calc\(100dvh - var\(--shell-chrome\)\)/);
  });

  it('on a phone the bar on top stays, and the reader is the window less both bars exactly (the review)', () => {
    const bar = rule('.phone-bar');
    expect(bar).toMatch(/position:\s*sticky/);
    expect(bar).toMatch(/top:\s*0/);
    expect(bar).toMatch(/height:\s*var\(--phone-bar\)/);
    const phone = rule('.shell-phone');
    expect(phone).toMatch(/--shell-top:\s*var\(--phone-bar\)/);
    expect(phone).toMatch(/--shell-chrome:\s*calc\(var\(--phone-bar\) \+ var\(--phone-bottom\)\)/);
    expect(rule('.shell-phone .shell-content')).toMatch(/padding-bottom:\s*var\(--phone-bottom\)/);
  });

  it('a focused control or an address’s target is never scrolled under a bar (WCAG 2.4.11, the review)', () => {
    const number = (pattern: RegExp, selector: string) =>
      Number(pattern.exec(rule(selector))?.[1] ?? 0);
    const top = number(/--shell-top:\s*(\d+)px/, '.shell-wide,\n.shell-mid');
    expect(top).toBe(64);
    expect(
      number(/scroll-padding-top:\s*(\d+)px/, 'html:has(.shell-wide),\nhtml:has(.shell-mid)'),
    ).toBeGreaterThan(top);
    expect(number(/scroll-padding-top:\s*(\d+)px/, 'html:has(.shell-phone)')).toBeGreaterThan(
      number(/--phone-bar:\s*(\d+)px/, '.shell-phone'),
    );
    expect(rule('html:has(.shell-phone)')).toMatch(/scroll-padding-bottom:\s*calc\(96px/);
  });
});
