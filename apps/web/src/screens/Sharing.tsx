import { can, sharePagesNote } from '@fdv/shared';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, type Share } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { storedRole } from '../session.js';
import { BottomNav, ConfirmDialog, ErrorNote, TopBar } from '../ui.js';

/**
 * Settings → Sharing (5.19): every link outside the family the reader may
 * know about — to a document, or to a collection — in one list, each taken
 * back after asking (5.1's dialog). A collection's link is listed only to
 * whoever can see the collection and every document it was made with (or
 * made it), and never says how many went: the vault decides, and this
 * draws what it is given. For those who may share; nobody else has links.
 */

/** Still able to open: taken back, it opens nothing (a page opened on a used-up one lasts to its end). */
const working = (s: Share) => s.state === 'active' || s.state === 'used_up' || s.state === 'paused';

/**
 * What a link is to, in words: a document's title, or a collection's name —
 * at the start of a line, or inside a sentence.
 */
export function linkTarget(s: Share, inside = false): string {
  if (s.collection_id) {
    return `${inside ? 'the' : 'The'} collection “${s.collection_name ?? 'a collection'}”`;
  }
  return s.document_title ? `“${s.document_title}”` : inside ? 'a document' : 'A document';
}

export function SharingScreen() {
  const { withToken, authVersion } = useApp();
  const mayShare = can(storedRole(), 'document.share');
  const { data, error, reload } = useLoad(
    async (t) => (mayShare ? (await api.shares(t)).items : []),
    [authVersion, mayShare],
  );
  const [asking, setAsking] = useState<Share | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const returnTo = useRef<HTMLButtonElement | null>(null);

  const takeBack = async (s: Share) => {
    setBusy(true);
    setProblem(null);
    try {
      await withToken((t) => api.revokeShare(t, s.id));
      setAsking(null);
      setSaid(`The link to ${linkTarget(s, true)} is taken back.`);
      await reload();
      status.current?.focus();
    } catch (err) {
      setAsking(null);
      setProblem(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const links = data ?? [];
  const live = links.filter(working);
  const ended = links.filter((s) => !working(s)).slice(0, 20);
  return (
    <main className="page page-top has-nav">
      <TopBar title="Sharing" back="/settings" />
      <p className="lede">
        Links to documents and collections outside the family. Each works until its end, or until
        you take it back.
      </p>
      <ErrorNote message={error ?? problem} />
      <p className="notice status-line" role="status" tabIndex={-1} ref={status}>
        {said}
      </p>
      {!mayShare && <p className="muted">Only an adult can share a document outside the family.</p>}
      <section aria-labelledby="links-live-h" className="stack">
        <h2 id="links-live-h" className="section-h">
          Working now
        </h2>
        {data !== null && live.length === 0 && (
          <p className="muted">
            No link works now. Share a document from its page, or a collection from{' '}
            <Link to="/collections">its page</Link>.
          </p>
        )}
        <ul className="list" aria-label="Links that work now">
          {live.map((s) => (
            <LinkRow
              key={s.id}
              link={s}
              busy={busy}
              onTakeBack={(button) => {
                returnTo.current = button;
                setAsking(s);
              }}
            />
          ))}
        </ul>
      </section>
      {ended.length > 0 && (
        <section aria-labelledby="links-ended-h" className="stack">
          <h2 id="links-ended-h" className="section-h">
            No longer working
          </h2>
          <ul className="list" aria-label="Links that no longer work">
            {ended.map((s) => (
              <LinkRow key={s.id} link={s} busy={busy} />
            ))}
          </ul>
        </section>
      )}
      {asking && (
        <ConfirmDialog
          title="Take this link back?"
          confirmLabel="Take it back"
          busyLabel="Taking it back…"
          danger
          busy={busy}
          returnFocus={returnTo}
          onConfirm={() => void takeBack(asking)}
          onCancel={() => setAsking(null)}
        >
          <p>
            {asking.collection_id
              ? `Whoever has it can no longer open the documents it gives from ${linkTarget(asking, true)}, even on a page they have open now.`
              : `Whoever has it can no longer open ${linkTarget(asking, true)}, even on a page they have open now.`}{' '}
            You can make a new one whenever you like.
          </p>
        </ConfirmDialog>
      )}
      <BottomNav />
    </main>
  );
}

function LinkRow(props: {
  link: Share;
  busy: boolean;
  onTakeBack?: (button: HTMLButtonElement) => void;
}) {
  const s = props.link;
  const pages = s.document_id ? sharePagesNote(s.pages) : null;
  return (
    <li className="place">
      <div className="place-title">{linkTarget(s)}</div>
      <div className="muted">{s.summary}</div>
      {s.created_by_name && <div className="muted">Made by {s.created_by_name}</div>}
      {pages && <div className="status status-warn">{pages}</div>}
      {props.onTakeBack && (
        <div className="row">
          <button
            type="button"
            className="btn btn-quiet"
            disabled={props.busy}
            aria-label={`Take back the link to ${linkTarget(s, true)}${s.recipient_label ? `, shared with ${s.recipient_label}` : ''}`}
            onClick={(e) => props.onTakeBack?.(e.currentTarget)}
          >
            Take it back
          </button>
        </div>
      )}
    </li>
  );
}
