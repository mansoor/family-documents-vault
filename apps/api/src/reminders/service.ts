import {
  appendAudit,
  mayYetSignUp,
  regenerateDerived,
  stillTurned13,
  reminderWords,
  withPrincipal,
  type Db,
  type RegenerateOptions,
  householdZone,
} from '@fdv/db';
import {
  aboutDate,
  addDays,
  addMonths,
  localToday,
  nextOccurrence,
  nextReview,
  parseRecurrence,
  reminderAbout,
  reminderLabel,
  REVIEW_NOTE,
  turnedThirteenWords,
  yearlyReviewOffered,
  type PersonReminderView,
  type ReminderView,
} from '@fdv/shared';
import { sql } from 'kysely';
import type { Principal, RequestMeta } from '../auth/service.js';
import { ApiError } from '../errors.js';
import { requireCapability } from '../authz.js';

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
 * - A yearly review (0.9.0, H3, `review`) is somebody's own reminder on an
 *   advance directive, a healthcare proxy or a HIPAA authorization,
 *   repeating every year: one open a document, Done bringing the next a
 *   year on (`nextReview`) even when it is done early, and a new version
 *   of the paper leaving it be. Removing it turns it off.
 */

export interface ManualReminderInput {
  document_id: string;
  fire_at: string;
  note?: string | null | undefined;
  recurrence?: string | null | undefined;
  /** A yearly review (H3): its note and its repeat are the vault's. */
  review?: boolean | undefined;
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
  review: boolean;
  recur_from?: string | null;
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
    return localToday(householdZone(hh.timezone));
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

  /**
   * REM-08: a renewed document resolves its open reminders — but its
   * yearly review (H3), which is about the paper, not this copy of it.
   */
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
      .where('review', '=', false)
      .executeTakeFirst();
    void householdId;
    return Number(r.numUpdatedRows);
  }

  /**
   * The caller's reminders, of documents they can see; with `documentId`,
   * that document's alone (H3: its page asks whether its yearly review is
   * on) — none, for one they cannot see.
   */
  async list(
    p: Principal,
    state: 'due' | 'upcoming' | 'all',
    documentId?: string,
  ): Promise<ReminderView[]> {
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
          'reminder.review',
          'reminder.status',
          'reminder.snoozed_until',
          'document.title',
          'document.type_key',
        ])
        .where('document.deleted_at', 'is', null)
        // No longer needed (0082): reminded of nothing, whatever a row says.
        .where('document.no_longer_needed_at', 'is', null)
        .where(visibleTo(p))
        .orderBy('reminder.fire_at');
      if (documentId !== undefined) q = q.where('reminder.document_id', '=', documentId);
      if (state === 'due') q = q.where('reminder.status', '=', 'due');
      else if (state === 'upcoming')
        q = q
          .where('reminder.status', 'in', ['scheduled', 'snoozed'])
          .where('reminder.fire_at', '<=', addDays(today, 90));
      else q = q.where('reminder.status', 'in', ['scheduled', 'due', 'snoozed']);
      const rows = await q.execute();
      const words = await reminderWords(trx, rows);
      return rows.map((r) =>
        view(ofDocument({ ...r, status: r.status }), r.title, today, words.get(r.id) ?? null),
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
    const review = input.review === true;
    if (review && input.recurrence && input.recurrence !== 'annual') {
      throw new ApiError(422, 'validation_failed', 'A yearly review repeats every year.', {
        detail: 'recurrence',
      });
    }
    return withPrincipal(this.db, p, async (trx) => {
      const doc = await trx
        .selectFrom('document')
        .select(['id', 'title', 'type_key', 'no_longer_needed_at'])
        .where('id', '=', input.document_id)
        .where(visibleTo(p))
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!doc) throw new ApiError(404, 'not_found', 'That document is not in the vault.');
      // No longer needed (0082): nothing reminds of it until it is needed again.
      if (doc.no_longer_needed_at) throw noLongerNeeded();
      const today = await this.today(trx, p.householdId);
      if (review) {
        // Only on a paper worth reading again every year (H3).
        if (!yearlyReviewOffered({ key: doc.type_key })) {
          throw new ApiError(
            422,
            'validation_failed',
            'A yearly review is for an advance directive, a healthcare proxy or a HIPAA authorization.',
            { detail: 'review' },
          );
        }
      }
      // Turned on twice is on: the one there is (one open a document,
      // reminder_one_review — two at once, the second waits for the first).
      const theOpenReview = () =>
        trx
          .selectFrom('reminder')
          .selectAll()
          .where('document_id', '=', doc.id)
          .where('review', '=', true)
          .where('status', 'in', ['scheduled', 'due', 'snoozed'])
          .executeTakeFirst();
      // A review's first day is never one gone by (H3): today at the earliest.
      const fireAt = review && input.fire_at < today ? today : input.fire_at;
      const insert = () =>
        trx
          .insertInto('reminder')
          .values({
            household_id: p.householdId,
            document_id: doc.id,
            kind: 'manual',
            fire_at: fireAt,
            note: review ? REVIEW_NOTE : (input.note ?? null),
            recurrence: review ? 'annual' : (input.recurrence ?? null),
            review,
            status: fireAt <= today ? 'due' : 'scheduled',
            created_by: p.accountId,
          })
          .onConflict((oc) =>
            oc
              .column('document_id')
              .where(sql<boolean>`review and status in ('scheduled', 'due', 'snoozed')`)
              .doNothing(),
          )
          .returningAll()
          .executeTakeFirst();
      let row: Awaited<ReturnType<typeof insert>>;
      // An open one there: that one. One there as this was made, and gone
      // again before it could be read (turned off at that moment): made
      // once more, once.
      for (let tries = 0; ; tries++) {
        if (review) {
          const on = await theOpenReview();
          if (on) return view(ofDocument(on), doc.title, today, null);
        }
        row = await insert();
        if (row || tries === 1) break;
      }
      if (!row) {
        throw new ApiError(409, 'conflict', 'The yearly review changed as it was set. Try again.', {
          retriable: true,
        });
      }
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'reminder.created',
        objectType: 'reminder',
        objectId: row.id,
        detail: { document_id: doc.id, fire_at: fireAt, ...(review ? { review } : {}) },
        ip: meta.ip,
      });
      return view(ofDocument(row), doc.title, today, null);
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
    return this.transition(p, id, meta, 'snooze', async (trx, r, today) => {
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
   * expired passport: the document's status still says so. A yearly
   * review (H3) comes back a year on, done early or late (`nextReview`).
   */
  async acknowledge(p: Principal, id: string, meta: RequestMeta): Promise<ReminderView> {
    return this.transition(p, id, meta, 'done', async (_trx, r, today) => {
      if (r.recurrence) {
        // Counted from the day it was first set for, so it never drifts (H3).
        const anchor = iso(r.recur_from ?? null) ?? r.fire_at.slice(0, 10);
        const next = r.review
          ? nextReview(iso(r.fire_at) as string, today, anchor)
          : (nextOccurrence(anchor, r.recurrence, today) ?? addMonths(today, 1));
        return {
          status: 'scheduled',
          fire_at: next,
          recur_from: anchor,
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

  /**
   * A reminder set by hand, removed: by whoever may manage reminders and
   * sees its document. A yearly review (H3) is turned off by whoever turned
   * it on, or an owner.
   */
  async remove(p: Principal, id: string, meta: RequestMeta): Promise<void> {
    requireCapability(p, 'reminder.manage');
    await withPrincipal(this.db, p, async (trx) => {
      // Only on a document the caller can see: a reminder on somebody
      // else's private document is not there, not "not yours".
      const mine = await trx
        .selectFrom('reminder')
        .select(['id', 'review', 'created_by'])
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
      if (!mine)
        throw new ApiError(
          404,
          'not_found',
          'Only a reminder somebody set by hand can be removed, never one made from a date.',
        );
      if (mine.review && mine.created_by !== p.accountId && p.role !== 'owner') {
        throw new ApiError(
          403,
          'forbidden',
          'Only whoever turned the yearly review on, or an owner, can turn it off.',
        );
      }
      await trx.deleteFrom('reminder').where('id', '=', id).execute();
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

  // ------------------------------------------- about a person (0066)

  /**
   * GET /reminders/people: the owners' reminders that somebody has turned
   * 13 and may now have a sign-in of their own — due, not dismissed, and
   * only while they may still sign up (no sign-in, none taken away, no
   * invitation waiting, alive). An owner's alone: anybody else is refused,
   * and the database gives them none.
   */
  async listPeople(p: Principal): Promise<PersonReminderView[]> {
    mustBeOwner(p);
    return withPrincipal(this.db, p, async (trx) => {
      const today = await this.today(trx, p.householdId);
      const rows = await trx
        .selectFrom('reminder')
        .innerJoin('member', 'member.id', 'reminder.member_id')
        .select([
          'reminder.id',
          'reminder.member_id',
          'reminder.fire_at',
          'member.display_name',
          'member.date_of_birth',
        ])
        .where('reminder.kind', '=', 'turned_13')
        .where('reminder.status', '=', 'due')
        .where(mayYetSignUp(new Date()))
        .orderBy('reminder.fire_at')
        .orderBy('reminder.id')
        .execute();
      // Still about their 13th birthday: a date of birth corrected since is
      // not (the review, INV-3).
      return rows.filter(stillTurned13).map((r) => {
        const fireAt = iso(r.fire_at) as string;
        return {
          id: r.id,
          kind: 'turned_13' as const,
          member_id: r.member_id as string,
          display_name: r.display_name,
          fire_at: fireAt,
          ...turnedThirteenWords(r.display_name, fireAt, today),
        };
      });
    });
  }

  /**
   * POST /reminders/people/{id}/dismiss: an owner is done with a reminder
   * that somebody has turned 13. It is not made again; inviting them is
   * still on their page. 404 for one that is not there, or not an owner's
   * to see.
   */
  async dismissPerson(p: Principal, id: string, meta: RequestMeta): Promise<void> {
    mustBeOwner(p);
    const gone = () => new ApiError(404, 'not_found', 'That reminder does not exist.');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw gone();
    await withPrincipal(this.db, p, async (trx) => {
      const r = await trx
        .updateTable('reminder')
        .set({ status: 'acknowledged', acknowledged_by: p.accountId, acknowledged_at: new Date() })
        .where('id', '=', id)
        .where('kind', '=', 'turned_13')
        .where('status', 'in', ['scheduled', 'due', 'snoozed'])
        .returning('id')
        .executeTakeFirst();
      if (!r) throw gone();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'reminder.acknowledged',
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
    /** What is asked: Done answers a reminder of a document no longer needed as it is. */
    asked: 'snooze' | 'done',
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
        .select(['document.title', 'document.type_key', 'document.no_longer_needed_at'])
        .where('reminder.id', '=', id)
        .where(visibleTo(p))
        // Held before the log, as its document's removal holds it: one taken
        // back into a batch's queue meanwhile is waited for, and then not
        // there (the I3 check, N2) — never a deadlock, never a 500.
        .forUpdate('reminder')
        .executeTakeFirst();
      if (!r) throw new ApiError(404, 'not_found', 'That reminder does not exist.');
      const today = await this.today(trx, p.householdId);
      // Its document no longer needed (0082): what reminded of it was
      // resolved as it was marked. Done with is answered as it is (an older
      // phone's Done on a line it had kept); anything else would remind.
      if (r.no_longer_needed_at) {
        if (asked !== 'done') throw noLongerNeeded();
        const words = await reminderWords(trx, [r]);
        return view(ofDocument(r), r.title, today, words.get(r.id) ?? null);
      }
      const { action, ...set } = await decide(trx, ofDocument(r), today);
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
      return view(ofDocument(updated), r.title, today, words.get(r.id) ?? null);
    });
  }
}

/**
 * A reminder about a document, as every query of these gives them: each
 * joins its document. Since 0066 a reminder may be about a person (an
 * owner's `turned_13`), which none of them ever meets.
 */
function ofDocument<T extends { document_id: string | null; kind: string }>(
  r: T,
): T & { document_id: string; kind: 'derived' | 'manual' } {
  if (r.document_id === null || (r.kind !== 'derived' && r.kind !== 'manual')) {
    throw new Error('a reminder about a person, where one about a document was asked for');
  }
  return r as T & { document_id: string; kind: 'derived' | 'manual' };
}

/** A document no longer needed (0082) is reminded of nothing: said when a reminder is asked of it. */
const noLongerNeeded = () =>
  new ApiError(
    409,
    'no_longer_needed',
    'This document is no longer needed, so nothing reminds of it. Mark it needed again to be reminded.',
  );

/** A turning-13 reminder is the owners' (0066): said to anybody else as a refusal. */
function mustBeOwner(p: Principal): void {
  if (p.role !== 'owner') {
    throw new ApiError(403, 'forbidden', 'Only an owner is reminded when somebody turns 13.');
  }
}

function visibleTo(p: Principal) {
  return sql<boolean>`(document.visibility = 'household'
    or (document.visibility = 'adults' and ${p.seesAdults})
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
    review: r.review,
    status: r.status,
    snoozed_until: snoozed,
    label: reminderLabel(fireAt, today, r.status, snoozed),
    source: r.source,
    about: about && word ? reminderAbout(word, about, today) : null,
  };
}
