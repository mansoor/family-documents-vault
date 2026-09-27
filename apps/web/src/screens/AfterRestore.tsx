import { useRef, useState } from 'react';
import { api, type Share } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { BottomNav, Button, ErrorNote, TopBar } from '../ui.js';

/**
 * Settings → After a restore (5.16).
 *
 * A backup is the vault as it was when it was made: a link taken back since
 * is live again in it. So a restore pauses every link, and each waits here
 * for somebody who may to say it still stands (A55) — an owner for any link
 * to a document they can see, a sharer for their own. 5.21 adds upload
 * requests here, and 5.28 the people whose sign-ins wait too.
 */
export function AfterRestoreScreen() {
  const { guarded, withToken, authVersion } = useApp();
  const {
    data,
    error: loadError,
    reload,
  } = useLoad(async (t) => (await api.afterRestore(t)).links, [authVersion]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const status = useRef<HTMLParagraphElement>(null);

  const act = async (link: Share, how: 'resume' | 'revoke') => {
    setBusy(link.id);
    setError(null);
    try {
      const done =
        how === 'resume'
          ? await guarded((t) => api.resumeShare(t, link.id))
          : await withToken((t) => api.revokeShare(t, link.id));
      if (done === null) return;
      const what = `The link to “${link.document_title ?? 'a document'}”`;
      setSaid(how === 'resume' ? `${what} works again.` : `${what} is taken back for good.`);
      await reload();
      status.current?.focus();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  const links = data ?? [];
  return (
    <main className="page page-top has-nav">
      <TopBar title="After a restore" back="/settings" />
      <p className="lede">
        The vault was put back from a backup. A link taken back after that backup was made would
        work again, so every link was paused. Turn back on the ones that should still work.
      </p>
      <ErrorNote message={loadError ?? error} />
      <p className="notice" role="status" tabIndex={-1} ref={status} hidden={!said}>
        {said}
      </p>
      <section aria-labelledby="paused-links-h" className="stack">
        <h2 id="paused-links-h" className="section-h">
          Links waiting for you
        </h2>
        {data && links.length === 0 ? (
          <p className="muted">Nothing is waiting. Every link you may decide about is decided.</p>
        ) : (
          <ul className="list">
            {links.map((link) => (
              <li key={link.id} className="place">
                <div className="place-title">{link.document_title ?? 'A document'}</div>
                <div className="muted">
                  {[
                    link.recipient_label ? `For ${link.recipient_label}` : 'Shared by link',
                    link.created_by_name ? `made by ${link.created_by_name}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
                <div className="muted">
                  {link.has_pin ? 'Has a PIN. ' : ''}
                  Would work until{' '}
                  {new Date(link.expires_at).toLocaleDateString([], { dateStyle: 'long' })}.
                </div>
                <div className="row">
                  <Button disabled={busy !== null} onClick={() => void act(link, 'resume')}>
                    {busy === link.id ? 'Working…' : 'Turn back on'}
                  </Button>
                  <Button
                    kind="quiet"
                    disabled={busy !== null}
                    onClick={() => void act(link, 'revoke')}
                  >
                    Take it back
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <BottomNav />
    </main>
  );
}
