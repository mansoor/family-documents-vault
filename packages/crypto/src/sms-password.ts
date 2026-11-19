import { openBound, sealBound } from './master-rotation.js';

/**
 * The password of the household's SMS Gate, as an owner sets it in Settings
 * (0.9.0, SMS1): sealed by the API (AES-256-GCM, the household bound in)
 * under a key derived from the master key for this purpose alone, and
 * opened only to sign in to SMS Gate as a text is sent. One of
 * MASTER_SEALED, so rotate-master-key and a restore of an older backup move
 * it as they move the other secrets.
 */
export const SMS_PASSWORD_PURPOSE = 'sms-credentials';

/** Where, and as whom, a password was typed for: bound in with the household. */
export interface SmsTarget {
  mode: string;
  baseUrl: string;
  username: string;
}

/**
 * What is bound in: the household, so a value moved to another's row does
 * not open; and the mode, the address and the sign-in it was typed for, so
 * a password kept as the address is changed never goes to the new one.
 */
export const smsPasswordAad = (
  householdId: string,
  mode: string,
  baseUrl: string,
  username: string,
) => `sms:${householdId}\0${mode}\0${baseUrl}\0${username}`;

export function sealSmsPassword(
  key: Buffer,
  password: string,
  householdId: string,
  to: SmsTarget,
): Buffer {
  return sealBound(
    key,
    Buffer.from(password, 'utf8'),
    smsPasswordAad(householdId, to.mode, to.baseUrl, to.username),
  );
}

export function openSmsPassword(
  key: Buffer,
  sealed: Buffer,
  householdId: string,
  to: SmsTarget,
): string {
  return openBound(
    key,
    sealed,
    smsPasswordAad(householdId, to.mode, to.baseUrl, to.username),
  ).toString('utf8');
}

/**
 * The Auth Token of the household's Twilio account (0.9.0-dev.71), sealed
 * exactly as SMS Gate's password is: under the same key, with the household
 * and the Account SID it was typed for bound in, so a token kept as the
 * Account SID is changed never signs in as another account. Where texts
 * come from (a number or a Messaging Service) is not bound in: the token
 * only ever goes to Twilio, whichever sends them.
 */
export interface TwilioTarget {
  accountSid: string;
}

export const twilioTokenAad = (householdId: string, accountSid: string) =>
  `sms-twilio:${householdId}\0${accountSid}`;

export function sealTwilioToken(
  key: Buffer,
  token: string,
  householdId: string,
  to: TwilioTarget,
): Buffer {
  return sealBound(key, Buffer.from(token, 'utf8'), twilioTokenAad(householdId, to.accountSid));
}

export function openTwilioToken(
  key: Buffer,
  sealed: Buffer,
  householdId: string,
  to: TwilioTarget,
): string {
  return openBound(key, sealed, twilioTokenAad(householdId, to.accountSid)).toString('utf8');
}

/** What a provider's secret was sealed for: SMS Gate's password, or Twilio's token. */
export type SmsSecretTarget =
  (SmsTarget & { provider?: 'sms_gate' | undefined }) | (TwilioTarget & { provider: 'twilio' });

/** Opens whichever provider's secret it is: what a send does with the household's settings. */
export function openSmsSecret(
  key: Buffer,
  sealed: Buffer,
  householdId: string,
  to: SmsSecretTarget,
): string {
  return to.provider === 'twilio'
    ? openTwilioToken(key, sealed, householdId, to)
    : openSmsPassword(key, sealed, householdId, to);
}
