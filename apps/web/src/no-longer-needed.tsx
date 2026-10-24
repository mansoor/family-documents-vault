import {
  ANOTHER_DOCUMENT,
  NO_LONGER_NEEDED_REASON_MAX,
  type DocumentView,
  type NoLongerNeededView,
} from '@fdv/shared';
import { useEffect, useId, useRef, useState, type Ref, type RefObject } from 'react';
import { Link } from 'react-router';
import { api } from './api.js';
import { describeError, useApp } from './app-context.js';
import { dayWordsOf, useFamilyZone } from './family-time.js';
import { ErrorNote, Switch, useSheetFocus } from './ui.js';

/**
 * No longer needed (0.9.0; the owner's ask of 23 Oct 2026): a document kept
 * — found, shared and in its collections as ever — whose expiry says
 * nothing any more, because something else made it unnecessary: an EAD card
 * once the green card came. Set with its details (Edit details, the one
 * place on its own page, 0.9.0 — not a menu's item, as it is not often
 * done), and beside a reminder (Not needed any more, with the dialog); said
 * on its page by a banner, with Needed again and Change why.
 */

/** A document the dialog may offer as what replaced it. */
interface Choice {
  id: string;
  title: string | null;
}

/** How many it offers at once: a short list to choose from, never the vault. */
const OFFERED = 8;
/** How long typing stops before the vault is asked (search as you type). */
const SETTLES_MS = 250;

const named = (title: string | null) => title ?? 'A document with no name';

/** "No longer needed since 23 Oct 2026", on the family's calendar. */
export function sinceWords(n: Pick<NoLongerNeededView, 'at'>, zone: string): string {
  return `No longer needed since ${dayWordsOf(n.at, zone, { month: 'short', year: true })}`;
}

/** Marks one replacement the reader may not see, kept as it is: never sent (the review, M1). */
const KEPT = 'kept';

/** What the dialog sends: only what was changed — a field left out is kept as it is. */
export type NoLongerNeededBody = { reason?: string | null; replaced_by?: string | null };

/**
 * Why, and what replaced it, as typed and chosen: the dialog's, and the
 * property's on the document's details (0.9.0) — one picker, one rule.
 */
export interface NoLongerNeededDraft {
  reason: string;
  /** The id chosen, '' for nothing in particular, or KEPT for one the reader may not see. */
  chosen: string;
  /** The one chosen, offered whatever is typed: what is chosen is seen. */
  chosenOne: Choice | null;
}

/** A draft as the document has it now: its reason and what replaced it, or none. */
export function draftOf(was: NoLongerNeededView | null): NoLongerNeededDraft {
  const hiddenKept = was?.replaced_by != null && was.replaced_by.id === null;
  return {
    reason: was?.reason ?? '',
    chosen: hiddenKept ? KEPT : (was?.replaced_by?.id ?? ''),
    chosenOne: was?.replaced_by?.id
      ? { id: was.replaced_by.id, title: was.replaced_by.title }
      : null,
  };
}

/**
 * What to send for a draft: a field only once it is changed from what the
 * document had, so a replacement the reader may not see — or a reason sealed
 * from a list — is kept as it is, never wiped by what they were not shown (M1).
 */
export function bodyOf(
  was: NoLongerNeededView | null,
  draft: NoLongerNeededDraft,
): NoLongerNeededBody {
  const before = draftOf(was);
  return {
    ...(draft.reason.trim() !== before.reason.trim()
      ? { reason: draft.reason.trim() || null }
      : {}),
    ...(draft.chosen !== before.chosen && draft.chosen !== KEPT
      ? { replaced_by: draft.chosen || null }
      : {}),
  };
}

/** Why is at most NO_LONGER_NEEDED_REASON_MAX characters: the words when it is longer. */
export function reasonTooLong(draft: NoLongerNeededDraft): string | null {
  return [...draft.reason.trim()].length > NO_LONGER_NEEDED_REASON_MAX
    ? `Keep why to ${NO_LONGER_NEEDED_REASON_MAX} characters.`
    : null;
}

/**
 * Why (optional), and Replaced by (optional): what replaced it is one of the
 * documents the reader can see, found as they type, the same person's
 * offered first, never the document itself.
 */
export function NoLongerNeededFields({
  ref,
  ...props
}: {
  /** Each field's id starts with it. */
  ids: string;
  doc: Pick<DocumentView, 'id' | 'owner_member_id' | 'no_longer_needed'>;
  draft: NoLongerNeededDraft;
  onChange: (draft: NoLongerNeededDraft) => void;
  /** Why's box, for the dialog to start on. */
  ref?: Ref<HTMLTextAreaElement>;
}) {
  const { withToken } = useApp();
  const { ids, draft, onChange } = props;
  const [query, setQuery] = useState('');
  const [offered, setOffered] = useState<Choice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hiddenKept =
    props.doc.no_longer_needed?.replaced_by != null &&
    props.doc.no_longer_needed.replaced_by.id === null;

  useEffect(() => {
    let stopped = false;
    const q = query.trim();
    const timer = setTimeout(
      () => {
        void withToken(async (t) => {
          if (q.length < 2) {
            // The same person's documents first: what usually replaces an
            // EAD card is that person's green card.
            const whose = props.doc.owner_member_id;
            const page = await api.documents(t, {
              sort: 'title',
              limit: 50,
              ...(whose ? { member_id: whose } : {}),
            });
            return page.items.map((d) => ({ id: d.id, title: d.title }));
          }
          const hits = await api.search(t, q);
          return hits.items.map((h) => ({ id: h.document_id, title: h.title }));
        }).then(
          (found) => {
            if (stopped || !found) return;
            setOffered(found.filter((d) => d.id !== props.doc.id).slice(0, OFFERED));
          },
          (err: unknown) => {
            if (!stopped) setError(describeError(err));
          },
        );
      },
      q.length < 2 ? 0 : SETTLES_MS,
    );
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [query, props.doc.id, props.doc.owner_member_id, withToken]);

  const choices = [
    ...(draft.chosenOne && !(offered ?? []).some((d) => d.id === draft.chosenOne?.id)
      ? [draft.chosenOne]
      : []),
    ...(offered ?? []),
  ];
  const length = [...draft.reason.trim()].length;
  const tooLong = length > NO_LONGER_NEEDED_REASON_MAX;
  return (
    <>
      <div className="field">
        <label htmlFor={`${ids}-why`}>Why (optional)</label>
        <textarea
          ref={ref}
          id={`${ids}-why`}
          value={draft.reason}
          rows={3}
          maxLength={NO_LONGER_NEEDED_REASON_MAX + 20}
          aria-invalid={tooLong || undefined}
          aria-describedby={`${ids}-count`}
          onChange={(e) => onChange({ ...draft, reason: e.target.value })}
        />
        <span id={`${ids}-count`} className={tooLong ? 'error-text' : 'muted'}>
          {length} of {NO_LONGER_NEEDED_REASON_MAX} characters
        </span>
      </div>
      <fieldset className="nln-replaced">
        <legend>Replaced by (optional)</legend>
        <div className="field">
          <label htmlFor={`${ids}-find`}>Find a document</label>
          <input
            id={`${ids}-find`}
            type="search"
            value={query}
            autoComplete="off"
            aria-describedby={`${ids}-found`}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <p id={`${ids}-found`} className="muted" role="status">
          {offered === null
            ? 'Looking…'
            : query.trim().length < 2
              ? 'Documents of the same person. Type to find any other.'
              : offered.length === 0
                ? 'No document has those words.'
                : `${offered.length} found`}
        </p>
        <div className="nln-choices">
          <div className="check">
            <input
              id={`${ids}-none`}
              type="radio"
              name={`${ids}-by`}
              value=""
              checked={draft.chosen === ''}
              onChange={() => onChange({ ...draft, chosen: '' })}
            />
            <label htmlFor={`${ids}-none`}>Nothing in particular</label>
          </div>
          {hiddenKept && (
            <div className="check">
              <input
                id={`${ids}-kept`}
                type="radio"
                name={`${ids}-by`}
                value={KEPT}
                checked={draft.chosen === KEPT}
                onChange={() => onChange({ ...draft, chosen: KEPT })}
              />
              <label htmlFor={`${ids}-kept`}>Another document (kept as it is)</label>
            </div>
          )}
          {choices.map((d, i) => (
            <div key={d.id} className="check">
              <input
                id={`${ids}-by-${i}`}
                type="radio"
                name={`${ids}-by`}
                value={d.id}
                checked={draft.chosen === d.id}
                onChange={() => onChange({ ...draft, chosen: d.id, chosenOne: d })}
              />
              <label htmlFor={`${ids}-by-${i}`}>{named(d.title)}</label>
            </div>
          ))}
        </div>
      </fieldset>
      <ErrorNote message={error} />
    </>
  );
}

/**
 * The dialog that marks a document no longer needed — or, asked again,
 * changes why and by what (the banner's Change why, a reminder's Not needed
 * any more). `onDone` is given the document as the vault now has it.
 */
export function NoLongerNeededDialog(props: {
  doc: Pick<DocumentView, 'id' | 'title' | 'owner_member_id' | 'no_longer_needed'>;
  returnFocus: RefObject<HTMLElement | null>;
  onDone: (saved: DocumentView) => void | Promise<unknown>;
  onCancel: () => void;
}) {
  const { withToken } = useApp();
  const ids = useId();
  const box = useRef<HTMLElement>(null);
  const why = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  useSheetFocus(box, {
    start: why,
    onEscape: props.onCancel,
    busy,
    returnFocus: props.returnFocus,
  });
  const was = props.doc.no_longer_needed ?? null;
  const [draft, setDraft] = useState(() => draftOf(was));
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (busy) return;
    const tooLong = reasonTooLong(draft);
    if (tooLong) {
      setError(tooLong);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await withToken((t) =>
        api.markNoLongerNeeded(t, props.doc.id, bodyOf(was, draft)),
      );
      if (saved) await props.onDone(saved);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="scrim" role="presentation">
      <section
        ref={box}
        className="card stack sheet nln-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${ids}-h`}
        aria-describedby={`${ids}-what`}
        aria-busy={busy}
      >
        <h2 id={`${ids}-h`} style={{ fontSize: 20 }}>
          {was ? 'No longer needed' : 'Mark as no longer needed'}
        </h2>
        <p id={`${ids}-what`} className="muted">
          “{named(props.doc.title)}” stays in the vault: found, shared and in its collections as
          before. Nobody is reminded of it, and it leaves Needs attention.
        </p>
        <NoLongerNeededFields
          ids={ids}
          doc={props.doc}
          draft={draft}
          onChange={setDraft}
          ref={why}
        />
        <ErrorNote message={error} />
        <div className="row">
          <button
            type="button"
            className="btn btn-primary"
            aria-disabled={busy || undefined}
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : was ? 'Save' : 'Mark as no longer needed'}
          </button>
          <button
            type="button"
            className="btn btn-quiet"
            aria-disabled={busy || undefined}
            onClick={() => {
              if (!busy) props.onCancel();
            }}
          >
            Cancel
          </button>
        </div>
      </section>
    </div>
  );
}

/**
 * No longer needed as a property of the document (0.9.0; the owner's ask of
 * 24 Oct), on its details card (Edit details) with its kind and dates: a
 * switch, and — on — why and what replaced it, as the dialog asks them.
 * Saved with the card: turned off, it is needed again.
 */
export function NoLongerNeededProperty(props: {
  doc: Pick<DocumentView, 'id' | 'owner_member_id' | 'no_longer_needed'>;
  on: boolean;
  draft: NoLongerNeededDraft;
  onChange: (on: boolean, draft: NoLongerNeededDraft) => void;
}) {
  const ids = useId();
  const zone = useFamilyZone();
  const was = props.doc.no_longer_needed;
  return (
    <div className="nln-property stack">
      <Switch
        id={`${ids}-on`}
        label="No longer needed"
        checked={props.on}
        onChange={(on) => props.onChange(on, props.draft)}
      />
      <p className="muted nln-property-note">
        {props.on
          ? was
            ? `${sinceWords(was, zone)}. Kept, found and shared as before; nobody is reminded of it. Turn it off when it is needed again.`
            : 'Kept, found and shared as before; nobody is reminded of it, and it leaves Needs attention.'
          : was
            ? 'Needed again once you save: its reminders come back as its dates say.'
            : 'For a document kept, but made unnecessary by another: an EAD card once the green card came.'}
      </p>
      {props.on && (
        <NoLongerNeededFields
          ids={ids}
          doc={props.doc}
          draft={props.draft}
          onChange={(draft) => props.onChange(props.on, draft)}
        />
      )}
    </div>
  );
}

/** What replaced it, as the reader is given it: its name and the way to it, or "another document". */
function ReplacedBy({ by }: { by: NonNullable<NoLongerNeededView['replaced_by']> }) {
  return by.id ? (
    <>
      Replaced by <Link to={`/documents/${by.id}`}>{named(by.title)}</Link>
    </>
  ) : (
    <>Replaced by {ANOTHER_DOCUMENT}</>
  );
}

/**
 * Said at the top of a document no longer needed: "No longer needed since
 * 23 Oct 2026 · Replaced by Green card · Needed again", why under it, and
 * who marked it. Needed again and Change are for whoever may change it.
 */
export function NoLongerNeededBanner(props: {
  doc: DocumentView;
  mayChange: boolean;
  onChanged: (saved: DocumentView) => void;
}) {
  const { withToken } = useApp();
  const zone = useFamilyZone();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const change = useRef<HTMLButtonElement>(null);
  const n = props.doc.no_longer_needed;
  if (!n) return null;
  const again = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await withToken((t) => api.markNeededAgain(t, props.doc.id));
      if (saved) props.onChanged(saved);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="nln-banner" aria-label="No longer needed">
      <p>
        <strong>{sinceWords(n, zone)}</strong>
        {n.replaced_by && (
          <>
            {' · '}
            <ReplacedBy by={n.replaced_by} />
          </>
        )}
        {props.mayChange && (
          <>
            {' · '}
            <button
              type="button"
              className="btn-link nln-again"
              aria-disabled={busy || undefined}
              onClick={() => void again()}
            >
              {busy ? 'Marking it needed again…' : 'Needed again'}
            </button>
          </>
        )}
      </p>
      {n.reason && <p className="nln-reason keep-lines">{n.reason}</p>}
      {!n.reason && n.has_reason && <p className="muted">Why is kept for its owner alone.</p>}
      <p className="muted">
        Nothing reminds anyone of it.{n.by_name ? ` Marked by ${n.by_name}.` : ''}
        {props.mayChange && (
          <>
            {' '}
            <button
              ref={change}
              type="button"
              className="btn-link"
              onClick={() => setChanging(true)}
            >
              Change why
            </button>
          </>
        )}
      </p>
      <ErrorNote message={error} />
      {changing && (
        <NoLongerNeededDialog
          doc={props.doc}
          returnFocus={change}
          onCancel={() => setChanging(false)}
          onDone={(saved) => {
            setChanging(false);
            props.onChanged(saved);
          }}
        />
      )}
    </section>
  );
}

/**
 * Asked once a new version is added to a document no longer needed (S1):
 * whether it is needed again. Adding a copy never makes it so by itself —
 * a scan of the old card filed late is still the old card.
 */
export function NeededAgainQuestion(props: {
  doc: Pick<DocumentView, 'id' | 'title'>;
  returnFocus: RefObject<HTMLElement | null>;
  onAnswered: (saved: DocumentView | null) => void | Promise<unknown>;
}) {
  const { withToken } = useApp();
  const ids = useId();
  const box = useRef<HTMLElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useSheetFocus(box, {
    start: keep,
    onEscape: () => void props.onAnswered(null),
    busy,
    returnFocus: props.returnFocus,
  });
  const again = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await withToken((t) => api.markNeededAgain(t, props.doc.id));
      await props.onAnswered(saved);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="scrim" role="presentation">
      <section
        ref={box}
        className="card stack sheet"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${ids}-h`}
        aria-describedby={`${ids}-body`}
        aria-busy={busy}
      >
        <h2 id={`${ids}-h`} style={{ fontSize: 20 }}>
          Is it needed again?
        </h2>
        <p id={`${ids}-body`} className="muted">
          A new version of “{named(props.doc.title)}” was added. It is still marked no longer
          needed, so nobody is reminded of it.
        </p>
        <ErrorNote message={error} />
        <div className="row">
          <button
            type="button"
            className="btn btn-primary"
            aria-disabled={busy || undefined}
            onClick={() => void again()}
          >
            {busy ? 'Marking it needed again…' : 'Needed again'}
          </button>
          <button
            ref={keep}
            type="button"
            className="btn btn-quiet"
            aria-disabled={busy || undefined}
            onClick={() => {
              if (!busy) void props.onAnswered(null);
            }}
          >
            Keep it no longer needed
          </button>
        </div>
      </section>
    </div>
  );
}

/**
 * "Not needed any more", beside a reminder (Needs attention, where the
 * reminder email and push lead): the same dialog as the document's page,
 * for a document whose renewal nobody will do — and with it, its
 * reminders go. For whoever may change the document.
 */
export function NotNeededButton(props: {
  documentId: string;
  title: string | null;
  ownerMemberId: string | null;
  onDone: () => void | Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={button}
        type="button"
        className="btn btn-quiet btn-small"
        aria-label={`Not needed any more: “${named(props.title)}”`}
        onClick={() => setOpen(true)}
      >
        Not needed any more
      </button>
      {open && (
        <NoLongerNeededDialog
          doc={{
            id: props.documentId,
            title: props.title,
            owner_member_id: props.ownerMemberId,
            no_longer_needed: null,
          }}
          returnFocus={button}
          onCancel={() => setOpen(false)}
          onDone={async () => {
            setOpen(false);
            await props.onDone();
          }}
        />
      )}
    </>
  );
}
