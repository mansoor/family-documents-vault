import { localToday, shortDate } from './reminders.js';
import { can, type Role } from './roles.js';
import { suspensionInEffect } from './wire.js';

/**
 * A watched folder for network scanners (0.8.0, S3, CAP-10).
 *
 * The operator mounts a folder into the worker and sets FDV_WATCH_DIR; the
 * household's scanner saves into it over SMB or FTP. An owner turns it on in
 * Settings and chooses whose Inbox it fills — by default themselves, or
 * anybody of the family who may add documents, never a viewer. The worker
 * looks every WATCH_POLL_MS, and takes a file once it has stopped changing
 * (FDV_WATCH_STABLE_SECONDS, WATCH_STABLE_MS by default) and looks complete
 * for its kind — or has stayed so for FDV_WATCH_INCOMPLETE_GRACE_SECONDS; it adds it as Add → Many documents adds a file: an item in
 * that person's batch of the day ("Scanner, 12 Oct"), theirs alone until
 * they accept it. Once it is safely stored the file is deleted. A file the
 * vault cannot take is moved to `rejected/`, with a note beside it saying
 * why, and that person is told in Needs attention.
 */

/** How often the worker looks in the folder. Polling: bind mounts on Docker Desktop deliver no events. */
export const WATCH_POLL_MS = 15_000;

/** By default, a file is taken once its size and time have not changed for this long. */
export const WATCH_STABLE_MS = 10_000;

/**
 * By default, a file that has stopped changing but does not look complete
 * for its kind is waited for this long, then taken anyway
 * (FDV_WATCH_INCOMPLETE_GRACE_SECONDS): a valid file whose end the check does
 * not know (a motion photo, a PDF with data after its end) is never held up
 * for long, and the reader says of a file cut short that its pages are bad.
 */
export const WATCH_INCOMPLETE_GRACE_MS = 120_000;

/**
 * The worker's word on the folder older than this is no word at all: the
 * worker is not running, or cannot reach the database. The scanner folder
 * is then not offered.
 */
export const WATCH_STALE_MS = 2 * 60_000;

/** The folder the worker moves what it cannot take into, beside a note saying why. */
export const WATCH_REJECTED_DIR = 'rejected';

/** Where the README puts the scanner folder on the server, beside docker-compose.yml. */
export const WATCH_HOST_DIR = './scanner';

/** How long a "couldn't be added" note stays in Needs attention, unless dismissed. */
export const WATCH_NOTICE_DAYS = 30;

/**
 * The folder, as the worker last found it: `off` (FDV_WATCH_DIR is not set),
 * `ready`, `missing`, `not_a_folder` or `not_writable` (the vault could not
 * delete a file once it is stored, nor move one to rejected/). `unknown`
 * when the worker has not said so lately (WATCH_STALE_MS).
 */
export type WatchDirState = 'off' | 'ready' | 'missing' | 'not_a_folder' | 'not_writable';

/**
 * Why the folder is paused, while it is on: whose Inbox it fills is gone
 * (`removed`), has no sign-in (`no_sign_in`), may no longer add documents
 * (`cannot_add`), is locked (`locked`) or waits for an owner after a restore
 * (`restored`); or the vault cannot open that person's key (`sealed`), has
 * nowhere to keep files (`no_storage`), or the day's batch is full
 * (`day_full`). Files wait in the folder until it is not.
 */
export type WatchPause =
  | 'removed'
  | 'no_sign_in'
  | 'cannot_add'
  | 'locked'
  | 'restored'
  | 'sealed'
  | 'no_storage'
  | 'day_full';

/**
 * Why a file was moved to rejected/ (or would have been): not a kind the
 * vault keeps, too large, not to be read, empty, or a linked copy of a file
 * elsewhere (`linked`).
 */
export type WatchRejectReason = 'unsupported' | 'too_large' | 'unreadable' | 'empty' | 'linked';

/** Somebody whose Inbox the folder may fill: of the family, with a sign-in, who may add documents. */
export interface WatchCandidate {
  member_id: string;
  display_name: string;
  role: Role;
}

/** GET /watch-folder: an owner's view of the scanner folder. */
export interface WatchFolderView {
  /** Whether the folder can be turned on: FDV_WATCH_DIR set, there, and writable (`/capabilities`'s `watch_folder`). */
  available: boolean;
  folder: {
    state: WatchDirState | 'unknown';
    /** FDV_WATCH_DIR as the worker has it, inside its container. */
    dir: string | null;
    checked_at: string | null;
    /** What it means, in a sentence: the folder in the worker, and on the server as the README sets it up. */
    words: string;
  };
  enabled: boolean;
  /** Whose Inbox it fills: null when it has never been on, or that person is gone. */
  member_id: string | null;
  member_name: string | null;
  /** While it is on and cannot add: why, in a sentence. */
  paused: { reason: WatchPause; words: string } | null;
  last_added_at: string | null;
  /**
   * Files the worker has dealt with that are still in the folder, not
   * encrypted: stored in the vault but not deleted, or meant for rejected/
   * but not moved. 0 when there are none; with what to do.
   */
  stuck_files: number;
  stuck_words: string | null;
  /** Whose Inbox it may fill. */
  candidates: WatchCandidate[];
}

/** PUT /watch-folder: on or off; whose Inbox (left out, or null: the owner turning it on). */
export interface WatchFolderInput {
  enabled: boolean;
  member_id?: string | null | undefined;
}

/**
 * GET /watch-folder/notices: "A scanned file couldn't be added", the
 * caller's own — and, since S4, "An email couldn't be added" (`source`).
 */
export interface WatchNoticeView {
  id: string;
  /** The scanner folder's, or an email's (S4; absent from an S3 vault: the scanner's). */
  source?: 'scanner' | 'email';
  /** The file's name; an email's note may name none (the mail as a whole). */
  file_name: string | null;
  /** An email's are MailNoticeReason's (S4). */
  reason: WatchRejectReason | 'message_too_large' | 'nothing_to_add' | 'skipped';
  /** It could not be moved to rejected/ either: it is still where the scanner saved it. */
  left_in_place: boolean;
  /** "A scanned file couldn't be added" */
  title: string;
  /** Why, and what to do. */
  words: string;
  at: string;
}

/**
 * What the folder's state means, to an owner in Settings: the folder as the
 * worker has it (`dir`, inside its container) and where the README puts it on
 * the server (WATCH_HOST_DIR), so an owner can find it either way.
 */
export function watchDirWords(state: WatchDirState | 'unknown', dir: string | null): string {
  const at = dir
    ? `${dir} in the worker (${WATCH_HOST_DIR} on the server, if set up as the README says)`
    : 'the folder';
  switch (state) {
    case 'ready':
      return `The scanner folder is ready: ${at}.`;
    case 'off':
      return `There is no scanner folder: FDV_WATCH_DIR is not set on the worker. The README’s “Scanning straight into the vault” says how to set one up, as ${WATCH_HOST_DIR} on the server.`;
    case 'missing':
      return `FDV_WATCH_DIR names ${at}, but there is nothing there. Check the scanner folder’s mount in docker-compose.yml.`;
    case 'not_a_folder':
      return `FDV_WATCH_DIR names ${at}, which is a file, not a folder.`;
    case 'not_writable':
      return `The vault can’t write to ${at}, so it couldn’t delete a file once it is stored. Give the folder to the containers’ user (uid 1000).`;
    case 'unknown':
      return 'The worker hasn’t looked at the scanner folder in the last few minutes. Check that it is running.';
  }
}

/**
 * Files the worker has dealt with that are still in the folder, to an
 * owner — stored but not deleted, or meant for rejected/ but not moved —
 * as of the worker's last look; null for none.
 */
export function watchStuckWords(n: number): string | null {
  if (n <= 0) return null;
  const files = n === 1 ? '1 scan is' : `${n} scans are`;
  const it = n === 1 ? 'it' : 'them';
  return `${files} still in the scanner folder, not encrypted, though the vault has dealt with ${it}: stored safely but not deleted, or not added and not moved to rejected/. Check the folder’s permissions, and delete ${it} from the folder by hand once you have checked.`;
}

/** Why the folder is paused, to an owner: `name` is whose Inbox it fills. */
export function watchPauseWords(reason: WatchPause, name: string | null): string {
  const who = name ?? 'That person';
  const wait = 'Scans wait in the folder until then.';
  switch (reason) {
    case 'removed':
      return 'Paused: the person whose Inbox it filled is no longer in the household. Choose someone else.';
    case 'no_sign_in':
      return `Paused: ${who} has no sign-in now. Choose someone else, or give them their sign-in back. ${wait}`;
    case 'cannot_add':
      return `Paused: ${who} can’t add documents now. Choose someone who can. ${wait}`;
    case 'locked':
      return `Paused: ${who}’s sign-in is locked. ${wait}`;
    case 'restored':
      return `Paused after a restore, until an owner turns ${who}’s sign-in back on. ${wait}`;
    case 'sealed':
      return `Paused: the vault can’t open ${who}’s key with this master key. Check FDV_MASTER_KEY. ${wait}`;
    case 'no_storage':
      return `Paused: there is nowhere to keep files yet. Set up where files are kept first. ${wait}`;
    case 'day_full':
      return `Paused: today’s batch is full. The rest are added tomorrow, or once ${who} removes some from today’s.`;
  }
}

/** Why a file was moved to rejected/, in plain words: in its note, and in Needs attention. */
export function watchRejectWords(reason: WatchRejectReason, maxBytes?: number): string {
  switch (reason) {
    case 'unsupported':
      return 'It isn’t a kind of file the vault keeps. PDFs, photos and scans are fine (PDF, JPEG, PNG, TIFF, HEIC, WebP), and Word and Excel files.';
    case 'too_large':
      return maxBytes
        ? `It is larger than the most the vault takes in one file (${sizeWords(maxBytes)}). Scan it in parts, or at a lower resolution.`
        : 'It is larger than the most the vault takes in one file. Scan it in parts, or at a lower resolution.';
    case 'unreadable':
      return 'The vault couldn’t read it from the folder. Check the file, then save it into the folder again.';
    case 'empty':
      return 'It was empty. Scan it again.';
    case 'linked':
      return 'It was a linked copy of a file kept somewhere else. Save it into the folder as a plain file.';
  }
}

/** "100 MB", or "64 KB" under a megabyte. */
function sizeWords(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${Math.floor(mb)} MB` : `${Math.max(1, Math.floor(bytes / 1024))} KB`;
}

/** What a note says when the file could not be moved to rejected/ either. */
export const WATCH_LEFT_IN_PLACE =
  'It could not be moved to the rejected folder either, so it is still where the scanner saved it, not encrypted. Delete it from the scanner folder once you have dealt with it.';

/** Needs attention's heading for a file moved to rejected/. */
export const WATCH_REJECTED_TITLE = 'A scanned file couldn’t be added';

/**
 * Why the person whose Inbox the folder fills cannot have files added,
 * from their sign-in as it is now: null when they can. `member` null when
 * they are gone; `sign_in` null when they have none.
 */
export function watchPauseOf(
  member: { kind: 'family' | 'guest' } | null,
  signIn: {
    role: Role;
    suspended_at: Date | string | null;
    suspended_until: Date | string | null;
    suspend_reason: string | null;
  } | null,
  now: number = Date.now(),
): WatchPause | null {
  if (!member) return 'removed';
  if (!signIn) return 'no_sign_in';
  if (member.kind !== 'family' || !can(signIn.role, 'document.add')) return 'cannot_add';
  if (suspensionInEffect(signIn, now)) {
    return signIn.suspend_reason === 'restored' ? 'restored' : 'locked';
  }
  return null;
}

/** Whose Inbox the folder may fill: somebody of the family with a sign-in who may add documents. */
export function mayFillFromScanner(role: Role, kind: 'family' | 'guest' = 'family'): boolean {
  return kind === 'family' && can(role, 'document.add');
}

/** The day a file is added, on the household's calendar, and its batch's name: "Scanner, 12 Oct". */
export function scannerDay(
  timezone: string,
  now: Date = new Date(),
): { day: string; name: string } {
  const day = localToday(timezone, now);
  return { day, name: `Scanner, ${shortDate(day)}` };
}

/** Names nothing of a scan's: a scanner's or an operating system's own, written beside it. */
const NOT_SCANS = new Set(['thumbs.db', 'desktop.ini']);

/**
 * Whether a file in the folder is left alone, by its path from the folder
 * (`/` between parts): anything under `rejected/`, a hidden file or folder
 * (a name starting with `.`), a name a program writes while it is still
 * saving (`~…`, `….tmp`, `….part`), and an operating system's own files.
 */
export function watchIgnored(relPath: string): boolean {
  const parts = relPath.split('/').filter((p) => p.length > 0);
  if (parts.length === 0) return true;
  if (parts[0] === WATCH_REJECTED_DIR) return true;
  if (parts.some((p) => p.startsWith('.'))) return true;
  const name = (parts[parts.length - 1] as string).toLowerCase();
  if (name.startsWith('~')) return true;
  if (name.endsWith('.tmp') || name.endsWith('.part')) return true;
  return NOT_SCANS.has(name);
}
