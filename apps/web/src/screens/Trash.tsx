import { can, PURGE_NOTICE_HOURS, shortName, whenExactly, type DocumentView } from '@fdv/shared';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { Link } from 'react-router';
import { api } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { PICK_WIDTH } from '../documents-table.js';
import { storedRole } from '../session.js';
import { useShellMode } from '../shell.js';
import { None, OutcomeNote, PickAll, useGrid, type Outcome } from '../table-grid.js';
import { Button, ConfirmDialog, ErrorNote, TopBar, TrashIcon } from '../ui.js';

/**
 * What its filer — and anybody else looking at the Trash — is told of an
 * owner's request to remove a document for good (5.24). Whoever filed it is
 * told how to keep it: to bring it back, when they may; otherwise to ask
 * somebody who may (a filer made a viewer since, or a teen whose filing is
 * now somebody else's).
 */
export function purgeAskedWords(
  d: Pick<DocumentView, 'purge_requested_at' | 'filed_by_me'>,
  mayBringBack: boolean,
) {
  if (!d.purge_requested_at) return null;
  const asked = `An owner asked to remove this for good on ${whenExactly(d.purge_requested_at)}.`;
  if (!d.filed_by_me) return asked;
  return mayBringBack
    ? `${asked} Bring it back to keep it.`
    : `${asked} To keep it, ask an owner or another adult to bring it back.`;
}

/** Whether somebody may bring a document back out of the Trash: as the vault decides. */
export function mayBringBack(
  role: Parameters<typeof can>[0],
  memberId: string | undefined,
  d: Pick<DocumentView, 'owner_member_id'>,
): boolean {
  // Whoever may change documents; a teen only their own.
  return can(role, 'document.edit') && (role !== 'teen' || d.owner_member_id === memberId);
}

/** What an owner may do about removing one for good, now. */
type Removal = { kind: 'remove' } | { kind: 'ask' } | { kind: 'wait'; from: string };

/**
 * The Trash (5.1): what was moved there, most recent first, and the way
 * back. A document in the Trash is out of every list, search and reminder;
 * nothing in it is gone — until an owner removes it for good (5.24): one
 * they filed at once; anybody else's once whoever filed it has been told,
 * and has had a day to bring it back.
 */
export function TrashScreen() {
  const { withToken, guarded, authVersion, session } = useApp();
  const first = useLoad(
    (t) => api.documents(t, { deleted: 'true', sort: 'recent' }),
    [authVersion],
  );
  const [older, setOlder] = useState<DocumentView[]>([]);
  // Undefined until "Show older" is used; then the next page, or null at the end.
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [news, setNews] = useState<ReactNode>(null);
  // The one being removed for good, or asked about, in the app's own dialog.
  const [confirming, setConfirming] = useState<{ doc: DocumentView; removal: Removal } | null>(
    null,
  );
  const status = useRef<HTMLParagraphElement>(null);
  // Each row's "Remove for good" button, and the one that opened the dialog:
  // where focus goes back to when it closes (Safari focuses no button on a
  // click, so the browser remembers none).
  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  const opener = useRef<HTMLElement | null>(null);
  // What a "from {time}" is read against: now as the page opened, moved on
  // each minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const role = storedRole();
  const me = session.info?.member_id;
  // From 768 px a table, to choose many (R4); on a phone, today's rows.
  const wide = useShellMode() !== 'phone';
  const mayRestore = (d: DocumentView) => mayBringBack(role, me, d);
  // Owners only (5.24). What may go at once the vault says (purge_at_once:
  // one they filed, or theirs when its filer has gone); anybody else's is
  // asked about, and goes a day after.
  const removalOf = (d: DocumentView): Removal | null => {
    if (!can(role, 'document.purge')) return null;
    if (d.purge_at_once === true) return { kind: 'remove' };
    if (!d.purge_allowed_from) return { kind: 'ask' };
    return Date.parse(d.purge_allowed_from) <= now
      ? { kind: 'remove' }
      : { kind: 'wait', from: d.purge_allowed_from };
  };
  const items = [...(first.data?.items ?? []), ...older];
  const next =
    cursor === undefined ? (first.data?.has_more ? first.data.next_cursor : null) : cursor;

  const more = async (from: string) => {
    setLoadingMore(true);
    try {
      const page = await withToken((t) =>
        api.documents(t, { deleted: 'true', sort: 'recent', cursor: from }),
      );
      if (page) {
        setOlder((o) => [...o, ...page.items]);
        setCursor(page.has_more ? page.next_cursor : null);
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoadingMore(false);
    }
  };

  /** What is in the Trash has changed: from the first page again, and the news has focus. */
  const changed = async (said: ReactNode) => {
    setNews(said);
    setOlder([]);
    setCursor(undefined);
    await first.reload();
    // The button that had focus may be gone with its row: the news takes it.
    status.current?.focus();
  };

  const restore = async (doc: DocumentView) => {
    setBusy(doc.id);
    setError(null);
    try {
      await withToken((t) => api.restoreDocument(t, doc.id));
      await changed(
        <>
          <Link to={`/documents/${doc.id}`}>“{doc.title ?? 'Needs a name'}”</Link> is back.
        </>,
      );
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  const purge = async () => {
    if (!confirming) return;
    const { doc } = confirming;
    const title = doc.title ?? 'Needs a name';
    setBusy(doc.id);
    setError(null);
    try {
      // It asks to confirm it's you, every time: the prompt opens over the
      // dialog, and the removal goes on once it is answered.
      const out = await guarded((t) => api.purgeDocument(t, doc.id));
      setConfirming(null);
      if (!out) return;
      if (out.removed) {
        await changed(`“${title}” was removed for good.`);
      } else {
        const from = out.document.purge_allowed_from;
        await changed(
          `You asked to remove “${title}” for good. Whoever added it, if they still sign in here, ` +
            `and the other owners have been told${from ? `. You can remove it from ${whenExactly(from)}.` : '.'}`,
        );
      }
    } catch (err) {
      setConfirming(null);
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="page page-top page-wide has-nav">
      <TopBar title="Trash" />
      <ErrorNote message={error ?? first.error} />
      <p className="muted">
        Documents moved to the Trash. They are out of every list, search and reminder until somebody
        brings them back
        {can(role, 'document.purge') ? ', or an owner removes them for good.' : '.'}
      </p>
      <p role="status" ref={status} tabIndex={-1} className="status-line">
        {news}
      </p>
      {wide ? (
        <TrashTable
          items={items}
          loaded={first.data !== null && !first.error}
          failed={first.error !== null}
          removalOf={removalOf}
          mayRestore={mayRestore}
          busy={busy}
          onRestore={(d) => void restore(d)}
          onRemove={(d, removal, from) => {
            opener.current = from;
            setConfirming({ doc: d, removal });
          }}
          fallbackFocus={() => status.current?.focus()}
          onChanged={() => {
            setOlder([]);
            setCursor(undefined);
            return first.reload();
          }}
        />
      ) : (
        <ul className="list">
          {items.map((d) => {
            const removal = removalOf(d);
            const asked = purgeAskedWords(d, mayRestore(d));
            const title = d.title ?? 'this document';
            return (
              <li key={d.id} className="trash-row">
                <span className="stack" style={{ gap: 2 }}>
                  <span className="doc-title">{d.title ?? 'Needs a name'}</span>
                  {d.deleted_at && (
                    <span className="muted">Moved to the Trash {whenExactly(d.deleted_at)}</span>
                  )}
                  {asked && <span className="trash-asked">{asked}</span>}
                </span>
                <span className="trash-actions">
                  {mayRestore(d) && (
                    <Button
                      kind="quiet"
                      disabled={busy === d.id}
                      ariaLabel={`Bring it back: ${title}`}
                      onClick={() => void restore(d)}
                    >
                      {busy === d.id && !confirming ? 'Bringing it back…' : 'Bring it back'}
                    </Button>
                  )}
                  {removal?.kind === 'wait' && (
                    <Button
                      kind="quiet"
                      disabled
                      ariaLabel={`Remove for good from ${whenExactly(removal.from)}: ${title}`}
                    >
                      Remove for good from {whenExactly(removal.from)}
                    </Button>
                  )}
                  {removal && removal.kind !== 'wait' && (
                    <Button
                      kind="quiet"
                      danger
                      disabled={busy === d.id}
                      ariaLabel={`${removal.kind === 'ask' ? 'Ask to remove for good' : 'Remove for good'}: ${title}`}
                      ref={(el) => {
                        if (el) removeButtons.current.set(d.id, el);
                        else removeButtons.current.delete(d.id);
                      }}
                      onClick={() => {
                        opener.current = removeButtons.current.get(d.id) ?? null;
                        setConfirming({ doc: d, removal });
                      }}
                    >
                      {removal.kind === 'ask' ? 'Ask to remove for good' : 'Remove for good'}
                    </Button>
                  )}
                </span>
              </li>
            );
          })}
          {first.data !== null && !first.error && items.length === 0 && (
            <li className="muted">The Trash is empty.</li>
          )}
        </ul>
      )}
      {next && (
        <Button kind="quiet" disabled={loadingMore} onClick={() => void more(next)}>
          {loadingMore ? 'Loading…' : 'Show older'}
        </Button>
      )}
      {confirming && (
        <PurgeDialog
          doc={confirming.doc}
          ask={confirming.removal.kind === 'ask'}
          busy={busy === confirming.doc.id}
          returnFocus={opener}
          onConfirm={() => void purge()}
          onCancel={() => setConfirming(null)}
        />
      )}
    </main>
  );
}

/** The title's least width in the Trash's table, in px: below it the box scrolls sideways. */
const TITLE_LEAST = 180;

/** "1 document", "3 documents". */
const docs = (n: number) => `${n} document${n === 1 ? '' : 's'}`;

/**
 * The Trash from 768 px (R4): R2's grid — the table one stop for Tab, the
 * arrows between its cells — with a box to choose each, and what may be
 * done with all those chosen: bring them back, and for an owner remove them
 * for good, each only where every one of them allows it, by the rules each
 * row's own buttons follow. Each is done through the vault's call for one
 * document, one after another, and what could not be is named.
 */
function TrashTable(props: {
  items: DocumentView[];
  loaded: boolean;
  /** It could not be loaded: said, rather than Loading for ever (R5). */
  failed: boolean;
  removalOf: (d: DocumentView) => Removal | null;
  mayRestore: (d: DocumentView) => boolean;
  busy: string | null;
  onRestore: (d: DocumentView) => void;
  onRemove: (d: DocumentView, removal: Removal, from: HTMLElement) => void;
  onChanged: () => Promise<unknown>;
  /** With nothing left to choose from: the page's own line, never nowhere. */
  fallbackFocus: () => void;
}) {
  const { items, removalOf, mayRestore } = props;
  const { authVersion, withToken, guarded } = useApp();
  const role = storedRole();
  const owner = can(role, 'document.purge');
  // Whose each is, and what kind: the family and the kinds, as this reader is given them.
  const { data: members } = useLoad(async (t) => (await api.members(t)).items, [authVersion]);
  const { data: types } = useLoad(async (t) => (await api.documentTypes(t)).items, [authVersion]);
  const names = shortName(members ?? []);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const chosen = items.filter((d) => picked.has(d.id));
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [asking, setAsking] = useState(false);
  const [progress, setProgress] = useState<{ done: number; of: number } | null>(null);
  const table = useRef<HTMLTableElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const pickAllRef = useRef<HTMLInputElement>(null);
  const outcomeRef = useRef<HTMLDivElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  const grid = useGrid(table, wrap, [items.map((d) => d.id).join(','), String(owner)]);

  // Those gone from the Trash — brought back or removed — are not chosen:
  // what is chosen is always among the rows there are.
  const pick = (id: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };
  const allPicked = items.length > 0 && chosen.length === items.length;

  // What may be done with all of them: each only where every one allows it.
  const n = chosen.length;
  const removals = chosen.map(removalOf);
  const restoreAll = n > 0 && chosen.every(mayRestore);
  const removeAll = owner && n > 0 && removals.every((r) => r !== null && r.kind !== 'wait');
  const notes: string[] = [];
  if (n > 0 && !restoreAll) {
    const not = chosen.filter((d) => !mayRestore(d)).length;
    notes.push(
      `${not === n ? (n === 1 ? 'It isn’t' : 'None of these is') : `${not} of these ${not === 1 ? 'isn’t' : 'aren’t'}`} yours to bring back: Bring back is offered when every one you chose is.`,
    );
  }
  if (owner && n > 0 && !removeAll) {
    notes.push(
      'Remove for good is offered when every one you chose can be removed or asked about now.',
    );
  }
  const removeNow = chosen.filter((_, i) => removals[i]?.kind === 'remove');
  const askNow = chosen.filter((_, i) => removals[i]?.kind === 'ask');

  /** Where the focus goes when what had it goes: the header's box, else the table, else the page. */
  const backToTable = () => {
    if (pickAllRef.current && !pickAllRef.current.disabled) pickAllRef.current.focus();
    else if (!grid.focusActive()) props.fallbackFocus();
  };

  /** Each, one after another: what went through, what did not and why, what was never reached. */
  const each = async (list: DocumentView[], act: (d: DocumentView) => Promise<unknown>) => {
    const done: DocumentView[] = [];
    const answers: unknown[] = [];
    const failed: Outcome['failed'] = [];
    for (const [i, d] of list.entries()) {
      setProgress({ done: i, of: list.length });
      try {
        const r = await act(d);
        // No answer: confirming it's you was put away, or the sign-in ended.
        if (r === null) return { done, answers, failed, untouched: list.slice(i) };
        done.push(d);
        answers.push(r);
      } catch (err) {
        failed.push({ id: d.id, title: d.title ?? 'Needs a name', why: describeError(err) });
      }
    }
    return { done, answers, failed, untouched: [] as DocumentView[] };
  };

  const head = (failed: number, of: number, what: string) =>
    of === 1
      ? `It could not be ${what}:`
      : failed === of
        ? `None of the ${of} could be ${what}:`
        : `${failed} of the ${of} could not be ${what}:`;
  const left = (doneCount: number, untouched: number, what: string, why: string) => {
    if (untouched === 0) return null;
    return doneCount === 0
      ? `Nothing was ${what}: ${why}. ${docs(untouched)} ${untouched === 1 ? 'is' : 'are'} still chosen.`
      : `The other ${untouched} ${untouched === 1 ? 'was' : 'were'} not ${what}: ${why}, and ${untouched === 1 ? 'it is' : 'they are'} still chosen.`;
  };
  const joined = (...parts: Array<string | null>) => parts.filter(Boolean).join(' ') || null;

  /** What a run came to: said, and focus there; what failed or was never reached stays chosen. */
  const finish = async (o: Outcome) => {
    flushSync(() => {
      setProgress(null);
      setAsking(false);
      setOutcome(o);
      setPicked(new Set([...o.failed.map((f) => f.id), ...o.untouched]));
    });
    await props.onChanged();
    window.setTimeout(() => outcomeRef.current?.focus(), 0);
  };

  const restore = async () => {
    const list = chosen;
    const r = await each(list, (d) => withToken((t) => api.restoreDocument(t, d.id)));
    await finish({
      said: joined(
        r.done.length > 0
          ? `${docs(r.done.length)} brought back: ${r.done.length === 1 ? 'it is' : 'they are'} in every list again.`
          : null,
        left(r.done.length, r.untouched.length, 'brought back', 'your sign-in ended'),
      ),
      failedHead: head(r.failed.length, list.length, 'brought back'),
      failed: r.failed,
      untouched: r.untouched.map((d) => d.id),
    });
  };

  const remove = async () => {
    const list = [...removeNow, ...askNow];
    // It asks to confirm it's you (5.24): once, then the rest go on.
    const r = await each(list, (d) => guarded((t) => api.purgeDocument(t, d.id)));
    const removed = r.answers.filter((a) => (a as { removed?: boolean }).removed === true).length;
    const asked = r.done.length - removed;
    await finish({
      said: joined(
        removed > 0 ? `${docs(removed)} removed for good.` : null,
        asked > 0
          ? `You asked to remove ${docs(asked)} for good: whoever added each, if they still sign in here, and the other owners have been told.`
          : null,
        left(r.done.length, r.untouched.length, 'removed', 'you did not confirm it’s you'),
      ),
      failedHead: head(r.failed.length, list.length, 'removed for good'),
      failed: r.failed,
      untouched: r.untouched.map((d) => d.id),
    });
  };

  const busy = progress !== null;
  return (
    <>
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
      <div ref={wrap} className="tbl-wrap tbl-static trash-wrap">
        <table
          ref={table}
          className="tbl trash-tbl"
          role="grid"
          style={{ minWidth: (owner ? 836 : 676) + TITLE_LEAST }}
          onKeyDown={grid.onKeyDown}
          onFocus={grid.onFocus}
        >
          <caption className="visually-hidden">In the Trash, the most recent first</caption>
          <colgroup>
            <col style={{ width: PICK_WIDTH }} />
            <col />
            <col style={{ width: 100 }} />
            <col style={{ width: 96 }} />
            <col style={{ width: 140 }} />
            <col style={{ width: 170 }} />
            <col style={{ width: 126 }} />
            {owner && <col style={{ width: 160 }} />}
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className="col-pick">
                <PickAll
                  ref={pickAllRef}
                  count={items.length}
                  checked={allPicked}
                  mixed={chosen.length > 0 && !allPicked}
                  onChange={(on) => setPicked(on ? new Set(items.map((d) => d.id)) : new Set())}
                />
              </th>
              <th scope="col" className="col-title" style={{ left: PICK_WIDTH }}>
                Title
              </th>
              <th scope="col">Kind</th>
              <th scope="col">Person</th>
              <th scope="col">Moved to the Trash</th>
              <th scope="col">Removed for good</th>
              <th scope="col">
                <span className="visually-hidden">Bring it back</span>
              </th>
              {owner && (
                <th scope="col">
                  <span className="visually-hidden">Remove for good</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {items.map((d) => {
              const removal = removalOf(d);
              const title = d.title ?? 'Needs a name';
              const kind = types?.find((t) => t.key === d.type_key)?.label;
              const whose = d.owner_member_id ? names.get(d.owner_member_id) : undefined;
              const asked = purgeAskedWords(d, mayRestore(d));
              return (
                <tr key={d.id} data-id={d.id} className={picked.has(d.id) ? 'picked' : undefined}>
                  <td className="col-pick">
                    <label className="pick-cell">
                      <input
                        type="checkbox"
                        checked={picked.has(d.id)}
                        onChange={(e) => pick(d.id, e.target.checked)}
                      />
                      <span className="visually-hidden">Select “{title}”</span>
                    </label>
                  </td>
                  <td className="col-title" style={{ left: PICK_WIDTH }}>
                    <span className="cell-title trash-title">{title}</span>
                  </td>
                  <td>{kind ? <span className="clip">{kind}</span> : <None />}</td>
                  <td>{whose ? <span className="clip">{whose}</span> : <None />}</td>
                  <td>{d.deleted_at ? whenExactly(d.deleted_at) : <None />}</td>
                  <td>
                    {asked ? (
                      <span className="trash-asked">{asked}</span>
                    ) : (
                      <span className="muted">Not unless an owner removes it</span>
                    )}
                  </td>
                  <td>
                    {mayRestore(d) ? (
                      <button
                        type="button"
                        className="btn btn-quiet btn-small"
                        disabled={props.busy === d.id || busy}
                        aria-label={`Bring it back: ${title}`}
                        onClick={() => props.onRestore(d)}
                      >
                        {props.busy === d.id ? 'Bringing it back…' : 'Bring it back'}
                      </button>
                    ) : (
                      <None />
                    )}
                  </td>
                  {owner && (
                    <td>
                      {removal?.kind === 'wait' ? (
                        <span className="muted">From {whenExactly(removal.from)}</span>
                      ) : removal ? (
                        <button
                          type="button"
                          className="btn btn-quiet btn-small btn-danger-quiet"
                          disabled={props.busy === d.id || busy}
                          aria-label={`${removal.kind === 'ask' ? 'Ask to remove for good' : 'Remove for good'}: ${title}`}
                          onClick={(e) => props.onRemove(d, removal, e.currentTarget)}
                        >
                          {removal.kind === 'ask' ? 'Ask to remove' : 'Remove for good'}
                        </button>
                      ) : (
                        <None />
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
            {items.length === 0 && (
              <tr className="empty-row">
                <td colSpan={owner ? 8 : 7}>
                  {props.loaded
                    ? 'The Trash is empty.'
                    : props.failed
                      ? 'The Trash could not be loaded.'
                      : 'Loading the Trash…'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="visually-hidden" role="status">
        {n > 0 ? `${n} selected` : ''}
      </p>
      {n > 0 ? (
        <div className="bulkbar" role="region" aria-label="What to do with the chosen documents">
          <span className="bulk-count">{n} selected</span>
          {restoreAll && (
            <button
              type="button"
              className="btn btn-bulk"
              disabled={busy}
              onClick={() => void restore()}
            >
              {progress && !asking
                ? `Bringing back ${progress.done + 1} of ${progress.of}…`
                : 'Bring them back'}
            </button>
          )}
          {removeAll && (
            <button
              ref={removeButton}
              type="button"
              className="btn btn-bulk btn-bulk-danger"
              disabled={busy}
              onClick={() => setAsking(true)}
            >
              <TrashIcon />
              Remove for good
            </button>
          )}
          <span className="bulk-gap" />
          <button
            type="button"
            className="btn btn-bulk"
            disabled={busy}
            onClick={() => {
              flushSync(() => setPicked(new Set()));
              backToTable();
            }}
          >
            Clear selection
          </button>
          {notes.length > 0 && (
            <div className="bulk-notes">
              {notes.map((note) => (
                <p key={note}>{note}</p>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="tablefoot">
          <span>Tick documents to bring back many at once.</span>
        </div>
      )}
      {asking && (
        <ConfirmDialog
          title={
            askNow.length === 0
              ? `Remove ${docs(removeNow.length)} for good?`
              : removeNow.length === 0
                ? `Ask to remove ${docs(askNow.length)} for good?`
                : `Remove ${docs(removeNow.length)} for good, and ask about ${askNow.length} more?`
          }
          confirmLabel={
            askNow.length === 0
              ? 'Remove for good'
              : removeNow.length === 0
                ? 'Ask to remove for good'
                : 'Remove and ask'
          }
          busyLabel={progress ? `Removing ${progress.done + 1} of ${progress.of}…` : 'Removing…'}
          icon={<TrashIcon />}
          danger
          busy={busy}
          returnFocus={removeButton}
          onConfirm={() => void remove()}
          onCancel={() => setAsking(false)}
        >
          {removeNow.length > 0 && (
            <p>
              {removeNow.length === 1 ? 'It is' : `${removeNow.length} are`} removed from the vault:
              {removeNow.length === 1 ? ' its' : ' their'} files, pages, and any link to{' '}
              {removeNow.length === 1 ? 'it' : 'them'}. Nobody can bring{' '}
              {removeNow.length === 1 ? 'it' : 'them'} back. Copies made elsewhere are not reached:
              an export made before now, a phone keeping {removeNow.length === 1 ? 'it' : 'them'}{' '}
              offline, a backup.
            </p>
          )}
          {askNow.length > 0 && (
            <p>
              Somebody else added {askNow.length === 1 ? 'one' : askNow.length} of these. Whoever
              added each is told now, if they still sign in here, and so are the other owners.
              Bringing it back keeps it. If nobody does, you can remove{' '}
              {askNow.length === 1 ? 'it' : 'them'} for good {PURGE_NOTICE_HOURS} hours from now.
            </p>
          )}
          <p>You will be asked to confirm it’s you.</p>
        </ConfirmDialog>
      )}
    </>
  );
}

/**
 * The app's own "are you sure?" (5.1) for removing a document for good, or
 * for asking to (5.24): what goes and what does not, that it cannot be
 * brought back, and — for somebody else's — who is told and how long they
 * have.
 */
function PurgeDialog(props: {
  doc: DocumentView;
  ask: boolean;
  busy: boolean;
  returnFocus: RefObject<HTMLElement | null>;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const title = props.doc.title ?? 'This document';
  return props.ask ? (
    <ConfirmDialog
      title="Ask to remove for good?"
      confirmLabel="Ask to remove for good"
      busyLabel="Asking…"
      icon={<TrashIcon />}
      danger
      busy={props.busy}
      returnFocus={props.returnFocus}
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
    >
      <p>
        Somebody else added “{title}”. Whoever added it is told now, if they still sign in here, and
        so are the other owners. Bringing it back keeps it.
      </p>
      <p>
        If nobody does, you can remove it for good {PURGE_NOTICE_HOURS} hours from now. You will be
        asked to confirm it’s you.
      </p>
    </ConfirmDialog>
  ) : (
    <ConfirmDialog
      title="Remove for good?"
      confirmLabel="Remove for good"
      busyLabel="Removing…"
      icon={<TrashIcon />}
      danger
      busy={props.busy}
      returnFocus={props.returnFocus}
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
    >
      <p>
        “{title}” is removed from the vault: its file, its pages, and any link to it. Nobody can
        bring it back.
      </p>
      <p>
        Copies made elsewhere are not reached: an export made before now keeps its copy until it
        expires, within seven days, and a phone keeping it offline removes its copy when it next
        connects. A backup made before now can bring back its details, never its file.
      </p>
      <p>You will be asked to confirm it’s you.</p>
    </ConfirmDialog>
  );
}
