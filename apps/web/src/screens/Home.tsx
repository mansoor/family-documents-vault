import type { DocumentView } from '@fdv/shared';
import { Link, useNavigate } from 'react-router';
import { api, type Member } from '../api.js';
import { useApp, useLoad } from '../app-context.js';
import { Avatar, BottomNav, categoryLabel, ErrorNote, StatusBadge } from '../ui.js';

/**
 * Home is the whole product in one view: the needs-attention strip (the
 * only red on the screen, and empty most of the time), the people row,
 * category tiles with counts, and what was added recently.
 */
export function HomeScreen() {
  const { caps, authVersion } = useApp();
  const navigate = useNavigate();
  const { data, error } = useLoad(
    async (t) => {
      const [members, counts, recent, attention, me] = await Promise.all([
        api.members(t),
        api.counts(t),
        api.documents(t, { limit: 5, sort: 'recent' }),
        api.documents(t, { limit: 50, sort: 'expiring' }),
        api.me(t),
      ]);
      return {
        me,
        members: members.items,
        counts,
        recent: recent.items,
        attention: attention.items.filter((d) =>
          ['expired', 'expiring_soon', 'needs_info'].includes(d.status.value),
        ),
      };
    },
    [authVersion],
  );

  const categories = (data?.counts.by_category ?? [])
    .filter((c) => c.category)
    .sort((a, b) => b.count - a.count);

  return (
    <main className="page page-top has-nav">
      <header className="topbar">
        <div style={{ flexGrow: 1 }}>
          <div className="muted" style={{ fontSize: 13 }}>
            Household
          </div>
          <h1 style={{ fontSize: 24 }}>{caps?.branding.display_name ?? 'Family Document Vault'}</h1>
        </div>
        <Link to="/settings" className="back" aria-label="Settings">
          ⚙
        </Link>
      </header>
      <ErrorNote message={error} />

      {data?.me.totp_required && (
        <Link to="/settings" className="attention" role="status">
          <strong>Switch on two-step sign-in</strong>
          <span className="muted">Owners must. It takes a minute, in Settings.</span>
        </Link>
      )}
      <AttentionStrip items={data?.attention ?? []} />

      <section aria-labelledby="people-h">
        <h2 id="people-h" className="section-h">
          People
        </h2>
        <div className="people-row">
          {(data?.members ?? []).map((m: Member) => (
            <Link key={m.id} to={`/people/${m.id}`} className="person-chip">
              <Avatar name={m.display_name} colour={m.colour} size={52} />
              <span>{m.display_name.split(' ')[0]}</span>
            </Link>
          ))}
          <Link to="/people" className="person-chip person-add" aria-label="Add a person">
            <span className="avatar avatar-add" aria-hidden="true">
              +
            </span>
            <span>Add</span>
          </Link>
        </div>
      </section>

      <section aria-labelledby="cats-h">
        <h2 id="cats-h" className="section-h">
          Categories
        </h2>
        {categories.length === 0 ? (
          <p className="muted">
            Nothing filed yet. Add your first document and it will appear here.
          </p>
        ) : (
          <div className="tiles">
            {categories.map((c) => (
              <Link key={c.category} to={`/search?category=${c.category}`} className="tile">
                <span className="tile-title">{categoryLabel(c.category)}</span>
                <span className="muted">
                  {c.count} item{c.count === 1 ? '' : 's'}
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="recent-h">
        <h2 id="recent-h" className="section-h">
          Recently added
        </h2>
        <ul className="list">
          {(data?.recent ?? []).map((d) => (
            <DocRow key={d.id} doc={d} onOpen={() => void navigate(`/documents/${d.id}`)} />
          ))}
        </ul>
      </section>
      <BottomNav />
    </main>
  );
}

function AttentionStrip({ items }: { items: DocumentView[] }) {
  if (items.length === 0) {
    return (
      <div className="attention attention-calm" role="status">
        Everything is fine. Nothing needs your attention.
      </div>
    );
  }
  return (
    <Link to="/reminders" className="attention" role="status">
      <strong>
        {items.length} thing{items.length === 1 ? '' : 's'} need{items.length === 1 ? 's' : ''}{' '}
        attention
      </strong>
      <ul>
        {items.slice(0, 3).map((d) => (
          <li key={d.id}>
            <span>{d.title ?? 'Untitled'}</span>
            <StatusBadge status={d.status} />
          </li>
        ))}
      </ul>
    </Link>
  );
}

export function DocRow({ doc, onOpen }: { doc: DocumentView; onOpen: () => void }) {
  return (
    <li>
      <button type="button" className="rowbtn" onClick={onOpen}>
        <span className="doc-title">{doc.title ?? 'Scan · needs a name'}</span>
        <span className="muted">
          {categoryLabel(doc.category)}
          {doc.visibility === 'adults'
            ? ' · Adults only'
            : doc.visibility === 'private'
              ? ' · Only me'
              : ''}
        </span>
        <StatusBadge status={doc.status} />
      </button>
    </li>
  );
}
