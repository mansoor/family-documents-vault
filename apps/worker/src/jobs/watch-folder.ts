import { createHash, createHmac, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import * as fsp from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { type ScopeKeys } from '@fdv/crypto';
import { withSystem, type Db } from '@fdv/db';
import {
  dropFileName,
  itemFolder,
  localToday,
  UPLOAD_KINDS,
  WATCH_INCOMPLETE_GRACE_MS,
  WATCH_NOTICE_DAYS,
  WATCH_POLL_MS,
  WATCH_PROCESSED_DIR,
  WATCH_PROCESSED_MARKER,
  WATCH_REJECTED_DIR,
  WATCH_REJECTED_TITLE,
  WATCH_STABLE_MS,
  watchIgnored,
  watchPathRefusal,
  watchRejectWords,
  type WatchDirState,
  type WatchPause,
  type WatchRejectReason,
} from '@fdv/shared';
import type pg from 'pg';
import {
  AdvisoryLock,
  arriveItem,
  clearStaleItem,
  discardItem,
  placeItem,
  storeItem,
  whoseInbox,
  whyOf,
  type Target,
} from './intake-ingest.js';

/**
 * A watched folder for network scanners (0.8.0, S3, CAP-10).
 *
 * The operator mounts a folder into this container (FDV_WATCH_DIR, say
 * ./scanner:/watch) and points the household's scanner at that folder over
 * SMB or FTP. Every WATCH_POLL_MS one worker — whichever holds a Postgres
 * advisory lock (WATCH_LOCK_KEY), on a connection of its own, kept alive,
 * checked in pg_locks before every file — looks in the folder. Polling, not
 * inotify: bind mounts on Docker Desktop deliver no events.
 *
 *  - It says how it found the folder (watch_dir): the API offers the scanner
 *    folder only when it is set, there and writable, and said so lately.
 *  - It finds the household that has it on, and whose Inbox it fills. That
 *    person must still be of the family, with a sign-in that may add
 *    documents, not locked nor waiting after a restore; the vault must open
 *    their key and have somewhere to keep files; and their batch of the day
 *    must have room. Otherwise it is paused, and says why (watch_folder),
 *    and the files wait. All of it is asked again, held, as each file is
 *    placed: an owner who turns it off or points it elsewhere mid-round
 *    stops the round there.
 *  - What it reads, moves and deletes it checks to be inside the folder,
 *    just before: the walk never follows a link or a junction (lstat), and
 *    each folder it walks is, by its real path, inside the folder's. A file
 *    is opened with O_NOFOLLOW, and the handle must be the very file listed
 *    (device and inode, and since 0.9.0 its change time and size), a plain file with one link, and inside the folder
 *    by its real path — on Linux the handle's own (/proc/self/fd), elsewhere
 *    the name's, whose lstat must be the handle's file. Every byte is read
 *    from that handle. A name is linked, renamed or unlinked only while its
 *    folder's real path is inside the folder's and lstat shows the file
 *    listed. (A swap in the instant between that check and the call itself
 *    is the one gap left: the system has no call that checks as it acts.)
 *  - A file is taken once its size and time have not changed for
 *    FDV_WATCH_STABLE_SECONDS, seen twice, and it looks complete for its
 *    kind (a PDF's %%EOF, a JPEG's end, a PNG's IEND, a zip's directory,
 *    and, but for a TIFF, no tail of zeros); one that does not is waited
 *    for FDV_WATCH_INCOMPLETE_GRACE_SECONDS and then taken anyway — the
 *    reader flags a page that is bad. Hidden files, names a program writes while it
 *    saves (`~…`, `….tmp`, `….part`) and `rejected/` are left alone.
 *  - It is hashed, and then added as Add → Many documents adds a file (the
 *    API's BatchService.addItem): an item of that person's batch of the day
 *    ("Scanner, 12 Oct"), on its way first, its bytes counted, hashed and
 *    encrypted under a new key wrapped by their own member key straight to
 *    its object, then arrived — and the worker's batch.previews job draws
 *    its pages, reads it and proposes for it, with their own rules (I2, I4).
 *  - Only once the item has arrived is the file deleted: no plaintext
 *    lingers. A worker that stops between storing and deleting finds the
 *    item next time by the file's SHA-256 among that person's scanner items
 *    waiting or accepted, and deletes the file without adding it twice; one
 *    removed from the Inbox since is added again. One that stops while it is
 *    on its way leaves an item its Idempotency-Key finds, removed before the
 *    file is added again. A stored file that cannot be deleted is said once
 *    in the log, and counted for the owners (stuck_files).
 *  - What cannot be added is moved to `rejected/<name>` (0700), and then its
 *    person told (watch_notice, once a file), with `<name>.txt` (0600, made
 *    new, never through a link) saying why in plain words. Moved by a hard
 *    link and an unlink (or a copy from the handle), never over another
 *    name; a file that could not be opened, by a rename onto a free name. One
 *    that cannot be moved is left in place, its person told so once, and
 *    counted for the owners with the stored files not deleted.
 *  - `stop` stops between files, and aborts a file on its way: its row and
 *    object are removed then (as a worker that stopped mid-file would have
 *    them removed on the next start, by the Idempotency-Key).
 *
 * The bytes are only ever streamed through: nothing parses them here but
 * the first and last few, compared with the kinds' own (watchKindOf,
 * looksComplete). A file's words are read by the batch job, in its tools'
 * own processes, as any item's are.
 *
 * The subfolder a file was in (0.8.0, S2) — "Passports/Ahmed" — is kept
 * with its item as Add → Many documents keeps a folder's: sealed under the
 * item's own key (`itemFolder`, itemFolderBinding), never plain and never
 * logged, to suggest its kind, whose it is and tags to its person alone.
 *
 * Since 0.9.0 (O1):
 *
 *  - The folder is the one an owner chose in Settings, or FDV_WATCH_DIR.
 *    A folder chosen must be inside one of the roots (FDV_WATCH_ROOTS, and
 *    FDV_WATCH_DIR) by its real path — no link out of them — and none of
 *    the vault's own folders (ownDirs: where it keeps files and backups,
 *    its temporary folders, the app, Docker's secrets), nor inside one, nor
 *    above one. Asked every round (dirState), of every household's folder
 *    chosen; one refused is never looked in.
 *  - A file safely stored is not deleted at once but kept (keep): moved to
 *    processed/<the household's date>/, its subfolders kept under it, by
 *    the same move as rejected/'s — never over another name ("name (2)"),
 *    only the very file listed — and deleted once it has been there longer
 *    than the owner's number of days (prune): only a file whose device and
 *    inode are still what was listed, a plain file, in a real folder
 *    inside. 0 days deletes it at once, as before. processed/ is never
 *    taken from, and made 0700.
 */

/** The advisory lock one worker holds while it watches: beside migrate's 7401 and the tests' 7402. */
export const WATCH_LOCK_KEY = 7403;

/** At most this many files are added a round: the rest wait for the next. */
export const WATCH_ROUND_MAX = 25;

/** At most this many entries are looked at, this many folders deep. */
const WALK_MAX_ENTRIES = 5000;
const WALK_MAX_DEPTH = 10;

/** A file that could not be moved, or deleted once stored, is left alone this long before it is tried again. */
const RETRY_MS = 10 * 60_000;

/** processed/ is looked through for scans kept long enough at most this often. */
const PRUNE_EVERY_MS = 60_000;

/** A day, for the days scans are kept. */
const DAY_MS = 24 * 60 * 60_000;

/** At most this many households' folders are looked at a round. */
const CHOSEN_MAX = 50;

/** The first bytes a kind is told from (the API's sniffStream reads as many), and the last a file's end is. */
const HEAD_BYTES = 4100;
const TAIL_BYTES = 1024;

/** Read from a handle this much at a time. */
const CHUNK = 1024 * 1024;

type Log = (level: string, msg: string, extra?: Record<string, unknown>) => void;

export interface WatchDeps {
  /** The owning role: the folder's state, and which household has it on. */
  admin: pg.Pool;
  /** The application role, as the vault itself in one household (withSystem). */
  db: Db;
  keys: ScopeKeys;
  credentialsKey: Buffer;
  localRoot: string;
  log: Log;
  /** The key a file's Idempotency-Key is made with (deriveKey(master, WATCH_KEY_PURPOSE)). */
  itemKey: Buffer;
  /** FDV_MAX_UPLOAD_BYTES: the most one file may be, as for an upload. */
  maxBytes: number;
  /** A household's batch.previews job: the items' pages drawn and read. */
  sendBatchPreviews: (householdId: string) => Promise<void>;
}

/** What the itemKey is derived for. */
export const WATCH_KEY_PURPOSE = 'watch-folder-items';

export interface WatchOptions {
  /** FDV_WATCH_DIR: null when it is not set. The folder used unless an owner chose another. */
  dir: string | null;
  /**
   * FDV_WATCH_ROOTS (0.9.0, O1): the folders an owner may choose the
   * scanner folder inside. FDV_WATCH_DIR is one too. Left out (the tests of
   * S3): no folder may be chosen, and without FDV_WATCH_DIR the runner
   * looks at nothing.
   */
  roots?: readonly string[];
  /**
   * The vault's own folders (O1), which no folder may be, be inside or be
   * above: where it keeps files and backups, its temporary folders, the
   * app, Docker's secrets (WATCH_SYSTEM_DIRS and the worker's own).
   */
  ownDirs?: readonly string[];
  /** Where the lock's own connection goes (DATABASE_URL: a direct connection, never a transaction pooler). */
  lockUrl: string;
  pollMs?: number;
  /** FDV_WATCH_STABLE_SECONDS, in ms. */
  stableMs?: number;
  roundMax?: number;
  /** The clock, for the tests. */
  now?: () => number;
  /** The file system, for the tests that cannot make a folder read-only, or swap one mid-round. */
  fs?: WatchFs;
  /** FDV_WATCH_INCOMPLETE_GRACE_SECONDS, in ms: how long a file that looks unfinished waits. */
  incompleteGraceMs?: number;
  /** Tests: held just before a file is placed, for the races. */
  beforePlace?: (rel: string) => Promise<void>;
  /** Tests: held just before a kept scan due to go is checked and deleted, for the races. */
  beforeExpire?: (abs: string) => Promise<void>;
}

/** What is asked of the file system: node's own, unless a test stands in. */
export interface WatchFs {
  stat: typeof fsp.stat;
  lstat: typeof fsp.lstat;
  realpath: typeof fsp.realpath;
  readlink: typeof fsp.readlink;
  access: typeof fsp.access;
  writeFile: typeof fsp.writeFile;
  unlink: typeof fsp.unlink;
  readdir: typeof fsp.readdir;
  link: typeof fsp.link;
  rename: typeof fsp.rename;
  mkdir: typeof fsp.mkdir;
  open: typeof fsp.open;
  /** An empty folder removed (0.9.0, O1: processed/'s days once their scans have gone). */
  rmdir: typeof fsp.rmdir;
  /** How much room there is (O1: Verify). */
  statfs: typeof fsp.statfs;
}

export const nodeFs: WatchFs = {
  stat: fsp.stat,
  lstat: fsp.lstat,
  realpath: fsp.realpath,
  readlink: fsp.readlink,
  access: fsp.access,
  writeFile: fsp.writeFile,
  unlink: fsp.unlink,
  readdir: fsp.readdir,
  link: fsp.link,
  rename: fsp.rename,
  mkdir: fsp.mkdir,
  open: fsp.open,
  rmdir: fsp.rmdir,
  statfs: fsp.statfs,
};

const code = (err: unknown) => (err as NodeJS.ErrnoException | null)?.code ?? '';

/** A file's device and inode, as the system has them (exactly: bigint). */
const idOf = (st: Pick<BigIntStats, 'dev' | 'ino'>) => `${st.dev}:${st.ino}`;

/**
 * And the moment its inode last changed, and its size (0.9.0, O1): with its
 * device and inode, a file's identity. A file put in another's place may
 * be given the very inode just freed (Linux reuses them at once), never
 * that moment too — so a reused inode is never taken for the file listed.
 */
const stampOf = (st: Pick<BigIntStats, 'ctimeNs' | 'size'>) => `${st.ctimeNs}:${st.size}`;

/** A kept scan's whole identity: device, inode, change time and size. */
const keptId = (st: Pick<BigIntStats, 'dev' | 'ino' | 'ctimeNs' | 'size'>) =>
  `${idOf(st)}:${stampOf(st)}`;

/**
 * A file's birth time, where the file system gives one (statx's btime;
 * NTFS's): set once as the file is made, never by a chmod, an xattr, an
 * antivirus or Samba's DOS attributes, as its change time is (the O1
 * re-check, 1). Null where there is none (Node gives 0).
 */
export const bornOf = (st: Pick<BigIntStats, 'birthtimeNs'>): string | null =>
  st.birthtimeNs > 0n ? String(st.birthtimeNs) : null;

/**
 * Whether a file is the scan kept (the O1 re-check, 1): `same` — its device,
 * inode and size, and its birth time where both have one, else its change
 * time too; `changed` — its device, inode and size, but no birth time to
 * tell and its change time moved: maybe it, maybe a file given its inode;
 * `other` — another file.
 */
export function keptMatch(
  st: Pick<BigIntStats, 'dev' | 'ino' | 'ctimeNs' | 'size' | 'birthtimeNs'>,
  rec: { file_id: string; born: string | null },
): 'same' | 'changed' | 'other' {
  const [dev, ino, ctime, size] = rec.file_id.split(':');
  if (`${st.dev}` !== dev || `${st.ino}` !== ino || `${st.size}` !== size) return 'other';
  const born = bornOf(st);
  if (rec.born && born) return rec.born === born ? 'same' : 'other';
  return `${st.ctimeNs}` === ctime ? 'same' : 'changed';
}

/** What the worker last said of a household's kept scans. */
interface KeptSaid {
  kept_left: number;
  kept_changed: number;
  kept_untracked: number;
  kept_reconcile: boolean;
}

/** Whether a real path is the folder's, or inside it. */
export const within = (root: string, real: string) =>
  real === root || real.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** A name for a note: its control characters gone, its folders each so. */
const cleanRel = (rel: string) => rel.split('/').map(dropFileName).join('/');

/** Why a hard link could not be made where a copy will do: another file system, none taken, or refused. */
const LINKLESS = ['EXDEV', 'EPERM', 'ENOTSUP', 'ENOSYS', 'EOPNOTSUPP', 'EMLINK'];

/** Opened with no link followed at its last part (O_NOFOLLOW where the system has it). */
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

// ------------------------------------------------------------- the folder

/**
 * What a folder is checked against (0.9.0, O1): the roots it must be inside
 * (null: none asked, as for FDV_WATCH_DIR, the operator's own), and the
 * vault's own folders it must be none of, nor inside, nor above.
 */
export interface WatchPlaceRules {
  roots: readonly string[] | null;
  ownDirs: readonly string[];
}

/**
 * The vault's own folders by identity (the O1 review, M4): each one's
 * device and inode, and those of every folder above one (but the system's
 * root). A path compared by name misses a bind mount of the same folder
 * elsewhere; its device and inode do not.
 */
export interface OwnIds {
  own: Set<string>;
  above: Set<string>;
}

export async function ownIdsOf(ownDirs: readonly string[], fsx: WatchFs = nodeFs): Promise<OwnIds> {
  const out: OwnIds = { own: new Set(), above: new Set() };
  for (const d of ownDirs) {
    if (!path.isAbsolute(d)) continue;
    const st = await fsx.stat(d, { bigint: true }).catch(() => null);
    if (!st) continue;
    out.own.add(idOf(st));
    for (let p = path.dirname(path.resolve(d)); p !== path.dirname(p); p = path.dirname(p)) {
      const up = await fsx.stat(p, { bigint: true }).catch(() => null);
      if (up) out.above.add(idOf(up));
    }
  }
  return out;
}

/**
 * Where a folder is (0.9.0, O1): inside one of the roots by its real path
 * (no link inside them leads out of them) and, unless `real` says the path
 * is a real path already, by its name too; and whether it is one of the
 * vault's own folders, inside one, or above one — by name, by real path, and
 * (the O1 review, M4) by device and inode, of the folder and of every folder
 * above it. Null when it is not there.
 */
export async function placeOf(
  dir: string,
  rules: WatchPlaceRules,
  fsx: WatchFs = nodeFs,
  opts: { real?: boolean; ids?: OwnIds } = {},
): Promise<{ inside: boolean; own: boolean; withinOwn: boolean } | null> {
  const real = await fsx.realpath(dir).catch(() => null);
  if (!real) return null;
  const named = path.resolve(dir);
  const realOf = async (p: string) => (await fsx.realpath(p).catch(() => null)) ?? path.resolve(p);
  let inside = true;
  if (rules.roots) {
    const roots = rules.roots.filter((r) => path.isAbsolute(r));
    const realRoots = await Promise.all(roots.map(realOf));
    if (!realRoots.some((r) => within(r, real))) inside = false;
    if (!opts.real) {
      // As written, on the worker's own system: no `..`, no doubled slash, under a root.
      if (path.sep === '/' && watchPathRefusal(dir, roots, []) !== null) inside = false;
      if (!roots.some((r) => within(path.resolve(r), named))) inside = false;
    }
  }
  const own: string[] = [];
  for (const d of rules.ownDirs) {
    if (!path.isAbsolute(d)) continue;
    own.push(path.resolve(d), await realOf(d));
  }
  const overlaps = (a: string, b: string) => within(a, b) || within(b, a);
  let isOwn = own.some((o) => overlaps(o, real) || overlaps(o, named));
  let withinOwn = own.some((o) => within(o, real) || within(o, named));
  // By identity: the folder itself one of the vault's own or above one, or
  // any folder above it one of the vault's own.
  const ids = opts.ids ?? (await ownIdsOf(rules.ownDirs, fsx));
  const self = await fsx.stat(real, { bigint: true }).catch(() => null);
  if (self && (ids.own.has(idOf(self)) || ids.above.has(idOf(self)))) {
    isOwn = true;
    if (ids.own.has(idOf(self))) withinOwn = true;
  }
  for (let p = path.dirname(real); p !== path.dirname(p); p = path.dirname(p)) {
    const up = await fsx.stat(p, { bigint: true }).catch(() => null);
    if (up && ids.own.has(idOf(up))) {
      isOwn = true;
      withinOwn = true;
    }
  }
  return { inside, own: isOwn, withinOwn };
}

/** How a folder was found, and, when it may be used, the real path and identity it was found at. */
export interface WatchDirExam {
  state: WatchDirState;
  /** Its real path, and device and inode, when it is ready: what a round pins. */
  real: string | null;
  id: string | null;
}

/**
 * How the folder is: not set, there, a folder, one the vault may use, and
 * one the vault can write in — a file written and removed (a hidden one,
 * which nothing takes), in the folder by its real path. A folder it cannot
 * write in is no use: a file could not be deleted once stored, nor moved to
 * rejected/. Nothing is written in a folder the vault may not use, and the
 * folder must still be the one checked once the probe is gone (M1).
 */
export async function examineWatchDir(
  dir: string | null,
  fsx: WatchFs = nodeFs,
  rules: WatchPlaceRules = { roots: null, ownDirs: [] },
  ids?: OwnIds,
): Promise<WatchDirExam> {
  const no = (state: WatchDirState): WatchDirExam => ({ state, real: null, id: null });
  if (!dir) return no('off');
  if (!path.isAbsolute(dir)) return no('refused');
  try {
    const st = await fsx.stat(dir);
    if (!st.isDirectory()) return no('not_a_folder');
  } catch (err) {
    return no(code(err) === 'ENOTDIR' ? 'not_a_folder' : 'missing');
  }
  const place = await placeOf(dir, rules, fsx, ids ? { ids } : {});
  if (!place) return no('missing');
  if (!place.inside || place.own) return no('refused');
  const real = await fsx.realpath(dir).catch(() => null);
  const st = real ? await fsx.lstat(real, { bigint: true }).catch(() => null) : null;
  if (!real || !st || !st.isDirectory() || st.isSymbolicLink()) return no('refused');
  const id = idOf(st);
  try {
    await fsx.access(real, constants.R_OK | constants.W_OK | constants.X_OK);
    const probe = path.join(real, `.fdv-probe-${randomBytes(6).toString('hex')}`);
    await fsx.writeFile(probe, '', { flag: 'wx', mode: 0o600 });
    await fsx.unlink(probe);
  } catch {
    return no('not_writable');
  }
  return { state: 'ready', real, id };
}

/** How the folder is: examineWatchDir's state alone. */
export async function checkWatchDir(
  dir: string | null,
  fsx: WatchFs = nodeFs,
  rules: WatchPlaceRules = { roots: null, ownDirs: [] },
): Promise<WatchDirState> {
  return (await examineWatchDir(dir, fsx, rules)).state;
}

/**
 * The roots a folder may be chosen inside, and those refused (the O1
 * review, M4): `/`, or one of the vault's own folders or above one, by name
 * or by device and inode.
 */
export async function acceptedRoots(
  roots: readonly string[],
  ownDirs: readonly string[],
  fsx: WatchFs = nodeFs,
): Promise<{ accepted: string[]; refused: string[] }> {
  const ids = await ownIdsOf(ownDirs, fsx);
  const accepted: string[] = [];
  const refused: string[] = [];
  for (const r of roots) {
    if (!path.isAbsolute(r)) {
      refused.push(r);
      continue;
    }
    const at = path.resolve(r);
    if (at === path.parse(at).root) {
      refused.push(r);
      continue;
    }
    const byName = ownDirs.some((o) => path.isAbsolute(o) && within(at, path.resolve(o)));
    const st = await fsx.stat(at, { bigint: true }).catch(() => null);
    const byId = st !== null && (ids.own.has(idOf(st)) || ids.above.has(idOf(st)));
    if (byName || byId) refused.push(r);
    else accepted.push(r);
  }
  return { accepted, refused };
}

/** A file in the folder: its path from the folder (`/` between parts), size, time and identity. */
export interface WatchFile {
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
  /** Device and inode, as listed: what is opened, moved and deleted must still be it. */
  id: string;
  /**
   * Its change time and size, as listed (0.9.0, O1): with `id`, so a file
   * given the inode of the one listed is never taken for it.
   */
  stamp: string;
}

/**
 * Every file in the folder and the folders inside it, but what is left
 * alone (watchIgnored), up to WALK_MAX_ENTRIES, WALK_MAX_DEPTH deep. Never
 * through a link or a junction (lstat, entry by entry); and each folder,
 * looked at again just before it is read, must be a folder whose real path
 * is inside the folder's — and none of the vault's own, nor above one, by
 * device and inode (the O1 review, M4: a bind mount of one inside it).
 */
export async function listWatchFiles(
  dir: string,
  fsx: WatchFs = nodeFs,
  ids: OwnIds = { own: new Set(), above: new Set() },
  /**
   * The folder as a round pinned it (M1): its real path must still be that
   * device and inode, inside the roots and none of the vault's own, checked
   * on the real path — else nothing is listed.
   */
  pinned?: { id: string; rules: WatchPlaceRules },
): Promise<WatchFile[]> {
  const root = await fsx.realpath(dir);
  const out: WatchFile[] = [];
  if (pinned) {
    const st = await fsx.lstat(root, { bigint: true }).catch(() => null);
    if (!st || !st.isDirectory() || st.isSymbolicLink() || idOf(st) !== pinned.id) return out;
    const place = await placeOf(root, pinned.rules, fsx, { real: true, ids });
    if (!place || !place.inside || place.own) return out;
  }
  let seen = 0;
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > WALK_MAX_DEPTH) return;
    const here = rel ? path.join(dir, ...rel.split('/')) : dir;
    if (rel) {
      const st = await fsx.lstat(here, { bigint: true }).catch(() => null);
      if (!st || !st.isDirectory() || st.isSymbolicLink()) return;
      if (ids.own.has(idOf(st)) || ids.above.has(idOf(st))) return;
      const real = await fsx.realpath(here).catch(() => null);
      if (!real || !within(root, real)) return;
    }
    let entries;
    try {
      entries = await fsx.readdir(here, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (++seen > WALK_MAX_ENTRIES) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (watchIgnored(r)) continue;
      const abs = path.join(here, e.name);
      const st = await fsx.lstat(abs, { bigint: true }).catch(() => null);
      if (!st || st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        await walk(r, depth + 1);
      } else if (st.isFile()) {
        out.push({
          rel: r,
          abs,
          size: Number(st.size),
          mtimeMs: Number(st.mtimeMs),
          id: idOf(st),
          stamp: stampOf(st),
        });
      }
    }
  };
  await walk('', 0);
  return out;
}

/**
 * The kind a file is, from its first bytes and, for a Word or Excel file (a
 * zip inside), its name: the kinds the vault keeps (UPLOAD_KINDS), or null.
 * Their first bytes compared, and nothing parsed.
 */
export function watchKindOf(head: Buffer, name: string): { mime: string; ext: string } | null {
  const at = (offset: number, bytes: number[] | string) => {
    const want = typeof bytes === 'string' ? Buffer.from(bytes, 'latin1') : Buffer.from(bytes);
    return (
      head.length >= offset + want.length &&
      head.subarray(offset, offset + want.length).equals(want)
    );
  };
  const kind = (mime: string) => ({ mime, ext: UPLOAD_KINDS[mime] as string });
  if (at(0, '%PDF')) return kind('application/pdf');
  if (at(0, [0xff, 0xd8, 0xff])) return kind('image/jpeg');
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return kind('image/png');
  if (at(0, [0x49, 0x49, 0x2a, 0x00]) || at(0, [0x4d, 0x4d, 0x00, 0x2a])) {
    return kind('image/tiff');
  }
  if (at(0, [0x49, 0x49, 0x2b, 0x00]) || at(0, [0x4d, 0x4d, 0x00, 0x2b])) {
    return kind('image/tiff');
  }
  if (at(0, 'RIFF') && at(8, 'WEBP')) return kind('image/webp');
  if (at(4, 'ftyp')) {
    if (at(8, 'heic') || at(8, 'heix')) return kind('image/heic');
    if (at(8, 'mif1')) return kind('image/heif');
    return null;
  }
  if (at(0, [0x50, 0x4b, 0x03, 0x04])) {
    const ext = path.extname(name).toLowerCase();
    if (ext === '.docx') {
      return kind('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    }
    if (ext === '.xlsx') {
      return kind('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    }
  }
  return null;
}

/**
 * Whether a file looks complete for its kind, from its first and last
 * bytes: a PDF's `%%EOF` near its end, a JPEG's end marker near its end, a
 * PNG's IEND, a zip's end-of-directory record, a WebP whose size says this
 * size — and, but for a TIFF (whose last strip may be blank paper), no tail
 * all zeros (space a program set aside and has not written). Compared, never
 * parsed. Only a hint: a file that stays "unfinished" past its grace is
 * taken anyway (a motion photo, a PDF with more after its end).
 */
export function looksComplete(mime: string, head: Buffer, tail: Buffer, size: number): boolean {
  if (tail.length === 0) return false;
  if (mime !== 'image/tiff' && tail.every((b) => b === 0)) return false;
  const has = (s: string | number[]) =>
    tail.includes(typeof s === 'string' ? Buffer.from(s, 'latin1') : Buffer.from(s));
  switch (mime) {
    case 'application/pdf':
      return has('%%EOF');
    case 'image/jpeg':
      return has([0xff, 0xd9]);
    case 'image/png':
      return has('IEND');
    case 'image/webp':
      return head.length >= 8 && head.readUInt32LE(4) + 8 === size;
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return has([0x50, 0x4b, 0x05, 0x06]);
    default:
      return true;
  }
}

/**
 * A file's Idempotency-Key: a keyed hash of its household, its path in the
 * folder, its size, its time and its SHA-256, made a UUID. The same file is
 * the same key, every time; the key says nothing of the file.
 */
export function watchItemKey(
  key: Buffer,
  householdId: string,
  f: Pick<WatchFile, 'rel' | 'size' | 'mtimeMs'>,
  sha256: Buffer | null = null,
): string {
  const h = createHmac('sha256', key)
    .update(
      `${householdId}\0${f.rel}\0${f.size}\0${Math.trunc(f.mtimeMs)}\0${sha256?.toString('hex') ?? ''}`,
    )
    .digest();
  // As a version 8 UUID (RFC 9562: custom), so the column takes it.
  h[6] = ((h[6] as number) & 0x0f) | 0x80;
  h[8] = ((h[8] as number) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** A handle's bytes, `size` of them, chunk by chunk from the start: never through its name again. */
async function* bytesOf(
  fh: FileHandle,
  size: number,
  signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  let at = 0;
  while (at < size) {
    signal?.throwIfAborted();
    const buf = Buffer.alloc(Math.min(CHUNK, size - at));
    const { bytesRead } = await fh.read(buf, 0, buf.length, at);
    if (bytesRead === 0) break;
    at += bytesRead;
    yield buf.subarray(0, bytesRead);
  }
}

// ------------------------------------------------------------- the round

/** What became of one file. */
export type WatchOutcome =
  | { kind: 'added'; itemId: string }
  | { kind: 'already' }
  | { kind: 'rejected'; reason: WatchRejectReason; as: string }
  | { kind: 'paused'; reason: WatchPause }
  /** Stopped changing but not complete yet: waited for (WATCH_INCOMPLETE_MS). */
  | { kind: 'waiting' }
  /** The round stops here: the setting changed under it, the lock was lost, or the worker stops. */
  | { kind: 'stopped'; why: string }
  /** Not now — changed as it was read, gone, its batch being removed, a blip — tried next round. */
  | { kind: 'later'; why: string };

/** What a round did. */
export interface WatchRound {
  /** Whether this worker holds the lock, and so looked. */
  ran: boolean;
  state?: WatchDirState;
  paused?: WatchPause | null;
  outcomes: Array<{ rel: string } & WatchOutcome>;
}

/** An open file, checked: the handle, its identity and its size. */
interface Opened {
  fh: FileHandle;
  st: BigIntStats;
}

/**
 * The scanner folder's one runner. `start` looks every pollMs, a round at
 * a time; `tick` is one round, for the tests. Only the worker holding the
 * advisory lock looks; the others try for it each round, so one takes over
 * when its holder stops.
 */
export class WatchRunner {
  private readonly fs: WatchFs;
  private readonly now: () => number;
  private readonly lock: AdvisoryLock;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<WatchRound> | null = null;
  private stopped = false;
  private readonly abort = new AbortController();
  /** The folder looked in this round (the one chosen, or FDV_WATCH_DIR), and its real path. */
  private dir = '';
  private root = '';
  /** The folder's device and inode as checked this round: it must stay that folder (the O1 review, M1). */
  private rootId = '';
  /** The refused roots last said in the log. */
  private refusedSaid = '';
  /** How many days what is stored is kept in processed/ this round (0: deleted at once). */
  private keepDays = 0;
  /** When each folder's processed/ was last looked through. */
  private readonly pruned = new Map<string, number>();
  /** A kept scan that could not be moved to processed/: said once. */
  private keepSaid = false;
  /** The scan kept by the file being taken, and its record: looked at again once its handle is closed. */
  private justKept: { hh: string; id: string; at: string; st: BigIntStats } | null = null;
  /** Each file as last seen, and since when it has not changed. */
  private readonly seen = new Map<string, { size: number; mtimeMs: number; since: number }>();
  /** Files left alone until then: could not be moved to rejected/. */
  private readonly held = new Map<string, number>();
  /** Files stored that could not be deleted: said once, counted, tried again after RETRY_MS. */
  private readonly stuck = new Map<string, { id: string; retry: number }>();
  /** Files meant for rejected/ that could not be moved there: counted with the stuck ones. */
  private readonly unmovable = new Map<string, { id: string }>();
  /** Files that stopped changing but did not look complete, since when. */
  private readonly unfinished = new Map<string, { id: string; since: number; said: boolean }>();
  /** The stuck count the owners were last told. */
  private told = -1;

  constructor(
    private readonly deps: WatchDeps,
    private readonly opts: WatchOptions,
  ) {
    this.fs = opts.fs ?? nodeFs;
    this.now = opts.now ?? Date.now;
    this.lock = new AdvisoryLock(WATCH_LOCK_KEY, opts.lockUrl, deps.log, 'the scanner folder');
  }

  /** Whether this worker holds the lock now. */
  get holding(): boolean {
    return this.lock.holding;
  }

  /** Looks every pollMs from now on, a round at a time. */
  start(): void {
    const next = () => {
      if (this.stopped) return;
      this.timer = setTimeout(() => {
        void this.tick()
          .catch((err: unknown) =>
            this.deps.log('warn', 'the scanner folder could not be looked at', {
              err: whyOf(err),
            }),
          )
          .finally(next);
      }, this.opts.pollMs ?? WATCH_POLL_MS);
      this.timer.unref?.();
    };
    void this.tick()
      .catch(() => undefined)
      .finally(next);
  }

  /**
   * Stops looking: between files, and a file on its way aborted (its row
   * and object removed), then lets go of the lock.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    if (this.timer) clearTimeout(this.timer);
    await this.running?.catch(() => undefined);
    await this.lock.letGo();
  }

  /** One round: never two at once. */
  async tick(): Promise<WatchRound> {
    if (this.running) return this.running;
    this.running = this.round().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /**
   * The folders a folder may be chosen inside: FDV_WATCH_ROOTS, and
   * FDV_WATCH_DIR — but `/` and any holding one of the vault's own (the O1
   * review, M4), which are refused and said once.
   */
  private async roots(): Promise<{ accepted: string[]; refused: string[] }> {
    const asked = [...(this.opts.roots ?? [])];
    if (this.opts.dir && !asked.includes(this.opts.dir)) asked.push(this.opts.dir);
    const r = await acceptedRoots(asked, this.opts.ownDirs ?? [], this.fs);
    const said = r.refused.join('\0');
    if (r.refused.length && said !== this.refusedSaid) {
      this.deps.log('warn', 'scanner roots refused: / or a folder holding the vault’s own', {
        roots: r.refused,
      });
    }
    this.refusedSaid = said;
    return r;
  }

  /**
   * How a folder is, and whether it may be used (O1): a folder an owner
   * chose must be inside the roots by its real path; any folder, chosen or
   * FDV_WATCH_DIR, must be none of the vault's own. Asked every round.
   */
  private examine(dir: string, chosen: boolean, roots: string[], ids: OwnIds) {
    return examineWatchDir(
      dir,
      this.fs,
      { roots: chosen ? roots : null, ownDirs: this.opts.ownDirs ?? [] },
      ids,
    );
  }

  /**
   * The folder still as it was checked (the O1 review, M1): its name leads
   * to the very real path and folder (device and inode) the check found,
   * not a link put in its place since; and that real path is still inside
   * the roots (a folder chosen) and none of the vault's own. Asked once a
   * round is to look in it; rootHeld asks the cheap part before each file.
   */
  private async pin(chosen: boolean, roots: string[], ids: OwnIds): Promise<boolean> {
    const real = await this.fs.realpath(this.dir).catch(() => null);
    if (real !== this.root || !(await this.rootHeld())) return false;
    const place = await placeOf(
      this.root,
      { roots: chosen ? roots : null, ownDirs: this.opts.ownDirs ?? [] },
      this.fs,
      { real: true, ids },
    );
    return place !== null && place.inside && !place.own;
  }

  /** The folder's real path is still the folder pinned: no link, the same device and inode. */
  private async rootHeld(): Promise<boolean> {
    const st = await this.fs.lstat(this.root, { bigint: true }).catch(() => null);
    return st !== null && st.isDirectory() && !st.isSymbolicLink() && idOf(st) === this.rootId;
  }

  private async round(): Promise<WatchRound> {
    const out: WatchRound = { ran: false, outcomes: [] };
    if (this.stopped) return out;
    const envDir = this.opts.dir;
    if (!envDir && (this.opts.roots ?? []).length === 0) {
      // Not set here: said, unless a worker that has it said otherwise just now.
      await this.deps.admin.query(
        `insert into watch_dir (singleton, dir, state, checked_at) values (true, null, 'off', now())
         on conflict (singleton) do update set dir = null, state = 'off', checked_at = now()
          where watch_dir.state = 'off' or watch_dir.checked_at < now() - interval '1 minute'`,
      );
      out.state = 'off';
      return out;
    }
    if (!(await this.lock.hold(this.stopped))) return out;
    out.ran = true;
    const ownDirs = this.opts.ownDirs ?? [];
    const ids = await ownIdsOf(ownDirs, this.fs);
    const { accepted: roots, refused } = await this.roots();
    const exams = new Map<string, WatchDirExam>();
    const envExam = envDir
      ? await this.examine(envDir, false, roots, ids)
      : { state: 'off' as const, real: null, id: null };
    const envState = envExam.state;
    out.state = envState;
    await this.deps.admin.query(
      `insert into watch_dir (singleton, dir, state, roots, own_dirs, refused_roots, checked_at)
       values (true, $1, $2, $3, $4, $5, now())
       on conflict (singleton) do update
         set dir = $1, state = $2, roots = $3, own_dirs = $4, refused_roots = $5, checked_at = now()`,
      [envDir, envState, roots, [...ownDirs], refused],
    );
    // What nobody dismissed in WATCH_NOTICE_DAYS goes.
    await this.deps.admin.query(
      `delete from watch_notice where created_at < now() - make_interval(days => $1)`,
      [WATCH_NOTICE_DAYS],
    );
    const { rows: all } = await this.deps.admin.query<{
      household_id: string;
      enabled: boolean;
      member_id: string | null;
      paused_reason: WatchPause | null;
      dir: string | null;
      keep_days: number;
      processed_foreign: boolean;
      kept_left: number;
      kept_changed: number;
      kept_untracked: number;
      kept_reconcile: boolean;
    }>(
      `select household_id, enabled, member_id, paused_reason, dir, keep_days,
              processed_foreign, kept_left, kept_changed, kept_untracked, kept_reconcile
         from watch_folder
        where enabled or dir is not null
        order by enabled desc, household_id limit $1`,
      [CHOSEN_MAX],
    );
    // Each folder chosen, as it is now — every round, never once: what
    // Settings says of it, and whether it may be turned on.
    for (const r of all) {
      if (!r.dir) continue;
      const e = exams.get(r.dir) ?? (await this.examine(r.dir, true, roots, ids));
      exams.set(r.dir, e);
      await withSystem(this.deps.db, r.household_id, (trx) =>
        trx
          .updateTable('watch_folder')
          .set({
            dir_state: e.state === 'off' ? 'missing' : e.state,
            dir_seen: r.dir,
            dir_checked_at: new Date(),
          })
          .where('household_id', '=', r.household_id)
          .execute(),
      );
    }
    const examOf = (r: { dir: string | null }): WatchDirExam =>
      r.dir ? (exams.get(r.dir) as WatchDirExam) : envExam;

    const setting = all.find((r) => r.enabled);
    // Kept scans go once kept long enough: the enabled household's alone, by
    // its own days, wherever the vault kept them while that folder may
    // still be used (the O1 review, M2, L1, L2).
    if (setting) {
      const inUse = examOf(setting);
      await this.prune(
        setting.household_id,
        setting.keep_days,
        roots,
        ids,
        setting,
        inUse.state === 'ready' ? inUse.real : null,
      ).catch((err: unknown) =>
        this.deps.log('warn', 'kept scans could not be looked through', { err: whyOf(err) }),
      );
    }
    const dir = setting ? (setting.dir ?? envDir) : null;
    const exam = setting ? examOf(setting) : envExam;
    if (setting) out.state = exam.state;
    if (setting && (!dir || exam.state !== 'ready')) {
      // Not paused for its person's sake while the folder is not there at all.
      await this.paused(setting.household_id, setting.paused_reason, null);
      await this.tellStuck(setting.household_id, null);
      return out;
    }
    if (!setting || !dir) {
      this.seen.clear();
      return out;
    }
    if (dir !== this.dir || exam.real !== this.root) {
      // Another folder: nothing seen of the last one counts.
      for (const m of [this.seen, this.held, this.stuck, this.unmovable, this.unfinished]) {
        m.clear();
      }
    }
    this.dir = dir;
    this.root = exam.real as string;
    this.rootId = exam.id as string;
    // Still the folder checked, as it is to be looked in (M1): a folder
    // swapped for a link since is refused for this round, and nothing in
    // it touched.
    if (!(await this.pin(setting.dir !== null, roots, ids))) {
      this.deps.log('warn', 'the scanner folder changed after it was checked: not looked in');
      out.state = 'refused';
      await this.tellStuck(setting.household_id, null);
      return out;
    }
    this.keepDays = setting.keep_days;
    const hh = setting.household_id;
    await this.sayProcessed(hh, setting.processed_foreign);
    const target = setting.member_id
      ? await whoseInbox(this.deps.db, hh, setting.member_id, this.now())
      : { pause: 'removed' as const };
    if ('pause' in target) {
      out.paused = target.pause;
      await this.paused(hh, setting.paused_reason, target.pause);
      await this.tellStuck(hh, null);
      return out;
    }

    const files = await listWatchFiles(this.root, this.fs, ids, {
      id: this.rootId,
      rules: { roots: setting.dir !== null ? roots : null, ownDirs },
    });
    const ready = this.settled(files);
    let added = 0;
    let pause: WatchPause | null = null;
    for (const f of ready.slice(0, this.opts.roundMax ?? WATCH_ROUND_MAX)) {
      if (this.stopped) break;
      if (!(await this.lock.still())) {
        out.outcomes.push({ rel: f.rel, kind: 'stopped', why: 'the lock was lost' });
        break;
      }
      if (!(await this.rootHeld())) {
        out.outcomes.push({ rel: f.rel, kind: 'stopped', why: 'the folder changed' });
        break;
      }
      const r = await this.take(target, f).catch((err: unknown): WatchOutcome => ({
        kind: 'later',
        why: whyOf(err),
      }));
      out.outcomes.push({ rel: f.rel, ...r });
      if (r.kind === 'added') added++;
      if (r.kind === 'added' || r.kind === 'already' || r.kind === 'rejected') {
        this.seen.delete(f.rel);
        this.unfinished.delete(f.rel);
      }
      if (r.kind === 'later') {
        this.deps.log('warn', 'a scanned file is to be tried again', {
          why: r.why.slice(0, 200),
        });
      }
      if (r.kind === 'paused') {
        pause = r.reason;
        break;
      }
      if (r.kind === 'stopped') break;
    }
    out.paused = pause;
    await this.paused(hh, setting.paused_reason, pause);
    await this.tellStuck(hh, files);
    if (added > 0) {
      await withSystem(this.deps.db, hh, (trx) =>
        trx
          .updateTable('watch_folder')
          .set({ last_added_at: new Date() })
          .where('household_id', '=', hh)
          .execute(),
      );
      await this.deps.sendBatchPreviews(hh).catch((err: unknown) =>
        this.deps.log('warn', 'could not ask for scanned files’ pages', {
          err: whyOf(err),
        }),
      );
      this.deps.log('info', 'scanned files added', { household: hh, added });
    }
    return out;
  }

  /**
   * Whether the folder has a processed/ the vault did not make (M2): said
   * to the owners once it changes. The vault keeps no scans in one.
   */
  private async sayProcessed(hh: string, was: boolean): Promise<void> {
    const top = path.join(this.root, WATCH_PROCESSED_DIR);
    const st = await this.fs.lstat(top).catch(() => null);
    let foreign = false;
    if (st) {
      const marker = await this.fs.lstat(path.join(top, WATCH_PROCESSED_MARKER)).catch(() => null);
      foreign =
        !st.isDirectory() ||
        st.isSymbolicLink() ||
        !marker ||
        !marker.isFile() ||
        marker.isSymbolicLink();
    }
    if (foreign === was) return;
    await withSystem(this.deps.db, hh, (trx) =>
      trx
        .updateTable('watch_folder')
        .set({ processed_foreign: foreign })
        .where('household_id', '=', hh)
        .execute(),
    );
  }

  /** Why the folder is paused, said once it changes: the worker's word, read by Settings. */
  private async paused(hh: string, was: WatchPause | null, now: WatchPause | null) {
    if (was === now) return;
    await withSystem(this.deps.db, hh, (trx) =>
      trx
        .updateTable('watch_folder')
        .set({ paused_reason: now, paused_at: now ? new Date() : null })
        .where('household_id', '=', hh)
        .execute(),
    );
    if (now) this.deps.log('info', 'the scanner folder is paused', { household: hh, why: now });
  }

  /**
   * How many files the worker has dealt with are still in the folder —
   * stored but not deleted, or meant for rejected/ but not moved — told to
   * the owners at the end of every round that has the folder on. With the
   * folder listed (`files`), those no longer there are let go first. A round
   * that ends before it lists the folder (paused, the folder not ready)
   * cannot tell which are still there, so the owners keep the last count
   * known: this worker's own as of its last listing, or, before it has one
   * (just started), what the database already says.
   */
  private async tellStuck(hh: string, files: WatchFile[] | null) {
    if (files) {
      const here = new Map(files.map((f) => [f.rel, f.id]));
      for (const map of [this.stuck, this.unmovable]) {
        for (const [rel, s] of [...map]) if (here.get(rel) !== s.id) map.delete(rel);
      }
    } else if (this.told === -1) {
      return;
    }
    const n = this.stuck.size + this.unmovable.size;
    if (n === this.told) return;
    await withSystem(this.deps.db, hh, (trx) =>
      trx
        .updateTable('watch_folder')
        .set({ stuck_files: n })
        .where('household_id', '=', hh)
        .execute(),
    );
    this.told = n;
  }

  /** The files whose size and time have stood still since stableMs ago, seen twice. */
  private settled(files: WatchFile[]): WatchFile[] {
    const now = this.now();
    const stable = this.opts.stableMs ?? WATCH_STABLE_MS;
    const here = new Set<string>();
    const ready: WatchFile[] = [];
    for (const f of files) {
      here.add(f.rel);
      const held = this.held.get(f.rel);
      if (held !== undefined && held > now) continue;
      const stuck = this.stuck.get(f.rel);
      if (stuck && stuck.id === f.id && stuck.retry > now) continue;
      const was = this.seen.get(f.rel);
      if (!was || was.size !== f.size || was.mtimeMs !== f.mtimeMs) {
        this.seen.set(f.rel, { size: f.size, mtimeMs: f.mtimeMs, since: now });
      } else if (now - was.since >= stable) {
        ready.push(f);
      }
    }
    for (const map of [this.seen, this.held, this.unfinished]) {
      for (const rel of [...map.keys()]) if (!here.has(rel)) map.delete(rel);
    }
    return ready;
  }

  /**
   * The file opened, and checked to be the very file listed, inside the
   * folder: O_NOFOLLOW, then on the handle a plain file of the listed
   * device, inode, change time and size — and the file's real path inside the folder's: on
   * Linux the handle's own (/proc/self/fd); elsewhere the name's real path,
   * whose lstat must be the handle's device and inode. Or why not: skipped
   * (`later`), or unreadable.
   */
  private async open(f: WatchFile): Promise<Opened | { later: string } | { unreadable: true }> {
    let fh: FileHandle;
    try {
      fh = await this.fs.open(f.abs, READ_FLAGS);
    } catch (err) {
      const c = code(err);
      if (c === 'ENOENT' || c === 'ELOOP' || c === 'EMLINK' || c === 'ENOTDIR') {
        return { later: `not the file listed (${c})` };
      }
      return { unreadable: true };
    }
    try {
      const st = await fh.stat({ bigint: true });
      if (!st.isFile() || idOf(st) !== f.id || stampOf(st) !== f.stamp) {
        throw new Error('not the file listed');
      }
      if (!(await this.rootHeld())) throw new Error('the folder changed');
      if (process.platform === 'linux') {
        const real = await this.fs.readlink(`/proc/self/fd/${fh.fd}`);
        if (!within(this.root, real)) throw new Error('outside the folder');
      } else {
        const real = await this.fs.realpath(f.abs);
        if (!within(this.root, real)) throw new Error('outside the folder');
        const there = await this.fs.lstat(real, { bigint: true });
        if (idOf(there) !== idOf(st)) throw new Error('not the file opened');
      }
      return { fh, st };
    } catch (err) {
      await fh.close().catch(() => undefined);
      return { later: whyOf(err) };
    }
  }

  /**
   * Whether the name is still the file listed, inside the folder: its
   * folder's real path under the folder's, and the name a plain file (no
   * link) of the listed device, inode, change time and size. Asked just before anything is
   * linked, renamed or unlinked.
   */
  private async stillThere(f: WatchFile): Promise<boolean> {
    if (!(await this.rootHeld())) return false;
    const parent = await this.fs.realpath(path.dirname(f.abs)).catch(() => null);
    if (!parent || !within(this.root, parent)) return false;
    const st = await this.fs.lstat(f.abs, { bigint: true }).catch(() => null);
    return (
      st !== null &&
      st.isFile() &&
      !st.isSymbolicLink() &&
      idOf(st) === f.id &&
      stampOf(st) === f.stamp
    );
  }

  /** One file, taken: added, found added already, rejected, waited for — or why not now. */
  private async take(t: Target, f: WatchFile): Promise<WatchOutcome> {
    const opened = await this.open(f);
    if ('later' in opened) return { kind: 'later', why: opened.later };
    if ('unreadable' in opened) {
      // Not to be read: only the very file listed, still inside, is moved
      // aside or named in a note. Anything else is left alone, unnamed.
      if (!(await this.stillThere(f))) return { kind: 'later', why: 'not the file listed' };
      return this.reject(t, f, 'unreadable', null);
    }
    const { fh, st } = opened;
    try {
      return await this.takeOpen(t, f, fh, st);
    } finally {
      await fh.close().catch(() => undefined);
      await this.keptClosed().catch(() => undefined);
    }
  }

  /**
   * A scan just kept, as it is once its handle is closed: some systems
   * (Windows) mark a file changed as its last handle closes. Its record is
   * brought up to that change time while it is still that file — the same
   * device, inode and size — so that the record is the file as it stays.
   */
  private async keptClosed(): Promise<void> {
    const k = this.justKept;
    this.justKept = null;
    if (!k) return;
    const now = await this.fs.lstat(k.at, { bigint: true }).catch(() => null);
    if (!now || !now.isFile() || now.isSymbolicLink()) return;
    if (idOf(now) !== idOf(k.st) || now.size !== k.st.size || keptId(now) === keptId(k.st)) return;
    await withSystem(this.deps.db, k.hh, (trx) =>
      trx
        .updateTable('watch_kept')
        .set({ file_id: keptId(now) })
        .where('id', '=', k.id)
        .where('file_id', '=', keptId(k.st))
        .execute(),
    );
  }

  private async takeOpen(
    t: Target,
    f: WatchFile,
    fh: FileHandle,
    st: BigIntStats,
  ): Promise<WatchOutcome> {
    const hh = t.householdId;
    const size = Number(st.size);
    if (st.nlink !== 1n) return this.reject(t, f, 'linked', fh);
    if (size === 0) return this.reject(t, f, 'empty', fh);
    if (size > this.deps.maxBytes) return this.reject(t, f, 'too_large', fh);
    const head = Buffer.alloc(Math.min(HEAD_BYTES, size));
    const tail = Buffer.alloc(Math.min(TAIL_BYTES, size));
    try {
      await fh.read(head, 0, head.length, 0);
      await fh.read(tail, 0, tail.length, size - tail.length);
    } catch {
      return this.reject(t, f, 'unreadable', fh);
    }
    const name = dropFileName(path.basename(f.abs));
    const kind = watchKindOf(head, name);
    if (!kind) return this.reject(t, f, 'unsupported', fh);
    if (!looksComplete(kind.mime, head, tail, size)) {
      const was = this.unfinished.get(f.rel);
      const since = was && was.id === f.id ? was.since : this.now();
      this.unfinished.set(f.rel, { id: f.id, since, said: was?.said ?? false });
      if (this.now() - since < (this.opts.incompleteGraceMs ?? WATCH_INCOMPLETE_GRACE_MS)) {
        return { kind: 'waiting' };
      }
      // Its grace over: taken as it is. A file cut short has its pages
      // flagged by the reader, as any item's; said once, never named.
      const now = this.unfinished.get(f.rel);
      if (now && !now.said) {
        now.said = true;
        this.deps.log('info', 'a scanned file that looked unfinished is taken after its grace', {
          kind: kind.mime,
        });
      }
    }

    // Hashed first, from the handle: a file stored before is found by it.
    const firstHash = createHash('sha256');
    try {
      for await (const chunk of bytesOf(fh, size, this.abort.signal)) firstHash.update(chunk);
    } catch (err) {
      if (this.abort.signal.aborted) return { kind: 'stopped', why: 'the worker is stopping' };
      return { kind: 'later', why: `not read: ${whyOf(err)}` };
    }
    const sha = firstHash.digest();
    const key = watchItemKey(this.deps.itemKey, hh, f, sha);

    // Stored before, and waiting or accepted: the file only had to go. One
    // removed from the Inbox since is added again.
    const prior = await withSystem(this.deps.db, hh, (trx) =>
      trx
        .selectFrom('incoming_file as i')
        .innerJoin('intake_batch as b', 'b.id', 'i.batch_id')
        .select(['i.id'])
        .where('i.requester_member_id', '=', t.memberId)
        .where('b.watch_day', 'is not', null)
        .where('i.state', 'in', ['received', 'accepted'])
        .where('i.sha256', '=', sha)
        .executeTakeFirst(),
    );
    if (prior) {
      await this.remove(t, f, fh);
      return { kind: 'already' };
    }
    // On its way when a worker stopped: removed, and added again.
    await clearStaleItem(this.deps, hh, key);

    await this.opts.beforePlace?.(f.rel);
    // Its row, on its way, in the day's batch: holding its place — and the
    // setting and its person asked again, held, as it is placed.
    const placed = await withSystem(this.deps.db, hh, async (trx) => {
      const setting = await trx
        .selectFrom('watch_folder')
        .select(['enabled', 'member_id'])
        .where('household_id', '=', hh)
        .forShare()
        .executeTakeFirst();
      if (!setting?.enabled || setting.member_id !== t.memberId) {
        return { stop: 'the scanner folder was changed' };
      }
      // The subfolder it was in under the folder (S2): its folders, without its
      // own name, sealed with its row — never plain, never logged.
      return placeItem(trx, this.deps, t, 'scanner', this.now(), {
        name,
        key,
        folder: itemFolder(f.rel, { withFileName: true }),
      });
    });
    if ('stop' in placed) return { kind: 'stopped', why: placed.stop };
    if ('pause' in placed) return { kind: 'paused', reason: placed.pause };
    if ('later' in placed) return { kind: 'later', why: placed.later };

    // Its bytes, from the same handle, counted and hashed as they go,
    // encrypted straight to its object.
    let stored: Awaited<ReturnType<typeof storeItem>>;
    try {
      stored = await storeItem(
        placed,
        bytesOf(fh, size, this.abort.signal),
        this.deps.maxBytes,
        this.abort.signal,
      );
    } catch (err) {
      await discardItem(this.deps.db, placed);
      if (this.abort.signal.aborted) return { kind: 'stopped', why: 'the worker is stopping' };
      return { kind: 'later', why: `not stored: ${whyOf(err)}` };
    }
    // Changed as it was read — the scanner still writing after all: tried again.
    const after = await fh.stat({ bigint: true }).catch(() => null);
    if (
      !after ||
      stored.bytes !== size ||
      after.size !== st.size ||
      after.mtimeNs !== st.mtimeNs ||
      !stored.sha256.equals(sha)
    ) {
      await discardItem(this.deps.db, placed);
      return { kind: 'later', why: 'changed as it was read' };
    }

    const arrived = await arriveItem(this.deps.db, placed, { mime: kind.mime, ...stored });
    if (!arrived) {
      // Its batch removed as it arrived, or the database out of reach.
      await discardItem(this.deps.db, placed);
      return { kind: 'later', why: 'its batch went as it arrived' };
    }
    // Safely stored: the file goes. A worker that stops here finds the item next time.
    await this.remove(t, f, fh);
    return { kind: 'added', itemId: placed.id };
  }

  /**
   * The file, once stored, kept in processed/ for the owner's days (O1) —
   * or, with none, or where it cannot be kept, deleted — only while its
   * name is still the file stored. One that cannot be deleted is said once
   * in the log, counted for the owners, and tried again after RETRY_MS.
   */
  private async remove(t: Target, f: WatchFile, fh: FileHandle): Promise<void> {
    if (!(await this.stillThere(f))) return;
    if (this.keepDays > 0) {
      const kept = await this.keep(t, f, fh).catch((err: unknown) => {
        if (!this.keepSaid) {
          this.keepSaid = true;
          this.deps.log('warn', 'a stored scan could not be kept in processed/: it is deleted', {
            err: whyOf(err),
          });
        }
        return false;
      });
      if (kept) {
        this.stuck.delete(f.rel);
        return;
      }
      if (!(await this.stillThere(f))) return;
    }
    try {
      await this.fs.unlink(f.abs);
      this.stuck.delete(f.rel);
    } catch (err) {
      if (code(err) === 'ENOENT') return;
      const had = this.stuck.get(f.rel);
      this.stuck.set(f.rel, { id: f.id, retry: this.now() + RETRY_MS });
      if (!had || had.id !== f.id) {
        this.deps.log('warn', 'a scanned file is stored but could not be deleted from the folder', {
          err: whyOf(err),
        });
      }
    }
  }

  /**
   * rejected/, made 0700 the first time; and only ever a real folder inside
   * the folder, never a link to one.
   */
  private rejectedDir(): Promise<string | null> {
    return this.ownDir([WATCH_REJECTED_DIR]);
  }

  /**
   * A folder of the vault's own inside the folder, `parts` deep (rejected/,
   * processed/<day>/<subfolders>): each part made 0700 if it is not there,
   * and each, made or found, only ever a real folder inside the folder,
   * never a link to one. Null when one is not.
   */
  private async ownDir(parts: readonly string[], from = this.root): Promise<string | null> {
    let into = from;
    for (const part of parts) {
      into = path.join(into, part);
      await this.fs.mkdir(into, { mode: 0o700 }).catch((err: unknown) => {
        if (code(err) !== 'EEXIST') throw err;
      });
      const st = await this.fs.lstat(into);
      if (!st.isDirectory() || st.isSymbolicLink()) return null;
      const real = await this.fs.realpath(into);
      if (!within(this.root, real) || real === this.root) return null;
    }
    return into;
  }

  /**
   * processed/, the vault's own (the O1 review, M2): made 0700 with a
   * marker inside saying so; one that was there before the vault made it
   * (no marker) is never adopted — null, and scans are deleted as before.
   */
  private async processedDir(): Promise<string | null> {
    const top = path.join(this.root, WATCH_PROCESSED_DIR);
    const made = await this.fs.mkdir(top, { mode: 0o700 }).then(
      () => true,
      (err: unknown) => {
        if (code(err) !== 'EEXIST') throw err;
        return false;
      },
    );
    const st = await this.fs.lstat(top);
    if (!st.isDirectory() || st.isSymbolicLink()) return null;
    const real = await this.fs.realpath(top);
    if (!within(this.root, real) || real === this.root) return null;
    const marker = path.join(top, WATCH_PROCESSED_MARKER);
    if (made) {
      await this.fs.writeFile(
        marker,
        'This folder is the Family Document Vault’s: it keeps scans here once they are stored, and deletes them after the days set in Settings. It never touches anything else saved here, nor adds it.\n',
        { flag: 'wx', mode: 0o600 },
      );
    }
    const m = await this.fs.lstat(marker).catch(() => null);
    return m && m.isFile() && !m.isSymbolicLink() ? top : null;
  }

  /**
   * The file stored, kept (O1): moved to processed/<the household's
   * date>/ with the subfolders it was in, by the same move as rejected/'s
   * — the very file listed, never over another name ("name (2)") — and
   * recorded (watch_kept, the O1 review M2): the only files the vault ever
   * deletes there. False when the file listed is no longer there; a throw
   * when it could not be kept. Kept but not recorded, it is deleted at once
   * rather than left there for ever.
   */
  private async keep(t: Target, f: WatchFile, fh: FileHandle): Promise<boolean> {
    const top = await this.processedDir();
    if (!top) throw new Error('processed/ is not the vault’s own');
    const day = localToday(t.timezone, new Date(this.now()));
    const folders = f.rel.split('/').slice(0, -1);
    const into = await this.ownDir([day, ...folders], top);
    if (!into) throw new Error('processed/ is not a folder of its own');
    const as = await this.move(f, into, path.basename(f.abs), fh, false);
    if (as === null) return false;
    const kept = path.join(into, as);
    const st = await this.fs.lstat(kept, { bigint: true });
    const rel = [WATCH_PROCESSED_DIR, day, ...folders, as].join('/');
    try {
      const row = await withSystem(this.deps.db, t.householdId, (trx) =>
        trx
          .insertInto('watch_kept')
          .values({
            household_id: t.householdId,
            dir: this.root,
            rel,
            file_id: keptId(st),
            born: bornOf(st),
          })
          .returning('id')
          .executeTakeFirstOrThrow(),
      );
      this.justKept = { hh: t.householdId, id: row.id, at: kept, st };
    } catch (err) {
      const now = await this.fs.lstat(kept, { bigint: true }).catch(() => null);
      if (now && now.isFile() && !now.isSymbolicLink() && keptId(now) === keptId(st)) {
        await this.fs.unlink(kept).catch(() => undefined);
      }
      throw err;
    }
    return true;
  }

  /**
   * The scans the vault kept for a household (watch_kept), deleted once
   * kept longer than `days` — at most once a PRUNE_EVERY_MS, and only those
   * it recorded (the O1 review, M2): nothing else saved into processed/ is
   * ever touched. Wherever each was kept (L1), while that folder may still
   * be used: there, inside the roots, none of the vault's own, its
   * processed/ the vault's (its marker). A kept scan is deleted only while
   * it is a plain file, no link, in a real folder inside that processed/,
   * that is still the very file kept (keptMatch): its device, inode and
   * size, and its birth time where the file system gives one (the O1
   * re-check, 1) — else its change time. One whose change time moved with
   * no birth time to tell (Samba's DOS attributes, an antivirus, an xattr)
   * is left in place, its record kept, and counted (kept_changed). A record
   * whose file is gone, or is another file, is let go. Then the folders it
   * left empty go. Scans kept in a folder that may no longer be used are
   * counted for the owners (kept_left). After a restore, and while any are
   * left, the files in a processed/ of the vault's that it has no record of
   * are counted (kept_untracked), never deleted (the re-check, 2).
   */
  private async prune(
    hh: string,
    days: number,
    roots: string[],
    ids: OwnIds,
    said: KeptSaid,
    /** The folder in use this round, by its real path, when it is ready. */
    current: string | null,
  ): Promise<void> {
    const now = this.now();
    const last = this.pruned.get(hh);
    // A clock set back looks again at once.
    if (last !== undefined && now >= last && now - last < PRUNE_EVERY_MS) return;
    this.pruned.set(hh, now);
    const records = await withSystem(this.deps.db, hh, (trx) =>
      trx
        .selectFrom('watch_kept')
        .select(['id', 'dir', 'rel', 'file_id', 'born', 'kept_at'])
        .orderBy('kept_at')
        .limit(WALK_MAX_ENTRIES)
        .execute(),
    );
    const usable = new Map<string, string | null>();
    /** A folder kept scans are in, still to be used: its processed/'s real path; else null. */
    const processedOf = async (dir: string): Promise<string | null> => {
      if (usable.has(dir)) return usable.get(dir) as string | null;
      let top: string | null = null;
      const real = await this.fs.realpath(dir).catch(() => null);
      const st = real === dir ? await this.fs.lstat(dir).catch(() => null) : null;
      if (st && st.isDirectory() && !st.isSymbolicLink()) {
        const place = await placeOf(dir, { roots, ownDirs: this.opts.ownDirs ?? [] }, this.fs, {
          real: true,
          ids,
        });
        const p = path.join(dir, WATCH_PROCESSED_DIR);
        const pst = await this.fs.lstat(p).catch(() => null);
        const marker = await this.fs.lstat(path.join(p, WATCH_PROCESSED_MARKER)).catch(() => null);
        const preal = await this.fs.realpath(p).catch(() => null);
        if (
          place?.inside &&
          !place.own &&
          pst?.isDirectory() &&
          !pst.isSymbolicLink() &&
          marker?.isFile() &&
          !marker.isSymbolicLink() &&
          preal === p
        ) {
          top = p;
        }
      }
      usable.set(dir, top);
      return top;
    };
    let gone = 0;
    let left = 0;
    let changed = 0;
    const done: string[] = [];
    const emptied = new Map<string, string>();
    for (const r of records) {
      const top = await processedOf(r.dir);
      if (!top) {
        left += 1;
        continue;
      }
      const abs = path.join(r.dir, ...r.rel.split('/'));
      if (now - r.kept_at.getTime() < days * DAY_MS) continue;
      await this.opts.beforeExpire?.(abs);
      const parent = await this.fs.realpath(path.dirname(abs)).catch(() => null);
      const s = await this.fs.lstat(abs, { bigint: true }).catch(() => null);
      if (!s) {
        done.push(r.id);
        continue;
      }
      const match =
        parent && within(top, parent) && s.isFile() && !s.isSymbolicLink()
          ? keptMatch(s, r)
          : 'other';
      if (match === 'changed') {
        // Maybe the very scan, maybe not: never deleted, never forgotten.
        changed += 1;
        continue;
      }
      if (match === 'other') {
        // Not that very file any more: never deleted, and no longer the vault's.
        done.push(r.id);
        continue;
      }
      try {
        await this.fs.unlink(abs);
        gone += 1;
        done.push(r.id);
        emptied.set(path.dirname(abs), top);
      } catch (err) {
        if (code(err) === 'ENOENT') done.push(r.id);
        else this.deps.log('warn', 'a kept scan could not be deleted', { err: whyOf(err) });
      }
    }
    if (done.length) {
      await withSystem(this.deps.db, hh, (trx) =>
        trx.deleteFrom('watch_kept').where('id', 'in', done).execute(),
      );
    }
    // The folders a deleted scan left empty, up to its processed/: the deepest first.
    for (const [from, top] of [...emptied].sort((a, b) => b[0].length - a[0].length)) {
      for (let d = from; d !== top && within(top, d); d = path.dirname(d)) {
        const st = await this.fs.lstat(d).catch(() => null);
        const real = await this.fs.realpath(d).catch(() => null);
        if (!st || !st.isDirectory() || st.isSymbolicLink() || real !== d) break;
        const ok = await this.fs.rmdir(d).then(
          () => true,
          () => false,
        );
        if (!ok) break;
      }
    }
    // After a restore, and until none are left: what the vault has no record of.
    let untracked = said.kept_untracked;
    if (said.kept_reconcile || said.kept_untracked > 0) {
      const kept = new Set(
        records.filter((r) => !done.includes(r.id)).map((r) => `${r.dir}\0${r.rel}`),
      );
      const dirs = [...new Set([...(current ? [current] : []), ...records.map((r) => r.dir)])];
      untracked = 0;
      for (const dir of dirs) {
        const top = await processedOf(dir);
        if (top) untracked += await this.untracked(dir, top, kept);
      }
    }
    if (
      left !== said.kept_left ||
      changed !== said.kept_changed ||
      untracked !== said.kept_untracked ||
      said.kept_reconcile
    ) {
      await withSystem(this.deps.db, hh, (trx) =>
        trx
          .updateTable('watch_folder')
          .set({
            kept_left: left,
            kept_changed: changed,
            kept_untracked: untracked,
            kept_reconcile: false,
          })
          .where('household_id', '=', hh)
          .execute(),
      );
    }
    if (gone > 0) this.deps.log('info', 'kept scans deleted', { deleted: gone });
    if (changed > 0)
      this.deps.log('warn', 'kept scans changed since they were kept, left', { changed });
  }

  /**
   * The files in a processed/ of the vault's that it has no record of (the
   * O1 re-check, 2): counted, by a walk that follows no link, and never
   * deleted, moved or read.
   */
  private async untracked(dir: string, top: string, kept: Set<string>): Promise<number> {
    let n = 0;
    let seen = 0;
    const walk = async (here: string, depth: number): Promise<void> => {
      if (depth > WALK_MAX_DEPTH + 2) return;
      const entries = await this.fs.readdir(here, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (++seen > WALK_MAX_ENTRIES) return;
        const abs = path.join(here, e.name);
        const s = await this.fs.lstat(abs).catch(() => null);
        if (!s || s.isSymbolicLink()) continue;
        if (s.isDirectory()) {
          const real = await this.fs.realpath(abs).catch(() => null);
          if (real === abs && within(top, real)) await walk(abs, depth + 1);
        } else if (s.isFile()) {
          if (here === top && e.name === WATCH_PROCESSED_MARKER) continue;
          const rel = path.relative(dir, abs).split(path.sep).join('/');
          if (!kept.has(`${dir}\0${rel}`)) n += 1;
        }
      }
    };
    await walk(top, 0);
    return n;
  }

  /**
   * Moved to rejected/, then its person told (once a file), and a note
   * beside it saying why. Only the very file listed, still inside the
   * folder, is moved (move). One that cannot be moved — rejected/ not a
   * folder of its own, the move refused — is left where it is, its person
   * told once that it was left in place, counted for the owners, and tried
   * again later. Anything that is no longer the file listed is left alone,
   * and named to nobody.
   */
  private async reject(
    t: Target,
    f: WatchFile,
    reason: WatchRejectReason,
    fh: FileHandle | null,
  ): Promise<WatchOutcome> {
    const original = path.basename(f.abs);
    const tell = (leftInPlace: boolean) =>
      withSystem(this.deps.db, t.householdId, (trx) =>
        trx
          .insertInto('watch_notice')
          .values({
            household_id: t.householdId,
            member_id: t.memberId,
            file_name: [...dropFileName(original)].slice(0, 255).join(''),
            reason,
            left_in_place: leftInPlace,
            file_key: watchItemKey(this.deps.itemKey, t.householdId, f),
          })
          .onConflict((oc) =>
            leftInPlace
              ? oc.columns(['household_id', 'member_id', 'file_key']).doNothing()
              : oc
                  .columns(['household_id', 'member_id', 'file_key'])
                  .doUpdateSet({ left_in_place: false }),
          )
          .execute(),
      );
    const cannotMove = async (why: string): Promise<WatchOutcome> => {
      this.held.set(f.rel, this.now() + RETRY_MS);
      this.deps.log('warn', 'a scanned file could not be moved to rejected/', { err: why });
      if (!(await this.stillThere(f))) return { kind: 'later', why: 'not the file listed' };
      await tell(true);
      this.unmovable.set(f.rel, { id: f.id });
      return { kind: 'later', why: 'could not be moved to rejected/' };
    };
    let into: string | null;
    try {
      into = await this.rejectedDir();
    } catch (err) {
      return cannotMove(whyOf(err));
    }
    if (!into) return cannotMove('rejected/ is not a folder of its own');
    let as: string | null;
    try {
      as = await this.move(f, into, original, fh, true);
    } catch (err) {
      return cannotMove(whyOf(err));
    }
    if (as === null) return { kind: 'later', why: 'not the file listed' };
    this.unmovable.delete(f.rel);
    await tell(false);
    const words = watchRejectWords(reason, this.deps.maxBytes);
    const when = new Date(this.now()).toLocaleString('en-GB', {
      timeZone: t.timezone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    const shown = dropFileName(original);
    const where = cleanRel(f.rel);
    const note = [
      `${WATCH_REJECTED_TITLE}.`,
      '',
      `File: ${shown}${where !== shown ? ` (it was ${where})` : ''}`,
      `When: ${when}`,
      `Why: ${words}`,
      '',
      'The vault kept no copy of it. Anything in this folder is not encrypted:',
      'delete this file and this note once you have dealt with them.',
      '',
    ].join('\n');
    await this.fs
      .writeFile(path.join(into, `${as}.txt`), note, { flag: 'wx', mode: 0o600 })
      .catch((err: unknown) =>
        this.deps.log('warn', 'a rejected scan’s note could not be written', { err: whyOf(err) }),
      );
    this.deps.log('info', 'a scanned file was moved to rejected/', { why: reason });
    return { kind: 'rejected', reason, as };
  }

  /**
   * The file listed moved into rejected/ (or, kept, processed/<day>/) under
   * a name nothing has (lstat; for rejected/, its note's name too): the
   * name it went by, null when the file listed is no longer there (gone,
   * changed, or its folder no longer inside) — nothing done — and a throw
   * when it is but could not be moved. Before anything is linked, renamed or
   * unlinked, the name is asked again (stillThere).
   *
   *  - Opened (a handle): a hard link, never over another name, whose new
   *    name must then be the file listed, and the old name unlinked; where
   *    no link can be made (another file system, a folder that takes none,
   *    or a file the link is refused for), a new file copied from the
   *    handle — removed again if the copy fails or is aborted.
   *  - Not to be opened (no handle): renamed onto a name lstat says is free.
   */
  private async move(
    f: WatchFile,
    into: string,
    name: string,
    fh: FileHandle | null,
    withNote: boolean,
  ): Promise<string | null> {
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    const free = async (c: string) => {
      for (const n of withNote ? [c, `${c}.txt`] : [c]) {
        if (
          await this.fs.lstat(path.join(into, n)).then(
            () => true,
            () => false,
          )
        )
          return false;
      }
      return true;
    };
    for (let n = 1; n < 1000; n++) {
      const candidate = n === 1 ? name : `${stem} (${n})${ext}`;
      if (!(await free(candidate))) continue;
      if (!(await this.stillThere(f))) return null;
      const to = path.join(into, candidate);
      if (!fh) {
        await this.fs.rename(f.abs, to);
        return candidate;
      }
      try {
        await this.fs.link(f.abs, to);
      } catch (err) {
        const c = code(err);
        if (c === 'EEXIST') continue;
        if (!LINKLESS.includes(c)) throw err;
        if (!(await this.copy(fh, to))) continue;
        if (await this.stillThere(f)) await this.fs.unlink(f.abs);
        return candidate;
      }
      // The new name must be the very file listed; else it is taken back.
      const linked = await this.fs.lstat(to, { bigint: true }).catch(() => null);
      if (!linked || idOf(linked) !== f.id || `${linked.size}` !== f.stamp.split(':')[1]) {
        await this.fs.unlink(to).catch(() => undefined);
        return null;
      }
      // The link itself changed the file's change time: the old name must
      // now be that very file, as it is since the link.
      if (!(await this.stillThere({ ...f, stamp: stampOf(linked) }))) return candidate;
      try {
        await this.fs.unlink(f.abs);
      } catch (err) {
        await this.fs.unlink(to).catch(() => undefined);
        throw err;
      }
      return candidate;
    }
    throw new Error(`no name free in ${path.basename(into)}`);
  }

  /** A new file at `to` (never over one), copied from the handle; false when the name was taken. */
  private async copy(fh: FileHandle, to: string): Promise<boolean> {
    const out = await this.fs.open(to, 'wx', 0o600).catch((e: unknown) => {
      if (code(e) === 'EEXIST') return null;
      throw e;
    });
    if (!out) return false;
    try {
      const st = await fh.stat({ bigint: true });
      for await (const chunk of bytesOf(fh, Number(st.size), this.abort.signal)) {
        await out.write(chunk);
      }
      await out.close();
      return true;
    } catch (err) {
      await out.close().catch(() => undefined);
      await this.fs.unlink(to).catch(() => undefined);
      throw err;
    }
  }
}
