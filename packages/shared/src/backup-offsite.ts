/**
 * An off-site copy of the nightly backups (0.9.0): Settings → Backups.
 *
 * The worker's nightly backup is an encrypted dump of the database, written
 * to /data/backups beside the files. An owner may name a bucket on any
 * S3-compatible service; after each backup the worker copies the encrypted
 * file there as it is, and keeps the newest `retain_count`, removing only
 * its own older copies under the prefix chosen. Only the database: the
 * document files are not in a backup, so not in its copy either.
 */

/** How many copies are kept there, unless an owner says otherwise; and the bounds. */
export const OFFSITE_RETAIN_DEFAULT = 30;
export const OFFSITE_RETAIN_MIN = 1;
export const OFFSITE_RETAIN_MAX = 365;

/**
 * A copy older than this, while the copy is on, is late: the owners are told,
 * once. It assumes a backup every night; FDV_BACKUP_OFFSITE_LATE_DAYS (API and
 * worker) says otherwise for a vault backed up less often.
 */
export const OFFSITE_LATE_DAYS = 2;

/** Why a test or a copy did not go: a reason, never the provider's own words or a secret. */
export type OffsiteProblem =
  | 'credentials_rejected'
  | 'bucket_missing'
  | 'permission_denied'
  | 'unreachable'
  | 'verification_failed'
  | 'not_found'
  | 'unknown'
  /** The database holds more than one household: its dump is not one household's to send. */
  | 'several_households'
  /** The secret saved does not open with the master key the worker has. */
  | 'secret_unopened';

/** Each reason in words, for Settings and the owners' alert. */
export const OFFSITE_PROBLEM_WORDS: Record<OffsiteProblem, string> = {
  credentials_rejected: 'The access key ID or secret key was not accepted.',
  bucket_missing: 'That bucket does not exist, or the key cannot see it.',
  permission_denied: 'The key is not allowed to write, read or list there.',
  unreachable: 'The vault could not reach the address.',
  verification_failed: 'The copy was sent, but the bucket holds a different size.',
  not_found: 'The bucket did not find what the vault had just written.',
  unknown: 'Something went wrong talking to the bucket.',
  several_households:
    'This database holds more than one household, so its backups are not copied off-site.',
  secret_unopened:
    'The secret key saved does not open with the master key the worker has. Save it again.',
};

/** Words for a reason the database holds, whatever it is. */
export function offsiteProblemWords(problem: string | null | undefined): string {
  return problem && problem in OFFSITE_PROBLEM_WORDS
    ? OFFSITE_PROBLEM_WORDS[problem as OffsiteProblem]
    : OFFSITE_PROBLEM_WORDS.unknown;
}

/** The bucket, as an owner set it: never the secret key, only whether one is set. */
export interface OffsiteSettings {
  /** Null: Amazon S3 itself, by its region. */
  endpoint: string | null;
  region: string | null;
  bucket: string;
  prefix: string | null;
  path_style: boolean;
  access_key_id: string;
  secret_access_key: 'set' | 'not_set';
  retain_count: number;
  enabled: boolean;
  /** Whether a test of what is saved passed; it must before the copy is turned on. */
  status: 'untested' | 'ok' | 'failed';
  last_tested_at: string | null;
  test_problem: OffsiteProblem | null;
  /**
   * Whether the key may delete there, as the last test found (null until one
   * passed). False: a write-only key — the vault removes no old copies, and
   * the bucket's own lifecycle rule should.
   */
  can_delete: boolean | null;
  /** What the worker last did. */
  last_attempt_at: string | null;
  last_copy_at: string | null;
  last_copy_object: string | null;
  last_copy_bytes: number | null;
  last_result: 'ok' | 'failed' | null;
  last_problem: OffsiteProblem | null;
  /** On, and the last copy (or the turning on) older than OFFSITE_LATE_DAYS. */
  late: boolean;
}

/** GET /backups/offsite: what Settings → Backups shows. An owner's (`403` otherwise). */
export interface OffsiteView {
  /** False where the vault does not offer it (the hosted edition): the operator keeps backups. */
  available: boolean;
  /** Null until an owner sets it up. */
  settings: OffsiteSettings | null;
  /** What a backup holds: the database alone. Said in Settings, so nobody thinks otherwise. */
  covers: 'database';
}

/**
 * PUT /backups/offsite: the bucket, saved untested and off when anything
 * that reaches it changed. The secret left out keeps the one set, unless the
 * address, bucket or access key changed.
 */
export interface OffsiteInput {
  endpoint?: string | null | undefined;
  region?: string | null | undefined;
  bucket: string;
  prefix?: string | null | undefined;
  path_style?: boolean | undefined;
  access_key_id: string;
  secret_access_key?: string | undefined;
  retain_count?: number | undefined;
}

/** POST /backups/offsite/test: whether a small file was written there and deleted again. */
export interface OffsiteTestResult {
  ok: boolean;
  problem: OffsiteProblem | null;
  words: string;
  view: OffsiteView;
}
