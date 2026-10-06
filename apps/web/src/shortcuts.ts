import { useSyncExternalStore } from 'react';

/**
 * Whether the shell's single-key shortcuts — `/` to the search box, `n` to
 * Add — are on, on this device (WCAG 2.1.4): on, unless turned off in
 * Settings → Your account. Somebody who speaks to their computer, or whose
 * hand rests on the keys, may not want a key that does something alone.
 *
 * Kept in this browser's localStorage, which a private window may refuse:
 * then the choice holds until the page is loaded again.
 */
const KEY = 'fdv.shortcuts';
const watchers = new Set<() => void>();
let unstored: boolean | null = null;

export function shortcutsOn(): boolean {
  // A choice this browser would not keep holds for now, over what it has.
  if (unstored !== null) return unstored;
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setShortcutsOn(on: boolean): void {
  try {
    if (on) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, 'off');
    unstored = null;
  } catch {
    unstored = on;
  }
  for (const changed of watchers) changed();
}

function watch(changed: () => void): () => void {
  watchers.add(changed);
  // Turned off in another tab of the vault: this one too.
  const elsewhere = (e: StorageEvent) => {
    if (e.key === KEY || e.key === null) changed();
  };
  window.addEventListener('storage', elsewhere);
  return () => {
    watchers.delete(changed);
    window.removeEventListener('storage', elsewhere);
  };
}

/** The same, kept up as it changes, for what is drawn: the key's hint, `aria-keyshortcuts`. */
export function useShortcutsOn(): boolean {
  return useSyncExternalStore(watch, shortcutsOn, () => true);
}
