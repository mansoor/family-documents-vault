import { withSystem } from '@fdv/db';
import type { PgBoss } from 'pg-boss';
import { adapterOf, drawIncoming, removeObjects, undrawn, type IncomingDeps } from './incoming.js';
import { drawnOrNot, readNextBatchItem, unread, type ReadOptions } from './read-item.js';

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
 */
export async function workBatchPreviews(
  boss: PgBoss,
  deps: IncomingDeps,
  opts: { draw?: DrawItem; pollingIntervalSeconds?: number; read?: ReadOptions } = {},
): Promise<void> {
  await boss.createQueue(BATCH_PREVIEWS, { policy: 'stately', retryLimit: 2, retryDelay: 30 });
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
        const r = await drawNextBatchItem(deps, job.data, opts.draw);
        // Then one item read, drawn already: this one, or one before it.
        const read = opts.read
          ? await readNextBatchItem(deps, hh, opts.read)
          : { read: null, more: false };
        if (r.more || read.more) await sendBatchPreviews(boss, hh);
      }
    },
  );
}

/** One household's job, behind whatever else is queued; dropped if one already waits. */
export async function sendBatchPreviews(boss: PgBoss, householdId: string): Promise<void> {
  await boss.send(
    BATCH_PREVIEWS,
    { household_id: householdId },
    { singletonKey: batchPreviewsKey(householdId) },
  );
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
