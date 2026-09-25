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

export function describeError(err: unknown): string {
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
      const got = await session.token();
      if (got.kind === 'offline') {
        // No answer is not "signed out": the session is kept, and the
        // screen that asked says the vault cannot be reached, rather than
        // showing an empty household as if there were nothing in it. Only
        // that screen: a blip must not wipe a half-filled form.
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
      {asking && <StepUpPrompt message={asking.message} onSettled={asking.settle} />}
    </Ctx.Provider>
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
