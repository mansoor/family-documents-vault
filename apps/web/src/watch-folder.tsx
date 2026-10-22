import {
  roleLabel,
  WATCH_KEEP_DAYS_DEFAULT,
  WATCH_KEEP_DAYS_MAX,
  WATCH_KEPT_WARNING,
  type WatchBrowseResult,
  type WatchFolderView,
  type WatchNoticeView,
} from '@fdv/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from './api.js';
import { describeError, useApp, useLoad } from './app-context.js';
import { Button, Check, ErrorNote, LoadFailed, TopBar } from './ui.js';
import { useWorkerCheck } from './worker-check.js';

/**
 * The scanner folder (0.8.0, S3): an owner's page in Settings → For owners,
 * and the notes it leaves in Needs attention for whoever's Inbox it fills.
 *
 * The page says how the worker found the folder — ready, or why not, in
 * words an owner can act on — and lets an owner turn it on (only while it
 * is offered) and choose whose Inbox it fills: themselves by default, or
 * anybody of the family who signs in and adds documents. While it is on and
 * cannot add, it says it is paused, and why.
 *
 * Since 0.9.0 (O1) an owner chooses the folder too, inside the folders the
 * server set aside for scanners: typed, or browsed to (the worker lists the
 * folders inside one), and Verified by the worker before it is saved. And
 * how many days a scan is kept in the folder's processed folder once it is
 * safely in the vault, with what that means.
 */
export function ScannerScreen() {
  const { authVersion, guarded, session, reloadCaps } = useApp();
  const { data, error, reload } = useLoad((t) => api.watchFolder(t), [authVersion]);
  const [enabled, setEnabled] = useState(false);
  const [member, setMember] = useState<string>('');
  const [dir, setDir] = useState('');
  const [keep, setKeep] = useState(String(WATCH_KEEP_DAYS_DEFAULT));
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const line = useRef<HTMLParagraphElement>(null);
  const verify = useWorkerCheck();
  const browse = useWorkerCheck();
  const verified = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!data) return;
    // The form starts from what the vault has, each time it is loaded.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEnabled(data.enabled);
    setMember(data.member_id ?? session.info?.member_id ?? data.candidates[0]?.member_id ?? '');
    setDir(data.choice?.dir ?? data.choice?.default_dir ?? data.choice?.roots[0] ?? '');
    setKeep(String(data.keep_days ?? WATCH_KEEP_DAYS_DEFAULT));
  }, [data, session.info?.member_id]);
  useEffect(() => {
    if (said) line.current?.focus();
  }, [said]);
  useEffect(() => {
    if (verify.view?.state === 'done' || verify.view?.state === 'late') verified.current?.focus();
  }, [verify.view]);

  const choice = data?.choice;
  /** The folder as it is to be saved: null for the server's own (FDV_WATCH_DIR). */
  const dirToSave = (): string | null => {
    const typed = dir.trim();
    if (!choice) return null;
    if (typed === '' || typed === choice.default_dir) return null;
    return typed;
  };
  const keepDays = Number(keep);
  const keepValid = /^\d{1,3}$/.test(keep.trim()) && keepDays <= WATCH_KEEP_DAYS_MAX;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !data) return;
    if (!keepValid) {
      setSaveError(`Keep scans for 0 to ${WATCH_KEEP_DAYS_MAX} days.`);
      return;
    }
    setBusy(true);
    setSaveError(null);
    setSaid(null);
    try {
      const done = await guarded((t) =>
        api.setWatchFolder(t, {
          enabled,
          member_id: member || null,
          ...(choice ? { dir: dirToSave(), keep_days: keepDays } : {}),
        }),
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

  const look = (path: string) => {
    if (!path.trim()) return;
    void browse.run((t) => api.browseWatchFolder(t, path.trim()));
  };
  const check = () => {
    if (!dir.trim()) return;
    void verify.run((t) => api.verifyWatchFolder(t, dir.trim()));
  };

  const changed =
    data !== null &&
    (enabled !== data.enabled ||
      (enabled && member !== data.member_id) ||
      (choice !== undefined && dirToSave() !== choice.dir) ||
      (data.keep_days !== undefined && keep.trim() !== String(data.keep_days)));
  // Turned on only while the folder is offered (or a folder is being chosen,
  // which the server checks as it saves); turned off always.
  const mayTurnOn =
    data?.available === true ||
    data?.enabled === true ||
    (choice !== undefined && choice.roots.length > 0);
  const listed = browse.view?.state === 'done' ? (browse.view.browse ?? null) : null;
  const result = verify.view?.state === 'done' ? (verify.view.folder ?? null) : null;
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
            {/* A processed folder the vault didn't make (the O1 review, M2), and
                scans kept where the vault may no longer go (L1). */}
            {data.processed_words && (
              <p className="attention" role="status">
                {data.processed_words}
              </p>
            )}
            {data.kept_left_words && (
              <p className="attention attention-warn" role="status">
                {data.kept_left_words}
              </p>
            )}
            {/* Kept scans changed since, and scans kept before a restore: never
                deleted by the vault (the O1 re-check). */}
            {data.kept_changed_words && (
              <p className="attention attention-warn" role="status">
                {data.kept_changed_words}
              </p>
            )}
            {data.kept_untracked_words && (
              <p className="attention attention-warn" role="status">
                {data.kept_untracked_words}
              </p>
            )}
          </section>
          <form
            className="stack"
            onSubmit={(e) => void save(e)}
            aria-labelledby="scanner-set-h"
            noValidate
          >
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
                  ? 'Each file is encrypted into a batch called “Scanner” and the day’s date.'
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
            {choice && (
              <>
                <h2 id="scanner-dir-h" className="section-h">
                  Which folder
                </h2>
                <div className="field">
                  <label htmlFor="scanner-dir">Folder, as the worker sees it</label>
                  <input
                    id="scanner-dir"
                    value={dir}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoComplete="off"
                    aria-describedby="scanner-dir-note"
                    onChange={(e) => {
                      setDir(e.target.value);
                      verify.clear();
                    }}
                  />
                  <p id="scanner-dir-note" className="muted field-note">
                    {choice.roots.length > 0
                      ? `A folder inside ${choice.roots.join(', ')}: the folders the server set aside for scanners.`
                      : 'The worker hasn’t said which folders the server set aside for scanners: check that it is running.'}
                    {choice.default_dir ? ` The server’s own is ${choice.default_dir}.` : ''}
                  </p>
                  {/* Roots the worker refused: / or a folder holding the vault's own (M4). */}
                  {choice.refused_words && (
                    <p className="attention attention-warn">{choice.refused_words}</p>
                  )}
                </div>
                <div className="row wrap">
                  <Button kind="quiet" disabled={verify.busy || !dir.trim()} onClick={check}>
                    {verify.busy ? 'Verifying…' : 'Verify'}
                  </Button>
                  <Button
                    kind="quiet"
                    disabled={browse.busy || !dir.trim()}
                    onClick={() => look(dir)}
                  >
                    {browse.busy ? 'Looking…' : 'Browse folders'}
                  </Button>
                  {choice.default_dir && dir.trim() !== choice.default_dir && (
                    <Button
                      kind="quiet"
                      onClick={() => {
                        setDir(choice.default_dir ?? '');
                        verify.clear();
                      }}
                    >
                      Use the server’s folder
                    </Button>
                  )}
                </div>
                <BrowseList
                  listed={listed}
                  roots={choice.roots}
                  late={browse.view?.state === 'late' ? browse.view.words : null}
                  error={browse.error}
                  onPick={(p) => {
                    setDir(p);
                    verify.clear();
                    look(p);
                  }}
                />
                <ErrorNote message={verify.error} />
                <div ref={verified} tabIndex={-1} role="status" className="stack">
                  {verify.view?.state === 'late' && (
                    <p className="attention">{verify.view.words}</p>
                  )}
                  {result && (
                    <>
                      <p className={result.ok ? 'attention attention-calm' : 'attention'}>
                        {result.words}
                      </p>
                      <ul
                        className="verify-steps"
                        aria-label={`What was checked of ${result.path}`}
                      >
                        {result.steps.map((s) => (
                          <li
                            key={s.check}
                            className={
                              s.ok === true ? 'step-ok' : s.ok === false ? 'step-bad' : 'step-skip'
                            }
                          >
                            <span className="step-mark" aria-hidden="true">
                              {s.ok === true ? '✓' : s.ok === false ? '✗' : '–'}
                            </span>{' '}
                            {s.words}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
                <h2 id="scanner-keep-h" className="section-h">
                  Kept scans
                </h2>
                <div className="field">
                  <label htmlFor="scanner-keep">Keep each scan for this many days</label>
                  <input
                    id="scanner-keep"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={WATCH_KEEP_DAYS_MAX}
                    value={keep}
                    aria-describedby="scanner-keep-note scanner-keep-warning"
                    aria-invalid={!keepValid}
                    onChange={(e) => setKeep(e.target.value)}
                  />
                  <p id="scanner-keep-note" className="muted field-note">
                    Once a scan is safely in the vault it is moved to the folder’s “processed”
                    folder, by date, and deleted after this many days. 0 deletes it at once. Only
                    the scans the vault put there are ever deleted.
                  </p>
                </div>
                <p id="scanner-keep-warning" className="attention attention-warn">
                  {data.kept_warning ?? WATCH_KEPT_WARNING}
                </p>
              </>
            )}
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
                complete, then encrypts it into that person’s Inbox.
                {data.keep_days === undefined || data.keep_days === 0
                  ? ' Then it deletes it from the folder.'
                  : ` Then it moves it to the folder’s processed folder, and deletes it there after ${data.keep_days === 1 ? 'a day' : `${data.keep_days} days`}.`}{' '}
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

/**
 * The folders inside one, as the worker listed them (O1): each a button
 * that chooses it and looks inside it, and the way back up while above a
 * root. Nothing until a folder has been browsed.
 */
function BrowseList(props: {
  listed: WatchBrowseResult | null;
  roots: string[];
  late: string | null;
  error: string | null;
  onPick: (path: string) => void;
}) {
  const { listed, roots } = props;
  if (props.error) return <ErrorNote message={props.error} />;
  if (props.late) return <p className="attention">{props.late}</p>;
  if (!listed) {
    return roots.length > 1 ? (
      <div className="row wrap">
        {roots.map((r) => (
          <Button key={r} kind="quiet" onClick={() => props.onPick(r)}>
            {`Browse ${r}`}
          </Button>
        ))}
      </div>
    ) : null;
  }
  if (listed.problem) return <p className="attention">{listed.problem}</p>;
  const up = listed.path.slice(0, listed.path.lastIndexOf('/')) || '/';
  const atRoot = roots.includes(listed.path);
  const join = (name: string) => `${listed.path.replace(/\/+$/, '')}/${name}`;
  return (
    <nav aria-label={`Folders in ${listed.path}`} className="stack browse-list">
      <p className="muted">
        {listed.folders.length === 0
          ? `There are no folders in ${listed.path}.`
          : `Folders in ${listed.path}${listed.truncated ? ' (the first few hundred)' : ''}:`}
      </p>
      <ul>
        {!atRoot && (
          <li>
            <Button kind="link" ariaLabel={`Up to ${up}`} onClick={() => props.onPick(up)}>
              Up
            </Button>
          </li>
        )}
        {listed.folders.map((f) => (
          <li key={f}>
            <Button
              kind="link"
              ariaLabel={`Choose ${join(f)}`}
              onClick={() => props.onPick(join(f))}
            >
              {f}
            </Button>
          </li>
        ))}
      </ul>
    </nav>
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
 * "A scanned file couldn't be added" (S3), and "An email couldn't be added"
 * (S4), in Needs attention: the reader's own, each with its name (where it
 * has one) and why, and Dismiss. Nothing when there are none.
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
        setSaid(
          n.source === 'email'
            ? 'Dismissed.'
            : n.left_in_place
              ? `Dismissed. ${n.file_name ?? 'The file'} is still where the scanner saved it.`
              : `Dismissed. ${n.file_name ?? 'The file'} is still in the scanner folder’s rejected folder.`,
        );
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
              ariaLabel={
                n.file_name
                  ? `Dismiss the note about ${n.file_name}`
                  : 'Dismiss the note about an email'
              }
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
