import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import * as fsp from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { EncryptStream, newKey, wrapKey, type ScopeKeys } from '@fdv/crypto';
import { withSystem, type Db } from '@fdv/db';
import {
  BATCH_MAX_FILES,
  INCOMING_KEEP_DAYS,
  dropFileName,
  scannerDay,
  UPLOAD_KINDS,
  WATCH_INCOMPLETE_MS,
  WATCH_NOTICE_DAYS,
  WATCH_POLL_MS,
  WATCH_REJECTED_DIR,
  WATCH_REJECTED_TITLE,
  WATCH_STABLE_MS,
  watchIgnored,
  watchPauseOf,
  watchRejectWords,
  type WatchDirState,
  type WatchPause,
  type WatchRejectReason,
} from '@fdv/shared';
import pg from 'pg';
import { adapterOf } from './incoming.js';

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
 *  - Nothing outside the folder is ever read, written or removed. The walk
 *    never follows a link or a junction (lstat), and each folder it walks
 *    is, by its real path, inside the folder's. A file is opened with
 *    O_NOFOLLOW, and the handle must be the very file listed (device and
 *    inode), a plain file with one link, and — on Linux — inside the folder
 *    by its real path (/proc/self/fd). Every byte is read from that handle.
 *    A name is deleted or moved only while it is still that file.
 *  - A file is taken once its size and time have not changed for
 *    FDV_WATCH_STABLE_SECONDS, seen twice, and it looks complete for its
 *    kind (a PDF's %%EOF, a JPEG's end, a PNG's IEND, a zip's directory,
 *    and no tail of zeros); one that does not is waited for, and a day on
 *    rejected as `incomplete`. Hidden files, names a program writes while it
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
 *  - What cannot be added is moved to `rejected/<name>` (0700), its person
 *    told first (watch_notice, once a file), with `<name>.txt` (0600, made
 *    new, never through a link) saying why in plain words. Moved by a hard
 *    link and an unlink, never over another file.
 *  - `stop` stops between files, and aborts a file on its way: its row and
 *    object are removed then (as a worker that stopped mid-file would have
 *    them removed on the next start, by the Idempotency-Key).
 *
 * The bytes are only ever streamed through: nothing parses them here but
 * the first and last few, compared with the kinds' own (watchKindOf,
 * looksComplete). A file's words are read by the batch job, in its tools'
 * own processes, as any item's are.
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

/** The first bytes a kind is told from (the API's sniffStream reads as many), and the last a file's end is. */
const HEAD_BYTES = 4100;
const TAIL_BYTES = 1024;

/** Read from a handle this much at a time. */
const CHUNK = 1024 * 1024;

/** An upload this old, still on its way, holds no place in its batch (the API's UPLOAD_FRESH_MS). */
const UPLOAD_FRESH_MS = 15 * 60_000;

const DAY = 864e5;

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
  /** FDV_WATCH_DIR: null when it is not set. */
  dir: string | null;
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
  /** Tests: held just before a file is placed, for the races. */
  beforePlace?: (rel: string) => Promise<void>;
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
  mkdir: typeof fsp.mkdir;
  open: typeof fsp.open;
}

const nodeFs: WatchFs = {
  stat: fsp.stat,
  lstat: fsp.lstat,
  realpath: fsp.realpath,
  readlink: fsp.readlink,
  access: fsp.access,
  writeFile: fsp.writeFile,
  unlink: fsp.unlink,
  readdir: fsp.readdir,
  link: fsp.link,
  mkdir: fsp.mkdir,
  open: fsp.open,
};

const code = (err: unknown) => (err as NodeJS.ErrnoException | null)?.code ?? '';

/**
 * Why, for the log: an error's code where it has one — a file system's
 * message names the file and its folders, and a database's can carry a
 * value — and otherwise the start of its message. Never a file's name.
 */
const whyOf = (err: unknown) => {
  const c = code(err);
  if (c) return c;
  const m = err instanceof Error ? err.message : String(err);
  return m.replace(/(['"`]).*?\1/g, '…').slice(0, 120);
};

/** A file's identity: its device and inode, as the system has them (exactly: bigint). */
const idOf = (st: Pick<BigIntStats, 'dev' | 'ino'>) => `${st.dev}:${st.ino}`;

/** Whether a real path is the folder's, or inside it. */
export const within = (root: string, real: string) =>
  real === root || real.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** A name for a note: its control characters gone, its folders each so. */
const cleanRel = (rel: string) => rel.split('/').map(dropFileName).join('/');

/** Opened with no link followed at its last part (O_NOFOLLOW where the system has it). */
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

// ------------------------------------------------------------- the folder

/**
 * How the folder is: not set, there, a folder, and one the vault can write
 * in — a file written and removed (a hidden one, which nothing takes). A
 * folder it cannot write in is no use: a file could not be deleted once
 * stored, nor moved to rejected/.
 */
export async function checkWatchDir(
  dir: string | null,
  fsx: WatchFs = nodeFs,
): Promise<WatchDirState> {
  if (!dir) return 'off';
  try {
    const st = await fsx.stat(dir);
    if (!st.isDirectory()) return 'not_a_folder';
  } catch (err) {
    return code(err) === 'ENOTDIR' ? 'not_a_folder' : 'missing';
  }
  try {
    await fsx.access(dir, constants.R_OK | constants.W_OK | constants.X_OK);
    const probe = path.join(dir, `.fdv-probe-${randomBytes(6).toString('hex')}`);
    await fsx.writeFile(probe, '', { flag: 'wx', mode: 0o600 });
    await fsx.unlink(probe);
    return 'ready';
  } catch {
    return 'not_writable';
  }
}

/** A file in the folder: its path from the folder (`/` between parts), size, time and identity. */
export interface WatchFile {
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
  /** Device and inode, as listed: what is opened, moved and deleted must still be it. */
  id: string;
}

/**
 * Every file in the folder and the folders inside it, but what is left
 * alone (watchIgnored), up to WALK_MAX_ENTRIES, WALK_MAX_DEPTH deep. Never
 * through a link or a junction (lstat, entry by entry); and each folder,
 * looked at again just before it is read, must be a folder whose real path
 * is inside the folder's.
 */
export async function listWatchFiles(dir: string, fsx: WatchFs = nodeFs): Promise<WatchFile[]> {
  const root = await fsx.realpath(dir);
  const out: WatchFile[] = [];
  let seen = 0;
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > WALK_MAX_DEPTH) return;
    const here = rel ? path.join(dir, ...rel.split('/')) : dir;
    if (rel) {
      const st = await fsx.lstat(here).catch(() => null);
      if (!st || !st.isDirectory() || st.isSymbolicLink()) return;
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
 * bytes: a PDF's `%%EOF` near its end, a JPEG's end marker, a PNG's IEND, a
 * zip's end-of-directory record, a WebP whose size says this size — and no
 * kind's tail all zeros (space a program set aside and has not written).
 * Compared, never parsed.
 */
export function looksComplete(mime: string, head: Buffer, tail: Buffer, size: number): boolean {
  if (tail.length === 0 || tail.every((b) => b === 0)) return false;
  const has = (s: string | number[]) =>
    tail.includes(typeof s === 'string' ? Buffer.from(s, 'latin1') : Buffer.from(s));
  switch (mime) {
    case 'application/pdf':
      return has('%%EOF');
    case 'image/jpeg':
      return tail.length >= 2 && tail[tail.length - 2] === 0xff && tail[tail.length - 1] === 0xd9;
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

/** Whose Inbox, as they are now: the household's, the person, their sign-in. */
interface Target {
  householdId: string;
  memberId: string;
  accountId: string;
  timezone: string;
}

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
  private lock: pg.Client | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<WatchRound> | null = null;
  private stopped = false;
  private readonly abort = new AbortController();
  /** The folder's real path, as of this round. */
  private root = '';
  /** Each file as last seen, and since when it has not changed. */
  private readonly seen = new Map<string, { size: number; mtimeMs: number; since: number }>();
  /** Files left alone until then: could not be moved to rejected/. */
  private readonly held = new Map<string, number>();
  /** Files stored that could not be deleted: said once, counted, tried again after RETRY_MS. */
  private readonly stuck = new Map<string, { id: string; retry: number }>();
  /** Files that stopped changing but did not look complete, since when. */
  private readonly unfinished = new Map<string, { id: string; since: number }>();
  /** The stuck count the owners were last told. */
  private told = -1;

  constructor(
    private readonly deps: WatchDeps,
    private readonly opts: WatchOptions,
  ) {
    this.fs = opts.fs ?? nodeFs;
    this.now = opts.now ?? Date.now;
  }

  /** Whether this worker holds the lock now. */
  get holding(): boolean {
    return this.lock !== null;
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
    await this.letGo();
  }

  /** One round: never two at once. */
  async tick(): Promise<WatchRound> {
    if (this.running) return this.running;
    this.running = this.round().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async letGo(): Promise<void> {
    const c = this.lock;
    this.lock = null;
    if (c) {
      await c.query('select pg_advisory_unlock($1)', [WATCH_LOCK_KEY]).catch(() => undefined);
      await c.end().catch(() => undefined);
    }
  }

  /**
   * Whether this connection still holds the lock, by pg_locks: a session
   * lock on a connection that has gone is no lock, and a pooler that hands
   * the session to somebody else would show it (README: a direct connection).
   */
  private async stillHolding(): Promise<boolean> {
    const c = this.lock;
    if (!c) return false;
    try {
      const { rows } = await c.query<{ held: boolean }>(
        `select exists (select 1 from pg_locks
                         where locktype = 'advisory' and pid = pg_backend_pid() and granted
                           and classid = 0 and objid = $1 and objsubid = 1) as held`,
        [WATCH_LOCK_KEY],
      );
      if (rows[0]?.held) return true;
    } catch {
      // Gone with its connection.
    }
    await this.letGo();
    return false;
  }

  /**
   * The lock, held on a connection of its own, kept alive, for as long as
   * this worker lives: asked for once a round until it is had, and checked
   * (stillHolding) at each round and before each file while it is.
   */
  private async holdLock(): Promise<boolean> {
    if (this.lock && (await this.stillHolding())) return true;
    if (this.stopped) return false;
    const c = new pg.Client({ connectionString: this.opts.lockUrl, keepAlive: true });
    c.on('error', () => {
      if (this.lock === c) this.lock = null;
      void c.end().catch(() => undefined);
    });
    try {
      await c.connect();
      const { rows } = await c.query<{ got: boolean }>('select pg_try_advisory_lock($1) as got', [
        WATCH_LOCK_KEY,
      ]);
      if (rows[0]?.got) {
        this.lock = c;
        this.deps.log('info', 'this worker watches the scanner folder', { dir: this.opts.dir });
        return true;
      }
    } catch (err) {
      this.deps.log('warn', 'could not ask for the scanner folder’s lock', {
        err: whyOf(err),
      });
    }
    await c.end().catch(() => undefined);
    return false;
  }

  private async round(): Promise<WatchRound> {
    const out: WatchRound = { ran: false, outcomes: [] };
    if (this.stopped) return out;
    const { dir } = this.opts;
    if (!dir) {
      // Not set here: said, unless a worker that has it said otherwise just now.
      await this.deps.admin.query(
        `insert into watch_dir (singleton, dir, state, checked_at) values (true, null, 'off', now())
         on conflict (singleton) do update set dir = null, state = 'off', checked_at = now()
          where watch_dir.state = 'off' or watch_dir.checked_at < now() - interval '1 minute'`,
      );
      out.state = 'off';
      return out;
    }
    if (!(await this.holdLock())) return out;
    out.ran = true;
    const state = await checkWatchDir(dir, this.fs);
    out.state = state;
    await this.deps.admin.query(
      `insert into watch_dir (singleton, dir, state, checked_at) values (true, $1, $2, now())
       on conflict (singleton) do update set dir = $1, state = $2, checked_at = now()`,
      [dir, state],
    );
    // What nobody dismissed in WATCH_NOTICE_DAYS goes.
    await this.deps.admin.query(
      `delete from watch_notice where created_at < now() - make_interval(days => $1)`,
      [WATCH_NOTICE_DAYS],
    );
    const { rows } = await this.deps.admin.query<{
      household_id: string;
      member_id: string | null;
      paused_reason: WatchPause | null;
    }>(
      `select household_id, member_id, paused_reason from watch_folder where enabled
        order by household_id limit 1`,
    );
    const setting = rows[0];
    if (state !== 'ready') {
      // Not paused for its person's sake while the folder is not there at all.
      if (setting) await this.paused(setting.household_id, setting.paused_reason, null);
      return out;
    }
    if (!setting) {
      this.seen.clear();
      return out;
    }
    this.root = await this.fs.realpath(dir);
    const hh = setting.household_id;
    const target = await this.target(hh, setting.member_id);
    if ('pause' in target) {
      out.paused = target.pause;
      await this.paused(hh, setting.paused_reason, target.pause);
      return out;
    }

    const files = await listWatchFiles(dir, this.fs);
    const ready = this.settled(files);
    let added = 0;
    let pause: WatchPause | null = null;
    for (const f of ready.slice(0, this.opts.roundMax ?? WATCH_ROUND_MAX)) {
      if (this.stopped) break;
      if (!(await this.stillHolding())) {
        out.outcomes.push({ rel: f.rel, kind: 'stopped', why: 'the lock was lost' });
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

  /** How many stored files could not be deleted, and are still there: told to the owners when it changes. */
  private async tellStuck(hh: string, files: WatchFile[]) {
    const here = new Map(files.map((f) => [f.rel, f.id]));
    for (const [rel, s] of [...this.stuck]) if (here.get(rel) !== s.id) this.stuck.delete(rel);
    const n = this.stuck.size;
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

  /** Whose Inbox, as they are now — or why nothing can be added to it. */
  private async target(
    hh: string,
    memberId: string | null,
  ): Promise<Target | { pause: WatchPause }> {
    if (!memberId) return { pause: 'removed' };
    return withSystem(this.deps.db, hh, async (trx) => {
      const member = await trx
        .selectFrom('member')
        .select(['kind'])
        .where('id', '=', memberId)
        .executeTakeFirst();
      const signIn = await trx
        .selectFrom('account_household')
        .select(['account_id', 'role', 'suspended_at', 'suspended_until', 'suspend_reason'])
        .where('member_id', '=', memberId)
        .where('household_id', '=', hh)
        .executeTakeFirst();
      const pause = watchPauseOf(member ?? null, signIn ?? null, this.now());
      if (pause || !signIn) return { pause: pause ?? 'no_sign_in' };
      const home = await trx
        .selectFrom('household')
        .select('timezone')
        .where('id', '=', hh)
        .executeTakeFirstOrThrow();
      return {
        householdId: hh,
        memberId,
        accountId: signIn.account_id,
        timezone: home.timezone,
      };
    });
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
   * device and inode — and, on Linux, the handle's own real path inside the
   * folder's. Or why not: skipped (`later`), or unreadable.
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
      if (!st.isFile() || idOf(st) !== f.id) throw new Error('not the file listed');
      if (process.platform === 'linux') {
        const real = await this.fs.readlink(`/proc/self/fd/${fh.fd}`);
        if (!within(this.root, real)) throw new Error('outside the folder');
      }
      return { fh, st };
    } catch (err) {
      await fh.close().catch(() => undefined);
      return { later: whyOf(err) };
    }
  }

  /** Whether the name is still the file held: what is moved or deleted must be. */
  private async stillThere(f: WatchFile): Promise<boolean> {
    const st = await this.fs.lstat(f.abs, { bigint: true }).catch(() => null);
    return st !== null && st.isFile() && !st.isSymbolicLink() && idOf(st) === f.id;
  }

  /** One file, taken: added, found added already, rejected, waited for — or why not now. */
  private async take(t: Target, f: WatchFile): Promise<WatchOutcome> {
    const opened = await this.open(f);
    if ('later' in opened) return { kind: 'later', why: opened.later };
    if ('unreadable' in opened) return this.reject(t, f, 'unreadable', null);
    const { fh, st } = opened;
    try {
      return await this.takeOpen(t, f, fh, st);
    } finally {
      await fh.close().catch(() => undefined);
    }
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
      this.unfinished.set(f.rel, { id: f.id, since });
      if (this.now() - since >= WATCH_INCOMPLETE_MS) return this.reject(t, f, 'incomplete', fh);
      return { kind: 'waiting' };
    }
    this.unfinished.delete(f.rel);

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
      await this.remove(f);
      return { kind: 'already' };
    }
    // On its way when a worker stopped: removed, and added again.
    await withSystem(this.deps.db, hh, async (trx) => {
      const gone = await trx
        .deleteFrom('incoming_file')
        .where('idempotency_key', '=', key)
        .where('state', '=', 'uploading')
        .returning(['storage_key', 'vault_id'])
        .execute();
      for (const g of gone) {
        const adapter = await adapterOf(trx, this.deps, g.vault_id);
        await adapter.delete(g.storage_key).catch(() => undefined);
      }
      // A removed one keeps no key a new one would need.
      await trx
        .updateTable('incoming_file')
        .set({ idempotency_key: null })
        .where('idempotency_key', '=', key)
        .where('state', '=', 'rejected')
        .execute();
    });

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
      const signIn = await trx
        .selectFrom('account_household')
        .select(['role', 'suspended_at', 'suspended_until', 'suspend_reason'])
        .where('member_id', '=', t.memberId)
        .where('household_id', '=', hh)
        .forShare()
        .executeTakeFirst();
      const member = await trx
        .selectFrom('member')
        .select('kind')
        .where('id', '=', t.memberId)
        .executeTakeFirst();
      const pause = watchPauseOf(member ?? null, signIn ?? null, this.now());
      if (pause) return { pause };
      let scopeKey;
      try {
        scopeKey = await this.deps.keys.unwrap(trx, {
          householdId: hh,
          kind: 'member',
          memberId: t.memberId,
        });
      } catch {
        return { pause: 'sealed' as const };
      }
      const home = await trx
        .selectFrom('household')
        .select('active_vault_id')
        .where('id', '=', hh)
        .executeTakeFirstOrThrow();
      if (!home.active_vault_id) return { pause: 'no_storage' as const };
      const adapter = await adapterOf(trx, this.deps, home.active_vault_id);
      const batch = await this.dayBatch(trx, t);
      if ('pause' in batch || 'later' in batch) return batch;
      const fileKey = newKey();
      const id = randomUUID();
      const row = await trx
        .insertInto('incoming_file')
        .values({
          id,
          household_id: hh,
          request_id: null,
          batch_id: batch.id,
          review_by: 'me',
          requester_member_id: t.memberId,
          original_name: name,
          storage_key: `${hh}/batches/${batch.id}/${randomBytes(16).toString('hex')}.enc`,
          vault_id: home.active_vault_id,
          file_key_wrapped: wrapKey(fileKey, scopeKey.key, `incoming:${id}`),
          wrapped_by_scope: scopeKey.id,
          scope: 'member',
          scan_state: 'unscanned',
          read_state: 'waiting',
          idempotency_key: key,
        })
        .returning(['id', 'storage_key'])
        .executeTakeFirstOrThrow();
      return { id: row.id, storageKey: row.storage_key, adapter, fileKey };
    });
    if ('stop' in placed) return { kind: 'stopped', why: placed.stop };
    if ('pause' in placed) return { kind: 'paused', reason: placed.pause };
    if ('later' in placed) return { kind: 'later', why: placed.later };

    const discard = async () => {
      await placed.adapter.delete(placed.storageKey).catch(() => undefined);
      await withSystem(this.deps.db, hh, (trx) =>
        trx
          .deleteFrom('incoming_file')
          .where('id', '=', placed.id)
          .where('state', '=', 'uploading')
          .execute(),
      ).catch(() => undefined);
    };

    // Its bytes, from the same handle, counted and hashed as they go,
    // encrypted straight to its object.
    const plainHash = createHash('sha256');
    let bytes = 0;
    const counted = new PassThrough();
    counted.on('data', (chunk: Buffer) => {
      plainHash.update(chunk);
      bytes += chunk.length;
      if (bytes > this.deps.maxBytes) counted.destroy(new Error('larger than the vault takes'));
    });
    const enc = new EncryptStream(placed.fileKey);
    const storing = placed.adapter.put(placed.storageKey, enc);
    const flowing = pipeline(Readable.from(bytesOf(fh, size, this.abort.signal)), counted, enc, {
      signal: this.abort.signal,
    });
    let put: { bytes: number; sha256: string };
    try {
      [put] = await Promise.all([storing, flowing]);
    } catch (err) {
      enc.destroy();
      await Promise.allSettled([storing, flowing]);
      await discard();
      if (this.abort.signal.aborted) return { kind: 'stopped', why: 'the worker is stopping' };
      return { kind: 'later', why: `not stored: ${whyOf(err)}` };
    }
    // Changed as it was read — the scanner still writing after all: tried again.
    const after = await fh.stat({ bigint: true }).catch(() => null);
    if (
      !after ||
      bytes !== size ||
      after.size !== st.size ||
      after.mtimeNs !== st.mtimeNs ||
      !plainHash.digest().equals(sha)
    ) {
      await discard();
      return { kind: 'later', why: 'changed as it was read' };
    }

    const arrived = await withSystem(this.deps.db, hh, async (trx) => {
      const at = new Date();
      const done = await trx
        .updateTable('incoming_file')
        .set({
          state: 'received',
          mime: kind.mime,
          byte_size: bytes,
          sha256: sha,
          cipher_bytes: put.bytes,
          cipher_sha256: Buffer.from(put.sha256, 'hex'),
          received_at: at,
          submitted_at: at,
        })
        .where('id', '=', placed.id)
        .where('state', '=', 'uploading')
        .returning('id')
        .executeTakeFirst();
      return done !== undefined;
    }).catch(() => false);
    if (!arrived) {
      // Its batch removed as it arrived, or the database out of reach.
      await discard();
      return { kind: 'later', why: 'its batch went as it arrived' };
    }
    // Safely stored: the file goes. A worker that stops here finds the item next time.
    await this.remove(f);
    return { kind: 'added', itemId: placed.id };
  }

  /** The person's batch of the day, made the first time; or why there is no room in it. */
  private async dayBatch(
    trx: Db,
    t: Target,
  ): Promise<{ id: string } | { pause: 'day_full' } | { later: string }> {
    const { day, name } = scannerDay(t.timezone, new Date(this.now()));
    const find = () =>
      trx
        .selectFrom('intake_batch')
        .select(['id', 'ends_at'])
        .where('member_id', '=', t.memberId)
        .where('watch_day', '=', day)
        .forUpdate()
        .executeTakeFirst();
    let b = await find();
    if (!b) {
      const at = new Date();
      await trx
        .insertInto('intake_batch')
        .values({
          household_id: t.householdId,
          created_by: t.accountId,
          member_id: t.memberId,
          name,
          watch_day: day,
          created_at: at,
          ends_at: new Date(at.getTime() + INCOMING_KEEP_DAYS * DAY),
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
      b = await find();
    }
    if (!b) return { later: 'the day’s batch could not be made' };
    // Being removed by its person just now: tried again once it has gone.
    if (b.ends_at.getTime() <= Date.now()) return { later: 'the day’s batch is being removed' };
    const taken = await trx
      .selectFrom('incoming_file')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('batch_id', '=', b.id)
      .where((eb) =>
        eb.or([
          eb('state', 'in', ['received', 'accepted']),
          eb.and([
            eb('state', '=', 'uploading'),
            eb('created_at', '>', new Date(Date.now() - UPLOAD_FRESH_MS)),
          ]),
        ]),
      )
      .executeTakeFirstOrThrow();
    if (Number(taken.n) >= BATCH_MAX_FILES) return { pause: 'day_full' };
    return { id: b.id };
  }

  /**
   * The file deleted, once stored — only while its name is still the file
   * stored. One that cannot be deleted is said once in the log, counted for
   * the owners, and tried again after RETRY_MS.
   */
  private async remove(f: WatchFile): Promise<void> {
    if (!(await this.stillThere(f))) return;
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
  private async rejectedDir(): Promise<string | null> {
    const into = path.join(this.opts.dir as string, WATCH_REJECTED_DIR);
    await this.fs.mkdir(into, { mode: 0o700 }).catch((err: unknown) => {
      if (code(err) !== 'EEXIST') throw err;
    });
    const st = await this.fs.lstat(into);
    if (!st.isDirectory() || st.isSymbolicLink()) return null;
    const real = await this.fs.realpath(into);
    return within(this.root, real) && real !== this.root ? into : null;
  }

  /**
   * Moved to rejected/, its person told first (once a file, whatever
   * happens after), a note beside it saying why. Moved by a hard link to a
   * name nothing has and the old name's unlink — never over another file,
   * and only while the name is still the file — or, where the folder takes
   * no links, copied from the handle to a new file. A file that cannot be
   * moved is left where it is, and tried again later.
   */
  private async reject(
    t: Target,
    f: WatchFile,
    reason: WatchRejectReason,
    fh: FileHandle | null,
  ): Promise<WatchOutcome> {
    const original = path.basename(f.abs);
    const notName = (why: string): WatchOutcome => {
      this.held.set(f.rel, this.now() + RETRY_MS);
      this.deps.log('warn', 'a scanned file could not be moved to rejected/', { err: why });
      return { kind: 'later', why: 'could not be moved to rejected/' };
    };
    let into: string | null;
    try {
      into = await this.rejectedDir();
    } catch (err) {
      return notName(whyOf(err));
    }
    if (!into) return notName('rejected/ is not a folder of its own');
    await withSystem(this.deps.db, t.householdId, (trx) =>
      trx
        .insertInto('watch_notice')
        .values({
          household_id: t.householdId,
          member_id: t.memberId,
          file_name: [...dropFileName(original)].slice(0, 255).join(''),
          reason,
          file_key: watchItemKey(this.deps.itemKey, t.householdId, f),
        })
        .onConflict((oc) => oc.columns(['household_id', 'member_id', 'file_key']).doNothing())
        .execute(),
    );
    let as: string | null;
    try {
      as = await this.move(f, into, original, fh);
    } catch (err) {
      return notName(whyOf(err));
    }
    if (!as) return notName('changed, or no name free');
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

  /** The file moved into rejected/ under a name nothing has (lstat), or null when it changed. */
  private async move(
    f: WatchFile,
    into: string,
    name: string,
    fh: FileHandle | null,
  ): Promise<string | null> {
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    const free = async (c: string) => {
      for (const n of [c, `${c}.txt`]) {
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
      try {
        await this.fs.link(f.abs, to);
      } catch (err) {
        const c = code(err);
        if (c === 'EEXIST') continue;
        if (!fh || !['EXDEV', 'EPERM', 'ENOTSUP', 'ENOSYS', 'EOPNOTSUPP'].includes(c)) throw err;
        // No links here: a new file, from the handle.
        const out = await this.fs.open(to, 'wx', 0o600).catch((e: unknown) => {
          if (code(e) === 'EEXIST') return null;
          throw e;
        });
        if (!out) continue;
        try {
          const st = await fh.stat({ bigint: true });
          for await (const chunk of bytesOf(fh, Number(st.size))) await out.write(chunk);
        } finally {
          await out.close();
        }
      }
      if (await this.stillThere(f)) await this.fs.unlink(f.abs);
      return candidate;
    }
    return null;
  }
}
