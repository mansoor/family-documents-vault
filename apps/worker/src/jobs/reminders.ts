import { withHousehold, type Db } from '@fdv/db';
import { addDays, deriveStatus, localHour, localToday, reminderLabel } from '@fdv/shared';
import { sql } from 'kysely';
import type pg from 'pg';

/**
 * The reminder engine's clockwork.
 *
 * `tick` (every 15 minutes): scheduled → due when the household's local
 * date reaches fire_at; snoozed → due when the snooze ends.
 *
 * `deliver` (every hour): for each household whose local hour is 9 and
 * which has not had today's digest, collect everything due that has no
 * delivery row and send ONE notification (REM-05). Nothing fires
 * individually, and a server that was off for nine days produces exactly
 * one summary on restart, because the digest covers every undelivered
 * reminder, however old (REM-13).
 *
 * `refreshStatus` (nightly): materialises status_cache for fast list
 * filtering. Never authoritative — status is computed on read.
 */

export interface Digest {
  household_id: string;
  household_name: string;
  timezone: string;
  local_date: string;
  kind: 'daily' | 'catch_up' | 'weekly';
  items: Array<{
    reminder_id: string;
    document_id: string;
    title: string;
    label: string;
    note: string | null;
    overdue: boolean;
  }>;
}

/** The seam 2.3 fills with email and push. */
export interface Notifier {
  /** Returns the channels it actually delivered on. */
  digest(d: Digest): Promise<string[]>;
}

export const logNotifier = (
  log: (level: string, msg: string, extra?: Record<string, unknown>) => void,
): Notifier => ({
  async digest(d) {
    log('info', 'reminder digest', {
      household: d.household_name,
      kind: d.kind,
      count: d.items.length,
      items: d.items.map((i) => `${i.title}: ${i.label}`),
    });
    return ['log'];
  },
});

export interface ReminderDeps {
  admin: pg.Pool;
  app: Db;
  notifier: Notifier;
  log: (level: string, msg: string, extra?: Record<string, unknown>) => void;
  /** For tests: the current instant. */
  now?: () => Date;
  /** Local hour at which the digest goes out. */
  digestHour?: number;
  /** Local hour for the Sunday summary. */
  weeklyHour?: number;
}

async function households(admin: pg.Pool) {
  const { rows } = await admin.query<{ id: string; name: string; timezone: string }>(
    'select id, name, timezone from household where deleted_at is null',
  );
  return rows;
}

export async function tick(deps: ReminderDeps): Promise<{ became_due: number }> {
  const now = deps.now?.() ?? new Date();
  let total = 0;
  for (const hh of await households(deps.admin)) {
    const today = localToday(hh.timezone, now);
    total += await withHousehold(deps.app, hh.id, async (trx) => {
      const a = await trx
        .updateTable('reminder')
        .set({ status: 'due' })
        .where('status', '=', 'scheduled')
        .where('fire_at', '<=', today)
        .executeTakeFirst();
      const b = await trx
        .updateTable('reminder')
        .set({ status: 'due', snoozed_until: null })
        .where('status', '=', 'snoozed')
        .where('snoozed_until', '<=', today)
        .executeTakeFirst();
      return Number(a.numUpdatedRows) + Number(b.numUpdatedRows);
    });
  }
  return { became_due: total };
}

export async function deliver(deps: ReminderDeps): Promise<{ digests: number }> {
  const now = deps.now?.() ?? new Date();
  const hour = deps.digestHour ?? 9;
  let digests = 0;
  for (const hh of await households(deps.admin)) {
    // At or after the digest hour, never before it: "nothing fires before
    // 9 in the morning" is a promise the screen makes. A server that was
    // off all day and comes back at nine in the evening still owes the
    // household its summary today — the ledger below is what keeps it to
    // one, not the clock.
    if (localHour(hh.timezone, now) < hour) continue;
    const today = localToday(hh.timezone, now);
    const sent = await withHousehold(deps.app, hh.id, async (trx) => {
      const already = await trx
        .selectFrom('notification_digest')
        .select('local_date')
        .where('local_date', '=', today)
        .where('kind', '=', 'daily')
        .executeTakeFirst();
      if (already) return false;

      const due = await trx
        .selectFrom('reminder')
        .innerJoin('document', 'document.id', 'reminder.document_id')
        // Delivered once per reminder: a still-open reminder is not nagged
        // daily. Escalation to the other adults is REM-09, later.
        .leftJoin('reminder_delivery', 'reminder_delivery.reminder_id', 'reminder.id')
        .select([
          'reminder.id',
          'reminder.document_id',
          'reminder.fire_at',
          'reminder.note',
          'reminder.status',
          'reminder.snoozed_until',
          'document.title',
        ])
        .where('reminder.status', '=', 'due')
        .where('document.deleted_at', 'is', null)
        .where('reminder_delivery.reminder_id', 'is', null)
        .orderBy('reminder.fire_at')
        .execute();
      if (due.length === 0) return false;

      const oldest = due.reduce((m, r) => (String(r.fire_at) < m ? String(r.fire_at) : m), today);
      const kind: Digest['kind'] =
        daysBetween(String(oldest).slice(0, 10), today) > 1 ? 'catch_up' : 'daily';
      const digest: Digest = {
        household_id: hh.id,
        household_name: hh.name,
        timezone: hh.timezone,
        local_date: today,
        kind,
        items: due.map((r) => {
          const fireAt = String(r.fire_at).slice(0, 10);
          return {
            reminder_id: r.id,
            document_id: r.document_id,
            title: r.title ?? 'Untitled',
            label: reminderLabel(fireAt, today, 'due', null),
            note: r.note,
            overdue: fireAt < today,
          };
        }),
      };
      const channels = await deps.notifier.digest(digest);
      for (const r of due) {
        for (const channel of channels.length ? channels : ['none']) {
          await trx
            .insertInto('reminder_delivery')
            .values({ reminder_id: r.id, household_id: hh.id, fire_date: today, channel })
            .onConflict((oc) => oc.doNothing())
            .execute();
        }
      }
      await trx
        .insertInto('notification_digest')
        .values({
          household_id: hh.id,
          local_date: today,
          kind: 'daily',
          item_count: due.length,
          channels,
        })
        .execute();
      return true;
    });
    if (sent) digests++;
  }
  return { digests };
}

/**
 * REM-06: the Sunday-evening summary. Everything due or coming up in the
 * next month, in one message, for the people who asked for email. It is
 * not tied to the delivery ledger — it is a summary, not a first warning,
 * so it repeats each week while something is still outstanding.
 */
export async function weekly(deps: ReminderDeps): Promise<{ digests: number }> {
  const now = deps.now?.() ?? new Date();
  const hour = deps.weeklyHour ?? 18;
  let digests = 0;
  for (const hh of await households(deps.admin)) {
    // Sunday evening or later that Sunday, for the same reason as the
    // daily digest: a restart at eight should not cost the household its
    // weekly summary.
    if (localHour(hh.timezone, now) < hour) continue;
    const today = localToday(hh.timezone, now);
    // Sunday on the household's own calendar.
    const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
    if (weekday !== 0) continue;
    const sent = await withHousehold(deps.app, hh.id, async (trx) => {
      const already = await trx
        .selectFrom('notification_digest')
        .select('local_date')
        .where('local_date', '=', today)
        .where('kind', '=', 'weekly')
        .executeTakeFirst();
      if (already) return false;
      const horizon = addDays(today, 30);
      const rows = await trx
        .selectFrom('reminder')
        .innerJoin('document', 'document.id', 'reminder.document_id')
        .select([
          'reminder.id',
          'reminder.document_id',
          'reminder.fire_at',
          'reminder.note',
          'document.title',
        ])
        .where('document.deleted_at', 'is', null)
        .where('reminder.status', 'in', ['due', 'scheduled'])
        .where('reminder.fire_at', '<=', horizon)
        .orderBy('reminder.fire_at')
        .execute();
      if (rows.length === 0) return false;
      const digest: Digest = {
        household_id: hh.id,
        household_name: hh.name,
        timezone: hh.timezone,
        local_date: today,
        kind: 'weekly',
        items: rows.map((r) => {
          const fireAt = String(r.fire_at).slice(0, 10);
          return {
            reminder_id: r.id,
            document_id: r.document_id,
            title: r.title ?? 'Untitled',
            label: reminderLabel(fireAt, today, 'due', null),
            note: r.note,
            overdue: fireAt < today,
          };
        }),
      };
      const channels = await deps.notifier.digest(digest);
      await trx
        .insertInto('notification_digest')
        .values({
          household_id: hh.id,
          local_date: today,
          kind: 'weekly',
          item_count: rows.length,
          channels,
        })
        .execute();
      return true;
    });
    if (sent) digests++;
  }
  return { digests };
}

/** Nightly: status_cache for every live document, per household. */
export async function refreshStatus(
  deps: Pick<ReminderDeps, 'admin' | 'app' | 'now'>,
): Promise<{ documents: number }> {
  const now = deps.now?.() ?? new Date();
  let n = 0;
  for (const hh of await households(deps.admin)) {
    const today = localToday(hh.timezone, now);
    n += await withHousehold(deps.app, hh.id, async (trx) => {
      const docs = await trx
        .selectFrom('document')
        .leftJoin('document_type', 'document_type.key', 'document.type_key')
        .select([
          'document.id',
          'document.owner_member_id',
          'document.expires_on',
          'document.expires_precision',
          'document_type.key as type_key',
          'document_type.expiry_driver',
          'document_type.reminder_leads',
        ])
        .where('document.deleted_at', 'is', null)
        .execute();
      for (const d of docs) {
        const expires = d.expires_on
          ? {
              date: String(d.expires_on).slice(0, 10),
              precision: d.expires_precision ?? 'day',
            }
          : null;
        const status = deriveStatus(
          {
            type: d.type_key
              ? {
                  key: d.type_key,
                  expiry_driver: d.expiry_driver,
                  reminder_leads: d.reminder_leads ?? [],
                }
              : null,
            owner_member_id: d.owner_member_id,
            expires,
          },
          today,
        );
        await trx
          .updateTable('document')
          .set({ status_cache: status.value })
          .where('id', '=', d.id)
          .where(sql<boolean>`status_cache is distinct from ${status.value}`)
          .execute();
      }
      return docs.length;
    });
  }
  return { documents: n };
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
