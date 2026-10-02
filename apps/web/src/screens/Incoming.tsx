import {
  can,
  effectiveVisibility,
  incomingFileName,
  NOT_SCANNED,
  whenExactly,
  type DocumentTypeView,
  type DocumentView,
  type IncomingFileView,
  type Member,
  type Visibility,
} from '@fdv/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { api, ApiRequestError } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { storedRole } from '../session.js';
import { BottomNav, Button, ConfirmDialog, ErrorNote, Field, Select, TopBar } from '../ui.js';

/**
 * Incoming (5.23): what somebody outside the family sent through a request,
 * waiting for whoever reviews it to look at it — the pages the vault drew,
 * or a copy — and then file it, as a new document or a new version of one,
 * or refuse it. Nothing here is a document until it is filed: no list,
 * search or reminder has it. The vault scans nothing for viruses (A42), and
 * says so beside every file.
 *
 * For the owners and adults who review what came in; the vault keeps a
 * request somebody reviews alone to them alone, so this shows what it is
 * given.
 */

/** "120 KB", "2.4 MB": a size as people say it. */
function sizeWords(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** "1 November": the day it is removed. */
const dayWords = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });

/** Whom from, and for what: "From Jane, accountant, for “Your tax papers” — W-2". */
function fromWords(f: IncomingFileView): string {
  const who = f.recipient_label ? `From ${f.recipient_label}` : 'Sent through a request';
  return `${who}, for “${f.request_title}”${f.item_label ? ` — ${f.item_label}` : ''}`;
}

/** Said beside every file the vault has not scanned: here, every one (A42). */
export function NotScanned({ id }: { id?: string }) {
  return (
    <span className="status status-warn" id={id}>
      {NOT_SCANNED}
    </span>
  );
}

export function IncomingScreen() {
  const { authVersion } = useApp();
  const location = useLocation();
  const said = (location.state as { said?: string } | null)?.said ?? null;
  const mayReview = can(storedRole(), 'upload_request.create');
  const { data, error } = useLoad(
    async (t) => (mayReview ? (await api.incoming(t)).items : []),
    [authVersion, mayReview],
  );
  const status = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (said) status.current?.focus();
  }, [said]);

  return (
    <main className="page page-top has-nav">
      <TopBar title="Files sent to you" back="/settings" />
      <ErrorNote message={error} />
      <p role="status" ref={status} tabIndex={-1} className="status-line">
        {said}
      </p>
      <p className="muted">
        What somebody outside the family sent through a request. None of it is a document yet: look
        at each, then file it or refuse it. Anything not filed within 30 days is removed.
      </p>
      <ul className="list" aria-label="Waiting for you">
        {(data ?? []).map((f) => (
          <li key={f.id}>
            <Link to={`/incoming/${f.id}`} className="rowbtn">
              <span className="doc-title">{f.name}</span>
              <span className="muted">{fromWords(f)}</span>
              <span className="muted">
                {sizeWords(f.byte_size)} · sent {whenExactly(f.sent_at)} · removed on{' '}
                {dayWords(f.removed_at)} unless you file it
              </span>
              {f.scan_state !== 'clean' && <NotScanned />}
            </Link>
          </li>
        ))}
        {data !== null && !error && data.length === 0 && (
          <li className="muted">Nothing is waiting for you.</li>
        )}
      </ul>
      <BottomNav />
    </main>
  );
}

/** One page the vault drew for review, fetched with the token, and asked again while it is drawn. */
function IncomingPages({ file, onDrawn }: { file: IncomingFileView; onDrawn: () => void }) {
  const { withToken } = useApp();
  const [n, setN] = useState(1);
  const [shown, setShown] = useState<{ n: number; url: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const pages = file.preview_state === 'ready' ? (file.preview_pages ?? 0) : 0;

  // Still being drawn: asked again in a moment, a few times.
  useEffect(() => {
    if (file.preview_state !== 'pending') return;
    const timer = setTimeout(onDrawn, 3000);
    return () => clearTimeout(timer);
  }, [file.preview_state, onDrawn]);

  useEffect(() => {
    if (pages === 0) return;
    let cancelled = false;
    let url: string | null = null;
    withToken((t) => api.incomingPage(t, file.id, n))
      .then((blob) => {
        if (cancelled || !blob) return;
        url = URL.createObjectURL(blob);
        setShown({ n, url });
        setProblem(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setProblem(describeError(err));
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file.id, n, pages, withToken]);

  if (file.preview_state === 'pending') {
    return (
      <div className="preview" aria-busy="true">
        <span className="muted">Getting it ready to look at…</span>
      </div>
    );
  }
  if (file.preview_state !== 'ready' || pages === 0) {
    return (
      <div className="preview">
        <span className="muted">
          {file.preview_state === 'unsupported'
            ? 'There is no preview of this kind of file. Save a copy to look at it.'
            : 'The vault could not draw this file’s pages. Save a copy to look at it.'}
        </span>
      </div>
    );
  }
  return (
    <section aria-label="Its pages" className="stack incoming-pages">
      <ErrorNote message={problem} />
      <div className="preview">
        {shown?.n === n ? (
          <img src={shown.url} alt={`Page ${n} of ${pages} of ${file.name}`} />
        ) : (
          <span className="muted">Loading page {n}…</span>
        )}
      </div>
      {pages > 1 && (
        // As the reader turns a document's pages (Reader.tsx).
        <div className="reader-tools" role="toolbar" aria-label="Pages">
          <Button
            kind="quiet"
            ariaLabel="Previous page"
            disabled={n <= 1}
            onClick={() => setN(n - 1)}
          >
            ‹
          </Button>
          <span className="reader-count" aria-live="polite">
            Page {n} of {pages}
          </span>
          <Button
            kind="quiet"
            ariaLabel="Next page"
            disabled={n >= pages}
            onClick={() => setN(n + 1)}
          >
            ›
          </Button>
        </div>
      )}
    </section>
  );
}

const VISIBILITIES: Array<[Visibility, string]> = [
  ['household', 'Everyone'],
  ['adults', 'Adults only'],
  ['private', 'Only me'],
];

export function IncomingFileScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { withToken, authVersion, session } = useApp();
  const me = session.info?.member_id ?? null;
  const role = storedRole();
  const mayReview = can(role, 'upload_request.create');
  const { data, error, reload } = useLoad(
    async (t) => {
      if (!mayReview) return null;
      const [incoming, types, members, documents] = await Promise.all([
        api.incoming(t),
        api.documentTypes(t),
        api.members(t),
        api.documents(t, { sort: 'recent', limit: 100 }),
      ]);
      return {
        file: incoming.items.find((f) => f.id === id) ?? null,
        types: types.items,
        members: members.items,
        documents: documents.items,
      };
    },
    [id, authVersion, mayReview],
  );
  const file = data?.file ?? null;

  return (
    <main className="page page-top has-nav">
      <TopBar title={file?.name ?? 'A file sent to you'} back="/incoming" />
      <ErrorNote message={error} />
      {data && !file && !error && (
        <p className="muted">
          This file is not waiting any more: somebody filed or refused it, or it was removed.{' '}
          <Link to="/incoming">See what is waiting</Link>.
        </p>
      )}
      {file && data && (
        <IncomingFile
          key={file.id}
          file={file}
          types={data.types}
          members={data.members}
          documents={data.documents}
          me={me}
          reload={reload}
          withToken={withToken}
          onDone={(to, said) => void navigate(to, said ? { state: { said } } : undefined)}
        />
      )}
      <BottomNav />
    </main>
  );
}

function IncomingFile(props: {
  file: IncomingFileView;
  types: DocumentTypeView[];
  members: Member[];
  documents: DocumentView[];
  me: string | null;
  reload: () => Promise<void>;
  withToken: ReturnType<typeof useApp>['withToken'];
  onDone: (to: string, said?: string) => void;
}) {
  const { file, types, members, me, withToken } = props;
  const role = storedRole();
  const suggestedType = types.find((t) => t.key === file.suggested_type_key);
  const startOwner = members.some((m) => m.id === file.suggested_member_id)
    ? (file.suggested_member_id as string)
    : '';
  const startVisibility = (type: DocumentTypeView | undefined, owner: string): Visibility => {
    if (!type) return 'adults';
    const v = effectiveVisibility({}, type, role);
    return v === 'private' && owner !== me ? 'adults' : v;
  };
  const [mode, setMode] = useState<'new' | 'version'>('new');
  const [title, setTitle] = useState(() => file.name.replace(/\.[^.]{1,10}$/, ''));
  const [typeKey, setTypeKey] = useState(suggestedType?.key ?? '');
  const [owner, setOwner] = useState(startOwner);
  const [visibility, setVisibility] = useState<Visibility>(() =>
    startVisibility(suggestedType, startOwner),
  );
  const [into, setInto] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const refuseButton = useRef<HTMLButtonElement>(null);
  const shown = types.filter((t) => !t.hidden || t.key === typeKey);
  const people = members.filter((m) => !m.is_deceased);

  const saveCopy = async () => {
    setProblem(null);
    try {
      const blob = await withToken((t) => api.incomingContent(t, file.id));
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = incomingFileName(file.name, file.content_type);
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      setProblem(describeError(err));
    }
  };

  const fileIt = async (e: FormEvent) => {
    e.preventDefault();
    if (mode === 'version' && !into) {
      setProblem('Choose the document it is a new version of.');
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const done = await withToken((t) =>
        api.acceptIncoming(
          t,
          file.id,
          mode === 'version'
            ? { into_document_id: into }
            : {
                title: title.trim() || null,
                type_key: typeKey || null,
                owner_member_id: owner || null,
                visibility,
              },
        ),
      );
      if (done) props.onDone(`/documents/${done.document_id}`);
    } catch (err) {
      setProblem(
        err instanceof ApiRequestError && err.code === 'incoming_not_ready'
          ? 'It is still being got ready to look at. Try again in a minute.'
          : describeError(err),
      );
    } finally {
      setBusy(false);
    }
  };

  const refuse = async () => {
    setBusy(true);
    try {
      await withToken((t) => api.rejectIncoming(t, file.id));
      setAsking(false);
      props.onDone('/incoming', `“${file.name}” was refused, and removed.`);
    } catch (err) {
      setAsking(false);
      setProblem(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="card stack" aria-labelledby="incoming-about">
        <h2 id="incoming-about" className="section-h">
          What came in
        </h2>
        <p>{fromWords(file)}</p>
        <p className="muted">
          {file.content_type === 'application/pdf' ? 'PDF' : file.content_type} ·{' '}
          {sizeWords(file.byte_size)} · sent {whenExactly(file.sent_at)}
        </p>
        {file.scan_state !== 'clean' && (
          <div className="stack incoming-scan">
            <NotScanned id="incoming-scan" />
            <span className="muted">
              This vault does not check files for viruses. The pages below are pictures the vault
              drew, and safe to look at; open a copy only if you trust who sent it.
            </span>
          </div>
        )}
        {file.sender_note && (
          <blockquote className="incoming-note">
            <span className="muted">Their note:</span> {file.sender_note}
          </blockquote>
        )}
        <p className="muted">
          Removed on {dayWords(file.removed_at)} unless somebody files it.
          {file.moved_to_owners &&
            ' It was sent for somebody who can no longer look at it, so it came to the owners.'}
        </p>
        <div className="row">
          <Button kind="quiet" onClick={() => void saveCopy()}>
            Save a copy
          </Button>
        </div>
      </section>

      <IncomingPages file={file} onDrawn={() => void props.reload()} />

      <form
        className="card stack"
        aria-labelledby="incoming-file-it"
        onSubmit={(e) => void fileIt(e)}
      >
        <h2 id="incoming-file-it" className="section-h">
          File it
        </h2>
        <div className="field" role="group" aria-label="File it as">
          <span className="field-label">As</span>
          <div className="pills">
            {(
              [
                ['new', 'A new document'],
                ['version', 'A new version of one'],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                type="button"
                className={`pill${mode === m ? ' pill-on' : ''}`}
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {mode === 'new' ? (
          <>
            <Field
              id="incoming-title"
              label="Name"
              value={title}
              maxLength={200}
              required={false}
              onChange={setTitle}
            />
            <Select
              id="incoming-type"
              label="Kind of document"
              value={typeKey}
              options={[
                { value: '', label: 'Not sure yet' },
                ...shown.map((t) => ({ value: t.key, label: t.label })),
              ]}
              onChange={(v) => {
                setTypeKey(v);
                setVisibility(
                  startVisibility(
                    types.find((t) => t.key === v),
                    owner,
                  ),
                );
              }}
              hint={
                file.suggested_type_key && typeKey === file.suggested_type_key
                  ? 'As the request suggested.'
                  : undefined
              }
            />
            <Select
              id="incoming-owner"
              label="Whose is it?"
              value={owner}
              options={[
                { value: '', label: 'Nobody in particular' },
                ...people.map((m) => ({ value: m.id, label: m.display_name })),
              ]}
              onChange={(v) => {
                setOwner(v);
                if (visibility === 'private' && v !== me) setVisibility('adults');
              }}
              hint={
                file.suggested_member_id && owner === file.suggested_member_id
                  ? 'As the request suggested.'
                  : undefined
              }
            />
            <div className="field" role="group" aria-label="Who can see it">
              <span className="field-label">Who can see it</span>
              <div className="pills">
                {VISIBILITIES.map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    className={`pill${visibility === v ? ' pill-on' : ''}`}
                    aria-pressed={visibility === v}
                    disabled={v === 'private' && (owner === '' || owner !== me)}
                    onClick={() => setVisibility(v)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {visibility === 'private' && (
                <span className="muted">
                  Only you can open this. Nobody can open it after you, unless you leave a key.
                </span>
              )}
            </div>
          </>
        ) : (
          <Select
            id="incoming-into"
            label="A new version of"
            value={into}
            options={[
              { value: '', label: 'Choose a document' },
              ...props.documents.map((d) => ({ value: d.id, label: d.title ?? 'Needs a name' })),
            ]}
            onChange={setInto}
          />
        )}
        <ErrorNote message={problem} />
        <div className="row">
          <Button type="submit" disabled={busy}>
            {busy && !asking ? 'Filing it…' : 'File it'}
          </Button>
          <button
            ref={refuseButton}
            type="button"
            className="btn btn-quiet"
            disabled={busy}
            onClick={() => setAsking(true)}
          >
            Refuse it
          </button>
        </div>
      </form>

      {asking && (
        <ConfirmDialog
          title="Refuse this file?"
          confirmLabel="Refuse it"
          busyLabel="Refusing…"
          danger
          busy={busy}
          returnFocus={refuseButton}
          onConfirm={() => void refuse()}
          onCancel={() => setAsking(false)}
        >
          <p>
            “{file.name}” is removed from the vault, and nothing of it is kept.{' '}
            {file.recipient_label ? `${file.recipient_label} is` : 'Whoever sent it is'} not told.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
