import {
  can,
  IDENTITY_AUDIENCE_LABELS,
  roleLabel,
  type PausedSignIn,
  type UploadRequestView,
} from '@fdv/shared';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, type Share } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { storedRole } from '../session.js';
import { Button, ConfirmDialog, ErrorNote, TopBar } from '../ui.js';
import { linkTarget, RequestRow, requestTarget, turnedBackOnWords } from './Sharing.js';

/**
 * "1 link is paused until you turn it back on", "2 links and 1 request you
 * made are paused"; since 5.28 an owner's sign-ins first: "1 sign-in, 2
 * links and 1 request are paused until you turn them back on".
 */
export function pausedWords(
  waiting: { links: number; requests: number; signIns?: number },
  owner: boolean,
): string {
  const signIns = waiting.signIns ?? 0;
  const count = (n: number, one: string, many: string) =>
    n > 0 ? `${n} ${n === 1 ? one : many}` : null;
  const parts = [
    count(signIns, 'sign-in', 'sign-ins'),
    count(waiting.links, 'link', 'links'),
    count(waiting.requests, 'request', 'requests'),
  ].filter((p): p is string => p !== null);
  const many = signIns + waiting.links + waiting.requests > 1;
  const last = parts.pop();
  const what = parts.length > 0 ? `${parts.join(', ')} and ${last ?? ''}` : (last ?? '');
  return owner
    ? `${what} ${many ? 'are' : 'is'} paused until you turn ${many ? 'them' : 'it'} back on`
    : `${what} you made ${many ? 'are' : 'is'} paused`;
}

/**
 * The way to After a restore (R1; in Settings until then): on Home, and
 * only while a restore has paused something the reader may decide about
 * (5.16) — an owner, any link; anybody else who may share, the links they
 * made, which only an owner turns back on. Requests to send documents count
 * too (5.22), and the sign-ins it paused, which only an owner is given
 * (5.28). Nothing at all otherwise: it is a task, not a place.
 */
export function AfterRestoreBanner() {
  const { authVersion } = useApp();
  const mayShare = can(storedRole(), 'document.share');
  const owner = can(storedRole(), 'restore.review');
  const { data: waiting } = useLoad(
    async (t) => {
      if (!mayShare) return null;
      const paused = await api.afterRestore(t);
      return {
        links: paused.links.length,
        requests: (paused.upload_requests ?? []).length,
        signIns: (paused.sign_ins ?? []).length,
      };
    },
    [authVersion, mayShare],
  );
  if (!waiting || waiting.links + waiting.requests + waiting.signIns === 0) return null;
  return (
    <Link to="/after-restore" className="attention attention-warn">
      <strong>After a restore</strong>
      <span className="muted">{pausedWords(waiting, owner)}</span>
    </Link>
  );
}

/**
 * After a restore (5.16): from Home, while a restore has paused something.
 *
 * A backup is the vault as it was when it was made: a link taken back since
 * is live again in it, and the line in the activity log that said who took
 * it back is gone. So a restore pauses every link, and each waits here for
 * an owner to say it still stands (A55), whoever made it. Anybody else who
 * may share sees the links they made, only to take back: not even a link
 * to their own Only me document, which no owner can see, is theirs to turn
 * back on, so the page says to take it back and make a new one.
 *
 * Requests to send documents wait here too (5.22, the API of 5.21): an owner
 * turns each back on; an adult sees their own, to take back — and their own
 * review-by-me request, which no owner can see, only to take back and ask
 * again.
 *
 * And the people whose sign-ins wait (5.28, A55): a restore pauses every
 * sign-in but the owners', and each role is as the backup had it, so an
 * owner sees it beside the name before turning the sign-in back on, one tap
 * each (a passkey or a code first, as for every power over a sign-in). A
 * restricted viewer's restriction is shown with it, in a sentence (5.32).
 */
export function AfterRestoreScreen() {
  const { caps, guarded, withToken, authVersion } = useApp();
  const identityKept = caps?.features.member_identity === true;
  const { data: identity } = useLoad(
    async (t) => (identityKept ? api.identityAudience(t) : null),
    [authVersion, identityKept],
  );
  const owner = can(storedRole(), 'restore.review');
  const {
    data: waiting,
    error: loadError,
    reload,
  } = useLoad(
    async (t) => {
      const paused = await api.afterRestore(t);
      return {
        links: paused.links,
        requests: paused.upload_requests ?? [],
        // An owner's alone; absent from a vault from before 5.28.
        signIns: paused.sign_ins ?? [],
      };
    },
    [authVersion],
  );
  const data = waiting?.links ?? null;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [asking, setAsking] = useState<UploadRequestView | null>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const returnTo = useRef<HTMLButtonElement | null>(null);

  const actOnRequest = async (r: UploadRequestView, how: 'resume' | 'revoke') => {
    setBusy(r.id);
    setError(null);
    try {
      const done =
        how === 'resume'
          ? await guarded((t) => api.resumeUploadRequest(t, r.id))
          : await withToken((t) => api.revokeUploadRequest(t, r.id));
      setAsking(null);
      if (done === null && how === 'resume') return;
      const what = requestTarget(r);
      const What = `${what.charAt(0).toUpperCase()}${what.slice(1)}`;
      setSaid(
        // Maybe still paused by its requester's sign-in (5.28): on, but not
        // working yet, as the vault answered.
        how === 'resume' && done
          ? turnedBackOnWords(what, done, done.requested_by_name ?? 'whoever asked')
          : `${What} is taken back. What was sent already stays.`,
      );
      await reload();
      status.current?.focus();
    } catch (err) {
      setAsking(null);
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  const act = async (link: Share, how: 'resume' | 'revoke') => {
    setBusy(link.id);
    setError(null);
    try {
      const done =
        how === 'resume'
          ? await guarded((t) => api.resumeShare(t, link.id))
          : await withToken((t) => api.revokeShare(t, link.id));
      if (done === null) return;
      const what = `The link to ${linkTarget(link, true)}`;
      setSaid(
        // Maybe still paused by its maker's sign-in (5.28): on, but not
        // working yet, as the vault answered.
        how === 'resume' && done
          ? turnedBackOnWords(what, done, done.created_by_name ?? 'whoever made it')
          : `${what} is taken back for good.`,
      );
      await reload();
      status.current?.focus();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  // A sign-in back on: they can sign in with their own password, as before.
  const resumeSignIn = async (s: PausedSignIn) => {
    if (busy !== null) return;
    setBusy(s.member_id);
    setError(null);
    try {
      const done = await guarded((t) => api.resumeMember(t, s.member_id));
      if (done === null) return;
      setSaid(`${s.display_name} can sign in again.`);
      await reload();
      status.current?.focus();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  const links = data ?? [];
  const requests = waiting?.requests ?? [];
  const signIns = waiting?.signIns ?? [];
  return (
    <main className="page page-top has-nav">
      <TopBar title="After a restore" back="/" />
      <p className="lede">
        The vault was put back from a backup. A link taken back after that backup was made would
        work again, so every link was paused.{' '}
        {owner
          ? 'Turn back on the ones that should still work.'
          : 'Only an owner can turn one back on.'}
      </p>
      {!owner && (
        <>
          <p className="muted">
            These are the links you made. An owner decides which of them work again, and you can
            take any of them back.
          </p>
          <p className="muted">
            No owner can see your Only me documents, so no one can turn a link to one of them back
            on. If it is still needed, take it back and make a new link.
          </p>
        </>
      )}
      {/* Every restore narrows who sees identity details (5.26): the rule,
          then how it is now, read from the vault — true however long ago the
          restore was, and whatever was waiting then (the 5.27 review). */}
      {caps?.features.member_identity && (
        <p className="muted" data-testid="restore-identity">
          A restore sets who can see identity details back to the owners and each person, and
          withdraws any wider audience that was waiting.
          {identity ? ` It is now: ${IDENTITY_AUDIENCE_LABELS[identity.audience]}.` : ''}{' '}
          {owner ? (
            <>
              To let more people see them again, choose it in{' '}
              <Link to="/settings/family" className="quiet-link">
                Settings → Family
              </Link>
              : it waits 72 hours, while everyone is told.
            </>
          ) : (
            'An owner can let more people see them again: it waits 72 hours, while everyone is told.'
          )}
        </p>
      )}
      <ErrorNote message={loadError ?? error} />
      <p className="notice" role="status" tabIndex={-1} ref={status} hidden={!said}>
        {said}
      </p>
      {signIns.length > 0 && (
        <section aria-labelledby="paused-sign-ins-h" className="stack">
          <h2 id="paused-sign-ins-h" className="section-h">
            Sign-ins waiting for you
          </h2>
          <p className="muted">
            Everyone but the owners was signed out, and can’t sign in until you turn their sign-in
            back on. Each role is as the backup had it: check it is still right first.
          </p>
          <ul className="list" aria-label="Paused sign-ins">
            {signIns.map((s) => (
              <li key={s.member_id} className="place">
                <div className="place-title">{s.display_name}</div>
                <div className="muted">Role: {roleLabel(s.role)}</div>
                {/* A restricted viewer's restriction, beside the role, to be
                    confirmed with it (A55, 5.32): read from the vault, and
                    read-only here; 5.33 gives owners the screens to change
                    it. A vault from before 5.32 sends none. */}
                {s.restriction && (
                  <div className="muted" data-testid="paused-restriction">
                    {s.restriction.summary}
                  </div>
                )}
                <div className="row">
                  {/* aria-disabled while one is on its way, not disabled:
                      "confirm it is you" gives focus back to it. */}
                  <button
                    type="button"
                    className="btn btn-primary"
                    aria-disabled={busy !== null}
                    aria-label={`Turn back on ${s.display_name}’s sign-in`}
                    onClick={() => void resumeSignIn(s)}
                  >
                    {busy === s.member_id ? 'Working…' : 'Turn back on'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="paused-links-h" className="stack">
        <h2 id="paused-links-h" className="section-h">
          {owner ? 'Links waiting for you' : 'Your paused links'}
        </h2>
        {data && links.length === 0 ? (
          <p className="muted">
            {requests.length > 0 || signIns.length > 0
              ? 'No link is waiting.'
              : 'Nothing is waiting. Every link you may decide about is decided.'}
          </p>
        ) : (
          <ul className="list">
            {links.map((link) => (
              <li key={link.id} className="place">
                <div className="place-title">
                  {link.collection_id ? linkTarget(link) : (link.document_title ?? 'A document')}
                </div>
                <div className="muted">
                  {[
                    link.recipient_label ? `For ${link.recipient_label}` : 'Shared by link',
                    link.created_by_name ? `made by ${link.created_by_name}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
                <div className="muted">
                  {link.has_pin ? 'Has a PIN. ' : ''}
                  Would work until{' '}
                  {new Date(link.expires_at).toLocaleDateString([], { dateStyle: 'long' })}.
                </div>
                <div className="row">
                  {owner && (
                    <Button disabled={busy !== null} onClick={() => void act(link, 'resume')}>
                      {busy === link.id ? 'Working…' : 'Turn back on'}
                    </Button>
                  )}
                  <Button
                    kind="quiet"
                    disabled={busy !== null}
                    onClick={() => void act(link, 'revoke')}
                  >
                    {busy === link.id && !owner ? 'Working…' : 'Take it back'}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      {requests.length > 0 && (
        <section aria-labelledby="paused-requests-h" className="stack">
          <h2 id="paused-requests-h" className="section-h">
            {owner ? 'Requests waiting for you' : 'Your paused requests'}
          </h2>
          <p className="muted">
            {owner
              ? 'Requests for someone to send documents were paused too. Their links open nothing until you turn them back on.'
              : 'Requests you made for someone to send documents were paused too. An owner decides which work again; you can take any of them back.'}
          </p>
          <ul className="list" aria-label="Paused requests">
            {requests.map((r) => (
              <RequestRow
                key={r.id}
                request={r}
                busy={busy !== null}
                owner={owner}
                onResume={() => void actOnRequest(r, 'resume')}
                onTakeBack={(button) => {
                  returnTo.current = button;
                  setAsking(r);
                }}
              />
            ))}
          </ul>
        </section>
      )}
      {asking && (
        <ConfirmDialog
          title="Take this request back?"
          confirmLabel="Take it back"
          busyLabel="Taking it back…"
          danger
          busy={busy !== null}
          returnFocus={returnTo}
          onConfirm={() => void actOnRequest(asking, 'revoke')}
          onCancel={() => setAsking(null)}
        >
          <p>
            {asking.recipient_label ?? 'Whoever has the link'} can no longer open it or send
            anything. What they have sent already stays, for you to look at. You can make a new
            request whenever you like.
          </p>
        </ConfirmDialog>
      )}
    </main>
  );
}
