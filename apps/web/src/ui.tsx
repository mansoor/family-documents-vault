import type { Status } from '@fdv/shared';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router';

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

const AVATAR = [
  '#1F5D4C',
  '#B7791F',
  '#4A5FA8',
  '#B3261E',
  '#6B4FA0',
  '#2A7F8F',
  '#8A6D3B',
  '#5E574E',
];

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
        background: AVATAR[colour % AVATAR.length],
        fontSize: size * 0.42,
      }}
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

/** Status is never colour alone: a dot plus words (NFR-09). */
export function StatusBadge({ status }: { status: Status }) {
  if (status.value === 'valid') return null;
  const tone =
    status.value === 'expired'
      ? 'danger'
      : status.value === 'expiring_soon' || status.value === 'needs_info'
        ? 'warn'
        : status.value === 'active'
          ? 'ok'
          : 'neutral';
  return <span className={`status status-${tone}`}>{status.label}</span>;
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
      <NavLink to="/add" className="fab" aria-label="Add a document">
        +
      </NavLink>
      {item('/reminders', 'Reminders', '◷')}
      {item('/people', 'People', '☺')}
    </nav>
  );
}

export const CATEGORY_LABELS: Record<string, string> = {
  identity: 'Identity',
  legal: 'Legal',
  property: 'Property & vehicle',
  financial: 'Financial',
  tax: 'Tax',
  insurance: 'Insurance',
  medical: 'Medical',
  education: 'Education',
  bills: 'Bills & utilities',
  work: 'Work',
  pets: 'Pets',
  other: 'Other',
};

export const categoryLabel = (c: string | null) => (c ? (CATEGORY_LABELS[c] ?? c) : 'Unsorted');
