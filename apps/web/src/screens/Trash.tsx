import { can, PURGE_NOTICE_HOURS, whenExactly, type DocumentView } from '@fdv/shared';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { storedRole } from '../session.js';
import { BottomNav, Button, ConfirmDialog, ErrorNote, TopBar, TrashIcon } from '../ui.js';

/**
 * What its filer — and anybody else looking at the Trash — is told of an
 * owner's request to remove a document for good (5.24). Whoever filed it is
 * told how to keep it.
 */
export function purgeAskedWords(d: Pick<DocumentView, 'purge_requested_at' | 'filed_by_me'>) {
  if (!d.purge_requested_at) return null;
  const asked = `An owner asked to remove this for good on ${whenExactly(d.purge_requested_at)}.`;
  return d.filed_by_me ? `${asked} Bring it back to keep it.` : asked;
}

/** What an owner may do about removing one for good, now. */
type Removal = { kind: 'remove' } | { kind: 'ask' } | { kind: 'wait'; from: string };

/**
 * The Trash (5.1): what was moved there, most recent first, and the way
 * back. A document in the Trash is out of every list, search and reminder;
 * nothing in it is gone — until an owner removes it for good (5.24): one
 * they filed, or that is theirs, at once; anybody else's once whoever filed
 * it has been told, and has had a day to bring it back.
 */
export function TrashScreen() {
  const { withToken, guarded, authVersion, session } = useApp();
  const first = useLoad(
    (t) => api.documents(t, { deleted: 'true', sort: 'recent' }),
    [authVersion],
  );
  const [older, setOlder] = useState<DocumentView[]>([]);
  // Undefined until "Show older" is used; then the next page, or null at the end.
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [news, setNews] = useState<{ id?: string; title: string; text: string } | null>(null);
  // The one being removed for good, or asked about, in the app's own dialog.
  const [confirming, setConfirming] = useState<{ doc: DocumentView; removal: Removal } | null>(
    null,
  );
  const status = useRef<HTMLParagraphElement>(null);
  // What a "from {time}" is read against: now as the page opened, moved on
  // each minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const role = storedRole();
  const me = session.info?.member_id;
  // As the vault decides: whoever may change documents, a teen only their own.
  const mayRestore = (d: DocumentView) =>
    can(role, 'document.edit') && (role !== 'teen' || d.owner_member_id === me);
  // Owners only (5.24). One they filed, or that is theirs, goes at once;
  // anybody else's is asked about, and goes a day after.
  const removalOf = (d: DocumentView): Removal | null => {
    if (!can(role, 'document.purge')) return null;
    if (d.filed_by_me === true || (me && d.owner_member_id === me)) return { kind: 'remove' };
    if (!d.purge_allowed_from) return { kind: 'ask' };
    return Date.parse(d.purge_allowed_from) <= now
      ? { kind: 'remove' }
      : { kind: 'wait', from: d.purge_allowed_from };
  };
  const items = [...(first.data?.items ?? []), ...older];
  const next =
    cursor === undefined ? (first.data?.has_more ? first.data.next_cursor : null) : cursor;

  const more = async (from: string) => {
    setLoadingMore(true);
    try {
      const page = await withToken((t) =>
        api.documents(t, { deleted: 'true', sort: 'recent', cursor: from }),
      );
      if (page) {
        setOlder((o) => [...o, ...page.items]);
        setCursor(page.has_more ? page.next_cursor : null);
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoadingMore(false);
    }
  };

  /** What is in the Trash has changed: from the first page again, and the news has focus. */
  const changed = async (said: { id?: string; title: string; text: string }) => {
    setNews(said);
    setOlder([]);
    setCursor(undefined);
    await first.reload();
    // The button that had focus may be gone with its row: the news takes it.
    status.current?.focus();
  };

  const restore = async (doc: DocumentView) => {
    setBusy(doc.id);
    setError(null);
    try {
      await withToken((t) => api.restoreDocument(t, doc.id));
      await changed({ id: doc.id, title: doc.title ?? 'Needs a name', text: 'is back.' });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  const purge = async () => {
    if (!confirming) return;
    const { doc } = confirming;
    const title = doc.title ?? 'Needs a name';
    setBusy(doc.id);
    setError(null);
    try {
      // It asks to confirm it's you, every time: the prompt opens over the
      // dialog, and the removal goes on once it is answered.
      const out = await guarded((t) => api.purgeDocument(t, doc.id));
      setConfirming(null);
      if (!out) return;
      if (out.removed) {
        await changed({ title, text: 'was removed for good.' });
      } else {
        const from = out.document.purge_allowed_from;
        await changed({
          id: doc.id,
          title,
          text: from
            ? `Whoever added it has been told. You can remove it for good from ${whenExactly(from)}.`
            : 'Whoever added it has been told.',
        });
      }
    } catch (err) {
      setConfirming(null);
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="page page-top has-nav">
      <TopBar title="Trash" back="/settings" />
      <ErrorNote message={error ?? first.error} />
      <p className="muted">
        Documents moved to the Trash. They are out of every list, search and reminder until somebody
        brings them back
        {can(role, 'document.purge') ? ', or an owner removes them for good.' : '.'}
      </p>
      <p role="status" ref={status} tabIndex={-1} className="status-line">
        {news &&
          (news.id && news.text === 'is back.' ? (
            <>
              <Link to={`/documents/${news.id}`}>“{news.title}”</Link> {news.text}
            </>
          ) : (
            <>
              “{news.title}” {news.text}
            </>
          ))}
      </p>
      <ul className="list">
        {items.map((d) => {
          const removal = removalOf(d);
          const asked = purgeAskedWords(d);
          const title = d.title ?? 'this document';
          return (
            <li key={d.id} className="trash-row">
              <span className="stack" style={{ gap: 2 }}>
                <span className="doc-title">{d.title ?? 'Needs a name'}</span>
                {d.deleted_at && (
                  <span className="muted">Moved to the Trash {whenExactly(d.deleted_at)}</span>
                )}
                {asked && <span className="trash-asked">{asked}</span>}
              </span>
              <span className="trash-actions">
                {mayRestore(d) && (
                  <Button
                    kind="quiet"
                    disabled={busy === d.id}
                    ariaLabel={`Bring it back: ${title}`}
                    onClick={() => void restore(d)}
                  >
                    {busy === d.id && !confirming ? 'Bringing it back…' : 'Bring it back'}
                  </Button>
                )}
                {removal?.kind === 'wait' && (
                  <Button
                    kind="quiet"
                    disabled
                    ariaLabel={`Remove for good from ${whenExactly(removal.from)}: ${title}`}
                  >
                    Remove for good from {whenExactly(removal.from)}
                  </Button>
                )}
                {removal && removal.kind !== 'wait' && (
                  <Button
                    kind="quiet"
                    danger
                    disabled={busy === d.id}
                    ariaLabel={`${removal.kind === 'ask' ? 'Ask to remove for good' : 'Remove for good'}: ${title}`}
                    onClick={() => setConfirming({ doc: d, removal })}
                  >
                    {removal.kind === 'ask' ? 'Ask to remove for good' : 'Remove for good'}
                  </Button>
                )}
              </span>
            </li>
          );
        })}
        {first.data !== null && !first.error && items.length === 0 && (
          <li className="muted">The Trash is empty.</li>
        )}
      </ul>
      {next && (
        <Button kind="quiet" disabled={loadingMore} onClick={() => void more(next)}>
          {loadingMore ? 'Loading…' : 'Show older'}
        </Button>
      )}
      {confirming && (
        <PurgeDialog
          doc={confirming.doc}
          ask={confirming.removal.kind === 'ask'}
          busy={busy === confirming.doc.id}
          onConfirm={() => void purge()}
          onCancel={() => setConfirming(null)}
        />
      )}
      <BottomNav />
    </main>
  );
}

/**
 * The app's own "are you sure?" (5.1) for removing a document for good, or
 * for asking to (5.24): what goes, that it cannot be brought back, and —
 * for somebody else's — who is told and how long they have.
 */
function PurgeDialog(props: {
  doc: DocumentView;
  ask: boolean;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const title = props.doc.title ?? 'This document';
  return props.ask ? (
    <ConfirmDialog
      title="Ask to remove for good?"
      confirmLabel="Ask to remove for good"
      busyLabel="Asking…"
      icon={<TrashIcon />}
      danger
      busy={props.busy}
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
    >
      <p>
        Somebody else added “{title}”. They are told now, and so are the other owners, and they can
        bring it back to keep it.
      </p>
      <p>
        If nobody does, you can remove it for good {PURGE_NOTICE_HOURS} hours from now. You will be
        asked to confirm it’s you.
      </p>
    </ConfirmDialog>
  ) : (
    <ConfirmDialog
      title="Remove for good?"
      confirmLabel="Remove for good"
      busyLabel="Removing…"
      icon={<TrashIcon />}
      danger
      busy={props.busy}
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
    >
      <p>
        “{title}” and its file are removed from the vault: every copy, its pages, and any link to
        it. Nobody can bring it back.
      </p>
      <p>
        A backup made before now can bring back its details, never its file. You will be asked to
        confirm it’s you.
      </p>
    </ConfirmDialog>
  );
}
