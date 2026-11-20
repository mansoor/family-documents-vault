import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { withPrincipal, type Db } from '@fdv/db';
import { sql } from 'kysely';
import { appendAudit } from '@fdv/db';
import { ApiError } from '../errors.js';
import {
  stillSignedIn,
  type AuthService,
  type Principal,
  type RequestMeta,
  type Tokens,
} from './service.js';

/**
 * Passkeys: the primary credential, with the password kept as the fallback
 * (design decision, not a preference).
 *
 * Two things make a passkey worth the machinery. It cannot be phished —
 * the authenticator checks the origin itself, so a convincing copy of the
 * sign-in page gets nothing — and there is no shared secret to steal from
 * the server: what is stored here is a public key.
 *
 * A challenge is remembered in the database rather than carried in a
 * signed token, because the property that matters is that the server
 * accepts each one exactly once.
 */

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export interface PasskeyView {
  id: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  /** True when the passkey is synced to the owner's cloud keychain. */
  backed_up: boolean | null;
  /** The session that is using this passkey right now, if any. */
  transports: string[];
}

export interface PasskeyConfig {
  /** The domain passkeys are bound to — the vault's hostname, nothing else. */
  rpId: string;
  /** The exact origin the browser must report. */
  origin: string;
  displayName: string;
}

/** The vault's own name and origin, derived from where it is published. */
export function passkeyConfig(baseUrl: string, displayName: string, rpIdOverride?: string) {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`FDV_BASE_URL is not a URL: ${baseUrl}`);
  }
  return {
    rpId: rpIdOverride ?? url.hostname,
    origin: url.origin,
    displayName,
  } satisfies PasskeyConfig;
}

export class PasskeyService {
  constructor(
    private readonly db: Db,
    private readonly auth: AuthService,
    private readonly config: PasskeyConfig,
  ) {}

  // ------------------------------------------------------------ registering

  /** Options for creating a passkey on this device, for someone signed in. */
  async startRegistration(p: Principal) {
    const account = await this.db
      .selectFrom('account')
      .select(['id', 'email'])
      .where('id', '=', p.accountId)
      .executeTakeFirstOrThrow();
    const existing = await this.credentials(p.accountId);

    const options = await generateRegistrationOptions({
      rpName: this.config.displayName,
      rpID: this.config.rpId,
      userName: account.email,
      userDisplayName: account.email,
      // A passkey the browser can find without being told who is signing in,
      // and one that asks for a PIN, a fingerprint or a face (0.9.0): a
      // passkey is a whole sign-in, and counts as two-step sign-in, so a
      // key that only knows it was touched is not enough.
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
      },
      // Do not let the same authenticator enrol twice.
      excludeCredentials: existing.map((c) => ({
        id: base64url(c.credential_id as Buffer),
        transports: c.transports as never,
      })),
      attestationType: 'none',
    });

    await this.rememberChallenge(options.challenge, 'register', p.accountId);
    return options;
  }

  /** Checks what the authenticator produced and keeps the public key. */
  async finishRegistration(
    p: Principal,
    response: RegistrationResponseJSON,
    label: string | null,
    meta: RequestMeta,
  ): Promise<PasskeyView> {
    const challenge = await this.takeChallenge('register', p.accountId, response);

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: this.config.origin,
        expectedRPID: this.config.rpId,
        requireUserVerification: true,
      });
    } catch (err) {
      throw new ApiError(400, 'passkey_rejected', explain(err));
    }
    if (!verification.verified || !verification.registrationInfo) {
      throw new ApiError(400, 'passkey_rejected', 'That passkey could not be verified.');
    }

    const { credential, aaguid, credentialBackedUp } = verification.registrationInfo;
    const row = await withPrincipal(this.db, p, async (trx) => {
      // From a session still live (5.29): a passkey added by a session that
      // a reset ended while this waited would outlast the reset.
      await stillSignedIn(trx, p);
      const made = await trx
        .insertInto('credential')
        .values({
          account_id: p.accountId,
          kind: 'passkey',
          credential_id: Buffer.from(credential.id, 'base64url'),
          public_key: Buffer.from(credential.publicKey),
          sign_count: credential.counter,
          transports: credential.transports ?? [],
          backed_up: credentialBackedUp,
          aaguid: aaguid ?? null,
          label: label?.trim() || null,
          // Its PIN or fingerprint was asked for (requireUserVerification).
          user_verified: true,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      // Making it was a passkey given, PIN and all: this session has
      // presented two-step sign-in (0.9.0). Fresh, as
      // any passkey given is, for five minutes.
      await trx
        .updateTable('session')
        .set({ factor_verified_at: new Date() })
        .where('id', '=', p.sessionId)
        .execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'credential.passkey_added',
        objectType: 'credential',
        objectId: made.id,
        detail: { label: made.label },
        ip: meta.ip,
      });
      return made;
    });
    return view(row);
  }

  // --------------------------------------------------------- authenticating

  /**
   * Options for signing in. With an email we can name the passkeys that
   * would work; without one the browser offers whatever it holds for this
   * site, and the server learns who it is only from the answer.
   */
  async startAuthentication(email?: string) {
    let accountId: string | null = null;
    let allow: Array<{ id: string; transports?: string[] }> = [];
    if (email) {
      const account = await this.db
        .selectFrom('account')
        .select(['id'])
        .where('email', '=', email)
        .executeTakeFirst();
      if (account) {
        accountId = account.id;
        allow = (await this.credentials(account.id)).map((c) => ({
          id: base64url(c.credential_id as Buffer),
          transports: c.transports,
        }));
      }
      // An unknown address still gets options back. Answering "no passkeys
      // here" would turn this into a way to test whether an address has an
      // account.
    }

    // A PIN, a fingerprint or a face, every time (0.9.0): a passkey made
    // before that without one still works where its device can ask for one
    // (the browser asks), and is refused where it cannot.
    const options = await generateAuthenticationOptions({
      rpID: this.config.rpId,
      userVerification: 'required',
      allowCredentials: allow,
    });
    await this.rememberChallenge(options.challenge, 'authenticate', accountId);
    return options;
  }

  /** Verifies the assertion and opens a session. */
  async finishAuthentication(
    response: AuthenticationResponseJSON,
    meta: RequestMeta,
  ): Promise<Tokens> {
    const credentialId = credentialIdOf(response);
    if (!credentialId) throw rejected();
    const credential = await this.db
      .selectFrom('credential')
      .selectAll()
      .where('kind', '=', 'passkey')
      .where('credential_id', '=', credentialId)
      .executeTakeFirst();
    if (!credential || !credential.public_key) throw rejected();

    const challenge = await this.takeChallenge('authenticate', credential.account_id, response);

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: this.config.origin,
        expectedRPID: this.config.rpId,
        requireUserVerification: true,
        credential: {
          id: response.id,
          publicKey: new Uint8Array(credential.public_key),
          counter: Number(credential.sign_count ?? 0),
          transports: credential.transports,
        },
      });
    } catch (err) {
      // The library checks the signature counter itself and refuses one
      // that has gone backwards. That case deserves its own sentence: it
      // means the key may have been copied, and "try again" is the wrong
      // advice.
      if (/counter/i.test(err instanceof Error ? err.message : '')) {
        throw new ApiError(
          401,
          'passkey_rejected',
          'That passkey looks like a copy. Sign in another way and remove it.',
        );
      }
      if (unverified(err)) throw new ApiError(401, 'passkey_rejected', NOT_VERIFIED);
      throw rejected();
    }
    if (!verification.verified) throw rejected();

    await this.db
      .updateTable('credential')
      .set({
        sign_count: verification.authenticationInfo.newCounter,
        last_used_at: new Date(),
        // Used with its PIN or fingerprint (required since 0.9.0): a factor.
        user_verified: true,
      })
      .where('id', '=', credential.id)
      .execute();

    // Which passkey, checked again where the session opens (5.29).
    return this.auth.openSessionForAccount(credential.account_id, meta, 'passkey', {
      passkey: credential.id,
    });
  }

  /**
   * The same check as signing in, but for someone already here: it proves
   * the device is present without opening a new session (SEC-17).
   */
  async verifyForAccount(accountId: string, response: AuthenticationResponseJSON): Promise<void> {
    const credentialId = credentialIdOf(response);
    if (!credentialId) throw rejected();
    const credential = await this.db
      .selectFrom('credential')
      .selectAll()
      .where('kind', '=', 'passkey')
      .where('credential_id', '=', credentialId)
      .where('account_id', '=', accountId)
      .executeTakeFirst();
    if (!credential?.public_key) throw rejected();
    const challenge = await this.takeChallenge('authenticate', accountId, response);
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: this.config.origin,
        expectedRPID: this.config.rpId,
        requireUserVerification: true,
        credential: {
          id: response.id,
          publicKey: new Uint8Array(credential.public_key),
          counter: Number(credential.sign_count ?? 0),
          transports: credential.transports,
        },
      });
    } catch (err) {
      if (unverified(err)) throw new ApiError(401, 'passkey_rejected', NOT_VERIFIED);
      throw rejected();
    }
    if (!verification.verified) throw rejected();
    await this.db
      .updateTable('credential')
      .set({
        sign_count: verification.authenticationInfo.newCounter,
        last_used_at: new Date(),
        // Used with its PIN or fingerprint (required since 0.9.0): a factor.
        user_verified: true,
      })
      .where('id', '=', credential.id)
      .execute();
  }

  // ---------------------------------------------------------------- listing

  async list(p: Principal): Promise<PasskeyView[]> {
    return (await this.credentials(p.accountId)).map(view);
  }

  async remove(p: Principal, id: string, meta: RequestMeta): Promise<void> {
    const row = await this.db
      .selectFrom('credential')
      .selectAll()
      .where('id', '=', id)
      .where('account_id', '=', p.accountId)
      .where('kind', '=', 'passkey')
      .executeTakeFirst();
    if (!row) throw new ApiError(404, 'not_found', 'There is no passkey by that name here.');

    await this.db.deleteFrom('credential').where('id', '=', row.id).execute();
    await withPrincipal(this.db, p, (trx) =>
      appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'credential.passkey_removed',
        objectType: 'credential',
        objectId: row.id,
        detail: { label: row.label },
        ip: meta.ip,
      }),
    );
  }

  /** True when this account holds at least one passkey (SEC-03). */
  async has(accountId: string): Promise<boolean> {
    return (await this.credentials(accountId)).length > 0;
  }

  // --------------------------------------------------------------- internals

  private async credentials(accountId: string) {
    return this.db
      .selectFrom('credential')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('kind', '=', 'passkey')
      .orderBy('created_at')
      .execute();
  }

  private async rememberChallenge(
    challenge: string,
    purpose: 'register' | 'authenticate',
    accountId: string | null,
  ): Promise<void> {
    await this.db
      .insertInto('webauthn_challenge')
      .values({
        challenge: Buffer.from(challenge, 'base64url'),
        purpose,
        account_id: accountId,
        expires_at: new Date(Date.now() + CHALLENGE_TTL_MS),
      })
      .execute();
    // Old challenges are worthless; clearing them here keeps the table from
    // being a place rows go to live forever.
    await this.db
      .deleteFrom('webauthn_challenge')
      .where('expires_at', '<', new Date(Date.now() - CHALLENGE_TTL_MS))
      .execute();
  }

  /**
   * The challenge the answer was signed over (its `clientDataJSON`), if the
   * vault issued it for this purpose and it is unused and unexpired, marked
   * used in the same statement so that two requests racing cannot both have
   * it. Found by its value, never as "the newest" (0.9.0): somebody asking
   * for challenges over and over cannot make another person's sign-in or
   * step-up fail. One the vault never issued (for this account) is refused
   * as a passkey not accepted; one used or run out, `challenge_expired`.
   */
  private async takeChallenge(
    purpose: 'register' | 'authenticate',
    accountId: string | null,
    response: { response?: { clientDataJSON?: unknown } },
  ): Promise<string> {
    const signed = signedChallenge(response);
    if (!signed) throw rejected();
    // A sign-in challenge issued without an email belongs to whoever
    // answers it; one issued for an account belongs to that account.
    const mine = accountId
      ? sql`(account_id = ${accountId}::uuid or account_id is null)`
      : sql`account_id is null`;
    const rows = await sql<{ challenge: Buffer }>`
      update webauthn_challenge set used_at = now()
       where id = (
         select id from webauthn_challenge
          where challenge = ${signed}
            and purpose = ${purpose}
            and used_at is null
            and expires_at > now()
            and ${mine}
          limit 1
       )
      returning challenge`.execute(this.db);

    const row = rows.rows[0];
    if (!row) {
      const known = await sql<{ id: string }>`
        select id from webauthn_challenge
         where challenge = ${signed} and purpose = ${purpose} and ${mine}
         limit 1`.execute(this.db);
      if (known.rows.length === 0) throw rejected();
      throw new ApiError(
        400,
        'challenge_expired',
        'That took too long, or it was already used. Try again.',
      );
    }
    return row.challenge.toString('base64url');
  }
}

const rejected = () =>
  new ApiError(401, 'passkey_rejected', 'That passkey was not accepted. Try again.');

/**
 * The credential a sign-in or a step-up names, or null for a response that
 * names none: refused as any passkey not accepted, never a server error
 * (the Phase 5 exit found `{ "response": {} }` answered 500 on a public route).
 */
/**
 * The challenge a passkey's answer was signed over, from its client data:
 * null for an answer that carries none readable.
 */
function signedChallenge(response: { response?: { clientDataJSON?: unknown } }): Buffer | null {
  const data = response?.response?.clientDataJSON;
  if (typeof data !== 'string' || data.length === 0 || data.length > 4096) return null;
  try {
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as {
      challenge?: unknown;
    };
    return typeof parsed.challenge === 'string' && parsed.challenge.length > 0
      ? Buffer.from(parsed.challenge, 'base64url')
      : null;
  } catch {
    return null;
  }
}

function credentialIdOf(response: AuthenticationResponseJSON): Buffer | null {
  const id = (response as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'string' && id.length > 0 ? Buffer.from(id, 'base64url') : null;
}

/** A passkey that did not ask for a PIN, a fingerprint or a face (0.9.0). */
const NOT_VERIFIED =
  'That passkey did not ask for your PIN, fingerprint or face, which the vault needs. Use one that does: your phone’s or computer’s own, or a security key with a PIN set.';
const unverified = (err: unknown) =>
  /user verification|user could not be verified/i.test(err instanceof Error ? err.message : '');

function explain(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (unverified(err)) return NOT_VERIFIED;
  if (/origin/i.test(message)) {
    return 'This passkey was made for a different address for the vault. Open the vault at the address you set it up with.';
  }
  if (/RP ID/i.test(message)) {
    return 'This passkey belongs to a different site.';
  }
  return 'That passkey could not be verified. Try again.';
}

function base64url(b: Buffer): string {
  return b.toString('base64url');
}

function view(row: {
  id: string;
  label: string | null;
  created_at: Date;
  last_used_at: Date | null;
  backed_up: boolean | null;
  transports: string[];
}): PasskeyView {
  return {
    id: row.id,
    label: row.label,
    created_at: row.created_at.toISOString(),
    last_used_at: row.last_used_at?.toISOString() ?? null,
    backed_up: row.backed_up,
    transports: row.transports,
  };
}
