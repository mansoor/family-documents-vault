import { derivedFireDates, localToday } from '@fdv/shared';
import type { Db } from './client.js';

/** How a document's reminders are made again: see regenerateDerived. */
export interface RegenerateOptions {
  /**
   * Only reminders whose day is still ahead are made: the type changed,
   * not the document (types.regenerate). Left out, a lead whose day has
   * passed is made `due`, as when the document itself is filed or edited.
   */
  aheadOnly?: boolean;
}

/**
 * A document's derived reminders, made again from its type and its expiry
 * date: one for each of the type's lead times, as the caller's household
 * has the type (0031) — its own lead times, and none where it has switched
 * Expires off. Runs in the caller's transaction: the API's, when somebody
 * files or edits a document, and the worker's, when a type's lead times
 * change (types.regenerate, 0.5.10), so both make them the same way.
 *
 * A lead whose date has passed is made `due`, so a passport added with two
 * months left is in the needs-attention strip straight away — when the
 * document is filed or edited. When its type changed (`aheadOnly`, the 5.11
 * review), only a reminder whose day is still ahead is made: a lead added
 * to Passport, or Expires switched off and on again, is about what is
 * coming, not a due reminder for every passport the family keeps for the
 * record, long expired, nor one it has already dealt with and that the
 * switch took away.
 *
 * A reminder that is to be exactly as it was — the same lead, the same day —
 * is left as it was (0.5.10): done, snoozed or settled by a new copy stays
 * so. Before, every reminder was made afresh, so a change to a type's lead
 * times, or an edit that only named the type again, brought back reminders
 * somebody had already dealt with. The rest are taken away and made new.
 *
 * The document is held first: two of these at once for one document (an
 * edit, and the job) would each add what the other had not yet.
 */
export async function regenerateDerived(
  trx: Db,
  householdId: string,
  documentId: string,
  opts: RegenerateOptions = {},
): Promise<void> {
  const doc = await trx
    .selectFrom('document')
    .select(['document.id', 'document.expires_on', 'document.deleted_at', 'document.type_key'])
    .where('document.id', '=', documentId)
    .forUpdate()
    .executeTakeFirst();
  const type = doc?.type_key
    ? await trx
        .selectFrom('effective_document_type')
        .select(['reminder_leads', 'expiry_driver'])
        .where('key', '=', doc.type_key)
        .executeTakeFirst()
    : undefined;
  const wanted =
    doc && !doc.deleted_at && doc.expires_on && type?.expiry_driver && type.reminder_leads?.length
      ? derivedFireDates(String(doc.expires_on).slice(0, 10), type.reminder_leads)
      : [];

  const held = await trx
    .selectFrom('reminder')
    .select(['id', 'lead_days', 'fire_at'])
    .where('document_id', '=', documentId)
    .where('kind', '=', 'derived')
    .orderBy('created_at')
    .execute();
  const kept = new Set<string>();
  const drop: string[] = [];
  for (const r of held) {
    const at = `${r.lead_days}:${String(r.fire_at).slice(0, 10)}`;
    if (!kept.has(at) && wanted.some((w) => `${w.lead}:${w.fire_at}` === at)) kept.add(at);
    else drop.push(r.id);
  }
  if (drop.length) await trx.deleteFrom('reminder').where('id', 'in', drop).execute();

  const missing = wanted.filter((w) => !kept.has(`${w.lead}:${w.fire_at}`));
  if (missing.length === 0) return;
  const hh = await trx
    .selectFrom('household')
    .select('timezone')
    .where('id', '=', householdId)
    .executeTakeFirstOrThrow();
  const today = localToday(hh.timezone);
  for (const { lead, fire_at } of missing) {
    if (opts.aheadOnly && fire_at <= today) continue;
    await trx
      .insertInto('reminder')
      .values({
        household_id: householdId,
        document_id: documentId,
        kind: 'derived',
        fire_at,
        lead_days: lead,
        status: fire_at <= today ? 'due' : 'scheduled',
      })
      .execute();
  }
}
