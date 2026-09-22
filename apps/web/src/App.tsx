import type { Capabilities } from '@fdv/shared';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, ApiRequestError, type Me, type SessionRow } from './api.js';
import { Session } from './session.js';
import { StorageScreen } from './StorageScreen.js';
import { Button, ErrorNote, Field, Logo } from './ui.js';

type Stage =
  | { kind: 'connecting' }
  | { kind: 'failed'; message: string }
  | { kind: 'setup'; caps: Capabilities }
  | { kind: 'sign-in'; caps: Capabilities }
  | { kind: 'home'; caps: Capabilities }
  | { kind: 'storage'; caps: Capabilities };

const UNREACHABLE = "We can't reach the vault right now. Check that it is running, then reload.";

function describe(err: unknown): string {
  return err instanceof ApiRequestError ? err.message : UNREACHABLE;
}

export function App() {
  const session = useMemo(() => new Session(), []);
  const [stage, setStage] = useState<Stage>({ kind: 'connecting' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const caps = await api.capabilities();
        if (cancelled) return;
        if (caps.setup_required) return setStage({ kind: 'setup', caps });
        const token = await session.token();
        if (cancelled) return;
        setStage({ kind: token ? 'home' : 'sign-in', caps });
      } catch (err) {
        if (!cancelled) setStage({ kind: 'failed', message: describe(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  switch (stage.kind) {
    case 'connecting':
      return (
        <Shell title="Family Document Vault">
          <span className="status status-warn">Connecting to the vault…</span>
        </Shell>
      );
    case 'failed':
      return (
        <Shell title="Family Document Vault">
          <span className="status status-danger">Not connected</span>
          <p className="muted">{stage.message}</p>
        </Shell>
      );
    case 'setup':
      return (
        <SetupScreen
          onDone={(caps) => {
            setStage({ kind: 'home', caps });
          }}
          session={session}
          caps={stage.caps}
        />
      );
    case 'sign-in':
      return (
        <SignInScreen
          caps={stage.caps}
          session={session}
          onDone={() => setStage({ kind: 'home', caps: stage.caps })}
        />
      );
    case 'home':
      return (
        <HomeScreen
          caps={stage.caps}
          session={session}
          onSignedOut={() => setStage({ kind: 'sign-in', caps: stage.caps })}
          onStorage={() => setStage({ kind: 'storage', caps: stage.caps })}
        />
      );
    case 'storage':
      return (
        <StorageScreen
          session={session}
          onSignedOut={() => setStage({ kind: 'sign-in', caps: stage.caps })}
          onBack={() => setStage({ kind: 'home', caps: stage.caps })}
        />
      );
  }
}

function Shell({
  title,
  lede,
  children,
}: {
  title: string;
  lede?: string;
  children: React.ReactNode;
}) {
  return (
    <main className="page">
      <Logo />
      <div>
        <h1 style={{ fontSize: 32 }}>{title}</h1>
        {lede && <p className="lede">{lede}</p>}
      </div>
      <section className="card" aria-live="polite">
        {children}
      </section>
    </main>
  );
}

function SetupScreen(props: {
  caps: Capabilities;
  session: Session;
  onDone: (caps: Capabilities) => void;
}) {
  const [household, setHousehold] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const tokens = await api.setup({
        household_name: household,
        display_name: name,
        email,
        password,
      });
      props.session.accept(tokens);
      props.onDone({ ...props.caps, setup_required: false, branding: { display_name: household } });
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell
      title="Set up your family's vault"
      lede="You are the first person here, so you become the owner. You can invite the others afterwards."
    >
      <form onSubmit={(e) => void submit(e)} className="stack">
        <Field
          id="household"
          label="What should we call your family?"
          value={household}
          onChange={setHousehold}
          hint="For example: The Seikh family"
        />
        <Field id="name" label="Your name" value={name} onChange={setName} autoComplete="name" />
        <Field
          id="email"
          label="Your email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
        />
        <Field
          id="password"
          label="Choose a password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          hint="At least 10 characters. A few words you will remember work best."
        />
        <ErrorNote message={error} />
        <Button type="submit" disabled={busy}>
          {busy ? 'Setting up…' : 'Create my vault'}
        </Button>
      </form>
    </Shell>
  );
}

function SignInScreen(props: { caps: Capabilities; session: Session; onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      props.session.accept(await api.signIn(email, password));
      props.onDone();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title={props.caps.branding.display_name} lede="Sign in to open the vault.">
      <form onSubmit={(e) => void submit(e)} className="stack">
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
    </Shell>
  );
}

function HomeScreen(props: {
  caps: Capabilities;
  session: Session;
  onSignedOut: () => void;
  onStorage: () => void;
}) {
  const [me, setMe] = useState<Me | null>(null);
  const [devices, setDevices] = useState<SessionRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const { session, onSignedOut } = props;
  const load = useCallback(async () => {
    const token = await session.token();
    if (!token) return onSignedOut();
    try {
      const [who, sessions] = await Promise.all([api.me(token), api.sessions(token)]);
      setMe(who);
      setDevices(sessions.items);
    } catch (err) {
      setError(describe(err));
    }
  }, [session, onSignedOut]);

  useEffect(() => {
    // load() only sets state after awaiting the network; the compiler's
    // heuristic cannot see past the callback boundary.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const revoke = async (id: string) => {
    const token = await props.session.token();
    if (!token) return props.onSignedOut();
    await api.revokeSession(token, id);
    await load();
  };

  return (
    <Shell title={props.caps.branding.display_name} lede="You are signed in.">
      <ErrorNote message={error} />
      {me && <p className="muted">{`Role: ${me.role} · Server ${props.caps.server_version}`}</p>}
      <h2 style={{ fontSize: 18, marginTop: 16 }}>Signed-in devices</h2>
      <ul className="list">
        {devices.map((d) => (
          <li key={d.id}>
            <span>
              {d.user_agent ? shortAgent(d.user_agent) : 'Unknown device'}
              {d.current && <span className="muted"> · this one</span>}
            </span>
            {!d.current && (
              <Button kind="quiet" onClick={() => void revoke(d.id)}>
                Sign out
              </Button>
            )}
          </li>
        ))}
      </ul>
      <p className="muted">Documents arrive in the next releases.</p>
      {me?.role === 'owner' && (
        <Button kind="quiet" onClick={props.onStorage}>
          Where your files are kept
        </Button>
      )}
      <Button
        kind="quiet"
        onClick={() => {
          void props.session.signOut().then(props.onSignedOut);
        }}
      >
        Sign out
      </Button>
    </Shell>
  );
}

function shortAgent(ua: string): string {
  if (/iPhone|iPad/.test(ua)) return 'iPhone or iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Windows/.test(ua)) return 'Windows computer';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Linux/.test(ua)) return 'Linux computer';
  return ua.slice(0, 40);
}
