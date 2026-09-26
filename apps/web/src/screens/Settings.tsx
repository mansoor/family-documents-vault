import { useEffect, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { Link, useNavigate } from 'react-router';
import * as passkeys from '../passkeys.js';
import { api, type ExportRow, type NewVault, type Provider } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { BottomNav, Button, ErrorNote, Field, TopBar } from '../ui.js';
import { can } from '@fdv/shared';
import { storedRole } from '../session.js';
import { ChangePassword } from './Password.js';

export function SettingsScreen() {
  const { caps, session, markAuthChanged, authVersion } = useApp();
  const navigate = useNavigate();
  const { data: sessions, reload } = useLoad(
    async (t) => (await api.sessions(t)).items,
    [authVersion],
  );
  const { withToken } = useApp();

  const revoke = async (id: string) => {
    await withToken((t) => api.revokeSession(t, id));
    await reload();
  };
  const signOut = async () => {
    await session.signOut();
    markAuthChanged();
    void navigate('/sign-in', { replace: true });
  };

  return (
    <main className="page page-top has-nav">
      <TopBar title="Settings" back="/" />
      <p className="muted">
        {caps?.branding.display_name} · Server {caps?.server_version}
      </p>
      <ul className="list">
        {can(storedRole(), 'audit.read') && (
          <li>
            <Link to="/settings/activity" className="rowbtn">
              <span className="doc-title">What has been happening</span>
              <span className="muted">Everything anybody has done in this vault</span>
            </Link>
          </li>
        )}
        {can(storedRole(), 'document.edit') && (
          <li>
            <Link to="/settings/trash" className="rowbtn">
              <span className="doc-title">Trash</span>
              <span className="muted">
                Documents moved to the Trash, and the way to bring them back
              </span>
            </Link>
          </li>
        )}
        <li>
          <Link to="/settings/notifications" className="rowbtn">
            <span className="doc-title">How you hear about things</span>
            <span className="muted">Notifications on your devices, and email</span>
          </Link>
        </li>
        {session.info?.role === 'owner' && (
          <li>
            <Link to="/settings/storage" className="rowbtn">
              <span className="doc-title">Where your files are kept</span>
              <span className="muted">Local disk, or your own S3-compatible bucket</span>
            </Link>
          </li>
        )}
      </ul>
      <ChangePassword />
      <section aria-labelledby="devices-h">
        <h2 id="devices-h" className="section-h">
          Signed-in devices
        </h2>
        <ul className="list">
          {(sessions ?? []).map((d) => (
            <li key={d.id}>
              <span>
                {d.label ?? shortAgent(d.user_agent)}
                {d.current && <span className="muted"> · this one</span>}
                {/* Signing it out also ends what it keeps (0.4.13). */}
                {d.offline && <span className="muted"> · Keeps Essentials for offline use</span>}
              </span>
              {!d.current && (
                <Button kind="quiet" onClick={() => void revoke(d.id)}>
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      </section>
      <Passkeys />
      <TwoStep />
      <ExportSection />
      <Button kind="quiet" onClick={() => void signOut()}>
        Sign out
      </Button>
      <BottomNav />
    </main>
  );
}

/**
 * Passkeys: the primary credential. A face or a fingerprint on this
 * device, checked by the device, with nothing shared that could be
 * phished or stolen from the server.
 */
function Passkeys() {
  const { guarded, authVersion } = useApp();
  const { data, reload } = useLoad(async (t) => (await api.passkeys(t)).items, [authVersion]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState('');

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await guarded((t) => passkeys.enrol(t, label.trim() || 'This device'));
      setLabel('');
      await reload();
    } catch (err) {
      setError(passkeys.describe(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      await guarded((t) => api.removePasskey(t, id));
      await reload();
    } catch (err) {
      setError(describeError(err));
    }
  };

  return (
    <section aria-labelledby="passkeys-h" className="card stack">
      <h2 id="passkeys-h" style={{ fontSize: 18 }}>
        Passkeys
      </h2>
      <p className="muted">
        Sign in with your face, your fingerprint or your screen lock. There is nothing to remember
        and nothing a fake sign-in page could take.
      </p>
      <ul className="list">
        {(data ?? []).map((k) => (
          <li key={k.id}>
            <span>
              <strong>{k.label ?? 'A passkey'}</strong>
              <span className="muted">
                Added {new Date(k.created_at).toLocaleDateString()}
                {k.last_used_at
                  ? ` · last used ${new Date(k.last_used_at).toLocaleDateString()}`
                  : ' · not used yet'}
                {k.backed_up ? ' · synced to your other devices' : ''}
              </span>
            </span>
            <Button kind="quiet" onClick={() => void remove(k.id)}>
              Remove
            </Button>
          </li>
        ))}
        {data?.length === 0 && <li className="muted">None yet.</li>}
      </ul>
      <ErrorNote message={error} />
      {!passkeys.supported() ? (
        <p className="status status-warn">This browser cannot make passkeys.</p>
      ) : !passkeys.secureEnough() ? (
        <p className="status status-warn">
          Passkeys need a secure connection. The vault is reachable at an address the browser does
          not trust yet — the README explains how to give it one.
        </p>
      ) : (
        <form onSubmit={(e) => void add(e)} className="stack">
          <Field
            id="passkey-label"
            label="What to call this device"
            value={label}
            onChange={setLabel}
            required={false}
            hint="So you can tell them apart later."
          />
          <Button type="submit" disabled={busy}>
            {busy ? 'Waiting for your device…' : 'Add a passkey on this device'}
          </Button>
        </form>
      )}
    </section>
  );
}

/** SEC-03: two-step sign-in, mandatory for owners. */
function TwoStep() {
  const { guarded, authVersion } = useApp();
  const { data: me, reload } = useLoad(async (t) => api.me(t), [authVersion]);
  const [enrol, setEnrol] = useState<{ secret: string; otpauth_url: string; qr: string } | null>(
    null,
  );
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setError(null);
    try {
      const r = await guarded((t) => api.totpEnrol(t));
      if (!r) return;
      const qr = await QRCode.toDataURL(r.otpauth_url, { margin: 1, width: 220 });
      setEnrol({ ...r, qr });
    } catch (err) {
      setError(describeError(err));
    }
  };
  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await guarded((t) => api.totpConfirm(t, code));
      setEnrol(null);
      setCode('');
      await reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="twostep-h" className="card stack">
      <h2 id="twostep-h" style={{ fontSize: 18 }}>
        Two-step sign-in
      </h2>
      {me?.totp_enabled ? (
        <p className="status status-ok">
          On. Signing in asks for a code from your authenticator app.
        </p>
      ) : enrol ? (
        <form onSubmit={(e) => void confirm(e)} className="stack">
          <p className="muted">
            Scan this with an authenticator app (Google Authenticator, Authy, 1Password…), then
            enter the code it shows.
          </p>
          <img src={enrol.qr} alt="QR code for your authenticator app" width={220} height={220} />
          <p className="muted">
            Or type the key by hand: <code>{enrol.secret}</code>
          </p>
          <Field
            id="totp-code"
            label="Code from the app"
            value={code}
            onChange={setCode}
            autoComplete="one-time-code"
          />
          <ErrorNote message={error} />
          <Button type="submit" disabled={busy}>
            Turn on
          </Button>
        </form>
      ) : (
        <>
          {me?.totp_required && (
            <p className="status status-warn">Owners must switch this on. It takes a minute.</p>
          )}
          <p className="muted">
            A code from your phone as well as your password, so a stolen password alone cannot open
            the vault.
          </p>
          <ErrorNote message={error} />
          <Button kind="quiet" onClick={() => void start()}>
            Set up two-step sign-in
          </Button>
        </>
      )}
    </section>
  );
}

/** STO-07: one button, one ZIP, no lock-in. */
function ExportSection() {
  const { guarded, authVersion } = useApp();
  const { data, reload } = useLoad(async (t) => (await api.exports(t)).items, [authVersion]);
  const [error, setError] = useState<string | null>(null);
  const pending = (data ?? []).some((e) => e.state === 'queued' || e.state === 'running');

  useEffect(() => {
    if (!pending) return;
    const h = setInterval(() => void reload(), 2000);
    return () => clearInterval(h);
  }, [pending, reload]);

  const start = async () => {
    setError(null);
    try {
      await guarded((t) => api.requestExport(t));
      await reload();
    } catch (err) {
      setError(describeError(err));
    }
  };
  const download = async (e: ExportRow) => {
    setError(null);
    try {
      const blob = await guarded((t) => api.exportContent(t, e.id));
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'family-document-vault-export.zip';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      setError(describeError(err));
    }
  };

  return (
    <section aria-labelledby="export-h" className="card stack">
      <h2 id="export-h" style={{ fontSize: 18 }}>
        Export everything
      </h2>
      <p className="muted">
        A ZIP with every original file you can see, plus a readable index. It works with no app at
        all, and it doubles as your disaster plan.
      </p>
      <ErrorNote message={error} />
      <Button kind="quiet" onClick={() => void start()} disabled={pending}>
        {pending ? 'Preparing…' : 'Make an export'}
      </Button>
      <ul className="list">
        {(data ?? []).slice(0, 3).map((e) => (
          <li key={e.id}>
            <span>
              <strong>{new Date(e.created_at).toLocaleString()}</strong>
              <span className="muted">
                {e.state === 'done'
                  ? `${e.document_count} document${e.document_count === 1 ? '' : 's'} · ${((e.byte_size ?? 0) / 1024 / 1024).toFixed(1)} MB`
                  : e.state === 'failed'
                    ? `Failed: ${e.error ?? 'unknown'}`
                    : 'Preparing…'}
              </span>
            </span>
            {e.state === 'done' && (
              <Button kind="quiet" onClick={() => void download(e)}>
                Download
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function shortAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  if (/iPhone|iPad/.test(ua)) return 'iPhone or iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Windows/.test(ua)) return 'Windows computer';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Linux/.test(ua)) return 'Linux computer';
  return ua.slice(0, 40);
}

/**
 * "Where your files are kept" — the Storage board from the prototype.
 */
export function StorageScreen() {
  const { withToken, guarded, authVersion } = useApp();
  const [notice, setNotice] = useState<string | null>(null);
  const { data, error, reload } = useLoad(
    async (t) => {
      const [v, p] = await Promise.all([api.vaults(t), api.providers(t)]);
      return { vaults: v.items, providers: p };
    },
    [authVersion],
  );

  const activate = async (id: string) => {
    await guarded((t) => api.activateVault(t, id));
    setNotice('Done. New files will be kept there from now on.');
    await reload();
  };
  const remove = async (id: string) => {
    await guarded((t) => api.removeVault(t, id));
    await reload();
  };

  return (
    <main className="page page-top">
      <TopBar title="Where your files are kept" back="/settings" />
      <p className="lede">
        Your documents are scrambled before they leave this app, so whoever stores them cannot read
        them.
      </p>
      <ErrorNote message={error} />
      {notice && <p className="notice">{notice}</p>}

      <ul className="list" aria-label="Places">
        {(data?.vaults ?? []).map((v) => (
          <li key={v.id} className="place">
            <div>
              <div className="place-title">
                {v.label}
                {v.active && <span className="badge">In use</span>}
                {!v.active && v.status === 'failed' && (
                  <span className="badge badge-danger">Not working</span>
                )}
                {!v.active && v.status === 'untested' && (
                  <span className="badge badge-warn">Not tested</span>
                )}
              </div>
              <div className="muted">
                {v.kind === 'local'
                  ? 'Works with no internet'
                  : `${v.bucket ?? ''}${v.endpoint ? ` at ${hostOf(v.endpoint)}` : ''}`}
                {v.last_error && !v.active ? ` · ${v.last_error}` : ''}
              </div>
            </div>
            {!v.active && (
              <div className="row">
                {v.status === 'ok' && (
                  <Button kind="quiet" onClick={() => void activate(v.id)}>
                    Use this
                  </Button>
                )}
                <Button kind="quiet" onClick={() => void remove(v.id)}>
                  Remove
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>

      <AddPlace
        providers={data?.providers ?? []}
        onAdd={async (body) => {
          try {
            const created = await guarded((t) => api.addVault(t, body));
            if (!created) return null;
            const result = await withToken((t) => api.testVault(t, created.id));
            await reload();
            return result ?? null;
          } catch (err) {
            return { ok: false, message: describeError(err) };
          }
        }}
      />
    </main>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function AddPlace(props: {
  providers: Provider[];
  onAdd: (body: NewVault) => Promise<{ ok: boolean; message: string } | null>;
}) {
  const [providerKey, setProviderKey] = useState('b2');
  const [endpoint, setEndpoint] = useState('');
  const [region, setRegion] = useState('');
  const [bucket, setBucket] = useState('');
  const [keyId, setKeyId] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const provider = props.providers.find((p) => p.key === providerKey);
  const needsEndpoint = providerKey !== 'aws';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    const body: NewVault = {
      provider: providerKey,
      bucket,
      access_key_id: keyId,
      secret_access_key: secret,
    };
    if (needsEndpoint) body.endpoint = endpoint || provider?.endpoint || null;
    if (region) body.region = region;
    const r = await props.onAdd(body);
    setResult(r);
    if (r?.ok) {
      setBucket('');
      setKeyId('');
      setSecret('');
    }
    setBusy(false);
  };

  return (
    <section className="card">
      <h2 style={{ fontSize: 18, marginBottom: 12 }}>Add another place</h2>
      <form onSubmit={(e) => void submit(e)} className="stack">
        <div className="field">
          <label htmlFor="s-provider">Provider</label>
          <select
            id="s-provider"
            value={providerKey}
            onChange={(e) => {
              setProviderKey(e.target.value);
              setEndpoint('');
              setResult(null);
            }}
          >
            {props.providers.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </select>
          {provider?.hint && <span className="muted">{provider.hint}</span>}
        </div>
        {needsEndpoint && (
          <Field
            id="s-endpoint"
            label="Address"
            value={endpoint}
            onChange={setEndpoint}
            hint={provider?.endpoint ? `Usually ${provider.endpoint}` : undefined}
          />
        )}
        <Field
          id="s-region"
          label="Region (if your provider has one)"
          value={region}
          onChange={setRegion}
          required={false}
        />
        <Field id="s-bucket" label="Bucket name" value={bucket} onChange={setBucket} />
        <Field id="s-key" label="Key ID" value={keyId} onChange={setKeyId} autoComplete="off" />
        <Field
          id="s-secret"
          label="Application key"
          type="password"
          value={secret}
          onChange={setSecret}
          autoComplete="off"
        />
        {result && (
          <p className={result.ok ? 'status status-ok' : 'status status-danger'} role="status">
            {result.message}
          </p>
        )}
        <Button type="submit" disabled={busy}>
          {busy ? 'Testing…' : 'Test and save this place'}
        </Button>
      </form>
    </section>
  );
}
