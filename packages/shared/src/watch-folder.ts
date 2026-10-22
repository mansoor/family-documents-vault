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

/**
 * Where a scan is kept once it is safely stored (0.9.0, O1):
 * `processed/<YYYY-MM-DD>/`, the household's date, its subfolders kept
 * under it, until it is older than the owner's number of days.
 */
export const WATCH_PROCESSED_DIR = 'processed';

/** How many days a stored scan is kept in processed/ by default; 0 deletes it at once. */
export const WATCH_KEEP_DAYS_DEFAULT = 7;
export const WATCH_KEEP_DAYS_MAX = 365;

/** Said beside the number of days scans are kept. */
export const WATCH_KEPT_WARNING =
  'Scans kept here are not encrypted until they’re deleted; anyone who can open the server’s folder can read them.';

/** Said beside it too (the O1 review, M2): the vault deletes only the scans it kept there. */
export const WATCH_PROCESSED_UNTOUCHED =
  'Anything else saved into processed is never touched, but isn’t added either.';

/** The file that says a processed/ folder is the vault's own: it never keeps scans in one without it. */
export const WATCH_PROCESSED_MARKER = '.fdv-processed';

/** Said while the folder has a processed/ the vault didn't make (M2). */
export const WATCH_PROCESSED_FOREIGN =
  'The scanner folder has a folder called “processed” that the vault didn’t make, so it keeps no scans there: they are deleted once stored, and nothing in that folder is touched or added. Rename it, and the vault makes its own.';

/** Said of scans kept in a folder the vault may no longer use (L1): left there, not encrypted. */
export function watchKeptLeftWords(n: number): string | null {
  if (n <= 0) return null;
  const scans = n === 1 ? '1 kept scan is' : `${n} kept scans are`;
  return `${scans} in a scanner folder the vault no longer uses, or may no longer use, so it can’t delete ${n === 1 ? 'it' : 'them'}: ${n === 1 ? 'it is' : 'they are'} still there, not encrypted. Delete ${n === 1 ? 'it' : 'them'} from that folder’s processed folder by hand.`;
}

/**
 * Said of kept scans changed since they were kept, on a file system with no
 * birth time to know them by (the O1 re-check, 1): never deleted, as they
 * may not be the files the vault kept.
 */
export function watchKeptChangedWords(n: number): string | null {
  if (n <= 0) return null;
  const scans = n === 1 ? '1 kept scan' : `${n} kept scans`;
  return `${scans} changed since ${n === 1 ? 'it was' : 'they were'} kept, left in place: the vault can’t be sure ${n === 1 ? 'it is' : 'they are'} still the scan${n === 1 ? '' : 's'} it kept, so it won’t delete ${n === 1 ? 'it' : 'them'}. Delete ${n === 1 ? 'it' : 'them'} by hand from the scanner folder’s processed folder once you no longer need ${n === 1 ? 'it' : 'them'}.`;
}

/**
 * Said of files in a processed/ of the vault's own that it has no record of
 * after a restore (the O1 re-check, 2): never deleted by the vault.
 */
export function watchKeptUntrackedWords(n: number): string | null {
  if (n <= 0) return null;
  const scans =
    n === 1 ? '1 scan kept before a restore isn’t' : `${n} scans kept before a restore aren’t`;
  return `${scans} tracked, so the vault won’t delete ${n === 1 ? 'it' : 'them'}: delete ${n === 1 ? 'it' : 'them'} by hand from the scanner folder’s processed folder, or leave ${n === 1 ? 'it' : 'them'} there. ${n === 1 ? 'It is' : 'They are'} not encrypted.`;
}

/** Said of FDV_WATCH_ROOTS the worker refuses (M4): `/`, or a folder holding the vault's own. */
export function watchRefusedRootsWords(roots: readonly string[]): string | null {
  if (roots.length === 0) return null;
  return `The server names ${roots.length === 1 ? 'a folder' : 'folders'} for scanners that the vault refuses, as ${roots.length === 1 ? 'it is' : 'they are'} / or ${roots.length === 1 ? 'holds' : 'hold'} the vault’s own files: ${roots.join(', ')}. Ask the server’s operator to change FDV_WATCH_ROOTS.`;
}

/** The folders a scanner folder may be chosen inside by default (FDV_WATCH_ROOTS). */
export const WATCH_ROOTS_DEFAULT = '/watch';

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
export type WatchDirState =
  | 'off'
  | 'ready'
  | 'missing'
  | 'not_a_folder'
  | 'not_writable'
  /**
   * One of the vault's own folders or one above one, outside the folders
   * it may be chosen inside, or reached through a link out of them (0.9.0,
   * O1). Nothing in it is touched.
   */
  | 'refused';

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
  /** Whether the folder can be turned on: the folder in use there and writable, as the worker said lately. */
  available: boolean;
  folder: {
    state: WatchDirState | 'unknown';
    /** The folder in use, inside the worker's container: the one an owner chose, or FDV_WATCH_DIR. */
    dir: string | null;
    checked_at: string | null;
    /** What it means, in a sentence: the folder in the worker, and on the server as the README sets it up. */
    words: string;
  };
  /**
   * Where it may be (0.9.0, O1): the folder an owner chose (null: the
   * server's own, FDV_WATCH_DIR), that one, and the folders one may be
   * chosen inside (FDV_WATCH_ROOTS, and FDV_WATCH_DIR). Absent from a
   * vault before 0.9.0.
   */
  choice?: {
    dir: string | null;
    default_dir: string | null;
    roots: string[];
    /** FDV_WATCH_ROOTS the worker refuses (the O1 review, M4), and what that means; none, null. */
    refused_roots?: string[];
    refused_words?: string | null;
  };
  /** A processed/ the vault didn't make is there (M2): what that means; null when not. */
  processed_words?: string | null;
  /** Scans kept in a folder the vault may no longer use (L1): how many, and what to do. */
  kept_left?: number;
  kept_left_words?: string | null;
  /** Kept scans changed since, left in place (the O1 re-check, 1). */
  kept_changed?: number;
  kept_changed_words?: string | null;
  /** Files in the vault's processed/ it has no record of after a restore, never deleted (2). */
  kept_untracked?: number;
  kept_untracked_words?: string | null;
  /** How many days a stored scan is kept in processed/ (0: deleted at once), and what that means (O1). */
  keep_days?: number;
  kept_warning?: string;
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

/**
 * PUT /watch-folder: on or off; whose Inbox (left out, or null: the owner
 * turning it on); and since 0.9.0 which folder (null: FDV_WATCH_DIR; left
 * out: as it was) and how many days scans are kept (left out: as it was).
 */
export interface WatchFolderInput {
  enabled: boolean;
  member_id?: string | null | undefined;
  dir?: string | null | undefined;
  keep_days?: number | undefined;
}

/**
 * Why a path cannot be the scanner folder, before anything is asked of the
 * folder itself (0.9.0, O1): not a whole path (`not_absolute`); written
 * with `.`, `..`, `//`, a backslash or a control character (`not_plain`);
 * outside the folders it may be chosen inside (`outside_roots`); or one of
 * the vault's own folders, inside one, or a folder above one
 * (`vault_folder`).
 */
export type WatchPathRefusal =
  | 'not_absolute'
  | 'not_plain'
  | 'outside_roots'
  | 'vault_folder'
  /** Another household on this server uses it, is inside it, or (but for browsing) under it (the O1 review, L2). */
  | 'used_elsewhere';

/**
 * Folders that are the vault's own, or the system's, in the worker's
 * container, whatever the worker says besides: its code, its temporary
 * folders, the secrets Docker hands it (the master key among them), a
 * database's data, the volume its files and backups are on. Never a
 * scanner folder, nor inside one, nor above one.
 */
export const WATCH_SYSTEM_DIRS = [
  '/app',
  '/tmp',
  '/var/tmp',
  '/run/secrets',
  '/var/lib/postgresql',
  '/data',
  '/proc',
  '/sys',
  '/dev',
  '/etc',
] as const;

/** A path tidied: no slash at its end but the root's. */
export function watchPathTidy(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/** Whether `inner` is `outer`, or inside it, part by whole part. */
export function watchPathWithin(outer: string, inner: string): boolean {
  const o = watchPathTidy(outer);
  const i = watchPathTidy(inner);
  return i === o || i.startsWith(o === '/' ? '/' : `${o}/`);
}

/** Control characters, and a backslash. */
// eslint-disable-next-line no-control-regex
const NOT_PLAIN = /[\u0000-\u001f\u007f\\]/;

/**
 * Whether a path may be the scanner folder, as written: null when it may;
 * otherwise why not. `roots` are the folders it may be chosen inside (or
 * be); `ownDirs` the vault's own, which it may neither be, nor be inside,
 * nor be above (the API gives WATCH_SYSTEM_DIRS and the worker's own, as
 * the worker said them). The worker asks again of the folder itself, by
 * its real path, every round.
 */
export function watchPathRefusal(
  p: string,
  roots: readonly string[],
  ownDirs: readonly string[],
): WatchPathRefusal | null {
  if (!p.startsWith('/')) return 'not_absolute';
  const t = watchPathTidy(p);
  if (t.length > 1024 || NOT_PLAIN.test(t)) return 'not_plain';
  if (
    t !== '/' &&
    t
      .split('/')
      .slice(1)
      .some((x) => x === '' || x === '.' || x === '..')
  ) {
    return 'not_plain';
  }
  if (!roots.some((r) => r.startsWith('/') && watchPathWithin(r, t))) return 'outside_roots';
  for (const own of ownDirs) {
    if (!own.startsWith('/')) continue;
    if (watchPathWithin(own, t) || watchPathWithin(t, own)) return 'vault_folder';
  }
  return null;
}

/** Why a path was refused, in plain words. */
export function watchPathWords(r: WatchPathRefusal, roots: readonly string[] = []): string {
  const inside = roots.length
    ? `inside ${roots.length === 1 ? roots[0] : `one of ${roots.join(', ')}`}`
    : 'inside the folders the server set aside for scanners (FDV_WATCH_ROOTS)';
  switch (r) {
    case 'not_absolute':
      return `Type the whole path, starting with /: a folder ${inside}.`;
    case 'not_plain':
      return 'Type the path plainly: no “.” or “..”, and no doubled slashes or backslashes.';
    case 'outside_roots':
      return `That folder isn’t one the vault may use. Choose a folder ${inside}. The README’s “Scanning straight into the vault” says how to mount another.`;
    case 'vault_folder':
      return 'That is one of the vault’s own folders, or a folder above one: where it keeps files, its database, its temporary files or the app itself. Choose another.';
    case 'used_elsewhere':
      return 'Another household on this server uses that folder for its scanner, or a folder inside it. Choose another.';
  }
}

/**
 * What "Verify" asks of a folder, in order, in the worker (0.9.0, O1): it
 * is there and is a folder; it is inside the folders it may be chosen
 * inside by its real path (no link out of them); it is none of the vault's
 * own folders, nor above one; the vault can list it, make a file in it,
 * move that file and delete it (a hidden file, removed after); and how
 * much room there is.
 */
export type WatchVerifyCheck =
  'exists' | 'folder' | 'inside' | 'not_vault' | 'read' | 'create' | 'move' | 'delete' | 'space';

export const WATCH_VERIFY_CHECKS: readonly WatchVerifyCheck[] = [
  'exists',
  'folder',
  'inside',
  'not_vault',
  'read',
  'create',
  'move',
  'delete',
  'space',
];

/** One check: passed, failed, or not tried because one before it failed (null). */
export interface WatchVerifyStep {
  check: WatchVerifyCheck;
  ok: boolean | null;
  words: string;
}

/** What the worker found of a folder, as it is kept: the words are made from it. */
export interface WatchVerifyFound {
  path: string;
  steps: Array<{ check: WatchVerifyCheck; ok: boolean | null }>;
  /** Free space for the vault's user, in bytes; null when it could not be told. */
  free_bytes: number | null;
}

/** A Verify, answered: each check in words, and whether all passed. */
export interface WatchVerifyResult {
  path: string;
  ok: boolean;
  steps: WatchVerifyStep[];
  free_bytes: number | null;
  words: string;
}

/** A folder browsed, answered: the folders inside it, by name. */
export interface WatchBrowseResult {
  path: string;
  folders: string[];
  /** More than WATCH_BROWSE_MAX: the first so many, by name. */
  truncated: boolean;
  /** Why it could not be listed, in words: null when it was. */
  problem: string | null;
}

/** At most this many folders are listed of one folder. */
export const WATCH_BROWSE_MAX = 200;

/** Less room than this is said as a problem: a few scans' worth. */
export const WATCH_LOW_SPACE_BYTES = 200 * 1024 * 1024;

const VERIFY_NAMES: Record<WatchVerifyCheck, string> = {
  exists: 'Whether it is there',
  folder: 'Whether it is a folder',
  inside: 'Whether it is inside the folders the vault may use',
  not_vault: 'Whether it is one of the vault’s own',
  read: 'Seeing into it',
  create: 'Making a file in it',
  move: 'Moving a file in it',
  delete: 'Deleting a file in it',
  space: 'How much room there is',
};

/** One check, in plain words: what passed, or what is wrong and what to do. */
export function watchVerifyWords(
  check: WatchVerifyCheck,
  ok: boolean | null,
  freeBytes: number | null = null,
): string {
  if (ok === null) return `${VERIFY_NAMES[check]}: not checked, as something before it failed.`;
  switch (check) {
    case 'exists':
      return ok
        ? 'The folder is there.'
        : 'There is nothing at that path in the worker. Check the folder’s mount in docker-compose.yml.';
    case 'folder':
      return ok ? 'It is a folder.' : 'That is a file, not a folder.';
    case 'inside':
      return ok
        ? 'It is inside the folders the vault may use, with no link out of them.'
        : 'It isn’t inside the folders the vault may use, or a link inside them leads out of them. Choose a folder inside them, with no links on the way.';
    case 'not_vault':
      return ok
        ? 'It isn’t one of the vault’s own folders.'
        : 'It is one of the vault’s own folders, or a folder above one. Choose another.';
    case 'read':
      return ok
        ? 'The vault can see what is in it.'
        : 'The vault can’t see what is in it. Give the folder to the containers’ user (uid 1000).';
    case 'create':
      return ok
        ? 'The vault can make a file in it.'
        : 'The vault can’t make a file in it, so it couldn’t keep scans or say why it rejected one. Give the folder to the containers’ user (uid 1000).';
    case 'move':
      return ok
        ? 'The vault can move a file in it.'
        : 'The vault can’t move a file in it, so it couldn’t set scans aside. Check the folder’s permissions.';
    case 'delete':
      return ok
        ? 'The vault can delete a file in it.'
        : 'The vault can’t delete a file in it, so scans would stay in it, not encrypted. Check the folder’s permissions.';
    case 'space':
      if (freeBytes === null) {
        return ok ? 'There is room in it.' : 'How much room there is couldn’t be told.';
      }
      return ok
        ? `There is ${spaceWords(freeBytes)} free.`
        : `There is only ${spaceWords(freeBytes)} free: the scanner may not be able to save into it.`;
  }
}

/** "12 GB", "3.4 GB", "640 MB", "12 KB". */
export function spaceWords(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 10) return `${Math.floor(gb)} GB`;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  if (mb >= 1) return `${Math.floor(mb)} MB`;
  return `${Math.max(0, Math.floor(bytes / 1024))} KB`;
}

/** A Verify's findings, in words, as the API answers them. */
export function watchVerifyResult(f: WatchVerifyFound): WatchVerifyResult {
  const steps = f.steps.map((s) => ({
    check: s.check,
    ok: s.ok,
    words: watchVerifyWords(s.check, s.ok, f.free_bytes),
  }));
  const ok = steps.length > 0 && steps.every((s) => s.ok === true);
  const failed = steps.find((s) => s.ok === false);
  return {
    path: f.path,
    ok,
    steps,
    free_bytes: f.free_bytes,
    words: ok
      ? `${f.path} is ready for scans.`
      : failed
        ? `${f.path} can’t be used yet. ${failed.words}`
        : `${f.path} couldn’t be checked.`,
  };
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
    case 'refused':
      return `The vault won’t use ${dir ?? 'that folder'}: it is one of the vault’s own folders or a folder above one, it isn’t inside the folders set aside for scanners (FDV_WATCH_ROOTS), or a link leads out of them. Choose another folder.`;
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
 * (`/` between parts): anything under `rejected/` or (0.9.0) `processed/`, a hidden file or folder
 * (a name starting with `.`), a name a program writes while it is still
 * saving (`~…`, `….tmp`, `….part`), and an operating system's own files.
 */
export function watchIgnored(relPath: string): boolean {
  const parts = relPath.split('/').filter((p) => p.length > 0);
  if (parts.length === 0) return true;
  if (parts[0] === WATCH_REJECTED_DIR || parts[0] === WATCH_PROCESSED_DIR) return true;
  if (parts.some((p) => p.startsWith('.'))) return true;
  const name = (parts[parts.length - 1] as string).toLowerCase();
  if (name.startsWith('~')) return true;
  if (name.endsWith('.tmp') || name.endsWith('.part')) return true;
  return NOT_SCANS.has(name);
}
