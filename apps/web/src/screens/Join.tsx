import { guestAccessEnded, guestEndWords, roleDescription } from '@fdv/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { api, type InvitationPreview } from '../api.js';
import { describeError, useApp } from '../app-context.js';
import { heldLinkToken, linkSpent, markLinkSpent } from '../link-token.js';
import { Button, ErrorNote, Field, Logo } from '../ui.js';

/**
 * Accepting an invitation (SHR-02).
 *
 * The person arriving here has been sent a link by someone they know, and
 * has a code from somewhere else. Before they type anything they are told
 * whose vault this is, who invited them and what they will be able to do —
 * because "paste this link and make a password" is also what a phishing
 * page says, and the difference has to be visible.
 *
 * The link reads `/join#<token>` (5.17), or `/join/<token>` if it was made
 * before then. Either way the token was taken out of the address before
 * anything was drawn (link-token.ts) — out of the address bar and this
 * tab's history, not out of the browser's own history of visited pages,
 * which no page can reach. What keeps the link safe there is that it works
 * once, only with the code, and not for long. It goes to the vault in a
 * body, never a path.
 *
 * Somebody invited from outside the family (5.34's review, W534-07) is told
 * so: a guest, who sees only what they are given, until the day their
 * access ends — and, when that day has passed already, told before they
 * type anything. Nothing promises them documents of their own.
 */
export function JoinScreen() {
  // Read, not taken: reading it twice, as a check in development does,
  // gives the same token.
  const [token] = useState(() => heldLinkToken('join'));
  // Used in this page load already, and the page opened again (5.17 review).
  const [spent] = useState(() => linkSpent('join'));
  const { session, markAuthChanged } = useApp();
  const navigate = useNavigate();
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let live = true;
    void (async () => {
      try {
        const p = await api.lookupInvitation(token);
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
      session.accept(
        await api.acceptInvitationLink(token, {
          code,
          password,
          ...(email && email.trim() ? { email: email.trim() } : {}),
        }),
      );
      markLinkSpent();
      markAuthChanged();
      // In place of this page, so Back does not come back to it.
      await navigate('/', { replace: true });
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };

  if (spent) {
    // They joined from this page, in this page load, and it is open again:
    // asking for the link would send them to one that opens nothing.
    return (
      <main className="page">
        <Logo />
        <section className="card stack">
          <h1 style={{ fontSize: 24 }}>That invitation has been used</h1>
          <p className="muted">
            You joined with it, so the link opens nothing now. From here on, your way in is the
            email and password you chose.
          </p>
          <Button onClick={() => void navigate('/', { replace: true })}>Go to the vault</Button>
        </section>
      </main>
    );
  }

  if (!token || loadError) {
    return (
      <main className="page">
        <Logo />
        <section className="card stack">
          <h1 style={{ fontSize: 24 }}>
            {token ? 'This invitation cannot be used' : 'Open the invitation link again'}
          </h1>
          <p className="muted">
            {loadError ??
              'This page needs the whole link you were sent. Open it from the message again: it works until you have joined, or until it runs out.'}
          </p>
          <Button kind="quiet" onClick={() => void navigate('/welcome')}>
            Go to the sign-in page
          </Button>
        </section>
      </main>
    );
  }

  if (!preview) {
    return (
      <main className="page">
        <Logo />
        <span className="status status-warn">Checking the invitation…</span>
      </main>
    );
  }

  const guest = preview.kind === 'guest';
  // On this browser's clock, named: the page knows no other before sign-in.
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const end = guest && preview.access_expires_at ? preview.access_expires_at : null;
  const ended = end !== null && guestAccessEnded(end);
  const endWords = end ? `${guestEndWords(end, zone)} (${zone})` : '';
  const inviter = preview.invited_by ? <strong>{preview.invited_by}</strong> : 'Someone';

  if (guest) {
    return (
      <main className="page">
        <Logo />
        <h1 style={{ fontSize: 28 }}>A guest’s sign-in to {preview.household_name}</h1>
        <section className="card stack">
          <p>
            {inviter} invited you as <strong>{preview.display_name}</strong>, a guest from outside
            the family.
          </p>
          {ended ? (
            <p className="status status-warn" role="status">
              {`The access this invitation gives ended ${endWords}. Ask whoever invited you for a new invitation.`}
            </p>
          ) : (
            <p className="muted">
              {end
                ? `You will see only what they choose to give you, until ${endWords}. They can renew it.`
                : 'You will see only what they choose to give you, for as long as they choose.'}
            </p>
          )}
        </section>
        {!ended && (
          <JoinForm
            preview={preview}
            code={code}
            setCode={setCode}
            email={email}
            setEmail={setEmail}
            password={password}
            setPassword={setPassword}
            busy={busy}
            error={error}
            onSubmit={submit}
            passwordHint="At least 10 characters."
            submitLabel="Accept the invitation"
            busyLabel="Accepting…"
          />
        )}
      </main>
    );
  }

  return (
    <main className="page">
      <Logo />
      <h1 style={{ fontSize: 28 }}>Join {preview.household_name}</h1>
      <section className="card stack">
        <p>
          {inviter} invited you as <strong>{preview.display_name}</strong>.
        </p>
        <p className="muted">
          {preview.role_label}: {roleDescription(preview.role)}
        </p>
      </section>
      <JoinForm
        preview={preview}
        code={code}
        setCode={setCode}
        email={email}
        setEmail={setEmail}
        password={password}
        setPassword={setPassword}
        busy={busy}
        error={error}
        onSubmit={submit}
        passwordHint="At least 10 characters. This also unlocks your own private documents."
        submitLabel="Join the family vault"
        busyLabel="Joining…"
      />
    </main>
  );
}

/** The code, the address and the password an invitation is accepted with. */
function JoinForm(props: {
  preview: InvitationPreview;
  code: string;
  setCode: (v: string) => void;
  email: string | null;
  setEmail: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
  busy: boolean;
  error: string | null;
  onSubmit: (e: FormEvent) => Promise<void>;
  passwordHint: string;
  submitLabel: string;
  busyLabel: string;
}) {
  const { preview, code, setCode, email, setEmail, password, setPassword, busy, error } = props;
  return (
    <form onSubmit={(e) => void props.onSubmit(e)} className="card stack">
      <Field
        id="join-code"
        label="The code they gave you"
        value={code}
        onChange={setCode}
        placeholder="ABCD-EFGH"
        autoComplete="one-time-code"
        hint="It came separately from the link. Capitals and dashes do not matter."
      />
      <Field
        id="join-email"
        label="The email you will sign in with"
        type="email"
        value={email ?? ''}
        onChange={setEmail}
        autoComplete="email"
        placeholder={preview.email}
        // Left empty, the invitation's own address is kept (5.3): a
        // browser must not refuse the form for it.
        required={false}
        hint={`Leave it empty to keep the address this was sent to (${preview.email}). If you ever forget your password, the link to set a new one comes here — so make it an address only you can read.`}
      />
      <Field
        id="join-password"
        label="Choose a password"
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        hint={props.passwordHint}
      />
      <ErrorNote message={error} />
      <Button type="submit" disabled={busy || !code || password.length < 10}>
        {busy ? props.busyLabel : props.submitLabel}
      </Button>
      <p className="muted">
        The link is out of the address bar and this tab's history now, but this browser's own
        history of pages visited may still have it. That is why it works only once, only with the
        code, and only until{' '}
        {new Date(preview.expires_at).toLocaleDateString([], { dateStyle: 'long' })}.
      </p>
    </form>
  );
}
