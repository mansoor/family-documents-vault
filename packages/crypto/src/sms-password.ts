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
