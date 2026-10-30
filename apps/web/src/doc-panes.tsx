import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { useApp } from './app-context.js';
import { useShellMode, type ShellMode } from './shell.js';
import { Splitter, useKeptWidth, type WidthBounds } from './splitter.js';

/** The details' narrowest and widest, in pixels (0.9.0, the owner's ask of 29 Oct 2026)… */
export const DETAILS_MIN = 280;
export const DETAILS_MAX = 640;
/** …never so wide that the pages have less than this… */
export const PAGES_MIN = 360;
/** …beside the line between them: its 16 px, and 8 px either side of it. */
const DIVIDER = 32;

/** Where each person's width of a document's details is kept, on this device: view and edit alike. */
export const detailsWidthKey = (memberId: string | null) =>
  `fdv.document.details-width.${memberId ?? 'nobody'}`;

/**
 * The details' width before anybody moves the line: what the layout gave
 * at this width before it could be moved, so nobody's page jumps — from
 * 1024 px 40% of the room, 280 to 400 px (W-R3-4); 768–1023 px 5 parts
 * in 11 of the room less the 20 px between, from 272 px.
 */
export function startingWidth(mode: ShellMode, room: number): number {
  const was =
    mode === 'mid'
      ? Math.max(272, ((room - 20) * 5) / 11)
      : Math.max(280, Math.min(400, room * 0.4));
  return Math.round(was);
}

/** The details' bounds at a room this wide (the pane's content, the line and the pages). */
export function detailsBounds(mode: ShellMode, room: number): WidthBounds {
  const max = Math.max(DETAILS_MIN, Math.min(DETAILS_MAX, Math.floor(room - DIVIDER - PAGES_MIN)));
  const start = Math.min(max, Math.max(DETAILS_MIN, startingWidth(mode, room)));
  return { start, min: DETAILS_MIN, max, step: 16 };
}

/**
 * The room the two panes share, kept up as it changes (the window, the
 * sidebar, the divider beside the sidebar): measured once drawn; before
 * that, or with no ResizeObserver, the window less the sidebar and the
 * page's padding.
 */
function useRoom(mode: ShellMode): [room: number, ref: RefObject<HTMLDivElement | null>] {
  const ref = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<number | null>(null);
  const [, setWindow] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof ResizeObserver === 'function') {
      const watching = new ResizeObserver(() => {
        if (el.clientWidth > 0) setMeasured(el.clientWidth);
      });
      watching.observe(el);
      return () => watching.disconnect();
    }
    const again = () => setWindow((w) => w + 1);
    window.addEventListener('resize', again);
    return () => window.removeEventListener('resize', again);
  }, []);
  if (measured !== null) return [measured, ref];
  const shell = typeof document === 'undefined' ? null : document.querySelector('.shell');
  const side =
    mode === 'mid'
      ? 72
      : Number.parseFloat(shell ? getComputedStyle(shell).getPropertyValue('--side-w') : '') || 216;
  return [window.innerWidth - side - 48, ref];
}

/**
 * A document in two panes, from 768 px (R3; resizable since 0.9.0): its
 * details — or, in Edit, its form — on the left, the line between them
 * dragged or moved with the arrow keys (splitter.tsx, as Notes' and
 * Settings'), and its pages across the rest. The details pane must carry
 * the id `doc-details`, which the line controls.
 */
export function DocPanes(props: { details: ReactNode; pages: ReactNode }) {
  const mode = useShellMode();
  const { session } = useApp();
  const [room, ref] = useRoom(mode);
  const bounds = detailsBounds(mode, room);
  const [kept, setKept, keep] = useKeptWidth(
    detailsWidthKey(session.info?.member_id ?? null),
    bounds,
  );
  // Kept at a wider window: within this one's bounds.
  const width = Math.min(bounds.max, Math.max(bounds.min, kept));
  return (
    <div
      className="doc-split"
      ref={ref}
      style={{ '--doc-details-w': `${width}px` } as CSSProperties}
    >
      {props.details}
      <Splitter
        className="doc-resizer"
        label="Width of the details"
        controls="doc-details"
        width={width}
        bounds={bounds}
        onWidth={setKept}
        onDone={keep}
      />
      {props.pages}
    </div>
  );
}
