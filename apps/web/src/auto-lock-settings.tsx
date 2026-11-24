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
import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { api } from './api.js';
import { describeError, useApp, useLoad } from './app-context.js';
import { autoLockChanged } from './auto-lock.js';
import { Button, LoadFailed, Select } from './ui.js';

/**
 * Lock by itself after a while away (0.9.0-dev.87), in Settings → Security
 * (24 Nov 2026): one card, two choices side by side.
 *
 *  - For the family, an owner's to change (others read it): Off, or 5, 10,
 *    15, 30 or 60 minutes, 15 unless one chose otherwise.
 *  - For you, anybody's: the family's, or a shorter time for yourself —
 *    never longer, and never Off while the family has a time.
 *
 * Times are chosen, then saved with Save: going through the choices with
 * the arrow keys saves nothing. A longer time, or Off, asks to confirm it's
 * you first (the vault's `change_auto_lock`); cancelled, nothing more is
 * saved. Saved, this tab and every other open tab of this browser ask the
 * vault again for the time in effect (`autoLockChanged`); a page in another
 * browser asks as it is come back to, or within a few minutes.
 */

/** The value a select holds for "Off", and for "as the family's". */
const NONE = '';

const optionValue = (m: AutoLockMinutes | null) => (m === null ? NONE : String(m));
const valueOf = (v: string): AutoLockMinutes | null => {
  const n = Number(v);
  return v !== NONE && isAutoLockMinutes(n) ? n : null;
};

/** Settings → Security: when the vault locks itself, for the family and for you. */
export function AutoLockCard() {
  const { authVersion, guarded } = useApp();
  const loaded = useLoad((t) => api.autoLock(t), [authVersion]);
  const data = loaded.data;
  const status = useRef<HTMLParagraphElement>(null);
  const [pickedFamily, setPickedFamily] = useState<string | null>(null);
  const [pickedMine, setPickedMine] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const savedFamily = data ? optionValue(data.household) : NONE;
  const savedMine = data ? optionValue(data.mine) : NONE;
  const family = pickedFamily ?? savedFamily;
  const mine = pickedMine ?? savedMine;
  const familyChanged = data !== null && data.can_change && family !== savedFamily;
  const mineChanged = data !== null && mine !== savedMine;
  const unsaved = familyChanged || mineChanged;
  // Yours as allowed under a family's time — the family's as it is chosen
  // now: shorter, or kept as you chose it should the family's be shorter.
  const allowedUnder = (v: string, familyMinutes: AutoLockMinutes | null) => {
    const m = valueOf(v);
    return m === null || familyMinutes === null || m < familyMinutes || m === data?.mine;
  };
  const familyNow = valueOf(family);
  const shorter = AUTO_LOCK_MINUTES.filter((m) => allowedUnder(String(m), familyNow));

  const pickFamily = (v: string) => {
    setSaid(null);
    setPickedFamily(v);
    // A time of yours no longer shorter than the family's: back to yours as saved.
    if (pickedMine !== null && !allowedUnder(pickedMine, valueOf(v))) setPickedMine(null);
  };

  /** What the family's time is, and yours, in a few words. */
  const familyWords = (v: AutoLock) => (v.household === null ? 'Off' : autoLockSpan(v.household));
  const yoursWords = (v: AutoLock) =>
    v.in_effect === null
      ? 'it stays unlocked until you lock it'
      : `it locks after ${autoLockSpan(v.in_effect)}`;

  const save = async () => {
    if (busy || !unsaved) return;
    setBusy(true);
    setProblem(null);
    setSaid(null);
    // The family's first, as yours is measured against it.
    let familySaved: AutoLock | null = null;
    let mineSaved: AutoLock | null = null;
    const say = (words: string) => {
      flushSync(() => setSaid(words));
      status.current?.focus();
    };
    try {
      if (familyChanged) {
        familySaved = await guarded((t) => api.setHouseholdAutoLock(t, valueOf(family)));
        if (!familySaved) return;
        const done = familySaved;
        flushSync(() => {
          loaded.setData(done);
          setPickedFamily(null);
        });
      }
      if (mineChanged) {
        mineSaved = await guarded((t) => api.setMyAutoLock(t, valueOf(mine)));
        if (!mineSaved) {
          // Cancelled: the family's is saved all the same, and said so.
          if (familySaved) {
            say(`The family’s time is saved (${familyWords(familySaved)}). Yours wasn’t changed.`);
          }
          return;
        }
        const done = mineSaved;
        flushSync(() => {
          loaded.setData(done);
          setPickedMine(null);
        });
      }
      const last = mineSaved ?? familySaved;
      if (!last) return;
      say(
        familySaved
          ? `Saved. For the family: ${familyWords(last)}. For you: ${yoursWords(last)}.`
          : last.in_effect === null
            ? 'Saved: the vault stays unlocked until you lock it.'
            : `Saved: it locks after ${autoLockSpan(last.in_effect)}.`,
      );
    } catch (err) {
      setProblem(
        familySaved
          ? `The family’s time is saved (${familyWords(familySaved)}), but yours isn’t: ${describeError(err)}`
          : describeError(err),
      );
    } finally {
      // Whatever was saved, every open tab asks again.
      if (familySaved || mineSaved) autoLockChanged();
      setBusy(false);
    }
  };

  return (
    <section className="card stack" aria-labelledby="auto-lock-h">
      <h2 id="auto-lock-h" style={{ fontSize: 18 }}>
        Lock after a while away
      </h2>
      <p className="muted">
        A browser nobody has used for a while locks itself, as Lock does: what was on the screen is
        put away until somebody confirms it’s them. The phone app isn’t locked this way. Each person
        may choose a shorter time for themselves.
      </p>
      {data === null && loaded.error ? (
        <LoadFailed
          message={loaded.error}
          what="when the vault locks itself"
          onRetry={() => void loaded.reload()}
        />
      ) : null}
      {data && (
        <>
          <p className="muted">{autoLockWords(data.in_effect)}</p>
          <div className="auto-lock-pair">
            {data.can_change ? (
              <Select
                id="family-auto-lock"
                label="For the family"
                value={family}
                onChange={pickFamily}
                options={[...AUTO_LOCK_MINUTES, null].map((m) => ({
                  value: optionValue(m),
                  label: `${autoLockChoiceWords(m)}${m === AUTO_LOCK_DEFAULT ? ' (the default)' : ''}`,
                }))}
                hint="A longer time, or Off, asks you to confirm it’s you first."
              />
            ) : (
              <dl className="facts">
                <dt>For the family</dt>
                <dd>{autoLockChoiceWords(data.household)}</dd>
              </dl>
            )}
            <Select
              id="my-auto-lock"
              label="For you"
              value={mine}
              onChange={(v) => {
                setSaid(null);
                setPickedMine(v);
              }}
              options={[
                {
                  value: NONE,
                  label:
                    familyNow === null
                      ? 'As the family’s (Off)'
                      : `As the family’s (${autoLockSpan(familyNow)})`,
                },
                ...shorter.map((m) => ({ value: optionValue(m), label: autoLockChoiceWords(m) })),
              ]}
              hint={
                familyNow === null
                  ? 'The family’s is Off: you can still choose a time for yourself.'
                  : 'A shorter time than the family’s, never a longer one.'
              }
            />
          </div>
          <div className="row">
            <Button disabled={busy || !unsaved} onClick={() => void save()}>
              Save
            </Button>
          </div>
        </>
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
