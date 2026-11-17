import {
  APP_LINK_FULL_WORDS,
  APP_LINK_OVER_WORDS,
  APP_REFUSALS,
  type AppLinkSession,
} from '@fdv/shared';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { api, ApiRequestError } from '../api.js';
import { describeError } from '../app-context.js';
import { browserZone, dateTimeWords } from '../family-time.js';
import { useFixedTitle } from '../page-title.js';
import { Logo } from '../ui.js';

/**
 * The page a connected app's view link opens (0.9.0, APP3), on its own as a
 * share link's is: none of the family's app around it, no sign-in. The app
 * sent its user's browser to a single-use link; the vault gave this browser
 * a session of ten minutes and sent it here. It shows the pages the vault
 * drew of one document, never the file, with the app's name across the top.
 *
 * The link itself sends a browser here with `#used`, `#ended` or
 * `#elsewhere` when it cannot open, and a download link with `#full` when
 * the app has downloaded as much as it may today: the page says so.
 */

type Phase =
  | { kind: 'loading' }
  | { kind: 'dead'; message: string }
  | { kind: 'open'; session: AppLinkSession };

/** How often pages still being drawn are asked for again, and for how long. */
const DRAWING_POLL_MS = 3000;
const DRAWING_PATIENCE_MS = 3 * 60_000;
/** A failed ask is tried again after 6, 12, 24… seconds, at most this long. */
const BACKOFF_MAX_MS = 30_000;
/** Failures in a row before a page that never opened says why. */
const FIRST_TRIES = 3;

const OVER = new Set(['link_ended', 'link_other_address']);

/** What a hash the link sent the browser here with says. */
function hashWords(hash: string): string | null {
  if (hash === '#used' || hash === '#ended') return APP_LINK_OVER_WORDS;
  if (hash === '#elsewhere') return APP_REFUSALS.link_other_address;
  if (hash === '#full') return APP_LINK_FULL_WORDS;
  return null;
}

export function AppLinkPage({ hash }: { hash: string }) {
  useFixedTitle('A document');
  const [phase, setPhase] = useState<Phase>(() => {
    const said = hashWords(hash);
    return said ? { kind: 'dead', message: said } : { kind: 'loading' };
  });
  const [since] = useState(() => Date.now());
  const heading = useRef<HTMLHeadingElement>(null);

  // Never indexed, beside the X-Robots-Tag every answer here carries.
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow, noarchive';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);

  // The hash said what it had to: it leaves the address bar.
  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  // The session, asked again while its pages are being drawn. Any failure
  // but the session being over is asked again too, waiting longer each
  // time: one dropped request never stops the page. Before the page has
  // ever opened, a few failures in a row say what went wrong.
  const dead = phase.kind === 'dead';
  const [gaveUp, setGaveUp] = useState(false);
  const [ask, setAsk] = useState({ n: 0, after: 0 });
  const failures = useRef(0);
  const opened = useRef(false);
  useEffect(() => {
    if (dead || gaveUp) return;
    let live = true;
    const again = (after: number) => setAsk((a) => ({ n: a.n + 1, after }));
    const timer = window.setTimeout(() => {
      void api.appLinkSession().then(
        (session) => {
          if (!live) return;
          failures.current = 0;
          opened.current = true;
          setPhase({ kind: 'open', session });
          if (session.pages.state === 'drawing') again(DRAWING_POLL_MS);
        },
        (err: unknown) => {
          if (!live) return;
          if (err instanceof ApiRequestError && OVER.has(err.code)) {
            setPhase({ kind: 'dead', message: err.message });
            return;
          }
          failures.current += 1;
          if (!opened.current && failures.current >= FIRST_TRIES) {
            setPhase({ kind: 'dead', message: describeError(err) });
            return;
          }
          again(Math.min(DRAWING_POLL_MS * 2 ** failures.current, BACKOFF_MAX_MS));
        },
      );
    }, ask.after);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [ask, dead, gaveUp]);

  // Pages still being drawn are waited for a few minutes, on a timer of
  // their own: after that the page says they could not be prepared, rather
  // than "a moment" for ever.
  const drawing = phase.kind === 'open' && phase.session.pages.state === 'drawing';
  useEffect(() => {
    if (!drawing) return;
    const t = window.setTimeout(
      () => setGaveUp(true),
      Math.max(0, since + DRAWING_PATIENCE_MS - Date.now()),
    );
    return () => window.clearTimeout(t);
  }, [drawing, since]);

  // What was there is gone, and the focus with it: the new heading takes it.
  useEffect(() => {
    if (phase.kind !== 'loading') heading.current?.focus();
  }, [phase.kind]);

  return (
    <main className="page share-page">
      <Logo />
      {phase.kind === 'loading' && (
        <p className="status status-warn" role="status">
          Opening the document…
        </p>
      )}
      {phase.kind === 'dead' && (
        <section className="card stack" aria-labelledby="app-link-h">
          <h1 id="app-link-h" style={{ fontSize: 22 }} tabIndex={-1} ref={heading}>
            This document cannot be shown
          </h1>
          <p className="muted" role="alert">
            {phase.message}
          </p>
        </section>
      )}
      {phase.kind === 'open' && (
        <Opened session={phase.session} gaveUp={gaveUp} heading={heading} />
      )}
    </main>
  );
}

function Opened({
  session,
  gaveUp,
  heading,
}: {
  session: AppLinkSession;
  gaveUp: boolean;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const [broken, setBroken] = useState<number[]>([]);
  const title = session.title ?? 'A document';
  return (
    <>
      <p className="status" role="note">
        Opened through <strong>{session.app}</strong>
      </p>
      <h1 id="app-link-h" style={{ fontSize: 26 }} tabIndex={-1} ref={heading}>
        {title}
      </h1>
      <section className="card stack" aria-labelledby="app-link-h">
        {session.pages.state === 'ready' && session.pages.count > 0 ? (
          <ol className="shared-pages" aria-label={`The pages of ${title}`}>
            {Array.from({ length: session.pages.count }, (_, i) => i + 1).map((n) => (
              <li key={n}>
                {broken.includes(n) ? (
                  <p className="muted">
                    Page {n} could not be shown. Reload the page to try again.
                  </p>
                ) : (
                  <img
                    src={api.appLinkPageUrl(n)}
                    alt={`Page ${n} of ${session.pages.count}`}
                    loading={n > 2 ? 'lazy' : 'eager'}
                    onError={() => setBroken((b) => [...b, n])}
                  />
                )}
              </li>
            ))}
          </ol>
        ) : session.pages.state === 'drawing' ? (
          <p className={`status ${gaveUp ? 'status-danger' : 'status-warn'}`} role="status">
            {gaveUp
              ? `The pages could not be prepared. Open the document again from ${session.app} in a while.`
              : 'Preparing the pages… They will appear here in a moment.'}
          </p>
        ) : (
          <p className="muted" role="note">
            The vault cannot show this document&rsquo;s pages here.
          </p>
        )}
        <p className="muted">
          This page stays open until{' '}
          {dateTimeWords(session.ends_at, browserZone(), { always: true })}. After that, open the
          document again from {session.app}.
        </p>
      </section>
    </>
  );
}
