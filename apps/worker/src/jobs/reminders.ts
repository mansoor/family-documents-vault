import { withHousehold, type Db } from '@fdv/db';
import { addDays, canSee, deriveStatus, localHour, localToday, reminderLabel } from '@fdv/shared';
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
 * delivery row and send ONE notification per person (REM-05). Nothing
 * fires individually, and a server that was off for nine days produces
 * exactly one summary on restart, because the digest covers every
 * undelivered reminder, however old (REM-13).
 *
 * "Per person" is the privacy wall, not a nicety. Each copy is cut to the
 * documents that person may see, by the same rule the API applies to every
 * list (`canSee` in `@fdv/shared`). Until 0.4.2 the household got one copy
 * with every title in it, which put private and adults-only titles on
 * other people's lock screens and in their inboxes.
 *
 * `refreshStatus` (nightly): materialises status_cache for fast list
 * filtering. Never authoritative — status is computed on read.
 */

export interface DigestItem {
  reminder_id: string;
  document_id: string;
  title: string;
  label: string;
  note: string | null;
  overdue: boolean;
  /**
   * An "Only me" document. Its title may go by push, which is encrypted to
   * the person's own device, but never by email: the household's mail
   * server is one an owner can point at themselves.
   */
  private: boolean;
}

export interface Digest {
  household_id: string;
  household_name: string;
  timezone: string;
  local_date: string;
  kind: 'daily' | 'catch_up' | 'weekly';
  /**
   * Who this copy is for. A digest is always one person's, already cut to
   * what they may see: a title never reaches somebody the document is
   * hidden from — not a teen, not a viewer, not the other adult.
   */
  recipient: { account_id: string; email: string };
  items: DigestItem[];
}

/** The seam 2.3 fills with email and push. */
export interface Notifier {
  /** Sends one person their digest. Returns the channels that reached them. */
  digest(d: Digest): Promise<string[]>;
}

export const logNotifier = (
  log: (level: string, msg: string, extra?: Record<string, unknown>) => void,
): Notifier => ({
  async digest(d) {
    // Counts, not titles. The log is read by whoever runs the server, and
    // the titles are the part that belongs to the family.
    log('info', 'reminder digest', {
      household: d.household_name,
      kind: d.kind,
      count: d.items.length,
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

/** A reminder about to be sent, with what decides who may hear of it. */
interface Due extends Omit<DigestItem, 'private'> {
  fire_at: string;
  visibility: string;
  owner_member_id: string | null;
}

/** Everyone in the household whose sign-in still works. */
function people(trx: Db) {
  return trx
    .selectFrom('account_household')
    .innerJoin('account', 'account.id', 'account_household.account_id')
    .select([
      'account_household.account_id',
      'account_household.member_id',
      'account_household.role',
      'account.email',
    ])
    .where('account.disabled_at', 'is', null)
    .orderBy('account_household.joined_at')
    .execute();
}

/**
 * Sends each person the part of `due` they may see, and nobody anything
 * when they may see none of it. Returns, for each reminder, the channels
 * that carried it to at least one person — which is what the ledger
 * records, so a reminder only one person could read is not marked as
 * reaching the family.
 */
async function sendToEach(
  trx: Db,
  notifier: Notifier,
  base: Omit<Digest, 'recipient' | 'items' | 'kind'>,
  due: Due[],
  kindOf: (mine: Due[]) => Digest['kind'],
): Promise<Map<string, Set<string>>> {
  const reached = new Map<string, Set<string>>();
  for (const person of await people(trx)) {
    const viewer = { role: person.role, memberId: person.member_id };
    const mine = due.filter((r) => canSee(viewer, r));
    if (mine.length === 0) continue;
    const channels = await notifier.digest({
      ...base,
      kind: kindOf(mine),
      recipient: { account_id: person.account_id, email: person.email },
      items: mine.map((r) => ({
        reminder_id: r.reminder_id,
        document_id: r.document_id,
        title: r.title,
        label: r.label,
        note: r.note,
        overdue: r.overdue,
        private: r.visibility === 'private',
      })),
    });
    for (const r of mine) {
      const set = reached.get(r.reminder_id) ?? new Set<string>();
      for (const c of channels) set.add(c);
      reached.set(r.reminder_id, set);
    }
  }
  return reached;
}

const union = (reached: Map<string, Set<string>>) =>
  [...new Set([...reached.values()].flatMap((s) => [...s]))].sort();

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
          'document.visibility',
          'document.owner_member_id',
        ])
        .where('reminder.status', '=', 'due')
        .where('document.deleted_at', 'is', null)
        .where('reminder_delivery.reminder_id', 'is', null)
        .orderBy('reminder.fire_at')
        .execute();
      if (due.length === 0) return false;

      const items: Due[] = due.map((r) => {
        const fireAt = String(r.fire_at).slice(0, 10);
        return {
          reminder_id: r.id,
          document_id: r.document_id,
          title: r.title ?? 'Untitled',
          label: reminderLabel(fireAt, today, 'due', null),
          note: r.note,
          overdue: fireAt < today,
          fire_at: fireAt,
          visibility: r.visibility,
          owner_member_id: r.owner_member_id,
        };
      });
      const reached = await sendToEach(
        trx,
        deps.notifier,
        { household_id: hh.id, household_name: hh.name, timezone: hh.timezone, local_date: today },
        items,
        // Whether this person's copy is a catch-up depends on what is in
        // *their* copy, not on the oldest thing in the household.
        (mine) => {
          const oldest = mine.reduce((m, r) => (r.fire_at < m ? r.fire_at : m), today);
          return daysBetween(oldest, today) > 1 ? 'catch_up' : 'daily';
        },
      );
      for (const r of due) {
        const channels = [...(reached.get(r.id) ?? [])];
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
          channels: union(reached),
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
          'document.visibility',
          'document.owner_member_id',
        ])
        .where('document.deleted_at', 'is', null)
        .where('reminder.status', 'in', ['due', 'scheduled'])
        .where('reminder.fire_at', '<=', horizon)
        .orderBy('reminder.fire_at')
        .execute();
      if (rows.length === 0) return false;
      const items: Due[] = rows.map((r) => {
        const fireAt = String(r.fire_at).slice(0, 10);
        return {
          reminder_id: r.id,
          document_id: r.document_id,
          title: r.title ?? 'Untitled',
          label: reminderLabel(fireAt, today, 'due', null),
          note: r.note,
          overdue: fireAt < today,
          fire_at: fireAt,
          visibility: r.visibility,
          owner_member_id: r.owner_member_id,
        };
      });
      const reached = await sendToEach(
        trx,
        deps.notifier,
        { household_id: hh.id, household_name: hh.name, timezone: hh.timezone, local_date: today },
        items,
        () => 'weekly',
      );
      await trx
        .insertInto('notification_digest')
        .values({
          household_id: hh.id,
          local_date: today,
          kind: 'weekly',
          item_count: rows.length,
          channels: union(reached),
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
