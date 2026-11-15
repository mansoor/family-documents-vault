import { addDays, birthdayAt, GROWN_UP_AGE, localToday } from '@fdv/shared';
import { sql, type RawBuilder } from 'kysely';
import type { Db } from './client.js';

/**
 * Turning 18 with medical papers (0098, 0.9.0, H1b of the health plan; the
 * owner's decisions of 14 Nov 2026).
 *
 * As somebody turns 18 on the household's calendar, with Medical papers
 * about them that the family can see, they are asked once: keep them
 * visible to the family, or make them Only me. Nothing changes until they
 * answer. Somebody who signs in as an owner or an adult is asked
 * themselves; for anybody else (no sign-in, or one still a teen's) the
 * owners are reminded — to ask them in person, or to make their role an
 * adult's first — a reminder about a person, as turning 13 is (`turned_18`,
 * beside 0066's `turned_13`).
 *
 * The first time the job runs for a household (`household.grown_ups_asked_at`
 * still null), everybody already 18 or over with such papers is asked too:
 * a one-off catch-up, never repeated, and never a second question for
 * anybody.
 */

/**
 * How many days late the question is still asked: a vault that was off on
 * somebody's 18th birthday asks when it is back, within the week, as
 * turning 13 is told (`TURNED_13_CATCH_UP_DAYS`).
 */
export const GROWN_UP_CATCH_UP_DAYS = 7;

/**
 * "A Medical paper about this person that the family can see", as SQL on a
 * row called `d` and a person's id: theirs, Everyone's or Adults only, its
 * own category Medical (as `caregiver_reads` asks it), never a note — in
 * the Trash too, where the family can still see it and bring it back.
 * The question is asked about these, and Only me makes each of them so.
 */
export const familyMedicalOf = (member: RawBuilder<string>) => sql<boolean>`(
  d.owner_member_id = ${member}
  and d.visibility in ('household', 'adults')
  and d.type_key is distinct from 'note'
  and d.category = 'medical')`;

/** Whether this person has any such paper, as SQL. */
export const familySeesMedicalOf = (member: RawBuilder<string>) => sql<boolean>`exists (
  select 1 from document d where ${familyMedicalOf(member)})`;

/**
 * The questions as the vault asks them, in the worker's reminders.tick, as
 * the vault itself: one for each person of the family, alive, with Medical
 * papers the family can see, whose 18th birthday on the household's
 * calendar is today — or within the week, for a vault that was off — and
 * who was already in the vault before it; and, the first time for the
 * household, everybody already 18 or over. Never a second for anybody,
 * whatever they answered. For somebody who does not sign in as a grown-up,
 * the owners' reminder too. A reminder whose question is answered, or whose
 * person now answers for themselves, is done with: resolved. How many asked.
 */
export async function askGrownUps(
  trx: Db,
  householdId: string,
  timezone: string,
  now: Date,
): Promise<number> {
  const today = localToday(timezone, now);
  await trx
    .updateTable('reminder')
    .set({ status: 'resolved', acknowledged_at: now })
    .where('kind', '=', 'turned_18')
    .where('status', 'in', ['scheduled', 'due', 'snoozed'])
    .where(
      sql<boolean>`(exists (select 1 from grown_up_question q
                             where q.member_id = reminder.member_id
                               and q.answered_at is not null)
                    or member_signs_in_grown_up(reminder.member_id)
                    or not exists (select 1 from member m
                                    where m.id = reminder.member_id and not m.is_deceased))`,
    )
    .execute();
  // The one-off catch-up, claimed by this look alone: two looks at once ask
  // once, the second finding it claimed.
  const claimed = await trx
    .updateTable('household')
    .set({ grown_ups_asked_at: now })
    .where('id', '=', householdId)
    .where('grown_ups_asked_at', 'is', null)
    .returning('id')
    .executeTakeFirst();
  const catchUp = claimed !== undefined;
  const people = await trx
    .selectFrom('member')
    .select(['member.id', 'member.date_of_birth', 'member.created_at'])
    .where('member.kind', '=', 'family')
    .where('member.is_deceased', '=', false)
    .where('member.date_of_birth', 'is not', null)
    .where(
      sql<boolean>`not exists (select 1 from grown_up_question q where q.member_id = member.id)`,
    )
    .where(familySeesMedicalOf(sql`member.id`))
    .execute();
  let asked = 0;
  for (const m of people) {
    const day = birthdayAt(String(m.date_of_birth).slice(0, 10), GROWN_UP_AGE);
    if (!day || day > today) continue;
    const recent = day > addDays(today, -GROWN_UP_CATCH_UP_DAYS);
    if (!catchUp) {
      if (!recent) continue;
      // Added on the day or after it: added as a grown-up, by whoever chose
      // then who sees their papers.
      if (localToday(timezone, m.created_at) >= day) continue;
    }
    const q = await trx
      .insertInto('grown_up_question')
      .values({ household_id: householdId, member_id: m.id, turned_on: day })
      .onConflict((oc) => oc.doNothing())
      .returning('member_id')
      .executeTakeFirst();
    if (!q) continue;
    asked++;
    const self = await sql<{ self: boolean }>`
      select member_signs_in_grown_up(${m.id}::uuid) as self`.execute(trx);
    if (self.rows[0]?.self === true) continue;
    await trx
      .insertInto('reminder')
      .values({
        household_id: householdId,
        member_id: m.id,
        document_id: null,
        kind: 'turned_18',
        // Long past, for the catch-up: due today, so the owners' digest is
        // the day's own, not one catching up on years.
        fire_at: recent ? day : today,
        status: 'due',
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
  return asked;
}
