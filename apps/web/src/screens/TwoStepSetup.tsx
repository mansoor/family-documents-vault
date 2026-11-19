import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api.js';
import { useApp, useLoad } from '../app-context.js';
import { StepUpPrompt } from '../StepUpPrompt.js';
import { Button, Logo } from '../ui.js';
import { Passkeys, TwoStep } from './Settings.js';

/**
 * Two-step sign-in, before anything else (0.9.0). An owner — and an adult,
 * where the household asks it of adults — who signed in with a password
 * alone is shown this and nothing else: the vault answers every other
 * request `403 two_step_setup_required` until then.
 *
 * With neither a code from an authenticator app nor a passkey (`enrol`),
 * they set one up. With one (`confirm`: a sign-in from before, or one that
 * did not give it), they confirm it's them with it — never the password.
 * Either way they go straight on, in the same sign-in. `onDone` is for
 * first-run setup, which carries on with its own boards; anywhere else the
 * app goes on by itself.
 */
export function TwoStepSetupScreen({ onDone }: { onDone?: () => void }) {
  const { session, authVersion, markAuthChanged, twoStepDone } = useApp();
  const navigate = useNavigate();
  const { data: me } = useLoad(async (t) => api.me(t), [authVersion]);
  const [leaving, setLeaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const done = () => {
    twoStepDone();
    onDone?.();
  };
  const signOut = async () => {
    setLeaving(true);
    await session.signOut();
    markAuthChanged();
    void navigate('/welcome', { replace: true });
  };
  const signOutButton = (
    <Button kind="quiet" onClick={() => void signOut()} disabled={leaving}>
      Sign out
    </Button>
  );

  if (me?.two_step_reason === 'confirm') {
    return (
      <main className="page page-top">
        <Logo />
        <div>
          <h1 style={{ fontSize: 28 }}>Confirm it’s you</h1>
          <p className="lede">
            A password alone never opens the vault for you. Use your passkey, or a code from your
            authenticator app, and you go straight on.
          </p>
        </div>
        <Button onClick={() => setConfirming(true)}>Confirm it’s you</Button>
        {signOutButton}
        {confirming && (
          <StepUpPrompt
            action="change_sign_in"
            factor
            message="Use your passkey, or a code from your authenticator app."
            onSettled={(ok) => {
              setConfirming(false);
              if (ok) done();
            }}
          />
        )}
      </main>
    );
  }

  const who =
    me?.role === 'owner'
      ? 'Owners must have two-step sign-in, so that a password alone, guessed or stolen, never opens the vault.'
      : 'Your family asks every adult to have two-step sign-in, so that a password alone, guessed or stolen, never opens the vault.';
  return (
    <main className="page page-top">
      <Logo />
      <div>
        <h1 style={{ fontSize: 28 }}>Set up two-step sign-in</h1>
        <p className="lede">
          {me ? who : 'A password alone, guessed or stolen, should never open the vault.'} Choose
          one: it takes a minute, and you go straight on.
        </p>
      </div>
      <Passkeys onAdded={done} />
      <TwoStep onDone={done} />
      <p className="muted">Not now? You can sign out and come back to it.</p>
      {signOutButton}
    </main>
  );
}
