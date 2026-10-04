import { shareEndWords, suspensionInEffect, type Tokens } from '@fdv/shared';
import { createHash, randomUUID } from 'node:crypto';
import type { ScopeKeys } from '@fdv/crypto';
import { ANONYMOUS, appendAudit, withPrincipal, withScope, type Db, type Role } from '@fdv/db';
import argon2 from 'argon2';
import { sql } from 'kysely';
import { ApiError } from '../errors.js';
import {
  ACCESS_TTL_SECONDS,
  hashRefreshToken,
  newRefreshToken,
  parseRefreshToken,
  REFRESH_TTL_SECONDS,
  refreshFamilyKey,
  sessionOfToken,
  signAccessToken,
  verifyAccessToken,
  type AccessClaims,
} from './tokens.js';
import { endDevices, SESSION_ENDED, type PushRequest, type PushTarget } from '../push-job.js';

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

/** What a sign-in answers with: the shared wire type, written once in `@fdv/shared`. */
export type { Tokens } from '@fdv/shared';

export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
  /** The app installation making the request (X-FDV-Installation); browsers send none. */
  installationId?: string | null;
}

/**
 * Why a session ended, as clients are told it (0.4.11). `suspended` since
 * 5.28: the person's sign-in was locked by an owner, or paused after a
 * restore.
 */
export type SessionEndReason =
  'expired' | 'revoked' | 'reused' | 'removed' | 'malformed' | 'suspended';

/** Sign in once, and a session lasts at most this long however much it is used. */
export const SESSION_MAX_MS = 180 * 24 * 60 * 60 * 1000;
/** A refresh whose answer was lost may be replayed within this long. */
export const REFRESH_GRACE_MS = 30_000;
/** Tokens touched by grace replays, kept per session: the most recent this many. */
const GRACE_HASHES_KEPT = 8;

/** What a session's stored revocation says to the client. */
export function endReasonOf(revokedReason: string | null): SessionEndReason {
  if (revokedReason === 'refresh token reuse') return 'reused';
  if (revokedReason === 'membership removed') return 'removed';
  // 5.28: household/locks.ts LOCKED_REVOKED_REASON.
  if (revokedReason === 'sign-in locked') return 'suspended';
  return 'revoked';
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

const sessionEnded = (why: string, reason: SessionEndReason) =>
  new ApiError(401, 'session_ended', 'Please sign in again.', { detail: why, reason });

/** What a session's end is answered with when it ended while a request waited (5.29). */
export const endedMeanwhile = (revokedReason: string | null) =>
  sessionEnded('the session ended while this waited', endReasonOf(revokedReason));

/**
 * What a password or a passkey proved, carried to where the session is
 * opened (5.29): checked again there, under the person's membership, so a
 * reset or a stopped password that commits between the proof and the
 * session is seen, and the session is not opened.
 */
export type SignInProof = { password: string } | { passkey: string };

/** A password hash, as a sign-in carries it: never the hash itself. */
export const passwordProof = (hash: string) =>
  createHash('sha256').update(hash, 'utf8').digest('base64url');

/**
 * The session asking is still live, held so (5.29): the person's membership
 * FOR SHARE — which a reset, a stopped password and a lock hold FOR NO KEY
 * UPDATE while they end every session — then the session itself. A change
 * to how somebody signs in (a password, a passkey, two-step sign-in) that
 * waited for one of those is refused, as its next request would be.
 */
export async function stillSignedIn(trx: Db, p: Principal): Promise<void> {
  await trx
    .selectFrom('account_household')
    .select(['member_id'])
    .where('account_id', '=', p.accountId)
    .where('household_id', '=', p.householdId)
    .forShare()
    .executeTakeFirst();
  const s = await trx
    .selectFrom('session')
    .select(['revoked_at', 'revoked_reason'])
    .where('id', '=', p.sessionId)
    .executeTakeFirst();
  if (!s || s.revoked_at) throw endedMeanwhile(s?.revoked_reason ?? null);
}

/**
 * A sign-in refused because it is locked, or paused after a restore (5.28):
 * said only once the password, the code or the passkey has been proven, so
 * it tells nobody else anything about which accounts there are. Who it is
 * said to is the person, so it says until when, on the household's clock.
 */
export function membershipSuspended(
  reason: 'locked' | 'restored' | null,
  until: Date | null,
  timezone: string,
): ApiError {
  const message =
    reason === 'restored'
      ? 'The vault was restored from a backup, and your sign-in waits for an owner to turn it back on. Ask one of them.'
      : until
        ? `An owner has locked your sign-in until ${shareEndWords(until, timezone)} (${timezone}). Ask one of them if you need to get in sooner.`
        : 'An owner has locked your sign-in. Ask one of them if you need to get in.';
  return new ApiError(403, 'membership_suspended', message, {
    reason: reason ?? 'locked',
  });
}

export function scopesFor(role: Role): Tokens['scopes_unlocked'] {
  // Until member scope keys exist (1.1), this reflects role alone.
  return role === 'owner' || role === 'adult' ? ['household', 'adults', 'member'] : ['household'];
}

export class AuthService {
  /** What a refresh token's tag is made with (5.30, tokens.ts). */
  private readonly familyKey: Buffer;

  constructor(
    private readonly db: Db,
    private readonly signingKey: Uint8Array,
    private readonly keys: ScopeKeys,
    /** Runs inside setup's transaction after the household exists (creates the default vault). */
    private readonly onHouseholdCreated: (
      trx: Db,
      householdId: string,
    ) => Promise<void> = async () => undefined,
    /** Tells named accounts something at once (SEC-11). */
    private readonly alert: (input: {
      householdId: string;
      accountIds: string[];
      subject: string;
      body: string;
      pushType?: 'new_device' | 'owner_change';
    }) => Promise<void> = async () => undefined,
    /**
     * Answers whether an account must present a second factor, and mints the
     * interim token — which carries what the password proved (5.29).
     */
    private readonly mfa: {
      isEnabled: (accountId: string) => Promise<boolean>;
      mfaToken: (accountId: string, proof?: string) => Promise<string>;
      mfaClaims: (token: string) => Promise<{ accountId: string; proof: string | null }>;
      verify: (accountId: string, code: string) => Promise<boolean>;
    } | null = null,
    /** Pushes the worker sends (4.13): "you were signed out" to a session's phones. */
    private readonly push: (input: PushRequest) => Promise<void> = async () => undefined,
  ) {
    this.familyKey = refreshFamilyKey(signingKey);
  }

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

    // Nobody is anybody yet: the account this makes is not the one asking.
    return withScope(this.db, { householdId, actor: ANONYMOUS }, async (trx) => {
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
    if (!account?.password_hash || !ok || account.disabled_at) throw invalidCredentials();

    // What the password proved goes on to where the session opens (5.29).
    const proof = passwordProof(account.password_hash);
    if (this.mfa && (await this.mfa.isEnabled(account.id))) {
      return { mfa_required: true, mfa_token: await this.mfa.mfaToken(account.id, proof) };
    }
    return this.openSessionForAccount(account.id, meta, 'password', { password: proof });
  }

  /** Second step: the interim token plus a code from the authenticator. */
  async signInWithMfa(mfaToken: string, code: string, meta: RequestMeta): Promise<Tokens> {
    if (!this.mfa) throw invalidCredentials();
    const { accountId, proof } = await this.mfa.mfaClaims(mfaToken);
    if (!(await this.mfa.verify(accountId, code))) {
      throw new ApiError(401, 'totp_invalid', "That code didn't match. Try the current one.");
    }
    // A token from before 5.29 carries no proof: it is no longer than five
    // minutes old, and asks for the password again.
    if (proof === null) throw invalidCredentials();
    return this.openSessionForAccount(accountId, meta, 'password+totp', { password: proof });
  }

  /**
   * Opens a session for an account that has already proved who it is.
   * Public so the passkey service can finish a sign-in; every caller must
   * have done the proving first. What the proof was (5.29) is checked again
   * once the person's membership is held: the password is still the one
   * proved, or the passkey is still theirs. A reset or a stopped password
   * that committed in between leaves nothing to open a session with.
   */
  async openSessionForAccount(
    accountId: string,
    meta: RequestMeta,
    method: string,
    proof?: SignInProof,
  ): Promise<Tokens> {
    // A switched-off account opens nothing, however it was proven: a
    // passkey too (5.28), which until then went straight on.
    const switchedOff = await this.db
      .selectFrom('account')
      .select(['disabled_at'])
      .where('id', '=', accountId)
      .executeTakeFirst();
    if (!switchedOff || switchedOff.disabled_at) {
      throw method === 'passkey'
        ? new ApiError(401, 'passkey_rejected', 'That passkey was not accepted. Try again.')
        : invalidCredentials();
    }
    const account = { id: accountId };

    // Proved, but not yet anybody in a household: only its own memberships show.
    const memberships = await withScope(
      this.db,
      { accountId: account.id, actor: ANONYMOUS },
      (trx) =>
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

    const asked = {
      accountId: account.id,
      householdId: m.household_id,
      memberId: m.member_id,
      role: m.role,
    };
    return withPrincipal(this.db, asked, async (trx) => {
      // The membership as it is now, held until the session is open (5.28):
      // a lock at the same moment waits for this, and then ends the session
      // it made; or this waits for the lock, and is refused.
      const held = await trx
        .selectFrom('account_household')
        .select(['member_id', 'role', 'suspended_at', 'suspended_until', 'suspend_reason'])
        .where('account_id', '=', account.id)
        .where('household_id', '=', m.household_id)
        .forShare()
        .executeTakeFirst();
      if (!held) {
        throw new ApiError(
          403,
          'no_household',
          'Your sign-in is not part of any family vault yet.',
        );
      }
      // The proof still holds (5.29): the password is the one proved, or the
      // passkey is still theirs. Held, so a change waits for this session to
      // open, and ends it; or this sees the change, and opens nothing.
      if (proof && 'password' in proof) {
        const now = await trx
          .selectFrom('account')
          .select(['password_hash'])
          .where('id', '=', account.id)
          .forShare()
          .executeTakeFirst();
        if (!now?.password_hash || passwordProof(now.password_hash) !== proof.password) {
          throw invalidCredentials();
        }
      }
      if (proof && 'passkey' in proof) {
        const still = await trx
          .selectFrom('credential')
          .select(['id'])
          .where('id', '=', proof.passkey)
          .where('account_id', '=', account.id)
          .where('kind', '=', 'passkey')
          .forShare()
          .executeTakeFirst();
        if (!still) {
          throw new ApiError(401, 'passkey_rejected', 'That passkey was not accepted. Try again.');
        }
      }
      // Locked, or paused after a restore: refused, now that who it is has
      // been proven, and only now.
      if (suspensionInEffect(held)) {
        const hh = await trx.selectFrom('household').select(['timezone']).executeTakeFirstOrThrow();
        throw membershipSuspended(held.suspend_reason, held.suspended_until, hh.timezone);
      }
      const p = { ...asked, memberId: held.member_id, role: held.role };
      await appendAudit(trx, {
        householdId: m.household_id,
        actorAccountId: account.id,
        action: 'auth.signed_in',
        ip: meta.ip,
        detail: { method },
      });
      return this.openSession(trx, p, meta, method);
    });
  }

  /**
   * `method` is how the sign-in was proved: a passkey, or a password and a
   * code, is also what the owner's powers over other people's sign-ins ask
   * for (A54), so such a session starts fresh for those too.
   */
  private async openSession(
    trx: Db,
    p: Omit<Principal, 'sessionId'>,
    meta: RequestMeta,
    method = 'password',
  ): Promise<Tokens> {
    // Its id is chosen here, as its first token names it (5.30).
    const sessionId = randomUUID();
    const refresh = newRefreshToken(this.familyKey, p.householdId, sessionId);
    const now = Date.now();
    const factor = method === 'passkey' || method === 'password+totp';
    const expiresAt = new Date(now + REFRESH_TTL_SECONDS * 1000);
    const session = await trx
      .insertInto('session')
      .values({
        id: sessionId,
        account_id: p.accountId,
        household_id: p.householdId,
        refresh_hash: hashRefreshToken(refresh),
        user_agent: meta.userAgent ?? null,
        ip: meta.ip ?? null,
        installation_id: meta.installationId ?? null,
        rotated_at: new Date(now),
        expires_at: expiresAt,
        absolute_expires_at: new Date(now + SESSION_MAX_MS),
        // A credential was just presented, so the session starts fresh for
        // the purposes of step-up (SEC-17).
        verified_at: new Date(now),
        factor_verified_at: factor ? new Date(now) : null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.noteDevice(trx, p, meta);
    return this.tokens({ ...p, sessionId: session.id }, refresh, expiresAt);
  }

  /**
   * New-device alerts (SEC-11).
   *
   * The app says which installation it is (0.4.11), and that is what is
   * remembered: an app update is not a new device, and a second phone on
   * the same version is. A browser tells us its user agent and nothing
   * else, so for a browser this is a weak signal, built to fail in the
   * safe direction: two laptops running the same browser version look
   * alike and the second one is quiet, while a browser update makes a
   * device look new and you are told about a sign-in you already knew
   * about. Being told twice is a nuisance; not being told is the thing
   * this exists to prevent.
   *
   * The first device an account ever uses is never an alert — there is
   * nobody to tell and nothing surprising about it.
   */
  private async noteDevice(
    trx: Db,
    p: Omit<Principal, 'sessionId'>,
    meta: RequestMeta,
  ): Promise<void> {
    const agent = meta.userAgent ?? 'unknown';
    const fingerprint = createHash('sha256')
      .update(meta.installationId ? `installation:${meta.installationId}` : agent, 'utf8')
      .digest();
    const seen = await trx
      .selectFrom('known_device')
      .select(['id', 'fingerprint'])
      .where('account_id', '=', p.accountId)
      .execute();
    const known = seen.find((d) => d.fingerprint.equals(fingerprint));
    if (known) {
      await trx
        .updateTable('known_device')
        .set({ last_seen_at: new Date() })
        .where('id', '=', known.id)
        .execute();
      return;
    }
    await trx
      .insertInto('known_device')
      .values({
        account_id: p.accountId,
        household_id: p.householdId,
        fingerprint,
        label: describeDevice(agent),
      })
      .execute();
    if (seen.length === 0) return;
    const device = describeDevice(agent);
    await this.alert({
      householdId: p.householdId,
      accountIds: [p.accountId],
      subject: 'A new device signed in to your vault',
      pushType: 'new_device',
      body: `Somebody signed in ${device.startsWith('the app') ? 'with' : 'on'} ${device}${meta.ip ? ` from ${meta.ip}` : ''}. If that was you, nothing to do. If it wasn't, change your password and sign that device out under Settings.`,
    });
  }

  private async tokens(p: Principal, refresh: string, refreshExpiresAt: Date): Promise<Tokens> {
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
      // The real remainder: 30 days from now, or less near the 180-day end.
      refresh_expires_in: Math.max(0, Math.floor((refreshExpiresAt.getTime() - Date.now()) / 1000)),
      household_id: p.householdId,
      member_id: p.memberId,
      role: p.role,
      scopes_unlocked: scopesFor(p.role),
    };
  }

  /**
   * Rotates the refresh token, and slides the session: 30 more days from
   * now, never past 180 days from the sign-in.
   *
   * A token that was already rotated is proof of theft (either the thief or
   * the owner is replaying): the whole session is revoked and both must
   * sign in again. With one exception, for answers that never arrive — a
   * phone on a network that drops them, or a browser page reloaded while
   * its refresh was on the way: the token just replaced may be presented
   * once more, within 30 seconds of its rotation, from the same client —
   * the session's own app installation, or, for a browser (which has
   * none), the same browser from the same address it last refreshed from.
   * It gets a new rotation, and the token it displaces becomes the
   * previous one, so that whoever holds that one ends the session if they
   * ever use it.
   *
   * Since 5.30 every token names its session (tokens.ts), so any token the
   * vault made for a session, presented once it has been replaced, ends it —
   * not only the one just replaced: a thief who spends a stolen token and
   * then its successor before the owner does loses the session when the
   * owner's token comes in, and the owner who refreshed first ends it when
   * the thief's does, however many refreshes later. A token from before
   * then still refreshes, and is answered with one of a family.
   */
  async refresh(refreshToken: string, meta: RequestMeta): Promise<Tokens> {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) throw sessionEnded('malformed refresh token', 'malformed');
    const presented = hashRefreshToken(refreshToken);
    // The session the token names, if the vault made it; none for one from before 5.30.
    const named = sessionOfToken(this.familyKey, parsed);
    const legacy = named === null;

    // Until the token matches a session, whoever presents it is nobody yet.
    const scope = { householdId: parsed.householdId, actor: ANONYMOUS };
    const result = await withScope(this.db, scope, async (trx) => {
      const now = new Date();
      let session = await trx
        .selectFrom('session')
        .selectAll()
        .where('refresh_hash', '=', presented)
        .forUpdate()
        .executeTakeFirst();
      let replay = false;
      if (!session) {
        // Not the current token. The one just before it, replayed because
        // the answer to its refresh was lost, may get one more rotation.
        const previous = await trx
          .selectFrom('session')
          .selectAll()
          .where('prev_refresh_hash', '=', presented)
          .forUpdate()
          .executeTakeFirst();
        // A session that has already ended says why, not "reused".
        if (previous?.revoked_at) {
          throw sessionEnded('session revoked', endReasonOf(previous.revoked_reason));
        }
        // Anything else — garbage, an older token, a replay the grace does
        // not cover — must commit its revocation before we fail, so it is
        // handled outside this transaction.
        if (!previous || !graceAllows(previous, meta, now)) return null;
        session = previous;
        replay = true;
      }

      if (session.revoked_at)
        throw sessionEnded('session revoked', endReasonOf(session.revoked_reason));
      if (
        session.expires_at.getTime() < now.getTime() ||
        session.absolute_expires_at.getTime() < now.getTime()
      ) {
        throw sessionEnded('session expired', 'expired');
      }

      const membership = await trx
        .selectFrom('account_household')
        .select(['member_id', 'role', 'suspended_at', 'suspended_until'])
        .where('account_id', '=', session.account_id)
        .where('household_id', '=', session.household_id)
        .executeTakeFirst();
      if (!membership) throw sessionEnded('membership removed', 'removed');
      // Locked, or paused after a restore (5.28): no new token.
      if (suspensionInEffect(membership)) {
        throw sessionEnded('membership suspended', 'suspended');
      }

      // A session from before 5.30 is given a token of a family here, and is one from now on.
      const next = newRefreshToken(this.familyKey, session.household_id, session.id);
      const expiresAt = new Date(
        Math.min(now.getTime() + REFRESH_TTL_SECONDS * 1000, session.absolute_expires_at.getTime()),
      );
      await trx
        .updateTable('session')
        .set(
          replay
            ? {
                refresh_hash: hashRefreshToken(next),
                // The token this replay displaces becomes the previous one,
                // and both it and the replayed one are kept for the
                // session's life: presented ever again, however many
                // rotations later, either ends the session.
                prev_refresh_hash: session.refresh_hash,
                grace_hashes: [...session.grace_hashes, presented, session.refresh_hash].slice(
                  -GRACE_HASHES_KEPT,
                ),
                grace_used_at: now,
                rotated_at: now,
                last_used_at: now,
                expires_at: expiresAt,
                ip: meta.ip ?? null,
                user_agent: meta.userAgent ?? session.user_agent,
              }
            : {
                refresh_hash: hashRefreshToken(next),
                prev_refresh_hash: presented,
                // A token from before 5.30 names no session, so once it is
                // no longer the one just replaced nothing would know it.
                // Kept with the tokens a grace touched: presented again,
                // however many refreshes later, it ends the session (the
                // 5.30 review, T530-01).
                ...(legacy
                  ? { grace_hashes: [...session.grace_hashes, presented].slice(-GRACE_HASHES_KEPT) }
                  : {}),
                grace_used_at: null,
                rotated_at: now,
                last_used_at: now,
                expires_at: expiresAt,
                ip: meta.ip ?? null,
                // The browser as it is now: one updated since the sign-in
                // is the same browser (its reload grace compares with this).
                user_agent: meta.userAgent ?? session.user_agent,
              },
        )
        .where('id', '=', session.id)
        .execute();
      if (replay) {
        await appendAudit(trx, {
          householdId: session.household_id,
          actorAccountId: session.account_id,
          action: 'auth.refresh_replayed',
          objectType: 'session',
          objectId: session.id,
          ip: meta.ip,
        });
      }

      return this.tokens(
        {
          accountId: session.account_id,
          sessionId: session.id,
          householdId: session.household_id,
          memberId: membership.member_id,
          role: membership.role,
        },
        next,
        expiresAt,
      );
    });
    if (result) return result;

    // A token that ended a session is proof of reuse; one that matches
    // nothing (garbage, a restored backup's, one long retired, one whose
    // tag is not the vault's) is only no longer valid.
    const why = await this.endSpent(parsed.householdId, presented, named, meta);
    throw sessionEnded('unknown or reused refresh token', why);
  }

  /**
   * Ends the session a spent token belongs to: the token before its current
   * one, any a grace replay touched, or — a token of a family (5.30) — any
   * the vault made for it. Answers why the session is over: `reused` when
   * this ended it; why it ended, when it already had; `revoked` for a token
   * that belongs to no session at all.
   */
  private async endSpent(
    householdId: string,
    presented: Buffer,
    named: string | null,
    meta: RequestMeta,
  ): Promise<SessionEndReason> {
    const scope = { householdId, actor: ANONYMOUS };
    const ended = await withScope(this.db, scope, async (trx) => {
      const spent = await trx
        .selectFrom('session')
        .select(['id', 'account_id', 'revoked_at', 'revoked_reason'])
        .where(
          sql<boolean>`(prev_refresh_hash = ${presented} or ${presented} = any(grace_hashes) or id = ${named})`,
        )
        .forUpdate()
        .executeTakeFirst();
      if (!spent) return { why: 'revoked' as const, phones: [] };
      // A session that has already ended says why, not "reused".
      if (spent.revoked_at) return { why: endReasonOf(spent.revoked_reason), phones: [] };
      const revoked = await trx
        .updateTable('session')
        .set({ revoked_at: new Date(), revoked_reason: 'refresh token reuse' })
        .where('id', '=', spent.id)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (Number(revoked.numUpdatedRows) !== 1) return { why: 'revoked' as const, phones: [] };
      // Its devices go with it; its phones are told once this commits.
      const phones = await endDevices(trx, {
        accountId: spent.account_id,
        sessionIds: [spent.id],
      });
      await appendAudit(trx, {
        householdId,
        action: 'auth.session_revoked',
        objectType: 'session',
        objectId: spent.id,
        detail: { reason: 'refresh token reuse' },
        ip: meta.ip,
      });
      return { why: 'reused' as const, phones };
    });
    await this.tellEnded(householdId, ended.phones);
    return ended.why;
  }

  /** "You were signed out", to the phones of sessions that just ended (4.13). */
  private async tellEnded(householdId: string, phones: PushTarget[]): Promise<void> {
    if (phones.length > 0)
      await this.push({ householdId, message: SESSION_ENDED, targets: phones });
  }

  /** Verifies a bearer token and confirms its session is still open. */
  async authenticate(bearer: string): Promise<Principal> {
    let claims: AccessClaims;
    try {
      claims = await verifyAccessToken(this.signingKey, bearer);
    } catch {
      throw new ApiError(401, 'unauthenticated', 'Please sign in.');
    }
    // The role is read from the household and not from the token. An
    // access token lasts fifteen minutes and a role change has to take
    // effect now: somebody just made an owner should not be told they
    // cannot, and somebody just removed from the household has no row
    // here and so has no session either. Until this answers, the bearer
    // is nobody yet.
    const scope = { householdId: claims.hid, actor: ANONYMOUS };
    const open = await withScope(this.db, scope, (trx) =>
      trx
        .selectFrom('session')
        .innerJoin('account_household', (j) =>
          j
            .onRef('account_household.account_id', '=', 'session.account_id')
            .onRef('account_household.household_id', '=', 'session.household_id'),
        )
        .select([
          'session.id',
          'account_household.role',
          'account_household.member_id',
          'account_household.suspended_at',
          'account_household.suspended_until',
        ])
        .where('session.id', '=', claims.sid)
        .where('session.revoked_at', 'is', null)
        .executeTakeFirst(),
    );
    if (!open) throw await this.whyEnded(claims.hid, claims.sid);
    // Locked, or paused after a restore (5.28): its sessions ended with it,
    // and any that did not (opened at that very moment, or written by hand)
    // answers nothing.
    if (suspensionInEffect(open)) throw sessionEnded('membership suspended', 'suspended');
    return {
      accountId: claims.sub,
      sessionId: claims.sid,
      householdId: claims.hid,
      memberId: open.member_id,
      role: open.role,
    };
  }

  /** Why a session that no longer authenticates ended, for the 401. */
  private async whyEnded(householdId: string, sessionId: string): Promise<ApiError> {
    const row = await withScope(this.db, { householdId, actor: ANONYMOUS }, (trx) =>
      trx
        .selectFrom('session')
        .select(['revoked_at', 'revoked_reason'])
        .where('id', '=', sessionId)
        .executeTakeFirst(),
    );
    if (!row) return sessionEnded('session revoked', 'revoked');
    // Not revoked, yet no membership joins it: the person left the household.
    if (!row.revoked_at) return sessionEnded('membership removed', 'removed');
    return sessionEnded('session revoked', endReasonOf(row.revoked_reason));
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
    return withPrincipal(this.db, p, (trx) =>
      trx
        .selectFrom('session')
        .select([
          'id',
          'user_agent',
          'ip',
          'created_at',
          'last_used_at',
          'installation_id',
          'offline_expires_at',
        ])
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
        client: clientOf(r.installation_id, r.user_agent),
        label: describeDevice(r.user_agent ?? 'unknown'),
        // It keeps Essentials for offline use (0.4.13): its grant is in force.
        offline:
          r.offline_expires_at !== null && new Date(r.offline_expires_at).getTime() > Date.now(),
      })),
    );
  }

  async revokeSession(p: Principal, sessionId: string, meta: RequestMeta, reason: string) {
    const phones = await withPrincipal(this.db, p, async (trx) => {
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
      // Signed out or revoked: nothing more is pushed to it (4.13).
      return endDevices(trx, { accountId: p.accountId, sessionIds: [sessionId] });
    });
    await this.tellEnded(p.householdId, phones);
  }
}

/**
 * Whether the one-time replay of a refresh token is allowed (0.4.11): the
 * token just replaced, within 30 seconds of that, the first replay since,
 * and from the client that spent it — the app installation that holds the
 * session, or, for a browser (which has no installation id), the same user
 * agent from the same address as the refresh that spent it (0.5.12).
 */
export function graceAllows(
  s: {
    rotated_at: Date | null;
    grace_used_at: Date | null;
    installation_id: string | null;
    user_agent: string | null;
    ip: string | null;
    revoked_at: Date | null;
  },
  meta: RequestMeta,
  now: Date,
): boolean {
  // The same client that spent the token: an app says which installation
  // it is; a browser says nothing of the kind, so it is the browser with
  // the session's user agent, at the address the token was spent from
  // (5.14: a page reloaded while its refresh was on the way lost the
  // answer, and with it the session).
  const sameClient =
    s.installation_id !== null
      ? meta.installationId === s.installation_id
      : !meta.installationId &&
        s.user_agent !== null &&
        meta.userAgent === s.user_agent &&
        s.ip !== null &&
        meta.ip === s.ip;
  return (
    s.revoked_at === null &&
    s.rotated_at !== null &&
    now.getTime() - s.rotated_at.getTime() <= REFRESH_GRACE_MS &&
    s.grace_used_at === null &&
    sameClient
  );
}

/** What kind of thing holds a session: an app installation, a browser, or neither that we can tell. */
export function clientOf(
  installationId: string | null,
  agent: string | null,
): 'app' | 'browser' | 'other' {
  if (installationId) return 'app';
  if (agent && /^mozilla\//i.test(agent)) return 'browser';
  return 'other';
}

/**
 * "Name/1.2.3 (Android 15; Google Pixel 8a)": an app, on a device it names.
 * No two parts can match the same characters, so it runs in linear time
 * whatever a client sends; the name is trimmed afterwards.
 */
const APP_AGENT =
  /^[A-Za-z][\w.-]{0,40}\/\d[\w.-]{0,20} ?\( ?(?:android|ios|ipados)[^;)]{0,40};([^;)]{1,60})\)/i;
/**
 * What a device may be called in an alert: a model name, and nothing that
 * reads as a sentence. The alert exists for a stolen password, and its
 * holder must not get to write what it says.
 */
const DEVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,39}$/;

/**
 * A user agent in words a person recognises. Deliberately coarse: the
 * point is "a phone" or "this computer", not a version number. An app's
 * own user agent names the device it runs on: "the app on a Google Pixel
 * 8a" — whichever app it is, as no app's name is written in here.
 */
export function describeDevice(fullAgent: string): string {
  // Everything worth reading is at the start; a longer one is not a device's.
  const agent = fullAgent.slice(0, 256);
  const app = APP_AGENT.exec(agent);
  if (app && !/^mozilla\//i.test(agent)) {
    const device = (app[1] ?? '').trim();
    if (!DEVICE_NAME.test(device) || /^unknown/i.test(device)) return 'the app on a phone';
    return `the app on ${/^[aeiou]/i.test(device) ? 'an' : 'a'} ${device}`;
  }
  const a = agent.toLowerCase();
  const browser = a.includes('firefox')
    ? 'Firefox'
    : a.includes('edg/')
      ? 'Edge'
      : a.includes('chrome') && !a.includes('chromium')
        ? 'Chrome'
        : a.includes('safari')
          ? 'Safari'
          : null;
  const platform = a.includes('iphone')
    ? 'an iPhone'
    : a.includes('ipad')
      ? 'an iPad'
      : a.includes('android')
        ? 'an Android phone'
        : a.includes('mac os')
          ? 'a Mac'
          : a.includes('windows')
            ? 'a Windows computer'
            : a.includes('linux')
              ? 'a Linux computer'
              : null;
  if (browser && platform) return `${browser} on ${platform}`;
  if (platform) return platform;
  if (browser) return browser;
  return 'a device we could not recognise';
}
