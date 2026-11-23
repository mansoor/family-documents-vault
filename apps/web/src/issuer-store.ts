import { useSyncExternalStore } from 'react';

/**
 * When the household's "Same as" list of issuers last changed in this tab
 * (0.9.0-dev.91): Same or Separate, in Settings › Who issued it or beside the
 * level picker. Everything that names issuers — a cabinet's folders, the
 * table's Who issued it chip, the Settings list — reads them again when it
 * moves, so no page keeps a name the list no longer gives.
 */
let version = 0;
const listeners = new Set<() => void>();

/** The list changed: every page naming issuers reads them again. */
export function issuersChanged(): void {
  version += 1;
  for (const l of listeners) l();
}

/** How many times the list changed in this tab: a dependency for whatever reads issuers. */
export function useIssuersVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => version,
  );
}
