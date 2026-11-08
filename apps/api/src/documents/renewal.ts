import type { Db } from '@fdv/db';
import type { DateValue } from '@fdv/shared';
import { sql } from 'kysely';

/**
 * A renewal's details put on a document, and taken back (0.8.0, S1; 0.9.0):
 * one way, shared by a batch's file added as a new version of a document
 * (uploads/batches.ts) and by "Use these" on a document whose newest
 * version's pages say other dates (DocumentService.applyRenewal).
 *
 * Only what differs is changed, through the edit every change goes
 * through (so the activity log says what changed, and the reminders are
 * made again from the new date). Beforehand, what it replaces is noted:
 * the fields as they were, the document's derived reminders as they were
 * by what each reminds of (an expiry changed makes them again, under new
 * ids), and the last line of the activity log about it — what comes after
 * that line, a look aside, is a change since, and an Undo then keeps it.
 */

/** A renewal's fields, as a document keeps them. */
export type PriorFields = {
  identifier?: string | null;
  issued?: DateValue | null;
  expires?: DateValue | null;
  issued_by?: string | null;
};

/** A derived reminder as it was, by what it reminds of (source:lead:fire_at). */
export interface DerivedReminder {
  key: string;
  status: string;
  snoozed_until: string | null;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
}

/** A look at a document, or a phone keeping it: not a change to it. */
export const LOOKS = [
  'document.viewed',
  'document.downloaded',
  'document.cached_offline',
  'document.opened_offline',
];

export const REMINDER_OPEN = new Set(['scheduled', 'due', 'snoozed']);
const REMINDER_STATES = new Set(['scheduled', 'due', 'snoozed', 'acknowledged', 'resolved']);

/** A document's date as its columns hold it. */
export function dateOf(on: string | null, precision: string | null): DateValue | null {
  return on
    ? { date: on.slice(0, 10), precision: (precision ?? 'day') as DateValue['precision'] }
    : null;
}

/** The same date, as a document keeps it. */
export function sameDay(a: DateValue | null, b: DateValue | null): boolean {
  return a === null || b === null
    ? a === b
    : a.date.slice(0, 10) === b.date.slice(0, 10) && a.precision === b.precision;
}

/** Its derived reminders as they are now, by what each reminds of. */
export async function derivedAsTheyAre(trx: Db, documentId: string): Promise<DerivedReminder[]> {
  return (
    await trx
      .selectFrom('reminder')
      .select([
        sql<string>`source || ':' || lead_days || ':' || to_char(fire_at, 'YYYY-MM-DD')`.as('key'),
        'status',
        sql<string | null>`to_char(snoozed_until, 'YYYY-MM-DD')`.as('snoozed_until'),
        'acknowledged_by',
        'acknowledged_at',
      ])
      .where('document_id', '=', documentId)
      .where('kind', '=', 'derived')
      .orderBy('id')
      .execute()
  ).map((r) => ({
    key: r.key,
    status: r.status,
    snoozed_until: r.snoozed_until,
    acknowledged_by: r.acknowledged_by,
    acknowledged_at: r.acknowledged_at ? r.acknowledged_at.toISOString() : null,
  }));
}

/**
 * What a renewal changes: of the fields `sent`, only those that differ from
 * what the document holds (`was`) — the edit to make, and what it replaces.
 */
export function renewalChange(
  was: PriorFields,
  sent: PriorFields,
): { edit: PriorFields; before: PriorFields } {
  const edit: PriorFields = {};
  const before: PriorFields = {};
  for (const k of ['identifier', 'issued_by'] as const) {
    if (sent[k] === undefined) continue;
    const v = sent[k]?.trim() || null;
    if (v !== (was[k] ?? null)) {
      edit[k] = v;
      before[k] = was[k] ?? null;
    }
  }
  for (const k of ['issued', 'expires'] as const) {
    const v = sent[k];
    if (v === undefined) continue;
    if (!sameDay(v ?? null, was[k] ?? null)) {
      edit[k] = v ?? null;
      before[k] = was[k] ?? null;
    }
  }
  return { edit, before };
}

/** The last line of the activity log about a document (the log is held to its commit). */
export async function lastLine(
  trx: Db,
  householdId: string,
  documentId: string,
): Promise<string | null> {
  const line = await trx
    .selectFrom('audit_event')
    .select((eb) => eb.fn.max('id').as('id'))
    .where('household_id', '=', householdId)
    .where('object_type', '=', 'document')
    .where('object_id', '=', documentId)
    .executeTakeFirst();
  return line?.id === null || line?.id === undefined ? null : String(line.id);
}

/**
 * Whether anything changed the document after `line` — every change is a
 * line in the log, and the log's own order says what came after, never a
 * clock (the S1 review, L3). No line known: changed, to be safe.
 */
export async function changedSince(
  trx: Db,
  householdId: string,
  documentId: string,
  line: string | null,
): Promise<boolean> {
  if (!line) return true;
  const since = await trx
    .selectFrom('audit_event')
    .select('id')
    .where('household_id', '=', householdId)
    .where('object_type', '=', 'document')
    .where('object_id', '=', documentId)
    .where(sql<boolean>`id > ${line}::bigint`)
    .where('action', 'not in', LOOKS)
    .limit(1)
    .executeTakeFirst();
  return since !== undefined;
}

/**
 * Its derived reminders, each put back as it was — the edit that put the
 * date back may have made them again, under new ids — by what each reminds
 * of: acknowledged, snoozed, or open (the S1 review, M1).
 */
export async function putDerivedBack(
  trx: Db,
  documentId: string,
  derived: readonly DerivedReminder[],
): Promise<void> {
  for (const d of derived) {
    await trx
      .updateTable('reminder')
      .set({
        status: d.status as 'scheduled' | 'due' | 'snoozed' | 'acknowledged' | 'resolved',
        snoozed_until: d.snoozed_until,
        acknowledged_by: d.acknowledged_by,
        acknowledged_at: d.acknowledged_at ? new Date(d.acknowledged_at) : null,
      })
      .where('document_id', '=', documentId)
      .where('kind', '=', 'derived')
      .where(
        sql<boolean>`source || ':' || lead_days || ':' || to_char(fire_at, 'YYYY-MM-DD') = ${d.key}`,
      )
      .execute();
  }
}

/** Fields as kept for an Undo, well formed; null when they are not. */
export function storedFields(raw: unknown): PriorFields | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  const fields: PriorFields = {};
  for (const k of ['identifier', 'issued_by'] as const) {
    if (!(k in f)) continue;
    const v = f[k];
    if (v !== null && typeof v !== 'string') return null;
    fields[k] = v;
  }
  for (const k of ['issued', 'expires'] as const) {
    if (!(k in f)) continue;
    const d = f[k] as { date?: unknown; precision?: unknown } | null;
    if (d === null) fields[k] = null;
    else if (
      d &&
      typeof d.date === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(d.date) &&
      ['day', 'month', 'year'].includes(String(d.precision))
    ) {
      fields[k] = { date: d.date, precision: d.precision as DateValue['precision'] };
    } else return null;
  }
  return fields;
}

/** Derived reminders as kept for an Undo, the well-formed ones. */
export function storedDerived(raw: unknown): DerivedReminder[] {
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return (Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : []).flatMap((d) =>
    d && typeof d.key === 'string' && REMINDER_STATES.has(String(d.status))
      ? [
          {
            key: d.key,
            status: String(d.status),
            snoozed_until: str(d.snoozed_until),
            acknowledged_by: str(d.acknowledged_by),
            acknowledged_at: str(d.acknowledged_at),
          },
        ]
      : [],
  );
}

/** A log line's id as kept, or null. */
export function storedLine(raw: unknown): string | null {
  return typeof raw === 'string' && /^\d+$/.test(raw) ? raw : null;
}
