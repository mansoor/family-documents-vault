import { createHash, randomBytes } from 'node:crypto';
import type { ScopeKeys } from '@fdv/crypto';
import { appendAudit, withScope, type Db } from '@fdv/db';
import argon2 from 'argon2';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import type { Principal, RequestMeta } from './service.js';
import type { StepUpService } from './step-up.js';
import type { AlertRequest } from '../alert-job.js';

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
 * And one route deliberately missing: **an owner cannot reset another
 * member's password.** They could then sign in as that person and read
 * their private documents, which is the one thing the privacy wall exists
 * to prevent. A forgotten password is answered by email to the address
 * the account already has, or by whoever runs the server — who holds the
 * master key and can read everything anyway.
 */

const ARGON2: argon2.HashOptions & { raw?: false } = {
  type: argon2.argon2id,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
};

/** Short, because it is a way into an account and nothing else. */
export const RESET_TTL_MINUTES = 60;

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

export interface ResetPreview {
  household_name: string | null;
  email: string;
  /** True when an owner or the operator made it, rather than the person. */
  issued_by_operator: boolean;
  expires_at: string;
}

const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest();

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
    await withScope(this.db, { householdId: p.householdId }, async (trx) => {
      await trx
        .updateTable('account')
        .set({ password_hash: hash })
        .where('id', '=', p.accountId)
        .execute();
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
      // 0.4.2 name no session, so they go too.
      await trx
        .deleteFrom('device')
        .where('account_id', '=', p.accountId)
        .where((eb) => eb.or([eb('session_id', 'is', null), eb('session_id', '!=', p.sessionId)]))
        .execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'auth.password_changed',
        detail: { method },
        ip: meta.ip,
      });
    });

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

    const membership = await withScope(this.db, { accountId: account.id }, (trx) =>
      trx
        .selectFrom('account_household')
        .select(['household_id'])
        .orderBy('joined_at', 'desc')
        .executeTakeFirst(),
    );
    if (!membership) return;

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
    const owners = await withScope(this.db, { householdId }, (trx) =>
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
    const token = randomBytes(32).toString('base64url');
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
    const membership = await withScope(this.db, { accountId: row.account_id }, (trx) =>
      trx
        .selectFrom('account_household')
        .select(['household_id'])
        .orderBy('joined_at', 'desc')
        .executeTakeFirst(),
    );
    const household = membership
      ? await withScope(this.db, { householdId: membership.household_id }, (trx) =>
          trx.selectFrom('household').select(['name']).executeTakeFirst(),
        )
      : null;
    return {
      household_name: household?.name ?? null,
      email: account.email,
      issued_by_operator: row.issued_by === 'operator',
      expires_at: row.expires_at.toISOString(),
    };
  }

  /**
   * Spends the link. Deliberately does not sign anybody in: an account
   * with two-step sign-in switched on must still be asked for the code,
   * and a reset that handed back a session would walk straight past it.
   */
  async reset(token: string, newPassword: string, meta: RequestMeta): Promise<{ email: string }> {
    const row = await this.live(token);
    const account = await this.db
      .selectFrom('account')
      .select(['id', 'email'])
      .where('id', '=', row.account_id)
      .executeTakeFirstOrThrow();
    const membership = await withScope(this.db, { accountId: account.id }, (trx) =>
      trx
        .selectFrom('account_household')
        .select(['household_id', 'member_id'])
        .orderBy('joined_at', 'desc')
        .executeTakeFirst(),
    );
    if (!membership) throw gone();

    const hash = await argon2.hash(newPassword, ARGON2);
    // Claiming the link is its own statement, so that two people racing
    // the same link cannot both spend it.
    const claimed = await this.db
      .updateTable('password_reset')
      .set({ used_at: new Date() })
      .where('id', '=', row.id)
      .where('used_at', 'is', null)
      .returning('id')
      .executeTakeFirst();
    if (!claimed) throw gone();

    await withScope(this.db, { householdId: membership.household_id }, async (trx) => {
      await trx
        .updateTable('account')
        .set({ password_hash: hash })
        .where('id', '=', account.id)
        .execute();
      // No old password to unwrap with, so the member key comes back
      // through the master key and is given a fresh credential wrap.
      await this.keys.attachCredential(
        trx,
        { householdId: membership.household_id, kind: 'member', memberId: membership.member_id },
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
      await trx.deleteFrom('device').where('account_id', '=', account.id).execute();
      // And every passkey. A reset is what somebody does when they cannot
      // get in, or fear somebody else can; a passkey added from a borrowed
      // session would otherwise outlast it. They are added again in a tap.
      await trx
        .deleteFrom('credential')
        .where('account_id', '=', account.id)
        .where('kind', '=', 'passkey')
        .execute();
      await appendAudit(trx, {
        householdId: membership.household_id,
        actorAccountId: account.id,
        action: 'auth.password_reset',
        detail: { issued_by: row.issued_by },
        ip: meta.ip,
      });
    });

    await this.alert({
      householdId: membership.household_id,
      accountIds: [account.id],
      subject: 'Your vault password was reset',
      body: 'Somebody used a reset link to set a new password, and every device has been signed out. If that was not you, whoever did it can read your email — deal with that first.',
      emailOnly: true,
    });
    return { email: account.email };
  }

  /** The address a reset link points at. */
  linkFor(token: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}/reset/${token}`;
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
