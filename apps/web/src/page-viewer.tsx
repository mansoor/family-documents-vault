import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { useShortcutsOn } from './shortcuts.js';

/**
 * The zoom's steps, as browsers have them (0.9.0). 100% is a page as the
 * vault drew it, one of its pixels to one CSS pixel: the worker draws each
 * page at most 1600 px on its long edge (PREVIEW_EDGE, apps/worker's
 * tools.ts), so an A4 page is about 1131 × 1600 px at 100%, and a small
 * photo its own size.
 */
export const ZOOM_STEPS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4,
] as const;
export const ZOOM_MIN = 0.25;
/**
 * As far as a page zooms: twice the size it was drawn at. There is no
 * larger drawing to ask for (the vault keeps one, at 1600 px), and past
 * twice its size a page only blurs; the file itself is the original.
 */
export const ZOOM_MAX = 2;
/** Within this, two zooms are the same one (a fit of 1.0004 is 100%). */
const NEAR = 0.005;
const REACHABLE = ZOOM_STEPS.filter((s) => s <= ZOOM_MAX);

/** The next step up (1) or down (-1) from a zoom; at either end, the zoom itself. */
export function zoomStep(now: number, dir: 1 | -1): number {
  const to =
    dir > 0
      ? REACHABLE.find((s) => s > now + NEAR)
      : [...REACHABLE].reverse().find((s) => s < now - NEAR);
  return to ?? now;
}

const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

/** Fitted to the pane's width, the whole page in the pane, or a zoom of its own. */
type Zoom = 'width' | 'page' | number;

/** A pixel count from a computed style ('' in jsdom). */
const px = (v: string) => parseFloat(v) || 0;

/**
 * Pages, one at a time (I3; shared since R3): Previous and Next, "Page 2
 * of 3", fitted to the pane's width or zoomed (0.9.0). Page Up and Page
 * Down turn them while the page has the focus — and [ and ], while single
 * keys are on (WCAG 2.1.4). It zooms with its buttons, Ctrl (⌘) and the
 * scroll wheel or a pinch over the page, and + − 0 with the page in focus
 * and single keys on; the point under the pointer stays where it is. The
 * zoom holds as the pages turn; shown afresh (another document), it starts
 * fitted to the width. Nothing here fetches: whoever shows it says which
 * page is shown (`n`) and what it is (`url`), and turns it (`onTurn`). A
 * file's in the review queue (BatchItem.tsx's ItemPages) and a document's
 * (Document.tsx's DocumentPages) both use it.
 */
export function PageViewer(props: {
  /** The region's name: "Pages of passport.pdf". */
  label: string;
  className?: string;
  /** How many pages can be turned to; 0 for none, when `none` is said instead. */
  total: number;
  /** How many the file has, when more than can be turned to (said, never turned to). */
  of?: number;
  /** The page shown, from 1. */
  n: number;
  onTurn: (n: number) => void;
  /** The page's picture, once there is one. */
  url: string | null;
  /** Said in its place until then: "Loading the page…". */
  note: ReactNode;
  /** Beside `note`: what can be done about it ("Try again"). */
  noteAction?: ReactNode;
  /** Said when there are no pages to turn. */
  none: ReactNode;
  /** More in the bar, after the zoom ("Read it full size"). */
  tools?: ReactNode;
  /** Under the hint ("Pages 31–50 aren't shown here"). */
  after?: ReactNode;
  /** Offer Fit page: where the pane's height is the window's, not the page's. */
  fitPage?: boolean;
  /** After "200% is as far as its pages zoom": where the original is. */
  beyond?: ReactNode;
}) {
  const { total, n, onTurn, url } = props;
  const of = props.of ?? total;
  const shortcuts = useShortcutsOn();
  const [zoom, setZoom] = useState<Zoom>('width');
  // The page's own size, as drawn (the last one shown: the next is most
  // likely the same), and the room inside the viewer.
  const [drawn, setDrawn] = useState<{ w: number; h: number } | null>(null);
  const [room, setRoom] = useState<{ w: number; h: number } | null>(null);

  // A control inside the page ("Try again", "Confirm it's you") goes away
  // once pressed: the focus it had stays here, on the page, rather than
  // falling to the top of the document (WCAG 2.4.3, the review's W-R3-1).
  const box = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLImageElement>(null);
  const focusInside = useRef(false);
  useLayoutEffect(() => {
    const now = document.activeElement;
    if (focusInside.current && box.current && (now === null || now === document.body)) {
      box.current.focus({ preventScroll: true });
    }
  });
  const onFocus = () => {
    focusInside.current = true;
  };
  const onBlur = (e: ReactFocusEvent<HTMLDivElement>) => {
    const to = e.relatedTarget;
    if (to instanceof Node && e.currentTarget.contains(to)) return;
    const from = e.target;
    // Focus gone somewhere: it left. Gone nowhere: it left, unless what had
    // it was taken off the page, when the effect above puts it back here.
    if (to) focusInside.current = false;
    else
      queueMicrotask(() => {
        if (from.isConnected) focusInside.current = false;
      });
  };

  /** The room inside the viewer, less its padding: what a fit fits. */
  const measure = () => {
    const el = box.current;
    if (!el) return;
    const style = getComputedStyle(el);
    const w = el.clientWidth - px(style.paddingLeft) - px(style.paddingRight);
    const h = el.clientHeight - px(style.paddingTop) - px(style.paddingBottom);
    setRoom((was) => (was && was.w === w && was.h === h ? was : { w, h }));
  };
  const measured = useRef(measure);
  const hasPages = total > 0;
  useEffect(() => {
    measured.current = measure;
  });
  useEffect(() => {
    const el = box.current;
    if (!hasPages || !el) return;
    const again = () => measured.current();
    // Measured as it is drawn and each time the pane changes (the divider,
    // the window); without a ResizeObserver, as the window changes.
    if (typeof ResizeObserver === 'function') {
      const watching = new ResizeObserver(again);
      watching.observe(el);
      return () => watching.disconnect();
    }
    window.addEventListener('resize', again);
    return () => window.removeEventListener('resize', again);
  }, [hasPages]);

  const fitWidth = drawn && room && room.w > 0 ? room.w / drawn.w : null;
  const fitWhole =
    drawn && room && room.w > 0 && room.h > 0 ? Math.min(room.w / drawn.w, room.h / drawn.h) : null;
  /** The zoom now, as a number: null while there is nothing yet to measure. */
  const scale = zoom === 'width' ? fitWidth : zoom === 'page' ? fitWhole : zoom;
  // Stepped from where it is; from 100% while that is not known yet.
  const from = scale ?? 1;
  const shown = url !== null;
  const canIn = shown && from < ZOOM_MAX - NEAR;
  const canOut = shown && from > ZOOM_MIN + NEAR;
  // Zoomed as far as it goes (not a fit that happens to be that large).
  const atCap = shown && typeof zoom === 'number' && zoom >= ZOOM_MAX - NEAR;

  // Where a zoom was made: the point of the page under the pointer (the
  // middle, for the buttons and the keys), to keep in place once drawn.
  const anchor = useRef<{ fx: number; fy: number; cx: number; cy: number } | null>(null);
  const zoomTo = (next: Zoom, at?: { x: number; y: number }) => {
    const el = box.current;
    const pic = picture.current;
    if (el && pic) {
      const b = el.getBoundingClientRect();
      const p = pic.getBoundingClientRect();
      const cx = at ? at.x - b.left - el.clientLeft : el.clientWidth / 2;
      const cy = at ? at.y - b.top - el.clientTop : el.clientHeight / 2;
      const left = p.left - b.left - el.clientLeft;
      const top = p.top - b.top - el.clientTop;
      anchor.current = {
        fx: p.width > 0 ? (cx - left) / p.width : 0.5,
        fy: p.height > 0 ? (cy - top) / p.height : 0.5,
        cx,
        cy,
      };
    }
    setZoom(next);
  };
  // Drawn at the new zoom: the point it was made at put back under it.
  useLayoutEffect(() => {
    const a = anchor.current;
    anchor.current = null;
    const el = box.current;
    const pic = picture.current;
    if (!a || !el || !pic) return;
    const b = el.getBoundingClientRect();
    const p = pic.getBoundingClientRect();
    el.scrollLeft += p.left - b.left - el.clientLeft + p.width * a.fx - a.cx;
    el.scrollTop += p.top - b.top - el.clientTop + p.height * a.fy - a.cy;
  }, [zoom]);
  // Another page, at the same zoom: from its top left.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.scrollTop = 0;
    el.scrollLeft = 0;
  }, [n]);

  const stepBy = (dir: 1 | -1) => {
    const to = zoomStep(from, dir);
    if (Math.abs(to - from) > NEAR) zoomTo(to);
  };
  /** By a factor, about a point (the wheel, a pinch): within the bounds, not stepped. */
  const zoomBy = (factor: number, at: { x: number; y: number }) => {
    const to = clampZoom(from * factor);
    if (Math.abs(to - from) > NEAR / 10) zoomTo(to, at);
  };

  // Ctrl (or ⌘) and the scroll wheel — and a trackpad's pinch, which comes
  // as one — over the page zoom it, and never the browser's page; anywhere
  // else they are the browser's. Safari's pinch comes as its gesture events.
  // Listened to here, not through React: its wheel listeners cannot stop it.
  const wheel = useRef<(e: WheelEvent) => void>(() => undefined);
  const gesture = useRef<(e: Event) => void>(() => undefined);
  const lastGesture = useRef(1);
  useEffect(() => {
    wheel.current = (e) => {
      if (!(e.ctrlKey || e.metaKey) || !shown) return;
      e.preventDefault();
      // A line (Firefox) is about 33 px; a notch of a mouse wheel about a step.
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      zoomBy(Math.exp(-Math.max(-100, Math.min(100, dy)) * 0.0025), {
        x: e.clientX,
        y: e.clientY,
      });
    };
    gesture.current = (e) => {
      if (!shown) return;
      e.preventDefault();
      const g = e as Event & { scale?: number; clientX?: number; clientY?: number };
      if (e.type === 'gesturestart') {
        lastGesture.current = 1;
        return;
      }
      const s = g.scale ?? 1;
      zoomBy(s / lastGesture.current, { x: g.clientX ?? 0, y: g.clientY ?? 0 });
      lastGesture.current = s;
    };
  });
  useEffect(() => {
    const el = box.current;
    if (!hasPages || !el) return;
    const onWheel = (e: WheelEvent) => wheel.current(e);
    const onGesture = (e: Event) => gesture.current(e);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('gesturestart', onGesture);
    el.addEventListener('gesturechange', onGesture);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', onGesture);
      el.removeEventListener('gesturechange', onGesture);
    };
  }, [hasPages]);

  // Two fingers on a touch screen: their pinch, about the point between them.
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const spread = useRef<number | null>(null);
  const between = () => {
    const [a, b] = [...touches.current.values()];
    if (!a || !b) return null;
    return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'touch') return;
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    spread.current = touches.current.size === 2 ? (between()?.d ?? null) : null;
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!touches.current.has(e.pointerId)) return;
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const now = between();
    if (!now || touches.current.size !== 2 || !spread.current || !shown) return;
    zoomBy(now.d / spread.current, now);
    spread.current = now.d;
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    touches.current.delete(e.pointerId);
    spread.current = null;
  };

  const turn = (by: number) => {
    const to = Math.min(Math.max(n + by, 1), total);
    if (to === n) return false;
    onTurn(to);
    return true;
  };
  const keys = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    // + − 0: single keys, so only while they are on (WCAG 2.1.4), and only
    // here — with the page in focus — so never `/` or `n`'s, nor a field's.
    if (shortcuts && (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '0')) {
      e.preventDefault();
      if (!shown) return;
      if (e.key === '0') zoomTo('width');
      else stepBy(e.key === '-' ? -1 : 1);
      return;
    }
    const next = e.key === 'PageDown' || (shortcuts && e.key === ']');
    const back = e.key === 'PageUp' || (shortcuts && e.key === '[');
    if (!next && !back) return;
    e.preventDefault();
    turn(next ? 1 : -1);
  };

  const pct = scale === null ? null : Math.round(scale * 100);
  const said =
    zoom === 'width' ? 'Fit to width' : zoom === 'page' ? 'Fit page' : `Zoom ${pct ?? ''}%`;
  // The page's width at this zoom; fitted to the width, the stylesheet's.
  const width =
    !drawn || zoom === 'width'
      ? undefined
      : zoom === 'page'
        ? fitWhole === null
          ? undefined
          : Math.floor(drawn.w * fitWhole)
        : Math.round(drawn.w * zoom);

  return (
    <section className={props.className} aria-label={props.label}>
      {total > 0 ? (
        <>
          <div className="row viewer-bar">
            <button
              type="button"
              className="btn btn-quiet btn-small"
              disabled={n <= 1}
              onClick={() => turn(-1)}
            >
              <span aria-hidden="true">‹ </span>Previous page
            </button>
            <span className="viewer-at" aria-live="polite">
              Page {n} of {of}
            </span>
            <button
              type="button"
              className="btn btn-quiet btn-small"
              disabled={n >= total}
              onClick={() => turn(1)}
            >
              Next page<span aria-hidden="true"> ›</span>
            </button>
            <button
              type="button"
              className="btn btn-quiet btn-small"
              aria-pressed={zoom === 'width'}
              // Pressed again: the page's own size, as it always was.
              onClick={() => zoomTo(zoom === 'width' ? 1 : 'width')}
            >
              Fit to width
            </button>
            {props.fitPage && (
              <button
                type="button"
                className="btn btn-quiet btn-small"
                aria-pressed={zoom === 'page'}
                onClick={() => zoomTo(zoom === 'page' ? 'width' : 'page')}
              >
                Fit page
              </button>
            )}
            <span className="viewer-zoom" role="group" aria-label="Zoom">
              <button
                type="button"
                className="btn btn-quiet btn-small viewer-zoom-btn"
                aria-label="Zoom out"
                title="Zoom out"
                aria-keyshortcuts={shortcuts ? '-' : undefined}
                disabled={!canOut}
                onClick={() => stepBy(-1)}
              >
                <span aria-hidden="true">−</span>
              </button>
              <button
                type="button"
                className="btn btn-quiet btn-small viewer-zoom-at"
                aria-label={pct === null ? 'Back to Fit to width' : `${pct}%, back to Fit to width`}
                title="Back to Fit to width"
                aria-keyshortcuts={shortcuts ? '0' : undefined}
                onClick={() => zoomTo('width')}
              >
                {pct === null ? '…' : `${pct}%`}
              </button>
              <button
                type="button"
                className="btn btn-quiet btn-small viewer-zoom-btn"
                aria-label="Zoom in"
                title="Zoom in"
                aria-keyshortcuts={shortcuts ? '+' : undefined}
                disabled={!canIn}
                onClick={() => stepBy(1)}
              >
                <span aria-hidden="true">+</span>
              </button>
            </span>
            <span className="visually-hidden" aria-live="polite">
              {said}
            </span>
            {props.tools}
          </div>
          <div
            className={`viewer${zoom === 'width' ? ' viewer-fit' : ''}`}
            tabIndex={0}
            role="group"
            aria-label={`Page ${n} of ${of}. Page Up and Page Down turn the pages.`}
            aria-keyshortcuts={shortcuts ? 'PageUp PageDown [ ] + - 0' : 'PageUp PageDown'}
            onKeyDown={keys}
            ref={box}
            onFocus={onFocus}
            onBlur={onBlur}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {url ? (
              <img
                ref={picture}
                src={url}
                alt={`Page ${n} of ${of}`}
                style={width === undefined ? undefined : { width }}
                onLoad={(e) => {
                  const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
                  if (w > 0 && h > 0)
                    setDrawn((was) => (was?.w === w && was.h === h ? was : { w, h }));
                  measure();
                }}
              />
            ) : props.noteAction ? (
              <div className="viewer-note">
                <p className="muted">{props.note}</p>
                {props.noteAction}
              </div>
            ) : (
              <p className="muted">{props.note}</p>
            )}
          </div>
          <p className="muted viewer-hint">
            {shortcuts
              ? 'With the page in focus, Page Up and Page Down, or [ and ], turn the pages; + and − zoom, and 0 fits it to the width.'
              : 'With the page in focus, Page Up and Page Down turn the pages.'}
          </p>
          {atCap && (
            <p className="muted viewer-hint">
              {Math.round(ZOOM_MAX * 100)}% is as far as its pages zoom: drawn larger, they would
              only blur.{props.beyond ? <> {props.beyond}</> : null}
            </p>
          )}
          {props.after}
        </>
      ) : (
        <div className="viewer viewer-none">
          <p className="muted">{props.none}</p>
        </div>
      )}
    </section>
  );
}
