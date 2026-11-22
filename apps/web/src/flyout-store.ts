/**
 * The documents open beside the list (flyouts): which, in what order, and
 * how each is — shown, minimised to the tray, or freed (its content
 * dropped, its tray icon kept, opened again when chosen). Plain data and
 * plain functions, each returning a new set: the shell's FlyoutProvider
 * (flyout-context.tsx) holds the set and draws it.
 *
 * From 1,100 px wide two or three may be shown side by side (`side`, left
 * to right), one of them the pane used last (`last`), which a document
 * opened from the list replaces; the one replaced goes to the tray,
 * minimised. Narrower, one at a time.
 *
 * Kept for this tab only (sessionStorage), under the person signed in, and
 * only what is needed to put the tray back after a reload: each document's
 * id and whether its details were hidden, which one was in front, and which
 * were side by side, in their order. Never a title, never anything of its
 * content. After a reload every one is freed but the one in front, or those
 * side by side, which open again.
 */

export type FlyoutState = 'shown' | 'min' | 'freed';
/** Both panes, or its pages alone (Hide details). */
export type FlyoutView = 'both' | 'content';

export interface FlyoutItem {
  id: string;
  state: FlyoutState;
  view: FlyoutView;
  /** When it was minimised; null unless it is. */
  minimisedAt: number | null;
}

/** The open documents, in the order they were opened: the tray's order. */
export interface FlyoutSet {
  items: readonly FlyoutItem[];
  /**
   * Side by side: the documents shown next to each other, left to right,
   * two or three, every one of them shown; none when one is shown at a time.
   */
  side: readonly string[];
  /** Side by side: the pane used last, which a document opened from the list replaces. */
  last: string | null;
}

export const EMPTY_FLYOUTS: FlyoutSet = { items: [], side: [], last: null };

/** The most open at once: every tray icon counts, freed ones and those side by side too. */
export const MAX_OPEN = 10;
/** From this many open, a warning that many open documents slow the vault down. */
export const WARN_FROM = 8;
/** Minimised this long, a document is freed. */
export const FREE_AFTER_MS = 15 * 60_000;
/** How often the minimised ones are looked at (and whenever the tab is shown or hidden). */
export const SWEEP_EVERY_MS = 30_000;
/** The most side by side. */
export const MAX_SIDE = 3;
/** Side by side is offered from this wide (the window); narrower, one at a time. */
export const SIDE_BY_SIDE_FROM = 1100;
/** A third is offered only when each of three panes would be at least this wide. */
export const SIDE_PANE_MIN = 300;
/**
 * How much of the list stays in sight at the left of those side by side,
 * and the tray's width: styles.css's --list-peek and --tray-now, the same
 * numbers (flyout-store.test.ts holds the stylesheet to them).
 */
export const LIST_PEEK = 240;
export const TRAY_WIDTH = 76;

/**
 * The room those side by side share: the window, less the sidebar (as wide
 * as the shell says, --side-w), the tray and the list kept in sight — as
 * styles.css's --side-room works it out.
 */
export function sideRoom(): number {
  const shell =
    typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('.shell');
  const side = Number.parseFloat(shell?.style.getPropertyValue('--side-w') ?? '') || 216;
  return window.innerWidth - side - TRAY_WIDTH - LIST_PEEK;
}

/**
 * The one beside the list, alone, can be made wider or narrower by its
 * edge facing the list (0.9.0-dev.88). Never narrower than PANE_MIN, where
 * a document's view is still a phone's, and never wider than the room
 * that keeps LIST_PEEK of the list in sight — or, where the window is too
 * narrow for that, than it is to start with (`paneDefault`), so nothing
 * jumps. ← and → move it PANE_STEP (Shift: four times as far). The
 * stylesheet works it out with the same numbers (.flyout's --pane-w).
 */
export const PANE_MIN = 360;
export const PANE_STEP = 16;

/** Its width to start with, as styles.css has always had it: min(100vw − tray, clamp(720, 62vw, 1100)). */
export function paneDefault(viewport: number): number {
  return Math.min(viewport - TRAY_WIDTH, Math.min(1100, Math.max(720, viewport * 0.62)));
}

export interface PaneBounds {
  min: number;
  max: number;
  /** Its width with nothing chosen. */
  start: number;
}

/**
 * In a window `viewport` wide whose page starts `pageStart` from its left
 * (the sidebar, or its rail, or nothing on a phone's layout).
 */
export function paneBounds(viewport: number, pageStart: number): PaneBounds {
  const start = Math.round(paneDefault(viewport));
  const room = Math.floor(viewport - pageStart - TRAY_WIDTH - LIST_PEEK);
  return { min: PANE_MIN, max: Math.max(PANE_MIN, room, start), start };
}

export function clampPane(px: number, bounds: PaneBounds): number {
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, px)));
}

/** How many may be side by side in `room`: three when each would have SIDE_PANE_MIN, else two. */
export function mostSideBySide(room: number): 2 | 3 {
  return room / 3 >= SIDE_PANE_MIN ? 3 : 2;
}

/** Side by side: two or three shown next to each other. */
export function isSideBySide(set: FlyoutSet): boolean {
  return set.side.length >= 2;
}

/** The document in front: the one shown, or, side by side, the pane used last. */
export function frontOf(set: FlyoutSet): string | null {
  if (isSideBySide(set)) return set.last ?? set.side[set.side.length - 1] ?? null;
  for (let i = set.items.length - 1; i >= 0; i--) {
    const it = set.items[i];
    if (it?.state === 'shown') return it.id;
  }
  return null;
}

export function itemOf(set: FlyoutSet, id: string): FlyoutItem | null {
  return set.items.find((it) => it.id === id) ?? null;
}

const ONE_AT_A_TIME = { side: [], last: null } as const;

/** Shown, its clock stopped. */
const shownItem = (it: FlyoutItem): FlyoutItem => ({ ...it, state: 'shown', minimisedAt: null });
/** To the tray, its clock started now. */
const minItem = (it: FlyoutItem, now: number): FlyoutItem => ({
  ...it,
  state: 'min',
  minimisedAt: now,
});
/** Opened now: shown, its details too. */
const newItem = (id: string): FlyoutItem => ({
  id,
  state: 'shown',
  view: 'both',
  minimisedAt: null,
});

/**
 * Side by side, `id` takes the place of the pane used last, which goes to
 * the tray, minimised now; `id` is the pane used last then. `id` is open
 * already, or `extra` adds it at the end of the tray.
 */
function replacedIn(set: FlyoutSet, id: string, now: number, extra?: FlyoutItem): FlyoutSet {
  const out = frontOf(set);
  const at = out === null ? -1 : set.side.indexOf(out);
  const items = set.items.map((it) =>
    it.id === id ? shownItem(it) : it.id === out ? minItem(it, now) : it,
  );
  return {
    items: extra ? [...items, extra] : items,
    side: set.side.map((s, i) => (i === at ? id : s)),
    last: id,
  };
}

/** Side by side, the pane used last is this one (the focus went into it). The same set otherwise. */
export function usedIn(set: FlyoutSet, id: string): FlyoutSet {
  if (!isSideBySide(set) || set.last === id || !set.side.includes(id)) return set;
  return { ...set, last: id };
}

/**
 * Brings one to the front (shown), opening it again if it was freed; the
 * one in front before it goes to the tray, minimised now. Side by side, one
 * of them becomes the pane used last, and any other takes the place of the
 * pane used last.
 */
export function shownIn(set: FlyoutSet, id: string, now: number): FlyoutSet {
  if (!itemOf(set, id)) return set;
  if (isSideBySide(set)) {
    return set.side.includes(id) ? usedIn(set, id) : replacedIn(set, id, now);
  }
  return {
    items: set.items.map((it) =>
      it.id === id ? shownItem(it) : it.state === 'shown' ? minItem(it, now) : it,
    ),
    ...ONE_AT_A_TIME,
  };
}

export type Opened = { set: FlyoutSet; added: boolean } | { full: true };

/**
 * Opens a document: one already open comes to the front; a new one goes
 * at the end of the tray, in front, its details shown — side by side, in
 * the place of the pane used last. The 11th is not opened: `full`, and the
 * caller asks which to close (`suggestions`). Every tray icon counts, those
 * side by side too.
 */
export function openedIn(set: FlyoutSet, id: string, now: number): Opened {
  if (itemOf(set, id)) return { set: shownIn(set, id, now), added: false };
  if (set.items.length >= MAX_OPEN) return { full: true };
  if (isSideBySide(set)) return { set: replacedIn(set, id, now, newItem(id)), added: true };
  const rest = set.items.map((it) => (it.state === 'shown' ? minItem(it, now) : it));
  return { set: { items: [...rest, newItem(id)], ...ONE_AT_A_TIME }, added: true };
}

/**
 * Shows `id` beside the one in front: the second of two, or a third, at
 * the right, the pane used last then. One already side by side becomes the
 * pane used last; with three already, it takes the place of the pane used
 * last. A document not yet open is opened (the 11th is not: `full`). With
 * none in front, it is opened as `openedIn` opens it.
 */
export function besideIn(set: FlyoutSet, id: string, now: number): Opened {
  const front = frontOf(set);
  // None in front to go beside: opened as any other.
  if (front === null) return openedIn(set, id, now);
  const side = isSideBySide(set) ? set.side : [front];
  if (side.includes(id)) return { set: usedIn(set, id), added: false };
  if (side.length >= MAX_SIDE) return openedIn(set, id, now);
  const known = itemOf(set, id) !== null;
  if (!known && set.items.length >= MAX_OPEN) return { full: true };
  const items = known
    ? set.items.map((it) => (it.id === id ? shownItem(it) : it))
    : [...set.items, newItem(id)];
  return { set: { items, side: [...side, id], last: id }, added: !known };
}

/**
 * Back to one at a time (One at a time, or a window narrower than
 * SIDE_BY_SIDE_FROM): the pane used last stays; the others go to the tray,
 * minimised now, their 15 minutes started then.
 */
export function oneAtATimeIn(set: FlyoutSet, now: number): FlyoutSet {
  if (!isSideBySide(set)) return set;
  const keep = frontOf(set);
  return {
    items: set.items.map((it) =>
      it.id !== keep && set.side.includes(it.id) ? minItem(it, now) : it,
    ),
    ...ONE_AT_A_TIME,
  };
}

/**
 * No more than `most` side by side (the window narrowed): those over go to
 * the tray, minimised now, from the left, never the pane used last.
 */
export function fewerIn(set: FlyoutSet, most: number, now: number): FlyoutSet {
  if (set.side.length <= most) return set;
  if (most < 2) return oneAtATimeIn(set, now);
  const last = frontOf(set);
  const over = set.side.filter((id) => id !== last).slice(0, set.side.length - most);
  return {
    items: set.items.map((it) => (over.includes(it.id) ? minItem(it, now) : it)),
    side: set.side.filter((id) => !over.includes(id)),
    last,
  };
}

/** Moving to another page: every one shown goes to the tray, minimised now; none side by side. */
export function trayedIn(set: FlyoutSet, now: number): FlyoutSet {
  if (!set.items.some((it) => it.state === 'shown')) return set;
  return {
    items: set.items.map((it) => (it.state === 'shown' ? minItem(it, now) : it)),
    ...ONE_AT_A_TIME,
  };
}

/**
 * `id` leaves side by side (minimised or closed): the others stay where
 * they are, and one left alone is shown one at a time. The pane used last,
 * if it was `id`, is the one now in its place (or the one before it).
 */
function leftSide(set: FlyoutSet, items: readonly FlyoutItem[], id: string): FlyoutSet {
  const at = set.side.indexOf(id);
  if (at < 0) return { ...set, items };
  const side = set.side.filter((s) => s !== id);
  if (side.length < 2) return { items, ...ONE_AT_A_TIME };
  const last = set.last === id || set.last === null ? (side[at] ?? side[at - 1] ?? null) : set.last;
  return { items, side, last };
}

/** To the tray: kept as it is, out of sight, its clock started. Side by side, the others stay. */
export function minimisedIn(set: FlyoutSet, id: string, now: number): FlyoutSet {
  if (itemOf(set, id)?.state !== 'shown') return set;
  return leftSide(
    set,
    set.items.map((it) => (it.id === id ? minItem(it, now) : it)),
    id,
  );
}

export function closedIn(set: FlyoutSet, id: string): FlyoutSet {
  return leftSide(
    set,
    set.items.filter((it) => it.id !== id),
    id,
  );
}

export function withView(set: FlyoutSet, id: string, view: FlyoutView): FlyoutSet {
  return { ...set, items: set.items.map((it) => (it.id === id ? { ...it, view } : it)) };
}

/**
 * Frees what has been minimised for FREE_AFTER_MS or more: its content is
 * dropped, its tray icon stays. Never one shown, side by side or not. The
 * same set when nothing is due.
 */
export function sweptIn(set: FlyoutSet, now: number): { set: FlyoutSet; freed: string[] } {
  const freed = set.items
    .filter(
      (it) =>
        it.state === 'min' && it.minimisedAt !== null && now - it.minimisedAt >= FREE_AFTER_MS,
    )
    .map((it) => it.id);
  if (freed.length === 0) return { set, freed };
  return {
    set: {
      ...set,
      items: set.items.map((it) =>
        freed.includes(it.id) ? { ...it, state: 'freed', minimisedAt: null } : it,
      ),
    },
    freed,
  };
}

/**
 * Which to close, best first, when the 11th is asked for: the freed ones
 * (in the tray's order), then the minimised ones (longest in the tray
 * first), then those shown.
 */
export function suggestions(set: FlyoutSet): FlyoutItem[] {
  const rank: Record<FlyoutState, number> = { freed: 0, min: 1, shown: 2 };
  return set.items
    .map((it, at) => ({ it, at }))
    .sort(
      (a, b) =>
        rank[a.it.state] - rank[b.it.state] ||
        (a.it.minimisedAt ?? 0) - (b.it.minimisedAt ?? 0) ||
        a.at - b.at,
    )
    .map(({ it }) => it);
}

/** The next (1) or previous (-1) open document from the one in front, round from the end. */
export function neighbourIn(set: FlyoutSet, dir: 1 | -1): string | null {
  const n = set.items.length;
  if (n === 0) return null;
  const front = frontOf(set);
  const at = front === null ? -1 : set.items.findIndex((it) => it.id === front);
  const to = at < 0 ? (dir > 0 ? 0 : n - 1) : (at + dir + n) % n;
  return set.items[to]?.id ?? null;
}

// ------------------------------------------------------------- storage

const PREFIX = 'fdv.flyouts.';
export const flyoutsKey = (memberId: string) => `${PREFIX}${memberId}`;

/** A document's id as the vault gives one: nothing else is taken back from storage. */
const ID = /^[A-Za-z0-9-]{1,64}$/;

interface Stored {
  items: Array<{ id: string; view: FlyoutView }>;
  /** The one in front: side by side, the pane used last. */
  front: string | null;
  /** Side by side, left to right; left out when one is shown at a time. */
  side?: string[];
}

export function toStored(set: FlyoutSet): Stored {
  return {
    items: set.items.map((it) => ({ id: it.id, view: it.view })),
    front: frontOf(set),
    ...(isSideBySide(set) ? { side: [...set.side] } : {}),
  };
}

/**
 * What was kept, as tray icons: all freed but the one in front, which opens
 * again — or those side by side, in their order, up to `most` of them (as
 * many as the window has room for: none below 1,100 px, then the one in
 * front alone), the pane used last always among them.
 */
export function fromStored(raw: unknown, most: number = MAX_SIDE): FlyoutSet {
  if (typeof raw !== 'object' || raw === null) return EMPTY_FLYOUTS;
  const kept = raw as { items?: unknown; front?: unknown; side?: unknown };
  if (!Array.isArray(kept.items)) return EMPTY_FLYOUTS;
  const seen = new Set<string>();
  const items: FlyoutItem[] = [];
  for (const one of kept.items as unknown[]) {
    if (typeof one !== 'object' || one === null) continue;
    const { id, view } = one as { id?: unknown; view?: unknown };
    if (typeof id !== 'string' || !ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    items.push({
      id,
      state: id === kept.front ? 'shown' : 'freed',
      view: view === 'content' ? 'content' : 'both',
      minimisedAt: null,
    });
    if (items.length === MAX_OPEN) break;
  }
  const all = keptSide(kept.side, seen);
  const front = typeof kept.front === 'string' && all.includes(kept.front) ? kept.front : null;
  const lastOne = front ?? all[all.length - 1] ?? null;
  // Too many for the window: those over, from the left, freed with the rest.
  const over = all.filter((id) => id !== lastOne).slice(0, Math.max(0, all.length - most));
  const side = most < 2 ? [] : all.filter((id) => !over.includes(id));
  if (side.length < 2) return { items, ...ONE_AT_A_TIME };
  const last = lastOne;
  return {
    items: items.map((it) =>
      side.includes(it.id)
        ? shownItem(it)
        : it.state === 'shown'
          ? { ...it, state: 'freed' as const }
          : it,
    ),
    side,
    last: last ?? side[side.length - 1] ?? null,
  };
}

/** Those kept side by side, if they are two or three of those taken back, each once; else none. */
function keptSide(raw: unknown, open: ReadonlySet<string>): string[] {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_SIDE) return [];
  const side: string[] = [];
  for (const id of raw as unknown[]) {
    if (typeof id !== 'string' || !open.has(id) || side.includes(id)) return [];
    side.push(id);
  }
  return side;
}

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * This person's open documents in this tab, as tray icons (`fromStored`);
 * up to `most` side by side (as many as the window has room for).
 */
export function readFlyouts(memberId: string | null, most: number = MAX_SIDE): FlyoutSet {
  if (!memberId) return EMPTY_FLYOUTS;
  try {
    const raw = storage()?.getItem(flyoutsKey(memberId));
    return raw ? fromStored(JSON.parse(raw), most) : EMPTY_FLYOUTS;
  } catch {
    return EMPTY_FLYOUTS;
  }
}

export function keepFlyouts(memberId: string | null, set: FlyoutSet): void {
  if (!memberId) return;
  try {
    const s = storage();
    if (!s) return;
    if (set.items.length === 0) s.removeItem(flyoutsKey(memberId));
    else s.setItem(flyoutsKey(memberId), JSON.stringify(toStored(set)));
  } catch {
    // Full, or blocked: the tray is not put back after a reload.
  }
}

/**
 * The vault locked (0.9.0-dev.86): every document beside the list is freed
 * as the page it was drawn on goes. What is kept to put the tray back once
 * it is unlocked: the one in front, which opens again, and the rest as tray
 * icons — never those side by side, which would all open again with it.
 */
export function lockedFlyouts(memberId: string | null): void {
  if (!memberId) return;
  try {
    const s = storage();
    const raw = s?.getItem(flyoutsKey(memberId));
    if (!s || !raw) return;
    const kept = JSON.parse(raw) as { items?: unknown; front?: unknown };
    s.setItem(flyoutsKey(memberId), JSON.stringify({ items: kept.items, front: kept.front }));
  } catch {
    // Nothing kept, or nothing to keep it in.
  }
}

/** Every person's kept open documents in this tab: at a sign-out, a session's end and a new sign-in. */
export function forgetFlyouts(): void {
  try {
    const s = storage();
    if (!s) return;
    const mine: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const key = s.key(i);
      if (key?.startsWith(PREFIX)) mine.push(key);
    }
    for (const key of mine) s.removeItem(key);
  } catch {
    // Nothing kept, or nothing to keep it in.
  }
}

// ------------------------------------------------- the width chosen, kept

/**
 * The width chosen for the one beside the list, kept in this browser
 * (localStorage) for the person signed in: the number alone, nothing of any
 * document. Side by side forgets it (`keepPaneWidth(…, null)`).
 */
const WIDTH_PREFIX = 'fdv.flyout-width.';
export const paneWidthKey = (memberId: string) => `${WIDTH_PREFIX}${memberId}`;

function widthStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The width this person chose in this browser, or null for the one it starts with. */
export function readPaneWidth(memberId: string | null): number | null {
  if (!memberId) return null;
  try {
    const raw = widthStorage()?.getItem(paneWidthKey(memberId));
    const n = raw === null || raw === undefined || raw.trim() === '' ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 && n < 100_000 ? Math.round(n) : null;
  } catch {
    return null;
  }
}

export function keepPaneWidth(memberId: string | null, width: number | null): void {
  if (!memberId) return;
  try {
    const s = widthStorage();
    if (!s) return;
    if (width === null) s.removeItem(paneWidthKey(memberId));
    else s.setItem(paneWidthKey(memberId), String(Math.round(width)));
  } catch {
    // Blocked, or full: the width holds until the page is loaded again.
  }
}
