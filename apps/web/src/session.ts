import {
  SessionCore,
  type CrossContextLock,
  type StoredSession,
  type TokenResult,
  type TokenStore,
} from '@fdv/client';
import { api, type Tokens } from './api.js';
import { disable as disablePush } from './push.js';

/**
 * Holds the signed-in session for the web app: `@fdv/client`'s session
 * core over localStorage.
 *
 * The refresh token is kept in localStorage so the app survives a reload;
 * the access token lives in memory only and is renewed through the
 * refresh endpoint — once at a time, however many screens ask at once
 * (see `SessionCore`). Everything storage-related is wrapped, because
 * private windows and blocked site data make localStorage throw.
 */

const KEY = 'fdv.session';

export type { StoredSession } from '@fdv/client';

function read(): StoredSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

function write(s: StoredSession | null) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    // storage unavailable: the session simply does not persist across reloads
  }
}

const localStorageStore: TokenStore = {
  load: async () => read(),
  save: async (s) => write(s),
};

/**
 * Tabs of the vault share one session in localStorage, so they take turns
 * refreshing it: a tab that waited reads the token the other just saved,
 * rather than presenting a spent one and ending the session for both.
 * Web Locks exist only in secure contexts (https, or localhost); on plain
 * http over the LAN the store is still re-read before every refresh.
 */
const tabLock: CrossContextLock | undefined =
  typeof navigator !== 'undefined' && 'locks' in navigator
    ? <T>(fn: () => Promise<T>): Promise<T> =>
        // Typed as Promise<Promise<T>> for an async callback; it resolves to T.
        navigator.locks.request('fdv.refresh', fn) as unknown as Promise<T>
    : undefined;

/**
 * The signed-in role, for deciding what to put on the screen.
 *
 * It is a plain function rather than something off the context because
 * `ui.tsx` needs it, and `ui.tsx` cannot import the context without a
 * cycle. Nothing is trusted to it: the server refuses regardless, and
 * this only decides whether a button that would be refused is drawn.
 */
export function storedRole(): Tokens['role'] {
  return read()?.role ?? 'viewer';
}

export class Session {
  // localStorage can be read at once, so the web starts already knowing
  // whether anybody is signed in; a phone calls hydrate() instead.
  private readonly core = new SessionCore(api, localStorageStore, {
    initial: read(),
    ...(tabLock ? { lock: tabLock } : {}),
  });

  get signedIn(): boolean {
    return this.core.signedIn;
  }

  get info(): StoredSession | null {
    return this.core.info;
  }

  accept(tokens: Tokens) {
    // The in-memory half is set before this returns; the store write is
    // localStorage, which is synchronous underneath.
    void this.core.accept(tokens);
  }

  clear() {
    void this.core.clear();
  }

  /** A usable access token — or why there is not one. */
  token(): Promise<TokenResult> {
    return this.core.token();
  }

  async signOut() {
    const r = await this.token();
    if (r.kind === 'ok') {
      // This browser stops being told things before the sign-in ends, so
      // the next person to use it is not sent the last one's digest.
      await disablePush(r.token).catch(() => undefined);
      await api.logout(r.token).catch(() => undefined);
    }
    this.clear();
  }
}
