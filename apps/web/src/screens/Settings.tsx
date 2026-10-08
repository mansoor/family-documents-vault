import { useEffect, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { Link, useLocation } from 'react-router';
import * as passkeys from '../passkeys.js';
import { api, type ExportRow, type NewVault, type Provider } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { Button, Check, ErrorNote, Field, TopBar } from '../ui.js';
import { can } from '@fdv/shared';
import { storedRole } from '../session.js';
import { setShortcutsOn, useShortcutsOn } from '../shortcuts.js';
import { ChangePassword } from './Password.js';

/** A row that opens a part of Settings with a page of its own. */
interface SettingsRow {
  to: string;
  title: string;
  note: string;
}

/**
 * Settings holds settings only (Phase 6, R1): your account, how you hear
 * about things, the household's own settings for those who keep them, and
 * your data for those who may export it. What else it held has a place of
 * its own in the navigation — the Inbox, Sharing, Activity, the Trash,
 * People outside the family — and After a restore is on Home while it waits.
 * Signing out is the account menu's.
 */
export function SettingsScreen() {
  const { caps, session, authVersion, withToken } = useApp();
  const role = storedRole();
  const owner = session.info?.role === 'owner';
  const { data: sessions, reload } = useLoad(
    async (t) => (await api.sessions(t)).items,
    [authVersion],
  );
  const revoke = async (id: string) => {
    await withToken((t) => api.revokeSession(t, id));
    await reload();
  };

  // Owners and adults, as before: each row where it was shown.
  const household: SettingsRow[] = [
    // Who sees the identity details on each profile (5.27, A34): an owner's.
    ...(caps?.features.member_identity && can(role, 'identity.audience')
      ? [{ to: '/settings/family', title: 'Family', note: 'Who can see identity details' }]
      : []),
    // The household's rule for Only me documents and links (5.41): read by
    // owners and adults, an owner's to change.
    ...(can(role, 'document.share')
      ? [
          {
            to: '/settings/household',
            title: 'Household',
            note: 'Whether Only me documents can be shared outside the family',
          },
        ]
      : []),
    ...(caps?.features.custom_types && can(role, 'types.manage')
      ? [
          {
            to: '/settings/kinds',
            title: 'Kinds of document',
            note: 'What the family keeps, and what the card asks for each',
          },
        ]
      : []),
    ...(owner
      ? [
          {
            to: '/settings/storage',
            title: 'Where your files are kept',
            note: 'Local disk, or your own S3-compatible bucket',
          },
          {
            to: '/settings/email',
            title: 'Where email comes from',
            note: 'The mail server reminders and invitations are sent through',
          },
        ]
      : []),
  ];

  return (
    <main className="page page-top has-nav">
      <TopBar title="Settings" />
      <p className="muted">
        {caps?.branding.display_name} · Server {caps?.server_version}
      </p>

      <section aria-labelledby="settings-account-h" className="stack settings-group">
        <h2 id="settings-account-h" className="settings-h">
          Your account
        </h2>
        <ChangePassword />
        <TwoStep />
        <Passkeys />
        <section aria-labelledby="devices-h">
          <h3 id="devices-h" className="section-h">
            Signed-in devices
          </h3>
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
        <KeyShortcuts />
      </section>

      <section aria-labelledby="settings-notifications-h" className="settings-group">
        <h2 id="settings-notifications-h" className="settings-h">
          Notifications
        </h2>
        <SettingsRows
          rows={[
            {
              to: '/settings/notifications',
              title: 'How you hear about things',
              note: 'Notifications on your devices, and email',
            },
          ]}
        />
      </section>

      {household.length > 0 && (
        <section aria-labelledby="settings-household-h" className="settings-group">
          <h2 id="settings-household-h" className="settings-h">
            Household
          </h2>
          <SettingsRows rows={household} />
        </section>
      )}

      {/* Only to whoever may export (5.35): a viewer, a guest or a teen
          asking would be refused. */}
      {can(role, 'export.request') && (
        <section aria-labelledby="settings-data-h" className="settings-group">
          <h2 id="settings-data-h" className="settings-h">
            Your data
          </h2>
          <ExportSection />
        </section>
      )}

      <ElsewhereNote />
    </main>
  );
}

/**
 * The single-key shortcuts, `/` and `n` (WCAG 2.1.4): on unless turned
 * off, on this device alone (shortcuts.ts).
 */
function KeyShortcuts() {
  const on = useShortcutsOn();
  return (
    <section aria-labelledby="keys-h">
      <h3 id="keys-h" className="section-h">
        On this device
      </h3>
      <Check
        id="single-keys"
        checked={on}
        onChange={setShortcutsOn}
        label="Single-key shortcuts (/ and n)"
        note="With a keyboard, / goes to the search box and n to Add. Turn them off if you type by voice, or if they get in your way."
      />
    </section>
  );
}

function SettingsRows({ rows }: { rows: SettingsRow[] }) {
  return (
    <ul className="list">
      {rows.map((r) => (
        <li key={r.to}>
          <Link to={r.to} className="rowbtn">
            <span className="doc-title">{r.title}</span>
            <span className="muted">{r.note}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * Where what Settings used to hold is now (R1), for whoever looks for it
 * here: each only where it is theirs.
 */
function ElsewhereNote() {
  const { caps, session } = useApp();
  const role = storedRole();
  const inbox = caps?.features.upload_requests === true && can(role, 'upload_request.create');
  const sharing = can(role, 'document.share');
  const outside = caps?.features.guests === true && session.info?.role === 'owner';
  const activity = can(role, 'audit.read');
  const trash = can(role, 'document.edit');
  const lines = [
    inbox && (
      <li key="inbox">
        {/* Their own tab since I1: the Inbox opens on your uploads. */}
        <Link to="/inbox/sent">Files sent to you</Link> are in the Inbox
      </li>
    ),
    sharing && (
      <li key="sharing">
        <Link to="/sharing">Sharing</Link>: links, and asking for documents
      </li>
    ),
    outside && (
      <li key="outside">
        <Link to="/people/outside">People outside the family</Link> are under People
      </li>
    ),
    activity && trash && (
      <li key="activity">
        <Link to="/activity">Activity</Link> and <Link to="/trash">Trash</Link> have their own
        places
      </li>
    ),
    activity && !trash && (
      <li key="activity">
        <Link to="/activity">Activity</Link> has its own place
      </li>
    ),
  ].filter(Boolean);
  if (lines.length === 0) return null;
  return (
    <div className="elsewhere">
      <p>
        <strong>Settings holds settings only.</strong>
      </p>
      <ul>{lines}</ul>
    </div>
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
      <h3 id="passkeys-h" style={{ fontSize: 18 }}>
        Passkeys
      </h3>
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
  // Linked to from where it is needed (5.25: an owner's Account card).
  const { hash } = useLocation();
  useEffect(() => {
    if (hash === '#two-step') document.getElementById('two-step')?.scrollIntoView?.();
  }, [hash]);
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
    <section id="two-step" aria-labelledby="twostep-h" className="card stack">
      <h3 id="twostep-h" style={{ fontSize: 18 }}>
        Two-step sign-in
      </h3>
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
      <h3 id="export-h" style={{ fontSize: 18 }}>
        Export everything
      </h3>
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
