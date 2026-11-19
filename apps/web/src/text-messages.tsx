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
  SMS_FACTOR_WARNING,
  SMS_MODE_WORDS,
  SMS_MODES,
  SMS_PROVIDER_WORDS,
  SMS_PROVIDERS,
  TWILIO_ACCOUNT_SID,
  TWILIO_MESSAGING_SERVICE_SID,
  E164,
  type Member,
  type MemberPhoneView,
  type SmsMode,
  type SmsProviderKind,
  type SmsSettingsView,
  type SmsTestResult,
} from '@fdv/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from './api.js';
import { describeError, useApp, useLoad } from './app-context.js';
import { dateTimeWords } from './family-time.js';
import { SettingsPage } from './screens/Settings.js';
import { Button, Check, ConfirmDialog, ErrorNote, Field, LoadFailed } from './ui.js';

/**
 * Text messages (0.9.0, SMS1): Settings → Server and reading → Text
 * messages, an owner's; and a person's mobile number on their profile.
 *
 * The vault sends texts through the household's own SMS Gate, an app on a
 * phone the family owns, or (0.9.0-dev.71) through Twilio, a paid service.
 * For SMS Gate an owner chooses how the vault reaches it — the phone itself
 * on the home network (recommended), SMS Gate's cloud relay, or a server of
 * their own — and types its sign-in; for Twilio, the account's SID and Auth
 * Token and a number or Messaging Service to send from. Saved, they send a
 * test to a number: only once a test has gone does the vault send any
 * other text, and a new provider waits for a test of its own.
 */

/**
 * Whether a code can be texted now (0.9.0, SMS3): the vault offers codes by
 * text and the household's texts are set up (GET /sms/status). False until
 * it is known, and when it cannot be asked.
 */
export function useSmsCodes(): boolean {
  const { authVersion, caps } = useApp();
  const offered = caps?.features.sms_codes === true;
  const { data } = useLoad(
    async (t) => (offered ? api.smsStatus(t).catch(() => null) : null),
    [authVersion, offered],
  );
  return offered && data?.ready === true;
}

/**
 * Whether the vault can text a link or a request to whoever it is for now
 * (0.9.0-dev.69; the owner's feedback of 18 Nov 2026): it offers link texts
 * (`features.link_texts`) and the household's texts are set up and tested
 * (GET /sms/status). False until it is known, and when it cannot be asked:
 * the forms then say texts aren't set up, and offer email or Copy instead.
 */
export function useLinkTexts(): boolean {
  const { authVersion, caps } = useApp();
  const offered = caps?.features.link_texts === true;
  const { data } = useLoad(
    async (t) => (offered ? api.smsStatus(t).catch(() => null) : null),
    [authVersion, offered],
  );
  return offered && data?.ready === true;
}

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
    <SettingsPage title="Text messages" subtitle="Texts through SMS Gate or Twilio">
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
        The vault can send texts through SMS Gate for Android, an app on a phone your family owns,
        or through Twilio, a paid service. It texts codes, the alerts and reminders people ask for,
        and links you send.
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

/** A number as typed for Twilio's From, as E.164: "+44 7700 900123" is "+447700900123". */
const fromNumber = (typed: string) => typed.trim().replace(/[\s().-]/g, '');

/**
 * The settings themselves: who sends the texts, and what that provider
 * needs. The password or Auth Token is sent once and kept sealed — never
 * shown again, only whether one is set; left blank, the one set is kept,
 * unless the address or username (SMS Gate) or the Account SID (Twilio)
 * changed, or the provider did.
 */
function SmsForm(props: { view: SmsSettingsView; onSaved: () => Promise<void> }) {
  const { guarded } = useApp();
  const s = props.view.settings;
  // An older vault says no provider: SMS Gate, the only one it had.
  const saved: SmsProviderKind | null = s ? (s.provider ?? 'sms_gate') : null;
  const gate = s && saved === 'sms_gate' ? s : null;
  const tw = saved === 'twilio' ? (s?.twilio ?? null) : null;
  const [provider, setProvider] = useState<SmsProviderKind>('sms_gate');
  const [sid, setSid] = useState('');
  const [token, setToken] = useState('');
  const [sendFrom, setSendFrom] = useState<'number' | 'service'>('number');
  const [fromNum, setFromNum] = useState('');
  const [serviceSid, setServiceSid] = useState('');
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
    setProvider(s?.provider ?? 'sms_gate');
    const t = s?.provider === 'twilio' ? (s.twilio ?? null) : null;
    setSid(t?.account_sid ?? '');
    setToken('');
    setSendFrom(t?.messaging_service_sid ? 'service' : 'number');
    setFromNum(t?.from ?? '');
    setServiceSid(t?.messaging_service_sid ?? '');
    setMode(s?.mode ?? 'local');
    setBaseUrl(s && s.mode && s.mode !== 'cloud' ? (s.base_url ?? '') : '');
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
    gate !== null &&
    gate.password === 'set' &&
    (mode !== gate.mode || address !== gate.base_url || user.trim() !== gate.username);
  const passwordNeeded = (gate === null || gate.password !== 'set' || moved) && password === '';
  // Twilio's token was kept for this Account SID alone.
  const sidMoved = tw !== null && tw.auth_token === 'set' && sid.trim() !== tw.account_sid;
  const tokenNeeded = (tw === null || tw.auth_token !== 'set' || sidMoved) && token === '';
  const switching = s !== null && provider !== saved;
  const changed =
    s === null ||
    switching ||
    country !== s.country ||
    cap !== String(s.monthly_cap) ||
    (provider === 'twilio'
      ? sid !== (tw?.account_sid ?? '') ||
        token !== '' ||
        (sendFrom === 'number'
          ? fromNum !== (tw?.from ?? '') || tw?.messaging_service_sid != null
          : serviceSid !== (tw?.messaging_service_sid ?? '') || tw?.from != null)
      : mode !== s.mode ||
        (mode !== 'cloud' && baseUrl !== s.base_url) ||
        user !== s.username ||
        password !== '');
  const countries = COUNTRIES.includes(country) ? COUNTRIES : [country, ...COUNTRIES];

  /** What a Twilio save says is wrong first, or null. */
  const twilioProblem = (): { words: string; field: string } | null => {
    if (!TWILIO_ACCOUNT_SID.test(sid.trim())) {
      return {
        words:
          'Type the Account SID the Twilio Console shows: AC followed by 32 letters and digits.',
        field: 'sms-twilio-sid',
      };
    }
    if (tokenNeeded) {
      return {
        words: sidMoved
          ? 'Type the Auth Token again for the new Account SID.'
          : 'Type the Auth Token the Twilio Console shows.',
        field: 'sms-twilio-token',
      };
    }
    if (sendFrom === 'number' && !E164.test(fromNumber(fromNum))) {
      return {
        words:
          'Type the number texts come from with its country code, such as +447700900123: one of your Twilio numbers.',
        field: 'sms-twilio-from',
      };
    }
    if (sendFrom === 'service' && !TWILIO_MESSAGING_SERVICE_SID.test(serviceSid.trim())) {
      return {
        words:
          'Type the Messaging Service SID the Twilio Console shows: MG followed by 32 letters and digits.',
        field: 'sms-twilio-service',
      };
    }
    return null;
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const capN = Number(cap);
    if (provider === 'twilio') {
      const wrong = twilioProblem();
      if (wrong) {
        setError(wrong.words);
        document.getElementById(wrong.field)?.focus();
        return;
      }
    } else if (mode !== 'cloud' && !baseUrl.trim()) {
      setError(
        mode === 'local'
          ? 'Type the address the SMS Gate app shows under Local server.'
          : 'Type your server’s address.',
      );
      return;
    }
    if (provider === 'sms_gate' && !user.trim()) {
      setError('Type the username the SMS Gate app shows.');
      return;
    }
    if (provider === 'sms_gate' && passwordNeeded) {
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
        api.setSmsSettings(
          t,
          provider === 'twilio'
            ? {
                provider: 'twilio',
                account_sid: sid.trim(),
                ...(token !== '' ? { auth_token: token } : {}),
                from: sendFrom === 'number' ? fromNumber(fromNum) : null,
                messaging_service_sid: sendFrom === 'service' ? serviceSid.trim() : null,
                country,
                monthly_cap: capN,
              }
            : {
                mode,
                base_url: mode === 'cloud' ? null : baseUrl.trim(),
                username: user.trim(),
                ...(password !== '' ? { password } : {}),
                country,
                monthly_cap: capN,
              },
        ),
      );
      if (done !== null) {
        setPassword('');
        setToken('');
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
        setSaid(
          saved === 'twilio'
            ? 'Removed, with its Auth Token. The vault sends no texts now.'
            : 'Removed, with its password. The vault sends no texts now.',
        );
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
        Set up text messages
      </h2>
      <fieldset className="stack">
        <legend>Who sends the texts</legend>
        {SMS_PROVIDERS.map((p) => (
          <div key={p} className="check check-noted">
            <input
              id={`sms-provider-${p}`}
              type="radio"
              name="sms-provider"
              value={p}
              checked={provider === p}
              aria-describedby={`sms-provider-${p}-note`}
              onChange={() => setProvider(p)}
            />
            <label htmlFor={`sms-provider-${p}`}>{SMS_PROVIDER_WORDS[p].name}</label>
            <p id={`sms-provider-${p}-note`} className="muted check-note">
              {SMS_PROVIDER_WORDS[p].hint}
            </p>
          </div>
        ))}
      </fieldset>
      {switching && (
        <p className="attention attention-warn" role="note" data-testid="sms-switching">
          {provider === 'twilio'
            ? 'Saving switches the vault to Twilio: SMS Gate’s settings and password are forgotten, and no text is sent until a test goes.'
            : 'Saving switches the vault to SMS Gate: Twilio’s settings and Auth Token are forgotten, and no text is sent until a test goes.'}
        </p>
      )}
      {provider === 'twilio' ? (
        <>
          <p className="muted" data-testid="sms-twilio-costs">
            Twilio charges your own Twilio account for every text, at its prices; the vault adds
            nothing and pays for nothing. The most texts in a month, below, keeps the count down.
          </p>
          <Field
            id="sms-twilio-sid"
            label="Account SID"
            value={sid}
            placeholder="AC…"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            note="On the Twilio Console’s front page, under Account Info."
            onChange={setSid}
          />
          <Field
            id="sms-twilio-token"
            label="Auth Token"
            type="password"
            value={token}
            autoComplete="new-password"
            required={false}
            invalid={tokenNeeded && error !== null}
            note={
              sidMoved
                ? 'You changed the Account SID: type its Auth Token. The one saved only ever signs in as the account it was typed for.'
                : tw?.auth_token === 'set'
                  ? 'One is saved, and never shown. Leave this empty to keep it, or type a new one.'
                  : 'Beside the Account SID. It is kept encrypted, and never shown again.'
            }
            onChange={setToken}
          />
          <fieldset className="stack">
            <legend>Texts come from</legend>
            <div className="check">
              <input
                id="sms-from-number"
                type="radio"
                name="sms-from"
                checked={sendFrom === 'number'}
                onChange={() => setSendFrom('number')}
              />
              <label htmlFor="sms-from-number">One of your Twilio numbers</label>
            </div>
            <div className="check">
              <input
                id="sms-from-service"
                type="radio"
                name="sms-from"
                checked={sendFrom === 'service'}
                onChange={() => setSendFrom('service')}
              />
              <label htmlFor="sms-from-service">A Messaging Service</label>
            </div>
          </fieldset>
          {sendFrom === 'number' ? (
            <Field
              id="sms-twilio-from"
              label="From number"
              type="tel"
              value={fromNum}
              placeholder="+447700900123"
              autoComplete="off"
              note="With its country code. It must be able to send texts to your family’s country."
              onChange={setFromNum}
            />
          ) : (
            <Field
              id="sms-twilio-service"
              label="Messaging Service SID"
              value={serviceSid}
              placeholder="MG…"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              note="Under Messaging → Services in the Twilio Console. Twilio picks the number."
              onChange={setServiceSid}
            />
          )}
        </>
      ) : (
        <SmsGateFields
          mode={mode}
          setMode={setMode}
          baseUrl={baseUrl}
          setBaseUrl={setBaseUrl}
          user={user}
          setUser={setUser}
          password={password}
          setPassword={setPassword}
          passwordInvalid={passwordNeeded && error !== null}
          passwordNote={
            moved
              ? 'You changed the address or the username: type the password again for it. The one saved is only ever sent where it was typed for.'
              : gate?.password === 'set'
                ? 'One is saved, and never shown. Leave this empty to keep it, or type a new one.'
                : 'As the SMS Gate app shows it. It is kept encrypted, and never shown again.'
          }
        />
      )}
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
          {saved === 'twilio'
            ? 'The vault forgets Twilio and its Auth Token'
            : 'The vault forgets SMS Gate and its password'}
          , and sends no texts until it is set up again. The family’s mobile numbers are kept.
        </ConfirmDialog>
      )}
    </form>
  );
}

/** SMS Gate's own fields: how the vault reaches it, its address and its sign-in. */
function SmsGateFields(props: {
  mode: SmsMode;
  setMode: (m: SmsMode) => void;
  baseUrl: string;
  setBaseUrl: (v: string) => void;
  user: string;
  setUser: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
  passwordInvalid: boolean;
  passwordNote: string;
}) {
  const { mode, setMode, baseUrl, setBaseUrl, user, setUser, password, setPassword } = props;
  return (
    <>
      <fieldset className="stack">
        <legend>How the vault reaches SMS Gate</legend>
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
        invalid={props.passwordInvalid}
        note={props.passwordNote}
        onChange={setPassword}
      />
    </>
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

/**
 * Codes by text (0.9.0, SMS3), in Your account: whether a reset of the
 * password, and a sign-in, also ask for a code texted to the person's own
 * confirmed number. Each off until they turn it on; turning either on or off
 * is changing how they sign in, so it asks to confirm it's them. A text is
 * the weakest second step, and the card says why in plain words; an owner
 * keeps a passkey or an authenticator app beside it.
 */
export function CodesByTextCard() {
  const { authVersion, guarded, caps, session } = useApp();
  const offered = caps?.features.sms_codes === true;
  const me = session.info?.member_id ?? null;
  const { data, error, reload, setData } = useLoad(
    async (t) => (offered ? api.textCodeSettings(t) : null),
    [authVersion, offered],
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!offered) return null;
  if (data === null && error) {
    return <LoadFailed message={error} what="codes by text" onRetry={() => void reload()} />;
  }
  if (!data) return null;
  const change = async (input: { sign_in?: boolean; reset?: boolean }) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const next = await guarded((t) => api.setTextCodeSettings(t, input));
      if (next) setData(next);
    } catch (err) {
      setProblem(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  // Off and impossible: said why, and where to put it right. On stays
  // changeable, so somebody whose number went can still turn it off.
  const off = (on: boolean) => busy || (!on && !data.can_turn_on);
  return (
    <section aria-labelledby="text-codes-h" className="card stack">
      <h2 id="text-codes-h" style={{ fontSize: 18 }}>
        Codes by text
      </h2>
      <p className="muted">
        {data.phone && data.phone_confirmed
          ? `A code texted to ${data.phone} as well, when you ask for it here.`
          : 'A code texted to your own mobile number as well, when you ask for it here.'}
      </p>
      {data.why_not && (
        <p className="muted" role="note">
          {data.why_not}{' '}
          {data.sms_ready && me && (
            <Link to={`/people/${me}`}>Your mobile number is on your profile.</Link>
          )}
        </p>
      )}
      <Check
        id="text-codes-reset"
        checked={data.reset}
        disabled={off(data.reset)}
        onChange={(on) => void change({ reset: on })}
        label="Ask for a code by text when my password is reset"
        note="Whoever resets it — you, from an emailed link, or an owner’s link — also types the code we text you. If your number isn’t confirmed or texts aren’t working then, the reset goes ahead without it, and your owners are told."
      />
      <Check
        id="text-codes-sign-in"
        checked={data.sign_in}
        disabled={off(data.sign_in)}
        onChange={(on) => void change({ sign_in: on })}
        label="Text me a code when I sign in"
        note={
          data.step_up
            ? 'As well as your password. You can also use a texted code when the vault asks you to confirm it’s you.'
            : 'As well as your password.'
        }
      />
      <p className="status status-warn" role="note">
        {SMS_FACTOR_WARNING}
      </p>
      <ErrorNote message={problem} />
    </section>
  );
}
