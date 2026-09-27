import {
  addDays,
  derivedFireDates,
  localToday,
  reminderWord,
  wellFormedDate,
  type DateValue,
  type ReminderWords,
} from '@fdv/shared';
import type { Db } from './client.js';

/**
 * The kind's word for the date each derived reminder is about (0.5.15),
 * by reminder id: "Due date", "Expires", "Review by", "MOT" — as the
 * household has the kind, in the caller's transaction. A field the kind no
 * longer asks for is named from the library. Manual reminders have none.
 */
export async function reminderWords(
  trx: Db,
  rows: ReadonlyArray<{
    id: string;
    kind: string;
    source: string | null;
    type_key: string | null;
  }>,
): Promise<Map<string, string>> {
  const derived = rows.filter((r) => r.kind === 'derived' && r.source);
  if (derived.length === 0) return new Map();
  const keys = [...new Set(derived.flatMap((r) => (r.type_key ? [r.type_key] : [])))];
  const types = keys.length
    ? await trx
        .selectFrom('effective_document_type')
        .select(['key', 'expiry_driver', 'core', 'fields'])
        .where('key', 'in', keys)
        .execute()
    : [];
  const byKey = new Map(types.map((t) => [t.key, t as unknown as ReminderWords]));
  const loose = [
    ...new Set(
      derived
        .filter(
          (r) =>
            r.source !== 'expires' &&
            !(byKey.get(r.type_key ?? '')?.fields ?? []).some((f) => f.key === r.source),
        )
        .map((r) => r.source as string),
    ),
  ];
  const library = loose.length
    ? await trx
        .selectFrom('document_attribute')
        .select(['key', 'label'])
        .where('key', 'in', loose)
        .execute()
    : [];
  return new Map(
    derived.map((r) => [
      r.id,
      reminderWord(byKey.get(r.type_key ?? ''), r.source as string, library),
    ]),
  );
}

/** How a document's reminders are made again: see regenerateDerived. */
export interface RegenerateOptions {
  /**
   * Only reminders whose day is still ahead are made: the type changed,
   * not the document (types.regenerate). Left out, the nearest lead whose
   * day has passed is made `due`, as when the document itself is filed or
   * edited.
   */
  aheadOnly?: boolean;
  /**
   * The document's details as its caller holds them open, by key: an Only
   * me document's are sealed (0.5.8), and the reminding date is read from
   * here when it is one of them (0.5.15, A62). Its owner's own write passes
   * what it already holds open; the worker's types.regenerate opens that
   * one date and passes `{ [key]: value }` alone.
   */
  details?: Record<string, unknown> | undefined;
}

/**
 * A write reached an Only me document's reminders without the sealed date
 * they count back from (0.5.15). It fails, and with it the write, rather
 * than quietly dropping its owner's reminders: a path that forgot to pass
 * the date is found by a test, not by a missed bill.
 */
export class SealedDateNeeded extends Error {
  constructor(
    readonly documentId: string,
    readonly key: string,
  ) {
    super(
      `the reminders of document ${documentId} need its sealed date ${key}, which was not passed`,
    );
    this.name = 'SealedDateNeeded';
  }
}

/** A date detail's day, or null for anything that is not a date. */
function dayOf(value: unknown): string | null {
  return value && typeof value === 'object' && wellFormedDate(value as DateValue)
    ? (value as DateValue).date
    : null;
}

const has = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);

/**
 * A document's derived reminders, made again from its type and the date
 * the type reminds from (0.5.15): its expiry, or one of its date details —
 * a bill's due date. One for each of the type's lead times, as the
 * caller's household has the type (0031). Runs in the caller's
 * transaction: the API's, when somebody files or edits a document, and the
 * worker's, when a type changes (types.regenerate), so both make them the
 * same way.
 *
 * Each reminder says which date it is about (`source`), and is keyed by
 * that date, its lead and its day. One that is to be exactly as it was is
 * left as it was (0.5.10): done, snoozed or settled by a new copy stays so.
 * The rest are taken away and made new — when the type moves to another
 * date, every reminder about the old one, done ones included.
 *
 * What has passed:
 *
 *  - A date field's day that has already passed makes nothing and takes
 *    nothing away: a bill filed after it was paid is reminded of nothing,
 *    and an edit after its due day never deletes a reminder nobody has
 *    dealt with. Removing the date removes its reminders, as for Expires.
 *    An expiry that has passed still makes one, as always.
 *  - Of the reminders whose day has passed, at most one is made `due`: the
 *    one nearest the date, and none if one nearer is already held. A bill
 *    filed on its due day with 7 days and 1 day is one line in the digest,
 *    not two; a passport filed with two months left is in the
 *    needs-attention strip straight away, once. This is so for Expires too.
 *  - When its type changed (`aheadOnly`, the 5.11 review), only reminders
 *    still ahead are made: a lead added to Passport is about what is
 *    coming, not a due reminder for every passport kept for the record.
 *
 * An Only me document's details are sealed: its reminding date is read
 * from `opts.details`, and one that lists the date as sealed with none
 * passed throws SealedDateNeeded. In the Trash it has no reminders, and
 * needs no date.
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
    .select([
      'document.id',
      'document.expires_on',
      'document.deleted_at',
      'document.type_key',
      'document.extra',
      'document.sealed_details',
    ])
    .where('document.id', '=', documentId)
    .forUpdate()
    .executeTakeFirst();
  const type =
    doc?.type_key && !doc.deleted_at
      ? await trx
          .selectFrom('effective_document_type')
          .select(['remind_from', 'remind_leads'])
          .where('key', '=', doc.type_key)
          .executeTakeFirst()
      : undefined;
  const source = type?.remind_from ?? null;
  const leads = type?.remind_leads ?? [];

  let date: string | null = null;
  if (doc && source === 'expires') {
    date = doc.expires_on ? String(doc.expires_on).slice(0, 10) : null;
  } else if (doc && source) {
    if (opts.details && has(opts.details, source)) {
      date = dayOf(opts.details[source]);
    } else if ((doc.sealed_details ?? []).includes(source)) {
      throw new SealedDateNeeded(doc.id, source);
    } else {
      const extra = doc.extra && typeof doc.extra === 'object' ? doc.extra : {};
      date = dayOf((extra as Record<string, unknown>)[source]);
    }
  }

  const held = await trx
    .selectFrom('reminder')
    .select(['id', 'lead_days', 'fire_at', 'source'])
    .where('document_id', '=', documentId)
    .where('kind', '=', 'derived')
    .orderBy('created_at')
    .execute();
  const hh = await trx
    .selectFrom('household')
    .select('timezone')
    .where('id', '=', householdId)
    .executeTakeFirstOrThrow();
  const today = localToday(hh.timezone);
  const dayOfRow = (r: { fire_at: unknown }) => String(r.fire_at).slice(0, 10);

  // A date field's day gone by: nothing made, and nothing overdue taken
  // away. Reminders about another source go, as always, and so do this
  // field's own about a day still to come: the date is gone by, so they are
  // about one it no longer holds (a due date put right from ahead to gone
  // by must not keep reminding of the old one).
  if (source && source !== 'expires' && date !== null && date < today) {
    const other = held
      .filter(
        (r) =>
          r.source !== source || r.lead_days === null || addDays(dayOfRow(r), r.lead_days) >= today,
      )
      .map((r) => r.id);
    if (other.length) await trx.deleteFrom('reminder').where('id', 'in', other).execute();
    return;
  }

  const wanted =
    source && date && leads.length
      ? derivedFireDates(date, leads).map((w) => ({
          ...w,
          key: `${source}:${w.lead}:${w.fire_at}`,
        }))
      : [];
  const kept = new Set<string>();
  const keptRows: typeof held = [];
  const drop: string[] = [];
  for (const r of held) {
    const at = `${r.source}:${r.lead_days}:${dayOfRow(r)}`;
    if (!kept.has(at) && wanted.some((w) => w.key === at)) {
      kept.add(at);
      keptRows.push(r);
    } else drop.push(r.id);
  }
  if (drop.length) await trx.deleteFrom('reminder').where('id', 'in', drop).execute();

  const missing = wanted.filter((w) => !kept.has(w.key));
  const make = missing.filter((w) => w.fire_at > today);
  if (!opts.aheadOnly) {
    // The nearest of those whose day has passed, unless one nearer is held.
    const nearest = missing
      .filter((w) => w.fire_at <= today)
      .reduce<(typeof missing)[number] | null>((n, w) => (!n || w.lead < n.lead ? w : n), null);
    const nearer =
      nearest &&
      keptRows.some(
        (r) => r.lead_days !== null && r.lead_days < nearest.lead && dayOfRow(r) <= today,
      );
    if (nearest && !nearer) make.push(nearest);
  }
  for (const { lead, fire_at } of make) {
    await trx
      .insertInto('reminder')
      .values({
        household_id: householdId,
        document_id: documentId,
        kind: 'derived',
        source,
        fire_at,
        lead_days: lead,
        status: fire_at <= today ? 'due' : 'scheduled',
      })
      .execute();
  }
}
