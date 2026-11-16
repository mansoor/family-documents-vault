import {
  ENDED_SHARING_DAYS,
  ENDED_SHARING_DEFAULT,
  ENDED_SHARING_KEPT_NOTE,
  endedSharingChoiceWords,
  endedSharingSpan,
  endedSharingWords,
  refusalFor,
  type EndedSharingDays,
} from '@fdv/shared';
import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { api } from './api.js';
import { describeError, useApp, useLoad } from './app-context.js';
import { Button, ConfirmDialog, LoadFailed } from './ui.js';

/** The choices, in the order Settings offers them. */
const CHOICES: ReadonlyArray<EndedSharingDays | null> = [...ENDED_SHARING_DAYS, null];

/** Whether a new choice removes sooner than the old: Never to any, or fewer days. */
export function removesSooner(was: EndedSharingDays | null, to: EndedSharingDays | null): boolean {
  if (to === null) return false;
  return was === null || to < was;
}

/**
 * Settings → Privacy (0.9.0, RQ; the owner's ask of 16 Nov 2026): how long
 * links outside the family and requests to send documents are kept once
 * they no longer work — the household's, an owner's to change; an adult,
 * who makes links and requests, reads it. What stays once one is removed is
 * said beside it: the activity log's record of each, and what was filed.
 *
 * A choice is made, then saved (the review of 0106: arrow keys pass over
 * every radio); one that removes sooner than before is confirmed first,
 * saying what goes the next night. No step-up: the household's other
 * keeping settings (the scanner folder's kept scans) ask none either.
 */
export function EndedSharingCard() {
  const { authVersion, guarded } = useApp();
  const { data, error, setData, reload } = useLoad((t) => api.endedSharing(t), [authVersion]);
  // What is chosen and not yet saved; undefined, what is saved.
  const [picked, setPicked] = useState<EndedSharingDays | null | undefined>(undefined);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);

  const saved = data?.remove_after_days ?? null;
  const chosen = picked === undefined ? saved : picked;
  const unsaved = data !== null && chosen !== saved;

  const save = async () => {
    if (busy || !unsaved) return;
    setBusy(true);
    setProblem(null);
    setSaid(null);
    try {
      const next = await guarded((t) => api.setEndedSharing(t, chosen));
      setAsking(false);
      if (!next) return;
      flushSync(() => {
        setData(next);
        setPicked(undefined);
        setSaid(`Saved: ${endedSharingChoiceWords(next.remove_after_days)}.`);
      });
      status.current?.focus();
    } catch (err) {
      setAsking(false);
      setProblem(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card stack" aria-labelledby="ended-sharing-h">
      <h2 id="ended-sharing-h" style={{ fontSize: 18 }}>
        Links and requests that no longer work
      </h2>
      <p className="muted">
        A link or a request no longer works once it is taken back, closed, stopped after wrong
        codes, or past its end. One that is only paused or used up is not removed until its end has
        passed too.
      </p>
      {data === null && error ? (
        <LoadFailed
          message={error}
          what="links and requests that no longer work"
          onRetry={() => void reload()}
        />
      ) : null}
      {data &&
        (data.can_change ? (
          <>
            <fieldset className="stack" disabled={busy}>
              <legend>Remove them from Sharing</legend>
              {CHOICES.map((days) => (
                <div key={String(days)} className="check">
                  <input
                    id={`ended-sharing-${days ?? 'never'}`}
                    type="radio"
                    name="ended-sharing"
                    checked={chosen === days}
                    onChange={() => {
                      setSaid(null);
                      setPicked(days);
                    }}
                  />
                  <label htmlFor={`ended-sharing-${days ?? 'never'}`}>
                    {endedSharingChoiceWords(days)}
                    {days === ENDED_SHARING_DEFAULT ? ' (the default)' : ''}
                  </label>
                </div>
              ))}
            </fieldset>
            <div className="row">
              <Button
                ref={saveButton}
                disabled={busy || !unsaved}
                onClick={() => {
                  if (removesSooner(saved, chosen)) setAsking(true);
                  else void save();
                }}
              >
                Save
              </Button>
            </div>
          </>
        ) : (
          <dl className="facts">
            <dt>Now</dt>
            <dd>{endedSharingWords(data.remove_after_days)}</dd>
          </dl>
        ))}
      {data && <p className="muted">{ENDED_SHARING_KEPT_NOTE}</p>}
      {data && !data.can_change && <p className="muted">{refusalFor('household.ended_sharing')}</p>}
      {busy && <p className="muted">Working…</p>}
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      <p ref={status} className="notice status-line" role="status" tabIndex={-1}>
        {said}
      </p>
      {asking && chosen !== null && (
        <ConfirmDialog
          title="Remove them sooner?"
          confirmLabel={`Remove after ${endedSharingSpan(chosen)}`}
          busyLabel="Saving…"
          danger
          busy={busy}
          returnFocus={saveButton}
          onConfirm={() => void save()}
          onCancel={() => setAsking(false)}
        >
          <p>
            Links and requests that ended more than {endedSharingSpan(chosen)} ago will be removed
            from Sharing the next night, and can’t be brought back. {ENDED_SHARING_KEPT_NOTE}
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}
