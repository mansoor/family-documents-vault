import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { appendAudit, withScope, type Db } from '@fdv/db';
import { SignJWT, jwtVerify } from 'jose';
import * as OTPAuth from 'otpauth';
import { ApiError } from '../errors.js';
import type { Principal, RequestMeta } from './service.js';

/**
 * Two-step sign-in with a time-based code (SEC-03). Mandatory for owners:
 * the vault does not lock an owner out for not having set it up yet (that
 * would strand a fresh install), but reports `totp_required` until they do
 * and the web app nags.
 *
 * The secret is stored encrypted under a master-derived key; a stolen
 * database dump does not yield working authenticators.
 */

const ISSUER = 'Family Document Vault';
const MFA_TTL = '5m';

export class TotpService {
  constructor(
    private readonly db: Db,
    private readonly secretKey: Buffer, // deriveKey(master, 'totp-secrets')
    private readonly signingKey: Uint8Array,
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
    await this.db
      .updateTable('account')
      .set({
        totp_secret: seal(this.secretKey, secret.base32, p.accountId),
        totp_confirmed_at: null,
      })
      .where('id', '=', p.accountId)
      .execute();
    await withScope(this.db, { householdId: p.householdId }, (trx) =>
      appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'auth.totp_enrol_started',
        ip: meta.ip,
      }),
    );
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
    if (!this.check(open(this.secretKey, row.totp_secret, p.accountId), code)) {
      throw new ApiError(
        422,
        'totp_invalid',
        "That code didn't match. Codes change every 30 seconds — try the current one.",
      );
    }
    await this.db
      .updateTable('account')
      .set({ totp_confirmed_at: new Date() })
      .where('id', '=', p.accountId)
      .execute();
    await withScope(this.db, { householdId: p.householdId }, (trx) =>
      appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'auth.totp_enabled',
        ip: meta.ip,
      }),
    );
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
    if (!row.totp_secret || !this.check(open(this.secretKey, row.totp_secret, p.accountId), code)) {
      throw new ApiError(422, 'totp_invalid', "That code didn't match.");
    }
    await this.db
      .updateTable('account')
      .set({ totp_secret: null, totp_confirmed_at: null })
      .where('id', '=', p.accountId)
      .execute();
    await withScope(this.db, { householdId: p.householdId }, (trx) =>
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

  /** Verifies a code against the stored, confirmed secret. */
  async verify(accountId: string, code: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('account')
      .select(['totp_secret', 'totp_confirmed_at'])
      .where('id', '=', accountId)
      .executeTakeFirst();
    if (!row?.totp_secret || !row.totp_confirmed_at) return false;
    return this.check(open(this.secretKey, row.totp_secret, accountId), code);
  }

  /** A short-lived token that says "password was right, now the code" (API spec §2). */
  async mfaToken(accountId: string): Promise<string> {
    return new SignJWT({ purpose: 'mfa' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(accountId)
      .setIssuedAt()
      .setIssuer('fdv')
      .setAudience('fdv-mfa')
      .setExpirationTime(MFA_TTL)
      .sign(this.signingKey);
  }

  async accountFromMfaToken(token: string): Promise<string> {
    try {
      const { payload } = await jwtVerify(token, this.signingKey, {
        issuer: 'fdv',
        audience: 'fdv-mfa',
      });
      if (payload.purpose !== 'mfa' || typeof payload.sub !== 'string') throw new Error('bad');
      return payload.sub;
    } catch {
      throw new ApiError(401, 'mfa_expired', 'That sign-in attempt has expired. Start again.');
    }
  }

  private check(base32: string, code: string): boolean {
    const totp = new OTPAuth.TOTP({
      issuer: ISSUER,
      secret: OTPAuth.Secret.fromBase32(base32),
      digits: 6,
      period: 30,
    });
    return totp.validate({ token: code.replace(/\s+/g, ''), window: 1 }) !== null;
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
