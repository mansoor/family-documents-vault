import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import * as passkeys from '../passkeys.js';
import * as push from '../push.js';
import { api, ApiRequestError } from '../api.js';
import { takeLanding } from '../landing.js';
import { describeError, useApp } from '../app-context.js';
import { Button, ErrorNote, Field, Logo } from '../ui.js';
import type { MfaChallenge, RecoveryWay, Tokens } from '@fdv/shared';

/** The Welcome board: what this is, and one primary action. */
export function WelcomeScreen() {
  const { caps } = useApp();
  const navigate = useNavigate();
  const setupRequired = caps?.setup_required ?? true;
  return (
    <main className="page">
      <Logo />
      <div>
        <h1 style={{ fontSize: 36 }}>Every important paper, in one place.</h1>
        <p className="lede">
          Passports, birth certificates, policies, tax returns. Scanned once, found in seconds, and
          never quietly expired.
        </p>
      </div>
      <ul className="features">
        <li>
          <strong>Scan it, we file it</strong>
          <span className="muted">We read the page and fill in the details</span>
        </li>
        <li>
          <strong>Warned before it lapses</strong>
          <span className="muted">Months ahead, not the week after</span>
        </li>
        <li>
          <strong>Yours, and only yours</strong>
          <span className="muted">Scrambled before it leaves this app</span>
        </li>
      </ul>
      <div className="stack">
        {setupRequired ? (
          <Button onClick={() => void navigate('/setup')}>Set up my family</Button>
        ) : (
          <Button onClick={() => void navigate('/sign-in')}>Sign in</Button>
        )}
      </div>
    </main>
  );
}

export function SignInScreen() {
  const { caps, session, markAuthChanged } = useApp();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  // The second step (0.9.0, SMS3): the authenticator's code, or one texted
  // to their own number — as the vault offers, and as they choose.
  const [mfa, setMfa] = useState<MfaChallenge | null>(null);
  const [byText, setByText] = useState(false);
  const [texted, setTexted] = useState<string | null>(null);
  // What stands in for a lost second step (0.9.0-dev.104): a recovery code,
  // or the security questions; and a sign-in refused because its code by
  // text couldn't be sent, which only they can finish.
  const [way, setWay] = useState<'second_step' | RecoveryWay>('second_step');
  const [refused, setRefused] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [questions, setQuestions] = useState<string[] | null>(null);
  const [answers, setAnswers] = useState<string[]>([]);
  // A new password, chosen as a code or the answers stand in (0.9.0-dev.104):
  // the one somebody else may know never gets in again.
  const [newPassword, setNewPassword] = useState('');

  /** Signed in: where a folder label's code asked to go (C3); else Home. */
  const signedIn = (r: Tokens) => {
    session.accept(r);
    markAuthChanged();
    void push.repost(r.access_token);
    void navigate(takeLanding() ?? '/', { replace: true });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = mfaToken
        ? await api.signInMfa(mfaToken, code, mfa?.methods ? (byText ? 'text' : 'totp') : undefined)
        : await api.signIn(email, password);
      if ('mfa_required' in r) {
        setMfaToken(r.mfa_token);
        setMfa(r);
        // A text the only second step: one went with the password.
        const onlyText = r.methods?.length === 1 && r.methods[0] === 'text';
        setByText(onlyText);
        if (r.text_sent && r.text_to) setTexted(`We texted a code to ${r.text_to}.`);
        return;
      }
      signedIn(r);
    } catch (err) {
      // The code by text couldn't be sent (0.9.0-dev.104): nobody is let in,
      // and a recovery code or the questions may stand in.
      if (err instanceof ApiRequestError && err.code === 'text_code_unavailable' && err.mfaToken) {
        setMfaToken(err.mfaToken);
        setMfa({
          mfa_required: true,
          mfa_token: err.mfaToken,
          // A passkey of theirs, which signs them in on its own.
          methods: err.methods.includes('passkey') ? ['passkey'] : [],
          recovery: err.recovery.filter(
            (w): w is RecoveryWay => w === 'recovery_code' || w === 'security_questions',
          ),
        });
        setRefused(err.message);
        return;
      }
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  /**
   * A passkey signs in on its own: no password, and no second step, because
   * the device already checked who is holding it.
   */
  const withPasskey = async () => {
    setBusy(true);
    setError(null);
    try {
      const tokens = await passkeys.signIn(email.trim() || undefined);
      signedIn(tokens);
    } catch (err) {
      setError(passkeys.describe(err));
    } finally {
      setBusy(false);
    }
  };

  /** A code texted for the second step (SMS3): a first, or another. */
  const textMe = async () => {
    if (!mfaToken) return;
    setBusy(true);
    setError(null);
    try {
      const sent = await api.signInTextCode(mfaToken);
      setByText(true);
      setCode('');
      setTexted(`We texted a code to ${sent.sent_to}.`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  /** One of what stands in for the second step, chosen (0.9.0-dev.104). */
  const choose = async (next: RecoveryWay) => {
    setError(null);
    setWay(next);
    if (next !== 'security_questions' || questions || !mfaToken) return;
    setBusy(true);
    try {
      const asked = await api.signInQuestions(mfaToken);
      setQuestions(asked.questions);
      setAnswers(asked.questions.map(() => ''));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  /** The recovery code, or the answers, in place of the second step. */
  const standIn = async (e: FormEvent) => {
    e.preventDefault();
    if (!mfaToken) return;
    setBusy(true);
    setError(null);
    try {
      const r =
        way === 'recovery_code'
          ? await api.signInRecoveryCode(mfaToken, recoveryCode, newPassword)
          : await api.signInAnswers(mfaToken, answers, newPassword);
      signedIn(r);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  /** Back to the email and password, as if nothing had been typed after them. */
  const startAgain = () => {
    setMfaToken(null);
    setMfa(null);
    setCode('');
    setByText(false);
    setTexted(null);
    setWay('second_step');
    setRefused(null);
    setRecoveryCode('');
    setQuestions(null);
    setAnswers([]);
    setNewPassword('');
    setError(null);
  };

  if (mfaToken) {
    const offersText = mfa?.methods?.includes('text') === true;
    const offersApp = !mfa?.methods || mfa.methods.includes('totp');
    // Somebody who must have two-step sign-in, whose factor is a passkey
    // (0.9.0): the passkey is the second step, as a passkey sign-in.
    const offersPasskey = mfa?.methods?.includes('passkey') === true;
    const ways = mfa?.recovery ?? [];
    const passkeyButton = offersPasskey && (
      <Button
        kind={offersApp ? 'quiet' : 'primary'}
        disabled={busy}
        onClick={() => void withPasskey()}
      >
        {busy ? 'Waiting for your device…' : 'Use your passkey'}
      </Button>
    );
    // What stands in, as links under the second step (0.9.0-dev.104).
    const standInLinks = (
      <>
        {ways.includes('recovery_code') && way !== 'recovery_code' && (
          <Button kind="link" onClick={() => void choose('recovery_code')}>
            Use a recovery code
          </Button>
        )}
        {ways.includes('security_questions') && way !== 'security_questions' && (
          <Button kind="link" onClick={() => void choose('security_questions')}>
            Answer your security questions
          </Button>
        )}
        {way !== 'second_step' && !refused && (
          <Button
            kind="link"
            onClick={() => {
              setWay('second_step');
              setError(null);
            }}
          >
            Use my second step instead
          </Button>
        )}
      </>
    );
    if (way !== 'second_step' || refused) {
      return (
        <main className="page">
          <Logo />
          <div>
            <h1 style={{ fontSize: 32 }}>
              {way === 'recovery_code'
                ? 'Use a recovery code'
                : way === 'security_questions'
                  ? 'Answer your security questions'
                  : 'One more step'}
            </h1>
            <p className="lede">
              {way === 'recovery_code'
                ? 'Type one of the recovery codes you kept. It works once.'
                : way === 'security_questions'
                  ? 'Answer all three, as you did when you set them.'
                  : refused}
            </p>
            {way !== 'second_step' && (
              <p className="muted">
                You choose a new password too. Your authenticator app, passkeys and codes by text
                will be taken away, and every other device signed out. You then set up two-step
                sign-in again, on this device.
              </p>
            )}
          </div>
          <form onSubmit={(e) => void standIn(e)} className="card stack">
            {way === 'recovery_code' && (
              <Field
                id="recovery-code"
                label="Recovery code"
                value={recoveryCode}
                onChange={setRecoveryCode}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                placeholder="xxxxx-xxxxx"
              />
            )}
            {way === 'security_questions' &&
              (questions ?? []).map((q, i) => (
                <Field
                  key={q}
                  id={`security-answer-${i}`}
                  label={q}
                  value={answers[i] ?? ''}
                  autoComplete="off"
                  onChange={(v) => setAnswers(answers.map((a, j) => (j === i ? v : a)))}
                />
              ))}
            {way !== 'second_step' && (
              <Field
                id="recovery-new-password"
                label="Choose a new password"
                type="password"
                value={newPassword}
                onChange={setNewPassword}
                autoComplete="new-password"
                hint="It replaces your password now. It also unlocks your own private documents."
              />
            )}
            <ErrorNote message={error} />
            {offersPasskey && way === 'second_step' && passkeyButton}
            {way !== 'second_step' && (
              <Button
                type="submit"
                disabled={
                  busy ||
                  newPassword === '' ||
                  (way === 'recovery_code'
                    ? recoveryCode.trim() === ''
                    : questions === null || answers.some((a) => a.trim() === ''))
                }
              >
                {busy ? 'Checking…' : 'Continue'}
              </Button>
            )}
            {standInLinks}
            <Button kind="link" onClick={startAgain}>
              Start again
            </Button>
          </form>
        </main>
      );
    }
    if (offersPasskey && !offersApp && !offersText) {
      return (
        <main className="page">
          <Logo />
          <div>
            <h1 style={{ fontSize: 32 }}>One more step</h1>
            <p className="lede">
              Use your passkey: your device asks for your PIN, fingerprint or face.
            </p>
          </div>
          <div className="card stack">
            <ErrorNote message={error} />
            {passkeyButton}
            {standInLinks}
          </div>
        </main>
      );
    }
    return (
      <main className="page">
        <Logo />
        <div>
          <h1 style={{ fontSize: 32 }}>One more step</h1>
          <p className="lede">
            {byText
              ? `Enter the six-digit code we text${texted ? 'ed' : ''} to ${mfa?.text_to ?? 'your phone'}.`
              : offersPasskey
                ? 'Enter the six-digit code from your authenticator app, or use your passkey.'
                : 'Enter the six-digit code from your authenticator app.'}
          </p>
        </div>
        <form onSubmit={(e) => void submit(e)} className="card stack">
          <Field
            id="code"
            label={byText ? 'Code from the text' : 'Code'}
            value={code}
            onChange={setCode}
            autoComplete="one-time-code"
            placeholder="123 456"
          />
          <p className="status-line" role="status">
            {byText ? (texted ?? '') : ''}
          </p>
          <ErrorNote message={error} />
          <Button type="submit" disabled={busy || (byText && !texted)}>
            {busy ? 'Checking…' : 'Continue'}
          </Button>
          {offersText &&
            (byText ? (
              <Button kind="quiet" disabled={busy} onClick={() => void textMe()}>
                {texted ? 'Send another code' : 'Text me a code'}
              </Button>
            ) : (
              <Button kind="quiet" disabled={busy} onClick={() => void textMe()}>
                Text me a code instead
              </Button>
            ))}
          {passkeyButton}
          {offersText && offersApp && byText && (
            <Button
              kind="link"
              onClick={() => {
                setByText(false);
                setCode('');
              }}
            >
              Use my authenticator app instead
            </Button>
          )}
          {standInLinks}
        </form>
      </main>
    );
  }

  return (
    <main className="page">
      <Logo />
      <div>
        <h1 style={{ fontSize: 32 }}>{caps?.branding.display_name ?? 'Family Document Vault'}</h1>
        <p className="lede">Sign in to open the vault.</p>
      </div>
      <form onSubmit={(e) => void submit(e)} className="card stack">
        <Field
          id="email"
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="username"
        />
        <Field
          id="password"
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
        />
        <ErrorNote message={error} />
        <Button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
        {caps?.features.passkeys && passkeys.supported() && passkeys.secureEnough() && (
          <>
            <p className="muted" style={{ textAlign: 'center' }}>
              or
            </p>
            <Button kind="quiet" disabled={busy} onClick={() => void withPasskey()}>
              {busy ? 'Waiting for your device…' : 'Use a passkey'}
            </Button>
          </>
        )}
        <Button kind="link" onClick={() => void navigate('/forgot-password')}>
          I have forgotten my password
        </Button>
      </form>
    </main>
  );
}
