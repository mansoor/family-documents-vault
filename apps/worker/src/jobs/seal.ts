import {
  openPrivate,
  openVersionExtra,
  sealPrivate,
  sealVersionExtra,
  type ScopeKeys,
} from '@fdv/crypto';
import { withSystem, type Db } from '@fdv/db';
import type pg from 'pg';

/**
 * private.seal (0.5.8): the notes and details of documents that are Only me
 * already, sealed under their owner's member key and taken out of the plain
 * columns.
 *
 * From 0.5.8 the API seals them as their owner writes them, and moves them
 * when a document is made Only me or visible again. What was written before
 * is sealed here, because SQL holds no keys: on the worker's start (after
 * the upgrade, the one that matters), and by a restore before the vault
 * opens, since a backup can be older than a sealing.
 *
 * One document per transaction: a household with many is never held in
 * one long transaction, what is done stays done if the worker stops, and a
 * document that cannot be sealed leaves the others sealed. Each is locked
 * and looked at again in its own: one made visible meanwhile is left as it
 * now is.
 *
 * Nobody edited anything, as with a migration: no document's updated_at
 * moves, and no audit event is written.
 */

export interface SealDeps {
  /** The owning role: finds them, across households, and only reads. */
  admin: pg.Pool;
  /** The application role: seals each, as the vault itself, in its household. */
  app: Db;
  keys: ScopeKeys;
  log: (level: string, msg: string, extra?: Record<string, unknown>) => void;
}

export async function sealPrivateValues(
  deps: SealDeps,
): Promise<{ sealed: number; failed: number; firstError?: string }> {
  // In the bin too: it is in every backup as much as the rest.
  const { rows } = await deps.admin.query<{ household_id: string; id: string }>(
    `select household_id, id from document
      where visibility = 'private' and (notes is not null or extra <> '{}'::jsonb)
      order by household_id, id`,
  );
  let sealed = 0;
  let failed = 0;
  let firstError: string | undefined;
  for (const r of rows) {
    try {
      const done = await withSystem(deps.app, r.household_id, (trx) =>
        sealOne(trx, deps.keys, r.household_id, r.id),
      );
      if (done) sealed += 1;
    } catch (err) {
      failed += 1;
      firstError ??= (err as Error).message;
      deps.log('error', "an Only me document's notes and details could not be sealed", {
        household_id: r.household_id,
        document_id: r.id,
        error: (err as Error).message,
      });
    }
  }
  // And an Only me document's older versions' own details (0.9.0, 0083):
  // the API seals them as it keeps them, but a restore can bring back one
  // kept before its document was made Only me.
  const { rows: versions } = await deps.admin.query<{ household_id: string; id: string }>(
    `select v.household_id, v.id from document_version v
       join document d on d.id = v.document_id
      where d.visibility = 'private' and v.extra <> '{}'::jsonb
      order by v.household_id, v.id`,
  );
  for (const r of versions) {
    try {
      const done = await withSystem(deps.app, r.household_id, (trx) =>
        sealVersionOne(trx, deps.keys, r.household_id, r.id),
      );
      if (done) sealed += 1;
    } catch (err) {
      failed += 1;
      firstError ??= (err as Error).message;
      deps.log('error', "an Only me document's older version's details could not be sealed", {
        household_id: r.household_id,
        version_id: r.id,
        error: (err as Error).message,
      });
    }
  }
  return { sealed, failed, ...(firstError !== undefined ? { firstError } : {}) };
}

/** One older version's details, in its own transaction, its document held first. */
async function sealVersionOne(trx: Db, keys: ScopeKeys, householdId: string, id: string) {
  const v = await trx
    .selectFrom('document_version')
    .select(['document_id'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!v) return false;
  const doc = await trx
    .selectFrom('document')
    .select(['visibility', 'owner_member_id'])
    .where('id', '=', v.document_id)
    .forUpdate()
    .executeTakeFirst();
  if (!doc || doc.visibility !== 'private') return false;
  const row = await trx
    .selectFrom('document_version')
    .select(['extra', 'extra_sealed'])
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
  const extra = extraOf(row?.extra);
  if (!row || Object.keys(extra).length === 0) return false;
  const key = await keys.unwrap(trx, {
    householdId,
    kind: 'member',
    memberId: doc.owner_member_id,
  });
  await trx
    .updateTable('document_version')
    .set({
      extra: '{}',
      extra_sealed: sealVersionExtra(key.key, id, {
        ...openVersionExtra(key.key, id, row.extra_sealed),
        ...extra,
      }),
    })
    .where('id', '=', id)
    .execute();
  return true;
}

/** One document, in its own transaction. False when there was nothing to do by then. */
async function sealOne(trx: Db, keys: ScopeKeys, householdId: string, id: string) {
  const doc = await trx
    .selectFrom('document')
    .select(['visibility', 'owner_member_id', 'notes', 'extra', 'notes_sealed', 'extra_sealed'])
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
  const extra = extraOf(doc?.extra);
  if (!doc || doc.visibility !== 'private') return false;
  if (doc.notes === null && Object.keys(extra).length === 0) return false;
  const key = await keys.unwrap(trx, {
    householdId,
    kind: 'member',
    memberId: doc.owner_member_id,
  });
  // Some of it sealed already (it can be, after a restore): opened, and
  // sealed again with what is plain, which is the newer.
  const before =
    doc.notes_sealed || doc.extra_sealed
      ? openPrivate(key.key, id, doc)
      : { notes: null, extra: {} };
  await trx
    .updateTable('document')
    .set({
      ...sealPrivate(key.key, id, {
        notes: doc.notes ?? before.notes,
        extra: { ...before.extra, ...extra },
      }),
      notes: null,
      extra: '{}',
    })
    .where('id', '=', id)
    .execute();
  return true;
}

/** The details as the database hands them over: an object, or nothing. */
function extraOf(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
