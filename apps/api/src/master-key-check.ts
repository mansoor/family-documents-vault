import { masterKeyRefusal } from '@fdv/crypto';
import { createPool } from '@fdv/db';

/**
 * The API does not start on a master key that does not open the vault
 * (after a rotation, a .env not updated, or `docker compose restart`,
 * which keeps the old one). Started, it would answer /readyz and fail
 * every owner's two-step sign-in with a 500, and write new secrets under
 * the wrong key. False, having said why on stderr.
 */
export async function masterKeyOpensVault(adminUrl: string, secret: string): Promise<boolean> {
  const admin = createPool(adminUrl, 1);
  try {
    const refusal = await masterKeyRefusal(admin, secret, (m) => console.warn(`[master key] ${m}`));
    if (refusal === null) return true;
    console.error(refusal);
    return false;
  } finally {
    await admin.end();
  }
}
