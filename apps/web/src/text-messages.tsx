import {
  PHONE_CODE_DIGITS,
  PHONE_CODE_MINUTES,
  PHONE_CODE_SENT,
  SMS_CAP_MAX,
  SMS_CAP_MIN,
  SMS_CLOUD_URL,
  SMS_CLOUD_WARNING,
  SMS_DEFAULT_CAP,
  SMS_DEFAULT_COUNTRY,
  SMS_MODE_WORDS,
  SMS_MODES,
  type Member,
  type MemberPhoneView,
  type SmsMode,
  type SmsSettingsView,
  type SmsTestResult,
} from '@fdv/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from './api.js';
import { describeError, useApp, useLoad } from './app-context.js';
import { dateTimeWords } from './family-time.js';
import { SettingsPage } from './screens/Settings.js';
import { Button, ConfirmDialog, ErrorNote, Field, LoadFailed } from './ui.js';

/**
 * Text messages (0.9.0, SMS1): Settings → Server and reading → Text
 * messages, an owner's; and a person's mobile number on their profile.
 *
 * The vault sends texts through the household's own SMS Gate, an app on a
 * phone the family owns. An owner chooses how the vault reaches it — the
 * phone itself on the home network (recommended), SMS Gate's cloud relay,
 * or a server of their own — types its sign-in, saves, and sends a test to
 * a number: only once a test has gone does the vault send any other text.
 * For now the only other texts are the codes that confirm a mobile number;
 * reminders by text come later.
 */

/** Countries offered first for numbers typed without +; the one saved is always there too. */
const COUNTRIES = ['GB', 'IE', 'US', 'CA', 'AU', 'NZ', 'FR', 'DE', 'ES', 'IT', 'NL', 'IN', 'PK'];

/** A country's name, as this browser says it: "United Kingdom". */
function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(['en-GB'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** "Working. The last test went 11 November 2026, 14:02", or what is still to do. */
function statusWords(v: SmsSettingsView): string {
  const s = v.settings;
  if (!s) return 'Not set up. Fill in the form, save, then send a test.';
  if (s.status === 'ok') {
    return `Working. The last test went${s.last_verified_at ? ` ${dateTimeWords(s.last_verified_at)}` : ''}.`;
  }
  if (s.status === 'failed') return `Not working: ${s.last_error ?? 'the last test did not go.'}`;
  return 'Saved, not yet tested. Send a test below: no other text is sent until one goes.';
}

export function TextMessagesScreen() {
  return (
    <SettingsPage title="Text messages" subtitle="Texts through your own SMS Gate">
      <TextMessagesPart />
    </SettingsPage>
  );
}

function TextMessagesPart() {
  const { authVersion } = useApp();
  const { data, error, reload, setData } = useLoad((t) => api.smsSettings(t), [authVersion]);
  return (
    <>
      <p className="lede">
        The vault can send texts through SMS Gate for Android, an app on a phone your family owns.
        For now it texts the codes that confirm each person’s mobile number.
      </p>
      {data === null && error ? (
        <LoadFailed message={error} what="text messages" onRetry={() => void reload()} />
      ) : data === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <p
            className={data.ready ? 'attention attention-calm' : 'attention'}
            role="status"
            data-testid="sms-status"
          >
            {statusWords(data)}
          </p>
          <p className="muted">
            {data.sent_this_month} of {data.monthly_cap} texts sent this month.
          </p>
          <SmsForm view={data} onSaved={reload} />
          {data.settings && (
            <SmsTest
              onTested={(r) => {
                setData(r.view);
              }}
            />
          )}
        </>
      )}
    </>
  );
}

/**
 * The settings themselves. The password is sent once and kept sealed —
 * never shown again, only whether one is set; left blank, the one set is
 * kept, unless the address or username changed.
 */
function SmsForm(props: { view: SmsSettingsView; onSaved: () => Promise<void> }) {
  const { guarded } = useApp();
  const s = props.view.settings;
  const [mode, setMode] = useState<SmsMode>('local');
  const [baseUrl, setBaseUrl] = useState('');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [country, setCountry] = useState(SMS_DEFAULT_COUNTRY);
  const [cap, setCap] = useState(String(SMS_DEFAULT_CAP));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const line = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    // The form starts from what the vault has, each time it is loaded.
    /* eslint-disable react-hooks/set-state-in-effect */
    setMode(s?.mode ?? 'local');
    setBaseUrl(s && s.mode !== 'cloud' ? s.base_url : '');
    setUser(s?.username ?? '');
    setPassword('');
    setCountry(s?.country ?? SMS_DEFAULT_COUNTRY);
    setCap(String(s?.monthly_cap ?? SMS_DEFAULT_CAP));
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [s]);
  useEffect(() => {
    if (said) line.current?.focus();
  }, [said]);

  const address = mode === 'cloud' ? SMS_CLOUD_URL : baseUrl.trim().replace(/\/+$/, '');
  // The password was kept for this mode, address and username alone: any of
  // them changed, it is typed again.
  const moved =
    s !== null &&
    s.password === 'set' &&
    (mode !== s.mode || address !== s.base_url || user.trim() !== s.username);
  const passwordNeeded = (s === null || s.password !== 'set' || moved) && password === '';
  const changed =
    s === null ||
    mode !== s.mode ||
    (mode !== 'cloud' && baseUrl !== s.base_url) ||
    user !== s.username ||
    password !== '' ||
    country !== s.country ||
    cap !== String(s.monthly_cap);
  const countries = COUNTRIES.includes(country) ? COUNTRIES : [country, ...COUNTRIES];

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const capN = Number(cap);
    if (mode !== 'cloud' && !baseUrl.trim()) {
      setError(
        mode === 'local'
          ? 'Type the address the SMS Gate app shows under Local server.'
          : 'Type your server’s address.',
      );
      return;
    }
    if (!user.trim()) {
      setError('Type the username the SMS Gate app shows.');
      return;
    }
    if (passwordNeeded) {
      setError(
        moved
          ? 'Type the password again for the new address or username.'
          : 'Type the password the SMS Gate app shows.',
      );
      document.getElementById('sms-password')?.focus();
      return;
    }
    if (!Number.isInteger(capN) || capN < SMS_CAP_MIN || capN > SMS_CAP_MAX) {
      setError(`The most texts in a month is a number from ${SMS_CAP_MIN} to ${SMS_CAP_MAX}.`);
      return;
    }
    setBusy(true);
    setError(null);
    setSaid(null);
    try {
      const done = await guarded((t) =>
        api.setSmsSettings(t, {
          mode,
          base_url: mode === 'cloud' ? null : baseUrl.trim(),
          username: user.trim(),
          ...(password !== '' ? { password } : {}),
          country,
          monthly_cap: capN,
        }),
      );
      if (done !== null) {
        setPassword('');
        await props.onSaved();
        setSaid(
          done.ready
            ? 'Saved. Texts are still on.'
            : 'Saved. Now send a test: no text is sent until one goes.',
        );
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const done = await guarded((t) => api.removeSmsSettings(t));
      setAsking(false);
      if (done !== null) {
        await props.onSaved();
        setSaid('Removed, with its password. The vault sends no texts now.');
      }
    } catch (err) {
      setAsking(false);
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={(e) => void save(e)} aria-labelledby="sms-set-h" noValidate>
      <h2 id="sms-set-h" className="section-h">
        Set up SMS Gate
      </h2>
      <fieldset className="stack">
        <legend>How the vault reaches it</legend>
        {SMS_MODES.map((m) => (
          <div key={m} className="check check-noted">
            <input
              id={`sms-mode-${m}`}
              type="radio"
              name="sms-mode"
              value={m}
              checked={mode === m}
              aria-describedby={`sms-mode-${m}-note`}
              onChange={() => setMode(m)}
            />
            <label htmlFor={`sms-mode-${m}`}>
              {m === 'local' ? `${SMS_MODE_WORDS[m].name} — recommended` : SMS_MODE_WORDS[m].name}
            </label>
            <p id={`sms-mode-${m}-note`} className="muted check-note">
              {m === 'cloud'
                ? 'Through SMS Gate’s own relay on the internet.'
                : SMS_MODE_WORDS[m].hint}
            </p>
          </div>
        ))}
      </fieldset>
      {mode === 'cloud' && (
        <p className="attention attention-warn" role="note">
          {SMS_CLOUD_WARNING}
        </p>
      )}
      {mode === 'cloud' ? (
        <p className="muted">
          The vault sends through <code>{SMS_CLOUD_URL}</code>.
        </p>
      ) : (
        <Field
          id="sms-base-url"
          label="Address"
          value={baseUrl}
          placeholder={
            mode === 'local' ? 'http://192.168.1.20:8080' : 'https://sms.example.com/3rdparty/v1'
          }
          autoCapitalize="off"
          autoCorrect="off"
          onChange={setBaseUrl}
        />
      )}
      <Field
        id="sms-user"
        label="Username"
        value={user}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        onChange={setUser}
      />
      <Field
        id="sms-password"
        label="Password"
        type="password"
        value={password}
        autoComplete="new-password"
        required={false}
        invalid={passwordNeeded && error !== null}
        note={
          moved
            ? 'You changed the address or the username: type the password again for it. The one saved is only ever sent where it was typed for.'
            : s?.password === 'set'
              ? 'One is saved, and never shown. Leave this empty to keep it, or type a new one.'
              : 'As the SMS Gate app shows it. It is kept encrypted, and never shown again.'
        }
        onChange={setPassword}
      />
      <div className="field">
        <label htmlFor="sms-country">Country of your numbers</label>
        <select
          id="sms-country"
          value={country}
          aria-describedby="sms-country-note"
          onChange={(e) => setCountry(e.target.value)}
        >
          {countries.map((c) => (
            <option key={c} value={c}>
              {countryName(c)}
            </option>
          ))}
        </select>
        <p id="sms-country-note" className="muted field-note">
          A number typed without + is read as one from here.
        </p>
      </div>
      <Field
        id="sms-cap"
        label="Most texts in a month"
        value={cap}
        inputMode="numeric"
        note="The vault sends no more than this in a calendar month, whatever asks."
        onChange={setCap}
      />
      <ErrorNote message={error} />
      <div className="row">
        <Button kind="primary" type="submit" disabled={busy || !changed}>
          Save
        </Button>
        {s && (
          <Button kind="quiet" danger disabled={busy} onClick={() => setAsking(true)}>
            Turn off text messages
          </Button>
        )}
      </div>
      <p ref={line} className="status-line" role="status" tabIndex={-1}>
        {said}
      </p>
      {asking && (
        <ConfirmDialog
          title="Turn off text messages?"
          confirmLabel="Turn off"
          busyLabel="Turning off…"
          danger
          busy={busy}
          onConfirm={() => void remove()}
          onCancel={() => setAsking(false)}
        >
          The vault forgets SMS Gate and its password, and sends no texts until it is set up again.
          The family’s mobile numbers are kept.
        </ConfirmDialog>
      )}
    </form>
  );
}

/** "Send a test": it must go before the vault sends any other text. */
function SmsTest(props: { onTested: (r: SmsTestResult) => void }) {
  const { withToken } = useApp();
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SmsTestResult | null>(null);
  const line = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (result) line.current?.focus();
  }, [result]);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!number.trim()) {
      setError('Type the mobile number to send the test to.');
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await withToken((t) => api.testSms(t, number.trim()));
      if (r) {
        setResult(r);
        props.onTested(r);
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack" onSubmit={(e) => void send(e)} aria-labelledby="sms-test-h" noValidate>
      <h2 id="sms-test-h" className="section-h">
        Send a test
      </h2>
      <Field
        id="sms-test-number"
        label="Mobile number"
        type="tel"
        value={number}
        autoComplete="tel"
        note="Your own, say. The test says only that it is a test from your vault."
        onChange={setNumber}
      />
      <ErrorNote message={error} />
      <div className="row">
        <Button kind="primary" type="submit" disabled={busy}>
          {busy ? 'Sending… (up to 20 seconds)' : 'Send a test'}
        </Button>
      </div>
      <p
        ref={line}
        className={result ? (result.ok ? 'attention attention-calm' : 'attention') : 'status-line'}
        role="status"
        tabIndex={-1}
      >
        {result?.words}
      </p>
    </form>
  );
}

/**
 * A person's mobile number, on their profile (SMS1): for themselves, and for
 * an owner — who adds one for somebody without a sign-in. Saved, a code is
 * texted to it; typed back, the number is confirmed. Removing it asks first.
 * Shown only once texts are set up; an owner is told where to set them up.
 */
export function MobileNumberCard(props: { member: Member; name: string; owner: boolean }) {
  const { authVersion, withToken, caps } = useApp();
  const offered = caps?.features.sms_texts === true && (props.member.is_me || props.owner);
  const { data, error, reload, setData } = useLoad(
    async (t) => (offered ? api.memberPhone(t, props.member.id) : null),
    [authVersion, props.member.id, offered],
  );
  const [number, setNumber] = useState('');
  const [code, setCode] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const line = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (said) line.current?.focus();
  }, [said]);
  if (!offered) return null;
  if (data === null && error) {
    return <LoadFailed message={error} what="the mobile number" onRetry={() => void reload()} />;
  }
  if (!data) return null;
  if (!data.sms_ready && !data.phone) {
    return props.owner ? (
      <section aria-labelledby="mobile-h" className="stack">
        <h2 id="mobile-h" className="section-h">
          Mobile number
        </h2>
        <p className="muted">
          Text messages aren’t set up yet.{' '}
          <Link to="/settings/texts">Set up text messages in Settings</Link>, then add a number
          here.
        </p>
      </section>
    ) : null;
  }

  const whose = props.member.is_me ? 'your' : `${props.name}’s`;
  const run = async (fn: (t: string) => Promise<MemberPhoneView>, after: string | null) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    setSaid(null);
    try {
      const v = await withToken(fn);
      if (v) {
        setData(v);
        setSaid(after);
      }
      return v;
    } catch (err) {
      setProblem(describeError(err));
      return null;
    } finally {
      setBusy(false);
    }
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!number.trim()) {
      setProblem('Type the mobile number.');
      return;
    }
    const v = await run((t) => api.setMemberPhone(t, props.member.id, number.trim()), null);
    if (v) {
      setNumber('');
      setEditing(false);
      setSaid(v.phone?.confirmed ? 'That number is confirmed already.' : PHONE_CODE_SENT);
    }
  };
  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim()) {
      setProblem(`Type the ${PHONE_CODE_DIGITS}-digit code from the text.`);
      return;
    }
    const v = await run(
      (t) => api.confirmMemberPhone(t, props.member.id, code.trim()),
      'Confirmed. The vault can text this number.',
    );
    if (v) setCode('');
  };
  const phone = data.phone;
  const waiting = phone !== null && !phone.confirmed;
  return (
    <section aria-labelledby="mobile-h" className="stack">
      <h2 id="mobile-h" className="section-h">
        Mobile number
      </h2>
      {phone && !editing && (
        <p>
          <span data-testid="mobile-masked">{phone.masked}</span>{' '}
          <span className={phone.confirmed ? 'muted' : 'attention-inline'}>
            {phone.confirmed ? '· Confirmed' : '· Not confirmed yet'}
          </span>
        </p>
      )}
      {waiting && !editing && (
        <form className="stack" onSubmit={(e) => void confirm(e)} noValidate>
          <Field
            id="mobile-code"
            label="Code from the text"
            value={code}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={12}
            note={`Six digits, sent to ${phone.masked}. It works for ${PHONE_CODE_MINUTES} minutes.`}
            onChange={setCode}
          />
          <div className="row">
            <Button kind="primary" type="submit" disabled={busy}>
              Confirm
            </Button>
            <Button
              kind="quiet"
              disabled={busy || !data.sms_ready}
              onClick={() =>
                void run(
                  (t) => api.resendMemberPhoneCode(t, props.member.id),
                  `A new code is on its way. ${PHONE_CODE_SENT}`,
                )
              }
            >
              Send a new code
            </Button>
          </div>
        </form>
      )}
      {(!phone || editing) && data.sms_ready && (
        <form className="stack" onSubmit={(e) => void save(e)} noValidate>
          <Field
            id="mobile-number"
            label={phone ? 'New mobile number' : 'Mobile number'}
            type="tel"
            value={number}
            autoComplete={props.member.is_me ? 'tel' : 'off'}
            note="We text a code to it, to make sure it is the right number."
            onChange={setNumber}
          />
          <div className="row">
            <Button kind="primary" type="submit" disabled={busy}>
              {phone ? 'Change the number' : 'Add the number'}
            </Button>
            {editing && (
              <Button kind="quiet" disabled={busy} onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      )}
      {phone && !editing && (
        <div className="row">
          {data.sms_ready && (
            <Button kind="quiet" disabled={busy} onClick={() => setEditing(true)}>
              Change
            </Button>
          )}
          <Button kind="quiet" danger disabled={busy} onClick={() => setAsking(true)}>
            Remove
          </Button>
        </div>
      )}
      <ErrorNote message={problem} />
      <p ref={line} className="status-line" role="status" tabIndex={-1}>
        {said}
      </p>
      {asking && (
        <ConfirmDialog
          title={
            props.member.is_me ? 'Remove your mobile number?' : `Remove ${whose} mobile number?`
          }
          confirmLabel="Remove"
          busyLabel="Removing…"
          danger
          busy={busy}
          onConfirm={() =>
            void run((t) => api.removeMemberPhone(t, props.member.id), 'Removed.').then(() =>
              setAsking(false),
            )
          }
          onCancel={() => setAsking(false)}
        >
          The vault won’t be able to text {props.member.is_me ? 'you' : props.name} until a number
          is added and confirmed again.
        </ConfirmDialog>
      )}
    </section>
  );
}
