import {
  isShareAddress,
  lastEmailedWords,
  lastTextedWords,
  LINK_TEXT_NOTE,
  LINK_TEXTS_NOT_SET_UP,
  SHARE_LINK_EMAIL_UNAVAILABLE,
  SHARE_LINK_EMAIL_MESSAGE_MAX,
  SHARE_LINK_EMAIL_NOTE,
  shareLinkMessage,
  UPLOAD_REQUEST_EMAIL_NOTE,
  UPLOAD_REQUEST_TEXT_NOTE,
  type LinkTexted,
  type LinkTextInput,
  type RevealedUploadRequest,
  type ShareEmailed,
  type ShareEmailInput,
  type UploadRequestView,
} from '@fdv/shared';
import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { api, ApiRequestError, type RevealedShare, type Share } from '../api.js';
import { describeError, useApp } from '../app-context.js';
import { Button, Dialog, ErrorNote, Field, TextArea } from '../ui.js';

/**
 * A link handed over, the one way for share links and requests alike
 * (0.9.0-dev.69; the owner's feedback of 18 Nov 2026). Wherever a link or a
 * request is listed for whoever made it — Sharing, a document's Share panel
 * — "Show the link" shows the same thing, after confirming it's them: the
 * link with Copy the link and Send (the phone's or computer's own share
 * sheet, where the browser has one), its PIN or password with Copy, and
 * "have the vault send it": Email the link and Text the link. And when one
 * is made, the same pieces hand it over, after saying what the vault sent
 * to whoever it is for.
 *
 * Nothing the vault sends carries the PIN or the password: those are told
 * another way, and every hand-over says so.
 */

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

/** Whom a request is for, in a sentence: "the request to Jane, accountant". */
export const requestTarget = (r: UploadRequestView) =>
  `the request “${r.title}”${r.recipient_label ? ` to ${r.recipient_label}` : ''}`;

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

/** A share link's address: on the public-only site when the vault has one, the secret after the #. */
export const shareLinkAddress = (r: { link_url?: string | null | undefined; link_token: string }) =>
  r.link_url ?? `${window.location.origin}/s#${r.link_token}`;

/** A request's address, the same way, at /drop. */
export const requestLinkAddress = (r: {
  link_url?: string | null | undefined;
  link_token: string;
}) => r.link_url ?? `${window.location.origin}/drop#${r.link_token}`;

/** Copied to the clipboard; said on the button until another is pressed. */
function useCopy<K extends string>() {
  const [copied, setCopied] = useState<K | null>(null);
  const copy = (what: K, text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(what),
      () => setCopied(null),
    );
  };
  return { copied, copy };
}

/**
 * The link itself, with Copy the link, and Send where the browser has a
 * share sheet of its own (`navigator.share`: most phones, some computers) —
 * the link alone, never its PIN or password. A link on http:// is warned
 * about: it would not open for whoever it is for.
 */
export function LinkAndSend(props: { link: string; what: 'link' | 'request' }) {
  const { copied, copy } = useCopy<'link'>();
  const [sendProblem, setSendProblem] = useState<string | null>(null);
  const canSend = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const send = () => {
    setSendProblem(null);
    navigator
      .share({
        title: props.what === 'link' ? 'A shared link' : 'Somewhere to send documents',
        url: props.link,
      })
      .catch((err: unknown) => {
        // Closed without sending: nothing to say.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setSendProblem('This browser couldn’t send it. Copy the link and send it yourself.');
      });
  };
  return (
    <>
      <code style={{ wordBreak: 'break-all' }}>{props.link}</code>
      {insecureLink(props.link) && (
        <p className="status status-warn" role="alert">
          {props.what === 'link'
            ? 'This link starts with http://, not https://, so whoever you send it to will not be able to download the document: their browser will not open it over a connection that is not secure. Ask whoever looks after the vault to give it an https:// address first.'
            : 'This link starts with http://, not https://, so whoever you send it to will not be able to send anything: their browser will not open it over a connection that is not secure. Ask whoever looks after the vault to give it an https:// address first.'}
        </p>
      )}
      <div className="row link-send">
        <Button kind="quiet" onClick={() => copy('link', props.link)}>
          {copied === 'link' ? 'Copied' : 'Copy the link'}
        </Button>
        {canSend && (
          <Button kind="quiet" ariaLabel="Send the link from another app" onClick={send}>
            Send
          </Button>
        )}
      </div>
      <ErrorNote message={sendProblem} />
    </>
  );
}

/** A PIN or a password, shown with Copy, and what to do with it. */
export function LinkSecret(props: {
  kind: 'pin' | 'password';
  value: string;
  note?: ReactNode;
  testId?: string;
}) {
  const { copied, copy } = useCopy<'secret'>();
  const what = props.kind === 'pin' ? 'PIN' : 'password';
  return (
    <div className="field" data-testid={props.testId}>
      <span className="field-label">The {what}</span>
      <code
        style={
          props.kind === 'pin'
            ? { fontSize: 24, letterSpacing: 4 }
            : { fontSize: 22, letterSpacing: 2, wordBreak: 'break-all' }
        }
      >
        {props.value}
      </code>
      <Button kind="quiet" onClick={() => copy('secret', props.value)}>
        {copied === 'secret' ? 'Copied' : `Copy the ${what}`}
      </Button>
      {props.note && <span className="muted">{props.note}</span>}
    </div>
  );
}

// ------------------------------------- who it is for: where the vault sends it

/**
 * Where the vault sends a link once it is made (18 Nov 2026), as typed on
 * "Who it is for": an email address, a mobile number, both or neither —
 * each only where the vault can send that way. What is wrong with each is
 * said once something is typed; an empty one sends nothing.
 */
export function readSendTo(
  typed: { email: string; phone: string },
  can: { email: boolean; text: boolean },
) {
  const email = can.email ? typed.email.trim() : '';
  const phone = can.text ? typed.phone.trim() : '';
  const emailProblem =
    email && !isShareAddress(email)
      ? 'That is not an email address. Check it: name@example.com.'
      : null;
  const phoneProblem =
    phone && !looksLikeAPhone(phone)
      ? 'That is not a mobile number. Check it: such as 07700 900123.'
      : null;
  return {
    email: email && !emailProblem ? email : null,
    phone: phone && !phoneProblem ? phone : null,
    emailProblem,
    phoneProblem,
  };
}

/**
 * "Email the link to" and "Text the link to", on a new link's or request's
 * "Who it is for" (18 Nov 2026): optional, and the vault sends the link to
 * each once it is made — never its PIN or password. Where the vault can't
 * send one way, that field is turned off and says why: no mail server
 * (SHARE_LINK_EMAIL_UNAVAILABLE), or the household's texts not set up
 * (LINK_TEXTS_NOT_SET_UP).
 */
export function SendFields(props: {
  /** The ids' start: `share` for a link, `ask` for a request. */
  idPrefix: string;
  email: string;
  phone: string;
  onEmail: (email: string) => void;
  onPhone: (phone: string) => void;
  can: { email: boolean; text: boolean };
  read: ReturnType<typeof readSendTo>;
}) {
  const p = props.idPrefix;
  const { can, read } = props;
  const field = (f: {
    id: string;
    label: string;
    type: 'email' | 'tel';
    value: string;
    onChange: (v: string) => void;
    on: boolean;
    problem: string | null;
    off: string;
    note: string;
    max: number;
  }) => (
    <div className="field">
      <label htmlFor={f.id}>{f.label}</label>
      <input
        id={f.id}
        type={f.type}
        autoComplete="off"
        maxLength={f.max}
        value={f.on ? f.value : ''}
        disabled={!f.on}
        onChange={(e) => f.onChange(e.target.value)}
        aria-invalid={f.on && f.problem ? true : undefined}
        aria-describedby={`${f.id}-note`}
      />
      <span
        id={`${f.id}-note`}
        className={f.on && f.problem ? 'field-error' : 'muted'}
        role={f.on && f.problem ? 'alert' : undefined}
      >
        {!f.on ? f.off : (f.problem ?? f.note)}
      </span>
    </div>
  );
  return (
    <>
      {field({
        id: `${p}-send-email`,
        label: 'Email the link to',
        type: 'email',
        value: props.email,
        onChange: props.onEmail,
        on: can.email,
        problem: read.emailProblem,
        off: SHARE_LINK_EMAIL_UNAVAILABLE,
        note: 'If you like: the vault emails them the link once it is made — never its PIN or password.',
        max: 254,
      })}
      {field({
        id: `${p}-send-phone`,
        label: 'Text the link to',
        type: 'tel',
        value: props.phone,
        onChange: props.onPhone,
        on: can.text,
        problem: read.phoneProblem,
        off: LINK_TEXTS_NOT_SET_UP,
        note: 'Their mobile number, if you like: the vault texts them the link once it is made, through your household’s own text messages — never its PIN or password.',
        max: 40,
      })}
    </>
  );
}

// ------------------------------------------- what the vault sent, when made

/** What the vault did with the address or number typed as the link was made. */
export interface LinkSent {
  way: 'email' | 'text';
  /** Where it went, masked; null when it did not go. */
  to: string | null;
  /** Why it did not go, in the vault's words or ours; null when it went. */
  problem: string | null;
  /**
   * A number the vault couldn't read (`422 phone_number_invalid`): Text the
   * link starts with it, and the vault's words under it, to put right.
   */
  refused?: { to: string; problem: string };
}

/**
 * Sends a link just made to whoever it is for (18 Nov 2026): by email when
 * an address was typed, by text when a number was — each only where the
 * vault can (`can`), and each said, sent or not. Never throws: what could not
 * be sent is said, and Copy the link stays.
 */
export async function sendMadeLink(opts: {
  guarded: <T>(fn: (token: string) => Promise<T>) => Promise<T | null>;
  email: {
    to: string;
    can: boolean;
    send: (token: string, body: ShareEmailInput) => Promise<ShareEmailed>;
  } | null;
  text: {
    to: string;
    can: boolean;
    send: (token: string, body: LinkTextInput) => Promise<LinkTexted>;
  } | null;
}): Promise<LinkSent[]> {
  const sent: LinkSent[] = [];
  if (opts.email && opts.email.to) {
    const { to, can, send } = opts.email;
    sent.push(
      can
        ? await sendOne('email', to, () => opts.guarded((t) => send(t, { to })))
        : {
            way: 'email',
            to: null,
            problem: 'The vault can’t email this one. Copy the link and send it yourself.',
          },
    );
  }
  if (opts.text && opts.text.to) {
    const { to, can, send } = opts.text;
    sent.push(
      can
        ? await sendOne('text', to, () => opts.guarded((t) => send(t, { to })))
        : { way: 'text', to: null, problem: LINK_TEXTS_NOT_SET_UP },
    );
  }
  return sent;
}

async function sendOne(
  way: 'email' | 'text',
  typed: string,
  go: () => Promise<{ sent_to: string } | null>,
): Promise<LinkSent> {
  try {
    const done = await go();
    return done
      ? { way, to: done.sent_to, problem: null }
      : {
          way,
          to: null,
          problem: `It wasn’t ${way === 'email' ? 'emailed' : 'texted'}, as confirming it’s you was cancelled. You can send it below.`,
        };
  } catch (err) {
    if (way === 'text' && err instanceof ApiRequestError && err.code === 'phone_number_invalid') {
      return {
        way,
        to: null,
        problem:
          'The vault couldn’t read that number. Put it right below, and press Text the link.',
        refused: { to: typed, problem: err.message },
      };
    }
    return { way, to: null, problem: describeError(err) };
  }
}

/**
 * What the vault sent, first in a hand-over (18 Nov 2026): "Emailed to
 * j•••@e•••.com", "Texted to •••• •••123", or why one did not go — then
 * Copy the link and Send, as the way to send it yourself.
 */
export function SentSaid(props: {
  sent: LinkSent[];
  /** What it asks for besides the link, which the vault never sends. */
  secret: 'pin' | 'password' | null;
}) {
  if (props.sent.length === 0) return null;
  const all = props.sent.every((s) => s.problem === null);
  const secret = props.secret === 'pin' ? 'PIN' : props.secret;
  return (
    <div className="stack link-sent" style={{ gap: 4 }}>
      <ul className="stack" aria-label="What the vault sent" style={{ gap: 4 }}>
        {props.sent.map((s) => (
          <li
            key={s.way}
            className={`status ${s.problem === null ? 'status-ok' : 'status-warn'}`}
            role={s.problem === null ? undefined : 'alert'}
          >
            {s.problem === null
              ? `${s.way === 'email' ? 'Emailed' : 'Texted'} to ${s.to ?? ''}`
              : `Not ${s.way === 'email' ? 'emailed' : 'texted'}: ${s.problem}`}
          </li>
        ))}
      </ul>
      <p className="muted">
        {all
          ? `${secret ? `Its ${secret} was not sent with it: tell them that another way. ` : ''}You can also copy the link and send it yourself.`
          : 'Copy the link and send it yourself instead, or try again below.'}
      </p>
    </div>
  );
}

// ------------------------------------------------ have the vault send it

/**
 * "Email the link" (0.9.0; the owner's decision of 13 Nov 2026): the vault
 * emails the link to an address its maker types, through the mail server
 * of whoever runs the vault — offered only where there is one
 * (`features.share_link_email`) and on a link the reader made
 * (`Share.emailable`). Beside Copy the link, never in its place: Copy stays
 * whatever happens here. The email never carries the PIN, the password or
 * what the link is to; those are told another way, as the sheet says.
 */
export function EmailTheLink(props: { share: Share; idPrefix: string }) {
  const { caps } = useApp();
  return (
    <EmailALink
      idPrefix={props.idPrefix}
      offered={caps?.features.share_link_email === true && props.share.emailable === true}
      note={SHARE_LINK_EMAIL_NOTE}
      send={(t, body) => api.emailShare(t, props.share.id, body)}
    />
  );
}

/**
 * "Text the link" (0.9.0-dev.69; the owner's feedback of 18 Nov 2026): the
 * vault texts the link to a mobile number its maker types, through the
 * household's own text messages, offered while they are set up
 * (`features.link_texts`, `Share.textable`). As Email the link: beside
 * Copy, never with its PIN or password.
 */
export function TextTheLink(props: {
  share: Share;
  idPrefix: string;
  start?: { to: string; problem: string } | undefined;
}) {
  const { caps } = useApp();
  return (
    <TextALink
      idPrefix={props.idPrefix}
      offered={caps?.features.link_texts === true && props.share.textable === true}
      note={LINK_TEXT_NOTE}
      start={props.start}
      send={(t, body) => api.textShare(t, props.share.id, body)}
    />
  );
}

/** A request's link emailed by the vault (0.9.0, LK; the owner's decision of 16 Nov 2026). */
export function RequestEmail(props: { request: UploadRequestView; idPrefix: string }) {
  const { caps } = useApp();
  return (
    <EmailALink
      idPrefix={props.idPrefix}
      offered={caps?.features.upload_request_email === true && props.request.emailable === true}
      note={UPLOAD_REQUEST_EMAIL_NOTE}
      send={(t, body) => api.emailUploadRequest(t, props.request.id, body)}
    />
  );
}

/** And texted (0.9.0-dev.69), as a share link's is. */
export function RequestText(props: {
  request: UploadRequestView;
  idPrefix: string;
  start?: { to: string; problem: string } | undefined;
}) {
  const { caps } = useApp();
  return (
    <TextALink
      idPrefix={props.idPrefix}
      offered={caps?.features.link_texts === true && props.request.textable === true}
      note={UPLOAD_REQUEST_TEXT_NOTE}
      start={props.start}
      send={(t, body) => api.textUploadRequest(t, props.request.id, body)}
    />
  );
}

/**
 * "Or have the vault email it", for a share link or (0.9.0, LK; the owner's
 * decision of 16 Nov 2026) a request to send documents: the address, a short
 * message, and what never goes in the email.
 */
export function EmailALink(props: {
  idPrefix: string;
  offered: boolean;
  note: string;
  send: (token: string, body: ShareEmailInput) => Promise<ShareEmailed>;
}) {
  const { guarded } = useApp();
  const [to, setTo] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  if (!props.offered) return null;
  const id = `${props.idPrefix}-email-link`;
  const send = async () => {
    setProblem(null);
    setSentTo(null);
    const address = to.trim();
    if (!isShareAddress(address)) {
      setProblem('That is not an email address. Check it: name@example.com.');
      return;
    }
    const words = shareLinkMessage(message);
    if ('problem' in words) {
      setProblem(words.problem);
      return;
    }
    setBusy(true);
    try {
      const sent = await guarded((t) =>
        props.send(t, {
          to: address,
          ...(words.message ? { message: words.message } : {}),
        }),
      );
      if (sent) {
        setSentTo(sent.sent_to);
        setTo('');
        setMessage('');
      }
    } catch (err) {
      setProblem(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack" role="group" aria-labelledby={`${id}-h`} data-testid="email-the-link">
      <h3 id={`${id}-h`} className="field-label">
        Or have the vault email it
      </h3>
      <Field
        id={`${id}-to`}
        label="Email the link to"
        type="email"
        autoComplete="off"
        required={false}
        value={to}
        maxLength={254}
        onChange={setTo}
      />
      <TextArea
        id={`${id}-message`}
        label="A short message, if you like"
        value={message}
        maxLength={SHARE_LINK_EMAIL_MESSAGE_MAX}
        hint="Sent as you type it, with no web addresses or website names in it."
        onChange={setMessage}
      />
      <p className="muted">{props.note}</p>
      <Button kind="quiet" disabled={busy} onClick={() => void send()}>
        {busy ? 'Sending…' : 'Email the link'}
      </Button>
      <p className="status-line" role="status">
        {sentTo ? `Sent to ${sentTo}.` : ''}
      </p>
      <ErrorNote message={problem} />
    </div>
  );
}

/**
 * A mobile number as the page reads it before the vault does: loosely —
 * digits, spaces, brackets, dashes, dots and a +. The vault reads it
 * properly, in the household's country, and says so if it can't.
 */
export const looksLikeAPhone = (typed: string) => /^[+0-9 ()\-.]{7,40}$/.test(typed.trim());

/**
 * "Or have the vault text it" (0.9.0-dev.69), for a share link or a request,
 * as EmailALink: the mobile number, what goes in the text and what never
 * does, and where it went, masked ("Sent to •••• •••123.").
 */
export function TextALink(props: {
  idPrefix: string;
  offered: boolean;
  note: string;
  send: (token: string, body: LinkTextInput) => Promise<LinkTexted>;
  /** A number the vault couldn't read as the link was made: here, with why, to put right. */
  start?: { to: string; problem: string } | undefined;
}) {
  const { guarded } = useApp();
  const [to, setTo] = useState(props.start?.to ?? '');
  const [busy, setBusy] = useState(false);
  // About the number itself, said under it; anything else, under the button.
  const [numberProblem, setNumberProblem] = useState<string | null>(props.start?.problem ?? null);
  const [problem, setProblem] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  if (!props.offered) return null;
  const id = `${props.idPrefix}-text-link`;
  const send = async () => {
    setProblem(null);
    setNumberProblem(null);
    setSentTo(null);
    const number = to.trim();
    if (!looksLikeAPhone(number)) {
      setNumberProblem('That is not a mobile number. Check it: such as 07700 900123.');
      return;
    }
    setBusy(true);
    try {
      const sent = await guarded((t) => props.send(t, { to: number }));
      if (sent) {
        setSentTo(sent.sent_to);
        setTo('');
      }
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'phone_number_invalid') {
        setNumberProblem(err.message);
      } else {
        setProblem(describeError(err));
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack" role="group" aria-labelledby={`${id}-h`} data-testid="text-the-link">
      <h3 id={`${id}-h`} className="field-label">
        Or have the vault text it
      </h3>
      <div className="field">
        <label htmlFor={`${id}-to`}>Text the link to</label>
        <input
          id={`${id}-to`}
          type="tel"
          autoComplete="off"
          maxLength={40}
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
            setNumberProblem(null);
          }}
          aria-invalid={numberProblem ? true : undefined}
          aria-describedby={`${id}-to-note`}
        />
        <span
          id={`${id}-to-note`}
          className={numberProblem ? 'field-error' : 'muted'}
          role={numberProblem ? 'alert' : undefined}
        >
          {numberProblem ??
            'Their mobile number. Nobody is shown it again but its last three digits.'}
        </span>
      </div>
      <p className="muted">{props.note}</p>
      <Button kind="quiet" disabled={busy} onClick={() => void send()}>
        {busy ? 'Sending…' : 'Text the link'}
      </Button>
      <p className="status-line" role="status">
        {sentTo ? `Sent to ${sentTo}.` : ''}
      </p>
      <ErrorNote message={problem} />
    </div>
  );
}

// ------------------------------------------------------------ shown again

/**
 * A link or a request's link shown again to whoever made it (0.9.0; since
 * 0.9.0-dev.69 the one dialog for both): the link with Copy and Send, its
 * PIN or password with Copy, where the vault last sent it, and Email the
 * link and Text the link. Nothing of it is kept on the page once it is
 * closed.
 */
function ShownAgain(props: {
  title: string;
  what: 'link' | 'request';
  link: string;
  madeFor?: string | null;
  pin?: string | undefined;
  password?: string | undefined;
  lastEmailed?: string | null | undefined;
  lastTexted?: string | null | undefined;
  mine?: boolean | undefined;
  /** Have the vault send it: Email the link, Text the link. */
  send: ReactNode;
  returnFocus: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  return (
    <Dialog
      title={props.title}
      wide
      returnFocus={props.returnFocus}
      onClose={props.onClose}
      closeLabel="Hide it"
      closePrimary
    >
      {props.madeFor && <p className="muted">Made for {props.madeFor}.</p>}
      <LinkAndSend link={props.link} what={props.what} />
      {props.pin && <LinkSecret kind="pin" value={props.pin} />}
      {props.password && <LinkSecret kind="password" value={props.password} />}
      {(props.pin || props.password) && (
        <p className="muted">
          Tell them the {props.pin ? 'PIN' : 'password'} some other way — a phone call, not the same
          message.
        </p>
      )}
      {/* Other ways to send it, beside Copy: never in its place. */}
      {props.lastEmailed && (
        <p className="muted">{lastEmailedWords(props.lastEmailed, props.mine)}</p>
      )}
      {props.lastTexted && <p className="muted">{lastTextedWords(props.lastTexted, props.mine)}</p>}
      {props.send}
      <p className="muted">
        Only you can see this again, and only after confirming it’s you. Closing hides it.
      </p>
    </Dialog>
  );
}

/**
 * Show the link, wherever a link or a request is listed for whoever made it
 * (Sharing, a document's Share panel): asked of the vault after confirming
 * it's you — cancelled, nothing is shown — and drawn in the one dialog.
 * `dialog` goes in the page; `problem` is said where the page says such
 * things.
 */
export function useShowAgain(onClosed?: () => void) {
  const { guarded } = useApp();
  const returnFocus = useRef<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState<
    | { kind: 'link'; link: Share; revealed: RevealedShare }
    | { kind: 'request'; request: UploadRequestView; revealed: RevealedUploadRequest }
    | null
  >(null);
  const ask = async (button: HTMLElement | null, go: () => Promise<void>) => {
    returnFocus.current = button;
    setBusy(true);
    setProblem(null);
    try {
      await go();
    } catch (err) {
      setProblem(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  const showLink = (link: Share, button: HTMLElement | null) =>
    ask(button, async () => {
      const revealed = await guarded((t) => api.revealShare(t, link.id));
      if (revealed) setShown({ kind: 'link', link, revealed });
    });
  const showRequest = (request: UploadRequestView, button: HTMLElement | null) =>
    ask(button, async () => {
      const revealed = await guarded((t) => api.revealUploadRequest(t, request.id));
      if (revealed) setShown({ kind: 'request', request, revealed });
    });
  // Closed: the list is asked again, so where the vault sent it shows on its row.
  const close = () => {
    setShown(null);
    onClosed?.();
  };
  const dialog =
    shown === null ? null : shown.kind === 'link' ? (
      <ShownAgain
        title={`The link to ${linkTarget(shown.link, true)}`}
        what="link"
        link={shareLinkAddress(shown.revealed)}
        madeFor={shown.link.recipient_label}
        pin={shown.revealed.pin}
        password={shown.revealed.password}
        lastEmailed={shown.link.emailed_to}
        lastTexted={shown.link.texted_to}
        mine={shown.link.mine}
        send={
          <>
            <EmailTheLink share={shown.link} idPrefix="shown" />
            <TextTheLink share={shown.link} idPrefix="shown" />
          </>
        }
        returnFocus={returnFocus}
        onClose={close}
      />
    ) : (
      <ShownAgain
        title={`The link for ${requestTarget(shown.request)}`}
        what="request"
        link={requestLinkAddress(shown.revealed)}
        pin={shown.revealed.pin}
        password={shown.revealed.password}
        lastEmailed={shown.request.emailed_to}
        lastTexted={shown.request.texted_to}
        mine={shown.request.mine}
        send={
          <>
            <RequestEmail request={shown.request} idPrefix="shown-request" />
            <RequestText request={shown.request} idPrefix="shown-request" />
          </>
        }
        returnFocus={returnFocus}
        onClose={close}
      />
    );
  return { busy, problem, showLink, showRequest, dialog };
}
