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
 *    after a day it goes, and its temporary object with it;
 *  - a person's photo left half made for a day (5.17c), and its upload.
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

/**
 * A vault's object gone, or known gone: true when deleted, or when there is
 * no vault row left to reach it by. A vault row that cannot be opened (its
 * credentials key changed) or a vault that cannot be reached keeps it, and
 * says so, so what points at it is kept until next time.
 */
async function deleteObject(
  trx: Db,
  deps: PruneUploadsDeps,
  at: { key: string | null; vaultId: string | null },
): Promise<boolean> {
  if (!at.key || !at.vaultId) return true;
  const vault = await trx
    .selectFrom('vault')
    .selectAll()
    .where('id', '=', at.vaultId)
    .executeTakeFirst();
  if (!vault) return true;
  return Promise.resolve()
    .then(() => adapterFromRow(vault, deps.credentialsKey, deps.localRoot).delete(at.key as string))
    .then(
      () => true,
      () => false,
    );
}

export async function pruneUploads(
  deps: PruneUploadsDeps,
): Promise<{ done: number; abandoned: number; photos: number }> {
  const now = deps.now?.() ?? new Date();
  const doneBefore = new Date(now.getTime() - DONE_KEPT_DAYS * DAY);
  const claimedBefore = new Date(now.getTime() - DAY);
  let done = 0;
  let abandoned = 0;
  let photos = 0;
  const { rows } = await deps.admin.query<{ id: string }>('select id from household');
  for (const hh of rows) {
    await withSystem(deps.app, hh.id, async (trx) => {
      // A person's photo left half made for a day (5.17c) — its job lost, a
      // restore that marked it failed, a refusal kept for its reason — goes,
      // with any upload still there. A ready photo is never touched.
      const unfinished = await trx
        .selectFrom('member_photo')
        .select(['id', 'source_key', 'source_vault_id'])
        .where('state', '<>', 'ready')
        .where('created_at', '<', claimedBefore)
        .execute();
      for (const u of unfinished) {
        if (!(await deleteObject(trx, deps, { key: u.source_key, vaultId: u.source_vault_id }))) {
          continue;
        }
        const r = await trx
          .deleteFrom('member_photo')
          .where('id', '=', u.id)
          .where('state', '<>', 'ready')
          .executeTakeFirst();
        photos += Number(r.numDeletedRows);
      }

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
        // A vault that cannot be reached keeps its object until next time,
        // and the claim with it, so the object is never forgotten; a vault
        // row that cannot be opened fails this one claim, not the sweep.
        if (!(await deleteObject(trx, deps, { key: s.temp_key, vaultId: s.temp_vault_id }))) {
          continue;
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
  return { done, abandoned, photos };
}
