import {
  seesLocation,
  shortName,
  tagDetail,
  tagKey,
  tagLabelKey,
  tagWords,
  type CollectionView,
  type DocumentSort,
  type DocumentTypeView,
  type DocumentView,
  type LinksChoiceNeeded,
  type OwnLinkToEnd,
  type SortDirection,
  type Visibility,
  type VisibilityChange,
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
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { flushSync } from 'react-dom';
import {
  Link,
  NavigationType,
  useNavigate,
  useNavigationType,
  useSearchParams,
} from 'react-router';
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
import { moveInMenu, useShellMode } from '../shell.js';
import { FilterSelect, None, OutcomeNote, PickAll, useGrid, type Outcome } from '../table-grid.js';
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
  useSheetFocus,
} from '../ui.js';
import { DocRow } from './Home.js';
import { beside, mayChange, useTrashedNote } from '../DocActions.js';
import { TagField } from '../tags.js';
import { useSelect } from './SearchPeople.js';
import { LinksChoiceDialog, linksAsk, linksChoice, type LinksAsk } from './Visibility.js';

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
  const info = session.info;
  const holder: Holder | null = info
    ? { household: info.household_id, member: info.member_id }
    : null;
  const pages = usePages(view, holder);

  const hasCollections = caps?.features.collections === true;
  const { data: members } = useLoad(async (t) => (await api.members(t)).items, [authVersion]);
  const { data: types } = useLoad(async (t) => (await api.documentTypes(t)).items, [authVersion]);
  const { data: collections } = useLoad(
    async (t) => (hasCollections ? (await api.collections(t)).items : []),
    [authVersion, hasCollections],
  );
  // Every tag the reader can see, for the filters by a tag and by a detail's label (T1).
  const { data: tags } = useLoad(
    async (t) => (await api.tags(t, undefined, { limit: 1000 })).items.map((x) => x.tag),
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
    <TableDocuments
      view={view}
      setView={setView}
      pages={pages}
      who={who}
      known={known}
      holder={holder}
    />
  );
}

/**
 * What the filters offer and the cells name: the household as this reader
 * is given it. A collection's Add documents (Phase 6) offers the same.
 */
export interface Known {
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
  /** The next page, after the cursor: the first of its documents' ids, or null. */
  more: () => Promise<string | null>;
  /** The view again, as far as it was shown (after an action). */
  reload: () => void;
}

/** Who is signed in: whose choices a history entry may give back. */
interface Holder {
  household: string;
  member: string;
}

/**
 * What this page's entry in the browser's history keeps of a view (the
 * review's W4): what was chosen, and how many were shown — so that Back
 * from a document is the table as it was left, not its first page afresh.
 * Whose it is, too: the next person to sign in at this tab, and press
 * Back, finds none of the last person's choices (the second round's F5).
 */
interface Kept extends Holder {
  key: string;
  picked: string[];
  shown: number;
}

const KEPT = 'fdvDocuments';

function readKept(key: string, holder: Holder | null): Kept | null {
  if (!holder) return null;
  try {
    const state = window.history.state as Record<string, unknown> | null;
    const k = state?.[KEPT] as Partial<Kept> | undefined;
    return k &&
      k.key === key &&
      k.household === holder.household &&
      k.member === holder.member &&
      Array.isArray(k.picked) &&
      typeof k.shown === 'number'
      ? (k as Kept)
      : null;
  } catch {
    return null;
  }
}

function writeKept(k: Kept): void {
  try {
    const state = (window.history.state as Record<string, unknown> | null) ?? {};
    window.history.replaceState({ ...state, [KEPT]: k }, '');
  } catch {
    // Not kept: Back shows the first page, nothing chosen.
  }
}

/**
 * The row last opened from the table, and the view it was opened from (R5's
 * keyboard paths): Back to that view gives it the focus again, as its
 * history entry gives back what was chosen and how many were shown (W4).
 */
let lastOpened: { search: string; id: string } | null = null;

function rememberOpened(id: string): void {
  lastOpened = { search: window.location.search, id };
}

function forgetOpened(): void {
  lastOpened = null;
}

/**
 * Come back (the browser's Back, or the document's own) to the view a
 * document was opened from: once its row is drawn again, it has the focus,
 * after the shell has given the page's heading it. Read once, as the list
 * comes back, and let go: a page loaded afresh has none.
 */
function useBackToOpened(
  rows: readonly DocumentView[],
  find: (id: string) => HTMLElement | null | undefined,
) {
  const navigation = useNavigationType();
  const [returningTo] = useState(() =>
    navigation === NavigationType.Pop && lastOpened?.search === window.location.search
      ? lastOpened.id
      : null,
  );
  const returning = useRef(returningTo);
  const finder = useRef(find);
  useLayoutEffect(() => {
    finder.current = find;
  });
  useEffect(forgetOpened, []);
  const ids = rows.map((d) => d.id).join(',');
  useEffect(() => {
    const id = returning.current;
    if (!id || !ids.split(',').includes(id)) return;
    const timer = window.setTimeout(() => {
      const target = finder.current(id);
      if (!target) return;
      returning.current = null;
      target.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [ids]);
}

/** A view's pages: the first, then each Show more asks for the next after the cursor. */
function usePages(view: TableView, holder: Holder | null): Pages {
  const { withToken } = useApp();
  const key = paramsOf(view).toString();
  const household = holder?.household ?? null;
  const member = holder?.member ?? null;
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
  const shown = useRef<{ key: string | null; count: number }>({ key: null, count: 0 });

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      const asWas = viewFrom(new URLSearchParams(key), storedRole());
      // As many as were shown: after an action, or back from a document.
      const want =
        shown.current.key === key
          ? shown.current.count
          : (readKept(key, household && member ? { household, member } : null)?.shown ?? PAGE_SIZE);
      try {
        let r = await withToken((t) =>
          api.documents(
            t,
            queryOf(asWas, { limit: Math.min(MOST_AT_ONCE, Math.max(PAGE_SIZE, want)) }),
          ),
        );
        if (cancelled || !r) return;
        let items = r.items;
        let next = r.next_cursor;
        const total = r.total ?? null;
        while (next && items.length < want) {
          const cursor = next;
          const had = items;
          r = await withToken((t) =>
            api.documents(
              t,
              queryOf(asWas, { cursor, limit: Math.min(MOST_AT_ONCE, want - had.length) }),
            ),
          );
          if (cancelled || !r) return;
          items = [...had, ...r.items.filter((d) => !had.some((x) => x.id === d.id))];
          next = r.next_cursor;
        }
        shown.current = { key, count: items.length };
        setGot({ key, items, next, total });
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
  }, [key, asked, withToken, household, member]);

  const current = got && got.key === key ? got : null;
  const more = async (): Promise<string | null> => {
    if (!current?.next || loadingMore) return null;
    setLoadingMore(true);
    try {
      const r = await withToken((t) => api.documents(t, queryOf(view, { cursor: current.next })));
      setError(null);
      if (!r) return null;
      const fresh = r.items.filter((d) => !current.items.some((x) => x.id === d.id));
      setGot((g) =>
        g && g.key === key
          ? {
              key,
              items: [...g.items, ...fresh],
              next: r.next_cursor,
              total: r.total ?? g.total,
            }
          : g,
      );
      shown.current = { key, count: current.items.length + fresh.length };
      return fresh[0]?.id ?? null;
    } catch (err) {
      setError(describeError(err));
      return null;
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
  // Not loaded, and not on its way: said above, not Loading for ever (R5).
  if (pages.total === null) return pages.error ? '' : 'Loading your documents…';
  const n = documentsCount(pages.total);
  return filtersOn(view) > 0 ? `${n} match these filters` : n;
}

/** Each filter's choices, as its select offers them: "All …" first. */
export function filterChoices(
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
      // A detail tag as it is shown: "Locker · 12" (0.9.0, T1).
      return [
        { value: '', label: 'All tags' },
        ...[...new Set([...known.tags, ...(view.tag ? [view.tag] : [])])].map((t) => ({
          value: t,
          label: tagWords(t).text,
        })),
      ];
    case 'label':
      // Every document with a detail of this label, whatever its value (T1).
      return [{ value: '', label: 'Any detail' }, ...detailLabels(known.tags, view.label)];
  }
}

/** The labels of the detail tags the reader can see: "Locker", by "locker". */
function detailLabels(
  tags: readonly string[],
  chosen: string,
): Array<{ value: string; label: string }> {
  const labels = new Map<string, string>();
  for (const t of tags) {
    const shown = tagWords(t).label;
    const d = tagDetail(t);
    if (shown && d) labels.set(tagLabelKey(d.label), shown);
  }
  if (chosen && !labels.has(tagLabelKey(chosen))) labels.set(tagLabelKey(chosen), chosen);
  return [...labels]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([value, label]) => ({ value, label }));
}

export const FILTER_LABELS: Record<FilterKey, string> = {
  person: 'Person',
  kind: 'Kind',
  status: 'Status',
  visibility: 'Who can see it',
  collection: 'Collection',
  tag: 'Tag',
  label: 'Detail',
};

/** The filters there is something to choose in: no collections, no collection filter. */
function filtersFor(known: Known): FilterKey[] {
  return FILTER_KEYS.filter(
    (k) =>
      (k !== 'collection' || known.collections.length > 0) &&
      (k !== 'tag' || known.tags.length > 0) &&
      (k !== 'label' || known.tags.some((t) => tagDetail(t) !== null)),
  );
}

// ------------------------------------------------------------- wide

function TableDocuments(props: {
  view: TableView;
  setView: (v: TableView) => void;
  pages: Pages;
  who: Chooser;
  known: Known;
  holder: Holder | null;
}) {
  const { view, setView, pages, who, known, holder } = props;
  const navigate = useNavigate();
  const [hidden, setHidden] = useState<Set<ColumnKey>>(readHidden);
  const columns = columnsFor(who.role, { collections: known.collections.length > 0 });
  const shown = columns.filter((c) => c.key === 'title' || !hidden.has(c.key));
  const selectable = maySelect(who);
  const viewKey = paramsOf(view).toString();
  // What is chosen, for this view: a new sort or filter starts again, and
  // Back from a document finds it as it was (W4).
  const [picked, setPicked] = useState<{ key: string; ids: ReadonlySet<string> }>(() => ({
    key: viewKey,
    ids: new Set(readKept(viewKey, holder)?.picked ?? []),
  }));
  const pickedIds =
    picked.key === viewKey ? picked.ids : new Set<string>(readKept(viewKey, holder)?.picked ?? []);
  const chosen = pages.items.filter((d) => pickedIds.has(d.id));
  const setPickedIds = (ids: ReadonlySet<string>) => setPicked({ key: viewKey, ids });
  // What the last action came to, said until it is put away or the view changes.
  const [said, setSaid] = useState<{ key: string; outcome: Outcome } | null>(null);
  const outcome = said?.key === viewKey ? said.outcome : null;
  const setOutcome = (o: Outcome | null) => setSaid(o ? { key: viewKey, outcome: o } : null);
  const outcomeRef = useRef<HTMLDivElement>(null);
  const pickAllRef = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const table = useRef<HTMLTableElement>(null);
  const tips = useClipTips(pages.items);
  const grid = useGrid(table, wrap, [
    pages.items.map((d) => d.id).join(','),
    shown.map((c) => c.key).join(','),
    String(selectable),
  ]);

  // Kept in this page's history entry as it changes (W4).
  const pickedKey = [...pickedIds].join(',');
  const count = pages.items.length;
  const household = holder?.household ?? null;
  const member = holder?.member ?? null;
  useEffect(() => {
    if (pages.loading || count === 0 || !household || !member) return;
    writeKept({
      key: viewKey,
      household,
      member,
      picked: pickedKey ? pickedKey.split(',') : [],
      shown: count,
    });
  }, [viewKey, pickedKey, count, pages.loading, household, member]);

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

  /**
   * Where the focus goes when what had it goes (W13): the header's box, the
   * next thing to choose with; or, for somebody who chooses nothing, the
   * table's own place in it. With no documents left to choose from — the
   * last of them moved to the Trash — the page's heading (F4): never
   * nowhere.
   */
  const backToTable = () => {
    if (pickAllRef.current && !pickAllRef.current.disabled) pickAllRef.current.focus();
    else if (pages.items.length === 0 || !grid.focusActive()) heading.current?.focus();
  };

  /** An action came back: what it did, what it could not, and the list again. */
  const finished = (o: Outcome) => {
    flushSync(() => {
      setOutcome(o);
      // What failed, or was never reached, stays chosen, to try again; the
      // rest is done with.
      setPickedIds(new Set([...o.failed.map((f) => f.id), ...o.untouched]));
    });
    pages.reload();
    // The dialog gives the focus back as it closes; then it comes here, where
    // what happened is said, as the button that asked may be gone.
    window.setTimeout(() => outcomeRef.current?.focus(), 0);
  };

  const openRow = (e: ReactMouseEvent<HTMLTableRowElement>, id: string) => {
    const target = e.target as HTMLElement;
    // The box's cell is the box's (W4): a near miss on it chooses nothing,
    // and opens nothing.
    if (target.closest('a, button, input, label, select, td.col-pick')) return;
    // A word being chosen to copy is not a click on the row.
    if (window.getSelection?.()?.toString()) return;
    rememberOpened(id);
    void navigate(`/documents/${id}`);
  };

  // Back from a document opened here: the focus on its row again, after the
  // shell has given the page's heading it (R5).
  useBackToOpened(pages.items, (id) =>
    table.current?.querySelector<HTMLElement>(`tr[data-id="${id}"] .cell-title`),
  );

  /** The next page; then, by whatever asked for it, the first of it (W2). */
  const showMore = async () => {
    const first = await pages.more();
    if (!first) return;
    window.setTimeout(() => {
      table.current?.querySelector<HTMLElement>(`tr[data-id="${first}"] .cell-title`)?.focus();
    }, 0);
  };

  const minWidth =
    (selectable ? PICK_WIDTH : 0) + shown.reduce((sum, c) => sum + (c.width ?? TITLE_MIN), 0);
  const words = directionWords(view.sort);

  return (
    <main className="page page-table" aria-busy={pages.loading}>
      <div className="table-head">
        <h1 ref={heading} tabIndex={-1}>
          Documents
        </h1>
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
                label: '',
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
        <OutcomeNote
          ref={outcomeRef}
          outcome={outcome}
          onDismiss={() => {
            flushSync(() => setOutcome(null));
            backToTable();
          }}
        />
      )}
      <div
        ref={wrap}
        className="tbl-wrap"
        // No scroll-padding: with it, a browser scrolls a pinned cell or the
        // head "into view" each time it is focused, back to the left and up
        // (F2). `reveal` keeps the focus clear of them instead (W3).
        onMouseOver={tips.show}
        onMouseOut={tips.hide}
        onKeyDown={tips.escape}
      >
        <table
          ref={table}
          className="tbl"
          role="grid"
          style={{ minWidth }}
          onKeyDown={grid.onKeyDown}
          onFocus={(e) => {
            grid.onFocus(e);
            tips.show(e);
          }}
          onBlur={tips.hide}
        >
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
                    ref={pickAllRef}
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
                data-id={d.id}
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
      </div>
      {/* Outside the box that scrolls sideways, so it is never off to one side (W2). */}
      {pages.hasMore && (
        <div className="tbl-more">
          <button
            type="button"
            className="btn btn-quiet"
            aria-disabled={pages.loadingMore || undefined}
            onClick={() => {
              if (!pages.loadingMore) void showMore();
            }}
          >
            {pages.loadingMore ? 'Loading more…' : 'Show more'}
          </button>
          <span className="muted">
            {pages.items.length} of {pages.total ?? '…'} shown
          </span>
        </div>
      )}
      {/* How many are chosen, said as it changes (W1). */}
      <p className="visually-hidden" role="status">
        {chosen.length > 0 ? `${chosen.length} selected` : ''}
      </p>
      {chosen.length > 0 ? (
        <BulkBar
          chosen={chosen}
          who={who}
          known={known}
          rows={pages.items}
          onClear={() => {
            flushSync(() => setPickedIds(new Set()));
            backToTable();
          }}
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

/**
 * Words that may be cut short: the whole of them on hover and on focus
 * (`useClipTips`) — `always` where some of them are never drawn at all (a
 * "+1" collection).
 */
function Clip({
  text,
  always,
  children,
}: {
  text: string;
  always?: boolean;
  children?: ReactNode;
}) {
  return (
    <span className="clip" data-clip={text} data-clip-always={always ? '' : undefined}>
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
          <Link
            className="cell-title"
            to={`/documents/${doc.id}`}
            onClick={() => rememberOpened(doc.id)}
          >
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
            <Clip text={names.join(', ')} always={names.length > 1}>
              <span className="chip">{names[0]}</span>
              {/* The rest, in a tip and to a screen reader (W10). */}
              {names.length > 1 && (
                <>
                  <span className="chip" aria-hidden="true">
                    +{names.length - 1}
                  </span>
                  <span className="visually-hidden">, {names.slice(1).join(', ')}</span>
                </>
              )}
            </Clip>
          )}
        </td>
      );
    }
  }
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
    <div
      className="columns-wrap"
      // Shut when the focus goes somewhere else, so it never sits over what
      // has it (W14). Only then: a press on a column's name, which cannot
      // take the focus, leaves it going nowhere — and is the column's, to
      // show or hide (F1). A click outside shuts it by itself, above.
      onBlur={(e) => {
        if (open && e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
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

/** The tip's widest (as styles.css draws it), and the room it wants below the words. */
const TIP_WIDTH = 320;
const TIP_ROOM = 80;

/**
 * The whole of what a cell cuts short, beside it, on hover and on focus —
 * every cell takes the focus by the grid's arrows (`useGrid`), not as a
 * stop for Tab. Whether the words are cut is measured then, so a kind or a
 * name that came after the rows, or a font that came late, is measured as
 * it now is (W11). Escape puts it away (WCAG 1.4.13). It repeats words that
 * are on the page already, so a screen reader is not told them twice. A
 * row that goes — to the Trash, say — takes its tip with it, though the
 * pointer never left it (no mouseout comes from what is gone).
 */
function useClipTips(rows: readonly DocumentView[]) {
  const [tip, setTip] = useState<{
    text: string;
    /** The row it is of; null for the head's. */
    row: string | null;
    left: number;
    top?: number;
    bottom?: number;
  } | null>(null);
  const shown = tip && (tip.row === null || rows.some((d) => d.id === tip.row)) ? tip : null;
  const cut = (el: HTMLElement) =>
    el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
  const clipOf = (target: EventTarget | null): HTMLElement | null => {
    if (!(target instanceof HTMLElement)) return null;
    return target.closest<HTMLElement>('[data-clip]') ?? target.querySelector('[data-clip]');
  };
  const show = (e: ReactMouseEvent | ReactFocusEvent) => {
    const el = clipOf(e.target);
    if (!el || !(el.dataset.clipAlways !== undefined || cut(el))) return;
    const r = el.getBoundingClientRect();
    // Beside the words, and all of it in the window: above them when there
    // is no room below.
    const left = Math.max(8, Math.min(r.left, window.innerWidth - TIP_WIDTH - 8));
    const below = r.bottom + 4 + TIP_ROOM < window.innerHeight;
    setTip({
      text: el.dataset.clip ?? '',
      row: el.closest<HTMLElement>('tr[data-id]')?.dataset.id ?? null,
      left,
      ...(below ? { top: r.bottom + 4 } : { bottom: window.innerHeight - r.top + 4 }),
    });
  };
  const hide = () => setTip(null);
  const escape = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape' && shown) setTip(null);
  };
  return {
    show,
    hide,
    escape,
    tip: shown ? (
      <div
        className="clip-tip"
        aria-hidden="true"
        style={{ left: shown.left, top: shown.top, bottom: shown.bottom }}
      >
        {shown.text}
      </div>
    ) : null,
  };
}

// ------------------------------------------------------------- many at once

type Acting =
  | 'collect'
  | 'location'
  | 'tag-add'
  | 'tag-remove'
  | 'visibility'
  | 'confirm-visibility'
  | 'links'
  | 'trash'
  | null;

/** What the vault says once a change is made: "Only you can open this" (SEC-19). */
type Notice = { title: string; body: string };

/** A change of who can see many: what it did, could not, and never reached; its notice. */
interface VisibilityRun {
  done: DocumentView[];
  failed: Outcome['failed'];
  untouched: DocumentView[];
  told: Notice | null;
}

/** Set aside by its call: asked about once, for all, when the rest are done. */
const ASIDE = Symbol('set aside');

/**
 * The one question, for many made Only me at once (5.41): "2 of these have 3
 * links of yours that send them outside the family. …" — each link once, a
 * collection's link though it holds more than one of them.
 */
function linksQuestion(docs: number, links: number): string {
  const them = docs === 1 ? 'it' : 'them';
  return `${docs === 1 ? '1 of these has' : `${docs} of these have`} ${
    links === 1 ? 'a link of yours that sends' : `${links} links of yours that send`
  } ${them} outside the family. Choose whether ${
    links === 1 ? 'it ends or is' : 'they end or are'
  } kept, now that ${docs === 1 ? 'it is' : 'they are'} Only me.`;
}

/**
 * What became of the person's own links to those made Only me, as the vault
 * said it of each (its answer's `links`): ended, or kept — but for one a
 * restore paused, which ends either way. Each link once, a collection's link
 * though it held more than one of them; and, where a document's links changed
 * while it was asked, as many as the vault said. Kept, it names who the
 * people they are for can still open: those whose links were kept.
 */
function linksWords(
  documents: Array<{ id: string; title: string; links: OwnLinkToEnd[] }>,
  replies: ReadonlyMap<string, VisibilityChange>,
): string | null {
  const ended = new Set<string>();
  const kept = new Set<string>();
  let endedElse = 0;
  let keptElse = 0;
  const keptTo: string[] = [];
  let settled = 0;
  for (const d of documents) {
    const now = replies.get(d.id)?.links;
    if (!now?.yours_now || now.yours === 0) continue;
    settled += 1;
    if (now.yours_now === 'kept') keptTo.push(d.title);
    if (now.yours === d.links.length) {
      for (const l of d.links) (now.yours_now === 'kept' && !l.will_end ? kept : ended).add(l.id);
    } else if (now.yours_now === 'kept') keptElse += now.yours;
    else endedElse += now.yours;
  }
  const k = kept.size + keptElse;
  const e = ended.size + endedElse;
  if (k + e === 0) return null;
  const it = settled === 1 ? 'it' : 'them';
  const count = (n: number) => (n === 1 ? '1 link' : `${n} links`);
  if (k === 0) return `Your ${count(e)} to ${it} ${e === 1 ? 'has' : 'have'} ended.`;
  const open =
    keptTo.length === settled
      ? it
      : keptTo.length === 1
        ? `“${keptTo[0] ?? ''}”`
        : `${keptTo.length} of them`;
  return `Your ${count(k)} to ${it} ${k === 1 ? 'is' : 'are'} kept: the people ${
    k === 1 ? 'it is' : 'they are'
  } for can still open ${open}.${
    e > 0
      ? ` ${e === 1 ? 'Another has' : `${e} others have`} ended: paused after a restore, ${
          e === 1 ? 'it' : 'they'
        } could not be turned back on.`
      : ''
  }`;
}

/**
 * Said once a document is Only me, to the person who made it so, with links
 * of their own, after the first time (visibility.ts): what is true now, with
 * these words, instead of the sentence that has to be said the first time.
 */
const TOLD_BEFORE = 'Nobody else in the family can open it.';

/**
 * Of the vault's notices for many made Only me, the one to say (SEC-19): one
 * that carries the sentence that has to be said the first time — which the
 * vault says once for each document, so never lost — else the first there is.
 */
function noticeOf(notices: Array<Notice | null | undefined>): Notice | null {
  const given = notices.filter((n): n is Notice => Boolean(n));
  return given.find((n) => !n.body.startsWith(TOLD_BEFORE)) ?? given[0] ?? null;
}

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
  const [notice, setNotice] = useState<Notice | null>(null);
  // Into Only me: those whose links the vault asked about, and the one question (5.41).
  const [linksAsked, setLinksAsked] = useState<{
    docs: DocumentView[];
    documents: Array<{ id: string; title: string; links: OwnLinkToEnd[]; others: number }>;
    ask: LinksAsk;
  } | null>(null);
  // What the run came to before the question, said with what came after it.
  const first = useRef<VisibilityRun | null>(null);
  const pending = useRef<Outcome | null>(null);
  const collectButton = useRef<HTMLButtonElement>(null);
  const locationButton = useRef<HTMLButtonElement>(null);
  const tagsButton = useRef<HTMLButtonElement>(null);
  const visibilityButton = useRef<HTMLButtonElement>(null);
  const trashButton = useRef<HTMLButtonElement>(null);
  const busy = progress !== null;

  /**
   * Each, one after another, through the vault's call for one: what went
   * through and what did not, by name and in the vault's words. `null` from
   * a call is a question about who is asking that was not answered, or a
   * sign-in that has ended: the rest are left as they are, and said to be.
   * `ASIDE` is one the vault has a question about, asked once for all of
   * them when the rest are done (their own links, into Only me).
   */
  const each = async (docs: DocumentView[], act: (doc: DocumentView) => Promise<unknown>) => {
    const done: DocumentView[] = [];
    const failed: Outcome['failed'] = [];
    const aside: DocumentView[] = [];
    for (const [i, doc] of docs.entries()) {
      setProgress({ done: i, of: docs.length });
      try {
        const r = await act(doc);
        if (r === null) return { done, failed, untouched: docs.slice(i), aside };
        if (r === ASIDE) aside.push(doc);
        else done.push(doc);
      } catch (err) {
        failed.push({ id: doc.id, title: titleOf(doc), why: describeError(err) });
      }
    }
    return { done, failed, untouched: [] as DocumentView[], aside };
  };

  /**
   * What a run that stopped short says of those it never reached (W9):
   * how many, why, and that they are still chosen.
   */
  const leftWords = (done: number, left: number, doneWhat: string, why: string) => {
    if (left === 0) return '';
    const still = left === 1 ? 'it is still chosen' : 'they are still chosen';
    return done === 0
      ? `Nothing was ${doneWhat}: ${why}. ${documentsCount(left)} ${left === 1 ? 'is' : 'are'} still chosen.`
      : `The other ${left} ${left === 1 ? 'was' : 'were'} not ${doneWhat}: ${why}, and ${still}.`;
  };
  const said = (...parts: Array<string | null>) => parts.filter((p) => p).join(' ') || null;

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

  const signedOut = 'your sign-in ended';

  const trash = async () => {
    const r = await each(chosen, (d) => withToken((t) => api.deleteDocument(t, d.id)));
    finish({
      said: said(
        r.done.length > 0
          ? `${documentsCount(r.done.length)} moved to the Trash. You can bring ${r.done.length === 1 ? 'it' : 'them'} back from there.`
          : null,
        leftWords(r.done.length, r.untouched.length, 'moved to the Trash', signedOut),
      ),
      failedHead: failedHead(r.failed.length, n, 'moved to the Trash'),
      failed: r.failed,
      untouched: r.untouched.map((d) => d.id),
    });
  };

  const setLocation = async (where: string) => {
    const r = await each(chosen, (d) =>
      withToken((t) => api.updateDocument(t, d.id, { physical_location: where }, d.etag)),
    );
    finish({
      said: said(
        r.done.length > 0 ? `${documentsCount(r.done.length)} now kept in “${where}”.` : null,
        leftWords(r.done.length, r.untouched.length, 'changed', signedOut),
      ),
      failedHead: failedHead(r.failed.length, n, 'changed'),
      failed: r.failed,
      untouched: r.untouched.map((d) => d.id),
    });
  };

  /**
   * A tag added to, or taken off, the chosen documents the person may change
   * (0.9.0, T1): each through its own edit, with its own ETag, so one changed
   * meanwhile is refused alone and listed, and the rest go through. Those
   * not theirs to change are left as they are, and named.
   */
  const tagged = async (mode: 'add' | 'remove', tag: string) => {
    const mine = chosen.filter((d) => mayChange(who.role, who.memberId, d));
    const notMine = chosen.filter((d) => !mayChange(who.role, who.memberId, d));
    const key = tagKey(tag);
    const asWas: DocumentView[] = [];
    const r = await each(mine, (d) => {
      const has = d.tags.some((t) => tagKey(t) === key);
      if (mode === 'add' ? has : !has) {
        asWas.push(d);
        return Promise.resolve(true);
      }
      const tags = mode === 'add' ? [...d.tags, tag] : d.tags.filter((t) => tagKey(t) !== key);
      return withToken((t) => api.updateDocument(t, d.id, { tags }, d.etag));
    });
    const changed = r.done.length - asWas.filter((d) => r.done.includes(d)).length;
    const shown = `“${tagWords(tag).text}”`;
    const already = asWas.length;
    finish({
      said: said(
        changed > 0
          ? mode === 'add'
            ? `${shown} added to ${documentsCount(changed)}.`
            : `${shown} taken off ${documentsCount(changed)}.`
          : r.failed.length === 0 && r.untouched.length === 0
            ? 'Nothing changed.'
            : null,
        already > 0
          ? mode === 'add'
            ? `${already} had it already.`
            : `${already} did not have it.`
          : null,
        notMine.length > 0
          ? `Left as ${notMine.length === 1 ? 'it was' : 'they were'}, not yours to change: ${notMine
              .map((d) => `“${titleOf(d)}”`)
              .join(', ')}.`
          : null,
        leftWords(changed, r.untouched.length, 'changed', signedOut),
      ),
      failedHead: failedHead(r.failed.length, mine.length, 'changed'),
      failed: r.failed,
      untouched: r.untouched.map((d) => d.id),
    });
  };

  const changing = to ? chosen.filter((d) => d.visibility !== to) : [];
  // Only me documents that would be seen by more people (W7).
  const widened = to && to !== 'private' ? changing.filter((d) => d.visibility === 'private') : [];

  /**
   * What a change of who can see them came to: said — with what became of
   * the person's own links, and those left as they were — and the vault's
   * notice said once, first (SEC-19).
   */
  const report = (
    r: VisibilityRun,
    more: { links?: string | null; leftAside?: DocumentView[] } = {},
  ) => {
    if (!to) return;
    const aside = more.leftAside ?? [];
    pending.current = {
      said: said(
        r.done.length > 0 ? `${documentsCount(r.done.length)} now ${VISIBILITY_WORDS[to]}.` : null,
        more.links ?? null,
        leftWords(r.done.length, r.untouched.length, 'changed', 'you did not confirm it is you'),
        leftWords(
          r.done.length,
          aside.length,
          'changed',
          'you did not say what becomes of your links to them',
        ),
      ),
      failedHead: failedHead(r.failed.length, changing.length, 'changed'),
      failed: r.failed,
      untouched: [...r.untouched, ...aside].map((d) => d.id),
    };
    if (r.told) {
      const told = r.told;
      flushSync(() => {
        setProgress(null);
        setActing(null);
        setNotice(told);
      });
      return;
    }
    finish(pending.current);
  };

  const setVisibility = async () => {
    if (!to) return;
    let told: Notice | null = null;
    // Into Only me, the vault asks first about any of the person's own links
    // that still send one (5.41): those documents are set aside, and asked
    // about once, for all of them, when the rest are done.
    const asks = new Map<string, LinksChoiceNeeded>();
    let asking: unknown = null;
    const r = await each(changing, async (d) => {
      try {
        const result = await guarded((t) => api.setVisibility(t, d.id, to));
        if (result?.notice) told ??= result.notice;
        return result;
      } catch (err) {
        const asked = to === 'private' ? linksChoice(err) : null;
        if (!asked) throw err;
        asks.set(d.id, asked);
        asking ??= err;
        return ASIDE;
      }
    });
    if (r.aside.length === 0) {
      report({ ...r, told });
      return;
    }
    // The household's clock, for when each link ends, as one document's question has it.
    const clock = await linksAsk(asking, withToken);
    const documents = r.aside.map((d) => ({
      id: d.id,
      title: titleOf(d),
      links: asks.get(d.id)?.links ?? [],
      others: asks.get(d.id)?.others ?? 0,
    }));
    const all = [...asks.values()];
    const links = documents.flatMap((d) => d.links);
    first.current = { ...r, told };
    flushSync(() => {
      setProgress(null);
      setLinksAsked({
        docs: r.aside,
        documents,
        ask: {
          links,
          keep_allowed: all.every((a) => a.keep_allowed),
          // Each document's own count, with no ids to tell one link from
          // another: the dialog says them by document, never added up.
          others: Math.max(0, ...all.map((a) => a.others)),
          message: linksQuestion(documents.length, new Set(links.map((l) => l.id)).size),
          timezone: clock?.timezone ?? 'UTC',
        },
      });
      setActing('links');
    });
  };

  /** The person's answer about their links: those set aside, sent again with it. */
  const answerLinks = async (ownLinks: 'end' | 'keep') => {
    const asked = linksAsked;
    const before = first.current;
    if (!to || !asked || !before) return;
    // What the vault said of each: its links now, and its notice — the
    // sentence that has to be said the first time, if none was before (F1).
    const replies = new Map<string, VisibilityChange>();
    const r = await each(asked.docs, async (d) => {
      const result = await guarded((t) => api.setVisibility(t, d.id, to, ownLinks));
      if (result) replies.set(d.id, result);
      return result;
    });
    setLinksAsked(null);
    first.current = null;
    report(
      {
        done: [...before.done, ...r.done],
        failed: [...before.failed, ...r.failed],
        untouched: [...before.untouched, ...r.untouched],
        told: before.told ?? noticeOf([...replies.values()].map((x) => x.notice)),
      },
      { links: linksWords(asked.documents, replies) },
    );
  };

  /** Put away: those set aside stay as they were, and chosen; the rest is said. */
  const leaveLinks = () => {
    const asked = linksAsked;
    const before = first.current;
    setLinksAsked(null);
    first.current = null;
    if (!asked || !before) {
      setActing(null);
      return;
    }
    report(before, { leftAside: asked.docs });
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
        {offer.tags && (
          <TagsMenu
            button={tagsButton}
            disabled={busy || tooMany}
            onChoose={(mode) => setActing(mode === 'add' ? 'tag-add' : 'tag-remove')}
          />
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
            Move to the Trash
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
          onClose={(news) => {
            setActing(null);
            if (news) props.onFinished({ said: news, failedHead: null, failed: [], untouched: [] });
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
      {(acting === 'tag-add' || acting === 'tag-remove') && (
        <TagsSheet
          mode={acting === 'tag-add' ? 'add' : 'remove'}
          chosen={chosen}
          mine={chosen.filter((d) => mayChange(who.role, who.memberId, d))}
          progress={progress}
          returnFocus={tagsButton}
          onRun={(mode, tag) => void tagged(mode, tag)}
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
            {/* Only me, seen by more people: said, with how many (W7). */}
            {widened.length > 0 &&
              ` ${widened.length} of these ${widened.length === 1 ? 'is' : 'are'} Only me now: ${
                to === 'adults'
                  ? `Adults only lets every adult see ${widened.length === 1 ? 'it' : 'them'}.`
                  : `everyone in the family will see ${widened.length === 1 ? 'it' : 'them'}.`
              }`}
            {n > changing.length &&
              ` ${n - changing.length} ${n - changing.length === 1 ? 'is' : 'are'} ${VISIBILITY_WORDS[to]} already, and stay${n - changing.length === 1 ? 's' : ''} as ${n - changing.length === 1 ? 'it is' : 'they are'}.`}
          </p>
        </ConfirmDialog>
      )}
      {acting === 'links' && linksAsked && (
        // The one question for all of them, as one document's is asked (5.41).
        <LinksChoiceDialog
          ask={linksAsked.ask}
          documents={linksAsked.documents}
          busy={busy}
          busyLabel={progress ? `Changing ${progress.done + 1} of ${progress.of}…` : 'Changing…'}
          returnFocus={visibilityButton}
          onChoose={(ownLinks) => void answerLinks(ownLinks)}
          onCancel={leaveLinks}
        />
      )}
      {acting === 'trash' && (
        <ConfirmDialog
          title={`Move ${what} to the Trash?`}
          confirmLabel="Move to the Trash"
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

/**
 * Tags, in the bar for the chosen (0.9.0, T1): one menu button, so the bar
 * keeps to one line — Add a tag… and Remove a tag… in its menu. Down or Up
 * opens it at its first or last item, the arrows, Home and End move in it,
 * and Escape shuts it with the focus back on Tags, as the Add menu does.
 */
function TagsMenu(props: {
  button: RefObject<HTMLButtonElement | null>;
  disabled: boolean;
  onChoose: (mode: 'add' | 'remove') => void;
}) {
  const { button, disabled, onChoose } = props;
  const [menu, setMenu] = useState<{ start: 'first' | 'last'; at: CSSProperties } | null>(null);
  const id = useId();
  const open = (start: 'first' | 'last') => setMenu({ start, at: beside(button.current) });
  return (
    <>
      <button
        ref={button}
        type="button"
        className="btn btn-bulk"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        aria-controls={menu ? id : undefined}
        onClick={() => (menu ? setMenu(null) : open('first'))}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          e.preventDefault();
          open(e.key === 'ArrowUp' ? 'last' : 'first');
        }}
      >
        Tags
        <span aria-hidden="true">▾</span>
      </button>
      {menu && (
        <TagsMenuBox
          id={id}
          start={menu.start}
          at={menu.at}
          returnFocus={button}
          onChoose={(mode) => {
            setMenu(null);
            onChoose(mode);
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}

function TagsMenuBox(props: {
  id: string;
  start: 'first' | 'last';
  at: CSSProperties;
  returnFocus: RefObject<HTMLElement | null>;
  onChoose: (mode: 'add' | 'remove') => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const last = useRef<HTMLButtonElement>(null);
  useSheetFocus(box, {
    start: props.start === 'last' ? last : first,
    onEscape: props.onClose,
    returnFocus: props.returnFocus,
  });
  return (
    <div
      className="menu-layer"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div ref={box} className="menu-box tags-box" style={props.at}>
        <div id={props.id} role="menu" aria-label="Tags" onKeyDown={moveInMenu}>
          <button
            ref={first}
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => props.onChoose('add')}
          >
            Add a tag…
          </button>
          <button
            ref={last}
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => props.onChoose('remove')}
          >
            Remove a tag…
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A tag for the chosen documents (0.9.0, T1): one to add, typed with the
 * tags the person can see offered; or one of theirs to take off. Done to
 * those the person may change; the rest are said to be left as they are.
 */
function TagsSheet(props: {
  mode: 'add' | 'remove';
  chosen: DocumentView[];
  mine: DocumentView[];
  progress: { done: number; of: number } | null;
  returnFocus: RefObject<HTMLButtonElement | null>;
  onRun: (mode: 'add' | 'remove', tag: string) => void;
  onCancel: () => void;
}) {
  const busy = props.progress !== null;
  const [picked, setPicked] = useState<string | null>(null);
  const n = props.mine.length;
  const what = documentsCount(n);
  const notMine = props.chosen.length - n;
  const heading = props.mode === 'add' ? `Add a tag to ${what}` : `Remove a tag from ${what}`;
  // The tags on the documents the person may change, each once, most used first.
  const theirs = new Map<string, { tag: string; count: number }>();
  for (const d of props.mine) {
    for (const t of d.tags) {
      const had = theirs.get(tagKey(t));
      theirs.set(tagKey(t), { tag: had?.tag ?? t, count: (had?.count ?? 0) + 1 });
    }
  }
  const onThem = [...theirs.values()].sort(
    (a, b) => b.count - a.count || a.tag.localeCompare(b.tag),
  );
  const busyWords = props.progress
    ? `Changing ${props.progress.done + 1} of ${props.progress.of}…`
    : null;
  return (
    <Sheet label={heading} busy={busy} returnFocus={props.returnFocus} onClose={props.onCancel}>
      <div className="card stack">
        <h2 style={{ fontSize: 20 }}>{heading}</h2>
        {notMine > 0 && (
          <p className="muted">
            {notMine} of the {props.chosen.length} you chose {notMine === 1 ? 'isn’t' : 'aren’t'}{' '}
            yours to change: {notMine === 1 ? 'it is' : 'they are'} left as{' '}
            {notMine === 1 ? 'it is' : 'they are'}.
          </p>
        )}
        {props.mode === 'add' ? (
          <TagField
            id="bulk-tag"
            label="Tag"
            have={[]}
            busy={busy}
            action={busyWords ?? `Add to ${what}`}
            onAdd={(tag) => {
              props.onRun('add', tag);
              return Promise.resolve(false);
            }}
          />
        ) : onThem.length === 0 ? (
          <p>None of them has a tag.</p>
        ) : (
          <Pills
            label="Which tag"
            value={picked}
            options={onThem.map((t) => ({
              value: t.tag,
              label: `${tagWords(t.tag).text} (${t.count})`,
            }))}
            onChange={setPicked}
          />
        )}
        <div className="row">
          {props.mode === 'remove' && onThem.length > 0 && (
            <Button
              disabled={busy || picked === null}
              onClick={() => {
                if (picked) props.onRun('remove', picked);
              }}
            >
              {busyWords ?? `Remove from ${what}`}
            </Button>
          )}
          <Button kind="quiet" disabled={busy} onClick={props.onCancel}>
            Cancel
          </Button>
        </div>
      </div>
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
  const trashed = useTrashedNote();
  useBackToOpened(pages.items, (id) =>
    document.querySelector<HTMLElement>(
      `li[data-doc="${id}"] button.rowbtn, li[data-doc="${id}"] input.pick`,
    ),
  );
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
      {trashed.note}
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
            onOpen={() => {
              rememberOpened(d.id);
              void navigate(`/documents/${d.id}`);
            }}
            onChanged={pages.reload}
            onTrashed={trashed.onTrashed}
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
                      label: '',
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
