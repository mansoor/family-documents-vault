import type { Capabilities } from '@fdv/shared';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { StepUpCoordinator } from '@fdv/client';
import { api, ApiRequestError, isSessionOver, NetworkError, quiet } from './api.js';
import { onFamilyZoneHeard, setCurrentFamilyZone } from './family-zone-store.js';

/** The family's zone is asked again as the tab is come back to, at most this often. */
export const ZONE_ASK_AGAIN_MS = 60_000;
import { flushPendingLogout, Session } from './session.js';
import { StepUpPrompt } from './StepUpPrompt.js';
import { forgetAllPages } from './batch-pages.js';
import { clearPhotos } from './photos.js';
import { forgetDrafts } from './note-drafts.js';
import {
  LOCK_HINT_KEY,
  lockedHintFor,
  lockPendingFor,
  onLockHeard,
  setLockedHint,
  setLockPending,
} from './session-lock.js';

/** How often a lock not yet taken by the vault is sent again (0.9.0-dev.86). */
export const LOCK_RESEND_MS = 10_000;

/**
 * What every screen needs: the capability document, the session, and a
 * way to call the API with a fresh token that turns a lost session into a
 * redirect rather than a broken page.
 */

export const UNREACHABLE =
  "We can't reach the vault right now. Check that it is running, then reload.";

/**
 * The sign-in's renewal was turned away for too many tries (429), and not
 * waited out: the vault was reached, and the session is still good. Still
 * no answer to what was asked, so as offline it is treated — and said for
 * what it is, never "can't reach the vault… reload", as a reload spends
 * another try (the PR #100 investigation).
 */
export class TooManyTries extends NetworkError {
  constructor(retryAfterSeconds: number | null) {
    super('offline', tooManyWords(retryAfterSeconds));
    this.name = 'TooManyTries';
  }
}

/** "Too many tries just now. Try again in 2 minutes." */
export function tooManyWords(seconds: number | null): string {
  if (seconds === null) return 'Too many tries just now. Wait a minute, then try again.';
  const minutes = Math.ceil(seconds / 60);
  return seconds <= 90
    ? `Too many tries just now. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`
    : `Too many tries just now. Try again in ${minutes} minutes.`;
}

/** What is said while a renewal waits: "…; trying again in 12 seconds." */
export const waitingWords = (seconds: number) =>
  `Too many tries just now; trying again in ${seconds} second${seconds === 1 ? '' : 's'}.`;

export function describeError(err: unknown): string {
  if (err instanceof TooManyTries) return err.message;
  return err instanceof ApiRequestError ? err.message : UNREACHABLE;
}

interface AppState {
  caps: Capabilities | null;
  session: Session;
  /** Re-fetch capabilities (after setup, or on demand). */
  reloadCaps: () => Promise<void>;
  /** Calls `fn` with a valid token, or returns null and clears the session. */
  withToken: <T>(fn: (token: string) => Promise<T>) => Promise<T | null>;
  /**
   * Like `withToken`, but for the handful of actions that may ask for a
   * credential again (SEC-17): it opens the prompt, waits, and retries —
   * unless `cancelled` says the screen that asked has moved on by then.
   */
  guarded: <T>(
    fn: (token: string) => Promise<T>,
    opts?: { cancelled?: () => boolean },
  ) => Promise<T | null>;
  /** Bumped when the session signs in or out, so screens can re-render. */
  authVersion: number;
  markAuthChanged: () => void;
  connectionError: string | null;
  /**
   * The family's time zone in effect (0.9.0, TZ), once the vault has said
   * it for this sign-in: every time a screen shows is on it (family-time.tsx).
   * Null until known.
   */
  familyZone: string | null;
  /** Asks the vault for the family's zone, once a sign-in; screens call it through useFamilyZone. */
  wantFamilyZone: () => void;
  /** The family's zone as an owner has just changed it in Settings: every screen moves to it. */
  setFamilyZone: (zone: string) => void;
  /**
   * This sign-in must set up two-step sign-in before anything else (0.9.0):
   * an owner, or an adult where the household asks it, with neither a code
   * nor a passkey. The app shows only that, until it is set up.
   */
  twoStepSetup: boolean;
  /** Two-step sign-in is set up: the app goes on. */
  twoStepDone: () => void;
  /**
   * The vault is locked in this session (0.9.0-dev.86): the app shows the
   * lock screen and nothing else (App.tsx) until it is unlocked — as Lock
   * was pressed, any call heard `423 session_locked`, or another tab of
   * this browser locked it.
   */
  locked: boolean;
  /**
   * Lock: the page let go of at once, and the vault asked to keep it locked.
   * `away` (0.9.0-dev.87): it locked itself, its time with nobody using it
   * up, and the vault's line says so.
   */
  lock: (opts?: { away?: boolean }) => Promise<void>;
  /** Unlocked by a credential given on the lock screen: the app comes back. */
  unlocked: () => void;
  /** The lock screen asked the vault whether it is locked (`Me.locked`). */
  lockHeard: (vaultLocked: boolean) => void;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const session = useMemo(() => new Session(), []);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [authVersion, setAuthVersion] = useState(0);

  const reloadCaps = useCallback(async () => {
    try {
      // A sign-out the vault could not be told of, told first (0.9.0):
      // nothing is shown, the sign-in page included, until it has been tried.
      const [answer] = await Promise.all([api.capabilities(), flushPendingLogout()]);
      setCaps(answer);
      setConnectionError(null);
    } catch (err) {
      setConnectionError(describeError(err));
    }
  }, []);

  useEffect(() => {
    // Capabilities are fetched from the network; state is set in the callback.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reloadCaps();
  }, [reloadCaps]);

  const markAuthChanged = useCallback(() => setAuthVersion((v) => v + 1), []);

  // Two-step sign-in to set up before anything else (0.9.0): as the sign-in
  // said (session.twoStepSetup), or as any answer since has said.
  // Heard for whom: a later sign-in, somebody else's, is not held to it.
  const [twoStepHeardFor, setTwoStepHeardFor] = useState<string | null>(null);
  const setTwoStepHeard = useCallback(
    (heard: boolean) => setTwoStepHeardFor(heard ? (session.info?.member_id ?? null) : null),
    [session],
  );
  const twoStepSetup =
    session.signedIn &&
    (session.twoStepSetup ||
      (twoStepHeardFor !== null && twoStepHeardFor === session.info?.member_id));
  const twoStepDone = useCallback(() => {
    session.twoStepDone();
    setTwoStepHeard(false);
    markAuthChanged();
  }, [session, setTwoStepHeard, markAuthChanged]);

  // The family's clock (0.9.0, TZ): asked once a sign-in, as a screen first
  // needs it, and remembered on this device for the next visit, so a page
  // opened again shows its times on the family's clock from the start.
  const [familyZone, setZone] = useState<string | null>(() => {
    const remembered = rememberedZone(session);
    setCurrentFamilyZone(remembered);
    return remembered;
  });
  const zoneAsked = useRef<number | null>(null);
  const setFamilyZone = useCallback(
    (zone: string) => {
      setCurrentFamilyZone(zone);
      setZone(zone);
      rememberZone(session, zone);
    },
    [session],
  );

  const withToken = useCallback(
    async <T,>(fn: (token: string) => Promise<T>): Promise<T | null> => {
      const was = session.info;
      const got = await session.token();
      const now = session.info;
      // This tab took over another tab's sign-in, as somebody else (W535-07):
      // nothing asked as the last person goes ahead as the next, and the app
      // starts again for whoever it is now — an upload of many documents
      // stopped and forgotten with it (the I1 check).
      if (
        got.kind === 'ok' &&
        was &&
        now &&
        (was.member_id !== now.member_id || was.household_id !== now.household_id)
      ) {
        markAuthChanged();
        return null;
      }
      if (got.kind === 'offline') {
        // No answer is not "signed out": the session is kept, and the
        // screen that asked says the vault cannot be reached, rather than
        // showing an empty household as if there were nothing in it. Only
        // that screen: a blip must not wipe a half-filled form. Too many
        // tries is not "signed out" either, and is said as what it is.
        if (got.tooMany) throw new TooManyTries(got.tooMany.retryAfterSeconds);
        throw new NetworkError('offline');
      }
      if (got.kind !== 'ok') {
        markAuthChanged();
        return null;
      }
      try {
        return await fn(got.token);
      } catch (err) {
        // Not every 401 means the session is over. The API also answers
        // 401 when a credential presented *inside* a request was wrong —
        // a mistyped current password, a passkey that is not yours — and
        // signing somebody out for a typo is its own small betrayal.
        // Only the two codes that actually mean "this session is done"
        // end it; anything else is the caller's to show.
        if (isSessionOver(err)) {
          session.clear();
          markAuthChanged();
          return null;
        }
        // A sign-in that must set up two-step sign-in first (0.9.0): the
        // app shows that, and nothing else, until it is (App.tsx).
        if (err instanceof ApiRequestError && err.code === 'two_step_setup_required') {
          setTwoStepHeard(true);
        }
        throw err;
      }
    },
    [session, markAuthChanged, setTwoStepHeard],
  );

  // The step-up prompt is here rather than in a screen because any screen
  // can trigger it, and because the retry has to happen where the call was
  // made — otherwise the person confirms and then has to press the button
  // again themselves.
  const [asking, setAsking] = useState<{
    action: string;
    message: string;
    factor?: boolean;
    settle: (ok: boolean) => void;
  } | null>(null);

  // One prompt, however many requests ask at once: they all wait on it and
  // all carry on when it is answered. Until 0.4.3 a second request replaced
  // the first's prompt, and the first then waited for ever.
  const stepUp = useMemo(
    () =>
      new StepUpCoordinator(
        (req) =>
          new Promise<boolean>((settle) =>
            setAsking({
              ...req,
              settle: (ok) => {
                setAsking(null);
                settle(ok);
              },
            }),
          ),
      ),
    [],
  );

  // Lock (0.9.0-dev.86): whose session the lock screen is shown for. Known
  // at once on a reload, and in every tab, from this browser's note of it
  // (session-lock.ts); the vault decides, and says 423 to anything else.
  const [lockedFor, setLockedFor] = useState<string | null>(() =>
    lockedHintFor(session.info?.member_id) ? (session.info?.member_id ?? null) : null,
  );
  // Signed in or out since (another sign-in, the same person's too): as the
  // note says now — a sign-out forgets it, and a new session is not locked.
  const [lockAuth, setLockAuth] = useState(authVersion);
  if (lockAuth !== authVersion) {
    setLockAuth(authVersion);
    const member = session.info?.member_id ?? null;
    setLockedFor(lockedHintFor(member) ? member : null);
  }
  const locked =
    session.signedIn && lockedFor !== null && lockedFor === (session.info?.member_id ?? null);
  const lockedNowFor = useRef(lockedFor);
  useLayoutEffect(() => {
    lockedNowFor.current = lockedFor;
  });
  /**
   * The lock screen, now. `kept`: this browser's note of it written too, so
   * a reload and every other tab show it at once — when Lock was pressed
   * here, or the vault has said it is locked; never for a 423 alone, which
   * may be late (from before another tab unlocked): the lock screen asks.
   */
  const lockedNow = useCallback(
    (kept: boolean) => {
      const member = session.info?.member_id ?? null;
      if (!session.signedIn || !member) return;
      if (kept) setLockedHint(member);
      // Nothing of the page stays: the documents beside the list go with the
      // page they were drawn on (App.tsx draws the lock screen in its place);
      // people's photos, a batch's first pages and notes not yet saved are
      // let go of here.
      clearPhotos();
      forgetAllPages();
      forgetDrafts();
      lockedNowFor.current = member;
      setLockedFor(member);
    },
    [session],
  );
  // And in memory, for a browser whose storage is blocked.
  const pendingHere = useRef(false);
  // Whether the lock asked for was the page's own, its time up (0.9.0-dev.87).
  const awayHere = useRef(false);
  const pending = useCallback(
    () => pendingHere.current || lockPendingFor(session.info?.member_id),
    [session],
  );
  /** A lock asked for and not yet taken, sent again: forgotten once it is (204). */
  const sendLock = useCallback(async () => {
    if (!pending()) return;
    try {
      const got = await session.token({ wait: false });
      if (got.kind !== 'ok') return;
      await api.lock(got.token, awayHere.current ? { away: true } : {});
      pendingHere.current = false;
      awayHere.current = false;
      setLockPending(null);
    } catch {
      // Not reached: sent again when the browser is back online, or soon.
    }
  }, [session, pending]);
  const lock = useCallback(
    async (opts: { away?: boolean } = {}) => {
      pendingHere.current = true;
      awayHere.current = opts.away === true;
      setLockPending(session.info?.member_id ?? null);
      lockedNow(true);
      await sendLock();
    },
    [session, lockedNow, sendLock],
  );
  const unlocked = useCallback(() => {
    setLockedHint(null);
    pendingHere.current = false;
    awayHere.current = false;
    setLockPending(null);
    lockedNowFor.current = null;
    setLockedFor(null);
  }, []);
  /**
   * What the vault says as the lock screen is drawn: locked, and it is kept
   * so; not locked, the lock is sent again if one was asked for here and not
   * yet taken — otherwise the 423 that showed it was late, and the page
   * comes back.
   */
  const lockHeard = useCallback(
    (vaultLocked: boolean) => {
      const member = session.info?.member_id ?? null;
      if (vaultLocked) {
        if (member) setLockedHint(member);
      } else if (pending()) {
        void sendLock();
      } else {
        unlocked();
      }
    },
    [session, pending, sendLock, unlocked],
  );
  // Any call answered 423, from whichever screen.
  useEffect(() => onLockHeard(() => lockedNow(false)), [lockedNow]);
  // A lock not yet taken: sent again as the browser comes back online, and
  // every few seconds while the lock screen shows.
  useEffect(() => {
    if (!locked) return;
    const again = () => void sendLock();
    window.addEventListener('online', again);
    const timer = window.setInterval(again, LOCK_RESEND_MS);
    return () => {
      window.removeEventListener('online', again);
      window.clearInterval(timer);
    };
  }, [locked, sendLock]);
  // Another tab of this browser locked or unlocked the same session.
  useEffect(() => {
    const heard = (e: StorageEvent) => {
      if (e.key !== LOCK_HINT_KEY) return;
      const member = session.info?.member_id ?? null;
      if (member && e.newValue === member) lockedNow(false);
      else if (e.newValue === null && lockedNowFor.current !== null) {
        lockedNowFor.current = null;
        setLockedFor(null);
      }
    };
    window.addEventListener('storage', heard);
    return () => window.removeEventListener('storage', heard);
  }, [session, lockedNow]);
  // A confirmation asked for by a screen the lock took away: answered no.
  useEffect(() => {
    if (locked && asking) asking.settle(false);
  }, [locked, asking]);

  const guarded = useCallback(
    async <T,>(
      fn: (token: string) => Promise<T>,
      opts: { cancelled?: () => boolean } = {},
    ): Promise<T | null> => {
      try {
        return await withToken(fn);
      } catch (err) {
        if (!(err instanceof ApiRequestError) || err.code !== 'step_up_required') throw err;
        const confirmed = await stepUp.confirm({
          action: err.action ?? '',
          message: err.message,
          ...(err.factor ? { factor: true } : {}),
        });
        // Confirmed for something nobody is waiting for any more: not fetched.
        if (!confirmed || opts.cancelled?.()) return null;
        return await withToken(fn);
      }
    },
    [withToken, stepUp],
  );

  // When it was last asked: asked again as the tab is come back to, at most
  // once a minute (the TZ review), so a tab left open for days takes up an
  // owner's change made elsewhere.
  const zoneAskedAt = useRef(0);
  const askZone = useCallback(() => {
    zoneAskedAt.current = Date.now();
    // Asked by the page by itself, as the tab is come back to: not use (0.9.0-dev.87).
    return withToken((t) => quiet.profile(t)).then((p) => {
      if (p?.timezone) setFamilyZone(p.timezone);
    });
  }, [withToken, setFamilyZone]);

  const wantFamilyZone = useCallback(() => {
    if (zoneAsked.current === authVersion) return;
    zoneAsked.current = authVersion;
    // Not reached: asked again by the next screen that needs it.
    askZone().catch(() => {
      zoneAsked.current = null;
    });
  }, [authVersion, askZone]);

  // Whatever answer says the zone — the profile, the time zone's own, a
  // change just made — moves every screen to it (family-zone-store.ts).
  useEffect(() => onFamilyZoneHeard(setFamilyZone), [setFamilyZone]);

  useEffect(() => {
    const again = () => {
      if (document.visibilityState === 'hidden') return;
      // Only once a signed-in screen has asked for it this sign-in.
      if (zoneAsked.current !== authVersion) return;
      if (Date.now() - zoneAskedAt.current < ZONE_ASK_AGAIN_MS) return;
      askZone().catch(() => undefined);
    };
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', again);
    return () => {
      window.removeEventListener('focus', again);
      document.removeEventListener('visibilitychange', again);
    };
  }, [authVersion, askZone]);

  const value = useMemo<AppState>(
    () => ({
      caps,
      session,
      reloadCaps,
      withToken,
      guarded,
      authVersion,
      markAuthChanged,
      connectionError,
      familyZone,
      wantFamilyZone,
      setFamilyZone,
      twoStepSetup,
      twoStepDone,
      locked,
      lock,
      unlocked,
      lockHeard,
    }),
    [
      caps,
      session,
      reloadCaps,
      withToken,
      guarded,
      authVersion,
      markAuthChanged,
      connectionError,
      familyZone,
      wantFamilyZone,
      setFamilyZone,
      twoStepSetup,
      twoStepDone,
      locked,
      lock,
      unlocked,
      lockHeard,
    ],
  );
  return (
    <Ctx.Provider value={value}>
      {children}
      <RenewalWait session={session} />
      {asking && !locked && (
        <StepUpPrompt
          action={asking.action}
          message={asking.message}
          factor={asking.factor === true}
          onSettled={asking.settle}
        />
      )}
    </Ctx.Provider>
  );
}

/**
 * While a renewal turned away for too many tries is waited out (the session
 * core waits a short Retry-After, twice at most): said, with the seconds
 * counting down, where "can't reach the vault" would otherwise be all
 * anybody heard. Heard once as it starts; the count is for the eye.
 */
function RenewalWait({ session }: { session: Session }) {
  const [until, setUntil] = useState<{ at: number; seconds: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(
    () =>
      session.onWait((seconds) => {
        setNow(Date.now());
        setUntil(seconds === null ? null : { at: Date.now() + seconds * 1000, seconds });
      }),
    [session],
  );
  useEffect(() => {
    if (!until) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [until]);
  if (!until) return null;
  const left = Math.max(0, Math.ceil((until.at - now) / 1000));
  return (
    <div className="renewal-wait">
      <p className="visually-hidden" role="status">
        {waitingWords(until.seconds)}
      </p>
      <p aria-hidden="true">{waitingWords(left)}</p>
    </div>
  );
}

/** Where this device remembers the family's zone, by household. */
const zoneKey = (session: Session) => {
  const household = session.info?.household_id;
  return household ? `fdv.familyZone.${household}` : null;
};

function rememberedZone(session: Session): string | null {
  const key = zoneKey(session);
  if (!key) return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function rememberZone(session: Session, zone: string): void {
  const key = zoneKey(session);
  if (!key) return;
  try {
    window.localStorage.setItem(key, zone);
  } catch {
    // Private windows and blocked storage: asked again next time.
  }
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
}

/**
 * Loads data for a screen with the usual states. `deps` re-runs the load.
 * `guarded` (0.9.0-dev.87): what may ask to confirm it's you first — an Only
 * me or an Essential note's words — asks, and is loaded once it is;
 * `declined` says it was not, and `reload` asks again.
 */
export function useLoad<T>(
  load: (token: string) => Promise<T>,
  deps: unknown[],
  opts: {
    guarded?: boolean;
    /**
     * What is in hand already (0.9.0-dev.87: a note just made): shown at
     * once, and not asked for until `reload`.
     */
    initial?: T | null;
  } = {},
) {
  const { withToken, guarded } = useApp();
  const asks = opts.guarded === true;
  // A stable key for the dependency list: the rule wants an array literal.
  const depsKey = JSON.stringify(deps);
  const inHand = opts.initial ?? null;
  // While the dependencies are those it was in hand for, it is not asked for.
  const skipFor = useRef(inHand !== null ? depsKey : null);
  const [data, setData] = useState<T | null>(inHand);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(inHand === null);
  const [declined, setDeclined] = useState(false);

  // Each ask numbered: an answer to an older one that comes after a newer
  // one's is let go, so what is shown is never older than what was asked
  // last (a list read again twice in quick succession, 0.9.0-dev.103).
  const asked = useRef(0);
  const run = useCallback(async () => {
    const mine = ++asked.current;
    setLoading(true);
    setDeclined(false);
    try {
      const r = asks ? await guarded(load) : await withToken(load);
      if (mine !== asked.current) return;
      if (r !== null) setData(r);
      else if (asks) setDeclined(true);
      setError(null);
      setErrorCode(null);
    } catch (err) {
      if (mine !== asked.current) return;
      setError(describeError(err));
      setErrorCode(err instanceof ApiRequestError ? err.code : null);
    } finally {
      if (mine === asked.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withToken, guarded, asks, depsKey]);

  useEffect(() => {
    // What was in hand is shown first; asked for again only by `reload`.
    if (skipFor.current === depsKey) return;
    void run();
  }, [run, depsKey]);

  return { data, error, errorCode, loading, reload: run, setData, declined };
}
