import {
  can,
  NOTE_KIND,
  NOTES_MAX,
  noteFirstWords,
  type DocumentView,
  type NoteSummary,
  type Visibility,
} from '@fdv/shared';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { Link, NavLink, useLocation, useNavigate, useParams } from 'react-router';
import { api } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { collectionsOffered } from '../collections.js';
import { mayChange } from '../DocActions.js';
import { NotesSection, ONLY_ME_TITLE, secretNoteWarning } from '../notes.js';
import { release, useLeaveGuard } from '../leave-guard.js';
import { RichTextEditor } from '../rich-text.js';
import { storedRole } from '../session.js';
import { useShellMode } from '../shell.js';
import { TagSection } from '../tags.js';
import { Button, ErrorNote, MoveToTrashDialog, Pills, TopBar, TrashIcon } from '../ui.js';
import { DocumentCollections } from './Document.js';
import { SharePanel } from './Share.js';
import { VisibilityControl } from './Visibility.js';
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
const LIST_WIDTH = { start: 320, min: 240, max: 560, step: 16 };

const widthKey = (memberId: string | null) => `fdv.notes.list-width.${memberId ?? 'nobody'}`;

function keptWidth(memberId: string | null): number {
  try {
    const n = Number(window.localStorage.getItem(widthKey(memberId)));
    return Number.isFinite(n) && n >= LIST_WIDTH.min && n <= LIST_WIDTH.max ? n : LIST_WIDTH.start;
  } catch {
    return LIST_WIDTH.start;
  }
}

function keepWidth(memberId: string | null, width: number): void {
  try {
    window.localStorage.setItem(widthKey(memberId), String(Math.round(width)));
  } catch {
    // Blocked, or full: the width is this visit's alone.
  }
}

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
  const [held, setHeld] = useState(() => ({ who: memberId, w: keptWidth(memberId) }));
  const width = held.who === memberId ? held.w : keptWidth(memberId);
  const setWidth = (w: number) => setHeld({ who: memberId, w });

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
    <NotePane key={id} id={id} phone={phone} onChanged={changed} onDirty={setDirty} />
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
          <Resizer width={width} onWidth={setWidth} onDone={(w) => keepWidth(memberId, w)} />
          {pane}
        </div>
      )}
      {guard}
    </main>
  );
}

/**
 * Between the list and the note: dragged, or moved with the arrow keys
 * (16 px a press), Home and End — a window splitter, as ARIA has one.
 */
function Resizer(props: {
  width: number;
  onWidth: (w: number) => void;
  onDone: (w: number) => void;
}) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  const clamp = (w: number) => Math.min(LIST_WIDTH.max, Math.max(LIST_WIDTH.min, w));
  const set = (w: number) => {
    const next = clamp(w);
    props.onWidth(next);
    props.onDone(next);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? LIST_WIDTH.step * 4 : LIST_WIDTH.step;
    const to =
      e.key === 'ArrowLeft'
        ? props.width - step
        : e.key === 'ArrowRight'
          ? props.width + step
          : e.key === 'Home'
            ? LIST_WIDTH.min
            : e.key === 'End'
              ? LIST_WIDTH.max
              : null;
    if (to === null) return;
    e.preventDefault();
    set(to);
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = { x: e.clientX, w: props.width };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    props.onWidth(clamp(drag.current.w + e.clientX - drag.current.x));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const w = clamp(drag.current.w + e.clientX - drag.current.x);
    drag.current = null;
    set(w);
  };
  return (
    <div
      className="notes-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Width of the list of notes"
      aria-controls="notes-list"
      aria-valuenow={props.width}
      aria-valuemin={LIST_WIDTH.min}
      aria-valuemax={LIST_WIDTH.max}
      aria-valuetext={`${props.width} pixels wide`}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
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
                <span className="notes-item-preview muted">
                  {n.preview || 'Nothing written in it yet.'}
                </span>
                {n.visibility !== 'household' && (
                  <span className="notes-item-who">{visibilityWords[n.visibility]}</span>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
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
  onChanged: () => void;
  onDirty: (dirty: boolean) => void;
}) {
  const { authVersion, session, withToken, caps } = useApp();
  const navigate = useNavigate();
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const trashButton = useRef<HTMLButtonElement>(null);
  const [trashing, setTrashing] = useState(false);
  const [editSlot, setEditSlot] = useState<HTMLElement | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const { data, error, reload, setData } = useLoad(
    async (t) => {
      const [doc, profile] = await Promise.all([
        api.document(t, props.id),
        api.profile(t).catch(() => null),
      ]);
      return { doc, timezone: profile?.timezone ?? null };
    },
    [props.id, authVersion],
  );

  // A note chosen: its name takes the focus, so it is said.
  const shownId = data?.doc.id;
  useEffect(() => {
    if (shownId) heading.current?.focus({ preventScroll: true });
  }, [shownId]);

  if (error) {
    return (
      <section className="note-pane" aria-label="Note">
        <ErrorNote message={error} />
      </section>
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
  const title = noteTitle(doc.title, doc.notes);
  const saved = (next: DocumentView) => {
    setData((d) => (d ? { ...d, doc: next } : d));
    props.onChanged();
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
            {visibilityWords[doc.visibility]} · changed{' '}
            {exactWords(doc.notes_updated_at ?? doc.updated_at, data.timezone ?? undefined)}
          </p>
        </div>
        {/* The note's Edit, on the title's line (NotesSection puts it here). */}
        <div className="note-pane-edit" ref={setEditSlot} />
      </header>
      <ErrorNote message={actionError} />
      <NotesSection
        key={doc.id}
        variant="note"
        labelledBy={titleId}
        doc={doc}
        label="Note"
        mayEdit={mayEdit}
        timezone={data.timezone}
        onSaved={saved}
        onRefreshed={(now) => setData((d) => (d ? { ...d, doc: now } : d))}
        onDirty={props.onDirty}
        editSlot={editSlot}
      />
      <div className="row note-pane-actions">
        <Button kind="quiet" onClick={() => downloadNote(doc)}>
          Download as a file
        </Button>
        {mayEdit && (
          <button
            ref={trashButton}
            type="button"
            className="btn btn-link btn-trash"
            onClick={() => setConfirming(true)}
          >
            <TrashIcon />
            Move to the Trash
          </button>
        )}
      </div>
      <VisibilityControl
        documentId={doc.id}
        current={doc.visibility}
        isMine={doc.owner_member_id !== null && doc.owner_member_id === memberId}
        filedByMe={doc.filed_by_me === true}
        note
        onChanged={async () => {
          await reload();
          props.onChanged();
        }}
      />
      <TagSection key={`tags-${doc.id}`} doc={doc} mayEdit={mayEdit} onSaved={saved} />
      {collectionsOffered(caps, role) && <DocumentCollections documentId={doc.id} title={title} />}
      <SharePanel
        documentId={doc.id}
        documentTitle={doc.title}
        onlyMe={doc.visibility === 'private'}
        note
      />
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
  const { withToken, session } = useApp();
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
        }),
      );
      if (!made) return;
      // The guard's entry off first, then New note replaced by the note:
      // Back never finds an empty New note (the N1 re-check).
      await release();
      onDirty(false);
      props.onMade();
      void navigate(`/notes/${made.id}`, { replace: true });
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
        label="Who can see it"
        value={visibility}
        options={choices.map((v) => ({ value: v, label: visibilityWords[v] }))}
        onChange={setVisibility}
      />
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
