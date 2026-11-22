import {
  AUTO_LOCK_DEFAULT,
  AUTO_LOCK_MINUTES,
  autoLockChoiceWords,
  autoLockSpan,
  autoLockWords,
  isAutoLockMinutes,
  type AutoLock,
  type AutoLockMinutes,
} from '@fdv/shared';
import { useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { api } from './api.js';
import { describeError, useApp, useLoad } from './app-context.js';
import { autoLockChanged } from './auto-lock.js';
import { Button, LoadFailed, Select } from './ui.js';

/**
 * Lock by itself after a while away (0.9.0-dev.87), in Settings.
 *
 *  - The family's time (Privacy, `FamilyAutoLockCard`), an owner's: Off, or
 *    5, 10, 15, 30 or 60 minutes, 15 unless one chose otherwise.
 *  - Your own (Your account, `MyAutoLockCard`), anybody's: the family's, or
 *    a shorter time for yourself — never longer, and never Off while the
 *    family has a time.
 *
 * A time is chosen, then saved with Save: going through the choices with
 * the arrow keys saves nothing. A longer time, or Off, asks to confirm it's
 * you first (the vault's `change_auto_lock`); cancelled, nothing changes.
 * Saved, this tab and every other open tab of this browser ask the vault
 * again for the time in effect (`autoLockChanged`); a page in another
 * browser asks as it is come back to, or within a few minutes.
 */

/** The value a select holds for "Off", and for "as the family's". */
const NONE = '';

const optionValue = (m: AutoLockMinutes | null) => (m === null ? NONE : String(m));
const valueOf = (v: string): AutoLockMinutes | null => {
  const n = Number(v);
  return v !== NONE && isAutoLockMinutes(n) ? n : null;
};

/**
 * A card's choice: loaded, chosen (`picked`, until saved), saved with Save,
 * and said in `status`, which then takes the focus.
 */
function useAutoLockChoice(
  status: RefObject<HTMLParagraphElement | null>,
  savedOf: (v: AutoLock) => AutoLockMinutes | null,
) {
  const { authVersion, guarded } = useApp();
  const loaded = useLoad((t) => api.autoLock(t), [authVersion]);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const savedValue = loaded.data ? optionValue(savedOf(loaded.data)) : NONE;
  const chosen = picked ?? savedValue;
  const unsaved = loaded.data !== null && chosen !== savedValue;
  const pick = (v: string) => {
    setSaid(null);
    setPicked(v);
  };
  const save = async (
    send: (t: string, minutes: AutoLockMinutes | null) => Promise<AutoLock>,
    words: (v: AutoLock) => string,
  ) => {
    if (busy || !unsaved) return;
    setBusy(true);
    setProblem(null);
    setSaid(null);
    try {
      const next = await guarded((t) => send(t, valueOf(chosen)));
      if (!next) return;
      flushSync(() => {
        loaded.setData(next);
        setPicked(null);
        setSaid(words(next));
      });
      autoLockChanged();
      status.current?.focus();
    } catch (err) {
      setProblem(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return { ...loaded, chosen, unsaved, pick, busy, problem, said, save };
}

/** Settings → Privacy: when the vault locks itself for the family. */
export function FamilyAutoLockCard() {
  const status = useRef<HTMLParagraphElement>(null);
  const c = useAutoLockChoice(status, (v) => v.household);
  const data = c.data;
  return (
    <section className="card stack" aria-labelledby="family-auto-lock-h">
      <h2 id="family-auto-lock-h" style={{ fontSize: 18 }}>
        Lock after a while away
      </h2>
      <p className="muted">
        A browser nobody has used for a while locks itself, as Lock does: what was on the screen is
        put away until somebody confirms it’s them. The phone app isn’t locked this way. Each person
        may choose a shorter time for themselves in Your account.
      </p>
      {data === null && c.error ? (
        <LoadFailed
          message={c.error}
          what="when the vault locks itself"
          onRetry={() => void c.reload()}
        />
      ) : null}
      {data &&
        (data.can_change ? (
          <>
            <Select
              id="family-auto-lock"
              label="For the family"
              value={c.chosen}
              onChange={c.pick}
              options={[...AUTO_LOCK_MINUTES, null].map((m) => ({
                value: optionValue(m),
                label: `${autoLockChoiceWords(m)}${m === AUTO_LOCK_DEFAULT ? ' (the default)' : ''}`,
              }))}
              hint="A longer time, or Off, asks you to confirm it’s you first."
            />
            <div className="row">
              <Button
                disabled={c.busy || !c.unsaved}
                onClick={() =>
                  void c.save(
                    (t, m) => api.setHouseholdAutoLock(t, m),
                    (next) => `Saved: ${autoLockChoiceWords(next.household)}.`,
                  )
                }
              >
                Save
              </Button>
            </div>
          </>
        ) : (
          <dl className="facts">
            <dt>For the family</dt>
            <dd>{autoLockChoiceWords(data.household)}</dd>
          </dl>
        ))}
      {c.busy && <p className="muted">Working…</p>}
      {c.problem && (
        <p className="error" role="alert">
          {c.problem}
        </p>
      )}
      <p ref={status} className="notice status-line" role="status" tabIndex={-1}>
        {c.said}
      </p>
    </section>
  );
}

/** Settings → Your account: your own time, shorter than the family's. */
export function MyAutoLockCard() {
  const status = useRef<HTMLParagraphElement>(null);
  const c = useAutoLockChoice(status, (v) => v.mine);
  const data = c.data;
  const family = data?.household ?? null;
  // Shorter than the family's; and their own, kept as they chose it should the family's be shorter now.
  const shorter = AUTO_LOCK_MINUTES.filter(
    (m) => family === null || m < family || m === data?.mine,
  );
  return (
    <section className="card stack" aria-labelledby="my-auto-lock-h">
      <h2 id="my-auto-lock-h" style={{ fontSize: 18 }}>
        Lock after a while away
      </h2>
      {data === null && c.error ? (
        <LoadFailed
          message={c.error}
          what="when the vault locks itself"
          onRetry={() => void c.reload()}
        />
      ) : null}
      {data && (
        <>
          <p className="muted">{autoLockWords(data.in_effect)}</p>
          <Select
            id="my-auto-lock"
            label="For you"
            value={c.chosen}
            onChange={c.pick}
            options={[
              {
                value: NONE,
                label:
                  family === null
                    ? 'As the family’s (Off)'
                    : `As the family’s (${autoLockSpan(family)})`,
              },
              ...shorter.map((m) => ({ value: optionValue(m), label: autoLockChoiceWords(m) })),
            ]}
            hint={
              family === null
                ? 'The family’s is Off: you can still choose a time for yourself.'
                : 'You can choose a shorter time than the family’s, never a longer one.'
            }
          />
          <div className="row">
            <Button
              disabled={c.busy || !c.unsaved}
              onClick={() =>
                void c.save(
                  (t, m) => api.setMyAutoLock(t, m),
                  (next) =>
                    next.in_effect === null
                      ? 'Saved: the vault stays unlocked until you lock it.'
                      : `Saved: it locks after ${autoLockSpan(next.in_effect)}.`,
                )
              }
            >
              Save
            </Button>
          </div>
        </>
      )}
      {c.busy && <p className="muted">Working…</p>}
      {c.problem && (
        <p className="error" role="alert">
          {c.problem}
        </p>
      )}
      <p ref={status} className="notice status-line" role="status" tabIndex={-1}>
        {c.said}
      </p>
    </section>
  );
}
