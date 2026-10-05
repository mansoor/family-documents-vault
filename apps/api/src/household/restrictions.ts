import { appendAudit, withPrincipal, type Db } from '@fdv/db';
import {
  ACCESS_GRANT_MAX,
  can,
  mayBeRestricted,
  onlyEveryone,
  restrictionSummary,
  youCanSee,
  type AccessGrant,
  type AccessPreview,
  type MemberAccess,
  type MyRestriction,
  type RestrictionSummary,
} from '@fdv/shared';
import { sql } from 'kysely';
import { z } from 'zod';
import type { AlertRequest } from '../alert-job.js';
import type { Principal, RequestMeta } from '../auth/service.js';
import { requireCapability } from '../authz.js';
import { ApiError } from '../errors.js';

/**
 * Limiting what a viewer sees (5.32, 5.33, A56–A59): the service half.
 *
 * The database keeps the rule (0054): what a restricted viewer is given,
 * everywhere. Here is what an owner restricting somebody must be asked
 * first, and what the screens read (5.33):
 *
 *  - Only owners restrict (`role.change`; the routes add the owner power,
 *    A54), and only a viewer, or somebody with no sign-in (A58); the
 *    database refuses anybody else's too.
 *  - Restricting somebody who keeps Only me documents asks the owner to
 *    confirm (`confirm_private`), and the person is told (A59). Otherwise an
 *    owner could make an adult a viewer, restrict them, and cut them off
 *    like a lock, with none of 5.28's guard rails or alerts. They still see
 *    their own Only me documents; the database refuses the restriction
 *    without the owner's confirmation.
 *  - Only a collection for Everyone is given (A17): any other is refused
 *    with a sentence (422), and the database refuses it too (0055).
 *
 * A restriction is the person's, not their sign-in's: taking the sign-in
 * away leaves it, and giving it back asks the owners to confirm it again
 * (`reconfirm_since`, 0054). Confirming is putting the same grant: every
 * write here clears it, and taking the limits off removes it with them.
 *
 * The order every write here takes its locks in, as a role change does:
 * the household (FOR SHARE), the person, their sign-in (FOR NO KEY
 * UPDATE), their restriction (FOR UPDATE), the collections it names (FOR
 * SHARE, as each is named, 0055's trigger) before any grant of theirs is
 * taken away; and the activity log's lock last (appendAudit).
 */

/** What a restriction grants: whose documents, of which kinds, which collections. */
export interface RestrictionGrant {
  people?: string[] | undefined;
  types?: string[] | undefined;
  collections?: string[] | undefined;
  include_adults_only?: boolean | undefined;
  include_no_person_docs?: boolean | undefined;
  expires_at?: Date | null | undefined;
  /**
   * Whether it names people, or kinds, at all, as the caller said it: left
   * out, an empty list keeps what the restriction says now (the 5.33
   * review); `false` lets an empty list mean "anybody's" or "any kind".
   */
  limits_people?: boolean | undefined;
  limits_types?: boolean | undefined;
}

/** A grant once checked (`checkGrant`): every part said, each unique. */
export interface CheckedGrant {
  people: string[];
  types: string[];
  collections: string[];
  include_adults_only: boolean;
  include_no_person_docs: boolean;
  expires_at: Date | null;
  /** As the caller said them, or left out (`RestrictionGrant`). */
  limits_people?: boolean | undefined;
  limits_types?: boolean | undefined;
}

/**
 * Whether a restriction names people, or kinds, once written: whenever any
 * is named; otherwise as the caller says, and when they say nothing, as it
 * says now. An empty list never clears it by itself: a person or a kind
 * named and deleted since leaves the list empty and the restriction still
 * limited by them, giving nothing that way (R532-01, the 5.33 review).
 */
export const limitsAfter = (named: string[], said: boolean | undefined, had: boolean | undefined) =>
  named.length > 0 || (said ?? had ?? false);

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

/** The fields of a grant, as PUT /members/{id}/access, the preview and an invitation take them. */
const grantFields = {
  people: z
    .array(z.string().uuid('Choose people from the family.'))
    .max(ACCESS_GRANT_MAX.people, `Choose ${ACCESS_GRANT_MAX.people} people at most.`)
    .optional(),
  types: z
    .array(z.string().trim().min(1).max(64))
    .max(ACCESS_GRANT_MAX.types, `Choose ${ACCESS_GRANT_MAX.types} kinds at most.`)
    .optional(),
  collections: z
    .array(z.string().uuid('Choose collections of the family.'))
    .max(
      ACCESS_GRANT_MAX.collections,
      `Choose ${ACCESS_GRANT_MAX.collections} collections at most.`,
    )
    .optional(),
  include_adults_only: z.boolean().optional(),
  include_no_person_docs: z.boolean().optional(),
  expires_at: z.string().datetime({ offset: true }).nullable().optional(),
  // Whether people, or kinds, are named at all (the 5.33 review): what GET
  // gives, sent back as it came.
  limits_people: z.boolean().optional(),
  limits_types: z.boolean().optional(),
};

/** A grant: an invitation's `restriction`, and the preview's (as a query, below). */
export const accessGrantBody = z.object(grantFields).strict();

/** PUT /members/{id}/access: the grant, and the owner's confirmation (A59) when asked for it. */
export const accessPutBody = z
  .object({ ...grantFields, confirm_private: z.boolean().optional() })
  .strict();

/** A list in a query string: `people=a,b`. Empty is none. */
const listOf = (v: unknown): unknown =>
  typeof v === 'string' ? v.split(',').filter((x) => x.trim() !== '') : v;
/** A flag in a query string: `true` or `false`. */
const flagOf = (v: unknown): unknown => (v === 'true' ? true : v === 'false' ? false : v);

/**
 * GET /members/{id}/access/preview: the same grant, in the query string —
 * lists comma-separated, flags `true` or `false`.
 */
export const accessPreviewQuery = z
  .object({
    people: z.preprocess(listOf, grantFields.people),
    types: z.preprocess(listOf, grantFields.types),
    collections: z.preprocess(listOf, grantFields.collections),
    include_adults_only: z.preprocess(flagOf, grantFields.include_adults_only),
    include_no_person_docs: z.preprocess(flagOf, grantFields.include_no_person_docs),
    expires_at: z.preprocess((v) => (v === '' ? null : v), grantFields.expires_at),
    limits_people: z.preprocess(flagOf, grantFields.limits_people),
    limits_types: z.preprocess(flagOf, grantFields.limits_types),
  })
  .strict();

/** A grant as the body said it, with its end as a date. */
export function grantOf(body: z.infer<typeof accessGrantBody>): RestrictionGrant {
  return {
    people: body.people ?? [],
    types: body.types ?? [],
    collections: body.collections ?? [],
    include_adults_only: body.include_adults_only ?? false,
    include_no_person_docs: body.include_no_person_docs ?? false,
    expires_at: body.expires_at ? new Date(body.expires_at) : null,
    limits_people: body.limits_people,
    limits_types: body.limits_types,
  };
}

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
 * Said of a collection that is not for Everyone (A17): only an Everyone
 * collection is ever given to a viewer. The one sentence, in @fdv/shared.
 */
export const ONLY_EVERYONE = onlyEveryone;

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

/**
 * The household, held FOR SHARE, as a role change holds it (co-owners.ts
 * holdHousehold, written again here: that module reads this one).
 */
const holdHousehold = (trx: Db) =>
  sql`select 1 from household where id = app_household() for share`.execute(trx);

const invalid = (message: string, field: string) =>
  new ApiError(422, 'validation_failed', message, { detail: field });

/**
 * A grant checked as the caller sees the family (5.33): an end in the
 * future — or the one the restriction has now, ended or not, so that
 * confirming an ended restriction keeps it ended (the 5.33 review,
 * L533-05); the people, kinds and collections it names each one the caller
 * may see; a collection for Everyone (A17). A collection deleted since it
 * was named is left out, never refused: it gives nothing, and refusing it
 * would leave limits nobody could save (L533-02). Unique, and as the
 * database spells them.
 */
export async function checkGrant(
  trx: Db,
  grant: RestrictionGrant,
  opts: { now?: number; storedEnd?: Date | null } = {},
): Promise<CheckedGrant> {
  const now = opts.now ?? Date.now();
  const end = grant.expires_at ?? null;
  const unchanged = end !== null && opts.storedEnd?.getTime() === end.getTime();
  if (end && end.getTime() <= now && !unchanged) {
    throw invalid('Choose an end in the future, or none.', 'expires_at');
  }
  const people = [...new Set((grant.people ?? []).map((p) => p.toLowerCase()))];
  const types = [...new Set(grant.types ?? [])];
  const asked = [...new Set((grant.collections ?? []).map((c) => c.toLowerCase()))];
  let collections = asked;
  if (people.length > 0) {
    const found = await trx.selectFrom('member').select('id').where('id', 'in', people).execute();
    if (found.length !== people.length) throw invalid('Choose people from the family.', 'people');
  }
  if (types.length > 0) {
    const found = await trx
      .selectFrom('document_type')
      .select('key')
      .where('key', 'in', types)
      .execute();
    if (found.length !== types.length) {
      throw invalid('Choose kinds of document the family has.', 'types');
    }
  }
  if (asked.length > 0) {
    const found = await trx
      .selectFrom('doc_collection')
      .select(['id', 'name', 'audience', 'deleted_at'])
      .where('id', 'in', asked)
      .orderBy('id')
      .execute();
    if (found.length !== asked.length) {
      throw invalid('Choose collections of the family.', 'collections');
    }
    const live = found.filter((c) => c.deleted_at === null);
    const narrower = live.find((c) => c.audience !== 'everyone');
    if (narrower) throw invalid(ONLY_EVERYONE(narrower.name, narrower.audience), 'collections');
    collections = live.map((c) => c.id);
  }
  return {
    people,
    types,
    collections,
    include_adults_only: grant.include_adults_only ?? false,
    include_no_person_docs: grant.include_no_person_docs ?? false,
    expires_at: end,
    limits_people: grant.limits_people,
    limits_types: grant.limits_types,
  };
}

/** What the activity log says of a grant: how many of each, never which. */
function grantDetail(g: CheckedGrant): Record<string, unknown> {
  return {
    people: g.people.length,
    types: g.types.length,
    collections: g.collections.length,
    include_adults_only: g.include_adults_only,
    include_no_person_docs: g.include_no_person_docs,
    ...(g.expires_at ? { expires_at: g.expires_at.toISOString() } : {}),
  };
}

/**
 * A person's restriction made exactly `grant`, in the caller's transaction:
 * the row (inserted or changed, `reconfirm_since` cleared), then the people,
 * kinds and collections it names. A collection is named before any is taken
 * away, so that each is held (FOR SHARE, 0055) before a grant row is: a
 * change of a collection's audience at the same moment, which holds the
 * collection and then drops its grants, waits for this, or this for it,
 * and never both. Row-level security turns a write it refuses into nothing
 * written: each is counted.
 */
export async function writeGrant(
  trx: Db,
  householdId: string,
  memberId: string,
  grant: CheckedGrant,
  opts: {
    exists: boolean;
    confirmPrivate?: boolean;
    /**
     * Whether it names people, or kinds, at all (`limitsAfter`): kept apart
     * from the rows naming them, so that one deleted since narrows, and the
     * last one gone gives nothing (the 5.32 review, R532-01) — and a save
     * of what is shown never widens it (the 5.33 review).
     */
    limits: { people: boolean; types: boolean };
  },
): Promise<void> {
  const values = {
    include_adults_only: grant.include_adults_only,
    include_no_person_docs: grant.include_no_person_docs,
    expires_at: grant.expires_at,
    limits_people: opts.limits.people || grant.people.length > 0,
    limits_types: opts.limits.types || grant.types.length > 0,
    ...(opts.confirmPrivate ? { private_confirmed_at: new Date() } : {}),
  };
  const written = opts.exists
    ? await trx
        .updateTable('access_restriction')
        .set({ ...values, reconfirm_since: null })
        .where('member_id', '=', memberId)
        .executeTakeFirst()
        .then((r) => Number(r.numUpdatedRows))
    : await trx
        .insertInto('access_restriction')
        .values({ member_id: memberId, household_id: householdId, ...values })
        .executeTakeFirst()
        .then((r) => Number(r.numInsertedOrUpdatedRows ?? 0n));
  if (written !== 1) throw notFound();

  // The collections first: each named, and so held, before any is taken away.
  if (grant.collections.length > 0) {
    try {
      await trx
        .insertInto('access_restriction_collection')
        .values(
          grant.collections.map((c) => ({
            restricted_member_id: memberId,
            household_id: householdId,
            collection_id: c,
          })),
        )
        .onConflict((oc) => oc.columns(['restricted_member_id', 'collection_id']).doNothing())
        .execute();
    } catch (err) {
      // Changed away from Everyone, or deleted, since it was checked (0055).
      if ((err as { code?: string }).code === '23514') {
        throw invalid(
          'A collection you chose is no longer for Everyone in the family. Choose again.',
          'collections',
        );
      }
      throw err;
    }
  }
  let gone = trx
    .deleteFrom('access_restriction_collection')
    .where('restricted_member_id', '=', memberId);
  if (grant.collections.length > 0) gone = gone.where('collection_id', 'not in', grant.collections);
  await gone.execute();

  await trx
    .deleteFrom('access_restriction_member')
    .where('restricted_member_id', '=', memberId)
    .execute();
  await trx
    .deleteFrom('access_restriction_type')
    .where('restricted_member_id', '=', memberId)
    .execute();
  const wrote = async (
    n: Promise<{ numInsertedOrUpdatedRows: bigint | undefined }>,
    want: number,
  ) => {
    if (Number((await n).numInsertedOrUpdatedRows ?? 0n) !== want) throw notFound();
  };
  if (grant.people.length > 0) {
    await wrote(
      trx
        .insertInto('access_restriction_member')
        .values(
          grant.people.map((m) => ({
            restricted_member_id: memberId,
            household_id: householdId,
            member_id: m,
          })),
        )
        .executeTakeFirst(),
      grant.people.length,
    );
  }
  if (grant.types.length > 0) {
    await wrote(
      trx
        .insertInto('access_restriction_type')
        .values(
          grant.types.map((t) => ({
            restricted_member_id: memberId,
            household_id: householdId,
            type_key: t,
          })),
        )
        .executeTakeFirst(),
      grant.types.length,
    );
  }
  // Exactly the collections asked for, as the rules let the caller see them.
  const now = await trx
    .selectFrom('access_restriction_collection')
    .select('collection_id')
    .where('restricted_member_id', '=', memberId)
    .execute();
  if (now.length !== grant.collections.length) throw notFound();
}

export class RestrictionService {
  constructor(
    private readonly db: Db,
    /** Tells a set of accounts something. Returns without waiting. */
    private readonly alert: (input: AlertRequest) => Promise<void> = async () => undefined,
  ) {}

  /**
   * Restricts somebody, or changes their restriction, to exactly `grant`
   * (PUT /members/{id}/access). Owners only. Somebody who keeps Only me
   * documents is restricted only with `confirmPrivate`, and is then told;
   * without it, `409 confirm_private` and nothing changes. A collection not
   * for Everyone is `422` (A17). The same grant again confirms it after
   * their sign-in was given back (`reconfirm_since` cleared).
   */
  async restrict(
    p: Principal,
    memberId: string,
    grant: RestrictionGrant,
    opts: { confirmPrivate?: boolean; meta?: RequestMeta } = {},
  ): Promise<Restricted> {
    requireCapability(p, 'role.change');
    if (!UUID.test(memberId)) throw notFound();
    let tell: { accountId: string; household: string } | null = null;
    const done = await withPrincipal(this.db, p, async (trx) => {
      // 1. The household, as a role change holds it: a change of role at
      // the same moment either lands first, and is seen, or waits.
      await holdHousehold(trx);
      // 2. The person, held, then their sign-in, if any: neither changes under us.
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
      // 3. Their restriction, held.
      const existing = await trx
        .selectFrom('access_restriction')
        .select([
          'member_id',
          'private_confirmed_at',
          'reconfirm_since',
          'include_adults_only',
          'include_no_person_docs',
          'expires_at',
          'limits_people',
          'limits_types',
        ])
        .where('member_id', '=', person.id)
        .forUpdate()
        .executeTakeFirst();
      const checked = await checkGrant(trx, grant, { storedEnd: existing?.expires_at ?? null });
      // Whether it names people, and kinds, once written: an empty list keeps
      // what it says now unless the caller says otherwise (the 5.33 review).
      const limits = {
        people: limitsAfter(checked.people, checked.limits_people, existing?.limits_people),
        types: limitsAfter(checked.types, checked.limits_types, existing?.limits_types),
      };
      // Whether they keep Only me documents, in the Trash too: the database
      // asks the same, and refuses the restriction without a confirmation.
      const keeps = await trx
        .selectFrom('document')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('owner_member_id', '=', person.id)
        .where('visibility', '=', 'private')
        .executeTakeFirstOrThrow();
      const keepsPrivate = keeps.n > 0;
      // Asked once: a restriction already confirmed is changed without asking again.
      const confirmed = existing?.private_confirmed_at != null;
      if (keepsPrivate && !confirmed && !opts.confirmPrivate) {
        throw new ApiError(409, 'confirm_private', CONFIRM_PRIVATE(person.display_name));
      }
      const before = existing ? await this.named(trx, person.id) : null;
      await writeGrant(trx, p.householdId, person.id, checked, {
        exists: existing !== undefined,
        confirmPrivate: keepsPrivate && !confirmed,
        limits,
      });
      // 4. The log, last: made, changed, or the same again — confirmed.
      const changed =
        !existing ||
        !before ||
        existing.include_adults_only !== checked.include_adults_only ||
        existing.include_no_person_docs !== checked.include_no_person_docs ||
        (existing.expires_at?.getTime() ?? null) !== (checked.expires_at?.getTime() ?? null) ||
        // A flag let go widens as much as a person or a kind added.
        existing.limits_people !== limits.people ||
        existing.limits_types !== limits.types ||
        !sameSet(before.people, checked.people) ||
        !sameSet(before.types, checked.types) ||
        !sameSet(before.collections, checked.collections);
      const reconfirmed = existing?.reconfirm_since != null;
      if (!existing || changed || reconfirmed) {
        await appendAudit(trx, {
          householdId: p.householdId,
          actorAccountId: p.accountId,
          action: existing ? 'access.changed' : 'access.restricted',
          objectType: 'member',
          objectId: person.id,
          detail: {
            ...grantDetail(checked),
            ...(limits.people && checked.people.length === 0 ? { limits_people: true } : {}),
            ...(limits.types && checked.types.length === 0 ? { limits_types: true } : {}),
            ...(existing ? { changed } : {}),
            ...(reconfirmed ? { reconfirmed: true } : {}),
            ...(keepsPrivate && !confirmed ? { confirmed_private: true } : {}),
          },
          ip: opts.meta?.ip ?? null,
        });
      }
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

  /**
   * DELETE /members/{id}/access: their limits taken off, and with them any
   * confirmation still waiting (`reconfirm_since`). Owners only. Somebody
   * with none: nothing to do, and nothing logged. A viewer with no limits
   * sees every family document but the Adults only ones.
   */
  async remove(p: Principal, memberId: string, meta: RequestMeta): Promise<{ removed: boolean }> {
    requireCapability(p, 'role.change');
    if (!UUID.test(memberId)) throw notFound();
    return withPrincipal(this.db, p, async (trx) => {
      await holdHousehold(trx);
      const person = await trx
        .selectFrom('member')
        .select(['id'])
        .where('id', '=', memberId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!person) throw notFound();
      await trx
        .selectFrom('account_household')
        .select(['account_id'])
        .where('member_id', '=', person.id)
        .forNoKeyUpdate()
        .execute();
      const existing = await trx
        .selectFrom('access_restriction')
        .select(['member_id'])
        .where('member_id', '=', person.id)
        .forUpdate()
        .executeTakeFirst();
      if (!existing) return { removed: false };
      const gone = await trx
        .deleteFrom('access_restriction')
        .where('member_id', '=', person.id)
        .executeTakeFirst();
      // A rule that quietly removed nothing removed nothing.
      if (Number(gone.numDeletedRows) !== 1) throw notFound();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'access.removed',
        objectType: 'member',
        objectId: person.id,
        ip: meta.ip ?? null,
      });
      return { removed: true };
    });
  }

  /**
   * Somebody's limits as an owner sees them (5.33): null for somebody with
   * none. Owners only — anybody else reads no restriction but their own,
   * and is answered as if there were none to read.
   */
  async access(p: Principal, memberId: string, trx?: Db): Promise<MemberAccess | null> {
    if (p.role !== 'owner' || !UUID.test(memberId)) return null;
    const read = async (t: Db): Promise<MemberAccess | null> => {
      const r = await t
        .selectFrom('access_restriction')
        .select([
          'member_id',
          'include_adults_only',
          'include_no_person_docs',
          'expires_at',
          'reconfirm_since',
          'private_confirmed_at',
          'updated_at',
          'limits_people',
          'limits_types',
        ])
        .where('member_id', '=', memberId)
        .executeTakeFirst();
      if (!r) return null;
      const named = await this.named(t, r.member_id);
      const summaries = await restrictionSummaries(t, p.householdId, [r.member_id]);
      return {
        member_id: r.member_id,
        people: named.people,
        types: named.types,
        collections: named.collections,
        include_adults_only: r.include_adults_only,
        include_no_person_docs: r.include_no_person_docs,
        expires_at: r.expires_at?.toISOString() ?? null,
        limits_people: r.limits_people,
        limits_types: r.limits_types,
        summary: summaries.get(r.member_id)?.summary ?? '',
        reconfirm_since: r.reconfirm_since?.toISOString() ?? null,
        private_confirmed: r.private_confirmed_at !== null,
        updated_at: r.updated_at.toISOString(),
      };
    };
    return trx ? read(trx) : withPrincipal(this.db, p, read);
  }

  /** The people, kinds and collections a restriction names, as ids and keys. */
  private async named(
    trx: Db,
    memberId: string,
  ): Promise<Pick<AccessGrant, 'people' | 'types' | 'collections'>> {
    const [people, types, collections] = await Promise.all([
      trx
        .selectFrom('access_restriction_member')
        .select('member_id')
        .where('restricted_member_id', '=', memberId)
        .orderBy('member_id')
        .execute(),
      trx
        .selectFrom('access_restriction_type')
        .select('type_key')
        .where('restricted_member_id', '=', memberId)
        .orderBy('type_key')
        .execute(),
      // Only those that still grant (for Everyone, not deleted), as the rule
      // and the summary count them: a row left from before is never shown,
      // so never sent back to be refused (the 5.33 review, L533-02).
      trx
        .selectFrom('access_restriction_collection as g')
        .innerJoin('doc_collection as c', 'c.id', 'g.collection_id')
        .select('g.collection_id')
        .where('g.restricted_member_id', '=', memberId)
        .where('c.deleted_at', 'is', null)
        .where('c.audience', '=', 'everyone')
        .orderBy('g.collection_id')
        .execute(),
    ]);
    return {
      people: people.map((r) => r.member_id),
      types: types.map((r) => r.type_key),
      collections: collections.map((r) => r.collection_id),
    };
  }

  /**
   * "They will see 14 documents" (GET /members/{id}/access/preview): a grant
   * not yet saved, counted by the rule itself — 0054's doc_in_grant(),
   * handed the grant as a value — over the household's documents out of
   * the Trash, as the caller is given them. What the person then sees, but
   * for their own Only me documents, which no one else is told the number
   * of (`keeps_private` says there are some). For somebody not yet in the
   * family (an invitation), `memberId` is null: they own nothing yet.
   *
   * An owner's; or an adult's, inviting a viewer, without Adults only
   * documents (A27) — everything else such a grant gives, an adult sees.
   */
  async preview(
    p: Principal,
    memberId: string | null,
    grant: RestrictionGrant,
    opts: {
      /**
       * Whether `keeps_private` may be said: an owner whose session gave a
       * passkey or a code within the last five minutes (the route asks;
       * the 5.33 review, S533-05). Otherwise it is left out.
       */
      tellPrivate?: boolean;
    } = {},
  ): Promise<AccessPreview> {
    if (p.role !== 'owner') {
      if (!can(p.role, 'member.invite')) {
        throw new ApiError(403, 'forbidden', 'Only an owner can limit what someone can see.');
      }
      if (grant.include_adults_only) throw adultsOnlyRefusal();
    }
    if (memberId !== null && !UUID.test(memberId)) throw notFound();
    return withPrincipal(this.db, p, async (trx) => {
      let had:
        { expires_at: Date | null; limits_people: boolean; limits_types: boolean } | undefined;
      if (memberId !== null) {
        const person = await trx
          .selectFrom('member')
          .select(['id', 'display_name'])
          .where('id', '=', memberId)
          .executeTakeFirst();
        if (!person) throw notFound();
        // Only somebody who could be limited (A58): a viewer, or somebody
        // with no sign-in yet. Anybody else is refused as a PUT would be,
        // and nothing is counted of them (the 5.33 review, S533-05).
        const signIn = await trx
          .selectFrom('account_household')
          .select('role')
          .where('member_id', '=', person.id)
          .executeTakeFirst();
        if (signIn && signIn.role !== 'viewer') {
          throw new ApiError(409, 'not_a_viewer', ONLY_VIEWERS(person.display_name));
        }
        // Their limits now, which an owner reads (0054): a PUT keeps their
        // flags, and their end, as the preview counts them.
        had = await trx
          .selectFrom('access_restriction')
          .select(['expires_at', 'limits_people', 'limits_types'])
          .where('member_id', '=', person.id)
          .executeTakeFirst();
      }
      const g = await checkGrant(trx, grant, { storedEnd: had?.expires_at ?? null });
      const limitsPeople = limitsAfter(g.people, g.limits_people, had?.limits_people);
      const limitsTypes = limitsAfter(g.types, g.limits_types, had?.limits_types);
      const counted = await sql<{ n: number }>`
        select count(*)::int as n
          from document d
         where d.deleted_at is null
           and d.visibility in ('household', 'adults')
           and doc_in_grant(
                 row(${g.expires_at === null}::boolean or ${g.expires_at}::timestamptz > now(),
                     ${memberId}::uuid,
                     ${g.include_adults_only}::boolean,
                     ${g.include_no_person_docs}::boolean,
                     ${limitsPeople}::boolean,
                     ${limitsTypes}::boolean,
                     ${g.people}::uuid[],
                     ${g.types}::text[],
                     array(select i.document_id
                             from doc_collection_item i
                             join doc_collection c on c.id = i.collection_id
                            where i.collection_id = any(${g.collections}::uuid[])
                              and c.deleted_at is null
                              and c.audience = 'everyone'))::access_grant,
                 d.id, d.visibility, d.owner_member_id, d.type_key)`.execute(trx);
      const documents = counted.rows[0]?.n ?? 0;
      // Whether they keep Only me documents: an owner's question alone, who
      // is asked to confirm it before they are limited (A59), and only once
      // they have given a passkey or a code (S533-05).
      if (memberId === null || p.role !== 'owner' || !opts.tellPrivate) return { documents };
      const keeps = await trx
        .selectFrom('document')
        .select('id')
        .where('owner_member_id', '=', memberId)
        .where('visibility', '=', 'private')
        .executeTakeFirst();
      return { documents, keeps_private: keeps !== undefined };
    });
  }

  /**
   * `/me.restriction` (5.33): what a restricted viewer is given, in their own
   * words, read as themselves — the people, kinds and collections the
   * database gives them to read (0054), so one deleted since, or a
   * collection no longer for Everyone, is not named. Null for anybody not
   * restricted: only a viewer ever is (A58).
   */
  async mine(p: Principal): Promise<MyRestriction | null> {
    if (!mayBeRestricted(p.role)) return null;
    return withPrincipal(this.db, p, async (trx) => {
      const r = await trx
        .selectFrom('access_restriction')
        .select([
          'include_adults_only',
          'include_no_person_docs',
          'expires_at',
          'limits_people',
          'limits_types',
        ])
        .where('member_id', '=', p.memberId)
        .executeTakeFirst();
      if (!r) return null;
      const [people, types, collections, hh] = await Promise.all([
        trx
          .selectFrom('access_restriction_member as g')
          .innerJoin('member as m', 'm.id', 'g.member_id')
          .select(['m.id', 'm.display_name'])
          .where('g.restricted_member_id', '=', p.memberId)
          .orderBy('m.display_name')
          .orderBy('m.id')
          .execute(),
        trx
          .selectFrom('access_restriction_type as g')
          .innerJoin('document_type as t', 't.key', 'g.type_key')
          .select(['t.key', sql<string>`coalesce(t.short_label, t.label)`.as('label')])
          .where('g.restricted_member_id', '=', p.memberId)
          .orderBy('t.sort_order')
          .orderBy('t.key')
          .execute(),
        trx
          .selectFrom('access_restriction_collection as g')
          .innerJoin('doc_collection as c', 'c.id', 'g.collection_id')
          .select(['c.id', 'c.name'])
          .where('g.restricted_member_id', '=', p.memberId)
          .where('c.deleted_at', 'is', null)
          .where('c.audience', '=', 'everyone')
          .orderBy('c.name')
          .orderBy('c.id')
          .execute(),
        trx
          .selectFrom('household')
          .select('timezone')
          .where('id', '=', p.householdId)
          .executeTakeFirstOrThrow(),
      ]);
      const summary = youCanSee(
        {
          people,
          types,
          collections,
          include_no_person_docs: r.include_no_person_docs,
          expires_at: r.expires_at,
          limits_people: r.limits_people,
          limits_types: r.limits_types,
        },
        hh.timezone,
      );
      return {
        summary,
        people: people.map((m) => ({ id: m.id, display_name: m.display_name })),
        types: types.map((t) => ({ key: t.key, label: t.label })),
        collections: collections.map((c) => ({ id: c.id, name: c.name })),
        include_adults_only: r.include_adults_only,
        include_no_person_docs: r.include_no_person_docs,
        expires_at: r.expires_at?.toISOString() ?? null,
      };
    });
  }
}

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

/** Said to an adult asking for Adults only documents for a viewer (A27, D6). */
export const ADULTS_ONLY_OWNERS = 'Only an owner can let a viewer see Adults only documents.';

const adultsOnlyRefusal = () => new ApiError(403, 'forbidden', ADULTS_ONLY_OWNERS);

/**
 * Each of these people's restriction, in a sentence, for an owner (A55's
 * "After a restore", and the family's list, 5.33): null for somebody with
 * none. Read in the owner's own transaction: an owner reads every
 * restriction of the household (0054).
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
      'r.limits_people',
      'r.limits_types',
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
