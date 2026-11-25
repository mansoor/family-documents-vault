import {
  can,
  FILE_REMOVED,
  isRecordFormat,
  RECORD_ACCEPT,
  recordNoPreviewWords,
  firstReview,
  formatDate,
  issuedByLabel,
  localToday,
  NOTE_KIND,
  REVIEW_LABEL,
  yearlyReviewOffered,
  PREVIEW_MAX_PAGES,
  type CoreField,
  type VersionView,
  SENSITIVE_LABEL,
  SENSITIVE_MEANS,
  CAREGIVER_MARK,
} from '@fdv/shared';
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { FileItHere, WhereKeptRow } from '../original-place.js';
import { SourceFolderRow } from '../source-folder.js';
import { TheirLinksOpened } from '../link-opens.js';
import { api, ApiRequestError } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { AddToCollection, audienceLabel, collectionsOffered } from '../collections.js';
import { AlsoInRow } from '../cabinet.js';
import { mayChange } from '../DocActions.js';
import { asksFor, coreRule, detailText, useAttributes } from '../details.js';
import { NotesSection } from '../notes.js';
import {
  NeededAgainQuestion,
  NoLongerNeededBanner,
  NoLongerNeededInfo,
} from '../no-longer-needed.js';
import { DocPanes, type DocPanesView } from '../doc-panes.js';
import { PageViewer } from '../page-viewer.js';
import { useOpenedOnPage } from '../recently-opened.js';
import { useShellMode } from '../shell.js';
import {
  Button,
  categoryLabel,
  ConfirmDialog,
  ErrorNote,
  IdScope,
  NamedWithin,
  useNamedWithin,
  MoveToTrashDialog,
  Sheet,
  StatusBadge,
  TopBar,
} from '../ui.js';
import { storedRole } from '../session.js';
import { useSuggestionsOffered } from '../suggestions.js';
import { PagesOffers } from '../renewal.js';
import { OlderVersionBanner, OlderVersionDetails } from '../version-view.js';
import { SharePanel } from './Share.js';
import { TagSection } from '../tags.js';
import { mayChangeWhoSees, VisibilityControl } from './Visibility.js';
import { ActionIcon, ActionRow, countBadge } from '../action-row.js';
import { DocumentActivityPanel } from '../document-activity.js';
import { createUploadKeys, whileInProgress } from '../upload-keys.js';
import { documentFacts, PrintDocument, sheetNote, whoseWords } from '../print-document.js';
import { exactWords, familyZoneNow } from '../family-time.js';

/**
 * A document's own page, `/documents/:id`: its view (DocumentView), the
 * address saying which document and which of its versions is shown.
 */
export function DocumentScreen() {
  const { id } = useParams<{ id: string }>();
  // Arrived from Add, its file just filed (0.9.0, C3): File it here is offered.
  const arrived: unknown = useLocation().state;
  const justFiled =
    typeof arrived === 'object' &&
    arrived !== null &&
    (arrived as { justFiled?: unknown }).justFiled === true;
  return <DocumentView id={id as string} host="page" justFiled={justFiled} />;
}

/** Where a document is shown: its own page, or beside the list (flyouts). */
export type DocumentHost = DocumentViewProps['host'];

/**
 * Why a document beside the list has nothing more to show, for its host to
 * close it: moved to the Trash (`said` is what to announce, the words the
 * page says on Home), or it is a note, which is read on Notes.
 */
export type DocumentViewClosed =
  { reason: 'trashed'; said: string } | { reason: 'note'; noteId: string };

/**
 * Document detail: the facts in a plain two-column list, its notes, the
 * history of versions, and one primary action — Download. From 768 px the
 * details are on the left and the pages on the right, turned in the shared
 * viewer (R3, the owner's rule); on a phone, one column — the details
 * first, with a preview right after the facts that opens the pages full
 * size, to read (0.4.12).
 *
 * Two hosts. On its own page (`page`) it is the screen it always was: the
 * address holds the older version looked at, the Trash goes to Home, a
 * note goes to Notes. Beside the list (`flyout`) it never reads or changes
 * the address: the version looked at is its own, and the Trash and a note
 * are told to the host (`onClosed`) instead. Its own width decides its
 * panes there (DocPanes `fit="own"`), and `view` "content" shows its pages
 * alone. Edit is a page in both.
 *
 * Beside the list it starts afresh for each document (keyed by its id):
 * nothing of one document — a late answer, an open dialog, a version
 * looked at, an open section — is carried to the next. The page is as it
 * always was.
 */
export function DocumentView(props: DocumentViewProps) {
  return props.host === 'flyout' ? <BesideTheList {...props} /> : <OneDocumentView {...props} />;
}

/**
 * Beside the list, more than one may be open at once: the ids of the forms
 * inside (Share a link's) are each one's own (IdScope), the same while it
 * loads and once it has.
 */
function BesideTheList(props: DocumentViewProps & { host: 'flyout' }) {
  const scope = useId();
  return (
    <IdScope id={scope}>
      <NamedWithin by={props.headingId}>
        <OneDocumentView key={props.id} {...props} />
      </NamedWithin>
    </IdScope>
  );
}

export type DocumentViewProps =
  | {
      id: string;
      host: 'page';
      /** Arrived from Add, its file just filed: File it here is offered. */
      justFiled?: boolean;
    }
  | {
      id: string;
      host: 'flyout';
      /** Told when there is nothing more to show here: its host closes it. */
      onClosed: (why: DocumentViewClosed) => void;
      /** Both panes, or its pages alone (Hide details). */
      view?: DocPanesView;
      /** The host's own buttons, before Edit (Hide details). */
      tools?: ReactNode;
      /** The host's own buttons, after Edit (Minimise, Close). */
      controls?: ReactNode;
      /** The heading's id, for the host's dialog to be named by. */
      headingId?: string;
      /** The host's word under its heading, across the whole width (choosing from the list). */
      notice?: ReactNode;
      /** Told what the host needs of it once it is loaded, and whenever that changes. */
      onLoaded?: (loaded: DocumentViewLoaded) => void;
    };

/**
 * What a document beside the list tells its host as it loads and changes:
 * its name (the tray), whether it is in the Trash (nothing to show beside
 * a list), and a stamp that changes whenever it is saved, here or elsewhere (the
 * lists under it are loaded again).
 */
export interface DocumentViewLoaded {
  title: string;
  inTrash: boolean;
  stamp: string;
}

function OneDocumentView(props: DocumentViewProps) {
  const { id, host } = props;
  const onPage = host === 'page';
  const flyout = props.host === 'flyout' ? props : null;
  const justFiled = props.host === 'page' && props.justFiled === true;
  const { withToken, guarded, authVersion, session, caps } = useApp();
  const navigate = useNavigate();
  // A note that asks to confirm it's you (0.9.0-dev.87), opened from a
  // search hit, is answered `step_up_required` here — no document's own read
  // asks — and goes to Notes, which asks, with its title and date.
  const { data, error, errorCode, reload, setData } = useLoad(
    async (t) => {
      const [doc, versions, members, types, profile] = await Promise.all([
        api.document(t, id),
        api.versions(t, id),
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
  const asksFirst = errorCode === 'step_up_required';
  const [actionError, setActionError] = useState<string | null>(null);
  // The action row's counts, as its sections say them; and which is busy.
  const [counts, setCounts] = useState<{ collections?: number; links?: number }>({});
  const [busy, setBusy] = useState<{ visibility?: boolean; share?: boolean }>({});
  const onCollections = useCallback(
    (n: number) => setCounts((c) => ({ ...c, collections: n })),
    [],
  );
  const onLinks = useCallback((n: number) => setCounts((c) => ({ ...c, links: n })), []);
  const [keys] = useState(createUploadKeys);
  // What its pages propose for its empty fields (5.37): offered after Save.
  const suggests = useSuggestionsOffered();

  const latest = data?.versions[0];
  // An older version looked at (0.9.0): on the page, named in the address,
  // so Back and a reload keep it; beside the list, held here (afresh for
  // each document). The current version, or one not of this document, is
  // the document as ever.
  const [params, setParams] = useSearchParams();
  const [held, setHeld] = useState<string | null>(null);
  const asked = onPage ? params.get('version') : held;
  const shownAt = asked ? (data?.versions.findIndex((v) => v.id === asked) ?? -1) : -1;
  const viewing = shownAt > 0 ? data?.versions[shownAt] : undefined;
  const viewVersion = (v: VersionView | null) => {
    if (!onPage) {
      setHeld(v ? v.id : null);
      return;
    }
    setParams(
      (now) => {
        const next = new URLSearchParams(now);
        if (v) next.set('version', v.id);
        else next.delete('version');
        return next;
      },
      { replace: false },
    );
  };
  // Two panes from 768 px, the details on the left and the pages on the
  // right (R3, the owner's rule); on a phone, one column, details first.
  // Beside the list its own width decides (DocPanes), the pages always in
  // its viewer.
  const shellPanes = useShellMode() !== 'phone';
  const panes = !onPage || shellPanes;
  // The details pane, which the line between the panes controls: one id on
  // the page, as ever; beside the list, its own, as others may be open.
  const ownId = useId();
  const detailsId = onPage ? 'doc-details' : `doc-details-${ownId}`;
  // Every id inside it likewise: as on the page, there; beside the list,
  // its own, as more than one document may be open there at once.
  const own = (name: string) => (onPage ? name : `${name}-${ownId}`);
  // A section's name, the document's too beside the list (side by side).
  const named = useNamedWithin();
  // Told to the host beside the list: the latest it gave.
  const closed = useRef(flyout?.onClosed);
  const toldLoaded = useRef(flyout?.onLoaded);
  useEffect(() => {
    closed.current = flyout?.onClosed;
    toldLoaded.current = flyout?.onLoaded;
  });

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

  // No longer needed (0.9.0): set with the details (Edit, since the owner's
  // word of 24 Oct, the one place to set it), said here by its banner, and
  // asked about again when a new version is added — never made needed again
  // by the adding alone.
  const [askAgain, setAskAgain] = useState(false);
  const versionInput = useRef<HTMLLabelElement>(null);
  // Its banner, opened and closed by the (i) beside "No longer needed"
  // (0.9.0-dev.53; the owner's ask of 16 Nov 2026): closed on each document.
  // Held as the document it is open for, so another document starts closed.
  const [aboutFor, setAboutFor] = useState<string | null>(null);
  const aboutUnneeded = aboutFor === id;

  const addVersion = async (file: File | undefined) => {
    if (!file || !data) return;
    setActionError(null);
    try {
      const key = keys.keyFor(file);
      const added = await whileInProgress(() =>
        withToken((t) => api.upload(t, data.doc.id, file, key)),
      );
      keys.saved();
      await reload();
      if (added && data.doc.no_longer_needed) setAskAgain(true);
    } catch (err) {
      setActionError(describeError(err));
    }
  };

  // Print (0.9.0): what to print, in a dialog from the action row.
  const [printing, setPrinting] = useState(false);
  const printButton = useRef<HTMLButtonElement>(null);

  // Moving to the Trash asks first, in the app's own dialog (5.1).
  const [confirmingTrash, setConfirmingTrash] = useState(false);
  const [trashing, setTrashing] = useState(false);
  const trashButton = useRef<HTMLButtonElement>(null);
  const remove = async () => {
    if (!data) return;
    setTrashing(true);
    try {
      await withToken((t) => api.deleteDocument(t, data.doc.id));
      const said = `“${data.doc.title ?? 'Needs a name'}” moved to the Trash. You can bring it back from there.`;
      if (!onPage) {
        // Beside the list: its host closes it and says so, the list kept.
        setConfirmingTrash(false);
        closed.current?.({ reason: 'trashed', said });
        return;
      }
      // Home, where what was done is said and has the focus (R5): as Documents
      // says it of many, and never in silence.
      void navigate('/', { replace: true, state: { said } });
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

  // A note kept on its own (0.9.0, N1) is read and written on Notes. Beside
  // the list (where a note's row never opens it) its host is told, once.
  const noteId = data?.doc.type_key === NOTE_KIND || asksFirst ? id : null;
  useEffect(() => {
    if (!onPage && noteId !== null) closed.current?.({ reason: 'note', noteId });
  }, [onPage, noteId]);
  // Its page arrived at: Home's Recent remembers it (0.9.0-dev.102), once
  // for each arrival. Beside the list, the open itself told it
  // (flyout-context), so a reload or an unlock drawing it again tells nothing.
  // (Its own document only: not the one before it, still shown while it loads.)
  useOpenedOnPage(
    onPage && data?.doc.id === id ? data.doc : null,
    data?.doc.type_key === NOTE_KIND,
    justFiled,
  );
  // What its host beside the list needs of it (DocumentViewLoaded).
  const loadedTitle = data ? (data.doc.title ?? 'Needs a name') : null;
  const loadedInTrash = Boolean(data?.doc.deleted_at);
  const loadedStamp = data
    ? `${data.doc.etag}|${data.versions.length}|${data.versions[0]?.id ?? ''}`
    : null;
  useEffect(() => {
    if (loadedTitle === null || loadedStamp === null) return;
    toldLoaded.current?.({
      title: loadedTitle,
      inTrash: loadedInTrash,
      stamp: loadedStamp,
    });
  }, [loadedTitle, loadedInTrash, loadedStamp]);

  if (asksFirst) return onPage ? <Navigate to={`/notes/${id}`} replace /> : null;
  if (error) {
    return onPage ? (
      <main className="page page-top has-nav">
        <TopBar title="Document" back="/" backInApp />
        <ErrorNote message={error} />
      </main>
    ) : (
      <FlyoutView
        title="Document"
        tools={flyout?.tools}
        controls={flyout?.controls}
        headingId={flyout?.headingId}
        notice={flyout?.notice}
      >
        <ErrorNote message={error} />
      </FlyoutView>
    );
  }
  if (!data)
    return onPage ? (
      <main className="page page-top has-nav">
        <TopBar title="Document" back="/" backInApp />
      </main>
    ) : (
      <FlyoutView
        title="Document"
        tools={flyout?.tools}
        controls={flyout?.controls}
        headingId={flyout?.headingId}
        notice={flyout?.notice}
      />
    );

  const { doc, versions, members, types } = data;
  // A note kept on its own (0.9.0, N1) is read and written on Notes: a
  // search hit or a row in the table that opens it goes there.
  if (doc.type_key === NOTE_KIND)
    return onPage ? <Navigate to={`/notes/${doc.id}`} replace /> : null;
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
  // Whose it is, as its details say it: printed in the same words.
  const person = whoseWords(doc, members);
  const memberId = session.info?.member_id ?? null;
  const isMine = doc.owner_member_id !== null && doc.owner_member_id === memberId;
  const filedByMe = doc.filed_by_me === true;
  // Seen only as its person's caregiver (0.9.0, H1b): read, downloaded,
  // nothing more — no change, no link, no collection, no new version.
  const caregiver = doc.caregiver === true;
  const history = (
    <HistorySection
      headingId={own('history-h')}
      versions={versions}
      viewing={viewing?.id ?? null}
      onDownload={(v) => void download(v)}
      onView={(v) => viewVersion(v)}
      ref={versionInput}
      onAdd={caregiver ? null : (file) => void addVersion(file)}
    />
  );
  // An older version looked at: its banner, its own details, its pages, its
  // Download and the history — nothing that changes the document, which is
  // the current version's (0.9.0).
  const olderPane = viewing ? (
    <section id={detailsId} className="doc-details" aria-label={`Details of ${title}`}>
      <OlderVersionBanner
        version={viewing}
        of={versions.length}
        next={versions[shownAt - 1]}
        onBack={() => viewVersion(null)}
      />
      {!panes && (
        <DocumentPages
          key={`phone-${viewing.id}`}
          documentId={doc.id}
          title={`${title}, version ${viewing.version_no}`}
          version={viewing}
          onDrawn={() => void reload()}
        />
      )}
      <OlderVersionDetails version={viewing} type={type} person={owner?.display_name ?? null} />
      <hr className="note-divider" />
      <ActionRow
        kind="document"
        memberId={memberId}
        fromAddress={onPage}
        place={host}
        onDownload={!viewing.file_removed ? () => void download(viewing) : null}
        onTrash={null}
        error={<ErrorNote message={actionError} />}
        sections={[
          {
            key: 'history' as const,
            label: 'History',
            icon: <ActionIcon name="history" />,
            badge: countBadge(versions.length, 'version', 'versions'),
            render: () => history,
          },
        ]}
      />
    </section>
  ) : null;
  const visibilityLabel =
    doc.visibility === 'household'
      ? 'Everyone in the family'
      : doc.visibility === 'adults'
        ? 'Adults only'
        : 'Only me';

  const detailsPane = (
    <section id={detailsId} className="doc-details" aria-label={`Details of ${title}`}>
      <div className="row" style={{ alignItems: 'center', gap: 12 }}>
        <span className="row" style={{ alignItems: 'center', gap: 4 }}>
          <StatusBadge status={doc.status} />
          {doc.no_longer_needed && (
            <NoLongerNeededInfo
              open={aboutUnneeded}
              controls={own('nln-about')}
              onToggle={() => setAboutFor((o) => (o === id ? null : id))}
            />
          )}
        </span>
        <span className="muted">{visibilityLabel}</span>
      </div>
      {/* Kept, but no longer needed (0.9.0): since when, what replaced
              it, and Needed again for whoever may change it — opened by
              its (i) above, closed until then. */}
      <NoLongerNeededBanner
        doc={doc}
        mayChange={mayChangeIt}
        open={aboutUnneeded}
        id={own('nln-about')}
        onChanged={(saved) => setData((d) => (d ? { ...d, doc: saved } : d))}
      />
      {askAgain && (
        <NeededAgainQuestion
          doc={doc}
          returnFocus={versionInput}
          onAnswered={(saved) => {
            setAskAgain(false);
            if (saved) setData((d) => (d ? { ...d, doc: saved } : d));
          }}
        />
      )}
      {/* "The new version says:" (0.9.0) and "We read the pages — is this
          right?" (5.37): for whoever may change it. */}
      {suggests && mayChangeIt && latest && !latest.file_removed && (
        <PagesOffers
          key={`pages-${doc.id}`}
          doc={doc}
          types={types}
          members={members}
          onSaved={(saved) => setData((d) => (d ? { ...d, doc: saved } : d))}
          onStale={reload}
          onGone={() => facts.current?.focus()}
        />
      )}

      {/* Just filed from a scan or an upload (0.9.0, C3): where its paper
          goes, its folders in the reader's cabinet offered first. */}
      {justFiled && (
        <FileItHere
          doc={doc}
          mayChange={mayChangeIt}
          onSaved={(saved) => setData((d) => (d ? { ...d, doc: saved } : d))}
        />
      )}

      {/* A paper seen as its person's caregiver (0.9.0, H1b): said so, plainly. */}
      {caregiver && (
        <p className="caregiver-mark" role="note">
          <strong>{CAREGIVER_MARK}.</strong>{' '}
          <span className="muted">
            {owner
              ? `${owner.display_name} lets you see their medical papers. You can read this and save a copy, but not change or share it.`
              : 'You can read this and save a copy, but not change or share it.'}
          </span>
        </p>
      )}
      {/* Sensitive, all said (0.9.0, AIR2): a lock, named for what it means. */}
      {doc.sensitive_effective === true && (
        <p className="sensitive-mark">
          <span role="img" aria-label={SENSITIVE_LABEL} title={SENSITIVE_MEANS}>
            <LockIcon />
          </span>
          <span aria-hidden="true">{SENSITIVE_LABEL}</span>
        </p>
      )}
      <dl className="facts" ref={facts} tabIndex={-1}>
        <dt>Type</dt>
        <dd>{type?.label ?? 'Not set'}</dd>
        <dt>Person</dt>
        <dd>{person}</dd>
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
        {/* The reader's own cabinet folders it is in (0.9.0, C1). */}
        <AlsoInRow documentId={doc.id} inTrash={Boolean(doc.deleted_at)} />
        {/* Where the original is kept is the household's (5.41): never a
            viewer's or a guest's, whatever an answer carries. */}
        {/* With its place in a cabinet (0.9.0, C3): "Study › Drawer 2 ›
            Tax 2025 · behind the blue divider", and File it in my cabinet…
            for whoever may change it. */}
        <WhereKeptRow
          doc={doc}
          label={word('physical_location', 'Original is kept')}
          mayChange={mayChangeIt}
          onSaved={(saved) => setData((d) => (d ? { ...d, doc: saved } : d))}
        />
        {/* The folder it came from (0.9.0, C4): the household's, as above. */}
        <SourceFolderRow
          doc={doc}
          mayChange={mayChangeIt}
          onSaved={(saved) => setData((d) => (d ? { ...d, doc: saved } : d))}
        />
      </dl>

      {/* A yearly review (0.9.0, H3): on an advance directive, a proxy or a
          HIPAA authorization, off until somebody turns it on. */}
      {caps?.features.health_kinds === true &&
        !caregiver &&
        !doc.deleted_at &&
        !doc.no_longer_needed &&
        can(storedRole(), 'reminder.manage') && (
          <YearlyReview
            key={`review-${doc.id}`}
            idBase={own('yearly-review')}
            documentId={doc.id}
            signed={doc.issued?.date ?? null}
            offered={yearlyReviewOffered(type)}
          />
        )}

      {/* On a phone, the pages within reach: right after the facts, before
              the notes, the history and the rest (R3, as the prototype). */}
      {!panes && (
        <PhonePages documentId={doc.id} title={title} docTitle={doc.title} version={latest} />
      )}

      {others.length > 0 && (
        <section aria-labelledby={named(own('other-h'))}>
          <h2 id={own('other-h')} className="section-h">
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
      {/* The thin line under the details and the note; then one row:
              Download, a button for each section, and the Trash at the end
              (the owner's request of 24 Oct 2026). */}
      <hr className="note-divider" />
      <ActionRow
        kind="document"
        memberId={memberId}
        fromAddress={onPage}
        place={host}
        onDownload={latest && !latest.file_removed ? () => void download(latest) : null}
        onPrint={() => setPrinting(true)}
        printRef={printButton}
        onTrash={mayChangeIt ? () => setConfirmingTrash(true) : null}
        trashRef={trashButton}
        error={<ErrorNote message={actionError} />}
        sections={[
          // Its versions beside Download: the file's own actions together.
          {
            key: 'history' as const,
            label: 'History',
            icon: <ActionIcon name="history" />,
            badge: countBadge(versions.length, 'version', 'versions'),
            render: () => history,
          },
          ...(!caregiver && mayChangeWhoSees({ current: doc.visibility, isMine, filedByMe })
            ? [
                {
                  key: 'visibility' as const,
                  // Its words without its value: the details say that (the
                  // owner's request of 24 Nov 2026).
                  label: 'Visibility',
                  icon: <ActionIcon name="eye" />,
                  heading: 'Visibility',
                  busy: busy.visibility === true,
                  render: (done: () => void) => (
                    <VisibilityControl
                      documentId={doc.id}
                      current={doc.visibility}
                      isMine={isMine}
                      filedByMe={filedByMe}
                      onChanged={reload}
                      onClose={done}
                      onBusy={(on) => setBusy((b) => ({ ...b, visibility: on }))}
                    />
                  ),
                },
              ]
            : []),
          // Its tags as chips, each a way to the others like it; added and
          // taken off here by whoever may change it (0.9.0, T1).
          ...(doc.tags.length > 0 || mayChangeIt
            ? [
                {
                  key: 'tags' as const,
                  label: 'Tags',
                  icon: <ActionIcon name="tag" />,
                  badge: countBadge(doc.tags.length, 'tag', 'tags'),
                  render: () => (
                    <TagSection
                      key={`tags-${doc.id}`}
                      doc={doc}
                      mayEdit={mayChangeIt}
                      onSaved={(saved) => setData((d) => (d ? { ...d, doc: saved } : d))}
                    />
                  ),
                },
              ]
            : []),
          ...(!caregiver && collectionsOffered(caps, storedRole())
            ? [
                {
                  key: 'collections' as const,
                  label: 'Collections',
                  icon: <ActionIcon name="collection" />,
                  badge:
                    counts.collections === undefined
                      ? null
                      : countBadge(counts.collections, 'collection', 'collections'),
                  render: () => (
                    <DocumentCollections
                      headingId={own('doc-collections-h')}
                      documentId={doc.id}
                      title={title}
                      onCount={onCollections}
                    />
                  ),
                },
              ]
            : []),
          // A link sends the file: with none yet, there is nothing to send (5.4).
          ...(!caregiver && doc.latest_version_id !== null && can(storedRole(), 'document.share')
            ? [
                {
                  key: 'share' as const,
                  label: 'Share a link',
                  icon: <ActionIcon name="link" />,
                  badge: counts.links ? countBadge(counts.links, 'live link', 'live links') : null,
                  busy: busy.share === true,
                  render: (done: () => void) => (
                    <SharePanel
                      documentId={doc.id}
                      documentTitle={doc.title}
                      onlyMe={doc.visibility === 'private'}
                      sensitive={doc.sensitive_effective === true}
                      onClose={done}
                      onBusy={(on) => setBusy((b) => ({ ...b, share: on }))}
                      onCount={onLinks}
                      fromAddress={onPage}
                    />
                  ),
                },
              ]
            : []),
          // Its lines in the activity log (0.9.0, DA), under the row since
          // 0.9.0-dev.67: for whoever reads the log, never a caregiver, whose
          // papers' lines it gives them none. Read once it is first opened.
          ...(!caregiver &&
          caps?.features.document_activity === true &&
          can(storedRole(), 'audit.read')
            ? [
                {
                  key: 'activity' as const,
                  label: 'Activity',
                  icon: <ActionIcon name="activity" />,
                  lazy: true,
                  render: () => (
                    <DocumentActivityPanel
                      key={`activity-${doc.id}`}
                      documentId={doc.id}
                      title={doc.title}
                      sensitive={doc.sensitive_effective === true}
                    />
                  ),
                },
              ]
            : []),
        ]}
      />
      {/* Their own sensitive paper's links, whoever made them, and who
          opened each (0.9.0, H5). */}
      {isMine && doc.sensitive_effective === true && <TheirLinksOpened documentId={doc.id} />}
      {printing && (
        <PrintDocument
          title={title}
          version={latest}
          facts={documentFacts(doc, type, person, storedRole())}
          note={sheetNote(doc, type)}
          sensitive={doc.sensitive_effective === true}
          returnFocus={printButton}
          onClose={() => setPrinting(false)}
        />
      )}
      {confirmingTrash && (
        <MoveToTrashDialog
          title={doc.title}
          sensitive={doc.sensitive_effective === true}
          backupDays={caps?.limits.backup_retain_days ?? null}
          busy={trashing}
          returnFocus={trashButton}
          onConfirm={() => void remove()}
          onCancel={() => setConfirmingTrash(false)}
        />
      )}
    </section>
  );

  // Edit is the current version's: none while an older one is shown. A
  // page in both hosts.
  const edit = viewing ? undefined : (
    <Link to={`/documents/${doc.id}/confirm`} className="btn btn-quiet" style={{ minHeight: 40 }}>
      Edit
    </Link>
  );
  const pagesPane = (
    <DocumentPages
      key={(viewing ?? latest)?.id ?? 'none'}
      documentId={doc.id}
      title={viewing ? `${title}, version ${viewing.version_no}` : title}
      version={viewing ?? latest}
      onDrawn={() => void reload()}
    />
  );

  if (!onPage)
    return (
      <FlyoutView
        title={title}
        tools={
          <>
            {flyout?.tools}
            {edit}
          </>
        }
        controls={flyout?.controls}
        headingId={flyout?.headingId}
        notice={flyout?.notice}
      >
        <DocPanes
          fit="own"
          view={flyout?.view ?? 'both'}
          detailsId={detailsId}
          details={olderPane ?? detailsPane}
          pages={pagesPane}
        />
      </FlyoutView>
    );

  return (
    <main className={`page page-top has-nav${panes ? ' doc-panes' : ''}`}>
      <TopBar title={title} back="/" backInApp action={edit} />
      {panes ? (
        // From 768 px the details beside the pages, the line between them
        // moved to widen either (0.9.0).
        <DocPanes details={olderPane ?? detailsPane} pages={pagesPane} />
      ) : (
        <div className="doc-split">{olderPane ?? detailsPane}</div>
      )}
    </main>
  );
}

/**
 * A document beside the list: its name as the heading (for its host to
 * focus as it opens), the host's buttons and Edit beside it, then the view.
 */
function FlyoutView(props: {
  title: string;
  tools?: ReactNode;
  controls?: ReactNode;
  headingId?: string | undefined;
  notice?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="doc-view doc-view-flyout">
      <div className="doc-flyout-head">
        <h2 id={props.headingId} className="doc-flyout-title" tabIndex={-1}>
          {props.title}
        </h2>
        <div className="row doc-flyout-tools">{props.tools}</div>
        {props.controls && <div className="row doc-flyout-controls">{props.controls}</div>}
        {props.notice && <div className="doc-flyout-notice">{props.notice}</div>}
      </div>
      {props.children}
    </div>
  );
}

/** A closed lock: the mark of a sensitive document (0.9.0, AIR2). */
function LockIcon() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

/**
 * A document's versions, newest first, each older one to look at (0.9.0)
 * and to download; and Add a new version.
 */
function HistorySection({
  ref,
  ...props
}: {
  headingId: string;
  versions: VersionView[];
  /** The older version shown, if one is. */
  viewing: string | null;
  onDownload: (v: VersionView) => void;
  /** Look at a version: an older one, or the current one again (null). */
  onView: (v: VersionView | null) => void;
  /** Add a new version: where the focus goes back to after asking about it. */
  ref: RefObject<HTMLLabelElement | null>;
  /** Null for somebody who may not add one: a caregiver (H1b). */
  onAdd: ((file: File | undefined) => void) | null;
}) {
  const { versions, onAdd } = props;
  const named = useNamedWithin();
  return (
    <section aria-labelledby={named(props.headingId)}>
      <h2 id={props.headingId} className="section-h">
        History
      </h2>
      <ul className="list">
        {versions.map((v, i) => (
          <li key={v.id}>
            <span>
              <strong>{i === 0 ? 'Current' : `Version ${v.version_no}`}</strong>
              <span className="muted">
                {v.filename} · {(v.byte_size / 1024).toFixed(0)} KB · added{' '}
                {exactWords(v.uploaded_at)}
                {v.uploaded_by_name ? ` by ${v.uploaded_by_name}` : ''}
                {/* Where it came from, when somebody outside sent it (5.23). */}
                {v.sent_through ? ` · ${v.sent_through}` : ''}
              </span>
              {v.file_removed && <span className="muted">{FILE_REMOVED}</span>}
            </span>
            {i > 0 && (
              <span className="history-actions">
                {props.viewing === v.id ? (
                  <span className="muted history-shown">Shown</span>
                ) : (
                  <Button
                    kind="quiet"
                    ariaLabel={`View version ${v.version_no}`}
                    onClick={() => props.onView(v)}
                  >
                    View
                  </Button>
                )}
                {!v.file_removed && (
                  <Button
                    kind="quiet"
                    ariaLabel={`Download version ${v.version_no}`}
                    onClick={() => props.onDownload(v)}
                  >
                    Download
                  </Button>
                )}
              </span>
            )}
            {i === 0 && props.viewing !== null && (
              <Button
                kind="quiet"
                ariaLabel="View the current version"
                onClick={() => props.onView(null)}
              >
                View
              </Button>
            )}
          </li>
        ))}
      </ul>
      {onAdd && (
        <label
          ref={ref}
          className="btn btn-quiet"
          style={{ display: 'inline-flex', alignItems: 'center' }}
        >
          Add a new version
          <input
            type="file"
            accept={`image/*,application/pdf,.docx,.xlsx,${RECORD_ACCEPT}`}
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              // Cleared, so the same file chosen again is a retry, not nothing.
              e.target.value = '';
              onAdd(file);
            }}
          />
        </label>
      )}
    </section>
  );
}

/**
 * A yearly review (0.9.0, H3): a reminder that comes back every year to read
 * the paper again — its wishes, its agent, who it lets see what. Off until
 * somebody turns it on; on, it is one of the family's reminders like any
 * other (Home, Attention, the digest), first on the next anniversary of the
 * day it was signed, else a year from today, and Done brings the next one a
 * year on. Off removes it. The vault never says what to change.
 */
function YearlyReview(props: {
  documentId: string;
  signed: string | null;
  offered: boolean;
  /** Its box's id; its next date's, the same and `-next`. */
  idBase: string;
}) {
  const { withToken, authVersion } = useApp();
  // Its own reminders: an older vault answers them all, so asked again here.
  const { data, error, reload } = useLoad(
    async (t) => ({
      review:
        (await api.reminders(t, 'all', props.documentId)).items.find(
          (r) => r.document_id === props.documentId && r.review === true,
        ) ?? null,
    }),
    [props.documentId, authVersion],
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const review = data?.review ?? null;
  const turn = async (want: boolean) => {
    setBusy(true);
    setProblem(null);
    try {
      await withToken<unknown>((t) =>
        want
          ? api.createReminder(t, {
              document_id: props.documentId,
              fire_at: firstReview(props.signed, localToday(familyZoneNow())),
              review: true,
            })
          : review
            ? api.deleteReminder(t, review.id)
            : Promise.resolve(),
      );
      await reload();
    } catch (err) {
      setProblem(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  // Shown on the kinds it is for, and wherever one is on (a paper moved to
  // another kind since): there it can be turned off.
  if (!props.offered && review === null) return null;
  return (
    <div className="yearly-review stack">
      <ErrorNote message={error ?? problem} />
      <div className="check">
        <input
          id={props.idBase}
          type="checkbox"
          checked={review !== null}
          disabled={busy || data === null}
          aria-describedby={review ? `${props.idBase}-next` : undefined}
          onChange={(e) => void turn(e.currentTarget.checked)}
        />
        <label htmlFor={props.idBase}>{REVIEW_LABEL}</label>
      </div>
      {review && (
        <span id={`${props.idBase}-next`} className="muted">
          Next review: {formatDate({ date: review.fire_at, precision: 'day' })}
        </span>
      )}
    </div>
  );
}

/**
 * The collections this document is in, of those the reader may see, and "Add to
 * a collection" (5.15). A collection the reader may not see is not mentioned at all.
 */
export function DocumentCollections(props: {
  /** Its heading's id: `doc-collections-h` unless said. */
  headingId?: string;
  documentId: string;
  title: string;
  /** Told how many it is in, as that changes (the action row). */
  onCount?: (n: number) => void;
}) {
  const { authVersion } = useApp();
  const named = useNamedWithin();
  const { data, error, reload } = useLoad(
    async (t) => (await api.documentCollections(t, props.documentId)).items,
    [props.documentId, authVersion],
  );
  const { onCount } = props;
  const count = data ? data.length : null;
  useEffect(() => {
    if (count !== null) onCount?.(count);
  }, [count, onCount]);
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
    <section aria-labelledby={named(props.headingId ?? 'doc-collections-h')}>
      <h2 id={props.headingId ?? 'doc-collections-h'} className="section-h">
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
  // A health record kept as it is (0.9.0, H5): no thumbnail, no pages.
  const asIs = latest?.stored_as_is === true || isRecordFormat(latest?.mime);
  useEffect(() => {
    let url: string | null = null;
    // Gone before it came (moved on, or the vault locked, 0.9.0-dev.86): no
    // object URL is made for a view that is not there to let it go.
    let live = true;
    // Nothing to draw a thumbnail from: its file was removed for good (5.24),
    // or it is a health record kept as it is (H5).
    if (!latest || latest.file_removed || asIs) return;
    void withToken((t) => api.thumbnail(t, latest.id))
      .then((blob) => {
        if (blob && live) {
          url = URL.createObjectURL(blob);
          setThumb(url);
        }
      })
      .catch(() => {
        if (live) setThumb(null);
      });
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [latest, withToken, asIs]);

  return (
    <section className="doc-pages" aria-label={`Pages of ${props.title}`}>
      {latest?.file_removed ? (
        // Its record came back with a restore, its file did not (5.24).
        <div className="preview preview-removed" role="note" aria-label="Preview">
          <span className="muted">{FILE_REMOVED}</span>
        </div>
      ) : latest && asIs ? (
        // No preview (H5): it is downloaded, never shown.
        <div className="preview preview-as-is" role="note" aria-label="Preview">
          <span className="muted">{recordNoPreviewWords(latest.mime)}</span>
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
export function DocumentPages(props: {
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
      : // A health record kept as it is (0.9.0, H5): never drawn.
        version.stored_as_is === true || isRecordFormat(version.mime)
        ? recordNoPreviewWords(version.mime)
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
      fitPage
      beyond={none === null ? 'Download it to see the original.' : undefined}
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
