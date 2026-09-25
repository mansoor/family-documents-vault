import { formatDate, issuedByLabel, type VersionView } from '@fdv/shared';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { BottomNav, Button, categoryLabel, ErrorNote, StatusBadge, TopBar } from '../ui.js';
import { SharePanel } from './Share.js';
import { VisibilityControl } from './Visibility.js';
import { createUploadKeys, whileInProgress } from '../upload-keys.js';

/**
 * Document detail: a preview, the facts in a plain two-column list, the
 * history of versions, and one primary action — Download. Tapping the
 * preview opens the pages full size, to read (0.4.12).
 */
export function DocumentScreen() {
  const { id } = useParams<{ id: string }>();
  const { withToken, guarded, authVersion, session } = useApp();
  const navigate = useNavigate();
  const { data, error, reload } = useLoad(
    async (t) => {
      const [doc, versions, members, types] = await Promise.all([
        api.document(t, id as string),
        api.versions(t, id as string),
        api.members(t),
        api.documentTypes(t),
      ]);
      return { doc, versions: versions.items, members: members.items, types: types.items };
    },
    [id, authVersion],
  );
  const [thumb, setThumb] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [keys] = useState(createUploadKeys);

  const latest = data?.versions[0];
  useEffect(() => {
    let url: string | null = null;
    if (!latest) return;
    void withToken((t) => api.thumbnail(t, latest.id))
      .then((blob) => {
        if (blob) {
          url = URL.createObjectURL(blob);
          setThumb(url);
        }
      })
      .catch(() => setThumb(null));
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [latest, withToken]);

  const download = async (v: VersionView) => {
    setActionError(null);
    try {
      // An Essential or an "only me" document may ask who is asking first.
      const blob = await guarded((t) => api.content(t, v.id));
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = v.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      setActionError(describeError(err));
    }
  };

  const addVersion = async (file: File | undefined) => {
    if (!file || !data) return;
    setActionError(null);
    try {
      const key = keys.keyFor(file);
      await whileInProgress(() => withToken((t) => api.upload(t, data.doc.id, file, key)));
      keys.saved();
      await reload();
    } catch (err) {
      setActionError(describeError(err));
    }
  };

  const remove = async () => {
    if (!data) return;
    if (!window.confirm('Move this document to the bin? You can bring it back within 30 days.'))
      return;
    try {
      await withToken((t) => api.deleteDocument(t, data.doc.id));
      void navigate('/', { replace: true });
    } catch (err) {
      setActionError(describeError(err));
    }
  };

  if (error) {
    return (
      <main className="page page-top has-nav">
        <TopBar title="Document" back="/" />
        <ErrorNote message={error} />
        <BottomNav />
      </main>
    );
  }
  if (!data)
    return (
      <main className="page page-top has-nav">
        <TopBar title="Document" back="/" />
        <BottomNav />
      </main>
    );

  const { doc, versions, members, types } = data;
  const owner = members.find((m) => m.id === doc.owner_member_id);
  const type = types.find((t) => t.key === doc.type_key);
  const visibilityLabel =
    doc.visibility === 'household'
      ? 'Everyone in the family'
      : doc.visibility === 'adults'
        ? 'Adults only'
        : 'Only me';

  return (
    <main className="page page-top has-nav">
      <TopBar
        title={doc.title ?? 'Needs a name'}
        back="/"
        action={
          <Link
            to={`/documents/${doc.id}/confirm`}
            className="btn btn-quiet"
            style={{ minHeight: 40 }}
          >
            Edit
          </Link>
        }
      />
      {latest ? (
        <Link
          to={`/documents/${doc.id}/read`}
          className="preview preview-link"
          aria-label={`Read ${doc.title ?? 'the document'}, full size`}
        >
          {thumb ? (
            <img src={thumb} alt="" />
          ) : (
            <span className="muted">Preview is being made…</span>
          )}
          <span className="preview-hint">Tap to read it full size</span>
        </Link>
      ) : (
        <div className="preview" aria-label="Preview">
          <span className="muted">No file yet</span>
        </div>
      )}
      <div className="row" style={{ alignItems: 'center', gap: 12 }}>
        <StatusBadge status={doc.status} />
        <span className="muted">{visibilityLabel}</span>
      </div>
      <VisibilityControl
        documentId={doc.id}
        current={doc.visibility}
        isMine={doc.owner_member_id !== null && doc.owner_member_id === session.info?.member_id}
        onChanged={reload}
      />
      <ErrorNote message={actionError} />
      {latest && <Button onClick={() => void download(latest)}>Download</Button>}

      <dl className="facts">
        <dt>Type</dt>
        <dd>{type?.label ?? 'Not set'}</dd>
        <dt>Person</dt>
        <dd>{owner?.display_name ?? 'Not set'}</dd>
        {doc.issued_by && (
          <>
            {/* The type's own word for it: "Institution", "Insurer"… */}
            <dt>{issuedByLabel(type)}</dt>
            <dd>{doc.issued_by}</dd>
          </>
        )}
        {doc.identifier && (
          <>
            <dt>Number</dt>
            <dd>{doc.identifier}</dd>
          </>
        )}
        {doc.issued && (
          <>
            <dt>Issued</dt>
            <dd>{formatDate(doc.issued)}</dd>
          </>
        )}
        {doc.expires && (
          <>
            <dt>Expires</dt>
            <dd>{formatDate(doc.expires)}</dd>
          </>
        )}
        <dt>Category</dt>
        <dd>{categoryLabel(doc.category)}</dd>
        {doc.physical_location && (
          <>
            <dt>Original is kept</dt>
            <dd>{doc.physical_location}</dd>
          </>
        )}
        {doc.tags.length > 0 && (
          <>
            <dt>Tags</dt>
            <dd>{doc.tags.join(', ')}</dd>
          </>
        )}
      </dl>

      <section aria-labelledby="history-h">
        <h2 id="history-h" className="section-h">
          History
        </h2>
        <ul className="list">
          {versions.map((v, i) => (
            <li key={v.id}>
              <span>
                <strong>{i === 0 ? 'Current' : `Version ${v.version_no}`}</strong>
                <span className="muted">
                  {v.filename} · {(v.byte_size / 1024).toFixed(0)} KB · added{' '}
                  {new Date(v.uploaded_at).toLocaleDateString()}
                </span>
              </span>
              {i > 0 && (
                <Button kind="quiet" onClick={() => void download(v)}>
                  Download
                </Button>
              )}
            </li>
          ))}
        </ul>
        <label className="btn btn-quiet" style={{ display: 'inline-flex', alignItems: 'center' }}>
          Add a new version
          <input
            type="file"
            accept="image/*,application/pdf"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              // Cleared, so the same file chosen again is a retry, not nothing.
              e.target.value = '';
              void addVersion(file);
            }}
          />
        </label>
      </section>

      {doc.notes && (
        <section>
          <h2 className="section-h">Notes</h2>
          <p>{doc.notes}</p>
        </section>
      )}
      <SharePanel documentId={doc.id} documentTitle={doc.title} />
      <Button kind="link" onClick={() => void remove()}>
        Move to the bin
      </Button>
      <BottomNav />
    </main>
  );
}
