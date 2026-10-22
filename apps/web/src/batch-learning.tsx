import {
  LEARNED_SURE_CONFIRMATIONS,
  type BatchLearning,
  type LearnedRuleView,
  type LearnedShapeView,
} from '@fdv/shared';
import { useRef, useState } from 'react';
import { api } from './api.js';
import { describeError, useApp, useLoad } from './app-context.js';
import { ConfirmDialog, ErrorNote } from './ui.js';

/**
 * What the vault learned from your corrections (Phase 6, I4), under the
 * Inbox's Your uploads, at every width: how well it is doing — "Of your
 * last 50 accepted, 31 needed no change" — and, a press away, the rules it
 * learned from you, with Forget all. Yours alone: the vault gives nobody
 * else them, an owner included. Nothing at all until there is something to
 * say, and nothing from a vault that does not learn.
 */

/** "2 rules", "2 rules and 1 sender’s papers": what was learned, in words. */
function taughtWords(rules: number, shapes: number): string {
  const r = `${rules} ${rules === 1 ? 'rule' : 'rules'}`;
  if (shapes === 0) return r;
  const p = `${shapes} ${shapes === 1 ? 'layout of a sender’s papers' : 'layouts of senders’ papers'}`;
  return rules === 0 ? p : `${r} and ${p}`;
}

const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

/** "Of your last 50 accepted, 31 needed no change." */
export function countWords(l: Pick<BatchLearning, 'counted' | 'unchanged'>): string {
  if (l.counted === 1) {
    return l.unchanged === 1
      ? 'Your last accepted file needed no change.'
      : 'Your last accepted file needed a change.';
  }
  return `Of your last ${l.counted} accepted, ${l.unchanged} needed no change.`;
}

/** One rule, as its person reads it: who sent it, and what it says. */
function RuleLine({ rule }: { rule: LearnedRuleView }) {
  const says =
    rule.field === 'type_key'
      ? `kind: ${rule.label ?? 'one no longer kept'}`
      : `whose: ${rule.label ?? 'somebody no longer in the household'}`;
  return (
    <li className="learned-rule">
      <span>
        From <strong>{rule.issuer}</strong> — {says}
      </span>
      <span className="muted">
        {rule.contradicted > 0
          ? `confirmed ${times(rule.confirmed)}, not ${times(rule.contradicted)}`
          : `confirmed ${times(rule.confirmed)}`}
        {rule.sure ? ' · trusted' : ''}
      </span>
    </li>
  );
}

const FIELD_WORDS: Record<LearnedShapeView['lessons'][number]['field'], string> = {
  type_key: 'kind',
  owner_member_id: 'whose',
  issued: 'issue date at',
  expires: 'expiry or due date at',
  identifier: 'number at',
};

/** One sender's layout (R1), as its person reads it: who sent it, and what it taught. */
function ShapeLine({ shape }: { shape: LearnedShapeView }) {
  const says = shape.lessons
    .filter((l) => l.confirmed > 0)
    .map((l) => {
      const what =
        l.field === 'type_key' || l.field === 'owner_member_id'
          ? (l.label ?? (l.field === 'type_key' ? 'one no longer kept' : 'somebody no longer here'))
          : `“${l.label ?? l.value}”`;
      return `${FIELD_WORDS[l.field]} ${what}${l.sure ? ' (trusted)' : ''}`;
    });
  return (
    <li className="learned-rule">
      <span>
        Papers like this from <strong>{shape.issuer}</strong>
      </span>
      <span className="muted">{says.length > 0 ? says.join('; ') : 'nothing yet'}</span>
    </li>
  );
}

export function LearnedFromYou() {
  const { caps, authVersion, withToken } = useApp();
  const on = caps?.features.batch_learning === true;
  const { data, error, reload } = useLoad(
    async (t) => (on ? api.batchLearning(t) : null),
    [authVersion, on],
  );
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const forgetButton = useRef<HTMLButtonElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  if (!on) return null;
  if (error) return <ErrorNote message={`What the vault learned couldn’t be loaded: ${error}`} />;
  // The layouts of senders' papers it learned (R1); none from a vault before 0.9.0.
  const shapes = data?.shapes ?? [];
  const taught = (data?.rules.length ?? 0) + shapes.length;
  const something = data && (data.counted > 0 || taught > 0);

  const forget = async () => {
    setBusy(true);
    setFailed(null);
    try {
      await withToken((t) => api.forgetBatchLearning(t));
      setAsking(false);
      setOpen(false);
      setSaid(
        'Forgotten. Your waiting files will be read again, and the vault starts learning again from your next accepts.',
      );
      await reload();
      status.current?.focus();
    } catch (err) {
      setFailed(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p role="status" ref={status} tabIndex={-1} className="status-line">
        {said}
      </p>
      {data && something && (
        <section className="notice-box learned-box" aria-label="What the vault learned from you">
          {data.counted > 0 && <p className="learned-count">{countWords(data)}</p>}
          {taught > 0 && (
            <>
              <button
                type="button"
                className="btn btn-quiet btn-small learned-toggle"
                aria-expanded={open}
                aria-controls="learned-rules"
                onClick={() => setOpen((o) => !o)}
              >
                What the vault has learned from you: {taughtWords(data.rules.length, shapes.length)}
              </button>
              {open && (
                <div id="learned-rules" className="stack learned-rules">
                  <p className="muted">
                    From the files you accepted and corrected: who sent them, and what you chose.
                    Only you can see these, and they are used only on your own uploads. A rule is
                    trusted once you have confirmed it {LEARNED_SURE_CONFIRMATIONS} times and never
                    chosen differently for that sender. What you’ve taught stays until you forget
                    it, even after the documents it came from are gone.
                  </p>
                  {data.rules.length > 0 && (
                    <ul className="learned-list" aria-label="Rules learned from you">
                      {data.rules.map((r) => (
                        <RuleLine key={r.id} rule={r} />
                      ))}
                    </ul>
                  )}
                  {shapes.length > 0 && (
                    <>
                      <p className="muted">
                        And how your senders lay out their papers: their headings and labels, and
                        which label carries a date or a number — never a name, a number or an
                        address from the page.
                      </p>
                      <ul className="learned-list" aria-label="Papers learned from you">
                        {shapes.map((s) => (
                          <ShapeLine key={s.id} shape={s} />
                        ))}
                      </ul>
                    </>
                  )}
                  <div className="row">
                    <button
                      type="button"
                      ref={forgetButton}
                      className="btn btn-quiet btn-small"
                      onClick={() => setAsking(true)}
                    >
                      Forget all
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
          {taught === 0 && data.counted > 0 && (
            <div className="row">
              <button
                type="button"
                ref={forgetButton}
                className="btn btn-quiet btn-small"
                onClick={() => setAsking(true)}
              >
                Forget the count
              </button>
            </div>
          )}
        </section>
      )}
      {asking && data && (
        <ConfirmDialog
          title="Forget what the vault learned from you?"
          confirmLabel="Forget all"
          busyLabel="Forgetting…"
          danger
          busy={busy}
          returnFocus={forgetButton}
          onConfirm={() => void forget()}
          onCancel={() => {
            setAsking(false);
            setFailed(null);
          }}
        >
          <p>
            {taught > 0
              ? `Its ${taughtWords(data.rules.length, shapes.length)} and the count go. `
              : 'The count goes. '}
            Your waiting files will be read again. It starts learning again from your next accepts.
            Your documents are not changed.
          </p>
          <ErrorNote message={failed} />
        </ConfirmDialog>
      )}
    </>
  );
}
