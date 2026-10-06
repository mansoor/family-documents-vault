import {
  seesLocation,
  shortName,
  type CollectionView,
  type DocumentSort,
  type DocumentTypeView,
  type DocumentView,
  type SortDirection,
  type Visibility,
} from '@fdv/shared';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { flushSync } from 'react-dom';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api, type Member } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { AddToCollection, collectionsOffered } from '../collections.js';
import {
  bulkOffer,
  columnsFor,
  documentsCount,
  FILTER_KEYS,
  filtersOn,
  MOST_AT_ONCE,
  PAGE_SIZE,
  paramsOf,
  PICK_WIDTH,
  queryOf,
  readHidden,
  STATUS_WORDS,
  tableDate,
  TITLE_MIN,
  viewFrom,
  VISIBILITY_CHOICES,
  VISIBILITY_WORDS,
  writeHidden,
  maySelect,
  type BulkOffer,
  type Chooser,
  type Column,
  type ColumnKey,
  type FilterKey,
  type TableView,
} from '../documents-table.js';
import { storedRole } from '../session.js';
import { useShellMode } from '../shell.js';
import {
  Button,
  Check,
  ConfirmDialog,
  ErrorNote,
  LockIcon,
  Pills,
  Select,
  Sheet,
  StatusBadge,
  TopBar,
  TrashIcon,
} from '../ui.js';
import { DocRow } from './Home.js';
import { useSelect } from './SearchPeople.js';

/**
 * Documents (Phase 6, R2): every document the reader may see.
 *
 *  - From 768 px, a table: a column for each thing a document says, each a
 *    sort (`aria-sort`); a Columns menu, remembered on this device; filters
 *    for whose, what kind, its status, who can see it, its collection and
 *    a tag; and boxes to choose many, with what may be done with all of
 *    them at once. Below 1024 px the table scrolls sideways in its own box,
 *    the box and the title staying where they are.
 *  - On a phone, today's list of rows, the filters in a sheet, and Select as
 *    today: into a collection.
 *
 * The address holds the sort and the filters, so a link shows the same
 * view and Back goes to the one before. Where the original is kept is the
 * household's (5.41): a viewer or a guest has no Location column, no sort
 * or filter by it, and no way to set it.
 */
export function DocumentsScreen() {
  const mode = useShellMode();
  const { authVersion, caps, session } = useApp();
  const role = storedRole();
  const [params, setParams] = useSearchParams();
  const view = viewFrom(params, role);
  const setView = (next: TableView) => setParams(paramsOf(next));
  const pages = usePages(view);

  const hasCollections = caps?.features.collections === true;
  const { data: members } = useLoad(async (t) => (await api.members(t)).items, [authVersion]);
  const { data: types } = useLoad(async (t) => (await api.documentTypes(t)).items, [authVersion]);
  const { data: collections } = useLoad(
    async (t) => (hasCollections ? (await api.collections(t)).items : []),
    [authVersion, hasCollections],
  );
  const { data: tags } = useLoad(
    async (t) => (await api.tags(t)).items.map((x) => x.tag),
    [authVersion],
  );
  const known: Known = {
    members: members ?? [],
    // First names, or whole ones where two first names match (5.17c).
    names: shortName(members ?? []),
    types: types ?? [],
    collections: collections ?? [],
    tags: tags ?? [],
  };
  const who: Chooser = {
    role,
    memberId: session.info?.member_id ?? null,
    collections: collectionsOffered(caps, role),
  };

  return mode === 'phone' ? (
    <PhoneDocuments view={view} setView={setView} pages={pages} who={who} known={known} />
  ) : (
    <TableDocuments view={view} setView={setView} pages={pages} who={who} known={known} />
  );
}

/** What the filters offer and the cells name: the household as this reader is given it. */
interface Known {
  members: Member[];
  /** How a person is named in a cell: their first name, or more where two share it. */
  names: Map<string, string>;
  types: DocumentTypeView[];
  collections: CollectionView[];
  tags: string[];
}

// ------------------------------------------------------------- the pages

interface Pages {
  items: DocumentView[];
  /** How many the filters give in all; null until the first page comes. */
  total: number | null;
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  more: () => Promise<void>;
  /** The view again, as far as it was shown (after an action). */
  reload: () => void;
}

/** A view's pages: the first, then each Show more asks for the next after the cursor. */
function usePages(view: TableView): Pages {
  const { withToken } = useApp();
  const key = paramsOf(view).toString();
  const [got, setGot] = useState<{
    key: string;
    items: DocumentView[];
    next: string | null;
    total: number | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [asked, setAsked] = useState(0);
  // As many as were shown, when the same view is asked again after an action.
  const shown = useRef({ key: '', count: 0 });

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      const again = shown.current.key === key;
      const limit = again
        ? Math.min(MOST_AT_ONCE, Math.max(PAGE_SIZE, shown.current.count))
        : PAGE_SIZE;
      try {
        const r = await withToken((t) =>
          api.documents(t, queryOf(viewFrom(new URLSearchParams(key), storedRole()), { limit })),
        );
        if (cancelled || !r) return;
        shown.current = { key, count: r.items.length };
        setGot({ key, items: r.items, next: r.next_cursor, total: r.total ?? null });
        setError(null);
      } catch (err) {
        if (!cancelled) setError(describeError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [key, asked, withToken]);

  const current = got && got.key === key ? got : null;
  const more = async () => {
    if (!current?.next || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await withToken((t) => api.documents(t, queryOf(view, { cursor: current.next })));
      if (r) {
        setGot((g) =>
          g && g.key === key
            ? {
                key,
                items: [...g.items, ...r.items.filter((d) => !g.items.some((x) => x.id === d.id))],
                next: r.next_cursor,
                total: r.total ?? g.total,
              }
            : g,
        );
        shown.current = { key, count: shown.current.count + r.items.length };
      }
      setError(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoadingMore(false);
    }
  };

  return {
    items: current?.items ?? [],
    total: current?.total ?? null,
    loading: (loading || current === null) && error === null,
    error,
    hasMore: Boolean(current?.next),
    loadingMore,
    more,
    reload: () => setAsked((n) => n + 1),
  };
}

// ------------------------------------------------------------- words

/** How a sort's two ways read, for a column of this kind. */
function directionWords(sort: DocumentSort): Record<SortDirection, string> {
  switch (sort) {
    case 'issued':
    case 'expires':
      return { asc: 'earliest first', desc: 'latest first' };
    case 'status':
      return { asc: 'most pressing first', desc: 'least pressing first' };
    case 'visibility':
      return { asc: 'Everyone first', desc: 'Only me first' };
    default:
      return { asc: 'A to Z', desc: 'Z to A' };
  }
}

const SORT_LABELS: Record<DocumentSort, string> = {
  title: 'Title',
  kind: 'Kind',
  person: 'Person',
  issued: 'Issued',
  expires: 'Expires',
  status: 'Status',
  visibility: 'Who can see it',
  collections: 'Collections',
  location: 'Location',
};

function titleOf(doc: Pick<DocumentView, 'title'>): string {
  return doc.title ?? 'Scan · needs a name';
}

function countWords(pages: Pages, view: TableView): string {
  if (pages.total === null) return 'Loading your documents…';
  const n = documentsCount(pages.total);
  return filtersOn(view) > 0 ? `${n} match these filters` : n;
}

/** Each filter's choices, as its select offers them: "All …" first. */
function filterChoices(
  key: FilterKey,
  known: Known,
  view: TableView,
): Array<{ value: string; label: string }> {
  switch (key) {
    case 'person':
      return [
        { value: '', label: 'All people' },
        ...known.members.map((m) => ({ value: m.id, label: m.display_name })),
        { value: 'none', label: 'Nobody in particular' },
      ];
    case 'kind': {
      const kinds = known.types
        .filter((t) => !t.hidden || t.key === view.kind)
        .sort((a, b) => a.label.localeCompare(b.label));
      return [
        { value: '', label: 'All kinds' },
        ...kinds.map((t) => ({ value: t.key, label: t.label })),
      ];
    }
    case 'status':
      return [
        { value: '', label: 'Any status' },
        ...Object.entries(STATUS_WORDS).map(([value, label]) => ({ value, label })),
      ];
    case 'visibility':
      return [
        { value: '', label: 'Anyone can see' },
        ...(['household', 'adults', 'private'] as const).map((v) => ({
          value: v,
          label: VISIBILITY_WORDS[v],
        })),
      ];
    case 'collection':
      return [
        { value: '', label: 'All collections' },
        ...known.collections.map((c) => ({ value: c.id, label: c.name })),
        { value: 'none', label: 'In no collection' },
      ];
    case 'tag':
      return [
        { value: '', label: 'All tags' },
        ...[...new Set([...known.tags, ...(view.tag ? [view.tag] : [])])].map((t) => ({
          value: t,
          label: t,
        })),
      ];
  }
}

const FILTER_LABELS: Record<FilterKey, string> = {
  person: 'Person',
  kind: 'Kind',
  status: 'Status',
  visibility: 'Who can see it',
  collection: 'Collection',
  tag: 'Tag',
};

/** The filters there is something to choose in: no collections, no collection filter. */
function filtersFor(known: Known): FilterKey[] {
  return FILTER_KEYS.filter(
    (k) =>
      (k !== 'collection' || known.collections.length > 0) &&
      (k !== 'tag' || known.tags.length > 0),
  );
}

// ------------------------------------------------------------- wide

function TableDocuments(props: {
  view: TableView;
  setView: (v: TableView) => void;
  pages: Pages;
  who: Chooser;
  known: Known;
}) {
  const { view, setView, pages, who, known } = props;
  const navigate = useNavigate();
  const [hidden, setHidden] = useState<Set<ColumnKey>>(readHidden);
  const columns = columnsFor(who.role, { collections: known.collections.length > 0 });
  const shown = columns.filter((c) => c.key === 'title' || !hidden.has(c.key));
  const selectable = maySelect(who);
  const viewKey = paramsOf(view).toString();
  // What is chosen, for this view: a new sort or filter starts again.
  const [picked, setPicked] = useState<{ key: string; ids: ReadonlySet<string> }>({
    key: viewKey,
    ids: new Set(),
  });
  const pickedIds = picked.key === viewKey ? picked.ids : new Set<string>();
  const chosen = pages.items.filter((d) => pickedIds.has(d.id));
  const setPickedIds = (ids: ReadonlySet<string>) => setPicked({ key: viewKey, ids });
  // What the last action came to, said until it is put away or the view changes.
  const [said, setSaid] = useState<{ key: string; outcome: Outcome } | null>(null);
  const outcome = said?.key === viewKey ? said.outcome : null;
  const setOutcome = (o: Outcome | null) => setSaid(o ? { key: viewKey, outcome: o } : null);
  const outcomeRef = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const tips = useClipTips(wrap, [
    pages.items.map((d) => d.etag).join(','),
    shown.map((c) => c.key).join(','),
  ]);

  const sortBy = (key: ColumnKey) => {
    const sort: DocumentSort = key;
    setView({ ...view, sort, dir: view.sort === sort && view.dir === 'asc' ? 'desc' : 'asc' });
  };
  const setFilter = (key: FilterKey, value: string) => setView({ ...view, [key]: value });
  const anyFilter = filtersOn(view) > 0;

  const toggleColumn = (key: ColumnKey, on: boolean) => {
    const next = new Set(hidden);
    if (on) next.delete(key);
    else next.add(key);
    setHidden(next);
    writeHidden(next);
  };

  const pick = (id: string, on: boolean) => {
    const next = new Set(pickedIds);
    if (on) next.add(id);
    else next.delete(id);
    setPickedIds(next);
  };
  const allPicked = pages.items.length > 0 && chosen.length === pages.items.length;
  const somePicked = chosen.length > 0 && !allPicked;
  const pickAll = (on: boolean) =>
    setPickedIds(on ? new Set(pages.items.map((d) => d.id)) : new Set());

  /** An action came back: what it did, what it could not, and the list again. */
  const finished = (o: Outcome) => {
    flushSync(() => {
      setOutcome(o);
      // What failed stays chosen, to try again; the rest is done with.
      setPickedIds(new Set(o.failed.map((f) => f.id)));
    });
    pages.reload();
    // The dialog gives the focus back as it closes; then it comes here, where
    // what happened is said, as the button that asked may be gone.
    window.setTimeout(() => outcomeRef.current?.focus(), 0);
  };

  const openRow = (e: ReactMouseEvent<HTMLTableRowElement>, id: string) => {
    const target = e.target as HTMLElement;
    if (target.closest('a, button, input, label, select')) return;
    // A word being chosen to copy is not a click on the row.
    if (window.getSelection?.()?.toString()) return;
    void navigate(`/documents/${id}`);
  };

  const minWidth =
    (selectable ? PICK_WIDTH : 0) + shown.reduce((sum, c) => sum + (c.width ?? TITLE_MIN), 0);
  const words = directionWords(view.sort);

  return (
    <main className="page page-table" aria-busy={pages.loading}>
      <div className="table-head">
        <h1>Documents</h1>
        <ColumnsMenu columns={columns} hidden={hidden} onChange={toggleColumn} />
      </div>
      <div className="filters" role="group" aria-label="Filters">
        {filtersFor(known).map((k) => (
          <FilterSelect
            key={k}
            id={`filter-${k}`}
            label={FILTER_LABELS[k]}
            value={view[k]}
            options={filterChoices(k, known, view)}
            onChange={(v) => setFilter(k, v)}
          />
        ))}
        {anyFilter && (
          <button
            type="button"
            className="btn btn-quiet btn-small"
            onClick={() =>
              setView({
                ...view,
                person: '',
                kind: '',
                status: '',
                visibility: '',
                collection: '',
                tag: '',
              })
            }
          >
            Clear filters
          </button>
        )}
        <p className="muted table-count" role="status">
          {countWords(pages, view)}
        </p>
      </div>
      <ErrorNote message={pages.error} />
      {outcome && (
        <OutcomeNote ref={outcomeRef} outcome={outcome} onDismiss={() => setOutcome(null)} />
      )}
      <div
        ref={wrap}
        className="tbl-wrap"
        onMouseOver={tips.show}
        onMouseOut={tips.hide}
        onFocus={tips.show}
        onBlur={tips.hide}
        onKeyDown={tips.escape}
      >
        <table className="tbl" style={{ minWidth }}>
          <caption className="visually-hidden">
            Documents, sorted by {SORT_LABELS[view.sort]}, {words[view.dir]}
          </caption>
          <colgroup>
            {selectable && <col style={{ width: PICK_WIDTH }} />}
            {shown.map((c) => (
              <col key={c.key} style={c.width ? { width: c.width } : undefined} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {selectable && (
                <th scope="col" className="col-pick">
                  <PickAll
                    count={pages.items.length}
                    checked={allPicked}
                    mixed={somePicked}
                    onChange={pickAll}
                  />
                </th>
              )}
              {shown.map((c) => (
                <HeaderCell
                  key={c.key}
                  column={c}
                  view={view}
                  pinned={c.key === 'title'}
                  offset={selectable ? PICK_WIDTH : 0}
                  onSort={() => sortBy(c.key)}
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {pages.items.map((d) => (
              <tr
                key={d.id}
                className={pickedIds.has(d.id) ? 'picked' : undefined}
                onClick={(e) => openRow(e, d.id)}
              >
                {selectable && (
                  <td className="col-pick">
                    <label className="pick-cell">
                      <input
                        type="checkbox"
                        checked={pickedIds.has(d.id)}
                        onChange={(e) => pick(d.id, e.target.checked)}
                      />
                      <span className="visually-hidden">Select “{titleOf(d)}”</span>
                    </label>
                  </td>
                )}
                {shown.map((c) => (
                  <Cell
                    key={c.key}
                    column={c}
                    doc={d}
                    known={known}
                    offset={selectable ? PICK_WIDTH : 0}
                  />
                ))}
              </tr>
            ))}
            {pages.items.length === 0 && (
              <tr className="empty-row">
                <td colSpan={shown.length + (selectable ? 1 : 0)}>
                  {pages.loading
                    ? 'Loading your documents…'
                    : pages.error
                      ? 'The documents could not be loaded.'
                      : anyFilter
                        ? 'Nothing matches these filters.'
                        : 'Nothing here yet.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {pages.hasMore && (
          <div className="tbl-more">
            <Button kind="quiet" disabled={pages.loadingMore} onClick={() => void pages.more()}>
              {pages.loadingMore ? 'Loading more…' : 'Show more'}
            </Button>
            <span className="muted">
              {pages.items.length} of {pages.total ?? '…'} shown
            </span>
          </div>
        )}
      </div>
      {chosen.length > 0 ? (
        <BulkBar
          chosen={chosen}
          who={who}
          known={known}
          rows={pages.items}
          onClear={() => setPickedIds(new Set())}
          onFinished={finished}
        />
      ) : (
        <div className="tablefoot">
          <span>
            {selectable
              ? 'Tick documents to do something with many at once.'
              : 'Open a document to read or download it.'}
          </span>
          <span className="tablefoot-sort">
            Sorted by {SORT_LABELS[view.sort].toLowerCase()}, {words[view.dir]}
          </span>
        </div>
      )}
      {tips.tip}
    </main>
  );
}

/** The header's box: every row shown, chosen or not; part of them, mixed. */
function PickAll(props: {
  count: number;
  checked: boolean;
  mixed: boolean;
  onChange: (on: boolean) => void;
}) {
  const box = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (box.current) box.current.indeterminate = props.mixed;
  });
  return (
    <label className="pick-cell">
      <input
        ref={box}
        type="checkbox"
        checked={props.checked}
        disabled={props.count === 0}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span className="visually-hidden">Select all {props.count} shown</span>
    </label>
  );
}

function HeaderCell(props: {
  column: Column;
  view: TableView;
  pinned: boolean;
  offset: number;
  onSort: () => void;
}) {
  const { column, view } = props;
  const on = view.sort === column.key;
  const sort = on ? (view.dir === 'asc' ? 'ascending' : 'descending') : undefined;
  return (
    <th
      scope="col"
      className={
        `${column.end ? 'end ' : ''}${props.pinned ? 'col-title' : ''}`.trim() || undefined
      }
      style={props.pinned ? { left: props.offset } : undefined}
      aria-sort={sort}
    >
      <button type="button" className="th-sort" onClick={props.onSort}>
        {column.label}
        <span className="sort-mark" aria-hidden="true">
          {on ? (view.dir === 'asc' ? '▲' : '▼') : ''}
        </span>
      </button>
    </th>
  );
}

/** A blank, seen as a dash and heard as nothing there. */
function None() {
  return (
    <>
      <span className="muted" aria-hidden="true">
        —
      </span>
      <span className="visually-hidden">None</span>
    </>
  );
}

/** Words that may be cut short: the whole of them on hover and on focus (`useClipTips`). */
function Clip({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <span className="clip" data-clip={text}>
      {children ?? text}
    </span>
  );
}

function Cell(props: { column: Column; doc: DocumentView; known: Known; offset: number }) {
  const { column, doc, known } = props;
  switch (column.key) {
    case 'title':
      return (
        <td className="col-title" style={{ left: props.offset }}>
          <Link className="cell-title" to={`/documents/${doc.id}`}>
            <Clip text={titleOf(doc)} />
          </Link>
        </td>
      );
    case 'kind': {
      const label = known.types.find((t) => t.key === doc.type_key)?.label;
      return <td>{label ? <Clip text={label} /> : <None />}</td>;
    }
    case 'person': {
      const name = doc.owner_member_id ? known.names.get(doc.owner_member_id) : undefined;
      return <td>{name ? <Clip text={name} /> : <None />}</td>;
    }
    case 'issued':
      return <td className="end nowrap">{doc.issued ? tableDate(doc.issued) : <None />}</td>;
    case 'expires':
      return <td className="end nowrap">{doc.expires ? tableDate(doc.expires) : <None />}</td>;
    case 'status':
      return (
        <td>
          {doc.status.value === 'valid' ? (
            <span className="muted">Nothing to renew</span>
          ) : (
            <Clip text={doc.status.label}>
              <StatusBadge status={doc.status} />
            </Clip>
          )}
        </td>
      );
    case 'visibility':
      return (
        <td className="nowrap">
          <span className="vis">
            {doc.visibility === 'private' && <LockIcon />}
            {VISIBILITY_WORDS[doc.visibility]}
          </span>
        </td>
      );
    case 'location':
      return <td>{doc.physical_location ? <Clip text={doc.physical_location} /> : <None />}</td>;
    case 'collections': {
      const names = (doc.collections ?? []).map((c) => c.name);
      return (
        <td>
          {names.length === 0 ? (
            <None />
          ) : (
            <Clip text={names.join(', ')}>
              <span className="chip">{names[0]}</span>
              {names.length > 1 && <span className="chip">+{names.length - 1}</span>}
            </Clip>
          )}
        </td>
      );
    }
  }
}

/** A filter: a select that says what it is set to, its name for a screen reader. */
function FilterSelect(props: {
  id: string;
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
}) {
  // A value no longer offered (a collection gone) is still shown as chosen.
  const options = props.options.some((o) => o.value === props.value)
    ? props.options
    : [...props.options, { value: props.value, label: props.value }];
  return (
    <span className="filter">
      <label className="visually-hidden" htmlFor={props.id}>
        {props.label}
      </label>
      <select
        id={props.id}
        className={props.value ? 'on' : undefined}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}

/**
 * Columns: which the table shows, remembered on this device. The title
 * always is. A disclosure: the button says whether it is open, Escape or a
 * click outside closes it, and the focus goes back to the button.
 */
function ColumnsMenu(props: {
  columns: Column[];
  hidden: ReadonlySet<ColumnKey>;
  onChange: (key: ColumnKey, on: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);
  return (
    <div className="columns-wrap">
      <button
        ref={button}
        type="button"
        className="btn btn-quiet btn-small"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        Columns
      </button>
      {open && (
        <div id={id} ref={box} className="columns-menu" role="group" aria-label="Columns shown">
          {props.columns
            .filter((c) => c.key !== 'title')
            .map((c) => (
              <Check
                key={c.key}
                id={`column-${c.key}`}
                checked={!props.hidden.has(c.key)}
                label={c.label}
                onChange={(on) => props.onChange(c.key, on)}
              />
            ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------- whole words

/**
 * The whole of what a cell cuts short, beside it, on hover and on focus: a
 * cell whose words do not fit can be reached with Tab for it. Escape puts
 * it away (WCAG 1.4.13). It repeats words that are on the page already, so
 * a screen reader is not told them twice.
 */
/** The tip's widest (as styles.css draws it), and the room it wants below the words. */
const TIP_WIDTH = 320;
const TIP_ROOM = 80;

function useClipTips(wrap: RefObject<HTMLDivElement | null>, deps: string[]) {
  const [tip, setTip] = useState<{
    text: string;
    left: number;
    top?: number;
    bottom?: number;
  } | null>(null);
  const cut = (el: HTMLElement) =>
    el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
  const clipOf = (target: EventTarget | null): HTMLElement | null => {
    if (!(target instanceof HTMLElement)) return null;
    return target.closest<HTMLElement>('[data-clip]') ?? target.querySelector('[data-clip]');
  };
  const show = (e: ReactMouseEvent | ReactFocusEvent) => {
    const el = clipOf(e.target);
    if (!el || !cut(el)) return;
    const r = el.getBoundingClientRect();
    // Beside the words, and all of it in the window: above them when there
    // is no room below.
    const left = Math.max(8, Math.min(r.left, window.innerWidth - TIP_WIDTH - 8));
    const below = r.bottom + 4 + TIP_ROOM < window.innerHeight;
    setTip({
      text: el.dataset.clip ?? '',
      left,
      ...(below ? { top: r.bottom + 4 } : { bottom: window.innerHeight - r.top + 4 }),
    });
  };
  const hide = () => setTip(null);
  const escape = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape' && tip) setTip(null);
  };
  // Words cut short can be reached with Tab, so that focus shows them too:
  // only those, and only while they are cut.
  const deepDeps = deps.join('|');
  useLayoutEffect(() => {
    const box = wrap.current;
    if (!box) return;
    const mark = () => {
      for (const el of box.querySelectorAll<HTMLElement>('[data-clip]')) {
        if (el.closest('a, button')) continue;
        if (cut(el)) el.tabIndex = 0;
        else el.removeAttribute('tabindex');
      }
    };
    mark();
    if (typeof ResizeObserver !== 'function') return;
    const watch = new ResizeObserver(mark);
    watch.observe(box);
    return () => watch.disconnect();
  }, [wrap, deepDeps]);
  return {
    show,
    hide,
    escape,
    tip: tip ? (
      <div
        className="clip-tip"
        aria-hidden="true"
        style={{ left: tip.left, top: tip.top, bottom: tip.bottom }}
      >
        {tip.text}
      </div>
    ) : null,
  };
}

// ------------------------------------------------------------- many at once

/** What an action on many came to: said in a line, and each one it could not, by name. */
interface Outcome {
  said: string | null;
  failedHead: string | null;
  failed: Array<{ id: string; title: string; why: string }>;
}

function OutcomeNote({
  ref,
  outcome,
  onDismiss,
}: {
  ref: RefObject<HTMLDivElement | null>;
  outcome: Outcome;
  onDismiss: () => void;
}) {
  return (
    <div ref={ref} className="bulk-outcome" tabIndex={-1}>
      {outcome.said && (
        <p className="notice" role="status">
          {outcome.said}
        </p>
      )}
      {outcome.failed.length > 0 && (
        <div className="error bulk-failed" role="alert">
          <p>{outcome.failedHead}</p>
          <ul>
            {outcome.failed.map((f) => (
              <li key={f.id}>
                “{f.title}”: {f.why}
              </li>
            ))}
          </ul>
          <p className="muted">They are still chosen, to try again.</p>
        </div>
      )}
      <button type="button" className="btn btn-quiet btn-small" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

type Acting = 'collect' | 'location' | 'visibility' | 'confirm-visibility' | 'trash' | null;

/**
 * The bar under the table while documents are chosen: how many, and what may
 * be done with all of them (`bulkOffer`) — into a collection, where they are
 * kept, who can see them, to the Trash — each through the vault's own call
 * for one document, as the ⋯ does. Who can see them, and the Trash, are asked
 * about first.
 */
function BulkBar(props: {
  chosen: DocumentView[];
  who: Chooser;
  known: Known;
  rows: DocumentView[];
  onClear: () => void;
  onFinished: (o: Outcome) => void;
}) {
  const { chosen, who } = props;
  const { withToken, guarded } = useApp();
  const n = chosen.length;
  const offer: BulkOffer = bulkOffer(who, chosen);
  const tooMany = n > MOST_AT_ONCE;
  const [acting, setActing] = useState<Acting>(null);
  const [progress, setProgress] = useState<{ done: number; of: number } | null>(null);
  const [to, setTo] = useState<Visibility | null>(null);
  const [notice, setNotice] = useState<{ title: string; body: string } | null>(null);
  const pending = useRef<Outcome | null>(null);
  const collectButton = useRef<HTMLButtonElement>(null);
  const locationButton = useRef<HTMLButtonElement>(null);
  const visibilityButton = useRef<HTMLButtonElement>(null);
  const trashButton = useRef<HTMLButtonElement>(null);
  const busy = progress !== null;

  /**
   * Each, one after another, through the vault's call for one: what went
   * through and what did not, by name and in the vault's words. `null` from
   * a call is a question about who is asking that was not answered: the
   * rest are left as they are.
   */
  const each = async (
    docs: DocumentView[],
    act: (doc: DocumentView) => Promise<unknown>,
  ): Promise<{ done: DocumentView[]; failed: Outcome['failed']; stopped: number }> => {
    const done: DocumentView[] = [];
    const failed: Outcome['failed'] = [];
    for (const [i, doc] of docs.entries()) {
      setProgress({ done: i, of: docs.length });
      try {
        const r = await act(doc);
        if (r === null) return { done, failed, stopped: docs.length - i };
        done.push(doc);
      } catch (err) {
        failed.push({ id: doc.id, title: titleOf(doc), why: describeError(err) });
      }
    }
    return { done, failed, stopped: 0 };
  };

  const finish = (o: Outcome) => {
    flushSync(() => {
      setProgress(null);
      setActing(null);
    });
    props.onFinished(o);
  };

  /** Said above those it could not do: 'None of the 3 could be …', '1 of the 3 could not be …'. */
  const failedHead = (failed: number, of: number, done: string) =>
    of === 1
      ? `It could not be ${done}:`
      : failed === of
        ? `None of the ${of} could be ${done}:`
        : `${failed} of the ${of} could not be ${done}:`;

  const trash = async () => {
    const r = await each(chosen, (d) => withToken((t) => api.deleteDocument(t, d.id)));
    finish({
      said:
        r.done.length > 0
          ? `${documentsCount(r.done.length)} moved to the Trash. You can bring ${r.done.length === 1 ? 'it' : 'them'} back from there.`
          : null,
      failedHead: failedHead(r.failed.length, n, 'moved to the Trash'),
      failed: r.failed,
    });
  };

  const setLocation = async (where: string) => {
    const r = await each(chosen, (d) =>
      withToken((t) => api.updateDocument(t, d.id, { physical_location: where }, d.etag)),
    );
    finish({
      said: r.done.length > 0 ? `${documentsCount(r.done.length)} now kept in “${where}”.` : null,
      failedHead: failedHead(r.failed.length, n, 'changed'),
      failed: r.failed,
    });
  };

  const changing = to ? chosen.filter((d) => d.visibility !== to) : [];
  const setVisibility = async () => {
    if (!to) return;
    let told: { title: string; body: string } | null = null;
    const r = await each(changing, async (d) => {
      const result = await guarded((t) => api.setVisibility(t, d.id, to));
      if (result?.notice) told ??= result.notice;
      return result;
    });
    const stayed = r.stopped > 0 ? ` ${r.stopped} left as they were.` : '';
    pending.current = {
      said:
        r.done.length > 0 || stayed
          ? `${documentsCount(r.done.length)} now ${VISIBILITY_WORDS[to]}.${stayed}`
          : null,
      failedHead: failedHead(r.failed.length, changing.length, 'changed'),
      failed: r.failed,
    };
    if (told) {
      // Said once, here, before anything else (SEC-19).
      flushSync(() => {
        setProgress(null);
        setActing(null);
        setNotice(told);
      });
      return;
    }
    finish(pending.current);
  };

  const what = documentsCount(n);
  return (
    <>
      <div className="bulkbar" role="region" aria-label="What to do with the chosen documents">
        <span className="bulk-count">{n} selected</span>
        {offer.collect && (
          <button
            ref={collectButton}
            type="button"
            className="btn btn-bulk"
            disabled={busy || tooMany}
            onClick={() => setActing('collect')}
          >
            Add to a collection
          </button>
        )}
        {offer.location && (
          <button
            ref={locationButton}
            type="button"
            className="btn btn-bulk"
            disabled={busy || tooMany}
            onClick={() => setActing('location')}
          >
            Set where it’s kept
          </button>
        )}
        {offer.visibility.length > 0 && (
          <button
            ref={visibilityButton}
            type="button"
            className="btn btn-bulk"
            disabled={busy || tooMany}
            onClick={() => {
              setTo(offer.visibility[0] ?? null);
              setActing('visibility');
            }}
          >
            Who can see it
          </button>
        )}
        {offer.trash && (
          <button
            ref={trashButton}
            type="button"
            className="btn btn-bulk btn-bulk-danger"
            disabled={busy || tooMany}
            onClick={() => setActing('trash')}
          >
            <TrashIcon />
            Move to Trash
          </button>
        )}
        <span className="bulk-gap" />
        <button type="button" className="btn btn-bulk" disabled={busy} onClick={props.onClear}>
          Clear selection
        </button>
        {(tooMany || offer.notes.length > 0) && (
          <div className="bulk-notes">
            {tooMany && <p>Up to {MOST_AT_ONCE} at once: choose fewer to go on.</p>}
            {offer.notes.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </div>
        )}
      </div>
      {acting === 'collect' && (
        <CollectSheet
          ids={chosen.map((d) => d.id)}
          what={what}
          returnFocus={collectButton}
          onClose={(said) => {
            setActing(null);
            if (said) props.onFinished({ said, failedHead: null, failed: [] });
          }}
        />
      )}
      {acting === 'location' && (
        <LocationSheet
          what={what}
          rows={props.rows}
          progress={progress}
          returnFocus={locationButton}
          onSet={(where) => void setLocation(where)}
          onCancel={() => setActing(null)}
        />
      )}
      {acting === 'visibility' && (
        <Sheet
          label={`Who can see ${what}`}
          busy={false}
          returnFocus={visibilityButton}
          onClose={() => setActing(null)}
        >
          <div className="card stack">
            <h2 style={{ fontSize: 20 }}>Who can see {what}</h2>
            <Pills
              label="Who can see them"
              value={to}
              options={offer.visibility.map((v) => ({
                value: v,
                label: VISIBILITY_CHOICES[v].label,
              }))}
              onChange={setTo}
            />
            {to && <p className="muted">{VISIBILITY_CHOICES[to].means}</p>}
            <div className="row">
              <Button disabled={!to} onClick={() => setActing('confirm-visibility')}>
                Continue
              </Button>
              <Button kind="quiet" onClick={() => setActing(null)}>
                Cancel
              </Button>
            </div>
          </div>
        </Sheet>
      )}
      {acting === 'confirm-visibility' && to && (
        <ConfirmDialog
          title={
            to === 'household'
              ? `Let everyone in the family see ${documentsCount(changing.length)}?`
              : `Make ${documentsCount(changing.length)} ${VISIBILITY_WORDS[to]}?`
          }
          confirmLabel="Change who can see them"
          busyLabel={progress ? `Changing ${progress.done + 1} of ${progress.of}…` : 'Changing…'}
          busy={busy}
          returnFocus={visibilityButton}
          onConfirm={() => void setVisibility()}
          onCancel={() => setActing(null)}
        >
          <p>
            {VISIBILITY_CHOICES[to].means}
            {n > changing.length &&
              ` ${n - changing.length} ${n - changing.length === 1 ? 'is' : 'are'} ${VISIBILITY_WORDS[to]} already, and stay${n - changing.length === 1 ? 's' : ''} as ${n - changing.length === 1 ? 'it is' : 'they are'}.`}
          </p>
        </ConfirmDialog>
      )}
      {acting === 'trash' && (
        <ConfirmDialog
          title={`Move ${what} to the Trash?`}
          confirmLabel="Move to Trash"
          busyLabel={progress ? `Moving ${progress.done + 1} of ${progress.of}…` : 'Moving…'}
          icon={<TrashIcon />}
          danger
          busy={busy}
          returnFocus={trashButton}
          onConfirm={() => void trash()}
          onCancel={() => setActing(null)}
        >
          <p>
            {n === 1 ? 'It leaves' : 'They leave'} every list, search and reminder. You can bring{' '}
            {n === 1 ? 'it' : 'them'} back from the Trash.
          </p>
        </ConfirmDialog>
      )}
      {notice && (
        <Sheet
          label={notice.title}
          busy={false}
          returnFocus={visibilityButton}
          onClose={() => {
            setNotice(null);
            if (pending.current) props.onFinished(pending.current);
          }}
        >
          <section className="card stack" role="alert" aria-labelledby="bulk-notice-h">
            <h2 id="bulk-notice-h" style={{ fontSize: 18 }}>
              {notice.title}
            </h2>
            <p>{notice.body}</p>
            <Button
              onClick={() => {
                setNotice(null);
                if (pending.current) props.onFinished(pending.current);
              }}
            >
              I understand
            </Button>
          </section>
        </Sheet>
      )}
    </>
  );
}

/** Into a collection, all at once or none (5.15): the ⋯'s sheet, for many. */
function CollectSheet(props: {
  ids: string[];
  what: string;
  returnFocus: RefObject<HTMLButtonElement | null>;
  onClose: (said: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const said = useRef<string | null>(null);
  const close = () => props.onClose(said.current);
  return (
    <Sheet
      label={`Add ${props.what} to a collection`}
      busy={busy}
      returnFocus={props.returnFocus}
      onClose={close}
    >
      <AddToCollection
        documentIds={props.ids}
        what={props.what}
        onClose={close}
        onBusy={setBusy}
        onAdded={(news) => {
          said.current = news;
        }}
      />
    </Sheet>
  );
}

/** Where the paper originals of the chosen are kept: one place for all of them. */
function LocationSheet(props: {
  what: string;
  rows: DocumentView[];
  progress: { done: number; of: number } | null;
  returnFocus: RefObject<HTMLButtonElement | null>;
  onSet: (where: string) => void;
  onCancel: () => void;
}) {
  const [where, setWhere] = useState('');
  const [missing, setMissing] = useState(false);
  const busy = props.progress !== null;
  const places = [
    ...new Set(props.rows.map((d) => d.physical_location?.trim()).filter((p): p is string => !!p)),
  ].sort((a, b) => a.localeCompare(b));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!where.trim()) {
      setMissing(true);
      return;
    }
    props.onSet(where.trim());
  };
  return (
    <Sheet
      label={`Where the paper originals of ${props.what} are kept`}
      busy={busy}
      returnFocus={props.returnFocus}
      onClose={props.onCancel}
    >
      <form className="card stack" onSubmit={submit} noValidate>
        <h2 style={{ fontSize: 20 }}>Set where {props.what} are kept</h2>
        <div className="field">
          <label htmlFor="bulk-location">Where the paper originals are kept</label>
          <input
            id="bulk-location"
            type="text"
            value={where}
            list="bulk-location-places"
            maxLength={500}
            placeholder="Fire safe, in the study"
            aria-invalid={missing || undefined}
            aria-describedby="bulk-location-note"
            onChange={(e) => {
              setWhere(e.target.value);
              setMissing(false);
            }}
          />
          <datalist id="bulk-location-places">
            {places.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
          <span id="bulk-location-note" className="muted">
            The same place for all {props.what}: what was written before is replaced.
          </span>
        </div>
        <ErrorNote message={missing ? 'Say where they are kept.' : null} />
        <div className="row">
          <Button type="submit" disabled={busy}>
            {props.progress
              ? `Setting ${props.progress.done + 1} of ${props.progress.of}…`
              : `Set for ${props.what}`}
          </Button>
          <Button kind="quiet" disabled={busy} onClick={props.onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

// ------------------------------------------------------------- phone

/**
 * On a phone, today's rows: each with its ⋯, the filters and the sort in a
 * sheet, and Select as today, into a collection.
 */
function PhoneDocuments(props: {
  view: TableView;
  setView: (v: TableView) => void;
  pages: Pages;
  who: Chooser;
  known: Known;
}) {
  const { view, pages, known } = props;
  const navigate = useNavigate();
  const select = useSelect(props.who.collections);
  const [filtering, setFiltering] = useState(false);
  const filtersButton = useRef<HTMLButtonElement>(null);
  const on = filtersOn(view);
  // A row its ⋯ took away (to the Trash) is chosen no longer.
  const { drop } = select;
  const ids = pages.items.map((d) => d.id).join(',');
  const before = useRef<string[]>([]);
  useEffect(() => {
    const now = ids ? ids.split(',') : [];
    drop(before.current.filter((id) => !now.includes(id)));
    before.current = now;
  }, [ids, drop]);

  const sortChoices = (Object.keys(SORT_LABELS) as DocumentSort[])
    .filter((s) => s !== 'location' || seesLocation(props.who.role))
    .filter((s) => s !== 'collections' || known.collections.length > 0)
    .flatMap((s) =>
      (['asc', 'desc'] as const).map((d) => ({
        value: `${s}:${d}`,
        label: `${SORT_LABELS[s]}, ${directionWords(s)[d]}`,
      })),
    );

  return (
    <main className="page page-top page-wide has-nav">
      <TopBar
        title="Documents"
        action={
          <button
            ref={filtersButton}
            type="button"
            className="btn btn-quiet btn-small"
            aria-haspopup="dialog"
            onClick={() => setFiltering(true)}
          >
            {on > 0 ? `Filters (${on})` : 'Filters'}
          </button>
        }
      />
      <p className="muted" role="status" tabIndex={-1} data-landing>
        {countWords(pages, view)}
      </p>
      <ErrorNote message={pages.error} />
      {(select.on || pages.items.length > 0) && select.bar}
      <ul className="list">
        {pages.items.length === 0 && !pages.loading && (
          <li className="muted">
            {pages.error
              ? 'The documents could not be loaded.'
              : on > 0
                ? 'Nothing matches these filters.'
                : 'Nothing here yet.'}
          </li>
        )}
        {pages.items.map((d) => (
          <DocRow
            key={d.id}
            doc={d}
            types={known.types}
            pick={select.pick(d.id)}
            onOpen={() => void navigate(`/documents/${d.id}`)}
            onChanged={pages.reload}
          />
        ))}
      </ul>
      {pages.hasMore && (
        <Button kind="quiet" disabled={pages.loadingMore} onClick={() => void pages.more()}>
          {pages.loadingMore ? 'Loading more…' : 'Show more'}
        </Button>
      )}
      {select.sheet}
      {filtering && (
        <Sheet
          label="Filters"
          busy={false}
          returnFocus={filtersButton}
          onClose={() => setFiltering(false)}
        >
          <div className="card stack">
            <h2 style={{ fontSize: 20 }}>Filters</h2>
            <Select
              id="phone-sort"
              label="Sort by"
              value={`${view.sort}:${view.dir}`}
              options={sortChoices}
              onChange={(v) => {
                const [sort, dir] = v.split(':') as [DocumentSort, SortDirection];
                props.setView({ ...view, sort, dir });
              }}
            />
            {filtersFor(known).map((k) => (
              <Select
                key={k}
                id={`phone-filter-${k}`}
                label={FILTER_LABELS[k]}
                value={view[k]}
                options={filterChoices(k, known, view)}
                onChange={(v) => props.setView({ ...view, [k]: v })}
              />
            ))}
            <p className="muted" role="status">
              {countWords(pages, view)}
            </p>
            <div className="row">
              <Button onClick={() => setFiltering(false)}>Done</Button>
              {on > 0 && (
                <Button
                  kind="quiet"
                  onClick={() =>
                    props.setView({
                      ...view,
                      person: '',
                      kind: '',
                      status: '',
                      visibility: '',
                      collection: '',
                      tag: '',
                    })
                  }
                >
                  Clear filters
                </Button>
              )}
            </div>
          </div>
        </Sheet>
      )}
    </main>
  );
}
