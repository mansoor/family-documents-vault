import {
  can,
  canShareToView,
  COLLECTION_SHARE_FILE_REMOVED,
  defaultShareEnd,
  isShareAddress,
  latestShareEnd,
  PREVIEW_MAX_PAGES,
  SHARE_CODE_TRUTH,
  SHARE_CODE_UNAVAILABLE,
  SHARE_LIMIT_MAX,
  SHARE_MAX_DAYS,
  SHARE_PASSWORD_MAX,
  SHARE_PASSWORD_MIN,
  shareEndProblem,
  shareEndWords,
  sharePagesNote,
  shareQuickPicks,
  zonedParts,
  zonedTime,
  type Capabilities,
  type ShareInput,
  type SharePermission,
} from '@fdv/shared';
import { useState, type ReactNode } from 'react';
import { api, ApiRequestError, type CreatedShare, type Share } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { storedRole } from '../session.js';
import { Button, Check, ErrorNote, Field } from '../ui.js';

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
 * for; and it can be opened so many times. Since 5.19 a collection is
 * shared with the same options (ShareCollection.tsx).
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
  const options = useLinkOptions();
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
  const viewable = !data?.newest || canShareToView(data.newest.mime);
  // A restore found its file removed for good (5.24): no new link, which
  // would open on nothing; a link already made can still be taken back.
  const removed = data?.newest?.file_removed === true;
  const long =
    data?.newest?.page_count && data.newest.page_count > PREVIEW_MAX_PAGES
      ? data.newest.page_count
      : null;
  const read = readLinkOptions(options.value, {
    timezone,
    maxDays: caps?.limits.share_max_days ?? SHARE_MAX_DAYS,
    viewable,
    factors: linkFactors(caps),
  });

  const working = (on: typeof busy) => {
    setBusy(on);
    props.onBusy?.(on !== null);
  };

  const create = async () => {
    if (!read.body) return;
    working('making');
    setError(null);
    try {
      const created = await guarded((t) => api.share(t, props.documentId, read.body as ShareInput));
      if (created) {
        setMade(created);
        setOpen(false);
        options.reset();
        await reload();
      }
    } catch (err) {
      // About the address a code goes to: said under it (W520-5).
      const refused = codeAddressRefusal(err);
      if (refused) options.set({ codeRefused: refused });
      else setError(describeError(err));
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

      {removed ? (
        <p className="muted">{COLLECTION_SHARE_FILE_REMOVED}</p>
      ) : open ? (
        <div className="stack">
          <LinkOptions
            options={options}
            read={read}
            timezone={timezone}
            viewable={viewable}
            notViewable="Word and Excel files can only be shared with download: the vault cannot draw their pages."
            viewNote={
              long !== null
                ? `They will see the first ${PREVIEW_MAX_PAGES} of ${long} pages.`
                : null
            }
          />
          <div className="row">
            <Button disabled={busy !== null || !read.body} onClick={() => void create()}>
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

// ------------------------------------------------------- a link's options

/** A link's options as they are being chosen (5.18; 5.20's protection). */
export interface LinkOptionsValue {
  label: string;
  /** The end as chosen, on the family's clock; null is the default, In a week. */
  end: { date: string; time: string } | null;
  permission: SharePermission;
  opens: string;
  withPin: boolean;
  /** A password (5.20): one the vault makes up, or one typed here. Never with a PIN. */
  withPassword: boolean;
  passwordMode: 'made' | 'typed';
  password: string;
  /** A code emailed to this address when they ask (5.20). */
  withCode: boolean;
  codeEmail: string;
  /**
   * The vault's own refusal of that address, said under it (W520-5), until
   * it is changed.
   */
  codeRefused: string | null;
  /** The first browser to open it is the only one it opens in (5.20). */
  thisDeviceOnly: boolean;
}

const NO_OPTIONS: LinkOptionsValue = {
  label: '',
  end: null,
  permission: 'download',
  opens: '',
  withPin: false,
  withPassword: false,
  passwordMode: 'made',
  password: '',
  withCode: false,
  codeEmail: '',
  codeRefused: null,
  thisDeviceOnly: false,
};

export function useLinkOptions() {
  const [value, setValue] = useState<LinkOptionsValue>(NO_OPTIONS);
  return {
    value,
    set: (change: Partial<LinkOptionsValue>) => setValue((v) => ({ ...v, ...change })),
    // What was typed goes — a password and an address with it; View or
    // not, and which protections, stay as they were chosen.
    reset: () =>
      setValue((v) => ({
        ...NO_OPTIONS,
        permission: v.permission,
        withPin: v.withPin,
        withPassword: v.withPassword,
        passwordMode: v.passwordMode,
        withCode: v.withCode,
        thisDeviceOnly: v.thisDeviceOnly,
      })),
  };
}

/**
 * What this vault can ask for besides the link (5.20): a password and one
 * browser only (`share_second_factor`), and an emailed code, only when its
 * operator has given it a mail server (`share_email_code`, A21).
 */
export interface LinkFactors {
  second: boolean;
  email: boolean;
}

export function linkFactors(caps: Capabilities | null): LinkFactors {
  return {
    second: caps?.features.share_second_factor === true,
    email: caps?.features.share_email_code === true,
  };
}

/**
 * The vault's refusal of what a link asks for, when it is about the address
 * a code goes to (W520-5): said under that field, where it can be put right,
 * rather than at the top of the card. Null for anything else.
 */
export function codeAddressRefusal(err: unknown): string | null {
  if (!(err instanceof ApiRequestError)) return null;
  if (err.code === 'email_code_unavailable') return err.message;
  if (err.code === 'validation_failed' && err.detail?.startsWith('code_email')) return err.message;
  return null;
}

/** What the options come to: the end, what is wrong, and what to send when nothing is. */
export function readLinkOptions(
  value: LinkOptionsValue,
  ctx: {
    timezone: string;
    maxDays: number;
    viewable: boolean;
    now?: Date;
    /** What the vault can ask for besides the link (5.20); none, when not said. */
    factors?: LinkFactors;
  },
) {
  const now = ctx.now ?? new Date();
  const { timezone, maxDays } = ctx;
  // The longest the vault takes (FDV_SHARE_MAX_DAYS, 90 unless its operator
  // shortened it; 30 days for a collection's link that keeps up with it):
  // only picks within it are offered, and the default is a week or, when
  // that is too long, an hour safely inside the longest it allows
  // (defaultShareEnd), never the very edge of it.
  const picks = shareQuickPicks(timezone, now, maxDays);
  const chosen = value.end ?? defaultShareEnd(timezone, now, maxDays);
  const endAt = zonedTime(chosen.date, chosen.time, timezone);
  const endProblem = endAt ? shareEndProblem(endAt, { now, maxDays }) : 'Choose a date and a time.';
  // Read as typed (a text field): a number field reads "5e" as nothing at
  // all, and a limit typed wrong would have become no limit (5.18 review).
  const opensTyped = value.opens.trim();
  const opensCount = opensTyped === '' ? null : /^\d+$/.test(opensTyped) ? Number(opensTyped) : NaN;
  const opensProblem =
    opensCount !== null &&
    (!Number.isInteger(opensCount) || opensCount < 1 || opensCount > SHARE_LIMIT_MAX)
      ? `A number from 1 to ${SHARE_LIMIT_MAX}, or leave it empty for no limit.`
      : null;
  // 5.20: a password (made up, or typed: 8 characters at least), a code by
  // email (only where the vault can send one), and one browser only.
  const factors = ctx.factors ?? { second: false, email: false };
  const password = factors.second && value.withPassword && !value.withPin;
  const typed = value.password.trim();
  const passwordProblem =
    password && value.passwordMode === 'typed' && typed.length < SHARE_PASSWORD_MIN
      ? `At least ${SHARE_PASSWORD_MIN} characters. Something they can type, and you can say to them.`
      : null;
  const code = factors.email && value.withCode;
  const address = value.codeEmail.trim();
  // The vault's own rule (isShareAddress, W520-5): nothing it would refuse
  // is offered; and a refusal it gave anyway is said here too.
  const codeProblem = code
    ? !isShareAddress(address)
      ? 'Their email address, which the code will go to: name@example.com.'
      : value.codeRefused
    : null;
  const body: ShareInput | null =
    endAt && !endProblem && !opensProblem && !passwordProblem && !codeProblem
      ? {
          ...(value.label.trim() ? { recipient_label: value.label.trim() } : {}),
          expires_at: endAt.toISOString(),
          permission: ctx.viewable ? value.permission : 'download',
          ...(opensCount !== null ? { max_opens: opensCount } : {}),
          with_pin: value.withPin,
          ...(password
            ? value.passwordMode === 'made'
              ? { with_password: true }
              : { password: typed }
            : {}),
          ...(code ? { code_email: address } : {}),
          ...(factors.second && value.thisDeviceOnly ? { this_device_only: true } : {}),
        }
      : null;
  return {
    now,
    picks,
    chosen,
    endAt,
    endProblem,
    opensProblem,
    passwordProblem,
    codeProblem,
    body,
    maxDays,
    factors,
  };
}

/**
 * The fields of a link's options (5.18): whom it is for, when it stops,
 * what they can do, how often it opens, and a PIN.
 */
export function LinkOptions(props: {
  options: ReturnType<typeof useLinkOptions>;
  read: ReturnType<typeof readLinkOptions>;
  timezone: string;
  /** The vault can draw the pages of what is being shared: it can go to view. */
  viewable: boolean;
  /** Why it cannot, when it cannot. */
  notViewable: string;
  /** Said under View, when there is something to say ("the first 30 of 42 pages"). */
  viewNote?: string | null;
  /** Said under the end, after it ("A link that keeps up … lasts 30 days at most."). */
  endNote?: ReactNode;
}) {
  const { options, read, timezone, viewable } = props;
  const { value } = options;
  const { opensProblem } = read;
  return (
    <>
      <Field
        id="share-label"
        label="Who is it for?"
        value={value.label}
        onChange={(label) => options.set({ label })}
        required={false}
        hint="Only for your own list — the letting agent, the accountant. It is also written across the pages of a link to view."
      />

      <EndPicker
        idPrefix="share"
        timezone={timezone}
        read={read}
        onChange={(end) => options.set({ end })}
        endNote={props.endNote}
      />

      <div className="field" role="group" aria-labelledby="share-can-h">
        <span id="share-can-h" className="field-label">
          What they can do
        </span>
        <div className="pills">
          <button
            type="button"
            className={`pill${value.permission === 'view' && viewable ? ' pill-on' : ''}`}
            aria-pressed={value.permission === 'view' && viewable}
            disabled={!viewable}
            onClick={() => options.set({ permission: 'view' })}
          >
            View
          </button>
          <button
            type="button"
            className={`pill${value.permission === 'download' || !viewable ? ' pill-on' : ''}`}
            aria-pressed={value.permission === 'download' || !viewable}
            onClick={() => options.set({ permission: 'download' })}
          >
            View and download
          </button>
        </div>
        <span className="muted">
          {!viewable
            ? props.notViewable
            : value.permission === 'view'
              ? 'They see its pages, with who it is for written across each, and cannot save the file. They can keep pictures of the pages, each marked; nothing can stop a screenshot.'
              : 'They can save the file itself.'}
        </span>
        {viewable && value.permission === 'view' && props.viewNote && (
          <span className="muted">{props.viewNote}</span>
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
            value={value.opens}
            onChange={(e) => options.set({ opens: e.target.value })}
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

      <Protection options={options} read={read} />
    </>
  );
}

/**
 * When a link stops working (5.18), on the family's clock: Tonight, Friday
 * 5 pm and In a week one tap away, or a date and a time; what it comes to
 * said under them, or why it cannot be. A request to send documents (5.22)
 * ends the same way.
 */
export function EndPicker(props: {
  /** The ids' start: `share` for a link, `ask` for a request. */
  idPrefix: string;
  timezone: string;
  read: Pick<
    ReturnType<typeof readLinkOptions>,
    'chosen' | 'endAt' | 'endProblem' | 'picks' | 'now' | 'maxDays'
  >;
  onChange: (end: { date: string; time: string }) => void;
  /** Said under the end, after it ("A link that keeps up … lasts 30 days at most."). */
  endNote?: ReactNode;
}) {
  const { idPrefix: p, timezone, read } = props;
  const { chosen, endAt, endProblem, picks, now, maxDays } = read;
  const zoneWords =
    timezone !== Intl.DateTimeFormat().resolvedOptions().timeZone ? ` (${timezone} time)` : '';
  return (
    <div className="field" role="group" aria-labelledby={`${p}-until-h`}>
      <span id={`${p}-until-h`} className="field-label">
        Stops working
      </span>
      <div className="pills">
        {picks.map((pick) => {
          const on = endAt !== null && Math.abs(endAt.getTime() - pick.at.getTime()) < 60_000;
          return (
            <button
              key={pick.key}
              type="button"
              className={`pill${on ? ' pill-on' : ''}`}
              aria-pressed={on}
              onClick={() => props.onChange(zonedParts(pick.at, timezone))}
            >
              {pick.label}
            </button>
          );
        })}
      </div>
      <div className="share-when">
        <label className="field" htmlFor={`${p}-date`}>
          <span>Date</span>
          <input
            id={`${p}-date`}
            type="date"
            value={chosen.date}
            min={zonedParts(now, timezone).date}
            max={latestShareEnd(timezone, now, maxDays).date}
            onChange={(e) => props.onChange({ date: e.target.value, time: chosen.time })}
            aria-describedby={`${p}-until-note`}
          />
        </label>
        <label className="field" htmlFor={`${p}-time`}>
          <span>Time</span>
          <input
            id={`${p}-time`}
            type="time"
            value={chosen.time}
            step={300}
            onChange={(e) => props.onChange({ date: chosen.date, time: e.target.value })}
            aria-describedby={`${p}-until-note`}
          />
        </label>
      </div>
      <span
        id={`${p}-until-note`}
        className={endProblem ? 'field-error' : 'muted'}
        role={endProblem ? 'alert' : undefined}
      >
        {endProblem ?? (endAt ? `Until ${shareEndWords(endAt, timezone)}${zoneWords}.` : null)}
      </span>
      {props.endNote}
    </div>
  );
}

/**
 * A password the vault makes up, or one typed (5.20): which, and the typed
 * one with what is wrong with it — said only once something is typed
 * (W520-6), and left as typed by a phone keyboard (W520-13).
 */
export function PasswordChoice(props: {
  /** The typed password's field: `share-password`, `ask-password`. */
  id: string;
  mode: 'made' | 'typed';
  password: string;
  problem: string | null;
  onMode: (mode: 'made' | 'typed') => void;
  onPassword: (password: string) => void;
  /** What is said under the typed one: the rule, and what to do with it. */
  typedNote: string;
  madeNote: string;
}) {
  const wrong = props.problem && props.password ? props.problem : null;
  return (
    <div className="stack share-indent" style={{ gap: 8 }}>
      <div className="pills" role="group" aria-label="Which password">
        <button
          type="button"
          className={`pill${props.mode === 'made' ? ' pill-on' : ''}`}
          aria-pressed={props.mode === 'made'}
          onClick={() => props.onMode('made')}
        >
          Make one up for me
        </button>
        <button
          type="button"
          className={`pill${props.mode === 'typed' ? ' pill-on' : ''}`}
          aria-pressed={props.mode === 'typed'}
          onClick={() => props.onMode('typed')}
        >
          I’ll type one
        </button>
      </div>
      {props.mode === 'typed' ? (
        <div className="field">
          <label htmlFor={props.id}>The password</label>
          <input
            id={props.id}
            type="text"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={SHARE_PASSWORD_MAX}
            value={props.password}
            onChange={(e) => props.onPassword(e.target.value)}
            aria-invalid={wrong ? true : undefined}
            aria-describedby={`${props.id}-note`}
          />
          <span
            id={`${props.id}-note`}
            className={wrong ? 'field-error' : 'muted'}
            role={wrong ? 'alert' : undefined}
          >
            {wrong ?? props.typedNote}
          </span>
        </div>
      ) : (
        <span className="muted">{props.madeNote}</span>
      )}
    </div>
  );
}

/** What "This browser only" means, for whoever makes a link or a request (5.20, 5.22). */
export const DEVICE_ONLY_NOTE =
  'The first browser that opens it is the only one it will open in. If they open it on their phone, it will not open on their computer.';

/**
 * What a link asks for besides itself (5.20): a PIN or a password, a code
 * emailed to them, and to open in one browser only — any of them, each
 * said plainly. Where the vault cannot email a code (its operator has set
 * no mail server, A21), that option is not there, and the reason is.
 */
function Protection(props: {
  options: ReturnType<typeof useLinkOptions>;
  read: ReturnType<typeof readLinkOptions>;
}) {
  const { options, read } = props;
  const { value } = options;
  const { factors, passwordProblem, codeProblem } = read;
  // The app's box (`.check`, 5.19): beside the start of its label, never
  // wrapped onto a line of its own on a phone.
  const check = (
    id: string,
    checked: boolean,
    onChange: (on: boolean) => void,
    label: ReactNode,
    describedBy?: string,
  ) => (
    <div className="check">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-describedby={describedBy}
      />
      <label htmlFor={id}>{label}</label>
    </div>
  );
  return (
    <div className="share-protect" role="group" aria-labelledby="share-protect-h">
      <span id="share-protect-h" className="field-label">
        Protect it
      </span>
      {check(
        'share-pin',
        value.withPin,
        (on) => options.set({ withPin: on, ...(on ? { withPassword: false } : {}) }),
        'Also ask for a four-digit PIN, which you tell them separately',
      )}
      {factors.second && (
        <>
          {check(
            'share-with-password',
            value.withPassword,
            (on) => options.set({ withPassword: on, ...(on ? { withPin: false } : {}) }),
            'Also ask for a password, which you tell them separately',
          )}
          {value.withPassword && (
            <PasswordChoice
              id="share-password"
              mode={value.passwordMode}
              password={value.password}
              problem={passwordProblem}
              onMode={(passwordMode) => options.set({ passwordMode })}
              onPassword={(password) => options.set({ password })}
              typedNote={`At least ${SHARE_PASSWORD_MIN} characters. The vault keeps only a scrambled copy, so write it down before you send the link.`}
              madeNote="Three short groups of letters and numbers, easy to read out. You see it once, with the link."
            />
          )}
        </>
      )}
      {factors.email ? (
        <>
          {check(
            'share-with-code',
            value.withCode,
            (on) => options.set({ withCode: on }),
            'Also email them a code when they open it',
            'share-code-truth',
          )}
          {value.withCode && (
            <div className="stack share-indent" style={{ gap: 8 }}>
              <div className="field">
                <label htmlFor="share-code-email">Their email address</label>
                <input
                  id="share-code-email"
                  type="email"
                  autoComplete="off"
                  maxLength={254}
                  value={value.codeEmail}
                  onChange={(e) => options.set({ codeEmail: e.target.value, codeRefused: null })}
                  aria-invalid={codeProblem && value.codeEmail ? true : undefined}
                  aria-describedby="share-code-note"
                />
                <span
                  id="share-code-note"
                  className={codeProblem && value.codeEmail ? 'field-error' : 'muted'}
                  role={codeProblem && value.codeEmail ? 'alert' : undefined}
                >
                  {codeProblem && value.codeEmail
                    ? codeProblem
                    : 'The code goes only to this address, from the vault’s own mail server. They never type an address; they see it with most of it hidden.'}
                </span>
              </div>
            </div>
          )}
          <span id="share-code-truth" className="muted share-indent">
            {SHARE_CODE_TRUTH}
          </span>
        </>
      ) : (
        factors.second && (
          <p className="muted share-indent" role="note" data-testid="share-code-unavailable">
            <strong>An emailed code is not available.</strong> {SHARE_CODE_UNAVAILABLE}
          </p>
        )
      )}
      {/* Its note just under its label, in the label's column (5.22): as a
          sibling under the row it sat a whole tap height below it. */}
      {factors.second && (
        <Check
          id="share-device-only"
          noteId="share-device-note"
          checked={value.thisDeviceOnly}
          onChange={(on) => options.set({ thisDeviceOnly: on })}
          label="This browser only"
          note={DEVICE_ONLY_NOTE}
        />
      )}
    </div>
  );
}

/**
 * Whether a link would open on a page no browser treats as secure: http://
 * anywhere but this computer. There Open's Secure cookie is dropped, so the
 * page refuses to open it (SharePage), and the person it is for gets nothing.
 */
export function insecureLink(link: string): boolean {
  try {
    const url = new URL(link);
    return url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * The link and its PIN, shown once. For a collection (5.19), what it is to
 * and what it gives are the collection's.
 */
export function HandOver(props: { created: CreatedShare; timezone: string; onDone: () => void }) {
  // The secret after the #: a browser never sends it to a server, and the
  // page it opens takes it out of the address bar (5.16). On the vault's
  // public-only site when it has one, so the person it is for can reach it.
  const link = props.created.link_url ?? `${window.location.origin}/s#${props.created.link_token}`;
  const [copied, setCopied] = useState(false);
  const { share } = props.created;
  const collection = share.collection_id ? (share.collection_name ?? 'this collection') : null;
  const pagesNote = sharePagesNote(share.pages);
  return (
    <section className="card stack">
      <h2 style={{ fontSize: 18 }}>
        {collection
          ? `The link to “${collection}”`
          : `The link to ${share.document_title ?? 'this document'}`}
      </h2>
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
      {/* A password the vault made up (5.20): here, once, and nowhere else. */}
      {props.created.password && (
        <div className="field" data-testid="share-password">
          <span className="field-label">The password</span>
          <code style={{ fontSize: 22, letterSpacing: 2, wordBreak: 'break-all' }}>
            {props.created.password}
          </code>
          <span className="muted">
            Tell them this some other way — a phone call, not the same message. It is shown only
            now: the vault keeps a scrambled copy it cannot show again.
          </span>
        </div>
      )}
      <ul className="share-terms">
        <li>Until {shareEndWords(new Date(share.expires_at), props.timezone)}.</li>
        <li>
          {share.permission === 'view'
            ? collection
              ? 'To view: they see the pages, with who it is for written across each, and cannot save the files.'
              : 'To view: they see its pages, with who it is for written across each, and cannot save the file.'
            : 'To view and download.'}
        </li>
        {share.max_opens != null && (
          <li>It can be opened {share.max_opens === 1 ? 'once' : `${share.max_opens} times`}.</li>
        )}
        {/* What it asks for besides the link (5.20). */}
        {share.protection?.includes('password') && !props.created.password && (
          <li>They will be asked for the password you chose.</li>
        )}
        {share.code_to && (
          <li>
            When they open it, a code is emailed to {share.code_to}, and they type it in. It works
            once, for 10 minutes.
          </li>
        )}
        {share.this_device_only && <li>It opens only in the first browser that opens it.</li>}
        {share.follow_collection && (
          <li>
            It keeps up with the collection: what an owner or an adult puts in it goes too, if
            everybody the collection is for may see it.
          </li>
        )}
      </ul>
      {pagesNote && (
        <p className="status status-warn" role="status">
          {pagesNote}
        </p>
      )}
      <p className="muted">
        {collection
          ? 'Anyone with the link can open the documents you chose until it expires, and nothing else in the vault. One you can no longer see, or that leaves the collection, stops being sent. You will see every time it is opened, and you can take it back whenever you like.'
          : 'Anyone with the link can open this one document until it expires, and nothing else. You will see every time it is opened, and you can take it back whenever you like.'}
      </p>
      <Button onClick={props.onDone}>Done</Button>
    </section>
  );
}
