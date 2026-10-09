import { ONLY_ME_SHARING_WORDS, refusalFor, type OnlyMeSharing } from '@fdv/shared';
import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { api, ApiRequestError } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { TwoStepNeeded } from '../identity.js';
import { householdRows, SettingsRows } from '../settings-sections.js';
import { storedRole } from '../session.js';
import { ErrorNote } from '../ui.js';
import { SettingsPage } from './Settings.js';

/**
 * Settings → Household (5.41): the household's rule for Only me documents
 * and links outside the family — and, since Settings has sections, the way
 * to Family and to Kinds of document, the household's other settings (the owner's decision of 6 Oct 2026). An
 * owner's to change, with two-step sign-in and a passkey or a code (A54);
 * an adult reads it, as it decides what their share sheet offers.
 */
export function HouseholdScreen() {
  const { caps, session } = useApp();
  const rows = householdRows(session.info?.role ?? storedRole(), caps);
  return (
    <SettingsPage title="Household">
      <OnlyMeSharingCard />
      {/* Its pages (the owner's ask): who sees identity details, and the
          kinds of document — each where it was shown before. */}
      <SettingsRows rows={rows} label="More for the household" />
    </SettingsPage>
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
  // Never how many: other people's links to their Only me documents are
  // theirs to know, and each maker is told of their own.
  return next.only_me_shareable
    ? 'Turned on. Links it paused work again.'
    : 'Turned off. Any link that sent an Only me document is paused, and whoever made it is told.';
}
