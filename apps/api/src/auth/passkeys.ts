import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { withScope, type Db } from '@fdv/db';
import { sql } from 'kysely';
import { appendAudit } from '@fdv/db';
import { ApiError } from '../errors.js';
import type { AuthService, Principal, RequestMeta, Tokens } from './service.js';

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
      // A passkey the browser can find without being told who is signing in.
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
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
    const challenge = await this.takeChallenge('register', p.accountId);

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: this.config.origin,
        expectedRPID: this.config.rpId,
        requireUserVerification: false,
      });
    } catch (err) {
      throw new ApiError(400, 'passkey_rejected', explain(err));
    }
    if (!verification.verified || !verification.registrationInfo) {
      throw new ApiError(400, 'passkey_rejected', 'That passkey could not be verified.');
    }

    const { credential, aaguid, credentialBackedUp } = verification.registrationInfo;
    const row = await this.db
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
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await withScope(this.db, { householdId: p.householdId, accountId: p.accountId }, (trx) =>
      appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'credential.passkey_added',
        objectType: 'credential',
        objectId: row.id,
        detail: { label: row.label },
        ip: meta.ip,
      }),
    );
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

    const options = await generateAuthenticationOptions({
      rpID: this.config.rpId,
      userVerification: 'preferred',
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
    const credentialId = Buffer.from(response.id, 'base64url');
    const credential = await this.db
      .selectFrom('credential')
      .selectAll()
      .where('kind', '=', 'passkey')
      .where('credential_id', '=', credentialId)
      .executeTakeFirst();
    if (!credential || !credential.public_key) throw rejected();

    const challenge = await this.takeChallenge('authenticate', credential.account_id);

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: this.config.origin,
        expectedRPID: this.config.rpId,
        requireUserVerification: false,
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
      throw rejected();
    }
    if (!verification.verified) throw rejected();

    await this.db
      .updateTable('credential')
      .set({
        sign_count: verification.authenticationInfo.newCounter,
        last_used_at: new Date(),
      })
      .where('id', '=', credential.id)
      .execute();

    return this.auth.openSessionForAccount(credential.account_id, meta, 'passkey');
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
    await withScope(this.db, { householdId: p.householdId, accountId: p.accountId }, (trx) =>
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
   * The newest unused challenge for this purpose, marked used in the same
   * statement so that two requests racing cannot both have it.
   */
  private async takeChallenge(
    purpose: 'register' | 'authenticate',
    accountId: string | null,
  ): Promise<string> {
    // Claimed in one statement: two requests racing for the same challenge
    // must not both get it. A sign-in challenge issued without an email
    // belongs to whoever answers it; one issued for an account belongs to
    // that account.
    const mine = accountId
      ? sql`(account_id = ${accountId}::uuid or account_id is null)`
      : sql`account_id is null`;
    const rows = await sql<{ challenge: Buffer }>`
      update webauthn_challenge set used_at = now()
       where id = (
         select id from webauthn_challenge
          where purpose = ${purpose}
            and used_at is null
            and expires_at > now()
            and ${mine}
          order by created_at desc
          limit 1
       )
      returning challenge`.execute(this.db);

    const row = rows.rows[0];
    if (!row) {
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

function explain(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
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
