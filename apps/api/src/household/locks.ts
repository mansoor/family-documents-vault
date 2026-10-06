import { appendAudit, withPrincipal, type Db } from '@fdv/db';
import {
  can,
  LOCK_MAX_DAYS,
  LOCK_NOTE_MAX,
  shareEndWords,
  suspensionInEffect,
  type MemberSuspension,
  type PausedSignIn,
  type Role,
  type SignedOutEverywhere,
} from '@fdv/shared';
import { sql } from 'kysely';
import { z } from 'zod';
import type { AlertRequest } from '../alert-job.js';
import type { Principal, RequestMeta } from '../auth/service.js';
import { requireCapability } from '../authz.js';
import type { Enqueue } from '../documents/service.js';
import { endSessions } from '../documents/share-sessions.js';
import { SHARE_PAGES_PRUNE_JOB } from '../documents/shares.js';
import { ApiError } from '../errors.js';
import { endDevices, SESSION_ENDED, type PushRequest, type PushTarget } from '../push-job.js';
import { INCOMING_MOVE_JOB } from '../uploads/incoming.js';
import { holdHousehold, LIMITED_WORDS } from './co-owners.js';
import { isRestricted, restrictionSummaries } from './restrictions.js';

/**
 * Locking a sign-in (5.28, A50–A52).
 *
 * An owner locks somebody's sign-in — never their own, never another
 * owner's (A50): one owner locking out another would be a weapon against a
 * spouse, as taking the owner role away at once would be (co-owners.ts).
 * Asked with a passkey or a code, never the password (A54, the route).
 *
 * A lock, in one transaction (A51):
 *  - their sessions end (the reason `suspended`), and their devices with
 *    them; their phones are told once it commits;
 *  - the invitations they made are taken back, and their reset links used
 *    up;
 *  - their share links and requests to send documents stop answering: each
 *    is live only while its maker's sign-in is not suspended (0051), so
 *    nothing is written onto them, and they come back as they were when the
 *    lock ends. With `end_links` they are taken back instead, for good;
 *  - their exports stop being downloadable;
 *  - a wider audience for identity details still waiting is withdrawn: they
 *    could neither see the notice nor mark anything Only me (5.26);
 *  - a line in the activity log, for the owners and the person (5.6's
 *    table), and the person is emailed — no secret, no note — and the other
 *    owners told.
 * Once it commits, what was sent for them alone to review moves to the
 * owners (`incoming.move`, 5.23).
 *
 * A lock may end by itself (`until`): from then on every read takes it as
 * over (suspensionInEffect), with nothing written; their links and requests
 * answer again at that moment, as after an unlock.
 *
 * Signing somebody out everywhere (5.30, A53) is here too: their sessions
 * and devices end, and nothing else; they sign in again as before.
 *
 * The order every one of these takes its locks in: the person's membership
 * first (FOR NO KEY UPDATE, which their own sign-in, a widening and a
 * reviewer's decision wait for, as they hold it FOR SHARE); then sessions
 * and devices, invitations and reset links, links, requests, exports and
 * notices, in that order; and the activity log's lock last (appendAudit).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 24 * 60 * 60 * 1000;

/** What a session ended by a lock says it ended for (endReasonOf: `suspended`). */
export const LOCKED_REVOKED_REASON = 'sign-in locked';

/** POST /members/{id}/lock (5.28): until when, ending their links for good, a note. */
export const lockBody = z
  .object({
    until: z.string().datetime({ offset: true }).nullable().optional(),
    end_links: z.boolean().optional(),
    note: z
      .string()
      .trim()
      .max(LOCK_NOTE_MAX, `A note can be ${LOCK_NOTE_MAX} characters at most.`)
      .nullable()
      .optional(),
  })
  .strict();

const noSignIn = () => new ApiError(404, 'not_found', 'They have no sign-in to lock.');
const noSignInToEnd = () => new ApiError(404, 'not_found', 'They have no sign-in to sign out.');

/** What a session ended by "Sign out everywhere" says it ended for (endReasonOf: `revoked`). */
export const SIGNED_OUT_EVERYWHERE_REASON = 'signed out everywhere';

/** The person whose sign-in it is, held. */
interface Held {
  account_id: string;
  member_id: string;
  role: Role;
  suspended_at: Date | null;
  suspended_until: Date | null;
  suspend_reason: 'locked' | 'restored' | null;
  display_name: string;
}

export class LockService {
  constructor(
    private readonly db: Db,
    /** Tells a set of accounts something. Returns without waiting. */
    private readonly alert: (input: AlertRequest) => Promise<void> = async () => undefined,
    /** "You were signed out", to the locked person's phones (4.13). */
    private readonly push: (input: PushRequest) => Promise<void> = async () => undefined,
    /** The worker's queue: files sent for them alone to review (5.23); a view-only link's pages. */
    private readonly enqueue: Enqueue = async () => undefined,
  ) {}

  /**
   * The person's membership, held for the change: FOR NO KEY UPDATE, the
   * first lock any of these takes. Somebody with no sign-in, or nobody of
   * the family, is 404.
   */
  private async hold(trx: Db, memberId: string, missing = noSignIn): Promise<Held> {
    if (!UUID.test(memberId)) throw missing();
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
    if (!row) throw missing();
    const person = await trx
      .selectFrom('member')
      .select(['display_name'])
      .where('id', '=', row.member_id)
      .executeTakeFirstOrThrow();
    return { ...row, display_name: person.display_name };
  }

  /** The household's name and clock, for what the person and the owners are told. */
  private async household(trx: Db): Promise<{ name: string; timezone: string }> {
    return trx.selectFrom('household').select(['name', 'timezone']).executeTakeFirstOrThrow();
  }

  /** Every owner but the one asking: told of a lock, and of its end. */
  private async otherOwners(trx: Db, p: Principal): Promise<string[]> {
    const rows = await trx
      .selectFrom('account_household')
      .select(['account_id'])
      .where('role', '=', 'owner')
      .where('account_id', '!=', p.accountId)
      .execute();
    return rows.map((r) => r.account_id);
  }

  /** "Mansoor", the owner asking, by the name the family knows them by. */
  private async nameOf(trx: Db, p: Principal): Promise<string> {
    const me = await trx
      .selectFrom('member')
      .select(['display_name'])
      .where('id', '=', p.memberId)
      .executeTakeFirst();
    return me?.display_name ?? 'An owner';
  }

  /**
   * POST /members/{id}/lock. Refused, in order: somebody with no sign-in
   * (404); oneself (422); an owner (409 `owner_notice_required`, A50);
   * somebody locked already (409 `already_locked`); an end that is not in
   * the future, or more than a year away (422). Somebody paused after a
   * restore may be locked: the lock takes the pause's place.
   */
  async lock(
    p: Principal,
    memberId: string,
    body: z.infer<typeof lockBody>,
    meta: RequestMeta,
  ): Promise<{ member_id: string; suspension: MemberSuspension }> {
    requireCapability(p, 'member.suspend');
    const until = body.until ? new Date(body.until) : null;
    const endLinks = body.end_links === true;
    const note = body.note ? body.note : null;
    const after: {
      memberId: string;
      phones: PushTarget[];
      viewLinks: string[];
      suspension: MemberSuspension | null;
    } = { memberId, phones: [], viewLinks: [], suspension: null };
    await withPrincipal(this.db, p, async (trx) => {
      // 1. The person, held.
      const target = await this.hold(trx, memberId);
      if (target.account_id === p.accountId) {
        throw new ApiError(422, 'validation_failed', 'You cannot lock your own sign-in.');
      }
      if (target.role === 'owner') {
        throw new ApiError(
          409,
          'owner_notice_required',
          `${target.display_name} is an owner, and one owner's sign-in is never locked by another. Ask for their role to be changed first — that takes seven days, and they are told about it.`,
        );
      }
      if (target.suspend_reason === 'locked' && suspensionInEffect(target)) {
        throw new ApiError(
          409,
          'already_locked',
          `${target.display_name}'s sign-in is locked already. Unlock it first to lock it differently.`,
        );
      }
      // Asked of the database's clock, as every read of the lock is.
      const now = (await sql<{ now: Date }>`select now() as now`.execute(trx)).rows[0]?.now as Date;
      if (until !== null) {
        if (until.getTime() <= now.getTime()) {
          throw new ApiError(422, 'validation_failed', 'Choose a time in the future to unlock.');
        }
        if (until.getTime() > now.getTime() + LOCK_MAX_DAYS * DAY) {
          throw new ApiError(
            422,
            'validation_failed',
            'A lock can end by itself within a year at most. Leave the end out to keep it until you unlock it.',
          );
        }
      }
      const locked = await trx
        .updateTable('account_household')
        .set({
          suspended_at: now,
          suspended_by: p.accountId,
          suspended_until: until,
          suspend_reason: 'locked',
          suspend_note: note,
        })
        .where('account_id', '=', target.account_id)
        .where('household_id', '=', p.householdId)
        .executeTakeFirst();
      // A rule that quietly changed nothing is not a lock.
      if (Number(locked.numUpdatedRows) !== 1) throw noSignIn();

      // 2. Their sessions, and every device of theirs here.
      const sessions = await trx
        .updateTable('session')
        .set({ revoked_at: now, revoked_reason: LOCKED_REVOKED_REASON })
        .where('account_id', '=', target.account_id)
        .where('household_id', '=', p.householdId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      after.phones = await endDevices(trx, { accountId: target.account_id });

      // 3. The invitations they made, and their reset links.
      const invitations = await trx
        .updateTable('invitation')
        .set({ revoked_at: now, revoked_by: p.accountId })
        .where('invited_by', '=', target.account_id)
        .where('accepted_at', 'is', null)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      await trx
        .updateTable('password_reset')
        .set({ used_at: now })
        .where('account_id', '=', target.account_id)
        .where('used_at', 'is', null)
        .execute();

      // 4. Their links: paused by the lock itself (0051), or taken back —
      // those still live. One that has run out, or locked itself after ten
      // wrong tries, is left as it is, as a collection's end leaves it
      // (the 5.28 review, E528-4): its history stays true, and no line says
      // a dead link was taken back.
      const links = endLinks
        ? await trx
            .updateTable('share_link')
            .set({ revoked_at: now, revoked_by: p.accountId, code_email: null })
            .where('created_by', '=', target.account_id)
            .where('revoked_at', 'is', null)
            .where('expires_at', '>', now)
            .where('attempts', '<', 10)
            .returning(['id', 'document_id', 'collection_id', 'permission'])
            .execute()
        : [];
      await endSessions(
        trx,
        links.map((l) => l.id),
      );
      after.viewLinks = links.filter((l) => l.permission === 'view').map((l) => l.id);

      // 5. Their requests: paused by the lock itself, or taken back — with
      // the owner's rights, since a review-by-me request is theirs alone.
      const requests = endLinks
        ? (
            await sql<{
              id: string;
            }>`select id from upload_requests_end_for_lock(${target.account_id}) as id`.execute(trx)
          ).rows
        : [];

      // 6. Their exports.
      const exports = await trx
        .updateTable('export')
        .set({ expires_at: now })
        .where('requested_by', '=', target.account_id)
        .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]))
        .executeTakeFirst();

      // 7. A wider audience for identity details still waiting: withdrawn,
      // as they could neither be told nor mark anything Only me (5.26).
      const widening = await trx
        .updateTable('notice_request')
        .set({ withdrawn_at: sql<Date>`now()` })
        .where('kind', '=', 'identity_audience')
        .where('completed_at', 'is', null)
        .where('withdrawn_at', 'is', null)
        .where('notice_until', '>', sql<Date>`now()`)
        .returning(['subject'])
        .executeTakeFirst();
      const audience = widening
        ? (
            await trx
              .selectFrom('household')
              .select(['identity_audience'])
              .executeTakeFirstOrThrow()
          ).identity_audience
        : null;

      // 8. The activity log, last.
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'member.locked',
        objectType: 'member',
        objectId: target.member_id,
        detail: {
          until: until?.toISOString() ?? null,
          end_links: endLinks,
          sessions: Number(sessions.numUpdatedRows),
          invitations: Number(invitations.numUpdatedRows),
          links: links.length,
          requests: requests.length,
          exports: Number(exports.numUpdatedRows),
          ...(widening ? { widening_withdrawn: widening.subject } : {}),
        },
        ip: meta.ip,
      });
      for (const l of links) {
        await appendAudit(trx, {
          householdId: p.householdId,
          actorAccountId: p.accountId,
          action: 'share.revoked',
          ...(l.collection_id !== null
            ? { objectType: 'collection', objectId: l.collection_id }
            : { objectType: 'document', objectId: l.document_id }),
          detail: { share_id: l.id },
          ip: meta.ip,
        });
      }
      for (const r of requests) {
        await appendAudit(trx, {
          householdId: p.householdId,
          actorAccountId: p.accountId,
          action: 'upload_request.revoked',
          objectType: 'upload_request',
          objectId: r.id,
          ip: meta.ip,
        });
      }
      if (widening && audience) {
        // As an owner withdrawing it would: everybody it told reads it.
        await appendAudit(trx, {
          householdId: p.householdId,
          actorAccountId: p.accountId,
          action: 'identity.audience_changed',
          objectType: 'household',
          objectId: p.householdId,
          detail: { from: audience, to: audience, withdrawn: widening.subject },
          ip: meta.ip,
        });
      }

      // 9. Told: the person, by mail, even though locked; the other owners.
      const hh = await this.household(trx);
      const by = await this.nameOf(trx, p);
      const end = until ? ` until ${shareEndWords(until, hh.timezone)} (${hh.timezone})` : '';
      await this.alert({
        householdId: p.householdId,
        accountIds: [target.account_id],
        subject: `Your sign-in to ${hh.name} is locked`,
        body:
          `${by} locked your sign-in${end}. You cannot sign in meanwhile, and every device you ` +
          'were signed in on has been signed out. Your documents are as you left them. If you ' +
          'think this is a mistake, talk to an owner of the family vault.',
        emailOnly: true,
        ownSignIn: true,
      });
      const owners = await this.otherOwners(trx, p);
      if (owners.length > 0) {
        const lent = endLinks
          ? 'Their links and requests to send documents were ended for good.'
          : 'Their links and requests to send documents are paused until the lock ends.';
        const withdrawn = widening
          ? ' Letting more people see identity details, which was waiting, was withdrawn: ask again once everybody can sign in.'
          : '';
        await this.alert({
          pushType: 'owner_change',
          householdId: p.householdId,
          accountIds: owners,
          subject: `${by} locked ${target.display_name}'s sign-in`,
          body: `${target.display_name} cannot sign in${end}, and was signed out everywhere. ${lent}${withdrawn} Any owner can unlock it from ${target.display_name}'s page.`,
        });
      }
      after.memberId = target.member_id;
      after.suspension = {
        reason: 'locked',
        since: now.toISOString(),
        until: until?.toISOString() ?? null,
        note,
        by,
      };
    });
    // Once it has committed: their phones are told, what was sent for them
    // alone to review goes to the owners, and ended view-only links' pages go.
    if (after.phones.length > 0) {
      await this.push({
        householdId: p.householdId,
        message: SESSION_ENDED,
        targets: after.phones,
      });
    }
    await this.enqueue(INCOMING_MOVE_JOB, { household_id: p.householdId }).catch(() => undefined);
    for (const id of after.viewLinks) {
      await this.enqueue(SHARE_PAGES_PRUNE_JOB, {
        household_id: p.householdId,
        share_id: id,
      }).catch(() => undefined);
    }
    return { member_id: after.memberId, suspension: after.suspension as MemberSuspension };
  }

  /**
   * DELETE /members/{id}/lock: the lock ends now. Their links and requests
   * answer again — those not taken back — and they sign in as before.
   * Somebody not locked (never, past its end, or paused after a restore,
   * which `resume` turns back on) is 409 `not_locked`.
   */
  async unlock(p: Principal, memberId: string, meta: RequestMeta): Promise<void> {
    requireCapability(p, 'member.suspend');
    await withPrincipal(this.db, p, async (trx) => {
      const target = await this.hold(trx, memberId);
      if (target.suspend_reason !== 'locked' || !suspensionInEffect(target)) {
        throw new ApiError(409, 'not_locked', `${target.display_name}'s sign-in is not locked.`);
      }
      await this.clear(trx, p, target, 'locked');
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'member.unlocked',
        objectType: 'member',
        objectId: target.member_id,
        detail: { reason: 'locked' },
        ip: meta.ip,
      });
      const hh = await this.household(trx);
      const by = await this.nameOf(trx, p);
      // Limited, they are told so as they come back (L533-03; the Phase 5
      // exit's second round, C-02): perhaps limited while locked.
      const limited = await isRestricted(trx, target.member_id);
      await this.alert({
        householdId: p.householdId,
        accountIds: [target.account_id],
        subject: `Your sign-in to ${hh.name} is unlocked`,
        body:
          `${by} unlocked your sign-in. You can sign in again with your own password, as before.` +
          (limited ? ` ${LIMITED_WORDS}` : ''),
        emailOnly: true,
        ownSignIn: true,
      });
      const owners = await this.otherOwners(trx, p);
      if (owners.length > 0) {
        await this.alert({
          pushType: 'owner_change',
          householdId: p.householdId,
          accountIds: owners,
          subject: `${by} unlocked ${target.display_name}'s sign-in`,
          body: `${target.display_name} can sign in again, and their links and requests to send documents that were paused work again.`,
        });
      }
    });
  }

  /**
   * POST /members/{id}/resume: a sign-in a restore paused, turned back on by
   * an owner (A55) — one tap each in "After a restore". Somebody not paused
   * by a restore is 409 `not_paused`: a lock is unlocked, not resumed.
   */
  async resume(p: Principal, memberId: string, meta: RequestMeta): Promise<void> {
    requireCapability(p, 'restore.review');
    await withPrincipal(this.db, p, async (trx) => {
      const target = await this.hold(trx, memberId);
      if (target.suspend_reason !== 'restored') {
        throw new ApiError(
          409,
          'not_paused',
          `${target.display_name}'s sign-in is not waiting after a restore.`,
        );
      }
      await this.clear(trx, p, target, 'restored');
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'member.unlocked',
        objectType: 'member',
        objectId: target.member_id,
        detail: { reason: 'restored' },
        ip: meta.ip,
      });
      const hh = await this.household(trx);
      const limited = await isRestricted(trx, target.member_id);
      await this.alert({
        householdId: p.householdId,
        accountIds: [target.account_id],
        subject: `You can sign in to ${hh.name} again`,
        body:
          'The vault was restored from a backup, and an owner has turned your sign-in back on. Sign in with your own password, as before.' +
          (limited ? ` ${LIMITED_WORDS}` : ''),
        emailOnly: true,
        ownSignIn: true,
      });
    });
  }

  /**
   * DELETE /members/{id}/sessions (5.30, A53): signs somebody out everywhere
   * — a lost phone, a password somebody else has — and leaves their sign-in
   * as it is: they sign in again with their own password, at once if they
   * like. Owners only, and an owner power (A54, the route). A co-owner too,
   * who is told (A53); anybody it is about is emailed — no push, as their
   * devices go with it — unless their sign-in is locked or paused, which
   * ended their sessions already.
   *
   * Oneself: every other session, as a password change does, and the device
   * asking stays signed in.
   *
   * In one transaction, in the order a role change takes its locks: the
   * household (FOR SHARE, as since 5.27), the person's membership (FOR NO
   * KEY UPDATE), their sessions — each ends, the reason `revoked`, and with
   * it its offline grant — and every device of theirs here; the activity
   * log's lock last. A refresh at the same moment either lands first, and
   * its new token's session ends here, or waits, and finds its session
   * ended. Their phones are told once it commits.
   */
  async signOutEverywhere(
    p: Principal,
    memberId: string,
    meta: RequestMeta,
  ): Promise<SignedOutEverywhere> {
    requireCapability(p, 'member.sign_out');
    const after: {
      phones: PushTarget[];
      told: { accountId: string; owner: boolean; by: string; household: string } | null;
      result: SignedOutEverywhere | null;
    } = { phones: [], told: null, result: null };
    await withPrincipal(this.db, p, async (trx) => {
      // 1. The household, then the person.
      await holdHousehold(trx);
      const target = await this.hold(trx, memberId, noSignInToEnd);
      const self = target.account_id === p.accountId;

      // 2. Their sessions — one's own but this one — and their devices.
      let sessions = trx
        .updateTable('session')
        .set({ revoked_at: new Date(), revoked_reason: SIGNED_OUT_EVERYWHERE_REASON })
        .where('account_id', '=', target.account_id)
        .where('household_id', '=', p.householdId)
        .where('revoked_at', 'is', null);
      if (self) sessions = sessions.where('id', '!=', p.sessionId);
      const ended = Number((await sessions.executeTakeFirst()).numUpdatedRows);
      after.phones = await endDevices(
        trx,
        self
          ? { accountId: target.account_id, exceptSessionId: p.sessionId }
          : { accountId: target.account_id },
      );

      // 3. The activity log, last.
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'member.signed_out_everywhere',
        objectType: 'member',
        objectId: target.member_id,
        detail: { sessions: ended, ...(self ? { self: true } : {}) },
        ip: meta.ip,
      });
      // Told, unless locked or paused: they could not sign in again as the
      // email says, and their sessions ended with the lock already.
      if (!self && !suspensionInEffect(target)) {
        after.told = {
          accountId: target.account_id,
          owner: target.role === 'owner',
          by: await this.nameOf(trx, p),
          household: (await this.household(trx)).name,
        };
      }
      after.result = { member_id: target.member_id, sessions_ended: ended };
    });
    // Once it has committed: their phones, and the person.
    if (after.phones.length > 0) {
      await this.push({
        householdId: p.householdId,
        message: SESSION_ENDED,
        targets: after.phones,
      });
    }
    if (after.told) {
      const { by, household } = after.told;
      await this.alert({
        householdId: p.householdId,
        accountIds: [after.told.accountId],
        subject: `${by} signed you out of ${household} everywhere`,
        body:
          `${by} signed you out on every device you were signed in on. You can sign in again ` +
          'with your own password, and your documents are as you left them. If you did not ' +
          (after.told.owner
            ? `expect this, talk to ${by}, and look at the activity log.`
            : `expect this, talk to ${by}.`),
        emailOnly: true,
      });
    }
    return after.result as SignedOutEverywhere;
  }

  /** The suspension taken off, counted: a rule that changed nothing has changed nothing. */
  private async clear(
    trx: Db,
    p: Principal,
    target: Held,
    reason: 'locked' | 'restored',
  ): Promise<void> {
    const done = await trx
      .updateTable('account_household')
      .set({
        suspended_at: null,
        suspended_by: null,
        suspended_until: null,
        suspend_reason: null,
        suspend_note: null,
      })
      .where('account_id', '=', target.account_id)
      .where('household_id', '=', p.householdId)
      .where('suspend_reason', '=', reason)
      .executeTakeFirst();
    if (Number(done.numUpdatedRows) !== 1) throw noSignIn();
  }

  /**
   * The sign-ins a restore paused (A55), for "After a restore": an owner's
   * to turn back on, one tap each. Anybody else, none: their own is not
   * theirs to decide, and they are not signed in to ask. Each with its role,
   * shown to confirm, and a restricted viewer's restriction in a sentence
   * (5.32), read-only: 5.33 gives owners the screens to change it.
   */
  async paused(p: Principal): Promise<PausedSignIn[]> {
    if (!can(p.role, 'restore.review')) return [];
    return withPrincipal(this.db, p, async (trx) => {
      const rows = await trx
        .selectFrom('account_household')
        .innerJoin('member', 'member.id', 'account_household.member_id')
        .select([
          'account_household.member_id',
          'account_household.role',
          'account_household.suspended_at',
          'member.display_name',
        ])
        .where('account_household.suspend_reason', '=', 'restored')
        .orderBy('member.display_name')
        .orderBy('account_household.member_id')
        .execute();
      const restrictions = await restrictionSummaries(
        trx,
        p.householdId,
        rows.map((r) => r.member_id),
      );
      return rows.map((r) => ({
        member_id: r.member_id,
        display_name: r.display_name,
        role: r.role,
        paused_at: (r.suspended_at as Date).toISOString(),
        restriction: restrictions.get(r.member_id) ?? null,
      }));
    });
  }
}
