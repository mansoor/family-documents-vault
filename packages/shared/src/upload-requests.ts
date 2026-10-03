import type { Visibility } from './documents.js';

/**
 * Asking somebody outside the family to send documents (5.21).
 *
 * An owner or an adult makes a request: a link, `/drop#<token>`, for the
 * accountant or the solicitor to put files in. The link is write-only —
 * whoever holds it never sees the vault, another sender's files, or their
 * own once sent — and what comes in waits to be reviewed (5.23) before it
 * becomes a document. The rules the vault holds a request to, and the
 * shapes it answers with, in one place.
 */

/** A request takes this many files at most (A41), and the requester may ask for fewer. */
export const UPLOAD_REQUEST_MAX_FILES = 10;
/** And this many bytes in all (A41): 200 MB. */
export const UPLOAD_REQUEST_MAX_BYTES = 200 * 1024 * 1024;
/**
 * The household's files waiting for review, across every request: past
 * this, no link takes another byte until some are filed or refused. It
 * bounds what strangers can make the vault keep.
 */
export const INCOMING_HOUSEHOLD_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** The sender's note, plain text. */
export const SENDER_NOTE_MAX = 1000;
/** A typed password is at least this long (5.20's rule for a link's). */
export const UPLOAD_PASSWORD_MIN = 8;
/** Named things a request asks for ("W-2", "1099"), at most. */
export const UPLOAD_REQUEST_ITEMS_MAX = 10;
export const UPLOAD_REQUEST_TITLE_MAX = 120;
export const UPLOAD_REQUEST_MESSAGE_MAX = 2000;
export const UPLOAD_REQUEST_ITEM_LABEL_MAX = 80;
/** An emailed code works for this long, and for this many tries. */
export const UPLOAD_CODE_MINUTES = 10;
export const UPLOAD_CODE_TRIES = 5;

/**
 * What a request takes (A40): PDFs and photos; Word and Excel too when the
 * requester says so. Decided from the bytes, never the name. A Word or
 * Excel file with macros is never taken.
 */
export type UploadAcceptTypes = 'standard' | 'office';

/** Who looks at what comes in (A43): the person who asked, or any adult. */
export type UploadReviewBy = 'me' | 'adults';

/** What Open asks of the sender, beyond the link: a password, an emailed code, or this device. */
export type UploadProtection = 'password' | 'email_code' | 'this_device';

const STANDARD_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/tiff',
  'image/webp',
] as const;
const OFFICE_TYPES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;

/** The kinds of file a request takes, by what their bytes are. */
export function uploadRequestTypes(accept: UploadAcceptTypes): readonly string[] {
  return accept === 'office' ? [...STANDARD_TYPES, ...OFFICE_TYPES] : STANDARD_TYPES;
}

/** The kinds a request takes, as a person says them. */
export function uploadRequestTypesWords(accept: UploadAcceptTypes): string {
  return accept === 'office' ? 'PDFs, photos, and Word or Excel files' : 'PDFs and photos';
}

/** What a request is now. */
export type UploadRequestState =
  'active' | 'expired' | 'revoked' | 'closed' | 'locked' | 'paused' | 'used_up';

/** `POST /api/v1/upload-requests`. */
export interface UploadRequestInput {
  title: string;
  message?: string | null;
  /** What to send, by name: "W-2", "1099". Each is a slot the sender can put files in. */
  items?: string[];
  /** Whom it is for, in the family's words: "Jane, accountant". */
  recipient_label?: string | null;
  /** Where an emailed code goes; the sender never types it, and sees it masked. */
  recipient_email?: string | null;
  /** When it ends: at least 5 minutes ahead, at most `limits.share_max_days` (A20). */
  expires_at: string;
  /** A password the vault makes up and shows once. */
  with_password?: boolean;
  /** Or one typed, of at least 8 characters. */
  password?: string;
  /** An emailed code too: only when the vault has operator mail (A21). */
  email_code?: boolean;
  this_device_only?: boolean;
  /** How many times Open may work; null or absent for no limit. */
  max_visits?: number | null;
  /** 1 to 10; 10 unless said. */
  max_files?: number;
  /** Up to 200 MB in all; 200 MB unless said. */
  max_total_bytes?: number;
  accept_types?: UploadAcceptTypes;
  review_by?: UploadReviewBy;
  /** Hints for whoever reviews: whose it probably is, and what kind. Never shown to the sender. */
  suggested_member_id?: string | null;
  suggested_type_key?: string | null;
  /** Closed once the first sending is finished. */
  close_after_submit?: boolean;
}

export interface UploadRequestItem {
  id: string;
  label: string;
}

/** A request, as the people who review it see it. */
export interface UploadRequestView {
  id: string;
  title: string;
  message: string | null;
  items: UploadRequestItem[];
  recipient_label: string | null;
  /** Null once the request has ended: it is cleared then. */
  recipient_email: string | null;
  requested_by_name: string | null;
  /** Whether the reader is the one who asked. */
  mine: boolean;
  created_at: string;
  expires_at: string;
  protection: UploadProtection[];
  max_visits: number | null;
  visits_used: number;
  max_files: number;
  files_used: number;
  max_total_bytes: number;
  bytes_used: number;
  accept_types: UploadAcceptTypes;
  review_by: UploadReviewBy;
  suggested_member_id: string | null;
  suggested_type_key: string | null;
  close_after_submit: boolean;
  state: UploadRequestState;
  /**
   * `restored`: a restore paused it, for an owner to turn back on. `locked`
   * (5.28): its requester's sign-in is locked; it opens again, by itself,
   * once they are unlocked.
   */
  paused_reason: 'restored' | 'locked' | null;
  closed_reason: 'submitted' | 'requester_lost_right' | null;
  /** Files sent in and waiting, or decided (5.23). */
  files_received: number;
}

/** What making a request answers: the link and the password exist here and nowhere else. */
export interface CreatedUploadRequest {
  request: UploadRequestView;
  link_token: string;
  /**
   * `{FDV_PUBLIC_URL}/drop#{link_token}` when the vault has a public-only
   * site; null when it has none, and the app puts its own address first.
   */
  link_url: string | null;
  /** Present only when the vault made one up. */
  password?: string;
}

/**
 * `POST /api/v1/drop/preview`: all the page shows before Open — whose vault
 * and who asked. Not what, from whom or why: the title, the message and
 * the slots wait for Open. Nothing is counted and nothing is written down.
 */
export interface DropPreview {
  household_name: string;
  requested_by: string | null;
  /** What Open asks for; empty when the link alone opens it. */
  protection: UploadProtection[];
  expires_at: string;
  /**
   * Which request it is (5.22): a page that has it open in this browser
   * already — another tab, a link followed again — carries on in that
   * session (`GET /drop/session`) rather than pressing Open, which would
   * start another and leave the first one's files behind. Absent from older
   * vaults.
   */
  request_id?: string;
  /**
   * Where an emailed code goes, masked (`j•••@e•••.com`), when Open asks for
   * one (5.22), as a share link's preview says (5.20). The sender never
   * types an address. Null in another browser than a this-device-only
   * request's, and absent from older vaults.
   */
  code_to?: string | null;
  /**
   * It has been opened in another browser already, and opens only there
   * (5.22): Open would be refused, and no code is sent here. Absent from
   * older vaults.
   */
  other_device?: boolean;
}

/** `POST /api/v1/drop/code`: where the code went, masked, and until when it works. */
export interface DropCodeSent {
  sent_to: string;
  expires_at: string;
}

/** A file this session has sent. */
export interface DropFile {
  id: string;
  name: string;
  content_type: string;
  byte_size: number;
  /** Which of the request's items it was sent as, if the sender chose. */
  item_id: string | null;
}

/**
 * `POST /api/v1/drop/unlock` and `GET /api/v1/drop/session`: what the
 * sender is asked for, and what they have sent so far in this browser.
 * Never the person or the kind of document the requester guessed at.
 */
export interface DropSession {
  /**
   * Which request this is: the page sends it back as `X-FDV-Drop-Request`,
   * so a browser with two requests open is asked about the right one. Its
   * session cookie is named for it.
   */
  request_id: string;
  household_name: string;
  requested_by: string | null;
  title: string;
  message: string | null;
  items: UploadRequestItem[];
  /** What it takes, by the bytes: see `uploadRequestTypes`. */
  accept_types: UploadAcceptTypes;
  accepted: readonly string[];
  max_files: number;
  files_left: number;
  bytes_left: number;
  /** The largest one file may be now: the vault's limit, or what is left. */
  max_file_bytes: number;
  /**
   * The vault's own limit for one file (FDV_MAX_UPLOAD_BYTES), whatever is
   * left: a page that gives room back on Remove caps one file by it too
   * (the 5.22 review, N522W2-3).
   */
  file_limit_bytes: number;
  expires_at: string;
  session_expires_at: string;
  files: DropFile[];
}

/**
 * A sent file's name as the vault keeps it, and shows it (`DropFile.name`):
 * its last path part, in NFC, with no control or direction characters,
 * runs of space as one, trimmed, and at most 200 characters; `file` when
 * nothing is left. The API keeps names so, and a page that looks for a file
 * it sent compares names so (the 5.22 review, N522W2-2).
 */
export function dropFileName(name: string): string {
  const last = name.split(/[\\/]/).pop() ?? '';
  const clean = last
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const cut = [...clean].slice(0, 200).join('');
  return cut && cut !== '.' && cut !== '..' ? cut : 'file';
}

/** `POST /api/v1/drop/finish`: how many files went, and whether the request is closed now. */
export interface DropFinished {
  files: number;
  closed: boolean;
}

// ------------------------------------------------- incoming (5.23)

/**
 * A file sent in waits this many days, from when it arrived, for somebody
 * to file it; then the vault removes it, its bytes and all.
 */
export const INCOMING_KEEP_DAYS = 30;

/**
 * What a reviewer is told of a file the vault has not scanned for viruses:
 * this vault scans for nothing (A42), so it is every file it holds.
 */
export const NOT_SCANNED = 'Not scanned for viruses';

/** Where a file sent in stands with the vault's scan (A42): never "clean" without a scanner. */
export type IncomingScanState = 'pending' | 'unscanned' | 'clean';

/**
 * Its review previews: being got ready, drawn (`preview_pages` of them), a
 * kind the vault does not draw (Word, Excel), or drawing failed.
 */
export type IncomingPreviewState = 'pending' | 'ready' | 'unsupported' | 'failed';

/**
 * `GET /api/v1/incoming`: a file sent through a request, waiting for its
 * reviewer — the requester, for a request they review alone; otherwise the
 * owners and adults, or the owners alone once moved to them. Never a
 * teen's or a viewer's. Nothing here is a document until it is filed.
 */
export interface IncomingFileView {
  id: string;
  request_id: string;
  /** The request it came through: its title, and whom it was for ("Jane, accountant"). */
  request_title: string;
  recipient_label: string | null;
  /** Which of the things asked for the sender said it was ("W-2"), if they chose. */
  item_label: string | null;
  /** Its name as sent, made safe to show. Shown, and never trusted for anything else. */
  name: string;
  /** What its bytes are, never what it was called. */
  content_type: string;
  byte_size: number;
  /** The sender's note, plain text, given with every file they sent at once. */
  sender_note: string | null;
  /** When its sender pressed Finish. */
  sent_at: string;
  /** When the vault removes it unless it is filed: INCOMING_KEEP_DAYS after it arrived. */
  removed_at: string;
  scan_state: IncomingScanState;
  preview_state: IncomingPreviewState;
  /** Pages drawn, served at /incoming/{id}/pages/{n}; null until known. */
  preview_pages: number | null;
  /** The requester's hints for whoever reviews: whose it probably is, and what kind. */
  suggested_member_id: string | null;
  suggested_type_key: string | null;
  review_by: UploadReviewBy;
  /** Moved to the owners from a requester who can no longer review it. */
  moved_to_owners: boolean;
}

/**
 * `POST /api/v1/incoming/{id}/accept`: filed as a new document, for the
 * person and visibility chosen, its details checked as a capture's are; or
 * as a new version of a document the reviewer may see and change
 * (`into_document_id`), with nothing else beside it.
 */
export interface IncomingAcceptInput {
  owner_member_id?: string | null;
  type_key?: string | null;
  title?: string | null;
  visibility?: Visibility;
  into_document_id?: string;
}

/** What filing a file made. */
export interface IncomingAccepted {
  document_id: string;
  version_id: string;
}

/**
 * A version's line in a document's history when it came in through a
 * request (5.23): "Sent through a request link (Jane, accountant)".
 */
export function sentThroughWords(recipientLabel: string | null): string {
  const label = recipientLabel?.trim();
  return label ? `Sent through a request link (${label})` : 'Sent through a request link';
}

/** The ending each kind a request takes is saved with. */
const INCOMING_EXTENSIONS: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heic',
  'image/tiff': 'tiff',
  'image/webp': 'webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

/**
 * The name a file sent in is saved under: its own name without whatever
 * ending the sender gave it, and the ending its bytes say it has. A file
 * sent as "invoice.html" that is a PDF is "invoice.pdf".
 */
export function incomingFileName(name: string, contentType: string): string {
  const ext = INCOMING_EXTENSIONS[contentType] ?? 'bin';
  const base = name.replace(/\.[^.]{1,10}$/, '').trim() || 'file';
  return `${base}.${ext}`;
}
