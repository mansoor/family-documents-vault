import {
  MY_WORDING_WORDS,
  MY_WORDINGS,
  NEUTRAL_WORDING_WORDS,
  NEUTRAL_WORDINGS,
  PRIVATE_EXAMPLE,
  rulesWords,
  WORDING_EXAMPLE_DOCUMENTS,
  wordingExamples,
  type MyWording,
  type MyWordingView,
  type NeutralWording,
} from '@fdv/shared';
import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { api } from './api.js';
import { describeError, useApp, useLoad } from './app-context.js';
import { LoadFailed } from './ui.js';

/**
 * Neutral wording in notifications and email (0.9.0, H2): whether what the
 * vault sends — the email digest, the reminder email, a browser's
 * notification — names a document by its title, or says only "A reminder
 * about a document". The household's choice is an owner's, in Settings →
 * Privacy (`NeutralWordingCard`); each person may hide more in what is sent
 * to them, in Settings → Notifications (`MyWordingChoice`) — the household's
 * choice always applies as well. Each choice shows the lines it would send,
 * in plain words.
 */

/** The lines some choices send, for a sensitive document, a Health one and one of neither. */
function Examples(props: { rules: readonly NeutralWording[]; id?: string }) {
  const lines = wordingExamples(props.rules);
  return (
    <ul className="muted wording-examples" id={props.id} style={{ margin: '4px 0 0' }}>
      {(Object.keys(WORDING_EXAMPLE_DOCUMENTS) as Array<keyof typeof lines>).map((k) => (
        <li key={k}>
          {WORDING_EXAMPLE_DOCUMENTS[k]}: <q>{lines[k]}</q>
        </li>
      ))}
    </ul>
  );
}

const ONLY_ME_NOTE = (
  <p className="muted">
    Whatever is chosen, an Only me document is never named: <q>{PRIVATE_EXAMPLE}</q>. Texts never
    name a document, and neither does the phone app’s notification.
  </p>
);

/** Settings → Privacy: the household's choice, an owner's. */
export function NeutralWordingCard() {
  const { authVersion, guarded } = useApp();
  const { data, error, setData, reload } = useLoad((t) => api.neutralWording(t), [authVersion]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const status = useRef<HTMLParagraphElement>(null);

  const change = async (to: NeutralWording) => {
    if (busy || data?.neutral_wording === to) return;
    setBusy(true);
    setProblem(null);
    setSaid(null);
    try {
      const next = await guarded((t) => api.setNeutralWording(t, { neutral_wording: to }));
      if (!next) return;
      flushSync(() => {
        setData(next);
        setSaid(`Saved: ${NEUTRAL_WORDING_WORDS[next.neutral_wording].label}.`);
      });
      status.current?.focus();
    } catch (err) {
      setProblem(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card stack" aria-labelledby="wording-h">
      <h2 id="wording-h" style={{ fontSize: 18 }}>
        Neutral wording in notifications and email
      </h2>
      <p className="muted">
        Emails and notifications can be read by more people than the family: whoever runs the mail
        server, or anyone who picks up a phone. Choose which documents they name by title. The rest
        say only that there is a reminder, and when it is due.
      </p>
      {data === null && error ? (
        <LoadFailed message={error} what="neutral wording" onRetry={() => void reload()} />
      ) : null}
      {data && (
        <fieldset className="stack" disabled={busy}>
          <legend className="visually-hidden">Which documents are not named</legend>
          {NEUTRAL_WORDINGS.map((rule) => (
            <div key={rule} className="check">
              <input
                id={`wording-${rule}`}
                type="radio"
                name="neutral-wording"
                checked={data.neutral_wording === rule}
                aria-describedby={`wording-${rule}-ex`}
                onChange={() => void change(rule)}
              />
              <label htmlFor={`wording-${rule}`}>
                {NEUTRAL_WORDING_WORDS[rule].label}
                {rule === 'sensitive' ? ' (the default)' : ''}
                <span className="muted">{NEUTRAL_WORDING_WORDS[rule].note}</span>
                <Examples rules={[rule]} id={`wording-${rule}-ex`} />
              </label>
            </div>
          ))}
        </fieldset>
      )}
      {ONLY_ME_NOTE}
      {data && (
        <p className="muted">
          A change that names any document now left unnamed asks you to confirm it’s you. Everyone
          can hide more for themselves in Settings → Notifications.
        </p>
      )}
      {busy && <p className="muted">Working…</p>}
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      <p ref={status} className="notice status-line" role="status" tabIndex={-1}>
        {said}
      </p>
    </section>
  );
}

/** Settings → Notifications: each person's own, beside the household's. */
export function MyWordingChoice() {
  const { caps, guarded, authVersion } = useApp();
  const offered = caps?.features.neutral_wording === true;
  const { data, error, setData, reload } = useLoad(
    async (t) => (offered ? api.myWording(t) : null),
    [authVersion, offered],
  );
  const [problem, setProblem] = useState<string | null>(null);
  if (!offered) return null;

  const choose = async (to: MyWording) => {
    setProblem(null);
    try {
      // Naming anything more to them asks them to confirm it's them.
      const next: MyWordingView | null = await guarded((t) =>
        api.setMyWording(t, { neutral_wording: to }),
      );
      if (next) setData(next);
    } catch (err) {
      setProblem(describeError(err));
    }
  };
  return (
    <fieldset className="stack" aria-describedby="my-wording-now">
      <legend style={{ fontWeight: 600 }}>Naming documents</legend>
      <p className="muted">
        Which documents the emails and notifications sent to you leave unnamed, besides those the
        household’s choice leaves unnamed: that always applies as well, so you can hide more, never
        less.
      </p>
      {data === null && error ? (
        <LoadFailed message={error} what="how documents are named" onRetry={() => void reload()} />
      ) : null}
      {data && (
        <>
          {MY_WORDINGS.map((mine) => (
            <div key={mine} className="check">
              <input
                id={`my-wording-${mine}`}
                type="radio"
                name="my-wording"
                checked={data.neutral_wording === mine}
                onChange={() => void choose(mine)}
              />
              <label htmlFor={`my-wording-${mine}`}>
                {mine === 'household'
                  ? `${MY_WORDING_WORDS.household.label} (${NEUTRAL_WORDING_WORDS[data.household].label})`
                  : MY_WORDING_WORDS[mine].label}
                <span className="muted">{MY_WORDING_WORDS[mine].note}</span>
              </label>
            </div>
          ))}
          <div id="my-wording-now" className="muted">
            {data.in_effect.includes('off')
              ? 'What is sent to you names every document but Only me ones.'
              : `Not named in what is sent to you: ${rulesWords(data.in_effect)}.`}
            <Examples rules={data.in_effect} />
          </div>
        </>
      )}
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
    </fieldset>
  );
}
