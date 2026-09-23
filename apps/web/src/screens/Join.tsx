import { roleDescription } from '@fdv/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api, type InvitationPreview } from '../api.js';
import { describeError, useApp } from '../app-context.js';
import { Button, ErrorNote, Field, Logo } from '../ui.js';

/**
 * Accepting an invitation (SHR-02).
 *
 * The person arriving here has been sent a link by someone they know, and
 * has a code from somewhere else. Before they type anything they are told
 * whose vault this is, who invited them and what they will be able to do —
 * because "paste this link and make a password" is also what a phishing
 * page says, and the difference has to be visible.
 */
export function JoinScreen() {
  const { token } = useParams<{ token: string }>();
  const { session, markAuthChanged } = useApp();
  const navigate = useNavigate();
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const p = await api.invitationPreview(token ?? '');
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
    setBusy(true);
    setError(null);
    try {
      session.accept(await api.acceptInvitation(token ?? '', { code, password }));
      markAuthChanged();
      await navigate('/', { replace: true });
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <main className="page">
        <Logo />
        <section className="card stack">
          <h1 style={{ fontSize: 24 }}>This invitation cannot be used</h1>
          <p className="muted">{loadError}</p>
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

  return (
    <main className="page">
      <Logo />
      <h1 style={{ fontSize: 28 }}>Join {preview.household_name}</h1>
      <section className="card stack">
        <p>
          {preview.invited_by ? <strong>{preview.invited_by}</strong> : 'Someone'} invited you as{' '}
          <strong>{preview.display_name}</strong>.
        </p>
        <p className="muted">
          {preview.role_label}: {roleDescription(preview.role)}
        </p>
        <p className="muted">Your sign-in will be {preview.email}.</p>
      </section>

      <form onSubmit={(e) => void submit(e)} className="card stack">
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
          id="join-password"
          label="Choose a password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          hint="At least 10 characters. This also unlocks your own private documents."
        />
        <ErrorNote message={error} />
        <Button type="submit" disabled={busy || !code || password.length < 10}>
          {busy ? 'Joining…' : 'Join the family vault'}
        </Button>
      </form>
    </main>
  );
}
