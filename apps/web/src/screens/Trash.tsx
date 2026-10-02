import { can, PURGE_NOTICE_HOURS, whenExactly, type DocumentView } from '@fdv/shared';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link } from 'react-router';
import { api } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { storedRole } from '../session.js';
import { BottomNav, Button, ConfirmDialog, ErrorNote, TopBar, TrashIcon } from '../ui.js';

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
    <main className="page page-top has-nav">
      <TopBar title="Trash" back="/settings" />
      <ErrorNote message={error ?? first.error} />
      <p className="muted">
        Documents moved to the Trash. They are out of every list, search and reminder until somebody
        brings them back
        {can(role, 'document.purge') ? ', or an owner removes them for good.' : '.'}
      </p>
      <p role="status" ref={status} tabIndex={-1} className="status-line">
        {news}
      </p>
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
      <BottomNav />
    </main>
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
