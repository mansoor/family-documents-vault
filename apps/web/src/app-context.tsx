import type { Capabilities } from '@fdv/shared';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { StepUpCoordinator } from '@fdv/client';
import { api, ApiRequestError, isSessionOver, NetworkError } from './api.js';
import { Session } from './session.js';
import { StepUpPrompt } from './StepUpPrompt.js';

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
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const session = useMemo(() => new Session(), []);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [authVersion, setAuthVersion] = useState(0);

  const reloadCaps = useCallback(async () => {
    try {
      setCaps(await api.capabilities());
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
        throw err;
      }
    },
    [session, markAuthChanged],
  );

  // The step-up prompt is here rather than in a screen because any screen
  // can trigger it, and because the retry has to happen where the call was
  // made — otherwise the person confirms and then has to press the button
  // again themselves.
  const [asking, setAsking] = useState<{
    action: string;
    message: string;
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

  const guarded = useCallback(
    async <T,>(
      fn: (token: string) => Promise<T>,
      opts: { cancelled?: () => boolean } = {},
    ): Promise<T | null> => {
      try {
        return await withToken(fn);
      } catch (err) {
        if (!(err instanceof ApiRequestError) || err.code !== 'step_up_required') throw err;
        const confirmed = await stepUp.confirm({ action: err.action ?? '', message: err.message });
        // Confirmed for something nobody is waiting for any more: not fetched.
        if (!confirmed || opts.cancelled?.()) return null;
        return await withToken(fn);
      }
    },
    [withToken, stepUp],
  );

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
    }),
    [caps, session, reloadCaps, withToken, guarded, authVersion, markAuthChanged, connectionError],
  );
  return (
    <Ctx.Provider value={value}>
      {children}
      <RenewalWait session={session} />
      {asking && (
        <StepUpPrompt action={asking.action} message={asking.message} onSettled={asking.settle} />
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

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
}

/**
 * Loads data for a screen with the usual states. `deps` re-runs the load.
 */
export function useLoad<T>(load: (token: string) => Promise<T>, deps: unknown[]) {
  const { withToken } = useApp();
  // A stable key for the dependency list: the rule wants an array literal.
  const depsKey = JSON.stringify(deps);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const run = useCallback(async () => {
    setLoading(true);
    try {
      const r = await withToken(load);
      if (r !== null) setData(r);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withToken, depsKey]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void run();
  }, [run]);

  return { data, error, loading, reload: run, setData };
}
