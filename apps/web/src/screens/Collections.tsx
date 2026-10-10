import {
  can,
  inCollectionAudience,
  sharedOutsideWords,
  type CollectionItemView,
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
import { Button, ConfirmDialog, ErrorNote, Sheet, TopBar, TrashIcon } from '../ui.js';
import { DocRow } from './Home.js';
import { useTrashedNote } from '../DocActions.js';
import { collectionShareOffered, ShareCollectionPanel } from './ShareCollection.js';

/**
 * Collections of documents (5.15): the Collections screen, and a collection's own page.
 *
 * A collection gathers documents for a purpose. It never widens who sees one:
 * whoever opens it is given the documents in it they could see already,
 * and every count here is the vault's count of those (`item_count`). A
 * collection somebody may not see is not there at all, not even as a number.
 * Only its maker changes a collection (A18), while they are in its audience.
 */

/** Said once a collection has been made, changed or deleted: carried to the next screen. */
type Arrived = { notice?: string } | null;

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
    const made = await withToken((t) => api.createCollection(t, fields));
    if (!made) return;
    void navigate(`/collections/${made.id}`, {
      state: {
        notice: `“${made.name}” is made. Put documents in it with Add to a collection, in the ⋯ beside any document.`,
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
  const trashed = useTrashedNote();
  const role = storedRole();
  const first = useLoad(
    async (t) => {
      const [collection, types, members] = await Promise.all([
        api.getCollection(t, id as string),
        api.documentTypes(t),
        can(role, 'collection.manage')
          ? api.members(t)
          : Promise.resolve({ items: [] as Member[] }),
      ]);
      return { collection, types: types.items, members: members.items };
    },
    [id, authVersion],
  );
  // Pages after the first, as "Show more" brings them; undefined until it is used.
  const [older, setOlder] = useState<CollectionItemView[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
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

  /**
   * Whether `err` says the collection is not there for the reader: then the
   * page says only that.
   */
  const goneIf = (err: unknown): boolean => {
    if (!(err instanceof ApiRequestError && err.status === 404)) return false;
    setGone({ id, message: describeError(err) });
    return true;
  };

  /** From the first page again: what is in it, or the collection itself, has changed. */
  const again = async () => {
    setOlder([]);
    setCursor(undefined);
    // What went wrong before is said again only if it goes wrong again.
    setProblem(null);
    try {
      const collection = await withToken((t) => api.getCollection(t, id as string));
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
  const items = [...collection.items, ...older];
  const next =
    cursor === undefined ? (collection.has_more ? collection.next_cursor : null) : cursor;
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

  const more = async (from: string) => {
    setLoadingMore(true);
    setProblem(null);
    try {
      const page = await withToken((t) => api.getCollection(t, collection.id, { cursor: from }));
      if (page) {
        setOlder((o) => [...o, ...page.items]);
        setCursor(page.has_more ? page.next_cursor : null);
      }
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 422) {
        // The last one shown has gone since: from the top again.
        setNotice('This collection changed while you were looking, so it has been loaded again.');
        await again();
      } else if (!goneIf(err)) {
        setProblem(describeError(err));
      }
    } finally {
      setLoadingMore(false);
    }
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
        setOlder([]);
        setCursor(undefined);
        setEditing(false);
        setNotice(`“${changed.name}” is saved.`);
      });
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
    <main className="page page-top page-wide has-nav">
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
          {collectionShareOffered(caps, role, collection) && (
            <div className="row">
              <button
                ref={shareButton}
                type="button"
                className="btn btn-quiet"
                onClick={() => setSharing(true)}
              >
                Share this collection
              </button>
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
      <p role="status" ref={statusRef} tabIndex={-1} className="notice status-line">
        {notice}
      </p>
      <ErrorNote message={problem ?? first.error} />
      <section aria-labelledby="collection-items-h">
        <h2 id="collection-items-h" className="section-h">
          In this collection
        </h2>
        {/* What the collection holds, as the vault counts it for this reader. Where
            focus goes when a row leaves the collection with it (5.4). */}
        <p className="muted" tabIndex={-1} data-landing>
          {documentsWord(collection.item_count)}
        </p>
        {trashed.note}
        <ul className="list">
          {items.map((item) => (
            <DocRow
              key={item.document.id}
              doc={item.document}
              types={types}
              hint={item.hint}
              collection={{ id: collection.id, name: collection.name, mayChange }}
              onOpen={() => void navigate(`/documents/${item.document.id}`)}
              onChanged={again}
              onTrashed={trashed.onTrashed}
            />
          ))}
          {items.length === 0 && (
            <li className="muted">
              Nothing in this collection yet.
              {mayChange ? ' Use Add to a collection, in the ⋯ beside any document.' : ''}
            </li>
          )}
        </ul>
        {next && (
          <Button kind="quiet" disabled={loadingMore} onClick={() => void more(next)}>
            {loadingMore ? 'Loading…' : 'Show more'}
          </Button>
        )}
      </section>
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
