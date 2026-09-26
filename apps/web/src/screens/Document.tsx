import {
  formatDate,
  issuedByLabel,
  whenExactly,
  type CoreField,
  type VersionView,
} from '@fdv/shared';
import { Fragment, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { mayChange } from '../DocActions.js';
import { asksFor, coreRule, detailText, useAttributes } from '../details.js';
import {
  BottomNav,
  Button,
  categoryLabel,
  ConfirmDialog,
  ErrorNote,
  MoveToTrashDialog,
  StatusBadge,
  TopBar,
  TrashIcon,
} from '../ui.js';
import { storedRole } from '../session.js';
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

  // Moving to the Trash asks first, in the app's own dialog (5.1).
  const [confirmingTrash, setConfirmingTrash] = useState(false);
  const [trashing, setTrashing] = useState(false);
  const trashButton = useRef<HTMLButtonElement>(null);
  const remove = async () => {
    if (!data) return;
    setTrashing(true);
    try {
      await withToken((t) => api.deleteDocument(t, data.doc.id));
      void navigate('/', { replace: true });
    } catch (err) {
      setConfirmingTrash(false);
      setActionError(describeError(err));
    } finally {
      setTrashing(false);
    }
  };

  // The type's own details, and those its type no longer asks for (A11):
  // kept under "Other details" until somebody removes them. An Only me
  // document's are here only because this is its owner's own request for
  // it (0.5.8); a list never carries them.
  const docType = data?.types.find((t) => t.key === data.doc.type_key);
  const typeFields = (docType?.fields ?? []).filter(asksFor);
  const others = Object.entries(data?.doc.extra ?? {}).filter(
    ([key, value]) => value !== null && !typeFields.some((f) => f.key === key),
  );
  const library = useAttributes(others.length > 0);
  const [removing, setRemoving] = useState<{ key: string; label: string; text: string } | null>(
    null,
  );
  const [removeBusy, setRemoveBusy] = useState(false);
  // Where focus lands once a detail has gone, with its button.
  const facts = useRef<HTMLDListElement>(null);
  const removeDetail = async () => {
    if (!data || !removing) return;
    setRemoveBusy(true);
    setActionError(null);
    try {
      // null takes a key away, whatever the type asks for now (0.5.7).
      await withToken((t) =>
        api.updateDocument(t, data.doc.id, { extra: { [removing.key]: null } }, data.doc.etag),
      );
      await reload();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setRemoveBusy(false);
      setRemoving(null);
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
  // Who may change it — move it to the Trash, remove a detail: the same
  // rule as its row's ⋯ (5.1, 5.4).
  const mayChangeIt = mayChange(storedRole(), session.info?.member_id, doc);
  const owner = members.find((m) => m.id === doc.owner_member_id);
  const type = types.find((t) => t.key === doc.type_key);
  // The fixed fields in the type's own words ('Passport number', 0.5.6).
  const word = (key: CoreField, fallback: string) => coreRule(type, key).label ?? fallback;
  const details = typeFields.flatMap((field) => {
    const value = doc.extra[field.key];
    return value === undefined || value === null || value === '' ? [] : [{ field, value }];
  });
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

      <dl className="facts" ref={facts} tabIndex={-1}>
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
            <dt>{word('identifier', 'Number')}</dt>
            <dd>{doc.identifier}</dd>
          </>
        )}
        {doc.issued && (
          <>
            <dt>{word('issued', 'Issued')}</dt>
            <dd>{formatDate(doc.issued)}</dd>
          </>
        )}
        {doc.expires && (
          <>
            <dt>{word('expires', 'Expires')}</dt>
            <dd>{formatDate(doc.expires)}</dd>
          </>
        )}
        {/* The type's own details, in its order (5.10). */}
        {details.map(({ field, value }) => (
          <Fragment key={field.key}>
            <dt>{field.label}</dt>
            <dd className={field.kind === 'long_text' ? 'keep-lines' : undefined}>
              {detailText(field.kind, value)}
            </dd>
          </Fragment>
        ))}
        <dt>Category</dt>
        <dd>{categoryLabel(doc.category)}</dd>
        {doc.physical_location && (
          <>
            <dt>{word('physical_location', 'Original is kept')}</dt>
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

      {others.length > 0 && (
        <section aria-labelledby="other-h">
          <h2 id="other-h" className="section-h">
            Other details
          </h2>
          <p className="muted">
            This kind of document no longer asks for these. They are kept until somebody removes
            them.
          </p>
          <ul className="list">
            {others.map(([key, value]) => {
              const known = library?.find((a) => a.key === key);
              const label = known?.label ?? key;
              const text = detailText(known?.kind, value);
              return (
                <li key={key}>
                  <span>
                    <strong>{label}</strong>
                    <span className="muted keep-lines">{text}</span>
                  </span>
                  {mayChangeIt && (
                    <Button
                      kind="quiet"
                      ariaLabel={`Remove ${label}`}
                      onClick={() => setRemoving({ key, label, text })}
                    >
                      Remove
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {removing && (
        <ConfirmDialog
          title="Remove this detail?"
          confirmLabel="Remove"
          busyLabel="Removing…"
          danger
          busy={removeBusy}
          returnFocus={facts}
          onConfirm={() => void removeDetail()}
          onCancel={() => setRemoving(null)}
        >
          <p>
            “{removing.label}: {removing.text}” is taken off this document for good.
          </p>
        </ConfirmDialog>
      )}

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
                  {whenExactly(v.uploaded_at)}
                  {v.uploaded_by_name ? ` by ${v.uploaded_by_name}` : ''}
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
        <section aria-labelledby="notes-h">
          <h2 id="notes-h" className="section-h">
            {word('notes', 'Notes')}
          </h2>
          {/* Plain text, as it was written: its line breaks kept (5.10). */}
          <p className="keep-lines">{doc.notes}</p>
        </section>
      )}
      {/* A link sends the file: with none yet, there is nothing to send (5.4). */}
      {doc.latest_version_id !== null && (
        <SharePanel documentId={doc.id} documentTitle={doc.title} />
      )}
      {mayChangeIt && (
        <button
          ref={trashButton}
          type="button"
          className="btn btn-link btn-trash"
          onClick={() => setConfirmingTrash(true)}
        >
          <TrashIcon />
          Move to Trash
        </button>
      )}
      {confirmingTrash && (
        <MoveToTrashDialog
          title={doc.title}
          busy={trashing}
          returnFocus={trashButton}
          onConfirm={() => void remove()}
          onCancel={() => setConfirmingTrash(false)}
        />
      )}
      <BottomNav />
    </main>
  );
}
