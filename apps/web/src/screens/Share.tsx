import {
  can,
  canShareToView,
  COLLECTION_SHARE_FILE_REMOVED,
  defaultShareEnd,
  DOWNLOAD_KEEPS_DETAILS,
  isRecordFormat,
  isShareAddress,
  latestShareEnd,
  ONLY_ME_NOT_SHARED,
  ONLY_ME_SHARE_WARNING,
  PREVIEW_MAX_PAGES,
  SENSITIVE_SHARE_CONFIRM,
  sensitiveLinkStartWords,
  SHARE_CODE_TRUTH,
  SHARE_CODE_UNAVAILABLE,
  SHARE_LIMIT_MAX,
  SHARE_MAX_DAYS,
  SHARE_PASSWORD_MAX,
  SHARE_PASSWORD_MIN,
  shareEndProblem,
  sharePagesNote,
  shareQuickPicks,
  SHOW_TITLE_LABEL,
  SHOW_TITLE_SENSITIVE_HINT,
  emailedToWords,
  textedToWords,
  zonedParts,
  zonedTime,
  type Capabilities,
  type ShareInput,
  type SharePermission,
} from '@fdv/shared';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { api, ApiRequestError, type CreatedShare, type Share } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { storedRole } from '../session.js';
import { Button, Check, ErrorNote, Field, useArrivedSaid, useIdScope } from '../ui.js';
import { endWords, familyZoneNow } from '../family-time.js';
import { useLinkTexts, useSmsCodes } from '../text-messages.js';
import { useSensitiveConfirm } from '../sensitive-confirm.js';
import { LinkOpens } from '../link-opens.js';
import {
  EmailTheLink,
  LinkAndSend,
  LinkSecret,
  readSendTo,
  sendMadeLink,
  SendFields,
  SentSaid,
  shareLinkAddress,
  TextTheLink,
  useShowAgain,
  type LinkSent,
} from './LinkHandOver.js';

/** A link just made, and what the vault sent of it to whoever it is for (18 Nov 2026). */
export interface MadeLink {
  created: CreatedShare;
  sent: LinkSent[];
}

/**
 * Where Change on a link goes (0.9.0-dev.69): its own page, as a request's
 * is, coming back to `back` — the page it was pressed on — when it is done.
 * A clinician's link (H4) says whose page it is listed on.
 */
export function changeLinkPath(link: Pick<Share, 'id'>, person?: string | null): string {
  return `/sharing/links/${encodeURIComponent(link.id)}${person ? `?person=${encodeURIComponent(person)}` : ''}`;
}

/** "Change the link to “Mansoor’s passport”, shared with the visa agent" */
export const changeLinkLabel = (target: string, s: Pick<Share, 'recipient_label'>) =>
  `Change the link to ${target}${s.recipient_label ? `, shared with ${s.recipient_label}` : ''}`;

/** "Show the link to “Mansoor’s passport”, shared with the visa agent" */
export const showLinkLabel = (target: string, s: Pick<Share, 'recipient_label'>) =>
  `Show the link to ${target}${s.recipient_label ? `, shared with ${s.recipient_label}` : ''}`;

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
   * The document is Only me (5.41): the sheet says the people the link is
   * for will see it; and while the household shares none outside the
   * family, it offers no link at all, and says why.
   */
  onlyMe?: boolean;
  /**
   * A note kept on its own (0.9.0, N1): its link is read on the page, with
   * no file to download — what they can do is not asked.
   */
  note?: boolean;
  /**
   * The document is sensitive, all said (0.9.0, H1a): the sheet asks before
   * the link is made, and the link's page says "A document" unless its
   * title is shown.
   */
  sensitive?: boolean;
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
  /** Told how many of its links can still be taken back, as that changes (the action row). */
  onCount?: (n: number) => void;
  /**
   * On the document's own page (the default), which a link's Change comes
   * back to. False beside the list: the page under it is not the
   * document's, so Change comes back to the document's own page, and what
   * the page under it was told is left to that page.
   */
  fromAddress?: boolean;
}) {
  const { guarded, authVersion, caps } = useApp();
  // Its ids, its own beside the list (IdScope).
  const sid = useIdScope();
  // A code by text (SMS3): offered while the household's texts are set up.
  const texts = useSmsCodes();
  // The link texted to whoever it is for (0.9.0-dev.69): while texts are set up.
  const linkTexts = useLinkTexts();
  const [made, setMade] = useState<MadeLink | null>(null);
  // Changed on their own page, come back here saying so (0.9.0-dev.69).
  const fromAddress = props.fromAddress !== false;
  const said = useArrivedSaid(fromAddress);
  const location = useLocation();
  const backHere = fromAddress
    ? `${location.pathname}${location.search}#share`
    : `/documents/${encodeURIComponent(props.documentId)}#share`;
  // A sensitive document's link starts as view-only, for a week (0.9.0,
  // H5); one the vault can't draw goes to download all the same.
  const options = useLinkOptions(props.sensitive === true ? { permission: 'view' } : undefined);
  const [open, setOpen] = useState(Boolean(props.onClose));
  const [busy, setBusy] = useState<'making' | 'taking back' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mayShare = can(storedRole(), 'document.share');
  // What Sensitive protects (0.9.0, H1a), where the vault has it: asked
  // first, and the title shown on the link's page only if chosen.
  const protects = caps?.features.sensitive_protects === true;
  const sensitive = props.sensitive === true;
  const [showTitle, setShowTitle] = useState(!sensitive);
  const confirm = useSensitiveConfirm({
    title: 'Share a sensitive document?',
    confirmLabel: 'Share it anyway',
  });
  // On a document's page, the form opens in Share a link's place, and
  // closes back to it: the focus goes with it, to who it is for or back to
  // the button, never to nowhere (R5's keyboard paths). The link made says
  // so itself (HandOver).
  const shareButton = useRef<HTMLButtonElement>(null);
  const moved = useRef<'form' | 'button' | null>(null);
  useEffect(() => {
    const to = moved.current;
    if (!to) return;
    // Once it is drawn: the page around it may be drawn again first.
    const target =
      to === 'form' ? document.getElementById(sid('share-label')) : shareButton.current;
    if (!target) return;
    moved.current = null;
    target.focus();
  });

  const { data, reload } = useLoad(
    async (t) => {
      if (!mayShare) return { shares: [], newest: null, timezone: 'UTC', onlyMeOut: true };
      const [shares, versions, profile, rule] = await Promise.all([
        api.shares(t),
        api.versions(t, props.documentId).catch(() => ({ items: [] })),
        api.profile(t).catch(() => null),
        props.onlyMe ? api.onlyMeSharing(t).catch(() => null) : Promise.resolve(null),
      ]);
      const newest = [...versions.items].sort((a, b) => b.version_no - a.version_no)[0] ?? null;
      return {
        shares: shares.items.filter((s) => s.document_id === props.documentId),
        newest,
        // Not reached: the family's zone as the tab knows it, never UTC (the TZ review).
        timezone: profile?.timezone ?? familyZoneNow(),
        // An older vault says nothing: as before, its owner may.
        onlyMeOut: rule?.only_me_shareable ?? true,
      };
    },
    [props.documentId, authVersion, mayShare, props.onlyMe],
  );
  // Its links shown again, as Sharing shows them (0.9.0-dev.69): the one way.
  const reveal = useShowAgain(() => void reload());
  // Listed while it can still be taken back: live, or opened as often as it
  // allows (a page opened with it lasts to its own end).
  const listed = (data?.shares ?? []).filter((s) => s.state === 'active' || s.state === 'used_up');
  const { onCount } = props;
  const live = data ? listed.length : null;
  useEffect(() => {
    if (live !== null) onCount?.(live);
  }, [live, onCount]);
  if (!mayShare) return null;
  // Until the vault answers, the family's zone as this tab knows it — never UTC (the TZ review).
  const timezone = data?.timezone ?? familyZoneNow();
  const viewable = !data?.newest || canShareToView(data.newest.mime);
  // A restore found its file removed for good (5.24): no new link, which
  // would open on nothing; a link already made can still be taken back.
  const removed = data?.newest?.file_removed === true;
  const long =
    data?.newest?.page_count && data.newest.page_count > PREVIEW_MAX_PAGES
      ? data.newest.page_count
      : null;
  // Where the vault can send the link once it is made (18 Nov 2026).
  const sendCan = { email: caps?.features.share_link_email === true, text: linkTexts };
  const read = readLinkOptions(options.value, {
    timezone,
    maxDays: caps?.limits.share_max_days ?? SHARE_MAX_DAYS,
    viewable,
    factors: linkFactors(caps, texts),
    send: sendCan,
  });

  const working = (on: typeof busy) => {
    setBusy(on);
    props.onBusy?.(on !== null);
  };

  const create = async () => {
    if (!read.body) return;
    working('making');
    setError(null);
    // A note's link is read on the page (0.9.0, N1).
    const plain: ShareInput = props.note ? { ...read.body, permission: 'view' } : read.body;
    // Its title on the link's page (H1a): said only when it is not what the
    // vault would do anyway, so a document made sensitive later is covered.
    const body: ShareInput =
      protects && showTitle !== !sensitive ? { ...plain, show_title: showTitle } : plain;
    try {
      const created = await confirm.ask(
        (confirmed) =>
          guarded((t) =>
            api.share(t, props.documentId, confirmed ? { ...body, confirm_sensitive: true } : body),
          ),
        protects && sensitive ? SENSITIVE_SHARE_CONFIRM : null,
      );
      if (created) {
        // Sent to whoever it is for, as typed (18 Nov 2026), then handed over.
        const sent = await sendMadeLink({
          guarded,
          ...madeLinkSends(created, read.sendTo, caps),
        });
        setMade({ created, sent });
        setOpen(false);
        options.reset();
        setShowTitle(!sensitive);
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
        created={made.created}
        sent={made.sent}
        timezone={timezone}
        onDone={() => {
          if (!props.onClose) moved.current = 'button';
          setMade(null);
          props.onClose?.();
        }}
      />
    );
  }

  return (
    <section className="card stack">
      <h2 style={{ fontSize: 18 }}>Send this to someone outside the family</h2>
      <ErrorNote message={error ?? reveal.problem} />
      {confirm.dialog}
      {reveal.dialog}
      {said && (
        <p className="notice status-line" role="status">
          {said}
        </p>
      )}

      {listed.length > 0 && (
        <ul className="list" aria-label="Its links that work now">
          {listed.map((s) => {
            // A view-only link's pages, when there is something to say
            // about them: still being drawn, cut at 30, or not drawable at
            // all — told here as well as when the link was made.
            const pagesNote = sharePagesNote(s.pages);
            const target = props.documentTitle ? `“${props.documentTitle}”` : 'this document';
            return (
              <li key={s.id} className="row" style={{ justifyContent: 'space-between' }}>
                <span className="stack" style={{ gap: 4 }}>
                  <span className="muted">{s.summary}</span>
                  {/* Where the vault last sent it (0.9.0; texts since 0.9.0-dev.69). */}
                  {s.emailed_to && (
                    <span className="muted">
                      {emailedToWords(s.emailed_to, s.emailed_by_name, s.mine)}
                    </span>
                  )}
                  {s.texted_to && (
                    <span className="muted">
                      {textedToWords(s.texted_to, s.texted_by_name, s.mine)}
                    </span>
                  )}
                  {/* Who opened it, when (0.9.0, H5). */}
                  <LinkOpens link={s} />
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
                {/* As Sharing's rows (0.9.0-dev.69): Show the link, Change, Take it back. */}
                <span className="row" style={{ gap: 8 }}>
                  {s.revealable === true && (
                    <button
                      type="button"
                      className="btn btn-quiet"
                      disabled={busy !== null || reveal.busy}
                      aria-label={showLinkLabel(target, s)}
                      onClick={(e) => void reveal.showLink(s, e.currentTarget)}
                    >
                      Show the link
                    </button>
                  )}
                  {s.changeable === true && (
                    <Link
                      to={changeLinkPath(s)}
                      // Back to this page (beside the list: the document's
                      // own), its Share panel open (`#share`), where the change is said.
                      state={{ back: backHere }}
                      className="btn btn-quiet"
                      aria-label={changeLinkLabel(target, s)}
                    >
                      Change
                    </Link>
                  )}
                  <Button kind="quiet" disabled={busy !== null} onClick={() => void revoke(s)}>
                    Take it back
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {removed ? (
        <p className="muted">{COLLECTION_SHARE_FILE_REMOVED}</p>
      ) : props.onlyMe && data && !data.onlyMeOut ? (
        <p className="status status-warn">{ONLY_ME_NOT_SHARED}</p>
      ) : open ? (
        <div className="stack">
          {props.onlyMe && <p className="status status-warn">{ONLY_ME_SHARE_WARNING}</p>}
          <LinkOptions
            options={options}
            read={read}
            timezone={timezone}
            viewable={viewable}
            note={props.note === true}
            notViewable={
              isRecordFormat(data?.newest?.mime)
                ? 'Health record files kept as they are can only be shared with download: the vault doesn’t open them, so it has no pages to show.'
                : 'Word and Excel files can only be shared with download: the vault cannot draw their pages.'
            }
            viewNote={
              long !== null
                ? `They will see the first ${PREVIEW_MAX_PAGES} of ${long} pages.`
                : null
            }
          />
          {/* Why it starts as it does (0.9.0, H5). */}
          {sensitive && props.note !== true && (
            <p className="muted">{sensitiveLinkStartWords({ viewable })}</p>
          )}
          {protects && (
            <>
              <Check
                id={sid('share-show-title')}
                checked={showTitle}
                label={SHOW_TITLE_LABEL}
                note={sensitive ? SHOW_TITLE_SENSITIVE_HINT : undefined}
                onChange={setShowTitle}
              />
              {/* The page, not the file (the H1a review, M5). */}
              <p className="muted">{DOWNLOAD_KEEPS_DETAILS}</p>
            </>
          )}
          <div className="row">
            <Button disabled={busy !== null || !read.body} onClick={() => void create()}>
              {busy === 'making' ? 'Making the link…' : 'Make the link'}
            </Button>
            {/* Not while the link is being made: it would be made, and never shown. */}
            <Button
              kind="quiet"
              disabled={busy !== null}
              onClick={() => {
                if (props.onClose) return props.onClose();
                moved.current = 'button';
                setOpen(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          ref={shareButton}
          kind="quiet"
          onClick={() => {
            moved.current = 'form';
            setOpen(true);
          }}
        >
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
  /**
   * View or download was pressed (0.9.0, H5): a collection's sheet starts
   * view-only while a sensitive one is ticked, until the sharer chooses.
   */
  permissionChosen?: boolean;
  opens: string;
  withPin: boolean;
  /** A password (5.20): one the vault makes up, or one typed here. Never with a PIN. */
  withPassword: boolean;
  passwordMode: 'made' | 'typed';
  password: string;
  /** A code emailed to this address when they ask (5.20). */
  withCode: boolean;
  codeEmail: string;
  /** Or texted to this mobile number (0.9.0, SMS3), where the vault can send texts. */
  codeBy: 'email' | 'sms';
  codePhone: string;
  /**
   * The vault's own refusal of that address, said under it (W520-5), until
   * it is changed.
   */
  codeRefused: string | null;
  /** The first browser to open it is the only one it opens in (5.20). */
  thisDeviceOnly: boolean;
  /**
   * Where the vault sends the link once it is made (0.9.0-dev.69; the
   * owner's feedback of 18 Nov 2026): an email address, a mobile number,
   * either, both or neither. A new link's alone; never its PIN or password.
   */
  sendEmail: string;
  sendPhone: string;
}

const NO_OPTIONS: LinkOptionsValue = {
  sendEmail: '',
  sendPhone: '',
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
  codeBy: 'email',
  codePhone: '',
  codeRefused: null,
  thisDeviceOnly: false,
};

/**
 * A link's options as they are chosen: none yet for a new link, or (0.9.0,
 * LK) a link's own, prefilled, for Change.
 */
export function useLinkOptions(initial?: Partial<LinkOptionsValue>) {
  const [value, setValue] = useState<LinkOptionsValue>(() => ({ ...NO_OPTIONS, ...initial }));
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
        codeBy: v.codeBy,
        thisDeviceOnly: v.thisDeviceOnly,
      })),
  };
}

/**
 * What this vault can ask for besides the link (5.20): a password and one
 * browser only (`share_second_factor`), and an emailed code, only when its
 * operator has given it a mail server (`share_email_code`, A21); and since
 * 0.9.0 a texted code, while the household's texts are set up (`sms_codes`,
 * GET /sms/status: `useSmsCodes`).
 */
export interface LinkFactors {
  second: boolean;
  email: boolean;
  text?: boolean;
}

export function linkFactors(caps: Capabilities | null, texts = false): LinkFactors {
  return {
    second: caps?.features.share_second_factor === true,
    email: caps?.features.share_email_code === true,
    text: caps?.features.sms_codes === true && texts,
  };
}

/** What a texted code proves, beside its choice (SMS3), as the emailed one's truth is said. */
export const SHARE_TEXT_TRUTH =
  'The code proves they have that phone. It protects against a forwarded or misposted link, not a lost phone or a number moved to somebody else’s SIM.';

/**
 * The vault's refusal of what a link asks for, when it is about the address
 * a code goes to (W520-5): said under that field, where it can be put right,
 * rather than at the top of the card. Null for anything else.
 */
export function codeAddressRefusal(err: unknown): string | null {
  if (!(err instanceof ApiRequestError)) return null;
  if (err.code === 'email_code_unavailable') return err.message;
  // A number the vault cannot read, or texts no longer set up (SMS3).
  if (err.code === 'phone_number_invalid' || err.code === 'sms_not_set_up') return err.message;
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
    /**
     * Where the vault can send a new link once it is made (0.9.0-dev.69):
     * by email, by text. Left out (Change), nothing is sent.
     */
    send?: { email: boolean; text: boolean };
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
  // How a code goes (SMS3): as chosen, where the vault can send it that way.
  const by: 'email' | 'sms' | null =
    value.codeBy === 'sms' && factors.text
      ? 'sms'
      : factors.email
        ? 'email'
        : factors.text
          ? 'sms'
          : null;
  const code = value.withCode && by !== null;
  const address = value.codeEmail.trim();
  const phone = value.codePhone.trim();
  // The vault's own rule (isShareAddress, W520-5): nothing it would refuse
  // is offered; and a refusal it gave anyway is said here too. A number is
  // read by the vault, in the household's country.
  const codeProblem = code
    ? by === 'sms'
      ? !/^[+0-9 ()\-.]{7,40}$/.test(phone)
        ? 'Their mobile number, which the code will be texted to: such as 07700 900123.'
        : value.codeRefused
      : !isShareAddress(address)
        ? 'Their email address, which the code will go to: name@example.com.'
        : value.codeRefused
    : null;
  // Where the vault sends it once made (18 Nov 2026): not a part of the link.
  const sendTo = readSendTo(
    { email: value.sendEmail, phone: value.sendPhone },
    ctx.send ?? { email: false, text: false },
  );
  const body: ShareInput | null =
    endAt &&
    !endProblem &&
    !opensProblem &&
    !passwordProblem &&
    !codeProblem &&
    !sendTo.emailProblem &&
    !sendTo.phoneProblem
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
          ...(code && by === 'email' ? { code_email: address } : {}),
          ...(code && by === 'sms'
            ? { second_factor: 'sms' as const, recipient_phone: phone }
            : {}),
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
    by,
    sendTo,
    send: ctx.send ?? null,
  };
}

/**
 * What to send a link just made to, and how (18 Nov 2026): by email where
 * the vault emails links and it is `emailable`, by text where it texts them
 * and it is `textable` — said by the hand-over either way.
 */
export function madeLinkSends(
  created: CreatedShare,
  sendTo: { email: string | null; phone: string | null },
  caps: Capabilities | null,
) {
  const share = created.share;
  return {
    email: sendTo.email
      ? {
          to: sendTo.email,
          can: caps?.features.share_link_email === true && share.emailable === true,
          send: (t: string, body: { to: string }) => api.emailShare(t, share.id, body),
        }
      : null,
    text: sendTo.phone
      ? {
          to: sendTo.phone,
          can: caps?.features.link_texts === true && share.textable === true,
          send: (t: string, body: { to: string }) => api.textShare(t, share.id, body),
        }
      : null,
  };
}

type LinkOptionsHandle = ReturnType<typeof useLinkOptions>;
type LinkOptionsRead = ReturnType<typeof readLinkOptions>;

/**
 * The fields of a link's options (5.18): whom it is for, when it stops,
 * what they can do, how often it opens, and a PIN.
 *
 * Since 0.9.0-dev.69 each part is its own piece too — LinkWho, LinkCanDo,
 * LinkOpensField — so a link's change page lays them out in cards, as a
 * request's is; a new link's sheet keeps them in this order, together.
 */
export function LinkOptions(props: {
  options: LinkOptionsHandle;
  read: LinkOptionsRead;
  timezone: string;
  /** The vault can draw the pages of what is being shared: it can go to view. */
  viewable: boolean;
  /** Why it cannot, when it cannot. */
  notViewable: string;
  /** Said under View, when there is something to say ("the first 30 of 42 pages"). */
  viewNote?: string | null;
  /** Said under the end, after it ("A link that keeps up … lasts 30 days at most."). */
  endNote?: ReactNode;
  /** A note kept on its own (0.9.0, N1): read on the page, nothing to choose. */
  note?: boolean;
}) {
  const { options, read, timezone } = props;
  const sid = useIdScope();
  return (
    <>
      <LinkWho options={options} read={read} />
      <EndPicker
        idPrefix={sid('share')}
        timezone={timezone}
        read={read}
        onChange={(end) => options.set({ end })}
        endNote={props.endNote}
      />
      <LinkCanDo
        options={options}
        viewable={props.viewable}
        notViewable={props.notViewable}
        viewNote={props.viewNote}
        {...(props.note
          ? {
              canDo:
                'They read the note on the page, as it is when they open it. They can copy its words: nothing can stop that.',
            }
          : {})}
      />
      <LinkOpensField options={options} read={read} />
      <Protection options={options} read={read} />
    </>
  );
}

/**
 * Whom a link is for (5.18), and — a new link's alone (0.9.0-dev.69) —
 * where the vault sends it once it is made: "Email the link to" and "Text
 * the link to".
 */
export function LinkWho(props: { options: LinkOptionsHandle; read: LinkOptionsRead }) {
  const { options, read } = props;
  const sid = useIdScope();
  const { value } = options;
  return (
    <>
      <Field
        id={sid('share-label')}
        label="Who is it for?"
        value={value.label}
        onChange={(label) => options.set({ label })}
        required={false}
        hint="Only for your own list — the letting agent, the accountant. It is also written across the pages of a link to view."
      />
      {/* A new link is sent by the vault, if you like (18 Nov 2026): never on Change. */}
      {read.send && (
        <SendFields
          idPrefix={sid('share')}
          email={value.sendEmail}
          phone={value.sendPhone}
          onEmail={(sendEmail) => options.set({ sendEmail })}
          onPhone={(sendPhone) => options.set({ sendPhone })}
          can={read.send}
          read={read.sendTo}
        />
      )}
    </>
  );
}

/**
 * What they can do (5.18): View, or View and download — or, where there is
 * nothing to choose, said (`canDo`): a note is read on the page (0.9.0,
 * N1), and a clinician's link is to view, always (0.9.0, LK).
 */
export function LinkCanDo(props: {
  options: LinkOptionsHandle;
  viewable: boolean;
  notViewable: string;
  viewNote?: string | null | undefined;
  canDo?: string;
  /** Its heading is the card's ("What they can do"): the group is named by it. */
  labelledBy?: string;
}) {
  const { options, viewable } = props;
  const sid = useIdScope();
  const { value } = options;
  if (props.canDo) {
    return (
      <div className="field">
        {!props.labelledBy && <span className="field-label">What they can do</span>}
        <span className="muted">{props.canDo}</span>
      </div>
    );
  }
  return (
    <div className="field" role="group" aria-labelledby={props.labelledBy ?? sid('share-can-h')}>
      {!props.labelledBy && (
        <span id={sid('share-can-h')} className="field-label">
          What they can do
        </span>
      )}
      <div className="pills">
        <button
          type="button"
          className={`pill${value.permission === 'view' && viewable ? ' pill-on' : ''}`}
          aria-pressed={value.permission === 'view' && viewable}
          disabled={!viewable}
          onClick={() => options.set({ permission: 'view', permissionChosen: true })}
        >
          View
        </button>
        <button
          type="button"
          className={`pill${value.permission === 'download' || !viewable ? ' pill-on' : ''}`}
          aria-pressed={value.permission === 'download' || !viewable}
          onClick={() => options.set({ permission: 'download', permissionChosen: true })}
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
  );
}

/** How often it can be opened (5.18): a number, or empty for no limit. */
export function LinkOpensField(props: { options: LinkOptionsHandle; read: LinkOptionsRead }) {
  const { options } = props;
  const sid = useIdScope();
  const { opensProblem } = props.read;
  return (
    <div className="field">
      <label htmlFor={sid('share-opens')}>Can be opened</label>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <input
          id={sid('share-opens')}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          maxLength={6}
          value={options.value.opens}
          onChange={(e) => options.set({ opens: e.target.value })}
          aria-describedby={sid('share-opens-hint')}
          aria-invalid={opensProblem ? true : undefined}
          style={{ width: 96 }}
        />
        <span aria-hidden="true">times</span>
      </div>
      <span
        id={sid('share-opens-hint')}
        className={opensProblem ? 'field-error' : 'muted'}
        role={opensProblem ? 'alert' : undefined}
      >
        {opensProblem ??
          'Leave it empty for no limit. Each press of Open counts; reloading the page it opens does not.'}
      </span>
    </div>
  );
}

/** How a link's or a request's PIN or password goes as it is changed (0.9.0, LK). */
export type SecretChoiceValue = {
  choice: 'keep' | 'none' | 'pin' | 'password';
  mode: 'made' | 'typed';
  password: string;
};

export const SECRET_KEPT: SecretChoiceValue = { choice: 'keep', mode: 'made', password: '' };

/**
 * What is wrong with a password typed for a change, or null. Read as making
 * one reads it: a link's with its spaces at the ends taken off (`trim`), a
 * request's exactly as typed.
 */
export function secretChoiceProblem(
  value: SecretChoiceValue,
  min: number,
  trim = true,
): string | null {
  return value.choice === 'password' &&
    value.mode === 'typed' &&
    (trim ? value.password.trim() : value.password).length < min
    ? `At least ${min} characters. Something they can type, and you can say to them.`
    : null;
}

/**
 * Its PIN or password, as a link or a request is changed (0.9.0, LK): kept
 * as it is, taken away, or made new — a new one replaces the old, and every
 * page opened with the old one has to be opened again. What else protects it
 * — a code, one browser only — stays as it was made, and says so.
 */
export function SecretChoice(props: {
  /** The ids' start: `share` for a link, `ask` for a request. */
  idPrefix: string;
  /** What it has now. */
  has: 'pin' | 'password' | null;
  /** A PIN is offered: a link's always; a request's where the vault takes one (0.9.0-dev.69). */
  pin: boolean;
  value: SecretChoiceValue;
  onChange: (value: SecretChoiceValue) => void;
  problem: string | null;
  /**
   * Its other protections, each a sentence saying what it does and that it
   * stays as it was made (the owner's decision of 16 Nov 2026).
   */
  fixed: string[];
  /**
   * The reader made it (16 Nov 2026): only then are its PIN or password
   * theirs to change. An owner changing somebody else's is told so instead.
   */
  maker?: boolean;
  /** `link` or `request`, as the words say it. */
  what?: 'link' | 'request';
  /** Say what is wrong even with nothing typed, once the form has been sent. */
  showProblem?: boolean;
}) {
  const { idPrefix: p, value } = props;
  const what = props.pin ? 'PIN or password' : 'password';
  if (props.maker === false) {
    return (
      <div className="share-protect" role="group" aria-labelledby={`${p}-protect-h`}>
        <span id={`${p}-protect-h`} className="field-label">
          Protect it
        </span>
        <span className="muted">
          {props.has
            ? `It asks for a ${props.has === 'pin' ? 'PIN' : 'password'}. `
            : `It asks for no ${what}. `}
          Only {props.what === 'request' ? 'whoever asked' : 'whoever made it'} can change its{' '}
          {what}: to change that, take this {props.what ?? 'link'} back and make a new one.
        </span>
        {props.fixed.map((said) => (
          <span key={said} className="muted">
            {said}
          </span>
        ))}
      </div>
    );
  }
  type Choice = [SecretChoiceValue['choice'], string];
  const choices: Choice[] = [
    [
      'keep',
      props.has === 'pin'
        ? 'Keep its PIN'
        : props.has === 'password'
          ? 'Keep its password'
          : `No ${what}, as now`,
    ],
    ...(props.has ? [['none', `No ${what}`] as Choice] : []),
    ...(props.pin
      ? [['pin', props.has === 'pin' ? 'A new four-digit PIN' : 'A four-digit PIN'] as Choice]
      : []),
    ['password', props.has === 'password' ? 'A new password' : 'A password'],
  ];
  return (
    <div className="share-protect" role="group" aria-labelledby={`${p}-protect-h`}>
      <span id={`${p}-protect-h`} className="field-label">
        Protect it
      </span>
      <fieldset className="stack" style={{ gap: 4 }}>
        <legend className="visually-hidden">Its {what}</legend>
        {choices.map(([choice, label]) => (
          <div key={choice} className="check">
            <input
              id={`${p}-secret-${choice}`}
              type="radio"
              name={`${p}-secret`}
              checked={value.choice === choice}
              onChange={() => props.onChange({ ...value, choice })}
            />
            <label htmlFor={`${p}-secret-${choice}`}>{label}</label>
          </div>
        ))}
      </fieldset>
      {value.choice === 'password' && (
        <PasswordChoice
          id={`${p}-password`}
          mode={value.mode}
          password={value.password}
          problem={props.problem}
          onMode={(mode) => props.onChange({ ...value, mode })}
          onPassword={(password) => props.onChange({ ...value, password })}
          typedNote={`At least ${SHARE_PASSWORD_MIN} characters. The vault keeps only a scrambled copy, so write it down before you tell them.`}
          madeNote="Three short groups of letters and numbers, easy to read out. You see it once you save."
          showProblem={props.showProblem === true}
        />
      )}
      {(value.choice === 'pin' || value.choice === 'password' || value.choice === 'none') &&
        props.has !== null && (
          <span className="muted share-indent">
            The old {props.has === 'pin' ? 'PIN' : 'password'} stops working at once. Anyone with a
            page open has to open the link again.
          </span>
        )}
      {props.fixed.map((said) => (
        <span key={said} className="muted">
          {said}
        </span>
      ))}
    </div>
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
        {/* Its zone named where this browser's clock reads otherwise (the TZ review). */}
        {endProblem ?? (endAt ? `Until ${endWords(endAt, timezone)}.` : null)}
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
  /**
   * Say what is wrong even with nothing typed: a form that lets its button
   * be pressed, once it has been (5.22's ask form; the share sheet's button
   * waits instead).
   */
  showProblem?: boolean;
}) {
  const wrong = props.problem && (props.password || props.showProblem) ? props.problem : null;
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
  const sid = useIdScope();
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
    <div className="share-protect" role="group" aria-labelledby={sid('share-protect-h')}>
      <span id={sid('share-protect-h')} className="field-label">
        Protect it
      </span>
      {check(
        sid('share-pin'),
        value.withPin,
        (on) => options.set({ withPin: on, ...(on ? { withPassword: false } : {}) }),
        'Also ask for a four-digit PIN, which you tell them separately',
      )}
      {factors.second && (
        <>
          {check(
            sid('share-with-password'),
            value.withPassword,
            (on) => options.set({ withPassword: on, ...(on ? { withPin: false } : {}) }),
            'Also ask for a password, which you tell them separately',
          )}
          {value.withPassword && (
            <PasswordChoice
              id={sid('share-password')}
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
      {factors.email || factors.text ? (
        <>
          {check(
            sid('share-with-code'),
            value.withCode,
            // Ticked with nowhere yet for the code: where the link is sent,
            // as typed above (18 Nov 2026), to change if it should go elsewhere.
            (on) =>
              options.set({
                withCode: on,
                ...(on && !value.codeEmail.trim() && value.sendEmail.trim()
                  ? { codeEmail: value.sendEmail.trim() }
                  : {}),
                ...(on && !value.codePhone.trim() && value.sendPhone.trim()
                  ? { codePhone: value.sendPhone.trim() }
                  : {}),
              }),
            factors.email && factors.text
              ? 'Also send them a code when they open it'
              : factors.text
                ? 'Also text them a code when they open it'
                : 'Also email them a code when they open it',
            sid('share-code-truth'),
          )}
          {/* By email or by text (SMS3), where the vault can do both. */}
          {value.withCode && factors.email && factors.text && (
            <fieldset className="share-indent share-code-by">
              <legend className="field-label">How the code goes</legend>
              {(['email', 'sms'] as const).map((way) => (
                <div key={way} className="check">
                  <input
                    id={sid(`share-code-by-${way}`)}
                    type="radio"
                    name={sid('share-code-by')}
                    checked={read.by === way}
                    onChange={() => options.set({ codeBy: way, codeRefused: null })}
                  />
                  <label htmlFor={sid(`share-code-by-${way}`)}>
                    {way === 'email' ? 'By email' : 'By text message'}
                  </label>
                </div>
              ))}
            </fieldset>
          )}
          {value.withCode && read.by === 'sms' && (
            <div className="stack share-indent" style={{ gap: 8 }}>
              <div className="field">
                <label htmlFor={sid('share-code-phone')}>Their mobile number</label>
                <input
                  id={sid('share-code-phone')}
                  type="tel"
                  autoComplete="off"
                  maxLength={40}
                  value={value.codePhone}
                  onChange={(e) => options.set({ codePhone: e.target.value, codeRefused: null })}
                  aria-invalid={codeProblem && value.codePhone ? true : undefined}
                  aria-describedby={sid('share-code-phone-note')}
                />
                <span
                  id={sid('share-code-phone-note')}
                  className={codeProblem && value.codePhone ? 'field-error' : 'muted'}
                  role={codeProblem && value.codePhone ? 'alert' : undefined}
                >
                  {codeProblem && value.codePhone
                    ? codeProblem
                    : 'The code is texted only to this number, through your household’s own text messages, and counts towards its texts this month. Nobody is shown the number again but its last three digits.'}
                </span>
              </div>
            </div>
          )}
          {value.withCode && read.by === 'email' && (
            <div className="stack share-indent" style={{ gap: 8 }}>
              <div className="field">
                <label htmlFor={sid('share-code-email')}>Their email address</label>
                <input
                  id={sid('share-code-email')}
                  type="email"
                  autoComplete="off"
                  maxLength={254}
                  value={value.codeEmail}
                  onChange={(e) => options.set({ codeEmail: e.target.value, codeRefused: null })}
                  aria-invalid={codeProblem && value.codeEmail ? true : undefined}
                  aria-describedby={sid('share-code-note')}
                />
                <span
                  id={sid('share-code-note')}
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
          <span id={sid('share-code-truth')} className="muted share-indent">
            {read.by === 'sms' ? SHARE_TEXT_TRUTH : SHARE_CODE_TRUTH}
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
          id={sid('share-device-only')}
          noteId={sid('share-device-note')}
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
 * The link and its PIN, shown once. For a collection (5.19), what it is to
 * and what it gives are the collection's.
 *
 * Since 0.9.0-dev.69 (the owner's feedback of 18 Nov 2026) drawn with a
 * request's pieces, so the two hand over alike: what the vault sent to
 * whoever it is for first, then the link with Copy and Send as the way to
 * send it yourself, its PIN or password with Copy, what it does, and Email
 * the link and Text the link to send it again.
 */
export function HandOver(props: {
  created: CreatedShare;
  timezone: string;
  onDone: () => void;
  /** What the vault sent as it was made (18 Nov 2026). */
  sent?: LinkSent[];
}) {
  // The secret after the #: a browser never sends it to a server, and the
  // page it opens takes it out of the address bar (5.16). On the vault's
  // public-only site when it has one, so the person it is for can reach it.
  const link = shareLinkAddress(props.created);
  const { share } = props.created;
  const collection = share.collection_id ? (share.collection_name ?? 'this collection') : null;
  const pagesNote = sharePagesNote(share.pages);
  const sent = props.sent ?? [];
  // Made: the focus comes here, where the link is, from the button that made
  // it, which is gone (R5's keyboard paths).
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <section className="card stack" data-testid="share-handover">
      <h2 ref={heading} tabIndex={-1} style={{ fontSize: 18 }}>
        {collection
          ? `The link to “${collection}”`
          : `The link to ${share.document_title ?? 'this document'}`}
      </h2>
      <SentSaid
        sent={sent}
        secret={props.created.pin ? 'pin' : props.created.password ? 'password' : null}
      />
      <LinkAndSend link={link} what="link" />
      {props.created.pin && (
        <LinkSecret
          kind="pin"
          value={props.created.pin}
          note="Tell them this some other way — a phone call, not the same message."
        />
      )}
      {/* A password the vault made up (5.20): here, once, and nowhere else. */}
      {props.created.password && (
        <LinkSecret
          kind="password"
          value={props.created.password}
          testId="share-password"
          // Since 0.9.0 a vault that keeps a sealed copy says so (`revealable`).
          note={
            share.revealable
              ? 'Tell them this some other way — a phone call, not the same message. You can see it again from Sharing, after confirming it’s you.'
              : 'Tell them this some other way — a phone call, not the same message. It is shown only now: the vault keeps a scrambled copy it cannot show again.'
          }
        />
      )}
      <ul className="share-terms">
        <li>Until {endWords(share.expires_at, props.timezone)}.</li>
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
            When they open it, a code is {share.second_factor === 'sms' ? 'texted' : 'emailed'} to{' '}
            {share.code_to}, and they type it in. It works once, for 10 minutes.
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
      {/* Other ways to send it, beside Copy: never in its place. */}
      <EmailTheLink share={share} idPrefix="made" />
      <TextTheLink share={share} idPrefix="made" start={sent.find((s) => s.refused)?.refused} />
      <Button onClick={props.onDone}>Done</Button>
    </section>
  );
}
