import { ONLY_ME_SHARING_WORDS, refusalFor, type OnlyMeSharing } from '@fdv/shared';
import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { api, ApiRequestError } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { TwoStepNeeded } from '../identity.js';
import { BottomNav, ErrorNote, TopBar } from '../ui.js';

/**
 * Settings → Household (5.41): the household's rule for Only me documents
 * and links outside the family (the owner's decision of 6 Oct 2026). An
 * owner's to change, with two-step sign-in and a passkey or a code (A54);
 * an adult reads it, as it decides what their share sheet offers.
 */
export function HouseholdScreen() {
  return (
    <main className="page page-top has-nav">
      <TopBar title="Household" back="/settings" />
      <OnlyMeSharingCard />
      <BottomNav />
    </main>
  );
}

function OnlyMeSharingCard() {
  const { authVersion, guarded } = useApp();
  const { data, error, setData } = useLoad((t) => api.onlyMeSharing(t), [authVersion]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [twoStep, setTwoStep] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const problemAt = useRef<HTMLDivElement>(null);

  const change = async (to: boolean) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    setTwoStep(null);
    setSaid(null);
    try {
      const next: OnlyMeSharing | null = await guarded((t) => api.setOnlyMeSharing(t, to));
      if (!next) return;
      flushSync(() => {
        setData(next);
        setSaid(changedWords(next));
      });
      status.current?.focus();
    } catch (err) {
      flushSync(() => {
        if (err instanceof ApiRequestError && err.code === 'totp_required_for_owner') {
          setTwoStep(err.message);
        } else {
          setProblem(describeError(err));
        }
      });
      problemAt.current?.querySelector<HTMLElement>('[role="alert"]')?.focus();
    } finally {
      setBusy(false);
    }
  };

  const on = data?.only_me_shareable ?? true;
  return (
    <section className="card stack" aria-labelledby="only-me-h">
      <h2 id="only-me-h" style={{ fontSize: 18 }}>
        Only me documents and links outside the family
      </h2>
      <ErrorNote message={error} />
      {data && (
        <>
          <dl className="facts">
            <dt>Now</dt>
            <dd>{on ? ONLY_ME_SHARING_WORDS.on : ONLY_ME_SHARING_WORDS.off}</dd>
          </dl>
          {data.can_change ? (
            <>
              <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={busy}
                  aria-describedby="only-me-on only-me-off"
                  onChange={(e) => void change(e.target.checked)}
                />
                <span>Only me documents can be shared outside the family</span>
              </label>
              <p id="only-me-on" className="muted">
                On: {ONLY_ME_SHARING_WORDS.on}
              </p>
              <p id="only-me-off" className="muted">
                Off: {ONLY_ME_SHARING_WORDS.off}
              </p>
              <p className="muted">
                Changing it asks you to confirm it’s you with a passkey or a code from your
                authenticator app.
              </p>
              {busy && <p className="muted">Working…</p>}
              <div ref={problemAt} className="stack">
                {twoStep && <TwoStepNeeded message={twoStep} />}
                {problem && (
                  <p className="error" role="alert" tabIndex={-1}>
                    {problem}
                  </p>
                )}
              </div>
            </>
          ) : (
            <p className="muted">{refusalFor('sharing.only_me_rule')}</p>
          )}
        </>
      )}
      <p ref={status} className="notice status-line" role="status" tabIndex={-1}>
        {said}
      </p>
    </section>
  );
}

/** "Turned off. 3 links that sent an Only me document are paused." */
export function changedWords(next: OnlyMeSharing): string {
  const n = next.only_me_shareable ? (next.links_resumed ?? 0) : (next.links_paused ?? 0);
  const links =
    n === 1 ? '1 link that sends an Only me document' : `${n} links that send an Only me document`;
  if (next.only_me_shareable) {
    return n > 0 ? `Turned on. ${links} ${n === 1 ? 'works' : 'work'} again.` : 'Turned on.';
  }
  return n > 0
    ? `Turned off. ${links} ${n === 1 ? 'is' : 'are'} paused, and their makers are told.`
    : 'Turned off.';
}
