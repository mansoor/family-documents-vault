import type { MailInTestResult } from './mail-in.js';
import type { WatchBrowseResult, WatchVerifyResult } from './watch-folder.js';

/**
 * What an owner asks the worker from Settings (0.9.0, O1), and its answer:
 * "Verify" a scanner folder, the folders inside one (to browse for it), or
 * "Test the mailbox". The worker alone has the folders and the mailbox's
 * password, so it answers; the page asks for the answer until it is there.
 */

/** `folder`: Verify; `browse`: the folders inside one; `mailbox`: Test the mailbox. */
export type SettingsCheckKind = 'folder' | 'browse' | 'mailbox';

/**
 * A worker that has not answered in this long is not running, or is busy:
 * the page stops waiting, and says so.
 */
export const SETTINGS_CHECK_LATE_MS = 60_000;

/** How often an owner may ask, a household: this many a minute. */
export const SETTINGS_CHECKS_PER_MINUTE = 20;

/** How long an answer is kept, then cleared away. */
export const SETTINGS_CHECK_KEEP_MS = 24 * 60 * 60_000;

/** A check, asked for (202) and asked after (GET /settings-checks/{id}). */
export interface SettingsCheckView {
  id: string;
  kind: SettingsCheckKind;
  /** Waiting for the worker; answered; or not answered in SETTINGS_CHECK_LATE_MS. */
  state: 'waiting' | 'done' | 'late';
  requested_at: string;
  /** The answer, by kind, once it is done. */
  folder?: WatchVerifyResult;
  browse?: WatchBrowseResult;
  mailbox?: MailInTestResult;
  /** While late: why, and what to do. */
  words: string | null;
}

/** Said of a check the worker has not answered in time. */
export const SETTINGS_CHECK_LATE_WORDS =
  'The worker hasn’t answered. Check that it is running, then try again.';
