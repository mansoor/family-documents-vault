import { placeWords, THE_HOUSEHOLD, CAREGIVER_MARK, type DocumentView } from '@fdv/shared';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { useSearchParams } from 'react-router';
import { api } from './api.js';
import { describeError, useApp } from './app-context.js';
import {
  COLLECTION_HIDDEN_BY_DEFAULT,
  COLLECTION_HIDDEN_COLUMNS_KEY,
  columnsFor,
  documentsCount,
  FILTER_KEYS,
  folderChipCount,
  MOST_AT_ONCE,
  queryOf,
  readHidden,
  tableDate,
  viewFrom,
  VISIBILITY_WORDS,
  type Column,
  type TableView,
} from './documents-table.js';
import { NOTHING, PrintOut } from './print.js';
import {
  directionWords,
  FILTER_LABELS,
  choiceWords,
  SORT_LABELS,
  titleOf,
  type Known,
} from './screens/Documents.js';
import { storedRole } from './session.js';
import { Button, Check, Dialog, ErrorNote } from './ui.js';

/**
 * Printing a collection's contents (0.9.0): a table of what is in it, with
 * the columns its table shows on this device (Columns), in its sort and
 * through its filters — every document of it the vault gives the reader,
 * not only the rows shown so far — and, if wanted, a box beside each to
 * tick on paper. What each cell says is what the table's cell says.
 */

/** The most documents printed: past this, the first of them, and it says so. */
const MOST_PRINTED = 2000;
/** The most pages asked for: enough for them, and never more, whatever a cursor does. */
const MOST_ROUNDS = Math.ceil(MOST_PRINTED / MOST_AT_ONCE) + 1;

/** A cell's words, as the table's cell says them. */
export function cellWords(column: Column, doc: DocumentView, known: Known): string {
  switch (column.key) {
    case 'title':
      return titleOf(doc);
    case 'kind':
      return known.types.find((t) => t.key === doc.type_key)?.label ?? NOTHING;
    case 'person':
      return (
        (doc.owner_member_id
          ? known.names.get(doc.owner_member_id)
          : doc.household_owned === true
            ? THE_HOUSEHOLD
            : undefined) ?? NOTHING
      );
    case 'issued':
      return doc.issued ? tableDate(doc.issued) : NOTHING;
    case 'expires':
      return doc.expires ? tableDate(doc.expires) : NOTHING;
    case 'status':
      return doc.status.value === 'valid' ? 'Nothing to renew' : doc.status.label;
    case 'visibility':
      return doc.caregiver === true ? CAREGIVER_MARK : VISIBILITY_WORDS[doc.visibility];
    case 'location':
      return doc.physical_location ?? NOTHING;
    case 'original_place':
      return doc.original_place ? placeWords(doc.original_place) : NOTHING;
    case 'collections': {
      const names = (doc.collections ?? []).map((c) => c.name);
      return names.length > 0 ? names.join(', ') : NOTHING;
    }
  }
}

/**
 * The filters on, in the table's words: "Person: Mansoor or Sara · Kind:
 * Passport" — several choices of one filter any of them (0.9.0-dev.92).
 */
export function filterWords(view: TableView, known: Known): string {
  const said = FILTER_KEYS.filter((k) => k !== 'collection' && view[k].length > 0).map(
    (k) => `${FILTER_LABELS[k]}: ${view[k].map((v) => choiceWords(k, v, known)).join(' or ')}`,
  );
  const more = folderChipCount(view.folder);
  if (more > 0) said.push(more === 1 ? 'and 1 more condition' : `and ${more} more conditions`);
  return said.join(' · ');
}

/** The columns the collection's table shows on this device. */
function shownColumns(known: Known, places: boolean): Column[] {
  const hidden = readHidden(COLLECTION_HIDDEN_COLUMNS_KEY, COLLECTION_HIDDEN_BY_DEFAULT);
  return columnsFor(storedRole(), {
    collections: known.collections.length > 0,
    places,
  }).filter((c) => c.key === 'title' || !hidden.has(c.key));
}

interface Job {
  items: DocumentView[];
  /** More than were printed. */
  more: boolean;
  ticks: boolean;
}

/** Print, from a collection's page: a box to tick beside each, or not; then the printing. */
export function PrintCollection(props: {
  collection: { id: string; name: string; description: string | null };
  /** The household as its table names it: printed once all of it has come. */
  known: Known;
  returnFocus: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const { collection } = props;
  const { withToken, caps } = useApp();
  const [params] = useSearchParams();
  // Its sort and filters as its table has them (the address), in this collection.
  const view: TableView = { ...viewFrom(params, storedRole()), collection: [collection.id] };
  const { known } = props;
  const columns = shownColumns(known, caps?.features.original_place === true);
  const [ticks, setTicks] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Every document of it the reader is given, in the table's order. */
  const everything = async (): Promise<{ items: DocumentView[]; more: boolean } | null> => {
    let items: DocumentView[] = [];
    let cursor: string | null = null;
    let rounds = 0;
    do {
      rounds += 1;
      const after: string | null = cursor;
      const page: Awaited<ReturnType<typeof api.documents>> | null = await withToken((t) =>
        api.documents(t, queryOf(view, { cursor: after, limit: MOST_AT_ONCE })),
      );
      if (!page) return null;
      items = [...items, ...page.items.filter((d) => !items.some((x) => x.id === d.id))];
      cursor = page.next_cursor;
    } while (cursor && items.length < MOST_PRINTED && rounds < MOST_ROUNDS);
    return { items: items.slice(0, MOST_PRINTED), more: cursor !== null };
  };

  const print = async () => {
    if (!known.settled) return;
    setBusy(true);
    setProblem(null);
    try {
      const got = await everything();
      if (got && alive.current) setJob({ ...got, ticks });
    } catch (err) {
      if (alive.current) setProblem(describeError(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  if (job) {
    const words = directionWords(view.sort);
    const filters = filterWords(view, known);
    return (
      <PrintOut
        title={collection.name}
        about={
          <>
            {collection.description && (
              <p className="print-about keep-lines">{collection.description}</p>
            )}
            <p className="print-about">
              Collection · {documentsCount(job.items.length)}
              {job.more ? ` (the first ${job.items.length})` : ''} · sorted by{' '}
              {SORT_LABELS[view.sort].toLowerCase()}, {words[view.dir]}
            </p>
            {filters && <p className="print-about">Filtered: {filters}</p>}
          </>
        }
        onDone={props.onClose}
      >
        <table className="print-table">
          <thead>
            <tr>
              {job.ticks && (
                <th scope="col" className="print-tick-col">
                  <span className="visually-hidden">Ticked</span>
                </th>
              )}
              {columns.map((c) => (
                <th key={c.key} scope="col">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {job.items.map((d) => (
              <tr key={d.id}>
                {job.ticks && (
                  <td className="print-tick-col">
                    <span className="print-tick" />
                  </td>
                )}
                {columns.map((c) => (
                  <td key={c.key}>{cellWords(c, d, known)}</td>
                ))}
              </tr>
            ))}
            {job.items.length === 0 && (
              <tr>
                <td colSpan={columns.length + (job.ticks ? 1 : 0)}>
                  {filters ? 'Nothing matches these filters.' : 'Nothing in this collection yet.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </PrintOut>
    );
  }

  return (
    <Dialog
      title={`Print “${collection.name}”`}
      busy={busy}
      returnFocus={props.returnFocus}
      onClose={props.onClose}
      closeLabel="Cancel"
      actions={
        <Button
          kind="primary"
          disabled={busy || known.settled !== true}
          onClick={() => void print()}
        >
          {busy || (known.settled !== true && !known.failed) ? 'Preparing…' : 'Print'}
        </Button>
      }
    >
      <p className="muted">
        A table of what is in it, with the columns its table shows:{' '}
        {columns.map((c) => c.label).join(', ')}.
        {filterWords(view, known) ? ' Through the filters chosen above it.' : ''}
      </p>
      <Check
        id="print-ticks"
        checked={ticks}
        label="A box beside each, to tick"
        note="To check them off on paper, one by one."
        onChange={setTicks}
      />
      <ErrorNote
        message={
          problem ??
          (known.failed && known.settled !== true
            ? `The family’s names and kinds could not be loaded, so it can’t be printed as its table shows it. ${known.failed}`
            : null)
        }
      />
    </Dialog>
  );
}
