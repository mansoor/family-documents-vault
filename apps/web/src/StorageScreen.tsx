import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiRequestError, type NewVault, type Provider, type VaultRow } from './api.js';
import type { Session } from './session.js';
import { Button, ErrorNote, Field } from './ui.js';

/**
 * "Where your files are kept" — the Storage board from the prototype.
 * Lists the places, marks the one in use, and adds an S3-compatible bucket
 * through a provider preset, a bucket name and two keys, with a Test that
 * must pass before Save.
 */
export function StorageScreen(props: {
  session: Session;
  onSignedOut: () => void;
  onBack: () => void;
}) {
  const { session, onSignedOut } = props;
  const [vaults, setVaults] = useState<VaultRow[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const withToken = useCallback(
    async <T,>(fn: (token: string) => Promise<T>): Promise<T | undefined> => {
      const token = await session.token();
      if (!token) {
        onSignedOut();
        return undefined;
      }
      try {
        setError(null);
        return await fn(token);
      } catch (err) {
        setError(
          err instanceof ApiRequestError ? err.message : "We can't reach the vault right now.",
        );
        return undefined;
      }
    },
    [session, onSignedOut],
  );

  const load = useCallback(async () => {
    await withToken(async (t) => {
      const [v, p] = await Promise.all([api.vaults(t), api.providers(t)]);
      setVaults(v.items);
      setProviders(p);
    });
  }, [withToken]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const activate = async (id: string) => {
    await withToken((t) => api.activateVault(t, id));
    setNotice('Done. New files will be kept there from now on.');
    await load();
  };
  const remove = async (id: string) => {
    await withToken((t) => api.removeVault(t, id));
    await load();
  };

  return (
    <main className="page page-top">
      <header className="topbar">
        <button type="button" className="back" aria-label="Back" onClick={props.onBack}>
          ‹
        </button>
        <h1 style={{ fontSize: 24 }}>Where your files are kept</h1>
      </header>
      <p className="lede">
        Your documents are scrambled before they leave this app, so whoever stores them cannot read
        them.
      </p>
      <ErrorNote message={error} />
      {notice && <p className="notice">{notice}</p>}

      <ul className="list" aria-label="Places">
        {vaults.map((v) => (
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
        providers={providers}
        onAdd={async (body) => {
          const created = await withToken((t) => api.addVault(t, body));
          if (!created) return null;
          const result = await withToken((t) => api.testVault(t, created.id));
          await load();
          return result ?? null;
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
