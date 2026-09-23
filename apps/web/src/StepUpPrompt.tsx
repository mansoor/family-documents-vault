import { useState, type FormEvent } from 'react';
import { api } from './api.js';
import { useApp } from './app-context.js';
import * as passkeys from './passkeys.js';
import { Button, ErrorNote, Field } from './ui.js';

/**
 * "Confirm it is you" (SEC-17).
 *
 * It appears over whatever the person was doing, takes one credential,
 * and hands control back so the action they asked for goes through by
 * itself. Cancelling is a first-class answer: nothing was done, and
 * nothing is lost.
 */
export function StepUpPrompt(props: { message: string; onSettled: (confirmed: boolean) => void }) {
  // A wrong password here answers 401 with `invalid_credentials`, which
  // `withToken` now leaves alone — only `session_ended` and
  // `unauthenticated` end a session. Going through the session directly
  // anyway, because this prompt must never be the thing that signs
  // somebody out, whatever the shared helper does later.
  const { session } = useApp();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canUsePasskey = passkeys.supported() && passkeys.secureEnough();

  const withPassword = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const got = await session.token();
      if (got.kind !== 'ok') return props.onSettled(false);
      await api.stepUp(got.token, { password });
      props.onSettled(true);
    } catch {
      setError("That didn't match. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const withPasskey = async () => {
    setBusy(true);
    setError(null);
    try {
      const options = await api.passkeyChallenge();
      const response = await passkeys.assert(options);
      const got = await session.token();
      if (got.kind !== 'ok') return props.onSettled(false);
      await api.stepUp(got.token, { passkey: response });
      props.onSettled(true);
    } catch (err) {
      setError(passkeys.describe(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="scrim" role="presentation">
      <section
        className="card stack sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="stepup-h"
      >
        <h2 id="stepup-h" style={{ fontSize: 20 }}>
          Just checking it is you
        </h2>
        <p className="muted">{props.message}</p>
        {canUsePasskey && (
          <Button disabled={busy} onClick={() => void withPasskey()}>
            {busy ? 'Waiting for your device…' : 'Use your passkey'}
          </Button>
        )}
        <form onSubmit={(e) => void withPassword(e)} className="stack">
          <Field
            id="stepup-password"
            label="Or your password"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
          />
          <ErrorNote message={error} />
          <div className="row">
            <Button type="submit" disabled={busy || !password}>
              {busy ? 'Checking…' : 'Confirm'}
            </Button>
            <Button kind="quiet" onClick={() => props.onSettled(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}
