import { localToday, shortDate } from './reminders.js';

/**
 * Email documents to the vault: a household mailbox checked over IMAP
 * (0.8.0, S4, CAP-09).
 *
 * The operator makes a mailbox of the household's own and gives the worker
 * its server and sign-in (FDV_MAIL_IN_*). An owner turns it on in Settings.
 * The worker looks every FDV_MAIL_IN_POLL_SECONDS: mail From the confirmed
 * sign-in address of somebody of the family who may add documents goes into
 * their Inbox, each attachment the vault keeps an item of their batch of the
 * day ("Email, 12 Oct"), theirs alone until they accept it. Then the mail is
 * moved to a "Filed" folder, or deleted. Anything else is left unread and
 * untouched, and counted for the owners.
 *
 * Somebody's address is confirmed by a code: they send it, in a subject,
 * from their sign-in address to the mailbox. With FDV_MAIL_IN_AUTHSERV_ID
 * set, a sender is accepted only on the mailbox provider's own word
 * (Authentication-Results: DMARC, or DKIM aligned with the From); without
 * it on the From alone, and each item says "sender not verified".
 */

/** By default the worker looks at the mailbox this often (FDV_MAIL_IN_POLL_SECONDS). */
export const MAIL_IN_POLL_SECONDS = 300;

/** The most one email may be: larger, and nothing in it is downloaded. */
export const MAIL_IN_MAX_MESSAGE_BYTES = 50 * 1024 * 1024;

/** A picture in the body smaller than this is a signature or a logo: left out. */
export const MAIL_IN_INLINE_SKIP_BYTES = 20 * 1024;

/** Where mail is moved once its attachments are in the vault (FDV_MAIL_IN_AFTER=move). */
export const MAIL_IN_FILED_FOLDER = 'Filed';

/** How long a code to confirm an address lasts. */
export const MAIL_IN_CODE_MS = 24 * 60 * 60_000;

/**
 * A code to confirm an address: FDV- and three groups of four letters and
 * digits that are never mistaken for each other (60 random bits).
 */
export const MAIL_IN_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const MAIL_IN_CODE_PATTERN = /FDV-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}/gi;

/**
 * The worker's word on the mailbox older than this many polls is no word at
 * all: it is not running, or cannot reach the database. Email in is then
 * not offered.
 */
export const MAIL_IN_STALE_POLLS = 2;

/** And a little more, for a poll that takes a while. */
export const MAIL_IN_STALE_GRACE_MS = 60_000;

/** What is done with a mail once its attachments are in: moved to Filed, or deleted. */
export type MailInAfter = 'move' | 'delete';

/**
 * What last went wrong, as a word — never the mail server's own message,
 * which can carry the sign-in: the mailbox refused the sign-in, could not be
 * reached, or its certificate could not be verified; the folder is not
 * there; a mail added could not be filed; the vault could not open
 * somebody's key or has nowhere to keep files; a mail could not be read.
 */
export type MailInError =
  | 'login_failed'
  | 'unreachable'
  | 'certificate'
  | 'no_folder'
  | 'not_filed'
  | 'sealed'
  | 'no_storage'
  | 'unreadable';

/** Why an email, or an attachment of one, could not be added: in its person's Needs attention. */
export type MailNoticeReason = 'message_too_large' | 'too_large' | 'unreadable' | 'nothing_to_add';

/** GET /mail-in: an owner's view of email in. */
export interface MailInView {
  /** Whether it can be turned on: set up on the worker, which has said so lately (`/capabilities`' `email_ingest`). */
  available: boolean;
  server: {
    /** `ready`, `not_configured` (FDV_MAIL_IN_* not set), or `unknown` (the worker has not said lately). */
    state: 'ready' | 'not_configured' | 'unknown';
    /** Where the family sends mail. */
    address: string | null;
    folder: string | null;
    after: MailInAfter;
    /** FDV_MAIL_IN_AUTHSERV_ID is set: senders are checked by the mailbox's own word. */
    sender_check: boolean;
    poll_seconds: number | null;
    checked_at: string | null;
    /** What it means, in a sentence. */
    words: string;
  };
  enabled: boolean;
  last_checked_at: string | null;
  last_error: { code: MailInError; words: string; at: string } | null;
  last_added_at: string | null;
  /** Mail left in the mailbox as of the last look: from strangers, failing the check, waiting. */
  unknown_senders: number;
  unverified: number;
  waiting: number;
  /** Those, in sentences: none when there are none. */
  counts: string[];
  /** While senders are not checked: what that means, and what to set. */
  sender_warning: string | null;
}

/** PUT /mail-in: on or off. */
export interface MailInInput {
  enabled: boolean;
}

/** GET /mail-in/me: whether the caller may email documents in, and from where. */
export interface MailInMine {
  /** On, and the mailbox ready: the caller can email documents in (once their address is confirmed). */
  on: boolean;
  /** Where to send them. */
  address: string | null;
  /** From which address: the caller's sign-in. */
  email: string;
  /** That address is confirmed: mail from it reaches the caller's Inbox. */
  confirmed: boolean;
  /** A code made and not yet used: until when it lasts. */
  code_expires_at: string | null;
  /** Senders are not checked by the mailbox (each item says "sender not verified"). */
  sender_check: boolean;
}

/** POST /mail-in/me/code: a new code, shown once. */
export interface MailInCode {
  code: string;
  expires_at: string;
}

/** The day an email is added, on the household's calendar, and its batch's name: "Email, 12 Oct". */
export function emailDay(timezone: string, now: Date = new Date()): { day: string; name: string } {
  const day = localToday(timezone, now);
  return { day, name: `Email, ${shortDate(day)}` };
}

/** A code as it is compared: capitals, nothing around it. */
export function normaliseMailInCode(code: string): string {
  return code.trim().toUpperCase();
}

/** The codes in a subject (most, a few): each one is tried. */
export function mailInCodesIn(subject: string): string[] {
  return [...subject.matchAll(MAIL_IN_CODE_PATTERN)]
    .slice(0, 3)
    .map((m) => normaliseMailInCode(m[0]));
}

/** "50 MB", or "64 KB" under a megabyte. */
function sizeWords(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${Math.floor(mb)} MB` : `${Math.max(1, Math.floor(bytes / 1024))} KB`;
}

/** What the mailbox's state means, to an owner in Settings. */
export function mailServerWords(
  state: MailInView['server']['state'],
  address: string | null,
  folder: string | null,
): string {
  switch (state) {
    case 'ready':
      return `The vault checks ${address ?? 'the household mailbox'}${folder ? `, in its ${folder} folder` : ''}.`;
    case 'not_configured':
      return 'Email in isn’t set up on this server: FDV_MAIL_IN_HOST, FDV_MAIL_IN_USER and a password aren’t all set on the worker. The README’s “Emailing documents to the vault” says how.';
    case 'unknown':
      return 'The worker hasn’t checked the mailbox lately. Check that it is running.';
  }
}

/** What last went wrong, to an owner: never a secret, always what to do. */
export function mailInErrorWords(code: MailInError, folder?: string | null): string {
  switch (code) {
    case 'login_failed':
      return 'The mailbox refused the vault’s sign-in. Check FDV_MAIL_IN_USER and the app password. The vault tries less often until it works, so the provider doesn’t lock the mailbox.';
    case 'unreachable':
      return 'The vault couldn’t reach the mail server. Check FDV_MAIL_IN_HOST and FDV_MAIL_IN_PORT, and the server’s internet connection.';
    case 'certificate':
      return 'The mail server’s certificate couldn’t be verified, so the vault didn’t sign in. Check that FDV_MAIL_IN_HOST is your provider’s IMAP server name.';
    case 'no_folder':
      return `The mailbox has no folder called ${folder ?? 'that'}. Check FDV_MAIL_IN_FOLDER.`;
    case 'not_filed':
      return 'An email’s attachments were added, but the email couldn’t be moved to Filed or deleted. The vault tries again; check that the mailbox lets it make folders.';
    case 'sealed':
      return 'The vault can’t open someone’s key with this master key, so their email waits. Check FDV_MASTER_KEY.';
    case 'no_storage':
      return 'There is nowhere to keep files yet, so email waits. Set up where files are kept first.';
    case 'unreadable':
      return 'An email couldn’t be read just now. The vault tries again.';
  }
}

/** Mail left in the mailbox, to an owner: a sentence for each kind there is any of. */
export function mailInCountWords(c: {
  unknown_senders: number;
  unverified: number;
  waiting: number;
}): string[] {
  const n = (k: number) => (k === 1 ? '1 email' : `${k} emails`);
  const out: string[] = [];
  if (c.unknown_senders > 0) {
    out.push(
      `${n(c.unknown_senders)} from unknown senders ${c.unknown_senders === 1 ? 'was' : 'were'} ignored. ${c.unknown_senders === 1 ? 'It is' : 'They are'} still in the mailbox, unread.`,
    );
  }
  if (c.unverified > 0) {
    out.push(
      `${n(c.unverified)} from family addresses didn’t pass the mailbox’s sender check, so ${c.unverified === 1 ? 'it was' : 'they were'} ignored as possibly forged.`,
    );
  }
  if (c.waiting > 0) {
    out.push(
      `${n(c.waiting)} ${c.waiting === 1 ? 'waits' : 'wait'}: the sender can’t have files added just now (their sign-in is locked or waits after a restore, or today’s batch is full).`,
    );
  }
  return out;
}

/** Said to owners while senders are not checked (FDV_MAIL_IN_AUTHSERV_ID unset). */
export const MAIL_IN_SENDER_WARNING =
  'Senders aren’t verified. Anyone who knows the mailbox’s address can send an email that looks as if it came from someone in the family. Set FDV_MAIL_IN_AUTHSERV_ID (README, “Emailing documents to the vault”) so the vault accepts only email your provider checked. Until then, every item from an email says “sender not verified”.';

/** Said on an item from an email whose sender was not verified. */
export const SENDER_NOT_VERIFIED = 'Sender not verified';

/** What a mail's note is headed, by why. */
export function mailNoticeTitle(reason: MailNoticeReason): string {
  switch (reason) {
    case 'nothing_to_add':
      return 'An email had nothing we could add';
    case 'too_large':
      return 'An attachment couldn’t be added';
    case 'message_too_large':
    case 'unreadable':
      return 'An email couldn’t be added';
  }
}

/** Why, in plain words, and what became of the email. */
export function mailNoticeWords(
  reason: MailNoticeReason,
  fileName: string | null,
  after: MailInAfter,
  maxBytes?: number,
): string {
  const gone =
    after === 'delete'
      ? 'The email was deleted from the household mailbox.'
      : `The email was moved to the household mailbox’s ${MAIL_IN_FILED_FOLDER} folder.`;
  switch (reason) {
    case 'message_too_large':
      return `An email you sent was larger than the vault takes (${sizeWords(MAIL_IN_MAX_MESSAGE_BYTES)}), so nothing in it was added. ${gone} Send the documents in smaller emails.`;
    case 'too_large':
      return `${fileName ?? 'An attachment'} is larger than the most the vault takes in one file${maxBytes ? ` (${sizeWords(maxBytes)})` : ''}, so it wasn’t added. Scan it in parts, or at a lower resolution.`;
    case 'unreadable':
      return `An email you sent couldn’t be read, so nothing in it was added. ${gone}`;
    case 'nothing_to_add':
      return `No PDF, photo, Word or Excel file was attached to an email you sent (pictures in a signature are left out). ${gone}`;
  }
}
