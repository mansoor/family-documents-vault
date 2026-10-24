import type {
  LocalAiNotice as LocalAiNoticeView,
  LocalAiServerView,
  LocalAiSettingsView,
} from '@fdv/shared';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { api } from './api.js';
import { describeError, useApp, useLoad } from './app-context.js';
import { Button, Check, ErrorNote, LoadFailed } from './ui.js';
import { useWorkerCheck } from './worker-check.js';

/**
 * Said where somebody adds papers many at a time (the R4 review, M1): this
 * household's are read by its local AI too, and on which host. Nothing
 * while the vault has none, or the household has it off.
 */
export function LocalAiNotice() {
  const { caps, authVersion, guarded } = useApp();
  const offered = caps?.features?.local_ai === true;
  const [notice, setNotice] = useState<LocalAiNoticeView | null>(null);
  useEffect(() => {
    if (!offered) return;
    let live = true;
    void guarded((t) => api.localAiNotice(t)).then(
      (n) => {
        if (live) setNotice(n);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [offered, authVersion, guarded]);
  if (!offered || !notice?.local_ai) return null;
  return (
    <p className="private-note" role="note">
      <span aria-hidden="true">✦</span> Read by the household’s local AI, on{' '}
      <bdi>{notice.host}</bdi>, beside the vault’s rules.
    </p>
  );
}

/** What the workers found of the endpoint, in words. */
function serverWords(s: LocalAiServerView): string {
  switch (s.state) {
    case 'not_set_up':
      return 'Not set up on this server.';
    case 'reachable':
      return `Set up: ${s.model} at ${s.host}. It answered when last asked.`;
    case 'unreachable':
      return `Set up: ${s.model} at ${s.host}. It didn’t answer when last asked, so papers are read without it.`;
    case 'no_model':
      return `Set up: ${s.model} at ${s.host}. It answers, but hasn’t that model yet: it needs pulling there first.`;
  }
}

/**
 * The local AI (R4), an owner's switch for the household, off unless an
 * owner turns it on. Where the model is — its address and name — is set by
 * whoever runs the vault in .env alone; this page only says what the
 * server found of it and tests it (a tiny fixed prompt, no paper's words).
 * It never makes a document Ready, and nothing it reads leaves the server.
 */
export function LocalAiCard() {
  const { authVersion, guarded, reloadCaps } = useApp();
  const { data, error, setData, reload } = useLoad((t) => api.localAiSettings(t), [authVersion]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const problemAt = useRef<HTMLParagraphElement>(null);
  const tested = useRef<HTMLDivElement>(null);
  const test = useWorkerCheck();
  useEffect(() => {
    if (test.view?.state === 'done' || test.view?.state === 'late') tested.current?.focus();
  }, [test.view]);

  const change = async (to: boolean) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    setSaid(null);
    try {
      const next: LocalAiSettingsView | null = await guarded((t) =>
        api.setLocalAi(t, { local_ai: to }),
      );
      if (!next) return;
      flushSync(() => {
        setData(next);
        setSaid(
          next.local_ai
            ? 'Turned on. Papers read from now on are read with the local AI too.'
            : 'Turned off. Papers read from now on are read by the vault’s rules alone.',
        );
      });
      status.current?.focus();
      void reloadCaps();
    } catch (err) {
      flushSync(() => setProblem(describeError(err)));
      problemAt.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  const setUp = data !== null && data.local_ai_server.state !== 'not_set_up';
  const result = test.view?.state === 'done' ? (test.view.local_ai ?? null) : null;
  return (
    <section className="card stack" aria-labelledby="local-ai-h">
      <h2 id="local-ai-h" style={{ fontSize: 18 }}>
        The local AI
      </h2>
      {data === null && error ? (
        <LoadFailed message={error} what="the reading settings" onRetry={() => void reload()} />
      ) : data === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <p>
            A language model on your server, or on a machine on your network you control, if whoever
            runs the vault has set one up. Turned on, it reads the first pages of each paper beside
            the vault’s rules and suggests details for you to check. It never makes a document Ready
            by itself.
          </p>
          <div>
            <p>What the vault sends it, to the address set up for it and nowhere else:</p>
            <ul>
              <li>
                the first pages’ words of every paper anybody here adds many at a time — from Add,
                the scanner folder and email — Only me papers included;
              </li>
              <li>
                when the Reading check runs, the words of the filed documents the owner running it
                can see;
              </li>
              <li>
                the household’s kinds of document, and the first names of the family (whole names
                where two share one).
              </li>
            </ul>
            <p className="muted">
              The model’s server may keep what it is sent in its own logs. Best on this same server,
              or over https.
            </p>
          </div>
          <p
            className={data.local_ai_server.state === 'reachable' ? '' : 'attention'}
            role="status"
          >
            {serverWords(data.local_ai_server)}
          </p>
          {!setUp && (
            <p className="muted">
              Whoever runs the vault sets it up in the server’s .env file (FDV_LOCAL_AI_URL and
              FDV_LOCAL_AI_MODEL): the README says how. It can’t be set from here.
            </p>
          )}
          <Check
            id="local-ai"
            checked={data.local_ai}
            disabled={busy || (!setUp && !data.local_ai)}
            label="Read this household’s papers with the local AI too"
            note="Off unless you turn it on. On, it reads everyone’s uploads in the household, and each of them is told so where they add papers. Off, the vault’s rules read alone: run the Reading check with it on and off to compare."
            onChange={(on) => void change(on)}
          />
          <p className="muted">
            A detail it suggested says “suggested by the local AI”, and the card waits for you to
            check it. Where it reads a paper differently from the rules, the card says so and waits
            too.
          </p>
          {setUp && (
            <div className="row">
              <Button
                kind="quiet"
                disabled={test.busy || busy}
                describedBy="local-ai-test-note"
                onClick={() => void test.run((t) => api.testLocalAi(t))}
              >
                {test.busy ? 'Testing…' : 'Test'}
              </Button>
            </div>
          )}
          {setUp && (
            <p id="local-ai-test-note" className="muted field-note">
              Test sends the model a one-line question of its own — none of your papers — and says
              how long it took to answer.
            </p>
          )}
          <ErrorNote message={test.error} />
          <div ref={tested} tabIndex={-1} role="status" className="stack">
            {test.view?.state === 'late' && <p className="attention">{test.view.words}</p>}
            {result && (
              <p className={result.problem ? 'attention' : 'notice'}>
                <span aria-hidden="true">{result.problem ? '✗ ' : '✓ '}</span>
                {result.words}
              </p>
            )}
          </div>
          {busy && <p className="muted">Working…</p>}
          {problem && (
            <p ref={problemAt} className="error" role="alert" tabIndex={-1}>
              {problem}
            </p>
          )}
        </>
      )}
      <p ref={status} className="notice status-line" role="status" tabIndex={-1}>
        {said}
      </p>
    </section>
  );
}
