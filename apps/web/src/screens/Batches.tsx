import {
  autoTitle,
  BATCH_MAX_FILES,
  BATCH_NAME_MAX,
  batchVisibility,
  can,
  duplicateWords,
  seesLocation,
  type BatchDefaults,
  type BatchDetail,
  type BatchItemView,
  type BatchView,
  type CollectionView,
  type DocumentTypeView,
  type Role,
  type Visibility,
} from '@fdv/shared';
import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, ApiRequestError, NetworkError, type Member } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { BATCH_ACCEPT, sendBatchItem, sha256Of, takenKind } from '../batch-upload.js';
import { mayChangeCollection } from '../collections.js';
import { storedRole } from '../session.js';
import { useShellMode } from '../shell.js';
import { Button, ConfirmDialog, ErrorNote, Field, Select, Switch, TopBar } from '../ui.js';
import { captureDetails, ConfirmForm } from './AddConfirm.js';
import { IncomingList, sizeWords } from './Incoming.js';

/**
 * Many documents at once (Phase 6, I1): Add → Many documents, the Inbox's
 * "Your uploads", a batch's page, and the card that accepts one of its
 * files as a document.
 *
 * A batch is its uploader's alone until each file in it is accepted (the
 * owner's decision Q3): nobody else in the family sees it, an owner
 * included. What the batch chooses for all of them fills only what is blank
 * on each card (Q4). Reading the pages and proposing the details is the
 * next iteration's (I2): until then each file waits "to be read", and its
 * card starts from the batch's choices alone.
 */

/** "6 Oct": the day, as a batch with no name is called by it. */
const shortDay = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/** "5 November": the day what is undecided is removed. */
const longDay = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });

/** A batch as it is called: its name, or the day it was made. */
export function batchLabel(b: { name: string | null; created_at: string }): string {
  return b.name ?? `Upload of ${shortDay(b.created_at)}`;
}

/** What an item duplicates, in words, with an unnamed batch called by its day. */
const dupWords = (item: BatchItemView) =>
  item.duplicate ? duplicateWords(item.duplicate, batchLabel) : null;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Whether somebody may make batches: the vault has them, and they add documents. */
function useMayBatch(): { mayBatch: boolean; role: Role } {
  const { caps, session } = useApp();
  const role: Role = session.info?.role ?? storedRole();
  return { mayBatch: caps?.features.batches === true && can(role, 'document.add'), role };
}

/** The collections somebody may put documents in: their own, in an audience they are in. */
const addable = (collections: CollectionView[], role: Role) =>
  collections.filter((c) => mayChangeCollection(role, c));

/** What only the uploader sees, said where it matters. */
function OnlyYou({ children }: { children?: ReactNode }) {
  return (
    <p className="private-note">
      <span aria-hidden="true">🔒︎</span>{' '}
      {children ?? 'Only you can see these until you accept them.'}
    </p>
  );
}

// ------------------------------------------------------------ add many

/** One file chosen, and what became of it. */
interface Chosen {
  key: string;
  file: File;
  state: 'ready' | 'refused' | 'sending' | 'sent' | 'skipped' | 'failed';
  /** Why it was not sent, in the vault's words or the page's. */
  reason?: string;
  /** How much of it has gone. */
  sent: number;
}

const fileKey = (f: File) =>
  `${(f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name}:${f.size}:${f.lastModified}`;

/** Every file under what was dropped: a folder's own, and its folders' (Chrome, Edge, Safari, Firefox). */
async function droppedFiles(e: DragEvent<HTMLElement>): Promise<File[]> {
  const items = [...e.dataTransfer.items];
  const entries = items
    .map((i) => (i.kind === 'file' ? (i.webkitGetAsEntry?.() ?? null) : null))
    .filter((x): x is FileSystemEntry => x !== null);
  if (entries.length === 0) return [...e.dataTransfer.files];
  const out: File[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      out.push(
        await new Promise<File>((resolve, reject) =>
          (entry as FileSystemFileEntry).file(resolve, reject),
        ),
      );
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (batch.length === 0) return;
      for (const child of batch) await walk(child);
    }
  };
  for (const entry of entries) await walk(entry);
  return out;
}

/** Whether this browser chooses a folder (`webkitdirectory`). */
const foldersChosen = () =>
  typeof HTMLInputElement !== 'undefined' && 'webkitdirectory' in HTMLInputElement.prototype;

/**
 * Add → Many documents (/add/many): files or a folder, what is chosen for
 * all of them, then the upload, one file after another, each file's
 * progress and all of it, said politely as each file arrives. A file the
 * vault would refuse — too big, a kind it does not take — is listed as not
 * sent, with why, and the rest carry on. Stop stops after the file being
 * sent. With `?batch=`, it carries on a batch already made: what arrived
 * already (its name, size and SHA-256) is not sent again.
 */
export function AddManyScreen() {
  const mode = useShellMode();
  if (mode === 'phone') {
    return (
      <main className="page page-top has-nav">
        <TopBar title="Add many documents" back="/" />
        <div className="notice-box">
          <strong>Adding many documents is for a computer.</strong>
          <span className="muted">
            On a phone, add one at a time with + below. Checking a batch of files is a task for a
            wide screen, and far quicker there.
          </span>
        </div>
        <p>
          <Link to="/add" className="btn btn-primary">
            Add one document
          </Link>
        </p>
      </main>
    );
  }
  return <AddMany />;
}

function AddMany() {
  const { caps, withToken } = useApp();
  const { mayBatch, role } = useMayBatch();
  const [params] = useSearchParams();
  const resuming = params.get('batch');
  const limit = caps?.limits.max_upload_bytes ?? Number.POSITIVE_INFINITY;
  const { data, error: loadError } = useLoad(
    async (t) => {
      const [types, members, collections, batch] = await Promise.all([
        api.documentTypes(t),
        api.members(t),
        caps?.features.collections && can(role, 'collection.manage')
          ? api.collections(t).then((r) => r.items)
          : Promise.resolve([] as CollectionView[]),
        resuming ? api.batch(t, resuming) : Promise.resolve(null),
      ]);
      return { types: types.items, members: members.items, collections, batch };
    },
    [resuming, role],
  );
  const me = data?.members.find((m) => m.is_me);
  const teen = role === 'teen';
  const [chosen, setChosen] = useState<Chosen[]>([]);
  const [name, setName] = useState('');
  const [owner, setOwner] = useState('');
  const [typeKey, setTypeKey] = useState('');
  const [visibility, setVisibility] = useState<Visibility | ''>('');
  const [location, setLocation] = useState('');
  const [collectionId, setCollectionId] = useState('');
  const [tags, setTags] = useState('');
  const [essential, setEssential] = useState(false);
  const [phase, setPhase] = useState<'choosing' | 'sending' | 'stopped' | 'done'>('choosing');
  const [batch, setBatch] = useState<{ id: string; label: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const [over, setOver] = useState(false);
  const stopAsked = useRef(false);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const stopButton = useRef<HTMLButtonElement>(null);
  const outcome = useRef<HTMLParagraphElement>(null);
  const resumed = data?.batch ?? null;
  const already = resumed?.items.length ?? 0;

  // The button that started it goes as it starts, and Stop as it ends: the
  // focus goes to Stop while files are sent, and then to what arrived.
  useEffect(() => {
    if (phase === 'sending') stopButton.current?.focus();
    if (phase === 'done' || phase === 'stopped') outcome.current?.focus();
  }, [phase]);

  /** What is chosen, checked as the vault would check it: refused here, with why, or ready. */
  const add = (files: File[]) => {
    setChosen((was) => {
      const keys = new Set(was.map((c) => c.key));
      const next = [...was];
      for (const file of files) {
        const key = fileKey(file);
        if (keys.has(key)) continue;
        keys.add(key);
        const room = BATCH_MAX_FILES - already - next.filter((c) => c.state !== 'refused').length;
        const reason = !takenKind(file)
          ? 'Not a kind the vault takes: PDFs, photos and scans, Word and Excel files.'
          : file.size > limit
            ? `Too big: over ${sizeWords(limit)}, the most this vault takes for one file.`
            : room <= 0
              ? `A batch holds ${BATCH_MAX_FILES} files: start another batch for this one.`
              : null;
        next.push({
          key,
          file,
          state: reason ? 'refused' : 'ready',
          sent: 0,
          ...(reason ? { reason } : {}),
        });
      }
      return next;
    });
  };

  const update = (key: string, change: Partial<Chosen>) =>
    setChosen((was) => was.map((c) => (c.key === key ? { ...c, ...change } : c)));

  /** The defaults, as the batch is made with them: only what was chosen. */
  const defaultsChosen = (): Partial<BatchDefaults> => {
    const d: Partial<BatchDefaults> = {};
    if (owner) d.owner_member_id = owner;
    if (typeKey) d.type_key = typeKey;
    if (visibility) d.visibility = visibility;
    if (location.trim() && seesLocation(role)) d.physical_location = location.trim();
    if (collectionId) d.collection_id = collectionId;
    const t = tags
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    if (t.length) d.tags = t;
    if (essential) d.is_essential = true;
    return d;
  };

  /**
   * Sends what is ready (and, again, what failed): one file after another,
   * into the batch — made first, or the one carried on. A file already in
   * a batch carried on (its name, its size and its SHA-256) is not sent
   * again. Stop is heard after the file being sent.
   */
  const send = async () => {
    setProblem(null);
    stopAsked.current = false;
    let target = batch;
    if (!target) {
      if (resumed) {
        target = { id: resumed.id, label: batchLabel(resumed) };
      } else {
        try {
          const made = await withToken((t) =>
            api.createBatch(t, {
              ...(name.trim() ? { name: name.trim() } : {}),
              defaults: defaultsChosen(),
            }),
          );
          if (!made) return;
          target = { id: made.id, label: batchLabel(made) };
        } catch (err) {
          setProblem(describeError(err));
          return;
        }
      }
      setBatch(target);
    }
    const todo = chosen.filter((c) => c.state === 'ready' || c.state === 'failed');
    setPhase('sending');
    setSaid(`Sending ${plural(todo.length, 'file')}.`);
    let done = 0;
    let stoppedBy: string | null = null;
    for (const c of todo) {
      if (stopAsked.current) break;
      const there = resumed?.items.find(
        (i) => i.name === c.file.name && i.byte_size === c.file.size,
      );
      if (there) {
        const hash = await sha256Of(c.file).catch(() => null);
        if (hash === there.sha256) {
          update(c.key, { state: 'skipped', reason: 'Already in this batch.' });
          done++;
          continue;
        }
      }
      update(c.key, { state: 'sending', sent: 0 });
      try {
        const item = await withToken(
          (t) =>
            sendBatchItem(t, (target as { id: string }).id, c.file, (sent) =>
              update(c.key, { sent }),
            ).done,
        );
        if (!item) return;
        update(c.key, { state: 'sent', sent: c.file.size });
        done++;
        setSaid(`${done} of ${todo.length} sent.`);
      } catch (err) {
        if (err instanceof NetworkError || !(err instanceof ApiRequestError)) {
          // The connection: this one, and the rest, wait to be sent again.
          update(c.key, {
            state: 'failed',
            reason: 'The connection dropped: it can be sent again.',
          });
          stoppedBy = 'The connection to the vault dropped. Send the rest again when it is back.';
          break;
        }
        update(c.key, { state: 'refused', reason: err.message });
        // A batch that takes no more: none of the rest would go in it.
        if (err.code === 'batch_full' || err.code === 'batch_ended') {
          stoppedBy = err.message;
          break;
        }
      }
    }
    if (stoppedBy) setProblem(stoppedBy);
    setPhase(stopAsked.current || stoppedBy ? 'stopped' : 'done');
    setSaid(stopAsked.current ? 'Stopped. What arrived is in your Inbox.' : '');
  };

  const counts = {
    total: chosen.length,
    sent: chosen.filter((c) => c.state === 'sent').length,
    skipped: chosen.filter((c) => c.state === 'skipped').length,
    refused: chosen.filter((c) => c.state === 'refused').length,
    waiting: chosen.filter((c) => c.state === 'ready' || c.state === 'failed').length,
  };
  const toSend = chosen.filter((c) => c.state !== 'refused');
  const bytes = toSend.reduce((n, c) => n + c.file.size, 0);
  const sentBytes = toSend.reduce(
    (n, c) =>
      n +
      (c.state === 'sent' || c.state === 'skipped'
        ? c.file.size
        : c.state === 'sending'
          ? c.sent
          : 0),
    0,
  );
  const started = phase !== 'choosing' || resumed !== null;
  const locked = phase !== 'choosing';
  const people = (data?.members ?? []).filter((m) => (teen ? m.is_me : !m.is_deceased));
  const collections = data ? addable(data.collections, role) : [];
  const shownTypes = (data?.types ?? []).filter((t) => !t.hidden || t.key === typeKey);

  if (!mayBatch) {
    return (
      <main className="page page-top has-nav">
        <TopBar title="Add many documents" back="/" />
        <p className="muted">
          {caps?.features.batches === false || caps?.features.batches === undefined
            ? 'This vault takes one document at a time.'
            : 'Only somebody who adds documents can add many at once.'}
        </p>
      </main>
    );
  }

  return (
    <main className="page page-top page-wide has-nav addmany-page">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to="/inbox">Inbox</Link> <span aria-hidden="true">›</span>{' '}
        <span>{resumed ? batchLabel(resumed) : 'Add many documents'}</span>
      </nav>
      <h1>{resumed ? `Carry on: ${batchLabel(resumed)}` : 'Add many documents'}</h1>
      <p className="lede">
        {resumed
          ? `Choose the same files or folder again: what is already in it (${plural(already, 'file')}) is not sent twice.`
          : 'Each file waits in your Inbox, and becomes a document when you accept it. Nothing is a document, and nobody else sees it, until then.'}
      </p>
      <ErrorNote message={loadError} />
      <p className="visually-hidden" role="status" aria-live="polite">
        {said}
      </p>
      <div className="addmany">
        <div className="stack">
          {!locked && (
            <div
              className={`drop${over ? ' drop-over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(true);
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setOver(false);
                void droppedFiles(e).then(add);
              }}
            >
              <h2 className="section-h">Drop files or a folder here</h2>
              <p className="muted">
                PDFs, photos and scans, Word and Excel files: up to {BATCH_MAX_FILES} at a time,
                each up to {sizeWords(limit)}.
              </p>
              <div className="row">
                <Button kind="quiet" onClick={() => filesInput.current?.click()}>
                  Choose files
                </Button>
                {foldersChosen() && (
                  <Button kind="quiet" onClick={() => folderInput.current?.click()}>
                    Choose a folder
                  </Button>
                )}
              </div>
              <input
                ref={filesInput}
                type="file"
                multiple
                accept={BATCH_ACCEPT}
                aria-label="Choose files"
                style={{ display: 'none' }}
                onChange={(e) => {
                  add([...(e.target.files ?? [])]);
                  e.target.value = '';
                }}
              />
              <input
                ref={(el) => {
                  folderInput.current = el;
                  el?.setAttribute('webkitdirectory', '');
                }}
                type="file"
                multiple
                aria-label="Choose a folder"
                style={{ display: 'none' }}
                onChange={(e) => {
                  add([...(e.target.files ?? [])]);
                  e.target.value = '';
                }}
              />
            </div>
          )}
          {chosen.length > 0 && (
            <section className="card stack" aria-labelledby="chosen-h">
              <div className="card-head">
                <h2 id="chosen-h" className="section-h">
                  {phase === 'choosing'
                    ? `${plural(toSend.length, 'file')} · ${sizeWords(bytes)}`
                    : phase === 'sending'
                      ? `Sending ${Math.min(counts.sent + counts.skipped + 1, toSend.length)} of ${toSend.length}…`
                      : `${plural(counts.sent + counts.skipped, 'file')} arrived`}
                </h2>
                {phase === 'choosing' && (
                  <Button kind="link" onClick={() => setChosen([])}>
                    Remove all
                  </Button>
                )}
              </div>
              {phase !== 'choosing' && (
                <div className="stack">
                  <progress
                    className="upload-bar"
                    value={sentBytes}
                    max={Math.max(bytes, 1)}
                    aria-label="All of them"
                  />
                  <span className="muted">
                    {sizeWords(sentBytes)} of {sizeWords(bytes)}
                  </span>
                </div>
              )}
              <ul className="filelist" aria-label="The files">
                {chosen.map((c) => (
                  <li key={c.key} className={`filerow filerow-${c.state}`}>
                    <span className="filerow-name" title={c.file.name}>
                      {c.file.name}
                    </span>
                    <span className="filerow-size">{sizeWords(c.file.size)}</span>
                    <span className="filerow-state">
                      {c.state === 'sending' ? (
                        <>
                          <progress
                            value={c.sent}
                            max={Math.max(c.file.size, 1)}
                            aria-label={`${c.file.name}, sending`}
                          />
                          <span aria-hidden="true">
                            {Math.round((c.sent / Math.max(c.file.size, 1)) * 100)}%
                          </span>
                        </>
                      ) : c.state === 'sent' ? (
                        'Arrived · waiting to be read'
                      ) : c.state === 'skipped' ? (
                        c.reason
                      ) : c.state === 'ready' ? (
                        phase === 'choosing' ? (
                          'Ready'
                        ) : (
                          'Not sent yet'
                        )
                      ) : (
                        <span className="status status-warn">
                          {c.state === 'failed' ? 'Not sent: ' : 'Not sent. '}
                          {c.reason}
                        </span>
                      )}
                    </span>
                    {phase === 'choosing' && (
                      <button
                        type="button"
                        className="btn btn-link"
                        aria-label={`Take ${c.file.name} off the list`}
                        onClick={() => setChosen((was) => was.filter((x) => x.key !== c.key))}
                      >
                        ×
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              <ErrorNote message={problem} />
              {phase === 'sending' && (
                <div className="row">
                  <Button
                    ref={stopButton}
                    kind="quiet"
                    onClick={() => {
                      stopAsked.current = true;
                      setSaid('Stopping after this file.');
                    }}
                  >
                    Stop after this file
                  </Button>
                  <span className="muted">You can carry on later from the batch.</span>
                </div>
              )}
              {(phase === 'done' || phase === 'stopped') && batch && (
                <div className="stack">
                  <p role="status" ref={outcome} tabIndex={-1}>
                    {plural(counts.sent + counts.skipped, 'file')} arrived in “{batch.label}”
                    {counts.refused ? `; ${plural(counts.refused, 'file')} not sent` : ''}
                    {counts.waiting ? `; ${counts.waiting} still to send` : ''}.
                  </p>
                  <div className="row">
                    <Link className="btn btn-primary" to={`/inbox/batches/${batch.id}`}>
                      Open the batch
                    </Link>
                    {counts.waiting > 0 && (
                      <Button kind="quiet" onClick={() => void send()}>
                        Send the rest
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </section>
          )}
        </div>
        <section className="card stack defaults-card" aria-labelledby="defaults-h">
          <div>
            <h2 id="defaults-h" className="section-h">
              For all of them
            </h2>
            <p className="muted">
              {resumed
                ? 'Chosen when the batch was made. Each card starts from these.'
                : 'All optional. Each fills only what is blank on a file’s card, which you check before it becomes a document.'}
            </p>
          </div>
          {resumed || locked ? (
            // Chosen once: what the batch was made with, said, not asked again.
            <DefaultsWords
              defaults={resumed?.defaults ?? { ...NO_DEFAULTS, ...defaultsChosen() }}
              types={data?.types ?? []}
              members={data?.members ?? []}
              collections={data?.collections ?? []}
            />
          ) : (
            <fieldset className="stack plain" disabled={locked}>
              <legend className="visually-hidden">What is chosen for all of them</legend>
              <Field
                id="b-name"
                label="Name this batch"
                value={name}
                onChange={setName}
                required={false}
                maxLength={BATCH_NAME_MAX}
                placeholder={`Upload of ${shortDay(new Date().toISOString())}`}
              />
              <Select
                id="b-owner"
                label="Whose documents"
                value={owner}
                onChange={(v) => {
                  setOwner(v);
                  if (visibility === 'private' && v && v !== me?.id) setVisibility('');
                }}
                options={[
                  { value: '', label: teen ? 'Mine' : 'Different people, or not sure' },
                  ...people.map((m) => ({ value: m.id, label: m.display_name })),
                ]}
              />
              <Select
                id="b-kind"
                label="Kind"
                value={typeKey}
                onChange={setTypeKey}
                options={[
                  { value: '', label: 'Different kinds, or not sure' },
                  ...shownTypes.map((t) => ({ value: t.key, label: t.label })),
                ]}
              />
              <div className="field" role="group" aria-labelledby="b-vis-l">
                <span className="field-label" id="b-vis-l">
                  Who can see them
                </span>
                <div className="pills">
                  {(
                    [
                      ['', 'As each kind says'],
                      ['household', 'Everyone'],
                      ['adults', 'Adults only'],
                      ['private', 'Only me'],
                    ] as const
                  ).map(([v, label]) => (
                    <button
                      key={v || 'kind'}
                      type="button"
                      className={`pill${visibility === v ? ' pill-on' : ''}`}
                      aria-pressed={visibility === v}
                      disabled={
                        (v === 'adults' && !can(role, 'document.see_adults')) ||
                        (v === 'private' && owner !== '' && owner !== me?.id)
                      }
                      onClick={() => setVisibility(v)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <span className="muted">
                  Never wider than you choose: a kind usually for the adults stays for the adults.
                </span>
              </div>
              {seesLocation(role) && (
                <Field
                  id="b-location"
                  label="Where the paper copies are"
                  value={location}
                  onChange={setLocation}
                  required={false}
                  placeholder="Filing cabinet, study"
                />
              )}
              {collections.length > 0 && (
                <Select
                  id="b-collection"
                  label="Collection"
                  value={collectionId}
                  onChange={setCollectionId}
                  options={[
                    { value: '', label: 'None' },
                    ...collections.map((c) => ({ value: c.id, label: c.name })),
                  ]}
                />
              )}
              <Field
                id="b-tags"
                label="Tags"
                value={tags}
                onChange={setTags}
                required={false}
                placeholder="house, old papers"
                hint="A comma between tags."
              />
              <Switch
                id="b-essential"
                label="Essential"
                checked={essential}
                onChange={setEssential}
              />
            </fieldset>
          )}
          {phase === 'choosing' && (
            <Button disabled={!data || counts.waiting === 0} onClick={() => void send()}>
              {counts.waiting === 0
                ? 'Choose some files first'
                : `${started ? 'Send' : 'Start: upload'} ${plural(counts.waiting, 'file')}`}
            </Button>
          )}
          <OnlyYou>Only you see them until you accept them.</OnlyYou>
        </section>
      </div>
    </main>
  );
}

/** Nothing chosen for all of them. */
const NO_DEFAULTS: BatchDefaults = {
  owner_member_id: null,
  type_key: null,
  visibility: null,
  physical_location: null,
  collection_id: null,
  tags: [],
  is_essential: false,
};

/** A batch's choices for all of its files, said as chips: "Aisha", "Passport", "Adults only". */
function DefaultsWords(props: {
  defaults: BatchDefaults;
  types: DocumentTypeView[];
  members: Member[];
  collections: CollectionView[];
}) {
  const d = props.defaults;
  const words = [
    d.owner_member_id && props.members.find((m) => m.id === d.owner_member_id)?.display_name,
    d.type_key && (props.types.find((t) => t.key === d.type_key)?.label ?? d.type_key),
    d.visibility &&
      ({ household: 'Everyone', adults: 'Adults only', private: 'Only me' } as const)[d.visibility],
    d.physical_location,
    d.collection_id && props.collections.find((c) => c.id === d.collection_id)?.name,
    ...d.tags.map((t) => `#${t}`),
    d.is_essential && 'Essential',
  ].filter((w): w is string => typeof w === 'string' && w !== '');
  if (words.length === 0) return <p className="muted">Nothing chosen for all of them.</p>;
  return (
    <ul className="chips" aria-label="Chosen for all of them">
      {words.map((w) => (
        <li key={w} className="chip">
          {w}
        </li>
      ))}
    </ul>
  );
}

// --------------------------------------------------------------- inbox

/** The Inbox's two lists, as tabs: your uploads, and what was sent to you. */
function InboxTabs(props: {
  current: 'uploads' | 'sent';
  uploads: number | null;
  sent: number | null;
}) {
  const count = (n: number | null) =>
    n === null ? null : (
      <span className="tab-count" aria-hidden="true">
        {n}
      </span>
    );
  return (
    <nav className="tabs" aria-label="Inbox">
      <Link
        className="tab"
        to="/inbox"
        aria-current={props.current === 'uploads' ? 'page' : undefined}
        aria-label={props.uploads === null ? undefined : `Your uploads, ${props.uploads} waiting`}
      >
        Your uploads{count(props.uploads)}
      </Link>
      <Link
        className="tab"
        to="/inbox/sent"
        aria-current={props.current === 'sent' ? 'page' : undefined}
        aria-label={props.sent === null ? undefined : `Files sent to you, ${props.sent} waiting`}
      >
        Files sent to you{count(props.sent)}
      </Link>
    </nav>
  );
}

/** The Inbox's page: its heading, and the tabs for whoever has both lists. */
function InboxPage(props: {
  current: 'uploads' | 'sent';
  both: boolean;
  uploads: number | null;
  sent: number | null;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="page page-top page-wide has-nav">
      <TopBar title="Inbox" action={props.action} />
      <p className="lede">What is waiting for you before it becomes a document.</p>
      {props.both && (
        <InboxTabs current={props.current} uploads={props.uploads} sent={props.sent} />
      )}
      {props.children}
    </main>
  );
}

/**
 * The Inbox (/inbox): your uploads — each batch with how many files, how
 * many wait, and when what is undecided is removed — beside the files sent
 * to you. A vault from before batches, or somebody who adds nothing, has
 * the files sent to them alone, as before.
 */
export function InboxScreen() {
  const { mayBatch } = useMayBatch();
  const { caps, authVersion } = useApp();
  const role = storedRole();
  const mayReview = caps?.features.upload_requests === true && can(role, 'upload_request.create');
  const location = useLocation();
  const said = (location.state as { said?: string } | null)?.said ?? null;
  const status = useRef<HTMLParagraphElement>(null);
  const mode = useShellMode();
  const { data, error } = useLoad(
    async (t) => {
      const [batches, sent] = await Promise.all([
        mayBatch ? api.batches(t).then((r) => r.items) : Promise.resolve([] as BatchView[]),
        mayReview ? api.incoming(t).then((r) => r.items.length) : Promise.resolve(null),
      ]);
      return { batches, sent };
    },
    [authVersion, mayBatch, mayReview],
  );
  useEffect(() => {
    if (said) status.current?.focus();
  }, [said]);
  if (!mayBatch) return <IncomingList standalone />;
  const waiting = data ? data.batches.reduce((n, b) => n + b.counts.waiting, 0) : null;
  return (
    <InboxPage
      current="uploads"
      both={mayReview}
      uploads={waiting}
      sent={data?.sent ?? null}
      action={
        mode !== 'phone' ? (
          <Link className="btn btn-primary" to="/add/many">
            Add many documents
          </Link>
        ) : undefined
      }
    >
      <p role="status" ref={status} tabIndex={-1} className="status-line">
        {said}
      </p>
      <ErrorNote message={error} />
      <OnlyYou>
        Only you can see these until you accept them. Anything not decided within 30 days is
        removed.
      </OnlyYou>
      {!data && !error && <p className="muted">Loading your uploads…</p>}
      {data && data.batches.length === 0 && (
        <div className="notice-box">
          <strong>Nothing you uploaded is waiting.</strong>
          <span className="muted">
            Add many documents at once from a computer, and they wait here for you to check.
          </span>
        </div>
      )}
      {data && data.batches.length > 0 && (
        <ul className="list batch-list" aria-label="Your uploads">
          {data.batches.map((b) => (
            <li key={b.id}>
              <Link to={`/inbox/batches/${b.id}`} className="rowbtn batch-row">
                <span className="doc-title">{batchLabel(b)}</span>
                <span className="muted">
                  {plural(b.counts.items, 'file')} ·{' '}
                  {b.counts.waiting > 0
                    ? `${b.counts.waiting} waiting`
                    : b.counts.items > 0
                      ? 'nothing left to check'
                      : 'nothing in it yet'}
                  {b.counts.duplicates > 0 ? ` · ${plural(b.counts.duplicates, 'duplicate')}` : ''}
                </span>
                <span className="muted">
                  Made {shortDay(b.created_at)} · removed on {longDay(b.ends_at)} unless accepted
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </InboxPage>
  );
}

/** The files sent to you (/inbox/sent), in the Inbox's tabs for whoever also uploads. */
export function SentScreen() {
  const { mayBatch } = useMayBatch();
  const { caps, authVersion } = useApp();
  const mayReview =
    caps?.features.upload_requests === true && can(storedRole(), 'upload_request.create');
  const { data } = useLoad(
    async (t) =>
      mayBatch ? (await api.batches(t)).items.reduce((n, b) => n + b.counts.waiting, 0) : null,
    [authVersion, mayBatch],
  );
  if (!mayBatch || !mayReview) return <IncomingList standalone />;
  return (
    <IncomingList
      standalone={false}
      wrap={(children, sent) => (
        <InboxPage current="sent" both uploads={data ?? null} sent={sent}>
          {children}
        </InboxPage>
      )}
    />
  );
}

// --------------------------------------------------------------- batch

/** An item's first page, drawn by the worker: a picture when there is one, a blank until then. */
function FirstPage(props: { batchId: string; item: BatchItemView; large?: boolean }) {
  const { withToken } = useApp();
  const [url, setUrl] = useState<string | null>(null);
  const ready = props.item.preview_state === 'ready' && (props.item.preview_pages ?? 0) > 0;
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    let made: string | null = null;
    withToken((t) => api.batchItemPage(t, props.batchId, props.item.id, 1))
      .then((blob) => {
        if (cancelled || !blob) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [ready, props.batchId, props.item.id, withToken]);
  const cls = props.large ? 'firstpage firstpage-large' : 'firstpage';
  if (url) return <img className={cls} src={url} alt={`First page of ${props.item.name}`} />;
  return (
    <span className={`${cls} firstpage-none`} aria-hidden="true">
      {props.item.preview_state === 'pending'
        ? '…'
        : props.item.content_type === 'application/pdf'
          ? 'PDF'
          : 'FILE'}
    </span>
  );
}

/** What an item is now, in words: waiting to be read, a duplicate, or accepted. */
function ItemState({ item }: { item: BatchItemView }) {
  if (item.state === 'accepted') {
    return (
      <span className="item-state">
        <span className="status status-ok">Accepted</span>
        {item.document_id && (
          <Link to={`/documents/${item.document_id}`} className="quiet-link">
            Open the document
          </Link>
        )}
      </span>
    );
  }
  const dup = dupWords(item);
  return (
    <span className="item-state">
      <span className="status status-neutral">Waiting to be read</span>
      {dup && (
        <span className="status status-warn">
          {item.duplicate?.of === 'document' ? (
            <Link to={`/documents/${item.duplicate.document_id}`}>{dup}</Link>
          ) : (
            dup
          )}
        </span>
      )}
    </span>
  );
}

/**
 * A batch (/inbox/batches/:id): its files, each with its first page when
 * drawn, its name, size and pages, and what it is now — waiting to be read,
 * a duplicate, accepted. Accept opens its card; Remove asks first; Remove
 * the batch removes what is undecided; Carry on sends more of it.
 */
export function BatchScreen() {
  const { id } = useParams<{ id: string }>();
  const { withToken, caps } = useApp();
  const role = storedRole();
  const navigate = useNavigate();
  const mode = useShellMode();
  const location = useLocation();
  const said = (location.state as { said?: string } | null)?.said ?? null;
  const [message, setMessage] = useState<string | null>(said);
  const status = useRef<HTMLParagraphElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const { data, error, reload } = useLoad(
    async (t) => {
      const [batch, members, types, collections] = await Promise.all([
        api.batch(t, id as string),
        api.members(t),
        api.documentTypes(t),
        caps?.features.collections && can(role, 'collection.manage')
          ? api.collections(t).then((r) => r.items)
          : Promise.resolve([] as CollectionView[]),
      ]);
      return { batch, members: members.items, types: types.items, collections };
    },
    [id],
  );
  const [asking, setAsking] = useState<BatchItemView | 'batch' | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // After a removal, where the focus goes once the batch is drawn again:
  // the next file's Accept, or what happened when none is left.
  const focusNext = useRef<string | null>(null);
  const removeBatchButton = useRef<HTMLButtonElement>(null);
  // The Remove that asked: where the focus goes back to should it be cancelled.
  const removeAsked = useRef<HTMLButtonElement | null>(null);

  // What happened, said where the focus is once the batch is drawn: a file
  // accepted on its card, and come back here.
  const drawn = data !== null;
  useEffect(() => {
    if (said && drawn) status.current?.focus();
  }, [said, drawn]);

  // While the worker draws their pages, asked again now and then.
  const drawing = data?.batch.items.some(
    (i) => i.state === 'waiting' && i.preview_state === 'pending',
  );
  const tries = useRef(0);
  useEffect(() => {
    if (!drawing || tries.current >= 30) return;
    const timer = setTimeout(() => {
      tries.current += 1;
      void reload();
    }, 4000);
    return () => clearTimeout(timer);
  }, [drawing, data, reload]);

  // After a removal: the next file's Accept, or the one before it, or the status.
  useEffect(() => {
    const next = focusNext.current;
    if (!next || !data) return;
    focusNext.current = null;
    const to = next === 'status' ? status.current : document.getElementById(`accept-${next}`);
    (to ?? heading.current)?.focus();
  }, [data]);

  const removeItem = async (item: BatchItemView) => {
    if (!data) return;
    setBusy(true);
    setProblem(null);
    const waiting = data.batch.items.filter((i) => i.state === 'waiting');
    const at = waiting.findIndex((i) => i.id === item.id);
    const next = waiting[at + 1] ?? waiting[at - 1] ?? null;
    try {
      await withToken((t) => api.removeBatchItem(t, data.batch.id, item.id));
      setAsking(null);
      setMessage(`“${item.name}” was removed: its file and its pages are gone from the vault.`);
      focusNext.current = next ? next.id : 'status';
      await reload();
    } catch (err) {
      setAsking(null);
      setProblem(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const removeBatch = async () => {
    if (!data) return;
    setBusy(true);
    try {
      await withToken((t) => api.removeBatch(t, data.batch.id));
      void navigate('/inbox', {
        state: {
          said: `“${batchLabel(data.batch)}” was removed, with what was not accepted in it.`,
        },
      });
    } catch (err) {
      setAsking(null);
      setProblem(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  if (error || !data) {
    return (
      <main className="page page-top has-nav">
        <TopBar title="A batch" back="/inbox" />
        {error ? (
          <ErrorNote message={error} />
        ) : (
          <p className="muted" aria-busy="true">
            Loading the batch…
          </p>
        )}
      </main>
    );
  }
  const b = data.batch;
  const waiting = b.items.filter((i) => i.state === 'waiting');
  const label = batchLabel(b);
  const row = (item: BatchItemView) => {
    const actions =
      item.state === 'waiting' ? (
        <span className="row item-actions">
          <Link
            id={`accept-${item.id}`}
            to={`/inbox/batches/${b.id}/items/${item.id}`}
            className="btn btn-primary btn-small"
            aria-label={`Accept ${item.name}`}
          >
            Accept
          </Link>
          <button
            type="button"
            className="btn btn-quiet btn-small"
            aria-label={`Remove ${item.name}`}
            onClick={(e) => {
              removeAsked.current = e.currentTarget;
              setAsking(item);
            }}
          >
            Remove
          </button>
        </span>
      ) : null;
    const about = `${sizeWords(item.byte_size)}${item.preview_pages ? ` · ${plural(item.preview_pages, 'page')}` : ''}`;
    return { actions, about };
  };

  return (
    <main className="page page-top page-wide has-nav batch-page">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to="/inbox">Inbox</Link> <span aria-hidden="true">›</span> <span>Your uploads</span>
      </nav>
      <div className="batch-head">
        <div className="stack batch-title">
          <h1 ref={heading} tabIndex={-1}>
            {label}
          </h1>
          <p className="muted">
            {plural(b.counts.items, 'file')} · made {shortDay(b.created_at)} · removed on{' '}
            {longDay(b.ends_at)} unless accepted
          </p>
          <DefaultsWords
            defaults={b.defaults}
            types={data.types}
            members={data.members}
            collections={data.collections}
          />
        </div>
        <div className="stack batch-actions">
          <OnlyYou />
          <div className="row">
            {mode !== 'phone' && (
              <Link className="btn btn-quiet" to={`/add/many?batch=${b.id}`}>
                Carry on uploading
              </Link>
            )}
            <button
              ref={removeBatchButton}
              type="button"
              className="btn btn-quiet btn-danger-quiet"
              onClick={() => setAsking('batch')}
            >
              Remove the batch
            </button>
          </div>
        </div>
      </div>
      <p role="status" ref={status} tabIndex={-1} className="status-line">
        {message}
      </p>
      <ErrorNote message={problem} />
      {b.items.length === 0 ? (
        <div className="notice-box">
          <strong>Nothing is in this batch yet.</strong>
          <span className="muted">
            {mode === 'phone'
              ? 'Send files to it from a computer.'
              : 'Carry on uploading to send files to it.'}
          </span>
        </div>
      ) : waiting.length === 0 ? (
        <div className="notice-box">
          <strong>Nothing left to check in this batch.</strong>
          <span className="muted">
            {plural(b.counts.accepted, 'file')} accepted as{' '}
            {b.counts.accepted === 1 ? 'a document' : 'documents'}. The batch goes on{' '}
            {longDay(b.ends_at)}, or when you remove it.
          </span>
        </div>
      ) : null}
      {b.items.length > 0 &&
        (mode === 'phone' ? (
          <ul className="list batch-items" aria-label={`Files in ${label}`}>
            {b.items.map((item) => {
              const r = row(item);
              return (
                <li key={item.id} className="batch-item">
                  <FirstPage batchId={b.id} item={item} />
                  <span className="stack batch-item-words">
                    <span className="doc-title clip">{item.name}</span>
                    <span className="muted">{r.about}</span>
                    <ItemState item={item} />
                    {r.actions}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="tbl-wrap batch-wrap">
            <table className="tbl batch-tbl">
              <caption className="visually-hidden">Files in {label}</caption>
              <colgroup>
                <col style={{ width: 64 }} />
                <col />
                <col style={{ width: 120 }} />
                <col style={{ width: 260 }} />
                <col style={{ width: 190 }} />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">
                    <span className="visually-hidden">First page</span>
                  </th>
                  <th scope="col">File</th>
                  <th scope="col">Size</th>
                  <th scope="col">State</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {b.items.map((item) => {
                  const r = row(item);
                  return (
                    <tr key={item.id}>
                      <td>
                        <FirstPage batchId={b.id} item={item} />
                      </td>
                      <td>
                        <span className="cell-title clip" title={item.name}>
                          {item.name}
                        </span>
                      </td>
                      <td className="muted">{r.about}</td>
                      <td>
                        <ItemState item={item} />
                      </td>
                      <td>{r.actions}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
      {asking && asking !== 'batch' && (
        <ConfirmDialog
          title={`Remove “${asking.name}”?`}
          confirmLabel="Remove it"
          busyLabel="Removing…"
          danger
          busy={busy}
          returnFocus={removeAsked}
          onConfirm={() => void removeItem(asking)}
          onCancel={() => setAsking(null)}
        >
          <p>
            Its file and its pages are removed from the vault. It was never a document, so nothing
            else changes.
          </p>
        </ConfirmDialog>
      )}
      {asking === 'batch' && (
        <ConfirmDialog
          title={`Remove “${label}”?`}
          confirmLabel="Remove the batch"
          busyLabel="Removing…"
          danger
          busy={busy}
          returnFocus={removeBatchButton}
          onConfirm={() => void removeBatch()}
          onCancel={() => setAsking(null)}
        >
          <p>
            {waiting.length > 0
              ? `${plural(waiting.length, 'file')} not accepted ${waiting.length === 1 ? 'is' : 'are'} removed from the vault, with ${waiting.length === 1 ? 'its' : 'their'} pages.`
              : 'Nothing in it is waiting.'}{' '}
            {b.counts.accepted > 0
              ? `What you accepted (${plural(b.counts.accepted, 'document')}) stays in the vault.`
              : ''}
          </p>
        </ConfirmDialog>
      )}
    </main>
  );
}

// ------------------------------------------------------------ the card

/**
 * One file's card (/inbox/batches/:id/items/:itemId): the single add's "Is
 * this right?", with a collection, tags and Essential too, each detail
 * starting from what the batch chose — where it chose anything; the rest
 * blank. Accepting files it as a document, and goes back to the batch.
 */
export function BatchItemScreen() {
  const { id, itemId } = useParams<{ id: string; itemId: string }>();
  const { withToken, caps } = useApp();
  const navigate = useNavigate();
  const role = storedRole();
  const { data, error } = useLoad(
    async (t) => {
      const [batch, types, members, collections] = await Promise.all([
        api.batch(t, id as string),
        api.documentTypes(t),
        api.members(t),
        caps?.features.collections && can(role, 'collection.manage')
          ? api.collections(t).then((r) => r.items)
          : Promise.resolve([] as CollectionView[]),
      ]);
      return { batch, types: types.items, members: members.items, collections };
    },
    [id, itemId],
  );
  const accept = useCallback(
    async (
      batch: BatchDetail,
      item: BatchItemView,
      details: Parameters<typeof captureDetails>[0],
      extra?: { collection_id: string | null },
    ) => {
      const sent = await withToken((t) =>
        api.acceptBatchItem(t, batch.id, item.id, {
          ...captureDetails(details),
          ...(details.tags !== undefined ? { tags: details.tags } : {}),
          ...(details.is_essential !== undefined ? { is_essential: details.is_essential } : {}),
          collection_id: extra?.collection_id ?? null,
        }),
      );
      if (!sent) return;
      const title = details.title ? `: ${details.title}` : '';
      void navigate(`/inbox/batches/${batch.id}`, {
        replace: true,
        state: { said: `“${item.name}” is a document now${title}.` },
      });
    },
    [withToken, navigate],
  );
  if (error || !data) {
    return (
      <main className="page page-top">
        <TopBar title="Is this right?" back={`/inbox/batches/${id ?? ''}`} />
        {error ? <ErrorNote message={error} /> : <p className="muted">Loading…</p>}
      </main>
    );
  }
  const { batch, types, members } = data;
  const item = batch.items.find((i) => i.id === itemId && i.state === 'waiting');
  if (!item) {
    return (
      <main className="page page-top">
        <TopBar title="Is this right?" back={`/inbox/batches/${batch.id}`} />
        <p className="muted">
          This file is not waiting any more: it was accepted or removed.{' '}
          <Link to={`/inbox/batches/${batch.id}`}>Back to the batch</Link>.
        </p>
      </main>
    );
  }
  const d = batch.defaults;
  const me = members.find((m) => m.is_me);
  const type = types.find((t) => t.key === d.type_key);
  const owner = role === 'teen' ? (me?.id ?? '') : (d.owner_member_id ?? '');
  const person = members.find((m) => m.id === owner);
  const startVisibility = (t: DocumentTypeView | undefined, o: string) =>
    batchVisibility({ chosen: d.visibility, type: t ?? null, role, owner: o, me: me?.id });
  const dup = dupWords(item);
  return (
    <ConfirmForm
      title="Is this right?"
      back={`/inbox/batches/${batch.id}`}
      lede="Check it, and accept it as a document. What you chose for the whole batch is filled in already; nothing else is."
      fileName={item.name}
      aside={
        <div className="stack batch-card-aside">
          <FirstPage batchId={batch.id} item={item} large />
          {dup && <p className="status status-warn">{dup}</p>}
        </div>
      }
      types={types}
      members={members}
      initial={{
        typeKey: type?.key ?? '',
        title: type ? autoTitle(type, person) : '',
        owner,
        issuer: '',
        issued: '',
        expires: '',
        identifier: '',
        location: d.physical_location ?? '',
        visibility: startVisibility(type, owner),
        notes: '',
        details: {},
      }}
      startVisibility={startVisibility}
      extras={{
        collections: addable(data.collections, role),
        collectionId: d.collection_id ?? '',
        tags: d.tags.join(', '),
        essential: d.is_essential,
      }}
      submitLabel="Accept as a document"
      onSubmit={(details, extra) => accept(batch, item, details, extra)}
    />
  );
}
