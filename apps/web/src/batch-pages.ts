/**
 * A batch's first pages, as this browser holds them (the I1 review): fetched
 * with the sign-in's token, a few at a time, only for a file still waiting,
 * and kept in memory as object URLs by item id — so a batch's page drawn
 * again, coming back from a file's card, asks the vault for nothing. The
 * vault answers them no-store; nothing is written to disk. A file accepted
 * or removed lets its page go (`forgetPages`), and signing out, or the
 * session ending, forgets every one (`forgetAllPages`, from the session).
 */

/** How many pages are asked for at once: a batch of 200 never sends 200 requests together. */
export const PAGES_AT_ONCE = 4;

const held = new Map<string, string>();
const asked = new Map<string, Promise<string | null>>();
interface Waiting {
  itemId: string;
  fetch: () => Promise<Blob | null>;
  settle: (url: string | null) => void;
}
const queue: Waiting[] = [];
let running = 0;
/** Bumped as everything is forgotten: a page fetched for an earlier sign-in is not kept. */
let era = 0;

/** The page's object URL, if this browser holds it already. */
export function heldPage(itemId: string): string | undefined {
  return held.get(itemId);
}

/**
 * The page of this item, fetched once while this page lives, waiting its
 * turn behind PAGES_AT_ONCE others. `cancel` takes it out of the queue if
 * it has not started (the row went off the screen, or the page was left).
 */
export function askPage(
  itemId: string,
  fetch: () => Promise<Blob | null>,
): { done: Promise<string | null>; cancel: () => void } {
  const have = held.get(itemId);
  if (have) return { done: Promise.resolve(have), cancel: () => undefined };
  const on = asked.get(itemId);
  if (on) return { done: on, cancel: () => undefined };
  let entry: Waiting | null = null;
  const done = new Promise<string | null>((settle) => {
    entry = { itemId, fetch, settle };
    queue.push(entry);
  });
  asked.set(itemId, done);
  pump();
  return {
    done,
    cancel: () => {
      const at = entry ? queue.indexOf(entry) : -1;
      if (at < 0 || !entry) return;
      queue.splice(at, 1);
      asked.delete(itemId);
      entry.settle(null);
    },
  };
}

function pump(): void {
  while (running < PAGES_AT_ONCE && queue.length > 0) {
    const next = queue.shift() as Waiting;
    running += 1;
    const from = era;
    void next
      .fetch()
      .then((blob) => {
        // Forgotten meanwhile (signed out, or decided): not kept.
        if (!blob || from !== era || asked.get(next.itemId) === undefined) return null;
        const url = URL.createObjectURL(blob);
        held.set(next.itemId, url);
        return url;
      })
      .catch(() => null)
      .then((url) => {
        next.settle(from === era ? url : null);
        // Everything forgotten meanwhile: the queue started again without it.
        if (from !== era) return;
        asked.delete(next.itemId);
        running -= 1;
        pump();
      });
  }
}

/**
 * Where an item's page is held (I3): its first by the item's id, as the
 * batch's page asks for it, and each other page the review's viewer turns
 * to by the item's id and its number.
 */
export const pageKey = (itemId: string, n: number): string => (n === 1 ? itemId : `${itemId}#${n}`);

/** These items' pages let go: each was accepted or removed, and its pages went with its bytes. */
export function forgetPages(itemIds: Iterable<string>): void {
  const ids = [...itemIds];
  // Every page of each, not only its first (I3).
  const pages = (id: string) =>
    [...held.keys(), ...asked.keys(), ...queue.map((w) => w.itemId)].filter((k) =>
      k.startsWith(`${id}#`),
    );
  for (const id of [...ids, ...ids.flatMap(pages)]) {
    const url = held.get(id);
    if (url) URL.revokeObjectURL(url);
    held.delete(id);
    asked.delete(id);
    const at = queue.findIndex((w) => w.itemId === id);
    if (at >= 0) queue.splice(at, 1)[0]?.settle(null);
  }
}

/** Every page forgotten: at sign-out and when a session ends. */
export function forgetAllPages(): void {
  era += 1;
  forgetPages([...held.keys(), ...queue.map((w) => w.itemId)]);
  asked.clear();
  running = 0;
}
