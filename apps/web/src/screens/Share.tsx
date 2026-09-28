import {
  can,
  canShareToView,
  defaultShareEnd,
  latestShareEnd,
  PREVIEW_MAX_PAGES,
  SHARE_LIMIT_MAX,
  SHARE_MAX_DAYS,
  shareEndProblem,
  shareEndWords,
  sharePagesNote,
  shareQuickPicks,
  zonedParts,
  zonedTime,
  type SharePermission,
} from '@fdv/shared';
import { useState } from 'react';
import { api, type CreatedShare, type Share } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { storedRole } from '../session.js';
import { Button, ErrorNote, Field } from '../ui.js';

/**
 * Sharing one document with somebody outside the family (SHR-05).
 *
 * The whole feature is one link with an end, so the interface is one form
 * and one card. The card has to carry three things the person needs to
 * believe: it stops working at a time, it can be taken back, and every
 * time somebody opens it the family will see.
 *
 * Since 5.18 the end is a date and a time on the family's clock (the
 * household's time zone), with Tonight, Friday 5 pm and In a week one tap
 * away; the link can be for viewing only, its pages drawn with whom it is
 * for; and it can be opened so many times.
 */
export function SharePanel(props: {
  documentId: string;
  documentTitle: string | null;
  /**
   * Opened from a row's ⋯ (5.4): it starts at the form, and Cancel or Done
   * closes the sheet it is in.
   */
  onClose?: () => void;
  /**
   * A link is being made or taken back. The sheet it is in stays open
   * until it is done: the link and its PIN are shown once, here, and
   * nowhere else.
   */
  onBusy?: (busy: boolean) => void;
}) {
  const { guarded, authVersion, caps } = useApp();
  const [made, setMade] = useState<CreatedShare | null>(null);
  const [label, setLabel] = useState('');
  /** The end as chosen, on the family's clock; null is the default, In a week. */
  const [end, setEnd] = useState<{ date: string; time: string } | null>(null);
  const [permission, setPermission] = useState<SharePermission>('download');
  const [opens, setOpens] = useState('');
  const [withPin, setWithPin] = useState(false);
  const [open, setOpen] = useState(Boolean(props.onClose));
  const [busy, setBusy] = useState<'making' | 'taking back' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mayShare = can(storedRole(), 'document.share');

  const { data, reload } = useLoad(
    async (t) => {
      if (!mayShare) return { shares: [], newest: null, timezone: 'UTC' };
      const [shares, versions, profile] = await Promise.all([
        api.shares(t),
        api.versions(t, props.documentId).catch(() => ({ items: [] })),
        api.profile(t).catch(() => null),
      ]);
      const newest = [...versions.items].sort((a, b) => b.version_no - a.version_no)[0] ?? null;
      return {
        shares: shares.items.filter((s) => s.document_id === props.documentId),
        newest,
        timezone: profile?.timezone ?? 'UTC',
      };
    },
    [props.documentId, authVersion, mayShare],
  );
  if (!mayShare) return null;

  // Listed while it can still be taken back: live, or opened as often as it
  // allows (a page opened with it lasts to its own end).
  const listed = (data?.shares ?? []).filter((s) => s.state === 'active' || s.state === 'used_up');
  const timezone = data?.timezone ?? 'UTC';
  const now = new Date();
  // The longest the vault takes (FDV_SHARE_MAX_DAYS, 90 unless its operator
  // shortened it): only picks within it are offered, and the default is a
  // week or, when that is too long, an hour safely inside the longest it
  // allows (defaultShareEnd), never the very edge of it.
  const maxDays = caps?.limits.share_max_days ?? SHARE_MAX_DAYS;
  const picks = shareQuickPicks(timezone, now, maxDays);
  const chosen = end ?? defaultShareEnd(timezone, now, maxDays);
  const endAt = zonedTime(chosen.date, chosen.time, timezone);
  const endProblem = endAt ? shareEndProblem(endAt, { now, maxDays }) : 'Choose a date and a time.';
  const viewable = !data?.newest || canShareToView(data.newest.mime);
  const long =
    data?.newest?.page_count && data.newest.page_count > PREVIEW_MAX_PAGES
      ? data.newest.page_count
      : null;
  // Read as typed (a text field): a number field reads "5e" as nothing at
  // all, and a limit typed wrong would have become no limit (5.18 review).
  const opensTyped = opens.trim();
  const opensCount = opensTyped === '' ? null : /^\d+$/.test(opensTyped) ? Number(opensTyped) : NaN;
  const opensProblem =
    opensCount !== null &&
    (!Number.isInteger(opensCount) || opensCount < 1 || opensCount > SHARE_LIMIT_MAX)
      ? `A number from 1 to ${SHARE_LIMIT_MAX}, or leave it empty for no limit.`
      : null;
  const zoneWords =
    timezone !== Intl.DateTimeFormat().resolvedOptions().timeZone ? ` (${timezone} time)` : '';

  const working = (on: typeof busy) => {
    setBusy(on);
    props.onBusy?.(on !== null);
  };

  const create = async () => {
    if (!endAt || endProblem || opensProblem) return;
    working('making');
    setError(null);
    try {
      const created = await guarded((t) =>
        api.share(t, props.documentId, {
          ...(label.trim() ? { recipient_label: label.trim() } : {}),
          expires_at: endAt.toISOString(),
          permission: viewable ? permission : 'download',
          ...(opensCount !== null ? { max_opens: opensCount } : {}),
          with_pin: withPin,
        }),
      );
      if (created) {
        setMade(created);
        setOpen(false);
        setLabel('');
        setOpens('');
        setEnd(null);
        await reload();
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      working(null);
    }
  };

  const revoke = async (s: Share) => {
    working('taking back');
    try {
      await guarded((t) => api.revokeShare(t, s.id));
      await reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      working(null);
    }
  };

  if (made) {
    return (
      <HandOver
        created={made}
        timezone={timezone}
        onDone={() => {
          setMade(null);
          props.onClose?.();
        }}
      />
    );
  }

  return (
    <section className="card stack">
      <h2 style={{ fontSize: 18 }}>Send this to someone outside the family</h2>
      <ErrorNote message={error} />

      {listed.length > 0 && (
        <ul className="list">
          {listed.map((s) => {
            // A view-only link's pages, when there is something to say
            // about them: still being drawn, cut at 30, or not drawable at
            // all — told here as well as when the link was made.
            const pagesNote = sharePagesNote(s.pages);
            return (
              <li key={s.id} className="row" style={{ justifyContent: 'space-between' }}>
                <span className="stack" style={{ gap: 4 }}>
                  <span className="muted">{s.summary}</span>
                  {pagesNote && (
                    <span
                      className={
                        s.pages?.state === 'failed' ? 'status status-danger' : 'status status-warn'
                      }
                    >
                      {pagesNote}
                    </span>
                  )}
                </span>
                <Button kind="quiet" disabled={busy !== null} onClick={() => void revoke(s)}>
                  Take it back
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {open ? (
        <div className="stack">
          <Field
            id="share-label"
            label="Who is it for?"
            value={label}
            onChange={setLabel}
            required={false}
            hint="Only for your own list — the letting agent, the accountant. It is also written across the pages of a link to view."
          />

          <div className="field" role="group" aria-labelledby="share-until-h">
            <span id="share-until-h" className="field-label">
              Stops working
            </span>
            <div className="pills">
              {picks.map((p) => {
                const on = endAt !== null && Math.abs(endAt.getTime() - p.at.getTime()) < 60_000;
                return (
                  <button
                    key={p.key}
                    type="button"
                    className={`pill${on ? ' pill-on' : ''}`}
                    aria-pressed={on}
                    onClick={() => setEnd(zonedParts(p.at, timezone))}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
            <div className="share-when">
              <label className="field" htmlFor="share-date">
                <span>Date</span>
                <input
                  id="share-date"
                  type="date"
                  value={chosen.date}
                  min={zonedParts(now, timezone).date}
                  max={latestShareEnd(timezone, now, maxDays).date}
                  onChange={(e) => setEnd({ date: e.target.value, time: chosen.time })}
                  aria-describedby="share-until-note"
                />
              </label>
              <label className="field" htmlFor="share-time">
                <span>Time</span>
                <input
                  id="share-time"
                  type="time"
                  value={chosen.time}
                  step={300}
                  onChange={(e) => setEnd({ date: chosen.date, time: e.target.value })}
                  aria-describedby="share-until-note"
                />
              </label>
            </div>
            <span
              id="share-until-note"
              className={endProblem ? 'field-error' : 'muted'}
              role={endProblem ? 'alert' : undefined}
            >
              {endProblem ??
                (endAt ? `Until ${shareEndWords(endAt, timezone)}${zoneWords}.` : null)}
            </span>
          </div>

          <div className="field" role="group" aria-labelledby="share-can-h">
            <span id="share-can-h" className="field-label">
              What they can do
            </span>
            <div className="pills">
              <button
                type="button"
                className={`pill${permission === 'view' && viewable ? ' pill-on' : ''}`}
                aria-pressed={permission === 'view' && viewable}
                disabled={!viewable}
                onClick={() => setPermission('view')}
              >
                View
              </button>
              <button
                type="button"
                className={`pill${permission === 'download' || !viewable ? ' pill-on' : ''}`}
                aria-pressed={permission === 'download' || !viewable}
                onClick={() => setPermission('download')}
              >
                View and download
              </button>
            </div>
            <span className="muted">
              {!viewable
                ? 'Word and Excel files can only be shared with download: the vault cannot draw their pages.'
                : permission === 'view'
                  ? 'They see its pages, with who it is for written across each, and cannot save the file. They can keep pictures of the pages, each marked; nothing can stop a screenshot.'
                  : 'They can save the file itself.'}
            </span>
            {viewable && permission === 'view' && long !== null && (
              <span className="muted">
                They will see the first {PREVIEW_MAX_PAGES} of {long} pages.
              </span>
            )}
          </div>

          <div className="field">
            <label htmlFor="share-opens">Can be opened</label>
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <input
                id="share-opens"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                value={opens}
                onChange={(e) => setOpens(e.target.value)}
                aria-describedby="share-opens-hint"
                aria-invalid={opensProblem ? true : undefined}
                style={{ width: 96 }}
              />
              <span aria-hidden="true">times</span>
            </div>
            <span
              id="share-opens-hint"
              className={opensProblem ? 'field-error' : 'muted'}
              role={opensProblem ? 'alert' : undefined}
            >
              {opensProblem ??
                'Leave it empty for no limit. Each press of Open counts; reloading the page it opens does not.'}
            </span>
          </div>

          <label className="row" style={{ gap: 8 }}>
            <input
              type="checkbox"
              checked={withPin}
              onChange={(e) => setWithPin(e.target.checked)}
            />
            <span>Also ask for a four-digit PIN, which you tell them separately</span>
          </label>
          <div className="row">
            <Button
              disabled={busy !== null || Boolean(endProblem) || Boolean(opensProblem)}
              onClick={() => void create()}
            >
              {busy === 'making' ? 'Making the link…' : 'Make the link'}
            </Button>
            {/* Not while the link is being made: it would be made, and never shown. */}
            <Button
              kind="quiet"
              disabled={busy !== null}
              onClick={() => (props.onClose ? props.onClose() : setOpen(false))}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button kind="quiet" onClick={() => setOpen(true)}>
          Share a link
        </Button>
      )}
    </section>
  );
}

/**
 * Whether a link would open on a page no browser treats as secure: http://
 * anywhere but this computer. There Open's Secure cookie is dropped, so the
 * page refuses to open it (SharePage), and the person it is for gets nothing.
 */
function insecureLink(link: string): boolean {
  try {
    const url = new URL(link);
    return url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

function HandOver(props: { created: CreatedShare; timezone: string; onDone: () => void }) {
  // The secret after the #: a browser never sends it to a server, and the
  // page it opens takes it out of the address bar (5.16). On the vault's
  // public-only site when it has one, so the person it is for can reach it.
  const link = props.created.link_url ?? `${window.location.origin}/s#${props.created.link_token}`;
  const [copied, setCopied] = useState(false);
  const { share } = props.created;
  const pagesNote = sharePagesNote(share.pages);
  return (
    <section className="card stack">
      <h2 style={{ fontSize: 18 }}>The link to {share.document_title ?? 'this document'}</h2>
      <code style={{ wordBreak: 'break-all' }}>{link}</code>
      {insecureLink(link) && (
        <p className="status status-warn" role="alert">
          This link starts with http://, not https://, so whoever you send it to will not be able to
          download the document: their browser will not open it over a connection that is not
          secure. Ask whoever looks after the vault to give it an https:// address first.
        </p>
      )}
      <Button
        kind="quiet"
        onClick={() => {
          void navigator.clipboard?.writeText(link).then(
            () => setCopied(true),
            () => setCopied(false),
          );
        }}
      >
        {copied ? 'Copied' : 'Copy the link'}
      </Button>
      {props.created.pin && (
        <div className="field">
          <span className="field-label">The PIN</span>
          <code style={{ fontSize: 24, letterSpacing: 4 }}>{props.created.pin}</code>
          <span className="muted">
            Tell them this some other way — a phone call, not the same message.
          </span>
        </div>
      )}
      <ul className="share-terms">
        <li>Until {shareEndWords(new Date(share.expires_at), props.timezone)}.</li>
        <li>
          {share.permission === 'view'
            ? 'To view: they see its pages, with who it is for written across each, and cannot save the file.'
            : 'To view and download.'}
        </li>
        {share.max_opens != null && (
          <li>It can be opened {share.max_opens === 1 ? 'once' : `${share.max_opens} times`}.</li>
        )}
      </ul>
      {pagesNote && (
        <p className="status status-warn" role="status">
          {pagesNote}
        </p>
      )}
      <p className="muted">
        Anyone with the link can open this one document until it expires, and nothing else. You will
        see every time it is opened, and you can take it back whenever you like.
      </p>
      <Button onClick={props.onDone}>Done</Button>
    </section>
  );
}
