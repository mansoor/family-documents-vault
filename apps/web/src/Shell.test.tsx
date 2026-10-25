import { refusalFor } from '@fdv/shared';
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
 * The app's shell (Phase 6, R1): a bar on top across the window from 768 px,
 * the household's name at its left (0.7.0), and a sidebar under it, its
 * icons alone below 1024 px; and on a phone today's bottom bar
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
  // Settings → Tags (0.9.0, T1).
  tagManagement: true,
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
    // Wide, Settings opens on its first section.
    await screen.findByRole('heading', { name: 'Your account', level: 1 });
    expect(current()).toEqual(['Settings']);
    // A part of a section is the section's: a document is Documents', a
    // settings page Settings'.
    fireEvent.click(screen.getByRole('link', { name: /^Notifications/ }));
    await screen.findByRole('heading', { name: 'Notifications', level: 1 });
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
    for (const px of [WIDE, MID]) {
      at('/', EVERYTHING, 'owner', px);
      const nav = await sidebar();
      await screen.findByRole('heading', { name: 'Recently added' });
      // The bar on top is the shell's own, above the sidebar and the page,
      // with the household's name in it (0.7.0): the sidebar has none.
      const bar = appBar();
      expect(bar.parentElement).toBe(document.querySelector('.shell'));
      expect(bar.closest('main')).toBeNull();
      expect(within(bar).getByRole('link', { name: /^The Seikh family/ })).toHaveAttribute(
        'href',
        '/',
      );
      expect(within(nav).queryByText('The Seikh family')).toBeNull();
      expect(within(bar).getByRole('search')).toBeInTheDocument();
      expect(screen.getByRole('main')).toBeInTheDocument();
      await expectAccessible();
      cleanup();
    }
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
      // The old address: the place, in its section.
      await screen.findByRole('heading', { name: 'Your account', level: 1 });
      expect(window.location.pathname + window.location.hash).toBe('/settings/account#two-step');
      const card = document.getElementById('two-step') as HTMLElement;
      await waitFor(() => expect(card).toHaveFocus());
      expect(scrolled).toContain(card);
      expect(screen.getByRole('heading', { name: 'Your account', level: 1 })).not.toHaveFocus();
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
    const box = () => screen.getByRole('checkbox', { name: 'Single-key shortcuts' });
    await screen.findByRole('checkbox', { name: 'Single-key shortcuts' });
    expect(box()).toBeChecked();
    expect(box()).toHaveAccessibleDescription(/\/ goes to the search box and n to Add/);
    // Every key the switch turns off, named (R5).
    expect(box()).toHaveAccessibleDescription(/j and k .* \[ and \] .* \+ and −/);
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
    await screen.findByRole('checkbox', { name: 'Single-key shortcuts' });
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
    const box = () => screen.getByRole('checkbox', { name: 'Single-key shortcuts' });
    await screen.findByRole('checkbox', { name: 'Single-key shortcuts' });
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

describe('Settings in three groups, with a menu beside the page (0.9.0, the owner’s ask)', () => {
  /** The menu beside the page. */
  const subMenu = async () => screen.findByRole('navigation', { name: 'Settings sections' });
  /** Each group the menu offers, by its heading, with its sections by name. */
  const groupsIn = (nav: HTMLElement): Array<[string, string[]]> =>
    [...nav.querySelectorAll<HTMLElement>('ul[aria-labelledby]')].map((list) => [
      // Each list is named by its group's heading.
      document.getElementById(list.getAttribute('aria-labelledby') ?? '')?.textContent ?? '',
      within(list)
        .getAllByRole('link')
        .map((l) => l.querySelector('.settings-nav-label, .doc-title')?.textContent ?? ''),
    ]);
  /** The sections, in order, whatever their group. */
  const sectionNames = (nav: HTMLElement) => groupsIn(nav).flatMap(([, names]) => names);
  /** The rows a section opens, by title, in order. */
  const rows = (main: HTMLElement) =>
    [...main.querySelectorAll('a.rowbtn .doc-title')].map((t) => t.textContent);

  const GROUPS: Record<Role, Array<[string, string[]]>> = {
    owner: [
      ['You', ['Your account', 'Notifications', 'Your data']],
      ['Household', ['Privacy', 'Time zone', 'Kinds of document', 'Tags']],
      [
        'Server and reading · owners',
        ['Storage', 'Email, in and out', 'Scanner folder', 'Reading and the check'],
      ],
    ],
    adult: [
      ['You', ['Your account', 'Notifications', 'Your data']],
      ['Household', ['Privacy', 'Time zone', 'Kinds of document', 'Tags']],
    ],
    // A teen: their own tags, and the family's clock to read; no export.
    teen: [
      ['You', ['Your account', 'Notifications']],
      ['Household', ['Time zone', 'Tags']],
    ],
    viewer: [
      ['You', ['Your account', 'Notifications']],
      ['Household', ['Time zone']],
    ],
  };
  const SECTIONS = (role: Role) => GROUPS[role].flatMap(([, names]) => names);

  it.each(['owner', 'adult', 'teen', 'viewer'] as const)(
    'at 1280, a %s’s Settings opens on its first section, the menu beside it in its groups, only their sections',
    async (role) => {
      const before = window.history.length;
      at('/settings', EVERYTHING, role);
      await waitFor(() => expect(window.location.pathname).toBe('/settings/account'));
      // In place of /settings, not a step after it.
      expect(window.history.length).toBe(before);
      // Asked for again: the page it opened on is drawn afresh.
      await waitFor(async () =>
        expect(
          within(await subMenu()).getByRole('link', { name: /^Your account/ }),
        ).toHaveAttribute('aria-current', 'page'),
      );
      const nav = await subMenu();
      // Each group heading only where one of its sections is theirs.
      expect(groupsIn(nav)).toEqual(GROUPS[role]);
      // Each group's list named by it; none of them a heading, so the page's
      // own h1, after the menu, is the first.
      for (const [name] of GROUPS[role]) {
        expect(
          within(nav).getByRole('list', { name: (n) => n.replace(/\s+/g, ' ') === name }),
        ).toBeVisible();
      }
      expect(within(nav).queryAllByRole('heading')).toEqual([]);
      // Links, the current one marked: not tabs.
      expect(within(nav).queryByRole('tab')).toBeNull();
      expect(
        within(nav)
          .getAllByRole('link')
          .filter((l) => l.hasAttribute('aria-current')),
      ).toHaveLength(1);
      // Each link its icon, hidden from a screen reader: the name is the words.
      for (const link of within(nav)
        .getAllByRole('link')
        .filter((l) => l.closest('ul[aria-labelledby]'))) {
        expect(link.querySelector('svg.settings-icon')).toHaveAttribute('aria-hidden', 'true');
      }
      expect(await screen.findByRole('heading', { level: 1, name: 'Your account' })).toBeVisible();
      expect(document.title).toBe('Settings: your account – Family Document Vault');
      // The shell's own Settings, one entry, current.
      expect(within(await sidebar()).getByRole('link', { name: 'Settings' })).toHaveAttribute(
        'aria-current',
        'page',
      );
      await expectAccessible();
    },
  );

  it.each(['owner', 'adult', 'teen', 'viewer'] as const)(
    'at 320, a %s’s Settings is the list of their groups, each headed; each section opens its page, with Back to Settings',
    async (role) => {
      at('/settings', EVERYTHING, role, 320);
      await screen.findByRole('heading', { level: 1, name: 'Settings' });
      const list = screen.getByRole('navigation', { name: 'Settings sections' });
      expect(groupsIn(list)).toEqual(GROUPS[role]);
      // Here, after the page's h1: each group headed.
      expect(
        within(list)
          .getAllByRole('heading', { level: 2 })
          .map((h) => h.textContent),
      ).toEqual(GROUPS[role].map(([name]) => name));
      expect(window.location.pathname).toBe('/settings');
      expect(document.title).toBe('Settings – Family Document Vault');
      // No menu to widen on a phone.
      expect(screen.queryByRole('separator', { name: 'Width of the Settings menu' })).toBeNull();
      await expectAccessible();
      fireEvent.click(within(list).getByRole('link', { name: /^Notifications/ }));
      expect(await screen.findByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();
      // No menu on a phone: the way back is the page's own.
      expect(screen.queryByRole('navigation', { name: 'Settings sections' })).toBeNull();
      expect(screen.getByRole('link', { name: 'Back to Settings' })).toHaveAttribute(
        'href',
        '/settings',
      );
      await waitFor(() =>
        expect(screen.getByRole('heading', { level: 1, name: 'Notifications' })).toHaveFocus(),
      );
    },
  );

  it('a page under a section, or a part of one, keeps its address; the menu marks its section', async () => {
    for (const [path, section, current, heading] of [
      ['/settings/family', 'Privacy', 'true', 'Family'],
      ['/settings/kinds/new', 'Kinds of document', 'true', 'Add a kind'],
      ['/settings/storage', 'Storage', 'page', 'Storage'],
      ['/settings/email', 'Email, in and out', 'page', 'Email, in and out'],
      ['/settings/email-in', 'Email, in and out', 'page', 'Email, in and out'],
      ['/settings/scanner', 'Scanner folder', 'page', 'Scanner folder'],
      ['/settings/reading', 'Reading and the check', 'page', 'Reading and the check'],
      ['/settings/reading-check', 'Reading and the check', 'page', 'Reading and the check'],
    ] as const) {
      at(path, { ...EVERYTHING, identities: {} });
      const nav = await subMenu();
      // A kind's editor draws its bar again once the kinds have loaded.
      await waitFor(() =>
        expect(screen.getByRole('heading', { level: 1, name: heading })).toBeVisible(),
      );
      expect(window.location.pathname).toBe(path);
      const marked = within(nav)
        .getAllByRole('link')
        .filter((l) => l.hasAttribute('aria-current'));
      expect(
        marked.map((l) => [
          l.querySelector('.settings-nav-label')?.textContent,
          l.getAttribute('aria-current'),
        ]),
      ).toEqual([[section, current]]);
      expect(within(await sidebar()).getByRole('link', { name: 'Settings' })).toHaveAttribute(
        'aria-current',
        'page',
      );
      cleanup();
    }
  });

  it('each section has its own page title and heading; moving to one puts the focus on its heading', async () => {
    at('/settings/account', EVERYTHING);
    const nav = await subMenu();
    await screen.findByRole('heading', { level: 1, name: 'Your account' });
    for (const [name, path, heading, title] of [
      ['Notifications', '/settings/notifications', 'Notifications', 'Settings: notifications'],
      ['Your data', '/settings/data', 'Your data', 'Settings: your data'],
      ['Privacy', '/settings/privacy', 'Privacy', 'Settings: privacy'],
      ['Time zone', '/settings/time-zone', 'Time zone', 'Settings: time zone'],
      ['Kinds of document', '/settings/kinds', 'Kinds of document', 'Settings: kinds of document'],
      ['Tags', '/settings/tags', 'Tags', 'Settings: tags'],
      ['Storage', '/settings/storage', 'Storage', 'Settings: storage'],
      ['Email, in and out', '/settings/email', 'Email, in and out', 'Settings: email, in and out'],
      ['Scanner folder', '/settings/scanner', 'Scanner folder', 'Settings: scanner folder'],
      [
        'Reading and the check',
        '/settings/reading',
        'Reading and the check',
        'Settings: reading and the check',
      ],
      ['Your account', '/settings/account', 'Your account', 'Settings: your account'],
    ] as const) {
      fireEvent.click(within(nav).getByRole('link', { name: new RegExp(`^${name}`) }));
      await waitFor(() => expect(window.location.pathname).toBe(path));
      const h1 = await screen.findByRole('heading', { level: 1, name: heading });
      await waitFor(() => expect(h1).toHaveFocus());
      expect(document.title).toBe(`${title} – Family Document Vault`);
      expect(within(nav).getByRole('link', { name: new RegExp(`^${name}`) })).toHaveAttribute(
        'aria-current',
        'page',
      );
    }
  });

  it('an old address with a place on the page goes to that place in its section, at any width', async () => {
    for (const px of [WIDE, 320]) {
      at('/settings#two-step', EVERYTHING, 'owner', px);
      await waitFor(() => expect(window.location.pathname).toBe('/settings/account'));
      expect(window.location.hash).toBe('#two-step');
      expect(await screen.findByRole('heading', { name: 'Two-step sign-in' })).toBeVisible();
      cleanup();
    }
  });

  it('widened past 768 px on the list, Settings opens its first section', async () => {
    at('/settings', EVERYTHING, 'owner', 320);
    await screen.findByRole('heading', { level: 1, name: 'Settings' });
    resizeTo(WIDE);
    await waitFor(() => expect(window.location.pathname).toBe('/settings/account'));
    expect(await subMenu()).toBeVisible();
  });

  it('every setting there was is in a section, for an owner', async () => {
    // A restore paused a link: After a restore is Home's, not here.
    const state = at('/settings/account', {
      ...EVERYTHING,
      shares: [{ id: 'sh-1', state: 'paused', document_title: 'Lease', created_by_name: 'M' }],
    });
    let main = (await screen.findByRole('heading', { level: 1, name: 'Your account' })).closest(
      'main',
    ) as HTMLElement;
    // Your account: the password, two-step sign-in, passkeys, the devices, the single keys.
    expect(within(main).getByRole('button', { name: 'Change your password' })).toBeInTheDocument();
    expect(await within(main).findByRole('heading', { name: 'Two-step sign-in' })).toBeVisible();
    expect(within(main).getByRole('heading', { name: 'Passkeys' })).toBeVisible();
    expect(within(main).getByRole('heading', { name: 'Signed-in devices' })).toBeVisible();
    expect(within(main).getByRole('checkbox', { name: 'Single-key shortcuts' })).toBeVisible();
    await expectAccessible();
    const go = async (name: string, heading: string) => {
      fireEvent.click(within(await subMenu()).getByRole('link', { name: new RegExp(`^${name}`) }));
      return (await screen.findByRole('heading', { level: 1, name: heading })).closest(
        'main',
      ) as HTMLElement;
    };
    // Notifications: how you hear about things.
    main = await go('Notifications', 'Notifications');
    expect(within(main).getByRole('heading', { name: 'What you want' })).toBeVisible();
    await expectAccessible();
    // Privacy (Household until 0.8.0): the Only me rule, here; who sees
    // identity details, a page of its own.
    main = await go('Privacy', 'Privacy');
    expect(
      await within(main).findByRole('heading', {
        name: 'Only me documents and links outside the family',
      }),
    ).toBeVisible();
    expect(rows(main)).toEqual(['Family']);
    expect(within(main).getByRole('list', { name: 'More about privacy' })).toBeVisible();
    await expectAccessible();
    // Kinds of document: a section of its own since 0.8.0, its editor in it.
    main = await go('Kinds of document', 'Kinds of document');
    expect(within(main).getByRole('link', { name: 'Add a kind' })).toBeVisible();
    await expectAccessible();
    // Your data: the export.
    main = await go('Your data', 'Your data');
    expect(within(main).getByRole('button', { name: 'Make an export' })).toBeVisible();
    await expectAccessible();
    // Server and reading (For owners until 0.9.0): where files are kept, the
    // two parts of Email, in and out, the scanner folder (S3), and the two
    // parts of Reading and the check (R2, R4, R0) — every page For owners listed.
    main = await go('Storage', 'Storage');
    // Named as the menu names it; what it is, the line beneath.
    expect(within(main).getByText('Where your files are kept')).toHaveClass('settings-subtitle');
    expect(within(main).queryByRole('heading', { name: 'Where your files are kept' })).toBeNull();
    expect(within(main).getByRole('list', { name: 'Places' })).toBeInTheDocument();
    await expectAccessible();
    main = await go('Email, in and out', 'Email, in and out');
    expect(
      within(main)
        .getAllByRole('heading', { level: 2 })
        .map((h) => h.textContent),
    ).toEqual(['Where email comes from', 'Email in']);
    expect(within(main).getByRole('region', { name: 'Where email comes from' })).toBeVisible();
    expect(within(main).getByRole('region', { name: 'Email in' })).toBeVisible();
    await expectAccessible();
    await go('Scanner folder', 'Scanner folder');
    await expectAccessible();
    main = await go('Reading and the check', 'Reading and the check');
    expect(
      within(main)
        .getAllByRole('heading', { level: 2 })
        .map((h) => h.textContent),
    ).toEqual(['Reading', 'Reading check']);
    expect(
      await within(main).findByRole('heading', { name: 'The vault’s reading model', level: 3 }),
    ).toBeVisible();
    await expectAccessible();
    // What has a place of its own is said beside the sections, never here.
    const nav = await subMenu();
    expect(nav).toHaveTextContent('Settings holds settings only.');
    expect(within(nav).getByRole('link', { name: 'Files sent to you' })).toHaveAttribute(
      'href',
      '/inbox/sent',
    );
    expect(within(nav).getByRole('link', { name: 'People outside the family' })).toHaveAttribute(
      'href',
      '/people/outside',
    );
    await waitFor(() =>
      expect(state.calls.some((c) => c.url === '/api/v1/after-restore')).toBe(false),
    );
    expect(screen.queryByRole('link', { name: /After a restore/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });

  it('an adult reads the Only me rule under Privacy and keeps the kinds of document, a section of their own; their data is theirs', async () => {
    at('/settings/privacy', EVERYTHING, 'adult');
    const main = (await screen.findByRole('heading', { level: 1, name: 'Privacy' })).closest(
      'main',
    ) as HTMLElement;
    // Family is an owner's; the kinds are not under Privacy any more.
    expect(rows(main)).toEqual([]);
    expect(
      within(await subMenu()).getByRole('link', { name: /^Kinds of document/ }),
    ).toHaveAttribute('href', '/settings/kinds');
    expect(
      await within(main).findByRole('heading', {
        name: 'Only me documents and links outside the family',
      }),
    ).toBeVisible();
    cleanup();
    at('/settings/data', EVERYTHING, 'adult');
    expect(await screen.findByRole('button', { name: 'Make an export' })).toBeVisible();
  });

  it.each(['teen', 'viewer'] as const)(
    'a %s has their account and notifications; an address for a section not theirs refuses, as before',
    async (role) => {
      at('/settings/data', EVERYTHING, role);
      expect(await screen.findByText('Only an adult can export the whole vault.')).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Make an export' })).toBeNull();
      cleanup();
      at('/settings/owners', EVERYTHING, role);
      expect(
        await screen.findByText('Only an owner can change where your files are kept.'),
      ).toBeVisible();
      expect(screen.queryByRole('link', { name: /Where your files are kept/ })).toBeNull();
      expect(screen.queryByText(/Server and reading/)).toBeNull();
    },
  );

  it.each(['teen', 'viewer'] as const)(
    'a %s, who does not manage the kinds of document, is not offered Kinds of document, nor Privacy (0.8.0)',
    async (role) => {
      at('/settings/account', EVERYTHING, role);
      const nav = await subMenu();
      await screen.findByRole('heading', { level: 1, name: 'Your account' });
      expect(within(nav).queryByRole('link', { name: /^Kinds of document/ })).toBeNull();
      expect(within(nav).queryByRole('link', { name: /^Privacy/ })).toBeNull();
      cleanup();
      // At 320 too, in the list of the sections.
      at('/settings', EVERYTHING, role, 320);
      const list = await screen.findByRole('navigation', { name: 'Settings sections' });
      expect(within(list).queryByRole('link', { name: /^Kinds of document/ })).toBeNull();
      cleanup();
      // Its address refuses, as before, with the way back to Settings.
      at('/settings/kinds', EVERYTHING, role, 320);
      expect(await screen.findByText(refusalFor('types.manage'))).toBeVisible();
      expect(screen.queryByRole('link', { name: 'Add a kind' })).toBeNull();
      expect(screen.getByRole('link', { name: 'Back to Settings' })).toHaveAttribute(
        'href',
        '/settings',
      );
    },
  );

  it('on a phone, each section’s Back goes to Settings; Family’s to Privacy', async () => {
    at('/settings/kinds', EVERYTHING, 'adult', 320);
    await screen.findByRole('heading', { level: 1, name: 'Kinds of document' });
    expect(screen.getByRole('link', { name: 'Back to Settings' })).toHaveAttribute(
      'href',
      '/settings',
    );
    expect(screen.queryByRole('link', { name: 'Back to Household' })).toBeNull();
    cleanup();
    at('/settings', EVERYTHING, 'owner', 320);
    const list = await screen.findByRole('navigation', { name: 'Settings sections' });
    expect(sectionNames(list)).toEqual(SECTIONS('owner'));
    cleanup();
    // Server and reading's pages, sections now: Back to Settings, never to For owners.
    for (const [path, heading] of [
      ['/settings/storage', 'Storage'],
      ['/settings/email-in', 'Email, in and out'],
      ['/settings/scanner', 'Scanner folder'],
      ['/settings/reading-check', 'Reading and the check'],
    ] as const) {
      at(path, EVERYTHING, 'owner', 320);
      await screen.findByRole('heading', { level: 1, name: heading });
      expect(screen.getByRole('link', { name: 'Back to Settings' })).toHaveAttribute(
        'href',
        '/settings',
      );
      expect(screen.queryByRole('link', { name: 'Back to For owners' })).toBeNull();
      cleanup();
    }
    at('/settings/family', { ...EVERYTHING, identities: {} }, 'owner', 320);
    await screen.findByRole('heading', { level: 1, name: 'Family' });
    expect(screen.getByRole('link', { name: 'Back to Privacy' })).toHaveAttribute(
      'href',
      '/settings/privacy',
    );
  });
});

describe('a page in two parts: each part’s old address lands on it (0.9.0)', () => {
  it.each([
    ['/settings/email', 'Email, in and out', ['Where email comes from', 'Email in']],
    ['/settings/reading', 'Reading and the check', ['Reading', 'Reading check']],
  ] as const)('%s holds both parts, headed, each a region', async (path, title, parts) => {
    at(path, EVERYTHING);
    const h1 = await screen.findByRole('heading', { level: 1, name: title });
    const main = h1.closest('main') as HTMLElement;
    expect(
      within(main)
        .getAllByRole('heading', { level: 2 })
        .map((h) => h.textContent),
    ).toEqual([...parts]);
    for (const part of parts) {
      expect(within(main).getByRole('region', { name: part })).toBeInTheDocument();
    }
    await expectAccessible();
  });

  it('the first part’s address opens the page at its top; the second’s, at the second part, its heading given the focus', async () => {
    at('/settings/email-in', EVERYTHING);
    const second = await screen.findByRole('heading', { level: 2, name: 'Email in' });
    await waitFor(() => expect(second).toHaveFocus());
    expect(screen.getByRole('heading', { level: 1, name: 'Email, in and out' })).toBeVisible();
    cleanup();
    at('/settings/reading-check', EVERYTHING);
    const check = await screen.findByRole('heading', { level: 2, name: 'Reading check' });
    await waitFor(() => expect(check).toHaveFocus());
    cleanup();
    at('/settings/reading', EVERYTHING);
    await screen.findByRole('heading', { level: 1, name: 'Reading and the check' });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole('heading', { level: 2, name: 'Reading' })).not.toHaveFocus();
  });

  it('the second part is kept in view while the part above it loads and grows, until the person scrolls or presses a key', async () => {
    const watchers: Array<{ grew: () => void; off: boolean }> = [];
    class Watch {
      w: { grew: () => void; off: boolean };
      constructor(grew: () => void) {
        this.w = { grew, off: false };
        watchers.push(this.w);
      }
      observe() {}
      disconnect() {
        this.w.off = true;
      }
    }
    const before = globalThis.ResizeObserver;
    globalThis.ResizeObserver = Watch as unknown as typeof ResizeObserver;
    const scrolled = vi.fn();
    const was = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrolled,
    });
    try {
      at('/settings/reading-check', EVERYTHING);
      const check = await screen.findByRole('heading', { level: 2, name: 'Reading check' });
      await waitFor(() => expect(check).toHaveFocus());
      const mine = () => scrolled.mock.contexts.filter((c) => c === check).length;
      expect(mine()).toBe(1);
      const watch = watchers.at(-1);
      expect(watch?.off).toBe(false);
      // The part above grew: the heading moved down, and is gone to again.
      check.getBoundingClientRect = () => ({ top: 600 }) as DOMRect;
      watch?.grew();
      expect(mine()).toBe(2);
      // Not moved: left where it is.
      watch?.grew();
      expect(mine()).toBe(2);
      // The person takes over: no more.
      fireEvent.keyDown(window, { key: 'ArrowDown' });
      expect(watch?.off).toBe(true);
    } finally {
      if (was) Object.defineProperty(Element.prototype, 'scrollIntoView', was);
      else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      globalThis.ResizeObserver = before;
    }
  });

  it('gone to from elsewhere in the app: the second part’s heading has the focus, and the shell leaves it there', async () => {
    at('/settings/account', EVERYTHING);
    await screen.findByRole('heading', { level: 1, name: 'Your account' });
    act(() => {
      window.history.pushState({}, '', '/settings/reading-check');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    const check = await screen.findByRole('heading', { level: 2, name: 'Reading check' });
    await waitFor(() => expect(check).toHaveFocus());
    await new Promise((r) => setTimeout(r, 50));
    expect(check).toHaveFocus();
    // And from the page's first part to its second, the page kept.
    act(() => {
      window.history.pushState({}, '', '/settings/email');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    const h1 = await screen.findByRole('heading', { level: 1, name: 'Email, in and out' });
    await waitFor(() => expect(h1).toHaveFocus());
    act(() => {
      window.history.pushState({}, '', '/settings/email-in');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: 'Email in' })).toHaveFocus(),
    );
  });

  it('Notifications’ link to where email comes from opens Email, in and out at its top', async () => {
    at('/settings/notifications', EVERYTHING);
    fireEvent.click(await screen.findByRole('link', { name: 'Where email comes from' }));
    await waitFor(() => expect(window.location.pathname).toBe('/settings/email'));
    const h1 = await screen.findByRole('heading', { level: 1, name: 'Email, in and out' });
    await waitFor(() => expect(h1).toHaveFocus());
    expect(await screen.findByLabelText('Provider')).toBeInTheDocument();
  });

  it('an owner’s: an adult is refused at either address, and nothing of it is asked of the vault', async () => {
    for (const path of ['/settings/email', '/settings/email-in']) {
      const state = at(path, EVERYTHING, 'adult');
      expect(
        await screen.findByText('Only an owner can change the vault’s email settings.'),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText('Provider')).toBeNull();
      await new Promise((r) => setTimeout(r, 50));
      expect(state.calls.some((c) => /\/smtp|\/mail-in/.test(c.url))).toBe(false);
      cleanup();
    }
  });
});

describe('the Settings menu, as wide as its person makes it (0.9.0)', () => {
  const bar = () => screen.findByRole('separator', { name: 'Width of the Settings menu' });
  /** The menu the line widens, in the Settings sections landmark with it. */
  const menu = () =>
    screen
      .getByRole('navigation', { name: 'Settings sections' })
      .querySelector('#settings-menu') as HTMLElement;

  it('a window splitter: about 248 px to start, 200 to 360, moved with the keys', async () => {
    at('/settings/account', EVERYTHING);
    const line = await bar();
    expect(line).toHaveAttribute('aria-orientation', 'vertical');
    expect(line).toHaveAttribute('aria-valuenow', '248');
    expect(line).toHaveAttribute('aria-valuemin', '200');
    expect(line).toHaveAttribute('aria-valuemax', '360');
    expect(line).toHaveAttribute('aria-controls', 'settings-menu');
    expect(line).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toContainElement(line);
    expect(menu().style.width).toBe('248px');
    fireEvent.keyDown(line, { key: 'ArrowRight' });
    expect(line).toHaveAttribute('aria-valuenow', '264');
    expect(menu().style.width).toBe('264px');
    fireEvent.keyDown(line, { key: 'ArrowRight', shiftKey: true });
    expect(line).toHaveAttribute('aria-valuenow', '328');
    fireEvent.keyDown(line, { key: 'ArrowLeft' });
    expect(line).toHaveAttribute('aria-valuenow', '312');
    // The bounds: no wider than 360, no narrower than 200.
    fireEvent.keyDown(line, { key: 'End' });
    expect(line).toHaveAttribute('aria-valuenow', '360');
    fireEvent.keyDown(line, { key: 'ArrowRight' });
    expect(line).toHaveAttribute('aria-valuenow', '360');
    fireEvent.keyDown(line, { key: 'Home' });
    expect(line).toHaveAttribute('aria-valuenow', '200');
    fireEvent.keyDown(line, { key: 'ArrowLeft', shiftKey: true });
    expect(line).toHaveAttribute('aria-valuenow', '200');
    expect(menu().style.width).toBe('200px');
    await expectAccessible();
  });

  it('dragged, within its bounds; remembered for each person, on this device', async () => {
    at('/settings/account', EVERYTHING);
    const line = await bar();
    fireEvent.pointerDown(line, { clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(line, { clientX: 340, pointerId: 1 });
    // As it moves: the menu with it.
    expect(menu().style.width).toBe('288px');
    fireEvent.pointerUp(line, { clientX: 352, pointerId: 1 });
    expect(line).toHaveAttribute('aria-valuenow', '300');
    expect(localStorage.getItem('fdv.settings.menu-width.me')).toBe('300');
    // Dragged far past the widest: the widest.
    fireEvent.pointerDown(line, { clientX: 300, pointerId: 2 });
    fireEvent.pointerUp(line, { clientX: 900, pointerId: 2 });
    expect(line).toHaveAttribute('aria-valuenow', '360');
    fireEvent.keyDown(line, { key: 'ArrowLeft' });
    expect(localStorage.getItem('fdv.settings.menu-width.me')).toBe('344');
    cleanup();
    // Back again, on another page of Settings: as it was left.
    at('/settings/privacy', EVERYTHING);
    expect(await bar()).toHaveAttribute('aria-valuenow', '344');
    expect(menu().style.width).toBe('344px');
    cleanup();
    // One kept out of bounds still wins, within them.
    localStorage.setItem('fdv.settings.menu-width.me', '9000');
    at('/settings/account', EVERYTHING);
    expect(await bar()).toHaveAttribute('aria-valuenow', '360');
    cleanup();
    localStorage.setItem('fdv.settings.menu-width.me', '50');
    at('/settings/account', EVERYTHING, 'owner', MID);
    expect(await bar()).toHaveAttribute('aria-valuenow', '200');
    cleanup();
    // Nonsense kept: as it starts.
    localStorage.setItem('fdv.settings.menu-width.me', 'wide');
    at('/settings/account', EVERYTHING);
    expect(await bar()).toHaveAttribute('aria-valuenow', '248');
  });

  it('on a tablet (768–1023 px) it starts at its narrowest, 200 px, and from 1024 px at 248; a width kept wins at both', async () => {
    at('/settings/account', EVERYTHING, 'owner', MID);
    const line = await bar();
    expect(line).toHaveAttribute('aria-valuenow', '200');
    expect(menu().style.width).toBe('200px');
    // Its bounds are the same.
    expect(line).toHaveAttribute('aria-valuemin', '200');
    expect(line).toHaveAttribute('aria-valuemax', '360');
    // The window grown past 1024 px, nothing kept: 248; and back again, 200.
    resizeTo(WIDE);
    await waitFor(() => expect(menu().style.width).toBe('248px'));
    resizeTo(MID);
    await waitFor(() => expect(menu().style.width).toBe('200px'));
    // Moved: kept, and it wins at either size.
    fireEvent.keyDown(await bar(), { key: 'ArrowRight', shiftKey: true });
    expect(menu().style.width).toBe('264px');
    expect(localStorage.getItem('fdv.settings.menu-width.me')).toBe('264');
    resizeTo(WIDE);
    await waitFor(() => expect(menu().style.width).toBe('264px'));
    cleanup();
    localStorage.setItem('fdv.settings.menu-width.me', '300');
    at('/settings/account', EVERYTHING, 'owner', MID);
    expect(await bar()).toHaveAttribute('aria-valuenow', '300');
  });

  it('the current section is brought into sight in a menu that scrolls; one in sight is left be', async () => {
    const rect = (el: Element) =>
      el.id === 'settings-menu'
        ? { top: 64, bottom: 464, height: 400 }
        : el.matches('a[aria-current][href="/settings/reading"]')
          ? { top: 764, bottom: 824, height: 60 }
          : el.matches('a[aria-current]')
            ? { top: 100, bottom: 160, height: 60 }
            : { top: 0, bottom: 0, height: 0 };
    const rects = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      return rect(this) as DOMRect;
    });
    const moved: number[] = [];
    Object.defineProperty(HTMLDivElement.prototype, 'scrollTop', {
      configurable: true,
      get: () => 0,
      set(this: HTMLDivElement, v: number) {
        if (this.id === 'settings-menu') moved.push(v);
      },
    });
    try {
      at('/settings/reading-check', EVERYTHING);
      await screen.findByRole('heading', { level: 1, name: 'Reading and the check' });
      // 700 below the menu's top, less half of what is left around it.
      await waitFor(() => expect(moved).toEqual([700 - (400 - 60) / 2]));
      cleanup();
      moved.length = 0;
      at('/settings/account', EVERYTHING);
      await screen.findByRole('heading', { level: 1, name: 'Your account' });
      await new Promise((r) => setTimeout(r, 50));
      expect(moved).toEqual([]);
    } finally {
      rects.mockRestore();
      delete (HTMLDivElement.prototype as { scrollTop?: number }).scrollTop;
    }
  });

  it('storage blocked: as it starts, still moved, nothing thrown', async () => {
    // Refused for the menu's width alone: the session itself is kept as ever.
    const realGet = Object.getOwnPropertyDescriptor(Storage.prototype, 'getItem')
      ?.value as Storage['getItem'];
    const realSet = Object.getOwnPropertyDescriptor(Storage.prototype, 'setItem')
      ?.value as Storage['setItem'];
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (
      this: Storage,
      key: string,
    ) {
      if (key.startsWith('fdv.settings.')) throw new Error('blocked');
      return realGet.call(this, key);
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key.startsWith('fdv.settings.')) throw new Error('blocked');
      realSet.call(this, key, value);
    });
    try {
      at('/settings/account', EVERYTHING);
      const line = await bar();
      expect(line).toHaveAttribute('aria-valuenow', '248');
      fireEvent.keyDown(line, { key: 'ArrowRight' });
      expect(line).toHaveAttribute('aria-valuenow', '264');
      expect(menu().style.width).toBe('264px');
      expect(get).toHaveBeenCalledWith('fdv.settings.menu-width.me');
      expect(set).toHaveBeenCalledWith('fdv.settings.menu-width.me', '264');
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
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
    // Household became Privacy in 0.8.0: old links and bookmarks land there.
    ['/settings/household', '/settings/privacy', 'Privacy'],
  ])('%s is %s, in place of the old one', async (from, to, title) => {
    const before = window.history.length;
    at(from, EVERYTHING);
    await screen.findByRole('heading', { name: title, level: 1 });
    expect(window.location.pathname + window.location.search).toBe(to);
    // Replaced, not added: Back does not bounce off the old address.
    expect(window.history.length).toBe(before);
  });

  /**
   * Every /settings address there is, and where it lands (0.9.0, the three
   * groups): each still opens, by a redirect or as itself. The list is held
   * to App.tsx's own routes below, so an address added there is added here.
   */
  const SETTINGS_ADDRESSES: Array<[from: string, to: string, heading: string]> = [
    ['/settings', '/settings/account', 'Your account'],
    ['/settings/account', '/settings/account', 'Your account'],
    ['/settings/notifications', '/settings/notifications', 'Notifications'],
    // Refused without the feature, as before; the address stays.
    ['/settings/computers', '/settings/computers', 'Your computers'],
    ['/settings/data', '/settings/data', 'Your data'],
    ['/settings/privacy', '/settings/privacy', 'Privacy'],
    ['/settings/household', '/settings/privacy', 'Privacy'],
    ['/settings/family', '/settings/family', 'Family'],
    ['/settings/time-zone', '/settings/time-zone', 'Time zone'],
    ['/settings/kinds', '/settings/kinds', 'Kinds of document'],
    ['/settings/kinds/new', '/settings/kinds/new', 'Add a kind'],
    ['/settings/kinds/passport', '/settings/kinds/passport', 'Passport'],
    ['/settings/tags', '/settings/tags', 'Tags'],
    // For owners' list is the menu's Server and reading: its address, Storage.
    ['/settings/owners', '/settings/storage', 'Storage'],
    ['/settings/storage', '/settings/storage', 'Storage'],
    ['/settings/email', '/settings/email', 'Email, in and out'],
    ['/settings/email-in', '/settings/email-in', 'Email, in and out'],
    ['/settings/scanner', '/settings/scanner', 'Scanner folder'],
    ['/settings/reading', '/settings/reading', 'Reading and the check'],
    ['/settings/reading-check', '/settings/reading-check', 'Reading and the check'],
    ['/settings/activity', '/activity', 'What has been happening'],
    ['/settings/trash', '/trash', 'Trash'],
    ['/settings/sharing', '/sharing', 'Sharing'],
    ['/settings/sharing/ask', '/sharing/ask', 'Ask for documents'],
    ['/settings/guests', '/people/outside', 'People outside the family'],
    ['/settings/after-restore', '/after-restore', 'After a restore'],
  ];

  it.each(SETTINGS_ADDRESSES)('%s opens at %s, an owner’s', async (from, to, heading) => {
    at(from, { ...EVERYTHING, identities: {} });
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: heading })).toBeVisible(),
    );
    expect(window.location.pathname).toBe(to);
  });

  it('that list is every /settings address App.tsx has', () => {
    const file = ['src/App.tsx', 'apps/web/src/App.tsx']
      .map((p) => resolve(process.cwd(), p))
      .find((p) => existsSync(p));
    const app = file ? readFileSync(file, 'utf8') : '';
    const from = app.indexOf('<Route path="/settings" element={<SettingsLayout />}>');
    const to = app.indexOf('{MOVED.map', from);
    expect(from).toBeGreaterThan(0);
    const children = [
      ...app
        .slice(from + '<Route path="/settings"'.length, to)
        .matchAll(/<Route\s+path="([^"]+)"/g),
    ].map((m) => `/settings/${m[1]}`);
    const moved = [...app.matchAll(/\['(\/settings[^']*)',\s*'[^']*'\]/g)].map((m) => m[1]);
    const routes = new Set(['/settings', ...children, ...moved]);
    // `:key` stands for a kind's own.
    const listed = new Set(
      SETTINGS_ADDRESSES.map(([path]) =>
        path.replace(/^\/settings\/kinds\/passport$/, '/settings/kinds/:key'),
      ),
    );
    expect([...routes].sort()).toEqual([...listed].sort());
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

  it('beside the sidebar, forms and reading keep a readable width; lists use the whole of it', () => {
    expect(rule('.shell-wide .page,\n.shell-mid .page')).toMatch(/max-width:\s*720px/);
    // Across the content's width, as Documents (the owner's report).
    expect(rule('.shell-wide .page.page-wide,\n.shell-mid .page.page-wide')).toMatch(
      /max-width:\s*none/,
    );
    expect(
      rule(
        '.shell-wide .page-wide > p,\n.shell-mid .page-wide > p,\n.shell-wide .page-wide > section > p,\n.shell-mid .page-wide > section > p',
      ),
    ).toMatch(/max-width:\s*72ch/);
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
