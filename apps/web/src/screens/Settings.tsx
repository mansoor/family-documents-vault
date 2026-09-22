import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, type NewVault, type Provider } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { BottomNav, Button, ErrorNote, Field, TopBar } from '../ui.js';

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
        {session.info?.role === 'owner' && (
          <li>
            <Link to="/settings/storage" className="rowbtn">
              <span className="doc-title">Where your files are kept</span>
              <span className="muted">Local disk, or your own S3-compatible bucket</span>
            </Link>
          </li>
        )}
      </ul>
      <section aria-labelledby="devices-h">
        <h2 id="devices-h" className="section-h">
          Signed-in devices
        </h2>
        <ul className="list">
          {(sessions ?? []).map((d) => (
            <li key={d.id}>
              <span>
                {shortAgent(d.user_agent)}
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
      </section>
      <Button kind="quiet" onClick={() => void signOut()}>
        Sign out
      </Button>
      <BottomNav />
    </main>
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
  const { withToken, authVersion } = useApp();
  const [notice, setNotice] = useState<string | null>(null);
  const { data, error, reload } = useLoad(
    async (t) => {
      const [v, p] = await Promise.all([api.vaults(t), api.providers(t)]);
      return { vaults: v.items, providers: p };
    },
    [authVersion],
  );

  const activate = async (id: string) => {
    await withToken((t) => api.activateVault(t, id));
    setNotice('Done. New files will be kept there from now on.');
    await reload();
  };
  const remove = async (id: string) => {
    await withToken((t) => api.removeVault(t, id));
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
            const created = await withToken((t) => api.addVault(t, body));
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
