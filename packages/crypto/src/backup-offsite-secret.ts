import { openBound, sealBound } from './master-rotation.js';

/**
 * The secret key of the bucket the nightly backups are copied to, as an
 * owner sets it in Settings → Backups: sealed by the API (AES-256-GCM, the
 * household bound in) under a key derived from the master key for this
 * purpose alone, and opened by the API to send a test and by the worker to
 * copy a backup. One of MASTER_SEALED, so rotate-master-key and a restore of
 * an older backup move it as they move the other secrets. Never returned,
 * logged or put in an export.
 */
export const BACKUP_OFFSITE_KEY_PURPOSE = 'backup-offsite-credentials';

/** Where, and as which key, a secret was typed for: bound in with the household. */
export interface BackupOffsiteTarget {
  /** Null for Amazon S3 itself, whose address the region gives. */
  endpoint: string | null;
  bucket: string;
  accessKeyId: string;
}

/**
 * What is bound in: the household, so a value moved to another's row does
 * not open; and the address, the bucket and the access key it was typed
 * for, so a secret kept as any of them is changed never goes to the new one.
 */
export const backupOffsiteAad = (
  householdId: string,
  endpoint: string,
  bucket: string,
  accessKeyId: string,
) => `backup-offsite:${householdId}\0${endpoint}\0${bucket}\0${accessKeyId}`;

export function sealBackupOffsiteSecret(
  key: Buffer,
  secret: string,
  householdId: string,
  to: BackupOffsiteTarget,
): Buffer {
  return sealBound(
    key,
    Buffer.from(secret, 'utf8'),
    backupOffsiteAad(householdId, to.endpoint ?? '', to.bucket, to.accessKeyId),
  );
}

export function openBackupOffsiteSecret(
  key: Buffer,
  sealed: Buffer,
  householdId: string,
  to: BackupOffsiteTarget,
): string {
  return openBound(
    key,
    sealed,
    backupOffsiteAad(householdId, to.endpoint ?? '', to.bucket, to.accessKeyId),
  ).toString('utf8');
}
