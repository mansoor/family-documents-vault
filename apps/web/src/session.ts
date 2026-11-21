import {
  SessionCore,
  type CrossContextLock,
  type StoredSession,
  type TokenResult,
  type TokenStore,
} from '@fdv/client';
import { api, type Tokens } from './api.js';
import { forgetDrafts } from './note-drafts.js';
import { forgetFlyouts } from './flyout-store.js';
import { forgetAllPages } from './batch-pages.js';
import { clearPhotos } from './photos.js';
import { disable as disablePush } from './push.js';

/**
 * Holds the signed-in session for the web app: `@fdv/client`'s session
 * core over localStorage.
 *
 * Since 0.9.0 the refresh token is an HttpOnly cookie the vault sets
 * (path /api/v1/auth), which script on the page — anybody's, should a flaw
 * ever let some run — cannot read. localStorage keeps only who is signed in
 * (household, member, role), so the app knows at once whether to show the
 * sign-in page; the access token lives in memory only and is renewed
 * through the refresh endpoint, with the cookie — once at a time, however
 * many screens ask at once (see `SessionCore`). A refresh token a version
 * before 0.9.0 kept here is spent once, for a cookie, and forgotten.
 * Everything storage-related is wrapped, because private windows and
 * blocked site data make localStorage throw.
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
    // Never a refresh token: it is in the cookie (0.9.0). An empty one says
    // "the cookie's"; the one kept from before goes with this write.
    if (s) localStorage.setItem(KEY, JSON.stringify({ ...s, refresh_token: '' }));
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
 * A sign-out the vault could not be told of (0.9.0): the session its
 * cookie names still open there. Kept here, and sent as the app next loads,
 * before the sign-in page is shown (`flushPendingLogout`).
 */
const LOGOUT_PENDING = 'fdv.logout-pending';

function setLogoutPending(on: boolean) {
  try {
    if (on) localStorage.setItem(LOGOUT_PENDING, '1');
    else localStorage.removeItem(LOGOUT_PENDING);
  } catch {
    // storage unavailable: nothing to remember it in
  }
}

/** Signing out with the cookie; not reached, remembered for the next load. */
async function logoutByCookie(): Promise<void> {
  try {
    await api.logoutWithCookie();
    setLogoutPending(false);
  } catch {
    setLogoutPending(true);
  }
}

/**
 * The sign-out the vault was not told of, told now (0.9.0): as the app
 * loads, before it shows anything. Not reached again: kept for the next.
 */
export async function flushPendingLogout(): Promise<void> {
  let pending: boolean;
  try {
    pending = localStorage.getItem(LOGOUT_PENDING) === '1';
  } catch {
    pending = false;
  }
  if (!pending) return;
  try {
    await api.logoutWithCookie();
    setLogoutPending(false);
  } catch {
    // Still not reached: tried again next time.
  }
}

/**
 * Renewing the sign-in (0.9.0): with the cookie; or, once, with a refresh
 * token a version before kept in localStorage, which the vault answers
 * with a cookie — the token is then forgotten (`write`).
 */
const refresher = {
  refresh: (kept: string) => (kept ? api.refresh(kept) : api.refreshWithCookie()),
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
  /** Who is told while a renewal turned away for too many tries is waited out. */
  private readonly waitListeners = new Set<(seconds: number | null) => void>();
  // localStorage can be read at once, so the web starts already knowing
  // whether anybody is signed in; a phone calls hydrate() instead.
  private readonly core = new SessionCore(refresher, localStorageStore, {
    initial: read(),
    ...(tabLock ? { lock: tabLock } : {}),
    onWait: (seconds) => {
      for (const listen of this.waitListeners) listen(seconds);
    },
  });

  /**
   * Told the seconds a renewal waits, the vault having said too many tries
   * just now, and null once it is asked again. Returns the way to stop.
   */
  onWait(listen: (seconds: number | null) => void): () => void {
    this.waitListeners.add(listen);
    return () => this.waitListeners.delete(listen);
  }

  get signedIn(): boolean {
    return this.core.signedIn;
  }

  get info(): StoredSession | null {
    return this.core.info;
  }

  /**
   * The sign-in just accepted may only set up two-step sign-in, or sign out
   * (0.9.0, `Tokens.two_step_setup_required`), until the app says it is done.
   */
  twoStepSetup = false;

  /** Two-step sign-in is set up: this sign-in goes on. */
  twoStepDone() {
    this.twoStepSetup = false;
  }

  accept(tokens: Tokens) {
    this.twoStepSetup = tokens.two_step_setup_required === true;
    // A new sign-in's cookie replaced the one a sign-out could not end: the
    // next load must not end this one in its place (0.9.0).
    setLogoutPending(false);
    // A new sign-in starts with no notes half-written by the last one
    // (5.35, A32), and none of the last one's documents open beside the list.
    forgetDrafts();
    forgetFlyouts();
    // The in-memory half is set before this returns; the store write is
    // localStorage, which is synchronous underneath.
    void this.core.accept(tokens);
  }

  clear() {
    this.twoStepSetup = false;
    // People's photos are held in memory for the sign-in that fetched them
    // (5.17c), and a batch's first pages (I1): the next person at this
    // browser is not shown them. Nor the notes they had not saved (5.35, A32).
    clearPhotos();
    forgetAllPages();
    forgetDrafts();
    // Nor the documents they had open beside the list.
    forgetFlyouts();
    void this.core.clear();
  }

  /** A usable access token — or why there is not one. */
  async token(opts: { wait?: boolean } = {}): Promise<TokenResult> {
    const before = this.core.info;
    const r = await this.core.token(opts);
    const after = this.core.info;
    // A session that ended by itself — signed out on another device, taken
    // away, run out — takes its unsaved notes with it, as signing out does
    // (5.35, A32).
    if (r.kind === 'ended' || r.kind === 'signed_out') {
      forgetDrafts();
      forgetFlyouts();
    }
    // And one this tab took over from another tab, signed in there as
    // somebody else (the 5.35 review, W535-07): nothing of the last
    // person's stays — their unsaved notes, the photos fetched for them.
    if (
      before &&
      after &&
      (before.member_id !== after.member_id || before.household_id !== after.household_id)
    ) {
      forgetDrafts();
      forgetFlyouts();
      clearPhotos();
      forgetAllPages();
    }
    return r;
  }

  async signOut() {
    // Never behind a renewal waiting out "too many tries" (up to two
    // minutes; the review round): the access token while it lasts, or a
    // renewal that waits for nothing.
    const r = await this.token({ wait: false });
    if (r.kind === 'ok') {
      // This browser stops being told things before the sign-in ends, so
      // the next person to use it is not sent the last one's digest.
      await disablePush(r.token).catch(() => undefined);
      // Not reached, or refused: the cookie ends it instead (0.9.0).
      await api.logout(r.token).catch(() => logoutByCookie());
    } else if (this.core.signedIn) {
      // Without one (offline, or too many tries just now): the session the
      // cookie names is ended by the cookie (0.9.0).
      await logoutByCookie();
    }
    this.clear();
  }
}
