import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { ShellMode } from './shell.js';

/**
 * The wide layout's sidebar (Phase 6, the owner's ask): as wide as you
 * drag it, and folded to its icons if you like, opening over the page while
 * the pointer or the keyboard is on it. Both remembered on this device.
 * From 1024 px only: the icons' rail (768–1023 px) and the phone's layout
 * are as they were.
 */

/** Today's width, the narrowest and the widest. */
export const SIDE_DEFAULT = 216;
export const SIDE_MIN = 200;
export const SIDE_MAX = 360;
/** Folded, as wide as the icons' rail at 768–1023 px. */
export const RAIL = 72;
/** What the page beside it keeps, however wide the sidebar was left. */
export const MIN_CONTENT = 600;
/** ← and → move it this far; with Shift, further. */
export const STEP = 16;
export const BIG_STEP = 48;
/** Over the folded rail this long before it opens (a pointer passing by does nothing)… */
export const PEEK_OPEN_MS = 150;
/** …and away from it this long before it folds again (a move on the slant does not flicker). */
export const PEEK_CLOSE_MS = 300;
/**
 * Folding and opening again take this long (styles.css: the sidebar's
 * width and the page's start move together). The shell is moving until the
 * page's start has arrived; or, where nothing moves (prefers-reduced-motion)
 * or a busy page held it up, at the latest this long after: a move is never
 * cut short by the clock.
 */
export const MOVE_MS = 200;
export const MOVING_AT_MOST_MS = 600;
/** The page's start arriving (styles.css's `@keyframes side-shift`). */
export const MOVE_NAME = 'side-shift';

export const WIDTH_KEY = 'fdv.sidebar.width';
export const COLLAPSED_KEY = 'fdv.sidebar.collapsed';

// Kept in this browser's localStorage, which a private window may refuse:
// then the choice holds until the page is loaded again (as shortcuts.ts).
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Not kept: it holds for now.
  }
}

/** The width chosen on this device, or today's. */
export function storedWidth(): number {
  const n = Number(read(WIDTH_KEY));
  return Number.isFinite(n) && n > 0 ? n : SIDE_DEFAULT;
}

export function storedCollapsed(): boolean {
  return read(COLLAPSED_KEY) === '1';
}

/** The widest it can be in a window this wide: the page keeps MIN_CONTENT. */
export function widestFor(viewport: number): number {
  return Math.max(SIDE_MIN, Math.min(SIDE_MAX, viewport - MIN_CONTENT));
}

export function clampWidth(px: number, viewport: number): number {
  return Math.round(Math.min(widestFor(viewport), Math.max(SIDE_MIN, px)));
}

function watchViewport(changed: () => void): () => void {
  window.addEventListener('resize', changed);
  return () => window.removeEventListener('resize', changed);
}

const viewportWidth = () => window.innerWidth;

/** Where the sidebar's own keys are not to act: a dialog or a menu over the page. */
const overThePage = () => document.querySelector('[aria-modal="true"], [role="menu"]') !== null;

export interface Sidebar {
  /** Wide, and folded to its icons. */
  rail: boolean;
  /** Folded, and open over the page for now (the pointer or the focus on it). */
  peek: boolean;
  /** Its width, open, in this window. */
  width: number;
  widest: number;
  resizing: boolean;
  /** For the shell: its classes and the widths the stylesheet reads. */
  shellClass: string;
  shellStyle: CSSProperties | undefined;
  /** For the sidebar's <nav>: hover and focus open it, folded. */
  navProps: {
    onPointerEnter: (e: ReactPointerEvent) => void;
    onPointerLeave: (e: ReactPointerEvent) => void;
    onPointerDown: () => void;
    onPointerUp: () => void;
    onFocus: (e: ReactFocusEvent) => void;
    onBlur: (e: ReactFocusEvent) => void;
  };
  setWidth: (px: number, keep: boolean) => void;
  resetWidth: () => void;
  setResizing: (on: boolean) => void;
  toggle: () => void;
}

/**
 * `page` is the page beside it (the shell's `.shell-main`), whose start
 * moves with it as it folds and opens.
 */
export function useSidebar(mode: ShellMode, page: RefObject<HTMLDivElement | null>): Sidebar {
  const viewport = useSyncExternalStore(watchViewport, viewportWidth, () => 1280);
  const [chosen, setChosen] = useState(storedWidth);
  const [collapsed, setCollapsed] = useState(storedCollapsed);
  const [hoverOpen, setHoverOpen] = useState(false);
  const [focusOpen, setFocusOpen] = useState(false);
  const [resizing, setResizing] = useState(false);
  // Folded or opened a moment ago, until the page's start is there; and how
  // far it comes (from the right, folding; from the left, opening).
  const [moving, setMoving] = useState(false);
  const [shift, setShift] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const moved = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // A press on the rail moves focus into it too: that is the pointer's, not
  // the keyboard's, and the rail folds again when the pointer leaves.
  const pressed = useRef(false);

  const wide = mode === 'wide';
  const rail = wide && collapsed;
  const peek = rail && (hoverOpen || focusOpen);
  const width = clampWidth(chosen, viewport);
  const widest = widestFor(viewport);
  // Not folded any more (a window narrowed to the rail's): nothing left open
  // for when it is again.
  if (!rail && (hoverOpen || focusOpen)) {
    setHoverOpen(false);
    setFocusOpen(false);
  }

  const stop = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
  };
  useEffect(() => stop, []);
  useEffect(() => () => clearTimeout(moved.current), []);

  // The page's start arrived where it was going: no longer moving. Its own
  // move, not one inside it (a spinner's turn) bubbling up.
  useEffect(() => {
    const el = page.current;
    if (!el) return;
    const arrived = (e: AnimationEvent) => {
      if (e.target !== el || e.animationName !== MOVE_NAME) return;
      clearTimeout(moved.current);
      setMoving(false);
    };
    el.addEventListener('animationend', arrived);
    return () => el.removeEventListener('animationend', arrived);
  }, [page]);

  // Escape folds it while it is open over the page (WCAG 1.4.13), wherever
  // focus is: the pointer may be resting on it while the keys are elsewhere.
  useEffect(() => {
    if (!peek) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || overThePage()) return;
      stop();
      setHoverOpen(false);
      setFocusOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [peek]);

  const navProps: Sidebar['navProps'] = {
    onPointerEnter: (e) => {
      // A finger has no hover: a tap is for the link under it.
      if (!rail || e.pointerType === 'touch') return;
      stop();
      if (!hoverOpen) timer.current = setTimeout(() => setHoverOpen(true), PEEK_OPEN_MS);
    },
    onPointerLeave: (e) => {
      if (!rail || e.pointerType === 'touch') return;
      stop();
      timer.current = setTimeout(() => setHoverOpen(false), PEEK_CLOSE_MS);
    },
    onPointerDown: () => {
      pressed.current = true;
    },
    onPointerUp: () => {
      pressed.current = false;
    },
    onFocus: () => {
      const byPointer = pressed.current;
      pressed.current = false;
      if (rail && !byPointer) setFocusOpen(true);
    },
    onBlur: (e) => {
      const to = e.relatedTarget;
      if (to instanceof Node && e.currentTarget.contains(to)) return;
      setFocusOpen(false);
    },
  };

  const setWidth = (px: number, keep: boolean) => {
    const next = clampWidth(px, viewport);
    setChosen(next);
    if (keep) write(WIDTH_KEY, String(next));
  };

  return {
    rail,
    peek,
    width,
    widest,
    resizing,
    shellClass: wide
      ? `${collapsed ? ' side-collapsed' : ''}${peek ? ' side-peek' : ''}${resizing ? ' side-resizing' : ''}${moving ? ' side-moving' : ''}`
      : '',
    // The last move's distance stays when it is over: put, and taken away,
    // a value every element under the shell inherits would have each of
    // them looked at again, for nothing (measured).
    shellStyle: wide
      ? ({
          '--side-w': `${collapsed ? RAIL : width}px`,
          '--side-open-w': `${width}px`,
          '--side-shift': `${shift}px`,
        } as CSSProperties)
      : undefined,
    navProps,
    setWidth,
    resetWidth: () => {
      setChosen(SIDE_DEFAULT);
      write(WIDTH_KEY, null);
    },
    setResizing,
    toggle: () => {
      stop();
      setHoverOpen(false);
      setFocusOpen(false);
      setCollapsed(!collapsed);
      write(COLLAPSED_KEY, collapsed ? null : '1');
      // The page is laid out once, where it ends up, and its start comes
      // there from where it was: nothing in it wraps again on the way.
      setShift(collapsed ? RAIL - width : width - RAIL);
      setMoving(true);
      clearTimeout(moved.current);
      moved.current = setTimeout(() => setMoving(false), MOVING_AT_MOST_MS);
    },
  };
}

/**
 * The sidebar's right edge: dragged with a mouse, a pen or a finger, or
 * moved with ← and → (Shift: further), Home or a double-click for today's
 * width (WCAG 2.5.7: dragging is not the only way). A window splitter, as
 * WAI-ARIA has it.
 */
export function ResizeHandle({ side }: { side: Sidebar }) {
  const drag = useRef<{ id: number; x: number; from: number } | null>(null);
  const end = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    side.setResizing(false);
    side.setWidth(side.width, true);
  };
  return (
    <div
      className="side-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the sidebar"
      aria-valuenow={side.width}
      aria-valuemin={SIDE_MIN}
      aria-valuemax={side.widest}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.focus();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        drag.current = { id: e.pointerId, x: e.clientX, from: side.width };
        side.setResizing(true);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d?.id !== e.pointerId) return;
        side.setWidth(d.from + e.clientX - d.x, false);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={side.resetWidth}
      onKeyDown={(e: ReactKeyboardEvent<HTMLDivElement>) => {
        const by = e.shiftKey ? BIG_STEP : STEP;
        if (e.key === 'ArrowLeft') side.setWidth(side.width - by, true);
        else if (e.key === 'ArrowRight') side.setWidth(side.width + by, true);
        else if (e.key === 'Home') side.resetWidth();
        else return;
        e.preventDefault();
      }}
    />
  );
}

/** Fold the sidebar to its icons, or open it again: at its foot, above Settings. */
export function CollapseButton({ side }: { side: Sidebar }) {
  const words = side.rail ? 'Expand' : 'Collapse';
  return (
    <button
      type="button"
      className="side-link side-toggle"
      aria-expanded={!side.rail}
      aria-label={`${words} the sidebar`}
      onClick={side.toggle}
    >
      <svg
        className="icon"
        aria-hidden="true"
        width={20}
        height={20}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
        <path d="M9 4.5v15" />
        <path d={side.rail ? 'm13.5 9.5 2.5 2.5-2.5 2.5' : 'm16 9.5-2.5 2.5 2.5 2.5'} />
      </svg>
      <span className={side.rail && !side.peek ? 'visually-hidden' : 'side-label'}>{words}</span>
    </button>
  );
}
