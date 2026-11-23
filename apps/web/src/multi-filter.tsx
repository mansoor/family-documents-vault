import { FILTER_VALUES_MAX } from '@fdv/shared';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { Check } from './ui.js';

/**
 * Filters that take more than one choice (0.9.0-dev.92): on Documents and
 * on Activity, two people, or Passport and Driving licence, or several
 * kinds of activity. Within one filter the choices widen what is shown
 * (any of them); across filters they narrow it (all of them apply).
 *
 * A filter is a button that says what it holds — "All people", "Sam", or
 * "Person · 2" — and opens a list of boxes to tick, never a native multiple
 * select. It is a disclosure, as Columns is: the button says whether it is
 * open, Escape or a click outside shuts it and the focus goes back to the
 * button, and it shuts when the focus leaves it. In a sheet (the phone's
 * Filters), the boxes are there to tick at once, under the filter's name.
 * A long list (a household's tags) has a box to find one in, and scrolls.
 * No more can be ticked than the vault takes at once, nor more than an
 * address can carry.
 *
 * What is chosen is said again below as chips, each taken off by its ×,
 * with Clear all (`ChipRow`).
 *
 * The focus follows what is drawn, not a timer: the router changes the
 * address in a transition, so the page may draw it later. Where a box or
 * a chip the focus was on goes, the next one takes it once the page is
 * drawn without it (`useLayoutEffect` on what is drawn).
 */

/**
 * A value an address holds, shown as it was just set (0.9.0-dev.92): the
 * router draws a new address in a transition, so a box or a field bound to
 * it would spring back for a moment — a tick undone, then done again, and
 * to a test's click no change at all. What was set is shown at once, until
 * the address catches up (a value other than the one it was set from); then
 * it is let go, so Back to that same address later shows the address.
 */
export function useAtOnce<T>(
  value: T,
  apply: (next: T) => void,
  keyOf: (v: T) => string = String,
): [T, (next: T) => void] {
  const [set, setSet] = useState<{ from: string; value: T } | null>(null);
  const key = keyOf(value);
  // The address moved on: what was set is the address's now, or overtaken.
  const [seen, setSeen] = useState(key);
  if (seen !== key) {
    setSeen(key);
    setSet(null);
  }
  const shown = set !== null && set.from === key && seen === key ? set.value : value;
  return [
    shown,
    (next) => {
      setSet({ from: key, value: next });
      apply(next);
    },
  ];
}

export interface FilterOption {
  value: string;
  label: string;
}

/** Past this many choices a list has a box to find one in. */
export const FIND_FROM = 12;

/**
 * How long the filters may make an address, in characters: with the cap of
 * choices, a household's long tags never make an address the server refuses
 * (431). The page gives each filter what is left of it (`room`).
 */
export const ADDRESS_ROOM = 4000;

/** What is said beside the boxes when no more can be ticked. */
export const CAP_WORDS = `You can choose up to ${FILTER_VALUES_MAX}.`;

/** What a filter's button says: what none chosen means, the one chosen, or how many. */
export function filterSummary(
  label: string,
  any: string,
  values: readonly string[],
  options: readonly FilterOption[],
  unknown: (value: string) => string = (v) => v,
): string {
  if (values.length === 0) return any;
  if (values.length === 1) return labelOf(values[0] as string, options, unknown);
  return `${label} · ${values.length}`;
}

/**
 * A value's name among the choices; one no longer offered, or not yet known
 * (a collection gone, somebody not given, the household still loading), by
 * the filter's words for one it cannot name — never an id.
 */
export function labelOf(
  value: string,
  options: readonly FilterOption[],
  unknown: (value: string) => string = (v) => v,
): string {
  return options.find((o) => o.value === value)?.label ?? unknown(value);
}

/** The choices, with any chosen that are no longer offered still there to untick. */
function withChosen(
  values: readonly string[],
  options: readonly FilterOption[],
  unknown: (value: string) => string,
): FilterOption[] {
  return [
    ...options,
    ...values
      .filter((v) => !options.some((o) => o.value === v))
      .map((v) => ({ value: v, label: unknown(v) })),
  ];
}

/** What one value takes of an address: its field, `=`, the value and an `&`. */
export const addressLength = (field: string, value: string) =>
  field.length + encodeURIComponent(value).length + 2;

export function MultiFilter(props: {
  /** Unique on the page: each box's id starts with it. */
  id: string;
  /** The filter's name: "Person". */
  label: string;
  /** What none chosen means, on the closed button: "All people". */
  any: string;
  values: readonly string[];
  options: readonly FilterOption[];
  onChange: (values: string[]) => void;
  /** In a sheet: the boxes under the filter's name, nothing to open. */
  inline?: boolean | undefined;
  /** How a value the filter cannot name is said: "someone in the family". */
  unknown?: ((value: string) => string) | undefined;
  /** The find box's name, for a long list: "Find a tag". */
  find?: string | undefined;
  /** The field the address gives it under, and what is left of the address (`ADDRESS_ROOM`). */
  field?: string | undefined;
  room?: number | undefined;
}) {
  const unknown = props.unknown ?? ((v: string) => v);
  const [open, setOpen] = useState(false);
  const [found, setFound] = useState('');
  const boxId = useId();
  const capId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // The box last ticked or unticked, by its place in the list: given the
  // focus if it went with its value (one no longer offered, unticked), once
  // the page is drawn without it.
  const pending = useRef<number | null>(null);
  // What is chosen, shown as ticked the moment it is (`useAtOnce`).
  const [values, setValues] = useAtOnce<readonly string[]>(
    props.values,
    (next) => props.onChange([...next]),
    (v) => v.join('\u0000'),
  );
  const options = withChosen(values, props.options, unknown);
  const chosenKey = values.join('\u0000');
  useLayoutEffect(() => {
    const at = pending.current;
    if (at === null) return;
    pending.current = null;
    const here = list.current;
    if (!here || here.contains(document.activeElement)) return;
    const boxes = [...here.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    (boxes[at] ?? boxes[at - 1] ?? boxes[0] ?? button.current)?.focus();
  }, [chosenKey]);

  const toggle = (value: string, on: boolean, at: number) => {
    const next = on
      ? [...values.filter((v) => v !== value), value]
      : values.filter((v) => v !== value);
    pending.current = at;
    // In the order they are offered, so the address is the same however they were ticked.
    setValues(options.map((o) => o.value).filter((v) => next.includes(v)));
  };
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  // No more than the vault takes at once, nor an address too long to send.
  const field = props.field ?? props.id;
  const room = props.room ?? Infinity;
  const full = values.length >= FILTER_VALUES_MAX;
  const blockedOf = (value: string) =>
    !values.includes(value) && (full || addressLength(field, value) > room);
  const capped = options.some((o) => blockedOf(o.value));

  // A long list: a box to find one in; those chosen stay, to untick.
  const findable = options.length > FIND_FROM;
  const want = found.trim().toLowerCase();
  const visible = options
    .map((o, i) => ({ ...o, i }))
    .filter((o) => !want || o.label.toLowerCase().includes(want) || values.includes(o.value));

  const on = values.length > 0;
  const findWords = props.find ?? `Find a ${props.label.toLowerCase()}`;
  const head =
    on || findable ? (
      <div className="multi-filter-head">
        {findable && (
          <input
            type="search"
            className="multi-filter-find"
            aria-label={findWords}
            placeholder={findWords}
            value={found}
            onChange={(e) => setFound(e.target.value)}
          />
        )}
        {on && (
          <button
            type="button"
            className="btn btn-quiet btn-small multi-filter-clear"
            onClick={() => {
              setValues([]);
              if (!props.inline) button.current?.focus();
            }}
          >
            Show all
          </button>
        )}
      </div>
    ) : null;
  const body = (
    <>
      {head}
      {capped && (
        <p id={capId} className="muted multi-filter-cap">
          {CAP_WORDS}
        </p>
      )}
      <div ref={list} className="multi-filter-list">
        {visible.length === 0 ? (
          <p className="muted">{options.length === 0 ? props.any : 'None match.'}</p>
        ) : (
          visible.map((o, at) => {
            const blocked = blockedOf(o.value);
            return (
              <Check
                key={o.value}
                id={`${props.id}-${o.i}`}
                checked={values.includes(o.value)}
                disabled={blocked}
                describedBy={blocked ? capId : undefined}
                label={o.label}
                onChange={(tick) => toggle(o.value, tick, at)}
              />
            );
          })
        )}
      </div>
    </>
  );

  if (props.inline) {
    return (
      <fieldset className="multi-filter-inline">
        <legend>{props.label}</legend>
        {body}
      </fieldset>
    );
  }

  const summary = filterSummary(props.label, props.any, values, options, unknown);
  return (
    <div
      className="filter multi-filter"
      // Shut when the focus goes somewhere else, as Columns does (W14). A
      // box that went with its value leaves the focus nowhere for a moment
      // (no next element): it stays open, and the next box takes the focus.
      onBlur={(e) => {
        if (open && e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={button}
        id={props.id}
        type="button"
        className={on ? 'multi-filter-btn on' : 'multi-filter-btn'}
        // Its name says the filter and then what it holds, its words among them.
        aria-label={`${props.label}: ${summary}`}
        aria-expanded={open}
        aria-controls={open ? boxId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        {summary}
        <span className="multi-filter-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div
          id={boxId}
          ref={box}
          className="multi-filter-menu"
          role="group"
          aria-label={`${props.label}: any of these`}
        >
          {body}
        </div>
      )}
    </div>
  );
}

/** A choice said as a chip: its words, and what taking it off does. */
export interface Chip {
  key: string;
  words: string;
  clear: () => void;
}

/**
 * The choices made, a chip each, each taken off by its ×, and Clear all
 * (0.9.0-dev.92). Taking one off puts the focus on the next chip's ×, or the
 * one before, or — none left — on `fallback`, never nowhere: once the page is
 * drawn without it, whenever the router draws it. Render it always, so it is
 * there to move the focus when the last chip goes; it draws nothing then.
 */
export function ChipRow(props: {
  chips: readonly Chip[];
  /** Every filter taken off. */
  onClearAll: () => void;
  /** Where the focus goes when there are no chips left. */
  fallback: RefObject<HTMLElement | null>;
  /** Said under the chips, beside them (a folder asking more than the table shows). */
  note?: ReactNode;
  label?: string;
}) {
  const row = useRef<HTMLDivElement>(null);
  // The place of the chip taken off (past the last for Clear all), until
  // the page is drawn without it.
  const pending = useRef<number | null>(null);
  const shownKey = props.chips.map((c) => c.key).join('\u0000');
  const { fallback } = props;
  useLayoutEffect(() => {
    const at = pending.current;
    if (at === null) return;
    pending.current = null;
    const xs = [...(row.current?.querySelectorAll<HTMLButtonElement>('button.chip-x') ?? [])];
    (xs[at] ?? xs[at - 1] ?? fallback.current)?.focus();
  }, [shownKey, fallback]);
  if (props.chips.length === 0 && !props.note) return null;
  return (
    <div ref={row} className="filter-chips" role="group" aria-label={props.label ?? 'Chosen'}>
      {props.chips.map((c, i) => (
        <span key={c.key} className="folder-chip">
          {c.words}
          <button
            type="button"
            className="btn btn-quiet btn-small chip-x"
            aria-label={`Take off the filter ${c.words}`}
            onClick={() => {
              pending.current = i;
              c.clear();
            }}
          >
            <span aria-hidden="true">×</span>
          </button>
        </span>
      ))}
      {props.chips.length > 0 && (
        <button
          type="button"
          className="btn btn-quiet btn-small"
          onClick={() => {
            // Past the last chip: none is left to take the focus but the filters.
            pending.current = Number.MAX_SAFE_INTEGER;
            props.onClearAll();
          }}
        >
          Clear all
        </button>
      )}
      {props.note}
    </div>
  );
}
