import {
  readShareCode,
  SENDER_NOTE_MAX,
  SHARE_NEWEST_CODE_ONLY,
  uploadRequestTypesWords,
  type DropCodeSent,
  type DropFile,
  type DropFinished,
  type DropPreview,
  type DropSession,
} from '@fdv/shared';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { api, ApiRequestError, NetworkError } from '../api.js';
import { describeError } from '../app-context.js';
import { sendDropFile } from '../drop-upload.js';
import { Button, ErrorNote, Field, Logo, TextArea } from '../ui.js';

/**
 * The page a request to send documents opens (5.22): `/drop#<token>`.
 *
 * Whoever lands here — the accountant, the solicitor — has no account and
 * is not going to make one. The link is write-only: they can put files in,
 * and see nothing of the vault, not even what they sent once it has gone.
 * The page says whose vault this is and who asked, and opens nothing until
 * they press Open — a link scanner fetching the page is not somebody
 * opening it, and Open is what counts a visit.
 *
 * The secret is in the fragment, which no server is ever sent. It is read
 * once, before the page is drawn (takeLinkToken, from main.tsx), and taken
 * out of the address bar and this tab's history at once, as `/s` does.
 * Open gives a cookie for `/api/v1/drop` alone, named for the request, so
 * a browser can have two open; every call after it names its request
 * (`X-FDV-Drop-Request`, 5.21). Which request this tab opened is kept for
 * the tab (sessionStorage) — the id, never the token — so a reload finds
 * what it had open. And because the cookie is named for the request, a
 * second Open of the same request in this browser would replace the first
 * one's session and strand its files: a page whose request is open in this
 * browser already — another tab, or the link followed again — carries on in
 * that session instead (the 5.22 review).
 *
 * Each phase replaces the last, so its heading takes the focus as it
 * arrives, and a screen reader says where it now is.
 */

type Phase =
  | { kind: 'loading' }
  | { kind: 'preview'; preview: DropPreview }
  | { kind: 'open'; session: DropSession; carriedOn: boolean }
  | { kind: 'finished'; finished: DropFinished; session: DropSession }
  | { kind: 'dead'; message: string }
  /** The vault could not be asked just now: nothing is forgotten, and it can be asked again. */
  | { kind: 'unreachable'; message: string };

const NO_LINK =
  'This page opens a link somebody sent you to send them documents. Open the link from their message again — the whole of it.';

/** Which request this tab has open: its id, kept for a reload. Never the token. */
const OPENED = 'fdv.drop.request';

function rememberOpened(id: string | null): void {
  try {
    if (id) sessionStorage.setItem(OPENED, id);
    else sessionStorage.removeItem(OPENED);
  } catch {
    // A browser that keeps nothing: a reload asks for the link again.
  }
}

function openedBefore(): string | null {
  try {
    return sessionStorage.getItem(OPENED);
  } catch {
    return null;
  }
}

/**
 * Whether this page may open a request at all. Open's cookie is Secure, and
 * a browser keeps it only on a secure page — https, or this computer itself.
 * Anywhere else Open would count a visit, and every file would be refused.
 */
const secure = () => window.isSecureContext !== false;

const when = (iso: string) =>
  new Date(iso).toLocaleString([], { dateStyle: 'long', timeStyle: 'short' });

/** Who asked, in a sentence: their name, or "whoever sent it". */
const asker = (name: string | null) => name ?? 'whoever sent it';

/** A request for one browser, in another (5.20's words: one browser, not the device). */
const otherBrowser = (name: string | null) =>
  `This link has been opened in another browser already, and it only opens there. Open it in the browser you opened it in first, or ask ${asker(name)} for a new one.`;

/** Typed wrong ten times: the request has stopped working for good. */
const locked = (name: string | null) =>
  `The password or code was typed wrong too many times, so this link has stopped working. Ask ${asker(name)} for a new one.`;

/** Past its end. */
const expired = (end: string, name: string | null) =>
  `This request has ended: it worked until ${when(end)}. Ask ${asker(name)} for a new link if you still need to send something.`;

/**
 * The answers that mean what this page had is over — the session, or the
 * request — and nothing else does (the 5.22 review): a dropped connection,
 * the vault busy for a moment, too many tries at once or a fault of its own
 * leave everything as it was, to be asked again.
 */
const OVER = new Set(['drop_session_ended', 'link_not_valid', 'request_used_up', 'other_device']);
const isOver = (err: unknown): err is ApiRequestError =>
  err instanceof ApiRequestError && OVER.has(err.code);

/** Why the vault could not be asked just now, in words for the person sending. */
function notReached(err: unknown): string {
  if (err instanceof ApiRequestError && err.code === 'busy') {
    return 'The vault was busy for a moment. Nothing was lost: try again.';
  }
  if (err instanceof ApiRequestError && err.status === 429) return err.message;
  if (err instanceof ApiRequestError && err.status < 500) return err.message;
  return 'The vault could not be reached just now. Nothing was lost: check your connection, and try again.';
}

/**
 * A file the vault would not take, or could not, in words for the person
 * sending it (5.22): too large, a kind it does not take, macros, the
 * request full, and the vault busy for a moment.
 */
export function fileProblem(err: unknown): { message: string; again: boolean } {
  if (err instanceof NetworkError) {
    return {
      message: 'It did not reach the vault: the connection dropped. Try again.',
      again: true,
    };
  }
  if (!(err instanceof ApiRequestError)) {
    return { message: describeError(err), again: false };
  }
  switch (err.code) {
    case 'busy':
      return {
        message: 'The vault was busy for a moment, and nothing of it was kept. Try again.',
        again: true,
      };
    case 'too_large':
    case 'unsupported_type':
    case 'macros_refused':
    case 'files_used_up':
      return { message: err.message, again: false };
    default:
      return { message: err.message, again: err.retriable };
  }
}

/**
 * The session this browser has open for a request already, if any: another
 * tab's, or this one's from before. Null when there is none; anything that
 * is not an answer is thrown.
 */
async function openAlready(requestId: string | undefined): Promise<DropSession | null> {
  if (!requestId) return null;
  try {
    const session = await api.dropSession(requestId);
    // This request's, and no other's: a session of another request under
    // its name is not carried on in (the 5.22 review, N522S-2).
    return session.request_id === requestId ? session : null;
  } catch (err) {
    if (isOver(err)) return null;
    throw err;
  }
}

export function DropPage({ token }: { token: string | null }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);

  // What was there is gone, and the focus with it: the new heading takes it.
  useEffect(() => {
    if (phase.kind !== 'loading') heading.current?.focus();
  }, [phase.kind, attempt]);

  const onOver = useCallback((message: string) => {
    rememberOpened(null);
    setPhase({ kind: 'dead', message });
  }, []);

  const onOpened = useCallback((session: DropSession, carriedOn: boolean) => {
    rememberOpened(session.request_id);
    setPhase({ kind: 'open', session, carriedOn });
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        if (token) {
          // A page opened with a link is about that link: whatever this tab
          // had open before is not what a reload should bring back now.
          rememberOpened(null);
          const preview = await api.dropPreview(token);
          if (!live) return;
          if (preview.other_device) {
            setPhase({ kind: 'dead', message: otherBrowser(preview.requested_by) });
            return;
          }
          // Open in this browser already: carried on, not opened again.
          const already = await openAlready(preview.request_id);
          if (!live) return;
          if (already) onOpened(already, true);
          else setPhase({ kind: 'preview', preview });
          return;
        }
        // No token: the page was reloaded after Open, or opened without its
        // link. What this tab opened, if anything, is still open.
        const id = openedBefore();
        if (!id) {
          if (live) setPhase({ kind: 'dead', message: NO_LINK });
          return;
        }
        const session = await api.dropSession(id);
        if (live) setPhase({ kind: 'open', session, carriedOn: false });
      } catch (err) {
        if (!live) return;
        if (isOver(err)) {
          // Over: forgotten, and said so.
          rememberOpened(null);
          setPhase({
            kind: 'dead',
            message: !token && err.code === 'drop_session_ended' ? NO_LINK : err.message,
          });
          return;
        }
        // Not reached: nothing is forgotten, so asking again finds it.
        setPhase({ kind: 'unreachable', message: notReached(err) });
      }
    })();
    return () => {
      live = false;
    };
  }, [token, attempt, onOpened]);

  return (
    <main className="page drop-page">
      <Logo />
      {phase.kind === 'loading' && (
        <p className="status status-warn" role="status">
          Opening the link…
        </p>
      )}

      {phase.kind === 'dead' && (
        <section className="card stack" aria-labelledby="drop-h">
          <h1 id="drop-h" style={{ fontSize: 22 }} tabIndex={-1} ref={heading}>
            This link cannot be opened
          </h1>
          <p className="muted" role="alert">
            {phase.message}
          </p>
        </section>
      )}

      {phase.kind === 'unreachable' && (
        <section className="card stack" aria-labelledby="drop-h">
          <h1 id="drop-h" style={{ fontSize: 22 }} tabIndex={-1} ref={heading}>
            Not reached just now
          </h1>
          <p className="muted" role="alert">
            {phase.message}
          </p>
          <Button
            onClick={() => {
              setPhase({ kind: 'loading' });
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </Button>
        </section>
      )}

      {phase.kind === 'preview' && token && (
        <Preview
          token={token}
          preview={phase.preview}
          heading={heading}
          onOpened={onOpened}
          onOver={onOver}
        />
      )}

      {phase.kind === 'open' && (
        <Opened
          session={phase.session}
          carriedOn={phase.carriedOn}
          heading={heading}
          onFinished={(finished, session) => {
            rememberOpened(null);
            setPhase({ kind: 'finished', finished, session });
          }}
          onOver={onOver}
        />
      )}

      {phase.kind === 'finished' && (
        <Finished finished={phase.finished} session={phase.session} heading={heading} />
      )}
    </main>
  );
}

/** What Open asks for, in the sentence that says who asked. */
function asksFor(needs: { password: boolean; code: boolean }): string {
  if (needs.password && needs.code) {
    return ' Open asks for the password they gave you, and a code we email to you.';
  }
  if (needs.password) return ' Open asks for the password they gave you.';
  if (needs.code) return ' Open asks for a code, which we email to you.';
  return '';
}

function Preview({
  token,
  preview,
  heading,
  onOpened,
  onOver,
}: {
  token: string;
  preview: DropPreview;
  heading: RefObject<HTMLHeadingElement | null>;
  onOpened: (session: DropSession, carriedOn: boolean) => void;
  onOver: (message: string) => void;
}) {
  const needsPassword = preview.protection.includes('password');
  const needsCode = preview.protection.includes('email_code');
  const oneBrowser = preview.protection.includes('this_device');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Each refusal of Open, so the focus goes back to what to put right every time. */
  const [refusals, setRefusals] = useState(0);
  const [sent, setSent] = useState<DropCodeSent | null>(null);
  // How many codes this page has sent: what it says changes with each, so
  // a screen reader hears a second send as well as the first (W520-2).
  const [sends, setSends] = useState(0);
  const [sending, setSending] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const canOpen = secure();
  const name = preview.requested_by;

  /** A refusal that means the request cannot be opened here at all. */
  const overFor = (err: unknown): string | null => {
    if (!(err instanceof ApiRequestError)) return null;
    if (err.code === 'other_device') return otherBrowser(name);
    if (err.code === 'link_not_valid' || err.code === 'request_used_up') return err.message;
    return null;
  };

  const sendCode = async () => {
    setSending(true);
    setCodeError(null);
    try {
      setSent(await api.dropCode(token));
      setSends((n) => n + 1);
      setCode('');
    } catch (err) {
      const over = overFor(err);
      if (over) onOver(over);
      else setCodeError(describeError(err));
    } finally {
      setSending(false);
    }
  };
  // Sent: the focus goes to where the code is typed (W520-2).
  useEffect(() => {
    if (sends > 0) document.getElementById('drop-code-input')?.focus();
  }, [sends]);
  // Refused: the focus goes to what to put right — the password, else the
  // code — not left on a button that was turned off while it was asked.
  useEffect(() => {
    if (refusals === 0) return;
    const field =
      document.getElementById('drop-password') ?? document.getElementById('drop-code-input');
    field?.focus();
  }, [refusals]);

  const open = async (e: FormEvent) => {
    e.preventDefault();
    if (!canOpen) return;
    setBusy(true);
    setError(null);
    try {
      // Opened in another tab of this browser while this one waited: carried
      // on there rather than opened again, which would strand its files.
      const already = await openAlready(preview.request_id);
      if (already) {
        onOpened(already, true);
        return;
      }
      const session = await api.dropUnlock(token, {
        ...(needsPassword && password ? { password } : {}),
        ...(needsCode ? { code: readShareCode(code) ?? code.trim() } : {}),
      });
      setPassword('');
      setCode('');
      onOpened(session, false);
    } catch (err) {
      const over = overFor(err);
      if (over) {
        onOver(over);
        return;
      }
      if (err instanceof ApiRequestError && err.code === 'secret_wrong') {
        // The tenth wrong try locks it: asked again, a locked request is
        // not there, and the page says so rather than "try again".
        const stillThere = await api.dropPreview(token).then(
          () => true,
          (again: unknown) =>
            !(again instanceof ApiRequestError && again.code === 'link_not_valid'),
        );
        if (!stillThere) {
          onOver(locked(name));
          return;
        }
      }
      setError(
        err instanceof ApiRequestError && err.code === 'busy'
          ? 'The vault was busy for a moment, and nothing was counted. Press Open again.'
          : describeError(err),
      );
      setRefusals((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  const ready =
    (!needsPassword || password.length > 0) && (!needsCode || readShareCode(code) !== null);
  return (
    <>
      <h1 id="drop-h" style={{ fontSize: 26 }} tabIndex={-1} ref={heading}>
        Send documents to {preview.household_name}
      </h1>
      <form className="card stack" aria-labelledby="drop-h" onSubmit={(e) => void open(e)}>
        <p>
          {name ? <strong>{name}</strong> : 'Somebody'} asked you to send documents to{' '}
          {preview.household_name}’s vault.{asksFor({ password: needsPassword, code: needsCode })}
        </p>
        <ul className="share-terms">
          <li>
            After Open you see what they asked for, and choose the files. You can only send: you
            cannot see anything in the vault.
          </li>
          <li>Each press of Open counts as a visit. Reloading the page it opens does not.</li>
          {/* How to follow it from here (5.20's N520W-5): this page has
              already taken the link out of its address, so the email app's
              "open in your browser" would open nothing. */}
          {oneBrowser && (
            <li>
              It opens only in the first browser that opens it. Open it in the browser you usually
              use — not a private window, or the browser inside your email app — because after that
              it will not open anywhere else. If this page opened inside your email app, go back to
              the email, press and hold the link, and open it in your usual browser.
            </li>
          )}
        </ul>
        {needsPassword && (
          <Field
            id="drop-password"
            label="The password they gave you"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            maxLength={64}
            hint="It came separately from the link."
          />
        )}
        {needsCode && (
          <div className="stack" style={{ gap: 8 }} data-testid="drop-code">
            <p className="share-code-sent">
              We email a code to{' '}
              {preview.code_to ? <strong>{preview.code_to}</strong> : 'the address'}, the address{' '}
              {asker(name)} gave for you. {SHARE_NEWEST_CODE_ONLY}, once, for 10 minutes.
            </p>
            {/* Always here (5.20's W520-1): a code already in the inbox — from
                before a reload, or from the email app — is typed without
                sending another, which would end it. */}
            <Field
              id="drop-code-input"
              label="The code from the email"
              value={code}
              onChange={setCode}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={9}
              hint={
                sent
                  ? 'Six digits. If it has not come, look in junk mail, or send another.'
                  : 'Already have a code? Type it here. Six digits, from the newest email.'
              }
            />
            {/* Always in the page, so what it says is heard when it changes. */}
            <p
              className={`status-line share-code-status${sent ? ' status status-ok' : ''}`}
              role="status"
            >
              {sent
                ? sends > 1
                  ? `We sent a new code to ${sent.sent_to} (${sends} so far). The one before it no longer works.`
                  : `We sent a code to ${sent.sent_to}.`
                : ''}
            </p>
            <ErrorNote message={codeError} />
            <Button
              kind={sent ? 'quiet' : 'primary'}
              disabled={sending || !canOpen}
              onClick={() => void sendCode()}
            >
              {sending ? 'Sending…' : sent ? 'Send another code' : 'Email me a code'}
            </Button>
          </div>
        )}
        {!canOpen && (
          <p className="status status-warn" role="note">
            This page is not on a secure connection, so this browser could not send files. Open is
            turned off: nothing has been opened, and {asker(name)} has not been told it was. Ask for
            a link that starts with https://.
          </p>
        )}
        <ErrorNote message={error} />
        <Button type="submit" disabled={!canOpen || busy || !ready}>
          {busy ? 'Opening…' : 'Open'}
        </Button>
        <p className="muted">
          Nothing is opened until you press Open. The link works until {when(preview.expires_at)},
          and {asker(name)} can take it back sooner. They will see that it was opened.
        </p>
      </form>
    </>
  );
}

/** A file on its way, or one that did not go. */
interface Sending {
  key: number;
  itemId: string | null;
  file: File;
  sent: number;
  /**
   * Waiting its turn; sending; arriving — every byte gone, the vault
   * checking it, and too late to stop; or not sent, and why.
   */
  state: 'waiting' | 'sending' | 'arriving' | 'failed';
  problem?: string;
  again?: boolean;
  stop?: () => void;
}

/** The extensions a file chooser offers beside the kinds the request takes. */
const EXTENSIONS: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg,.jpeg',
  'image/png': '.png',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/tiff': '.tif,.tiff',
  'image/webp': '.webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
};

export function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / 1024 / 1024;
  return `${mb >= 10 ? Math.floor(mb) : mb.toFixed(1).replace(/\.0$/, '')} MB`;
}

const files = (n: number) => (n === 1 ? '1 file' : `${n} files`);

/** How many files the page holds now, said after each change so each change is heard. */
const readyWords = (n: number) =>
  n === 0
    ? 'Nothing is ready to send.'
    : n === 1
      ? '1 file is ready to send.'
      : `${n} files are ready to send.`;

/** The vault's own words for a request whose files are all in (5.21's files_used_up). */
const fullWords = (max: number) =>
  `This request takes ${max} ${max === 1 ? 'file' : 'files'}, and that many have been sent.`;

/** A file added to what the session lists, and the room it takes. */
function withFile(s: DropSession, f: DropFile): DropSession {
  if (s.files.some((x) => x.id === f.id)) return s;
  const bytesLeft = Math.max(0, s.bytes_left - f.byte_size);
  return {
    ...s,
    files: [...s.files, f],
    files_left: Math.max(0, s.files_left - 1),
    bytes_left: bytesLeft,
    max_file_bytes: Math.min(s.max_file_bytes, bytesLeft),
  };
}

function Opened({
  session: first,
  carriedOn,
  heading,
  onFinished,
  onOver,
}: {
  session: DropSession;
  /** Open in this browser already — another tab, or the link followed again: carried on. */
  carriedOn: boolean;
  heading: RefObject<HTMLHeadingElement | null>;
  onFinished: (finished: DropFinished, session: DropSession) => void;
  onOver: (message: string) => void;
}) {
  const [session, setSession] = useState(first);
  const [sending, setSending] = useState<Sending[]>([]);
  const [note, setNote] = useState('');
  const [said, setSaid] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The vault could not be asked what has arrived: the list may be behind. */
  const [stale, setStale] = useState(false);
  const status = useRef<HTMLParagraphElement>(null);
  const finishButton = useRef<HTMLButtonElement>(null);
  /** Each time Finish found the list behind: the focus goes back to Finish (N522W-4). */
  const [askedAgain, setAskedAgain] = useState(0);
  const nextKey = useRef(1);
  /** The files started already: an effect run twice never sends one twice. */
  const started = useRef(new Set<number>());
  /** The session as it is now, for what runs after an answer arrives. */
  const latest = useRef(session);
  useEffect(() => {
    latest.current = session;
  }, [session]);
  const name = session.requested_by;

  /** Says something in the page's one status line, and puts the focus there. */
  const say = useCallback((words: string, focus = false) => {
    setSaid(words);
    if (focus) window.setTimeout(() => status.current?.focus(), 0);
  }, []);

  /** The session, or the request, is over: said in words for why. */
  const over = useCallback(
    (err: unknown): boolean => {
      if (!isOver(err)) return false;
      if (Date.parse(latest.current.expires_at) <= Date.now()) {
        onOver(expired(latest.current.expires_at, name));
      } else if (err.code === 'other_device') onOver(otherBrowser(name));
      else onOver(err.message);
      return true;
    },
    [name, onOver],
  );

  /**
   * What the vault has for this session now. On an answer that is not one —
   * the connection, the vault busy — what the page has stays, and it says
   * the list may be behind, with a way to ask again.
   */
  const refresh = useCallback(async (): Promise<DropSession | null> => {
    try {
      const fresh = await api.dropSession(latest.current.request_id);
      setSession(fresh);
      setStale(false);
      return fresh;
    } catch (err) {
      if (!over(err)) setStale(true);
      return null;
    }
  }, [over]);

  // Another tab of this browser may add to the same session: what the vault
  // has is asked again whenever this tab is looked at again.
  useEffect(() => {
    const onShow = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onShow);
    return () => document.removeEventListener('visibilitychange', onShow);
  }, [refresh]);

  // One file at a time, in the order chosen: each is counted against the
  // request's room as it goes, and the address's limit of 20 a minute.
  const current = sending.find((s) => s.state === 'sending' || s.state === 'arriving');
  const waiting = sending.find((s) => s.state === 'waiting');
  useEffect(() => {
    if (current || !waiting || started.current.has(waiting.key)) return;
    const key = waiting.key;
    started.current.add(key);
    const update = (change: Partial<Sending>) =>
      setSending((all) => all.map((s) => (s.key === key ? { ...s, ...change } : s)));
    // The room left, as the vault last said it and with what has arrived
    // since: a file it cannot take is not sent at all.
    const room = latest.current;
    const tooBig = waiting.file.size > room.max_file_bytes && waiting.file.size <= room.bytes_left;
    const noRoom =
      room.files_left <= 0
        ? fullWords(room.max_files)
        : waiting.file.size > room.bytes_left
          ? `That file would take this request past what it can take: ${sizeOf(room.bytes_left)} is left.`
          : tooBig
            ? `That file is too big: one file can be ${sizeOf(room.max_file_bytes)} at most.`
            : null;
    if (noRoom) {
      // Room another file's removal can make: worth trying again then.
      update({ state: 'failed', problem: noRoom, again: !tooBig });
      return;
    }
    const before = new Set(room.files.map((f) => f.id));
    /** Every byte went: the vault may keep it whatever the answer says, or if none comes. */
    let allSent = false;
    const going = sendDropFile(session.request_id, waiting.file, waiting.itemId, {
      progress: (sent) => update({ sent }),
      // Every byte gone: too late to stop it, so Stop goes.
      sent: () => {
        allSent = true;
        update({ state: 'arriving', sent: waiting.file.size });
      },
    });
    update({ state: 'sending', stop: going.stop });
    going.done.then(
      async (file: DropFile) => {
        const next = withFile(latest.current, file);
        latest.current = next;
        setSession(next);
        setSending((all) => all.filter((s) => s.key !== key));
        say(`Sent “${file.name}”. ${readyWords(next.files.length)}`);
        await refresh();
      },
      async (err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') {
          setSending((all) => all.filter((s) => s.key !== key));
          // Stopped as its last bytes went, the vault may have kept it
          // anyway: asked, and said whichever it was.
          const fresh = await refresh();
          const arrived = fresh?.files.find(
            (f) => !before.has(f.id) && f.name === waiting.file.name,
          );
          say(
            arrived
              ? `“${waiting.file.name}” had already arrived, so it is listed: remove it if you do not want it sent.`
              : fresh
                ? `Stopped sending “${waiting.file.name}”. Nothing of it was kept.`
                : `Stopped sending “${waiting.file.name}”. If it had already arrived, it will be listed once the vault answers.`,
            true,
          );
          return;
        }
        if (over(err)) return;
        // No answer, or one that could not be read, after the vault may have
        // had every byte: what arrived is asked before anything is said
        // (N522W-1), so a file the vault kept is listed, not called lost.
        const unanswered =
          allSent ||
          err instanceof NetworkError ||
          (err instanceof ApiRequestError && (err.status >= 500 || err.status < 300));
        if (unanswered) {
          const fresh = await refresh();
          const arrived = fresh?.files.find(
            (f) => !before.has(f.id) && f.name === waiting.file.name,
          );
          if (arrived) {
            setSending((all) => all.filter((s) => s.key !== key));
            say(
              `“${waiting.file.name}” arrived after all, so it is listed. ${readyWords(fresh?.files.length ?? 0)}`,
              true,
            );
            return;
          }
        }
        const problem = fileProblem(err);
        // Said where the file is, as an alert: not again in the line that
        // says what went well.
        update({ state: 'failed', problem: problem.message, again: problem.again, sent: 0 });
        // Refused for want of room: what the vault has now, so the list and
        // the room line match it.
        if (
          err instanceof ApiRequestError &&
          (err.code === 'files_used_up' || err.code === 'too_large')
        ) {
          await refresh();
        }
      },
    );
  }, [current, waiting, session.request_id, refresh, over, say]);

  const choose = (itemId: string | null, chosen: FileList | null) => {
    if (!chosen || chosen.length === 0) return;
    // What the request can still take, less what is already waiting to go.
    const queued = sending.filter((s) => s.state !== 'failed');
    let filesLeft = session.files_left - queued.length;
    let bytesLeft = session.bytes_left - queued.reduce((n, s) => n + s.file.size, 0);
    const add: Sending[] = [...chosen].map((file) => {
      const key = nextKey.current++;
      // Said at once, before any of it is sent: too big for any file here,
      // or no room left for it — which removing another file can make.
      const tooBig = file.size > session.max_file_bytes && file.size <= session.bytes_left;
      const refused = tooBig
        ? `That file is too big: one file can be ${sizeOf(session.max_file_bytes)} at most.`
        : filesLeft <= 0
          ? fullWords(session.max_files)
          : file.size > bytesLeft
            ? `That file would take this request past what it can take: ${sizeOf(Math.max(0, bytesLeft))} is left.`
            : null;
      if (refused) {
        return { key, itemId, file, sent: 0, state: 'failed', problem: refused, again: !tooBig };
      }
      filesLeft -= 1;
      bytesLeft -= file.size;
      return { key, itemId, file, sent: 0, state: 'waiting' };
    });
    setSending((all) => [...all, ...add]);
  };

  const remove = async (file: DropFile) => {
    setRemoving(file.id);
    setError(null);
    try {
      await api.dropRemoveFile(session.request_id, file.id);
      const was = latest.current;
      const left = was.files.filter((f) => f.id !== file.id);
      const bytesLeft = was.bytes_left + file.byte_size;
      const next = {
        ...was,
        files: left,
        files_left: was.files_left + 1,
        bytes_left: bytesLeft,
        // One file's limit was what was left, while that was less than the
        // vault's own: it grows with what was given back (N522W-2), so a file
        // that fits now is not refused as too big before the vault answers.
        max_file_bytes: was.max_file_bytes >= was.bytes_left ? bytesLeft : was.max_file_bytes,
      };
      latest.current = next;
      setSession(next);
      say(`Removed “${file.name}”. It will not be sent. ${readyWords(left.length)}`, true);
      await refresh();
    } catch (err) {
      if (!over(err)) setError(describeError(err));
    } finally {
      setRemoving(null);
    }
  };

  const finish = async () => {
    setFinishing(true);
    setError(null);
    try {
      // What the vault has, read now: Finish sends what it has, so the
      // page says it first if that is not what the page shows.
      const fresh = await api.dropSession(session.request_id);
      const shown = new Set(latest.current.files.map((f) => f.id));
      const same = fresh.files.length === shown.size && fresh.files.every((f) => shown.has(f.id));
      latest.current = fresh;
      setSession(fresh);
      setStale(false);
      if (!same) {
        setError(
          `The vault has ${files(fresh.files.length)} from this page, listed now. Look at the list, then press Finish again.`,
        );
        setAskedAgain((n) => n + 1);
        return;
      }
      const done = await api.dropFinish(session.request_id, note.trim() || undefined);
      onFinished(done, fresh);
    } catch (err) {
      if (over(err)) return;
      setError(
        err instanceof ApiRequestError && err.code === 'busy'
          ? 'The vault was busy for a moment, and nothing was sent. Press Finish again.'
          : err instanceof NetworkError
            ? 'The vault could not be reached, and nothing was sent. Press Finish again.'
            : describeError(err),
      );
    } finally {
      setFinishing(false);
    }
  };

  // Finish asked again: back on Finish, turned on again, once it is drawn.
  useEffect(() => {
    if (askedAgain > 0) finishButton.current?.focus();
  }, [askedAgain]);

  const slots: Array<{ id: string | null; label: string }> =
    session.items.length > 0
      ? [...session.items, { id: null, label: 'Anything else' }]
      : [{ id: null, label: 'Your files' }];
  const accept = session.accepted.flatMap((t) => [t, EXTENSIONS[t] ?? '']).filter(Boolean);
  const inFlight = sending.some((s) => s.state !== 'failed');
  const full = session.files_left === 0;
  return (
    <>
      <h1 id="drop-h" style={{ fontSize: 26 }} tabIndex={-1} ref={heading}>
        {session.title}
      </h1>
      <section className="card stack" aria-labelledby="drop-h">
        {carriedOn && (
          <p className="notice" role="note">
            This link is open in this browser already — in another tab, or from before — so you are
            carrying on there. What you add in either is sent together.
          </p>
        )}
        <p>
          {name ? <strong>{name}</strong> : 'Somebody'} asked you to send these to{' '}
          {session.household_name}.
        </p>
        {session.message && (
          <figure className="drop-message">
            <figcaption className="muted">Their message</figcaption>
            <blockquote>{session.message}</blockquote>
          </figure>
        )}
        <p className="muted" data-testid="drop-room">
          {full
            ? `It takes no more files: ${files(session.max_files)} have been sent.`
            : `You can send ${session.files_left === 1 ? '1 more file' : `${session.files_left} more files`}, ${sizeOf(session.bytes_left)} in all, each up to ${sizeOf(session.max_file_bytes)}. ${uploadRequestTypesWords(session.accept_types)}.`}{' '}
          Until you press Finish, you can remove what you add.
        </p>
        {stale && (
          <div className="stack" style={{ gap: 8 }}>
            <p className="status status-warn" role="alert">
              The vault could not be asked just now what has arrived, so this list may be behind.
            </p>
            <Button
              kind="quiet"
              onClick={() => {
                void refresh().then((fresh) => {
                  // The button goes with the warning: the focus goes to what was said.
                  if (fresh) say(`The list is up to date. ${readyWords(fresh.files.length)}`, true);
                });
              }}
            >
              Check again
            </Button>
          </div>
        )}
      </section>

      {slots.map((slot) => (
        <Slot
          key={slot.id ?? 'other'}
          slot={slot}
          accept={accept.join(',')}
          sent={session.files.filter((f) => f.item_id === slot.id)}
          sending={sending.filter((s) => s.itemId === slot.id)}
          full={full}
          removing={removing}
          onChoose={(list) => choose(slot.id, list)}
          onRemove={(f) => void remove(f)}
          onStop={(s) => {
            // On its way: stopped, and said so when it has. Not yet: taken off the list.
            if (s.stop) {
              s.stop();
              return;
            }
            setSending((all) => all.filter((x) => x.key !== s.key));
            say(`Took “${s.file.name}” off the list: it was not sent.`, true);
          }}
          onAgain={(s) => {
            // Again, as a new file in the queue: the one that failed is not started twice.
            const key = nextKey.current++;
            setSending((all) =>
              all.map((x) =>
                x.key === s.key
                  ? { key, itemId: s.itemId, file: s.file, sent: 0, state: 'waiting' }
                  : x,
              ),
            );
            say(`Sending “${s.file.name}” again.`, true);
          }}
          onDismiss={(s) => {
            setSending((all) => all.filter((x) => x.key !== s.key));
            say(`Took “${s.file.name}” off the list: it was not sent.`, true);
          }}
        />
      ))}

      <section className="card stack" aria-labelledby="drop-finish-h">
        <h2 id="drop-finish-h" style={{ fontSize: 18 }}>
          Finish
        </h2>
        <p className="notice status-line" role="status" tabIndex={-1} ref={status}>
          {said}
        </p>
        <TextArea
          id="drop-note"
          label={`A note for ${name ?? 'them'} (if you like)`}
          value={note}
          maxLength={SENDER_NOTE_MAX}
          onChange={setNote}
          hint="Plain text. It goes with the files."
        />
        <ErrorNote message={error} />
        <Button
          ref={finishButton}
          disabled={finishing || inFlight || session.files.length === 0}
          onClick={() => void finish()}
        >
          {finishing
            ? 'Sending…'
            : session.files.length > 0
              ? `Finish and send ${files(session.files.length)}`
              : 'Finish'}
        </Button>
        <p className="muted">
          {inFlight
            ? 'Wait for every file to arrive, then press Finish.'
            : session.files.length === 0
              ? 'Add at least one file, then press Finish.'
              : `Finish sends them to ${name ?? 'whoever asked'}. After that this page cannot change them.`}{' '}
          This page stays open for 30 minutes after you last use it, and until{' '}
          {when(session.session_expires_at)} at the latest.
        </p>
      </section>
    </>
  );
}

function Slot(props: {
  slot: { id: string | null; label: string };
  accept: string;
  sent: DropFile[];
  sending: Sending[];
  full: boolean;
  removing: string | null;
  onChoose: (files: FileList | null) => void;
  onRemove: (file: DropFile) => void;
  onStop: (s: Sending) => void;
  onAgain: (s: Sending) => void;
  onDismiss: (s: Sending) => void;
}) {
  const { slot } = props;
  const input = useRef<HTMLInputElement>(null);
  const hId = `drop-slot-${slot.id ?? 'other'}`;
  const more = props.sent.length + props.sending.length > 0;
  const rows: ReactNode[] = [
    ...props.sent.map((f) => (
      <li key={f.id} className="drop-file">
        <span className="drop-file-name">{f.name}</span>
        <span className="muted">{sizeOf(f.byte_size)} · Added</span>
        <Button
          kind="quiet"
          disabled={props.removing !== null}
          ariaLabel={`Remove ${f.name}`}
          onClick={() => props.onRemove(f)}
        >
          {props.removing === f.id ? 'Removing…' : 'Remove'}
        </Button>
      </li>
    )),
    ...props.sending.map((s) => (
      <li key={`s${s.key}`} className="drop-file">
        <span className="drop-file-name">{s.file.name}</span>
        {s.state === 'failed' ? (
          <>
            <span className="field-error" role="alert">
              {s.problem}
            </span>
            <div className="row">
              {s.again && (
                <Button
                  kind="quiet"
                  ariaLabel={`Try ${s.file.name} again`}
                  onClick={() => props.onAgain(s)}
                >
                  Try again
                </Button>
              )}
              <Button
                kind="quiet"
                ariaLabel={`Dismiss ${s.file.name}`}
                onClick={() => props.onDismiss(s)}
              >
                Dismiss
              </Button>
            </div>
          </>
        ) : (
          <>
            <progress
              className="drop-progress"
              max={s.file.size || 1}
              value={s.state === 'waiting' ? 0 : s.sent}
              aria-label={`Sending ${s.file.name}`}
            />
            <span className="muted">
              {s.state === 'waiting'
                ? `Waiting · ${sizeOf(s.file.size)}`
                : s.state === 'arriving'
                  ? `Arriving… the vault is checking it · ${sizeOf(s.file.size)}`
                  : `${Math.min(99, Math.round((s.sent / (s.file.size || 1)) * 100))}% of ${sizeOf(s.file.size)}`}
            </span>
            {/* Every byte gone, it is the vault's: too late to stop, and
                removable once it has arrived (the 5.22 review). */}
            {s.state !== 'arriving' && (
              <Button
                kind="quiet"
                ariaLabel={`Stop sending ${s.file.name}`}
                onClick={() => props.onStop(s)}
              >
                Stop
              </Button>
            )}
          </>
        )}
      </li>
    )),
  ];
  return (
    <section className="card stack drop-slot" aria-labelledby={hId}>
      <h2 id={hId} style={{ fontSize: 18 }}>
        {slot.label}
      </h2>
      {rows.length > 0 && (
        <ul className="list drop-files" aria-label={`Files for ${slot.label}`}>
          {rows}
        </ul>
      )}
      {/* Not in the accessibility tree (display: none): the button below
          is what is pressed, and says which slot it is for. */}
      <input
        ref={input}
        type="file"
        multiple
        accept={props.accept}
        aria-label={`File chooser for ${slot.label}`}
        style={{ display: 'none' }}
        onChange={(e) => {
          props.onChoose(e.target.files);
          // Cleared, so the same file can be chosen again.
          e.target.value = '';
        }}
      />
      <Button
        kind="quiet"
        disabled={props.full}
        ariaLabel={`${more ? 'Add more files' : 'Choose files'} for ${slot.label}`}
        onClick={() => input.current?.click()}
      >
        {more ? 'Add more files' : 'Choose files'}
      </Button>
    </section>
  );
}

function Finished({
  finished,
  session,
  heading,
}: {
  finished: DropFinished;
  session: DropSession;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const name = session.requested_by;
  return (
    <section className="card stack" aria-labelledby="drop-h">
      <h1 id="drop-h" style={{ fontSize: 26 }} tabIndex={-1} ref={heading}>
        Sent
      </h1>
      <p className="status status-ok">
        {files(finished.files)} went to {name ?? 'whoever asked'} at {session.household_name}.
      </p>
      <p>
        They will look at {finished.files === 1 ? 'it' : 'them'} before{' '}
        {finished.files === 1 ? 'it is' : 'they are'} filed.{' '}
        {finished.closed
          ? 'This request is closed now: it takes nothing more.'
          : 'If you need to send something else, open the link you were sent again.'}
      </p>
      <p className="muted">You can close this page.</p>
    </section>
  );
}
