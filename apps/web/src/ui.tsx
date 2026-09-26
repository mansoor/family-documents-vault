import { avatarColour, can, statusTone, type Status } from '@fdv/shared';
import { useEffect, useRef, useState, type ReactNode } from 'react';
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

/**
 * The app's own "are you sure?" (5.1), never the browser's confirm(): over
 * the page like the step-up sheet. Cancel or Escape is a real answer. Focus
 * starts on Cancel, so Enter never does the irreversible-looking thing by
 * accident, and it stays inside the dialog until the dialog is answered.
 */
export function ConfirmDialog(props: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  icon?: ReactNode;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const box = useRef<HTMLElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const onCancel = useRef(props.onCancel);
  useEffect(() => {
    onCancel.current = props.onCancel;
  });
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel.current();
        return;
      }
      if (e.key !== 'Tab' || !box.current) return;
      const focusable = [...box.current.querySelectorAll<HTMLElement>('button:not([disabled])')];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
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
      before?.focus();
    };
  }, []);
  return (
    <div className="scrim" role="presentation">
      <section
        ref={box}
        className="card stack sheet"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-h"
        aria-describedby="confirm-body"
      >
        <h2 id="confirm-h" style={{ fontSize: 20 }}>
          {props.title}
        </h2>
        <div id="confirm-body" className="muted">
          {props.children}
        </div>
        <div className="row">
          <button
            type="button"
            className={`btn ${props.danger ? 'btn-danger' : 'btn-primary'} btn-icon`}
            disabled={props.busy}
            onClick={props.onConfirm}
          >
            {props.icon}
            {props.confirmLabel}
          </button>
          <button ref={cancel} type="button" className="btn btn-quiet" onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      </section>
    </div>
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
