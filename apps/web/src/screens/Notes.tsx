import {
  can,
  NOTE_KIND,
  NOTES_MAX,
  noteFirstWords,
  SENSITIVE_LABEL,
  SENSITIVE_MEANS,
  type DocumentView,
  type NoteSummary,
  type Visibility,
} from '@fdv/shared';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate, useParams } from 'react-router';
import { api, ApiRequestError } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { collectionsOffered } from '../collections.js';
import { mayChange } from '../DocActions.js';
import {
  ESSENTIAL_NOTE_MEANS,
  keepWords,
  NOTE_ASKS,
  NoteText,
  NotesSection,
  ONLY_ME_TITLE,
  secretNoteWarning,
} from '../notes.js';
import { PrintOut, SensitivePrintNotice } from '../print.js';
import { release, useLeaveGuard } from '../leave-guard.js';
import { RichTextEditor } from '../rich-text.js';
import { storedRole } from '../session.js';
import { useShellMode } from '../shell.js';
import { Splitter, useKeptWidth, type WidthBounds } from '../splitter.js';
import { TagSection } from '../tags.js';
import { Button, ErrorNote, MoveToTrashDialog, Pills, Switch, TopBar } from '../ui.js';
import { ActionIcon, ActionRow, countBadge } from '../action-row.js';
import { DocumentCollections } from './Document.js';
import { SharePanel } from './Share.js';
import { mayChangeWhoSees, VisibilityControl } from './Visibility.js';
import { dayWordsOf, exactWords, familyZoneNow } from '../family-time.js';

/**
 * Notes (0.9.0, N1, the owner's request of 18 Oct 2026): what the family
 * knows and keeps nowhere else — where things are, how they work, who to
 * call — and a safer way than an email to send some of it outside the
 * family. A note is a document with no file (0078): it is seen, shared,
 * tagged, collected, found, exported and put in the Trash as any document
 * is; this is where it is written and read.
 *
 * From 768 px a list of the notes beside the one that is open, the list as
 * wide as it is dragged (or moved with the arrow keys), remembered for
 * each person on this browser; on a phone, the list, then the note on its
 * own, and back. A note opens to read; Edit writes it in the one editor,
 * Save or Cancel ends that, and leaving with anything unsaved is asked
 * about first.
 */

/** What a note is for, said where there are none yet. */
export const NOTES_FOR =
  'Notes keep what the family knows: where things are, how things work, who to call. Share one with somebody outside the family more safely than by email.';
/** And what a note is not for: as the tags' field says it. */
export const NOTES_NOT_FOR =
  'A note is not a password manager: keep passwords and PINs in one, or at the very least in an Only me note.';

/** The list's width, in pixels: as it starts, and how narrow or wide it may be dragged. */
const LIST_WIDTH: WidthBounds = { start: 320, min: 240, max: 560, step: 16 };

const widthKey = (memberId: string | null) => `fdv.notes.list-width.${memberId ?? 'nobody'}`;

const visibilityWords: Record<Visibility, string> = {
  household: 'Everyone in the family',
  adults: 'Adults only',
  private: 'Only me',
};

/** "3 Oct", or "3 Oct 2025" for another year. */
function shortDate(iso: string): string {
  return dayWordsOf(iso, familyZoneNow(), { month: 'short', year: 'other' });
}

/** A note's name: its title, or its first words, or "Untitled note". */
export function noteTitle(title: string | null | undefined, words?: string | null): string {
  return title?.trim() || noteFirstWords(words) || 'Untitled note';
}

export function NotesScreen() {
  const { id } = useParams<{ id?: string }>();
  const { pathname } = useLocation();
  const creating = pathname === '/notes/new';
  const { authVersion, session } = useApp();
  const memberId = session.info?.member_id ?? null;
  const role = session.info?.role ?? storedRole();
  const phone = useShellMode() === 'phone';
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  const [listed, setListed] = useState(0);
  const [dirty, setDirty] = useState(false);
  const guard = useLeaveGuard(dirty);

  // Typing settles before the vault is asked.
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(typed.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [typed]);

  const { data, error, reload } = useLoad(
    async (t) => api.notes(t, query ? { q: query } : {}),
    [authVersion, query, listed],
  );
  const changed = useCallback(() => setListed((n) => n + 1), []);

  // The list's width: as this person left it here.
  const [width, setWidth, keepWidth] = useKeptWidth(widthKey(memberId), LIST_WIDTH);

  const mayAdd = can(role, 'document.add');
  const showList = !phone || (!id && !creating);
  const showPane = !phone || Boolean(id) || creating;

  const list = (
    <NotesList
      items={data?.items ?? null}
      error={error}
      typed={typed}
      query={query}
      onType={setTyped}
      selected={id ?? null}
      mayAdd={mayAdd}
      onRetry={() => void reload()}
    />
  );
  const pane = creating ? (
    <NewNote key="new" onMade={changed} onDirty={setDirty} />
  ) : id ? (
    <NotePane
      key={id}
      id={id}
      phone={phone}
      summary={data?.items.find((n) => n.id === id) ?? null}
      onChanged={changed}
      onDirty={setDirty}
    />
  ) : (
    <div className="notes-none">
      <p className="muted">
        {data && data.items.length === 0 && !query
          ? 'No notes yet.'
          : 'Choose a note to read it here.'}
      </p>
    </div>
  );

  return (
    <main className="page page-top page-wide has-nav notes-page">
      <TopBar
        title={phone && (id || creating) ? (creating ? 'New note' : 'Note') : 'Notes'}
        {...(phone && (id || creating) ? { back: '/notes', backLabel: 'All notes' } : {})}
      />
      {phone ? (
        <>
          {showList && list}
          {showPane && pane}
        </>
      ) : (
        <div
          className="notes-split"
          style={{ gridTemplateColumns: `${width}px 12px minmax(0, 1fr)` }}
        >
          {list}
          <Splitter
            className="notes-resizer"
            label="Width of the list of notes"
            controls="notes-list"
            width={width}
            bounds={LIST_WIDTH}
            onWidth={setWidth}
            onDone={keepWidth}
          />
          {pane}
        </div>
      )}
      {guard}
    </main>
  );
}

function NotesList(props: {
  items: NoteSummary[] | null;
  error: string | null;
  typed: string;
  query: string;
  onType: (q: string) => void;
  selected: string | null;
  mayAdd: boolean;
  onRetry: () => void;
}) {
  const searchId = useId();
  const items = props.items;
  const none = items !== null && items.length === 0;
  return (
    <section id="notes-list" className="notes-list" aria-labelledby="notes-list-h">
      <h2 id="notes-list-h" className="visually-hidden">
        All notes
      </h2>
      <div className="notes-list-tools">
        <div className="notes-find" role="search" aria-label="Notes">
          <label htmlFor={searchId} className="visually-hidden">
            Find in notes
          </label>
          <input
            id={searchId}
            type="search"
            placeholder="Find in notes"
            value={props.typed}
            autoComplete="off"
            onChange={(e) => props.onType(e.target.value)}
          />
        </div>
        {props.mayAdd && (
          <Link to="/notes/new" className="btn btn-primary btn-small notes-new">
            New note
          </Link>
        )}
      </div>
      <ErrorNote message={props.error} />
      {props.error && (
        <Button kind="quiet" onClick={props.onRetry}>
          Try again
        </Button>
      )}
      {none && !props.query && (
        <div className="notes-empty">
          <p>{NOTES_FOR}</p>
          <p className="muted">{NOTES_NOT_FOR}</p>
        </div>
      )}
      {none && props.query && (
        <p className="muted" role="status">
          No note has “{props.query}” in it.
        </p>
      )}
      {items && items.length > 0 && (
        <ul className="notes-items" aria-label="Notes">
          {items.map((n) => (
            <li key={n.id}>
              <NavLink
                to={`/notes/${n.id}`}
                className="notes-item"
                aria-current={props.selected === n.id ? 'page' : undefined}
              >
                <span className="notes-item-top">
                  <span className="notes-item-title">{noteTitle(n.title, n.preview)}</span>
                  <span className="notes-item-when muted">
                    <span className="visually-hidden">, changed </span>
                    {shortDate(n.updated_at)}
                  </span>
                </span>
                {/* An Only me or an Essential note: its title and date alone, its
                    words only once it is confirmed to be you (0.9.0-dev.87). */}
                {!n.confirm_to_read && (
                  <span className="notes-item-preview muted">
                    {n.preview || 'Nothing written in it yet.'}
                  </span>
                )}
                {(n.visibility !== 'household' || n.is_essential === true) && (
                  <span className="notes-item-who">
                    {[
                      n.visibility !== 'household' ? visibilityWords[n.visibility] : null,
                      n.is_essential === true ? 'Essential' : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * What a note's details say under its title: who sees it, whether it is
 * Essential or Sensitive — for anybody who reads it.
 */
function noteMeta(
  doc: Pick<NoteSummary, 'visibility'> & { is_essential?: boolean | undefined },
  sensitive: boolean,
): string {
  return [
    visibilityWords[doc.visibility],
    doc.is_essential === true ? 'Essential' : null,
    sensitive ? SENSITIVE_LABEL : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** A note's words, as a file of their own: Markdown, which any editor opens. */
function downloadNote(doc: DocumentView) {
  const title = noteTitle(doc.title, doc.notes);
  const text = `# ${title}\n\n${doc.notes ?? ''}\n`;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${
    title
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .trim()
      .slice(0, 80) || 'Note'
  }.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The note that is open: read, written, and its own controls. */
function NotePane(props: {
  id: string;
  phone: boolean;
  /** As the list gives it: its title and date, while its words wait to be confirmed. */
  summary: NoteSummary | null;
  onChanged: () => void;
  onDirty: (dirty: boolean) => void;
}) {
  const { authVersion, session, withToken, guarded, caps } = useApp();
  const navigate = useNavigate();
  // A note made just now (0.9.0-dev.87): opened with the words in hand, its
  // maker never asked to confirm it's them for what they have just written.
  const { state: carried } = useLocation() as { state: { made?: DocumentView } | null };
  const made = carried?.made?.id === props.id ? carried.made : null;
  const confirmButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const trashButton = useRef<HTMLButtonElement>(null);
  const [trashing, setTrashing] = useState(false);
  const [editSlot, setEditSlot] = useState<HTMLElement | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Printed (0.9.0): its title, who sees it and when it changed, and its
  // words; a Sensitive one asked about first (the owner's choice of 24 Nov 2026).
  const [printing, setPrinting] = useState<'ask' | 'print' | null>(null);
  const printButton = useRef<HTMLButtonElement>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Essential being turned on or off, and what it came to.
  const [toggling, setToggling] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  // The row's counts, as its sections say them; and which of them is busy.
  const [counts, setCounts] = useState<{ collections?: number; links?: number }>({});
  const [busy, setBusy] = useState<{ visibility?: boolean; share?: boolean }>({});
  const onCollections = useCallback(
    (n: number) => setCounts((c) => ({ ...c, collections: n })),
    [],
  );
  const onLinks = useCallback((n: number) => setCounts((c) => ({ ...c, links: n })), []);
  // An Only me or an Essential note asks to confirm it's you before its
  // words are shown (0.9.0-dev.87), as opening such a document's file does.
  const { data, error, reload, setData, declined } = useLoad(
    async (t) => {
      const [doc, profile] = await Promise.all([
        api.document(t, props.id),
        api.profile(t).catch(() => null),
      ]);
      return { doc, timezone: profile?.timezone ?? null };
    },
    [props.id, authVersion],
    { guarded: true, initial: made ? { doc: made, timezone: null } : null },
  );

  // A note chosen: its name takes the focus, so it is said.
  const shownId = data?.doc.id;
  useEffect(() => {
    if (shownId) heading.current?.focus({ preventScroll: true });
  }, [shownId]);
  // Waiting to be confirmed: the way on takes the focus (0.9.0-dev.87).
  const waiting = !data && declined;
  useEffect(() => {
    if (waiting) confirmButton.current?.focus();
  }, [waiting]);

  if (error) {
    return (
      <section className="note-pane" aria-label="Note">
        <ErrorNote message={error} />
      </section>
    );
  }
  if (!data && declined) {
    // Its title and date as the list gives them, and the way on, focused.
    const s = props.summary;
    return (
      <article className="note-pane stack" aria-labelledby={titleId}>
        <header className="note-pane-head">
          <div className="note-pane-heading">
            <h2 id={titleId} className="note-pane-title">
              {s ? noteTitle(s.title, s.preview) : 'Note'}
            </h2>
            {s && (
              <p className="muted note-pane-meta">
                {noteMeta(s, s.sensitive_effective === true)} · changed{' '}
                {exactWords(s.notes_updated_at ?? s.updated_at)}
              </p>
            )}
          </div>
        </header>
        <p>{NOTE_ASKS}</p>
        <div className="row">
          <Button ref={confirmButton} onClick={() => void reload()}>
            Confirm it’s you
          </Button>
        </div>
      </article>
    );
  }
  if (!data) {
    return (
      <section className="note-pane" aria-label="Note">
        <p className="muted">Opening the note…</p>
      </section>
    );
  }
  const { doc } = data;
  if (doc.type_key !== NOTE_KIND) {
    return (
      <section className="note-pane" aria-label="Note">
        <p>
          This is a document, not a note.{' '}
          <Link to={`/documents/${doc.id}`}>Open “{doc.title ?? 'it'}” with the documents</Link>.
        </p>
      </section>
    );
  }
  const memberId = session.info?.member_id ?? null;
  const role = session.info?.role ?? storedRole();
  const mayEdit = mayChange(role, memberId, doc);
  const isMine = doc.owner_member_id !== null && doc.owner_member_id === memberId;
  const filedByMe = doc.filed_by_me === true;
  const title = noteTitle(doc.title, doc.notes);
  const sensitiveOffered = caps?.features.sensitive_documents === true;
  const sensitive = doc.sensitive_effective === true;
  // An answer that withholds its words keeps those in hand (0.9.0-dev.87).
  const saved = (next: DocumentView) => {
    setData((d) => (d ? { ...d, doc: keepWords(d.doc, next) } : d));
    props.onChanged();
  };

  // Make it Essential, or Stop it being Essential (the owner's request of
  // 24 Nov 2026): as a document's ⋯ does, with the ETag of the note as it
  // was loaded. Turning it off takes away the question opening it asks, so
  // the vault may ask to confirm it's you first.
  const toggleEssential = async () => {
    if (toggling) return;
    const next = !doc.is_essential;
    setToggling(true);
    setActionError(null);
    setSaid(null);
    try {
      const result = await guarded((t) =>
        api.updateDocument(t, doc.id, { is_essential: next }, doc.etag),
      );
      if (!result) return;
      saved(result);
      setSaid(next ? 'This note is Essential now.' : 'This note is not Essential any more.');
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409) {
        setActionError(
          'This note was changed somewhere else, so it has been loaded again. Try again if it still needs changing.',
        );
        void reload();
        return;
      }
      setActionError(describeError(err));
    } finally {
      setToggling(false);
    }
  };

  const remove = async () => {
    setTrashing(true);
    try {
      await withToken((t) => api.deleteDocument(t, doc.id));
      props.onChanged();
      // The guard's entry off first: replacing it would leave this note's
      // page on the history to come back to (the N1 re-check).
      await release();
      void navigate('/notes', { replace: true });
    } catch (err) {
      setConfirming(false);
      setActionError(describeError(err));
    } finally {
      setTrashing(false);
    }
  };

  return (
    <article className="note-pane" aria-labelledby={titleId}>
      <header className="note-pane-head">
        <div className="note-pane-heading">
          <h2 id={titleId} ref={heading} tabIndex={-1} className="note-pane-title">
            {title}
          </h2>
          <p className="muted note-pane-meta">
            {noteMeta(doc, sensitive)} · changed{' '}
            {exactWords(doc.notes_updated_at ?? doc.updated_at, data.timezone ?? undefined)}
          </p>
        </div>
        {/* The note's Edit, on the title's line (NotesSection puts it here). */}
        <div className="note-pane-edit" ref={setEditSlot} />
      </header>
      <NotesSection
        key={doc.id}
        variant="note"
        labelledBy={titleId}
        doc={doc}
        label="Note"
        mayEdit={mayEdit}
        timezone={data.timezone}
        onSaved={saved}
        onRefreshed={(now) => setData((d) => (d ? { ...d, doc: keepWords(d.doc, now) } : d))}
        onConfirm={() => void reload()}
        onDirty={props.onDirty}
        editSlot={editSlot}
        sensitiveOffered={sensitiveOffered && mayEdit}
      />
      {/* Under the note, one row: Download, Print, a button for each
          section, and the Trash at the end (the owner's request of 24 Oct 2026). */}
      <ActionRow
        kind="note"
        memberId={memberId}
        onDownload={() => downloadNote(doc)}
        onPrint={() => setPrinting(sensitive ? 'ask' : 'print')}
        printRef={printButton}
        essential={
          mayEdit
            ? { on: doc.is_essential, busy: toggling, onToggle: () => void toggleEssential() }
            : null
        }
        onTrash={mayEdit ? () => setConfirming(true) : null}
        trashRef={trashButton}
        error={
          <>
            <ErrorNote message={actionError} />
            <p className="muted" role="status">
              {said}
            </p>
          </>
        }
        sections={[
          ...(mayChangeWhoSees({ current: doc.visibility, isMine, filedByMe })
            ? [
                {
                  key: 'visibility' as const,
                  // Its words without its value: the details say that.
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
                      note
                      onChanged={async () => {
                        await reload();
                        props.onChanged();
                      }}
                      onClose={done}
                      onBusy={(on) => setBusy((b) => ({ ...b, visibility: on }))}
                    />
                  ),
                },
              ]
            : []),
          ...(doc.tags.length > 0 || mayEdit
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
                      mayEdit={mayEdit}
                      onSaved={saved}
                    />
                  ),
                },
              ]
            : []),
          ...(collectionsOffered(caps, role)
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
                      documentId={doc.id}
                      title={title}
                      onCount={onCollections}
                    />
                  ),
                },
              ]
            : []),
          ...(can(role, 'document.share')
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
                      note
                      onClose={done}
                      onBusy={(on) => setBusy((b) => ({ ...b, share: on }))}
                      onCount={onLinks}
                    />
                  ),
                },
              ]
            : []),
        ]}
      />
      {printing === 'ask' && (
        <SensitivePrintNotice
          returnFocus={printButton}
          onPrint={() => setPrinting('print')}
          onCancel={() => setPrinting(null)}
        />
      )}
      {printing === 'print' && (
        <PrintOut
          title={title}
          about={
            <p className="print-about">
              Note · {visibilityWords[doc.visibility]}
              {sensitive ? ` · ${SENSITIVE_LABEL}` : ''} · changed{' '}
              {exactWords(doc.notes_updated_at ?? doc.updated_at, data.timezone ?? undefined)}
            </p>
          }
          onDone={() => setPrinting(null)}
        >
          <div className="print-note">
            {doc.notes ? (
              <NoteText source={doc.notes} headingLevel={2} />
            ) : (
              <p>This note has no words yet.</p>
            )}
          </div>
        </PrintOut>
      )}
      {confirming && (
        <MoveToTrashDialog
          title={title}
          busy={trashing}
          returnFocus={trashButton}
          onConfirm={() => void remove()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </article>
  );
}

/** A new note: its title, who can see it, and its words; nothing is kept until Save. */
function NewNote(props: { onMade: () => void; onDirty: (dirty: boolean) => void }) {
  const { withToken, session, caps } = useApp();
  // Essential and Sensitive from the start (0.9.0-dev.87), as a document's.
  const [essential, setEssential] = useState(false);
  const [sensitive, setSensitive] = useState(false);
  const sensitiveOffered = caps?.features.sensitive_documents === true;
  const navigate = useNavigate();
  const id = useId();
  const role = session.info?.role ?? storedRole();
  const memberId = session.info?.member_id ?? null;
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('household');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = title.trim() !== '' || text.trim() !== '';
  const { onDirty } = props;
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  useEffect(() => {
    if (!dirty) return;
    const ask = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [dirty]);

  // Adults only is for whoever sees adults' documents: never a teen's to choose.
  const choices: Visibility[] = can(role, 'document.see_adults')
    ? ['household', 'adults', 'private']
    : ['household', 'private'];
  const tooLong = text.length > NOTES_MAX;
  const secret = secretNoteWarning(text, visibility);

  const save = async () => {
    if (busy || tooLong) return;
    setBusy(true);
    setError(null);
    try {
      const made = await withToken((t) =>
        api.createDocument(t, {
          type_key: NOTE_KIND,
          // A note's title is only ever what was typed (the N1 review and
          // re-check): nothing of its words is copied into it — they may be
          // sealed now or later — and its name is worked out from them as
          // it is read.
          title: title.trim() || null,
          notes: text.trim() || null,
          visibility,
          owner_member_id: memberId,
          ...(essential ? { is_essential: true } : {}),
          ...(sensitiveOffered && sensitive ? { sensitive: true } : {}),
        }),
      );
      if (!made) return;
      // The guard's entry off first, then New note replaced by the note:
      // Back never finds an empty New note (the N1 re-check).
      await release();
      onDirty(false);
      props.onMade();
      // Opened with what was just written, never asked for it again.
      void navigate(`/notes/${made.id}`, { replace: true, state: { made } });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="note-pane" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="note-pane-title">
        New note
      </h2>
      <div className="field">
        <label htmlFor={`${id}-title`}>Title</label>
        <input
          id={`${id}-title`}
          type="text"
          value={title}
          maxLength={200}
          autoComplete="off"
          autoFocus
          aria-describedby={visibility === 'private' ? `${id}-title-note` : undefined}
          onChange={(e) => setTitle(e.target.value)}
        />
        {visibility === 'private' && (
          <span id={`${id}-title-note`} className="muted field-note">
            {ONLY_ME_TITLE}
          </span>
        )}
      </div>
      <Pills
        label="Visibility"
        value={visibility}
        options={choices.map((v) => ({ value: v, label: visibilityWords[v] }))}
        onChange={setVisibility}
      />
      <Switch
        id={`${id}-essential`}
        label="Essential"
        checked={essential}
        onChange={setEssential}
      />
      <p className="muted">{ESSENTIAL_NOTE_MEANS}</p>
      {sensitiveOffered && (
        <>
          <Switch
            id={`${id}-sensitive`}
            label={SENSITIVE_LABEL}
            checked={sensitive}
            onChange={setSensitive}
          />
          <p className="muted">{SENSITIVE_MEANS}</p>
        </>
      )}
      <RichTextEditor
        label="Note"
        initial=""
        describedBy={`${id}-not-for${secret ? ` ${id}-secret` : ''}`}
        onChange={setText}
      />
      <p id={`${id}-not-for`} className="muted note-count">
        {tooLong
          ? `Too long to save: ${new Intl.NumberFormat('en-GB').format(text.length)} characters.`
          : NOTES_NOT_FOR}
      </p>
      {secret && (
        <p id={`${id}-secret`} className="note-secret" role="status">
          {secret}
        </p>
      )}
      <ErrorNote message={error} />
      <div className="row">
        <Button onClick={() => void save()} disabled={busy || tooLong}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Link to="/notes" className="btn btn-quiet">
          Cancel
        </Link>
      </div>
    </section>
  );
}
