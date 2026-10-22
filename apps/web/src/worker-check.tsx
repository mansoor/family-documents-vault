import { SETTINGS_CHECK_LATE_MS, type SettingsCheckView } from '@fdv/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { describeError, useApp } from './app-context.js';

/** How often the page asks for the worker's answer. */
export const CHECK_POLL_MS = 700;

/**
 * Something an owner asks the worker from Settings (0.9.0, O1) — Verify a
 * folder, the folders inside one, Test the mailbox — asked, then asked
 * after until the worker has answered or is late. `run` answers the
 * check as it ended (null when it was refused, or the page went).
 */
export function useWorkerCheck() {
  const { guarded } = useApp();
  const [view, setView] = useState<SettingsCheckView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const run = useCallback(
    async (ask: (t: string) => Promise<SettingsCheckView>): Promise<SettingsCheckView | null> => {
      setBusy(true);
      setError(null);
      setView(null);
      try {
        let v = await guarded(ask);
        const started = Date.now();
        while (v !== null && v.state === 'waiting' && live.current) {
          if (Date.now() - started > SETTINGS_CHECK_LATE_MS + 5_000) break;
          await new Promise((r) => setTimeout(r, CHECK_POLL_MS));
          const id: string = v.id;
          v = await guarded((t) => api.settingsCheck(t, id));
        }
        if (!live.current) return null;
        setView(v);
        return v;
      } catch (err) {
        if (live.current) setError(describeError(err));
        return null;
      } finally {
        if (live.current) setBusy(false);
      }
    },
    [guarded],
  );
  const clear = useCallback(() => {
    setView(null);
    setError(null);
  }, []);
  return { view, busy, error, run, clear };
}
