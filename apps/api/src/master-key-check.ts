import {
  compareKeyCanary,
  KEY_CANARY_MISMATCH,
  masterKeyRefusal,
  writeKeyCanary,
} from '@fdv/crypto';
import { createPool } from '@fdv/db';

/**
 * The API does not start on a master key that does not open the vault
 * (after a rotation, a .env not updated, or `docker compose restart`,
 * which keeps the old one). Started, it would answer /readyz and fail
 * every owner's two-step sign-in with a 500, and write new secrets under
 * the wrong key. False, having said why on stderr. Passed, the key's
 * canary is recorded (key-canary.ts), for a start without the owning role.
 */
export async function masterKeyOpensVault(adminUrl: string, secret: string): Promise<boolean> {
  const admin = createPool(adminUrl, 1);
  try {
    const refusal = await masterKeyRefusal(admin, secret, (m) => console.warn(`[master key] ${m}`));
    if (refusal !== null) {
      console.error(refusal);
      return false;
    }
    await writeKeyCanary(admin, secret);
    return true;
  } finally {
    await admin.end();
  }
}

/**
 * The same refusal on the application role alone, as the compose file's
 * API starts: the key compared with the one the migrate service last
 * recorded. True when it matches, or nothing is recorded yet (a database
 * this release's migrate service has not run on: as before, it is not
 * checked here). False, having said why on stderr.
 */
export async function masterKeyMatchesCanary(appUrl: string, secret: string): Promise<boolean> {
  const app = createPool(appUrl, 1);
  try {
    const seen = await compareKeyCanary(app, secret);
    if (seen === 'mismatch') {
      console.error(`[start] ${KEY_CANARY_MISMATCH}`);
      return false;
    }
    console.log(
      seen === 'match'
        ? '[start] the master key is the one the migrate service last opened the vault with'
        : '[start] the master key is checked by the migrate service before this starts: without ' +
            'DATABASE_ADMIN_URL, the owning role, the API cannot see every household to check it',
    );
    return true;
  } finally {
    await app.end();
  }
}
