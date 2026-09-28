import {
  can,
  COLLECTION_DESCRIPTION_MAX,
  COLLECTION_NAME_MAX,
  inCollectionAudience,
  sharedOutsideWords,
  type Capabilities,
  type CollectionAudience,
  type CollectionView,
  type Role,
} from '@fdv/shared';
import { useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { Link } from 'react-router';
import { api, ApiRequestError } from './api.js';
import { describeError, useApp, useLoad } from './app-context.js';
import { storedRole } from './session.js';
import { Button, ErrorNote, Field, Pills, TextArea } from './ui.js';

/**
 * Collections of documents on the web (5.15): what the Collections screen, a collection's
 * page, a row's ⋯ and the document's page share — who a collection is for, in
 * words; the form that makes or changes one; and "Add to a collection".
 *
 * Nothing here counts what the reader cannot see. Every number is one the
 * vault gave them (`item_count` is what they can see of a collection), and a
 * collection they are not given is not there at all.
 */

/** Who a collection is for, in the order the picker offers them, each with what it means. */
export const AUDIENCE_CHOICES: ReadonlyArray<{
  value: CollectionAudience;
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
    // The same people as Everyone: what tells them apart is that only an
    // Everyone collection may ever be granted to a viewer (A17, 5.33).
    sentence:
      'The same people as Everyone in the family: owners, adults and teens. Unlike Everyone, it can never be granted to a viewer.',
  },
  {
    value: 'only_me',
    label: 'Only me',
    sentence: 'Only you. Nobody else will see it, or know it is here, not even an owner.',
  },
];

/**
 * Said under Everyone in the family alone: no viewer is in any audience,
 * and only an Everyone collection may be granted to one (A17, 5.33).
 */
export const VIEWERS_NEED_A_GRANT = 'Viewers see a collection only when it is granted to them.';

/** A collection never widens who sees a document (5.14). */
export const NEVER_WIDENS =
  'Whoever sees a collection sees only the documents in it they could see already.';

export function audienceLabel(audience: string): string {
  return AUDIENCE_CHOICES.find((c) => c.value === audience)?.label ?? 'Some of the family';
}

/** What an audience means, and for Everyone in the family, that a viewer needs a grant. */
export function audienceSentence(audience: string): string | null {
  const sentence = AUDIENCE_CHOICES.find((c) => c.value === audience)?.sentence ?? null;
  return sentence && audience === 'everyone' ? `${sentence} ${VIEWERS_NEED_A_GRANT}` : sentence;
}

/** "1 document", "3 documents": a number the vault gave, never one worked out here. */
export function documentsWord(n: number): string {
  return `${n} document${n === 1 ? '' : 's'}`;
}

/**
 * Whether collections are offered at all: the vault has them (`features.collections`),
 * and the reader may make them (`collection.manage`: owners, adults and teens).
 * A viewer is offered nothing about collections, and older vaults have none.
 */
export function collectionsOffered(caps: Capabilities | null, role: Role): boolean {
  return caps?.features.collections === true && can(role, 'collection.manage');
}

/**
 * Whether the reader may change a collection — its name, who it is for, what is
 * in it: its maker, while they are in its audience (A18). The vault decides
 * regardless; this only decides what is drawn.
 */
export function mayChangeCollection(
  role: Role,
  collection: Pick<CollectionView, 'mine' | 'audience'>,
): boolean {
  return collection.mine && inCollectionAudience(role, collection.audience);
}

/**
 * Who a collection is for: the four choices as pills — only those the maker is in
 * themselves, as the vault allows — with what the chosen one means. It is
 * asked for, never assumed, so it is marked as the name is.
 */
export function AudiencePicker(props: {
  value: CollectionAudience | null;
  role: Role;
  onChange: (audience: CollectionAudience) => void;
}) {
  const choices = AUDIENCE_CHOICES.filter((c) => inCollectionAudience(props.role, c.value));
  const chosen = choices.find((c) => c.value === props.value);
  return (
    <div className="stack audience">
      <Pills
        label="Who it is for"
        requiredMark
        value={props.value}
        options={choices.map((c) => ({ value: c.value, label: c.label }))}
        onChange={props.onChange}
      />
      <div className="muted audience-words">
        {chosen && <p>{chosen.sentence}</p>}
        {chosen?.value === 'everyone' && <p>{VIEWERS_NEED_A_GRANT}</p>}
        <p>{NEVER_WIDENS}</p>
      </div>
    </div>
  );
}

export interface CollectionFields {
  name: string;
  audience: CollectionAudience;
  /** Undefined where the form does not ask for it (the ⋯'s quick "Make a new collection"). */
  description?: string | null;
}

/**
 * Making a collection, or changing one: its name, what it is for (on the Collections
 * screen and the collection's page) and who it is for. It says what is missing
 * in the vault's own words before it asks the vault anything.
 */
export function CollectionForm(props: {
  id: string;
  /** The collection as it is, when it is being changed. */
  initial?: { name: string; description: string | null; audience: CollectionAudience };
  withDescription: boolean;
  submitLabel: string;
  busyLabel: string;
  onSubmit: (fields: CollectionFields) => Promise<void>;
  onCancel: () => void;
}) {
  const role = storedRole();
  const [name, setName] = useState(props.initial?.name ?? '');
  const [description, setDescription] = useState(props.initial?.description ?? '');
  // Nothing is chosen for a new collection: who may know a collection is there is the
  // maker's decision, never a default they did not notice.
  const [audience, setAudience] = useState<CollectionAudience | null>(
    props.initial?.audience ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; field: 'name' | 'audience' | null } | null>(
    null,
  );
  const form = useRef<HTMLFormElement>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!name.trim()) {
      setError({ message: 'Give the collection a name.', field: 'name' });
      return;
    }
    if (!audience) {
      setError({ message: 'Say who the collection is for.', field: 'audience' });
      // Where the answer is given: the first of the choices.
      form.current?.querySelector<HTMLButtonElement>('.audience .pill')?.focus();
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
    <form ref={form} className="card stack" onSubmit={(e) => void submit(e)} noValidate>
      <Field
        id={`${props.id}-name`}
        label="Name"
        value={name}
        required={false}
        requiredMark
        invalid={error?.field === 'name'}
        maxLength={COLLECTION_NAME_MAX}
        placeholder="For the mortgage broker"
        onChange={setName}
      />
      {props.withDescription && (
        <TextArea
          id={`${props.id}-about`}
          label="What it is for"
          value={description}
          maxLength={COLLECTION_DESCRIPTION_MAX}
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
 * "Add to a collection" (5.15), in a sheet over the page: one document from its
 * row's ⋯ or its own page, or several chosen in search. It offers the
 * collections the reader may put things in — those they made, for an audience
 * they are in — and a new one. Several go in all at once or not at all:
 * one that has gone meanwhile is refused with the rest, and nothing goes in.
 */
export function AddToCollection(props: {
  documentIds: string[];
  /** What is being added, as the sentences say it: “Passport”, or 3 documents. */
  what: string;
  onClose: () => void;
  /** Something is on its way: the sheet stays open until it is done. */
  onBusy: (busy: boolean) => void;
  /** Something was put in a collection: what the sheet said about it. */
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
        api.collections(t),
        one ? api.documentCollections(t, one) : Promise.resolve(null),
      ]);
      return { collections: all.items, on: (onIt?.items ?? []).map((l) => l.id) };
    },
    [props.documentIds.join(',')],
  );
  const [adding, setAdding] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const newCollection = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);

  const mine = (data?.collections ?? []).filter((l) => mayChangeCollection(role, l));
  // Collections the reader made, for people they are no longer one of (A18).
  const outgrown = (data?.collections ?? []).filter((l) => l.mine).length;
  const on = new Set(data?.on ?? []);

  const working = (collection: string | null) => {
    setAdding(collection);
    props.onBusy(collection !== null);
  };

  /**
   * What a refusal means, in words. Several go in together or not at all,
   * so a refusal of several says none went in. A collection that is not there
   * any more leaves the sheet: the reader's collections as they are now say
   * whether it was the collection that had gone, or a document.
   */
  const refusal = async (collection: CollectionView, err: unknown): Promise<string> => {
    if (!(err instanceof ApiRequestError)) return describeError(err);
    if (err.status === 404) {
      const now = await withToken((t) => api.collections(t)).catch(() => null);
      if (now) setData((d) => (d ? { ...d, collections: now.items } : d));
      if (now && !now.items.some((l) => l.id === collection.id)) {
        return `“${collection.name}” is not there any more, so nothing went into it.`;
      }
    }
    if (one || (err.status !== 404 && err.status !== 403)) return describeError(err);
    const none = `None of the ${props.documentIds.length} went into “${collection.name}”`;
    return err.status === 404
      ? `${none}: one of them is no longer in the vault, or no longer yours to see.`
      : `${none}. ${err.message}`;
  };

  /**
   * Where the focus goes after a refusal: never out of the sheet. It stays
   * on the Add button that was pressed, or goes back to it (switched off
   * while it was asked, it let go of the focus); when its collection has gone,
   * and the button with it, to the next collection's, or the one before, or to
   * Make a new collection — as a row that leaves its collection gives it to the next.
   */
  const refocus = (pressed: string, order: string[]) => {
    const box = card.current;
    if (!box || box.contains(document.activeElement)) return;
    const buttons = new Map(
      [...box.querySelectorAll<HTMLElement>('li[data-collection]')].map((li) => [
        li.dataset.collection,
        li.querySelector('button'),
      ]),
    );
    const at = order.indexOf(pressed);
    const near = [pressed, ...order.slice(at + 1), ...order.slice(0, Math.max(at, 0)).reverse()];
    (near.map((id) => buttons.get(id)).find((b) => b) ?? newCollection.current)?.focus();
  };

  const add = async (collection: CollectionView) => {
    if (adding) return;
    const order = mine.map((l) => l.id);
    working(collection.id);
    setError(null);
    setNote(null);
    try {
      const after = await withToken((t) =>
        api.addToCollection(t, collection.id, props.documentIds),
      );
      if (!after) return;
      setData((d) =>
        d
          ? {
              collections: d.collections.map((l) =>
                l.id === after.id ? { ...l, item_count: after.item_count } : l,
              ),
              on: [...d.on, after.id],
            }
          : d,
      );
      const said = one
        ? `${props.what} is in “${after.name}” now.`
        : `${props.what} added to “${after.name}”.`;
      setNote(said);
      props.onAdded?.(said);
      // Its Add button goes: the news has the focus, so it is heard.
      status.current?.focus();
    } catch (err) {
      const said = await refusal(collection, err);
      // Drawn at once, with the buttons back on, so one can take the focus.
      flushSync(() => {
        setError(said);
        working(null);
      });
      refocus(collection.id, order);
    } finally {
      working(null);
    }
  };

  const make = async (fields: CollectionFields) => {
    props.onBusy(true);
    let made: CollectionView | null;
    try {
      made = await withToken((t) =>
        api.createCollection(t, { name: fields.name, audience: fields.audience }),
      );
    } finally {
      props.onBusy(false);
    }
    if (!made) return;
    setMaking(false);
    setData((d) => (d ? { ...d, collections: [...d.collections, made] } : d));
    // Made, then put in: should that be refused, the collection is there to try again.
    await add(made);
  };

  const titleId = `add-to-collection-h`;
  return (
    <div ref={card} className="card stack">
      <h2 id={titleId} style={{ fontSize: 20 }}>
        Add {props.what} to a collection
      </h2>
      <p ref={status} className="notice status-line" role="status" tabIndex={-1}>
        {note}
      </p>
      <ErrorNote message={error ?? loadError} />
      {data === null && !loadError && (
        <p className="muted" role="status">
          Finding your collections…
        </p>
      )}
      {data !== null && mine.length === 0 && (
        <p className="muted">
          {outgrown === 1
            ? 'The collection you made is for people you are no longer one of: you can still delete it, but not put documents in it.'
            : outgrown > 1
              ? 'The collections you made are for people you are no longer one of: you can still delete them, but not put documents in them.'
              : 'You haven’t made a collection yet. Only the person who made a collection can put documents in it.'}
        </p>
      )}
      {mine.length > 0 && (
        <ul className="list" aria-labelledby={titleId}>
          {mine.map((l) => (
            <li key={l.id} data-collection={l.id}>
              <span>
                <strong>{l.name}</strong>
                <span className="muted">
                  {audienceLabel(l.audience)} · {documentsWord(l.item_count)}
                </span>
                {/* Shared outside the family (5.19): said before anything goes
                    in, and heard with its Add button (W519-3). */}
                {l.shared_outside && (
                  <span id={`add-shared-${l.id}`} className="status status-warn">
                    {sharedOutsideWords(l.shared_outside, role)}
                  </span>
                )}
              </span>
              {on.has(l.id) ? (
                <span className="muted">
                  <span aria-hidden="true">✓ </span>
                  {one ? 'In this collection' : 'Added'}
                </span>
              ) : (
                <Button
                  kind="quiet"
                  ariaLabel={`Add to “${l.name}”`}
                  {...(l.shared_outside ? { describedBy: `add-shared-${l.id}` } : {})}
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
        <CollectionForm
          id="add-new-collection"
          withDescription={false}
          submitLabel="Make it and add"
          busyLabel="Making the collection…"
          onSubmit={make}
          onCancel={() => {
            setMaking(false);
            // The form goes, and its Cancel with it: back to what opened it.
            requestAnimationFrame(() => newCollection.current?.focus());
          }}
        />
      ) : (
        data !== null && (
          <button
            ref={newCollection}
            type="button"
            className="btn btn-quiet"
            disabled={adding !== null}
            onClick={() => setMaking(true)}
          >
            Make a new collection
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
 * The family's collections on Home (5.15), the way to the Collections screen: the
 * first few as tiles, each with how many of its documents the reader can
 * see, as the vault counts them. The way there is always drawn — while
 * they load, and when they cannot be loaded — and the tiles fill in when
 * they come. `version` goes up when something on Home may have changed
 * what is in a collection (a row's ⋯), and they are counted again. `quiet`:
 * Home has said already that the vault cannot be reached, and once is
 * enough — a screen reader would read the same alert twice.
 */
export function CollectionsOnHome(props: { version: number; quiet: boolean }) {
  const { authVersion } = useApp();
  const { data, error } = useLoad(
    async (t) => (await api.collections(t)).items,
    [authVersion, props.version],
  );
  const none = data !== null && data.length === 0;
  return (
    <section aria-labelledby="collections-h">
      <h2 id="collections-h" className="section-h">
        Collections
      </h2>
      <ErrorNote message={props.quiet ? null : error} />
      {data !== null && (
        <div className="tiles">
          {data.slice(0, 4).map((l) => (
            <Link key={l.id} to={`/collections/${l.id}`} className="tile">
              <span className="tile-title">{l.name}</span>
              <span className="muted">{documentsWord(l.item_count)}</span>
            </Link>
          ))}
          {none && (
            <Link to="/collections" className="tile tile-missing">
              <span className="tile-title">Make a collection</span>
              <span className="muted">
                Gather papers for a purpose: a trip, a mortgage, a move.
              </span>
              <span className="tile-cue">Start one</span>
            </Link>
          )}
        </div>
      )}
      {!none && (
        <Link to="/collections" className="seeall">
          All collections
        </Link>
      )}
    </section>
  );
}
