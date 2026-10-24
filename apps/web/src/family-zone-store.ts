/**
 * The family's time zone as this page last heard it (0.9.0, TZ), for the
 * few helpers that say a moment outside a screen's render (a batch's name
 * by its day, as an upload starts). Screens take it from useFamilyZone
 * (family-time.tsx), which also re-draws them when it changes; AppProvider
 * keeps this in step with it.
 */
let current: string | null = null;

export function setCurrentFamilyZone(zone: string | null): void {
  current = zone;
}

export function currentFamilyZone(): string | null {
  return current;
}

/**
 * Every answer from the vault that says the family's zone — GET /profile,
 * GET and PUT /household/timezone, PUT /profile — is heard here (api.ts),
 * and AppProvider moves every screen to it: a screen never shows times on a
 * zone older than the newest answer the tab has had (the TZ review).
 */
const listeners = new Set<(zone: string) => void>();

export function onFamilyZoneHeard(listener: (zone: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function heardFamilyZone(zone: string | null | undefined): void {
  if (!zone) return;
  for (const l of listeners) l(zone);
}
