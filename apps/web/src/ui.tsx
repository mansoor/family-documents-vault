import { avatarColour, graphemesOf, statusTone, type Status } from '@fdv/shared';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import { NavLink, useNavigate } from 'react-router';

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

/**
 * What a field the card asks for before it saves says after its name (5.10):
 * a '*' and the word, so it is never a symbol alone. Read out as "required".
 */
export function RequiredMark() {
  return (
    <>
      {' '}
      <span className="req-star" aria-hidden="true">
        *
      </span>{' '}
      <span className="req-word">required</span>
    </>
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
  /** Asked for before the card saves, which checks it itself (5.10). */
  requiredMark?: boolean;
  /** The card waited for it, or could not read it. */
  invalid?: boolean;
  inputMode?: 'text' | 'numeric' | 'decimal';
  maxLength?: number;
  /** A password read out to them (5.20): a phone keyboard leaves it as typed. */
  autoCapitalize?: 'none' | 'off' | 'sentences' | 'words' | 'characters';
  autoCorrect?: 'on' | 'off';
  /**
   * What is said about the value, directly under the field and heard with
   * it (5.16b): "We'll remind you 7 days before its due date."
   */
  note?: ReactNode;
  /**
   * Where the value came from, beside the label and heard with it (I2):
   * "suggested · 92%", "from the batch". Gone once the value is changed.
   */
  mark?: ReactNode;
  onChange: (v: string) => void;
}) {
  const noteId = props.note ? `${props.id}-note` : undefined;
  return (
    <div className="field">
      <label htmlFor={props.id}>
        {props.label}
        {props.requiredMark && <RequiredMark />}
        {props.mark && <> {props.mark}</>}
      </label>
      <input
        id={props.id}
        type={props.type ?? 'text'}
        value={props.value}
        autoComplete={props.autoComplete}
        placeholder={props.placeholder}
        inputMode={props.inputMode}
        maxLength={props.maxLength}
        autoCapitalize={props.autoCapitalize}
        autoCorrect={props.autoCorrect}
        onChange={(e) => props.onChange(e.target.value)}
        required={props.required ?? true}
        aria-required={props.requiredMark || undefined}
        aria-invalid={props.invalid || undefined}
        aria-describedby={noteId}
      />
      {props.hint && <span className="muted">{props.hint}</span>}
      {props.note && (
        <div id={noteId} className="field-note muted">
          {props.note}
        </div>
      )}
    </div>
  );
}

/** Plain text over several lines (5.10): a note, a long detail. Line breaks are kept. */
export function TextArea(props: {
  id: string;
  label: string;
  value: string;
  maxLength: number;
  hint?: string | undefined;
  requiredMark?: boolean;
  invalid?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div className="field">
      <label htmlFor={props.id}>
        {props.label}
        {props.requiredMark && <RequiredMark />}
      </label>
      <textarea
        id={props.id}
        value={props.value}
        rows={4}
        maxLength={props.maxLength}
        onChange={(e) => props.onChange(e.target.value)}
        aria-required={props.requiredMark || undefined}
        aria-invalid={props.invalid || undefined}
      />
      {props.hint && <span className="muted">{props.hint}</span>}
    </div>
  );
}

/**
 * A yes or a no (5.10): a switch, which says which in words as well. Given
 * a `word`, it stands alone in a row (5.12's Hide): that word beside it,
 * and `label` its whole name for a screen reader ("Hide Passport").
 */
export function Switch(props: {
  id: string;
  label: string;
  checked: boolean;
  requiredMark?: boolean;
  word?: string;
  onChange: (v: boolean) => void;
}) {
  const input = (
    <input
      id={props.id}
      type="checkbox"
      role="switch"
      checked={props.checked}
      aria-label={props.word === undefined ? undefined : props.label}
      onChange={(e) => props.onChange(e.target.checked)}
    />
  );
  if (props.word !== undefined) {
    return (
      <label className="switch">
        {input}
        <span aria-hidden="true">{props.word}</span>
      </label>
    );
  }
  return (
    <div className="field">
      <label htmlFor={props.id}>
        {props.label}
        {props.requiredMark && <RequiredMark />}
      </label>
      <span className="switch">
        {input}
        <span aria-hidden="true">{props.checked ? 'Yes' : 'No'}</span>
      </span>
    </div>
  );
}

/**
 * The app's box (`.check`, 5.19): beside the start of its label, never
 * wrapped onto a line of its own on a phone. With a `note`, what is said
 * about it sits just under the label, in the label's column (`.check-noted`),
 * and is heard with the box — never pushed down by the row's tap height.
 */
export function Check(props: {
  id: string;
  checked: boolean;
  label: ReactNode;
  onChange: (on: boolean) => void;
  note?: ReactNode;
  /** The note's id, when something else names it; `<id>-note` otherwise. */
  noteId?: string;
  /** Something else said about it, outside the row. */
  describedBy?: string | undefined;
  disabled?: boolean;
}) {
  const noteId = props.note ? (props.noteId ?? `${props.id}-note`) : undefined;
  const described = [noteId, props.describedBy].filter(Boolean).join(' ') || undefined;
  return (
    <div className={props.note ? 'check check-noted' : 'check'}>
      <input
        id={props.id}
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
        aria-describedby={described}
      />
      <label htmlFor={props.id}>{props.label}</label>
      {props.note && (
        <span id={noteId} className="muted check-note">
          {props.note}
        </span>
      )}
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
  requiredMark?: boolean;
  invalid?: boolean;
  /** The id of what is said about the choice, heard with it (5.16b). */
  describedBy?: string | undefined;
  /** Where the choice came from, beside the label and heard with it (I2), as a Field's. */
  mark?: ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={props.id}>
        {props.label}
        {props.requiredMark && <RequiredMark />}
        {props.mark && <> {props.mark}</>}
      </label>
      <select
        id={props.id}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        aria-required={props.requiredMark || undefined}
        aria-invalid={props.invalid || undefined}
        aria-describedby={props.describedBy}
      >
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

export function Button({
  ref,
  ...props
}: {
  children: ReactNode;
  kind?: 'primary' | 'quiet' | 'link';
  type?: 'submit' | 'button';
  disabled?: boolean;
  onClick?: () => void;
  ariaLabel?: string;
  /** The id of what a screen reader should hear with it: what pressing it does. */
  describedBy?: string;
  /** Its key, while single-key shortcuts are on (`aria-keyshortcuts`). */
  keyShortcuts?: string | undefined;
  /** A quiet button for something that cannot be undone, in the danger colour (5.24). */
  danger?: boolean;
  /** The button itself, for a dialog it opens to give focus back to (Safari focuses none). */
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      type={props.type ?? 'button'}
      className={`btn btn-${props.kind ?? 'primary'}${props.danger ? ' btn-danger-quiet' : ''}`}
      disabled={props.disabled}
      onClick={props.onClick}
      aria-label={props.ariaLabel}
      aria-describedby={props.describedBy}
      aria-keyshortcuts={props.keyShortcuts}
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

/**
 * A choice made of pills: the wizard's "We own it / We rent" pattern. The
 * group is named by what it shows, so one that must be answered before
 * the card saves is "… required" to a screen reader too (5.10's mark).
 */
export function Pills<T extends string>(props: {
  label: string;
  /** Asked for before the card saves, with nothing chosen for the person. */
  requiredMark?: boolean;
  value: T | null;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  const labelId = useId();
  return (
    <div className="field" role="group" aria-labelledby={labelId}>
      <span id={labelId} className="field-label">
        {props.label}
        {props.requiredMark && <RequiredMark />}
      </span>
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

/**
 * A person's circle (5.17c): their photo filling it, with their colour
 * behind while it loads or if it cannot be shown; otherwise their letters
 * (`initialsFor`, smaller when there are two). Always aria-hidden: their
 * name is beside it.
 */
export function Avatar({
  name,
  colour,
  size = 44,
  initials,
  photo,
}: {
  name: string;
  colour: number;
  size?: number;
  /** The family's letters for them; their first letter without. */
  initials?: string | undefined;
  /** Their photo's object URL, once fetched. */
  photo?: string | null | undefined;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const letters = initials ?? (graphemesOf(name.trim())[0] ?? '').toLocaleUpperCase();
  const shown = photo && failed !== photo ? photo : null;
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        background: avatarColour(colour),
        // Two letters as a reader counts them: "सी" is one.
        fontSize: size * (graphemesOf(letters).length > 1 ? 0.36 : 0.42),
      }}
    >
      {shown ? (
        <img className="avatar-photo" src={shown} alt="" onError={() => setFailed(shown)} />
      ) : (
        letters
      )}
    </span>
  );
}

/** Status is never colour alone: a dot plus words (NFR-09). */
export function StatusBadge({ status }: { status: Status }) {
  const t = statusTone(status);
  if (!t) return null;
  return <span className={`status status-${t.tone}`}>{t.words}</span>;
}

/**
 * Whether this tab came to the page from another of the app's own, so that
 * the browser's Back is a step within the app (react-router numbers the
 * entries it makes; the first is 0).
 */
export function cameFromTheApp(): boolean {
  const idx = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof idx === 'number' && idx > 0;
}

export function TopBar({
  title,
  back,
  backInApp,
  action,
}: {
  title: string;
  back?: string;
  /**
   * Back is where the page was come to from, as the browser's Back is —
   * the Documents table as it was left, a search, a person — when that was
   * in the app; `back` otherwise (a link opened afresh). R5's keyboard
   * paths: the table's sort, its filters and its row came back only with
   * the browser's own Back.
   */
  backInApp?: boolean;
  action?: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <header className="topbar">
      {back && (
        <NavLink
          to={back}
          className="back"
          aria-label="Back"
          onClick={(e) => {
            if (!backInApp || e.defaultPrevented || e.button !== 0) return;
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || !cameFromTheApp()) return;
            e.preventDefault();
            void navigate(-1);
          }}
        >
          ‹
        </NavLink>
      )}
      <h1 style={{ fontSize: 24, flexGrow: 1 }}>{title}</h1>
      {action}
    </header>
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

/** A padlock, drawn (5.19): beside what the share sheet does not tick for you. */
export function LockIcon() {
  return (
    <svg
      className="icon"
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
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
  // Copied as the render is committed, before anything else can happen: a
  // key pressed the moment `busy` turns false must read false. Copied in a
  // passive effect, as it was until 5.35, it could run after that key — the
  // browser may handle input before passive effects are flushed — and an
  // Escape right after an action finished read busy and left the sheet
  // open (a flaky Collections test under load).
  useLayoutEffect(() => {
    latest.current = opts;
  });
  useEffect(() => {
    const active = document.activeElement;
    const before = active instanceof HTMLElement && active !== document.body ? active : null;
    const inside = () =>
      box.current ? [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)] : [];
    (latest.current.start?.current ?? inside()[0])?.focus();
    const onKey = (e: KeyboardEvent) => {
      // Another sheet is over this one: the keys are its — one opened inside
      // this one too, as the question about one's links is in a row's "Who
      // can see" sheet (the third round, W2): its Escape is its own answer.
      // (A menu is not a sheet, so it steps aside for any.)
      const top = topSheet();
      if (top && box.current && top !== box.current) return;
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
 * A panel over the page (5.4): sharing, or who can see it, from a row's ⋯;
 * adding to a collection (5.15). While what it holds is on its way, Escape leaves
 * it open, as the "are you sure?" does: what comes back is shown only here.
 */
export function Sheet(props: {
  label: string;
  busy: boolean;
  returnFocus: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLElement>(null);
  useSheetFocus(box, {
    onEscape: props.onClose,
    busy: props.busy,
    returnFocus: props.returnFocus,
  });
  return (
    <div className="scrim" role="presentation">
      <section
        ref={box}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={props.label}
        aria-busy={props.busy}
      >
        {props.children}
      </section>
    </div>
  );
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
      title="Move to the Trash?"
      confirmLabel="Move to the Trash"
      busyLabel="Moving to the Trash…"
      returnFocus={props.returnFocus}
      icon={<TrashIcon />}
      danger
      busy={props.busy}
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
    >
      <p>
        “{props.title ?? 'This document'}” leaves every list, search and reminder. You can bring it
        back from the Trash.
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
