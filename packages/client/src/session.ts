import type { Role, Tokens } from '@fdv/shared';
import { ApiRequestError, isRetriableStatus, isSessionOver, NetworkError } from './errors.js';

/**
 * A signed-in session, on any platform.
 *
 * The access token lives in memory; the refresh token and who it belongs
 * to live in a `TokenStore` the platform supplies — localStorage on the
 * web, the Keychain or Keystore on a phone.
 *
 * Three rules this exists to keep:
 *
 *  - **Exactly one refresh at a time.** The server rotates refresh tokens
 *    and treats the previous one, presented again, as theft: it ends the
 *    session. So five requests that all find the access token expired must
 *    share one refresh, or the second of them signs the person out. Until
 *    0.4.3 the web app did exactly that, whenever Settings was reloaded.
 *  - **The store, not memory, holds the current refresh token.** Another
 *    tab, or a phone's share extension, may have rotated it since this
 *    copy of the app last looked, so it is read again before every
 *    refresh — inside a lock shared across those contexts, where the
 *    platform has one.
 *  - **No answer is not "signed out".** Only the vault saying so ends a
 *    session. A refresh that never reached it, or met a proxy rather than
 *    the vault, keeps the stored session and reports `offline`.
 *
 * And one kindness: a renewal the vault turns away for too many tries
 * (429) with a short Retry-After is waited out and asked again — at most
 * twice, and only for a wait of a minute or less — rather than reported
 * at once, when the next thing somebody does (a reload) spends another
 * try. It is never "signed out" (the PR #100 investigation).
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

/**
 * Runs `fn` while holding a lock shared by every context that uses the
 * same store (browser tabs: Web Locks; a phone app and its extension: a
 * keychain or file lock). Without one, refreshes are still re-read from
 * the store, which narrows the race to two contexts in the same instant.
 */
export type CrossContextLock = <T>(fn: () => Promise<T>) => Promise<T>;

export type TokenResult =
  | { kind: 'ok'; token: string }
  | {
      kind: 'offline';
      /**
       * The vault answered, and turned the renewal away for too many tries
       * (429): the session is still good. How long it asked for, in
       * seconds, when it said. Absent when there was no answer at all.
       */
      tooMany?: { retryAfterSeconds: number | null };
    }
  | { kind: 'ended'; reason: string }
  | { kind: 'signed_out' };

export interface SessionOptions {
  /** What the store already holds, when it can be read without waiting (localStorage can). */
  initial?: StoredSession | null;
  now?: () => number;
  lock?: CrossContextLock;
  /** How a wait is waited out: a timer, unless a test has a clock of its own. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Told when a renewal turned away for too many tries is waited out: the
   * seconds before it is asked again, and then null once it is.
   */
  onWait?: (seconds: number | null) => void;
}

/** A refused renewal is asked again at most this many times... */
export const RENEWAL_RETRIES = 2;
/** ...and only when the vault asked for no longer a wait than this, in seconds. */
export const RENEWAL_WAIT_MOST = 60;

/** Refresh early, so a token does not expire on its way to the server. */
const EARLY_MS = 30_000;

export class SessionCore {
  private access: string | null = null;
  private accessExpiresAt = 0;
  private inflight: Promise<TokenResult> | null = null;
  private stored: StoredSession | null;
  private readonly now: () => number;
  private readonly lock: CrossContextLock;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onWait: ((seconds: number | null) => void) | undefined;

  constructor(
    private readonly refresher: { refresh(refreshToken: string): Promise<Tokens> },
    private readonly store: TokenStore,
    options: SessionOptions = {},
  ) {
    this.stored = options.initial ?? null;
    this.now = options.now ?? (() => Date.now());
    this.lock = options.lock ?? ((fn) => fn());
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.onWait = options.onWait;
  }

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
    this.inflight ??= this.lock(() => this.refreshOnce()).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** The server said this session is over: forget it here too. */
  async end(err: unknown): Promise<TokenResult> {
    await this.clear();
    return { kind: 'ended', reason: reasonOf(err) };
  }

  /** Where things stand, without asking the server. */
  private current(): TokenResult {
    if (this.access && this.now() < this.accessExpiresAt) return { kind: 'ok', token: this.access };
    return this.stored ? { kind: 'offline' } : { kind: 'signed_out' };
  }

  private async refreshOnce(retried = 0): Promise<TokenResult> {
    const believed = this.stored;
    if (!believed) return { kind: 'signed_out' };
    // Another context may have rotated the refresh token, or signed out,
    // since this one last looked. The store is the truth.
    const latest = await this.store.load();
    if (this.stored !== believed) return this.current();
    if (!latest) {
      this.access = null;
      this.accessExpiresAt = 0;
      this.stored = null;
      return { kind: 'signed_out' };
    }
    const using = latest.refresh_token !== believed.refresh_token ? latest : believed;
    this.stored = using;

    let tokens: Tokens;
    try {
      tokens = await this.refresher.refresh(using.refresh_token);
    } catch (err) {
      // A sign-in or sign-out landed while this was in the air: it stands.
      if (this.stored !== using) return this.current();
      if (isSessionOver(err)) return this.end(err);
      if (err instanceof ApiRequestError && isVaultRefusal(err)) return this.end(err);
      if (err instanceof ApiRequestError && err.status === 429) {
        // Too many tries: the token was not spent. A short wait the vault
        // asked for is waited out — still holding the lock, so no other
        // context spends a try meanwhile — and the store read again, as
        // for any refresh. Never more than twice: never a loop.
        const wait = err.retryAfterSeconds;
        if (wait !== undefined && wait <= RENEWAL_WAIT_MOST && retried < RENEWAL_RETRIES) {
          this.onWait?.(wait);
          try {
            await this.sleep(wait * 1000);
          } finally {
            this.onWait?.(null);
          }
          // Signed in or out while it waited: that stands.
          if (this.stored !== using) return this.current();
          return this.refreshOnce(retried + 1);
        }
        return { kind: 'offline', tooMany: { retryAfterSeconds: wait ?? null } };
      }
      // No answer, a timeout, a 5xx, or an answer that was not the vault's
      // (a proxy's login page): the session is still good.
      return { kind: 'offline' };
    }
    // Likewise on success: tokens for a session that has since been
    // replaced or signed out are thrown away, not written over it.
    if (this.stored !== using) return this.current();
    await this.accept(tokens);
    return { kind: 'ok', token: this.access as string };
  }
}

/**
 * The vault itself refused this refresh token, in its own envelope, for a
 * reason that retrying will not change (a malformed or unknown token). Not
 * a 401 from something standing in front of the vault, and not a status
 * worth waiting out.
 */
function isVaultRefusal(err: ApiRequestError): boolean {
  if (err.code === 'http_error') return false;
  if (isRetriableStatus(err.status)) return false;
  return err.status >= 400 && err.status < 500 && err.status !== 401;
}

function reasonOf(err: unknown): string {
  if (err instanceof ApiRequestError) return err.reason ?? err.code;
  if (err instanceof NetworkError) return err.kind;
  return 'unknown';
}
