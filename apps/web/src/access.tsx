import {
  type AccessGrant,
  type AccessPreview,
  type CollectionView,
  type DocumentTypeView,
  type MemberAccess,
} from '@fdv/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
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
};

/** The limits as a viewer's card holds them, to change. */
export const limitsOf = (a: MemberAccess): Limits => ({
  people: a.people,
  types: a.types,
  collections: a.collections,
  include_adults_only: a.include_adults_only,
  include_no_person_docs: a.include_no_person_docs,
  expires_at: a.expires_at,
});

/** "14 documents" */
const documentsWord = (n: number) => `${n} document${n === 1 ? '' : 's'}`;

/** What the count says: what they will see, and their own Only me ones. */
export function previewWords(p: AccessPreview): string {
  const own = p.keeps_private ? ', and their own Only me documents' : '';
  return `They will see ${documentsWord(p.documents)}${own}.`;
}

/** The day an end is chosen as, from what the vault keeps: the browser's day. */
const dayOf = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
/** The end of that day, on this device's clock: the moment the vault keeps. */
const endOf = (day: string) => (day ? new Date(`${day}T23:59:00`).toISOString() : null);

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
}) {
  const { authVersion, withToken, caps } = useApp();
  const hasCollections = caps?.features.collections === true;
  const { data, error } = useLoad(
    async (t) => {
      const [members, types, collections] = await Promise.all([
        api.members(t),
        api.documentTypes(t),
        // A vault from before collections has none to give.
        hasCollections ? api.collections(t) : Promise.resolve({ items: [] as CollectionView[] }),
      ]);
      return { members: members.items, types: types.items, collections: collections.items };
    },
    [authVersion, hasCollections],
  );
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

  const toggle = (list: 'people' | 'types' | 'collections', id: string, on: boolean) =>
    props.onChange({
      ...v,
      [list]: on ? [...v[list], id] : v[list].filter((x) => x !== id),
    });
  const people = (data?.members ?? []).filter((m: Member) => m.id !== props.memberId);
  const kinds = (data?.types ?? []).filter((t: DocumentTypeView) => !t.hidden);
  const everyone = (data?.collections ?? []).filter(
    (c: CollectionView) => c.audience === 'everyone',
  );
  const id = (s: string) => `${props.idPrefix}-${s}`;

  return (
    <div className="stack limits">
      <ErrorNote message={error} />
      <fieldset className="limits-set">
        <legend className="field-label">Whose documents</legend>
        <p className="muted" id={id('people-about')}>
          None chosen: anybody’s, of the kinds below.
        </p>
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
        <legend className="field-label">Which kinds</legend>
        <p className="muted">None chosen: every kind of the people chosen.</p>
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
        <div className="field">
          <label htmlFor={id('until')}>Until (optional)</label>
          <input
            id={id('until')}
            type="date"
            value={dayOf(v.expires_at)}
            onChange={(e) => props.onChange({ ...v, expires_at: endOf(e.target.value) })}
            aria-describedby={id('until-note')}
          />
          <span id={id('until-note')} className="muted">
            After this day they see nothing at all.
          </span>
        </div>
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
  const a = props.access;

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
    if (editing) {
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
        <form className="stack" onSubmit={submit}>
          <LimitsPicker
            idPrefix="limits"
            value={editing}
            onChange={setEditing}
            memberId={props.member.id}
            owner
          />
          <ErrorNote message={error} />
          <div className="row">
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save these limits'}
            </Button>
            <Button
              kind="quiet"
              onClick={() => {
                setEditing(null);
                setError(null);
              }}
            >
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
            {a && (
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
