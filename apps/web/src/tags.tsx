import {
  looksSecret,
  normaliseTag,
  secretTagWarning,
  tagKey,
  tagsProblem,
  tagSuggestions,
  TAGS_SEEN_NOTE,
  tagWords,
  TAG_MAX,
  type DocumentView,
  type TagView,
} from '@fdv/shared';
import { useId, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api, ApiRequestError } from './api.js';
import { describeError, useApp, useLoad } from './app-context.js';
import { heldNow } from './notes.js';
import { ErrorNote } from './ui.js';

/**
 * Tags you can use (0.9.0, T1), on the web: a document's tags as chips,
 * each opening Documents filtered by it; one added with type-ahead from
 * the tags this person can see, or taken off with its ×. A detail tag,
 * "locker: 12", is shown "Locker · 12" and read "Locker: 12".
 *
 * A change is the document's own edit (PATCH, with its ETag): somebody
 * else's change meanwhile is not lost, nor is this one — it is made again
 * on the document as it is now, once, and said to have been.
 */

/** Documents filtered by this tag. */
export function tagHref(tag: string): string {
  return `/documents?${new URLSearchParams({ tag }).toString()}`;
}

/** The tags this person can see, most used first: the type-ahead's words. None when not `wanted`. */
export function useKnownTags(wanted = true): TagView[] {
  const { authVersion } = useApp();
  const { data } = useLoad(
    async (t) => (wanted ? (await api.tags(t, undefined, { limit: 1000 })).items : []),
    [authVersion, wanted],
  );
  return data ?? [];
}

/** A tag as a chip: "Locker · 12", heard as "Locker: 12". */
export function TagText({ tag }: { tag: string }) {
  const words = tagWords(tag);
  if (words.text === words.spoken) return <>{words.text}</>;
  return (
    <>
      <span aria-hidden="true">{words.text}</span>
      <span className="visually-hidden">{words.spoken}</span>
    </>
  );
}

/**
 * A tag being typed: what the person has typed, what is offered for it,
 * and — for one that looks like a secret — said, and asked once more.
 * `onAdd` is given the tag as the vault keeps it, and says whether it was
 * added (the field is then empty again).
 */
export function TagField(props: {
  id: string;
  label: string;
  known: readonly TagView[];
  /** The tags it already has: never offered again. */
  have: readonly string[];
  busy: boolean;
  /** "Add", or "Add to 3 documents". */
  action: string;
  onAdd: (tag: string) => Promise<boolean>;
}) {
  const [typed, setTyped] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  // A tag that looks like a secret, said once: added on the second ask.
  const [warned, setWarned] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const noteId = `${props.id}-note`;
  const warnId = `${props.id}-warn`;
  const offered = tagSuggestions(typed, props.known, props.have);

  const add = async (raw: string) => {
    const tag = normaliseTag(raw);
    setProblem(null);
    if (!tag) {
      setProblem('Type a tag first.');
      return;
    }
    const tooLong = tagsProblem([tag]);
    if (tooLong) {
      setProblem(tooLong);
      return;
    }
    if (looksSecret(tag) && warned !== tagKey(tag)) {
      setTyped(tag);
      setWarned(tagKey(tag));
      return;
    }
    if (await props.onAdd(tag)) {
      setTyped('');
      setWarned(null);
      input.current?.focus();
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!props.busy) void add(typed);
  };
  const warning = warned !== null && warned === tagKey(typed) ? secretTagWarning(typed) : null;

  return (
    <form className="tag-add" onSubmit={submit} noValidate>
      <div className="field">
        <label htmlFor={props.id}>{props.label}</label>
        <div className="tag-add-row">
          <input
            ref={input}
            id={props.id}
            type="text"
            value={typed}
            autoComplete="off"
            autoCapitalize="none"
            placeholder="travel, or locker: 12"
            maxLength={TAG_MAX * 4}
            aria-describedby={warning ? `${warnId} ${noteId}` : noteId}
            aria-invalid={problem ? true : undefined}
            onChange={(e) => {
              setTyped(e.target.value);
              setProblem(null);
            }}
          />
          <button type="submit" className="btn btn-quiet" disabled={props.busy}>
            {warning ? 'Add it anyway' : props.action}
          </button>
        </div>
        <span id={noteId} className="muted">
          A word, or a detail as “label: value” — “locker: 12”. {TAGS_SEEN_NOTE}
        </span>
      </div>
      {warning && (
        <p id={warnId} className="status-warn tag-warn" role="alert">
          {warning}
        </p>
      )}
      <ErrorNote message={problem} />
      {offered.length > 0 && (
        <div className="pills tag-offers" role="group" aria-label="Tags already used">
          {offered.map((t) => (
            <button
              key={t}
              type="button"
              className="pill pill-sugg"
              disabled={props.busy}
              aria-label={`${props.action}: ${tagWords(t).spoken}`}
              onClick={() => void add(t)}
            >
              <TagText tag={t} />
            </button>
          ))}
        </div>
      )}
    </form>
  );
}

/** One change to a document's tags, made again on what the vault holds now. */
type TagChange = { add: string } | { remove: string };

function applied(tags: readonly string[], change: TagChange): string[] | null {
  if ('add' in change) {
    if (tags.some((t) => tagKey(t) === tagKey(change.add))) return null;
    return [...tags, change.add];
  }
  if (!tags.some((t) => tagKey(t) === tagKey(change.remove))) return null;
  return tags.filter((t) => tagKey(t) !== tagKey(change.remove));
}

/**
 * A document's tags on its page (0.9.0, T1): chips that open Documents
 * filtered by each, and — for whoever may change the document — a field
 * to add one and a × to take one off.
 */
export function TagSection(props: {
  doc: DocumentView;
  mayEdit: boolean;
  /** The document as the vault answered the change. */
  onSaved: (doc: DocumentView) => void;
}) {
  const { withToken } = useApp();
  const { doc } = props;
  const known = useKnownTags(props.mayEdit);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const fieldId = useId();
  const headingId = `${fieldId}-h`;

  /**
   * The change, with the ETag the page has. Refused because the document
   * changed meanwhile (409), it is made again, once, on the document as the
   * vault holds it now — so neither change is lost — and said so.
   */
  const change = async (what: TagChange): Promise<boolean> => {
    setBusy(true);
    setSaid(null);
    setProblem(null);
    let base = doc;
    try {
      for (let tries = 0; tries < 2; tries++) {
        const tags = applied(base.tags, what);
        if (tags === null) {
          // Already so on the document as it is now: nothing to send.
          if (base !== doc) props.onSaved(base);
          return true;
        }
        try {
          const saved = await withToken((t) => api.updateDocument(t, doc.id, { tags }, base.etag));
          if (!saved) return false;
          props.onSaved(saved);
          if (base !== doc) {
            setSaid(
              'Someone else changed this document meanwhile. Your change was made on top of theirs.',
            );
          }
          return true;
        } catch (err) {
          if (!(err instanceof ApiRequestError && err.status === 409)) throw err;
          const now = heldNow(err);
          if (!now || tries > 0) {
            if (now) props.onSaved(now);
            setProblem(
              'Someone else is changing this document too. It has been loaded again: try once more.',
            );
            return false;
          }
          base = now;
        }
      }
      return false;
    } catch (err) {
      setProblem(describeError(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (doc.tags.length === 0 && !props.mayEdit) return null;
  return (
    <section aria-labelledby={headingId} className="doc-tags">
      <h2 id={headingId} ref={heading} tabIndex={-1} className="section-h">
        Tags
      </h2>
      {doc.tags.length > 0 ? (
        <ul className="tag-chips" aria-label="Tags">
          {doc.tags.map((tag) => {
            const words = tagWords(tag);
            return (
              <li key={tag} className="tag-chip">
                <Link
                  to={tagHref(tag)}
                  className="tag-chip-link"
                  aria-label={`Documents tagged ${words.spoken}`}
                >
                  <TagText tag={tag} />
                </Link>
                {props.mayEdit && (
                  <button
                    type="button"
                    className="tag-chip-remove"
                    disabled={busy}
                    aria-label={`Remove the tag ${words.spoken}`}
                    onClick={() => {
                      void change({ remove: tag }).then((done) => {
                        if (done) {
                          setSaid((s) => s ?? `“${words.spoken}” is no longer a tag here.`);
                          heading.current?.focus();
                        }
                      });
                    }}
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted">No tags yet.</p>
      )}
      <p role="status" className="notice status-line">
        {said}
      </p>
      <ErrorNote message={problem} />
      {props.mayEdit && (
        <TagField
          id={`${fieldId}-add`}
          label="Add a tag"
          known={known}
          have={doc.tags}
          busy={busy}
          action="Add"
          onAdd={(tag) =>
            change({ add: tag }).then((done) => {
              if (done) setSaid((s) => s ?? `“${tagWords(tag).spoken}” added.`);
              return done;
            })
          }
        />
      )}
    </section>
  );
}
