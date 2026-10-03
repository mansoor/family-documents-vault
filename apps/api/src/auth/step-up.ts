import argon2 from 'argon2';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { appendAudit, withPrincipal, type Db } from '@fdv/db';
import { FACTOR_STEP_UPS } from '@fdv/shared';
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
  | 'change_sign_in'
  | 'widen_type_visibility'
  | 'share_collection'
  | 'remove_for_good'
  | 'manage_sign_ins'
  | 'open_identity'
  | 'reveal_identity'
  | 'identity_audience';

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
  // A kind of document made visible to more people by default: the next
  // will or tax return anybody files, a phone's queued scan among them,
  // is in front of them (0.5.10).
  widen_type_visibility: 'to let more people see a kind of document',
  // Every collection shared outside, whatever is in it (5.19, A19): a
  // session picked up from an unlocked device could otherwise send the
  // will, the tax returns and the medical file out in one link. Turning a
  // shared collection back on after a restore asks the same.
  share_collection: 'to share a collection outside the family',
  // Removing a document for good (5.24), or asking to: a session picked up
  // from an unlocked device could otherwise empty the Trash for ever.
  remove_for_good: 'to remove a document for good',
  // The owner's powers over other people's sign-ins (A54, 5.25): asked
  // with a passkey or a code from an authenticator app, never the password
  // (`FACTOR_STEP_UPS`).
  manage_sign_ins: "to manage other people's sign-ins",
  // Showing another person's identity numbers (5.26), whoever asks — an
  // owner (A54), or an adult or a teen the household's audience lets read
  // them: a passkey or a code, never the password. One phished password
  // must not open everybody's passport number.
  open_identity: "to see another person's identity numbers",
  // Showing one's own identity numbers (5.26): any credential, as opening
  // an Only me document asks.
  reveal_identity: 'to see your identity numbers',
  // Who reads other people's identity details (5.26, A34, A54).
  identity_audience: 'to change who can see identity details',
};

/**
 * Said to somebody with neither two-step sign-in nor a passkey who asks for
 * what takes one (`FACTOR_STEP_UPS`), in the words of what they asked for
 * (the 5.26 review): "Turn on two-step sign-in to see another person's
 * identity numbers." For the account card (`manage_sign_ins`), as before 5.26:
 * "Turn on two-step sign-in to manage other people's sign-ins."
 */
export const needsTwoStep = (action: StepUpAction) => `Turn on two-step sign-in ${WHY[action]}.`;

/**
 * Whether an action's step-up takes only a passkey or a code (A54): the
 * shared list, which the web reads too, so it offers no password for them.
 */
const factorOnly = (action: StepUpAction) => FACTOR_STEP_UPS.includes(action);

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
   *
   * Asked in the caller's own transaction when it has one: a change that
   * decides under a lock whether it needs asking (a kind of document made
   * visible to more people, 0.5.10) asks there, without a second
   * connection.
   */
  private async verifiedAt(p: Principal, trx?: Db, factor = false): Promise<Date | null> {
    const read = (t: Db) =>
      t
        .selectFrom('session')
        .select(['verified_at', 'factor_verified_at'])
        .where('id', '=', p.sessionId)
        .executeTakeFirst();
    const row = trx ? await read(trx) : await withPrincipal(this.db, p, read);
    // A54: the owner's powers over other people's sign-ins ask when this
    // session last saw a passkey or a code; a password, however recent,
    // is not that.
    const at = factor ? row?.factor_verified_at : row?.verified_at;
    return at ? new Date(at) : null;
  }

  /**
   * Throws `step_up_required` unless a credential was seen recently: any of
   * the account's, or for the actions of `FACTOR_STEP_UPS` (A54), a passkey
   * or a code.
   */
  async require(p: Principal, action: StepUpAction, trx?: Db): Promise<void> {
    const at = (await this.verifiedAt(p, trx, factorOnly(action)))?.getTime() ?? 0;
    if (Date.now() - at <= STEP_UP_WINDOW_MS) return;
    throw new ApiError(403, 'step_up_required', `Please confirm it is you ${WHY[action]}.`, {
      action,
    });
  }

  /**
   * A new owner power (A54, 5.25), for an owner — the caller has refused
   * anybody else already, as the power's route answers them: an owner with
   * only a password is refused it outright (`403 totp_required_for_owner`),
   * and any other is asked for a passkey or a code within the last five
   * minutes, never the password (`require` with a `FACTOR_STEP_UPS`
   * action). Every route that calls this is listed in the API changelog.
   */
  async requireOwnerPower(p: Principal, action: StepUpAction): Promise<void> {
    await this.requireFactor(p, action);
  }

  /**
   * What takes a passkey or a code (`FACTOR_STEP_UPS`), for anybody: an
   * owner's powers (A54), and since 5.26 showing another person's identity
   * numbers, whoever asks. Somebody with neither is refused outright, in the
   * words of what they asked for — an owner `403 totp_required_for_owner`,
   * anybody else `403 two_step_required` — and anybody else is asked for a
   * passkey or a code within the last five minutes, never the password.
   */
  async requireFactor(p: Principal, action: StepUpAction): Promise<void> {
    if (!factorOnly(action)) throw new Error(`${action} does not take a passkey or a code alone`);
    const [code, passkey] = await Promise.all([
      this.totp ? this.totp.isEnabled(p.accountId) : false,
      this.passkeys ? this.passkeys.has(p.accountId) : false,
    ]);
    if (!code && !passkey) {
      throw new ApiError(
        403,
        p.role === 'owner' ? 'totp_required_for_owner' : 'two_step_required',
        needsTwoStep(action),
      );
    }
    await this.require(p, action);
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
    // A passkey or a code is also what the owner's powers ask (A54); a
    // password moves only the time any credential was last seen.
    const factor = method === 'passkey' || method === 'totp';
    await withPrincipal(this.db, p, (trx) =>
      trx
        .updateTable('session')
        .set(factor ? { verified_at: now, factor_verified_at: now } : { verified_at: now })
        .where('id', '=', p.sessionId)
        .execute(),
    );
    await withPrincipal(this.db, p, (trx) =>
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
