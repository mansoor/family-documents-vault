import { useSyncExternalStore } from 'react';

/**
 * When somebody last changed tags in this tab (0.9.0-dev.103): a tag added
 * to or taken off a document — on its page, beside the list, to the ones
 * chosen — or renamed, merged or deleted in Settings → Tags. The Documents
 * filter's tags are read again when it moves, so a tag just added is there
 * to filter by without leaving the page.
 */
let version = 0;
const listeners = new Set<() => void>();

/** Tags changed: whatever lists them reads them again. */
export function tagsChanged(): void {
  version += 1;
  for (const l of listeners) l();
}

/** How many times tags changed in this tab: a dependency for whatever lists them. */
export function useTagsVersion(): number {
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
