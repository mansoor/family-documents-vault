import {
  can,
  defaultShareEnd,
  isShareAddress,
  maskEmail,
  SHARE_CODE_TRUTH,
  SHARE_CODE_UNAVAILABLE,
  SHARE_MAX_DAYS,
  shareEndProblem,
  shareQuickPicks,
  UPLOAD_PASSWORD_MIN,
  UPLOAD_REQUEST_ITEM_LABEL_MAX,
  UPLOAD_REQUEST_ITEMS_MAX,
  UPLOAD_REQUEST_MAX_BYTES,
  UPLOAD_REQUEST_MAX_FILES,
  UPLOAD_REQUEST_MESSAGE_MAX,
  UPLOAD_REQUEST_TITLE_MAX,
  uploadRequestTypesWords,
  zonedParts,
  zonedTime,
  type ChangedUploadRequest,
  type CreatedUploadRequest,
  type UploadAcceptTypes,
  type UploadRequestChangeInput,
  type UploadRequestInput,
  type UploadRequestView,
  type UploadReviewBy,
} from '@fdv/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, ApiRequestError } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { storedRole } from '../session.js';
import { Button, Check, ErrorNote, Field, Select, TextArea } from '../ui.js';
import {
  ChangeTrouble,
  changeTrouble,
  FormActions,
  FormCard,
  FormPage,
  PutRightFirst,
} from '../form-page.js';
import {
  DEVICE_ONLY_NOTE,
  EndPicker,
  PasswordChoice,
  SECRET_KEPT,
  SecretChoice,
  secretChoiceProblem,
  type SecretChoiceValue,
} from './Share.js';
import { NewSecret } from './ChangeLink.js';
import {
  LinkAndSend,
  LinkSecret,
  readSendTo,
  requestLinkAddress,
  RequestEmail,
  RequestText,
  requestTarget,
  sendMadeLink,
  SendFields,
  SentSaid,
  type LinkSent,
} from './LinkHandOver.js';
import { endWords, familyZoneNow } from '../family-time.js';
import { useLinkTexts } from '../text-messages.js';

/**
 * Ask for documents (5.22): somebody outside the family — the accountant,
 * the solicitor — is sent a link, `/drop#…`, on which they can put files
 * in and see nothing of the vault (5.21). Owners and adults only; a teen
 * or a viewer is never offered it, and the vault answers them as if there
 * were no such thing.
 *
 * One form: what to send and why, whom it is for, when it stops, what
 * protects it (a password, an emailed code, this browser only, so many
 * visits — 5.20's patterns), how much it takes, what kinds, and who looks
 * at what comes in. Then a card with the link and a made-up password, shown
 * once: the vault keeps neither in a form it can show again.
 *
 * Since 0.9.0-dev.69 (the owner's feedback of 18 Nov 2026) a request is
 * made, changed and handed over as a share link is: "Who it is for" asks
 * for their email address and mobile number, and the vault sends the link
 * to each once it is made; a request may ask for a four-digit PIN instead of
 * a password (`features.upload_request_pin`); and its form, its change page
 * and a link's change page share one layout (form-page.tsx).
 */

/** A request's choices as they are being made. */
export interface AskValue {
  title: string;
  message: string;
  /** The named things to send, in order; empty ones are left out. */
  items: string[];
  label: string;
  /** Whose documents they probably are: a hint for whoever reviews, never shown to the sender. */
  person: string;
  end: { date: string; time: string } | null;
  /** A four-digit PIN the vault makes up (0.9.0-dev.69): never with a password. */
  withPin: boolean;
  withPassword: boolean;
  passwordMode: 'made' | 'typed';
  password: string;
  withCode: boolean;
  email: string;
  /** The vault's own refusal of that address, said under it until it is changed. */
  emailRefused: string | null;
  thisDeviceOnly: boolean;
  limitVisits: boolean;
  visits: string;
  maxFiles: string;
  maxMegabytes: string;
  accept: UploadAcceptTypes;
  reviewBy: UploadReviewBy;
  closeAfter: boolean;
  /** Where the vault sends the link once it is made (0.9.0-dev.69): not a part of the request. */
  sendEmail: string;
  sendPhone: string;
}

const MB = 1024 * 1024;
const MAX_MB = Math.floor(UPLOAD_REQUEST_MAX_BYTES / MB);

const START: AskValue = {
  title: '',
  message: '',
  items: [''],
  label: '',
  person: '',
  end: null,
  withPin: false,
  withPassword: false,
  passwordMode: 'made',
  password: '',
  withCode: false,
  email: '',
  emailRefused: null,
  thisDeviceOnly: false,
  limitVisits: false,
  visits: '3',
  maxFiles: String(UPLOAD_REQUEST_MAX_FILES),
  maxMegabytes: String(MAX_MB),
  accept: 'standard',
  reviewBy: 'me',
  closeAfter: false,
  sendEmail: '',
  sendPhone: '',
};

/** A whole number typed in a text field, within its range; null when it is not one. */
function count(typed: string, min: number, max: number): number | null {
  const t = typed.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
}

/** What the choices come to: the end, what is wrong, and what to send when nothing is. */
export function readAsk(
  value: AskValue,
  ctx: {
    timezone: string;
    maxDays: number;
    emailCode: boolean;
    now?: Date;
    /** The vault takes a PIN on a request (0.9.0-dev.69, `features.upload_request_pin`). */
    pin?: boolean;
    /** Where it can send the link once made (0.9.0-dev.69); left out (Change), nowhere. */
    send?: { email: boolean; text: boolean };
  },
) {
  const now = ctx.now ?? new Date();
  const { timezone, maxDays } = ctx;
  const picks = shareQuickPicks(timezone, now, maxDays);
  const chosen = value.end ?? defaultShareEnd(timezone, now, maxDays);
  const endAt = zonedTime(chosen.date, chosen.time, timezone);
  // The vault's own words, about a request rather than a link.
  const endProblem = endAt
    ? (shareEndProblem(endAt, { now, maxDays })?.replace(/^A link /, 'A request ') ?? null)
    : 'Choose a date and a time.';
  const title = value.title.trim();
  const titleProblem = title ? null : 'Say what you are asking for.';
  const items = value.items.map((i) => i.trim()).filter(Boolean);
  // A PIN or a password, never both (0.9.0-dev.69), as a share link's.
  const pin = ctx.pin === true && value.withPin;
  const password = value.withPassword && !pin;
  const typed = value.password;
  const passwordProblem =
    password && value.passwordMode === 'typed' && typed.length < UPLOAD_PASSWORD_MIN
      ? `At least ${UPLOAD_PASSWORD_MIN} characters. Something they can type, and you can say to them.`
      : null;
  const code = ctx.emailCode && value.withCode;
  const address = value.email.trim();
  const codeProblem = code
    ? !isShareAddress(address)
      ? 'Their email address, which the code will go to: name@example.com.'
      : value.emailRefused
    : null;
  const visits = value.limitVisits ? count(value.visits, 1, 1000) : null;
  const visitsProblem = value.limitVisits && visits === null ? 'A number from 1 to 1000.' : null;
  const maxFiles = count(value.maxFiles, 1, UPLOAD_REQUEST_MAX_FILES);
  const filesProblem = maxFiles === null ? `A number from 1 to ${UPLOAD_REQUEST_MAX_FILES}.` : null;
  const megabytes = count(value.maxMegabytes, 1, MAX_MB);
  const sizeProblem = megabytes === null ? `A number of MB from 1 to ${MAX_MB}.` : null;
  // Where the vault sends it once made (18 Nov 2026): not a part of the request.
  const sendTo = readSendTo(
    { email: value.sendEmail, phone: value.sendPhone },
    ctx.send ?? { email: false, text: false },
  );
  const body: UploadRequestInput | null =
    endAt &&
    !endProblem &&
    !titleProblem &&
    !passwordProblem &&
    !codeProblem &&
    !sendTo.emailProblem &&
    !sendTo.phoneProblem &&
    !visitsProblem &&
    maxFiles !== null &&
    megabytes !== null
      ? {
          title,
          ...(value.message.trim() ? { message: value.message.trim() } : {}),
          ...(items.length ? { items } : {}),
          ...(value.label.trim() ? { recipient_label: value.label.trim() } : {}),
          ...(code ? { email_code: true, recipient_email: address } : {}),
          expires_at: endAt.toISOString(),
          ...(pin ? { with_pin: true } : {}),
          ...(password
            ? value.passwordMode === 'made'
              ? { with_password: true }
              : { password: typed }
            : {}),
          ...(value.thisDeviceOnly ? { this_device_only: true } : {}),
          ...(visits !== null ? { max_visits: visits } : {}),
          max_files: maxFiles,
          max_total_bytes: Math.min(megabytes * MB, UPLOAD_REQUEST_MAX_BYTES),
          accept_types: value.accept,
          review_by: value.reviewBy,
          ...(value.person ? { suggested_member_id: value.person } : {}),
          ...(value.closeAfter ? { close_after_submit: true } : {}),
        }
      : null;
  return {
    now,
    picks,
    chosen,
    endAt,
    endProblem,
    maxDays,
    titleProblem,
    passwordProblem,
    codeProblem,
    visitsProblem,
    filesProblem,
    sizeProblem,
    sendTo,
    body,
  };
}

/** The vault's refusal about the address a code goes to: said under that field. */
function addressRefusal(err: unknown): string | null {
  if (!(err instanceof ApiRequestError)) return null;
  if (err.code === 'email_code_unavailable') return err.message;
  if (err.code === 'validation_failed' && err.detail?.startsWith('recipient_email')) {
    return err.message;
  }
  return null;
}

export function AskForDocumentsScreen() {
  const { guarded, authVersion, caps } = useApp();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const fromPerson = params.get('person');
  // Asked for from a collection's checklist (0.9.0, C1): what it is
  // missing, as the things to send, and back to the collection.
  const location = useLocation();
  const [fromList] = useState(() => {
    const ask = (
      location.state as { ask?: { title?: unknown; items?: unknown; back?: unknown } } | null
    )?.ask;
    if (!ask) return null;
    const items = Array.isArray(ask.items)
      ? ask.items
          .filter((i): i is string => typeof i === 'string' && i.trim() !== '')
          .slice(0, UPLOAD_REQUEST_ITEMS_MAX)
      : [];
    return {
      title: typeof ask.title === 'string' ? ask.title : '',
      items,
      back: typeof ask.back === 'string' && ask.back.startsWith('/collections/') ? ask.back : null,
    };
  });
  const mayAsk = can(storedRole(), 'upload_request.create');
  const back =
    fromList?.back ?? (fromPerson ? `/people/${encodeURIComponent(fromPerson)}` : '/sharing');
  const [value, setValue] = useState<AskValue>(() => ({
    ...START,
    person: fromPerson ?? '',
    ...(fromList
      ? { title: fromList.title, items: fromList.items.length ? fromList.items : [''] }
      : {}),
  }));
  const set = (change: Partial<AskValue>) => setValue((v) => ({ ...v, ...change }));
  const [made, setMade] = useState<{ created: CreatedUploadRequest; sent: LinkSent[] } | null>(
    null,
  );
  // The link texted to whoever it is for (0.9.0-dev.69): while texts are set up.
  const linkTexts = useLinkTexts();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  /** Each press of Make the link with something to put right: the focus goes to it. */
  const [refused, setRefused] = useState(0);
  const form = useRef<HTMLFormElement>(null);
  const itemsBox = useRef<HTMLFieldSetElement>(null);
  const addItem = useRef<HTMLButtonElement>(null);
  const [focusItem, setFocusItem] = useState<number | null>(null);

  const { data, error: loadError } = useLoad(
    async (t) => {
      if (!mayAsk) return null;
      const [requests, members, profile] = await Promise.all([
        api.uploadRequests(t),
        api.members(t),
        api.profile(t).catch(() => null),
      ]);
      return {
        emailCode: requests.email_code_available,
        members: members.items,
        timezone: profile?.timezone ?? familyZoneNow(),
      };
    },
    [authVersion, mayAsk],
  );

  // A thing to send added, or one taken away: the focus goes to the field
  // that is there now, not to the page's start.
  // The last one taken away: the button that names another (the 5.22 review).
  useEffect(() => {
    if (focusItem === null) return;
    const fields = itemsBox.current?.querySelectorAll<HTMLInputElement>('input') ?? [];
    const to = fields[focusItem] ?? fields[fields.length - 1] ?? addItem.current;
    to?.focus();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFocusItem(null);
  }, [focusItem]);

  // Make the link pressed with something to put right: the focus goes to
  // the first thing marked, where what is wrong is said (WCAG 3.3.1).
  useEffect(() => {
    if (refused === 0) return;
    const first =
      form.current?.querySelector<HTMLElement>('[aria-invalid="true"]') ??
      form.current?.querySelector<HTMLElement>('#ask-date');
    first?.focus();
  }, [refused]);

  if (!mayAsk) {
    return (
      <FormPage
        title="Ask for documents"
        back="/"
        lede="Only an owner or an adult can ask someone to send documents."
      />
    );
  }

  // Until the vault answers, the family's zone as this tab knows it — never UTC (the TZ review).
  const timezone = data?.timezone ?? familyZoneNow();
  const emailCode = data?.emailCode === true;
  const pinOffered = caps?.features.upload_request_pin === true;
  const sendCan = { email: caps?.features.upload_request_email === true, text: linkTexts };
  const read = readAsk(value, {
    timezone,
    maxDays: caps?.limits.share_max_days ?? SHARE_MAX_DAYS,
    emailCode,
    pin: pinOffered,
    send: sendCan,
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!read.body) {
      setRefused((n) => n + 1);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await guarded((t) =>
        api.createUploadRequest(t, read.body as UploadRequestInput),
      );
      if (created) {
        // Sent to whoever it is for, as typed (18 Nov 2026), then handed over.
        const r = created.request;
        const sent = await sendMadeLink({
          guarded,
          email: read.sendTo.email
            ? {
                to: read.sendTo.email,
                can: caps?.features.upload_request_email === true && r.emailable === true,
                send: (t, body) => api.emailUploadRequest(t, r.id, body),
              }
            : null,
          text: read.sendTo.phone
            ? {
                to: read.sendTo.phone,
                can: caps?.features.link_texts === true && r.textable === true,
                send: (t, body) => api.textUploadRequest(t, r.id, body),
              }
            : null,
        });
        setMade({ created, sent });
      }
    } catch (err) {
      const refused = addressRefusal(err);
      if (refused) set({ emailRefused: refused });
      else setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  if (made) {
    return (
      <FormPage title="Ask for documents" back={back}>
        <RequestHandOver
          created={made.created}
          sent={made.sent}
          timezone={timezone}
          onDone={() => void navigate(back, { replace: true })}
        />
      </FormPage>
    );
  }

  const person = data?.members.find((m) => m.id === value.person) ?? null;
  const items = value.items;
  return (
    <FormPage
      title="Ask for documents"
      back={back}
      lede="Send someone outside the family a link to put files in — your accountant, a solicitor. They see nothing in the vault, and what they send waits apart from your documents until it is looked at."
    >
      <ErrorNote message={loadError} />
      <form className="stack ask-form" ref={form} onSubmit={(e) => void submit(e)} noValidate>
        <FormCard id="ask-what" title="What you are asking for">
          <Field
            id="ask-title"
            label="Title"
            value={value.title}
            maxLength={UPLOAD_REQUEST_TITLE_MAX}
            placeholder="2025 tax documents"
            requiredMark
            invalid={tried && read.titleProblem !== null}
            onChange={(title) => set({ title })}
            note={
              tried && read.titleProblem ? (
                <span className="field-error">{read.titleProblem}</span>
              ) : (
                'They see it once they open the link.'
              )
            }
          />
          <TextArea
            id="ask-message"
            label="A message for them"
            value={value.message}
            maxLength={UPLOAD_REQUEST_MESSAGE_MAX}
            onChange={(message) => set({ message })}
            hint="If you like: what you need, and by when."
          />
          <fieldset className="stack ask-items" ref={itemsBox}>
            <legend className="field-label">Things to send</legend>
            <p className="muted" id="ask-items-note">
              Each gets its own place on their page: W-2, 1099. Up to {UPLOAD_REQUEST_ITEMS_MAX}.
              They can always send anything else as well.
            </p>
            {items.map((item, i) => (
              <div className="ask-item" key={i}>
                <input
                  type="text"
                  value={item}
                  maxLength={UPLOAD_REQUEST_ITEM_LABEL_MAX}
                  aria-label={`Thing to send ${i + 1}`}
                  aria-describedby="ask-items-note"
                  placeholder={i === 0 ? 'W-2' : i === 1 ? '1099' : ''}
                  onChange={(e) =>
                    set({ items: items.map((x, j) => (j === i ? e.target.value : x)) })
                  }
                />
                <Button
                  kind="quiet"
                  ariaLabel={`Remove ${item.trim() || `thing to send ${i + 1}`}`}
                  onClick={() => {
                    set({ items: items.filter((_, j) => j !== i) });
                    setFocusItem(Math.max(0, i - 1));
                  }}
                >
                  Remove
                </Button>
              </div>
            ))}
            <Button
              ref={addItem}
              kind="quiet"
              disabled={items.length >= UPLOAD_REQUEST_ITEMS_MAX}
              onClick={() => {
                set({ items: [...items, ''] });
                setFocusItem(items.length);
              }}
            >
              {items.length === 0 ? 'Name a thing to send' : 'Add another'}
            </Button>
          </fieldset>
        </FormCard>

        <FormCard id="ask-who" title="Who it is for">
          <Field
            id="ask-label"
            label="Who is it for?"
            value={value.label}
            maxLength={80}
            required={false}
            placeholder="Jane, accountant"
            onChange={(label) => set({ label })}
            hint="For your own list, and the activity log. They do not see it."
          />
          {/* The vault sends the link, if you like (18 Nov 2026), as a share link's. */}
          <SendFields
            idPrefix="ask"
            email={value.sendEmail}
            phone={value.sendPhone}
            onEmail={(sendEmail) => set({ sendEmail })}
            onPhone={(sendPhone) => set({ sendPhone })}
            can={sendCan}
            read={read.sendTo}
          />
          <Select
            id="ask-person"
            label="Whose documents are they?"
            value={value.person}
            options={[
              { value: '', label: 'Not sure, or several people' },
              ...(data?.members ?? []).map((m) => ({ value: m.id, label: m.display_name })),
            ]}
            onChange={(p) => set({ person: p })}
            hint="Only for whoever looks at what comes in. The person sending never sees it."
          />
        </FormCard>

        <FormCard id="ask-when" title="Keeping it safe">
          <EndPicker
            idPrefix="ask"
            timezone={timezone}
            read={read}
            onChange={(end) => set({ end })}
            endNote={
              <span className="muted">
                A request lasts {caps?.limits.share_max_days ?? SHARE_MAX_DAYS} days at most. There
                is no request without an end.
              </span>
            }
          />

          <div className="share-protect" role="group" aria-labelledby="ask-protect-h">
            <span id="ask-protect-h" className="field-label">
              Protect it
            </span>
            {/* A PIN (0.9.0-dev.69), as a share link may: a PIN or a password, never both. */}
            {pinOffered && (
              <Check
                id="ask-pin"
                checked={value.withPin}
                onChange={(withPin) =>
                  set({ withPin, ...(withPin ? { withPassword: false } : {}) })
                }
                label="Also ask for a four-digit PIN, which you tell them separately"
              />
            )}
            <Check
              id="ask-with-password"
              checked={value.withPassword && !(pinOffered && value.withPin)}
              onChange={(withPassword) =>
                set({ withPassword, ...(withPassword ? { withPin: false } : {}) })
              }
              label="Also ask for a password, which you tell them separately"
            />
            {value.withPassword && !(pinOffered && value.withPin) && (
              <PasswordChoice
                id="ask-password"
                mode={value.passwordMode}
                password={value.password}
                problem={read.passwordProblem}
                onMode={(passwordMode) => set({ passwordMode })}
                onPassword={(password) => set({ password })}
                typedNote={`At least ${UPLOAD_PASSWORD_MIN} characters, checked exactly as typed. The vault keeps only a scrambled copy, so write it down before you send the link.`}
                madeNote="Three short groups of letters and numbers, easy to read out. You see it once, with the link. Capitals, spaces and dashes do not matter when they type it."
                showProblem={tried}
              />
            )}
            <Check
              id="ask-with-code"
              checked={emailCode && value.withCode}
              disabled={!emailCode}
              // Ticked with no address yet for the code: where the link is
              // emailed, as typed above (18 Nov 2026), to change if need be.
              onChange={(withCode) =>
                set({
                  withCode,
                  ...(withCode && !value.email.trim() && value.sendEmail.trim()
                    ? { email: value.sendEmail.trim(), emailRefused: null }
                    : {}),
                })
              }
              label="Also email them a code when they open it"
              note={
                emailCode ? (
                  SHARE_CODE_TRUTH
                ) : (
                  <span data-testid="ask-code-unavailable">
                    <strong>Not available here.</strong> {SHARE_CODE_UNAVAILABLE}
                  </span>
                )
              }
            />
            {emailCode && value.withCode && (
              <div className="stack share-indent" style={{ gap: 8 }}>
                <div className="field">
                  <label htmlFor="ask-email">Their email address</label>
                  <input
                    id="ask-email"
                    type="email"
                    autoComplete="off"
                    maxLength={254}
                    value={value.email}
                    onChange={(e) => set({ email: e.target.value, emailRefused: null })}
                    aria-invalid={read.codeProblem && (value.email || tried) ? true : undefined}
                    aria-describedby="ask-email-note"
                  />
                  <span
                    id="ask-email-note"
                    className={read.codeProblem && (value.email || tried) ? 'field-error' : 'muted'}
                    role={read.codeProblem && (value.email || tried) ? 'alert' : undefined}
                  >
                    {read.codeProblem && (value.email || tried)
                      ? read.codeProblem
                      : 'The code goes only to this address, from the vault’s own mail server. They never type an address; they see it with most of it hidden.'}
                  </span>
                </div>
              </div>
            )}
            <Check
              id="ask-device-only"
              checked={value.thisDeviceOnly}
              onChange={(thisDeviceOnly) => set({ thisDeviceOnly })}
              label="This browser only"
              note={DEVICE_ONLY_NOTE}
            />
            <AskVisits value={value} set={set} read={read} />
          </div>
        </FormCard>

        <FormCard id="ask-takes" title="What it takes">
          <AskTakes value={value} set={set} read={read} />
        </FormCard>

        <FormCard id="ask-review" title="Who looks at what comes in">
          <div className="field" role="group" aria-label="Who looks at what comes in">
            <div className="pills">
              {(
                [
                  ['me', 'Only me'],
                  ['adults', 'Any adult'],
                ] as const
              ).map(([v, words]) => (
                <button
                  key={v}
                  type="button"
                  className={`pill${value.reviewBy === v ? ' pill-on' : ''}`}
                  aria-pressed={value.reviewBy === v}
                  onClick={() => set({ reviewBy: v })}
                >
                  {words}
                </button>
              ))}
            </div>
            <span className="muted">
              {value.reviewBy === 'me'
                ? 'Only you can see what they send, until you file it. No other owner or adult can.'
                : 'Any owner or adult can see what they send, and file it. Teens and viewers never see it.'}
              {person ? ` You will be told it is probably ${person.display_name}’s.` : ''}
            </span>
          </div>
        </FormCard>

        <ErrorNote message={error} />
        <FormActions
          label="Make the link"
          busyLabel="Making the link…"
          busy={busy}
          disabled={data === null}
          cancelTo={back}
        />
        <PutRightFirst show={tried && !read.body} />
      </form>
    </FormPage>
  );
}

type AskRead = ReturnType<typeof readAsk>;

/** Only so many visits (5.22): the box, and how many. A request's form and its Change's. */
function AskVisits(props: {
  value: AskValue;
  set: (change: Partial<AskValue>) => void;
  read: AskRead;
}) {
  const { value, set, read } = props;
  return (
    <>
      <Check
        id="ask-limit-visits"
        checked={value.limitVisits}
        onChange={(limitVisits) => set({ limitVisits })}
        label="Only so many visits"
        note="Each press of Open is a visit. Reloading the page it opens is not."
      />
      {value.limitVisits && (
        <div className="field share-indent">
          <label htmlFor="ask-visits">Visits, at most</label>
          <input
            id="ask-visits"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            maxLength={4}
            value={value.visits}
            onChange={(e) => set({ visits: e.target.value })}
            aria-invalid={read.visitsProblem ? true : undefined}
            aria-describedby={read.visitsProblem ? 'ask-visits-note' : undefined}
            style={{ width: 96 }}
          />
          {read.visitsProblem && (
            <span id="ask-visits-note" className="field-error" role="alert">
              {read.visitsProblem}
            </span>
          )}
        </div>
      )}
    </>
  );
}

/** What a request takes (5.22): how many files, how much, what kinds, and closing once sent. */
function AskTakes(props: {
  value: AskValue;
  set: (change: Partial<AskValue>) => void;
  read: AskRead;
}) {
  const { value, set, read } = props;
  return (
    <>
      <div className="ask-limits">
        <div className="field">
          <label htmlFor="ask-max-files">Files, at most</label>
          <input
            id="ask-max-files"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            maxLength={2}
            value={value.maxFiles}
            onChange={(e) => set({ maxFiles: e.target.value })}
            aria-invalid={read.filesProblem ? true : undefined}
            aria-describedby="ask-max-files-note"
          />
          <span
            id="ask-max-files-note"
            className={read.filesProblem ? 'field-error' : 'muted'}
            role={read.filesProblem ? 'alert' : undefined}
          >
            {read.filesProblem ?? `Up to ${UPLOAD_REQUEST_MAX_FILES}.`}
          </span>
        </div>
        <div className="field">
          <label htmlFor="ask-max-mb">In all (MB)</label>
          <input
            id="ask-max-mb"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            maxLength={3}
            value={value.maxMegabytes}
            onChange={(e) => set({ maxMegabytes: e.target.value })}
            aria-invalid={read.sizeProblem ? true : undefined}
            aria-describedby="ask-max-mb-note"
          />
          <span
            id="ask-max-mb-note"
            className={read.sizeProblem ? 'field-error' : 'muted'}
            role={read.sizeProblem ? 'alert' : undefined}
          >
            {read.sizeProblem ?? `Up to ${MAX_MB} MB, all files together.`}
          </span>
        </div>
      </div>
      <div className="field" role="group" aria-labelledby="ask-accept-h">
        <span id="ask-accept-h" className="field-label">
          Kinds of file
        </span>
        <div className="pills">
          {(
            [
              ['standard', 'PDFs and photos'],
              ['office', 'Also Word and Excel'],
            ] as const
          ).map(([v, words]) => (
            <button
              key={v}
              type="button"
              className={`pill${value.accept === v ? ' pill-on' : ''}`}
              aria-pressed={value.accept === v}
              onClick={() => set({ accept: v })}
            >
              {words}
            </button>
          ))}
        </div>
        <span className="muted">
          {value.accept === 'office'
            ? 'Word and Excel files with macros, or that load anything from elsewhere, are refused. What a file is is decided from its contents, never its name.'
            : 'What a file is is decided from its contents, never its name.'}
        </span>
      </div>
      <Check
        id="ask-close-after"
        checked={value.closeAfter}
        onChange={(closeAfter) => set({ closeAfter })}
        label="Close it once they press Finish"
        note="Then the link takes nothing more. Leave it open if they may send things in more than one go."
      />
    </>
  );
}
/**
 * A request changed after it was made (0.9.0, LK; the owner's decision of 15
 * Nov 2026), at /sharing/ask/{id}: the form it was made with, filled in as it
 * is now, for whoever asked, while it works or is only paused. Whom it is
 * for, when it stops, its PIN or password, its visits, what it takes and
 * whether it closes once sent can change; what it asks for, who looks at
 * what comes in, its emailed code and "this browser only" stay as they were
 * made, and are said, not offered. Anything that lets it do more asks to
 * confirm it's you.
 *
 * Since 0.9.0-dev.69 laid out as a link's change page is (form-page.tsx),
 * and changed somewhere else meanwhile, or ended, said the same way: Load it
 * again starts the form afresh from the request as it is now.
 */
export function ChangeRequestScreen() {
  const { id = '' } = useParams();
  const { authVersion } = useApp();
  const { data, error, reload } = useLoad(
    async (t) => {
      const [requests, profile] = await Promise.all([
        api.uploadRequests(t),
        api.profile(t).catch(() => null),
      ]);
      return {
        request: requests.items.find((r) => r.id === id) ?? null,
        timezone: profile?.timezone ?? familyZoneNow(),
      };
    },
    [authVersion, id],
  );
  // Each Load it again starts the form afresh.
  const [round, setRound] = useState(0);
  if (!data) {
    return (
      <FormPage title="Change a request" back="/sharing">
        <ErrorNote message={error} />
      </FormPage>
    );
  }
  if (!data.request || data.request.changeable !== true) {
    return (
      <FormPage
        title="Change a request"
        back="/sharing"
        lede="That request can’t be changed: it has ended, or it isn’t one you made. Make a new one if you need to."
      >
        <Link to="/sharing/ask" className="btn btn-primary">
          Ask for documents
        </Link>
      </FormPage>
    );
  }
  return (
    <ChangeRequestForm
      key={round}
      request={data.request}
      timezone={data.timezone}
      onReload={async () => {
        await reload();
        setRound((n) => n + 1);
      }}
    />
  );
}

function ChangeRequestForm(props: {
  request: UploadRequestView;
  timezone: string;
  onReload: () => Promise<void>;
}) {
  const { request: r, timezone } = props;
  const { guarded, caps } = useApp();
  const navigate = useNavigate();
  const [startEnd] = useState(() => {
    const p = zonedParts(new Date(r.expires_at), timezone);
    return { date: p.date, time: p.time };
  });
  const [startMb] = useState(() => String(Math.max(1, Math.round(r.max_total_bytes / MB))));
  const [value, setValue] = useState<AskValue>(() => ({
    ...START,
    title: r.title,
    message: r.message ?? '',
    label: r.recipient_label ?? '',
    end: startEnd,
    limitVisits: r.max_visits !== null,
    visits: r.max_visits !== null ? String(r.max_visits) : '3',
    maxFiles: String(r.max_files),
    maxMegabytes: startMb,
    accept: r.accept_types,
    reviewBy: r.review_by,
    closeAfter: r.close_after_submit,
  }));
  const set = (change: Partial<AskValue>) => setValue((v) => ({ ...v, ...change }));
  const [secret, setSecret] = useState<SecretChoiceValue>(SECRET_KEPT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trouble, setTrouble] = useState<'conflict' | 'ended' | null>(null);
  const [tried, setTried] = useState(false);
  const [newSecret, setNewSecret] = useState<ChangedUploadRequest | null>(null);

  const now = new Date();
  const latest = r.latest_end ? new Date(r.latest_end) : null;
  const maxDays = latest ? Math.max(0, (latest.getTime() - now.getTime()) / 864e5) : 0;
  const read = readAsk(value, { timezone, maxDays, emailCode: false, now });
  const endTouched =
    value.end !== null && (value.end.date !== startEnd.date || value.end.time !== startEnd.time);
  const endProblem = !endTouched
    ? null
    : read.endProblem?.startsWith('A request can last') && latest
      ? `It can last until ${endWords(latest, timezone)} at the latest: as long as a request may from when it was made.`
      : read.endProblem;
  // Exactly as typed, as making a request reads it.
  const passwordProblem = secretChoiceProblem(secret, UPLOAD_PASSWORD_MIN, false);
  // A PIN (0.9.0-dev.69) where the vault takes one on a request.
  const pinOffered = caps?.features.upload_request_pin === true;
  const has = r.protection.includes('password')
    ? 'password'
    : r.protection.includes('pin')
      ? 'pin'
      : null;

  // Only what is changed.
  const body: UploadRequestChangeInput = {};
  if (!read.titleProblem && value.title.trim() !== r.title) body.title = value.title.trim();
  const message = value.message.trim() || null;
  if (message !== r.message) body.message = message;
  const label = value.label.trim() || null;
  if (label !== r.recipient_label) body.recipient_label = label;
  if (endTouched && read.endAt) body.expires_at = read.endAt.toISOString();
  const visits = value.limitVisits ? Number(value.visits.trim()) : null;
  if (!read.visitsProblem && visits !== r.max_visits) body.max_visits = visits;
  if (!read.filesProblem && Number(value.maxFiles.trim()) !== r.max_files) {
    body.max_files = Number(value.maxFiles.trim());
  }
  if (!read.sizeProblem && value.maxMegabytes.trim() !== startMb) {
    body.max_total_bytes = Math.min(
      Number(value.maxMegabytes.trim()) * MB,
      UPLOAD_REQUEST_MAX_BYTES,
    );
  }
  if (value.accept !== r.accept_types) body.accept_types = value.accept;
  if (value.closeAfter !== r.close_after_submit) body.close_after_submit = value.closeAfter;
  if (secret.choice === 'none' && has) body.secret = 'none';
  if (secret.choice === 'pin') body.secret = 'pin';
  if (secret.choice === 'password') {
    body.secret = 'password';
    if (secret.mode === 'typed') body.password = secret.password;
  }
  const nothing = Object.keys(body).length === 0;
  const problem =
    read.titleProblem ??
    endProblem ??
    read.visitsProblem ??
    read.filesProblem ??
    read.sizeProblem ??
    passwordProblem;
  // Said of the request as it is now: its title may be what changed.
  const back = (now: UploadRequestView = r) =>
    void navigate('/sharing', {
      replace: true,
      state: { said: `${capital(requestTarget(now))} is changed.` },
    });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (nothing || problem) return;
    setBusy(true);
    setError(null);
    setTrouble(null);
    try {
      const done = await guarded((t) => api.changeUploadRequest(t, r.id, body, r.version));
      if (!done) return;
      if (done.pin || done.password) setNewSecret(done);
      else back(done.request);
    } catch (err) {
      const moved = changeTrouble(err);
      if (moved) setTrouble(moved);
      else setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  if (newSecret) {
    return (
      <FormPage title="Change a request" back="/sharing">
        <NewSecret
          what="request"
          pin={newSecret.pin ?? null}
          password={newSecret.password ?? null}
          showAgain={newSecret.request.revealable === true}
          onDone={() => back(newSecret.request)}
        />
      </FormPage>
    );
  }

  // What else protects it, each staying as it was made (16 Nov 2026).
  const fixed = [
    ...(r.protection.includes('email_code')
      ? [
          `It emails a code to ${r.recipient_email ? maskEmail(r.recipient_email) : 'the address you chose'} when it is opened. To send the code somewhere else, take this request back and make a new one.`,
        ]
      : []),
    ...(r.protection.includes('this_device')
      ? [
          'It opens only in the first browser that opened it. To let it open somewhere else, take this request back and make a new one.',
        ]
      : []),
  ];
  return (
    <FormPage
      title="Change a request"
      back="/sharing"
      lede="It stays the same link. Change what you like; anything that lets it do more asks you to confirm it’s you."
    >
      <form className="stack ask-form" onSubmit={(e) => void submit(e)} noValidate>
        <FormCard id="ask-what" title="What you are asking for">
          <Field
            id="ask-title"
            label="Title"
            value={value.title}
            maxLength={UPLOAD_REQUEST_TITLE_MAX}
            requiredMark
            invalid={tried && read.titleProblem !== null}
            onChange={(title) => set({ title })}
            note={
              tried && read.titleProblem ? (
                <span className="field-error">{read.titleProblem}</span>
              ) : (
                'They see it once they open the link.'
              )
            }
          />
          <TextArea
            id="ask-message"
            label="A message for them"
            value={value.message}
            maxLength={UPLOAD_REQUEST_MESSAGE_MAX}
            onChange={(message) => set({ message })}
            hint="If you like: what you need, and by when."
          />
          {r.items.length > 0 && (
            <ul className="muted" aria-label="Things to send">
              {r.items.map((i) => (
                <li key={i.id}>{i.label}</li>
              ))}
            </ul>
          )}
          <p className="muted">
            {r.review_by === 'me'
              ? r.mine
                ? 'Only you look at what comes in.'
                : 'Only whoever asked looks at what comes in.'
              : 'Any adult looks at what comes in.'}{' '}
            The things to send, and who looks at what comes in, stay as they are. To change those,
            take this request back and make a new one.
          </p>
        </FormCard>

        <FormCard id="ask-who" title="Who it is for">
          <Field
            id="ask-label"
            label="Who is it for?"
            value={value.label}
            maxLength={80}
            required={false}
            placeholder="Jane, accountant"
            onChange={(l) => set({ label: l })}
            hint="For your own list, and the activity log. They do not see it."
          />
        </FormCard>

        <FormCard id="ask-when" title="Keeping it safe">
          <EndPicker
            idPrefix="ask"
            timezone={timezone}
            read={{ ...read, endProblem }}
            onChange={(end) => set({ end })}
          />
          <SecretChoice
            idPrefix="ask"
            has={has}
            pin={pinOffered}
            value={secret}
            onChange={setSecret}
            problem={passwordProblem}
            fixed={fixed}
            showProblem={tried}
            maker={r.mine}
            what="request"
          />
          <AskVisits value={value} set={set} read={read} />
        </FormCard>

        <FormCard id="ask-takes" title="What it takes">
          <AskTakes value={value} set={set} read={read} />
        </FormCard>

        {trouble ? (
          <ChangeTrouble
            trouble={trouble}
            what="request"
            busy={busy}
            onReload={() => void props.onReload()}
          />
        ) : (
          <ErrorNote message={error} />
        )}
        <FormActions
          label="Save the changes"
          busyLabel="Saving…"
          busy={busy}
          disabled={nothing}
          cancelTo="/sharing"
        />
        {nothing && <p className="muted">Nothing is changed yet.</p>}
        <PutRightFirst show={tried && problem !== null} />
      </form>
    </FormPage>
  );
}

const capital = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);

/** "1 file", "10 files". */
const filesWord = (n: number) => (n === 1 ? '1 file' : `${n} files`);

/**
 * The link and a made-up password, shown once (5.22): the vault keeps the
 * link's token and the password only as hashes, so this card is the only
 * place either is ever shown. What the request will do is said back under
 * them.
 *
 * Since 0.9.0-dev.69 (the owner's feedback of 18 Nov 2026) drawn with a
 * share link's pieces, so the two hand over alike: what the vault sent to
 * whoever it is for first, then the link with Copy and Send as the way to
 * send it yourself, its PIN or password with Copy, what it does, and Email
 * the link and Text the link to send it again. A vault that keeps a sealed
 * copy shows the PIN or password again from Sharing.
 */
export function RequestHandOver(props: {
  created: CreatedUploadRequest;
  timezone: string;
  onDone: () => void;
  /** What the vault sent as it was made (18 Nov 2026). */
  sent?: LinkSent[];
}) {
  // The secret after the #: a browser never sends it to a server, and the
  // page it opens takes it out of the address bar. On the vault's
  // public-only site when it has one, so whoever it is for can reach it.
  const link = requestLinkAddress(props.created);
  const heading = useRef<HTMLHeadingElement>(null);
  const r = props.created.request;
  const sent = props.sent ?? [];
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const again = r.revealable === true;
  return (
    <section className="card stack" aria-labelledby="handover-h" data-testid="request-handover">
      <h2
        id="handover-h"
        className="handover-title"
        style={{ fontSize: 20 }}
        tabIndex={-1}
        ref={heading}
      >
        {r.recipient_label ? `The link for ${r.recipient_label}` : 'The link to send them'}
      </h2>
      <p className="muted handover-title">“{r.title}”</p>
      <SentSaid
        sent={sent}
        secret={props.created.pin ? 'pin' : props.created.password ? 'password' : null}
      />
      <LinkAndSend link={link} what="request" />
      {props.created.pin && (
        <LinkSecret
          kind="pin"
          value={props.created.pin}
          testId="request-pin"
          note={
            again
              ? 'Tell them this some other way — a phone call, not the same message. You can see it again from Sharing, after confirming it’s you.'
              : 'Tell them this some other way — a phone call, not the same message.'
          }
        />
      )}
      {props.created.password && (
        <LinkSecret
          kind="password"
          value={props.created.password}
          testId="request-password"
          note={
            again
              ? 'Tell them this some other way — a phone call, not the same message. Capitals, spaces and dashes do not matter when they type it. You can see it again from Sharing, after confirming it’s you.'
              : 'Tell them this some other way — a phone call, not the same message. Capitals, spaces and dashes do not matter when they type it. It is shown only now: the vault keeps a scrambled copy it cannot show again.'
          }
        />
      )}
      <ul className="share-terms">
        <li>Until {endWords(r.expires_at, props.timezone)}.</li>
        {r.items.length > 0 && <li>It asks for {r.items.map((i) => i.label).join(', ')}.</li>}
        <li>
          They can send {filesWord(r.max_files)}, {Math.floor(r.max_total_bytes / MB)} MB in all:{' '}
          {uploadRequestTypesWords(r.accept_types)}.
        </li>
        {r.max_visits != null && (
          <li>
            It can be opened{' '}
            {r.max_visits === 1 ? 'once' : r.max_visits === 2 ? 'twice' : `${r.max_visits} times`}.
          </li>
        )}
        {r.protection.includes('password') && !props.created.password && (
          <li>They will be asked for the password you chose.</li>
        )}
        {r.protection.includes('email_code') && r.recipient_email && (
          <li>
            When they open it, a code is emailed to {maskEmail(r.recipient_email)}, and they type it
            in. It works once, for 10 minutes.
          </li>
        )}
        {r.protection.includes('this_device') && (
          <li>It opens only in the first browser that opens it.</li>
        )}
        {r.close_after_submit && <li>It closes once they press Finish.</li>}
        <li>
          {r.review_by === 'me'
            ? 'Only you will see what they send, until you file it.'
            : 'Any owner or adult can see what they send, and file it.'}
        </li>
      </ul>
      <p className="muted">
        Anyone with the link can send files until it ends, and see nothing in the vault. You will
        see when it is opened, and you can take it back from Sharing whenever you like.
      </p>
      {/* Other ways to send it, beside Copy: never in its place. */}
      <RequestEmail request={r} idPrefix="made-request" />
      <RequestText
        request={r}
        idPrefix="made-request"
        start={sent.find((s) => s.refused)?.refused}
      />
      <Button onClick={props.onDone}>Done</Button>
    </section>
  );
}
