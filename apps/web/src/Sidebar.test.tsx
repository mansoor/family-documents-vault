import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { AISHA, fresh, installFakeApi, ME, signedIn, type FakeState } from './test-api.js';

/**
 * The sidebar from 1024 px (Phase 6, the owner's ask): as wide as it is
 * dragged, between 200 and 360 px, by a pointer or the keys; and folded to
 * its icons, opening over the page — never moving it — while hovered or
 * focused. Both remembered on this device. The icons' rail at 768–1023 px
 * and the phone's layout are as they were.
 *
 * jsdom lays nothing out, but it cascades a stylesheet: styles.css is put
 * in the page, and the widths the shell gives it are read back from it.
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
function at(stored: Record<string, string> = {}, px = WIDE, path = '/'): FakeState {
  for (const [k, v] of Object.entries(stored)) localStorage.setItem(k, v);
  atWidth(px);
  const state = fresh({ members: [ME, AISHA], incoming: [{ ...W2 }] });
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

async function loaded(stored: Record<string, string> = {}, px = WIDE) {
  at(stored, px);
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

  it('its edge is seen on hover, while dragged and with focus, and nothing on it moves (styles.css)', () => {
    const rule = (selector: string) => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      return new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(CSS)?.[1] ?? '';
    };
    expect(rule('.side-resize')).toMatch(/cursor:\s*col-resize/);
    expect(rule('.side-resize')).toMatch(/position:\s*fixed/);
    expect(
      rule(
        '.side-resize:hover::before,\n.side-resize:focus-visible::before,\n.side-resizing .side-resize::before',
      ),
    ).toMatch(/background:\s*var\(--accent\)/);
    expect(rule('.side-resize:focus-visible')).toMatch(/outline:\s*2px solid var\(--accent\)/);
    expect(rule('.side-resizing,\n.side-resizing *')).toMatch(/user-select:\s*none/);
    expect(rule('.side-toggle:focus-visible')).toMatch(/outline:\s*2px solid/);
    // Prefers-reduced-motion: nothing of the sidebar's moves at all.
    const sidebarRules = [
      ...CSS.matchAll(/([^{}]*\.side-(?:resize|peek|collapsed|toggle)[^{}]*)\{([^}]*)\}/g),
    ];
    expect(sidebarRules.length).toBeGreaterThan(5);
    for (const [, , body] of sidebarRules) expect(body).not.toMatch(/transition|animation/);
  });
});

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
