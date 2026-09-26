import { withSystem, type Db } from '@fdv/db';
import { adapterFromRow } from '@fdv/storage';
import type pg from 'pg';

/**
 * The upload keys' housekeeping (0.4.8). Uploads are reserve-then-commit
 * on their Idempotency-Key: a try claims the key, streams its bytes to a
 * temporary object, and commits. What is left over:
 *
 *  - done keys, which answer retries for as long as a retry is plausible:
 *    180 days, the longest a session can last, and then they go;
 *  - claims whose try died without cleaning up (the process stopped
 *    mid-upload). After 15 minutes the same account may take one over;
 *    after a day it goes, and its temporary object with it.
 */
export interface PruneUploadsDeps {
  admin: pg.Pool;
  app: Db;
  credentialsKey: Buffer;
  localRoot: string;
  now?: () => Date;
}

const DAY = 24 * 60 * 60 * 1000;
export const DONE_KEPT_DAYS = 180;

export async function pruneUploads(
  deps: PruneUploadsDeps,
): Promise<{ done: number; abandoned: number }> {
  const now = deps.now?.() ?? new Date();
  const doneBefore = new Date(now.getTime() - DONE_KEPT_DAYS * DAY);
  const claimedBefore = new Date(now.getTime() - DAY);
  let done = 0;
  let abandoned = 0;
  const { rows } = await deps.admin.query<{ id: string }>('select id from household');
  for (const hh of rows) {
    await withSystem(deps.app, hh.id, async (trx) => {
      const gone = await trx
        .deleteFrom('upload_idempotency')
        .where('state', '=', 'done')
        .where('claimed_at', '<', doneBefore)
        .executeTakeFirst();
      done += Number(gone.numDeletedRows);

      const stale = await trx
        .selectFrom('upload_idempotency')
        .select(['idempotency_key', 'temp_key', 'temp_vault_id'])
        .where('state', '=', 'pending')
        .where('claimed_at', '<', claimedBefore)
        .execute();
      for (const s of stale) {
        if (s.temp_key && s.temp_vault_id) {
          const vault = await trx
            .selectFrom('vault')
            .selectAll()
            .where('id', '=', s.temp_vault_id)
            .executeTakeFirst();
          // A vault that cannot be reached keeps its object until next time,
          // and the claim with it, so the object is never forgotten.
          if (vault) {
            // A vault row that cannot be opened (its credentials key changed)
            // fails this one claim, not the sweep.
            const deleted = await Promise.resolve()
              .then(() =>
                adapterFromRow(vault, deps.credentialsKey, deps.localRoot).delete(
                  s.temp_key as string,
                ),
              )
              .then(
                () => true,
                () => false,
              );
            if (!deleted) continue;
          }
        }
        const r = await trx
          .deleteFrom('upload_idempotency')
          .where('idempotency_key', '=', s.idempotency_key)
          .where('state', '=', 'pending')
          .where('claimed_at', '<', claimedBefore)
          .executeTakeFirst();
        abandoned += Number(r.numDeletedRows);
      }
    });
  }
  return { done, abandoned };
}
