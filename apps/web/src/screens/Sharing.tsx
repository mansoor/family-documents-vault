import { can, sharePagesNote, type UploadRequestView } from '@fdv/shared';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, type Share } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { storedRole } from '../session.js';
import { BottomNav, Button, ConfirmDialog, ErrorNote, TopBar } from '../ui.js';

/**
 * Settings → Sharing (5.19): every link outside the family the reader may
 * know about — to a document, or to a collection — in one list, each taken
 * back after asking (5.1's dialog). A collection's link is listed only to
 * whoever can see the collection and every document it was made with (or
 * made it), and never says how many went: the vault decides, and this
 * draws what it is given. For those who may share; nobody else has links.
 *
 * Since 5.22 it lists the requests to send documents the reader reviews
 * too — their own, and those any adult reviews — with what each has had
 * (files received, visits used) and where it stands. Each can be taken
 * back, after asking; an owner turns one a restore paused back on. A teen
 * or a viewer sees none of it.
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

/** A request that can still be used, or is only paused: taking it back still means something. */
const requestWorking = (r: UploadRequestView) =>
  r.state === 'active' || r.state === 'paused' || r.state === 'used_up';

/** "No files yet · 1 of 3 visits used": what a request has had. */
export function requestTally(r: UploadRequestView): string {
  const files =
    r.files_received === 0
      ? 'No files yet'
      : r.files_received === 1
        ? '1 file received'
        : `${r.files_received} files received`;
  const visits =
    r.max_visits != null
      ? `${r.visits_used} of ${r.max_visits} ${r.max_visits === 1 ? 'visit' : 'visits'} used`
      : r.visits_used === 0
        ? 'Not opened yet'
        : r.visits_used === 1
          ? 'Opened once'
          : `Opened ${r.visits_used} times`;
  return `${files} · ${visits}`;
}

/** Where a request stands, in words, never colour alone (NFR-09). */
export function requestState(r: UploadRequestView): {
  words: string;
  tone: 'ok' | 'warn' | 'danger' | null;
} {
  const at = new Date(r.expires_at).toLocaleString([], {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  switch (r.state) {
    case 'active':
      return { words: `Working until ${at}`, tone: 'ok' };
    case 'paused':
      return { words: 'Paused after a restore', tone: 'warn' };
    case 'used_up':
      return { words: 'Opened as many times as it allows', tone: 'warn' };
    case 'expired':
      return { words: `Ended ${at}`, tone: null };
    case 'revoked':
      return { words: 'Taken back', tone: null };
    case 'locked':
      return { words: 'Stopped: a wrong password or code was typed ten times', tone: 'danger' };
    case 'closed':
      return {
        words:
          r.closed_reason === 'submitted'
            ? 'Closed when they finished sending'
            : r.closed_reason === 'requester_lost_right'
              ? 'Closed: whoever asked can no longer ask for documents'
              : 'Closed',
        tone: null,
      };
    default:
      return { words: String(r.state), tone: null };
  }
}

/** Whom a request is for, in a sentence: "the request to Jane, accountant". */
const requestTarget = (r: UploadRequestView) =>
  `the request “${r.title}”${r.recipient_label ? ` to ${r.recipient_label}` : ''}`;

export function SharingScreen() {
  const { withToken, guarded, authVersion } = useApp();
  const mayShare = can(storedRole(), 'document.share');
  const mayAsk = can(storedRole(), 'upload_request.create');
  const owner = can(storedRole(), 'restore.review');
  const { data, error, reload } = useLoad(
    async (t) => (mayShare ? (await api.shares(t)).items : []),
    [authVersion, mayShare],
  );
  const requests = useLoad(
    async (t) => (mayAsk ? (await api.uploadRequests(t)).items : []),
    [authVersion, mayAsk],
  );
  const [asking, setAsking] = useState<Share | null>(null);
  const [askingRequest, setAskingRequest] = useState<UploadRequestView | null>(null);
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

  const takeBackRequest = async (r: UploadRequestView) => {
    setBusy(true);
    setProblem(null);
    try {
      await withToken((t) => api.revokeUploadRequest(t, r.id));
      setAskingRequest(null);
      setSaid(`${capital(requestTarget(r))} is taken back. What was sent already stays.`);
      await requests.reload();
      status.current?.focus();
    } catch (err) {
      setAskingRequest(null);
      setProblem(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  // After a restore (A55): an owner says a paused request still stands.
  const resume = async (r: UploadRequestView) => {
    setBusy(true);
    setProblem(null);
    try {
      const done = await guarded((t) => api.resumeUploadRequest(t, r.id));
      if (done === null) return;
      setSaid(`${capital(requestTarget(r))} works again.`);
      await requests.reload();
      status.current?.focus();
    } catch (err) {
      setProblem(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const links = data ?? [];
  const live = links.filter(working);
  const ended = links.filter((s) => !working(s)).slice(0, 20);
  const asked = requests.data ?? [];
  const askedLive = asked.filter(requestWorking);
  const askedEnded = asked.filter((r) => !requestWorking(r)).slice(0, 20);
  return (
    <main className="page page-top has-nav">
      <TopBar title="Sharing" back="/settings" />
      <p className="lede">
        Links to documents and collections outside the family
        {mayAsk ? ', and requests for someone to send you documents' : ''}. Each works until its
        end, or until you take it back.
      </p>
      <ErrorNote message={error ?? requests.error ?? problem} />
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
      {mayAsk && (
        <section aria-labelledby="requests-h" className="stack">
          <h2 id="requests-h" className="section-h">
            Asking for documents
          </h2>
          <p className="muted">
            A link for someone outside the family to send you files — your accountant, a solicitor.
            They see nothing in the vault.
          </p>
          <Link to="/settings/sharing/ask" className="btn btn-primary ask-start">
            Ask for documents
          </Link>
          {requests.data !== null && askedLive.length === 0 && (
            <p className="muted">No request works now.</p>
          )}
          <ul className="list" aria-label="Requests that work now">
            {askedLive.map((r) => (
              <RequestRow
                key={r.id}
                request={r}
                busy={busy}
                owner={owner}
                onTakeBack={(button) => {
                  returnTo.current = button;
                  setAskingRequest(r);
                }}
                onResume={() => void resume(r)}
              />
            ))}
          </ul>
          {askedEnded.length > 0 && (
            <>
              <h3 className="section-h" id="requests-ended-h">
                Requests that have ended
              </h3>
              <ul className="list" aria-labelledby="requests-ended-h">
                {askedEnded.map((r) => (
                  <RequestRow key={r.id} request={r} busy={busy} owner={owner} />
                ))}
              </ul>
            </>
          )}
        </section>
      )}
      {askingRequest && (
        <ConfirmDialog
          title="Take this request back?"
          confirmLabel="Take it back"
          busyLabel="Taking it back…"
          danger
          busy={busy}
          returnFocus={returnTo}
          onConfirm={() => void takeBackRequest(askingRequest)}
          onCancel={() => setAskingRequest(null)}
        >
          <p>
            {askingRequest.recipient_label ?? 'Whoever has the link'} can no longer open it or send
            anything, even on a page they have open now. What they have sent already stays, for you
            to look at. You can make a new request whenever you like.
          </p>
        </ConfirmDialog>
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

const capital = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);

function RequestRow(props: {
  request: UploadRequestView;
  busy: boolean;
  owner: boolean;
  onTakeBack?: (button: HTMLButtonElement) => void;
  onResume?: () => void;
}) {
  const r = props.request;
  const state = requestState(r);
  const who = [
    r.recipient_label ? `For ${r.recipient_label}` : null,
    !r.mine && r.requested_by_name ? `Asked by ${r.requested_by_name}` : null,
    r.review_by === 'adults' ? 'Any adult looks at what comes in' : null,
  ].filter(Boolean);
  return (
    <li className="place">
      <div className="place-title">“{r.title}”</div>
      {who.length > 0 && <div className="muted">{who.join(' · ')}</div>}
      <div className="muted">{requestTally(r)}</div>
      <div className={`request-state${state.tone ? ` status status-${state.tone}` : ' muted'}`}>
        {state.words}
      </div>
      {(props.onTakeBack || (props.onResume && props.owner && r.state === 'paused')) && (
        <div className="row">
          {props.onResume && props.owner && r.state === 'paused' && (
            <Button disabled={props.busy} onClick={props.onResume}>
              Turn back on
            </Button>
          )}
          {props.onTakeBack && (
            <button
              type="button"
              className="btn btn-quiet"
              disabled={props.busy}
              aria-label={`Take back ${requestTarget(r)}`}
              onClick={(e) => props.onTakeBack?.(e.currentTarget)}
            >
              Take it back
            </button>
          )}
        </div>
      )}
    </li>
  );
}
