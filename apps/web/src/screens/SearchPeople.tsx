import {
  can,
  roleLabel,
  type DocumentTypeView,
  type DocumentView,
  type Role,
  type SuggestionView,
} from '@fdv/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, type Invitation, type Member, type SearchHit } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { storedRole } from '../session.js';
import {
  Avatar,
  BottomNav,
  Button,
  categoryLabel,
  CollapsibleSection,
  ErrorNote,
  Field,
  StatusBadge,
  TopBar,
} from '../ui.js';
import { addLink, DocRow, rowLine } from './Home.js';
import { InvitePanel } from './Invite.js';
import { OwnerChangeNotices, RoleControls } from './Roles.js';

/** How many of the household's issuers are offered as filter chips. */
const ISSUER_CHIPS = 8;

/**
 * Search: one field, live results, filter chips for person and category,
 * and for who issued it (0.4.10: "Barclays", "British Gas"). With no query
 * it browses — by category (from the home tiles), by person or by issuer —
 * because non-technical users browse before they search.
 */
export function SearchScreen() {
  const { withToken, authVersion } = useApp();
  const navigate = useNavigate();
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
  const { data: members } = useLoad(async (t) => (await api.members(t)).items, [authVersion]);
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
            setHits(r.items);
            setBrowse(null);
            const handle = r.sealed_pending.token;
            if (!handle) {
              setSealed({ state: 'idle', items: [], searched: 0 });
            } else {
              setSealed({ state: 'searching', items: [], searched: 0 });
              const more = await withToken((t) => api.searchSealed(t, handle));
              if (!cancelled)
                setSealed({
                  state: 'done',
                  items: more?.items ?? [],
                  searched: more?.searched ?? 0,
                });
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
            setBrowse(r.items);
            setHits(null);
            setSealed({ state: 'idle', items: [], searched: 0 });
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
  }, [q, category, memberId, issuer, withToken]);

  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  return (
    <main className="page page-top has-nav">
      <TopBar title="Search" />
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
            {m.display_name.split(' ')[0]}
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
      {hits && (
        <>
          <p className="muted" role="status">
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
                onOpen={() => void navigate(`/documents/${h.document_id}`)}
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
                    onOpen={() => void navigate(`/documents/${h.document_id}`)}
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
              onOpen={() => void navigate(`/documents/${d.id}`)}
            />
          ))}
        </ul>
      )}
      <BottomNav />
    </main>
  );
}

/** One issuer however it was written: "barclays" is "Barclays". */
function sameIssuer(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function HitRow({
  hit,
  types,
  onOpen,
}: {
  hit: SearchHit;
  types: DocumentTypeView[] | null;
  onOpen: () => void;
}) {
  return (
    <li>
      <button type="button" className="rowbtn" onClick={onOpen}>
        <span className="doc-title">{hit.title ?? 'Untitled'}</span>
        <span className="muted">{rowLine(hit, types)}</span>
        <span
          className="snippet"
          dangerouslySetInnerHTML={{ __html: sanitiseSnippet(hit.snippet) }}
        />
        <StatusBadge status={hit.status} />
      </button>
    </li>
  );
}

/** The server marks matches with <em>; everything else is escaped. */
export function sanitiseSnippet(s: string): string {
  const esc = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(/&lt;em&gt;/g, '<em>').replace(/&lt;\/em&gt;/g, '</em>');
}

export function PeopleScreen() {
  const { authVersion, guarded, session } = useApp();
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
  const [busy, setBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setAddError(null);
    try {
      await guarded((t) => api.addMember(t, { display_name: name, date_of_birth: dob || null }));
      setName('');
      setDob('');
      setAdding(false);
      await reload();
    } catch (err) {
      setAddError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="page page-top has-nav">
      <TopBar title="People" />
      <ErrorNote message={error} />
      <OwnerChangeNotices items={data?.changes ?? []} onChanged={reload} />
      <p className="muted">{data ? `${data.members.length} in the household` : ''}</p>
      <ul className="list">
        {(data?.members ?? []).map((m) => (
          <li key={m.id}>
            <button
              type="button"
              className="rowbtn person"
              onClick={() => void navigate(`/people/${m.id}`)}
            >
              <Avatar name={m.display_name} colour={m.colour} />
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
      <BottomNav />
    </main>
  );
}

export function PersonScreen() {
  const { id } = useParams<{ id: string }>();
  const { authVersion } = useApp();
  const navigate = useNavigate();
  const { data, error, reload } = useLoad(
    async (t) => {
      const [members, docs, types] = await Promise.all([
        api.members(t),
        api.documents(t, { member_id: id, limit: 100 }),
        api.documentTypes(t),
      ]);
      return {
        member: members.items.find((m) => m.id === id),
        docs: docs.items,
        types: types.items,
      };
    },
    [id, authVersion],
  );
  return (
    <main className="page page-top has-nav">
      <TopBar title={data?.member?.display_name ?? 'Person'} back="/people" />
      <ErrorNote message={error} />
      <ul className="list">
        {(data?.docs ?? []).map((d) => (
          <DocRow
            key={d.id}
            doc={d}
            types={data?.types}
            onOpen={() => void navigate(`/documents/${d.id}`)}
          />
        ))}
        {data && data.docs.length === 0 && <li className="muted">No documents yet.</li>}
      </ul>
      {data?.member && <RoleControls member={data.member} onChanged={reload} />}
      <BottomNav />
    </main>
  );
}

export function RemindersScreen() {
  const { authVersion, withToken } = useApp();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const { data, reload } = useLoad(
    async (t) => {
      const [due, upcoming, docs, suggestions, hidden, types] = await Promise.all([
        api.reminders(t, 'due'),
        api.reminders(t, 'upcoming'),
        api.documents(t, { sort: 'expiring', limit: 100 }),
        api.suggestions(t),
        api.suggestions(t, true),
        api.documentTypes(t),
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
  const today = new Date().toISOString().slice(0, 10);
  const plusDays = (n: number) => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  const count = (data?.due.length ?? 0) + (data?.attention.length ?? 0);
  return (
    <main className="page page-top has-nav">
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
              <span className="status status-danger">{r.label}</span>
              <span className="doc-title">{r.document_title ?? 'Untitled'}</span>
              {r.note && <span className="muted">{r.note}</span>}
            </button>
            <div className="row">
              <Button
                kind="quiet"
                onClick={() => void act((t) => api.snoozeReminder(t, r.id, plusDays(7)))}
              >
                A week
              </Button>
              <Button
                kind="quiet"
                onClick={() => void act((t) => api.snoozeReminder(t, r.id, plusDays(30)))}
              >
                A month
              </Button>
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
                  <span className="muted">
                    {r.label}
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
      <BottomNav />
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
    return props.profileAnswered !== false ? null : (
      <section aria-labelledby="missing-h">
        <h2 id="missing-h" className="section-h">
          We noticed something missing
        </h2>
        <p className="muted">
          Answer a few questions about your household and this is where we will tell you what is not
          here yet. <Link to="/settings">Settings</Link>
        </p>
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
