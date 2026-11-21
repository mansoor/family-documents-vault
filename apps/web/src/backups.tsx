import {
  OFFSITE_RETAIN_DEFAULT,
  OFFSITE_RETAIN_MAX,
  OFFSITE_RETAIN_MIN,
  offsiteProblemWords,
  type OffsiteTestResult,
  type OffsiteView,
} from '@fdv/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from './api.js';
import { describeError, useApp, useLoad } from './app-context.js';
import { dateTimeWords } from './family-time.js';
import { SettingsPage } from './screens/Settings.js';
import { Button, Check, ConfirmDialog, ErrorNote, Field, LoadFailed } from './ui.js';

/**
 * Settings → Server and reading → Backups (0.9.0-dev.76), an owner's: what
 * the nightly backup holds, and a copy of each one somewhere else — a bucket
 * on any S3-compatible service. The copy is the backup file as it is,
 * encrypted under the master key; the secret key is sent once and kept
 * sealed, never shown again. Saved, a test writes a small file there and
 * deletes it; only once one passed can the copy be turned on, and a new
 * bucket, key or secret waits for a test of its own.
 */
export function BackupsScreen() {
  const { authVersion, caps } = useApp();
  const { data, error, reload, setData } = useLoad((t) => api.offsiteBackup(t), [authVersion]);
  const days = caps?.limits.backup_retain_days ?? null;
  return (
    <SettingsPage title="Backups" subtitle="Nightly backups, and a copy somewhere else">
      <p className="lede">
        Every night the vault writes an encrypted backup of its database on this server
        {days ? `, and keeps ${days} days of them` : ''}. A backup holds the database: every
        document’s details and notes, the people, the activity log and the settings.
      </p>
      <p className="attention attention-warn" role="note" data-testid="backups-files-note">
        A backup does not hold the document files themselves. Keep a copy of those yourself: the
        vault’s files volume on this server, or the bucket in Settings → Storage.
      </p>
      {data === null && error ? (
        <LoadFailed message={error} what="backups" onRetry={() => void reload()} />
      ) : data === null ? (
        <p className="muted">Loading…</p>
      ) : !data.available ? (
        <p className="muted">
          Whoever runs this vault keeps its backups, so they are not copied from here.
        </p>
      ) : (
        <>
          <h2 className="section-h">A copy somewhere else</h2>
          <p>
            One lost disk, or the server’s volumes removed, would take the vault and its backups
            together. The vault can copy each backup, as it is — still encrypted — to a bucket on
            Amazon S3, Backblaze B2, Wasabi, MinIO or any other S3-compatible service, and keep the
            newest few there. Only you and the vault hold the key to read them: keep the master key
            (in the server’s <code>.env</code> or key file) somewhere other than the server too,
            such as a password manager, or a copy is no use.
          </p>
          <p
            className={
              data.settings?.enabled &&
              data.settings.last_result !== 'failed' &&
              !data.settings.late
                ? 'attention attention-calm'
                : 'attention'
            }
            role="status"
            data-testid="offsite-status"
          >
            {statusWords(data)}
          </p>
          {data.settings?.can_delete === false && (
            <p className="attention attention-warn" role="note" data-testid="offsite-no-delete">
              This key can’t delete, so old copies are not removed here — set a lifecycle rule on
              the bucket to remove them after a while. (A key that can’t delete is the safer kind: a
              server taken over could not wipe the copies.)
            </p>
          )}
          <OffsiteForm view={data} onSaved={setData} />
          {data.settings && <OffsiteActions view={data} onChanged={setData} />}
        </>
      )}
    </SettingsPage>
  );
}

/** What the copy is doing, in a sentence. */
export function statusWords(v: OffsiteView): string {
  const s = v.settings;
  if (!s) return 'Not set up. Backups stay on this server only.';
  if (s.enabled) {
    if (s.last_result === 'failed') {
      return `On, but the last copy did not go: ${offsiteProblemWords(s.last_problem)}`;
    }
    if (s.late) {
      return 'On, but no copy has gone lately. Check that the backups are made and the worker is running.';
    }
    if (s.last_copy_at) {
      return `On. The last copy went ${dateTimeWords(s.last_copy_at)}${
        s.last_copy_bytes !== null ? ` (${sizeWords(s.last_copy_bytes)})` : ''
      }.`;
    }
    return 'On. The first copy goes after the next nightly backup.';
  }
  if (s.status === 'ok') return 'Tested, and off. Turn it on to copy each backup there.';
  if (s.status === 'failed') {
    return `Off. The last test did not go: ${offsiteProblemWords(s.test_problem)}`;
  }
  return 'Saved, not yet tested. Send a test: nothing is copied until one goes.';
}

function sizeWords(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The bucket: where it is, which folder in it, the access key and its
 * secret, and how many copies to keep. The secret left blank keeps the one
 * set, unless the address, bucket or access key changed.
 */
function OffsiteForm(props: { view: OffsiteView; onSaved: (v: OffsiteView) => void }) {
  const { guarded } = useApp();
  const s = props.view.settings;
  const [endpoint, setEndpoint] = useState(s?.endpoint ?? '');
  const [region, setRegion] = useState(s?.region ?? '');
  const [bucket, setBucket] = useState(s?.bucket ?? '');
  const [prefix, setPrefix] = useState(s?.prefix ?? '');
  const [keyId, setKeyId] = useState(s?.access_key_id ?? '');
  const [secret, setSecret] = useState('');
  const [pathStyle, setPathStyle] = useState(s?.path_style ?? true);
  const [keep, setKeep] = useState(String(s?.retain_count ?? OFFSITE_RETAIN_DEFAULT));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const line = useRef<HTMLParagraphElement>(null);
  // The form starts from what the vault has, each time it is loaded: set
  // while drawing, never in an effect after it, so nothing typed before an
  // effect would have run is put back.
  const [from, setFrom] = useState(s);
  if (from !== s) {
    setFrom(s);
    setEndpoint(s?.endpoint ?? '');
    setRegion(s?.region ?? '');
    setBucket(s?.bucket ?? '');
    setPrefix(s?.prefix ?? '');
    setKeyId(s?.access_key_id ?? '');
    setSecret('');
    setPathStyle(s?.path_style ?? true);
    setKeep(String(s?.retain_count ?? OFFSITE_RETAIN_DEFAULT));
  }
  useEffect(() => {
    if (said) line.current?.focus();
  }, [said]);

  // The secret was kept for this address, bucket and access key alone.
  const moved =
    s !== null &&
    s.secret_access_key === 'set' &&
    (endpoint.trim().replace(/\/+$/, '') !== (s.endpoint ?? '') ||
      bucket.trim() !== s.bucket ||
      keyId.trim() !== s.access_key_id);
  const secretNeeded = (s === null || s.secret_access_key !== 'set' || moved) && secret === '';

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const keepN = Number(keep);
    if (!bucket.trim()) {
      setError('Type the bucket’s name.');
      document.getElementById('offsite-bucket')?.focus();
      return;
    }
    if (!keyId.trim()) {
      setError('Type the access key ID.');
      document.getElementById('offsite-key')?.focus();
      return;
    }
    if (secretNeeded) {
      setError(
        moved
          ? 'Type the secret key again for the new address, bucket or access key.'
          : 'Type the secret key.',
      );
      document.getElementById('offsite-secret')?.focus();
      return;
    }
    if (!Number.isInteger(keepN) || keepN < OFFSITE_RETAIN_MIN || keepN > OFFSITE_RETAIN_MAX) {
      setError(`Keep a number of copies from ${OFFSITE_RETAIN_MIN} to ${OFFSITE_RETAIN_MAX}.`);
      return;
    }
    setBusy(true);
    setError(null);
    setSaid(null);
    try {
      const done = await guarded((t) =>
        api.setOffsiteBackup(t, {
          endpoint: endpoint.trim() || null,
          region: region.trim() || null,
          bucket: bucket.trim(),
          prefix: prefix.trim() || null,
          path_style: pathStyle,
          access_key_id: keyId.trim(),
          ...(secret !== '' ? { secret_access_key: secret } : {}),
          retain_count: keepN,
        }),
      );
      if (done !== null) {
        setSecret('');
        props.onSaved(done);
        setSaid(
          done.settings?.enabled
            ? 'Saved. The copy is still on.'
            : 'Saved. Now send a test: nothing is copied until one goes.',
        );
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="stack"
      onSubmit={(e) => void save(e)}
      aria-labelledby="offsite-set-h"
      noValidate
    >
      <h3 id="offsite-set-h" className="section-h">
        The bucket
      </h3>
      <Field
        id="offsite-endpoint"
        label="Address"
        value={endpoint}
        placeholder="https://s3.eu-central-003.backblazeb2.com"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        note="The S3 address your provider gives. Leave it empty for Amazon S3 itself."
        onChange={setEndpoint}
      />
      <Field
        id="offsite-region"
        label="Region"
        value={region}
        autoComplete="off"
        autoCapitalize="off"
        note="Such as eu-central-003 or us-east-1. Needed for Amazon S3."
        onChange={setRegion}
      />
      <Field
        id="offsite-bucket"
        label="Bucket name"
        value={bucket}
        autoComplete="off"
        autoCapitalize="off"
        onChange={setBucket}
      />
      <Field
        id="offsite-prefix"
        label="Folder in the bucket (optional)"
        value={prefix}
        placeholder="family-vault"
        autoComplete="off"
        autoCapitalize="off"
        note="The vault writes only here, and removes only its own older copies from here."
        onChange={setPrefix}
      />
      <Field
        id="offsite-key"
        label="Access key ID"
        value={keyId}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        note="Names the key, like a user name. Give it a key that may write, list and delete in this bucket only."
        onChange={setKeyId}
      />
      <Field
        id="offsite-secret"
        label="Secret key"
        type="password"
        value={secret}
        autoComplete="new-password"
        note={
          s?.secret_access_key === 'set' && !moved
            ? 'Set, and kept encrypted. Leave it empty to keep it.'
            : 'Shown once when you make the key. The vault keeps it encrypted, and never shows it again.'
        }
        onChange={setSecret}
      />
      <Check
        id="offsite-path-style"
        checked={pathStyle}
        label="Path-style addresses"
        note="On for MinIO and most servers you run yourself; off if your provider asks for bucket.address."
        onChange={setPathStyle}
      />
      <Field
        id="offsite-keep"
        label="Copies to keep there"
        value={keep}
        inputMode="numeric"
        note="One a night: 30 keeps a month. Older copies of the vault’s are removed from the bucket."
        onChange={setKeep}
      />
      <ErrorNote message={error} />
      <div className="row">
        <Button kind="primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
      <p ref={line} className="status-line" role="status" tabIndex={-1}>
        {said}
      </p>
    </form>
  );
}

/** Send a test, turn the copy on or off, or forget the bucket. */
function OffsiteActions(props: { view: OffsiteView; onChanged: (v: OffsiteView) => void }) {
  const { guarded, withToken } = useApp();
  const s = props.view.settings;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OffsiteTestResult | null>(null);
  const [asking, setAsking] = useState(false);
  const line = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (result) line.current?.focus();
  }, [result]);
  if (!s) return null;

  const act = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  const test = () =>
    act(async () => {
      setResult(null);
      const r = await withToken((t) => api.testOffsiteBackup(t));
      if (r) {
        setResult(r);
        props.onChanged(r.view);
      }
    });
  const turn = (on: boolean) =>
    act(async () => {
      const v = await guarded((t) => api.setOffsiteBackupEnabled(t, on));
      if (v) props.onChanged(v);
    });
  const remove = () =>
    act(async () => {
      const v = await guarded((t) => api.removeOffsiteBackup(t));
      setAsking(false);
      if (v) props.onChanged(v);
    });

  return (
    <section className="stack" aria-labelledby="offsite-test-h">
      <h3 id="offsite-test-h" className="section-h">
        Test, and turn it on
      </h3>
      <p className="muted">
        A test writes a small file in the folder, lists it and deletes it: everything a copy needs
        the key to do.
      </p>
      <div className="row">
        <Button kind="primary" onClick={() => void test()} disabled={busy}>
          {busy ? 'Working…' : 'Send a test'}
        </Button>
        {s.enabled ? (
          <Button kind="quiet" onClick={() => void turn(false)} disabled={busy}>
            Turn off the copy
          </Button>
        ) : (
          <Button kind="quiet" onClick={() => void turn(true)} disabled={busy || s.status !== 'ok'}>
            Turn on the copy
          </Button>
        )}
        <Button kind="quiet" onClick={() => setAsking(true)} disabled={busy}>
          Remove
        </Button>
      </div>
      <ErrorNote message={error} />
      <p
        ref={line}
        className={result ? (result.ok ? 'attention attention-calm' : 'attention') : 'status-line'}
        role="status"
        tabIndex={-1}
      >
        {result?.words}
      </p>
      {asking && (
        <ConfirmDialog
          title="Stop copying backups off-site?"
          confirmLabel="Remove"
          busyLabel="Removing…"
          danger
          busy={busy}
          onConfirm={() => void remove()}
          onCancel={() => setAsking(false)}
        >
          <p>
            The vault forgets the bucket and its secret key, and copies no more backups there. The
            copies already in the bucket stay there until you delete them.
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}
