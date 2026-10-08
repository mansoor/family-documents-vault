import { withSystem } from '@fdv/db';
import type { PgBoss } from 'pg-boss';
import { adapterOf, drawIncoming, removeObjects, undrawn, type IncomingDeps } from './incoming.js';
import {
  BATCH_JOB_EXPIRE_SECONDS,
  READ_STALE_MS,
  drawnOrNot,
  readNextBatchItem,
  unread,
  type ReadOptions,
} from './read-item.js';

/**
 * Many documents at once (Phase 6, I1): what the worker does for a batch's
 * items, which are incoming files that name their batch (0062).
 *
 *  - `batch.previews`, sent by the API as each item arrives: one item's
 *    review pages drawn — the oldest of the household's not yet drawn —
 *    under the same limits as every file's (tools.ts), encrypted under the
 *    item's own key beside its object. Then, if more are waiting, the job
 *    is sent again, behind whatever else is queued. Its queue keeps one
 *    queued and one running a household (`stately`, keyed by household), so
 *    a batch of 200 is drawn one at a time, taking its turn with every
 *    other household's; a single add (version.process) and a file sent
 *    through a request (incoming.scan) are on queues of their own and wait
 *    for none of it.
 *  - and, since I2, in the same job and the same turn, one item read: the
 *    oldest whose pages are drawn and whose words are not read yet, its
 *    words taken and proposed for (read-item.ts). A job draws one item and
 *    reads one, so the first items of a batch are ready to review while the
 *    rest wait, and the household's turn is still one item at a time.
 *  - the daily sweep (incoming.sweep): a batch past its end, removed with
 *    what is undecided in it, its bytes and pages first; and a household
 *    whose items have waited ten minutes undrawn or unread — a job lost —
 *    sent again. The worker's start does the same for every household, and
 *    first puts back to waiting any read a worker that stopped left taken.
 *
 * Nobody is told of an item: it is its uploader's own, and they are
 * looking at it.
 */

/** The job's name, as the API sends it (its BATCH_PREVIEWS_JOB). */
export const BATCH_PREVIEWS = 'batch.previews';

/** One queued and one running a household: the API's batchPreviewsKey. */
export const batchPreviewsKey = (householdId: string) => `batch-previews:${householdId}`;

export interface BatchPreviewsJob {
  household_id: string;
}

/** How one item's pages are drawn: drawIncoming, unless a test stands in. */
export type DrawItem = typeof drawIncoming;

/**
 * One household's next item drawn: the oldest that has arrived and not
 * been drawn (or whose drawing died an hour ago), in any batch of any
 * uploader. Answers what it drew, and whether more are waiting.
 */
export async function drawNextBatchItem(
  deps: IncomingDeps,
  job: BatchPreviewsJob,
  draw: DrawItem = drawIncoming,
): Promise<{ drawn: string | null; more: boolean }> {
  const hh = job.household_id;
  const waiting = () =>
    withSystem(deps.db, hh, (trx) =>
      trx
        .selectFrom('incoming_file')
        .select(['id', 'mime', 'storage_key', 'vault_id', 'file_key_wrapped', 'wrapped_by_scope'])
        .where('batch_id', 'is not', null)
        .where('state', '=', 'received')
        .where(undrawn)
        .orderBy('received_at')
        .orderBy('id')
        .limit(2)
        .execute(),
    );
  const [next] = await waiting();
  if (!next) return { drawn: null, more: false };
  await draw(deps, hh, next);
  const left = await waiting();
  return { drawn: next.id, more: left.length > 0 };
}

/**
 * The job, on a queue of its own: `stately`, so one waits and one runs a
 * household, and each run sends the next. main.ts registers it so, and
 * the ordering test the same way.
 *
 * Whatever happens in a run (the I2 review, P-I2-1), it ends by sending the
 * household's next while there is work left: at once, or — where all that
 * is left is an item waiting to be read again — once its wait is over. A
 * run may take BATCH_JOB_EXPIRE_SECONDS before the queue takes it as lost:
 * above a read's deadline, under the time a read is taken as stale.
 */
export async function workBatchPreviews(
  boss: PgBoss,
  deps: IncomingDeps,
  opts: { draw?: DrawItem; pollingIntervalSeconds?: number; read?: ReadOptions } = {},
): Promise<void> {
  const settings = {
    retryLimit: 2,
    retryDelay: 30,
    expireInSeconds: BATCH_JOB_EXPIRE_SECONDS,
  };
  await boss.createQueue(BATCH_PREVIEWS, { policy: 'stately', ...settings });
  // A queue made before I2 takes the expiry too.
  await boss.updateQueue(BATCH_PREVIEWS, settings);
  await boss.work<BatchPreviewsJob>(
    BATCH_PREVIEWS,
    {
      batchSize: 1,
      ...(opts.pollingIntervalSeconds
        ? { pollingIntervalSeconds: opts.pollingIntervalSeconds }
        : {}),
    },
    async (jobs) => {
      for (const job of jobs) {
        const hh = job.data.household_id;
        try {
          await drawNextBatchItem(deps, job.data, opts.draw);
          // Then one item read, drawn already: this one, or one before it.
          if (opts.read) await readNextBatchItem(deps, hh, opts.read);
        } finally {
          // Not known: asked again in a little while, never at once (the I2 check).
          const left = await batchWorkLeft(deps, hh, Boolean(opts.read)).catch((err: unknown) => {
            deps.log('warn', 'could not tell what a household’s batches have left', {
              household: hh,
              err: (err as Error).message.slice(0, 200),
            });
            return { now: false, at: new Date(Date.now() + LEFT_UNKNOWN_MS) };
          });
          if (left.now) await sendBatchPreviews(boss, hh);
          else if (left.at) await sendBatchPreviews(boss, hh, left.at);
        }
      }
    },
  );
}

/** What a household's batches have left could not be told: asked again this much later. */
export const LEFT_UNKNOWN_MS = 30_000;

/**
 * One household's job, behind whatever else is queued, and dropped if one
 * already waits. One for later (`after`) waits under a key of its own (the
 * I2 check): queued with a time ahead, it would otherwise drop the job a new
 * upload sends, and the upload would wait for it.
 */
export async function sendBatchPreviews(
  boss: PgBoss,
  householdId: string,
  after?: Date,
): Promise<void> {
  await boss.send(
    BATCH_PREVIEWS,
    { household_id: householdId },
    after
      ? { singletonKey: batchPreviewsLaterKey(householdId), startAfter: after }
      : { singletonKey: batchPreviewsKey(householdId) },
  );
}

/** The key a household's job for later waits under. */
export const batchPreviewsLaterKey = (householdId: string) =>
  `${batchPreviewsKey(householdId)}:later`;

/**
 * What one household's batches have left to do (the I2 review): an item to
 * draw, or — where this worker reads — one drawn to read, now; or else the
 * soonest an item waiting to be read again may be taken.
 */
export async function batchWorkLeft(
  deps: Pick<IncomingDeps, 'db'>,
  hh: string,
  reads = true,
): Promise<{ now: boolean; at: Date | null }> {
  return withSystem(deps.db, hh, async (trx) => {
    const now = await trx
      .selectFrom('incoming_file')
      .select('id')
      .where('batch_id', 'is not', null)
      .where('state', '=', 'received')
      .where((eb) =>
        reads ? eb.or([undrawn(eb), eb.and([unread(eb), drawnOrNot(eb)])]) : undrawn(eb),
      )
      .limit(1)
      .executeTakeFirst();
    if (now) return { now: true, at: null };
    if (!reads) return { now: false, at: null };
    const later = await trx
      .selectFrom('incoming_file')
      .select((eb) => eb.fn.min('read_not_before').as('at'))
      .where('batch_id', 'is not', null)
      .where('state', '=', 'received')
      .where('read_state', '=', 'waiting')
      .where('read_not_before', '>', new Date())
      .executeTakeFirst();
    // And one left reading — a database blip as it was written — when it
    // is taken as stale (the I2 check), not at the nightly sweep.
    const stuck = await trx
      .selectFrom('incoming_file')
      .select((eb) => eb.fn.min('read_started_at').as('at'))
      .where('batch_id', 'is not', null)
      .where('state', '=', 'received')
      .where('read_state', '=', 'reading')
      .executeTakeFirst();
    const times = [
      later?.at ? new Date(later.at) : null,
      stuck?.at ? new Date(new Date(stuck.at).getTime() + READ_STALE_MS + 1000) : null,
    ].filter((t): t is Date => t !== null);
    const at = times.length ? new Date(Math.min(...times.map((t) => t.getTime()))) : null;
    return { now: false, at };
  });
}

/**
 * Each night, for one household: a batch past its end removed, with what
 * is undecided in it — its bytes and every page first, then its rows, then
 * the batch, whose decided rows go with it (a removed item's bytes not yet
 * known to be gone are left to purge.leftovers, 0047). An object that
 * cannot be reached keeps its item, and the batch, until the next night.
 * Answers how many batches, and how many items, went.
 */
export async function sweepBatches(
  deps: IncomingDeps,
  hh: string,
  now: Date,
): Promise<{ batches: number; items: number }> {
  const ended = await withSystem(deps.db, hh, (trx) =>
    trx.selectFrom('intake_batch').select('id').where('ends_at', '<=', now).orderBy('id').execute(),
  );
  let batches = 0;
  let items = 0;
  for (const { id } of ended) {
    const out = await withSystem(deps.db, hh, async (trx) => {
      // Held: an upload or a decision under way waits for this, and this for it.
      const held = await trx
        .selectFrom('intake_batch')
        .select('id')
        .where('id', '=', id)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!held) return { batches: 0, items: 0 };
      const undecided = await trx
        .selectFrom('incoming_file')
        .select(['id', 'storage_key', 'vault_id'])
        .where('batch_id', '=', id)
        .where('state', 'in', ['uploading', 'received'])
        .orderBy('id')
        .forUpdate()
        .execute();
      const gone: string[] = [];
      for (const f of undecided) {
        const removed = await adapterOf(trx, deps, f.vault_id)
          .then((a) => removeObjects(a, f))
          .then(
            () => true,
            () => false,
          );
        if (removed) gone.push(f.id);
      }
      if (gone.length > 0) {
        await trx.deleteFrom('incoming_file').where('id', 'in', gone).execute();
      }
      if (gone.length < undecided.length) return { batches: 0, items: gone.length };
      await trx.deleteFrom('intake_batch').where('id', '=', id).execute();
      return { batches: 1, items: gone.length };
    });
    batches += out.batches;
    items += out.items;
  }
  return { batches, items };
}

/**
 * Whether a household has an item that arrived ten minutes ago and is still
 * not drawn, or drawn and still not read.
 */
export async function staleBatchItems(deps: IncomingDeps, hh: string, now: Date): Promise<boolean> {
  const stale = await withSystem(deps.db, hh, (trx) =>
    trx
      .selectFrom('incoming_file')
      .select('id')
      .where('batch_id', 'is not', null)
      .where('state', '=', 'received')
      .where('received_at', '<', new Date(now.getTime() - 10 * 60_000))
      .where((eb) => eb.or([undrawn(eb), eb.and([unread(eb), drawnOrNot(eb)])]))
      .limit(1)
      .execute(),
  );
  return stale.length > 0;
}

/**
 * On the worker's start: a read a worker that stopped left taken is put back
 * to waiting, and every household with an item to draw or read is sent its
 * job, so nothing waits for the nightly sweep. Answers the households sent.
 */
export async function resumeBatchItems(
  deps: Pick<IncomingDeps, 'admin' | 'db'>,
  send: (householdId: string) => Promise<void>,
): Promise<number> {
  const { rows } = await deps.admin.query<{ household_id: string }>(
    `select distinct household_id from incoming_file
      where batch_id is not null and state = 'received'
        and (read_state in ('waiting', 'reading') or preview_state in ('none', 'drawing'))
      order by household_id`,
  );
  for (const { household_id: hh } of rows) {
    await withSystem(deps.db, hh, (trx) =>
      trx
        .updateTable('incoming_file')
        .set({ read_state: 'waiting', read_started_at: null })
        .where('batch_id', 'is not', null)
        .where('state', '=', 'received')
        .where('read_state', '=', 'reading')
        .execute(),
    );
    await send(hh);
  }
  return rows.length;
}
