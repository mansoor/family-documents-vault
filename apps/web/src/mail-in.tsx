import { can, type MailInCode, type MailInEmailed, type MailInMine } from '@fdv/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from './api.js';
import { describeError, useApp, useLoad } from './app-context.js';
import { storedRole } from './session.js';
import { Button, Check, ErrorNote, LoadFailed, TopBar } from './ui.js';

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

/** "12 Oct, 14:03", in this browser's time. */
function whenWords(at: string): string {
  return new Date(at).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "12 Oct", in this browser's time. */
function dayWords(at: string): string {
  return new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
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
