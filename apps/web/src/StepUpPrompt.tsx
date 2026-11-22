import { CODE_USED_REASON, FACTOR_STEP_UPS } from '@fdv/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiRequestError } from './api.js';
import { tooManyWords, useApp } from './app-context.js';
import * as passkeys from './passkeys.js';
import { Button, ErrorNote, Field, OnTop, useSheetFocus } from './ui.js';

/**
 * "Confirm it is you" (SEC-17).
 *
 * It appears over whatever the person was doing, takes one credential,
 * and hands control back so the action they asked for goes through by
 * itself. Cancelling is a first-class answer: nothing was done, and
 * nothing is lost. Escape is one too, and the keyboard stays inside it
 * until it is answered, over a sheet as well (5.4).
 *
 * The owner's powers over other people's sign-ins (A54, 5.25) take a
 * passkey or a code from an authenticator app, never the password: for
 * those it offers no password field, and asks for a code instead.
 */
export function StepUpPrompt(props: {
  /** Which action asked (`step_up_required`'s `action`). */
  action?: string;
  message: string;
  /** Only a passkey or a code will do (0.9.0: the refusal said so). */
  factor?: boolean;
  onSettled: (confirmed: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  // A passkey or a code, never the password: the owner's powers, and
  // since 0.9.0 whatever the vault says so of (changing how somebody who
  // has either signs in).
  const factorOnly = props.factor === true || FACTOR_STEP_UPS.includes(props.action ?? '');
  const box = useRef<HTMLElement>(null);
  useSheetFocus(box, { onEscape: () => props.onSettled(false), busy });

  return (
    <OnTop>
      <div className="scrim" role="presentation">
        <section
          ref={box}
          className="card stack sheet"
          role="dialog"
          aria-modal="true"
          aria-labelledby="stepup-h"
        >
          <h2 id="stepup-h" style={{ fontSize: 20 }}>
            Just checking it is you
          </h2>
          <p className="muted">{props.message}</p>
          <ConfirmItsYou
            idPrefix="stepup"
            factorOnly={factorOnly}
            send={(token, body) => api.stepUp(token, body)}
            onBusy={setBusy}
            onConfirmed={() => props.onSettled(true)}
            onLost={() => props.onSettled(false)}
            onCancel={() => props.onSettled(false)}
          />
        </section>
      </div>
    </OnTop>
  );
}

/** A credential given again: one of these. */
export interface Credential {
  password?: string;
  code?: string;
  passkey?: unknown;
  text_code?: string;
}

/**
 * What a refused password or code says: the vault's own words where they say
 * more than "that didn't match" — a code taken already (`code_used`), too
 * many tries just now — and `ours` otherwise.
 */
const refusedSaying = (ours: string) => (err: unknown) =>
  err instanceof ApiRequestError && err.status === 429
    ? // In words of confirming it's you, never of signing in.
      tooManyWords(err.retryAfterSeconds ?? null)
    : err instanceof ApiRequestError && err.reason === CODE_USED_REASON
      ? err.message
      : ours;

/** Which of the forms the last answer was to: its words are said there. */
type Where = 'passkey' | 'password' | 'code' | 'text';

/**
 * The ways to confirm it's you, and one sent: a passkey, the password (never
 * for what takes a passkey or a code), a code from an authenticator app
 * (asked for alone when only that or a passkey will do; beside the password
 * with `codeToo`), and, where the vault offers it, a code by text. Drawn in
 * the step-up's dialog, and on the lock screen (0.9.0-dev.86), whose `send`
 * unlocks.
 */
export function ConfirmItsYou(props: {
  /** The fields' ids start with it: one of these on a page at a time. */
  idPrefix: string;
  factorOnly: boolean;
  /** A code from an authenticator app offered beside the password (the account has one). */
  codeToo?: boolean;
  /** The password field's name; "Or your password" unless said. */
  passwordLabel?: string;
  /** What its buttons say: "Confirm" unless said. Beside the password, the code's says "… with the code". */
  confirmWord?: string;
  /** Sends what was given: confirming it's you, or unlocking. */
  send: (token: string, body: Credential) => Promise<unknown>;
  onBusy?: (busy: boolean) => void;
  onConfirmed: () => void;
  /** No session to send it with. */
  onLost: () => void;
  /** Absent: no Cancel (the lock screen's way out is signing out). */
  onCancel?: () => void;
}) {
  // A wrong password here answers 401 with `invalid_credentials`, which
  // `withToken` now leaves alone — only `session_ended` and
  // `unauthenticated` end a session. Going through the session directly
  // anyway, because this prompt must never be the thing that signs
  // somebody out, whatever the shared helper does later.
  const { session, caps } = useApp();
  const { idPrefix: id, factorOnly } = props;
  const word = props.confirmWord ?? 'Confirm';
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusyNow] = useState(false);
  const setBusy = (on: boolean) => {
    setBusyNow(on);
    props.onBusy?.(on);
  };
  const [error, setError] = useState<{ at: Where; text: string } | null>(null);
  const canUsePasskey = passkeys.supported() && passkeys.secureEnough();
  // A code by text (0.9.0): offered to an adult or a teen who asked
  // for codes by text — never for what takes a passkey or an
  // authenticator's code (FACTOR_STEP_UPS).
  const [textTo, setTextTo] = useState<string | null>(null);
  const [texted, setTexted] = useState<string | null>(null);
  const [textCode, setTextCode] = useState('');
  const asksText = caps?.features.sms_codes === true && !factorOnly;
  useEffect(() => {
    if (!asksText) return;
    let live = true;
    void (async () => {
      const got = await session.token();
      if (got.kind !== 'ok') return;
      const state = await api.stepUpState(got.token).catch(() => null);
      if (live) setTextTo(state?.text_to ?? null);
    })();
    return () => {
      live = false;
    };
  }, [asksText, session]);

  /** Sends what `given` gives; refused, says what `words` makes of it, at `at`. */
  const confirm = async (
    at: Where,
    given: () => Promise<Credential>,
    words: (err: unknown) => string,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const body = await given();
      const got = await session.token();
      if (got.kind !== 'ok') return props.onLost();
      await props.send(got.token, body);
      props.onConfirmed();
    } catch (err) {
      setError({ at, text: words(err) });
    } finally {
      setBusy(false);
    }
  };
  const errorAt = (at: Where) => <ErrorNote message={error?.at === at ? error.text : null} />;

  const textMe = async () => {
    setBusy(true);
    setError(null);
    try {
      const got = await session.token();
      if (got.kind !== 'ok') return props.onLost();
      const sent = await api.stepUpTextCode(got.token);
      setTexted(`We texted a code to ${sent.sent_to}.`);
      setTextCode('');
    } catch (err) {
      setError({
        at: 'text',
        text: err instanceof Error ? err.message : 'The code couldn’t be texted.',
      });
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent, at: Where, body: Credential, words: (err: unknown) => string) => {
    e.preventDefault();
    void confirm(at, async () => body, words);
  };

  const withPasskey = () =>
    void confirm(
      'passkey',
      async () => ({ passkey: await passkeys.assert(await api.passkeyChallenge()) }),
      (err) => passkeys.describe(err),
    );

  const cancel = props.onCancel && (
    <Button kind="quiet" onClick={props.onCancel}>
      Cancel
    </Button>
  );
  const codeForm = (label: string) => (
    <form
      onSubmit={(e) =>
        submit(
          e,
          'code',
          { code: code.replace(/\s+/g, '') },
          refusedSaying("That code didn't match. Try the one your app shows now."),
        )
      }
      className="stack"
    >
      <Field
        id={`${id}-code`}
        label={label}
        value={code}
        onChange={setCode}
        autoComplete="one-time-code"
        inputMode="numeric"
      />
      {errorAt('code')}
      <div className="row">
        <Button type="submit" disabled={busy || code.replace(/\s+/g, '').length < 6}>
          {busy ? 'Checking…' : props.codeToo ? `${word} with the code` : word}
        </Button>
        {factorOnly && cancel}
      </div>
    </form>
  );

  return (
    <>
      {factorOnly && (
        <p className="muted">
          Use your passkey, or a code from your authenticator app. Your password isn’t enough for
          this.
        </p>
      )}
      {canUsePasskey && (
        <Button disabled={busy} onClick={withPasskey}>
          {busy ? 'Waiting for your device…' : 'Use your passkey'}
        </Button>
      )}
      {errorAt('passkey')}
      {texted ? (
        <form
          onSubmit={(e) =>
            submit(e, 'text', { text_code: textCode.replace(/\s+/g, '') }, (err) =>
              err instanceof Error ? err.message : "That code didn't match.",
            )
          }
          className="stack"
        >
          <Field
            id={`${id}-text-code`}
            label="Code from the text"
            value={textCode}
            onChange={setTextCode}
            autoComplete="one-time-code"
            inputMode="numeric"
          />
          <p className="status-line" role="status">
            {texted}
          </p>
          {errorAt('text')}
          <div className="row">
            <Button type="submit" disabled={busy || textCode.replace(/\s+/g, '').length < 6}>
              {busy ? 'Checking…' : word}
            </Button>
            <Button kind="quiet" disabled={busy} onClick={() => void textMe()}>
              Send another code
            </Button>
            {cancel}
          </div>
        </form>
      ) : factorOnly ? (
        codeForm(
          canUsePasskey
            ? 'Or a code from your authenticator app'
            : 'Code from your authenticator app',
        )
      ) : (
        <>
          <form
            onSubmit={(e) =>
              submit(e, 'password', { password }, refusedSaying("That didn't match. Try again."))
            }
            className="stack"
          >
            <Field
              id={`${id}-password`}
              label={props.passwordLabel ?? 'Or your password'}
              type="password"
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
            />
            {textTo && (
              <Button kind="link" disabled={busy} onClick={() => void textMe()}>
                {`Or text me a code at ${textTo}`}
              </Button>
            )}
            {errorAt('password')}
            {errorAt('text')}
            <div className="row">
              <Button type="submit" disabled={busy || !password}>
                {busy ? 'Checking…' : word}
              </Button>
              {cancel}
            </div>
          </form>
          {props.codeToo && codeForm('Or a code from your authenticator app')}
        </>
      )}
    </>
  );
}
