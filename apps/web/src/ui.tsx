import { avatarColour, can, statusTone, type Status } from '@fdv/shared';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { NavLink } from 'react-router';
import { storedRole } from './session.js';

/** Small shared pieces, styled from the tokens in styles.css. */

export function Logo() {
  return (
    <div className="logo" aria-hidden="true">
      <svg
        width="32"
        height="32"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#fff"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 3 4 6v6c0 4.4 3.4 8.3 8 9 4.6-.7 8-4.6 8-9V6z" />
      </svg>
    </div>
  );
}

export function Field(props: {
  id: string;
  label: string;
  type?: string;
  value: string;
  autoComplete?: string;
  hint?: string | undefined;
  required?: boolean;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="field">
      <label htmlFor={props.id}>{props.label}</label>
      <input
        id={props.id}
        type={props.type ?? 'text'}
        value={props.value}
        autoComplete={props.autoComplete}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        required={props.required ?? true}
      />
      {props.hint && <span className="muted">{props.hint}</span>}
    </div>
  );
}

export function Select(props: {
  id: string;
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
  hint?: string | undefined;
}) {
  return (
    <div className="field">
      <label htmlFor={props.id}>{props.label}</label>
      <select id={props.id} value={props.value} onChange={(e) => props.onChange(e.target.value)}>
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {props.hint && <span className="muted">{props.hint}</span>}
    </div>
  );
}

export function Button(props: {
  children: ReactNode;
  kind?: 'primary' | 'quiet' | 'link';
  type?: 'submit' | 'button';
  disabled?: boolean;
  onClick?: () => void;
  ariaLabel?: string;
}) {
  return (
    <button
      type={props.type ?? 'button'}
      className={`btn btn-${props.kind ?? 'primary'}`}
      disabled={props.disabled}
      onClick={props.onClick}
      aria-label={props.ariaLabel}
    >
      {props.children}
    </button>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="error" role="alert">
      {message}
    </p>
  );
}

/** A choice made of pills: the wizard's "We own it / We rent" pattern. */
export function Pills<T extends string>(props: {
  label: string;
  value: T | null;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="field" role="group" aria-label={props.label}>
      <span className="field-label">{props.label}</span>
      <div className="pills">
        {props.options.map((o) => (
          <button
            key={o.value}
            type="button"
            className={`pill${props.value === o.value ? ' pill-on' : ''}`}
            aria-pressed={props.value === o.value}
            onClick={() => props.onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Avatar({
  name,
  colour,
  size = 44,
}: {
  name: string;
  colour: number;
  size?: number;
}) {
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        background: avatarColour(colour),
        fontSize: size * 0.42,
      }}
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

/** Status is never colour alone: a dot plus words (NFR-09). */
export function StatusBadge({ status }: { status: Status }) {
  const t = statusTone(status);
  if (!t) return null;
  return <span className={`status status-${t.tone}`}>{t.words}</span>;
}

export function TopBar({
  title,
  back,
  action,
}: {
  title: string;
  back?: string;
  action?: ReactNode;
}) {
  return (
    <header className="topbar">
      {back && (
        <NavLink to={back} className="back" aria-label="Back">
          ‹
        </NavLink>
      )}
      <h1 style={{ fontSize: 24, flexGrow: 1 }}>{title}</h1>
      {action}
    </header>
  );
}

export function BottomNav() {
  const canAdd = can(storedRole(), 'document.add');
  const item = (to: string, label: string, icon: string) => (
    <NavLink
      to={to}
      className={({ isActive }) => `nav-item${isActive ? ' nav-on' : ''}`}
      end={to === '/'}
    >
      <span aria-hidden="true" className="nav-icon">
        {icon}
      </span>
      <span>{label}</span>
    </NavLink>
  );
  return (
    <nav className="bottomnav" aria-label="Main">
      {item('/', 'Home', '⌂')}
      {item('/search', 'Search', '⌕')}
      {/* A viewer can open and download, and nothing else: an Add button
          that always refuses is worse than no Add button. */}
      {canAdd && (
        <NavLink to="/add" className="fab" aria-label="Add a document">
          +
        </NavLink>
      )}
      {item('/reminders', 'Reminders', '◷')}
      {item('/people', 'People', '☺')}
    </nav>
  );
}

/** A bin with a lid, drawn: emoji look different on every phone. */
export function TrashIcon() {
  return (
    <svg
      className="icon"
      aria-hidden="true"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

/** What Tab can reach inside a sheet. */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/** The sheet on top of the page, if one is open: the last in the page is drawn over the rest. */
function topSheet(): HTMLElement | null {
  const open = document.querySelectorAll<HTMLElement>('[aria-modal="true"]');
  return open[open.length - 1] ?? null;
}

/**
 * The focus handling every sheet over the page shares: the "are you sure?"
 * (5.1), a row's ⋯ menu and what it opens (5.4), and "confirm it is you".
 * Focus starts on `start`, or on the first thing in the box. Tab stays
 * inside. Escape is an answer, unless the action is already on its way.
 * Only the sheet on top listens: "confirm it is you" over a Share sheet
 * takes its own Tab and Escape. When the sheet goes, focus goes back where
 * it came from, or into the sheet underneath when that has gone.
 */
export function useSheetFocus(
  box: RefObject<HTMLElement | null>,
  opts: {
    start?: RefObject<HTMLElement | null>;
    onEscape: () => void;
    busy?: boolean | undefined;
    /** Where focus goes afterwards when the browser remembered none (Safari). */
    returnFocus?: RefObject<HTMLElement | null> | undefined;
  },
) {
  const latest = useRef(opts);
  useEffect(() => {
    latest.current = opts;
  });
  useEffect(() => {
    const active = document.activeElement;
    const before = active instanceof HTMLElement && active !== document.body ? active : null;
    const inside = () =>
      box.current ? [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)] : [];
    (latest.current.start?.current ?? inside()[0])?.focus();
    const onKey = (e: KeyboardEvent) => {
      // Another sheet is over this one: the keys are its. (A menu is not a
      // sheet, so it steps aside for any.)
      const top = topSheet();
      if (top && box.current && top !== box.current && !box.current.contains(top)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!latest.current.busy) latest.current.onEscape();
        return;
      }
      if (e.key !== 'Tab' || !box.current) return;
      const focusable = inside();
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (!box.current.contains(document.activeElement)) {
        e.preventDefault();
        (latest.current.start?.current ?? first).focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      // What focus came from may have gone, or been switched off while the
      // sheet worked: then the next best that will take it.
      const underneath = topSheet()?.querySelector<HTMLElement>(FOCUSABLE) ?? null;
      for (const to of [before, latest.current.returnFocus?.current, underneath]) {
        to?.focus();
        if (to && document.activeElement === to) return;
      }
    };
  }, [box]);
}

/**
 * The app's own "are you sure?" (5.1), never the browser's confirm(): over
 * the page like the step-up sheet. Cancel or Escape is a real answer, until
 * the action is on its way: then neither can take it back, so neither
 * pretends to. Focus starts on Cancel, so Enter never does the thing by
 * accident; it stays inside the dialog, and goes back where it came from.
 */
export function ConfirmDialog(props: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  /** What the confirm button says while the action is on its way. */
  busyLabel?: string;
  icon?: ReactNode;
  danger?: boolean;
  busy?: boolean;
  /** Where focus goes afterwards when the browser remembered none (Safari). */
  returnFocus?: RefObject<HTMLElement | null>;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const box = useRef<HTMLElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useSheetFocus(box, {
    start: cancel,
    onEscape: props.onCancel,
    busy: props.busy,
    returnFocus: props.returnFocus,
  });
  const busy = Boolean(props.busy);
  return (
    <div className="scrim" role="presentation">
      <section
        ref={box}
        className="card stack sheet"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-h"
        aria-describedby="confirm-body"
        aria-busy={busy}
      >
        <h2 id="confirm-h" style={{ fontSize: 20 }}>
          {props.title}
        </h2>
        <div id="confirm-body" className="muted">
          {props.children}
        </div>
        <div className="row">
          {/* aria-disabled, not disabled: a disabled button drops the focus
              it holds, and the trap above with it. */}
          <button
            type="button"
            className={`btn ${props.danger ? 'btn-danger' : 'btn-primary'} btn-icon`}
            aria-disabled={busy}
            onClick={() => {
              if (!busy) props.onConfirm();
            }}
          >
            {props.icon}
            {busy && props.busyLabel ? props.busyLabel : props.confirmLabel}
          </button>
          <button
            ref={cancel}
            type="button"
            className="btn btn-quiet"
            aria-disabled={busy}
            onClick={() => {
              if (!busy) props.onCancel();
            }}
          >
            Cancel
          </button>
        </div>
      </section>
    </div>
  );
}

/**
 * Moving a document to the Trash asks first (5.1): from its page, and from
 * its row's ⋯ (5.4), in the same words.
 */
export function MoveToTrashDialog(props: {
  title: string | null;
  busy: boolean;
  /** The button that asked: where focus goes back to. */
  returnFocus: RefObject<HTMLElement | null>;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmDialog
      title="Move to Trash?"
      confirmLabel="Move to Trash"
      busyLabel="Moving to Trash…"
      returnFocus={props.returnFocus}
      icon={<TrashIcon />}
      danger
      busy={props.busy}
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
    >
      <p>
        “{props.title ?? 'This document'}” leaves every list, search and reminder. You can bring it
        back from the Trash in Settings.
      </p>
    </ConfirmDialog>
  );
}

/**
 * A section that folds away (5.1), its count in brackets so a folded one
 * still says how much is in it. Whether it is folded is remembered on this
 * browser only.
 */
export function CollapsibleSection(props: {
  id: string;
  title: string;
  count: number;
  children: ReactNode;
}) {
  const key = `fdv.fold.${props.id}`;
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(key) !== 'closed';
    } catch {
      return true;
    }
  });
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(key, next ? 'open' : 'closed');
    } catch {
      // A private window: folded for now, not remembered.
    }
  };
  return (
    <section aria-labelledby={`${props.id}-h`}>
      <h2 id={`${props.id}-h`} className="section-h">
        <button
          type="button"
          className="section-toggle"
          aria-expanded={open}
          aria-controls={`${props.id}-body`}
          onClick={toggle}
        >
          <span>
            {props.title} ({props.count})
          </span>
          <span aria-hidden="true" className="chevron">
            {open ? '▾' : '▸'}
          </span>
        </button>
      </h2>
      <div id={`${props.id}-body`} hidden={!open}>
        {props.children}
      </div>
    </section>
  );
}

// One list for every app: see @fdv/shared/tokens.ts.
export { CATEGORY_LABELS, categoryLabel } from '@fdv/shared';
