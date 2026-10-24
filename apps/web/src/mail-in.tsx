import {
  can,
  MAIL_IN_AUTHSERV_HINT,
  MAIL_IN_PORT_DEFAULT,
  type MailInCode,
  type MailInEmailed,
  type MailInMine,
  type MailInView,
} from '@fdv/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from './api.js';
import { describeError, useApp, useLoad } from './app-context.js';
import { storedRole } from './session.js';
import { Button, Check, ErrorNote, LoadFailed, TopBar } from './ui.js';
import { useWorkerCheck } from './worker-check.js';
import { dayWordsOf, familyZoneNow, shortWhenWords } from './family-time.js';

/**
 * Email in (0.8.0, S4): an owner's page in Settings → For owners, and the
 * line on Add and Home that tells whoever may add documents where to email
 * them, from which address, and how to confirm it.
 *
 * The page says how the worker has the household mailbox — set up, or why
 * not, in words an owner can act on — whether senders are checked, what
 * last went wrong, and what was left in the mailbox; and turns it on (only
 * while it is offered) or off.
 */
export function EmailInScreen() {
  const { authVersion, guarded, reloadCaps } = useApp();
  const { data, error, reload } = useLoad((t) => api.mailIn(t), [authVersion]);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const line = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    // The form starts from what the vault has, each time it is loaded.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (data) setEnabled(data.enabled);
  }, [data]);
  useEffect(() => {
    if (said) line.current?.focus();
  }, [said]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !data) return;
    setBusy(true);
    setSaveError(null);
    setSaid(null);
    try {
      const done = await guarded((t) => api.setMailIn(t, { enabled }));
      if (done !== null) {
        await reload();
        void reloadCaps?.();
        setSaid(
          done.enabled
            ? 'Saved. Email in is on: the vault checks the mailbox every few minutes.'
            : 'Saved. Email in is off: email sent to the mailbox stays there.',
        );
      }
    } catch (err) {
      setSaveError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const mayTurnOn = data?.available === true || data?.enabled === true;
  const changed = data !== null && enabled !== data.enabled;
  return (
    <main className="page page-top">
      <TopBar title="Email in" back="/settings/owners" backLabel="Back to For owners" />
      <p className="lede">
        Email documents to the vault: the family sends them to a mailbox of the household’s own, and
        each attachment goes into the sender’s Inbox to look over, as if they had added it.
      </p>
      {data === null && error ? (
        <LoadFailed message={error} what="email in" onRetry={() => void reload()} />
      ) : data === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <section aria-labelledby="mail-in-box-h" className="stack">
            <h2 id="mail-in-box-h" className="section-h">
              The mailbox
            </h2>
            <p
              className={data.server.state === 'ready' ? 'attention attention-calm' : 'attention'}
              role="status"
            >
              {data.server.words}
            </p>
            {data.sender_warning && (
              <p className="attention attention-warn" role="status">
                <strong>Senders aren’t verified.</strong>{' '}
                <span>{data.sender_warning.replace(/^Senders aren’t verified\. /, '')}</span>
              </p>
            )}
            {/* Nobody can confirm an address yet (F1): what to set. */}
            {data.confirm_warning && (
              <p className="attention attention-warn" role="status">
                {data.confirm_warning}
              </p>
            )}
            {/* Filed otherwise than told, as the server allows (F10). */}
            {data.server.filing_words && (
              <p className="attention" role="status">
                {data.server.filing_words}
              </p>
            )}
            {data.last_error && (
              <p className="attention" role="status">
                {data.last_error.words}
              </p>
            )}
            {data.enabled && data.counts.length > 0 && (
              <ul className="mail-in-counts" aria-label="Left in the mailbox">
                {data.counts.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            )}
            {data.enabled && data.last_checked_at && (
              <p className="muted">
                Last checked {whenWords(data.last_checked_at)}
                {data.last_added_at ? `; last added a file ${whenWords(data.last_added_at)}` : ''}.
              </p>
            )}
          </section>
          {data.source !== undefined && (
            <MailboxForm
              view={data}
              onSaved={async () => {
                await reload();
                void reloadCaps?.();
              }}
            />
          )}
          <form className="stack" onSubmit={(e) => void save(e)} aria-labelledby="mail-in-set-h">
            <h2 id="mail-in-set-h" className="section-h">
              Turn it on
            </h2>
            <Check
              id="mail-in-on"
              checked={enabled}
              disabled={!mayTurnOn}
              onChange={setEnabled}
              label="Add what the family emails in"
              note={
                mayTurnOn
                  ? 'Each person confirms their address first, from Add.'
                  : 'It can be turned on once the mailbox is set up.'
              }
            />
            <ErrorNote message={saveError} />
            <div className="row">
              <Button kind="primary" type="submit" disabled={busy || !changed}>
                Save
              </Button>
            </div>
            <p ref={line} className="status-line" role="status" tabIndex={-1}>
              {said}
            </p>
          </form>
          <section aria-labelledby="mail-in-what-h" className="stack">
            <h2 id="mail-in-what-h" className="section-h">
              What happens to each email
            </h2>
            <ul className="scanner-what">
              <li>
                Only email from the sign-in address of someone in the family who adds documents is
                taken, once they have confirmed that address, and only into their own Inbox. Not a
                viewer’s, not a guest’s.
              </li>
              <li>
                PDFs, photos, Word and Excel files attached are added. The email’s text and subject
                aren’t kept. Pictures in a signature are left out.
              </li>
              <li>
                Afterwards the email is{' '}
                {data.server.after === 'delete'
                  ? 'deleted from the mailbox'
                  : 'moved to the mailbox’s Filed folder'}
                . Email from anyone else is left there unread, and counted above.
              </li>
              <li>
                Anything emailed in waits in an Inbox for its person to look over: nothing is filed
                without them.
              </li>
            </ul>
          </section>
        </>
      )}
    </main>
  );
}

/** How often the mailbox may be checked, in the form: minutes, as seconds. */
const POLLS = [60, 120, 300, 600, 900, 1800, 3600];

/** "every 5 minutes", "every hour". */
function pollWords(seconds: number): string {
  if (seconds % 3600 === 0)
    return seconds === 3600 ? 'Every hour' : `Every ${seconds / 3600} hours`;
  if (seconds % 60 === 0) return seconds === 60 ? 'Every minute' : `Every ${seconds / 60} minutes`;
  return `Every ${seconds} seconds`;
}

/**
 * The household mailbox, set up here (0.9.0, O1): it overrides the
 * server's FDV_MAIL_IN_*. The app password is sent once and kept sealed —
 * never shown again, only whether one is set; left blank, the one set is
 * kept. "Test the mailbox" asks the worker to sign in to what is saved and
 * look without touching any mail.
 */
function MailboxForm(props: { view: MailInView; onSaved: () => Promise<void> }) {
  const { guarded } = useApp();
  const box = props.view.mailbox ?? null;
  const [host, setHost] = useState('');
  const [port, setPort] = useState(String(MAIL_IN_PORT_DEFAULT));
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [folder, setFolder] = useState('INBOX');
  const [after, setAfter] = useState<'move' | 'delete'>('move');
  const [authserv, setAuthserv] = useState('');
  const [poll, setPoll] = useState(300);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const test = useWorkerCheck();
  const tested = useRef<HTMLDivElement>(null);
  const line = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    // The form starts from what the vault has, each time it is loaded.
    /* eslint-disable react-hooks/set-state-in-effect */
    setHost(box?.host ?? '');
    setPort(String(box?.port ?? MAIL_IN_PORT_DEFAULT));
    setUser(box?.username ?? '');
    setPassword('');
    setFolder(box?.folder ?? 'INBOX');
    setAfter(box?.after ?? 'move');
    setAuthserv(box?.authserv_id ?? '');
    setPoll(box?.poll_seconds ?? 300);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [box]);
  useEffect(() => {
    if (said) line.current?.focus();
  }, [said]);
  useEffect(() => {
    if (test.view?.state === 'done' || test.view?.state === 'late') tested.current?.focus();
  }, [test.view]);

  // The app password was kept for this server, port and sign-in alone (the
  // O1 review, H1): any of them changed, it is typed again.
  const serverChanged =
    box !== null &&
    box.password === 'set' &&
    (host.trim().toLowerCase() !== box.host.toLowerCase() ||
      port !== String(box.port) ||
      user.trim() !== box.username);
  const passwordNeeded = serverChanged && password === '';
  const changed =
    host !== (box?.host ?? '') ||
    port !== String(box?.port ?? MAIL_IN_PORT_DEFAULT) ||
    user !== (box?.username ?? '') ||
    password !== '' ||
    folder !== (box?.folder ?? 'INBOX') ||
    after !== (box?.after ?? 'move') ||
    authserv !== (box?.authserv_id ?? '') ||
    poll !== (box?.poll_seconds ?? 300);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const portN = Number(port);
    if (!host.trim() || !user.trim()) {
      setError('Type the mail server and the sign-in.');
      return;
    }
    if (!Number.isInteger(portN) || portN < 1 || portN > 65535) {
      setError('The port is a number from 1 to 65535: 993 for most.');
      return;
    }
    if (passwordNeeded) {
      setError('Type the app password again for the new server.');
      document.getElementById('mailbox-password')?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    setSaid(null);
    try {
      const done = await guarded((t) =>
        api.setMailInMailbox(t, {
          host: host.trim(),
          port: portN,
          username: user.trim(),
          ...(password !== '' ? { password } : {}),
          folder: folder.trim() || 'INBOX',
          after,
          authserv_id: authserv.trim() || null,
          poll_seconds: poll,
        }),
      );
      if (done !== null) {
        setPassword('');
        test.clear();
        await props.onSaved();
        setSaid(
          done.mailbox?.password === 'set'
            ? 'Saved. The vault checks this mailbox from now on: test it to be sure.'
            : 'Saved. Type the app password too, so the vault can sign in.',
        );
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSaid(null);
    try {
      const done = await guarded((t) => api.removeMailInMailbox(t));
      if (done !== null) {
        test.clear();
        await props.onSaved();
        setSaid(
          done.source === 'server'
            ? 'Removed. The vault checks the server’s own mailbox again.'
            : 'Removed, with its password. No mailbox is set up now.',
        );
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  const result = test.view?.state === 'done' ? (test.view.mailbox ?? null) : null;
  const pollChoices = POLLS.includes(poll) ? POLLS : [...POLLS, poll].sort((a, b) => a - b);
  return (
    <form
      className="stack"
      onSubmit={(e) => void save(e)}
      aria-labelledby="mail-in-box-set-h"
      noValidate
    >
      <h2 id="mail-in-box-set-h" className="section-h">
        Set up the mailbox
      </h2>
      <p className="muted">
        {props.view.source === 'settings'
          ? 'The vault checks the mailbox set up here.'
          : props.view.source === 'server'
            ? 'The vault checks the server’s own mailbox (FDV_MAIL_IN_*). One set up here is used instead.'
            : 'A mailbox of the household’s own, with an app password: Gmail, Fastmail, iCloud or your own server’s.'}
      </p>
      <div className="mailbox-pair">
        <div className="field">
          <label htmlFor="mailbox-host">Mail server (IMAP)</label>
          <input
            id="mailbox-host"
            value={host}
            placeholder="imap.gmail.com"
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            onChange={(e) => setHost(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="mailbox-port">Port</label>
          <input
            id="mailbox-port"
            type="number"
            inputMode="numeric"
            min={1}
            max={65535}
            value={port}
            aria-describedby="mailbox-port-note"
            onChange={(e) => setPort(e.target.value)}
          />
          <p id="mailbox-port-note" className="muted field-note">
            993: encrypted from the start. The server’s operator can allow others.
          </p>
        </div>
      </div>
      <div className="mailbox-pair">
        <div className="field">
          <label htmlFor="mailbox-user">Sign-in</label>
          <input
            id="mailbox-user"
            value={user}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            aria-describedby="mailbox-user-note"
            onChange={(e) => setUser(e.target.value)}
          />
          <p id="mailbox-user-note" className="muted field-note">
            Usually the mailbox’s address: where the family sends documents.
          </p>
        </div>
        <div className="field">
          <label htmlFor="mailbox-password">App password</label>
          <input
            id="mailbox-password"
            type="password"
            value={password}
            autoComplete="new-password"
            aria-describedby="mailbox-password-note"
            aria-invalid={passwordNeeded}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p
            id="mailbox-password-note"
            className={passwordNeeded ? 'attention field-note' : 'muted field-note'}
          >
            {serverChanged
              ? 'You changed the server or the sign-in: type the app password again for it. The one saved is only ever sent to the server it was typed for.'
              : box?.password === 'set'
                ? 'One is saved, and never shown. Leave this empty to keep it, or type a new one.'
                : 'An app password made for the vault, not the account’s own. It is kept encrypted, and never shown again.'}
          </p>
        </div>
      </div>
      <div className="mailbox-pair">
        <div className="field">
          <label htmlFor="mailbox-folder">Folder</label>
          <input
            id="mailbox-folder"
            value={folder}
            spellCheck={false}
            autoCapitalize="off"
            onChange={(e) => setFolder(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="mailbox-after">Once its attachments are in</label>
          <select
            id="mailbox-after"
            value={after}
            onChange={(e) => setAfter(e.target.value === 'delete' ? 'delete' : 'move')}
          >
            <option value="move">Move the email to Filed</option>
            <option value="delete">Delete the email</option>
          </select>
        </div>
      </div>
      <div className="mailbox-pair">
        <div className="field">
          <label htmlFor="mailbox-authserv">The provider’s authserv-id</label>
          <input
            id="mailbox-authserv"
            value={authserv}
            placeholder="mx.google.com"
            spellCheck={false}
            autoCapitalize="off"
            aria-describedby="mailbox-authserv-note"
            onChange={(e) => setAuthserv(e.target.value)}
          />
          <p id="mailbox-authserv-note" className="muted field-note">
            {MAIL_IN_AUTHSERV_HINT}. Set, the vault takes only email your provider checked came from
            its sender. Your provider’s documentation names it; Test the mailbox gives a hint.
          </p>
        </div>
        <div className="field">
          <label htmlFor="mailbox-poll">How often it is checked</label>
          <select id="mailbox-poll" value={poll} onChange={(e) => setPoll(Number(e.target.value))}>
            {pollChoices.map((s) => (
              <option key={s} value={s}>
                {pollWords(s)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <ErrorNote message={error ?? test.error} />
      <div className="row">
        <Button kind="primary" type="submit" disabled={busy || !changed}>
          Save the mailbox
        </Button>
        <Button
          kind="quiet"
          disabled={test.busy || busy || changed}
          describedBy="mailbox-test-note"
          onClick={() => void test.run((t) => api.testMailInMailbox(t))}
        >
          {test.busy ? 'Testing…' : 'Test the mailbox'}
        </Button>
        {box && (
          <Button kind="quiet" disabled={busy} onClick={() => void remove()}>
            {props.view.source === 'settings' ? 'Remove this mailbox' : 'Remove'}
          </Button>
        )}
      </div>
      <p id="mailbox-test-note" className="muted field-note">
        Test signs in to the mailbox as saved and counts what is in its folder. Only the newest
        emails’ Authentication-Results headers are read (three at most); nothing is moved or marked.
        {changed ? ' Save first.' : ''}
      </p>
      <p ref={line} className="status-line" role="status" tabIndex={-1}>
        {said}
      </p>
      <div ref={tested} tabIndex={-1} role="status" className="stack">
        {test.view?.state === 'late' && <p className="attention">{test.view.words}</p>}
        {result && (
          <ul
            className="verify-steps"
            aria-label={result.ok ? 'What the test found' : 'Why the test failed'}
          >
            {result.lines.map((l, i) => (
              <li key={i} className={result.ok ? 'step-ok' : 'step-bad'}>
                <span className="step-mark" aria-hidden="true">
                  {i === 0 ? (result.ok ? '✓' : '✗') : '·'}
                </span>{' '}
                {l}
              </li>
            ))}
          </ul>
        )}
      </div>
    </form>
  );
}

/** "12 Oct, 14:03", on the family's clock (0.9.0, TZ). */
function whenWords(at: string): string {
  return shortWhenWords(at, familyZoneNow());
}

/** "12 Oct", on the family's calendar. */
function dayWords(at: string): string {
  return dayWordsOf(at, familyZoneNow(), { month: 'short' });
}

/** What of theirs was left in the mailbox, to its person (F1): counts, and the newest one's date. */
function heldWords(held: NonNullable<MailInMine['held']>): string {
  const n = (k: number) => (k === 1 ? '1 email' : `${k} emails`);
  const out: string[] = [];
  if (held.unconfirmed > 0) {
    out.push(
      `${n(held.unconfirmed)} from your address ${held.unconfirmed === 1 ? 'is' : 'are'} waiting in the mailbox until your address is confirmed.`,
    );
  }
  if (held.unverified > 0) {
    out.push(
      `${n(held.unverified)} from your address didn’t pass the mailbox’s sender check, so ${held.unverified === 1 ? 'it wasn’t' : 'they weren’t'} added. Send ${held.unverified === 1 ? 'it' : 'them'} again from your own mail account.`,
    );
  }
  if (held.last_at) out.push(`The newest is from ${dayWords(held.last_at)}.`);
  return out.join(' ');
}

/**
 * "Email documents to <mailbox> from <your sign-in email>" (S4), on Add and
 * Home, for whoever may add documents while email in is on. Until their
 * address is confirmed, how to (F1): send a code FROM it while the mailbox
 * checks senders (a mailto link has it in the subject), or type in a code
 * the vault emailed TO it — or, with neither, why they cannot yet. And what
 * of theirs was left in the mailbox.
 */
export function EmailInLine(props: { className?: string }) {
  const { caps, authVersion, guarded, session } = useApp();
  const role = session.info?.role ?? storedRole();
  const offered = caps?.features.email_ingest === true && can(role, 'document.add');
  const { data, reload } = useLoad(
    async (t): Promise<MailInMine | null> =>
      offered ? await api.myMailIn(t).catch(() => null) : null,
    [authVersion, offered],
  );
  const [code, setCode] = useState<MailInCode | null>(null);
  const [emailed, setEmailed] = useState<MailInEmailed | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const shown = useRef<HTMLParagraphElement>(null);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (code) shown.current?.focus();
  }, [code]);
  useEffect(() => {
    if (emailed) field.current?.focus();
  }, [emailed]);
  if (!data?.on || !data.address) return null;
  const act = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  const getCode = () =>
    act(async () => {
      const made = await guarded((t) => api.newMailInCode(t));
      if (made) setCode(made);
    });
  const emailMe = () =>
    act(async () => {
      const sent = await guarded((t) => api.emailMailInCode(t));
      if (sent) setEmailed(sent);
    });
  const confirm = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      const done = await guarded((t) => api.confirmMailIn(t, typed));
      if (done !== null) {
        setSaid('Your address is confirmed: emails from it now come into your Inbox.');
        setEmailed(null);
        await reload();
      }
    });
  };
  const ways = data.confirm;
  return (
    <section
      className={`card mail-in-line stack ${props.className ?? ''}`}
      aria-labelledby="mail-in-line-h"
    >
      <h2 id="mail-in-line-h" className="dash-h">
        Email documents in
      </h2>
      <p>
        Email documents to <strong>{data.address}</strong> from <strong>{data.email}</strong>.
      </p>
      {data.confirmed ? (
        <p className="muted">
          Attachments go into your Inbox to look over
          {data.sender_check ? '' : ', each marked “sender not verified”'}.
        </p>
      ) : !ways.send_from && !ways.emailed ? (
        <p className="muted">{data.confirm_words}</p>
      ) : (
        <>
          <p className="muted">First, confirm that the address is yours.</p>
          {ways.send_from &&
            (code ? (
              <p ref={shown} tabIndex={-1} className="mail-in-code" role="status">
                Send an email from {data.email} to {data.address} with <code>{code.code}</code> as
                its subject. It works for a day. <a href={code.mailto}>Write that email</a>
              </p>
            ) : (
              <div className="row">
                <Button kind="quiet" disabled={busy} onClick={() => void getCode()}>
                  {data.code_kind === 'send' ? 'Get a new code to send' : 'Get a code to send'}
                </Button>
              </div>
            ))}
          {ways.emailed &&
            (emailed ? (
              <form className="stack" onSubmit={confirm} aria-label="Confirm with the emailed code">
                <div className="field">
                  <label htmlFor="mail-in-typed">
                    Code from the email sent to {emailed.sent_to}
                  </label>
                  <input
                    id="mail-in-typed"
                    ref={field}
                    value={typed}
                    autoComplete="one-time-code"
                    inputMode="text"
                    onChange={(e) => setTyped(e.target.value)}
                  />
                </div>
                <div className="row">
                  <Button kind="primary" type="submit" disabled={busy || typed.trim() === ''}>
                    Confirm
                  </Button>
                </div>
              </form>
            ) : (
              <div className="row">
                <Button kind="quiet" disabled={busy} onClick={() => void emailMe()}>
                  Email me a code
                </Button>
              </div>
            ))}
        </>
      )}
      {data.held && <p className="muted">{heldWords(data.held)}</p>}
      <ErrorNote message={error} />
      <p className="status-line" role="status">
        {said}
      </p>
    </section>
  );
}
