import { appendAudit, withPrincipal, type Db } from '@fdv/db';
import {
  conditionHolds,
  localToday,
  suggestionKey,
  suggestionTitle,
  wantedCount,
  type Condition,
  type SuggestionProfile,
  type SuggestionRule,
  type SuggestionView,
} from '@fdv/shared';
import { sql } from 'kysely';
import type { Principal, RequestMeta } from '../auth/service.js';
import { ApiError } from '../errors.js';
import { allows, requireCapability } from '../authz.js';

/**
 * "We noticed something missing" (REM-10).
 *
 * The rules live in the database as data; the judgement lives in
 * @fdv/shared where it can be read and tested. This service is the join:
 * it gathers the household's answers, its people and what is already on
 * file, then asks each rule whether it has anything to say.
 *
 * What counts as "already on file" is what *this caller* can see. A
 * private document belonging to another adult does not silently satisfy a
 * rule, because that would let the absence of a suggestion reveal the
 * presence of a document. The cost is an occasional redundant suggestion;
 * the alternative is a leak, and this side of the trade is the quiet one.
 */

export interface SuggestionList {
  items: SuggestionView[];
  /**
   * False until someone answers the wizard's questions: the UI offers to.
   * Null for a viewer, who is not told about the family at all (5.3).
   */
  profile_answered: boolean | null;
  /** How many suggestions this household has waved away. */
  dismissed_count: number;
}

/** A rule row as Postgres hands it back: the jsonb columns are already parsed. */
interface RuleRow {
  key: string;
  condition: Condition | null;
  suggests_type: string;
  scope: 'household' | 'per_member';
  quantity: SuggestionRule['quantity'];
  noun: string;
  why: string;
  sort_order: number;
  type_label: string;
}

export class SuggestionService {
  constructor(private readonly db: Db) {}

  async list(p: Principal, opts: { includeDismissed?: boolean } = {}): Promise<SuggestionList> {
    // Worked out from the household's answers and who is a child: "No
    // passport for Aisha" tells a viewer what 5.3 keeps from them.
    if (!allows(p, 'family.details'))
      return { items: [], profile_answered: null, dismissed_count: 0 };
    return withPrincipal(this.db, p, async (trx) => {
      const household = await trx
        .selectFrom('household')
        .select('timezone')
        .where('id', '=', p.householdId)
        .executeTakeFirstOrThrow();
      const profileRow = await trx
        .selectFrom('household_profile')
        .selectAll()
        .where('household_id', '=', p.householdId)
        .executeTakeFirst();
      const profile: SuggestionProfile = {
        owns_home: profileRow?.owns_home ?? null,
        rents_home: profileRow?.rents_home ?? null,
        vehicle_count: profileRow?.vehicle_count ?? null,
        has_pets: profileRow?.has_pets ?? null,
        has_business: profileRow?.has_business ?? null,
        country: profileRow?.country ?? null,
      };
      const today = localToday(household.timezone);

      const rules = await trx
        .selectFrom('suggestion_rule')
        .innerJoin('document_type', 'document_type.key', 'suggestion_rule.suggests_type')
        .select([
          'suggestion_rule.key',
          'suggestion_rule.condition',
          'suggestion_rule.suggests_type',
          'suggestion_rule.scope',
          'suggestion_rule.quantity',
          'suggestion_rule.noun',
          'suggestion_rule.why',
          'suggestion_rule.sort_order',
          'document_type.label as type_label',
        ])
        .where('suggestion_rule.enabled', '=', true)
        .orderBy('suggestion_rule.sort_order')
        .execute();

      const members = await trx
        .selectFrom('member')
        .select(['id', 'display_name', 'date_of_birth', 'is_deceased'])
        .where('household_id', '=', p.householdId)
        .where('is_deceased', '=', false)
        .orderBy('created_at')
        .execute();

      const counts = await this.countsVisibleTo(trx, p);
      const dismissed = new Set(
        (
          await trx.selectFrom('suggestion_dismissal').select(['rule_key', 'member_id']).execute()
        ).map((d) => suggestionKey(d.rule_key, d.member_id)),
      );

      const items: SuggestionView[] = [];
      for (const row of rules as unknown as RuleRow[]) {
        const rule: SuggestionRule = {
          key: row.key,
          condition: row.condition ?? {},
          suggests_type: row.suggests_type,
          scope: row.scope,
          quantity: row.quantity,
          noun: row.noun,
          why: row.why,
          sort_order: row.sort_order,
        };
        const candidates =
          rule.scope === 'per_member'
            ? members.map((m) => ({
                member: {
                  id: m.id,
                  display_name: m.display_name,
                  date_of_birth: m.date_of_birth,
                  is_deceased: m.is_deceased,
                },
              }))
            : [{ member: undefined }];

        for (const { member } of candidates) {
          if (!conditionHolds(rule.condition, { profile, member, today })) continue;
          const have =
            rule.scope === 'per_member'
              ? (counts.perMember.get(`${rule.suggests_type}:${member?.id ?? ''}`) ?? 0)
              : (counts.household.get(rule.suggests_type) ?? 0);
          const missing = wantedCount(rule, profile) - have;
          if (missing <= 0) continue;
          const key = suggestionKey(rule.key, member?.id ?? null);
          const isDismissed = dismissed.has(key);
          items.push({
            key,
            rule_key: rule.key,
            member_id: member?.id ?? null,
            member_name: member?.display_name ?? null,
            type_key: rule.suggests_type,
            type_label: row.type_label,
            title: suggestionTitle(rule, missing, have, member?.display_name),
            why: rule.why,
            missing,
            dismissed: isDismissed,
          });
        }
      }

      return {
        items: items.filter((i) => i.dismissed === Boolean(opts.includeDismissed)),
        profile_answered: profileRow?.answered_at != null,
        dismissed_count: items.filter((i) => i.dismissed).length,
      };
    });
  }

  /**
   * What is already filed, by type and by owner, counting only documents
   * this caller may see. Deleted documents and untyped scans do not count:
   * a scan nobody has named is not a birth certificate yet.
   */
  private async countsVisibleTo(
    trx: Db,
    p: Principal,
  ): Promise<{ household: Map<string, number>; perMember: Map<string, number> }> {
    const adultsOk = allows(p, 'document.see_adults');
    const rows = await sql<{ type_key: string; owner_member_id: string | null; n: string }>`
      select type_key, owner_member_id, count(*) as n
        from document
       where deleted_at is null
         and type_key is not null
         and (visibility = 'household'
              or (visibility = 'adults' and ${adultsOk})
              or (visibility = 'private' and owner_member_id = ${p.memberId}::uuid))
       group by type_key, owner_member_id
    `.execute(trx);
    const household = new Map<string, number>();
    const perMember = new Map<string, number>();
    for (const r of rows.rows) {
      const n = Number(r.n);
      household.set(r.type_key, (household.get(r.type_key) ?? 0) + n);
      if (r.owner_member_id) {
        const key = `${r.type_key}:${r.owner_member_id}`;
        perMember.set(key, (perMember.get(key) ?? 0) + n);
      }
    }
    return { household, perMember };
  }

  /** "Not for us." Reversible — see `restore`. */
  async dismiss(p: Principal, key: string, meta: RequestMeta): Promise<void> {
    this.canDecide(p);
    const { ruleKey, memberId } = this.split(key);
    await withPrincipal(this.db, p, async (trx) => {
      const rule = await trx
        .selectFrom('suggestion_rule')
        .select('key')
        .where('key', '=', ruleKey)
        .executeTakeFirst();
      if (!rule) throw new ApiError(404, 'not_found', 'There is no suggestion by that name.');
      await trx
        .insertInto('suggestion_dismissal')
        .values({
          household_id: p.householdId,
          rule_key: ruleKey,
          member_id: memberId,
          dismissed_by: p.accountId,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'suggestion.dismiss',
        objectType: 'suggestion',
        detail: { key },
        ip: meta.ip,
      });
    });
  }

  /** Show it again. */
  async restore(p: Principal, key: string, meta: RequestMeta): Promise<void> {
    this.canDecide(p);
    const { ruleKey, memberId } = this.split(key);
    await withPrincipal(this.db, p, async (trx) => {
      let q = trx.deleteFrom('suggestion_dismissal').where('rule_key', '=', ruleKey);
      q = memberId ? q.where('member_id', '=', memberId) : q.where('member_id', 'is', null);
      await q.execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'suggestion.restore',
        objectType: 'suggestion',
        detail: { key },
        ip: meta.ip,
      });
    });
  }

  private canDecide(p: Principal): void {
    requireCapability(p, 'profile.edit');
  }

  private split(key: string): { ruleKey: string; memberId: string | null } {
    const at = key.indexOf(':');
    if (at === -1) return { ruleKey: key, memberId: null };
    return { ruleKey: key.slice(0, at), memberId: key.slice(at + 1) };
  }
}
