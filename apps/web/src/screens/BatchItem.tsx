import {
  autoTitle,
  batchVisibility,
  can,
  formatDate,
  LEVEL_WORDS,
  untouchedAccept,
  type BatchDetail,
  type BatchItemView,
  type CollectionView,
  type DocumentTypeView,
} from '@fdv/shared';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, ApiRequestError } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { askPage, forgetPages, heldPage, pageKey } from '../batch-pages.js';
import { newRun, runSummary, type ReviewRun } from '../batch-review.js';
import { useUploads } from '../batch-store.js';
import { storedRole } from '../session.js';
import { useShortcutsOn } from '../shortcuts.js';
import { ConfirmDialog, ErrorNote, TopBar } from '../ui.js';
import { captureDetails, ConfirmForm } from './AddConfirm.js';
import {
  addable,
  batchLabel,
  dupWords,
  inQueue,
  ItemTags,
  LevelBadge,
  OnlyYou,
  queueFilter,
} from './Batches.js';
import { sizeWords } from './Incoming.js';

/**
 * One file of a batch, in two panes (Phase 6, I3): the card on the left —
 * what the pages say merged with what the batch chose, each suggested
 * detail marked until it is changed — and its pages on the right, turned
 * with the buttons or Page Up and Page Down. On a phone, the details first
 * and the pages after them (the owner's rule).
 *
 * **Accept and next** (Enter, from any field where Enter means nothing
 * else) files it and opens the next file still waiting in the queue's
 * order, as the queue was filtered; **Skip** moves on without deciding;
 * **Not a document, remove it** asks first. After the last, back to the
 * queue: "All 20 done: 17 accepted, 3 removed". Each new file puts the
 * focus on its first field, and says politely where it is: "Item 4 of 20,
 * Check: Person unsure". An accept the vault refuses keeps the file and
 * says why on the card.
 */
export function BatchItemScreen() {
  const { id, itemId } = useParams<{ id: string; itemId: string }>();
  const { withToken, caps } = useApp();
  const [, uploads] = useUploads();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const level = queueFilter(params.get('level'));
  const role = storedRole();
  const removeButton = useRef<HTMLButtonElement>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Loaded once a batch: moving from file to file keeps what is on the screen.
  const { data, error, setData } = useLoad(
    async (t) => {
      const [batch, types, members, collections] = await Promise.all([
        api.batch(t, id as string),
        api.documentTypes(t),
        api.members(t),
        caps?.features.collections && can(role, 'collection.manage')
          ? api.collections(t).then((r) => r.items)
          : Promise.resolve([] as CollectionView[]),
      ]);
      return { batch, types: types.items, members: members.items, collections };
    },
    [id],
  );

  const batch = data?.batch ?? null;
  const item = batch?.items.find((i) => i.id === itemId && i.state === 'waiting') ?? null;
  // The go through the queue this belongs to; begun here when opened by its address.
  const carried = (location.state as { run?: ReviewRun } | null)?.run;
  const run: ReviewRun =
    carried && carried.order.includes(itemId ?? '')
      ? carried
      : newRun(
          (batch?.items ?? [])
            .filter((i) => i.state === 'waiting' && inQueue(level)(i))
            .map((i) => i.id),
          level,
        );
  const at = run.order.indexOf(itemId ?? '');
  const position = at >= 0 ? at + 1 : null;

  // Each new file: the focus on its first field, and where it is, said
  // politely (the status below changes with the file, and only then).
  const shownId = item?.id ?? null;
  useEffect(() => {
    if (shownId) document.getElementById('f-type')?.focus();
  }, [shownId]);
  const heard = item
    ? `${position ? `Item ${position} of ${run.order.length}` : item.name}, ${
        item.level ? LEVEL_WORDS[item.level] : 'Not read yet'
      }${(() => {
        const why = (item.tags ?? [])
          .filter((t) => t.kind !== 'info')
          .map((t) => t.words)
          .join(', ');
        return why ? `: ${why}` : '';
      })()}`
    : '';

  const queuePath = `/inbox/batches/${id ?? ''}${level ? `?level=${level}` : ''}`;

  /** On to the next file still waiting, in the queue's order — or back to the queue, said. */
  const onward = (now: BatchDetail, next: ReviewRun) => {
    const waiting = new Set(now.items.filter((i) => i.state === 'waiting').map((i) => i.id));
    const from = next.order.indexOf(itemId ?? '');
    const after = [...next.order.slice(from + 1), ...next.order.slice(0, Math.max(from, 0))];
    const to = after.find((x) => x !== itemId && waiting.has(x) && !next.skipped.includes(x));
    if (to) {
      void navigate(
        {
          pathname: `/inbox/batches/${now.id}/items/${to}`,
          search: level ? `?level=${level}` : '',
        },
        { replace: true, state: { run: next } },
      );
    } else {
      void navigate(queuePath, {
        state: { said: [next.last, runSummary(next)].filter(Boolean).join(' ') },
      });
    }
  };

  /** The batch as it is now, after a decision: drawn here, and what onward goes by. */
  const fresh = async (): Promise<BatchDetail | null> => {
    const now = await withToken((t) => api.batch(t, id as string));
    if (now && data) setData({ ...data, batch: now });
    return now;
  };

  const accept = async (
    b: BatchDetail,
    it: BatchItemView,
    details: Parameters<typeof captureDetails>[0],
    extra?: { collection_id: string | null },
  ) => {
    const sent = await withToken((t) =>
      api.acceptBatchItem(t, b.id, it.id, {
        ...captureDetails(details),
        ...(details.tags !== undefined ? { tags: details.tags } : {}),
        ...(details.is_essential !== undefined ? { is_essential: details.is_essential } : {}),
        collection_id: extra?.collection_id ?? null,
      }),
    );
    if (!sent) return;
    forgetPages([it.id]);
    uploads.changed();
    const now = (await fresh().catch(() => null)) ?? b;
    // What it became, and who else will now see it, as the collection says (5.33).
    const title = details.title ? `: ${details.title}` : '';
    const also = (sent.warnings ?? []).join(' ');
    onward(now, {
      ...run,
      accepted: run.accepted + 1,
      last: `“${it.name}” is a document now${title}.${also ? ` ${also}` : ''}`,
    });
  };

  const skip = () => {
    if (!batch || !item) return;
    onward(batch, { ...run, skipped: [...run.skipped, item.id], last: `Skipped “${item.name}”.` });
  };

  const remove = async () => {
    if (!batch || !item) return;
    setBusy(true);
    setProblem(null);
    try {
      await withToken((t) => api.removeBatchItem(t, batch.id, item.id));
      forgetPages([item.id]);
      uploads.changed();
      setAsking(false);
      const now = (await fresh().catch(() => null)) ?? batch;
      onward(now, {
        ...run,
        removed: run.removed + 1,
        last: `“${item.name}” was removed: its file and its pages are gone from the vault.`,
      });
    } catch (err) {
      setAsking(false);
      setProblem(
        err instanceof ApiRequestError && err.code === 'already_decided'
          ? 'This file was accepted or removed already.'
          : describeError(err),
      );
    } finally {
      setBusy(false);
    }
  };

  if (error || !data || !batch) {
    return (
      <main className="page page-top">
        <TopBar title="A file to check" back={queuePath} />
        {error ? <ErrorNote message={error} /> : <p className="muted">Loading…</p>}
      </main>
    );
  }
  const { types, members } = data;
  if (!item) {
    return (
      <main className="page page-top">
        <TopBar title="A file to check" back={queuePath} />
        <p className="muted">
          This file is not waiting any more: it was accepted or removed.{' '}
          <Link to={queuePath}>Back to the batch</Link>.
        </p>
      </main>
    );
  }

  const d = batch.defaults;
  const me = members.find((m) => m.is_me);
  // What the card starts from (I2): what the pages say, merged with what the
  // batch chose; untouched, it sends exactly what Accept all Ready files (I3).
  const p = item.proposals ?? null;
  const card =
    p && me
      ? untouchedAccept({ proposals: p, defaults: d, types, people: members, role, me: me.id })
      : null;
  const type = types.find((t) => t.key === (p ? p.type_key?.value : d.type_key));
  // A batch made Only me is the uploader's own: whose these are is them.
  const owner =
    role === 'teen'
      ? (me?.id ?? '')
      : p
        ? (p.owner_member_id?.value ?? (d.visibility === 'private' ? (me?.id ?? '') : ''))
        : (d.owner_member_id ?? (d.visibility === 'private' ? (me?.id ?? '') : ''));
  const startVisibility = (t: DocumentTypeView | undefined, o: string) => {
    // Somebody else's, chosen on the card, from a batch made Only me: Only
    // me is not for them, so the narrowest left, shown before accepting.
    if (d.visibility === 'private' && (o === '' || o !== me?.id)) {
      return can(role, 'document.see_adults') ? 'adults' : 'household';
    }
    return batchVisibility({ chosen: d.visibility, type: t ?? null, role, owner: o, me: me?.id });
  };
  const issuer = p?.issued_by?.value ?? '';
  const dup = item.duplicate ? dupWords(item) : null;
  const unread = (item.tags ?? []).find((t) => t.code === 'unread');
  const heading = card?.title ?? item.name;
  const pages = item.preview_pages ?? 0;
  const label = batchLabel(batch);

  return (
    <main className="page page-top page-wide has-nav review-page">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to="/inbox">Inbox</Link> <span aria-hidden="true">›</span>{' '}
        <Link to={queuePath}>{label}</Link> <span aria-hidden="true">›</span>{' '}
        <span aria-current="page">
          {position ? `File ${position} of ${run.order.length}` : item.name}
        </span>
      </nav>
      <p className="visually-hidden" role="status" aria-live="polite">
        {heard}
      </p>
      <p className="status-line" role="status">
        {run.last}
      </p>
      <div className="review">
        <section className="review-form" aria-labelledby="item-h">
          <div className="stack item-head">
            <h1 id="item-h" tabIndex={-1} className="clip-2">
              {heading}
            </h1>
            <p className="muted item-file">
              {item.name} · {sizeWords(item.byte_size)}
              {pages > 0 ? ` · ${pages === 1 ? '1 page' : `${pages} pages`}` : ''}
            </p>
            {item.level !== undefined && (
              <div className="batch-card-level">
                {item.level ? (
                  <LevelBadge level={item.level} />
                ) : (
                  <span className="status status-neutral">
                    {item.reading === 'reading'
                      ? 'Being read: accept it with the batch’s choices, or come back once it is read.'
                      : 'Waiting to be read: accept it with the batch’s choices, or come back once it is read.'}
                  </span>
                )}
                <ItemTags item={item} />
              </div>
            )}
            {item.level === 'ready' && (
              <p className="muted">
                Everything its kind needs is filled in, and the vault is sure of its kind and whose
                it is. Check it, and accept it.
              </p>
            )}
            <OnlyYou>Only you can see this until you accept it.</OnlyYou>
          </div>
          {dup && (
            <div className="problem-box" role="note">
              <strong>{dup}</strong>
              <span>
                It is the same file, byte for byte. Most likely this copy can go: remove it below,
                or accept it anyway to keep both.
              </span>
            </div>
          )}
          {unread && (
            <div className="problem-box" role="note">
              <strong>Couldn’t read the pages</strong>
              <span>{unread.detail}</span>
            </div>
          )}
          {(item.tags ?? [])
            .filter((t) => t.code === 'not_read')
            .map((t) => (
              <div key={t.code} className="problem-box problem-box-calm" role="note">
                <strong>Not read</strong>
                <span>{t.detail}</span>
              </div>
            ))}
          {item.level === 'unrecognised' && (
            <div className="problem-box problem-box-calm" role="note">
              <strong>Not recognised</strong>
              <span>
                The vault could not tell what kind of document this is. Choose a kind below, or
                remove it if it is not a document.
              </span>
            </div>
          )}
          <ErrorNote message={problem} />
          <ConfirmForm
            key={item.id}
            title="Is this right?"
            back={queuePath}
            lede=""
            fileName={item.name}
            types={types}
            members={members}
            initial={{
              typeKey: type?.key ?? '',
              title:
                card?.title ??
                (type
                  ? autoTitle(type, members.find((m) => m.id === owner) ?? null, {
                      issued_by: issuer,
                      issued: null,
                    })
                  : ''),
              owner,
              issuer,
              issued: p?.issued ? formatDate(p.issued.value) : '',
              expires: p?.expires ? formatDate(p.expires.value) : '',
              identifier: p?.identifier?.value ?? '',
              location: d.physical_location ?? '',
              // Never wider than the batch chose; narrower where its kind usually is.
              visibility: p?.visibility.value ?? startVisibility(type, owner),
              notes: '',
              details: {},
            }}
            startVisibility={startVisibility}
            {...(p
              ? {
                  marks: {
                    ...(p.type_key ? { type_key: p.type_key } : {}),
                    ...(p.owner_member_id && role !== 'teen'
                      ? { owner_member_id: p.owner_member_id }
                      : {}),
                    ...(p.issued_by ? { issued_by: p.issued_by } : {}),
                    ...(p.issued ? { issued: p.issued } : {}),
                    ...(p.expires ? { expires: p.expires } : {}),
                    ...(p.identifier ? { identifier: p.identifier } : {}),
                  },
                  clashes: item.clashes ?? [],
                }
              : {})}
            extras={{
              collections: addable(data.collections, role),
              collectionId: d.collection_id ?? '',
              tags: d.tags.join(', '),
              essential: d.is_essential,
            }}
            submitLabel={dup ? 'Accept anyway' : 'Accept and next'}
            pane={{
              hint: 'Enter',
              actions: (
                <>
                  <button type="button" className="btn btn-quiet" onClick={skip}>
                    Skip
                  </button>
                  <span className="spacer" />
                  <button
                    ref={removeButton}
                    type="button"
                    className="btn btn-quiet btn-danger-quiet"
                    onClick={() => setAsking(true)}
                  >
                    Not a document, remove it
                  </button>
                </>
              ),
            }}
            onSubmit={(details, extra) => accept(batch, item, details, extra)}
          />
        </section>
        <ItemPages key={item.id} batchId={batch.id} item={item} />
      </div>
      {asking && (
        <ConfirmDialog
          title={`Remove “${item.name}”?`}
          confirmLabel="Remove it"
          busyLabel="Removing…"
          danger
          busy={busy}
          returnFocus={removeButton}
          onConfirm={() => void remove()}
          onCancel={() => setAsking(false)}
        >
          <p>
            Its file and its pages are removed from the vault. It was never a document, so nothing
            else changes. Then the next file opens.
          </p>
        </ConfirmDialog>
      )}
    </main>
  );
}

/**
 * The file's pages, as the worker drew them (I3): one at a time, Previous
 * and Next, "Page 2 of 3", fitted to the pane's width or at their own
 * size. Page Up and Page Down turn them while the page has the focus — and
 * [ and ], while single keys are on (WCAG 2.1.4). Each page is asked for as
 * it is turned to, and kept until the file is decided.
 */
function ItemPages({ batchId, item }: { batchId: string; item: BatchItemView }) {
  const { withToken } = useApp();
  const shortcuts = useShortcutsOn();
  const [n, setN] = useState(1);
  const [fit, setFit] = useState(true);
  // Each page as it came back, by where it is held: a picture, or none.
  const [got, setGot] = useState<Record<string, string | false>>({});
  const total = item.preview_state === 'ready' ? (item.preview_pages ?? 0) : 0;
  const key = pageKey(item.id, n);
  const url = heldPage(key) ?? (got[key] || null);
  const missing = got[key] === false;

  useEffect(() => {
    if (total === 0 || heldPage(key)) return;
    let gone = false;
    const page = askPage(key, () => withToken((t) => api.batchItemPage(t, batchId, item.id, n)));
    void page.done.then((made) => {
      if (!gone) setGot((was) => ({ ...was, [key]: made ?? false }));
    });
    return () => {
      gone = true;
      page.cancel();
    };
  }, [key, total, batchId, item.id, n, withToken]);

  const turn = (by: number) => {
    const to = Math.min(Math.max(n + by, 1), total);
    if (to === n) return false;
    setN(to);
    return true;
  };
  const keys = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const next = e.key === 'PageDown' || (shortcuts && e.key === ']');
    const back = e.key === 'PageUp' || (shortcuts && e.key === '[');
    if (!next && !back) return;
    e.preventDefault();
    turn(next ? 1 : -1);
  };

  return (
    <section className="review-pages" aria-label={`Pages of ${item.name}`}>
      {total > 0 ? (
        <>
          <div className="row viewer-bar">
            <button
              type="button"
              className="btn btn-quiet btn-small"
              disabled={n <= 1}
              onClick={() => turn(-1)}
            >
              <span aria-hidden="true">‹ </span>Previous page
            </button>
            <span className="viewer-at" aria-live="polite">
              Page {n} of {total}
            </span>
            <button
              type="button"
              className="btn btn-quiet btn-small"
              disabled={n >= total}
              onClick={() => turn(1)}
            >
              Next page<span aria-hidden="true"> ›</span>
            </button>
            <button
              type="button"
              className="btn btn-quiet btn-small"
              aria-pressed={fit}
              onClick={() => setFit(!fit)}
            >
              Fit to width
            </button>
          </div>
          <div
            className={`viewer${fit ? ' viewer-fit' : ''}`}
            tabIndex={0}
            role="group"
            aria-label={`Page ${n} of ${total}. Page Up and Page Down turn the pages.`}
            aria-keyshortcuts={shortcuts ? 'PageUp PageDown [ ]' : 'PageUp PageDown'}
            onKeyDown={keys}
          >
            {url ? (
              <img src={url} alt={`Page ${n} of ${total}`} />
            ) : (
              <p className="muted">
                {missing ? 'This page could not be shown.' : 'Loading the page…'}
              </p>
            )}
          </div>
          <p className="muted viewer-hint">
            {shortcuts
              ? 'With the page in focus, Page Up and Page Down, or [ and ], turn the pages.'
              : 'With the page in focus, Page Up and Page Down turn the pages.'}
          </p>
        </>
      ) : (
        <div className="viewer viewer-none">
          <p className="muted">
            {item.preview_state === 'pending'
              ? 'Its pages are being drawn. They appear here once they are.'
              : item.preview_state === 'unsupported'
                ? 'The vault does not draw this kind of file’s pages.'
                : 'Its pages could not be drawn.'}
          </p>
        </div>
      )}
    </section>
  );
}
