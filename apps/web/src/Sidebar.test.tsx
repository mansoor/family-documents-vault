import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { MOVE_MS, MOVING_AT_MOST_MS } from './sidebar.js';
import { AISHA, fresh, installFakeApi, ME, signedIn, type FakeState } from './test-api.js';

/**
 * The longest a fold or an opening is said to be moving. jsdom runs no
 * animation, and so never ends one: this is when the shell stops waiting.
 */
const MOVING = MOVING_AT_MOST_MS;

/**
 * The sidebar from 1024 px (Phase 6, the owner's ask): as wide as it is
 * dragged, between 200 and 360 px, by a pointer or the keys; and folded to
 * its icons, opening over the page — never moving it — while hovered or
 * focused. Both remembered on this device. The icons' rail at 768–1023 px
 * and the phone's layout are as they were.
 *
 * And from 768 px (0.7.0, the owner's ask) the bar on top is the window's
 * whole width, the household's name in it where it stays, on one line;
 * and folding, opening and the peek move smoothly, a drag at once.
 *
 * jsdom lays nothing out, but it cascades a stylesheet: styles.css is put
 * in the page, and the widths the shell gives it are read back from it.
 * (Its media queries it never applies: prefers-reduced-motion's rules are
 * put in the page as they are, for the tests of reduced motion.)
 */

const PHONE = 375;
const MID = 900;
const WIDE = 1280;

let width = WIDE;
function atWidth(px: number) {
  width = px;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const minWidth = /\(min-width:\s*(\d+)px\)/.exec(query);
      const minHeight = /\(min-height:\s*(\d+)px\)/.exec(query);
      return {
        matches:
          (!minWidth || width >= Number(minWidth[1])) &&
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

const CSS = (() => {
  const file = ['src/styles.css', 'apps/web/src/styles.css']
    .map((p) => resolve(process.cwd(), p))
    .find((p) => existsSync(p));
  return (file ? readFileSync(file, 'utf8') : '').replace(/\/\*[\s\S]*?\*\//g, '');
})();

let sheet: HTMLStyleElement | null = null;
const innerWidth = window.innerWidth;
beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  sheet = document.createElement('style');
  sheet.textContent = CSS;
  document.head.appendChild(sheet);
});
afterEach(() => {
  vi.useRealTimers();
  sheet?.remove();
  Reflect.deleteProperty(window, 'matchMedia');
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
});

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

/** A file sent through a request, waiting: the Inbox has a count. */
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

/** The app at `path`, `px` wide, an owner signed in, with this kept on the device. */
function at(
  stored: Record<string, string> = {},
  px = WIDE,
  path = '/',
  over: Partial<FakeState> = {},
): FakeState {
  for (const [k, v] of Object.entries(stored)) localStorage.setItem(k, v);
  atWidth(px);
  const state = fresh({ members: [ME, AISHA], incoming: [{ ...W2 }], ...over });
  installFakeApi(state);
  signedIn('owner');
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

const sidebar = () => screen.findByRole('navigation', { name: 'Sections' });
const nav = () => screen.getByRole('navigation', { name: 'Sections' });
const shell = () => document.querySelector('.shell') as HTMLElement;
const handle = () => screen.getByRole('separator', { name: 'Resize the sidebar' });
const now = () => Number(handle().getAttribute('aria-valuenow'));
const sideW = () => shell().style.getPropertyValue('--side-w');
const stored = (key: string) => localStorage.getItem(`fdv.sidebar.${key}`);
const peeking = () => shell().classList.contains('side-peek');
/** A name in the sidebar is drawn (not only heard). */
const drawn = (name: string) =>
  within(nav()).getByRole('link', { name }).querySelector('.side-label') !== null;

/** A custom property's value here, inherited as a browser would. */
function custom(el: HTMLElement, name: string): string {
  for (let at: HTMLElement | null = el; at; at = at.parentElement) {
    const value = getComputedStyle(at).getPropertyValue(name).trim();
    if (value) return value;
  }
  return '';
}

/** A computed value with its custom properties put in, as a browser would. */
function resolved(el: HTMLElement, property: string): string {
  return getComputedStyle(el)
    .getPropertyValue(property)
    .replace(
      /var\((--[\w-]+)(?:,\s*([^)]+))?\)/g,
      (_, name: string, fallback?: string) => custom(el, name) || (fallback ?? '').trim(),
    );
}
/** Where the page beside the sidebar starts: the shell's first column. */
const pageLeft = () => resolved(shell(), 'grid-template-columns').split(' ')[0];

async function loaded(
  stored: Record<string, string> = {},
  px = WIDE,
  over: Partial<FakeState> = {},
) {
  at(stored, px, '/', over);
  await sidebar();
  await screen.findByRole('heading', { name: 'Recently added' });
}

/** This long passes, on the fake clock. */
function pass(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function drag(from: number, to: number, pointerType = 'mouse', pointerId = 1) {
  const el = handle();
  fireEvent.pointerDown(el, { pointerId, pointerType, button: 0, clientX: from });
  fireEvent.pointerMove(el, { pointerId, pointerType, clientX: (from + to) / 2 });
  fireEvent.pointerMove(el, { pointerId, pointerType, clientX: to });
  fireEvent.pointerUp(el, { pointerId, pointerType, clientX: to });
}

// ------------------------------------------------------------ the width

describe('the sidebar’s width, from 1024 px', () => {
  it('is today’s, with an edge that is a window splitter: named, focusable, its values said', async () => {
    await loaded();
    const edge = handle();
    expect(edge).toHaveAttribute('aria-orientation', 'vertical');
    expect(edge).toHaveAttribute('aria-valuenow', '216');
    expect(edge).toHaveAttribute('aria-valuemin', '200');
    expect(edge).toHaveAttribute('aria-valuemax', '360');
    expect(edge).toHaveAttribute('tabindex', '0');
    expect(sideW()).toBe('216px');
    expect(pageLeft()).toBe('216px');
    await expectAccessible();
  });

  it('follows a drag of its edge, the page taking the rest, and keeps it when let go', async () => {
    await loaded();
    const el = handle();
    fireEvent.pointerDown(el, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 216 });
    // While dragged: no words chosen on the way.
    expect(shell()).toHaveClass('side-resizing');
    expect(getComputedStyle(screen.getByRole('main')).userSelect).toBe('none');
    fireEvent.pointerMove(el, { pointerId: 1, pointerType: 'mouse', clientX: 300 });
    expect(now()).toBe(300);
    expect(pageLeft()).toBe('300px');
    // Kept once let go, not on every move.
    expect(stored('width')).toBeNull();
    fireEvent.pointerUp(el, { pointerId: 1, pointerType: 'mouse', clientX: 300 });
    expect(shell()).not.toHaveClass('side-resizing');
    expect(stored('width')).toBe('300');
    // A move after it is let go does nothing.
    fireEvent.pointerMove(el, { pointerId: 1, pointerType: 'mouse', clientX: 340 });
    expect(now()).toBe(300);
  });

  it('a finger or a pen drags it too; another mouse button does not', async () => {
    await loaded();
    drag(216, 260, 'touch', 7);
    expect(now()).toBe(260);
    drag(260, 230, 'pen', 8);
    expect(now()).toBe(230);
    expect(stored('width')).toBe('230');
    const el = handle();
    fireEvent.pointerDown(el, { pointerId: 1, pointerType: 'mouse', button: 2, clientX: 230 });
    fireEvent.pointerMove(el, { pointerId: 1, pointerType: 'mouse', clientX: 330 });
    expect(now()).toBe(230);
    // Its edge stays a finger's to drag, never the page's to scroll.
    expect(getComputedStyle(el).touchAction).toBe('none');
  });

  it('moves with ← and → (Shift: further), and Home puts it back (WCAG 2.5.7)', async () => {
    await loaded();
    const el = handle();
    fireEvent.keyDown(el, { key: 'ArrowRight' });
    expect(now()).toBe(232);
    expect(stored('width')).toBe('232');
    fireEvent.keyDown(el, { key: 'ArrowRight', shiftKey: true });
    expect(now()).toBe(280);
    fireEvent.keyDown(el, { key: 'ArrowLeft' });
    expect(now()).toBe(264);
    expect(pageLeft()).toBe('264px');
    fireEvent.keyDown(el, { key: 'ArrowLeft', shiftKey: true });
    expect(now()).toBe(216);
    fireEvent.keyDown(el, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(el, { key: 'Home' });
    expect(now()).toBe(216);
    expect(stored('width')).toBeNull();
  });

  it('a double-click puts it back', async () => {
    await loaded({ 'fdv.sidebar.width': '320' });
    expect(now()).toBe(320);
    fireEvent.doubleClick(handle());
    expect(now()).toBe(216);
    expect(sideW()).toBe('216px');
    expect(stored('width')).toBeNull();
  });

  it('goes no narrower than 200 px and no wider than 360, by drag or by key', async () => {
    await loaded();
    drag(216, 900);
    expect(now()).toBe(360);
    expect(stored('width')).toBe('360');
    fireEvent.keyDown(handle(), { key: 'ArrowRight', shiftKey: true });
    expect(now()).toBe(360);
    drag(360, 0);
    expect(now()).toBe(200);
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    expect(now()).toBe(200);
  });

  it.each([
    ['999', 360],
    ['40', 200],
    ['wide', 216],
  ])('a width kept as %s is read as %s px', async (kept, px) => {
    await loaded({ 'fdv.sidebar.width': kept });
    expect(now()).toBe(px);
    expect(sideW()).toBe(`${px}px`);
  });

  it('a window too narrow for the width kept: the page keeps 600 px, and it widens again with the window', async () => {
    // As a window would be with the page zoomed: the media query and the width disagreeing.
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 880 });
    await loaded({ 'fdv.sidebar.width': '340' });
    expect(now()).toBe(280);
    expect(handle()).toHaveAttribute('aria-valuemax', '280');
    act(() => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
      window.dispatchEvent(new Event('resize'));
    });
    expect(now()).toBe(340);
    expect(handle()).toHaveAttribute('aria-valuemax', '360');
  });

  it('is remembered on this device, and a browser that keeps nothing still resizes', async () => {
    await loaded();
    drag(216, 296);
    cleanup();
    await loaded();
    expect(now()).toBe(296);
    expect(sideW()).toBe('296px');
    cleanup();
    localStorage.clear();
    // The sidebar's own keys refused, read or written (the rest of the app's as it was).
    const real = {
      get: localStorage.getItem.bind(localStorage),
      set: localStorage.setItem.bind(localStorage),
      remove: localStorage.removeItem.bind(localStorage),
    };
    const mine = (key: string) => key.startsWith('fdv.sidebar.');
    const refuse = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key, value) => {
      if (mine(key)) throw new Error('QuotaExceededError');
      real.set(key, value);
    });
    const forget = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation((key) => {
      if (mine(key)) throw new Error('SecurityError');
      real.remove(key);
    });
    const unread = vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => {
      if (mine(key)) throw new Error('SecurityError');
      return real.get(key);
    });
    // Nothing thrown on the way, where a key or a click would end in an error.
    const thrown: unknown[] = [];
    const onError = (e: ErrorEvent) => thrown.push(e.error);
    window.addEventListener('error', onError);
    try {
      at();
      await sidebar();
      expect(now()).toBe(216);
      fireEvent.keyDown(handle(), { key: 'ArrowRight' });
      expect(now()).toBe(232);
      fireEvent.keyDown(handle(), { key: 'Home' });
      expect(now()).toBe(216);
      fireEvent.click(collapseButton());
      expect(sideW()).toBe('72px');
      fireEvent.click(expandButton());
      drag(216, 260);
      expect(now()).toBe(260);
      expect(thrown).toEqual([]);
    } finally {
      window.removeEventListener('error', onError);
      refuse.mockRestore();
      forget.mockRestore();
      unread.mockRestore();
    }
  });

  it('its edge is seen on hover, while dragged and with focus (styles.css)', () => {
    expect(rule('.side-resize')).toMatch(/cursor:\s*col-resize/);
    expect(rule('.side-resize')).toMatch(/position:\s*fixed/);
    // Under the bar on top, which it no longer reaches into.
    expect(rule('.side-resize')).toMatch(/top:\s*var\(--shell-top\)/);
    expect(
      rule(
        '.side-resize:hover::before,\n.side-resize:focus-visible::before,\n.side-resizing .side-resize::before',
      ),
    ).toMatch(/background:\s*var\(--accent\)/);
    expect(rule('.side-resize:focus-visible')).toMatch(/outline:\s*2px solid var\(--accent\)/);
    expect(rule('.side-resizing,\n.side-resizing *')).toMatch(/user-select:\s*none/);
    expect(rule('.side-toggle:focus-visible')).toMatch(/outline:\s*2px solid/);
  });
});

/** The declarations of the rule in styles.css with exactly this selector. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(CSS)?.[1] ?? '';
}

// ---------------------------------------------------------- collapsing

const collapseButton = () => screen.getByRole('button', { name: 'Collapse the sidebar' });
const expandButton = () => screen.getByRole('button', { name: 'Expand the sidebar' });

describe('the sidebar folded to its icons, from 1024 px', () => {
  it('folds and opens again from its foot, says so, and keeps the width it had', async () => {
    await loaded({ 'fdv.sidebar.width': '300' });
    const button = collapseButton();
    expect(button).toHaveAttribute('aria-expanded', 'true');
    act(() => button.focus());
    // Above Settings, at the foot.
    const foot = button.closest('.side-foot') as HTMLElement;
    expect(within(foot).getByRole('link', { name: 'Settings' })).toBeInTheDocument();
    fireEvent.click(button);
    expect(expandButton()).toHaveAttribute('aria-expanded', 'false');
    expect(stored('collapsed')).toBe('1');
    // The rail's width, the icons alone, each still named; no edge to drag.
    expect(sideW()).toBe('72px');
    expect(pageLeft()).toBe('72px');
    expect(drawn('Home')).toBe(false);
    expect(within(nav()).getByRole('link', { name: 'Home' })).toBeInTheDocument();
    expect(screen.queryByRole('separator')).toBeNull();
    // Focus stays on the button that did it, and opens nothing over the page.
    expect(expandButton()).toHaveFocus();
    expect(peeking()).toBe(false);
    fireEvent.click(expandButton());
    expect(collapseButton()).toHaveAttribute('aria-expanded', 'true');
    expect(stored('collapsed')).toBeNull();
    expect(sideW()).toBe('300px');
    expect(now()).toBe(300);
    expect(drawn('Home')).toBe(true);
  });

  it('is remembered on this device', async () => {
    await loaded();
    fireEvent.click(collapseButton());
    cleanup();
    await loaded();
    expect(expandButton()).toHaveAttribute('aria-expanded', 'false');
    expect(sideW()).toBe('72px');
  });

  it('keeps the Inbox’s count, on its icon, and aria-current', async () => {
    await loaded({ 'fdv.sidebar.collapsed': '1' });
    const inbox = await within(nav()).findByRole('link', { name: 'Inbox, 1 waiting' });
    const count = within(inbox).getByText('1');
    expect(count).toHaveAttribute('aria-hidden', 'true');
    // Drawn over the icon's corner, as the rail at 768–1023 px has it.
    expect(getComputedStyle(count).position).toBe('absolute');
    expect(within(nav()).getByRole('link', { name: 'Home' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expectAccessible();
  });

  it('adds no key of its own: n and / are as they were', async () => {
    await loaded({ 'fdv.sidebar.collapsed': '1' });
    for (const key of ['[', ']', 'b', 's', '\\']) {
      fireEvent.keyDown(document.body, { key });
      expect(sideW()).toBe('72px');
    }
    fireEvent.keyDown(document.body, { key: '/' });
    expect(screen.getByRole('searchbox', { name: 'Search the vault' })).toHaveFocus();
  });
});

describe('folded, it opens over the page while hovered', () => {
  it('after a moment over it, and folds again a moment after the pointer leaves', async () => {
    await loaded({ 'fdv.sidebar.collapsed': '1' });
    vi.useFakeTimers();
    fireEvent.pointerEnter(nav(), { pointerType: 'mouse' });
    pass(140);
    // A pointer passing by opens nothing.
    expect(peeking()).toBe(false);
    pass(10);
    expect(peeking()).toBe(true);
    expect(drawn('Home')).toBe(true);
    expect(drawn('Inbox, 1 waiting')).toBe(true);
    // Still folded: Expand keeps it open.
    expect(expandButton()).toHaveAttribute('aria-expanded', 'false');
    fireEvent.pointerLeave(nav(), { pointerType: 'mouse' });
    pass(290);
    expect(peeking()).toBe(true);
    pass(10);
    expect(peeking()).toBe(false);
    expect(drawn('Home')).toBe(false);
  });

  it('a pointer leaving and coming back on the slant does not flicker', async () => {
    await loaded({ 'fdv.sidebar.collapsed': '1' });
    vi.useFakeTimers();
    fireEvent.pointerEnter(nav(), { pointerType: 'mouse' });
    pass(150);
    fireEvent.pointerLeave(nav(), { pointerType: 'mouse' });
    pass(200);
    fireEvent.pointerEnter(nav(), { pointerType: 'mouse' });
    pass(1000);
    expect(peeking()).toBe(true);
    // And one only passing by, in and out, opens nothing.
    fireEvent.pointerLeave(nav(), { pointerType: 'mouse' });
    pass(300);
    fireEvent.pointerEnter(nav(), { pointerType: 'mouse' });
    pass(100);
    fireEvent.pointerLeave(nav(), { pointerType: 'mouse' });
    pass(1000);
    expect(peeking()).toBe(false);
  });

  it('a finger has no hover: a tap is for the icon under it', async () => {
    await loaded({ 'fdv.sidebar.collapsed': '1' });
    vi.useFakeTimers();
    fireEvent.pointerEnter(nav(), { pointerType: 'touch' });
    pass(1000);
    expect(peeking()).toBe(false);
  });

  it('never moves the page: the column stays the rail’s, and it is drawn above it', async () => {
    await loaded({ 'fdv.sidebar.collapsed': '1', 'fdv.sidebar.width': '280' });
    const before = pageLeft();
    expect(before).toBe('72px');
    vi.useFakeTimers();
    fireEvent.pointerEnter(nav(), { pointerType: 'mouse' });
    pass(150);
    expect(peeking()).toBe(true);
    expect(pageLeft()).toBe(before);
    expect(resolved(shell(), 'grid-template-columns')).toBe('72px minmax(0, 1fr)');
    // The sidebar its own width again, over the page and the bar on top, with a shadow.
    const side = nav();
    expect(resolved(side, 'width')).toBe('280px');
    const bar = document.querySelector('header.app-bar') as HTMLElement;
    expect(Number(getComputedStyle(side).zIndex)).toBeGreaterThan(
      Number(getComputedStyle(bar).zIndex),
    );
    expect(getComputedStyle(side).boxShadow).not.toBe('');
    // No edge to drag while it is open over the page.
    expect(screen.queryByRole('separator')).toBeNull();
    vi.useRealTimers();
    await expectAccessible();
  });

  it('Escape folds it, wherever focus is (WCAG 1.4.13)', async () => {
    await loaded({ 'fdv.sidebar.collapsed': '1' });
    vi.useFakeTimers();
    fireEvent.pointerEnter(nav(), { pointerType: 'mouse' });
    pass(150);
    expect(peeking()).toBe(true);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(peeking()).toBe(false);
    // Still hovered: it stays folded until the pointer comes back.
    pass(1000);
    expect(peeking()).toBe(false);
  });
});

describe('folded, it opens while the keyboard is on it', () => {
  it('focus in opens it at once; focus out folds it; Escape folds it, focus kept', async () => {
    await loaded({ 'fdv.sidebar.collapsed': '1' });
    const home = within(nav()).getByRole('link', { name: 'Home' });
    act(() => home.focus());
    expect(peeking()).toBe(true);
    expect(drawn('Home')).toBe(true);
    // Along it: still open.
    const docs = within(nav()).getByRole('link', { name: 'Documents' });
    act(() => docs.focus());
    expect(peeking()).toBe(true);
    // Out of it, to the page: folded.
    const heading = screen.getByRole('heading', { level: 1 });
    heading.setAttribute('tabindex', '-1');
    act(() => heading.focus());
    expect(peeking()).toBe(false);
    act(() => docs.focus());
    expect(peeking()).toBe(true);
    fireEvent.keyDown(docs, { key: 'Escape' });
    expect(peeking()).toBe(false);
    expect(docs).toHaveFocus();
    // Tab on to the next: open again.
    act(() => within(nav()).getByRole('link', { name: 'People' }).focus());
    expect(peeking()).toBe(true);
    await expectAccessible();
  });

  it('a press with the pointer is not the keyboard: it folds when the pointer leaves', async () => {
    await loaded({ 'fdv.sidebar.collapsed': '1' });
    const home = within(nav()).getByRole('link', { name: 'Home' });
    fireEvent.pointerDown(home, { pointerType: 'mouse' });
    act(() => home.focus());
    fireEvent.pointerUp(home, { pointerType: 'mouse' });
    expect(peeking()).toBe(false);
  });

  it('the Escape of a menu over the page is the menu’s', async () => {
    await loaded({ 'fdv.sidebar.collapsed': '1' });
    act(() => within(nav()).getByRole('link', { name: 'Home' }).focus());
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.appendChild(menu);
    try {
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(peeking()).toBe(true);
    } finally {
      menu.remove();
    }
  });
});

// ------------------------------------------------- the bar on top (0.7.0)

const bar = () => document.querySelector('header.app-bar') as HTMLElement;
const brand = () => within(bar()).getByRole('link', { name: /^The Seikh family/ });
const LONG = 'The Rodríguez-Montgomery family of Eastbourne';

/**
 * The page's banners: its headers that are not a screen's own (inside its
 * main, a section or an article, a header is no banner; axe knows this, and
 * Testing Library does not).
 */
const banners = () =>
  [...document.querySelectorAll('header, [role="banner"]')].filter(
    (h) => !h.parentElement?.closest('main, article, aside, nav, section, [role="dialog"]'),
  );

/**
 * Where the household's name sits, as a browser lays it out: the bar from
 * the window's left edge (a row of the shell's grid of its own, across both
 * columns), its padding, then the brand, first in it, as wide as it says.
 */
function brandPlace() {
  const header = bar();
  const name = brand();
  return {
    barInTheShell: header.parentElement === shell(),
    barColumns: getComputedStyle(header).gridColumn,
    barPadding: resolved(header, 'padding-left'),
    brandFirst: header.firstElementChild === name,
    brandWidth: resolved(name, 'width'),
  };
}

describe('the bar on top, across the window (the owner’s ask)', () => {
  it.each([
    ['wide', WIDE],
    ['in the middle', MID],
  ])(
    '%s: one banner the window’s width, the household’s name in it and not in the sidebar',
    async (_, px) => {
      await loaded({}, px);
      // Its own row, across both of the shell's columns: above the sidebar
      // and the page, not beside the sidebar.
      expect(bar().parentElement).toBe(shell());
      expect(getComputedStyle(bar()).gridColumn).toBe('1 / -1');
      expect(resolved(shell(), 'grid-template-rows')).toBe('auto 1fr');
      expect(bar().compareDocumentPosition(nav()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(bar().closest('.shell-main')).toBeNull();
      // The sidebar under it, the rest of the window's height.
      expect(resolved(nav(), 'top')).toBe('64px');
      expect(resolved(nav(), 'height')).toBe('calc(100dvh - 64px)');
      // Mark, household, search, the gap, Add, the account, in that order.
      const parts = [...bar().children].map((c) =>
        c === brand()
          ? 'brand'
          : c.matches('[role="search"]')
            ? 'search'
            : c.matches('.app-bar-gap')
              ? 'gap'
              : c.matches('.app-add, .add-wrap')
                ? 'add'
                : c.matches('.account')
                  ? 'account'
                  : c.outerHTML.slice(0, 40),
      );
      expect(parts).toEqual(['brand', 'search', 'gap', 'add', 'account']);
      expect(within(bar()).getByText('The Seikh family')).toBeInTheDocument();
      expect(within(nav()).queryByText('The Seikh family')).toBeNull();
      expect(nav().querySelector('.brand')).toBeNull();
      // Landmarks: one banner, one main, the sections.
      expect(banners()).toEqual([bar()]);
      expect(document.querySelectorAll('main, [role="main"]')).toHaveLength(1);
      expect(bar().closest('main')).toBeNull();
      await expectAccessible();
    },
  );

  it('its name goes Home, and is the first thing Tab reaches after the skip link', async () => {
    at({}, WIDE, '/documents');
    await screen.findByRole('heading', { name: 'Documents', level: 1 });
    expect(brand()).toHaveAttribute('href', '/');
    const focusable = [...document.querySelectorAll('a[href], button, input')];
    expect(focusable[0]).toHaveTextContent('Skip to main content');
    expect(focusable[1]).toBe(brand());
    fireEvent.click(brand());
    await screen.findByRole('heading', { name: 'Recently added' });
    expect(window.location.pathname).toBe('/');
  });

  it('stays where it is: folded, opened, peeking, and 200 or 360 px wide', async () => {
    await loaded();
    const place = brandPlace();
    expect(place).toEqual({
      barInTheShell: true,
      barColumns: '1 / -1',
      barPadding: '19px',
      brandFirst: true,
      brandWidth: '209px',
    });
    drag(216, 0);
    expect(now()).toBe(200);
    expect(brandPlace()).toEqual(place);
    drag(200, 900);
    expect(now()).toBe(360);
    expect(brandPlace()).toEqual(place);
    fireEvent.click(collapseButton());
    expect(sideW()).toBe('72px');
    expect(brandPlace()).toEqual(place);
    act(() => within(nav()).getByRole('link', { name: 'Home' }).focus());
    expect(peeking()).toBe(true);
    expect(brandPlace()).toEqual(place);
    fireEvent.click(expandButton());
    expect(sideW()).toBe('360px');
    expect(brandPlace()).toEqual(place);
  });

  it('a long name stays on one line, ends in “…”, and is still said and shown whole', async () => {
    await loaded({}, WIDE, { displayName: LONG });
    const link = within(bar()).getByRole('link', { name: `${LONG} Family Document Vault` });
    const name = within(link).getByText(LONG);
    const sub = within(link).getByText('Family Document Vault');
    for (const line of [name, sub]) {
      const look = getComputedStyle(line);
      expect(look.whiteSpace).toBe('nowrap');
      expect(look.overflow).toBe('hidden');
      expect(look.textOverflow).toBe('ellipsis');
    }
    expect(name).toHaveAttribute('title', LONG);
    expect(sub).toHaveAttribute('title', 'Family Document Vault');
    // Its words in a box no wider than its own, whatever the name.
    expect(resolved(link, 'width')).toBe('209px');
    // Neither squeezed by the search box nor grown (`flex: none`).
    expect(getComputedStyle(link).flex).toBe('0 0 auto');
    expect(getComputedStyle(link.querySelector('.brand-words') as HTMLElement).minWidth).toBe(
      '0px',
    );
    await expectAccessible();
  });

  it('in the middle, the mark and the name alone, on one line', async () => {
    await loaded({}, MID, { displayName: LONG });
    const link = within(bar()).getByRole('link', { name: new RegExp(`^${LONG}`) });
    expect(getComputedStyle(within(link).getByText('Family Document Vault')).display).toBe('none');
    expect(getComputedStyle(within(link).getByText(LONG)).whiteSpace).toBe('nowrap');
    expect(within(link).getByText(LONG)).toHaveAttribute('title', LONG);
    expect(resolved(link, 'width')).toBe('200px');
    // Wide, both lines.
    cleanup();
    await loaded();
    expect(getComputedStyle(within(brand()).getByText('Family Document Vault')).display).not.toBe(
      'none',
    );
  });
});

// ------------------------------------------------- moving (0.7.0)

const main = () => document.querySelector('.shell-main') as HTMLElement;
const moving = () => shell().classList.contains('side-moving');
/** A declared value on one line (the stylesheet may spread a list over several). */
const flat = (value: string) => value.replace(/\s+/g, ' ').trim();
const sideMoves = () => flat(getComputedStyle(nav()).transition);
const pageMoves = () => flat(getComputedStyle(main()).animation);
/**
 * An animation on `el` ended, as a browser says so (jsdom has no
 * AnimationEvent: an Event with its name).
 */
function ended(el: HTMLElement, animationName: string) {
  const e = new Event('animationend', { bubbles: true });
  Object.defineProperty(e, 'animationName', { value: animationName });
  act(() => {
    el.dispatchEvent(e);
  });
}

/** How long, and how, from "width 200ms ease-out" or "side-shift 200ms ease-out". */
const how = (value: string) => value.split(' ').slice(1).join(' ');

/** prefers-reduced-motion asked for: its rules in the page, as a browser would apply them. */
function reduceMotion() {
  const rules = [
    ...CSS.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g),
  ].map((m) => m[1]);
  expect(rules.join('')).toMatch(/\.shell \.sidebar/);
  const reduced = document.createElement('style');
  reduced.textContent = rules.join('\n');
  document.head.appendChild(reduced);
  return reduced;
}

describe('folding and opening move, smoothly (the owner’s ask)', () => {
  it('folding: the sidebar’s width and the page’s start, together, in 200 ms', async () => {
    await loaded({ 'fdv.sidebar.width': '300' });
    // Still, as it is: nothing moves on its own, and ← and → are at once.
    expect(sideMoves()).not.toMatch(/\d+ms/);
    expect(pageMoves()).not.toMatch(/\d+ms/);
    // Its own width, which can move (not only its column's).
    expect(resolved(nav(), 'width')).toBe('300px');
    vi.useFakeTimers();
    fireEvent.click(collapseButton());
    expect(moving()).toBe(true);
    expect(resolved(nav(), 'width')).toBe('72px');
    expect(MOVE_MS).toBe(200);
    expect(sideMoves()).toBe(`width ${MOVE_MS}ms ease-out`);
    expect(pageMoves()).toBe(`side-shift ${MOVE_MS}ms ease-out`);
    expect(how(pageMoves())).toBe(how(sideMoves()));
    // The page is laid out where it ends up (the rail's column) and its
    // start comes from where it was, 300 − 72 px to the right.
    expect(pageLeft()).toBe('72px');
    expect(shell().style.getPropertyValue('--side-shift')).toBe('228px');
    expect(getComputedStyle(main()).position).toBe('relative');
    // Cut at the window's edge on the way, never scrolled sideways.
    expect(getComputedStyle(shell()).overflowX).toBe('clip');
    pass(MOVING);
    expect(moving()).toBe(false);
    expect(pageMoves()).not.toMatch(/\d+ms/);
    expect(getComputedStyle(shell()).overflowX).not.toBe('clip');
    expect(getComputedStyle(main()).position).not.toBe('relative');
  });

  it('opening again: from the left, as far', async () => {
    await loaded({ 'fdv.sidebar.width': '300', 'fdv.sidebar.collapsed': '1' });
    vi.useFakeTimers();
    fireEvent.click(expandButton());
    expect(moving()).toBe(true);
    expect(sideMoves()).toBe('width 200ms ease-out');
    expect(pageMoves()).toBe('side-shift 200ms ease-out');
    expect(pageLeft()).toBe('300px');
    expect(shell().style.getPropertyValue('--side-shift')).toBe('-228px');
    pass(MOVING);
    expect(moving()).toBe(false);
    expect(sideMoves()).not.toMatch(/\d+ms/);
  });

  it('it is moving until the page’s start arrives: its own move’s end, not one inside the page', async () => {
    await loaded();
    vi.useFakeTimers();
    fireEvent.click(collapseButton());
    expect(moving()).toBe(true);
    // A spinner's turn ending, on the page or inside it: still moving.
    ended(main(), 'spinner-turn');
    ended(screen.getByRole('main'), 'side-shift');
    expect(moving()).toBe(true);
    // The page's start arrived: at once, not when the clock says.
    pass(MOVE_MS);
    ended(main(), 'side-shift');
    expect(moving()).toBe(false);
    expect(getComputedStyle(shell()).overflowX).not.toBe('clip');
  });

  it('the page’s start moves from where it was to where it is (styles.css)', () => {
    expect(CSS).toMatch(
      /@keyframes side-shift \{\s*from \{\s*left: var\(--side-shift, 0px\);\s*\}\s*to \{\s*left: 0;\s*\}\s*\}/,
    );
  });

  it('the peek slides open and shut in 150 ms, the page still', async () => {
    await loaded({ 'fdv.sidebar.collapsed': '1', 'fdv.sidebar.width': '280' });
    expect(sideMoves()).toMatch(/^width 150ms ease-out, box-shadow 150ms ease-out$/);
    vi.useFakeTimers();
    fireEvent.pointerEnter(nav(), { pointerType: 'mouse' });
    pass(150);
    expect(peeking()).toBe(true);
    expect(sideMoves()).toMatch(/^width 150ms ease-out/);
    expect(moving()).toBe(false);
    expect(pageMoves()).not.toMatch(/\d+ms/);
    expect(pageLeft()).toBe('72px');
    fireEvent.pointerLeave(nav(), { pointerType: 'mouse' });
    pass(300);
    expect(peeking()).toBe(false);
    // Shutting slides too: the rule is the folded sidebar's, peeking or not.
    expect(sideMoves()).toMatch(/^width 150ms ease-out/);
    // Above the page while it shuts, as it was open.
    expect(Number(getComputedStyle(nav()).zIndex)).toBeGreaterThan(0);
  });

  it('opening, its sections are already their open width: uncovered, not wrapped on the way', async () => {
    await loaded({ 'fdv.sidebar.collapsed': '1', 'fdv.sidebar.width': '280' });
    const list = nav().querySelector('.side-list') as HTMLElement;
    expect(resolved(list, 'min-width')).not.toMatch(/px/);
    expect(resolved(nav(), 'overflow-x')).toBe('hidden');
    fireEvent.click(expandButton());
    expect(resolved(list, 'min-width')).toBe('calc(280px - 24px)');
    expect(resolved(nav().querySelector('.side-foot-wide') as HTMLElement, 'min-width')).toBe(
      'calc(280px - 24px)',
    );
  });

  it('nothing in it moves sideways as it folds: each icon, and the mark above, 36 px in', async () => {
    await loaded();
    const px = (value: string) => Number.parseFloat(value);
    const home = () => within(nav()).getByRole('link', { name: 'Home' });
    /** The icon's middle, from the window's left: the sidebar's padding, then the link's. */
    const iconMiddle = () => {
      const link = home();
      const inside =
        getComputedStyle(link).justifyContent === 'center'
          ? (px(resolved(link, 'width')) - 20) / 2
          : px(resolved(link, 'padding-left'));
      return px(resolved(nav(), 'padding-left')) + inside + 10;
    };
    expect(iconMiddle()).toBe(36);
    fireEvent.click(collapseButton());
    expect(drawn('Home')).toBe(false);
    expect(iconMiddle()).toBe(36);
    // The household's mark (34 px) in the bar on top, over them.
    expect(px(resolved(bar(), 'padding-left')) + 34 / 2).toBe(36);
  });

  it('a drag follows the pointer at once, even the moment after opening', async () => {
    await loaded({ 'fdv.sidebar.collapsed': '1' });
    vi.useFakeTimers();
    fireEvent.click(expandButton());
    expect(sideMoves()).toBe('width 200ms ease-out');
    fireEvent.pointerDown(handle(), {
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      clientX: 216,
    });
    expect(shell()).toHaveClass('side-resizing');
    expect(moving()).toBe(true);
    expect(sideMoves()).toBe('none');
    expect(pageMoves()).toBe('none');
    fireEvent.pointerMove(handle(), { pointerId: 1, pointerType: 'mouse', clientX: 260 });
    expect(sideW()).toBe('260px');
    expect(sideMoves()).toBe('none');
    fireEvent.pointerUp(handle(), { pointerId: 1, pointerType: 'mouse', clientX: 260 });
    pass(MOVING);
    // And ← and → are at once too.
    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    expect(sideW()).toBe('276px');
    expect(moving()).toBe(false);
    expect(sideMoves()).not.toMatch(/\d+ms/);
  });

  it('for whoever asks for less motion, nothing moves: folding, opening, the peek', async () => {
    const reduced = reduceMotion();
    try {
      await loaded({ 'fdv.sidebar.width': '300' });
      vi.useFakeTimers();
      fireEvent.click(collapseButton());
      expect(moving()).toBe(true);
      expect(sideMoves()).toBe('none');
      expect(pageMoves()).toBe('none');
      fireEvent.pointerEnter(nav(), { pointerType: 'mouse' });
      pass(MOVING);
      expect(peeking()).toBe(true);
      expect(sideMoves()).toBe('none');
      fireEvent.click(expandButton());
      expect(sideMoves()).toBe('none');
      expect(pageMoves()).toBe('none');
    } finally {
      reduced.remove();
    }
  });

  it('folded and opened again quickly, it ends where it should', async () => {
    await loaded();
    vi.useFakeTimers();
    fireEvent.click(collapseButton());
    pass(50);
    fireEvent.click(expandButton());
    expect(shell().style.getPropertyValue('--side-shift')).toBe('-144px');
    pass(MOVING - 50);
    // The first one's clock does not cut the second short.
    expect(moving()).toBe(true);
    pass(50);
    expect(moving()).toBe(false);
    expect(sideW()).toBe('216px');
    expect(pageMoves()).not.toMatch(/\d+ms/);
  });
});

// ---------------------------------------------------------- unchanged

describe('768–1023 px and a phone: as they were', () => {
  it.each([[{}], [{ 'fdv.sidebar.width': '340', 'fdv.sidebar.collapsed': '1' }]])(
    'the rail at 900 px, whatever was kept (%o)',
    async (kept) => {
      await loaded(kept, MID);
      expect(shell()).toHaveClass('shell-mid');
      expect(shell()).not.toHaveClass('side-collapsed');
      expect(shell().getAttribute('style')).toBeNull();
      expect(resolved(shell(), 'grid-template-columns')).toBe('72px minmax(0, 1fr)');
      expect(screen.queryByRole('separator')).toBeNull();
      expect(screen.queryByRole('button', { name: /the sidebar$/ })).toBeNull();
      const home = within(nav()).getByRole('link', { name: 'Home' });
      expect(home).toHaveAttribute('data-label', 'Home');
      // Settings at the foot, as before.
      expect(within(nav()).getByRole('link', { name: 'Settings' }).closest('ul')).toHaveClass(
        'side-foot',
      );
      vi.useFakeTimers();
      fireEvent.pointerEnter(nav(), { pointerType: 'mouse' });
      pass(1000);
      act(() => home.focus());
      expect(shell()).not.toHaveClass('side-peek');
      vi.useRealTimers();
      await expectAccessible();
    },
  );

  it('a phone has its bar and its drawer, whatever was kept', async () => {
    at({ 'fdv.sidebar.width': '340', 'fdv.sidebar.collapsed': '1' }, PHONE);
    await screen.findByRole('navigation', { name: 'Main' });
    expect(shell()).toHaveClass('shell-phone');
    expect(shell().getAttribute('style')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Sections' })).toBeNull();
    expect(screen.queryByRole('separator')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    const drawer = await screen.findByRole('dialog', { name: 'Menu' });
    expect(within(drawer).queryByRole('button', { name: /the sidebar$/ })).toBeNull();
    await waitFor(() =>
      expect(within(drawer).getByRole('link', { name: 'Settings' }).closest('ul')).toHaveClass(
        'side-foot',
      ),
    );
  });
});
