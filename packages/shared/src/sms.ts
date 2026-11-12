import {
  isSupportedCountry,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js/min';

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
 * calendar month than the owners allow. Notifications by text come later
 * (SMS2): for now a text is a test, or a code.
 */

/** How the vault reaches SMS Gate. */
export type SmsMode = 'local' | 'cloud' | 'private';
export const SMS_MODES: readonly SmsMode[] = ['local', 'cloud', 'private'];

/** Whether a test text has gone since the settings were last saved: only `ok` sends. */
export type SmsStatus = 'untested' | 'ok' | 'failed';

/** What became of a text, as SMS Gate last said; `not_sent`: SMS Gate never took it. */
export type SmsState = 'pending' | 'processed' | 'sent' | 'delivered' | 'failed' | 'not_sent';

/** Why a text was sent. */
export type SmsKind = 'test' | 'phone_code' | 'phone_changed';

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

/** The household's SMS Gate, as an owner sees it: never its password, only whether one is set. */
export interface SmsSettings {
  mode: SmsMode;
  base_url: string;
  username: string;
  password: 'set' | 'not_set';
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

/** PUT /sms/settings: the password left out keeps the one set (unless the address or sign-in changed). */
export interface SmsSettingsInput {
  mode: SmsMode;
  /** Ignored for `cloud`. */
  base_url?: string | null | undefined;
  username: string;
  password?: string | undefined;
  country: string;
  monthly_cap: number;
}

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
