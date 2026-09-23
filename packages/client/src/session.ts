import type { Role, Tokens } from '@fdv/shared';
import { ApiRequestError, isSessionOver } from './errors.js';

/**
 * A signed-in session, on any platform.
 *
 * The access token lives in memory; the refresh token and who it belongs
 * to live in a `TokenStore` the platform supplies — localStorage on the
 * web, the Keychain or Keystore on a phone.
 *
 * Two rules this exists to keep:
 *
 *  - **Exactly one refresh at a time.** The server rotates refresh tokens
 *    and treats the previous one, presented again, as theft: it ends the
 *    session. So five requests that all find the access token expired must
 *    share one refresh, or the second of them signs the person out. Until
 *    0.4.3 the web app did exactly that, on any screen that loaded two
 *    things at once after the token had lapsed.
 *  - **No answer is not "signed out".** A refresh that never reached the
 *    server keeps the stored session and reports `offline`. Only the
 *    server saying so ends a session.
 */

export interface StoredSession {
  refresh_token: string;
  household_id: string;
  member_id: string;
  role: Role;
}

export interface TokenStore {
  load(): Promise<StoredSession | null>;
  save(session: StoredSession | null): Promise<void>;
}

export type TokenResult =
  | { kind: 'ok'; token: string }
  | { kind: 'offline' }
  | { kind: 'ended'; reason: string }
  | { kind: 'signed_out' };

/** Refresh early, so a token does not expire on its way to the server. */
const EARLY_MS = 30_000;

export class SessionCore {
  private access: string | null = null;
  private accessExpiresAt = 0;
  private inflight: Promise<TokenResult> | null = null;

  constructor(
    private readonly refresher: { refresh(refreshToken: string): Promise<Tokens> },
    private readonly store: TokenStore,
    /**
     * What the store already holds, when the platform can read it without
     * waiting (localStorage can). Otherwise call `hydrate()`.
     */
    private stored: StoredSession | null = null,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async hydrate(): Promise<void> {
    this.stored = await this.store.load();
  }

  get signedIn(): boolean {
    return this.stored !== null;
  }

  get info(): StoredSession | null {
    return this.stored;
  }

  async accept(tokens: Tokens): Promise<void> {
    this.access = tokens.access_token;
    this.accessExpiresAt = this.now() + tokens.expires_in * 1000 - EARLY_MS;
    this.stored = {
      refresh_token: tokens.refresh_token,
      household_id: tokens.household_id,
      member_id: tokens.member_id,
      role: tokens.role,
    };
    await this.store.save(this.stored);
  }

  async clear(): Promise<void> {
    this.access = null;
    this.accessExpiresAt = 0;
    this.stored = null;
    await this.store.save(null);
  }

  /** A usable access token, refreshing when it has to — once, for everybody. */
  async token(): Promise<TokenResult> {
    if (this.access && this.now() < this.accessExpiresAt) return { kind: 'ok', token: this.access };
    if (!this.stored) return { kind: 'signed_out' };
    this.inflight ??= this.refreshOnce().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** The server said this session is over: forget it here too. */
  async end(err: unknown): Promise<TokenResult> {
    await this.clear();
    return { kind: 'ended', reason: reasonOf(err) };
  }

  private async refreshOnce(): Promise<TokenResult> {
    const stored = this.stored;
    if (!stored) return { kind: 'signed_out' };
    try {
      // Saved before anybody is handed the token: a crash between the two
      // must not leave the old, now-spent refresh token in the store.
      await this.accept(await this.refresher.refresh(stored.refresh_token));
      return { kind: 'ok', token: this.access as string };
    } catch (err) {
      // Somebody signed in afresh while this was in the air: their tokens
      // stand, whatever became of the old refresh. (Not `this.token()`:
      // that would wait on this very promise.)
      if (this.stored !== stored) {
        return this.access ? { kind: 'ok', token: this.access } : { kind: 'signed_out' };
      }
      if (isSessionOver(err) || (err instanceof ApiRequestError && err.status === 401)) {
        return this.end(err);
      }
      // No answer, a timeout, a 429 or a 5xx: the session is still good.
      return { kind: 'offline' };
    }
  }
}

function reasonOf(err: unknown): string {
  if (err instanceof ApiRequestError) return err.reason ?? err.code;
  return 'unknown';
}
