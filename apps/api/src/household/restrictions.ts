import { withPrincipal, type Db } from '@fdv/db';
import { restrictionSummary, type RestrictionSummary } from '@fdv/shared';
import { sql } from 'kysely';
import type { AlertRequest } from '../alert-job.js';
import type { Principal } from '../auth/service.js';
import { requireCapability } from '../authz.js';
import { ApiError } from '../errors.js';

/**
 * Limiting what a viewer sees (5.32, A56–A59): the service half.
 *
 * The database keeps the rule (0054): what a restricted viewer is given,
 * everywhere. Here is what an owner restricting somebody must be asked
 * first. There is no route yet — 5.33 adds `PUT /members/{id}/access`,
 * which calls `restrict` — and the tests call it directly.
 *
 *  - Only owners restrict (`role.change`), and only a viewer, or somebody
 *    with no sign-in (A58); the database refuses anybody else's too.
 *  - Restricting somebody who keeps Only me documents asks the owner to
 *    confirm (`confirm_private`), and the person is told (A59). Otherwise an
 *    owner could make an adult a viewer, restrict them, and cut them off
 *    like a lock, with none of 5.28's guard rails or alerts. They still see
 *    their own Only me documents; the database refuses the restriction
 *    without the owner's confirmation.
 *
 * A restriction is the person's, not their sign-in's: taking the sign-in
 * away leaves it, and giving it back asks the owners to confirm it again
 * (`reconfirm_since`, 0054), which 5.33's screens read.
 */

/** What a restriction grants: whose documents, of which kinds, which collections. */
export interface RestrictionGrant {
  people?: string[] | undefined;
  types?: string[] | undefined;
  collections?: string[] | undefined;
  include_adults_only?: boolean | undefined;
  include_no_person_docs?: boolean | undefined;
  expires_at?: Date | null | undefined;
}

/** What `restrict` did. */
export interface Restricted {
  member_id: string;
  /** They keep Only me documents, and the owner confirmed it. */
  confirmed_private: boolean;
  /** They were told (A59): only somebody with a sign-in can be. */
  told: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notFound = () => new ApiError(404, 'not_found', 'That person is not in the family.');

/** Said to an owner restricting somebody who keeps Only me documents (A59). */
export const CONFIRM_PRIVATE = (name: string) =>
  `${name} keeps documents only they can see. Limited, they still see those, and nothing else of the family’s that you do not give them. Confirm to go ahead: they will be told.`;

/**
 * Said to an owner giving somebody restricted any role but viewer (the 5.32
 * review): a restriction never stands beside another role, so their limits
 * come off first. The database refuses it too (0054's
 * account_household_restricted_role, SQLSTATE FDV02).
 */
export const LIMITS_FIRST = (name: string | null) =>
  `${name ?? 'Their'}${name ? "'s" : ''} access is limited to some documents. Remove their limits first.`;

/** `409 restricted`, for a role but viewer's asked for somebody restricted. */
export const restrictedRefusal = (name: string | null) =>
  new ApiError(409, 'restricted', LIMITS_FIRST(name));

/**
 * Whether somebody has a restriction: asked by an owner before a change of
 * role, a sign-in given back or an invitation, as the owner reads every
 * restriction of the household (0054). Anybody else reads none but their
 * own, and is answered by the database when it is written.
 */
export async function isRestricted(trx: Db, memberId: string): Promise<boolean> {
  const row = await trx
    .selectFrom('access_restriction')
    .select('member_id')
    .where('member_id', '=', memberId)
    .executeTakeFirst();
  return row !== undefined;
}

/** Said to an owner restricting anybody but a viewer (A58). */
export const ONLY_VIEWERS = (name: string) =>
  `Only a viewer can be limited to some documents. ${name} is not a viewer.`;

export class RestrictionService {
  constructor(
    private readonly db: Db,
    /** Tells a set of accounts something. Returns without waiting. */
    private readonly alert: (input: AlertRequest) => Promise<void> = async () => undefined,
  ) {}

  /**
   * Restricts somebody, or changes their restriction, to exactly `grant`
   * (5.33's PUT /members/{id}/access will call this). Owners only. Somebody
   * who keeps Only me documents is restricted only with `confirmPrivate`,
   * and is then told; without it, `409 confirm_private` and nothing changes.
   */
  async restrict(
    p: Principal,
    memberId: string,
    grant: RestrictionGrant,
    opts: { confirmPrivate?: boolean } = {},
  ): Promise<Restricted> {
    requireCapability(p, 'role.change');
    if (!UUID.test(memberId)) throw notFound();
    let tell: { accountId: string; household: string } | null = null;
    const done = await withPrincipal(this.db, p, async (trx) => {
      // The person, held: their sign-in, if any, cannot change under us.
      const person = await trx
        .selectFrom('member')
        .select(['id', 'display_name'])
        .where('id', '=', memberId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!person) throw notFound();
      const signIn = await trx
        .selectFrom('account_household')
        .select(['account_id', 'role'])
        .where('member_id', '=', person.id)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (signIn && signIn.role !== 'viewer') {
        throw new ApiError(409, 'not_a_viewer', ONLY_VIEWERS(person.display_name));
      }
      // Whether they keep Only me documents, in the Trash too: the database
      // asks the same, and refuses the restriction without a confirmation.
      const keeps = await trx
        .selectFrom('document')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('owner_member_id', '=', person.id)
        .where('visibility', '=', 'private')
        .executeTakeFirstOrThrow();
      const keepsPrivate = keeps.n > 0;
      const existing = await trx
        .selectFrom('access_restriction')
        .select(['member_id', 'private_confirmed_at'])
        .where('member_id', '=', person.id)
        .executeTakeFirst();
      // Asked once: a restriction already confirmed is changed without asking again.
      const confirmed = existing?.private_confirmed_at != null;
      if (keepsPrivate && !confirmed && !opts.confirmPrivate) {
        throw new ApiError(409, 'confirm_private', CONFIRM_PRIVATE(person.display_name));
      }
      const values = {
        include_adults_only: grant.include_adults_only ?? false,
        include_no_person_docs: grant.include_no_person_docs ?? false,
        expires_at: grant.expires_at ?? null,
        // Whether people, or kinds, are named at all: kept apart from the
        // rows naming them, so that one deleted since narrows, and the last
        // one gone gives nothing (the 5.32 review, R532-01).
        limits_people: (grant.people ?? []).length > 0,
        limits_types: (grant.types ?? []).length > 0,
        ...(keepsPrivate && !confirmed ? { private_confirmed_at: new Date() } : {}),
      };
      const written = existing
        ? await trx
            .updateTable('access_restriction')
            .set({ ...values, reconfirm_since: null })
            .where('member_id', '=', person.id)
            .executeTakeFirst()
            .then((r) => Number(r.numUpdatedRows))
        : await trx
            .insertInto('access_restriction')
            .values({ member_id: person.id, household_id: p.householdId, ...values })
            .executeTakeFirst()
            .then((r) => Number(r.numInsertedOrUpdatedRows ?? 0n));
      // Row-level security turns a write it refuses into nothing written.
      if (written !== 1) throw notFound();
      await this.replace(trx, p.householdId, person.id, grant);
      if (keepsPrivate && !confirmed && signIn) {
        tell = { accountId: signIn.account_id, household: p.householdId };
      }
      return { member_id: person.id, confirmed_private: keepsPrivate, told: tell !== null };
    });
    const told = tell as { accountId: string; household: string } | null;
    if (told) {
      const hh = await withPrincipal(this.db, p, (trx) =>
        trx
          .selectFrom('household')
          .select('name')
          .where('id', '=', p.householdId)
          .executeTakeFirstOrThrow(),
      );
      await this.alert({
        householdId: told.household,
        accountIds: [told.accountId],
        subject: `What you can see in ${hh.name} has been limited`,
        body:
          'An owner has limited the documents you can see in the family vault. Your own Only me ' +
          'documents are still yours to see. If you think this is a mistake, talk to an owner.',
        emailOnly: true,
      });
    }
    return done;
  }

  /** The people, kinds and collections named: exactly the grant, each written as asked. */
  private async replace(
    trx: Db,
    householdId: string,
    restricted: string,
    grant: RestrictionGrant,
  ): Promise<void> {
    await trx
      .deleteFrom('access_restriction_member')
      .where('restricted_member_id', '=', restricted)
      .execute();
    await trx
      .deleteFrom('access_restriction_type')
      .where('restricted_member_id', '=', restricted)
      .execute();
    await trx
      .deleteFrom('access_restriction_collection')
      .where('restricted_member_id', '=', restricted)
      .execute();
    const people = [...new Set(grant.people ?? [])];
    const types = [...new Set(grant.types ?? [])];
    const collections = [...new Set(grant.collections ?? [])];
    const wrote = async (
      n: Promise<{ numInsertedOrUpdatedRows: bigint | undefined }>,
      want: number,
    ) => {
      if (Number((await n).numInsertedOrUpdatedRows ?? 0n) !== want) throw notFound();
    };
    if (people.length) {
      await wrote(
        trx
          .insertInto('access_restriction_member')
          .values(
            people.map((m) => ({
              restricted_member_id: restricted,
              household_id: householdId,
              member_id: m,
            })),
          )
          .executeTakeFirst(),
        people.length,
      );
    }
    if (types.length) {
      await wrote(
        trx
          .insertInto('access_restriction_type')
          .values(
            types.map((t) => ({
              restricted_member_id: restricted,
              household_id: householdId,
              type_key: t,
            })),
          )
          .executeTakeFirst(),
        types.length,
      );
    }
    if (collections.length) {
      await wrote(
        trx
          .insertInto('access_restriction_collection')
          .values(
            collections.map((c) => ({
              restricted_member_id: restricted,
              household_id: householdId,
              collection_id: c,
            })),
          )
          .executeTakeFirst(),
        collections.length,
      );
    }
  }
}

/**
 * Each of these people's restriction, in a sentence, for an owner (A55's
 * "After a restore"): null for somebody with none. Read in the owner's own
 * transaction: an owner reads every restriction of the household (0054).
 */
export async function restrictionSummaries(
  trx: Db,
  householdId: string,
  memberIds: string[],
  now: number = Date.now(),
): Promise<Map<string, RestrictionSummary>> {
  const found = new Map<string, RestrictionSummary>();
  if (memberIds.length === 0) return found;
  const hh = await trx
    .selectFrom('household')
    .select('timezone')
    .where('id', '=', householdId)
    .executeTakeFirstOrThrow();
  const rows = await trx
    .selectFrom('access_restriction as r')
    .select([
      'r.member_id',
      'r.include_adults_only',
      'r.include_no_person_docs',
      'r.expires_at',
      sql<number>`(select count(*)::int from access_restriction_member m
                    where m.restricted_member_id = r.member_id)`.as('people'),
      sql<number>`(select count(*)::int from access_restriction_type t
                    where t.restricted_member_id = r.member_id)`.as('types'),
      // Only those that grant anything: for Everyone, and not deleted, as
      // the rule counts them (A17; the 5.32 review, O532-6).
      sql<number>`(select count(*)::int from access_restriction_collection g
                     join doc_collection c on c.id = g.collection_id
                    where g.restricted_member_id = r.member_id
                      and c.deleted_at is null
                      and c.audience = 'everyone')`.as('collections'),
    ])
    .where('r.member_id', 'in', memberIds)
    .execute();
  for (const r of rows) {
    found.set(r.member_id, { summary: restrictionSummary(r, hh.timezone, now) });
  }
  return found;
}
