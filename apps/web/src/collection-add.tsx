import {
  sharedOutsideWords,
  shortName,
  tagKey,
  type CollectionView,
  type DateValue,
  type DocumentTypeView,
  type DocumentView,
  type Member,
  type Role,
} from '@fdv/shared';
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react';
import { flushSync } from 'react-dom';
import { api, ApiRequestError, type SearchHit } from './api.js';
import { describeError, useApp, useLoad } from './app-context.js';
import { documentsWord } from './collections.js';
import {
  COLUMNS,
  MOST_AT_ONCE,
  PICK_WIDTH,
  queryOf,
  tableDate,
  TITLE_MIN,
  type ColumnKey,
  type TableView,
} from './documents-table.js';
import { FILTER_LABELS, filterChoices, type Known } from './screens/Documents.js';
import { useShellMode } from './shell.js';
import { FilterSelect, None, PickAll, useGrid } from './table-grid.js';
import { ConfirmDialog, ErrorNote, Sheet } from './ui.js';

/**
 * Adding documents from a collection's own page (Phase 6): "Add documents"
 * opens a picker — a wide dialog from 768 px, the whole screen on a phone —
 * that finds documents by the search the app has (GET /search: title,
 * number and the words inside, the caller's own sealed ones by the second
 * pass) or, with nothing typed, the Documents table's list (GET /documents,
 * a page at a time); narrows them by person, kind, status and tag, as the
 * table's filters do; and puts those chosen in the collection with the
 * vault's own call for it, all of them at once or none (5.15), as the ⋯'s
 * "Add to a collection" does.
 *
 * Only what the reader may see is found: the vault decides. Whoever may see
 * a document may put it in a collection of theirs (it widens nothing), so
 * nothing found is refused here but what is in the collection already. A
 * collection shared outside the family says so before anything goes in
 * (5.19), and who else will now see them (5.33) is said once they are in,
 * in the vault's words.
 */

/** The columns the picker shows, R2's: the title, then what tells documents apart. */
const PICKER_COLUMNS: readonly ColumnKey[] = ['title', 'kind', 'person', 'issued', 'expires'];

/** The filters it offers, the table's: a tag only where there are tags. */
const PICKER_FILTERS = ['person', 'kind', 'status', 'tag'] as const;
type PickerFilter = (typeof PICKER_FILTERS)[number];

/** The most results a search gives (GET /search's own limit). */
const SEARCH_MOST = 100;

/** A document found: as the table lists it, or as search finds it. */
interface Found {
  id: string;
  title: string;
  type_key: string | null;
  owner_member_id: string | null;
  issued: DateValue | null;
  expires: DateValue | null;
  /** In this collection, as the table says it (its `collections`). */
  inHere: boolean;
}

function titleOf(title: string | null): string {
  return title ?? 'Scan · needs a name';
}

const fromDoc = (collectionId: string, d: DocumentView): Found => ({
  id: d.id,
  title: titleOf(d.title),
  type_key: d.type_key,
  owner_member_id: d.owner_member_id,
  issued: d.issued,
  expires: d.expires,
  inHere: (d.collections ?? []).some((c) => c.id === collectionId),
});

const fromHit = (h: SearchHit): Found => ({
  id: h.document_id,
  title: titleOf(h.title),
  type_key: h.type_key,
  owner_member_id: h.owner_member_id,
  issued: h.issued ?? null,
  expires: h.expires ?? null,
  inHere: false,
});

/** What the reader has asked for: the words, and each filter. */
interface Asked {
  words: string;
  person: string;
  kind: string;
  status: string;
  tag: string;
}

/** The table's view for these filters: what its list and its filters are asked with. */
function viewOf(a: Asked): TableView {
  return {
    sort: 'title',
    dir: 'asc',
    person: a.person,
    kind: a.kind,
    status: a.status,
    visibility: '',
    collection: '',
    tag: a.tag,
    label: '',
  };
}

/**
 * Whether a search's result is one the filters keep: person by the search
 * itself, but for nobody in particular; kind, status and tag by what the
 * result says of itself.
 */
function kept(a: Asked, h: SearchHit): boolean {
  return (
    (a.person !== 'none' || !h.owner_member_id) &&
    (!a.kind || h.type_key === a.kind) &&
    (!a.status || h.status.value === a.status) &&
    (!a.tag || (h.tags ?? []).some((t) => tagKey(t) === tagKey(a.tag)))
  );
}

interface Results {
  key: string;
  rows: Found[];
  /** The list's next page (no words typed); search has none. */
  next: string | null;
  /** How many the list's filters give in all; null for a search. */
  total: number | null;
  /** The search gave as many as it gives: there may be more. */
  capped: boolean;
  /** The caller's own sealed documents are still being looked inside. */
  sealing: boolean;
}

/** What adding came to when it was refused: said in the picker, by name. */
interface Refused {
  head: string;
  failed: Array<{ id: string; title: string }>;
  tail: string | null;
}

export function AddDocumentsPicker(props: {
  collection: Pick<CollectionView, 'id' | 'name' | 'shared_outside'>;
  role: Role;
  types: DocumentTypeView[];
  members: Member[];
  returnFocus: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  /** In: what to say of it, the vault's warnings with it. */
  onAdded: (said: string) => void;
  /** Whether a refusal says the collection itself is not there any more: then the page says so. */
  onGone: (err: unknown) => boolean;
}) {
  const { collection, role } = props;
  const { withToken } = useApp();
  const wide = useShellMode() !== 'phone';
  const [typed, setTyped] = useState('');
  const [asked, setAsked] = useState<Asked>({
    words: '',
    person: '',
    kind: '',
    status: '',
    tag: '',
  });
  const [again, setAgain] = useState(0);
  const [results, setResults] = useState<Results | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<Refused | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const pickAllRef = useRef<HTMLInputElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const table = useRef<HTMLTableElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const { data: tags } = useLoad(async (t) => (await api.tags(t)).items.map((x) => x.tag), []);
  // What is in the collection already, by id, for what search finds: the
  // list says it of each of its own (`collections`).
  const { data: inIds } = useLoad(
    async (t) => {
      const ids = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < 100; page++) {
        const r = await api.documents(t, {
          sort: 'title',
          collection_id: collection.id,
          limit: MOST_AT_ONCE,
          cursor,
        });
        for (const d of r.items) ids.add(d.id);
        if (!r.next_cursor) break;
        cursor = r.next_cursor;
      }
      return ids;
    },
    [collection.id],
  );

  const known: Known = {
    members: props.members,
    names: shortName(props.members),
    types: props.types,
    collections: [],
    tags: tags ?? [],
  };
  const filters = PICKER_FILTERS.filter((k) => k !== 'tag' || known.tags.length > 0);
  const view = viewOf(asked);
  const key = JSON.stringify(asked);

  // What is typed is searched for once the typing stops; cleared, at once.
  useEffect(() => {
    const words = typed.trim();
    const timer = window.setTimeout(
      () => setAsked((a) => (a.words === words ? a : { ...a, words })),
      words ? 250 : 0,
    );
    return () => window.clearTimeout(timer);
  }, [typed]);

  useEffect(() => {
    let cancelled = false;
    const a = JSON.parse(key) as Asked;
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        if (!a.words) {
          const r = await withToken((t) => api.documents(t, queryOf(viewOf(a))));
          if (cancelled || !r) return;
          setResults({
            key,
            rows: r.items.map((d) => fromDoc(collection.id, d)),
            next: r.next_cursor,
            total: r.total ?? null,
            capped: false,
            sealing: false,
          });
          return;
        }
        const r = await withToken((t) =>
          api.search(t, a.words, {
            limit: SEARCH_MOST,
            ...(a.person && a.person !== 'none' ? { member_id: a.person } : {}),
          }),
        );
        if (cancelled || !r) return;
        const first = r.items.filter((h) => kept(a, h)).map(fromHit);
        const handle = r.sealed_pending.token;
        setResults({
          key,
          rows: first,
          next: null,
          total: null,
          capped: r.items.length >= SEARCH_MOST,
          sealing: Boolean(handle),
        });
        if (!handle) return;
        // The caller's own Only me documents, looked inside in their session,
        // after the rest are on screen: the slow half.
        const sealed = await withToken((t) => api.searchSealed(t, handle)).catch(() => null);
        if (cancelled) return;
        const seen = new Set(first.map((f) => f.id));
        const more = (sealed?.items ?? [])
          .filter((h) => kept(a, h) && !seen.has(h.document_id))
          .map(fromHit);
        setResults((g) =>
          g && g.key === key ? { ...g, rows: [...g.rows, ...more], sealing: false } : g,
        );
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
  }, [key, again, withToken, collection.id]);

  const current = results && results.key === key ? results : null;
  const rows = current?.rows ?? [];
  const isIn = (f: Found) => f.inHere || (inIds?.has(f.id) ?? false);
  const choosable = rows.filter((f) => !isIn(f));
  const n = chosen.size;
  const tooMany = n > MOST_AT_ONCE;
  const shownChosen = choosable.filter((f) => chosen.has(f.id)).length;
  const allChosen = choosable.length > 0 && shownChosen === choosable.length;

  const grid = useGrid(table, wrap, [
    rows.map((f) => `${f.id}:${isIn(f) ? 1 : 0}`).join(','),
    String(wide),
    String(choosable.length > 0),
  ]);

  const choose = (f: Found, on: boolean) =>
    setChosen((was) => {
      const now = new Map(was);
      if (on) now.set(f.id, f.title);
      else now.delete(f.id);
      return now;
    });

  const chooseAll = (on: boolean) =>
    setChosen((was) => {
      const now = new Map(was);
      for (const f of choosable) {
        if (on) now.set(f.id, f.title);
        else now.delete(f.id);
      }
      return now;
    });

  const setFilter = (k: PickerFilter, value: string) => setAsked((a) => ({ ...a, [k]: value }));
  const anyFilter = filters.some((k) => asked[k] !== '');

  /** A click anywhere on a row chooses it, or not: never one in the collection already. */
  const rowClick = (e: ReactMouseEvent, f: Found) => {
    if ((e.target as HTMLElement).closest('input, label, td.col-pick')) return;
    if (window.getSelection?.()?.toString()) return;
    if (!isIn(f)) choose(f, !chosen.has(f.id));
  };

  /** The list's next page; then, by whatever asked for it, the first of it. */
  const showMore = async () => {
    if (!current?.next || loadingMore) return;
    const from = current.next;
    setLoadingMore(true);
    try {
      const r = await withToken((t) => api.documents(t, queryOf(view, { cursor: from })));
      if (!r) return;
      const fresh = r.items
        .filter((d) => !current.rows.some((x) => x.id === d.id))
        .map((d) => fromDoc(collection.id, d));
      setResults((g) =>
        g && g.key === key
          ? { ...g, rows: [...g.rows, ...fresh], next: r.next_cursor, total: r.total ?? g.total }
          : g,
      );
      const first = fresh[0]?.id;
      if (first) {
        window.setTimeout(() => {
          // Its box; or, in the collection already, its title's cell (or its row).
          const row = (wide ? table.current : list.current)?.querySelector<HTMLElement>(
            `[data-id="${first}"]`,
          );
          (
            row?.querySelector<HTMLElement>('input') ??
            row?.querySelector<HTMLElement>('td.col-title') ??
            row
          )?.focus();
        }, 0);
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoadingMore(false);
    }
  };

  /**
   * Why adding was refused, in words. Several go in together or not at all,
   * so a refusal of several says none went in, and which of them is not there
   * to put in any more — those are chosen no longer; the rest still are.
   * Null when the collection itself has gone: the page says so.
   */
  const refusal = async (err: unknown, ids: string[]): Promise<Refused | null> => {
    const what = `“${collection.name}”`;
    if (err instanceof ApiRequestError && err.status === 404) {
      const now = await withToken((t) => api.getCollection(t, collection.id, { limit: 1 })).then(
        () => null,
        (e: unknown) => e,
      );
      if (now && props.onGone(now)) return null;
      // A document that has gone meanwhile: which, by asking after each.
      const gone =
        ids.length === 1
          ? ids
          : (
              await Promise.all(
                ids.map((id) =>
                  withToken((t) => api.document(t, id)).then(
                    () => null,
                    (e: unknown) => (e instanceof ApiRequestError && e.status === 404 ? id : null),
                  ),
                ),
              )
            ).filter((id): id is string => id !== null);
      const failed = gone.map((id) => ({ id, title: chosen.get(id) ?? 'A document' }));
      const rest = ids.length - gone.length;
      if (ids.length === 1) {
        return {
          head: `It didn’t go into ${what}: it is no longer in the vault, or no longer yours to see.`,
          failed,
          tail: null,
        };
      }
      if (gone.length === 0) {
        return {
          head: `None of the ${ids.length} went into ${what}: one of them is no longer in the vault, or no longer yours to see.`,
          failed: [],
          tail: 'They are still chosen, to try again.',
        };
      }
      return {
        head: `None of the ${ids.length} went into ${what}. ${
          gone.length === 1 ? 'This one is' : `These ${gone.length} are`
        } no longer in the vault, or no longer yours to see, so ${
          gone.length === 1 ? 'it is' : 'they are'
        } chosen no longer:`,
        failed,
        tail: `The other ${rest === 1 ? 'one is' : `${rest} are`} still chosen: add ${
          rest === 1 ? 'it' : 'them'
        } again.`,
      };
    }
    const why = describeError(err);
    return ids.length === 1
      ? { head: why, failed: [], tail: 'It is still chosen, to try again.' }
      : {
          head: `None of the ${ids.length} went into ${what}. ${why}`,
          failed: [],
          tail: 'They are still chosen, to try again.',
        };
  };

  const add = async () => {
    if (busy || n === 0 || tooMany) return;
    const ids = [...chosen.keys()];
    setBusy(true);
    setRefused(null);
    try {
      const after = await withToken((t) => api.addToCollection(t, collection.id, ids));
      if (!after) return;
      // And who else will now see them (5.33), in the vault's words.
      props.onAdded(
        [`${documentsWord(ids.length)} added to “${after.name}”.`, ...(after.warnings ?? [])].join(
          ' ',
        ),
      );
    } catch (err) {
      const said = await refusal(err, ids);
      if (!said) return;
      const gone = new Set(said.failed.map((f) => f.id));
      flushSync(() => {
        setConfirming(false);
        setBusy(false);
        setRefused(said);
        if (gone.size > 0) {
          setChosen((was) => new Map([...was].filter(([id]) => !gone.has(id))));
          setAgain((x) => x + 1);
        }
      });
      // Never out of the picker: back on what was pressed.
      addButton.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  /** Shared outside the family: said, and asked, before anything goes in (5.19). */
  const ask = (e?: FormEvent) => {
    e?.preventDefault();
    if (busy || n === 0 || tooMany) return;
    if (collection.shared_outside) setConfirming(true);
    else void add();
  };

  const names = known.names;
  const typeLabel = (f: Found) => props.types.find((t) => t.key === f.type_key)?.label;
  const personName = (f: Found) =>
    f.owner_member_id ? (names.get(f.owner_member_id) ?? null) : null;
  const shared = collection.shared_outside ?? null;
  const sharedId = 'add-docs-shared';
  const titleId = 'add-docs-h';

  const count = (() => {
    if (!current) return error ? '' : asked.words ? 'Searching…' : 'Loading your documents…';
    if (asked.words) {
      const found = `${documentsWord(rows.length)} found`;
      return current.capped
        ? `${found}, the closest ${SEARCH_MOST}. More words narrow it.`
        : current.sealing
          ? `${found}. Looking inside your private documents…`
          : found;
    }
    const all = documentsWord(current.total ?? rows.length);
    return anyFilter ? `${all} match these filters` : all;
  })();

  const empty = loading
    ? null
    : error && !current
      ? 'The documents could not be loaded.'
      : asked.words
        ? 'Nothing matches. Try other words, or fewer filters.'
        : anyFilter
          ? 'Nothing matches these filters.'
          : 'There are no documents to add yet.';

  const columns = COLUMNS.filter((c) => PICKER_COLUMNS.includes(c.key));
  const minWidth = PICK_WIDTH + columns.reduce((sum, c) => sum + (c.width ?? TITLE_MIN), 0);

  return (
    <Sheet
      label={`Add documents to “${collection.name}”`}
      busy={busy}
      returnFocus={props.returnFocus}
      onClose={props.onClose}
      className="card picker"
    >
      <h2 id={titleId} className="picker-h">
        Add documents to “{collection.name}”
      </h2>
      {/* Shared outside the family (5.19): said before anything goes in, and
          heard with the button that adds (as the ⋯'s sheet says it). */}
      {shared && (
        <p id={sharedId} className="status status-warn picker-shared">
          {sharedOutsideWords(shared, role)}
        </p>
      )}
      <div className="picker-find">
        <div className="field picker-search">
          <label htmlFor="add-docs-q">Search</label>
          <input
            id="add-docs-q"
            type="search"
            value={typed}
            maxLength={200}
            placeholder="Title, number, or words inside"
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>
        <div className="filters" role="group" aria-label="Filters">
          {filters.map((k) => (
            <FilterSelect
              key={k}
              id={`add-docs-${k}`}
              label={FILTER_LABELS[k]}
              value={asked[k]}
              options={filterChoices(k, known, view)}
              onChange={(v) => setFilter(k, v)}
            />
          ))}
          {anyFilter && (
            <button
              type="button"
              className="btn btn-quiet btn-small"
              onClick={() => setAsked((a) => ({ ...a, person: '', kind: '', status: '', tag: '' }))}
            >
              Clear filters
            </button>
          )}
        </div>
        <p className="muted picker-count" role="status">
          {count}
        </p>
      </div>
      <ErrorNote message={error} />
      <div className="picker-results" aria-busy={loading}>
        {wide ? (
          <div ref={wrap} className="tbl-wrap picker-wrap">
            <table
              ref={table}
              className="tbl"
              role="grid"
              style={{ minWidth }}
              onKeyDown={grid.onKeyDown}
              onFocus={grid.onFocus}
            >
              <caption className="visually-hidden">Documents to add to “{collection.name}”</caption>
              <colgroup>
                <col style={{ width: PICK_WIDTH }} />
                {columns.map((c) => (
                  <col key={c.key} style={c.width ? { width: c.width } : undefined} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  <th scope="col" className="col-pick">
                    {choosable.length > 0 ? (
                      <PickAll
                        ref={pickAllRef}
                        count={choosable.length}
                        checked={allChosen}
                        mixed={shownChosen > 0 && !allChosen}
                        onChange={chooseAll}
                      />
                    ) : (
                      <span className="visually-hidden">Choose</span>
                    )}
                  </th>
                  {columns.map((c) => (
                    <th
                      key={c.key}
                      scope="col"
                      className={c.key === 'title' ? 'col-title' : c.end ? 'end' : undefined}
                      style={c.key === 'title' ? { left: PICK_WIDTH } : undefined}
                    >
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((f) => {
                  const inside = isIn(f);
                  const on = chosen.has(f.id);
                  const kind = typeLabel(f);
                  const person = personName(f);
                  return (
                    <tr
                      key={f.id}
                      data-id={f.id}
                      className={inside ? 'in' : on ? 'picked' : undefined}
                      onClick={(e) => rowClick(e, f)}
                    >
                      <td className="col-pick">
                        {inside ? (
                          // Nothing to choose: a mark, and words for a screen reader.
                          <span className="pick-cell pick-in">
                            <span aria-hidden="true">✓</span>
                            <span className="visually-hidden">In this collection</span>
                          </span>
                        ) : (
                          <label className="pick-cell">
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={(e) => choose(f, e.target.checked)}
                            />
                            <span className="visually-hidden">Choose “{f.title}”</span>
                          </label>
                        )}
                      </td>
                      <td className="col-title" style={{ left: PICK_WIDTH }}>
                        <span className="picker-title">{f.title}</span>
                        {inside && (
                          <span className="picker-in" aria-hidden="true">
                            In this collection
                          </span>
                        )}
                      </td>
                      <td>{kind ?? <None />}</td>
                      <td>{person ?? <None />}</td>
                      <td className="end nowrap">{f.issued ? tableDate(f.issued) : <None />}</td>
                      <td className="end nowrap">{f.expires ? tableDate(f.expires) : <None />}</td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr className="empty-row">
                    <td colSpan={columns.length + 1}>
                      {empty ?? (asked.words ? 'Searching…' : 'Loading your documents…')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <ul ref={list} className="list picker-list" aria-label="Documents found">
            {rows.map((f) => {
              const inside = isIn(f);
              const line = [
                typeLabel(f),
                personName(f),
                f.expires ? `Expires ${tableDate(f.expires)}` : null,
              ]
                .filter(Boolean)
                .join(' · ');
              return (
                <li key={f.id} data-id={f.id} className="docrow" tabIndex={-1}>
                  {inside ? (
                    <div className="rowbtn rowpick picker-row-in">
                      <span className="pick-in" aria-hidden="true">
                        ✓
                      </span>
                      <span className="rowpick-words">
                        <span className="doc-title">{f.title}</span>
                        {line && <span className="muted">{line}</span>}
                        <span className="picker-in">In this collection</span>
                      </span>
                    </div>
                  ) : (
                    <label className="rowbtn rowpick">
                      <input
                        type="checkbox"
                        className="pick"
                        checked={chosen.has(f.id)}
                        aria-label={`Choose “${f.title}”`}
                        onChange={(e) => choose(f, e.target.checked)}
                      />
                      <span className="rowpick-words">
                        <span className="doc-title">{f.title}</span>
                        {line && <span className="muted">{line}</span>}
                      </span>
                    </label>
                  )}
                </li>
              );
            })}
            {rows.length === 0 && (
              <li className="muted">
                {empty ?? (asked.words ? 'Searching…' : 'Loading your documents…')}
              </li>
            )}
          </ul>
        )}
        {current?.next && (
          <div className="tbl-more">
            <button
              type="button"
              className="btn btn-quiet"
              aria-disabled={loadingMore || undefined}
              onClick={() => void showMore()}
            >
              {loadingMore ? 'Loading more…' : 'Show more'}
            </button>
            <span className="muted">
              {rows.length} of {current.total ?? '…'} shown
            </span>
          </div>
        )}
      </div>
      <form className="picker-foot" onSubmit={ask} noValidate>
        {refused && (
          <div className="error bulk-failed" role="alert">
            <p>{refused.head}</p>
            {refused.failed.length > 0 && (
              <ul>
                {refused.failed.map((f) => (
                  <li key={f.id}>“{f.title}”</li>
                ))}
              </ul>
            )}
            {refused.tail && <p className="muted">{refused.tail}</p>}
          </div>
        )}
        {tooMany && <p className="muted">Up to {MOST_AT_ONCE} can go in a collection at once.</p>}
        <div className="row picker-actions">
          <p className="picker-chosen" role="status">
            {n > 0 ? `${n} chosen` : 'Nothing chosen yet'}
          </p>
          {n > 0 && (
            <button
              type="button"
              className="btn btn-quiet btn-small"
              disabled={busy}
              onClick={() => {
                flushSync(() => setChosen(new Map()));
                document.getElementById('add-docs-q')?.focus();
              }}
            >
              Clear chosen
            </button>
          )}
          <span className="picker-buttons">
            <button
              ref={addButton}
              type="submit"
              className="btn btn-primary"
              disabled={n === 0 || tooMany}
              aria-disabled={busy || undefined}
              aria-describedby={shared ? sharedId : undefined}
            >
              {busy && !confirming
                ? 'Adding…'
                : n > 0
                  ? `Add ${n} to “${collection.name}”`
                  : `Add to “${collection.name}”`}
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              aria-disabled={busy || undefined}
              onClick={() => {
                if (!busy) props.onClose();
              }}
            >
              Cancel
            </button>
          </span>
        </div>
      </form>
      {confirming && shared && (
        <ConfirmDialog
          title={`Add ${documentsWord(n)} to “${collection.name}”?`}
          confirmLabel={`Add ${documentsWord(n)}`}
          busyLabel="Adding…"
          busy={busy}
          returnFocus={addButton}
          onConfirm={() => void add()}
          onCancel={() => setConfirming(false)}
        >
          <p>{sharedOutsideWords(shared, role)}</p>
        </ConfirmDialog>
      )}
    </Sheet>
  );
}
