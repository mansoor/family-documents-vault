import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { api, type ResetPreview } from '../api.js';
import { describeError, useApp } from '../app-context.js';
import { forgetLinkToken, heldLinkToken } from '../link-token.js';
import { Button, ErrorNote, Field, Logo } from '../ui.js';

/**
 * Passwords, from the three places a person meets them.
 *
 * The thing all three have to get across is that a password here is not
 * only a way in: it also unlocks the person's own *Only me* documents. So
 * every one of these screens says what will happen to those, rather than
 * leaving somebody to find out.
 */

/** In Settings, for somebody who is signed in and knows their password. */
export function ChangePassword() {
  const { guarded } = useApp();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // `guarded` handles the step-up prompt for somebody who signed in
      // with a passkey and has no password to give.
      await guarded((t) =>
        api.changePassword(t, {
          ...(current ? { current_password: current } : {}),
          new_password: next,
        }),
      );
      setCurrent('');
      setNext('');
      setOpen(false);
      setDone(true);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="stack">
        {done && (
          <p className="status status-ok">
            Your password is changed, and your other devices have been signed out.
          </p>
        )}
        <Button kind="quiet" onClick={() => setOpen(true)}>
          Change your password
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="card stack">
      <h2 style={{ fontSize: 18 }}>Change your password</h2>
      <Field
        id="pw-current"
        label="Your password now"
        type="password"
        value={current}
        onChange={setCurrent}
        autoComplete="current-password"
        required={false}
        hint="Leave this empty if you sign in with a passkey and have never set one."
      />
      <Field
        id="pw-new"
        label="Your new password"
        type="password"
        value={next}
        onChange={setNext}
        autoComplete="new-password"
        hint="At least 10 characters. A few words you will remember work best."
      />
      <p className="muted">
        This also unlocks your own private documents, so they come with it. Every other device you
        are signed in on will be signed out.
      </p>
      <ErrorNote message={error} />
      <div className="row">
        <Button type="submit" disabled={busy || next.length < 10}>
          {busy ? 'Changing…' : 'Change it'}
        </Button>
        <Button kind="quiet" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** From the sign-in page, for somebody who cannot get in. */
export function ForgotPasswordScreen() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setSent((await api.forgotPassword(email)).message);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page">
      <Logo />
      <h1 style={{ fontSize: 26 }}>Forgotten your password</h1>
      {sent ? (
        <section className="card stack">
          <p>{sent}</p>
          <p className="muted">
            It works once and stops working in an hour. If nothing arrives, ask whoever runs the
            vault: they can make you a link. A link only comes by email when nobody else in the
            family could read that email on its way to you, and nobody else in the family can reset
            your password for you — both deliberately, because a link is a way into your private
            documents.
          </p>
          <Button onClick={() => void navigate('/sign-in')}>Back to signing in</Button>
        </section>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="card stack">
          <p className="muted">
            Tell us the address you sign in with and we will send a link to it.
          </p>
          <Field
            id="forgot-email"
            label="Your email"
            type="email"
            value={email}
            onChange={setEmail}
            autoComplete="username"
          />
          <ErrorNote message={error} />
          <div className="row">
            <Button type="submit" disabled={busy || !email}>
              {busy ? 'Sending…' : 'Send me a link'}
            </Button>
            <Button kind="quiet" onClick={() => void navigate('/sign-in')}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </main>
  );
}

/**
 * The page the link in the email opens: `/reset#<token>` (5.17), or
 * `/reset/<token>` in a link sent before then. Either way the token was
 * taken out of the address before anything was drawn (link-token.ts) — out
 * of the address bar and this tab's history, not out of the browser's own
 * history of visited pages, which no page can reach. What keeps the link
 * safe there is that it works once, and for an hour. It goes to the vault
 * in a body, never a path.
 */
export function ResetPasswordScreen() {
  // Read, not taken: reading it twice, as a check in development does,
  // gives the same token.
  const [token] = useState(() => heldLinkToken('reset'));
  const navigate = useNavigate();
  const [preview, setPreview] = useState<ResetPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) return;
    let live = true;
    void (async () => {
      try {
        const p = await api.lookupReset(token);
        if (live) setPreview(p);
      } catch (err) {
        if (live) setLoadError(describeError(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await api.completeReset(token, password);
      forgetLinkToken();
      setDone(true);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };

  if (!token) {
    // Opened without its link, or reloaded once the link had been taken out
    // of the address: the link itself still works until it is used or its
    // hour is up.
    return (
      <main className="page">
        <Logo />
        <section className="card stack">
          <h1 style={{ fontSize: 22 }}>Open your link again</h1>
          <p className="muted">
            This page needs the whole link you were sent, by email or by whoever runs the vault.
            Open it again from there: it works once, and for an hour after it was made.
          </p>
          <Button onClick={() => void navigate('/forgot-password')}>Ask for a new one</Button>
        </section>
      </main>
    );
  }

  if (loadError) {
    return (
      <main className="page">
        <Logo />
        <section className="card stack">
          <h1 style={{ fontSize: 22 }}>This link cannot be used</h1>
          <p className="muted">{loadError}</p>
          <Button onClick={() => void navigate('/forgot-password')}>Ask for a new one</Button>
        </section>
      </main>
    );
  }

  if (done) {
    return (
      <main className="page">
        <Logo />
        <section className="card stack">
          <h1 style={{ fontSize: 22 }}>That is done</h1>
          <p>
            Your new password is set and every device has been signed out. Sign in again with it.
          </p>
          <p className="muted">
            The link is used up: it opens nothing now, even from this browser's history.
          </p>
          <Button onClick={() => void navigate('/sign-in')}>Sign in</Button>
        </section>
      </main>
    );
  }

  if (!preview) {
    return (
      <main className="page">
        <Logo />
        <span className="status status-warn">Checking the link…</span>
      </main>
    );
  }

  return (
    <main className="page">
      <Logo />
      <h1 style={{ fontSize: 26 }}>Set a new password</h1>
      <section className="card stack">
        <p>
          For <strong>{preview.email}</strong>
          {preview.household_name ? ` in ${preview.household_name}` : ''}.
        </p>
        {preview.issued_by_operator && (
          <p className="muted">Whoever runs this vault made this link for you from the server.</p>
        )}
        <p className="muted">
          The link is out of the address bar and this tab's history now, but this browser's own
          history of pages visited may still have it. That is why it works only once, and only until{' '}
          {new Date(preview.expires_at).toLocaleTimeString([], { timeStyle: 'short' })}.
        </p>
      </section>
      <form onSubmit={(e) => void submit(e)} className="card stack">
        <Field
          id="reset-password"
          label="Your new password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          hint="At least 10 characters. This also unlocks your own private documents."
        />
        <ErrorNote message={error} />
        <Button type="submit" disabled={busy || password.length < 10}>
          {busy ? 'Setting it…' : 'Set my new password'}
        </Button>
        <p className="muted">
          Every device will be signed out, including any you are still signed in on. If two-step
          sign-in is switched on, you will still be asked for the code afterwards.
        </p>
      </form>
    </main>
  );
}
