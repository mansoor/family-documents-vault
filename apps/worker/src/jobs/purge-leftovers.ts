import { withSystem, type Db } from '@fdv/db';
import { adapterFromRow, StorageError, type StorageAdapter } from '@fdv/storage';
import type pg from 'pg';

export interface PurgeLeftoversDeps {
  admin: pg.Pool;
  app: Db;
  credentialsKey: Buffer;
  localRoot: string;
  log?: (level: string, msg: string, extra?: Record<string, unknown>) => void;
}

/** What one job sends: one household's, after a removal could not finish. */
export interface PurgeLeftoversJob {
  household_id?: string;
}

/** Rows taken at a time, so a household with many never holds one long transaction. */
const BATCH = 500;

/**
 * The objects a removal for good wrote down and could not delete then
 * (purge_leftover, 0045; the API's purge.ts): deleted now, each row going
 * with its object. A missing object is deleted already. One that cannot be
 * reached keeps its row, with how often it was tried and why it failed,
 * until the next time — one household's when a removal asks, every
 * household's each night — so no object a removal owned is ever forgotten.
 */
export async function removeLeftovers(
  deps: PurgeLeftoversDeps,
  only?: { household_id: string },
): Promise<{ removed: number; left: number }> {
  const households = only
    ? [only.household_id]
    : (
        await deps.admin.query<{ household_id: string }>(
          'select distinct household_id from purge_leftover',
        )
      ).rows.map((r) => r.household_id);
  let removed = 0;
  let left = 0;
  for (const hh of households) {
    const adapters = new Map<string, StorageAdapter | null>();
    let after = '0';
    for (;;) {
      const rows = await withSystem(deps.app, hh, (trx) =>
        trx
          .selectFrom('purge_leftover')
          .select(['id', 'vault_id', 'object_key'])
          .where('id', '>', after)
          .orderBy('id')
          .limit(BATCH)
          .execute(),
      );
      if (!rows.length) break;
      after = rows[rows.length - 1]?.id ?? after;
      const done: string[] = [];
      const failed = new Map<string, string>();
      for (const r of rows) {
        if (!adapters.has(r.vault_id)) {
          const vault = await withSystem(deps.app, hh, (trx) =>
            trx.selectFrom('vault').selectAll().where('id', '=', r.vault_id).executeTakeFirst(),
          );
          let opened: StorageAdapter | null;
          try {
            opened = vault ? adapterFromRow(vault, deps.credentialsKey, deps.localRoot) : null;
          } catch {
            opened = null;
          }
          adapters.set(r.vault_id, opened);
        }
        const adapter = adapters.get(r.vault_id);
        if (!adapter) {
          failed.set(r.id, 'the place its files are kept could not be opened');
          continue;
        }
        try {
          await adapter.delete(r.object_key);
          done.push(r.id);
        } catch (err) {
          if (err instanceof StorageError && err.code === 'not_found') done.push(r.id);
          else failed.set(r.id, err instanceof Error ? err.message : String(err));
        }
      }
      await withSystem(deps.app, hh, async (trx) => {
        if (done.length) await trx.deleteFrom('purge_leftover').where('id', 'in', done).execute();
        for (const [id, why] of failed) {
          await trx
            .updateTable('purge_leftover')
            .set((eb) => ({ tries: eb('tries', '+', 1), last_error: why.slice(0, 500) }))
            .where('id', '=', id)
            .execute();
        }
      });
      removed += done.length;
      left += failed.size;
    }
  }
  if (removed || left) {
    deps.log?.(left ? 'warn' : 'info', 'files of documents removed for good deleted', {
      removed,
      left,
    });
  }
  return { removed, left };
}
