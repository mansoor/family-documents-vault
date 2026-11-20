import { useState } from 'react';
import { api } from './api.js';
import { describeError, useApp, useLoad } from './app-context.js';
import { ErrorNote, LoadFailed } from './ui.js';

/**
 * Settings → Privacy: whether every adult must have two-step sign-in
 * (0.9.0) — a code from an authenticator app, or a passkey — before a
 * password sign-in opens anything else. Owners always must. On for every
 * household made since 0.9.0; off for those made before, until an owner
 * turns it on. An owner's to change, with a passkey or a code; shown to
 * owners alone.
 */
export function TwoStepRuleCard() {
  const { authVersion, guarded } = useApp();
  const { data, error, setData, reload } = useLoad((t) => api.twoStepRule(t), [authVersion]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const change = async (adults: boolean) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const next = await guarded((t) => api.setTwoStepRule(t, adults));
      if (next) setData(next);
    } catch (err) {
      setProblem(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card stack" aria-labelledby="two-step-rule-h">
      <h2 id="two-step-rule-h" style={{ fontSize: 18 }}>
        Two-step sign-in for adults
      </h2>
      <p className="muted">
        Owners must always have two-step sign-in. Turned on, every adult must have it too — a code
        from an authenticator app, or a passkey — and an adult without one is asked to set it up the
        next time they sign in, before anything else.
      </p>
      {data === null && error ? (
        <LoadFailed
          message={error}
          what="two-step sign-in for adults"
          onRetry={() => void reload()}
        />
      ) : null}
      {data && (
        <div className="check">
          <input
            id="two-step-adults"
            type="checkbox"
            checked={data.adults}
            disabled={busy || !data.can_change}
            onChange={(e) => void change(e.target.checked)}
          />
          <label htmlFor="two-step-adults">Ask every adult to use two-step sign-in</label>
        </div>
      )}
      <ErrorNote message={problem} />
    </section>
  );
}
