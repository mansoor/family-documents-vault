import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react';
import type { ColumnKey } from './documents-table.js';
import type { ShellMode } from './shell.js';

/**
 * The Documents table's column widths (0.9.0, the owner's ask of 30 Oct
 * 2026): each column but the title as wide as what it usually says, on one
 * line, its header too; the title what is left, within a range; and each
 * column's right edge dragged, or moved with the keys, by each person on
 * their own device. A collection's table is the same table, and keeps its
 * widths apart, as it keeps its columns (`COLLECTION_HIDDEN_COLUMNS_KEY`).
 */

/**
 * A column's widths, in px:
 *  - `min`: the narrowest it can be made — its header whole on one line.
 *  - `tight`: the narrowest it is drawn by itself, in a narrow window, its
 *    words cut short with an ellipsis (the whole of them in a tip); a date
 *    is never cut by itself, so its `tight` is its `base`.
 *  - `base`: what it usually says, on one line, at 14 px.
 *  - `max`: the widest it can be made.
 *  - `weight`: its share of the room a wide window has to spare.
 *
 * Measured in Chromium, in Figtree: a header's words at 12 px, bold, 0.06em
 * apart, in capitals, plus `HEAD_CHROME`; a cell's at 14 px, plus its 16 px
 * of padding.
 */
export interface ColumnSize {
  min: number;
  tight: number;
  base: number;
  max: number;
  weight: number;
}

/**
 * Around a header's words: 8 px before them; the sort's mark (10 px, 4 px
 * from them); and 12 px after, clear of the line that resizes it.
 */
export const HEAD_CHROME = 34;

export const COLUMN_SIZES: Record<ColumnKey, ColumnSize> = {
  // Its least, drawn by itself; its narrowest, dragged.
  title: { min: 160, tight: 240, base: 240, max: 960, weight: 0 },
  // "Visa / residence permit" (145 px), "Diploma / transcript" (125 px);
  // drawn by itself no narrower than "Birth certificate" (98 px).
  kind: { min: 72, tight: 116, base: 162, max: 640, weight: 3 },
  // A first name ("Mansoor", 55 px); its header (53 px) is wider.
  person: { min: 88, tight: 88, base: 92, max: 640, weight: 1 },
  // "28 Sept 2026" (90 px in figures of one width), 4 px before it and 12
  // after, under its header's end.
  issued: { min: 84, tight: 106, base: 106, max: 640, weight: 1 },
  expires: { min: 88, tight: 106, base: 106, max: 640, weight: 1 },
  // "Valid for 1 year 1 month" (149 px, bold) after its dot (10 px, 6 px
  // from it); drawn by itself no narrower than "Expired 1 Mar 2025" (122 px).
  status: { min: 84, tight: 156, base: 184, max: 640, weight: 2 },
  // Its header, "Who sees it" (84 px), is wider than "Adults only" (71 px).
  visibility: { min: 118, tight: 118, base: 118, max: 640, weight: 1 },
  // "Safe deposit box" (106 px).
  location: { min: 104, tight: 104, base: 122, max: 640, weight: 2 },
  // One chip ("Refinance", 78 px with its border and padding), 4 px, and a
  // "+2" (34 px); its header (92 px) is nearly as wide.
  collections: { min: 126, tight: 126, base: 132, max: 640, weight: 2 },
};

/**
 * The most of the room the title takes by itself, on a wide window: what
 * is left after that is shared among the other columns, by their weight,
 * so they spread out instead of the title growing without end.
 */
export const TITLE_SHARE = 0.25;

/** How far an arrow key moves a column's edge; Shift, four times as far. */
export const COLUMN_STEP = 16;

/** The widths this person gave columns, by dragging or the keys: theirs, kept. */
export type KeptWidths = Partial<Record<ColumnKey, number>>;

const clampTo = (key: ColumnKey, w: number) => {
  const s = COLUMN_SIZES[key];
  return Math.min(s.max, Math.max(s.min, Math.round(w)));
};

/**
 * Each column's width, for these columns in `room` px (the table's box less
 * its pick box, its ⋯ and any column of its own):
 *  - one this person sized is as they left it;
 *  - with room to spare, the title grows from 240 px to a quarter of the
 *    room, and the rest of it is shared by weight among the others;
 *  - a little short of room, the others give up what it takes, in
 *    proportion, down to their `tight`, their words cut short;
 *  - shorter than that (1280 px, 1024 px), every column is as it starts,
 *    nothing cut, and the table is wider than its box, which scrolls
 *    sideways (the box and the title staying put, as before).
 * Widths are whole pixels, and fill the room exactly while they can.
 */
export function columnWidths(
  keys: readonly ColumnKey[],
  room: number,
  kept: KeptWidths = {},
): Record<string, number> {
  const out: Record<string, number> = {};
  let used = 0;
  const auto: ColumnKey[] = [];
  for (const k of keys) {
    const mine = kept[k];
    if (mine === undefined) {
      auto.push(k);
      continue;
    }
    out[k] = clampTo(k, mine);
    used += out[k];
  }
  const others = auto.filter((k) => k !== 'title');
  const titleAuto = auto.includes('title');
  const floor = COLUMN_SIZES.title.base;
  const bases = others.reduce((s, k) => s + COLUMN_SIZES[k].base, 0);
  let spare = Math.floor(room) - used - bases - (titleAuto ? floor : 0);
  if (spare >= 0) {
    if (titleAuto) {
      // Nothing else to share it with: the title takes all of it.
      const cap = others.length === 0 ? Infinity : Math.max(floor, Math.floor(room * TITLE_SHARE));
      const title = Math.min(floor + spare, cap);
      out.title = title;
      spare -= title - floor;
    }
    const weights = others.reduce((s, k) => s + COLUMN_SIZES[k].weight, 0);
    let given = 0;
    for (const k of others) {
      const extra = weights > 0 ? Math.floor((spare * COLUMN_SIZES[k].weight) / weights) : 0;
      out[k] = COLUMN_SIZES[k].base + extra;
      given += extra;
    }
    // What rounding left over: a pixel each, the heaviest first.
    const order = [...others].sort((a, b) => COLUMN_SIZES[b].weight - COLUMN_SIZES[a].weight);
    for (let i = 0; given < spare && order.length > 0; i++, given++) {
      const k = order[i % order.length] as ColumnKey;
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  }
  if (titleAuto) out.title = floor;
  const short = -spare;
  const slack = others.reduce((s, k) => s + COLUMN_SIZES[k].base - COLUMN_SIZES[k].tight, 0);
  // Cut short only where that makes the table fit: a table that scrolls
  // sideways anyway keeps every column's words whole.
  const take = short <= slack ? short : 0;
  let taken = 0;
  for (const k of others) {
    const s = COLUMN_SIZES[k];
    const off = slack > 0 ? Math.floor(((s.base - s.tight) * take) / slack) : 0;
    out[k] = s.base - off;
    taken += off;
  }
  // What rounding left: a pixel each from those with any left to give.
  for (let i = 0; taken < take; i++) {
    const k = others[i % others.length] as ColumnKey;
    if ((out[k] ?? 0) > COLUMN_SIZES[k].tight) {
      out[k] = (out[k] ?? 0) - 1;
      taken++;
    }
  }
  return out;
}

/** Where each person's widths are kept, on this device: Documents' and a collection's apart. */
export const columnWidthsKey = (where: 'documents' | 'collection', memberId: string | null) =>
  `fdv.${where}.columns.${memberId ?? 'nobody'}`;

/** The widths kept here: each a column's, within its bounds; nothing that is not. */
export function readKeptWidths(key: string): KeptWidths {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: KeptWidths = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!(k in COLUMN_SIZES) || typeof v !== 'number' || !Number.isFinite(v)) continue;
      out[k as ColumnKey] = clampTo(k as ColumnKey, v);
    }
    return out;
  } catch {
    // Blocked, or something else's words there: as they start.
    return {};
  }
}

/** Kept for next time, where the browser allows it; none kept, nothing there. */
export function writeKeptWidths(key: string, kept: KeptWidths): void {
  try {
    if (Object.keys(kept).length === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(kept));
  } catch {
    // Blocked, or full: the widths are this visit's alone.
  }
}

/** A column's width to fit the widest of what it shows (`widths`, padding and all), within its bounds. */
export function fitWidth(key: ColumnKey, widths: readonly number[]): number {
  const widest = widths.reduce((m, w) => (Number.isFinite(w) ? Math.max(m, w) : m), 0);
  return clampTo(key, Math.ceil(widest));
}

/** How wide a cell's words are, all on one line, with the cell's own padding. */
function naturalWidth(cell: HTMLTableCellElement): number | null {
  const inner = cell.querySelector<HTMLElement>('.th-sort, .clip');
  if (!inner) return null;
  const cs = getComputedStyle(cell);
  const pad = (Number.parseFloat(cs.paddingLeft) || 0) + (Number.parseFloat(cs.paddingRight) || 0);
  const was = inner.getAttribute('style');
  inner.style.width = 'max-content';
  inner.style.maxWidth = 'none';
  const w = inner.getBoundingClientRect().width;
  if (was === null) inner.removeAttribute('style');
  else inner.setAttribute('style', was);
  return w + pad;
}

/**
 * A header's line in focus, wholly in sight (as `reveal` keeps a cell,
 * table-grid.tsx): it stands astride its column's edge, half over the next
 * header, so its header in sight may leave it under the ⋯ pinned at the
 * right — or, scrolled the other way, under the box and the title.
 */
export function revealLine(box: HTMLElement | null, line: HTMLElement) {
  if (!box || line.closest('th.col-title')) return;
  const b = box.getBoundingClientRect();
  const l = line.getBoundingClientRect();
  let left = b.left;
  for (const p of box.querySelectorAll('thead .col-pick, thead .col-title')) {
    left = Math.max(left, p.getBoundingClientRect().right);
  }
  const more = box.querySelector('thead .col-more')?.getBoundingClientRect();
  const right = Math.min(b.left + box.clientWidth, more ? more.left : Infinity);
  if (l.right > right) box.scrollLeft += l.right - right;
  else if (l.left < left) box.scrollLeft -= left - l.left;
}

/** The widest of a column as shown — its header and every row's cell — whole, on one line. */
export function measureColumn(head: HTMLTableCellElement): number[] {
  const table = head.closest('table');
  if (!table) return [];
  const at = head.cellIndex;
  const cells = [
    head,
    ...[...table.querySelectorAll<HTMLTableRowElement>('tbody tr:not(.empty-row)')].map(
      (r) => r.cells[at],
    ),
  ];
  return cells.flatMap((c) => {
    const w = c ? naturalWidth(c) : null;
    return w === null ? [] : [w];
  });
}

/**
 * The room the table's columns share: its box's width inside, kept up as
 * it changes (the window, the sidebar, a scroll bar coming or going) —
 * measured once drawn; before that, or with no ResizeObserver, the window
 * less the sidebar, the page's padding and the box's border.
 */
export function useTableRoom(wrap: RefObject<HTMLDivElement | null>, mode: ShellMode): number {
  const [measured, setMeasured] = useState<number | null>(null);
  const [, setWindow] = useState(0);
  useEffect(() => {
    const el = wrap.current;
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
  }, [wrap]);
  if (measured !== null) return measured;
  const shell = typeof document === 'undefined' ? null : document.querySelector('.shell');
  const side =
    mode === 'mid'
      ? 72
      : Number.parseFloat(shell ? getComputedStyle(shell).getPropertyValue('--side-w') : '') || 216;
  return Math.max(0, window.innerWidth - side - 50);
}

/**
 * The right edge of a column's header: dragged, or — in focus — moved with
 * the arrow keys (16 px a press, Shift 64), Home and End, as the app's
 * other lines are (splitter.tsx); a double click, or Enter, fits the
 * column to the widest of what it shows. It never sorts: it is beside the
 * header's button, not in it, and a drag that ends on the header is the
 * line's. While dragged, the table is drawn by `onDrag` alone, not by
 * React — a hundred rows are not drawn again for each pixel — and the
 * width is the person's, kept, once it is let go (`onDone`).
 */
export function ColumnHandle(props: {
  /** The column's name: "Width of Title". */
  label: string;
  width: number;
  min: number;
  max: number;
  last: boolean;
  onDrag: (w: number) => void;
  onDone: (w: number) => void;
  onFit: () => void;
}) {
  const { min, max } = props;
  const drag = useRef<{ x: number; w: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const clamp = (w: number) => Math.min(max, Math.max(min, Math.round(w)));
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    const step = e.shiftKey ? COLUMN_STEP * 4 : COLUMN_STEP;
    let to: number | null = null;
    if (e.key === 'ArrowLeft') to = props.width - step;
    else if (e.key === 'ArrowRight') to = props.width + step;
    else if (e.key === 'Home') to = min;
    else if (e.key === 'End') to = max;
    else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      props.onFit();
      return;
    }
    // ↑ and ↓ are the grid's: to the cell below, or above.
    if (to === null) return;
    e.preventDefault();
    // Never the grid's arrows, Home or End too.
    e.stopPropagation();
    props.onDone(clamp(to));
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // No words chosen as it moves.
    e.preventDefault();
    e.currentTarget.focus({ preventScroll: true });
    drag.current = { x: e.clientX, w: props.width, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.x) < 2) return;
    if (!d.moved) setDragging(true);
    d.moved = true;
    props.onDrag(clamp(d.w + e.clientX - d.x));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    // A press that never moved changes nothing: two of them are a double click.
    if (!d?.moved) return;
    props.onDone(clamp(d.w + e.clientX - d.x));
  };
  return (
    <div
      className={`col-resize${props.last ? ' col-resize-last' : ''}${dragging ? ' dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label}
      aria-valuenow={props.width}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={`${props.width} pixels wide`}
      // A stop for Tab only beside its header's own, while that is the
      // grid's (Documents.tsx): the grid stays one stop.
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        const d = drag.current;
        drag.current = null;
        setDragging(false);
        // Drawn back as it was.
        if (d?.moved) props.onDrag(d.w);
      }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        props.onFit();
      }}
    />
  );
}
