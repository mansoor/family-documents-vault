import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PageViewer, WHEEL_QUIET_MS } from './page-viewer.js';

/**
 * The pages turned with the scroll wheel and the keys (0.9.0): at Fit page
 * each movement of the wheel and each arrow turns one page; at Fit to width
 * they scroll, and turn at the page's foot or top only when moved again
 * from there; zoomed to a size of its own, they only scroll.
 *
 * jsdom has no layout: the viewer's height, its page's height and how far
 * it is scrolled are said here, and each wheel event says when it came.
 */

function Pages(props: {
  total?: number;
  start?: number;
  url?: boolean;
  /** Pages still on their way: no picture yet. */
  coming?: number[];
  noteAction?: ReactNode;
}) {
  const [n, setN] = useState(props.start ?? 1);
  return (
    <PageViewer
      label="Pages of letters.pdf"
      total={props.total ?? 5}
      n={n}
      onTurn={setN}
      url={props.url === false || props.coming?.includes(n) ? null : `blob:page-${n}`}
      note="Loading the page…"
      noteAction={props.noteAction}
      none="No pages."
      fitPage
    />
  );
}

let clock = 10_000;
/** A wheel event over `on`, `after` ms after the last one: whether it was used. */
function wheel(on: Element, over: WheelEventInit, after = 16) {
  clock += after;
  const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...over });
  Object.defineProperty(e, 'timeStamp', { value: clock });
  act(() => {
    on.dispatchEvent(e);
  });
  return e.defaultPrevented;
}
/** A key pressed on `on`: whether it was used. */
function key(on: Element, k: string, over: KeyboardEventInit = {}) {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...over });
  act(() => {
    on.dispatchEvent(e);
  });
  return e.defaultPrevented;
}
const quiet = () => {
  clock += WHEEL_QUIET_MS + 50;
};

/** The viewer, `tall` px of page in 600 px of room, scrolled as set. */
function viewer(tall = 600) {
  const el = screen.getByRole('group', { name: /^Page \d of \d/ });
  let top = 0;
  Object.defineProperties(el, {
    clientHeight: { configurable: true, get: () => 600 },
    scrollHeight: { configurable: true, get: () => tall },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v;
      },
    },
  });
  return el;
}
/** The page shown, drawn: its own size known, as a browser knows it once it has loaded. */
const drawn = () => fireEvent.load(screen.getByRole('img', { name: /^Page \d of \d$/ }));
/** The page said in the bar (its live region). */
const at = () => document.querySelector('.viewer-at')?.textContent;
const fitPage = () => fireEvent.click(screen.getByRole('button', { name: 'Fit page' }));

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', {
    configurable: true,
    get: () => 1000,
  });
  Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', {
    configurable: true,
    get: () => 1414,
  });
});
afterEach(() => {
  localStorage.clear();
  Reflect.deleteProperty(HTMLImageElement.prototype, 'naturalWidth');
  Reflect.deleteProperty(HTMLImageElement.prototype, 'naturalHeight');
});

describe('Fit page: the wheel and the keys turn the pages', () => {
  it('one movement of the wheel turns one page, however many events it comes as', () => {
    render(<Pages />);
    fitPage();
    const v = viewer();
    // A trackpad's small steps: used (never the window's), turning at 40 px.
    expect(wheel(v, { deltaY: 15 })).toBe(true);
    expect(wheel(v, { deltaY: 15 })).toBe(true);
    expect(at()).toBe('Page 1 of 5');
    expect(wheel(v, { deltaY: 15 })).toBe(true);
    expect(at()).toBe('Page 2 of 5');
    // The rest of the movement, and its glide: spent, not another page.
    for (let i = 0; i < 40; i += 1) expect(wheel(v, { deltaY: 30 })).toBe(true);
    expect(at()).toBe('Page 2 of 5');
    // A notch of a mouse wheel, after a pause: the next page.
    quiet();
    expect(wheel(v, { deltaY: 100 }, 0)).toBe(true);
    expect(at()).toBe('Page 3 of 5');
    // Firefox's lines.
    quiet();
    wheel(v, { deltaY: 3, deltaMode: 1 }, 0);
    expect(at()).toBe('Page 4 of 5');
    // Up: the one before.
    quiet();
    wheel(v, { deltaY: -100 }, 0);
    expect(at()).toBe('Page 3 of 5');
    // The live region says it, and the group and the buttons follow.
    expect(document.querySelector('.viewer-at')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('group', { name: /^Page 3 of 5\./ })).toBe(v);
  });

  it('never past either end, and the window keeps the wheel there', () => {
    render(<Pages />);
    fitPage();
    const v = viewer();
    expect(wheel(v, { deltaY: -100 })).toBe(false);
    expect(at()).toBe('Page 1 of 5');
    expect(screen.getByRole('button', { name: /Previous page/ })).toBeDisabled();
    for (let i = 0; i < 6; i += 1) {
      quiet();
      wheel(v, { deltaY: 100 }, 0);
    }
    expect(at()).toBe('Page 5 of 5');
    expect(screen.getByRole('button', { name: /Next page/ })).toBeDisabled();
    quiet();
    expect(wheel(v, { deltaY: 100 }, 0)).toBe(false);
    expect(at()).toBe('Page 5 of 5');
  });

  it('the arrows, Page Up and Page Down turn a page; Home and End to the first and the last; never past either end', () => {
    render(<Pages />);
    fitPage();
    const v = viewer();
    expect(v).toHaveAttribute('tabindex', '0');
    expect(v).toHaveAccessibleName(
      'Page 1 of 5. The arrow keys, Page Up and Page Down turn the pages, as does the scroll wheel; Home and End go to the first and the last.',
    );
    expect(v).toHaveAttribute(
      'aria-keyshortcuts',
      'PageUp PageDown ArrowUp ArrowDown ArrowLeft ArrowRight Home End [ ] + - 0',
    );
    expect(key(v, 'ArrowDown')).toBe(true);
    expect(at()).toBe('Page 2 of 5');
    key(v, 'ArrowRight');
    expect(at()).toBe('Page 3 of 5');
    key(v, 'PageDown');
    expect(at()).toBe('Page 4 of 5');
    key(v, 'ArrowLeft');
    expect(at()).toBe('Page 3 of 5');
    key(v, 'ArrowUp');
    expect(at()).toBe('Page 2 of 5');
    key(v, 'PageUp');
    expect(at()).toBe('Page 1 of 5');
    // At either end, the arrows are the browser's.
    expect(key(v, 'ArrowUp')).toBe(false);
    expect(key(v, 'ArrowLeft')).toBe(false);
    expect(at()).toBe('Page 1 of 5');
    expect(key(v, 'End')).toBe(true);
    expect(at()).toBe('Page 5 of 5');
    expect(key(v, 'ArrowDown')).toBe(false);
    expect(key(v, 'ArrowRight')).toBe(false);
    expect(at()).toBe('Page 5 of 5');
    // Already there: the browser's own End.
    expect(key(v, 'End')).toBe(false);
    expect(key(v, 'Home')).toBe(true);
    expect(at()).toBe('Page 1 of 5');
  });

  it('a slow wheel’s small steps add up; a mouse wheel’s notch turns at once, however small its pixels', () => {
    render(<Pages />);
    fitPage();
    const v = viewer();
    // Each step its own movement, a third of a second apart: the third turns.
    expect(wheel(v, { deltaY: 15 }, 300)).toBe(true);
    expect(wheel(v, { deltaY: 15 }, 300)).toBe(true);
    expect(at()).toBe('Page 1 of 5');
    wheel(v, { deltaY: 15 }, 300);
    expect(at()).toBe('Page 2 of 5');
    // A notch, said by the browser as 120 of the old wheel's units.
    quiet();
    const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 8 });
    Object.defineProperties(e, {
      timeStamp: { value: clock },
      wheelDeltaY: { value: -120 },
    });
    act(() => {
      v.dispatchEvent(e);
    });
    expect(e.defaultPrevented).toBe(true);
    expect(at()).toBe('Page 3 of 5');
  });
});

describe('Fit to width: the page scrolls, and turns at its foot or top', () => {
  it('the wheel scrolls it; the movement that reached the foot turns nothing; a fresh one there turns to the next, from its top', () => {
    render(<Pages />);
    const v = viewer(1400);
    drawn();
    // Scrolling down the page: the browser's.
    expect(wheel(v, { deltaY: 100 })).toBe(false);
    v.scrollTop = 400;
    expect(wheel(v, { deltaY: 100 })).toBe(false);
    v.scrollTop = 800; // at its foot
    // The same movement, gliding on at the foot: nothing turns.
    for (let i = 0; i < 20; i += 1) expect(wheel(v, { deltaY: 60 })).toBe(false);
    expect(at()).toBe('Page 1 of 5');
    // A fresh movement at the foot: the next page, from its top.
    quiet();
    expect(wheel(v, { deltaY: 20 }, 0)).toBe(true);
    expect(at()).toBe('Page 1 of 5');
    expect(wheel(v, { deltaY: 30 })).toBe(true);
    expect(at()).toBe('Page 2 of 5');
    expect(v.scrollTop).toBe(0);
    // Its glide is spent: the new page does not scroll, nor turn again.
    for (let i = 0; i < 20; i += 1) expect(wheel(v, { deltaY: 60 })).toBe(true);
    expect(at()).toBe('Page 2 of 5');
    expect(v.scrollTop).toBe(0);
    // Not drawn yet: no foot in sight, so a fresh movement turns nothing.
    v.scrollTop = 800;
    quiet();
    expect(wheel(v, { deltaY: 100 }, 0)).toBe(false);
    expect(at()).toBe('Page 2 of 5');
    // Drawn, and at its foot: a fresh movement turns.
    drawn();
    quiet();
    expect(wheel(v, { deltaY: 100 }, 0)).toBe(true);
    expect(at()).toBe('Page 3 of 5');
  });

  it('a movement the browser will not let be stopped scrolls, and turns nothing', () => {
    render(<Pages />);
    const v = viewer(1400);
    drawn();
    v.scrollTop = 800;
    quiet();
    expect(wheel(v, { deltaY: 100, cancelable: false }, 0)).toBe(false);
    // The rest of it, stoppable again: still nothing.
    expect(wheel(v, { deltaY: 100 })).toBe(false);
    expect(at()).toBe('Page 1 of 5');
    quiet();
    expect(wheel(v, { deltaY: 100 }, 0)).toBe(true);
    expect(at()).toBe('Page 2 of 5');
  });

  it('a page still on its way is never turned past: neither its top nor its foot is in sight', () => {
    render(<Pages coming={[2]} />);
    const v = viewer(500);
    drawn();
    expect(key(v, 'ArrowDown')).toBe(true);
    expect(at()).toBe('Page 2 of 5');
    expect(screen.getByText('Loading the page…')).toBeInTheDocument();
    // Pressed again before it is shown, or the wheel moved afresh: it stays.
    expect(key(v, 'ArrowDown')).toBe(false);
    quiet();
    expect(wheel(v, { deltaY: 100 }, 0)).toBe(false);
    expect(key(v, 'ArrowUp')).toBe(false);
    expect(at()).toBe('Page 2 of 5');
    // Page Down still turns, as ever.
    expect(key(v, 'PageDown')).toBe(true);
    expect(at()).toBe('Page 3 of 5');
  });

  it('a fresh movement up at the top turns to the one before, shown from its foot', () => {
    render(<Pages start={3} />);
    const v = viewer(1400);
    drawn();
    v.scrollTop = 300;
    expect(wheel(v, { deltaY: -100 })).toBe(false);
    v.scrollTop = 0;
    expect(wheel(v, { deltaY: -100 })).toBe(false);
    expect(at()).toBe('Page 3 of 5');
    quiet();
    expect(wheel(v, { deltaY: -100 }, 0)).toBe(true);
    expect(at()).toBe('Page 2 of 5');
    expect(v.scrollTop).toBe(1400);
    // Drawn: still from its foot.
    fireEvent.load(screen.getByRole('img', { name: 'Page 2 of 5' }));
    expect(v.scrollTop).toBe(1400);
    // Going on up from its foot scrolls it: the browser's.
    quiet();
    expect(wheel(v, { deltaY: -100 }, 0)).toBe(false);
    expect(at()).toBe('Page 2 of 5');
  });

  it('a page that fits the pane turns with each movement, as at Fit page', () => {
    render(<Pages />);
    const v = viewer(500);
    drawn();
    expect(wheel(v, { deltaY: 100 })).toBe(true);
    expect(at()).toBe('Page 2 of 5');
    drawn();
    quiet();
    wheel(v, { deltaY: -100 }, 0);
    expect(at()).toBe('Page 1 of 5');
  });

  it('the arrows scroll, and at the foot or top turn — pressed afresh, not held; Page Up and Page Down turn from the top; Home and End', () => {
    render(<Pages />);
    const v = viewer(1400);
    expect(v).toHaveAttribute(
      'aria-keyshortcuts',
      'PageUp PageDown ArrowUp ArrowDown Home End [ ] + - 0',
    );
    drawn();
    v.scrollTop = 300;
    expect(key(v, 'ArrowDown')).toBe(false);
    expect(key(v, 'ArrowUp')).toBe(false);
    expect(at()).toBe('Page 1 of 5');
    v.scrollTop = 800;
    // Held down, reaching the foot: it stays.
    expect(key(v, 'ArrowDown', { repeat: true })).toBe(false);
    expect(at()).toBe('Page 1 of 5');
    // Pressed again there: the next page, from its top.
    expect(key(v, 'ArrowDown')).toBe(true);
    expect(at()).toBe('Page 2 of 5');
    expect(v.scrollTop).toBe(0);
    // Left and right are the browser's.
    expect(key(v, 'ArrowRight')).toBe(false);
    expect(key(v, 'ArrowLeft')).toBe(false);
    // At its top, once it is drawn, Arrow Up: the one before, from its foot.
    expect(key(v, 'ArrowUp')).toBe(false);
    drawn();
    expect(key(v, 'ArrowUp')).toBe(true);
    expect(at()).toBe('Page 1 of 5');
    expect(v.scrollTop).toBe(1400);
    // Page Down from part way: the next, from its top; Page Up the same.
    v.scrollTop = 300;
    key(v, 'PageDown');
    expect(at()).toBe('Page 2 of 5');
    expect(v.scrollTop).toBe(0);
    v.scrollTop = 500;
    key(v, 'PageUp');
    expect(at()).toBe('Page 1 of 5');
    expect(v.scrollTop).toBe(0);
    // Home on the first page: the browser's, to its top.
    expect(key(v, 'Home')).toBe(false);
    expect(key(v, 'End')).toBe(true);
    expect(at()).toBe('Page 5 of 5');
    expect(v.scrollTop).toBe(0);
    // The last page's foot: nothing further.
    v.scrollTop = 800;
    expect(key(v, 'ArrowDown')).toBe(false);
    expect(at()).toBe('Page 5 of 5');
    key(v, 'Home');
    expect(at()).toBe('Page 1 of 5');
  });
});

describe('zoomed to a size of its own: as ever', () => {
  it('the wheel and the arrows only scroll, Home and End too; Page Up and Page Down still turn', () => {
    render(<Pages />);
    // Fit to width pressed again: the page's own size.
    fireEvent.click(screen.getByRole('button', { name: 'Fit to width' }));
    const v = viewer(1400);
    expect(v).toHaveAttribute('aria-keyshortcuts', 'PageUp PageDown [ ] + - 0');
    expect(v).toHaveAccessibleName('Page 1 of 5. Page Up and Page Down turn the pages.');
    v.scrollTop = 800;
    quiet();
    for (let i = 0; i < 5; i += 1) expect(wheel(v, { deltaY: 100 })).toBe(false);
    quiet();
    expect(wheel(v, { deltaY: 100 }, 0)).toBe(false);
    for (const k of ['ArrowDown', 'ArrowRight', 'End', 'Home']) expect(key(v, k)).toBe(false);
    expect(at()).toBe('Page 1 of 5');
    expect(key(v, 'PageDown')).toBe(true);
    expect(at()).toBe('Page 2 of 5');
  });
});

describe('what is left be', () => {
  it('a viewer as tall as its page, the window scrolling instead: the wheel, the arrows, Home and End are the window’s', () => {
    render(<Pages />);
    const v = viewer();
    // One column (a narrow window): the stylesheet says it does not scroll
    // its page itself, and it runs off the top of the window.
    v.style.setProperty('--viewer-scrolls', '0');
    v.getBoundingClientRect = () => new DOMRect(0, -200, 400, 700);
    drawn();
    expect(v).toHaveAttribute('aria-keyshortcuts', 'PageUp PageDown [ ] + - 0');
    expect(v).toHaveAccessibleName('Page 1 of 5. Page Up and Page Down turn the pages.');
    for (const zoom of ['Fit to width', 'Fit page']) {
      if (zoom === 'Fit page') fitPage();
      quiet();
      expect(wheel(v, { deltaY: 100 }, 0)).toBe(false);
      quiet();
      expect(wheel(v, { deltaY: -100 }, 0)).toBe(false);
      for (const k of ['ArrowDown', 'ArrowRight', 'ArrowUp', 'End', 'Home']) {
        expect(key(v, k)).toBe(false);
      }
      expect(at()).toBe('Page 1 of 5');
    }
    // Page Down, and the buttons, still turn.
    expect(key(v, 'PageDown')).toBe(true);
    expect(at()).toBe('Page 2 of 5');
    fireEvent.click(screen.getByRole('button', { name: /Next page/ }));
    expect(at()).toBe('Page 3 of 5');
  });

  it('a page fitted in a scrolling viewer, its foot below the window: the wheel down is the window’s', () => {
    render(<Pages />);
    const v = viewer(500);
    v.getBoundingClientRect = () => new DOMRect(0, 400, 400, 600);
    drawn();
    quiet();
    expect(wheel(v, { deltaY: 100 }, 0)).toBe(false);
    expect(key(v, 'ArrowDown')).toBe(false);
    expect(at()).toBe('Page 1 of 5');
  });

  it('Ctrl or ⌘ and the wheel zoom the page, as ever, and turn nothing; Shift and the wheel are the browser’s', () => {
    render(<Pages />);
    fitPage();
    const v = viewer();
    expect(wheel(v, { deltaY: -100, ctrlKey: true })).toBe(true);
    expect(at()).toBe('Page 1 of 5');
    expect(screen.getByRole('button', { name: 'Fit page' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    fitPage();
    quiet();
    expect(wheel(v, { deltaY: 100, metaKey: true }, 0)).toBe(true);
    expect(at()).toBe('Page 1 of 5');
    fitPage();
    quiet();
    expect(wheel(v, { deltaY: 100, shiftKey: true }, 0)).toBe(false);
    expect(wheel(v, { deltaX: 100, deltaY: 10 })).toBe(false);
    expect(at()).toBe('Page 1 of 5');
  });

  it('keys in a field on the page are the field’s; on a button there, the arrows are the button’s', () => {
    render(
      <Pages
        url={false}
        noteAction={
          <>
            <input aria-label="A field" />
            <div contentEditable aria-label="Some text" role="textbox" />
            <button type="button">Try again</button>
          </>
        }
      />,
    );
    fitPage();
    viewer();
    for (const name of ['A field', 'Some text']) {
      const field = screen.getByRole('textbox', { name });
      for (const k of ['ArrowDown', 'PageDown', 'End', ']']) expect(key(field, k)).toBe(false);
    }
    const button = screen.getByRole('button', { name: 'Try again' });
    for (const k of ['ArrowDown', 'ArrowRight', 'End']) expect(key(button, k)).toBe(false);
    expect(at()).toBe('Page 1 of 5');
  });

  it('a single page: nothing turns, the wheel and the arrows are the browser’s', () => {
    render(<Pages total={1} />);
    fitPage();
    const v = viewer();
    expect(v).toHaveAttribute('aria-keyshortcuts', 'PageUp PageDown [ ] + - 0');
    expect(wheel(v, { deltaY: 100 })).toBe(false);
    for (const k of ['ArrowDown', 'ArrowUp', 'Home', 'End']) expect(key(v, k)).toBe(false);
    expect(at()).toBe('Page 1 of 1');
  });
});
