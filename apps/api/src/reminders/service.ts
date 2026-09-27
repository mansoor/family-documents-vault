import {
  appendAudit,
  regenerateDerived,
  reminderWords,
  withPrincipal,
  type Db,
  type RegenerateOptions,
} from '@fdv/db';
import {
  aboutDate,
  addDays,
  addMonths,
  localToday,
  nextOccurrence,
  parseRecurrence,
  reminderAbout,
  reminderLabel,
  type ReminderView,
} from '@fdv/shared';
import { sql } from 'kysely';
import type { Principal, RequestMeta } from '../auth/service.js';
import { ApiError } from '../errors.js';
import { allows, requireCapability } from '../authz.js';

/**
 * The reminder engine (design, Status and reminders).
 *
 * - Derived reminders come from the type template and are regenerated
 *   whenever a document's expiry date or type changes; manual reminders
 *   are never touched by that.
 * - Uploading a new version resolves a document's open reminders (REM-08).
 * - Snooze is honest: one week, one month, or until the date a reminder is
 *   about — and never past a due date that is still ahead (0.5.15).
 * - Acknowledging a recurring reminder schedules its next instance.
 * - A derived reminder says which date it is about (`source`), in the
 *   kind's words (`about`: "Due date: 10 Oct, in 7 days", 0.5.15).
 */

export interface ManualReminderInput {
  document_id: string;
  fire_at: string;
  note?: string | null | undefined;
  recurrence?: string | null | undefined;
}

type Row = {
  id: string;
  document_id: string;
  kind: 'derived' | 'manual';
  fire_at: string;
  lead_days: number | null;
  source: string | null;
  note: string | null;
  recurrence: string | null;
  status: ReminderView['status'];
  snoozed_until: string | null;
};

const iso = (d: string | null): string | null => (d === null ? null : d.slice(0, 10));

export class ReminderService {
  constructor(private readonly db: Db) {}

  private async today(trx: Db, householdId: string): Promise<string> {
    const hh = await trx
      .selectFrom('household')
      .select('timezone')
      .where('id', '=', householdId)
      .executeTakeFirstOrThrow();
    return localToday(hh.timezone);
  }

  /**
   * Recomputes the derived reminders for a document from its type and the
   * date its type reminds from: its expiry, or a date detail (0.5.15).
   * Runs inside the caller's transaction (document create/update). The
   * nearest lead whose day is already past is created as `due`, so a
   * passport added with two months left shows up in the needs-attention
   * strip straight away rather than being silently skipped. The worker's
   * types.regenerate makes them the same way (@fdv/db, 0.5.10).
   *
   * An Only me document's details are sealed: its owner's write passes
   * them as it holds them open (`details`), and one that does not, where
   * the date is sealed, fails (SealedDateNeeded).
   */
  async regenerateDerived(
    trx: Db,
    householdId: string,
    documentId: string,
    opts: RegenerateOptions = {},
  ): Promise<void> {
    await regenerateDerived(trx, householdId, documentId, opts);
  }

  /** REM-08: a renewed document resolves its open reminders. */
  async resolveOpen(
    trx: Db,
    householdId: string,
    documentId: string,
    accountId: string | null,
  ): Promise<number> {
    const r = await trx
      .updateTable('reminder')
      .set({ status: 'resolved', acknowledged_by: accountId, acknowledged_at: new Date() })
      .where('document_id', '=', documentId)
      .where('status', 'in', ['scheduled', 'due', 'snoozed'])
      .executeTakeFirst();
    void householdId;
    return Number(r.numUpdatedRows);
  }

  async list(p: Principal, state: 'due' | 'upcoming' | 'all'): Promise<ReminderView[]> {
    return withPrincipal(this.db, p, async (trx) => {
      const today = await this.today(trx, p.householdId);
      let q = trx
        .selectFrom('reminder')
        .innerJoin('document', 'document.id', 'reminder.document_id')
        .select([
          'reminder.id',
          'reminder.document_id',
          'reminder.kind',
          'reminder.fire_at',
          'reminder.lead_days',
          'reminder.source',
          'reminder.note',
          'reminder.recurrence',
          'reminder.status',
          'reminder.snoozed_until',
          'document.title',
          'document.type_key',
        ])
        .where('document.deleted_at', 'is', null)
        .where(visibleTo(p))
        .orderBy('reminder.fire_at');
      if (state === 'due') q = q.where('reminder.status', '=', 'due');
      else if (state === 'upcoming')
        q = q
          .where('reminder.status', 'in', ['scheduled', 'snoozed'])
          .where('reminder.fire_at', '<=', addDays(today, 90));
      else q = q.where('reminder.status', 'in', ['scheduled', 'due', 'snoozed']);
      const rows = await q.execute();
      const words = await reminderWords(trx, rows);
      return rows.map((r) =>
        view({ ...r, status: r.status }, r.title, today, words.get(r.id) ?? null),
      );
    });
  }

  async createManual(
    p: Principal,
    input: ManualReminderInput,
    meta: RequestMeta,
  ): Promise<ReminderView> {
    requireCapability(p, 'reminder.manage');
    if (input.recurrence && !parseRecurrence(input.recurrence)) {
      throw new ApiError(
        422,
        'validation_failed',
        'Repeat can be monthly, quarterly, annual, or every:Nm.',
      );
    }
    return withPrincipal(this.db, p, async (trx) => {
      const doc = await trx
        .selectFrom('document')
        .select(['id', 'title'])
        .where('id', '=', input.document_id)
        .where(visibleTo(p))
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!doc) throw new ApiError(404, 'not_found', 'That document is not in the vault.');
      const today = await this.today(trx, p.householdId);
      const row = await trx
        .insertInto('reminder')
        .values({
          household_id: p.householdId,
          document_id: doc.id,
          kind: 'manual',
          fire_at: input.fire_at,
          note: input.note ?? null,
          recurrence: input.recurrence ?? null,
          status: input.fire_at <= today ? 'due' : 'scheduled',
          created_by: p.accountId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'reminder.created',
        objectType: 'reminder',
        objectId: row.id,
        detail: { document_id: doc.id, fire_at: input.fire_at },
        ip: meta.ip,
      });
      return view(row, doc.title, today, null);
    });
  }

  /**
   * Later: a day, or `'expiry'` — the date a derived reminder is about
   * (0.5.15), its expiry or its due date; a manual one waits for its
   * document's expiry, as before. A reminder about a date field never
   * waits past that date while it is ahead: a later day is cut back to it,
   * so an older phone's "A month" on a bill due in 9 days waits 9 days.
   */
  async snooze(p: Principal, id: string, until: string, meta: RequestMeta): Promise<ReminderView> {
    return this.transition(p, id, meta, async (trx, r, today) => {
      const about = aboutDate({ ...r, fire_at: iso(r.fire_at) as string });
      let date = until;
      if (until === 'expiry' && about) {
        date = about;
      } else if (until === 'expiry') {
        const doc = await trx
          .selectFrom('document')
          .select('expires_on')
          .where('id', '=', r.document_id)
          .executeTakeFirstOrThrow();
        if (!doc.expires_on)
          throw new ApiError(
            422,
            'validation_failed',
            'This document has no expiry date to wait for.',
          );
        date = iso(doc.expires_on) as string;
      } else if (about && r.source !== 'expires' && about > today && date > about) {
        date = about;
      }
      if (date <= today) throw new ApiError(422, 'validation_failed', 'Pick a day after today.');
      return { status: 'snoozed', snoozed_until: date, action: 'reminder.snoozed' };
    });
  }

  /**
   * Done. A recurring reminder schedules its next instance immediately;
   * a one-off is finished. There is no permanent dismiss that hides an
   * expired passport: the document's status still says so.
   */
  async acknowledge(p: Principal, id: string, meta: RequestMeta): Promise<ReminderView> {
    return this.transition(p, id, meta, async (_trx, r, today) => {
      if (r.recurrence) {
        const next =
          nextOccurrence(iso(r.fire_at) as string, r.recurrence, today) ?? addMonths(today, 1);
        return {
          status: 'scheduled',
          fire_at: next,
          snoozed_until: null,
          action: 'reminder.acknowledged',
        };
      }
      return {
        status: 'acknowledged',
        acknowledged_by: p.accountId,
        acknowledged_at: new Date(),
        action: 'reminder.acknowledged',
      };
    });
  }

  async remove(p: Principal, id: string, meta: RequestMeta): Promise<void> {
    requireCapability(p, 'reminder.manage');
    await withPrincipal(this.db, p, async (trx) => {
      // Only on a document the caller can see: a reminder on somebody
      // else's private document is not there, not "not yours".
      const r = await trx
        .deleteFrom('reminder')
        .where('id', '=', id)
        .where('kind', '=', 'manual')
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom('document')
              .select('document.id')
              .whereRef('document.id', '=', 'reminder.document_id')
              .where(visibleTo(p)),
          ),
        )
        .executeTakeFirst();
      if (Number(r.numDeletedRows) === 0)
        throw new ApiError(404, 'not_found', 'Only reminders you set yourself can be removed.');
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'reminder.removed',
        objectType: 'reminder',
        objectId: id,
        ip: meta.ip,
      });
    });
  }

  private async transition(
    p: Principal,
    id: string,
    meta: RequestMeta,
    decide: (
      trx: Db,
      r: Row,
      today: string,
    ) => Promise<Record<string, unknown> & { action: string }>,
  ): Promise<ReminderView> {
    requireCapability(p, 'reminder.manage');
    return withPrincipal(this.db, p, async (trx) => {
      const r = await trx
        .selectFrom('reminder')
        .innerJoin('document', 'document.id', 'reminder.document_id')
        .selectAll('reminder')
        .select(['document.title', 'document.type_key'])
        .where('reminder.id', '=', id)
        .where(visibleTo(p))
        .executeTakeFirst();
      if (!r) throw new ApiError(404, 'not_found', 'That reminder does not exist.');
      const today = await this.today(trx, p.householdId);
      const { action, ...set } = await decide(trx, r, today);
      const updated = await trx
        .updateTable('reminder')
        .set(set as never)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action,
        objectType: 'reminder',
        objectId: id,
        ip: meta.ip,
      });
      const words = await reminderWords(trx, [r]);
      return view(updated, r.title, today, words.get(r.id) ?? null);
    });
  }
}

function visibleTo(p: Principal) {
  return sql<boolean>`(document.visibility = 'household'
    or (document.visibility = 'adults' and ${allows(p, 'document.see_adults')})
    or (document.visibility = 'private' and document.owner_member_id = ${p.memberId}::uuid))`;
}

/** A reminder as the API answers it; `word` is its kind's for the date it is about. */
function view(r: Row, title: string | null, today: string, word: string | null): ReminderView {
  const fireAt = iso(r.fire_at) as string;
  const snoozed = iso(r.snoozed_until);
  const about = aboutDate({ ...r, fire_at: fireAt });
  return {
    id: r.id,
    document_id: r.document_id,
    document_title: title,
    kind: r.kind,
    fire_at: fireAt,
    lead_days: r.lead_days,
    note: r.note,
    recurrence: r.recurrence,
    status: r.status,
    snoozed_until: snoozed,
    label: reminderLabel(fireAt, today, r.status, snoozed),
    source: r.source,
    about: about && word ? reminderAbout(word, about, today) : null,
  };
}
