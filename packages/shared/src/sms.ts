import {
  isSupportedCountry,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js/min';
import { namesService } from './ai-reader.js';
import { isLinkLocalAddress, isLoopbackAddress, isLoopbackName } from './push.js';

/**
 * Text messages (0.9.0, SMS1): the household's own SMS Gate for Android
 * (sms-gate.app), an app on a phone the family owns that sends texts for
 * whoever asks it over HTTP, and each person's mobile number, confirmed by
 * a code texted to it.
 *
 * An owner sets SMS Gate up in Settings — on the home network (`local`,
 * recommended), through SMS Gate's cloud relay (`cloud`), or through a
 * server of the family's own (`private`) — and sends a test. Only once a
 * test has gone does the vault send any other text, and never more in a
 * calendar month than the owners allow.
 *
 * Notifications by text (SMS2): each person may ask for the day's reminders,
 * the security alerts, and news of a link they shared being opened, by
 * text — each off until they turn it on, only ever to their own confirmed
 * number, and never in their quiet hours unless it is about their own
 * account's safety. A text never names a document: a count, or a headline.
 *
 * Since 0.9.0-dev.71 an owner may choose Twilio instead of SMS Gate: one
 * provider at a time, tested before it sends, as SMS Gate is.
 */

/**
 * Who sends the household's texts (0.9.0-dev.71): SMS Gate for Android, a
 * phone the family owns, or Twilio, a paid service on the internet. One at
 * a time; another provider (Vonage, MessageBird, Plivo) would be a new
 * value here and a new `SmsProvider` behind it.
 */
export type SmsProviderKind = 'sms_gate' | 'twilio';
export const SMS_PROVIDERS: readonly SmsProviderKind[] = ['sms_gate', 'twilio'];

/** Each provider, as Settings offers it. */
export const SMS_PROVIDER_WORDS: Record<SmsProviderKind, { name: string; hint: string }> = {
  sms_gate: {
    name: 'SMS Gate for Android',
    hint: 'An app on a phone your family owns sends the texts, on that phone’s own plan.',
  },
  twilio: {
    name: 'Twilio',
    hint: 'A paid service on the internet sends the texts. Twilio charges your own account for each one.',
  },
};

/** How the vault reaches SMS Gate. */
export type SmsMode = 'local' | 'cloud' | 'private';
export const SMS_MODES: readonly SmsMode[] = ['local', 'cloud', 'private'];

/** How a text goes: SMS Gate's way of being reached, or Twilio. For the words said of a problem. */
export type SmsVia = SmsMode | 'twilio';

/**
 * The ports SMS Gate's local server may be reached on unless the operator
 * says others (FDV_SMS_GATE_ALLOWED_PORTS, 0.9.0-dev.77): the app's own
 * 8080, the usual web ports, and the few a phone's server or a proxy in
 * front of it commonly uses — so a test is no port scanner of the home
 * network. This, not the names below, is what keeps the vault's own
 * services out: their ports (5432, 3000) are not on it.
 */
export const SMS_GATE_LOCAL_PORTS: readonly number[] = [8080, 80, 443, 8000, 8443, 8888];

/**
 * The vault's own services, as its compose files name them: never SMS
 * Gate, whose requests carry its username and password. Best effort, by
 * name alone — the name, its first label (`api.fdv_default`), or compose's
 * container name (`fdv-api-1`, `fdv-api-1.lan`); an address that happens
 * to be a container's is not found out (the port list above is what
 * holds).
 */
export const SMS_GATE_REFUSED_NAMES: readonly string[] = [
  'postgres',
  'migrate',
  'api',
  'worker',
  'web',
  'ollama',
  'caddy',
  'caddy-public',
];

/** Names Docker and Podman give the machine a container runs on: never SMS Gate. */
const HOST_NAMES = /(^|\.)(docker|containers)\.internal$/;

/** The WHATWG URL parser, as Node and the browsers have it (this package names no runtime). */
declare const URL: new (input: string) => { protocol: string; hostname: string; port: string };

/**
 * Why the local server's address is refused, without DNS; null when it may
 * be tried. The home network is its purpose, so a private address is fine;
 * but never this machine (loopback, by name or address), a link-local or
 * cloud-metadata address, the machine a container runs on
 * (`host.docker.internal`), the vault's own services by name (`own`), or a
 * port not on `ports` (`port`; SMS_GATE_LOCAL_PORTS unless the operator
 * said others). An address that is not a URL is refused as `own`.
 */
export function smsGateLocalRefused(
  baseUrl: string,
  ports: readonly number[] = SMS_GATE_LOCAL_PORTS,
): 'own' | 'port' | null {
  let url: InstanceType<typeof URL>;
  try {
    url = new URL(baseUrl);
  } catch {
    return 'own';
  }
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  const first = host.split('.')[0] ?? '';
  if (
    !host ||
    isLoopbackName(host) ||
    HOST_NAMES.test(host) ||
    namesService(host, SMS_GATE_REFUSED_NAMES) ||
    namesService(first, SMS_GATE_REFUSED_NAMES)
  ) {
    return 'own';
  }
  if (smsGateLocalAddressRefused(host)) return 'own';
  return ports.includes(smsGatePort(baseUrl) ?? 0) ? null : 'port';
}

/** The port an address is reached on, said or by its scheme; null when it is not a URL. */
export function smsGatePort(baseUrl: string): number | null {
  try {
    const url = new URL(baseUrl);
    return url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  } catch {
    return null;
  }
}

/**
 * What an owner is told of a local server on a port the vault does not
 * reach it on: the port, and the setting that allows others. Not a probe's
 * answer (nothing was asked of the network), so it is said as it is.
 */
export function smsGatePortWords(port: number | null | undefined): string {
  return `The vault doesn’t reach SMS Gate’s local server on port ${port ?? 'that'}. Use port 8080, SMS Gate’s own, in the app’s Local server settings, and type the address again; or whoever runs this server can allow the port with FDV_SMS_GATE_ALLOWED_PORTS.`;
}

/**
 * Whether the local server may not be reached at this address, as typed or
 * as DNS gave it: loopback, link-local and cloud metadata, "this network",
 * multicast. A name (not an address) is judged elsewhere: false.
 */
export function smsGateLocalAddressRefused(address: string): boolean {
  const a = address.toLowerCase().replace(/^\[|\]$/g, '');
  const literal = /^\d{1,3}(\.\d{1,3}){3}$/.test(a) || a.includes(':');
  return literal && (isLoopbackAddress(a) || isLinkLocalAddress(a));
}

/** A Twilio Account SID: AC and 32 hex digits. */
export const TWILIO_ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;
/** A Twilio Messaging Service SID: MG and 32 hex digits. */
export const TWILIO_MESSAGING_SERVICE_SID = /^MG[0-9a-fA-F]{32}$/;
/** Where Twilio's API is. Only a test points the vault anywhere else. */
export const TWILIO_API_URL = 'https://api.twilio.com';

/** Whether a test text has gone since the settings were last saved: only `ok` sends. */
export type SmsStatus = 'untested' | 'ok' | 'failed';

/** What became of a text, as its provider last said; `not_sent`: the provider never took it. */
export type SmsState = 'pending' | 'processed' | 'sent' | 'delivered' | 'failed' | 'not_sent';

/**
 * Why a text was sent: a test, a code, a number changed (SMS1); since
 * notifications by text (SMS2) the day's reminders, an alert, and a link
 * that was opened; and since codes by text (SMS3) a share link's code, an
 * invitation's, and a code to somebody's own number for a reset, a sign-in
 * or a step-up.
 */
export type SmsKind =
  | 'test'
  | 'phone_code'
  | 'phone_changed'
  | 'reminders'
  | 'alert'
  | 'share_opened'
  | 'share_code'
  | 'invite_code'
  | 'reset_code'
  | 'sign_in_code'
  | 'step_up_code'
  // 0.9.0-dev.69: a share link, or a request to send documents, texted to
  // whoever it is for.
  | 'share_link'
  | 'request_link';

/** SMS Gate's cloud relay: the one address of `cloud`. */
export const SMS_CLOUD_URL = 'https://api.sms-gate.app/3rdparty/v1';

/** What an owner is told of the cloud relay, beside its choice. */
export const SMS_CLOUD_WARNING =
  'The SMS Gate relay sees each text. Family Vault never puts a document’s details in one, but choose the local server if you can.';

/** Each mode, as Settings offers it. */
export const SMS_MODE_WORDS: Record<SmsMode, { name: string; hint: string }> = {
  local: {
    name: 'Local server on your network',
    hint: 'Recommended. The address the SMS Gate app shows under Local server, such as http://192.168.1.20:8080.',
  },
  cloud: {
    name: 'SMS Gate cloud',
    hint: SMS_CLOUD_WARNING,
  },
  private: {
    name: 'Your own server',
    hint: 'The https address of your own SMS Gate server, ending in /3rdparty/v1.',
  },
};

/** The most texts in a calendar month, unless an owner says otherwise; and the bounds. */
export const SMS_DEFAULT_CAP = 200;
export const SMS_CAP_MIN = 1;
export const SMS_CAP_MAX = 100_000;

/** Where a number typed without + is, until an owner says. */
export const SMS_DEFAULT_COUNTRY = 'GB';

/** How long the vault waits for a test text to be sent before it says it was not. */
export const SMS_TEST_WAIT_SECONDS = 20;

/** The test text: nothing of the family's in it. */
export const SMS_TEST_TEXT = 'Family Vault: this is a test text from your vault.';

/** A code to confirm a number: six digits, good for 10 minutes and 5 tries, and used once. */
export const PHONE_CODE_DIGITS = 6;
export const PHONE_CODE_MINUTES = 10;
export const PHONE_CODE_TRIES = 5;
/** At most 3 codes a number in any 15 minutes, and 10 in a day. */
export const PHONE_CODE_SENDS = { perWindow: 3, windowMinutes: 15, perDay: 10 } as const;

/** The first word of somebody's name, as a text says it. */
export function firstName(displayName: string): string {
  const first = displayName.trim().split(/\s+/)[0];
  return first || 'somebody';
}

/**
 * The text that carries a code. Never a link: whoever reads it types the
 * code where they asked for it.
 */
export function phoneCodeText(code: string, name: string): string {
  return `Family Vault code: ${code}. It confirms this number for ${firstName(name)}. It ends in ${PHONE_CODE_MINUTES} minutes.`;
}

/** The text a confirmed number is sent when somebody's number is changed. */
export function phoneChangedText(name: string): string {
  return `Family Vault: the mobile number for ${firstName(name)} was changed.`;
}

/** A number as E.164: +, then 7 to 15 digits, the first not 0. */
export const E164 = /^\+[1-9][0-9]{6,14}$/;

/** A country as ISO 3166-1 alpha-2, in capitals. */
export const COUNTRY = /^[A-Z]{2}$/;

/** Whether a country (ISO 3166-1 alpha-2, in capitals) has phone numbers the vault can read. */
export function isPhoneCountry(country: string): boolean {
  return COUNTRY.test(country) && isSupportedCountry(country);
}

/**
 * A number as somebody typed it, as E.164 — "07700 900123" in the UK is
 * "+447700900123" — or null when it cannot be a phone number. A number
 * without + is read as one in `country`. Whether it is a mobile, and its
 * owner's, only its code can tell.
 */
export function parsePhone(typed: string, country: string = SMS_DEFAULT_COUNTRY): string | null {
  const text = typed.trim();
  if (!text || text.length > 40 || !/^[+0-9 ()\-.]+$/.test(text)) return null;
  const region = isPhoneCountry(country) ? (country as CountryCode) : undefined;
  let parsed;
  try {
    parsed = parsePhoneNumberFromString(text, region ? { defaultCountry: region } : {});
  } catch {
    return null;
  }
  if (!parsed || !parsed.isPossible()) return null;
  const e164 = parsed.number;
  return E164.test(e164) ? e164 : null;
}

/** The last three digits of a number: all the vault keeps of a text's. */
export function phoneTail(e164: string): string {
  return e164.replace(/\D/g, '').slice(-3).padStart(3, '0');
}

/** A number as it is shown: "•••• •••123". */
export function maskPhone(e164: string): string {
  return `•••• •••${phoneTail(e164)}`;
}

/**
 * The household's texts, as an owner sees them: never a password or a
 * token, only whether one is set. Since 0.9.0-dev.71 `provider` says who
 * sends them; for Twilio `mode`, `base_url` and `username` are null and
 * `password` is `not_set`, and `twilio` says the rest.
 */
export interface SmsSettings {
  /** Absent from vaults before 0.9.0-dev.71, which have SMS Gate alone: read absent as `sms_gate`. */
  provider?: SmsProviderKind;
  /** SMS Gate's: null for Twilio. */
  mode: SmsMode | null;
  base_url: string | null;
  username: string | null;
  /** SMS Gate's password. */
  password: 'set' | 'not_set';
  /** Twilio's settings, while Twilio sends the texts; null for SMS Gate, absent from older vaults. */
  twilio?: TwilioSettings | null;
  country: string;
  monthly_cap: number;
  status: SmsStatus;
  last_verified_at: string | null;
  /** Why the last test failed, in plain words. */
  last_error: string | null;
  updated_at: string;
}

/** GET /sms/settings (owners). */
export interface SmsSettingsView {
  /** Null until an owner sets it up. */
  settings: SmsSettings | null;
  /** Whether the vault sends texts now: set up, and a test passed. */
  ready: boolean;
  /** Texts sent this calendar month, on the family's clock, and the most it allows. */
  sent_this_month: number;
  monthly_cap: number;
  /** The relay's address, for `cloud`. */
  cloud_url: string;
}

/** Twilio, as an owner set it up: never the Auth Token, only whether one is set. */
export interface TwilioSettings {
  account_sid: string;
  auth_token: 'set' | 'not_set';
  /** The number texts come from (E.164), or null when a Messaging Service sends them. */
  from: string | null;
  /** The Messaging Service that sends them (MG…), or null when `from` does. */
  messaging_service_sid: string | null;
}

/**
 * PUT /sms/settings for SMS Gate: the password left out keeps the one set
 * (unless the address or sign-in changed). `provider` may be left out.
 */
export interface SmsGateSettingsInput {
  provider?: 'sms_gate' | undefined;
  mode: SmsMode;
  /** Ignored for `cloud`. */
  base_url?: string | null | undefined;
  username: string;
  password?: string | undefined;
  country: string;
  monthly_cap: number;
}

/**
 * PUT /sms/settings for Twilio (0.9.0-dev.71): the Auth Token left out
 * keeps the one set, unless the Account SID changed. Exactly one of `from`
 * and `messaging_service_sid`.
 */
export interface TwilioSettingsInput {
  provider: 'twilio';
  account_sid: string;
  auth_token?: string | undefined;
  from?: string | null | undefined;
  messaging_service_sid?: string | null | undefined;
  country: string;
  monthly_cap: number;
}

/** PUT /sms/settings. */
export type SmsSettingsInput = SmsGateSettingsInput | TwilioSettingsInput;

/** POST /sms/settings/test. */
export interface SmsTestInput {
  /** Where the test goes, as typed: read in the settings' country without +. */
  number: string;
}

/** What a test found, and the settings after it. */
export interface SmsTestResult {
  ok: boolean;
  /** What became of the text, as SMS Gate last said. */
  state: SmsState;
  /** In plain words. */
  words: string;
  view: SmsSettingsView;
}

/** GET /sms/status (anybody signed in): whether to offer a mobile number. */
export interface SmsStatusView {
  ready: boolean;
}

/** GET /members/{id}/phone: somebody's mobile number, masked, and how it stands. */
export interface MemberPhoneView {
  /** Null when there is none. */
  phone: {
    /** "•••• •••123". */
    masked: string;
    confirmed: boolean;
    confirmed_at: string | null;
    /** While a code sent to it is still good: until when. */
    code_expires_at: string | null;
    updated_at: string;
  } | null;
  /** Whether the vault can text a code now (`GET /sms/status`). */
  sms_ready: boolean;
}

/** PUT /members/{id}/phone. */
export interface MemberPhoneInput {
  number: string;
}

/** POST /members/{id}/phone/confirm. */
export interface MemberPhoneConfirmInput {
  code: string;
}

/** Said when a number is saved and its code texted. */
export const PHONE_CODE_SENT = `We texted a ${PHONE_CODE_DIGITS}-digit code to that number. Type it here within ${PHONE_CODE_MINUTES} minutes.`;

// ------------------------------------------------- notifications by text

/** "21:00": a time of day on the family's clock, as quiet hours are said. */
export const CLOCK_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** Quiet hours until somebody chooses their own: nine in the evening to eight in the morning. */
export const QUIET_FROM_DEFAULT = '21:00';
export const QUIET_TO_DEFAULT = '08:00';

/** "21:00" (or the database's "21:00:00") as minutes since midnight. */
export function minuteOfDay(time: string): number {
  const [h, m] = time.split(':');
  return (Number(h) % 24) * 60 + (Number(m) % 60);
}

/** A time as the wire says it: "21:00", whatever the database gave ("21:00:00"). */
export function clockTime(time: string): string {
  return time.slice(0, 5);
}

/**
 * Whether a minute of the day falls in quiet hours from `from` until `to`,
 * which may run past midnight (21:00 to 08:00). The same time for both is
 * no quiet hours at all.
 */
export function inQuietHours(minute: number, from: string, to: string): boolean {
  const f = minuteOfDay(from);
  const t = minuteOfDay(to);
  if (f === t) return false;
  return f < t ? minute >= f && minute < t : minute >= f || minute < t;
}

/** The minute of the day it is on the family's clock, 0–1439. */
export function localMinute(timezone: string, now = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
    return (get('hour') % 24) * 60 + get('minute');
  } catch {
    return now.getUTCHours() * 60 + now.getUTCMinutes();
  }
}

/**
 * When somebody's quiet hours end, as an instant, if it is quiet for them
 * now on the family's clock; null when it is not. Across a change of the
 * clocks the end is put right once, so 08:00 is 08:00 on the day it falls.
 */
export function quietHoursEnd(
  timezone: string,
  from: string,
  to: string,
  now = new Date(),
): Date | null {
  const minute = localMinute(timezone, now);
  if (!inQuietHours(minute, from, to)) return null;
  const end = minuteOfDay(to);
  const ahead = (end - minute + 1440) % 1440 || 1440;
  // To the start of the minute, then the minutes ahead.
  const base = now.getTime() - (now.getTime() % 60_000);
  let at = new Date(base + ahead * 60_000);
  const off = localMinute(timezone, at) - end;
  if (off !== 0 && Math.abs(off) <= 120) at = new Date(at.getTime() - off * 60_000);
  return at;
}

/**
 * The day's reminders by text: how many, and nothing else of them — never
 * a title, a person or a date. "Things" when one is not a document (a
 * person who has turned 13).
 */
export function remindersText(count: number, allDocuments = true): string {
  const noun = allDocuments ? 'document' : 'thing';
  return count === 1
    ? `Family Vault: 1 ${noun} needs attention today. Open the app to see it.`
    : `Family Vault: ${count} ${noun}s need attention today. Open the app to see them.`;
}

/**
 * What an alert says by text, as a word: its plain headline is chosen by
 * it, never made from its email's subject (which may name people). A link
 * is never in one, nor a code.
 *
 * `urgent`: about the person's own sign-in — a new device, their password,
 * a lock, who owns the vault — and sent in their quiet hours too. The rest
 * wait until the quiet hours end.
 */
export type AlertTextKind =
  | 'new_device'
  | 'computer_added'
  | 'password_changed'
  | 'reset_started'
  | 'locked'
  | 'unlocked'
  | 'signed_out'
  | 'owner_change'
  // 0.9.0: failed tries at signing in to their account, and signing in waits.
  | 'sign_in_tries'
  | 'news';

export const ALERT_TEXTS: Record<AlertTextKind, { text: string; urgent: boolean }> = {
  new_device: {
    text: 'Family Vault: a new device signed in to your account.',
    urgent: true,
  },
  computer_added: {
    text: 'Family Vault: a computer was added to your sign-in.',
    urgent: true,
  },
  password_changed: {
    text: 'Family Vault: your password was changed.',
    urgent: true,
  },
  reset_started: {
    text: 'Family Vault: a password reset was started for your account.',
    urgent: true,
  },
  locked: { text: 'Family Vault: your sign-in was locked.', urgent: true },
  unlocked: { text: 'Family Vault: you can sign in to your vault again.', urgent: true },
  signed_out: { text: 'Family Vault: you were signed out everywhere.', urgent: true },
  owner_change: {
    text: 'Family Vault: there was a change to who owns your vault.',
    urgent: true,
  },
  sign_in_tries: {
    text: 'Family Vault: somebody keeps trying to sign in to your account. Details are in your email.',
    urgent: true,
  },
  news: { text: 'Family Vault: there is news about your vault in your email.', urgent: false },
};

export function isAlertTextKind(word: unknown): word is AlertTextKind {
  return typeof word === 'string' && Object.hasOwn(ALERT_TEXTS, word);
}

/**
 * Whom a link was shared for, as a text says it: the family's own label,
 * on one line and short, else "someone". Never the document.
 */
export function shareOpenedText(label: string | null | undefined): string {
  const clean = (label ?? '')
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();
  return `Family Vault: the link you shared for ${clean || 'someone'} was opened.`;
}

// ------------------------------------------------------- codes by text (SMS3)

/**
 * What a code to somebody's own confirmed number is for (SMS3): finishing a
 * password reset, the second step of a sign-in, and confirming it's them
 * (a step-up). Six digits, 10 minutes, 5 tries and used once, as the code
 * that confirms a number; at most 3 to a number, and to an account, in 15
 * minutes, and 10 in a day.
 */
export type TextCodePurpose = 'reset' | 'sign_in' | 'step_up';

/**
 * What the person is told of a code by text, wherever it is offered: the
 * weakest of the second factors, and why — so nobody mistakes it for an
 * authenticator app or a passkey.
 */
export const SMS_FACTOR_WARNING =
  'A text is the weakest way to prove it’s you: somebody who talks your mobile company into moving your number to their SIM gets your codes. Use it as well as a passkey or an authenticator app if you can, not instead.';

/** Why an owner cannot make a text their only second step (SMS3). */
export const SMS_OWNER_NEEDS_FACTOR =
  'An owner needs a passkey or two-step sign-in with an authenticator app before a code by text can be added. A text is never an owner’s only second step.';

/** The text that carries a share link's code: never the link, never what it is to. */
export function shareCodeText(code: string): string {
  return `Family Vault: your code to open the shared documents is ${code}. It ends in ${PHONE_CODE_MINUTES} minutes.`;
}

/**
 * The text that carries an invitation's code: never the link, which goes
 * as it always has. Whoever reads it types the code on the page the
 * invitation's link opens.
 */
export function inviteCodeText(code: string, inviter: string | null | undefined): string {
  const who = inviter ? `${firstName(inviter)} invited you to the family vault. ` : '';
  return `Family Vault: ${who}Your invitation code is ${code}. Type it on the page your invitation link opens.`;
}

/** The text that carries a code for one of somebody's own purposes. */
export function textCodeText(purpose: TextCodePurpose, code: string): string {
  const what =
    purpose === 'reset'
      ? 'your code to finish resetting your password'
      : purpose === 'sign_in'
        ? 'your sign-in code'
        : 'your code to confirm it’s you';
  const tail =
    purpose === 'reset'
      ? ' If you didn’t ask for it, tell an owner.'
      : ' Never tell it to anybody.';
  return `Family Vault: ${what} is ${code}. It ends in ${PHONE_CODE_MINUTES} minutes.${tail}`;
}

/**
 * Who may confirm it's them with a code by text (SMS3): adults and teens.
 * Never an owner — whose step-ups guard the household's own settings and
 * the owner's powers (A54) — nor a viewer or a guest.
 */
export function mayStepUpByText(role: string): boolean {
  return role === 'adult' || role === 'teen';
}

/** `POST /auth/mfa/text`, `/auth/step-up/text`, `/password-resets/code`: where a code went, masked. */
export interface TextCodeSent {
  /** "•••• •••123". */
  sent_to: string;
  expires_at: string;
}

/** `GET /auth/text-codes`: whether the person is asked for codes by text, and whether they can be. */
export interface TextCodeSettings {
  /** A code by text at sign-in (as well as the password), and to confirm it's them. */
  sign_in: boolean;
  /** A code by text to finish a password reset. */
  reset: boolean;
  /** Their own number, masked; null when they have none. */
  phone: string | null;
  /** Whether it is confirmed: only a confirmed number is sent a code. */
  phone_confirmed: boolean;
  /** Whether the household sends texts now (`GET /sms/status`). */
  sms_ready: boolean;
  /**
   * Whether they could turn either on now: a confirmed number, texts set up,
   * and for an owner, a passkey or two-step sign-in as well (`why_not` when not).
   */
  can_turn_on: boolean;
  /** Why not, in plain words; null when they can. */
  why_not: string | null;
  /** Whether a code by text can confirm it's them (adults and teens alone). */
  step_up: boolean;
}

/** `PUT /auth/text-codes`: either, or both. */
export interface TextCodeSettingsInput {
  sign_in?: boolean | undefined;
  reset?: boolean | undefined;
}
