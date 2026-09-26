import {
  can,
  documentLine,
  type DateValue,
  type DocumentTypeView,
  type DocumentView,
  type SuggestionView,
} from '@fdv/shared';
import { Link, useNavigate } from 'react-router';
import { api, type Member } from '../api.js';
import { useApp, useLoad } from '../app-context.js';
import { storedRole } from '../session.js';
import {
  Avatar,
  BottomNav,
  categoryLabel,
  CollapsibleSection,
  ErrorNote,
  StatusBadge,
} from '../ui.js';

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
      const [members, counts, recent, docs, me, due, suggestions, types] = await Promise.all([
        api.members(t),
        api.counts(t),
        api.documents(t, { limit: 5, sort: 'recent' }),
        api.documents(t, { limit: 50, sort: 'expiring' }),
        api.me(t),
        api.reminders(t, 'due'),
        api.suggestions(t),
        api.documentTypes(t),
      ]);
      const reminded = new Set(due.items.map((r) => r.document_id));
      const attention = [
        ...due.items.map((r) => ({
          id: r.id,
          title: r.document_title ?? 'Untitled',
          label: r.label,
          tone: 'danger' as const,
        })),
        ...docs.items
          .filter((d) => ['expired', 'needs_info'].includes(d.status.value) && !reminded.has(d.id))
          .map((d) => ({
            id: d.id,
            title: d.title ?? 'Scan · needs a name',
            label: d.status.label,
            tone: 'warn' as const,
          })),
      ];
      return {
        me,
        members: members.items,
        counts,
        recent: recent.items,
        attention,
        suggestions: suggestions.items,
        types: types.items,
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
      <MissingStrip items={data?.suggestions ?? []} />

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
          {can(storedRole(), 'member.add') && (
            <Link to="/people" className="person-chip person-add" aria-label="Add a person">
              <span className="avatar avatar-add" aria-hidden="true">
                +
              </span>
              <span>Add</span>
            </Link>
          )}
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
            <DocRow
              key={d.id}
              doc={d}
              types={data?.types}
              onOpen={() => void navigate(`/documents/${d.id}`)}
            />
          ))}
        </ul>
      </section>
      <BottomNav />
    </main>
  );
}

/**
 * "Missing is the quiet superpower": because the family told the wizard it
 * owns a home and has a child, the app can draw an empty tile for the deed
 * that is not here. Deliberately not part of the red strip above — nothing
 * is wrong, there is just something worth adding.
 */
function MissingStrip({ items }: { items: SuggestionView[] }) {
  // Every tile here is an invitation to add something. Somebody who
  // cannot add anything is being shown a list of jobs for other people.
  if (items.length === 0 || !can(storedRole(), 'document.add')) return null;
  return (
    <CollapsibleSection id="home-missing" title="We noticed something missing" count={items.length}>
      <div className="tiles">
        {items.slice(0, 2).map((s) => (
          <Link key={s.key} to={addLink(s)} className="tile tile-missing">
            <span className="tile-title">{s.title}</span>
            <span className="muted">{s.why}</span>
            <span className="tile-cue">Add it</span>
          </Link>
        ))}
      </div>
      {items.length > 2 && (
        <Link to="/reminders" className="muted seeall">
          {items.length - 2} more like this
        </Link>
      )}
    </CollapsibleSection>
  );
}

/** Straight into Add, with the type and person already chosen. */
export function addLink(s: SuggestionView): string {
  const q = new URLSearchParams({ type: s.type_key });
  if (s.member_id) q.set('member', s.member_id);
  return `/add?${q.toString()}`;
}

function AttentionStrip({
  items,
}: {
  items: Array<{ id: string; title: string; label: string; tone: 'danger' | 'warn' }>;
}) {
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
            <span>{d.title}</span>
            <span className={`status status-${d.tone}`}>{d.label}</span>
          </li>
        ))}
      </ul>
    </Link>
  );
}

/**
 * The line under a document's name: what it is, who issued it and when —
 * "Bank statement · Barclays · Sep 2026" — so a dozen statements are told
 * apart at a glance. Without a type, its category says what kind of thing
 * it is.
 */
export function rowLine(
  doc: {
    type_key: string | null;
    category: string | null;
    issued_by?: string | null;
    issued?: DateValue | null;
  },
  types: ReadonlyArray<DocumentTypeView> | null | undefined,
): string {
  const type = types?.find((t) => t.key === doc.type_key) ?? null;
  const line = documentLine({ type, issued_by: doc.issued_by ?? null, issued: doc.issued ?? null });
  return type ? line : [categoryLabel(doc.category), line].filter(Boolean).join(' · ');
}

export function DocRow({
  doc,
  types,
  onOpen,
}: {
  doc: DocumentView;
  /** The vault's types, for the type's short name; the category until they arrive. */
  types?: ReadonlyArray<DocumentTypeView> | null | undefined;
  onOpen: () => void;
}) {
  const who =
    doc.visibility === 'adults' ? 'Adults only' : doc.visibility === 'private' ? 'Only me' : null;
  return (
    <li>
      <button type="button" className="rowbtn" onClick={onOpen}>
        <span className="doc-title">{doc.title ?? 'Scan · needs a name'}</span>
        <span className="muted">
          <span>{rowLine(doc, types)}</span>
          {who && <span>{` · ${who}`}</span>}
        </span>
        <StatusBadge status={doc.status} />
      </button>
    </li>
  );
}
