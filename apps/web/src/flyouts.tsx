import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { Link, useNavigate } from 'react-router';
import { plainClick, useFlyouts, type Flyouts } from './flyout-context.js';
import {
  frontOf,
  isSideBySide,
  MAX_OPEN,
  MAX_SIDE,
  suggestions,
  WARN_FROM,
  type FlyoutItem,
  type FlyoutSet,
  type FlyoutState,
} from './flyout-store.js';
import { DocumentView } from './screens/Document.js';
import { shortcutsOn, useShortcutsOn } from './shortcuts.js';
import { Button, Dialog } from './ui.js';

/**
 * The documents open beside the list (flyouts), drawn by the shell over
 * whatever page is under them: the one in front at the right, over the
 * list, which stays there and reachable — a dialog that is not modal,
 * named by its heading; the others minimised, still there but hidden and
 * inert, so going back to one fetches nothing again; and the tray at the
 * right edge, an icon for each. Narrower than 700 px the one in front
 * covers the screen and the tray is an "N open" button with a list.
 *
 * From 1,100 px wide, two or three side by side over the list, equal
 * widths, under a bar with Add a third, Scroll together and One at a time;
 * the pane used last, marked by a green line, is the one a document opened
 * from the list replaces.
 *
 * Keys: Esc minimises (× closes); ] and [ (or Alt+↓ and Alt+↑) go to the
 * next and the previous; Delete on a tray icon closes it; ? lists them.
 * The keys of one character follow "Keyboard shortcuts" in Settings.
 */
export function FlyoutDesk() {
  const f = useFlyouts();
  if (!f) return null;
  return <Desk f={f} />;
}

/** How each is, in words: the tray's names and the lists'. */
export function stateWords(state: FlyoutState): string {
  return state === 'shown'
    ? 'showing'
    : state === 'min'
      ? 'minimised'
      : 'freed to save memory, opens again when chosen';
}

const nameOf = (f: Flyouts, id: string) => f.titles.get(id) ?? 'A document';

/**
 * Narrower than 700 px, the one in front covers the screen, so Back (the
 * browser's, a phone's) puts it in the tray rather than leaving the list:
 * an entry of the same address goes on the history while one is shown
 * there, marked as this one, and Back takes it off. Minimised or closed by
 * a button, the entry is taken off again (`leave`); a link inside it takes
 * the entry off first, then goes. The leave guard's entry (an unsaved note)
 * is its own, and is left alone.
 */
const ENTRY = 'fdvFlyout';
const LEAVE_GUARD = 'fdvLeaveGuard';

function historyState(): Record<string, unknown> | null {
  const state = window.history.state as unknown;
  return typeof state === 'object' && state !== null ? (state as Record<string, unknown>) : null;
}

/** On this one's entry, with nothing else's on top of it. */
function onOwnEntry(): boolean {
  const state = historyState();
  return state?.[ENTRY] === true && state[LEAVE_GUARD] !== true;
}

/**
 * Side by side, the panes in their order, left to right, first; then the
 * others (hidden) in the tray's order. Those in sight come first so that
 * one replaced never moves the others in the page: a pane moved would lose
 * its scroll and its focus.
 */
function drawOrder(set: FlyoutSet): FlyoutItem[] {
  const drawn = set.items.filter((it) => it.state !== 'freed');
  const side = set.side.flatMap((id) => drawn.filter((it) => it.id === id));
  return [...side, ...drawn.filter((it) => !set.side.includes(it.id))];
}

/**
 * A press or the focus in a pane makes it the one used last; not on its
 * own Minimise, Close or Open as a page, which take it away: the one used
 * last before it stays so.
 */
function usedBy(e: { target: EventTarget | null }): boolean {
  return !(e.target instanceof Element && e.target.closest('.doc-flyout-controls'));
}

/** A pane's page view: what Scroll together scrolls. */
const pageViewOf = (id: string) =>
  document.querySelector<HTMLElement>(`[data-flyout="${id}"] .viewer:not(.viewer-none)`);

/**
 * Scroll together: one pane's page view scrolled, the others' follow, as
 * far down theirs (a share of what each can scroll). What this sets is not
 * followed again, so none of them answers the others.
 */
function useScrollTogether(on: boolean, latest: RefObject<Flyouts>) {
  useEffect(() => {
    if (!on) return;
    const setHere = new WeakMap<Element, number>();
    const onScroll = (e: Event) => {
      const el = e.target;
      if (!(el instanceof HTMLElement) || !el.classList.contains('viewer')) return;
      const id = el.closest('[data-flyout]')?.getAttribute('data-flyout') ?? null;
      const side = latest.current.set.side;
      if (!id || !side.includes(id)) return;
      const was = setHere.get(el);
      if (was !== undefined) {
        setHere.delete(el);
        if (Math.abs(el.scrollTop - was) <= 1) return;
      }
      const room = el.scrollHeight - el.clientHeight;
      const share = room > 0 ? el.scrollTop / room : 0;
      for (const other of side) {
        if (other === id) continue;
        const view = pageViewOf(other);
        if (!view) continue;
        const its = view.scrollHeight - view.clientHeight;
        if (its <= 0) continue;
        const top = Math.round(share * its);
        if (Math.abs(view.scrollTop - top) <= 1) continue;
        setHere.set(view, top);
        view.scrollTop = top;
      }
    };
    document.addEventListener('scroll', onScroll, true);
    return () => document.removeEventListener('scroll', onScroll, true);
  }, [on, latest]);
}

function Desk({ f }: { f: Flyouts }) {
  const [keysOpen, setKeysOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  // Side by side: the picker (the second, or a third), what opened it, and
  // whether the page views scroll together.
  const [picker, setPicker] = useState<'pair' | 'third' | null>(null);
  const pickerFrom = useRef<HTMLElement | null>(null);
  const [together, setTogether] = useState(false);
  const sideBySide = isSideBySide(f.set);
  if (picker && (!f.sideOk || frontOf(f.set) === null || (picker === 'third' && !f.thirdOk))) {
    setPicker(null);
  }
  if (together && !sideBySide) setTogether(false);
  const latest = useRef(f);
  useLayoutEffect(() => {
    latest.current = f;
  });
  useScrollTogether(together && sideBySide, latest);
  const n = f.set.items.length;
  // The list of open ones goes with the last of them, and on a wide screen.
  if (listOpen && (n === 0 || !f.narrow)) setListOpen(false);

  // Back, below 700 px (ENTRY): what waits for the entry to be taken off.
  const navigate = useNavigate();
  const going = useRef(navigate);
  useLayoutEffect(() => {
    going.current = navigate;
  });
  const releasing = useRef<(() => void) | null>(null);
  const pushedAt = useRef<string | null>(null);
  const leave = useCallback((then?: () => void) => {
    const after = then ?? (() => undefined);
    if (releasing.current) {
      const before = releasing.current;
      releasing.current = () => {
        before();
        after();
      };
      return;
    }
    if (!onOwnEntry() || window.location.href !== pushedAt.current) {
      after();
      return;
    }
    pushedAt.current = null;
    releasing.current = after;
    window.history.back();
    // A Back the browser never makes: nothing waits for ever.
    window.setTimeout(() => {
      const left = releasing.current;
      releasing.current = null;
      left?.();
    }, 1000);
  }, []);
  const fenced = f.narrow && frontOf(f.set) !== null;
  const wasFenced = useRef(false);
  useEffect(() => {
    const was = wasFenced.current;
    wasFenced.current = fenced;
    if (fenced && !was) {
      if (onOwnEntry() || releasing.current) return;
      window.history.pushState(
        { ...(historyState() ?? {}), [ENTRY]: true },
        '',
        window.location.href,
      );
      pushedAt.current = window.location.href;
    } else if (!fenced && was) {
      leave();
    }
  }, [fenced, leave]);
  useEffect(() => {
    const onPop = () => {
      const pending = releasing.current;
      if (pending) {
        releasing.current = null;
        pending();
        return;
      }
      if (historyState()?.[ENTRY] === true) return;
      const now = latest.current;
      const front = frontOf(now.set);
      if (now.narrow && front) now.minimise(front);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  // A link inside the one covering the screen: its entry off first, then away.
  useEffect(() => {
    if (!fenced) return;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]');
      if (!(a instanceof HTMLAnchorElement) || !a.closest('[data-flyout]')) return;
      if (a.target && a.target !== '_self') return;
      const to = new URL(a.href, window.location.href);
      if (to.origin !== window.location.origin || !onOwnEntry()) return;
      // The link's own onClick still runs (Open as a page tells its list);
      // its own navigation does not.
      e.preventDefault();
      leave(() => void going.current(to.pathname + to.search + to.hash));
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [fenced, leave]);

  // The keys, for the whole page: never while typing, nor under a dialog
  // over the page or an open menu, which have their own.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (document.querySelector('[aria-modal="true"], [role="menu"]')) return;
      const now = latest.current;
      const t = e.target instanceof HTMLElement ? e.target : null;
      const typing =
        t !== null &&
        (t.isContentEditable || t.closest('input, textarea, select, [contenteditable="true"]'));
      if (typing || e.ctrlKey || e.metaKey) return;
      if (e.key === 'Escape') {
        if (e.altKey || e.shiftKey) return;
        // Waiting for a document from the list: no longer.
        if (now.picking) {
          e.preventDefault();
          now.cancelPick();
          return;
        }
        // The one the focus is in (side by side, that pane alone); or, with
        // the focus nowhere in particular, in the tray or on the bar above
        // those side by side, the one in front.
        const inPane = t?.closest('[data-flyout]')?.getAttribute('data-flyout') ?? null;
        const front = frontOf(now.set);
        const nowhere =
          t === null || t === document.body || t.closest('.flyout-tray, .flyout-side-bar') !== null;
        const which = inPane ?? (nowhere ? front : null);
        if (!which) return;
        e.preventDefault();
        now.minimise(which);
        return;
      }
      const alt = e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp');
      const single = !e.altKey && (e.key === ']' || e.key === '[' || e.key === '?');
      if (!alt && !single) return;
      if (single && !shortcutsOn()) return;
      if (e.key === '?') {
        if (e.repeat) return;
        e.preventDefault();
        setKeysOpen(true);
        return;
      }
      if (now.set.items.length === 0) return;
      e.preventDefault();
      now.step(e.key === ']' || e.key === 'ArrowDown' ? 1 : -1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const pill = useRef<HTMLButtonElement>(null);
  const said = f.said;
  return (
    <>
      <p className="visually-hidden" aria-live="polite" aria-atomic="true" data-flyouts-said="">
        {/* The same words twice are still said: one space more or less. */}
        {said ? `${said.text}${said.n % 2 === 0 ? ' ' : ''}` : ''}
      </p>
      {sideBySide && (
        <SideBar
          f={f}
          together={together}
          onTogether={() => setTogether((on) => !on)}
          onThird={(from) => {
            pickerFrom.current = from;
            setPicker('third');
          }}
        />
      )}
      {drawOrder(f.set).map((it) => (
        <Pane
          key={it.id}
          f={f}
          item={it}
          leave={leave}
          onSideBySide={(from) => {
            pickerFrom.current = from;
            setPicker('pair');
          }}
        />
      ))}
      {n > 0 && !f.narrow && <Tray f={f} />}
      {n > 0 && f.narrow && (
        <button
          ref={pill}
          type="button"
          className={`flyouts-pill${n >= WARN_FROM ? ' flyouts-pill-warn' : ''}`}
          data-flyouts-pill=""
          aria-haspopup="dialog"
          aria-expanded={listOpen}
          onClick={() => setListOpen(true)}
        >
          <Glyph name="stack" />
          {n} open
        </button>
      )}
      {f.warning && (
        <div className="flyout-warn" role="note">
          <p>
            {n} documents open. Many open documents slow the vault down: close the ones you’ve
            finished with.
          </p>
          <button
            type="button"
            className="icon-btn icon-btn-plain"
            aria-label="Put this warning away"
            onClick={f.dismissWarning}
          >
            <Glyph name="close" size={16} />
          </button>
        </div>
      )}
      {listOpen && <OpenList f={f} returnFocus={pill} onClose={() => setListOpen(false)} />}
      {picker && (
        <SideBySidePicker
          f={f}
          mode={picker}
          returnFocus={pickerFrom}
          onClose={() => setPicker(null)}
        />
      )}
      {f.limit && <LimitDialog f={f} />}
      {keysOpen && <KeysDialog onClose={() => setKeysOpen(false)} />}
    </>
  );
}

const quotedName = (f: Flyouts, id: string | null) => {
  const known = id ? f.titles.get(id) : undefined;
  return known ? `“${known}”` : 'the document showing';
};

/** One document beside the list: its view, with the host's buttons. */
function Pane({
  f,
  item,
  leave,
  onSideBySide,
}: {
  f: Flyouts;
  item: FlyoutItem;
  /** Takes Back's entry off first, below 700 px, then does this. */
  leave: (then: () => void) => void;
  /** Side by side asked for: the picker, opened from this button. */
  onSideBySide: (from: HTMLElement) => void;
}) {
  const navigate = useNavigate();
  const ids = useId();
  const headingId = `${ids}-title`;
  const lastId = `${ids}-last`;
  const min = item.state === 'min';
  const name = f.titles.get(item.id) ?? 'this document';
  const both = item.view === 'both';
  // Side by side: where it is, of how many, and whether it is the pane used last.
  const at = f.set.side.indexOf(item.id);
  const side = !min && at >= 0 && isSideBySide(f.set);
  const last = side && frontOf(f.set) === item.id;
  const className = f.narrow
    ? 'flyout flyout-full'
    : side
      ? `flyout flyout-side flyout-of-${f.set.side.length} flyout-at-${at}${last ? ' flyout-last' : ''}`
      : 'flyout';
  return (
    <section
      className={className}
      role="dialog"
      aria-modal="false"
      aria-labelledby={headingId}
      aria-describedby={last ? lastId : undefined}
      data-flyout={item.id}
      hidden={min}
      inert={min}
      onFocus={side ? (e) => usedBy(e) && f.use(item.id) : undefined}
      onPointerDown={side ? (e) => usedBy(e) && f.use(item.id) : undefined}
    >
      {last && (
        <p id={lastId} className="visually-hidden">
          Used last: a document opened from the list takes its place.
        </p>
      )}
      <DocumentView
        id={item.id}
        host="flyout"
        view={item.view}
        headingId={headingId}
        notice={
          // Choosing from the list: said here, in the one it goes beside,
          // over none of the list's rows.
          f.picking && frontOf(f.set) === item.id ? (
            <div className="flyout-pick">
              <p>Choose a document in the list to show beside this one.</p>
              <Button kind="quiet" onClick={f.cancelPick}>
                Cancel
              </Button>
            </div>
          ) : undefined
        }
        onLoaded={(got) => f.loaded(item.id, got)}
        onClosed={(why) => {
          if (why.reason === 'trashed') {
            f.trashed(item.id, why.said);
          } else {
            // A note is read on Notes.
            f.close(item.id, 'quiet');
            leave(() => void navigate(`/notes/${why.noteId}`));
          }
        }}
        tools={
          <>
            <button
              type="button"
              className="btn btn-quiet flyout-details-btn"
              aria-expanded={both}
              onClick={() => f.setView(item.id, both ? 'content' : 'both')}
            >
              <Glyph name="panel" size={18} />
              {both ? 'Hide details' : 'Show details'}
            </button>
            {f.sideOk && !side && !min && (
              <button
                type="button"
                className="btn btn-quiet flyout-details-btn"
                aria-haspopup="dialog"
                onClick={(e) => onSideBySide(e.currentTarget)}
              >
                <Glyph name="columns" size={18} />
                Side by side
              </button>
            )}
          </>
        }
        controls={
          <>
            <Link
              to={`/documents/${item.id}`}
              className="icon-btn icon-btn-plain"
              aria-label="Open as a page"
              title="Open as a page"
              onClick={(e) => {
                if (plainClick(e)) f.asPage(item.id);
              }}
            >
              <Glyph name="page" />
            </Link>
            <button
              type="button"
              className="icon-btn icon-btn-plain"
              aria-label={`Minimise ${name}`}
              title="Minimise (Esc)"
              onClick={() => f.minimise(item.id)}
            >
              <Glyph name="minimise" />
            </button>
            <button
              type="button"
              className="icon-btn icon-btn-plain"
              aria-label={`Close ${name}`}
              title="Close"
              onClick={() => f.close(item.id, 'pane')}
            >
              <Glyph name="close" />
            </button>
          </>
        }
      />
    </section>
  );
}

/**
 * Above those side by side: Add a third (with two), Scroll together, and
 * One at a time. A region of the page, not a dialog: the panes are the
 * dialogs.
 */
function SideBar(props: {
  f: Flyouts;
  together: boolean;
  onTogether: () => void;
  onThird: (from: HTMLElement) => void;
}) {
  const { f } = props;
  return (
    <section className="flyout-side-bar" aria-label="Side by side">
      {f.thirdOk && f.set.side.length < MAX_SIDE && (
        <button
          type="button"
          className="btn btn-quiet flyout-details-btn"
          aria-haspopup="dialog"
          onClick={(e) => props.onThird(e.currentTarget)}
        >
          <Glyph name="columns" size={18} />
          Add a third
        </button>
      )}
      <button
        type="button"
        className="btn btn-quiet flyout-details-btn"
        aria-pressed={props.together}
        onClick={props.onTogether}
      >
        <Glyph name="together" size={18} />
        Scroll together
      </button>
      <button type="button" className="btn btn-quiet flyout-details-btn" onClick={f.oneAtATime}>
        <Glyph name="single" size={18} />
        One at a time
      </button>
    </section>
  );
}

/**
 * Side by side, or Add a third: which document goes beside the one in
 * front — one of those open (the tray's), or one chosen from the list.
 */
function SideBySidePicker(props: {
  f: Flyouts;
  mode: 'pair' | 'third';
  returnFocus: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const { f } = props;
  const front = frontOf(f.set);
  const showing = isSideBySide(f.set) ? f.set.side : front ? [front] : [];
  const others = f.set.items.filter((it) => !showing.includes(it.id));
  return (
    <Dialog
      title={props.mode === 'third' ? 'Add a third' : 'Side by side'}
      returnFocus={props.returnFocus}
      onClose={props.onClose}
      closeLabel="Cancel"
      actions={
        <Button
          kind="quiet"
          onClick={() => {
            props.onClose();
            f.pickFromList();
          }}
        >
          Choose from the list
        </Button>
      }
    >
      <p>
        {props.mode === 'third'
          ? 'Choose a third document to show beside these two: one that is open, or one from the list.'
          : `Choose a document to show beside ${quotedName(f, front)}: one that is open, or one from the list.`}
      </p>
      {others.length > 0 ? (
        <ul className="list flyout-list" aria-label="Open documents">
          {others.map((it) => (
            <li key={it.id}>
              <button
                type="button"
                className="rowbtn"
                onClick={() => {
                  props.onClose();
                  f.beside(it.id);
                }}
              >
                <span className="doc-title">{nameOf(f, it.id)}</span>
                <span className="muted">{stateWords(it.state)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No other documents are open.</p>
      )}
    </Dialog>
  );
}

/**
 * The tray at the right edge: an icon for each open document, its full
 * name and how it is on hover and focus (and in its name); a small × on
 * its corner on hover (always on a touch screen) closes it without opening
 * it, as Delete does on the icon; and Close all.
 */
function Tray({ f }: { f: Flyouts }) {
  const n = f.set.items.length;
  const many = n >= WARN_FROM;
  const [tip, setTip] = useState<{ id: string; top: number } | null>(null);
  const tipFor = (id: string, el: Element | null) => {
    const box = el?.getBoundingClientRect();
    setTip({ id, top: box ? box.top + box.height / 2 : 0 });
  };
  const tipItem = tip ? f.set.items.find((it) => it.id === tip.id) : undefined;
  return (
    <nav className="flyout-tray" aria-label="Open documents">
      <p
        className={many ? 'tray-count tray-count-warn' : 'tray-count'}
        title={many ? 'Many documents open: this can slow the vault down' : undefined}
      >
        <span className="tray-n">{n}</span> open
        {many && <span className="visually-hidden">: many open documents slow the vault down</span>}
      </p>
      <ul className="tray-list">
        {f.set.items.map((it) => {
          const name = nameOf(f, it.id);
          return (
            <li
              key={it.id}
              className="tray-item"
              onMouseEnter={(e) => tipFor(it.id, e.currentTarget)}
              onMouseLeave={() => setTip(null)}
            >
              <button
                type="button"
                className={`tray-icon tray-${it.state}`}
                data-tray={it.id}
                aria-label={`${name}, ${stateWords(it.state)}`}
                aria-current={it.state === 'shown' ? 'true' : undefined}
                onClick={() => f.show(it.id)}
                onFocus={(e) => tipFor(it.id, e.currentTarget)}
                onBlur={() => setTip(null)}
                onKeyDown={(e) => {
                  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
                  e.preventDefault();
                  setTip(null);
                  f.close(it.id, 'tray');
                }}
              >
                <span className="tray-glyph" aria-hidden="true">
                  <Glyph name="file" />
                </span>
                <span className="tray-label" aria-hidden="true">
                  {name}
                </span>
              </button>
              <button
                type="button"
                className="tray-x"
                aria-label={`Close ${name}`}
                onClick={() => {
                  setTip(null);
                  f.close(it.id, 'tray');
                }}
              >
                <Glyph name="close" size={12} />
              </button>
            </li>
          );
        })}
      </ul>
      <button type="button" className="tray-all" onClick={f.closeAll}>
        Close all
      </button>
      {tip && tipItem && (
        <div className="tray-tip" aria-hidden="true" style={{ top: tip.top }}>
          <strong>{nameOf(f, tipItem.id)}</strong>
          <span>{stateWords(tipItem.state)}</span>
        </div>
      )}
    </nav>
  );
}

/** Narrower than 700 px: the open documents, from "N open". */
function OpenList(props: {
  f: Flyouts;
  returnFocus: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const { f } = props;
  const n = f.set.items.length;
  return (
    <Dialog
      title={`${n} open`}
      returnFocus={props.returnFocus}
      onClose={props.onClose}
      actions={
        <Button kind="quiet" onClick={f.closeAll}>
          Close all
        </Button>
      }
    >
      <ul className="list flyout-list">
        {f.set.items.map((it) => {
          const name = nameOf(f, it.id);
          return (
            <li key={it.id}>
              <button
                type="button"
                className="rowbtn"
                data-tray={it.id}
                aria-current={it.state === 'shown' ? 'true' : undefined}
                onClick={() => {
                  props.onClose();
                  f.show(it.id);
                }}
              >
                <span className="doc-title">{name}</span>
                <span className="muted">{stateWords(it.state)}</span>
              </button>
              <button
                type="button"
                className="icon-btn icon-btn-plain"
                aria-label={`Close ${name}`}
                onClick={() => f.close(it.id, 'tray')}
              >
                <Glyph name="close" size={16} />
              </button>
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}

/** The 11th asked for: which to close, freed ones first, then minimised. */
function LimitDialog({ f }: { f: Flyouts }) {
  const none = useRef<HTMLElement>(null);
  const want = f.limit?.title;
  const order = suggestions(f.set);
  return (
    <Dialog
      title={`${MAX_OPEN} documents are open`}
      returnFocus={none}
      onClose={f.cancelLimit}
      closeLabel="Cancel"
    >
      <p>
        That’s the most at once: many open documents slow the vault down. To open{' '}
        {want ? `“${want}”` : 'this document'}, close one of these first.
      </p>
      <ul className="list flyout-list">
        {order.map((it, i) => {
          const name = nameOf(f, it.id);
          return (
            <li key={it.id}>
              <span>
                <strong>{name}</strong>
                <span className="muted">
                  {stateWords(it.state)}
                  {i === 0 && it.state !== 'shown' ? ' · suggested' : ''}
                </span>
              </span>
              <Button kind="quiet" ariaLabel={`Close ${name}`} onClick={() => f.makeRoom(it.id)}>
                Close
              </Button>
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}

function KeysDialog(props: { onClose: () => void }) {
  const none = useRef<HTMLElement>(null);
  const on = useShortcutsOn();
  return (
    <Dialog
      title="Keys for open documents"
      returnFocus={none}
      onClose={props.onClose}
      closeLabel="Done"
      closePrimary
    >
      <dl className="keys-list">
        <dt>
          <kbd>Esc</kbd>
        </dt>
        <dd>Minimise the open document you are in, or, from the tray, the one in front</dd>
        <dt>
          <kbd>]</kbd> or <kbd>Alt</kbd>+<kbd>↓</kbd>
        </dt>
        <dd>The next open document</dd>
        <dt>
          <kbd>[</kbd> or <kbd>Alt</kbd>+<kbd>↑</kbd>
        </dt>
        <dd>The previous open document</dd>
        <dt>
          <kbd>Delete</kbd>
        </dt>
        <dd>On a tray icon: close that document</dd>
        <dt>Side by side</dt>
        <dd>
          Esc minimises the one you are in; a document opened from the list takes the place of the
          one used last, marked by a green line
        </dd>
        <dt>
          <kbd>?</kbd>
        </dt>
        <dd>This list</dd>
      </dl>
      {!on && (
        <p className="muted">
          The keys of one character, ] [ and ?, are turned off on this device in Settings.
        </p>
      )}
    </Dialog>
  );
}

type GlyphName =
  'close' | 'minimise' | 'page' | 'panel' | 'file' | 'stack' | 'columns' | 'together' | 'single';

const GLYPHS: Record<GlyphName, ReactNode> = {
  close: <path d="m6 6 12 12M18 6 6 18" />,
  minimise: <path d="M6 17h12" />,
  page: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4l-8 8" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </>
  ),
  panel: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M9.5 4.5v15" />
    </>
  ),
  file: (
    <>
      <path d="M6.5 3.5h7.5l4.5 4.5v12.5h-12z" />
      <path d="M14 3.5V8h4.5" />
    </>
  ),
  stack: (
    <>
      <path d="M8.5 6.5h7l4 4v10h-11z" />
      <path d="M5.5 17.5v-14h7" />
    </>
  ),
  columns: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M12 4.5v15" />
    </>
  ),
  together: (
    <>
      <path d="M8 4v16M16 4v16" />
      <path d="m5 17 3 3 3-3M13 17l3 3 3-3" />
    </>
  ),
  single: <rect x="5.5" y="4.5" width="13" height="15" rx="2" />,
};

function Glyph({ name, size = 20 }: { name: GlyphName; size?: number }) {
  return (
    <svg
      className="icon"
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {GLYPHS[name]}
    </svg>
  );
}
