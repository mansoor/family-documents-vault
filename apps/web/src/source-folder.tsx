import { seesLocation, type DocumentView } from '@fdv/shared';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { api } from './api.js';
import { describeError, useApp } from './app-context.js';
import { FolderIcon } from './cabinet.js';
import { ConfirmDialog } from './ui.js';
import { storedRole } from './session.js';

/**
 * The folder a paper came from (0.9.0, C4; the owner's idea 6): kept on a
 * document filed from a folder — Add many with a folder, the scanner folder,
 * a computer — and said on its page to whoever sees where originals are kept
 * (owners, adults and teens), as a way to the other papers from that
 * folder. Whoever may change it can forget it, after saying so: it is never
 * written by hand.
 */

/** The table's address for the papers that came from this folder. */
export function sourceFolderHref(folder: string): string {
  return `/documents?${new URLSearchParams({ source_folder: folder }).toString()}`;
}

/** A document's "Came from the folder" row: none when it has none, or the reader may not see it. */
export function SourceFolderRow(props: {
  doc: DocumentView;
  mayChange: boolean;
  onSaved: (saved: DocumentView) => void;
}) {
  const { doc } = props;
  const { caps, withToken } = useApp();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const folder = doc.source_folder ?? null;
  if (caps?.features.source_folders !== true || !seesLocation(storedRole()) || !folder) return null;
  const may = props.mayChange && !doc.deleted_at && doc.caregiver !== true;

  const forget = async () => {
    setBusy(true);
    try {
      const saved = await withToken((t) => api.forgetSourceFolder(t, doc.id, doc.etag));
      setAsking(false);
      if (saved) props.onSaved(saved);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <dt>Came from the folder</dt>
      <dd className="where-kept">
        <span className="where-kept-place">
          <Link to={sourceFolderHref(folder)} title="Papers from this folder">
            <FolderIcon />
            <bdi>{folder}</bdi>
          </Link>
        </span>
        {may && (
          <>
            {' '}
            <button
              ref={button}
              type="button"
              className="btn btn-quiet btn-small"
              onClick={() => {
                setError(null);
                setAsking(true);
              }}
            >
              Forget it…
            </button>
          </>
        )}
        {asking && (
          <ConfirmDialog
            title="Forget the folder this came from?"
            confirmLabel="Forget it"
            busyLabel="Forgetting…"
            busy={busy}
            returnFocus={button}
            onConfirm={() => void forget()}
            onCancel={() => setAsking(false)}
          >
            “{folder}” is taken off this document for everyone, and cabinet folders that hold the
            papers from it no longer hold this one. The document itself stays as it is. This can’t
            be undone.
            {error && (
              <span role="alert" className="error-text">
                {' '}
                {error}
              </span>
            )}
          </ConfirmDialog>
        )}
      </dd>
    </>
  );
}
