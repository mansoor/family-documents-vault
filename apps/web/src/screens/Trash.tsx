import { can, whenExactly, type DocumentView } from '@fdv/shared';
import { useState } from 'react';
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
  const { withToken, authVersion } = useApp();
  const {
    data,
    error: loadError,
    loading,
    reload,
  } = useLoad((t) => api.documents(t, { deleted: 'true', sort: 'recent' }), [authVersion]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [restored, setRestored] = useState<DocumentView | null>(null);
  const mayRestore = can(storedRole(), 'document.edit');
  const items = data?.items ?? [];

  const restore = async (doc: DocumentView) => {
    setBusy(doc.id);
    setError(null);
    try {
      await withToken((t) => api.restoreDocument(t, doc.id));
      setRestored(doc);
      await reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="page page-top has-nav">
      <TopBar title="Trash" back="/settings" />
      <ErrorNote message={error ?? loadError} />
      <p className="muted">
        Documents moved to the Trash. They are out of every list, search and reminder until somebody
        brings them back.
      </p>
      {restored && (
        <p role="status">
          <Link to={`/documents/${restored.id}`}>“{restored.title ?? 'Needs a name'}”</Link> is
          back.
        </p>
      )}
      <ul className="list">
        {items.map((d) => (
          <li key={d.id}>
            <span className="stack" style={{ gap: 2 }}>
              <span className="doc-title">{d.title ?? 'Needs a name'}</span>
              {d.deleted_at && (
                <span className="muted">Moved to the Trash {whenExactly(d.deleted_at)}</span>
              )}
            </span>
            {mayRestore && (
              <Button
                kind="quiet"
                disabled={busy === d.id}
                ariaLabel={`Bring back ${d.title ?? 'this document'}`}
                onClick={() => void restore(d)}
              >
                {busy === d.id ? 'Bringing it back…' : 'Bring it back'}
              </Button>
            )}
          </li>
        ))}
        {!loading && items.length === 0 && <li className="muted">The Trash is empty.</li>}
      </ul>
      <BottomNav />
    </main>
  );
}
