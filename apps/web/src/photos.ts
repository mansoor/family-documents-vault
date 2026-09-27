import { api } from './api.js';

/**
 * People's photos, as this browser holds them (5.17c): fetched with the
 * sign-in's token — never an address a browser could fetch or keep by
 * itself — and kept in memory only, as object URLs by photo id. The vault
 * answers them no-store; nothing is written to disk here. Signing out, or
 * the session ending, forgets every one (`clearPhotos`, from the session).
 */

const held = new Map<string, string>();
const asked = new Map<string, Promise<string | null>>();

/** The photo's object URL, fetched once per photo while this page lives. */
export function photoUrl(token: string, memberId: string, photoId: string): Promise<string | null> {
  const have = held.get(photoId);
  if (have) return Promise.resolve(have);
  let on = asked.get(photoId);
  if (!on) {
    on = api
      .memberPhoto(token, memberId, photoId)
      .then((blob) => {
        // Forgotten meanwhile (signed out): not kept.
        if (!asked.has(photoId)) return null;
        const url = URL.createObjectURL(blob);
        held.set(photoId, url);
        return url;
      })
      .catch(() => null)
      .finally(() => asked.delete(photoId));
    asked.set(photoId, on);
  }
  return on;
}

/** Every photo forgotten, and its object URL let go: at sign-out and when a session ends. */
export function clearPhotos(): void {
  for (const url of held.values()) URL.revokeObjectURL(url);
  held.clear();
  asked.clear();
}

/** How many photos this page holds now: for the tests. */
export function photosHeld(): number {
  return held.size;
}
