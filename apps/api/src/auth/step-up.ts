import argon2 from 'argon2';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { appendAudit, withScope, type Db } from '@fdv/db';
import { ApiError } from '../errors.js';
import type { PasskeyService } from './passkeys.js';
import type { Principal, RequestMeta } from './service.js';
import type { TotpService } from './totp.js';

/**
 * Step-up authentication (SEC-17).
 *
 * A live session is not the same as someone being there. These are the
 * actions where the difference matters — opening a private document,
 * moving where the files live, changing who is in the family, exporting
 * everything — and for them the vault asks for a credential again, once,
 * and then trusts the session for five minutes.
 *
 * It is a narrow defence with a specific target: a session token lifted
 * off a device that was left unlocked. It does nothing about a stolen
 * password, which is what two-step sign-in is for.
 */

export const STEP_UP_WINDOW_MS = 5 * 60 * 1000;

/** The actions that ask. The name travels to the client, which says why. */
export type StepUpAction =
  | 'open_private_document'
  | 'open_essential'
  | 'change_storage'
  | 'change_people'
  | 'export_everything'
  | 'change_password'
  | 'change_sign_in';

const WHY: Record<StepUpAction, string> = {
  open_private_document: 'to open a document only you can see',
  // A household's Essentials are everybody's: the old message said "only
  // you can see" about a passport the whole family can (0.4.12).
  open_essential: 'to open an Essential document',
  change_storage: 'to change where your files are kept',
  change_people: 'to change who is in the family',
  export_everything: 'to export everything',
  // Setting a password without knowing the old one is only safe if
  // somebody has just proved who they are some other way.
  change_password: 'to set a new password',
  // A passkey added from a session somebody else picked up would outlast
  // the session, and every password change after it.
  change_sign_in: 'to change how you sign in',
};

export class StepUpService {
  constructor(
    private readonly db: Db,
    private readonly passkeys: PasskeyService | null,
    private readonly totp: TotpService | null,
  ) {}

  /**
   * The session row is behind row-level security like everything else, so
   * this has to be asked inside the household's scope — outside it the
   * query returns nothing, which would read as "never verified" and ask
   * for a credential on every single action.
   */
  private async verifiedAt(p: Principal): Promise<Date | null> {
    const row = await withScope(this.db, { householdId: p.householdId }, (trx) =>
      trx
        .selectFrom('session')
        .select(['verified_at'])
        .where('id', '=', p.sessionId)
        .executeTakeFirst(),
    );
    return row?.verified_at ? new Date(row.verified_at) : null;
  }

  /** Throws `step_up_required` unless a credential was seen recently. */
  async require(p: Principal, action: StepUpAction): Promise<void> {
    const at = (await this.verifiedAt(p))?.getTime() ?? 0;
    if (Date.now() - at <= STEP_UP_WINDOW_MS) return;
    throw new ApiError(403, 'step_up_required', `Please confirm it is you ${WHY[action]}.`, {
      action,
    });
  }

  /** How long this session stays fresh, for the client to avoid asking twice. */
  async freshness(p: Principal): Promise<{ verified_at: string | null; expires_in: number }> {
    const at = await this.verifiedAt(p);
    const left = at ? Math.max(0, STEP_UP_WINDOW_MS - (Date.now() - at.getTime())) : 0;
    return { verified_at: at?.toISOString() ?? null, expires_in: Math.floor(left / 1000) };
  }

  /**
   * Presents a credential again. Any of the three the account has will do;
   * a passkey is the one that proves the device is present.
   */
  async verify(
    p: Principal,
    input: { password?: string; code?: string; passkey?: AuthenticationResponseJSON },
    meta: RequestMeta,
  ): Promise<{ verified_at: string; expires_in: number }> {
    let method: string;
    if (input.passkey) {
      if (!this.passkeys) throw refused();
      await this.passkeys.verifyForAccount(p.accountId, input.passkey);
      method = 'passkey';
    } else if (input.code) {
      if (!this.totp || !(await this.totp.verify(p.accountId, input.code))) throw refused();
      method = 'totp';
    } else if (input.password) {
      const account = await this.db
        .selectFrom('account')
        .select(['password_hash'])
        .where('id', '=', p.accountId)
        .executeTakeFirst();
      if (
        !account?.password_hash ||
        !(await argon2.verify(account.password_hash, input.password))
      ) {
        throw refused();
      }
      method = 'password';
    } else {
      throw new ApiError(422, 'validation_failed', 'Send a passkey, a code or your password.');
    }

    const now = new Date();
    await withScope(this.db, { householdId: p.householdId }, (trx) =>
      trx.updateTable('session').set({ verified_at: now }).where('id', '=', p.sessionId).execute(),
    );
    await withScope(this.db, { householdId: p.householdId, accountId: p.accountId }, (trx) =>
      appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'auth.stepped_up',
        detail: { method },
        ip: meta.ip,
      }),
    );
    return {
      verified_at: now.toISOString(),
      expires_in: Math.floor(STEP_UP_WINDOW_MS / 1000),
    };
  }
}

const refused = () => new ApiError(401, 'invalid_credentials', "That didn't match. Try again.");
