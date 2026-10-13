import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  EncryptStream,
  itemFolderBinding,
  newKey,
  sealBytes,
  wrapKey,
  type ScopeKeys,
} from '@fdv/crypto';
import { withSystem, type Db } from '@fdv/db';
import {
  BATCH_MAX_FILES,
  emailDay,
  INCOMING_KEEP_DAYS,
  scannerDay,
  watchPauseOf,
  type WatchPause,
} from '@fdv/shared';
import type { StorageAdapter } from '@fdv/storage';
import pg from 'pg';
import { adapterOf } from './incoming.js';

/**
 * What the vault's own intake shares (0.8.0): the scanner folder (S3,
 * watch-folder.ts) and email in (S4, mail-in.ts) each add a file as Add →
 * Many documents adds one — an item of its person's batch of the day, on
 * its way first, its bytes counted, hashed and encrypted under a new key
 * wrapped by their own member key straight to its object, then arrived —
 * and each runs as the one worker holding an advisory lock.
 *
 *  - `AdvisoryLock`: the lock, held on a connection of its own, kept alive,
 *    checked in pg_locks before every file.
 *  - `whoseInbox`: the person, as they are now — or why nothing can be
 *    added for them (watchPauseOf).
 *  - `placeItem`: in one transaction, held, the person asked again, their
 *    key, the vault's storage, their batch of the day (made the first
 *    time; or full), and the item's row, on its way.
 *  - `storeItem`: its bytes, encrypted to its object, counted and hashed;
 *    `arriveItem`: its row says it has arrived; `discardItem`: its row and
 *    object gone, when it could not.
 *  - `clearStaleItem`: an item a worker left on its way, by its key, gone.
 */

type Log = (level: string, msg: string, extra?: Record<string, unknown>) => void;

const DAY = 864e5;

/** An upload this old, still on its way, holds no place in its batch (the API's UPLOAD_FRESH_MS). */
const UPLOAD_FRESH_MS = 15 * 60_000;

const code = (err: unknown) => (err as NodeJS.ErrnoException | null)?.code ?? '';

/**
 * Why, for the log: an error's code where it has one, and otherwise the
 * start of its message with anything quoted taken out. Never a name, never
 * a value.
 */
export const whyOf = (err: unknown) => {
  const c = code(err);
  if (c) return c;
  const m = err instanceof Error ? err.message : String(err);
  return m.replace(/(['"`]).*?\1/g, '…').slice(0, 120);
};

/**
 * A keyed hash of `parts`, made a UUID (version 8, RFC 9562: custom) so an
 * Idempotency-Key column takes it: the same parts, the same key, every
 * time; the key says nothing of them.
 */
export function keyedUuid(key: Buffer, parts: readonly string[]): string {
  const h = createHmac('sha256', key).update(parts.join('\0')).digest();
  h[6] = ((h[6] as number) & 0x0f) | 0x80;
  h[8] = ((h[8] as number) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** Whose Inbox, as they are now: the household's, the person, their sign-in. */
export interface Target {
  householdId: string;
  memberId: string;
  accountId: string;
  timezone: string;
}

/** Where an item came from: its batch of the day is a scanner's or an email's. */
export type IntakeSource = 'scanner' | 'email';

export interface IngestDeps {
  db: Db;
  keys: ScopeKeys;
  credentialsKey: Buffer;
  localRoot: string;
}

/**
 * The advisory lock one worker holds while it runs: on a connection of its
 * own, kept alive, for as long as this worker lives — asked for once a round
 * until it is had, and checked in pg_locks at each round and before each
 * file while it is: a session lock on a connection that has gone is no
 * lock, and a pooler that hands the session to somebody else would show it
 * (README: a direct connection).
 */
export class AdvisoryLock {
  private client: pg.Client | null = null;

  constructor(
    private readonly key: number,
    private readonly url: string,
    private readonly log: Log,
    /** What it is held for, in the log: "the scanner folder". */
    private readonly what: string,
  ) {}

  get holding(): boolean {
    return this.client !== null;
  }

  async letGo(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (c) {
      await c.query('select pg_advisory_unlock($1)', [this.key]).catch(() => undefined);
      await c.end().catch(() => undefined);
    }
  }

  async still(): Promise<boolean> {
    const c = this.client;
    if (!c) return false;
    try {
      const { rows } = await c.query<{ held: boolean }>(
        `select exists (select 1 from pg_locks
                         where locktype = 'advisory' and pid = pg_backend_pid() and granted
                           and classid = 0 and objid = $1 and objsubid = 1) as held`,
        [this.key],
      );
      if (rows[0]?.held) return true;
    } catch {
      // Gone with its connection.
    }
    await this.letGo();
    return false;
  }

  /** Had already and still held, or had now; false when another worker holds it. */
  async hold(stopped: boolean): Promise<boolean> {
    if (this.client && (await this.still())) return true;
    if (stopped) return false;
    const c = new pg.Client({ connectionString: this.url, keepAlive: true });
    c.on('error', () => {
      if (this.client === c) this.client = null;
      void c.end().catch(() => undefined);
    });
    try {
      await c.connect();
      const { rows } = await c.query<{ got: boolean }>('select pg_try_advisory_lock($1) as got', [
        this.key,
      ]);
      if (rows[0]?.got) {
        this.client = c;
        this.log('info', `this worker runs ${this.what}`);
        return true;
      }
    } catch (err) {
      this.log('warn', `could not ask for ${this.what}’s lock`, { err: whyOf(err) });
    }
    await c.end().catch(() => undefined);
    return false;
  }
}

/** The person whose Inbox it is, as they are now — or why nothing can be added for them. */
export async function whoseInbox(
  db: Db,
  hh: string,
  memberId: string,
  now: number,
): Promise<Target | { pause: WatchPause }> {
  return withSystem(db, hh, async (trx) => {
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
    const pause = watchPauseOf(member ?? null, signIn ?? null, now);
    if (pause || !signIn) return { pause: pause ?? 'no_sign_in' };
    const home = await trx
      .selectFrom('household')
      .select('timezone')
      .where('id', '=', hh)
      .executeTakeFirstOrThrow();
    return { householdId: hh, memberId, accountId: signIn.account_id, timezone: home.timezone };
  });
}

/** How many items hold a place in a batch: arrived, or on their way lately. */
async function taken(trx: Db, batchId: string): Promise<number> {
  const n = await trx
    .selectFrom('incoming_file')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('batch_id', '=', batchId)
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
  return Number(n.n);
}

/**
 * Whether the person's batch of the day is full already: asked before
 * anything is fetched for it (email in, F4), and nothing made.
 */
export async function dayIsFull(
  db: Db,
  t: Target,
  source: IntakeSource,
  now: number,
): Promise<boolean> {
  const { day } =
    source === 'scanner'
      ? scannerDay(t.timezone, new Date(now))
      : emailDay(t.timezone, new Date(now));
  const column = source === 'scanner' ? 'watch_day' : 'mail_day';
  return withSystem(db, t.householdId, async (trx) => {
    const b = await trx
      .selectFrom('intake_batch')
      .select('id')
      .where('member_id', '=', t.memberId)
      .where(column, '=', day)
      .executeTakeFirst();
    return b ? (await taken(trx, b.id)) >= BATCH_MAX_FILES : false;
  });
}

/**
 * The person's batch of the day — a scanner's or an email's — made the
 * first time; or why there is no room in it.
 */
export async function dayBatch(
  trx: Db,
  t: Target,
  source: IntakeSource,
  now: number,
): Promise<{ id: string } | { pause: 'day_full' } | { later: string }> {
  const { day, name } =
    source === 'scanner'
      ? scannerDay(t.timezone, new Date(now))
      : emailDay(t.timezone, new Date(now));
  const column = source === 'scanner' ? 'watch_day' : 'mail_day';
  const find = () =>
    trx
      .selectFrom('intake_batch')
      .select(['id', 'ends_at'])
      .where('member_id', '=', t.memberId)
      .where(column, '=', day)
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
        [column]: day,
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
  if ((await taken(trx, b.id)) >= BATCH_MAX_FILES) return { pause: 'day_full' };
  return { id: b.id };
}

/** An item placed: its row, on its way, and where its bytes go. */
export interface Placed {
  id: string;
  householdId: string;
  storageKey: string;
  adapter: StorageAdapter;
  fileKey: Buffer;
}

/**
 * The item's row, on its way, in the person's batch of the day: holding its
 * place. Inside the caller's transaction, after it has asked again what it
 * must (its own setting), the person is asked again and held; then their
 * key, the vault's storage and the day's batch — or why not (a pause), or
 * not now (`later`).
 */
export async function placeItem(
  trx: Db,
  deps: IngestDeps,
  t: Target,
  source: IntakeSource,
  now: number,
  item: {
    name: string;
    key: string;
    /** An email's attachment: its Message-ID's key (0069). */
    mailKey?: string | null;
    /** An email whose sender the mailbox's check could not vouch for (0069). */
    senderUnverified?: boolean;
    /**
     * The subfolder it was in, under the scanner folder (0.8.0, S2): its
     * folders, without its own name (`itemFolder`) — sealed under the item’s
     * own key and bound to it (itemFolderBinding), never plain. An email has
     * none.
     */
    folder?: string | null;
  },
): Promise<Placed | { pause: WatchPause } | { later: string }> {
  const hh = t.householdId;
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
  const pause = watchPauseOf(member ?? null, signIn ?? null, now);
  if (pause) return { pause };
  let scopeKey;
  try {
    scopeKey = await deps.keys.unwrap(trx, {
      householdId: hh,
      kind: 'member',
      memberId: t.memberId,
    });
  } catch {
    return { pause: 'sealed' };
  }
  const home = await trx
    .selectFrom('household')
    .select('active_vault_id')
    .where('id', '=', hh)
    .executeTakeFirstOrThrow();
  if (!home.active_vault_id) return { pause: 'no_storage' };
  const adapter = await adapterOf(trx, deps, home.active_vault_id);
  const batch = await dayBatch(trx, t, source, now);
  if ('pause' in batch || 'later' in batch) return batch;
  const fileKey = newKey();
  const id = randomUUID();
  const row = await trx
    .insertInto('incoming_file')
    .values({
      id,
      ...(item.folder
        ? {
            folder_sealed: sealBytes(
              fileKey,
              Buffer.from(item.folder, 'utf8'),
              itemFolderBinding(id),
            ),
          }
        : {}),
      household_id: hh,
      request_id: null,
      batch_id: batch.id,
      review_by: 'me',
      requester_member_id: t.memberId,
      original_name: item.name,
      storage_key: `${hh}/batches/${batch.id}/${randomBytes(16).toString('hex')}.enc`,
      vault_id: home.active_vault_id,
      file_key_wrapped: wrapKey(fileKey, scopeKey.key, `incoming:${id}`),
      wrapped_by_scope: scopeKey.id,
      scope: 'member',
      scan_state: 'unscanned',
      read_state: 'waiting',
      idempotency_key: item.key,
      ...(item.mailKey ? { mail_key: item.mailKey } : {}),
      ...(item.senderUnverified ? { sender_unverified: true } : {}),
    })
    .returning(['id', 'storage_key'])
    .executeTakeFirstOrThrow();
  return { id: row.id, householdId: hh, storageKey: row.storage_key, adapter, fileKey };
}

/**
 * The item's bytes, encrypted straight to its object, counted and hashed as
 * they go: more than `maxBytes` is refused. What was stored, its plain
 * size and SHA-256 — or a throw (the caller discards the item).
 */
export async function storeItem(
  placed: Placed,
  chunks: AsyncIterable<Buffer> | Iterable<Buffer>,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ bytes: number; sha256: Buffer; put: { bytes: number; sha256: string } }> {
  const plainHash = createHash('sha256');
  let bytes = 0;
  const counted = new PassThrough();
  counted.on('data', (chunk: Buffer) => {
    plainHash.update(chunk);
    bytes += chunk.length;
    if (bytes > maxBytes) counted.destroy(new Error('larger than the vault takes'));
  });
  const enc = new EncryptStream(placed.fileKey);
  const storing = placed.adapter.put(placed.storageKey, enc);
  const flowing = pipeline(Readable.from(chunks), counted, enc, signal ? { signal } : {});
  try {
    const [put] = await Promise.all([storing, flowing]);
    return { bytes, sha256: plainHash.digest(), put };
  } catch (err) {
    enc.destroy();
    await Promise.allSettled([storing, flowing]);
    throw err;
  }
}

/** Its row says it has arrived: false when it could not (its batch removed as it arrived, say). */
export async function arriveItem(
  db: Db,
  placed: Placed,
  stored: { mime: string; bytes: number; sha256: Buffer; put: { bytes: number; sha256: string } },
): Promise<boolean> {
  return withSystem(db, placed.householdId, async (trx) => {
    const at = new Date();
    const done = await trx
      .updateTable('incoming_file')
      .set({
        state: 'received',
        mime: stored.mime,
        byte_size: stored.bytes,
        sha256: stored.sha256,
        cipher_bytes: stored.put.bytes,
        cipher_sha256: Buffer.from(stored.put.sha256, 'hex'),
        received_at: at,
        submitted_at: at,
      })
      .where('id', '=', placed.id)
      .where('state', '=', 'uploading')
      .returning('id')
      .executeTakeFirst();
    return done !== undefined;
  }).catch(() => false);
}

/** The item's object and row gone: it never arrived. */
export async function discardItem(db: Db, placed: Placed): Promise<void> {
  await placed.adapter.delete(placed.storageKey).catch(() => undefined);
  await withSystem(db, placed.householdId, (trx) =>
    trx
      .deleteFrom('incoming_file')
      .where('id', '=', placed.id)
      .where('state', '=', 'uploading')
      .execute(),
  ).catch(() => undefined);
}

/**
 * An item a worker left on its way, by its key: its row and object
 * removed, to be added again. One removed from the Inbox keeps no key a new
 * one would need.
 */
export async function clearStaleItem(
  deps: IngestDeps,
  hh: string,
  key: string,
  /** An email's attachment: one on its way under its Message-ID's key too, whatever its UID was. */
  mailKey: string | null = null,
  /**
   * An email's (F8): one its person removed keeps its key, so it counts as
   * taken and is never added again while its mail waits to be filed. The
   * scanner folder's lets go of it, and a file saved again is added again.
   */
  opts: { keepRemoved?: boolean } = {},
): Promise<void> {
  await withSystem(deps.db, hh, async (trx) => {
    const gone = await trx
      .deleteFrom('incoming_file')
      .where((eb) =>
        mailKey
          ? eb.or([eb('idempotency_key', '=', key), eb('mail_key', '=', mailKey)])
          : eb('idempotency_key', '=', key),
      )
      .where('state', '=', 'uploading')
      .returning(['storage_key', 'vault_id'])
      .execute();
    for (const g of gone) {
      const adapter = await adapterOf(trx, deps, g.vault_id);
      await adapter.delete(g.storage_key).catch(() => undefined);
    }
    if (opts.keepRemoved) return;
    await trx
      .updateTable('incoming_file')
      .set({ idempotency_key: null })
      .where('idempotency_key', '=', key)
      .where('state', '=', 'rejected')
      .execute();
  });
}
