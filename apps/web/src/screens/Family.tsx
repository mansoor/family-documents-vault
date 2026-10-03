import {
  can,
  IDENTITY_AUDIENCE_LABELS,
  IDENTITY_AUDIENCES,
  IDENTITY_NOTICE_HOURS,
  identityAudienceRank,
  refusalFor,
  type IdentityAudience,
  type IdentityAudienceView,
} from '@fdv/shared';
import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { api, ApiRequestError } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { TwoStepNeeded, whenWords } from '../identity.js';
import { storedRole } from '../session.js';
import { BottomNav, Button, ErrorNote, Pills, TopBar } from '../ui.js';

/**
 * Settings → Family (5.27): who can see the identity details kept on each
 * person's profile (A34). An owner's to change, with two-step sign-in and a
 * passkey or a code (A54). Wider waits 72 hours, while everybody with a
 * sign-in is told and may mark anything Only me; narrower is at once.
 */

/** Who an audience is, after "will see them": "all adults". */
const AUDIENCE_WHO: Record<IdentityAudience, string> = {
  owners_and_self: 'only the owners, and each person their own',
  adults: 'all adults',
  family: 'everyone in the family but viewers',
};

export function FamilyScreen() {
  return (
    <main className="page page-top has-nav">
      <TopBar title="Family" back="/settings" />
      <IdentityAudienceCard />
      <BottomNav />
    </main>
  );
}

function IdentityAudienceCard() {
  const { authVersion, guarded } = useApp();
  const owner = can(storedRole(), 'identity.audience');
  const { data, error, setData } = useLoad(
    async (t) => {
      const [audience, profile] = await Promise.all([api.identityAudience(t), api.profile(t)]);
      return { audience, timezone: profile.timezone ?? 'UTC' };
    },
    [authVersion],
  );
  const [chosen, setChosen] = useState<IdentityAudience | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [twoStep, setTwoStep] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const problemAt = useRef<HTMLDivElement>(null);

  const view = data?.audience ?? null;
  const timezone = data?.timezone ?? 'UTC';
  const now = view?.audience ?? 'owners_and_self';
  const pending = view?.pending ?? null;
  const choice = chosen ?? pending?.to ?? now;
  const wider = identityAudienceRank(choice) > identityAudienceRank(now);
  const action: 'widen' | 'narrow' | null =
    choice === now ? null : wider ? (pending?.to === choice ? null : 'widen') : 'narrow';

  const change = async (to: IdentityAudience, what: 'widen' | 'narrow' | 'withdraw') => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    setTwoStep(null);
    setSaid(null);
    try {
      const next: IdentityAudienceView | null = await guarded((t) =>
        api.setIdentityAudience(t, to),
      );
      if (!next) return;
      flushSync(() => {
        setData({ audience: next, timezone });
        setChosen(null);
        setSaid(
          what === 'widen' && next.pending
            ? `Asked. From ${whenWords(next.pending.notice_until, timezone)}, ${AUDIENCE_WHO[next.pending.to]} will see them. Everyone with a sign-in has been told.`
            : what === 'withdraw'
              ? 'Withdrawn. Nobody else will see them.'
              : `Done. From now on, ${AUDIENCE_WHO[next.audience]} see them.`,
        );
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

  return (
    <section className="card stack" aria-labelledby="audience-h">
      <h2 id="audience-h" style={{ fontSize: 18 }}>
        Who can see identity details
      </h2>
      <p className="muted">
        The names, contacts, addresses and ID numbers kept on each person’s profile. Each person
        always sees their own, and no one but them sees what they mark Only me. Viewers never see
        anyone else’s.
      </p>
      <ErrorNote message={error} />
      {view && (
        <dl className="facts">
          <dt>Now</dt>
          <dd>{IDENTITY_AUDIENCE_LABELS[now]}</dd>
        </dl>
      )}
      {pending && (
        <p className="status status-warn">
          From {whenWords(pending.notice_until, timezone)}, {AUDIENCE_WHO[pending.to]} will see
          them. Everyone with a sign-in has been told, and all but viewers can mark anything Only me
          before then.
        </p>
      )}
      {view && owner ? (
        <>
          {pending && (
            <Button kind="quiet" disabled={busy} onClick={() => void change(now, 'withdraw')}>
              {busy ? 'Working…' : 'Withdraw this'}
            </Button>
          )}
          <Pills
            label="Who can see them"
            value={choice}
            options={IDENTITY_AUDIENCES.map((a) => ({
              value: a,
              label: IDENTITY_AUDIENCE_LABELS[a],
            }))}
            onChange={(v) => {
              setSaid(null);
              setChosen(v);
            }}
          />
          <p className="muted">
            Letting more people see them waits {IDENTITY_NOTICE_HOURS} hours: everyone with a
            sign-in is told first, and all but viewers can mark anything Only me before then. Fewer
            people takes effect at once. Either way, you confirm it’s you with a passkey or a code
            from your authenticator app.
          </p>
          {action && (
            <Button disabled={busy} onClick={() => void change(choice, action)}>
              {busy
                ? 'Working…'
                : action === 'widen'
                  ? `Tell everyone, and wait ${IDENTITY_NOTICE_HOURS} hours`
                  : 'Change it now'}
            </Button>
          )}
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
        view && <p className="muted">{refusalFor('identity.audience')}</p>
      )}
      <p ref={status} className="notice status-line" role="status" tabIndex={-1}>
        {said}
      </p>
    </section>
  );
}
