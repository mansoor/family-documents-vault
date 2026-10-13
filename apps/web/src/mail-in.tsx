import { can, type MailInCode, type MailInMine } from '@fdv/shared';
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

/**
 * "Email documents to <mailbox> from <your sign-in email>" (S4), on Add and
 * Home, for whoever may add documents while email in is on. Until their
 * address is confirmed, how to: a code, shown once, to send from it.
 */
export function EmailInLine(props: { className?: string }) {
  const { caps, authVersion, guarded, session } = useApp();
  const role = session.info?.role ?? storedRole();
  const offered = caps?.features.email_ingest === true && can(role, 'document.add');
  const { data } = useLoad(
    async (t): Promise<MailInMine | null> =>
      offered ? await api.myMailIn(t).catch(() => null) : null,
    [authVersion, offered],
  );
  const [code, setCode] = useState<MailInCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (code) shown.current?.focus();
  }, [code]);
  if (!data?.on || !data.address) return null;
  const getCode = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const made = await guarded((t) => api.newMailInCode(t));
      if (made) setCode(made);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
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
      ) : (
        <>
          <p className="muted">
            First, confirm your address: send an email from {data.email} to {data.address} with a
            code as its subject. Your emails come in once the vault has it.
          </p>
          {code ? (
            <p ref={shown} tabIndex={-1} className="mail-in-code" role="status">
              Your code: <code>{code.code}</code>. It works for a day.
            </p>
          ) : (
            <div className="row">
              <Button kind="quiet" disabled={busy} onClick={() => void getCode()}>
                {data.code_expires_at ? 'Get a new code' : 'Get a code'}
              </Button>
            </div>
          )}
          <ErrorNote message={error} />
        </>
      )}
    </section>
  );
}
