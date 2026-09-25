import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { whenWords, type DeviceRow } from '@fdv/shared';
import { api, type SmtpProvider, type SmtpView } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import * as push from '../push.js';
import { Button, ErrorNote, Field, TopBar } from '../ui.js';

/**
 * "How you hear about things": notifications on this device, what each
 * person wants, and — for owners — the household's own email settings
 * (decision 13: bring your own SMTP, with presets and a Test).
 */
export function NotificationsScreen() {
  const { withToken, session, authVersion } = useApp();
  const [state, setState] = useState<push.PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: prefs, setData: setPrefs } = useLoad(
    async (t) => api.preferences(t),
    [authVersion],
  );
  const isOwner = session.info?.role === 'owner';

  const refresh = useCallback(async () => {
    const s = await withToken((t) => push.currentState(t));
    if (s) setState(s);
  }, [withToken]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const toggle = async (on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const s = await withToken((t) => (on ? push.enable(t) : push.disable(t)));
      if (s) setState(s);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const setPref = async (patch: Record<string, boolean>) => {
    const next = await withToken((t) => api.updatePreferences(t, patch));
    if (next) setPrefs(next);
  };

  return (
    <main className="page page-top">
      <TopBar title="How you hear about things" back="/settings" />
      <p className="lede">
        Everything due lands in one message a day, not one per document. Nothing fires before 9 in
        the morning.
      </p>
      <ErrorNote message={error} />

      <section className="card stack" aria-labelledby="push-h">
        <h2 id="push-h" style={{ fontSize: 18 }}>
          On this device
        </h2>
        {state?.kind === 'on' && (
          <>
            <p className="status status-ok">Notifications are on for this device.</p>
            <Button kind="quiet" disabled={busy} onClick={() => void toggle(false)}>
              Turn them off here
            </Button>
          </>
        )}
        {state?.kind === 'off' && (
          <>
            <p className="muted">
              Get the day&apos;s reminders on this device, even when the vault is closed.
            </p>
            <Button disabled={busy} onClick={() => void toggle(true)}>
              {busy ? 'Asking…' : 'Turn on notifications'}
            </Button>
          </>
        )}
        {state && state.kind !== 'on' && state.kind !== 'off' && (
          <p className="status status-warn">{state.message}</p>
        )}
      </section>

      <Devices />

      <section className="card stack" aria-labelledby="prefs-h">
        <h2 id="prefs-h" style={{ fontSize: 18 }}>
          What you want
        </h2>
        <Check
          id="p-push"
          label="The day's reminders, on my devices"
          checked={prefs?.daily_push ?? true}
          onChange={(v) => void setPref({ daily_push: v })}
        />
        <Check
          id="p-daily"
          label="The day's reminders, by email"
          hint="Off by default: the app already tells you."
          checked={prefs?.daily_email ?? false}
          onChange={(v) => void setPref({ daily_email: v })}
        />
        <Check
          id="p-weekly"
          label="A summary every Sunday evening, by email"
          checked={prefs?.weekly_email ?? true}
          onChange={(v) => void setPref({ weekly_email: v })}
        />
        {!isOwner && <p className="muted">Email needs an owner to set up the mail server.</p>}
      </section>

      {isOwner && <SmtpSection />}
    </main>
  );
}

function Check(props: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="check">
      <input
        id={props.id}
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <label htmlFor={props.id}>
        {props.label}
        {props.hint && <span className="muted">{props.hint}</span>}
      </label>
    </div>
  );
}

/** The SMTP wizard: pick a provider, paste two fields, press Test. */
function SmtpSection() {
  const { withToken, authVersion } = useApp();
  const { data, reload } = useLoad(
    async (t) => {
      const [smtp, providers] = await Promise.all([api.smtp(t), api.smtpProviders(t)]);
      return { smtp, providers };
    },
    [authVersion],
  );
  const [providerKey, setProviderKey] = useState('gmail');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('587');
  const [secure, setSecure] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fromEmail, setFromEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [touched, setTouched] = useState(false);

  const provider = data?.providers.find((p: SmtpProvider) => p.key === providerKey);
  const smtp: SmtpView | undefined = data?.smtp;

  const choose = (key: string) => {
    setProviderKey(key);
    setResult(null);
    const p = data?.providers.find((x: SmtpProvider) => x.key === key);
    if (p) {
      setHost(p.host);
      setPort(String(p.port));
      setSecure(p.secure);
      setTouched(true);
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      await withToken((t) =>
        api.saveSmtp(t, {
          provider: providerKey,
          host,
          port: Number(port),
          secure,
          username: username || null,
          password: password || null,
          from_name: 'Family Document Vault',
          from_email: fromEmail,
        }),
      );
      const r = await withToken((t) => api.testSmtp(t));
      setResult(r ?? null);
      await reload();
      if (r?.ok) setPassword('');
    } catch (err) {
      setResult({ ok: false, message: describeError(err) });
    } finally {
      setBusy(false);
    }
  };

  const retest = async () => {
    setBusy(true);
    try {
      const r = await withToken((t) => api.testSmtp(t));
      setResult(r ?? null);
      await reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card stack" aria-labelledby="smtp-h">
      <h2 id="smtp-h" style={{ fontSize: 18 }}>
        Where email comes from
      </h2>
      {smtp?.configured && !touched ? (
        <>
          <p className={smtp.status === 'ok' ? 'status status-ok' : 'status status-danger'}>
            {smtp.status === 'ok'
              ? `Working. Sending as ${smtp.from_email} through ${smtp.host}.`
              : `Not working: ${smtp.last_error ?? 'the last test failed'}`}
          </p>
          {result && (
            <p className={result.ok ? 'status status-ok' : 'status status-danger'} role="status">
              {result.message}
            </p>
          )}
          <div className="row">
            <Button kind="quiet" disabled={busy} onClick={() => void retest()}>
              {busy ? 'Testing…' : 'Send another test'}
            </Button>
            <Button kind="quiet" onClick={() => setTouched(true)}>
              Change
            </Button>
          </div>
        </>
      ) : (
        <form onSubmit={(e) => void save(e)} className="stack">
          <p className="muted">
            Reminders come from your own email account, so they arrive from a domain your family
            trusts and nobody else handles them.
          </p>
          <div className="field">
            <label htmlFor="smtp-provider">Provider</label>
            <select id="smtp-provider" value={providerKey} onChange={(e) => choose(e.target.value)}>
              {(data?.providers ?? []).map((p: SmtpProvider) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </select>
            {provider?.hint && <span className="muted">{provider.hint}</span>}
          </div>
          <Field
            id="smtp-from"
            label="Send from"
            type="email"
            value={fromEmail}
            onChange={setFromEmail}
            hint="The address the reminders come from."
          />
          <Field
            id="smtp-user"
            label="Username"
            value={username}
            onChange={setUsername}
            required={false}
            hint="Usually the same email address."
            autoComplete="off"
          />
          <Field
            id="smtp-pass"
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            required={false}
            autoComplete="off"
            hint="Most providers need an app password, not your normal one."
          />
          <Field id="smtp-host" label="Server" value={host} onChange={setHost} />
          <div className="row">
            <div className="field" style={{ flexGrow: 1 }}>
              <label htmlFor="smtp-port">Port</label>
              <input
                id="smtp-port"
                inputMode="numeric"
                value={port}
                onChange={(e) => setPort(e.target.value)}
              />
            </div>
            <Check
              id="smtp-secure"
              label="Always use TLS (port 465)"
              checked={secure}
              onChange={setSecure}
            />
          </div>
          {result && (
            <p className={result.ok ? 'status status-ok' : 'status status-danger'} role="status">
              {result.message}
            </p>
          )}
          <Button type="submit" disabled={busy}>
            {busy ? 'Testing…' : 'Save and send a test'}
          </Button>
        </form>
      )}
    </section>
  );
}

/** A device as the list names it: the phone app says how it hears (0.4.14). */
function deviceName(d: DeviceRow): string {
  if (d.kind === 'unified_push') return 'The Android app';
  return d.label ?? 'A browser';
}

/**
 * Where you hear from the vault (0.4.14): every browser and phone that has
 * notifications on for you, which one is this one, which have stopped
 * working, and a test for each.
 */
function Devices() {
  const { withToken, authVersion } = useApp();
  const { data, reload } = useLoad(async (t) => (await api.devices(t)).items, [authVersion]);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!data || data.length === 0) return null;
  const test = async (id: string) => {
    setError(null);
    try {
      await withToken((t) => api.testDevice(t, id));
      setSent(id);
      await reload();
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <section className="card stack" aria-labelledby="devices-h">
      <h2 id="devices-h" style={{ fontSize: 18 }}>
        Where you hear from the vault
      </h2>
      <ErrorNote message={error} />
      <ul className="list">
        {data.map((d) => (
          <li key={d.id}>
            <span>
              {deviceName(d)}
              {d.this_session && <span className="muted"> · this one</span>}
              {d.signed_out ? (
                <span className="status status-warn">
                  {' '}
                  Signed out — it hears nothing until you sign in there again
                </span>
              ) : (
                !d.working && (
                  <span className="status status-warn">
                    {' '}
                    Not working{d.failed_at ? ` — last tried ${whenWords(d.failed_at)}` : ''}
                  </span>
                )
              )}
              {sent === d.id && <span className="muted"> · test sent</span>}
            </span>
            {!d.signed_out && (
              <Button kind="quiet" onClick={() => void test(d.id)}>
                Send a test
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
