import { useSyncExternalStore } from 'react';

/**
 * Light, dark, or as the system is (0.9.0, the owner's ask of 27 Oct 2026):
 * chosen in Settings → Appearance or in the name menu, and kept in this
 * browser alone — nothing about it goes to the server, so a shared computer
 * can be dark for one person and light for the next only by asking again.
 *
 * Auto, the choice nobody has made, follows `prefers-color-scheme` and
 * changes as the system does (a phone turning dark at dusk). Whatever the
 * choice, the page itself is told a concrete theme: `data-theme="light"` or
 * `"dark"` on <html>, which styles.css draws from. The script at the top of
 * index.html does the same before the stylesheet is read, so a dark page is
 * never drawn light first; this keeps it so afterwards.
 *
 * Kept in localStorage, which a private window may refuse: then the choice
 * holds until the page is loaded again, and Auto after that.
 */
export type ThemeChoice = 'auto' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

/** Where this browser keeps the choice: index.html's script reads it too. */
export const THEME_KEY = 'fdv.theme';
export const DARK_QUERY = '(prefers-color-scheme: dark)';

/** The three choices, as each place offers them, in this order. */
export const THEME_CHOICES: ReadonlyArray<{ value: ThemeChoice; label: string; note: string }> = [
  { value: 'auto', label: 'Auto', note: 'As your device is set' },
  { value: 'light', label: 'Light', note: 'Always light' },
  { value: 'dark', label: 'Dark', note: 'Always dark' },
];

const watchers = new Set<() => void>();
let unstored: ThemeChoice | null = null;

/** The choice this browser keeps: Auto when there is none, or nothing can be read. */
export function themeChoice(): ThemeChoice {
  // A choice this browser would not keep holds for now, over what it has.
  if (unstored !== null) return unstored;
  try {
    const kept = localStorage.getItem(THEME_KEY);
    return kept === 'light' || kept === 'dark' ? kept : 'auto';
  } catch {
    return 'auto';
  }
}

/** Whether the system asks for dark: never, where it cannot say. */
export function systemDark(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches;
  } catch {
    return false;
  }
}

/** The theme a choice means now. */
export function themeFor(choice: ThemeChoice, dark: boolean = systemDark()): Theme {
  return choice === 'auto' ? (dark ? 'dark' : 'light') : choice;
}

/** Tells the page its theme: the attribute styles.css draws from, and the native controls'. */
export function applyTheme(theme: Theme = themeFor(themeChoice())): Theme {
  const root = document.documentElement;
  if (root.getAttribute('data-theme') !== theme) root.setAttribute('data-theme', theme);
  root.style.colorScheme = theme;
  return theme;
}

function tell() {
  for (const changed of watchers) changed();
}

/** Chooses, keeps the choice in this browser (Auto by keeping none), and shows it at once. */
export function setThemeChoice(choice: ThemeChoice): void {
  try {
    if (choice === 'auto') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
    unstored = null;
  } catch {
    unstored = choice;
  }
  applyTheme();
  tell();
}

/**
 * Keeps the page's theme as things change around it: the system's setting,
 * for Auto, and a choice made in another tab of the vault. Called once, as
 * any page of the app starts (main.tsx) — the family's, a share link's, a
 * request's — and undone by what it returns.
 */
export function followTheme(): () => void {
  const changed = () => {
    applyTheme();
    tell();
  };
  applyTheme();
  const stop = onSystemChange(changed);
  const elsewhere = (e: StorageEvent) => {
    if (e.key === THEME_KEY || e.key === null) changed();
  };
  window.addEventListener('storage', elsewhere);
  return () => {
    stop();
    window.removeEventListener('storage', elsewhere);
  };
}

/** Told as the system turns light or dark; nothing, where it cannot say. */
function onSystemChange(changed: () => void): () => void {
  let list: MediaQueryList;
  try {
    if (typeof window.matchMedia !== 'function') return () => undefined;
    list = window.matchMedia(DARK_QUERY);
  } catch {
    return () => undefined;
  }
  // Safari before 14 has only the older pair.
  if (typeof list.addEventListener === 'function') {
    list.addEventListener('change', changed);
    return () => list.removeEventListener('change', changed);
  }
  list.addListener(changed);
  return () => list.removeListener(changed);
}

function watch(changed: () => void): () => void {
  watchers.add(changed);
  return () => {
    watchers.delete(changed);
  };
}

/** The same, and the system's turns too: for what says what Auto means now. */
function watchShown(changed: () => void): () => void {
  const stop = watch(changed);
  const stopSystem = onSystemChange(changed);
  return () => {
    stop();
    stopSystem();
  };
}

/** The choice, kept up as it changes, for what is drawn: which of the three is checked. */
export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(watch, themeChoice, () => 'auto');
}

/** The theme shown now, kept up as the choice or the system changes: what Auto means at the moment. */
export function useShownTheme(): Theme {
  return useSyncExternalStore(
    watchShown,
    () => themeFor(themeChoice()),
    () => 'light',
  );
}
