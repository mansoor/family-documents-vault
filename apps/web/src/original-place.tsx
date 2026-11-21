import {
  placeWords,
  seesLocation,
  type CabinetLayout,
  type DocumentView,
  type OriginalPlaceBulkResult,
} from '@fdv/shared';
import { useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link } from 'react-router';
import { api } from './api.js';
import { describeError, useApp, useLoad } from './app-context.js';
import { cabinetHref, FolderIcon, folderChoices } from './cabinet.js';
import { storedRole } from './session.js';
import { Button, ErrorNote, Sheet } from './ui.js';

/**
 * Where the original is, as a place in my cabinet (0.9.0, C3; the owner's
 * idea 5 of 13 Nov 2026): Cabinet › Drawer › Folder, picked from the
 * reader's own layout, beside the words written for where it is kept.
 *
 * Said once, the place first and the words after a middle dot — "Study ›
 * Drawer 2 › Tax 2025 · behind the blue divider" — to whoever sees where
 * originals are kept (owners, adults and teens), as the words have always
 * been. The place keeps its names on the document, so everybody reads the
 * same line; only its setter is given the folder to open.
 */

/** Whether places in a cabinet are offered to this reader: the vault keeps them, and they see where originals are. */
export function usePlacesOffered(): boolean {
  const { caps } = useApp();
  return (
    caps?.features.original_place === true &&
    caps.features.cabinets === true &&
    seesLocation(storedRole())
  );
}

/** "Study › Drawer 2 › Tax 2025": the place as one line. */
export function placeLine(doc: Pick<DocumentView, 'original_place'>): string | null {
  return doc.original_place ? placeWords(doc.original_place) : null;
}

/** The folders offered, those suggested for this paper first. */
function choicesOf(layout: CabinetLayout | null, suggested: readonly string[]) {
  const all = layout ? folderChoices(layout) : [];
  const first = all.filter((f) => suggested.includes(f.id));
  return { all, first, rest: all.filter((f) => !suggested.includes(f.id)) };
}

/**
 * A document's "Original is kept" row (C3): its place in a cabinet, a way
 * to that folder for whoever set it, the words written for it, and — for
 * whoever may change it — File it in my cabinet…, or Change….
 */
export function WhereKeptRow(props: {
  doc: DocumentView;
  label: string;
  mayChange: boolean;
  onSaved: (saved: DocumentView) => void;
}) {
  const { doc } = props;
  const offered = usePlacesOffered();
  const [picking, setPicking] = useState(false);
  const [said, setSaid] = useState('');
  const button = useRef<HTMLButtonElement>(null);
  const may = offered && props.mayChange && !doc.deleted_at && doc.caregiver !== true;
  if (!seesLocation(storedRole())) return null;
  const line = placeLine(doc);
  if (!line && !doc.physical_location && !may) return null;
  return (
    <>
      <dt>{props.label}</dt>
      <dd className="where-kept">
        {line && (
          <span className="where-kept-place">
            {doc.original_place?.folder_id ? (
              <Link to={cabinetHref({ folder: doc.original_place.folder_id })}>
                <FolderIcon />
                <span>{line}</span>
              </Link>
            ) : (
              <>
                <FolderIcon />
                <span>{line}</span>
              </>
            )}
          </span>
        )}
        {line && doc.physical_location && <span aria-hidden="true"> · </span>}
        {doc.physical_location && <span>{doc.physical_location}</span>}
        {may && (
          <>
            {' '}
            <button
              ref={button}
              type="button"
              className="btn btn-quiet btn-small"
              onClick={() => setPicking(true)}
            >
              {line ? 'Change folder…' : 'File it in my cabinet…'}
            </button>
          </>
        )}
        <span className="visually-hidden" role="status" aria-live="polite">
          {said}
        </span>
        {picking && (
          <PlaceSheet
            doc={doc}
            returnFocus={button}
            onClose={(news, saved) => {
              setPicking(false);
              if (saved) props.onSaved(saved);
              if (news) setSaid(news);
            }}
          />
        )}
      </dd>
    </>
  );
}

/**
 * Where one paper is filed (C3): one of the reader's own folders — those
 * whose question the paper answers offered first — or none. Saved through
 * the document's own edit, as the page loaded it.
 */
export function PlaceSheet(props: {
  doc: DocumentView;
  returnFocus: RefObject<HTMLElement | null>;
  onClose: (said: string | null, saved?: DocumentView) => void;
}) {
  const { doc } = props;
  const { authVersion, withToken } = useApp();
  const selectId = useId();
  const { data: layout, error: loadError } = useLoad(
    async (t) => (await api.cabinet(t)).layout,
    [authVersion],
  );
  const { data: suggested } = useLoad(
    async (t) => (await api.documentAlsoIn(t, doc.id)).items.map((f) => f.id),
    [authVersion, doc.id],
  );
  const { all, first, rest } = choicesOf(layout, suggested ?? []);
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mine = doc.original_place?.folder_id ?? '';
  const chosen = choice || mine || first[0]?.id || all[0]?.id || '';
  const save = async (folder: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await withToken((t) => api.setOriginalPlace(t, doc.id, folder, doc.etag));
      if (saved) {
        const line = placeLine(saved);
        props.onClose(line ? `Filed in ${line}.` : 'Taken out of the cabinet.', saved);
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      label="Where the original is filed"
      busy={busy}
      returnFocus={props.returnFocus}
      onClose={() => props.onClose(null)}
    >
      <div className="card stack">
        <h2 style={{ fontSize: 20 }}>Where the original is filed</h2>
        <p className="muted">
          Choose the folder in your cabinet where the paper is kept. Everyone who sees where
          originals are kept will read the whole path — your cabinet’s, drawer’s and folder’s names,
          such as “Study › Drawer 2 › Tax” — and it changes for them when you rename or move them.
          Only you can open the folder.
        </p>
        {loadError && <ErrorNote message={loadError} />}
        {layout !== null && all.length === 0 && <NoFolders />}
        {all.length > 0 && (
          <FolderSelect
            id={selectId}
            value={chosen}
            first={first}
            rest={rest}
            onChange={setChoice}
          />
        )}
        <ErrorNote message={error} />
        <div className="row">
          <Button disabled={busy || all.length === 0} onClick={() => void save(chosen)}>
            {busy ? 'Saving…' : 'File it here'}
          </Button>
          {doc.original_place && (
            <Button kind="quiet" disabled={busy} onClick={() => void save(null)}>
              Not in a folder
            </Button>
          )}
          <Button kind="quiet" disabled={busy} onClick={() => props.onClose(null)}>
            Cancel
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

/** Nowhere to file it yet: a way to make a cabinet. */
function NoFolders() {
  return (
    <p className="cab-none">
      Your cabinet has no folders yet.{' '}
      <Link to={cabinetHref({ arrange: true })}>Arrange my cabinet</Link> first.
    </p>
  );
}

/** The folders, as one select: those suggested for this paper first, in their own group. */
function FolderSelect(props: {
  id: string;
  label?: string;
  value: string;
  first: Array<{ id: string; path: string }>;
  rest: Array<{ id: string; path: string }>;
  onChange: (id: string) => void;
  /** Choices before the folders: "Leave as it is". */
  before?: ReactNode;
  /** And after them: "Take them out of their folders". */
  after?: ReactNode;
  /** Said under it. */
  note?: ReactNode;
}) {
  const option = (f: { id: string; path: string }) => (
    <option key={f.id} value={f.id}>
      {f.path}
    </option>
  );
  return (
    <div className="field">
      <label htmlFor={props.id}>{props.label ?? 'Folder'}</label>
      <select id={props.id} value={props.value} onChange={(e) => props.onChange(e.target.value)}>
        {props.before}
        {props.first.length > 0 ? (
          <>
            <optgroup label="Its folders in your cabinet">{props.first.map(option)}</optgroup>
            {props.rest.length > 0 && (
              <optgroup label="Your other folders">{props.rest.map(option)}</optgroup>
            )}
          </>
        ) : (
          props.rest.map(option)
        )}
        {props.after}
      </select>
      {props.note && <span className="muted">{props.note}</span>}
    </div>
  );
}

/** What the bulk sheet's select says when nothing is to change. */
export const LEAVE_PLACE = '';
/** And when the chosen are to be taken out of their folders. */
export const NO_PLACE = '__none';

/**
 * For many at once (C3, LocationSheet): a folder of the reader's cabinet,
 * "Leave as it is", or "Take them out of their folders" — nothing at all
 * where places are not offered, or there are no folders.
 */
export function BulkPlaceField(props: { value: string; onChange: (v: string) => void }) {
  const offered = usePlacesOffered();
  const { authVersion } = useApp();
  const id = useId();
  const { data: layout } = useLoad(
    async (t) => (offered ? (await api.cabinet(t)).layout : null),
    [authVersion, offered],
  );
  const { all } = choicesOf(layout, []);
  if (!offered || all.length === 0) return null;
  return (
    <FolderSelect
      id={id}
      label="Folder in my cabinet"
      value={props.value}
      first={[]}
      rest={all}
      onChange={props.onChange}
      before={<option value={LEAVE_PLACE}>Leave as it is</option>}
      after={<option value={NO_PLACE}>Take them out of their folders</option>}
      note="Everyone who sees where originals are kept reads the whole path: cabinet, drawer and folder."
    />
  );
}

/** The folder a bulk choice names, by its path; null for none, undefined for no change. */
export function bulkFolderOf(value: string): string | null | undefined {
  return value === LEAVE_PLACE ? undefined : value === NO_PLACE ? null : value;
}

/** What many set at once says (C3). */
export function bulkPlaceWords(r: OriginalPlaceBulkResult, folder: string | null): string {
  const n = r.changed.length;
  const what = `${n} document${n === 1 ? '' : 's'}`;
  const done =
    n === 0
      ? folder === null
        ? 'None was in a folder.'
        : 'Every one was in that folder already.'
      : folder === null
        ? `${what} taken out of their folders.`
        : `${what} now filed in the folder you chose.`;
  const left = r.not_yours.length;
  return left > 0
    ? `${done} ${left} ${left === 1 ? 'isn’t' : 'aren’t'} yours to change, and ${left === 1 ? 'was' : 'were'} left as ${left === 1 ? 'it was' : 'they were'}.`
    : done;
}

/**
 * File it here (C3): after a scan or an upload is filed, where its paper
 * will go — the folders of the reader's cabinet whose question it answers,
 * each one tap; another folder; or Not now. Nothing where places are not
 * offered, it has one already, or the reader has no folders.
 */
export function FileItHere(props: {
  doc: DocumentView;
  mayChange: boolean;
  onSaved: (saved: DocumentView) => void;
}) {
  const { doc } = props;
  const offered = usePlacesOffered() && props.mayChange && !doc.original_place;
  const { authVersion, withToken } = useApp();
  const [gone, setGone] = useState(false);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const headingId = `${useId()}-h`;
  const other = useRef<HTMLButtonElement>(null);
  const { data } = useLoad(
    async (t) => {
      if (!offered) return null;
      const [layout, alsoIn] = await Promise.all([
        api.cabinet(t).then((c) => c.layout),
        api.documentAlsoIn(t, doc.id).then((a) => a.items.map((f) => f.id)),
      ]);
      return choicesOf(layout, alsoIn);
    },
    [authVersion, doc.id, offered],
  );
  if (done) {
    return (
      <p className="file-it-here-done" role="status">
        {done}
      </p>
    );
  }
  if (!offered || gone || !data || data.all.length === 0) return null;
  const file = async (folder: string) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await withToken((t) => api.setOriginalPlace(t, doc.id, folder, doc.etag));
      if (saved) {
        setDone(`Filed in ${placeLine(saved) ?? 'your folder'}.`);
        props.onSaved(saved);
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card stack file-it-here" aria-labelledby={headingId}>
      <h2 id={headingId} style={{ fontSize: 18 }}>
        Where will the paper go?
      </h2>
      <p className="muted">
        {data.first.length > 0
          ? 'It belongs in this folder of your cabinet. Say where you file the original, and the family can find it.'
          : 'Say which folder of your cabinet you file the original in, and the family can find it.'}{' '}
        Everyone who sees where originals are kept reads the whole path — cabinet, drawer and folder
        — as you name them.
      </p>
      {data.first.length > 0 && (
        <ul className="file-it-here-folders">
          {data.first.slice(0, 3).map((f) => (
            <li key={f.id}>
              <Button disabled={busy} onClick={() => void file(f.id)}>
                <FolderIcon />
                File it in {f.path}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ErrorNote message={error} />
      <div className="row">
        <button
          ref={other}
          type="button"
          className="btn btn-quiet btn-small"
          disabled={busy}
          onClick={() => setPicking(true)}
        >
          {data.first.length > 0 ? 'Another folder…' : 'Choose a folder…'}
        </button>
        <button
          type="button"
          className="btn btn-quiet btn-small"
          disabled={busy}
          onClick={() => setGone(true)}
        >
          Not now
        </button>
      </div>
      {picking && (
        <PlaceSheet
          doc={doc}
          returnFocus={other}
          onClose={(news, saved) => {
            setPicking(false);
            if (saved) {
              setDone(news);
              props.onSaved(saved);
            }
          }}
        />
      )}
    </section>
  );
}
