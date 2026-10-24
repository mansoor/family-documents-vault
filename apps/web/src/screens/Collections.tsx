import {
  can,
  inCollectionAudience,
  sharedOutsideWords,
  type CollectionView,
  type Member,
} from '@fdv/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { api, ApiRequestError } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import {
  audienceLabel,
  audienceSentence,
  CollectionForm,
  type CollectionFields,
  collectionsOffered,
  documentsWord,
  mayChangeCollection,
  NEVER_WIDENS,
  VIEWERS_NEED_A_GRANT,
} from '../collections.js';
import { storedRole } from '../session.js';
import { useShellMode } from '../shell.js';
import { OutcomeNote, type Outcome } from '../table-grid.js';
import { ConfirmDialog, ErrorNote, Sheet, TopBar, TrashIcon } from '../ui.js';
import { AddDocumentsPicker } from '../collection-add.js';
import { Toast, type ReviewToast } from '../batch-review.js';
import type { Removed } from '../DocActions.js';
import { CollectionDocuments } from './Documents.js';
import { collectionShareOffered, ShareCollectionPanel } from './ShareCollection.js';
import {
  checklistOffered,
  ChecklistSection,
  ChecklistSheet,
  type ChecklistDone,
} from '../checklist.js';
import type { CollectionChecklist } from '@fdv/shared';

/**
 * Collections of documents (5.15): the Collections screen, and a collection's own page.
 *
 * A collection gathers documents for a purpose. It never widens who sees one:
 * whoever opens it is given the documents in it they could see already,
 * and every count here is the vault's count of those (`item_count`). A
 * collection somebody may not see is not there at all, not even as a number.
 * Only its maker changes a collection (A18), while they are in its audience.
 */

/**
 * Said once a collection has been made, changed or deleted: carried to the
 * next screen. A collection made from a checklist (0.9.0, C1) carries the list too.
 */
type Arrived = { notice?: string; checklist?: string } | null;

/**
 * News carried here takes the focus as soon as the line that says it is on
 * the screen — a collection's page draws it once the collection has come — and leaves
 * the history entry, so a reload does not say it again.
 */
function useArrivedNotice() {
  const location = useLocation();
  const navigate = useNavigate();
  const [notice, setNotice] = useState<string | null>((location.state as Arrived)?.notice ?? null);
  const status = useRef<HTMLParagraphElement | null>(null);
  const unheard = useRef(notice !== null);
  const statusRef = useCallback((line: HTMLParagraphElement | null) => {
    status.current = line;
    if (line && unheard.current) {
      unheard.current = false;
      line.focus();
    }
  }, []);
  useEffect(() => {
    if (!(location.state as Arrived)?.notice) return;
    void navigate(location.pathname, { replace: true, state: null });
    // Only as the screen opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { notice, setNotice, status, statusRef };
}

// ------------------------------------------------------------------ the collections

export function CollectionsScreen() {
  const { withToken, authVersion, caps } = useApp();
  const navigate = useNavigate();
  const role = storedRole();
  const offered = collectionsOffered(caps, role);
  const { data, error } = useLoad(
    async (t) => {
      const [collections, members] = await Promise.all([
        api.collections(t),
        // Whose each collection is, for those who make them. A viewer is not given the family.
        can(role, 'collection.manage')
          ? api.members(t)
          : Promise.resolve({ items: [] as Member[] }),
      ]);
      return { collections: collections.items, members: members.items };
    },
    [authVersion],
  );
  const { notice, statusRef } = useArrivedNotice();
  // From 768 px a grid of cards (R4); on a phone, today's rows.
  const wide = useShellMode() !== 'phone';
  const [making, setMaking] = useState(false);
  const makeButton = useRef<HTMLButtonElement>(null);

  const make = async (fields: CollectionFields) => {
    const { checklist, ...asked } = fields;
    const made = await withToken((t) => api.createCollection(t, asked));
    if (!made) return;
    void navigate(`/collections/${made.id}`, {
      state: {
        notice: checklist?.trim()
          ? `“${made.name}” is made. Here is what your checklist found: nothing is added until you choose.`
          : `“${made.name}” is made. Put documents in it with Add documents, above, or Add to a collection in the ⋯ beside any document.`,
        ...(checklist?.trim() ? { checklist } : {}),
      },
    });
  };

  return (
    <main className="page page-top page-wide has-nav">
      <TopBar title="Collections" back="/" />
      <p className="lede">
        A collection gathers documents for a purpose: a trip, a mortgage, a move. {NEVER_WIDENS}
      </p>
      <p role="status" ref={statusRef} tabIndex={-1} className="notice status-line">
        {notice}
      </p>
      <ErrorNote message={error} />
      {offered &&
        (making ? (
          <CollectionForm
            id="new-collection"
            withDescription
            withChecklist={checklistOffered(caps, role)}
            submitLabel="Make the collection"
            busyLabel="Making the collection…"
            onSubmit={make}
            onCancel={() => {
              setMaking(false);
              requestAnimationFrame(() => makeButton.current?.focus());
            }}
          />
        ) : (
          <button
            ref={makeButton}
            type="button"
            className="btn btn-primary coll-make"
            onClick={() => setMaking(true)}
          >
            Make a collection
          </button>
        ))}
      {wide ? (
        // From 768 px a grid of cards (R4): each a link, as each row is.
        <ul className="coll-grid" aria-label="Collections">
          {(data?.collections ?? []).map((l) => (
            <li key={l.id}>
              <Link to={`/collections/${l.id}`} className="card coll-card">
                <span className="coll-name">{l.name}</span>
                <span className="muted">
                  {documentsWord(l.item_count)}
                  {whose(l, data?.members ?? [])}
                </span>
                <span className="coll-for">{audienceLabel(l.audience)}</span>
                {/* Whom its links go to, as the vault gives them to this reader (5.19). */}
                {l.shared_outside && (
                  <span className="coll-shared">{sharedWith(l.shared_outside.with)}</span>
                )}
              </Link>
            </li>
          ))}
          {data !== null && data.collections.length === 0 && (
            <li className="muted">{offered ? 'No collections yet.' : VIEWERS_NEED_A_GRANT}</li>
          )}
        </ul>
      ) : (
        <ul className="list" aria-label="Collections">
          {(data?.collections ?? []).map((l) => (
            <li key={l.id}>
              <Link to={`/collections/${l.id}`} className="rowbtn">
                <span className="doc-title">{l.name}</span>
                <span className="muted">
                  {documentsWord(l.item_count)} · {audienceLabel(l.audience)}
                  {whose(l, data?.members ?? [])}
                </span>
              </Link>
            </li>
          ))}
          {data !== null && data.collections.length === 0 && (
            <li className="muted">{offered ? 'No collections yet.' : VIEWERS_NEED_A_GRANT}</li>
          )}
        </ul>
      )}
    </main>
  );
}

/** "Shared with Jane Smith", "Shared outside the family": whom a collection's links are for. */
function sharedWith(names: string[]): string {
  const named = names.filter((n) => n.trim() !== '');
  if (named.length === 0) return 'Shared outside the family';
  if (named.length === 1) return `Shared with ${named[0]}`;
  return `Shared with ${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
}

/** " · Yours", or who made it, when the reader is told who is in the family. */
function whose(collection: CollectionView, members: Member[]): string {
  if (collection.mine) return ' · Yours';
  const maker = members.find((m) => m.id === collection.owner_member_id);
  return maker ? ` · Made by ${maker.display_name}` : '';
}

// ------------------------------------------------------------------ one collection

export function CollectionScreen() {
  const { id } = useParams<{ id: string }>();
  const { withToken, authVersion, caps } = useApp();
  const navigate = useNavigate();
  const role = storedRole();
  const first = useLoad(
    async (t) => {
      const [collection, types, members] = await Promise.all([
        // Its documents are its table's (0.9.0): of the page, only the collection.
        api.getCollection(t, id as string, { limit: 1 }),
        api.documentTypes(t),
        can(role, 'collection.manage')
          ? api.members(t)
          : Promise.resolve({ items: [] as Member[] }),
      ]);
      return { collection, types: types.items, members: members.items };
    },
    [id, authVersion],
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Sharing it outside the family (5.19), in a sheet over the page.
  const [sharing, setSharing] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const shareButton = useRef<HTMLButtonElement>(null);
  // The collection is not there for the reader any more — deleted, or no longer
  // for them — since the page was drawn: then that is all the page says,
  // as it would have been had it been so when the page opened.
  const [gone, setGone] = useState<{ id: string | undefined; message: string } | null>(null);
  const { notice, setNotice, status, statusRef } = useArrivedNotice();
  const editButton = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  // Add documents (Phase 6): the picker, and what it came to.
  const [picking, setPicking] = useState(false);
  const [added, setAdded] = useState<Outcome | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const addedRef = useRef<HTMLDivElement>(null);
  // What is in it changed here (Add documents, a checklist, Undo): its table
  // is loaded again (0.9.0).
  const [refresh, setRefresh] = useState(0);
  // Taken out (0.9.0): said in a toast with Undo, which puts them back.
  const [toast, setToast] = useState<ReviewToast | null>(null);
  const [heard, setHeard] = useState('');
  const toastBox = useRef<HTMLDivElement>(null);
  const removedTitles = useRef<string[]>([]);
  // Its checklist (0.9.0, C1): matched again as the page opens, and the
  // sheet that fills it — opened at once with a list typed as it was made.
  const location = useLocation();
  const offered = checklistOffered(caps, role);
  // Read once, then gone: kept here while its sheet is open, and out of the
  // browser's history, which useArrivedNotice empties with the notice that
  // always comes with it, so the pasted list is not kept there (the C1 review).
  const [arrivedList, setArrivedList] = useState<string | null>(
    () => (location.state as Arrived)?.checklist ?? null,
  );
  const kept = useLoad(
    async (t): Promise<CollectionChecklist | null> =>
      offered ? api.collectionChecklist(t, id as string) : null,
    [id, authVersion, offered],
  );
  const [filling, setFilling] = useState<boolean>(arrivedList !== null);
  const fillButton = useRef<HTMLButtonElement>(null);

  /**
   * Whether `err` says the collection is not there for the reader: then the
   * page says only that.
   */
  const goneIf = (err: unknown): boolean => {
    if (!(err instanceof ApiRequestError && err.status === 404)) return false;
    setGone({ id, message: describeError(err) });
    return true;
  };

  /** The collection again: what is in it, or the collection itself, has changed. */
  const again = async () => {
    // What went wrong before is said again only if it goes wrong again.
    setProblem(null);
    try {
      const collection = await withToken((t) => api.getCollection(t, id as string, { limit: 1 }));
      if (collection) first.setData((d) => (d ? { ...d, collection } : d));
    } catch (err) {
      if (!goneIf(err)) setProblem(describeError(err));
    }
  };

  const goneNow = gone !== null && gone.id === id ? gone.message : null;
  if (!first.data || goneNow) {
    return (
      <main className="page page-top page-wide has-nav">
        <TopBar title="Collection" back="/collections" />
        <ErrorNote message={goneNow ?? first.error} />
      </main>
    );
  }

  const { collection, types, members } = first.data;
  const mayChange = mayChangeCollection(role, collection);
  const maker = members.find((m) => m.id === collection.owner_member_id) ?? null;
  // Nobody may change it any more — its maker is outside its audience now,
  // or has no sign-in — so an owner who sees it may delete it (5.14).
  const stranded =
    !collection.mine &&
    role === 'owner' &&
    (maker === null ||
      maker.role === null ||
      !inCollectionAudience(maker.role, collection.audience));
  const mayDelete = collection.mine || stranded;
  // Whoever may put documents in it from a row's ⋯ (Add to a collection):
  // collections offered to them, and this one theirs to change (A18).
  const mayAdd = mayChange && collectionsOffered(caps, role);

  /** Filled from the checklist: the sheet goes, what it did is said, and all is loaded again. */
  const onFilled = (done: ChecklistDone) => {
    flushSync(() => {
      setFilling(false);
      setAdded({ said: done.said, failedHead: null, failed: [], untouched: [] });
    });
    window.setTimeout(() => addedRef.current?.focus(), 0);
    setRefresh((n) => n + 1);
    void again();
    void kept.reload();
  };

  /** In: the picker goes, what it came to is said and has the focus, and the list is loaded again. */
  const onAdded = (said: string) => {
    flushSync(() => {
      setPicking(false);
      setAdded({ said, failedHead: null, failed: [], untouched: [] });
    });
    // The picker gives the focus back as it closes; then it comes here.
    window.setTimeout(() => addedRef.current?.focus(), 0);
    setRefresh((n) => n + 1);
    void again();
    void kept.reload();
  };

  /**
   * Taken out (0.9.0), from a row's ⋯ or the bar for the chosen: said in a
   * toast, with Undo, which puts them back by the vault's own Add. The
   * documents themselves are untouched. From the bar — gone with them — the
   * focus comes to the toast; from a ⋯ it stays on the next row.
   */
  const onRemoved = (removed: Removed[], from: 'row' | 'bar') => {
    const one = removed.length === 1 ? removed[0] : undefined;
    const text = one
      ? `“${one.title}” is out of “${collection.name}”. It is still in the vault.`
      : `${documentsWord(removed.length)} taken out of “${collection.name}”. They are still in the vault.`;
    removedTitles.current = removed.map((r) => r.title);
    setToast({
      text,
      more: [],
      // Undo's documents: the collection's, put back as they went (not a batch's).
      undo: { batchId: collection.id, itemIds: removed.map((r) => r.id), until: null },
      busy: false,
    });
    setHeard(text);
    void again();
    void kept.reload();
    if (from === 'bar') window.setTimeout(() => toastBox.current?.focus(), 0);
  };

  /** Undo: back in, by the vault's own Add (its rules, its log), as Add documents puts them. */
  const undo = async () => {
    const was = toast;
    if (!was?.undo) return;
    const { itemIds } = was.undo;
    setToast({ ...was, busy: true });
    try {
      const back = await withToken((t) => api.addToCollection(t, collection.id, itemIds));
      if (!back) {
        setToast({ ...was, busy: false });
        return;
      }
      const titles = removedTitles.current;
      const text =
        itemIds.length === 1
          ? `“${titles[0] ?? 'It'}” is back in “${collection.name}”.`
          : `${documentsWord(itemIds.length)} are back in “${collection.name}”.`;
      setToast({ text, more: back.warnings ?? [], undo: null, busy: false });
      setHeard(text);
      setRefresh((n) => n + 1);
      void again();
      void kept.reload();
    } catch (err) {
      // Nothing put back (all of them, or none): Undo is still there to try
      // again. A 404 is a document gone meanwhile, or the collection: which,
      // the collection loaded again says.
      setToast({ ...was, more: [describeError(err)], busy: false });
      setHeard(describeError(err));
      void again();
    }
  };

  const dismissToast = () => {
    flushSync(() => setToast(null));
    // Back to the documents, never nowhere.
    const h = document.getElementById('collection-items-h');
    if (h && !h.hasAttribute('tabindex')) h.tabIndex = -1;
    h?.focus();
  };

  const save = async (fields: CollectionFields) => {
    try {
      const changed = await withToken((t) =>
        api.updateCollection(
          t,
          collection.id,
          { name: fields.name, audience: fields.audience, description: fields.description ?? null },
          collection.etag,
        ),
      );
      if (!changed) return;
      flushSync(() => {
        first.setData((d) => (d ? { ...d, collection: changed } : d));
        setEditing(false);
        setNotice(`“${changed.name}” is saved.`);
      });
      // Who it is for may have changed what its maker is told of each.
      setRefresh((n) => n + 1);
      status.current?.focus();
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409) {
        // Changed somewhere else since it was loaded: loaded again, so the
        // next try is made on what is there now.
        flushSync(() => {
          setEditing(false);
          setNotice(
            'This collection was changed somewhere else, so it has been loaded again. Try again if it still needs changing.',
          );
        });
        status.current?.focus();
        await again();
        return;
      }
      throw err;
    }
  };

  const remove = async () => {
    setDeleting(true);
    try {
      await withToken((t) => api.deleteCollection(t, collection.id));
      void navigate('/collections', {
        replace: true,
        state: {
          notice: `The collection “${collection.name}” is deleted. Its documents are still in the vault.`,
        },
      });
    } catch (err) {
      setConfirmDelete(false);
      setProblem(describeError(err));
    } finally {
      setDeleting(false);
    }
  };

  const sentence = audienceSentence(collection.audience);
  return (
    <main className={`page page-top page-wide has-nav${toast ? ' has-toast' : ''}`}>
      <TopBar
        title={collection.name}
        back="/collections"
        action={
          mayChange && !editing ? (
            <button
              ref={editButton}
              type="button"
              className="btn btn-quiet"
              style={{ minHeight: 40 }}
              aria-label={`Edit “${collection.name}”`}
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
          ) : undefined
        }
      />
      {editing ? (
        <CollectionForm
          id="edit-collection"
          initial={{
            name: collection.name,
            description: collection.description,
            audience: collection.audience,
          }}
          withDescription
          submitLabel="Save"
          busyLabel="Saving…"
          onSubmit={save}
          onCancel={() => {
            setEditing(false);
            requestAnimationFrame(() => editButton.current?.focus());
          }}
        />
      ) : (
        <div className="stack collection-about">
          {collection.description && <p className="keep-lines">{collection.description}</p>}
          <p className="muted">
            Who it is for: <strong>{audienceLabel(collection.audience)}</strong>. {sentence}
          </p>
          <MakerNote
            mine={collection.mine}
            mayChange={mayChange}
            stranded={stranded}
            maker={maker?.display_name ?? null}
          />
          {collection.shared_outside && (
            <p className="status status-warn">
              {sharedOutsideWords(collection.shared_outside, role)}
            </p>
          )}
          {(mayAdd || collectionShareOffered(caps, role, collection)) && (
            <div className="row">
              {mayAdd && (
                <button
                  ref={addButton}
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    setAdded(null);
                    setPicking(true);
                  }}
                >
                  Add documents
                </button>
              )}
              {collectionShareOffered(caps, role, collection) && (
                <button
                  ref={shareButton}
                  type="button"
                  className="btn btn-quiet"
                  onClick={() => setSharing(true)}
                >
                  Share this collection
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {sharing && (
        <Sheet
          label={`Share “${collection.name}”`}
          busy={shareBusy}
          returnFocus={shareButton}
          onClose={() => setSharing(false)}
        >
          <ShareCollectionPanel
            collection={collection}
            onBusy={setShareBusy}
            onShared={() => void again()}
            onClose={() => setSharing(false)}
          />
        </Sheet>
      )}
      {filling && mayAdd && offered && (
        <ChecklistSheet
          collection={collection}
          types={types}
          members={members}
          role={role}
          kept={kept.data}
          text={arrivedList}
          returnFocus={fillButton}
          onClose={() => {
            setArrivedList(null);
            setFilling(false);
          }}
          onDone={(done) => {
            setArrivedList(null);
            onFilled(done);
          }}
        />
      )}
      {picking && mayAdd && (
        <AddDocumentsPicker
          collection={collection}
          role={role}
          types={types}
          members={members}
          returnFocus={addButton}
          onClose={() => setPicking(false)}
          onAdded={onAdded}
          onGone={goneIf}
        />
      )}
      <p role="status" ref={statusRef} tabIndex={-1} className="notice status-line">
        {notice}
      </p>
      {added && (
        <OutcomeNote
          ref={addedRef}
          outcome={added}
          onDismiss={() => {
            flushSync(() => setAdded(null));
            addButton.current?.focus();
          }}
        />
      )}
      <ErrorNote message={problem ?? first.error} />
      {offered && (
        <ChecklistSection
          collection={collection}
          checklist={kept.data}
          error={kept.error}
          mayFill={mayAdd}
          ref={fillButton}
          onFill={() => {
            setAdded(null);
            setFilling(true);
          }}
        />
      )}
      {/* What is in it, as the Documents table shows documents (0.9.0): what
          the vault gives this reader of it, counted as it counts them. */}
      <CollectionDocuments
        refresh={refresh}
        scope={{
          collection: {
            id: collection.id,
            name: collection.name,
            audience: collection.audience,
            mine: collection.mine,
          },
          mayRemove: mayChange,
          empty: `Nothing in this collection yet.${
            mayAdd
              ? ' Use Add documents, above, or Add to a collection in the ⋯ beside any document.'
              : ''
          }`,
          onRemoved,
          onChanged: () => {
            void again();
            void kept.reload();
          },
        }}
      />
      {mayDelete && (
        <button
          ref={deleteButton}
          type="button"
          className="btn btn-link btn-trash"
          onClick={() => setConfirmDelete(true)}
        >
          <TrashIcon />
          Delete this collection
        </button>
      )}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete this collection?"
          confirmLabel="Delete the collection"
          busyLabel="Deleting…"
          icon={<TrashIcon />}
          danger
          busy={deleting}
          returnFocus={deleteButton}
          onConfirm={() => void remove()}
          onCancel={() => setConfirmDelete(false)}
        >
          <p>
            “{collection.name}” is gone for everybody who could see it. The documents in it stay in
            the vault, and in any other collection.
          </p>
        </ConfirmDialog>
      )}
      {toast && (
        <Toast toast={toast} box={toastBox} onUndo={() => void undo()} onDismiss={dismissToast} />
      )}
      {/* The toast said politely, the focus staying where it is (WCAG 4.1.3). */}
      <p className="visually-hidden" role="status" aria-live="polite">
        {heard}
      </p>
    </main>
  );
}

/** Why the reader may not change this collection, when they may not, in plain words. */
function MakerNote(props: {
  mine: boolean;
  mayChange: boolean;
  stranded: boolean;
  maker: string | null;
}) {
  if (props.mayChange) return null;
  if (props.mine) {
    return (
      <p className="muted">
        This collection is for people you are no longer one of. You can still delete it, but not
        change it.
      </p>
    );
  }
  if (props.stranded) {
    return (
      <p className="muted">
        Nobody can change this collection any more: whoever made it is no longer one of the people
        it is for, or can no longer sign in. As an owner, you can delete it.
      </p>
    );
  }
  return (
    <p className="muted">
      {props.maker
        ? `Only ${props.maker}, who made this collection, can change it.`
        : 'Only the person who made this collection can change it.'}
    </p>
  );
}
