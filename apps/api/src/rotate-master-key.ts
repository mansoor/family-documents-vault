import { MASTER_SEALED, MasterKeyMismatch, rotateMasterKey, type SealedName } from '@fdv/crypto';
import { createPool } from '@fdv/db';

/**
 * `cli.mjs rotate-master-key`: the vault's database, moved onto the key in
 * FDV_MASTER_KEY_NEW (see rotateMasterKey). What it prints is counts, never
 * a key or a secret.
 */

/**
 * What a new master key must be: at least 32 characters, of the kind the
 * README's command makes (base64url) or base64 or hex. Nothing a copy and
 * paste adds (a space, a line break), and nothing `.env` or Docker Compose
 * would change on the way back in (quotes, `#`, `$`): the key written into
 * `.env` afterwards must be the very key the database was moved onto.
 */
const KEY_SHAPE = /^[A-Za-z0-9_+/=.-]+$/;

/** Why FDV_MASTER_KEY_NEW will not do, or null if it will. */
export function newMasterKeyProblem(current: string, next: string | undefined): string | null {
  if (!next) return 'FDV_MASTER_KEY_NEW must be set to the new key.';
  if (!KEY_SHAPE.test(next)) {
    return (
      'FDV_MASTER_KEY_NEW may hold only letters, digits and - _ + / = . — no spaces, line ' +
      'breaks, quotes, # or $. Make one with the command in the README.'
    );
  }
  if (next.length < 32) return 'FDV_MASTER_KEY_NEW must be at least 32 characters.';
  if (next === current) {
    return 'FDV_MASTER_KEY_NEW is the key the vault already uses. Make a new one.';
  }
  return null;
}

const SEALED_LABEL: Record<SealedName, [one: string, many: string]> = {
  totpSecrets: ['two-step sign-in secret', 'two-step sign-in secrets'],
  vaultCredentials: ['storage (S3) credential', 'storage (S3) credentials'],
  smtpPasswords: ['mail (SMTP) password', 'mail (SMTP) passwords'],
};

export interface RotateOptions {
  /** The key the vault runs with now: FDV_MASTER_KEY, or FDV_MASTER_KEY_FILE's. */
  current: string;
  /** FDV_MASTER_KEY_NEW. */
  next: string | undefined;
  /** The owning role: rotation crosses households. */
  adminUrl: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/** Runs the command; resolves to its exit code. */
export async function rotateMasterKeyCommand(o: RotateOptions): Promise<number> {
  const out = o.out ?? ((line: string) => console.log(line));
  const err = o.err ?? ((line: string) => console.error(line));
  const problem = newMasterKeyProblem(o.current, o.next);
  if (problem !== null || o.next === undefined) {
    err(`${problem ?? 'FDV_MASTER_KEY_NEW must be set.'} Nothing was changed.`);
    return 2;
  }
  const admin = createPool(o.adminUrl, 1);
  try {
    const moved = await rotateMasterKey(admin, o.current, o.next);
    const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
    out('The database is on the new master key. In one transaction:');
    out(`  ${n(moved.rewrapped, 'scope key', 'scope keys')} rewrapped`);
    for (const s of MASTER_SEALED) {
      const [one, many] = SEALED_LABEL[s.name];
      out(`  ${n(moved.resealed[s.name], one, many)} sealed again`);
    }
    out(`  ${n(moved.sessionsEnded, 'session', 'sessions')} ended: everybody signs in again`);
    out('');
    out('Now put the new key in .env as FDV_MASTER_KEY (or in your FDV_MASTER_KEY_FILE) and');
    out('start the vault: docker compose up -d');
    out('Keep the old key with your backups: one made before now is restored with it, as');
    out('FDV_MASTER_KEY_PREVIOUS. The README says how.');
    return 0;
  } catch (e) {
    if (e instanceof MasterKeyMismatch) {
      err(
        `Nothing was changed: ${e.what} does not open with the current master key. It is ` +
          'read from FDV_MASTER_KEY (or FDV_MASTER_KEY_FILE): is that the key this vault runs with?',
      );
      return 1;
    }
    throw e;
  } finally {
    await admin.end();
  }
}
