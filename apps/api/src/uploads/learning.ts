import type { Db } from '@fdv/db';
import {
  correctionsOf,
  learningOf,
  LEARNED_RULES_MAX,
  LEARNING_OUTCOMES_KEPT,
  LEARNING_WINDOW,
  ruleSure,
  type BatchLearning,
  type CaptureMetadata,
  type ItemProposals,
} from '@fdv/shared';
import { sql } from 'kysely';
import type { Principal } from '../auth/service.js';

/**
 * The vault learns from your corrections (Phase 6, I4), in the API: what an
 * accept teaches, taken back by an Undo; and each person's count and rules,
 * shown to them and forgotten when they say. The rules themselves, and how
 * the worker uses them, are @fdv/shared's learning.ts.
 *
 * Everything here runs as the person (withPrincipal): the database gives
 * them their own rules and count and nobody else's (0065), and every query
 * also names them, so nothing here could reach another's even as the vault.
 */

/** A rule's column for a field: a kind's key, or a person. */
const columnOf = (field: 'type_key' | 'owner_member_id') =>
  field === 'type_key' ? ('type_key' as const) : ('person_id' as const);

/**
 * What an accept teaches, in its own transaction (the item held, the
 * document filed): for the issuer filed, a rule made or confirmed for the
 * kind and the person filed — made only for a correction — and every other
 * rule of that issuer and field contradicted; a rule contradicted more
 * often than confirmed removed; past LEARNED_RULES_MAX, the least used.
 * And, for an item that was read, whether it needed no change, with what
 * it taught, for the count and for an Undo.
 */
export async function learnFromAccept(
  trx: Db,
  p: Principal,
  x: {
    itemId: string;
    /** Its pages were read: only then is it counted. */
    read: boolean;
    /** What its card started from (levelItem's), at the moment it was accepted. */
    proposals: ItemProposals | null;
    /** What was filed: what was sent, and the batch's defaults for the rest. */
    filed: CaptureMetadata;
  },
): Promise<void> {
  const { issuer, steps } = learningOf({
    proposals: x.proposals,
    filed: x.filed,
    role: p.role,
  });
  const confirmed: string[] = [];
  const contradicted: string[] = [];
  const made: string[] = [];
  const mine = { household_id: p.householdId, member_id: p.memberId };
  for (const step of steps) {
    const col = columnOf(step.field);
    if (step.corrected) {
      // Made, or confirmed if it is there already (another accept at once).
      const conflict = ['household_id', 'member_id', 'issuer_key', col] as const;
      const row = await trx
        .insertInto('intake_rule')
        .values({ ...mine, issuer_key: issuer, [col]: step.value, confirmed: 1 })
        .onConflict((oc) =>
          oc
            .columns([...conflict])
            .where(col, 'is not', null)
            .doUpdateSet({
              confirmed: sql<number>`least(intake_rule.confirmed + 1, 1000000)`,
              last_used: sql<string>`current_date`,
            }),
        )
        .returning(['id', sql<boolean>`xmax = 0`.as('inserted')])
        .executeTakeFirstOrThrow();
      confirmed.push(row.id);
      if (row.inserted) made.push(row.id);
    } else {
      const row = await trx
        .updateTable('intake_rule')
        .set({
          confirmed: sql<number>`least(confirmed + 1, 1000000)`,
          last_used: sql<string>`current_date`,
        })
        .where('household_id', '=', p.householdId)
        .where('member_id', '=', p.memberId)
        .where('issuer_key', '=', issuer)
        .where(col, '=', step.value)
        .returning('id')
        .executeTakeFirst();
      if (row) confirmed.push(row.id);
    }
    // Every other rule of this issuer and field: something else was filed.
    const others = await trx
      .updateTable('intake_rule')
      .set({ contradicted: sql<number>`least(contradicted + 1, 1000000)` })
      .where('household_id', '=', p.householdId)
      .where('member_id', '=', p.memberId)
      .where('issuer_key', '=', issuer)
      .where(col, 'is not', null)
      .where(col, '<>', step.value)
      .returning('id')
      .execute();
    contradicted.push(...others.map((o) => o.id));
  }
  if (issuer) {
    // Contradicted more often than confirmed: dropped.
    await trx
      .deleteFrom('intake_rule')
      .where('household_id', '=', p.householdId)
      .where('member_id', '=', p.memberId)
      .where('issuer_key', '=', issuer)
      .where(sql<boolean>`contradicted > confirmed`)
      .execute();
  }
  if (made.length > 0) await capRules(trx, p, made);
  if (!x.read) return;

  const kind = x.filed.type_key
    ? ((await trx
        .selectFrom('effective_document_type')
        .select(['core', 'expiry_driver'])
        .where('key', '=', x.filed.type_key)
        .where('deleted_at', 'is', null)
        .executeTakeFirst()) ?? null)
    : null;
  const unchanged =
    correctionsOf({
      proposals: x.proposals,
      filed: x.filed,
      kind: kind as {
        core: Record<string, { shown?: boolean }>;
        expiry_driver: string | null;
      } | null,
    }).length === 0;
  await trx
    .insertInto('intake_outcome')
    .values({
      ...mine,
      item_id: x.itemId,
      unchanged,
      confirmed_rules: confirmed,
      contradicted_rules: contradicted.slice(0, 1000),
    })
    .onConflict((oc) =>
      oc.columns(['household_id', 'member_id', 'item_id']).doUpdateSet({
        unchanged,
        accepted_at: sql<Date>`now()`,
        confirmed_rules: confirmed,
        contradicted_rules: contradicted.slice(0, 1000),
      }),
    )
    .execute();
  // Only the newest are kept: the count reads LEARNING_WINDOW of them.
  await sql`
    delete from intake_outcome o
     using (select item_id from intake_outcome
             where household_id = ${p.householdId}::uuid and member_id = ${p.memberId}::uuid
             order by accepted_at desc, item_id
            offset ${LEARNING_OUTCOMES_KEPT}) old
     where o.household_id = ${p.householdId}::uuid and o.member_id = ${p.memberId}::uuid
       and o.item_id = old.item_id`.execute(trx);
}

/**
 * At most LEARNED_RULES_MAX rules a person: past it, the least used go —
 * the longest unused, then the least confirmed — never one just made.
 */
async function capRules(trx: Db, p: Principal, made: string[]): Promise<void> {
  await sql`
    delete from intake_rule r
     using (select id from intake_rule
             where household_id = ${p.householdId}::uuid and member_id = ${p.memberId}::uuid
               and id <> all(${made}::uuid[])
             order by last_used, confirmed - contradicted, confirmed, id
             limit greatest(0, (select count(*) from intake_rule
                                 where household_id = ${p.householdId}::uuid
                                   and member_id = ${p.memberId}::uuid) - ${LEARNED_RULES_MAX})) gone
     where r.id = gone.id`.execute(trx);
}

/**
 * An accept taken back by Undo (I3): what it taught taken back with it — the
 * rules it confirmed and contradicted, each by one; a rule left confirmed by
 * nothing, or contradicted more often than confirmed, removed — and it is no
 * longer counted.
 */
export async function unlearnAccept(trx: Db, p: Principal, itemId: string): Promise<void> {
  const o = await trx
    .deleteFrom('intake_outcome')
    .where('household_id', '=', p.householdId)
    .where('member_id', '=', p.memberId)
    .where('item_id', '=', itemId)
    .returning(['confirmed_rules', 'contradicted_rules'])
    .executeTakeFirst();
  if (!o) return;
  const touched = [...o.confirmed_rules, ...o.contradicted_rules];
  if (touched.length === 0) return;
  for (const [ids, col] of [
    [o.confirmed_rules, 'confirmed'],
    [o.contradicted_rules, 'contradicted'],
  ] as const) {
    if (ids.length === 0) continue;
    await trx
      .updateTable('intake_rule')
      .set({ [col]: sql<number>`greatest(${sql.ref(col)} - 1, 0)` })
      .where('household_id', '=', p.householdId)
      .where('member_id', '=', p.memberId)
      .where('id', 'in', ids)
      .execute();
  }
  await trx
    .deleteFrom('intake_rule')
    .where('household_id', '=', p.householdId)
    .where('member_id', '=', p.memberId)
    .where('id', 'in', touched)
    .where(sql<boolean>`confirmed = 0 or contradicted > confirmed`)
    .execute();
}

/**
 * GET /batches/learned: the caller's count — of their newest LEARNING_WINDOW
 * items read and accepted, how many needed no change — and their rules, each
 * with the kind's or the person's name. Nobody else's: the database gives
 * none (0065).
 */
export async function learnedOf(trx: Db, p: Principal): Promise<BatchLearning> {
  const outcomes = await trx
    .selectFrom('intake_outcome')
    .select('unchanged')
    .where('household_id', '=', p.householdId)
    .where('member_id', '=', p.memberId)
    .orderBy('accepted_at', 'desc')
    .orderBy('item_id')
    .limit(LEARNING_WINDOW)
    .execute();
  const rules = await trx
    .selectFrom('intake_rule as r')
    .leftJoin('effective_document_type as t', 't.key', 'r.type_key')
    .leftJoin('member as m', 'm.id', 'r.person_id')
    .select([
      'r.id',
      'r.issuer_key',
      'r.type_key',
      'r.person_id',
      'r.confirmed',
      'r.contradicted',
      'r.last_used',
      't.label as kind_label',
      't.deleted_at as kind_deleted',
      'm.display_name as person_name',
    ])
    .where('r.household_id', '=', p.householdId)
    .where('r.member_id', '=', p.memberId)
    .orderBy('r.issuer_key')
    // Its kind first, then whose: each issuer's rules together.
    .orderBy(sql`r.type_key is null`)
    .orderBy('r.confirmed', 'desc')
    .orderBy('r.id')
    .execute();
  return {
    counted: outcomes.length,
    unchanged: outcomes.filter((o) => o.unchanged).length,
    window: LEARNING_WINDOW,
    rules: rules.map((r) => ({
      id: r.id,
      issuer: r.issuer_key,
      field: r.type_key !== null ? 'type_key' : 'owner_member_id',
      value: (r.type_key ?? r.person_id) as string,
      label:
        r.type_key !== null
          ? r.kind_deleted
            ? null
            : (r.kind_label ?? null)
          : (r.person_name ?? null),
      confirmed: r.confirmed,
      contradicted: r.contradicted,
      sure: ruleSure(r),
      last_used: r.last_used,
    })),
    rules_max: LEARNED_RULES_MAX,
  };
}

/** DELETE /batches/learned: the caller's rules and count, forgotten. */
export async function forgetLearned(trx: Db, p: Principal): Promise<void> {
  await trx
    .deleteFrom('intake_rule')
    .where('household_id', '=', p.householdId)
    .where('member_id', '=', p.memberId)
    .execute();
  await trx
    .deleteFrom('intake_outcome')
    .where('household_id', '=', p.householdId)
    .where('member_id', '=', p.memberId)
    .execute();
}
