import { api, ApiRequestError, type Tokens } from './api.js';
import { disable as disablePush } from './push.js';

/**
 * Holds the signed-in session for the web app.
 *
 * The refresh token is kept in localStorage so the app survives a reload;
 * the access token lives in memory only and is renewed through the refresh
 * endpoint. Everything storage-related is wrapped, because private windows
 * and blocked site data make localStorage throw.
 */

const KEY = 'fdv.session';

export interface StoredSession {
  refresh_token: string;
  household_id: string;
  member_id: string;
  role: Tokens['role'];
}

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
  private access: string | null = null;
  private accessExpiresAt = 0;
  private stored: StoredSession | null = read();

  get signedIn(): boolean {
    return this.stored !== null;
  }

  get info(): StoredSession | null {
    return this.stored;
  }

  accept(tokens: Tokens) {
    this.access = tokens.access_token;
    this.accessExpiresAt = Date.now() + (tokens.expires_in - 30) * 1000;
    this.stored = {
      refresh_token: tokens.refresh_token,
      household_id: tokens.household_id,
      member_id: tokens.member_id,
      role: tokens.role,
    };
    write(this.stored);
  }

  clear() {
    this.access = null;
    this.accessExpiresAt = 0;
    this.stored = null;
    write(null);
  }

  /** A valid access token, refreshing when needed. Null when signed out. */
  async token(): Promise<string | null> {
    if (this.access && Date.now() < this.accessExpiresAt) return this.access;
    if (!this.stored) return null;
    try {
      this.accept(await api.refresh(this.stored.refresh_token));
      return this.access;
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) this.clear();
      return null;
    }
  }

  async signOut() {
    const t = await this.token();
    if (t) {
      // This browser stops being told things before the sign-in ends, so
      // the next person to use it is not sent the last one's digest.
      await disablePush(t).catch(() => undefined);
      await api.logout(t).catch(() => undefined);
    }
    this.clear();
  }
}
