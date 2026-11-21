import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useApp } from './app-context.js';
import {
  besideIn,
  closedIn,
  EMPTY_FLYOUTS,
  fewerIn,
  frontOf,
  isSideBySide,
  itemOf,
  keepFlyouts,
  minimisedIn,
  mostSideBySide,
  neighbourIn,
  oneAtATimeIn,
  openedIn,
  readFlyouts,
  shownIn,
  SIDE_BY_SIDE_FROM,
  sideRoom,
  sweptIn,
  SWEEP_EVERY_MS,
  trayedIn,
  usedIn,
  WARN_FROM,
  withView,
  type FlyoutSet,
  type FlyoutView,
} from './flyout-store.js';
import type { DocumentViewLoaded } from './screens/Document.js';

/**
 * The documents open beside the list (flyouts), for the whole of a
 * sign-in: held by the shell, so the tray stays as the person moves between
 * Home, Documents, the cabinet and a person's documents. The shell's
 * FlyoutDesk (flyouts.tsx) draws them; a list's rows open them
 * (`useOpenDocument`).
 *
 * Kept in this tab (sessionStorage, flyout-store.ts) for whoever is signed
 * in, so a reload puts the tray back: the one in front opens again, the
 * rest come back freed. A sign-out, a session's end and anybody else
 * signing in forget them (session.ts).
 *
 * From 1,100 px wide two or three can be shown side by side; a document
 * opened from the list then replaces the pane used last. Narrower, side by
 * side is not offered, and a set side by side goes back to one at a time.
 */

/** What a list's row tells, opening a document. */
export interface OpenAsk {
  /** Its name, for the tray until the document itself is loaded. */
  title?: string | null;
  /** What opened it: the focus goes back there as it is minimised or closed. */
  from?: HTMLElement | null;
  /**
   * Told when it goes on to its own page from beside the list (Open as a
   * page), and only then: the list it was opened from, for Back to find
   * its row.
   */
  toPage?: (() => void) | undefined;
  /** Shown beside the one in front, rather than in its place (Side by side). */
  beside?: boolean | undefined;
}

/** How a document was closed, which says where the focus goes. */
export type CloseHow =
  /** Its own ×, or its view had nothing more to show: back to what opened it. */
  | 'pane'
  /** From the tray (its × or Delete): the focus stays in the tray. */
  | 'tray'
  /** Nothing moves the focus. */
  | 'quiet';

export interface Flyouts {
  set: FlyoutSet;
  /** Each open document's name, as known. */
  titles: ReadonlyMap<string, string>;
  /** Narrower than 700 px: one at a time across the screen, and "N open" for the tray. */
  narrow: boolean;
  /** From 1,100 px wide: two can be shown side by side. */
  sideOk: boolean;
  /** And a third, where each of three would be at least SIDE_PANE_MIN wide. */
  thirdOk: boolean;
  open: (id: string, ask?: OpenAsk) => void;
  /** Shown beside the one in front: the second, or a third (one open, or from the list). */
  beside: (id: string) => void;
  /** Side by side no more: the pane used last stays, the others go to the tray. */
  oneAtATime: () => void;
  /** Side by side, the focus went into this pane: it is the one used last. */
  use: (id: string) => void;
  /** Waiting for a document clicked in the list, to show beside the one in front. */
  picking: boolean;
  pickFromList: () => void;
  cancelPick: () => void;
  /** To the front: from the tray, or the keys. A freed one opens again. */
  show: (id: string) => void;
  minimise: (id: string) => void;
  close: (id: string, how?: CloseHow) => void;
  closeAll: () => void;
  setView: (id: string, view: FlyoutView) => void;
  /**
   * What a document's view loaded: its name, whether it is in the Trash
   * (closed), and whether it changed since (the lists under it are told).
   */
  loaded: (id: string, loaded: DocumentViewLoaded) => void;
  /** Moved to the Trash beside the list: closed, said, and gone from the lists at once. */
  trashed: (id: string, said: string) => void;
  /**
   * What changed beside the list, for the lists under it: `n` counts the
   * changes, `gone` the documents moved to the Trash from there (left out
   * of a list at once, before it is loaded again).
   */
  changes: { n: number; gone: ReadonlySet<string> };
  /** The next (1) or the previous (-1) open document, to the front. */
  step: (dir: 1 | -1) => void;
  /** Said in the live region. */
  said: { text: string; n: number } | null;
  say: (text: string) => void;
  /** The 11th asked for: which to close first. */
  limit: { want: string; title: string | null } | null;
  /** One closed to make room: then the document asked for opens. */
  makeRoom: (id: string) => void;
  /** Open as a page: what opened it is told, and it leaves the tray. */
  asPage: (id: string) => void;
  cancelLimit: () => void;
  /** From the 8th open: that many open slow the vault down, until put away. */
  warning: boolean;
  dismissWarning: () => void;
}

const FlyoutContext = createContext<Flyouts | null>(null);

/** The open documents, inside the shell; null elsewhere (a screen drawn on its own, in a test). */
export function useFlyouts(): Flyouts | null {
  return useContext(FlyoutContext);
}

/** Below this wide, a document beside the list covers the screen. */
const WIDE_ENOUGH = '(min-width: 700px)';
/** From this wide, two or three side by side. */
const SIDE_BY_SIDE = `(min-width: ${SIDE_BY_SIDE_FROM}px)`;

function watchQuery(query: string, changed: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const list = window.matchMedia(query);
  list.addEventListener('change', changed);
  return () => list.removeEventListener('change', changed);
}

const watchWidth = (changed: () => void) => watchQuery(WIDE_ENOUGH, changed);
const watchSideWidth = (changed: () => void) => watchQuery(SIDE_BY_SIDE, changed);

/** At least 1,100 px wide (with no media queries, as in jsdom, never). */
function readSideBySide(): boolean {
  if (typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(SIDE_BY_SIDE).matches;
}

/** Wide enough for two or three side by side. */
export function useSideBySideWidth(): boolean {
  return useSyncExternalStore(watchSideWidth, readSideBySide, () => false);
}

/**
 * The room side by side changes with the window, and with the sidebar
 * (dragged or folded), which the shell says in its own --side-w.
 */
function watchRoom(changed: () => void): () => void {
  window.addEventListener('resize', changed);
  const shell = document.querySelector('.shell');
  const watching = shell ? new MutationObserver(() => changed()) : null;
  if (shell) watching?.observe(shell, { attributes: true, attributeFilter: ['style'] });
  return () => {
    window.removeEventListener('resize', changed);
    watching?.disconnect();
  };
}

const readMost = () => mostSideBySide(sideRoom());

/** How many side by side the room takes: three when each of three has SIDE_PANE_MIN, else two. */
function useMostSideBySide(): 2 | 3 {
  return useSyncExternalStore(watchRoom, readMost, () => 2);
}

/** Narrower than 700 px (with no media queries, as in jsdom, a phone's). */
function readNarrow(): boolean {
  if (typeof window.matchMedia !== 'function') return true;
  return !window.matchMedia(WIDE_ENOUGH).matches;
}

export function useNarrowFlyouts(): boolean {
  return useSyncExternalStore(watchWidth, readNarrow, () => true);
}

const quoted = (title: string | undefined) => (title ? `“${title}”` : 'The document');

/** The heading of a document beside the list, which opening it focuses. */
function headingOf(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-flyout="${id}"] .doc-flyout-title`);
}

/** Its icon in the tray, or its row in the "N open" list. */
function trayIconOf(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-tray="${id}"]`);
}

/** The page's own heading: where the focus goes when nothing else will take it. */
function pageHeading(): HTMLElement | null {
  const box = document.getElementById('main-content');
  const h = box?.querySelector<HTMLElement>('h1') ?? box?.querySelector<HTMLElement>('main');
  // Able to take the focus while it has it, and no longer: as it was after.
  if (h && !h.hasAttribute('tabindex')) {
    h.setAttribute('tabindex', '-1');
    h.addEventListener('blur', () => h.removeAttribute('tabindex'), { once: true });
  }
  return h ?? null;
}

function focusFirst(...to: Array<HTMLElement | null | undefined>): void {
  for (const el of to) {
    if (!el || !el.isConnected) continue;
    el.focus();
    if (document.activeElement === el) return;
  }
}

export function FlyoutProvider(props: { memberId: string | null; children: ReactNode }) {
  const { memberId } = props;
  const { session } = useApp();
  const narrow = useNarrowFlyouts();
  const sideOk = useSideBySideWidth() && !narrow;
  // How many side by side: none below 1,100 px, then two, and three where
  // each of three has room enough.
  const room = useMostSideBySide();
  const most = sideOk ? room : 0;
  // Side by side comes back only as far as it is offered: narrower, the one
  // in front alone, the others freed, as one at a time.
  const [set, setSet] = useState<FlyoutSet>(() => readFlyouts(memberId, most));
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(() => new Map());
  // Waiting for a document clicked in the list, to show beside the one in front.
  const [pickingNow, setPickingNow] = useState(false);
  const picking = useRef(false);
  const setPicking = useCallback((on: boolean) => {
    picking.current = on;
    setPickingNow(on);
  }, []);
  const [said, setSaid] = useState<{ text: string; n: number } | null>(null);
  const [limit, setLimit] = useState<{ want: string; title: string | null } | null>(null);
  const [warning, setWarning] = useState(false);
  const [changes, setChanges] = useState<{ n: number; gone: ReadonlySet<string> }>(() => ({
    n: 0,
    gone: new Set(),
  }));
  // Each one's stamp as last loaded: a new one is a change.
  const stamps = useRef(new Map<string, string>());
  // The latest set, for what is done between renders (a key, the clock).
  const current = useRef(set);
  // What opened each document, for the focus to go back to.
  const openers = useRef(new Map<string, HTMLElement>());
  // And what each would be told, going on to its own page.
  const pageHooks = useRef(new Map<string, () => void>());
  // What opens once the 11th's room is made: what opened it.
  const wanted = useRef<OpenAsk>({});
  // Where the focus goes once what was changed is drawn.
  const focusNext = useRef<(() => void) | null>(null);

  // Somebody else signed in, in this tab: theirs, never the last person's.
  const [who, setWho] = useState(memberId);
  if (who !== memberId) {
    setWho(memberId);
    setSet(readFlyouts(memberId, most));
    setTitles(new Map());
    setPickingNow(false);
    setLimit(null);
    setWarning(false);
    // Nothing of the last person's is said to the next.
    setSaid(null);
    setChanges({ n: 0, gone: new Set() });
  }
  // The window narrowed: three side by side go back to two, and below
  // 1,100 px a set side by side goes back to one at a time, the pane used
  // last staying.
  const [mostWas, setMostWas] = useState(most);
  if (mostWas !== most) {
    setMostWas(most);
    if (most < mostWas) {
      if (most < 2) setPickingNow(false);
      setSet((was) => fewerIn(was, most, Date.now()));
    }
  }
  // The names, for what is said between renders; and how many side by side.
  const named = useRef(titles);
  const mostNow = useRef(most);
  useLayoutEffect(() => {
    current.current = set;
    named.current = titles;
    picking.current = pickingNow;
    mostNow.current = most;
  });
  useEffect(() => {
    const kept = [openers.current, pageHooks.current, stamps.current];
    return () => {
      for (const one of kept) one.clear();
      wanted.current = {};
    };
  }, [who]);

  // Every document minimised stays as it was until it is freed after 15
  // minutes, a Sensitive one too: the Sensitive mark alone never asks
  // before opening, and anything asking "Confirm it's you" (Only me, an
  // Essential) asks again once freed, the step-up window being far shorter.
  const commit = useCallback((next: FlyoutSet) => {
    current.current = next;
    setSet(next);
    // Nothing in front (minimised, closed, in the Trash): nothing to choose
    // a document from the list to go beside.
    if (frontOf(next) === null && picking.current) {
      picking.current = false;
      setPickingNow(false);
    }
  }, []);

  const say = useCallback((text: string) => {
    setSaid((was) => ({ text, n: (was?.n ?? 0) + 1 }));
  }, []);

  useEffect(() => {
    // Never once signed out: what is kept is the signed-in person's alone.
    if (session.info?.member_id !== who) return;
    keepFlyouts(who, set);
  }, [who, set, session]);

  // The focus, once the change is drawn: after a dialog that closed has
  // given the focus back where it came from.
  useEffect(() => {
    const f = focusNext.current;
    focusNext.current = null;
    f?.();
  });

  /** Back to what opened it, else its tray icon (or "N open"), else the page's heading. */
  const backFrom = useCallback((id: string, keepTray: boolean) => {
    const opener = openers.current.get(id);
    const row = document.querySelector<HTMLElement>(
      `tr[data-id="${id}"] .cell-title, [data-doc="${id}"] .rowbtn`,
    );
    focusFirst(
      opener,
      row,
      keepTray ? trayIconOf(id) : null,
      document.querySelector<HTMLElement>('[data-flyouts-pill]'),
      pageHeading(),
    );
  }, []);

  const name = useCallback((id: string, title: string | null | undefined) => {
    if (!title) return;
    setTitles((was) => (was.get(id) === title ? was : new Map(was).set(id, title)));
  }, []);

  const show = useCallback(
    (id: string) => {
      if (!itemOf(current.current, id)) return;
      commit(shownIn(current.current, id, Date.now()));
      focusNext.current = () => focusFirst(headingOf(id));
    },
    [commit],
  );

  const open = useCallback(
    (id: string, ask: OpenAsk = {}) => {
      name(id, ask.title);
      const before = current.current;
      // Chosen from the list for Side by side: beside the one in front, if
      // one is, and as long as there is room for one more.
      const beside =
        (ask.beside === true || picking.current) &&
        frontOf(before) !== null &&
        (isSideBySide(before) ? before.side.length : 1) < mostNow.current;
      const done = beside ? besideIn(before, id, Date.now()) : openedIn(before, id, Date.now());
      if ('full' in done) {
        wanted.current = { from: ask.from ?? null, toPage: ask.toPage, beside };
        setLimit({ want: id, title: ask.title ?? null });
        return;
      }
      // The one showing chosen again: still waiting for another.
      if (picking.current && (!beside || isSideBySide(done.set))) setPicking(false);
      if (ask.from) openers.current.set(id, ask.from);
      if (ask.toPage) pageHooks.current.set(id, ask.toPage);
      else pageHooks.current.delete(id);
      commit(done.set);
      focusNext.current = () => focusFirst(headingOf(id));
      const title = ask.title ?? named.current.get(id);
      const out = frontOf(before);
      if (beside && !isSideBySide(done.set)) {
        say(`${quoted(title ?? undefined)} is the one showing: choose another to go beside it.`);
      } else if (beside && !before.side.includes(id)) {
        say(`${quoted(title ?? undefined)} shown side by side.`);
      } else if (isSideBySide(before) && out && !before.side.includes(id)) {
        // In the place of the pane used last, which goes to the tray.
        say(
          `${quoted(title ?? undefined)} replaced ${quoted(named.current.get(out))}, which is minimised to the tray.`,
        );
      }
      const n = done.set.items.length;
      if (done.added && n >= WARN_FROM) {
        setWarning(true);
        say(
          `${n} documents open. Many open documents slow the vault down: close the ones you’ve finished with.`,
        );
      }
    },
    [commit, name, say, setPicking],
  );

  const beside = useCallback((id: string) => open(id, { beside: true }), [open]);

  const oneAtATime = useCallback(() => {
    const before = current.current;
    if (!isSideBySide(before)) return;
    const keep = frontOf(before);
    commit(oneAtATimeIn(before, Date.now()));
    setPicking(false);
    say('One at a time: the others are minimised to the tray.');
    if (keep) focusNext.current = () => focusFirst(headingOf(keep));
  }, [commit, say, setPicking]);

  const use = useCallback(
    (id: string) => {
      const next = usedIn(current.current, id);
      if (next !== current.current) commit(next);
    },
    [commit],
  );

  const pickFromList = useCallback(() => {
    const front = frontOf(current.current);
    if (!front) return;
    setPicking(true);
    say(
      `Choose a document in the list to show beside ${quoted(named.current.get(front))}. Esc cancels.`,
    );
    focusNext.current = () => focusFirst(pageHeading());
  }, [say, setPicking]);

  const cancelPick = useCallback(() => {
    if (!picking.current) return;
    setPicking(false);
    const front = frontOf(current.current);
    say('Side by side cancelled.');
    if (front) focusNext.current = () => focusFirst(headingOf(front));
  }, [say, setPicking]);

  /**
   * After one left side by side (minimised or closed), the focus goes to
   * the pane used last now, still in sight; else `otherwise`.
   */
  const afterLeaving = useCallback(
    (before: FlyoutSet, id: string, otherwise: () => void): (() => void) => {
      const still = frontOf(current.current);
      if (before.side.includes(id) && still) return () => focusFirst(headingOf(still));
      return otherwise;
    },
    [],
  );

  const minimise = useCallback(
    (id: string) => {
      const before = current.current;
      if (itemOf(before, id)?.state !== 'shown') return;
      commit(minimisedIn(before, id, Date.now()));
      say(`${quoted(titles.get(id))} minimised to the tray.`);
      focusNext.current = afterLeaving(before, id, () => backFrom(id, true));
    },
    [afterLeaving, backFrom, commit, say, titles],
  );

  const close = useCallback(
    (id: string, how: CloseHow = 'pane') => {
      const was = current.current;
      const before = was.items.map((it) => it.id);
      const at = before.indexOf(id);
      if (at < 0) return;
      commit(closedIn(was, id));
      if (how !== 'quiet') say(`${quoted(titles.get(id))} closed.`);
      const opener = openers.current.get(id);
      openers.current.delete(id);
      if (how === 'tray') {
        const next = before[at + 1] ?? before[at - 1];
        focusNext.current = () =>
          focusFirst(
            next ? trayIconOf(next) : null,
            document.querySelector<HTMLElement>('[data-flyouts-pill]'),
            opener,
            pageHeading(),
          );
      } else if (how === 'pane') {
        focusNext.current = afterLeaving(was, id, () => {
          if (opener) openers.current.set(id, opener);
          backFrom(id, false);
          openers.current.delete(id);
        });
      }
    },
    [afterLeaving, backFrom, commit, say, titles],
  );

  const closeAll = useCallback(() => {
    const n = current.current.items.length;
    if (n === 0) return;
    commit(EMPTY_FLYOUTS);
    openers.current.clear();
    setWarning(false);
    setPicking(false);
    say(n === 1 ? 'Closed 1 document.' : `Closed ${n} documents.`);
    focusNext.current = () => focusFirst(pageHeading());
  }, [commit, say, setPicking]);

  const setView = useCallback(
    (id: string, view: FlyoutView) => commit(withView(current.current, id, view)),
    [commit],
  );

  const step = useCallback(
    (dir: 1 | -1) => {
      const to = neighbourIn(current.current, dir);
      if (to) show(to);
    },
    [show],
  );

  const makeRoom = useCallback(
    (id: string) => {
      const ask = limit;
      if (!ask) return;
      const before = current.current;
      commit(closedIn(before, id));
      openers.current.delete(id);
      say(`${quoted(titles.get(id))} closed.`);
      setLimit(null);
      // One of those side by side closed: the new one goes beside the rest.
      const besideRest = isSideBySide(before) && before.side.includes(id);
      open(ask.want, {
        ...wanted.current,
        beside: wanted.current.beside === true || besideRest,
        title: ask.title,
      });
      wanted.current = {};
    },
    [commit, limit, open, say, titles],
  );

  const cancelLimit = useCallback(() => {
    setLimit(null);
    wanted.current = {};
    setPicking(false);
  }, [setPicking]);

  const asPage = useCallback(
    (id: string) => {
      const told = pageHooks.current.get(id);
      pageHooks.current.delete(id);
      told?.();
      close(id, 'quiet');
    },
    [close],
  );

  const changed = useCallback((id: string, gone: boolean) => {
    setChanges((was) => ({ n: was.n + 1, gone: gone ? new Set(was.gone).add(id) : was.gone }));
  }, []);

  const trashed = useCallback(
    (id: string, words: string) => {
      close(id, 'pane');
      say(words);
      changed(id, true);
    },
    [changed, close, say],
  );

  const loaded = useCallback(
    (id: string, got: DocumentViewLoaded) => {
      name(id, got.title);
      if (got.inTrash) {
        // In the Trash already (moved there elsewhere, or before a reload):
        // nothing to show beside a list.
        close(id, 'quiet');
        say(`“${got.title}” is in the Trash, so it was closed.`);
        changed(id, true);
        return;
      }
      const before = stamps.current.get(id);
      stamps.current.set(id, got.stamp);
      if (before !== undefined && before !== got.stamp) changed(id, false);
    },
    [changed, close, name, say],
  );

  // Minimised 15 minutes, freed: looked at every 30 seconds, and whenever
  // the tab is shown or hidden (a laptop waking frees what is overdue at once).
  useEffect(() => {
    const sweep = () => {
      const { set: next, freed } = sweptIn(current.current, Date.now());
      if (freed.length === 0) return;
      commit(next);
      say(
        freed.length === 1
          ? 'A document minimised for 15 minutes was freed to save memory. Its icon stays in the tray and it opens again when you choose it.'
          : `${freed.length} documents minimised for 15 minutes were freed to save memory. Their icons stay in the tray and each opens again when you choose it.`,
      );
    };
    // Those shown, side by side too, are never freed: only the minimised.
    const timer = window.setInterval(sweep, SWEEP_EVERY_MS);
    document.addEventListener('visibilitychange', sweep);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', sweep);
    };
  }, [commit, say]);

  // Moving to another page puts those shown in the tray: nothing of them
  // over the page moved to (a link inside one, a section), and none side by
  // side. Moving to one of an open document's own pages (Edit, its page)
  // closes that one, as Open as a page does: the tray never keeps a copy of
  // it from before a save. What was moved to the Trash here is the lists'
  // own business again.
  const { pathname } = useLocation();
  const at = useRef(pathname);
  useLayoutEffect(() => {
    if (at.current === pathname) return;
    at.current = pathname;
    setChanges((was) => (was.gone.size === 0 ? was : { n: was.n, gone: new Set() }));
    setPicking(false);
    const own = /^\/documents\/([^/]+)/.exec(pathname)?.[1];
    if (own && itemOf(current.current, own)) {
      pageHooks.current.delete(own);
      close(own, 'quiet');
    }
    commit(trayedIn(current.current, Date.now()));
  }, [pathname, commit, close, setPicking]);

  // Those put back after a reload, freed, are not named until chosen: a
  // document's record read only to name its icon would be a look at it (a
  // caregiver's is recorded), and nothing of their titles is kept.

  const value: Flyouts = {
    set,
    titles,
    narrow,
    sideOk,
    thirdOk: most >= 3,
    open,
    beside,
    oneAtATime,
    use,
    picking: pickingNow && sideOk && frontOf(set) !== null,
    pickFromList,
    cancelPick,
    show,
    minimise,
    close,
    closeAll,
    setView,
    loaded,
    trashed,
    changes,
    step,
    said,
    say,
    limit,
    makeRoom,
    cancelLimit,
    asPage,
    warning: warning && set.items.length >= WARN_FROM,
    dismissWarning: () => setWarning(false),
  };
  return <FlyoutContext.Provider value={value}>{props.children}</FlyoutContext.Provider>;
}

const NOTHING_GONE: ReadonlySet<string> = new Set();

/**
 * A list under the documents beside it: loaded again (`reload`) whenever
 * something changes there — saved, or moved to the Trash — and what was
 * moved to the Trash there, to leave out at once, before that load is back.
 */
export function useChangesBeside(reload: () => unknown): ReadonlySet<string> {
  const flyouts = useFlyouts();
  const n = flyouts?.changes.n ?? 0;
  const latest = useRef(reload);
  useLayoutEffect(() => {
    latest.current = reload;
  });
  const seen = useRef(n);
  useEffect(() => {
    if (seen.current === n) return;
    seen.current = n;
    void latest.current();
  }, [n]);
  return flyouts?.changes.gone ?? NOTHING_GONE;
}

/** What a click says: a plain one opens beside the list; Ctrl, ⌘, Shift or the middle button, elsewhere. */
export interface OpenEvent {
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  currentTarget: EventTarget | null;
}

/**
 * A click of the main button with none of Ctrl, ⌘ or Shift held: Alt is
 * no reason to leave the list (on Windows, Alt and a click on a link
 * downloads it).
 */
export function plainClick(e: OpenEvent): boolean {
  return e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey;
}

/**
 * Opens a document from a list's row: beside the list (a flyout) on a
 * plain click; its own page in a new tab with Ctrl, ⌘, Shift or the middle
 * button, as a link would; its own page where there is no shell to hold it.
 */
export function useOpenDocument(): (
  id: string,
  how?: {
    title?: string | null;
    event?: OpenEvent;
    from?: HTMLElement | null;
    /** Told as it goes to its own page in this tab: at once with no shell, or by Open as a page. */
    toPage?: () => void;
  },
) => void {
  const flyouts = useFlyouts();
  const navigate = useNavigate();
  return useCallback(
    (id, how = {}) => {
      const href = `/documents/${id}`;
      const e = how.event;
      if (e && !plainClick(e)) {
        // As a link: a new tab, or with Shift a new window.
        window.open(href, '_blank', e.shiftKey ? 'noopener,popup' : 'noopener');
        return;
      }
      if (!flyouts) {
        how.toPage?.();
        void navigate(href);
        return;
      }
      const from = how.from ?? (e?.currentTarget instanceof HTMLElement ? e.currentTarget : null);
      flyouts.open(id, { title: how.title ?? null, from, toPage: how.toPage });
    },
    [flyouts, navigate],
  );
}
