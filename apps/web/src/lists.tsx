import {
  can,
  inListAudience,
  LIST_DESCRIPTION_MAX,
  LIST_NAME_MAX,
  type Capabilities,
  type ListAudience,
  type ListView,
  type Role,
} from '@fdv/shared';
import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from './api.js';
import { describeError, useApp, useLoad } from './app-context.js';
import { storedRole } from './session.js';
import { Button, ErrorNote, Field, Pills, TextArea } from './ui.js';

/**
 * Lists of documents on the web (5.15): what the Lists screen, a list's
 * page, a row's ⋯ and the document's page share — who a list is for, in
 * words; the form that makes or changes one; and "Add to a list".
 *
 * Nothing here counts what the reader cannot see. Every number is one the
 * vault gave them (`item_count` is what they can see of a list), and a
 * list they are not given is not there at all.
 */

/** Who a list is for, in the order the picker offers them, each with what it means. */
export const AUDIENCE_CHOICES: ReadonlyArray<{
  value: ListAudience;
  label: string;
  sentence: string;
}> = [
  {
    value: 'everyone',
    label: 'Everyone in the family',
    sentence: 'Owners, adults and teens: everyone in the family who files documents here.',
  },
  {
    value: 'adults',
    label: 'Adults',
    sentence: 'Owners and adults. Teens won’t see it, or know it is here.',
  },
  {
    value: 'teens',
    label: 'Teens and up',
    sentence: 'Owners, adults and teens: anyone from a teen up.',
  },
  {
    value: 'only_me',
    label: 'Only me',
    sentence: 'Only you. Nobody else will see it, or know it is here, not even an owner.',
  },
];

/** Said under every audience: a viewer is in none of them (A17). */
export const VIEWERS_NEED_A_GRANT = 'Viewers see a list only when it is granted to them.';

/** A list never widens who sees a document (5.14). */
export const NEVER_WIDENS =
  'Whoever sees a list sees only the documents on it they could see already.';

export function audienceLabel(audience: string): string {
  return AUDIENCE_CHOICES.find((c) => c.value === audience)?.label ?? 'Some of the family';
}

export function audienceSentence(audience: string): string | null {
  return AUDIENCE_CHOICES.find((c) => c.value === audience)?.sentence ?? null;
}

/** "1 document", "3 documents": a number the vault gave, never one worked out here. */
export function documentsWord(n: number): string {
  return `${n} document${n === 1 ? '' : 's'}`;
}

/**
 * Whether lists are offered at all: the vault has them (`features.lists`),
 * and the reader may make them (`list.manage`: owners, adults and teens).
 * A viewer is offered nothing about lists, and older vaults have none.
 */
export function listsOffered(caps: Capabilities | null, role: Role): boolean {
  return caps?.features.lists === true && can(role, 'list.manage');
}

/**
 * Whether the reader may change a list — its name, who it is for, what is
 * on it: its maker, while they are in its audience (A18). The vault decides
 * regardless; this only decides what is drawn.
 */
export function mayChangeList(role: Role, list: Pick<ListView, 'mine' | 'audience'>): boolean {
  return list.mine && inListAudience(role, list.audience);
}

/**
 * Who a list is for: the four choices as pills — only those the maker is in
 * themselves, as the vault allows — with what the chosen one means, and
 * that a viewer is never in any of them.
 */
export function AudiencePicker(props: {
  value: ListAudience | null;
  role: Role;
  onChange: (audience: ListAudience) => void;
}) {
  const choices = AUDIENCE_CHOICES.filter((c) => inListAudience(props.role, c.value));
  const chosen = choices.find((c) => c.value === props.value);
  return (
    <div className="stack audience">
      <Pills
        label="Who it is for"
        value={props.value}
        options={choices.map((c) => ({ value: c.value, label: c.label }))}
        onChange={props.onChange}
      />
      <div className="muted audience-words">
        {chosen && <p>{chosen.sentence}</p>}
        <p>{VIEWERS_NEED_A_GRANT}</p>
        <p>{NEVER_WIDENS}</p>
      </div>
    </div>
  );
}

export interface ListFields {
  name: string;
  audience: ListAudience;
  /** Undefined where the form does not ask for it (the ⋯'s quick "Make a new list"). */
  description?: string | null;
}

/**
 * Making a list, or changing one: its name, what it is for (on the Lists
 * screen and the list's page) and who it is for. It says what is missing
 * in the vault's own words before it asks the vault anything.
 */
export function ListForm(props: {
  id: string;
  /** The list as it is, when it is being changed. */
  initial?: { name: string; description: string | null; audience: ListAudience };
  withDescription: boolean;
  submitLabel: string;
  busyLabel: string;
  onSubmit: (fields: ListFields) => Promise<void>;
  onCancel: () => void;
}) {
  const role = storedRole();
  const [name, setName] = useState(props.initial?.name ?? '');
  const [description, setDescription] = useState(props.initial?.description ?? '');
  // Nothing is chosen for a new list: who may know a list is there is the
  // maker's decision, never a default they did not notice.
  const [audience, setAudience] = useState<ListAudience | null>(props.initial?.audience ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; field: 'name' | 'audience' | null } | null>(
    null,
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!name.trim()) {
      setError({ message: 'Give the list a name.', field: 'name' });
      return;
    }
    if (!audience) {
      setError({ message: 'Say who the list is for.', field: 'audience' });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await props.onSubmit({
        name,
        audience,
        ...(props.withDescription ? { description: description.trim() || null } : {}),
      });
    } catch (err) {
      setError({ message: describeError(err), field: null });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card stack" onSubmit={(e) => void submit(e)} noValidate>
      <Field
        id={`${props.id}-name`}
        label="Name"
        value={name}
        required={false}
        requiredMark
        invalid={error?.field === 'name'}
        maxLength={LIST_NAME_MAX}
        placeholder="For the mortgage broker"
        onChange={setName}
      />
      {props.withDescription && (
        <TextArea
          id={`${props.id}-about`}
          label="What it is for"
          value={description}
          maxLength={LIST_DESCRIPTION_MAX}
          hint="Optional. A few words for whoever opens it."
          onChange={setDescription}
        />
      )}
      <AudiencePicker value={audience} role={role} onChange={setAudience} />
      <ErrorNote message={error?.message ?? null} />
      <div className="row">
        <Button type="submit" disabled={busy}>
          {busy ? props.busyLabel : props.submitLabel}
        </Button>
        <Button kind="quiet" disabled={busy} onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * "Add to a list" (5.15), in a sheet over the page: one document from its
 * row's ⋯ or its own page, or several chosen in search. It offers the
 * lists the reader may put things on — those they made, for an audience
 * they are in — and a new one. Several go on all at once or not at all:
 * one that has gone meanwhile is refused with the rest, and nothing is on.
 */
export function AddToList(props: {
  documentIds: string[];
  /** What is being added, as the sentences say it: “Passport”, or 3 documents. */
  what: string;
  onClose: () => void;
  /** Something is on its way: the sheet stays open until it is done. */
  onBusy: (busy: boolean) => void;
  /** Something was put on a list: what the sheet said about it. */
  onAdded?: (said: string) => void;
}) {
  const { withToken } = useApp();
  const role = storedRole();
  const one = props.documentIds.length === 1 ? (props.documentIds[0] ?? null) : null;
  const {
    data,
    error: loadError,
    setData,
  } = useLoad(
    async (t) => {
      const [all, onIt] = await Promise.all([
        api.lists(t),
        one ? api.documentLists(t, one) : Promise.resolve(null),
      ]);
      return { lists: all.items, on: (onIt?.items ?? []).map((l) => l.id) };
    },
    [props.documentIds.join(',')],
  );
  const [adding, setAdding] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const newList = useRef<HTMLButtonElement>(null);

  const mine = (data?.lists ?? []).filter((l) => mayChangeList(role, l));
  const on = new Set(data?.on ?? []);

  const working = (list: string | null) => {
    setAdding(list);
    props.onBusy(list !== null);
  };

  const add = async (list: ListView) => {
    if (adding) return;
    working(list.id);
    setError(null);
    setNote(null);
    try {
      const after = await withToken((t) => api.addToList(t, list.id, props.documentIds));
      if (!after) return;
      setData((d) =>
        d
          ? {
              lists: d.lists.map((l) =>
                l.id === after.id ? { ...l, item_count: after.item_count } : l,
              ),
              on: [...d.on, after.id],
            }
          : d,
      );
      const said = one
        ? `${props.what} is on “${after.name}” now.`
        : `${props.what} added to “${after.name}”.`;
      setNote(said);
      props.onAdded?.(said);
      // Its Add button goes: the news has the focus, so it is heard.
      status.current?.focus();
    } catch (err) {
      setError(describeError(err));
    } finally {
      working(null);
    }
  };

  const make = async (fields: ListFields) => {
    props.onBusy(true);
    let made: ListView | null;
    try {
      made = await withToken((t) =>
        api.createList(t, { name: fields.name, audience: fields.audience }),
      );
    } finally {
      props.onBusy(false);
    }
    if (!made) return;
    setMaking(false);
    setData((d) => (d ? { ...d, lists: [...d.lists, made] } : d));
    // Made, then put on: should that be refused, the list is there to try again.
    await add(made);
  };

  const titleId = `add-to-list-h`;
  return (
    <div className="card stack">
      <h2 id={titleId} style={{ fontSize: 20 }}>
        Add {props.what} to a list
      </h2>
      <p ref={status} className="notice status-line" role="status" tabIndex={-1}>
        {note}
      </p>
      <ErrorNote message={error ?? loadError} />
      {data === null && !loadError && (
        <p className="muted" role="status">
          Finding your lists…
        </p>
      )}
      {data !== null && mine.length === 0 && (
        <p className="muted">
          You haven’t made a list yet. Only the person who made a list can put documents on it.
        </p>
      )}
      {mine.length > 0 && (
        <ul className="list" aria-labelledby={titleId}>
          {mine.map((l) => (
            <li key={l.id}>
              <span>
                <strong>{l.name}</strong>
                <span className="muted">
                  {audienceLabel(l.audience)} · {documentsWord(l.item_count)}
                </span>
              </span>
              {on.has(l.id) ? (
                <span className="muted">
                  <span aria-hidden="true">✓ </span>
                  {one ? 'On this list' : 'Added'}
                </span>
              ) : (
                <Button
                  kind="quiet"
                  ariaLabel={`Add to “${l.name}”`}
                  disabled={adding !== null}
                  onClick={() => void add(l)}
                >
                  {adding === l.id ? 'Adding…' : 'Add'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {making ? (
        <ListForm
          id="add-new-list"
          withDescription={false}
          submitLabel="Make it and add"
          busyLabel="Making the list…"
          onSubmit={make}
          onCancel={() => {
            setMaking(false);
            // The form goes, and its Cancel with it: back to what opened it.
            requestAnimationFrame(() => newList.current?.focus());
          }}
        />
      ) : (
        data !== null && (
          <button
            ref={newList}
            type="button"
            className="btn btn-quiet"
            disabled={adding !== null}
            onClick={() => setMaking(true)}
          >
            Make a new list
          </button>
        )
      )}
      <div className="row">
        <Button kind="quiet" disabled={adding !== null} onClick={props.onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}

/**
 * The family's lists on Home (5.15), the way to the Lists screen: the
 * first few as tiles, each with how many of its documents the reader can
 * see, as the vault counts them.
 */
export function ListsOnHome() {
  const { authVersion } = useApp();
  const { data } = useLoad(async (t) => (await api.lists(t)).items, [authVersion]);
  if (data === null) return null;
  return (
    <section aria-labelledby="lists-h">
      <h2 id="lists-h" className="section-h">
        Lists
      </h2>
      <div className="tiles">
        {data.slice(0, 4).map((l) => (
          <Link key={l.id} to={`/lists/${l.id}`} className="tile">
            <span className="tile-title">{l.name}</span>
            <span className="muted">{documentsWord(l.item_count)}</span>
          </Link>
        ))}
        {data.length === 0 && (
          <Link to="/lists" className="tile tile-missing">
            <span className="tile-title">Make a list</span>
            <span className="muted">Gather papers for a purpose: a trip, a mortgage, a move.</span>
            <span className="tile-cue">Start one</span>
          </Link>
        )}
      </div>
      {data.length > 0 && (
        <Link to="/lists" className="seeall">
          All lists
        </Link>
      )}
    </section>
  );
}
