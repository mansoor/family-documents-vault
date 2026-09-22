import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api.js';
import { describeError, useApp } from '../app-context.js';
import { Button, ErrorNote, Field, Logo } from '../ui.js';

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

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = mfaToken ? await api.signInMfa(mfaToken, code) : await api.signIn(email, password);
      if ('mfa_required' in r) {
        setMfaToken(r.mfa_token);
        return;
      }
      session.accept(r);
      markAuthChanged();
      void navigate('/', { replace: true });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  if (mfaToken) {
    return (
      <main className="page">
        <Logo />
        <div>
          <h1 style={{ fontSize: 32 }}>One more step</h1>
          <p className="lede">Enter the six-digit code from your authenticator app.</p>
        </div>
        <form onSubmit={(e) => void submit(e)} className="card stack">
          <Field
            id="code"
            label="Code"
            value={code}
            onChange={setCode}
            autoComplete="one-time-code"
            placeholder="123 456"
          />
          <ErrorNote message={error} />
          <Button type="submit" disabled={busy}>
            {busy ? 'Checking…' : 'Continue'}
          </Button>
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
      </form>
    </main>
  );
}
