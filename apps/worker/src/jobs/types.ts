import { regenerateDerived, withSystem, type Db } from '@fdv/db';

/** What types.regenerate is asked to do: one type, in one household. The API's REGENERATE_JOB. */
export interface RegenerateTypeJob {
  household_id: string;
  type_key: string;
}

/**
 * types.regenerate (0.5.10): every document of one type has its reminders
 * made again, after the household changed the type's lead times or
 * switched its Expires on or off. Every document of the type, whoever can
 * see it — an adult's Only me passport is reminded like any other — so as
 * the vault itself, in the type's household.
 *
 * One document per transaction, as private.seal does: a household with
 * many is never held in one long transaction, and one that fails leaves
 * the others done. The reminders are made as the API makes them when a
 * document is edited (regenerateDerived, @fdv/db), from the type and the
 * expiry date, which is never sealed: nothing sealed needs opening, and
 * nothing is. In the Trash too, so a document restored later has none left
 * over from the old lead times.
 */
export async function regenerateTypeReminders(
  app: Db,
  job: RegenerateTypeJob,
): Promise<{ documents: number; failed: number; firstError?: string }> {
  const ids = await withSystem(app, job.household_id, (trx) =>
    trx
      .selectFrom('document')
      .select('id')
      .where('type_key', '=', job.type_key)
      .orderBy('id')
      .execute(),
  );
  let documents = 0;
  let failed = 0;
  let firstError: string | undefined;
  for (const { id } of ids) {
    try {
      await withSystem(app, job.household_id, (trx) =>
        regenerateDerived(trx, job.household_id, id),
      );
      documents += 1;
    } catch (err) {
      failed += 1;
      firstError ??= (err as Error).message;
    }
  }
  return { documents, failed, ...(firstError !== undefined ? { firstError } : {}) };
}
