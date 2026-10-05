import { appendAudit, withPrincipal, type Db } from '@fdv/db';
import {
  can,
  DECEASED_NO_SIGN_IN,
  GUEST_ONLY_VIEWER,
  guestEndProblem,
  identityAudienceSees,
  mayBeRestricted,
  reducesSight,
  roleLabel,
  ROLES,
  suspensionInEffect,
  type Role,
  type RoleChangeEffectDone,
} from '@fdv/shared';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Principal, RequestMeta } from '../auth/service.js';
import type { Enqueue } from '../documents/service.js';
import { INCOMING_MOVE_JOB } from '../uploads/incoming.js';
import { closeLostRequests } from '../uploads/requests.js';
import { requireCapability } from '../authz.js';
import { ApiError, notFound } from '../errors.js';
import type { AlertRequest } from '../alert-job.js';
import { endDevices, SESSION_ENDED, type PushRequest, type PushTarget } from '../push-job.js';
import { isRestricted, restrictedRefusal } from './restrictions.js';

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
  /** What else it did (5.30): only what happened, `[]` for nothing. */
  effects: RoleChangeEffectDone[];
}

export class CoOwnerService {
  constructor(
    private readonly db: Db,
    /** Tells a set of accounts something. Returns without waiting. */
    private readonly alert: (input: AlertRequest) => Promise<void> = async () => undefined,
    /** Pushes the worker sends (4.13): "you were signed out" to a removed sign-in's phones. */
    private readonly push: (input: PushRequest) => Promise<void> = async () => undefined,
    /** The worker's queue: files sent for somebody who can no longer review them (5.23). */
    private readonly enqueue: Enqueue = async () => undefined,
  ) {}

  /**
   * Somebody can no longer review what was sent to them alone (5.23): once
   * the change has committed, the worker moves their waiting files to the
   * owners (`incoming.move`). Queued after, never inside: run before the
   * change is there to see, it would find them still able to. Its daily
   * sweep does the same, for a job that is lost.
   */
  private async filesMove(householdId: string): Promise<void> {
    await this.enqueue(INCOMING_MOVE_JOB, { household_id: householdId }).catch(() => undefined);
  }

  // ------------------------------------------------------------- changing

  async changeRole(
    p: Principal,
    memberId: string,
    to: Role,
    meta: RequestMeta,
  ): Promise<RoleChangeResult> {
    requireCapability(p, 'role.change');
    const after = { move: false };
    const result = await withPrincipal(this.db, p, async (trx) => {
      await holdHousehold(trx);
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
          effects: [],
        };
      }
      // A guest is a viewer and nothing else (5.34): never made one of the
      // family's roles. The database refuses it too (0056, FDV03).
      if (target.kind === 'guest') {
        throw new ApiError(409, 'guest', GUEST_ONLY_VIEWER(target.display_name));
      }
      // A restriction never stands beside another role (the 5.32 review):
      // their limits come off first. The database refuses it too.
      if (!mayBeRestricted(to) && (await isRestricted(trx, target.member_id))) {
        throw restrictedRefusal(target.display_name);
      }
      // A locked person is not made an owner (5.28): an owner's sign-in is
      // never locked, so it would be one an owner could not lock again. The
      // database refuses it too (account_household_suspension, 0051).
      if (to === 'owner' && suspensionInEffect(target)) {
        throw new ApiError(
          409,
          'locked',
          target.suspend_reason === 'restored'
            ? `${target.display_name}'s sign-in is waiting after a restore. Turn it back on first, then make them an owner.`
            : `${target.display_name}'s sign-in is locked. Unlock it first, then make them an owner.`,
        );
      }

      // Taking the owner role away is the only change that waits.
      if (target.role === 'owner') {
        const request = await this.openRequest(trx, p, target, 'demote', to, meta);
        return {
          applied: false,
          role: target.role,
          request,
          message: `Every owner has been told. ${target.display_name} stays an owner until ${formatDay(request.opens_at)}, and can refuse before then.`,
          effects: [],
        };
      }

      const changed = await trx
        .updateTable('account_household')
        .set({ role: to })
        .where('account_id', '=', target.account_id)
        .where('household_id', '=', p.householdId)
        .executeTakeFirst();
      // A rule that quietly changed nothing is not a change of role.
      if (Number(changed.numUpdatedRows) !== 1) throw notFound('That sign-in');
      // What else it takes away (5.30): the Essentials on their phones, their
      // exports, their requests to send documents (A39) — and what was sent
      // for them alone to review goes to the owners once this commits (5.23).
      const effects = await takeAway(trx, p, target, target.role, to, meta);
      after.move = !can(to, 'upload_request.create');
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'member.role_changed',
        objectType: 'member',
        objectId: memberId,
        detail: { from: target.role, to },
        ip: meta.ip,
      });
      await logEffects(trx, p, target.member_id, effects, meta);

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
        message: [
          `${target.display_name} is now ${article(to)}.`,
          ...effectWords(effects, 'Their'),
        ].join(' '),
        effects,
      };
    });
    if (after.move) await this.filesMove(p.householdId);
    return result;
  }

  /** Giving up the owner role yourself, which needs no notice at all. */
  async stepDown(p: Principal, to: Role, meta: RequestMeta): Promise<RoleChangeResult> {
    if (p.role !== 'owner') {
      throw new ApiError(422, 'validation_failed', 'Only an owner can step down.');
    }
    if (to === 'owner') {
      throw new ApiError(422, 'validation_failed', 'Choose what you want to become instead.');
    }
    const result = await withPrincipal(this.db, p, async (trx) => {
      await holdHousehold(trx);
      const changed = await trx
        .updateTable('account_household')
        .set({ role: to })
        .where('account_id', '=', p.accountId)
        .where('household_id', '=', p.householdId)
        .executeTakeFirst();
      if (Number(changed.numUpdatedRows) !== 1) throw notFound('That sign-in');
      // As for anybody whose role changes (5.30): their own phones'
      // Essentials, their exports, their requests.
      const effects = await takeAway(trx, p, { account_id: p.accountId }, 'owner', to, meta);
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
      await logEffects(trx, p, p.memberId, effects, meta);
      return {
        applied: true,
        role: to,
        message: [
          `You are ${article(to)} now. Another owner can give the role back.`,
          ...effectWords(effects, 'Your'),
        ].join(' '),
        effects,
      };
    });
    if (!can(to, 'upload_request.create')) await this.filesMove(p.householdId);
    return result;
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
      // And their requests to send documents close (A39).
      await closeLostRequests(trx, p.householdId, p.accountId, meta.ip);
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
    await this.filesMove(p.householdId);
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
    /**
     * A guest's sign-in is given back with a new end (5.34, A28): in the
     * future, within a year. Nobody else's has one. The route asks for a
     * passkey or a code when one is sent (`renew_guest`).
     */
    accessExpiresAt: Date | null = null,
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
          'member.kind',
          'account.disabled_at',
        ])
        .where('member.id', '=', memberId)
        .executeTakeFirst();
      if (!member) throw notFound('That person');
      // A guest's comes back as a viewer's, with an end (5.34); nobody else's
      // has one.
      if (member.kind === 'guest') {
        if (role !== 'viewer') {
          throw new ApiError(409, 'guest', GUEST_ONLY_VIEWER(member.display_name));
        }
        const problem = accessExpiresAt
          ? guestEndProblem(accessExpiresAt)
          : 'Choose the day their access ends.';
        if (problem) {
          throw new ApiError(422, 'validation_failed', problem, { detail: 'access_expires_at' });
        }
      } else if (accessExpiresAt) {
        throw new ApiError(
          422,
          'validation_failed',
          'Only a guest’s access ends on a day. Somebody of the family keeps theirs.',
          { detail: 'access_expires_at' },
        );
      }
      // Held, and read as they are once held: nobody signs in as somebody
      // recorded as passed away (5.25), however close together the two are.
      const person = await trx
        .selectFrom('member')
        .select(['is_deceased'])
        .where('id', '=', member.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (person.is_deceased) {
        throw new ApiError(409, 'passed_away', DECEASED_NO_SIGN_IN(member.display_name));
      }
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
      // Given back as anything but a viewer, a restricted person would have a
      // role their restriction never stands beside (the 5.32 review).
      if (!mayBeRestricted(role) && (await isRestricted(trx, member.id))) {
        throw restrictedRefusal(member.display_name);
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
        .values({
          account_id: account,
          household_id: p.householdId,
          member_id: memberId,
          role,
          access_expires_at: member.kind === 'guest' ? accessExpiresAt : null,
        })
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
        detail: {
          role,
          ...(member.kind === 'guest' && accessExpiresAt
            ? { kind: 'guest', access_expires_at: accessExpiresAt.toISOString() }
            : {}),
        },
        ip: meta.ip,
      });
      // Limited while it was away, they are told so now, plainly and with
      // nothing of what is given (A59; the 5.33 review, L533-03): nobody
      // could be told while there was no sign-in to tell.
      const limited = await isRestricted(trx, memberId);
      await this.alert({
        pushType: 'owner_change',
        householdId: p.householdId,
        accountIds: [account],
        subject: 'You can sign in to your family vault again',
        body:
          'Your sign-in has been given back. Use the same email and password as before; your own documents are as you left them.' +
          (limited ? ` ${LIMITED_WORDS}` : ''),
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
      await holdHousehold(trx);
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
      // An adult sees the documents an owner does: only exports that showed
      // identity details they no longer see can end (5.27).
      const effects = await takeAway(
        trx,
        p,
        { account_id: row.target_account },
        'owner',
        'adult',
        meta,
      );
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'member.role_changed',
        objectType: 'member',
        objectId: row.target_member_id,
        detail: { from: 'owner', to: 'adult', via: 'owner_change_request' },
        ip: meta.ip,
      });
      await logEffects(trx, p, row.target_member_id, effects, meta);
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
        message: [`${row.target_name} is an adult now.`, ...effectWords(effects, 'Their')].join(
          ' ',
        ),
        effects,
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
    // Held for the change (5.28): a lock at the same moment waits for this,
    // or this for it, and each sees the other.
    const row = await trx
      .selectFrom('account_household')
      .innerJoin('member', 'member.id', 'account_household.member_id')
      .select([
        'account_household.account_id',
        'account_household.role',
        'account_household.suspended_at',
        'account_household.suspended_until',
        'account_household.suspend_reason',
        'member.display_name',
        'member.id as member_id',
        'member.kind',
      ])
      .where('account_household.member_id', '=', memberId)
      .forNoKeyUpdate('account_household')
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
 * The household, held for as long as a role changes (the 5.27 review): a
 * change of who sees identity details (IdentityService.setAudience) holds it
 * FOR NO KEY UPDATE, so the two take turns, and each reads what the other
 * made. Without it a step-down and a narrowing at the same moment each read
 * the other's old state — the audience as it was, the role as it was — and
 * neither ended the export the person may no longer have. FOR SHARE: two
 * role changes do not wait for each other. Taken first, before any row, as
 * setAudience takes it first; the activity log's lock comes last in both.
 */
/** Said to somebody whose sign-in is given back with limits on it (5.33): nothing of what is given. */
export const LIMITED_WORDS =
  'An owner has limited what you can see in the vault: only the documents they have given you, and your own.';

export async function holdHousehold(trx: Db): Promise<void> {
  await sql`select 1 from household where id = app_household() for share`.execute(trx);
}

/**
 * Whether a role change takes away sight of other people's identity
 * details (5.27): read under the audience in effect now, as the database
 * reads it (identity_audience_now()). Since 5.27 an export holds them, so
 * an owner who becomes an adult under the narrowest audience loses, with
 * their exports, what they no longer see.
 */
async function losesIdentity(trx: Db, from: Role, to: Role): Promise<boolean> {
  const r = await sql<{ a: string | null }>`select identity_audience_now() as a`.execute(trx);
  const audience = r.rows[0]?.a ?? 'owners_and_self';
  return identityAudienceSees(audience, from) && !identityAudienceSees(audience, to);
}

/**
 * An export was built from what its requester could see then. When they
 * can no longer see the adults-only documents — demoted to teen or viewer,
 * or their sign-in taken away — or other people's identity details (5.27),
 * it stops being downloadable, or it would go on handing them what the
 * demotion took away.
 */
async function expireExportsOf(trx: Db, accountId: string): Promise<number> {
  const r = await trx
    .updateTable('export')
    .set({ expires_at: new Date() })
    .where('requested_by', '=', accountId)
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date())]))
    .executeTakeFirst();
  return Number(r.numUpdatedRows);
}

/**
 * What a change of role takes away besides the role itself (5.30), once the
 * role is written, in the order every change takes its locks: the household
 * (FOR SHARE) and the person's membership are held already; then their
 * sessions, their exports, their requests; the activity log's lock last.
 *
 *  - Sight taken away (`reducesSight`: an adult made a teen or a viewer,
 *    anybody made a viewer): the offline grant of every session of theirs
 *    ends, so each phone is given an empty set at its next sync and removes
 *    what it keeps (4.9). Keeping Essentials again takes the password.
 *  - The adults' documents, or identity details, no longer seen: their
 *    exports stop being downloadable (5.27).
 *  - No longer an adult: their requests to send documents close (A39), with
 *    the owner's rights (`upload_requests_close_lost()`), and a line each.
 *
 * Only what happened is answered, each with how many.
 */
async function takeAway(
  trx: Db,
  p: Principal,
  person: { account_id: string },
  from: Role,
  to: Role,
  meta: RequestMeta,
): Promise<RoleChangeEffectDone[]> {
  const effects: RoleChangeEffectDone[] = [];
  if (reducesSight(from, to)) {
    const ended = await trx
      .updateTable('session')
      .set({ offline_granted_at: null, offline_expires_at: null, offline_include_private: false })
      .where('account_id', '=', person.account_id)
      .where('household_id', '=', p.householdId)
      .where('revoked_at', 'is', null)
      .where('offline_expires_at', '>', new Date())
      .executeTakeFirst();
    const n = Number(ended.numUpdatedRows);
    if (n > 0) effects.push({ effect: 'offline_ended', count: n });
  }
  if (!can(to, 'document.see_adults') || (await losesIdentity(trx, from, to))) {
    const n = await expireExportsOf(trx, person.account_id);
    if (n > 0) effects.push({ effect: 'exports_ended', count: n });
  }
  if (!can(to, 'upload_request.create')) {
    const n = await closeLostRequests(trx, p.householdId, p.accountId, meta.ip);
    if (n > 0) effects.push({ effect: 'requests_closed', count: n });
  }
  return effects;
}

/**
 * A line each in the activity log for what a role change ended on the
 * person's phones, and of their requests (5.30): for the owners, the person
 * and whoever did it — never another adult, never a teen (audit/service.ts).
 * The change's own line keeps its audience.
 */
async function logEffects(
  trx: Db,
  p: Principal,
  memberId: string,
  effects: RoleChangeEffectDone[],
  meta: RequestMeta,
): Promise<void> {
  for (const e of effects) {
    if (e.effect === 'exports_ended') continue;
    await appendAudit(trx, {
      householdId: p.householdId,
      actorAccountId: p.accountId,
      action: e.effect === 'offline_ended' ? 'member.offline_ended' : 'member.requests_closed',
      objectType: 'member',
      objectId: memberId,
      detail: e.effect === 'offline_ended' ? { sessions: e.count } : { requests: e.count },
      ip: meta.ip,
    });
  }
}

/** What else a role change did, in sentences: "Their phone removes the Essentials it keeps at its next sync." */
function effectWords(effects: RoleChangeEffectDone[], whose: 'Their' | 'Your'): string[] {
  return effects.map((e) => {
    const n = e.count;
    switch (e.effect) {
      case 'offline_ended':
        return n === 1
          ? `${whose} phone removes the Essentials it keeps at its next sync.`
          : `${whose} phones remove the Essentials they keep at their next sync.`;
      case 'requests_closed':
        return `${whose} ${n === 1 ? 'request' : `${n} requests`} to send documents closed.`;
      case 'exports_ended':
        return `${whose} ${n === 1 ? 'export' : `${n} exports`} stopped working.`;
    }
  });
}
