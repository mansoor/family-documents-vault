import { openBound, sealBound } from './master-rotation.js';

/**
 * The household mailbox's app password, as an owner sets it in Settings
 * (0.9.0, O1): sealed by the API (AES-256-GCM, the household bound in)
 * under a key derived from the master key for this purpose alone, and
 * opened by the worker, which hands it to the IMAP client and nothing else.
 * One of MASTER_SEALED, so rotate-master-key and a restore of an older
 * backup move it as they move the other secrets.
 */
export const MAILBOX_PASSWORD_PURPOSE = 'mail-in-credentials';

/** The server and sign-in a password was typed for: bound in with the household. */
export interface MailboxTarget {
  host: string;
  port: number;
  username: string;
}

/**
 * What is bound in: the household, so a value moved to another's row does
 * not open; and the server, port and sign-in it was typed for (the O1
 * review, H1), so a password kept as the server is changed never goes to
 * the new one. A host is compared in lower case.
 */
export const mailboxPasswordAad = (
  householdId: string,
  host: string,
  port: number,
  username: string,
) => `mail-in:${householdId}\0${host.toLowerCase()}\0${port}\0${username}`;

export function sealMailboxPassword(
  key: Buffer,
  password: string,
  householdId: string,
  to: MailboxTarget,
): Buffer {
  return sealBound(
    key,
    Buffer.from(password, 'utf8'),
    mailboxPasswordAad(householdId, to.host, to.port, to.username),
  );
}

export function openMailboxPassword(
  key: Buffer,
  sealed: Buffer,
  householdId: string,
  to: MailboxTarget,
): string {
  return openBound(
    key,
    sealed,
    mailboxPasswordAad(householdId, to.host, to.port, to.username),
  ).toString('utf8');
}
