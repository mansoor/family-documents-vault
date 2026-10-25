import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { useLocation } from 'react-router';
import { TrashIcon } from './ui.js';

/**
 * One row of actions under a note and under a document (0.9.0, the owner's
 * request of 24 Oct 2026): Download, which acts at once; a button for each
 * of its sections — Who can see it, Tags, Collections, Share a link, a
 * document's History — each opening that section in a panel right under
 * the row; and Move to the Trash at the far end. Edit stays where it was.
 *
 * Each section button is a disclosure (`aria-expanded`, `aria-controls`):
 * one panel open at a time, the open one folded by its own button or by
 * Escape, which gives the focus back to it. Opened by a click, the focus
 * goes into the panel. Which was open is remembered for each person, a
 * note's apart from a document's, on this browser; none to begin with. A
 * link to a section — `#share`, `#tags`, `#collections`, `#history`,
 * `#who-can-see-it`, or the id of anything inside one — opens it.
 *
 * The row is a toolbar, as the editor's is: one Tab stop, the arrow keys
 * along it, Home and End. Tab goes on from it into the panel that is open,
 * which is the next thing on the page.
 *
 * Every panel stays drawn while folded, only hidden: what a section is in
 * the middle of — a link made and its PIN shown once, "Only you can open
 * this", a form half filled — is still there when it is opened again, and
 * each loads as it did when it was always on the page, so the counts on
 * the buttons cost nothing more. A section that says it is done (Cancel,
 * Done, a save) folds, and begins afresh next time.
 */

export type ActionSectionKey = 'visibility' | 'tags' | 'collections' | 'share' | 'history';

export interface ActionSection {
  key: ActionSectionKey;
  label: string;
  icon: ReactNode;
  /** Beside the label: a count, or who can see it; and how it is said. */
  badge?: { shown: string; spoken: string } | null;
  /** For a section with no heading of its own: one for a screen reader. */
  heading?: string;
  /** The section, given what to call once it is done with (Cancel, Done, a save). */
  render: (done: () => void) => ReactNode;
  /** Busy: Escape does not fold it, as a sheet's does not. */
  busy?: boolean;
}

/** The words a link uses for each section. */
const HASHES: Record<string, ActionSectionKey> = {
  'who-can-see-it': 'visibility',
  visibility: 'visibility',
  tags: 'tags',
  collections: 'collections',
  share: 'share',
  history: 'history',
};

const storeKey = (kind: 'note' | 'document', memberId: string | null) =>
  `fdv.actions.${kind}.${memberId ?? 'nobody'}`;

function remembered(kind: 'note' | 'document', memberId: string | null): ActionSectionKey | null {
  try {
    const kept = window.localStorage.getItem(storeKey(kind, memberId));
    return kept && Object.values(HASHES).includes(kept as ActionSectionKey)
      ? (kept as ActionSectionKey)
      : null;
  } catch {
    return null;
  }
}

function remember(
  kind: 'note' | 'document',
  memberId: string | null,
  key: ActionSectionKey | null,
) {
  try {
    if (key) window.localStorage.setItem(storeKey(kind, memberId), key);
    else window.localStorage.removeItem(storeKey(kind, memberId));
  } catch {
    // Blocked, or full: remembered for this visit only.
  }
}

/** What Tab can reach inside a panel. */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export function ActionRow({
  trashRef,
  ...props
}: {
  kind: 'note' | 'document';
  memberId: string | null;
  /** Download, at once; none when there is nothing to download. */
  onDownload?: (() => void) | null;
  sections: ActionSection[];
  /** Move to the Trash, for whoever may; its button, for the dialog to give focus back to. */
  onTrash?: (() => void) | null;
  /** The Trash's button, for its dialog to give the focus back to. */
  trashRef?: RefObject<HTMLButtonElement | null>;
  /** What Download or the Trash could not do, said under the row. */
  error?: ReactNode;
}) {
  const { kind, memberId, sections } = props;
  const id = useId();
  const { hash } = useLocation();
  const asked = hash.length > 1 ? decodeURIComponent(hash.slice(1)) : '';
  const [open, setOpen] = useState<ActionSectionKey | null>(
    () => HASHES[asked] ?? remembered(kind, memberId),
  );
  // Each section's turn: a new one begins it afresh.
  const [turns, setTurns] = useState<Partial<Record<ActionSectionKey, number>>>({});
  const [active, setActive] = useState(0);
  const toolbar = useRef<HTMLDivElement>(null);
  /** Where the focus goes once a panel is drawn: into it, or to its heading (a link). */
  const [focus, setFocus] = useState<{ key: ActionSectionKey; to: 'into' | 'heading' } | null>(
    null,
  );
  const shown = sections.some((s) => s.key === open) ? open : null;

  const panelId = (key: ActionSectionKey) => `${id}-${key}`;
  const buttonId = (key: ActionSectionKey) => `${id}-${key}-b`;

  const choose = (key: ActionSectionKey | null) => {
    setOpen(key);
    remember(kind, memberId, key);
  };

  // A link to a section, as the page opens or while it is open: the
  // section's word, or the id of something in it.
  useEffect(() => {
    if (!asked) return;
    const key =
      HASHES[asked] ??
      (document
        .getElementById(asked)
        ?.closest<HTMLElement>('[data-action-section]')
        ?.getAttribute('data-action-section') as ActionSectionKey | null | undefined);
    if (!key || !sections.some((s) => s.key === key)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFocus({ key, to: 'heading' });
    choose(key);
    // Only when the link changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked]);

  useLayoutEffect(() => {
    const want = focus;
    if (!want || want.key !== shown) return;
    const panel = document.getElementById(`${id}-${want.key}`);
    if (!panel || panel.hidden) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFocus(null);
    const heading = panel.querySelector<HTMLElement>('h2, h3');
    const first = panel.querySelector<HTMLElement>(FOCUSABLE);
    const target = want.to === 'into' ? (first ?? heading) : (heading ?? first);
    if (!target) return;
    if (target === heading && !heading.hasAttribute('tabindex')) {
      heading.setAttribute('tabindex', '-1');
    }
    if (want.to === 'heading') panel.scrollIntoView?.({ block: 'start' });
    target.focus({ preventScroll: want.to === 'heading' });
  }, [focus, shown, id]);

  const backTo = (key: ActionSectionKey) => {
    const button = document.getElementById(buttonId(key));
    button?.focus();
  };

  const toggle = (key: ActionSectionKey) => {
    if (shown === key) {
      choose(null);
      return;
    }
    setFocus({ key, to: 'into' });
    choose(key);
  };

  const done = (key: ActionSectionKey) => {
    setTurns((t) => ({ ...t, [key]: (t[key] ?? 0) + 1 }));
    if (open === key) choose(null);
    // Once the panel has gone: the button is where the person was.
    window.requestAnimationFrame(() => backTo(key));
    backTo(key);
  };

  const onPanelKey = (e: KeyboardEvent<HTMLDivElement>, section: ActionSection) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    // A dialog over the page answers its own Escape.
    if (document.querySelector('[aria-modal="true"]')) return;
    if (section.busy) return;
    e.preventDefault();
    choose(null);
    backTo(section.key);
  };

  // The row's buttons, in order: one of them reached by Tab, the arrows along.
  const first = props.onDownload ? 1 : 0;
  const count = first + sections.length + (props.onTrash ? 1 : 0);
  const current = active < count ? active : 0;
  const onToolbarKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = [...(toolbar.current?.querySelectorAll<HTMLButtonElement>('[data-action]') ?? [])];
    const at = all.indexOf(e.target as HTMLButtonElement);
    if (at < 0) return;
    const go = (to: number) => {
      e.preventDefault();
      const n = (to + all.length) % all.length;
      setActive(n);
      all[n]?.focus();
    };
    if (e.key === 'ArrowRight') go(at + 1);
    else if (e.key === 'ArrowLeft') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(all.length - 1);
  };
  const stop = (i: number) => {
    return { tabIndex: current === i ? 0 : -1, onFocus: () => setActive(i), 'data-action': '' };
  };

  if (count === 0) return null;
  return (
    <div className="action-row-wrap">
      <div
        ref={toolbar}
        className="action-row"
        role="toolbar"
        aria-label={kind === 'note' ? 'Note actions' : 'Document actions'}
        onKeyDown={onToolbarKey}
      >
        {props.onDownload && (
          <button type="button" className="btn action-btn" onClick={props.onDownload} {...stop(0)}>
            <ActionIcon name="download" />
            Download
          </button>
        )}
        {sections.map((s, i) => (
          <button
            key={s.key}
            id={buttonId(s.key)}
            type="button"
            className="btn action-btn"
            aria-expanded={shown === s.key}
            aria-controls={panelId(s.key)}
            onClick={() => toggle(s.key)}
            {...stop(first + i)}
          >
            {s.icon}
            {s.label}
            {s.badge && (
              <>
                <span className="visually-hidden">: {s.badge.spoken}</span>
                <span className="action-badge" aria-hidden="true">
                  {s.badge.shown}
                </span>
              </>
            )}
          </button>
        ))}
        {props.onTrash && (
          <button
            ref={trashRef}
            type="button"
            className="btn btn-link btn-trash action-trash"
            onClick={props.onTrash}
            {...stop(count - 1)}
          >
            <TrashIcon />
            Move to the Trash
          </button>
        )}
      </div>
      {props.error}
      <div>
        {sections.map((s) => (
          <div
            key={s.key}
            id={panelId(s.key)}
            className="action-panel"
            data-action-section={s.key}
            hidden={shown !== s.key}
            onKeyDown={(e) => onPanelKey(e, s)}
          >
            {s.heading && <h2 className="visually-hidden">{s.heading}</h2>}
            <PanelBody key={turns[s.key] ?? 0}>{s.render(() => done(s.key))}</PanelBody>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A section's own content, begun afresh with each turn. */
function PanelBody({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

/** "3 tags", "1 collection": a count as it is said. */
export function countBadge(n: number, one: string, many: string) {
  return { shown: String(n), spoken: `${n} ${n === 1 ? one : many}` };
}

type IconName = 'download' | 'eye' | 'tag' | 'collection' | 'link' | 'history';

const PATHS: Record<IconName, ReactNode> = {
  download: (
    <>
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M5 21h14" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  tag: (
    <>
      <path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" />
      <circle cx="7.5" cy="7.5" r="1.5" />
    </>
  ),
  collection: (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </>
  ),
  link: (
    <>
      <path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
    </>
  ),
  history: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
};

/** A row button's picture, drawn: never the only thing that says what it does. */
export function ActionIcon({ name }: { name: IconName }) {
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
      {PATHS[name]}
    </svg>
  );
}
