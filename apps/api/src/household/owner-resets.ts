import { appendAudit, withPrincipal, type Db } from '@fdv/db';
import {
  RESET_LINK_MINUTES,
  resetCommand,
  suspensionInEffect,
  type OwnerResetResult,
  type ResetPath,
  type Role,
} from '@fdv/shared';
import { sql } from 'kysely';
import { z } from 'zod';
import type { AlertRequest } from '../alert-job.js';
import { holdsPrivate, newResetToken, hashResetToken } from '../auth/passwords.js';
import type { Principal, RequestMeta } from '../auth/service.js';
import { requireCapability } from '../authz.js';
import { ApiError } from '../errors.js';
import { endDevices, SESSION_ENDED, type PushRequest, type PushTarget } from '../push-job.js';

/**
 * A password reset an owner starts (5.29, D5, A48–A50, A54).
 *
 * An owner starts a reset for somebody — never their own, never another
 * owner's (A50: one owner taking over another would be a weapon against a
 * spouse), never while they are locked or paused (5.28). It goes one way of
 * three, and no way hands an owner a working credential for somebody who
 * keeps anything private:
 *
 *  1. `mail`: whoever runs the server gave it a mail server (FDV_SMTP_URL).
 *     The link goes to the person's own sign-in address by that server
 *     alone, never the household's (which an owner can point anywhere), as
 *     their own "forgotten password" would. The answer and the activity log
 *     carry no link.
 *  2. `handover`: there is none, and the person keeps nothing private —
 *     nothing under their member key, nothing only they can see (0052's
 *     member_holds_private(), asked here and again as the link is spent).
 *     The owner is shown a one-time link, once, for an hour; the person is
 *     told at their next sign-in.
 *  3. `operator`: anybody else. No owner's way: the answer says to ask
 *     whoever runs the server to run `cli reset-password`.
 *
 * A teen follows the same rule (A49): a teen with anything private is 1 or
 * 3, never 2. `stop_now` makes their current password stop working at once
 * and ends every session of theirs (A48): nobody is given a password, ever;
 * they choose a new one through the link. Spending any reset link signs
 * them out, removes their passkeys, ends their exports and leaves two-step
 * sign-in to be asked (passwords.ts).
 *
 * Every way is a line in the activity log, `member.reset_started`, with the
 * way it went and never a link — for the owners and the person — and the
 * other owners are told.
 *
 * The order it takes its locks in: the person's membership first (FOR NO
 * KEY UPDATE, as a lock takes it), then their reset links, their account
 * and sessions, and the activity log's lock last.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a session ended by `stop_now` says it ended for (endReasonOf: `revoked`). */
export const STOPPED_REVOKED_REASON = 'password stopped';

/** POST /members/{id}/password-reset (5.29). */
export const ownerResetBody = z.object({ stop_now: z.boolean().optional() }).strict();

const noSignIn = () => new ApiError(404, 'not_found', 'They have no sign-in to reset.');

/** The person whose sign-in it is, held. */
interface Held {
  account_id: string;
  member_id: string;
  role: Role;
  suspended_at: Date | null;
  suspended_until: Date | null;
  suspend_reason: 'locked' | 'restored' | null;
  display_name: string;
  email: string;
}

export class OwnerResetService {
  constructor(
    private readonly db: Db,
    /** Where the vault is published, for the link: `/reset#…` (5.17). */
    private readonly linkFor: (token: string) => string,
    /** Whether whoever runs the server has given it a mail server (FDV_SMTP_URL). */
    private readonly operatorMail: boolean,
    /** Tells a set of accounts something. Returns without waiting. */
    private readonly alert: (input: AlertRequest) => Promise<void> = async () => undefined,
    /** "You were signed out", to their phones, after `stop_now` (4.13). */
    private readonly push: (input: PushRequest) => Promise<void> = async () => undefined,
  ) {}

  /**
   * Which way a reset for somebody goes now, for the account card: null
   * for an owner (A50) or somebody locked or paused. Asked in the owner's
   * own transaction (household/service.ts).
   */
  async pathFor(
    trx: Db,
    target: {
      account_id: string;
      role: Role;
      suspended_at: Date | null;
      suspended_until: Date | null;
    },
  ): Promise<ResetPath | null> {
    if (target.role === 'owner' || suspensionInEffect(target)) return null;
    if (this.operatorMail) return 'mail';
    return (await holdsPrivate(trx, target.account_id)) ? 'operator' : 'handover';
  }

  /**
   * The person's membership, held for the change: FOR NO KEY UPDATE, the
   * first lock a reset takes. Somebody with no sign-in, or nobody of the
   * family, is 404.
   */
  private async hold(trx: Db, memberId: string): Promise<Held> {
    if (!UUID.test(memberId)) throw noSignIn();
    const row = await trx
      .selectFrom('account_household')
      .select([
        'account_id',
        'member_id',
        'role',
        'suspended_at',
        'suspended_until',
        'suspend_reason',
      ])
      .where('member_id', '=', memberId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!row) throw noSignIn();
    const person = await trx
      .selectFrom('member')
      .select(['display_name'])
      .where('id', '=', row.member_id)
      .executeTakeFirstOrThrow();
    const account = await trx
      .selectFrom('account')
      .select(['email'])
      .where('id', '=', row.account_id)
      .executeTakeFirstOrThrow();
    return { ...row, display_name: person.display_name, email: account.email };
  }

  /**
   * POST /members/{id}/password-reset. Refused, in order: somebody with no
   * sign-in (404); oneself (422); an owner (409 `owner_notice_required`,
   * A50); somebody locked, or paused after a restore (409 `locked`).
   */
  async start(
    p: Principal,
    memberId: string,
    body: z.infer<typeof ownerResetBody>,
    meta: RequestMeta,
  ): Promise<OwnerResetResult> {
    requireCapability(p, 'member.reset_password');
    const stopNow = body.stop_now === true;
    const told: AlertRequest[] = [];
    let phones: PushTarget[] = [];
    const result = await withPrincipal(this.db, p, async (trx) => {
      // 1. The person, held.
      const target = await this.hold(trx, memberId);
      if (target.account_id === p.accountId) {
        throw new ApiError(
          422,
          'validation_failed',
          'You cannot reset your own password here. Change it in Settings, or use “Forgotten your password?” on the sign-in page.',
        );
      }
      if (target.role === 'owner') {
        throw new ApiError(
          409,
          'owner_notice_required',
          `${target.display_name} is an owner, and one owner's password is never reset by another. Ask for their role to be changed first — that takes seven days, and they are told about it.`,
        );
      }
      if (suspensionInEffect(target)) {
        throw new ApiError(
          409,
          'locked',
          target.suspend_reason === 'restored'
            ? `${target.display_name}'s sign-in is waiting after a restore. Turn it back on first, then reset their password.`
            : `${target.display_name}'s sign-in is locked. Unlock it first, then reset their password.`,
        );
      }
      // Asked of the database's clock, as the link's end is read.
      const now = (await sql<{ now: Date }>`select now() as now`.execute(trx)).rows[0]?.now as Date;

      // 2. Which way: the operator's mail; or, with none, a link to hand
      // over only for somebody who keeps nothing private; or nobody's.
      const path: ResetPath = this.operatorMail
        ? 'mail'
        : (await holdsPrivate(trx, target.account_id))
          ? 'operator'
          : 'handover';

      // 3. Their reset links: a new one retires the old — nobody holds two.
      let token: string | null = null;
      let expiresAt: Date | null = null;
      if (path !== 'operator') {
        await trx
          .updateTable('password_reset')
          .set({ used_at: now })
          .where('account_id', '=', target.account_id)
          .where('used_at', 'is', null)
          .execute();
        token = newResetToken();
        expiresAt = new Date(now.getTime() + RESET_LINK_MINUTES * 60_000);
        const made = await trx
          .insertInto('password_reset')
          .values({
            account_id: target.account_id,
            token_hash: hashResetToken(token),
            issued_by: 'owner',
            household_id: p.householdId,
            issued_by_account: p.accountId,
            handover: path === 'handover',
            expires_at: expiresAt,
            ip: meta.ip ?? null,
          })
          .returning('id')
          .executeTakeFirst();
        // A rule that quietly made nothing is no reset.
        if (!made) throw noSignIn();
      }

      // 4. Their password stops now, and every session of theirs ends (A48).
      let sessions = 0;
      if (stopNow) {
        const cleared = await trx
          .updateTable('account')
          .set({ password_hash: null })
          .where('id', '=', target.account_id)
          .executeTakeFirst();
        if (Number(cleared.numUpdatedRows) !== 1) throw noSignIn();
        const ended = await trx
          .updateTable('session')
          .set({ revoked_at: now, revoked_reason: STOPPED_REVOKED_REASON })
          .where('account_id', '=', target.account_id)
          .where('household_id', '=', p.householdId)
          .where('revoked_at', 'is', null)
          .executeTakeFirst();
        sessions = Number(ended.numUpdatedRows);
        phones = await endDevices(trx, { accountId: target.account_id });
      }

      // 5. The activity log, last: the way it went, never a link.
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'member.reset_started',
        objectType: 'member',
        objectId: target.member_id,
        detail: { path, stop_now: stopNow, sessions },
        ip: meta.ip,
      });

      // 6. Who is told: the person, and the other owners.
      const hh = await trx.selectFrom('household').select(['name']).executeTakeFirstOrThrow();
      const me = await trx
        .selectFrom('member')
        .select(['display_name'])
        .where('id', '=', p.memberId)
        .executeTakeFirst();
      const by = me?.display_name ?? 'An owner';
      const stopped = stopNow
        ? ' Your old password has stopped working, and every device you were signed in on has been signed out.'
        : '';
      if (path === 'mail' && token) {
        // The link, to their own address, by the operator's mail server
        // alone: never the household's, never a push to a lock screen.
        told.push({
          householdId: p.householdId,
          accountIds: [target.account_id],
          subject: 'Setting a new password for your vault',
          body: `${by}, an owner of ${hh.name}, started a password reset for ${target.email}. The link below works once and stops working in an hour.${stopped || ' Until it is used, your password still works.'}`,
          url: this.linkFor(token),
          urlLabel: 'Set a new password',
          emailOnly: true,
          operatorMail: true,
        });
      } else {
        // No secret in it, so the household's mail server may carry it.
        told.push({
          householdId: p.householdId,
          accountIds: [target.account_id],
          subject: `${by} started a password reset for you`,
          body:
            path === 'handover'
              ? `${by}, an owner of ${hh.name}, made a one-time link to set a new password for ${target.email}, to hand to you. It works once, for an hour.${stopped} You will be told about it when you next sign in.`
              : `${by}, an owner of ${hh.name}, asked for the password of ${target.email} to be reset. Whoever runs the vault's server will give you a link to set a new one.${stopped}`,
          emailOnly: true,
        });
      }
      const owners = await trx
        .selectFrom('account_household')
        .select(['account_id'])
        .where('role', '=', 'owner')
        .where('account_id', '!=', p.accountId)
        .execute();
      if (owners.length > 0) {
        const how =
          path === 'mail'
            ? `A link to set a new password went to ${target.display_name}'s own sign-in address.`
            : path === 'handover'
              ? `${by} was given a one-time link to hand to ${target.display_name}.`
              : `Whoever runs the vault's server is to give ${target.display_name} a link.`;
        told.push({
          pushType: 'owner_change',
          householdId: p.householdId,
          accountIds: owners.map((o) => o.account_id),
          subject: `${by} started a password reset for ${target.display_name}`,
          body: `${how}${stopNow ? ` ${target.display_name}'s old password stopped working at once, and they were signed out everywhere.` : ''} If this is a surprise, look at the activity log.`,
        });
      }
      // Asked for before it commits, as a lock's are.
      for (const a of told) await this.alert(a);

      const answer: OwnerResetResult = {
        member_id: target.member_id,
        path,
        stop_now: stopNow,
      };
      if (expiresAt) answer.expires_at = expiresAt.toISOString();
      if (path === 'handover' && token) answer.link = this.linkFor(token);
      if (path === 'operator') answer.command = resetCommand(target.email);
      return answer;
    });

    // Once it has committed: their phones are told they were signed out.
    if (phones.length > 0) {
      await this.push({ householdId: p.householdId, message: SESSION_ENDED, targets: phones });
    }
    return result;
  }
}
