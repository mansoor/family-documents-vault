import {
  can,
  defaultShareEnd,
  isShareAddress,
  maskEmail,
  SHARE_CODE_TRUTH,
  SHARE_CODE_UNAVAILABLE,
  SHARE_MAX_DAYS,
  shareEndProblem,
  shareEndWords,
  shareQuickPicks,
  UPLOAD_PASSWORD_MIN,
  UPLOAD_REQUEST_ITEM_LABEL_MAX,
  UPLOAD_REQUEST_ITEMS_MAX,
  UPLOAD_REQUEST_MAX_BYTES,
  UPLOAD_REQUEST_MAX_FILES,
  UPLOAD_REQUEST_MESSAGE_MAX,
  UPLOAD_REQUEST_TITLE_MAX,
  uploadRequestTypesWords,
  zonedTime,
  type CreatedUploadRequest,
  type UploadAcceptTypes,
  type UploadRequestInput,
  type UploadReviewBy,
} from '@fdv/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api, ApiRequestError } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { storedRole } from '../session.js';
import { BottomNav, Button, Check, ErrorNote, Field, Select, TextArea, TopBar } from '../ui.js';
import { DEVICE_ONLY_NOTE, EndPicker, insecureLink, PasswordChoice } from './Share.js';

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
  ctx: { timezone: string; maxDays: number; emailCode: boolean; now?: Date },
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
  const password = value.withPassword;
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
  const body: UploadRequestInput | null =
    endAt &&
    !endProblem &&
    !titleProblem &&
    !passwordProblem &&
    !codeProblem &&
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
  const mayAsk = can(storedRole(), 'upload_request.create');
  const back = fromPerson ? `/people/${encodeURIComponent(fromPerson)}` : '/settings/sharing';
  const [value, setValue] = useState<AskValue>(() => ({ ...START, person: fromPerson ?? '' }));
  const set = (change: Partial<AskValue>) => setValue((v) => ({ ...v, ...change }));
  const [made, setMade] = useState<CreatedUploadRequest | null>(null);
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
        timezone: profile?.timezone ?? 'UTC',
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
      <main className="page page-top has-nav">
        <TopBar title="Ask for documents" back="/settings" />
        <p className="lede">Only an owner or an adult can ask someone to send documents.</p>
        <BottomNav />
      </main>
    );
  }

  const timezone = data?.timezone ?? 'UTC';
  const emailCode = data?.emailCode === true;
  const read = readAsk(value, {
    timezone,
    maxDays: caps?.limits.share_max_days ?? SHARE_MAX_DAYS,
    emailCode,
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
      if (created) setMade(created);
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
      <main className="page page-top has-nav">
        <TopBar title="Ask for documents" back={back} />
        <RequestHandOver
          created={made}
          timezone={timezone}
          onDone={() => void navigate(back, { replace: true })}
        />
        <BottomNav />
      </main>
    );
  }

  const person = data?.members.find((m) => m.id === value.person) ?? null;
  const items = value.items;
  return (
    <main className="page page-top has-nav">
      <TopBar title="Ask for documents" back={back} />
      <p className="lede">
        Send someone outside the family a link to put files in — your accountant, a solicitor. They
        see nothing in the vault, and what they send waits apart from your documents until it is
        looked at.
      </p>
      <ErrorNote message={loadError} />
      <form className="stack ask-form" ref={form} onSubmit={(e) => void submit(e)} noValidate>
        <section className="card stack" aria-labelledby="ask-what-h">
          <h2 id="ask-what-h" style={{ fontSize: 18 }}>
            What you are asking for
          </h2>
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
        </section>

        <section className="card stack" aria-labelledby="ask-who-h">
          <h2 id="ask-who-h" style={{ fontSize: 18 }}>
            Who it is for
          </h2>
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
        </section>

        <section className="card stack" aria-labelledby="ask-when-h">
          <h2 id="ask-when-h" style={{ fontSize: 18 }}>
            Keeping it safe
          </h2>
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
            <Check
              id="ask-with-password"
              checked={value.withPassword}
              onChange={(withPassword) => set({ withPassword })}
              label="Also ask for a password, which you tell them separately"
            />
            {value.withPassword && (
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
              onChange={(withCode) => set({ withCode })}
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
          </div>
        </section>

        <section className="card stack" aria-labelledby="ask-takes-h">
          <h2 id="ask-takes-h" style={{ fontSize: 18 }}>
            What it takes
          </h2>
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
        </section>

        <section className="card stack" aria-labelledby="ask-review-h">
          <h2 id="ask-review-h" style={{ fontSize: 18 }}>
            Who looks at what comes in
          </h2>
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
        </section>

        <ErrorNote message={error} />
        <div className="row">
          <Button type="submit" disabled={busy || data === null}>
            {busy ? 'Making the link…' : 'Make the link'}
          </Button>
          <Link to={back} className="btn btn-quiet">
            Cancel
          </Link>
        </div>
        {tried && !read.body && (
          <p className="field-error" role="alert">
            Something above needs putting right first.
          </p>
        )}
      </form>
      <BottomNav />
    </main>
  );
}

/** "1 file", "10 files". */
const filesWord = (n: number) => (n === 1 ? '1 file' : `${n} files`);

/**
 * The link and a made-up password, shown once (5.22): the vault keeps the
 * link's token and the password only as hashes, so this card is the only
 * place either is ever shown. What the request will do is said back under
 * them.
 */
export function RequestHandOver(props: {
  created: CreatedUploadRequest;
  timezone: string;
  onDone: () => void;
}) {
  // The secret after the #: a browser never sends it to a server, and the
  // page it opens takes it out of the address bar. On the vault's
  // public-only site when it has one, so whoever it is for can reach it.
  const link =
    props.created.link_url ?? `${window.location.origin}/drop#${props.created.link_token}`;
  const [copied, setCopied] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const r = props.created.request;
  useEffect(() => {
    heading.current?.focus();
  }, []);
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
      <code style={{ wordBreak: 'break-all' }}>{link}</code>
      {insecureLink(link) && (
        <p className="status status-warn" role="alert">
          This link starts with http://, not https://, so whoever you send it to will not be able to
          send anything: their browser will not open it over a connection that is not secure. Ask
          whoever looks after the vault to give it an https:// address first.
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
      {props.created.password && (
        <div className="field" data-testid="request-password">
          <span className="field-label">The password</span>
          <code style={{ fontSize: 22, letterSpacing: 2, wordBreak: 'break-all' }}>
            {props.created.password}
          </code>
          <span className="muted">
            Tell them this some other way — a phone call, not the same message. Capitals, spaces and
            dashes do not matter when they type it. It is shown only now: the vault keeps a
            scrambled copy it cannot show again.
          </span>
        </div>
      )}
      <ul className="share-terms">
        <li>Until {shareEndWords(new Date(r.expires_at), props.timezone)}.</li>
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
      <Button onClick={props.onDone}>Done</Button>
    </section>
  );
}
