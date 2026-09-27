import { can } from '@fdv/shared';
import { useRef, useState } from 'react';
import { api, type Share } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { storedRole } from '../session.js';
import { BottomNav, Button, ErrorNote, TopBar } from '../ui.js';

/**
 * Settings → After a restore (5.16).
 *
 * A backup is the vault as it was when it was made: a link taken back since
 * is live again in it, and the line in the activity log that said who took
 * it back is gone. So a restore pauses every link, and each waits here for
 * an owner to say it still stands (A55), whoever made it. Anybody else who
 * may share sees the links they made, only to take back: not even a link
 * to their own Only me document, which no owner can see, is theirs to turn
 * back on, so the page says to take it back and make a new one. 5.21 adds
 * upload requests here, and 5.28 the people whose sign-ins wait too.
 */
export function AfterRestoreScreen() {
  const { guarded, withToken, authVersion } = useApp();
  const owner = can(storedRole(), 'restore.review');
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
        work again, so every link was paused.{' '}
        {owner
          ? 'Turn back on the ones that should still work.'
          : 'Only an owner can turn one back on.'}
      </p>
      {!owner && (
        <>
          <p className="muted">
            These are the links you made. An owner decides which of them work again, and you can
            take any of them back.
          </p>
          <p className="muted">
            No owner can see your Only me documents, so no one can turn a link to one of them back
            on. If it is still needed, take it back and make a new link.
          </p>
        </>
      )}
      <ErrorNote message={loadError ?? error} />
      <p className="notice" role="status" tabIndex={-1} ref={status} hidden={!said}>
        {said}
      </p>
      <section aria-labelledby="paused-links-h" className="stack">
        <h2 id="paused-links-h" className="section-h">
          {owner ? 'Links waiting for you' : 'Your paused links'}
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
                  {owner && (
                    <Button disabled={busy !== null} onClick={() => void act(link, 'resume')}>
                      {busy === link.id ? 'Working…' : 'Turn back on'}
                    </Button>
                  )}
                  <Button
                    kind="quiet"
                    disabled={busy !== null}
                    onClick={() => void act(link, 'revoke')}
                  >
                    {busy === link.id && !owner ? 'Working…' : 'Take it back'}
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
