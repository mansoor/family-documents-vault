import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiRequestError, type SharedSession, type ShareLinkPreview } from '../api.js';
import { describeError } from '../app-context.js';
import { Button, ErrorNote, Field, Logo } from '../ui.js';

/**
 * The page a link opens (5.16): `/s#<token>`.
 *
 * Whoever lands here has no account and is not going to make one. The page
 * says whose vault this is, who sent what and what it asks for, and opens
 * nothing until they press Open — an email client's link scanner that
 * fetches the page is not somebody opening the document, and the family's
 * log should not say it was.
 *
 * The secret is in the fragment, which no server is ever sent. It is read
 * once, before the page is drawn (takeLinkToken, from main.tsx), and taken
 * out of the address bar and this entry of the history at once. The PIN
 * goes in Open's body. What Open gives is a cookie for the share routes
 * alone; reloaded, the page finds what is open through it, and the token
 * is not needed again.
 */

/**
 * The token from the address's fragment, and the fragment gone from the
 * address bar and from this entry of the history — also from a history
 * synced to other devices. Null when there is none.
 */
export function takeLinkToken(): string | null {
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return null;
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${window.location.search}`,
  );
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'preview'; preview: ShareLinkPreview }
  | { kind: 'open'; session: SharedSession }
  | { kind: 'dead'; message: string };

const NO_LINK =
  'This page opens a link somebody sent you. Open the link from their message again — the whole of it.';

export function SharePage({ token }: { token: string | null }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        if (token) {
          const preview = await api.previewLink(token);
          if (live) setPhase({ kind: 'preview', preview });
          return;
        }
        // No token: the page was reloaded after Open, or opened without its
        // link. What this browser has open, if anything, is still open.
        const session = await api.linkItems();
        if (live) setPhase({ kind: 'open', session });
      } catch (err) {
        if (!live) return;
        const ended = err instanceof ApiRequestError && err.code === 'share_session_ended';
        setPhase({ kind: 'dead', message: !token && ended ? NO_LINK : describeError(err) });
      }
    })();
    return () => {
      live = false;
    };
  }, [token]);

  const open = async (e: FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const session = await api.unlockLink(token, pin.trim() || undefined);
      setPhase({ kind: 'open', session });
      setPin('');
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'link_not_valid') {
        setPhase({ kind: 'dead', message: err.message });
      } else {
        setError(describeError(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page share-page">
      <Logo />
      {phase.kind === 'loading' && <span className="status status-warn">Opening the link…</span>}

      {phase.kind === 'dead' && (
        <section className="card stack" aria-labelledby="share-h">
          <h1 id="share-h" style={{ fontSize: 22 }}>
            This link cannot be opened
          </h1>
          <p className="muted">{phase.message}</p>
        </section>
      )}

      {phase.kind === 'preview' && (
        <Preview
          preview={phase.preview}
          pin={pin}
          setPin={setPin}
          busy={busy}
          error={error}
          onOpen={(e) => void open(e)}
        />
      )}

      {phase.kind === 'open' && <Opened session={phase.session} />}
    </main>
  );
}

function Preview(props: {
  preview: ShareLinkPreview;
  pin: string;
  setPin: (v: string) => void;
  busy: boolean;
  error: string | null;
  onOpen: (e: FormEvent) => void;
}) {
  const { preview } = props;
  const needsPin = preview.protection.includes('pin');
  const from = preview.shared_by ? <strong>{preview.shared_by}</strong> : 'Somebody';
  return (
    <>
      <h1 id="share-h" style={{ fontSize: 26 }}>
        {preview.document_title ?? 'A shared document'}
      </h1>
      <form
        className="card stack"
        aria-labelledby="share-h"
        onSubmit={props.onOpen}
        data-testid="share-preview"
      >
        <p>
          {from} shared {preview.document_title ? 'this' : 'a document'} with you from{' '}
          {preview.household_name}
          {needsPin ? ', and put a PIN on it.' : '.'}
        </p>
        {needsPin && (
          <Field
            id="share-pin"
            label="The four-digit PIN they gave you"
            value={props.pin}
            onChange={props.setPin}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={12}
            hint="It came separately from the link. Its name stays hidden until the PIN is right."
          />
        )}
        {window.isSecureContext === false && (
          <p className="status status-warn" role="note">
            This page is not on a secure connection, so your browser may not keep what Open gives
            it. If the document does not appear, ask whoever sent the link for its https:// address.
          </p>
        )}
        <ErrorNote message={props.error} />
        <Button type="submit" disabled={props.busy || (needsPin && props.pin.trim().length < 4)}>
          {props.busy ? 'Opening…' : 'Open'}
        </Button>
        <p className="muted">
          Nothing is opened until you press Open. The link works until{' '}
          {new Date(preview.expires_at).toLocaleString([], {
            dateStyle: 'long',
            timeStyle: 'short',
          })}
          , and whoever sent it can take it back sooner. They will see that it was opened.
        </p>
      </form>
    </>
  );
}

function Opened({ session }: { session: SharedSession }) {
  const from = session.shared_by ? <strong>{session.shared_by}</strong> : 'Somebody';
  const single = session.items.length === 1 ? session.items[0] : undefined;
  return (
    <>
      <h1 id="share-h" style={{ fontSize: 26 }}>
        {single?.title ?? 'Shared documents'}
      </h1>
      <section className="card stack" aria-labelledby="share-h">
        <p>
          {from} shared {single ? 'this' : 'these'} with you from {session.household_name}.
        </p>
        <ul className="list" aria-label="What was shared">
          {session.items.map((item) => (
            <li key={item.id} className="place">
              {!single && <strong>{item.title ?? 'A document'}</strong>}
              {item.type_label && <span className="muted">{item.type_label}</span>}
              <a
                className="btn btn-primary"
                href={api.linkItemContentUrl(item.id)}
                download={item.filename}
              >
                Download {item.filename}
              </a>
              <span className="muted">{sizeOf(item.byte_size)}</span>
            </li>
          ))}
        </ul>
        <p className="muted">
          This page stays open for 30 minutes after you last use it, and until{' '}
          {new Date(session.session_expires_at).toLocaleString([], {
            dateStyle: 'long',
            timeStyle: 'short',
          })}{' '}
          at the latest. After that, open the link again.
        </p>
      </section>
    </>
  );
}

function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
