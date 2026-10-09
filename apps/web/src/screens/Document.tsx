import {
  FILE_REMOVED,
  formatDate,
  issuedByLabel,
  PREVIEW_MAX_PAGES,
  seesLocation,
  whenExactly,
  type CoreField,
  type VersionView,
} from '@fdv/shared';
import { Fragment, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, ApiRequestError } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { AddToCollection, audienceLabel, collectionsOffered } from '../collections.js';
import { mayChange } from '../DocActions.js';
import { asksFor, coreRule, detailText, useAttributes } from '../details.js';
import { NotesSection } from '../notes.js';
import { PageViewer } from '../page-viewer.js';
import { useShellMode } from '../shell.js';
import {
  Button,
  categoryLabel,
  ConfirmDialog,
  ErrorNote,
  MoveToTrashDialog,
  Sheet,
  StatusBadge,
  TopBar,
  TrashIcon,
} from '../ui.js';
import { storedRole } from '../session.js';
import { PagesSuggest, useSuggestionsOffered } from '../suggestions.js';
import { SharePanel } from './Share.js';
import { VisibilityControl } from './Visibility.js';
import { createUploadKeys, whileInProgress } from '../upload-keys.js';

/**
 * Document detail: the facts in a plain two-column list, its notes, the
 * history of versions, and one primary action — Download. From 768 px the
 * details are on the left and the pages on the right, turned in the shared
 * viewer (R3, the owner's rule); on a phone, one column — the details
 * first, with a preview right after the facts that opens the pages full
 * size, to read (0.4.12).
 */
export function DocumentScreen() {
  const { id } = useParams<{ id: string }>();
  const { withToken, guarded, authVersion, session, caps } = useApp();
  const navigate = useNavigate();
  const { data, error, reload, setData } = useLoad(
    async (t) => {
      const [doc, versions, members, types, profile] = await Promise.all([
        api.document(t, id as string),
        api.versions(t, id as string),
        api.members(t),
        api.documentTypes(t),
        // The household's clock, which a note's "edited …" is said in (5.35).
        api.profile(t).catch(() => null),
      ]);
      return {
        doc,
        versions: versions.items,
        members: members.items,
        types: types.items,
        timezone: profile?.timezone ?? null,
      };
    },
    [id, authVersion],
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [keys] = useState(createUploadKeys);
  // What its pages propose for its empty fields (5.37): offered after Save.
  const suggests = useSuggestionsOffered();

  const latest = data?.versions[0];
  // Two panes from 768 px, the details on the left and the pages on the
  // right (R3, the owner's rule); on a phone, one column, details first.
  const panes = useShellMode() !== 'phone';

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
  // What became of a Remove that did not go through: said by the list.
  const [removeNote, setRemoveNote] = useState<string | null>(null);
  // Where focus lands once a detail has gone, with its button.
  const facts = useRef<HTMLDListElement>(null);
  const removeDetail = async () => {
    if (!data || !removing) return;
    setRemoveBusy(true);
    setRemoveNote(null);
    try {
      // null takes a key away, whatever the type asks for now (0.5.7).
      await withToken((t) =>
        api.updateDocument(t, data.doc.id, { extra: { [removing.key]: null } }, data.doc.etag),
      );
      await reload();
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409) {
        // Changed somewhere else since the page was loaded. It is loaded
        // again, so the next try is made on what is there now.
        setRemoveNote(
          `This document was changed somewhere else, so it has been loaded again. Try again if “${removing.label}” still needs removing.`,
        );
        await reload();
      } else {
        setRemoveNote(describeError(err));
      }
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
      </main>
    );
  }
  if (!data)
    return (
      <main className="page page-top has-nav">
        <TopBar title="Document" back="/" />
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
  const title = doc.title ?? 'Needs a name';
  const visibilityLabel =
    doc.visibility === 'household'
      ? 'Everyone in the family'
      : doc.visibility === 'adults'
        ? 'Adults only'
        : 'Only me';

  return (
    <main className={`page page-top has-nav${panes ? ' doc-panes' : ''}`}>
      <TopBar
        title={title}
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
      <div className="doc-split">
        <section className="doc-details" aria-label={`Details of ${title}`}>
          <div className="row" style={{ alignItems: 'center', gap: 12 }}>
            <StatusBadge status={doc.status} />
            <span className="muted">{visibilityLabel}</span>
          </div>
          <VisibilityControl
            documentId={doc.id}
            current={doc.visibility}
            isMine={doc.owner_member_id !== null && doc.owner_member_id === session.info?.member_id}
            filedByMe={doc.filed_by_me === true}
            onChanged={reload}
          />
          <ErrorNote message={actionError} />
          {latest && !latest.file_removed && (
            <Button onClick={() => void download(latest)}>Download</Button>
          )}
          {/* "We read the pages — is this right?" (5.37): for whoever may change it. */}
          {suggests && mayChangeIt && latest && !latest.file_removed && (
            <PagesSuggest
              key={doc.id}
              doc={doc}
              types={types}
              members={members}
              onSaved={(saved) => setData((d) => (d ? { ...d, doc: saved } : d))}
              onStale={reload}
              onGone={() => facts.current?.focus()}
            />
          )}

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
            {/* Where the original is kept is the household's (5.41): never a
            viewer's or a guest's, whatever an answer carries. */}
            {seesLocation(storedRole()) && doc.physical_location && (
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

          {/* On a phone, the pages within reach: right after the facts, before
              the notes, the history and the rest (R3, as the prototype). */}
          {!panes && (
            <PhonePages documentId={doc.id} title={title} docTitle={doc.title} version={latest} />
          )}

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
          {/* By the list, where the person is: not at the top of the page. */}
          <ErrorNote message={removeNote} />
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

          {/* One note a document (5.35, A30): read by whoever sees it, written
          by whoever may change it. A kind of document that does not ask for
          notes offers none, but shows one it has. */}
          {(doc.notes || (mayChangeIt && coreRule(type, 'notes').shown)) && (
            <NotesSection
              key={doc.id}
              doc={doc}
              label={word('notes', 'Notes')}
              mayEdit={mayChangeIt}
              timezone={data.timezone}
              // As the vault holds it now, whether saved or refused (409): over
              // whatever the page holds then, never a copy from before a reload.
              onSaved={(saved) => setData((d) => (d ? { ...d, doc: saved } : d))}
              onRefreshed={(now) => setData((d) => (d ? { ...d, doc: now } : d))}
            />
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
                      {/* Where it came from, when somebody outside sent it (5.23). */}
                      {v.sent_through ? ` · ${v.sent_through}` : ''}
                    </span>
                    {v.file_removed && <span className="muted">{FILE_REMOVED}</span>}
                  </span>
                  {i > 0 && !v.file_removed && (
                    <Button kind="quiet" onClick={() => void download(v)}>
                      Download
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            <label
              className="btn btn-quiet"
              style={{ display: 'inline-flex', alignItems: 'center' }}
            >
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

          {collectionsOffered(caps, storedRole()) && (
            <DocumentCollections documentId={doc.id} title={title} />
          )}
          {/* A link sends the file: with none yet, there is nothing to send (5.4). */}
          {doc.latest_version_id !== null && (
            <SharePanel
              documentId={doc.id}
              documentTitle={doc.title}
              onlyMe={doc.visibility === 'private'}
            />
          )}
          {mayChangeIt && (
            <button
              ref={trashButton}
              type="button"
              className="btn btn-link btn-trash"
              onClick={() => setConfirmingTrash(true)}
            >
              <TrashIcon />
              Move to the Trash
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
        </section>
        {panes && (
          <DocumentPages
            key={latest?.id ?? 'none'}
            documentId={doc.id}
            title={title}
            version={latest}
            onDrawn={() => void reload()}
          />
        )}
      </div>
    </main>
  );
}

/**
 * The collections this document is in, of those the reader may see, and "Add to
 * a collection" (5.15). A collection the reader may not see is not mentioned at all.
 */
function DocumentCollections(props: { documentId: string; title: string }) {
  const { authVersion } = useApp();
  const { data, error, reload } = useLoad(
    async (t) => (await api.documentCollections(t, props.documentId)).items,
    [props.documentId, authVersion],
  );
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const added = useRef(false);
  const button = useRef<HTMLButtonElement>(null);

  const close = () => {
    setOpen(false);
    setBusy(false);
    if (!added.current) return;
    added.current = false;
    void reload();
  };

  return (
    <section aria-labelledby="doc-collections-h">
      <h2 id="doc-collections-h" className="section-h">
        Collections
      </h2>
      <ErrorNote message={error} />
      {data && data.length > 0 && (
        <ul className="list">
          {data.map((l) => (
            <li key={l.id}>
              <Link to={`/collections/${l.id}`} className="rowbtn">
                <span className="doc-title">{l.name}</span>
                <span className="muted">{audienceLabel(l.audience)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <button ref={button} type="button" className="btn btn-quiet" onClick={() => setOpen(true)}>
        Add to a collection
      </button>
      {open && (
        <Sheet
          label={`Add “${props.title}” to a collection`}
          busy={busy}
          returnFocus={button}
          onClose={close}
        >
          <AddToCollection
            documentIds={[props.documentId]}
            what={`“${props.title}”`}
            onClose={close}
            onBusy={setBusy}
            onAdded={() => {
              added.current = true;
            }}
          />
        </Sheet>
      )}
    </section>
  );
}

/**
 * A document's pages on a phone (R3): today's preview, right after the
 * facts — its first page small, a tap from reading it full size — so
 * nobody scrolls past Move to the Trash to reach them. Nothing is fetched but
 * the small picture, as before.
 */
function PhonePages(props: {
  documentId: string;
  title: string;
  docTitle: string | null;
  version: VersionView | undefined;
}) {
  const { withToken } = useApp();
  const latest = props.version;
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    // Nothing to draw a thumbnail from: its file was removed for good (5.24).
    if (!latest || latest.file_removed) return;
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

  return (
    <section className="doc-pages" aria-label={`Pages of ${props.title}`}>
      {latest?.file_removed ? (
        // Its record came back with a restore, its file did not (5.24).
        <div className="preview preview-removed" role="note" aria-label="Preview">
          <span className="muted">{FILE_REMOVED}</span>
        </div>
      ) : latest ? (
        <Link
          to={`/documents/${props.documentId}/read`}
          className="preview preview-link"
          aria-label={`Read ${props.docTitle ?? 'the document'}, full size`}
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
    </section>
  );
}

/** About two minutes of "being drawn" before it stops asking by itself (as the reader). */
const PATIENCE = 40;
/** How long the turning has to stop before the page turned to is fetched (W-R3-2). */
const TURN_SETTLES_MS = 150;
/** The kinds of file the vault draws the pages of, as the worker's `drawable` has them. */
const DRAWN_KINDS = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/tiff',
  'image/heic',
  'image/heif',
]);
const drawsKind = (mime: string) => DRAWN_KINDS.has(mime);

type PageState =
  | { kind: 'making' }
  | { kind: 'slow' }
  | { kind: 'ask' }
  | { kind: 'none'; message: string }
  | { kind: 'failed'; message: string };

/**
 * A document's pages beside its details, from 768 px (R3): the shared
 * viewer (page-viewer.tsx), its first page shown on arrival and each other
 * as it is turned to — fetched only then, as the reader does, so each page
 * shown is in the activity log and nothing is fetched ahead. An Essential
 * or an Only me document's pages are never asked for with a question on
 * arrival: "Confirm it's you" waits for the person to ask. "Read it full
 * size" opens today's reader at the page shown.
 */
function DocumentPages(props: {
  documentId: string;
  title: string;
  version: VersionView | undefined;
  /** Drawn just now: the version is asked for again, to learn how many pages. */
  onDrawn: () => void;
}) {
  const { withToken, guarded } = useApp();
  const version = props.version;
  const versionId = version?.id;
  // Pages drawn (null: not yet; 0: it cannot be drawn), and the file's own
  // length, which can be more than the 30 that are drawn (as the reader).
  const drawn = version?.preview_pages ?? null;
  const length = version?.page_count ?? null;
  const last = drawn ?? (length !== null ? Math.min(length, PREVIEW_MAX_PAGES) : 1);
  const none = !version
    ? 'No file yet'
    : version.file_removed
      ? FILE_REMOVED
      : drawn === 0
        ? // 0 is a kind it does not draw, or a drawing that failed (the
          // vault says both so): a PDF or a picture is always drawn (W-R3-3).
          drawsKind(version.mime)
          ? 'Its pages could not be drawn. Download it to open it.'
          : 'The vault does not draw this kind of file’s pages. Download it to open it.'
        : null;
  const [n, setN] = useState(1);
  const [attempt, setAttempt] = useState(0);
  // The try that may ask who is asking: the one "Confirm it's you" began.
  const [confirming, setConfirming] = useState<string | null>(null);
  // Each page shown, by its number; and what was last heard of the one asked for.
  const [pages, setPages] = useState<Record<number, string>>({});
  const [heard, setHeard] = useState<{ key: string; state: PageState } | null>(null);
  const made = useRef<string[]>([]);
  const key = `${n}|${attempt}`;
  const url = pages[n] ?? null;
  const page = url ? null : heard?.key === key ? heard.state : null;

  // While shown: a page that arrives after it was turned away from is kept
  // (it was fetched, and logged, once); the pages being fetched now; whether
  // the person has turned yet; and a page given up on mid-way, to ask again.
  const alive = useRef(true);
  const fetching = useRef(new Set<number>());
  const turned = useRef(false);
  const lastHeard = useRef<{ key: string; state: PageState } | null>(null);
  const [settled, setSettled] = useState(0);

  useEffect(() => {
    const urls = made.current;
    alive.current = true;
    return () => {
      alive.current = false;
      for (const u of urls) URL.revokeObjectURL(u);
    };
  }, []);

  useEffect(() => {
    if (!versionId || none !== null || url) return;
    // Being fetched already (turned away and back): it is shown when it comes.
    if (fetching.current.has(n)) return;
    // Heard of, and nothing to wait for: until "Try again" or "Confirm it's you".
    const before = lastHeard.current;
    if (before?.key === key && before.state.kind !== 'making') return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const say = (state: PageState) => {
      lastHeard.current = { key, state };
      setHeard({ key, state });
    };
    const fetchPage = (t: string) => api.page(t, versionId, n);
    const asked = confirming === key;
    const tryOnce = async (tries: number) => {
      fetching.current.add(n);
      try {
        const blob = asked
          ? await guarded(fetchPage, { cancelled: () => stopped })
          : await withToken(fetchPage);
        if (!alive.current) return;
        if (!blob) {
          if (asked && !stopped) say({ kind: 'ask' });
          return;
        }
        // Kept even when turned away from meanwhile: turning back asks nothing.
        const shown = URL.createObjectURL(blob);
        made.current.push(shown);
        setPages((was) => ({ ...was, [n]: shown }));
      } catch (err) {
        if (!alive.current || stopped) return;
        if (err instanceof ApiRequestError && err.code === 'step_up_required') {
          say({ kind: 'ask' });
          return;
        }
        if (err instanceof ApiRequestError && err.code === 'preview_pending') {
          if (tries >= PATIENCE) {
            say({ kind: 'slow' });
            return;
          }
          say({ kind: 'making' });
          timer = setTimeout(() => void tryOnce(tries + 1), (err.retryAfterSeconds ?? 3) * 1000);
          return;
        }
        if (err instanceof ApiRequestError && err.code === 'no_preview') {
          say({ kind: 'none', message: err.message });
          return;
        }
        say({ kind: 'failed', message: describeError(err) });
      } finally {
        fetching.current.delete(n);
        // Given up on while it was away: looked at again, it is asked again.
        if (stopped && alive.current) setSettled((s) => s + 1);
      }
    };
    // The first page at once; a page turned to once the turning stops, so
    // pages passed on the way are neither fetched nor logged (W-R3-2).
    timer = setTimeout(() => void tryOnce(0), turned.current ? TURN_SETTLES_MS : 0);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [versionId, n, key, none, url, confirming, guarded, withToken, settled]);

  // Drawn just now: the version knows how many pages there are. Once.
  const { onDrawn } = props;
  const recounted = useRef(false);
  useEffect(() => {
    if (!url || drawn !== null || recounted.current) return;
    recounted.current = true;
    onDrawn();
  }, [url, drawn, onDrawn]);

  const again = () => setAttempt((a) => a + 1);
  const confirm = () => {
    setConfirming(`${n}|${attempt + 1}`);
    setAttempt(attempt + 1);
  };
  const note =
    page?.kind === 'making'
      ? 'Its pages are being drawn. They appear here once they are.'
      : page?.kind === 'slow'
        ? 'Drawing its pages is taking longer than usual.'
        : page?.kind === 'ask'
          ? 'Confirm it’s you to see its pages.'
          : page?.kind === 'none' || page?.kind === 'failed'
            ? page.message
            : 'Loading the page…';
  const noteAction =
    page?.kind === 'ask' ? (
      <button type="button" className="btn btn-quiet" onClick={confirm}>
        Confirm it’s you
      </button>
    ) : page?.kind === 'slow' || page?.kind === 'failed' ? (
      <button type="button" className="btn btn-quiet" onClick={again}>
        Try again
      </button>
    ) : undefined;

  return (
    <PageViewer
      className="doc-pages"
      label={`Pages of ${props.title}`}
      total={none === null ? last : 0}
      of={length ?? last}
      n={n}
      onTurn={(to) => {
        turned.current = true;
        setN(to);
      }}
      url={url}
      note={note}
      noteAction={noteAction}
      none={none}
      tools={
        version && none === null ? (
          <Link
            to={`/documents/${props.documentId}/read?v=${version.id}&p=${n}`}
            className="btn btn-quiet btn-small"
          >
            Read it full size
          </Link>
        ) : undefined
      }
      after={
        url && n >= last && length !== null && length > last ? (
          <p className="muted viewer-hint">
            Pages {last + 1}–{length} aren’t shown here. Download the file to read them.
          </p>
        ) : undefined
      }
    />
  );
}
