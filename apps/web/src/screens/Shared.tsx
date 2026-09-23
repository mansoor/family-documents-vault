import { useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { api, type SharedDocument, type SharePreview } from '../api.js';
import { describeError } from '../app-context.js';
import { Button, ErrorNote, Field, Logo } from '../ui.js';

/**
 * The page somebody outside the family lands on (SHR-05).
 *
 * They have no account and are not going to make one. The page has one
 * job: tell them whose vault this is and who sent it, then give them the
 * file. Everything else — the household's name, the rest of the vault,
 * even the other documents' existence — is none of their business and is
 * not on the page.
 */
export function SharedScreen() {
  const { token } = useParams<{ token: string }>();
  const [preview, setPreview] = useState<SharePreview | null>(null);
  const [doc, setDoc] = useState<SharedDocument | null>(null);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const p = await api.sharePreview(token ?? '');
        if (!live) return;
        setPreview(p);
        // With no PIN there is nothing to ask, so the document arrives at
        // once rather than behind a button that says "continue".
        if (!p.needs_pin) setDoc(await api.openShare(token ?? ''));
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
      setDoc(await api.openShare(token ?? '', pin));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <main className="page">
        <Logo />
        <section className="card stack">
          <h1 style={{ fontSize: 22 }}>This link cannot be opened</h1>
          <p className="muted">{loadError}</p>
        </section>
      </main>
    );
  }

  if (!preview) {
    return (
      <main className="page">
        <Logo />
        <span className="status status-warn">Opening the link…</span>
      </main>
    );
  }

  return (
    <main className="page">
      <Logo />
      <h1 style={{ fontSize: 26 }}>{doc?.document_title ?? 'A shared document'}</h1>
      <section className="card stack">
        {doc ? (
          <>
            <p>
              {doc.shared_by ? <strong>{doc.shared_by}</strong> : 'Somebody'} shared this with you
              from {preview.household_name}.
            </p>
            {doc.document_type && <p className="muted">{doc.document_type}</p>}
            <a
              className="btn btn-primary"
              href={api.sharedContentUrl(token ?? '', pin || undefined)}
              download={doc.filename}
            >
              Download {doc.filename}
            </a>
            <p className="muted">
              This link stops working on {new Date(preview.expires_at).toLocaleDateString()}, and
              whoever sent it can take it back sooner. They can see that you opened it.
            </p>
          </>
        ) : (
          <form onSubmit={(e) => void submit(e)} className="stack">
            <p>
              {preview.shared_by ? <strong>{preview.shared_by}</strong> : 'Somebody'} shared a
              document with you from {preview.household_name}, and put a PIN on it.
            </p>
            <Field
              id="share-pin"
              label="The four-digit PIN they gave you"
              value={pin}
              onChange={setPin}
              autoComplete="one-time-code"
              hint="It came separately from the link."
            />
            <ErrorNote message={error} />
            <Button type="submit" disabled={busy || pin.length < 4}>
              {busy ? 'Checking…' : 'Open the document'}
            </Button>
          </form>
        )}
      </section>
    </main>
  );
}
