import { createHash, randomBytes } from 'node:crypto';
import type { ScopeKeys } from '@fdv/crypto';
import { ANONYMOUS, appendAudit, withPrincipal, withScope, type Db } from '@fdv/db';
import argon2 from 'argon2';
import { sql } from 'kysely';
import { z } from 'zod';
import { RESET_LINK_MINUTES, suspensionInEffect, type ResetNotice } from '@fdv/shared';
import { ApiError } from '../errors.js';
import { stillSignedIn, type Principal, type RequestMeta } from './service.js';
import type { Enqueue } from '../documents/service.js';
import { SHARE_PAGES_PRUNE_JOB } from '../documents/shares.js';
import type { StepUpService } from './step-up.js';
import type { AlertRequest } from '../alert-job.js';
import { endDevices, SESSION_ENDED, type PushRequest, type PushTarget } from '../push-job.js';

/**
 * Changing a password, and forgetting one.
 *
 * Both are complicated by the key hierarchy rather than by the password
 * itself. A member's scope key — the one that opens their *Only me*
 * documents — is wrapped twice: once by the master key, and once by a key
 * derived from their password. So a password that changes has to take the
 * second wrap with it, or the person would keep their documents and lose
 * the ability to open them with what they know.
 *
 * Two routes in, and the difference matters:
 *
 *  - **With the current password**, the scope key is unwrapped with the
 *    old credential and rewrapped with the new one. The master key is
 *    never involved.
 *  - **Without it** — a reset, or somebody who signs in with a passkey and
 *    never knew a password — the scope key comes from the master key and
 *    is given a fresh credential wrap. This is the path the design has in
 *    mind when it lists "password reset that does not destroy the
 *    archive" as something backend encryption buys.
 *
 * And one thing an owner never gets: **a working way into somebody
 * else's account while they keep anything private.** They could then sign
 * in as that person and read their private documents, which is the one
 * thing the privacy wall exists to prevent. A forgotten password is
 * answered by email to the address the account already has, or by
 * whoever runs the server — who holds the master key and can read
 * everything anyway. Since 5.29 an owner may *start* a reset
 * (household/owner-resets.ts): mailed to the person's own address by the
 * operator's mail server, or, with none, handed over only for somebody who
 * keeps nothing private — asked again here as the link is spent.
 *
 * Every reset spent ends the person's exports too (5.29), whoever started
 * it: an export is everything they could see, in one file.
 */

const ARGON2: argon2.HashOptions & { raw?: false } = {
  type: argon2.argon2id,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
};

/** Short, because it is a way into an account and nothing else. */
export const RESET_TTL_MINUTES = RESET_LINK_MINUTES;

const password = z.string().min(10, 'Use at least 10 characters.').max(1024);

export const changeBody = z
  .object({
    /** Omitted by someone who proved themselves with a passkey instead. */
    current_password: z.string().min(1).max(1024).optional(),
    new_password: password,
  })
  .strict();

export const forgotBody = z
  .object({ email: z.string().trim().toLowerCase().email().max(254) })
  .strict();

export const resetBody = z.object({ password }).strict();

/** A reset link's secret: base64url of 32 bytes, or what an old link carried. */
const linkToken = z.string().min(16).max(256);

/**
 * What the page sends to show whose account it is (5.17): the token it read
 * from the link's fragment, in a body — never in a path, where a proxy on
 * the way would see it.
 */
export const lookupBody = z.object({ token: linkToken }).strict();

/** Spending the link (5.17): its token and the new password, both in the body. */
export const completeBody = z.object({ token: linkToken, password }).strict();

export interface ResetPreview {
  household_name: string | null;
  email: string;
  /** True when an owner or the operator made it, rather than the person. */
  issued_by_operator: boolean;
  /** Who made it (5.29): the person, whoever runs the server, or an owner. */
  issued_by: 'self' | 'operator' | 'owner';
  expires_at: string;
}

/** What is kept of a reset link's secret: its hash, never the secret. */
export const hashResetToken = (token: string) =>
  createHash('sha256').update(token, 'utf8').digest();
const hashToken = hashResetToken;

/** A reset link's secret: 32 random bytes, base64url. */
export const newResetToken = () => randomBytes(32).toString('base64url');

const gone = () =>
  new ApiError(
    404,
    'reset_not_valid',
    'That link is not valid any more. Ask for a new one from the sign-in page.',
  );

export interface NewReset {
  token: string;
  expiresAt: Date;
  email: string;
}

export class PasswordService {
  constructor(
    private readonly db: Db,
    private readonly keys: ScopeKeys,
    private readonly stepUp: StepUpService | null,
    /** Where the vault is published, for the link in the email. */
    private readonly baseUrl: string,
    /** Sends the link. Returns without waiting; failures are the worker's. */
    private readonly alert: (input: AlertRequest) => Promise<void> = async () => undefined,
    /** Whether whoever runs the server has given it a mail server (FDV_SMTP_URL). */
    private readonly operatorMail = false,
    /** Pushes the worker sends (4.13): "you were signed out" to the phones of ended sessions. */
    private readonly push: (input: PushRequest) => Promise<void> = async () => undefined,
    /** The worker's queue: an ended view-only link's pages go (5.29, as a lock's). */
    private readonly enqueue: Enqueue = async () => undefined,
  ) {}

  // -------------------------------------------------------- changing one

  async change(p: Principal, input: z.infer<typeof changeBody>, meta: RequestMeta): Promise<void> {
    const account = await this.db
      .selectFrom('account')
      .select(['id', 'password_hash'])
      .where('id', '=', p.accountId)
      .executeTakeFirstOrThrow();

    const ref = { householdId: p.householdId, kind: 'member' as const, memberId: p.memberId };
    let method: string;
    let phones: PushTarget[] = [];

    if (input.current_password) {
      if (
        !account.password_hash ||
        !(await argon2.verify(account.password_hash, input.current_password))
      ) {
        throw new ApiError(401, 'invalid_credentials', "That isn't your current password.");
      }
      if (input.current_password === input.new_password) {
        throw new ApiError(
          422,
          'validation_failed',
          'That is the password you already have. Choose a different one.',
        );
      }
      method = 'current_password';
    } else {
      // No current password offered. That is allowed only for somebody who
      // has just proved who they are some other way — a passkey, a code —
      // which is exactly what step-up is. Without it this would be a way
      // to take over a session that was left open.
      if (!this.stepUp) throw new ApiError(401, 'invalid_credentials', 'Enter your password.');
      await this.stepUp.require(p, 'change_password');
      method = 'step_up';
    }

    const hash = await argon2.hash(input.new_password, ARGON2);
    let removed: SinceHandover = { since: null, passkeys: 0, twoStep: false };
    let links: EndedLink[] = [];
    await withPrincipal(this.db, p, async (trx) => {
      // The person's membership first, FOR NO KEY UPDATE, as a reset, a
      // stopped password and a lock take it (5.29): a passkey, two-step
      // sign-in or another change from a session this change ends waits for
      // it, then finds that session ended (stillSignedIn).
      await trx
        .selectFrom('account_household')
        .select(['member_id'])
        .where('account_id', '=', p.accountId)
        .where('household_id', '=', p.householdId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      // From a session still live (5.29): a reset or a stopped password that
      // ended it while this waited is not undone by it.
      await stillSignedIn(trx, p);
      await trx
        .updateTable('account')
        .set({ password_hash: hash, password_changed_at: sql<Date>`now()` })
        .where('id', '=', p.accountId)
        .execute();
      // Whoever spent a link an owner was handed chose a password, and could
      // add a passkey or two-step sign-in with it (5.29): every change takes
      // away each one added since, so none outlasts the person's own.
      removed = await takeAwaySinceHandover(trx, p.accountId, 'change');
      // The member key follows the password, or the person keeps their
      // private documents and loses the way into them.
      if (input.current_password) {
        await this.keys.rewrapCredential(trx, ref, input.current_password, input.new_password);
      } else {
        await this.keys.attachCredential(trx, ref, input.new_password);
      }
      // Every other device is signed out. A password change is the thing
      // people do when they think somebody else has it.
      await trx
        .updateTable('session')
        .set({ revoked_at: new Date(), revoked_reason: 'password changed' })
        .where('account_id', '=', p.accountId)
        .where('id', '!=', p.sessionId)
        .where('revoked_at', 'is', null)
        .execute();
      // This device stays signed in, but keeps no Essentials without the
      // new password (0.4.13).
      await trx
        .updateTable('session')
        .set({ offline_granted_at: null, offline_expires_at: null, offline_include_private: false })
        .where('id', '=', p.sessionId)
        .execute();
      // And they stop being told things there. Devices registered before
      // 0.4.2 name no session, so they go too; the phones hear once this commits.
      phones = await endDevices(trx, { accountId: p.accountId, exceptSessionId: p.sessionId });
      // And the share links made as them since a hand-over link was spent:
      // whoever spent it could make one as them (5.29).
      links = await endHandoverLinks(trx, p.accountId);
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'auth.password_changed',
        detail: {
          method,
          ...(removed.since
            ? {
                passkeys_removed: removed.passkeys,
                two_step_removed: removed.twoStep,
                links_removed: links.length,
              }
            : {}),
        },
        ip: meta.ip,
      });
      await auditEndedLinks(trx, p.householdId, p.accountId, links, meta);
    });
    // The other devices' phones: "you were signed out" (4.13).
    if (phones.length > 0)
      await this.push({ householdId: p.householdId, message: SESSION_ENDED, targets: phones });
    await this.prunePages(p.householdId, links);

    await this.alert({
      householdId: p.householdId,
      accountIds: [p.accountId],
      subject: 'Your vault password was changed',
      body: 'If that was you, there is nothing to do. If it was not, whoever did it is signed in — ask another owner to take away that sign-in, and tell them to look at the activity log.',
      emailOnly: true,
    });
  }

  // ------------------------------------------------------- forgetting one

  /**
   * Answers the same way whether or not the address is known. A sign-in
   * page that says "no such account" is an account-enumeration endpoint
   * with extra steps.
   */
  async forgot(email: string, meta: RequestMeta): Promise<void> {
    const account = await this.db
      .selectFrom('account')
      .select(['id', 'email', 'disabled_at'])
      .where('email', '=', email)
      .executeTakeFirst();
    if (!account || account.disabled_at) return;

    // Whoever typed the address is nobody the vault knows.
    const membership = await withScope(
      this.db,
      { accountId: account.id, actor: ANONYMOUS },
      (trx) =>
        trx
          .selectFrom('account_household')
          .select(['household_id', 'suspended_at', 'suspended_until'])
          .orderBy('joined_at', 'desc')
          .executeTakeFirst(),
    );
    if (!membership) return;
    // Locked, or paused after a restore (5.28): no link either — a lock
    // used up the ones they had — and the page answers as ever.
    if (suspensionInEffect(membership)) return;

    // The link is a way into this person's private documents, so it only
    // travels by a mail server nobody else in the family can redirect:
    // the operator's own, or the household's when this person is the one
    // owner who controls it. Otherwise nothing is sent — the answer on the
    // page is the same either way — and the operator's command line is
    // the way back.
    const route = this.operatorMail
      ? 'operator'
      : (await this.onlyOwner(account.id, membership.household_id))
        ? 'household'
        : null;
    if (!route) return;

    const reset = await this.issue(account.id, 'self', meta);
    await this.alert({
      householdId: membership.household_id,
      accountIds: [account.id],
      subject: 'Setting a new password for your vault',
      body: `Somebody asked to set a new password for ${account.email}. The link below works once and stops working in an hour. If that was not you, ignore this — nothing has changed, and your password still works.`,
      url: this.linkFor(reset.token),
      urlLabel: 'Set a new password',
      // Never a push: a lock screen is a poor place for a link that opens
      // an account.
      emailOnly: true,
      ...(route === 'operator' ? { operatorMail: true } : {}),
    });
  }

  /** Is this the household's only owner — the one person who controls its mail? */
  private async onlyOwner(accountId: string, householdId: string): Promise<boolean> {
    const owners = await withScope(this.db, { householdId, actor: ANONYMOUS }, (trx) =>
      trx
        .selectFrom('account_household')
        .select(['account_id'])
        .where('role', '=', 'owner')
        .execute(),
    );
    return owners.length === 1 && owners[0]?.account_id === accountId;
  }

  /**
   * Mints a reset. Shared with the operator command line, which prints
   * the link instead of sending it — the only route that works when a
   * household has no mail server, and the only one available to the
   * person who runs the server.
   */
  async issue(
    accountId: string,
    issuedBy: 'self' | 'operator',
    meta: RequestMeta = {},
  ): Promise<NewReset> {
    const token = newResetToken();
    const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60_000);
    const account = await this.db
      .selectFrom('account')
      .select(['email'])
      .where('id', '=', accountId)
      .executeTakeFirstOrThrow();
    // A new one retires the old: nobody holds two live links.
    await this.db
      .updateTable('password_reset')
      .set({ used_at: new Date() })
      .where('account_id', '=', accountId)
      .where('used_at', 'is', null)
      .execute();
    await this.db
      .insertInto('password_reset')
      .values({
        account_id: accountId,
        token_hash: hashToken(token),
        issued_by: issuedBy,
        expires_at: expiresAt,
        ip: meta.ip ?? null,
      })
      .execute();
    return { token, expiresAt, email: account.email };
  }

  /** What the person sees before they type a new password. */
  async preview(token: string): Promise<ResetPreview> {
    const row = await this.live(token);
    const account = await this.db
      .selectFrom('account')
      .select(['email'])
      .where('id', '=', row.account_id)
      .executeTakeFirstOrThrow();
    const membership = await withScope(
      this.db,
      { accountId: row.account_id, actor: ANONYMOUS },
      (trx) =>
        trx
          .selectFrom('account_household')
          .select(['household_id'])
          .orderBy('joined_at', 'desc')
          .executeTakeFirst(),
    );
    const household = membership
      ? await withScope(
          this.db,
          { householdId: membership.household_id, actor: ANONYMOUS },
          (trx) => trx.selectFrom('household').select(['name']).executeTakeFirst(),
        )
      : null;
    return {
      household_name: household?.name ?? null,
      email: account.email,
      // Somebody else made it: whoever runs the server, or an owner (5.29).
      issued_by_operator: row.issued_by !== 'self',
      issued_by: row.issued_by,
      expires_at: row.expires_at.toISOString(),
    };
  }

  /**
   * Spends the link. Deliberately does not sign anybody in: an account
   * with two-step sign-in switched on must still be asked for the code,
   * and a reset that handed back a session would walk straight past it.
   *
   * One transaction, in the order every reset takes its locks (5.29): the
   * person's membership first (FOR NO KEY UPDATE, as a lock and an owner's
   * reset take it, and as whatever makes them keep something private waits
   * for it: 0052), then the link, which is claimed once — two people racing
   * the same link cannot both spend it — then their sessions, passkeys and
   * exports, and the activity log's lock last.
   *
   * A link an owner was handed (5.29, path 2) is asked again here whether
   * the person keeps anything private now, or has become an owner: if so it
   * is used up, nothing else changes, and it answers as every dead link
   * does — saying nothing of why.
   */
  async reset(token: string, newPassword: string, meta: RequestMeta): Promise<{ email: string }> {
    const row = await this.live(token);
    const account = await this.db
      .selectFrom('account')
      .select(['id', 'email'])
      .where('id', '=', row.account_id)
      .executeTakeFirstOrThrow();
    const membership = await withScope(
      this.db,
      { accountId: account.id, actor: ANONYMOUS },
      (trx) =>
        trx
          .selectFrom('account_household')
          .select(['household_id', 'member_id'])
          .orderBy('joined_at', 'desc')
          .executeTakeFirst(),
    );
    if (!membership) throw gone();

    const hash = await argon2.hash(newPassword, ARGON2);
    let resetPhones: PushTarget[] = [];
    let handedOver = false;
    let handedBy: string | null = null;
    let endedLinks: EndedLink[] = [];
    // A reset signs nobody in, so it is not the account asking even now; the
    // account it is for is named, for what the database asks of it (0052).
    const scope = {
      householdId: membership.household_id,
      accountId: account.id,
      actor: ANONYMOUS,
    };
    const outcome = await withScope(this.db, scope, async (trx) => {
      // 1. The person's membership, held.
      const held = await trx
        .selectFrom('account_household')
        .select(['member_id', 'role'])
        .where('account_id', '=', account.id)
        .where('household_id', '=', membership.household_id)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!held) return 'gone' as const;
      // 2. The link, claimed, at this transaction's moment: what ends their
      // exports below asks for a reset spent by this very transaction.
      const claimed = await trx
        .updateTable('password_reset')
        .set({ used_at: sql<Date>`now()` })
        .where('id', '=', row.id)
        .where('used_at', 'is', null)
        .where('expires_at', '>', sql<Date>`now()`)
        .returning(['issued_by', 'handover'])
        .executeTakeFirst();
      if (!claimed) return 'gone' as const;
      // 3. A link an owner was handed: still nobody with anything private,
      // and still nobody an owner may not reset (A50). Otherwise spent, and
      // nothing more.
      if (claimed.handover) {
        if (held.role === 'owner' || (await holdsPrivate(trx, account.id))) {
          return 'refused' as const;
        }
      }
      // Two-step sign-in turned on since a link an owner was handed was
      // spent goes (5.29), as every passkey goes below — but not one turned
      // on after a change of the password, which the person may have made.
      await takeAwaySinceHandover(trx, account.id, 'reset');
      await trx
        .updateTable('account')
        .set({
          password_hash: hash,
          // A link an owner was handed (5.29): from now, what is added to
          // this sign-in goes at the next change of its password.
          ...(claimed.handover ? { handover_spent_at: sql<Date>`now()` } : {}),
        })
        .where('id', '=', account.id)
        .execute();
      if (claimed.handover && row.issued_by_account) {
        const owner = await trx
          .selectFrom('account_household')
          .innerJoin('member', 'member.id', 'account_household.member_id')
          .select(['member.display_name'])
          .where('account_household.account_id', '=', row.issued_by_account)
          .where('account_household.household_id', '=', membership.household_id)
          .executeTakeFirst();
        handedBy = owner?.display_name ?? null;
      }
      handedOver = claimed.handover;
      // No old password to unwrap with, so the member key comes back
      // through the master key and is given a fresh credential wrap.
      await this.keys.attachCredential(
        trx,
        { householdId: membership.household_id, kind: 'member', memberId: held.member_id },
        newPassword,
      );
      // Everything signs out. Whoever asked for this could not get in, and
      // anybody who *was* in is the reason they are asking.
      await trx
        .updateTable('session')
        .set({ revoked_at: new Date(), revoked_reason: 'password reset' })
        .where('account_id', '=', account.id)
        .where('revoked_at', 'is', null)
        .execute();
      resetPhones = await endDevices(trx, { accountId: account.id });
      // And every passkey. A reset is what somebody does when they cannot
      // get in, or fear somebody else can; a passkey added from a borrowed
      // session would otherwise outlast it. They are added again in a tap.
      await trx
        .deleteFrom('credential')
        .where('account_id', '=', account.id)
        .where('kind', '=', 'passkey')
        .execute();
      // And the share links made as them since a hand-over link was spent
      // (5.29), whoever spends this one.
      endedLinks = await endHandoverLinks(trx, account.id);
      // And their exports (5.29): everything they could see, in one file, is
      // not left for whoever spent the link — their own, an owner's or the
      // command line's.
      const exports = await sql<{
        n: number;
      }>`select password_reset_expire_exports(${account.id}) as n`.execute(trx);
      await appendAudit(trx, {
        householdId: membership.household_id,
        actorAccountId: account.id,
        action: 'auth.password_reset',
        detail: { issued_by: row.issued_by, exports: Number(exports.rows[0]?.n ?? 0) },
        ip: meta.ip,
      });
      await auditEndedLinks(trx, membership.household_id, account.id, endedLinks, meta);
      return 'done' as const;
    });
    // A link used up because they keep something private now commits as
    // used up, and is answered as any dead link: nothing says why.
    if (outcome !== 'done') throw gone();
    await this.prunePages(membership.household_id, endedLinks);
    if (resetPhones.length > 0) {
      await this.push({
        householdId: membership.household_id,
        message: SESSION_ENDED,
        targets: resetPhones,
      });
    }

    await this.alert({
      householdId: membership.household_id,
      accountIds: [account.id],
      subject: 'Your vault password was reset',
      // A link an owner was handed (5.29) never went by email: whoever spent
      // it had it from the owner, so the person is told that, and what to do.
      body: handedOver
        ? `${handedBy ?? 'An owner'}, an owner of your family vault, was given a one-time link for your sign-in, and it has been used to set a new password. Every device has been signed out and every passkey removed. If you did not choose that password yourself, set one of your own in Settings when you next sign in — that also removes any passkey or two-step sign-in added since — and talk to them.`
        : 'Somebody used a reset link to set a new password, and every device has been signed out. If that was not you, whoever did it can read your email — deal with that first.',
      emailOnly: true,
    });
    return { email: account.email };
  }

  // ------------------------------------------- an owner's link, told of

  /**
   * That an owner made a link to hand over for this sign-in (5.29, path 2),
   * until the person says they saw it: told at their next sign-in, and every
   * one after until then. The newest, by the owner's name as it is now.
   */
  async notice(p: Principal): Promise<ResetNotice | null> {
    return withPrincipal(this.db, p, async (trx) => {
      const row = await trx
        .selectFrom('password_reset')
        .select(['created_at', 'issued_by_account'])
        .where('account_id', '=', p.accountId)
        .where('household_id', '=', p.householdId)
        .where('handover', '=', true)
        .where('told_at', 'is', null)
        .orderBy('created_at', 'desc')
        .executeTakeFirst();
      if (!row) return null;
      const by = row.issued_by_account
        ? await trx
            .selectFrom('account_household')
            .innerJoin('member', 'member.id', 'account_household.member_id')
            .select(['member.display_name'])
            .where('account_household.account_id', '=', row.issued_by_account)
            .executeTakeFirst()
        : undefined;
      // What was added to this sign-in since such a link was spent (5.29):
      // whoever spent it could have added it, and the next change of the
      // password takes it away.
      const added = await addedSinceHandover(trx, p.accountId);
      return {
        by: by?.display_name ?? null,
        at: row.created_at.toISOString(),
        spent_at: added.since,
        passkeys_since: added.passkeys,
        two_step_since: added.twoStep,
        links_since: added.links,
      };
    });
  }

  /**
   * GET /me's `handover_since` (5.29): when a link an owner was handed for
   * this sign-in was last spent, if ever. Every password change takes away
   * each passkey and two-step sign-in added since, and says so.
   */
  async handoverSince(p: Principal): Promise<string | null> {
    const row = await this.db
      .selectFrom('account')
      .select(['handover_spent_at'])
      .where('id', '=', p.accountId)
      .executeTakeFirst();
    return row?.handover_spent_at?.toISOString() ?? null;
  }

  /** DELETE /me/reset-notice: they have seen it. Nothing to see is as good. */
  async noticeSeen(p: Principal): Promise<void> {
    await withPrincipal(this.db, p, (trx) =>
      trx
        .updateTable('password_reset')
        .set({ told_at: sql<Date>`now()` })
        .where('account_id', '=', p.accountId)
        .where('household_id', '=', p.householdId)
        .where('handover', '=', true)
        .where('told_at', 'is', null)
        .execute(),
    );
  }

  /** An ended view-only link's pages go (5.29), as a lock's do. */
  private async prunePages(householdId: string, links: EndedLink[]): Promise<void> {
    for (const l of links) {
      if (l.permission !== 'view') continue;
      await this.enqueue(SHARE_PAGES_PRUNE_JOB, {
        household_id: householdId,
        share_id: l.id,
      }).catch(() => undefined);
    }
  }

  /**
   * The address a reset link points at, in the email and from the command
   * line: `/reset#<token>` (5.17). What follows the `#` is sent to no
   * server, so neither the vault nor a proxy on the way sees the secret; the
   * page reads it, takes it out of the address bar and this tab's history,
   * and posts it. The browser's own history of visited pages still records
   * the link as it arrived, and no page can take it out of that: what keeps
   * a reset link safe is that it works once, and for an hour.
   */
  linkFor(token: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}/reset#${token}`;
  }

  private async live(token: string) {
    const row = await this.db
      .selectFrom('password_reset')
      .selectAll()
      .where('token_hash', '=', hashToken(token))
      .executeTakeFirst();
    if (!row) throw gone();
    if (row.used_at) throw gone();
    if (row.expires_at.getTime() < Date.now()) throw gone();
    return row;
  }
}

/**
 * Whether somebody keeps anything private (0052's member_holds_private()):
 * yes or no, never what. Asked by an owner starting a reset, and as a
 * link handed to one is spent; anything but a plain "no" is a yes.
 */
export async function holdsPrivate(trx: Db, accountId: string): Promise<boolean> {
  const r = await sql<{
    held: boolean | null;
  }>`select member_holds_private(${accountId}) as held`.execute(trx);
  return r.rows[0]?.held !== false;
}

/** What a password change or a reset took away since a hand-over link was spent (5.29). */
interface SinceHandover {
  since: Date | null;
  passkeys: number;
  twoStep: boolean;
}

/**
 * Each passkey and two-step sign-in added to this sign-in since a link an
 * owner was handed for it was last spent (0052's handover_spent_at), taken
 * away (5.29): whoever spent the link chose the password, and could have
 * added them. Asked at every change of the password and every reset, not
 * only the first: an owner could change it first, add a passkey, and then
 * hand the person a password. The person's own added since go too, and are
 * added again in a tap.
 */
async function takeAwaySinceHandover(
  trx: Db,
  accountId: string,
  at: 'change' | 'reset',
): Promise<SinceHandover> {
  const account = await trx
    .selectFrom('account')
    .select(['handover_spent_at', 'totp_confirmed_at', 'password_changed_at'])
    .where('id', '=', accountId)
    .executeTakeFirstOrThrow();
  const since = account.handover_spent_at;
  if (!since) return { since: null, passkeys: 0, twoStep: false };
  const passkeys = await trx
    .deleteFrom('credential')
    .where('account_id', '=', accountId)
    .where('kind', '=', 'passkey')
    .where('created_at', '>', since)
    .executeTakeFirst();
  // A change takes away two-step sign-in turned on since the hand-over. A
  // reset takes it away only if it was turned on before any change of the
  // password since then (5.29, the second round): one the person turned on
  // after setting their own password is what keeps a mailed link, spent by
  // whoever reads their mail, from being enough — a reset leaves two-step
  // sign-in to be asked for.
  const changedSince = account.password_changed_at;
  const twoStep =
    account.totp_confirmed_at !== null &&
    account.totp_confirmed_at > since &&
    (at === 'change' || changedSince === null || account.totp_confirmed_at < changedSince);
  if (twoStep) {
    await trx
      .updateTable('account')
      .set({ totp_secret: null, totp_confirmed_at: null })
      .where('id', '=', accountId)
      .execute();
  }
  return { since, passkeys: Number(passkeys.numDeletedRows), twoStep };
}

/** A share link a change or a reset ended (5.29), for the log and its pages. */
interface EndedLink {
  id: string;
  document_id: string | null;
  collection_id: string | null;
  permission: string;
}

/**
 * The share links made as somebody since a link an owner was handed for
 * their sign-in was spent, ended (0052's handover_links_end, 5.29): whoever
 * spent it could make one as them, and a link lives while its maker can see
 * what it is to — Only me documents they make later included.
 */
async function endHandoverLinks(trx: Db, accountId: string): Promise<EndedLink[]> {
  const r = await sql<EndedLink>`select * from handover_links_end(${accountId})`.execute(trx);
  return r.rows;
}

/** A line each, as taking a link back writes one: about its document, or its collection. */
async function auditEndedLinks(
  trx: Db,
  householdId: string,
  accountId: string,
  links: EndedLink[],
  meta: RequestMeta,
): Promise<void> {
  for (const l of links) {
    await appendAudit(trx, {
      householdId,
      actorAccountId: accountId,
      action: 'share.revoked',
      ...(l.collection_id !== null
        ? { objectType: 'collection', objectId: l.collection_id }
        : { objectType: 'document', objectId: l.document_id }),
      detail: { share_id: l.id },
      ip: meta.ip,
    });
  }
}

/** What was added since a hand-over link was spent, for the person to see (5.29). */
async function addedSinceHandover(
  trx: Db,
  accountId: string,
): Promise<{
  since: string | null;
  passkeys: Array<{ label: string | null; added_at: string }>;
  twoStep: string | null;
  links: Array<{ title: string | null; made_at: string }>;
}> {
  const account = await trx
    .selectFrom('account')
    .select(['handover_spent_at', 'totp_confirmed_at'])
    .where('id', '=', accountId)
    .executeTakeFirstOrThrow();
  const since = account.handover_spent_at;
  if (!since) return { since: null, passkeys: [], twoStep: null, links: [] };
  // The links made as them since, still live: each goes at the next change.
  const links = await trx
    .selectFrom('share_link')
    .leftJoin('document', 'document.id', 'share_link.document_id')
    .leftJoin('doc_collection', 'doc_collection.id', 'share_link.collection_id')
    .select([
      'share_link.created_at',
      'document.title as document_title',
      'doc_collection.name as collection_name',
    ])
    .where('share_link.created_by', '=', accountId)
    .where('share_link.created_at', '>', since)
    .where('share_link.revoked_at', 'is', null)
    .where('share_link.expires_at', '>', sql<Date>`now()`)
    .where('share_link.attempts', '<', 10)
    .orderBy('share_link.created_at')
    .execute();
  const passkeys = await trx
    .selectFrom('credential')
    .select(['label', 'created_at'])
    .where('account_id', '=', accountId)
    .where('kind', '=', 'passkey')
    .where('created_at', '>', since)
    .orderBy('created_at')
    .execute();
  return {
    since: since.toISOString(),
    passkeys: passkeys.map((k) => ({ label: k.label, added_at: k.created_at.toISOString() })),
    twoStep:
      account.totp_confirmed_at && account.totp_confirmed_at > since
        ? account.totp_confirmed_at.toISOString()
        : null,
    links: links.map((l) => ({
      title: l.document_title ?? l.collection_name ?? null,
      made_at: l.created_at.toISOString(),
    })),
  };
}
