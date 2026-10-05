import {
  namedAllGone,
  zonedParts,
  zonedTime,
  type AccessGrant,
  type AccessPreview,
  type CollectionView,
  type DocumentTypeView,
  type MemberAccess,
} from '@fdv/shared';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from 'react';
import { flushSync } from 'react-dom';
import { api, ApiRequestError, type Member } from './api.js';
import { describeError, useApp, useLoad } from './app-context.js';
import { Button, Check, ConfirmDialog, ErrorNote } from './ui.js';

/**
 * Limiting what a viewer can see (5.33, D6, A56–A59): the pickers an owner
 * changes a viewer's limits with, and an adult or an owner an invitation's;
 * the count of what the limits give, asked of the vault as they change; and
 * the "What they can see" part of a viewer's account card.
 *
 * The vault keeps the rule (0054): whose documents and of which kinds,
 * together; a collection for Everyone, separately; their own always. Here
 * only says it, and asks the vault to count — never counts itself.
 */

/** Limits being chosen: an `AccessGrant`. */
export type Limits = AccessGrant;

export const NO_LIMITS: Limits = {
  people: [],
  types: [],
  collections: [],
  include_adults_only: false,
  include_no_person_docs: false,
  expires_at: null,
  limits_people: false,
  limits_types: false,
};

/**
 * The limits as a viewer's card holds them, to change or keep: the flags
 * too, so that a person or a kind named and deleted since still limits
 * when they are sent back, and nothing widens by being kept (R532-01, the
 * 5.33 review).
 */
export const limitsOf = (a: MemberAccess): Limits => ({
  people: a.people,
  types: a.types,
  collections: a.collections,
  include_adults_only: a.include_adults_only,
  include_no_person_docs: a.include_no_person_docs,
  expires_at: a.expires_at,
  limits_people: a.limits_people,
  limits_types: a.limits_types,
});

/** Said when every kind, or every person, the limits named has been deleted since. */
export const KINDS_GONE =
  'Every kind these limits named has been deleted. They stay limited to those kinds, so they give nothing by person or kind until you choose others.';
export const PEOPLE_GONE =
  'Everyone these limits named has been removed. They stay limited to those people, so they give none of anybody’s documents by person until you choose others.';

/** "14 documents" */
const documentsWord = (n: number) => `${n} document${n === 1 ? '' : 's'}`;

/** What the count says: what they will see, and their own Only me ones. */
export function previewWords(p: AccessPreview): string {
  const own = p.keeps_private ? ', and their own Only me documents' : '';
  return `They will see ${documentsWord(p.documents)}${own}.`;
}

/**
 * The day an end is chosen as, from what the vault keeps: the family's day,
 * on the household's clock, as the vault says it (the 5.33 review,
 * L533-08).
 */
export const dayOf = (iso: string | null, timezone: string) =>
  iso ? zonedParts(new Date(iso), timezone).date : '';
/** The end of that day, on the household's clock: the moment the vault keeps. */
export const endOf = (day: string, timezone: string) =>
  day ? (zonedTime(day, '23:59', timezone)?.toISOString() ?? null) : null;

/**
 * People, kinds of document and collections to give a viewer, and the
 * count of what that gives, asked of the vault a moment after each change.
 * Only a collection for Everyone is offered (A17); Adults only documents
 * only to an owner (D6, A27).
 */
export function LimitsPicker(props: {
  idPrefix: string;
  value: Limits;
  onChange: (v: Limits) => void;
  /** Whose limits: their own documents are always theirs; null for somebody new. */
  memberId: string | null;
  /** An owner may give Adults only documents. */
  owner: boolean;
  /**
   * A guest's (5.34): their sign-in has its own end, so the limits have
   * none of their own to choose.
   */
  endless?: boolean;
}) {
  const { authVersion, withToken, caps } = useApp();
  const hasCollections = caps?.features.collections === true;
  const { data, error } = useLoad(
    async (t) => {
      const [members, types, collections, profile] = await Promise.all([
        api.members(t),
        api.documentTypes(t),
        // A vault from before collections has none to give.
        hasCollections ? api.collections(t) : Promise.resolve({ items: [] as CollectionView[] }),
        // The household's clock, which an end is chosen and said on.
        api.profile(t).catch(() => null),
      ]);
      return {
        members: members.items,
        types: types.items,
        collections: collections.items,
        timezone: profile?.timezone ?? 'UTC',
      };
    },
    [authVersion, hasCollections],
  );
  const timezone = data?.timezone ?? 'UTC';
  const [count, setCount] = useState<AccessPreview | null>(null);
  const [countError, setCountError] = useState<string | null>(null);
  const v = props.value;
  const key = JSON.stringify([props.memberId, v]);
  // Asked of the vault a moment after the last change; an older answer that
  // comes back later is not shown.
  const asked = useRef(0);
  useEffect(() => {
    const mine = ++asked.current;
    const timer = setTimeout(() => {
      void withToken((t) => api.previewAccess(t, props.memberId, v))
        .then((got) => {
          if (mine !== asked.current || !got) return;
          setCount(got);
          setCountError(null);
        })
        .catch((err: unknown) => {
          if (mine === asked.current) setCountError(describeError(err));
        });
    }, 300);
    return () => clearTimeout(timer);
    // The limits, as a string: a new object with the same limits asks nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, withToken]);

  // A choice made here says whether people, or kinds, are named at all: an
  // empty list chosen here is "none chosen" (any), said in so many words.
  const toggle = (list: 'people' | 'types' | 'collections', id: string, on: boolean) => {
    const now = on ? [...v[list], id] : v[list].filter((x) => x !== id);
    props.onChange({
      ...v,
      [list]: now,
      ...(list === 'people' ? { limits_people: now.length > 0 } : {}),
      ...(list === 'types' ? { limits_types: now.length > 0 } : {}),
    });
  };
  const gone = namedAllGone(v);
  // Where focus goes when a "Give … instead" button, pressed, leaves with
  // its warning: the legend of its own set, which stays (the 5.33 second
  // round, N533W-01), never the page itself.
  const peopleLegend = useRef<HTMLLegendElement>(null);
  const kindsLegend = useRef<HTMLLegendElement>(null);
  const giveUp = (change: Partial<Limits>, to: RefObject<HTMLLegendElement | null>) => {
    flushSync(() => props.onChange({ ...v, ...change }));
    to.current?.focus();
  };
  const people = (data?.members ?? []).filter((m: Member) => m.id !== props.memberId);
  // A hidden kind already chosen is shown, so that it can be taken away.
  const kinds = (data?.types ?? []).filter(
    (t: DocumentTypeView) => !t.hidden || v.types.includes(t.key),
  );
  const everyone = (data?.collections ?? []).filter(
    (c: CollectionView) => c.audience === 'everyone',
  );
  const id = (s: string) => `${props.idPrefix}-${s}`;

  return (
    <div className="stack limits">
      <ErrorNote message={error} />
      <fieldset className="limits-set">
        <legend ref={peopleLegend} tabIndex={-1} className="field-label">
          Whose documents
        </legend>
        <p className="muted" id={id('people-about')}>
          None chosen: anybody’s, of the kinds below.
        </p>
        {gone.people && (
          <div className="stack">
            <p className="status status-warn">{PEOPLE_GONE}</p>
            <Button kind="quiet" onClick={() => giveUp({ limits_people: false }, peopleLegend)}>
              Give anybody’s instead
            </Button>
          </div>
        )}
        <div className="limits-list">
          {people.map((m) => (
            <Check
              key={m.id}
              id={id(`person-${m.id}`)}
              label={m.display_name}
              checked={v.people.includes(m.id)}
              onChange={(on) => toggle('people', m.id, on)}
            />
          ))}
        </div>
      </fieldset>
      <fieldset className="limits-set">
        <legend ref={kindsLegend} tabIndex={-1} className="field-label">
          Which kinds
        </legend>
        <p className="muted">None chosen: every kind of the people chosen.</p>
        {gone.types && (
          <div className="stack">
            <p className="status status-warn">{KINDS_GONE}</p>
            <Button kind="quiet" onClick={() => giveUp({ limits_types: false }, kindsLegend)}>
              Give every kind instead
            </Button>
          </div>
        )}
        <div className="limits-list limits-kinds">
          {kinds.map((t) => (
            <Check
              key={t.key}
              id={id(`kind-${t.key}`)}
              label={t.short_label ?? t.label}
              checked={v.types.includes(t.key)}
              onChange={(on) => toggle('types', t.key, on)}
            />
          ))}
        </div>
      </fieldset>
      <fieldset className="limits-set">
        <legend className="field-label">Collections</legend>
        <p className="muted">
          Everything in a collection chosen, besides. Only a collection for Everyone in the family
          can be given to a viewer.
        </p>
        {everyone.length === 0 ? (
          <p className="muted">There is no collection for Everyone yet.</p>
        ) : (
          <div className="limits-list">
            {everyone.map((c) => (
              <Check
                key={c.id}
                id={id(`collection-${c.id}`)}
                label={c.name}
                checked={v.collections.includes(c.id)}
                onChange={(on) => toggle('collections', c.id, on)}
              />
            ))}
          </div>
        )}
      </fieldset>
      <fieldset className="limits-set">
        <legend className="field-label">Also</legend>
        <Check
          id={id('no-person')}
          label="Documents that belong to no one"
          note="The house deed, the car’s papers: of the kinds chosen."
          checked={v.include_no_person_docs}
          onChange={(on) => props.onChange({ ...v, include_no_person_docs: on })}
        />
        {props.owner && (
          <Check
            id={id('adults')}
            label="Adults only documents too"
            note="Only an owner can give these. Without it, none of them."
            checked={v.include_adults_only}
            onChange={(on) => props.onChange({ ...v, include_adults_only: on })}
          />
        )}
        {!props.endless && (
          <div className="field">
            <label htmlFor={id('until')}>Until (optional)</label>
            <input
              id={id('until')}
              type="date"
              value={dayOf(v.expires_at, timezone)}
              onChange={(e) =>
                props.onChange({ ...v, expires_at: endOf(e.target.value, timezone) })
              }
              aria-describedby={id('until-note')}
            />
            <span id={id('until-note')} className="muted">
              {`After this day, on the family’s clock (${timezone}), they see nothing at all.`}
            </span>
          </div>
        )}
      </fieldset>
      <p className="notice limits-count" role="status" aria-live="polite">
        {count ? previewWords(count) : ''}
      </p>
      <ErrorNote message={countError} />
    </div>
  );
}

/**
 * "What they can see", on a viewer's account card (5.33), for an owner
 * who has opened it — asked with a passkey or a code, as every owner power
 * is (A54): their limits in a sentence, to change or take off; and, after
 * their sign-in was given back, confirming they are still right.
 */
export function ViewerLimits(props: {
  member: Member;
  name: string;
  access: MemberAccess | null;
  /** A guest (5.34): always limited, so their limits are changed, never taken off. */
  guest?: boolean;
  onChanged: (access: MemberAccess | null, said: string) => void;
}) {
  const { guarded } = useApp();
  const [editing, setEditing] = useState<Limits | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [askPrivate, setAskPrivate] = useState<string | null>(null);
  const [takingOff, setTakingOff] = useState(false);
  const changeButton = useRef<HTMLButtonElement>(null);
  const offButton = useRef<HTMLButtonElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const editorHeading = useRef<HTMLHeadingElement>(null);
  const a = props.access;
  // Focus follows the editor (the 5.33 review, W533-04): into it as it
  // opens, and back to the button that opened it as it closes unsaved.
  const wasEditing = useRef(false);
  useLayoutEffect(() => {
    if (editing && !wasEditing.current) editorHeading.current?.focus();
    wasEditing.current = editing !== null;
  }, [editing]);
  const cancel = () => {
    flushSync(() => {
      setEditing(null);
      setError(null);
    });
    changeButton.current?.focus();
  };

  const save = async (limits: Limits, confirmPrivate: boolean, said: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const done = await guarded((t) =>
        api.setMemberAccess(t, props.member.id, {
          ...limits,
          ...(confirmPrivate ? { confirm_private: true } : {}),
        }),
      );
      if (!done) return;
      flushSync(() => {
        setEditing(null);
        setAskPrivate(null);
      });
      props.onChanged(done, said);
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'confirm_private') {
        setAskPrivate(err.message);
      } else {
        setAskPrivate(null);
        setError(describeError(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const takeOff = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const done = await guarded((t) => api.removeMemberAccess(t, props.member.id));
      if (done === null) return;
      flushSync(() => setTakingOff(false));
      props.onChanged(null, `${props.name} can see every family document again.`);
    } catch (err) {
      flushSync(() => setTakingOff(false));
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (editing && !busy) {
      void save(
        editing,
        false,
        `${props.name}’s limits are saved. They apply from their next look.`,
      );
    }
  };

  return (
    <section className="stack viewer-limits" aria-labelledby="limits-h">
      <h3 id="limits-h" className="section-h">
        What they can see
      </h3>
      {editing ? (
        <form className="stack" onSubmit={submit} aria-labelledby="limits-edit-h">
          <h4 id="limits-edit-h" ref={editorHeading} tabIndex={-1} className="limits-edit-h">
            {`Choose what ${props.name} can see`}
          </h4>
          <LimitsPicker
            idPrefix="limits"
            value={editing}
            onChange={setEditing}
            memberId={props.member.id}
            owner
          />
          <ErrorNote message={error} />
          <div className="row">
            {/* aria-disabled, not disabled: it keeps the focus while it
                saves, for the confirmation to hand back to. */}
            <button ref={saveButton} type="submit" className="btn btn-primary" aria-disabled={busy}>
              {busy ? 'Saving…' : 'Save these limits'}
            </button>
            <Button kind="quiet" onClick={cancel}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          {a?.reconfirm_since && (
            <p className="status status-warn">
              {`${props.name}’s sign-in was given back since these limits were set. Check they are still right, and keep them or change them.`}
            </p>
          )}
          <p>
            {a
              ? a.summary
              : `${props.name} can see every family document but the Adults only ones.`}
          </p>
          {/* Named, and deleted since (R532-01): still limited by them. */}
          {a && namedAllGone(a).types && <p className="status status-warn">{KINDS_GONE}</p>}
          {a && namedAllGone(a).people && <p className="status status-warn">{PEOPLE_GONE}</p>}
          <ErrorNote message={error} />
          <div className="row">
            {a?.reconfirm_since && (
              <Button
                disabled={busy}
                onClick={() =>
                  void save(limitsOf(a), false, `${props.name}’s limits are confirmed.`)
                }
              >
                Keep these limits
              </Button>
            )}
            <Button
              ref={changeButton}
              kind={a?.reconfirm_since ? 'quiet' : 'primary'}
              onClick={() => {
                setError(null);
                setEditing(a ? limitsOf(a) : NO_LIMITS);
              }}
            >
              {a ? 'Change what they can see' : 'Limit what they can see'}
            </Button>
            {a && !props.guest && (
              <Button
                ref={offButton}
                kind="quiet"
                onClick={() => {
                  setError(null);
                  setTakingOff(true);
                }}
              >
                Take the limits off
              </Button>
            )}
          </div>
        </>
      )}
      {askPrivate && editing && (
        <ConfirmDialog
          title={`Limit what ${props.name} can see?`}
          confirmLabel="Limit them"
          busyLabel="Saving…"
          busy={busy}
          returnFocus={saveButton}
          onConfirm={() =>
            void save(editing, true, `${props.name}’s limits are saved, and they have been told.`)
          }
          onCancel={() => setAskPrivate(null)}
        >
          <p>{askPrivate}</p>
        </ConfirmDialog>
      )}
      {takingOff && (
        <ConfirmDialog
          title={`Let ${props.name} see every family document?`}
          confirmLabel="Take the limits off"
          busyLabel="Taking them off…"
          busy={busy}
          returnFocus={offButton}
          onConfirm={() => void takeOff()}
          onCancel={() => setTakingOff(false)}
        >
          <p>{`${props.name} will see every family document but the Adults only ones, from their next look.`}</p>
        </ConfirmDialog>
      )}
    </section>
  );
}
