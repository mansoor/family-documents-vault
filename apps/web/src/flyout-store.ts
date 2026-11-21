/**
 * The documents open beside the list (flyouts): which, in what order, and
 * how each is — shown, minimised to the tray, or freed (its content
 * dropped, its tray icon kept, opened again when chosen). Plain data and
 * plain functions, each returning a new set: the shell's FlyoutProvider
 * (flyout-context.tsx) holds the set and draws it.
 *
 * Kept for this tab only (sessionStorage), under the person signed in, and
 * only what is needed to put the tray back after a reload: each document's
 * id and whether its details were hidden, and which one was in front.
 * Never a title, never anything of its content. After a reload every one
 * is freed but the one in front, which opens again.
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
}

export const EMPTY_FLYOUTS: FlyoutSet = { items: [] };

/** The most open at once: every tray icon counts, freed ones too. */
export const MAX_OPEN = 10;
/** From this many open, a warning that many open documents slow the vault down. */
export const WARN_FROM = 8;
/** Minimised this long, a document is freed. */
export const FREE_AFTER_MS = 15 * 60_000;
/** How often the minimised ones are looked at (and whenever the tab is shown or hidden). */
export const SWEEP_EVERY_MS = 30_000;

/** The document in front: the one shown. */
export function frontOf(set: FlyoutSet): string | null {
  for (let i = set.items.length - 1; i >= 0; i--) {
    const it = set.items[i];
    if (it?.state === 'shown') return it.id;
  }
  return null;
}

export function itemOf(set: FlyoutSet, id: string): FlyoutItem | null {
  return set.items.find((it) => it.id === id) ?? null;
}

/**
 * Brings one to the front (shown), opening it again if it was freed; the
 * one in front before it goes to the tray, minimised now.
 */
export function shownIn(set: FlyoutSet, id: string, now: number): FlyoutSet {
  if (!itemOf(set, id)) return set;
  return {
    items: set.items.map((it) =>
      it.id === id
        ? { ...it, state: 'shown', minimisedAt: null }
        : it.state === 'shown'
          ? { ...it, state: 'min', minimisedAt: now }
          : it,
    ),
  };
}

/**
 * Opens a document: one already open comes to the front; a new one goes
 * at the end of the tray, in front, its details shown. The 11th is not
 * opened: `full`, and the caller asks which to close (`suggestions`).
 */
export function openedIn(
  set: FlyoutSet,
  id: string,
  now: number,
): { set: FlyoutSet; added: boolean } | { full: true } {
  if (itemOf(set, id)) return { set: shownIn(set, id, now), added: false };
  if (set.items.length >= MAX_OPEN) return { full: true };
  const rest = set.items.map((it) =>
    it.state === 'shown' ? { ...it, state: 'min' as const, minimisedAt: now } : it,
  );
  return {
    set: { items: [...rest, { id, state: 'shown', view: 'both', minimisedAt: null }] },
    added: true,
  };
}

/** To the tray: kept as it is, out of sight, its clock started. */
export function minimisedIn(set: FlyoutSet, id: string, now: number): FlyoutSet {
  return {
    items: set.items.map((it) =>
      it.id === id && it.state === 'shown' ? { ...it, state: 'min', minimisedAt: now } : it,
    ),
  };
}

export function closedIn(set: FlyoutSet, id: string): FlyoutSet {
  return { items: set.items.filter((it) => it.id !== id) };
}

export function withView(set: FlyoutSet, id: string, view: FlyoutView): FlyoutSet {
  return { items: set.items.map((it) => (it.id === id ? { ...it, view } : it)) };
}

/**
 * Frees what has been minimised for FREE_AFTER_MS or more: its content is
 * dropped, its tray icon stays. The same set when nothing is due.
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
 * first), then the one in front.
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
  front: string | null;
}

export function toStored(set: FlyoutSet): Stored {
  return {
    items: set.items.map((it) => ({ id: it.id, view: it.view })),
    front: frontOf(set),
  };
}

/** What was kept, as tray icons: all freed but the one in front, which opens again. */
export function fromStored(raw: unknown): FlyoutSet {
  if (typeof raw !== 'object' || raw === null) return EMPTY_FLYOUTS;
  const kept = raw as { items?: unknown; front?: unknown };
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
  return { items };
}

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** This person's open documents in this tab, as tray icons (`fromStored`). */
export function readFlyouts(memberId: string | null): FlyoutSet {
  if (!memberId) return EMPTY_FLYOUTS;
  try {
    const raw = storage()?.getItem(flyoutsKey(memberId));
    return raw ? fromStored(JSON.parse(raw)) : EMPTY_FLYOUTS;
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
