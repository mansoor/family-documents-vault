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
  paused_reason: 'restored' | null;
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
  expires_at: string;
  session_expires_at: string;
  files: DropFile[];
}

/** `POST /api/v1/drop/finish`: how many files went, and whether the request is closed now. */
export interface DropFinished {
  files: number;
  closed: boolean;
}
