import {
  useLayoutEffect,
  useRef,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';

/**
 * What the app's tables share (Phase 6): R2's grid — one stop for Tab, the
 * arrows between cells, the cell in focus kept clear of what stays in place
 * — its header box, a blank cell, a filter, and what an action on many came
 * to. The Documents table (R2) and the Trash (R4) use them.
 */

/** Each row of the grid: the head's and the body's, never the line saying there are none. */
export const gridRows = (table: HTMLTableElement) => [
  ...table.querySelectorAll<HTMLTableRowElement>('thead tr, tbody tr:not(.empty-row)'),
];

/** What takes the focus in a cell: its box, its link or its sort; or the cell itself. */
const targetOf = (cell: HTMLElement): HTMLElement =>
  cell.querySelector<HTMLElement>('input, a, button') ?? cell;

/** A box or a button that cannot be used now, so cannot take the focus. */
const disabled = (el: HTMLElement): boolean =>
  (el instanceof HTMLInputElement || el instanceof HTMLButtonElement) && el.disabled;

/**
 * The table as one stop for Tab (the review's W1): a grid, the arrows moving
 * between its cells, Home and End along a row (with Control, to the first
 * and last cell), Page Up and Page Down ten rows at a time. Exactly one cell
 * — the one last in focus — can be reached with Tab, so Tab out of the
 * table goes straight on to Show more and to what to do with the chosen.
 * Each cell's own box, link or sort keeps its keys (Space, Enter). The
 * cell in focus is scrolled clear of the head and the pinned columns (W3).
 */
export function useGrid(
  table: RefObject<HTMLTableElement | null>,
  wrap: RefObject<HTMLDivElement | null>,
  deps: string[],
) {
  const at = useRef({ row: 1, col: 0 });
  const version = deps.join('|');
  useLayoutEffect(() => {
    const t = table.current;
    if (!t) return;
    const rows = gridRows(t);
    if (rows.length === 0) return;
    for (const row of rows) {
      for (const cell of row.cells) {
        const target = targetOf(cell);
        if (target !== cell) cell.removeAttribute('tabindex');
        target.tabIndex = -1;
      }
    }
    // Where the focus last was — the first row's box until then — or as
    // near as there is now: rows come and go with a sort or a filter.
    const cells = [...(rows[Math.min(at.current.row, rows.length - 1)]?.cells ?? [])];
    let active = cells[Math.max(0, Math.min(at.current.col, cells.length - 1))];
    // Never a control that cannot take the focus — the header's box, with
    // no rows to choose — or the grid has no stop at all: the head's first
    // that can (F4).
    if (active && disabled(targetOf(active))) {
      active = [...(rows[0]?.cells ?? [])].find((c) => !disabled(targetOf(c)));
    }
    if (active) targetOf(active).tabIndex = 0;
  }, [table, version]);

  /** Where a cell is in the grid, by row and by column. */
  const placeOf = (cell: HTMLTableCellElement) => {
    const t = table.current;
    const row = t ? gridRows(t).indexOf(cell.parentElement as HTMLTableRowElement) : -1;
    return { row, col: cell.cellIndex };
  };

  const onFocus = (e: ReactFocusEvent) => {
    const t = table.current;
    const cell = (e.target as HTMLElement).closest<HTMLTableCellElement>('th, td');
    if (!t || !cell || !t.contains(cell)) return;
    const place = placeOf(cell);
    if (place.row < 0) return;
    // The one stop is this cell now; whichever had it is not, wherever it
    // is — where it was may be gone, with a row or a column (F3).
    const target = targetOf(cell);
    for (const el of t.querySelectorAll<HTMLElement>('[tabindex="0"]')) {
      if (el !== target) el.tabIndex = -1;
    }
    target.tabIndex = 0;
    at.current = place;
    reveal(wrap.current, cell);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const t = table.current;
    if (!t || e.altKey || e.metaKey) return;
    const cell = (e.target as HTMLElement).closest<HTMLTableCellElement>('th, td');
    if (!cell) return;
    const { row, col } = placeOf(cell);
    if (row < 0) return;
    const rows = gridRows(t);
    const last = rows.length - 1;
    const width = (r: number) => rows[r]?.cells.length ?? 0;
    let to: { row: number; col: number };
    switch (e.key) {
      case 'ArrowRight':
        to = { row, col: Math.min(col + 1, width(row) - 1) };
        break;
      case 'ArrowLeft':
        to = { row, col: Math.max(col - 1, 0) };
        break;
      case 'ArrowDown':
        to = { row: Math.min(row + 1, last), col };
        break;
      case 'ArrowUp':
        to = { row: Math.max(row - 1, 0), col };
        break;
      case 'PageDown':
        to = { row: Math.min(row + 10, last), col };
        break;
      case 'PageUp':
        to = { row: Math.max(row - 10, 0), col };
        break;
      case 'Home':
        to = e.ctrlKey ? { row: 0, col: 0 } : { row, col: 0 };
        break;
      case 'End':
        to = e.ctrlKey ? { row: last, col: width(last) - 1 } : { row, col: width(row) - 1 };
        break;
      default:
        return;
    }
    e.preventDefault();
    const next = rows[to.row]?.cells[Math.min(to.col, width(to.row) - 1)];
    // The browser does not scroll it: it would put a row out of sight in the
    // middle of the box, a jump each time, and a pinned cell or the head
    // "into view" back at the left. `reveal`, as it takes the focus, scrolls
    // just enough (F2).
    if (next) targetOf(next).focus({ preventScroll: true });
  };

  /** The cell last in focus, focused again: whether it took it. */
  const focusActive = (): boolean => {
    const cell = table.current?.querySelector<HTMLElement>('[tabindex="0"]');
    cell?.focus();
    return Boolean(cell) && document.activeElement === cell;
  };

  return { onFocus, onKeyDown, focusActive };
}

/**
 * The cell in focus, clear of what stays in place over the box (W3): the
 * head above it, and — for a cell that scrolls sideways — the box and the
 * title pinned at the left. A browser leaves a cell partly in its box where
 * it is, which can be wholly under them.
 */
export function reveal(box: HTMLDivElement | null, cell: HTMLTableCellElement) {
  if (!box) return;
  const b = box.getBoundingClientRect();
  const c = cell.getBoundingClientRect();
  const head = box.querySelector('thead')?.getBoundingClientRect();
  if (!cell.matches('.col-pick, .col-title')) {
    let pinned = b.left;
    for (const p of box.querySelectorAll('thead .col-pick, thead .col-title')) {
      pinned = Math.max(pinned, p.getBoundingClientRect().right);
    }
    const right = b.left + box.clientWidth;
    if (c.left < pinned) box.scrollLeft -= pinned - c.left;
    else if (c.right > right) box.scrollLeft += Math.min(c.right - right, c.left - pinned);
  }
  if (!cell.closest('thead')) {
    const top = head ? head.bottom : b.top;
    const bottom = b.top + box.clientHeight;
    if (c.top < top) box.scrollTop -= top - c.top;
    else if (c.bottom > bottom) box.scrollTop += c.bottom - bottom;
  }
  // And the window, when it is too short for the whole box.
  const now = cell.getBoundingClientRect();
  if (now.top < 0 || now.bottom > window.innerHeight) cell.scrollIntoView({ block: 'nearest' });
}

/** The header's box: every row shown, chosen or not; part of them, mixed. */
export function PickAll({
  ref,
  ...props
}: {
  ref: RefObject<HTMLInputElement | null>;
  count: number;
  checked: boolean;
  mixed: boolean;
  onChange: (on: boolean) => void;
}) {
  useLayoutEffect(() => {
    if (ref.current) ref.current.indeterminate = props.mixed;
  });
  return (
    <label className="pick-cell">
      <input
        ref={ref}
        type="checkbox"
        checked={props.checked}
        disabled={props.count === 0}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span className="visually-hidden">Select all {props.count} shown</span>
    </label>
  );
}

/** A blank, seen as a dash and heard as nothing there. */
export function None() {
  return (
    <>
      <span className="muted" aria-hidden="true">
        —
      </span>
      <span className="visually-hidden">None</span>
    </>
  );
}

/** A filter: a select that says what it is set to, its name for a screen reader. */
export function FilterSelect(props: {
  id: string;
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
}) {
  // A value no longer offered (a collection gone) is still shown as chosen.
  const options = props.options.some((o) => o.value === props.value)
    ? props.options
    : [...props.options, { value: props.value, label: props.value }];
  return (
    <span className="filter">
      <label className="visually-hidden" htmlFor={props.id}>
        {props.label}
      </label>
      <select
        id={props.id}
        className={props.value ? 'on' : undefined}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}

/** What an action on many came to: said in a line, and each one it could not, by name. */
export interface Outcome {
  said: string | null;
  failedHead: string | null;
  failed: Array<{ id: string; title: string; why: string }>;
  /** Never reached, the run having stopped short (W9): still chosen. */
  untouched: string[];
}

export function OutcomeNote({
  ref,
  outcome,
  onDismiss,
}: {
  ref: RefObject<HTMLDivElement | null>;
  outcome: Outcome;
  onDismiss: () => void;
}) {
  return (
    <div ref={ref} className="bulk-outcome" tabIndex={-1}>
      {outcome.said && (
        <p className="notice" role="status">
          {outcome.said}
        </p>
      )}
      {outcome.failed.length > 0 && (
        <div className="error bulk-failed" role="alert">
          <p>{outcome.failedHead}</p>
          <ul>
            {outcome.failed.map((f) => (
              <li key={f.id}>
                “{f.title}”: {f.why}
              </li>
            ))}
          </ul>
          <p className="muted">They are still chosen, to try again.</p>
        </div>
      )}
      <button type="button" className="btn btn-quiet btn-small" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
