import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { RecoveryCodesShown } from '../recovery.js';
import { StepUpPrompt } from '../StepUpPrompt.js';
import { CodesByTextCard } from '../text-messages.js';
import { Button, ErrorNote, Logo } from '../ui.js';
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
 *
 * Somebody who got back in with a recovery code or their security questions
 * (`recovered`, 0.9.0-dev.104) had every second step taken away: they set
 * one up again — codes by text too, unless they are an owner — and go on
 * once new recovery codes are made. A second step set up here, either way,
 * is followed by the recovery codes made for it, shown once.
 */
export function TwoStepSetupScreen({ onDone }: { onDone?: () => void }) {
  const { caps, session, authVersion, markAuthChanged, twoStepDone, guarded } = useApp();
  const navigate = useNavigate();
  const { data: me } = useLoad(async (t) => api.me(t), [authVersion]);
  const [leaving, setLeaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [making, setMaking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // A second step set up here, and its codes asked for (0.9.0-dev.104).
  const [asked, setAsked] = useState(false);
  const done = () => {
    twoStepDone();
    onDone?.();
  };
  // A second step set up: its recovery codes made, and shown once, before
  // going on (0.9.0-dev.104). A vault without them goes straight on.
  const setUp = async () => {
    if (caps?.features.recovery_codes !== true) {
      done();
      return;
    }
    setAsked(true);
    setMaking(true);
    setProblem(null);
    try {
      const made = await guarded((t) => api.makeRecoveryCodes(t));
      if (made) setCodes(made.codes);
      else setProblem('Your recovery codes weren’t made. Make them to go on.');
    } catch (err) {
      setProblem(describeError(err));
    } finally {
      setMaking(false);
    }
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

  // A second step there and no codes yet — they failed, the confirming was
  // dismissed, or the page was reloaded: made again on request.
  const secondStepThere = me?.totp_enabled === true || me?.has_passkey === true;
  const makeCodesAgain = caps?.features.recovery_codes === true &&
    !making &&
    (asked || (me?.two_step_reason === 'recovered' && secondStepThere)) && (
      <Button onClick={() => void setUp()}>Make my recovery codes</Button>
    );

  if (codes) {
    return (
      <main className="page page-top">
        <Logo />
        <RecoveryCodesShown codes={codes} onDone={done} />
      </main>
    );
  }

  if (me?.two_step_reason === 'recovered') {
    return (
      <main className="page page-top">
        <Logo />
        <div>
          <h1 style={{ fontSize: 28 }}>Set up two-step sign-in again</h1>
          <p className="lede">
            You got back in without your second step, so your authenticator app, passkeys and codes
            by text were taken away, and every other device was signed out. Set one up again, keep
            the new recovery codes we make for it, and you go straight on.
          </p>
        </div>
        <Passkeys onAdded={() => void setUp()} />
        <TwoStep onDone={() => void setUp()} />
        {me.role !== 'owner' && <CodesByTextCard onTurnedOn={() => void setUp()} />}
        {making && (
          <p className="status-line" role="status">
            Making your recovery codes…
          </p>
        )}
        <ErrorNote message={problem} />
        {makeCodesAgain}
        {signOutButton}
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
      <Passkeys onAdded={() => void setUp()} />
      <TwoStep onDone={() => void setUp()} />
      {making && (
        <p className="status-line" role="status">
          Making your recovery codes…
        </p>
      )}
      <ErrorNote message={problem} />
      {makeCodesAgain}
      <p className="muted">Not now? You can sign out and come back to it.</p>
      {signOutButton}
    </main>
  );
}
