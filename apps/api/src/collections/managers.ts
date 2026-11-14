import { appendAudit, withPrincipal, type Db } from '@fdv/db';
import {
  inCollectionAudience,
  suspensionInEffect,
  type CollectionAudience,
  type CollectionManager,
  type CollectionManagerCandidate,
  type CollectionManagers,
  type CollectionPowers,
  type Role,
} from '@fdv/shared';
import { sql } from 'kysely';
import type { AlertRequest } from '../alert-job.js';
import type { Principal, RequestMeta } from '../auth/service.js';
import { requireCapability } from '../authz.js';
import { ApiError } from '../errors.js';
import type { CollectionService } from './service.js';

/** The family, who may manage a collection and see its managers: never a viewer or a guest. */
export const ofTheFamily = (p: Principal) =>
  !p.guest && (p.role === 'owner' || p.role === 'adult' || p.role === 'teen');

/**
 * Who manages a collection besides its maker (0.9.0, the owner's decision of
 * 13 Nov 2026; 0095).
 *
 * - **Its maker chooses them**, or a manager its maker let choose managers;
 *   such a manager gives another only what they may do themselves (a switch
 *   they have not got is `403`), and never takes the maker away — the maker
 *   is no manager at all: they may do everything already.
 * - **A manager is somebody who can see it already**: of the family, with a
 *   sign-in whose role is in its audience. Anybody else is `422`, in words;
 *   an Only me collection has none. So a manager never sees more than they
 *   did: a collection never widens who sees a document.
 * - **What each may do** is three switches, each off unless turned on:
 *   change who it is for, delete it, choose managers. Every manager may
 *   always put documents in and take them out, the checklist, its name and
 *   its words (CollectionService).
 * - **Every change is a line in the log**, about the collection, naming the
 *   person — `collection.manager_added`, `_changed`, `_removed` — for whoever
 *   may see the collection, the person among them. The maker is told, by an
 *   alert (email), when somebody else makes a person a manager.
 * - **Who manages it is the family's to know** who see the collection
 *   (owners, adults and teens); a viewer or a guest it is given to is told
 *   nobody, and the database gives them no row (0095).
 *
 * Each change is made to the collection held (FOR UPDATE), as every change
 * to it is, so a change of who it is for and a new manager never cross.
 */

const forTheFamily = () =>
  new ApiError(403, 'forbidden', 'A collection’s managers are for the family who see it.');
const notAManager = () =>
  new ApiError(404, 'not_found', 'That person doesn’t manage this collection.');
const theMaker = () =>
  new ApiError(
    422,
    'validation_failed',
    'The person who made this collection can already do everything with it, and can’t be taken away.',
    { detail: 'member_id' },
  );
const cannotManage = (name: string | null) =>
  new ApiError(
    422,
    'validation_failed',
    `${name ?? 'That person'} can’t manage this collection: only someone in the family with a sign-in who can already see it can.`,
    { detail: 'member_id' },
  );
const alreadyManages = (name: string) =>
  new ApiError(409, 'conflict', `${name} already manages this collection.`);
const onlyWhatYouMay = () =>
  new ApiError(403, 'forbidden', 'You can only let a manager do what you can do yourself.');

/** The three switches, as their columns. */
const SWITCHES = ['may_change_audience', 'may_delete', 'may_choose_managers'] as const;
type Switch = (typeof SWITCHES)[number];
type Switches = Record<Switch, boolean>;

/** Which of the caller's powers a switch asks of them. */
const POWER_OF: Record<Switch, keyof CollectionPowers> = {
  may_change_audience: 'change_audience',
  may_delete: 'delete',
  may_choose_managers: 'choose_managers',
};

export interface ManagerInput {
  member_id?: string | undefined;
  may_change_audience?: boolean | undefined;
  may_delete?: boolean | undefined;
  may_choose_managers?: boolean | undefined;
}

export class ManagerService {
  constructor(
    private readonly db: Db,
    private readonly collections: CollectionService,
    private readonly alert: (a: AlertRequest) => Promise<unknown>,
  ) {}

  /** Its managers, and — for a caller who may choose them — who else could be one. */
  async list(p: Principal, id: string): Promise<CollectionManagers> {
    if (!ofTheFamily(p)) throw forTheFamily();
    return withPrincipal(this.db, p, async (trx) => {
      const { row, powers } = await this.collections.seenWith(trx, p, id);
      return this.answer(trx, row, powers);
    });
  }

  /**
   * Somebody made a manager, with the switches asked for (each off unless
   * said): by its maker, or a manager who may choose managers and has each
   * switch they give.
   */
  async add(
    p: Principal,
    id: string,
    input: ManagerInput,
    meta: RequestMeta,
  ): Promise<CollectionManagers> {
    requireCapability(p, 'collection.manage');
    if (!ofTheFamily(p)) throw forTheFamily();
    const memberId = input.member_id;
    if (!memberId) {
      throw new ApiError(422, 'validation_failed', 'Choose who will manage it.', {
        detail: 'member_id',
      });
    }
    const asked: Switches = {
      may_change_audience: input.may_change_audience === true,
      may_delete: input.may_delete === true,
      may_choose_managers: input.may_choose_managers === true,
    };
    const { answer, tell } = await withPrincipal(this.db, p, async (trx) => {
      const { row, powers } = await this.collections.heldFor(trx, p, id, 'managers');
      if (memberId.toLowerCase() === row.owner_member_id?.toLowerCase()) throw theMaker();
      const person = await this.person(trx, memberId);
      if (!person || !mayManage(person, row.audience)) throw cannotManage(person?.name ?? null);
      const there = await trx
        .selectFrom('doc_collection_manager')
        .select('member_id')
        .where('collection_id', '=', row.id)
        .where('member_id', '=', person.id)
        .executeTakeFirst();
      if (there) throw alreadyManages(person.name);
      if (!powers.maker) {
        for (const s of SWITCHES) if (asked[s] && !powers[POWER_OF[s]]) throw onlyWhatYouMay();
      }
      await trx
        .insertInto('doc_collection_manager')
        .values({
          collection_id: row.id,
          household_id: p.householdId,
          member_id: person.id,
          ...asked,
          added_by: p.accountId,
        })
        .execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'collection.manager_added',
        objectType: 'collection',
        objectId: row.id,
        detail: { member_id: person.id, ...asked },
        ip: meta.ip,
      });
      // Its maker is told when somebody else makes a person a manager.
      const maker =
        !powers.maker && row.owner_member_id
          ? await trx
              .selectFrom('account_household')
              .select('account_id')
              .where('household_id', '=', p.householdId)
              .where('member_id', '=', row.owner_member_id)
              .executeTakeFirst()
          : undefined;
      const actor = await trx
        .selectFrom('member')
        .select('display_name')
        .where('id', '=', p.memberId)
        .executeTakeFirst();
      return {
        answer: await this.answer(trx, row, powers),
        tell: maker
          ? {
              accountId: maker.account_id,
              actor: actor?.display_name ?? 'Somebody',
              person: person.name,
            }
          : null,
      };
    });
    if (tell) {
      // Never the collection's name: it is information ("Divorce"), and an
      // email is read anywhere. The vault, and its activity log, say which.
      await this.alert({
        householdId: p.householdId,
        accountIds: [tell.accountId],
        subject: 'Someone else now manages one of your collections',
        body:
          `${tell.actor} made ${tell.person} a manager of one of the collections you made. ` +
          'Open Collections in the family vault to see who manages it and what each of them can ' +
          'do. You can take a manager away there at any time.',
        emailOnly: true,
      });
    }
    return answer;
  }

  /** What a manager may do, changed: a switch given only by somebody who has it. */
  async update(
    p: Principal,
    id: string,
    memberId: string,
    input: ManagerInput,
    meta: RequestMeta,
  ): Promise<CollectionManagers> {
    requireCapability(p, 'collection.manage');
    if (!ofTheFamily(p)) throw forTheFamily();
    return withPrincipal(this.db, p, async (trx) => {
      const { row, powers } = await this.collections.heldFor(trx, p, id, 'managers');
      if (memberId.toLowerCase() === row.owner_member_id?.toLowerCase()) throw theMaker();
      const was = await trx
        .selectFrom('doc_collection_manager')
        .select(['member_id', ...SWITCHES])
        .where('collection_id', '=', row.id)
        .where('member_id', '=', memberId)
        .forUpdate()
        .executeTakeFirst();
      if (!was) throw notAManager();
      const now: Switches = {
        may_change_audience: input.may_change_audience ?? was.may_change_audience,
        may_delete: input.may_delete ?? was.may_delete,
        may_choose_managers: input.may_choose_managers ?? was.may_choose_managers,
      };
      if (SWITCHES.every((s) => now[s] === was[s])) return this.answer(trx, row, powers);
      if (!powers.maker) {
        for (const s of SWITCHES) {
          if (now[s] && !was[s] && !powers[POWER_OF[s]]) throw onlyWhatYouMay();
        }
      }
      await trx
        .updateTable('doc_collection_manager')
        .set(now)
        .where('collection_id', '=', row.id)
        .where('member_id', '=', was.member_id)
        .execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'collection.manager_changed',
        objectType: 'collection',
        objectId: row.id,
        detail: { member_id: was.member_id, ...now },
        ip: meta.ip,
      });
      return this.answer(trx, row, powers);
    });
  }

  /** A manager taken away: by its maker, or a manager who may choose managers. Never the maker. */
  async remove(p: Principal, id: string, memberId: string, meta: RequestMeta): Promise<void> {
    requireCapability(p, 'collection.manage');
    if (!ofTheFamily(p)) throw forTheFamily();
    await withPrincipal(this.db, p, async (trx) => {
      const { row } = await this.collections.heldFor(trx, p, id, 'unmanage');
      if (memberId.toLowerCase() === row.owner_member_id?.toLowerCase()) throw theMaker();
      const gone = await trx
        .deleteFrom('doc_collection_manager')
        .where('collection_id', '=', row.id)
        .where('member_id', '=', memberId)
        .returning('member_id')
        .executeTakeFirst();
      if (!gone) throw notAManager();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'collection.manager_removed',
        objectType: 'collection',
        objectId: row.id,
        detail: { member_id: gone.member_id },
        ip: meta.ip,
      });
    });
  }

  // -------------------------------------------------------------- internals

  /** Somebody of the household, with their sign-in's role and any lock on it. */
  private async person(trx: Db, memberId: string): Promise<Candidate | undefined> {
    const found = await trx
      .selectFrom('member as m')
      .leftJoin('account_household as ah', (j) =>
        j.onRef('ah.member_id', '=', 'm.id').onRef('ah.household_id', '=', 'm.household_id'),
      )
      .select([
        'm.id',
        'm.display_name',
        'm.kind',
        'ah.role',
        'ah.suspended_at',
        'ah.suspended_until',
      ])
      .where('m.id', '=', memberId)
      .executeTakeFirst();
    return found
      ? {
          id: found.id,
          name: found.display_name,
          kind: found.kind,
          role: found.role ?? null,
          suspended_at: found.suspended_at ?? null,
          suspended_until: found.suspended_until ?? null,
        }
      : undefined;
  }

  /** The managers as they are now, and who else could be one for a caller who may choose. */
  private async answer(
    trx: Db,
    row: { id: string; audience: CollectionAudience; owner_member_id: string | null },
    powers: CollectionPowers,
  ): Promise<CollectionManagers> {
    const items: CollectionManager[] = (
      await trx
        .selectFrom('doc_collection_manager as m')
        .innerJoin('member as who', 'who.id', 'm.member_id')
        .select([
          'm.member_id',
          'who.display_name',
          'm.may_change_audience',
          'm.may_delete',
          'm.may_choose_managers',
          'm.added_at',
        ])
        .where('m.collection_id', '=', row.id)
        .orderBy(sql`lower(who.display_name)`)
        .orderBy('m.member_id')
        .execute()
    ).map((m) => ({ ...m, added_at: m.added_at.toISOString() }));
    let eligible: CollectionManagerCandidate[] = [];
    if (powers.choose_managers) {
      const managing = new Set(items.map((i) => i.member_id));
      const people = await trx
        .selectFrom('member as m')
        .innerJoin('account_household as ah', (j) =>
          j.onRef('ah.member_id', '=', 'm.id').onRef('ah.household_id', '=', 'm.household_id'),
        )
        .select([
          'm.id',
          'm.display_name',
          'm.kind',
          'ah.role',
          'ah.suspended_at',
          'ah.suspended_until',
        ])
        .orderBy(sql`lower(m.display_name)`)
        .orderBy('m.id')
        .execute();
      eligible = people
        .filter(
          (m) => m.id !== row.owner_member_id && !managing.has(m.id) && mayManage(m, row.audience),
        )
        .map((m) => ({ member_id: m.id, display_name: m.display_name }));
    }
    return { items, eligible, my_powers: powers };
  }
}

/** Somebody who might be made a manager, as `mayManage` asks. */
interface Candidate {
  id: string;
  name: string;
  kind: string;
  role: Role | null;
  suspended_at: Date | null;
  suspended_until: Date | null;
}

/**
 * Whether somebody may be made a manager of a collection for `audience`: of
 * the family, signed in, in it — and their sign-in not locked or paused
 * (0051), as the database asks too (doc_collection_manager_rule).
 */
function mayManage(
  person: Pick<Candidate, 'kind' | 'role' | 'suspended_at' | 'suspended_until'>,
  audience: CollectionAudience,
): boolean {
  return (
    person.kind === 'family' &&
    person.role !== null &&
    audience !== 'only_me' &&
    inCollectionAudience(person.role, audience) &&
    !suspensionInEffect(person)
  );
}

/**
 * The collections member `memberId` manages now, by id: read before their
 * role changes or their sign-in is taken away (M1 of the managers review),
 * so that each one the database then drops (account_household_drops_managers)
 * is a line of its own in the log, in the same transaction.
 */
export async function managedBy(trx: Db, memberId: string): Promise<string[]> {
  return (
    await trx
      .selectFrom('doc_collection_manager')
      .select('collection_id')
      .where('member_id', '=', memberId)
      .orderBy('collection_id')
      .execute()
  ).map((r) => r.collection_id);
}

/**
 * Each collection `memberId` managed before (`managedBy`) and no longer does:
 * `collection.manager_removed`, `why` the role that changed or the sign-in
 * that went, by whoever changed it.
 */
export async function logManagersDropped(
  trx: Db,
  p: Principal,
  memberId: string,
  before: string[],
  why: 'role' | 'sign_in',
  meta: RequestMeta,
): Promise<void> {
  if (before.length === 0) return;
  const now = new Set(await managedBy(trx, memberId));
  for (const collectionId of before.filter((c) => !now.has(c))) {
    await appendAudit(trx, {
      householdId: p.householdId,
      actorAccountId: p.accountId,
      action: 'collection.manager_removed',
      objectType: 'collection',
      objectId: collectionId,
      detail: { member_id: memberId, why },
      ip: meta.ip,
    });
  }
}
