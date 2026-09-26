import { appendAudit, withPrincipal, type Db } from '@fdv/db';
import { can, roleLabel, ROLES, type Role } from '@fdv/shared';
import { z } from 'zod';
import type { Principal, RequestMeta } from '../auth/service.js';
import { requireCapability } from '../authz.js';
import { ApiError, notFound } from '../errors.js';
import type { AlertRequest } from '../alert-job.js';
import { endDevices, SESSION_ENDED, type PushRequest, type PushTarget } from '../push-job.js';

/**
 * Co-owners (SHR-09, SHR-10).
 *
 * Several accounts may hold the owner role with identical powers. Two
 * rules keep that from becoming a way to hurt somebody:
 *
 *  - **At least one owner always remains.** Enforced by a deferred
 *    constraint trigger, not here, because a household with no owner
 *    cannot appoint one and the application is the thing most likely to
 *    be wrong.
 *  - **Taking the owner role off somebody else takes seven days**, during
 *    which they can refuse and everybody is told. A shared vault in a bad
 *    divorce is a real scenario; a one-tap lockout of a spouse would be a
 *    weapon. Promotion is immediate: it only adds powers. Leaving of your
 *    own accord is immediate too, as long as another owner remains.
 */

const NOTICE_DAYS = 7;
/** A request nobody completes stops hanging over the household. */
const LAPSE_DAYS = 30;

export const roleChangeBody = z.object({ role: z.enum(ROLES) }).strict();

export interface OwnerChangeView {
  id: string;
  target_member_id: string;
  target_name: string;
  requested_by_name: string | null;
  action: 'promote' | 'demote';
  requested_at: string;
  opens_at: string;
  lapses_at: string;
  state: 'waiting' | 'ready' | 'refused' | 'withdrawn' | 'completed' | 'lapsed';
  /** True when the caller is the person the request is about. */
  about_me: boolean;
  /** One sentence for whoever is looking at it. */
  summary: string;
}

/** What a role change did, so the client can say the right thing. */
export interface RoleChangeResult {
  applied: boolean;
  role: Role;
  request?: OwnerChangeView;
  message: string;
}

export class CoOwnerService {
  constructor(
    private readonly db: Db,
    /** Tells a set of accounts something. Returns without waiting. */
    private readonly alert: (input: AlertRequest) => Promise<void> = async () => undefined,
    /** Pushes the worker sends (4.13): "you were signed out" to a removed sign-in's phones. */
    private readonly push: (input: PushRequest) => Promise<void> = async () => undefined,
  ) {}

  // ------------------------------------------------------------- changing

  async changeRole(
    p: Principal,
    memberId: string,
    to: Role,
    meta: RequestMeta,
  ): Promise<RoleChangeResult> {
    requireCapability(p, 'role.change');
    return withPrincipal(this.db, p, async (trx) => {
      const target = await this.membership(trx, memberId);
      if (target.account_id === p.accountId) {
        // Changing your own role is either meaningless or a way round the
        // notice period, depending on which way it goes.
        throw new ApiError(
          422,
          'validation_failed',
          'You cannot change your own role. Ask another owner.',
        );
      }
      if (target.role === to) {
        return {
          applied: false,
          role: to,
          message: `${target.display_name} is already ${article(to)}.`,
        };
      }

      // Taking the owner role away is the only change that waits.
      if (target.role === 'owner') {
        const request = await this.openRequest(trx, p, target, 'demote', to, meta);
        return {
          applied: false,
          role: target.role,
          request,
          message: `Every owner has been told. ${target.display_name} stays an owner until ${formatDay(request.opens_at)}, and can refuse before then.`,
        };
      }

      await trx
        .updateTable('account_household')
        .set({ role: to })
        .where('account_id', '=', target.account_id)
        .where('household_id', '=', p.householdId)
        .execute();
      if (!can(to, 'document.see_adults')) await expireExportsOf(trx, target.account_id);
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'member.role_changed',
        objectType: 'member',
        objectId: memberId,
        detail: { from: target.role, to },
        ip: meta.ip,
      });

      if (to === 'owner') {
        // Promotion is immediate and everybody hears about it, because a
        // new owner can change where the family's files are kept.
        const adults = await this.adultAccounts(trx, p.accountId);
        await this.alert({
          pushType: 'owner_change',
          householdId: p.householdId,
          accountIds: adults,
          subject: `${target.display_name} is now an owner`,
          body: `${target.display_name} can now change where your files are kept, who is in the family, and the emergency contacts. If this is a surprise, sign in and look at the activity log.`,
        });
      }
      return {
        applied: true,
        role: to,
        message: `${target.display_name} is now ${article(to)}.`,
      };
    });
  }

  /** Giving up the owner role yourself, which needs no notice at all. */
  async stepDown(p: Principal, to: Role, meta: RequestMeta): Promise<RoleChangeResult> {
    if (p.role !== 'owner') {
      throw new ApiError(422, 'validation_failed', 'Only an owner can step down.');
    }
    if (to === 'owner') {
      throw new ApiError(422, 'validation_failed', 'Choose what you want to become instead.');
    }
    return withPrincipal(this.db, p, async (trx) => {
      await trx
        .updateTable('account_household')
        .set({ role: to })
        .where('account_id', '=', p.accountId)
        .where('household_id', '=', p.householdId)
        .execute();
      if (!can(to, 'document.see_adults')) await expireExportsOf(trx, p.accountId);
      // A request to take the owner role off somebody who has now given it
      // up has nothing left to do — carried out, it would make them an
      // adult, whatever they chose to be, and tell them they had lost a role
      // they gave away. It ends here, as what it is.
      const closed = await trx
        .updateTable('owner_change_request')
        .set({ withdrawn_at: new Date(), withdrawn_by: p.accountId, withdrawn_why: 'stepped_down' })
        .where('target_account', '=', p.accountId)
        .where('refused_at', 'is', null)
        .where('completed_at', 'is', null)
        .where('lapsed_at', 'is', null)
        .where('withdrawn_at', 'is', null)
        .where('lapses_at', '>', new Date())
        .executeTakeFirst();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'member.stepped_down',
        detail: { to, requests_closed: Number(closed.numUpdatedRows) },
        ip: meta.ip,
      });
      return {
        applied: true,
        role: to,
        message: `You are ${article(to)} now. Another owner can give the role back.`,
      };
    });
  }

  /** Takes a person's sign-in away. The person and their documents stay. */
  async removeSignIn(p: Principal, memberId: string, meta: RequestMeta): Promise<void> {
    requireCapability(p, 'member.remove');
    let removedPhones: PushTarget[] = [];
    await withPrincipal(this.db, p, async (trx) => {
      const target = await this.membership(trx, memberId);
      if (target.account_id === p.accountId) {
        throw new ApiError(
          422,
          'validation_failed',
          'To leave the household yourself, step down first and ask another owner.',
        );
      }
      if (target.role === 'owner') {
        throw new ApiError(
          409,
          'owner_notice_required',
          `${target.display_name} is an owner. Ask for their role to be changed first — that takes seven days, and they are told about it.`,
        );
      }
      await trx
        .deleteFrom('account_household')
        .where('account_id', '=', target.account_id)
        .where('household_id', '=', p.householdId)
        .execute();
      await expireExportsOf(trx, target.account_id);
      // Remembered so that the sign-in can be given back to this account,
      // and only to it: their private documents are locked to its password.
      await trx
        .updateTable('member')
        .set({ former_account_id: target.account_id })
        .where('id', '=', memberId)
        .execute();
      // Their sessions end with their membership; the person, their member
      // row and their documents are untouched.
      await trx
        .updateTable('session')
        .set({ revoked_at: new Date(), revoked_reason: 'membership removed' })
        .where('account_id', '=', target.account_id)
        .where('household_id', '=', p.householdId)
        .where('revoked_at', 'is', null)
        .execute();
      // And every device of theirs here: nothing more is pushed to them (4.13).
      removedPhones = await endDevices(trx, { accountId: target.account_id });
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'member.sign_in_removed',
        objectType: 'member',
        objectId: memberId,
        detail: { role: target.role },
        ip: meta.ip,
      });
    });
    if (removedPhones.length > 0) {
      await this.push({
        householdId: p.householdId,
        message: SESSION_ENDED,
        targets: removedPhones,
      });
    }
  }

  /**
   * Gives a removed sign-in back — to the account that had it, never to a
   * new one. The person signs in with their own password, as before, and
   * that password is still what their private documents are locked to.
   * Nothing secret changes hands, which is the point: an invitation would
   * hand a link and a code to whoever made it.
   */
  async restoreSignIn(
    p: Principal,
    memberId: string,
    role: 'adult' | 'teen' | 'viewer',
    meta: RequestMeta,
  ): Promise<{ message: string }> {
    requireCapability(p, 'member.remove');
    return withPrincipal(this.db, p, async (trx) => {
      const member = await trx
        .selectFrom('member')
        .leftJoin('account', 'account.id', 'member.former_account_id')
        .select([
          'member.id',
          'member.display_name',
          'member.former_account_id',
          'account.disabled_at',
        ])
        .where('member.id', '=', memberId)
        .executeTakeFirst();
      if (!member) throw notFound('That person');
      const held = await trx
        .selectFrom('account_household')
        .select(['account_id'])
        .where('member_id', '=', memberId)
        .executeTakeFirst();
      if (held) {
        throw new ApiError(
          409,
          'already_signed_in',
          `${member.display_name} already has a sign-in.`,
        );
      }
      const account = member.former_account_id;
      if (!account || member.disabled_at) {
        throw new ApiError(
          409,
          'no_sign_in_to_restore',
          `${member.display_name} has no sign-in to give back. Invite them instead.`,
        );
      }
      const elsewhere = await trx
        .selectFrom('account_household')
        .select(['member_id'])
        .where('account_id', '=', account)
        .executeTakeFirst();
      if (elsewhere) {
        throw new ApiError(
          409,
          'no_sign_in_to_restore',
          `That sign-in belongs to somebody else in the household now.`,
        );
      }
      await trx
        .insertInto('account_household')
        .values({ account_id: account, household_id: p.householdId, member_id: memberId, role })
        .execute();
      await trx
        .updateTable('member')
        .set({ former_account_id: null })
        .where('id', '=', memberId)
        .execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'member.sign_in_restored',
        objectType: 'member',
        objectId: memberId,
        detail: { role },
        ip: meta.ip,
      });
      await this.alert({
        pushType: 'owner_change',
        householdId: p.householdId,
        accountIds: [account],
        subject: 'You can sign in to your family vault again',
        body: 'Your sign-in has been given back. Use the same email and password as before; your own documents are as you left them.',
        emailOnly: true,
      });
      return {
        message: `${member.display_name} can sign in again with their own password, as ${article(role)}.`,
      };
    });
  }

  // ------------------------------------------------------------- requests

  async list(p: Principal): Promise<OwnerChangeView[]> {
    return withPrincipal(this.db, p, async (trx) => {
      const rows = await this.rows(trx);
      return rows.map((r) => this.view(r, p));
    });
  }

  /** The person a demotion is about says no, and that is the end of it. */
  async refuse(p: Principal, id: string, meta: RequestMeta): Promise<OwnerChangeView> {
    return withPrincipal(this.db, p, async (trx) => {
      const row = (await this.rows(trx)).find((r) => r.id === id);
      if (!row) throw notFound('That request');
      if (row.target_account !== p.accountId) {
        throw new ApiError(
          403,
          'forbidden',
          'Only the person a request is about can refuse it. Any owner can withdraw one.',
        );
      }
      if (row.completed_at || row.refused_at || row.withdrawn_at) {
        throw new ApiError(409, 'already_settled', 'That request has already been settled.');
      }
      if (hasLapsed(row)) {
        throw new ApiError(
          409,
          'request_lapsed',
          'That request lapsed: nothing will happen, so there is nothing to refuse.',
        );
      }
      await this.settle(trx, id, { refused_at: new Date() });
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'owner_change.refused',
        objectType: 'owner_change_request',
        objectId: id,
        ip: meta.ip,
      });
      await this.alert({
        pushType: 'owner_change',
        householdId: p.householdId,
        accountIds: [row.requested_by],
        subject: `${row.target_name} refused the change`,
        body: `${row.target_name} stays an owner of ${row.household_name}.`,
      });
      const after = (await this.rows(trx)).find((r) => r.id === id);
      return this.view(after as OwnerChangeRow, p);
    });
  }

  /** Any owner may withdraw a request they no longer want. */
  async withdraw(p: Principal, id: string, meta: RequestMeta): Promise<void> {
    requireCapability(p, 'role.change');
    await withPrincipal(this.db, p, async (trx) => {
      const row = (await this.rows(trx)).find((r) => r.id === id);
      if (!row) throw notFound('That request');
      if (row.completed_at || row.refused_at || row.withdrawn_at) {
        throw new ApiError(409, 'already_settled', 'That request has already been settled.');
      }
      if (hasLapsed(row)) {
        throw new ApiError(
          409,
          'request_lapsed',
          'That request has lapsed already: nothing will happen.',
        );
      }
      await this.settle(trx, id, {
        withdrawn_at: new Date(),
        withdrawn_by: p.accountId,
        withdrawn_why: 'withdrawn',
      });
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'owner_change.withdrawn',
        objectType: 'owner_change_request',
        objectId: id,
        ip: meta.ip,
      });
    });
  }

  /**
   * Carries out a demotion whose notice period has passed. Deliberately
   * something an owner does rather than something the clock does: seven
   * days later, somebody still has to mean it.
   */
  async complete(p: Principal, id: string, meta: RequestMeta): Promise<RoleChangeResult> {
    requireCapability(p, 'role.change');
    return withPrincipal(this.db, p, async (trx) => {
      const row = (await this.rows(trx)).find((r) => r.id === id);
      if (!row) throw notFound('That request');
      if (row.completed_at || row.refused_at || row.withdrawn_at) {
        throw new ApiError(409, 'already_settled', 'That request has already been settled.');
      }
      if (row.opens_at.getTime() > Date.now()) {
        throw new ApiError(
          409,
          'notice_period',
          `The seven days are not up. This can be carried out on ${formatDay(row.opens_at.toISOString())}.`,
        );
      }
      if (hasLapsed(row)) {
        throw new ApiError(
          409,
          'request_lapsed',
          'That request is too old to carry out. Ask again if you still want to.',
        );
      }
      // Stepping down closes the requests about you; this covers doing it
      // at the same moment as somebody presses "carry it out". The role is
      // read locked, so a step-down in flight either lands first and is
      // seen here, or waits until this is done.
      const current = await trx
        .selectFrom('account_household')
        .select('role')
        .where('account_id', '=', row.target_account)
        .where('household_id', '=', p.householdId)
        .forUpdate()
        .executeTakeFirst();
      if (current?.role !== 'owner') {
        throw new ApiError(
          409,
          'no_longer_owner',
          `${row.target_name} is no longer an owner, so there is nothing to carry out.`,
        );
      }
      // The household may have changed shape in the seven days: the other
      // owner can have stepped down, leaving this one the only one.
      await this.lastOwnerCheck(trx, row.target_account, row.target_name);
      // Claimed before the role changes: a refusal or a withdrawal landing
      // at the same moment wins or loses as a whole, never both.
      await this.settle(trx, id, { completed_at: new Date(), completed_by: p.accountId });
      await trx
        .updateTable('account_household')
        .set({ role: 'adult' })
        .where('account_id', '=', row.target_account)
        .where('household_id', '=', p.householdId)
        .execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'member.role_changed',
        objectType: 'member',
        objectId: row.target_member_id,
        detail: { from: 'owner', to: 'adult', via: 'owner_change_request' },
        ip: meta.ip,
      });
      await this.alert({
        pushType: 'owner_change',
        householdId: p.householdId,
        accountIds: [row.target_account],
        subject: `You are no longer an owner of ${row.household_name}`,
        body: 'You are still an adult in the household: everything day to day is unchanged, and your own private documents are untouched.',
      });
      return {
        applied: true,
        role: 'adult',
        message: `${row.target_name} is an adult now.`,
      };
    });
  }

  // -------------------------------------------------------------- helpers

  /**
   * The household must keep an owner. The database guarantees it with a
   * trigger; this is so that the refusal arrives as a sentence rather
   * than as a failed transaction, and arrives when the person asks
   * rather than seven days later.
   */
  private async lastOwnerCheck(trx: Db, targetAccount: string, name: string): Promise<void> {
    const others = await trx
      .selectFrom('account_household')
      .select(['account_id'])
      .where('role', '=', 'owner')
      .where('account_id', '!=', targetAccount)
      .execute();
    if (others.length === 0) {
      throw new ApiError(
        409,
        'last_owner',
        `${name} is the only owner left. Make somebody else an owner first, and this can go ahead afterwards.`,
      );
    }
  }

  private async openRequest(
    trx: Db,
    p: Principal,
    target: { account_id: string; display_name: string },
    action: 'promote' | 'demote',
    to: Role,
    meta: RequestMeta,
  ): Promise<OwnerChangeView> {
    if (to !== 'adult') {
      // Anything further down can be done once they are an adult, and one
      // notice period per decision is enough.
      throw new ApiError(
        422,
        'validation_failed',
        'An owner can only be made an adult. Change it again afterwards if you need to.',
      );
    }
    await this.lastOwnerCheck(trx, target.account_id, target.display_name);
    const now = Date.now();
    // A request nobody carried out in thirty days has lapsed; until it is
    // recorded as lapsed it still counts as the one live request, and
    // asking again would be refused over something nobody can see.
    await trx
      .updateTable('owner_change_request')
      .set((eb) => ({ lapsed_at: eb.ref('lapses_at') }))
      .where('target_account', '=', target.account_id)
      .where('refused_at', 'is', null)
      .where('completed_at', 'is', null)
      .where('lapsed_at', 'is', null)
      .where('withdrawn_at', 'is', null)
      .where('lapses_at', '<=', new Date(now))
      .execute();
    const alreadyAsked = () =>
      new ApiError(
        409,
        'already_requested',
        `Somebody has already asked for this. It is waiting, and ${target.display_name} has been told.`,
      );
    const existing = await trx
      .selectFrom('owner_change_request')
      .select(['id'])
      .where('target_account', '=', target.account_id)
      .where('refused_at', 'is', null)
      .where('completed_at', 'is', null)
      .where('lapsed_at', 'is', null)
      .where('withdrawn_at', 'is', null)
      .executeTakeFirst();
    if (existing) throw alreadyAsked();
    const row = await trx
      .insertInto('owner_change_request')
      .values({
        household_id: p.householdId,
        target_account: target.account_id,
        requested_by: p.accountId,
        action,
        opens_at: new Date(now + NOTICE_DAYS * 864e5),
        lapses_at: new Date(now + LAPSE_DAYS * 864e5),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
      .catch((err: unknown) => {
        // Two owners asking at the same moment: the database lets one in.
        if ((err as { code?: string }).code === '23505') throw alreadyAsked();
        throw err;
      });
    await appendAudit(trx, {
      householdId: p.householdId,
      actorAccountId: p.accountId,
      action: 'owner_change.requested',
      objectType: 'owner_change_request',
      objectId: row.id,
      detail: { action, target_account: target.account_id },
      ip: meta.ip,
    });

    // Everybody who could be affected hears about it, not only the person
    // it is about: this is the alarm, and it should be loud.
    const owners = await trx
      .selectFrom('account_household')
      .select(['account_id'])
      .where('role', '=', 'owner')
      .execute();
    await this.alert({
      pushType: 'owner_change',
      householdId: p.householdId,
      accountIds: [...new Set(owners.map((o) => o.account_id))],
      subject: `A request to take away ${target.display_name}'s owner role`,
      body: `In seven days ${target.display_name} becomes an adult unless they refuse. Nothing has changed yet, and they can refuse at any time before then.`,
    });

    const made = (await this.rows(trx)).find((r) => r.id === row.id) as OwnerChangeRow;
    return this.view(made, p);
  }

  private async membership(trx: Db, memberId: string) {
    const row = await trx
      .selectFrom('account_household')
      .innerJoin('member', 'member.id', 'account_household.member_id')
      .select([
        'account_household.account_id',
        'account_household.role',
        'member.display_name',
        'member.id as member_id',
      ])
      .where('account_household.member_id', '=', memberId)
      .executeTakeFirst();
    if (!row) throw notFound('That sign-in');
    return row;
  }

  private async adultAccounts(trx: Db, except: string): Promise<string[]> {
    const rows = await trx
      .selectFrom('account_household')
      .select(['account_id'])
      .where('role', 'in', ['owner', 'adult'])
      .execute();
    return rows.map((r) => r.account_id).filter((id) => id !== except);
  }

  /**
   * Ends a request — if it is still open. Refusing, withdrawing and
   * carrying out each read the request first; two of them at the same
   * moment both see it open, and the one that settles it second must not
   * overwrite the first. Whoever loses is told it is settled, and their
   * transaction (with any role change in it) goes no further.
   */
  private async settle(trx: Db, id: string, values: Record<string, unknown>): Promise<void> {
    const done = await trx
      .updateTable('owner_change_request')
      .set(values)
      .where('id', '=', id)
      .where('refused_at', 'is', null)
      .where('completed_at', 'is', null)
      .where('withdrawn_at', 'is', null)
      .where('lapsed_at', 'is', null)
      .executeTakeFirst();
    if (done.numUpdatedRows === 0n) {
      throw new ApiError(409, 'already_settled', 'That request has already been settled.');
    }
  }

  private async rows(trx: Db): Promise<OwnerChangeRow[]> {
    return trx
      .selectFrom('owner_change_request')
      .innerJoin('account_household as target', (j) =>
        j
          .onRef('target.account_id', '=', 'owner_change_request.target_account')
          .onRef('target.household_id', '=', 'owner_change_request.household_id'),
      )
      .innerJoin('member as target_member', 'target_member.id', 'target.member_id')
      .innerJoin('household', 'household.id', 'owner_change_request.household_id')
      .leftJoin('account_household as asker', (j) =>
        j
          .onRef('asker.account_id', '=', 'owner_change_request.requested_by')
          .onRef('asker.household_id', '=', 'owner_change_request.household_id'),
      )
      .leftJoin('member as asker_member', 'asker_member.id', 'asker.member_id')
      .leftJoin('account_household as closer', (j) =>
        j
          .onRef('closer.account_id', '=', 'owner_change_request.withdrawn_by')
          .onRef('closer.household_id', '=', 'owner_change_request.household_id'),
      )
      .leftJoin('member as closer_member', 'closer_member.id', 'closer.member_id')
      .select([
        'owner_change_request.id',
        'owner_change_request.target_account',
        'owner_change_request.requested_by',
        'owner_change_request.action',
        'owner_change_request.requested_at',
        'owner_change_request.opens_at',
        'owner_change_request.lapses_at',
        'owner_change_request.lapsed_at',
        'owner_change_request.refused_at',
        'owner_change_request.completed_at',
        'owner_change_request.withdrawn_at',
        'owner_change_request.withdrawn_by',
        'owner_change_request.withdrawn_why',
        'closer_member.display_name as withdrawn_by_name',
        'target_member.id as target_member_id',
        'target_member.display_name as target_name',
        'asker_member.display_name as requested_by_name',
        'household.name as household_name',
      ])
      .orderBy('owner_change_request.requested_at', 'desc')
      .execute();
  }

  private view(r: OwnerChangeRow, p: Principal): OwnerChangeView {
    const aboutMe = r.target_account === p.accountId;
    const state: OwnerChangeView['state'] = r.completed_at
      ? 'completed'
      : r.refused_at
        ? 'refused'
        : r.withdrawn_at
          ? 'withdrawn'
          : hasLapsed(r)
            ? 'lapsed'
            : r.opens_at.getTime() > Date.now()
              ? 'waiting'
              : 'ready';
    return {
      id: r.id,
      target_member_id: r.target_member_id,
      target_name: r.target_name,
      requested_by_name: r.requested_by_name,
      action: r.action,
      requested_at: r.requested_at.toISOString(),
      opens_at: r.opens_at.toISOString(),
      lapses_at: r.lapses_at.toISOString(),
      state,
      about_me: aboutMe,
      summary: summarise(r, state, aboutMe, p.accountId),
    };
  }
}

interface OwnerChangeRow {
  id: string;
  target_account: string;
  requested_by: string;
  action: 'promote' | 'demote';
  requested_at: Date;
  opens_at: Date;
  lapses_at: Date;
  lapsed_at: Date | null;
  refused_at: Date | null;
  completed_at: Date | null;
  withdrawn_at: Date | null;
  withdrawn_by: string | null;
  withdrawn_why: 'withdrawn' | 'stepped_down' | 'restored' | null;
  withdrawn_by_name: string | null;
  target_member_id: string;
  target_name: string;
  requested_by_name: string | null;
  household_name: string;
}

/**
 * Nobody carried it out in time. Recorded (lapsed_at) when somebody asks
 * again; until then the date says so.
 */
function hasLapsed(r: Pick<OwnerChangeRow, 'lapsed_at' | 'lapses_at'>): boolean {
  return r.lapsed_at !== null || r.lapses_at.getTime() <= Date.now();
}

function summarise(
  r: OwnerChangeRow,
  state: OwnerChangeView['state'],
  aboutMe: boolean,
  me: string,
): string {
  const who = aboutMe ? 'you' : r.target_name;
  const asker = r.requested_by_name ?? 'An owner';
  switch (state) {
    case 'waiting':
      return `${asker} asked for ${who} to stop being an owner. Nothing changes until ${formatDay(r.opens_at.toISOString())}${aboutMe ? ', and you can refuse before then' : ''}.`;
    case 'ready':
      return `The seven days are up. ${who === 'you' ? 'You' : who} can be made an adult now${aboutMe ? ', unless you refuse' : ''}.`;
    case 'refused':
      return `${who === 'you' ? 'You' : who} refused. ${aboutMe ? 'You are' : `${r.target_name} is`} still an owner.`;
    case 'withdrawn':
      if (r.withdrawn_why === 'stepped_down') {
        return `${aboutMe ? 'You' : r.target_name} stepped down, so this no longer applies.`;
      }
      if (r.withdrawn_why === 'restored') {
        return 'Withdrawn when the vault was restored from a backup, so nothing changed.';
      }
      return `${r.withdrawn_by === me ? 'You' : (r.withdrawn_by_name ?? 'An owner')} withdrew it, so nothing changed.`;
    case 'completed':
      return `${who === 'you' ? 'You are' : `${r.target_name} is`} an adult now.`;
    case 'lapsed':
      return 'Nobody carried this out, so it no longer counts.';
  }
}

const article = (role: Role) =>
  `${role === 'owner' || role === 'adult' ? 'an' : 'a'} ${roleLabel(role).toLowerCase()}`;

/** "30 September", in the reader's own words rather than an ISO string. */
function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
}

/**
 * An export was built from what its requester could see then. When they
 * can no longer see the adults-only documents — demoted to teen or viewer,
 * or their sign-in taken away — it stops being downloadable, or it would
 * go on handing them what the demotion took away.
 */
async function expireExportsOf(trx: Db, accountId: string): Promise<void> {
  await trx
    .updateTable('export')
    .set({ expires_at: new Date() })
    .where('requested_by', '=', accountId)
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date())]))
    .execute();
}
