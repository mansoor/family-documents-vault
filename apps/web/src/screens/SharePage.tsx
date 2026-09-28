import { pagesNotSharedNote } from '@fdv/shared';
import { useCallback, useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import {
  api,
  ApiRequestError,
  type SharedItem,
  type SharedSession,
  type ShareLinkPreview,
} from '../api.js';
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
 * once, before the page is drawn (takeLinkToken in link-token.ts, from
 * main.tsx), and taken out of the address bar and this tab's history at
 * once. The browser's own
 * history — the list of pages visited, which it may sync to other devices —
 * has already recorded the link as it arrived, and no page can take it out
 * of that; the PIN is what keeps a link found there shut. The PIN goes in
 * Open's body. What Open gives is a cookie for the share routes alone;
 * reloaded, the page finds what is open through it, and the token is not
 * needed again.
 *
 * Each phase replaces the last, so its heading takes the focus as it
 * arrives, and a screen reader says where it now is.
 */

type Phase =
  | { kind: 'loading' }
  | { kind: 'preview'; preview: ShareLinkPreview }
  | { kind: 'open'; session: SharedSession }
  | { kind: 'dead'; message: string };

const NO_LINK =
  'This page opens a link somebody sent you. Open the link from their message again — the whole of it.';

/**
 * Whether this page may open a link at all. Open's cookie is Secure, and a
 * browser keeps it only on a secure page — https, or this computer itself
 * (http://localhost counts). Anywhere else Open would count an open and
 * tell the sender, and then every download would be refused.
 */
const secure = () => window.isSecureContext !== false;

export function SharePage({ token }: { token: string | null }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  // What was there is gone, and the focus with it: the new heading takes it.
  useEffect(() => {
    if (phase.kind !== 'loading') heading.current?.focus();
  }, [phase.kind]);

  // While a page is open: what it asks again brings a newer answer, or
  // tells it the session or the link is over.
  const onSession = useCallback(
    (session: SharedSession) => setPhase({ kind: 'open', session }),
    [],
  );
  const onOver = useCallback((message: string) => setPhase({ kind: 'dead', message }), []);

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
    if (!token || !secure()) return;
    setBusy(true);
    setError(null);
    try {
      const session = await api.unlockLink(token, pin.trim() || undefined);
      setPhase({ kind: 'open', session });
      setPin('');
    } catch (err) {
      if (
        err instanceof ApiRequestError &&
        (err.code === 'link_not_valid' || err.code === 'link_used_up')
      ) {
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
      {phase.kind === 'loading' && (
        <p className="status status-warn" role="status">
          Opening the link…
        </p>
      )}

      {phase.kind === 'dead' && (
        <section className="card stack" aria-labelledby="share-h">
          <h1 id="share-h" style={{ fontSize: 22 }} tabIndex={-1} ref={heading}>
            This link cannot be opened
          </h1>
          <p className="muted" role="alert">
            {phase.message}
          </p>
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
          heading={heading}
        />
      )}

      {phase.kind === 'open' && (
        <Opened session={phase.session} heading={heading} onSession={onSession} onOver={onOver} />
      )}
    </main>
  );
}

function Preview({
  heading,
  ...props
}: {
  preview: ShareLinkPreview;
  pin: string;
  setPin: (v: string) => void;
  busy: boolean;
  error: string | null;
  onOpen: (e: FormEvent) => void;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const { preview } = props;
  const needsPin = preview.protection.includes('pin');
  const from = preview.shared_by ? <strong>{preview.shared_by}</strong> : 'Somebody';
  const canOpen = secure();
  return (
    <>
      <h1 id="share-h" style={{ fontSize: 26 }} tabIndex={-1} ref={heading}>
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
        {(preview.permission === 'view' || preview.opens_left != null) && (
          <ul className="share-terms">
            {preview.permission === 'view' && (
              <li>You can look at its pages here. It is not shared to download.</li>
            )}
            {preview.opens_left != null && (
              <li>
                It can be opened {moreTimes(preview.opens_left)}. Each press of Open counts;
                reloading the page it opens does not.
              </li>
            )}
          </ul>
        )}
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
        {!canOpen && (
          <p className="status status-warn" role="note">
            This page is not on a secure connection, so this browser could not download the
            document. Open is turned off: nothing has been opened, and the sender has not been told
            it was. Ask whoever sent the link for one that starts with https://.
          </p>
        )}
        <ErrorNote message={props.error} />
        <Button
          type="submit"
          disabled={!canOpen || props.busy || (needsPin && props.pin.trim().length < 4)}
        >
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

/** How often to ask again while a view-only link's pages are being drawn, and for how long. */
const DRAWING_POLL_MS = 4000;
const DRAWING_PATIENCE_MS = 3 * 60_000;

/**
 * What a session's answers mean the page is over, not only waiting: its
 * session ended, the link taken back or gone, or opened as often as it
 * allows. The page then says so, as Open does, in the vault's words.
 */
const OVER = new Set(['share_session_ended', 'link_not_valid', 'link_used_up']);

function Opened({
  session,
  heading,
  onSession,
  onOver,
}: {
  session: SharedSession;
  heading: RefObject<HTMLHeadingElement | null>;
  onSession: (session: SharedSession) => void;
  /** The session or its link is over: the page says so, with this. */
  onOver: (message: string) => void;
}) {
  const from = session.shared_by ? <strong>{session.shared_by}</strong> : 'Somebody';
  const single = session.items.length === 1 ? session.items[0] : undefined;
  const viewOnly = session.permission === 'view';
  const drawing = session.items.some((i) => i.pages?.state === 'drawing');
  const [asked, setAsked] = useState(0);
  const [since, setSince] = useState(() => Date.now());
  const [gaveUp, setGaveUp] = useState(false);
  const [wait, setWait] = useState(DRAWING_POLL_MS);

  // Pages still being drawn: asked again, inside the session (which counts
  // nothing, and asks the worker for them again each time), until they are
  // there — for a few minutes. After that the page says they could not be
  // prepared, rather than "in a minute" for ever, and offers to try again.
  // A session or link that is over says so at once; anything else (the
  // vault out of reach for a moment) is asked again while there is time.
  useEffect(() => {
    if (!drawing || gaveUp) return;
    const timer = window.setTimeout(() => {
      if (Date.now() - since > DRAWING_PATIENCE_MS) {
        setGaveUp(true);
        return;
      }
      void api.linkItems().then(
        (next) => {
          setWait(DRAWING_POLL_MS);
          setAsked((n) => n + 1);
          onSession(next);
        },
        (err: unknown) => {
          if (err instanceof ApiRequestError && OVER.has(err.code)) {
            onOver(err.message);
            return;
          }
          setWait(DRAWING_POLL_MS);
          setAsked((n) => n + 1);
        },
      );
    }, wait);
    return () => window.clearTimeout(timer);
  }, [drawing, asked, gaveUp, since, wait, onSession, onOver]);
  // Try again: waited for afresh, and asked at once.
  const tryAgain = () => {
    setSince(Date.now());
    setGaveUp(false);
    setWait(0);
    setAsked((n) => n + 1);
  };
  const downloadedAll =
    session.downloads_left === 0 && session.items.some((i) => i.downloaded === true);

  return (
    <>
      <h1 id="share-h" style={{ fontSize: 26 }} tabIndex={-1} ref={heading}>
        {single?.title ?? 'Shared documents'}
      </h1>
      <section className="card stack" aria-labelledby="share-h">
        <p>
          {from} shared {single ? 'this' : 'these'} with you from {session.household_name}
          {viewOnly ? ', to look at here.' : '.'}
        </p>
        {viewOnly && (
          <p className="status status-warn" role="note">
            This page cannot stop screenshots or photos of the screen. Every page shows who it was
            shared with and when.
          </p>
        )}
        {!viewOnly && session.downloads_left != null && (
          <p className="muted">
            {session.downloads_left > 0
              ? `It can be downloaded ${moreTimes(session.downloads_left)}. Downloading it again from this page does not count.`
              : downloadedAll
                ? 'This link has been downloaded from as many times as it allows. What this page has downloaded already, it can download again.'
                : 'This link has been downloaded from as many times as it allows. Ask whoever sent it for a new one.'}
          </p>
        )}
        <ul className="list" aria-label="What was shared">
          {session.items.map((item) => (
            <li key={item.id} className="place">
              {!single && <strong>{item.title ?? 'A document'}</strong>}
              {item.type_label && <span className="muted">{item.type_label}</span>}
              {viewOnly ? (
                <SharedPages item={item} gaveUp={gaveUp} onTryAgain={tryAgain} />
              ) : session.downloads_left === 0 && !item.downloaded ? null : (
                <>
                  <a
                    className="btn btn-primary"
                    href={api.linkItemContentUrl(item.id)}
                    download={item.filename}
                  >
                    Download {item.filename}
                  </a>
                  <span className="muted">{sizeOf(item.byte_size)}</span>
                </>
              )}
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

/**
 * A view-only link's pages of one document (5.18): the ones the vault drew
 * for this link, with whom it is for across each, one under another. Each
 * is fetched inside the session, which counts nothing; the first is
 * written down once as looked at.
 */
function SharedPages({
  item,
  gaveUp,
  onTryAgain,
}: {
  item: SharedItem;
  /** Waited long enough for pages still being drawn. */
  gaveUp: boolean;
  onTryAgain: () => void;
}) {
  const pages = item.pages;
  const [broken, setBroken] = useState<number[]>([]);
  // One line says how the wait is going, and stays while it does: its words
  // change, and a screen reader hears them; Try again gives it the focus,
  // since the button it pressed goes (the second review).
  const status = useRef<HTMLParagraphElement>(null);
  // And when the pages come after Try again, that line goes with the wait:
  // the pages take the focus, so it is not left on nothing (the third
  // review) — unless it has been moved on meanwhile.
  const list = useRef<HTMLOListElement>(null);
  const triedAgain = useRef(false);
  const ready = pages?.state === 'ready' && Boolean(pages.shown);
  useEffect(() => {
    if (!ready || !triedAgain.current) return;
    triedAgain.current = false;
    const where = document.activeElement;
    if (where === null || where === document.body) list.current?.focus();
  }, [ready]);
  if (!pages || pages.state === 'failed') {
    return (
      <p className="muted" role="note">
        The vault could not draw this document&rsquo;s pages. Ask whoever sent the link to send it
        another way.
      </p>
    );
  }
  if (pages.state === 'drawing' || !pages.shown) {
    return (
      <div className="stack" style={{ gap: 8 }}>
        <p
          className={`status ${gaveUp ? 'status-danger' : 'status-warn'}`}
          role="status"
          tabIndex={-1}
          ref={status}
        >
          {gaveUp
            ? 'The pages could not be prepared. Ask whoever sent the link, or try again in a while.'
            : 'The pages are still being drawn. They will appear here in a minute.'}
        </p>
        {gaveUp && (
          <Button
            kind="quiet"
            onClick={() => {
              status.current?.focus();
              triedAgain.current = true;
              onTryAgain();
            }}
          >
            Try again
          </Button>
        )}
      </div>
    );
  }
  const title = item.title ?? 'the document';
  const cut = pagesNotSharedNote(pages);
  return (
    <>
      <ol className="shared-pages" aria-label={`The pages of ${title}`} tabIndex={-1} ref={list}>
        {Array.from({ length: pages.shown }, (_, i) => i + 1).map((n) => (
          <li key={n}>
            {broken.includes(n) ? (
              <p className="muted">Page {n} could not be shown. Reload the page to try again.</p>
            ) : (
              <img
                src={api.linkItemPageUrl(item.id, n)}
                alt={`Page ${n} of ${pages.total ?? pages.shown}`}
                loading={n > 2 ? 'lazy' : 'eager'}
                onError={() => setBroken((b) => [...b, n])}
              />
            )}
          </li>
        ))}
      </ol>
      {cut && <p className="muted">{cut}</p>}
    </>
  );
}

/** "once more", "twice more", "3 more times". */
function moreTimes(n: number): string {
  return n === 1 ? 'once more' : n === 2 ? 'twice more' : `${n} more times`;
}

function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
