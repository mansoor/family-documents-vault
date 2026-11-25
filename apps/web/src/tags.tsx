import {
  looksSecret,
  normaliseTag,
  recentTagOffers,
  RECENT_TAGS_OFFERED,
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
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Link } from 'react-router';
import { api, ApiRequestError } from './api.js';
import { describeError, useApp } from './app-context.js';
import { heldNow } from './notes.js';
import { tagsChanged } from './tag-store.js';
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

/** How long typing has to stop before the vault is asked what fits. */
const TYPED_SETTLES_MS = 150;

/** What the vault offered, and for what: `q` as typed, and whether it is "Recently used". */
interface Found {
  q: string;
  items: TagView[];
  recent: boolean;
}

/**
 * The tags offered as somebody types (the T1 review, H1): nothing is asked
 * until the field is first given the focus; then the vault is asked for
 * those that start with what is typed (`q`), a few at a time, once the
 * typing stops — never the household's every tag.
 *
 * Nothing typed yet (0.9.0-dev.103), the tags used most recently instead,
 * as many more than five as the document has already, so that five are
 * left to offer: asked again each time the field is given the focus, so a
 * tag just added anywhere is first. `focused` counts the times it was.
 */
function useTypeAhead(typed: string, focused: number, have: number): Found {
  const { withToken, caps } = useApp();
  const [found, setFound] = useState<Found>({ q: '', items: [], recent: false });
  const q = typed.replace(/^\s+/, '');
  const recent = caps?.features.recent_tags === true && q === '';
  // Asked again on each focus only while nothing is typed.
  const round = q === '' ? focused : -1;
  const want = recent ? RECENT_TAGS_OFFERED + have : 50;
  useEffect(() => {
    if (focused === 0) return;
    let stopped = false;
    const timer = window.setTimeout(() => {
      void withToken((t) =>
        api.tags(t, q || undefined, recent ? { sort: 'recent', limit: want } : { limit: 50 }),
      )
        .then((r) => {
          if (!stopped && r) setFound({ q, items: r.items, recent });
        })
        .catch(() => undefined);
    }, TYPED_SETTLES_MS);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
    // `focused` is asked by `round`, so typing does not ask for every focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, round, recent, want, withToken]);
  return found;
}

/** The id of "Recently used" under a field: what the field is described by while it shows. */
const recentHeadId = (fieldId: string) => `${fieldId}-recent`;

/**
 * The tags offered under a tag field, as pills (0.9.0-dev.103): with
 * nothing typed, those used most recently, "Recently used"; as somebody
 * types, those that fit, "Tags already used". `label` names each pill for
 * a screen reader: "Add: travel".
 */
function TagOffers(props: {
  id: string;
  recent: readonly string[];
  offered: readonly string[];
  busy: boolean;
  label: (tag: string) => string;
  onPick: (tag: string) => void;
}) {
  const shown = props.recent.length > 0 ? props.recent : props.offered;
  if (shown.length === 0) return null;
  const headId = recentHeadId(props.id);
  const isRecent = props.recent.length > 0;
  return (
    <div
      className="pills tag-offers"
      role="group"
      {...(isRecent ? { 'aria-labelledby': headId } : { 'aria-label': 'Tags already used' })}
    >
      {isRecent && (
        <span id={headId} className="tag-offers-h muted">
          Recently used
        </span>
      )}
      {shown.map((t) => (
        <button
          key={t}
          type="button"
          className="pill pill-sugg"
          disabled={props.busy}
          aria-label={props.label(t)}
          onClick={() => props.onPick(t)}
        >
          <TagText tag={t} />
        </button>
      ))}
    </div>
  );
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
  // Asked for only once the field has had the focus; the recently used again on each.
  const [focused, setFocused] = useState(0);
  const found = useTypeAhead(typed, focused, props.have.length);
  const input = useRef<HTMLInputElement>(null);
  const noteId = `${props.id}-note`;
  const warnId = `${props.id}-warn`;
  const errorId = `${props.id}-error`;
  const blank = typed.trim() === '';
  const offered = tagSuggestions(typed, found.items, props.have);
  const recent = blank && found.recent ? recentTagOffers(found.items, props.have) : [];

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
  // What the field is described by: a refusal, the warning, and the note (the review's L7);
  // and "Recently used" while its pills show, so it is heard that they are there.
  const describedBy = [
    problem ? errorId : null,
    warning ? warnId : null,
    noteId,
    recent.length > 0 ? recentHeadId(props.id) : null,
  ]
    .filter(Boolean)
    .join(' ');

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
            aria-describedby={describedBy}
            aria-invalid={problem ? true : undefined}
            onFocus={() => setFocused((n) => n + 1)}
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
      {problem && (
        <p id={errorId} className="error" role="alert">
          {problem}
        </p>
      )}
      <TagOffers
        id={props.id}
        recent={recent}
        offered={offered}
        busy={props.busy}
        label={(t) => `${props.action}: ${tagWords(t).spoken}`}
        onPick={(t) => void add(t)}
      />
    </form>
  );
}

/**
 * A field of tags with a comma between them — Add's and the Inbox's card,
 * a batch's defaults — offered the same pills as a tag field
 * (0.9.0-dev.103): once it has the focus and nothing is typed where the
 * caret is, the tags used most recently; as a tag is typed there, those
 * that fit. One picked takes the place of the tag the caret is in, and the
 * others are left exactly as typed; picked at the end, a comma follows it,
 * ready for the next. `children` draws the field, whose input is `id`,
 * given what else it is described by: "Recently used", while it shows.
 */
export function TagPicks(props: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  busy?: boolean;
  children: (describedBy: string | undefined) => ReactNode;
}) {
  const [focused, setFocused] = useState(0);
  // Where the caret was last, in the value it was in; elsewhere, the end.
  const [caret, setCaret] = useState<{ value: string; at: number } | null>(null);
  const putCaret = useRef<number | null>(null);
  const at = caret !== null && caret.value === props.value ? caret.at : props.value.length;
  const parts = props.value.split(',');
  const which = props.value.slice(0, at).split(',').length - 1;
  const typing = parts[which] ?? '';
  const done = parts
    .filter((_, i) => i !== which)
    .map((t) => t.trim())
    .filter(Boolean);
  const found = useTypeAhead(typing, focused, done.length);
  const recent = typing.trim() === '' && found.recent ? recentTagOffers(found.items, done) : [];
  const offered = tagSuggestions(typing, found.items, done);
  const input = () => document.getElementById(props.id) as HTMLInputElement | null;
  const read = (e: { target: EventTarget }) => {
    const el = e.target as HTMLInputElement;
    if (el.id === props.id && el.selectionStart !== null) {
      setCaret({ value: el.value, at: el.selectionStart });
    }
  };
  // The caret put after the tag picked, once the field shows it.
  useLayoutEffect(() => {
    const to = putCaret.current;
    if (to === null) return;
    putCaret.current = null;
    input()?.setSelectionRange(to, to);
    setCaret({ value: props.value, at: to });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.value]);
  const pick = (tag: string) => {
    const last = which === parts.length - 1;
    const before = parts.slice(0, which).join(',');
    const put = `${which > 0 ? `${before}, ` : ''}${tag}`;
    const after = last ? ', ' : `,${parts.slice(which + 1).join(',')}`;
    putCaret.current = put.length + (last ? 2 : 0);
    props.onChange(put + after);
    // Back to the field, for the next: the recently used asked again.
    input()?.focus();
  };
  return (
    <div
      className="tag-picks"
      onFocus={(e) => {
        if (e.target.id === props.id) setFocused((n) => n + 1);
      }}
      onSelect={read}
      onKeyUp={read}
      onClick={read}
    >
      {props.children(recent.length > 0 ? recentHeadId(props.id) : undefined)}
      <TagOffers
        id={props.id}
        recent={recent}
        offered={offered}
        busy={props.busy ?? false}
        label={(t) => `Add the tag ${tagWords(t).spoken}`}
        onPick={pick}
      />
    </div>
  );
}

/** One change to a document's tags, made again on what the vault holds now. */
type TagChange = { add: string } | { remove: string };

/**
 * The tags once the change is made; or, nothing to send, why: the tag is
 * there already, as typed, or it is not there to take off. A tag there in
 * another spelling ("agent: sam lee", "agent: Sam Lee") is spelt as now
 * typed, in its place (the review's L5).
 */
function applied(
  tags: readonly string[],
  change: TagChange,
): { tags: string[]; respelt?: string } | { already: true } | { gone: true } {
  if ('add' in change) {
    const at = tags.findIndex((t) => tagKey(t) === tagKey(change.add));
    if (at < 0) return { tags: [...tags, change.add] };
    const was = tags[at] as string;
    if (was === change.add) return { already: true };
    return { tags: tags.map((t, i) => (i === at ? change.add : t)), respelt: was };
  }
  if (!tags.includes(change.remove)) return { gone: true };
  return { tags: tags.filter((t) => t !== change.remove) };
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
  // An Only me or an Essential note's change asks to confirm it's you, once
  // in five minutes, as a save of its words does (0.9.0-dev.87).
  const { guarded } = useApp();
  const { doc } = props;
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const fieldId = useId();
  const headingId = `${fieldId}-h`;

  /**
   * The change, with the ETag the page has. Refused because the document
   * changed meanwhile (409), it is made again, once, on the document as the
   * vault holds it now — so neither change is lost — and said so. What it
   * came to is said: added, respelt, there already, taken off.
   */
  const change = async (what: TagChange): Promise<boolean> => {
    setBusy(true);
    setSaid(null);
    setProblem(null);
    let base = doc;
    const meanwhile = () => (base !== doc ? 'Someone else changed this document meanwhile. ' : '');
    try {
      for (let tries = 0; tries < 2; tries++) {
        const next = applied(base.tags, what);
        if ('already' in next || 'gone' in next) {
          if (base !== doc) props.onSaved(base);
          const spoken = tagWords('add' in what ? what.add : what.remove).spoken;
          setSaid(
            'already' in next
              ? `${meanwhile()}“${spoken}” is already a tag here.`
              : `${meanwhile()}“${spoken}” is no longer a tag here.`,
          );
          return true;
        }
        try {
          const saved = await guarded((t) =>
            api.updateDocument(t, doc.id, { tags: next.tags }, base.etag),
          );
          if (!saved) return false;
          props.onSaved(saved);
          // The Documents filter lists it (or no longer does) without leaving the page.
          tagsChanged();
          const spoken = tagWords('add' in what ? what.add : what.remove).spoken;
          const done =
            'remove' in what
              ? `“${spoken}” is no longer a tag here.`
              : next.respelt
                ? `“${tagWords(next.respelt).spoken}” is now spelt “${spoken}”.`
                : `“${spoken}” added.`;
          setSaid(
            base !== doc
              ? `Someone else changed this document meanwhile. Your change was made on top of theirs: ${done}`
              : done,
          );
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
                        if (done) heading.current?.focus();
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
          have={doc.tags}
          busy={busy}
          action="Add"
          onAdd={(tag) => change({ add: tag })}
        />
      )}
    </section>
  );
}
