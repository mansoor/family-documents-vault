import {
  can,
  documentLine,
  initialsFor,
  shortName,
  type DateValue,
  type DocumentTypeView,
  type DocumentView,
  type ResetNotice,
  type SuggestionView,
} from '@fdv/shared';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, type Member } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { collectionsOffered, CollectionsOnHome } from '../collections.js';
import { DocActions, type RowCollection } from '../DocActions.js';
import { IdentityNotice } from '../identity.js';
import { PersonAvatar } from '../person-avatar.js';
import { storedRole } from '../session.js';
import {
  BottomNav,
  Button,
  categoryLabel,
  CollapsibleSection,
  ErrorNote,
  StatusBadge,
} from '../ui.js';
import { mayBringBack, purgeAskedWords } from './Trash.js';

/**
 * Home is the whole product in one view: the needs-attention strip (the
 * only red on the screen, and empty most of the time), the people row,
 * category tiles with counts, and what was added recently.
 */
export function HomeScreen() {
  const { caps, authVersion } = useApp();
  const navigate = useNavigate();
  const { data, error, reload } = useLoad(
    async (t) => {
      const [members, counts, recent, docs, me, due, suggestions, types, asked] = await Promise.all(
        [
          api.members(t),
          api.counts(t),
          api.documents(t, { limit: 5, sort: 'recent' }),
          api.documents(t, { limit: 50, sort: 'expiring' }),
          api.me(t),
          api.reminders(t, 'due'),
          api.suggestions(t),
          api.documentTypes(t),
          // An owner asked to remove something you filed for good (5.24).
          api.documents(t, { deleted: 'true', purge_requested: 'true', limit: 50 }),
        ],
      );
      const reminded = new Set(due.items.map((r) => r.document_id));
      const attention = [
        ...due.items.map((r) => ({
          id: r.id,
          title: r.document_title ?? 'Untitled',
          // The date it is about, in its kind's words (0.5.15): "Due date:
          // 10 Oct, in 7 days".
          label: r.about ?? r.label,
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
        // Yours, that an owner has asked to remove for good: you may keep it.
        removals: asked.items.filter((d) => d.filed_by_me === true && d.purge_requested_at),
      };
    },
    [authVersion],
  );
  // Bumped when a row's ⋯ changed something (5.4): put in a collection, moved to
  // the Trash. The collections' counts are the vault's, so they are asked again.
  const [changes, setChanges] = useState(0);
  const changed = () => {
    setChanges((n) => n + 1);
    return reload();
  };

  const letters = initialsFor(data?.members ?? []);
  const names = shortName(data?.members ?? []);
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
      {/* A wider audience for identity details, waiting its 72 hours (5.27). */}
      <IdentityNotice memberId={data?.me.member_id} />
      {data?.me.reset_notice && (
        <ResetNoticeStrip notice={data.me.reset_notice} onSeen={() => void reload()} />
      )}
      <RemovalNotice items={data?.removals ?? []} memberId={data?.me.member_id} />
      <AttentionStrip items={data?.attention ?? []} />
      <MissingStrip items={data?.suggestions ?? []} />

      <section aria-labelledby="people-h">
        <h2 id="people-h" className="section-h">
          People
        </h2>
        <div className="people-row">
          {/* A name here opens that person's documents; their profile is
              People's (A64). Back from there comes back here. */}
          {(data?.members ?? []).map((m: Member) => (
            <Link
              key={m.id}
              to={`/people/${m.id}/documents`}
              state={{ from: '/' }}
              className="person-chip"
              aria-label={`${m.display_name}’s documents`}
            >
              <PersonAvatar person={m} initials={letters.get(m.id)} size={52} />
              <span>{names.get(m.id) ?? m.display_name}</span>
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

      {/* The way to the family's collections (5.15): only where the vault has
          them, and for those who make them. A viewer is given none. */}
      {collectionsOffered(caps, storedRole()) && (
        <CollectionsOnHome version={changes} quiet={error !== null} />
      )}

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
              onChanged={changed}
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
 * Documents you filed that an owner has asked to remove for good (5.24):
 * said here, where you will see it, as well as by email — the Trash is
 * where you bring one back to keep it, for a day from when you were told.
 */
/**
 * An owner was given a one-time link to set a new password for this sign-in
 * (5.29, path 2): said at every sign-in, until the person says they saw it.
 * Whoever used it knew the password it set, so it says what to do.
 */
export function ResetNoticeStrip(props: { notice: ResetNotice; onSeen: () => void }) {
  const { guarded } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const by = props.notice.by ?? 'An owner';
  const dayOf = (at: string) =>
    new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
  const day = dayOf(props.notice.at);
  const added = [
    ...(props.notice.passkeys_since ?? []).map(
      (k) => `A passkey${k.label ? ` called “${k.label}”` : ''}, on ${dayOf(k.added_at)}`,
    ),
    ...(props.notice.two_step_since
      ? [`Two-step sign-in, on ${dayOf(props.notice.two_step_since)}`]
      : []),
    ...(props.notice.links_since ?? []).map(
      (l) => `A share link${l.title ? ` to “${l.title}”` : ''}, made on ${dayOf(l.made_at)}`,
    ),
  ];
  const seen = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const done = await guarded((t) => api.dismissResetNotice(t));
      if (done !== null) props.onSeen();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="attention stack reset-notice" aria-labelledby="reset-notice-h">
      <h2 id="reset-notice-h" className="reset-notice-h">
        An owner made a link to reset your password
      </h2>
      <p>
        {`On ${day}, ${by} was given a one-time link to set a new password for your sign-in, to hand to you. If you didn’t ask for it, or someone else set the password you use now, change it in Settings and talk to them.`}
      </p>
      {/* What was added to the sign-in since the link was used (the 5.29
          review): whoever used it could have added it, and changing the
          password takes each away. */}
      {added.length > 0 && (
        <>
          <p>Added to your sign-in since the link was used:</p>
          <ul aria-label="Added since the link was used">
            {added.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
          <p>
            If you didn’t add them, change your password: that removes every one of them, and you
            add your own again.
          </p>
        </>
      )}
      <ErrorNote message={error} />
      <div className="row">
        <Link to="/settings" className="btn btn-quiet">
          Change your password
        </Link>
        <Button kind="quiet" disabled={busy} onClick={() => void seen()}>
          I’ve seen this
        </Button>
      </div>
    </section>
  );
}

function RemovalNotice({
  items,
  memberId,
}: {
  items: DocumentView[];
  memberId: string | undefined;
}) {
  if (items.length === 0) return null;
  const role = storedRole();
  return (
    <div className="attention removal-notice" role="status">
      <strong>
        {items.length === 1
          ? 'An owner wants to remove one of your documents for good'
          : `An owner wants to remove ${items.length} of your documents for good`}
      </strong>
      <ul>
        {items.slice(0, 3).map((d) => (
          <li key={d.id}>
            <span className="doc-title">“{d.title ?? 'Needs a name'}”</span>
            <span>{purgeAskedWords(d, mayBringBack(role, memberId, d))}</span>
          </li>
        ))}
      </ul>
      <Link to="/settings/trash" className="quiet-link">
        Open the Trash
      </Link>
    </div>
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
  onChanged,
  hint,
  collection,
  pick,
}: {
  doc: DocumentView;
  /** The vault's types, for the type's short name; the category until they arrive. */
  types?: ReadonlyArray<DocumentTypeView> | null | undefined;
  onOpen: () => void;
  /** Its ⋯ changed something (5.4): the list is loaded again. */
  onChanged: () => void | Promise<unknown>;
  /** On a collection's page, for its maker only: who in its audience is not given it (5.14). */
  hint?: string | null | undefined;
  /** The collection whose page this row is on (5.15). */
  collection?: RowCollection | undefined;
  /** Chosen in search's Select (5.15). */
  pick?: RowPick | undefined;
}) {
  const who =
    doc.visibility === 'adults' ? 'Adults only' : doc.visibility === 'private' ? 'Only me' : null;
  const title = doc.title ?? 'Scan · needs a name';
  return (
    <li className="docrow">
      <RowMain title={title} pick={pick} onOpen={onOpen}>
        <span className="doc-title">{title}</span>
        <span className="muted">
          <span>{rowLine(doc, types)}</span>
          {who && <span>{` · ${who}`}</span>}
        </span>
        <StatusBadge status={doc.status} />
        {hint && <span className="collection-hint">{hint}</span>}
      </RowMain>
      {/* Beside the row's button, never inside it: a button inside a
          button is not a button to anybody using a screen reader. */}
      <DocActions
        documentId={doc.id}
        title={title}
        doc={doc}
        onChanged={onChanged}
        collection={collection}
      />
    </li>
  );
}

/** Whether a row is chosen, in search's Select (5.15). */
export interface RowPick {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/**
 * A row's own part, beside its ⋯: a button that opens the document — or,
 * in search's Select (5.15), the label of the box that chooses it. The
 * whole row is then the box's to press, a thumb's width and more, and
 * pressing it ticks the box rather than leaving what is chosen behind.
 */
export function RowMain(props: {
  title: string;
  pick: RowPick | undefined;
  onOpen: () => void;
  children: ReactNode;
}) {
  if (!props.pick) {
    return (
      <button type="button" className="rowbtn" onClick={props.onOpen}>
        {props.children}
      </button>
    );
  }
  return (
    <label className="rowbtn rowpick">
      <PickBox title={props.title} pick={props.pick} />
      <span className="rowpick-words">{props.children}</span>
    </label>
  );
}

/** The box that chooses a row, named for it: its row is its label. */
function PickBox({ title, pick }: { title: string; pick: RowPick }) {
  return (
    <input
      type="checkbox"
      className="pick"
      checked={pick.checked}
      aria-label={`Select “${title}”`}
      onChange={(e) => pick.onChange(e.target.checked)}
    />
  );
}
