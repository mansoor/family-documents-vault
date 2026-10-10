import {
  BATCH_MAX_FILES,
  BATCH_NAME_MAX,
  can,
  duplicateWords,
  LEVEL_WORDS,
  levelSummary,
  seesLocation,
  untouchedAccept,
  type BatchDefaults,
  type BatchItemView,
  type BatchLevel,
  type BatchView,
  type CollectionView,
  type DocumentTypeView,
  type Role,
  type Visibility,
} from '@fdv/shared';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, ApiRequestError, type Member } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { askPage, forgetPages, heldPage } from '../batch-pages.js';
import { labelOfDay, progressOf, useUploads } from '../batch-store.js';
import { newRun, useAcceptReady } from '../batch-review.js';
import { BATCH_ACCEPT } from '../batch-upload.js';
import { CollectionSelect, mayChangeCollection } from '../collections.js';
import { storedRole } from '../session.js';
import { useShellMode } from '../shell.js';
import { useShortcutsOn } from '../shortcuts.js';
import { useGrid } from '../table-grid.js';
import {
  Button,
  ConfirmDialog,
  ErrorNote,
  Field,
  Select,
  Switch,
  TopBar,
  useArrivedSaid,
} from '../ui.js';
import { SuggestedMark } from '../suggestions.js';
import { IncomingList, sizeWords } from './Incoming.js';

/**
 * Many documents at once (Phase 6, I1): Add → Many documents, the Inbox's
 * "Your uploads", a batch's page, and the card that accepts one of its
 * files as a document.
 *
 * A batch is its uploader's alone until each file in it is accepted (the
 * owner's decision Q3): nobody else in the family sees it, an owner
 * included. What the batch chooses for all of them fills only what is blank
 * on each card (Q4).
 *
 * The vault reads each file and suggests (I2): its level — Ready, Check,
 * Not recognised, a Problem — with tags that say why, the kind it looks
 * like and how sure; and its card starts from what the pages say, merged
 * with the batch's choices, each suggested detail marked.
 */

/** "6 Oct": the day, as a batch with no name is called by it. */
const shortDay = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/** "5 November": the day what is undecided is removed. */
const longDay = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });

/** A batch as it is called: its name, or the day it was made. */
export function batchLabel(b: { name: string | null; created_at: string }): string {
  return b.name ?? labelOfDay(b.created_at);
}

/** What an item duplicates, in words, with an unnamed batch called by its day. */
export const dupWords = (item: BatchItemView) =>
  item.duplicate ? duplicateWords(item.duplicate, batchLabel) : null;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** How many of a batch's waiting items are at each level (I2). */
const levelCounts = (items: readonly BatchItemView[]) => {
  const out: Partial<Record<BatchLevel, number>> = {};
  for (const i of items) {
    if (i.state === 'waiting' && i.level) out[i.level] = (out[i.level] ?? 0) + 1;
  }
  return out;
};

/** What the queue shows (I3): every file, a level's, or what is done. */
export type QueueFilter = '' | BatchLevel | 'done';

/** The queue's filters, in order, with their words. */
export const QUEUE_FILTERS: ReadonlyArray<readonly [QueueFilter, string]> = [
  ['', 'All'],
  ['ready', 'Ready'],
  ['check', 'Check'],
  ['unrecognised', 'Not recognised'],
  ['problem', 'Problems'],
  ['done', 'Done'],
];

/** The filter the address names, or every file. */
export const queueFilter = (v: string | null): QueueFilter =>
  QUEUE_FILTERS.some(([f]) => f === v) ? (v as QueueFilter) : '';

/** Whether an item is in the queue as filtered: at that level and waiting, or accepted for Done. */
export const inQueue = (filter: QueueFilter) => (i: BatchItemView) =>
  filter === ''
    ? true
    : filter === 'done'
      ? i.state === 'accepted'
      : i.state === 'waiting' && i.level === filter;

/** The name its card would start with (I3): what it would be filed as, untouched. */
export function proposedTitle(
  item: BatchItemView,
  defaults: BatchDefaults,
  types: DocumentTypeView[],
  members: Member[],
  role: Role,
): string | null {
  const me = members.find((m) => m.is_me)?.id;
  if (item.state !== 'waiting' || !item.proposals?.type_key || !me) return null;
  return (
    untouchedAccept({
      proposals: item.proposals,
      defaults,
      types,
      people: members,
      role,
      me,
    }).title ?? null
  );
}

/** Whose it is, as its card starts — or both, where the pages and the batch disagree. */
function ItemPerson({ item, members }: { item: BatchItemView; members: Member[] }) {
  const nameOf = (id: string) => members.find((m) => m.id === id)?.display_name ?? 'Somebody';
  if (item.state !== 'waiting') return <span className="muted">—</span>;
  const clash = item.clashes?.find((c) => c.field === 'owner_member_id');
  if (clash) {
    return (
      <span className="status status-warn">
        {nameOf(clash.pages.value)} or {nameOf(clash.batch)}?
      </span>
    );
  }
  const who = item.proposals?.owner_member_id;
  if (!who) return <span className="muted">—</span>;
  return <span className="clip">{nameOf(who.value)}</span>;
}

/** Whether somebody may make batches: the vault has them, and they add documents. */
export function useMayBatch(): { mayBatch: boolean; role: Role } {
  const { caps, session } = useApp();
  const role: Role = session.info?.role ?? storedRole();
  return { mayBatch: caps?.features.batches === true && can(role, 'document.add'), role };
}

/** The collections somebody may put documents in: their own, in an audience they are in. */
export const addable = (collections: CollectionView[], role: Role) =>
  collections.filter((c) => mayChangeCollection(role, c));

/** What only the uploader sees, said where it matters. */
export function OnlyYou({ children }: { children?: ReactNode }) {
  return (
    <p className="private-note">
      <span aria-hidden="true">🔒︎</span>{' '}
      {children ?? 'Only you can see these until you accept them.'}
    </p>
  );
}

// ------------------------------------------------------------ add many

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

/** As wide as a tablet, at least: by the width alone, never the height (WCAG 1.4.4, the I1 review). */
const TABLET = '(min-width: 768px)';
const watchTablet = (changed: () => void) => {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const list = window.matchMedia(TABLET);
  list.addEventListener?.('change', changed);
  return () => list.removeEventListener?.('change', changed);
};
const narrowNow = () =>
  typeof window.matchMedia === 'function' && !window.matchMedia(TABLET).matches;

/**
 * Add → Many documents (/add/many): files or a folder, what is chosen for
 * all of them, then the upload, one file after another, each file's
 * progress and all of it, said politely as each file arrives. A file the
 * vault would refuse — too big, a kind it does not take — is listed as not
 * sent, with why, and the rest carry on. Stop stops after the file being
 * sent. With `?batch=`, it carries on a batch already made: what arrived
 * already (by SHA-256) is not sent again.
 *
 * The upload is the app's, not the page's (the I1 review): the page may be
 * left while files go, and shows them again on return. Every visit is a new
 * location, so Add → Many documents after a finished upload starts a new
 * one. On a narrow screen it says a computer is quicker, and still works:
 * nothing is taken away by the layout.
 */
export function AddManyScreen() {
  const { key } = useLocation();
  return <AddMany key={key} visit={key} />;
}

function AddMany({ visit }: { visit: string }) {
  const { caps, withToken } = useApp();
  const { mayBatch, role } = useMayBatch();
  const narrow = useSyncExternalStore(watchTablet, narrowNow);
  const [params] = useSearchParams();
  const [upload, uploads] = useUploads();
  const navigate = useNavigate();
  useLayoutEffect(() => uploads.opened(visit), [uploads, visit]);
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
  const [name, setName] = useState('');
  const [owner, setOwner] = useState('');
  const [typeKey, setTypeKey] = useState('');
  const [visibility, setVisibility] = useState<Visibility | ''>('');
  const [location, setLocation] = useState('');
  const [collectionId, setCollectionId] = useState('');
  const [tags, setTags] = useState('');
  const [essential, setEssential] = useState(false);
  const [over, setOver] = useState(false);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const stopButton = useRef<HTMLButtonElement>(null);
  const outcome = useRef<HTMLParagraphElement>(null);
  const { chosen, phase, batch } = upload;
  const resumed = phase === 'choosing' ? (data?.batch ?? null) : null;
  const already = resumed?.items.length ?? 0;

  // The button that started it goes as it starts, and Stop as it ends: the
  // focus goes to Stop while files are sent, and then to what arrived.
  useEffect(() => {
    if (phase === 'sending') stopButton.current?.focus();
    if (phase === 'done' || phase === 'stopped') outcome.current?.focus();
  }, [phase]);

  const add = (files: File[]) => uploads.choose(files, { limit, already });

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

  /** Start: into the batch carried on, or a new one made with what was chosen. Pressed twice, once. */
  const start = () => {
    if (resumed) {
      void uploads.start(withToken, { carry: resumed, label: batchLabel(resumed) });
      return;
    }
    const d = defaultsChosen();
    void uploads.start(withToken, {
      make: { name: name.trim() || null, defaults: d },
      shown: { ...NO_DEFAULTS, ...d },
    });
  };

  /** Only me is the uploader's own (the I1 review): choosing it makes them whose these are. */
  const chooseVisibility = (v: Visibility | '') => {
    setVisibility(v);
    if (v === 'private' && me) setOwner(me.id);
  };
  const chooseOwner = (v: string) => {
    setOwner(v);
    // Only me never goes with somebody else, or with different people.
    if (visibility === 'private' && v !== me?.id) setVisibility('');
  };

  const counts = progressOf(upload);
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
  // Everybody of the family, as a file's card offers them: those who have
  // died after the living, and said so (the I1 review). A teen's are their own.
  const people = teen
    ? (data?.members ?? []).filter((m) => m.is_me)
    : [
        ...(data?.members ?? []).filter((m) => !m.is_deceased),
        ...(data?.members ?? []).filter((m) => m.is_deceased),
      ];
  const collections = data ? addable(data.collections, role) : [];
  const shownTypes = (data?.types ?? []).filter((t) => !t.hidden || t.key === typeKey);
  const carrying = locked ? upload.carryOn : resumed !== null;
  const label = locked && batch ? batch.label : resumed ? batchLabel(resumed) : null;

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
        <span>{carrying && label ? label : 'Add many documents'}</span>
      </nav>
      <h1>{carrying && label ? `Carry on: ${label}` : 'Add many documents'}</h1>
      <p className="lede">
        {carrying && !locked
          ? `Choose the same files or folder again: what is already in it (${plural(already, 'file')}) is not sent twice. A file you removed from this batch is sent again if you choose it.`
          : 'Each file waits in your Inbox, and becomes a document when you accept it. Nothing is a document, and nobody else sees it, until then.'}
      </p>
      {narrow && (
        <div className="notice-box">
          <strong>Adding many documents is quicker on a computer.</strong>
          <span className="muted">
            Checking a batch of files is easier on a wide screen. You can still choose and send them
            here.
          </span>
        </div>
      )}
      <ErrorNote message={loadError} />
      <p className="visually-hidden" role="status" aria-live="polite">
        {upload.said}
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
                  {phase === 'choosing' || phase === 'making'
                    ? `${plural(toSend.length, 'file')} · ${sizeWords(bytes)}`
                    : phase === 'sending'
                      ? `Sending ${Math.min(counts.arrived + 1, toSend.length)} of ${toSend.length}…`
                      : `${plural(counts.arrived, 'file')} arrived`}
                </h2>
                {phase === 'choosing' && (
                  <Button kind="link" onClick={() => uploads.takeAllOff()}>
                    Remove all
                  </Button>
                )}
              </div>
              {phase !== 'choosing' && phase !== 'making' && (
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
                        phase === 'choosing' || phase === 'making' ? (
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
                        onClick={() => uploads.takeOff(c.key)}
                      >
                        ×
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              <ErrorNote message={upload.problem} />
              {phase === 'sending' && (
                <div className="row">
                  <Button
                    ref={stopButton}
                    kind="quiet"
                    disabled={upload.stopping}
                    onClick={() => uploads.stop()}
                  >
                    Stop after this file
                  </Button>
                  <span className="muted">
                    You can leave this page: the files carry on going while the vault is open in
                    this tab.
                  </span>
                </div>
              )}
              {(phase === 'done' || phase === 'stopped') && batch && (
                <div className="stack">
                  <p role="status" ref={outcome} tabIndex={-1}>
                    {plural(counts.arrived, 'file')} arrived in “{batch.label}”
                    {counts.refused ? `; ${plural(counts.refused, 'file')} not sent` : ''}
                    {counts.waiting ? `; ${counts.waiting} still to send` : ''}.
                  </p>
                  <div className="row">
                    <Link className="btn btn-primary" to={`/inbox/batches/${batch.id}`}>
                      Open the batch
                    </Link>
                    {counts.waiting > 0 && (
                      <Button kind="quiet" onClick={() => void uploads.sendRest(withToken)}>
                        Send the rest
                      </Button>
                    )}
                    {/* A new visit, without ?batch=: a new batch, never the one carried on (the I1 check). */}
                    <Button kind="quiet" onClick={() => void navigate('/add/many')}>
                      Add another batch
                    </Button>
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
              {carrying
                ? 'Chosen when the batch was made. Each card starts from these.'
                : 'All optional. Each fills only what is blank on a file’s card, which you check before it becomes a document.'}
            </p>
          </div>
          {resumed || locked ? (
            // Chosen once: what the batch was made with, said, not asked again.
            <DefaultsWords
              defaults={
                (locked ? upload.defaults : null) ??
                resumed?.defaults ?? { ...NO_DEFAULTS, ...defaultsChosen() }
              }
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
                onChange={chooseOwner}
                options={[
                  { value: '', label: teen ? 'Mine' : 'Different people, or not sure' },
                  ...people.map((m) => ({
                    value: m.id,
                    label: m.is_deceased ? `${m.display_name} (passed away)` : m.display_name,
                  })),
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
                      onClick={() => chooseVisibility(v)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <span className="muted">
                  {visibility === 'private'
                    ? 'Only me is for your own documents: they are yours, and only you see them.'
                    : 'Never wider than you choose: a kind usually for the adults stays for the adults.'}
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
                <CollectionSelect
                  id="b-collection"
                  collections={collections}
                  value={collectionId}
                  onChange={setCollectionId}
                  role={role}
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
          {(phase === 'choosing' || phase === 'making') && (
            <Button disabled={!data || counts.waiting === 0 || phase === 'making'} onClick={start}>
              {phase === 'making'
                ? 'Making the batch…'
                : counts.waiting === 0
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
  /** A toast is shown (I3): room is left under the page for it. */
  toast?: boolean;
  children: ReactNode;
}) {
  return (
    <main className={`page page-top page-wide has-nav${props.toast ? ' has-toast' : ''}`}>
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
  const { caps, authVersion, withToken } = useApp();
  const role = storedRole();
  const mayReview = caps?.features.upload_requests === true && can(role, 'upload_request.create');
  const said = useArrivedSaid();
  const status = useRef<HTMLParagraphElement>(null);
  // The review queue (I3): each batch's levels, for Accept all Ready and Review.
  const levels = caps?.features.batch_review === true;
  const { data, error, reload } = useLoad(
    async (t) => {
      const [batches, sent] = await Promise.all([
        mayBatch
          ? api.batches(t, levels ? { levels } : {}).then((r) => r.items)
          : Promise.resolve([] as BatchView[]),
        mayReview ? api.incoming(t).then((r) => r.items.length) : Promise.resolve(null),
      ]);
      return { batches, sent };
    },
    [authVersion, mayBatch, mayReview, levels],
  );
  const ready = useAcceptReady({
    changed: reload,
    // The toast put away: back to the batch's own row (the I3 review, W-I3-4).
    fallback: (id) =>
      document.querySelector<HTMLElement>(`a.batch-row[href="/inbox/batches/${id}"]`),
  });
  const [asked, setAsked] = useState<string | null>(null);
  /**
   * From the Inbox, the batch read first, and its Ready files asked about
   * by id, as the queue asks: the question's count is what is sent (the I3
   * review, W-I3-3).
   */
  const askReady = async (b: BatchView, from: HTMLElement) => {
    setAsked(null);
    try {
      const now = await withToken((t) => api.batch(t, b.id));
      if (!now) return;
      const ids = now.items.filter((i) => i.state === 'waiting' && i.level === 'ready');
      if (ids.length === 0) {
        setAsked(`Nothing in “${batchLabel(b)}” is Ready now.`);
        await reload();
        return;
      }
      ready.open(
        {
          batchId: b.id,
          itemIds: ids.map((i) => i.id),
          names: new Map(now.items.map((i) => [i.id, i.name])),
        },
        from,
      );
    } catch (err) {
      setAsked(describeError(err));
    }
  };
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
      toast={ready.toastShown}
      action={
        // At every width: a narrow window is told a computer is quicker, not refused.
        <Link className="btn btn-primary" to="/add/many">
          Add many documents
        </Link>
      }
    >
      <p role="status" ref={status} tabIndex={-1} className="status-line">
        {said}
      </p>
      <ErrorNote message={error} />
      <p className="status-line" role="status">
        {asked}
      </p>
      {ready.element}
      <OnlyYou>
        Only you can see these until you accept them. Anything not decided within 30 days is
        removed.
      </OnlyYou>
      {!data && !error && <p className="muted">Loading your uploads…</p>}
      {data && data.batches.length === 0 && (
        <div className="notice-box">
          <strong>Nothing you uploaded is waiting.</strong>
          <span className="muted">
            Add many documents at once, and they wait here for you to check.
          </span>
        </div>
      )}
      {data && data.batches.length > 0 && (
        <ul className="list batch-list" aria-label="Your uploads">
          {data.batches.map((b) => {
            const l = b.levels;
            // Read and waiting: what there is to review now (I3).
            const toReview = l ? l.ready + l.check + l.unrecognised + l.problem : 0;
            return (
              <li key={b.id} className={l ? 'batch-li' : undefined}>
                <Link to={`/inbox/batches/${b.id}`} className="rowbtn batch-row">
                  <span className="doc-title">{batchLabel(b)}</span>
                  <span className="muted">
                    {plural(b.counts.items, 'file')} ·{' '}
                    {b.counts.waiting > 0
                      ? `${b.counts.waiting} waiting`
                      : b.counts.items > 0
                        ? 'nothing left to check'
                        : 'nothing in it yet'}
                    {b.counts.duplicates > 0
                      ? ` · ${plural(b.counts.duplicates, 'duplicate')}`
                      : ''}
                  </span>
                  {l && b.counts.waiting > 0 && (
                    <span className="muted">
                      {levelSummary(l) || 'None read yet'}
                      {l.unread > 0 ? ` · ${l.unread} still to read` : ''}
                    </span>
                  )}
                  <span className="muted">
                    Made {shortDay(b.created_at)} · removed on {longDay(b.ends_at)} unless accepted
                  </span>
                </Link>
                {l && (l.ready > 0 || toReview > 0) && (
                  <span className="row batch-li-actions">
                    {l.ready > 0 && (
                      <button
                        type="button"
                        className="btn btn-quiet btn-small"
                        aria-label={`Accept all Ready in ${batchLabel(b)} (${l.ready})`}
                        onClick={(e) => void askReady(b, e.currentTarget)}
                      >
                        Accept all Ready ({l.ready})
                      </button>
                    )}
                    {toReview > 0 && (
                      <Link
                        className="btn btn-primary btn-small"
                        to={`/inbox/batches/${b.id}`}
                        aria-label={`Review ${toReview} in ${batchLabel(b)}`}
                      >
                        Review {toReview}
                      </Link>
                    )}
                  </span>
                )}
              </li>
            );
          })}
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

/** How many rows draw their first page at once where the browser cannot say which are in view. */
const FIRST_FEW = 8;

/**
 * An item's first page, drawn by the worker: a picture when there is one, a
 * blank until then. Only for a file still waiting (an accepted one's pages
 * went with its bytes); asked for as its row comes near the screen, a few at
 * a time (batch-pages.ts), and kept, so coming back asks for nothing. A
 * browser that cannot say what is in view draws the first few (`eager`).
 */
export function FirstPage(props: {
  batchId: string;
  item: BatchItemView;
  large?: boolean;
  eager: boolean;
}) {
  const { withToken } = useApp();
  const [url, setUrl] = useState<string | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  const { batchId, eager } = props;
  const itemId = props.item.id;
  const ready =
    props.item.state === 'waiting' &&
    props.item.preview_state === 'ready' &&
    (props.item.preview_pages ?? 0) > 0;
  const shown = ready ? (heldPage(itemId) ?? url) : null;
  useEffect(() => {
    if (!ready || heldPage(itemId)) return;
    let gone = false;
    let asked: { cancel: () => void } | null = null;
    const ask = () => {
      const page = askPage(itemId, () =>
        withToken((t) => api.batchItemPage(t, batchId, itemId, 1)),
      );
      asked = page;
      void page.done.then((made) => {
        if (!gone && made) setUrl(made);
      });
    };
    if (typeof IntersectionObserver === 'undefined') {
      if (eager) ask();
    } else {
      const seen = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          seen.disconnect();
          ask();
        },
        { rootMargin: '200px' },
      );
      if (box.current) seen.observe(box.current);
      return () => {
        gone = true;
        seen.disconnect();
        asked?.cancel();
      };
    }
    return () => {
      gone = true;
      asked?.cancel();
    };
  }, [ready, batchId, itemId, eager, withToken]);
  const cls = props.large ? 'firstpage firstpage-large' : 'firstpage';
  if (shown) return <img className={cls} src={shown} alt={`First page of ${props.item.name}`} />;
  return (
    <span ref={box} className={`${cls} firstpage-none`} aria-hidden="true">
      {props.item.state === 'waiting' && props.item.preview_state === 'pending'
        ? '…'
        : props.item.content_type === 'application/pdf'
          ? 'PDF'
          : 'FILE'}
    </span>
  );
}

/** Each level's mark: an icon beside its words, never its colour alone (I2). */
export function LevelIcon({ level }: { level: BatchLevel }) {
  const path =
    level === 'ready'
      ? 'M3.5 8.5l3 3 6-7'
      : level === 'unrecognised'
        ? 'M6 6a2 2 0 1 1 3 1.7c-.6.4-1 .8-1 1.6M8 12v.5'
        : 'M8 3.5v5.5M8 11.5v.5';
  return (
    <svg className="level-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      {level === 'check' || level === 'problem' ? (
        <path d="M8 1.5l7 13H1z" fill="none" stroke="currentColor" strokeWidth="1.6" />
      ) : (
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      )}
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/** An item's level, in words with its icon: what a screen reader hears too. */
export function LevelBadge({ level }: { level: BatchLevel }) {
  return (
    <span className={`level level-${level}`}>
      <LevelIcon level={level} />
      {LEVEL_WORDS[level]}
    </span>
  );
}

/**
 * Its tags (I2): why it is at its level. A duplicate is said as I1 says it,
 * an unnamed batch called by its day, a document it duplicates one press
 * away.
 */
export function ItemTags({
  item,
  full = false,
  stop,
}: {
  item: BatchItemView;
  full?: boolean;
  /** In the queue (I3): the row's stop, so Tab passes the rows the keys move between. */
  stop?: number;
}) {
  const tags = item.tags ?? [];
  if (tags.length === 0) return null;
  return (
    <ul className="item-tags" aria-label="Why">
      {tags.map((t) => (
        <li key={`${t.code}:${t.field ?? ''}`} className={`item-tag item-tag-${t.kind}`}>
          {t.code === 'duplicate_document' && item.duplicate?.of === 'document' ? (
            <Link to={`/documents/${item.duplicate.document_id}`} tabIndex={stop}>
              {dupWords(item)}
            </Link>
          ) : t.code.startsWith('duplicate_') ? (
            dupWords(item)
          ) : (
            t.words
          )}
          {full && t.detail && <span className="item-tag-detail">{t.detail}</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * What an item is now, in words: waiting to be read, being read, its level
 * and why — or accepted. A vault from before I2 says nothing of levels: an
 * item then is "waiting to be read", with its duplicate, as I1 said it.
 */
function ItemState({ item, stop }: { item: BatchItemView; stop?: number }) {
  if (item.state === 'accepted') {
    return (
      <span className="item-state">
        <span className="status status-ok">Accepted</span>
        {item.document_id ? (
          <Link
            to={`/documents/${item.document_id}`}
            className="quiet-link"
            // The queue's Done (I3): the row's own stop for its keys.
            {...(stop !== undefined ? { tabIndex: stop, 'data-row-target': '' } : {})}
          >
            Open the document
          </Link>
        ) : stop !== undefined ? (
          // A document they can no longer see: the row still has its stop,
          // so Tab and the keys reach the rows after it (the I3 review, W-I3-5).
          <span className="muted" tabIndex={stop} data-row-target="">
            You can no longer see the document
          </span>
        ) : (
          // In the table, R2's grid: its cell takes the focus itself.
          <span className="muted">You can no longer see the document</span>
        )}
      </span>
    );
  }
  if (item.level === undefined) {
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
  return (
    <span className="item-state">
      {item.level ? (
        <LevelBadge level={item.level} />
      ) : (
        <span className="status status-neutral">
          {item.reading === 'reading' ? 'Reading…' : 'Waiting to be read'}
        </span>
      )}
      <ItemTags item={item} {...(stop !== undefined ? { stop } : {})} />
    </span>
  );
}

/** The kind it looks like, and how sure — or the batch's — or nothing yet. */
function ItemKind({ item, types }: { item: BatchItemView; types: DocumentTypeView[] }) {
  const kind = item.proposals?.type_key;
  if (item.state !== 'waiting' || !kind) return <span className="muted">—</span>;
  const label = types.find((t) => t.key === kind.value)?.label ?? kind.value;
  return (
    <span className="item-kind">
      <span className="clip">{label}</span>
      {kind.from === 'batch' || kind.confidence === null || kind.cue === null ? (
        <span className="mark-batch">from the batch</span>
      ) : (
        <SuggestedMark confidence={kind.confidence} cue={kind.cue} />
      )}
    </span>
  );
}

/**
 * Whether an item is still to be read: waiting for the worker, or on it now
 * — by a vault that reads them (its items have a `level`); an older one
 * never reads, and is not waited for.
 */
const toRead = (i: BatchItemView) =>
  i.state === 'waiting' &&
  i.level !== undefined &&
  (i.reading === 'waiting' || i.reading === 'reading');

/**
 * While the worker draws and reads: asked again every 4 seconds, twice as
 * long after each failure up to a minute — 30 times with nothing new read,
 * the count starting again whenever an item is read (I2). Then, while any
 * item is still to be read (behind another batch, or a long OCR), once a
 * minute (`after`), until none is or the batch is gone (the I2 review).
 * Changed only by the tests.
 */
export const batchPolling = { every: 4000, most: 60_000, times: 30, after: 60_000 };

/** Answers in a row with nothing of a batch's on the worker before it is said to wait its turn. */
const WAITING_ITS_TURN = 4;

/**
 * A batch (/inbox/batches/:id): its files, each with its first page when
 * drawn, its name, size and pages, and what it is now — waiting to be read,
 * a duplicate, accepted. Accept opens its card; Remove asks first; Remove
 * the batch removes what is undecided; Carry on sends more of it.
 *
 * A reload that fails with the batch on the screen keeps it there — the
 * table, a dialog open, the focus — and says so beside it; the asking goes
 * on, more slowly (the I1 review).
 */
export function BatchScreen() {
  const { id } = useParams<{ id: string }>();
  const { withToken, caps } = useApp();
  const [, uploads] = useUploads();
  const role = storedRole();
  const navigate = useNavigate();
  const mode = useShellMode();
  // What the card said it did — a file accepted, the run at its end — read
  // as the screen opens and taken out of the history entry (R5): Back to
  // here later neither says it again nor takes the focus for it.
  const said = useArrivedSaid();
  const [message, setMessage] = useState<string | null>(said);
  const status = useRef<HTMLParagraphElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // Removed — here, elsewhere, or by its end — while on the screen (the I2 review).
  const [gone, setGone] = useState(false);
  const { data, error, loading, reload } = useLoad(
    async (t) => {
      const [batch, members, types, collections] = await Promise.all([
        api.batch(t, id as string).catch((err: unknown) => {
          if (err instanceof ApiRequestError && err.status === 404) setGone(true);
          throw err;
        }),
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
  // The review queue (I3): which files are shown, kept in the address; the
  // row the keys move from; Accept all Ready, asked and then its toast.
  const [params, setParams] = useSearchParams();
  const filter = queueFilter(params.get('level'));
  const shortcuts = useShortcutsOn();
  const [active, setActive] = useState<string | null>(null);
  // From 768 px the queue is R2's grid, as Documents and the Trash are: one
  // stop for Tab, the arrows between its cells — and j and k between the
  // rows, while single keys are on. The stop starts on the first file's
  // name. Drawn again as files are shown, accepted or removed.
  const queueTable = useRef<HTMLTableElement>(null);
  const queueWrap = useRef<HTMLDivElement>(null);
  const grid = useGrid(
    queueTable,
    queueWrap,
    [
      (data?.batch.items ?? [])
        .filter(inQueue(filter))
        .map((i) => `${i.id}:${i.state}:${i.level ?? ''}`)
        .join(','),
      mode,
    ],
    { start: { row: 1, col: 1 }, jk: shortcuts },
  );
  const names = useMemo(
    () => new Map((data?.batch.items ?? []).map((i) => [i.id, i.name])),
    [data],
  );
  const ready = useAcceptReady({
    changed: reload,
    names,
    // The toast put away, its button gone: the status line, or the heading (W-I3-4).
    fallback: () => status.current ?? heading.current,
  });
  const choose = (v: QueueFilter) =>
    setParams(
      (was) => {
        const next = new URLSearchParams(was);
        if (v) next.set('level', v);
        else next.delete('level');
        return next;
      },
      { replace: true },
    );

  // What happened, said where the focus is once the batch is drawn: a file
  // accepted on its card, and come back here.
  const drawn = data !== null;
  useEffect(() => {
    if (said && drawn) status.current?.focus();
  }, [said, drawn]);

  // A file decided, here or elsewhere: its first page let go.
  useEffect(() => {
    if (data) forgetPages(data.batch.items.filter((i) => i.state !== 'waiting').map((i) => i.id));
  }, [data]);

  // While the worker draws their pages and reads them, asked again now and
  // then: after a failure, twice as long each time, up to a minute; and not
  // for ever — but each item read starts the count again (I2).
  const drawing = data?.batch.items.some(
    (i) => (i.state === 'waiting' && i.preview_state === 'pending') || toRead(i),
  );
  const tries = useRef(0);
  const failures = useRef(0);
  const readSoFar = data?.batch.items.filter((i) => i.state === 'waiting' && !toRead(i)).length;
  useEffect(() => {
    tries.current = 0;
  }, [readSoFar]);
  useEffect(() => {
    if (loading) return;
    failures.current = error ? failures.current + 1 : 0;
  }, [loading, error]);
  const stillToRead = data ? data.batch.items.some(toRead) : false;
  // Answers in a row with something still to read and nothing of it on the
  // worker: between a job's drawing and its reading there is none for a
  // moment, so it is said to wait its turn only after a few (the I2 check).
  const [idle, setIdle] = useState(0);
  useEffect(() => {
    if (!data) return;
    const items = data.batch.items;
    const onIt = items.some((i) => i.state === 'waiting' && i.reading === 'reading');
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIdle((n) => (items.some(toRead) && !onIt ? n + 1 : 0));
  }, [data]);
  useEffect(() => {
    if (gone || !drawing || loading) return;
    // Asked out: once a minute, while anything is still to be read.
    const slow = tries.current >= batchPolling.times;
    if (slow && !stillToRead) return;
    const wait = slow
      ? batchPolling.after
      : Math.min(batchPolling.every * 2 ** failures.current, batchPolling.most);
    const timer = setTimeout(() => {
      tries.current += 1;
      void reload();
    }, wait);
    return () => clearTimeout(timer);
  }, [gone, drawing, stillToRead, loading, data, error, reload]);

  // Reading, said politely once it starts and once it ends — never at each
  // item (I2): the line on the page moves; this is what is heard.
  const reading = data ? data.batch.items.some(toRead) : false;
  const wasReading = useRef<boolean | null>(null);
  const [heard, setHeard] = useState('');
  useEffect(() => {
    if (!data) return;
    const before = wasReading.current;
    wasReading.current = reading;
    if (before === null || before === reading) return;
    const left = data.batch.items.filter(toRead).length;
    setHeard(
      reading
        ? `Reading the files: ${plural(left, 'file')} to read.`
        : `All read. ${levelSummary(levelCounts(data.batch.items)) || 'Nothing is waiting.'}`,
    );
  }, [reading, data]);

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
      forgetPages([item.id]);
      uploads.changed();
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
      forgetPages(data.batch.items.map((i) => i.id));
      uploads.changed();
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

  if (gone) {
    return (
      <main className="page page-top has-nav">
        <TopBar title="A batch" back="/inbox" />
        <div className="notice-box" role="status">
          <strong>This batch was removed.</strong>
          <span className="muted">
            What was not accepted in it went with it; what was accepted is in the vault.{' '}
            <Link to="/inbox">Back to the Inbox</Link>
          </span>
        </div>
      </main>
    );
  }
  if (!data) {
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
  // "12 Ready, 5 Check, 2 Not recognised, 1 Problem", and "Reading 3 of 20…" (I2).
  const summary = levelSummary(levelCounts(b.items));
  const unread = b.items.filter(toRead).length;
  // None of this batch's on the worker yet: it waits its turn, behind another's (the I2 review).
  const progress =
    unread === 0
      ? null
      : idle < WAITING_ITS_TURN
        ? `Reading ${b.items.length - unread + 1} of ${b.items.length}…`
        : `Waiting its turn to be read: ${plural(unread, 'file')} to read`;
  // The queue (I3): the files at the level chosen, in the batch's order;
  // Done is what was accepted (and how many were removed).
  const counted = levelCounts(b.items);
  const readyIds = waiting.filter((i) => i.level === 'ready').map((i) => i.id);
  const removedCount = b.counts.removed ?? 0;
  const shown = b.items.filter(inQueue(filter));
  const reviewing = caps?.features.batch_review === true;
  // One stop for Tab in the list: the row last moved to, or the first.
  const activeId = shown.some((i) => i.id === active) ? active : (shown[0]?.id ?? null);
  const stop = (item: BatchItemView) => (item.id === activeId ? 0 : -1);
  // Opened from the queue: the files to go through, as they stand now.
  const run = newRun(
    shown.filter((i) => i.state === 'waiting').map((i) => i.id),
    filter,
  );
  const itemPath = (item: BatchItemView) => ({
    pathname: `/inbox/batches/${b.id}/items/${item.id}`,
    search: filter && filter !== 'done' ? `?level=${filter}` : '',
  });
  /** ↑ ↓ (and j k, while single keys are on), Home and End: from row to row. */
  const rowKeys = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const down = e.key === 'ArrowDown' || (shortcuts && e.key === 'j');
    const up = e.key === 'ArrowUp' || (shortcuts && e.key === 'k');
    if (!down && !up && e.key !== 'Home' && e.key !== 'End') return;
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-row]')];
    const at = rows.findIndex((r) => r.contains(e.target as Node));
    if (at < 0) return;
    e.preventDefault();
    // The next row with somewhere to go, that way; never a row without (W-I3-5).
    const targets = rows.map((r) => r.querySelector<HTMLElement>('[data-row-target]'));
    const order =
      e.key === 'Home'
        ? targets
        : e.key === 'End'
          ? [...targets].reverse()
          : down
            ? targets.slice(at + 1)
            : targets.slice(0, at).reverse();
    order.find((t) => t !== null)?.focus();
  };
  /**
   * A click on a waiting file's row, anywhere but on its own controls:
   * its card, as its name and its Accept open it (the owner's report).
   * Keyboard users have the name's link; a word being chosen to copy is
   * not a click.
   */
  const openRow = (e: ReactMouseEvent<HTMLElement>, item: BatchItemView) => {
    if (item.state !== 'waiting' || e.defaultPrevented || e.button !== 0) return;
    if ((e.target as HTMLElement).closest('a, button, input, label, select, textarea')) return;
    if (window.getSelection?.()?.toString()) return;
    void navigate(itemPath(item), { state: { run } });
  };
  /**
   * A row's own stops: on a phone, the row's one stop (I3); in the table,
   * none — the grid gives each cell's its own (useGrid).
   */
  const stops = (item: BatchItemView, inGrid: boolean) => (inGrid ? {} : { tabIndex: stop(item) });
  /** A waiting file's name: the way to its card, a stop in its row's one stop. */
  const nameLink = (item: BatchItemView, words: string, className: string, inGrid = false) =>
    item.state === 'waiting' ? (
      <Link
        to={itemPath(item)}
        state={{ run }}
        className={`${className} item-name`}
        title={words}
        {...stops(item, inGrid)}
      >
        {words}
      </Link>
    ) : (
      <span className={className} title={words}>
        {words}
      </span>
    );
  const row = (item: BatchItemView, inGrid = false) => {
    // Ready is accepted as it is; anything else is opened to be looked at
    // first, and is said so (the owner's report).
    const review = item.level !== undefined && item.level !== 'ready';
    const verb = review ? 'Review' : 'Accept';
    const waits = item.state === 'waiting';
    const accept = waits ? (
      <Link
        id={`accept-${item.id}`}
        to={itemPath(item)}
        state={{ run }}
        className="btn btn-primary btn-small"
        aria-label={`${verb} ${item.name}`}
        {...(inGrid ? {} : { 'data-row-target': '' })}
        {...stops(item, inGrid)}
      >
        {verb}
      </Link>
    ) : null;
    const remove = waits ? (
      <button
        type="button"
        className="btn btn-quiet btn-small"
        aria-label={`Remove ${item.name}`}
        {...stops(item, inGrid)}
        onClick={(e) => {
          removeAsked.current = e.currentTarget;
          setAsking(item);
        }}
      >
        Remove
      </button>
    ) : null;
    const actions = waits ? (
      <span className="row item-actions">
        {accept}
        {remove}
      </span>
    ) : null;
    const about = `${sizeWords(item.byte_size)}${item.preview_pages ? ` · ${plural(item.preview_pages, 'page')}` : ''}`;
    return { actions, accept, remove, about };
  };

  return (
    <main
      className={`page page-top page-wide has-nav batch-page${ready.toastShown ? ' has-toast' : ''}`}
    >
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
          {summary && <p className="batch-summary">{summary}</p>}
          {progress && (
            <p className="batch-progress">
              <span className="spinner" aria-hidden="true" />
              {progress}
            </p>
          )}
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
            <Link className="btn btn-quiet" to={`/add/many?batch=${b.id}`}>
              Carry on uploading
            </Link>
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
      <p className="visually-hidden" aria-live="polite">
        {heard}
      </p>
      <ErrorNote message={problem ?? error} />
      {b.items.length === 0 ? (
        <div className="notice-box">
          <strong>Nothing is in this batch yet.</strong>
          <span className="muted">Carry on uploading to send files to it.</span>
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
      {b.items.length > 0 && (
        // The queue's levels (I3): each with how many, kept in the address.
        <div className="levelfilters" role="group" aria-label="Show">
          {QUEUE_FILTERS.map(([v, words]) => {
            const n =
              v === ''
                ? b.items.length
                : v === 'done'
                  ? b.counts.accepted + removedCount
                  : (counted[v] ?? 0);
            return (
              <button
                key={v || 'all'}
                type="button"
                className="lf"
                aria-pressed={filter === v}
                onClick={() => choose(v)}
              >
                {v !== '' && v !== 'done' && <LevelIcon level={v} />}
                {words}
                <span className="lf-n">{n}</span>
              </button>
            );
          })}
          {reviewing && readyIds.length > 0 && (
            <button
              type="button"
              className="btn btn-primary queue-accept"
              onClick={(e) => ready.open({ batchId: b.id, itemIds: readyIds }, e.currentTarget)}
            >
              Accept all Ready ({readyIds.length})
            </button>
          )}
        </div>
      )}
      {/* The toast, under the levels: on a short screen it stays here, in the
          page, never over what has the focus (the I3 review, W-I3-6). */}
      {ready.element}
      {b.items.length > 0 && shown.length === 0 && (
        <p className="muted queue-none">
          {filter === 'done'
            ? removedCount > 0
              ? `None accepted yet; ${plural(removedCount, 'file')} removed.`
              : 'Nothing decided yet.'
            : 'None at this level.'}
        </p>
      )}
      {shown.length > 0 &&
        (mode === 'phone' ? (
          <ul className="list batch-items" aria-label={`Files in ${label}`} onKeyDown={rowKeys}>
            {shown.map((item, i) => {
              const r = row(item);
              return (
                <li
                  key={item.id}
                  className={`batch-item${item.state === 'waiting' ? ' row-opens' : ''}`}
                  data-row=""
                  onFocus={() => setActive(item.id)}
                  onClick={(e) => openRow(e, item)}
                >
                  <FirstPage batchId={b.id} item={item} eager={i < FIRST_FEW} />
                  <span className="stack batch-item-words">
                    {nameLink(item, item.name, 'doc-title clip')}
                    <span className="muted">{r.about}</span>
                    {item.state === 'waiting' && item.proposals?.type_key && (
                      <ItemKind item={item} types={data.types} />
                    )}
                    <ItemState item={item} stop={stop(item)} />
                    {r.actions}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <div ref={queueWrap} className="tbl-wrap batch-wrap">
            <table
              ref={queueTable}
              className="tbl batch-tbl"
              role="grid"
              onKeyDown={grid.onKeyDown}
              onFocus={grid.onFocus}
            >
              <caption className="visually-hidden">
                Files in {label}
                {filter ? `: ${QUEUE_FILTERS.find(([v]) => v === filter)?.[1] ?? ''}` : ''}
              </caption>
              <colgroup>
                <col style={{ width: 64 }} />
                <col />
                <col className="batch-col-kind" />
                <col className="batch-col-person" />
                <col className="batch-col-level" />
                <col style={{ width: 100 }} />
                <col style={{ width: 108 }} />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">
                    <span className="visually-hidden">First page</span>
                  </th>
                  <th scope="col">File</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Whose</th>
                  <th scope="col">Level</th>
                  {/* Accept (or Review), and Remove: a cell each, as the
                      grid moves between them. */}
                  <th scope="colgroup" colSpan={2}>
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((item, i) => {
                  const r = row(item, true);
                  const title = proposedTitle(item, b.defaults, data.types, data.members, role);
                  return (
                    <tr
                      key={item.id}
                      className={item.state === 'waiting' ? undefined : 'row-still'}
                      onClick={(e) => openRow(e, item)}
                    >
                      <td>
                        <FirstPage batchId={b.id} item={item} eager={i < FIRST_FEW} />
                      </td>
                      <td>
                        {nameLink(item, title ?? item.name, 'cell-title clip', true)}
                        <span className="muted clip" title={item.name}>
                          {title ? `${item.name} · ` : ''}
                          {r.about}
                        </span>
                      </td>
                      <td>
                        <ItemKind item={item} types={data.types} />
                      </td>
                      <td>
                        <ItemPerson item={item} members={data.members} />
                      </td>
                      <td>
                        <ItemState item={item} />
                      </td>
                      <td>{r.accept}</td>
                      <td>{r.remove}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
      {filter === 'done' && shown.length > 0 && removedCount > 0 && (
        <p className="muted">And {plural(removedCount, 'file')} removed: not documents.</p>
      )}
      {shown.some((i) => i.state === 'waiting') && (
        <p className="muted queue-hint">
          Open a file to check it: Enter accepts it and opens the next.{' '}
          {shortcuts
            ? 'Up and down arrows, or j and k, move between the files.'
            : 'Up and down arrows move between the files.'}
        </p>
      )}
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
