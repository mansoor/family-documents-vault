import { can, inListAudience, type ListItemView, type ListView, type Member } from '@fdv/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { api, ApiRequestError } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import {
  audienceLabel,
  audienceSentence,
  documentsWord,
  ListForm,
  type ListFields,
  listsOffered,
  mayChangeList,
  NEVER_WIDENS,
  VIEWERS_NEED_A_GRANT,
} from '../lists.js';
import { storedRole } from '../session.js';
import { BottomNav, Button, ConfirmDialog, ErrorNote, TopBar, TrashIcon } from '../ui.js';
import { DocRow } from './Home.js';

/**
 * Lists of documents (5.15): the Lists screen, and a list's own page.
 *
 * A list gathers documents for a purpose. It never widens who sees one:
 * whoever opens it is given the documents on it they could see already,
 * and every count here is the vault's count of those (`item_count`). A
 * list somebody may not see is not there at all, not even as a number.
 * Only its maker changes a list (A18), while they are in its audience.
 */

/** Said once a list has been made, changed or deleted: carried to the next screen. */
type Arrived = { notice?: string } | null;

/**
 * News carried here takes the focus as soon as the line that says it is on
 * the screen — a list's page draws it once the list has come — and leaves
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

// ------------------------------------------------------------------ the lists

export function ListsScreen() {
  const { withToken, authVersion, caps } = useApp();
  const navigate = useNavigate();
  const role = storedRole();
  const offered = listsOffered(caps, role);
  const { data, error } = useLoad(
    async (t) => {
      const [lists, members] = await Promise.all([
        api.lists(t),
        // Whose each list is, for those who make them. A viewer is not given the family.
        can(role, 'list.manage') ? api.members(t) : Promise.resolve({ items: [] as Member[] }),
      ]);
      return { lists: lists.items, members: members.items };
    },
    [authVersion],
  );
  const { notice, statusRef } = useArrivedNotice();
  const [making, setMaking] = useState(false);
  const makeButton = useRef<HTMLButtonElement>(null);

  const make = async (fields: ListFields) => {
    const made = await withToken((t) => api.createList(t, fields));
    if (!made) return;
    void navigate(`/lists/${made.id}`, {
      state: {
        notice: `“${made.name}” is made. Put documents on it with Add to a list, in the ⋯ beside any document.`,
      },
    });
  };

  return (
    <main className="page page-top has-nav">
      <TopBar title="Lists" back="/" />
      <p className="lede">
        A list gathers documents for a purpose: a trip, a mortgage, a move. {NEVER_WIDENS}
      </p>
      <p role="status" ref={statusRef} tabIndex={-1} className="notice status-line">
        {notice}
      </p>
      <ErrorNote message={error} />
      {offered &&
        (making ? (
          <ListForm
            id="new-list"
            withDescription
            submitLabel="Make the list"
            busyLabel="Making the list…"
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
            className="btn btn-primary"
            onClick={() => setMaking(true)}
          >
            Make a list
          </button>
        ))}
      <ul className="list" aria-label="Lists">
        {(data?.lists ?? []).map((l) => (
          <li key={l.id}>
            <Link to={`/lists/${l.id}`} className="rowbtn">
              <span className="doc-title">{l.name}</span>
              <span className="muted">
                {documentsWord(l.item_count)} · {audienceLabel(l.audience)}
                {whose(l, data?.members ?? [])}
              </span>
            </Link>
          </li>
        ))}
        {data !== null && data.lists.length === 0 && (
          <li className="muted">{offered ? 'No lists yet.' : VIEWERS_NEED_A_GRANT}</li>
        )}
      </ul>
      <BottomNav />
    </main>
  );
}

/** " · Yours", or who made it, when the reader is told who is in the family. */
function whose(list: ListView, members: Member[]): string {
  if (list.mine) return ' · Yours';
  const maker = members.find((m) => m.id === list.owner_member_id);
  return maker ? ` · Made by ${maker.display_name}` : '';
}

// ------------------------------------------------------------------ one list

export function ListScreen() {
  const { id } = useParams<{ id: string }>();
  const { withToken, authVersion } = useApp();
  const navigate = useNavigate();
  const role = storedRole();
  const first = useLoad(
    async (t) => {
      const [list, types, members] = await Promise.all([
        api.getList(t, id as string),
        api.documentTypes(t),
        can(role, 'list.manage') ? api.members(t) : Promise.resolve({ items: [] as Member[] }),
      ]);
      return { list, types: types.items, members: members.items };
    },
    [id, authVersion],
  );
  // Pages after the first, as "Show more" brings them; undefined until it is used.
  const [older, setOlder] = useState<ListItemView[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // The list is not there for the reader any more — deleted, or no longer
  // for them — since the page was drawn: then that is all the page says,
  // as it would have been had it been so when the page opened.
  const [gone, setGone] = useState<{ id: string | undefined; message: string } | null>(null);
  const { notice, setNotice, status, statusRef } = useArrivedNotice();
  const editButton = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);

  /** Whether `err` says the list is not there for the reader: then the page says only that. */
  const goneIf = (err: unknown): boolean => {
    if (!(err instanceof ApiRequestError && err.status === 404)) return false;
    setGone({ id, message: describeError(err) });
    return true;
  };

  /** From the first page again: what is on it, or the list itself, has changed. */
  const again = async () => {
    setOlder([]);
    setCursor(undefined);
    try {
      const list = await withToken((t) => api.getList(t, id as string));
      if (list) first.setData((d) => (d ? { ...d, list } : d));
    } catch (err) {
      if (!goneIf(err)) setProblem(describeError(err));
    }
  };

  const goneNow = gone !== null && gone.id === id ? gone.message : null;
  if (!first.data || goneNow) {
    return (
      <main className="page page-top has-nav">
        <TopBar title="List" back="/lists" />
        <ErrorNote message={goneNow ?? first.error} />
        <BottomNav />
      </main>
    );
  }

  const { list, types, members } = first.data;
  const items = [...list.items, ...older];
  const next = cursor === undefined ? (list.has_more ? list.next_cursor : null) : cursor;
  const mayChange = mayChangeList(role, list);
  const maker = members.find((m) => m.id === list.owner_member_id) ?? null;
  // Nobody may change it any more — its maker is outside its audience now,
  // or has no sign-in — so an owner who sees it may delete it (5.14).
  const stranded =
    !list.mine &&
    role === 'owner' &&
    (maker === null || maker.role === null || !inListAudience(maker.role, list.audience));
  const mayDelete = list.mine || stranded;

  const more = async (from: string) => {
    setLoadingMore(true);
    setProblem(null);
    try {
      const page = await withToken((t) => api.getList(t, list.id, { cursor: from }));
      if (page) {
        setOlder((o) => [...o, ...page.items]);
        setCursor(page.has_more ? page.next_cursor : null);
      }
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 422) {
        // The last one shown has gone since: from the top again.
        setNotice('This list changed while you were looking, so it has been loaded again.');
        await again();
      } else if (!goneIf(err)) {
        setProblem(describeError(err));
      }
    } finally {
      setLoadingMore(false);
    }
  };

  const save = async (fields: ListFields) => {
    try {
      const changed = await withToken((t) =>
        api.updateList(
          t,
          list.id,
          { name: fields.name, audience: fields.audience, description: fields.description ?? null },
          list.etag,
        ),
      );
      if (!changed) return;
      flushSync(() => {
        first.setData((d) => (d ? { ...d, list: changed } : d));
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
            'This list was changed somewhere else, so it has been loaded again. Try again if it still needs changing.',
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
      await withToken((t) => api.deleteList(t, list.id));
      void navigate('/lists', {
        replace: true,
        state: {
          notice: `The list “${list.name}” is deleted. Its documents are still in the vault.`,
        },
      });
    } catch (err) {
      setConfirmDelete(false);
      setProblem(describeError(err));
    } finally {
      setDeleting(false);
    }
  };

  const sentence = audienceSentence(list.audience);
  return (
    <main className="page page-top has-nav">
      <TopBar
        title={list.name}
        back="/lists"
        action={
          mayChange && !editing ? (
            <button
              ref={editButton}
              type="button"
              className="btn btn-quiet"
              style={{ minHeight: 40 }}
              aria-label={`Edit “${list.name}”`}
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
          ) : undefined
        }
      />
      {editing ? (
        <ListForm
          id="edit-list"
          initial={{ name: list.name, description: list.description, audience: list.audience }}
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
        <div className="stack list-about">
          {list.description && <p className="keep-lines">{list.description}</p>}
          <p className="muted">
            Who it is for: <strong>{audienceLabel(list.audience)}</strong>. {sentence}
          </p>
          <MakerNote
            mine={list.mine}
            mayChange={mayChange}
            stranded={stranded}
            maker={maker?.display_name ?? null}
          />
        </div>
      )}
      <p role="status" ref={statusRef} tabIndex={-1} className="notice status-line">
        {notice}
      </p>
      <ErrorNote message={problem ?? first.error} />
      <section aria-labelledby="list-items-h">
        <h2 id="list-items-h" className="section-h">
          On this list
        </h2>
        {/* What the list holds, as the vault counts it for this reader. Where
            focus goes when a row leaves the list with it (5.4). */}
        <p className="muted" tabIndex={-1} data-landing>
          {documentsWord(list.item_count)}
        </p>
        <ul className="list">
          {items.map((item) => (
            <DocRow
              key={item.document.id}
              doc={item.document}
              types={types}
              hint={item.hint}
              list={{ id: list.id, name: list.name, mayChange }}
              onOpen={() => void navigate(`/documents/${item.document.id}`)}
              onChanged={again}
            />
          ))}
          {items.length === 0 && (
            <li className="muted">
              Nothing on this list yet.
              {mayChange ? ' Use Add to a list, in the ⋯ beside any document.' : ''}
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
          Delete this list
        </button>
      )}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete this list?"
          confirmLabel="Delete the list"
          busyLabel="Deleting…"
          icon={<TrashIcon />}
          danger
          busy={deleting}
          returnFocus={deleteButton}
          onConfirm={() => void remove()}
          onCancel={() => setConfirmDelete(false)}
        >
          <p>
            “{list.name}” is gone for everybody who could see it. The documents on it stay in the
            vault, and on any other list.
          </p>
        </ConfirmDialog>
      )}
      <BottomNav />
    </main>
  );
}

/** Why the reader may not change this list, when they may not, in plain words. */
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
        This list is for people you are no longer one of. You can still delete it, but not change
        it.
      </p>
    );
  }
  if (props.stranded) {
    return (
      <p className="muted">
        Nobody can change this list any more: whoever made it is no longer one of the people it is
        for, or can no longer sign in. As an owner, you can delete it.
      </p>
    );
  }
  return (
    <p className="muted">
      {props.maker
        ? `Only ${props.maker}, who made this list, can change it.`
        : 'Only the person who made this list can change it.'}
    </p>
  );
}
