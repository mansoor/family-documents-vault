import type { ScopeKeys } from '@fdv/crypto';
import { appendAudit, withScope, type Db } from '@fdv/db';
import { z } from 'zod';
import type { Principal, RequestMeta } from '../auth/service.js';
import { ApiError } from '../errors.js';
import { allows, requireCapability } from '../authz.js';

/**
 * The household's people and its profile — what the first-run wizard
 * writes (design decision 6) and what the home screen's people row reads.
 * A member need not have a sign-in: children and late parents are members
 * with documents and no account (SHR-01).
 */

export const profileBody = z
  .object({
    owns_home: z.boolean().nullable(),
    rents_home: z.boolean().nullable(),
    vehicle_count: z.number().int().min(0).max(20).nullable(),
    has_pets: z.boolean().nullable(),
    has_business: z.boolean().nullable(),
    country: z.string().trim().length(2).toUpperCase().nullable(),
    timezone: z.string().min(1).max(64),
    extra: z.record(z.string(), z.unknown()),
  })
  .partial()
  .strict();

export const memberBody = z.object({
  display_name: z.string().trim().min(1).max(120),
  date_of_birth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  relationship: z.string().trim().max(60).nullable().optional(),
});

export interface MemberView {
  id: string;
  display_name: string;
  date_of_birth: string | null;
  relationship: string | null;
  is_deceased: boolean;
  colour: number;
  has_account: boolean;
  role: string | null;
  /** True for the member the signed-in account belongs to. */
  is_me: boolean;
  document_count: number;
}

export class HouseholdService {
  constructor(
    private readonly db: Db,
    private readonly keys: ScopeKeys,
  ) {}

  async profile(p: Principal) {
    return withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const row = await trx
        .selectFrom('household_profile')
        .selectAll()
        .where('household_id', '=', p.householdId)
        .executeTakeFirst();
      const hh = await trx
        .selectFrom('household')
        .select(['name', 'created_at', 'timezone'])
        .where('id', '=', p.householdId)
        .executeTakeFirstOrThrow();
      return {
        household_name: hh.name,
        timezone: hh.timezone,
        owns_home: row?.owns_home ?? null,
        rents_home: row?.rents_home ?? null,
        vehicle_count: row?.vehicle_count ?? null,
        has_pets: row?.has_pets ?? null,
        has_business: row?.has_business ?? null,
        country: row?.country ?? null,
        answered_at: row?.answered_at?.toISOString() ?? null,
        extra: (row?.extra ?? {}) as Record<string, unknown>,
      };
    });
  }

  async updateProfile(p: Principal, input: z.infer<typeof profileBody>, meta: RequestMeta) {
    requireCapability(p, 'profile.edit');
    await withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const values: Record<string, unknown> = { answered_at: new Date() };
      for (const k of [
        'owns_home',
        'rents_home',
        'vehicle_count',
        'has_pets',
        'has_business',
        'country',
      ] as const) {
        if (input[k] !== undefined) values[k] = input[k];
      }
      if (input.extra !== undefined) values.extra = JSON.stringify(input.extra);
      if (input.timezone !== undefined) {
        try {
          new Intl.DateTimeFormat('en', { timeZone: input.timezone });
        } catch {
          throw new ApiError(422, 'validation_failed', 'That time zone is not recognised.');
        }
        await trx
          .updateTable('household')
          .set({ timezone: input.timezone })
          .where('id', '=', p.householdId)
          .execute();
      }
      await trx
        .insertInto('household_profile')
        .values({ household_id: p.householdId, ...values })
        .onConflict((oc) => oc.column('household_id').doUpdateSet(values))
        .execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'household.profile_updated',
        detail: { fields: Object.keys(input) },
        ip: meta.ip,
      });
    });
    return this.profile(p);
  }

  async members(p: Principal): Promise<MemberView[]> {
    return withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const rows = await trx
        .selectFrom('member')
        .leftJoin('account_household', (j) =>
          j
            .onRef('account_household.member_id', '=', 'member.id')
            .onRef('account_household.household_id', '=', 'member.household_id'),
        )
        .select([
          'member.id',
          'member.display_name',
          'member.date_of_birth',
          'member.relationship',
          'member.is_deceased',
          'member.colour',
          'account_household.role',
        ])
        .orderBy('member.created_at')
        .execute();
      const counts = await trx
        .selectFrom('document')
        .select(['owner_member_id', (eb) => eb.fn.countAll<number>().as('n')])
        .where('deleted_at', 'is', null)
        .where((eb) =>
          eb.or([
            eb('visibility', '=', 'household'),
            ...(allows(p, 'document.see_adults') ? [eb('visibility', '=', 'adults')] : []),
            eb.and([eb('visibility', '=', 'private'), eb('owner_member_id', '=', p.memberId)]),
          ]),
        )
        .groupBy('owner_member_id')
        .execute();
      const countOf = new Map(counts.map((c) => [c.owner_member_id, Number(c.n)]));
      return rows.map((r) => ({
        id: r.id,
        display_name: r.display_name,
        date_of_birth: r.date_of_birth,
        relationship: r.relationship,
        is_deceased: r.is_deceased,
        colour: r.colour,
        has_account: r.role !== null,
        role: r.role,
        is_me: r.id === p.memberId,
        document_count: countOf.get(r.id) ?? 0,
      }));
    });
  }

  /** Adds a person without a sign-in. Their private-scope key is minted now (data model §8). */
  async addMember(
    p: Principal,
    input: z.infer<typeof memberBody>,
    meta: RequestMeta,
  ): Promise<MemberView> {
    requireCapability(p, 'member.add');
    const id = await withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const n = await trx
        .selectFrom('member')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .executeTakeFirstOrThrow();
      const row = await trx
        .insertInto('member')
        .values({
          household_id: p.householdId,
          display_name: input.display_name,
          date_of_birth: input.date_of_birth ?? null,
          relationship: input.relationship ?? null,
          colour: Number(n.n) % 8,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.keys.mintMemberKey(trx, p.householdId, row.id, null);
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'member.added',
        objectType: 'member',
        objectId: row.id,
        detail: { display_name: input.display_name },
        ip: meta.ip,
      });
      return row.id;
    });
    const all = await this.members(p);
    return all.find((m) => m.id === id) as MemberView;
  }
}
