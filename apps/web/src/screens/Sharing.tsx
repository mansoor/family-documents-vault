import {
  can,
  emailedToWords,
  ENDED_SHARING_KEPT_NOTE,
  endedSharingWords,
  sharePagesNote,
  textedToWords,
  type UploadRequestView,
} from '@fdv/shared';
import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Link, useLocation } from 'react-router';
import { api, type Share } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { storedRole } from '../session.js';
import { useShellMode } from '../shell.js';
import { None, useGrid } from '../table-grid.js';
import { Button, ConfirmDialog, ErrorNote, TopBar } from '../ui.js';
import { changeLinkLabel, changeLinkPath, showLinkLabel } from './Share.js';
import { linkTarget, requestTarget, useShowAgain } from './LinkHandOver.js';
import { LinkOpens } from '../link-opens.js';
import { dateTimeWords, familyZoneNow } from '../family-time.js';

// Said as they always were, by Sharing's neighbours too (After a restore).
export { linkTarget, requestTarget };

/**
 * Sharing (5.19): every link outside the family the reader may
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
 *
 * Since 0.9.0 (the owner's decision of 11 Nov 2026) a link the reader made
 * can be shown again — the link, and its PIN or the password the vault made
 * up — after confirming it's them, from "Show the link" on its row; closed,
 * it is hidden again. A link made before the vault kept copies stays shown
 * once, and has no such button.
 *
 * Since 0.9.0 (LK; the owner's decision of 15 Nov 2026) a link or a request
 * the reader made can be changed — Change opens the form it was made with,
 * filled in — and a request can be shown again, as a link is. Ended ones
 * cannot: they are made anew.
 *
 * Since 0.9.0 (RQ; the owner's ask of 16 Nov 2026) requests are a table too,
 * from 768 px, as links are — Working now, then No longer working — and the
 * list on a phone. What no longer works shows its first 20 and "Show N
 * more" for the rest (no longer cut off at 20): the vault removes each a
 * while after it ended (Settings → Privacy, 90 days unless an owner chose
 * otherwise), and Sharing says how long beside them.
 *
 * Since 0.9.0-dev.69 (the owner's feedback of 18 Nov 2026) links and
 * requests are shown and changed alike, here and wherever else they are
 * listed: Show the link is one dialog for both (LinkHandOver.tsx) — the link
 * with Copy and Send, its PIN or password, and the vault's Email the link
 * and Text the link — and Change opens a page of its own for both, a link's
 * at /sharing/links/{id}. Each row says where the vault last emailed or
 * texted it.
 */

/** Ended links, or ended requests, shown before "Show N more". */
export const ENDED_SHOWN = 20;

/** Still able to open: taken back, it opens nothing (a page opened on a used-up one lasts to its end). */
const working = (s: Share) => s.state === 'active' || s.state === 'used_up' || s.state === 'paused';

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

/**
 * Where a request stands, in words, never colour alone (NFR-09). A paused
 * one says who can turn it back on: an owner (who is reading, or who is
 * not), or — for an adult's own review-by-me request, which no owner can
 * see — nobody, so it is taken back and asked again (the 5.22 review).
 */
export function requestState(
  r: UploadRequestView,
  owner: boolean,
): {
  words: string;
  tone: 'ok' | 'warn' | 'danger' | null;
} {
  const at = dateTimeWords(r.expires_at, familyZoneNow(), { date: 'medium' });
  switch (r.state) {
    case 'active':
      return { words: `Working until ${at}`, tone: 'ok' };
    case 'paused':
      // 5.28: whoever asked has their sign-in locked, or waiting after a
      // restore. Nobody turns the request on: it opens again with them.
      // Said so only to an owner and to whoever asked; anybody else is
      // given no reason, and told it is paused (the 5.28 review).
      if (r.paused_reason === 'locked') {
        return {
          words: `Paused while the sign-in of ${r.requested_by_name ?? 'whoever asked'} is locked. It works again once they are unlocked.`,
          tone: 'warn',
        };
      }
      if (r.paused_reason === 'sign_in_paused') {
        return {
          words: `Paused until the sign-in of ${r.requested_by_name ?? 'whoever asked'} is turned back on after the restore.`,
          tone: 'warn',
        };
      }
      if (r.paused_reason !== 'restored') return { words: 'Paused for now', tone: 'warn' };
      return {
        words: owner
          ? 'Paused after a restore'
          : r.mine && r.review_by === 'me'
            ? 'Paused after a restore. Only you can see it, so nobody can turn it back on: take it back and ask again.'
            : 'Paused after a restore, until an owner turns it back on.',
        tone: 'warn',
      };
    case 'used_up':
      return { words: 'Opened as many times as it allows', tone: 'warn' };
    case 'expired':
      return { words: `Ended ${at}`, tone: null };
    case 'revoked':
      return { words: 'Taken back', tone: null };
    case 'locked':
      // A request may ask for a PIN since 0.9.0-dev.69.
      return {
        words: 'Stopped: a wrong PIN, password or code was typed ten times',
        tone: 'danger',
      };
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

/**
 * What turning on a link or a request a restore paused did, said by what the
 * vault answered (the 5.28 second round): it works again, or it is on and
 * still paused by the sign-in of whoever made it or asked — locked, until
 * they are unlocked; or waiting after the restore, until that is turned back
 * on too. Sharing's and After a restore's.
 */
export function turnedBackOnWords(
  what: string,
  done: { state: string; paused_reason?: string | null },
  who: string,
): string {
  const What = capital(what);
  if (done.state !== 'paused') return `${What} works again.`;
  if (done.paused_reason === 'locked') {
    return `${What} is turned back on. It stays paused until ${who} is unlocked, from their page.`;
  }
  if (done.paused_reason === 'sign_in_paused') {
    return `${What} is turned back on. It works once ${who} can sign in again: turn their sign-in back on too.`;
  }
  return `${What} is turned back on, but it is still paused for now.`;
}

export function SharingScreen() {
  const { withToken, guarded, authVersion, caps } = useApp();
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
  // A link or a request shown again (0.9.0; one way for both since
  // 0.9.0-dev.69): held only while its dialog is open.
  const reveal = useShowAgain(() => {
    void reload();
    void requests.reload();
  });
  const [askingRequest, setAskingRequest] = useState<UploadRequestView | null>(null);
  // Every ended link, or request, once asked for: the first 20 until then.
  const [allEnded, setAllEnded] = useState(false);
  const [allAskedEnded, setAllAskedEnded] = useState(false);
  // Where the ended links and requests are, for the focus once more are shown.
  const endedAt = useRef<HTMLElement>(null);
  const askedEndedAt = useRef<HTMLDivElement>(null);
  // How long ended ones are kept (0.9.0, RQ), said beside them.
  const keeping = useLoad(
    async (t) =>
      caps?.features.ended_sharing === true && (mayShare || mayAsk)
        ? await api.endedSharing(t)
        : null,
    [authVersion, caps?.features.ended_sharing, mayShare, mayAsk],
  );
  const keptWords =
    keeping.data != null
      ? `${endedSharingWords(keeping.data.remove_after_days)} ${ENDED_SHARING_KEPT_NOTE}`
      : null;
  const [acting, setBusy] = useState(false);
  const busy = acting || reveal.busy;
  const [problem, setProblem] = useState<string | null>(null);
  // A link or a request changed on its own page comes back saying so.
  const location = useLocation();
  const [said, setSaid] = useState<string | null>(
    () => (location.state as { said?: unknown } | null)?.said?.toString() ?? null,
  );
  const status = useRef<HTMLParagraphElement>(null);
  const returnTo = useRef<HTMLButtonElement | null>(null);
  // From 768 px the links are tables, as in the prototype; on a phone, the list.
  const wide = useShellMode() !== 'phone';
  const askToTakeBack = (s: Share, button: HTMLButtonElement) => {
    returnTo.current = button;
    setAsking(s);
  };

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
      // As the vault answered: its requester's sign-in may still hold it (5.28).
      setSaid(turnedBackOnWords(requestTarget(r), done, done.requested_by_name ?? 'whoever asked'));
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
  const endedAll = links.filter((s) => !working(s));
  const ended = allEnded ? endedAll : endedAll.slice(0, ENDED_SHOWN);
  const asked = requests.data ?? [];
  const askedLive = asked.filter(requestWorking);
  const askedEndedAll = asked.filter((r) => !requestWorking(r));
  const askedEnded = allAskedEnded ? askedEndedAll : askedEndedAll.slice(0, ENDED_SHOWN);
  const askToTakeBackRequest = (r: UploadRequestView, button: HTMLButtonElement | null) => {
    returnTo.current = button;
    setAskingRequest(r);
  };
  return (
    <main className="page page-top page-wide has-nav">
      <TopBar title="Sharing" />
      <p className="lede">
        Links to documents and collections outside the family
        {mayAsk ? ', and requests for someone to send you documents' : ''}. Each works until its
        end, or until you take it back.
      </p>
      <ErrorNote message={error ?? requests.error ?? problem ?? reveal.problem} />
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
        {wide ? (
          live.length > 0 && (
            <LinksTable
              links={live}
              caption="Links that work now"
              busy={busy}
              onTakeBack={askToTakeBack}
              onShow={(s, button) => void reveal.showLink(s, button)}
              change
            />
          )
        ) : (
          <ul className="list" aria-label="Links that work now">
            {live.map((s) => (
              <LinkRow
                key={s.id}
                link={s}
                busy={busy}
                onTakeBack={(button) => askToTakeBack(s, button)}
                onShow={(button) => void reveal.showLink(s, button)}
                change
              />
            ))}
          </ul>
        )}
      </section>
      {ended.length > 0 && (
        <section ref={endedAt} aria-labelledby="links-ended-h" className="stack">
          <h2 id="links-ended-h" className="section-h">
            No longer working
          </h2>
          {keptWords && <p className="muted">{keptWords}</p>}
          {wide ? (
            <LinksTable links={ended} caption="Links that no longer work" busy={busy} />
          ) : (
            <ul className="list" aria-label="Links that no longer work">
              {ended.map((s) => (
                <LinkRow key={s.id} link={s} busy={busy} />
              ))}
            </ul>
          )}
          <ShowMore
            hidden={endedAll.length - ended.length}
            what="links that no longer work"
            onShow={() => {
              flushSync(() => setAllEnded(true));
              focusRow(endedAt.current, ENDED_SHOWN);
            }}
          />
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
          <Link to="/sharing/ask" className="btn btn-primary ask-start">
            Ask for documents
          </Link>
          <h3 className="section-h" id="requests-live-h">
            Working now
          </h3>
          {requests.data !== null && askedLive.length === 0 && (
            <p className="muted">No request works now.</p>
          )}
          {wide ? (
            askedLive.length > 0 && (
              <RequestsTable
                requests={askedLive}
                caption="Requests that work now"
                busy={busy}
                owner={owner}
                onTakeBack={askToTakeBackRequest}
                onResume={(r) => void resume(r)}
                onShow={(r, button) => void reveal.showRequest(r, button)}
              />
            )
          ) : (
            <ul className="list" aria-label="Requests that work now">
              {askedLive.map((r) => (
                <RequestRow
                  key={r.id}
                  request={r}
                  busy={busy}
                  owner={owner}
                  onTakeBack={(button) => askToTakeBackRequest(r, button)}
                  onResume={() => void resume(r)}
                  onShow={(button) => void reveal.showRequest(r, button)}
                />
              ))}
            </ul>
          )}
          {askedEnded.length > 0 && (
            <div ref={askedEndedAt} className="stack">
              <h3 className="section-h" id="requests-ended-h">
                No longer working
              </h3>
              {keptWords && <p className="muted">{keptWords}</p>}
              {wide ? (
                <RequestsTable
                  requests={askedEnded}
                  caption="Requests that no longer work"
                  busy={busy}
                  owner={owner}
                />
              ) : (
                <ul className="list" aria-label="Requests that no longer work">
                  {askedEnded.map((r) => (
                    <RequestRow key={r.id} request={r} busy={busy} owner={owner} />
                  ))}
                </ul>
              )}
              <ShowMore
                hidden={askedEndedAll.length - askedEnded.length}
                what="requests that no longer work"
                onShow={() => {
                  flushSync(() => setAllAskedEnded(true));
                  focusRow(askedEndedAt.current, ENDED_SHOWN);
                }}
              />
            </div>
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
      {reveal.dialog}
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
    </main>
  );
}

function LinkRow(props: {
  link: Share;
  busy: boolean;
  onTakeBack?: (button: HTMLButtonElement) => void;
  onShow?: (button: HTMLButtonElement) => void;
  /**
   * Change it (0.9.0, LK), on its own page since 0.9.0-dev.69: on its row,
   * when it is the reader's to change.
   */
  change?: boolean;
}) {
  const s = props.link;
  const pages = s.document_id ? sharePagesNote(s.pages) : null;
  const show = s.revealable === true ? props.onShow : undefined;
  const change = s.changeable === true && props.change === true;
  return (
    <li className="place">
      <div className="place-title">{linkTarget(s)}</div>
      <div className="muted">{s.summary}</div>
      <SentWords item={s} block />
      {s.created_by_name && <div className="muted">Made by {s.created_by_name}</div>}
      {/* Who opened it, when (0.9.0, H5). */}
      <LinkOpens link={s} />
      {pages && <div className="status status-warn">{pages}</div>}
      {(props.onTakeBack || show || change) && (
        <div className="row">
          {show && (
            <button
              type="button"
              className="btn btn-quiet"
              disabled={props.busy}
              aria-label={showLabel(s)}
              onClick={(e) => show(e.currentTarget)}
            >
              Show the link
            </button>
          )}
          {change && <ChangeLinkLink link={s} />}
          {props.onTakeBack && (
            <button
              type="button"
              className="btn btn-quiet"
              disabled={props.busy}
              aria-label={takeBackLabel(s)}
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

/**
 * Where the vault last sent a link or a request (0.9.0; texts since
 * 0.9.0-dev.69), and by whom when it was somebody else: under its row.
 */
function SentWords(props: {
  item: Pick<Share, 'emailed_to' | 'emailed_by_name' | 'texted_to' | 'texted_by_name' | 'mine'>;
  /** A line each (a list's row), or within a table's cell. */
  block?: boolean;
}) {
  const { item } = props;
  const lines = [
    item.emailed_to ? emailedToWords(item.emailed_to, item.emailed_by_name, item.mine) : null,
    item.texted_to ? textedToWords(item.texted_to, item.texted_by_name, item.mine) : null,
  ].filter((l): l is string => l !== null);
  return (
    <>
      {lines.map((line) =>
        props.block ? (
          <div key={line} className="muted">
            {line}
          </div>
        ) : (
          <span key={line} className="muted cell-sub">
            {line}
          </span>
        ),
      )}
    </>
  );
}

/** Change, to the link's own page (0.9.0-dev.69), coming back here when done. */
function ChangeLinkLink(props: { link: Share; small?: boolean }) {
  return (
    <Link
      to={changeLinkPath(props.link)}
      state={{ back: '/sharing' }}
      className={`btn btn-quiet${props.small ? ' btn-small' : ''}`}
      aria-label={changeLabel(props.link)}
    >
      Change
    </Link>
  );
}

/** "Show the link to “Mansoor’s passport”, shared with the visa agent" */
const showLabel = (s: Share) => showLinkLabel(linkTarget(s, true), s);

/** "Change the link to “Mansoor’s passport”, shared with the visa agent" */
const changeLabel = (s: Share) => changeLinkLabel(linkTarget(s, true), s);

/** "Take back the link to “Mansoor’s passport”, shared with the visa agent" */
const takeBackLabel = (s: Share) =>
  `Take back the link to ${linkTarget(s, true)}${s.recipient_label ? `, shared with ${s.recipient_label}` : ''}`;

/**
 * Links as a table, from 768 px (the prototype's): what each is to, whom it
 * is for, where it stands in the vault's own words, and who made it — what
 * the list says, a column each. With a way to take each back, R2's grid
 * (one stop for Tab, the arrows between cells); without, a plain table.
 */
function LinksTable(props: {
  links: Share[];
  caption: string;
  busy: boolean;
  onTakeBack?: (link: Share, button: HTMLButtonElement) => void;
  /** Show a link the reader made again (0.9.0): on its row, when it is theirs to see. */
  onShow?: (link: Share, button: HTMLButtonElement) => void;
  /**
   * Change a link the reader made (0.9.0, LK), on its own page since
   * 0.9.0-dev.69: on its row, when it is theirs to change.
   */
  change?: boolean;
}) {
  const take = props.onTakeBack;
  // A column of its own (one grid stop a cell), only when a row has one to show.
  const show = take && props.links.some((s) => s.revealable === true) ? props.onShow : undefined;
  const change =
    take !== undefined && props.change === true && props.links.some((s) => s.changeable === true);
  const table = useRef<HTMLTableElement>(null);
  // Never in the page: a plain table is given no grid, so no stop of its own.
  const none = useRef<HTMLTableElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const grid = useGrid(take ? table : none, wrap, [
    props.links.map((s) => s.id).join(','),
    String(props.busy),
  ]);
  return (
    <div ref={wrap} className="tbl-wrap tbl-static tbl-section">
      <table
        ref={table}
        className="tbl tbl-plain links-tbl"
        {...(take ? { role: 'grid', onKeyDown: grid.onKeyDown, onFocus: grid.onFocus } : {})}
      >
        <caption className="visually-hidden">{props.caption}</caption>
        <colgroup>
          <col />
          <col style={{ width: '16%' }} />
          <col style={{ width: '36%' }} />
          <col style={{ width: '13%' }} />
          {show && <col style={{ width: 140 }} />}
          {change && <col style={{ width: 110 }} />}
          {take && <col style={{ width: 130 }} />}
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Link to</th>
            <th scope="col">For</th>
            <th scope="col">Where it stands</th>
            <th scope="col">Made by</th>
            {show && (
              <th scope="col">
                <span className="visually-hidden">Show the link</span>
              </th>
            )}
            {change && (
              <th scope="col">
                <span className="visually-hidden">Change</span>
              </th>
            )}
            {take && (
              <th scope="col">
                <span className="visually-hidden">Take it back</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {props.links.map((s) => {
            const pages = s.document_id ? sharePagesNote(s.pages) : null;
            return (
              <tr key={s.id}>
                <td>
                  <span className="cell-title wrap-any">{linkTarget(s)}</span>
                  {pages && <span className="status status-warn cell-sub">{pages}</span>}
                </td>
                <td className="wrap-any">{s.recipient_label ?? <None />}</td>
                <td className="wrap-any">
                  {s.summary}
                  <SentWords item={s} />
                  <LinkOpens link={s} />
                </td>
                <td className="wrap-any">{s.created_by_name ?? <None />}</td>
                {show && (
                  <td>
                    {s.revealable === true && (
                      <button
                        type="button"
                        className="btn btn-quiet btn-small"
                        disabled={props.busy}
                        aria-label={showLabel(s)}
                        onClick={(e) => show(s, e.currentTarget)}
                      >
                        Show the link
                      </button>
                    )}
                  </td>
                )}
                {change && <td>{s.changeable === true && <ChangeLinkLink link={s} small />}</td>}
                {take && (
                  <td>
                    <button
                      type="button"
                      className="btn btn-quiet btn-small"
                      disabled={props.busy}
                      aria-label={takeBackLabel(s)}
                      onClick={(e) => take(s, e.currentTarget)}
                    >
                      Take it back
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const capital = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);

/**
 * The first row "Show N more" showed, given the focus (the review of 0106),
 * so whoever pressed it reads on from there: a list's item or a table's row.
 */
function focusRow(box: HTMLElement | null, at: number) {
  const row = box?.querySelectorAll<HTMLElement>('ul.list > li, tbody > tr')[at];
  if (!row) return;
  row.tabIndex = -1;
  row.focus();
}

/** "Show 12 more": the rest of what no longer works, once asked for. */
function ShowMore(props: { hidden: number; what: string; onShow: () => void }) {
  if (props.hidden <= 0) return null;
  return (
    <Button
      kind="quiet"
      ariaLabel={`Show ${props.hidden} more ${props.what}`}
      onClick={props.onShow}
    >
      Show {props.hidden} more
    </Button>
  );
}

/** Whom a request is for, who asked, and who looks: what the list says under its title. */
function requestWho(r: UploadRequestView): string[] {
  return [
    r.recipient_label ? `For ${r.recipient_label}` : null,
    !r.mine && r.requested_by_name ? `Asked by ${r.requested_by_name}` : null,
    r.review_by === 'adults' ? 'Any adult looks at what comes in' : null,
  ].filter((w): w is string => w !== null);
}

/** Only a restore's own pause is an owner's to end on Sharing (the 5.28 second round). */
const resumable = (r: UploadRequestView, owner: boolean) =>
  owner && r.state === 'paused' && r.paused_reason === 'restored';
/** Paused by its requester's sign-in waiting after a restore: the row points there. */
const signInFirst = (r: UploadRequestView, owner: boolean) =>
  owner && r.state === 'paused' && r.paused_reason === 'sign_in_paused';

/**
 * Requests as a table, from 768 px (0.9.0, RQ), as links are: what was asked
 * for, whom it is for, where it stands, what came in, and who asked when the
 * reader sees anybody else's — what the list says, a column each. With a way
 * to take each back, R2's grid (one stop for Tab, the arrows between cells),
 * each action a column of its own when a row has it; without, a plain table.
 */
function RequestsTable(props: {
  requests: UploadRequestView[];
  caption: string;
  busy: boolean;
  owner: boolean;
  onTakeBack?: (request: UploadRequestView, button: HTMLButtonElement) => void;
  onResume?: (request: UploadRequestView) => void;
  onShow?: (request: UploadRequestView, button: HTMLButtonElement) => void;
}) {
  const take = props.onTakeBack;
  const rows = props.requests;
  // A column of its own (one grid stop a cell), only when a row has one to show.
  const show = take && rows.some((r) => r.revealable === true) ? props.onShow : undefined;
  const change = take !== undefined && rows.some((r) => r.changeable === true);
  const resume =
    take && rows.some((r) => resumable(r, props.owner) || signInFirst(r, props.owner))
      ? props.onResume
      : undefined;
  const askedBy = rows.some((r) => !r.mine);
  const table = useRef<HTMLTableElement>(null);
  // Never in the page: a plain table is given no grid, so no stop of its own.
  const none = useRef<HTMLTableElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const grid = useGrid(take ? table : none, wrap, [
    rows.map((r) => r.id).join(','),
    String(props.busy),
  ]);
  return (
    <div ref={wrap} className="tbl-wrap tbl-static tbl-section">
      <table
        ref={table}
        className="tbl tbl-plain links-tbl requests-tbl"
        {...(take ? { role: 'grid', onKeyDown: grid.onKeyDown, onFocus: grid.onFocus } : {})}
      >
        <caption className="visually-hidden">{props.caption}</caption>
        <colgroup>
          <col />
          <col style={{ width: '16%' }} />
          <col style={{ width: '24%' }} />
          <col style={{ width: '16%' }} />
          {askedBy && <col style={{ width: '12%' }} />}
          {show && <col style={{ width: 140 }} />}
          {change && <col style={{ width: 110 }} />}
          {resume && <col style={{ width: 150 }} />}
          {take && <col style={{ width: 130 }} />}
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Asked for</th>
            <th scope="col">For</th>
            <th scope="col">Where it stands</th>
            <th scope="col">Received</th>
            {askedBy && <th scope="col">Asked by</th>}
            {show && (
              <th scope="col">
                <span className="visually-hidden">Show the link</span>
              </th>
            )}
            {change && (
              <th scope="col">
                <span className="visually-hidden">Change</span>
              </th>
            )}
            {resume && (
              <th scope="col">
                <span className="visually-hidden">Turn back on</span>
              </th>
            )}
            {take && (
              <th scope="col">
                <span className="visually-hidden">Take it back</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const state = requestState(r, props.owner);
            return (
              <tr key={r.id}>
                <td>
                  <span className="cell-title wrap-any">“{r.title}”</span>
                  {r.review_by === 'adults' && (
                    <span className="muted cell-sub">Any adult looks at what comes in</span>
                  )}
                </td>
                <td className="wrap-any">{r.recipient_label ?? <None />}</td>
                <td className="wrap-any">
                  <span
                    className={`request-state${state.tone ? ` status status-${state.tone}` : ''}`}
                  >
                    {state.words}
                  </span>
                  <SentWords item={r} />
                </td>
                <td className="wrap-any">{requestTally(r)}</td>
                {askedBy && (
                  <td className="wrap-any">{r.mine ? 'You' : (r.requested_by_name ?? <None />)}</td>
                )}
                {show && (
                  <td>
                    {r.revealable === true && (
                      <button
                        type="button"
                        className="btn btn-quiet btn-small"
                        disabled={props.busy}
                        aria-label={`Show the link for ${requestTarget(r)}`}
                        onClick={(e) => show(r, e.currentTarget)}
                      >
                        Show the link
                      </button>
                    )}
                  </td>
                )}
                {change && (
                  <td>
                    {r.changeable === true && (
                      <Link
                        to={`/sharing/ask/${encodeURIComponent(r.id)}`}
                        className="btn btn-quiet btn-small"
                        aria-label={`Change ${requestTarget(r)}`}
                      >
                        Change
                      </Link>
                    )}
                  </td>
                )}
                {resume && (
                  <td>
                    {resumable(r, props.owner) ? (
                      <button
                        type="button"
                        className="btn btn-small"
                        disabled={props.busy}
                        aria-label={`Turn back on ${requestTarget(r)}`}
                        onClick={() => resume(r)}
                      >
                        Turn back on
                      </button>
                    ) : signInFirst(r, props.owner) ? (
                      <Link to="/after-restore" className="btn btn-quiet btn-small">
                        {r.requested_by_name
                          ? `Turn on ${r.requested_by_name}’s sign-in`
                          : 'Turn on their sign-in'}
                      </Link>
                    ) : null}
                  </td>
                )}
                {take && (
                  <td>
                    <button
                      type="button"
                      className="btn btn-quiet btn-small"
                      disabled={props.busy}
                      aria-label={`Take back ${requestTarget(r)}`}
                      onClick={(e) => take(r, e.currentTarget)}
                    >
                      Take it back
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** A request in a list (5.22): Sharing's, and After a restore's. */
export function RequestRow(props: {
  request: UploadRequestView;
  busy: boolean;
  owner: boolean;
  /** Take it back, after asking: the button is where focus goes back to. */
  onTakeBack?: (button: HTMLButtonElement | null) => void;
  onResume?: () => void;
  /** Show its link again (0.9.0, LK), when it is the reader's to see. */
  onShow?: (button: HTMLButtonElement | null) => void;
}) {
  const r = props.request;
  const state = requestState(r, props.owner);
  const takeBack = useRef<HTMLButtonElement>(null);
  const showButton = useRef<HTMLButtonElement>(null);
  // 0.9.0 (LK): shown again, and changed on the form it was made with.
  const show = r.revealable === true ? props.onShow : undefined;
  const change = r.changeable === true && props.onTakeBack !== undefined;
  // Only a restore's own pause is an owner's to end here. One that comes
  // from its requester's sign-in ends with it: a lock with the unlock, and
  // a wait after the restore once their sign-in is turned back on, which
  // the row points to (the 5.28 second round).
  const resume = resumable(r, props.owner) ? props.onResume : null;
  const afterSignIn = signInFirst(r, props.owner);
  const who = requestWho(r);
  return (
    <li className="place request-row">
      <div className="place-title">“{r.title}”</div>
      {who.length > 0 && <div className="muted">{who.join(' · ')}</div>}
      <div className="muted">{requestTally(r)}</div>
      <div className={`request-state${state.tone ? ` status status-${state.tone}` : ' muted'}`}>
        {state.words}
      </div>
      <SentWords item={r} block />
      {(props.onTakeBack || resume || afterSignIn || show) && (
        <div className="row">
          {show && (
            <Button
              ref={showButton}
              kind="quiet"
              disabled={props.busy}
              ariaLabel={`Show the link for ${requestTarget(r)}`}
              onClick={() => show(showButton.current)}
            >
              Show the link
            </Button>
          )}
          {change && (
            <Link
              to={`/sharing/ask/${encodeURIComponent(r.id)}`}
              className="btn btn-quiet"
              aria-label={`Change ${requestTarget(r)}`}
            >
              Change
            </Link>
          )}
          {resume && (
            <Button disabled={props.busy} onClick={resume}>
              Turn back on
            </Button>
          )}
          {afterSignIn && (
            <Link to="/after-restore" className="btn btn-quiet">
              {r.requested_by_name
                ? `Turn on ${r.requested_by_name}’s sign-in`
                : 'Turn on their sign-in'}
            </Link>
          )}
          {props.onTakeBack && (
            <Button
              ref={takeBack}
              kind="quiet"
              disabled={props.busy}
              ariaLabel={`Take back ${requestTarget(r)}`}
              onClick={() => props.onTakeBack?.(takeBack.current)}
            >
              Take it back
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
