import { useRef, useState, type FormEvent } from 'react';
import {
  RECOVERY_CODE_COUNT,
  SECURITY_QUESTION_CHOICES,
  SECURITY_QUESTION_COUNT,
  SECURITY_QUESTION_OWN,
  SECURITY_QUESTIONS_WARNING,
  securityAnswerProblem,
  type RecoveryCodesMade,
  type SecurityQuestionsInput,
} from '@fdv/shared';
import { api } from './api.js';
import { describeError, useApp, useLoad } from './app-context.js';
import { dayWordsOf, useFamilyZone } from './family-time.js';
import { canCopy } from './identity.js';
import { PrintOut } from './print.js';
import { Button, ConfirmDialog, ErrorNote, Field, LoadFailed, Select } from './ui.js';

/**
 * Getting back in when the second step is lost (0.9.0-dev.104): recovery
 * codes, and security questions if the person wants them. Both are made and
 * set in Settings → Your account; either stands in for the second step at
 * sign-in (Entry.tsx) and at a password reset (Password.tsx), never on its
 * own.
 */

/**
 * Ten new codes, shown this once: Download, Print and Copy, then Done. The
 * vault keeps only their hashes, so nothing shows them again.
 */
export function RecoveryCodesShown(props: { codes: string[]; onDone: () => void }) {
  const { caps } = useApp();
  const [printing, setPrinting] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const vault = caps?.branding.display_name ?? 'Family Document Vault';
  const text = [
    `${vault}: recovery codes`,
    '',
    'Each code works once, in place of your second step, with your password or a password reset link.',
    'Keep them somewhere safe and away from your devices.',
    '',
    ...props.codes,
    '',
  ].join('\n');
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'vault-recovery-codes.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied('Copied.');
    } catch {
      setCopied('This browser wouldn’t copy them. Download or print them instead.');
    }
  };
  return (
    <section className="card stack" aria-labelledby="recovery-shown-h" data-testid="recovery-codes">
      <h2 id="recovery-shown-h" style={{ fontSize: 18 }}>
        Your recovery codes
      </h2>
      <p>
        Keep these somewhere safe, away from your phone and computer. Each works once, in place of
        your second step, if you lose it. <strong>They won’t be shown again.</strong>
      </p>
      <ol className="recovery-codes">
        {props.codes.map((c) => (
          <li key={c}>
            <code>{c}</code>
          </li>
        ))}
      </ol>
      <div className="row">
        <Button kind="quiet" onClick={download}>
          Download
        </Button>
        <Button kind="quiet" onClick={() => setPrinting(true)}>
          Print
        </Button>
        {canCopy() && (
          <Button kind="quiet" onClick={() => void copy()}>
            Copy
          </Button>
        )}
      </div>
      <p className="status-line" role="status">
        {copied ?? ''}
      </p>
      <Button onClick={props.onDone}>I’ve kept them</Button>
      {printing && (
        <PrintOut
          title="Recovery codes"
          about={<p>Each works once, in place of your second step. Keep this page safe.</p>}
          onDone={() => setPrinting(false)}
        >
          <ol className="recovery-codes">
            {props.codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ol>
        </PrintOut>
      )}
    </section>
  );
}

/**
 * Settings → Your account → Recovery codes: how many are left, a warning
 * when two or fewer are, and new ones made on request (which replaces the
 * old). `justMade` are codes made as a second step was just set up
 * (`makeCodesIfNone`), shown here once until `onKept`.
 */
export function RecoveryCodesCard(
  props: { justMade?: RecoveryCodesMade | null; onKept?: () => void } = {},
) {
  const { caps, authVersion, guarded } = useApp();
  const zone = useFamilyZone();
  const offered = caps?.features.recovery_codes === true;
  const { data, error, reload, setData } = useLoad(
    async (t) => (offered ? api.recoveryCodes(t) : null),
    [authVersion, offered, props.justMade],
  );
  const [shown, setShown] = useState<RecoveryCodesMade | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const make = async () => {
    setAsking(false);
    setBusy(true);
    setProblem(null);
    try {
      const made = await guarded((t) => api.makeRecoveryCodes(t));
      if (made) {
        setShown(made);
        setData(made);
      }
    } catch (err) {
      setProblem(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  if (!offered) return null;
  const showing = shown ?? props.justMade ?? null;
  if (showing) {
    return (
      <RecoveryCodesShown
        codes={showing.codes}
        onDone={() => {
          setShown(null);
          props.onKept?.();
          void reload();
        }}
      />
    );
  }
  return (
    <section aria-labelledby="recovery-codes-h" className="card stack">
      <h2 id="recovery-codes-h" style={{ fontSize: 18 }}>
        Recovery codes
      </h2>
      <p className="muted">
        {RECOVERY_CODE_COUNT} codes to keep somewhere safe. If you lose your phone, your passkey or
        your authenticator app, one of them signs you in with your password in its place — once.
      </p>
      {data === null && error ? (
        <LoadFailed message={error} what="recovery codes" onRetry={() => void reload()} />
      ) : null}
      {data && !data.second_step && data.made_at === null && (
        <p className="muted">Set up two-step sign-in first, and then make codes for it.</p>
      )}
      {data && data.made_at !== null && (
        <p
          className={data.low ? 'status status-warn' : 'muted'}
          role={data.low ? 'note' : undefined}
        >
          {data.remaining === 0
            ? 'You have no recovery codes left. Make new ones.'
            : `${data.remaining} of ${RECOVERY_CODE_COUNT} left, made ${dayWordsOf(data.made_at, zone, { year: true })}.`}
          {data.low && data.remaining > 0 ? ' Make new ones soon.' : ''}
        </p>
      )}
      {data && data.second_step && data.made_at === null && (
        <p className="status status-warn" role="note">
          You have no recovery codes. Make them now, so that losing your phone doesn’t lock you out.
        </p>
      )}
      <ErrorNote message={problem} />
      {data?.second_step && (
        <div className="row">
          <Button
            ref={button}
            kind={data.made_at === null || data.low ? 'primary' : 'quiet'}
            disabled={busy}
            onClick={() => (data.made_at === null ? void make() : setAsking(true))}
          >
            {busy
              ? 'Making them…'
              : data.made_at === null
                ? 'Make recovery codes'
                : 'Make new codes'}
          </Button>
        </div>
      )}
      {asking && (
        <ConfirmDialog
          title="Make new recovery codes?"
          confirmLabel="Make new codes"
          returnFocus={button}
          onConfirm={() => void make()}
          onCancel={() => setAsking(false)}
        >
          <p>Your old codes stop working as soon as the new ones are made.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

/**
 * A second step just set up (0.9.0-dev.104): with no recovery codes yet, ten
 * are made beside it, to be shown once; null when none were made.
 */
export async function makeCodesIfNone(
  withToken: <T>(fn: (token: string) => Promise<T>) => Promise<T | null>,
  guarded: <T>(fn: (token: string) => Promise<T>) => Promise<T | null>,
): Promise<RecoveryCodesMade | null> {
  const now = await withToken((t) => api.recoveryCodes(t));
  if (!now || !now.second_step || now.made_at !== null) return null;
  return guarded((t) => api.makeRecoveryCodes(t));
}

/** The choices a question may be: each from the list, or the person's own words. */
const QUESTION_OPTIONS = [
  ...SECURITY_QUESTION_CHOICES.map((c) => ({ value: c.key, label: c.text })),
  { value: SECURITY_QUESTION_OWN, label: 'A question in my own words' },
];

/**
 * Settings → Your account → Security questions: three, chosen and
 * answered, which may stand in for a lost second step — never their
 * answers shown again. The page says plainly that relatives may know such
 * answers. Off for the household, they are kept and never asked.
 */
export function SecurityQuestionsCard() {
  const { caps, authVersion, guarded } = useApp();
  const zone = useFamilyZone();
  const offered = caps?.features.security_questions === true;
  const { data, error, reload, setData } = useLoad(
    async (t) => (offered ? api.securityQuestions(t) : null),
    [authVersion, offered],
  );
  const [editing, setEditing] = useState(false);
  const [keys, setKeys] = useState<string[]>(() =>
    SECURITY_QUESTION_CHOICES.slice(0, SECURITY_QUESTION_COUNT).map((c) => c.key),
  );
  const [own, setOwn] = useState('');
  const [answers, setAnswers] = useState<string[]>(() =>
    Array.from({ length: SECURITY_QUESTION_COUNT }, () => ''),
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const removeButton = useRef<HTMLButtonElement>(null);
  if (!offered) return null;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setProblem(null);
    const local =
      new Set(keys).size !== keys.length
        ? 'Choose a different question each time.'
        : answers.map(securityAnswerProblem).find((p) => p !== null);
    if (local) {
      setProblem(local);
      return;
    }
    setBusy(true);
    try {
      const body: SecurityQuestionsInput = {
        questions: keys.map((key, i) => ({
          key,
          ...(key === SECURITY_QUESTION_OWN ? { text: own } : {}),
          answer: answers[i] ?? '',
        })),
      };
      const next = await guarded((t) => api.setSecurityQuestions(t, body));
      if (next) {
        setData(next);
        setEditing(false);
        setAnswers(Array.from({ length: SECURITY_QUESTION_COUNT }, () => ''));
      }
    } catch (err) {
      setProblem(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setRemoving(false);
    setProblem(null);
    try {
      const next = await guarded((t) => api.removeSecurityQuestions(t));
      if (next) setData(next);
    } catch (err) {
      setProblem(describeError(err));
    }
  };

  return (
    <section aria-labelledby="security-questions-h" className="card stack">
      <h2 id="security-questions-h" style={{ fontSize: 18 }}>
        Security questions
      </h2>
      <p className="muted">
        Optional. Three questions only you can answer, which can stand in for your second step if
        you lose it — with your password, or a password reset link. Never on their own.
      </p>
      <p className="status status-warn" role="note">
        {SECURITY_QUESTIONS_WARNING}
      </p>
      {data === null && error ? (
        <LoadFailed message={error} what="security questions" onRetry={() => void reload()} />
      ) : null}
      {data && !data.offered && (
        <p className="muted">
          An owner has turned security questions off for your family, so they aren’t asked.
        </p>
      )}
      {data?.set && !editing && (
        <>
          <ol>
            {data.questions.map((q) => (
              <li key={q.key}>{q.text}</li>
            ))}
          </ol>
          <p className="muted">
            Set {data.set_at ? dayWordsOf(data.set_at, zone, { year: true }) : ''}. Your answers are
            never shown.
          </p>
          {data.refused_until && (
            <p className="status status-warn">
              Answered wrong too many times: they can’t be used until{' '}
              {dayWordsOf(data.refused_until, zone)}.
            </p>
          )}
        </>
      )}
      {editing ? (
        <form onSubmit={(e) => void save(e)} className="stack">
          {keys.map((key, i) => (
            <div key={i} className="stack" style={{ gap: 8 }}>
              <Select
                id={`security-question-${i}`}
                label={`Question ${i + 1}`}
                value={key}
                options={QUESTION_OPTIONS}
                onChange={(v) => setKeys(keys.map((k, j) => (j === i ? v : k)))}
              />
              {key === SECURITY_QUESTION_OWN && (
                <Field
                  id={`security-question-own-${i}`}
                  label="Your question"
                  value={own}
                  onChange={setOwn}
                />
              )}
              <Field
                id={`security-answer-${i}`}
                label={`Answer ${i + 1}`}
                value={answers[i] ?? ''}
                autoComplete="off"
                onChange={(v) => setAnswers(answers.map((a, j) => (j === i ? v : a)))}
                hint="At least 4 letters or numbers. Capitals, spaces and punctuation don’t matter."
              />
            </div>
          ))}
          <ErrorNote message={problem} />
          <div className="row">
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save these questions'}
            </Button>
            <Button kind="quiet" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        data?.offered && (
          <>
            <ErrorNote message={problem} />
            <div className="row">
              <Button kind="quiet" onClick={() => setEditing(true)}>
                {data.set ? 'Change them' : 'Set security questions'}
              </Button>
              {data.set && (
                <Button ref={removeButton} kind="quiet" danger onClick={() => setRemoving(true)}>
                  Remove them
                </Button>
              )}
            </div>
          </>
        )
      )}
      {removing && (
        <ConfirmDialog
          title="Remove your security questions?"
          confirmLabel="Remove them"
          danger
          returnFocus={removeButton}
          onConfirm={() => void remove()}
          onCancel={() => setRemoving(false)}
        >
          <p>They can’t stand in for your second step any more. You can set new ones later.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

/**
 * Settings → Security: whether security questions may stand in for a lost
 * second step in this household. On unless an owner turns it off; shown to
 * owners alone, and theirs to change with a passkey or a code.
 */
export function SecurityQuestionsRuleCard() {
  const { authVersion, guarded } = useApp();
  const { data, error, setData, reload } = useLoad(
    (t) => api.securityQuestionsRule(t),
    [authVersion],
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const change = async (on: boolean) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const next = await guarded((t) => api.setSecurityQuestionsRule(t, on));
      if (next) setData(next);
    } catch (err) {
      setProblem(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card stack" aria-labelledby="security-questions-rule-h">
      <h2 id="security-questions-rule-h" style={{ fontSize: 18 }}>
        Security questions
      </h2>
      <p className="muted">
        On, anybody may set three security questions that stand in for their second step if they
        lose it — with their password, never on their own. Relatives may know the answers, so you
        may prefer recovery codes alone. Off, questions already set are kept but never asked.
      </p>
      {data === null && error ? (
        <LoadFailed message={error} what="security questions" onRetry={() => void reload()} />
      ) : null}
      {data && (
        <div className="check">
          <input
            id="security-questions-on"
            type="checkbox"
            checked={data.on}
            disabled={busy || !data.can_change}
            onChange={(e) => void change(e.target.checked)}
          />
          <label htmlFor="security-questions-on">Let security questions stand in</label>
        </div>
      )}
      <ErrorNote message={problem} />
    </section>
  );
}
