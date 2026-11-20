import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { appendAudit, withPrincipal, type Db } from '@fdv/db';
import { SignJWT, jwtVerify } from 'jose';
import * as OTPAuth from 'otpauth';
import { ApiError } from '../errors.js';
import { stillSignedIn, type Principal, type RequestMeta } from './service.js';

/**
 * Two-step sign-in with a time-based code (SEC-03). Mandatory for owners:
 * the vault does not lock an owner out for not having set it up yet (that
 * would strand a fresh install), but reports `totp_required` until they do
 * and the web app nags.
 *
 * The secret is stored encrypted under a master-derived key; a stolen
 * database dump does not yield working authenticators.
 *
 * Each code is taken once (0.9.0): the time step of the last one taken is
 * kept on the account (`totp_last_step`), and a code at or before it is
 * refused — at signing in, at confirming it's you, at setting one up and at
 * turning it off. A code seen over a shoulder, or passed on by a copy of
 * the sign-in page, does not work a second time.
 */

/** What a code was found to be: right and not used before, wrong, or used already. */
export type CodeCheck = 'ok' | 'wrong' | 'used';

/** Said of a code from an authenticator app that was taken already (0.9.0). */
export const CODE_USED_MESSAGE =
  'That code was used already. Wait for the next one from your authenticator app, and type that.';

const ISSUER = 'Family Document Vault';
const MFA_TTL = '5m';
const PERIOD = 30;

export class TotpService {
  constructor(
    private readonly db: Db,
    private readonly secretKey: Buffer, // deriveKey(master, 'totp-secrets')
    private readonly signingKey: Uint8Array,
    private readonly opts: {
      /**
       * Whether a code is refused a second time (0.9.0): always, but in the
       * test harness, whose tests are not about it, unless one asks.
       */
      refuseReplay?: boolean;
      now?: () => number;
    } = {},
  ) {}

  /** Starts enrolment: a fresh secret, stored but not yet confirmed. */
  async enrol(
    p: Principal,
    email: string,
    meta: RequestMeta,
  ): Promise<{ secret: string; otpauth_url: string }> {
    // Starting again would overwrite a working secret and switch two-step
    // sign-in off without a code — for an owner, round the rule that they
    // must keep it on. Turning it off takes a code; so does starting over.
    const current = await this.db
      .selectFrom('account')
      .select(['totp_confirmed_at'])
      .where('id', '=', p.accountId)
      .executeTakeFirstOrThrow();
    if (current.totp_confirmed_at) {
      throw new ApiError(
        409,
        'totp_already_on',
        'Two-step sign-in is already on. To use a new app, turn it off first with a code from the one you have.',
      );
    }
    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = new OTPAuth.TOTP({ issuer: ISSUER, label: email, secret, digits: 6, period: 30 });
    await withPrincipal(this.db, p, async (trx) => {
      // From a session still live (5.29): a reset that ended it meanwhile
      // is not followed by an authenticator it never saw.
      await stillSignedIn(trx, p);
      await trx
        .updateTable('account')
        .set({
          totp_secret: seal(this.secretKey, secret.base32, p.accountId),
          totp_confirmed_at: null,
          // A new authenticator counts its codes afresh.
          totp_last_step: null,
        })
        .where('id', '=', p.accountId)
        .execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'auth.totp_enrol_started',
        ip: meta.ip,
      });
    });
    return { secret: secret.base32, otpauth_url: totp.toString() };
  }

  /** Confirms enrolment with a code from the authenticator. */
  async confirm(p: Principal, code: string, meta: RequestMeta): Promise<void> {
    const row = await this.db
      .selectFrom('account')
      .select(['totp_secret', 'email'])
      .where('id', '=', p.accountId)
      .executeTakeFirstOrThrow();
    if (!row.totp_secret)
      throw new ApiError(409, 'totp_not_started', 'Start setting up two-step sign-in first.');
    const found = await this.take(
      p.accountId,
      open(this.secretKey, row.totp_secret, p.accountId),
      code,
    );
    if (found !== 'ok') {
      throw new ApiError(
        422,
        'totp_invalid',
        found === 'used'
          ? CODE_USED_MESSAGE
          : "That code didn't match. Codes change every 30 seconds — try the current one.",
      );
    }
    await withPrincipal(this.db, p, async (trx) => {
      // From a session still live (5.29), as starting it asks.
      await stillSignedIn(trx, p);
      await trx
        .updateTable('account')
        .set({ totp_confirmed_at: new Date() })
        .where('id', '=', p.accountId)
        .execute();
      // A code was just given: this session has presented two-step sign-in
      // (0.9.0). Fresh, as any
      // code given is, for five minutes.
      await trx
        .updateTable('session')
        .set({ factor_verified_at: new Date() })
        .where('id', '=', p.sessionId)
        .execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'auth.totp_enabled',
        ip: meta.ip,
      });
    });
  }

  async disable(p: Principal, code: string, meta: RequestMeta): Promise<void> {
    if (p.role === 'owner') {
      throw new ApiError(403, 'totp_required_for_owner', 'Owners must keep two-step sign-in on.');
    }
    const row = await this.db
      .selectFrom('account')
      .select('totp_secret')
      .where('id', '=', p.accountId)
      .executeTakeFirstOrThrow();
    const found = row.totp_secret
      ? await this.take(p.accountId, open(this.secretKey, row.totp_secret, p.accountId), code)
      : 'wrong';
    if (found !== 'ok') {
      throw new ApiError(
        422,
        'totp_invalid',
        found === 'used' ? CODE_USED_MESSAGE : "That code didn't match.",
      );
    }
    await this.db
      .updateTable('account')
      .set({ totp_secret: null, totp_confirmed_at: null, totp_last_step: null })
      .where('id', '=', p.accountId)
      .execute();
    await withPrincipal(this.db, p, (trx) =>
      appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'auth.totp_disabled',
        ip: meta.ip,
      }),
    );
  }

  /** True when the account has a confirmed authenticator. */
  async isEnabled(accountId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('account')
      .select('totp_confirmed_at')
      .where('id', '=', accountId)
      .executeTakeFirst();
    return Boolean(row?.totp_confirmed_at);
  }

  /** Verifies a code against the stored, confirmed secret, and takes it: true once. */
  async verify(accountId: string, code: string): Promise<boolean> {
    return (await this.checkCode(accountId, code)) === 'ok';
  }

  /**
   * A code against the stored, confirmed secret (0.9.0): `ok`, and taken, so
   * it is refused from now on; `wrong`; or `used`, right but at or before the
   * last one taken.
   */
  async checkCode(accountId: string, code: string): Promise<CodeCheck> {
    const row = await this.db
      .selectFrom('account')
      .select(['totp_secret', 'totp_confirmed_at'])
      .where('id', '=', accountId)
      .executeTakeFirst();
    if (!row?.totp_secret || !row.totp_confirmed_at) return 'wrong';
    return this.take(accountId, open(this.secretKey, row.totp_secret, accountId), code);
  }

  /**
   * A short-lived token that says "password was right, now the code" (API
   * spec §2), carrying what the password proved (5.29), never the password.
   */
  async mfaToken(accountId: string, proof?: string, device?: string | null): Promise<string> {
    // `dev` (0.9.0): the known device the password came from, whose own
    // count the second step's tries go on.
    return new SignJWT({
      purpose: 'mfa',
      ...(proof ? { pwp: proof } : {}),
      ...(device ? { dev: device } : {}),
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(accountId)
      .setIssuedAt()
      .setIssuer('fdv')
      .setAudience('fdv-mfa')
      .setExpirationTime(MFA_TTL)
      .sign(this.signingKey);
  }

  async accountFromMfaToken(token: string): Promise<string> {
    return (await this.mfaClaims(token)).accountId;
  }

  /** Whose the token is, and what the password proved (5.29; null in an older token). */
  async mfaClaims(
    token: string,
  ): Promise<{ accountId: string; proof: string | null; device: string | null }> {
    try {
      const { payload } = await jwtVerify(token, this.signingKey, {
        issuer: 'fdv',
        audience: 'fdv-mfa',
      });
      if (payload.purpose !== 'mfa' || typeof payload.sub !== 'string') throw new Error('bad');
      return {
        accountId: payload.sub,
        proof: typeof payload.pwp === 'string' ? payload.pwp : null,
        device: typeof payload.dev === 'string' ? payload.dev : null,
      };
    } catch {
      throw new ApiError(401, 'mfa_expired', 'That sign-in attempt has expired. Start again.');
    }
  }

  /**
   * The time step a code is of, within a step either side of now; null when
   * it is none of them.
   */
  private stepOf(base32: string, code: string): number | null {
    const totp = new OTPAuth.TOTP({
      issuer: ISSUER,
      secret: OTPAuth.Secret.fromBase32(base32),
      digits: 6,
      period: PERIOD,
    });
    const now = this.opts.now?.() ?? Date.now();
    const delta = totp.validate({ token: code.replace(/\s+/g, ''), window: 1, timestamp: now });
    return delta === null ? null : Math.floor(now / 1000 / PERIOD) + delta;
  }

  /**
   * A code checked and, when right, taken: its step kept on the account, in
   * one statement, so that two requests with the same code cannot both
   * have it.
   */
  private async take(accountId: string, base32: string, code: string): Promise<CodeCheck> {
    const step = this.stepOf(base32, code);
    if (step === null) return 'wrong';
    if (this.opts.refuseReplay === false) return 'ok';
    const r = await this.db
      .updateTable('account')
      .set({ totp_last_step: step })
      .where('id', '=', accountId)
      .where((eb) => eb.or([eb('totp_last_step', 'is', null), eb('totp_last_step', '<', step)]))
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1 ? 'ok' : 'used';
  }
}

function seal(key: Buffer, secret: string, accountId: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(`totp:${accountId}`));
  const ct = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

function open(key: Buffer, sealed: Buffer, accountId: string): string {
  const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
  d.setAAD(Buffer.from(`totp:${accountId}`));
  d.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([d.update(sealed.subarray(28)), d.final()]).toString('utf8');
}

/** For tests: the current code for a secret. */
export function codeFor(base32: string, at?: number): string {
  return new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(base32),
    digits: 6,
    period: 30,
  }).generate(at !== undefined ? { timestamp: at } : {});
}
