import {
  can,
  CHECKLIST_COUNT_MAX,
  CHECKLIST_ITEMS_MAX,
  CHECKLIST_LINES_MAX,
  CHECKLIST_MONTHS_MAX,
  CHECKLIST_TEXT_MAX,
  checklistReadersWords,
  checklistSkipWords,
  formatDate,
  savedItem,
  sentItem,
  sharedOutsideWords,
  UPLOAD_REQUEST_ITEM_LABEL_MAX,
  UPLOAD_REQUEST_ITEMS_MAX,
  UPLOAD_REQUEST_TITLE_MAX,
  type ChecklistAdded,
  type ChecklistItem,
  type ChecklistItemCheck,
  type ChecklistMatch,
  type CollectionChecklist,
  type CollectionView,
  type DocumentTypeView,
  type Member,
  type Role,
  NOTE_KIND,
} from '@fdv/shared';
import { useEffect, useRef, useState, type Ref, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { useNavigate } from 'react-router';
import { api, ApiRequestError } from './api.js';
import { describeError, useApp } from './app-context.js';
import { documentsWord } from './collections.js';
import { Button, ConfirmDialog, ErrorNote, Field, Sheet, TextArea } from './ui.js';

/**
 * A collection from a checklist (0.9.0, C1): "Fill from a checklist" on a
 * collection's page, and the checklist kept on it.
 *
 * The person pastes or types the list; the vault reads it with plain rules
 * (no AI) and shows back what it understood of each line, with the
 * documents it found — ticked, with their title, date and person — and
 * what is missing. A line it could not read says so; the person chooses
 * its kind, whose it is and how many, or skips it. Nothing goes in until
 * "Add all found": then only what is ticked, by the collection's own rules
 * — a collection shared outside the family says so, and asks, first, as
 * Add documents does — and the list is kept on the collection, matched
 * again whenever the page opens. What is missing can be asked for, with the
 * vault's own "Ask for documents" link: what its sender will see is shown,
 * and may be changed, first.
 */

/** The ids one call to add takes: the rest go in the calls after it. */
const ADD_AT_ONCE = 200;

/** The family who may read a checklist: never a viewer or a guest. */
export const checklistOffered = (
  caps: { features?: { collection_checklist?: boolean } } | null,
  role: Role | null,
): boolean =>
  Boolean(caps?.features?.collection_checklist) &&
  (role === 'owner' || role === 'adult' || role === 'teen');

/**
 * "Found 2 of 3", "Found 1 of 2; 1 more found, not added", "Not
 * understood", "Whose?": a line's status, in words. Found counts only what
 * is, or will be, in the collection.
 */
export function statusWords(i: ChecklistItemCheck): string {
  if (i.skipped) return 'Skipped';
  if (i.problem === 'kind' || i.problem === 'years') return 'Not understood';
  if (i.problem) return 'Whose? Choose who it is for';
  // Several found by their titles (0.9.0): none ticked, to choose from.
  if (i.by_title && i.found === 0 && i.found_not_added === 0) return 'Choose which';
  const notAdded =
    i.found_not_added > 0
      ? `${i.found_not_added} ${i.found === 0 ? '' : 'more '}found, not added`
      : '';
  if (i.found === 0) return notAdded ? capital(notAdded) : 'Missing';
  return `Found ${i.found} of ${i.wanted}${notAdded ? `; ${notAdded}` : ''}`;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const tone = (i: ChecklistItemCheck) =>
  i.skipped
    ? 'muted'
    : !i.understood
      ? 'status status-warn'
      : i.found >= i.wanted
        ? 'status status-ok'
        : 'status status-warn';

/** A match as a line says it: its title, date and person. */
function matchWords(m: ChecklistMatch, members: readonly Member[]): string {
  const when = m.issued
    ? formatDate(m.issued)
    : `added ${formatDate({ date: m.added_at.slice(0, 10), precision: 'day' })}`;
  const whose = members.find((p) => p.id === m.owner_member_id)?.display_name;
  return [m.title ?? 'Scan · needs a name', when, whose].filter(Boolean).join(' · ');
}

/** "How many", as the select says it: the most recent, the last N, each of the last N months. */
function howMany(i: ChecklistItem): string {
  if (i.months !== null) return `m:${i.months}`;
  if (i.count !== null) return `n:${i.count}`;
  return '';
}

/** The items as they are kept: nothing of what was found. */
const keptOf = (items: readonly ChecklistItem[]) => JSON.stringify(items.map(savedItem));

// ---------------------------------------------------------- on the page

/**
 * The checklist kept on a collection, as the page opens: each line and how
 * it stands, matched again now. Its maker is offered what newly matches,
 * never given it by itself.
 */
export function ChecklistSection({
  ref,
  ...props
}: {
  collection: CollectionView;
  checklist: CollectionChecklist | null;
  error: string | null;
  mayFill: boolean;
  /** Fill from a checklist, for the sheet to give the focus back to. */
  ref?: Ref<HTMLButtonElement>;
  onFill: () => void;
}) {
  const { checklist } = props;
  const kept = checklist?.saved_at ? checklist : null;
  if (!kept && !props.mayFill) return null;
  return (
    <section aria-labelledby="checklist-h" className="stack checklist">
      <h2 id="checklist-h" className="section-h">
        Checklist
      </h2>
      <ErrorNote message={props.error} />
      {kept ? (
        <>
          <ol className="checklist-lines" aria-label="What the checklist asks for">
            {kept.items.map((i, n) => (
              <li key={n} className="checklist-line">
                <span className="checklist-what">
                  {i.heading && <span className="muted checklist-heading">{i.heading}</span>}
                  <span>{i.understood ? i.summary : i.line}</span>
                </span>
                <span className={tone(i)}>{statusWords(i)}</span>
                {i.missing.length > 0 && !i.skipped && (
                  <span className="muted">Missing: {i.missing.join('; ')}</span>
                )}
              </li>
            ))}
          </ol>
          {props.mayFill && kept.to_add > 0 && (
            <p className="notice">
              {kept.to_add === 1
                ? '1 document now matches this checklist and is not in the collection yet.'
                : `${kept.to_add} documents now match this checklist and are not in the collection yet.`}{' '}
              Nothing is added until you choose.
            </p>
          )}
        </>
      ) : (
        <p className="muted">
          Paste a list of what you need — “Documents for Mansoor”, “Last 3 pay statements” — and the
          vault finds them for you to add.
        </p>
      )}
      {props.mayFill && (
        <div className="row">
          <button ref={ref} type="button" className="btn btn-quiet" onClick={props.onFill}>
            {kept
              ? kept.to_add > 0
                ? 'Review and add'
                : 'Change the checklist'
              : 'Fill from a checklist'}
          </button>
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------ the sheet

/** What the sheet says it did, for the page to say once it closes. */
export interface ChecklistDone {
  said: string;
}

/**
 * "Fill from a checklist": paste, see what was found, add what is ticked,
 * ask for the rest. Opened with the list kept on the collection, or with
 * one typed as the collection was made.
 */
export function ChecklistSheet(props: {
  collection: CollectionView;
  types: readonly DocumentTypeView[];
  members: readonly Member[];
  role: Role | null;
  /** The list kept on it, matched; null for none yet. */
  kept: CollectionChecklist | null;
  /** A list typed as the collection was made: read at once. */
  text?: string | null;
  returnFocus: RefObject<HTMLElement | null>;
  onClose: () => void;
  onDone: (done: ChecklistDone) => void;
}) {
  const { withToken } = useApp();
  const navigate = useNavigate();
  const [text, setText] = useState(props.text ?? '');
  const [read, setRead] = useState<CollectionChecklist | null>(
    props.kept?.saved_at ? props.kept : null,
  );
  /** Ticks the person changed, by document: over what the vault ticked. */
  const [ticks, setTicks] = useState<Map<string, boolean>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The lines opened to change: kept open while they are changed. */
  const [editing, setEditing] = useState<Set<number>>(new Set());
  const [confirming, setConfirming] = useState(false);
  /** Asking for the missing ones: the title and lines its sender will see. */
  const [asking, setAsking] = useState<{ title: string; lines: string[] } | null>(null);
  const reviewHead = useRef<HTMLHeadingElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const askHead = useRef<HTMLHeadingElement>(null);
  const name = props.collection.name;
  const shared = props.collection.shared_outside ?? null;
  const mayAsk = props.role !== null && can(props.role, 'upload_request.create');
  const people = props.role === 'teen' ? props.members.filter((m) => m.is_me) : props.members;

  /** The vault's answer, with what went wrong said in words. */
  const ask = async <T,>(
    what: string,
    fn: (t: string) => Promise<T>,
  ): Promise<{ value: T | null } | null> => {
    setBusy(what);
    setError(null);
    try {
      return { value: await withToken(fn) };
    } catch (err) {
      setError(
        err instanceof ApiRequestError && err.code === 'checklist_unavailable'
          ? err.message
          : describeError(err),
      );
      return null;
    } finally {
      setBusy(null);
    }
  };

  const readList = async (words: string) => {
    if (!words.trim()) {
      setError('Paste or type the list first: one thing a line.');
      return;
    }
    const answer = (
      await ask('Reading the list…', (t) =>
        api.checkChecklist(t, props.collection.id, { text: words }),
      )
    )?.value;
    if (!answer) return;
    flushSync(() => {
      setRead(answer);
      setTicks(new Map());
      setEditing(new Set());
    });
    reviewHead.current?.focus();
  };

  // A list typed as the collection was made is read as the sheet opens.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (props.text?.trim()) void readList(props.text);
    // Only as it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * An item changed by the person: matched again, nothing kept yet. Its
   * line stays open, and its controls stay where the focus is.
   */
  const change = async (n: number, edit: Partial<ChecklistItem>) => {
    if (!read) return;
    setEditing((e) => new Set(e).add(n));
    const items = read.items.map((i, k) => sentItem(k === n ? { ...i, ...edit } : i));
    const answer = (
      await ask('Looking again…', (t) => api.checkChecklist(t, props.collection.id, { items }))
    )?.value;
    if (answer) setRead(answer);
  };

  const ticked = (m: ChecklistMatch) =>
    m.in_collection ? false : (ticks.get(m.document_id) ?? m.ticked);
  const chosen = read
    ? [
        ...new Set(
          read.items
            .filter((i) => !i.skipped && i.understood)
            .flatMap((i) => i.matches.filter(ticked).map((m) => m.document_id)),
        ),
      ]
    : [];

  /**
   * The list kept on the collection, as it now stands — its lines and what
   * each asks for, never what was found — and only when it has changed.
   */
  const keep = async (t: string): Promise<void> => {
    const items = (read?.items ?? []).map(sentItem);
    if (props.kept?.saved_at && keptOf(props.kept.items) === keptOf(items)) return;
    await api.saveChecklist(t, props.collection.id, items);
  };

  const addAll = async () => {
    if (!read) return;
    const answer = await ask('Adding…', async (t) => {
      await keep(t);
      // In calls of ADD_AT_ONCE, what each did gathered.
      const all: Omit<ChecklistAdded, 'collection'> = { added: [], skipped: [], warnings: [] };
      for (let i = 0; i < chosen.length; i += ADD_AT_ONCE) {
        const one = await api.addFromChecklist(
          t,
          props.collection.id,
          chosen.slice(i, i + ADD_AT_ONCE),
        );
        all.added.push(...one.added);
        all.skipped.push(...one.skipped);
        for (const w of one.warnings) if (!all.warnings.includes(w)) all.warnings.push(w);
      }
      return all;
    });
    setConfirming(false);
    if (!answer) return;
    const done = answer.value;
    const added = done?.added.length ?? 0;
    const skipped = done?.skipped ?? [];
    const why = [...new Set(skipped.map((s) => checklistSkipWords(s.why)))];
    const said = [
      added > 0 ? `${documentsWord(added)} added to “${name}”.` : `Nothing was added to “${name}”.`,
      skipped.length > 0 ? `${documentsWord(skipped.length)} skipped: ${why.join('; ')}.` : '',
      'The checklist is kept on the collection.',
      ...(done?.warnings ?? []),
    ]
      .filter(Boolean)
      .join(' ');
    props.onDone({ said });
  };

  /** Shared outside the family: said, and asked, before anything goes in (5.19). */
  const askToAdd = () => {
    if (shared && chosen.length > 0) setConfirming(true);
    else void addAll();
  };

  const keepOnly = async () => {
    const kept = await ask('Keeping the list…', async (t) => {
      await keep(t);
      return true;
    });
    if (kept?.value) {
      props.onDone({ said: `The checklist is kept on “${name}”. Nothing was added.` });
    }
  };

  /** What the sender will see: a title naming no collection, and the lines, each to change. */
  const startAsking = () => {
    if (!read) return;
    flushSync(() =>
      setAsking({
        title: 'Documents we need',
        lines: read.missing
          .slice(0, UPLOAD_REQUEST_ITEMS_MAX)
          .map((m) => [...m].slice(0, UPLOAD_REQUEST_ITEM_LABEL_MAX).join('')),
      }),
    );
    askHead.current?.focus();
  };

  const continueAsking = async () => {
    if (!asking) return;
    const kept = await ask('Keeping the list…', async (t) => {
      await keep(t);
      return true;
    });
    if (!kept?.value) return;
    void navigate('/sharing/ask', {
      state: {
        ask: {
          title: asking.title.trim() || 'Documents we need',
          items: asking.lines.map((l) => l.trim()).filter(Boolean),
          back: `/collections/${props.collection.id}`,
        },
      },
    });
  };

  // Nor a note: written, never a paper asked for (the N1 review).
  const kinds = props.types.filter((t) => !t.hidden && t.key !== 'other' && t.key !== NOTE_KIND);
  return (
    <Sheet
      label={`Fill “${name}” from a checklist`}
      busy={busy !== null}
      returnFocus={props.returnFocus}
      onClose={props.onClose}
      className="card picker checklist-sheet"
    >
      <h2 className="picker-h">Fill “{name}” from a checklist</h2>
      {shared && (
        <p className="status status-warn picker-shared">{sharedOutsideWords(shared, props.role)}</p>
      )}
      <p className="muted">{checklistReadersWords(props.collection.audience)}</p>
      <div className="stack">
        <TextArea
          id="checklist-text"
          label="The list"
          value={text}
          maxLength={CHECKLIST_TEXT_MAX}
          hint="One thing a line. A heading such as “Documents for Mansoor” starts that person’s part; a line before any heading is anyone’s."
          onChange={setText}
        />
        <div className="row">
          <Button
            kind={read ? 'quiet' : 'primary'}
            disabled={busy !== null}
            onClick={() => void readList(text)}
          >
            {read ? 'Read it again' : 'Read the list'}
          </Button>
        </div>
      </div>
      <p className="muted status-line" role="status">
        {busy ?? ''}
      </p>
      <ErrorNote message={error} />
      {asking ? (
        <div className="picker-results stack checklist-ask">
          <h3 ref={askHead} tabIndex={-1} className="section-h">
            What they will see
          </h3>
          <p className="muted">
            Whoever you send the link to sees this title and these lines, and nothing else in the
            vault. Change any name you would rather they did not see.
          </p>
          <Field
            id="checklist-ask-title"
            label="Title"
            value={asking.title}
            maxLength={UPLOAD_REQUEST_TITLE_MAX}
            required={false}
            onChange={(v) => setAsking((a) => (a ? { ...a, title: v } : a))}
          />
          {asking.lines.map((l, k) => (
            <Field
              key={k}
              id={`checklist-ask-${k}`}
              label={`What to send, ${k + 1}`}
              value={l}
              maxLength={UPLOAD_REQUEST_ITEM_LABEL_MAX}
              required={false}
              onChange={(v) =>
                setAsking((a) =>
                  a ? { ...a, lines: a.lines.map((x, j) => (j === k ? v : x)) } : a,
                )
              }
            />
          ))}
        </div>
      ) : (
        read && (
          <div className="picker-results checklist-review">
            <h3 ref={reviewHead} tabIndex={-1} className="section-h">
              What it found
            </h3>
            {read.left_out > 0 && (
              <p className="muted">
                {read.left_out === 1
                  ? 'One line or item was'
                  : `${read.left_out} lines or items were`}{' '}
                left out: a checklist reads {CHECKLIST_LINES_MAX} lines and keeps{' '}
                {CHECKLIST_ITEMS_MAX} items at most.
              </p>
            )}
            {read.items.length === 0 && <p className="muted">The list has no lines yet.</p>}
            <ol className="checklist-items">
              {read.items.map((item, n) => (
                <ChecklistRow
                  key={n}
                  n={n}
                  item={item}
                  kinds={kinds}
                  people={people}
                  members={props.members}
                  editing={editing.has(n) || (!item.understood && !item.skipped)}
                  ticked={ticked}
                  onTick={(id, on) => setTicks((t) => new Map(t).set(id, on))}
                  onEdit={() => setEditing((e) => new Set(e).add(n))}
                  onChange={(edit) => void change(n, edit)}
                />
              ))}
            </ol>
          </div>
        )
      )}
      <div className="picker-foot checklist-foot">
        {asking ? (
          <>
            <Button disabled={busy !== null} onClick={() => void continueAsking()}>
              Continue to Ask for documents
            </Button>
            <Button kind="quiet" disabled={busy !== null} onClick={() => setAsking(null)}>
              Back to the list
            </Button>
          </>
        ) : (
          <>
            {read && (
              <Button ref={addButton} disabled={busy !== null} onClick={askToAdd}>
                {chosen.length > 0 ? `Add all found (${chosen.length})` : 'Keep the list'}
              </Button>
            )}
            {read && chosen.length > 0 && (
              <Button kind="quiet" disabled={busy !== null} onClick={() => void keepOnly()}>
                Keep the list without adding
              </Button>
            )}
            {read && mayAsk && read.missing.length > 0 && (
              <Button kind="quiet" disabled={busy !== null} onClick={startAsking}>
                Ask for the missing ones
              </Button>
            )}
          </>
        )}
        <Button kind="quiet" disabled={busy !== null} onClick={props.onClose}>
          Cancel
        </Button>
      </div>
      {confirming && shared && (
        <ConfirmDialog
          title={`Add ${documentsWord(chosen.length)} to “${name}”?`}
          confirmLabel={`Add ${documentsWord(chosen.length)}`}
          busyLabel="Adding…"
          busy={busy !== null}
          returnFocus={addButton}
          onConfirm={() => void addAll()}
          onCancel={() => setConfirming(false)}
        >
          <p>{sharedOutsideWords(shared, props.role)}</p>
        </ConfirmDialog>
      )}
    </Sheet>
  );
}

/** One line of the list: what was understood, how it stands, and what was found. */
function ChecklistRow(props: {
  n: number;
  item: ChecklistItemCheck;
  kinds: readonly DocumentTypeView[];
  people: readonly Member[];
  members: readonly Member[];
  editing: boolean;
  ticked: (m: ChecklistMatch) => boolean;
  onTick: (documentId: string, on: boolean) => void;
  onEdit: () => void;
  onChange: (edit: Partial<ChecklistItem>) => void;
}) {
  const { item, n } = props;
  const id = `checklist-${n}`;
  const choices =
    item.problem === 'person_shared' && item.person_choices.length > 0
      ? props.people.filter((p) => item.person_choices.includes(p.id))
      : props.people;
  const counts = Array.from({ length: CHECKLIST_COUNT_MAX - 1 }, (_, k) => k + 2);
  const months = Array.from({ length: CHECKLIST_MONTHS_MAX }, (_, k) => k + 1);
  return (
    <li className="checklist-item stack" aria-labelledby={`${id}-what`}>
      <div className="checklist-line">
        <span id={`${id}-what`} className="checklist-what">
          <strong>{item.understood ? item.summary : item.line}</strong>
          {item.understood && <span className="muted"> “{item.line}”</span>}
        </span>
        <span className={tone(item)}>{statusWords(item)}</span>
      </div>
      {item.note && <p className="muted">{item.note}</p>}
      {props.editing ? (
        <div className="row checklist-edit">
          <label className="field">
            <span>Kind</span>
            <select
              value={item.type_key ?? ''}
              onChange={(e) => props.onChange({ type_key: e.target.value || null })}
            >
              <option value="">Choose a kind</option>
              {props.kinds.map((k) => (
                <option key={k.key} value={k.key}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Whose</span>
            <select
              value={item.member_id ?? (item.problem?.startsWith('person') ? '' : 'anyone')}
              onChange={(e) =>
                props.onChange(
                  e.target.value === 'anyone'
                    ? { member_id: null, unresolved: null }
                    : { member_id: e.target.value || null, unresolved: null },
                )
              }
            >
              {item.problem?.startsWith('person') && <option value="">Choose who</option>}
              <option value="anyone">Anyone’s</option>
              {choices.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>How many</span>
            <select
              value={howMany(item)}
              onChange={(e) => {
                const [what, k] = e.target.value.split(':');
                const nth = k ? Number(k) : null;
                props.onChange({
                  count: what === 'n' ? nth : null,
                  months: what === 'm' ? nth : null,
                  within: null,
                  in_months: [],
                });
              }}
            >
              <option value="">
                {item.years.length > 0 ? 'One for each year' : 'The most recent'}
              </option>
              {counts.map((c) => (
                <option key={`n${c}`} value={`n:${c}`}>
                  {`The last ${c}`}
                </option>
              ))}
              {months.map((m) => (
                <option key={`m${m}`} value={`m:${m}`}>
                  {m === 1 ? 'This month’s' : `Each of the last ${m} months`}
                </option>
              ))}
            </select>
          </label>
          <label className="checklist-skip">
            <input
              type="checkbox"
              checked={item.skipped}
              onChange={(e) => props.onChange({ skipped: e.target.checked })}
            />{' '}
            Skip this line
          </label>
        </div>
      ) : (
        <div className="row">
          <Button kind="link" onClick={props.onEdit} ariaLabel={`Change “${item.line}”`}>
            Change
          </Button>
        </div>
      )}
      {!item.skipped && item.matches.length > 0 && (
        <ul className="checklist-matches" aria-label={`Found for “${item.line}”`}>
          {item.matches.map((m) => (
            <li key={m.document_id}>
              <label className="checklist-match">
                <input
                  type="checkbox"
                  checked={props.ticked(m)}
                  disabled={m.in_collection}
                  onChange={(e) => props.onTick(m.document_id, e.target.checked)}
                />
                <span>
                  {matchWords(m, props.members)}
                  {m.in_collection && <span className="muted"> · Already in the collection</span>}
                  {!m.chosen && !m.in_collection && <span className="muted"> · Another match</span>}
                  {m.note && <span className="checklist-note">{m.note}</span>}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {!item.skipped && item.missing.length > 0 && (
        <p className="muted">Missing: {item.missing.join('; ')}</p>
      )}
    </li>
  );
}
