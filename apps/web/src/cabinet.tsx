import {
  ARRANGE_BY,
  ARRANGE_BY_WORDS,
  CABINET_CHANGED,
  folderQuestionWords,
  folderTreeWords,
  FOLDERS_CABINET,
  daySpanWords,
  inSeveralWords,
  unfiledWords,
  dividerMode,
  dividersProblemOf,
  layoutProblem,
  mergedName,
  mergeFolderFilters,
  NOT_SURE_YET,
  PLACE_SEPARATOR,
  rangeWords,
  seesLocation,
  resolvedRanges,
  schoolStages,
  THE_HOUSEHOLD,
  type ArrangeBy,
  type Cabinet,
  type CabinetDrawer,
  type CabinetFolder,
  type CabinetLayout,
  type CabinetView,
  type DividerRange,
  type DocumentView,
  type FolderContents,
  type FolderDivider,
  type FolderDividers,
  type PinsMoved,
} from '@fdv/shared';
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api, ApiRequestError } from './api.js';
import { describeError, useApp, useLoad } from './app-context.js';
import { documentsCount, folderView } from './documents-table.js';
import { Button, ConfirmDialog, ErrorNote, LoadFailed, Sheet } from './ui.js';
import { DocRow } from './screens/Home.js';
import { storedRole } from './session.js';

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
export function cabinetHref(
  over: {
    cabinet?: string;
    folder?: string;
    arrange?: boolean;
    fromFolders?: boolean;
    unfiled?: boolean;
  } = {},
): string {
  const p = new URLSearchParams({ show: 'cabinet' });
  if (over.cabinet) p.set('cabinet', over.cabinet);
  if (over.folder) p.set('folder', over.folder);
  if (over.arrange) p.set('arrange', '1');
  // Keep this folder tree as my cabinet (0.9.0, C4): its drawing, to look over first.
  if (over.fromFolders) p.set('from', 'folders');
  // The papers no folder holds (19 Nov 2026).
  if (over.unfiled) p.set('unfiled', '1');
  return `/documents?${p.toString()}`;
}

/**
 * Whether this reader may keep their folder tree as their cabinet (C4): the
 * vault keeps the folder a paper came from, and they see where originals are.
 */
export function useFolderTreeOffered(): boolean {
  const { caps } = useApp();
  return (
    caps?.features.source_folders === true &&
    caps.features.cabinets === true &&
    seesLocation(storedRole())
  );
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
    /** A person of the family, as the reader is given them: their date of birth, for school stages. */
    member: (id: string) => members?.find((m) => m.id === id),
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
  const { authVersion, caps } = useApp();
  const placesOffered = caps?.features.original_place === true && seesLocation(storedRole());
  const [params, setParams] = useSearchParams();
  const arranging = params.get('arrange') === '1';
  const treeOffered = useFolderTreeOffered();
  const keepingTree = treeOffered && params.get('from') === 'folders';
  const mine = useLoad(async (t) => api.cabinet(t), [authVersion]);
  const layout = mine.data?.layout ?? null;
  const version = mine.data?.version ?? 0;
  // Counted for a cabinet; and, for whoever may keep their folder tree (C4),
  // also asked of an empty one: whether papers came from folders it has none
  // for yet (`new_folders`) — a cheap question, never the drawing itself.
  const loaded = mine.data !== undefined && mine.data !== null;
  const told = useLoad(
    async (t) => (loaded && (layout || treeOffered) ? await api.cabinetCounts(t) : null),
    [authVersion, version, layout !== null, loaded, treeOffered],
  );
  const counts = { ...told, data: told.data?.counts ?? null };
  // What the cabinet holds in all, each paper once (19 Nov 2026): the
  // table's own total; those in no folder; those in more than one.
  const whole = told.data?.documents;
  const unfiled = told.data?.unfiled ?? 0;
  const inSeveral = told.data?.in_several ?? 0;
  const showingUnfiled = params.get('unfiled') === '1';
  // Offered, never added unasked.
  const treeToAdd = treeOffered && !keepingTree && told.data?.new_folders === true;
  const names = useNames();
  const heading = useRef<HTMLHeadingElement>(null);

  const go = (over: {
    cabinet?: string;
    folder?: string;
    arrange?: boolean;
    fromFolders?: boolean;
    unfiled?: boolean;
  }) => setParams(new URLSearchParams(cabinetHref(over).split('?')[1]));

  let body: ReactNode;
  if (mine.error && !mine.data) {
    body = (
      <LoadFailed message={mine.error} what="your cabinet" onRetry={() => void mine.reload()} />
    );
  } else if (!mine.data) {
    body = <p className="muted">Opening your cabinet…</p>;
  } else if (keepingTree) {
    body = (
      <KeepFolderTree
        saved={mine.data}
        onCancel={() => go({})}
        onSaved={(saved, cabinetId) => {
          mine.setData(saved);
          go(cabinetId ? { cabinet: cabinetId } : {});
          heading.current?.focus();
        }}
      />
    );
  } else if (arranging) {
    body = (
      <ArrangeCabinet
        saved={mine.data}
        counts={counts.data ?? {}}
        pins={told.data?.pins ?? {}}
        names={names}
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
        <div className="actions">
          <Button onClick={() => go({ arrange: true })}>Arrange my cabinet</Button>
          {/* Or the folders the papers came from (C4), when there are any. */}
          {!layout && treeToAdd && (
            <Button kind="quiet" onClick={() => go({ fromFolders: true })}>
              Use my folder tree
            </Button>
          )}
        </div>
      </section>
    );
  } else if (showingUnfiled) {
    body = <UnfiledPane names={names} count={told.data?.unfiled} onBack={() => go({})} />;
  } else {
    body = (
      <Browse
        layout={layout}
        counts={counts.data ?? {}}
        cabinetId={params.get('cabinet')}
        folderId={params.get('folder')}
        names={names}
        onChoose={(cabinet, folder) => go({ cabinet, ...(folder ? { folder } : {}) })}
        onChanged={() => void counts.reload()}
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
        {/* Where the table's Columns is (DL): the same slot, so toggling
            Table and Cabinet moves neither. */}
        <div className="table-head-tool">
          {!arranging && !keepingTree && mine.data && layout && (
            <button
              type="button"
              className="btn btn-quiet btn-small"
              onClick={() => go({ arrange: true })}
            >
              Arrange my cabinet
            </button>
          )}
        </div>
      </div>
      {!arranging && !keepingTree && mine.data && (
        <div className="cab-bar">
          <p className="muted">
            <strong className="cab-mine">My cabinet</strong>
            {/* The total it holds, each paper once, in the table's own words. */}
            {layout && typeof whole === 'number' && <span>{` · ${documentsCount(whole)}`}</span>}
            {layout?.arranged_by && (
              <span>
                {' · '}
                {ARRANGE_BY_WORDS[layout.arranged_by].title.replace(/^By/, 'Arranged by')}
              </span>
            )}
            <span>{' · Only you see this arrangement'}</span>
            {/* Labels for the paper folders, each with a code (C3). */}
            {placesOffered && layout && (
              <span>
                {' · '}
                <Link to="/cabinet/labels">Print folder labels</Link>
              </span>
            )}
            {/* Folders papers came from, not in the cabinet yet (C4). */}
            {layout && treeToAdd && (
              <span>
                {' · '}
                <Link to={cabinetHref({ fromFolders: true })}>Keep my folder tree</Link>
              </span>
            )}
          </p>
        </div>
      )}
      {!arranging && !keepingTree && layout && (unfiled > 0 || inSeveral > 0) && (
        <p className="muted cab-held">
          {unfiled > 0 && <Link to={cabinetHref({ unfiled: true })}>{unfiledWords(unfiled)}</Link>}
          {unfiled > 0 && inSeveral > 0 && ' · '}
          {inSeveral > 0 &&
            `${inSeveralWords(inSeveral) ?? ''}, so the folders add up to more than ${documentsCount(whole ?? 0)}.`}
        </p>
      )}
      <ErrorNote message={counts.error} />
      {body}
    </main>
  );
}

// ------------------------------------------------------------- browsing

/**
 * The papers no shown folder holds (19 Nov 2026): those with no topic or
 * kind yet, those only a hidden folder holds, and those a cabinet arranged
 * by hand asks for nowhere — newest first, a page at a time.
 */
function UnfiledPane(props: {
  names: ReturnType<typeof useNames>;
  count: number | undefined;
  onBack: () => void;
}) {
  const { names } = props;
  const { withToken } = useApp();
  const navigate = useNavigate();
  const [items, setItems] = useState<DocumentView[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);
  const page = (cursor?: string) =>
    withToken((t) => api.cabinetUnfiled(t, { limit: 50, ...(cursor ? { cursor } : {}) }));
  useEffect(() => {
    let cancelled = false;
    void page()
      .then((p) => {
        if (cancelled || !p) return;
        setItems(p.items);
        setNext(p.next_cursor);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err));
      });
    return () => {
      cancelled = true;
    };
    // Asked again after a paper changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked]);
  const more = async () => {
    if (!next) return;
    try {
      const p = await page(next);
      if (!p) return;
      setItems((had) => [...(had ?? []), ...p.items]);
      setNext(p.next_cursor);
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <section className="cab-pane" aria-labelledby="cab-unfiled-h">
      <div className="cab-pane-head">
        <h2 id="cab-unfiled-h" className="cab-tab">
          <FolderIcon />
          <span>Not in any folder</span>
        </h2>
        <Button kind="quiet" onClick={props.onBack}>
          Back to my cabinet
        </Button>
      </div>
      <p className="muted">
        Papers none of your shown folders hold: those with no topic or kind yet, those only a hidden
        folder holds, and those your folders don’t ask for.
        {typeof props.count === 'number' && ` ${documentsCount(props.count)}.`}
      </p>
      <ErrorNote message={error} />
      {items === null && !error && <p className="muted">Opening…</p>}
      {items !== null && items.length === 0 && (
        <p className="cab-none">Every document is in a folder.</p>
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

/** Never shown: what Browse falls back to were it given no cabinet to show. */
const NO_CABINET: Cabinet = { id: '', name: '', hidden: false, drawers: [] };

function Browse(props: {
  layout: CabinetLayout;
  counts: Record<string, number | null>;
  cabinetId: string | null;
  folderId: string | null;
  names: ReturnType<typeof useNames>;
  onChoose: (cabinet: string, folder?: string) => void;
  /** A folder's papers changed (a pin taken away): its counts asked again. */
  onChanged: () => void;
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
            onChanged={props.onChanged}
          />
        ) : (
          <section className="cab-pane" aria-label="Folder">
            {/* A folder asked for that is not one of the reader's shown ones —
                a label printed from somebody else's cabinet, say (C3). */}
            {props.folderId ? (
              <p className="cab-none" role="status">
                That folder isn’t in your cabinet: a folder label opens the cabinet of whoever
                printed it. Choose one of your own folders.
              </p>
            ) : (
              <p className="muted">Choose a folder to see what is in it.</p>
            )}
          </section>
        )}
      </div>
    </>
  );
}

/**
 * A folder's papers (C2): those pinned into it first, marked, each with
 * Unpin; then its dividers, newest first — years, or the folder's own date
 * ranges — each with how many are behind it, opened to its papers a page
 * at a time. What it holds, and every count, is the vault's answer for this
 * person (GET /cabinet/folders/{id}).
 */
function FolderPane(props: {
  path: [string, string, string];
  folder: CabinetFolder;
  count: number | null | undefined;
  names: ReturnType<typeof useNames>;
  /** Something in it changed (a pin taken away): the counts are asked again. */
  onChanged: () => void;
}) {
  const { folder, names } = props;
  const { withToken, caps } = useApp();
  // Places in a cabinet (C3), for whoever sees where originals are kept.
  const places = caps?.features.original_place === true && seesLocation(storedRole());
  const navigate = useNavigate();
  const headingId = useId();
  const [contents, setContents] = useState<FolderContents | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);
  const [said, setSaid] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  // Asked again whenever what it asks, or how it is divided, changes.
  const shape = JSON.stringify([folder.filter, folder.dividers ?? null]);

  useEffect(() => {
    let cancelled = false;
    void withToken((t) => api.cabinetFolder(t, folder.id))
      .then((c) => {
        if (cancelled || !c) return;
        setContents(c);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [folder.id, shape, withToken, asked]);

  const changed = () => {
    setAsked((n) => n + 1);
    props.onChanged();
  };
  const unpin = async (d: DocumentView) => {
    const title = d.title ?? 'This paper';
    setBusy(d.id);
    try {
      await withToken((t) => api.unpinFromFolder(t, folder.id, d.id));
      setSaid(`${title} is unpinned from ${folder.name}.`);
      changed();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  const total = contents?.total ?? props.count;
  const dividers = contents?.dividers ?? [];
  const pinned = contents?.pinned ?? [];
  const empty = contents !== null && pinned.length === 0 && dividers.every((d) => d.count === 0);
  // The newest divider with something behind it starts open; the rest closed.
  const firstOpen = dividers.find((d) => d.count > 0)?.key;
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
        {/* Where originals are (0.9.0, C3): the papers filed in this very
            folder, and a label for the paper one, with a code to open it. */}
        {places && (
          <>
            <Link
              className="btn btn-quiet btn-small"
              to={`/documents?${new URLSearchParams({ original_place: props.path.join(PLACE_SEPARATOR) }).toString()}`}
            >
              Originals filed here
            </Link>
            <Link
              className="btn btn-quiet btn-small"
              to={`/cabinet/labels?${new URLSearchParams({ folder: folder.id }).toString()}`}
            >
              Print a label
            </Link>
          </>
        )}
      </div>
      <p className="muted">
        Fills itself: {folderQuestionWords(folder.filter, names)}
        {typeof total === 'number' && ` ${documentsCount(total)}.`}
      </p>
      <ErrorNote message={error} />
      {contents === null && !error && <p className="muted">Opening the folder…</p>}
      {empty && dividers.every((d) => d.kind !== 'range') && (
        <p className="cab-none">
          Nothing in this folder yet. Papers that fit will appear here by themselves.
        </p>
      )}
      {pinned.length > 0 && (
        <section className="cab-pinned" aria-labelledby={`${headingId}-pinned`}>
          <h3 id={`${headingId}-pinned`} className="cab-divider-name">
            <PinIcon />
            Pinned here
          </h3>
          <ul className="list doclist">
            {pinned.map((d) => (
              <DocRow
                key={d.id}
                doc={d}
                types={names.types}
                onOpen={() => void navigate(`/documents/${d.id}`)}
                onChanged={changed}
                pinned={{ onUnpin: () => void unpin(d), busy: busy === d.id }}
              />
            ))}
          </ul>
        </section>
      )}
      {contents !== null &&
        dividers.map((d) => (
          <DividerSection
            key={`${d.key}:${asked}`}
            folderId={folder.id}
            divider={d}
            startOpen={d.key === firstOpen || d.kind === 'all'}
            names={names}
            onChanged={changed}
          />
        ))}
      <p className="visually-hidden" role="status" aria-live="polite">
        {said}
      </p>
    </section>
  );
}

/** A paper pin, drawn: what marks a pinned paper. */
function PinIcon() {
  return (
    <svg
      className="icon"
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 4h6l-1 6 3 3H7l3-3zM12 13v7" />
    </svg>
  );
}

/** A divider's days, in words: "2025", "1 Sep 2014 to 31 Aug 2020", "since 2027". */
function dividerWords(d: FolderDivider): string | null {
  if (d.kind === 'year' || d.kind === 'all') return null;
  if (d.kind === 'other') return 'Papers in none of the ranges';
  return rangeWords(d.from ?? undefined, d.to ?? undefined);
}

/**
 * One divider of a folder, and the papers behind it: a tab that opens and
 * closes them, its count beside its name; its papers newest first, a page
 * at a time. A folder with no dividers is one list, with no tab.
 */
function DividerSection(props: {
  folderId: string;
  divider: FolderDivider;
  startOpen: boolean;
  names: ReturnType<typeof useNames>;
  onChanged: () => void;
}) {
  const { divider, names } = props;
  const { withToken } = useApp();
  const navigate = useNavigate();
  const listId = useId();
  const [open, setOpen] = useState(props.startOpen);
  const [items, setItems] = useState<DocumentView[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const page = (cursor?: string) =>
    withToken((t) =>
      api.cabinetFolderDocuments(t, props.folderId, {
        divider: divider.key,
        limit: 50,
        ...(cursor ? { cursor } : {}),
      }),
    );
  useEffect(() => {
    if (!open || items !== null || divider.count === 0) return;
    let cancelled = false;
    void page()
      .then((p) => {
        if (cancelled || !p) return;
        setItems(p.items);
        setNext(p.next_cursor);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err));
      });
    return () => {
      cancelled = true;
    };
    // The divider's own papers, asked once it is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const more = async () => {
    if (!next) return;
    try {
      const p = await page(next);
      if (!p) return;
      setItems((had) => [...(had ?? []), ...p.items]);
      setNext(p.next_cursor);
    } catch (err) {
      setError(describeError(err));
    }
  };

  const list = (
    <>
      <ErrorNote message={error} />
      {divider.count === 0 && divider.kind !== 'all' && (
        <p className="muted cab-divider-none">Nothing behind this divider yet.</p>
      )}
      {divider.count > 0 && items === null && !error && <p className="muted">Opening…</p>}
      {items !== null && items.length > 0 && (
        <ul className="list doclist" id={listId}>
          {items.map((d) => (
            <DocRow
              key={d.id}
              doc={d}
              types={names.types}
              onOpen={() => void navigate(`/documents/${d.id}`)}
              onChanged={props.onChanged}
            />
          ))}
        </ul>
      )}
      {next && (
        <Button kind="quiet" onClick={() => void more()}>
          Show more
        </Button>
      )}
    </>
  );
  if (divider.kind === 'all') return <div className="cab-divider-all">{list}</div>;
  const words = dividerWords(divider);
  return (
    <section className="cab-divider">
      <h3 className="cab-divider-head">
        <button
          type="button"
          className="cab-divider-tab"
          aria-expanded={open}
          aria-controls={open && items !== null && items.length > 0 ? listId : undefined}
          onClick={() => setOpen((o) => !o)}
        >
          <span aria-hidden="true" className="cab-caret">
            {open ? '▾' : '▸'}
          </span>
          <span className="cab-divider-name">{divider.name}</span>
          {words && <span className="muted cab-divider-days">{words}</span>}
          <Count n={divider.count} />
        </button>
      </h3>
      {open && list}
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
export function mergeDrawers(
  a: CabinetDrawer,
  b: CabinetDrawer,
  /** Where each folder that joined another went, for its pins to follow (C2). */
  moves: PinsMoved[] = [],
): CabinetDrawer {
  const folders = [...a.folders];
  for (const f of b.folders) {
    const at = folders.findIndex(
      (x) => x.name.trim().toLowerCase() === f.name.trim().toLowerCase(),
    );
    const joined =
      at === -1 ? null : mergeFolderFilters((folders[at] as CabinetFolder).filter, f.filter);
    if (at !== -1 && joined) {
      const into = folders[at] as CabinetFolder;
      folders[at] = { ...into, filter: joined };
      moves.push({ from: f.id, to: into.id });
    } else folders.push(f);
  }
  return { ...a, folders };
}

const clone = (l: CabinetLayout): CabinetLayout => JSON.parse(JSON.stringify(l)) as CabinetLayout;

/**
 * Keep this folder tree as my cabinet (0.9.0, C4): the folders the reader's
 * papers came from, drawn by the vault beside what their cabinet holds, to
 * look over first. Nothing is saved until they say so — and, when they have
 * a cabinet already, until they confirm it — and nothing there is changed:
 * the folders are added to the cabinet "My folders".
 */
function KeepFolderTree(props: {
  saved: CabinetView;
  onCancel: () => void;
  onSaved: (saved: CabinetView, cabinetId: string | null) => void;
}) {
  const { withToken } = useApp();
  const drawn = useLoad(async (t) => api.cabinetFromFolders(t), []);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const d = drawn.data;
  const tree = d
    ? d.layout.cabinets.find((c) => c.drawers.some((x) => x.folders.some((f) => f.id in d.counts)))
    : undefined;
  /** The drawers that get a new folder, each with only its new folders. */
  const added = (tree?.drawers ?? [])
    .map((x) => ({ ...x, folders: x.folders.filter((f) => (d ? f.id in d.counts : false)) }))
    .filter((x) => x.folders.length > 0);
  const hasCabinet = (props.saved.layout?.cabinets.length ?? 0) > 0;

  const keep = async () => {
    if (!d) return;
    setBusy(true);
    try {
      const done = await withToken((t) =>
        api.saveCabinet(t, { layout: d.layout, version: d.version }),
      );
      if (done) props.onSaved(done, tree?.id ?? null);
    } catch (err) {
      setAsking(false);
      if (err instanceof ApiRequestError && err.status === 409) {
        // Changed elsewhere meanwhile: drawn again on what it is now, never over it.
        setError(`${CABINET_CHANGED} The folders were drawn again on your cabinet as it is now.`);
        await drawn.reload();
      } else setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  let body: ReactNode;
  if (drawn.error && !d) {
    body = (
      <LoadFailed message={drawn.error} what="your folders" onRetry={() => void drawn.reload()} />
    );
  } else if (!d) {
    body = <p className="muted">Looking at your folders…</p>;
  } else if (d.folders.length === 0) {
    body = (
      <p className="cab-none">
        None of your papers came from a folder yet. Papers you add from a folder — with Add many,
        the scanner folder or a computer — keep the folder they came from.
      </p>
    );
  } else if (added.length === 0) {
    body = (
      <p className="cab-none">
        {d.left_out > 0
          ? 'Your cabinet has no room for more folders. Hide or merge some with Arrange my cabinet, then try again.'
          : folderTreeWords(d.added)}
      </p>
    );
  } else {
    body = (
      <>
        <p className="muted">{folderTreeWords(d.added)}</p>
        <ol className="arrange-tree folder-tree" aria-label={`New in “${FOLDERS_CABINET}”`}>
          {added.map((x) => (
            <li key={x.id}>
              <div className="arrange-row">
                <strong>{x.name}</strong>
              </div>
              <ol>
                {x.folders.map((f) => (
                  <li key={f.id}>
                    <div className="arrange-row">
                      <FolderIcon />
                      <span title={f.filter.source_folder}>{f.name}</span>
                      <Count n={d.counts[f.id]} />
                    </div>
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ol>
        {(d.already > 0 || d.left_out > 0) && (
          <p className="muted">
            {d.already > 0 &&
              `${d.already === 1 ? '1 folder is' : `${d.already} folders are`} in your cabinet already, and ${d.already === 1 ? 'stays' : 'stay'} as ${d.already === 1 ? 'it is' : 'they are'}. `}
            {d.left_out > 0 &&
              `${d.left_out === 1 ? '1 folder is' : `${d.left_out} folders are`} left out: that is more than a cabinet can hold.`}
          </p>
        )}
      </>
    );
  }

  return (
    <section className="arrange stack" aria-labelledby="tree-h" aria-busy={drawn.loading}>
      <div>
        <h2 id="tree-h" className="section-h">
          Keep this folder tree as my cabinet
        </h2>
        <p className="muted">
          Each folder your papers came from becomes a folder in the cabinet “{FOLDERS_CABINET}”, and
          holds the papers from that folder, now and as more are added. Nothing in your cabinet now
          is changed. Only you see this arrangement.
        </p>
      </div>
      {body}
      <ErrorNote message={error} />
      <div className="actions">
        <Button kind="quiet" onClick={props.onCancel}>
          {added.length > 0 ? 'Cancel' : 'Back to my cabinet'}
        </Button>
        {added.length > 0 && (
          <Button
            disabled={busy || drawn.loading}
            onClick={() => (hasCabinet ? setAsking(true) : void keep())}
          >
            {busy ? 'Saving…' : 'Keep this folder tree'}
          </Button>
        )}
      </div>
      {asking && d && (
        <ConfirmDialog
          title={
            d.added.folders === 1
              ? 'Add 1 folder to your cabinet?'
              : `Add ${d.added.folders} folders to your cabinet?`
          }
          confirmLabel="Add the folders"
          busyLabel="Saving…"
          busy={busy}
          onConfirm={() => void keep()}
          onCancel={() => setAsking(false)}
        >
          They go in the cabinet “{FOLDERS_CABINET}”. Your other cabinets, drawers and folders stay
          as they are. You can rename, move or hide the new ones with Arrange my cabinet.
        </ConfirmDialog>
      )}
    </section>
  );
}

/** Arrange my cabinet: a way to draw it, the drawing to look over and change, then Use this arrangement. */
function ArrangeCabinet(props: {
  saved: CabinetView;
  counts: Record<string, number | null>;
  /** Each folder's pinned papers, by its id (GET /cabinet/counts' `pins`). */
  pins: Record<string, number>;
  names: ReturnType<typeof useNames>;
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
  /** Folders merged into others, in order: their pins go with them (C2). */
  const [pinsMoved, setMoved] = useState<PinsMoved[]>([]);
  /** The folder whose dividers are being set, if any. */
  const [dividing, setDividing] = useState<string | null>(null);
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
    setMoved([]);
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
    setMoved([]);
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

  /** Pinned papers in all: what a new arrangement may let go of. */
  const pinnedAll = Object.values(props.pins).reduce((n, x) => n + x, 0);
  /** Those this arrangement lets go of: in folders it no longer has, not moved by a merge. */
  const pinsLost = (layout: CabinetLayout): number => {
    const kept = new Set(
      layout.cabinets.flatMap((c) => c.drawers.flatMap((d) => d.folders.map((f) => f.id))),
    );
    // As the vault follows merges: B into A, then A into Z, takes B's to Z.
    const target = new Map<string, string>();
    for (const m of pinsMoved.filter((x) => !kept.has(x.from))) {
      for (const [from, to] of target) if (to === m.from) target.set(from, m.to);
      if (!target.has(m.from)) target.set(m.from, m.to);
    }
    return Object.entries(props.pins)
      .filter(([folder]) => !kept.has(folder) && !kept.has(target.get(folder) ?? ''))
      .reduce((n, [, x]) => n + x, 0);
  };
  /** The pins a save would let go of, asked about first (the owner's rule: confirm what is destructive). */
  const [losing, setLosing] = useState<number | null>(null);

  const use = async (sure = false) => {
    if (!draft) return;
    // What was typed into a divider, tidied as it is kept: an end left empty is open.
    const tidy = clone(draft);
    for (const f of tidy.cabinets.flatMap((c) => c.drawers.flatMap((d) => d.folders))) {
      for (const r of f.dividers?.ranges ?? []) {
        r.name = r.name.trim();
        r.from = r.from?.trim() ? r.from.trim() : null;
        r.to = r.to?.trim() ? r.to.trim() : null;
      }
    }
    const problem = layoutProblem(tidy);
    if (problem) {
      setError(problem);
      return;
    }
    const lost = pinsLost(tidy);
    if (lost > 0 && !sure) {
      setLosing(lost);
      return;
    }
    setLosing(null);
    setBusy(true);
    try {
      const done = await withToken((t) =>
        api.saveCabinet(t, {
          layout: tidy,
          version,
          ...(pinsMoved.length > 0 ? { pins_moved: pinsMoved } : {}),
        }),
      );
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
    merge?: { into: string; apply: (l: CabinetLayout, moves: PinsMoved[]) => string | null };
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
              const moves: PinsMoved[] = [];
              const refused = m.apply(trial, moves);
              if (refused) {
                setSaid('');
                setError(refused);
                return;
              }
              setError(null);
              setDraft(trial);
              setMoved((had) => [...had, ...moves]);
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
        {choice !== 'mine' && pinnedAll > 0 && (
          <p className="muted">
            {pinnedAll === 1 ? 'You have 1 pinned paper' : `You have ${pinnedAll} pinned papers`}: a
            new arrangement lets go of the pins in folders it doesn’t keep, and asks first.
          </p>
        )}
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
                                apply: (l: CabinetLayout, moves: PinsMoved[]) => {
                                  const cab = l.cabinets[ci] as Cabinet;
                                  const above = cab.drawers[di - 1] as CabinetDrawer;
                                  cab.drawers[di - 1] = mergeDrawers(
                                    above,
                                    cab.drawers[di] as CabinetDrawer,
                                    moves,
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
                              extra: (
                                <>
                                  <Count n={counts[f.id]} />
                                  <button
                                    type="button"
                                    className="btn btn-quiet btn-small"
                                    aria-expanded={dividing === f.id}
                                    aria-label={`Dividers: ${dividersSummary(f.dividers)}, for ${f.name} in ${c.name} › ${d.name}`}
                                    onClick={() => setDividing((x) => (x === f.id ? null : f.id))}
                                  >
                                    Dividers: {dividersSummary(f.dividers)}
                                  </button>
                                </>
                              ),
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
                                      apply: (l: CabinetLayout, moves: PinsMoved[]) => {
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
                                        moves.push({ from: it.id, to: above.id });
                                        return null;
                                      },
                                    },
                                  }
                                : {}),
                            })}
                            {dividing === f.id && (
                              <DividerEditor
                                folder={f}
                                names={props.names}
                                onChange={(dividers, words) =>
                                  change((l) => {
                                    const it = (
                                      (l.cabinets[ci] as Cabinet).drawers[di] as CabinetDrawer
                                    ).folders[fi] as CabinetFolder;
                                    if (dividers === undefined) delete it.dividers;
                                    else it.dividers = dividers;
                                  }, words)
                                }
                              />
                            )}
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
      {losing !== null && (
        <ConfirmDialog
          title={losing === 1 ? 'Let 1 pinned paper go?' : `Let ${losing} pinned papers go?`}
          confirmLabel="Use this arrangement"
          busyLabel="Saving…"
          busy={busy}
          onConfirm={() => void use(true)}
          onCancel={() => setLosing(null)}
        >
          {losing === 1 ? 'It is' : 'They are'} pinned in folders this arrangement doesn’t keep, so{' '}
          {losing === 1 ? 'its pin goes' : 'their pins go'}. The papers themselves stay as they are,
          and you can pin them again.
        </ConfirmDialog>
      )}
    </section>
  );
}

/** A folder's dividers in a word or two: "years", "none", "3 ranges". */
function dividersSummary(d: FolderDividers | undefined): string {
  switch (dividerMode(d)) {
    case 'years':
      return 'by year';
    case 'none':
      return 'none';
    case 'ranges': {
      const n = d?.ranges.length ?? 0;
      return n === 1 ? '1 range' : `${n} ranges`;
    }
  }
}

/**
 * How a folder's papers are divided (C2): by year, by themselves; none; or
 * the folder's own date ranges, each named, its ends a year ("2014") or a
 * full date ("2014-09-01"), either left open. What is typed is kept as it is
 * typed (tidied only as it is left, and saved); the days it covers are said
 * under it — a year that ends one range and starts the next belongs to the
 * later one. A folder for one person with a date of birth offers their
 * school stages, asked first when it would replace dividers already there.
 * What is wrong is said as it is typed; the vault checks it again.
 */
function DividerEditor(props: {
  folder: CabinetFolder;
  names: ReturnType<typeof useNames>;
  onChange: (dividers: FolderDividers | undefined, words: string) => void;
}) {
  const { folder } = props;
  const groupId = useId();
  const [replacing, setReplacing] = useState(false);
  const mode = dividerMode(folder.dividers);
  const ranges = folder.dividers?.ranges ?? [];
  const spans = resolvedRanges(folder.dividers);
  const set = (next: DividerRange[], words: string) =>
    props.onChange({ years: true, ranges: next }, words);
  const at = (i: number, change: Partial<DividerRange>) =>
    set(
      ranges.map((r, j) => (j === i ? { ...r, ...change } : r)),
      '',
    );
  /** An end as it is left: trimmed, and open when nothing is typed. */
  const tidied = (v: string | null) => (v?.trim() ? v.trim() : null);
  // One person's folder, with a date of birth: their school stages, offered.
  const personId = folder.filter.member_id;
  const person = personId && !personId.includes(',') ? props.names.member(personId) : undefined;
  const stages = person?.date_of_birth ? schoolStages(person.date_of_birth) : null;
  const applyStages = () => {
    if (!stages || !person) return;
    setReplacing(false);
    set(
      stages,
      `School stages from ${person.display_name}’s birthday: ${stages.map((x) => x.name).join(', ')}.`,
    );
  };
  const problem = folder.dividers ? dividersProblemOf(folder.dividers) : null;
  return (
    <fieldset className="divider-editor" aria-labelledby={`${groupId}-l`}>
      <legend id={`${groupId}-l`}>Dividers in {folder.name}</legend>
      {(['years', 'none', 'ranges'] as const).map((m) => (
        <label key={m} className="divider-choice">
          <input
            type="radio"
            name={`${groupId}-mode`}
            checked={mode === m}
            onChange={() =>
              m === 'years'
                ? props.onChange(undefined, 'Divided by year.')
                : m === 'none'
                  ? props.onChange({ years: false, ranges: [] }, 'No dividers.')
                  : set(
                      ranges.length > 0 ? ranges : [{ name: '', from: null, to: null }],
                      'Your own dividers: name each, and when it starts and ends.',
                    )
            }
          />
          {m === 'years'
            ? 'By year, by themselves'
            : m === 'none'
              ? 'No dividers'
              : 'My own date ranges'}
        </label>
      ))}
      {mode === 'ranges' && (
        <>
          <p className="muted">
            A year (2014) or a full date (2014-09-01); leave an end empty to keep it open. Ranges
            can’t share a day, but a year that ends one and starts the next belongs to the later
            one. Papers in none of them go behind “Other years”.
          </p>
          <ol className="divider-ranges">
            {ranges.map((r, i) => {
              const label = r.name.trim() || `divider ${i + 1}`;
              const span = spans[i];
              const covers =
                span &&
                (span.from === null || /^\d{4}-\d{2}-\d{2}$/.test(span.from)) &&
                (span.to === null || /^\d{4}-\d{2}-\d{2}$/.test(span.to)) &&
                (span.from !== null || span.to !== null)
                  ? daySpanWords(span)
                  : '';
              return (
                <li key={i} className="divider-range">
                  <input
                    type="text"
                    aria-label={`Name of ${label}`}
                    placeholder="Name, e.g. Middle school"
                    maxLength={80}
                    value={r.name}
                    onChange={(e) => at(i, { name: e.target.value })}
                  />
                  <input
                    type="text"
                    inputMode="numeric"
                    aria-label={`${label} starts`}
                    placeholder="From"
                    maxLength={10}
                    value={r.from ?? ''}
                    onChange={(e) => at(i, { from: e.target.value === '' ? null : e.target.value })}
                    onBlur={() => {
                      if (tidied(r.from) !== r.from) at(i, { from: tidied(r.from) });
                    }}
                  />
                  <input
                    type="text"
                    inputMode="numeric"
                    aria-label={`${label} ends`}
                    placeholder="To"
                    maxLength={10}
                    value={r.to ?? ''}
                    onChange={(e) => at(i, { to: e.target.value === '' ? null : e.target.value })}
                    onBlur={() => {
                      if (tidied(r.to) !== r.to) at(i, { to: tidied(r.to) });
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-quiet btn-small"
                    aria-label={`Remove ${label}`}
                    onClick={() =>
                      ranges.length === 1
                        ? props.onChange(undefined, `${label} removed. Divided by year.`)
                        : set(
                            ranges.filter((_, j) => j !== i),
                            `${label} removed.`,
                          )
                    }
                  >
                    Remove
                  </button>
                  {covers && <span className="muted divider-covers">{covers}</span>}
                </li>
              );
            })}
          </ol>
          <div className="row">
            <Button
              kind="quiet"
              onClick={() =>
                set([...ranges, { name: '', from: null, to: null }], 'A divider is added.')
              }
            >
              Add a divider
            </Button>
          </div>
        </>
      )}
      {stages && person && (
        <div className="row">
          <Button
            kind="quiet"
            onClick={() =>
              mode === 'ranges' && ranges.length > 0 ? setReplacing(true) : applyStages()
            }
          >
            Use school stages from {person.display_name}’s birthday
          </Button>
        </div>
      )}
      {replacing && person && (
        <ConfirmDialog
          title={`Replace the dividers of ${folder.name}?`}
          confirmLabel="Use school stages"
          onConfirm={applyStages}
          onCancel={() => setReplacing(false)}
        >
          {ranges.length === 1 ? 'Its own divider goes' : `Its ${ranges.length} dividers go`}, and{' '}
          {person.display_name}’s school stages take {ranges.length === 1 ? 'its' : 'their'} place:
          Elementary, Middle school, High school and College.
        </ConfirmDialog>
      )}
      {problem && (
        <p className="field-error" role="status">
          {problem.message}
        </p>
      )}
    </fieldset>
  );
}

// ------------------------------------------------------------- Also in

/**
 * "Also in" on a document's page (C1): the reader's own folders it is in,
 * each a way to that folder — so nobody wonders where "the" copy is —
 * those it is pinned in marked (C2), and "Pin to a folder…" for a paper
 * out of the Trash. Nothing at all where they have no cabinet, or it is in
 * none of theirs and there is nowhere to pin it.
 */
export function AlsoInRow({ documentId, inTrash }: { documentId: string; inTrash?: boolean }) {
  const { authVersion, caps } = useApp();
  const on = caps?.features.cabinets === true;
  const pins = on && caps?.features.cabinet_pins === true && !inTrash;
  const [asked, setAsked] = useState(0);
  const [said, setSaid] = useState('');
  const [picking, setPicking] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const { data } = useLoad(
    async (t) => (on ? (await api.documentAlsoIn(t, documentId)).items : []),
    [documentId, authVersion, on, asked],
  );
  const { data: layout } = useLoad(
    async (t) => (pins ? (await api.cabinet(t)).layout : null),
    [authVersion, pins],
  );
  const folders = layout ? folderChoices(layout) : [];
  if (!data || (data.length === 0 && folders.length === 0)) return null;
  return (
    <>
      <dt>Also in</dt>
      <dd>
        {data.length > 0 ? (
          <ul className="also-in">
            {data.map((f) => (
              <li key={f.id}>
                <Link to={cabinetHref({ folder: f.id })}>
                  <FolderIcon />
                  <span>{f.path.join(' › ')}</span>
                </Link>
                {f.pinned && <span className="pin-mark muted"> · Pinned</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted also-in-none">In none of your folders.</p>
        )}
        {pins && folders.length > 0 && (
          <button
            ref={button}
            type="button"
            className="btn btn-quiet btn-small"
            onClick={() => setPicking(true)}
          >
            Pin to a folder…
          </button>
        )}
        <span className="visually-hidden" role="status" aria-live="polite">
          {said}
        </span>
        {picking && (
          <PinSheet
            documentIds={[documentId]}
            what="this paper"
            returnFocus={button}
            onClose={(news) => {
              setPicking(false);
              if (news) {
                setSaid(news);
                setAsked((n) => n + 1);
              }
            }}
          />
        )}
      </dd>
    </>
  );
}

/** The folders a paper may be pinned into: the shown ones, by where they are. */
export function folderChoices(layout: CabinetLayout): Array<{ id: string; path: string }> {
  return shownOf(layout.cabinets).flatMap((c) =>
    shownOf(c.drawers).flatMap((d) =>
      shownOf(d.folders).map((f) => ({ id: f.id, path: `${c.name} › ${d.name} › ${f.name}` })),
    ),
  );
}

/**
 * Pin to a folder… (C2): one of the reader's own folders chosen, and the
 * paper — or every one chosen in the table — pinned there, shown first in
 * it. Their own arrangement: nothing about a paper changes.
 */
export function PinSheet(props: {
  documentIds: string[];
  /** "this paper", "3 documents". */
  what: string;
  returnFocus: RefObject<HTMLElement | null>;
  onClose: (said: string | null) => void;
}) {
  const { authVersion, withToken } = useApp();
  const selectId = useId();
  const { data: layout, error: loadError } = useLoad(
    async (t) => (await api.cabinet(t)).layout,
    [authVersion],
  );
  const folders = layout ? folderChoices(layout) : [];
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = choice || folders[0]?.id || '';
  const pin = async () => {
    const to = folders.find((f) => f.id === chosen);
    if (!to) return;
    setBusy(true);
    try {
      const done = await withToken((t) => api.pinToFolder(t, to.id, props.documentIds));
      if (done)
        props.onClose(
          `${props.what[0]?.toUpperCase() ?? ''}${props.what.slice(1)} pinned to ${to.path}.`,
        );
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      label={`Pin ${props.what} to a folder`}
      busy={busy}
      returnFocus={props.returnFocus}
      onClose={() => props.onClose(null)}
    >
      <div className="card stack">
        <h2 style={{ fontSize: 20 }}>Pin {props.what} to a folder</h2>
        <p className="muted">
          A pinned paper shows first in that folder of your cabinet, whatever the folder asks for.
          Only you see your cabinet; nothing about the paper changes.
        </p>
        {loadError && <ErrorNote message={loadError} />}
        {layout !== null && folders.length === 0 && (
          <p className="cab-none">
            Your cabinet has no folders yet.{' '}
            <Link to={cabinetHref({ arrange: true })}>Arrange my cabinet</Link> first.
          </p>
        )}
        {folders.length > 0 && (
          <div className="field">
            <label htmlFor={selectId}>Folder</label>
            <select id={selectId} value={chosen} onChange={(e) => setChoice(e.target.value)}>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.path}
                </option>
              ))}
            </select>
          </div>
        )}
        <ErrorNote message={error} />
        <div className="row">
          <Button disabled={busy || folders.length === 0} onClick={() => void pin()}>
            {busy ? 'Pinning…' : 'Pin'}
          </Button>
          <Button kind="quiet" disabled={busy} onClick={() => props.onClose(null)}>
            Cancel
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
