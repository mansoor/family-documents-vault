import type { ScopeKeys } from '@fdv/crypto';
import { appendAudit, withPrincipal, type Db } from '@fdv/db';
import {
  canChangeDetails,
  DECEASED_REFUSAL,
  DECEASED_SIGNED_IN,
  DETAILS_REFUSAL,
  suspensionInEffect,
  type MemberAccount,
  type MemberAccountDevice,
  type ResetPath,
  type Role,
} from '@fdv/shared';
import { z } from 'zod';
import { clientOf, describeDevice, type Principal, type RequestMeta } from '../auth/service.js';
import type { StepUpService } from '../auth/step-up.js';
import { ApiError } from '../errors.js';
import { allows, requireCapability } from '../authz.js';
import { photoFields } from './photos.js';
import { restrictionSummaries } from './restrictions.js';

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A day that is one, and has come: tomorrow too, for a family a time zone ahead. */
function bornOn(day: string): boolean {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d));
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d) {
    return false;
  }
  return at.getTime() <= Date.now() + 24 * 60 * 60 * 1000;
}

/**
 * A date of birth (5.25), as a person is added (POST /members) and as they
 * are changed (PATCH): a day that is one, and has come.
 */
const dateOfBirth = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Give the date of birth as a date.')
  .refine(bornOn, 'That date of birth is not a day that has been yet.');

/** POST /members: a person with no sign-in. Their date of birth as a change takes it (5.25). */
export const memberBody = z.object({
  display_name: z.string().trim().min(1).max(120),
  date_of_birth: dateOfBirth.nullable().optional(),
  relationship: z.string().trim().max(60).nullable().optional(),
});

/**
 * PATCH /members/{id} (5.25): what is sent is changed, and nothing else. A
 * blank relationship is none.
 */
export const memberEditBody = z
  .object({
    display_name: z.string().trim().min(1, 'Give them a name.').max(120),
    date_of_birth: dateOfBirth.nullable(),
    relationship: z.string().trim().max(60).nullable(),
    is_deceased: z.boolean(),
  })
  .partial()
  .strict();

/** A person's version as an ETag: `"3"`. */
export const memberEtag = (version: number) => `"${version}"`;

/** Whether an If-Match names this version: `"3"`, `W/"3"`, `3`, or `*`. */
function matches(ifMatch: string, version: number): boolean {
  const said = ifMatch.trim();
  if (said === '*') return true;
  return said.replace(/^W\//, '').replace(/^"(.*)"$/, '$1') === String(version);
}

const notInFamily = () => new ApiError(404, 'not_found', 'That person is not in the family.');

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
  /**
   * Their sign-in was taken away and can be given back to them. Such a
   * person is never invited again: see `mustNeverHaveSignedIn`.
   */
  sign_in_removed: boolean;
  /** Their ready photo, to the family and to themselves (5.17c). */
  photo: { id: string } | null;
  /** A new photo on its way, or refused: only to whoever may change it. */
  photo_status: 'processing' | 'failed' | null;
  /** Whether the caller may give them a photo, or change it (A66). */
  can_change_photo: boolean;
  /**
   * Moved on with every change to their details (5.25), for If-Match: null
   * to whoever is not given their details (a viewer, but for their own).
   */
  version: number | null;
  /** Whether the caller may change their name, date of birth and relationship (A66). */
  can_edit: boolean;
  /**
   * What an owner has limited them to, in a sentence (5.33): told to owners
   * alone, who read every restriction (0054); null for no limits.
   */
  restriction?: { summary: string } | null;
}

export class HouseholdService {
  constructor(
    private readonly db: Db,
    private readonly keys: ScopeKeys,
    /** Recording that somebody has passed away asks for it (5.25). */
    private readonly stepUp?: StepUpService,
    /**
     * How long a phone shows its Essentials without reaching the vault
     * (FDV_OFFLINE_MAX_DAYS): the account card says it, for a lock (5.28).
     */
    private readonly maxOfflineDays = 90,
    /**
     * Which way a password reset an owner starts would go for somebody
     * (5.29, OwnerResetService.pathFor): the account card says it. Asked in
     * the owner's own transaction.
     */
    private readonly resetPath?: (
      trx: Db,
      target: {
        account_id: string;
        role: Role;
        suspended_at: Date | null;
        suspended_until: Date | null;
      },
    ) => Promise<ResetPath | null>,
  ) {}

  async profile(p: Principal) {
    return withPrincipal(this.db, p, async (trx) => {
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
      // A viewer gets the household's name and time zone, which every
      // screen shows, and none of its answers (5.3).
      if (!allows(p, 'family.details')) {
        return {
          household_name: hh.name,
          timezone: hh.timezone,
          owns_home: null,
          rents_home: null,
          vehicle_count: null,
          has_pets: null,
          has_business: null,
          country: null,
          answered_at: null,
          extra: {},
        };
      }
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
    await withPrincipal(this.db, p, async (trx) => {
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
    return withPrincipal(this.db, p, async (trx) => {
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
          'member.former_account_id',
          'member.version',
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
            ...(p.seesAdults ? [eb('visibility', '=', 'adults')] : []),
            eb.and([eb('visibility', '=', 'private'), eb('owner_member_id', '=', p.memberId)]),
          ]),
        )
        .groupBy('owner_member_id')
        .execute();
      const countOf = new Map(counts.map((c) => [c.owner_member_id, Number(c.n)]));
      // Photos, in the same transaction: as the database gives them to the
      // caller (0040), and only what they may be told (5.17c).
      const photos = await photoFields(trx, p, rows);
      // Birthdays and relationships are the family's: a viewer is told only
      // their own (5.3; relationships since 5.17c, the first release that
      // sets one).
      const family = allows(p, 'family.details');
      // Who is limited, and to what, in a sentence (5.33): the owners'
      // alone, who read every restriction; nobody else is told.
      const limits =
        p.role === 'owner'
          ? await restrictionSummaries(
              trx,
              p.householdId,
              rows.map((r) => r.id),
            )
          : null;
      return rows.map((r) => {
        const own = family || r.id === p.memberId;
        const photo = photos.get(r.id);
        return {
          id: r.id,
          display_name: r.display_name,
          date_of_birth: own ? r.date_of_birth : null,
          relationship: own ? r.relationship : null,
          is_deceased: r.is_deceased,
          colour: r.colour,
          has_account: r.role !== null,
          role: r.role,
          is_me: r.id === p.memberId,
          document_count: countOf.get(r.id) ?? 0,
          sign_in_removed: r.role === null && r.former_account_id !== null,
          photo: photo?.photo ?? null,
          photo_status: photo?.photo_status ?? null,
          can_change_photo: photo?.can_change_photo ?? false,
          // A version moves when a birthday or relationship does: told only
          // to whoever is told those (5.25).
          version: own ? r.version : null,
          can_edit: canChangeDetails(
            { role: p.role, memberId: p.memberId },
            { id: r.id, role: r.role },
          ),
          ...(limits ? { restriction: limits.get(r.id) ?? null } : {}),
        };
      });
    });
  }

  /** One person, as `members` gives them; 404 when the caller is not given them. */
  async member(p: Principal, id: string): Promise<MemberView> {
    const found = (await this.members(p)).find((m) => m.id === id.toLowerCase());
    if (!found) throw new ApiError(404, 'not_found', 'That person is not in the family.');
    return found;
  }

  /** Adds a person without a sign-in. Their private-scope key is minted now (data model §8). */
  async addMember(
    p: Principal,
    input: z.infer<typeof memberBody>,
    meta: RequestMeta,
  ): Promise<MemberView> {
    requireCapability(p, 'member.add');
    const id = await withPrincipal(this.db, p, async (trx) => {
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

  /**
   * PATCH /members/{id} (5.25): a person's name, date of birth or
   * relationship, by whoever may change them (A66: `canChangeDetails`); and
   * that they have passed away, or not after all, by an owner alone, who is
   * asked to confirm it is them (`change_people`). Made to the person as the
   * caller saw them: an If-Match naming an older version is `409 conflict`,
   * with the person as they are now in `detail`. Refused, in order: a person
   * the caller cannot see (404); who may (403); a version moved on (409);
   * somebody who can still sign in recorded as passed away (409
   * `signed_in`); the step-up (403). Nothing sent that differs is no
   * change: the version stays, and nothing is logged.
   *
   * The row is held first, then the log (appendAudit's lock, last); and the
   * database's own rule (0046) decides as the row is written, so a change
   * it refuses changed nothing, and is refused here too.
   */
  async updateMember(
    p: Principal,
    requested: string,
    input: z.infer<typeof memberEditBody>,
    ifMatch: string | undefined,
    meta: RequestMeta,
  ): Promise<MemberView> {
    if (!UUID.test(requested)) throw notInFamily();
    const outcome = await withPrincipal(this.db, p, async (trx) => {
      const seen = await trx
        .selectFrom('member')
        .select(['id'])
        .where('id', '=', requested)
        .executeTakeFirst();
      if (!seen) throw notInFamily();
      const membership = await trx
        .selectFrom('account_household')
        .select(['role'])
        .where('member_id', '=', seen.id)
        .executeTakeFirst();
      const role = membership?.role ?? null;
      requireCapability(p, 'member.edit');
      if (!canChangeDetails({ role: p.role, memberId: p.memberId }, { id: seen.id, role })) {
        throw new ApiError(403, 'forbidden', DETAILS_REFUSAL);
      }
      // Held, and read as they are once held: one change at a time. A row
      // held for a change answers to the database's rule for changing a
      // person (0046) too, so one it would refuse is not held, nor changed.
      const current = await trx
        .selectFrom('member')
        .select(['id', 'display_name', 'date_of_birth', 'relationship', 'is_deceased', 'version'])
        .where('id', '=', seen.id)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw new ApiError(403, 'forbidden', DETAILS_REFUSAL);
      // Whether they can sign in, as it is now they are held: an invitation
      // accepted a moment ago is a sign-in.
      const signedIn = await trx
        .selectFrom('account_household')
        .select(['role'])
        .where('member_id', '=', current.id)
        .executeTakeFirst();
      const next = {
        display_name: input.display_name ?? current.display_name,
        date_of_birth:
          input.date_of_birth !== undefined ? input.date_of_birth : current.date_of_birth,
        relationship:
          input.relationship !== undefined ? input.relationship || null : current.relationship,
        is_deceased: input.is_deceased ?? current.is_deceased,
      };
      const passing = next.is_deceased !== current.is_deceased;
      if (passing && p.role !== 'owner') throw new ApiError(403, 'forbidden', DECEASED_REFUSAL);
      if (ifMatch !== undefined && !matches(ifMatch, current.version)) {
        return { id: current.id, stale: true };
      }
      const fields = (['display_name', 'date_of_birth', 'relationship'] as const).filter(
        (k) => next[k] !== current[k],
      );
      if (fields.length === 0 && !passing) return { id: current.id, stale: false };
      if (passing && next.is_deceased && signedIn) {
        throw new ApiError(409, 'signed_in', DECEASED_SIGNED_IN(current.display_name));
      }
      // Asked here, with the person held: whether it is asked depends on
      // what they are now (as a kind of document made visible to more
      // people asks, 0.5.10).
      if (passing) await this.stepUp?.require(p, 'change_people', trx);
      // Nobody signs in as them afterwards: an invitation still waiting for
      // them is taken back with the passing, and said so, as one taken back
      // by hand is.
      const withdrawn =
        passing && next.is_deceased
          ? await trx
              .updateTable('invitation')
              .set({ revoked_at: new Date(), revoked_by: p.accountId })
              .where('member_id', '=', current.id)
              .where('accepted_at', 'is', null)
              .where('revoked_at', 'is', null)
              .returning(['id', 'email'])
              .execute()
          : [];
      const changed = await trx
        .updateTable('member')
        .set(next)
        .where('id', '=', current.id)
        .where('version', '=', current.version)
        .executeTakeFirst();
      // The database's rule refused it (0046): nothing changed, and nothing
      // is said to have.
      if (Number(changed.numUpdatedRows) !== 1) {
        throw new ApiError(403, 'forbidden', DETAILS_REFUSAL);
      }
      if (fields.length > 0) {
        // Which details, never what they were or are now.
        await appendAudit(trx, {
          householdId: p.householdId,
          actorAccountId: p.accountId,
          action: 'member.updated',
          objectType: 'member',
          objectId: current.id,
          detail: { fields },
          ip: meta.ip,
        });
      }
      if (passing) {
        await appendAudit(trx, {
          householdId: p.householdId,
          actorAccountId: p.accountId,
          action: 'member.deceased',
          objectType: 'member',
          objectId: current.id,
          detail: { deceased: next.is_deceased },
          ip: meta.ip,
        });
      }
      for (const invitation of withdrawn) {
        await appendAudit(trx, {
          householdId: p.householdId,
          actorAccountId: p.accountId,
          action: 'invitation.revoked',
          objectType: 'invitation',
          objectId: invitation.id,
          detail: { email: invitation.email, why: 'passed_away' },
          ip: meta.ip,
        });
      }
      return { id: current.id, stale: false };
    });
    // Read afresh, the change made and let go.
    const now = await this.member(p, outcome.id);
    if (outcome.stale) {
      throw new ApiError(
        409,
        'conflict',
        'Someone else changed these details. Reload and try again.',
        { detail: JSON.stringify(now) },
      );
    }
    return now;
  }

  /**
   * GET /members/{id}/account (5.25): an owner's view of somebody's sign-in,
   * read-only — their role and the address they sign in with; whether
   * two-step sign-in is on, and how many passkeys they have; when they last
   * signed in here; and the devices they are signed in on, each in words,
   * app or browser, when it was last used, and whether it keeps Essentials
   * offline. Never an address a device signed in from, a user agent, an id,
   * or anything secret. The route has asked who is asking (A54); a person
   * with no sign-in, or nobody of the family, is 404.
   *
   * Each look is a line in the activity log, `member.account_viewed`, for
   * the owners and the person looked at: written as the card is given, so
   * a refusal writes none, and saying nothing of what the card said.
   */
  async account(p: Principal, requested: string, meta: RequestMeta): Promise<MemberAccount> {
    if (p.role !== 'owner' || !UUID.test(requested)) throw notInFamily();
    return withPrincipal(this.db, p, async (trx) => {
      const row = await trx
        .selectFrom('member')
        .innerJoin('account_household', (j) =>
          j
            .onRef('account_household.member_id', '=', 'member.id')
            .onRef('account_household.household_id', '=', 'member.household_id'),
        )
        .innerJoin('account', 'account.id', 'account_household.account_id')
        .select([
          'member.id',
          'account_household.role',
          'account_household.account_id',
          'account_household.suspended_at',
          'account_household.suspended_until',
          'account_household.suspend_reason',
          'account_household.suspend_note',
          'account.email',
          'account.totp_confirmed_at',
        ])
        .select((eb) =>
          eb
            .selectFrom('account_household as locker')
            .innerJoin('member as locker_member', 'locker_member.id', 'locker.member_id')
            .select('locker_member.display_name')
            .whereRef('locker.account_id', '=', 'account_household.suspended_by')
            .whereRef('locker.household_id', '=', 'account_household.household_id')
            .as('suspended_by_name'),
        )
        .where('member.id', '=', requested)
        .executeTakeFirst();
      if (!row) throw new ApiError(404, 'not_found', 'They have no sign-in to show.');
      const passkeys = await trx
        .selectFrom('credential')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('account_id', '=', row.account_id)
        .where('kind', '=', 'passkey')
        .executeTakeFirstOrThrow();
      // Their sessions here: the household's, through its own rule.
      const sessions = await trx
        .selectFrom('session')
        .select([
          'created_at',
          'last_used_at',
          'revoked_at',
          'expires_at',
          'absolute_expires_at',
          'user_agent',
          'installation_id',
          'offline_expires_at',
        ])
        .where('account_id', '=', row.account_id)
        .orderBy('last_used_at', 'desc')
        .execute();
      const now = Date.now();
      const last = sessions.reduce<Date | null>(
        (at, s) => (at === null || s.created_at > at ? s.created_at : at),
        null,
      );
      const devices: MemberAccountDevice[] = sessions
        .filter(
          (s) =>
            s.revoked_at === null &&
            s.expires_at.getTime() > now &&
            s.absolute_expires_at.getTime() > now,
        )
        .map((s) => ({
          label: describeDevice(s.user_agent ?? 'unknown'),
          client: clientOf(s.installation_id, s.user_agent),
          last_used_at: s.last_used_at.toISOString(),
          offline: s.offline_expires_at !== null && new Date(s.offline_expires_at).getTime() > now,
        }));
      // Which way a reset would go (5.29): yes or no about what they keep
      // private, never what.
      const resetPath =
        this.resetPath && row.account_id !== p.accountId
          ? await this.resetPath(trx, row)
          : undefined;
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'member.account_viewed',
        objectType: 'member',
        objectId: row.id,
        ip: meta.ip,
      });
      return {
        member_id: row.id,
        role: row.role,
        email: row.email,
        two_step: row.totp_confirmed_at !== null,
        passkeys: Number(passkeys.n),
        last_signed_in_at: last?.toISOString() ?? null,
        devices,
        // A lock, or a pause after a restore (5.28): one past its end is over.
        suspension:
          row.suspend_reason !== null && row.suspended_at !== null && suspensionInEffect(row)
            ? {
                reason: row.suspend_reason,
                since: row.suspended_at.toISOString(),
                until: row.suspended_until?.toISOString() ?? null,
                note: row.suspend_note,
                by: row.suspended_by_name ?? null,
              }
            : null,
        max_offline_days: this.maxOfflineDays,
        ...(this.resetPath ? { reset_path: resetPath ?? null } : {}),
      };
    });
  }
}
