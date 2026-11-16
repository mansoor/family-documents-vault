import { CABINET_NODE_ID } from '@fdv/shared';

/**
 * Where to land once signed in (0.9.0, C3): a printed folder label's code
 * opens `/folder/{id}`; whoever is signed out signs in as usual, and then
 * lands on that folder instead of Home. Kept in this tab only
 * (sessionStorage), for half an hour, and only ever a folder of the cabinet:
 * nothing else can be asked to land on, so no address can send anybody
 * anywhere else after they sign in.
 */

const KEY = 'fdv.landing';
const FOR_MS = 30 * 60_000;

/** The cabinet's page for a folder of the reader's own, by its id; the cabinet for any other id. */
export function folderLanding(id: string): string {
  return CABINET_NODE_ID.test(id)
    ? `/documents?show=cabinet&folder=${encodeURIComponent(id)}`
    : '/documents?show=cabinet';
}

const ALLOWED = /^\/documents\?show=cabinet(&folder=[A-Za-z0-9_-]{1,40})?$/;

/** Remembered as the place to land: written the same each time it is asked, so asking twice is once. */
export function rememberLanding(to: string): void {
  if (!ALLOWED.test(to)) return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ to, at: Date.now() }));
  } catch {
    // Not remembered: Home, as ever.
  }
}

/** Nowhere to land: joined, or a vault set up, by a way in that lands where it lands (C3). */
export function forgetLanding(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing kept.
  }
}

/** The place to land, once: taken away as it is read; null for none, or one too old. */
export function takeLanding(): string | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    if (!raw) return null;
    const { to, at } = JSON.parse(raw) as { to?: unknown; at?: unknown };
    return typeof to === 'string' &&
      ALLOWED.test(to) &&
      typeof at === 'number' &&
      Date.now() - at < FOR_MS
      ? to
      : null;
  } catch {
    return null;
  }
}
