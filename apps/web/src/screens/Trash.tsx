import { can, whenExactly, type DocumentView } from '@fdv/shared';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { storedRole } from '../session.js';
import { BottomNav, Button, ErrorNote, TopBar } from '../ui.js';

/**
 * The Trash (5.1): what was moved there, most recent first, and the way
 * back. A document in the Trash is out of every list, search and reminder;
 * nothing in it is gone.
 */
export function TrashScreen() {
  const { withToken, authVersion, session } = useApp();
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
  const [back, setBack] = useState<{ id: string; title: string } | null>(null);
  const status = useRef<HTMLParagraphElement>(null);

  const role = storedRole();
  // As the vault decides: whoever may change documents, a teen only their own.
  const mayRestore = (d: DocumentView) =>
    can(role, 'document.edit') &&
    (role !== 'teen' || d.owner_member_id === session.info?.member_id);
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

  const restore = async (doc: DocumentView) => {
    setBusy(doc.id);
    setError(null);
    try {
      await withToken((t) => api.restoreDocument(t, doc.id));
      setBack({ id: doc.id, title: doc.title ?? 'Needs a name' });
      // What is in the Trash has changed: from the first page again.
      setOlder([]);
      setCursor(undefined);
      await first.reload();
      // The button that had focus is gone with its row: the news takes it.
      status.current?.focus();
    } catch (err) {
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
        brings them back.
      </p>
      <p role="status" ref={status} tabIndex={-1} className="status-line">
        {back && (
          <>
            <Link to={`/documents/${back.id}`}>“{back.title}”</Link> is back.
          </>
        )}
      </p>
      <ul className="list">
        {items.map((d) => (
          <li key={d.id}>
            <span className="stack" style={{ gap: 2 }}>
              <span className="doc-title">{d.title ?? 'Needs a name'}</span>
              {d.deleted_at && (
                <span className="muted">Moved to the Trash {whenExactly(d.deleted_at)}</span>
              )}
            </span>
            {mayRestore(d) && (
              <Button
                kind="quiet"
                disabled={busy === d.id}
                ariaLabel={`Bring it back: ${d.title ?? 'this document'}`}
                onClick={() => void restore(d)}
              >
                {busy === d.id ? 'Bringing it back…' : 'Bring it back'}
              </Button>
            )}
          </li>
        ))}
        {first.data !== null && !first.error && items.length === 0 && (
          <li className="muted">The Trash is empty.</li>
        )}
      </ul>
      {next && (
        <Button kind="quiet" disabled={loadingMore} onClick={() => void more(next)}>
          {loadingMore ? 'Loading…' : 'Show older'}
        </Button>
      )}
      <BottomNav />
    </main>
  );
}
