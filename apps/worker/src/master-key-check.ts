import {
  compareKeyCanary,
  KEY_CANARY_MISMATCH,
  masterKeyRefusal,
  readMasterSecret,
  writeKeyCanary,
} from '@fdv/crypto';
import { createPool } from '@fdv/db';

type Log = (level: string, msg: string, extra?: Record<string, unknown>) => void;

/** FDV_MASTER_KEY, or the key in FDV_MASTER_KEY_FILE: both only if they agree. */
export const resolveMasterSecret = readMasterSecret;

/**
 * Whether the master key opens the vault, asked before a job runs and
 * before a backup is made: a worker on the wrong key (after a rotation, a
 * .env not updated, or `docker compose restart`, which keeps the old one)
 * fails mail, storage and OCR, and makes backups under a key the operator
 * has been told they may let go. False, having logged why.
 *
 * As the owning role (the compose file's worker) the full check is made
 * and, passed, the key's canary recorded (key-canary.ts). As a role that
 * cannot see every household, the key is compared with the canary the
 * migrate service recorded instead; with none recorded, it is not checked.
 */
export async function masterKeyOpensVault(
  adminUrl: string,
  secret: string,
  log: Log,
): Promise<boolean> {
  const admin = createPool(adminUrl, 1);
  try {
    const refusal = await masterKeyRefusal(admin, secret, (m) => log('warn', m));
    if (refusal !== null) {
      log('error', 'the master key does not open this vault', { reason: refusal });
      console.error(refusal);
      return false;
    }
    if (await writeKeyCanary(admin, secret)) return true;
    if ((await compareKeyCanary(admin, secret)) === 'mismatch') {
      log('error', 'the master key does not open this vault', { reason: KEY_CANARY_MISMATCH });
      console.error(KEY_CANARY_MISMATCH);
      return false;
    }
    return true;
  } finally {
    await admin.end();
  }
}
