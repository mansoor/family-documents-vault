import type { DocumentView } from '@fdv/shared';
import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { api, type Member, type SearchHit } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { Avatar, BottomNav, Button, categoryLabel, ErrorNote, StatusBadge, TopBar } from '../ui.js';
import { DocRow } from './Home.js';

/**
 * Search: one field, live results, filter chips for person and category.
 * With no query it browses — by category (from the home tiles) or by
 * person — because non-technical users browse before they search.
 */
export function SearchScreen() {
  const { withToken, authVersion } = useApp();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const category = params.get('category') ?? '';
  const memberId = params.get('member') ?? '';
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [browse, setBrowse] = useState<DocumentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data: members } = useLoad(async (t) => (await api.members(t)).items, [authVersion]);

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
            }),
          );
          if (!cancelled && r) {
            setHits(r.items);
            setBrowse(null);
          }
        } else {
          const r = await withToken((t) =>
            api.documents(t, {
              category: category || undefined,
              member_id: memberId || undefined,
              limit: 100,
            }),
          );
          if (!cancelled && r) {
            setBrowse(r.items);
            setHits(null);
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
  }, [q, category, memberId, withToken]);

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
          className={`pill${!memberId && !category ? ' pill-on' : ''}`}
          onClick={() => {
            set('member', '');
            set('category', '');
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
      <ErrorNote message={error} />
      {hits && (
        <>
          <p className="muted" role="status">
            {hits.length} document{hits.length === 1 ? '' : 's'}, searched inside the pages too
          </p>
          <ul className="list">
            {hits.map((h) => (
              <li key={h.document_id}>
                <button
                  type="button"
                  className="rowbtn"
                  onClick={() => void navigate(`/documents/${h.document_id}`)}
                >
                  <span className="doc-title">{h.title ?? 'Untitled'}</span>
                  <span className="muted">{categoryLabel(h.category)}</span>
                  <span
                    className="snippet"
                    dangerouslySetInnerHTML={{ __html: sanitiseSnippet(h.snippet) }}
                  />
                  <StatusBadge status={h.status} />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {browse && (
        <ul className="list">
          {browse.length === 0 && <li className="muted">Nothing here yet.</li>}
          {browse.map((d) => (
            <DocRow key={d.id} doc={d} onOpen={() => void navigate(`/documents/${d.id}`)} />
          ))}
        </ul>
      )}
      <BottomNav />
    </main>
  );
}

/** The server marks matches with <em>; everything else is escaped. */
export function sanitiseSnippet(s: string): string {
  const esc = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(/&lt;em&gt;/g, '<em>').replace(/&lt;\/em&gt;/g, '</em>');
}

export function PeopleScreen() {
  const { authVersion } = useApp();
  const { data, error } = useLoad(async (t) => (await api.members(t)).items, [authVersion]);
  const navigate = useNavigate();
  return (
    <main className="page page-top has-nav">
      <TopBar title="People" />
      <ErrorNote message={error} />
      <p className="muted">{data ? `${data.length} in the household` : ''}</p>
      <ul className="list">
        {(data ?? []).map((m) => (
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
                  {m.role ? m.role.charAt(0).toUpperCase() + m.role.slice(1) : 'No sign-in'} ·{' '}
                  {m.document_count} document{m.document_count === 1 ? '' : 's'}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="muted">Inviting someone to sign in arrives in a later release.</p>
      <BottomNav />
    </main>
  );
}

export function PersonScreen() {
  const { id } = useParams<{ id: string }>();
  const { authVersion } = useApp();
  const navigate = useNavigate();
  const { data, error } = useLoad(
    async (t) => {
      const [members, docs] = await Promise.all([
        api.members(t),
        api.documents(t, { member_id: id, limit: 100 }),
      ]);
      return { member: members.items.find((m) => m.id === id), docs: docs.items };
    },
    [id, authVersion],
  );
  return (
    <main className="page page-top has-nav">
      <TopBar title={data?.member?.display_name ?? 'Person'} back="/people" />
      <ErrorNote message={error} />
      <ul className="list">
        {(data?.docs ?? []).map((d) => (
          <DocRow key={d.id} doc={d} onOpen={() => void navigate(`/documents/${d.id}`)} />
        ))}
        {data && data.docs.length === 0 && <li className="muted">No documents yet.</li>}
      </ul>
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
      const [due, upcoming, docs] = await Promise.all([
        api.reminders(t, 'due'),
        api.reminders(t, 'upcoming'),
        api.documents(t, { sort: 'expiring', limit: 100 }),
      ]);
      const reminded = new Set([...due.items, ...upcoming.items].map((r) => r.document_id));
      return {
        due: due.items,
        upcoming: upcoming.items,
        // Documents in a bad state that have no reminder of their own.
        attention: docs.items.filter(
          (d) => ['expired', 'needs_info'].includes(d.status.value) && !reminded.has(d.id),
        ),
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
          <DocRow key={d.id} doc={d} onOpen={() => void navigate(`/documents/${d.id}`)} />
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
      <BottomNav />
    </main>
  );
}
