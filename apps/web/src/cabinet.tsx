import {
  asksOneYear,
  CABINET_CHANGED,
  CABINET_LEVEL_WORDS,
  CABINET_LEVELS,
  CABINET_LIMITS,
  cabinetLevels,
  cabinetSize,
  dividerLevelsOf,
  LEVEL_LIMITS,
  LEVEL_PRESETS,
  levelsProblem,
  levelsWords,
  moveDownFor,
  moveDownWords,
  NO_MOVE_WORDS,
  nodeLevels,
  ownLevelsProblem,
  sizeWarnings,
  sizeWarningWords,
  folderQuestionWords,
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
  type Cabinet,
  type CabinetLevel,
  type CabinetSize,
  type CabinetDrawer,
  type CabinetFolder,
  type CabinetLayout,
  type CabinetView,
  type DividerRange,
  type DocumentView,
  type FolderContents,
  type FolderDivider,
  type FolderDividers,
  type IssuerSameAs,
  type PinsMoved,
  type SizeWarning,
} from '@fdv/shared';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api, ApiRequestError } from './api.js';
import { describeError, useApp, useLoad } from './app-context.js';
import { documentsCount, folderView } from './documents-table.js';
import {
  Button,
  ConfirmDialog,
  ErrorNote,
  LoadFailed,
  LockIcon,
  Sheet,
  useSheetFocus,
  Caret,
} from './ui.js';
import { DocRow } from './screens/Home.js';
import { useChangesBeside, useOpenDocument } from './flyout-context.js';
import { issuersChanged, useIssuersVersion } from './issuer-store.js';
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
    unfiled?: boolean;
  } = {},
): string {
  const p = new URLSearchParams({ show: 'cabinet' });
  if (over.cabinet) p.set('cabinet', over.cabinet);
  if (over.folder) p.set('folder', over.folder);
  if (over.arrange) p.set('arrange', '1');
  // The papers no folder holds (19 Nov 2026).
  if (over.unfiled) p.set('unfiled', '1');
  return `/documents?${p.toString()}`;
}

/**
 * Table or Cabinet: the two ways to see the same documents. Cabinet's ▾
 * opens Arrange my cabinet (24 Nov 2026), from either view; while
 * arranging, it is not offered again.
 */
export function ViewToggle({
  current,
  arranging = false,
}: {
  current: 'table' | 'cabinet';
  arranging?: boolean;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const id = useId();
  const more = useRef<HTMLButtonElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      more.current?.focus();
    };
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
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
      ref={wrap}
      className="view-toggle-wrap"
      onBlur={(e) => {
        if (open && e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
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
          className="view-toggle-btn view-toggle-cabinet"
          aria-pressed={current === 'cabinet'}
          onClick={() => {
            if (current !== 'cabinet') void navigate(cabinetHref());
          }}
        >
          Cabinet
        </button>
        <button
          ref={more}
          type="button"
          className="view-toggle-btn view-toggle-more"
          aria-label="More for the cabinet"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          disabled={arranging}
          onClick={() => setOpen((o) => !o)}
        >
          <Caret />
        </button>
      </div>
      {open && (
        <div id={id} className="view-toggle-menu" role="menu" aria-label="Cabinet">
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            autoFocus
            onClick={() => {
              setOpen(false);
              void navigate(cabinetHref({ arrange: true }));
            }}
          >
            Arrange my cabinet
          </button>
        </div>
      )}
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

/** How people, kinds and issuers are named, as this reader is given them. */
function useNames() {
  const { authVersion, caps } = useApp();
  const { data: members } = useLoad(async (t) => (await api.members(t)).items, [authVersion]);
  const { data: types } = useLoad(
    async (t) => (await api.documentTypes(t, { all: true })).items,
    [authVersion],
  );
  // Who issued it, as the household names it (0.9.0-dev.91): only where the vault keeps it.
  const byIssuer = caps?.features.cabinet_issuer === true;
  // Read again whenever the household's list changes in this tab.
  const issuerChanges = useIssuersVersion();
  const { data: issuers } = useLoad(
    async (t) => (byIssuer ? (await api.issuerGroups(t)).items : []),
    [authVersion, byIssuer, issuerChanges],
  );
  return {
    issuer: (key: string) =>
      issuers?.find((g) => g.key === key || g.members.some((m) => m.key === key))?.name ?? key,
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
  const mine = useLoad(async (t) => api.cabinet(t), [authVersion]);
  const layout = mine.data?.layout ?? null;
  const version = mine.data?.version ?? 0;
  // Counted for a cabinet.
  const loaded = mine.data !== undefined && mine.data !== null;
  const told = useLoad(
    async (t) => (loaded && layout ? await api.cabinetCounts(t) : null),
    [authVersion, version, layout !== null, loaded],
  );
  const counts = { ...told, data: told.data?.counts ?? null };
  // What the cabinet holds in all, each paper once (19 Nov 2026): the
  // table's own total; those in no folder; those in more than one.
  const whole = told.data?.documents;
  const unfiled = told.data?.unfiled ?? 0;
  const inSeveral = told.data?.in_several ?? 0;
  const showingUnfiled = params.get('unfiled') === '1';
  const names = useNames();
  const heading = useRef<HTMLHeadingElement>(null);

  const go = (over: { cabinet?: string; folder?: string; arrange?: boolean; unfiled?: boolean }) =>
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
          {layout && layout.cabinets.length > 0
            ? 'Every cabinet is hidden'
            : 'Your cabinet is empty'}
        </h2>
        <p>
          {layout && layout.cabinets.length > 0
            ? 'Show a cabinet again while arranging, or draw a new arrangement.'
            : 'Arrange it from what the vault already knows: by person, by topic and year, or by kind. Folders fill themselves as papers are added.'}
        </p>
        <div className="actions">
          <Button onClick={() => go({ arrange: true })}>Arrange my cabinet</Button>
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
        {/* Right-most, as on the table; Arrange my cabinet is in its ▾. */}
        <ViewToggle current="cabinet" arranging={arranging} />
      </div>
      {!arranging && mine.data && (
        <div className="cab-bar">
          <p className="muted">
            <strong className="cab-mine">My cabinet</strong>
            {/* The total it holds, each paper once, in the table's own words. */}
            {layout && typeof whole === 'number' && <span>{` · ${documentsCount(whole)}`}</span>}
            {/* What it is arranged by (0.9.0-dev.90): its levels. */}
            {layout?.levels && <span>{` · Arranged by ${levelsWords(layout.levels)}`}</span>}
            <span>{' · Only you see this arrangement'}</span>
            {/* Labels for the paper folders, each with a code (C3). */}
            {placesOffered && layout && (
              <span>
                {' · '}
                <Link to="/cabinet/labels">Print folder labels</Link>
              </span>
            )}
          </p>
        </div>
      )}
      {!arranging && layout && (unfiled > 0 || inSeveral > 0) && (
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
 * kind yet, those only a hidden folder holds, and those no folder asks for
 * once one was changed — newest first, a page at a time.
 */
function UnfiledPane(props: {
  names: ReturnType<typeof useNames>;
  count: number | undefined;
  onBack: () => void;
}) {
  const { names } = props;
  const { withToken } = useApp();
  const openDocument = useOpenDocument();
  const [items, setItems] = useState<DocumentView[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);
  // Changed beside the list: asked again, and one moved to the Trash there gone at once.
  const gone = useChangesBeside(() => setAsked((n) => n + 1));
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
          {items
            .filter((d) => !gone.has(d.id))
            .map((d) => (
              <DocRow
                key={d.id}
                doc={d}
                types={names.types}
                onOpen={(e) => openDocument(d.id, { title: d.title, event: e })}
                onChanged={() => setAsked((n) => n + 1)}
                // Print in its ⋯, as in the Documents table's (0.9.0-dev.102).
                print
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

/**
 * Browsing: the cabinets as cards, the chosen one's drawers and folders
 * down the side, a folder's papers beside them. A level with only one
 * shown group is passed over, never stored so: a cabinet with one drawer
 * shows its folders straight away, and a drawer with one folder is one row,
 * "2024 › Me", that opens it. The folder's path still names every level,
 * and the address (so Back) is only ever the cabinet and folder chosen.
 */
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
  // The chosen folder's drawer open; else the first with folders to show
  // (one of a single folder is a row of its own, with nothing to open).
  const openFirst = (): ReadonlySet<string> =>
    new Set([
      found?.d.id ?? drawers.find((d) => shownOf(d.folders).length > 1)?.id ?? drawers[0]?.id ?? '',
    ]);
  const [open, setOpen] = useState<ReadonlySet<string>>(openFirst);
  // Worked out again for another cabinet, and for one whose only drawer
  // (passed over) has become a list of drawers: never drawers of the one
  // before left open, nor a new list with none open.
  const shape = `${cabinet.id}|${drawers.length > 1 ? 'drawers' : 'one'}`;
  const [lastShape, setLastShape] = useState(shape);
  if (shape !== lastShape) {
    setLastShape(shape);
    setOpen(openFirst());
  }
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
          const shown = shownOf(c.drawers);
          const n = shown.length;
          // One drawer is passed over: the card says how many folders it opens on.
          const folders = n === 1 ? shownOf(shown[0]?.folders ?? []).length : 0;
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
                <span className="muted">
                  {n === 1 ? (folders === 1 ? '1 folder' : `${folders} folders`) : `${n} drawers`}
                </span>
                {/* How it is arranged, where it is not the default's (0.9.0-dev.90). */}
                {c.drawn?.levels && <span className="badge badge-own">Own arrangement</span>}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="cab-browse">
        <nav className="cab-tree" aria-label={`Drawers and folders in ${cabinet.name}`}>
          {drawers.length === 0 ? (
            <p className="muted">Every drawer in this cabinet is hidden.</p>
          ) : drawers.length === 1 && drawers[0] ? (
            // One drawer: passed over, its folders shown straight away. Its
            // name stays said here and in the folder's path.
            <OnlyDrawer
              drawer={drawers[0]}
              counts={counts}
              current={found?.f.id}
              onChoose={(f) => props.onChoose(cabinet.id, f)}
            />
          ) : (
            <ul>
              {drawers.map((d) => {
                const isOpen = open.has(d.id);
                const folders = shownOf(d.folders);
                const only = folders.length === 1 ? folders[0] : undefined;
                if (only) {
                  // One folder: the drawer is one row, "2024 › Me", that opens it.
                  return (
                    <li key={d.id}>
                      <button
                        type="button"
                        className="cab-folder cab-folder-alone"
                        aria-current={only.id === found?.f.id ? 'true' : undefined}
                        onClick={() => props.onChoose(cabinet.id, only.id)}
                      >
                        <FolderIcon />
                        <span className="cab-folder-name">
                          <span className="visually-hidden">
                            {only.name}, in the {d.name} drawer
                          </span>
                          <span aria-hidden="true">
                            {d.name} <span className="cab-via">› {only.name}</span>
                          </span>
                        </span>
                        <Count n={counts[only.id]} />
                      </button>
                    </li>
                  );
                }
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
 * A cabinet's only shown drawer, passed over while browsing: its folders,
 * straight away, under a line saying which drawer they are in. The drawer
 * is still kept, so a paper that brings a second drawer simply adds it.
 */
function OnlyDrawer(props: {
  drawer: CabinetDrawer;
  counts: Record<string, number | null>;
  current: string | undefined;
  onChoose: (folder: string) => void;
}) {
  const { drawer, counts } = props;
  const folders = shownOf(drawer.folders);
  return (
    <>
      <p className="muted cab-skipped">In the {drawer.name} drawer.</p>
      {folders.length === 0 ? (
        <p className="muted">Every folder in this drawer is hidden.</p>
      ) : (
        <ul>
          {folders.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                className="cab-folder"
                aria-current={f.id === props.current ? 'true' : undefined}
                onClick={() => props.onChoose(f.id)}
              >
                <FolderIcon />
                <span className="cab-folder-name">{f.name}</span>
                <Count n={counts[f.id]} />
              </button>
            </li>
          ))}
        </ul>
      )}
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
  const openDocument = useOpenDocument();
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
  // Changed beside the list: asked again, and one moved to the Trash there gone at once.
  const gone = useChangesBeside(() => setAsked((n) => n + 1));
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
            {pinned
              .filter((d) => !gone.has(d.id))
              .map((d) => (
                <DocRow
                  key={d.id}
                  doc={d}
                  types={names.types}
                  onOpen={(e) => openDocument(d.id, { title: d.title, event: e })}
                  onChanged={changed}
                  pinned={{ onUnpin: () => void unpin(d), busy: busy === d.id }}
                  print
                />
              ))}
          </ul>
        </section>
      )}
      {contents !== null &&
        dividerGroups(dividers).map((g) =>
          g.leaves.length === 1 && (g.leaves[0]?.path?.length ?? 0) <= 1 ? (
            <DividerSection
              key={`${g.key}:${asked}`}
              folderId={folder.id}
              divider={g.leaves[0] as FolderDivider}
              startOpen={g.leaves[0]?.key === firstOpen || g.leaves[0]?.kind === 'all'}
              names={names}
              onChanged={changed}
            />
          ) : (
            // Levels 4 and 5 (0.9.0-dev.90): the leaves under their first step's tab.
            <DividerGroup
              key={`${g.key}:${asked}`}
              name={g.name}
              count={g.leaves.reduce((n, d) => n + d.count, 0)}
              startOpen={g.leaves.some((d) => d.key === firstOpen)}
            >
              {g.leaves.map((d) => (
                <DividerSection
                  key={d.key}
                  folderId={folder.id}
                  divider={d}
                  label={
                    (d.path ?? [])
                      .slice(1)
                      .map((step) => step.name)
                      .join(' · ') || d.name
                  }
                  nested
                  startOpen={d.key === firstOpen}
                  names={names}
                  onChanged={changed}
                />
              ))}
            </DividerGroup>
          ),
        )}
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

/**
 * A folder's dividers, grouped by their first step (0.9.0-dev.90): those of
 * two steps under the first's tab ("Bank statement", then "2025"); one of
 * one step, or one passed over inside its group, a group of its own.
 */
function dividerGroups(
  dividers: readonly FolderDivider[],
): Array<{ key: string; name: string; leaves: FolderDivider[] }> {
  const out: Array<{ key: string; name: string; leaves: FolderDivider[] }> = [];
  for (const d of dividers) {
    const first = d.path && d.path.length > 1 ? d.path[0] : undefined;
    const last = out[out.length - 1];
    if (first && last && last.key === first.key) last.leaves.push(d);
    else out.push({ key: first?.key ?? d.key, name: first?.name ?? d.name, leaves: [d] });
  }
  return out;
}

/** The tab of a first step of a folder's dividers, its leaves inside it, opened and closed. */
function DividerGroup(props: {
  name: string;
  count: number;
  startOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(props.startOpen);
  const inside = useId();
  return (
    <section className="cab-divider cab-divider-group">
      <h3 className="cab-divider-head">
        <button
          type="button"
          className="cab-divider-tab"
          aria-expanded={open}
          aria-controls={open ? inside : undefined}
          onClick={() => setOpen((o) => !o)}
        >
          <span aria-hidden="true" className="cab-caret">
            {open ? '▾' : '▸'}
          </span>
          <span className="cab-divider-name">{props.name}</span>
          <Count n={props.count} />
        </button>
      </h3>
      {open && (
        <div id={inside} className="cab-divider-inside">
          {props.children}
        </div>
      )}
    </section>
  );
}

/** A divider's days, in words: "2025", "1 Sep 2014 to 31 Aug 2020", "since 2027". */
function dividerWords(d: FolderDivider): string | null {
  if (d.kind === 'year' || d.kind === 'all' || d.kind === 'group') return null;
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
  /** Its name inside its group (0.9.0-dev.90): its steps after the group's. */
  label?: string;
  /** Inside a group: a heading a level down. */
  nested?: boolean;
  startOpen: boolean;
  names: ReturnType<typeof useNames>;
  onChanged: () => void;
}) {
  const { divider, names } = props;
  const { withToken } = useApp();
  const openDocument = useOpenDocument();
  const listId = useId();
  const [open, setOpen] = useState(props.startOpen);
  const [items, setItems] = useState<DocumentView[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Changed beside the list: its page asked again (when open), and one
  // moved to the Trash there gone at once.
  const gone = useChangesBeside(() => {
    setItems(null);
    setNext(null);
  });

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
          {items
            .filter((d) => !gone.has(d.id))
            .map((d) => (
              <DocRow
                key={d.id}
                doc={d}
                types={names.types}
                onOpen={(e) => openDocument(d.id, { title: d.title, event: e })}
                onChanged={props.onChanged}
                print
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
  const Heading = props.nested ? 'h4' : 'h3';
  return (
    <section className="cab-divider">
      <Heading className="cab-divider-head">
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
          <span className="cab-divider-name">{props.label ?? divider.name}</span>
          {words && <span className="muted cab-divider-days">{words}</span>}
          <Count n={divider.count} />
        </button>
      </Heading>
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

/** Numbers as the family reads them: 1,204. */
const COUNT = new Intl.NumberFormat('en-GB');

/** What a cabinet is, to the person arranging: drawn by the default, or by its own levels below it. */
function cabinetMark(c: Cabinet): 'default' | 'own' {
  return c.drawn?.levels ? 'own' : 'default';
}
const MARK_WORDS = {
  default: 'Follows the default',
  own: 'Own arrangement',
} as const;

/** What a level is, by its place among `total` levels: cabinet, drawer, folder or divider. */
function roleOf(at: number, total: number): 'cabinet' | 'drawer' | 'folder' | 'divider' {
  if (total <= LEVEL_LIMITS.fewest) return at === 0 ? 'drawer' : 'folder';
  return (['cabinet', 'drawer', 'folder'] as const)[at] ?? 'divider';
}
const ROLE_WORDS = {
  cabinet: 'Cabinet',
  drawer: 'Drawer',
  folder: 'Folder',
  divider: 'Divider',
} as const;
/** A role in a sentence: "now level 2, the drawers". */
const ROLE_PLURAL = {
  cabinet: 'the cabinets',
  drawer: 'the drawers',
  folder: 'the folders',
  divider: 'dividers inside each folder',
} as const;

const sameLevels = (
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined,
) =>
  (a ?? null) === null
    ? (b ?? null) === null
    : (b ?? null) !== null && a?.length === b?.length && (a ?? []).every((x, i) => x === b?.[i]);

/**
 * What saving a new default does, in words, said before it is saved: the
 * dividers alone; own arrangements let go wherever the vault's redraw lets
 * them go (the first level changing, or the default going from three or
 * more levels to two, or from two); pinned papers let go, counted. Null
 * where there is nothing to say.
 */
export function changeWords(
  saved: CabinetLayout | null,
  draft: CabinetLayout | null,
  /** Pinned papers in folders the draft no longer has. */
  pinsLost = 0,
): string | null {
  if (!draft?.levels || !saved) return null;
  const pinWords =
    pinsLost === 0
      ? ''
      : pinsLost === 1
        ? ' 1 pinned paper is in a folder this arrangement doesn’t keep: you are asked before it is let go.'
        : ` ${pinsLost} pinned papers are in folders this arrangement doesn’t keep: you are asked before they are let go.`;
  const kept =
    'Names you gave, hidden folders and pins are kept wherever the same folder is drawn again; you are asked first before any pin is let go.';
  if (!saved.levels) return `${kept}${pinWords}`;
  if (sameLevels(saved.levels, draft.levels)) return pinWords.trim() || null;
  if (sameLevels(nodeLevels(saved.levels), nodeLevels(draft.levels))) {
    return pinWords
      ? `Only the dividers change: no folder is redrawn.${pinWords}`
      : 'Only the dividers change: no folder is redrawn, and folders whose dividers you set yourself keep them.';
  }
  // Own arrangements stay only while there are three levels or more, the first the same.
  const ownStay =
    saved.levels.length >= LEVEL_LIMITS.nodes &&
    draft.levels.length >= LEVEL_LIMITS.nodes &&
    saved.levels[0] === draft.levels[0];
  const own = ownStay ? [] : saved.cabinets.filter((c) => c.drawn?.levels).map((c) => c.name);
  const ownWords =
    own.length === 0
      ? ''
      : ` ${own.join(', ')} ${own.length === 1 ? 'has its own arrangement, which is' : 'have their own arrangements, which are'} let go: ${draft.levels.length < LEVEL_LIMITS.nodes ? 'with two levels there is one cabinet, which follows them' : 'the first level, the cabinets themselves, changes'}.`;
  return `${kept}${ownWords}${pinWords}`;
}

/**
 * Arrange my cabinet (0.9.0-dev.90): the levels it is drawn by — the
 * default for every cabinet, or one cabinet's own below it — chosen and put
 * in order, drawn by the vault over what is there, then each part to rename,
 * hide, move or merge, and Use this arrangement. One structure
 * (0.9.0-dev.94): every cabinet is drawn by the levels, and Cancel and Use
 * this arrangement stay in a bar at the foot of the screen.
 */
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
  const [draft, setDraft] = useState<CabinetLayout | null>(
    saved.layout ? clone(saved.layout) : null,
  );
  /** What the picker arranges: the default, or one cabinet by its id. */
  const [scope, setScope] = useState<string>('default');
  /** The levels being chosen: the default's all, or a cabinet's below it. */
  const [picked, setPicked] = useState<CabinetLevel[]>(
    saved.layout ? [...(saved.layout.levels ?? [])] : [...(LEVEL_PRESETS[0] ?? [])],
  );
  /**
   * What the picker draws over while its levels change: the arrangement as
   * it was when it started, so one change never builds on another (unset
   * after any change made by hand, which a drawing then keeps).
   */
  const [base, setBase] = useState<CabinetLayout | null | undefined>(undefined);
  const asked = useRef(0);
  const [counts, setCounts] = useState<Record<string, number | null>>(props.counts);
  const [drawn, setDrawn] = useState<{ documents: number; left_out: number } | null>(null);
  /** Issuers that look like one, where Who issued it is a level asked (0.9.0-dev.91). */
  const [sameAs, setSameAs] = useState<IssuerSameAs[]>([]);
  /** Where a suggestion just said Same or Separate was, for the focus to stay near. */
  const [sameAsFocus, setSameAsFocus] = useState<number | null>(null);
  useEffect(() => {
    if (sameAsFocus === null) return;
    const rows = document.querySelectorAll<HTMLElement>('.same-as-list > li');
    const row = rows[Math.min(sameAsFocus, rows.length - 1)];
    const target =
      row?.querySelector<HTMLButtonElement>('button:not([disabled])') ??
      document.querySelector<HTMLButtonElement>('[data-level="issuer"] [data-act]:not([disabled])');
    target?.focus();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSameAsFocus(null);
  }, [sameAsFocus, sameAs]);
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
    setDraft(newer.layout ? clone(newer.layout) : null);
    setScope('default');
    setPicked([...(newer.layout?.levels ?? [])]);
    setBase(undefined);
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
  /** The screen, and its bar of Cancel and Use this arrangement at the foot. */
  const screenRef = useRef<HTMLElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  // The bar's height as it is now — a refusal said in it, its buttons on two
  // rows — kept on the screen (`--arrange-bar-h`): a part tabbed to stops
  // that far above the foot, never under the bar.
  useEffect(() => {
    const bar = barRef.current;
    const screen = screenRef.current;
    if (!bar || !screen || typeof ResizeObserver === 'undefined') return;
    const follow = () =>
      screen.style.setProperty(
        '--arrange-bar-h',
        `${Math.ceil(bar.getBoundingClientRect().height)}px`,
      );
    follow();
    const watch = new ResizeObserver(follow);
    watch.observe(bar);
    return () => watch.disconnect();
  }, []);

  /** What was last drawn: drawn again once issuers are said to be the same, or separate. */
  const [lastAsk, setLastAsk] = useState<{
    levels: CabinetLevel[];
    cabinet?: { id: string; levels: CabinetLevel[] | null };
  } | null>(null);
  /** Drawn by the vault: the default's levels, or one cabinet's own (null: the default's again). */
  const draw = (ask: {
    levels: CabinetLevel[];
    cabinet?: { id: string; levels: CabinetLevel[] | null };
  }) => {
    const from = base !== undefined ? base : draft;
    if (base === undefined) setBase(from);
    const n = ++asked.current;
    setLoading(true);
    void withToken((t) => api.previewCabinet(t, { ...ask, ...(from ? { layout: from } : {}) }))
      .then((p) => {
        if (!p || n !== asked.current) return;
        setDraft(p.layout);
        setCounts({ ...props.counts, ...p.counts });
        setDrawn({ documents: p.documents, left_out: p.left_out });
        setSameAs(p.same_as ?? []);
        setLastAsk(ask);
        setError(null);
      })
      .catch((err: unknown) => {
        if (n === asked.current) setError(describeError(err));
      })
      .finally(() => {
        if (n === asked.current) setLoading(false);
      });
  };

  // Nothing saved yet: the first shortcut drawn at once, to look over.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!saved.layout) draw({ levels: [...(LEVEL_PRESETS[0] ?? [])] });
    // Once, as arranging starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    // A change by hand: the next drawing keeps it.
    setBase(undefined);
    setSaid(words);
    if (focus) setFocusOn(focus);
  };

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

  const size = draft ? cabinetSize(draft) : null;
  const tooBig = size?.over !== null && size?.over !== undefined;
  // What the picker warns of: only the cabinets it would redraw — those
  // that follow the default, or the one being arranged — never another with
  // its own arrangement.
  const scopeSize = draft
    ? cabinetSize({
        levels: draft.levels,
        cabinets: draft.cabinets.filter((c) =>
          scope === 'default' ? !c.drawn?.levels : c.id === scope,
        ),
      })
    : null;

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

  /**
   * Two issuers said to be the same, or separate, from the picker
   * (0.9.0-dev.91): the household's list changed, and the cabinet drawn again.
   */
  const sameOrSeparate = async (s: IssuerSameAs, how: 'same' | 'separate') => {
    setBusy(true);
    try {
      const body = { from: s.from.key, to: s.to.key };
      await withToken((t) =>
        how === 'same' ? api.sameIssuer(t, body) : api.separateIssuer(t, body),
      );
      issuersChanged();
      // The focus on the suggestion that takes its place, else the one before,
      // else (none left) the Who issued it level itself.
      setSameAsFocus(sameAs.indexOf(s));
      setSameAs((list) => list.filter((x) => x !== s));
      setSaid(
        how === 'same'
          ? `“${s.from.name}” is now the same issuer as “${s.to.name}”.`
          : `“${s.from.name}” and “${s.to.name}” are kept separate.`,
      );
      if (how === 'same' && lastAsk) draw(lastAsk);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  // The scope: the default, or a drawn cabinet of the draft.
  const scoped = scope === 'default' ? undefined : draft?.cabinets.find((c) => c.id === scope);
  const defaults = draft?.levels ?? null;
  /** Levels chosen for the scope: new ones drawn at once, where they are 2 to 5. */
  const choose = (next: CabinetLevel[], words: string) => {
    setPicked(next);
    setSaid(words);
    if (scoped && defaults) {
      if (ownLevelsProblem(next, defaults) === null) {
        draw({ levels: defaults, cabinet: { id: scoped.id, levels: next } });
      }
    } else if (levelsProblem(next) === null) {
      draw({ levels: next });
    }
  };
  const arrangeCabinet = (c: Cabinet) => {
    if (!defaults) return;
    setScope(c.id);
    setBase(undefined);
    setPicked([...(c.drawn?.levels ?? defaults.slice(1))]);
    setSaid(`Arranging ${c.name}: choose the levels inside it.`);
  };
  const followDefault = (c: Cabinet) => {
    if (!defaults) return;
    setScope(c.id);
    setPicked(defaults.slice(1));
    setSaid(`${c.name} follows the default again.`);
    // Drawn over the arrangement as it is now, never a picker's earlier one.
    setBase(undefined);
    const from = draft;
    const n = ++asked.current;
    setLoading(true);
    void withToken((t) =>
      api.previewCabinet(t, {
        levels: defaults,
        cabinet: { id: c.id, levels: null },
        ...(from ? { layout: from } : {}),
      }),
    )
      .then((p) => {
        if (!p || n !== asked.current) return;
        setDraft(p.layout);
        setCounts({ ...props.counts, ...p.counts });
        setError(null);
      })
      .catch((err: unknown) => {
        if (n === asked.current) setError(describeError(err));
      })
      .finally(() => {
        if (n === asked.current) setLoading(false);
      });
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
              setBase(undefined);
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
  const lost = draft ? pinsLost(draft) : 0;
  const note = changeWords(saved.layout, draft, lost);

  return (
    <section ref={screenRef} className="arrange stack" aria-labelledby="arrange-h">
      <div>
        <h2 id="arrange-h" className="section-h">
          Arrange my cabinet
        </h2>
        <p className="muted">
          Only you see this arrangement. Folders fill themselves as papers are added.
        </p>
      </div>
      <div className="arrange-levels">
        <ArrangeScopes
          draft={draft}
          scope={scope}
          onDefault={() => {
            setScope('default');
            setBase(undefined);
            setPicked([...(draft?.levels ?? [])]);
          }}
          onArrange={arrangeCabinet}
          onUseDefault={followDefault}
        />
        <LevelPicker
          key={scope}
          scope={scoped && defaults ? { cabinet: scoped, defaults } : null}
          picked={picked}
          size={size}
          scopeSize={scopeSize}
          loading={loading}
          note={note}
          onChoose={choose}
          onUseDefault={scoped ? () => followDefault(scoped) : undefined}
          onSaveAnyway={() => void use()}
        />
        {(scoped ? [defaults?.[0], ...picked] : picked).includes('issuer') && sameAs.length > 0 && (
          <SameAsBox
            sameAs={sameAs}
            busy={busy}
            onSame={(s) => void sameOrSeparate(s, 'same')}
            onSeparate={(s) => void sameOrSeparate(s, 'separate')}
          />
        )}
      </div>

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
                  extra:
                    cabinetMark(c) === 'default' ? undefined : (
                      <span className="badge badge-own">{MARK_WORDS.own}</span>
                    ),
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
                                arranged={(() => {
                                  const eff = cabinetLevels(draft, c);
                                  return eff ? dividerLevelsOf(eff) : undefined;
                                })()}
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
      {/* Always in reach (0.9.0-dev.94): at the foot of the screen while the
          levels, the cabinets and the drawing scroll under it, last in the
          reading and Tab order; a refusal said beside the buttons. */}
      <div
        ref={barRef}
        className="arrange-bar"
        role="region"
        aria-label="Save or cancel this arrangement"
      >
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
          <Button disabled={!draft || loading || busy || tooBig} onClick={() => void use()}>
            {busy ? 'Saving…' : 'Use this arrangement'}
          </Button>
        </div>
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

/**
 * What to arrange: the default, for every cabinet, and each cabinet with
 * how it is arranged — following the default, or its own below the
 * cabinet level — and a ⋯ menu: Arrange this cabinet, and Use the default again.
 */
function ArrangeScopes(props: {
  draft: CabinetLayout | null;
  scope: string;
  onDefault: () => void;
  onArrange: (c: Cabinet) => void;
  onUseDefault: (c: Cabinet) => void;
}) {
  const { draft } = props;
  const [menu, setMenu] = useState<string | null>(null);
  // A cabinet has its own arrangement only below a default of three levels or more.
  const ownOffered = (draft?.levels?.length ?? 0) >= LEVEL_LIMITS.nodes;
  return (
    <ul className="arrange-scopes" aria-label="What to arrange">
      <li>
        <button
          type="button"
          className="arrange-scope"
          aria-pressed={props.scope === 'default'}
          onClick={props.onDefault}
        >
          <CabinetIcon />
          <span className="arrange-scope-name">The default, for every cabinet</span>
          <span className="muted arrange-scope-sub">
            {draft?.levels ? levelsWords(draft.levels) : 'No levels chosen yet'}
          </span>
        </button>
      </li>
      {(draft?.cabinets ?? []).map((c) => {
        const mark = cabinetMark(c);
        return (
          <li key={c.id} className="arrange-scope-cab">
            <div className="arrange-scope" aria-current={props.scope === c.id ? 'true' : undefined}>
              <CabinetIcon />
              <span className="arrange-scope-name">{c.name}</span>
              <span className="arrange-scope-sub">
                <span className={`badge badge-${mark}`}>{MARK_WORDS[mark]}</span>
              </span>
            </div>
            {ownOffered && (
              <CabinetMenu
                cabinet={c}
                open={menu === c.id}
                own={mark === 'own'}
                onOpen={(open) => setMenu(open ? c.id : null)}
                onArrange={() => {
                  setMenu(null);
                  props.onArrange(c);
                }}
                onUseDefault={() => {
                  setMenu(null);
                  props.onUseDefault(c);
                }}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** A cabinet's ⋯: Arrange this cabinet, and, with its own arrangement, Use the default again. */
function CabinetMenu(props: {
  cabinet: Cabinet;
  open: boolean;
  own: boolean;
  onOpen: (open: boolean) => void;
  onArrange: () => void;
  onUseDefault: () => void;
}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={button}
        type="button"
        className="btn btn-quiet btn-small arrange-more"
        aria-label={`More for ${props.cabinet.name}`}
        aria-haspopup="menu"
        aria-expanded={props.open}
        aria-controls={props.open ? id : undefined}
        onClick={() => props.onOpen(!props.open)}
      >
        ⋯
      </button>
      {props.open && (
        <MenuBox returnFocus={button} onClose={() => props.onOpen(false)}>
          <div id={id} role="menu" aria-label={props.cabinet.name} onKeyDown={moveInList}>
            <button type="button" role="menuitem" className="menu-item" onClick={props.onArrange}>
              Arrange this cabinet…
            </button>
            {props.own && (
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={props.onUseDefault}
              >
                Use the default again
              </button>
            )}
          </div>
        </MenuBox>
      )}
    </>
  );
}

/** A small menu in its place: focus on its first item, Tab kept inside, Escape back to its button. */
function MenuBox(props: {
  returnFocus: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  useSheetFocus(box, { onEscape: props.onClose, returnFocus: props.returnFocus });
  return (
    <div ref={box} className="menu-box arrange-menu">
      {props.children}
    </div>
  );
}

/** Up and down a menu's items, round from the end, and Home and End. */
function moveInList(e: ReactKeyboardEvent<HTMLDivElement>) {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const now = items.findIndex((item) => item === document.activeElement);
  const end = items.length - 1;
  const to = (
    {
      ArrowDown: now < end ? now + 1 : 0,
      ArrowUp: now > 0 ? now - 1 : end,
      Home: 0,
      End: end,
    } as Record<string, number>
  )[e.key];
  if (to === undefined) return;
  e.preventDefault();
  items[to]?.focus();
}

/**
 * The level picker: the levels in order, each its role — cabinet, drawer,
 * folder or divider — moved with ↑ and ↓ (or dragged by its grip), removed
 * with ×, added from the levels not in use; Who issued it shown, coming
 * next. For one cabinet, the default's first level is the cabinet itself,
 * fixed. What it makes is counted, with a warning — amber above what is easy
 * to open, red past what a cabinet can hold — and Move it down for me.
 */
function LevelPicker(props: {
  /** One cabinet's own, below the default's first level; null for the default. */
  scope: { cabinet: Cabinet; defaults: CabinetLevel[] } | null;
  picked: CabinetLevel[];
  /** The whole layout's: what refuses it. */
  size: CabinetSize | null;
  /** The cabinets this picker would redraw: what it warns of. */
  scopeSize: CabinetSize | null;
  loading: boolean;
  note: string | null;
  onChoose: (levels: CabinetLevel[], words: string) => void;
  onUseDefault: (() => void) | undefined;
  onSaveAnyway: () => void;
}) {
  const { scope, picked, size, scopeSize } = props;
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const [focusOn, setFocusOn] = useState<{ level: CabinetLevel; act: string } | null>(null);
  const dragging = useRef<number | null>(null);
  const locked = scope ? (scope.defaults[0] as CabinetLevel) : null;
  /** Every level, from the cabinet's own first. */
  const all: CabinetLevel[] = locked ? [locked, ...picked] : picked;
  const fewest = locked ? LEVEL_LIMITS.fewest + 1 : LEVEL_LIMITS.fewest;
  const most = LEVEL_LIMITS.most;
  const unused = CABINET_LEVELS.filter((l) => !all.includes(l));
  const name = (l: CabinetLevel) => CABINET_LEVEL_WORDS[l].name;

  // After a change, the focus on the level it was about, once its row is
  // drawn again: the button asked for, else another of its row, else the
  // picker's heading — never left on a button that is gone.
  useEffect(() => {
    if (!focusOn) return;
    const li = listRef.current?.querySelector<HTMLElement>(`[data-level="${focusOn.level}"]`);
    const target = [focusOn.act, 'up', 'down', 'remove']
      .map((act) => li?.querySelector<HTMLButtonElement>(`[data-act="${act}"]:not([disabled])`))
      .find((b) => b);
    (target ?? heading.current)?.focus();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFocusOn(null);
  }, [focusOn]);

  const placeWords = (levels: CabinetLevel[], l: CabinetLevel) => {
    const every = locked ? [locked, ...levels] : levels;
    const at = every.indexOf(l);
    return `now level ${at + 1}, ${ROLE_PLURAL[roleOf(at, every.length)]}`;
  };
  const moveTo = (from: number, to: number, focus?: string) => {
    if (to < 0 || to >= picked.length || from === to) return;
    const next = [...picked];
    const [l] = next.splice(from, 1);
    if (!l) return;
    next.splice(to, 0, l);
    props.onChoose(next, `${name(l)} moved ${to < from ? 'up' : 'down'}: ${placeWords(next, l)}.`);
    if (focus) setFocusOn({ level: l, act: focus });
  };

  // What it makes, and what is said of it: the cabinets it would redraw
  // warned of; the whole layout refused past what a cabinet can hold.
  const warnings = scopeSize ? sizeWarnings(scopeSize) : [];
  const over = size?.over !== null && size?.over !== undefined;
  const scoped = scopeSize ?? size;
  const worst: SizeWarning | undefined =
    over && scoped
      ? (scoped.biggest_drawer?.folders ?? 0) > CABINET_LIMITS.folders
        ? {
            code: 'folders',
            path: scoped.biggest_drawer?.path ?? ['', ''],
            folders: scoped.biggest_drawer?.folders ?? 0,
            cabinet_id: scoped.biggest_drawer?.cabinet_id ?? '',
          }
        : (scoped.biggest_cabinet?.drawers ?? 0) > CABINET_LIMITS.drawers
          ? {
              code: 'drawers',
              name: scoped.biggest_cabinet?.name ?? '',
              drawers: scoped.biggest_cabinet?.drawers ?? 0,
              cabinet_id: scoped.biggest_cabinet?.cabinet_id ?? '',
            }
          : { code: 'folders_total', folders: size?.folders ?? 0 }
      : warnings.find((w) => w.code !== 'near');
  const fix = worst ? moveDownFor(picked, worst, locked !== null, locked ? [locked] : []) : null;

  // Where a paper would be found, by the example of each level.
  const example = all.map((l, i) => ({
    l,
    divider: roleOf(i, all.length) === 'divider',
  }));
  const yearAbove = all.slice(0, LEVEL_LIMITS.nodes).includes('year');

  return (
    <section className="level-picker" aria-labelledby={headingId}>
      <div className="level-picker-top">
        <h3 id={headingId} ref={heading} tabIndex={-1}>
          {scope ? scope.cabinet.name : 'The default, for every cabinet'}
          {scope?.cabinet.drawn?.levels && <span className="badge badge-own">Own arrangement</span>}
        </h3>
        {scope && props.onUseDefault && scope.cabinet.drawn?.levels && (
          <button type="button" className="btn btn-quiet btn-small" onClick={props.onUseDefault}>
            Use the default again
          </button>
        )}
      </div>
      <p className="muted">
        {scope
          ? `The cabinet itself always comes from the default’s first level, ${name(scope.defaults[0] as CabinetLevel)}. Choose what goes inside it: ${levelsWords(scope.defaults.slice(1))} by default. If the default’s first level changes, this cabinet follows the default again.`
          : 'Every cabinet follows this order unless its ⋯ menu gives it its own. Only the first three levels make cabinets, drawers and folders; a fourth and fifth are dividers inside each folder, so they cost no folders.'}
      </p>
      {!scope && (
        <div className="level-chips" role="group" aria-label="Start from">
          <span className="muted">Start from:</span>
          {LEVEL_PRESETS.map((p) => (
            <button
              key={p.join()}
              type="button"
              className="chip"
              aria-pressed={sameLevels(p, picked)}
              onClick={() => props.onChoose([...p], `Arranged by ${levelsWords(p)}.`)}
            >
              {levelsWords(p)}
            </button>
          ))}
        </div>
      )}
      <ol ref={listRef} className="levels" aria-label="Levels, in order">
        {locked && (
          <li className="level level-locked" data-level={locked}>
            <span className="level-grip" aria-hidden="true">
              <LockIcon />
            </span>
            <span className="level-n">1</span>
            <span className="level-name">
              {name(locked)}
              <small className="muted">the cabinet itself, set by the default</small>
            </span>
            <span className="level-role level-role-cabinet">Cabinet</span>
          </li>
        )}
        {picked.map((l, i) => {
          const at = locked ? i + 1 : i;
          const role = roleOf(at, all.length);
          return (
            <li
              key={l}
              className="level"
              data-level={l}
              draggable
              onDragStart={(e) => {
                dragging.current = i;
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', l);
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const from = dragging.current;
                dragging.current = null;
                if (from !== null) moveTo(from, i);
              }}
            >
              <span className="level-grip" aria-hidden="true">
                ⋮⋮
              </span>
              <span className="level-n">{at + 1}</span>
              <span className="level-name">
                {name(l)}
                <small className="muted">{CABINET_LEVEL_WORDS[l].hint}</small>
              </span>
              <span className={`level-role level-role-${role}`}>{ROLE_WORDS[role]}</span>
              <span className="level-acts">
                <button
                  type="button"
                  className="btn btn-quiet btn-small"
                  data-act="up"
                  disabled={i === 0}
                  aria-label={`Move ${name(l)} up`}
                  onClick={() => moveTo(i, i - 1, 'up')}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="btn btn-quiet btn-small"
                  data-act="down"
                  disabled={i === picked.length - 1}
                  aria-label={`Move ${name(l)} down`}
                  onClick={() => moveTo(i, i + 1, 'down')}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="btn btn-quiet btn-small"
                  disabled={all.length <= fewest}
                  aria-label={`Remove ${name(l)}`}
                  data-act="remove"
                  onClick={() => {
                    props.onChoose(
                      picked.filter((x) => x !== l),
                      `${name(l)} removed.`,
                    );
                    // The level that takes its place, else the one before it.
                    const next = picked[i + 1] ?? picked[i - 1];
                    if (next) setFocusOn({ level: next, act: 'remove' });
                  }}
                >
                  ×
                </button>
              </span>
            </li>
          );
        })}
      </ol>
      <div className="level-chips" role="group" aria-label="Add a level">
        <span className="muted">
          {all.length >= most ? `Five levels at most.` : 'Add a level:'}
        </span>
        {all.length < most &&
          unused.map((l) => (
            <button
              key={l}
              type="button"
              className="chip chip-add"
              onClick={() => {
                props.onChoose(
                  [...picked, l],
                  `${name(l)} added: ${placeWords([...picked, l], l)}.`,
                );
                // Its button is gone: the focus on the level added.
                setFocusOn({ level: l, act: 'up' });
              }}
            >
              + {name(l)}
            </button>
          ))}
      </div>
      {all.length >= LEVEL_LIMITS.fewest && (
        <p className="level-example">
          <span className="muted">A paper would be found at: </span>
          {all.length <= LEVEL_LIMITS.fewest && <span>My cabinet › </span>}
          {example.map(({ l, divider }, i) => (
            <span key={l} className={divider ? 'level-example-divider' : undefined}>
              {i > 0 && ' › '}
              {CABINET_LEVEL_WORDS[l].example}
            </span>
          ))}
          <span className="muted">
            {all.length <= LEVEL_LIMITS.nodes
              ? yearAbove
                ? ' · no dividers, Year is above'
                : ' · dividers by year'
              : ''}
          </span>
        </p>
      )}
      {size && (
        <p className="muted level-size">
          <strong>Your cabinet:</strong>{' '}
          {`${size.cabinets === 1 ? '1 cabinet' : `${size.cabinets} cabinets`} · ${size.drawers === 1 ? '1 drawer' : `${COUNT.format(size.drawers)} drawers`} · ${size.folders === 1 ? '1 folder' : `${COUNT.format(size.folders)} folders`}.`}
        </p>
      )}
      {!props.loading && (over || warnings.length > 0) && (
        <div className={`level-warn${over ? ' level-warn-over' : ''}`} role="status">
          <p>
            <strong>
              {over ? 'That is more than a cabinet can hold.' : 'That is a lot of folders.'}
            </strong>{' '}
            {over
              ? `${worst ? sizeWarningWords(worst) : ''} A cabinet holds at most ${COUNT.format(CABINET_LIMITS.folders_total)} folders, ${CABINET_LIMITS.folders} in a drawer and ${CABINET_LIMITS.drawers} drawers in a cabinet, so this can’t be used.`
              : `${warnings.map(sizeWarningWords).join(' ')} Opening them takes many clicks.`}{' '}
            {fix ? moveDownWords(fix) : worst ? NO_MOVE_WORDS : ''}
          </p>
          <div className="row">
            {fix && (
              <button
                type="button"
                className="btn btn-primary btn-small"
                onClick={() => {
                  props.onChoose(
                    fix.levels,
                    `${fix.added ? `${name(fix.added)} added. ` : ''}${name(fix.level)} moved down: ${placeWords(fix.levels, fix.level)}.`,
                  );
                  // The box goes while the vault draws: the focus on the level moved.
                  setFocusOn({ level: fix.level, act: 'up' });
                }}
              >
                Move it down for me
              </button>
            )}
            {!over && (
              <button
                type="button"
                className="btn btn-quiet btn-small"
                onClick={props.onSaveAnyway}
              >
                Save anyway
              </button>
            )}
          </div>
        </div>
      )}
      {props.note && <p className="muted level-note">{props.note}</p>}
    </section>
  );
}

/**
 * Issuers that look like one (0.9.0-dev.91), where Who issued it is among
 * the levels chosen: "Barclays (14 papers) and Barclays Bank UK (3) look like
 * one." Same joins them in the household's list, for everybody, and the
 * cabinet is drawn again; Separate keeps them apart and stops suggesting it.
 * Never joined by itself; no paper is changed. Every issuer is in Settings.
 */
function SameAsBox(props: {
  sameAs: IssuerSameAs[];
  busy: boolean;
  onSame: (s: IssuerSameAs) => void;
  onSeparate: (s: IssuerSameAs) => void;
}) {
  const headingId = useId();
  const papers = (n: number) => `${n} paper${n === 1 ? '' : 's'}`;
  return (
    <section className="same-as" aria-labelledby={headingId}>
      <h3 id={headingId}>These issuers look like one</h3>
      <p className="muted">
        Say they are the same and they share a cabinet, drawer, folder or divider, for everybody in
        the family. No document is changed.
      </p>
      <ul className="same-as-list">
        {props.sameAs.slice(0, 5).map((s) => (
          <li key={`${s.from.key}\n${s.to.key}`}>
            <span>
              “{s.to.name}” ({papers(s.to.count)}) and “{s.from.name}” ({papers(s.from.count)}) look
              like one.
            </span>
            <span className="row" style={{ gap: 4 }}>
              <button
                type="button"
                className="btn btn-primary btn-small"
                disabled={props.busy}
                aria-label={`Same: “${s.from.name}” is “${s.to.name}”`}
                onClick={() => props.onSame(s)}
              >
                Same
              </button>
              <button
                type="button"
                className="btn btn-quiet btn-small"
                disabled={props.busy}
                aria-label={`Separate: keep “${s.from.name}” and “${s.to.name}” apart`}
                onClick={() => props.onSeparate(s)}
              >
                Separate
              </button>
            </span>
          </li>
        ))}
      </ul>
      <p className="muted">
        {props.sameAs.length > 5
          ? `${props.sameAs.length - 5} more, and every issuer, in `
          : 'Every issuer is in '}
        <Link to="/settings/issuers">Settings › Who issued it</Link>.
      </p>
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
    case 'levels':
      return byLevelsWords(d?.levels ?? []);
    case 'ranges': {
      const n = d?.ranges.length ?? 0;
      return n === 1 ? '1 range' : `${n} ranges`;
    }
  }
}

/** Divider levels in words: "by kind, then year". */
function byLevelsWords(levels: readonly CabinetLevel[]): string {
  return `by ${levels.map((l) => CABINET_LEVEL_WORDS[l].name.toLowerCase()).join(', then ')}`;
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
  /**
   * The divider levels its cabinet's levels give it (0.9.0-dev.90), for a
   * drawn folder: what "As arranged" puts back, whatever it is set to now.
   */
  arranged?: CabinetLevel[] | undefined;
  names: ReturnType<typeof useNames>;
  onChange: (dividers: FolderDividers | undefined, words: string) => void;
}) {
  const { folder } = props;
  const groupId = useId();
  const [replacing, setReplacing] = useState(false);
  const mode = dividerMode(folder.dividers);
  const ranges = folder.dividers?.ranges ?? [];
  const spans = resolvedRanges(folder.dividers);
  // The levels the folder was drawn with (0.9.0-dev.90), to go back to.
  // Worked out from its cabinet's levels as they are now, never kept from before.
  const arranged = props.arranged ?? [];
  const byArrangement = dividerMode({ levels: arranged, ranges: [] }) === 'levels';
  const asArranged =
    mode === 'levels' &&
    (folder.dividers?.levels ?? []).length === arranged.length &&
    arranged.every((l, i) => folder.dividers?.levels[i] === l);
  /** The folder's levels with no ranges: none of its own for plain years. */
  const withoutRanges = (): FolderDividers | undefined => {
    const levels = folder.dividers?.levels ?? ['year'];
    return dividerMode({ levels, ranges: [] }) === 'years' ? undefined : { levels, ranges: [] };
  };
  const set = (next: DividerRange[], words: string) =>
    props.onChange({ levels: folder.dividers?.levels ?? ['year'], ranges: next }, words);
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
      {(byArrangement
        ? (['levels', 'years', 'none', 'ranges'] as const)
        : (['years', 'none', 'ranges'] as const)
      ).map((m) => (
        <label key={m} className="divider-choice">
          <input
            type="radio"
            name={`${groupId}-mode`}
            checked={m === 'levels' ? asArranged : mode === m}
            onChange={() =>
              m === 'levels'
                ? props.onChange(
                    { levels: [...arranged], ranges: [] },
                    `Divided ${byLevelsWords(arranged)}.`,
                  )
                : m === 'years'
                  ? props.onChange(undefined, 'Divided by year.')
                  : m === 'none'
                    ? props.onChange({ levels: [], ranges: [] }, 'No dividers.')
                    : set(
                        ranges.length > 0 ? ranges : [{ name: '', from: null, to: null }],
                        'Your own dividers: name each, and when it starts and ends.',
                      )
            }
          />
          {m === 'levels'
            ? `As arranged: ${byLevelsWords(arranged)}`
            : m === 'years'
              ? 'By year, by themselves'
              : m === 'none'
                ? 'No dividers'
                : 'My own date ranges'}
        </label>
      ))}
      {mode === 'years' && asksOneYear(folder.filter) && (
        <p className="muted">
          This folder holds one year already, so its papers are one list, with no year divider.
        </p>
      )}
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
                        ? props.onChange(withoutRanges(), `${label} removed.`)
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
