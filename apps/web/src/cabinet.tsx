import {
  ARRANGE_BY,
  ARRANGE_BY_WORDS,
  CABINET_CHANGED,
  folderQuestionWords,
  layoutProblem,
  mergedName,
  mergeFolderFilters,
  NOT_SURE_YET,
  THE_HOUSEHOLD,
  type ArrangeBy,
  type Cabinet,
  type CabinetDrawer,
  type CabinetFolder,
  type CabinetLayout,
  type CabinetView,
  type DocumentView,
  type FolderFilter,
} from '@fdv/shared';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api, ApiRequestError } from './api.js';
import { describeError, useApp, useLoad } from './app-context.js';
import { documentsCount, folderView } from './documents-table.js';
import { Button, ErrorNote, LoadFailed } from './ui.js';
import { DocRow } from './screens/Home.js';

/**
 * My cabinet (0.9.0, C1; the owner's idea of 13 Nov 2026): the same
 * documents, laid out the way a family files paper — cabinets, drawers and
 * folders — beside the Documents table, never instead of it.
 *
 * Each person arranges their own, and nobody else sees it. A folder is a
 * saved question of the vault's list, so it fills itself: what it holds,
 * and how many, are what the vault gives this person for that question —
 * nothing they may not open. "Open in the table" carries the question to
 * the table's address.
 *
 * The address says what is shown: `?show=cabinet`, the cabinet and folder
 * chosen, and `arrange=1` while arranging — so Back goes where it was.
 */

/** The address of the cabinet, with these choices. */
function cabinetHref(over: { cabinet?: string; folder?: string; arrange?: boolean } = {}): string {
  const p = new URLSearchParams({ show: 'cabinet' });
  if (over.cabinet) p.set('cabinet', over.cabinet);
  if (over.folder) p.set('folder', over.folder);
  if (over.arrange) p.set('arrange', '1');
  return `/documents?${p.toString()}`;
}

/** Table or Cabinet: the two ways to see the same documents. */
export function ViewToggle({ current }: { current: 'table' | 'cabinet' }) {
  const navigate = useNavigate();
  return (
    <div className="view-toggle" role="group" aria-label="Show documents as">
      <button
        type="button"
        className="view-toggle-btn"
        aria-pressed={current === 'table'}
        onClick={() => {
          if (current !== 'table') void navigate('/documents');
        }}
      >
        Table
      </button>
      <button
        type="button"
        className="view-toggle-btn"
        aria-pressed={current === 'cabinet'}
        onClick={() => {
          if (current !== 'cabinet') void navigate(cabinetHref());
        }}
      >
        Cabinet
      </button>
    </div>
  );
}

/** A folder, drawn: the tab-topped shape of a paper one. */
export function FolderIcon() {
  return (
    <svg
      className="icon"
      aria-hidden="true"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

/** A cabinet, drawn: a box with two drawer handles. */
function CabinetIcon() {
  return (
    <svg
      className="icon"
      aria-hidden="true"
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M4 12h16M10 7.5h4M10 16.5h4" />
    </svg>
  );
}

/** How people and kinds are named, as this reader is given them. */
function useNames() {
  const { authVersion } = useApp();
  const { data: members } = useLoad(async (t) => (await api.members(t)).items, [authVersion]);
  const { data: types } = useLoad(
    async (t) => (await api.documentTypes(t, { all: true })).items,
    [authVersion],
  );
  return {
    types,
    person: (id: string) =>
      id === 'household'
        ? THE_HOUSEHOLD
        : id === 'none'
          ? NOT_SURE_YET
          : (members?.find((m) => m.id === id)?.display_name ?? 'someone in the family'),
    kind: (key: string) => types?.find((t) => t.key === key)?.label ?? 'another kind',
  };
}

/** A count, in words for a screen reader as well as the eye. */
function Count({ n }: { n: number | null | undefined }) {
  if (n === undefined) return null;
  return (
    <span className="cab-count">
      <span aria-hidden="true">{n === null ? '–' : n}</span>
      <span className="visually-hidden">
        {n === null ? ', not counted' : `, ${documentsCount(n)}`}
      </span>
    </span>
  );
}

const shownOf = <T extends { hidden: boolean }>(xs: readonly T[]) => xs.filter((x) => !x.hidden);

/** Documents, as a cabinet: the page `?show=cabinet` is. */
export function CabinetDocuments() {
  const { authVersion } = useApp();
  const [params, setParams] = useSearchParams();
  const arranging = params.get('arrange') === '1';
  const mine = useLoad(async (t) => api.cabinet(t), [authVersion]);
  const layout = mine.data?.layout ?? null;
  const version = mine.data?.version ?? 0;
  const counts = useLoad(
    async (t) => (layout ? (await api.cabinetCounts(t)).counts : {}),
    [authVersion, version, layout !== null],
  );
  const names = useNames();
  const heading = useRef<HTMLHeadingElement>(null);

  const go = (over: { cabinet?: string; folder?: string; arrange?: boolean }) =>
    setParams(new URLSearchParams(cabinetHref(over).split('?')[1]));

  let body: ReactNode;
  if (mine.error && !mine.data) {
    body = (
      <LoadFailed message={mine.error} what="your cabinet" onRetry={() => void mine.reload()} />
    );
  } else if (!mine.data) {
    body = <p className="muted">Opening your cabinet…</p>;
  } else if (arranging) {
    body = (
      <ArrangeCabinet
        saved={mine.data}
        counts={counts.data ?? {}}
        onCancel={() => go({})}
        onSaved={(saved) => {
          mine.setData(saved);
          go({});
          heading.current?.focus();
        }}
      />
    );
  } else if (!layout || shownOf(layout.cabinets).length === 0) {
    body = (
      <section className="cab-empty stack" aria-labelledby="cab-empty-h">
        <h2 id="cab-empty-h" className="section-h">
          {layout ? 'Every cabinet is hidden' : 'Your cabinet is empty'}
        </h2>
        <p>
          {layout
            ? 'Show a cabinet again while arranging, or draw a new arrangement.'
            : 'Arrange it from what the vault already knows: by person, by topic and year, or by kind. Folders fill themselves as papers are added.'}
        </p>
        <div>
          <Button onClick={() => go({ arrange: true })}>Arrange my cabinet</Button>
        </div>
      </section>
    );
  } else {
    body = (
      <Browse
        layout={layout}
        counts={counts.data ?? {}}
        cabinetId={params.get('cabinet')}
        folderId={params.get('folder')}
        names={names}
        onChoose={(cabinet, folder) => go({ cabinet, ...(folder ? { folder } : {}) })}
      />
    );
  }

  return (
    <main className="page page-table cabinet-page" aria-busy={mine.loading}>
      <div className="table-head">
        <h1 ref={heading} tabIndex={-1}>
          Documents
        </h1>
        <ViewToggle current="cabinet" />
      </div>
      {!arranging && mine.data && (
        <div className="cab-bar">
          <p className="muted">
            <strong className="cab-mine">My cabinet</strong>
            {layout?.arranged_by && (
              <span>
                {' · '}
                {ARRANGE_BY_WORDS[layout.arranged_by].title.replace(/^By/, 'Arranged by')}
              </span>
            )}
            <span>{' · Only you see this arrangement'}</span>
          </p>
          {layout && (
            <Button kind="quiet" onClick={() => go({ arrange: true })}>
              Arrange my cabinet
            </Button>
          )}
        </div>
      )}
      <ErrorNote message={counts.error} />
      {body}
    </main>
  );
}

// ------------------------------------------------------------- browsing

/** Never shown: what Browse falls back to were it given no cabinet to show. */
const NO_CABINET: Cabinet = { id: '', name: '', hidden: false, drawers: [] };

function Browse(props: {
  layout: CabinetLayout;
  counts: Record<string, number | null>;
  cabinetId: string | null;
  folderId: string | null;
  names: ReturnType<typeof useNames>;
  onChoose: (cabinet: string, folder?: string) => void;
}) {
  const { layout, counts, names } = props;
  const cabinets = shownOf(layout.cabinets);
  // The folder asked for, wherever it is; else the cabinet asked for; else the first.
  const holding = props.folderId
    ? cabinets.find((c) =>
        shownOf(c.drawers).some((d) => shownOf(d.folders).some((f) => f.id === props.folderId)),
      )
    : undefined;
  const cabinet: Cabinet =
    holding ?? cabinets.find((c) => c.id === props.cabinetId) ?? cabinets[0] ?? NO_CABINET;
  const drawers = shownOf(cabinet.drawers);
  const found = drawers
    .flatMap((d) => shownOf(d.folders).map((f) => ({ d, f })))
    .find(({ f }) => f.id === props.folderId);
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () => new Set([found?.d.id ?? drawers[0]?.id ?? '']),
  );
  const [lastFound, setLastFound] = useState(found?.d.id);
  // A folder chosen from elsewhere (Also in): its drawer opened.
  if (found && found.d.id !== lastFound) {
    setLastFound(found.d.id);
    setOpen((o) => new Set([...o, found.d.id]));
  }
  const toggle = (id: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      <ul className="cab-cards" aria-label="Your cabinets">
        {cabinets.map((c) => {
          const n = shownOf(c.drawers).length;
          return (
            <li key={c.id}>
              <button
                type="button"
                className="cab-card"
                aria-pressed={c.id === cabinet.id}
                onClick={() => props.onChoose(c.id)}
              >
                <CabinetIcon />
                <span className="cab-card-name">{c.name}</span>
                <span className="muted">{n === 1 ? '1 drawer' : `${n} drawers`}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="cab-browse">
        <nav className="cab-tree" aria-label={`Drawers and folders in ${cabinet.name}`}>
          {drawers.length === 0 ? (
            <p className="muted">Every drawer in this cabinet is hidden.</p>
          ) : (
            <ul>
              {drawers.map((d) => {
                const isOpen = open.has(d.id);
                const folders = shownOf(d.folders);
                return (
                  <li key={d.id}>
                    <button
                      type="button"
                      className="cab-drawer"
                      aria-expanded={isOpen}
                      onClick={() => toggle(d.id)}
                    >
                      <span aria-hidden="true" className="cab-caret">
                        {isOpen ? '▾' : '▸'}
                      </span>
                      <span className="cab-drawer-name">{d.name}</span>
                      <span className="muted cab-n">
                        {folders.length === 1 ? '1 folder' : `${folders.length} folders`}
                      </span>
                    </button>
                    {isOpen && (
                      <ul className="cab-folders">
                        {folders.map((f) => (
                          <li key={f.id}>
                            <button
                              type="button"
                              className="cab-folder"
                              aria-current={f.id === found?.f.id ? 'true' : undefined}
                              onClick={() => props.onChoose(cabinet.id, f.id)}
                            >
                              <FolderIcon />
                              <span className="cab-folder-name">{f.name}</span>
                              <Count n={counts[f.id]} />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </nav>
        {found ? (
          <FolderPane
            key={found.f.id}
            path={[cabinet.name, found.d.name, found.f.name]}
            folder={found.f}
            count={counts[found.f.id]}
            names={names}
          />
        ) : (
          <section className="cab-pane" aria-label="Folder">
            <p className="muted">Choose a folder to see what is in it.</p>
          </section>
        )}
      </div>
    </>
  );
}

/** A folder's papers: newest first, a page at a time. */
function FolderPane(props: {
  path: [string, string, string];
  folder: CabinetFolder;
  count: number | null | undefined;
  names: ReturnType<typeof useNames>;
}) {
  const { folder, names } = props;
  const { withToken } = useApp();
  const navigate = useNavigate();
  const headingId = useId();
  const [items, setItems] = useState<DocumentView[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);
  const filterKey = JSON.stringify(folder.filter);

  useEffect(() => {
    let cancelled = false;
    void withToken((t) =>
      api.documents(t, {
        ...(JSON.parse(filterKey) as FolderFilter),
        sort: 'dated',
        direction: 'desc',
        limit: 50,
      }),
    )
      .then((page) => {
        if (cancelled || !page) return;
        setItems(page.items);
        setNext(page.next_cursor);
        setTotal(page.total ?? page.items.length);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [filterKey, withToken, asked]);

  const more = async () => {
    if (!next) return;
    try {
      const page = await withToken((t) =>
        api.documents(t, {
          ...folder.filter,
          sort: 'dated',
          direction: 'desc',
          limit: 50,
          cursor: next,
        }),
      );
      if (!page) return;
      setItems((had) => [...(had ?? []), ...page.items]);
      setNext(page.next_cursor);
    } catch (err) {
      setError(describeError(err));
    }
  };

  const shown = total ?? props.count;
  return (
    <section className="cab-pane" aria-labelledby={headingId}>
      <p className="cab-path muted">{props.path.join(' › ')}</p>
      <div className="cab-pane-head">
        <h2 id={headingId} className="cab-tab">
          <FolderIcon />
          <span>{folder.name}</span>
        </h2>
        <Link
          className="btn btn-quiet btn-small"
          to={`/documents?${folderView(folder.filter).toString()}`}
        >
          Open in the table
        </Link>
      </div>
      <p className="muted">
        Fills itself: {folderQuestionWords(folder.filter, names)}
        {typeof shown === 'number' && ` ${documentsCount(shown)}.`}
      </p>
      <ErrorNote message={error} />
      {items === null && !error && <p className="muted">Opening the folder…</p>}
      {items !== null && items.length === 0 && (
        <p className="cab-none">
          Nothing in this folder yet. Papers that fit will appear here by themselves.
        </p>
      )}
      {items !== null && items.length > 0 && (
        <ul className="list doclist">
          {items.map((d) => (
            <DocRow
              key={d.id}
              doc={d}
              types={names.types}
              onOpen={() => void navigate(`/documents/${d.id}`)}
              onChanged={() => setAsked((n) => n + 1)}
            />
          ))}
        </ul>
      )}
      {next && (
        <Button kind="quiet" onClick={() => void more()}>
          Show more
        </Button>
      )}
    </section>
  );
}

// ------------------------------------------------------------- arranging

type Level = 'cabinet' | 'drawer' | 'folder';
const LEVEL_WORDS: Record<Level, string> = {
  cabinet: 'cabinet',
  drawer: 'drawer',
  folder: 'folder',
};

/** One list moved: the item at `i` swapped with its neighbour. */
function moved<T>(xs: readonly T[], i: number, by: -1 | 1): T[] {
  const out = [...xs];
  const j = i + by;
  if (j < 0 || j >= out.length) return out;
  [out[i], out[j]] = [out[j] as T, out[i] as T];
  return out;
}

/** Two drawers as one: the second's folders in the first, a folder of the same name and a question that can join, joined. */
export function mergeDrawers(a: CabinetDrawer, b: CabinetDrawer): CabinetDrawer {
  const folders = [...a.folders];
  for (const f of b.folders) {
    const at = folders.findIndex(
      (x) => x.name.trim().toLowerCase() === f.name.trim().toLowerCase(),
    );
    const joined =
      at === -1 ? null : mergeFolderFilters((folders[at] as CabinetFolder).filter, f.filter);
    if (at !== -1 && joined) folders[at] = { ...(folders[at] as CabinetFolder), filter: joined };
    else folders.push(f);
  }
  return { ...a, folders };
}

const clone = (l: CabinetLayout): CabinetLayout => JSON.parse(JSON.stringify(l)) as CabinetLayout;

/** Arrange my cabinet: a way to draw it, the drawing to look over and change, then Use this arrangement. */
function ArrangeCabinet(props: {
  saved: CabinetView;
  counts: Record<string, number | null>;
  onCancel: () => void;
  onSaved: (saved: CabinetView) => void;
}) {
  const { withToken } = useApp();
  const { saved } = props;
  const [choice, setChoice] = useState<ArrangeBy | 'mine'>(saved.layout ? 'mine' : ARRANGE_BY[0]);
  const [draft, setDraft] = useState<CabinetLayout | null>(
    saved.layout ? clone(saved.layout) : null,
  );
  const [counts, setCounts] = useState<Record<string, number | null>>(props.counts);
  const [drawn, setDrawn] = useState<{ documents: number; left_out: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const [version, setVersion] = useState(saved.version);
  /** The arrangement saved elsewhere meanwhile, when a save found one (409). */
  const [newer, setNewer] = useState<CabinetView | null>(null);
  /** Mine let go: the newer arrangement, as it was saved, to work on instead. */
  const loadNewer = () => {
    if (!newer) return;
    setChoice('mine');
    setDraft(newer.layout ? clone(newer.layout) : null);
    setCounts({});
    setDrawn(null);
    setVersion(newer.version);
    setNewer(null);
    setError(null);
    setSaid('The newer arrangement is loaded. Your changes here were let go.');
  };
  const [busy, setBusy] = useState(false);
  const [focusOn, setFocusOn] = useState<{ id: string; act: string } | null>(null);
  const legendId = useId();

  // A way chosen: drawn by the vault from what this person can see.
  useEffect(() => {
    if (choice === 'mine') return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    void withToken((t) => api.previewCabinet(t, choice))
      .then((p) => {
        if (cancelled || !p) return;
        setDraft(p.layout);
        setCounts(p.counts);
        setDrawn({ documents: p.documents, left_out: p.left_out });
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [choice, withToken]);

  // After a move, the focus stays with what moved.
  useEffect(() => {
    if (!focusOn) return;
    const row = document.querySelector<HTMLElement>(`[data-node="${focusOn.id}"]`);
    // Moved as far as it goes: the way back, else its name.
    const other = focusOn.act === 'up' ? 'down' : 'up';
    const target =
      row?.querySelector<HTMLButtonElement>(`[data-act="${focusOn.act}"]:not([disabled])`) ??
      row?.querySelector<HTMLButtonElement>(`[data-act="${other}"]:not([disabled])`) ??
      row?.querySelector<HTMLInputElement>('input[type="text"]');
    target?.focus();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFocusOn(null);
  }, [focusOn]);

  const change = (
    fn: (l: CabinetLayout) => void,
    words: string,
    focus?: { id: string; act: string },
  ) => {
    setDraft((d) => {
      if (!d) return d;
      const next = clone(d);
      fn(next);
      return next;
    });
    setSaid(words);
    if (focus) setFocusOn(focus);
  };

  const use = async () => {
    if (!draft) return;
    const problem = layoutProblem(draft);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    try {
      const done = await withToken((t) => api.saveCabinet(t, { layout: draft, version }));
      if (done) props.onSaved(done);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409) {
        // Saved elsewhere meanwhile: this drawing kept, to be used over it once read again.
        const now = await withToken((t) => api.cabinet(t)).catch(() => null);
        if (now) {
          setVersion(now.version);
          setNewer(now);
        }
        setError(
          `${CABINET_CHANGED} Your arrangement here is kept: Use this arrangement again to put it in its place, or load the newer one instead.`,
        );
      } else setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  /** The row of one part: its name, Show, Move up and down, and merging into the one above. */
  const row = (opts: {
    level: Level;
    node: { id: string; name: string; hidden: boolean };
    index: number;
    count: number;
    /** Where it is, for a screen reader: "in Mansoor", "in Mansoor › Tax". */
    where?: string;
    rename: (l: CabinetLayout, name: string) => void;
    hide: (l: CabinetLayout, hidden: boolean) => void;
    move: (l: CabinetLayout, by: -1 | 1) => void;
    merge?: { into: string; apply: (l: CabinetLayout) => string | null };
    extra?: ReactNode;
  }) => {
    const { level, node, index, count } = opts;
    const word = LEVEL_WORDS[level];
    const name = node.name || `this ${word}`;
    // Two drawers of one name, in two cabinets, are told apart.
    const named = opts.where ? `${name} in ${opts.where}` : name;
    return (
      <div
        className={`arrange-row arrange-${level}${node.hidden ? ' arrange-hidden' : ''}`}
        data-node={node.id}
      >
        {level === 'folder' && <FolderIcon />}
        <input
          type="text"
          className="arrange-name"
          aria-label={`Name of the ${word} ${opts.where ? `${node.name} in ${opts.where}` : node.name}`}
          value={node.name}
          maxLength={80}
          onChange={(e) => {
            const v = e.target.value;
            change((l) => opts.rename(l, v), '');
          }}
        />
        {opts.extra}
        <label className="arrange-show">
          <input
            type="checkbox"
            checked={!node.hidden}
            onChange={(e) => {
              const show = e.target.checked;
              change((l) => opts.hide(l, !show), show ? `${name} is shown.` : `${name} is hidden.`);
            }}
          />
          Show
        </label>
        <button
          type="button"
          className="btn btn-quiet btn-small"
          data-act="up"
          disabled={index === 0}
          aria-label={`Move ${named} up`}
          onClick={() =>
            change((l) => opts.move(l, -1), `${name} moved up.`, { id: node.id, act: 'up' })
          }
        >
          ↑
        </button>
        <button
          type="button"
          className="btn btn-quiet btn-small"
          data-act="down"
          disabled={index === count - 1}
          aria-label={`Move ${named} down`}
          onClick={() =>
            change((l) => opts.move(l, 1), `${name} moved down.`, { id: node.id, act: 'down' })
          }
        >
          ↓
        </button>
        {opts.merge && (
          <button
            type="button"
            className="btn btn-quiet btn-small"
            aria-label={`Merge ${named} into ${opts.merge.into}`}
            onClick={() => {
              const m = opts.merge;
              if (!m || !draft) return;
              const trial = clone(draft);
              const refused = m.apply(trial);
              if (refused) {
                setSaid('');
                setError(refused);
                return;
              }
              setError(null);
              setDraft(trial);
              setSaid(`${name} merged into ${m.into}.`);
            }}
          >
            Merge into the one above
          </button>
        )}
      </div>
    );
  };

  const total = (draft?.cabinets ?? []).reduce(
    (n, c) => n + c.drawers.reduce((m, d) => m + d.folders.length, 0),
    0,
  );

  return (
    <section className="arrange stack" aria-labelledby="arrange-h">
      <div>
        <h2 id="arrange-h" className="section-h">
          Arrange my cabinet
        </h2>
        <p className="muted">Only you see this arrangement.</p>
      </div>
      <fieldset className="arrange-by" aria-labelledby={legendId}>
        <legend id={legendId}>Arrange by</legend>
        {saved.layout && (
          <label className={`arrange-choice${choice === 'mine' ? ' arrange-choice-on' : ''}`}>
            <input
              type="radio"
              name="arrange-by"
              checked={choice === 'mine'}
              onChange={() => {
                setChoice('mine');
                setDraft(saved.layout ? clone(saved.layout) : null);
                setCounts(props.counts);
                setDrawn(null);
              }}
            />
            <span>
              <strong>My cabinet as it is</strong>
              <span className="muted">Change its names, order and drawers below.</span>
            </span>
          </label>
        )}
        {ARRANGE_BY.map((by) => (
          <label key={by} className={`arrange-choice${choice === by ? ' arrange-choice-on' : ''}`}>
            <input
              type="radio"
              name="arrange-by"
              checked={choice === by}
              onChange={() => setChoice(by)}
            />
            <span>
              <strong>{ARRANGE_BY_WORDS[by].title}</strong>
              <span className="muted">{ARRANGE_BY_WORDS[by].example}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <section className="arrange-preview" aria-labelledby="arrange-preview-h" aria-busy={loading}>
        <h3 id="arrange-preview-h">Your cabinet will look like this</h3>
        {loading && <p className="muted">Drawing your cabinet…</p>}
        {drawn && !loading && (
          <p className="muted">
            {documentsCount(drawn.documents)} in {total === 1 ? '1 folder' : `${total} folders`}.
            {drawn.left_out > 0 &&
              ` ${drawn.left_out === 1 ? '1 document has' : `${drawn.left_out} documents have`} no topic or kind yet, so ${drawn.left_out === 1 ? 'it is' : 'they are'} in no folder until ${drawn.left_out === 1 ? 'its' : 'their'} details say where.`}
          </p>
        )}
        {draft && !loading && draft.cabinets.length === 0 && (
          <p className="cab-none">There is nothing to arrange yet: add some documents first.</p>
        )}
        {draft && !loading && draft.cabinets.length > 0 && (
          <ol className="arrange-tree">
            {draft.cabinets.map((c, ci) => (
              <li key={c.id}>
                {row({
                  level: 'cabinet',
                  node: c,
                  index: ci,
                  count: draft.cabinets.length,
                  rename: (l, v) => {
                    (l.cabinets[ci] as Cabinet).name = v;
                  },
                  hide: (l, h) => {
                    (l.cabinets[ci] as Cabinet).hidden = h;
                  },
                  move: (l, by) => {
                    l.cabinets = moved(l.cabinets, ci, by);
                  },
                })}
                <ol>
                  {c.drawers.map((d, di) => (
                    <li key={d.id}>
                      {row({
                        level: 'drawer',
                        node: d,
                        index: di,
                        count: c.drawers.length,
                        where: c.name,
                        rename: (l, v) => {
                          ((l.cabinets[ci] as Cabinet).drawers[di] as CabinetDrawer).name = v;
                        },
                        hide: (l, h) => {
                          ((l.cabinets[ci] as Cabinet).drawers[di] as CabinetDrawer).hidden = h;
                        },
                        move: (l, by) => {
                          const cab = l.cabinets[ci] as Cabinet;
                          cab.drawers = moved(cab.drawers, di, by);
                        },
                        ...(di > 0
                          ? {
                              merge: {
                                into: (c.drawers[di - 1] as CabinetDrawer).name,
                                apply: (l: CabinetLayout) => {
                                  const cab = l.cabinets[ci] as Cabinet;
                                  const above = cab.drawers[di - 1] as CabinetDrawer;
                                  cab.drawers[di - 1] = mergeDrawers(
                                    above,
                                    cab.drawers[di] as CabinetDrawer,
                                  );
                                  cab.drawers.splice(di, 1);
                                  return null;
                                },
                              },
                            }
                          : {}),
                      })}
                      <ol>
                        {d.folders.map((f, fi) => (
                          <li key={f.id}>
                            {row({
                              level: 'folder',
                              node: f,
                              index: fi,
                              count: d.folders.length,
                              where: `${c.name} › ${d.name}`,
                              extra: <Count n={counts[f.id]} />,
                              rename: (l, v) => {
                                (
                                  ((l.cabinets[ci] as Cabinet).drawers[di] as CabinetDrawer)
                                    .folders[fi] as CabinetFolder
                                ).name = v;
                              },
                              hide: (l, h) => {
                                (
                                  ((l.cabinets[ci] as Cabinet).drawers[di] as CabinetDrawer)
                                    .folders[fi] as CabinetFolder
                                ).hidden = h;
                              },
                              move: (l, by) => {
                                const dr = (l.cabinets[ci] as Cabinet).drawers[di] as CabinetDrawer;
                                dr.folders = moved(dr.folders, fi, by);
                              },
                              ...(fi > 0
                                ? {
                                    merge: {
                                      into: (d.folders[fi - 1] as CabinetFolder).name,
                                      apply: (l: CabinetLayout) => {
                                        const dr = (l.cabinets[ci] as Cabinet).drawers[
                                          di
                                        ] as CabinetDrawer;
                                        const above = dr.folders[fi - 1] as CabinetFolder;
                                        const it = dr.folders[fi] as CabinetFolder;
                                        const joined = mergeFolderFilters(above.filter, it.filter);
                                        if (!joined) {
                                          return `“${it.name}” and “${above.name}” fill themselves with different papers, so they cannot be one folder. Try merging their drawers instead.`;
                                        }
                                        dr.folders[fi - 1] = {
                                          ...above,
                                          name: mergedName(above.name, it.name),
                                          filter: joined,
                                        };
                                        dr.folders.splice(fi, 1);
                                        return null;
                                      },
                                    },
                                  }
                                : {}),
                            })}
                          </li>
                        ))}
                      </ol>
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ol>
        )}
      </section>
      <p className="visually-hidden" role="status" aria-live="polite">
        {said}
      </p>
      <ErrorNote message={error} />
      <div className="actions">
        <Button kind="quiet" onClick={props.onCancel}>
          Cancel
        </Button>
        {newer && (
          <Button kind="quiet" onClick={loadNewer}>
            Load the newer arrangement
          </Button>
        )}
        <Button disabled={!draft || loading || busy} onClick={() => void use()}>
          {busy ? 'Saving…' : 'Use this arrangement'}
        </Button>
      </div>
    </section>
  );
}

// ------------------------------------------------------------- Also in

/**
 * "Also in" on a document's page (C1): the reader's own folders it is in,
 * each a way to that folder — so nobody wonders where "the" copy is.
 * Nothing at all where they have no cabinet, or it is in none of theirs.
 */
export function AlsoInRow({ documentId }: { documentId: string }) {
  const { authVersion, caps } = useApp();
  const on = caps?.features.cabinets === true;
  const { data } = useLoad(
    async (t) => (on ? (await api.documentAlsoIn(t, documentId)).items : []),
    [documentId, authVersion, on],
  );
  if (!data || data.length === 0) return null;
  return (
    <>
      <dt>Also in</dt>
      <dd>
        <ul className="also-in">
          {data.map((f) => (
            <li key={f.id}>
              <Link to={cabinetHref({ folder: f.id })}>
                <FolderIcon />
                <span>{f.path.join(' › ')}</span>
              </Link>
            </li>
          ))}
        </ul>
      </dd>
    </>
  );
}
