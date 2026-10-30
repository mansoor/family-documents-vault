import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { detailsBounds, startingWidth } from './doc-panes.js';
import { zoomStep, ZOOM_MAX, ZOOM_STEPS } from './page-viewer.js';
import { fresh, installFakeApi, ME, PASSPORT, signedIn, type FakeState } from './test-api.js';

/**
 * A document's page at the whole width, a line between its details and its
 * pages that is dragged or moved with the keys, the pages zoomed, and the
 * pages beside Edit's card (0.9.0, the owner's ask of 29 Oct 2026).
 *
 * jsdom has no layout: the window's width is said (matchMedia and
 * innerWidth), and the viewer's room and a page's own size are given to it.
 */

const PHONE = 320;
const MID = 900;
const WIDE = 1280;
const WIDER = 1600;

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
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: px });
}

/** The viewer's room inside (jsdom has no padding: no stylesheet), and each page's own size. */
const ROOM = { w: 500, h: 600 };
const DRAWN = { w: 1000, h: 1414 };

let made = 0;
beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  made = 0;
  Object.assign(URL, {
    createObjectURL: vi.fn(() => `blob:page-${++made}`),
    revokeObjectURL: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('viewer') ? ROOM.w : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('viewer') ? ROOM.h : 0;
    },
  });
  Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', {
    configurable: true,
    get: () => DRAWN.w,
  });
  Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', {
    configurable: true,
    get: () => DRAWN.h,
  });
});
afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia');
  Reflect.deleteProperty(window, 'innerWidth');
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
  Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
  Reflect.deleteProperty(HTMLImageElement.prototype, 'naturalWidth');
  Reflect.deleteProperty(HTMLImageElement.prototype, 'naturalHeight');
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

function at(path: string, px: number, over: Partial<FakeState> = {}): FakeState {
  atWidth(px);
  const state = fresh({
    members: [{ ...ME, role: 'owner' }],
    documents: [{ ...PASSPORT }],
    ...over,
  });
  installFakeApi(state);
  signedIn('owner');
  window.history.replaceState({}, '', path);
  render(<App />);
  return state;
}

const KEY = 'fdv.document.details-width.me';
const line = () => screen.findByRole('separator', { name: 'Width of the details' });
const split = () => document.querySelector('.doc-split') as HTMLElement;
const detailsWidth = () => split().style.getPropertyValue('--doc-details-w');
const pages = async () => {
  // The viewer, once there is one: in Edit the pane says "Loading the pages…" first.
  await screen.findByRole('group', { name: /^Page \d+ of/ });
  return screen.getByRole('region', { name: "Pages of Mansoor's passport" });
};

/** The page shown, drawn: its own size known, as a browser knows it once it has loaded. */
async function shownPage(region: HTMLElement, name: string | RegExp = /^Page 1 of/) {
  const img = await within(region).findByRole('img', { name });
  fireEvent.load(img);
  return img;
}
const readout = (region: HTMLElement) =>
  within(region).getByRole('button', { name: /back to Fit to width$/ });

describe('the line between the details and the pages (0.9.0)', () => {
  it('at 1600 px: a window splitter, 400 px to start, 280 to 640, moved with the keys', async () => {
    at('/documents/doc-1', WIDER);
    const bar = await line();
    expect(bar).toHaveAttribute('aria-orientation', 'vertical');
    expect(bar).toHaveAttribute('aria-controls', 'doc-details');
    expect(document.getElementById('doc-details')).toHaveAccessibleName(
      "Details of Mansoor's passport",
    );
    expect(bar).toHaveAttribute('tabindex', '0');
    // As the layout before it gave at this width: nobody's page jumps.
    expect(bar).toHaveAttribute('aria-valuenow', '400');
    expect(bar).toHaveAttribute('aria-valuemin', '280');
    expect(bar).toHaveAttribute('aria-valuemax', '640');
    expect(detailsWidth()).toBe('400px');
    // Between the details and the pages, in the page's order.
    const right = await pages();
    const left = document.getElementById('doc-details') as HTMLElement;
    expect(left.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bar.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.keyDown(bar, { key: 'ArrowRight' });
    expect(bar).toHaveAttribute('aria-valuenow', '416');
    expect(detailsWidth()).toBe('416px');
    fireEvent.keyDown(bar, { key: 'ArrowLeft', shiftKey: true });
    expect(bar).toHaveAttribute('aria-valuenow', '352');
    fireEvent.keyDown(bar, { key: 'End' });
    expect(bar).toHaveAttribute('aria-valuenow', '640');
    fireEvent.keyDown(bar, { key: 'ArrowRight' });
    expect(bar).toHaveAttribute('aria-valuenow', '640');
    fireEvent.keyDown(bar, { key: 'Home' });
    expect(bar).toHaveAttribute('aria-valuenow', '280');
    fireEvent.keyDown(bar, { key: 'ArrowLeft' });
    expect(bar).toHaveAttribute('aria-valuenow', '280');
    expect(localStorage.getItem(KEY)).toBe('280');
    await expectAccessible();
  });

  it('dragged, within its bounds, and remembered for its person on this device', async () => {
    at('/documents/doc-1', WIDER);
    const bar = await line();
    fireEvent.pointerDown(bar, { clientX: 640, pointerId: 1 });
    fireEvent.pointerMove(bar, { clientX: 700, pointerId: 1 });
    // As it moves: the details with it; kept once let go.
    expect(detailsWidth()).toBe('460px');
    expect(localStorage.getItem(KEY)).toBeNull();
    fireEvent.pointerUp(bar, { clientX: 720, pointerId: 1 });
    expect(bar).toHaveAttribute('aria-valuenow', '480');
    expect(localStorage.getItem(KEY)).toBe('480');
    // Far past either end: the end.
    fireEvent.pointerDown(bar, { clientX: 700, pointerId: 2 });
    fireEvent.pointerUp(bar, { clientX: 100, pointerId: 2 });
    expect(bar).toHaveAttribute('aria-valuenow', '280');
    fireEvent.pointerDown(bar, { clientX: 100, pointerId: 3 });
    fireEvent.pointerUp(bar, { clientX: 1500, pointerId: 3 });
    expect(bar).toHaveAttribute('aria-valuenow', '640');
    // Opened again: as it was left.
    localStorage.setItem(KEY, '500');
    act(() => {
      window.history.pushState({}, '', '/documents');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await screen.findByRole('grid', { name: /^Documents, sorted by/ });
    act(() => {
      window.history.pushState({}, '', '/documents/doc-1');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(await line()).toHaveAttribute('aria-valuenow', '500');
    expect(detailsWidth()).toBe('500px');
  });

  it('starts where each width’s layout was: 400 at 1280, 304 at 1024, 345 at 900 px; the pages keep about 360', async () => {
    for (const [px, start, max] of [
      [WIDE, 400, 624],
      [1024, 304, 368],
      [MID, 345, 388],
    ] as const) {
      at('/documents/doc-1', px);
      const bar = await line();
      expect(bar).toHaveAttribute('aria-valuenow', String(start));
      expect(bar).toHaveAttribute('aria-valuemax', String(max));
      cleanup();
    }
  });

  it('a width kept at a wider window is held to this one; nonsense kept starts it as new', async () => {
    localStorage.setItem(KEY, '9000');
    at('/documents/doc-1', WIDER);
    expect(await line()).toHaveAttribute('aria-valuenow', '640');
    cleanup();
    // 600 kept, at 900 px: no wider than leaves the pages their room.
    localStorage.setItem(KEY, '600');
    at('/documents/doc-1', MID);
    expect(await line()).toHaveAttribute('aria-valuenow', '388');
    expect(detailsWidth()).toBe('388px');
    cleanup();
    localStorage.setItem(KEY, '50');
    at('/documents/doc-1', WIDER);
    expect(await line()).toHaveAttribute('aria-valuenow', '280');
    cleanup();
    localStorage.setItem(KEY, 'wide');
    at('/documents/doc-1', WIDER);
    expect(await line()).toHaveAttribute('aria-valuenow', '400');
  });

  it('storage blocked: as it starts, still moved, nothing thrown', async () => {
    const realGet = Object.getOwnPropertyDescriptor(Storage.prototype, 'getItem')
      ?.value as Storage['getItem'];
    const realSet = Object.getOwnPropertyDescriptor(Storage.prototype, 'setItem')
      ?.value as Storage['setItem'];
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (
      this: Storage,
      key: string,
    ) {
      if (key.startsWith('fdv.document.')) throw new Error('blocked');
      return realGet.call(this, key);
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key.startsWith('fdv.document.')) throw new Error('blocked');
      realSet.call(this, key, value);
    });
    at('/documents/doc-1', WIDER);
    const bar = await line();
    expect(bar).toHaveAttribute('aria-valuenow', '400');
    fireEvent.keyDown(bar, { key: 'ArrowRight' });
    expect(bar).toHaveAttribute('aria-valuenow', '416');
    expect(detailsWidth()).toBe('416px');
    expect(get).toHaveBeenCalledWith(KEY);
    expect(set).toHaveBeenCalledWith(KEY, '416');
  });

  it('on a phone: one column as before, no line, nothing of its width read', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem');
    at('/documents/doc-1', PHONE);
    await screen.findByRole('region', { name: "Details of Mansoor's passport" });
    expect(screen.queryByRole('separator', { name: 'Width of the details' })).toBeNull();
    expect(screen.getByRole('main')).not.toHaveClass('doc-panes');
    expect(detailsWidth()).toBe('');
    expect(get).not.toHaveBeenCalledWith(KEY);
  });
});

describe('the pages, zoomed (0.9.0)', () => {
  it('Zoom in and Zoom out step through the browser’s steps from the fit, stop at 200% and 25%, and the zoom says it and goes back to the fit', async () => {
    at('/documents/doc-1', WIDE);
    const right = await pages();
    const img = await shownPage(right);
    const zoomIn = within(right).getByRole('button', { name: 'Zoom in' });
    const zoomOut = within(right).getByRole('button', { name: 'Zoom out' });
    const fit = within(right).getByRole('button', { name: 'Fit to width' });
    // Fitted to the width: 500 of the page's 1000 px.
    await waitFor(() => expect(readout(right)).toHaveTextContent('50%'));
    expect(readout(right)).toHaveAccessibleName('50%, back to Fit to width');
    expect(fit).toHaveAttribute('aria-pressed', 'true');
    expect(zoomIn).toHaveAttribute('title', 'Zoom in');
    expect(zoomOut).toHaveAttribute('title', 'Zoom out');
    const seen: string[] = [];
    while (!zoomIn.hasAttribute('disabled')) {
      fireEvent.click(zoomIn);
      seen.push(readout(right).textContent ?? '');
    }
    expect(seen).toEqual([
      '67%',
      '75%',
      '80%',
      '90%',
      '100%',
      '110%',
      '125%',
      '150%',
      '175%',
      '200%',
    ]);
    // At 200% the page is 2000 px wide, and no wider: it would only blur.
    expect(img).toHaveStyle({ width: '2000px' });
    expect(fit).toHaveAttribute('aria-pressed', 'false');
    expect(right.querySelector('.viewer')).not.toHaveClass('viewer-fit');
    expect(
      within(right).getByText(/200% is as far as its pages zoom/, { exact: false }),
    ).toHaveTextContent('Download it to see the original.');
    seen.length = 0;
    while (!zoomOut.hasAttribute('disabled')) {
      fireEvent.click(zoomOut);
      seen.push(readout(right).textContent ?? '');
    }
    expect(seen).toEqual([
      '175%',
      '150%',
      '125%',
      '110%',
      '100%',
      '90%',
      '80%',
      '75%',
      '67%',
      '50%',
      '33%',
      '25%',
    ]);
    expect(img).toHaveStyle({ width: '250px' });
    expect(within(right).queryByText(/is as far as its pages zoom/)).toBeNull();
    // The zoom, pressed: fitted to the width again.
    fireEvent.click(readout(right));
    expect(fit).toHaveAttribute('aria-pressed', 'true');
    expect(readout(right)).toHaveTextContent('50%');
    expect(right.querySelector('.viewer')).toHaveClass('viewer-fit');
    expect(img.style.width).toBe('');
    await expectAccessible();
  });

  it('Fit page: the whole page in the pane; Fit to width pressed again, its own size', async () => {
    at('/documents/doc-1', WIDE);
    const right = await pages();
    const img = await shownPage(right);
    fireEvent.click(within(right).getByRole('button', { name: 'Fit page' }));
    // 600 px of room for 1414 px of page: 42%.
    expect(within(right).getByRole('button', { name: 'Fit page' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(readout(right)).toHaveTextContent('42%');
    expect(img).toHaveStyle({ width: '424px' });
    fireEvent.click(within(right).getByRole('button', { name: 'Fit to width' }));
    expect(readout(right)).toHaveTextContent('50%');
    fireEvent.click(within(right).getByRole('button', { name: 'Fit to width' }));
    expect(readout(right)).toHaveTextContent('100%');
    expect(img).toHaveStyle({ width: '1000px' });
  });

  it('the steps are the browser’s, and stop at the cap', () => {
    expect(ZOOM_STEPS).toEqual([
      0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4,
    ]);
    expect(ZOOM_MAX).toBe(2);
    expect(zoomStep(1, 1)).toBe(1.1);
    expect(zoomStep(1, -1)).toBe(0.9);
    expect(zoomStep(0.72, 1)).toBe(0.75);
    expect(zoomStep(0.72, -1)).toBe(0.67);
    expect(zoomStep(2, 1)).toBe(2);
    expect(zoomStep(1.9, 1)).toBe(2);
    expect(zoomStep(2.4, -1)).toBe(2);
    expect(zoomStep(0.25, -1)).toBe(0.25);
  });

  it('+, − and 0 with the page in focus; nowhere else, and not with single keys off', async () => {
    at('/documents/doc-1', WIDE);
    const right = await pages();
    await shownPage(right);
    const viewer = within(right).getByRole('group', { name: /^Page 1 of 2/ });
    expect(viewer).toHaveAttribute('aria-keyshortcuts', 'PageUp PageDown [ ] + - 0');
    expect(within(right).getByRole('button', { name: 'Zoom in' })).toHaveAttribute(
      'aria-keyshortcuts',
      '+',
    );
    await waitFor(() => expect(readout(right)).toHaveTextContent('50%'));
    // Elsewhere, the keys are the page's.
    fireEvent.keyDown(document.body, { key: '+' });
    fireEvent.keyDown(screen.getByRole('heading', { level: 1 }), { key: '+' });
    fireEvent.keyDown(within(right).getByRole('button', { name: 'Next page' }), { key: '+' });
    expect(readout(right)).toHaveTextContent('50%');
    fireEvent.keyDown(viewer, { key: '+' });
    expect(readout(right)).toHaveTextContent('67%');
    fireEvent.keyDown(viewer, { key: '=' });
    expect(readout(right)).toHaveTextContent('75%');
    fireEvent.keyDown(viewer, { key: '-' });
    expect(readout(right)).toHaveTextContent('67%');
    // Ctrl and + is the browser's own zoom: left be.
    fireEvent.keyDown(viewer, { key: '+', ctrlKey: true });
    expect(readout(right)).toHaveTextContent('67%');
    fireEvent.keyDown(viewer, { key: '0' });
    expect(readout(right)).toHaveTextContent('50%');
    expect(within(right).getByRole('button', { name: 'Fit to width' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // The shell's own single keys still work outside it: `/` to the search box.
    fireEvent.keyDown(document.body, { key: '/' });
    await waitFor(() =>
      expect(screen.getByRole('searchbox', { name: 'Search the vault' })).toHaveFocus(),
    );
  });

  it('with single keys off, + − 0 do nothing, and the buttons still zoom', async () => {
    localStorage.setItem('fdv.shortcuts', 'off');
    at('/documents/doc-1', WIDE);
    const right = await pages();
    await shownPage(right);
    const viewer = within(right).getByRole('group', { name: /^Page 1 of 2/ });
    expect(viewer).toHaveAttribute('aria-keyshortcuts', 'PageUp PageDown');
    expect(within(right).getByRole('button', { name: 'Zoom in' })).not.toHaveAttribute(
      'aria-keyshortcuts',
    );
    await waitFor(() => expect(readout(right)).toHaveTextContent('50%'));
    for (const key of ['+', '=', '-', '0']) {
      const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      viewer.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
    }
    expect(readout(right)).toHaveTextContent('50%');
    expect(within(right).getByText(/^With the page in focus/)).toHaveTextContent(
      'With the page in focus, Page Up and Page Down turn the pages.',
    );
    fireEvent.click(within(right).getByRole('button', { name: 'Zoom in' }));
    expect(readout(right)).toHaveTextContent('67%');
  });

  it('Ctrl or ⌘ and the wheel over the page zoom it and never the browser; anywhere else they are left be', async () => {
    at('/documents/doc-1', WIDE);
    const right = await pages();
    await shownPage(right);
    await waitFor(() => expect(readout(right)).toHaveTextContent('50%'));
    const viewer = within(right).getByRole('group', { name: /^Page 1 of 2/ });
    const wheel = (on: Element, over: WheelEventInit) => {
      const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...over });
      act(() => {
        on.dispatchEvent(e);
      });
      return e.defaultPrevented;
    };
    // Up, with Ctrl: in, about e^0.25 (a notch).
    expect(wheel(viewer, { ctrlKey: true, deltaY: -100 })).toBe(true);
    expect(readout(right)).toHaveTextContent('64%');
    // Down, with ⌘: out.
    expect(wheel(viewer, { metaKey: true, deltaY: 100 })).toBe(true);
    expect(readout(right)).toHaveTextContent('50%');
    // Over the page, without Ctrl: the page scrolls, as ever.
    expect(wheel(viewer, { deltaY: 100 })).toBe(false);
    expect(readout(right)).toHaveTextContent('50%');
    // Over the details, or the bar above the page: the browser's.
    const details = document.getElementById('doc-details') as HTMLElement;
    expect(wheel(details, { ctrlKey: true, deltaY: -100 })).toBe(false);
    expect(
      wheel(within(right).getByRole('button', { name: 'Zoom in' }), {
        ctrlKey: true,
        deltaY: -100,
      }),
    ).toBe(false);
    expect(wheel(document.body, { ctrlKey: true, deltaY: -100 })).toBe(false);
    expect(readout(right)).toHaveTextContent('50%');
    // Never past either end.
    for (let i = 0; i < 20; i += 1) wheel(viewer, { ctrlKey: true, deltaY: -100 });
    expect(readout(right)).toHaveTextContent('200%');
    for (let i = 0; i < 30; i += 1) wheel(viewer, { ctrlKey: true, deltaY: 100 });
    expect(readout(right)).toHaveTextContent('25%');
  });

  it('the zoom holds as the pages turn, and another document starts fitted to the width', async () => {
    at('/documents/doc-1', WIDE, {
      documents: [
        { ...PASSPORT },
        { ...PASSPORT, id: 'doc-2', title: 'House deed', latest_version_id: 'v-2', etag: '"d"' },
      ],
    });
    const right = await pages();
    await shownPage(right);
    fireEvent.click(within(right).getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(within(right).getByRole('button', { name: 'Zoom in' }));
    expect(readout(right)).toHaveTextContent('75%');
    fireEvent.click(within(right).getByRole('button', { name: 'Next page' }));
    const second = await shownPage(right, 'Page 2 of 2');
    expect(readout(right)).toHaveTextContent('75%');
    expect(second).toHaveStyle({ width: '750px' });
    fireEvent.keyDown(within(right).getByRole('group', { name: /^Page 2 of 2/ }), {
      key: 'PageUp',
    });
    expect(await within(right).findByRole('img', { name: 'Page 1 of 2' })).toHaveStyle({
      width: '750px',
    });
    // Another document: fitted to the width.
    act(() => {
      window.history.pushState({}, '', '/documents/doc-2');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    const deed = await screen.findByRole('region', { name: 'Pages of House deed' });
    await shownPage(deed);
    expect(within(deed).getByRole('button', { name: 'Fit to width' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await waitFor(() => expect(readout(deed)).toHaveTextContent('50%'));
  });

  it('nothing to zoom until a page is shown; an Essential’s pages still wait for “Confirm it’s you”', async () => {
    at('/documents/doc-1', WIDE, { stepUpNeeded: true });
    const right = await pages();
    expect(
      await within(right).findByText('Confirm it’s you to see its pages.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(right).getByRole('button', { name: 'Zoom in' })).toBeDisabled();
    expect(within(right).getByRole('button', { name: 'Zoom out' })).toBeDisabled();
    const viewer = within(right).getByRole('group', { name: /^Page 1 of 2/ });
    const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true });
    viewer.dispatchEvent(e);
    // No page: the browser's own zoom, as anywhere.
    expect(e.defaultPrevented).toBe(false);
  });
});

describe('the pages beside Edit’s card (0.9.0)', () => {
  it('from 768 px: the card in the details’ place, the line, and the pages, each named; Save as before', async () => {
    for (const px of [WIDER, MID]) {
      const state = at('/documents/doc-1/confirm', px);
      const card = await screen.findByRole('region', { name: 'The details' });
      const right = await pages();
      expect(card.closest('main')).toHaveClass('doc-panes');
      expect(card).toHaveAttribute('id', 'doc-details');
      // The card first, then the line, then the pages: the form never under them.
      const bar = await line();
      expect(card.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(bar.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(within(card).getByLabelText(/^Name/)).toBeInTheDocument();
      expect(within(right).queryByLabelText(/^Name/)).toBeNull();
      await shownPage(right);
      expect(within(right).getByRole('button', { name: 'Zoom in' })).toBeEnabled();
      expect(state.calls.filter((c) => /\/pages\/\d+$/.test(c.url))).toHaveLength(1);
      await expectAccessible();
      if (px === WIDER) {
        // Back, as ever, to the document.
        expect(screen.getByRole('link', { name: 'Back' })).toHaveAttribute(
          'href',
          '/documents/doc-1',
        );
        fireEvent.change(within(card).getByLabelText(/^Name/), {
          target: { value: 'Passport, renewed' },
        });
        fireEvent.click(within(card).getByRole('button', { name: 'Save to the vault' }));
        await waitFor(() =>
          expect(
            state.calls.some((c) => c.method === 'PATCH' && c.url.endsWith('/documents/doc-1')),
          ).toBe(true),
        );
        await waitFor(() => expect(window.location.pathname).toBe('/documents/doc-1'));
      }
      cleanup();
    }
  });

  it('the line is the document’s own: a width kept on its page is Edit’s too', async () => {
    localStorage.setItem(KEY, '520');
    at('/documents/doc-1/confirm', WIDER);
    const bar = await line();
    expect(bar).toHaveAttribute('aria-valuenow', '520');
    fireEvent.keyDown(bar, { key: 'ArrowLeft' });
    expect(localStorage.getItem(KEY)).toBe('504');
  });

  it('on a phone: the card alone, as before; its pages are not asked for', async () => {
    const state = at('/documents/doc-1/confirm', PHONE);
    await screen.findByLabelText(/^Name/);
    expect(screen.queryByRole('region', { name: "Pages of Mansoor's passport" })).toBeNull();
    expect(screen.queryByRole('separator', { name: 'Width of the details' })).toBeNull();
    expect(screen.getByRole('main')).not.toHaveClass('doc-panes');
    await new Promise((r) => setTimeout(r, 50));
    expect(state.calls.some((c) => /\/versions$|\/pages\/\d+$/.test(c.url))).toBe(false);
  });

  it('an Essential’s pages ask first in Edit too, and not answering never holds the card', async () => {
    const state = at('/documents/doc-1/confirm', WIDER, { stepUpNeeded: true });
    const right = await pages();
    expect(
      await within(right).findByText('Confirm it’s you to see its pages.'),
    ).toBeInTheDocument();
    // Nothing asked on arrival.
    expect(screen.queryByRole('dialog')).toBeNull();
    const card = await screen.findByRole('region', { name: 'The details' });
    const name = within(card).getByLabelText(/^Name/);
    expect(name).toBeEnabled();
    fireEvent.change(name, { target: { value: 'Passport, renewed' } });
    expect(name).toHaveValue('Passport, renewed');
    expect(within(card).getByRole('button', { name: 'Save to the vault' })).toBeEnabled();
    expect(state.calls.filter((c) => /\/pages\/\d+$/.test(c.url))).toHaveLength(1);
  });
});

describe('where the details start, and how wide they may be (0.9.0)', () => {
  it('as the layout before the line was, at every width', () => {
    // From 1024 px: 40% of the room, 280 to 400.
    expect(startingWidth('wide', 600)).toBe(280);
    expect(startingWidth('wide', 800)).toBe(320);
    expect(startingWidth('wide', 1656)).toBe(400);
    // 768–1023 px: 5 parts in 11 of the room less the 20 px between, from 272.
    expect(startingWidth('mid', 648)).toBe(285);
    expect(startingWidth('mid', 500)).toBe(272);
    // Bounds: 280 to 640, the pages keeping 360 (and 32 for the line).
    expect(detailsBounds('wide', 1656)).toEqual({ start: 400, min: 280, max: 640, step: 16 });
    expect(detailsBounds('wide', 1016)).toEqual({ start: 400, min: 280, max: 624, step: 16 });
    // Too narrow for both: the details' narrowest.
    expect(detailsBounds('mid', 600)).toEqual({ start: 280, min: 280, max: 280, step: 16 });
  });
});
