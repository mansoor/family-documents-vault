import { roleLabel, type WatchFolderView, type WatchNoticeView } from '@fdv/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from './api.js';
import { describeError, useApp, useLoad } from './app-context.js';
import { Button, Check, ErrorNote, LoadFailed, TopBar } from './ui.js';

/**
 * The scanner folder (0.8.0, S3): an owner's page in Settings → For owners,
 * and the notes it leaves in Needs attention for whoever's Inbox it fills.
 *
 * The page says how the worker found the folder — ready, or why not, in
 * words an owner can act on — and lets an owner turn it on (only while it
 * is offered) and choose whose Inbox it fills: themselves by default, or
 * anybody of the family who signs in and adds documents. While it is on and
 * cannot add, it says it is paused, and why.
 */
export function ScannerScreen() {
  const { authVersion, guarded, session, reloadCaps } = useApp();
  const { data, error, reload } = useLoad((t) => api.watchFolder(t), [authVersion]);
  const [enabled, setEnabled] = useState(false);
  const [member, setMember] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const line = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (!data) return;
    // The form starts from what the vault has, each time it is loaded.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEnabled(data.enabled);
    setMember(data.member_id ?? session.info?.member_id ?? data.candidates[0]?.member_id ?? '');
  }, [data, session.info?.member_id]);
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
      const done = await guarded((t) =>
        api.setWatchFolder(t, { enabled, member_id: member || null }),
      );
      if (done !== null) {
        await reload();
        void reloadCaps?.();
        const who = done.candidates.find((c) => c.member_id === done.member_id)?.display_name;
        setSaid(
          done.enabled
            ? `Saved. What the scanner saves now goes to ${who ? `${who}’s` : 'the'} Inbox.`
            : 'Saved. The scanner folder is off: files saved into it stay there.',
        );
      }
    } catch (err) {
      setSaveError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const changed =
    data !== null && (enabled !== data.enabled || (enabled && member !== data.member_id));
  // Turned on only while the folder is offered; turned off always.
  const mayTurnOn = data?.available === true || data?.enabled === true;
  return (
    <main className="page page-top">
      <TopBar title="Scanner folder" back="/settings/owners" backLabel="Back to For owners" />
      <p className="lede">
        Scan straight into the vault: your scanner saves into a folder on this server, and each file
        goes into one person’s Inbox to look over, as if they had added it.
      </p>
      {data === null && error ? (
        <LoadFailed message={error} what="the scanner folder" onRetry={() => void reload()} />
      ) : data === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <section aria-labelledby="scanner-folder-h" className="stack">
            <h2 id="scanner-folder-h" className="section-h">
              The folder
            </h2>
            <p
              className={data.folder.state === 'ready' ? 'attention attention-calm' : 'attention'}
              role="status"
            >
              {data.folder.words}
            </p>
            {data.enabled && data.paused && (
              <p className="attention" role="status">
                {data.paused.words}
              </p>
            )}
            {data.enabled && !data.paused && data.last_added_at && (
              <p className="muted">Last file added {whenWords(data.last_added_at)}.</p>
            )}
            {/* Stored, but still in the folder, not encrypted (the S3 review). */}
            {data.stuck_words && (
              <p className="attention" role="status">
                {data.stuck_words}
              </p>
            )}
          </section>
          <form className="stack" onSubmit={(e) => void save(e)} aria-labelledby="scanner-set-h">
            <h2 id="scanner-set-h" className="section-h">
              Where scans go
            </h2>
            <Check
              id="scanner-on"
              checked={enabled}
              disabled={!mayTurnOn}
              onChange={setEnabled}
              label="Add what the scanner saves"
              note={
                mayTurnOn
                  ? 'Each file is encrypted into a batch called “Scanner” and the day’s date, then deleted from the folder.'
                  : 'It can be turned on once the folder is ready.'
              }
            />
            <div className="field">
              <label htmlFor="scanner-who">Whose Inbox it fills</label>
              <select
                id="scanner-who"
                value={member}
                disabled={!enabled}
                aria-describedby="scanner-who-note"
                onChange={(e) => setMember(e.target.value)}
              >
                {/* Whose Inbox it fills now, when they may no longer add: said, never
                    silently replaced by somebody else (the S3 review). */}
                {data.member_id && !data.candidates.some((c) => c.member_id === data.member_id) && (
                  <option value={data.member_id} disabled>
                    {`${data.member_name ?? 'Someone no longer here'} (can’t add now)`}
                  </option>
                )}
                {data.candidates.map((c) => (
                  <option key={c.member_id} value={c.member_id}>
                    {c.member_id === session.info?.member_id
                      ? `${c.display_name} (you)`
                      : `${c.display_name} · ${roleLabel(c.role)}`}
                  </option>
                ))}
              </select>
              <p id="scanner-who-note" className="muted field-note">
                Only they see what comes in, until they accept it. Anyone in the family who signs in
                and adds documents; not a viewer.
              </p>
            </div>
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
          <section aria-labelledby="scanner-what-h" className="stack">
            <h2 id="scanner-what-h" className="section-h">
              What happens to each file
            </h2>
            <ul className="scanner-what">
              <li>
                The vault waits until a file has stopped changing for a few seconds and looks
                complete, then encrypts it into that person’s Inbox and deletes it from the folder.
                A scanner that pauses for long in the middle of a file can still be taken too early:
                the person sees it in their Inbox, and can remove it.
              </li>
              <li>
                A file it can’t take — not a PDF, photo, Word or Excel file, too large, empty, or
                never finished — is moved to the folder’s <code>rejected</code> folder with a note
                saying why, and that person is told in Needs attention.
              </li>
              <li>
                While it is paused, files wait in the folder. Anything still in the folder is not
                encrypted.
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
 * "A scanned file couldn't be added" (S3), in Needs attention: the
 * reader's own, each with its name and why, and Dismiss. Nothing when there
 * are none.
 */
export function ScannerNotices(props: {
  items: WatchNoticeView[];
  onDismissed: () => Promise<unknown>;
}) {
  const { guarded } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const line = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (said) line.current?.focus();
  }, [said]);
  const dismiss = async (n: WatchNoticeView) => {
    if (busy) return;
    setBusy(n.id);
    setError(null);
    try {
      const done = await guarded((t) => api.dismissWatchNotice(t, n.id));
      if (done !== null) {
        await props.onDismissed();
        setSaid(`Dismissed. ${n.file_name} is still in the scanner folder’s rejected folder.`);
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };
  if (props.items.length === 0 && !said && !error) return null;
  return (
    <>
      {props.items.map((n) => (
        <section
          key={n.id}
          className="attention scanner-notice stack"
          aria-labelledby={`scanner-notice-${n.id}`}
        >
          <p id={`scanner-notice-${n.id}`}>
            <strong>{n.title}.</strong> {n.words}
          </p>
          <div className="row">
            <Button
              kind="quiet"
              disabled={busy !== null}
              ariaLabel={`Dismiss the note about ${n.file_name}`}
              onClick={() => void dismiss(n)}
            >
              Dismiss
            </Button>
          </div>
        </section>
      ))}
      <ErrorNote message={error} />
      <p ref={line} className="status-line" role="status" tabIndex={-1}>
        {said}
      </p>
    </>
  );
}

/** The reader's notes, for Home and Needs attention: none for whoever adds nothing, or on a refusal. */
export async function loadScannerNotices(
  t: string,
  addsDocuments: boolean,
): Promise<WatchNoticeView[]> {
  if (!addsDocuments) return [];
  return (await api.watchNotices(t).catch(() => ({ items: [] as WatchNoticeView[] }))).items;
}

export type { WatchFolderView };
