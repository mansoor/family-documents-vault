import { openPrivate, type ScopeKeys } from '@fdv/crypto';
import { regenerateDerived, withSystem, type Db } from '@fdv/db';

/** What types.regenerate is asked to do: one type, in one household. The API's REGENERATE_JOB. */
export interface RegenerateTypeJob {
  household_id: string;
  type_key: string;
}

export interface RegenerateDeps {
  /** The application role: each document as the vault itself, in its household. */
  app: Db;
  /** Opens an Only me document's reminding date, and nothing else (A62). */
  keys: ScopeKeys;
}

/** What the job did, for the log: counts and document ids, never a value. */
export interface RegenerateResult {
  documents: number;
  failed: number;
  failed_ids?: string[];
}

/**
 * types.regenerate (0.5.10): every document of one type has its reminders
 * made again, after the household changed the date the type reminds from,
 * its lead times, or switched its reminders on or off. Every document of
 * the type, whoever can see it — an adult's Only me passport is reminded
 * like any other — so as the vault itself, in the type's household.
 *
 * One document per transaction, as private.seal does: a household with
 * many is never held in one long transaction, and one that fails leaves
 * the others done. The reminders are made as the API makes them when a
 * document is edited (regenerateDerived, @fdv/db), from the type and the
 * date it reminds from.
 *
 * That date is plain — an expiry, or a household document's due date —
 * except in one case, the one exception to the seal (0.5.15, A62): a type
 * reminding from a date field, on an Only me document whose details are
 * sealed under its owner's key. Then, in that document's own transaction,
 * with its row held first, the owner's member key is unwrapped, the
 * details opened, and that one date alone passed on; nothing else is read
 * from them, nothing is kept, and nothing is logged but counts and ids.
 * Its only plain trace is the reminder rows, as an Only me expiry date's
 * already is. A key that cannot be unwrapped counts the document as
 * failed; the others are done.
 *
 * Not in the Trash: a document there has no reminders, and bringing it
 * back makes them, in its owner's own request.
 *
 * Reminder rows only: no document's updated_at, and so no ETag, moves,
 * and nothing is written to the activity log — nobody edited anything.
 *
 * Only reminders still ahead are made (`aheadOnly`, the 5.11 review): a
 * lead added, or Expires switched off and on again, made one due for every
 * document of the type whose lead day had passed — each passport kept for
 * the record, expired years ago, and each one the family had already
 * acknowledged — and the next digest listed them all.
 */
export async function regenerateTypeReminders(
  deps: RegenerateDeps,
  job: RegenerateTypeJob,
): Promise<RegenerateResult> {
  const ids = await withSystem(deps.app, job.household_id, (trx) =>
    trx
      .selectFrom('document')
      .select('id')
      .where('type_key', '=', job.type_key)
      .where('deleted_at', 'is', null)
      .orderBy('id')
      .execute(),
  );
  let documents = 0;
  const failed: string[] = [];
  for (const { id } of ids) {
    try {
      const done = await withSystem(deps.app, job.household_id, (trx) =>
        remindOne(trx, deps.keys, job.household_id, id),
      );
      if (done) documents += 1;
    } catch {
      // The id alone: an error's words could carry what the document holds.
      failed.push(id);
    }
  }
  return {
    documents,
    failed: failed.length,
    ...(failed.length ? { failed_ids: failed } : {}),
  };
}

/** One document, in its own transaction. False when it is in the Trash by then. */
async function remindOne(
  trx: Db,
  keys: ScopeKeys,
  householdId: string,
  id: string,
): Promise<boolean> {
  // Held first: an edit of it waits, and what is opened is what is there.
  const doc = await trx
    .selectFrom('document')
    .select(['id', 'deleted_at', 'type_key', 'owner_member_id', 'sealed_details', 'extra_sealed'])
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
  if (!doc || doc.deleted_at) return false;
  const type = doc.type_key
    ? await trx
        .selectFrom('effective_document_type')
        .select('remind_from')
        .where('key', '=', doc.type_key)
        .executeTakeFirst()
    : undefined;
  const key = type?.remind_from ?? null;
  let details: Record<string, unknown> | undefined;
  if (key !== null && key !== 'expires' && (doc.sealed_details ?? []).includes(key)) {
    const member = await keys.unwrap(trx, {
      householdId,
      kind: 'member',
      memberId: doc.owner_member_id,
    });
    // The details only (never the notes), and of them the one date.
    const opened = openPrivate(member.key, id, {
      notes_sealed: null,
      extra_sealed: doc.extra_sealed,
    });
    details = { [key]: opened.extra[key] ?? null };
  }
  await regenerateDerived(trx, householdId, id, { aheadOnly: true, details });
  return true;
}
