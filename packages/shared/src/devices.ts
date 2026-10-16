/**
 * A computer that sends scans (0.8.0, D1): pairing, and an upload-only key.
 *
 * Somebody who may add documents pairs a computer of theirs from Settings →
 * Your computers: their password again, then a one-time code for 10
 * minutes that the uploader app on that computer trades for a key of its
 * own (`POST /api/v1/devices/pair`). The key is sent as
 * `Authorization: Device <device_id>.<key>` and does one thing: it puts a
 * file into its person's own uploads, a batch a day, through
 * `POST /api/v1/device-uploads`, and says what it is through
 * `GET /api/v1/devices/me`. Every other route refuses it (401).
 *
 * MIT, with the rest of @fdv/shared: the uploader app reads these too.
 */

import { localToday } from './reminders.js';
import { zonedTime } from './shares.js';

/** The letters and digits a code is made of: none that reads as another (no 0/O, 1/I/L, 2/Z, 5/S, 8/B, U/V). */
export const PAIRING_ALPHABET = 'ACDEFGHJKMNPQRTWXY34679';

/** A code's length, without its dash: two halves of four (KX7P-2M9Q). */
export const PAIRING_CODE_LENGTH = 8;

/** How long a code lasts, in minutes. */
export const PAIRING_MINUTES = 10;

/** Wrong tries at a code before it ends. */
export const PAIRING_ATTEMPTS = 5;

/** The longest a computer's name may be. */
export const DEVICE_NAME_MAX = 60;

/** What a computer runs, as its app says. */
export const DEVICE_PLATFORMS = ['windows', 'macos', 'linux', 'other'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

/** The longest `relative_path` a computer may send with a file. */
export const DEVICE_RELATIVE_PATH_MAX = 1024;

/**
 * What is wrong with a `relative_path` a computer sends with a file (where
 * it was, under the folder it watches; empty for its top), in words; null
 * when it is fine: DEVICE_RELATIVE_PATH_MAX characters at most, none of
 * them a control character.
 */
export function relativePathProblem(path: string): string | null {
  if (path.length > DEVICE_RELATIVE_PATH_MAX) {
    return `A relative_path is ${DEVICE_RELATIVE_PATH_MAX} characters at most.`;
  }
  if (/\p{Cc}/u.test(path)) return 'A relative_path cannot hold a control character.';
  return null;
}

/**
 * A code as typed, made the code it names: capitals, and nothing but its
 * letters and digits (a dash, spaces, a lower case letter are all fine).
 * Null for anything that cannot be one.
 */
export function normalisePairingCode(typed: string): string | null {
  const plain = typed.toUpperCase().replace(/[^A-Z0-9]/g, '');
  // With its address's three-character check or without (pairing-address.ts):
  // the check is the app's to verify, never the vault's, so it is let go.
  if (plain.length !== PAIRING_CODE_LENGTH && plain.length !== PAIRING_CODE_LENGTH + 3) return null;
  for (const c of plain) if (!PAIRING_ALPHABET.includes(c)) return null;
  return plain.slice(0, PAIRING_CODE_LENGTH);
}

/** A code as it is shown: KX7P-2M9Q. */
export function showPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * A computer's name as the vault keeps it: trimmed, its runs of spaces one
 * space, nothing that is not printable. Null when nothing is left.
 */
export function deviceName(typed: string): string | null {
  const name = typed
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return name.length > 0 ? name.slice(0, DEVICE_NAME_MAX) : null;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * The name of a computer's batch for a day, on the household's calendar
 * (YYYY-MM-DD): "From Ahmed's laptop, 13 October 2026".
 */
export function deviceBatchName(device: string, day: string): string {
  const [year, month = 1, date = 1] = day.split('-').map(Number);
  return `From ${device}, ${date} ${MONTH_NAMES[month - 1] ?? ''} ${year}`;
}

/**
 * The next midnight on the household's clock (0.8.0, D1): when a
 * computer's day — its batch for the day and its room in bytes — starts
 * again. Through a change of the clocks too: the moment the household's
 * calendar turns to tomorrow's date.
 */
export function nextLocalMidnight(timezone: string, now: Date = new Date()): Date {
  const [y = 1970, m = 1, d = 1] = localToday(timezone, now).split('-').map(Number);
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return zonedTime(tomorrow, '00:00', timezone) ?? new Date(Date.UTC(y, m - 1, d + 1));
}

/** `POST /api/v1/device-pairings`: a code, shown once. */
export interface DevicePairingCode {
  /** As it is shown and typed: KX7P-2M9Q. */
  code: string;
  expires_at: string;
  /** The vault's address, as the app on the computer must be told it. */
  vault_address: string;
  /** Where the uploader app is downloaded from (FDV_DESKTOP_DOWNLOAD_URL), when the vault says. */
  download_url: string | null;
}

/** `POST /api/v1/devices/pair`'s body: the code, and what the app says the computer is. */
export interface DevicePairInput {
  code: string;
  device_name: string;
  platform: DevicePlatform;
}

/** `POST /api/v1/devices/pair`: the key, shown once — the app keeps it, the vault keeps its HMAC. */
export interface DevicePaired {
  device_id: string;
  /** The key alone: sent as `Authorization: Device <device_id>.<key>`. */
  key: string;
  /** Whose uploads its files go into. */
  member_name: string;
  /** The household's name. */
  vault_name: string;
}

/** Why a computer's files are refused for now, its key still good (`GET /devices/me`). */
export type DevicePausedReason =
  /** Its person can no longer add documents (their key is revoked as that happens). */
  | 'cannot_add'
  /** An owner has locked its person's sign-in. */
  | 'locked'
  /** After a restore, its person's sign-in waits for an owner to turn it back on. */
  | 'paused_after_restore';

/** `GET /api/v1/devices/me`: what the app may say about itself. */
export interface DeviceMe {
  device_id: string;
  device_name: string;
  member_name: string;
  active: boolean;
  paused: DevicePausedReason | null;
  limits: {
    /** The largest file the vault takes (FDV_MAX_UPLOAD_BYTES). */
    max_upload_bytes: number;
    /** A day's batch holds this many files. */
    batch_max_files: number;
    /** The most this computer may send in a day, in bytes (FDV_DEVICE_DAILY_BYTES). */
    daily_bytes: number;
    /**
     * When its day starts again (ISO): the next midnight on the household's
     * clock — a new batch for the day, and its room in bytes again.
     */
    day_resets_at: string;
    /** The kinds of file it takes, by media type. */
    accepted_types: string[];
  };
}

/** `POST /api/v1/device-uploads`: the item it made, and nothing else about the vault. */
export interface DeviceUploaded {
  item_id: string;
  /** Waiting in its person's uploads; or decided already (a repeat of an earlier file). */
  status: 'waiting' | 'accepted';
}

/** `GET /api/v1/paired-devices`: a computer, as its person or an owner sees it. */
export interface PairedDevice {
  id: string;
  name: string;
  platform: DevicePlatform;
  member_id: string;
  member_name: string;
  /** The caller's own. */
  mine: boolean;
  added_at: string;
  /** When it last sent anything: its person's to know; null to an owner for somebody else's. */
  last_used_at: string | null;
}

/** Why a device request is refused: the codes an app shows words for. */
export const DEVICE_REFUSALS = {
  device_revoked: 'This computer has been removed from the vault. Pair it again in Settings.',
  cannot_add: 'You can no longer add documents, so this computer cannot send them.',
  member_locked: 'An owner has locked your sign-in, so this computer cannot send documents.',
  member_paused:
    'After a restore your sign-in waits for an owner to turn it back on. Files will send once they have.',
} as const;
