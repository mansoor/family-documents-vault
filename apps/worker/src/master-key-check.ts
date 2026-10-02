import { readFile } from 'node:fs/promises';
import { masterKeyRefusal } from '@fdv/crypto';
import { createPool } from '@fdv/db';

type Log = (level: string, msg: string, extra?: Record<string, unknown>) => void;

/** FDV_MASTER_KEY, or the key in FDV_MASTER_KEY_FILE. */
export async function resolveMasterSecret(config: {
  FDV_MASTER_KEY?: string | undefined;
  FDV_MASTER_KEY_FILE?: string | undefined;
}): Promise<string> {
  return config.FDV_MASTER_KEY_FILE
    ? (await readFile(config.FDV_MASTER_KEY_FILE, 'utf8')).trim()
    : (config.FDV_MASTER_KEY as string);
}

/**
 * Whether the master key opens the vault, asked before a job runs and
 * before a backup is made: a worker on the wrong key (after a rotation, a
 * .env not updated, or `docker compose restart`, which keeps the old one)
 * fails mail, storage and OCR, and makes backups under a key the operator
 * has been told they may let go. False, having logged why.
 */
export async function masterKeyOpensVault(
  adminUrl: string,
  secret: string,
  log: Log,
): Promise<boolean> {
  const admin = createPool(adminUrl, 1);
  try {
    const refusal = await masterKeyRefusal(admin, secret, (m) => log('warn', m));
    if (refusal === null) return true;
    log('error', 'the master key does not open this vault', { reason: refusal });
    console.error(refusal);
    return false;
  } finally {
    await admin.end();
  }
}
