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
import { api, ApiRequestError } from './api.js';
import { Session } from './session.js';
import { StepUpPrompt } from './StepUpPrompt.js';

/**
 * What every screen needs: the capability document, the session, and a
 * way to call the API with a fresh token that turns a lost session into a
 * redirect rather than a broken page.
 */

export const UNREACHABLE =
  "We can't reach the vault right now. Check that it is running, then reload.";

/** The two codes that mean this session cannot be used again. */
function isSessionOver(err: ApiRequestError): boolean {
  return err.status === 401 && (err.code === 'session_ended' || err.code === 'unauthenticated');
}

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
   * credential again (SEC-17): it opens the prompt, waits, and retries.
   */
  guarded: <T>(fn: (token: string) => Promise<T>) => Promise<T | null>;
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
    void reloadCaps();
  }, [reloadCaps]);

  const markAuthChanged = useCallback(() => setAuthVersion((v) => v + 1), []);

  const withToken = useCallback(
    async <T,>(fn: (token: string) => Promise<T>): Promise<T | null> => {
      const token = await session.token();
      if (!token) {
        markAuthChanged();
        return null;
      }
      try {
        return await fn(token);
      } catch (err) {
        // Not every 401 means the session is over. The API also answers
        // 401 when a credential presented *inside* a request was wrong —
        // a mistyped current password, a passkey that is not yours — and
        // signing somebody out for a typo is its own small betrayal.
        // Only the two codes that actually mean "this session is done"
        // end it; anything else is the caller's to show.
        if (err instanceof ApiRequestError && isSessionOver(err)) {
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

  const guarded = useCallback(
    async <T,>(fn: (token: string) => Promise<T>): Promise<T | null> => {
      try {
        return await withToken(fn);
      } catch (err) {
        if (!(err instanceof ApiRequestError) || err.code !== 'step_up_required') throw err;
        const confirmed = await new Promise<boolean>((settle) =>
          setAsking({ action: err.action ?? '', message: err.message, settle }),
        );
        setAsking(null);
        if (!confirmed) return null;
        return await withToken(fn);
      }
    },
    [withToken],
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
