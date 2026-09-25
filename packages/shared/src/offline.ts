import type { DocumentView } from './documents.js';
import { canSee, type Role } from './roles.js';

/**
 * Essentials a phone may keep (0.4.13).
 *
 * A phone keeps a person's Essentials for when there is no connection. The
 * vault says which, as a complete set — anything not in it is to be
 * removed from the phone. One rule decides it, for the vault and for the
 * phone alike:
 *
 *  - only Essentials, and only ones the person can see;
 *  - owners and adults: all of those;
 *  - teens: only the Essentials that are theirs;
 *  - viewers: none;
 *  - a person's own Only me Essentials only when they chose to keep them
 *    too (`include_private` on the grant).
 */
export function mayKeepOffline(
  who: { role: Role; memberId: string | null },
  doc: { visibility: string; owner_member_id: string | null; is_essential: boolean },
  includePrivate: boolean,
): boolean {
  if (!doc.is_essential || who.role === 'viewer') return false;
  if (!canSee(who, doc)) return false;
  if (who.role === 'teen' && (who.memberId === null || doc.owner_member_id !== who.memberId))
    return false;
  return doc.visibility !== 'private' || includePrivate;
}

/** The most Essentials the set holds; past it, `truncated` says so. */
export const OFFLINE_SET_MAX = 500;

/** A grant, as the vault says it: the session may fill its phone until `expires_at`. */
export interface OfflineGrant {
  granted_at: string;
  expires_at: string;
  include_private: boolean;
}

export interface OfflineItem {
  document: DocumentView;
  /** The current version, the only one a phone keeps. */
  version: {
    id: string;
    mime: string;
    page_count: number | null;
    preview_pages: number | null;
    preview_state: string;
  };
  /** An Only me Essential (kept in the phone's separate store). */
  private: boolean;
}

/** GET /api/v1/offline/essentials. */
export interface OfflineSet {
  items: OfflineItem[];
  grant: OfflineGrant | null;
  /** How many days a phone may show its copies without reaching the vault. */
  max_offline_days: number;
  server_time: string;
  truncated: boolean;
}

/** One thing a phone did with a kept Essential, reported when it next connects. */
export interface OfflineOpen {
  /** A UUID the phone made: the same event sent twice is recorded once. */
  id: string;
  version_id: string;
  opened_at: string;
  mode: 'view' | 'show';
  /** Whether it was opened with a connection after all. */
  online: boolean;
}

export interface OfflineOpensResult {
  accepted: number;
  duplicates: number;
  /** Events about something the person cannot see (any more): not recorded. */
  dropped: number;
}
