import { randomUUID } from 'node:crypto';
import type { ScopeKeys } from '@fdv/crypto';
import { appendAudit, withScope, type Db, type Role } from '@fdv/db';
import argon2 from 'argon2';
import { sql } from 'kysely';
import { ApiError } from '../errors.js';
import {
  ACCESS_TTL_SECONDS,
  hashRefreshToken,
  newRefreshToken,
  parseRefreshToken,
  REFRESH_TTL_SECONDS,
  signAccessToken,
  verifyAccessToken,
  type AccessClaims,
} from './tokens.js';

/**
 * Accounts, sessions and the first-run setup. Everything here runs inside
 * scoped transactions so that row-level security is in force and each audit
 * entry commits with the change it records.
 */

// Argon2id parameters: OWASP's recommended minimum, comfortably fast on a Pi 5.
const ARGON2: argon2.HashOptions & { raw?: false } = {
  type: argon2.argon2id,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
};
// A hash of nothing in particular, verified against when the email is unknown
// so that a wrong email and a wrong password take the same time.
const DUMMY_HASH_PROMISE = argon2.hash('not-a-real-password', ARGON2);

export interface Tokens {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  refresh_expires_in: number;
  household_id: string;
  member_id: string;
  role: Role;
  scopes_unlocked: Array<'household' | 'adults' | 'member'>;
}

export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export interface Principal {
  accountId: string;
  sessionId: string;
  householdId: string;
  memberId: string;
  role: Role;
}

export interface SetupInput {
  householdName: string;
  displayName: string;
  email: string;
  password: string;
}

const invalidCredentials = () =>
  new ApiError(401, 'invalid_credentials', "That email and password don't match.");

const sessionEnded = (why: string) =>
  new ApiError(401, 'session_ended', 'Please sign in again.', { detail: why });

export function scopesFor(role: Role): Tokens['scopes_unlocked'] {
  // Until member scope keys exist (1.1), this reflects role alone.
  return role === 'owner' || role === 'adult' ? ['household', 'adults', 'member'] : ['household'];
}

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly signingKey: Uint8Array,
    private readonly keys: ScopeKeys,
    /** Runs inside setup's transaction after the household exists (creates the default vault). */
    private readonly onHouseholdCreated: (
      trx: Db,
      householdId: string,
    ) => Promise<void> = async () => undefined,
    /** Answers whether an account must present a second factor, and mints the interim token. */
    private readonly mfa: {
      isEnabled: (accountId: string) => Promise<boolean>;
      mfaToken: (accountId: string) => Promise<string>;
      accountFromMfaToken: (token: string) => Promise<string>;
      verify: (accountId: string, code: string) => Promise<boolean>;
    } | null = null,
  ) {}

  async setupComplete(): Promise<boolean> {
    const r = await sql<{ done: boolean }>`select setup_complete() as done`.execute(this.db);
    return r.rows[0]?.done ?? false;
  }

  /** The household's own name once set up; null before. */
  async displayName(): Promise<string | null> {
    const r = await sql<{ name: string | null }>`select vault_display_name() as name`.execute(
      this.db,
    );
    return r.rows[0]?.name ?? null;
  }

  /** First run: the household, its first member, the owner account, one session. */
  async setup(input: SetupInput, meta: RequestMeta): Promise<Tokens> {
    if (await this.setupComplete()) {
      throw new ApiError(
        409,
        'already_set_up',
        'This vault has already been set up. Sign in instead.',
      );
    }
    const householdId = randomUUID();
    const passwordHash = await argon2.hash(input.password, ARGON2);

    return withScope(this.db, { householdId }, async (trx) => {
      await trx
        .insertInto('household')
        .values({ id: householdId, name: input.householdName })
        .execute();
      await trx.insertInto('household_profile').values({ household_id: householdId }).execute();
      const member = await trx
        .insertInto('member')
        .values({ household_id: householdId, display_name: input.displayName })
        .returning('id')
        .executeTakeFirstOrThrow();
      const account = await trx
        .insertInto('account')
        .values({ email: input.email, password_hash: passwordHash })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('account_household')
        .values({
          account_id: account.id,
          household_id: householdId,
          member_id: member.id,
          role: 'owner',
        })
        .execute();
      // The key hierarchy is born with the household (data model, section 8):
      // nothing can be stored until these rows exist.
      await this.keys.mintHouseholdKeys(trx, householdId);
      await this.keys.mintMemberKey(trx, householdId, member.id, input.password);
      await this.onHouseholdCreated(trx, householdId);
      await appendAudit(trx, {
        householdId,
        actorAccountId: account.id,
        action: 'household.created',
        objectType: 'household',
        objectId: householdId,
        detail: { name: input.householdName },
        ip: meta.ip,
      });
      return this.openSession(
        trx,
        { accountId: account.id, householdId, memberId: member.id, role: 'owner' },
        meta,
      );
    });
  }

  async signInWithPassword(
    email: string,
    password: string,
    meta: RequestMeta,
  ): Promise<Tokens | { mfa_required: true; mfa_token: string }> {
    const account = await this.db
      .selectFrom('account')
      .select(['id', 'password_hash', 'disabled_at'])
      .where('email', '=', email)
      .executeTakeFirst();

    const hash = account?.password_hash ?? (await DUMMY_HASH_PROMISE);
    const ok = await argon2.verify(hash, password);
    if (!account || !ok || account.disabled_at) throw invalidCredentials();

    if (this.mfa && (await this.mfa.isEnabled(account.id))) {
      return { mfa_required: true, mfa_token: await this.mfa.mfaToken(account.id) };
    }
    return this.openSessionForAccount(account.id, meta, 'password');
  }

  /** Second step: the interim token plus a code from the authenticator. */
  async signInWithMfa(mfaToken: string, code: string, meta: RequestMeta): Promise<Tokens> {
    if (!this.mfa) throw invalidCredentials();
    const accountId = await this.mfa.accountFromMfaToken(mfaToken);
    if (!(await this.mfa.verify(accountId, code))) {
      throw new ApiError(401, 'totp_invalid', "That code didn't match. Try the current one.");
    }
    return this.openSessionForAccount(accountId, meta, 'password+totp');
  }

  private async openSessionForAccount(
    accountId: string,
    meta: RequestMeta,
    method: string,
  ): Promise<Tokens> {
    const account = { id: accountId };

    const memberships = await withScope(this.db, { accountId: account.id }, (trx) =>
      trx
        .selectFrom('account_household')
        .select(['household_id', 'member_id', 'role'])
        .orderBy('joined_at', 'desc')
        .execute(),
    );
    const m = memberships[0];
    if (!m) {
      throw new ApiError(403, 'no_household', 'Your sign-in is not part of any family vault yet.');
    }

    return withScope(
      this.db,
      { householdId: m.household_id, accountId: account.id },
      async (trx) => {
        await appendAudit(trx, {
          householdId: m.household_id,
          actorAccountId: account.id,
          action: 'auth.signed_in',
          ip: meta.ip,
          detail: { method },
        });
        return this.openSession(
          trx,
          {
            accountId: account.id,
            householdId: m.household_id,
            memberId: m.member_id,
            role: m.role,
          },
          meta,
        );
      },
    );
  }

  private async openSession(
    trx: Db,
    p: Omit<Principal, 'sessionId'>,
    meta: RequestMeta,
  ): Promise<Tokens> {
    const refresh = newRefreshToken(p.householdId);
    const session = await trx
      .insertInto('session')
      .values({
        account_id: p.accountId,
        household_id: p.householdId,
        refresh_hash: hashRefreshToken(refresh),
        user_agent: meta.userAgent ?? null,
        ip: meta.ip ?? null,
        expires_at: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return this.tokens({ ...p, sessionId: session.id }, refresh);
  }

  private async tokens(p: Principal, refresh: string): Promise<Tokens> {
    const claims: AccessClaims = {
      sub: p.accountId,
      sid: p.sessionId,
      hid: p.householdId,
      mid: p.memberId,
      role: p.role,
    };
    return {
      access_token: await signAccessToken(this.signingKey, claims),
      expires_in: ACCESS_TTL_SECONDS,
      refresh_token: refresh,
      refresh_expires_in: REFRESH_TTL_SECONDS,
      household_id: p.householdId,
      member_id: p.memberId,
      role: p.role,
      scopes_unlocked: scopesFor(p.role),
    };
  }

  /**
   * Rotates the refresh token. A token that was already rotated is proof of
   * theft (either the thief or the owner is replaying): the whole session
   * is revoked and both parties must sign in again.
   */
  async refresh(refreshToken: string, meta: RequestMeta): Promise<Tokens> {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) throw sessionEnded('malformed refresh token');
    const presented = hashRefreshToken(refreshToken);

    const result = await withScope(this.db, { householdId: parsed.householdId }, async (trx) => {
      const session = await trx
        .selectFrom('session')
        .selectAll()
        .where('refresh_hash', '=', presented)
        .executeTakeFirst();

      // A missing session is either garbage or a replayed, already-rotated
      // token. The replay case must commit its revocation before we fail,
      // so it is handled outside this transaction.
      if (!session) return null;

      if (session.revoked_at) throw sessionEnded('session revoked');
      if (session.expires_at.getTime() < Date.now()) throw sessionEnded('session expired');

      const membership = await trx
        .selectFrom('account_household')
        .select(['member_id', 'role'])
        .where('account_id', '=', session.account_id)
        .where('household_id', '=', session.household_id)
        .executeTakeFirst();
      if (!membership) throw sessionEnded('membership removed');

      const next = newRefreshToken(session.household_id);
      await trx
        .updateTable('session')
        .set({
          refresh_hash: hashRefreshToken(next),
          prev_refresh_hash: presented,
          last_used_at: new Date(),
          ip: meta.ip ?? null,
        })
        .where('id', '=', session.id)
        .execute();

      return this.tokens(
        {
          accountId: session.account_id,
          sessionId: session.id,
          householdId: session.household_id,
          memberId: membership.member_id,
          role: membership.role,
        },
        next,
      );
    });
    if (result) return result;

    await this.revokeOnReuse(parsed.householdId, presented, meta);
    throw sessionEnded('unknown or reused refresh token');
  }

  /** Revokes the session whose previous refresh token was just replayed, if any. */
  private async revokeOnReuse(householdId: string, presented: Buffer, meta: RequestMeta) {
    await withScope(this.db, { householdId }, async (trx) => {
      const replayed = await trx
        .selectFrom('session')
        .select('id')
        .where('prev_refresh_hash', '=', presented)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (!replayed) return;
      await trx
        .updateTable('session')
        .set({ revoked_at: new Date(), revoked_reason: 'refresh token reuse' })
        .where('id', '=', replayed.id)
        .execute();
      await appendAudit(trx, {
        householdId,
        action: 'auth.session_revoked',
        objectType: 'session',
        objectId: replayed.id,
        detail: { reason: 'refresh token reuse' },
        ip: meta.ip,
      });
    });
  }

  /** Verifies a bearer token and confirms its session is still open. */
  async authenticate(bearer: string): Promise<Principal> {
    let claims: AccessClaims;
    try {
      claims = await verifyAccessToken(this.signingKey, bearer);
    } catch {
      throw new ApiError(401, 'unauthenticated', 'Please sign in.');
    }
    const open = await withScope(this.db, { householdId: claims.hid }, (trx) =>
      trx
        .selectFrom('session')
        .select('id')
        .where('id', '=', claims.sid)
        .where('revoked_at', 'is', null)
        .executeTakeFirst(),
    );
    if (!open) throw sessionEnded('session revoked');
    return {
      accountId: claims.sub,
      sessionId: claims.sid,
      householdId: claims.hid,
      memberId: claims.mid,
      role: claims.role,
    };
  }

  async emailOf(accountId: string): Promise<string> {
    const row = await this.db
      .selectFrom('account')
      .select('email')
      .where('id', '=', accountId)
      .executeTakeFirstOrThrow();
    return row.email;
  }

  async listSessions(p: Principal) {
    return withScope(this.db, { householdId: p.householdId }, (trx) =>
      trx
        .selectFrom('session')
        .select(['id', 'user_agent', 'ip', 'created_at', 'last_used_at'])
        .where('account_id', '=', p.accountId)
        .where('revoked_at', 'is', null)
        .orderBy('last_used_at', 'desc')
        .execute(),
    ).then((rows) =>
      rows.map((r) => ({
        id: r.id,
        current: r.id === p.sessionId,
        user_agent: r.user_agent,
        ip: r.ip,
        created_at: r.created_at,
        last_used_at: r.last_used_at,
      })),
    );
  }

  async revokeSession(p: Principal, sessionId: string, meta: RequestMeta, reason: string) {
    await withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const r = await trx
        .updateTable('session')
        .set({ revoked_at: new Date(), revoked_reason: reason })
        .where('id', '=', sessionId)
        .where('account_id', '=', p.accountId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) {
        throw new ApiError(404, 'not_found', 'That device is not signed in.');
      }
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: reason === 'logout' ? 'auth.signed_out' : 'auth.session_revoked',
        objectType: 'session',
        objectId: sessionId,
        ip: meta.ip,
      });
    });
  }
}
