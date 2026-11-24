import {
  PASSWORD_MIN_LENGTH,
  PASSWORD_MIN_LENGTH_CEILING,
  PASSWORD_RULES_DEFAULT,
  PASSWORD_RULES_KEYS,
  isPasswordMinLength,
  passwordLacks,
  passwordRefusalWords,
  passwordRulesOf,
  passwordRulesWords,
  type Capabilities,
  type PasswordRules,
  type PasswordRulesView,
} from '@fdv/shared';
import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { api } from './api.js';
import { describeError, useApp, useLoad } from './app-context.js';
import { Button, LoadFailed } from './ui.js';

/**
 * Password rules (`features.password_rules`), in the web app.
 *
 *  - Settings → Security, `PasswordRulesCard`: an owner sets them — the
 *    least length, 10 to 64; common and easily guessed passwords refused;
 *    an uppercase letter, a lowercase letter, a number, a symbol.
 *  - Every form that sets a sign-in password says them under the field
 *    (`passwordHint`), and what the password typed still lacks as it is
 *    typed (`passwordStillLacks`), for the length and the mix. Whether a
 *    password is common is the vault's to say: its refusal is shown as the
 *    form's error.
 *
 * A vault from before them asks 10 characters and nothing else
 * (`RULES_BEFORE`).
 */

/** What a vault from before the rules asks: 10 characters, and nothing else. */
export const RULES_BEFORE: PasswordRules = { ...PASSWORD_RULES_DEFAULT, refuse_common: false };

/** The rules a vault answered with a page it loaded, or a vault from before them. */
export const rulesOrBefore = (r: PasswordRules | null | undefined): PasswordRules =>
  r ? passwordRulesOf(r) : RULES_BEFORE;

/** The line under a password field: the rules, and anything the form says besides. */
export const passwordHint = (rules: PasswordRules, besides?: string): string =>
  besides ? `${passwordRulesWords(rules)} ${besides}` : passwordRulesWords(rules);

/** Whether a password has the length and the mix the rules ask for. */
export const passwordFits = (password: string, rules: PasswordRules): boolean =>
  passwordLacks(password, rules).length === 0;

/** What the password typed still lacks, in words; null once it has it all, or nothing is typed. */
export function passwordStillLacks(password: string, rules: PasswordRules): string | null {
  if (password.length === 0) return null;
  const lacks = passwordLacks(password, rules);
  return lacks.length === 0 ? null : passwordRefusalWords(lacks, rules);
}

/**
 * The household's rules for somebody signed in: as the vault answers them
 * where it has them, a vault from before them's otherwise. Null while they
 * load.
 */
export function useSignedInPasswordRules(caps: Capabilities | null): PasswordRules | null {
  const { authVersion } = useApp();
  const on = caps?.features.password_rules === true;
  const { data, error } = useLoad(
    (t) => (on ? api.passwordRules(t) : Promise.resolve(null)),
    [authVersion, on],
  );
  if (!on) return caps ? RULES_BEFORE : null;
  if (data) return passwordRulesOf(data);
  // Not reached: the vault still holds the password to them, and says so.
  return error ? PASSWORD_RULES_DEFAULT : null;
}

const SWITCHES: ReadonlyArray<{
  key: Exclude<(typeof PASSWORD_RULES_KEYS)[number], 'min_length' | 'refuse_common'>;
  label: string;
}> = [
  { key: 'needs_upper', label: 'An uppercase letter' },
  { key: 'needs_lower', label: 'A lowercase letter' },
  { key: 'needs_number', label: 'A number' },
  { key: 'needs_symbol', label: 'A symbol (a space between words counts)' },
];

const sameRules = (a: PasswordRules, b: PasswordRules) =>
  PASSWORD_RULES_KEYS.every((k) => a[k] === b[k]);

/**
 * Settings → Security: what a sign-in password must be whenever one is set
 * — changed, set from a reset link, or chosen as an invitation is accepted.
 * Passwords already set are not asked again. Chosen, then saved with Save;
 * rules that let in a password the ones before refused ask to confirm it's
 * you first (the vault's `weaken_password_rules`); cancelled, nothing
 * changes. Shown to owners alone.
 */
export function PasswordRulesCard() {
  const { authVersion, guarded } = useApp();
  const loaded = useLoad((t) => api.passwordRules(t), [authVersion]);
  const [picked, setPicked] = useState<PasswordRules | null>(null);
  const [lengthText, setLengthText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const data: PasswordRulesView | null = loaded.data;
  const saved = data ? passwordRulesOf(data) : null;
  const chosen = picked ?? saved;
  const typed = lengthText ?? String(chosen?.min_length ?? PASSWORD_MIN_LENGTH);
  const lengthOk = isPasswordMinLength(Number(typed)) && /^\d+$/.test(typed.trim());
  const unsaved = saved !== null && chosen !== null && !sameRules(saved, chosen);

  const pick = (next: Partial<PasswordRules>) => {
    if (!chosen) return;
    setSaid(null);
    setPicked({ ...chosen, ...next });
  };
  const save = async () => {
    if (busy || !unsaved || !lengthOk || !chosen) return;
    setBusy(true);
    setProblem(null);
    setSaid(null);
    try {
      const next = await guarded((t) => api.setPasswordRules(t, chosen));
      if (!next) return;
      flushSync(() => {
        loaded.setData(next);
        setPicked(null);
        setLengthText(null);
        setSaid(`Saved: ${passwordRulesWords(passwordRulesOf(next))}`);
      });
      status.current?.focus();
    } catch (err) {
      setProblem(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card stack" aria-labelledby="password-rules-h">
      <h2 id="password-rules-h" style={{ fontSize: 18 }}>
        Password rules
      </h2>
      <p className="muted">
        What a password must be whenever one is set: changed, set from a reset link, or chosen as an
        invitation is accepted. Passwords already set keep working. The vault checks common
        passwords against a list it keeps itself: nothing is sent anywhere.
      </p>
      {data === null && loaded.error ? (
        <LoadFailed
          message={loaded.error}
          what="the password rules"
          onRetry={() => void loaded.reload()}
        />
      ) : null}
      {chosen && data && (
        <>
          <div className="field">
            <label htmlFor="password-rules-length">At least this many characters</label>
            <input
              id="password-rules-length"
              type="number"
              inputMode="numeric"
              min={PASSWORD_MIN_LENGTH}
              max={PASSWORD_MIN_LENGTH_CEILING}
              step={1}
              value={typed}
              disabled={busy || !data.can_change}
              aria-invalid={!lengthOk || undefined}
              aria-describedby="password-rules-length-hint"
              onChange={(e) => {
                const v = e.target.value;
                setSaid(null);
                setLengthText(v);
                const n = Number(v);
                if (isPasswordMinLength(n)) setPicked({ ...chosen, min_length: n });
              }}
            />
            <span id="password-rules-length-hint" className={lengthOk ? 'muted' : 'error'}>
              {`From ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MIN_LENGTH_CEILING}. ${PASSWORD_MIN_LENGTH} unless you choose more.`}
            </span>
          </div>
          <div className="check">
            <input
              id="password-rules-common"
              type="checkbox"
              checked={chosen.refuse_common}
              disabled={busy || !data.can_change}
              onChange={(e) => pick({ refuse_common: e.target.checked })}
            />
            <label htmlFor="password-rules-common">
              Refuse common and easily guessed passwords, and a person’s own name or email address
            </label>
          </div>
          <fieldset className="plain password-rules-mix">
            <legend>Must have</legend>
            {SWITCHES.map((s) => (
              <div className="check" key={s.key}>
                <input
                  id={`password-rules-${s.key}`}
                  type="checkbox"
                  checked={chosen[s.key]}
                  disabled={busy || !data.can_change}
                  onChange={(e) => pick({ [s.key]: e.target.checked })}
                />
                <label htmlFor={`password-rules-${s.key}`}>{s.label}</label>
              </div>
            ))}
          </fieldset>
          <p className="muted">
            Shorter, or a rule turned off, asks you to confirm it’s you first.
          </p>
          {data.can_change && (
            <div className="row">
              <Button disabled={busy || !unsaved || !lengthOk} onClick={() => void save()}>
                Save
              </Button>
            </div>
          )}
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
