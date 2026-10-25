import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

/**
 * A column's width, in pixels: as it starts, how narrow or wide it may be
 * dragged, and how far an arrow key moves it (Shift: four times as far).
 */
export interface WidthBounds {
  start: number;
  min: number;
  max: number;
  step: number;
}

/** The width this person left it at, here: their own, kept on this device. */
export function keptWidth(key: string, bounds: WidthBounds): number {
  try {
    const raw = window.localStorage.getItem(key);
    const n = raw === null || raw.trim() === '' ? NaN : Number(raw);
    // Kept: theirs, within the bounds (a width kept before they changed).
    return Number.isFinite(n)
      ? Math.min(bounds.max, Math.max(bounds.min, Math.round(n)))
      : bounds.start;
  } catch {
    // Blocked: as it starts.
    return bounds.start;
  }
}

/** Keeps the width for next time, where the browser allows it. */
export function keepWidth(key: string, width: number): void {
  try {
    window.localStorage.setItem(key, String(Math.round(width)));
  } catch {
    // Blocked, or full: the width is this visit's alone.
  }
}

/**
 * A column's width, as this person left it — read again when the person
 * changes (`key` names them), or where it starts does (a window grown past
 * a layout) — and kept each time a move ends.
 */
export function useKeptWidth(
  key: string,
  bounds: WidthBounds,
): [width: number, set: (w: number) => void, done: (w: number) => void] {
  const [held, setHeld] = useState(() => ({
    key,
    start: bounds.start,
    w: keptWidth(key, bounds),
  }));
  const width = held.key === key && held.start === bounds.start ? held.w : keptWidth(key, bounds);
  return [
    width,
    (w: number) => setHeld({ key, start: bounds.start, w }),
    (w: number) => keepWidth(key, w),
  ];
}

/**
 * Between two columns: dragged, or moved with the arrow keys (`step` a
 * press, Shift four times that), Home and End — a window splitter, as
 * WAI-ARIA has one (WCAG 2.5.7: dragging is not the only way). The Notes
 * list's, and the Settings menu's.
 */
export function Splitter(props: {
  width: number;
  bounds: WidthBounds;
  /** What it sizes: "Width of the list of notes". */
  label: string;
  /** The id of the column it sizes. */
  controls: string;
  className: string;
  onWidth: (w: number) => void;
  onDone: (w: number) => void;
}) {
  const { bounds } = props;
  const drag = useRef<{ x: number; w: number } | null>(null);
  const clamp = (w: number) => Math.min(bounds.max, Math.max(bounds.min, Math.round(w)));
  const set = (w: number) => {
    const next = clamp(w);
    props.onWidth(next);
    props.onDone(next);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? bounds.step * 4 : bounds.step;
    const to =
      e.key === 'ArrowLeft'
        ? props.width - step
        : e.key === 'ArrowRight'
          ? props.width + step
          : e.key === 'Home'
            ? bounds.min
            : e.key === 'End'
              ? bounds.max
              : null;
    if (to === null) return;
    e.preventDefault();
    set(to);
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = { x: e.clientX, w: props.width };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    props.onWidth(clamp(drag.current.w + e.clientX - drag.current.x));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const w = clamp(drag.current.w + e.clientX - drag.current.x);
    drag.current = null;
    set(w);
  };
  return (
    <div
      className={props.className}
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label}
      aria-controls={props.controls}
      aria-valuenow={props.width}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      aria-valuetext={`${props.width} pixels wide`}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  );
}
