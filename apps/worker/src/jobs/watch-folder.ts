import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { EncryptStream, newKey, wrapKey, type ScopeKeys } from '@fdv/crypto';
import { withSystem, type Db } from '@fdv/db';
import {
  BATCH_MAX_FILES,
  INCOMING_KEEP_DAYS,
  dropFileName,
  scannerDay,
  UPLOAD_KINDS,
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
 * advisory lock (WATCH_LOCK_KEY), on a connection of its own for as long as
 * it lives — looks in the folder. Polling, not inotify: bind mounts on
 * Docker Desktop deliver no events.
 *
 *  - It says how it found the folder (watch_dir): the API offers the scanner
 *    folder only when it is set, there and writable, and said so lately.
 *  - It finds the household that has it on, and whose Inbox it fills. That
 *    person must still be of the family, with a sign-in that may add
 *    documents, not locked nor waiting after a restore; the vault must open
 *    their key and have somewhere to keep files; and their batch of the day
 *    must have room. Otherwise it is paused, and says why (watch_folder),
 *    and the files wait.
 *  - A file is taken once its size and time have not changed for
 *    WATCH_STABLE_MS, seen twice. Hidden files, names a program writes while
 *    it saves (`~…`, `….tmp`, `….part`) and `rejected/` are left alone;
 *    files in folders inside it are taken too. A link is never followed.
 *  - It is added as Add → Many documents adds a file (the API's
 *    BatchService.addItem): an item of that person's batch of the day
 *    ("Scanner, 12 Oct", on the household's calendar), on its way first,
 *    its bytes counted, hashed and encrypted under a new key wrapped by
 *    their own member key straight to its object, then arrived — and the
 *    worker's batch.previews job draws its pages, reads it and proposes for
 *    it, with their own rules (I2, I4), as for anything they upload.
 *  - Only once the item has arrived is the file deleted: no plaintext
 *    lingers. Its Idempotency-Key is a keyed hash of its path, size and time
 *    (watchItemKey): a worker that stops between storing a file and deleting
 *    it finds the item next time and deletes the file without adding it
 *    twice; one that stops while it is on its way removes that and adds it
 *    again.
 *  - What cannot be added — not a kind the vault keeps, larger than
 *    FDV_MAX_UPLOAD_BYTES, empty, or not to be read — is moved to
 *    `rejected/<name>`, with `<name>.txt` beside it saying why in plain
 *    words; and that person is told in Needs attention (watch_notice).
 *
 * The bytes are only ever streamed through: nothing parses them here but
 * the first few, compared with the kinds' own first bytes (watchKindOf). A
 * file's words are read by the batch job, in its tools' own processes, as
 * any item's are.
 */

/** The advisory lock one worker holds while it watches: beside migrate's 7401 and the tests' 7402. */
export const WATCH_LOCK_KEY = 7403;

/** At most this many files are added a round: the rest wait for the next. */
export const WATCH_ROUND_MAX = 25;

/** At most this many entries are looked at, this many folders deep. */
const WALK_MAX_ENTRIES = 5000;
const WALK_MAX_DEPTH = 10;

/** A file that could not be moved to rejected/ is left alone this long before it is tried again. */
const REJECT_RETRY_MS = 10 * 60_000;

/** The first bytes a kind is told from (the API's sniffStream reads as many). */
const HEAD_BYTES = 4100;

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
  /** Where the lock's own connection goes (DATABASE_URL). */
  lockUrl: string;
  pollMs?: number;
  stableMs?: number;
  roundMax?: number;
  /** The clock, for the tests. */
  now?: () => number;
  /** The file system, for the tests that cannot make a folder read-only. */
  fs?: WatchFs;
}

/** What is asked of the file system: node's own, unless a test stands in. */
export interface WatchFs {
  stat: typeof fsp.stat;
  access: typeof fsp.access;
  writeFile: typeof fsp.writeFile;
  unlink: typeof fsp.unlink;
  readdir: typeof fsp.readdir;
  rename: typeof fsp.rename;
  mkdir: typeof fsp.mkdir;
  open: typeof fsp.open;
}

const nodeFs: WatchFs = {
  stat: fsp.stat,
  access: fsp.access,
  writeFile: fsp.writeFile,
  unlink: fsp.unlink,
  readdir: fsp.readdir,
  rename: fsp.rename,
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
    await fsx.writeFile(probe, '');
    await fsx.unlink(probe);
    return 'ready';
  } catch {
    return 'not_writable';
  }
}

/** A file in the folder: its path from the folder (`/` between parts), size and time. */
export interface WatchFile {
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
}

/**
 * Every file in the folder and the folders inside it, but what is left
 * alone (watchIgnored) — never through a link — up to WALK_MAX_ENTRIES,
 * WALK_MAX_DEPTH deep.
 */
export async function listWatchFiles(dir: string, fsx: WatchFs = nodeFs): Promise<WatchFile[]> {
  const out: WatchFile[] = [];
  let seen = 0;
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > WALK_MAX_DEPTH) return;
    let entries;
    try {
      entries = await fsx.readdir(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (++seen > WALK_MAX_ENTRIES) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (watchIgnored(r)) continue;
      if (e.isDirectory()) {
        await walk(r, depth + 1);
      } else if (e.isFile()) {
        const abs = path.join(dir, ...r.split('/'));
        try {
          const st = await fsx.stat(abs);
          if (st.isFile()) out.push({ rel: r, abs, size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          // Gone as it was looked at.
        }
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
 * A file's Idempotency-Key: a keyed hash of its household, its path in the
 * folder, its size and its time, made a UUID. The same file is the same
 * key, every time; the key says nothing of the file's name or folders.
 */
export function watchItemKey(
  key: Buffer,
  householdId: string,
  f: Pick<WatchFile, 'rel' | 'size' | 'mtimeMs'>,
): string {
  const h = createHmac('sha256', key)
    .update(`${householdId}\0${f.rel}\0${f.size}\0${Math.trunc(f.mtimeMs)}`)
    .digest();
  // As a version 8 UUID (RFC 9562: custom), so the column takes it.
  h[6] = ((h[6] as number) & 0x0f) | 0x80;
  h[8] = ((h[8] as number) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
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
  /** Each file as last seen, and since when it has not changed. */
  private readonly seen = new Map<string, { size: number; mtimeMs: number; since: number }>();
  /** Files that could not be moved to rejected/: left alone until then. */
  private readonly held = new Map<string, number>();

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

  /** Stops looking, lets the round under way finish, and lets go of the lock. */
  async stop(): Promise<void> {
    this.stopped = true;
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
   * The lock, held on a connection of its own for as long as this worker
   * lives: asked for once a round until it is had, and checked once a
   * round while it is. A connection that has gone has let go of it.
   */
  private async holdLock(): Promise<boolean> {
    if (this.lock) {
      try {
        await this.lock.query('select 1');
        return true;
      } catch {
        await this.letGo();
      }
    }
    if (this.stopped) return false;
    const c = new pg.Client({ connectionString: this.opts.lockUrl });
    c.on('error', () => {
      if (this.lock === c) this.lock = null;
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
    if (state !== 'ready') return out;

    const { rows } = await this.deps.admin.query<{
      household_id: string;
      member_id: string | null;
      paused_reason: WatchPause | null;
    }>(
      `select household_id, member_id, paused_reason from watch_folder where enabled
        order by household_id limit 1`,
    );
    const setting = rows[0];
    if (!setting) {
      this.seen.clear();
      return out;
    }
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
      const r = await this.take(target, f).catch((err: unknown): WatchOutcome => ({
        kind: 'later',
        why: whyOf(err),
      }));
      out.outcomes.push({ rel: f.rel, ...r });
      if (r.kind === 'added') added++;
      if (r.kind === 'added' || r.kind === 'already' || r.kind === 'rejected') {
        this.seen.delete(f.rel);
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
    }
    out.paused = pause;
    await this.paused(hh, setting.paused_reason, pause);
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
      const was = this.seen.get(f.rel);
      if (!was || was.size !== f.size || was.mtimeMs !== f.mtimeMs) {
        this.seen.set(f.rel, { size: f.size, mtimeMs: f.mtimeMs, since: now });
      } else if (now - was.since >= stable) {
        ready.push(f);
      }
    }
    for (const rel of [...this.seen.keys()]) if (!here.has(rel)) this.seen.delete(rel);
    for (const rel of [...this.held.keys()]) if (!here.has(rel)) this.held.delete(rel);
    return ready;
  }

  /** One file, taken: added, found added already, rejected — or why not now. */
  private async take(t: Target, f: WatchFile): Promise<WatchOutcome> {
    const hh = t.householdId;
    const key = watchItemKey(this.deps.itemKey, hh, f);
    // Taken before? Arrived, or decided since: the file only had to go.
    const prior = await withSystem(this.deps.db, hh, (trx) =>
      trx
        .selectFrom('incoming_file')
        .select(['id', 'state', 'storage_key', 'vault_id'])
        .where('idempotency_key', '=', key)
        .where('batch_id', 'is not', null)
        .executeTakeFirst(),
    );
    if (prior && prior.state !== 'uploading') {
      await this.remove(f);
      return { kind: 'already' };
    }
    if (prior) {
      // On its way when a worker stopped: removed, and added again.
      await withSystem(this.deps.db, hh, async (trx) => {
        const gone = await trx
          .deleteFrom('incoming_file')
          .where('id', '=', prior.id)
          .where('state', '=', 'uploading')
          .returning('id')
          .executeTakeFirst();
        if (gone) {
          const adapter = await adapterOf(trx, this.deps, prior.vault_id);
          await adapter.delete(prior.storage_key).catch(() => undefined);
        }
      });
    }

    if (f.size === 0) return this.reject(t, f, 'empty');
    if (f.size > this.deps.maxBytes) return this.reject(t, f, 'too_large');
    let head: Buffer;
    try {
      const h = await this.fs.open(f.abs, 'r');
      try {
        const buf = Buffer.alloc(Math.min(HEAD_BYTES, f.size));
        const { bytesRead } = await h.read(buf, 0, buf.length, 0);
        head = buf.subarray(0, bytesRead);
      } finally {
        await h.close();
      }
    } catch (err) {
      if (code(err) === 'ENOENT') return { kind: 'later', why: 'gone' };
      return this.reject(t, f, 'unreadable');
    }
    const name = dropFileName(path.basename(f.abs));
    const kind = watchKindOf(head, name);
    if (!kind) return this.reject(t, f, 'unsupported');

    // Its row, on its way, in the day's batch: holding its place.
    const placed = await withSystem(this.deps.db, hh, async (trx) => {
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

    // Its bytes counted and hashed as they go, encrypted straight to its object.
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
    const flowing = pipeline(createReadStream(f.abs), counted, enc);
    let put: { bytes: number; sha256: string };
    try {
      [put] = await Promise.all([storing, flowing]);
    } catch (err) {
      enc.destroy();
      await Promise.allSettled([storing, flowing]);
      await discard();
      return { kind: 'later', why: `not stored: ${whyOf(err)}` };
    }
    // Changed as it was read — the scanner still writing after all: tried again.
    const after = await this.fs.stat(f.abs).catch(() => null);
    if (!after || bytes !== f.size || after.size !== f.size || after.mtimeMs !== f.mtimeMs) {
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
          sha256: plainHash.digest(),
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

  /** The file deleted, once stored; a file that cannot be is tried again next round. */
  private async remove(f: WatchFile): Promise<void> {
    try {
      await this.fs.unlink(f.abs);
    } catch (err) {
      if (code(err) !== 'ENOENT') {
        this.deps.log('warn', 'a scanned file is stored but could not be deleted from the folder', {
          err: whyOf(err),
        });
      }
    }
  }

  /**
   * Moved to rejected/, a note beside it saying why, and its person told.
   * A file that cannot be moved is left where it is, and tried again later.
   */
  private async reject(t: Target, f: WatchFile, reason: WatchRejectReason): Promise<WatchOutcome> {
    const dir = this.opts.dir as string;
    const into = path.join(dir, WATCH_REJECTED_DIR);
    const original = path.basename(f.abs);
    let as: string;
    try {
      await this.fs.mkdir(into, { recursive: true });
      as = await this.freeName(into, original);
      await this.fs.rename(f.abs, path.join(into, as));
    } catch (err) {
      this.held.set(f.rel, this.now() + REJECT_RETRY_MS);
      this.deps.log('warn', 'a scanned file could not be moved to rejected/', {
        err: whyOf(err),
      });
      return { kind: 'later', why: 'could not be moved to rejected/' };
    }
    const words = watchRejectWords(reason, this.deps.maxBytes);
    const when = new Date(this.now()).toLocaleString('en-GB', {
      timeZone: t.timezone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    const note = [
      `${WATCH_REJECTED_TITLE}.`,
      '',
      `File: ${original}${f.rel !== original ? ` (it was ${f.rel})` : ''}`,
      `When: ${when}`,
      `Why: ${words}`,
      '',
      'The vault kept no copy of it. Anything in this folder is not encrypted:',
      'delete this file and this note once you have dealt with them.',
      '',
    ].join('\n');
    await this.fs
      .writeFile(path.join(into, `${as}.txt`), note)
      .catch((err: unknown) =>
        this.deps.log('warn', 'a rejected scan’s note could not be written', { err: code(err) }),
      );
    await withSystem(this.deps.db, t.householdId, (trx) =>
      trx
        .insertInto('watch_notice')
        .values({
          household_id: t.householdId,
          member_id: t.memberId,
          file_name: [...dropFileName(original)].slice(0, 255).join(''),
          reason,
        })
        .execute(),
    );
    this.deps.log('info', 'a scanned file was moved to rejected/', { why: reason });
    return { kind: 'rejected', reason, as };
  }

  /** A name in rejected/ nothing has: "scan.pdf", then "scan (2).pdf", and its note's too. */
  private async freeName(into: string, name: string): Promise<string> {
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let n = 1; n < 1000; n++) {
      const candidate = n === 1 ? name : `${stem} (${n})${ext}`;
      const taken = await Promise.all(
        [candidate, `${candidate}.txt`].map((c) =>
          this.fs.stat(path.join(into, c)).then(
            () => true,
            () => false,
          ),
        ),
      );
      if (!taken.includes(true)) return candidate;
    }
    return `${stem} (${randomBytes(4).toString('hex')})${ext}`;
  }
}
