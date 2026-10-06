import {
  aboutDate,
  addDays,
  can,
  canEditIdentity,
  initialsFor,
  localToday,
  roleLabel,
  shortDate,
  shortName,
  type DocumentTypeView,
  type DocumentView,
  type ReminderView,
  type Role,
  type SuggestionView,
} from '@fdv/shared';
import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api, type Invitation, type Member, type SearchHit } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { AddToCollection, collectionsOffered, documentsWord } from '../collections.js';
import { DocActions } from '../DocActions.js';
import { PersonAvatar } from '../person-avatar.js';
import { storedRole } from '../session.js';
import {
  Button,
  categoryLabel,
  Check,
  CollapsibleSection,
  ErrorNote,
  Field,
  Sheet,
  StatusBadge,
  TopBar,
} from '../ui.js';
import { addLink, DocRow, rowLine, RowMain, type RowPick } from './Home.js';

/** The most documents put in a collection at once, as the vault takes them. */
const MOST_AT_ONCE = 200;
import { PeopleTabs } from '../guests.js';
import { InvitePanel } from './Invite.js';
import { OwnerChangeNotices } from './Roles.js';

/** How many of the household's issuers are offered as filter chips. */
const ISSUER_CHIPS = 8;

/**
 * Search: one field, live results, filter chips for person and category,
 * and for who issued it (0.4.10: "Barclays", "British Gas"). With no query
 * it browses — by category (from the home tiles), by person or by issuer —
 * because non-technical users browse before they search.
 *
 * At /documents it is called Documents: the shell's Documents opens this
 * browse view until R2 builds the Documents table there (Phase 6, R1).
 */
export function SearchScreen({ title = 'Search' }: { title?: string } = {}) {
  const { withToken, authVersion, caps } = useApp();
  const navigate = useNavigate();
  const select = useSelect(collectionsOffered(caps, storedRole()));
  const unpick = select.drop;
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const category = params.get('category') ?? '';
  const memberId = params.get('member') ?? '';
  const issuer = params.get('issued_by') ?? '';
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  // The second pass over the caller's own sealed documents (FND-08). It
  // starts after the indexed results are already on screen, because it is
  // the slow half and waiting for it would make every search feel slow.
  const [sealed, setSealed] = useState<{
    state: 'idle' | 'searching' | 'done';
    items: SearchHit[];
    searched: number;
  }>({ state: 'idle', items: [], searched: 0 });
  const [browse, setBrowse] = useState<DocumentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped when a row's ⋯ changed something (5.4): the same search again.
  const [changed, setChanged] = useState(0);
  const again = () => setChanged((n) => n + 1);
  // The rows whose own ⋯ changed something, each with the search it was
  // in, until that search has run again: one that has left the results
  // with it — moved to the Trash, made somebody else's Only me — is chosen
  // no longer (5.15). What was chosen in an earlier search is not in these
  // results either, and stays.
  const acted = useRef(new Map<string, { search: string }>());
  const search = JSON.stringify([q, category, memberId, issuer]);
  const actedOn = (id: string) => () => {
    acted.current.set(id, { search });
    again();
  };
  // What the last search asked. The same search again keeps the second
  // pass's results on screen while it runs: emptied, each of their rows
  // would go, and the note and the focus on the row that acted with it.
  const asked = useRef('');
  const { data: members } = useLoad(async (t) => (await api.members(t)).items, [authVersion]);
  // First names, or whole names where two first names match (5.17c).
  const pillNames = shortName(members ?? []);
  const { data: types } = useLoad(async (t) => (await api.documentTypes(t)).items, [authVersion]);
  // Who issued what, among what is being looked at: the chips narrow it further.
  const { data: issuers } = useLoad(
    async (t) =>
      (
        await api.issuers(t, {
          category: category || undefined,
          member_id: memberId || undefined,
        })
      ).items,
    [authVersion, category, memberId],
  );
  const issuerChips = (issuers ?? []).slice(0, ISSUER_CHIPS).map((i) => i.issued_by);
  // The one chosen stays on screen, even when it is not among the most used.
  if (issuer && !issuerChips.some((n) => sameIssuer(n, issuer))) issuerChips.push(issuer);

  useEffect(() => {
    let cancelled = false;
    // The rows whose ⋯ asked for this search again, if one did; one acted
    // on in another search is not asked about in this one. Each is let go
    // of once it has been judged, and not before: a run overtaken by the
    // next, when a second ⋯ asks before the first is answered, leaves its
    // rows to that one, with the second's.
    for (const [id, act] of acted.current) if (act.search !== search) acted.current.delete(id);
    const actedNow = [...acted.current];
    /** Those of them the whole of the results, both passes, no longer hold. */
    const left = (shown: string[]) => {
      const here = new Set(shown);
      // Acted on again since this run began: the next run judges that.
      for (const [id, act] of actedNow) if (acted.current.get(id) === act) acted.current.delete(id);
      unpick(actedNow.map(([id]) => id).filter((id) => !here.has(id)));
    };
    const run = async () => {
      try {
        setError(null);
        if (q.trim()) {
          const r = await withToken((t) =>
            api.search(t, q.trim(), {
              ...(category ? { category } : {}),
              ...(memberId ? { member_id: memberId } : {}),
              ...(issuer ? { issued_by: issuer } : {}),
            }),
          );
          if (!cancelled && r) {
            const same = asked.current === search;
            asked.current = search;
            setHits(r.items);
            setBrowse(null);
            const found = r.items.map((h) => h.document_id);
            const handle = r.sealed_pending.token;
            if (!handle) {
              setSealed({ state: 'idle', items: [], searched: 0 });
              left(found);
            } else {
              setSealed(
                same
                  ? (was) => ({ ...was, state: 'searching' })
                  : { state: 'searching', items: [], searched: 0 },
              );
              const more = await withToken((t) => api.searchSealed(t, handle));
              if (!cancelled) {
                setSealed({
                  state: 'done',
                  items: more?.items ?? [],
                  searched: more?.searched ?? 0,
                });
                left([...found, ...(more?.items ?? []).map((h) => h.document_id)]);
              }
            }
          }
        } else {
          const r = await withToken((t) =>
            api.documents(t, {
              category: category || undefined,
              member_id: memberId || undefined,
              issued_by: issuer || undefined,
              limit: 100,
            }),
          );
          if (!cancelled && r) {
            asked.current = '';
            setBrowse(r.items);
            setHits(null);
            setSealed({ state: 'idle', items: [], searched: 0 });
            left(r.items.map((d) => d.id));
          }
        }
      } catch (err) {
        if (!cancelled) setError(describeError(err));
      }
    };
    const handle = setTimeout(() => void run(), q ? 250 : 0);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [q, category, memberId, issuer, search, withToken, changed, unpick]);

  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  return (
    <main className="page page-top page-wide has-nav">
      <TopBar title={title} />
      <div className="field">
        <label htmlFor="q">Search everything</label>
        <input
          id="q"
          type="search"
          value={q}
          onChange={(e) => set('q', e.target.value)}
          placeholder="Names, numbers, or words inside a document"
          autoFocus
        />
      </div>
      <div className="pills" aria-label="Filters">
        <button
          type="button"
          className={`pill${!memberId && !category && !issuer ? ' pill-on' : ''}`}
          onClick={() => {
            const next = new URLSearchParams(params);
            for (const k of ['member', 'category', 'issued_by']) next.delete(k);
            setParams(next, { replace: true });
          }}
        >
          All
        </button>
        {(members ?? []).map((m: Member) => (
          <button
            key={m.id}
            type="button"
            className={`pill${memberId === m.id ? ' pill-on' : ''}`}
            aria-pressed={memberId === m.id}
            onClick={() => set('member', memberId === m.id ? '' : m.id)}
          >
            {pillNames.get(m.id) ?? m.display_name}
          </button>
        ))}
        {category && (
          <button
            type="button"
            className="pill pill-on"
            aria-pressed="true"
            onClick={() => set('category', '')}
          >
            {categoryLabel(category)} ×
          </button>
        )}
      </div>
      {issuerChips.length > 0 && (
        <div className="pills" role="group" aria-label="Who it is from">
          {issuerChips.map((name) => {
            const on = sameIssuer(name, issuer);
            return (
              <button
                key={name}
                type="button"
                className={`pill${on ? ' pill-on' : ''}`}
                aria-pressed={on}
                onClick={() => set('issued_by', on ? '' : name)}
              >
                {/* Chosen is said by more than the colour. */}
                {on && <span aria-hidden="true">✓ </span>}
                {name}
              </button>
            );
          })}
        </div>
      )}
      <ErrorNote message={error} />
      {/* Select, where there is something to choose, or something chosen already. */}
      {(select.on ||
        (hits !== null && hits.length + sealed.items.length > 0) ||
        (browse !== null && browse.length > 0)) &&
        select.bar}
      {hits && (
        <>
          {/* Where focus goes when a row leaves the results with it (5.4). */}
          <p className="muted" role="status" tabIndex={-1} data-landing>
            {/* Counts both passes, so the line never says "0 documents"
                above a result the second pass found. */}
            {hits.length + sealed.items.length} document
            {hits.length + sealed.items.length === 1 ? '' : 's'}, searched inside the pages too
          </p>
          <ul className="list">
            {hits.map((h) => (
              <HitRow
                key={h.document_id}
                hit={h}
                types={types}
                pick={select.pick(h.document_id)}
                onOpen={() => void navigate(`/documents/${h.document_id}`)}
                onChanged={actedOn(h.document_id)}
              />
            ))}
          </ul>
          {sealed.state === 'searching' && (
            <p className="muted" role="status">
              Looking inside your private documents…
            </p>
          )}
          {sealed.items.length > 0 && (
            <>
              <h2 className="section-h">Also in your private documents</h2>
              <p className="muted">Only you can see these, so only your sign-in can search them.</p>
              <ul className="list">
                {sealed.items.map((h) => (
                  <HitRow
                    key={h.document_id}
                    hit={h}
                    types={types}
                    pick={select.pick(h.document_id)}
                    onOpen={() => void navigate(`/documents/${h.document_id}`)}
                    onChanged={actedOn(h.document_id)}
                  />
                ))}
              </ul>
            </>
          )}
          {sealed.state === 'done' && sealed.items.length === 0 && sealed.searched > 0 && (
            <p className="muted" role="status">
              Nothing in your {sealed.searched} private document
              {sealed.searched === 1 ? '' : 's'} matched.
            </p>
          )}
        </>
      )}
      {browse && (
        <ul className="list">
          {browse.length === 0 && <li className="muted">Nothing here yet.</li>}
          {browse.map((d) => (
            <DocRow
              key={d.id}
              doc={d}
              types={types}
              pick={select.pick(d.id)}
              onOpen={() => void navigate(`/documents/${d.id}`)}
              onChanged={actedOn(d.id)}
            />
          ))}
        </ul>
      )}
      {select.sheet}
    </main>
  );
}

/**
 * Search's Select (5.15): a box beside each result, and those chosen put in
 * a collection at once — all of them, or, if one has gone meanwhile, none. Only
 * where collections are offered; what is chosen stays chosen from one search to
 * the next, until it is put in a collection or Select is cancelled.
 */
function useSelect(offered: boolean) {
  const [on, setOn] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  // What the sheet said it put in a collection, for when it closes.
  const added = useRef<string | null>(null);
  const start = useRef<HTMLButtonElement>(null);
  const add = useRef<HTMLButtonElement>(null);

  const pick = (id: string): RowPick | undefined =>
    on
      ? {
          checked: picked.has(id),
          onChange: (yes) =>
            setPicked((was) => {
              const now = new Set(was);
              if (yes) now.add(id);
              else now.delete(id);
              return now;
            }),
        }
      : undefined;

  /** Chosen no longer: rows that have left the results by their own ⋯. */
  const drop = useCallback((ids: string[]) => {
    setPicked((was) => {
      if (!ids.some((id) => was.has(id))) return was;
      const now = new Set(was);
      for (const id of ids) now.delete(id);
      return now;
    });
  }, []);

  const begin = () => {
    flushSync(() => {
      setOn(true);
      setSaid(null);
    });
    // Select goes, and the boxes come: the first of them has the focus.
    document.querySelector<HTMLInputElement>('input.pick')?.focus();
  };

  const stop = () => {
    flushSync(() => {
      setOn(false);
      setPicked(new Set());
    });
    start.current?.focus();
  };

  const close = () => {
    const news = added.current;
    added.current = null;
    if (!news) {
      setAdding(false);
      setBusy(false);
      return;
    }
    // Put in a collection: done with these. What the sheet said stays said here.
    flushSync(() => {
      setAdding(false);
      setBusy(false);
      setOn(false);
      setPicked(new Set());
      setSaid(news);
    });
    start.current?.focus();
  };

  const tooMany = picked.size > MOST_AT_ONCE;
  const bar = offered ? (
    <div className="select-bar">
      <div className="row select-row">
        {on ? (
          <>
            <span className="select-count" role="status">
              {picked.size} selected
            </span>
            <button
              ref={add}
              type="button"
              className="btn btn-primary"
              disabled={picked.size === 0 || tooMany}
              onClick={() => setAdding(true)}
            >
              Add to a collection
            </button>
            <Button kind="quiet" onClick={stop}>
              Cancel
            </Button>
          </>
        ) : (
          <button ref={start} type="button" className="btn btn-quiet" onClick={begin}>
            Select
          </button>
        )}
      </div>
      {tooMany && <p className="muted">Up to {MOST_AT_ONCE} can go in a collection at once.</p>}
      <p className="notice status-line" role="status">
        {said}
      </p>
    </div>
  ) : null;

  const sheet = adding ? (
    <Sheet
      label={`Add ${documentsWord(picked.size)} to a collection`}
      busy={busy}
      returnFocus={add}
      onClose={close}
    >
      <AddToCollection
        documentIds={[...picked]}
        what={documentsWord(picked.size)}
        onClose={close}
        onBusy={setBusy}
        onAdded={(news) => {
          added.current = news;
        }}
      />
    </Sheet>
  ) : null;

  return { on, bar, sheet, pick, drop };
}

/** One issuer however it was written: "barclays" is "Barclays". */
function sameIssuer(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function HitRow({
  hit,
  types,
  pick,
  onOpen,
  onChanged,
}: {
  hit: SearchHit;
  types: DocumentTypeView[] | null;
  /** Chosen in Select (5.15). */
  pick: RowPick | undefined;
  onOpen: () => void;
  /** Its ⋯ changed something (5.4): the search is run again. */
  onChanged: () => void;
}) {
  const title = hit.title ?? 'Untitled';
  return (
    <li className="docrow">
      <RowMain title={title} pick={pick} onOpen={onOpen}>
        <span className="doc-title">{title}</span>
        <span className="muted">{rowLine(hit, types)}</span>
        <span className="snippet">{snippetParts(hit.snippet)}</span>
        <StatusBadge status={hit.status} />
      </RowMain>
      {/* A hit has no version or ETag: its ⋯ fetches the document on opening. */}
      <DocActions documentId={hit.document_id} title={title} onChanged={onChanged} />
    </li>
  );
}

/**
 * A search's snippet, as elements: the server marks each match with <em>
 * and </em>, and every other character is the document's own words, shown
 * as they are. Never an HTML string (5.35: a snippet may be a note's words,
 * and there is no path from a note to HTML).
 */
export function snippetParts(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  let marked = false;
  s.split(/(<em>|<\/em>)/).forEach((part, i) => {
    if (part === '<em>') marked = true;
    else if (part === '</em>') marked = false;
    else if (part) out.push(marked ? <em key={i}>{part}</em> : <Fragment key={i}>{part}</Fragment>);
  });
  return out;
}

export function PeopleScreen() {
  const { authVersion, caps, guarded, session } = useApp();
  const myRole: Role = session.info?.role ?? 'viewer';
  const { data, error, reload } = useLoad(
    async (t) => {
      const members = (await api.members(t)).items;
      // Only an adult may see who has been invited, so a teen's People
      // screen asks for the members and stops there.
      const invitations = can(myRole, 'member.invite')
        ? (await api.invitations(t)).items
        : ([] as Invitation[]);
      // Everybody sees these, because one of them may be about them.
      const changes = (await api.ownerChanges(t)).items;
      return { members, invitations, changes };
    },
    [authVersion],
  );
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [dob, setDob] = useState('');
  const [relationship, setRelationship] = useState('');
  // Their identity details next (5.27): only an owner changes somebody
  // else's (canEditIdentity), so only an owner is offered it.
  const detailsOffered =
    caps?.features.member_identity === true &&
    canEditIdentity({ role: myRole, memberId: null }, { id: '' }, 'shared');
  const [detailsNow, setDetailsNow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const letters = initialsFor(data?.members ?? []);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setAddError(null);
    try {
      const added = await guarded((t) =>
        api.addMember(t, {
          display_name: name,
          date_of_birth: dob || null,
          relationship: relationship.trim() || null,
        }),
      );
      if (added && detailsOffered && detailsNow) {
        // Straight to their profile, its Identity details' form open.
        void navigate(`/people/${added.id}`, { state: { editIdentity: true } });
        return;
      }
      setName('');
      setDob('');
      setRelationship('');
      setDetailsNow(false);
      setAdding(false);
      await reload();
    } catch (err) {
      setAddError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="page page-top page-wide has-nav">
      <TopBar title="People" />
      <PeopleTabs at="family" />
      <ErrorNote message={error} />
      <OwnerChangeNotices items={data?.changes ?? []} onChanged={reload} />
      <p className="muted">{data ? `${data.members.length} in the household` : ''}</p>
      <ul className="list">
        {/* A name here opens the person's profile (A64); back comes here. */}
        {(data?.members ?? []).map((m) => (
          <li key={m.id}>
            <button
              type="button"
              className="rowbtn person"
              onClick={() => void navigate(`/people/${m.id}`)}
            >
              <PersonAvatar person={m} initials={letters.get(m.id)} size={44} />
              <span>
                <strong>{m.display_name}</strong>
                <span className="muted">
                  {m.role ? roleLabel(m.role) : 'No sign-in'} · {m.document_count} document
                  {m.document_count === 1 ? '' : 's'}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {adding ? (
        <form onSubmit={(e) => void add(e)} className="card stack">
          <ErrorNote message={addError} />
          <Field
            id="member-name"
            label="Name of another family member"
            value={name}
            onChange={setName}
          />
          <Field
            id="member-dob"
            label="Date of birth"
            type="date"
            value={dob}
            onChange={setDob}
            required={false}
            hint="Optional. It is how we know whose birth certificate to ask about."
          />
          <Field
            id="member-relationship"
            label="Relationship (optional)"
            value={relationship}
            onChange={setRelationship}
            required={false}
            maxLength={60}
            hint="For example: Mum, Son, Grandad"
          />
          {detailsOffered && (
            <Check
              id="member-details-now"
              checked={detailsNow}
              onChange={setDetailsNow}
              label="Add their details now"
              note="Their name as on documents, ID numbers, addresses: their profile opens at them."
            />
          )}
          <div className="row">
            <Button type="submit" disabled={busy}>
              {busy ? 'Adding…' : 'Add'}
            </Button>
            <Button kind="quiet" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        can(myRole, 'member.add') && <Button onClick={() => setAdding(true)}>Add someone</Button>
      )}
      <InvitePanel
        members={data?.members ?? []}
        invitations={data?.invitations ?? []}
        onChanged={reload}
      />
    </main>
  );
}

export function RemindersScreen() {
  const { authVersion, withToken } = useApp();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const { data, reload } = useLoad(
    async (t) => {
      const [due, upcoming, docs, suggestions, hidden, types, profile] = await Promise.all([
        api.reminders(t, 'due'),
        api.reminders(t, 'upcoming'),
        api.documents(t, { sort: 'expiring', limit: 100 }),
        api.suggestions(t),
        api.suggestions(t, true),
        api.documentTypes(t),
        // The household's time zone, which every role reads: its day is the
        // vault's "today" for a snooze. Unanswered, the vault's own default.
        api.profile(t).catch(() => null),
      ]);
      const reminded = new Set([...due.items, ...upcoming.items].map((r) => r.document_id));
      return {
        due: due.items,
        upcoming: upcoming.items,
        // Documents in a bad state that have no reminder of their own.
        attention: docs.items.filter(
          (d) => ['expired', 'needs_info'].includes(d.status.value) && !reminded.has(d.id),
        ),
        suggestions: suggestions.items,
        profileAnswered: suggestions.profile_answered,
        hidden: hidden.items,
        types: types.items,
        timezone: profile?.timezone ?? 'UTC',
      };
    },
    [authVersion],
  );

  const act = async (fn: (t: string) => Promise<unknown>) => {
    setError(null);
    try {
      await withToken(fn);
      await reload();
    } catch (err) {
      setError(describeError(err));
    }
  };
  /**
   * A week and a month later — but a reminder about a date field, a bill's
   * due date, never waits past that date while it is ahead (the vault cuts
   * it back, 0.5.15): a snooze that would is offered as "On the day", once.
   * Ahead, and later, by the household's calendar, as the vault counts
   * them — not the browser's, nor UTC's (the 5.16b review): on the due day
   * itself, the vault refuses a snooze to it, and takes a week or a month.
   */
  const snoozes = (r: ReminderView): Array<{ label: string; until: string }> => {
    const today = localToday(data?.timezone ?? 'UTC');
    const about = r.source && r.source !== 'expires' ? aboutDate(r) : null;
    const held = about !== null && about > today ? about : null;
    const out: Array<{ label: string; until: string }> = [];
    for (const [label, days] of [
      ['A week', 7],
      ['A month', 30],
    ] as const) {
      const until = addDays(today, days);
      if (held === null || until <= held) out.push({ label, until });
      else if (!out.some((s) => s.label === 'On the day')) {
        out.push({ label: 'On the day', until: held });
      }
    }
    return out;
  };
  /** When a reminder coming up is next heard of: "Reminder on 3 Oct". */
  const remindsOn = (r: ReminderView) =>
    `Reminder on ${shortDate(
      (r.status === 'snoozed' && r.snoozed_until ? r.snoozed_until : r.fire_at).slice(0, 10),
    )}`;

  const count = (data?.due.length ?? 0) + (data?.attention.length ?? 0);
  return (
    <main className="page page-top page-wide has-nav">
      <TopBar title="Needs attention" />
      <ErrorNote message={error} />
      {data && count === 0 && (
        <p className="attention attention-calm" role="status">
          Everything is fine. Nothing needs your attention.
        </p>
      )}
      {data && count > 0 && (
        <p className="muted" role="status">
          {count} now, {data.upcoming.length} coming up
        </p>
      )}
      <ul className="list">
        {(data?.due ?? []).map((r) => (
          <li key={r.id} className="reminder">
            <button
              type="button"
              className="rowbtn"
              onClick={() => void navigate(`/documents/${r.document_id}`)}
            >
              {/* The date it is about, in its kind's words (0.5.15): never
                  "Overdue by 3 days" above a due date still ahead. */}
              <span className="status status-danger">{r.about ?? r.label}</span>
              <span className="doc-title">{r.document_title ?? 'Untitled'}</span>
              {r.note && <span className="muted">{r.note}</span>}
            </button>
            <div className="row">
              {snoozes(r).map((s) => (
                <Button
                  key={s.label}
                  kind="quiet"
                  onClick={() => void act((t) => api.snoozeReminder(t, r.id, s.until))}
                >
                  {s.label}
                </Button>
              ))}
              <Button
                kind="quiet"
                onClick={() => void act((t) => api.acknowledgeReminder(t, r.id))}
              >
                Done
              </Button>
            </div>
          </li>
        ))}
        {(data?.attention ?? []).map((d) => (
          <DocRow
            key={d.id}
            doc={d}
            types={data?.types}
            onOpen={() => void navigate(`/documents/${d.id}`)}
            onChanged={reload}
          />
        ))}
      </ul>
      {data && data.upcoming.length > 0 && (
        <section aria-labelledby="upcoming-h">
          <h2 id="upcoming-h" className="section-h">
            Coming up
          </h2>
          <ul className="list">
            {data.upcoming.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className="rowbtn"
                  onClick={() => void navigate(`/documents/${r.document_id}`)}
                >
                  <span className="doc-title">{r.document_title ?? 'Untitled'}</span>
                  {/* What it is about first, then when it comes (0.5.15). */}
                  {r.about && <span>{r.about}</span>}
                  <span className="muted">
                    {r.about ? remindsOn(r) : r.label}
                    {r.recurrence ? ' · repeats' : ''}
                    {r.note ? ` · ${r.note}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <Missing
        items={data?.suggestions ?? []}
        hidden={data?.hidden ?? []}
        profileAnswered={data?.profileAnswered ?? true}
        act={act}
      />
    </main>
  );
}

/**
 * The missing-document suggestions (REM-10). Each one says why it is here,
 * so "Not for us" is an informed answer — and it is reversible, which is
 * why the hidden ones are still offered back at the bottom.
 */
function Missing(props: {
  items: SuggestionView[];
  hidden: SuggestionView[];
  /** Null for a viewer, who is not told about the family (5.3). */
  profileAnswered: boolean | null;
  act: (fn: (t: string) => Promise<unknown>) => Promise<void>;
}) {
  const [showHidden, setShowHidden] = useState(false);
  if (props.items.length === 0 && props.hidden.length === 0) {
    // Only an answered "no" is an invitation to answer; a viewer's null is not.
    // The questions, on their own, with any answers already given, and back
    // here (5.35): Settings has none, and the first-run wizard goes on to
    // things only a new vault asks. Anybody else is told who can.
    return props.profileAnswered !== false ? null : (
      <section aria-labelledby="missing-h">
        <h2 id="missing-h" className="section-h">
          We noticed something missing
        </h2>
        {can(storedRole(), 'profile.edit') ? (
          <p className="muted">
            Answer a few questions about your household and this is where we will tell you what is
            not here yet. <Link to="/household-questions">Answer the questions</Link>
          </p>
        ) : (
          <p className="muted">
            Once an adult answers a few questions about your household, this is where we will tell
            you what is not here yet.
          </p>
        )}
      </section>
    );
  }
  return (
    <CollapsibleSection
      id="missing"
      title="We noticed something missing"
      count={props.items.length}
    >
      <ul className="list">
        {props.items.map((s) => (
          <li key={s.key} className="missing-row">
            <span className="doc-title">{s.title}</span>
            <span className="muted">{s.why}</span>
            {can(storedRole(), 'document.add') && (
              <div className="row">
                <Link to={addLink(s)} className="btn btn-quiet">
                  Add it
                </Link>
                <Button
                  kind="quiet"
                  onClick={() => void props.act((t) => api.dismissSuggestion(t, s.key))}
                >
                  Not for us
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {props.hidden.length > 0 &&
        (showHidden ? (
          <ul className="list">
            {props.hidden.map((s) => (
              <li key={s.key} className="missing-row">
                <span className="muted">{s.title}</span>
                <Button
                  kind="quiet"
                  onClick={() => void props.act((t) => api.restoreSuggestion(t, s.key))}
                >
                  Show it again
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <Button kind="quiet" onClick={() => setShowHidden(true)}>
            {props.hidden.length} hidden
          </Button>
        ))}
    </CollapsibleSection>
  );
}
