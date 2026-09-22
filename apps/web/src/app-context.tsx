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
      const token = await session.token();
      if (!token) {
        markAuthChanged();
        return null;
      }
      try {
        return await fn(token);
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 401) {
          session.clear();
          markAuthChanged();
          return null;
        }
        throw err;
      }
    },
    [session, markAuthChanged],
  );

  const value = useMemo<AppState>(
    () => ({ caps, session, reloadCaps, withToken, authVersion, markAuthChanged, connectionError }),
    [caps, session, reloadCaps, withToken, authVersion, markAuthChanged, connectionError],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
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
