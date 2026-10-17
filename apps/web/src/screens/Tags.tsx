import {
  can,
  groupTags,
  looksSecret,
  normaliseTag,
  refusalFor,
  secretTagWarning,
  tagKey,
  tagsProblem,
  tagWords,
  TAG_MAX,
  type TagChangeResult,
  type TagView,
} from '@fdv/shared';
import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { Link } from 'react-router';
import { api, ApiRequestError } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { storedRole } from '../session.js';
import { useShellMode } from '../shell.js';
import { tagHref, TagText } from '../tags.js';
import { Button, ConfirmDialog, ErrorNote, Field, Sheet, TopBar } from '../ui.js';

/**
 * Settings → Tags (0.9.0, T1): every tag the person can see, with how many
 * of the documents they can see carry it — detail tags grouped by their
 * label — and each renamed (into one there already: merged, asked first)
 * or deleted. For whoever may change documents: owners, adults and teens.
 *
 * A rename or a delete changes the documents the person may change, and no
 * others. Nothing here counts, or says anything of, a document they cannot
 * see; of those they can see but may not change (a teen's, of the family's)
 * it says how many keep the tag.
 */

/** "1 document", "3 documents". */
const docs = (n: number) => `${n} document${n === 1 ? '' : 's'}`;

/** What a rename, a merge or a delete came to, in words: the Trash's said too (the review's M2). */
function outcomeWords(r: TagChangeResult, done: string): string {
  const trash = r.in_trash ?? 0;
  const changed =
    r.changed > 0
      ? `${done} Changed on ${docs(r.changed)}${trash > 0 ? `, including ${trash} in the Trash` : ''}.`
      : 'Nothing changed.';
  const kept = r.kept > 0 ? ` It stays on ${docs(r.kept)} you can see but can’t change.` : '';
  return `${changed}${kept}`;
}

/** The most tags the list is given at once: past it, a search finds the rest (the review's L4). */
const LISTED = 1000;

/** How long typing in Find a tag has to stop before the vault is asked. */
const FIND_SETTLES_MS = 200;

export function TagsScreen() {
  const { withToken, authVersion } = useApp();
  const mayChange = can(storedRole(), 'document.edit');
  const backToSettings =
    useShellMode() === 'phone' ? { back: '/settings', backLabel: 'Back to Settings' } : {};
  // Those starting with what is typed in Find a tag, once the typing stops.
  const [find, setFind] = useState('');
  const [asked, setAsked] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setAsked(find.trim()), FIND_SETTLES_MS);
    return () => window.clearTimeout(timer);
  }, [find]);
  const { data, error, reload } = useLoad(
    async (t) =>
      mayChange ? (await api.tags(t, asked || undefined, { limit: LISTED })).items : [],
    [authVersion, asked],
  );
  const [said, setSaid] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<TagView | null>(null);
  const [deleting, setDeleting] = useState<TagView | null>(null);
  const [merging, setMerging] = useState<{ from: TagView; to: string; message: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const status = useRef<HTMLParagraphElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);

  const done = async (r: TagChangeResult | null, words: string) => {
    if (!r) return;
    setSaid(outcomeWords(r, words));
    await reload();
    window.setTimeout(() => status.current?.focus(), 0);
  };

  const rename = async (from: TagView, to: string, merge: boolean): Promise<string | null> => {
    setBusy(true);
    setProblem(null);
    setSaid(null);
    try {
      const r = await withToken((t) =>
        api.renameTag(t, { from: from.tag, to, ...(merge ? { merge: true } : {}) }),
      );
      setRenaming(null);
      setMerging(null);
      await done(
        r,
        merge
          ? `“${tagWords(from.tag).text}” merged into “${tagWords(to).text}”.`
          : `“${tagWords(from.tag).text}” is now “${tagWords(to).text}”.`,
      );
      return null;
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'tag_exists') {
        setRenaming(null);
        setMerging({ from, to, message: err.message });
        return null;
      }
      return describeError(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (tag: TagView) => {
    setBusy(true);
    setProblem(null);
    setSaid(null);
    try {
      const r = await withToken((t) => api.deleteTag(t, tag.tag));
      setDeleting(null);
      await done(r, `“${tagWords(tag.tag).text}” deleted.`);
    } catch (err) {
      setDeleting(null);
      setProblem(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  if (!mayChange) {
    return (
      <main className="page page-top has-nav">
        <TopBar title="Tags" {...backToSettings} />
        <p className="status status-warn">{refusalFor('document.edit')}</p>
      </main>
    );
  }

  const groups = groupTags(data ?? []);
  const row = (t: TagView) => (
    <TagRow
      key={t.tag}
      tag={t}
      busy={busy}
      onRename={(button) => {
        opener.current = button;
        setRenaming(t);
      }}
      onDelete={(button) => {
        opener.current = button;
        setDeleting(t);
      }}
    />
  );

  return (
    <main className="page page-top has-nav">
      <TopBar title="Tags" {...backToSettings} />
      <p className="lede">
        Every tag on the documents you can see, and how many carry it. Renaming or deleting one
        changes it on the documents you can change.
      </p>
      <p role="status" ref={status} tabIndex={-1} className="notice status-line">
        {said}
      </p>
      <ErrorNote message={problem ?? error} />
      <div className="field tags-find">
        <label htmlFor="tags-find">Find a tag</label>
        <input
          id="tags-find"
          type="search"
          value={find}
          autoComplete="off"
          placeholder="locker, or locker: 1"
          aria-describedby="tags-find-note"
          onChange={(e) => setFind(e.target.value)}
        />
        <span id="tags-find-note" className="muted">
          {data !== null && data.length >= LISTED
            ? `Showing the ${LISTED.toLocaleString('en-GB')} used most. Find a tag to see one further down.`
            : 'Those that start with what you type.'}
        </span>
      </div>
      {data !== null && data.length === 0 && (
        <p className="muted">
          {asked
            ? `No tag starts with “${asked}”.`
            : 'No tags yet. Add them on a document’s page, or to many at once in Documents.'}
        </p>
      )}
      {groups.plain.length > 0 && (
        <section aria-labelledby="tags-plain-h">
          <h2 id="tags-plain-h" className="section-h">
            Tags
          </h2>
          <ul className="list">{groups.plain.map(row)}</ul>
        </section>
      )}
      {groups.labels.length > 0 && (
        <section aria-labelledby="tags-details-h">
          <h2 id="tags-details-h" className="section-h">
            Details
          </h2>
          <p className="muted">
            Tags written “label: value”, by their label. Documents can be filtered by a label, any
            value.
          </p>
          {groups.labels.map((g) => (
            <div key={g.key} className="tag-group">
              <h3 className="tag-group-h">
                <Link to={`/documents?${new URLSearchParams({ label: g.key }).toString()}`}>
                  {g.label}
                </Link>
              </h3>
              <ul className="list" aria-label={g.label}>
                {g.tags.map(row)}
              </ul>
            </div>
          ))}
        </section>
      )}
      {renaming && (
        <RenameSheet
          tag={renaming}
          busy={busy}
          returnFocus={opener}
          onRename={(to) => rename(renaming, to, false)}
          onCancel={() => setRenaming(null)}
        />
      )}
      {merging && (
        <ConfirmDialog
          title={`Merge “${tagWords(merging.from.tag).text}” into “${tagWords(merging.to).text}”?`}
          confirmLabel="Merge them"
          busyLabel="Merging…"
          busy={busy}
          returnFocus={opener}
          onConfirm={() => void rename(merging.from, merging.to, true)}
          onCancel={() => setMerging(null)}
        >
          <p>
            {merging.message} A document that has both keeps one. It changes the{' '}
            {docs(merging.from.changeable ?? merging.from.count)} you can change.
          </p>
        </ConfirmDialog>
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete the tag “${tagWords(deleting.tag).text}”?`}
          confirmLabel="Delete it"
          busyLabel="Deleting…"
          danger
          busy={busy}
          returnFocus={opener}
          onConfirm={() => void remove(deleting)}
          onCancel={() => setDeleting(null)}
        >
          <p>
            It is taken off the {docs(deleting.changeable ?? deleting.count)} you can change.
            {(deleting.changeable ?? deleting.count) < deleting.count &&
              ` It stays on ${docs(deleting.count - (deleting.changeable ?? deleting.count))} you can see but can’t change.`}
          </p>
        </ConfirmDialog>
      )}
    </main>
  );
}

/** One tag: how many carry it, and its Rename and Delete where there is any of it to change. */
function TagRow(props: {
  tag: TagView;
  busy: boolean;
  onRename: (button: HTMLButtonElement | null) => void;
  onDelete: (button: HTMLButtonElement | null) => void;
}) {
  const { tag } = props;
  const rename = useRef<HTMLButtonElement>(null);
  const del = useRef<HTMLButtonElement>(null);
  const words = tagWords(tag.tag);
  const changeable = tag.changeable ?? tag.count;
  return (
    <li>
      <span>
        <Link to={tagHref(tag.tag)} className="doc-title">
          <TagText tag={tag.tag} />
        </Link>
        <span className="muted">
          {docs(tag.count)}
          {changeable < tag.count && ` · you can change ${changeable}`}
        </span>
      </span>
      {changeable > 0 && (
        <span className="row" style={{ gap: 4 }}>
          <button
            ref={rename}
            type="button"
            className="btn btn-quiet btn-small"
            disabled={props.busy}
            aria-label={`Rename ${words.spoken}`}
            onClick={() => props.onRename(rename.current)}
          >
            Rename
          </button>
          <button
            ref={del}
            type="button"
            className="btn btn-quiet btn-small"
            disabled={props.busy}
            aria-label={`Delete ${words.spoken}`}
            onClick={() => props.onDelete(del.current)}
          >
            Delete
          </button>
        </span>
      )}
    </li>
  );
}

/** What to rename a tag to: refused here if it is empty or too long, as the vault would. */
function RenameSheet(props: {
  tag: TagView;
  busy: boolean;
  returnFocus: RefObject<HTMLElement | null>;
  onRename: (to: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [to, setTo] = useState(props.tag.tag);
  const [problem, setProblem] = useState<string | null>(null);
  // A new name that looks like a secret, said once: renamed on the second ask.
  const [warned, setWarned] = useState<string | null>(null);
  const shown = tagWords(props.tag.tag).text;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (props.busy) return;
    const next = normaliseTag(to);
    if (!next) {
      setProblem('Type what to rename it to.');
      return;
    }
    const tooLong = tagsProblem([next]);
    if (tooLong) {
      setProblem(tooLong);
      return;
    }
    if (next === props.tag.tag) {
      props.onCancel();
      return;
    }
    if (looksSecret(next) && warned !== tagKey(next)) {
      setWarned(tagKey(next));
      return;
    }
    setProblem(await props.onRename(next));
  };
  const same = tagKey(to) === tagKey(props.tag.tag);
  const warning = warned !== null && warned === tagKey(to) ? secretTagWarning(to) : null;
  return (
    <Sheet
      label={`Rename “${shown}”`}
      busy={props.busy}
      returnFocus={props.returnFocus}
      onClose={props.onCancel}
    >
      <form className="card stack" onSubmit={(e) => void submit(e)} noValidate>
        <h2 style={{ fontSize: 20 }}>Rename “{shown}”</h2>
        <Field
          id="tag-rename"
          label="New name"
          value={to}
          onChange={(v) => {
            setTo(v);
            setProblem(null);
          }}
          maxLength={TAG_MAX * 4}
          hint={`It changes on the ${docs(props.tag.changeable ?? props.tag.count)} you can change. A tag that is there already is merged with it.`}
        />
        {warning && (
          <p className="status-warn tag-warn" role="alert">
            {warning}
          </p>
        )}
        <ErrorNote message={problem} />
        <div className="row">
          <Button type="submit" disabled={props.busy || (same && to.trim() === props.tag.tag)}>
            {props.busy ? 'Renaming…' : warning ? 'Rename it anyway' : 'Rename'}
          </Button>
          <Button kind="quiet" disabled={props.busy} onClick={props.onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
